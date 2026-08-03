/**
 * HOOK-COLLISION DETECTION — the one-owner rule, and the case where the rule was already broken.
 *
 * Upstream: https://github.com/cortexkit/magic-context, read at commit
 * 7d2230612a22d28f01c38d88e2578cb0c0ffaf2c (MIT, Copyright (c) 2025 ualtinok). Two things are taken,
 * and neither is a line of its code.
 *
 *  1. `packages/pi-plugin/src/fail-closed-pi.test.ts`'s `createFakePi()` shape: a fake `pi` whose
 *     `on()` accumulates handlers into a `Map<string, Handler[]>` and whose `emit()` runs the whole
 *     list, so a test can assert on the REGISTERED SET rather than on one handler's return. Upstream
 *     uses it to prove its own canceller fires; the same shape is what makes "exactly one
 *     `session_before_compact` handler" an assertion instead of an aspiration. `test/harness.ts`
 *     keeps a `Map<string, handler>` (last-writer-wins), which structurally cannot see a second
 *     registration -- so the collision test builds its own multi-handler host.
 *  2. The finding that made the rule necessary: pi's dispatcher
 *     (`dist/core/extensions/runner.js:565-594`, quoted in `dive--cortexkit-pi-magic-context.md`)
 *     runs EVERY registered handler for a `session_before_*` event, keeps the last truthy result, and
 *     short-circuits the whole loop on `result.cancel`. So two `session_before_compact` owners are
 *     not "both do overlapping things" -- they are mutually destructive, and which one wins is load
 *     order. Upstream's own monorepo records the same collision from the other side
 *     (`packages/e2e-tests/tests/pi-cache-stability.test.ts:576`, a FIXME that native compaction is
 *     cancelled by `session_before_compact`).
 *
 * WHY this is source and not only a test. `assertSingleCompactionOwner` is exported so the reviewed
 * profile is checkable from outside this suite (pi-lab's manifest gate reads it), and
 * `detectForeignSummary` runs at RUNTIME on the `session_compact` path: install-time arbitration does
 * not exist in pi 0.81.1, so the only honest posture is to detect the loss after the fact and say so.
 * See `dive-akitaonrails-ai-memory.md`'s "latent override hazard" and verdict §5.1.
 */

/** The hook this package owns exclusively, spelled as pi's event name. */
export const COMPACTION_HOOK = "session_before_compact";

/**
 * The manifest slot name for that hook, spelled as pi-lab's registry spells it
 * (`manifests/profile.json:11` -> `pi-compaction-router`). Kept beside the event name deliberately:
 * they are different strings for the same ownership and a reader should see both.
 */
export const COMPACTION_SLOT = "session-before-compact";

/**
 * Packages known to contend for this hook, with what each one does when it wins.
 *
 * A closed, cited list rather than a heuristic. Every entry was measured in its own dive, and the
 * `effect` is what the operator loses -- which is the part a warning has to be able to say.
 */
export const KNOWN_CONTENDERS: readonly { package: string; effect: string }[] = [
  { package: "pi-magic-context", effect: "returns {cancel: true} unconditionally, so compaction never happens and a routed summary is discarded" },
  { package: "pi-blackhole", effect: "returns its own extractive summary; last writer by manifest order wins" },
  { package: "pi-observational-memory", effect: "returns its own deterministic fold; last writer by manifest order wins" },
  { package: "accordion", effect: "cancels compaction while its GUI is attached" },
];

export interface OwnerViolation {
  /** How many handlers were registered for the hook. */
  count: number;
  message: string;
}

/**
 * Assert that the profile under review registers exactly ONE `session_before_compact` handler.
 *
 * `handlerCounts` is a map from event name to how many handlers that event has, which is what a
 * multi-handler fake host (or a real `ExtensionRunner`'s handler map) can produce. Returns `null` when
 * the invariant holds, so a caller reads it as "no violation" rather than having to interpret a
 * boolean.
 *
 * Zero is a violation as much as two is, and for a reason worth stating: this package IS the reviewed
 * owner of the slot, so a profile where nothing registered the hook is a profile where this package
 * failed to load -- which looks exactly like normal operation from the outside, because pi's native
 * compaction carries on.
 */
export function assertSingleCompactionOwner(handlerCounts: ReadonlyMap<string, number>): OwnerViolation | null {
  const count = handlerCounts.get(COMPACTION_HOOK) ?? 0;
  if (count === 1) return null;
  if (count === 0) {
    return { count, message: `No extension registered '${COMPACTION_HOOK}'. This package owns the '${COMPACTION_SLOT}' slot, so a profile with zero owners means it did not load; Pi's native compaction continues on the active model, silently.` };
  }
  return {
    count,
    message: `${count} extensions registered '${COMPACTION_HOOK}', which Pi does not arbitrate: it runs every handler, keeps the last truthy result, and short-circuits the whole loop on {cancel: true}. Which one wins is load order. Co-installing another owner is unsupported -- see docs and NOTICE. Known contenders: ${KNOWN_CONTENDERS.map(c => c.package).join(", ")}.`,
  };
}

/**
 * A compaction pi committed by SOMEONE ELSE'S handler, on a compaction this package took part in.
 *
 * This is the runtime half, and the hazard it names is the one install-time checks cannot reach.
 * Two facts meet here, and neither alone is enough:
 *
 *  - `event.fromExtension` -- pi's own record that SOME extension's handler returned the compaction
 *    (`fromHook` on the entry, `dist/core/session-manager.js:803`);
 *  - `ourOutcome` -- what OUR before-hook resolved to for this same compaction, which only we know.
 *    `undefined` means it never resolved at all.
 *
 * THE `undefined` CASE IS DELIBERATELY NOT A VIOLATION, and that is the whole reason this takes the
 * outcome rather than a boolean. Our hook does not resolve when this package is disabled or
 * unconfigured (`configFor` returns null and the handler returns immediately). In that state another
 * extension owning compaction is not a collision, it is the operator's configuration -- warning about
 * it would fire on every compaction of every host that installed us and then turned us off. So a
 * violation requires that we were actually in the running.
 *
 * `routed` is likewise not a violation: we produced the summary and pi committed an extension's
 * summary, which agrees. Every other resolved outcome (`fell-back`, `no-targets`, `aborted`) means we
 * returned nothing, so `fromExtension: true` alongside it can only be another owner's return value --
 * and on the `fell-back` path that is the expensive case, because we may have paid a provider for a
 * summary that was then discarded.
 *
 * What pi cannot tell us, and this therefore does not claim: WHICH extension. `fromHook` is a
 * boolean, there is no producer field, so the message names the candidates from `KNOWN_CONTENDERS`
 * and says the attribution is unresolved rather than accusing a package on evidence that cannot
 * support it.
 *
 * The inverse case (`!fromExtension` while we routed) is NOT reported here: that is the fail-open
 * path, which `src/pending-warning.ts` already reports in the operator's language.
 */
export function detectForeignSummary(event: { fromExtension: boolean }, ourOutcome: string | undefined): OwnerViolation | null {
  if (!event.fromExtension) return null;
  if (ourOutcome === undefined || ourOutcome === "routed") return null;
  return {
    // One override observed. `count` is the violation's size, not a handler tally, and 2 is the
    // smallest number of owners that produces this observation.
    count: 2,
    message: `A compaction was committed by ANOTHER extension's ${COMPACTION_HOOK} handler: Pi reports fromExtension: true, while this package resolved '${ourOutcome}' and returned no summary of its own. Pi records only THAT an extension produced a summary, never which, so the producer cannot be named from the session. This package owns the '${COMPACTION_SLOT}' slot and co-install with another owner is unsupported. Candidates: ${KNOWN_CONTENDERS.map(c => c.package).join(", ")}.`,
  };
}
