# Host upgrade guide: 0.28.0

**Release: 0.28.0 (2026-10-29).** This is the release where the `runToolLoop` input surface stops having
two addresses for one value: every configuration item now has exactly one canonical spelling under
`config.<group>.<leaf>`, every host behaviour is configured under `capabilities.*`, and the remaining
top-level options are the things the engine has to *hold* (ports, factories, callbacks) rather than
*read as data*.

**0.27.0 was never published.** The published line goes 0.26.0 → 0.28.0, so no host ever installed
0.27.0 and none of its intermediate shapes needs to be migrated from. If you pinned `0.26.0`, everything
below is written as "from 0.26.0 to 0.28.0".

The mechanical part is a find-and-replace of option names. The part that actually needs your attention is
that **names the engine used to ignore now throw at startup** — a typo'd or stale option that previously
cost you nothing now costs you a failed run. Section 10 tells you how to prove you are clean.

## 1. Change summary

| What you change | Why it changed | Where |
|---|---|---|
| Move 44 flat option spellings into `config.<group>.<leaf>` | one value, one address (issue #498 S3) | §3 |
| Move host behaviour into `capabilities.hooks.*` / `capabilities.ports.*` | behaviour is not data (issues #530, #545) | §4 |
| Treat top-level `session` as an identity container; move your opaque payload to `config.folding.context.session` | the container was shadowing the payload (issues #513, #550, #551) | §5 |
| Expect unknown names to throw (assembly-port members, `session` subkeys, retired flat names) | silence was the bug (issues #556, #513, #498) | §6 |
| `config.run.stream` must be a boolean; `config.timing.retry.sleepImpl` is gone | two contradictory judgements / a dead read (issues #538, #520) | §7 |
| Your `.d.ts` type errors are new and correct | the declared surface now equals the accepted set (issue #522) | §8 |

### Files touched by this release (host-visible surface)

* `src/loop/option-normalization.js` — the accepted top-level name set and the flat-name rejection.
* `src/loop/config-namespace.js` — the canonical leaf schema, the value rules, the relocated-key pointers.
* `src/assembly.js`, `src/assembly-validators.js` — the assembly port: canonical leaves only, the member
  gate, the `session` container rules.
* `src/loop/budget.js`, `src/loop/provider-runner.js` — where the opaque payload and the streaming
  judgement are read.
* `src/normalization/parse-model-json.js`, `src/config/slot-provider.js` — model-output normalisation entry
  and the slot → provider factory pair.
* `docs/host-consumer-contract.md` (and `_cn`) — the authoritative contract, updated throughout.

## 2. The input surface: two planes and one station

* **Data** goes in `config`, grouped by what it configures. The canonical schema is
  `CONFIG_NAMESPACE_SCHEMA` (`src/loop/config-namespace.js`): **41 leaves** in seven groups —
  `input` (5), `run` (16), `tuning` (4), `timing` (3), `folding` (3), `guard` (3), `metadata` (7).
  **No flat alias is registered any more**: `CONFIG_ALIAS_PATHS` is empty, which is the machine-readable
  form of "the flat spelling is not a supported spelling that also works — it is rejected".
* **Behaviour** goes in `capabilities`: `hooks` (the callbacks the engine calls), `ports` (the objects it
  delegates to), `slots` (the providers it selects). It lives in `config`'s sibling container because it
  is not data: the engine invokes it.
* **The station** is the remaining top-level option set, `RUN_TOOL_LOOP_OPTION_NAMES`
  (`src/loop/option-normalization.js`): **26 accepted names** — 11 ports and factories (`assemblyPort`,
  `provider`, `tools`, `executeTool`, `modelConfig`, `store`, `signal`, `deliverables`, `finalGuard`,
  `todoStateProvider`, `semanticStateProvider`), 12 observer/callback members (`onEvent`, `onRound`,
  `onToolResult`, `onJudge`, `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`, `onPersistenceError`,
  `onObserverError`, `onFoldSummary`, `diagnostics`), the identity container `session`, and the two plane
  containers `config` and `capabilities`.

Both intake routes — the direct option object and `createAssemblyPort` — accept the **same canonical
leaves**. The port no longer emits retired flat names into the option tree (issue #544), so "the port
normalised it for me" is no longer a reason for a flat name to work.

## 3. The flat configuration spellings are gone (issue #498 S3)

Writing any of these as a top-level `runToolLoop` option throws at startup with a verdict that names the
canonical home, in the shape
`unknown runToolLoop option: "timeoutMs" (its canonical home is config.timing.timeoutMs; the flat spelling is rejected)`.

| Retired top-level name | Write it as | Issue |
|---|---|---|
| `timeoutMs`, `deadlineMs`, `retry` | `config.timing.timeoutMs` / `.deadlineMs` / `.retry` | #498 |
| `context`, `toolResultTtl`, `toolResultFoldMinTokens` | `config.folding.context` / `.toolResultTtl` / `.toolResultFoldMinTokens` | #498 |
| `cacheStablePrefix`, `initialMessages` | `config.input.cacheStablePrefix` / `.initialMessages` | #498, #517 |
| `initialUserMessage` | `config.input.initialUserMessage` | #498 |
| `system` | `config.input.system` | #498 |
| `wrapup` | `config.input.wrapup` | #498, #530 |
| `maxTokens`, `temperature`, `topP` | `config.tuning.maxTokens` / `.temperature` / `.topP` | #498 |
| `cacheCapable` | `config.tuning.cacheCapable` | #498 |
| `finalGuardMaxRetries`, `finalGuardTimeoutMs`, `finalGuardExtend` | `config.guard.*` | #498 |
| `modelMetadata`, `requestId`, `toolContext`, `expert` | `config.metadata.*` | #498 |
| `user`, `model`, `task` | `config.metadata.user` / `.model` / `.task` | #498, #531 |
| `invalidArguments`, `replayPolicy`, `writeToolPathKeys`, `writeToolNames` | `config.run.*` | #498 |
| `partialPersistence`, `maxTokenContinuations`, `stream`, `resume`, `runId`, `maxRounds`, `completion` | `config.run.*` | #498, #538 |
| `stallDetection`, `persistence`, `outputHygiene`, `cwd` | `config.run.stallDetection` / `.persistence` / `.outputHygiene` / `.cwd` | #498, #562 |
| `reflection` | `config.run.reflection.*` for its 11 data members; its two invoked members moved to `capabilities` | #530 |
| `session` as a metadata leaf | top-level `session` (a port is not data) | #531 |

**Why this is behaviour-neutral for a correct host.** The expansion phase (`expandConfigNamespace`,
`src/loop/config-namespace.js`) writes each accepted canonical leaf back onto the name the engine has
always read, so the read side of every consumer did not change in this release: a run configured through
the new spellings behaves like the same run configured through the old ones. What changed is only *where
you are allowed to write the value*.

**Two boundaries hosts keep confusing.**

* `finalGuard` is a **hook**, not a data key: it stays a top-level capability member, while its three
  configuration keys moved to `config.guard.*`.
* `tools` stays a top-level option. The nested spelling `config.input.tools` **never existed** — it was
  listed in a schema shape but no code ever read it, and 0.28 removes the entry (§9).

## 4. Host behaviour lives in `capabilities` (issues #530, #545)

`reflection` was the last flat key to go, and it went differently: eleven data members moved to
`config.run.reflection.*`, while the two things the engine actually calls moved to the plane that already
had a home for them — `onReflection` → `capabilities.hooks.onReflection`, and `judge.provider` →
`capabilities.ports.judgeProvider`. Keys like `metadata` or `completion` were never invoked, so refusing a
function there was a deliberate narrowing; `reflection` members really are invoked, so they had to move
somewhere rather than simply stop accepting functions.

`policy` on the assembly port **carries data only** (issue #545): its accepted key set is derived from the
canonical leaves plus the two containers `config` / `capabilities`, and every accepted leaf is translated
into `config.<group>.<leaf>`. Writing a capability into `policy` flat is refused with a pointer, e.g.
`unknown assembly policy option: "onFoldSummary" (policy carries data only: …)`. Precedence is:
an explicit `policy.config` tree wins over a translated leaf, and the port's derived leaves only fill
holes.

## 5. `session` is an identity container; your payload has a new home (issues #513, #550, #551)

Top-level `session` accepts exactly `session.id`, `session.modelSlot` and `session.initialMessages`.
The accepted set is derived from the places that actually read it
(`SESSION_MEMBER_READ_POINTS`, `src/assembly-validators.js`), so it cannot drift from the engine.
`session.id` becomes `config.run.runId` and `session.initialMessages` seeds the first turn — on **both**
routes now, which is a behaviour change for hosts that passed them through the port before and got
silently ignored values (issue #550).

Anything you used to hand through `session` as an **opaque payload** now goes in
`config.folding.context.session`. It reaches your tool execution as `context.session` — and when you do
not set it, the key is absent rather than an empty object (issue #550). `config.metadata.session` is
refused with a verdict that points at the new home (issue #551), so the wrong spelling tells you where to
go instead of quietly arriving as `undefined`.

## 6. Unknown names now throw

Three gates landed in this release, all at startup, all naming the fix:

* **Retired flat names** (issue #498) — see §3.
* **Unknown members inside `session`** (issue #513), on both routes:
  `unknown session option: session.bogusSubkey (accepted: session.id, session.modelSlot, session.initialMessages)`.
* **Unknown top-level assembly-port members** (issue #556). Until 0.27 an extra key was accepted and
  silently discarded — and the two names hosts most often write are exactly the two containers of the
  other route, so `{ config: … }` at the port top level meant zero feedback and zero effect. The gate runs
  before any host factory is called, and the accepted set is derived from the same table that builds the
  port (`ASSEMBLY_PORT_MEMBER_READ_POINTS`, `src/assembly.js`):
  `unknown assembly port option: "config" (accepted: …); its canonical home is policy.config: …`
  A non-object input now reads `assembly port must be an object (got null)`.

Every one of these sentences is machine-pinned: `test/contract-verbatim-verdicts-553.test.js` reads them
out of the running engine and compares them against the contract text, so a doc cannot quietly promise a
message the engine stopped printing (issues #553, #554, #557).

## 7. Two value rules that now bite

* **`config.run.stream` must be a boolean** (issue #538). It previously fed two different judgements
  (which channel name to record, and whether to call `chat` or `chatStream`), now merged into one derived
  value (`streamsThisRun`, `src/loop/provider-runner.js`). A non-boolean throws at intake on both routes
  instead of producing a silently different transport:
  `config.run.stream must be a boolean (received: number)`.
* **`config.timing.retry.sleepImpl` is no longer a callback field** (issue #520). No engine code read it,
  so a stale value there is now simply ignored — a host that still passes one gets no error (this is a
  deliberate relaxation, the mirror image of the tightening above).

## 8. The declared type surface now equals the accepted set (issue #522)

The top-level keys declared in `src/index.d.ts` are reconciled against the accepted option whitelist, so a
new TypeScript error after upgrading is usually you writing a name the runtime also rejects. Contract
samples that must not compile are checked with `tsc --strict`, and an unknown option key fails with
`TS2353` rather than compiling and failing later at startup.

## 9. Three spellings that never existed

Do not write these as migrations — they were never live, and the release notes say so on purpose:

* `config.input.tools` (#527): listed in a schema shape, **never read** by any code path; the entry is
  removed and `tools` remains a top-level option.
* `config.metadata.session` as a data leaf (#531, #551): `session` is a port; the payload home is
  `config.folding.context.session`.
* `messages` as a top-level option — and `config.input.messages` written as its *migration target*
  (#562): the flat name never held a position in the allowlist, so the engine rejects it with the
  plain unknown-option verdict and **no** canonical-home pointer, because there is no old home to
  point back to. The leaf itself is live and always was: `config.input.messages`.

## 10. What did not change

* The engine's **read side**: every consumer still reads the same internal names, written back by the
  expansion phase.
* Termination, verification and exit-code semantics; the `skipped`-without-guard exit code stays `4`.
* Transcript and run-state on-disk formats; resume from an older ledger.
* Tool execution, compaction strategy defaults, reflection thresholds, the final guard contract (including
  named deliverable checks, `createNamedDeliverableChecks` in `bin/final-guard.js`).
* The CLI, the two built-in provider factories, and the zero-runtime-dependency rule.

## 11. Verify it on your side

1. **Find every retired name you still write.** From your repository root:

   ```bash
   grep -rnE '\b(timeoutMs|deadlineMs|retry|toolResultTtl|toolResultFoldMinTokens|cacheStablePrefix|initialMessages|initialUserMessage|cacheCapable|finalGuardMaxRetries|finalGuardTimeoutMs|finalGuardExtend|maxTokens|temperature|topP|modelMetadata|requestId|toolContext|expert|partialPersistence|maxTokenContinuations|maxTokenContinuation|invalidArguments|replayPolicy|writeToolPathKeys|writeToolNames|completion|resume|runId|maxRounds|wrapup)\b' src/
   ```

   Expect false positives (your own field names, engine *event* payloads, `effectiveOptions` in this
   repository's docs). What you are looking for is a **name written into the options object you hand to
   `runToolLoop` / `createAssemblyPort`**.

2. **Run your suite and read the first error, not the last.** Every rejection in this release happens at
   startup and the message names the canonical home, so the first failing test is usually the whole fix.

3. **If you assemble a port**, check that nothing sits at the top level except the accepted members, and
   that data you put there earlier is now inside `policy` (§6).

4. **Type-check your host with the published declarations** (`tsc --strict`). A new `TS2353` on an option
   key means the runtime would have rejected it too (§8).
