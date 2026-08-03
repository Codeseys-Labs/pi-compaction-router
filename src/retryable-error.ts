/**
 * Retryable-error and stale-context detection.
 *
 * Upstream: https://github.com/JMHSV/pi-blackhole, `src/om/retryable-error.ts` (`RETRYABLE_ERROR_RE`,
 * `isRetryableError`, `isStaleExtensionContextError`), read at commit
 * 2bf8cda11585c21fef2e5c2d9210690d82a2f2ca. MIT, Copyright (c) 2026 the pi-blackhole authors.
 *
 * Taken as its own module because upstream keeps it as its own module, for a reason it records in
 * its own header: the regex had been copied into two call sites and the copies diverged. The same
 * hazard is live here -- `src/retry.ts` classifies a failed attempt and `src/cooldown.ts` decides
 * whether that failure earns a persisted cooldown, and those two must agree about what "transient"
 * means or a target gets cooled down for an error it will never see again.
 *
 * Adapted, not vendored: upstream also re-exports pi's context-overflow detection from
 * `@earendil-works/pi-ai` here, which a router does not need -- pi decides when to compact, we only
 * decide which model writes the summary. The patterns and the two predicates are upstream's.
 */

/**
 * Error messages that describe weather rather than a defect: the same call, made again, may work.
 *
 * Upstream's pattern, unmodified. It is deliberately message-shaped rather than status-shaped
 * because a provider SDK's thrown `Error` is often all a caller gets -- see `src/retry.ts` for the
 * structured path (`retry-after-ms`, an explicit `retryable` flag) that is preferred when available.
 */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/** The message an unknown thrown value carries, if it carries one at all. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "");
}

/** Whether an error string or `Error` describes a transient failure. */
export function isRetryableError(error: unknown): boolean {
  return RETRYABLE_ERROR_RE.test(errorMessage(error));
}

/**
 * Pi's "extension ctx is stale" error, thrown when the session behind an extension context has been
 * replaced or reloaded.
 *
 * These are not model errors, and upstream's lesson is the one that matters: they must never be
 * recorded as a cooldown. A session reload during a compaction would otherwise cool down a target
 * that did nothing wrong, and the operator would watch their best model be skipped for an hour
 * because they reloaded a session.
 */
export function isStaleExtensionContextError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("extension ctx is stale") || message.includes("ctx is stale");
}
