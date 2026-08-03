/**
 * EVERY TRACKED SOURCE FILE IS TEXT, BECAUSE THE AUDITS THAT READ THIS REPO ARE TEXT-MODE.
 *
 * `src/preservation.ts` shipped in v0.4.0 with a LITERAL 0x00 byte at offset 19138, inside the
 * de-duplication key's template literal. Nothing failed. `tsc` accepted it, `bun test` ran all 50
 * assertions in `preservation.test.ts` green, and `betterleaks` counted its bytes -- because a NUL is
 * a legal code point in a TypeScript string literal and the scanners that matter here are not the
 * ones that broke.
 *
 * What broke is every audit that shells out to grep. This host's grep is ugrep 7.5.0, which treats a
 * file containing a NUL as binary and, unlike GNU grep, does not even print the "Binary file matches"
 * line: a plain `grep 'Copyright' src/preservation.ts` exits 1 and says NOTHING. So the largest file
 * in the package -- the one carrying the pi-observational-memory MIT attribution and its
 * upstream-provenance header -- was silently absent from the provenance sweeps that exist to check
 * exactly that header, and from every `grep -rn` a reviewer ran across `src/`. An audit that reports
 * "no match" and an audit that reports "I could not read this file" are different answers, and the
 * tooling collapsed them into the first one.
 *
 * MEASURED, and worth recording because it refutes the obvious guess: `betterleaks dir` DOES scan
 * NUL-bearing files and DOES report leaks in them. Planting a detected needle (a `ghp_` token) into
 * both the NUL-bearing and the escaped form of `preservation.ts` yields "leaks found: 1" either way.
 * The secret scanner was never blind here. The provenance greps were. This leaf is therefore about
 * text-mode READABILITY, not about a missed credential -- and the v0.4.0 tree was re-scanned after
 * the fix, clean.
 *
 * The fix upstream of this test is a spelling change with no semantic content: the raw byte became
 * the four-character escape `\x00`. The string VALUE is identical, which is why the dedupe and
 * collision tests in `preservation.test.ts` are unmodified -- they were never testing the spelling.
 * The separator has to stay NUL-valued (see `dedupeKey`: ids are 12-hex truncations, so id+content is
 * the key, joined by a byte that cannot occur in either half), and the last assertion here pins that,
 * so a future "tidy up the weird escape" cannot quietly change the join.
 *
 * SCOPE. The allowlist is the mechanism, not the file list: every tracked file is asserted to be text
 * unless it is named as deliberately binary. Nothing is named today. A real binary fixture is a
 * one-line addition made on purpose, which is the point -- the alternative, an extension allowlist,
 * would have let this exact defect through in any file type nobody thought to enumerate. NOTICE and
 * LICENSE have no extension and carry the attribution this package's steal discipline rests on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Paths that are allowed to contain bytes no text-mode tool can read. Empty, deliberately: adding an
 * entry is a decision to hide a file from every grep-based audit in this repo, and should read like one.
 */
const KNOWN_BINARY: readonly string[] = [];

/** Tracked files, from git rather than a directory walk: an untracked scratch file is not the audit surface. */
function trackedFiles(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  // A silent failure here would make every assertion below vacuous, so it fails loudly instead.
  if (git.exitCode !== 0) throw new Error(`git ls-files failed (${git.exitCode}): ${git.stderr.toString()}`);
  return git.stdout.toString().split("\0").filter((path) => path.length > 0);
}

interface Offence { path: string; reason: string }

/**
 * The scanner, as a function over (path -> bytes) so the mutation check below can run the REAL code
 * path against a planted NUL instead of a re-implementation of it.
 */
function notText(
  paths: readonly string[],
  read: (path: string) => Buffer,
  allowBinary: readonly string[] = KNOWN_BINARY,
): Offence[] {
  const offences: Offence[] = [];
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  for (const path of paths) {
    if (allowBinary.includes(path)) continue;
    const bytes = read(path);
    const nul = bytes.indexOf(0);
    // Report the offset, because "there is a NUL somewhere in 43 KB" is not an actionable message.
    if (nul !== -1) offences.push({ path, reason: `NUL byte (0x00) at offset ${nul}` });
    try {
      strictUtf8.decode(bytes);
    } catch {
      offences.push({ path, reason: "not valid UTF-8" });
    }
  }
  return offences;
}

const tracked = trackedFiles();
const readTracked = (path: string): Buffer => readFileSync(join(ROOT, path));

describe("source hygiene", () => {
  test("the scan actually enumerated this repo's sources", () => {
    // Guards against the whole file passing because `git ls-files` returned nothing useful.
    expect(tracked.length).toBeGreaterThan(40);
    expect(tracked).toContain("src/preservation.ts");
    expect(tracked).toContain("test/source-hygiene.test.ts");
    expect(tracked.filter((path) => path.startsWith("src/") && path.endsWith(".ts")).length).toBeGreaterThan(15);
  });

  test("no tracked file contains a NUL byte or invalid UTF-8", () => {
    // The message carries path + offset for each offender; an empty array is the whole contract.
    expect(notText(tracked, readTracked).map((o) => `${o.path}: ${o.reason}`)).toEqual([]);
  });

  test("preservation.ts specifically -- the file that regressed -- reads as text", () => {
    // Named separately from the sweep above so a future change to the enumeration cannot drop the one
    // file this leaf was written for without a test saying so.
    const bytes = readTracked("src/preservation.ts");
    expect(bytes.length).toBeGreaterThan(40_000);
    expect(bytes.indexOf(0)).toBe(-1);
    expect(notText(["src/preservation.ts"], readTracked)).toEqual([]);
  });

  test("the scan fails when a NUL is planted -- and when invalid UTF-8 is", () => {
    // Mutation check. Without this, a scanner that always returned [] would pass every test above.
    const dir = mkdtempSync(join(tmpdir(), "router-hygiene-"));
    // The real file as a realistic 43 KB base, but with any NUL stripped so these fixtures are
    // deterministic even while the tree is regressed -- otherwise a tree-level regression makes this
    // scanner test fail too, and four failures point at the tree instead of one pointing at the scanner.
    const clean = Buffer.from(readTracked("src/preservation.ts").filter((byte) => byte !== 0));
    expect(clean.indexOf(0)).toBe(-1);

    const planted = join(dir, "planted.ts");
    writeFileSync(planted, Buffer.concat([clean.subarray(0, 100), Buffer.of(0), clean.subarray(100)]));

    const mangled = join(dir, "mangled.ts");
    writeFileSync(mangled, Buffer.concat([clean, Buffer.of(0xc3, 0x28)]));

    const control = join(dir, "control.ts");
    writeFileSync(control, clean);

    const read = (path: string): Buffer => readFileSync(path);
    expect(notText([planted], read)).toEqual([{ path: planted, reason: "NUL byte (0x00) at offset 100" }]);
    expect(notText([mangled], read)).toEqual([{ path: mangled, reason: "not valid UTF-8" }]);
    // The control proves the planted failures came from the planting, not from the copy or the temp dir.
    expect(notText([control], read)).toEqual([]);
  });

  test("the allowlist can exempt a file, and exempts nothing today", () => {
    // The escape hatch is real (so it is tested) and unused (so it is asserted empty).
    expect(KNOWN_BINARY).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "router-hygiene-allow-"));
    const exempt = join(dir, "blob.bin");
    writeFileSync(exempt, Buffer.of(1, 0, 2));
    const read = (path: string): Buffer => readFileSync(path);
    expect(notText([exempt], read).map((o) => o.reason)).toEqual(["NUL byte (0x00) at offset 1"]);
    // Same bytes, now allowlisted: the exemption is what changes the answer, nothing else.
    expect(notText([exempt], read, [exempt])).toEqual([]);
  });

  test("the dedupe separator is still a NUL-valued escape, not a deleted one", () => {
    // The fix was a spelling change. This pins the VALUE the spelling has to keep: `dedupeKey` joins a
    // truncated-hash id to its content with a byte that can occur in neither half, which is what lets a
    // genuine 12-hex collision survive as two facts instead of being de-duplicated into one.
    const source = readTracked("src/preservation.ts").toString("utf8");
    // Written with a double-quoted literal on purpose: the target text contains backticks and `${`, so a
    // template literal (even String.raw) would have to escape them and would then not be what it looks
    // like. `\\x00` here is the two-character source spelling `\x00`, which is the whole point of the fix.
    expect(source).toContain("const dedupeKey = (fact: Fact): string => `${fact.id}\\x00${fact.content}`;");
    // And the escape means what it says, evaluated rather than assumed.
    const id = "abcdef012345";
    expect(`${id}\x00body`.charCodeAt(id.length)).toBe(0);
    expect(`${id}\x00body`).toBe(`${id}${String.fromCharCode(0)}body`);
  });
});
