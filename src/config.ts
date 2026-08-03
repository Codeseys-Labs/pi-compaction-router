import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RetryPolicy } from "@earendil-works/pi-ai";
import { resolvePreservationConfig, type PreservationConfig } from "./preservation.js";

export const REASONS = ["manual", "threshold", "overflow"] as const;
export type CompactionReason = (typeof REASONS)[number];

/**
 * The observer worker's slot in the route table (W5).
 *
 * Deliberately NOT a member of `REASONS`: `CompactionReason` is what pi's `session_before_compact`
 * event reports, and widening it would put a non-existent compaction reason into the resume policy,
 * the settings rows and the ledger's `reason` field. A route opts into the worker slot by naming it
 * explicitly, so every route written before W5 keeps covering exactly the three compaction reasons it
 * already covered -- `reasons()` below defaults to `[...REASONS]`, never to all slots.
 */
export const WORKER_SLOT = "worker";
export type RouteSlot = CompactionReason | typeof WORKER_SLOT;
export const ROUTE_SLOTS = [...REASONS, WORKER_SLOT] as const;

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
}
export interface Route { match: string; models: ModelTarget[]; reasons: RouteSlot[] }
export interface ResumeConfig { reasons: CompactionReason[]; message: string }
export interface RouterConfig {
  routes: Route[];
  defaults: ModelTarget[];
  resume: ResumeConfig;
  /** Router-wide cooldown duration; a target's own `cooldownHours` wins. Undefined = 1 hour. */
  cooldownHours?: number;
  /** Retries per target before the chain advances. Undefined = `DEFAULT_MAX_RETRIES` (3). */
  maxRetries?: number;
  /**
   * The W5 preservation layer. Always present and `enabled: false` unless the operator set
   * `preservation.enabled: true` -- so reading this field can never be the thing that turns the
   * observer on.
   */
  preservation: PreservationConfig;
  /**
   * Dedicated worker targets, tried before the `worker`-slot routes. The cheap-model slot from
   * verdict §3's row list ("plus the memory-worker model once §2.1 exists").
   */
  workerModels: ModelTarget[];
}
export type SessionOverrideResult = { ok: true; config: RouterConfig | null } | { ok: false; error: string };

type Rec = Record<string, unknown>;
const DEFAULT_RESUME = "Compaction completed. Resume the in-progress task from the retained summary and current repository state. Continue executing the next concrete steps instead of merely summarizing or waiting. If the original task is already complete, verify it and report completion rather than inventing more work.";
const record = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const section = (v: unknown): unknown => record(v) ? v.compactionRouter : undefined;
const validReason = (v: unknown): v is CompactionReason => typeof v === "string" && (REASONS as readonly string[]).includes(v);
const validSlot = (v: unknown): v is RouteSlot => typeof v === "string" && (ROUTE_SLOTS as readonly string[]).includes(v);

function reasons(v: unknown, fallback: CompactionReason[], warn: (s: string) => void): CompactionReason[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || !v.every(validReason)) { warn("Invalid reasons list; using defaults."); return fallback; }
  return [...new Set(v)];
}

/**
 * A route's slot list, which may include `worker` as well as the three compaction reasons.
 *
 * Separate from `reasons()` above rather than a widening of it, because the two callers want different
 * vocabularies: a ROUTE may serve the worker slot, a RESUME policy may not (there is no compaction to
 * resume after an observer call). Keeping them apart is what makes `resume.reasons: ["worker"]` an
 * invalid-value warning instead of a silently accepted no-op.
 */
function routeSlots(v: unknown, warn: (s: string) => void): RouteSlot[] {
  if (v === undefined) return [...REASONS];
  if (!Array.isArray(v) || !v.every(validSlot)) { warn(`Invalid route reasons list; using the three compaction reasons. Valid values are ${ROUTE_SLOTS.join(", ")}.`); return [...REASONS]; }
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

function target(v: unknown, warn: (s: string) => void): ModelTarget | null {
  if (!record(v) || typeof v.model !== "string" || !v.model.trim()) { warn("Ignoring model target without provider/model."); return null; }
  let thinkingLevel: ThinkingLevel | undefined;
  if (v.thinkingLevel !== undefined) {
    if (typeof v.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinkingLevel)) thinkingLevel = v.thinkingLevel as ThinkingLevel;
    else warn(`Ignoring invalid thinking level '${String(v.thinkingLevel)}'.`);
  }
  return { model: v.model.trim(), thinkingLevel, cooldownHours: hours(v.cooldownHours, "cooldownHours", warn) };
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
    routes.push({ match: item.match.trim(), models, reasons: routeSlots(item.reasons, warn) });
  }
  const defaults = targets(raw.models, warn);
  const workerModels = targets(raw.workerModels, warn);
  const rr = record(raw.resume) ? raw.resume : {};
  const resume: ResumeConfig = {
    reasons: rr.enabled === true ? reasons(rr.reasons, ["manual", "threshold"], warn) : [],
    message: typeof rr.message === "string" && rr.message.trim() ? rr.message.trim() : DEFAULT_RESUME,
  };
  const preservation = resolvePreservationConfig(raw.preservation, warn);
  // A `preservation` section counts as useful configuration only when it is actually enabled: a host
  // that wrote `preservation: {enabled: false}` and nothing else has configured nothing, and returning
  // a config for it would make `/compaction-router` claim the package is active when no route exists.
  if (!routes.length && !defaults.length && !resume.reasons.length && !preservation.enabled) return null;
  return { routes, defaults, resume, cooldownHours: hours(raw.cooldownHours, "cooldownHours", warn), maxRetries: hours(raw.maxRetries, "maxRetries", warn), preservation, workerModels };
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
    // Both W5 keys are emitted ONLY when they carry something. An always-present
    // `preservation: {enabled: false, ...}` would rewrite every operator's settings file with a
    // section they never asked for, and -- worse for the round trip -- `resolveConfig` treats a
    // disabled preservation section as "no configuration", so emitting one would not even survive a
    // re-parse into the same object.
    ...(config.workerModels.length ? { workerModels: config.workerModels } : {}),
    ...(config.preservation.enabled ? { preservation: preservationToSettingsValue(config.preservation) } : {}),
  };
}

/** The `preservation` section as settings JSON. Only reached when the layer is enabled. */
function preservationToSettingsValue(preservation: PreservationConfig): Rec {
  return {
    enabled: true,
    observeAfterTokens: preservation.observeAfterTokens,
    mode: preservation.mode,
    ratio: preservation.ratio,
    maxFacts: preservation.maxFacts,
    injectFold: preservation.injectFold,
    ...(preservation.observerChunkMaxTokens === undefined ? {} : { observerChunkMaxTokens: preservation.observerChunkMaxTokens }),
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
