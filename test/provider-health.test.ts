/**
 * PASSIVITY: NO PROBE CALL IS EVER MADE.
 *
 * The upstream rule, from ai-memory `e714d99` (`crates/ai-memory-llm/src/health.rs`, its own module
 * doc): "These wrappers never probe providers on their own. They only record the result of calls the
 * server was already going to make."
 *
 * That is the property this file exists to prove, and it is a property about calls NOT made, which
 * makes it a different kind of test from the rest of the suite. A test that only checked "health
 * records a failure after an auth refusal" would pass just as happily against an implementation that
 * warmed every target with a probe at session start -- the record would look identical. So these
 * tests count the calls reaching every registry method the router could possibly probe through, and
 * assert the count against what the route loop itself needed.
 *
 * Why passivity is worth a test rather than a comment: these targets are PAID endpoints, and
 * compaction fires on a hook the operator did not initiate. A probe would spend the operator's money
 * and quota to learn what the next real compaction reports for free, for targets that may never be
 * used at all. The failure this guards is not a crash; it is a silent bill.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { formatHealthRows, ProviderHealth } from "../src/provider-health.js";
import { beforeCompactEvent, compactEvent, withHost } from "./harness.js";
import { load, restore } from "./support/stub-compact.js";

afterAll(restore);

const CHAIN = { models: [{ model: "openai-codex/gpt-5.4-mini" }, { model: "anthropic/claude-haiku-4-5" }] };
const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };

/**
 * Every registry method the router touches, counted.
 *
 * `getApiKeyAndHeaders` and `compact()` are the PAID doors -- one resolves a credential, the other
 * spends tokens -- and a probe has to go through one of them to cost anything. `find` is counted
 * alongside them but is not one: it is a synchronous read of the in-memory catalogue
 * (`ModelRegistry.find` -> `ModelRuntime.getModel` -> `Models.getModel`, `pi-ai/dist/models.js:69-71`),
 * with no network and no credential. It is still counted, because an unbounded number of catalogue
 * reads would be a bug of a different kind, and because a future implementation that reached a provider
 * through it should have to change a number here to do so.
 */
interface Counts { find: number; auth: number; compact: number }

async function countRegistryCalls(
  body: (host: Awaited<ReturnType<typeof withHost<unknown>>> extends never ? never : Parameters<Parameters<typeof withHost>[1]>[0]) => Promise<void>,
  options: { routerConfig?: unknown; findModel?: unknown; auth?: unknown } = {},
): Promise<Counts> {
  const counts: Counts = { find: 0, auth: 0, compact: 0 };
  await withHost(
    {
      routerConfig: options.routerConfig ?? CHAIN,
      findModel: "findModel" in options ? options.findModel : FOUND_MODEL,
      auth: "auth" in options ? options.auth : GOOD_AUTH,
    },
    async host => {
      const registry = host.ctx.modelRegistry as { find: (...a: unknown[]) => unknown; getApiKeyAndHeaders: (...a: unknown[]) => unknown };
      const realFind = registry.find, realAuth = registry.getApiKeyAndHeaders;
      registry.find = (...args: unknown[]) => { counts.find++; return realFind(...args); };
      registry.getApiKeyAndHeaders = async (...args: unknown[]) => { counts.auth++; return await realAuth(...args); };
      await body(host);
    },
    () => load(async () => { counts.compact++; return { summary: "a summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 100 }; }),
  );
  return counts;
}

describe("provider health is passive: no probe is ever made", () => {
  test("loading the extension contacts nothing at all", async () => {
    // The strongest form of the property. Registering handlers must not warm, validate or reach any
    // target -- an extension that probed at load would bill an operator for merely installing it.
    const counts = await countRegistryCalls(async () => {});
    expect(counts).toEqual({ find: 0, auth: 0, compact: 0 });
  });

  test("EVERY registered handler and command except the compaction hook contacts nothing", async () => {
    // The exhaustive form, and the one that actually holds the line. The per-event tests below name
    // the events they drive, so they can only ever prove things about events someone remembered to
    // list -- a probe added on an event no test emits would pass all of them. This test DISCOVERS the
    // surface from the registration itself: it fires every handler and every command the extension
    // registered, and asserts that only `session_before_compact` -- the one hook whose whole job is
    // to call a provider -- ever reaches one.
    //
    // Verified to work: adding a `session_start` handler that warms each configured target with a
    // real `find` + `getApiKeyAndHeaders` pair leaves the named-event tests below green and fails
    // exactly here.
    const counts = await countRegistryCalls(async host => {
      const events: Record<string, unknown> = {
        session_start: { type: "session_start" },
        session_compact: compactEvent({ fromExtension: false }),
        session_shutdown: { type: "session_shutdown", reason: "quit" },
        session_before_fork: { type: "session_before_fork" },
        session_before_switch: { type: "session_before_switch" },
        session_info_changed: { type: "session_info_changed" },
        context: { type: "context", messages: [] },
        turn_start: { type: "turn_start" },
        turn_end: { type: "turn_end" },
        agent_start: { type: "agent_start" },
        agent_end: { type: "agent_end" },
      };
      const driven: string[] = [];
      for (const name of host.handlerNames()) {
        if (name === "session_before_compact") continue; // the one hook that legitimately routes
        // A registered handler with no fixture here would silently escape the sweep, so fail loudly.
        expect(events[name], `no event fixture for registered handler '${name}'`).toBeDefined();
        await host.emit(name, events[name]);
        driven.push(name);
      }
      // `compaction-router-config` is now IN the sweep. It used to be excluded for needing a ctx method
      // the harness did not model, and W4 both made that false (the harness models `ui.custom` and
      // `ui.editor`) and made the exclusion expensive: the settings dialog reads `getAvailable()` and
      // calls `find()` to validate, so it is now the surface most likely to acquire a probe by accident.
      // It is driven here with the operator escaping straight out -- the minimum interaction, which is
      // exactly the case where any provider contact would be unprovoked.
      //
      // `compact-resume` stays out: it calls `ctx.compact`, pi's own compaction entry point, which the
      // harness does not model and which is not the registry. It is driven where it is meaningful.
      host.ui.driveCustom = component => component.handleInput?.("\x1b");
      for (const name of host.commandNames()) {
        if (name === "compact-resume") continue;
        await host.runCommand(name);
        driven.push(name);
      }
      // The sweep must have actually swept something, or a harness change could quietly empty it.
      expect(driven.length).toBeGreaterThanOrEqual(3);
      expect(driven).toContain("session_compact");
      expect(driven).toContain("session_shutdown");
      expect(driven).toContain("compaction-router");
      expect(driven).toContain("compaction-router-config");
    });
    expect(counts).toEqual({ find: 0, auth: 0, compact: 0 });
  });

  test("session lifecycle events contact nothing", async () => {
    // session_compact writes a ledger row and session_shutdown clears state. Neither needs a
    // provider, and a health record that refreshed itself on either would be probing.
    const counts = await countRegistryCalls(async host => {
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      await host.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    });
    expect(counts).toEqual({ find: 0, auth: 0, compact: 0 });
  });

  test("the status command reads the record instead of refreshing it", async () => {
    // /compaction-router displays health. The tempting implementation refreshes what it displays;
    // that would turn a status command into two paid calls per configured target.
    const counts = await countRegistryCalls(async host => {
      await host.runCommand("compaction-router");
      expect(host.ui.notices.length).toBe(1);
    });
    expect(counts).toEqual({ find: 0, auth: 0, compact: 0 });
  });

  test("a routed compaction makes exactly the calls the route needed, and not one more", async () => {
    // One PAID call of each kind: one auth, one compact. The winning target is authenticated once and
    // asked for one summary; any extra on either counter is a probe, because the route needed none.
    //
    // `find` is 2 -- one per configured target -- and that is the fit-aware selector (G6), not a probe.
    // Cheapest-that-fits cannot order a chain without reading each candidate's window and price, so it
    // resolves every target up front instead of lazily per hop. This test is what forces that
    // distinction to be argued rather than assumed, so the argument is recorded here: `find` reaches no
    // provider at all. `ModelRegistry.find` -> `ModelRuntime.getModel` -> `Models.getModel`, which is
    // `getModels(provider).find(m => m.id === id)` over the in-memory catalogue
    // (`pi-ai/dist/models.js:69-71`) -- synchronous, no network, no credential, nothing billable. The
    // paid doors are `getApiKeyAndHeaders` and `compact()`, and those are the two held at 1 here.
    //
    // So the passivity rule is intact under its own terms ("never probe providers on their own"), and
    // the bound that matters is asserted exactly: the second target is never authenticated and never
    // asked to compact, even though it was ranked.
    const counts = await countRegistryCalls(async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
    });
    expect(counts).toEqual({ find: 2, auth: 1, compact: 1 });
  });

  test("catalogue reads are bounded at one per configured target, however long the chain", async () => {
    // The companion bound to the test above, and the one that keeps "resolve up front" from drifting
    // into "resolve repeatedly". A four-target chain costs four catalogue reads for the whole
    // compaction -- not four per hop, and not one per hop on top of the ranking pass.
    const counts = await countRegistryCalls(
      async host => {
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
      },
      { routerConfig: { models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }, { model: "d/four" }] } },
    );
    expect(counts.find).toBe(4);
    // And still exactly one paid call of each kind: the first fitting target served it.
    expect(counts.auth).toBe(1);
    expect(counts.compact).toBe(1);
  });

  test("recording a failure adds no call of its own", async () => {
    // Every target unavailable: `find` is called once per target and returns null, so `auth` and
    // `compact` are never reached. Recording two failures must not itself touch a provider -- e.g. to
    // "confirm" the target is really down.
    const counts = await countRegistryCalls(
      async host => {
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
      },
      { findModel: null },
    );
    expect(counts).toEqual({ find: 2, auth: 0, compact: 0 });
  });

  test("a second compaction re-discovers rather than pre-checking", async () => {
    // Two compactions cost exactly twice one compaction: nothing is cached across them, and nothing is
    // warmed ahead of them. A health record that pre-validated targets at the start of the second
    // compaction would show up here as extra auth calls -- the paid counter, which stays at one per
    // compaction. `find` doubles with the compactions for the same reason it is 2 above (one catalogue
    // read per configured target per compaction, unbilled), and doubling rather than growing is the
    // point: the second compaction re-reads, it does not accumulate.
    const counts = await countRegistryCalls(async host => {
      for (let i = 0; i < 2; i++) {
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
      }
    });
    expect(counts).toEqual({ find: 4, auth: 2, compact: 2 });
  });

  test("the health module itself exposes no way to reach a provider", () => {
    // Structural backstop for the counting tests above: those prove today's call sites are clean,
    // this proves the module has no door a future call site could probe through. ProviderHealth takes
    // results as arguments and never holds a provider, a registry or a fetch.
    const health = new ProviderHealth();
    // The whole method surface, pinned. A future method that took a provider, a registry or a URL
    // would have to appear in this list, so adding one is a deliberate act with a failing test
    // attached rather than a quiet extension of what "health" is allowed to do.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(health)).sort())
      .toEqual(["clear", "constructor", "recordFailure", "recordSuccess", "recordingCount", "snapshot", "snapshotAll", "stateFor"].sort());
    // State only: two plain containers, nothing callable, nothing holding a connection.
    expect(Object.keys(health).sort()).toEqual(["recordings", "states"]);
    for (const value of Object.values(health)) expect(typeof value).not.toBe("function");
  });

  test("only targets the route actually reached appear in the record", async () => {
    // The arithmetic that makes "passive" checkable from the outside: a target acquires a status only
    // by having been called. Here target 1 is unavailable and target 2 serves, while target 3 is never
    // reached because the chain stopped -- so target 3 must be ABSENT from the record. An
    // implementation that pre-checked its configuration would list all three.
    const chain = { models: [{ model: "a/one" }, { model: "b/two" }, { model: "c/three" }] };
    let status = "";
    let attempts = 0;
    const counts = await countRegistryCalls(
      async host => {
        // Only the second target resolves; the first is unavailable, the third is never asked.
        (host.ctx.modelRegistry as { find: (...a: unknown[]) => unknown }).find = () => attempts++ === 0 ? null : FOUND_MODEL;
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
        await host.runCommand("compaction-router");
        status = host.ui.notices.at(-1)!.message;
      },
      { routerConfig: chain },
    );
    expect(counts.compact).toBe(1);
    expect(status).toContain("a/one: error (unavailable)");
    expect(status).toContain("b/two: ok");
    // The load-bearing negative: configured, never called, therefore not in the record.
    expect(status).not.toContain("c/three:");
  });
});

describe("what the record says", () => {
  test("a success clears a previous error rather than leaving both", () => {
    // Upstream health.rs:167-176. A status surface showing a fresh success beside a stale error is a
    // status surface that lies about the current state.
    const health = new ProviderHealth();
    health.recordFailure("a/b", "call-failed", "boom");
    expect(health.snapshot("a/b")).toMatchObject({ status: "error", lastFailure: "call-failed", consecutiveFailures: 1 });
    health.recordSuccess("a/b");
    const after = health.snapshot("a/b");
    expect(after).toMatchObject({ status: "ok", lastFailure: null, lastErrorMessage: null, consecutiveFailures: 0 });
    expect(after.lastErrorAt).toBeNull();
    expect(after.lastSuccessAt).not.toBeNull();
  });

  test("consecutive failures accumulate, which is the deprioritisation input", () => {
    const health = new ProviderHealth();
    for (let i = 0; i < 3; i++) health.recordFailure("a/b", "unauthenticated", "nope");
    expect(health.snapshot("a/b").consecutiveFailures).toBe(3);
  });

  test("a target never called reads as unknown, not as healthy", () => {
    // The distinction upstream draws between `Unknown` and `Ok`, and the reason passivity needs it: a
    // target we have never called is not a target we know to be fine.
    expect(new ProviderHealth().snapshot("never/called")).toMatchObject({ status: "unknown", lastCallAt: null, consecutiveFailures: 0 });
  });

  test("an error message is truncated at upstream's cap", () => {
    // MAX_ERROR_MESSAGE_CHARS = 1024 (health.rs:17). A provider that returns an HTML error page must
    // not put a megabyte into a status surface.
    const health = new ProviderHealth();
    health.recordFailure("a/b", "call-failed", "x".repeat(5_000));
    const message = health.snapshot("a/b").lastErrorMessage!;
    expect(message.length).toBe(1024 + 3); // capped plus the elision marker
    expect(message.endsWith("...")).toBe(true);
  });

  test("only observed targets are rendered", () => {
    const health = new ProviderHealth();
    expect(formatHealthRows(health.snapshotAll())).toEqual([]);
    health.recordFailure("a/b", "too-small", "window");
    health.recordSuccess("c/d");
    const rows = formatHealthRows(health.snapshotAll());
    expect(rows[0]).toContain("never probed");
    expect(rows.join("\n")).toContain("a/b: error (too-small)");
    expect(rows.join("\n")).toContain("c/d: ok");
  });

  test("the rendered label states the passivity guarantee to the operator", () => {
    // The guarantee is worth surfacing where it is read: an operator seeing per-target health has
    // every reason to assume it was measured by probing, and it was not.
    const health = new ProviderHealth();
    health.recordSuccess("a/b");
    expect(formatHealthRows(health.snapshotAll())[0]).toBe("Target health (recorded from calls already made; never probed)");
  });
});
