import { compact, convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { configToSettingsValue, loadConfig, parseModelReference, parseSessionOverride, selectTargets, type CompactionReason, type RouterConfig } from "./config.js";
import { clearPendingWarning, setPendingWarning, takePendingWarning } from "./pending-warning.js";

/** Pi's `CompactionPreparation`, reached through the event that carries it rather than re-declared. */
type Preparation = SessionBeforeCompactEvent["preparation"];
type SummarizedMessages = Preparation["messagesToSummarize"];

const TAG = "pi-compaction-router";
const warn = (message: string, error?: unknown) => error === undefined ? console.warn(`[${TAG}] ${message}`) : console.warn(`[${TAG}] ${message}`, error);

/** Key for the durable not-routed banner. One key, so re-setting it replaces rather than stacks. */
const NOT_ROUTED_WIDGET_KEY = `${TAG}:not-routed`;

function restorePreviousFileOperations(preparation: { fileOps: { read: Set<string>; edited: Set<string> } }, branchEntries: Array<{ type: string; details?: unknown }>): void {
  const previous = [...branchEntries].reverse().find(entry => entry.type === "compaction");
  if (!previous || typeof previous.details !== "object" || previous.details === null) return;
  const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
  if (Array.isArray(details.readFiles)) for (const path of details.readFiles) if (typeof path === "string") preparation.fileOps.read.add(path);
  if (Array.isArray(details.modifiedFiles)) for (const path of details.modifiedFiles) if (typeof path === "string") preparation.fileOps.edited.add(path);
}

/**
 * Estimate the tokens the summarization prompt will actually carry, by measuring the artifact
 * `compact()` actually sends.
 *
 * Upstream: pi itself. `compact()` -> `generateSummaryWithUsage` builds its prompt as
 * `serializeConversation(convertToLlm(messagesToSummarize))`, and the split-turn arm adds a second
 * call over `turnPrefixMessages` the same way (`dist/core/compaction/compaction.js:461-462,
 * 584-588, 618-619`). Both functions are exported from the package, so this reuses pi's own code
 * rather than reimplementing the primitive.
 *
 * This replaces a `JSON.stringify(<message objects>).length / 2` estimate that was measured
 * 3.7x-37.9x too high across 14 real transcripts, and falsely refused 5 of them at a 272k window --
 * on the exact tool-heavy sessions routing exists for. Two errors compounded there: chars/2 where
 * pi's own conservative heuristic is chars/4 (`estimateTokens`,
 * `dist/core/compaction/compaction.js:188-213`), and measuring the message *objects* -- every JSON
 * key, quote, escaped newline, toolCallId and timestamp, plus tool results at full length -- when
 * `serializeConversation` truncates every tool result to `TOOL_RESULT_MAX_CHARS = 2000`
 * (`dist/core/compaction/utils.js:75, 128-133`). On a code-agent history, which is mostly large tool
 * results, the two diverge without bound.
 *
 * Still an over-estimate, and deliberately so: this is a fit guard, not billing tokenization. The
 * prompt scaffolding (the `<conversation>` wrapper, the summarization prompt, the system prompt) is
 * a few hundred tokens and sits inside `reserveTokens`, which the caller adds on top.
 */
function estimatedInputTokens(preparation: Pick<Preparation, "messagesToSummarize" | "turnPrefixMessages" | "previousSummary">): number {
  const serialized = (messages: SummarizedMessages): number => messages.length === 0 ? 0 : serializeConversation(convertToLlm(messages)).length;
  // previousSummary rides along in the same prompt as a <previous-summary> block, so it counts.
  const chars = serialized(preparation.messagesToSummarize) + serialized(preparation.turnPrefixMessages) + (preparation.previousSummary?.length ?? 0);
  return Math.ceil(chars / 4);
}

/**
 * Raise the not-routed banner in the widget container, which survives the post-compaction chat
 * rebuild. Wrapped and optional-chained for the same reason the notify was: a host may expose no ui,
 * and a failed notice must never be why a compaction breaks.
 */
function showNotRoutedWidget(ctx: Pick<ExtensionContext, "ui">, lines: string[]): void {
  try {
    ctx.ui?.setWidget?.(NOT_ROUTED_WIDGET_KEY, lines);
  } catch {
    // deliberately swallowed; the summary matters more than its notice
  }
}

/** Retract the banner, so a warning about an earlier compaction cannot linger past the one it describes. */
function clearNotRoutedWidget(ctx: Pick<ExtensionContext, "ui">): void {
  try {
    ctx.ui?.setWidget?.(NOT_ROUTED_WIDGET_KEY, undefined);
  } catch {
    // deliberately swallowed; see above
  }
}

export default function compactionRouter(pi: ExtensionAPI): void {
  const explicitResumeSessions = new Set<string>();
  const sessionOverrides = new Map<string, RouterConfig | null>();
  const configFor = (ctx: Parameters<typeof loadConfig>[0]): RouterConfig | null => {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionOverrides.has(sessionId) ? sessionOverrides.get(sessionId)! : loadConfig(ctx);
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Drop a stash from an earlier compaction that never reached session_compact so it cannot
    // resurface against this one, and retract a banner still standing from a previous fallback: it
    // describes a compaction this one supersedes.
    clearPendingWarning(sessionId);
    clearNotRoutedWidget(ctx);

    const config = configFor(ctx);
    if (!config) return;
    const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
    const targets = selectTargets(config, active, event.reason);
    if (!targets.length) return;

    restorePreviousFileOperations(event.preparation, event.branchEntries);
    const estimated = estimatedInputTokens(event.preparation);

    for (const target of targets) {
      const ref = parseModelReference(target.model);
      if (!ref) { warn(`Skipping invalid model '${target.model}'.`); continue; }
      const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
      if (!model) { warn(`Skipping unavailable model '${target.model}'.`); continue; }
      const reserve = event.preparation.settings.reserveTokens;
      if (estimated + reserve > model.contextWindow) {
        warn(`Skipping '${target.model}': conservative ${estimated}-token input estimate plus ${reserve} reserved tokens exceeds its ${model.contextWindow}-token context window.`);
        continue;
      }
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) { warn(`Skipping unauthenticated model '${target.model}': ${auth.error}.`); continue; }
        const result = await compact(event.preparation, model, auth.apiKey, auth.headers, event.customInstructions, event.signal, target.thinkingLevel, undefined, auth.env);
        return { compaction: result };
      } catch (error) {
        if (event.signal.aborted) return;
        warn(`Compaction with '${target.model}' failed; trying the next route target.`, error);
      }
    }
    warn("No routed model succeeded; falling back to Pi's active model and native handler.");
    // The fallback is deliberately FAIL-OPEN: refusing to compact would end the session, which is a worse
    // outcome than compacting with the active model. But fail-open must not mean unobserved. console.warn
    // goes to a stream the interactive TUI does not surface, so without an operator-visible report an
    // operator could watch every routed target be skipped and see nothing at all -- the compaction would
    // just happen on the wrong model and look entirely normal.
    //
    // ui.notify was that report, and it did not survive: notify is a child of chatContainer, which pi
    // clears and rebuilds on compaction_end, strictly after this hook returns. So the warning was
    // reliably destroyed before an operator could read it, every time, on the success path. It is
    // stashed here instead and emitted from session_compact as a widget, which lives in a container
    // the rebuild does not touch. See src/pending-warning.ts for the verified mechanism.
    //
    // Nothing is aborted if this stash never gets drained: an unemitted warning is a lost notice, not
    // a broken compaction.
    if (!event.signal.aborted) {
      setPendingWarning(sessionId, {
        lines: [
          `[${TAG}] compaction was NOT routed: all ${targets.length} configured target(s) were skipped`,
          `or failed, so Pi's active model handled it instead. An unavailable, unauthenticated or`,
          `too-small target is a configuration problem rather than a transient one.`,
        ],
        routedByExtension: false,
      });
    }
    return;
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // The compaction is committed by the time this fires, so the stashed warning can be checked
    // against the entry pi actually saved. `fromExtension` is pi's own record of whether a
    // session_before_compact handler returned the compaction; if it did, this compaction WAS routed
    // and the warning is stale -- drop it rather than accuse a compaction that went fine.
    const pending = takePendingWarning(sessionId);
    if (pending && pending.routedByExtension === event.fromExtension) showNotRoutedWidget(ctx, pending.lines);

    if (event.willRetry) return; // Pi already resumes overflow recovery.
    if (explicitResumeSessions.delete(sessionId)) return;
    const config = configFor(ctx);
    if (!config || !config.resume.reasons.includes(event.reason as CompactionReason)) return;
    pi.sendMessage({ customType: "compaction-router-resume", content: config.resume.message, display: true }, { deliverAs: "followUp", triggerTurn: true });
  });

  pi.registerCommand("compact-resume", {
    description: "Compact with the configured router, then resume the in-progress task",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      explicitResumeSessions.add(sessionId);
      const config = configFor(ctx);
      const message = config?.resume.message ?? "Compaction completed. Resume the in-progress task from the retained summary and current repository state. Continue with the next concrete steps; if complete, verify and report completion.";
      ctx.compact({
        customInstructions: args.trim() || undefined,
        onComplete: () => pi.sendMessage({ customType: "compaction-router-resume", content: message, display: true }, { deliverAs: "followUp", triggerTurn: true }),
        onError: error => { explicitResumeSessions.delete(sessionId); ctx.ui.notify(`Compaction failed: ${error.message}`, "error"); },
      });
    },
  });

  pi.registerCommand("compaction-router", {
    description: "Show compaction-router routes and resume policy",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const config = configFor(ctx);
      if (!config) { ctx.ui.notify(`pi-compaction-router is disabled${sessionOverrides.has(sessionId) ? " by this session's override" : " or has no valid routes"}.`, "warning"); return; }
      const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
      const lines = (["manual", "threshold", "overflow"] as CompactionReason[]).map(reason => `${reason}: ${selectTargets(config, active, reason).map(x => `${x.model}${x.thinkingLevel ? `:${x.thinkingLevel}` : ""}`).join(" -> ") || "Pi active model"}`);
      const source = sessionOverrides.has(sessionId) ? "session override" : "settings";
      ctx.ui.notify(`Active: ${active}\nSource: ${source}\n${lines.join("\n")}\nAuto-resume: ${config.resume.reasons.join(", ") || "off"}`, "info");
    },
  });

  pi.registerCommand("compaction-router-config", {
    description: "Edit a session-local compaction-router override",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const input = args.trim();
      if (input === "reset") {
        sessionOverrides.delete(sessionId);
        ctx.ui.notify("Compaction router reset to global/project settings for this session.", "info");
        return;
      }
      let source = input;
      if (input === "off") source = "false";
      if (!source) {
        const current = configFor(ctx);
        source = await ctx.ui.editor(
          "Compaction router — session override JSON",
          JSON.stringify(configToSettingsValue(current), null, 2),
        ) ?? "";
        if (!source) { ctx.ui.notify("Compaction router configuration unchanged.", "info"); return; }
      }
      const result = parseSessionOverride(source);
      if (!result.ok) { ctx.ui.notify(result.error, "error"); return; }
      sessionOverrides.set(sessionId, result.config);
      ctx.ui.notify(result.config ? "Session compaction-router override applied immediately." : "Compaction router disabled for this session.", "info");
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    explicitResumeSessions.delete(sessionId);
    sessionOverrides.delete(sessionId);
    // A warning about the old session must not be stashed against, or shown over, the next one.
    clearPendingWarning(sessionId);
    clearNotRoutedWidget(ctx);
  });
}

export * from "./config.js";
export * from "./pending-warning.js";
