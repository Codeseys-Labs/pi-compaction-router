/**
 * THE FAIL-OPEN WARNING MUST SURVIVE THE COMPACTION IT DESCRIBES.
 *
 * The router is deliberately fail-open: if no configured target can be used, it returns no
 * compaction and pi's native handler proceeds on the active model, because refusing to compact would
 * end the session. But fail-open must not mean unobserved -- the operator's summary was written by a
 * model they did not choose, and that is the one outcome they cannot infer from anything else.
 *
 * `ctx.ui.notify` was that report and it never worked. Verified on our pinned 0.81.1: notify is a
 * `chatContainer` child (`interactive-mode.js:3185-3189`), and `compaction_end` with a result runs
 * `chatContainer.clear()` then `rebuildChatFromMessages()` (`interactive-mode.js:2481-2485`), strictly
 * after `session_before_compact` returns (`agent-session.js:1390`, `1434`, `1457`). The warning was
 * destroyed on the success path, every time, before anyone could read it. `ui.setWidget` writes to
 * `extensionWidgetsAbove`/`Below`, containers the rebuild does not touch
 * (`interactive-mode.js:1455-1470`).
 *
 * So every test here runs `clearAndRebuildChat()` -- the destruction step -- and then asserts on what
 * an operator can still read. A test that skipped that step would have passed against the broken
 * code, which is exactly how this bug survived a green suite.
 */

import { describe, expect, test } from "bun:test";
import { beforeCompactEvent, compactEvent, withHost } from "./harness.js";

const WIDGET_KEY = "pi-compaction-router:not-routed";
const ROUTER_CONFIG = { models: [{ model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" }] };

describe("fail-open warning survives the post-compaction chat rebuild", () => {
  test("BASELINE: a notify raised in the before-hook is destroyed by the rebuild", async () => {
    // Not a test of our code -- a test of the harness's fidelity. If this ever passes, the harness
    // has stopped modelling pi and every other test in this file is worthless.
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      host.ui.notify("compaction was NOT routed", "warning");
      expect(host.ui.visibleText()).toContain("NOT routed");
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("the warning is READABLE after the rebuild, which is the whole point", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      // Pi commits the compaction and emits session_compact...
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      // ...then compaction_end tears the chat down and rebuilds it.
      host.ui.clearAndRebuildChat();

      const visible = host.ui.visibleText();
      expect(visible).toContain("NOT routed");
      // It must say what happened instead, or the operator cannot reason about the summary.
      expect(visible).toContain("active model");
      // And it must not imply a retry will help: an unavailable target is configuration, not weather.
      expect(visible).toContain("configuration problem");
    });
  });

  test("nothing is emitted from the before-hook, because nothing emitted there can survive", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      // The stash is held, not shown: the committed entry is not known yet.
      expect(host.ui.notices).toEqual([]);
      expect(host.ui.widgetCalls.filter(c => c.content !== undefined)).toEqual([]);
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("it is emitted as a widget under one stable key, so repeats replace rather than stack", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      for (let i = 0; i < 3; i++) {
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        host.ui.clearAndRebuildChat();
      }
      expect(host.ui.widgetKeys()).toEqual([WIDGET_KEY]);
      expect(host.ui.visibleText()).toContain("NOT routed");
    });
  });

  test("a ROUTED compaction is not accused: a stale stash is dropped against fromExtension", async () => {
    // The stash asserts "no routed target served this". Pi's own fromExtension records whether a
    // before-hook returned the compaction. If they disagree, the stash describes something that did
    // not happen, and a warning that cries wolf on a healthy compaction is worse than none.
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("the banner is RETRACTED by the next compaction, so it cannot outlive what it describes", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).toContain("NOT routed");

      // A later compaction begins. Whatever its outcome, the standing banner is about the previous
      // one; leaving it up would let a stale warning describe a compaction it did not see.
      await host.emit("session_before_compact", beforeCompactEvent());
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("a compaction that never commits leaves no stash for the next one to inherit", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      // Fails over, stash set -- but session_compact never arrives (the compaction was cancelled).
      await host.emit("session_before_compact", beforeCompactEvent());
      // The NEXT compaction routes fine, and pi commits it.
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("an aborted compaction stashes nothing: the operator cancelled it, they know", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent({ aborted: true }));
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("the warning does not fire when routing was never attempted", async () => {
    // No config means this package has no opinion, so it owes no warning. Compare: the config is
    // present but every target fails, which is the case that must warn.
    await withHost({ routerConfig: false, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("session_shutdown retracts the banner so it cannot bleed into the next session", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      expect(host.ui.visibleText()).toContain("NOT routed");
      await host.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
      expect(host.ui.visibleText()).not.toContain("NOT routed");
    });
  });

  test("the emitted widget fits pi's 10-line widget cap", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: false }));
      const shown = host.ui.widgetCalls.filter(c => c.content !== undefined).at(-1);
      // InteractiveMode.MAX_WIDGET_LINES = 10 (interactive-mode.js:1531); pi silently drops the rest,
      // so a warning longer than that would be truncated where an operator cannot tell.
      expect(shown?.content?.length).toBeLessThanOrEqual(10);
    });
  });

  test("a host with no ui at all still compacts, and still fails open", async () => {
    // Optional-chaining is load-bearing: a non-interactive host exposes no ui, and a notification
    // failure must never be the reason a session cannot compact.
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null, withoutUI: true }, async host => {
      await expect(host.emit("session_before_compact", beforeCompactEvent())).resolves.toBeUndefined();
      await expect(host.emit("session_compact", compactEvent({ fromExtension: false }))).resolves.toBeUndefined();
    });
  });

  test("a ui whose setWidget throws does not break the compaction", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      (host.ctx.ui as { setWidget: unknown }).setWidget = () => { throw new Error("hostile host"); };
      await expect(host.emit("session_before_compact", beforeCompactEvent())).resolves.toBeUndefined();
      await expect(host.emit("session_compact", compactEvent({ fromExtension: false }))).resolves.toBeUndefined();
    });
  });
});

describe("fail-open contract, unchanged by the warning fix", () => {
  test("registers a handler for both slots it claims to own", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, host => {
      expect(host.hasHandler("session_before_compact")).toBe(true);
      expect(host.hasHandler("session_compact")).toBe(true);
    });
  });

  test("exhaustion returns no compaction, so pi's native handler proceeds", async () => {
    await withHost({ routerConfig: ROUTER_CONFIG, findModel: null }, async host => {
      // Not an exception and not a compaction: refusing to compact would end the session.
      expect(await host.emit("session_before_compact", beforeCompactEvent())).toBeUndefined();
    });
  });
});
