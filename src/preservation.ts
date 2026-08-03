/**
 * THE PRESERVATION LAYER — a fact ledger, a deterministic fold, and coverage-ranked forgetting.
 *
 * Flag-gated and OFF by default (`preservation.enabled !== true` -> nothing here runs, no entry is
 * appended, no worker is called). That default is not timidity: this layer imports the reddit
 * thread's one substantiated complaint about POM -- background observation contending with the
 * user's own inference slot -- and a mechanism that can starve a local model must be something an
 * operator switched on.
 *
 * WHAT THIS IS NOT. It is not a replacement for pi's `compact()`. The fold this file renders is
 * passed to pi's own primitive as `customInstructions`; pi still writes the summary, pi still commits
 * the entry, `fileOps` and `fromHook` are untouched. POM's own hook returns a rendered fold AS the
 * summary and makes zero model calls (`hooks/compaction-hook.ts`, verified in
 * `dive-pi-observational-memory.md` §3); that is the inverted thesis this package declines
 * (`base-choice-verdict.md` §2.1: "POM's insight is adopted *around* the primitive, not instead of
 * it"). If the deterministic-fold-as-summary is ever measured to be better, it becomes a route
 * target option, not the base.
 *
 * ---
 *
 * UPSTREAM PROVENANCE.
 *
 * Adapted from https://github.com/elpapi42/pi-observational-memory, read at commit
 * `497fcfbff1c240f020216b574a26932d23ab10fc` (repo `main`, 2026-07-29). MIT, Copyright (c) 2026
 * pi-observational-memory contributors. Read from a clone of the repository at that commit, NEVER
 * from `npm:pi-observational-memory@3.0.3`: the published tarball declares the same version string as
 * this commit while lacking the observer chunk cap, the oversized-entry handling, the stream-error
 * logging and the pi-0.81 stream-function fix (`dive-pi-observational-memory.md` §1 -- eight `src/`
 * commits shipped under one unchanged version, so the drift is invisible to semver).
 *
 * Which upstream mechanism each part is, by `dive-pi-observational-memory.md` stealList number:
 *
 *  - 1. **Coverage-ranked forgetting** (`agents/dropper/coverage.ts:12-31`). `coverageTierForCount`
 *       and `COVERAGE_DROP_RANK` below are upstream's tiers and upstream's INVERTED rank: `strong`
 *       is the CHEAPEST to drop (rank 0), `none` the dearest (rank 2). That inversion is the insight
 *       and it is upstream's -- a fact two later facts already subsume has had its meaning lifted
 *       into durable form, while a fact nothing has absorbed is unabsorbed and dropping it loses
 *       information outright.
 *  - 2. **Deterministic fold at the compaction boundary** (`session-ledger/projection.ts:173-208`,
 *       `render-summary.ts:20-31`). `foldFacts` and `renderFold` are a fold over durable ledger
 *       entries, recomputed from the entries every time rather than from the previous fold -- which
 *       is upstream's answer to the compression-of-compression problem. Ours renders INTO a prompt;
 *       upstream's renders into the summary itself.
 *  - 3. **`recall` back-channel** (`tools/recall-observation.ts`). `recallFact` below, and the
 *       `/compaction-router-recall`-equivalent tool in `src/index.ts`. Upstream's 483-line version
 *       handles id collisions, `active` vs `dropped` status and `source_unavailable`; ours keeps the
 *       collision and status handling and the `source_unavailable` outcome, because those three are
 *       what make the answer honest, and drops upstream's reflection/observation duality (we have one
 *       record type).
 *  - 4. **Code-enforced source-id citation** (`agents/observer/agent.ts:69-84, 106-110`,
 *       `normalizeSourceEntryIds`). `parseFacts` rejects a fact whose cited ids are not in the
 *       allowlist, in code, before it can be stored. Upstream's comment is the standard: the prompt
 *       asks, the code guarantees.
 *  - 6. **`ratio` threshold mode** (`config.ts:80-85`, `resolveCompactAfterTokens`).
 *       `resolveObserveAfterTokens` below, same shape: ratio of the active model's context window
 *       when the window is known, static value otherwise. A 1M-context model should not be observed
 *       on a 128k model's cadence.
 *  - 8. **Re-entrancy guard** (`hooks/compaction-hook.ts:17-25`). `src/index.ts`'s
 *       `observerInFlight` / `foldInFlight` flags. ONE DELIBERATE DIVERGENCE, and it is the thesis:
 *       upstream returns `{cancel: true}` on a duplicate compaction. We never return `cancel`
 *       (`base-choice-verdict.md` §5.4 guardrail). A duplicate here declines to do OUR extra work and
 *       lets the compaction proceed, because cancelling a compaction is how a session dies.
 *  - 10. **`observerChunkMaxTokens` derived cap** (`config.ts:104-129`,
 *       `resolveObserverChunkMaxTokens` -- exists only on `main`, added by commit `2057c10`).
 *       `resolveObserverChunkMaxTokens` below keeps upstream's constants
 *       (`OBSERVER_CHUNK_CONTEXT_RATIO = 0.2`, fallback 60 000, floor 256) and its unwedge rationale
 *       verbatim in the doc comment, because the rationale is the reason the cap is not optional: an
 *       uncapped backlog that outgrows the window makes every observer call fail forever, so coverage
 *       never advances and the session can never recover.
 *
 * Upstream's `agentLoop`-with-a-required-tool observer, its three-stage observer/reflector/dropper
 * pipeline, its typebox tool schemas, its `om:status`/`om:view` commands and its
 * `PI_OBSERVATIONAL_MEMORY_PASSIVE` env key are NOT taken. One worker, one prompt, one line format
 * parsed here -- because `@earendil-works/pi-agent-core` is not a dependency of this package and
 * adding one to run a background loop would cost more than the mechanism is worth.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

// ── Entry types: the durable record ─────────────────────────────────────────────────────────────

/** Custom entry type for a batch of recorded facts. Namespaced, so it cannot collide with POM's `om.*`. */
export const FACTS_RECORDED = "compaction-router.facts.recorded";
/** Custom entry type for a batch of dropped fact ids. */
export const FACTS_DROPPED = "compaction-router.facts.dropped";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

/** Upstream's coverage tiers (`coverage.ts:3-4`), by how many later facts supersede this one. */
export const COVERAGE_TIERS = ["none", "partial", "strong"] as const;
export type CoverageTier = (typeof COVERAGE_TIERS)[number];

/**
 * Upstream's `REFLECTION_COVERAGE_DROP_RANK` (`coverage.ts:12-16`), inverted on purpose: a
 * well-covered fact is the CHEAPEST to drop.
 */
export const COVERAGE_DROP_RANK: Record<CoverageTier, number> = { strong: 0, partial: 1, none: 2 };

export interface Fact {
  /** 12 hex chars of sha256 over the content. Upstream's `hashId` (`src/ids.ts`), same width. */
  id: string;
  content: string;
  relevance: Relevance;
  /** Session entry ids this fact was drawn from. Never empty -- `parseFacts` drops a fact without them. */
  sourceEntryIds: string[];
  /** Ids of earlier facts this one makes redundant. Feeds the coverage tier. */
  supersedes: string[];
  /** ISO 8601, so the fold can be rendered chronologically without consulting the entry. */
  ts: string;
  tokens: number;
}

export interface FactsRecorded {
  facts: Fact[];
  /** The last source entry this batch covers. The next observer run starts after it. */
  coversUpToId: string;
  /** Which target served the observer call. The W3 ledger's question, asked of the worker too. */
  servedBy: string;
}

export interface FactsDropped {
  factIds: string[];
  reason: string;
}

/** The subset of a session entry this module reads. Structural, so a test needs no SessionManager. */
export interface LedgerEntry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
  message?: unknown;
  content?: unknown;
  summary?: unknown;
  details?: unknown;
}

/** Upstream's `hashId` (`src/ids.ts`): sha256, first 12 hex chars. */
export function factId(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Upstream's `MEMORY_ID_PATTERN` (`session-ledger/types.ts`), same width and alphabet. */
export const FACT_ID_PATTERN = /^[a-f0-9]{12}$/;

/** Upstream's `estimateStringTokens` (`src/tokens.ts:3-5`) -- pi's own chars/4, applied to a string. */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Thresholds: ratio mode and the chunk cap ────────────────────────────────────────────────────

/** Upstream's `DEFAULT_CONFIG.observeAfterTokens` (`config.ts`). */
export const DEFAULT_OBSERVE_AFTER_TOKENS = 10_000;
/** Upstream's `OBSERVER_CHUNK_FALLBACK_MAX_TOKENS` (`config.ts:89`), same value. */
export const OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000;
/** Upstream's `OBSERVER_CHUNK_MIN_TOKENS` (`config.ts:92`): enough for labels and source context. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256;
/** Upstream's `OBSERVER_CHUNK_CONTEXT_RATIO` (`config.ts:102`), same value and same reasoning. */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2;

export type ObserveThresholdMode = "static" | "ratio";

export interface PreservationConfig {
  /** OFF unless this is literally `true`. Every other value, including absent, means off. */
  enabled: boolean;
  /** The observer's route reason, so it resolves through OUR table like any other target. */
  observeAfterTokens: number;
  mode: ObserveThresholdMode;
  /** Fraction of the active model's context window, in `ratio` mode. */
  ratio: number;
  /** Explicit chunk cap; absent means derive it from the worker's window. */
  observerChunkMaxTokens?: number;
  /** Facts kept in the fold before coverage-ranked dropping starts. */
  maxFacts: number;
  /** Whether the fold is rendered into `customInstructions`. Off = observe but do not inject. */
  injectFold: boolean;
}

/**
 * Upstream's `resolveCompactAfterTokens` (`config.ts:80-85`) -- stealList 6, retargeted.
 *
 * Upstream applies ratio mode to its proactive COMPACTION threshold. We apply it to the OBSERVATION
 * threshold, because this package never decides when to compact: pi's own `shouldCompact` does, and
 * a second opinion about it is the double-triggering hazard the POM dive names (§6). The mechanism is
 * upstream's; the thing it is measured against is ours.
 *
 * Falls back to the static value when the window is unknown, which is upstream's arm too -- a ratio
 * of an unknown quantity is not a threshold.
 */
export function resolveObserveAfterTokens(config: Pick<PreservationConfig, "mode" | "ratio" | "observeAfterTokens">, contextWindow: number | undefined): number {
  if (config.mode === "ratio" && typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(1, Math.floor(contextWindow * config.ratio));
  }
  return config.observeAfterTokens;
}

/**
 * Upstream's `resolveObserverChunkMaxTokens` (`config.ts:104-129`) -- stealList 10, the mechanism
 * that exists ONLY on POM `main` and not in its published 3.0.3.
 *
 * Upstream's rationale, kept because it is the reason this is not optional: "a backlog that outgrows
 * the model's context window (e.g. after repeated observer failures, or when the extension is enabled
 * mid-way into a long session) makes every observer call fail, so coverage never advances and **the
 * session can never recover**" (`config.ts:112-116`). With the cap, an oversized backlog degrades to
 * slow progress -- drained oldest-first across successive runs -- instead of permanent failure.
 *
 * The 0.2 ratio is upstream's and upstream's reason is quoted rather than re-derived: chunk sizes are
 * estimated at ~4 chars/token, which can undercount real tokens by up to ~4x on non-ASCII content, so
 * 0.2 keeps even the worst case at ~80% of the window with room for the system prompt, prior facts,
 * and the response.
 */
export function resolveObserverChunkMaxTokens(config: Pick<PreservationConfig, "observerChunkMaxTokens">, contextWindow: number | undefined): number {
  if (config.observerChunkMaxTokens !== undefined && config.observerChunkMaxTokens > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens);
  }
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(OBSERVER_CHUNK_MIN_TOKENS, Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO));
  }
  return OBSERVER_CHUNK_FALLBACK_MAX_TOKENS;
}

// ── Config parsing ──────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Upstream's `positiveIntegerOrUndefined` (`config.ts:133-135`). */
function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Upstream's `validRatioOrUndefined` (`config.ts:156-158`), with upstream's reasoning: "0 would never
 * trigger; >= 1 would compact at/after the full window with no room left for the response."
 */
function validRatio(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : undefined;
}

/** The default ratio when `mode: "ratio"` is set with no explicit value. Half the window. */
export const DEFAULT_OBSERVE_RATIO = 0.5;
/** Facts kept before coverage-ranked dropping. A fold is a prompt block, not an archive. */
export const DEFAULT_MAX_FACTS = 200;

/**
 * The DEFAULT-OFF config. `enabled: false` is the property the donemeans test pins, and it is
 * expressed as a positive check for `=== true` rather than an absence check, so a truthy-but-not-true
 * value (`"yes"`, `1`) cannot enable a background model-calling layer by accident.
 *
 * Magic Context's config-schema recovery rule is followed for every other field (steal 7, already
 * used in `src/config.ts`): an invalid field falls back to its default and is warned about; it never
 * disables the whole section, and it never throws.
 */
export function resolvePreservationConfig(raw: unknown, warn: (message: string) => void = () => {}): PreservationConfig {
  const off: PreservationConfig = {
    enabled: false,
    observeAfterTokens: DEFAULT_OBSERVE_AFTER_TOKENS,
    mode: "static",
    ratio: DEFAULT_OBSERVE_RATIO,
    maxFacts: DEFAULT_MAX_FACTS,
    injectFold: true,
  };
  if (!isRecord(raw)) return off;
  if (raw.enabled !== true) {
    // A section that exists but is not `enabled: true` is off, and worth saying so once when the
    // operator clearly meant to configure something: a silent no-op is how a feature gets reported
    // as broken.
    if (raw.enabled !== undefined && raw.enabled !== false) warn(`Ignoring preservation.enabled '${String(raw.enabled)}'; it must be the boolean true to enable the observer.`);
    return off;
  }
  const observeAfterTokens = positiveInt(raw.observeAfterTokens);
  if (raw.observeAfterTokens !== undefined && observeAfterTokens === undefined) warn(`Ignoring invalid preservation.observeAfterTokens '${String(raw.observeAfterTokens)}'; using ${DEFAULT_OBSERVE_AFTER_TOKENS}.`);
  const ratio = validRatio(raw.ratio);
  if (raw.ratio !== undefined && ratio === undefined) warn(`Ignoring invalid preservation.ratio '${String(raw.ratio)}'; it must be greater than 0 and less than 1.`);
  const chunkCap = positiveInt(raw.observerChunkMaxTokens);
  if (raw.observerChunkMaxTokens !== undefined && chunkCap === undefined) warn(`Ignoring invalid preservation.observerChunkMaxTokens '${String(raw.observerChunkMaxTokens)}'; deriving it from the worker's context window instead.`);
  const maxFacts = positiveInt(raw.maxFacts);
  if (raw.maxFacts !== undefined && maxFacts === undefined) warn(`Ignoring invalid preservation.maxFacts '${String(raw.maxFacts)}'; using ${DEFAULT_MAX_FACTS}.`);
  const mode: ObserveThresholdMode = raw.mode === "ratio" ? "ratio" : "static";
  if (raw.mode !== undefined && raw.mode !== "ratio" && raw.mode !== "static") warn(`Ignoring invalid preservation.mode '${String(raw.mode)}'; using 'static'.`);
  return {
    enabled: true,
    observeAfterTokens: observeAfterTokens ?? DEFAULT_OBSERVE_AFTER_TOKENS,
    mode,
    ratio: ratio ?? DEFAULT_OBSERVE_RATIO,
    ...(chunkCap === undefined ? {} : { observerChunkMaxTokens: chunkCap }),
    maxFacts: maxFacts ?? DEFAULT_MAX_FACTS,
    injectFold: raw.injectFold !== false,
  };
}

// ── Reading the ledger ──────────────────────────────────────────────────────────────────────────

function isFactsRecordedEntry(entry: LedgerEntry): boolean {
  return entry.type === "custom" && entry.customType === FACTS_RECORDED && isRecord(entry.data);
}
function isFactsDroppedEntry(entry: LedgerEntry): boolean {
  return entry.type === "custom" && entry.customType === FACTS_DROPPED && isRecord(entry.data);
}

function asFact(v: unknown): Fact | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || !FACT_ID_PATTERN.test(v.id)) return null;
  if (typeof v.content !== "string" || !v.content.trim()) return null;
  const relevance = (RELEVANCE_VALUES as readonly string[]).includes(v.relevance as string) ? (v.relevance as Relevance) : "medium";
  const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
  return {
    id: v.id,
    content: v.content,
    relevance,
    sourceEntryIds: strings(v.sourceEntryIds),
    supersedes: strings(v.supersedes),
    ts: typeof v.ts === "string" ? v.ts : "",
    tokens: typeof v.tokens === "number" ? v.tokens : estimateStringTokens(v.content),
  };
}

/**
 * The de-duplication key for a recorded fact: its id AND its content.
 *
 * NOT the id alone, and the difference is load-bearing. An id is a TRUNCATED hash (12 hex chars), so
 * two distinct facts can legitimately share one -- that is the collision case `recallFact` reports and
 * upstream handles explicitly. De-duplicating on the id alone silently discards the second fact of a
 * colliding pair, which is both a lost fact and a collision the recall path can then never report.
 * Keying on id+content keeps the intended de-duplication (the same fact observed in two batches hashes
 * and reads identically) while letting a genuine collision survive as two facts.
 */
const dedupeKey = (fact: Fact): string => `${fact.id}\x00${fact.content}`;

/** Every fact in every batch, in ledger order, de-duplicated but with collisions preserved. */
function collectFacts(entries: readonly LedgerEntry[]): { facts: Fact[]; coversUpToId?: string } {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  let coversUpToId: string | undefined;
  for (const entry of entries) {
    if (!isFactsRecordedEntry(entry)) continue;
    const data = entry.data as Rec;
    if (typeof data.coversUpToId === "string" && data.coversUpToId) coversUpToId = data.coversUpToId;
    if (!Array.isArray(data.facts)) continue;
    for (const raw of data.facts) {
      const fact = asFact(raw);
      if (!fact) continue;
      const key = dedupeKey(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return { facts, coversUpToId };
}

/**
 * Every recorded fact on this branch, in ledger order, minus the dropped ones.
 *
 * A malformed entry is skipped rather than thrown on -- the same rule `parseRows` in `src/ledger.ts`
 * follows, and for the same reason: a hand-edited or half-written session file must degrade to fewer
 * facts, never to a failed compaction.
 */
export function readFacts(entries: readonly LedgerEntry[]): { facts: Fact[]; dropped: Set<string>; coversUpToId?: string } {
  const { facts, coversUpToId } = collectFacts(entries);
  const dropped = new Set<string>();
  for (const entry of entries) {
    if (!isFactsDroppedEntry(entry)) continue;
    const data = entry.data as Rec;
    if (Array.isArray(data.factIds)) for (const id of data.factIds) if (typeof id === "string") dropped.add(id);
  }
  return { facts: facts.filter(f => !dropped.has(f.id)), dropped, coversUpToId };
}

/** Upstream's `estimateEntryTokens` (`src/tokens.ts:7-27`), narrowed to the entry kinds we fold over. */
export function estimateEntryTokens(entry: LedgerEntry): number {
  if (entry.type === "message" && entry.message) return estimateTokens(entry.message as Parameters<typeof estimateTokens>[0]);
  if (entry.type === "custom_message" && entry.content) {
    if (typeof entry.content === "string") return estimateStringTokens(entry.content);
    if (Array.isArray(entry.content)) {
      let total = 0;
      for (const block of entry.content as Array<{ type?: string; text?: string }>) if (block?.type === "text" && typeof block.text === "string") total += estimateStringTokens(block.text);
      return total;
    }
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") return estimateStringTokens(entry.summary);
  return 0;
}

/** The entry kinds a fact may cite. Upstream's `SOURCE_TYPES` (`session-ledger/recall.ts:10`). */
export const SOURCE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary"]);

/**
 * Raw context mass observed since the last fact batch. The observer's trigger quantity.
 *
 * Counted over source entries AFTER `coversUpToId`, so a session that has already been observed up to
 * a point does not re-pay for it -- upstream's `rawTokensSinceLastCompaction` reading of its coverage
 * marker, applied to our own marker.
 */
export function tokensSinceCoverage(entries: readonly LedgerEntry[], coversUpToId: string | undefined): number {
  const start = coversUpToId ? entries.findIndex(e => e.id === coversUpToId) : -1;
  let total = 0;
  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (SOURCE_ENTRY_TYPES.has(entry.type)) total += estimateEntryTokens(entry);
  }
  return total;
}

// ── Coverage-ranked forgetting (stealList 1) ────────────────────────────────────────────────────

/**
 * Upstream's `reflectionSupportCounts` (`coverage.ts:18-25`), retargeted from
 * `supportingObservationIds` to `supersedes`.
 *
 * Upstream counts how many REFLECTIONS cite an observation. We have one record type, so the same
 * relation is expressed by a later fact declaring which earlier facts it makes redundant. The
 * counting, the tiers and the rank inversion are unchanged.
 */
export function supersedeCounts(facts: readonly Fact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    for (const id of new Set(fact.supersedes)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Upstream's `reflectionCoverageTierForCount` (`coverage.ts:27-31`), unchanged. */
export function coverageTierForCount(count: number): CoverageTier {
  if (count <= 0) return "none";
  if (count === 1) return "partial";
  return "strong";
}

export function coverageMap(facts: readonly Fact[]): Map<string, CoverageTier> {
  const counts = supersedeCounts(facts);
  return new Map(facts.map(f => [f.id, coverageTierForCount(counts.get(f.id) ?? 0)]));
}

/** Relevance as a drop rank: a `low` fact is cheaper to lose than a `critical` one. */
const RELEVANCE_RANK: Record<Relevance, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Which facts to keep, and which to forget — upstream's policy, not recency and not relevance alone.
 *
 * The sort is coverage first (upstream's inverted rank: drop `strong` before `none`), then relevance,
 * then age. Upstream's own prompt de-weaponises the tier and the same caveat applies here: coverage
 * is not a quota or a target, it is a statement about which evidence line has already had its meaning
 * lifted somewhere else.
 *
 * Returns the kept facts in their original ledger order, because the fold is read chronologically and
 * re-ordering it by drop rank would make it unreadable.
 */
export function rankForForgetting(facts: readonly Fact[], maxFacts: number): { keep: Fact[]; drop: Fact[] } {
  if (facts.length <= maxFacts) return { keep: [...facts], drop: [] };
  const coverage = coverageMap(facts);
  const order = new Map(facts.map((f, i) => [f.id, i]));
  const byDropCost = [...facts].sort((a, b) => {
    const coverDelta = COVERAGE_DROP_RANK[coverage.get(a.id) ?? "none"] - COVERAGE_DROP_RANK[coverage.get(b.id) ?? "none"];
    if (coverDelta !== 0) return coverDelta;
    const relevanceDelta = RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance];
    if (relevanceDelta !== 0) return relevanceDelta;
    // Oldest first among equals: a newer fact is likelier to still be live.
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
  const drop = byDropCost.slice(0, facts.length - maxFacts);
  const dropIds = new Set(drop.map(f => f.id));
  return { keep: facts.filter(f => !dropIds.has(f.id)), drop };
}

// ── The fold (stealList 2) ──────────────────────────────────────────────────────────────────────

export interface Fold {
  text: string;
  factCount: number;
  droppedCount: number;
  tokens: number;
}

/** One fact as a fold line. Upstream's `[id] timestamp [relevance] content` (`render-summary.ts:12-14`). */
export function factToFoldLine(fact: Fact): string {
  return `[${fact.id}] ${fact.ts || "unknown time"} [${fact.relevance}] ${fact.content}`;
}

/**
 * The preamble that teaches the recall tool and bounds its use.
 *
 * The bound is upstream's, quoted nearly verbatim because it is the half that keeps a back-channel
 * from becoming a search engine: "Do not use recall as broad search or inject raw source unless it is
 * needed" (`render-summary.ts:10`).
 */
export const FOLD_PREAMBLE = `## RECORDED FACTS (from this session, with source ids)

These are facts recorded earlier in this session by a background observer, each with the id of the
source it came from. Anchor the summary in them: they are the durable record of what happened, and
they were written while the original messages were still in context.

Treat them as past records. When facts conflict, the most recent one reflects the latest known state.
Work a fact describes as completed should not be redone unless the conversation asks to revisit it.

When exact source context is needed for precision or traceability, the recall tool exchanges a fact id
for its verbatim source. Do not use recall as broad search or inject raw source unless it is needed.`;

/**
 * Render the durable facts as a prompt block, applying coverage-ranked forgetting.
 *
 * Empty in, empty out: a session with no recorded facts produces `text: ""`, and the caller passes
 * nothing extra to `compact()`. That is what keeps the observer-off path byte-identical to the
 * pre-W5 behaviour.
 */
export function foldFacts(facts: readonly Fact[], maxFacts: number): Fold {
  const { keep, drop } = rankForForgetting(facts, maxFacts);
  if (!keep.length) return { text: "", factCount: 0, droppedCount: drop.length, tokens: 0 };
  const lines = keep.map(factToFoldLine);
  const parts = [FOLD_PREAMBLE, lines.join("\n")];
  if (drop.length) {
    // Never silent (Accordion's rule, already the ledger's): a fold that quietly forgot 40 facts and
    // a fold that had none are different facts about the session, and the reader can act on the first.
    parts.push(`(${drop.length} older fact(s) omitted from this list by coverage-ranked forgetting; they remain recallable by id.)`);
  }
  const text = parts.join("\n\n");
  return { text, factCount: keep.length, droppedCount: drop.length, tokens: estimateStringTokens(text) };
}

/** The fold for a branch, read straight off the entries. The whole deterministic path in one call. */
export function renderFold(entries: readonly LedgerEntry[], maxFacts: number): Fold {
  return foldFacts(readFacts(entries).facts, maxFacts);
}

// ── Source-addressed chunking, and the observer's allowlist ─────────────────────────────────────

export interface SourceChunk {
  text: string;
  /** The ids a fact from this chunk is allowed to cite. `parseFacts` enforces it. */
  allowedSourceEntryIds: string[];
  /** The last entry included, which becomes the next run's coverage marker. */
  coversUpToId?: string;
  estimatedTokens: number;
  /** True when the cap stopped the chunk short. The backlog drains across runs, oldest first. */
  truncated: boolean;
}

function renderSourceEntry(entry: LedgerEntry): string {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as { role?: string; content?: unknown; toolName?: string };
    const text = Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; text?: string; thinking?: string }>)
          .map(block => block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : undefined)
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .join("\n")
      : typeof message.content === "string" ? message.content : "";
    if (!text.trim()) return "";
    const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : `Tool result: ${message.toolName ?? "unknown"}`;
    return `[${role}]: ${text}`;
  }
  if (entry.type === "custom_message") {
    const content = entry.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>).filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text as string).join("\n")
        : "";
    return text.trim() ? `[Custom message]: ${text}` : "";
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") return `[Branch summary]: ${entry.summary}`;
  return "";
}

/**
 * The chunk the observer sees: source entries after the coverage marker, each labelled with its id,
 * bounded by the chunk cap.
 *
 * Upstream's `serializeSourceAddressedBranchEntries` (`src/serialize.ts:199-236`), including the
 * `[Source entry id: <id>]` label format that makes the citation allowlist legible to the model, and
 * upstream's oldest-first drain: when the cap is hit the chunk STOPS rather than skipping ahead, so
 * successive runs make progress through the backlog instead of leaving a permanent hole.
 *
 * Upstream's head/tail excerpt for a single oversized entry (commit `d0ebd32`) is simplified here to
 * a hard character clip of that one entry, keeping the property that matters -- one pathological tool
 * result can never permanently block coverage -- without upstream's marker vocabulary. The entry
 * itself is never modified and stays recallable in full by id.
 */
export function serializeSourceAddressedEntries(entries: readonly LedgerEntry[], coversUpToId: string | undefined, maxTokens: number): SourceChunk {
  const start = coversUpToId ? entries.findIndex(e => e.id === coversUpToId) : -1;
  const blocks: string[] = [];
  const allowedSourceEntryIds: string[] = [];
  let coversUpTo: string | undefined;
  let tokens = 0;
  let truncated = false;

  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!SOURCE_ENTRY_TYPES.has(entry.type) || !entry.id) continue;
    const rendered = renderSourceEntry(entry);
    if (!rendered.trim()) continue;
    const block = `[Source entry id: ${entry.id}]\n${rendered}`;
    const blockTokens = estimateStringTokens(block);
    if (tokens + blockTokens > maxTokens) {
      if (blocks.length > 0) { truncated = true; break; }
      // A single entry larger than the whole budget: clip it rather than send an over-context request
      // that always fails. Upstream's `d0ebd32`, and the reason the cap unwedges instead of stalling.
      const budget = Math.max(0, maxTokens * 4 - `[Source entry id: ${entry.id}]\n`.length - 32);
      const clipped = `[Source entry id: ${entry.id}]\n${rendered.slice(0, budget)} … [clipped]`;
      blocks.push(clipped);
      allowedSourceEntryIds.push(entry.id);
      coversUpTo = entry.id;
      tokens = estimateStringTokens(clipped);
      truncated = true;
      break;
    }
    blocks.push(block);
    allowedSourceEntryIds.push(entry.id);
    coversUpTo = entry.id;
    tokens += blockTokens;
  }

  return { text: blocks.join("\n\n"), allowedSourceEntryIds, coversUpToId: coversUpTo, estimatedTokens: tokens, truncated };
}

// ── Parsing the worker's output, with the citation guard (stealList 4) ──────────────────────────

/** Upstream's `MAX_RECORD_CONTENT_CHARS` (`src/serialize.ts:102`), same value. */
export const MAX_FACT_CONTENT_CHARS = 10_000;

export interface ParsedFacts {
  facts: Fact[];
  /** How many lines were discarded for citing ids that were not in the chunk. Reported, never hidden. */
  rejected: number;
  /** How many were discarded as duplicates of a fact already in this batch. */
  duplicates: number;
}

function truncateContent(content: string): string {
  if (content.length <= MAX_FACT_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_FACT_CONTENT_CHARS)} … [truncated ${content.length - MAX_FACT_CONTENT_CHARS} chars]`;
}

/**
 * Upstream's `normalizeSourceEntryIds` (`agents/observer/agent.ts:69-84`) — stealList 4, the
 * allowlist enforced in CODE.
 *
 * Upstream's semantics, kept exactly: ANY id outside the allowlist rejects the whole record (not just
 * that id), an empty list rejects, and the surviving ids are returned de-duplicated and sorted into
 * the allowlist's own order. Rejecting the whole record on one bad id is the strict choice and it is
 * upstream's: a fact citing one real and one invented source is not two-thirds trustworthy, it is a
 * fact whose provenance the model was willing to make up.
 */
export function normalizeSourceEntryIds(ids: readonly string[] | undefined, allowed: readonly string[]): string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const order = new Map<string, number>();
  for (let i = 0; i < allowed.length; i++) order.set(allowed[i]!, i);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!order.has(id)) return undefined;
    seen.add(id);
  }
  if (seen.size === 0) return undefined;
  return [...seen].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

const splitIds = (field: string): string[] => field === "-" || !field.trim() ? [] : field.split(",").map(s => s.trim()).filter(Boolean);

/**
 * Parse the worker's fact lines, dropping every line that fails the citation guard.
 *
 * A line format rather than a tool schema is a deliberate narrowing from upstream, which drives its
 * observer through `agentLoop` with a typebox-validated `record_observations` tool. That would make
 * `@earendil-works/pi-agent-core` a dependency of this package for one background call; the zero
 * runtime deps this package keeps are worth more than the schema. The guard that actually matters --
 * ids checked against the allowlist in code, before storage -- is the same either way.
 *
 * Anything the model says outside the line format is ignored rather than treated as an error: a
 * cheap worker model prefacing its output with "Here are the facts:" must cost nothing.
 */
export function parseFacts(text: string, allowed: readonly string[], now: () => string = () => new Date().toISOString()): ParsedFacts {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let duplicates = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith("FACT")) continue;
    const fields = trimmed.split("|").map(s => s.trim());
    if (fields.length < 5) { rejected++; continue; }
    const [, relevanceField, sourceField, supersedesField, ...rest] = fields;
    const content = truncateContent(rest.join(" | ").trim());
    if (!content) { rejected++; continue; }
    const relevance = (RELEVANCE_VALUES as readonly string[]).includes(relevanceField!) ? (relevanceField as Relevance) : undefined;
    if (!relevance) { rejected++; continue; }
    const sourceEntryIds = normalizeSourceEntryIds(splitIds(sourceField!), allowed);
    if (!sourceEntryIds) { rejected++; continue; }
    const id = factId(content);
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id);
    facts.push({
      id,
      content,
      relevance,
      sourceEntryIds,
      // `supersedes` is NOT allowlist-checked against source ids: it names earlier FACT ids, which are
      // content hashes from other batches. A stale or invented one costs a coverage tier, not a
      // fabricated provenance, and `supersedeCounts` simply never finds it.
      supersedes: splitIds(supersedesField!).filter(candidate => FACT_ID_PATTERN.test(candidate)),
      ts: now(),
      tokens: estimateStringTokens(content),
    });
  }
  return { facts, rejected, duplicates };
}

// ── recall (stealList 3) ────────────────────────────────────────────────────────────────────────

export type RecallStatus = "ok" | "invalid_id" | "not_found" | "source_unavailable";

export interface RecallResult {
  status: RecallStatus;
  factId: string;
  /** True when more than one fact shares the queried id prefix. Upstream's collision handling. */
  collision: boolean;
  facts: Fact[];
  /** Whether the fact was dropped by coverage-ranked forgetting. Dropped facts stay recallable. */
  dropped: boolean;
  /** The verbatim source text behind the fact, when the entries are still present. */
  sources: Array<{ id: string; text: string }>;
  missingSourceEntryIds: string[];
  message?: string;
}

/**
 * Exchange a fact id for the verbatim source behind it — the mechanism that makes a lossy summary
 * safe, and the one neither this router nor any summarize-only path had.
 *
 * Upstream's `recallMemorySources` + `recall-observation.ts`, narrowed to one record type. Three
 * upstream behaviours are kept because they are what make the answer honest rather than merely
 * present:
 *
 *  - **Collision.** Ids are truncated hashes, so two facts can share one. Upstream returns every
 *    match and flags it; so does this. Returning one arbitrary match would be a silent wrong answer.
 *  - **`dropped` vs active.** A fact dropped from the fold is still in the ledger and still
 *    recallable. That is the entire premise of aggressive forgetting: lossy in the prompt, lossless
 *    on the record.
 *  - **`source_unavailable`.** When the cited entries are gone from the branch, upstream says so
 *    rather than returning an empty success. An empty answer and a missing source are different
 *    facts.
 */
export function recallFact(entries: readonly LedgerEntry[], id: string): RecallResult {
  const trimmed = id.trim().toLowerCase();
  const empty = { factId: trimmed, collision: false, facts: [], dropped: false, sources: [], missingSourceEntryIds: [] };
  if (!FACT_ID_PATTERN.test(trimmed)) {
    return { ...empty, status: "invalid_id", message: `'${id}' is not a fact id. A fact id is 12 hexadecimal characters, as printed in brackets at the start of each recorded fact.` };
  }
  const { facts, dropped } = readFacts(entries);
  // Dropped facts are excluded from `facts` by `readFacts`, so search the full record for recall: the
  // whole premise is that forgetting from the fold does not forget from the ledger.
  const matches = collectFacts(entries).facts.filter(f => f.id === trimmed);
  if (!matches.length) {
    return { ...empty, status: "not_found", message: `No recorded fact has id '${trimmed}'. It may belong to a different session branch.` };
  }
  const byId = new Map(entries.map(e => [e.id, e]));
  const sources: Array<{ id: string; text: string }> = [];
  const missing: string[] = [];
  for (const sourceId of new Set(matches.flatMap(f => f.sourceEntryIds))) {
    const entry = byId.get(sourceId);
    const text = entry ? renderSourceEntry(entry) : "";
    if (entry && text.trim()) sources.push({ id: sourceId, text });
    else missing.push(sourceId);
  }
  const wasDropped = matches.some(f => dropped.has(f.id)) || !matches.some(f => facts.some(kept => kept.id === f.id));
  const collision = matches.length > 1;
  // Both notes are composed rather than one overwriting the other. A colliding id whose sources are ALSO
  // gone used to report only the missing source and drop the collision entirely -- so the reader was told
  // one true thing and silently denied a second, on the exact answer that is hardest to interpret.
  const notes: string[] = [];
  if (collision) notes.push(`${matches.length} facts share this id (truncated-hash collision); all are returned.`);
  if (!sources.length) {
    notes.push(`The fact is recorded, but the ${missing.length} source entr${missing.length === 1 ? "y it cites is" : "ies it cites are"} no longer on this branch. The fact's own text is returned; its verbatim source is not recoverable.`);
  }
  return {
    status: sources.length ? "ok" : "source_unavailable",
    factId: trimmed,
    collision,
    facts: matches,
    dropped: wasDropped,
    sources,
    missingSourceEntryIds: missing,
    ...(notes.length ? { message: notes.join(" ") } : {}),
  };
}

/** The recall answer as text for a tool result. Kept next to the data so both stay in step. */
export function formatRecallResult(result: RecallResult): string {
  if (result.status === "invalid_id" || result.status === "not_found") return result.message ?? result.status;
  const lines: string[] = [];
  for (const fact of result.facts) lines.push(`Fact ${factToFoldLine(fact)}${result.dropped ? " [dropped from the active fold, still recorded]" : ""}`);
  if (result.message) lines.push(result.message);
  if (result.sources.length) {
    lines.push("", "Verbatim source:");
    for (const source of result.sources) lines.push(`[Source entry id: ${source.id}]`, source.text);
  }
  if (result.missingSourceEntryIds.length) lines.push("", `Source entries no longer on this branch: ${result.missingSourceEntryIds.join(", ")}.`);
  return lines.join("\n");
}
