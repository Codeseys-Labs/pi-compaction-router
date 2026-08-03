/**
 * THE COMPACTION LEDGER — the meter this package did not have (gap G4).
 *
 * Before this file, `session_compact` was subscribed only to decide whether to nudge, and it
 * recorded nothing. `reason` is observable ONLY on the live event -- pi's persisted compaction entry
 * has no `reason` field (`appendCompaction(summary, firstKeptEntryId, tokensBefore, details,
 * fromHook, usage)`, `dist/core/session-manager.js:803`) -- so every question of the form "does
 * threshold compaction ever actually fire here", "was this summary routed", "what did it cost" was
 * unanswerable from the record. See `dive-ours-pi-compaction-router.md` G4 and §8.2 (WS11's C2).
 *
 * The field pi cannot give us, and the reason this file exists rather than a `git log` of pi's
 * session file: **which target actually served the compaction.** `fromHook` records only THAT an
 * extension produced the summary, never WHICH model did. That one field turns provenance from an
 * inference into a record, and turns a scale proof (G9) from an archaeology exercise into a file
 * read.
 *
 * ---
 *
 * UPSTREAM PROVENANCE — the outcome taxonomy.
 *
 * The closed `LedgerOutcome` union and the "never silent" rule below are adapted from
 * https://github.com/a-Fig/Accordion, read at commit `dc037bc` (`extension/accordion.ts:385-457`,
 * `recordPlanOutcome` and its `PlanOutcomeCause` union). MIT, Copyright (c) 2026 Accordion
 * contributors. Read from a clone of the repo at that commit, never from its npm package -- the published
 * `@a-fig/accordion@0.1.2` predates this code (`dive--a-fig-accordion.md`: the npm build is 2.5 weeks
 * behind the repo and lacks `recordPlanOutcome` entirely).
 *
 * What is upstream's: a *closed* set of causes; the invariant that every resolution of the hook
 * increments exactly one of them; and the explicit rule that no resolution may be silent. Upstream's
 * causes are about a GUI round-trip (`no-gui`, `unsent`, `epoch-mismatch`, `timeout-stale`,
 * `timeout-raw`, `empty-plan`, `applied`) and none of them are reusable here; ours are about route
 * resolution. Upstream counts causes in memory and acks them over a WebSocket. We persist a row per
 * compaction instead, because our question ("did threshold ever fire, and what served it") is a
 * question about history, not about a live socket.
 *
 * "Never silent" is the load-bearing half. It is why `unobserved` exists: a compaction that pi
 * committed without our before-hook ever resolving still gets a row saying exactly that, rather than
 * leaving a gap in the record that a reader would have to guess at. An absent row and a fell-back
 * row are very different facts, and a ledger that cannot tell them apart is not a meter.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

/**
 * Every route resolution lands on exactly one of these, and every committed compaction gets a row.
 * Closed by construction: `RouteRecord.outcome` and `LedgerRow.outcome` are both this union, so a new
 * resolution path cannot compile without choosing a cause.
 */
export const LEDGER_OUTCOMES = [
  /** A configured route target produced the summary. `servedBy` names it. */
  "routed",
  /** Every configured target was skipped or failed; pi's active model served it (the fail-open). */
  "fell-back",
  /** Configuration exists, but no target matched this reason and active model. */
  "no-targets",
  /** Routing was abandoned mid-chain because the caller aborted. Nothing was committed through us. */
  "aborted",
  /**
   * Pi committed a compaction that our before-hook never resolved -- a native path, another
   * extension's handler, or a mid-session config change between the two events. Recorded rather
   * than dropped: see "never silent" above.
   */
  "unobserved",
] as const;
export type LedgerOutcome = (typeof LEDGER_OUTCOMES)[number];

/** Which target served a compaction, or the explicit fact that no configured target did. */
export interface ServingTarget {
  /** `provider/model` as configured, or `null` when pi's active model served it. */
  model: string | null;
  thinkingLevel?: string;
  /** True when this is pi's active model rather than a configured route target. */
  active: boolean;
}

export interface LedgerRow {
  ts: string;
  sessionId: string;
  /** Project the compaction happened in, so a project-scoped meter can be aggregated. */
  project: string;
  /** What triggered it. Observable only on the live event, which is why it is persisted here. */
  reason: string;
  /** True when pi retries the aborted turn after this compaction (overflow recovery). */
  willRetry: boolean;
  /** Pi's own record of whether an extension produced the summary. */
  fromExtension: boolean;
  outcome: LedgerOutcome;
  /** WHICH TARGET SERVED IT. The field pi does not persist. */
  servedBy: ServingTarget;
  /** Context mass before the compaction, from pi's own accounting. */
  tokensBefore: number;
  /**
   * Estimated cost of the summary that replaced that mass, or `null` when we declined to compute it.
   * Never a fabricated number -- see `tokensSkipped`.
   */
  tokensAfter: number | null;
  /**
   * True when the summary exceeded `TOKENIZE_CAP_BYTES` and no count was computed. An event with
   * this flag contributes nothing to the savings aggregate rather than contributing a guess.
   *
   * Upstream provenance: https://github.com/cortexkit/aft at commit `566bcde`,
   * `crates/aft/src/bash_background/registry.rs:64` (`TOKENIZE_CAP_BYTES_PER_STREAM = 128 * 1024`)
   * and `:4438-4452` (`CompletionTokenCounts::skipped()` setting `tokens_skipped: true` with every
   * count left `None`). MIT. The rule taken is the one stated in `dive--cortexkit-aft-pi.md`
   * stealList 3: *never fabricate a count when you declined to compute one.* Upstream caps reading a
   * background process's output stream; we cap measuring a summary. The constant is upstream's
   * value, and the discriminated `null`-count-plus-flag shape is upstream's shape.
   */
  tokensSkipped: boolean;
  /** Context window of the model that served it, when known. */
  window: number | null;
  /** Usage of the LLM call(s) that generated the summary, when the host reported any. */
  usage: Usage | null;
}

/**
 * The byte cap above which a summary is not measured. Upstream AFT's
 * `TOKENIZE_CAP_BYTES_PER_STREAM`, same value.
 *
 * A compaction summary is normally a few KB, so this cap is not expected to fire in practice. It is
 * here because "not expected to fire" is not a bound, and because the alternative to a cap is a
 * pathological input silently turning a meter into a stall. When it does fire the row says so.
 */
export const TOKENIZE_CAP_BYTES = 128 * 1024;

/** Rotate at 1 MiB, keeping one generation. A meter must not become an unbounded disk consumer. */
export const LEDGER_MAX_BYTES = 1024 * 1024;

/**
 * Pi's own conservative chars/4 heuristic (`estimateTokens`,
 * `dist/core/compaction/compaction.js:188-213`), applied to the summary text. Returns `null` past
 * the cap rather than a guess.
 */
export function estimateSummaryTokens(summary: string): { tokens: number | null; skipped: boolean } {
  const bytes = Buffer.byteLength(summary, "utf8");
  if (bytes > TOKENIZE_CAP_BYTES) return { tokens: null, skipped: true };
  return { tokens: Math.ceil(summary.length / 4), skipped: false };
}

export function ledgerPath(agentDir: string): string {
  return join(agentDir, "compaction-router", "ledger.jsonl");
}

/**
 * Append one row. Fail-safe by construction: a ledger that cannot be written is a lost measurement,
 * never a broken compaction, so every error here is swallowed after one warning. This is the same
 * posture the fail-open route path takes, for the same reason -- observability must not become a new
 * way for compaction to fail.
 */
export function appendRow(agentDir: string, row: LedgerRow, warn: (message: string, error?: unknown) => void): void {
  const path = ledgerPath(agentDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfLarge(path);
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    warn("Could not append to the compaction ledger; the compaction itself is unaffected.", error);
  }
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size < LEDGER_MAX_BYTES) return;
  } catch {
    return; // no file yet: nothing to rotate
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // A failed rotation must not stop the append; the file simply grows past the cap this once.
  }
}

export interface SavingsAggregate {
  events: number;
  tokensBefore: number;
  tokensAfter: number;
  savingsTokens: number;
  /** Events excluded from the totals above because no count was computed. Reported, never hidden. */
  skippedEvents: number;
  /** How many of the counted events a configured route target served. */
  routedEvents: number;
}

export interface Savings {
  session: SavingsAggregate;
  project: SavingsAggregate;
}

const emptyAggregate = (): SavingsAggregate => ({ events: 0, tokensBefore: 0, tokensAfter: 0, savingsTokens: 0, skippedEvents: 0, routedEvents: 0 });

/**
 * Percentage of the pre-compaction mass that the summary reclaimed.
 *
 * Upstream provenance: https://github.com/cortexkit/aft at commit `566bcde`,
 * `packages/aft-bridge/src/format.ts:24-28` (`compressionSavingsPercent`). MIT. Taken verbatim in
 * behaviour, including both edge cases upstream's own tests pin
 * (`packages/aft-bridge/src/__tests__/format.test.ts:35-45`): a zero original returns `null` rather
 * than a division result, and a negative saving clamps to 0 rather than reporting a negative
 * percentage.
 */
export function savingsPercent(before: number, after: number): number | null {
  if (before <= 0) return null;
  const saved = Math.max(0, before - after);
  return Math.round((saved / before) * 100);
}

function fold(aggregate: SavingsAggregate, row: LedgerRow): void {
  aggregate.events++;
  if (row.tokensSkipped || row.tokensAfter === null) {
    aggregate.skippedEvents++;
    return;
  }
  aggregate.tokensBefore += row.tokensBefore;
  aggregate.tokensAfter += row.tokensAfter;
  aggregate.savingsTokens += Math.max(0, row.tokensBefore - row.tokensAfter);
  if (row.outcome === "routed") aggregate.routedEvents++;
}

/** Rows as parsed from the ledger. A malformed line is skipped, never thrown. */
export function parseRows(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as LedgerRow;
      if (value && typeof value === "object" && typeof value.tokensBefore === "number") rows.push(value);
    } catch {
      // A truncated final line (a kill mid-append) must not make the whole meter unreadable.
    }
  }
  return rows;
}

/**
 * The meter. Session and project aggregates, in AFT's two-scope shape
 * (`packages/aft-bridge/src/protocol.ts:43-53`, `StatusCompression` / `StatusCompressionAggregate`).
 *
 * Reads the current ledger generation only, so the project figure is "since the last rotation" and
 * the read stays bounded. That is a deliberate bound rather than an oversight: an unbounded read on
 * a status command is a stall waiting for a long-lived project.
 */
export function readSavings(agentDir: string, sessionId: string, project: string): Savings {
  const savings: Savings = { session: emptyAggregate(), project: emptyAggregate() };
  let text: string;
  try {
    text = readFileSync(ledgerPath(agentDir), "utf8");
  } catch {
    return savings; // no ledger yet: a meter reading zero, not an error
  }
  for (const row of parseRows(text)) {
    if (row.project === project) fold(savings.project, row);
    if (row.sessionId === sessionId) fold(savings.session, row);
  }
  return savings;
}

/** Rendered savings rows for a status surface, or `[]` when nothing has been measured yet. */
export function formatSavingsRows(savings: Savings): string[] {
  if (savings.project.events <= 0) return [];
  const rows: string[] = [];
  if (savings.session.events > 0) appendScope(rows, "Session", savings.session);
  appendScope(rows, "Project", savings.project);
  return rows;
}

/**
 * One scope's rows.
 *
 * Upstream provenance: AFT `566bcde`, `packages/pi-plugin/src/dialogs/status-dialog.ts:317-341`
 * (`appendCompressionScope` / `formatCompressionStatusRows`) -- MIT. Upstream's structure is taken:
 * a scope header line followed by indented stat lines, `Project` always shown once any event
 * exists and `Session` only when this session contributed, and an empty list when there is nothing
 * measured rather than a row of zeroes. `toLocaleString("en-US")` is upstream's too.
 *
 * Added here and not upstream: the routed count and the skipped-events line. Both exist because our
 * question is different from upstream's. Upstream measures one compressor against itself, so every
 * event is comparable; our savings mix routed and fell-back compactions, and a savings number that
 * does not say how many of its events were actually routed cannot answer "what did ROUTING buy" --
 * it answers "what did compaction buy", which pi would have done anyway.
 */
function appendScope(rows: string[], label: string, aggregate: SavingsAggregate): void {
  const pct = savingsPercent(aggregate.tokensBefore, aggregate.tokensAfter);
  rows.push(label);
  rows.push(`  Tokens Saved        ${aggregate.savingsTokens.toLocaleString("en-US")}`);
  rows.push(`  Compaction Ratio    ${pct ?? 0}%`);
  rows.push(`  Compactions         ${aggregate.events} (${aggregate.routedEvents} routed)`);
  if (aggregate.skippedEvents > 0) rows.push(`  Not measured        ${aggregate.skippedEvents}`);
  return;
}

/**
 * The per-session stash of what the before-hook decided, drained by `session_compact`.
 *
 * Two events, one fact. The outcome and serving target are known only in `session_before_compact`;
 * `reason`, `willRetry`, `fromExtension` and the committed `usage` are known only in
 * `session_compact`. A row needs both, so the first half waits here for the second.
 *
 * The take-and-delete read is deliberate and is the same discipline `pending-warning.ts` uses: a
 * decision must not be able to describe two compactions. If a stash is never drained (an abort, a
 * session that ends mid-compaction) the next before-hook clears it, so a stale decision can never be
 * attributed to a later compaction.
 */
export interface RouteRecord {
  outcome: LedgerOutcome;
  servedBy: ServingTarget;
  window: number | null;
  tokensBefore: number;
}

const recordBySessionId = new Map<string, RouteRecord>();

export function setRouteRecord(sessionId: string, record: RouteRecord): void {
  recordBySessionId.set(sessionId, record);
}

export function takeRouteRecord(sessionId: string): RouteRecord | undefined {
  const record = recordBySessionId.get(sessionId);
  recordBySessionId.delete(sessionId);
  return record;
}

export function clearRouteRecord(sessionId: string | undefined): void {
  if (!sessionId) return;
  recordBySessionId.delete(sessionId);
}

/** The serving target for a compaction pi's own active model handled. */
export const ACTIVE_MODEL_TARGET: ServingTarget = { model: null, active: true };
