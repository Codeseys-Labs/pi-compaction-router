/**
 * WHAT THE PICKER PROMISES, MEASURED AGAINST WHAT IT CHECKED.
 *
 * THE REPRODUCED DEFECT (fresh-user lane, 2026-08-04, real Bedrock, pane evidence in pi-lab's
 * `docs/runtime-evidence/2026-08-04-router-picker-invocability.md`). Searching `sonnet 5` in
 * `/compaction-router-config` ranked the bare `amazon-bedrock/anthropic.claude-sonnet-5` above the
 * working `us.`-prefixed form. The bare id RESOLVES in the catalogue, so `validateReference` passed and
 * the dialog reported "New compactions use it immediately" -- and the first real `/compact` threw
 * "Invocation of model ID anthropic.claude-sonnet-5 with on-demand throughput isn't supported". The
 * router then fell open to Pi's active model (`fromHook: false`) exactly as designed, and the `us.` form
 * routed (`fromHook: true`).
 *
 * WHAT IS AND IS NOT UNDER TEST HERE.
 *
 * NOT the ranking. `fuzzyFilter` is pi's own matcher, shared with pi's own `/model` picker, and
 * `test/model-picker.test.ts` already pins its subsequence behaviour as inherited substrate. Forking it
 * would give this package a different search from the rest of the editor, which is a worse outcome than
 * a shared quirk.
 *
 * NOT an invocability probe. One paid async call per candidate, inside a dialog that must never hang the
 * editor -- the same three reasons `getApiKeyAndHeaders` and the fit check live on the compaction path.
 *
 * WHAT IS: the CLAIM, and the one invocability fact this package already owns. The success notice now
 * states the boundary of the check that passed and names the `us.`/`global.` remedy; a target with a
 * RECORDED failure is called out at selection time from a Map read of calls already made. The third
 * file under test is the carry-forward, which covers the operator who was not at the terminal when a
 * fallback happened.
 */

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { carryFor, clearDegradation, peekDegradation, recordDegradation } from "../src/degradation-notice.js";
import {
  describeHealth,
  filterModels,
  healthNotice,
  modelItems,
  resolutionNotice,
  validateReference,
  type HealthLookup,
  type PickableHealth,
  type PickableModel,
  type PickableRegistry,
} from "../src/model-picker.js";
import { ProviderModelPicker } from "../src/settings-ui.js";
import { SETTINGS_KEY } from "../src/settings-store.js";
import { agentDirWith, beforeCompactEvent, compactEvent, KEYS, withHost, type DrivableComponent, type HostOptions } from "./harness.js";

/**
 * The reproduced pair, as the catalogue really carries it: both ids present, only one invocable.
 *
 * The bare id is first in catalogue order deliberately -- `modelsForProvider` preserves that order, so a
 * test driving Enter on the first row picks the non-invocable one, which is the defect's own path.
 */
const BEDROCK_PAIR: PickableModel[] = [
  { id: "anthropic.claude-sonnet-5", provider: "amazon-bedrock", name: "Sonnet 5", contextWindow: 1_000_000, reasoning: true },
  { id: "us.anthropic.claude-sonnet-5", provider: "amazon-bedrock", name: "Sonnet 5 (US)", contextWindow: 1_000_000, reasoning: true },
];

/** The provider's own refusal, as the route loop records it after `classifyFailure`. */
const ON_DEMAND_REFUSAL =
  "permanent: Summarization failed: Validation error: Invocation of model ID anthropic.claude-sonnet-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.";

function health(status: PickableHealth["status"], overrides: Partial<PickableHealth> = {}): PickableHealth {
  return { status, lastFailure: null, lastErrorMessage: null, consecutiveFailures: 0, ...overrides };
}

const SELECT_THEME = { selectedPrefix: (t: string) => t, selectedText: (t: string) => t, description: (t: string) => t, scrollInfo: (t: string) => t, noMatch: (t: string) => t };

function registry(models: PickableModel[] = BEDROCK_PAIR): PickableRegistry {
  return {
    getAvailable: () => models,
    getProviderDisplayName: () => "Amazon Bedrock",
    getProviderAuthStatus: () => ({ configured: true, label: "AWS_BEARER_TOKEN_BEDROCK" }),
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
  };
}

describe("the defect's precondition is real, and this fix does not pretend to remove it", () => {
  test("the non-invocable id is what a 'sonnet 5' search ranks first, and it RESOLVES", () => {
    // Both halves matter. The first is why the operator picks it; the second is why every check the
    // dialog had said yes. If a future change made `validateReference` refuse it, this test failing is
    // the signal that the notice wording below has become over-cautious and can be revisited.
    const ranked = filterModels(BEDROCK_PAIR, "sonnet 5", fuzzyFilter);
    expect(ranked[0]!.id).toBe("anthropic.claude-sonnet-5");
    expect(validateReference(registry(), "amazon-bedrock/anthropic.claude-sonnet-5")).toEqual({ ok: true });
  });

  test("the matcher is NOT forked: ranking is still pi's own, quirk included", () => {
    // The wave's explicit instruction, asserted so a later 'fix' to the ranking has to argue with a test
    // rather than with a comment. `filterModels` delegates entirely; passing an identity 'matcher' proves
    // it adds no ordering of its own.
    const identity = <T,>(items: T[]) => items;
    expect(filterModels(BEDROCK_PAIR, "sonnet 5", identity)).toEqual(BEDROCK_PAIR);
  });
});

describe("the success notice states what was checked and what was not", () => {
  test("it names the check's scope, the moment of discovery, and the remedy", () => {
    const notice = resolutionNotice();
    // The scope of the check that just passed -- resolution, not invocability.
    expect(notice).toContain("resolve in the catalogue");
    expect(notice).toContain("Not checked");
    // WHEN the operator will learn otherwise, so a later fail-open banner is expected rather than a
    // mystery -- and that nothing is lost when it happens.
    expect(notice).toContain("first real compaction");
    expect(notice).toContain("fails open");
    // The remedy, which is what makes this instructions rather than a disclaimer. All three prefixes,
    // because the reproduced case was `us.` and the next one may not be.
    expect(notice).toContain("us./global./eu.");
  });

  test("it does not claim the route WORKS, which is the sentence the defect turned into a lie", () => {
    const notice = resolutionNotice();
    expect(notice).not.toMatch(/will work|is working|verified|confirmed working/i);
  });

  test("a clean write still tells the operator no restart is needed, and adds the boundary", () => {
    // The setting-scoped claim is TRUE and is kept: `configFor` re-reads settings per compaction. What is
    // added is the sentence that stops it being read as a claim about the route.
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "amazon-bedrock/us.anthropic.claude-sonnet-5" }] } });
    return withHost(bedrockHost({ agentDir }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.message).toContain("New compactions use it immediately.");
      expect(notice.message).toContain("Not checked");
      expect(notice.message).toContain("us./global./eu.");
      // Still `info`: nothing is recorded against this target, so there is no fact to warn about. A
      // caveat is not a warning, and levelling it up would make every successful write look like a
      // problem.
      expect(notice.level).toBe("info");
    });
  });

  test("the boundary is stated even when the write is already being WARNED about for another reason", () => {
    // The shadowed-route arm. Two independent problems can hold at once, and the pre-existing warning
    // must not swallow the new sentence -- an operator whose pick is shadowed AND non-invocable needs
    // both, and the shadowing warning is the arm a reader is most likely to forget to extend.
    // The route must MATCH the active model to shadow anything: `bedrockHost` runs on
    // `amazon-bedrock/us.anthropic.claude-haiku-4-5`, so the glob is `amazon-bedrock/*`. An
    // `anthropic/*` route here would match nothing and the test would silently assert the clean arm.
    const agentDir = agentDirWith({
      compactionRouter: {
        enabled: true,
        routes: [{ match: "amazon-bedrock/*", reasons: ["manual"], models: [{ model: "amazon-bedrock/us.anthropic.claude-sonnet-5" }] }],
      },
    });
    return withHost(bedrockHost({ agentDir }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("warning");
      expect(notice.message).toContain("comes first");
      expect(notice.message).toContain("Not checked");
    });
  });

  test("a REFUSED write says nothing about invocability, because nothing was written", () => {
    // The notice describes a route that now exists. On the refusal path there is no route, and appending
    // a caveat about first use would be advice about a configuration the operator does not have.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true } });
    return withHost(bedrockHost({ agentDir }), async host => {
      host.ui.driveCustom = component => {
        for (const key of PICK_FIRST_MODEL) component.handleInput?.(key);
        (host.ctx.modelRegistry as { find: unknown }).find = () => undefined;
        component.handleInput?.(KEYS.escape);
      };
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("Nothing was written");
      expect(notice.message).not.toContain("Not checked");
    });
  });

  test("an UNCHANGED dialog says nothing either", () => {
    return withHost(bedrockHost(), async host => {
      host.ui.driveCustom = drive(KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(host.ui.notices.at(-1)!.message).toBe("Compaction router configuration unchanged.");
    });
  });
});

describe("a RECORDED failure is reported at selection time, from calls already made", () => {
  test("describeHealth distinguishes three states, and says nothing about the unobserved one", () => {
    // Silence is not a health claim. 113 of 114 rows carry no record on a fresh session, and rendering
    // "unknown" on all of them would train an operator to ignore the column that matters -- as well as
    // reading as a verdict when it is an absence.
    expect(describeHealth(undefined)).toBeUndefined();
    expect(describeHealth(health("unknown"))).toBeUndefined();
    expect(describeHealth(health("ok"))).toBe("last call ok");
    expect(describeHealth(health("error", { lastFailure: "call-failed" }))).toBe("LAST CALL FAILED (call-failed)");
  });

  test("a repeated failure carries its count; a single one does not say x1", () => {
    expect(describeHealth(health("error", { lastFailure: "call-failed", consecutiveFailures: 3 }))).toBe("LAST CALL FAILED (call-failed x3)");
    expect(describeHealth(health("error", { lastFailure: "unauthenticated", consecutiveFailures: 1 }))).toBe("LAST CALL FAILED (unauthenticated)");
  });

  test("a failure with no recorded class still renders, rather than printing 'null'", () => {
    expect(describeHealth(health("error"))).toBe("LAST CALL FAILED (unknown)");
  });

  test("the failing target is marked ON ITS OWN ROW in the model list, before it is picked", () => {
    // The reproduced case on the SECOND configuration: the bare id has failed once, so re-picking it in
    // the dialog is now visibly different from picking the `us.` form beside it.
    const lookup: HealthLookup = target =>
      target === "amazon-bedrock/anthropic.claude-sonnet-5" ? health("error", { lastFailure: "call-failed" }) : undefined;
    const items = modelItems(BEDROCK_PAIR, lookup);
    expect(items[0]!.description).toBe("1.0M ctx · reasoning · LAST CALL FAILED (call-failed)");
    // And the working form is NOT decorated, because nothing is recorded against it. The contrast is the
    // signal; marking both would erase it.
    expect(items[1]!.description).toBe("1.0M ctx · reasoning");
  });

  test("fit facts keep the leading position, and a row with no record is byte-identical to before", () => {
    // `contextWindow` is what the fit guard skips a target on, so it must not be pushed behind a health
    // fragment. And a fresh session must render exactly as it did pre-fix -- otherwise this change would
    // be a redesign of every row in service of one.
    expect(modelItems(BEDROCK_PAIR, () => undefined)).toEqual(modelItems(BEDROCK_PAIR));
    expect(modelItems(BEDROCK_PAIR, () => health("unknown"))).toEqual(modelItems(BEDROCK_PAIR));
  });

  test("the live picker renders the mark, so the wiring is proven and not just the formatter", () => {
    // Driven through the real component: Enter takes the provider, and the model list is what an operator
    // reads. A formatter test alone would pass with `health` never threaded through.
    const picker = new ProviderModelPicker(
      registry(),
      SELECT_THEME,
      () => {},
      () => {},
      target => (target === "amazon-bedrock/anthropic.claude-sonnet-5" ? health("error", { lastFailure: "call-failed" }) : health("ok")),
    );
    picker.handleInput(KEYS.enter);
    const shown = picker.render(120).join("\n");
    expect(shown).toContain("LAST CALL FAILED (call-failed)");
    expect(shown).toContain("last call ok");
  });

  test("healthNotice warns rather than refusing, and quotes the provider's own words", () => {
    // A warning, not a refusal: a recorded failure can be stale (a restored credential, an ended
    // outage), and refusing on a memory would make a transient failure permanently unpickable without a
    // restart. The provider's sentence is what tells an operator this is a coordinate problem.
    const notice = healthNotice(["amazon-bedrock/anthropic.claude-sonnet-5"], () =>
      health("error", { lastFailure: "call-failed", lastErrorMessage: ON_DEMAND_REFUSAL, consecutiveFailures: 1 }),
    )!;
    expect(notice).toContain("already made");
    expect(notice).toContain("FAILED");
    expect(notice).toContain("on-demand throughput isn't supported");
    expect(notice).toContain("The pick was written");
    expect(notice).toMatch(/stale/);
  });

  test("healthNotice is silent for ok, unknown and unrecorded targets", () => {
    const picks = ["amazon-bedrock/us.anthropic.claude-sonnet-5"];
    expect(healthNotice(picks, () => undefined)).toBeUndefined();
    expect(healthNotice(picks, () => health("ok"))).toBeUndefined();
    expect(healthNotice(picks, () => health("unknown"))).toBeUndefined();
    expect(healthNotice([], () => health("error", { lastFailure: "call-failed" }))).toBeUndefined();
  });

  test("two failing picks are both named, so a chain-wide problem is not reported as one target's", () => {
    const notice = healthNotice(["a/one", "b/two"], () => health("error", { lastFailure: "unauthenticated", consecutiveFailures: 2 }))!;
    expect(notice).toContain("'a/one'");
    expect(notice).toContain("'b/two'");
    expect(notice).toContain("x2");
  });

  test("END TO END: a failed call, then re-picking the same target, warns at write time", async () => {
    // The whole point, driven through the real handler: the route loop records the failure from a call it
    // already made, and the dialog then reads that record. No probe, no extra call -- the ONLY input is
    // the compaction that already happened.
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "amazon-bedrock/anthropic.claude-sonnet-5" }] } });
    await withHost(
      {
        ...bedrockHost({ agentDir }),
        // `find` resolves (the catalogue lists it) but auth refuses, which is the cheapest way to reach
        // `health.recordFailure` through the real loop without stubbing `compact`.
        auth: { ok: false, error: "no credentials in this test" },
      },
      async host => {
        // One real compaction attempt: the target is skipped and the failure is recorded.
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.runCommand("compaction-router");
        expect(host.ui.notices.at(-1)!.message).toContain("amazon-bedrock/anthropic.claude-sonnet-5: error");

        // Now the operator re-opens the dialog and picks the same target again.
        host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
        await host.runCommand("compaction-router-config");
        const notice = host.ui.notices.at(-1)!;
        expect(notice.level).toBe("warning");
        expect(notice.message).toContain("FAILED");
        expect(notice.message).toContain("unauthenticated");
        // The write STILL happened -- the operator's intent is recorded and the warning explains the risk.
        expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))[SETTINGS_KEY].routes).toBeDefined();
      },
    );
  });
});

describe("a degradation nobody was present for is mentioned once on the next compaction", () => {
  const SESSION = "degradation-test";

  test("carryFor returns nothing when nothing degraded", () => {
    clearDegradation(SESSION);
    expect(carryFor(SESSION, false)).toBeUndefined();
  });

  test("a recorded fallback produces one notice naming the target and the cause", () => {
    recordDegradation(SESSION, { targets: ["amazon-bedrock/anthropic.claude-sonnet-5"], cause: "all 1 route target(s) were tried and none served the compaction" });
    const lines = carryFor(SESSION, false)!;
    const text = lines.join(" ");
    expect(text).toContain("EARLIER compaction");
    expect(text).toContain("amazon-bedrock/anthropic.claude-sonnet-5");
    expect(text).toContain("none served the compaction");
    // Where the durable record is, so the notice is a pointer rather than the whole story.
    expect(text).toContain("/compaction-router");
    // Widget-shaped: pi renders at most 10 lines and silently drops the rest.
    expect(lines.length).toBeLessThanOrEqual(10);
    clearDegradation(SESSION);
  });

  test("it is SUPPRESSED when this compaction also degraded, because the live banner says it", () => {
    // The anti-nag rule. A persistent fault raises its own banner every time; adding a carry line on top
    // would be two notices for one fact, which is how an operator learns to dismiss both unread.
    recordDegradation(SESSION, { targets: ["a/one"], cause: "chain exhausted" });
    expect(carryFor(SESSION, true)).toBeUndefined();
    // And the record SURVIVES a suppressed read, so it is not lost by being suppressed -- the caller
    // replaces it with the newer fallback instead.
    expect(peekDegradation(SESSION)).toBeDefined();
    clearDegradation(SESSION);
  });

  test("multiple targets are all named", () => {
    recordDegradation(SESSION, { targets: ["a/one", "b/two"], cause: "chain exhausted" });
    expect(carryFor(SESSION, false)!.join(" ")).toContain("'a/one', 'b/two'");
    clearDegradation(SESSION);
  });

  test("a newer fallback replaces an older record rather than queueing behind it", () => {
    recordDegradation(SESSION, { targets: ["old/target"], cause: "first" });
    recordDegradation(SESSION, { targets: ["new/target"], cause: "second" });
    const text = carryFor(SESSION, false)!.join(" ");
    expect(text).toContain("new/target");
    expect(text).not.toContain("old/target");
    clearDegradation(SESSION);
  });

  test("state is per session, so one session's degradation is never reported against another's", () => {
    recordDegradation("session-a", { targets: ["a/one"], cause: "chain exhausted" });
    expect(carryFor("session-b", false)).toBeUndefined();
    clearDegradation("session-a");
  });

  test("END TO END: fall back, then a routed compaction shows the carry line ONCE", async () => {
    // Through the real handlers, and after `clearAndRebuildChat()` -- the step that destroys a notify and
    // spares a widget. A test that skipped it would pass against a notify-based implementation that no
    // operator could read.
    //
    // Compaction 2 must REALLY route, not merely be reported as routed: passing `fromExtension: true`
    // while our own hook fell back is a hook COLLISION, and the first draft of this test did exactly
    // that and asserted the collision banner by accident. So the target resolves and authenticates here,
    // and `compact` is the module mock this suite shares with `route-resilience.test.ts`.
    await withRoutedCompact(async () => {
      const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: FOUND_REFERENCE }] } });
      await withHost({ routerConfig: undefined, agentDir, findModel: null, sessionId: "carry-e2e" }, async host => {
        // Compaction 1: nothing resolves, so it falls back. The live banner appears.
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        host.ui.clearAndRebuildChat();
        expect(host.ui.visibleText()).toContain("NOT routed");
      });

      // Compactions 2 and 3 route for real: same scratch agent dir, same session id, a registry that now
      // resolves and authenticates the target. `withHost` is per-call, and the carry record is
      // process-scoped and keyed by session id -- which is what carries the fact across the boundary.
      await withHost({ routerConfig: undefined, agentDir, findModel: FOUND_MODEL, auth: GOOD_AUTH, sessionId: "carry-e2e" }, async host => {
        // The banner for compaction 1 is retracted here -- exactly the moment the fact used to vanish.
        const routed = await host.emit("session_before_compact", beforeCompactEvent());
        expect(routed).toHaveProperty("compaction");
        expect(host.ui.visibleText()).not.toContain("NOT routed");
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
        host.ui.clearAndRebuildChat();
        const visible = host.ui.visibleText();
        expect(visible).toContain("EARLIER compaction");
        expect(visible).toContain(FOUND_REFERENCE);
        // Its own key, so it can never overwrite the not-routed or collision banner.
        expect(host.ui.widgetKeys()).toContain("pi-compaction-router:degraded-earlier");

        // Compaction 3 also routes: the fact has been told, and is not told again.
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
        host.ui.clearAndRebuildChat();
        expect(host.ui.visibleText()).not.toContain("EARLIER compaction");
      });
    });
  });

  test("END TO END: a session that only ever falls back never shows a carry line", async () => {
    await withHost({ routerConfig: { enabled: true, models: [{ model: "a/one" }] }, findModel: null, sessionId: "persistent-fault" }, async host => {
      for (let i = 0; i < 3; i++) {
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        host.ui.clearAndRebuildChat();
      }
      // Every one of the three raised its own live banner; none of them was also told as history.
      expect(host.ui.visibleText()).toContain("NOT routed");
      expect(host.ui.visibleText()).not.toContain("EARLIER compaction");
      expect(host.ui.widgetKeys()).not.toContain("pi-compaction-router:degraded-earlier");
    });
  });

  test("a stash dropped as STALE also drops the carry, so a withdrawn accusation is not repeated", async () => {
    // The interaction the two mechanisms create, and the reason `clearDegradation` is called on the
    // stale-stash branch. Our hook falls back (nothing resolves) but pi reports `fromExtension: true` --
    // another owner's summary was committed. The stash is dropped as stale, and the carry record asserts
    // the very thing the stash just failed to prove. Carrying it forward would re-make, one compaction
    // later, a claim withdrawn here.
    await withHost({ routerConfig: { enabled: true, models: [{ model: "a/one" }] }, findModel: null, sessionId: "stale" }, async host => {
      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("NOT routed");
      // The record is gone at the source, not merely unrendered -- which is what stops the next
      // compaction, whatever it does, from finding it.
      expect(peekDegradation("stale")).toBeUndefined();

      await host.emit("session_before_compact", beforeCompactEvent());
      await host.emit("session_compact", compactEvent({ fromExtension: true }));
      host.ui.clearAndRebuildChat();
      expect(host.ui.visibleText()).not.toContain("EARLIER compaction");
    });
  });
});

describe("nothing added here probes a provider", () => {
  test("the notice and the row marks read the registry no more than the unfixed picker did", () => {
    // The passivity rule this package holds to (`src/provider-health.ts`): a status is a memory of a call
    // already made, never an answer to a question we asked. A booby-trapped registry proves the new code
    // reaches no paid door -- `getApiKeyAndHeaders` is not even on `PickableRegistry`, and `refresh` hung
    // two probe runs past 120 s when the original research measured it.
    const calls: string[] = [];
    const trapped = {
      getAvailable: () => { calls.push("getAvailable"); return BEDROCK_PAIR; },
      getProviderDisplayName: () => "Amazon Bedrock",
      getProviderAuthStatus: () => ({ configured: true }),
      find: () => { calls.push("find"); return BEDROCK_PAIR[0]; },
      getApiKeyAndHeaders: () => { throw new Error("a settings dialog must never authenticate a model"); },
      refresh: () => { throw new Error("refresh() is a network reload and hangs the UI path"); },
    } as unknown as PickableRegistry;

    const picker = new ProviderModelPicker(trapped, SELECT_THEME, () => {}, () => {}, () => health("error", { lastFailure: "call-failed" }));
    picker.handleInput(KEYS.enter);
    picker.render(120);
    healthNotice(["amazon-bedrock/anthropic.claude-sonnet-5"], () => health("error", { lastFailure: "call-failed" }));
    resolutionNotice();
    expect(new Set(calls)).toEqual(new Set(["getAvailable"]));
  });
});

// ── shared drivers ────────────────────────────────────────────────────────────────────────────────

const drive = (...keys: string[]) => (component: DrivableComponent) => { for (const key of keys) component.handleInput?.(key); };
/** Enter opens providers, Enter takes the only provider, Enter takes the FIRST model -- the bare id. */
const PICK_FIRST_MODEL = [KEYS.enter, KEYS.enter, KEYS.enter];

/** A target that resolves, authenticates and summarizes -- i.e. a compaction that really routes. */
const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const FOUND_REFERENCE = `${FOUND_MODEL.provider}/${FOUND_MODEL.id}`;
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };

/**
 * Run `body` with `compact()` stubbed to succeed, then put the real module back.
 *
 * Scoped to one test rather than installed in a `beforeAll`, because a stubbed `compact` leaks into
 * every file bun loads after this one -- `route-resilience.test.ts` learned that and restores in an
 * `afterAll` for the same reason. Only the carry-forward end-to-end test needs a compaction that really
 * routes; everything else in this file is either pure or deliberately about the failing path.
 */
async function withRoutedCompact(body: () => Promise<void>): Promise<void> {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    ...pi,
    compact: async () => ({ summary: "stubbed summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 1 }),
  }));
  try {
    await body();
  } finally {
    mock.module("@earendil-works/pi-coding-agent", () => ({ ...pi }));
  }
}

function bedrockHost(overrides: Partial<HostOptions> = {}): HostOptions {
  return {
    routerConfig: { enabled: true, models: [{ model: "amazon-bedrock/us.anthropic.claude-sonnet-5" }] },
    availableModels: BEDROCK_PAIR,
    model: { provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-4-5", contextWindow: 200_000 },
    ...overrides,
  };
}
