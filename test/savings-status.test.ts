/**
 * THE METER: `/compaction-router` SHOWS WHAT ROUTING ACTUALLY BOUGHT.
 *
 * This command showed configuration only -- what routing was ASKED to do. Configuration is not a
 * measurement: an operator reading it could not tell whether threshold compaction had ever fired,
 * whether any of it routed, or what it saved. The savings block is the answer, in the two-scope
 * session/project shape from AFT `566bcde` (`dive--cortexkit-aft-pi.md` stealList 4).
 *
 * Every test drives the REAL command handler through the harness and reads the notice string the
 * operator would actually see, computed from ledger rows the REAL hooks wrote. No test asserts on an
 * intermediate structure the operator never reads.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { formatSavingsRows, readSavings, type Savings } from "../src/ledger.js";
import { beforeCompactEvent, compactEvent, withHost, type Host } from "./harness.js";
import { load, restore } from "./support/stub-compact.js";

afterAll(restore);

const TARGET = "openai-codex/gpt-5.4-mini";
const ROUTER_CONFIG = { models: [{ model: TARGET, thinkingLevel: "low" }] };
const FOUND_MODEL = { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 272_000, maxTokens: 128_000 };
const GOOD_AUTH = { ok: true, apiKey: "test-key", headers: {}, env: {} };

/** A summary of `chars` characters, so `tokensAfter` is a known `chars / 4`. */
const summaryOf = (chars: number) => "s".repeat(chars);

/** Run `n` real routed compactions, then return what `/compaction-router` shows. */
async function statusAfter(compactions: Array<{ reason?: string; tokensBefore?: number; summary?: string; fromExtension?: boolean }>, options: { routerConfig?: unknown; findModel?: unknown } = {}): Promise<{ status: string; host: Host; savings: Savings }> {
  return await withHost(
    { routerConfig: options.routerConfig ?? ROUTER_CONFIG, findModel: "findModel" in options ? options.findModel : FOUND_MODEL, auth: GOOD_AUTH },
    async host => {
      for (const c of compactions) {
        await host.emit("session_before_compact", beforeCompactEvent({ reason: c.reason }));
        await host.emit("session_compact", compactEvent({ fromExtension: c.fromExtension ?? true, reason: c.reason, tokensBefore: c.tokensBefore, summary: c.summary }));
      }
      await host.runCommand("compaction-router");
      return {
        status: host.ui.notices.at(-1)!.message,
        host,
        savings: readSavings(host.agentDir, "test-session", host.ctx.cwd as string),
      };
    },
    () => load(async () => ({ summary: "a routed summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 100 })),
  );
}

describe("/compaction-router shows savings", () => {
  test("a routed compaction produces a savings block with the tokens it reclaimed", async () => {
    // 200 000 before, a 4 000-char summary => 1 000 after => 199 000 saved, 100% of 200k (rounded).
    const { status, savings } = await statusAfter([{ reason: "threshold", tokensBefore: 200_000, summary: summaryOf(4_000) }]);
    expect(savings.session.tokensBefore).toBe(200_000);
    expect(savings.session.tokensAfter).toBe(1_000);
    expect(savings.session.savingsTokens).toBe(199_000);

    // What the operator reads.
    expect(status).toContain("Session");
    expect(status).toContain("Project");
    expect(status).toContain("Tokens Saved        199,000");
    expect(status).toContain("Compaction Ratio    100%");
    // And that it was ROUTING that bought it, not merely compaction.
    expect(status).toContain("Compactions         1 (1 routed)");
    // Configuration is still there: the meter is added, not substituted.
    expect(status).toContain(`manual: ${TARGET}:low`);
  });

  test("savings accumulate across compactions", async () => {
    const { status, savings } = await statusAfter([
      { tokensBefore: 100_000, summary: summaryOf(400) },   // 100 after,  99 900 saved
      { tokensBefore: 50_000, summary: summaryOf(800) },    // 200 after,  49 800 saved
    ]);
    expect(savings.session.events).toBe(2);
    expect(savings.session.savingsTokens).toBe(149_700);
    expect(status).toContain("Tokens Saved        149,700");
    expect(status).toContain("Compactions         2 (2 routed)");
  });

  test("the ratio distinguishes a good compaction from a poor one", async () => {
    // A meter whose number does not move with the thing it measures is not a meter. Half the mass
    // reclaimed must read as 50%, not as 100%.
    const { status } = await statusAfter([{ tokensBefore: 1_000, summary: summaryOf(2_000) }]); // 500 after
    expect(status).toContain("Compaction Ratio    50%");
  });

  test("an unrouted compaction counts toward compactions but not toward routed", async () => {
    // The distinction the whole surface exists for: "what did ROUTING buy" is a different question
    // from "what did compaction buy", and pi would have done the latter anyway. A fell-back
    // compaction still saved tokens, so it belongs in the savings -- but crediting it to routing
    // would make the meter flatter its own feature.
    const { status, savings } = await statusAfter(
      [{ tokensBefore: 80_000, summary: summaryOf(400), fromExtension: false }],
      { findModel: null }, // every target unavailable => fail-open
    );
    expect(savings.session.events).toBe(1);
    expect(savings.session.routedEvents).toBe(0);
    expect(savings.session.savingsTokens).toBe(79_900);
    expect(status).toContain("Compactions         1 (0 routed)");
  });

  test("before any compaction the surface shows no savings block at all", async () => {
    // Not a row of zeroes: there is no honest number yet, and "0% saved" would read as a finding.
    const { status } = await statusAfter([]);
    expect(status).toContain(`manual: ${TARGET}:low`); // configuration still shown
    expect(status).not.toContain("Tokens Saved");
    expect(status).not.toContain("Compaction Ratio");
  });

  test("a skipped measurement is reported, not folded in as zero", async () => {
    // The honest half of the cap. An unmeasured event contributes nothing to the totals AND says so,
    // because silently folding it in as `tokensAfter: 0` would report a 100% saving for a compaction
    // nobody measured.
    const { status, savings } = await statusAfter([
      { tokensBefore: 10_000, summary: summaryOf(400) },
      { tokensBefore: 900_000, summary: "y".repeat(128 * 1024 + 1) }, // past the cap
    ]);
    expect(savings.session.events).toBe(2);
    expect(savings.session.skippedEvents).toBe(1);
    // The 900k event contributed nothing: totals are the first event's alone.
    expect(savings.session.tokensBefore).toBe(10_000);
    expect(savings.session.savingsTokens).toBe(9_900);
    expect(status).toContain("Not measured        1");
  });

  test("session and project scopes are counted separately", async () => {
    // Two sessions in one project. The project figure must include both; each session's must include
    // only its own, or a per-session meter would report the project's history as this session's work.
    await withHost(
      { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH, sessionId: "session-one" },
      async first => {
        await first.emit("session_before_compact", beforeCompactEvent());
        await first.emit("session_compact", compactEvent({ fromExtension: true, tokensBefore: 10_000, summary: summaryOf(400) }));

        // A second session, sharing this project and this agent dir.
        const project = first.ctx.cwd as string;
        await withHost(
          { routerConfig: ROUTER_CONFIG, findModel: FOUND_MODEL, auth: GOOD_AUTH, sessionId: "session-two" },
          async second => {
            process.env.PI_CODING_AGENT_DIR = first.agentDir;
            (second.ctx as { cwd: string }).cwd = project;
            await second.emit("session_before_compact", beforeCompactEvent());
            await second.emit("session_compact", compactEvent({ fromExtension: true, tokensBefore: 20_000, summary: summaryOf(400) }));

            const savings = readSavings(first.agentDir, "session-two", project);
            expect(savings.session.events).toBe(1);
            expect(savings.session.tokensBefore).toBe(20_000);
            expect(savings.project.events).toBe(2);
            expect(savings.project.tokensBefore).toBe(30_000);
          },
          () => load(async () => ({ summary: "s", firstKeptEntryId: "entry-first-kept", tokensBefore: 1 })),
        );
      },
      () => load(async () => ({ summary: "s", firstKeptEntryId: "entry-first-kept", tokensBefore: 1 })),
    );
  });

  test("another project's compactions are not counted as this one's", async () => {
    const { savings, host } = await statusAfter([{ tokensBefore: 10_000, summary: summaryOf(400) }]);
    expect(savings.project.events).toBe(1);
    expect(readSavings(host.agentDir, "test-session", "/some/other/project").project.events).toBe(0);
  });

  test("a missing ledger reads as zero rather than throwing", () => {
    // The status command must work on a host that has never compacted. An exception here would make
    // /compaction-router unusable precisely when an operator is first checking their configuration.
    const savings = readSavings("/nonexistent/agent/dir", "s", "/p");
    expect(savings.session.events).toBe(0);
    expect(formatSavingsRows(savings)).toEqual([]);
  });
});
