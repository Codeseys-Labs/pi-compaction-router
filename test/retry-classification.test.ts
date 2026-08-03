/**
 * PER-TARGET RETRY, AND THE FOUR WAYS IT MUST REFUSE TO RETRY.
 *
 * Retry is the easy half. The hard half is everything it must NOT do, because each one is a way to
 * make the shipped behaviour worse rather than better:
 *
 *  - **Quota must veto retry.** An `insufficient_quota` retried four times spends four rate-limit
 *    windows learning what the first response said. And the veto has to OVERRIDE, not merely fail to
 *    match: real provider messages are usually both at once (`429 Too Many Requests:
 *    insufficient_quota` matches every rate-limit alternative in the retryable pattern), so a
 *    classifier that checked retryable-first would retry every quota error there is.
 *  - **A provider asking for 15 minutes must be failed FAST.** Sleeping past the 60 s ceiling inside a
 *    compaction is worse than failing over, because there IS a next target. Upstream's inversion.
 *  - **`retry-after-ms` must beat `retry-after`.** A provider that sends both means the precise one.
 *  - **Abort must be honoured INSIDE the sleep.** The pre-existing `event.signal.aborted` check only
 *    ran between attempts, so a naive `setTimeout` backoff would sit through a user cancel and then
 *    return a summary nobody wanted.
 *
 * Steal: algal/pi-openai-server-compaction PR #7 head 9ea79cb89fecca4c7ab09739530ee78a654cd32f
 * (`src/remote-compaction.ts`). See `src/retry.ts` for the provenance header.
 */

import { describe, expect, test } from "bun:test";
import { advancesChain } from "../src/chain.js";
import {
  classifyFailure,
  DEFAULT_MAX_RETRIES,
  MAX_RETRIES_CEILING,
  MAX_RETRY_DELAY_MS,
  retryAfterDelayMs,
  RouteAttemptError,
  routeAbortError,
  sleepForRetry,
  withTargetRetry,
} from "../src/retry.js";

/** A header bag as a getter, which is what `retryAfterDelayMs` takes so a test needs no HTTP server. */
const headers = (bag: Record<string, string>) => (name: string) => bag[name] ?? null;

describe("failure classification", () => {
  test("transient provider failures are retryable", () => {
    for (const message of [
      "server_is_overloaded",
      "429 Too Many Requests",
      "503 Service Unavailable",
      "fetch failed",
      "socket hang up",
      "the request timed out",
      "terminated",
      "upstream connect error",
    ]) {
      const c = classifyFailure(new Error(message));
      expect(c.kind, message).toBe("retryable");
      expect(c.retryable, message).toBeTrue();
    }
  });

  test("QUOTA VETOES RETRY, and it vetoes a message that also looks transient", () => {
    // This is the case the veto exists for. Every string here matches the retryable pattern too; if
    // the veto were merely an alternative that failed to match, all four would be retried.
    for (const message of [
      "429 Too Many Requests: insufficient_quota",
      "rate_limit_error: quota exceeded for this organization",
      "503 Service Unavailable — billing issue on your account",
      "server error: usage limit reached",
    ]) {
      const c = classifyFailure(new Error(message));
      expect(c.kind, message).toBe("quota");
      expect(c.retryable, message).toBeFalse();
    }
  });

  test("quota overrides even a caller that declared the error retryable", () => {
    // A caller can be wrong about this; a billing message cannot. Stricter than upstream on purpose.
    const c = classifyFailure(new RouteAttemptError("insufficient_quota", { retryable: true }));
    expect(c.kind).toBe("quota");
    expect(c.retryable).toBeFalse();
  });

  test("a real defect is permanent: never retried", () => {
    for (const message of ["400 Bad Request: unsupported thinking level", "invalid_request_error: tool schema is malformed", "model not found"]) {
      const c = classifyFailure(new Error(message));
      expect(c.kind, message).toBe("permanent");
      expect(c.retryable, message).toBeFalse();
    }
  });

  test("an abort is classified as an abort, not as a model failure", () => {
    const c = classifyFailure(routeAbortError());
    expect(c.kind).toBe("aborted");
    expect(c.retryable).toBeFalse();
    expect(c.cooldownWorthy).toBeFalse();
  });

  test("pi's stale-context error is never held against the target", () => {
    // The lesson pi-blackhole records: a session reload is not the model's fault, and cooling down the
    // operator's best model for an hour because they reloaded a session is a real harm.
    for (const message of ["extension ctx is stale", "Error: ctx is stale, session was replaced"]) {
      const c = classifyFailure(new Error(message));
      expect(c.kind, message).toBe("stale-context");
      expect(c.retryable, message).toBeFalse();
      expect(c.cooldownWorthy, message).toBeFalse();
    }
  });

  test("a structured retryable flag is honoured over the message patterns", () => {
    expect(classifyFailure(new RouteAttemptError("something bespoke", { retryable: true })).kind).toBe("retryable");
    // ...and a caller saying "not retryable" wins over a message that reads transient.
    expect(classifyFailure(new RouteAttemptError("overloaded", { retryable: false })).kind).toBe("permanent");
  });

  test("a bare TypeError is retryable, because that is how fetch reports a network failure", () => {
    expect(classifyFailure(new TypeError("Failed to fetch")).kind).toBe("retryable");
  });

  test("which failures earn a cooldown, and which must never", () => {
    expect(classifyFailure(new Error("overloaded")).cooldownWorthy).toBeTrue();
    // Out of budget is the strongest cooldown case: retrying next compaction is guaranteed waste.
    expect(classifyFailure(new Error("insufficient_quota")).cooldownWorthy).toBeTrue();
    // A misconfiguration is not fixed by waiting, and hiding the target would hide the error.
    expect(classifyFailure(new Error("400 Bad Request")).cooldownWorthy).toBeFalse();
    expect(classifyFailure(new Error("extension ctx is stale")).cooldownWorthy).toBeFalse();
    expect(classifyFailure(routeAbortError()).cooldownWorthy).toBeFalse();
  });

  test("a provider body is stripped out of the message a cooldown will persist", () => {
    const c = classifyFailure(new Error('overloaded {"error":{"type":"overloaded_error","request_id":"req_abc"}}'));
    expect(c.message).toBe("overloaded");
  });

  test("a trailing brace that is NOT JSON keeps its text -- upstream's caveat, actually enforced", () => {
    // pi-blackhole's comment says "to avoid stripping non-JSON braces like {host}, only strip if the
    // text after the brace pair consists solely of whitespace". Its regex does not achieve that: a
    // trailing `{host}` IS a brace pair followed by only whitespace, so upstream drops it. We require
    // the candidate to PARSE as JSON. This test is the reason for the divergence recorded in
    // src/retry.ts, and it fails against a literal port of upstream's regex.
    expect(classifyFailure(new Error("connection refused to {host}")).message).toBe("connection refused to {host}");
    expect(classifyFailure(new Error("overloaded: check {your,config}")).message).toBe("overloaded: check {your,config}");
  });

  test("a message that is nothing BUT a JSON body is kept, not emptied", () => {
    // Stripping to "" would put an empty reason into the cooldown file, where an operator reads it.
    const c = classifyFailure(new Error('{"error":{"message":"overloaded"}}'));
    expect(c.message).toBe('{"error":{"message":"overloaded"}}');
  });

  test("a non-Error throw is classified rather than crashing the classifier", () => {
    expect(classifyFailure("503 service unavailable").kind).toBe("retryable");
    expect(classifyFailure({ message: "insufficient_quota" }).kind).toBe("quota");
    expect(classifyFailure(undefined).message).toBe("unknown error");
  });
});

describe("retry-after header preference", () => {
  test("retry-after-ms is PREFERRED over retry-after", () => {
    // Both present, disagreeing. The ms header is the precise one and must win.
    expect(retryAfterDelayMs(headers({ "retry-after-ms": "1500", "retry-after": "30" }))).toBe(1500);
  });

  test("retry-after in seconds is used when no ms header is sent", () => {
    expect(retryAfterDelayMs(headers({ "retry-after": "30" }))).toBe(30_000);
  });

  test("retry-after as an HTTP date falls back to a delta from now", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    expect(retryAfterDelayMs(headers({ "retry-after": "Sun, 02 Aug 2026 12:00:45 GMT" }), now)).toBe(45_000);
  });

  test("an HTTP date already in the past clamps to 0 rather than going backwards", () => {
    const now = Date.parse("2026-08-02T12:00:00Z");
    expect(retryAfterDelayMs(headers({ "retry-after": "Sun, 02 Aug 2026 11:59:00 GMT" }), now)).toBe(0);
  });

  test("an unparseable retry-after-ms falls THROUGH to retry-after, not to undefined", () => {
    // A provider that sent both meant to be understood; swallowing the pair would lose the request.
    expect(retryAfterDelayMs(headers({ "retry-after-ms": "soon", "retry-after": "5" }))).toBe(5_000);
  });

  test("no headers at all means no provider request", () => {
    expect(retryAfterDelayMs(headers({}))).toBeUndefined();
    expect(retryAfterDelayMs(headers({ "retry-after": "not-a-date" }))).toBeUndefined();
  });
});

describe("the retry loop", () => {
  /** A sleep that records what it was asked for and returns immediately: the suite stays fast. */
  function recordingSleep() {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => { delays.push(ms); } };
  }

  test("a transient failure is retried and the second attempt's success is returned", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    const result = await withTargetRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("server_is_overloaded");
      return "summary";
    }, { sleep, baseDelayMs: 100 });
    expect(result).toBe("summary");
    expect(attempts).toBe(2);
    expect(delays).toEqual([100]);
  });

  test("backoff is exponential off the base delay", async () => {
    const { delays, sleep } = recordingSleep();
    await expect(withTargetRetry(async () => { throw new Error("overloaded"); }, { sleep, baseDelayMs: 100, maxRetries: 3 })).rejects.toThrow("overloaded");
    expect(delays).toEqual([100, 200, 400]);
  });

  test("a QUOTA error is thrown on the FIRST attempt, with no sleep at all", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await expect(withTargetRetry(async () => { attempts += 1; throw new Error("insufficient_quota"); }, { sleep })).rejects.toThrow("insufficient_quota");
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("a permanent error is not retried either", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await expect(withTargetRetry(async () => { attempts += 1; throw new Error("400 Bad Request"); }, { sleep })).rejects.toThrow("400");
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("the provider's requested delay is used instead of the backoff curve", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await withTargetRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new RouteAttemptError("rate_limit", { retryable: true, retryAfterMs: 2_500 });
      return "ok";
    }, { sleep, baseDelayMs: 100 });
    expect(delays).toEqual([2_500]);
  });

  test("a delay past the 60s CEILING fails FAST instead of sleeping", async () => {
    // The inversion: sleeping 15 minutes inside a compaction is worse than failing over to the next
    // target. A router has an option a single-endpoint client does not.
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    const promise = withTargetRetry(async () => {
      attempts += 1;
      throw new RouteAttemptError("rate_limit_error", { retryable: true, retryAfterMs: 15 * 60_000 });
    }, { sleep });
    await expect(promise).rejects.toThrow(/provider requested a 900s retry delay, maximum 60s/);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("the ceiling error is non-retryable, so nothing re-enters the loop on it", async () => {
    // If it came back retryable, a caller wrapping this would sleep on the very delay we refused.
    const { sleep } = recordingSleep();
    let thrown: unknown;
    try {
      await withTargetRetry(async () => { throw new RouteAttemptError("rate_limit", { retryable: true, retryAfterMs: 120_000 }); }, { sleep });
    } catch (error) { thrown = error; }
    expect(classifyFailure(thrown).retryable).toBeFalse();
  });

  test("but the ceiling error STILL cools the target down: it was a rate limit", async () => {
    // Found by a test. Folding this into `permanent` made the target escape cooldown, so the next
    // compaction would immediately re-ask a provider that had just said it needs fifteen minutes.
    const { sleep } = recordingSleep();
    let thrown: unknown;
    try {
      await withTargetRetry(async () => { throw new RouteAttemptError("rate_limit", { retryable: true, retryAfterMs: 900_000 }); }, { sleep });
    } catch (error) { thrown = error; }
    const c = classifyFailure(thrown);
    expect(c.kind).toBe("rate-limited-past-ceiling");
    expect(c.retryable).toBeFalse();
    expect(c.cooldownWorthy).toBeTrue();
    // And it advances the chain, because reaching the next target is the point of the ceiling.
    expect(advancesChain(c)).toBeTrue();
  });

  test("a long delay on a QUOTA message never reaches the ceiling arm: the veto is earlier", async () => {
    // The veto fires while classifying the attempt, so the loop exits before it ever consults the
    // requested delay -- correct, and worth pinning: quota is the more specific diagnosis and the
    // ceiling's fail-fast has nothing to add once retry is already off the table. Both classes cool
    // the target down, so the operator loses nothing either way.
    const { delays, sleep } = recordingSleep();
    let thrown: unknown;
    try {
      await withTargetRetry(async () => { throw new RouteAttemptError("usage limit reached, retry later", { retryable: true, retryAfterMs: 900_000 }); }, { sleep });
    } catch (error) { thrown = error; }
    const c = classifyFailure(thrown);
    expect(c.kind).toBe("quota");
    expect(c.cooldownWorthy).toBeTrue();
    expect(advancesChain(c)).toBeTrue();
    expect(delays).toEqual([]);
  });

  test("a delay at exactly the ceiling is slept, not refused", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await withTargetRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new RouteAttemptError("overloaded", { retryable: true, retryAfterMs: MAX_RETRY_DELAY_MS });
      return "ok";
    }, { sleep });
    expect(delays).toEqual([MAX_RETRY_DELAY_MS]);
  });

  test("an exponential backoff that would exceed the ceiling is clamped to it", async () => {
    const { delays, sleep } = recordingSleep();
    await expect(withTargetRetry(async () => { throw new Error("overloaded"); }, { sleep, baseDelayMs: 40_000, maxRetries: 3 })).rejects.toThrow();
    expect(delays).toEqual([40_000, MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS]);
  });

  test("maxRetries 0 means one attempt", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await expect(withTargetRetry(async () => { attempts += 1; throw new Error("overloaded"); }, { sleep, maxRetries: 0 })).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test("an absurd maxRetries is clamped, so a config typo is not an unbounded loop", async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    await expect(withTargetRetry(async () => { attempts += 1; throw new Error("overloaded"); }, { sleep, maxRetries: 10_000, baseDelayMs: 1 })).rejects.toThrow();
    expect(attempts).toBe(MAX_RETRIES_CEILING + 1);
    expect(delays.length).toBe(MAX_RETRIES_CEILING);
  });

  test("an unset maxRetries uses the documented default", async () => {
    const { delays, sleep } = recordingSleep();
    await expect(withTargetRetry(async () => { throw new Error("overloaded"); }, { sleep, baseDelayMs: 1 })).rejects.toThrow();
    expect(delays.length).toBe(DEFAULT_MAX_RETRIES);
  });
});

describe("abort is honoured INSIDE the backoff sleep", () => {
  test("sleepForRetry rejects when the signal fires DURING the sleep", async () => {
    // The defect this closes: an `aborted` check that only runs between attempts sits through a user
    // cancel for the whole backoff, and then returns a summary nobody asked for.
    const controller = new AbortController();
    const started = Date.now();
    const promise = sleepForRetry(30_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/aborted/);
    // It rejected promptly rather than after the full 30s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("sleepForRetry rejects immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepForRetry(30_000, controller.signal)).rejects.toThrow(/aborted/);
  });

  test("the rejection is an AbortError, so a caller recognises it as a cancel", async () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try { await sleepForRetry(1_000, controller.signal); } catch (error) { thrown = error; }
    expect((thrown as Error).name).toBe("AbortError");
    expect(classifyFailure(thrown).kind).toBe("aborted");
  });

  test("the abort listener is REMOVED when the sleep completes normally", async () => {
    // Upstream's `removeEventListener` cleanup. Without it a long chain accumulates one dead listener
    // per retry on a signal that lives as long as the compaction.
    const controller = new AbortController();
    let added = 0, removed = 0;
    const signal = {
      get aborted() { return controller.signal.aborted; },
      addEventListener: (type: "abort", fn: () => void, options?: { once?: boolean }) => { added += 1; controller.signal.addEventListener(type, fn, options); },
      removeEventListener: (type: "abort", fn: () => void) => { removed += 1; controller.signal.removeEventListener(type, fn); },
    };
    await sleepForRetry(1, signal);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  test("the retry loop aborts mid-backoff rather than making another attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = withTargetRetry(async () => {
      attempts += 1;
      throw new Error("server_is_overloaded");
    }, { signal: controller.signal, baseDelayMs: 30_000 });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/aborted/);
    // One attempt made, and the second never happened because the sleep rejected.
    expect(attempts).toBe(1);
  });

  test("a signal-shaped object with no listener API still sleeps rather than throwing", async () => {
    // A non-interactive host, and every `beforeCompactEvent` in this suite, produce exactly this: an
    // `{aborted}` flag and nothing else. A missing listener API must degrade to a plain sleep.
    await expect(sleepForRetry(1, { aborted: false })).resolves.toBeUndefined();
  });

  test("a signal-shaped object already aborted is honoured without a listener API", async () => {
    await expect(sleepForRetry(30_000, { aborted: true })).rejects.toThrow(/aborted/);
  });

  test("an abort observed between attempts is a cancel, whatever the attempt threw", async () => {
    const { sleep } = { sleep: async () => {} };
    const controller = new AbortController();
    let thrown: unknown;
    try {
      await withTargetRetry(async () => {
        controller.abort();
        throw new Error("overloaded");
      }, { signal: controller.signal, sleep });
    } catch (error) { thrown = error; }
    expect((thrown as Error).name).toBe("AbortError");
  });
});
