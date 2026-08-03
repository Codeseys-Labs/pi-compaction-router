/**
 * THE G9 EVIDENCE IS CHECKED, NOT JUST CHECKED IN.
 *
 * `docs/runtime-evidence/2026-08-03-scale-proof.json` and its artifact directory are the durable
 * record of a real routed compaction at real scale. This file is the leaf that keeps them honest, and
 * it exists because of how the v1 proof failed: it was true when written, and unverifiable a week
 * later, because its evidence lived in `/tmp` (`dive-ours-pi-compaction-router.md` §3, verdict §4.3).
 *
 * A committed JSON file has the same failure mode in slow motion -- it can be edited, weakened, or left
 * describing artifacts that are no longer beside it, and nothing would say so. So these tests assert
 * the three properties the proof's WORTH depends on:
 *
 *  1. It is at SCALE. A 481-token proof is structurally insufficient (donemeans W6), so the recorded
 *     mass has to be orders of magnitude past it, and the estimator contrast has to be present.
 *  2. Its assertions are about a PERSISTED entry, and the artifacts it was made against are IN THE
 *     REPOSITORY -- re-read here from disk, not taken from the summary that describes them.
 *  3. It names WHICH TARGET SERVED IT, consistently across the summary, the ledger row and the session.
 *
 * This does not re-run the proof: that needs live credentials and spends money, and a unit suite must
 * not. `scripts/scale-proof.ts` is the runnable half; this is the half that notices if what it produced
 * stops being true.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseRows } from "../src/ledger.js";

const EVIDENCE_PATH = resolve(import.meta.dir, "..", "docs", "runtime-evidence", "2026-08-03-scale-proof.json");

interface Evidence {
  verdict: string;
  scale: {
    tokensBefore: number;
    honestEstimate: number;
    legacyEstimate: number;
    legacyOverCountRatio: number;
    reserveTokens: number;
    v1ProofTokensBefore: number;
    legacyWouldRefuseAt272k: boolean;
    honestFitsAt272k: boolean;
  };
  selection: { servedBy: string; cheapestFittingCandidate: string; fittingCandidates: number; attempts: { target: string; outcome: string }[] };
  persistedEntry: { entryId: string; fromHook: boolean; tokensBefore: number; summaryChars: number; usage: { input: number } | null };
  ledger: { routedRows: number; servedBy: { model: string | null; active: boolean }; windowRecorded: number | null };
  estimatorAccuracy: { honestEstimate: number; providerReportedInput: number | null; estimatePlusReserve: number; guardHoldsWithReserve: boolean };
  provenance: { agentDir: string; isScratchDir: boolean; piCodingAgentVersion: string };
  artifacts: { sessionFile: string; ledgerFile: string };
  notClaimed: string[];
}

const evidence = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as Evidence;

/** Artifact paths are absolute in the record; resolve them against the evidence file for portability. */
const artifactPath = (recorded: string): string => isAbsolute(recorded) ? resolve(dirname(EVIDENCE_PATH), recorded.slice(recorded.lastIndexOf("/docs/runtime-evidence/") + "/docs/runtime-evidence/".length)) : resolve(dirname(EVIDENCE_PATH), recorded);

describe("the G9 proof was made at scale", () => {
  test("it passed", () => {
    expect(evidence.verdict).toBe("PASS");
  });

  test("the input is orders of magnitude past the 481-token v1 proof", () => {
    // The specific insufficiency donemeans W6 names. 481 tokens could not exercise the defect class the
    // estimator fix addresses, so a re-proof at that scale would prove the same nothing again.
    expect(evidence.scale.v1ProofTokensBefore).toBe(481);
    expect(evidence.scale.tokensBefore).toBeGreaterThan(100_000);
    expect(evidence.scale.tokensBefore / evidence.scale.v1ProofTokensBefore).toBeGreaterThan(100);
  });

  test("the mass is the shape that DISCRIMINATES between the two estimators", () => {
    // A fixture both estimators accept proves nothing about the fix. The recorded run must be one the
    // old estimator would have refused at dive §5.2's 272k window and the new one routes -- which is
    // the false-skip defect, reproduced and then shown closed.
    expect(evidence.scale.legacyWouldRefuseAt272k).toBe(true);
    expect(evidence.scale.honestFitsAt272k).toBe(true);
    // And the over-count is in the measured 3.7x-37.9x band the dive recorded.
    expect(evidence.scale.legacyOverCountRatio).toBeGreaterThan(3.7);
    expect(evidence.scale.legacyOverCountRatio).toBeLessThan(37.9);
  });

  test("the estimator was checked against the provider's own token count", () => {
    // The measurement this package could not previously make, and it corrects a claim in src/index.ts:
    // chars/4 UNDER-counted this provider's tokenization, so the estimate's own margin is not what makes
    // the fit guard sound -- `reserveTokens` is. Pinned because a future wave shrinking the reserve
    // toward the estimate's error would silently admit prompts that overflow.
    expect(evidence.estimatorAccuracy.providerReportedInput).toBeGreaterThan(0);
    expect(evidence.estimatorAccuracy.honestEstimate).toBeLessThan(evidence.estimatorAccuracy.providerReportedInput!);
    expect(evidence.estimatorAccuracy.guardHoldsWithReserve).toBe(true);
    expect(evidence.estimatorAccuracy.estimatePlusReserve).toBeGreaterThanOrEqual(evidence.estimatorAccuracy.providerReportedInput!);
  });
});

describe("the proof asserts on a persisted entry, and the artifacts are in the repository", () => {
  test("the session artifact EXISTS beside the evidence, and is not a /tmp reference", () => {
    // The v1 failure, prevented rather than described. The evidence names artifact paths; those files
    // have to actually be here.
    const sessionFile = artifactPath(evidence.artifacts.sessionFile);
    expect(existsSync(sessionFile)).toBe(true);
    expect(sessionFile.startsWith("/tmp/")).toBe(false);
  });

  test("the persisted compaction entry is real, routed, and at the recorded scale", () => {
    // Re-read from the committed artifact rather than trusted from the summary: the point of keeping the
    // bytes is that the claim can be re-derived from them.
    const lines = readFileSync(artifactPath(evidence.artifacts.sessionFile), "utf8").trim().split("\n");
    const entries = lines.map(line => JSON.parse(line) as { type: string; summary?: string; tokensBefore?: number; fromHook?: boolean; id?: string });
    const compactions = entries.filter(e => e.type === "compaction");
    expect(compactions.length).toBe(1);
    const entry = compactions[0]!;
    // `fromHook: true` is pi's own record that an extension produced the summary. Without it, this is a
    // native compaction and the proof says nothing about routing.
    expect(entry.fromHook).toBe(true);
    expect(entry.summary!.length).toBeGreaterThan(100);
    expect(entry.tokensBefore).toBe(evidence.scale.tokensBefore);
    expect(entry.id).toBe(evidence.persistedEntry.entryId);
    // And the session is a real session: something produced the context that was compacted.
    expect(entries.some(e => e.type === "message")).toBe(true);
  });

  test("the ledger artifact names WHICH TARGET SERVED IT -- the field pi does not persist", () => {
    // The v1 proof could only INFER the serving model, from CloudTrail timestamps and matching usage
    // ("INFERRED, high confidence", its own words). W3's ledger makes it a field, and this asserts the
    // field is populated in the committed bytes.
    const rows = parseRows(readFileSync(artifactPath(evidence.artifacts.ledgerFile), "utf8"));
    const routed = rows.filter(r => r.outcome === "routed");
    expect(routed.length).toBe(1);
    expect(routed[0]!.servedBy.active).toBe(false);
    expect(routed[0]!.servedBy.model).toBe(evidence.selection.servedBy);
    expect(routed[0]!.tokensBefore).toBe(evidence.scale.tokensBefore);
  });

  test("the summary, the ledger row and the session agree on the same compaction", () => {
    // Three records of one event. A proof whose parts disagree is not evidence of anything, and this is
    // the assertion that would fail if the evidence file were edited without the artifacts.
    const rows = parseRows(readFileSync(artifactPath(evidence.artifacts.ledgerFile), "utf8"));
    const entries = readFileSync(artifactPath(evidence.artifacts.sessionFile), "utf8").trim().split("\n").map(l => JSON.parse(l) as { type: string; tokensBefore?: number });
    const compaction = entries.find(e => e.type === "compaction")!;
    expect(evidence.ledger.servedBy.model).toBe(evidence.selection.servedBy);
    expect(rows[0]!.servedBy.model).toBe(evidence.selection.servedBy);
    expect(compaction.tokensBefore).toBe(rows[0]!.tokensBefore);
  });
});

describe("the proof's own limits are recorded", () => {
  test("the run never touched the operator's live profile", () => {
    // Wave rules forbid writing ~/.pi, and the proof writes a ledger, a cooldown file and a session --
    // so where it wrote them is part of the claim.
    expect(evidence.provenance.isScratchDir).toBe(true);
    expect(evidence.provenance.agentDir).not.toContain("/.pi/agent");
  });

  test("it says what it does NOT establish", () => {
    // The v1 README's best habit, kept: a proof that lists no limits is being read as proving more than
    // it did. Threshold/overflow compaction and subagent routing are the two big absences.
    expect(evidence.notClaimed.length).toBeGreaterThanOrEqual(3);
    const text = evidence.notClaimed.join(" ");
    expect(text).toContain("threshold");
    expect(text).toContain("subagent");
  });

  test("the selector's limit is recorded: the cheapest fitting candidate need not be the one that serves", () => {
    // The finding this run produced. `getAvailable()` is auth-filtered, not invocation-filtered, so
    // ranking on published metadata can put an uninvocable model first -- and the chain advancing past
    // it is the mechanism working. Recorded as attempts rather than hidden behind a hardcoded winner.
    expect(evidence.selection.attempts.length).toBeGreaterThanOrEqual(1);
    expect(evidence.selection.attempts.at(-1)!.outcome).toBe("served");
    expect(evidence.selection.attempts.at(-1)!.target).toBe(evidence.selection.servedBy);
    // Every earlier hop failed, which is what makes the last one the first invocable fitting target.
    for (const attempt of evidence.selection.attempts.slice(0, -1)) expect(attempt.outcome).not.toBe("served");
  });

  test("it was run against the pinned pi version", () => {
    const pinned = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as { version: string };
    expect(evidence.provenance.piCodingAgentVersion).toBe(pinned.version);
  });
});
