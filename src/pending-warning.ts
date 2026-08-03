/**
 * Per-session stash for a fail-open warning that must outlive the compaction it describes.
 *
 * Upstream: https://github.com/algal/pi-openai-server-compaction (src/state.ts, the
 * `PendingCompactionWarning` trio: `setPendingCompactionWarning` /
 * `takePendingCompactionWarning` / `clearPendingCompactionWarning`), read at PR #7 head
 * 9ea79cb89fecca4c7ab09739530ee78a654cd32f. MIT, Copyright (c) 2026 Alexis Gallagher.
 *
 * Adapted, not vendored: the upstream module also caches OpenAI continuation, remote-compaction
 * and request-shape state, none of which exists here; the warning payload carries our
 * `routedByExtension` discriminator instead of upstream's `textOnlyFallback`. The take-and-delete
 * read and the "a session id keys everything" shape are upstream's, and the reason the stash has
 * to exist at all is upstream's finding -- see the WHY below.
 *
 * WHY a stash instead of notifying directly. Verified against our own pinned 0.81.1, not taken on
 * upstream's word:
 *
 *   - `ui.notify(msg, "warning")` reaches `showWarning`, which does `chatContainer.addChild(...)`
 *     (`dist/modes/interactive/interactive-mode.js:3185-3189`).
 *   - On `compaction_end` with a result, interactive mode runs `this.chatContainer.clear()` and
 *     then `rebuildChatFromMessages()` (`interactive-mode.js:2481-2485`).
 *   - `ui.setWidget` reaches `setExtensionWidget`, which writes to `extensionWidgetsAbove` /
 *     `extensionWidgetsBelow` -- separate containers the rebuild never touches
 *     (`interactive-mode.js:1455-1470`).
 *
 * Our fail-open warning is raised inside `session_before_compact`, which pi emits strictly before
 * `appendCompaction`, `session_compact` and `compaction_end` (`dist/core/agent-session.js:1390`,
 * `1434`, `1440`, `1457`). So the one event the README singles out as needing operator visibility --
 * "compaction was NOT routed" -- was being added to a container pi then clears, on the success path,
 * every time. Stash it here during the before-hook; emit it as a widget from `session_compact`,
 * where the committed entry is known and the container survives.
 */

/** A fail-open warning raised during `session_before_compact`, awaiting the committed compaction. */
export interface PendingWarning {
  /** Lines to render in the widget. Pi renders at most 10 (`InteractiveMode.MAX_WIDGET_LINES`). */
  lines: string[];
  /**
   * The outcome the warning asserts: that no routed target served this compaction, so pi's active
   * model did. `session_compact` re-checks it against the entry pi actually committed and drops the
   * warning if the asserted outcome did not happen, so a stale stash can never accuse a compaction
   * that in fact routed fine.
   */
  routedByExtension: false;
}

const pendingBySessionId = new Map<string, PendingWarning>();

export function setPendingWarning(sessionId: string, warning: PendingWarning): void {
  pendingBySessionId.set(sessionId, warning);
}

/** Reads and removes the pending warning, so it can never be emitted twice. */
export function takePendingWarning(sessionId: string): PendingWarning | undefined {
  const warning = pendingBySessionId.get(sessionId);
  pendingBySessionId.delete(sessionId);
  return warning;
}

export function clearPendingWarning(sessionId: string | undefined): void {
  if (!sessionId) return;
  pendingBySessionId.delete(sessionId);
}
