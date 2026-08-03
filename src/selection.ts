/**
 * Route selection with a named reason for every outcome, including the empty one.
 *
 * Upstream: https://github.com/XTSoftwareLabs/neatcontext-plugins,
 * `plugins/claude-code/neatcontext/src/core/save-nudge.mjs` `evaluateSaveNudge` -- the
 * `{fire, tier, reasons, suppressor}` return, its closed suppressor vocabulary
 * (`manual-mode` / `already-proposed` / `fire-budget` / `fire-unresolved` / `no-writes` /
 * `mid-flight` / `nothing-since-save` / `nothing-since-fire`), and the `no(suppressor)` helper that
 * makes every early return name itself. Read at commit 5b1c750aed83da604c93814081b9daf7267d39f7.
 * MIT, Copyright (c) 2026 XTSoftwareLabs.
 *
 * WHY. `selectTargets` returned a bare `ModelTarget[]`, and the caller's whole reading of an empty
 * array was `if (!targets.length) return;` -- a silent, reasonless no-op. Four different situations
 * produced that same empty array: no models configured at all, a route that matches this model but
 * excludes this compaction reason, every candidate under cooldown, and a route whose models all
 * failed validation. An operator asking "why did my threshold compaction not route?" had nothing to
 * read, and neither did a test. Upstream's own comment is the standard: the gate is "pure on purpose:
 * every threshold and suppressor lives here, where a table test can reach it without a transcript, a
 * hook, or a file."
 *
 * Adapted: upstream's suppressors are its save-nudge's vocabulary; ours are route selection's. The
 * `tier` field has no analogue here and is dropped. `reasons` keeps upstream's meaning exactly -- the
 * human-readable grounds for the decision, in the order they were found.
 *
 * The route-shadowing warning and the `maxTokens` guard in this file are ours
 * (`dive-ours-pi-compaction-router.md` §5.4), placed here because both are statements about a
 * selection an operator cannot otherwise see.
 */

import { globMatch, WORKER_SLOT, type CompactionReason, type ModelTarget, type Route, type RouterConfig, type RouteSlot } from "./config.js";
import type { CooldownEntry } from "./cooldown.js";

/**
 * Why no target will be tried. A closed set: an empty `fire` list ALWAYS carries one of these, which
 * is the property the tests pin.
 */
export type Suppressor =
  /** The configuration names no route for this model and no fallback models. */
  | "no-targets-configured"
  /** A route matches this model but not this compaction reason, and there are no defaults to fall to. */
  | "reason-not-routed"
  /** Every candidate is inside a cooldown window from an earlier failure. */
  | "all-targets-cooled-down";

export interface TargetSelection {
  /** The targets to try, in order. Upstream's `fire`, which here is a list rather than a boolean. */
  fire: ModelTarget[];
  /** Human-readable grounds for this outcome -- for the `/compaction-router` surface and the ledger. */
  reasons: string[];
  /** Non-null exactly when `fire` is empty. */
  suppressor: Suppressor | null;
}

export interface SelectOptions {
  /** Consulted per candidate; return the active cooldown entry, or undefined. */
  cooldownFor?: (target: ModelTarget) => CooldownEntry | undefined;
}

/** Upstream's `no(suppressor)` helper: every empty return has to name itself to compile. */
const none = (suppressor: Suppressor, ...reasons: string[]): TargetSelection => ({ fire: [], reasons, suppressor });

function describe(target: ModelTarget): string {
  return `${target.model}${target.thinkingLevel ? `:${target.thinkingLevel}` : ""}`;
}

/**
 * The targets for one compaction, and why.
 *
 * Selection order is unchanged from the shipped behaviour -- first matching route by reason and glob,
 * else the defaults -- because changing it is W6's fit-aware selector, not this. What changes is that
 * the outcome is now legible: which route matched, which candidates were dropped for cooldown, and
 * which suppressor explains an empty list.
 */
export function selectTargets(config: RouterConfig, activeModel: string, reason: CompactionReason, options: SelectOptions = {}): TargetSelection {
  const route = config.routes.find(r => r.reasons.includes(reason) && globMatch(r.match, activeModel));
  const candidates = route?.models ?? config.defaults;
  const reasons: string[] = [];
  if (route) reasons.push(`route '${route.match}' matched ${activeModel} for a ${reason} compaction`);
  else if (config.defaults.length) reasons.push(`no route matched ${activeModel} for a ${reason} compaction; using the fallback models`);

  if (!candidates.length) {
    // Distinguish the two shapes of "nothing to try", because they are different operator actions: a
    // missing configuration is a thing to write, a reason mismatch is a thing to widen. A route that
    // matches the model on some OTHER reason is the tell.
    const modelMatchesSomeRoute = config.routes.some((r: Route) => globMatch(r.match, activeModel));
    if (modelMatchesSomeRoute) {
      const routed = config.routes.filter(r => globMatch(r.match, activeModel)).flatMap(r => r.reasons);
      return none("reason-not-routed", `${activeModel} has route(s) covering ${[...new Set(routed)].join(", ") || "no reasons"}, but not '${reason}', and no fallback models are configured`);
    }
    return none("no-targets-configured", `no route matches ${activeModel} and no fallback models are configured`);
  }

  if (!options.cooldownFor) return { fire: candidates, reasons, suppressor: null };

  const fire: ModelTarget[] = [];
  const cooled: string[] = [];
  for (const target of candidates) {
    const entry = options.cooldownFor(target);
    if (entry) cooled.push(`${describe(target)} is cooled down (${entry.reason}${entry.until ? ` until ${entry.until}` : ""})`);
    else fire.push(target);
  }
  if (!fire.length) {
    // Every target is cooling. This is the case the whole cooldown layer exists for, and it is also
    // the case that MUST say so: silently returning nothing here looks identical to having no
    // configuration, and the operator's fix is the opposite one (wait, or clear the cooldown file).
    return none("all-targets-cooled-down", ...reasons, ...cooled);
  }
  return { fire, reasons: [...reasons, ...cooled], suppressor: null };
}

// ── The observer worker's targets (W5) ──────────────────────────────────────────────────────────

/**
 * The observer worker's target chain, through the SAME table, suppressors and cooldowns as a
 * compaction — which is the capability POM lacks and the reason this layer belongs here.
 *
 * Upstream POM resolves one `observational-memory.model`, memoizes it across all three of its
 * background stages, and falls back to the SESSION model when it is missing
 * (`runtime.ts:42-62`, read at `497fcfb`). That last arm is the starvation: the background worker
 * quietly borrows the model the user's own turn is waiting on. This function has no such arm. If no
 * worker target resolves, the caller gets an empty `fire` with a suppressor and records nothing --
 * observation is skipped, never silently promoted onto the session model.
 *
 * Precedence: an explicit `workerModels` chain first, then any route that opted into the `worker`
 * slot, and NEVER `config.defaults`. Falling through to the compaction defaults would point the
 * observer at the expensive summarization model, which inverts the entire point of a cheap worker --
 * an operator who configured one compaction target and switched the layer on would be billed for a
 * frontier-model call every 10 000 tokens without ever asking for one.
 */
export function selectWorkerTargets(config: RouterConfig, activeModel: string, options: SelectOptions = {}): TargetSelection {
  const reasons: string[] = [];
  let candidates: ModelTarget[] = config.workerModels;
  if (candidates.length) reasons.push(`using the configured worker models for the observer`);
  else {
    const route = config.routes.find(r => r.reasons.includes(WORKER_SLOT) && globMatch(r.match, activeModel));
    if (route) {
      candidates = route.models;
      reasons.push(`route '${route.match}' matched ${activeModel} for the observer worker`);
    }
  }
  if (!candidates.length) {
    return none("no-targets-configured", `no worker models are configured and no route covers the '${WORKER_SLOT}' slot for ${activeModel}; set compactionRouter.workerModels to run the observer`);
  }
  if (!options.cooldownFor) return { fire: candidates, reasons, suppressor: null };

  const fire: ModelTarget[] = [];
  const cooled: string[] = [];
  for (const target of candidates) {
    const entry = options.cooldownFor(target);
    if (entry) cooled.push(`${describe(target)} is cooled down (${entry.reason}${entry.until ? ` until ${entry.until}` : ""})`);
    else fire.push(target);
  }
  if (!fire.length) return none("all-targets-cooled-down", ...reasons, ...cooled);
  return { fire, reasons: [...reasons, ...cooled], suppressor: null };
}

// ── Route shadowing (dive-ours §5.4) ────────────────────────────────────────────────────────────

export interface ShadowWarning {
  /** Index and pattern of the general route that wins. */
  shadowing: { index: number; match: string };
  /** Index and pattern of the specific route that can never be reached. */
  shadowed: { index: number; match: string };
  /** The slots the shadowing applies to. Includes `worker` since W5 gave routes that slot too. */
  reasons: RouteSlot[];
  message: string;
}

/**
 * Routes that can never be reached, because an earlier, more general route matches everything they do.
 *
 * `selectTargets` takes the FIRST matching route (documented: "the first matching route wins"), and
 * there is no specificity ordering. So `anthropic/*` placed before `anthropic/claude-opus-*` makes the
 * second route dead configuration -- the operator wrote a rule, the file kept it, and nothing ever
 * used it. The live settings file happens to be ordered safely, and nothing warned; that is luck, not
 * a guarantee.
 *
 * Subsumption is decided by running the general pattern against the specific pattern's own text: if
 * `anthropic/*` matches the literal string `anthropic/claude-opus-*` and the reverse does not hold,
 * the first is strictly more general. Equal patterns are reported too -- a duplicated `match` is the
 * same dead-configuration bug with a simpler cause. This is a conservative test over patterns rather
 * than a real language-inclusion decision, so it can miss an exotic case; it does not produce false
 * positives, which is the direction a warning has to err.
 */
export function findRouteShadowing(config: RouterConfig): ShadowWarning[] {
  const warnings: ShadowWarning[] = [];
  for (let i = 0; i < config.routes.length; i++) {
    for (let j = i + 1; j < config.routes.length; j++) {
      const general = config.routes[i]!, specific = config.routes[j]!;
      // Shadowing only matters where the reason sets overlap: `anthropic/*` for `manual` does not
      // shadow `anthropic/claude-opus-*` for `overflow`, and warning about it would be noise.
      const overlap = specific.reasons.filter(r => general.reasons.includes(r));
      if (!overlap.length) continue;
      if (!globMatch(general.match, specific.match)) continue;
      const equal = general.match.toLowerCase() === specific.match.toLowerCase();
      if (!equal && globMatch(specific.match, general.match)) continue;
      warnings.push({
        shadowing: { index: i, match: general.match },
        shadowed: { index: j, match: specific.match },
        reasons: overlap,
        message: equal
          ? `Route ${j + 1} duplicates route ${i + 1}'s match '${general.match}' for ${overlap.join(", ")}; the first one wins and route ${j + 1} is never used.`
          : `Route ${i + 1} '${general.match}' is more general than route ${j + 1} '${specific.match}' and comes first, so route ${j + 1} is never used for ${overlap.join(", ")}. Put the specific route first.`,
      });
    }
  }
  return warnings;
}

// ── maxTokens guard (dive-ours §5.4) ────────────────────────────────────────────────────────────

/**
 * Pi's own summary budget for the main arm: `maxTokens = min(floor(0.8 * reserveTokens), model.maxTokens)`
 * when `model.maxTokens > 0`, else `0.8 * reserveTokens` uncapped
 * (`dist/core/compaction/compaction.js:453`, read at our pinned 0.81.1).
 */
export function summaryBudgetTokens(reserveTokens: number): number {
  return Math.floor(0.8 * reserveTokens);
}

/**
 * The fraction of pi's requested summary budget a target must be able to write before this package
 * will still route to it.
 *
 * **This number is a guess, and is labelled as one** (neatcontext's practice: a threshold recorded as
 * uncalibrated is debuggable, one presented as derived is not). The reasoning: pi already does
 * `min(...)`, so a small shortfall is a shorter summary, not a broken one, and refusing to route over
 * it would trade a documented outcome for an undocumented fail-open. A target that can write less than
 * half of what pi budgeted is a different thing -- the operator raised `reserveTokens` precisely to get
 * a longer summary and would be silently getting a much shorter one. Nothing has measured where the
 * real line is. If a measurement ever does, this constant is the one to move.
 */
export const MAX_TOKENS_REFUSAL_FRACTION = 0.5;

export interface MaxTokensVerdict {
  /** The budget pi will ask for, before the model's own cap. */
  requested: number;
  /** `model.maxTokens`, or `undefined` when the registry reports none. */
  available?: number;
  /** True when the model's cap is below the requested budget: the summary will be cut short. */
  truncates: boolean;
  /** True when the shortfall is severe enough to skip the target. Implies `truncates`. */
  refuse: boolean;
  /** Present whenever `truncates`. */
  message?: string;
}

/**
 * Whether a target's `maxTokens` can hold the summary pi is about to ask it for.
 *
 * With the default 16 384 reserve the requested budget is 13 107, under every catalogued `maxTokens`,
 * so this is quiet today -- and that is the hazard: WS11's C0 recommends RAISING `reserveTokens`, and
 * the moment it rises past a target's cap the summary is quietly truncated at the provider with
 * nothing said anywhere. `model.maxTokens <= 0` is pi's own "no cap known" encoding and is treated as
 * no cap, exactly as pi treats it.
 */
export function checkMaxTokens(model: { maxTokens?: number }, reserveTokens: number, targetName: string): MaxTokensVerdict {
  const requested = summaryBudgetTokens(reserveTokens);
  const available = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
  if (available === undefined || requested <= available) return { requested, available, truncates: false, refuse: false };
  const refuse = available < requested * MAX_TOKENS_REFUSAL_FRACTION;
  const shortfall = `'${targetName}' can emit at most ${available} output tokens, but pi will ask this compaction for ${requested} (0.8 x the ${reserveTokens}-token reserve)`;
  return {
    requested,
    available,
    truncates: true,
    refuse,
    message: refuse
      ? `Skipping ${shortfall} -- under half the requested budget, so its summary would be cut short enough to matter. Lower reserveTokens or route to a model with a larger output cap.`
      : `${shortfall}, so the summary will be capped at ${available} tokens. Routing anyway: pi caps the request the same way, and a shorter summary beats not routing.`,
  };
}
