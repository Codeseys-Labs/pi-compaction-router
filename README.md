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
    "maxRetries": 3,
    "cooldownHours": 1,
    "resume": {
      "enabled": false,
      "reasons": ["manual", "threshold"]
    }
  }
}
```

- The first matching route wins. There is no specificity ordering, so a general pattern placed before a specific one makes the specific route dead configuration — `anthropic/*` before `anthropic/claude-opus-*` means the second route is never used. The extension warns about this once per configuration and `/compaction-router` shows it.
- `models` at the router root is the fallback route.
- Each model is tried in order. If all fail, the extension returns control to Pi's native active-model handler.
- Missing models, missing authentication, and models too small to hold the summarization prompt are skipped. The fit check measures the artifact Pi actually sends — `serializeConversation(convertToLlm(...))`, in which every tool result is truncated to 2 000 characters — not the raw message objects.
- A target whose output cap cannot hold the summary Pi is about to ask for is warned about, and skipped when the shortfall is severe. Pi asks for `0.8 × reserveTokens` output tokens and silently caps that at the model's own `maxTokens`, so with a raised `reserveTokens` a small-output model truncates its summary with nothing said anywhere.
- `overflow` never receives an extra resume turn because Pi already retries the interrupted request.

### Retry and cooldowns

A failed target is now classified rather than simply abandoned:

- **Transient failures are retried on the same target** before the chain advances — `maxRetries` (default 3) attempts with exponential backoff, capped at 60 seconds per wait. Cancelling a compaction interrupts the backoff immediately rather than after it elapses.
- **Quota and billing failures are never retried.** `insufficient_quota` will not change in the next second, and spending four attempts on it costs four rate-limit windows.
- **A provider asking to be retried later than 60 seconds is failed fast**, and the chain moves to the next target. Sleeping fifteen minutes inside a compaction is worse than failing over when there is another target to reach.
- **The chain stops rather than advancing** when the failure is not about the target: a cancelled compaction, or Pi replacing the session under the extension. Both would fail identically on every remaining target.
- **A target that keeps failing is cooled down** for `cooldownHours` (default 1) and skipped by later compactions, instead of being retried on every single one. Cooldowns are recorded per `provider/model` in `<agent dir>/pi-compaction-router/cooldown.json` with the reason and the compaction stage, expire on their own, and can be cleared by deleting the file. `/compaction-router` lists the active ones.
- **`cooldownHours: 0`, per target or router-wide, keeps cooldowns in memory only** — the target is skipped for the rest of the process and nothing is written to disk. Use it on a read-only or ephemeral home.
- A misconfiguration (a bad request, an unsupported thinking level) is *not* cooled down: waiting does not fix it, and hiding the target would hide the error.

Settings are re-read at every compaction, so global or trusted project changes take effect during the current session without `/reload`.

### Interactive configuration

`/compaction-router-config` with no arguments opens a settings list: one row per compaction reason, plus auto-resume and an advanced row.

```text
manual       anthropic/claude-sonnet-4-5
threshold    (not routed)
overflow     anthropic/claude-sonnet-4-5
auto-resume  off
advanced     open editor
```

Enter on a reason row drills down — providers first, then that provider's models, with context window and reasoning shown so a model too small to hold the summarization prompt is visible before it is picked rather than after it is skipped. Typing filters the model list. Escape from the model list returns to the providers; Escape again closes the dialog.

Only providers with working credentials are listed, because the list is derived from the model catalogue Pi has already authenticated. Nothing on this path performs a network refresh.

Closing the dialog after a change writes the `compactionRouter` key of your global `settings.json`, preserving every other key in the file. The write is refused rather than applied if the file changed while the dialog was open, and the operator is told to reopen it. Routes you wrote by hand are never rewritten — the interactive surface owns only routes whose `match` is `*` — and because the first matching route wins, a hand-written route continues to take precedence. When it does, the dialog says so instead of reporting a success that routing disagrees with.

Requires the interactive TUI. Project-scoped settings are written only when the project is trusted *and* already carries a `compactionRouter` key; otherwise the write goes to global, so the dialog never creates routing configuration in a file that travels with the repository.

### Session-local configuration

The `advanced` row, and any argument to the command, reach the raw-JSON editor. That override applies immediately and is discarded at session shutdown — it is the way to author what the rows cannot express: multi-target fallback chains, per-target thinking levels and cooldowns, and glob routes narrower than a catch-all.

```text
/compaction-router-config off
/compaction-router-config reset
/compaction-router-config {"models":[{"model":"openai-codex/gpt-5.4-mini","thinkingLevel":"low"}]}
```

- `off` disables routing for this session.
- `reset` returns the session to live global/project settings.
- Inline JSON supports RPC and scripted use without an interactive editor, and works in every run mode.
- Invalid JSON, route entries, reasons, or thinking levels are rejected rather than partially applied.

## Post-compaction continuation

Auto-resume is off by default because automatic continuation consumes tokens and can be surprising after a completed task. Enable selected reasons explicitly, or use the safer one-shot command:

```text
/compact-resume
/compact-resume Focus on exact changed files, remaining tests, and the next executable step
```

After successful compaction, the extension injects a visible custom continuation message and triggers a turn. The default message tells the agent to continue concrete work, but to verify and report completion instead of inventing work when the original task is done.

## Commands

- `/compaction-router` — show active model, configuration source, routes, fallback order, thinking levels, auto-resume policy, and — once anything has been compacted — the savings meter and per-target health.
- `/compaction-router-config` — open the interactive routing settings (TUI only); with `off`, `reset` or JSON, edit the current session's override in any mode.
- `/compact-resume [instructions]` — compact and explicitly continue.

Pi does not expose an extension API for adding fields to the built-in `/settings` menu, so this package owns its own command. It does expose the components that menu is built from, and the interactive surface above uses them; configuration remains plain JSON on disk and reviewable there.

## The compaction ledger and the savings meter

Pi's persisted compaction entry records no `reason` and no serving model: `reason` exists only on the
live event, and `fromHook` says *that* an extension produced the summary, never *which model did*. So
"did threshold compaction ever fire here", "was this summary routed" and "what did it cost" were
unanswerable from the record.

Every committed compaction now appends one JSON line to
`$PI_CODING_AGENT_DIR/compaction-router/ledger.jsonl` (default `~/.pi/agent/...`), carrying `reason`,
`willRetry`, `fromExtension`, `tokensBefore`, the summary's estimated `tokensAfter`, the serving
model's context `window`, the reported `usage`, a closed `outcome`, and **`servedBy` — which target
served it**.

`outcome` is a closed taxonomy, and every committed compaction gets a row:

| outcome | meaning |
|---|---|
| `routed` | a configured target produced the summary; `servedBy.model` names it |
| `fell-back` | every target was skipped or failed, so Pi's active model served it |
| `no-targets` | configuration exists, but nothing matched this reason and active model |
| `aborted` | the caller aborted; nothing was committed through the router |
| `unobserved` | Pi committed a compaction the router's before-hook never resolved |

`unobserved` is the reason the taxonomy is worth having: an **absent** row and a **fell-back** row are
different facts, and a ledger that cannot tell them apart would let a reader conclude "routing was
never asked" from evidence that only says "the decision was not observed".

`/compaction-router` reads that file back as a session and project savings meter. Two honesty
properties are deliberate:

- **A summary larger than 128 KiB is not measured.** The row carries `tokensAfter: null` and
  `tokensSkipped: true`, the event is excluded from the totals, and the surface reports the exclusion
  as `Not measured`. A declined measurement is never reported as a zero-cost summary.
- **The meter separates routed from total.** `Compactions 3 (1 routed)` — savings from a fell-back
  compaction are real but are not routing's doing, and crediting them to routing would make the meter
  flatter the feature it measures.

The ledger rotates at 1 MiB keeping one generation, and a ledger that cannot be written is a lost
measurement rather than a failed compaction.

## Provider health is recorded, never probed

`/compaction-router` also shows per-target health — the outcome of the last call to each target the
router actually made. Nothing here probes: no warm-up, no reachability check, no timer, no call of its
own. A target acquires a status only by having been used, and a configured target that has never been
reached does not appear at all.

This matters because targets are paid endpoints and compaction fires on a hook the operator did not
initiate: a probe would spend real money and quota to learn what the next real compaction reports for
free, for targets that may never be used. `test/provider-health.test.ts` enforces it by driving every
handler and command the extension registers and asserting that only `session_before_compact` ever
reaches the model registry.

The record is currently an input for future target deprioritisation, not a decision: nothing here
reorders a route chain today.

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
- The package performs no direct network or subprocess operations; model calls go through Pi's model registry and native compaction function. Its only write is the append-only ledger under `$PI_CODING_AGENT_DIR/compaction-router/`, and a failed ledger write is swallowed after one warning rather than failing the compaction.
- The ledger records the summary's *size*, never its text, and no message content. It does record the project path and the configured target names.
- The context-fit estimate still rounds up (characters ÷ 4, the same heuristic Pi uses) and is not exact provider tokenization. It is a fit guard, not billing.
- Model fallback after a failed provider call can incur partial provider cost.
- Routed compactions are passed the host's own `settings.retry` policy, so a transient stream drop is retried before the route advances — the same policy Pi's native compaction runs with.
- If every configured target is skipped or throws, the hook returns control to Pi's native active-model handler: this is **fail-open**, not fail-closed. That outcome is reported to the operator as a widget above the editor, raised after the compaction commits and retracted by the next one. It is not a `notify`: Pi clears and rebuilds the chat container on `compaction_end`, which destroys anything the before-hook put there. The same widget reports the two cases where no target was even attempted — every target cooling down, or no route covering this compaction reason — because those are indistinguishable from a working compaction otherwise.
- Cooldowns are advisory and best-effort. A read-only or full filesystem loses them silently rather than failing the compaction, which means a rate-limited target may be tried again sooner than configured.
- The severe-truncation threshold for the `maxTokens` guard (half of Pi's requested summary budget) is an uncalibrated guess, and is labelled as one in `src/selection.ts`. Nothing has measured where the real line is.
- Automatic resume does not prove that unfinished work exists; leave it disabled if strict turn control matters.

## Development

```bash
bun install
bun run check
```

## Attribution

The native compaction integration and restoration of prior file-operation details are adapted from [JMHSV/pi-compaction-model](https://github.com/JMHSV/pi-compaction-model), MIT licensed.

Also adapted, all MIT licensed, each read at a named commit rather than a published tarball, each with a per-file provenance header naming the upstream file and what diverges:

- [algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction) PR #7 — the durable post-compaction warning, and the retry classifier, `retry-after` handling, 60-second ceiling and abort-inside-the-sleep in `src/retry.ts`.
- [JMHSV/pi-blackhole](https://github.com/JMHSV/pi-blackhole) — persisted per-model cooldowns and the retryable/stale-context predicates.
- [cortexkit/pi-magic-context](https://github.com/cortexkit/pi-magic-context) — the failure-class allow-list that gates advancing a fallback chain.
- [XTSoftwareLabs/neatcontext-plugins](https://github.com/XTSoftwareLabs/neatcontext-plugins) — the suppressor taxonomy, so declining to route says why.
- [a-Fig/Accordion](https://github.com/a-Fig/Accordion) — the ledger's closed outcome taxonomy.
- [cortexkit/aft](https://github.com/cortexkit/aft) — the tokenize-cost cap, the honest skip flag, and the savings telemetry.
- [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) — the passive provider-health record.

See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE) for the commit SHAs and the precise scope of each adaptation.
