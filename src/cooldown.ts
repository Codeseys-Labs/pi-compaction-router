/**
 * Persisted per-target cooldowns: stop re-trying a flapping provider on every compaction.
 *
 * Upstream: https://github.com/JMHSV/pi-blackhole, `src/om/cooldown.ts` (the whole module: the
 * `{until, reason, stage}` entry shape, `cooldownPath`, `readCooldownMap`/`writeCooldownMap`,
 * `getCooldownEntry` with lazy expiry-on-read, `recordCooldown`, `expireCooldowns`, and the
 * `cooldownHours === 0` early returns) plus the in-memory `failedInCycle` half of
 * `src/om/runtime.ts` (`resolveModel`'s skip arm and `recordRetryableError`'s `cooldownHours === 0`
 * branch). Read at commit 2bf8cda11585c21fef2e5c2d9210690d82a2f2ca. MIT, Copyright (c) 2026 the
 * pi-blackhole authors.
 *
 * WHY this exists here. This package had no memory of failure at all: a rate-limited target was
 * retried on every single compaction, forever. W2's per-target retry (`src/retry.ts`) makes that
 * worse before it makes it better -- retry turns one wasted call per compaction into four. Retry and
 * cooldown are one mechanism in two halves: retry handles a blip within a compaction, cooldown
 * handles a target that is down across compactions.
 *
 * Adapted, not vendored:
 *
 *  - Upstream keys on its own `OmModelConfig` and stages `"observer" | "reflector" | "dropper"`. We
 *    key on a `provider/model` string and our stage is the compaction reason plus the failure class,
 *    which is what an operator reading the file needs to know: `{until, reason, stage}` is upstream's
 *    field set, and the fields keep their meanings.
 *  - Upstream's file is `<agentDir>/pi-blackhole/pi-blackhole-cooldown.json`; ours is
 *    `<agentDir>/pi-compaction-router/cooldown.json`. `getAgentDir()` honours
 *    `PI_CODING_AGENT_DIR`, which is how the tests write to a scratch dir and never to `~/.pi`.
 *  - Upstream reads the file on every `isCooldownActive` call and says so ("no in-memory cache
 *    needed"). Kept, deliberately: the file is a handful of entries, the read happens once per route
 *    target per compaction, and a cache would need invalidating against an operator who edits or
 *    deletes the file to un-stick a target -- which is the one recovery move they have.
 *  - `cooldownHours: 0` = in-memory only is upstream's semantic and the reason it is worth taking is
 *    upstream's too: a read-only or ephemeral home must never be forced into a disk write. Upstream
 *    scopes the in-memory set to a consolidation cycle; we scope it to a `CooldownStore` instance,
 *    which the extension holds for the process. Same guarantee -- the flapping target is skipped for
 *    the rest of this run and nothing is written.
 *
 * Every write is best-effort. A lost cooldown means slightly more API traffic on the next compaction;
 * a thrown write would mean a failed compaction. Upstream chose the same way, for the same reason.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Upstream's directory-then-file shape, under this package's own name. */
const COOLDOWN_DIR = "pi-compaction-router";
const COOLDOWN_FILE = "cooldown.json";
/** Upstream's `cooldownHours ?? 1`: what a cooldown lasts when config names no duration. */
export const DEFAULT_COOLDOWN_HOURS = 1;

/** Upstream's `CooldownEntry`, field for field. */
export interface CooldownEntry {
  /** ISO 8601. Compared against `now`, so a clock change expires or extends honestly. */
  until: string;
  /** Brief, human-readable cause. Never the full provider body -- see `src/retry.ts` `brief`. */
  reason: string;
  /**
   * Which part of the pipeline recorded it. Upstream's consolidation stage; ours is the compaction
   * reason and failure class, e.g. `"threshold/retryable"`. An operator staring at a cooled-down
   * target needs to know whether it was a rate limit during an overflow or an exhausted budget.
   */
  stage: string;
}

export type CooldownMap = Record<string, CooldownEntry>;

/** `provider/model`, the same string the config's `ModelTarget.model` carries. */
export function cooldownKey(target: string): string {
  return target.trim();
}

export function cooldownFilePath(): string {
  // Resolved per call, not memoized: `PI_CODING_AGENT_DIR` is what makes a scratch home work, and a
  // memoized path captured at import time would pin the first value the process ever saw. That is
  // exactly the bug pi-blackhole's `unified-config.ts:16-31` memo-with-env-invalidation exists to
  // avoid; not memoizing is the cheaper way to the same place.
  return join(getAgentDir(), COOLDOWN_DIR, COOLDOWN_FILE);
}

function readCooldownMap(): CooldownMap {
  const path = cooldownFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map: CooldownMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Upstream trusts the file's shape once it parses. We validate per entry instead, because a
      // half-written or hand-edited file must degrade to "this target is not cooled down" rather
      // than putting `undefined` into a `new Date()` and cooling a target down forever.
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.until !== "string") continue;
      map[key] = { until: entry.until, reason: typeof entry.reason === "string" ? entry.reason : "unknown", stage: typeof entry.stage === "string" ? entry.stage : "unknown" };
    }
    return map;
  } catch {
    // A corrupt file is not a reason to refuse to compact. Upstream's choice, kept.
    return {};
  }
}

function writeCooldownMap(map: CooldownMap): void {
  try {
    const path = cooldownFilePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    // Best-effort by design, and upstream's comment is the right one: cooldowns are advisory. Losing
    // one means a rate-limited target may be tried again next compaction -- slightly more API
    // traffic, no data loss -- and this is also what keeps a read-only filesystem from crashing a
    // compaction.
  }
}

export interface CooldownRecord {
  reason: string;
  stage: string;
  /** `0` = in-memory only for this process; `undefined` = `DEFAULT_COOLDOWN_HOURS`. */
  cooldownHours?: number;
}

/**
 * The cooldown layer as an instance, because the `cooldownHours: 0` half of it has to live somewhere
 * that is not disk.
 *
 * Upstream keeps the persisted half as module functions and the in-memory half as `failedInCycle` on
 * its runtime object. One object here, so a caller cannot consult persisted state and forget the
 * memory-only set -- which would silently un-do `cooldownHours: 0` for the case it exists to serve.
 */
export class CooldownStore {
  /** Upstream's `failedInCycle`: keys cooled down with `cooldownHours: 0`, never written to disk. */
  private readonly failedInMemory = new Set<string>();

  /**
   * The active cooldown for a target, or `undefined`. Expired entries are cleaned up LAZILY, on read,
   * which is upstream's design and the reason no timer or session hook is needed to keep the file
   * from growing without bound.
   *
   * `cooldownHours: 0` disables the persisted check entirely (upstream's early return) and consults
   * the in-memory set instead.
   */
  get(target: string, options: { cooldownHours?: number; now?: Date } = {}): CooldownEntry | undefined {
    const key = cooldownKey(target);
    if (options.cooldownHours === 0) {
      return this.failedInMemory.has(key)
        ? { until: "", reason: "failed earlier in this process (cooldown persistence disabled)", stage: "memory" }
        : undefined;
    }
    // A memory-only record from an earlier call still counts even if this call named no hours: the
    // target failed in this process and nothing has said otherwise.
    if (this.failedInMemory.has(key)) return { until: "", reason: "failed earlier in this process (cooldown persistence disabled)", stage: "memory" };

    const map = readCooldownMap();
    const entry = map[key];
    if (!entry) return undefined;
    const until = new Date(entry.until);
    if (Number.isNaN(until.getTime())) {
      // An unparseable `until` is a corrupt entry, not an eternal cooldown. Sweep it.
      delete map[key];
      writeCooldownMap(map);
      return undefined;
    }
    const now = options.now ?? new Date();
    if (now >= until) {
      delete map[key];
      writeCooldownMap(map);
      return undefined;
    }
    return entry;
  }

  isActive(target: string, options: { cooldownHours?: number; now?: Date } = {}): boolean {
    return this.get(target, options) !== undefined;
  }

  /**
   * Record a cooldown after a failure the classifier called `cooldownWorthy`.
   *
   * `cooldownHours: 0` takes the in-memory path and writes NOTHING -- upstream's
   * `recordRetryableError` branch, and the property the tests assert by checking the file does not
   * exist.
   */
  record(target: string, record: CooldownRecord, now: Date = new Date()): void {
    const key = cooldownKey(target);
    if (record.cooldownHours === 0) {
      this.failedInMemory.add(key);
      return;
    }
    const hours = record.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
    // A negative or non-finite duration would put `until` in the past and make `record` a silent
    // no-op, which is a worse outcome than the default: an operator who typed `-1` gets an hour and
    // can see the entry, rather than nothing and no explanation.
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_COOLDOWN_HOURS;
    const map = readCooldownMap();
    map[key] = { until: new Date(now.getTime() + safeHours * 3_600_000).toISOString(), reason: record.reason, stage: record.stage };
    writeCooldownMap(map);
  }

  /**
   * Sweep every expired entry. Upstream calls this on session start and config reload; lazy expiry
   * already keeps correctness, so this is hygiene for the file an operator reads.
   */
  expire(now: Date = new Date()): void {
    const map = readCooldownMap();
    let changed = false;
    for (const [key, entry] of Object.entries(map)) {
      const until = new Date(entry.until);
      if (Number.isNaN(until.getTime()) || now >= until) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) writeCooldownMap(map);
  }

  /** Everything currently on disk, expired entries included. For diagnostics and tests. */
  snapshot(): CooldownMap {
    return readCooldownMap();
  }

  /** Drop the in-memory half. A new session should not inherit the last one's memory-only skips. */
  clearMemory(): void {
    this.failedInMemory.clear();
  }
}
