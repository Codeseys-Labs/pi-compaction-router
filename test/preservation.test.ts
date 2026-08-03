/**
 * THE PRESERVATION LAYER'S PURE HALF — the fold, forgetting, thresholds, citation guard, recall.
 *
 * Every mechanism here is a function over plain objects, which is deliberate and is why this file
 * needs no host: the W5 brief's acceptance list is mostly claims about POLICY (which fact is dropped
 * first, which cited id is rejected, what a ratio threshold resolves to), and a policy that can only
 * be checked by driving a compaction is a policy nothing pins. The handler-level assertions -- observer
 * OFF by default, fold reaching `compact()`, the worker routed through our table -- live in
 * `preservation-handler.test.ts` against the real handlers.
 */

import { describe, expect, test } from "bun:test";
import {
  COVERAGE_DROP_RANK,
  coverageTierForCount,
  DEFAULT_MAX_FACTS,
  DEFAULT_OBSERVE_AFTER_TOKENS,
  estimateStringTokens,
  factId,
  FACTS_DROPPED,
  FACTS_RECORDED,
  foldFacts,
  formatRecallResult,
  normalizeSourceEntryIds,
  OBSERVER_CHUNK_FALLBACK_MAX_TOKENS,
  OBSERVER_CHUNK_MIN_TOKENS,
  parseFacts,
  rankForForgetting,
  readFacts,
  recallFact,
  renderFold,
  resolveObserveAfterTokens,
  resolveObserverChunkMaxTokens,
  resolvePreservationConfig,
  serializeSourceAddressedEntries,
  supersedeCounts,
  tokensSinceCoverage,
  type Fact,
  type LedgerEntry,
  type Relevance,
} from "../src/preservation.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function fact(content: string, options: { relevance?: Relevance; supersedes?: string[]; sources?: string[]; ts?: string } = {}): Fact {
  return {
    id: factId(content),
    content,
    relevance: options.relevance ?? "medium",
    sourceEntryIds: options.sources ?? ["entry-1"],
    supersedes: options.supersedes ?? [],
    ts: options.ts ?? "2026-08-02T00:00:00.000Z",
    tokens: estimateStringTokens(content),
  };
}

function factsEntry(id: string, facts: Fact[], coversUpToId = "entry-1", servedBy = "cheap/model"): LedgerEntry {
  return { type: "custom", id, customType: FACTS_RECORDED, data: { facts, coversUpToId, servedBy } };
}

function userEntry(id: string, text: string): LedgerEntry {
  return { type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } };
}

// ── Default OFF ─────────────────────────────────────────────────────────────────────────────────

describe("the layer is off unless it was switched on", () => {
  test("an absent section is off, with every default present", () => {
    const config = resolvePreservationConfig(undefined);
    expect(config.enabled).toBeFalse();
    expect(config.observeAfterTokens).toBe(DEFAULT_OBSERVE_AFTER_TOKENS);
    expect(config.mode).toBe("static");
    expect(config.maxFacts).toBe(DEFAULT_MAX_FACTS);
  });

  test("only a literal boolean true enables it", () => {
    // The reason this is a positive `=== true` check and not `!== false`: a truthy string or a 1 must
    // not turn on a layer that spends money in the background. An operator who typed `"true"` gets a
    // warning and an off layer, which is recoverable; a silently enabled observer is not.
    for (const value of ["true", 1, "yes", {}, [], "enabled"]) {
      expect(resolvePreservationConfig({ enabled: value }).enabled).toBeFalse();
    }
    expect(resolvePreservationConfig({ enabled: true }).enabled).toBeTrue();
  });

  test("a non-boolean enabled value is warned about rather than swallowed", () => {
    const warnings: string[] = [];
    resolvePreservationConfig({ enabled: "true" }, m => warnings.push(m));
    expect(warnings.join(" ")).toContain("must be the boolean true");
    // `false` is a legitimate way to say off, so it must NOT warn -- a warning for the documented way
    // to disable something trains an operator to ignore warnings.
    const quiet: string[] = [];
    resolvePreservationConfig({ enabled: false }, m => quiet.push(m));
    expect(quiet).toEqual([]);
  });

  test("an invalid field falls back to its default and never disables the section (MC steal 7)", () => {
    const warnings: string[] = [];
    const config = resolvePreservationConfig(
      { enabled: true, observeAfterTokens: -5, ratio: 4, maxFacts: "many", mode: "sideways", observerChunkMaxTokens: 0 },
      m => warnings.push(m),
    );
    expect(config.enabled).toBeTrue();
    expect(config.observeAfterTokens).toBe(DEFAULT_OBSERVE_AFTER_TOKENS);
    expect(config.mode).toBe("static");
    expect(config.maxFacts).toBe(DEFAULT_MAX_FACTS);
    expect(config.observerChunkMaxTokens).toBeUndefined();
    expect(warnings.length).toBe(5);
  });
});

// ── ratio mode and the chunk cap (stealList 6 and 10) ───────────────────────────────────────────

describe("ratio threshold mode", () => {
  const base = { observeAfterTokens: 10_000, ratio: 0.25 };

  test("static mode ignores the window", () => {
    expect(resolveObserveAfterTokens({ ...base, mode: "static" }, 1_000_000)).toBe(10_000);
  });

  test("ratio mode scales with the active model's window", () => {
    // The mechanism's whole point: a 1M-context model must not be observed on a 128k model's cadence.
    expect(resolveObserveAfterTokens({ ...base, mode: "ratio" }, 1_000_000)).toBe(250_000);
    expect(resolveObserveAfterTokens({ ...base, mode: "ratio" }, 128_000)).toBe(32_000);
  });

  test("ratio mode falls back to the static value when the window is unknown", () => {
    // Upstream's arm, and the honest one: a ratio of an unknown quantity is not a threshold.
    for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveObserveAfterTokens({ ...base, mode: "ratio" }, window)).toBe(10_000);
    }
  });

  test("a ratio outside (0,1) is rejected at parse time", () => {
    // Upstream's reason, quoted: 0 would never trigger, >= 1 leaves no room for the response.
    for (const ratio of [0, 1, 1.5, -0.5, Number.NaN]) {
      expect(resolvePreservationConfig({ enabled: true, ratio }).ratio).toBe(0.5);
    }
    expect(resolvePreservationConfig({ enabled: true, ratio: 0.3 }).ratio).toBe(0.3);
  });
});

describe("the observer chunk cap (the permanent-wedge fix)", () => {
  test("an explicit value wins, floored at the minimum", () => {
    expect(resolveObserverChunkMaxTokens({ observerChunkMaxTokens: 5_000 }, 200_000)).toBe(5_000);
    expect(resolveObserverChunkMaxTokens({ observerChunkMaxTokens: 10 }, 200_000)).toBe(OBSERVER_CHUNK_MIN_TOKENS);
  });

  test("otherwise it is a fifth of the worker's window, upstream's ratio", () => {
    expect(resolveObserverChunkMaxTokens({}, 200_000)).toBe(40_000);
    expect(resolveObserverChunkMaxTokens({}, 32_000)).toBe(6_400);
  });

  test("an unknown window falls back to upstream's constant", () => {
    for (const window of [undefined, 0, -1, Number.NaN]) {
      expect(resolveObserverChunkMaxTokens({}, window)).toBe(OBSERVER_CHUNK_FALLBACK_MAX_TOKENS);
    }
  });

  test("the cap stops a chunk short instead of skipping ahead, so the backlog drains oldest-first", () => {
    // THE UNWEDGE PROPERTY, which is the reason this mechanism exists at all: without it, a backlog
    // bigger than the window makes every observer call fail, coverage never advances, and the session
    // can never recover (upstream `config.ts:112-116`). The observable consequence is that a capped
    // chunk covers a PREFIX of the backlog and reports where it stopped -- so the next run resumes.
    const entries = Array.from({ length: 20 }, (_, i) => userEntry(`entry-${i}`, "x".repeat(400)));
    const first = serializeSourceAddressedEntries(entries, undefined, 300);
    expect(first.truncated).toBeTrue();
    expect(first.allowedSourceEntryIds.length).toBeGreaterThan(0);
    expect(first.allowedSourceEntryIds.length).toBeLessThan(entries.length);
    // The next run starts where this one stopped and makes further progress: drainage, not a hole.
    const second = serializeSourceAddressedEntries(entries, first.coversUpToId, 300);
    expect(second.allowedSourceEntryIds[0]).toBe(`entry-${first.allowedSourceEntryIds.length}`);
    expect(second.allowedSourceEntryIds).not.toContain(first.coversUpToId);
  });

  test("one entry larger than the whole budget is clipped rather than refused (upstream d0ebd32)", () => {
    // Without this arm the first entry never fits, the chunk is always empty, and coverage is wedged on
    // one pathological tool result forever.
    const chunk = serializeSourceAddressedEntries([userEntry("huge", "y".repeat(100_000))], undefined, 500);
    expect(chunk.truncated).toBeTrue();
    expect(chunk.allowedSourceEntryIds).toEqual(["huge"]);
    expect(chunk.coversUpToId).toBe("huge");
    expect(chunk.text).toContain("[clipped]");
    expect(chunk.text.length).toBeLessThan(100_000);
  });
});

// ── Coverage-ranked forgetting (stealList 1) ────────────────────────────────────────────────────

describe("coverage-ranked forgetting", () => {
  test("upstream's tiers, and upstream's inverted rank", () => {
    expect(coverageTierForCount(0)).toBe("none");
    expect(coverageTierForCount(1)).toBe("partial");
    expect(coverageTierForCount(2)).toBe("strong");
    expect(coverageTierForCount(9)).toBe("strong");
    // THE INVERSION IS THE INSIGHT (dive §3.1). A well-covered fact is the cheapest to lose because
    // its meaning already lives in the facts that superseded it; an uncovered one is unabsorbed, and
    // dropping it loses information outright. Getting this backwards would forget exactly the facts
    // worth keeping, which is what recency- or relevance-only policies do.
    expect(COVERAGE_DROP_RANK.strong).toBeLessThan(COVERAGE_DROP_RANK.partial);
    expect(COVERAGE_DROP_RANK.partial).toBeLessThan(COVERAGE_DROP_RANK.none);
  });

  test("supersede counts are per-fact and de-duplicated within one fact", () => {
    const a = fact("a"), b = fact("b");
    const counts = supersedeCounts([a, b, fact("c", { supersedes: [a.id, a.id] }), fact("d", { supersedes: [a.id, b.id] })]);
    expect(counts.get(a.id)).toBe(2); // two distinct facts cite it; the duplicate inside one is not double-counted
    expect(counts.get(b.id)).toBe(1);
  });

  test("a well-covered fact is dropped before an uncovered one", () => {
    const covered = fact("covered fact");
    const uncovered = fact("uncovered fact");
    const superseder1 = fact("superseder one", { supersedes: [covered.id] });
    const superseder2 = fact("superseder two", { supersedes: [covered.id] });
    const { keep, drop } = rankForForgetting([covered, uncovered, superseder1, superseder2], 3);
    expect(drop.map(f => f.id)).toEqual([covered.id]);
    expect(keep.map(f => f.id)).toContain(uncovered.id);
  });

  test("relevance breaks a coverage tie, and a critical fact outlives a low one", () => {
    const low = fact("low relevance", { relevance: "low" });
    const critical = fact("critical relevance", { relevance: "critical" });
    const { drop } = rankForForgetting([critical, low], 1);
    expect(drop.map(f => f.id)).toEqual([low.id]);
  });

  test("nothing is dropped while the fold fits", () => {
    const facts = [fact("one"), fact("two")];
    expect(rankForForgetting(facts, 10)).toEqual({ keep: facts, drop: [] });
  });

  test("kept facts stay in ledger order, not drop-rank order", () => {
    // The fold is read chronologically. Re-ordering it by drop cost would make it unreadable, and would
    // also break the "most recent fact reflects the latest state" rule the preamble states.
    const facts = ["a", "b", "c", "d"].map(c => fact(c));
    const { keep } = rankForForgetting(facts, 2);
    const order = facts.map(f => f.id);
    expect(keep.map(f => order.indexOf(f.id))).toEqual([...keep.map(f => order.indexOf(f.id))].sort((x, y) => x - y));
  });
});

// ── The fold (stealList 2) ──────────────────────────────────────────────────────────────────────

describe("the deterministic fold", () => {
  test("no facts renders nothing at all", () => {
    // This is the property the whole off-by-default guarantee rests on downstream: an empty fold means
    // the handler passes `event.customInstructions` through untouched.
    expect(foldFacts([], 10)).toEqual({ text: "", factCount: 0, droppedCount: 0, tokens: 0 });
    expect(renderFold([], 10).text).toBe("");
  });

  test("each fact appears with its id, timestamp and relevance", () => {
    const one = fact("the router owns selection, pi owns the primitive", { relevance: "critical" });
    const fold = foldFacts([one], 10);
    expect(fold.text).toContain(`[${one.id}]`);
    expect(fold.text).toContain("[critical]");
    expect(fold.text).toContain(one.content);
    expect(fold.factCount).toBe(1);
  });

  test("the preamble teaches recall and bounds it", () => {
    // Upstream's bound is the half that keeps a back-channel from becoming a search engine.
    const fold = foldFacts([fact("something")], 10);
    expect(fold.text).toContain("recall tool");
    expect(fold.text).toContain("Do not use recall as broad search");
  });

  test("a fold that forgot facts says how many (never silent)", () => {
    const facts = Array.from({ length: 5 }, (_, i) => fact(`fact ${i}`));
    const fold = foldFacts(facts, 2);
    expect(fold.factCount).toBe(2);
    expect(fold.droppedCount).toBe(3);
    expect(fold.text).toContain("3 older fact(s) omitted");
    expect(fold.text).toContain("remain recallable by id");
  });

  test("the fold is recomputed from entries, not from a previous fold", () => {
    // Upstream's answer to the compression-of-compression problem: idempotent over the ledger. Two
    // renders of the same entries are byte-identical, and a render never reads its own prior output.
    const entries = [factsEntry("e1", [fact("first")]), factsEntry("e2", [fact("second")])];
    expect(renderFold(entries, 10).text).toBe(renderFold(entries, 10).text);
    expect(renderFold(entries, 10).factCount).toBe(2);
  });
});

describe("reading facts off the ledger", () => {
  test("facts accumulate across batches in order", () => {
    const { facts, coversUpToId } = readFacts([
      factsEntry("e1", [fact("alpha")], "entry-3"),
      userEntry("entry-4", "more talk"),
      factsEntry("e2", [fact("beta")], "entry-5"),
    ]);
    expect(facts.map(f => f.content)).toEqual(["alpha", "beta"]);
    expect(coversUpToId).toBe("entry-5"); // the LATEST marker, so the next run does not re-observe
  });

  test("a dropped id removes the fact from the fold but not from the record", () => {
    const gone = fact("dropped fact");
    const entries = [
      factsEntry("e1", [gone, fact("kept fact")]),
      { type: "custom", id: "e2", customType: FACTS_DROPPED, data: { factIds: [gone.id], reason: "coverage" } } as LedgerEntry,
    ];
    const { facts, dropped } = readFacts(entries);
    expect(facts.map(f => f.content)).toEqual(["kept fact"]);
    expect(dropped.has(gone.id)).toBeTrue();
    // Still recallable: lossy in the prompt, lossless on the record.
    expect(recallFact(entries, gone.id).facts.map(f => f.content)).toEqual(["dropped fact"]);
  });

  test("the same fact recorded twice is folded once (ids are content hashes)", () => {
    const twice = fact("observed in two batches");
    const { facts } = readFacts([factsEntry("e1", [twice]), factsEntry("e2", [twice])]);
    expect(facts.length).toBe(1);
  });

  test("a malformed entry is skipped, never thrown on", () => {
    // Same rule as `parseRows` in src/ledger.ts: a hand-edited session file must degrade to fewer facts
    // rather than to a failed compaction.
    const entries: LedgerEntry[] = [
      { type: "custom", id: "bad-1", customType: FACTS_RECORDED, data: "not an object" },
      { type: "custom", id: "bad-2", customType: FACTS_RECORDED, data: { facts: "not an array" } },
      { type: "custom", id: "bad-3", customType: FACTS_RECORDED, data: { facts: [{ id: "nope", content: "bad id" }, { id: "a".repeat(12), content: "" }] } },
      factsEntry("good", [fact("survivor")]),
    ];
    expect(readFacts(entries).facts.map(f => f.content)).toEqual(["survivor"]);
  });

  test("a foreign custom entry is not read as ours", () => {
    // POM writes `om.observations.recorded`. Namespaced types are what keep a co-installed package's
    // entries out of our fold.
    const entries: LedgerEntry[] = [{ type: "custom", id: "pom", customType: "om.observations.recorded", data: { observations: [{ id: "a".repeat(12), content: "theirs" }] } }];
    expect(readFacts(entries).facts).toEqual([]);
  });
});

describe("tokens since the coverage marker", () => {
  test("only entries after the marker are counted", () => {
    const entries = [userEntry("e1", "x".repeat(4_000)), userEntry("e2", "y".repeat(4_000)), userEntry("e3", "z".repeat(4_000))];
    const all = tokensSinceCoverage(entries, undefined);
    const afterFirst = tokensSinceCoverage(entries, "e1");
    expect(all).toBeGreaterThan(afterFirst);
    expect(tokensSinceCoverage(entries, "e3")).toBe(0);
  });

  test("a marker that is no longer on the branch counts everything rather than nothing", () => {
    // The safe direction: over-counting means one extra observer pass, under-counting means a
    // permanently unobserved prefix.
    const entries = [userEntry("e1", "x".repeat(4_000))];
    expect(tokensSinceCoverage(entries, "vanished")).toBe(tokensSinceCoverage(entries, undefined));
  });

  test("custom entries our own layer wrote are not counted as new mass", () => {
    // Otherwise recording facts would itself push the backlog over the threshold and the observer would
    // trigger on its own output forever.
    const entries = [factsEntry("f1", [fact("a fact")]), factsEntry("f2", [fact("another")])];
    expect(tokensSinceCoverage(entries, undefined)).toBe(0);
  });
});

// ── The citation guard (stealList 4) ────────────────────────────────────────────────────────────

describe("code-enforced source-id citation", () => {
  test("upstream's allowlist semantics, exactly", () => {
    const allowed = ["e1", "e2", "e3"];
    expect(normalizeSourceEntryIds(["e2", "e1"], allowed)).toEqual(["e1", "e2"]); // sorted into allowlist order
    expect(normalizeSourceEntryIds(["e1", "e1"], allowed)).toEqual(["e1"]);       // de-duplicated
    expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();                  // empty rejects
    expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
    // ONE bad id rejects the WHOLE record -- upstream's strict choice, kept. A fact citing one real and
    // one invented source is not two-thirds trustworthy; it is a fact whose provenance was invented.
    expect(normalizeSourceEntryIds(["e1", "invented"], allowed)).toBeUndefined();
  });

  test("a fact citing an invented id is discarded, not stored with the bad id stripped", () => {
    const text = [
      "FACT | high | e1 | - | the estimator uses pi's own serializer",
      "FACT | high | e1,made-up | - | this one invented a source",
      "FACT | high | not-real | - | so did this one",
    ].join("\n");
    const parsed = parseFacts(text, ["e1", "e2"]);
    expect(parsed.facts.map(f => f.content)).toEqual(["the estimator uses pi's own serializer"]);
    expect(parsed.rejected).toBe(2);
  });

  test("a malformed or unparseable line is rejected rather than half-read", () => {
    const parsed = parseFacts([
      "FACT | high | e1 | - | good",
      "FACT | high | e1",                    // too few fields
      "FACT | sideways | e1 | - | bad relevance",
      "FACT | high | e1 | - |   ",           // empty content
      "Here are the facts:",                 // prose the worker prefixed
      "",
    ].join("\n"), ["e1"]);
    expect(parsed.facts.map(f => f.content)).toEqual(["good"]);
    expect(parsed.rejected).toBe(3); // the prose line and the blank are ignored, not rejected
  });

  test("content containing a pipe survives, because the content field is the remainder", () => {
    const parsed = parseFacts("FACT | medium | e1 | - | run `a | b` to reproduce", ["e1"]);
    expect(parsed.facts[0]?.content).toBe("run `a | b` to reproduce");
  });

  test("duplicates within one batch are counted, not stored twice", () => {
    const parsed = parseFacts(["FACT | low | e1 | - | same", "FACT | low | e1 | - | same"].join("\n"), ["e1"]);
    expect(parsed.facts.length).toBe(1);
    expect(parsed.duplicates).toBe(1);
  });

  test("supersedes is id-shaped-filtered but NOT allowlist-checked", () => {
    // Deliberate asymmetry, and the comment in `parseFacts` says why: `supersedes` names earlier FACT
    // ids (content hashes from other batches), not source entries. A stale one costs a coverage tier,
    // never a fabricated provenance -- so filtering it by shape is enough, and checking it against the
    // source allowlist would reject every legitimate cross-batch supersede.
    const earlier = factId("an earlier fact");
    const parsed = parseFacts(`FACT | high | e1 | ${earlier},not-an-id | - it supersedes`, ["e1"]);
    expect(parsed.facts[0]?.supersedes).toEqual([earlier]);
  });

  test("over-long content is truncated with the truncation named", () => {
    const parsed = parseFacts(`FACT | low | e1 | - | ${"z".repeat(20_000)}`, ["e1"]);
    expect(parsed.facts[0]?.content).toContain("[truncated");
    expect(parsed.facts[0]?.content.length).toBeLessThan(20_000);
  });

  test("an id is a 12-hex content hash, so the same content always hashes the same", () => {
    expect(factId("stable")).toBe(factId("stable"));
    expect(factId("stable")).toMatch(/^[a-f0-9]{12}$/);
    expect(factId("stable")).not.toBe(factId("different"));
  });
});

// ── recall (stealList 3) ────────────────────────────────────────────────────────────────────────

describe("recall: id to verbatim source", () => {
  const source = userEntry("entry-7", "the operator said: never touch ~/.pi/agent");
  const recorded = fact("the operator forbade touching ~/.pi/agent", { sources: ["entry-7"] });
  const entries = [source, factsEntry("f1", [recorded])];

  test("a round trip returns the fact and its verbatim source", () => {
    const result = recallFact(entries, recorded.id);
    expect(result.status).toBe("ok");
    expect(result.facts.map(f => f.content)).toEqual([recorded.content]);
    expect(result.sources.map(s => s.id)).toEqual(["entry-7"]);
    // VERBATIM is the point: the original wording, not the fact's paraphrase of it.
    expect(result.sources[0]?.text).toContain("never touch ~/.pi/agent");
    expect(formatRecallResult(result)).toContain("never touch ~/.pi/agent");
  });

  test("a malformed id says so instead of returning nothing found", () => {
    // Different operator action: a bad id is a typo, a missing one is a branch problem. An uppercase
    // id is NOT malformed -- it is lowercased before the shape check, because a model copying an id out
    // of a rendered fold should not fail on case.
    for (const bad of ["", "short", "not-hex-chars", "a".repeat(13), "zzzzzzzzzzzz"]) {
      const result = recallFact(entries, bad);
      expect(result.status).toBe("invalid_id");
      expect(result.message).toContain("12 hexadecimal");
    }
  });

  test("an id nobody recorded is not_found", () => {
    const result = recallFact(entries, "0".repeat(12));
    expect(result.status).toBe("not_found");
    expect(result.message).toContain("different session branch");
  });

  test("a source entry gone from the branch is source_unavailable, not an empty success", () => {
    // Upstream's outcome, kept because an empty answer and a missing source are different facts.
    const orphan = fact("cited an entry that is gone", { sources: ["entry-vanished"] });
    const result = recallFact([factsEntry("f1", [orphan])], orphan.id);
    expect(result.status).toBe("source_unavailable");
    expect(result.missingSourceEntryIds).toEqual(["entry-vanished"]);
    expect(result.facts.map(f => f.content)).toEqual([orphan.content]);
    expect(result.message).toContain("no longer on this branch");
  });

  test("a truncated-hash collision returns every match and flags it", () => {
    // Ids are 12-hex truncations, so collisions are possible. Returning one arbitrary match would be a
    // silent wrong answer; upstream returns all and says so.
    const shared = "abcdef012345";
    const one: Fact = { ...fact("first colliding fact"), id: shared };
    const two: Fact = { ...fact("second colliding fact"), id: shared };
    const result = recallFact([source, factsEntry("f1", [one, two])], shared);
    expect(result.collision).toBeTrue();
    expect(result.facts.length).toBe(2);
    expect(result.message).toContain("collision");
  });

  test("a fact dropped from the fold is still recallable, and says it was dropped", () => {
    const gone = fact("forgotten from the fold", { sources: ["entry-7"] });
    const result = recallFact([
      source,
      factsEntry("f1", [gone]),
      { type: "custom", id: "d1", customType: FACTS_DROPPED, data: { factIds: [gone.id], reason: "coverage" } } as LedgerEntry,
    ], gone.id);
    expect(result.status).toBe("ok");
    expect(result.dropped).toBeTrue();
    expect(formatRecallResult(result)).toContain("dropped from the active fold, still recorded");
  });

  test("recall is case- and whitespace-tolerant on the id", () => {
    // A model copying an id out of a rendered fold should not fail on stray whitespace.
    expect(recallFact(entries, `  ${recorded.id.toUpperCase()}  `).status).toBe("ok");
  });
});

// ── Source-addressed chunking ───────────────────────────────────────────────────────────────────

describe("the source-addressed chunk", () => {
  test("each entry is labelled with the id a fact is allowed to cite", () => {
    const chunk = serializeSourceAddressedEntries([userEntry("e1", "hello"), userEntry("e2", "world")], undefined, 10_000);
    expect(chunk.text).toContain("[Source entry id: e1]");
    expect(chunk.text).toContain("[Source entry id: e2]");
    expect(chunk.allowedSourceEntryIds).toEqual(["e1", "e2"]);
    expect(chunk.coversUpToId).toBe("e2");
    expect(chunk.truncated).toBeFalse();
  });

  test("non-source entries and empty renders are skipped", () => {
    const chunk = serializeSourceAddressedEntries([
      { type: "thinking_level_change", id: "t1" } as LedgerEntry,
      factsEntry("f1", [fact("our own entry")]),
      userEntry("e1", "  "),
      userEntry("e2", "real content"),
    ], undefined, 10_000);
    expect(chunk.allowedSourceEntryIds).toEqual(["e2"]);
  });

  test("assistant thinking and tool results are included, with their roles named", () => {
    const chunk = serializeSourceAddressedEntries([
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "considering" }, { type: "text", text: "answering" }] } },
      { type: "message", id: "t1", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }] } },
    ] as LedgerEntry[], undefined, 10_000);
    expect(chunk.text).toContain("[Assistant]");
    expect(chunk.text).toContain("considering");
    expect(chunk.text).toContain("Tool result: read");
  });
});
