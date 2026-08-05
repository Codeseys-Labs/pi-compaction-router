/**
 * THE ONE-COMPACTION CARRY-FORWARD: a fallback that nobody was at the terminal to see.
 *
 * This is a sibling of `src/pending-warning.ts` and deliberately not a second payload inside it. That
 * module solves "a warning about THIS compaction is destroyed by the chat rebuild before it can be
 * read"; this one solves "a warning about the PREVIOUS compaction was correctly retracted, and the
 * fact it carried is now nowhere in view".
 *
 * THE GAP, stated narrowly, because the wide version of it is false. This package is loud at the
 * moment of failure: the fell-back path stashes a widget banner naming the targets and the cause, the
 * ledger gets an `outcome: "fell-back"` row naming `servedBy`, and `/compaction-router` shows recorded
 * target health. Measured in the 2026-08-04 fresh-user lane, all three worked. What is NOT covered:
 * `session_before_compact` retracts the banner (correctly -- it describes a compaction the new one
 * supersedes), so an operator who was away from the terminal during a fallback and whose next
 * compaction routed fine sees a clean screen and never learns a configured target is broken.
 *
 * WHY THIS IS BOUNDED AT EXACTLY ONE FOLLOWING COMPACTION, and why that is not a compromise:
 *
 *  - A PERSISTENT fault -- the reproduced case, a model coordinate the provider refuses -- fails again
 *    on the next compaction and raises its own live banner. So the carry-forward is not what reports
 *    it, and firing on top of that live banner would be a duplicate: two notices for one fact, which is
 *    how a useful notice becomes one an operator learns to dismiss unread. `carryFor` returns
 *    `undefined` for that case on purpose.
 *  - A TRANSIENT fault that self-healed is the case this exists for, and it is exactly one line long:
 *    it happened, here is the target, the record is in `/compaction-router`. It does not repeat, because
 *    after one telling the operator has been told, and a notice that stands until acknowledged is a nag
 *    with a longer name.
 *
 * State is per session and in memory, like the cooldown store's memory half and for the same reason: a
 * degradation an operator was not present for is worth one sentence in the session it happened in, and
 * is not worth a file.
 */

/** What a fallback left behind, for the next compaction to mention once. */
export interface DegradationRecord {
  /** The targets that were configured and did not serve it, as configured. Never empty. */
  targets: string[];
  /** Why the chain ended -- `ChainStop.message`, the same sentence the live banner carried. */
  cause: string;
}

const bySessionId = new Map<string, DegradationRecord>();

/** Remember that this session degraded to the active model. Replaces any earlier record: the newest
 * fallback is the one worth mentioning, and two would be a list nobody asked for. */
export function recordDegradation(sessionId: string, record: DegradationRecord): void {
  bySessionId.set(sessionId, record);
}

/** Drop the record. Called on shutdown, and after the carry line is emitted. */
export function clearDegradation(sessionId: string | undefined): void {
  if (!sessionId) return;
  bySessionId.delete(sessionId);
}

/** Whether a session is currently carrying one. For tests and for the status surface. */
export function peekDegradation(sessionId: string): DegradationRecord | undefined {
  return bySessionId.get(sessionId);
}

/**
 * The carry line for a compaction that has just been committed, or `undefined`.
 *
 * `degradedNow` is whether THIS compaction also fell back. When it did, the live banner is the report
 * and this returns nothing -- see the class comment. Reading and deleting are separate so the caller
 * decides: a `degradedNow` compaction must REPLACE the record (its own fallback is now the newest one),
 * not consume it.
 */
export function carryFor(sessionId: string, degradedNow: boolean): string[] | undefined {
  const record = bySessionId.get(sessionId);
  if (!record || degradedNow) return undefined;
  const targets = record.targets.length === 1 ? `'${record.targets[0]}'` : record.targets.map(t => `'${t}'`).join(", ");
  return [
    `[pi-compaction-router] an EARLIER compaction in this session was not routed: ${targets} did not serve it,`,
    `so Pi's active model summarized instead (${record.cause}). This one routed. Shown once, because the`,
    `banner for that compaction was retracted when this one began. '/compaction-router' has the record.`,
  ];
}
