/**
 * The durable write path for this package's own settings key.
 *
 * Upstream: https://github.com/XTSoftwareLabs/neatcontext-plugins,
 * `plugins/pi/neatcontext/src/core/lite-context.mjs` (`fingerprintLite`, `requireCurrentBase`,
 * `acquireUpdateLock` with its `UPDATE_LOCK_STALE_MS` staleness sweep, `replaceLiteDirectory`, and
 * the `updateCapturedLite` sequence that checks the base fingerprint TWICE -- once at prepare and
 * again inside the lock before any write). Read at commit
 * `5b1c750aed83da604c93814081b9daf7267d39f7`. MIT, Copyright (c) 2026 XTSoftwareLabs.
 *
 * WHY this file exists, and why it is not one `writeFileSync`.
 *
 * Pi exposes no generic `set(key, value)`. Its `SettingsManager` has 47 setters and every one is
 * field-specific (`setTheme`, `setDefaultModel`, ...), so an extension that wants to own a top-level
 * settings key has to write the raw JSON itself. That is safe in one measured respect and unsafe in
 * another:
 *
 *  - SAFE: pi does not clobber extension-owned top-level keys when it rewrites `settings.json`. A
 *    planted `compactionRouter` key survived a `setTheme("dark")` + flush with its value intact
 *    (`pi-settings-ui-surface.md` §4b). So the key is ours to keep.
 *  - UNSAFE: `FileSettingsStorage` -- which owns pi's own `withLock` read-modify-write -- is NOT
 *    exported from the package root (verified: `undefined`). A naive read-modify-write here is
 *    therefore unsynchronised against a concurrent pi write, and the loser's edit disappears
 *    silently. That is verdict §5.6's "UI write races" risk.
 *
 * So this file takes neatcontext's whole shape for a durable artifact: a lock with a staleness
 * sweep, a fingerprint of the bytes we based our edit on, that fingerprint re-checked INSIDE the
 * lock, and a staging-file-then-rename so a reader never sees a half-written settings file.
 *
 * Adapted, not vendored:
 *
 *  - Upstream fingerprints a whole context directory (manifest fields, profile text, every knowledge
 *    file) because that is its durable artifact. Ours is one file, so `fingerprint` is a sha256 of
 *    its exact bytes -- the same optimistic-concurrency token, over the artifact we actually have.
 *    Upstream's `revision` counter has no analogue: pi owns this file's shape and would not preserve
 *    a counter we added at top level, and putting one INSIDE our own key would make the fingerprint
 *    of every write differ from the read it was based on for a reason unrelated to conflict.
 *  - Upstream's `acquireUpdateLock` is `mkdir(<liteHome>/.update-<id>.lock)` with a 60 s staleness
 *    sweep. Ours is `mkdir("<settings.json>.lock")` with the same sweep -- and that exact path is
 *    load-bearing, not cosmetic. Pi's own `FileSettingsStorage.acquireLockSyncWithRetry` calls
 *    `proper-lockfile`'s `lockSync(path, {realpath: false})`, and `proper-lockfile` implements a lock
 *    as `mkdir(`${file}.lock`)` -- "Use mkdir to create the lockfile (atomic operation)",
 *    `lib/lockfile.js:28-29`. So `mkdir` of that path from `node:fs` is the SAME primitive on the
 *    SAME path, and the exclusion is mutual. MEASURED both directions on our pinned tree: with our
 *    directory present, `lockfile.lockSync` refused with `ELOCKED`; with pi's lock held, our `mkdir`
 *    refused with `EEXIST`; after pi released, ours succeeded. This is the one place where copying
 *    upstream's mechanism also buys interoperability with the host, and it is why the lock is
 *    `mkdir` rather than an `O_EXCL` sentinel file of our own naming.
 *  - Upstream's staleness threshold is 60 s. Ours is 10 s, because it has to agree with the other
 *    holder of this lock: `proper-lockfile`'s default `stale` is 10 000 ms (`lib/lockfile.js:208`),
 *    it refreshes the lock's mtime every `stale/2` while held, and it will BREAK a lock whose mtime
 *    is older than that. A 60 s threshold here would mean pi steals our lock at 10 s while we still
 *    believe we hold it. Matching the number is what makes both sides agree on when a lock is dead.
 *  - Upstream's `replaceLiteDirectory` renames directories with a backup and a rollback. Ours writes
 *    a sibling temp file and `renameSync`s it over the target: for a single file the rename IS the
 *    atomic commit, and the rollback upstream needs (restore the backup directory) has no analogue
 *    because nothing is destroyed until the rename succeeds. Upstream's reason for factoring it out
 *    -- "so the rollback path is directly testable" -- is honoured by keeping the fingerprint check
 *    and the replace as separate exported functions.
 *
 * Not taken: upstream's `normalizeCaptureKnowledge` allowlist (we write no model-authored paths --
 * one fixed file, whose path pi decides), and its `cp`-to-staging of a whole tree.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Our own top-level key in pi's settings. The one thing in that file this package may write. */
export const SETTINGS_KEY = "compactionRouter";

/**
 * How long a lock directory may go untouched before it is presumed abandoned.
 *
 * Upstream's `UPDATE_LOCK_STALE_MS` is 60_000. This is 10_000 to match `proper-lockfile`'s default
 * `stale`, which is what pi acquires this same lock with -- see the header. Both holders must agree
 * or the longer-waiting one gets its lock stolen mid-write.
 */
export const LOCK_STALE_MS = 10_000;

/** Bounded wait for a lock someone else legitimately holds. Pi's own retry budget is 10 x 20 ms. */
const LOCK_ATTEMPTS = 25;
const LOCK_RETRY_MS = 20;

export type SettingsScope = "global" | "project";

export class SettingsWriteError extends Error {
  constructor(
    message: string,
    /** `conflict` = the file changed under us; `locked` = someone else is writing; `io` = everything else. */
    readonly kind: "conflict" | "locked" | "io" | "untrusted",
  ) {
    super(message);
    this.name = "SettingsWriteError";
  }
}

/**
 * Where pi keeps each settings scope. Mirrors `FileSettingsStorage`'s constructor exactly
 * (`dist/core/settings-manager.js:47-50`): the global file is `<agentDir>/settings.json`, the project
 * file is `<cwd>/<CONFIG_DIR_NAME>/settings.json`.
 *
 * `CONFIG_DIR_NAME` is read from pi rather than hardcoded as `".pi"`, because a rebranded
 * distribution sets it to something else (`docs/extensions.md:948-965`), and `getAgentDir()` honours
 * `PI_CODING_AGENT_DIR` -- which is how the tests write to a scratch dir and never to `~/.pi`.
 */
export function settingsPath(scope: SettingsScope, cwd: string): string {
  return scope === "global" ? join(getAgentDir(), "settings.json") : join(cwd, CONFIG_DIR_NAME, "settings.json");
}

/**
 * The optimistic-concurrency token: a digest of the exact bytes an edit was based on.
 *
 * Upstream's `fingerprintLite` over a directory, narrowed to one file. A missing file is a legitimate
 * base state (a host that has never written settings), and it gets its own token rather than being
 * conflated with an empty one -- otherwise "the file did not exist when I read it" and "the file was
 * empty" would compare equal, and one of those is a state another writer can create.
 */
export function fingerprint(text: string | undefined): string {
  if (text === undefined) return "absent";
  return createHash("sha256").update(text).digest("hex");
}

export interface SettingsSnapshot {
  /** Raw file text, or `undefined` when the file does not exist. */
  text: string | undefined;
  /** The token to hand back to `writeSection`. */
  baseHash: string;
  /** Parsed top-level object. `{}` when the file is absent, empty, or not an object. */
  value: Record<string, unknown>;
  path: string;
}

/**
 * Read a scope for editing. Never throws on a malformed file: an unparseable `settings.json` is
 * reported as an empty object with its real `baseHash`, so the write path can still refuse to clobber
 * it (the fingerprint of the bytes we could not parse is still the fingerprint we based our edit on).
 */
export function readSnapshot(scope: SettingsScope, cwd: string): SettingsSnapshot {
  const path = settingsPath(scope, cwd);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  let value: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch {
      // Left as `{}`. The baseHash below still describes the bytes, so a write based on this snapshot
      // conflicts against any concurrent change -- including the operator fixing their own typo.
    }
  }
  return { text, baseHash: fingerprint(text), value, path };
}

/** Upstream's `requireCurrentBase`, with our own message. */
function requireCurrentBase(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SettingsWriteError(
      "Settings changed while this edit was open, so nothing was written. Re-open /compaction-router-config and apply the change again.",
      "conflict",
    );
  }
}

/**
 * Upstream's `acquireUpdateLock`: `mkdir` is the atomic primitive, `EEXIST` means someone holds it,
 * and a lock whose mtime is older than the staleness threshold is broken rather than waited on
 * forever.
 *
 * The path is `<settings.json>.lock` deliberately -- it is the same path `proper-lockfile` derives
 * for pi's own settings lock, so this excludes pi and pi excludes this. See the file header for the
 * measurement.
 *
 * Waiting is synchronous because every caller is. A settings write happens once, when an operator
 * closes a dialog; the whole budget here is half a second.
 */
function acquireLock(path: string): () => void {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lock);
      return () => {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          // A lock we cannot remove will be swept as stale by the next writer, ours or pi's.
        }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      // Upstream's staleness sweep. A crashed writer must not wedge the file forever.
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // The holder released it between our mkdir and our stat. Fall through and retry immediately.
        continue;
      }
      if (age > LOCK_STALE_MS) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          // Someone else swept it first; the retry below will find it gone.
        }
        continue;
      }
      if (attempt === LOCK_ATTEMPTS) break;
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) {
        // Synchronous sleep, for the same reason pi's own `acquireLockSyncWithRetry` uses one: not
        // being async keeps every caller of a settings write out of the async colouring problem.
      }
    }
  }
  throw new SettingsWriteError("Another process is writing pi's settings right now; nothing was written. Try again in a moment.", "locked");
}

/**
 * Replace a file atomically: write a sibling temp file, then rename it over the target.
 *
 * Upstream's `replaceLiteDirectory` in the shape a single file needs. `renameSync` within a directory
 * is atomic, so a concurrent reader sees either the old file entire or the new file entire -- never a
 * truncated one, which is what `writeFileSync` over the live path would risk. Kept separate from the
 * caller for upstream's stated reason: the failure path is then directly testable.
 */
export function atomicReplace(path: string, contents: string): void {
  const staging = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(staging, contents, "utf8");
    renameSync(staging, path);
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // Nothing was committed either way; a stray temp file is not worth masking the real error.
    }
    throw error;
  }
}

export interface WriteSectionOptions {
  scope: SettingsScope;
  cwd: string;
  /** The `baseHash` from the `readSnapshot` this edit was based on. */
  baseHash: string;
  /** The new value for our key. `false` disables the router; `undefined` removes the key entirely. */
  section: unknown;
  /** Required for `scope: "project"`. Mirrors pi's own `assertProjectTrustedForWrite`. */
  projectTrusted?: boolean;
}

/**
 * Read-modify-write our one key, preserving every other top-level key byte-for-byte in value.
 *
 * The sequence is upstream's `updateCapturedLite`, in order:
 *   1. check the base fingerprint before taking the lock (cheap rejection);
 *   2. take the lock;
 *   3. check the base fingerprint AGAIN, inside the lock -- upstream's comment is the reason:
 *      "Recheck after staging so a hand edit made during preparation is not replaced. Other save
 *      processes respect the lock; this catches everything outside that protocol." Pi's writes DO
 *      respect this lock; an operator with the file open in an editor does not;
 *   4. stage and rename;
 *   5. release in `finally`.
 *
 * Only our key is touched. Everything else is re-serialised from the object we just parsed, which is
 * how a `theme` or `defaultProvider` a test plants survives -- the property the donemeans calls
 * "foreign top-level keys survive the write".
 */
export function writeSection(options: WriteSectionOptions): { path: string; hash: string } {
  if (options.scope === "project" && !options.projectTrusted) {
    // Pi's own rule (`assertProjectTrustedForWrite`), enforced before anything is opened rather than
    // after: an untrusted project directory is somebody else's repository, and a settings file is
    // executable configuration. The UI never offers this scope without `ctx.isProjectTrusted()`.
    throw new SettingsWriteError("This project is not trusted, so project-scoped settings were not written.", "untrusted");
  }
  const path = settingsPath(options.scope, options.cwd);
  const before = readSnapshot(options.scope, options.cwd);
  requireCurrentBase(before.baseHash, options.baseHash);

  const release = acquireLock(path);
  try {
    // Re-read inside the lock. `before` was read outside it, so it can only ever be a hint.
    const current = readSnapshot(options.scope, options.cwd);
    requireCurrentBase(current.baseHash, options.baseHash);

    const next = { ...current.value };
    if (options.section === undefined) delete next[SETTINGS_KEY];
    else next[SETTINGS_KEY] = options.section;
    // `null, 2` plus a trailing newline: pi serialises its own writes as `JSON.stringify(x, null, 2)`
    // (`settings-manager.js:169, 383`), so matching it keeps an operator's diff to the key that
    // actually changed.
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    atomicReplace(path, contents);
    return { path, hash: fingerprint(contents) };
  } finally {
    release();
  }
}

/** Whether a scope's file exists at all -- for deciding what a UI can honestly offer to edit. */
export function settingsFileExists(scope: SettingsScope, cwd: string): boolean {
  return existsSync(settingsPath(scope, cwd));
}
