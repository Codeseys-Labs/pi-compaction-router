import { compact, convertToLlm, getAgentDir, getSettingsListTheme, getSelectListTheme, serializeConversation, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { advancesChain, chainExhausted, chainHalt, type ChainStop } from "./chain.js";
import { detectForeignSummary } from "./collision.js";
import { configToSettingsValue, cooldownHoursFor, loadConfig, loadRetryPolicy, parseModelReference, parseSessionOverride, REASONS, type CompactionReason, type ModelTarget, type RouterConfig } from "./config.js";
import { CooldownStore } from "./cooldown.js";
import { ACTIVE_MODEL_TARGET, appendRow, clearRouteRecord, estimateSummaryTokens, formatSavingsRows, readSavings, setRouteRecord, takeRouteRecord, type LedgerRow, type RouteRecord, type ServingTarget } from "./ledger.js";
import { validateReference, type PickableRegistry } from "./model-picker.js";
import { clearPendingWarning, setPendingWarning, takePendingWarning } from "./pending-warning.js";
import { formatHealthRows, ProviderHealth } from "./provider-health.js";
import { classifyFailure, withTargetRetry, type Classification } from "./retry.js";
import { checkMaxTokens, findRouteShadowing, rankByFit, selectTargets, type Suppressor } from "./selection.js";
import { ADVANCED_ROW, RESUME_ROW, RESUME_VALUES, RouterDraft } from "./settings-draft.js";
import { readSnapshot, SETTINGS_KEY, SettingsWriteError, writeSection, type SettingsScope } from "./settings-store.js";
import { buildSettingsDialog, ProviderModelPicker } from "./settings-ui.js";

/** Pi's `CompactionPreparation`, reached through the event that carries it rather than re-declared. */
type Preparation = SessionBeforeCompactEvent["preparation"];
type SummarizedMessages = Preparation["messagesToSummarize"];

const TAG = "pi-compaction-router";
const warn = (message: string, error?: unknown) => error === undefined ? console.warn(`[${TAG}] ${message}`) : console.warn(`[${TAG}] ${message}`, error);

/** Key for the durable not-routed banner. One key, so re-setting it replaces rather than stacks. */
const NOT_ROUTED_WIDGET_KEY = `${TAG}:not-routed`;

/**
 * Key for the hook-collision banner. Deliberately NOT the not-routed key: the two facts are
 * independent and can hold at once ("nothing of ours ran" AND "someone else's summary was
 * committed"), so sharing a key would let one silently overwrite the other.
 */
const COLLISION_WIDGET_KEY = `${TAG}:collision`;

/** The rows whose drill-down produces a model reference, and so whose picks need validating. */
const REASON_ROWS = REASONS;

/**
 * Whether the project scope already owns a `compactionRouter` key.
 *
 * This decides which scope the dialog edits, and it is deliberately conservative: the UI writes
 * project settings ONLY when the operator has already put router configuration there AND pi reports
 * the project trusted. Otherwise it writes global. The alternative -- offering a scope picker --
 * invites an operator to create project-scoped configuration by accident, in a file that travels with
 * the repository to everyone who clones it.
 */
function projectSectionPresent(ctx: Pick<ExtensionContext, "cwd">): boolean {
  return readSnapshot("project", ctx.cwd).value[SETTINGS_KEY] !== undefined;
}

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
 * Write one widget key, in the container that survives the post-compaction chat rebuild. Wrapped and
 * optional-chained for the same reason the notify was: a host may expose no ui, and a failed notice
 * must never be why a compaction breaks. `undefined` retracts.
 */
function setWidget(ctx: Pick<ExtensionContext, "ui">, key: string, lines: string[] | undefined): void {
  try {
    ctx.ui?.setWidget?.(key, lines);
  } catch {
    // deliberately swallowed; the summary matters more than its notice
  }
}

const showNotRoutedWidget = (ctx: Pick<ExtensionContext, "ui">, lines: string[]): void => setWidget(ctx, NOT_ROUTED_WIDGET_KEY, lines);

/**
 * Break one long sentence into widget lines.
 *
 * Pi renders at most 10 widget lines (`InteractiveMode.MAX_WIDGET_LINES`, `interactive-mode.js:1531`)
 * and silently DROPS the rest, so a single 400-character string handed to `setWidget` is one line that
 * the terminal wraps outside pi's accounting. The collision message is written as prose for a log and
 * has to be re-flowed before it can be read in a widget. Word-wrapped at a conservative width and
 * capped below pi's limit so the cap is never what an operator notices.
 */
function wrapForWidget(message: string, width = 96, maxLines = 8): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of message.split(/\s+/)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
    if (lines.length === maxLines) return lines;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

/** Retract the banner, so a warning about an earlier compaction cannot linger past the one it describes. */
const clearNotRoutedWidget = (ctx: Pick<ExtensionContext, "ui">): void => setWidget(ctx, NOT_ROUTED_WIDGET_KEY, undefined);

/**
 * Assemble and append one ledger row for a compaction pi has just committed.
 *
 * `record` is the before-hook's half of the row (outcome, serving target, window). `undefined` means
 * our before-hook never resolved for this compaction -- a native path, another extension's handler,
 * or a config change between the two events. That case is recorded as `unobserved` rather than
 * skipped, which is the "never silent" rule from Accordion `dc037bc` (see src/ledger.ts): an absent
 * row and a fell-back row are different facts, and a ledger that cannot distinguish them is not a
 * meter.
 *
 * `tokensBefore` comes from the committed entry rather than the stash, because the entry is what pi
 * actually saved; the stash's copy is only the fallback for the `unobserved` case.
 */
function writeLedgerRow(
  event: Pick<SessionCompactEvent, "reason" | "willRetry" | "fromExtension" | "compactionEntry">,
  ctx: Pick<ExtensionContext, "cwd">,
  record: RouteRecord | undefined,
  sessionId: string,
): void {
  const entry = event.compactionEntry;
  const summary = typeof entry?.summary === "string" ? entry.summary : "";
  const { tokens, skipped } = estimateSummaryTokens(summary);
  const servedBy: ServingTarget = record?.servedBy ?? ACTIVE_MODEL_TARGET;
  const row: LedgerRow = {
    ts: new Date().toISOString(),
    sessionId,
    project: ctx.cwd,
    reason: event.reason,
    willRetry: event.willRetry,
    fromExtension: event.fromExtension,
    outcome: record?.outcome ?? "unobserved",
    servedBy,
    tokensBefore: typeof entry?.tokensBefore === "number" ? entry.tokensBefore : record?.tokensBefore ?? 0,
    tokensAfter: tokens,
    tokensSkipped: skipped,
    window: record?.window ?? null,
    usage: entry?.usage ?? null,
  };
  appendRow(getAgentDir(), row, warn);
}

/**
 * The durable banner for a compaction no target was even attempted for.
 *
 * `no-targets-configured` is deliberately not given a banner by the caller: a package with no
 * configuration owes no warning, which is the existing contract the fail-open tests pin. The other two
 * suppressors are outcomes the operator configured FOR and did not get.
 *
 * Pi renders at most 10 widget lines (`InteractiveMode.MAX_WIDGET_LINES`, `interactive-mode.js:1531`)
 * and silently drops the rest, so the detail lines are capped where a reader can still see the cap.
 */
function suppressorLines(suppressor: Suppressor, reason: string, reasons: string[]): string[] {
  const head = suppressor === "all-targets-cooled-down"
    ? [
        `[${TAG}] compaction was NOT routed: every configured target is in a cooldown window from`,
        `an earlier failure, so Pi's active model handled this ${reason} compaction instead.`,
        `Cooldowns expire on their own; delete the router's cooldown.json to clear them now.`,
      ]
    : [
        `[${TAG}] compaction was NOT routed: no route covers a '${reason}' compaction and no`,
        `fallback models are configured, so Pi's active model handled it. Add '${reason}' to a`,
        `route's reasons, or set fallback models, if this was meant to be routed.`,
      ];
  return [...head, ...reasons.slice(0, 10 - head.length - 1).map(line => `- ${line}`)];
}

/**
 * Hold a failure against the target, if it is the target's to answer for.
 *
 * The classifier decides (`cooldownWorthy`), not this function: `stale-context` and `aborted` must
 * never cool a target down, and that judgement belongs next to the classification rather than
 * duplicated at each call site. The stage string is the compaction reason plus the failure class,
 * because an operator reading the file needs to know whether a target was cooled by a rate limit
 * during an overflow or by an exhausted budget.
 */
function recordCooldown(store: CooldownStore, config: RouterConfig, target: ModelTarget, classification: Classification, reason: string): void {
  if (!classification.cooldownWorthy) return;
  store.record(target.model, {
    reason: classification.message,
    stage: `${reason}/${classification.kind}`,
    cooldownHours: cooldownHoursFor(config, target),
  });
}

export default function compactionRouter(pi: ExtensionAPI): void {
  const explicitResumeSessions = new Set<string>();
  const sessionOverrides = new Map<string, RouterConfig | null>();
  /**
   * Passive only. Fed exclusively from results the route loop below already obtained; never consulted
   * by asking a provider anything. See src/provider-health.ts for the upstream rule this holds to.
   */
  const health = new ProviderHealth();
  /**
   * One store for the process, because its `cooldownHours: 0` half is in-memory by definition and a
   * per-call store would forget it instantly -- silently un-doing the one semantic that setting exists
   * for. The persisted half reads the file per call regardless, so nothing else is cached here.
   */
  const cooldowns = new CooldownStore();
  /** Config objects already checked for route shadowing, so the warning is emitted once, not per compaction. */
  const shadowingReported = new WeakSet<RouterConfig>();


  const configFor = (ctx: Parameters<typeof loadConfig>[0]): RouterConfig | null => {
    const sessionId = ctx.sessionManager.getSessionId();
    const config = sessionOverrides.has(sessionId) ? sessionOverrides.get(sessionId)! : loadConfig(ctx);
    if (config && !shadowingReported.has(config)) {
      shadowingReported.add(config);
      // Dead configuration is worth exactly one warning. A route that can never be reached is a rule
      // the operator wrote and the file kept; saying so every compaction would train them to ignore it.
      for (const shadow of findRouteShadowing(config)) warn(shadow.message);
    }
    return config;
  };

  pi.on("session_before_compact", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Drop a stash from an earlier compaction that never reached session_compact so it cannot
    // resurface against this one, and retract a banner still standing from a previous fallback: it
    // describes a compaction this one supersedes.
    clearPendingWarning(sessionId);
    clearNotRoutedWidget(ctx);
    // The collision banner is retracted for the same reason and on the same schedule: it names a
    // specific compaction whose summary came from elsewhere, and the next compaction may not repeat it.
    setWidget(ctx, COLLISION_WIDGET_KEY, undefined);
    // Same reason as the warning stash above: a route decision from a compaction that never reached
    // session_compact must not be attributed to this one.
    clearRouteRecord(sessionId);

    const tokensBefore = event.preparation.tokensBefore;
    const config = configFor(ctx);
    if (!config) return;
    const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
    const selection = selectTargets(config, active, event.reason, {
      cooldownFor: target => cooldowns.get(target.model, { cooldownHours: cooldownHoursFor(config, target) }),
    });
    const targets = selection.fire;
    if (!targets.length) {
      // "Never silent", in both registers. The ledger gets a `no-targets` row rather than an absent one
      // a reader must guess at; the operator gets a suppressor naming which of the four ways this
      // happened it was. An empty target list used to be a bare `return` that produced neither.
      //
      // The two suppressors that mean "this package HAD an opinion and was thwarted" also get the
      // durable banner: a cooled-down chain and a reason the operator's routes do not cover are both
      // things they can act on, and neither is inferable from anything else they can see.
      setRouteRecord(sessionId, { outcome: "no-targets", servedBy: ACTIVE_MODEL_TARGET, window: ctx.model?.contextWindow ?? null, tokensBefore });
      for (const reason of selection.reasons) warn(reason);
      warn(`No route target will be tried for this ${event.reason} compaction (${selection.suppressor}).`);
      if (!event.signal.aborted && selection.suppressor !== "no-targets-configured") {
        setPendingWarning(sessionId, { lines: suppressorLines(selection.suppressor!, event.reason, selection.reasons), routedByExtension: false });
      }
      return;
    }

    restorePreviousFileOperations(event.preparation, event.branchEntries);
    const estimated = estimatedInputTokens(event.preparation);
    // Read once per compaction, not once per target: this is a settings file read, and a route chain
    // must not re-read it per hop. Hoisted out of the loop below for a second reason -- inside the
    // try/catch it would report a settings failure as "compaction with this target failed", sending
    // the operator after the wrong thing. `configFor` above already read the same file, so this adds
    // no failure mode that was not already present.
    const retry = loadRetryPolicy(ctx);
    const reserve = event.preparation.settings.reserveTokens;

    // CHEAPEST THAT FITS (G6). The operator's list says which targets are ALLOWED; this decides which
    // allowed target is tried first, and it is a decision the router could not previously make -- the
    // window was read only to reject and `cost` was never read at all. Ordering happens once, before
    // the loop, because the ranking is a property of the prompt rather than of a hop.
    //
    // Ordering here is safe only because W1 fixed the estimator: `estimated` is now
    // `serializeConversation(convertToLlm(...))/4` rather than a number that ran 3.7x-37.9x high, and
    // cheapest-first over a bad estimate would have systematically preferred the small-window models
    // that estimate wrongly excluded (verdict §5.5, risk 5).
    //
    // Non-fitting targets stay IN the chain, at the back. They are still tried, still reported, still
    // recorded against provider health -- the ranking changes the order, never the operator's set.
    //
    // RESOLUTION HAPPENS ONCE, HERE, AND IS REPORTED HERE. Two reasons, and the second is the subtler:
    //
    //  1. Resolving per hop instead would double this package's registry lookups, and
    //     `test/provider-health.test.ts` bounds them at one per configured target.
    //  2. A target that cannot be resolved is a fact learned at THIS point, and ranking would otherwise
    //     bury it: an unresolvable target does not fit, so it sorts to the back, so a chain that
    //     succeeds earlier would never reach it and would never record what we already know. Reporting
    //     at the point of discovery is what keeps "this target is unavailable" in the health record
    //     regardless of where the ranking puts it.
    //
    // `find` is a synchronous in-memory catalogue read -- `ModelRegistry.find` -> `runtime.getModel` ->
    // `Models.getModel` = `getModels(provider).find(...)` (`pi-ai/dist/models.js:69-71`), no network and
    // no credential -- so resolving every candidate reaches no provider and costs the operator nothing.
    // That is why the passivity rule is untouched by doing it up front: the paid doors are
    // `getApiKeyAndHeaders` and `compact`, and both stay strictly inside the loop below.
    const resolvable: { target: ModelTarget; model: NonNullable<ReturnType<typeof ctx.modelRegistry.find>> }[] = [];
    for (const target of targets) {
      const ref = parseModelReference(target.model);
      if (!ref) { warn(`Skipping invalid model '${target.model}'.`); continue; }
      const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
      // Every `health.record*` call sits AFTER the thing it records, and describes only that thing.
      // Nothing here asks a provider a question in order to have something to record.
      if (!model) { health.recordFailure(target.model, "unavailable"); warn(`Skipping unavailable model '${target.model}'.`); continue; }
      resolvable.push({ target, model });
    }
    const ranking = rankByFit(resolvable, estimated, reserve);
    let stop: ChainStop = chainExhausted(targets.length);

    for (const { target, model, fits, window, reason } of ranking) {
      if (!fits) {
        // The fit refusal, now decided by `rankByFit` so that one rule serves both the ordering and the
        // skip. `window` is post-override: a target carrying `contextWindow` is judged on the
        // operator's number, which is the point of the override (blackhole steal 7).
        health.recordFailure(target.model, "too-small", reason);
        warn(`Skipping ${reason}.`);
        continue;
      }
      // The output side of the same arithmetic. Pi will ask for `0.8 x reserveTokens` output tokens
      // and silently `min()` it against the model's own cap, so a target with a small `maxTokens`
      // truncates its summary with nothing said anywhere. Warn always; skip only when the shortfall
      // is severe (see MAX_TOKENS_REFUSAL_FRACTION, which is labelled a guess).
      const budget = checkMaxTokens(model, reserve, target.model);
      if (budget.message) warn(budget.message);
      if (budget.refuse) continue;
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) { health.recordFailure(target.model, "unauthenticated", auth.error); warn(`Skipping unauthenticated model '${target.model}': ${auth.error}.`); continue; }
        // Retry THIS target before advancing: one `server_is_overloaded` used to cost the whole hop.
        // Arg 10 is `retry`. Pi passes its own `settingsManager.getRetrySettings()` on both native
        // compaction paths (`dist/core/agent-session.js:1423`, `1662`); omitting it here meant a
        // routed compaction was the one summarization call in the process with retry disabled, so a
        // single transient stream drop cost the whole route hop where pi would have retried. Both
        // layers are wanted: pi's retry is inside one `compact()` call, ours survives it throwing.
        const result = await withTargetRetry(
          () => compact(event.preparation, model, auth.apiKey, auth.headers, event.customInstructions, event.signal, target.thinkingLevel, undefined, auth.env, retry),
          {
            maxRetries: config.maxRetries,
            signal: event.signal,
            onRetry: notice => warn(`Retrying '${target.model}' after a ${notice.classification.kind} failure (attempt ${notice.attempt}): ${notice.classification.message}. Waiting ${notice.delayMs}ms.`),
          },
        );
        health.recordSuccess(target.model);
        // WHICH TARGET SERVED IT -- the field pi's own compaction entry does not carry. Stashed for
        // session_compact, which owns the other half of the row (reason, willRetry, committed usage).
        setRouteRecord(sessionId, {
          outcome: "routed",
          servedBy: { model: target.model, thinkingLevel: target.thinkingLevel, active: false },
          // The POST-OVERRIDE window, not `model.contextWindow`. When a target carries a
          // `contextWindow` override, that is the number the fit decision was actually made on, and a
          // ledger recording the registry's rejected value would misdescribe the decision it is the
          // record of.
          window,
          tokensBefore,
        });
        return { compaction: result };
      } catch (error) {
        const classification = classifyFailure(error);
        recordCooldown(cooldowns, config, target, classification, event.reason);
        if (classification.kind === "aborted" || event.signal.aborted) {
          // An abort is not a target failure: the target never got the chance to fail. Recording it as
          // one would make an aborted session look like a flapping provider to route selection -- which
          // is why `classifyFailure` gives it its own class and `recordCooldown` above declines it.
          setRouteRecord(sessionId, { outcome: "aborted", servedBy: ACTIVE_MODEL_TARGET, window: ctx.model?.contextWindow ?? null, tokensBefore });
          return;
        }
        // The health record carries the classification, not the raw throw: "quota" and "overloaded" are
        // the same `call-failed` to the ledger's taxonomy but very different things to read in a status.
        health.recordFailure(target.model, "call-failed", `${classification.kind}: ${classification.message}`);
        if (!advancesChain(classification)) {
          // Magic Context's rule: a failure that is not ABOUT THE TARGET travels with the request, so
          // the next target would fail identically. Stop rather than burn the list.
          stop = chainHalt(classification);
          warn(`Compaction with '${target.model}' failed (${classification.kind}); ${stop.message}.`, error);
          break;
        }
        warn(`Compaction with '${target.model}' failed (${classification.kind}); trying the next route target.`, error);
      }
    }
    warn(`No routed model succeeded (${stop.message}); falling back to Pi's active model and native handler.`);
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
    setRouteRecord(sessionId, {
      outcome: event.signal.aborted ? "aborted" : "fell-back",
      servedBy: ACTIVE_MODEL_TARGET,
      window: ctx.model?.contextWindow ?? null,
      tokensBefore,
    });
    if (!event.signal.aborted) {
      setPendingWarning(sessionId, {
        lines: [
          `[${TAG}] compaction was NOT routed: all ${targets.length} configured target(s) were skipped`,
          `or failed, so Pi's active model handled it instead. An unavailable, unauthenticated or`,
          `too-small target is a configuration problem rather than a transient one.`,
          // Why the chain ended where it did. Without this, "all N targets" reads as "all N were
          // tried", which a halted chain did not do -- and the halt is the more actionable outcome.
          `Cause: ${stop.message}.`,
        ],
        routedByExtension: false,
      });
    }
    return;
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // The ledger row is written here, not in the before-hook, because this is the first point at
    // which the compaction is a FACT rather than an intention -- and because `reason`, `willRetry`
    // and the committed `usage` exist only on this event. Written before the resume decision below,
    // which returns early on several paths: a meter that only records the compactions that also
    // triggered a nudge is not a meter.
    //
    // The record is drained ONCE and reused, because `takeRouteRecord` deletes: calling it twice
    // would give the collision check below `undefined` and hide every override we routed against.
    const record = takeRouteRecord(sessionId);
    writeLedgerRow(event, ctx, record, sessionId);

    // THE OVERRIDE HAZARD. Pi runs every registered `session_before_compact` handler and keeps the
    // LAST truthy result (`dist/core/extensions/runner.js:565-594`), so on a compaction where we
    // returned nothing another owner's summary is what pi commits -- and on the fell-back path we may
    // have paid a provider for a summary that was then discarded. Install-time arbitration does not
    // exist in 0.81.1, so this is detectable only after the fact, and only here. The outcome is passed
    // rather than a boolean so that "we were not running at all" is not reported as a collision; see
    // src/collision.ts for why that distinction is load-bearing.
    const collision = detectForeignSummary(event, record?.outcome);
    if (collision) {
      warn(collision.message);
      setWidget(ctx, COLLISION_WIDGET_KEY, [`[${TAG}] hook collision:`, ...wrapForWidget(collision.message)]);
    }

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
      const lines = (["manual", "threshold", "overflow"] as CompactionReason[]).map(reason => {
        const selection = selectTargets(config, active, reason, {
          cooldownFor: target => cooldowns.get(target.model, { cooldownHours: cooldownHoursFor(config, target) }),
        });
        // The suppressor is the point of showing this at all: "threshold: Pi active model" was
        // indistinguishable from "threshold: cooled down, waiting", and those are different problems.
        return selection.fire.length
          ? `${reason}: ${selection.fire.map(x => `${x.model}${x.thinkingLevel ? `:${x.thinkingLevel}` : ""}`).join(" -> ")}`
          : `${reason}: Pi active model (${selection.suppressor})`;
      });
      const cooled = Object.entries(cooldowns.snapshot()).map(([key, entry]) => `${key} until ${entry.until} (${entry.stage}: ${entry.reason})`);
      const shadowing = findRouteShadowing(config).map(s => s.message);
      const source = sessionOverrides.has(sessionId) ? "session override" : "settings";
      // This command showed CONFIGURATION only. Configuration is what routing was ASKED to do; the
      // savings block below is what it actually did -- the meter for "what did routing buy" (AFT
      // 566bcde stealList 4). Both blocks degrade to nothing rather than to a row of zeroes: before
      // any compaction has been measured there is no honest number to show. The cooldown and shadowing
      // blocks follow the same rule: absent when there is nothing to report.
      const meter = formatSavingsRows(readSavings(getAgentDir(), sessionId, ctx.cwd));
      const healthRows = formatHealthRows(health.snapshotAll());
      const blocks = [`Active: ${active}`, `Source: ${source}`, ...lines, `Auto-resume: ${config.resume.reasons.join(", ") || "off"}`];
      if (cooled.length) blocks.push("", "Cooldowns:", ...cooled.map(l => `  ${l}`));
      if (meter.length) blocks.push("", ...meter);
      if (healthRows.length) blocks.push("", ...healthRows);
      // Dead configuration is the one thing here that is a defect rather than a report, so it raises the
      // notification's level as well as appearing in it.
      if (shadowing.length) blocks.push("", ...shadowing.map(l => `WARNING: ${l}`));
      ctx.ui.notify(blocks.join("\n"), shadowing.length ? "warning" : "info");
    },
  });

  /**
   * The raw-JSON editor this command used to BE, demoted to an escape hatch.
   *
   * It is still the only way to author things the row surface cannot express -- a multi-target
   * fallback chain, a per-target `thinkingLevel` or `cooldownHours`, a glob route narrower than the
   * catch-all -- so it is kept whole, including `parseSessionOverride`'s all-or-nothing semantics
   * (verdict §4.4). What changed is that it is no longer the front door: it is reached from the
   * `advanced` row, or by typing an argument to the command.
   *
   * Session-scoped, as it always was, and now labelled as such where the operator can read it: the
   * row surface writes durable settings, this writes an override that dies with the session.
   */
  const editSessionOverrideJson = async (ctx: Parameters<typeof loadConfig>[0] & { ui: ExtensionContext["ui"] }, sessionId: string, prefill?: string): Promise<void> => {
    const source = prefill ?? await ctx.ui.editor(
      "Compaction router — session override JSON (this session only)",
      JSON.stringify(configToSettingsValue(configFor(ctx)), null, 2),
    ) ?? "";
    if (!source) { ctx.ui.notify("Compaction router configuration unchanged.", "info"); return; }
    const result = parseSessionOverride(source);
    if (!result.ok) { ctx.ui.notify(result.error, "error"); return; }
    sessionOverrides.set(sessionId, result.config);
    ctx.ui.notify(result.config ? "Session compaction-router override applied immediately." : "Compaction router disabled for this session.", "info");
  };

  pi.registerCommand("compaction-router-config", {
    description: "Configure compaction-router routing (interactive)",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const input = args.trim();
      if (input === "reset") {
        sessionOverrides.delete(sessionId);
        ctx.ui.notify("Compaction router reset to global/project settings for this session.", "info");
        return;
      }
      // An explicit argument is a power-user instruction and keeps its old, direct meaning: `off`
      // disables for the session, anything else is parsed as override JSON. Neither needs a TUI, so
      // both are handled before the mode gate below -- an RPC host keeps the surface it had.
      if (input) { await editSessionOverrideJson(ctx, sessionId, input === "off" ? "false" : input); return; }

      // `ctx.mode === "tui"`, not `ctx.hasUI`. `hasUI` is also true in RPC mode, where `custom()` has
      // no terminal to draw on and `getSettingsListTheme()` throws. This is the documented guard
      // (`docs/extensions.md:944-946`) and `questionnaire.ts:90-92` returns an error result the same way.
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/compaction-router-config needs the interactive TUI. Pass override JSON as an argument, or 'off', or 'reset'.", "error");
        return;
      }

      // Read the scope we will write, and remember the fingerprint of the bytes we based the draft on.
      // Project scope only when pi says the project is trusted -- an untrusted project directory is
      // somebody else's repository and its settings file is executable configuration.
      const scope: SettingsScope = ctx.isProjectTrusted() && projectSectionPresent(ctx) ? "project" : "global";
      const snapshot = readSnapshot(scope, ctx.cwd);
      const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown/unknown";
      const draft = RouterDraft.from(snapshot.value, SETTINGS_KEY, active);
      const registry = ctx.modelRegistry as unknown as PickableRegistry;

      let wantsJsonEditor = false;
      await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
        // Inside the callback, and only here: `getSettingsListTheme()` throws outside a live TUI.
        const settingsTheme = getSettingsListTheme();
        const selectTheme = getSelectListTheme();
        const requestRender = () => tui.requestRender();
        const items: SettingItem[] = draft.rows().map(row => ({
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: row.currentValue,
          ...(row.isReasonSlot
            // The drill-down. `SettingsList` delegates everything to what this returns until it calls
            // `done`, and on a defined value sets the row and fires `onChange` for us.
            ? { submenu: (_current: string, finish: (value?: string) => void) => new ProviderModelPicker(registry, selectTheme, finish, requestRender) }
            : { values: [...RESUME_VALUES] }),
        }));
        items.push({
          id: ADVANCED_ROW,
          label: "advanced",
          description: "Edit the raw JSON for this session: multi-target chains, thinking levels, per-target cooldowns, glob routes.",
          currentValue: "open editor",
          values: ["open editor"],
        });
        return buildSettingsDialog({
          items,
          settingsTheme,
          title: `Compaction router — ${scope} settings · active model ${active}`,
          onChange: (id, value) => {
            if (id === ADVANCED_ROW) {
              // The editor is a `ctx.ui.editor` await, which cannot run while `custom()` owns the
              // screen. Close first, then open it -- the flag is read after `custom()` resolves.
              wantsJsonEditor = true;
              done(undefined);
              return;
            }
            draft.apply(id, value);
          },
          onClose: () => done(undefined),
          requestRender,
        });
      });

      if (wantsJsonEditor) { await editSessionOverrideJson(ctx, sessionId); return; }
      if (!draft.changed()) { ctx.ui.notify("Compaction router configuration unchanged.", "info"); return; }

      // Validate every pick against the SAME registry the compaction hook will call, so a reference
      // that passes here is one `session_before_compact` can resolve later. A failure writes nothing:
      // a settings file is not the place to discover a typo.
      const invalid: string[] = [];
      for (const reason of REASON_ROWS) {
        const pick = draft.pickFor(reason);
        if (!pick) continue;
        const check = validateReference(registry, pick);
        if (!check.ok && check.error) invalid.push(check.error);
      }
      if (invalid.length) { ctx.ui.notify(`Nothing was written. ${invalid.join(" ")}`, "error"); return; }

      try {
        const written = writeSection({
          scope,
          cwd: ctx.cwd,
          baseHash: snapshot.baseHash,
          section: draft.toSettingsValue(),
          projectTrusted: ctx.isProjectTrusted(),
        });
        // The session mirror. `appendEntry` is replay-safe and travels with the session tree, so a
        // resumed or forked session can see what this dialog did without re-reading settings -- and,
        // unlike a settings write, it is a record of WHEN as well as what.
        pi.appendEntry("compaction-router-config", { scope, path: written.path, section: draft.toSettingsValue() });
        // A durable write must not silently disagree with routing. `verifyEffective` re-parses what we
        // just wrote through `resolveConfig` + `selectTargets` and reports any slot a hand-written
        // route still out-ranks -- the one way a surgical write can succeed and mean nothing.
        const problems = draft.verifyEffective(SETTINGS_KEY);
        const summary = `Compaction router ${scope} settings updated (${written.path}).`;
        if (problems.length) ctx.ui.notify(`${summary} But: ${problems.join(" ")}`, "warning");
        else ctx.ui.notify(`${summary} New compactions use it immediately.`, "info");
      } catch (error) {
        // A conflict or a held lock is an expected outcome, not a crash: report it in the operator's
        // language and leave the file alone. `configFor` re-reads settings per compaction, so there is
        // no stale in-memory state to unwind.
        const message = error instanceof SettingsWriteError ? error.message : `Could not write settings: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    explicitResumeSessions.delete(sessionId);
    sessionOverrides.delete(sessionId);
    // A warning about the old session must not be stashed against, or shown over, the next one.
    clearPendingWarning(sessionId);
    clearRouteRecord(sessionId);
    clearNotRoutedWidget(ctx);
    setWidget(ctx, COLLISION_WIDGET_KEY, undefined);
    // The memory-only cooldowns are this process's knowledge of what failed, and a new session is
    // entitled to try again. The persisted half is untouched: a rate limit outlives a session, which
    // is the entire reason it is on disk. Also sweeps expired entries, upstream's `expireCooldowns()`
    // on a session boundary -- lazy expiry already keeps correctness, this keeps the file readable.
    cooldowns.clearMemory();
    cooldowns.expire();
  });
}

export * from "./chain.js";
export * from "./collision.js";
export * from "./config.js";
export * from "./cooldown.js";
export * from "./ledger.js";
export * from "./pending-warning.js";
export * from "./provider-health.js";
export * from "./model-picker.js";
export * from "./retry.js";
export * from "./retryable-error.js";
export * from "./selection.js";
export * from "./settings-draft.js";
export * from "./settings-store.js";
export * from "./settings-ui.js";
