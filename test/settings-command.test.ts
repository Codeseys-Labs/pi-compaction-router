/**
 * `/compaction-router-config` end to end: the gates, the write, the mirror, and the escape hatch.
 *
 * The unit files prove the pieces. This one proves the COMMAND -- that the mode gate refuses a
 * non-TUI host, that an untouched dialog writes nothing, that a drill-down's pick reaches
 * `settings.json` with foreign keys intact, that the session mirror is written, and that the raw-JSON
 * editor is still reachable behind the `advanced` row rather than merely still present in the source.
 *
 * Every test runs against a scratch `PI_CODING_AGENT_DIR`. None may touch `~/.pi`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_KEY, settingsPath } from "../src/settings-store.js";
import { agentDirWith, KEYS, withHost, type DrivableComponent, type HostOptions } from "./harness.js";

const AVAILABLE = [
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { id: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", contextWindow: 1_000_000, reasoning: true },
  { id: "gpt-5", provider: "openai", name: "GPT-5", contextWindow: 400_000, reasoning: true },
];

/** A host whose registry offers real models, in TUI mode, with the router already configured. */
function options(overrides: Partial<HostOptions> = {}): HostOptions {
  return { routerConfig: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] }, availableModels: AVAILABLE, ...overrides };
}

/** Feed a key sequence to whatever component `custom()` built. */
const drive = (...keys: string[]) => (component: DrivableComponent) => { for (const key of keys) component.handleInput?.(key); };

/** Pick the first model of the first provider on the row currently selected. */
const PICK_FIRST_MODEL = [KEYS.enter, KEYS.enter, KEYS.enter];

describe("the command is gated on ctx.mode === 'tui'", () => {
  test("an RPC host is refused, even though hasUI is true there", () => {
    // The exact distinction the spec insists on. `hasUI` is true in RPC mode, so gating on it would open
    // a `custom()` with no terminal -- and `getSettingsListTheme()` throws in that situation.
    return withHost(options({ mode: "rpc" }), async host => {
      expect(host.ctx.hasUI).toBeTrue();
      await host.runCommand("compaction-router-config");
      expect(host.ui.customCalls).toBe(0);
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("interactive TUI");
      // And it tells the operator what they CAN do instead, rather than just refusing.
      expect(notice.message).toContain("'reset'");
    });
  });

  test("a print-mode host is refused too", () => {
    return withHost(options({ mode: "print" }), async host => {
      await host.runCommand("compaction-router-config");
      expect(host.ui.customCalls).toBe(0);
      expect(host.ui.notices.at(-1)!.level).toBe("error");
    });
  });

  test("a TUI host opens the dialog", () => {
    return withHost(options(), async host => {
      host.ui.driveCustom = drive(KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(host.ui.customCalls).toBe(1);
    });
  });

  test("an argument works in ANY mode, so a non-TUI host keeps the surface it had", () => {
    // The old command took override JSON as an argument and that path needs no terminal. Regressing it
    // would take a working surface away from an RPC host in the name of adding one to a TUI host.
    return withHost(options({ mode: "rpc" }), async host => {
      await host.runCommand("compaction-router-config", '{"models":[{"model":"anthropic/claude-opus-4-8"}]}');
      expect(host.ui.customCalls).toBe(0);
      expect(host.ui.notices.at(-1)!.message).toContain("applied immediately");
    });
  });

  test("'off' and 'reset' still work without a TUI", () => {
    return withHost(options({ mode: "rpc" }), async host => {
      await host.runCommand("compaction-router-config", "off");
      expect(host.ui.notices.at(-1)!.message).toContain("disabled for this session");
      await host.runCommand("compaction-router-config", "reset");
      expect(host.ui.notices.at(-1)!.message).toContain("reset to global/project settings");
    });
  });
});

describe("an untouched dialog writes nothing", () => {
  test("escaping out leaves settings.json byte-identical", () => {
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost(options({ agentDir }), async host => {
      host.ui.driveCustom = drive(KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
      expect(host.ui.notices.at(-1)!.message).toContain("unchanged");
      // And no session mirror either: nothing happened, so nothing is recorded as having happened.
      expect(host.entries).toEqual([]);
    });
  });

  test("cancelling inside the picker also writes nothing", () => {
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost(options({ agentDir }), async host => {
      // Enter opens providers, Escape closes the submenu, Escape closes the dialog.
      host.ui.driveCustom = drive(KEYS.enter, KEYS.escape, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
    });
  });
});

describe("a drill-down pick reaches settings.json", () => {
  test("the picked model lands under compactionRouter, and foreign keys survive", () => {
    // The wave's durable-write assertion, driven from the actual command rather than the store directly.
    const foreign = { theme: "dark", defaultProvider: "anthropic", retry: { enabled: true, maxRetries: 4 } };
    const agentDir = agentDirWith({ ...foreign, compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir }), async host => {
      // Row 0 is `manual`; Enter opens providers, Enter takes `anthropic`, Enter takes its first model.
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");

      const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      for (const [key, value] of Object.entries(foreign)) expect(written[key]).toEqual(value);
      const routes = written[SETTINGS_KEY].routes as Array<{ match: string; reasons: string[]; models: Array<{ model: string }> }>;
      expect(routes).toHaveLength(1);
      expect(routes[0]!.reasons).toEqual(["manual"]);
      expect(routes[0]!.models).toEqual([{ model: "anthropic/claude-sonnet-4-5" }]);
      // The pre-existing fallback chain is untouched -- only `manual` was edited.
      expect(written[SETTINGS_KEY].models).toEqual([{ model: "anthropic/claude-sonnet-4-5" }]);
    });
  });

  test("the operator is told where it landed and that it takes effect now", () => {
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("info");
      expect(notice.message).toContain("global settings updated");
      expect(notice.message).toContain(join(agentDir, "settings.json"));
      expect(notice.message).toContain("immediately");
    });
  });

  test("the session mirror is written via appendEntry", () => {
    // Replay-safe and travels with the session tree, so a resumed or forked session can see what this
    // dialog did without re-reading settings -- and it records WHEN, which a settings file does not.
    return withHost(options(), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(host.entries).toHaveLength(1);
      const entry = host.entries[0]!;
      expect(entry.customType).toBe("compaction-router-config");
      const data = entry.data as { scope: string; path: string; section: { routes: unknown } };
      expect(data.scope).toBe("global");
      expect(data.path).toContain("settings.json");
      expect(data.section.routes).toBeDefined();
    });
  });

  test("the next compaction uses the new setting, with no restart", () => {
    // The claim in the success notice, proven rather than asserted: `configFor` re-reads settings per
    // compaction, so a routing decision made after the write must see it.
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir }), async host => {
      // Pick the SECOND anthropic model (Claude Opus) for `manual`, so the new value is distinguishable.
      host.ui.driveCustom = drive(KEYS.enter, KEYS.enter, KEYS.down, KEYS.enter, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))[SETTINGS_KEY].routes[0].models)
        .toEqual([{ model: "anthropic/claude-opus-4-8" }]);

      // Now ask the status command, which reads config the same way the compaction hook does.
      await host.runCommand("compaction-router");
      expect(host.ui.notices.at(-1)!.message).toContain("manual: anthropic/claude-opus-4-8");
    });
  });

  test("an empty catalogue offers nothing to pick, and so writes nothing", () => {
    // A host with no configured credentials at all. The picker shows its placeholder row, Enter on it
    // commits nothing, and the command must reach its "unchanged" arm rather than writing an empty or
    // malformed reference.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost({ routerConfig: { enabled: true }, availableModels: [], agentDir }, async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
      expect(host.ui.notices.at(-1)!.message).toContain("unchanged");
    });
  });

  test("a pick whose model vanishes from the catalogue is refused, and writes nothing", () => {
    // Validation is a `find()` round-trip against the same registry the compaction hook will call, and
    // this is the case it exists for: the operator picks a model, and between the pick and the write the
    // catalogue no longer resolves it (a revoked credential, a provider dropped from models.json). The
    // dialog must refuse rather than persist a reference `session_before_compact` would then skip.
    //
    // Driven by swapping `getAvailable`/`find` apart AFTER the pick: `getAvailable` populated the list,
    // `find` now misses. That is exactly the shape of a catalogue that changed under the dialog.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost(options({ agentDir }), async host => {
      host.ui.driveCustom = component => {
        for (const key of PICK_FIRST_MODEL) component.handleInput?.(key);
        const registry = host.ctx.modelRegistry as { find: unknown };
        registry.find = () => undefined;
        component.handleInput?.(KEYS.escape);
      };
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("Nothing was written");
      expect(notice.message).toContain("not an available model");
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
      // And no session mirror for a write that did not happen.
      expect(host.entries).toEqual([]);
    });
  });
});

describe("the resume row writes durably too", () => {
  test("cycling resume to 'manual' persists it", () => {
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir }), async host => {
      // Rows: manual, threshold, overflow, auto-resume, advanced. Down x3 lands on auto-resume.
      host.ui.driveCustom = drive(KEYS.down, KEYS.down, KEYS.down, KEYS.enter, KEYS.escape);
      await host.runCommand("compaction-router-config");
      const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      expect(written[SETTINGS_KEY].resume).toEqual({ enabled: true, reasons: ["manual"] });
    });
  });
});

describe("the advanced row still reaches the raw-JSON editor", () => {
  test("activating it opens ctx.ui.editor, prefilled with the current configuration", () => {
    // The escape hatch is demoted, not deleted: it is the only way to author a multi-target chain, a
    // per-target thinking level, or a glob route narrower than the catch-all.
    return withHost(options(), async host => {
      host.ui.editorResult = undefined;   // the operator opens it and cancels
      // Rows: manual, threshold, overflow, auto-resume, advanced. Down x4 lands on advanced.
      host.ui.driveCustom = drive(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
      await host.runCommand("compaction-router-config");
      expect(host.ui.editorCalls).toHaveLength(1);
      const call = host.ui.editorCalls[0]!;
      expect(call.title).toContain("JSON");
      // Labelled session-scoped where the operator can read it -- the row surface writes durable
      // settings, this writes an override that dies with the session.
      expect(call.title).toContain("this session only");
      expect(JSON.parse(call.prefill!).models).toEqual([{ model: "anthropic/claude-sonnet-4-5" }]);
    });
  });

  test("JSON typed into the editor applies as a session override", () => {
    return withHost(options(), async host => {
      host.ui.editorResult = JSON.stringify({ models: [{ model: "anthropic/claude-opus-4-8", thinkingLevel: "high" }] });
      host.ui.driveCustom = drive(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
      await host.runCommand("compaction-router-config");
      expect(host.ui.notices.at(-1)!.message).toContain("applied immediately");
      // And it really is in effect, thinking level and all -- the thing the row surface cannot express.
      await host.runCommand("compaction-router");
      expect(host.ui.notices.at(-1)!.message).toContain("anthropic/claude-opus-4-8:high");
    });
  });

  test("invalid JSON is refused with the parse error, and nothing is applied", () => {
    // `parseSessionOverride`'s all-or-nothing semantics, kept (verdict §4.4).
    return withHost(options(), async host => {
      host.ui.editorResult = "{not json";
      host.ui.driveCustom = drive(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("Invalid JSON");
    });
  });

  test("opening the editor does NOT write durable settings", () => {
    // The two surfaces have different scopes and must not leak into each other: the advanced row is a
    // session override, and reaching it must not persist anything to disk.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost(options({ agentDir }), async host => {
      host.ui.editorResult = JSON.stringify({ models: [{ model: "anthropic/claude-opus-4-8" }] });
      host.ui.driveCustom = drive(KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
      await host.runCommand("compaction-router-config");
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
    });
  });

  test("a row pick made before opening the editor is not silently dropped on the floor", () => {
    // The interaction the `wantsJsonEditor` flag creates: `done()` closes the dialog for BOTH the
    // advanced row and a normal close, so the two paths have to stay distinguishable. Documented
    // behaviour, asserted: choosing the editor hands control to the editor and the pending row pick is
    // NOT written -- the editor's own result is what the operator ends up with.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    const before = readFileSync(join(agentDir, "settings.json"), "utf8");
    return withHost(options({ agentDir }), async host => {
      host.ui.editorResult = undefined;
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
      await host.runCommand("compaction-router-config");
      expect(host.ui.editorCalls).toHaveLength(1);
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
    });
  });
});

describe("project scope is gated on trust", () => {
  test("an untrusted project writes global, never the project file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "router-untrusted-"));
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir, cwd, projectTrusted: false }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))[SETTINGS_KEY].routes).toBeDefined();
      expect(existsSync(settingsPath("project", cwd))).toBeFalse();
    });
  });

  test("a trusted project with no router key of its own still writes global", () => {
    // Deliberately conservative: the UI does not CREATE project-scoped configuration. Doing so would put
    // routing config in a file that travels with the repository to everyone who clones it.
    const cwd = mkdtempSync(join(tmpdir(), "router-trusted-"));
    const agentDir = agentDirWith({ compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir, cwd, projectTrusted: true }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      expect(existsSync(settingsPath("project", cwd))).toBeFalse();
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))[SETTINGS_KEY].routes).toBeDefined();
    });
  });

  test("the dialog title names the scope it will write", () => {
    return withHost(options(), async host => {
      let title = "";
      host.ui.driveCustom = component => { title = component.render(80)[0] ?? ""; component.handleInput?.(KEYS.escape); };
      await host.runCommand("compaction-router-config");
      expect(title).toContain("global settings");
      // And the active model, because every routing decision here is relative to it.
      expect(title).toContain("anthropic/claude-sonnet-4-5");
    });
  });
});

describe("a concurrent write is reported, not lost", () => {
  test("settings changed while the dialog was open produces an error and no clobber", () => {
    // The verdict §5.6 race, exercised through the command. The fingerprint is taken when the dialog
    // opens; a write in between must refuse rather than overwrite.
    const agentDir = agentDirWith({ theme: "dark", compactionRouter: { enabled: true, models: [{ model: "anthropic/claude-sonnet-4-5" }] } });
    return withHost(options({ agentDir }), async host => {
      host.ui.driveCustom = component => {
        for (const key of PICK_FIRST_MODEL) component.handleInput?.(key);
        // Somebody else -- pi, or the operator in an editor -- writes while the dialog is up.
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light", intruder: true }, null, 2));
        component.handleInput?.(KEYS.escape);
      };
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("Settings changed while this edit was open");
      // The concurrent writer's content survived intact.
      expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ theme: "light", intruder: true });
    });
  });
});

describe("a write that would not take effect warns instead of claiming success", () => {
  test("a hand-written route that out-ranks the catch-all is reported", () => {
    // `selectTargets` takes the FIRST matching route, so an operator's `anthropic/*` beats the `*` the UI
    // writes. Without this the dialog would report success while routing kept the old model.
    const agentDir = agentDirWith({
      compactionRouter: {
        enabled: true,
        routes: [{ match: "anthropic/*", reasons: ["manual"], models: [{ model: "anthropic/claude-opus-4-8" }] }],
      },
    });
    return withHost(options({ agentDir }), async host => {
      host.ui.driveCustom = drive(...PICK_FIRST_MODEL, KEYS.escape);
      await host.runCommand("compaction-router-config");
      const notice = host.ui.notices.at(-1)!;
      expect(notice.level).toBe("warning");
      expect(notice.message).toContain("still routes to anthropic/claude-opus-4-8");
      expect(notice.message).toContain("comes first");
      // The write still happened -- the operator's intent is recorded, and the warning explains why it
      // is not yet in force. Silently discarding it would be worse.
      const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
      expect((written[SETTINGS_KEY].routes as Array<{ match: string }>).some(r => r.match === "*")).toBeTrue();
    });
  });
});
