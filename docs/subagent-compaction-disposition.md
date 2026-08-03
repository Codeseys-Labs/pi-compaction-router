# Subagent compaction routing (G2): DECLARED OUT OF SCOPE for this package, filed as a DFW-fork ask

**Date:** 2026-08-03. **Decision:** the third option of the three the wave-11 verdict offered —
**declared out of scope for `pi-compaction-router`** — plus the second half stated as a concrete
sibling ask rather than left implied: the routing that IS reachable belongs in a **DFW fork** (S-203's
one-fork bucket), and the part that is reachable nowhere is an **upstream SDK ask**.

This document exists because the ask had been carried open three times with no owner
(`refined-vision-v1-draft.md:448`, `docs/plan/v1/ARCHITECTURE.md:280`, `docs/plan/v1/PLAN.md:576`
PROPOSED-10, `feature-harvest/raw-vision.md:398`), and the wave-11 verdict's caveat 2 required a
written disposition "not silence a fourth time". A disposition is not a fix. What follows is a
refusal with its reason measured, and a named owner for the remainder.

## The ask

`docs/raw-vision.md:83-84` (A-23/A-24), sourced to a real operator turn at 2026-07-25T07:46:36:
subagent autocompaction with hard steering, explicitly for **both** ordinary subagents and
dynamic/fractal workflow subagents — "so a subagent can keep working when a task runs far past its
estimate".

## Why this package cannot deliver it — measured, not inherited

Three facts, each re-measured on this host for this document rather than carried from the dive.

**1. Subagent compaction happens today, natively, unrouted.** `_checkCompaction` is a method on
`AgentSession`, not on the extension path — `dist/core/agent-session.js:1508`, called from `:776` and
`:862`, read in the `@earendil-works/pi-coding-agent` 0.81.1 tree this package pins. So a subagent
session compacts on its own model whenever it crosses the threshold. The compactions are real; only
the routing and the record are absent.

**2. DFW spawns its subagents with no extension runtime at all.**
`pi-dynamic-fractal-workflows/src/agent.ts:1024-1041`, measured at that checkout's HEAD
`dc0d5d46aa7678c84177ad2d210e7c4c940814d1`: `getSharedResourceLoader` builds a
`DefaultResourceLoader` with `noExtensions: true`. Pi honours that by replacing the discovered
extension set with the CLI-explicit one — `dist/core/resource-loader.js:267`,
`this.noExtensions ? cliEnabledExtensions : this.mergePaths(cliEnabledExtensions, enabledExtensions)`.
DFW passes no explicit extension paths through that loader, so the set is empty: no extension
runtime, therefore no `session_before_compact` subscriber, therefore nothing this package registers
can fire. Upstream's own comment says so in the same breath as the leak fix it was written for: it
"structurally kills recursive orchestration in subagents (no extension runtime at all)".

**3. The `pi-subagents` half is NOT structurally closed — and that distinction is new here.** The
dive treated G2 as one gap. It is two, and only the DFW half is structural. `pi-subagents@0.38.0`
(read-only, in the installed tree at `~/.pi/agent/npm/node_modules/pi-subagents`) spawns children as
a `pi` subprocess and builds their extension arguments in
`src/runs/shared/pi-args.ts:149-181` (`resolvePiLaunchToolPlan`) / `:249-256`:

- `disableAmbientExtensions` is `capabilityCeiling?.denyExtensions === true || input.extensions !== undefined`
  — so ambient discovery survives unless a ceiling denies extensions or the agent definition names an
  explicit list;
- when it is false, `extensionArgs` is `runtimeExtensions + toolExtensionPaths + subagentOnlyExtensions`
  and `--no-extensions` is never pushed;
- pi's own CLI keeps explicit `-e/--extension` paths working even under `--no-extensions`
  (`dist/cli/args.js:120-125`, help text at `:251`: "Disable extension discovery (explicit -e paths
  still work)").

So for `pi-subagents` children there is a supported seam: an agent definition's `extensions` (or
`subagentOnlyExtensions`) can name this package's entry point, and the child then has a real
extension runtime with a `session_before_compact` owner in it. **That seam is not wired, and this
wave does not wire it**, for three reasons that are policy rather than mechanism: the child would
need this package's settings resolvable in its own agent dir; a second `session_before_compact`
owner inside a child process is exactly the collision `test/collision.test.ts` in this wave exists to
refuse, and it needs a reviewed answer for the nested case before it is created; and the manifest
slot `session-before-compact` is granted to this package once, in `manifests/profile.json:11`, with
no nesting semantics defined. Naming the seam is the useful half of this disposition; taking it
without those three answers would be the scope creep the verdict's risk 4 warns about.

## The disposition, in three parts

1. **OUT OF SCOPE for `pi-compaction-router`, permanently as framed.** No code in this package can
   route a DFW subagent's compaction, and no amount of work inside these 250-odd source lines
   changes that. The v2 row does not claim subagent routing, and the README says so.
2. **The DFW half is a DFW-fork item (S-203's one-fork bucket).** The lever is the **subagent
   extension allowlist**, which S-203 counts as one of the four things that one fork owes:
   `refined-vision-v1-draft.md:764-768` — "Buckets 1, 5, 10 and 13 all propose patching
   `@quintinshaw/pi-dynamic-workflows`… they are *one* fork, not four projects… the subagent
   extension allowlist". Bucket 10 IS compaction, and `refined-vision-v1-draft.md:755` dispositions
   it as "**FORK-EDIT** the same package as #1 (extension allowlist)" — so the recorded disposition
   was already the fork, and this document is the router side agreeing with it rather than a new
   proposal. Concretely, what that fork would add: an opt-in list of extension paths passed through
   `DefaultResourceLoader`'s CLI-explicit slot, so a workflow may elect a compaction owner for its
   children without re-enabling ambient discovery — the shape pi's own `--no-extensions` + `-e`
   contract already supports, and therefore not a pi change.
3. **The steering half (G3) is an upstream SDK ask and stays one.** Even with an extension runtime in
   the child, `pi.sendMessage` has no subagent analogue, so "hard steering" after a subagent's
   compaction cannot be built from the extension API as it stands at 0.81.1. That is the honest
   remainder and it is upstream's, alongside the pre-decision compaction hook that
   `ws11-supervisor/ARCHITECTURE.md:367-379` already records as the residue of the refused adaptive
   timing (G7).

## What this costs, stated

Subagent compactions continue to happen on the subagent's own model, unrouted and unmetered. This
package's ledger cannot see them: it is fed from `session_compact` in the parent process, and a
child's compaction is committed in the child's session. Anyone reading this project's savings meter
is reading **parent-session compactions only**. That is a real hole in the V2 half of the vision and
it is not closed by this wave; it is named, owned elsewhere, and no longer silent.
