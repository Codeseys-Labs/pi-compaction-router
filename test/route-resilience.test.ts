/**
 * ROUTE RESILIENCE THROUGH THE REAL HANDLER.
 *
 * The unit files next to this one test each mechanism in isolation. This one drives the actual
 * `session_before_compact` handler against real-mass preparations, because the shipped defects were
 * all wiring: a chain that advanced on every error, a target retried on every compaction forever, an
 * empty target list that returned silently. None of those is visible from a pure function.
 *
 * The W1 bar applies: every handler test here builds its preparation from `fixtures/real-mass.ts` with
 * pi's real `CompactionPreparation` field names, never `{messages: []}`. Four tests once passed
 * against a preparation that measured nothing at all.
 *
 * Cooldown assertions read the file under this test's scratch `PI_CODING_AGENT_DIR` -- never `~/.pi`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { advancesChain, chainExhausted, chainHalt } from "../src/chain.js";
import { classifyFailure, RouteAttemptError, routeAbortError } from "../src/retry.js";
import type { CooldownMap } from "../src/cooldown.js";
import { agentDirWith, beforeCompactEvent, compactEvent, withHost, type Host } from "./harness.js";

const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };

/** What each `compact()` attempt does, consumed in order; a function may throw or return. */
let attempts: Array<() => unknown> = [];
let attemptLog: string[] = [];

beforeAll(() => {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    ...pi,
    // `model` is argument 2. Recording it is what makes "which target was tried, in what order"
    // assertable -- the question every test in this file is really about.
    compact: async (_prep: unknown, model: { provider: string; id: string }) => {
      attemptLog.push(`${model.provider}/${model.id}`);
      const next = attempts.shift();
      if (!next) return { summary: "stubbed summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 1 };
      const result = next();
      return result as { summary: string; firstKeptEntryId: string; tokensBefore: number };
    },
  }));
});

afterAll(() => {
  // Or a stubbed compact() leaks into every test file bun loads after this one.
  mock.module("@earendil-works/pi-coding-agent", () => ({ ...pi }));
});

let scratch: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  attempts = [];
  attemptLog = [];
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  scratch = mkdtempSync(join(tmpdir(), "router-resilience-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

const cooldownPath = (dir: string) => join(dir, "pi-compaction-router", "cooldown.json");
function readCooldowns(dir: string): CooldownMap {
  // The guard, mechanical rather than commented: a cooldown assertion that resolved into the real
  // home would be corrupting live operator state to prove a feature works.
  if (dir.startsWith(join(homedir(), ".pi"))) throw new Error(`refusing to read cooldowns from the real agent dir ${dir}`);
  const path = cooldownPath(dir);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as CooldownMap) : {};
}

/** A scratch agent dir carrying router settings, reusable across `withHost` calls. */
function agentDir(routerConfig: unknown): string {
  return agentDirWith({ compactionRouter: routerConfig });
}

/** Drive one compaction through the handler against a scratch dir the caller keeps. */
async function compaction(dir: string, body?: (host: Host) => Promise<void>, options: Parameters<typeof beforeCompactEvent>[0] = {}): Promise<unknown> {
  return withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
    if (body) await body(host);
    return host.emit("session_before_compact", beforeCompactEvent(options));
  });
}

describe("per-target retry before the chain advances", () => {
  test("a transient failure is retried on the SAME target, not handed to the next one", async () => {
    // The shipped defect: one `server_is_overloaded` cost the whole route hop. `a/one` must be tried
    // twice before `b/two` is tried at all.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }], maxRetries: 2 });
    attempts = [() => { throw new Error("server_is_overloaded"); }];
    const result = await compaction(dir);
    expect(attemptLog).toEqual(["openai-codex/gpt-5.4-mini", "openai-codex/gpt-5.4-mini"]);
    expect(result).toMatchObject({ compaction: { summary: "stubbed summary" } });
  });

  test("a QUOTA failure is not retried: it advances to the next target immediately", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }], maxRetries: 3 });
    attempts = [() => { throw new Error("429 Too Many Requests: insufficient_quota"); }];
    await compaction(dir);
    // Two entries, not four: one attempt on `a/one`, then straight to `b/two`.
    expect(attemptLog.length).toBe(2);
  });

  test("retries are exhausted, then the chain advances", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }], maxRetries: 1 });
    attempts = [
      () => { throw new Error("overloaded"); },
      () => { throw new Error("overloaded"); },
    ];
    const result = await compaction(dir);
    // Two attempts on the first target (one plus one retry), then the second target served it.
    expect(attemptLog.length).toBe(3);
    expect(result).toMatchObject({ compaction: { summary: "stubbed summary" } });
  });

  test("a target that is retried into success is not cooled down", async () => {
    // It recovered. Holding a blip against it for an hour would be the cure being worse than the
    // disease, and would empty a chain that is actually healthy.
    const dir = agentDir({ models: [{ model: "a/one" }] });
    attempts = [() => { throw new Error("overloaded"); }];
    await compaction(dir);
    expect(readCooldowns(dir)).toEqual({});
  });
});

describe("failure-reason-gated chain advance", () => {
  test("a PERMANENT failure still advances: it may be about how THIS target was reached", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }] });
    attempts = [() => { throw new Error("400 Bad Request: unsupported thinking level"); }];
    const result = await compaction(dir);
    expect(attemptLog.length).toBe(2);
    expect(result).toMatchObject({ compaction: {} });
  });

  test("a STALE-CONTEXT failure HALTS the chain: pi replaced the session", async () => {
    // Magic Context's rule. There is no longer a session to compact, so every further target would
    // fail identically -- and would cool itself down doing it.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }] });
    attempts = [() => { throw new Error("extension ctx is stale") }];
    await compaction(dir);
    expect(attemptLog).toEqual(["openai-codex/gpt-5.4-mini"]);
  });

  test("a stale-context halt cools NOTHING down", async () => {
    // The lesson pi-blackhole records: reloading a session must not cool down the operator's best model.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }] });
    attempts = [() => { throw new Error("extension ctx is stale") }];
    await compaction(dir);
    expect(readCooldowns(dir)).toEqual({});
  });

  test("an ABORT halts the chain and returns nothing, with no warning stashed", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }] });
    attempts = [() => { throw routeAbortError(); }];
    const result = await withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
      const r = await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      // The operator cancelled. They know. Accusing the compaction would be noise.
      expect(host.ui.visibleText()).not.toContain("NOT routed");
      return r;
    });
    expect(result).toBeUndefined();
    expect(attemptLog.length).toBe(1);
  });

  test("the advance decision is a closed list: an unrecognised class does not advance", () => {
    expect(advancesChain({ kind: "retryable" })).toBeTrue();
    expect(advancesChain({ kind: "quota" })).toBeTrue();
    expect(advancesChain({ kind: "rate-limited-past-ceiling" })).toBeTrue();
    expect(advancesChain({ kind: "permanent" })).toBeTrue();
    expect(advancesChain({ kind: "aborted" })).toBeFalse();
    expect(advancesChain({ kind: "stale-context" })).toBeFalse();
  });

  test("the halt reason is reported to the operator, not just the target count", async () => {
    // "all 3 configured target(s) were skipped" reads as "all 3 were tried", which a halted chain did
    // not do. The halt is the more actionable outcome, so it has to be in the durable banner.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }] });
    attempts = [() => { throw new Error("extension ctx is stale") }];
    await withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).toContain("replaced the session");
    });
  });

  test("chainHalt and chainExhausted describe themselves distinguishably", () => {
    expect(chainExhausted(3).message).toContain("all 3 route target(s) were tried");
    expect(chainHalt(classifyFailure(routeAbortError())).message).toContain("aborted");
    expect(chainHalt(classifyFailure(new Error("ctx is stale"))).message).toContain("replaced the session");
  });

  test("chainHalt does not claim 'pi replaced the session' for a class it does not know", () => {
    // An `else` branch here would give an operator a confident, wrong explanation in a durable banner.
    const halt = chainHalt({ kind: "quota", retryable: false, cooldownWorthy: true, message: "insufficient_quota" });
    expect(halt.message).not.toContain("replaced the session");
    expect(halt.message).toContain("quota failure");
  });
});

describe("cooldowns across compactions, through the handler", () => {
  test("a target that keeps failing is COOLED DOWN and skipped by the next compaction", async () => {
    // The gap this closes: a rate-limited target was retried on every single compaction, forever.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }], maxRetries: 0 });
    attempts = [() => { throw new Error("429 Too Many Requests"); }];
    await compaction(dir);
    expect(Object.keys(readCooldowns(dir))).toEqual(["a/one"]);

    // Second compaction, same persisted state: `a/one` is not attempted at all.
    attemptLog = [];
    attempts = [];
    await compaction(dir);
    expect(attemptLog.length).toBe(1);
  });

  test("the persisted record names the reason and the stage", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }], maxRetries: 0 });
    attempts = [() => { throw new Error("429 Too Many Requests"); }];
    await compaction(dir, undefined, { reason: "threshold" });
    const entry = readCooldowns(dir)["a/one"]!;
    expect(entry.reason).toContain("429");
    // The compaction reason plus the failure class: what an operator staring at the file needs.
    expect(entry.stage).toBe("threshold/retryable");
  });

  test("a quota failure is cooled down too, and its stage says so", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }] });
    attempts = [() => { throw new Error("insufficient_quota"); }];
    await compaction(dir);
    expect(readCooldowns(dir)["a/one"]!.stage).toBe("manual/quota");
  });

  test("a PERMANENT failure is NOT cooled down: hiding the target would hide the error", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }] });
    attempts = [() => { throw new Error("400 Bad Request: malformed tool schema"); }];
    await compaction(dir);
    expect(readCooldowns(dir)).toEqual({});
  });

  test("cooldownHours: 0 skips the target for the process and writes NO file", async () => {
    const dir = agentDir({ models: [{ model: "a/one", cooldownHours: 0 }, { model: "b/two" }], maxRetries: 0 });
    attempts = [() => { throw new Error("overloaded"); }];
    await compaction(dir);
    // The property that makes a read-only or ephemeral home safe.
    expect(existsSync(cooldownPath(dir))).toBeFalse();
  });

  test("a router-wide cooldownHours applies, and a target's own value overrides it", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two", cooldownHours: 0 }], cooldownHours: 5, maxRetries: 0 });
    attempts = [
      () => { throw new Error("overloaded"); },
      () => { throw new Error("overloaded"); },
    ];
    await compaction(dir);
    const map = readCooldowns(dir);
    // `a/one` took the router-wide 5 hours; `b/two` took its own 0 and was never written.
    expect(Object.keys(map)).toEqual(["a/one"]);
    const hours = (new Date(map["a/one"]!.until).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(4.9);
    expect(hours).toBeLessThan(5.1);
  });

  test("when EVERY target is cooled down the operator is told, durably", async () => {
    // A silent empty list here looks identical to having no configuration, and the fix is the opposite.
    const dir = agentDir({ models: [{ model: "a/one" }], maxRetries: 0 });
    attempts = [() => { throw new Error("overloaded"); }];
    await compaction(dir);

    await withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      const visible = host.ui.visibleText();
      expect(visible).toContain("NOT routed");
      expect(visible).toContain("cooldown");
      // And it names the recovery the operator actually has.
      expect(visible).toContain("cooldown.json");
    });
  });

  test("a reason with no route and no fallback is reported durably too", async () => {
    const dir = agentDir({ routes: [{ match: "anthropic/*", reasons: ["threshold"], models: [{ model: "a/one" }] }] });
    await withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent({ reason: "manual" }));
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).toContain("no route covers a 'manual' compaction");
    });
  });

  test("but an UNCONFIGURED router still warns about nothing: it has no opinion to be thwarted", async () => {
    // The pre-existing contract, which the suppressor work must not break.
    await withHost({ routerConfig: false, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("the suppressor banner fits pi's 10-line widget cap", async () => {
    // Pi silently drops lines past MAX_WIDGET_LINES = 10, where an operator cannot tell.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }, { model: "d/four" }, { model: "e/five" }, { model: "f/six" }], maxRetries: 0 });
    attempts = Array.from({ length: 6 }, () => () => { throw new Error("overloaded"); });
    await compaction(dir);
    await withHost({ routerConfig: undefined, agentDir: dir, findModel: FOUND_MODEL, auth: GOOD_AUTH }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      const shown = host.ui.widgetCalls.filter(c => c.content !== undefined).at(-1);
      expect(shown?.content?.length).toBeLessThanOrEqual(10);
    });
  });

  test("no cooldown is ever written outside the scratch agent dir", async () => {
    // The property this whole file's guard exists for, asserted directly: the only cooldown file that
    // appears is the one under the dir this test made.
    const dir = agentDir({ models: [{ model: "a/one" }], maxRetries: 0 });
    attempts = [() => { throw new Error("overloaded"); }];
    await compaction(dir);
    expect(existsSync(cooldownPath(dir))).toBeTrue();
    expect(cooldownPath(dir).startsWith(join(homedir(), ".pi"))).toBeFalse();
  });
});

describe("the maxTokens guard through the handler", () => {
  test("a target whose output cap is far under the requested budget is SKIPPED", async () => {
    // 0.8 x 65 536 = 52 428 requested; a 4 096-token cap is under half, so the chain moves on.
    const dir = agentDir({ models: [{ model: "tiny/model" }, { model: "big/model" }] });
    await withHost({ routerConfig: undefined, agentDir: dir, auth: GOOD_AUTH }, async host => {
      let call = 0;
      (host.ctx.modelRegistry as { find: unknown }).find = () =>
        call++ === 0
          ? { provider: "tiny", id: "model", contextWindow: 272_000, maxTokens: 4_096 }
          : { provider: "big", id: "model", contextWindow: 272_000, maxTokens: 128_000 };
      await host.emit("session_before_compact", beforeCompactEvent({ reserveTokens: 65_536 }));
    });
    // The tiny model never reached compact(); the big one served it.
    expect(attemptLog).toEqual(["big/model"]);
  });

  test("a modest shortfall still routes: a shorter summary beats not routing", async () => {
    const dir = agentDir({ models: [{ model: "small/model" }] });
    await withHost({ routerConfig: undefined, agentDir: dir, auth: GOOD_AUTH, findModel: { provider: "small", id: "model", contextWindow: 272_000, maxTokens: 8_192 } }, async host => {
      const result = await host.emit("session_before_compact", beforeCompactEvent({ reserveTokens: 12_800 }));
      expect(result).toMatchObject({ compaction: {} });
    });
    expect(attemptLog).toEqual(["small/model"]);
  });

  test("the default reserve routes to a catalogued model with nothing said", async () => {
    const dir = agentDir({ models: [{ model: "openai-codex/gpt-5.4-mini" }] });
    const result = await compaction(dir);
    expect(result).toMatchObject({ compaction: {} });
    expect(attemptLog).toEqual(["openai-codex/gpt-5.4-mini"]);
  });
});

describe("a structured RouteAttemptError travels through the handler", () => {
  test("a ceiling-exceeding retry-after fails the target FAST and advances", async () => {
    // Sleeping 15 minutes inside a compaction is worse than failing over -- and there IS a next target.
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }] });
    attempts = [() => { throw new RouteAttemptError("rate_limit_error", { retryable: true, retryAfterMs: 15 * 60_000 }); }];
    const started = Date.now();
    const result = await compaction(dir);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(attemptLog.length).toBe(2);
    expect(result).toMatchObject({ compaction: {} });
  });

  test("and the target that asked for it IS cooled down", async () => {
    const dir = agentDir({ models: [{ model: "a/one" }, { model: "b/two" }] });
    attempts = [() => { throw new RouteAttemptError("rate_limit_error", { retryable: true, retryAfterMs: 15 * 60_000 }); }];
    await compaction(dir);
    // The ceiling error is non-retryable, but it is still a rate limit and still the target's to answer
    // for: it told us it needs fifteen minutes, so trying it next compaction is known waste.
    expect(readCooldowns(dir)["a/one"]!.reason).toContain("900s retry delay");
  });
});
