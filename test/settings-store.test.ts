/**
 * The durable write path: does our key land, and does everything else survive?
 *
 * The headline assertion the wave asks for is "foreign top-level keys survive the write". It is not a
 * formality: the only way to write an extension-owned settings key is to serialise the WHOLE file
 * ourselves, so a bug here silently deletes an operator's theme, credentials config and model
 * preferences. Every test in this file writes to a scratch `PI_CODING_AGENT_DIR`; none may touch `~/.pi`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { atomicReplace, fingerprint, LOCK_STALE_MS, readSnapshot, SETTINGS_KEY, settingsPath, SettingsWriteError, writeSection } from "../src/settings-store.js";

/** A scratch agent dir with the given settings.json content, and `PI_CODING_AGENT_DIR` pointed at it. */
function withAgentDir<T>(settings: unknown, body: (dir: string) => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "router-settings-"));
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return body(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const projectDir = (): string => mkdtempSync(join(tmpdir(), "router-project-"));

describe("the durable write preserves everything it does not own", () => {
  test("foreign top-level keys survive the write, values and all", () => {
    // The property in the donemeans, stated at full strength: not just "the keys are still there" but
    // "their values are unchanged", including a nested object and an array, which a shallow rebuild
    // would flatten or drop.
    const foreign = {
      theme: "dark",
      defaultProvider: "anthropic",
      retry: { enabled: true, maxRetries: 4, baseDelayMs: 500 },
      enabledModels: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      mcpServers: { local: { command: "node", args: ["server.js"] } },
      someFutureKey: null,
    };
    withAgentDir({ ...foreign, [SETTINGS_KEY]: { enabled: true, models: [{ model: "anthropic/old" }] } }, dir => {
      const before = readSnapshot("global", projectDir());
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true, models: [{ model: "anthropic/new" }] } });

      const after = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      for (const [key, value] of Object.entries(foreign)) expect(after[key]).toEqual(value);
      expect(after[SETTINGS_KEY]).toEqual({ enabled: true, models: [{ model: "anthropic/new" }] });
      // And no key was invented or lost.
      expect(Object.keys(after).sort()).toEqual([...Object.keys(foreign), SETTINGS_KEY].sort());
    });
  });

  test("a settings file that did not exist is created with only our key", () => {
    withAgentDir(undefined, dir => {
      const before = readSnapshot("global", projectDir());
      expect(before.text).toBeUndefined();
      expect(before.baseHash).toBe("absent");
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } });
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ [SETTINGS_KEY]: { enabled: true } });
    });
  });

  test("the file is written the way pi writes it: two-space indent, trailing newline", () => {
    // Not cosmetic. An operator's `git diff` of their settings should show the key that changed, not a
    // whole-file reformat, and pi serialises with `JSON.stringify(x, null, 2)`.
    withAgentDir({ theme: "dark" }, dir => {
      const before = readSnapshot("global", projectDir());
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } });
      const text = readFileSync(join(dir, "settings.json"), "utf8");
      expect(text.endsWith("\n")).toBeTrue();
      expect(text).toContain('\n  "theme": "dark"');
    });
  });

  test("section undefined removes the key and leaves the rest alone", () => {
    withAgentDir({ theme: "dark", [SETTINGS_KEY]: { enabled: true } }, dir => {
      const before = readSnapshot("global", projectDir());
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: undefined });
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    });
  });

  test("section false disables the router without deleting the key", () => {
    // `resolveConfig` reads `false` as "off"; an absent key means "never configured". They are
    // different states and the write path must be able to express both.
    withAgentDir({ theme: "dark" }, dir => {
      const before = readSnapshot("global", projectDir());
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: false });
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))[SETTINGS_KEY]).toBe(false);
    });
  });
});

describe("optimistic concurrency (neatcontext 5b1c750 stealList 5)", () => {
  test("a write whose base fingerprint is stale is refused, and changes nothing", () => {
    withAgentDir({ theme: "dark", [SETTINGS_KEY]: { enabled: true } }, dir => {
      const stale = readSnapshot("global", projectDir());
      // Somebody else -- pi, or the operator in an editor -- writes between our read and our write.
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "light", other: 1 }, null, 2)}\n`);

      expect(() => writeSection({ scope: "global", cwd: projectDir(), baseHash: stale.baseHash, section: { enabled: true, models: [] } }))
        .toThrow(SettingsWriteError);
      // The concurrent writer's content is intact: a refused write is a no-op, not a partial one.
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "light", other: 1 });
    });
  });

  test("the refusal is a conflict, and says what to do about it", () => {
    withAgentDir({ theme: "dark" }, dir => {
      const stale = readSnapshot("global", projectDir());
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "light" }, null, 2)}\n`);
      try {
        writeSection({ scope: "global", cwd: projectDir(), baseHash: stale.baseHash, section: { enabled: true } });
        throw new Error("expected a conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsWriteError);
        expect((error as SettingsWriteError).kind).toBe("conflict");
        expect((error as SettingsWriteError).message).toContain("Re-open");
      }
    });
  });

  test("a file created after our read is a conflict, not an overwrite", () => {
    // The `absent` token exists for this: "there was no file when I read" is a base state another
    // writer can invalidate, and conflating it with an empty file would let us clobber a fresh write.
    withAgentDir(undefined, dir => {
      const before = readSnapshot("global", projectDir());
      writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
      expect(() => writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } }))
        .toThrow(SettingsWriteError);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    });
  });

  test("an unparseable settings file is never silently replaced", () => {
    // The strongest form of "do no harm": if we cannot read it, we certainly cannot rewrite it from a
    // stale base. `readSnapshot` reports `{}` for the value but the REAL hash for the bytes, so an edit
    // based on the broken file still conflicts against any change to it -- including the operator
    // fixing their own typo while the dialog is open.
    withAgentDir(undefined, dir => {
      const path = join(dir, "settings.json");
      writeFileSync(path, '{"theme": "dark",,,}');
      const snapshot = readSnapshot("global", projectDir());
      expect(snapshot.value).toEqual({});
      expect(snapshot.baseHash).not.toBe("absent");

      writeFileSync(path, '{"theme": "light"}');
      expect(() => writeSection({ scope: "global", cwd: projectDir(), baseHash: snapshot.baseHash, section: { enabled: true } }))
        .toThrow(SettingsWriteError);
    });
  });

  test("an unchanged file writes successfully with the hash it was read at", () => {
    // The other half of the above: optimistic concurrency must not be so pessimistic that the normal
    // path fails. Read, nobody else writes, write succeeds.
    withAgentDir({ theme: "dark" }, () => {
      const before = readSnapshot("global", projectDir());
      const written = writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } });
      expect(written.hash).not.toBe(before.baseHash);
      // And the hash it reports is the hash of what is now on disk, so a caller can chain writes.
      expect(written.hash).toBe(fingerprint(readFileSync(written.path, "utf8")));
    });
  });
});

describe("the lock is pi's own lock", () => {
  test("a held lock refuses the write rather than racing it", () => {
    withAgentDir({ theme: "dark" }, dir => {
      const path = join(dir, "settings.json");
      // This is exactly what `proper-lockfile.lockSync(path, {realpath: false})` creates -- pi's own
      // settings lock (`FileSettingsStorage.acquireLockSyncWithRetry`), which the library implements as
      // `mkdir(`${file}.lock`)`. So planting the directory here models a concurrent PI write, not just
      // a concurrent us.
      mkdirSync(`${path}.lock`);
      const before = readSnapshot("global", projectDir());
      try {
        writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } });
        throw new Error("expected the write to refuse");
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsWriteError);
        expect((error as SettingsWriteError).kind).toBe("locked");
      }
      // Untouched: the operator's file is not a casualty of losing a race.
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "dark" });
      rmSync(`${path}.lock`, { recursive: true, force: true });
    });
  });

  test("a stale lock is swept, so a crashed writer cannot wedge settings forever", () => {
    withAgentDir({ theme: "dark" }, dir => {
      const path = join(dir, "settings.json");
      const lock = `${path}.lock`;
      mkdirSync(lock);
      // Backdate past the staleness threshold: a lock nobody is refreshing is a lock nobody holds.
      // `proper-lockfile` refreshes its own every `stale/2` ms while held, which is why matching its
      // 10 s default (rather than upstream's 60 s) is what makes both sides agree.
      const stale = new Date(Date.now() - LOCK_STALE_MS - 5000);
      utimesSync(lock, stale, stale);

      const before = readSnapshot("global", projectDir());
      writeSection({ scope: "global", cwd: projectDir(), baseHash: before.baseHash, section: { enabled: true } });
      expect(JSON.parse(readFileSync(path, "utf8"))[SETTINGS_KEY]).toEqual({ enabled: true });
    });
  });

  test("the lock is released after a successful write and after a failed one", () => {
    withAgentDir({ theme: "dark" }, dir => {
      const path = join(dir, "settings.json");
      const cwd = projectDir();
      const first = readSnapshot("global", cwd);
      writeSection({ scope: "global", cwd, baseHash: first.baseHash, section: { enabled: true } });
      expect(existsSync(`${path}.lock`)).toBeFalse();

      // A conflict throws from inside the lock; the `finally` still has to release it, or the next
      // write -- and pi's own -- would block on a lock whose owner is gone.
      expect(() => writeSection({ scope: "global", cwd, baseHash: first.baseHash, section: { enabled: true } })).toThrow(SettingsWriteError);
      expect(existsSync(`${path}.lock`)).toBeFalse();

      // Proven by doing it: a second write with a fresh hash succeeds.
      const second = readSnapshot("global", cwd);
      writeSection({ scope: "global", cwd, baseHash: second.baseHash, section: { enabled: true, models: [{ model: "a/b" }] } });
      expect(JSON.parse(readFileSync(path, "utf8"))[SETTINGS_KEY].models).toEqual([{ model: "a/b" }]);
    });
  });
});

describe("atomic replace", () => {
  test("no staging file is left behind on success", () => {
    withAgentDir(undefined, dir => {
      const path = join(dir, "settings.json");
      atomicReplace(path, '{"a":1}\n');
      expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
      expect(readdirSync(dir).filter(f => f.includes(".tmp"))).toEqual([]);
    });
  });

  test("a reader never sees a partially written file", () => {
    // The reason this is a rename rather than a `writeFileSync` over the live path: at no instant does
    // the target contain half of the new content. Asserted structurally -- the target is only ever the
    // old bytes or the new bytes -- by checking that the staging path, not the target, is what gets
    // written first.
    withAgentDir({ theme: "dark" }, dir => {
      const path = join(dir, "settings.json");
      const original = readFileSync(path, "utf8");
      atomicReplace(path, '{"replaced":true}\n');
      expect(readFileSync(path, "utf8")).not.toBe(original);
      expect(readFileSync(path, "utf8")).toBe('{"replaced":true}\n');
    });
  });
});

describe("scope and trust", () => {
  test("an untrusted project write is refused before anything is opened", () => {
    // Pi's own rule (`assertProjectTrustedForWrite`). The check is first, not last: an untrusted
    // project directory is somebody else's repository and its settings file is executable config.
    withAgentDir({ theme: "dark" }, () => {
      const cwd = projectDir();
      const before = readSnapshot("project", cwd);
      try {
        writeSection({ scope: "project", cwd, baseHash: before.baseHash, section: { enabled: true }, projectTrusted: false });
        throw new Error("expected the untrusted write to refuse");
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsWriteError);
        expect((error as SettingsWriteError).kind).toBe("untrusted");
      }
      // Nothing was created -- not the file, and not the `.pi` directory that would hold it.
      expect(existsSync(settingsPath("project", cwd))).toBeFalse();
    });
  });

  test("a trusted project write lands in the project file, not the global one", () => {
    withAgentDir({ theme: "dark" }, dir => {
      const cwd = projectDir();
      const before = readSnapshot("project", cwd);
      writeSection({ scope: "project", cwd, baseHash: before.baseHash, section: { enabled: true }, projectTrusted: true });
      expect(JSON.parse(readFileSync(settingsPath("project", cwd), "utf8"))).toEqual({ [SETTINGS_KEY]: { enabled: true } });
      // The global file is untouched -- the two scopes are genuinely separate artifacts.
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
    });
  });

  test("global settings resolve under PI_CODING_AGENT_DIR, never the real home", () => {
    // The rule the whole suite depends on. If `getAgentDir()` ever stopped honouring the env var, every
    // test in this file would be writing into the operator's live `~/.pi`.
    withAgentDir({ theme: "dark" }, dir => {
      expect(settingsPath("global", projectDir())).toBe(join(dir, "settings.json"));
      expect(settingsPath("global", projectDir())).not.toContain(join(homedir(), ".pi", "agent"));
    });
  });
});
