/**
 * What a row change actually writes -- and, more importantly, what it leaves alone.
 *
 * The draft is where the UI's one real design risk lives. The settings shape does not change
 * (verdict §4.4), so a per-reason pick has to land in the `routes` array that already exists, next to
 * routes the operator wrote by hand. Every test here is about that boundary: the operator's routes are
 * untouched, unmodelled keys survive, reasons nobody edited keep their configuration, and when a
 * hand-written route out-ranks the UI's catch-all the operator is TOLD rather than left with a dialog
 * that reported success and routing that disagrees.
 */

import { describe, expect, test } from "bun:test";
import { resolveConfig, type CompactionReason } from "../src/config.js";
import { describeChain, describeResume, effectiveChain, NOT_ROUTED, RESUME_ROW, RESUME_VALUES, resumeReasonsFor, RouterDraft, UI_ROUTE_MATCH } from "../src/settings-draft.js";
import { selectTargets } from "../src/selection.js";

const KEY = "compactionRouter";
const ACTIVE = "anthropic/claude-sonnet-4-5";

const draftOf = (section: unknown, active = ACTIVE): RouterDraft => RouterDraft.from({ [KEY]: section }, KEY, active);

/** What the router would actually do with a written value, via the real config + selection path. */
function resolved(value: unknown, reason: CompactionReason, active = ACTIVE): string[] {
  const config = resolveConfig({ [KEY]: value }, undefined, () => {});
  if (!config) return [];
  return selectTargets(config, active, reason).fire.map(t => t.model);
}

describe("rows report the configured chain", () => {
  test("a fallback chain shows on every reason row", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a" }, { model: "openai/b" }] });
    const rows = draft.rows();
    expect(rows.slice(0, 3).map(r => r.currentValue)).toEqual(["anthropic/a -> openai/b", "anthropic/a -> openai/b", "anthropic/a -> openai/b"]);
  });

  test("a reason no target serves says so instead of showing an empty value", () => {
    // "not routed" is a real configuration, not a missing one, and hiding it would make the dialog
    // disagree with `/compaction-router`, which reports the same fact with its suppressor.
    const draft = draftOf({ enabled: true, routes: [{ match: "anthropic/*", reasons: ["manual"], models: [{ model: "anthropic/a" }] }] });
    const rows = draft.rows();
    expect(rows[0]!.currentValue).toBe("anthropic/a");
    expect(rows[1]!.currentValue).toBe(NOT_ROUTED);
    expect(rows[2]!.currentValue).toBe(NOT_ROUTED);
  });

  test("thinkingLevel is shown, because it is part of what a target IS", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a", thinkingLevel: "low" }] });
    expect(draft.rows()[0]!.currentValue).toBe("anthropic/a:low");
  });

  test("a disabled router shows every row as not routed, and can still be edited", () => {
    const draft = draftOf(false);
    expect(draft.config).toBeNull();
    expect(draft.rows().slice(0, 3).every(r => r.currentValue === NOT_ROUTED)).toBeTrue();
    // And a pick re-enables it, rather than writing routes under an `enabled: false` that cannot fire.
    draft.apply("manual", "anthropic/x");
    expect(draft.toSettingsValue().enabled).toBe(true);
    expect(resolved(draft.toSettingsValue(), "manual")).toEqual(["anthropic/x"]);
  });

  test("an absent key is a legitimate starting point", () => {
    const draft = RouterDraft.from({}, KEY, ACTIVE);
    expect(draft.changed()).toBeFalse();
    draft.apply("manual", "anthropic/x");
    expect(resolved(draft.toSettingsValue(), "manual")).toEqual(["anthropic/x"]);
  });

  test("all three disabled shapes re-enable on a pick, and none writes enabled: false", () => {
    // `false`, `{enabled: false}` and an absent key are three ways to be off, and `enabled: true` has to
    // be written for all of them. The `{enabled: false}` case is the one a spread would carry through
    // silently: it produces routes under a flag that stops them ever firing.
    for (const section of [false, { enabled: false }, { enabled: false, routes: [] }, undefined]) {
      const draft = section === undefined ? RouterDraft.from({}, KEY, ACTIVE) : draftOf(section);
      expect(draft.config).toBeNull();
      draft.apply("manual", "anthropic/x");
      const value = draft.toSettingsValue();
      expect(value.enabled, `section ${JSON.stringify(section)} must write enabled: true`).toBe(true);
      expect(resolved(value, "manual")).toEqual(["anthropic/x"]);
    }
  });

  test("a disabled key that still holds routes keeps them when it is re-enabled", () => {
    // `{enabled: false, routes: [...]}` is an operator who turned routing off without deleting their
    // configuration. Re-enabling must not throw their routes away.
    const draft = draftOf({ enabled: false, routes: [{ match: "openai/*", reasons: ["overflow"], models: [{ model: "openai/keep" }] }] });
    draft.apply("manual", "anthropic/x");
    const value = draft.toSettingsValue();
    expect(resolved(value, "manual")).toEqual(["anthropic/x"]);
    expect(resolved(value, "overflow", "openai/gpt-5")).toEqual(["openai/keep"]);
  });

  test("the row for a pending pick shows the pick, not the old value", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/old" }] });
    draft.apply("manual", "anthropic/new");
    const rows = draft.rows();
    expect(rows[0]!.currentValue).toBe("anthropic/new");
    expect(rows[0]!.description).toContain("Will be written");
    // Untouched rows still show what is configured.
    expect(rows[1]!.currentValue).toBe("anthropic/old");
  });

  test("cooldowns are deliberately not consulted: this surface reports configuration", () => {
    // A cooled-down target is still the CONFIGURED target. `effectiveChain` takes no cooldown reader, so
    // the dialog cannot drift from the file the operator is editing.
    const config = resolveConfig({ [KEY]: { enabled: true, models: [{ model: "anthropic/a" }] } }, undefined, () => {});
    expect(effectiveChain(config, ACTIVE, "manual").map(t => t.model)).toEqual(["anthropic/a"]);
    expect(describeChain([])).toBe(NOT_ROUTED);
  });
});

describe("an untouched dialog writes nothing", () => {
  test("changed() is false until a row changes", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a" }] });
    expect(draft.changed()).toBeFalse();
    draft.apply("manual", "anthropic/b");
    expect(draft.changed()).toBeTrue();
  });

  test("a row id that is not a slot is refused, so the advanced row cannot become a pick", () => {
    const draft = draftOf({ enabled: true });
    expect(draft.apply("advanced", "open editor")).toBeFalse();
    expect(draft.apply("nonsense", "x")).toBeFalse();
    expect(draft.changed()).toBeFalse();
    expect(draft.apply("manual", "a/b")).toBeTrue();
    expect(draft.apply(RESUME_ROW, "off")).toBeTrue();
  });
});

describe("the write is surgical", () => {
  test("unmodelled keys survive: cooldownHours, maxRetries and anything a later wave adds", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a" }], cooldownHours: 3, maxRetries: 5, futureKey: { nested: true } });
    draft.apply("manual", "anthropic/b");
    const value = draft.toSettingsValue();
    expect(value.cooldownHours).toBe(3);
    expect(value.maxRetries).toBe(5);
    expect(value.futureKey).toEqual({ nested: true });
  });

  test("a hand-written route keeps its match, models, reasons and position", () => {
    // The core guarantee. Only routes whose `match` is exactly "*" are rewritten.
    const operatorRoute = { match: "openai-codex/*", reasons: ["overflow"], models: [{ model: "openai/small", thinkingLevel: "low" }] };
    const draft = draftOf({ enabled: true, routes: [operatorRoute] });
    draft.apply("manual", "anthropic/b");
    const routes = draft.toSettingsValue().routes as unknown[];
    expect(routes[0]).toEqual(operatorRoute);
    // And the UI's own route is appended after it, never in front.
    expect((routes[1] as { match: string }).match).toBe(UI_ROUTE_MATCH);
  });

  test("a reason nobody touched keeps its exact configuration", () => {
    const draft = draftOf({
      enabled: true,
      routes: [{ match: UI_ROUTE_MATCH, reasons: ["manual", "threshold"], models: [{ model: "anthropic/old" }] }],
    });
    draft.apply("manual", "anthropic/new");
    const value = draft.toSettingsValue();
    expect(resolved(value, "manual")).toEqual(["anthropic/new"]);
    // `threshold` was in the same route and must come out of the rewrite unchanged.
    expect(resolved(value, "threshold")).toEqual(["anthropic/old"]);
  });

  test("a UI route with no explicit reasons covers all three, and stripping one writes the other two", () => {
    // `resolveConfig` defaults an absent `reasons` to all three, so removing one reason from such a
    // route has to name the survivors explicitly or they would be silently widened back.
    const draft = draftOf({ enabled: true, routes: [{ match: UI_ROUTE_MATCH, models: [{ model: "anthropic/old" }] }] });
    draft.apply("overflow", "anthropic/new");
    const value = draft.toSettingsValue();
    expect(resolved(value, "manual")).toEqual(["anthropic/old"]);
    expect(resolved(value, "threshold")).toEqual(["anthropic/old"]);
    expect(resolved(value, "overflow")).toEqual(["anthropic/new"]);
  });

  test("two reasons picking the same model share one route rather than duplicating it", () => {
    // Grouping keeps the file small AND keeps catch-all reason sets disjoint, which is what stops
    // `findRouteShadowing` from reporting the UI's own output as dead configuration.
    const draft = draftOf({ enabled: true });
    draft.apply("manual", "anthropic/x");
    draft.apply("threshold", "anthropic/x");
    const routes = draft.toSettingsValue().routes as Array<{ reasons: string[]; models: unknown }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]!.reasons).toEqual(["manual", "threshold"]);
  });

  test("reasons are written in canonical order, so a diff is stable", () => {
    const draft = draftOf({ enabled: true });
    draft.apply("overflow", "anthropic/x");
    draft.apply("manual", "anthropic/x");
    expect((draft.toSettingsValue().routes as Array<{ reasons: string[] }>)[0]!.reasons).toEqual(["manual", "overflow"]);
  });

  test("a route left with no reasons is dropped rather than written empty", () => {
    // An empty route is noise `resolveConfig` warns about on the next load.
    const draft = draftOf({ enabled: true, routes: [{ match: UI_ROUTE_MATCH, reasons: ["manual"], models: [{ model: "anthropic/old" }] }] });
    draft.apply("manual", "anthropic/new");
    const routes = draft.toSettingsValue().routes as Array<{ models: Array<{ model: string }> }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]!.models).toEqual([{ model: "anthropic/new" }]);
  });

  test("a UI route carrying a thinkingLevel is not merged with a bare pick of the same model", () => {
    // They are different configurations. Merging them would silently drop the thinking level.
    const draft = draftOf({ enabled: true, routes: [{ match: UI_ROUTE_MATCH, reasons: ["threshold"], models: [{ model: "anthropic/x", thinkingLevel: "high" }] }] });
    draft.apply("manual", "anthropic/x");
    const routes = draft.toSettingsValue().routes as Array<{ reasons: string[]; models: unknown }>;
    expect(routes).toHaveLength(2);
    const value = draft.toSettingsValue();
    expect(resolved(value, "threshold")).toEqual(["anthropic/x"]);
    const config = resolveConfig({ [KEY]: value }, undefined, () => {});
    expect(selectTargets(config!, ACTIVE, "threshold").fire[0]!.thinkingLevel).toBe("high");
    expect(selectTargets(config!, ACTIVE, "manual").fire[0]!.thinkingLevel).toBeUndefined();
  });

  test("a multi-target chain is not merged into, so the rest of the chain is not dropped", () => {
    // A chain is something the row surface cannot express, and it can only have come from the advanced
    // editor or a hand edit. Folding a new reason into it would silently discard every target but the
    // first, which is the fallback behaviour the operator configured it FOR.
    const draft = draftOf({
      enabled: true,
      routes: [{ match: UI_ROUTE_MATCH, reasons: ["threshold"], models: [{ model: "anthropic/x" }, { model: "openai/backup" }] }],
    });
    draft.apply("manual", "anthropic/x");
    const routes = draft.toSettingsValue().routes as Array<{ reasons: string[]; models: unknown[] }>;
    expect(routes).toHaveLength(2);
    const chain = routes.find(r => r.models.length === 2)!;
    expect(chain.reasons).toEqual(["threshold"]);
    expect(chain.models).toEqual([{ model: "anthropic/x" }, { model: "openai/backup" }]);
    // And `threshold` still falls back the way it was configured to.
    const config = resolveConfig({ [KEY]: draft.toSettingsValue() }, undefined, () => {});
    expect(selectTargets(config!, ACTIVE, "threshold").fire.map(t => t.model)).toEqual(["anthropic/x", "openai/backup"]);
  });

  test("a route naming a per-target cooldown is not merged into either", () => {
    const draft = draftOf({ enabled: true, routes: [{ match: UI_ROUTE_MATCH, reasons: ["threshold"], models: [{ model: "anthropic/x", cooldownHours: 0 }] }] });
    draft.apply("manual", "anthropic/x");
    expect((draft.toSettingsValue().routes as unknown[])).toHaveLength(2);
    const config = resolveConfig({ [KEY]: draft.toSettingsValue() }, undefined, () => {});
    expect(selectTargets(config!, ACTIVE, "threshold").fire[0]!.cooldownHours).toBe(0);
    expect(selectTargets(config!, ACTIVE, "manual").fire[0]!.cooldownHours).toBeUndefined();
  });

  test("the routes key is removed rather than written as an empty array", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a" }] });
    draft.apply(RESUME_ROW, "manual");
    expect(draft.toSettingsValue().routes).toBeUndefined();
  });
});

describe("the resume row", () => {
  test("each value maps to the reasons it means", () => {
    expect(resumeReasonsFor("off")).toEqual([]);
    expect(resumeReasonsFor("manual")).toEqual(["manual"]);
    expect(resumeReasonsFor("manual, threshold")).toEqual(["manual", "threshold"]);
  });

  test("overflow is absent from the cycle, because pi already retries it", () => {
    expect(RESUME_VALUES.some(v => v.includes("overflow"))).toBeFalse();
  });

  test("turning resume on writes enabled: true with the reasons", () => {
    const draft = draftOf({ enabled: true, models: [{ model: "anthropic/a" }] });
    draft.apply(RESUME_ROW, "manual, threshold");
    expect(draft.toSettingsValue().resume).toEqual({ enabled: true, reasons: ["manual", "threshold"] });
  });

  test("turning it off writes enabled: false rather than deleting the block", () => {
    const draft = draftOf({ enabled: true, resume: { enabled: true, reasons: ["manual"] } });
    draft.apply(RESUME_ROW, "off");
    expect(draft.toSettingsValue().resume).toEqual({ enabled: false, reasons: [] });
  });

  test("a custom resume message survives a change to which reasons fire it", () => {
    // The operator wrote that prompt. Losing it because they toggled a checkbox is the kind of quiet
    // data loss a settings UI must not have.
    const draft = draftOf({ enabled: true, resume: { enabled: true, reasons: ["manual"], message: "Keep going, carefully." } });
    draft.apply(RESUME_ROW, "manual, threshold");
    expect((draft.toSettingsValue().resume as { message: string }).message).toBe("Keep going, carefully.");
  });

  test("the row reports the configured policy", () => {
    expect(describeResume(resolveConfig({ [KEY]: { enabled: true, models: [{ model: "a/b" }], resume: { enabled: true, reasons: ["threshold", "manual"] } } }, undefined, () => {}))).toBe("manual, threshold");
    expect(describeResume(resolveConfig({ [KEY]: { enabled: true, models: [{ model: "a/b" }] } }, undefined, () => {}))).toBe("off");
    expect(describeResume(null)).toBe("off");
  });
});

describe("verifyEffective catches a write that would not take effect", () => {
  test("a normal pick verifies clean", () => {
    const draft = draftOf({ enabled: true });
    draft.apply("manual", "anthropic/x");
    expect(draft.verifyEffective(KEY)).toEqual([]);
  });

  test("a hand-written route that out-ranks the catch-all is reported, naming the route", () => {
    // The footgun this check exists for. `selectTargets` takes the FIRST matching route, so an operator's
    // `anthropic/*` route beats the `*` route the UI writes -- and without this check the dialog would
    // report success while routing silently kept using the old model.
    const draft = draftOf({
      enabled: true,
      routes: [{ match: "anthropic/*", reasons: ["manual"], models: [{ model: "anthropic/handwritten" }] }],
    });
    draft.apply("manual", "anthropic/picked");
    const problems = draft.verifyEffective(KEY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("'manual' still routes to anthropic/handwritten");
    expect(problems[0]).toContain("route 'anthropic/*' matches this model and comes first");
    expect(problems[0]).toContain("advanced JSON editor");
  });

  test("the same route does not trip verification for a reason it does not cover", () => {
    const draft = draftOf({ enabled: true, routes: [{ match: "anthropic/*", reasons: ["manual"], models: [{ model: "anthropic/handwritten" }] }] });
    draft.apply("threshold", "anthropic/picked");
    expect(draft.verifyEffective(KEY)).toEqual([]);
  });

  test("a route that does not match the active model does not trip verification", () => {
    const draft = draftOf({ enabled: true, routes: [{ match: "openai/*", reasons: ["manual"], models: [{ model: "openai/other" }] }] });
    draft.apply("manual", "anthropic/picked");
    expect(draft.verifyEffective(KEY)).toEqual([]);
  });

  test("verification runs through the REAL config and selection path, not a re-reading of intent", () => {
    // The property that makes the check worth anything: it asks `resolveConfig` + `selectTargets` -- the
    // same two functions the compaction hook uses -- so anything they would do differently shows up here.
    const draft = draftOf({ enabled: true });
    draft.apply("manual", "anthropic/x");
    draft.apply("overflow", "openai/y");
    const value = draft.toSettingsValue();
    expect(resolved(value, "manual")).toEqual(["anthropic/x"]);
    expect(resolved(value, "overflow")).toEqual(["openai/y"]);
    expect(draft.verifyEffective(KEY)).toEqual([]);
  });

  test("a pick for a model no route can serve reports the resolves-to-nothing case", () => {
    // Reachable when a foreign route matches the active model for this reason but names only models
    // `resolveConfig` throws away, so the catch-all is shadowed by a route that then contributes nothing.
    const draft = draftOf({ enabled: true, routes: [{ match: "*", reasons: ["manual", "threshold", "overflow"], models: [{ model: "anthropic/keep" }] }] });
    draft.apply("manual", "anthropic/picked");
    expect(draft.verifyEffective(KEY)).toEqual([]);
    expect(resolved(draft.toSettingsValue(), "threshold")).toEqual(["anthropic/keep"]);
  });
});
