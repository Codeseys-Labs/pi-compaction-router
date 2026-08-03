/**
 * What the settings rows MEAN, and what a change to one writes -- with no TUI anywhere in it.
 *
 * This file is the reason the settings UI is testable. `src/settings-ui.ts` builds components and
 * hands them to `ctx.ui.custom()`; every rule about which target serves a reason, what a row shows,
 * and what lands in `settings.json` lives here as a function over plain objects. A rule that lives
 * inside a `SettingsList` callback can only be checked by driving a terminal.
 *
 * THE WRITE IS SURGICAL, AND THAT IS THE WHOLE DESIGN.
 *
 * The settings shape does not change (verdict §4.4: "New settings shape stays backward-compatible").
 * There is no per-reason field to write, so a per-reason pick has to land in the shape that already
 * exists -- and the shape offers two places: a `route` (matched by glob on the active model, filtered
 * by `reasons`) or the root `models` fallback chain (which applies to every reason at once, so it
 * cannot express "manual goes here, threshold goes there").
 *
 * So a pick lands in a route with `match: "*"` -- a catch-all, which is what the root fallback already
 * is, but per-reason. Three consequences, all deliberate:
 *
 *  - **Routes the operator wrote by hand are never touched.** Only routes whose `match` is exactly
 *    `"*"` are rewritten. A hand-written `anthropic/claude-opus-*` route keeps its position, its
 *    models and its reasons, and -- because `selectTargets` takes the FIRST matching route -- keeps
 *    winning over anything this UI writes. That is the right precedence: a specific rule an operator
 *    typed should beat a catch-all a dialog produced.
 *  - **Reasons the operator did not touch keep their exact configuration.** The draft records only
 *    the slots that changed. `toSettingsValue` rewrites those and copies everything else through,
 *    including keys this file does not model (`cooldownHours`, `maxRetries`, and anything a future
 *    wave adds).
 *  - **The precedence above is a footgun, so the write is verified rather than assumed.**
 *    `verifyEffective` re-parses the value we are about to write through this package's own
 *    `resolveConfig` + `selectTargets` and checks that each changed slot actually resolves to the
 *    model the operator picked. When a hand-written route out-ranks the catch-all, the operator is
 *    told their pick will not take effect for the active model -- instead of the dialog reporting
 *    success and the routing silently disagreeing with it. This is the one check that makes a
 *    surgical write honest.
 *
 * One narrowing is recorded rather than hidden: a row's drill-down picks ONE model, so applying it to
 * a reason whose current chain has several targets replaces the chain. Multi-target fallback chains
 * remain authorable -- through the `advanced` row's raw-JSON editor, which is exactly what that
 * escape hatch is for.
 */

import { globMatch, REASONS, type CompactionReason, type ModelTarget, type RouterConfig, resolveConfig } from "./config.js";
import { selectTargets } from "./selection.js";

/** The catch-all glob a UI-owned route uses. Routes with any other `match` are the operator's. */
export const UI_ROUTE_MATCH = "*";
/** A row whose reason no target serves. Shown, not hidden: "not routed" is a real configuration. */
export const NOT_ROUTED = "(not routed)";
/** Row id for the raw-JSON escape hatch. Not a routing slot. */
export const ADVANCED_ROW = "advanced";
/** Row id for the auto-resume policy. A cycling row, not a drill-down. */
export const RESUME_ROW = "resume";

/** The resume policies the row cycles through, in order. `overflow` is absent on purpose: pi already
 * retries an overflow compaction itself, so this package never sends it a resume turn. */
export const RESUME_VALUES = ["off", "manual", "threshold", "manual, threshold"] as const;

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** How a target is shown on a row and in a notice. Mirrors `/compaction-router`'s own formatting. */
export function describeTarget(target: Pick<ModelTarget, "model" | "thinkingLevel">): string {
  return `${target.model}${target.thinkingLevel ? `:${target.thinkingLevel}` : ""}`;
}

/** A whole chain, as a row value. `a -> b` is the same arrow `/compaction-router` uses. */
export function describeChain(targets: Array<Pick<ModelTarget, "model" | "thinkingLevel">>): string {
  return targets.length ? targets.map(describeTarget).join(" -> ") : NOT_ROUTED;
}

export interface SlotRow {
  id: string;
  label: string;
  currentValue: string;
  description: string;
  /** True for the three compaction reasons -- the rows whose Enter opens a model picker. */
  isReasonSlot: boolean;
}

/**
 * The effective chain for one reason, as configured -- cooldowns deliberately not consulted.
 *
 * A cooled-down target is still the CONFIGURED target, and a settings dialog that hid it would show
 * an operator a different answer than the one in their file. `/compaction-router` is the surface that
 * reports live cooldown state; this one reports configuration.
 */
export function effectiveChain(config: RouterConfig | null, activeModel: string, reason: CompactionReason): ModelTarget[] {
  if (!config) return [];
  return selectTargets(config, activeModel, reason).fire;
}

/** `resume.reasons` as one of `RESUME_VALUES`. An unrecognised combination reports the honest list. */
export function describeResume(config: RouterConfig | null): string {
  const reasons = config?.resume.reasons ?? [];
  if (!reasons.length) return "off";
  const wanted = REASONS.filter(r => reasons.includes(r));
  return wanted.join(", ");
}

/** `RESUME_VALUES` member -> the reason list it means. */
export function resumeReasonsFor(value: string): CompactionReason[] {
  if (value === "off") return [];
  return value.split(",").map(s => s.trim()).filter((s): s is CompactionReason => (REASONS as readonly string[]).includes(s));
}

/**
 * A draft edit of the `compactionRouter` settings key.
 *
 * Holds the raw section it was built from so `toSettingsValue` can copy every unmodelled key through
 * verbatim, and holds only the slots that actually changed -- so an operator who opens the dialog,
 * looks, and presses Escape produces no write at all (`changed()` is false and the caller skips it).
 */
export class RouterDraft {
  /** reason -> the `provider/model` reference the operator picked in this dialog. */
  private readonly picks = new Map<CompactionReason, string>();
  /** The resume row's new value, or `null` when it was not touched. */
  private resume: string | null = null;

  private constructor(
    /** The raw `compactionRouter` value as read, for pass-through. `{}` when absent or `false`. */
    private readonly section: Rec,
    readonly config: RouterConfig | null,
    readonly activeModel: string,
  ) {}

  /**
   * Build a draft from a settings snapshot's top-level object.
   *
   * A `false` section (the router explicitly disabled) is a legitimate starting point and is handled by
   * the same path as an absent one: there is nothing to preserve from either, so `section` is `{}` and
   * `toSettingsValue` writes `enabled: true` unconditionally. `config` comes from the real
   * `resolveConfig`, so it is `null` for both -- which is what makes every row read "(not routed)".
   */
  static from(settingsValue: Rec, sectionKey: string, activeModel: string): RouterDraft {
    const raw = settingsValue[sectionKey];
    const config = resolveConfig({ [sectionKey]: raw }, undefined, () => {
      // Warnings are the config module's own business and were already surfaced when the extension
      // loaded. A settings dialog re-reading the same file must not re-narrate them.
    });
    return new RouterDraft(record(raw) ? raw : {}, config, activeModel);
  }

  /** Whether anything would be written. An untouched dialog writes nothing. */
  changed(): boolean {
    return this.picks.size > 0 || this.resume !== null;
  }

  /** What the operator picked for a reason in this dialog, if anything. */
  pickFor(reason: CompactionReason): string | undefined {
    return this.picks.get(reason);
  }

  /**
   * Record one row change. Returns false for an id that is not an editable slot, so the caller can
   * tell a real edit from the `advanced` row's signal without matching strings twice.
   */
  apply(id: string, value: string): boolean {
    if (id === RESUME_ROW) {
      this.resume = value;
      return true;
    }
    if ((REASONS as readonly string[]).includes(id)) {
      this.picks.set(id as CompactionReason, value);
      return true;
    }
    return false;
  }

  /** The rows, in the order they are shown. `advanced` is added by the UI, not here. */
  rows(): SlotRow[] {
    const slots: SlotRow[] = REASONS.map(reason => {
      const pick = this.picks.get(reason);
      const chain = effectiveChain(this.config, this.activeModel, reason);
      return {
        id: reason,
        label: reason,
        currentValue: pick ?? describeChain(chain),
        description: pick
          ? `Will be written: ${reason} compaction routes to ${pick}.`
          : `Which model summarizes a '${reason}' compaction, for the active model ${this.activeModel}.`,
        isReasonSlot: true,
      };
    });
    slots.push({
      id: RESUME_ROW,
      label: "auto-resume",
      currentValue: this.resume ?? describeResume(this.config),
      description: "After compaction, send a follow-up turn so the agent continues instead of waiting. Overflow is excluded: pi already retries it.",
      isReasonSlot: false,
    });
    return slots;
  }

  /**
   * The value to write under the `compactionRouter` key.
   *
   * Order of operations, and why each step is the way it is:
   *
   *  1. Copy the section through. Unmodelled keys (`cooldownHours`, `maxRetries`, anything later)
   *     survive because they are never enumerated -- only overwritten if this method names them.
   *  2. `enabled: true`. A pick is an instruction to route; leaving a previous `enabled: false` in
   *     place would write configuration that cannot fire.
   *  3. Partition the existing routes into the operator's (any `match` other than `"*"`) and this
   *     UI's (`match: "*"`). Only the second group is rewritten.
   *  4. Strip every changed reason out of the UI-owned routes, then re-add it to the route whose
   *     model chain is exactly the picked model, creating that route if needed. Grouping by chain
   *     keeps the file small AND keeps reason sets disjoint across catch-all routes -- which is what
   *     stops `findRouteShadowing` from reporting the UI's own output as dead configuration.
   *  5. Drop any UI-owned route left with no reasons or no models. An empty route is noise
   *     `resolveConfig` would warn about on the next load.
   *
   * A UI-owned route with NO explicit `reasons` covers all three (that is `resolveConfig`'s default),
   * so stripping one reason from it has to write the remaining two explicitly. That expands the
   * operator's file slightly and changes nothing about what it means.
   */
  toSettingsValue(): Rec {
    // `enabled: true` unconditionally, and it is the same statement for all three starting points: an
    // absent key, a `false` key, and an `{enabled: false}` key all spread to nothing useful and all
    // need it written. A pick is an instruction to route; writing routes under an `enabled: false` the
    // spread carried through would produce configuration that cannot fire.
    const next: Rec = { ...this.section, enabled: true };

    const rawRoutes = Array.isArray(this.section.routes) ? this.section.routes : [];
    const foreign: unknown[] = [];
    const owned: Array<{ models: unknown; reasons: CompactionReason[]; rest: Rec }> = [];
    for (const item of rawRoutes) {
      if (!record(item) || typeof item.match !== "string" || item.match.trim() !== UI_ROUTE_MATCH) {
        foreign.push(item);
        continue;
      }
      const { match: _match, models, reasons, ...rest } = item;
      const covered = Array.isArray(reasons)
        ? reasons.filter((r): r is CompactionReason => (REASONS as readonly string[]).includes(r))
        : [...REASONS];
      owned.push({ models, reasons: covered, rest });
    }

    const changedReasons = [...this.picks.keys()];
    for (const entry of owned) entry.reasons = entry.reasons.filter(r => !changedReasons.includes(r));

    for (const [reason, reference] of this.picks) {
      const existing = owned.find(entry => isBarePickOf(entry.models, reference));
      if (existing) existing.reasons.push(reason);
      else owned.push({ models: [{ model: reference }], reasons: [reason], rest: {} });
    }

    const rebuilt = owned
      .filter(entry => entry.reasons.length > 0 && hasAnyModel(entry.models))
      .map(entry => ({ ...entry.rest, match: UI_ROUTE_MATCH, reasons: dedupeReasons(entry.reasons), models: entry.models }));
    const routes = [...foreign, ...rebuilt];
    if (routes.length) next.routes = routes;
    else delete next.routes;

    if (this.resume !== null) {
      const reasons = resumeReasonsFor(this.resume);
      const previous = record(this.section.resume) ? this.section.resume : {};
      // `message` is preserved: an operator who wrote a custom resume prompt must not lose it because
      // they toggled which reasons it fires on.
      next.resume = { ...previous, enabled: reasons.length > 0, reasons };
    }
    return next;
  }

  /**
   * Does the value we are about to write actually route each changed reason to the picked model?
   *
   * Re-parses through this package's own `resolveConfig` and asks `selectTargets` -- the same two
   * functions the compaction hook uses -- so this is a round-trip against the real decision, not a
   * re-reading of our own intent. A mismatch means a route that out-ranks the catch-all governs the
   * active model, and the operator is owed that sentence.
   */
  verifyEffective(sectionKey: string): string[] {
    const value = this.toSettingsValue();
    const config = resolveConfig({ [sectionKey]: value }, undefined, () => {});
    const problems: string[] = [];
    for (const [reason, reference] of this.picks) {
      const chain = effectiveChain(config, this.activeModel, reason);
      const first = chain[0];
      if (first?.model === reference) continue;
      const governing = shadowingRoute(value, this.activeModel, reason);
      problems.push(
        first
          ? `'${reason}' still routes to ${describeChain(chain)} for ${this.activeModel}, not ${reference}` +
            (governing ? `: route '${governing}' matches this model and comes first. Edit that route, or narrow it, via the advanced JSON editor.` : ".")
          : `'${reason}' resolves to no target for ${this.activeModel} even after this change.`,
      );
    }
    return problems;
  }
}

/** The first non-catch-all route that would win for this model and reason, for a precise message. */
function shadowingRoute(value: Rec, activeModel: string, reason: CompactionReason): string | undefined {
  const routes = Array.isArray(value.routes) ? value.routes : [];
  for (const item of routes) {
    if (!record(item) || typeof item.match !== "string") continue;
    const match = item.match.trim();
    if (match === UI_ROUTE_MATCH) continue;
    const covered = Array.isArray(item.reasons)
      ? item.reasons.filter((r): r is CompactionReason => (REASONS as readonly string[]).includes(r))
      : [...REASONS];
    if (covered.includes(reason) && globMatch(match, activeModel)) return match;
  }
  return undefined;
}

/** Reason lists are written in `REASONS` order and without duplicates, so a diff is stable. */
function dedupeReasons(reasons: CompactionReason[]): CompactionReason[] {
  return REASONS.filter(r => reasons.includes(r));
}

/**
 * Whether a route's `models` is exactly what this UI writes for one pick: a single target naming this
 * model and carrying nothing else.
 *
 * Mergeability is deliberately this narrow. A route naming the same model with a `thinkingLevel` or a
 * `cooldownHours` is a DIFFERENT configuration, and folding a new reason into it would silently apply
 * settings the operator never asked for on that reason -- so anything richer than `{model}` fails here
 * and gets its own route. Likewise a multi-target chain: it means something the row surface cannot say,
 * and merging into it would drop the rest of the chain.
 */
function isBarePickOf(models: unknown, reference: string): boolean {
  if (!Array.isArray(models) || models.length !== 1) return false;
  const only = models[0];
  return record(only) && only.model === reference && Object.keys(only).length === 1;
}

/** Whether a route names at least one target `resolveConfig` would keep. An empty route is dropped. */
function hasAnyModel(models: unknown): boolean {
  return Array.isArray(models) && models.some(item => record(item) && typeof item.model === "string" && item.model.trim() !== "");
}
