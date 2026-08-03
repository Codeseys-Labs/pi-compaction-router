/**
 * A ROUTED COMPACTION MUST GET THE SAME RETRY POLICY AS A NATIVE ONE.
 *
 * `compact()` takes `retry?: RetryPolicy` as argument 10, and pi passes its own
 * `settingsManager.getRetrySettings()` on both native compaction paths
 * (`dist/core/agent-session.js:1423`, `1662`). This package omitted it, which made a routed
 * compaction the one summarization call in the process running with retry disabled: a single
 * transient stream drop -- a `terminated`, a socket close -- burned the whole route hop where pi
 * would have retried and succeeded. Silent, and worse on exactly the long calls routing produces.
 *
 * These tests read the argument off a stubbed `compact()`, so they assert the wire, not the
 * intention. `mock.module` is restored in `afterAll` because bun's module mocks are process-wide and
 * would otherwise leak a stubbed `compact` into every later test file.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { beforeCompactEvent, withHost } from "./harness.js";

const ROUTER_CONFIG = { models: [{ model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" }] };
const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };
const COMPACT_RETRY_ARG_INDEX = 9; // 0-based: argument 10

let compactCalls: unknown[][] = [];

beforeAll(() => {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    ...pi,
    compact: async (...args: unknown[]) => {
      compactCalls.push(args);
      return { summary: "stubbed summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 1 };
    },
  }));
});

// Restore the real module, or a stubbed compact() leaks into every test file bun loads after this one.
afterAll(() => {
  mock.module("@earendil-works/pi-coding-agent", () => ({ ...pi }));
});

/** Route one real-mass compaction through the handler and return `compact()`'s arguments. */
async function routedCompactArgs(hostSettings?: Record<string, unknown>): Promise<unknown[]> {
  compactCalls = [];
  const result = await withHost(
    { routerConfig: ROUTER_CONFIG, hostSettings, findModel: FOUND_MODEL, auth: GOOD_AUTH },
    host => host.emit("session_before_compact", beforeCompactEvent()),
  );
  // The compaction must actually have been routed, or reading its arguments proves nothing.
  expect(result).toMatchObject({ compaction: { summary: "stubbed summary" } });
  expect(compactCalls.length).toBe(1);
  return compactCalls[0]!;
}

describe("retry parity with pi's native compaction", () => {
  test("passes the host's retry policy as compact() argument 10", async () => {
    const retry = (await routedCompactArgs({ retry: { enabled: true, maxRetries: 4, baseDelayMs: 250 } }))[COMPACT_RETRY_ARG_INDEX];
    expect(retry).toMatchObject({ enabled: true, maxRetries: 4, baseDelayMs: 250 });
  });

  test("a host that disabled retry has that honoured, not overridden", async () => {
    // The policy is the host's to set. Reading it means respecting `enabled: false` too.
    const retry = (await routedCompactArgs({ retry: { enabled: false, maxRetries: 9, baseDelayMs: 10 } }))[COMPACT_RETRY_ARG_INDEX];
    expect(retry).toMatchObject({ enabled: false });
  });

  test("a host that set no retry block still gets pi's defaults, not undefined", async () => {
    // getRetrySettings() applies pi's own defaults, so an unconfigured host gets what pi's native
    // compaction gets. Passing undefined here would silently reintroduce the defect.
    const retry = (await routedCompactArgs())[COMPACT_RETRY_ARG_INDEX] as { enabled: boolean; maxRetries: number; baseDelayMs: number };
    expect(retry).toBeDefined();
    expect(typeof retry.enabled).toBe("boolean");
    expect(typeof retry.maxRetries).toBe("number");
    expect(typeof retry.baseDelayMs).toBe("number");
  });

  test("every target in a chain is given the same policy, read once", async () => {
    // The policy is read once per compaction, not once per hop: it is a settings file read, and a
    // three-target chain must not become three of them. Assert the observable consequence -- the hop
    // that finally succeeds still carries the policy -- rather than counting file reads.
    compactCalls = [];
    const chain = { models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }] };
    let attempt = 0;
    await withHost(
      { routerConfig: chain, hostSettings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } }, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      host => {
        // The first two hops fail authentication, so the chain advances to the third.
        (host.ctx.modelRegistry as { getApiKeyAndHeaders: unknown }).getApiKeyAndHeaders = async () =>
          attempt++ < 2 ? { ok: false, error: "unauthenticated in this test" } : GOOD_AUTH;
        return host.emit("session_before_compact", beforeCompactEvent());
      },
    );
    // Three hops attempted, the third served it -- so the chain really did advance.
    expect(attempt).toBe(3);
    expect(compactCalls.length).toBe(1);
    expect(compactCalls[0]![COMPACT_RETRY_ARG_INDEX]).toMatchObject({ maxRetries: 3 });
  });

  test("the retry argument sits in the slot compact() reads it from", async () => {
    // Positional arguments are the failure mode here: a policy passed one slot early lands in `env`
    // and is silently ignored. Pin the neighbours so a signature change is caught, not absorbed.
    const args = await routedCompactArgs({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } });
    expect(args[6]).toBe("low");          // thinkingLevel, from the route target
    expect(args[7]).toBeUndefined();      // streamFn: still pi's own (an open upstream gap, G-stream)
    expect(args[8]).toEqual({});          // env, from getApiKeyAndHeaders
    expect(args[COMPACT_RETRY_ARG_INDEX]).toMatchObject({ maxRetries: 2 });
  });
});
