import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE FIRST TESTS OF THE HANDLER ITSELF.
 *
 * Before these, this package had 10 tests and every one covered config parsing. The
 * session_before_compact handler — the whole reason the package exists — had none, which is exactly
 * why "does the router actually FUNCTION?" stayed an open question after its registration had been
 * proven. Registration is not function.
 *
 * The case that matters most is EXHAUSTION. The handler is deliberately fail-open: if no configured
 * target can be used it returns without a compaction and Pi's native handler proceeds on the active
 * model. That is the right call, because refusing to compact would end the session. But fail-open
 * must not mean unobserved, and until now the only report was console.warn — a stream the
 * interactive TUI does not surface. So an operator could have every routed target skipped, get a
 * summary written by a model they did not choose, and see nothing at all.
 */

/** A throwaway agent dir whose global settings configure the router, so loadConfig finds real config. */
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

type Captured = { message: string; level: string };

/** Invoke the extension against a fake pi/ctx and return what the handler did. */
async function runCompactHook(opts: {
  routerConfig: unknown;
  /** null makes every target "unavailable", which is the exhaustion path. */
  findModel: unknown;
}): Promise<{ result: unknown; notices: Captured[] }> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirWith(opts.routerConfig);
  try {
    const mod = await import("../src/index.js");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      addCommand: () => {},
      registerCommand: () => {},
      addTool: () => {},
    };
    (mod.default as (pi: unknown) => void)(pi);

    const handler = handlers.get("session_before_compact");
    expect(handler).toBeDefined();

    const notices: Captured[] = [];
    const ctx = {
      cwd: projectDir(),
      // configFor() reads this first, to honour a per-session override before touching settings.
      sessionManager: { getSessionId: () => "test-session", getSessionFile: () => null },
      isProjectTrusted: () => false,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
      modelRegistry: {
        find: () => opts.findModel,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "no credentials in this test" }),
      },
      ui: { notify: (message: string, level: string) => void notices.push({ message, level }) },
    };
    const event = {
      reason: "manual",
      preparation: {
        fileOps: { read: new Set<string>(), edited: new Set<string>() },
        settings: { reserveTokens: 1000 },
        messages: [],
      },
      branchEntries: [],
      customInstructions: undefined,
      signal: { aborted: false },
    };

    const result = await handler!(event, ctx);
    return { result, notices };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

const ROUTER_CONFIG = {
  models: [
    { model: "anthropic/claude-opus-4-5", thinkingLevel: "low" },
    { model: "openai/gpt-5", thinkingLevel: "low" },
  ],
};

describe("session_before_compact handler", () => {
  test("registers a handler for the slot it claims to own", async () => {
    const { notices } = await runCompactHook({ routerConfig: ROUTER_CONFIG, findModel: null });
    // The assertion inside runCompactHook already proves registration; this keeps it named.
    expect(Array.isArray(notices)).toBe(true);
  });

  test("exhaustion is fail-open: it returns no compaction so Pi's native handler proceeds", async () => {
    const { result } = await runCompactHook({ routerConfig: ROUTER_CONFIG, findModel: null });
    // Not an exception and not a compaction: refusing to compact would end the session.
    expect(result).toBeUndefined();
  });

  test("exhaustion is ANNOUNCED on the operator-visible channel, not only to console.warn", async () => {
    const { notices } = await runCompactHook({ routerConfig: ROUTER_CONFIG, findModel: null });
    expect(notices.length).toBeGreaterThan(0);
    const notice = notices.at(-1)!;
    expect(notice.level).toBe("warning");
    // It must say the routing did NOT happen. A notice that merely says "compacting" would let an
    // operator believe their configured model wrote the summary.
    expect(notice.message).toContain("NOT routed");
    // And it must say what did happen instead, or the operator cannot reason about the summary.
    expect(notice.message).toContain("active model");
    // And it must not imply a retry will help: an unavailable target is configuration, not weather.
    expect(notice.message).toContain("configuration problem");
  });

  test("a host without a ui does not break a compaction", async () => {
    // Optional-chaining is load-bearing: a non-interactive host may expose no ui at all, and a
    // notification failure must never be the reason a session cannot compact.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirWith(ROUTER_CONFIG);
    try {
      const mod = await import("../src/index.js");
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      (mod.default as (pi: unknown) => void)({
        on: (n: string, f: (e: unknown, c: unknown) => unknown) => handlers.set(n, f),
        addCommand: () => {},
        registerCommand: () => {},
        addTool: () => {},
      });
      const ctx = {
        cwd: projectDir(),
        sessionManager: { getSessionId: () => "test-session-no-ui", getSessionFile: () => null },
        isProjectTrusted: () => false,
        model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
        modelRegistry: { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false, error: "none" }) },
        // no ui at all
      };
      const event = {
        reason: "manual",
        preparation: { fileOps: { read: new Set<string>(), edited: new Set<string>() }, settings: { reserveTokens: 1000 }, messages: [] },
        branchEntries: [],
        signal: { aborted: false },
      };
      await expect(handlers.get("session_before_compact")!(event, ctx)).resolves.toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
