# pi-compaction-router

A Pi extension that preserves Pi's native compaction algorithm while routing summary generation to dedicated registered models. It adds ordered fallback, context-fit guards, diagnostics, and optional post-compaction continuation.

> Early v0.1 software. Pin an exact commit or release and test it in a disposable Pi home before primary use.

## Why

A large-context parent can require a large-context compactor, while smaller sessions may benefit from a faster or cheaper model. The router changes only which registered model invokes Pi's exported `compact()` function; it does not replace Pi's preparation, prompts, summary format, file-operation details, or session storage.

## Install

```bash
pi install git:github.com/Codeseys-Labs/pi-compaction-router
```

## Configure

Add `compactionRouter` to global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`:

```json
{
  "compactionRouter": {
    "enabled": true,
    "routes": [
      {
        "match": "anthropic/*",
        "reasons": ["manual", "threshold", "overflow"],
        "models": [
          { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "low" }
        ]
      },
      {
        "match": "openai-codex/*",
        "models": [
          { "model": "openai-codex/gpt-5.4-mini", "thinkingLevel": "low" },
          { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "low" }
        ]
      }
    ],
    "models": [
      { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "low" }
    ],
    "resume": {
      "enabled": false,
      "reasons": ["manual", "threshold"]
    }
  }
}
```

- The first matching route wins.
- `models` at the router root is the fallback route.
- Each model is tried in order. If all fail, the extension returns control to Pi's native active-model handler.
- Missing models, missing authentication, and models too small for a conservative input estimate are skipped.
- `overflow` never receives an extra resume turn because Pi already retries the interrupted request.

Settings are re-read at every compaction, so global or trusted project changes take effect during the current session without `/reload`.

### Session-local configuration

Use `/compaction-router-config` to edit a JSON override for only the current session. The editor starts with the effective global/project configuration. The saved override applies immediately and is discarded at session shutdown.

```text
/compaction-router-config
/compaction-router-config off
/compaction-router-config reset
/compaction-router-config {"models":[{"model":"openai-codex/gpt-5.4-mini","thinkingLevel":"low"}]}
```

- `off` disables routing for this session.
- `reset` returns the session to live global/project settings.
- Inline JSON supports RPC and scripted use without an interactive editor.
- Invalid JSON, route entries, reasons, or thinking levels are rejected rather than partially applied.

## Post-compaction continuation

Auto-resume is off by default because automatic continuation consumes tokens and can be surprising after a completed task. Enable selected reasons explicitly, or use the safer one-shot command:

```text
/compact-resume
/compact-resume Focus on exact changed files, remaining tests, and the next executable step
```

After successful compaction, the extension injects a visible custom continuation message and triggers a turn. The default message tells the agent to continue concrete work, but to verify and report completion instead of inventing work when the original task is done.

## Commands

- `/compaction-router` — show active model, configuration source, routes, fallback order, thinking levels, and auto-resume policy.
- `/compaction-router-config [off|reset|JSON]` — edit or replace the current session's routing policy.
- `/compact-resume [instructions]` — compact and explicitly continue.

Pi does not currently expose an extension API for adding arbitrary fields to the built-in `/settings` menu. Persistent configuration remains reviewable in JSON; the package-owned command is intentionally session-scoped.

## Executed manual-compaction proof (2026-07-28)

**MEASURED — function, not merely registration.** A disposable live session used a session-local
route from active `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0` to
`amazon-bedrock/global.anthropic.claude-sonnet-5` at `low` thinking, then requested a real
**manual** compaction. The persisted session has a non-empty compaction entry with
`fromHook: true`, `tokensBefore: 481`, and usage `input: 302`, `output: 129`. The contemporaneous
CloudTrail request names `global.anthropic.claude-sonnet-5`; its service completion reports the
same 302 input / 129 output token pair. This verifies that the hook returned a real summary made
by the configured target, rather than only proving that this extension's commands register.

The raw evidence is intentionally private: `/tmp/proof/router-proof.md`,
`/tmp/proof/router-sessions/`, and `/tmp/proof/router-runtime-target-cloudtrail-command.log` on
the host that ran the proof. The session entry does not persist a provider/model field for a
compaction. Therefore the assignment of the CloudTrail request to that entry is **INFERRED, high
confidence** from the single configured target, contiguous timestamps, hook trace, and exactly
matching usage — it is not claimed as one atomic session field.

### Repeat the bounded proof

Use a disposable project and session directory; do **not** edit a live global settings file. Ensure
both the active Runtime model and this target are registered and authenticated, create one ordinary
turn, then apply this session-only configuration:

```text
/compaction-router-config {"models":[{"model":"amazon-bedrock/global.anthropic.claude-sonnet-5","thinkingLevel":"low"}]}
```

Request a manual compaction. The postcondition is **not** a successful command return: inspect the
persisted session for a non-empty `compaction` entry with `fromHook: true`, then query CloudTrail
for the compaction time window and require a request naming the target model plus a completion with
input/output usage equal to the entry's `usage`. Preserve the session, trace, and CloudTrail output
outside the repository. A trace of `session_before_compact` should show `reason: "manual"` and the
active model; a later `session_compact` trace should show `fromExtension: true`.

This result does **not** establish routing for 341k–576k-token inputs, automatic `threshold` or
`overflow` compaction, ordered fallback after an actual provider failure, or the native fallback's
runtime behavior. The tested input was 481 tokens. Treat any probe that fails before it makes a
compaction assertion as a broken probe, not evidence about the router.

## Safety and limitations

- Install only one `session_before_compact` owner.
- Routed models use credentials already registered with Pi.
- The package performs no direct network or subprocess operations; model calls go through Pi's model registry and native compaction function.
- The context-fit estimate intentionally overestimates code-heavy input but is not exact provider tokenization.
- Model fallback after a failed provider call can incur partial provider cost.
- If every configured target is skipped or throws, the hook returns control to Pi's native active-model handler: this is **fail-open**, not fail-closed. That outcome is reported to the operator as a widget above the editor, raised after the compaction commits and retracted by the next one. It is not a `notify`: Pi clears and rebuilds the chat container on `compaction_end`, which destroys anything the before-hook put there.
- Automatic resume does not prove that unfinished work exists; leave it disabled if strict turn control matters.

## Development

```bash
bun install
bun run check
```

## Attribution

The native compaction integration and restoration of prior file-operation details are adapted from [JMHSV/pi-compaction-model](https://github.com/JMHSV/pi-compaction-model), MIT licensed. See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE).
