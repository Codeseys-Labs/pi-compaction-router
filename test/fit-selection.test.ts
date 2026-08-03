/**
 * CHEAPEST-THAT-FITS (gap G6) and the `contextWindow` override (pi-blackhole `2bf8cda` steal 7).
 *
 * The ask, from `dive-ours-pi-compaction-router.md` §7.2: the vision's "any model it deems fit" (A-11)
 * against a router that only ever took a hand-written ordered list, read `contextWindow` solely to
 * reject, and never read `cost` at all.
 *
 * WHY THIS TEST FILE IS BUILT ON THE REAL-MASS FIXTURE. Verdict §5.5 / risk 5: G6 is blocked on G1,
 * because ordering by fit over an estimator that ran 3.7x-37.9x high re-lands the false-skip defect
 * behind a nicer interface -- and cheapest-first makes it worse, since the cheap models are the
 * small-window ones the bad estimate wrongly excluded. So the end-to-end cases here use
 * `test/fixtures/real-mass.ts` (calibrated to the 268 697-token session §5.2 recorded) rather than a
 * synthetic small preparation: a fixture both estimators accept would prove nothing about the ordering
 * that sits on top of them.
 */

import { describe, expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { effectiveContextWindow, rankByFit } from "../src/selection.js";
import { resolveConfig } from "../src/config.js";
import { RESERVE_TOKENS, serializedPromptTokens, WINDOW_272K } from "./fixtures/real-mass.js";
import { beforeCompactEvent, compactEvent, withHost } from "./harness.js";
import { load, restore } from "./support/stub-compact.js";
import { buildPreparation } from "./fixtures/real-mass.js";

afterAll(restore);

/** A model as the fit selector sees it. Only the four fields it reads. */
const model = (contextWindow: number, inputCost: number | undefined, maxTokens = 64_000) => ({
  contextWindow,
  maxTokens,
  ...(inputCost === undefined ? {} : { cost: { input: inputCost, output: inputCost * 5 } }),
});

const t = (name: string, extra: Record<string, unknown> = {}) => ({ model: name, ...extra });

describe("effectiveContextWindow: the operator's override wins over bad metadata", () => {
  test("the registry value is used when no override is set", () => {
    expect(effectiveContextWindow({}, { contextWindow: 200_000 })).toBe(200_000);
  });

  test("an override REPLACES a registry value, which is the escape hatch's whole point", () => {
    // dive-pi-blackhole.md steal 7: a model whose registry-reported window is wrong would otherwise be
    // silently unroutable, and the operator's only remedy would be to stop using the target.
    expect(effectiveContextWindow({ contextWindow: 1_000_000 }, { contextWindow: 8_000 })).toBe(1_000_000);
  });

  test("an override also rescues a model reporting NO window", () => {
    expect(effectiveContextWindow({ contextWindow: 400_000 }, {})).toBe(400_000);
    expect(effectiveContextWindow({ contextWindow: 400_000 }, { contextWindow: 0 })).toBe(400_000);
  });

  test("no override and no registry window is 0 -- unknown, NOT a default", () => {
    // Upstream falls back to 128 000 here. That is deliberately not taken: inventing a window would let
    // this package route a prompt it has no evidence fits, in the one place where the entire question is
    // whether the prompt fits. 0 means unknown and the caller treats unknown as does-not-fit.
    expect(effectiveContextWindow({}, {})).toBe(0);
    expect(effectiveContextWindow({}, { contextWindow: 0 })).toBe(0);
  });

  test("a zero or negative override is ignored, unlike cooldownHours: 0", () => {
    // `contextWindow: 0` is pi's own encoding for "no window known" -- exactly the bad metadata this
    // corrects -- so zero cannot also mean "a window of zero". `cooldownHours: 0` IS meaningful, and the
    // parser keeps them apart on purpose.
    const config = resolveConfig({ compactionRouter: { models: [{ model: "a/b", contextWindow: 0, cooldownHours: 0 }] } }, undefined, () => {});
    expect(config!.defaults[0]!.contextWindow).toBeUndefined();
    expect(config!.defaults[0]!.cooldownHours).toBe(0);
  });

  test("an invalid override is warned about and dropped, never applied", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ compactionRouter: { models: [{ model: "a/b", contextWindow: "big" }] } }, undefined, m => warnings.push(m));
    expect(config!.defaults[0]!.contextWindow).toBeUndefined();
    expect(warnings.join(" ")).toContain("contextWindow");
  });
});

describe("rankByFit: cheapest that fits", () => {
  const PROMPT = 100_000;
  const RESERVE = 16_384;

  test("the cheapest FITTING target is tried first, not the first one configured", () => {
    // The behaviour the gap names. All three fit; the operator's order is expensive-first, and the
    // ranking corrects it without dropping anything.
    const ranked = rankByFit([
      { target: t("p/expensive"), model: model(200_000, 15) },
      { target: t("p/cheap"), model: model(200_000, 1) },
      { target: t("p/middling"), model: model(200_000, 5) },
    ], PROMPT, RESERVE);
    expect(ranked.map(r => r.target.model)).toEqual(["p/cheap", "p/middling", "p/expensive"]);
    expect(ranked.every(r => r.fits)).toBe(true);
  });

  test("a cheap target that does NOT fit sorts behind an expensive one that does", () => {
    // The rule that keeps cheapest-first from being a false economy: a target that cannot hold the
    // prompt is not a cheaper option, it is a skip.
    const ranked = rankByFit([
      { target: t("p/roomy"), model: model(500_000, 15) },
      { target: t("p/tiny-and-cheap"), model: model(64_000, 0.1) },
    ], PROMPT, RESERVE);
    expect(ranked.map(r => r.target.model)).toEqual(["p/roomy", "p/tiny-and-cheap"]);
    expect(ranked[0]!.fits).toBe(true);
    expect(ranked[1]!.fits).toBe(false);
  });

  test("non-fitting targets stay IN the chain, at the back, with a stated reason", () => {
    // The ranking changes the ORDER, never the operator's set. A dropped target would be a silent
    // narrowing of configuration; a deprioritised one is still reported and still tried.
    const ranked = rankByFit([
      { target: t("p/tiny"), model: model(64_000, 0.1) },
      { target: t("p/roomy"), model: model(500_000, 15) },
    ], PROMPT, RESERVE);
    expect(ranked.length).toBe(2);
    const tiny = ranked.find(r => r.target.model === "p/tiny")!;
    expect(tiny.fits).toBe(false);
    expect(tiny.reason).toContain("64000-token window");
    expect(tiny.reason).toContain(String(PROMPT));
  });

  test("an UNPRICED model sorts last among those that fit, never first", () => {
    // A missing price is not a price of zero. Sorting `null` first would make a catalogue gap look like
    // the cheapest model in the fleet and route every compaction to it.
    const ranked = rankByFit([
      { target: t("p/unpriced"), model: model(200_000, undefined) },
      { target: t("p/expensive"), model: model(200_000, 15) },
    ], PROMPT, RESERVE);
    expect(ranked.map(r => r.target.model)).toEqual(["p/expensive", "p/unpriced"]);
    expect(ranked[1]!.inputCost).toBeNull();
  });

  test("equal prices KEEP the operator's configured order", () => {
    // The operator's sequencing is information. Reordering it on a tie would discard it for nothing.
    const ranked = rankByFit([
      { target: t("p/first"), model: model(200_000, 3) },
      { target: t("p/second"), model: model(200_000, 3) },
      { target: t("p/third"), model: model(200_000, 3) },
    ], PROMPT, RESERVE);
    expect(ranked.map(r => r.target.model)).toEqual(["p/first", "p/second", "p/third"]);
  });

  test("the override is what the ranking is decided on", () => {
    // The two mechanisms meeting: a target the registry says is too small, which the operator has
    // corrected, must be ranked on the corrected number -- otherwise the override changes nothing.
    const ranked = rankByFit([
      { target: t("p/roomy"), model: model(500_000, 15) },
      { target: t("p/misreported", { contextWindow: 1_000_000 }), model: model(8_000, 1) },
    ], PROMPT, RESERVE);
    // Cheap, and now fits: it wins.
    expect(ranked[0]!.target.model).toBe("p/misreported");
    expect(ranked[0]!.fits).toBe(true);
    expect(ranked[0]!.window).toBe(1_000_000);
  });

  test("a model reporting no window does not fit, and says why with the remedy", () => {
    const ranked = rankByFit([{ target: t("p/unknown"), model: model(0, 1) }], PROMPT, RESERVE);
    expect(ranked[0]!.fits).toBe(false);
    expect(ranked[0]!.reason).toContain("no context window");
    expect(ranked[0]!.reason).toContain("contextWindow");
  });

  test("an unresolvable target gets NO fit reason: that verdict is not this function's", () => {
    // `fits: false` with no `reason` is how the ranking says "not my call". The route loop reports an
    // unavailable model in its own words and records it as `unavailable`, a different fact from
    // `too-small`; a reason invented here would pre-empt that distinction.
    const ranked = rankByFit([{ target: t("p/gone"), model: null }], PROMPT, RESERVE);
    expect(ranked[0]!.fits).toBe(false);
    expect(ranked[0]!.reason).toBeUndefined();
  });

  test("the reserve is part of the fit decision, not decoration", () => {
    // Pi adds `reserveTokens` on top of the prompt, so a window that holds the prompt exactly does not
    // hold the request. Boundary pinned in both directions.
    const exact = rankByFit([{ target: t("p/x"), model: model(PROMPT + RESERVE, 1) }], PROMPT, RESERVE);
    expect(exact[0]!.fits).toBe(true);
    const oneShort = rankByFit([{ target: t("p/x"), model: model(PROMPT + RESERVE - 1, 1) }], PROMPT, RESERVE);
    expect(oneShort[0]!.fits).toBe(false);
  });

  test("an empty candidate list ranks to an empty list", () => {
    expect(rankByFit([], PROMPT, RESERVE)).toEqual([]);
  });
});

describe("end to end: the selector runs on real mass, with the W1 estimator", () => {
  const REAL_PROMPT = serializedPromptTokens(buildPreparation());

  test("REGRESSION GUARD: the fixture's mass is the §5.2 shape, so the ordering is tested on it", () => {
    // The fixture reproduces the 268 697-token session the router falsely refused at a 272k window.
    // The honest estimate of that prompt is what the ranking below is decided on, and it must be well
    // under the window -- if this drifts, the end-to-end cases stop testing what they claim to.
    expect(REAL_PROMPT + RESERVE_TOKENS).toBeLessThan(WINDOW_272K);
    expect(REAL_PROMPT).toBeGreaterThan(10_000);
  });

  test("on a real-mass compaction the cheapest fitting target is the one asked to compact", async () => {
    // The whole feature, through the real handler: two authorised targets, the expensive one first in
    // configuration, and the cheap one large enough to hold this prompt. The cheap one must serve it.
    const compacted: string[] = [];
    await withHost(
      {
        routerConfig: { models: [t("p/expensive"), t("p/cheap")] },
        auth: { ok: true, apiKey: "k", headers: {}, env: {} },
      },
      async host => {
        (host.ctx.modelRegistry as { find: (p?: string, i?: string) => unknown }).find = (_p, id) =>
          id === "cheap" ? { provider: "p", id: "cheap", ...model(500_000, 1) } : { provider: "p", id: "expensive", ...model(500_000, 15) };
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
      },
      // `compact()`'s arg 2 is the model. Read positionally, as `test/retry-parity.test.ts` does, so the
      // stub keeps the `(...args: unknown[])` shape the loader seam is typed for.
      () => load(async (...args: unknown[]) => {
        compacted.push((args[1] as { id: string }).id);
        return { summary: "a summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 100 };
      }),
    );
    // Exactly one call, to the cheap model. The expensive one was configured first and never asked.
    expect(compacted).toEqual(["cheap"]);
  });

  test("a too-small target is deprioritised, and the ledger records the window the DECISION used", async () => {
    // The override's end-to-end consequence. `p/misreported` is catalogued at 8k -- far too small for
    // this prompt -- and the operator has corrected it to 1M. It is also the cheaper of the two, so if
    // the override is honoured it wins, and the ledger's `window` must be the corrected number rather
    // than the registry's rejected one.
    let window: unknown = null;
    await withHost(
      {
        routerConfig: { models: [t("p/roomy"), t("p/misreported", { contextWindow: 1_000_000 })] },
        auth: { ok: true, apiKey: "k", headers: {}, env: {} },
      },
      async host => {
        (host.ctx.modelRegistry as { find: (p?: string, i?: string) => unknown }).find = (_p, id) =>
          id === "misreported" ? { provider: "p", id: "misreported", ...model(8_000, 1) } : { provider: "p", id: "roomy", ...model(500_000, 15) };
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
        const { readFileSync } = await import("node:fs");
        const { ledgerPath } = await import("../src/ledger.js");
        const rows = readFileSync(ledgerPath(host.agentDir), "utf8").trim().split("\n").map(l => JSON.parse(l));
        expect(rows.length).toBe(1);
        expect(rows[0].servedBy.model).toBe("p/misreported");
        window = rows[0].window;
      },
      () => load(async () => ({ summary: "a summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 100 })),
    );
    // The corrected window, not the catalogued 8 000 the fit decision would have refused.
    expect(window).toBe(1_000_000);
  });

  test("a target too small for THIS prompt is reported, and the chain still reaches a fitting one", async () => {
    const compacted: string[] = [];
    await withHost(
      {
        routerConfig: { models: [t("p/tiny"), t("p/roomy")] },
        auth: { ok: true, apiKey: "k", headers: {}, env: {} },
      },
      async host => {
        (host.ctx.modelRegistry as { find: (p?: string, i?: string) => unknown }).find = (_p, id) =>
          id === "tiny" ? { provider: "p", id: "tiny", ...model(8_000, 0.1) } : { provider: "p", id: "roomy", ...model(500_000, 15) };
        await host.emit("session_before_compact", beforeCompactEvent());
        await host.emit("session_compact", compactEvent({ fromExtension: true }));
      },
      // `compact()`'s arg 2 is the model. Read positionally, as `test/retry-parity.test.ts` does, so the
      // stub keeps the `(...args: unknown[])` shape the loader seam is typed for.
      () => load(async (...args: unknown[]) => {
        compacted.push((args[1] as { id: string }).id);
        return { summary: "a summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 100 };
      }),
    );
    // The cheap-but-tiny target was ranked last and skipped; the roomy one served it. A cheapest-first
    // rule that ignored fit would have tried `p/tiny` first and burned a hop on a certain failure.
    expect(compacted).toEqual(["roomy"]);
  });
});
