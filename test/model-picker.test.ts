/**
 * The provider/model enumeration rules, and the three registry methods this package must never call.
 *
 * The negative assertions carry as much weight as the positive ones. Each names a method that is
 * present on `ModelRegistry`, plausibly named for the job, and measured wrong:
 * `getRegisteredProviderIds()` returns only extension-registered providers (one id on the research
 * host, against a 37-provider catalogue); `refresh()` is a network reload that hung two probe runs past
 * 120 s; `getAll()` is not auth-filtered and would offer an operator a provider they cannot use. A
 * fake registry that THROWS on each is the only way to keep them out for good -- a comment cannot.
 */

import { describe, expect, test } from "bun:test";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { filterModels, modelItems, modelSearchText, modelsForProvider, providerIds, providerItems, validateReference, type PickableModel, type PickableRegistry } from "../src/model-picker.js";

const MODELS: PickableModel[] = [
  { id: "amazon.nova-lite-v1:0", provider: "amazon-bedrock", name: "Nova Lite", contextWindow: 300_000, reasoning: false },
  { id: "amazon.nova-pro-v1:0", provider: "amazon-bedrock", name: "Nova Pro", contextWindow: 300_000, reasoning: false },
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { id: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", contextWindow: 1_000_000, reasoning: true },
  { id: "gpt-5", provider: "openai", name: "GPT-5", contextWindow: 400_000, reasoning: true },
];

const AUTH: Record<string, { configured: boolean; source?: string; label?: string }> = {
  "amazon-bedrock": { configured: true, source: "environment", label: "AWS_BEARER_TOKEN_BEDROCK" },
  anthropic: { configured: true, source: "stored" },
  openai: { configured: true },
};

const DISPLAY: Record<string, string> = { "amazon-bedrock": "Amazon Bedrock", anthropic: "Anthropic", openai: "OpenAI" };

/**
 * A registry that answers the three supported reads and BOOBY-TRAPS the rest.
 *
 * `getAll`, `refresh` and `getRegisteredProviderIds` are present, because they are present on the real
 * `ModelRegistry` and the point is to prove our code does not reach for them. Each throws, so any
 * future edit that calls one fails this file loudly instead of shipping a near-empty provider list or a
 * dialog that hangs the editor.
 */
function fakeRegistry(models: PickableModel[] = MODELS): PickableRegistry & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getAvailable: () => { calls.push("getAvailable"); return models; },
    getProviderDisplayName: (p: string) => DISPLAY[p] ?? p,
    getProviderAuthStatus: (p: string) => AUTH[p] ?? { configured: false },
    find: (provider: string, id: string) => { calls.push("find"); return models.find(m => m.provider === provider && m.id === id); },
    // The three traps.
    getAll: () => { throw new Error("getAll() is not auth-filtered; use getAvailable()"); },
    refresh: () => { throw new Error("refresh() is a network reload and hangs the UI path"); },
    getRegisteredProviderIds: () => { throw new Error("getRegisteredProviderIds() returns extension-registered providers only"); },
    // `mr.runtime` is reachable at runtime because TS `private` is erased. Present and poisoned.
    runtime: new Proxy({}, { get: () => { throw new Error("mr.runtime is internal and must never be touched"); } }),
  } as unknown as PickableRegistry & { calls: string[] };
}

describe("provider enumeration derives from the catalogue", () => {
  test("providers are the distinct providers of getAvailable(), in catalogue order", () => {
    // The one-line workaround for the missing `getProviders()`, asserted as the exact expression the
    // spec names: `[...new Set(getAvailable().map(m => m.provider))]`.
    expect(providerIds(fakeRegistry())).toEqual(["amazon-bedrock", "anthropic", "openai"]);
  });

  test("order is the catalogue's, not alphabetical", () => {
    const shuffled = [MODELS[4]!, MODELS[2]!, MODELS[0]!];
    expect(providerIds(fakeRegistry(shuffled))).toEqual(["openai", "anthropic", "amazon-bedrock"]);
  });

  test("enumeration touches getAvailable and nothing else", () => {
    // The positive form of the traps: every forbidden method throws, so reaching one would fail here.
    const registry = fakeRegistry();
    providerIds(registry);
    providerItems(registry);
    expect(new Set(registry.calls)).toEqual(new Set(["getAvailable"]));
  });

  test("no duplicate provider row even when a provider has many models", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, provider: "anthropic", name: `M${i}` }));
    expect(providerIds(fakeRegistry(many))).toEqual(["anthropic"]);
  });

  test("an empty catalogue yields no providers rather than throwing", () => {
    expect(providerIds(fakeRegistry([]))).toEqual([]);
    expect(providerItems(fakeRegistry([]))).toEqual([]);
  });
});

describe("provider rows render display name and auth reason", () => {
  test("label is getProviderDisplayName, description carries the auth label", () => {
    // The auth label is the point of the description: it tells the operator WHY the provider is
    // available, which is the difference between an actionable list and a list of opaque ids.
    const items = providerItems(fakeRegistry());
    expect(items[0]).toEqual({ value: "amazon-bedrock", label: "Amazon Bedrock", description: "2 model(s) · AWS_BEARER_TOKEN_BEDROCK" });
  });

  test("a status with no label falls back to its source", () => {
    expect(providerItems(fakeRegistry())[1]).toEqual({ value: "anthropic", label: "Anthropic", description: "2 model(s) · stored" });
  });

  test("a status with neither label nor source still gets a row", () => {
    // It came from `getAvailable()`, so it is usable. Saying nothing about it beats implying it is broken.
    expect(providerItems(fakeRegistry())[2]).toEqual({ value: "openai", label: "OpenAI", description: "1 model(s)" });
  });
});

describe("model rows are filtered per provider and show fit information", () => {
  test("models are filtered to the chosen provider", () => {
    expect(modelsForProvider(fakeRegistry(), "anthropic").map(m => m.id)).toEqual(["claude-sonnet-4-5", "claude-opus-4-8"]);
    expect(modelsForProvider(fakeRegistry(), "openai").map(m => m.id)).toEqual(["gpt-5"]);
  });

  test("an unknown provider yields no models rather than the whole catalogue", () => {
    expect(modelsForProvider(fakeRegistry(), "nope")).toEqual([]);
  });

  test("a row's value is the provider/model reference the settings store uses", () => {
    // Load-bearing: the picker's output goes straight into `ModelTarget.model` and is read back by
    // `parseModelReference`. A bare model id here would produce settings the router cannot resolve.
    const items = modelItems(modelsForProvider(fakeRegistry(), "anthropic"));
    expect(items.map(i => i.value)).toEqual(["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-8"]);
  });

  test("description shows contextWindow and reasoning, the two facts that decide fit", () => {
    const items = modelItems(modelsForProvider(fakeRegistry(), "anthropic"));
    expect(items[0]).toEqual({ value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", description: "200k ctx · reasoning" });
    expect(items[1]!.description).toBe("1.0M ctx · reasoning");
  });

  test("a non-reasoning model says nothing about reasoning", () => {
    expect(modelItems(modelsForProvider(fakeRegistry(), "amazon-bedrock"))[0]!.description).toBe("300k ctx");
  });

  test("label falls back to the id when the catalogue gives no name", () => {
    expect(modelItems([{ id: "raw-model", provider: "p" }])).toEqual([{ value: "p/raw-model", label: "raw-model" }]);
  });

  test("a model with no window and no reasoning gets no description key at all", () => {
    // Rather than an empty string, which `SelectList` would render as a blank line.
    expect(modelItems([{ id: "x", provider: "p" }])[0]!.description).toBeUndefined();
  });
});

describe("filtering copies pi's /model recipe", () => {
  test("search text puts provider first, exactly as getModelSelectorSearchText does", () => {
    // Reproducing the ORDER is the point, not just the tokens: upstream's comment says the bare model
    // id is kept out of the leading position so provider-prefixed queries outrank proxy ids like
    // `openrouter/openai/gpt-5`. A re-ordering with the same tokens scores differently under fuzzyFilter.
    expect(modelSearchText(MODELS[2]!)).toBe("anthropic anthropic/claude-sonnet-4-5 anthropic claude-sonnet-4-5 Claude Sonnet 4.5");
  });

  test("a name-less model produces no trailing space", () => {
    expect(modelSearchText({ id: "x", provider: "p" })).toBe("p p/x p x");
  });

  test("fuzzy filter finds a model by name fragment", () => {
    expect(filterModels(MODELS, "sonnet", fuzzyFilter).map(m => m.id)).toEqual(["claude-sonnet-4-5"]);
  });

  test("fuzzy filter handles slash-separated provider/model queries", () => {
    // The case `SelectList.setFilter` cannot do at all: it is a `startsWith` on `value`, so
    // `"bedrock/nova"` against `amazon-bedrock/...` matches nothing and renders the hardcoded
    // "No matching commands". This is why the list is rebuilt instead.
    expect(filterModels(MODELS, "bedrock/nova-lite", fuzzyFilter).map(m => m.id)).toEqual(["amazon.nova-lite-v1:0"]);
  });

  test("a mid-string query matches at all, which startsWith would not", () => {
    // The direct demonstration of the defect being routed around: `setFilter("opus")` is a
    // `startsWith` on `value`, so it matches NOTHING here (asserted on the second line) and renders
    // the hardcoded "No matching commands". `fuzzyFilter` finds the model.
    expect(filterModels(MODELS, "opus", fuzzyFilter).map(m => m.id)).toContain("claude-opus-4-8");
    expect(MODELS.filter(m => `${m.provider}/${m.id}`.toLowerCase().startsWith("opus"))).toEqual([]);
  });

  test("fuzzyFilter is a SUBSEQUENCE matcher, and a short query can rank the wrong model first", () => {
    // MEASURED on this package's pinned pi-tui 0.81.1, and recorded rather than wished away: a query
    // matches if its characters appear IN ORDER anywhere in the search text, not contiguously. So
    // "opus" also matches `claude-sonnet-4-5` -- o(anthr*o*pic) p(anthro*p*ic) u(cla*u*de) s(*s*onnet)
    // -- and scores it BETTER (29.1 vs 45.4, lower is better), putting the model the operator did not
    // mean at the top of the list.
    //
    // This is pi's own matcher and pi's own `/model` picker has exactly the same behaviour, so it is
    // substrate, not a defect this package introduced, and copying the recipe faithfully means
    // inheriting it. It is asserted here so the inheritance is a recorded fact: if a future wave wants
    // contiguous-substring ranking it has to write its own matcher, and this test is what will tell it
    // that `fuzzyFilter` was never going to give it that.
    expect(filterModels(MODELS, "opus", fuzzyFilter).map(m => m.id)).toEqual(["claude-sonnet-4-5", "claude-opus-4-8"]);
    // One more character is enough to reverse the ranking, which is the practical mitigation and the
    // reason this is liveable: the list is rebuilt on every keystroke, so the operator sees it correct
    // itself as they type.
    expect(filterModels(MODELS, "opus-4", fuzzyFilter)[0]!.id).toBe("claude-opus-4-8");
    expect(filterModels(MODELS, "claude-opus", fuzzyFilter)[0]!.id).toBe("claude-opus-4-8");
  });

  test("an empty query is the identity, not whatever fuzzyFilter does with empty input", () => {
    // Upstream guards this explicitly (`query ? fuzzyFilter(...) : this.activeModels`).
    expect(filterModels(MODELS, "", fuzzyFilter)).toEqual(MODELS);
  });

  test("a query matching nothing yields an empty list, not the unfiltered one", () => {
    expect(filterModels(MODELS, "zzzznope", fuzzyFilter)).toEqual([]);
  });
});

describe("validation is a find() round-trip", () => {
  test("a reference the registry can resolve validates", () => {
    expect(validateReference(fakeRegistry(), "anthropic/claude-sonnet-4-5")).toEqual({ ok: true });
  });

  test("a model that is not in the catalogue is refused, naming the provider", () => {
    const result = validateReference(fakeRegistry(), "anthropic/claude-imaginary");
    expect(result.ok).toBeFalse();
    expect(result.error).toContain("not an available model for 'anthropic'");
  });

  test("a provider that does not exist is refused", () => {
    expect(validateReference(fakeRegistry(), "nope/some-model").ok).toBeFalse();
  });

  test("a reference with no slash, a leading slash, or a trailing slash is refused", () => {
    // These are the shapes `parseModelReference` also rejects; catching them here means the error the
    // operator reads names their input rather than surfacing as a mysterious skip at compaction time.
    for (const bad of ["anthropic", "/claude", "anthropic/", ""]) {
      const result = validateReference(fakeRegistry(), bad);
      expect(result.ok, `'${bad}' should be refused`).toBeFalse();
      expect(result.error).toContain("provider/model reference");
    }
  });

  test("a model id containing slashes validates, because proxy providers use them", () => {
    // `openrouter/openai/gpt-5` is a real shape: the FIRST slash separates provider from id, so the id
    // keeps the rest. Splitting on the last slash, or on all of them, would break every proxy provider.
    const registry = fakeRegistry([{ id: "openai/gpt-5", provider: "openrouter", name: "GPT-5" }]);
    expect(validateReference(registry, "openrouter/openai/gpt-5")).toEqual({ ok: true });
  });
});
