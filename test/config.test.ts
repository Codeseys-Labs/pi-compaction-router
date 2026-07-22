import { describe, expect, test } from "bun:test";
import { globMatch, parseModelReference, resolveConfig, selectTargets } from "../src/config.js";

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
});

describe("routing", () => {
  test("matches case-insensitive globs", () => {
    expect(globMatch("openai-codex/*", "OpenAI-Codex/gpt-5.4-mini")).toBeTrue();
    expect(globMatch("anthropic/*", "openai/gpt")).toBeFalse();
  });
  test("uses a reason-compatible route and otherwise defaults", () => {
    const config = resolveConfig({ compactionRouter: { models: [target], routes: [{ match: "openai-codex/*", reasons: ["threshold"], models: [{ model: "openai/gpt" }] }] } }, {})!;
    expect(selectTargets(config, "openai-codex/gpt-5", "threshold")[0]?.model).toBe("openai/gpt");
    expect(selectTargets(config, "openai-codex/gpt-5", "manual")[0]?.model).toBe(target.model);
  });
  test("parses provider/model while retaining model slashes", () => expect(parseModelReference("bedrock/us/model/id")).toEqual({ provider: "bedrock", modelId: "us/model/id" }));
});
