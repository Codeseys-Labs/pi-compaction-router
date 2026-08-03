/**
 * A `compact()` stub, installed through the loader seam `withHost` already exposes.
 *
 * Why this is a module and not a `beforeAll`. Bun's `mock.module` is PROCESS-WIDE: a stubbed
 * `compact` left installed leaks into every test file bun loads afterwards, which is exactly why
 * `retry-parity.test.ts` restores the real module in an `afterAll`. Routing it through one place
 * means one restore to remember, and `load()`'s spread of the real namespace means a stubbed module
 * keeps every other export -- `getAgentDir`, `serializeConversation`, `estimateTokens` -- so the
 * code under test is only altered where the test intends.
 *
 * The stub exists because the routed path calls a real `compact()`, which would make a network call
 * with the harness's fake credentials. Everything else on that path is real.
 */

import { mock } from "bun:test";
import * as pi from "@earendil-works/pi-coding-agent";

/** Install `impl` as `compact()` and return the freshly evaluated extension module. */
export async function load(impl: (...args: unknown[]) => unknown): Promise<{ default: unknown }> {
  mock.module("@earendil-works/pi-coding-agent", () => ({ ...pi, compact: impl }));
  return await import("../../src/index.js");
}

/** Put the real module back. Every file that calls `load()` owes this in an `afterAll`. */
export function restore(): void {
  mock.module("@earendil-works/pi-coding-agent", () => ({ ...pi }));
}
