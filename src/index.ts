import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configToSettingsValue, loadConfig, parseModelReference, parseSessionOverride, selectTargets, type CompactionReason, type RouterConfig } from "./config.js";

const TAG = "pi-compaction-router";
const warn = (message: string, error?: unknown) => error === undefined ? console.warn(`[${TAG}] ${message}`) : console.warn(`[${TAG}] ${message}`, error);

function restorePreviousFileOperations(preparation: { fileOps: { read: Set<string>; edited: Set<string> } }, branchEntries: Array<{ type: string; details?: unknown }>): void {
  const previous = [...branchEntries].reverse().find(entry => entry.type === "compaction");
  if (!previous || typeof previous.details !== "object" || previous.details === null) return;
  const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
  if (Array.isArray(details.readFiles)) for (const path of details.readFiles) if (typeof path === "string") preparation.fileOps.read.add(path);
  if (Array.isArray(details.modifiedFiles)) for (const path of details.modifiedFiles) if (typeof path === "string") preparation.fileOps.edited.add(path);
}

function estimatedInputTokens(preparation: { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; previousSummary?: string }): number {
  // Deliberately conservative for code-heavy histories. This is a guard, not billing tokenization.
  return Math.ceil(JSON.stringify([preparation.previousSummary ?? "", preparation.messagesToSummarize, preparation.turnPrefixMessages]).length / 2);
}

export default function compactionRouter(pi: ExtensionAPI): void {
  const explicitResumeSessions = new Set<string>();
  const sessionOverrides = new Map<string, RouterConfig | null>();
  const configFor = (ctx: Parameters<typeof loadConfig>[0]): RouterConfig | null => {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionOverrides.has(sessionId) ? sessionOverrides.get(sessionId)! : loadConfig(ctx);
  };

  pi.on("session_before_compact", async (event, ctx) => {
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
    return;
  });

  pi.on("session_compact", (event, ctx) => {
    if (event.willRetry) return; // Pi already resumes overflow recovery.
    const sessionId = ctx.sessionManager.getSessionId();
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
  });
}

export * from "./config.js";
