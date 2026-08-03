/**
 * The data behind the provider -> model drill-down, separated from the components that draw it.
 *
 * Upstream: pi itself. The filter recipe is `ModelSelectorComponent`'s
 * (`dist/modes/interactive/components/model-selector.js:2, 195-198`) and the search-text builder is
 * `getModelSelectorSearchText` (`dist/modes/interactive/model-search.js`), neither of which is
 * exported from the package root -- so the ~15 lines are reproduced here rather than imported. Read
 * at this package's pinned `@earendil-works/pi-coding-agent` 0.81.1.
 *
 * WHY this file is pure, and why the picker is not a `ctx.ui.select` call.
 *
 * Everything here is a function from a plain model list to a plain item list. That is deliberate:
 * these are the rules the wave's acceptance criteria are written about ("provider list =
 * `[...new Set(getAvailable().map(m => m.provider))]`, never `getRegisteredProviderIds`, never
 * `refresh()`"), and a rule that lives inside a TUI component can only be tested by driving a TUI.
 * `src/settings-ui.ts` draws; this decides.
 *
 * THREE MEASURED TRAPS this file exists to avoid (`pi-settings-ui-surface.md` §1, §3):
 *
 *  1. `ModelRegistry` has NO `getProviders()`. The plausibly-named `getRegisteredProviderIds()` is
 *     not the provider list -- it returns only providers an EXTENSION registered via
 *     `pi.registerProvider`, and on the research host it returned exactly `["llama.cpp"]` while the
 *     catalogue held 37 providers. `mr.runtime.getProviders()` is reachable (TS `private` is erased)
 *     and is explicitly internal; it is not touched here. The supported derivation is a `Set` over
 *     the catalogue, which is what `providerIds` does.
 *  2. `getAvailable()` is ALREADY auth-filtered. Measured: `getAll()` = 1153 models / 37 providers,
 *     `getAvailable()` = 114 models / 1 provider, and every provider surfacing from `getAvailable()`
 *     passes `getProviderAuthStatus().configured`. So `getAvailable()` is the correct source and no
 *     second filter is needed. `getAll()` is deliberately NOT used: it would offer an operator a
 *     provider they have no credentials for.
 *  3. `refresh()` is NEVER called. It is the async network catalogue reload, and it hung two probe
 *     runs past a 120 s timeout. A settings dialog must not be able to hang the editor; the
 *     synchronous reads here return whatever the registry already knows.
 *
 * A fourth trap belongs to the component and is recorded here because this file's output is what
 * feeds it: `SelectList.setFilter()` is a case-insensitive `startsWith` on `item.value` only
 * (`select-list.js:25-29`), so against `provider/model` values it matches almost nothing, and
 * `SelectList.handleInput` ignores printable characters entirely (`select-list.js:64-89`) -- a bare
 * `SelectList` is not searchable at all. Hence `filterModels` below and a rebuilt list, which is what
 * pi's own `/model` picker does.
 */

import type { SelectItem } from "@earendil-works/pi-tui";

/** The part of `Model<Api>` this package reads. Structural, so the tests need no real registry. */
export interface PickableModel {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** The part of `AuthStatus` worth rendering (`dist/core/provider-composer.d.ts:39-43`). */
export interface PickableAuthStatus {
  configured: boolean;
  source?: string;
  label?: string;
}

/** The `ModelRegistry` surface this file uses -- and, by omission, the surface it refuses to use. */
export interface PickableRegistry {
  getAvailable(): PickableModel[];
  getProviderDisplayName(provider: string): string;
  getProviderAuthStatus(provider: string): PickableAuthStatus;
  find(provider: string, modelId: string): unknown;
}

/**
 * Every provider that has at least one usable model, in first-seen catalogue order.
 *
 * This is the one-line workaround for the missing `getProviders()`. Order is the catalogue's own
 * rather than alphabetical: pi orders its catalogue deliberately and re-sorting it would put an
 * operator's usual provider somewhere new.
 */
export function providerIds(registry: Pick<PickableRegistry, "getAvailable">): string[] {
  return [...new Set(registry.getAvailable().map(m => m.provider))];
}

/**
 * Providers as select rows: display name as the label, the auth reason as the description.
 *
 * `getProviderAuthStatus(id).label` is the point of the description -- it tells an operator WHY a
 * provider is available (`"AWS_BEARER_TOKEN_BEDROCK"`, `"stored"`), which is the difference between a
 * list they can act on and a list of opaque ids. A provider whose status carries neither a label nor a
 * source still gets a row: it came from `getAvailable()`, so it is usable, and saying nothing about it
 * is better than implying it is broken.
 */
export function providerItems(registry: PickableRegistry): SelectItem[] {
  return providerIds(registry).map(id => {
    const status = registry.getProviderAuthStatus(id);
    const detail = status.label ?? status.source;
    const count = registry.getAvailable().filter(m => m.provider === id).length;
    return {
      value: id,
      label: registry.getProviderDisplayName(id),
      description: detail ? `${count} model(s) · ${detail}` : `${count} model(s)`,
    };
  });
}

/** The models one provider offers, in catalogue order. */
export function modelsForProvider(registry: Pick<PickableRegistry, "getAvailable">, provider: string): PickableModel[] {
  return registry.getAvailable().filter(m => m.provider === provider);
}

/** `1000000` -> `1.0M`, `300000` -> `300k`. A context window is compared, not summed. */
function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}

/**
 * A model as a select row: `provider/id` as the value, `name` as the label, and
 * `{contextWindow, reasoning}` in the description.
 *
 * The value is the full `provider/model` reference because that is exactly what this package's
 * settings store as `ModelTarget.model` and what `parseModelReference` reads back -- so the picker's
 * output needs no translation on the way to disk.
 *
 * `contextWindow` earns its place in the description rather than being decoration: the fit guard in
 * `src/index.ts` skips a target whose window cannot hold the summarization prompt, and this is where
 * an operator can see that coming before they pick it.
 */
export function modelItems(models: PickableModel[]): SelectItem[] {
  return models.map(model => {
    const parts: string[] = [];
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) parts.push(formatWindow(model.contextWindow));
    if (model.reasoning) parts.push("reasoning");
    return {
      value: `${model.provider}/${model.id}`,
      label: model.name ?? model.id,
      ...(parts.length ? { description: parts.join(" · ") } : {}),
    };
  });
}

/**
 * Pi's own `/model` search text, reproduced verbatim in shape.
 *
 * Upstream (`model-search.js`, `getModelSelectorSearchText`):
 *   `${provider} ${provider}/${id} ${provider} ${id}${name ? " " + name : ""}`
 *
 * The bare model id is deliberately NOT in the leading position, and upstream says why in a comment:
 * "The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5". Reproducing the ORDER is the whole point -- a re-ordering that
 * happens to contain the same tokens scores differently under `fuzzyFilter`.
 */
export function modelSearchText(model: PickableModel): string {
  const name = model.name ? ` ${model.name}` : "";
  return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/**
 * Filter models by a query, using pi's own fuzzy matcher over pi's own search text.
 *
 * `fuzzyFilter` is injected rather than imported so this module stays free of `@earendil-works/pi-tui`
 * and so a test can prove the SEARCH TEXT is what gets matched, independently of the matcher. The
 * empty query returns the list unchanged, which is upstream's behaviour
 * (`query ? fuzzyFilter(...) : this.activeModels`) and matters because `fuzzyFilter("")` is not
 * guaranteed to be the identity.
 *
 * INHERITED BEHAVIOUR, measured and recorded rather than papered over: `fuzzyFilter` matches a
 * SUBSEQUENCE -- the query's characters in order, not contiguous -- so a short query pulls in models
 * that merely contain its letters, and can rank one of them first. Measured on pinned pi-tui 0.81.1:
 * `"opus"` matches `anthropic/claude-sonnet-4-5` (o-p from "anthropic", u from "claude", s from
 * "sonnet") and scores it 29.1 against `claude-opus-4-8`'s 45.4, lower being better -- so the wrong
 * model sorts to the top. This is pi's own matcher and pi's own `/model` picker behaves identically, so
 * copying the recipe faithfully means inheriting it; a divergent matcher here would be a worse outcome
 * than a shared quirk. One more typed character reverses it (`"opus-4"` ranks correctly), and the list
 * is rebuilt per keystroke, so the operator watches it correct itself. `test/model-picker.test.ts`
 * pins the behaviour so a future wave that wants substring ranking knows it must bring its own matcher.
 */
export function filterModels(
  models: PickableModel[],
  query: string,
  fuzzy: <T>(items: T[], query: string, getText: (item: T) => string) => T[],
): PickableModel[] {
  return query ? fuzzy(models, query, modelSearchText) : models;
}

export interface ValidationResult {
  ok: boolean;
  /** Present when `ok` is false. Written for an operator, not a log. */
  error?: string;
}

/**
 * The `find(provider, id)` round-trip: does the reference the picker produced resolve to a real model?
 *
 * This is the honest half of validation and the only half this function does. It closes the loop
 * against the SAME registry the compaction hook will call, so a reference that validates here is one
 * `src/index.ts` can find later. It deliberately does not check credentials or context fit:
 * `getApiKeyAndHeaders` is async and per-model, and the fit check needs a live preparation -- both
 * belong to the compaction path, which already performs them and already reports what it skipped.
 */
export function validateReference(registry: Pick<PickableRegistry, "find">, reference: string): ValidationResult {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return { ok: false, error: `'${reference}' is not a provider/model reference.` };
  const provider = reference.slice(0, slash);
  const modelId = reference.slice(slash + 1);
  return registry.find(provider, modelId)
    ? { ok: true }
    : { ok: false, error: `'${reference}' is not an available model for '${provider}'.` };
}
