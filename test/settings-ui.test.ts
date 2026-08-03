/**
 * The drill-down, driven headlessly by synthetic keystrokes.
 *
 * This file is the wave's headline acceptance test: a real `SettingsList` hosting a real
 * `SettingItem.submenu`, fed real key bytes, producing `changed = [["manual","anthropic/..."]]`. It
 * needs no terminal, no TUI instance and no pi session -- which is the whole reason the submenu
 * mechanism was chosen over a hand-rolled state machine.
 *
 * Themes are plain identity stylers rather than pi's. `getSettingsListTheme()` THROWS outside a live
 * TUI ("Theme not initialized. Call initTheme() first.", re-measured on this package's pinned 0.81.1),
 * so a test that imported it would fail on the import, and `src/settings-ui.ts` takes its themes as
 * arguments precisely so this file can supply substitutes. That the components accept an injected theme
 * is what makes them testable; that `src/index.ts` fetches the real one inside the `custom()` callback
 * is what keeps them correct.
 */

import { describe, expect, test } from "bun:test";
import { SettingsList, type SelectListTheme, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import { type PickableModel, type PickableRegistry } from "../src/model-picker.js";
import { buildSettingsDialog, ProviderModelPicker } from "../src/settings-ui.js";

const SETTINGS_THEME: SettingsListTheme = { label: t => t, value: t => t, description: t => t, cursor: "> ", hint: t => t };
const SELECT_THEME: SelectListTheme = { selectedPrefix: t => t, selectedText: t => t, description: t => t, scrollInfo: t => t, noMatch: t => t };

/** The real key bytes `KeybindingsManager` matches for the four navigation actions. */
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", backspace: "\x7f" };

const MODELS: PickableModel[] = [
  { id: "amazon.nova-lite-v1:0", provider: "amazon-bedrock", name: "Nova Lite", contextWindow: 300_000 },
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { id: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", contextWindow: 1_000_000, reasoning: true },
];

function registry(models: PickableModel[] = MODELS): PickableRegistry {
  return {
    getAvailable: () => models,
    getProviderDisplayName: (p: string) => ({ "amazon-bedrock": "Amazon Bedrock", anthropic: "Anthropic" })[p] ?? p,
    getProviderAuthStatus: () => ({ configured: true, label: "TEST_KEY" }),
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
  };
}

/** A `SettingsList` with reason rows whose submenu is the real picker, plus a recorder for onChange. */
function harness(models: PickableModel[] = MODELS) {
  const changed: Array<[string, string]> = [];
  let cancelled = false;
  const items: SettingItem[] = [
    {
      id: "manual",
      label: "manual",
      currentValue: "(not routed)",
      submenu: (_current, done) => new ProviderModelPicker(registry(models), SELECT_THEME, done),
    },
    { id: "threshold", label: "threshold", currentValue: "anthropic/claude-sonnet-4-5" },
  ];
  const list = new SettingsList(items, 8, SETTINGS_THEME, (id, value) => changed.push([id, value]), () => { cancelled = true; }, { enableSearch: true });
  return { list, items, changed, isCancelled: () => cancelled, render: () => list.render(70).join("\n") };
}

describe("the two-stage drill-down, headless", () => {
  test("Enter opens providers, Enter picks one, Enter picks a model: changed = [[manual, ref]]", () => {
    // The donemeans shape, at the exact `changed=[["manual","anthropic"]]` structure the research
    // measured -- with the value being the full `provider/model` reference this package actually stores.
    const h = harness();
    expect(h.render()).toContain("manual");
    expect(h.render()).toContain("(not routed)");

    h.list.handleInput(KEY.enter);            // open the submenu
    expect(h.render()).toContain("Select a provider");
    expect(h.render()).toContain("Amazon Bedrock");
    expect(h.render()).toContain("Anthropic");

    h.list.handleInput(KEY.down);             // amazon-bedrock -> anthropic
    h.list.handleInput(KEY.enter);            // choose the provider
    expect(h.render()).toContain("Select a model from Anthropic");
    expect(h.render()).toContain("Claude Sonnet 4.5");

    h.list.handleInput(KEY.enter);            // choose the first model
    expect(h.changed).toEqual([["manual", "anthropic/claude-sonnet-4-5"]]);
    // And the row now shows it: `SettingsList` sets `currentValue` from `done(value)` for us.
    expect(h.items[0]!.currentValue).toBe("anthropic/claude-sonnet-4-5");
    expect(h.render()).toContain("anthropic/claude-sonnet-4-5");
  });

  test("the model list only shows the chosen provider's models", () => {
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);   // anthropic
    h.list.handleInput(KEY.enter);
    const shown = h.render();
    expect(shown).toContain("Claude Sonnet 4.5");
    expect(shown).toContain("Claude Opus 4.8");
    expect(shown).not.toContain("Nova Lite");
  });

  test("descriptions carry contextWindow and reasoning where the operator picks", () => {
    // The fit information has to be visible AT THE MOMENT OF CHOOSING -- this is the surface where an
    // operator can see a too-small window before the compaction hook skips the target for it.
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    expect(h.render()).toContain("200k ctx · reasoning");
  });

  test("typing filters the model list, and backspace unfilters it", () => {
    // The measured reason this is a rebuilt list: `SelectList.handleInput` ignores printable characters
    // outright, so a bare list would show all three models no matter what was typed.
    //
    // The query is "4-8" rather than "opus": `fuzzyFilter` matches a SUBSEQUENCE, so "opus" also matches
    // `claude-sonnet-4-5` through anthr*o*pic/anthro*p*ic/cla*u*de/*s*onnet. That is pi's own matcher and
    // pi's own `/model` inherits it too -- `test/model-picker.test.ts` pins it as a fact. Here the point
    // is that typing narrows the list AT ALL, so the query is one that genuinely excludes.
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    for (const ch of "4-8") h.list.handleInput(ch);
    const filtered = h.render();
    expect(filtered).toContain("Claude Opus 4.8");
    expect(filtered).not.toContain("Claude Sonnet 4.5");

    for (let i = 0; i < 3; i++) h.list.handleInput(KEY.backspace);
    expect(h.render()).toContain("Claude Sonnet 4.5");
  });

  test("a subsequence query still ranks the best match first, so Enter takes the obvious one", () => {
    // The operator-facing consequence of the inherited matcher, asserted where it matters: even when
    // "opus-4" pulls `claude-sonnet-4-5` into the list, the model whose name the operator typed sorts to
    // the top and is what Enter commits.
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    for (const ch of "opus-4") h.list.handleInput(ch);
    h.list.handleInput(KEY.enter);
    expect(h.changed).toEqual([["manual", "anthropic/claude-opus-4-8"]]);
  });

  test("picking a filtered model yields that model, not the one at the original index", () => {
    // The bug that makes a filter dangerous: if the selection index is not reset when the list is
    // rebuilt, Enter commits whatever now sits at the old position. Driven with a Down FIRST, so the
    // index is genuinely non-zero before the filter narrows the list to one row -- without that move the
    // test would pass on an implementation that never resets anything.
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);                       // select Claude Opus 4.8 (index 1)
    for (const ch of "sonnet") h.list.handleInput(ch);  // narrows to Claude Sonnet 4.5 alone
    h.list.handleInput(KEY.enter);
    expect(h.changed).toEqual([["manual", "anthropic/claude-sonnet-4-5"]]);
  });

  test("Escape at the model stage goes back to providers, and changes nothing", () => {
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    expect(h.render()).toContain("Select a model from Anthropic");

    h.list.handleInput(KEY.escape);
    expect(h.render()).toContain("Select a provider");
    expect(h.changed).toEqual([]);
    // Still inside the picker: the dialog was not cancelled by a back-navigation.
    expect(h.isCancelled()).toBeFalse();
  });

  test("Escape at the provider stage closes the submenu without touching the row", () => {
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.escape);
    expect(h.changed).toEqual([]);
    expect(h.items[0]!.currentValue).toBe("(not routed)");
    // Back on the main list, and one more Escape cancels the dialog itself.
    expect(h.render()).toContain("threshold");
    h.list.handleInput(KEY.escape);
    expect(h.isCancelled()).toBeTrue();
  });

  test("a re-filtered search resets between drills, so a second pick starts clean", () => {
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    for (const ch of "opus") h.list.handleInput(ch);
    h.list.handleInput(KEY.escape);   // back to providers -- search must clear
    h.list.handleInput(KEY.enter);    // amazon-bedrock this time
    expect(h.render()).toContain("Nova Lite");
    h.list.handleInput(KEY.enter);
    expect(h.changed).toEqual([["manual", "amazon-bedrock/amazon.nova-lite-v1:0"]]);
  });

  test("a provider with no models at all is survivable, not a crash", () => {
    const h = harness([]);
    h.list.handleInput(KEY.enter);
    expect(h.render()).toContain("No providers with configured credentials");
    // Enter on the placeholder must not commit an empty reference into settings.
    h.list.handleInput(KEY.enter);
    expect(h.changed).toEqual([]);
  });

  test("a query matching nothing says so and cannot be committed", () => {
    const h = harness();
    h.list.handleInput(KEY.enter);
    h.list.handleInput(KEY.down);
    h.list.handleInput(KEY.enter);
    for (const ch of "zzzznope") h.list.handleInput(ch);
    expect(h.render()).toContain("No model matches 'zzzznope'");
    h.list.handleInput(KEY.enter);
    expect(h.changed).toEqual([]);
  });

  test("a non-submenu row still cycles its values in place", () => {
    // The `resume` and `advanced` rows use `values` rather than `submenu`; both mechanisms have to
    // coexist on one list.
    const changed: Array<[string, string]> = [];
    const items: SettingItem[] = [{ id: "resume", label: "auto-resume", currentValue: "off", values: ["off", "manual", "manual, threshold"] }];
    const list = new SettingsList(items, 5, SETTINGS_THEME, (id, v) => changed.push([id, v]), () => {}, { enableSearch: true });
    list.handleInput(KEY.enter);
    list.handleInput(KEY.enter);
    expect(changed).toEqual([["resume", "manual"], ["resume", "manual, threshold"]]);
  });
});

describe("the dialog shell", () => {
  test("it renders a title above the list and forwards input", () => {
    const changed: Array<[string, string]> = [];
    let closed = false;
    let renders = 0;
    const component = buildSettingsDialog({
      items: [{ id: "resume", label: "auto-resume", currentValue: "off", values: ["off", "manual"] }],
      settingsTheme: SETTINGS_THEME,
      title: "Compaction router — global settings",
      onChange: (id, v) => changed.push([id, v]),
      onClose: () => { closed = true; },
      requestRender: () => { renders++; },
    });
    expect(component.render(70)[0]).toBe("Compaction router — global settings");
    component.handleInput?.(KEY.enter);
    expect(changed).toEqual([["resume", "manual"]]);
    // A render was requested, or the change would sit invisible until the next unrelated keystroke.
    expect(renders).toBeGreaterThan(0);
    component.handleInput?.(KEY.escape);
    expect(closed).toBeTrue();
  });

  test("row search is enabled, so the surface survives more rows being added", () => {
    // `enableSearch: true` is cheap now and load-bearing once W5 adds a memory-worker row. The hint line
    // is `SettingsList`'s own tell for which mode it is in.
    const component = buildSettingsDialog({
      items: [{ id: "manual", label: "manual", currentValue: "x", values: ["x", "y"] }],
      settingsTheme: SETTINGS_THEME,
      title: "t",
      onChange: () => {},
      onClose: () => {},
    });
    expect(component.render(70).join("\n")).toContain("Type to search");
  });

  test("invalidate reaches the list rather than throwing", () => {
    const component = buildSettingsDialog({
      items: [{ id: "a", label: "a", currentValue: "1", values: ["1", "2"] }],
      settingsTheme: SETTINGS_THEME, title: "t", onChange: () => {}, onClose: () => {},
    });
    expect(() => component.invalidate()).not.toThrow();
  });
});
