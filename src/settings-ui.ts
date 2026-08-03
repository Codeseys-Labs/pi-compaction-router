/**
 * The components. Everything that draws; nothing that decides.
 *
 * Upstream: pi itself, twice.
 *
 *  - The `SettingsList` host is `examples/extensions/tools.ts:66-135`'s shape -- `ctx.mode !== "tui"`
 *    guard, `ctx.ui.custom()`, `getSettingsListTheme()` called INSIDE the callback, a `Container` with
 *    a title component, and the returned `{render, invalidate, handleInput}` that forwards to the list
 *    and calls `tui.requestRender()`.
 *  - `ProviderModelPicker`'s filter arm is `ModelSelectorComponent`'s
 *    (`dist/modes/interactive/components/model-selector.js:2, 195-198`): an `Input`, `fuzzyFilter`
 *    over provider-first search text, and a REBUILT `SelectList` on every keystroke.
 *
 * Both read at this package's pinned 0.81.1. MIT, Copyright (c) 2026 Earendil Works
 * (`@earendil-works/pi-coding-agent`), whose examples directory is published as copy-me reference
 * material -- `docs/tui.md:612-670` says so in as many words: "Copy these patterns instead of building
 * from scratch", and `:930`: "SelectList, SettingsList, BorderedLoader cover 90% of cases. Don't
 * rebuild them."
 *
 * WHY A REBUILT LIST RATHER THAN `setFilter`, MEASURED (`pi-settings-ui-surface.md` §3):
 *
 *  - `SelectList.setFilter(q)` is `items.filter(i => i.value.toLowerCase().startsWith(q))` -- a
 *    `startsWith` on `value` only (`select-list.js:25-29`). Our values are `provider/model`, so
 *    `setFilter("opus")` matches NOTHING and the list renders the hardcoded, unthemeable string
 *    "No matching commands".
 *  - `SelectList.handleInput` matches only `tui.select.up/down/confirm/cancel` and ignores printable
 *    characters entirely (`select-list.js:64-89`), so a bare `SelectList` is not searchable at all.
 *  - `ModelSelectorComponent` IS exported and IS a real constructor, but its arity-8 signature demands
 *    a `ModelRuntime` -- precisely the object `ExtensionContext` does not expose. Constructing one
 *    would mean a second, divergent model runtime. So the ~15-line pattern is copied; the component is
 *    not.
 *
 * WHY THE THEME IS FETCHED WHERE IT IS: `getSettingsListTheme()` throws
 * `"Theme not initialized. Call initTheme() first."` outside a TUI session (measured; re-measured on
 * this package's own pinned 0.81.1, where it still throws while `getSelectListTheme()` does not). It
 * is therefore called only inside the `custom()` callback, and the whole command is gated on
 * `ctx.mode === "tui"` rather than `ctx.hasUI` -- `hasUI` is also true in RPC mode, where there is no
 * TUI to theme (`docs/extensions.md:944-946`).
 *
 * Every component here takes its theme as a constructor argument for that reason: it makes the throw
 * impossible to reintroduce from this file, and it is what lets the tests render these components
 * headlessly with plain stylers.
 */

import { fuzzyFilter, Input, SelectList, SettingsList, type SelectItem, type SelectListTheme, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { filterModels, modelItems, modelsForProvider, providerItems, type PickableRegistry } from "./model-picker.js";

/** How many rows either list shows before it scrolls. Pi's own pickers sit in this range. */
const MAX_VISIBLE = 12;

/**
 * The two-stage drill-down: providers, then that provider's models, then `done(provider/model)`.
 *
 * Implements `Component`, so it is exactly what `SettingItem.submenu` must return. `SettingsList`
 * delegates all input and rendering to it from the moment `activateItem()` calls the factory until it
 * calls `done` (`settings-list.js:142-172`), so this class owns the whole drill-down -- there is no
 * state machine in the caller and no navigation code outside this file.
 *
 * `done(undefined)` on cancel is the contract that makes Escape work: `SettingsList` closes the
 * submenu on any `done`, and only a defined value sets `currentValue` and fires `onChange`. So
 * cancelling at either stage leaves the row untouched.
 *
 * Escape at the MODEL stage goes back to the provider list rather than out of the picker, because a
 * two-stage flow whose back-button exits is the one thing an operator will get wrong twice.
 */
export class ProviderModelPicker implements Component {
  private stage: "provider" | "model" = "provider";
  private provider: string | undefined;
  private list: SelectList;
  private readonly search = new Input();

  constructor(
    private readonly registry: PickableRegistry,
    private readonly theme: SelectListTheme,
    private readonly done: (value?: string) => void,
    /** Called after any state change, so the host can re-render. `tui.requestRender()` in practice. */
    private readonly requestRender: () => void = () => {},
  ) {
    this.list = this.buildProviderList();
  }

  private buildProviderList(): SelectList {
    const items = providerItems(this.registry);
    const list = new SelectList(items.length ? items : [{ value: "", label: "No providers with configured credentials" }], MAX_VISIBLE, this.theme);
    list.onSelect = item => {
      // The empty value is the placeholder row above: there is nothing to drill into, and an operator
      // pressing Enter on it should not get a blank model list.
      if (!item.value) return;
      this.provider = item.value;
      this.stage = "model";
      this.search.setValue("");
      this.list = this.buildModelList();
      this.requestRender();
    };
    list.onCancel = () => this.done(undefined);
    return list;
  }

  /**
   * The model list for the chosen provider, filtered by whatever is in the search input.
   *
   * Rebuilt on every keystroke -- upstream's arm, and the only one that works here. Selection resets
   * to the top when a query is active, which is `model-selector.js`'s
   * `this.selectedIndex = query ? 0 : /* clamp *\/` behaviour: after a filter the old index points at
   * a different model, and leaving it there is how an operator picks the wrong one.
   */
  private buildModelList(): SelectList {
    const query = this.search.getValue().trim();
    const models = filterModels(modelsForProvider(this.registry, this.provider!), query, fuzzyFilter);
    const items: SelectItem[] = modelItems(models);
    const list = new SelectList(items.length ? items : [{ value: "", label: `No model matches '${query}'` }], MAX_VISIBLE, this.theme);
    list.onSelect = item => {
      if (!item.value) return;
      this.done(item.value);
    };
    // Back to the provider stage, not out of the picker. See the class comment.
    list.onCancel = () => {
      this.stage = "provider";
      this.provider = undefined;
      this.search.setValue("");
      this.list = this.buildProviderList();
      this.requestRender();
    };
    return list;
  }

  render(width: number): string[] {
    const heading = this.stage === "provider"
      ? "Select a provider · Esc to cancel"
      : `Select a model from ${this.registry.getProviderDisplayName(this.provider!)} · type to filter · Esc to go back`;
    const lines = [this.theme.description(`  ${heading}`)];
    if (this.stage === "model") lines.push(...this.search.render(width));
    lines.push(...this.list.render(width));
    return lines;
  }

  invalidate(): void {
    this.list.invalidate();
    this.search.invalidate();
  }

  /**
   * Navigation keys go to the list; everything else that is printable goes to the search input.
   *
   * The order matters. `SelectList.handleInput` ignores printable characters, so offering it the
   * keystroke first costs nothing and keeps arrow keys, Enter and Escape behaving exactly as they do
   * in pi's own lists. Only at the model stage does anything else reach the input -- the provider list
   * is short and unambiguous, and `SettingsList`'s own `enableSearch` already covers finding a ROW.
   */
  handleInput(data: string): void {
    if (this.stage === "model" && isSearchInput(data)) {
      this.search.handleInput(data);
      this.list = this.buildModelList();
      this.requestRender();
      return;
    }
    this.list.handleInput(data);
    this.requestRender();
  }
}

/**
 * Whether a keystroke is text for the filter rather than navigation.
 *
 * Backspace (`\x7f`) is included because a filter you cannot correct is worse than no filter. Escape
 * sequences (`\x1b...`), Enter and every other control byte are excluded so they reach the list.
 */
function isSearchInput(data: string): boolean {
  if (data === "\x7f" || data === "\b") return true;
  if (data.length === 0 || data.startsWith("\x1b")) return false;
  // Printable ASCII and anything above it (so a pasted non-ASCII model name still types).
  return [...data].every(ch => ch >= " " && ch !== "\x7f");
}

export interface SettingsDialogOptions {
  items: SettingItem[];
  settingsTheme: SettingsListTheme;
  title: string;
  onChange: (id: string, value: string) => void;
  onClose: () => void;
  requestRender?: () => void;
}

/**
 * The `SettingsList` host: a title line, the list, and the `{render, invalidate, handleInput}` triple
 * `ctx.ui.custom()` requires.
 *
 * `enableSearch: true` gives the row list a real fuzzy search over `label` (`settings-list.js:174-177`)
 * -- cheap now, and the reason the surface stays usable when W5 adds a memory-worker row.
 *
 * Returned as a plain object rather than a `Container` subclass because `custom()`'s contract is
 * structural and this is the whole of it. `tools.ts` builds a `Container` to hold its title; a
 * two-element render is not worth the indirection.
 */
export function buildSettingsDialog(options: SettingsDialogOptions): Component {
  const requestRender = options.requestRender ?? (() => {});
  const list = new SettingsList(
    options.items,
    Math.min(options.items.length + 2, MAX_VISIBLE + 3),
    options.settingsTheme,
    (id, value) => {
      options.onChange(id, value);
      requestRender();
    },
    options.onClose,
    { enableSearch: true },
  );
  return {
    render: (width: number) => [options.settingsTheme.label(options.title, false), "", ...list.render(width)],
    invalidate: () => list.invalidate(),
    handleInput: (data: string) => {
      list.handleInput(data);
      requestRender();
    },
  };
}
