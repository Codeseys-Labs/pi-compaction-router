/**
 * Failure-reason-gated route-chain advance.
 *
 * Upstream: https://github.com/cortexkit/pi-magic-context, `packages/pi-plugin/src/subagent-runner.ts`
 * `isFallbackEligible` -- advance to the next model only on
 * `model_failed | truncated | non_zero_exit | no_assistant`, and stop the chain on anything else. Read
 * at commit 7d2230612a22d28f01c38d88e2578cb0c0ffaf2c. MIT, Copyright (c) 2026 cortexkit.
 *
 * WHY. This package advanced the chain on EVERY thrown error. A bad `customInstructions`, a
 * non-retryable 400, a malformed request -- each one burned the whole route list, one target at a
 * time, making the same request four ways and getting the same 400 four times. Then it fell open to
 * pi's active model, which got the same 400. Upstream's insight is that a fallback chain is only
 * meaningful for failures that are ABOUT THE TARGET; a failure about the request travels with the
 * request and the next target inherits it.
 *
 * Adapted: upstream's four reason strings are its own runner's vocabulary (it spawns subagent
 * processes, hence `non_zero_exit`). Ours is the `FailureClass` in `src/retry.ts`, which is the same
 * taxonomy shifted to what a `compact()` call can produce. The rule -- an explicit allow-list of
 * advance-eligible classes, everything else stops -- is upstream's, and so is its direction: an
 * unrecognised failure must NOT advance. A closed list that errs toward stopping is what stops a
 * whole route list burning on one bad request.
 */

import type { Classification, FailureClass } from "./retry.js";

/**
 * The failure classes that earn the next target a turn.
 *
 * `retryable`: the target is down or throttled and `src/retry.ts` already gave it its retries; a
 * different provider may well be up. `quota`: this target is out of budget, which says nothing about
 * the next one -- the single strongest case for advancing. `rate-limited-past-ceiling`: the target
 * asked for longer than we will wait, and reaching the next target instead is the entire point of the
 * ceiling. `permanent`: a defect in how THIS target was reached (unavailable model, bad thinking level
 * for this provider, a 400 the next provider may not raise). Upstream advances on its `model_failed`
 * for the same reason.
 *
 * Deliberately NOT here: `aborted` -- the operator cancelled, and trying three more models is the
 * opposite of what they asked for. `stale-context` -- pi replaced the session; there is no longer a
 * session to compact, so every further target would fail identically.
 */
const ADVANCE_ELIGIBLE: readonly FailureClass[] = ["retryable", "rate-limited-past-ceiling", "quota", "permanent"];

/** Whether a classified failure lets the chain move to the next target. */
export function advancesChain(classification: Pick<Classification, "kind">): boolean {
  return ADVANCE_ELIGIBLE.includes(classification.kind);
}

/** Why a chain stopped where it did, for the operator-visible report and the ledger. */
export interface ChainStop {
  /** `exhausted`: every target was tried. `halted`: a failure class that forbids advancing. */
  kind: "exhausted" | "halted";
  /** The class that halted it, absent when the chain simply ran out of targets. */
  failure?: FailureClass;
  message: string;
}

export function chainHalt(classification: Classification): ChainStop {
  // Switched rather than if/else: an `else` here would report a future non-advancing class as "pi
  // replaced the session", which is a confident, wrong explanation -- the worst kind for an operator
  // reading a durable banner. An unrecognised class says only what is known.
  let message: string;
  switch (classification.kind) {
    case "aborted":
      message = "the compaction was aborted, so no further route target was tried";
      break;
    case "stale-context":
      message = `pi replaced the session while compacting (${classification.message}), so no further route target was tried`;
      break;
    default:
      message = `a ${classification.kind} failure (${classification.message}) stopped the route chain, so no further target was tried`;
  }
  return { kind: "halted", failure: classification.kind, message };
}

export function chainExhausted(attempted: number): ChainStop {
  return { kind: "exhausted", message: `all ${attempted} route target(s) were tried and none served the compaction` };
}
