/**
 * A REAL-MASS, TOOL-HEAVY COMPACTION PREPARATION.
 *
 * Why this file exists. The context-fit guard shipped 3.7x-37.9x too pessimistic and falsely
 * refused to route 5 of 14 real sessions at a 272k window, and every one of the four handler tests
 * that existed at the time passed anyway. They passed because their `preparation` was
 * `{ fileOps, settings, messages: [] }` -- and `messages` is not a field of pi's
 * `CompactionPreparation` at all. The estimator read `messagesToSummarize` and `turnPrefixMessages`,
 * found `undefined` for both, and measured nothing. Four tests of the exhaustion path, zero grams of
 * mass between them.
 *
 * So the fixture is the countermeasure, not a convenience: any test that drives the handler builds
 * its preparation here, with the real field names pi uses, carrying real bulk.
 *
 * Calibration. `TOOL_HEAVY_TURNS` etc. are tuned so `tokensBefore` lands at 268 640 -- within 57
 * tokens of the 268 697-token session recorded in `dive-ours-pi-compaction-router.md` §5.2, the one
 * the router refused at a 272 000-token target that its real prompt fits inside with 199k to spare.
 * The old estimator reads this fixture at 564 280 tokens and the new one at 58 295, a 9.68x ratio
 * against §5.2's measured 9.6x for that session. Those are not free parameters: they are the numbers
 * that make this fixture a reproduction rather than a large blob. The tests below assert on the
 * behavioural consequence (old refuses, new routes) rather than these exact integers, which shift
 * with pi's serializer; the numbers are recorded here so a future drift is legible.
 */

import { convertToLlm, estimateTokens, serializeConversation, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

type Preparation = SessionBeforeCompactEvent["preparation"];
type SummarizedMessages = Preparation["messagesToSummarize"];

/** Pi's catalogued context window for every `openai-codex/gpt-5.*` model, and §5.2's threshold. */
export const WINDOW_272K = 272_000;
/** Pi's `DEFAULT_COMPACTION_SETTINGS.reserveTokens`, which is what the live host runs with. */
export const RESERVE_TOKENS = 16_384;

const TOOL_HEAVY_TURNS = 30;
const USER_REPEAT = 12;
const THINKING_REPEAT = 110;
const ASSISTANT_TEXT_REPEAT = 55;
const TOOL_RESULT_REPEAT = 1_240;

/**
 * A code-agent history: user asks, assistant thinks and reads a file, a large tool result comes
 * back. Mostly tool-result mass, which is the shape the old estimator diverged on without bound --
 * it counted the whole result where `serializeConversation` truncates each one to 2 000 chars.
 */
export function toolHeavyMessages(turns = TOOL_HEAVY_TURNS): SummarizedMessages {
  const messages: SummarizedMessages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Investigate module ${i}. `.repeat(USER_REPEAT) }],
      timestamp: 0,
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `Reasoning about module ${i}: `.repeat(THINKING_REPEAT) },
        { type: "text", text: `Read file ${i} and found the relevant symbol. `.repeat(ASSISTANT_TEXT_REPEAT) },
        { type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/repo/src/module-${i}.ts` } },
      ],
      timestamp: 0,
      stopReason: "toolUse",
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as SummarizedMessages[number]);
    messages.push({
      role: "toolResult",
      content: [{ type: "text", text: `export const sym${i} = ${i};\n`.repeat(TOOL_RESULT_REPEAT) }],
      toolCallId: `call-${i}`,
      toolName: "read",
      isError: false,
      timestamp: 0,
    } as SummarizedMessages[number]);
  }
  return messages;
}

/** Pi's own accounting of what this history costs in context, via its exported `estimateTokens`. */
export function tokensBefore(messages: SummarizedMessages): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * The estimator this package shipped with, kept executable so the real-mass tests can prove they
 * discriminate: a fixture that the old formula skips and the new one routes is a regression test,
 * whereas a fixture both accept proves nothing. `src/index.ts:15-18` at commit 332f371.
 */
export function legacyEstimatedInputTokens(preparation: Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages" | "previousSummary">): number {
  return Math.ceil(JSON.stringify([preparation.previousSummary ?? "", preparation.messagesToSummarize, preparation.turnPrefixMessages]).length / 2);
}

/** The honest estimate, computed independently of `src/` so the tests are not tautological. */
export function serializedPromptTokens(preparation: Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages" | "previousSummary">): number {
  const chars = (messages: SummarizedMessages) => messages.length === 0 ? 0 : serializeConversation(convertToLlm(messages)).length;
  return Math.ceil((chars(preparation.messagesToSummarize) + chars(preparation.turnPrefixMessages) + (preparation.previousSummary?.length ?? 0)) / 4);
}

export interface PreparationOptions {
  messagesToSummarize?: SummarizedMessages;
  turnPrefixMessages?: SummarizedMessages;
  previousSummary?: string;
  isSplitTurn?: boolean;
  reserveTokens?: number;
}

/** A `CompactionPreparation` with pi's real field names. Never `messages: []`. */
export function buildPreparation(options: PreparationOptions = {}): Preparation {
  const messagesToSummarize = options.messagesToSummarize ?? toolHeavyMessages();
  const turnPrefixMessages = options.turnPrefixMessages ?? [];
  return {
    firstKeptEntryId: "entry-first-kept",
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: options.isSplitTurn ?? turnPrefixMessages.length > 0,
    tokensBefore: tokensBefore(messagesToSummarize),
    previousSummary: options.previousSummary,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: options.reserveTokens ?? RESERVE_TOKENS, keepRecentTokens: 20_000 },
  };
}
