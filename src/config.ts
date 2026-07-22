import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REASONS = ["manual", "threshold", "overflow"] as const;
export type CompactionReason = (typeof REASONS)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelTarget { model: string; thinkingLevel?: ThinkingLevel }
export interface Route { match: string; models: ModelTarget[]; reasons: CompactionReason[] }
export interface ResumeConfig { reasons: CompactionReason[]; message: string }
export interface RouterConfig { routes: Route[]; defaults: ModelTarget[]; resume: ResumeConfig }

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
function target(v: unknown, warn: (s: string) => void): ModelTarget | null {
  if (!record(v) || typeof v.model !== "string" || !v.model.trim()) { warn("Ignoring model target without provider/model."); return null; }
  let thinkingLevel: ThinkingLevel | undefined;
  if (v.thinkingLevel !== undefined) {
    if (typeof v.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(v.thinkingLevel)) thinkingLevel = v.thinkingLevel as ThinkingLevel;
    else warn(`Ignoring invalid thinking level '${String(v.thinkingLevel)}'.`);
  }
  return { model: v.model.trim(), thinkingLevel };
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
  return { routes, defaults, resume };
}

export function loadConfig(ctx: ExtensionContext): RouterConfig | null {
  const s = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
  return resolveConfig(s.getGlobalSettings(), ctx.isProjectTrusted() ? s.getProjectSettings() : undefined);
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
export function selectTargets(config: RouterConfig, activeModel: string, reason: CompactionReason): ModelTarget[] {
  const route = config.routes.find(r => r.reasons.includes(reason) && globMatch(r.match, activeModel));
  return route?.models ?? config.defaults;
}
