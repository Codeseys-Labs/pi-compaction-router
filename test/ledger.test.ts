/**
 * THE LEDGER ROW, AND THE FIELD PI DOES NOT PERSIST.
 *
 * Gap G4: this package had no meter. `session_compact` decided whether to nudge and recorded
 * nothing, and `reason` is observable ONLY on that live event -- pi's committed compaction entry has
 * no `reason` field -- so "does threshold compaction ever fire here", "was this summary routed" and
 * "what did it cost" were all unanswerable from the record.
 *
 * Every test here drives the REAL handlers through the real host harness and then reads the JSONL
 * file the code actually wrote, in a throwaway `PI_CODING_AGENT_DIR` (never `~/.pi`). Asserting on the
 * artifact rather than on a mock is the point: the ledger's whole value is that a later reader can
 * open the file, so a test that trusted an in-memory call record would not be testing the thing.
 *
 * The load-bearing assertion is `servedBy.model`. `fromHook` records only THAT an extension produced
 * a summary, never WHICH model did; that field is the one this file exists to defend.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as pi from "@earendil-works/pi-coding-agent";
import { estimateSummaryTokens, LEDGER_OUTCOMES, ledgerPath, parseRows, savingsPercent, TOKENIZE_CAP_BYTES, type LedgerRow } from "../src/ledger.js";
import { beforeCompactEvent, compactEvent, withHost, type Host } from "./harness.js";
import { restore } from "./support/stub-compact.js";

// This file installs a stubbed `compact()` via the loader seam. Bun's module mocks are process-wide,
// so the real module must go back or a stubbed compact leaks into every later test file.
afterAll(restore);

const TARGET = "openai-codex/gpt-5.4-mini";
const ROUTER_CONFIG = { models: [{ model: TARGET, thinkingLevel: "low" }] };
const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };

/** Read the rows the handlers actually wrote to this host's throwaway agent dir. */
function rowsFrom(host: Host): LedgerRow[] {
  return parseRows(readFileSync(ledgerPath(host.agentDir), "utf8"));
}

/**
 * Drive a full compaction through both hooks with `compact()` stubbed, and return the rows written.
 *
 * The stub is local to this call rather than a `mock.module` in `beforeAll` because bun's module
 * mocks are process-wide: a stubbed `compact` left installed leaks into every later test file. The
 * `loader` seam the harness already exposes gives the same effect scoped to one host.
 */
async function routedRows(options: {
  compactImpl?: (...args: unknown[]) => unknown;
  routerConfig?: unknown;
  findModel?: unknown;
  auth?: unknown;
  compactEventOptions?: Parameters<typeof compactEvent>[0];
  beforeEventOptions?: Parameters<typeof beforeCompactEvent>[0];
} = {}): Promise<{ rows: LedgerRow[]; host: Host; beforeResult: unknown }> {
  const compactImpl = options.compactImpl ?? (async () => ({ summary: "a routed summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 268_640 }));
  return await withHost(
    {
      routerConfig: options.routerConfig ?? ROUTER_CONFIG,
      // `in`, not `??`: an explicit `findModel: null` is the "every target unavailable" case, and `??`
      // would silently read it as "not provided" and hand back a model that routes fine.
      findModel: "findModel" in options ? options.findModel : FOUND_MODEL,
      auth: "auth" in options ? options.auth : GOOD_AUTH,
    },
    async host => {
      const beforeResult = await host.emit("session_before_compact", beforeCompactEvent(options.beforeEventOptions));
      await host.emit("session_compact", compactEvent({ fromExtension: true, ...options.compactEventOptions }));
      return { rows: rowsFrom(host), host, beforeResult };
    },
    () => import("./support/stub-compact.js").then(m => m.load(compactImpl)),
  );
}

describe("the JSONL ledger row", () => {
  test("carries every field the meter needs, including WHICH TARGET SERVED IT", async () => {
    const { rows } = await routedRows({
      compactEventOptions: { reason: "threshold", willRetry: false, tokensBefore: 268_640, summary: "x".repeat(4_000), usage: { input: 260_000, output: 1_200, cacheRead: 0, cacheWrite: 0, totalTokens: 261_200, cost: { input: 0.3, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.32 } } },
    });
    expect(rows.length).toBe(1);
    const row = rows[0]!;

    // The donemeans list, field by field.
    expect(row.reason).toBe("threshold");
    expect(row.willRetry).toBe(false);
    expect(row.tokensBefore).toBe(268_640);
    expect(row.window).toBe(272_000);
    expect(row.usage).toMatchObject({ input: 260_000, output: 1_200, totalTokens: 261_200 });

    // WHICH TARGET SERVED IT -- the field pi's own entry cannot give us.
    expect(row.servedBy).toEqual({ model: TARGET, thinkingLevel: "low", active: false });
    expect(row.outcome).toBe("routed");

    // And the row is a complete record on its own: a reader with only this line can place it.
    expect(row.fromExtension).toBe(true);
    expect(typeof row.ts).toBe("string");
    expect(Date.parse(row.ts)).not.toBeNaN();
    expect(row.sessionId).toBe("test-session");
    expect(typeof row.project).toBe("string");
    expect(row.tokensAfter).toBe(1_000); // 4000 chars / 4
    expect(row.tokensSkipped).toBe(false);
  });

  test("is one line of valid JSON per compaction, appended not overwritten", async () => {
    // JSONL is only useful if it is actually JSONL: appended, newline-terminated, one row per event.
    await withHost(
      { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      async host => {
        for (const reason of ["manual", "threshold", "overflow"]) {
          await host.emit("session_before_compact", beforeCompactEvent({ reason }));
          await host.emit("session_compact", compactEvent({ fromExtension: true, reason }));
        }
        const text = readFileSync(ledgerPath(host.agentDir), "utf8");
        expect(text.endsWith("\n")).toBe(true);
        const lines = text.trim().split("\n");
        expect(lines.length).toBe(3);
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
        expect(lines.map(l => JSON.parse(l).reason)).toEqual(["manual", "threshold", "overflow"]);
        // The recorded reason is the point of the row: it exists nowhere else once the event is gone.
        expect(lines.map(l => JSON.parse(l).servedBy.model)).toEqual([TARGET, TARGET, TARGET]);
      },
      () => import("./support/stub-compact.js").then(m => m.load(async () => ({ summary: "s", firstKeptEntryId: "entry-first-kept", tokensBefore: 5 }))),
    );
  });

  test("records the serving target as pi's active model when the route fell back", async () => {
    // The fail-open path. `servedBy.active` is what distinguishes "we routed it" from "pi did", and
    // an unrouted compaction otherwise looks exactly like a routed one in the record.
    const { rows } = await routedRows({
      findModel: null, // every target unavailable, so the chain exhausts
      compactEventOptions: { fromExtension: false },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("fell-back");
    expect(rows[0]!.servedBy).toEqual({ model: null, active: true });
    expect(rows[0]!.fromExtension).toBe(false);
  });

  test("records a compaction our before-hook never saw, rather than leaving a gap", async () => {
    // "Never silent" (Accordion dc037bc). A native compaction, another extension's handler, or a
    // config change between the two events all land here. An ABSENT row and a FELL-BACK row are
    // different facts; a meter that cannot tell them apart would let a reader conclude "routing was
    // never asked" from evidence that only says "we did not observe the decision".
    await withHost(
      { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      async host => {
        await host.emit("session_compact", compactEvent({ fromExtension: false, reason: "overflow", willRetry: true, tokensBefore: 999 }));
        const rows = rowsFrom(host);
        expect(rows.length).toBe(1);
        expect(rows[0]!.outcome).toBe("unobserved");
        expect(rows[0]!.reason).toBe("overflow");
        expect(rows[0]!.willRetry).toBe(true);
        expect(rows[0]!.tokensBefore).toBe(999);
        expect(rows[0]!.servedBy.active).toBe(true);
      },
    );
  });

  test("records no-targets separately from fell-back", async () => {
    // Config exists but nothing matched this reason: routing was not tried, as opposed to tried and
    // exhausted. Collapsing the two would misattribute a configuration mistake to a provider outage.
    await withHost(
      { routerConfig: { routes: [{ match: "other/*", models: [{ model: TARGET }], reasons: ["manual"] }], resume: { enabled: true, reasons: ["manual"] } }, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      async host => {
        await host.emit("session_before_compact", beforeCompactEvent({ reason: "manual" }));
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        const rows = rowsFrom(host);
        expect(rows.length).toBe(1);
        expect(rows[0]!.outcome).toBe("no-targets");
      },
    );
  });

  test("every outcome in the taxonomy is a value the code can actually produce", async () => {
    // A closed taxonomy is only closed if it is also complete. `unobserved`, `no-targets`,
    // `fell-back` and `routed` are each asserted by a test above; `aborted` is asserted below. This
    // test fails if a sixth outcome is added to the union without a test that produces it.
    expect([...LEDGER_OUTCOMES]).toEqual(["routed", "fell-back", "no-targets", "aborted", "unobserved"]);
  });

  test("an aborted compaction is not recorded as a target failure", async () => {
    // An abort is the caller's doing. Recording it as a route failure would make a user pressing
    // escape look like a flapping provider to the selection logic that reads this.
    const { rows } = await routedRows({
      compactImpl: async () => { throw new Error("aborted mid-call"); },
      beforeEventOptions: { aborted: true },
      compactEventOptions: { fromExtension: false },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("aborted");
    expect(rows[0]!.servedBy.active).toBe(true);
  });

  test("a route decision cannot be attributed to a later compaction", async () => {
    // The stash is take-and-delete, and the before-hook clears it. So a decision from a compaction
    // that never reached session_compact must not describe the next one, which would report a routed
    // compaction as having been served by a target that in fact served a compaction that never
    // committed.
    await withHost(
      { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      async host => {
        // A routed decision that never commits (no session_compact follows).
        await host.emit("session_before_compact", beforeCompactEvent());
        // Then a compaction pi commits natively, with no before-hook resolution of its own.
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        // The first decision drained into THIS row -- correctly, it is the one it belongs to.
        expect(rowsFrom(host).length).toBe(1);
        // A second native commit must not reuse it.
        await host.emit("session_compact", compactEvent({ fromExtension: false }));
        const rows = rowsFrom(host);
        expect(rows.length).toBe(2);
        expect(rows[1]!.outcome).toBe("unobserved");
        expect(rows[1]!.servedBy).toEqual({ model: null, active: true });
      },
      () => import("./support/stub-compact.js").then(m => m.load(async () => ({ summary: "s", firstKeptEntryId: "entry-first-kept", tokensBefore: 5 }))),
    );
  });

  test("records the summary's size but never its text, and no message content", async () => {
    // The README makes this claim to operators, so it is pinned here. The ledger is a meter, and a
    // meter needs magnitudes, not content -- a row that carried summary text would quietly turn a
    // telemetry file into a transcript of every compaction, including whatever was in the history.
    const secretSummary = "PRIVATE-SUMMARY-TEXT-abcdef";
    const secretHistory = "PRIVATE-HISTORY-CONTENT-123456";
    const { rows, host } = await routedRows({
      beforeEventOptions: { messagesToSummarize: [{ role: "user", content: [{ type: "text", text: secretHistory }], timestamp: 0 }] as never },
      compactEventOptions: { summary: secretSummary },
    });
    expect(rows.length).toBe(1);
    // The size was recorded, so the meter still works.
    expect(rows[0]!.tokensAfter).toBe(Math.ceil(secretSummary.length / 4));
    // Assert on the RAW FILE, not the parsed row: a stray field would be invisible to a typed read.
    const raw = readFileSync(ledgerPath(host.agentDir), "utf8");
    expect(raw).not.toContain(secretSummary);
    expect(raw).not.toContain(secretHistory);
  });

  test("a failed ledger write never breaks the compaction", async () => {
    // The posture the fail-open route path already takes, for the same reason: observability must not
    // become a new way for compaction to fail. An unwritable agent dir is the realistic trigger.
    await withHost(
      { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH },
      async host => {
        // A path component that is a FILE, not a directory, so mkdirSync throws ENOTDIR.
        process.env.PI_CODING_AGENT_DIR = `${host.agentDir}/settings.json`;
        try {
          expect(await host.emit("session_compact", compactEvent({ fromExtension: false }))).toBeUndefined();
        } finally {
          process.env.PI_CODING_AGENT_DIR = host.agentDir;
        }
      },
    );
  });
});

describe("the tokenize-cost cap and its honest flag", () => {
  test("a summary past the cap reports null tokens and tokens_skipped, never a guess", async () => {
    // AFT 566bcde's rule (registry.rs:64, :4438-4452): never fabricate a count when you declined to
    // compute one. The flag is the honest half -- a null count with no flag would read as "zero".
    const { rows } = await routedRows({
      compactEventOptions: { summary: "y".repeat(TOKENIZE_CAP_BYTES + 1) },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokensAfter).toBeNull();
    expect(rows[0]!.tokensSkipped).toBe(true);
  });

  test("the cap is measured in bytes, not characters", async () => {
    // A multi-byte summary just under the cap in characters is over it in bytes. Measuring the wrong
    // unit is how a cap silently fails to be a cap.
    const multibyte = "é".repeat(TOKENIZE_CAP_BYTES - 10); // 2 bytes each
    expect(multibyte.length).toBeLessThan(TOKENIZE_CAP_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(TOKENIZE_CAP_BYTES);
    expect(estimateSummaryTokens(multibyte)).toEqual({ tokens: null, skipped: true });
  });

  test("a summary at the cap is still measured", async () => {
    // The boundary is inclusive, so the cap does not skip work it could have done.
    expect(estimateSummaryTokens("z".repeat(TOKENIZE_CAP_BYTES))).toEqual({ tokens: TOKENIZE_CAP_BYTES / 4, skipped: false });
  });

  test("the cap is upstream AFT's value", () => {
    expect(TOKENIZE_CAP_BYTES).toBe(128 * 1024);
  });
});

describe("savingsPercent, against upstream AFT's own pinned edge cases", () => {
  // packages/aft-bridge/src/__tests__/format.test.ts:35-45 at 566bcde. Taking the function means
  // taking its edge cases, so they are re-pinned here rather than assumed.
  test("a zero original is null, not a division", () => {
    expect(savingsPercent(0, 0)).toBeNull();
  });
  test("a normal saving", () => {
    expect(savingsPercent(100, 60)).toBe(40);
  });
  test("a negative saving clamps to zero", () => {
    expect(savingsPercent(50, 80)).toBe(0);
  });
});

describe("ledger parsing robustness", () => {
  test("a truncated final line does not make the whole meter unreadable", () => {
    // A kill mid-append leaves a partial line. The rows before it are still facts.
    const good = JSON.stringify({ ts: "t", sessionId: "s", project: "p", reason: "manual", willRetry: false, fromExtension: true, outcome: "routed", servedBy: { model: "a/b", active: false }, tokensBefore: 10, tokensAfter: 2, tokensSkipped: false, window: 100, usage: null });
    const rows = parseRows(`${good}\n${good}\n{"ts":"t","sessi`);
    expect(rows.length).toBe(2);
  });

  test("a blank line is not a row", () => {
    expect(parseRows("\n\n  \n")).toEqual([]);
  });
});

/**
 * The stub must replace ONLY `compact()`. If mocking it dropped the rest of the namespace, the
 * estimator and `getAgentDir` would vanish from under the code being tested and every routed-path
 * test above would be exercising a different program than production runs.
 */
test("stubbing compact() leaves the rest of the pi module intact", async () => {
  const { load } = await import("./support/stub-compact.js");
  const stub = async () => ({ summary: "s", firstKeptEntryId: "e", tokensBefore: 1 });
  await load(stub);
  const mocked = await import("@earendil-works/pi-coding-agent");
  // Identity against the stub itself. Comparing to `pi.compact` would not discriminate: bun's
  // mock.module rewrites the module registry that the namespace import above reads from too, so
  // after `load()` the `pi` binding in this file also sees the stub.
  expect(mocked.compact).toBe(stub as unknown as typeof mocked.compact);
  // The estimator and the agent-dir resolver are on the routed path this file drives; if mocking
  // dropped them, every routed test above would be exercising a different program.
  expect(typeof mocked.serializeConversation).toBe("function");
  expect(typeof mocked.convertToLlm).toBe("function");
  expect(typeof mocked.getAgentDir).toBe("function");
});
