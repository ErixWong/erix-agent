# Host upgrade guide: 0.27.0

**This is the "the fold summarizer finally gets a deadline, a budget and a size limit" release.** 0.26.0 made a
fold say what it removed; 0.27.0 makes the LLM call behind that sentence **bounded** — in time, in input size,
and in output size — and makes it say *how* it failed when it degrades. Nothing is removed, nothing is renamed,
no store method signature moved, no export or dependency moved, and the runtime still has **zero** npm
dependencies.

Everything below is additive or a strictly better-behaved default, with **two exceptions you have to look at**:
the summary output budget default moved `800 → 1400` tokens (§4), and the summary request's `maxTokens` is no
longer inherited verbatim from the run (§2). A host that compiles against 0.26.0 compiles and runs unchanged.
`CHANGELOG.md` stays the complete list; `docs/host-consumer-contract.md` stays the field-level truth.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| Five summarizer knobs on `context` (§2) | no — omit them and you get the defaults below |
| Summary request `maxTokens` = `min(run maxTokens, maxSummaryTokens)` (§2) | yes, if you asserted on the summarizer request body |
| Unknown `context` sub-keys: knob typos throw, host metadata is tolerated with an event (§3) | yes, if you put your own keys in `context` |
| Summary budget default `800 → 1400`; trimming keeps section headers; topic crumbs moved up a tier (§4) | yes, if you pinned the old truncation shape |
| Prior summary seeded across resume; the reuse key now includes it (§5) | yes, expect **one** recomputed summary per existing ledger |
| Degrade facts on `compaction.foldSummary`, including `degradeKind` and `finishReason` (§6) | no — additive; no fact, no key |
| A single round larger than the input cap has no whole round to drop (§7) | no — but read this before asserting on `droppedRounds` |
| Nested `config` namespace for the same knobs (§10) | no — the flat keys keep working; `config.*` wins when both are given |

### Files touched by this release (host-visible surface)

- `src/loop/orchestrator.js` — summarizer wiring: two-layer deadline, input cap, `summaryMaxTokens` min-align, prior-summary seeding.
- `src/compact/provider-summarizer.js` — the deadline actually aborts the provider call; errors keep their kind.
- `src/compact/fold-llm.js` — summary budget default, skeleton-preserving trim, section tier order, `degradeKind` classification.
- `src/assembly-validators.js` / `src/assembly.js` — `context` whitelist (five engine-read keys + all knobs), knob-family detection by edit distance, `contextOptionNameSelfCheck()`.
- `src/loop/budget.js` — the `context.toolContext` / `expert` / `user` / `session` / `requestId` keys that were always read but never whitelisted.
- `src/tools/file-tools.js` — `readFile` description's median tier re-measured (byte-neutral; the test tolerances did not move).
- `src/loop/config-namespace.js` — the `config` namespace schema, its derived alias table and the capability refusal list (`runId` / `cwd` are configuration, not capability: string scalars, JSON-safe).

## 2. The five summarizer knobs, and one cap that is now actually a cap

`context` accepts five knobs. Omitting all five **is** the recommended configuration: the defaults below are
the values a production host asked for, so "omit" and "write them out" are equivalent.

| Knob | Default | Meaning |
| --- | --- | --- |
| `summarizerTimeoutMs` | `30000` | **provider-layer, single-call** deadline. Aborts the in-flight HTTP call; a host `abort` of the run now aborts this call too instead of being noticed afterwards |
| `summarizerBudgetMs` | `30000` | **strategy-layer, whole-step** deadline. Shared by the first attempt and the shorter-input self-heal retry — deliberately a different number from the row above, do not merge them |
| `maxSummarizerInputBytes` | `49152` (48 KB) | hard byte cap on what is handed to the summarizer. Measured per round, so see §7 for the case where it cannot bite |
| `maxPriorSummaryBytes` | `24576` (24 KB) | cap on the previous summary used as a continuation base |
| `maxSummaryTokens` | `1400` | summary **output** budget (it was `800` before this release — §4) |

All five must be safe positive integers, or assembly throws a `TypeError` naming the key. `null`, `0`, `-1`,
`1.5` and `"1000"` are all "given, but wrong"; only omission means default.

**The one behaviour change to check if you assert on request bodies**: the summarizer request's `maxTokens` used
to inherit the run's value verbatim — a host that set `maxTokens: 32768` paid the model to write 32k tokens that
were then trimmed back to the summary budget. It is now:

```js
summaryMaxTokens = Math.min(run.maxTokens ?? Infinity, context.maxSummaryTokens ?? 1400)
```

Strictly tighter, never looser. If you want the old ceiling back, set `context.maxSummaryTokens` explicitly.

## 3. Unknown `context` sub-keys: a typo throws, your metadata does not

0.26.0 silently dropped unknown `context` keys (a host believed it had configured something; the engine used a
default). **As of this release both entry routes** distinguish the two cases — issue #496 moved the check
onto the canonical merged options, so it is no longer assembly-only:

- **Knob-family typos throw** — a key within edit distance 2 of a known knob name (`maxPriorSummaryByte`,
  `summarizeBudgetMs`, `summarizerTimeouts`, …) is an accident, and it is reported at assembly time as
  `unknown … context option`. The rule is **edit distance, not substring**: a name merely containing `summar` is
  not a knob.
- **Everything else is host metadata** — the contract has always said private host metadata may live in
  `context` (`workspaceName`, `summaryStyle`, `summarizerNote`, …). Those keys are **tolerated** and reported
  honestly through one event, never silently:

```
type: "context_unknown_option"
keys: ["workspaceName"]
note: "unknown context keys are tolerated as host metadata; summarizer knob typos throw instead"
```

Also whitelisted, because the engine reads them itself in `src/loop/budget.js`: `toolContext`, `expert`, `user`,
`session`, `requestId`. A host that put them in `context` on 0.26.x got a `TypeError` at assembly — that was a
bug in our whitelist, and it is fixed here.

**`context.onFoldSummary` is retired in this release (issue #499).** It used to sit on the accepted list even
though the engine **never** read it from `context` — the delivery hook lives at the top level
(`runToolLoop({ onFoldSummary })`) or on the assembly policy (`policy.onFoldSummary`). That entry therefore
bought a host a green light and **no** event: configured, ineffective, and invisible. It is now an ordinary
tolerated key — the assembly-port route reports it in `context_unknown_option`, the fine-grained route passes it
in silence, and **neither route throws** (it is host-metadata shaped, not a misspelled knob). If you configured
it under `context`, move it to one of the two real positions; if you did not, nothing changes.

⚠ **This validation now runs on both entry routes** (issue #496). A host that calls `runToolLoop(options)`
directly used to get no `context` validation at all — a misspelled knob there was silently ignored. That
asymmetry is gone: both routes now raise the same `TypeError` with the same message, and the error object
carries `via: "direct" | "assembly"` so you can tell which door you came in through. **One asymmetry is
left, and it is only this one**: the `context_unknown_option` event is emitted by the assembly port only,
so a direct-route host never receives it (`onEvent` still works there — it just never gets that event).

Two consequences of that fix are host-visible and neither is a silent no-op:

- **The knob-family check's blast radius grew with the fix.** The rule itself is unchanged (edit distance
  ≤ 2 against a known knob name, never substring), but before 0.27.0 only assembly-port hosts paid for it;
  now every host does. Measured: `summarizerBudget`, `summarizerTimeout`, `maxSummaryToken` now **throw**,
  while `summaryStyle`, `summarizerNote`, `maxSummaryChars`, `workspaceName` stay tolerated metadata.
- **A callback that is not a function now throws at startup** instead of being quietly unused:
  `finalGuard`, `retry.sleepImpl`, `reflection.onReflection`, `diagnostics.error`, `onFoldSummary`,
  `context.onBeforeFold`, `context.onAfterFold`. `null` counts as *given but wrong*. The single exception
  is `context: null`, which is literally *not configured* (measured equal to omitting the key).

## 4. Summary budget: the default moved, and trimming got less destructive

Three related changes, all aimed at "the five-section contract holds under the default configuration":

1. **`maxSummaryTokens` default `800 → 1400`.** Five sections × 150 CJK characters measure at roughly 1,335
   tokens, so with the old default a model that obeyed the contract exactly was still cut down to two sections.
2. **Trimming keeps the skeleton.** Before, an over-budget section became one line `[已修剪]`, hiding the fact
   that the section ever existed — from the reader and from the next fold's summarizer alike. Now only the body
   is cut: `## heading\n[已修剪]`.
3. **Topic crumbs moved up the priority order**, to tier 1 with `## 下一步`. Order is now: next-steps /
   recovery-hint > topic crumbs > verified items > changed files. A budget squeeze now costs you the file list
   before it costs you the only clue about what to search for next.

`compaction.foldSummary.finishReason` passes the provider's normalised value through unchanged; `max_tokens`
means **this summary was cut by the output budget and is not complete**. Unknown values must be treated as
unknown, never as "fine".

## 5. The continuation base survives resume — and the first fold after you upgrade recomputes

The "previous summary" used as a continuation base used to be a closure inside one strategy instance, so the
**first fold of a resumed run had no base** even though the model could see the previous summary in context. It
is now seeded from the ledger (session scope), reusing the same covering-alternative picker as the fold
substitute backfill, and reported as:

```
compaction.foldSummary.priorSummaryOrigin: "ledger" | "in-run"     // absent when there was no base
```

Precedence is fixed: explicit call argument > strategy constructor argument > in-run closure > ledger seed.

**Expect this cost once per existing session**: the reuse fingerprint now includes the base text, so ledgers
written before this release miss their stored summary on the first fold after upgrade and recompute one summary.
That is deliberate (without it, the seeded base is silently ignored exactly on the fold that needed it) and it
is not a regression signal — the second fold in the same range hits again.

## 6. When the summary is second grade, say so

Degradation does not get a new event type — it is recorded on the compaction stat, and your UI has to read it:

```
compaction.foldSummary = {
  degradeKind,            // "timeout" | "context_window_exceeded" | "error"
  degradeReason,          // full sentence, for a human
  inputTruncated, droppedMessages, droppedRounds,
  finishReason, inputTokens, outputTokens,
  priorSummaryTruncated, priorSummaryBytes,
  attempts, budgetExhausted, reused,
  strategyName            // on the stat itself: which strategy actually ran
}
```

Same discipline as `strategyName`: **no fact, no key** — a clean fold leaves the shape byte-for-byte unchanged,
so a missing key means "nothing went wrong", not "we did not look". `fold-statistical` never writes any of these
(zero LLM involved), which is a contract, not a bug. Degradation is not a run failure: the model still received
a mechanical substitute, so do not turn a `degradeKind` into a red terminal state.

## 7. A single fat round has no whole round to drop

`maxSummarizerInputBytes` is measured over the rounds being folded. If **one** round is already larger than the
cap, there is no whole round left to drop: `droppedRounds` stays `0`, the token guard clips item by item, and an
omission note is left behind. Hosts whose shape is "one user message = one run" hit this routinely — do not
write acceptance criteria that assume the byte cap fires.

## 8. What did not change

- No API removed or renamed; no export moved; `runToolLoop` option names unchanged.
- `TranscriptStore` / `NotesStore` signatures unchanged; no migration; no new required store method.
- `fold-statistical` and `sliding-window` remain zero-LLM and zero-cost; their output is unchanged.
- `record.foldedFacts` / `onFoldSummary` payload from 0.26.0 unchanged except the three additive range keys
  (`foldedRoundRange`, `foldedThrough`, `foldedRoundCount` — note `foldedRoundCount` is **run-scoped**).
- Runtime dependencies: still zero.

## 9. Verify it on your side

```bash
npm i erix-agent@0.27.0
node -e 'import("erix-agent").then(m=>console.log(Object.keys(m).length))'   # smoke: the surface loads
```

Then, in your own acceptance:

1. **Knobs reach the wire**: set `context.maxSummaryTokens = 200` and assert the summarizer request carries
   `maxTokens: 200` while the run itself keeps its own larger value.
2. **Assembly rejects a bad value, not your metadata**: `{ maxSummaryTokens: 0 }` throws; `{ workspaceName: "x" }`
   assembles and emits one `context_unknown_option`.
3. **Degrade is visible**: force a summarizer timeout and assert `compaction.foldSummary.degradeKind === "timeout"`
   on the `compaction` event, with the run still finishing normally.
4. **The upgrade miss is one, not many**: on a pre-existing session, fold twice and assert the first fold
   recomputed (`priorSummaryOrigin` present) and the second did not re-burn the same base.

## 10. One namespace for a run's configuration: `config`

0.27.0 adds a second, nested spelling for the configuration keys. `config.run.maxRounds` and the flat
`maxRounds` are the same knob: the leaf name is always verbatim the flat option name, and the alias *is*
the schema path — nothing to remember, and no second mapping table to drift. The seven groups are
`prompt` / `run` / `tuning` / `timing` / `folding` / `guard` / `metadata`; the contract section
“The `config` namespace (issue #497)” lists every knob one by one.

**Callbacks are not in the config tree** (issue #498 S4a). `capabilities.hooks` is their canonical
home — `onEvent`, `onObserverError`, `onPersistenceError`, `onRound`, `onJudge`, `onToolResult`,
`onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`, `onFoldSummary` — and the flat top-level
spellings keep working unchanged. There is no `config.observers` group: the group that 0.27.0's
draft carried was **removed before release**, because a callback is behaviour, not data, and a
`config` subtree holding one cannot survive a JSON round-trip. For the same reason any function
value inside `config` is now refused at intake with its full path named
(`config.timing.retry.sleepImpl`, `config.guard.deliverables[0].check`, …), and `finalGuard` —
whose value must be a function — left the config surface (the flat `finalGuard` is untouched).

What you have to act on: **nothing**. The flat keys you pass today keep being accepted and behave
exactly as before. Two things to know if you adopt it:

1. **Precedence** — when the same knob is given both ways, `config.*` wins, and the engine emits one
   `config_override_conflict` event before the first round:
   `{ type, runId?, conflicts: [{ path, key }], detail }`. Nothing is silent — if you see that event,
   one knob has two sources of truth in that run. The **same event covers the assembly port's
   `policy.config` versus the call-level `config`**: the call-level tree wins as a whole (the
   pre-existing "last writer wins" merge, unchanged), and every leaf both sources set to different
   values is reported leaf by leaf. Equal values are not conflicts; a leaf only the overridden tree
   sets is **dropped** by that whole-tree override, so do not treat the two sources as a per-leaf
   merge.
2. **Capability keys are refused** — `provider`, `tools`, `executeTool`, `store`, `modelConfig`,
   `assemblyPort`, `signal`, `todoStateProvider`, `semanticStateProvider`,
   `onEvent`, `onObserverError`, `onPersistenceError`, `diagnostics`, the eight observer channels
   (`onRound`, `onJudge`, `onToolResult`, `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`,
   `onFoldSummary`) and `finalGuard` are not configuration. Writing one inside `config` throws at
   startup and names the key; for a callback the message also names `capabilities.hooks.<name>`.
   The line is behavioural: the capability surface is what you hand in as **behaviour carriers**
   (functions / port objects the engine calls or dereferences), while the config surface is
   **data the engine validates and interprets by known field**. That is why `persistence`
   (`config.run.persistence`) and `model` / `modelMetadata` / `session` (`config.metadata.*`) are
   configuration in this version — the engine reads their known fields (the persistence mode
   literal, the window numbers, `session.id` / `modelSlot`). `runId` / `cwd` are configuration too
   (`config.run.runId` / `config.run.cwd`): they are string scalars, JSON-safe by construction, and
   the round-trip property ("the `config` subtree survives a JSON round-trip unchanged") wants the
   capability surface to hold functions and port objects only — and it is now **asserted
   mechanically** in the default suite (one representative data value per schema leaf, then
   `JSON.parse(JSON.stringify(cfg))` compared leaf by leaf), not merely promised. This narrowing
   applies to the **new namespace only**: the pre-existing precedence rule — an explicit
   fine-grained option overrides the same-named member the assembly port supplies
   (`resolveAssemblyMember` (`src/assembly.js`)), e.g. an explicit `provider` still beats the port's
   provider — is untouched, and `test/contract/assembly-port.js` keeps asserting it.

New hosts should use `config` for configuration and `capabilities.hooks` for callbacks. The flat
top-level keys are the **primitive / transitional** surface — still accepted, still validated, still
documented — and their removal window belongs to the mother issue's release ladder (#495). This
release removes none of them.
