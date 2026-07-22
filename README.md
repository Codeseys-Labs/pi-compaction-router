# pi-compaction-router

A Pi extension that preserves Pi's native compaction algorithm while routing summary generation to dedicated registered models. It adds ordered fallback, context-fit guards, diagnostics, and optional post-compaction continuation.

> Early v0.1 software. Pin an exact commit or release and test it in a disposable Pi home before primary use.

## Why

A large-context parent can require a large-context compactor, while smaller sessions may benefit from a faster or cheaper model. The router changes only which registered model invokes Pi's exported `compact()` function; it does not replace Pi's preparation, prompts, summary format, file-operation details, or session storage.

## Install

```bash
pi install git:github.com/baladithyab/pi-compaction-router
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

## Post-compaction continuation

Auto-resume is off by default because automatic continuation consumes tokens and can be surprising after a completed task. Enable selected reasons explicitly, or use the safer one-shot command:

```text
/compact-resume
/compact-resume Focus on exact changed files, remaining tests, and the next executable step
```

After successful compaction, the extension injects a visible custom continuation message and triggers a turn. The default message tells the agent to continue concrete work, but to verify and report completion instead of inventing work when the original task is done.

## Commands

- `/compaction-router` — show active model, routes, fallback order, thinking levels, and auto-resume policy.
- `/compact-resume [instructions]` — compact and explicitly continue.

Pi does not currently expose an extension API for adding arbitrary fields to the built-in `/settings` menu. A future release may add a package-owned interactive configuration command; v0.1 keeps configuration reviewable in JSON.

## Safety and limitations

- Install only one `session_before_compact` owner.
- Routed models use credentials already registered with Pi.
- The package performs no direct network or subprocess operations; model calls go through Pi's model registry and native compaction function.
- The context-fit estimate intentionally overestimates code-heavy input but is not exact provider tokenization.
- Model fallback after a failed provider call can incur partial provider cost.
- Automatic resume does not prove that unfinished work exists; leave it disabled if strict turn control matters.

## Development

```bash
bun install
bun run check
```

## Attribution

The native compaction integration and restoration of prior file-operation details are adapted from [JMHSV/pi-compaction-model](https://github.com/JMHSV/pi-compaction-model), MIT licensed. See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE).
