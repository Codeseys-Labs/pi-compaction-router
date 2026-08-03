/**
 * PASSIVE PROVIDER-HEALTH RECORDING.
 *
 * Upstream provenance: https://github.com/akitaonrails/ai-memory, read at commit
 * `e714d992993b5ee76a76e09e64ac5cb441e14aed` (`crates/ai-memory-llm/src/health.rs`). MIT,
 * Copyright (c) 2026 Fabio Akita. Read from a clone of the repo at that commit -- never from
 * `npm:ai-memory`, which `dive-akitaonrails-ai-memory.md` confirms is an unrelated 1.0.0 stub with no
 * `repository` field at all.
 *
 * The upstream rule, quoted from that file's own module doc:
 *
 *   > These wrappers never probe providers on their own. They only record
 *   > the result of calls the server was already going to make.
 *
 * That sentence is the whole design, and it is why this module has no exported function that
 * performs I/O of any kind. `record*` are pure state transitions over calls the route loop has
 * ALREADY made and already paid for. There is no timer, no warm-up, no reachability check, no
 * `fetch`, no `getApiKeyAndHeaders` call of its own. The status a target carries is a memory of what
 * happened to it, not an answer to a question we asked.
 *
 * Why passivity is a requirement here and not merely a preference: a compaction router's targets are
 * paid endpoints, and it fires on a hook the operator did not initiate. A health check that probed
 * would spend the operator's money and quota to learn something the next real compaction would have
 * told us for free -- and it would do so on every session start, for targets that may never be used.
 * `test/provider-health.test.ts` holds the line with a test that fails if any probe is ever made.
 *
 * What is taken from upstream: the four-state `disabled`/`unknown`/`ok`/`error` status ladder, the
 * `last_call_at` / `last_success_at` / `last_error_at` triple, error-message truncation at a named
 * constant (`MAX_ERROR_MESSAGE_CHARS = 1024`), the rule that recording a success CLEARS the previous
 * error rather than leaving a stale one beside a fresh success, and the snapshot-as-wire-format
 * split (mutable state in, plain serializable record out).
 *
 * What differs, and why: upstream wraps two provider ROLES (llm, embedding) behind a decorator
 * trait. We key by `provider/model` target string instead, because the router's question is per
 * target -- "is THIS route hop flapping" -- and a route chain is a list of targets, not a pair of
 * roles. Upstream's process-scoped `Arc<Mutex<..>>` becomes a plain `Map`, since an extension is
 * single-threaded. Upstream's `retry_hint` is dropped: it exists to tell a CLI user what command to
 * re-run, and there is no such command here.
 *
 * SCOPE, stated so it is not mistaken for more than it is: this is a process-scoped record and the
 * input to a future zero-cost deprioritisation (verdict §2 steal 10). It deliberately does NOT
 * deprioritise anything yet -- W2 owns route selection, including the persisted cooldowns from
 * blackhole, and two workstreams writing the same selection rule would collide. This module records;
 * selection reads. Nothing here reorders a route chain today.
 */

const MAX_ERROR_MESSAGE_CHARS = 1024;

export const HEALTH_STATUSES = [
  /** No call to this target has ever been observed in this process. */
  "unknown",
  /** The last observed call to this target succeeded. */
  "ok",
  /** The last observed call to this target failed. */
  "error",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Why a target's last observed call failed, in the router's own vocabulary. */
export type HealthFailure =
  /** `modelRegistry.find` did not return it. */
  | "unavailable"
  /** `getApiKeyAndHeaders` refused. */
  | "unauthenticated"
  /** The fit guard rejected it for this preparation. */
  | "too-small"
  /** `compact()` threw. */
  | "call-failed";

/** A plain, serializable view of one target's recorded state. Upstream's snapshot split. */
export interface HealthSnapshot {
  target: string;
  status: HealthStatus;
  lastCallAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastFailure: HealthFailure | null;
  lastErrorMessage: string | null;
  /** Consecutive observed failures. Reset by a success. The deprioritisation input W2 will read. */
  consecutiveFailures: number;
}

interface HealthState {
  status: HealthStatus;
  lastCallAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastFailure: HealthFailure | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}

const truncate = (message: string): string => message.length <= MAX_ERROR_MESSAGE_CHARS ? message : `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}...`;

/**
 * A record of what has already happened to each route target.
 *
 * Every method on this class is a pure state transition. If a method here ever needs to perform I/O
 * to answer a question, the answer is that it must not: the caller already has the result, and the
 * caller passes it in.
 */
export class ProviderHealth {
  private readonly states = new Map<string, HealthState>();
  /**
   * Counts every recording call, for diagnostics only -- never for display, and never as an input to
   * any decision. Passivity itself is proved from the OUTSIDE, by counting the calls that reach the
   * model registry (`test/provider-health.test.ts`); a counter this class maintains about itself could
   * not prove anything about calls this class made.
   */
  private recordings = 0;

  private stateFor(target: string): HealthState {
    let state = this.states.get(target);
    if (!state) {
      state = { status: "unknown", lastCallAt: null, lastSuccessAt: null, lastErrorAt: null, lastFailure: null, lastErrorMessage: null, consecutiveFailures: 0 };
      this.states.set(target, state);
    }
    return state;
  }

  /** Record that a call the router already made to `target` succeeded. */
  recordSuccess(target: string, now = new Date()): void {
    this.recordings++;
    const state = this.stateFor(target);
    const ts = now.toISOString();
    state.status = "ok";
    state.lastCallAt = ts;
    state.lastSuccessAt = ts;
    // Upstream clears the error fields on success rather than leaving a stale error beside a fresh
    // success (`health.rs:167-176`). A status surface showing both is a status surface that lies.
    state.lastErrorAt = null;
    state.lastFailure = null;
    state.lastErrorMessage = null;
    state.consecutiveFailures = 0;
  }

  /** Record that a call the router already made to `target`, or a check of it, failed. */
  recordFailure(target: string, failure: HealthFailure, message?: string, now = new Date()): void {
    this.recordings++;
    const state = this.stateFor(target);
    const ts = now.toISOString();
    state.status = "error";
    state.lastCallAt = ts;
    state.lastErrorAt = ts;
    state.lastFailure = failure;
    state.lastErrorMessage = message === undefined ? null : truncate(message);
    state.consecutiveFailures++;
  }

  /** One target's state, or an `unknown` snapshot for a target never observed. */
  snapshot(target: string): HealthSnapshot {
    const state = this.states.get(target);
    if (!state) return { target, status: "unknown", lastCallAt: null, lastSuccessAt: null, lastErrorAt: null, lastFailure: null, lastErrorMessage: null, consecutiveFailures: 0 };
    return { target, ...state };
  }

  /** Every observed target, for a status surface. Targets never called do not appear. */
  snapshotAll(): HealthSnapshot[] {
    return [...this.states.keys()].map(target => this.snapshot(target));
  }

  /** How many recordings have happened. For the passivity test, not for display. */
  recordingCount(): number {
    return this.recordings;
  }

  /** Drop state for a session teardown or a test. */
  clear(): void {
    this.states.clear();
    this.recordings = 0;
  }
}

/** Rendered health rows for a status surface, or `[]` when no call has been observed yet. */
export function formatHealthRows(snapshots: HealthSnapshot[]): string[] {
  const observed = snapshots.filter(s => s.status !== "unknown");
  if (!observed.length) return [];
  return ["Target health (recorded from calls already made; never probed)", ...observed.map(s => {
    const detail = s.status === "error" ? ` (${s.lastFailure}${s.consecutiveFailures > 1 ? ` x${s.consecutiveFailures}` : ""})` : "";
    return `  ${s.target}: ${s.status}${detail}`;
  })];
}
