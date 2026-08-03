/**
 * THE ONE-OWNER COLLISION FIXTURE (Magic Context `7d22306` stealList 8; verdict §5.1).
 *
 * pi-lab's own review said it lacked this assertion. Two halves, because the hazard has two shapes:
 *
 *  1. **Install-time**: exactly ONE `session_before_compact` handler on the reviewed profile. The
 *     reviewed profile is `manifests/profile.json`, which grants the `session-before-compact` slot to
 *     this package alone -- so the assertion is about what THIS extension registers, plus the refusal
 *     that fires if anything else is loaded beside it.
 *  2. **Runtime**: a `session_compact`-side detector for a committed summary we did not produce. That
 *     is the ai-memory dive's "latent override hazard", and it is the half that install-time checks
 *     structurally cannot reach, because pi 0.81.1 has no arbitration primitive and the loser of the
 *     race finds out only afterwards.
 *
 * The fake host here is NOT `test/harness.ts`'s. That one keeps `Map<string, handler>` -- one handler
 * per event, last writer wins -- which cannot represent two owners at all, so it would pass the
 * single-owner assertion by construction and prove nothing. This file uses Magic Context's
 * `createFakePi()` shape instead (`packages/pi-plugin/src/fail-closed-pi.test.ts`, read at commit
 * 7d2230612a22d28f01c38d88e2578cb0c0ffaf2c): handlers accumulate into a `Map<string, Handler[]>`, so
 * the registered SET is the thing under test.
 */

import { describe, expect, test } from "bun:test";
import { assertSingleCompactionOwner, COMPACTION_HOOK, COMPACTION_SLOT, detectForeignSummary, KNOWN_CONTENDERS } from "../src/collision.js";
import { beforeCompactEvent, compactEvent, withHost } from "./harness.js";

type Handler = (...args: unknown[]) => unknown;

/**
 * Magic Context's `createFakePi()` shape: `on()` APPENDS, so two registrations for one event are
 * visible as two.
 */
function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    pi: {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerCommand: () => {},
      addCommand: () => {},
      addTool: () => {},
      sendMessage: () => {},
      appendEntry: () => {},
    },
    handlers,
    /** Handler counts per event, the shape `assertSingleCompactionOwner` reads. */
    counts: () => new Map([...handlers].map(([event, list]) => [event, list.length])),
  };
}

/** Load the real extension factory against a multi-handler fake host. */
async function loadInto(host: ReturnType<typeof createFakePi>): Promise<void> {
  const mod = await import("../src/index.js");
  (mod.default as (pi: unknown) => void)(host.pi);
}

const TARGET = "anthropic/claude-opus-4-8";
const ROUTER_CONFIG = { enabled: true, models: [{ model: TARGET }], resume: { enabled: true, reasons: ["manual"] } };

describe("the reviewed profile has exactly one session_before_compact owner", () => {
  test("this extension registers the hook exactly ONCE", async () => {
    // The reviewed profile grants `session-before-compact` to this package
    // (manifests/profile.json:11). The install-time invariant is therefore a statement about this
    // extension's own registrations: it must claim the slot, and must not claim it twice.
    const host = createFakePi();
    await loadInto(host);
    expect(host.handlers.get(COMPACTION_HOOK)?.length).toBe(1);
    expect(assertSingleCompactionOwner(host.counts())).toBeNull();
  });

  test("a SECOND owner loaded beside us is REFUSED, not silently tolerated", async () => {
    // The whole point of the fixture. Pi runs every handler and keeps the last truthy result, so a
    // second owner is not a duplicate registration -- it decides which summary gets committed. This
    // asserts the condition is DETECTED and that the report says what an operator has to do.
    const host = createFakePi();
    await loadInto(host);
    // An MC-style unconditional canceller, the worst case: it short-circuits pi's whole dispatch loop.
    host.pi.on(COMPACTION_HOOK, () => ({ cancel: true }));

    expect(host.handlers.get(COMPACTION_HOOK)?.length).toBe(2);
    const violation = assertSingleCompactionOwner(host.counts());
    expect(violation).not.toBeNull();
    expect(violation!.count).toBe(2);
    // Names the mechanism, so the reader learns why two owners is not merely untidy.
    expect(violation!.message).toContain("cancel");
    expect(violation!.message).toContain("load order");
    expect(violation!.message).toContain("unsupported");
    // And names the contenders, so co-install with any of the four is documented at the point of failure.
    for (const contender of KNOWN_CONTENDERS) expect(violation!.message).toContain(contender.package);
  });

  test("ZERO owners is a violation too: it means this package did not load", async () => {
    // A profile with no owner looks exactly like normal operation from outside -- pi's native
    // compaction carries on -- which is precisely why it needs saying. The reviewed profile assigns
    // the slot to us; nobody holding it is a failure to load, not a configuration.
    const violation = assertSingleCompactionOwner(new Map([["session_compact", 1]]));
    expect(violation).not.toBeNull();
    expect(violation!.count).toBe(0);
    expect(violation!.message).toContain(COMPACTION_SLOT);
    expect(violation!.message).toContain("did not load");
  });

  test("the MC canceller really does win against us under pi's dispatch rule", async () => {
    // Not a test of our code: a test that the hazard is real, using pi's own documented loop
    // (`dist/core/extensions/runner.js:565-594`) -- every handler runs, the last truthy result is
    // kept, and `cancel` returns immediately. Modelled here so the fixture's premise is checkable
    // rather than asserted in a comment.
    const host = createFakePi();
    const calls: string[] = [];
    host.pi.on(COMPACTION_HOOK, () => { calls.push("ours"); return { compaction: { summary: "ours" } }; });
    host.pi.on(COMPACTION_HOOK, () => { calls.push("theirs"); return { cancel: true }; });

    let result: Record<string, unknown> | undefined;
    for (const handler of host.handlers.get(COMPACTION_HOOK)!) {
      const value = (await handler({}, {})) as Record<string, unknown> | undefined;
      if (value) { result = value; if (value.cancel) break; }
    }
    // Ours ran and produced a summary, and it was discarded anyway. That is the cost the warning names.
    expect(calls).toEqual(["ours", "theirs"]);
    expect(result).toEqual({ cancel: true });
  });
});

describe("a committed summary we did not produce is detected at session_compact", () => {
  test("fromExtension: true while we fell back is reported as another owner's summary", () => {
    const violation = detectForeignSummary({ fromExtension: true }, "fell-back");
    expect(violation).not.toBeNull();
    expect(violation!.message).toContain("ANOTHER extension");
    expect(violation!.message).toContain("fell-back");
    // Pi's entry carries `fromHook` as a boolean and no producer field, so the report must not name a
    // culprit. It names candidates and says the attribution cannot be made.
    expect(violation!.message).toContain("never which");
  });

  test("our own routed summary is NOT reported", () => {
    // We produced it and pi says an extension produced it. Those agree; warning here would fire on
    // every successful routed compaction.
    expect(detectForeignSummary({ fromExtension: true }, "routed")).toBeNull();
  });

  test("a native compaction is NOT reported", () => {
    // `fromExtension: false` is pi's own handler. Nothing was overridden.
    expect(detectForeignSummary({ fromExtension: false }, "fell-back")).toBeNull();
    expect(detectForeignSummary({ fromExtension: false }, undefined)).toBeNull();
  });

  test("a compaction our hook never resolved is NOT reported, even from an extension", () => {
    // THE FALSE-POSITIVE GUARD, and the reason the detector takes an outcome rather than a boolean.
    // When this package is disabled or unconfigured its handler returns immediately and resolves
    // nothing. Another extension owning compaction in that state is the operator's configuration, not
    // a collision -- reporting it would warn on every compaction of every host that installed us and
    // then turned us off.
    expect(detectForeignSummary({ fromExtension: true }, undefined)).toBeNull();
  });

  test("no-targets and aborted are reported: we were running and returned nothing", () => {
    // Both mean our handler resolved without producing a summary, so an extension-produced summary
    // can only have come from a second owner.
    expect(detectForeignSummary({ fromExtension: true }, "no-targets")).not.toBeNull();
    expect(detectForeignSummary({ fromExtension: true }, "aborted")).not.toBeNull();
  });

  test("END TO END through the real handlers: the override raises an operator-visible banner", async () => {
    // The unit cases above pin the predicate; this one proves the predicate is WIRED -- that the real
    // `session_compact` handler reaches it with the real route record, and that the report survives
    // pi's post-compaction chat rebuild (so it goes out as a widget, not a notify).
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      // Our route exhausts (every target unavailable), so we return nothing and record `fell-back`.
      await host.emit("session_before_compact", beforeCompactEvent());
      // Pi then commits a compaction it says an EXTENSION produced. Since it was not ours, a second
      // owner returned it after us.
      await host.emit("session_compact", compactEvent({ fromExtension: true }));

      host.ui.clearAndRebuildChat();
      const visible = host.ui.visibleText();
      expect(visible).toContain("hook collision");
      expect(visible).toContain("ANOTHER extension");
      // A separate widget key from the not-routed banner: the two facts are independent and one must
      // not overwrite the other.
      expect(host.ui.widgetKeys()).toContain("pi-compaction-router:collision");
    });
  });

  test("the banner is RETRACTED by the next compaction", async () => {
    // It names one specific compaction. Leaving it up would let it describe a later compaction that
    // did not collide.
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      expect(host.ui.visibleText()).toContain("hook collision");

      await host.emit("session_before_compact", beforeCompactEvent());
      expect(host.ui.visibleText()).not.toContain("hook collision");
    });
  });

  test("the widget stays inside pi's 10-line render cap", async () => {
    // `InteractiveMode.MAX_WIDGET_LINES` is 10 and pi DROPS the rest silently, so a message written as
    // prose for a log has to be re-flowed. A dropped tail would take the actionable half of the report.
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      const written = host.ui.widgetCalls.filter(c => c.key === "pi-compaction-router:collision" && c.content !== undefined);
      const call = written[written.length - 1];
      expect(call).toBeDefined();
      expect(call!.content!.length).toBeLessThanOrEqual(10);
      // And re-flowed rather than handed over as one long line the terminal wraps outside pi's count.
      for (const line of call!.content!) expect(line.length).toBeLessThanOrEqual(100);
    });
  });
});
