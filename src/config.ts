import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RetryPolicy } from "@earendil-works/pi-ai";

export const REASONS = ["manual", "threshold", "overflow"] as const;
export type CompactionReason = (typeof REASONS)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelTarget {
  model: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * How long this target stays cooled down after a failure that earned one, overriding the
   * router-wide `cooldownHours`. `0` means "skip it for the rest of this process, write nothing to
   * disk" -- pi-blackhole's semantic, kept because a read-only or ephemeral home must never be forced
   * into a disk write. See `src/cooldown.ts`.
   */
  cooldownHours?: number;
  /**
   * Correct a wrong registry context window for this target, instead of letting the fit guard skip it
   * on bad metadata.
   *
   * Upstream: pi-blackhole `om/model-budget.ts:15-41` (`effectiveContextWindow`) and its
   * `OmModelConfig.contextWindow` field (`core/unified-config.ts:62-63`, "Context window override for
   * this model. Inherits from Pi's model registry when unset"), read at commit
   * 2bf8cda11585c21fef2e5c2d9210690d82a2f2ca. MIT. Upstream's resolution order -- config override, then
   * the registry value, then a default -- is taken; upstream's 128 000 fallback is NOT, because our
   * `Model` always carries a `contextWindow` and inventing one for a target that reports none would be
   * a guess where the whole point is a measurement. See `effectiveContextWindow` in
   * `src/selection.ts`.
   *
   * WHY it earns a config surface here (dive-pi-blackhole.md steal 7): the fit guard SKIPS a target
   * whose window cannot hold the prompt. When a registry entry understates a window -- a proxy provider,
   * a stale catalogue, a self-hosted endpoint -- the operator's correct configuration is silently
   * unroutable and the only remedy is to stop using the target. This is the escape hatch.
   */
  contextWindow?: number;
}
export interface Route { match: string; models: ModelTarget[]; reasons: CompactionReason[] }
export interface ResumeConfig { reasons: CompactionReason[]; message: string }
export interface RouterConfig {
  routes: Route[];
  defaults: ModelTarget[];
  resume: ResumeConfig;
  /** Router-wide cooldown duration; a target's own `cooldownHours` wins. Undefined = 1 hour. */
  cooldownHours?: number;
  /** Retries per target before the chain advances. Undefined = `DEFAULT_MAX_RETRIES` (3). */
  maxRetries?: number;
}
export type SessionOverrideResult = { ok: true; config: RouterConfig | null } | { ok: false; error: string };

type Rec = Record<string, unknown>;
const DEFAULT_RESUME = "Compaction completed. Resume the in-progress task from the retained summary and current repository state. Continue executing the next concrete steps instead of merely summarizing or waiting. If the original task is already complete, verify it and report completion rather than inventing more work.";
const record = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const section = (v: unknown): unknown => record(v) ? v.compactionRouter : undefined;
const validReason = (v: unknown): v is CompactionReason => typeof v === "string" && (REASONS as readonly string[]).includes(v);

function reasons(v: unknown, fallback: CompactionReason[], warn: (s: string) => void): CompactionReason[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || !v.every(validReason)) { warn("Invalid reasons list; using defaults."); return fallback; }
  return [...new Set(v)];
}
/**
 * A non-negative hour count, or `undefined` when the value is absent or unusable.
 *
 * `0` is a MEANINGFUL value here (memory-only cooldown), so it must survive every guard that a
 * falsy-check would eat. That is the whole reason this is a named helper rather than `Number(v) || undefined`.
 */
function hours(v: unknown, label: string, warn: (s: string) => void): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { warn(`Ignoring invalid ${label} '${String(v)}'; it must be a non-negative number.`); return undefined; }
  return v;
}

/**
 * A STRICTLY positive token count, or `undefined` when absent or unusable.
 *
 * Separate from `hours` above and not a parameterisation of it, because the two disagree about zero on
 * purpose: `cooldownHours: 0` is a meaningful setting, whereas `contextWindow: 0` is pi's own encoding
 * for "no window known" and is exactly the bad metadata this override exists to correct. Upstream
 * agrees -- blackhole's `effectiveContextWindow` gates on `> 0` and its parser uses `positiveInt`
 * (`core/unified-config.ts:275`).
 */
function positiveTokens(v: unknown, label: string, warn: (s: string) => void): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) { warn(`Ignoring invalid ${label} '${String(v)}'; it must be a positive number of tokens.`); return undefined; }
  return Math.floor(v);
}

function target(v: unknown, warn: (s: string) => void): ModelTarget | null {
  if (!record(v) || typeof v.model !== "string" || !v.model.trim()) { warn("Ignoring model target without provider/model."); return null; }
  let thinkingLevel: ThinkingLevel | undefined;
  if (v.thinkingLevel !== undefined) {
    if (typeof v.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinkingLevel)) thinkingLevel = v.thinkingLevel as ThinkingLevel;
    else warn(`Ignoring invalid thinking level '${String(v.thinkingLevel)}'.`);
  }
  return {
    model: v.model.trim(),
    thinkingLevel,
    cooldownHours: hours(v.cooldownHours, "cooldownHours", warn),
    contextWindow: positiveTokens(v.contextWindow, "contextWindow", warn),
  };
}
function targets(v: unknown, warn: (s: string) => void): ModelTarget[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => target(x, warn)).filter((x): x is ModelTarget => x !== null);
}

export function resolveConfig(globalSettings: unknown, projectSettings: unknown, warn = (s: string) => console.warn(`[pi-compaction-router] ${s}`)): RouterConfig | null {
  const g = section(globalSettings), p = section(projectSettings);
  if (p === false || (g === false && p === undefined)) return null;
  const raw: Rec = { ...(record(g) ? g : {}), ...(record(p) ? p : {}) };
  if (raw.enabled === false) return null;
  const routes: Route[] = [];
  if (Array.isArray(raw.routes)) for (const item of raw.routes) {
    if (!record(item) || typeof item.match !== "string" || !item.match.trim()) { warn("Ignoring route without a match pattern."); continue; }
    const models = targets(item.models, warn); if (!models.length) { warn(`Ignoring route '${item.match}' without valid models.`); continue; }
    routes.push({ match: item.match.trim(), models, reasons: reasons(item.reasons, [...REASONS], warn) });
  }
  const defaults = targets(raw.models, warn);
  const rr = record(raw.resume) ? raw.resume : {};
  const resume: ResumeConfig = {
    reasons: rr.enabled === true ? reasons(rr.reasons, ["manual", "threshold"], warn) : [],
    message: typeof rr.message === "string" && rr.message.trim() ? rr.message.trim() : DEFAULT_RESUME,
  };
  if (!routes.length && !defaults.length && !resume.reasons.length) return null;
  return { routes, defaults, resume, cooldownHours: hours(raw.cooldownHours, "cooldownHours", warn), maxRetries: hours(raw.maxRetries, "maxRetries", warn) };
}

/** The cooldown duration that applies to one target: its own value wins, then the router-wide one. */
export function cooldownHoursFor(config: Pick<RouterConfig, "cooldownHours">, target: Pick<ModelTarget, "cooldownHours">): number | undefined {
  return target.cooldownHours ?? config.cooldownHours;
}

export function loadConfig(ctx: ExtensionContext): RouterConfig | null {
  const s = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  return resolveConfig(s.getGlobalSettings(), ctx.isProjectTrusted() ? s.getProjectSettings() : undefined);
}

/**
 * The host's own `settings.retry` policy, for the `retry` argument of `compact()`.
 *
 * This is not our config surface: it is pi's, read through the same `SettingsManager` `loadConfig`
 * builds and returned in the exact `{enabled, maxRetries, baseDelayMs}` shape `compact()` expects.
 * `getRetrySettings()` applies pi's defaults, so a host that never set `retry` gets what pi's own
 * compaction gets. Read-only: nothing here writes settings.
 */
export function loadRetryPolicy(ctx: ExtensionContext): RetryPolicy {
  return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getRetrySettings();
}

export function configToSettingsValue(config: RouterConfig | null): false | Rec {
  if (!config) return false;
  return {
    enabled: true,
    routes: config.routes,
    models: config.defaults,
    resume: {
      enabled: config.resume.reasons.length > 0,
      reasons: config.resume.reasons,
      message: config.resume.message,
    },
    // Spread-conditional rather than `cooldownHours: config.cooldownHours`: an explicit `undefined`
    // survives `JSON.stringify` as an absent key on the way out but not on the way back in through
    // `resolveConfig`, and the round-trip test compares the parsed config to the original.
    ...(config.cooldownHours === undefined ? {} : { cooldownHours: config.cooldownHours }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
  };
}

export function parseSessionOverride(text: string): SessionOverrideResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  if (value === false || (record(value) && value.enabled === false)) return { ok: true, config: null };
  if (!record(value)) return { ok: false, error: "Expected a router configuration object or false." };
  const warnings: string[] = [];
  const config = resolveConfig({ compactionRouter: value }, undefined, message => warnings.push(message));
  if (warnings.length) return { ok: false, error: warnings.join(" ") };
  if (!config) return { ok: false, error: "Configuration has no valid routes, fallback models, or resume policy." };
  return { ok: true, config };
}

export function parseModelReference(ref: string): { provider: string; modelId: string } | null {
  const i = ref.indexOf("/"); if (i <= 0 || i === ref.length - 1) return null;
  const provider = ref.slice(0, i).trim(), modelId = ref.slice(i + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
// `selectTargets` lives in `src/selection.ts` as of W2: it now returns `{fire, reasons, suppressor}`
// and consults the cooldown store, which is more than a config module should know about.
