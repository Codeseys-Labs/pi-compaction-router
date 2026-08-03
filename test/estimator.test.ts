/**
 * THE FALSE-SKIP REGRESSION TESTS.
 *
 * The context-fit guard used to JSON-stringify the message objects and divide by 2. That is 3.7x-37.9x
 * too high on real transcripts, and it falsely refused to route 5 of 14 of them at a 272 000-token
 * target their real prompts fit inside -- on precisely the big tool-heavy sessions routing exists
 * for. The guard was anti-correlated with the feature's purpose, and it told the operator the cause
 * was "a configuration problem".
 *
 * Every test here drives the REAL `session_before_compact` handler against a >=100k-token tool-heavy
 * preparation (`fixtures/real-mass.ts`, calibrated to §5.2's 268 697-token case). None uses
 * `messages: []`.
 */

import { describe, expect, test } from "bun:test";
import { buildPreparation, legacyEstimatedInputTokens, RESERVE_TOKENS, serializedPromptTokens, toolHeavyMessages, WINDOW_272K } from "./fixtures/real-mass.js";
import { beforeCompactEvent, withHost } from "./harness.js";

const TARGET = "openai-codex/gpt-5.4-mini";
const ROUTER_CONFIG = { models: [{ model: TARGET, thinkingLevel: "low" }] };

/** Pi's catalogued `gpt-5.4-mini`: the model the live host's default route actually points at. */
const GPT_5_4_MINI = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: WINDOW_272K, maxTokens: 128_000 };

/**
 * Drive the handler with a target the registry FINDS and would AUTHENTICATE. Auth is the tell: the
 * fit guard sits before it, so "auth was reached" means the target was not skipped for size. Auth
 * then fails deliberately, which keeps the test off the network -- the assertion is about routing,
 * not summarizing.
 */
async function didReachAuth(options: Parameters<typeof beforeCompactEvent>[0] = {}, reserveTokens = RESERVE_TOKENS): Promise<{ reachedAuth: boolean; result: unknown }> {
  let reachedAuth = false;
  const result = await withHost(
    {
      routerConfig: ROUTER_CONFIG,
      findModel: GPT_5_4_MINI,
      auth: { get ok() { reachedAuth = true; return false; }, error: "auth deliberately refused after the fit guard" },
    },
    host => host.emit("session_before_compact", beforeCompactEvent({ ...options, reserveTokens })),
  );
  return { reachedAuth, result };
}

describe("context-fit estimator", () => {
  test("the fixture is real mass, at the scale the defect was measured on", () => {
    const preparation = buildPreparation();
    // A guard cannot trip at 481 tokens, which is all the original live proof ever exercised.
    expect(preparation.tokensBefore).toBeGreaterThan(100_000);
    expect(preparation.messagesToSummarize.length).toBeGreaterThan(0);
  });

  test("the old formula over-counts this history by more than 3.7x, the low end of the measured range", () => {
    const preparation = buildPreparation();
    const ratio = legacyEstimatedInputTokens(preparation) / serializedPromptTokens(preparation);
    expect(ratio).toBeGreaterThan(3.7);
  });

  test("the old formula FALSELY SKIPS a 272k target this prompt fits inside with room to spare", () => {
    const preparation = buildPreparation();
    // Old: refuses. This is the shipped defect, reproduced.
    expect(legacyEstimatedInputTokens(preparation) + RESERVE_TOKENS).toBeGreaterThan(WINDOW_272K);
    // New: fits, and not marginally -- the real prompt leaves six figures of headroom.
    expect(serializedPromptTokens(preparation) + RESERVE_TOKENS).toBeLessThan(WINDOW_272K);
    expect(WINDOW_272K - (serializedPromptTokens(preparation) + RESERVE_TOKENS)).toBeGreaterThan(100_000);
  });

  test("the handler ROUTES the real-mass session the old estimator refused", async () => {
    const { reachedAuth } = await didReachAuth();
    // Under the old estimator this was false: the target was skipped for size before auth. This
    // single assertion is the regression test for the whole defect.
    expect(reachedAuth).toBe(true);
  });

  test("estimates the artifact compact() actually sends: a 200k-char tool result is truncated, not counted whole", async () => {
    // serializeConversation truncates every tool result to TOOL_RESULT_MAX_CHARS = 2000, so one huge
    // result must not be able to veto a target. Under the old formula it could, single-handedly.
    const huge = toolHeavyMessages(1);
    huge[huge.length - 1] = { ...huge[huge.length - 1], content: [{ type: "text", text: "y".repeat(200_000) }] } as typeof huge[number];
    const preparation = buildPreparation({ messagesToSummarize: huge });
    expect(serializedPromptTokens(preparation)).toBeLessThan(5_000);
    const { reachedAuth } = await didReachAuth({ messagesToSummarize: huge });
    expect(reachedAuth).toBe(true);
  });

  test("the guard still REFUSES a target that genuinely cannot fit", async () => {
    // The fix must not be "delete the guard". A 4k window cannot hold this history's real prompt.
    let reachedAuth = false;
    await withHost(
      {
        routerConfig: ROUTER_CONFIG,
        findModel: { ...GPT_5_4_MINI, contextWindow: 4_000 },
        auth: { get ok() { reachedAuth = true; return true; }, apiKey: "k", headers: {} },
      },
      host => host.emit("session_before_compact", beforeCompactEvent()),
    );
    expect(reachedAuth).toBe(false);
  });

  test("previousSummary counts toward the estimate: it rides in the same prompt", () => {
    const previousSummary = "z".repeat(400_000);
    const withSummary = serializedPromptTokens(buildPreparation({ previousSummary }));
    const without = serializedPromptTokens(buildPreparation());
    // Pi appends it as a <previous-summary> block in generateSummaryWithUsage, so an estimate that
    // ignored it would under-count an iterative compaction by exactly this much.
    expect(withSummary - without).toBe(Math.ceil(previousSummary.length / 4));
  });

  test("a huge previousSummary can legitimately push a target over its window", async () => {
    // The counterpart to the test above, through the handler: previousSummary is load-bearing, not
    // decorative. 272k window, ~58k of history, plus a >1M-char prior summary.
    const { reachedAuth } = await didReachAuth({ previousSummary: "z".repeat(1_100_000) });
    expect(reachedAuth).toBe(false);
  });

  test("the turn-prefix half counts: a split turn is TWO summarization calls", () => {
    // compact() calls generateSummaryWithUsage over messagesToSummarize AND generateTurnPrefixSummary
    // over turnPrefixMessages when isSplitTurn. Both serialize the same way, so both count.
    const turnPrefixMessages = toolHeavyMessages(6);
    const split = serializedPromptTokens(buildPreparation({ turnPrefixMessages, isSplitTurn: true }));
    const historyOnly = serializedPromptTokens(buildPreparation());
    expect(split).toBeGreaterThan(historyOnly);
    // Within 1: the estimator sums both halves' characters and rounds once, so it can land a token
    // below the sum of two separately-rounded halves. That is the intended direction (one ceiling,
    // not two) and the tolerance names it rather than hiding it.
    const prefixAlone = serializedPromptTokens(buildPreparation({ messagesToSummarize: turnPrefixMessages }));
    expect(Math.abs(split - historyOnly - prefixAlone)).toBeLessThanOrEqual(1);
  });

  test("an empty half contributes nothing rather than serializer scaffolding", () => {
    const empty = buildPreparation({ messagesToSummarize: [], turnPrefixMessages: [] });
    expect(serializedPromptTokens(empty)).toBe(0);
  });
});
