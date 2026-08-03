import { describe, expect, test } from "bun:test";
import { configToSettingsValue, globMatch, parseModelReference, parseSessionOverride, resolveConfig, WORKER_SLOT } from "../src/config.js";
// `selectTargets` moved to src/selection.ts in W2, where it returns `{fire, reasons, suppressor}`.
import { selectTargets, selectWorkerTargets } from "../src/selection.js";

const target = { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "low" as const };

describe("configuration", () => {
  test("returns null without useful configuration", () => expect(resolveConfig({}, {})).toBeNull());
  test("project false disables global configuration", () => expect(resolveConfig({ compactionRouter: { models: [target] } }, { compactionRouter: false })).toBeNull());
  test("parses defaults, routes, max thinking, and resume", () => {
    const config = resolveConfig({ compactionRouter: {
      models: [target], routes: [{ match: "openai-codex/*", models: [{ model: "openai-codex/gpt-5.4-mini", thinkingLevel: "max" }], reasons: ["threshold"] }],
      resume: { enabled: true, reasons: ["manual"] },
    } }, {});
    expect(config?.defaults).toEqual([target]);
    expect(config?.routes[0]?.models[0]?.thinkingLevel).toBe("max");
    expect(config?.resume.reasons).toEqual(["manual"]);
  });
  test("project configuration replaces route arrays", () => {
    const config = resolveConfig({ compactionRouter: { models: [target] } }, { compactionRouter: { models: [{ model: "openai/gpt" }] } });
    expect(config?.defaults).toEqual([{ model: "openai/gpt", thinkingLevel: undefined }]);
  });
  test("round-trips normalized settings through a session override", () => {
    const config = resolveConfig({ compactionRouter: { models: [target], resume: { enabled: true, reasons: ["manual"] } } }, {})!;
    const parsed = parseSessionOverride(JSON.stringify(configToSettingsValue(config)));
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) expect(parsed.config).toEqual(config);
  });
  test("accepts an explicit session disable", () => {
    expect(parseSessionOverride("false")).toEqual({ ok: true, config: null });
    expect(parseSessionOverride('{"enabled":false}')).toEqual({ ok: true, config: null });
  });
  test("rejects malformed or partially invalid session overrides", () => {
    expect(parseSessionOverride("{").ok).toBeFalse();
    expect(parseSessionOverride("[]").ok).toBeFalse();
    expect(parseSessionOverride('{"models":[{"model":"openai/gpt","thinkingLevel":"ultra"}]}').ok).toBeFalse();
    expect(parseSessionOverride("{}").ok).toBeFalse();
  });
});

describe("routing", () => {
  test("matches case-insensitive globs", () => {
    expect(globMatch("openai-codex/*", "OpenAI-Codex/gpt-5.4-mini")).toBeTrue();
    expect(globMatch("anthropic/*", "openai/gpt")).toBeFalse();
  });
  test("uses a reason-compatible route and otherwise defaults", () => {
    const config = resolveConfig({ compactionRouter: { models: [target], routes: [{ match: "openai-codex/*", reasons: ["threshold"], models: [{ model: "openai/gpt" }] }] } }, {})!;
    expect(selectTargets(config, "openai-codex/gpt-5", "threshold").fire[0]?.model).toBe("openai/gpt");
    expect(selectTargets(config, "openai-codex/gpt-5", "manual").fire[0]?.model).toBe(target.model);
  });
  test("parses provider/model while retaining model slashes", () => expect(parseModelReference("bedrock/us/model/id")).toEqual({ provider: "bedrock", modelId: "us/model/id" }));
});

/**
 * W5 added a fourth route slot and two config keys. These tests exist because both are
 * backward-compatibility claims: an operator's pre-W5 settings file must mean exactly what it meant
 * before, and the new keys must survive the session-override round trip that `configToSettingsValue`
 * feeds.
 */
describe("the worker slot and the preservation keys", () => {
  const worker = { model: "cheap/worker-8b" };

  test("a preservation section alone is enough configuration, but only when enabled", () => {
    // An operator whose whole intent is "record facts, do not route compaction" has configured something.
    expect(resolveConfig({ compactionRouter: { preservation: { enabled: true } } }, {})?.preservation.enabled).toBeTrue();
    // A disabled section is not configuration; returning a config for it would make /compaction-router
    // claim the package is active with no route anywhere.
    expect(resolveConfig({ compactionRouter: { preservation: { enabled: false } } }, {})).toBeNull();
  });

  test("every config carries a preservation object, defaulted off", () => {
    // So no call site has to guard on the field's existence -- the off default is a value, not an absence.
    const config = resolveConfig({ compactionRouter: { models: [target] } }, {})!;
    expect(config.preservation.enabled).toBeFalse();
    expect(config.workerModels).toEqual([]);
  });

  test("a pre-W5 route keeps covering exactly the three compaction reasons", () => {
    // The compatibility claim. If `reasons` defaulted to all four slots, every existing catch-all route
    // would silently start serving background observer calls the operator never configured.
    const config = resolveConfig({ compactionRouter: { routes: [{ match: "*", models: [target] }] } }, {})!;
    expect(config.routes[0]?.reasons).toEqual(["manual", "threshold", "overflow"]);
    expect(config.routes[0]?.reasons).not.toContain(WORKER_SLOT);
  });

  test("a route may opt into the worker slot explicitly", () => {
    const config = resolveConfig({ compactionRouter: { routes: [{ match: "*", models: [worker], reasons: ["worker"] }] } }, {})!;
    expect(config.routes[0]?.reasons).toEqual([WORKER_SLOT]);
    expect(selectWorkerTargets(config, "anthropic/claude-sonnet-4-5").fire).toEqual([{ model: "cheap/worker-8b", thinkingLevel: undefined, cooldownHours: undefined }]);
  });

  test("resume still refuses the worker slot, because there is no compaction to resume", () => {
    // The two vocabularies are deliberately separate: `routeSlots` accepts `worker`, `reasons` does not.
    const warnings: string[] = [];
    const config = resolveConfig({ compactionRouter: { models: [target], resume: { enabled: true, reasons: ["worker"] } } }, {}, m => warnings.push(m))!;
    expect(config.resume.reasons).toEqual(["manual", "threshold"]);
    expect(warnings.join(" ")).toContain("Invalid reasons list");
  });

  test("an invalid route slot warns and falls back rather than dropping the route", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ compactionRouter: { routes: [{ match: "*", models: [target], reasons: ["sideways"] }] } }, {}, m => warnings.push(m))!;
    expect(config.routes.length).toBe(1);
    expect(config.routes[0]?.reasons).toEqual(["manual", "threshold", "overflow"]);
    expect(warnings.join(" ")).toContain("worker");
  });

  test("workerModels take precedence over a worker-slot route", () => {
    // An explicit chain is the more specific statement of intent.
    const config = resolveConfig({ compactionRouter: {
      workerModels: [worker],
      routes: [{ match: "*", models: [{ model: "other/model" }], reasons: ["worker"] }],
    } }, {})!;
    expect(selectWorkerTargets(config, "anthropic/x").fire[0]?.model).toBe("cheap/worker-8b");
  });

  test("the compaction defaults are NEVER borrowed for the worker", () => {
    // The cost guard. Falling through to `models` would bill an operator for a frontier-model call every
    // observation window without their ever having configured a worker.
    const config = resolveConfig({ compactionRouter: { models: [target], preservation: { enabled: true } } }, {})!;
    const selection = selectWorkerTargets(config, "anthropic/claude-sonnet-4-5");
    expect(selection.fire).toEqual([]);
    expect(selection.suppressor).toBe("no-targets-configured");
    expect(selection.reasons.join(" ")).toContain("workerModels");
  });

  test("a cooled-down worker target is dropped, and an all-cooled chain says so", () => {
    const config = resolveConfig({ compactionRouter: { workerModels: [worker, { model: "warm/model" }], preservation: { enabled: true } } }, {})!;
    const cooled = { until: "2026-08-03T00:00:00.000Z", reason: "rate limited", stage: "worker/retryable" };
    const partial = selectWorkerTargets(config, "anthropic/x", { cooldownFor: t => t.model === "cheap/worker-8b" ? cooled : undefined });
    expect(partial.fire.map(t => t.model)).toEqual(["warm/model"]);
    const all = selectWorkerTargets(config, "anthropic/x", { cooldownFor: () => cooled });
    expect(all.fire).toEqual([]);
    expect(all.suppressor).toBe("all-targets-cooled-down");
  });

  test("the W5 keys round-trip through a session override", () => {
    const config = resolveConfig({ compactionRouter: {
      models: [target],
      workerModels: [worker],
      preservation: { enabled: true, observeAfterTokens: 5_000, mode: "ratio", ratio: 0.3, maxFacts: 50, observerChunkMaxTokens: 8_000, injectFold: false },
    } }, {})!;
    const parsed = parseSessionOverride(JSON.stringify(configToSettingsValue(config)));
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) expect(parsed.config).toEqual(config);
  });

  test("a disabled layer emits no preservation key, so it round-trips as absent", () => {
    // `resolveConfig` reads a disabled section as no configuration, so emitting one would not survive a
    // re-parse -- and would also rewrite an operator's file with a section they never asked for.
    const config = resolveConfig({ compactionRouter: { models: [target] } }, {})!;
    const value = configToSettingsValue(config) as Record<string, unknown>;
    expect(value.preservation).toBeUndefined();
    expect(value.workerModels).toBeUndefined();
    const parsed = parseSessionOverride(JSON.stringify(value));
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) expect(parsed.config).toEqual(config);
  });
});
