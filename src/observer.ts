/**
 * THE OBSERVER WORKER — one cheap model call, routed through this package's own route table.
 *
 * This is the half of the preservation layer that costs money, so it is the half that is flag-gated
 * off by default and the half that carries every bound W2 built.
 *
 * WHY IT IS ROUTED THROUGH OUR TABLE, which is the whole reason this layer belongs in this package
 * rather than being left to POM. POM resolves ONE model for all three of its background workers,
 * memoized per consolidation run, and silently degrades to the SESSION model when the configured one
 * is missing (`runtime.ts:42-62`, `dive-pi-observational-memory.md` §4). It has no cooldown, no queue
 * and no rate limit: `grep -rn "cooldown\|semaphore\|queue\|concurren" src/` returns nothing at
 * `497fcfb`, and `void runtime.launchConsolidationTask(...)` fires on every `turn_end`
 * (`consolidation-trigger.ts:142`). Default-to-session-model plus unthrottled fire-and-forget is
 * precisely the mechanism behind the reddit thread's one substantiated POM complaint -- background
 * observation starving the user's own local inference slot (`dive` §5, verdict §5.3).
 *
 * So the observer here gets, from W2, what upstream lacks:
 *
 *  - **An ordered chain, not one target** (`selectWorkerTargets`, `src/selection.ts`). A worker target
 *    that is unavailable advances to the next one; it never silently becomes the session model, because
 *    borrowing the session model is the starvation.
 *  - **Persisted per-target cooldowns** (`src/cooldown.ts`, pi-blackhole `2bf8cda`). A worker model
 *    that rate-limited is skipped for the cooldown window instead of being asked again next turn.
 *  - **Failure classification** (`src/retry.ts`, algal PR #7). A quota failure cools the target and
 *    never burns retries; a stale-context failure is never held against it.
 *  - **The context-window admission check and the chunk cap**, so an oversized backlog degrades to
 *    slow progress rather than a permanently failing call (POM `main`'s `2057c10`; see
 *    `resolveObserverChunkMaxTokens` in `src/preservation.ts`).
 *
 * NO RETRY, deliberately, and this is a divergence from the compaction path in the same package.
 * `withTargetRetry` exists and the observer does not use it: a compaction is a blocking, once-per-many-
 * turns event where sleeping 2s to save the summary is obviously right, while an observer run is
 * background work that the NEXT turn will attempt again anyway. Sleeping inside it holds the inference
 * slot for no gain -- it converts one wasted call into four, on the exact path the starvation report is
 * about. A failure advances the chain, records health, and cools the target if it earned it.
 *
 * NO DAEMON, NO CANCEL, NO CONTEXT HOOK (verdict §5.4 guardrails). This module is called from
 * `turn_end` and returns; nothing here schedules recurring work, subscribes to `context`, or returns
 * `{cancel: true}` from anywhere.
 */

import { buildObserverInstructions } from "./preservation-prompt.js";
import {
  parseFacts,
  resolveObserverChunkMaxTokens,
  serializeSourceAddressedEntries,
  type Fact,
  type LedgerEntry,
  type PreservationConfig,
} from "./preservation.js";
import { classifyFailure, type Classification } from "./retry.js";
import type { ModelTarget } from "./config.js";
import type { Suppressor } from "./selection.js";

/** The pieces of a resolved model this module needs. Structural, so a test needs no registry. */
export interface WorkerModel {
  provider: string;
  id: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface WorkerAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/**
 * One model call, injected rather than imported.
 *
 * The seam exists for two reasons. It keeps this module free of any transport, which is what lets the
 * off-by-default test assert "no worker call" by counting invocations of a function rather than
 * intercepting a network layer. And it keeps the concrete call -- `completeSimple` from
 * `@earendil-works/pi-ai/compat`, dynamically imported in `src/index.ts` -- out of the module graph
 * entirely when the observer is off.
 */
export type WorkerCall = (request: {
  model: WorkerModel;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  thinkingLevel?: string;
  auth: WorkerAuth;
  signal?: AbortSignal;
}) => Promise<string>;

/** Why an observer run produced nothing. A closed set, in neatcontext's suppressor style. */
export type ObserverSkip =
  /** The layer is off. The default, and the only outcome a default-configured host can reach. */
  | "disabled"
  /** Not enough new context mass since the last batch to be worth a call. */
  | "below-threshold"
  /** A run is already in flight; this one declines rather than racing it. */
  | "in-flight"
  /** No worker target survived selection -- carries the selection suppressor for detail. */
  | "no-targets"
  /** Nothing new to observe: the chunk was empty after the coverage marker. */
  | "nothing-to-observe"
  /** Every candidate target failed. Health and cooldowns record which and why. */
  | "all-targets-failed"
  /** The caller aborted. Never held against a target. */
  | "aborted";

export interface ObserverOutcome {
  /** Present when the run recorded facts. */
  recorded?: {
    facts: Fact[];
    coversUpToId: string;
    /** WHICH TARGET SERVED IT -- the same question the W3 ledger asks of a compaction. */
    servedBy: string;
    rejected: number;
    duplicates: number;
    /** True when the chunk cap stopped the chunk short; the backlog drains on later runs. */
    truncated: boolean;
  };
  skip?: ObserverSkip;
  /** Human-readable grounds, for a warning or a status surface. Never empty on a skip. */
  reasons: string[];
}

export interface WorkerSelection {
  fire: ModelTarget[];
  reasons: string[];
  suppressor: Suppressor | null;
}

export interface RunObserverOptions {
  config: PreservationConfig;
  /** The branch, oldest first. Read-only: nothing here mutates an entry. */
  entries: readonly LedgerEntry[];
  /** Where the last batch stopped. Facts before it are not re-observed. */
  coversUpToId: string | undefined;
  /** Raw mass since that marker, measured by the caller (`tokensSinceCoverage`). */
  tokensSinceCoverage: number;
  /** The threshold, already resolved through `ratio` mode by the caller. */
  threshold: number;
  /** Worker targets, in order, from our route table. */
  selection: WorkerSelection;
  /** `modelRegistry.find`, narrowed. */
  findModel: (target: ModelTarget) => WorkerModel | null;
  /** `modelRegistry.getApiKeyAndHeaders`, narrowed. */
  authFor: (model: WorkerModel) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
  call: WorkerCall;
  signal?: AbortSignal;
  /** Called after a failure the classifier held against the target. */
  onFailure?: (target: ModelTarget, classification: Classification) => void;
  onSuccess?: (target: ModelTarget) => void;
  /** Injected for tests; production passes `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * The output-token budget for one observer call.
 *
 * Facts are single lines and a batch is a few dozen of them, so this is generous rather than tight. It
 * is `min()`ed against the model's own cap the way pi does it, because a worker model with a small
 * `maxTokens` should produce a shorter batch, not a provider error.
 */
export const OBSERVER_MAX_OUTPUT_TOKENS = 4_000;

function workerBudget(model: WorkerModel): number {
  const cap = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
  return Math.min(OBSERVER_MAX_OUTPUT_TOKENS, cap);
}

/**
 * Run the observer once, or say why it did not.
 *
 * Every early return names itself (neatcontext's `no(suppressor)` discipline, already this package's
 * house style in `src/selection.ts`): an observer that silently does nothing is indistinguishable from
 * one that is broken, and the operator's action differs for each of the seven reasons above.
 */
export async function runObserver(options: RunObserverOptions): Promise<ObserverOutcome> {
  const { config, entries, selection, signal } = options;
  if (!config.enabled) return { skip: "disabled", reasons: ["the preservation layer is disabled (preservation.enabled is not true)"] };
  if (signal?.aborted) return { skip: "aborted", reasons: ["the turn was aborted before the observer ran"] };
  if (options.tokensSinceCoverage < options.threshold) {
    return { skip: "below-threshold", reasons: [`${options.tokensSinceCoverage} tokens since the last observation, under the ${options.threshold}-token threshold`] };
  }
  if (!selection.fire.length) {
    return { skip: "no-targets", reasons: [`no worker target will be tried (${selection.suppressor})`, ...selection.reasons] };
  }

  const reasons: string[] = [];
  const systemPrompt = buildObserverInstructions();

  // `selection.fire` is ALREADY cooldown-filtered: `selectWorkerTargets` consults the store and either
  // drops a cooled target or returns an empty list with the `all-targets-cooled-down` suppressor. This
  // loop deliberately does not re-check, because two cooldown checks mean two places to keep in step and
  // the second one is unreachable in production -- which a mutation test confirmed by deleting the real
  // filter and watching this one silently cover for it.
  for (const target of selection.fire) {
    const model = options.findModel(target);
    if (!model) { reasons.push(`worker model '${target.model}' is not available in the registry`); continue; }

    // The chunk is built PER TARGET, because the cap is derived from that target's context window: a
    // 32k worker and a 1M worker must not be handed the same chunk. This is the ordering the
    // permanent-wedge fix depends on (POM `main` `2057c10`).
    const maxChunkTokens = resolveObserverChunkMaxTokens(config, model.contextWindow);
    const chunk = serializeSourceAddressedEntries(entries, options.coversUpToId, maxChunkTokens);
    if (!chunk.text.trim() || !chunk.coversUpToId) {
      return { skip: "nothing-to-observe", reasons: [...reasons, "no new source entries after the coverage marker"] };
    }

    try {
      const auth = await options.authFor(model);
      if (!auth.ok) { reasons.push(`worker model '${target.model}' is unauthenticated: ${auth.error}`); continue; }
      const text = await options.call({
        model,
        systemPrompt,
        prompt: `## Conversation\n\n${chunk.text}`,
        maxTokens: workerBudget(model),
        thinkingLevel: target.thinkingLevel,
        auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        signal,
      });
      options.onSuccess?.(target);
      const parsed = parseFacts(text, chunk.allowedSourceEntryIds, options.now);
      if (!parsed.facts.length) {
        // A worker that read the chunk and found nothing durable is a SUCCESS, not a failure -- POM's
        // reflector prompt says it outright ("it is better to emit zero reflections than to create one
        // reflection per observation"). The coverage marker still advances, or the same chunk would be
        // paid for again on every subsequent turn.
        return {
          recorded: { facts: [], coversUpToId: chunk.coversUpToId, servedBy: target.model, rejected: parsed.rejected, duplicates: parsed.duplicates, truncated: chunk.truncated },
          reasons: [...reasons, `'${target.model}' recorded no durable facts from ${chunk.allowedSourceEntryIds.length} source entr${chunk.allowedSourceEntryIds.length === 1 ? "y" : "ies"}`],
        };
      }
      return {
        recorded: { facts: parsed.facts, coversUpToId: chunk.coversUpToId, servedBy: target.model, rejected: parsed.rejected, duplicates: parsed.duplicates, truncated: chunk.truncated },
        reasons,
      };
    } catch (error) {
      const classification = classifyFailure(error);
      if (classification.kind === "aborted" || signal?.aborted) {
        return { skip: "aborted", reasons: [...reasons, "the turn was aborted during the observer call"] };
      }
      options.onFailure?.(target, classification);
      reasons.push(`worker '${target.model}' failed (${classification.kind}): ${classification.message}`);
    }
  }

  return { skip: "all-targets-failed", reasons };
}
