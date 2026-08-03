/**
 * PERSISTED PER-TARGET COOLDOWNS, AND WHERE THEY ARE ALLOWED TO BE WRITTEN.
 *
 * This package had no memory of failure: a rate-limited target was retried on every single
 * compaction, forever. W2's retry layer makes that worse before better -- retry turns one wasted call
 * per compaction into four -- so cooldown is the other half of the same mechanism.
 *
 * **Every test in this file writes into a scratch `PI_CODING_AGENT_DIR` and never `~/.pi`.** That is
 * not hygiene, it is the correctness property: `~/.pi/agent` is the operator's live home, and a suite
 * that proved persistence by persisting into it would be corrupting real state to demonstrate a
 * feature. `agentDirGuard()` below makes the requirement mechanical -- it asserts the env var actually
 * moved off the real home before any test body runs, and the first test asserts the resolved path is
 * under the scratch dir rather than trusting that it is.
 *
 * Steal: pi-blackhole `2bf8cda`, `src/om/cooldown.ts` + the `failedInCycle` half of `src/om/runtime.ts`.
 * See `src/cooldown.ts` for the provenance header.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cooldownFilePath, CooldownStore, DEFAULT_COOLDOWN_HOURS, type CooldownMap } from "../src/cooldown.js";

let scratch: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  scratch = mkdtempSync(join(tmpdir(), "router-cooldown-"));
  process.env.PI_CODING_AGENT_DIR = scratch;
  // The guard, not a comment: if the redirect ever silently stops working, this throws here rather
  // than letting a test write a cooldown into the operator's real agent dir.
  const resolved = cooldownFilePath();
  if (!resolved.startsWith(scratch)) throw new Error(`refusing to run: cooldown path ${resolved} is not under the scratch dir ${scratch}`);
  if (resolved.startsWith(join(homedir(), ".pi"))) throw new Error(`refusing to run: cooldown path ${resolved} is inside the real ~/.pi`);
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
});

const read = (): CooldownMap => JSON.parse(readFileSync(cooldownFilePath(), "utf-8")) as CooldownMap;

describe("where cooldowns are written", () => {
  test("the file resolves under PI_CODING_AGENT_DIR, never under the real ~/.pi", () => {
    const path = cooldownFilePath();
    expect(path).toBe(join(scratch, "pi-compaction-router", "cooldown.json"));
    expect(path.startsWith(join(homedir(), ".pi"))).toBeFalse();
  });

  test("the path is re-resolved per call, so a moved agent dir is honoured", () => {
    // Not memoized on purpose: a path captured at import time would pin the first value the process
    // ever saw, which is pi-blackhole's `unified-config.ts` memo-invalidation bug in reverse.
    const other = mkdtempSync(join(tmpdir(), "router-cooldown-other-"));
    process.env.PI_CODING_AGENT_DIR = other;
    expect(cooldownFilePath().startsWith(other)).toBeTrue();
    process.env.PI_CODING_AGENT_DIR = scratch;
    expect(cooldownFilePath().startsWith(scratch)).toBeTrue();
  });

  test("recording creates the directory it needs", () => {
    new CooldownStore().record("anthropic/claude-opus-4-6", { reason: "overloaded", stage: "manual/retryable" });
    expect(existsSync(cooldownFilePath())).toBeTrue();
  });
});

describe("persistence and the {until, reason, stage} shape", () => {
  test("a recorded cooldown carries upstream's three fields", () => {
    const now = new Date("2026-08-02T12:00:00Z");
    new CooldownStore().record("anthropic/claude-opus-4-6", { reason: "429 Too Many Requests", stage: "threshold/retryable", cooldownHours: 2 }, now);
    expect(read()["anthropic/claude-opus-4-6"]).toEqual({
      until: "2026-08-02T14:00:00.000Z",
      reason: "429 Too Many Requests",
      stage: "threshold/retryable",
    });
  });

  test("it SURVIVES a new store, which is what 'persisted' means", () => {
    // A fresh CooldownStore is what the next pi process gets. If cooldowns lived only in memory this
    // is the assertion that would fail, and the gap the whole file exists to close.
    new CooldownStore().record("openai-codex/gpt-5.4-mini", { reason: "overloaded", stage: "manual/retryable" });
    expect(new CooldownStore().isActive("openai-codex/gpt-5.4-mini")).toBeTrue();
  });

  test("an unnamed duration uses the documented default", () => {
    const now = new Date("2026-08-02T12:00:00Z");
    new CooldownStore().record("a/b", { reason: "overloaded", stage: "manual/retryable" }, now);
    expect(read()["a/b"]!.until).toBe(new Date(now.getTime() + DEFAULT_COOLDOWN_HOURS * 3_600_000).toISOString());
  });

  test("a negative or non-finite duration falls back to the default rather than silently no-opping", () => {
    // `-1` would put `until` in the past and make record() a no-op with no explanation. An operator who
    // typed it gets an hour and an entry they can see.
    const store = new CooldownStore();
    const now = new Date("2026-08-02T12:00:00Z");
    store.record("a/negative", { reason: "overloaded", stage: "manual/retryable", cooldownHours: -1 }, now);
    store.record("a/nan", { reason: "overloaded", stage: "manual/retryable", cooldownHours: Number.NaN }, now);
    expect(store.isActive("a/negative", { now })).toBeTrue();
    expect(store.isActive("a/nan", { now })).toBeTrue();
  });

  test("only the cooled target is skipped; a sibling in the same chain is untouched", () => {
    const store = new CooldownStore();
    store.record("anthropic/claude-opus-4-6", { reason: "overloaded", stage: "manual/retryable" });
    expect(store.isActive("anthropic/claude-opus-4-6")).toBeTrue();
    expect(store.isActive("openai-codex/gpt-5.4-mini")).toBeFalse();
  });
});

describe("lazy expiry", () => {
  test("a cooldown whose window has passed is not active", () => {
    const store = new CooldownStore();
    const recordedAt = new Date("2026-08-02T12:00:00Z");
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 1 }, recordedAt);
    expect(store.isActive("a/b", { now: new Date("2026-08-02T12:59:00Z") })).toBeTrue();
    expect(store.isActive("a/b", { now: new Date("2026-08-02T13:00:01Z") })).toBeFalse();
  });

  test("reading an expired entry REMOVES it, so the file cannot grow without bound", () => {
    // Upstream's design, and the reason no timer or session hook is needed for correctness.
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 1 }, new Date("2026-08-02T12:00:00Z"));
    expect(Object.keys(read())).toEqual(["a/b"]);
    store.get("a/b", { now: new Date("2026-08-02T14:00:00Z") });
    expect(read()["a/b"]).toBeUndefined();
  });

  test("expiry at the exact boundary releases the target rather than holding it", () => {
    const store = new CooldownStore();
    const at = new Date("2026-08-02T12:00:00Z");
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 1 }, at);
    expect(store.isActive("a/b", { now: new Date("2026-08-02T13:00:00Z") })).toBeFalse();
  });

  test("expire() sweeps every stale entry and leaves live ones", () => {
    const store = new CooldownStore();
    const at = new Date("2026-08-02T12:00:00Z");
    store.record("a/stale", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 1 }, at);
    store.record("a/live", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 10 }, at);
    store.expire(new Date("2026-08-02T14:00:00Z"));
    expect(Object.keys(read())).toEqual(["a/live"]);
  });

  test("an unparseable `until` is swept rather than becoming an eternal cooldown", () => {
    // Upstream returns undefined for a NaN date but leaves the row. A hand-edited or half-written file
    // must not be able to hide a target forever, and it must not be able to hide it silently either.
    mkdirSync(join(scratch, "pi-compaction-router"), { recursive: true });
    writeFileSync(cooldownFilePath(), JSON.stringify({ "a/b": { until: "whenever", reason: "hand-edited", stage: "manual/retryable" } }));
    const store = new CooldownStore();
    expect(store.isActive("a/b")).toBeFalse();
    expect(read()["a/b"]).toBeUndefined();
  });
});

describe("cooldownHours: 0 is MEMORY-ONLY", () => {
  test("recording writes NOTHING to disk", () => {
    // The property: a read-only or ephemeral home must never be forced into a disk write. Asserted by
    // the file's absence, which is the only assertion that actually proves it.
    new CooldownStore().record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    expect(existsSync(cooldownFilePath())).toBeFalse();
  });

  test("but the target IS skipped for the rest of this process", () => {
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    expect(store.isActive("a/b", { cooldownHours: 0 })).toBeTrue();
  });

  test("a NEW store does not inherit it, because nothing was persisted", () => {
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    expect(new CooldownStore().isActive("a/b", { cooldownHours: 0 })).toBeFalse();
  });

  test("cooldownHours: 0 disables the PERSISTED check too, so an old entry cannot cool it", () => {
    // Upstream's early return. A target the operator marked memory-only should not be held by a row
    // written before they marked it.
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 4 });
    expect(store.isActive("a/b")).toBeTrue();
    expect(new CooldownStore().isActive("a/b", { cooldownHours: 0 })).toBeFalse();
  });

  test("0 is not confused with 'unset': unset persists, 0 does not", () => {
    // The falsy-check bug this guards: `cooldownHours || DEFAULT` would turn 0 into an hour on disk.
    const store = new CooldownStore();
    store.record("a/unset", { reason: "overloaded", stage: "manual/retryable" });
    store.record("a/zero", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    expect(Object.keys(read())).toEqual(["a/unset"]);
  });

  test("a memory-only skip is reported with a reason, not as a bare boolean", () => {
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    const entry = store.get("a/b", { cooldownHours: 0 });
    expect(entry?.stage).toBe("memory");
    expect(entry?.reason).toContain("persistence disabled");
  });

  test("clearMemory() releases memory-only skips, which is what a new session is entitled to", () => {
    const store = new CooldownStore();
    store.record("a/b", { reason: "overloaded", stage: "manual/retryable", cooldownHours: 0 });
    store.clearMemory();
    expect(store.isActive("a/b", { cooldownHours: 0 })).toBeFalse();
  });
});

describe("a corrupt or hostile cooldown file never breaks a compaction", () => {
  const writeRaw = (content: string) => {
    mkdirSync(join(scratch, "pi-compaction-router"), { recursive: true });
    writeFileSync(cooldownFilePath(), content);
  };

  test("unparseable JSON reads as no cooldowns", () => {
    writeRaw("{ not json");
    expect(new CooldownStore().isActive("a/b")).toBeFalse();
  });

  test("a JSON array reads as no cooldowns rather than indexing into it", () => {
    writeRaw('["a/b"]');
    expect(new CooldownStore().snapshot()).toEqual({});
  });

  test("an entry with no `until` is dropped rather than cooling the target forever", () => {
    writeRaw(JSON.stringify({ "a/b": { reason: "x", stage: "y" } }));
    expect(new CooldownStore().isActive("a/b")).toBeFalse();
  });

  test("an entry missing reason/stage is still usable, with the fields defaulted", () => {
    writeRaw(JSON.stringify({ "a/b": { until: "2099-01-01T00:00:00.000Z" } }));
    const entry = new CooldownStore().get("a/b");
    expect(entry?.reason).toBe("unknown");
    expect(entry?.stage).toBe("unknown");
  });

  test("a non-object entry is skipped without throwing", () => {
    writeRaw(JSON.stringify({ "a/b": "cooled", "c/d": null, "e/f": { until: "2099-01-01T00:00:00.000Z", reason: "r", stage: "s" } }));
    const store = new CooldownStore();
    expect(store.isActive("a/b")).toBeFalse();
    expect(store.isActive("e/f")).toBeTrue();
  });

  test("an unwritable agent dir does not throw: cooldowns are advisory", () => {
    // Upstream's reasoning, kept: losing a cooldown means slightly more API traffic on the next
    // compaction. A thrown write would mean a failed compaction, which is strictly worse.
    process.env.PI_CODING_AGENT_DIR = "/proc/definitely-not-writable";
    expect(() => new CooldownStore().record("a/b", { reason: "overloaded", stage: "manual/retryable" })).not.toThrow();
    process.env.PI_CODING_AGENT_DIR = scratch;
  });
});
