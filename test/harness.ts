/**
 * A fake pi host for driving the real extension handlers.
 *
 * One rule, learned the hard way: the preparation this harness builds always uses pi's real
 * `CompactionPreparation` field names and carries real mass by default (see
 * `fixtures/real-mass.ts`). The four handler tests that existed before this file passed a
 * `{ messages: [] }` preparation, which is not pi's shape, and so never exercised the estimator at
 * all -- which is how a 3.7x-37.9x over-count shipped under a green suite.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreparation, type PreparationOptions } from "./fixtures/real-mass.js";

export interface Notice { message: string; level: string }
export interface WidgetCall { key: string; content: string[] | undefined }

/**
 * A throwaway agent dir whose global settings configure the router, so `loadConfig` finds real
 * config. Never `~/.pi`: `PI_CODING_AGENT_DIR` is redirected for the duration of the call.
 */
export function agentDirWith(settings: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "router-agent-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  return dir;
}

export function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "router-project-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/**
 * Models the piece of pi's interactive mode this package's operator-visibility fix turns on.
 *
 * Verified on our pinned 0.81.1: `ui.notify` is a `chatContainer` child
 * (`interactive-mode.js:3185-3189`); `compaction_end` with a result runs `chatContainer.clear()`
 * then `rebuildChatFromMessages()` (`interactive-mode.js:2481-2485`); `ui.setWidget` writes to
 * `extensionWidgetsAbove`/`Below`, separate containers the rebuild never touches
 * (`interactive-mode.js:1455-1470`). So `clear()` destroys notifies and spares widgets, and this
 * class reproduces exactly that asymmetry.
 */
export class FakeInteractiveUI {
  readonly notices: Notice[] = [];
  readonly widgetCalls: WidgetCall[] = [];
  /** What an operator can actually still read. `clear()` empties this; widgets are not in it. */
  chatContainer: string[] = [];
  private widgets = new Map<string, string[]>();

  notify = (message: string, level = "info"): void => {
    this.notices.push({ message, level });
    this.chatContainer.push(message);
  };

  setWidget = (key: string, content: string[] | undefined): void => {
    this.widgetCalls.push({ key, content });
    if (content === undefined) this.widgets.delete(key);
    else this.widgets.set(key, content);
  };

  /** Pi's post-compaction chat rebuild, the step that destroyed the old warning. */
  clearAndRebuildChat(): void {
    this.chatContainer = [];
  }

  /** Everything an operator can read after the rebuild: surviving widgets plus surviving chat. */
  visibleText(): string {
    return [...[...this.widgets.values()].flat(), ...this.chatContainer].join("\n");
  }

  widgetKeys(): string[] {
    return [...this.widgets.keys()];
  }
}

export interface HostOptions {
  /** Router settings written under the `compactionRouter` key. */
  routerConfig: unknown;
  /** Other top-level pi settings, e.g. `retry`. */
  hostSettings?: Record<string, unknown>;
  /** What `modelRegistry.find` returns. `null` makes every target unavailable. */
  findModel?: unknown;
  /** What `modelRegistry.getApiKeyAndHeaders` returns. Defaults to unauthenticated. */
  auth?: unknown;
  sessionId?: string;
  /** Omit the ui entirely, to model a non-interactive host. */
  withoutUI?: boolean;
}

export interface Host {
  emit(event: string, event_: unknown): Promise<unknown>;
  hasHandler(name: string): boolean;
  readonly ui: FakeInteractiveUI;
  readonly ctx: Record<string, unknown>;
}

/**
 * Load the extension against a fake host. `loader` exists so a caller can install a module mock
 * before `src/index.ts` is imported.
 */
export async function withHost<T>(
  options: HostOptions,
  body: (host: Host) => Promise<T> | T,
  loader: () => Promise<{ default: unknown }> = () => import("../src/index.js"),
): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirWith({ ...options.hostSettings, compactionRouter: options.routerConfig });
  try {
    const mod = await loader();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    (mod.default as (pi: unknown) => void)({
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      registerCommand: () => {},
      addCommand: () => {},
      addTool: () => {},
      sendMessage: () => {},
    });

    const ui = new FakeInteractiveUI();
    const ctx: Record<string, unknown> = {
      cwd: projectDir(),
      sessionManager: { getSessionId: () => options.sessionId ?? "test-session", getSessionFile: () => null },
      isProjectTrusted: () => false,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
      modelRegistry: {
        find: () => options.findModel ?? null,
        getApiKeyAndHeaders: async () => options.auth ?? { ok: false, error: "no credentials in this test" },
      },
    };
    if (!options.withoutUI) ctx.ui = ui;

    const host: Host = {
      emit: async (name, event_) => {
        const handler = handlers.get(name);
        if (!handler) throw new Error(`no handler registered for '${name}'`);
        return await handler(event_, ctx);
      },
      hasHandler: name => handlers.has(name),
      ui,
      ctx,
    };
    return await body(host);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

/** A `session_before_compact` event whose preparation carries real mass by default. */
export function beforeCompactEvent(options: PreparationOptions & { reason?: string; aborted?: boolean; willRetry?: boolean } = {}): Record<string, unknown> {
  return {
    type: "session_before_compact",
    reason: options.reason ?? "manual",
    preparation: buildPreparation(options),
    branchEntries: [],
    customInstructions: undefined,
    willRetry: options.willRetry ?? false,
    signal: { aborted: options.aborted ?? false },
  };
}

/** A `session_compact` event for the compaction pi has just committed. */
export function compactEvent(options: { fromExtension?: boolean; reason?: string; willRetry?: boolean } = {}): Record<string, unknown> {
  return {
    type: "session_compact",
    compactionEntry: { type: "compaction", id: "entry-compaction", summary: "a summary", firstKeptEntryId: "entry-first-kept", tokensBefore: 1, fromHook: options.fromExtension ?? false },
    fromExtension: options.fromExtension ?? false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}
