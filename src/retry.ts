/**
 * Per-target retry: try a transiently-failed target again before advancing the route chain.
 *
 * Upstream: https://github.com/algal/pi-openai-server-compaction, `src/remote-compaction.ts` --
 * `RemoteCompactionError`, `NON_RETRYABLE_REMOTE_COMPACTION_LIMIT_PATTERN`,
 * `RETRYABLE_REMOTE_COMPACTION_ERROR_PATTERN`, `isRetryableRemoteCompactionError`,
 * `retryAfterDelayMs`, `sleepForRemoteCompactionRetry`, and the retry loop in
 * `callRemoteCompactionEndpoint` (the `MAX_REMOTE_COMPACTION_RETRY_DELAY_MS` ceiling arm). Read at
 * PR #7 head 9ea79cb89fecca4c7ab09739530ee78a654cd32f (`refs/pull/7/head`), not from a published
 * tarball. MIT, Copyright (c) 2026 Alexis Gallagher.
 *
 * Adapted, not vendored. Upstream retries one HTTP endpoint it owns end-to-end and can read response
 * headers from; we retry an opaque `compact()` call that throws an `Error`, so the classifier has to
 * work from a message as well as from structured data, and `retryAfterDelayMs` is exported as a
 * header-getter function rather than reading a `Response`. The three mechanisms below are upstream's,
 * and each earns its place against a defect this package had:
 *
 *  1. **Typed classification with a quota veto.** We dropped a target on its first throw, so one
 *     `server_is_overloaded` cost the whole route hop. But a naive "retry everything" is worse: an
 *     `insufficient_quota` error would burn four attempts and four rate-limit windows to learn
 *     something the first response already said. Upstream's shape -- a retryable pattern AND a
 *     non-retryable quota/billing pattern that overrides it -- is what makes retry safe to add.
 *  2. **`retry-after-ms` preferred over `retry-after`,** with an HTTP-date fallback, and a fail-fast
 *     when the provider's requested delay exceeds a 60 s ceiling. The inversion is the insight:
 *     sleeping fifteen minutes inside a compaction is strictly worse than failing over to the next
 *     target, because there IS a next target. A router has an option a single-endpoint client does
 *     not, so it should take it.
 *  3. **Abort honoured INSIDE the backoff sleep,** with `removeEventListener` cleanup and a
 *     synthesized `AbortError`. Our `event.signal.aborted` check only ran between attempts; a naive
 *     `setTimeout` backoff would sit through a user cancel and then return a summary nobody wanted.
 *
 * One divergence, deliberate: `cooldownWorthy` (below) is true for `quota` as well as `retryable`,
 * where upstream cools nothing down at all (it has no cooldown layer) and pi-blackhole cools down
 * only retryable errors. See the field comment for the reason.
 */

import { errorMessage, isRetryableError, isStaleExtensionContextError } from "./retryable-error.js";

/**
 * Sleeping longer than this inside a compaction is refused in favour of the next route target.
 * Upstream's `MAX_REMOTE_COMPACTION_RETRY_DELAY_MS`, same value, load-bearing for the same reason.
 */
export const MAX_RETRY_DELAY_MS = 60_000;
/** Upstream's `DEFAULT_REMOTE_COMPACTION_MAX_RETRIES` / `..._RETRY_BASE_DELAY_MS`. */
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1_000;
/** Upstream's `MAX_REMOTE_COMPACTION_RETRIES`: a config typo must not become an unbounded loop. */
export const MAX_RETRIES_CEILING = 10;

/**
 * Billing and quota exhaustion, which VETOES retry however transient the rest of the message looks.
 *
 * Upstream's `NON_RETRYABLE_REMOTE_COMPACTION_LIMIT_PATTERN`, unmodified. It has to override rather
 * than merely fail to match, because a real provider message is often BOTH: `429 Too Many Requests:
 * insufficient_quota` matches every rate-limit alternative in the retryable pattern. Order alone
 * would not save us; the veto is checked first and wins.
 */
export const NON_RETRYABLE_LIMIT_PATTERN = /insufficient_quota|quota exceeded|out of budget|billing|usage limit/i;

/**
 * Transient alternatives upstream's pattern carries that pi-blackhole's `RETRYABLE_ERROR_RE` does
 * not. Both patterns are consulted; neither is edited, so a future upstream read stays a diff.
 */
export const ADDITIONAL_RETRYABLE_PATTERN = /temporar(?:y|ily)|you can retry your request|please retry|socket|upstream/i;

/** What a failed attempt was, once classified. */
export type FailureClass =
  /** Weather: the same call may work. Retry, then cool the target down if it keeps failing. */
  | "retryable"
  /**
   * A rate limit whose requested delay exceeded the 60 s ceiling.
   *
   * Its own class rather than a `permanent` in disguise, because it needs a combination no other class
   * has: do NOT sleep (that is the whole point of the ceiling), DO advance the chain, and DO cool the
   * target down -- it just told us it needs fifteen minutes, so trying it on the next compaction is
   * known waste rather than merely likely waste. Folding this into `permanent` let the target escape
   * cooldown, which a test caught.
   */
  | "rate-limited-past-ceiling"
  /** Out of money or out of budget. Never retried -- the answer will not change this minute. */
  | "quota"
  /** Pi replaced the session under us. Not the model's fault; never held against the target. */
  | "stale-context"
  /** The operator cancelled. Stop entirely; do not advance the chain, do not warn. */
  | "aborted"
  /** A real defect: a 400, a bad `customInstructions`, a malformed request. Advance, never retry. */
  | "permanent";

export interface Classification {
  kind: FailureClass;
  /** Whether this target should be tried again. False for everything except `retryable`. */
  retryable: boolean;
  /**
   * Whether the target earns a persisted cooldown.
   *
   * `retryable` yes: a flapping provider that fails every attempt should not be re-tried on every
   * compaction for the rest of the day. `quota` yes, and this is where we diverge from both
   * upstreams: pi-blackhole records a cooldown only for retryable errors, because its quota
   * exhaustion arrives dressed as a retryable 429 and never gets classified apart. We classify it
   * apart precisely so it cannot burn retries -- and a target that is out of budget is the strongest
   * cooldown case there is, since retrying it next compaction is guaranteed waste rather than merely
   * likely waste. `stale-context` no, emphatically: reloading a session must not cool down the
   * operator's best model for an hour. `aborted` no. `permanent` no -- a misconfiguration is not
   * fixed by waiting, and hiding the target behind a cooldown would hide the error too.
   */
  cooldownWorthy: boolean;
  /** A brief message, safe to persist into the cooldown record. */
  message: string;
  /** The provider's own requested delay, if it named one. */
  retryAfterMs?: number;
}

/**
 * An attempt failure carrying structure a message cannot: an explicit retryable flag, the provider's
 * requested delay, a provider error code.
 *
 * Upstream's `RemoteCompactionError`, renamed for this package's scope and exported because a caller
 * that CAN produce structure (a route target wrapping its own fetch) should be able to hand it over
 * rather than round-tripping through a string.
 */
export class RouteAttemptError extends Error {
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(message: string, options: { retryable?: boolean; retryAfterMs?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RouteAttemptError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
  }
}

/** A cancel, in the shape `AbortSignal` consumers already recognise. Upstream's synthesized error. */
export function routeAbortError(message = "Routed compaction was aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * The provider's requested delay, in milliseconds, preferring `retry-after-ms` over `retry-after`.
 *
 * Upstream's `retryAfterDelayMs`, taking a getter instead of a `Headers` so it is callable against
 * anything header-shaped -- including a plain object in a test, which is the only way to assert the
 * preference order without standing up an HTTP server. `retry-after` may be seconds or an HTTP date;
 * both are handled, and a negative result (a date already past) clamps to 0 rather than going
 * backwards.
 */
export function retryAfterDelayMs(get: (name: string) => string | null | undefined, now = Date.now()): number | undefined {
  const millis = get("retry-after-ms");
  if (millis !== null && millis !== undefined && millis !== "") {
    const parsed = Number(millis);
    // `retry-after-ms` is preferred, but an unparseable value must fall through to `retry-after`
    // rather than swallow the header pair: a provider that sent both meant to be understood.
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  const retryAfter = get("retry-after");
  if (retryAfter === null || retryAfter === undefined || retryAfter === "") return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Trim a trailing JSON body off a provider message, so a cooldown record stays readable.
 *
 * pi-blackhole's `recordRetryableError` cleanup (`om/runtime.ts`), with its caveat actually enforced.
 * Upstream's comment states the intent -- "to avoid stripping non-JSON braces like `{host}`, only
 * strip if the text after the brace pair consists solely of whitespace" -- but its regex,
 * `/\s*\{[\s\S]*?\}\s*$/`, does not achieve it: a trailing `{host}` IS a brace pair followed by only
 * whitespace, so upstream turns `connection refused to {host}` into `connection refused to`. Found by
 * writing the test upstream's comment implies. Here the candidate must actually PARSE as JSON before
 * it is dropped, which is the check the comment describes.
 */
function brief(message: string): string {
  const match = /\s*(\{[\s\S]*\})\s*$/.exec(message);
  if (!match) return message.trim();
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (typeof parsed !== "object" || parsed === null) return message.trim();
  } catch {
    return message.trim();
  }
  return message.slice(0, match.index).trim() || message.trim();
}

/**
 * Classify a thrown value from one route target's `compact()` attempt.
 *
 * Order is the contract, not an implementation detail:
 *   abort   -- an operator cancel is not a model failure and outranks everything.
 *   stale   -- pi replaced the session; the target is blameless.
 *   ceiling -- our own fail-fast marker, which must not be re-read as the rate limit it wrapped.
 *   quota   -- the veto. Checked BEFORE anything retryable, because a quota message usually also
 *              matches a rate-limit pattern, and getting this order wrong is how four attempts get
 *              spent learning what the first response said.
 *   structured retryable flag -- a caller that knows better than a regex.
 *   patterns -- last resort, over the message.
 *
 * One consequence worth naming, because a reader will look for it: a provider whose message mentions a
 * usage limit AND asks for a 15-minute delay is classified `quota`, never `rate-limited-past-ceiling`.
 * `withTargetRetry` classifies the attempt before it consults the requested delay, so the veto exits
 * the loop first and the ceiling arm is never constructed. That is the better diagnosis anyway -- and
 * both classes cool the target down and advance the chain, so nothing is lost. Pinned by a test.
 */
export function classifyFailure(error: unknown): Classification {
  const message = brief(errorMessage(error)) || "unknown error";
  if (isAbortError(error)) return { kind: "aborted", retryable: false, cooldownWorthy: false, message };
  if (isStaleExtensionContextError(error)) return { kind: "stale-context", retryable: false, cooldownWorthy: false, message };

  const retryAfterMs = error instanceof RouteAttemptError ? error.retryAfterMs : undefined;
  const raw = errorMessage(error);
  // Checked before the veto so that OUR marker is never re-read as the provider text it wrapped. In
  // practice a quota message never gets here (see the note above), but the marker is explicit and an
  // explicit marker should outrank a pattern match on a message we composed ourselves.
  if (error instanceof RouteAttemptError && error.code === CEILING_EXCEEDED_CODE) {
    return { kind: "rate-limited-past-ceiling", retryable: false, cooldownWorthy: true, message, retryAfterMs };
  }
  if (NON_RETRYABLE_LIMIT_PATTERN.test(raw)) {
    // The veto applies even to an error that declared itself retryable. A caller can be wrong about
    // this, a billing message cannot: whatever the flag says, spending attempts on an exhausted quota
    // buys nothing. This is stricter than upstream, which lets its own structured flag win.
    return { kind: "quota", retryable: false, cooldownWorthy: true, message, retryAfterMs };
  }
  if (error instanceof RouteAttemptError && error.retryable !== undefined) {
    return error.retryable
      ? { kind: "retryable", retryable: true, cooldownWorthy: true, message, retryAfterMs }
      : { kind: "permanent", retryable: false, cooldownWorthy: false, message, retryAfterMs };
  }
  // Upstream also treats a bare `TypeError` as retryable, on the grounds that `fetch` reports network
  // failure that way. Kept: `compact()` reaches a provider through the same primitive.
  if (error instanceof TypeError || isRetryableError(error) || ADDITIONAL_RETRYABLE_PATTERN.test(raw)) {
    return { kind: "retryable", retryable: true, cooldownWorthy: true, message, retryAfterMs };
  }
  return { kind: "permanent", retryable: false, cooldownWorthy: false, message, retryAfterMs };
}

/** The part of `AbortSignal` this module uses, so a host (or a test) may supply less than all of it. */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
}

/**
 * Sleep, and reject the moment the signal aborts.
 *
 * Upstream's `sleepForRemoteCompactionRetry`. Optional-chained on `addEventListener` for the same
 * reason `AbortLike` exists: pi's `session_before_compact` hands us a real `AbortSignal`, but the
 * aborted-flag-only shape is what a non-interactive host and a test both actually produce, and a
 * missing listener API must degrade to a plain sleep rather than throw.
 */
export function sleepForRetry(delayMs: number, signal?: AbortLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(routeAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(routeAbortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export interface RetryNotice {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  classification: Classification;
  /** The delay about to be slept, after the provider's request and the ceiling are applied. */
  delayMs: number;
}

export interface RetryOptions {
  /** Retries AFTER the first attempt. `0` means one attempt and no retry. */
  maxRetries?: number;
  baseDelayMs?: number;
  signal?: AbortLike;
  /** Injectable for tests; production uses `sleepForRetry`. */
  sleep?: (delayMs: number, signal?: AbortLike) => Promise<void>;
  /** Called before each sleep, so a caller can report "retrying target X in Ns". */
  onRetry?: (notice: RetryNotice) => void;
}

/** Upstream's `normalizedRetryCount` / `normalizedBaseDelayMs`: clamp config, never trust it. */
function normalizedRetryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
  return Math.min(MAX_RETRIES_CEILING, Math.max(0, Math.floor(value)));
}
function normalizedBaseDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BASE_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.floor(value)));
}

/** Marks a `RouteAttemptError` as the ceiling fail-fast, so `classifyFailure` can tell it apart. */
export const CEILING_EXCEEDED_CODE = "retry_after_exceeds_ceiling";

/**
 * The thrown value when a provider asks for a delay past the ceiling. Non-retryable BY CONSTRUCTION:
 * the point of the fail-fast is that the route chain advances now instead of sleeping.
 *
 * It carries `CEILING_EXCEEDED_CODE` because "do not retry" is not the whole truth about it -- it was
 * still a rate limit, and the target still earns a cooldown. Without the code it classified as
 * `permanent` and the target escaped cooldown entirely, so the next compaction would ask a provider
 * that wants fifteen minutes to try again immediately.
 */
export function ceilingExceededError(message: string, requestedMs: number, cause?: unknown): RouteAttemptError {
  return new RouteAttemptError(
    `${message} (provider requested a ${Math.ceil(requestedMs / 1_000)}s retry delay, maximum ${MAX_RETRY_DELAY_MS / 1_000}s)`,
    { retryable: false, retryAfterMs: requestedMs, code: CEILING_EXCEEDED_CODE, cause },
  );
}

/**
 * Run one route target's attempt, retrying transient failures, and throw whatever finally defeats it.
 *
 * The caller's contract, which is what makes this composable with a route chain: this function never
 * decides whether to advance. It returns a value or throws, and the thrown value is classified --
 * `classifyFailure` on it tells the chain what happened. That separation is why the failure-gated
 * advance in `src/chain.ts` can be tested without a retry loop and this can be tested without a chain.
 */
export async function withTargetRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = normalizedRetryCount(options.maxRetries);
  const baseDelayMs = normalizedBaseDelayMs(options.baseDelayMs);
  const sleep = options.sleep ?? sleepForRetry;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error) {
      // An abort observed between attempts is a cancel, whatever the attempt threw on its way out.
      if (options.signal?.aborted) throw routeAbortError();
      const classification = classifyFailure(error);
      if (!classification.retryable || attempt > maxRetries) throw error;

      const requested = classification.retryAfterMs;
      if (requested !== undefined && requested > MAX_RETRY_DELAY_MS) {
        // Fail FAST, not slow: there is a next target, and reaching it beats sleeping past the
        // ceiling. Rethrown as non-retryable so nothing upstream of us re-enters this loop.
        throw ceilingExceededError(classification.message, requested, error);
      }
      const delayMs = Math.min(requested ?? baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      options.onRetry?.({ attempt, classification, delayMs });
      // Abort is honoured INSIDE this call, not merely around it.
      await sleep(delayMs, options.signal);
    }
  }
}
