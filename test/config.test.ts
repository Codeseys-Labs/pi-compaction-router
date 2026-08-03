import { describe, expect, test } from "bun:test";
import { configToSettingsValue, globMatch, parseModelReference, parseSessionOverride, resolveConfig } from "../src/config.js";
// `selectTargets` moved to src/selection.ts in W2, where it returns `{fire, reasons, suppressor}`.
import { selectTargets } from "../src/selection.js";

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
