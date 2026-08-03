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
- **Among the targets a route allows, the cheapest one that can actually hold this compaction's prompt is tried first.** Ordering is by catalogued input price (`$/Mtok`), because a summarization call is dominated by its input — Pi sends the whole conversation and asks for at most `0.8 × reserveTokens` back. Three rules keep that from being a false economy: a target that cannot hold the prompt is ranked *behind* every one that can rather than being treated as cheap; a model the catalogue reports no price for sorts **last** among those that fit, never first, because a missing price is not a price of zero; and equal prices preserve the order you wrote, since your sequencing is information. Nothing is ever dropped — the ranking changes the order, never the set.
- Output price is deliberately **not** blended into that ordering. Any weighting between input and output cost would be a constant nobody has measured, so none is invented.
- Each remaining model is tried in order. If all fail, the extension returns control to Pi's native active-model handler.
- Missing models, missing authentication, and models too small to hold the summarization prompt are skipped. The fit check measures the artifact Pi actually sends — `serializeConversation(convertToLlm(...))`, in which every tool result is truncated to 2 000 characters — not the raw message objects.
- `contextWindow` on a target **overrides** what Pi's registry reports for it. It exists for the case where the registry understates a window — a proxy provider, a stale catalogue, a self-hosted endpoint — which would otherwise make correct configuration silently unroutable with no remedy but to stop using the target. It is the number the fit decision and the ledger both use. Unlike `cooldownHours`, `0` is *not* meaningful here and is ignored with a warning: Pi uses zero to mean "no window known", which is the metadata this corrects. A target with no window from either source does not fit, because inventing one would let this package route a prompt it has no evidence fits.
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

### The preservation layer (off by default)

A routed summary is only as good as what the summarizing model can still see. The preservation layer
records durable facts *during* the session, with a cheap model, and folds them into the summarization
prompt so the summary is anchored in facts written while the original messages were still in context.

**It is off unless you switch it on, and switching it on costs money in the background.** A background
observer that borrows the model your own turns are waiting on is a real failure mode — it is the one
substantiated complaint about the upstream package this layer takes its mechanisms from — so the
observer never runs without an explicit `preservation.enabled: true` *and* a worker model of its own.

```json
{
  "compactionRouter": {
    "models": [{ "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "low" }],
    "workerModels": [
      { "model": "openrouter/google/gemma-4-31b-it", "thinkingLevel": "off" }
    ],
    "preservation": {
      "enabled": true,
      "observeAfterTokens": 10000,
      "mode": "static",
      "maxFacts": 200,
      "injectFold": true
    }
  }
}
```

- **`enabled` must be the boolean `true`.** `"true"`, `1` and `yes` are rejected with a warning: a
  layer that spends money in the background should not switch itself on by type coercion.
- **`workerModels` is a chain, tried in order, and it is never inferred.** With no `workerModels` and
  no route covering the `worker` slot, nothing is observed — the layer does **not** fall back to your
  compaction targets or to the session model. Falling back to `models` would bill you for a
  frontier-model call every observation window; falling back to the session model is the starvation.
  A route may serve the worker instead by naming the slot: `"reasons": ["worker"]`. Routes written
  before this feature keep covering exactly the three compaction reasons.
- Worker targets share the compaction path's **cooldowns and provider health**, so a provider that
  rate-limited as a worker is known to be down when it is next considered for a compaction, and the
  chain advances past it without a call. Worker calls are **not** retried: a compaction is worth
  sleeping 2s for, a background pass the next turn will re-attempt is not.
- **`observeAfterTokens`** is how much unobserved conversation triggers a pass (default 10 000). With
  `"mode": "ratio"` and a `"ratio"` between 0 and 1 it becomes a fraction of the *active* model's
  context window instead, so a 1M-context session is not observed on a 128k model's cadence.
- **`observerChunkMaxTokens`** caps what one pass sends. Left unset it is a fifth of the *worker's*
  window (fallback 60 000). The cap is not a nicety: without it a backlog that outgrows the worker's
  window makes every pass fail, so coverage never advances and the session cannot recover. With it, an
  oversized backlog drains oldest-first across passes, and one pathological tool result is clipped
  rather than blocking coverage forever.
- **`maxFacts`** bounds what the fold carries (default 200). Over that, facts are dropped by
  *coverage rank*: a fact that later facts have already superseded is the cheapest to drop, because its
  meaning now lives in them, while a fact nothing has absorbed is the dearest. Dropped facts stay in the
  session record and stay recallable — lossy in the prompt, lossless on the record. The fold says how
  many it omitted rather than omitting them silently.
- **`injectFold: false`** keeps recording facts but stops adding them to the prompt.

Facts are appended as custom session entries, which Pi keeps out of the LLM context, so recording one
costs nothing until the fold injects it. They travel with the session tree, survive compaction by
construction, and are re-folded from the entries every time — never re-summarized from the previous
summary. Each fact must cite the source entry ids it came from, and a fact citing an id that was not in
the chunk is **discarded in code** before it can be stored, not merely discouraged in the prompt.

The `recall-fact` tool exchanges a fact id for its verbatim source, so the summary can be aggressively
compressed and still be recovered where precision matters. `/compaction-router` reports the layer's
state, the worker chain, the resolved threshold and the current fact count.

Pi's compaction primitive is untouched by all of this. The fold is passed to Pi's own `compact()` as
`customInstructions`; Pi still writes the summary, the compaction entry stays native, and file-operation
restore and `fromHook` semantics are unchanged. The prompt the routed model receives also carries a
faithfulness rule (no invented paths, line numbers, commit hashes or speculation), a security boundary
framing conversation history as untrusted data, and the rule that user messages are reproduced verbatim.

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

- `/compaction-router` — show active model, configuration source, routes, fallback order, thinking levels, auto-resume policy, the preservation layer's state, and — once anything has been compacted — the savings meter and per-target health.
- `/compaction-router-config` — open the interactive routing settings (TUI only); with `off`, `reset` or JSON, edit the current session's override in any mode.
- `/compact-resume [instructions]` — compact and explicitly continue.

One tool is registered for the model rather than the operator:

- `recall-fact` — exchange a 12-hex fact id from a summary's recorded-facts section for the verbatim
  source behind it. Registered whether or not the preservation layer is enabled, because settings change
  mid-session and gating registration would leave a fold citing ids no tool could resolve until restart;
  with no facts recorded it simply answers that the id is not found. Named `recall-fact` rather than
  `recall` deliberately: tool names are first-registration-wins across extensions, and a bare `recall`
  would collide with a co-installed memory package under a name our own prompt taught the model.

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

## Executed scale proof (2026-08-03) — supersedes the 481-token proof below

**MEASURED at 268 640 tokens, with the evidence in this repository.** `scripts/scale-proof.ts` drove a
real `compact()` against a real, authenticated Bedrock target on a tool-heavy history calibrated to the
268 697-token session that this package's old estimator falsely refused at a 272 000-token window. The
compaction entry was persisted by Pi's own `appendCompaction`, then **re-read from disk** and asserted:
non-empty summary, `fromHook: true`, `tokensBefore: 268640`.

Evidence, tracked rather than described: `docs/runtime-evidence/2026-08-03-scale-proof.json`, with the
session file and ledger row it was made against copied beside it under
`docs/runtime-evidence/2026-08-03-scale-proof-artifacts/`. `test/scale-proof-evidence.test.ts` re-derives
the claims from those bytes on every `bun run check`, so the record cannot quietly rot or be weakened.

What is new about this proof, beyond the scale:

- **Which target served it is a FIELD, not an inference.** The 2026-07-28 proof had to assign a
  CloudTrail request to a session entry by matching timestamps and usage, and said so ("INFERRED, high
  confidence"). The W3 ledger records `servedBy` directly.
- **The estimator was checked against the provider's own count, and the result corrects this README.**
  The honest estimate was 58 295 tokens against a provider-reported input of 69 323 — so characters ÷ 4
  **under-counts** this provider's tokenization by ~16%, rather than over-estimating as the fit guard's
  comment assumed. The guard is still sound, and the arithmetic showing why is recorded: `reserveTokens`
  (16 384) is what carries the margin, not the estimate. A future change that shrinks the reserve toward
  the estimate's error would make the guard admit prompts that overflow.
- **`getAvailable()` is auth-filtered, not invocation-filtered.** The cheapest fitting candidate in the
  catalogue failed the call, and the chain advanced past it to serve the compaction. Several listed
  Bedrock ids refuse with `Invocation of model ID <id> with on-demand throughput isn't supported` and are
  reachable only through their `global.`/`us.`-prefixed inference-profile entries. So "cheapest that
  fits" is cheapest among *listed* models; invocability is discovered by calling, and every hop is
  recorded in the evidence rather than hidden behind a hand-picked winner.
- **A second Pi-side observation, recorded because it costs an operator diagnosability:** at this scale
  Pi's Bedrock error path substituted a serialised socket object for the provider's message, so the same
  failure that reads clearly on a small prompt is unreadable on a large one.

Still **not** established: automatic `threshold` or `overflow` compaction, ordered fallback after a
*provider* failure of a target that would otherwise work, and subagent compaction — which is out of
scope for this package by written disposition (`docs/subagent-compaction-disposition.md`). The run never
reads or writes `~/.pi`: it refuses to start unless `PI_CODING_AGENT_DIR` names a scratch directory.

```sh
PI_CODING_AGENT_DIR=/tmp/scratch-agent-dir bun run scripts/scale-proof.ts
```

## Executed manual-compaction proof (2026-07-28) — superseded, kept for provenance

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

- **Install only one `session_before_compact` owner. Co-installing another is UNSUPPORTED, and Pi cannot
  arbitrate it.** Pi's dispatcher runs every registered handler for the event, keeps the last truthy
  result, and short-circuits the whole loop on `{cancel: true}` — so two owners are mutually destructive
  and which one wins is load order, not configuration. Specifically unsupported alongside this package:
  `pi-magic-context` (cancels compaction unconditionally), `pi-blackhole` and
  `pi-observational-memory` (each returns its own summary; last writer by manifest order wins), and
  `accordion` (cancels while its GUI is attached). This package detects the loss after the fact rather
  than pretending it can prevent it: when Pi reports an extension produced the summary on a compaction
  this package resolved without producing one, a hook-collision widget says so. Pi records only *that*
  an extension produced a summary, never which, so the report names the candidates and does not accuse
  one. `test/collision.test.ts` asserts the reviewed profile registers exactly one owner.
- **Subagent compactions are not routed at all**, and for dynamic/fractal workflow subagents they cannot
  be — those sessions load with no extension runtime. They still compact, on their own model, and this
  package's ledger cannot see them, so the savings meter reads parent-session compactions only. Written
  disposition, with the measurements: `docs/subagent-compaction-disposition.md`.
- Routed models use credentials already registered with Pi.
- The package performs no direct network or subprocess operations; model calls go through Pi's model registry and native compaction function. Its only write is the append-only ledger under `$PI_CODING_AGENT_DIR/compaction-router/`, and a failed ledger write is swallowed after one warning rather than failing the compaction.
- The ledger records the summary's *size*, never its text, and no message content. It does record the project path and the configured target names.
- The context-fit estimate is characters ÷ 4 over the artifact Pi sends, the same heuristic Pi uses, and it is not exact provider tokenization — it is a fit guard, not billing. **Measured 2026-08-03, correcting an earlier assumption here: it is not reliably an over-estimate.** Against one Bedrock target at 268 640 tokens it came in ~16% *under* the provider's reported input (58 295 estimated, 69 323 reported). The guard holds because `reserveTokens` is added on top and carries the margin, not because the estimate is conservative. Lowering `reserveTokens` toward that error would make the guard admit prompts that overflow.
- Model fallback after a failed provider call can incur partial provider cost.
- Routed compactions are passed the host's own `settings.retry` policy, so a transient stream drop is retried before the route advances — the same policy Pi's native compaction runs with.
- If every configured target is skipped or throws, the hook returns control to Pi's native active-model handler: this is **fail-open**, not fail-closed. That outcome is reported to the operator as a widget above the editor, raised after the compaction commits and retracted by the next one. It is not a `notify`: Pi clears and rebuilds the chat container on `compaction_end`, which destroys anything the before-hook put there. The same widget reports the two cases where no target was even attempted — every target cooling down, or no route covering this compaction reason — because those are indistinguishable from a working compaction otherwise.
- Cooldowns are advisory and best-effort. A read-only or full filesystem loses them silently rather than failing the compaction, which means a rate-limited target may be tried again sooner than configured.
- The severe-truncation threshold for the `maxTokens` guard (half of Pi's requested summary budget) is an uncalibrated guess, and is labelled as one in `src/selection.ts`. Nothing has measured where the real line is.
- Automatic resume does not prove that unfinished work exists; leave it disabled if strict turn control matters.

Limitations specific to the preservation layer, which is why it is off by default:

- **Enabling it means paying for a model call roughly every `observeAfterTokens` of conversation.** The
  worker is meant to be a cheap small model; pointing it at a frontier model is supported and expensive.
- **A background pass competes for whatever serves the worker.** Routing it to a different provider than
  your session model is the point of `workerModels`; pointing both at the same local endpoint recreates
  the contention this design exists to avoid. The pass is deferred past the turn's end and re-checked
  before it runs, and only one runs at a time, but it is still real work on a real endpoint.
- **Facts are model-written and therefore fallible.** Cited source ids are verified in code, so a fact's
  *provenance* cannot be fabricated, but its *wording* is the worker's summary of that source. `recall-fact`
  exists because of this: when a fact is load-bearing, read the source it cites rather than trusting the
  paraphrase.
- **A fact is only as durable as its branch.** Facts live in the session tree, so a fork inherits what its
  branch recorded and nothing else, and a fact whose source entries have left the branch recalls as
  `source_unavailable` rather than silently returning nothing.
- **Fact content is written to the session file.** The ledger under `$PI_CODING_AGENT_DIR` still records no
  message content, but recorded facts are conversation-derived text in the session record. If a session
  file is not somewhere conversation content may live, leave this layer off.
- The observation threshold and the chunk cap are denominated in the same characters ÷ 4 heuristic as the
  rest of this package, which undercounts non-ASCII content — upstream's own caveat, and the reason the
  chunk-cap ratio is a conservative 0.2 of the window rather than something tighter.
- Coverage-ranked forgetting is a better policy than recency, not a solved problem: it depends on the
  worker choosing to declare that a new fact supersedes an old one. Facts nothing supersedes are never
  dropped ahead of ones that were, which is the intended bias, but a worker that never emits `supersedes`
  degrades the policy to oldest-first within a relevance tier.

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
- [a-Fig/Accordion](https://github.com/a-Fig/Accordion) — the ledger's closed outcome taxonomy, and the "user messages are sacred" and `## Relevant files` prompt conventions.
- [cortexkit/aft](https://github.com/cortexkit/aft) — the tokenize-cost cap, the honest skip flag, and the savings telemetry.
- [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) — the passive provider-health record, and the faithfulness and security-boundary prompt blocks.
- [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) — the preservation layer's mechanisms: coverage-ranked forgetting, the deterministic fold, the `recall` back-channel, code-enforced source-id citation, `ratio` threshold mode, the deferred-and-re-checked trigger, the re-entrancy guard and the observer chunk cap. Its thesis is *not* adopted: upstream returns its fold as the summary and makes no model call, where this package folds into Pi's own `compact()` and leaves the primitive in charge. Read at a `main` commit rather than its npm 3.0.3, which advertises the same version string while missing four fixes including the chunk cap.

See [`NOTICE`](./NOTICE) and [`LICENSE`](./LICENSE) for the commit SHAs and the precise scope of each adaptation.
