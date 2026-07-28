import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realPackage from "@earendil-works/pi-coding-agent";

/**
 * THE SUCCESS PATH OF THE ROUTER.
 *
 * test/handler.test.ts proved the four FAILURE paths: every target unavailable, fail-open return,
 * the operator-visible announcement, and a host with no ui. It never made the handler produce a
 * compaction, because its fake `getApiKeyAndHeaders` always returns `ok: false`. So before this
 * file, `compact()` had never been reached in a test and three claims in README.md:130-133 were
 * uncovered by anything except one live manual proof:
 *
 *   - automatic `threshold` compaction routing
 *   - automatic `overflow` compaction routing
 *   - ordered fallback after an actual provider failure
 *
 * All three are drivable with no network and no provider, because src/index.ts:33 reads
 * `event.reason` and src/config.ts:118 selects on it, and because `compact` is an ordinary module
 * import that can be replaced.
 *
 * WHAT THESE TESTS DO NOT CLAIM: they prove the HANDLER's behaviour when Pi hands it
 * `reason: "threshold"` / `"overflow"`. They do not prove that Pi's own trigger fires those
 * reasons at a real context threshold or on a real provider overflow error — that is Pi's code,
 * not this package's, and it is still unproven here. Nor do they prove a real provider failure:
 * they prove ordered fallback when the compaction call throws, which is the shape a provider
 * failure takes at this seam (src/index.ts:52).
 */

/** Which compaction call, in order, and with what. Reset per run. */
type CompactCall = {
  model: string;
  thinkingLevel: unknown;
  apiKey: unknown;
  headers: unknown;
  env: unknown;
  readFiles: string[];
  editedFiles: string[];
  customInstructions: unknown;
};

type Scenario = {
  calls: CompactCall[];
  /** Return a summary marker, or throw, keyed by "provider/modelId". */
  behaviour: (model: string) => string;
};

let scenario: Scenario | null = null;

/**
 * Replace ONLY `compact`. Everything else (SettingsManager, getAgentDir, used by src/config.ts)
 * stays real, and with no scenario installed this delegates to the real implementation — so if this
 * module mock leaks into another test file in the same bun process, that file's behaviour is
 * unchanged rather than silently faked.
 */
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...realPackage,
  compact: async (
    preparation: { fileOps: { read: Set<string>; edited: Set<string> } },
    model: { provider: string; id: string },
    apiKey: unknown,
    headers: unknown,
    customInstructions: unknown,
    _signal: unknown,
    thinkingLevel: unknown,
    _streamFn: unknown,
    env: unknown,
  ) => {
    if (!scenario) return (realPackage.compact as (...a: unknown[]) => unknown)(preparation as never, model as never, apiKey as never, headers as never, customInstructions as never, _signal as never, thinkingLevel as never, _streamFn as never, env as never);
    const ref = `${model.provider}/${model.id}`;
    scenario.calls.push({
      model: ref,
      thinkingLevel,
      apiKey,
      headers,
      env,
      readFiles: [...preparation.fileOps.read],
      editedFiles: [...preparation.fileOps.edited],
      customInstructions,
    });
    const summary = scenario.behaviour(ref); // may throw, which is the provider-failure shape
    return { summary, firstKeptEntryId: "kept-1", tokensBefore: 4321 };
  },
}));

function agentDirWith(routerConfig: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "router-agent-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compactionRouter: routerConfig }, null, 2));
  return dir;
}

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "router-project-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

type Notice = { message: string; level: string };

interface RunOptions {
  routerConfig: unknown;
  reason: "manual" | "threshold" | "overflow";
  /** "provider/modelId" -> context window, or absent to make the model unavailable. */
  registry: Record<string, number>;
  /** "provider/modelId" -> summary to return, or a thrown Error. Default: succeed. */
  behaviour?: (model: string) => string;
  /** "provider/modelId" -> false to make auth fail. Default: authenticated. */
  authOk?: (model: string) => boolean;
  branchEntries?: Array<{ type: string; details?: unknown }>;
  aborted?: boolean;
  withUi?: boolean;
  customInstructions?: string;
  messagesToSummarize?: unknown[];
}

interface RunResult {
  result: { compaction?: { summary: string; tokensBefore: number } } | undefined;
  notices: Notice[];
  warnings: string[];
  /** Compaction attempts in the order the router made them. */
  order: string[];
  calls: CompactCall[];
  /** Every model lookup, in order — including ones that never reached compact. */
  lookups: string[];
}

async function runRouter(opts: RunOptions): Promise<RunResult> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirWith(opts.routerConfig);
  const realWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(" "));
  const calls: CompactCall[] = [];
  scenario = { calls, behaviour: opts.behaviour ?? (() => "summary") };
  try {
    const mod = await import("../src/index.js");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    (mod.default as (pi: unknown) => void)({
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      addCommand: () => {},
      registerCommand: () => {},
      addTool: () => {},
      sendMessage: () => {},
    });
    const handler = handlers.get("session_before_compact");
    expect(handler).toBeDefined();

    const notices: Notice[] = [];
    const lookups: string[] = [];
    const ctx = {
      cwd: projectDir(),
      sessionManager: { getSessionId: () => `session-${opts.reason}`, getSessionFile: () => null },
      isProjectTrusted: () => false,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
      modelRegistry: {
        find: (provider: string, modelId: string) => {
          const ref = `${provider}/${modelId}`;
          lookups.push(ref);
          const contextWindow = opts.registry[ref];
          return contextWindow === undefined ? null : { provider, id: modelId, contextWindow };
        },
        getApiKeyAndHeaders: async (model: { provider: string; id: string }) => {
          const ref = `${model.provider}/${model.id}`;
          return (opts.authOk ?? (() => true))(ref)
            ? { ok: true, apiKey: `key-for-${ref}`, headers: { "x-target": ref }, env: { TARGET: ref } }
            : { ok: false, error: `no credentials for ${ref}` };
        },
      },
      ...(opts.withUi === false ? {} : { ui: { notify: (message: string, level: string) => void notices.push({ message, level }) } }),
    };
    const event = {
      reason: opts.reason,
      preparation: {
        firstKeptEntryId: "kept-1",
        messagesToSummarize: opts.messagesToSummarize ?? [{ role: "user", content: "hi" }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 4321,
        fileOps: { read: new Set<string>(), edited: new Set<string>() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 4000 },
      },
      branchEntries: opts.branchEntries ?? [],
      customInstructions: opts.customInstructions,
      signal: { aborted: opts.aborted === true },
    };

    const result = (await handler!(event, ctx)) as RunResult["result"];
    return { result, notices, warnings, order: calls.map(c => c.model), calls, lookups };
  } finally {
    scenario = null;
    console.warn = realWarn;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** One route per reason plus a distinct default, so a selected target names the reason that chose it. */
const REASON_CONFIG = {
  routes: [
    { match: "anthropic/*", reasons: ["threshold"], models: [{ model: "vendor/threshold-target", thinkingLevel: "medium" }] },
    { match: "anthropic/*", reasons: ["overflow"], models: [{ model: "vendor/overflow-target", thinkingLevel: "high" }] },
  ],
  models: [{ model: "vendor/default-target", thinkingLevel: "low" }],
};
const REASON_REGISTRY = {
  "vendor/threshold-target": 400_000,
  "vendor/overflow-target": 400_000,
  "vendor/default-target": 400_000,
};

describe("routing by compaction reason", () => {
  test("reason 'threshold' routes to the threshold route and returns its compaction", async () => {
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "threshold",
      registry: REASON_REGISTRY,
      behaviour: model => `summary-from-${model}`,
    });
    // Exactly one attempt, and it is the threshold route's target: no default leakage.
    expect(run.order).toEqual(["vendor/threshold-target"]);
    expect(run.result?.compaction?.summary).toBe("summary-from-vendor/threshold-target");
    // A returned compaction is the whole point: the handler must not fall through to fail-open.
    expect(run.notices).toEqual([]);
  });

  test("reason 'overflow' routes to the overflow route, not the threshold one", async () => {
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "overflow",
      registry: REASON_REGISTRY,
      behaviour: model => `summary-from-${model}`,
    });
    expect(run.order).toEqual(["vendor/overflow-target"]);
    expect(run.result?.compaction?.summary).toBe("summary-from-vendor/overflow-target");
  });

  test("a reason no route claims falls to the configured defaults", async () => {
    // Negative control for the two tests above: if reasons were ignored, 'manual' would have
    // matched the first route and this would name a threshold target.
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "manual",
      registry: REASON_REGISTRY,
      behaviour: model => `summary-from-${model}`,
    });
    expect(run.order).toEqual(["vendor/default-target"]);
  });

  test("the reason's own thinking level reaches compact()", async () => {
    const threshold = await runRouter({ routerConfig: REASON_CONFIG, reason: "threshold", registry: REASON_REGISTRY });
    const overflow = await runRouter({ routerConfig: REASON_CONFIG, reason: "overflow", registry: REASON_REGISTRY });
    expect(threshold.calls[0]?.thinkingLevel).toBe("medium");
    expect(overflow.calls[0]?.thinkingLevel).toBe("high");
  });

  test("each target is called with its own credentials, not the previous target's", async () => {
    const run = await runRouter({
      routerConfig: { models: [{ model: "vendor/first" }, { model: "vendor/second" }] },
      reason: "manual",
      registry: { "vendor/first": 400_000, "vendor/second": 400_000 },
      behaviour: model => {
        if (model === "vendor/first") throw new Error("provider 503");
        return "ok";
      },
    });
    expect(run.calls.map(c => [c.model, c.apiKey])).toEqual([
      ["vendor/first", "key-for-vendor/first"],
      ["vendor/second", "key-for-vendor/second"],
    ]);
    expect(run.calls.at(-1)?.env).toEqual({ TARGET: "vendor/second" });
  });
});

describe("ordered fallback after a failed compaction call", () => {
  const THREE = {
    models: [
      { model: "vendor/first" },
      { model: "vendor/second" },
      { model: "vendor/third" },
    ],
  };

  test("a throwing first target is followed by the SECOND target, in that order", async () => {
    const run = await runRouter({
      routerConfig: THREE,
      reason: "manual",
      registry: { "vendor/first": 400_000, "vendor/second": 400_000, "vendor/third": 400_000 },
      behaviour: model => {
        if (model === "vendor/first") throw new Error("provider 503 from first");
        return `summary-from-${model}`;
      },
    });
    // ORDER, not merely "something succeeded": first was tried, then second, and third never.
    expect(run.order).toEqual(["vendor/first", "vendor/second"]);
    expect(run.result?.compaction?.summary).toBe("summary-from-vendor/second");
    // The failure of the first target must be loud, and must name the target and the next step.
    expect(run.warnings.some(w => w.includes("vendor/first") && w.includes("next route target"))).toBe(true);
    expect(run.warnings.some(w => w.includes("provider 503 from first"))).toBe(true);
    // A recovered failure is not a fail-open, so it must NOT raise the fail-open notice.
    expect(run.notices).toEqual([]);
  });

  test("declaration order decides the order, so reversing the config reverses the attempts", async () => {
    // This is what makes the previous test an order assertion rather than a coincidence: the same
    // two targets in the opposite declaration order must be attempted in the opposite order.
    const run = await runRouter({
      routerConfig: { models: [{ model: "vendor/second" }, { model: "vendor/first" }] },
      reason: "manual",
      registry: { "vendor/first": 400_000, "vendor/second": 400_000 },
      behaviour: model => {
        if (model === "vendor/second") throw new Error("provider 503 from second");
        return `summary-from-${model}`;
      },
    });
    expect(run.order).toEqual(["vendor/second", "vendor/first"]);
    expect(run.result?.compaction?.summary).toBe("summary-from-vendor/first");
  });

  test("unusable targets are skipped without a compaction call, and the survivor still compacts", async () => {
    const run = await runRouter({
      routerConfig: {
        models: [
          { model: "no-slash-so-invalid" },
          { model: "vendor/unregistered" },
          { model: "vendor/unauthenticated" },
          { model: "vendor/too-small" },
          { model: "vendor/good" },
        ],
      },
      reason: "threshold",
      registry: { "vendor/unauthenticated": 400_000, "vendor/too-small": 10, "vendor/good": 400_000 },
      authOk: model => model !== "vendor/unauthenticated",
      behaviour: () => "summary-from-good",
    });
    // Only the one usable target ever reached compact(), and it is the last declared.
    expect(run.order).toEqual(["vendor/good"]);
    expect(run.result?.compaction?.summary).toBe("summary-from-good");
    // Lookup order proves the router walked the list in declaration order and did not reorder it.
    // The invalid reference never reaches the registry at all.
    expect(run.lookups).toEqual(["vendor/unregistered", "vendor/unauthenticated", "vendor/too-small", "vendor/good"]);
    // Each distinct skip reason is reported distinguishably, or an operator cannot fix it.
    expect(run.warnings.some(w => w.includes("invalid model 'no-slash-so-invalid'"))).toBe(true);
    expect(run.warnings.some(w => w.includes("unavailable model 'vendor/unregistered'"))).toBe(true);
    expect(run.warnings.some(w => w.includes("unauthenticated model 'vendor/unauthenticated'"))).toBe(true);
    expect(run.warnings.some(w => w.includes("vendor/too-small") && w.includes("context window"))).toBe(true);
  });

  test("every target throwing is a LOUD fail-open, never a silent pass-through", async () => {
    const run = await runRouter({
      routerConfig: { models: [{ model: "vendor/only" }] },
      reason: "overflow",
      registry: { "vendor/only": 400_000 },
      behaviour: () => {
        throw new Error("provider 500 from only target");
      },
    });
    // The planted violation this guards: returning a compaction that no configured model made,
    // e.g. passing the payload through as if it had succeeded.
    expect(run.order).toEqual(["vendor/only"]);
    expect(run.result).toBeUndefined();
    // Loud on the operator-visible channel...
    const notice = run.notices.at(-1);
    expect(notice?.level).toBe("warning");
    expect(notice?.message).toContain("NOT routed");
    expect(notice?.message).toContain("1 configured target");
    // ...and loud on the log, naming the real provider error so it is diagnosable.
    expect(run.warnings.some(w => w.includes("provider 500 from only target"))).toBe(true);
    expect(run.warnings.some(w => w.includes("No routed model succeeded"))).toBe(true);
  });

  test("an aborted compaction stops quietly instead of announcing a fail-open", async () => {
    // Distinct branch (src/index.ts:53): the operator cancelled, so there is nothing to warn about
    // and no next target to try. It must still return no compaction.
    const run = await runRouter({
      routerConfig: { models: [{ model: "vendor/first" }, { model: "vendor/second" }] },
      reason: "manual",
      registry: { "vendor/first": 400_000, "vendor/second": 400_000 },
      aborted: true,
      behaviour: () => {
        throw new Error("aborted mid-stream");
      },
    });
    expect(run.order).toEqual(["vendor/first"]);
    expect(run.result).toBeUndefined();
    expect(run.notices).toEqual([]);
    expect(run.warnings.some(w => w.includes("No routed model succeeded"))).toBe(false);
  });

  test("a MATCHED route's exhaustion does not fall through to the root 'models' list", async () => {
    // Pinning a behaviour that README.md:53 ("`models` at the router root is the fallback route")
    // reads as if it were the opposite. src/config.ts:103 is `route?.models ?? config.defaults`: the
    // root list is the route used when NOTHING matched, not a second chance after a matched route
    // fails. An operator expecting a cross-route fallback would be wrong, so this makes the real
    // contract executable rather than inferred from one line of prose.
    const run = await runRouter({
      routerConfig: {
        routes: [{ match: "anthropic/*", reasons: ["threshold"], models: [{ model: "vendor/route-only" }] }],
        models: [{ model: "vendor/root-default" }],
      },
      reason: "threshold",
      registry: { "vendor/route-only": 400_000, "vendor/root-default": 400_000 },
      behaviour: () => {
        throw new Error("provider 429 from the only route target");
      },
    });
    expect(run.order).toEqual(["vendor/route-only"]);
    // The root default is never even looked up, let alone called.
    expect(run.lookups).toEqual(["vendor/route-only"]);
    expect(run.result).toBeUndefined();
    expect(run.notices.at(-1)?.message).toContain("NOT routed");
  });

  test("a host with no ui still returns the routed compaction", async () => {
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "threshold",
      registry: REASON_REGISTRY,
      withUi: false,
      behaviour: () => "headless-summary",
    });
    expect(run.result?.compaction?.summary).toBe("headless-summary");
  });
});

describe("carried-forward file operations", () => {
  test("the previous compaction's file lists are restored into the routed preparation", async () => {
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "threshold",
      registry: REASON_REGISTRY,
      branchEntries: [
        { type: "compaction", details: { readFiles: ["old/read.ts"], modifiedFiles: ["old/edit.ts"] } },
        { type: "message" },
        { type: "compaction", details: { readFiles: ["newest/read.ts", 42], modifiedFiles: ["newest/edit.ts"] } },
      ],
      behaviour: () => "summary",
    });
    // The LAST compaction entry wins (src/index.ts:9 reverses before find), and a non-string
    // path in the persisted details must not reach the summarizer.
    expect(run.calls[0]?.readFiles).toEqual(["newest/read.ts"]);
    expect(run.calls[0]?.editedFiles).toEqual(["newest/edit.ts"]);
  });

  test("custom instructions reach the routed compaction call", async () => {
    const run = await runRouter({
      routerConfig: REASON_CONFIG,
      reason: "overflow",
      registry: REASON_REGISTRY,
      customInstructions: "focus on the router seam",
      behaviour: () => "summary",
    });
    expect(run.calls[0]?.customInstructions).toBe("focus on the router seam");
  });
});
