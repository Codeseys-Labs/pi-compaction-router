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
import { initTheme } from "@earendil-works/pi-coding-agent";
import { buildPreparation, type PreparationOptions } from "./fixtures/real-mass.js";

/**
 * Give the process a theme, so `getSettingsListTheme()` does not throw inside a `custom()` callback.
 *
 * This models pi's own startup, which calls `initTheme(...)` before it ever builds a TUI component
 * (`dist/cli/startup-ui.js`, `createStartupTui`). Without it, `getSettingsListTheme()` raises
 * "Theme not initialized. Call initTheme() first." -- the third sharp edge in
 * `pi-settings-ui-surface.md`, and the reason the config command fetches its theme inside the callback
 * and gates on `ctx.mode === "tui"` rather than importing one at module scope.
 *
 * Calling it here is what makes the settings dialog drivable headlessly. It is a global, and it is
 * called once per module load rather than per test, deliberately: `initTheme` falls back to "dark"
 * silently on any failure, so it cannot throw and cannot leave the process without a theme.
 */
initTheme("dark");

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

  // ── The settings-dialog half (W4) ─────────────────────────────────────────────────────────────
  //
  // `custom()` and `editor()` are how the interactive config surface reaches an operator, and both are
  // modelled here rather than stubbed away, because the properties W4 owes -- that the command is gated
  // on TUI mode, that the advanced row still reaches the editor, that closing the dialog is what
  // triggers the write -- are all properties of WHEN these get called.

  /** Every `ctx.ui.editor` call, so a test can prove the raw-JSON escape hatch was reached. */
  readonly editorCalls: Array<{ title: string; prefill?: string }> = [];
  /** What the next `editor()` returns. `undefined` models the operator cancelling. */
  editorResult: string | undefined = undefined;
  /** Every `ctx.ui.custom` call, so a test can prove the dialog was (or was not) opened. */
  customCalls = 0;
  /**
   * Drives the component `custom()` builds. Receives the same `(tui, theme, keybindings, done)` the
   * real one does, then hands the built component to `driveCustom` so a test can feed it keystrokes.
   *
   * `done` resolves the `custom()` promise, exactly as pi's does -- which is what lets the command's
   * post-dialog code (validate, write, notify) run in the test.
   */
  driveCustom: ((component: DrivableComponent) => void) | undefined = undefined;

  editor = async (title: string, prefill?: string): Promise<string | undefined> => {
    this.editorCalls.push({ title, prefill });
    return this.editorResult;
  };

  custom = async <T>(factory: CustomFactory<T>): Promise<T | undefined> => {
    this.customCalls++;
    let settled = false;
    let result: T | undefined;
    // A minimal `tui`: `requestRender` is the only method the components under test call, and counting
    // it proves a state change asked for a repaint rather than sitting invisible.
    const tui = { requestRender: () => { this.renderRequests++; } };
    const component = factory(tui, FAKE_THEME, FAKE_KEYBINDINGS, (value: T) => {
      if (settled) return;
      settled = true;
      result = value;
    });
    this.driveCustom?.(component);
    return result;
  };

  renderRequests = 0;
}

/** The shape `ctx.ui.custom` returns and this harness drives. */
export interface DrivableComponent {
  render(width: number): string[];
  invalidate?(): void;
  handleInput?(data: string): void;
}

export type CustomFactory<T> = (
  tui: { requestRender: () => void },
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => DrivableComponent;

/**
 * A stand-in for pi's `Theme`. The components under test never touch it -- they take their
 * `SettingsListTheme`/`SelectListTheme` from `getSettingsListTheme()`/`getSelectListTheme()` inside the
 * callback -- but `custom()`'s signature passes one, so the harness has to supply something.
 */
const FAKE_THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown;
const FAKE_KEYBINDINGS = {} as unknown;

/** The real key bytes, shared with `test/settings-ui.test.ts`. */
export const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", backspace: "\x7f" } as const;

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
  /**
   * Reuse an existing scratch agent dir instead of minting a fresh one, so two `withHost` calls can
   * share persisted state -- which is the only way to prove a cooldown SURVIVES a session. Must still
   * be a scratch dir; nothing in this suite may point at `~/.pi`.
   */
  agentDir?: string;
  /**
   * `ctx.mode`. Defaults to `"tui"` so the interactive config surface is reachable; set `"rpc"` to prove
   * the mode gate refuses. Note that `hasUI` stays true for `"rpc"`, which is the whole point of gating
   * on `mode` rather than `hasUI` -- an RPC host has dialogs but no terminal to draw a component on.
   */
  mode?: "tui" | "rpc" | "print";
  /** `ctx.isProjectTrusted()`. Defaults to false, matching the pre-W4 harness. */
  projectTrusted?: boolean;
  /** `ctx.cwd`. Defaults to a fresh scratch project dir. */
  cwd?: string;
  /** What the registry reports for `getAvailable()`, for the settings dialog's provider/model lists. */
  availableModels?: Array<{ id: string; provider: string; name?: string; contextWindow?: number; reasoning?: boolean }>;
  /**
   * The W5 observer's model call, injected. Omit it and the extension keeps its live implementation --
   * which is exactly what the default-off test wants, because it proves the observer made no call
   * without a stub standing in for the thing that would have made one.
   */
  workerCall?: (request: WorkerRequest) => Promise<string>;
  /**
   * What `ctx.sessionManager.getBranch()` returns: the session's entry list, which is where recorded
   * facts live. Defaults to empty, which is what a session with no observations has.
   */
  branch?: unknown[];
  /** `ctx.model`. Pass `null` to model a host with no active model. */
  model?: unknown;
  /** `ctx.signal`, for the abort paths. */
  signal?: { aborted: boolean };
}

/** The request shape `src/observer.ts` hands its injected `WorkerCall`. Mirrored, not imported, so a
 * test can assert on the fields without the harness depending on the module under test. */
export interface WorkerRequest {
  model: { provider: string; id: string; contextWindow?: number; maxTokens?: number };
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  thinkingLevel?: string;
  auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  signal?: unknown;
}

/** What a registered tool's `execute` returns, as the harness surfaces it. */
export interface ToolOutcome {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface Host {
  emit(event: string, event_: unknown): Promise<unknown>;
  hasHandler(name: string): boolean;
  /** Every event name the extension registered a handler for. */
  handlerNames(): string[];
  /** Every slash command the extension registered. */
  commandNames(): string[];
  /** Drive a registered slash command against the same ctx the handlers get. */
  runCommand(name: string, args?: string): Promise<unknown>;
  /**
   * Every tool the extension registered via `pi.registerTool`.
   *
   * The harness used to offer a no-op `addTool`, which is not a method pi's `ExtensionAPI` has at all
   * (`registerTool` is, `loader.js:195`). A no-op under the wrong name meant a real
   * `pi.registerTool` call crashed every handler test with `is not a function` -- so the stub was
   * worse than nothing, and the correct name is modelled here rather than absorbed.
   */
  toolNames(): string[];
  /** Drive a registered tool against the same ctx the handlers get. */
  runTool(name: string, params: unknown): Promise<ToolOutcome>;
  readonly ui: FakeInteractiveUI;
  readonly ctx: Record<string, unknown>;
  /**
   * The throwaway agent dir this host redirected `PI_CODING_AGENT_DIR` to -- where `getAgentDir()`
   * resolves, and so where both the ledger and the cooldown file are written.
   *
   * Exposed so a test can read the artifact the code actually produced instead of being told a path,
   * and -- more to the point -- so it can assert on WHERE. `~/.pi` is the operator's real home; a
   * suite that wrote a cooldown or a ledger row into it would be corrupting live state to prove a
   * feature works. NEVER `~/.pi`.
   */
  readonly agentDir: string;
  /** Every `pi.appendEntry` the extension made -- the session-scoped mirror of a settings write. */
  readonly entries: ReadonlyArray<{ customType: string; data: unknown }>;
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
  const agentDir = options.agentDir ?? agentDirWith({ ...options.hostSettings, compactionRouter: options.routerConfig });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const mod = await loader();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    type ToolSpec = { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolOutcome> };
    const tools = new Map<string, ToolSpec>();
    /** Every `pi.appendEntry` call, so a test can prove the session mirror was written. */
    const entries: Array<{ customType: string; data: unknown }> = [];
    (mod.default as (pi: unknown, extra?: unknown) => void)(
      {
        on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
        registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, spec.handler),
        // Pi's real name for this, and the one `src/index.ts` calls. See `Host.toolNames`.
        registerTool: (spec: ToolSpec) => tools.set(spec.name, spec),
        addCommand: () => {},
        sendMessage: () => {},
        appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
      },
      // The W5 seam: an injected worker call, so the observer never reaches a network and a test can
      // count invocations. Absent unless a test supplies one, which is what lets the default-off test
      // assert that the extension made no call rather than that a stub was never configured.
      options.workerCall ? { workerCall: options.workerCall } : undefined,
    );

    const ui = new FakeInteractiveUI();
    const available = options.availableModels ?? [];
    const ctx: Record<string, unknown> = {
      cwd: options.cwd ?? projectDir(),
      sessionManager: {
        getSessionId: () => options.sessionId ?? "test-session",
        getSessionFile: () => null,
        // The entry list the preservation layer folds over. Empty by default: a session that has
        // recorded nothing is the state every pre-W5 test is implicitly in.
        getBranch: () => options.branch ?? [],
      },
      isProjectTrusted: () => options.projectTrusted ?? false,
      isIdle: () => true,
      signal: options.signal,
      model: options.model === undefined ? { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 } : options.model ?? undefined,
      // `mode` defaults to "tui" so the interactive surface is reachable. `hasUI` is true for both "tui"
      // and "rpc" (pi's own rule), which is exactly why the config command gates on `mode`.
      mode: options.mode ?? "tui",
      hasUI: (options.mode ?? "tui") !== "print",
      modelRegistry: {
        // `find` prefers a real lookup against `availableModels` when the caller supplied any, so a
        // settings-dialog test gets a registry whose `find` and `getAvailable` AGREE -- validation is a
        // round-trip and a registry that disagreed with itself would make it meaningless.
        find: (provider?: string, id?: string) =>
          available.length ? available.find(m => m.provider === provider && m.id === id) ?? null : options.findModel ?? null,
        getApiKeyAndHeaders: async () => options.auth ?? { ok: false, error: "no credentials in this test" },
        getAvailable: () => available,
        getProviderDisplayName: (p: string) => p,
        getProviderAuthStatus: () => ({ configured: true, label: "TEST_KEY" }),
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
      handlerNames: () => [...handlers.keys()],
      commandNames: () => [...commands.keys()],
      runCommand: async (name, args = "") => {
        const handler = commands.get(name);
        if (!handler) throw new Error(`no command registered as '${name}'`);
        return await handler(args, ctx);
      },
      toolNames: () => [...tools.keys()],
      runTool: async (name, params) => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`no tool registered as '${name}'`);
        return await tool.execute("test-tool-call", params, undefined, undefined, ctx);
      },
      ui,
      ctx,
      agentDir,
      entries,
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

/**
 * A `session_compact` event for the compaction pi has just committed.
 *
 * `summary`, `tokensBefore` and `usage` are overridable because the ledger reads all three off the
 * committed entry -- a fixed `tokensBefore: 1` cannot exercise a savings meter.
 */
export function compactEvent(options: {
  fromExtension?: boolean;
  reason?: string;
  willRetry?: boolean;
  summary?: string;
  tokensBefore?: number;
  usage?: unknown;
} = {}): Record<string, unknown> {
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "entry-compaction",
      summary: options.summary ?? "a summary",
      firstKeptEntryId: "entry-first-kept",
      tokensBefore: options.tokensBefore ?? 1,
      fromHook: options.fromExtension ?? false,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
    fromExtension: options.fromExtension ?? false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}
