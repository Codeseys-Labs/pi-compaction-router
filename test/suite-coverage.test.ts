import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Regression coverage for the orphan-suite gate.
 *
 * Every case drives `scripts/check-suite-coverage.ts` against a SYNTHETIC fixture tree in a tmpdir,
 * never against this repository's own `test/`. A fixture reproduces exactly one violation
 * deterministically; a test asserting something about the live tree would go red whenever the live
 * tree legitimately changed, which teaches everyone to ignore the gate.
 *
 * The pairing is the point. Each refusal case plants ONE problem on top of an otherwise-clean tree,
 * and `clean tree passes` proves the checker discriminates rather than refusing everything. A control
 * only ever observed refusing is not evidence that it works.
 *
 * The facts these cases encode were MEASURED, not assumed:
 *   - `bun test` ran 4 of 7 suite-shaped files in one directory, silently skipping `d-test.ts`,
 *     `f-spec.ts` and `test-g.ts`.
 *   - `bun test` FOLLOWS directory symlinks: a suite behind `test/linked -> ../real` ran
 *     (`Ran 2 tests across 3 files.`), so the walker follows them too and a refusal would be false.
 *   - `bun test` exits 0 and says nothing when a directory is unreadable, skipping the suite inside.
 *   - `bun test <missing path>` and `bun test` over an empty tree both exit 1, so this checker does
 *     NOT guard those: the runner already does. An earlier draft claimed they exited 0, having read
 *     `$?` from a `| tail` pipeline rather than from bun.
 */

const ROOT = join(import.meta.dir, "..");
const CHECKER = join(ROOT, "scripts", "check-suite-coverage.ts");

const SUITE_BODY = 'import { test } from "bun:test";\ntest("placeholder", () => {});\n';

function runChecker(fixtureRoot: string): { status: number; out: string } {
  const r = spawnSync("bun", [CHECKER, fixtureRoot], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function writeScripts(root: string, scripts: Record<string, string>): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ scripts }, null, 2)}\n`);
}

const CLEAN_SCRIPTS = {
  check: "bun run typecheck && bun run test && bun run secrets",
  typecheck: "tsc --noEmit",
  test: "bun test",
  secrets: "betterleaks dir .",
};

function cleanFixture(scripts: Record<string, string> = CLEAN_SCRIPTS): string {
  const root = mkdtempSync(join(tmpdir(), "suite-coverage-"));
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "test", "handler.test.ts"), SUITE_BODY);
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  writeScripts(root, scripts);
  return root;
}

describe("check-suite-coverage", () => {
  test("clean tree passes", () => {
    const root = cleanFixture();
    try {
      const { status, out } = runChecker(root);
      expect(out).toContain("check-suite-coverage: ok (1 suite file");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested suite is covered, not an orphan: bun scans recursively", () => {
    const root = cleanFixture();
    try {
      mkdirSync(join(root, "test", "deep", "deeper"), { recursive: true });
      writeFileSync(join(root, "test", "deep", "deeper", "nested.test.ts"), SUITE_BODY);
      const { status, out } = runChecker(root);
      expect(out).toContain("2 suite file");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hyphenated suite name is refused: bun's discovery cannot see it", () => {
    const root = cleanFixture();
    try {
      writeFileSync(join(root, "test", "routes-test.ts"), SUITE_BODY);
      const { status, out } = runChecker(root);
      expect(out).toContain("do NOT match bun's discovery");
      expect(out).toContain("test/routes-test.ts");
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The false refusal the sibling implementation of this checker produced on its first real run:
   * `src/model-spec.ts` is a module about model SPECIFICATIONS, and a name-only rule called it an
   * orphaned suite. Kept permanently, because the tempting fix for a false refusal is disabling
   * the check.
   */
  test("a source file merely NAMED *-spec.ts is not a suite", () => {
    const root = cleanFixture();
    try {
      writeFileSync(join(root, "src", "model-spec.ts"), "export const LEVELS = [] as const;\n");
      const { status, out } = runChecker(root);
      expect(out).toContain("check-suite-coverage: ok (1 suite file");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a suite stage the gate never invokes is refused (the original bite)", () => {
    const root = cleanFixture({ ...CLEAN_SCRIPTS, check: "bun run typecheck && bun run secrets" });
    try {
      const { status, out } = runChecker(root);
      expect(out).toContain('stage "test" is never reached from "check"');
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a declared stage missing from package.json is refused", () => {
    const root = cleanFixture();
    try {
      writeScripts(root, { check: "bun run typecheck", typecheck: "tsc --noEmit" });
      const { status, out } = runChecker(root);
      expect(out).toMatch(/declared suite stage "[\w:.-]+" does not exist in package\.json scripts/);
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a suite ignored by --path-ignore-patterns with no stage picking it up is an orphan", () => {
    const root = cleanFixture({ ...CLEAN_SCRIPTS, test: "bun test --path-ignore-patterns test/handler.test.ts" });
    try {
      const { status, out } = runChecker(root);
      expect(out).toContain("no declared stage runs: test/handler.test.ts");
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A stage refactored into sub-stages without updating the declaration. The declaration still names
   * `test`, `test` no longer invokes `bun test`, and every suite silently stops being anyone's job.
   * (The two-stage split that IS legitimate -- one stage ignoring a slow file, another naming it
   * explicitly -- is covered in the sibling copy of this suite in pi-bedrock-mantle, whose
   * DECLARED_SUITE_STAGES actually describes that shape.)
   */
  test("a declared stage that no longer invokes bun test is refused", () => {
    const root = cleanFixture({
      ...CLEAN_SCRIPTS,
      test: "bun run test:fast && bun run test:slow",
      "test:fast": "bun test --path-ignore-patterns test/slow.test.ts",
      "test:slow": "bun test test/slow.test.ts --timeout 30000",
    });
    try {
      writeFileSync(join(root, "test", "slow.test.ts"), SUITE_BODY);
      const { status, out } = runChecker(root);
      expect(out).toContain("suite file(s) that no declared stage runs");
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable directory is reported, never treated as empty", () => {
    const root = cleanFixture();
    const locked = join(root, "src", "locked");
    try {
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      const { status, out } = runChecker(root);
      expect(out).toContain("could not be read: src/locked (EACCES)");
      expect(status).toBe(1);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * bun FOLLOWS directory symlinks (MEASURED: a suite behind `test/linked -> ../real` ran), so this
   * walker follows them as well. Refusing them would be a false refusal; ignoring them would let a
   * hyphen-named suite hide behind one -- which is exactly what this case plants.
   */
  test("a suite hidden behind a directory symlink is still inventoried", () => {
    const root = cleanFixture();
    try {
      const hidden = join(root, "elsewhere");
      mkdirSync(hidden, { recursive: true });
      writeFileSync(join(hidden, "sneaky-test.ts"), SUITE_BODY);
      symlinkSync(hidden, join(root, "test", "linked"), "dir");
      const { status, out } = runChecker(root);
      expect(out).toContain("do NOT match bun's discovery");
      expect(out).toContain("sneaky-test.ts");
      expect(status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Following symlinks invites a cycle, so the walker deduplicates by realpath. The timeout is a HANG
   * DETECTOR, not a budget: the checker's measured runtime on these fixtures is under 150ms, so 20s
   * can only be reached by a walker that is not terminating.
   */
  test("a symlink cycle terminates instead of hanging the gate", () => {
    const root = cleanFixture();
    try {
      mkdirSync(join(root, "loop"), { recursive: true });
      symlinkSync(join(root, "loop"), join(root, "loop", "self"), "dir");
      const started = Date.now();
      const { status, out } = runChecker(root);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(out).toContain("check-suite-coverage: ok");
      expect(status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
