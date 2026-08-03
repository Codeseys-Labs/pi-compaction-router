/**
 * AN EMPTY TARGET LIST MUST SAY WHY, AND A DEAD ROUTE MUST BE REPORTED.
 *
 * `selectTargets` used to return a bare `ModelTarget[]`, and the caller's whole reading of an empty
 * one was `if (!targets.length) return;`. Four different situations produced that same empty array --
 * nothing configured, a route that matches the model but not this reason, every candidate cooling, a
 * route whose models all failed validation -- and an operator asking "why did my threshold compaction
 * not route?" had nothing to read. Neither did a test.
 *
 * The three mechanisms here:
 *  - **Suppressor taxonomy** (neatcontext `5b1c750`, `evaluateSaveNudge`'s
 *    `{fire, reasons, suppressor}`): an empty `fire` ALWAYS carries a named suppressor. The last test
 *    in that block is the one that matters -- it enumerates every empty-list path and asserts none of
 *    them is silent.
 *  - **Route shadowing** (`dive-ours` §5.4): the first matching route wins with no specificity
 *    ordering, so `anthropic/*` before `anthropic/claude-opus-*` makes the second route dead
 *    configuration. The live settings file happens to be ordered safely; that is luck, and nothing
 *    warned.
 *  - **`maxTokens` guard** (`dive-ours` §5.4): pi asks for `0.8 x reserveTokens` output tokens and
 *    silently `min()`s it against the model's cap, so raising `reserveTokens` (which WS11's C0
 *    recommends) can quietly truncate a summary with nothing said anywhere.
 */

import { describe, expect, test } from "bun:test";
import { resolveConfig, type RouterConfig } from "../src/config.js";
import type { CooldownEntry } from "../src/cooldown.js";
import { checkMaxTokens, findRouteShadowing, MAX_TOKENS_REFUSAL_FRACTION, selectTargets, summaryBudgetTokens } from "../src/selection.js";

const RESERVE = 16_384;

function config(section: Record<string, unknown>): RouterConfig {
  const resolved = resolveConfig({ compactionRouter: section }, undefined, () => {});
  if (!resolved) throw new Error("fixture produced no config");
  return resolved;
}

const cooled = (reason = "429 Too Many Requests"): CooldownEntry => ({ until: "2099-01-01T00:00:00.000Z", reason, stage: "manual/retryable" });

describe("suppressor taxonomy", () => {
  test("a matched route returns its models and no suppressor", () => {
    const c = config({ routes: [{ match: "anthropic/*", reasons: ["manual"], models: [{ model: "openai-codex/gpt-5.4-mini" }] }] });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual");
    expect(s.fire.map(t => t.model)).toEqual(["openai-codex/gpt-5.4-mini"]);
    expect(s.suppressor).toBeNull();
    // And it says WHICH route matched, which is the question an operator with four routes actually has.
    expect(s.reasons.join(" ")).toContain("route 'anthropic/*' matched");
  });

  test("no route and no fallback models: 'no-targets-configured'", () => {
    const c = config({ routes: [{ match: "openai/*", reasons: ["manual"], models: [{ model: "a/b" }] }], resume: { enabled: true } });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual");
    expect(s.fire).toEqual([]);
    expect(s.suppressor).toBe("no-targets-configured");
    expect(s.reasons.join(" ")).toContain("no route matches anthropic/claude-sonnet-4-5");
  });

  test("a route matches the model but not this REASON: 'reason-not-routed'", () => {
    // A distinct suppressor from the one above, because the operator's fix is the opposite: widen a
    // route's reasons rather than write a route. Collapsing the two would send them the wrong way.
    const c = config({ routes: [{ match: "anthropic/*", reasons: ["threshold"], models: [{ model: "a/b" }] }] });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual");
    expect(s.suppressor).toBe("reason-not-routed");
    expect(s.reasons.join(" ")).toContain("route(s) covering threshold, but not 'manual'");
  });

  test("every candidate cooling: 'all-targets-cooled-down', naming each one", () => {
    const c = config({ models: [{ model: "a/one" }, { model: "b/two" }] });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual", { cooldownFor: () => cooled() });
    expect(s.fire).toEqual([]);
    expect(s.suppressor).toBe("all-targets-cooled-down");
    // This is the case the cooldown layer exists for, and the one that MUST say so: an empty list here
    // looks identical to having no configuration, and the fix is the opposite (wait, or clear the file).
    expect(s.reasons.join(" ")).toContain("a/one is cooled down (429 Too Many Requests");
    expect(s.reasons.join(" ")).toContain("b/two is cooled down");
  });

  test("a partially-cooled chain fires the survivors and still reports the skips", () => {
    const c = config({ models: [{ model: "a/one" }, { model: "b/two" }] });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual", { cooldownFor: t => t.model === "a/one" ? cooled() : undefined });
    expect(s.fire.map(t => t.model)).toEqual(["b/two"]);
    expect(s.suppressor).toBeNull();
    expect(s.reasons.join(" ")).toContain("a/one is cooled down");
  });

  test("the fallback models are used when no route matches, and said so", () => {
    const c = config({ models: [{ model: "a/one" }], routes: [{ match: "openai/*", reasons: ["manual"], models: [{ model: "b/two" }] }] });
    const s = selectTargets(c, "anthropic/claude-sonnet-4-5", "manual");
    expect(s.fire.map(t => t.model)).toEqual(["a/one"]);
    expect(s.reasons.join(" ")).toContain("using the fallback models");
  });

  test("a thinking level is carried into the reported cooldown line", () => {
    const c = config({ models: [{ model: "a/one", thinkingLevel: "high" }] });
    const s = selectTargets(c, "anthropic/x", "manual", { cooldownFor: () => cooled() });
    expect(s.reasons.join(" ")).toContain("a/one:high is cooled down");
  });

  test("EVERY empty-list path carries a suppressor -- none is silent", () => {
    // The invariant, enumerated rather than asserted case by case. This is what makes the return type
    // worth having: a future edit that adds a fifth way to return nothing fails here.
    const cases: RouterConfig[] = [
      config({ routes: [{ match: "openai/*", reasons: ["manual"], models: [{ model: "a/b" }] }], resume: { enabled: true } }),
      config({ routes: [{ match: "anthropic/*", reasons: ["threshold"], models: [{ model: "a/b" }] }] }),
      config({ models: [{ model: "a/one" }] }),
    ];
    for (const c of cases) {
      for (const reason of ["manual", "threshold", "overflow"] as const) {
        const s = selectTargets(c, "anthropic/claude-sonnet-4-5", reason, { cooldownFor: () => cooled() });
        if (s.fire.length === 0) expect(s.suppressor, `${reason} on ${JSON.stringify(c.routes)}`).not.toBeNull();
        else expect(s.suppressor).toBeNull();
      }
    }
  });

  test("selection is unchanged when no cooldown source is supplied", () => {
    // W2 must not make cooldowns mandatory to select: a caller that does not pass `cooldownFor` gets
    // exactly the shipped ordering.
    const c = config({ models: [{ model: "a/one" }, { model: "b/two" }] });
    expect(selectTargets(c, "anthropic/x", "manual").fire.map(t => t.model)).toEqual(["a/one", "b/two"]);
  });
});

describe("route shadowing", () => {
  test("a general route before a specific one is reported as dead configuration", () => {
    const c = config({ routes: [
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "a/b" }] },
      { match: "anthropic/claude-opus-*", reasons: ["manual"], models: [{ model: "c/d" }] },
    ] });
    const warnings = findRouteShadowing(c);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.shadowing.match).toBe("anthropic/*");
    expect(warnings[0]!.shadowed.match).toBe("anthropic/claude-opus-*");
    // The message has to name the fix, not just the problem.
    expect(warnings[0]!.message).toContain("Put the specific route first");
  });

  test("the SAFE order is not reported", () => {
    const c = config({ routes: [
      { match: "anthropic/claude-opus-*", reasons: ["manual"], models: [{ model: "c/d" }] },
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "a/b" }] },
    ] });
    expect(findRouteShadowing(c)).toEqual([]);
  });

  test("the live settings file's shape -- codex before anthropic -- is not reported", () => {
    // §5.4 records that the live file orders `openai-codex/*` before `anthropic/*`, which is fine.
    // A warning that fired on the real configuration would be worse than no warning.
    const c = config({ routes: [
      { match: "openai-codex/*", reasons: ["manual", "threshold", "overflow"], models: [{ model: "openai-codex/gpt-5.4-mini" }] },
      { match: "anthropic/*", reasons: ["manual", "threshold", "overflow"], models: [{ model: "anthropic/claude-haiku-4-5" }] },
    ] });
    expect(findRouteShadowing(c)).toEqual([]);
  });

  test("a duplicated match is reported as the same dead-configuration bug", () => {
    const c = config({ routes: [
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "a/b" }] },
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "c/d" }] },
    ] });
    expect(findRouteShadowing(c)[0]!.message).toContain("duplicates route 1's match");
  });

  test("non-overlapping REASONS are not shadowing", () => {
    // `anthropic/*` for manual does not shadow `anthropic/claude-opus-*` for overflow, and warning
    // about it would be noise an operator learns to ignore.
    const c = config({ routes: [
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "a/b" }] },
      { match: "anthropic/claude-opus-*", reasons: ["overflow"], models: [{ model: "c/d" }] },
    ] });
    expect(findRouteShadowing(c)).toEqual([]);
  });

  test("only the overlapping reasons are named in the warning", () => {
    const c = config({ routes: [
      { match: "anthropic/*", reasons: ["manual", "threshold"], models: [{ model: "a/b" }] },
      { match: "anthropic/claude-opus-*", reasons: ["threshold", "overflow"], models: [{ model: "c/d" }] },
    ] });
    const w = findRouteShadowing(c)[0]!;
    expect(w.reasons).toEqual(["threshold"]);
    expect(w.message).not.toContain("overflow");
  });

  test("a bare `*` shadows everything after it", () => {
    const c = config({ routes: [
      { match: "*", reasons: ["manual"], models: [{ model: "a/b" }] },
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "c/d" }] },
      { match: "openai/gpt-5", reasons: ["manual"], models: [{ model: "e/f" }] },
    ] });
    expect(findRouteShadowing(c).length).toBe(2);
  });

  test("unrelated routes are not reported however many there are", () => {
    const c = config({ routes: [
      { match: "anthropic/*", reasons: ["manual"], models: [{ model: "a/b" }] },
      { match: "openai-codex/*", reasons: ["manual"], models: [{ model: "c/d" }] },
      { match: "google/*", reasons: ["manual"], models: [{ model: "e/f" }] },
    ] });
    expect(findRouteShadowing(c)).toEqual([]);
  });
});

describe("maxTokens guard", () => {
  test("the budget is pi's own formula: floor(0.8 x reserveTokens)", () => {
    // `dist/core/compaction/compaction.js:453` at our pinned 0.81.1.
    expect(summaryBudgetTokens(RESERVE)).toBe(13_107);
  });

  test("the default reserve against a catalogued model is quiet -- which is the hazard", () => {
    // 13 107 is under every catalogued maxTokens, so this guard says nothing today. WS11's C0
    // recommends RAISING reserveTokens, and that is when it starts mattering.
    const v = checkMaxTokens({ maxTokens: 128_000 }, RESERVE, "openai-codex/gpt-5.4-mini");
    expect(v.truncates).toBeFalse();
    expect(v.refuse).toBeFalse();
    expect(v.message).toBeUndefined();
  });

  test("a raised reserve past the model's cap WARNS and still routes", () => {
    // A modest shortfall is a shorter summary, not a broken one -- pi does the same min() -- so
    // refusing here would trade a documented outcome for an undocumented fail-open.
    const v = checkMaxTokens({ maxTokens: 8_192 }, 12_800, "small/model");
    expect(summaryBudgetTokens(12_800)).toBe(10_240);
    expect(v.truncates).toBeTrue();
    expect(v.refuse).toBeFalse();
    expect(v.message).toContain("capped at 8192 tokens");
    expect(v.message).toContain("Routing anyway");
  });

  test("a SEVERE shortfall refuses the target and names the fix", () => {
    const v = checkMaxTokens({ maxTokens: 4_096 }, 65_536, "tiny/model");
    expect(summaryBudgetTokens(65_536)).toBe(52_428);
    expect(v.refuse).toBeTrue();
    expect(v.message).toContain("Skipping");
    expect(v.message).toContain("Lower reserveTokens");
  });

  test("the refusal threshold is exactly the documented (guessed) fraction", () => {
    // MAX_TOKENS_REFUSAL_FRACTION is labelled a guess in src/selection.ts. Pinning it here means a
    // future recalibration is a visible, deliberate change rather than a drift.
    const requested = summaryBudgetTokens(RESERVE);
    const justUnder = Math.floor(requested * MAX_TOKENS_REFUSAL_FRACTION) - 1;
    const justOver = Math.ceil(requested * MAX_TOKENS_REFUSAL_FRACTION) + 1;
    expect(checkMaxTokens({ maxTokens: justUnder }, RESERVE, "t").refuse).toBeTrue();
    expect(checkMaxTokens({ maxTokens: justOver }, RESERVE, "t").refuse).toBeFalse();
  });

  test("a model reporting no cap is treated as uncapped, exactly as pi treats it", () => {
    // `model.maxTokens > 0 ? model.maxTokens : POSITIVE_INFINITY` is pi's own encoding.
    for (const maxTokens of [0, undefined, -1]) {
      const v = checkMaxTokens({ maxTokens }, 65_536, "t");
      expect(v.truncates, String(maxTokens)).toBeFalse();
      expect(v.available, String(maxTokens)).toBeUndefined();
    }
  });

  test("a cap exactly equal to the requested budget does not warn", () => {
    expect(checkMaxTokens({ maxTokens: summaryBudgetTokens(RESERVE) }, RESERVE, "t").truncates).toBeFalse();
  });

  test("the warning states both numbers, because the operator has to choose between them", () => {
    const v = checkMaxTokens({ maxTokens: 8_192 }, 12_800, "small/model");
    expect(v.message).toContain("8192");
    expect(v.message).toContain("10240");
    expect(v.message).toContain("12800-token reserve");
  });
});
