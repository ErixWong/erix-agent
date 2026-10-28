# Host Consumer Contract

> Chinese version: [host-consumer-contract_cn.md](host-consumer-contract_cn.md)

This document defines the host integration boundary for `erix-agent`. The engine
maintains auditable run facts; the host owns tool permissions, archive policy,
retry/rerun policy, and the final consumption decision. See
[ADR-012](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/012-engine-truth-model-efficiency-host-policy.md) and
[ADR-013](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/013-guard-charter.md) for the responsibility boundary.
The 0.6.0 migration steps are in
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md); the 0.12.0 notes
contract migration steps are in
[host-upgrade-guide-0.12.0.md](host-upgrade-guide-0.12.0.md). The 0.16.0
store-fidelity, same-round ordering, and additive display-projection migration
steps are in
[host-upgrade-guide-0.16.0.md](host-upgrade-guide-0.16.0.md).

## `runToolLoop` options

`runToolLoop` accepts only the following top-level option keys. An unknown key
throws `TypeError` instead of being silently ignored. Host-private metadata
must be placed in an explicit namespace such as `toolContext` or
`config.folding.context` (the flat `context` has been rejected by the name gate since 0.28.0 — see
"Flat-spelling version policy" below).

```text
assemblyPort, provider, system, wrapup, tools,
executeTool, maxRounds,
reflection, stallDetection,
completion, finalGuard,
maxTokenContinuations,
todoStateProvider, semanticStateProvider,
modelConfig, modelMetadata, expert, session, requestId,
toolContext, store, persistence, runId, cwd, deliverables, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent, onFoldSummary, config,
capabilities
```

`config.run.partialPersistence` defaults to `false`, preserving the existing no-write
streaming behavior. (The **flat** spelling `partialPersistence` is retired by the `run` group's A12
slice — see "Flat-spelling version policy for the `run` group's A12 segment" below. Version policy:
writable up to **0.26.0** — the last published release —, **0.27.0** was never published, and from
**0.28.0** the name gate rejects it. The option's *semantics* did not move: it is still durability,
not retry.) Set it to `{ intervalMs, minBytes? }` to opt into
interval-throttled partial assistant-text snapshots. This uses the existing
latest-only `saveRunSnapshot` capability and introduces no store method;
without that capability there is no partial write. Recovery consumes a
well-formed `partialText`/`partialRound` from a newer snapshot as assistant
text, while older snapshots without those fields retain their existing
behavior. If `minBytes` is set, individual smaller deltas do not schedule a
write; omit it when the interval loss bound must apply to every incoming delta.
Prerequisite: set `stream: true`; otherwise startup throws.

The `executeTool` boundary has one call shape and no arity negotiation:

```js
executeTool({ id, name, input, context, signal })
```

Canonical execution results have one of these three forms:

- `string`
- `{ content, metadata?, success? }`
- `Error`

The older `{ data, success, ... }` shape and other duck-typed shapes are
normalized permissively for compatibility, but are deprecated and must not be
depended on.

### Where option validation happens (issue #496)

Option validation is a property of the **normalised option representation**, not of the entry
route a host happens to call. Two phases share one rule source:

- **Pre-check phase** — object shape plus the top-level name allowlist, run before any host
  port is read (`assertRunToolLoopOptionNames` (`src/loop/option-normalization.js`)). An
  unknown top-level key therefore still throws before `assemblyPortOptions`, before
  `modelConfig.resolve`, and before the capability check.
- **Semantic phase** — value and callback-shape rules, run on the **merged** representation:
  `assertSemanticOptionValues` (`src/assembly-validators.js`) is called after the explicit
  options have been merged over the assembled ones, and `createAssemblyPort` calls the same
  function on its `policy`. The rules themselves live in `collectSemanticOptionProblems` (`src/assembly-validators.js`) — one condition, one message, no per-route copy.

Both routes therefore raise the same `TypeError` with the same message. The only difference is
the `via` own-property on the error object: `"assembly"` for the assembly-port shape,
`"direct"` for fine-grained `runToolLoop` options. These messages carry no `did you mean`
suffix (that suffix belongs to the top-level name allowlist alone).

The semantic phase owns exactly these rules: `context` must be an object when present
(omitted or `null` means "no context"); an unknown `context` key that is a **misspelled
summarizer knob** throws; summarizer knob values must be positive safe integers; and every
field that carries a host callback must be a function when provided — `finalGuard`,
`config.timing.retry.sleepImpl` (issue #498 S3: `retry` is `config.timing.retry` now, so the flat
spelling is refused one phase earlier by the name gate), `reflection.onReflection`,
`diagnostics.error`, `onFoldSummary` (top level), `context.onBeforeFold`, `context.onAfterFold`. Two families
stay where they are on purpose: `deliverables[].check` is validated by `normalizeDeliverables` (`src/loop/deliverables.js`), and the remaining value rules (`maxRounds`, `partialPersistence`,
`persistence`, …) are `runToolLoop`'s own startup checks — both already run for every route
because both routes converge there.

One doctrine covers every callback field: **omitted means "not subscribed"**; `null` and any
other non-function value mean "provided but wrong" and throw at startup. There is exactly one
exception — `context: null` is verbatim identical to omitting `context`. The reason is that the
engine already reads `undefined` and `null` identically there, so throwing would only break hosts
that pass a nullable field straight through, and it would buy no property. Top-level callbacks
deliberately get **no** such pass: `finalGuard: null`, `config.timing.retry.sleepImpl: null` and
`onFoldSummary: null` all throw. Uniform doctrine beats one fewer half-break, and "a `null` hook
silently means no hook" is exactly the class of quiet configuration this change makes loud.

Host metadata keys inside `context` (anything that is not an engine-read key and not a misspelled
knob) are still **tolerated** — they never throw. In this one respect the two routes differ: the
assembly-port route reports them through a `context_unknown_option` event, while the fine-grained
route **never emits that event** — the assembly port is its only emission point — so the keys pass
in silence. That is not because the fine-grained route lacks an observer channel: `onEvent` is a
first-class option there and receives `round_start` / `attempt` / `usage` / `round_end` /
`run_outcome` (see “Nine host callbacks observe a run”). It is only *this* event that never arrives,
and a host waiting for it on the fine-grained route will wait forever; that is a property of the
route, not of the validation.

The message `unknown assembly policy context option: …` is **historical wording**: hosts match
that string verbatim, so it is preserved character for character. On the fine-grained route there
is no `policy` — the phrase survives only because renaming it would break existing string matching.

The misspelled-knob criterion (edit distance ≤ 2 to a known summarizer knob name) is itself
unchanged, but its **blast radius is not**: it used to be applied only to assembly-port hosts and
now applies to every `runToolLoop` host. Measured boundary — `summarizerBudget`,
`summarizerTimeout` and `maxSummaryToken` are read as slips and throw; `summaryStyle`,
`summarizerNote` and `maxSummaryChars` still pass.

### The call-level override channel (`assemblyPortOptions(input, overrides)`, issue #498)

`assemblyPortOptions` takes a second parameter: fine-grained options a host wants to apply **after**
the port has been converted. Up to and including 0.26.0 (the last published release — 0.27.0 was
**never published**, so 0.28.0 is the first release a host can actually install with the new
behaviour) that channel was silent about three things; **since 0.28.0 all three throw at startup**:

- **A key the port already supplied.** `overrides.maxRounds` when `policy.maxRounds` is set,
  `overrides.provider` when the port has a provider, `overrides.store` when the port has a store,
  `overrides.onEvent` when the port has `emit`, … throw
  `assembly port option override conflicts with the port: "<key>" comes from <construction source>
  (construction) and overrides.<key> (call); pass it in one place only`. The construction-time
  source is named verbatim: `port.policy.maxRounds`, `port.provider`, `port.tools.definitions`,
  `port.tools.executeTool`, `port.store`, `port.session.id`, `port.session`,
  `port.session.initialMessages`, `port.emit`. The ruling behind it is the mother ticket's (#495):
  the capability set is fixed at **construction** time, and a run-time swap is exactly the "one
  knob, two homes" problem the config/capability split exists to remove.
- **A name outside the option allowlist.** `overrides` keys must be legal `runToolLoop` options; the
  set is read out of `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`), never from a
  second copy, so the accept surface still has one source (issue #496 / #502). A typo throws
  `unknown assembly port override option: "maxRound" (did you mean "maxRounds"?)` — same allowlist,
  same edit-distance rule as the top-level name check.
- **A container.** `overrides.config` / `overrides.capabilities` throw
  `assembly port override must not replace the "config" container: pass the specific sub-keys
  instead (e.g. config.run.maxRounds)`, because replacing a whole subtree would mix the two planes
  (#498) back together.

Two things deliberately **do not** throw, and both are pinned by tests:

- **A key the port did not produce** — the per-round ones (`signal`), and `store` when the port
  gives none. That is the legal use of the channel and it keeps working.
- **`modelConfig`** — the one pre-existing override, validated by `validateModelConfigResolver` (a
  plain config object still throws with the migration hint). It is exempt from the conflict rule
  because the port always resolves one: the explicit value replaces the resolver, and the port's
  own resolver is never called.

`undefined` still means "not given" (the merge condition stays `value !== undefined`), so spreading
a possibly-undefined field is not punished. The gate runs **before** `modelConfig.resolve` and before
any other host callback, so a call that is going to throw does not touch the host first.

**Scope of the narrowing**: it applies to the `overrides` parameter only. The direct route's merge —
`runToolLoop({ assemblyPort, provider })`, where an explicit fine-grained option wins over the
same-named member the port supplies (`src/loop/option-normalization.js`, issue #177) — is unchanged;
`test/contract/assembly-port.js` asserts that behaviour for the direct route and asserts the throw
for the override channel.

Behaviour change to know about in 0.27.0 — a number that was **never published** (the last
published release is 0.26.0, so everything in this paragraph reaches a host for the first time in
**0.28.0**): a misspelled summarizer knob under `context`, and a
non-function value in any of the callback fields above, used to be **silently ignored** on the
fine-grained route (the run simply used the defaults). Both now throw at startup. The capability
plane that accepts these callbacks outside the config tree **landed in 0.28.0** (issue #498 S4a):
`capabilities.hooks` is their canonical home, and the flat positions listed above keep working
unchanged (the move is additive — see “The `capabilities` namespace” below).

### The `config` namespace (issue #497)

A run's configuration has a second spelling. `config` is a **nested namespace** whose leaves are
aliases of the flat top-level keys, and the alias **is** the schema path: `config.run.maxRounds`
and the flat `maxRounds` are the same knob, and a leaf name is verbatim the flat option name —
with exactly one registered exception, `config.input.messages`, the nested alias of the flat
`initialMessages` (issue #498 S4b). That exception is a one-entry table (`CONFIG_LEAF_ALIAS_PATHS`
(`src/loop/config-namespace.js`)) and the self-check holds it to two things: a registered alias must
name a leaf that really exists (a dead entry is a failure), and it must not rename onto a leaf name
that group already has. It is not a rename table you can grow. **Version scope** (issue #517): the
`config` namespace entered the tree at 0.27.0 — a version that was **never published** (the last
published release is 0.26.0, so the first release a host can actually install with this namespace is
0.28.0) — and in every tree up to and including 0.27.0 every leaf name was
verbatim a top-level option name; **since 0.28.0 (the issue #517 preparatory refactor) a leaf may
have no top-level alias, while every top-level option must still have exactly one home** — the
self-check is **one-directional** (top-level option → exactly one home: config surface / capability /
container), and "every leaf must be reached by the round-trip coverage table" is held by a
**per-leaf** assertion in the suite (independent of whether the leaf has a top-level key). One schema,
`CONFIG_NAMESPACE_SCHEMA` (`src/loop/config-namespace.js`), is the only hand-written part; the alias map
`CONFIG_ALIAS_PATHS` (`src/loop/config-namespace.js`) and the config-surface list
`CONFIG_SURFACE_OPTION_NAMES` (`src/loop/config-namespace.js`) are derived from it, and
`configSchemaSelfCheck` (`src/loop/config-namespace.js`) keeps the pair honest against the
top-level allowlist in three directions: every top-level option must be classified as exactly one
of *config surface*, *capability* (22 keys), *top-level surface* (the permanent top-level options —
the third station, issue #527) or *container* (2: `config` and `capabilities`), and the buckets must
add up to the allowlist. Since issue #517 the *config surface* bucket is the
**intersection** of "the names the schema maps onto" with the allowlist, so a leaf that loses its
top-level key merely drops out of that bucket instead of turning the identity red. **Since issue
#498 S3 (the `timing` slice, the first one) that difference is no longer empty**: `config.timing.timeoutMs` /
`.deadlineMs` / `.retry` lost their flat top-level spelling, and every later S3 slice takes more
(`folding.*`, `input.cacheStablePrefix` / `initialMessages` / `initialUserMessage`, `tuning.cacheCapable`),
so the config-surface bucket is smaller than the leaf count by **however many S3 has retired so far** —
derive it (`CONFIG_SURFACE_OPTION_NAMES.length - configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES).length`)
instead of copying a number; the buckets still have to add up to the allowlist. The totals are
not restated here on purpose — derive them (`configPlaneOptionNames(RUN_TOOL_LOOP_OPTION_NAMES).length`,
`CAPABILITY_OPTION_NAMES.length`, `NAMESPACE_CONTAINER_OPTION_NAMES.length`) rather than copying a
total that goes stale the next time a group moves.

| namespace | knobs |
| --- | --- |
| `config.input` | `system`, `cacheStablePrefix`, `initialUserMessage`, `messages` (the flat `initialMessages`), `wrapup` — **not** `tools` (issue #527: it is a permanent top-level option, the third station) |
| `config.run` | `maxRounds`, `maxTokenContinuations`, `stallDetection`, `completion`, `replayPolicy`, `invalidArguments`, `partialPersistence`, `persistence`, `outputHygiene`, `writeToolNames`, `writeToolPathKeys`, `resume`, `stream`, `reflection`, `runId`, `cwd` |
| `config.tuning` | `maxTokens`, `temperature`, `topP`, `cacheCapable` |
| `config.timing` | `timeoutMs`, `deadlineMs`, `retry` |
| `config.folding` | `context`, `toolResultTtl`, `toolResultFoldMinTokens` |
| `config.guard` | `finalGuardMaxRetries`, `finalGuardTimeoutMs`, `finalGuardExtend` |
| `config.metadata` | `expert`, `user`, `task`, `requestId`, `toolContext`, `model`, `modelMetadata` — **not** `session` (issue #531: it is a permanent top-level option, the third station) |

**Version scope of the flat spelling** (issue #498 S3, the `timing` slice). This is the first slice
that actually **retires** flat top-level keys, so the rule is stated as versions, not as "today":

| release | writing `timeoutMs` / `deadlineMs` / `retry` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3) | **rejected on the spot** — write `config.timing.timeoutMs` / `.deadlineMs` / `.retry`. The name gate throws `unknown runToolLoop option: "timeoutMs" (its canonical home is config.timing.timeoutMs; the flat spelling is rejected)`, and the message always names the new home, because that sentence is the only thing standing between an upgrading host and a guessing game |

The three keys are the whole slice: the other config groups still accept their flat spelling, and
that has not changed. What *did* change is the mechanism hosts should rely on when reading values
back: the expansion phase still writes each of the three onto `effectiveOptions.timeoutMs` /
`.deadlineMs` / `.retry`, so **the engine's read side is unchanged** — the retirement is a
*write-spelling* change only. One consequence worth naming, because it is silent otherwise: the old
shell slot `retry.sleepImpl` is no longer reachable from a host at all. Its flat spelling is refused
by the name gate, and `config.timing.retry.sleepImpl` is refused by the "`config` holds data only"
rule; the canonical home for a retry timer is, and was, `capabilities.ports.sleepImpl`.

**Flat-spelling version policy** (issue #498 S3, the `folding` slice — the second one, and it
**retires** flat top-level keys too):

| release | writing `context` / `toolResultTtl` / `toolResultFoldMinTokens` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, second slice) | **rejected on the spot** — write `config.folding.context` / `config.folding.toolResultTtl` / `config.folding.toolResultFoldMinTokens`. The name gate throws `unknown runToolLoop option: "toolResultTtl" (its canonical home is config.folding.toolResultTtl; the flat spelling is rejected)` |

**Flat-spelling version policy** (issue #498 S3, the `input` group's A segment — the third slice,
and the first one whose keys live in `config.input`):

| release | writing `cacheStablePrefix` / `initialMessages` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, third slice) | **rejected on the spot** — write `config.input.cacheStablePrefix` / `config.input.messages`. The name gate throws `unknown runToolLoop option: "cacheStablePrefix" (its canonical home is config.input.cacheStablePrefix; the flat spelling is rejected)` |

`initialMessages` is the interesting one, and the message is the reason to read this paragraph:
**the home it names is `config.input.messages`, not `config.input.initialMessages`**. The leaf is
`messages` and the top-level key it used to be spelled as is `initialMessages` — that single rename
is the *only* entry in `CONFIG_LEAF_ALIAS_PATHS` (`src/loop/config-namespace.js`), and it is explicit
rather than derived precisely so it can be counted (one record) and checked (the leaf must exist).
Writing the old *top-level* name as a leaf (`config.input.initialMessages`) is the most common slip
and gets its own message (`unknown config.input option: "initialMessages" (… belongs to
config.input.messages)`), so the two sentences point at each other and both end at the same place.

Since this slice `config.input.messages` is a leaf **without** a top-level twin, which is the shape
issue #517 made legal on purpose (`configSchemaSelfCheck` requires "every top-level option has
exactly one home", not "every leaf has a top-level key"). Two consequences, both machine-checked:

* the expansion phase still writes the leaf onto `effectiveOptions.initialMessages`, so the engine's
  read side is unchanged — the retirement is a *write-spelling* change only (same mechanism as
  `timing` / `folding`);
* the **assembly port** is unaffected: `policy.session.initialMessages` still seeds a run (that is a
  port member, not a top-level option, and it never went through the name gate). It also means the
  flat key can still *appear* in the merged representation, so a host that writes both
  `policy.session.initialMessages` and `config.input.messages` gets one `config_override_conflict`
  event with `path: "input.messages"` — `config` wins, and it is not silent.

**Flat-spelling version policy** (issue #498 S3, the `input` group's A2b segment — the fourth slice,
and the one that closes `config.input`: every member of that group is now nested-only):

| release | writing `initialUserMessage` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, fourth slice) | **rejected on the spot** — write `config.input.initialUserMessage`. The name gate throws `unknown runToolLoop option: "initialUserMessage" (its canonical home is config.input.initialUserMessage; the flat spelling is rejected)` |

This is the seed message of a run — the one key almost every host writes, which is why it is worth
spelling out. Two properties hold, both machine-checked:

* the leaf stays in `CONFIG_NAMESPACE_SCHEMA.input` (`src/loop/config-namespace.js`) even though it
  has no top-level twin any more — that is the #517 shape (`config.input.messages` had it first), and
  the expansion phase still writes it onto `effectiveOptions.initialUserMessage`, so **the engine's
  read side is unchanged**;
* `initialMessages` still wins over it on the read side when both are present (that precedence is
  untouched), so a resumed run with seed history ignores the seed message exactly as before.

One consequence worth naming: an explicit call-level `config` **replaces** `policy.config` wholesale
(the pre-existing merge rule, reported as one `config_override_conflict` event). Now that the seed
lives in `config.input`, a host that puts its seed in `policy.config.input.initialUserMessage` and
then passes a call-level `config` for something else loses the policy one — same rule as before, but
it now reaches a key nearly every host uses.

**Flat-spelling version policy** (issue #498 S3, the `tuning` slice — the fifth slice, and the first
one that retires a **scalar** knob instead of a shell):

| release | writing `cacheCapable` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, fifth slice) | **rejected on the spot** — write `config.tuning.cacheCapable`. The name gate throws `unknown runToolLoop option: "cacheCapable" (its canonical home is config.tuning.cacheCapable; the flat spelling is rejected)` |

Two properties hold, both machine-checked:

* the expansion phase still writes it onto `effectiveOptions.cacheCapable`, so **the engine's read side
  is unchanged** — the only reader is the TTL-folding default (`cacheCapable === true` together with
  no explicit `toolResultTtl` ⇒ tool-result TTL folding off). The retirement is a *write-spelling*
  change only, exactly like the four slices before it;
* the rejection message names **one station and only one**. Every earlier slice could not say that:
  `context` and `retry` are **mixed shells**, so their message appends a second station
  (`capabilities.hooks.<name>` / `capabilities.ports.<name>`). `cacheCapable` is a boolean, it has no
  behaviour members, and the second station is derived from `CAPABILITY_SLOT_DESTINATIONS`
  (`src/loop/capabilities-namespace.js`), which registers nothing for it — so the message deliberately
  carries **no** `capabilities.*` hint. That is a derived
  fact, not a promise: if the key ever grows a behaviour member the second station appears on its own,
  and the suite goes red if the message does not follow.

One naming trap is worth spelling out, because the same word lives on **two different surfaces**.
The `cacheCapable` this section retires is the **`runToolLoop` option**. The other one is the
**model-slot / config-file** field `slots.default.cacheCapable` (`src/config/env.js` reads it from
`CACHE_CAPABLE`; `bin/config.js` forwards it; `bin/cli.js` reads it in `resolveToolResultTtl`) — that
surface never went through the name gate, it is unchanged by this slice, and writing it is still
correct. Do not "migrate" a config file into `config.tuning`.

**Flat-spelling version policy for the `guard` group** (issue #498 S3, the `guard` slice — the sixth
slice, and the first one that retires **three** keys at once, all of them scalars):

| release | writing `finalGuardMaxRetries` / `finalGuardTimeoutMs` / `finalGuardExtend` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, sixth slice) | **rejected on the spot** — write `config.guard.finalGuardMaxRetries` / `config.guard.finalGuardTimeoutMs` / `config.guard.finalGuardExtend`. The name gate throws `unknown runToolLoop option: "finalGuardTimeoutMs" (its canonical home is config.guard.finalGuardTimeoutMs; the flat spelling is rejected)` |

Two properties hold, both machine-checked:

* the expansion phase still writes each of them onto `effectiveOptions.finalGuardMaxRetries` /
  `.finalGuardTimeoutMs` / `.finalGuardExtend`, so **the engine's read side is unchanged** — the three
  readers are the retry limit, the per-attempt guard deadline, and the budget-stop bridge, and none of
  them was touched. The leaf stays in `CONFIG_NAMESPACE_SCHEMA.guard` (`src/loop/config-namespace.js`)
  even though the top-level key left `RUN_TOOL_LOOP_OPTION_NAMES`
  (`src/loop/option-normalization.js`): deleting the flat key is **not** deleting the leaf. Retirement
  is a *write-spelling* change only, exactly like the five slices before it;
* the rejection message names **one station and only one**. All three values are scalars, so nothing is
  registered for them in `CAPABILITY_SLOT_DESTINATIONS`
  (`src/loop/capabilities-namespace.js`) and the message deliberately carries **no** `capabilities.*`
  hint. Derived, not promised: a behaviour member would make the second station appear on its own.

**Two names this slice does not touch, and one it must not be confused with.** `finalGuard` is a
**hook**, not data: its value must be a function, so it has no config home at all — it lives in
`capabilities.hooks.finalGuard` and the flat top-level spelling stays legal until **S9** retires it.
`finalGuardVerdict` is an **engine-internal** key: a host may neither write it nor find it in the config
tree, so writing it is still rejected and the message carries **no** canonical-home hint (there is no
home to name). Neither name appears in `CONFIG_NAMESPACE_SCHEMA.guard`.

**Flat-spelling version policy for the `tuning` group** (issue #498 S3, the `tuning` slice's A5
segment — the seventh slice, and the one that closes `config.tuning`: `cacheCapable` left in the A3
segment, these three are the rest of the group):

| release | writing `maxTokens` / `temperature` / `topP` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, seventh slice) | **rejected on the spot** — write `config.tuning.maxTokens` / `config.tuning.temperature` / `config.tuning.topP`. The name gate throws `unknown runToolLoop option: "maxTokens" (its canonical home is config.tuning.maxTokens; the flat spelling is rejected)` |

Two properties hold, both machine-checked:

* the expansion phase still writes each of them onto `effectiveOptions.maxTokens` / `.temperature` /
  `.topP`, so **the engine's read side is unchanged** — the readers are the request assembly in
  `src/loop/provider-runner.js` and `src/loop/termination.js`, and neither was touched. The leaves stay
  in `CONFIG_NAMESPACE_SCHEMA.tuning` (`src/loop/config-namespace.js`) even though the top-level keys
  left `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`): deleting the flat key is
  **not** deleting the leaf. Retirement is a *write-spelling* change only, exactly like the six slices
  before it;
* the rejection message names **one station and only one**. All three values are scalars, so nothing is
  registered for them in `CAPABILITY_SLOT_DESTINATIONS`
  (`src/loop/capabilities-namespace.js`) and the message deliberately carries **no** `capabilities.*`
  hint. Derived, not promised: a behaviour member would make the second station appear on its own.

**These three words live on five other planes, and this slice moved none of them.** That is the whole
reason this group needed its own paragraph: a repo-wide grep for `maxTokens` returns far more than the
option that just retired, and migrating any of the rest would be a regression. Concretely:

| plane | where it lives | status |
| --- | --- | --- |
| `runToolLoop` top-level option | `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`) | **retired by this slice** (the only one that moved) |
| `config.tuning.*` | `CONFIG_NAMESPACE_SCHEMA.tuning` (`src/loop/config-namespace.js`) | the canonical home — write here |
| model-slot / config-file field `slots.default.maxTokens` | read by `createProviderForSlot` (`src/config/slot-provider.js`) and forwarded by `bin/cli.js`; it flattens to the request's `max_tokens` | **untouched** — a config file is not a `runToolLoop` option and never went through the name gate |
| config-file sampling defaults `temperature` / `topP` | `src/config/env.js` (`TEMPERATURE` / `TOP_P`) | **untouched** — same reason |
| assembly `policy.maxTokens` | `src/assembly.js` — a port member, not a top-level option | **untouched**; it still reaches the request body |
| provider request fields `maxTokens` / `temperature` / `topP` | `src/messages/anthropic.js`, `src/providers/openai.js` | **untouched** — that is the engine's *read* side, and the expansion phase feeds it |

One near-miss worth naming: `maxTokenContinuations` is a **different key** (its home is
`config.run.maxTokenContinuations`, and it stays a legal flat option). A whole-word grep for
`maxTokens` drags it in; it is not part of this slice and the flat spelling keeps working.

**Flat-spelling version policy for the `input` group's A6 segment** (issue #498 S3, the eighth
slice — the one that was supposed to close `config.input`; it does **not**, see below):

| release | writing `system` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, eighth slice) | **rejected on the spot** — write `config.input.system`. The name gate throws `unknown runToolLoop option: "system" (its canonical home is config.input.system; the flat spelling is rejected)` |

Two properties hold, both machine-checked:

* the expansion phase still writes it onto `effectiveOptions.system`, so **the engine's read side is
  unchanged** — the reader is the system-prompt assembly that folds the wrap-up instruction in
  (`src/loop/orchestrator.js`), and it was not touched. The leaf stays in
  `CONFIG_NAMESPACE_SCHEMA.input` (`src/loop/config-namespace.js`) even though the top-level key left
  `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`): deleting the flat key is **not**
  deleting the leaf. Retirement is a *write-spelling* change only, exactly like the seven slices
  before it;
* the rejection message names **one station and only one**. The value is a scalar, so nothing is
  registered for it in `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`) and the
  message deliberately carries **no** `capabilities.*` hint. The *function-value* message for this
  same leaf goes one step further and says outright that there is no capability home for it — `system`
  is a data key, so the fix is "pass plain data", not "move it to the capability surface".

**`config.input` is closed except `wrapup`; `tools` is not a config key at all (issue #527).** The
A6 slice returned `tools` pending a ruling; that ruling has landed. The two keys are pinned in
`test/loop-input-keys-slice-498s3a6.test.js` (G1–G5, S) and `test/loop-config-namespace-497.test.js`
(I3):

* **`tools` is a permanent top-level option — the third station — alongside `provider` /
  `executeTool` / `store`.** The A6 reachability check proved the reason: a host may hand in tool
  definitions whose entries carry **function members** — `handler`, `validate`, `execute`, or a
  function inside `inputSchema`. Every one of those shapes is **accepted** through the flat `tools`
  and would be **rejected** at `config.input.tools`, because `config` holds data only (the subtree
  must survive a JSON round-trip, so a function value is refused at intake with its full path). At
  the same time the engine never calls those members, so `tools` is not a capability either — the two
  protocol adapters project each entry down to `{name, description, inputSchema}` (the OpenAI
  projection in `src/messages/canonical.js`, the Anthropic payload builder in
  `src/messages/anthropic.js`). The #527 ruling therefore **removed the leaf**: `tools` lives only at
  the top level, and writing `config.input.tools` is rejected on the spot as an **unknown leaf**
  whose message points at the third station, at the top level:

  ```text
  unknown config.input option: "tools" ("tools" is a permanent top-level option — the third station —
  write it at the top level: tools: …)
  ```

  The engine's read side is unchanged: it still reads `effectiveOptions.tools`, and the flat
  spelling is the one the host writes. `config.input.tools` is gone for **every** shape — plain data,
  arrays, scalars and `undefined` alike (G5) — so this is a closed door, not a narrowed one.

  | release | writing `config.input.tools` |
  | --- | --- |
  | 0.26.0 and earlier (the last **published** release) | the `config` namespace did not exist yet, so no host ever wrote this path — there is no migration cost |
  | 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
  | 0.28.0 and later (issue #527) | **rejected on the spot** — write the top-level `tools`; the leaf is not on the schema and the message names the third station |

* **`wrapup` is deferred.** Its flat write points are spread over ~35 test files / ~106 occurrences
  (`wrapup: false` is the fixture idiom for turning the wrap-up protocol off); deleting the key turns
  **189** test cases red at once, and a naive rewrite repeats the #521 problem (475 write points plus
  "this file already has a `config:` key" collisions that a plain replace turns into a silently
  winning duplicate). The right order is a fixture-level translation point first — `withSeed` in
  `test/helpers/run-direct.js` is the precedent — and the key second. `wrapup` therefore stays a
  legal flat option; its canonical home `config.input.wrapup` already exists and is exercised.

The accounting is machine-derived rather than remembered: the `input` group now has exactly **one**
member with a flat twin (`wrapup`), and the suite asserts that the set equals the returned list. The
third station is derived in both directions too: the keys with **no nested home** (`configPathForOption`
and `capabilitiesPathForOption` both `undefined`) are exactly `TOP_LEVEL_SURFACE_OPTION_NAMES` plus the
two containers — **12** after #527, up from 11 before it, with `tools` as the added member. Re-adding
the `config.input.tools` leaf makes the self-check red and names the key, which is the reverse proof
that the account is live rather than a copied expectation.

**These three words live on six other planes, and this slice moved none of them.** A repo-wide grep
for `system` / `tools` / `wrapup` returns far more than the three options, and migrating any of the
rest would be a regression:

| plane | where it lives | status |
| --- | --- | --- |
| `runToolLoop` top-level option | `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`) | `system` **retired by the A6 slice**; `wrapup` still legal flat; `tools` is a **permanent top-level option** (the third station, same class as `provider` / `executeTool` / `store`) — it has no nested home at all |
| `config.input.*` | `CONFIG_NAMESPACE_SCHEMA.input` (`src/loop/config-namespace.js`) | the canonical home for **data** leaves — `tools` is **not** one of them since #527 (the leaf was removed) |
| provider request field `system` / OpenAI `role: "system"` | `src/messages/anthropic.js`, `src/messages/canonical.js` | **untouched** — that is the engine's *read* side, and the expansion phase feeds it |
| `systemPrompt` / `systemPromptMode` / `systemPromptFile` | issue #505's two slices — **independent options**, never members of this group | **untouched**; neither is a `runToolLoop` top-level key, and neither has a config home |
| the reflection wrap-up container (`config.run.reflection.wrapupNormalize`) | `src/loop/orchestrator.js`, `src/reflection/wrapup.js` | **untouched** — a different thing from the top-level boolean `wrapup` |
| `erix-agent/tools` subpath export and the tool registry (`src/tools/index.js`) | capability surface | **untouched** — a module export, not an option key |

The `context` row carries one sentence that **must** be read: it is a **mixed shell** — it holds
data members (`budgetTokens` / `keepRounds` / a strategy *name*) **and** behaviour members (the five
functions `onBeforeFold` / `onAfterFold` / `stubFor` / `protectedMessage` / `recoveryHint`, plus the
object form of `strategy`), while `config` holds **data only** (the subtree must survive a JSON
round-trip unchanged). So when the top-level `context` is rejected, the message names **both
stations in one sentence**:

```text
unknown runToolLoop option: "context" (its canonical home is config.folding.context; the flat spelling is rejected)
  — this shell holds both data and functions: write data as config.folding.context.<leaf>,
    and behaviour members as capabilities.hooks.<name>
    (onBeforeFold / onAfterFold / stubFor / protectedMessage / recoveryHint) or capabilities.ports.strategy
```

Naming only one station sends the host into a second wall: putting `onBeforeFold` into
`config.folding.context` is refused by "`config` holds data only", and only *that* message mentions
`capabilities.hooks.onBeforeFold`. Both stations have to appear in the **same** sentence — during an
upgrade it is the only signpost there is. The sentence is derived from `CAPABILITY_SLOT_DESTINATIONS`
(not a `context` special case), so every shell that holds both data and behaviour gets its second
station automatically: for `retry` it is `capabilities.ports.sleepImpl`.

The read side is unchanged: the expansion phase writes these three leaves onto
`effectiveOptions.context` / `.toolResultTtl` / `.toolResultFoldMinTokens`, so **the engine's read
side did not change by a single line**. The assembly port's `policy.context` is **not** narrowed
(function leaves still get through it, with 0.26 semantics), but the shipped contract only promises
`capabilities.*`.

The `config.observers` group that 0.27.0 carried is **gone in 0.28.0** (issue #498 S4a): a callback
is not data, and a `config` subtree that holds one cannot survive a JSON round-trip. Callbacks live
in `capabilities.hooks` (next section). `finalGuard` left the table for the same reason — its value
*must* be a function, so by the criterion below it is a behaviour carrier, not data; the flat
top-level `finalGuard` is untouched, and its nested home is `capabilities.hooks.finalGuard`
(issue #498 S4b). `deliverables` left the table in the same slice, for the same reason: every entry
carries a function `check`, so it lives in `capabilities.checks.deliverables`. The `prompt` group
was renamed `input` (issue #498 S4b) and now also carries `tools` — see the historical note on
`tools` further down.

Five rules govern it:

- **Precedence** — when the same knob is given both ways, `config.*` wins. The flat key keeps being
  accepted and behaves exactly as before whenever it is the only spelling. A leaf set to
  `undefined` is verbatim "not provided" (the same rule the flat merge uses), so it neither
  overrides a flat value nor counts as a conflict.
- **Conflicts are not silent** — when both spellings are present with **different** values the
  engine emits one `config_override_conflict` event before the first round:
  `{ type: "config_override_conflict", runId?, conflicts: [{ path, key }], detail }`. The payload
  carries paths and key names only (values may be functions or large objects). An observer that
  throws on that event is isolated like every other observer channel — recorded through
  `onObserverError`, and the run continues.
  **The same event covers the second pair of sources** (issue #497 review R4): the assembly port's
  `policy.config` and the call-level `config` are two spellings of the *same* tree, and the
  call-level one wins as a **whole tree** (the pre-existing "last writer wins" merge rule, kept
  byte for byte). That override is reported leaf by leaf through the same event and the same
  fields: every leaf that both sources set to **different** values appears once in `conflicts`
  (`{ path, key }`, deduplicated by path, ordered by schema group then declaration order). Equal
  values, or a leaf only one side sets, are not conflicts — and note the flip side of a whole-tree
  override: a leaf that only the overridden tree sets is **dropped** (it falls back to the
  default), so do not use the two sources as a per-leaf merge. Measured before this fix: policy
  `run.maxRounds: 4` plus call-level `1` ran **1** round and emitted **zero** events.
- **Structural equivalence** — the same configuration written flat and written as `config` produces
  the same `effectiveOptions`, key for key. Expansion runs on the **merged** representation (after
  the assembly port has been folded in, before the semantic phase), so a `config` value goes
  through exactly the same validation as its flat twin: a misspelled summarizer knob under
  `config.folding.context` throws the same message as under the flat `context`, and
  `config.timing.retry.sleepImpl` must be a function for the same reason its flat twin used to have to
  be (issue #498 S3: that flat twin is gone — `retry` is now only writable as `config.timing.retry`).
- **Function values are refused at intake** (issue #498 S4a). A JSON round-trip check is a
  post-mortem; refusal is the guarantee that "you thought you configured it, and it was never
  configured" cannot happen. The whole `config` subtree is walked node by node — arrays included —
  and any function value throws at startup with the **full path** named
  (`config.folding.context.onBeforeFold`, not `onBeforeFold`): the field shells that really are
  called as functions are `config.timing.retry.sleepImpl`, `config.run.reflection.onReflection`,
  `config.run.reflection.judge.provider` and `config.folding.context.onBeforeFold` /
  `onAfterFold`. The message also names the canonical home, **by real path**: `capabilities.hooks.<name>`
  for a host callback (`config.folding.context.onBeforeFold` → `capabilities.hooks.onBeforeFold`),
  `capabilities.checks.deliverables` for a deliverables check, and `capabilities.ports.<slot>` for a
  port implementation — `config.timing.retry.sleepImpl` → `capabilities.ports.sleepImpl`,
  `config.run.reflection.judge.provider` → `capabilities.ports.judgeProvider`,
  `config.folding.context.strategy` (and anything below it) → `capabilities.ports.strategy`. The
  mapping is not guessed from the leaf name alone: the full path is matched against the registered
  destinations (`CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`)), so a leaf
  whose name says nothing (`provider`) still lands on its real slot. A config **data** key (such as
  `config.input.wrapup`) has no capability home at all, and the message says exactly that — `there is
  no capability home for it: …` — instead of inventing one. Nothing is "accepted and then dropped
  during expansion" — the throw happens **before any host port is read**. Two leaves that used to be
  the awkward part of this rule are simply not config keys any more: `config.guard.finalGuard` and
  `config.guard.deliverables` (issue #498 S4b) — see the table above and the `capabilities` section
  below. **History**: before issue #498 S4c this paragraph ended the sentence with "or the matching
  capability port slot", which pointed at a slot that did not exist yet (there was no
  `capabilities.ports`); that is why the paths above are spelled out now.
- **Capability keys are refused** — the 22 capability options in
  `CAPABILITY_OPTION_NAMES` (`src/loop/config-namespace.js`) are not configuration: `provider`,
  `executeTool`, `store`, `modelConfig`, `assemblyPort`, `signal`, `todoStateProvider`,
  `semanticStateProvider`, `onEvent`, `onObserverError`, `onPersistenceError`, `diagnostics`, the
  eight observer channels (`onRound`, `onJudge`, `onToolResult`, `onDelta`, `onReasoningDelta`,
  `onToolCall`, `onUsage`, `onFoldSummary`), `finalGuard` and `deliverables`. Writing one inside
  `config` (at the top level or under a group) throws at startup and names the key; the message also
  names the new home when there is one (`capabilities.hooks.<name>` / `capabilities.checks.<leaf>`),
  and the error carries the same `via` tag as every other gate error (`"direct"` / `"assembly"`).
  The nine leaves that only exist as capability **slots** (issue #498 S4c) are not on that list
  because they are not top-level options at all: writing `sleepImpl` / `onBeforeFold` / … at the top
  of `config`, or one group too high (`config.timing.sleepImpl`, `config.folding.onBeforeFold`),
  answers `unknown config.<group> option: … (… belongs to capabilities.<group>.<leaf>)`, and writing
  one in its real nested home (`config.timing.retry.sleepImpl`) hits the function-value refusal above.
  **This narrowing applies to the new namespace only**:
  the direct-route precedence rule — an explicit fine-grained option overrides the same-named
  member the assembly port supplies (`src/loop/option-normalization.js`), e.g.
  `runToolLoop({ assemblyPort, provider })` still lets the explicit `provider` beat the port's —
  is unchanged, and `test/contract/assembly-port.js` keeps asserting it for that route
  ("直连路线的显式 provider 仍覆盖端口 provider"). **The helper's `overrides` parameter is a
  different story since 0.28.0** (issue #498): `assemblyPortOptions(port, { provider })` now throws
  at startup instead of silently winning — see "The call-level override channel" above.

  **Where the line runs (issue #497 review R1, the criterion is behavioural):** the capability
  surface is what the host hands in as **behaviour carriers** — functions and port objects the
  engine *calls or dereferences* (a port method is invoked, a signal is listened to, callbacks are
  delivered to). The config surface is **data the engine validates and interprets by known
  field** — enum literals, numbers, booleans, string scalars, objects with a known shape. That is
  why four keys that used to sit on the capability list are configuration, and why writing them
  under `config` is accepted and takes effect: `persistence` (`config.run.persistence`; its
  `"none"` / `"required"` literal is validated and picks the persistence path — `"required"`
  turns on the transcript-store method check), `model` / `modelMetadata` (`config.metadata.*`;
  their `contextWindowTokens` / `maxOutputTokens` numbers are read by `modelMetadataFor`
  (`src/loop/budget.js`) to derive the compaction budget and the 15%-of-window output limit) and
  and `session` (`id` is validated, `modelSlot` is passed to
  `modelConfig.resolve`, `initialMessages` is read). The old wording — "capability
  means the engine does not interpret its value" — was measurably false for all four. Note that
  `session` is data **only**: the 0.27 draft also accepted `session.resume` as an alias of the flat
  `resume`, and that alias is gone (issue #498 S4b) — `session.resume` now throws on **both** entry
  routes (the assembly port's `createAssemblyPort`, and the direct `runToolLoop` options through the
  shared semantic phase `collectSemanticOptionProblems` in `src/assembly-validators.js`), naming the
  full path `session.resume` and pointing at `config.run.resume` / the flat `resume`. It is never
  silently dropped: the direct route used to accept the key and run without resuming, which is the
  "configured but inert" shape this release removes. `session` is data, but its **only** home is the
  top level (issue #531): the nested spelling `config.metadata.session` is an unknown leaf rejected on
  the spot — see "`session` is a port-class key" below.
  
  **History: `tools` was the last key that did not satisfy that criterion** (issue #498 S4a shipped
  with it on the capability list). The engine never *calls* a member of a tool definition — it
  validates `replay` (an enum literal), reads `name` / `inputSchema`, and forwards the object into the
  request payload. S4b first moved it to `config.input.tools`; **issue #527 then proved that home
  wrong**: a tool entry may carry function members (`handler` / `validate` / `execute` / a function
  inside `inputSchema`), so the data-only `config` subtree cannot hold every legal shape. The ruling
  removed that leaf and made `tools` a **permanent top-level option (the third station)**, the same
  class as `provider` / `executeTool` / `store`. The capability surface **is** purely behaviour
  carriers — the counter-example no longer exists, and `config.input.tools` is now an unknown leaf.
  The same S4b slice moved the deliverables checks the other way (`config.guard.deliverables` →
  `capabilities.checks.deliverables`).
  **`capabilities.provider` is still rejected** — adapter port objects (`provider`, `store`,
  `signal`, `modelConfig`, `executeTool`) stay top-level options or assembly-port members, and
  whether they ever move under `capabilities` is a ruling that has **not** been made. That is no
  longer the same claim as "there is no port container": as of issue #498 S4c the container
  `capabilities.ports` **does exist** — it holds the three *in-shell implementation* slots
  (`sleepImpl`, `judgeProvider`, `strategy`), i.e. the ports the engine dereferences or calls
  itself, not the adapters a host hands in. So "the ports container exists" and "`provider` /
  `store` moved into `capabilities`" are two different claims, and only the first one is true today.
  The wording this paragraph used to carry ("a later ruling, and nothing here promises it") was a
  statement about a **future** decision, not an error: **S4c is that ruling arriving**, and it
  settled the in-shell half only. The `provider` / `store` half is still open, and this document
  still promises nothing about it. See "`capabilities.ports`" below for the members that do exist.

  What *did* land is the other half of the criterion: as of 0.28.0 the `config` subtree holds **data
  only**, so it **does** survive a JSON round-trip unchanged, and that property is asserted mechanically
  in the default suite (one representative data value per schema leaf, then
  `JSON.parse(JSON.stringify(cfg))` compared leaf by leaf). Two guards keep it true: the function
  refusal above, and the fact that a leaf whose value must be a function is simply not on the config
  surface.


  **`runId` / `cwd` are configuration too** (issue #497 review, second round — the "identity /
  environment injection" leg that the first round added to the criterion is **cancelled**), so
  they are `config.run.runId` / `config.run.cwd`; the flat top-level keys are untouched (this is
  an added alias, not a migration). Two reasons:
  1. The criterion is worth only what is **mechanically checkable**: the capability surface is the
     behaviour carriers that get called or dereferenced, the config surface is data that gets
     validated and interpreted. A carve-out opened for two keys degenerates the criterion into
     "classify first, then write the justification" — anyone can pass it.
  2. The stronger, positive reason: the checkable target for 0.28 is "the `config` subtree must
     survive a JSON round-trip unchanged". `runId` / `cwd` are **string scalars, JSON-safe by
     construction**, and the capability surface should be left with functions and port objects
     only. Keeping them on the capability side would force that 0.28 check to open the exception
     in the other direction — a round-trip rule with two string exemptions is no longer a rule.
- **Shape and names** — `config` itself must be an object (`null`, an array and a string all
  throw); an unknown group, an unknown leaf, a flat key written at the top of `config`
  (`config.maxRounds` is answered with "write `config.run.maxRounds`"), a leaf written at the top of
  `config` (`config.messages` is answered with "write `config.input.messages`"), and a leaf written
  in the wrong group (`config.run.temperature` points at `config.tuning.temperature`) all throw
  **before any host port is read**, with the accepted names enumerated from the schema. A group name
  that was **renamed** is answered with its destination rather than a bare "unknown":
  `config.prompt` gets `config.prompt: the "prompt" group is now "input" (write
  config.input.<leaf> instead, e.g. config.input.system)`.

`config` never reaches the engine: expansion removes it, so `effectiveOptions` — and the
`explicitOptions` returned by `normalizeRunToolLoopOptions` (`src/loop/option-normalization.js`) —
contain flat keys only. The assembly port accepts `config` in its `policy` as well, so both entry
routes share this one expansion (and the `via` tag says which route threw).

Transition: new hosts should use `config` alone. The flat top-level keys are the **primitive /
transitional** surface — still accepted, still validated, still documented — but the direction of
travel is one namespace. Their removal window belongs to #495's release ladder and has **not**
happened: this change removes no flat key.

Everything in this section and the next describes the tree on this branch (the 0.28.0 line —
`package.json` is bumped by the release cut, not by a feature change).

**Flat-spelling version policy for the `metadata` group's A8 segment** (issue #498 S3, the ninth
slice — four small keys of `config.metadata`: `modelMetadata`, `requestId`, `toolContext`, `expert`):

| release | writing `modelMetadata` / `requestId` / `toolContext` / `expert` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, ninth slice) | **rejected on the spot** — write `config.metadata.modelMetadata` / `.requestId` / `.toolContext` / `.expert`. The name gate throws `unknown runToolLoop option: "modelMetadata" (its canonical home is config.metadata.modelMetadata; the flat spelling is rejected)` |

Two properties hold, both machine-checked:

* the expansion phase still writes each of them onto `effectiveOptions.modelMetadata` /
  `.requestId` / `.toolContext` / `.expert`, so **the engine's read side is unchanged** — the readers
  are `modelMetadataFor` / `toolContextFor` in `src/loop/budget.js` and the orchestrator
  destructuring that hands the values over, none of which was touched. The leaves stay in
  `CONFIG_NAMESPACE_SCHEMA.metadata` (`src/loop/config-namespace.js`) even though the top-level keys
  left `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`): deleting the flat key is
  **not** deleting the leaf. Retirement is a *write-spelling* change only, exactly like the eight
  slices before it;
* the rejection message names **one station and only one**. Nothing is registered for these four names
  in `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`), so the message carries
  **no** `capabilities.*` hint. Derived, not promised: a behaviour member would make the second
  station appear on its own.

**The narrowing this slice accepts, stated plainly.** These four values are **opaque identity
payloads** — the engine never calls them, it only **forwards** them (into the tool context, the judge
brief and the budget derivation), and the only engine-read fields inside them are the two numbers of
`modelMetadata` (`contextWindowTokens` / `maxOutputTokens`). Moving them into `config.metadata.*`
therefore costs one thing: a **function value is refused** at intake, because the `config` subtree must
survive a JSON round-trip unchanged. The rejection says both halves out loud — *this leaf holds data
only* **and** *the engine never called it, it only forwards the value* — so a host cannot read it as
"a capability was lost":

```text
config.metadata.expert is not accepted: "expert" is a function, and the config namespace holds data
only (the config subtree must survive a JSON round-trip unchanged) — there is no capability home for
it: "expert" is a data key of the config namespace — the engine never calls it, it only forwards the
value — so pass plain data (host callbacks belong under capabilities.hooks.<name>)
```

The asymmetry is pinned **as-is**, not papered over: the flat spelling of the group's *other* members
still accepts a function today and keeps its `typeof` all the way into the tool context, while the
canonical home refuses it. `test/loop-metadata-keys-slice-498s3a8.test.js` (F1 / F2) is that pin;
after the A9 slice below it points at `session`, which is the only member of the group still writable
flat — whoever widens or tightens either side sees it go red.

**Flat-spelling version policy for the `metadata` group's A9 segment** (issue #498 S3, the tenth
slice — the group's *big three*: `user`, `model`, `task`):

| release | writing `user` / `model` / `task` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, tenth slice) | **rejected on the spot** — write `config.metadata.user` / `.model` / `.task`. The name gate throws `unknown runToolLoop option: "task" (its canonical home is config.metadata.task; the flat spelling is rejected)` |

The slice was sized **before** it was written, and that measurement is why it needed no fixture: with
only one key removed from the allowlist the full suite went red in **6 cells for `user`, 5 for `model`,
13 for `task`** (sum 24; all three removed together **15** ⇒ 9 cells overlap — the union of the three
per-key failure sets, a method validated against the measured all-four run: union 29 = measured 29), far below the ~150-cell
threshold that would have required a #521-style translation point in the shared fixture. Nothing was
translated behind the host's back: every write point moved to its canonical home in the same commit.

Two properties hold, both machine-checked (`test/loop-metadata-keys-slice-498s3a9.test.js`):

* the expansion phase still writes each of them onto `effectiveOptions.user` / `.model` / `.task`, so
  **the engine's read side is unchanged** — the readers are `toolContextFor` and `modelMetadataFor` in
  `src/loop/budget.js`, `resolveTaskBrief` in `src/loop/task-brief.js` and the orchestrator
  destructuring that hands the values over. The leaves stay in `CONFIG_NAMESPACE_SCHEMA.metadata`
  even though the top-level keys left `RUN_TOOL_LOOP_OPTION_NAMES`: deleting the flat key is **not**
  deleting the leaf (P2/P3);
* the same narrowing as A8 applies: a **function value is refused** at the canonical home, and the
  message says both halves out loud (data only **and** *the engine never calls it, it only forwards the
  value*). These three values are opaque identity payloads — the engine reads only known fields
  (`model`'s two window numbers) and forwards the rest.

**`session` is a port-class key: two entries, one home (issue #531).** Issue #498 S3 measured it and
*returned* it (19 red cells, so size was not what stopped it); issue #531 then settled the question the
other way round. `session` belongs to the same class as `provider` / `executeTool` / `store` /
`modelConfig`: it is an **assembly-port member**, and the top-level option and the port member are
**two entries of the same value** — `assemblyPortOptions(port).session === port.session` (identity,
not deep equality), and the construction-time conflict message names `port.session` as the source of
the very same key. That double entry is the trap hosts hit most often: `createAssemblyPort({ session })`
and `runToolLoop({ session })` are not two different settings, they are one value seen twice, and the
explicit top-level option wins over the port's member on the direct route.

So the ruling is **two entries, one home**: the home is the **top level** — `session` is a permanent
top-level option, the third station (`TOP_LEVEL_SURFACE_OPTION_NAMES`, 10 → 11), the same bucket as
`provider` / `executeTool` / `store` / `modelConfig` / `tools`. The `config.metadata.session` leaf was
removed, and writing it is now an **unknown leaf rejected on the spot**:

```
unknown config.metadata option: "session" ("session" is a permanent top-level option — the third station — write it at the top level: session: …)
```

| release | writing `config.metadata.session` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | there is no `config` namespace at all, so the question does not arise — `session` is a top-level option, and that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which the leaf existed |
| 0.28.0 and later (issue #531) | **rejected on the spot** — write the top-level `session`. The message above is the closed door; the engine's read side is untouched (`effectiveOptions.session` is still what it always was) |

Three halves are machine-pinned (`test/loop-metadata-keys-slice-498s3a9.test.js` S1–S3): the same
value on both entries (S1), the conflict message naming `port.session` (S2), and the closed door —
top level accepted, `config.metadata.session` rejected with the verbatim message above (S3). The
group is therefore **closed**: `config.metadata` has no flat twin left.

**These three words live on other planes, and this slice moved none of them:**

| name | other plane | evidence | moved? |
| --- | --- | --- | --- |
| `user` | message role `"user"` (round grouping, request user view) | `src/messages/rounds.js`, `src/loop/request-user-view.js`, `test/loop-request-user-invariant.test.js` | **no** (N1) |
| `user` | the fold-context shell `context.user` | `src/loop/budget.js` (`toolContextFor`'s fallback chain), `src/assembly-validators.js` | **no** |
| `user` | provider request body field `user` (`extraBody` / `providerOptions`) | `src/providers/*`, `test/providers/request-injection.test.js` | **no** |
| `model` | the `modelConfig` port (the third station) | `src/assembly.js`, `src/loop/orchestrator.js` | **no** (N3) |
| `model` | the model-slot field `slots.default.model` | `src/config/slot-provider.js`, `bin/cli.js` | **no** |
| `model` | the provider request body field `model` | `src/providers/openai.js`, `src/providers/anthropic.js` | **no** |
| `task` | the fold-context shell `context.task` (explicit task wins over it — as-is) | `src/loop/task-brief.js` (`resolveTaskBrief`), `src/assembly-validators.js` | **no** (N2) |
| `task` | `task-brief.js`'s string read (`typeof === "string"` + `trim()`) | `src/loop/task-brief.js` | **no** — read side |
| `task` | the `erix_run` extension's own `task` parameter (`core.run({ task })`) | `examples/pi-extension/erix-run-core.js` | **no** — a different API plane |
| `session` | the assembly port member `port.session` | `src/assembly.js` (`assemblyPortOptions`) | **no** — the same value, so the top level is its one home (two entries, one home; #531) |
| `session` | the CLI `--session <id>` argument (a session id string, fed to `runId`) | `bin/cli.js` | **no** — a different key entirely |

**Suggestion noise is measured, not assumed.** The candidate pool for "did you mean" is the **live**
allowlist, and `model` sits one edit-distance away from `modelMetadata`. After retirement the exact
spelling gets **no** suggestion at all (distance 8 > threshold 5), so the message is the canonical home
and nothing else — a host that mistypes `modelMetadata` is pointed at `config.metadata.modelMetadata`,
never at `model` (S1). The cost of a smaller pool is stated too: a *misspelling* such as `modelMetada`
now gets neither a suggestion nor a home, just the bare unknown-option sentence (S2, pinned as-is).

**These four words live on other planes, and this slice moved none of them:**

| plane | where it lives | status |
| --- | --- | --- |
| `runToolLoop` top-level option | `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`) | **retired by this slice** (the only one that moved) |
| `config.metadata.*` | `CONFIG_NAMESPACE_SCHEMA.metadata` (`src/loop/config-namespace.js`) | the canonical home — write here |
| assembly `policy.modelMetadata` / `.requestId` / `.toolContext` / `.expert` / `.session` | `src/assembly.js` — port members, not top-level options | **untouched** (#525's plane); they still reach the run. `policy.session` is the *same value* as the top-level `session` option (#531) |
| `context.expert` / `.requestId` / `.toolContext` (the fold-context shell) | `src/loop/budget.js` (`toolContextFor`'s `?? context?.<key>` fallback chain) | **untouched** — the fallback chain still works, and an explicit `config.metadata.*` value still wins over it (P5-b) |
| tool context handed to `executeTool` / the judge brief | the `toolContextFor` helper in `src/loop/budget.js`, handed over by `src/loop/orchestrator.js` | **untouched** — that is the engine's *read* side |
| model-slot window numbers (`slots.default.contextWindowTokens` / `maxOutputTokens`) | `src/config/slot-provider.js` | **untouched** — a config file is not a `runToolLoop` option |

**Flat-spelling version policy for the `run` group's A11 segment** (issue #498 S3, the eleventh
slice — the group's *small four*: `invalidArguments`, `replayPolicy`, `writeToolNames`,
`writeToolPathKeys`):

| release | writing `invalidArguments` / `replayPolicy` / `writeToolNames` / `writeToolPathKeys` |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, eleventh slice) | **rejected on the spot** — write `config.run.invalidArguments` / `.replayPolicy` / `.writeToolNames` / `.writeToolPathKeys`. The name gate throws `unknown runToolLoop option: "invalidArguments" (its canonical home is config.run.invalidArguments; the flat spelling is rejected)` |

The slice was sized **before** it was written, and that measurement is why it needed no fixture: with
only one key removed from the allowlist the full suite went red in **4 cells for `invalidArguments`,
9 for `replayPolicy`, 6 for `writeToolNames`, 5 for `writeToolPathKeys`** (sum 24; all four removed
together **14** ⇒ 10 cells overlap), far below the ~150-cell threshold that would have required a
#521-style translation point in the shared fixture. Every write point moved to its canonical home in
the same commit.

**The reachability check ran before any key was removed**, because two earlier slices (`tools` in
#527, `session` in #531) were stopped by exactly this step: a shape that is *flat-reachable but
nested-unreachable* would have narrowed the surface silently. All eight legal value shapes went
through the real `runToolLoop` entry, flat versus nested, and both sides exited 0 in every case:

| key | legal shape(s) | flat | nested |
| --- | --- | --- | --- |
| `invalidArguments` | `"reject"` / `"execute"` | exit 0 / 0 | exit 0 / 0 |
| `replayPolicy` | `"always-replay"` / `"per-tool-declaration"` | exit 0 / 0 | exit 0 / 0 |
| `writeToolNames` | `["work"]` / `[]` | exit 0 / 0 | exit 0 / 0 |
| `writeToolPathKeys` | `["path", "file_path"]` / `[]` | exit 0 / 0 | exit 0 / 0 |

So all four are **data-shaped keys** (two enum scalars, two string arrays), none is a mixed shell, and
none was returned. The one delta the check did find sits on an **illegal** shape: an array carrying a
function element used to be *silently filtered* flat (the name-set normaliser keeps strings only) and
is now **refused** at the canonical home (the `config` subtree holds data only). That is the same
narrowing the A8 slice pinned for `metadata.*`, and it is pinned as-is rather than papered over —
`test/loop-run-slice-498s3a11.test.js` (F2) is that pin. It is not a lost capability: the engine never
calls those elements, it only reads the string entries.

Two properties hold, both machine-checked (`test/loop-run-slice-498s3a11.test.js`):

* the expansion phase still writes each of them onto `effectiveOptions.invalidArguments` /
  `.replayPolicy` / `.writeToolNames` / `.writeToolPathKeys`, so **the engine's read side is
  unchanged** — the readers are the invalid-arguments verdict and the resume replay branch in
  `src/loop/orchestrator.js`, the name-set normaliser in `src/loop/budget.js` and the write-path key
  picker in `src/reflection/judge.js`, none of which was touched. The leaves stay in
  `CONFIG_NAMESPACE_SCHEMA.run` even though the top-level keys left
  `RUN_TOOL_LOOP_OPTION_NAMES`: deleting the flat key is **not** deleting the leaf (P2/P3);
* the rejection message names **one station and only one**. Nothing is registered for these four names
  in `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`), so the message carries
  **no** `capabilities.*` hint (N1) — derived, not promised.

**These four words live on other planes, and this slice moved none of them:**

| name | other plane | evidence | moved? |
| --- | --- | --- | --- |
| `writeToolNames` / `writeToolPathKeys` | the judge's *read* side: the write-tool set and the path-key priority that produce `filesWritten` | `src/reflection/judge.js` (`rawWritePath` / `rawWritePaths`), `src/loop/termination.js` | **no** — read side (R3/R4, N3) |
| `replayPolicy` | the tool-declaration switch `replay: "safe" \| "unsafe"` on each tool entry (a *different* key, rejected with its own message) | `src/loop/orchestrator.js`, `test/loop-resume.test.js` | **no** |
| `replayPolicy` | the `session.resume` ruling (#531: `session` is a third-station member, `config.metadata.session` is a closed door) | `src/loop/config-namespace.js`, `test/loop-metadata-keys-slice-498s3a9.test.js` | **no** — untouched (N2) |
| `invalidArguments` | the arguments-repair pipeline and the parser verdict text | `src/messages/tool-arguments.js`, `src/text/repair-json.js` | **no** — read side (R1) |
| `maxTokenContinuations` | **not** the retired `maxTokens` (a `tuning` group key, retired by A5); two different knobs | `CONFIG_NAMESPACE_SCHEMA.run` vs `.tuning` | **no** (N4) |

**Flat-spelling version policy for the `run` group's A12 segment** (issue #498 S3, the twelfth
slice — `partialPersistence`, the first of the group's four):

| release | writing `partialPersistence` at the top level |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, twelfth slice) | **rejected on the spot** — write `config.run.partialPersistence`. The name gate throws `unknown runToolLoop option: "partialPersistence" (its canonical home is config.run.partialPersistence; the flat spelling is rejected)` |

**What did *not* move is the meaning.** `partialPersistence` is durability, not retry: it commits the
partial text of a dying attempt so that a resume reuses it instead of regenerating it (see the
streaming / resume sections below — those sentences are unchanged, only the *address* changed). The
leaf stays in `CONFIG_NAMESPACE_SCHEMA.run`, and the reader is still the startup validator
`partialPersistenceConfig` at `src/loop/orchestrator.js` — deleting the flat key is **not** deleting
the leaf.

**This slice needed a translation point, unlike A11.** With only this one key removed from the
allowlist the full suite went red in **16 cells** — above the threshold at which a slice has to keep
the shared fixture honest instead of editing every call site. So `withRunFamily` (the fixture every
resume-shaped test goes through) grew a **single** translation point: a flat `partialPersistence`
passed to it is re-spelled into `config.run.partialPersistence` before the call. That point is
load-bearing and is pinned as such — corrupt it and the whole family goes red, not one cell.

The pin file is `test/loop-run-slice-498s3a12.test.js`. Its P case asserts the rejection **text**
verbatim (one station, and only one), and its R case asserts that a value written at the canonical
home arrives at `effectiveOptions.partialPersistence` byte for byte and still drives the real
`stream` + `partialPersistence` recovery path.

**Flat-spelling version policy for the `run` group's A13 segment** (issue #498 S3, the thirteenth
slice — the three keys A12 deliberately held back: `stallDetection` / `outputHygiene` /
`persistence`):

| release | writing `stallDetection` / `outputHygiene` / `persistence` at the top level |
| --- | --- |
| 0.26.0 and earlier (the last **published** release) | accepted at the top level — that is the only spelling those versions know |
| 0.27.0 | **never published** (`npm view erix-agent dist-tags.latest` → `0.26.0`; `versions` has no `0.27.0`), so no host ever installed a tree in which this mattered |
| 0.28.0 and later (issue #498 S3, thirteenth slice) | **rejected on the spot** — write `config.run.stallDetection` / `config.run.outputHygiene` / `config.run.persistence`. The name gate throws `unknown runToolLoop option: "<key>" (its canonical home is config.run.<key>; the flat spelling is rejected)` |

**Why they left together, and why only now.** A12 measured the four `run`-group data shells leaving
*together* at **176 red cells** — far above the threshold at which a slice must stop hand-editing call
sites. So A12 first landed the single translation point (`withRunFamily` in
`test/helpers/run-direct.js`, the same discipline as #521's seed fixture), which compressed the same
deletion to **31 cells**, and then shipped only `partialPersistence`. The fixture is on `main`, so this
slice spends that dividend instead of re-paying it:

| key | red cells without the fixture | with the fixture | after migrating the hand-written sites |
| --- | --- | --- | --- |
| `stallDetection` | 120 | 32 | 0 |
| `outputHygiene` | 29 | 4 | 0 |
| `persistence` | 38 | 10 | 0 |
| all three together | — | **38** | 0 |

The 38 that remain after the fixture are **hand-written sites**, and they are the whole job of this
slice: direct `runToolLoop` callers, the inline allowlist mirror in `test/loop-option-normalization.test.js`,
the two-shape equivalence sample in `test/loop-config-namespace-497.test.js`, the contract payload demos,
`examples/provenance-repro.test.mjs`, the two observation scripts (`scripts/soak.mjs`,
`scripts/message-journal-golden.mjs` — spelling only, observation logic untouched) and the executable
fence in this document. Three of those test files now route their direct calls through the fixture
(`runDirect`) instead of being hand-translated: extending the fixture's reach costs one word per call
site and keeps the next slice from paying again.

**The reachability check (gate 2) ran per key, two legal shapes each, flat versus nested, through the
real `runToolLoop` entry** — the same step that stopped `tools` (#527) and `session` (#531):

| key | legal shapes | flat | nested |
| --- | --- | --- | --- |
| `stallDetection` | `false` / `{ window: 4 }` | exit 0 / 0 | exit 0 / 0 |
| `outputHygiene` | `false` / `{ limit: 4096 }` | exit 0 / 0 | exit 0 / 0 |
| `persistence` | `"none"` / `"required"` | exit 0 / 0 | exit 0 / 0 |

Both sides are also refused identically on the illegal shape (`persistence: true` → `persistence must
be "none" or "required"` on either side), so the narrowing is a **name** move, not a shape move. All
three are pure data shells: no callback, nothing to promote to `capabilities.hooks`.

**What did not move is the meaning, and nothing on the read side was touched.** The expansion phase
still writes each value onto `effectiveOptions.stallDetection` / `.outputHygiene` / `.persistence`; the
readers are the resolved-stall branch at the top of `src/loop/orchestrator.js` (`false` wins over
`ERIX_STALL_MODE`), the `outputHygieneEnabled` / `outputHygieneLimit` derivation plus the truncation
branch in `src/loop/run-snapshot-executor.js`, and the `persistenceMode` derivation plus
`validateTranscriptStore`'s `required` branch. The leaves stay in `CONFIG_NAMESPACE_SCHEMA.run` even
though the top-level keys left `RUN_TOOL_LOOP_OPTION_NAMES`: deleting the flat key is **not** deleting
the leaf.

**Three neighbours that this slice deliberately did not touch:**

| name | other plane | evidence | moved? |
| --- | --- | --- | --- |
| `store` | the third-station **port** (a `TranscriptStore` implementation), not a mode | `src/assembly-validators.js` (`TRANSCRIPT_STORE_METHODS`), `test/loop-run-slice-498s3a13.test.js` (N2) | **no** |
| `partialPersistence` | the interval-throttled snapshot knob, retired by A12 — a *different* key with its own home `config.run.partialPersistence` | `src/loop/resume-manager.js`, `test/loop-run-slice-498s3a12.test.js` | **no** — not re-spelled back |
| `writeToolNames` / `writeToolPathKeys` | the judge's write-tool set and path-key priority, retired by A11 — a different family that also starts with `write` | `src/reflection/judge.js` | **no** |
| `maxRounds` / `deadlineMs` | the round budget (still a flat option) and the retired run deadline (`config.timing.deadlineMs`) — neither is stall detection | `CONFIG_NAMESPACE_SCHEMA.run` vs `.timing` | **no** |

The pin file is `test/loop-run-slice-498s3a13.test.js`. Its P case asserts each rejection **text**
verbatim (one station, and only one), its G case is the gate-2 matrix above (the `outputHygiene` and
`persistence` rows get the *same* store on both sides, because without one both sides are refused for
a different reason), its R case asserts that a value written at the canonical home arrives at
`effectiveOptions.<key>` byte for byte, and its N cases hold the four neighbours above.

### The `capabilities` namespace (issue #498)

Behaviour carriers are not data, so 0.28.0 gives them their own container. It has **three groups**
(issue #498 S4b added the second one so that `hooks` does not turn into a pocket; issue #498 S4c
added the third one so that a behaviour carrier that used to live in a nested shell slot has a real
destination): `capabilities.hooks` for host callbacks, `capabilities.checks` for deliverables checks,
and `capabilities.ports` for the infrastructure / strategy implementations the engine dereferences.
The **sixteen** host callbacks — `onEvent`, `onObserverError`, `onPersistenceError`, `onRound`,
`onJudge`, `onToolResult`, `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`, `onFoldSummary`,
`finalGuard`, `onReflection`, `onBeforeFold`, `onAfterFold`, `stubFor` — are enumerated in
`CAPABILITY_HOOK_NAMES` (`src/loop/capabilities-namespace.js`), and the group table
`CAPABILITIES_NAMESPACE_SCHEMA` (`src/loop/capabilities-namespace.js`) is its single hand-written
source: the alias map `CAPABILITIES_ALIAS_PATHS` (`src/loop/capabilities-namespace.js`) is derived
from it exactly the way the `config` alias map is, so `capabilities.hooks.onEvent` and the flat
`onEvent` are the same key (alias = schema path, leaf name verbatim the flat option name) — with the
one registered exception described below (nine leaves that never were top-level options).

| namespace | members |
| --- | --- |
| `capabilities.hooks` | 18 members — **16 callbacks** (listed below) **plus the two polymorphic knobs** `protectedMessage` / `recoveryHint` (function form here, data form stays in `config.folding.context`):  `onEvent`, `onObserverError`, `onPersistenceError`, `onRound`, `onJudge`, `onToolResult`, `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`, `onFoldSummary`, `finalGuard`, `onReflection`, `onBeforeFold`, `onAfterFold`, `stubFor` — plus the **function form** of the two polymorphic knobs, `protectedMessage` and `recoveryHint` |
| `capabilities.checks` | `deliverables` (each entry `{ name, check }`; `check` is a function, `name` is a label) |
| `capabilities.ports` | `sleepImpl`, `judgeProvider`, `strategy` — see “`capabilities.ports`” below |

Six rules, deliberately symmetric with `config` (two containers, one set of rules):

- **Precedence** — when a callback is given both ways, `capabilities.hooks.*` wins over the flat key
  (and over the nested shell slot, for the leaves that have one); the older spelling keeps being
  accepted and behaves exactly as before when it is the only one. A leaf set to `undefined` is
  verbatim "not subscribed", so it neither overrides a flat hook nor counts as a conflict.
- **Conflicts are not silent** — different values under both spellings emit one
  `config_override_conflict` event before the first round, with `conflicts: [{ path, key }]` where
  `path` names the **destination** of the leaf: `hooks.<name>` for a callback that also has a flat
  key (`{ path: "hooks.onEvent", key: "onEvent" }`), `ports.<slot>` for a port slot
  (`{ path: "ports.sleepImpl", key: "sleepImpl" }`), and — for the two polymorphic knobs — the
  **config-side** path of the same knob (`{ path: "folding.context.protectedMessage", key:
  "protectedMessage" }`), because there the two sides are "data in the config namespace" versus
  "function in the capability namespace" and the host has to know which side to change. Same event,
  same fields, no new event type: the payload says "this knob has two sources of truth" and the path
  says where the destination is. An observer that throws on it is isolated like every other observer
  channel.
  **The same event covers the second pair of sources**: the assembly port's `policy.capabilities`
  and the call-level `capabilities` are two sources of the *same* container, and the call-level one
  wins as a **whole tree** (the same "last writer wins" rule `config` uses); every leaf both sources
  set to **different** values is reported leaf by leaf, deduplicated by path. Equal values, or a
  leaf only one side sets, are not conflicts. **"Equal" is exactly `isDeepStrictEqual`**
  (`src/loop/capabilities-namespace.js`) — that is the predicate the engine runs, stated here so
  hosts do not have to guess: under `hooks` a value compares **by reference** (the same function
  object is equal, two separately written arrow functions never are, even with identical bodies),
  under `checks` the `{ name, check }` array compares **element by element** (so passing the same
  `check` reference under both spellings is *not* a conflict, while a freshly written `check`
  function is), and a port slot compares deeply (the same strategy object is equal, an identically
  shaped second object is not). There is no looser "looks the same" rule.
- **Unknown sub-keys throw, with the full path** — `capabilities: { hoks: … }` answers
  `unknown capabilities namespace: "hoks" (accepted: hooks, checks, ports; port objects such as
  provider / store / signal stay top-level options or assembly-port members, not capabilities
  members)`, `capabilities: { check: … }` (one `s` short) answers the same enumeration with `checks`
  in the accepted list, `capabilities.hooks.onEtent` answers `unknown capabilities.hooks option:
  "onEtent" (accepted: …)`, and `capabilities.ports.sleeplmp` answers `unknown capabilities.ports
  option: "sleeplmp" (accepted: sleepImpl, judgeProvider, strategy)`. A leaf written one level too
  high (`capabilities.onEvent`, `capabilities.deliverables`, `capabilities.sleepImpl`) is answered
  with "<group> live under capabilities.<group>". Nothing is silently ignored — that is the class of
  quiet configuration this container must not reintroduce.
- **Values must have the group's shape** — under `hooks`, `undefined` means "not subscribed" and any
  other non-function value (`null`, a string, an object) throws at startup, naming
  `capabilities.hooks.<name>`; the flat top-level `onRound: "x"` tolerance is the published 0.26
  surface and is unchanged. That rule is **not relaxed** for the two polymorphic knobs: their
  function form is a function or nothing, exactly like every other hook. Under `checks`, the value
  must be a `{ name, check }[]` and the shape rules are **not restated here**: the validator calls
  `normalizeDeliverables` (`src/loop/deliverables.js`), the same single source the flat option uses,
  so `capabilities.checks.deliverables` and the flat `deliverables` cannot drift apart. An empty
  array is verbatim "not declared".
  **An empty group is verbatim "nothing configured"** — `capabilities: { hooks: {} }`,
  `capabilities: { checks: {} }` and `capabilities: { ports: {} }` validate, expand to no keys at
  all, emit no `config_override_conflict`, and shadow nothing: same behaviour for all three groups,
  because an empty object is read as "absent", not as "present but empty". (`checks: { deliverables:
  [] }` is the same story one level down: an empty array is "not declared".)
- **Nine leaves have no flat alias** (issue #498 S4c) — `ports.sleepImpl`, `ports.judgeProvider`,
  `ports.strategy`, `hooks.onReflection`, `hooks.onBeforeFold`, `hooks.onAfterFold`, `hooks.stubFor`,
  `hooks.protectedMessage` and `hooks.recoveryHint` **never were top-level options**, so 0.28.0
  invents a container member slot for them instead of a new flat key. Their destinations are
  registered in `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`) and expansion
  hands them to the engine on a side channel rather than writing new flat keys — which is why the
  top-level allowlist was **67** entries at that slice and the identity was three-way then
  (43 config + 22 capability + 2 containers). Issue #527 later added the permanent top-level
  surface (the third station), so today the accounting is four-way and every number is derived
  rather than copied; this sentence records the state of that slice, not the current one. Their legacy homes are the nested shell slots listed under
  “`capabilities.ports`” and in the `hooks` row above (`reflection.onReflection`,
  `context.onBeforeFold`, …); those keep working.
- **Port objects are still not collected** — `provider`, `store`, `signal`, `modelConfig`,
  `executeTool` and the state providers stay where they are (top-level options or the assembly port);
  writing one under `capabilities` (`capabilities.provider`) still throws with a message that says
  so. `capabilities.ports` is **not** their new home: it holds the three slots above, which are
  *implementations the engine dereferences*, not adapters. `tools` is **not** a port either: issue
  #527 made it a **permanent top-level option (the third station)**, so it lives only at the top
  level; `config.input.tools` was removed and is now rejected as an unknown leaf.
  **History**: before issue #498 S4c this section said "`capabilities.ports` does not exist in this
  release" — that was true of S4a/S4b and is kept here as the record of how the ruling changed, not
  as the current state.

`capabilities` never reaches the engine either: expansion removes it, so `effectiveOptions` — and
the `explicitOptions` returned by `normalizeRunToolLoopOptions` (`src/loop/option-normalization.js`)
— carry flat keys only (the nine leaves above travel on the `capabilitySlots` side channel instead of
becoming flat keys). The assembly port accepts `capabilities` in its `policy` as well, so both
entry routes share this one expansion, and the `via` tag says which route threw.

#### `capabilities.ports` (issue #498 S4c)

A port slot holds an **implementation the engine dereferences or calls**, not data and not a host
callback: the engine either invokes the value itself (`sleepImpl`, `judgeProvider` when it is a
function) or dereferences a method on it and invokes that (`judgeProvider.chat`, `strategy.compact`).
That is the difference from `hooks`, and it is the reason the value shapes differ: **a port may be an
object, a hook must be callable.**

| slot | value shape | legacy nested home (still accepted) | what the engine does with it |
| --- | --- | --- | --- |
| `capabilities.ports.sleepImpl` | a function `(ms, signal) => Promise<void>` | `config.timing.retry.sleepImpl` (and, before issue #498 S3, the flat `retry.sleepImpl`) | replaces the retry timer: every backoff delay goes through it, so a host can record the delays without paying wall-clock time |
| `capabilities.ports.judgeProvider` | a callable `(request) => Promise<response>` **or** an object with a `chat(request)` method | `reflection.judge.provider` / `config.run.reflection.judge.provider` | the judge's evaluator. It feeds the round judge, the wrap-up LLM normalizer and the reported `judgeModel` — the same three places the nested slot fed. Without it the run's main provider is used |
| `capabilities.ports.strategy` | a compaction strategy **object** with `shouldCompact(messages, budgetTokens)` and `compact(messages, options)` | `context.strategy` (object form) / `config.folding.context.strategy` | passed through verbatim (`resolveCompactionStrategy` (`src/compact/strategy-resolution.js`) returns an object unchanged), so the methods called are the host's own. A built-in **name** is data, not a port: pass `"sliding-window"` / `"fold-statistical"` / `"fold-llm"` as `context.strategy` / `config.folding.context.strategy`, and the port rejects a string with a message that says so |

Three consequences worth knowing:

1. **They are not new top-level options.** `runToolLoop({ sleepImpl })` is still an unknown option
   (the allowlist is unchanged); the canonical spelling is `capabilities.ports.sleepImpl`.
2. **Both spellings at once is a conflict, not a silent win.** Giving `capabilities.ports.sleepImpl`
   and `retry.sleepImpl` *different* functions emits one `config_override_conflict` with
   `{ path: "ports.sleepImpl", key: "sleepImpl" }`; the port wins. **Since issue #498 S3 that shape
   can no longer be built by a host** (`retry` moved to `config.timing.retry`, and a function value
   cannot live in `config`), so the port is now the single entry point; the expansion-layer rule is
   kept and still asserted directly, because it is what makes the port authoritative. The same holds for
   `judgeProvider` versus `reflection.judge.provider` and for `strategy` versus `context.strategy`
   (a deeply equal value is not a conflict).
3. **`reflection.judge.evaluator` is retired** (issue #498 S4c). It was a pure alias of
   `reflection.judge.provider` — the same `??` slot written twice — and 0.28.0 retires it rather
   than moving it: writing it now throws on **both** entry routes (`reflection.judge.evaluator is not
   accepted: it was an alias of reflection.judge.provider (pass reflection.judge.provider, or the
   canonical capabilities.ports.judgeProvider)`). `reflection.judge.provider` keeps working.

### Tool arguments that cannot be parsed (issue #409)

Every tool call carries an arguments payload the model wrote. The engine parses it in two
layers and never invents a value. L0 is a plain `JSON.parse` of the original text. If that
fails, L1 runs the deterministic rule table in `REPAIR_RULES`（`src/text/repair-json.js`）:
code-fence stripping, single-quoted strings and bare keys, invalid escapes made legal by
**doubling the backslash** (`\.` → `\\.`), the Python literals `True`/`False`/`None`, and
trailing commas. Truncation completion exists in that table but is **off by default**: it is
the only rule that completes structure the model never wrote, and the measured corpus (110
transcripts / 312 real final answers) contained zero truncated-argument cases, so it is off
for lack of demand rather than for risk.

One invariant makes that layer safe to default on: **every string value a repair produces
must still be a verbatim slice of the original text.** A rule that changes a value's bytes is
disqualified by machine, not by taste. The rejected alternative is what `jsonrepair` does with
an invalid escape: `{"api":"http\.request"}` becomes the value `http.request`, which no longer
appears in the original text and would be silently dropped by any verbatim gate. Doubling keeps
the value byte-identical to the source and still makes the text parseable.

`parseJsonWithRepair`（`src/text/repair-json.js`）is the L0-then-L1 entry the tool path uses, and
`parseToolArguments`（`src/messages/tool-arguments.js`）is what the OpenAI non-streaming
conversion, the OpenAI stream accumulator, and the Anthropic stream assembler all call, so the
two protocols cannot drift apart here. The strict entry point is untouched: `parseModelJson`
still repairs nothing (see its own section) — repair exists only on the tool-argument path.

When the arguments still do not parse, the default (`invalidArguments: "reject"`, a member of
`RUN_TOOL_LOOP_OPTION_NAMES`（`src/loop/option-normalization.js`）) is to **not execute the tool at
all**. The engine
returns an `is_error` `tool_result` whose content is the parser's own verdict, assembled by
`describeToolArgumentsParseError`（`src/messages/tool-arguments.js`）: the parser's words, the
1-based character position with a snippet around it, and a correct-shape example rendered from
that tool's own `inputSchema`. The instruction that follows tells the model to re-send the same
call with fixed arguments, not to switch tools and not to guess content. That result carries
`erix.executionStatus: "rejected"`; because the call never ran it carries no `erix.round`, no
`erix.durationMs` and no `erix.success` (the same existence rule as a judge interception). The
`tool_use` block additionally carries `erix.argumentsParseError`
(`{reason, message, position?, text}`, an additive optional key that is never on the wire), so a
host can tell "the model wrote broken JSON" apart from "the tool itself failed" without parsing
`content`. No retry and no second LLM call is spent on it: the model gets the verdict on its next
turn and fixes the arguments itself.

`invalidArguments: "execute"` restores the pre-#409 behaviour byte for byte: the malformed payload
reaches `executeTool` as `{_truncatedArguments, _raw}`, the tool runs anyway, and the model sees
whatever second-order error that tool reports (typically "missing required field") instead of the
parse verdict. Both halves — the fake object handed to the executor and the second-order error
that comes back — are pinned by `deepEqual` tests.

## Observer callback errors (issue #173)

Nine host callbacks observe a run: the eight event channels `onEvent`, `onRound`,
`onToolResult`, `onJudge`, `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage`,
plus the error account itself (`onObserverError`). **A throw in any of them is
reported and the run continues** — one uniform consequence. Before this change the
same fault had three different outcomes: a throwing `onEvent`, `onRound`, or
`onToolResult` killed the run with `termination.reason: "failed"`, the streaming
channels were reported through `onObserverError`, and `onJudge` disappeared into a
bare `catch {}`.

```text
observer throws synchronously, or returns a rejected promise (onRound / onToolResult)
  └─ reportObserverError(error, { channel, … })   src/loop/orchestrator.js:892-899
       ├─ onObserverError(error, context)         the host account, called synchronously
       └─ console.error("Observer callback error:", error, context)
                                                  when no account is configured, or it threw
```

1. **The run keeps going.** No observer error can change `termination.reason`, the
   returned result, or what was persisted. When `onRound` throws the round has
   already been appended and the later rounds still run; when `onToolResult` throws
   the tool result still reaches the model; after a throwing `onEvent` the engine
   keeps emitting events (the stream no longer truncates at the first host failure).
   The paths that can still end a run are the engine's own: see
   "Termination decision table (issue #170)".
2. **Every report names its channel.** `onObserverError(error, context)` receives a
   plain object that always carries `channel` — the callback name, or `"unknown"` if
   the engine ever reports without one — and always carries `runId` when the host
   supplied the `runId` option, so a host running runs in parallel can attribute the
   failure. The extra fields below are the complete set per channel and are additive;
   a host must not require anything more:

| `context.channel` | Extra fields | Engine guard |
|---|---|---|
| `onEvent` | `type`, plus `round` when the event carries one | `emitEvent` (`src/loop/orchestrator.js`) |
| `onEvent` (startup diagnostics) | `type: "model_metadata_missing"`, or `type: "persistence_capability_degraded"` plus `method` | the local guards in `notifyCapabilitySkipped` / `notifyModelMetadataMissing` (`src/loop/orchestrator.js`), which call `onEvent` directly because they fire before `emitEvent` exists |
| `onRound` | `round` | `src/loop/orchestrator.js` |
| `onToolResult` | `toolName`, `round` | `src/loop/run-snapshot-executor.js:266-294` |
| `onJudge` | `round`, `kind` | `emitJudge` (`src/loop/orchestrator.js`) |
| `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage` | `round`, `type` (the streamed event type) | `dispatchAttemptEvent` (`src/loop/provider-runner.js`) |

   The startup diagnostics keep their exactly-once-per-run guarantee even when the
   host throws: the dedup marker is set before the callback runs.
3. **Observer errors are best-effort and are accounted nowhere else.** They never
   enter `result.unpersisted`, they produce no `delivery_failure` entry, and they are
   not written into the run state. A host that needs the count keeps it from
   `onObserverError` itself; a durable, persisted observer-error account is a
   separate decision (issue #173 boundary accepted as-is).
4. **The account itself must not throw.** If `onObserverError` throws, the engine
   logs `Observer error reporter failed:` and then falls through to
   `console.error("Observer callback error:", error, context)`. The run is unaffected
   either way. Without a configured account the console line is the only signal, so a
   production host must configure one and count it.
5. **Throwing is not how a host stops a run.** Use `signal.abort()`: the loop then
   throws the standard `aborted` shape with the issue #180 payload
   (`error.usage` / `error.rounds` / `error.finalText`). A host that previously let a
   throwing sink abort the run must migrate to the abort signal — the throw now only
   reports.
6. **Callbacks return synchronously.** Only `onRound` and `onToolResult` are awaited,
   so only those two channels isolate a rejected promise as well as a synchronous
   throw. On `onEvent`, `onJudge`, and the four streaming channels the engine catches
   synchronous throws only: an `async` callback whose promise rejects later escapes as
   an unhandled rejection in the host. Keep callbacks synchronous, or guard the async
   work inside the callback.
7. **`onToolResult` is a rewrite hook, not a pure observer.** Its return value
   replaces the tool result (returning `undefined` keeps the engine result), so a
   failure there has a data consequence: the fallback is the **original execution
   result, unchanged** — never a partial rewrite, never an empty result — plus a
   `channel: "onToolResult"` report carrying `toolName` and `round`. Hosts that
   redact, truncate, or re-shape tool output inside this hook must defend that logic
   themselves: a throwing redactor silently hands the un-redacted engine result to
   the model.

Nothing else is in this channel. `executeTool` errors become tool results,
`onPersistenceError` and `diagnostics.error` report through the persistence ledger and
`delivery_failure` (see "Persistence failure reporting"), `finalGuard` surfaces as
`verification.status: "error"`, `reflection.onReflection` and the compaction hooks
`onBeforeFold` / `onAfterFold` still let an uncaught throw reach `fail()`, and
`todoStateProvider` / `semanticStateProvider` surface as `status: "error"` run-state
sections. Do not extrapolate observer isolation to those callbacks.

## Provider request injection (issue #181)

`createOpenAIProvider` and `createAnthropicProvider` accept two additional, fully
optional option keys, so a host can tag outgoing requests with its own
attribution identifiers (per-run / per-session) without wrapping `fetchImpl`:

```js
const provider = createOpenAIProvider({
  endpoint, apiKey, model,
  defaultHeaders: { "X-Station-Run-Id": runId, "X-Station-Session-Id": sessionId },
  extraBody: { user: `${fde}:${sessionId}` },
});
await provider.chat({ messages });
```

- `defaultHeaders` is **appended** to the engine-owned request headers, which keep
  their existing values and ordering. Engine headers are immutable: a host key
  that collides — case-insensitively — with OpenAI's `Authorization` /
  `Content-Type` or Anthropic's `x-api-key` / `anthropic-version` / `content-type`
  throws `TypeError` at construction rather than being silently ignored.
  `undefined` / `null` values are skipped (conditional injection); any other value
  must be a string, number, or boolean without CR, LF, or NUL.
- **Header values never enter error text or log output.** Every message added by
  this surface names the header only, never its value — the same masking policy as
  `apiKey`, because hosts put gateway keys in headers.
- `extraBody` is merged into the JSON request body **after** engine assembly, so an
  engine-owned field always wins and a host cannot quietly redefine `stream` or
  `model`. Reserved keys are `model`, `messages`, `system`, `tools`, `max_tokens`,
  `temperature`, `top_p`, `stream`, `stream_options`, `frequency_penalty`,
  `presence_penalty`, `response_format`; a host-supplied reserved key is dropped,
  and so is any key the engine already wrote for that specific request (for
  example one arriving through `providerOptions`).
- Each dropped field is reported on stderr with `console.warn`, carrying the field
  name only (never the value), once per provider instance per field: reserved-key
  conflicts at construction, per-request conflicts at first occurrence.
- Both injection points take a **top-level** snapshot at construction; mutating the
  host object afterwards does not change what goes on the wire, but **nested objects
  inside `extraBody` stay shared by reference** — deep-freeze or deep-copy any value
  that must be stable. Hosts construct a provider per
  run already, which is the intended granularity.
- With neither option supplied, outgoing headers and bodies are byte-identical to
  previous releases. `providerOptions` stays the payload escape hatch and keeps
  dropping core keys **silently**; `extraBody` is the channel that warns.

Budget metadata is a separate contract: which fields a model slot may carry, in
which order it is probed, and when the loop emits the one-shot
`model_metadata_missing` diagnostic event are all specified in "Model metadata
and budget derivation (issue #182)" below (issue #182).

## HTTP error classification (issue #179)

A non-2xx provider response becomes a `KitError` built by `classifyHttpError`
(`src/providers/errors.js:105-129`), which the package root re-exports
(`src/index.js:2`). Its `code` is host-visible, and it reaches a host a second
time as `termination.errorCode` (issue #176, see "Termination payload" below).
The mapping:

| HTTP status | `KitError.code` | `retryable` |
|---|---|---|
| 408 | `timeout` | `true` |
| 429 | `rate_limited` | `true` |
| 401 / 403 | `auth` | `false` |
| 500-599 | `server` | `true` |
| 400 / 422 | `invalid_request` | `false` |
| 404 | `not_found` | `false` |
| 409 | `conflict` | `false` |
| any other status, or no status | `unknown` | `false` |

Two facts are the whole contract here:

- **Only the `code` string widened.** `invalid_request`, `not_found`, and
  `conflict` are new values (issue #179: value-surface extension = semver minor);
  before them 400 / 404 / 409 / 422 all reported `unknown`. `retryable` moved for
  no status — all four were, and remain, non-retryable — `KitError` gained no
  field and lost none, and every pre-existing row above is untouched, so the
  retry path still repeats exactly the `retryable === true` set (see
  "Retry budget (issue #183)").
- **`"unknown"` is not a dead value.** It stays the fallback for every status the
  table does not name — 402, 405, 410, 413, 415, 418, 499, 600, or a missing
  status — so a host's `unknown` branch still exists; it just no longer catches
  those four statuses. A host that branched on `code === "unknown"` (or on
  `termination.errorCode === "unknown"`) to mean "bad request / wrong model name"
  must widen that branch to the three new codes; a `default` branch that treats
  anything unclassified as `unknown` needs no change.

The 500-599 row is a numeric range comparison, so a non-numeric `status` that
coerces into that range (e.g. the string `"500"`) still lands on `server`;
every other row matches by strict equality. The transport fact itself is
separate from the classification: `error.status` keeps the raw number and is
what a host should read when it wants the number rather than the class.

## Retry budget (issue #183)

> **Spelling note (issue #498 S3).** Every `retry: …` below is the **value**, not the top-level
> spelling. Since 0.28.0 the knob is written `config.timing.retry` — the flat `retry` is rejected on
> the spot by the name gate (0.26.0 and earlier accepted it; 0.27.0 was never published). The rows
> below are unchanged on purpose: the derived values, the clamping, the two independent loops and the
> observation points are all exactly what the engine computes from `effectiveOptions.retry`, which is
> where the expansion phase puts `config.timing.retry`.

**Not configured means not retried.** `retry` defaults to `false`
(`resolvedModelConfig` at `src/loop/orchestrator.js`), and in that state the engine issues exactly
one provider attempt per round and one write per store call. A host that wants
retrying has to ask for it, and a host that does not ask must not assume a
provider call is ever repeated. This section is the whole rule set; the
termination side of it is the `failed` row of "Termination decision table
(issue #170)".

### Derived values

Only an **object** turns retrying on: `retryOptions = retry && typeof retry ===
"object" ? retry : null` (`runStateAvailability` at `src/loop/orchestrator.js`), so `retry: true` is
*not* "enable retrying" — it is identical to leaving the option out.

| input | effective value | derivation |
|---|---|---|
| `retry` omitted / `false` / `true` | `retryAttempts = 0`, no retry path at all | `:713-715` |
| `retry: {}` | `retryAttempts = 2` → 3 provider calls per round at most | `Number.isInteger(attempts) ? Math.max(0, attempts) : 2` (`:714-718`) |
| `retry: { attempts: n }` | `Math.max(0, n)` for an **integer** `n` | `:716-717` |
| `retry: { attempts: 2.5 }` / `{ attempts: "2" }` | silently `2` — the non-integer value is discarded, never validated | `:716`, fallback `:718` |
| `retry: { attempts: -1 }` | `0` (clamped, not rejected) | `:717` |
| `retry.backoffBaseMs` | `1500` when absent or non-finite; negatives clamp to `0` | `:719-721` |
| `retry.backoffMaxMs` | `10000` when absent or non-finite; negatives clamp to `0` | `:722-724` |
| `retry.sleepImpl` | `defaultSleep` (`src/loop/abort.js:16`); a host value is called as `sleepImpl(delay, signal)` | `:725`, `:885`, `:1636-1641` |

The wait before retry *n* (0-based) is `Math.min(backoffBaseMs * 2 ** n,
backoffMaxMs)` in both loops (`src/loop/provider-runner.js:246-249`,
`src/loop/orchestrator.js`). Sleeping is abort-aware: the run's signal
is passed to `sleepImpl` and raced by `waitForRetry`
(`forcedFinal` at `src/loop/orchestrator.js`), so `signal.abort()` during a backoff
wait throws the standard `aborted` shape with the issue #180 payload.

Only errors marked `retryable === true` are retried
(`src/loop/provider-runner.js:219`). That set is `KitError.code` ∈
`timeout`, `rate_limited`, `server`, `disconnect`
(`src/providers/errors.js:1,14-16`), HTTP 408/429/5xx through
`classifyHttpError` (`:105-129`), retryable transport failures through
`classifyFetchException` (`:166-198`, decided by
`isRetryableNetworkException` `:148-157`), and an assistant message that carries no
text, tool call, or reasoning (`src/messages/canonical.js:448-454`).
Everything else — `auth`, `aborted`, the 4xx classes `invalid_request`,
`not_found`, and `conflict` (issue #179), a `TypeError` from option validation, a
host store bug — is rethrown on first sight.

### One option, two independent loops

The same three numbers feed two loops with **separate counters**. They do not
multiply, and a host must not model them as one global attempt budget:

| loop | coordinate | gate | budget |
|---|---|---|---|
| per-round provider call | `src/loop/provider-runner.js:33-263` (`callProvider`) | `retryOptions !== null` **and** `error.retryable === true` (`:219`) | `retryAttempts + 1` provider calls **per round**; a run therefore tops out at `maxRounds × (retryAttempts + 1)` |
| persistence store write | `src/loop/orchestrator.js:875-891` | the same numbers, no `retryable` gate | `retryAttempts + 1` writes **per store call**, independent of the provider loop |

A persistence retry never re-issues a provider call, and a provider retry never
re-writes a record. `retry: { attempts: 0 }` and `retry: false` are
observationally equal: one provider call, one store write, no `recovering`
event, and `maxAttempts: 1` on the `attempt` event.

### What this budget does not cover

Do not extrapolate it to the rest of the engine:

- **Tools are never retried.** A failed `executeTool` becomes a `tool_result`
  with `is_error`; re-running is the host's call (see "Tool replay policy
  (issue #139)", which is about resume, not retry).
- **Out-of-round completions get one attempt each**: the wrap-up call
  (`src/loop/termination.js:234`), the wrap-up/`judge` text normalizer
  (`normalizeWrapupWithLlm` at `src/reflection/wrapup.js`), and the `fold-llm` default summarizer
  (`finalPersistence` at `src/loop/orchestrator.js`). None of them consumes this budget.
- **The run itself is never retried.** Whole-run rerun/requeue policy belongs to
  the host (ADR-012), and `maxTokenContinuations` (default `3`) and
  `finalGuardMaxRetries` are separate budgets: the first continues a response
  truncated by `max_tokens`, the second re-asks the final-answer guard. Neither
  is an error-retry budget, and neither is affected by `retry`.

### Streaming: same budget, one behaviour change to know about

There is **no second stream-retry counter**. For a `stream: true` run the loop
above *is* the stream recovery: `recovering` /
`recovered` are its event surface, and a failed attempt is rolled back to the
pre-attempt snapshot before re-requesting the whole completion
(`src/loop/provider-runner.js:224-243`).

- `DEFAULT_STREAM_RECOVERY_MAX_ATTEMPTS` is **not an identifier in this
  package** (grep-verified). A `2` quoted as its value is the `retryAttempts`
  fallback at `src/loop/orchestrator.js`. The CLI's own `2` comes from
  `ERIX_RETRY_ATTEMPTS` (`bin/cli.js`), which the CLI passes as
  `retry: { attempts: … }`; the **library** default stays `false`, so copying
  CLI behaviour into a host is how this number gets misattributed.
- `partialPersistence` is durability, not retry: it commits the partial text of
  a dying attempt (`onPartialAttemptEnd({ retrying: true })`,
  `roundEventDeltas` at `src/loop/orchestrator.js`) and adds no attempt of its own.
- **Side effect worth asserting in your own tests:** with `retryAttempts > 0`
  the streamed observer callbacks are buffered per attempt and dispatched only
  once that attempt succeeds
  (`src/loop/provider-runner.js:111-117`, flush at `:192-194`), so
  `onDelta`/`onReasoningDelta`/`onToolCall`/`onUsage` arrive in one burst at
  attempt end instead of incrementally. With `retry: false` (or
  `attempts: 0`) they dispatch as they arrive
  (`src/loop/provider-runner.js:112-115`). Enabling retry therefore changes
  your rendering cadence; that is upstream behaviour, not a host bug.

### Host-assertable observation points

| want to pin down | channel you can assert on |
|---|---|
| provider attempts per round | the `attempt` event `{ type, round, attempt, maxAttempts }` (`src/loop/provider-runner.js:86-91`); `maxAttempts === retryAttempts + 1`, so a host can assert the cap without knowing the option value |
| a retry actually happened | the `recovering` event (`src/loop/provider-runner.js:252-258`); `recovered` marks the attempt that succeeded after one (`:188-191`, `:203-206`) |
| the backoff schedule, without wall-clock cost | inject `retry.sleepImpl` and record every `delay` — the count is the number of retries taken, and the recorded values pin the `min(base × 2ⁿ, max)` formula |
| no N×M provider amplification | your provider wrapper's own request counter, asserted against the `attempt` events and against `maxRounds × (retryAttempts + 1)` |
| store-write retries | **no per-attempt event exists.** The only signal is the terminal `persistence_error` report after the loop is exhausted (`reportObserverError` at `src/loop/orchestrator.js`); wrap your own store methods to count attempts, which is currently the only way to prove the store-side loop ran at all |

Leftover (issue #183): the run result carries no aggregate attempt/retry
counter, so a per-run total has to be assembled from events by the host. A
durable retry counter is **not** promised today; treat `attempt` / `recovering`
/ `recovered` and `retry.sleepImpl` as the only supported observation points.

### Silence is a retryable deadline — but only if someone wires it (issue #441)

The engine ships its own **silence deadlines**: `firstByteTimeoutMs`,
`streamIdleTimeoutMs`, `streamTotalTimeoutMs` and `requestTimeoutMs`. When one of
them expires it throws `KitError("timeout", …, { retryable: true })`
(`src/providers/timeout.js`), and `timeout` is in `RETRYABLE_CODES`
(`src/providers/errors.js`) — so a silent provider is supposed to land on the
retry loop above, not on a hard kill. Until 0.24.0 **no CLI code passed any of
them** (`grep -rn 'firstByteTimeoutMs' bin/` had zero hits, and the CLI config
whitelist did not carry them either), which left the CLI's idle watchdog as the
only thing that could end a silent run — and that path aborts the run's
`AbortSignal`, which is **not** retryable. That is the structural failure this
section records the fix for.

The CLI now derives **two of them** from `--idle-timeout` in one place (the
resolver lives in `bin/provider-timeouts.js`; `bin/cli.js` and `bin/repl.js` use
it identically):

| `--idle-timeout` | what reaches the provider |
|---|---|
| `0` (`erix repl` default) | **nothing derived** — the pre-0.24.0 assembly, byte for byte: the legacy `timeoutMs` deadline only. Explicit phase keys in the config file still pass through (the engine then uses its phase model) |
| `N > 0` (`erix chat` default `300`) | `firstByteTimeoutMs` = `streamIdleTimeoutMs` = `⌊N × 3/4⌋` ms, unless the user configured that key explicitly. `requestTimeoutMs` is **not** derived: the non-streaming deadline stays legacy (`config.timeout ?? 300_000`) |

Four rules, in order:

1. **The silence budget is strictly smaller than the idle window.** Equality is a
   defect, not a preference: for a silent request both timers start at the same
   moment and the idle one starts *earlier* (it is armed before the provider
   call), so `deadline === idle` always resolves to the non-retryable abort. The
   remaining quarter is the room a retry needs — the backoff
   (`backoffBaseMs = 1500`, then `3000`) plus the next attempt.
2. **`requestTimeoutMs` is deliberately not derived** — the non-streaming path
   keeps its legacy deadline (`config.timeout ?? 300_000`). On that path
   `requestTimeoutMs` measures the **whole generation**, not a silence
   (`provider.chat()` has exactly one absolute deadline), so deriving it to
   `⌊idle × 3/4⌋` turns the default `[⌊idle × 3/4⌋, idle)` = `[225s, 300s)` band
   from *alive* into *always fatal*: measured against a real HTTP upstream with
   `ERIX_RETRY_ATTEMPTS=2`, a request answered after **240s** ended `end_turn`
   (exit **4**) in **240.29s** before the wiring and was killed at **225.21s**
   with `failed` / `errorCode: "timeout"` after it. Retrying non-streaming
   *silence* would need a deadline **strictly below** the idle window, and both
   idle and the legacy `timeout` default to `300` — so any shrink kills that
   band. The fix for non-streaming silence is "retry after declaring death"
   (issue #433 fix 1, see the next section), not an earlier kill: the CLI now
   resumes the run from its transcript after the watchdog fires, and only the
   exhausted budget ends it as `idle_timeout` (one call per attempt, no engine
   retry on that path).
3. **`streamTotalTimeoutMs` is not derived.** It is an absolute cap on one
   stream, not a silence deadline, and while a stream is flowing the idle
   watchdog is fed by `onDelta` and cannot fire anyway — deriving it from the
   idle window would turn a long-but-healthy output into a retry that fails the
   same way. The engine default (`300000`) stays. An explicit legacy `timeout`
   **is** passed through as `streamTotalTimeoutMs`, because entering the phase
   model disables the legacy absolute deadline (`hasExplicitPhase` in
   `src/providers/payload.js`) and dropping it would silently lower a ceiling the
   user asked for.
4. **Explicit phase configuration wins and is never rewritten**: a phase value
   ≥ the idle window is used verbatim and only produces a one-line warning — the silence may then still be ended by the
   non-retryable idle path. The four keys are also **validated at load**: a value
   that is not a safe integer `>= 0` (`-1000`, `"abc"`, `true`, `1.5`) is a
   config error that names the key, instead of reaching the engine as
   `undefined` — where it used to mean "this phase deadline silently does not
   exist" (stream) or "the request expires immediately, zero calls reach the
   upstream" (non-streaming). `0` is legal and means "already expired". The legacy `timeout` / `timeoutMs` key is **not** covered by
   this validation — it is still forwarded verbatim, so a non-numeric value reaches `setTimeout` and
   behaves as "already expired"; only the four phase keys are load-validated, because they are the four
   this change made load-bearing. (Note that the CLI's `exec` ceiling follows a
   **different** rule since issue #433 fix 4: an explicit `ERIX_EXEC_TIMEOUT_MS`
   is *converged* to `min(exec, idle − 60s)` with a loud log — the reason is
   specific to command timeouts, see "Tool execution is not silence".)

Two host-observable consequences:

- A silent **`--stream`** run now ends `termination.reason: "failed"` with
  `termination.errorCode: "timeout"` once the retries are exhausted, instead of
  `reason: "aborted"` with no `errorCode` at all. This is **not** a contract
  extension: `failed` already carries `errorCode` (issue #176) and no other
  reason gained the field. Hosts that branch on `aborted` for "silent kill" must
  branch on `failed` + `errorCode: "timeout"` for streaming runs;
  **non-streaming silence is unchanged on the deadline side** and still ends
  `idle_timeout` once the CLI's retry budget is exhausted (issue #433 fix 1) —
  and since issue #440 that error keeps the engine's termination payload (see
  "The CLI's idle kill keeps the payload").
- The CLI feeds its idle watchdog on the `attempt` and `recovering` events, so a
  retry (including its backoff) is progress rather than "no progress". Without
  that, the idle window would cut the backoff and the silence would fall back to
  the abort path anyway.

The budget guarantees that **one attempt's** silence deadline fires before the
idle watchdog; it does not put the retry **backoff** inside the idle window. An
`--idle-timeout` **smaller than or equal to** the backoff schedule
(`backoffBaseMs = 1500`, then `3000`, `6000`, … capped at `backoffMaxMs = 10000`)
can still be ended by the non-retryable idle path during a backoff — exactly as
before this change; measured at `--idle-timeout 3`, where the second backoff is
exactly `3000ms` = the window: 2 calls, 9.21s, `aborted`. With the defaults
(`300`) that cannot happen.

## AssemblyPort

Hosts that assemble a complete run can provide one validated composition root
instead of repeating the individual wiring:

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider
  provider,    // Provider
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // optional TranscriptStore
  session: { id, initialMessages? }, // data only: resume is a top-level option / config.run.resume
  policy?,     // explicit run options
  emit?,       // (eventType, payload) => void
});

await runToolLoop({ assemblyPort });
```

`modelConfig`, `provider`, `tools`, `store`, `session`, and `policy` may also
be synchronous zero-argument factories when passed to `createAssemblyPort`.
The required methods are checked at assembly/startup: `modelConfig.resolve`,
either `provider.chat` or `provider.chatStream`, `tools.definitions`,
`tools.executeTool`, and `session.id`. When supplied, `store` must implement
the two required `TranscriptStore` methods — `appendRound` and `load`. A
missing required method throws `TypeError` before the run starts. `policy`
contains only named `runToolLoop` options; unknown policy keys are rejected.

### TranscriptStore capability tiers (issue #78)

The former "checkpoint" surface was renamed to **run snapshot** and demoted
to an optional capability. The actual semantics were always latest-only
autosave (each round overwrites the same slot; used only to resume a crashed
run), never a multi-version checkpoint. The tiers are:

| Tier | Methods | Missing behavior |
| --- | --- | --- |
| Required | `appendRound`, `load` | `TypeError` at assembly/startup |
| Optional run snapshot | `saveRunSnapshot`, `loadLatestRunSnapshot` | snapshot persistence skipped; run completes normally, no mid-flight crash resume |
| Optional run-state | `saveRunState`, `loadRunState`, `markRunState` | run-state persistence skipped; run completes normally |
| Host-facing optional terminal-status read | `loadRunStateStatus` | not used or validated by the engine; its absence does not emit a degraded-capability event |
| Optional fast-path pre-write probes (issue #157) | `loadByDedupKey`, `loadMaxRound` | `appendUserTurn` falls back to full `load` (paired: implementing one without the other behaves exactly like implementing neither) |

`loadRunStateStatus` resolves to the terminal status **string** —
`(runId: string) => Promise<string | undefined>`, with `undefined` when no
status is recorded for that run — not a status record object (mirrors the
source typedef in `src/store/memory.js` / `src/store/file.js`).

When an optional method is absent, the engine emits **one**
`persistence_capability_degraded` event per missing method (`{type, runId,
method, detail}`) and skips the corresponding persistence for the whole run —
no per-round log spam. `getToolMetadata` and `emit` remain optional.

### Tool replay policy (issue #139)

Tool schemas may declare `replay: "safe" | "unsafe"` on each canonical
`tools` definition; omission means `unsafe`, and other values are rejected at
startup. The declaration is engine metadata and is not sent to the model. Run
snapshots persist the resolved declaration on each `pendingToolUses` entry so
recovery uses the intent recorded when that tool call was made.

`replayPolicy` defaults to `"always-replay"`, preserving the existing resume
behavior regardless of declarations. Opt into `"per-tool-declaration"` to
replay only entries recorded as `safe`. An unsafe entry (including an older
snapshot with no `replay` field) is not executed; the model receives a
`tool_result` with `executionStatus: "interrupted"`, `is_error: true`, and an
explanation plus any captured output available in the run snapshot. The engine
emits the optional `tool_replay_decision_required` event with the run/tool IDs
and `requiresHostDecision: true`. The host owns any follow-up decision; the
engine does not schedule or retry the tool.

What the factory-shipped tools actually declare against this rule, and the
checklist for switching a host onto `"per-tool-declaration"`, are recorded in
"Factory tool replay declarations and the switch-over checklist (issue #139)"
at the end of this section.

`saveRunState`/`loadRunState` manage one latest-only structured snapshot per
run, not a history of versions. New snapshots do not persist a `state` key;
`markRunState` writes terminal status through a separate channel. Hosts that
need the status should use the optional `loadRunStateStatus` reader (returns
the status string, `Promise<string | undefined>`; see the shape note above).
The engine does not call or validate this host-facing method. When called,
this method
reads the independent status first and falls back to the embedded `state` in
legacy `.state.json` data only when the status file is absent. Corrupt status
JSON or parsed JSON without a string `status` throws instead of falling back.
`loadRunState` continues to return legacy snapshot objects unchanged, including
an embedded `state` key.

**Migration.** Replace host reads of `loadRunState(runId).state` with
`loadRunStateStatus(runId)`, and continue using `loadRunState` for snapshot
fields such as `stateVersion`, `deterministic`, and `semantic`. Existing
embedded statuses remain readable; new snapshot writes no longer include
`state`.

**Rename & merge.** `saveCheckpoint` → `saveRunSnapshot`,
`loadLatestCheckpoint` → `loadLatestRunSnapshot`. `appendCheckpoint` was
**merged into `saveRunSnapshot`**: both were identical latest-only overwrite
writes, so a separate "append" only invited the false assumption of
versioning. The file store persists snapshots as `<runId>.snapshot.json`
(was `<runId>.checkpoint.json`); reading falls back to the legacy suffix when
the new file does not exist (read-compatible, no data migration).

**Deprecated aliases (transition period).** The built-in stores still expose
`saveCheckpoint` / `appendCheckpoint` / `loadLatestCheckpoint` as `@deprecated`
aliases delegating to the new methods. Third-party stores that only implement
the old names keep working: the engine resolves the snapshot writer as
`saveRunSnapshot` → `saveCheckpoint` → `appendCheckpoint`, and the snapshot
loader as `loadLatestRunSnapshot` → `loadLatestCheckpoint`. Hosts should
migrate to the new names; the aliases may be removed in a future major.

**Known duplication (decided, not removed).** The latest run-state is
written twice: embedded in each round record (`RoundRecord.runState`) and via
the standalone run-state methods (`saveRunState`/`markRunState`). Both copies
are load-bearing, so issue #82 kept both instead of deleting one — see
[ADR-019](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/019-run-state-store-authority.md) for the authority rules and
the alternatives that were rejected or deferred.
The standalone run-state (`saveRunState`/`loadRunState`) is the authoritative
latest-only state; `RoundRecord.runState` is the history-side per-round
snapshot. On resume, a valid standalone state takes precedence; only an absent
standalone state falls back to the latest record, while a present but invalid
standalone state is reported as `state_unavailable` without fallback.

`modelConfig` is always the resolver-shaped `ModelConfigProvider`, including an
explicit override supplied alongside `assemblyPort`. A plain config object is
rejected with a migration hint; wrap it with
`createModelConfigResolver(config)` (or use
`createStaticModelConfigProvider(config)`).

The existing fine-grained `runToolLoop` options remain supported. When both
forms are present, the AssemblyPort is resolved first and explicitly supplied
fine-grained options override the corresponding assembled values. This keeps
the port at the composition boundary and does not wrap or change the loop
injection contract. If `emit` is present, it is used as the default event
sink; an explicit `onEvent` still wins. `assemblyPortContract` from
`erix-agent/contract-tests` locks these startup and precedence rules.
An assembly-shaped fine-grained entry performs the same provider, executor,
model-config, session, and required-persistence fail-fast checks before the
first provider call. `persistence: "none"` does not require a TranscriptStore.

The library's `createAssemblyPort` is the reference assembly implementation;
it performs no I/O. The CLI continues to use its existing file-backed
provider, tool, and transcript adapters, so no host needs to adopt the port
in one migration.

### Factory tool replay declarations and the switch-over checklist (issue #139)

The subsection above is the rule. This one records **what the shipped tools actually
declare against it today**, because a host cannot see that from outside the package and
it decides what switching costs. The state is: **nothing declares `replay`** — a search
for the field under `src/tools` and `bin/tools.js` returns nothing, and the only readers
of the key are the startup validator (`partialPersistenceConfig` at `src/loop/orchestrator.js`) and the resolver
(`src/loop/orchestrator.js:1890-1902`).

| Tool | Ships from | Declares `replay` today | Behaviour on resume under `per-tool-declaration` | Side effect class |
| --- | --- | --- | --- | --- |
| `readFile` | `erix-agent/tools` | no | not replayed → interrupted | none |
| `searchText` | same | no | not replayed → interrupted | none |
| `rg` | same | no | not replayed → interrupted | none (deprecated alias) |
| `grep` | same | no | not replayed → interrupted | none (deprecated alias) |
| `tree` | same | no | not replayed → interrupted | none |
| `edit` | same | no | not replayed → interrupted | writes a file |
| `writeFile` | same | no | not replayed → interrupted | writes a file |
| `note_read` | package root and `erix-agent/tools` | no | not replayed → interrupted | none |
| `note_list` | same | no | not replayed → interrupted | none |
| `note_take` | same | no | not replayed → interrupted | writes a note record |
| `note_forget` | same | no | not replayed → interrupted | revokes a note record |
| `exec` | the CLI assembly layer, not a published API entry (issue #194) | no | not replayed → interrupted | arbitrary |
| `todo_list` | the CLI assembly layer | no | not replayed → interrupted | none |
| `todo_add` | the CLI assembly layer | no | not replayed → interrupted | writes the per-cwd todo file |
| `todo_done` | the CLI assembly layer | no | not replayed → interrupted | writes the per-cwd todo file |
| `todo_clear` | the CLI assembly layer | no | not replayed → interrupted | writes the per-cwd todo file |
| skill-pack tools (names chosen by each pack) | `erix-agent/tools` | no — the loader adds no such field | not replayed → interrupted | whatever the pack's own executor does |
| the CLI's single MCP proxy tool | the CLI assembly layer | no | not replayed → interrupted | whatever the proxied server tool does |

**Default orientation: absent means `unsafe`, and the entire factory fleet is absent.**
Turning `"per-tool-declaration"` on without labelling anything therefore marks **every**
pending call unsafe on **every** resume — including the pure reads, which come back as an
`interrupted` error result exactly like `exec` does. The engine infers nothing: it does
not look at the tool name, at the executor, or at `writeToolNames` (that option only feeds
the judge's filesWritten counter, `src/loop/orchestrator.js`). Snapshots whose
pending entries carry no recorded field resolve the same way
(`docs/host-upgrade-guide-0.14.0.md`).

**Why the library annotates nothing.** A replay claim describes the **executor**, not the
schema, and these factories hand out schemas: the `definitions` arrays are plain objects
that a host may route to whatever executor it likes (a sandboxed read, an `edit` that also
writes an audit row, a `writeFile` that only enqueues). Baking `safe` into a library would
be a claim about somebody else's executor, so the annotation lives with whoever owns
`executeTool` — the same ADR-009 division that leaves `allowRead` / `allowWrite` as the
whole boundary surface. Until a factory-side default lands, **labelling is host-side
work**, and the Side effect class column above is the shape of that future default
(read-only tools safe, everything else unsafe). A skill pack is the one place the
annotation is already the author's to make: `buildSkillTools` passes each pack's tool entry
through unchanged (`src/skills/loader.js:344-348`; its validator requires only `name` and
`inputSchema`, `src/skills/loader.js:72-100`), so a pack that declares the field gets it
honoured. An MCP bridge is the other place — the library has no MCP layer (ADR-005), so a
host bridging servers builds its own tool entries and decides per server and per tool;
one proxy tool standing in for many executors (the CLI's own MCP proxy tool is exactly
that shape) cannot carry a single blanket verdict, and `unsafe` is the honest answer there.

**Switch-over checklist.**

1. **Decide per executor you actually wire, not per tool name.** A plain local read is a
   `safe` candidate; the same name proxied to a remote sandbox, metered per call, or
   writing through an audit sink is not. Marking a read `safe` carries one semantic
   caveat: the replay happens later, so the result reflects the state of the world at
   replay time, not at interruption time.
2. **Label the definitions you pass in.** The factories ship none, and each call returns a
   fresh `structuredClone` of its schemas, so mutating the result is safe:

   ```js
   import { createFileTools } from "erix-agent/tools";

   const WRITE_TOOLS = new Set(["edit", "writeFile"]);
   const fileTools = createFileTools({ cwd: process.cwd() });
   const tools = fileTools.definitions.map((definition) => ({
     ...definition,
     replay: WRITE_TOOLS.has(definition.name) ? "unsafe" : "safe",
   }));
   if (tools.find((tool) => tool.name === "readFile").replay !== "safe") {
     throw new Error("replay labelling did not survive the factory clone");
   }
   ```

3. **Opt in explicitly, and know where the option applies.** `replayPolicy` still defaults
   to `"always-replay"`. Pass `"per-tool-declaration"` as a `runToolLoop` option, or as the
   AssemblyPort `policy` key of the same name (whitelisted in `src/assembly.js`, asserted
   by `test/contract/assembly-port.test.js:47-53`). The policy is consulted **only** on the
   resume path (`guardedMessages` at `src/loop/orchestrator.js`): with `resume: false`, or with a store
   that has no run-snapshot capability, there is no pending list and the option is inert.
4. **Let the new event type through the whitelist.** A host that filters `onEvent` on a set
   of `type` strings **must** add `tool_replay_decision_required`, or the signal is
   silently dropped while everything else still looks healthy: the model receives the
   interrupted `tool_result` regardless, so the run proceeds and only the host's half —
   knowing a decision is owed — disappears. The engine emits one event per skipped pending
   call, immediately **before** the paired `tool_result` event, with
   `{ type, runId, round, toolUseId, toolName, replay: "unsafe", requiresHostDecision: true,
   partialOutputAvailable }` (`src/loop/orchestrator.js`). The README's event
   enumeration is illustrative ("including …"), not a whitelist, so a host that copied it
   into a `Set` has to re-copy it.
5. **Read the result shape correctly.** The result carries `is_error: true` and
   `executionStatus: "interrupted"`. If a `tool_result` block for that call id was already
   present in the messages, the engine **rewrites that block in place**
   (`isLowBudget` at `src/loop/orchestrator.js`) instead of appending a second one, so a host that
   diffs messages must expect a mutation rather than an addition. `executionStatus` rides
   into the display projection (`src/display/projection.js:158-160`), and afterwards the
   interrupted result is ordinary round text: only `intercepted` results are excluded from
   the aggregate-budget count (`src/loop/aggregate-budget.js:150-153`).
6. **Handle the partial output.** `partialOutputAvailable` says whether anything was found;
   when it is true the result text ends with a `Previously captured partial output:`
   section, assembled from the interrupted round's archived output plus any already-recorded
   result content, deduplicated (`compactionStat` at `src/loop/orchestrator.js`).
7. **Expect no retry and no re-pending.** The skipped call's id is **not** added to
   `executedToolIds`, the engine schedules nothing, and the run continues with the model
   looking at an error. The follow-up — ask the user, resume again carrying your own
   instruction, or drop the call — is the host's, and it is a decision the host should make
   at most once per `toolUseId`.
8. **Drain in-flight runs, and check store fidelity.** The declaration is frozen into each
   pending entry when the snapshot is written, so a snapshot written before the switch
   carries none and resolves unsafe on resume: every pending call of an in-flight run,
   including its reads, becomes an interrupted decision. A store that does not round-trip
   unknown snapshot fields loses the recorded intent and the resolver then falls back to
   the **current** `tools` array (`src/loop/orchestrator.js:1890-1902`); the shipped
   `transcriptStoreContract` already round-trips a pending entry carrying
   `replay: "unsafe"` and deep-compares it (`test/contract/transcript-store.js:124-142`),
   so a host store that passes that suite keeps the field (see also "Store fidelity
   requirements").
9. **Know the fail-fast.** A `replay` value other than the two literals, and an unknown
   `replayPolicy`, throw `TypeError` before the first provider call
   (`hasExplicitModelConfigOverride` at `src/loop/orchestrator.js` and `:583-587`) — a typo is a startup crash, never a
   silent misclassification on the resume path.
10. **The declaration is invisible to the model and to the stream.** The key is stripped
    from the provider tool list (`hasReplayDeclarations` at `src/loop/orchestrator.js`) and deleted from the
    resume-path `tool_use` payload (`guardedMessages` at `src/loop/orchestrator.js`), so a host that wants
    to display "this one was labelled safe" reads it from its own `tools` array, not from
    an event.

**Not anchored yet.** No `docs-drift-check` rule reads the presence or absence of the
annotation in the tool sources, so this table can drift silently in either direction: a
future factory-side labelling change and this subsection must ship in the same PR.

## Model metadata and budget derivation (issue #182)

`modelConfig` and `modelMetadata` are whitelisted option names whose payload
fields used to be documented nowhere. Exactly two of those fields are
load-bearing for the engine's own budget math — `contextWindowTokens` and
`maxOutputTokens` — and everything else a slot carries goes to the provider
request instead. A host that writes neither budget field keeps context
compaction and the per-round aggregate output budget switched off for the whole
run; the only signal is the `model_metadata_missing` event named below.

### Probe order and slot selection

| Probe position | Candidate | What it must hold |
|---|---|---|
| 1 | the **resolved** `modelConfig` | the object returned by `modelConfig.resolve(session?.modelSlot)` — the resolver itself is never probed |
| 2 | `modelMetadata` | metadata-only carrier; nothing else reads it |
| 3 | `model` | the `model` option object |
| 4 | `provider` | both built-in factories re-expose `contextWindowTokens` / `maxOutputTokens` on the returned object when they were given them (`src/providers/openai.js:575-584`, `src/providers/anthropic.js:541-550`) |
| 5 | `context` | the compaction-context option |

- The probe is a duck-type over that exact order and returns the **first**
  candidate that carries either field (`src/loop/budget.js:59-69`, called at
  `notifyModelMetadataMissing` at `src/loop/orchestrator.js`). Fields are **never merged across
  candidates**: a slot with only `contextWindowTokens` plus a `modelMetadata`
  carrying `maxOutputTokens` derives no budget at all. Keep the pair in one
  object.
- `modelConfig` must be a resolver (`{ resolve(slot?) }`). A plain config object
  passed as `modelConfig` is rejected at startup with
  `assembly port is missing methods: modelConfig.resolve`, because the option
  name is read as a port whenever it is present (`persistenceMode` at `src/loop/orchestrator.js`).
  The resolved value — not the resolver — is what the probe reads.
- Slot selection is per run: the slot name travels in `session.modelSlot`
  (`persistenceMode` at `src/loop/orchestrator.js`). **Up to and including 0.27.0** — a version
  that was **never published** (the last published release is 0.26.0, so the first release a host
  can actually install with the new behaviour is 0.28.0) — both built-in providers fell back to
  the `default` slot for an unknown name, so per-run selection never failed a run that only
  misspelled a slot. **Since 0.28.0 (breaking,
  issue #518)** that silent fallback is gone — "no slot named" and "a slot named wrong"
  are two different requests: omitting the slot (`undefined` / `null`) still resolves
  `default`, while an explicit name the slot map does not own **throws at startup**,
  naming the slot and listing the available ones. A host that misspells a slot can no
  longer run with a different model than the one it asked for.
- `createJsonFileModelConfigProvider` reads `{ "slots": { "<name>": { … } } }`
  from a JSON file; `createStaticModelConfigProvider` takes the same shape in
  memory. Both return the slot **verbatim** plus a materialized `apiKey`
  (`apiKey` → `apiKeyEnv` → `apiKeyFile`, `src/config/api-key.js:9-36`).

### Field contract

| Slot field | Unit | Reaches the provider request | Drives budget / compaction | Behavior when absent |
|---|---|---|---|---|
| `contextWindowTokens` | tokens (safe integer > 0) | no | **yes** — budget input, and it sizes the output-truncation limit | no budget derivable → compaction and aggregate output budget off; limit falls back to `4096` |
| `maxOutputTokens` | tokens (safe integer ≥ 0) | yes, as the default `max_tokens` when `maxTokens` is absent | **yes** — second required budget input | OpenAI omits `max_tokens`; Anthropic uses `4096`; no budget derivable |
| `maxTokens` | tokens | yes — request `max_tokens`, wins over `maxOutputTokens` | **no**, never a budget input | field omitted |
| `temperature` | number | yes — `temperature` | no | field omitted |
| `topP` | number | yes — `top_p` | no | field omitted |
| `thinking`, `reasoning`, `reasoning_effort`, `enable_thinking`, `chat_template_kwargs` | provider-specific | yes, copied verbatim into the payload | no | field omitted; reasoning detection off |
| `model_type`, `supports_reasoning`, `thinking_format` | provider-specific | no, but they mark the endpoint as a reasoning model and switch on the stream-usage probe; re-exposed on the provider object | no | probe off |
| `frequency_penalty`, `presence_penalty`, `response_format`, `providerOptions` | provider-specific | yes (`providerOptions` core keys are dropped **silently**, see #181) | no | field omitted |
| `timeoutMs`, `requestTimeoutMs`, `firstByteTimeoutMs`, `streamIdleTimeoutMs`, `streamTotalTimeoutMs` (snake_case aliases accepted) | ms | request / stream timeouts | no | engine defaults |
| `endpoint`, `apiKey` / `apiKeyEnv` / `apiKeyFile`, `model` / `model_name`, `protocol` | — | endpoint and credential identity; `protocol` selects the factory **the host** builds — the engine never dispatches on it | no | provider construction throws `provider_config` once endpoint / key / model resolve empty (`src/providers/errors.js:37-51`) |

The run-level knobs `config.tuning.maxTokens` / `config.tuning.temperature` /
`config.tuning.topP` are injected into every request and therefore **override** the same slot fields
(`src/loop/provider-runner.js:128-130`, `src/providers/openai.js:51-55`). Their **flat** spellings were
retired in 0.28.0 (see the `tuning` version policy above); the slot fields they override are a
different plane and are untouched.

**Unknown slot fields are inert and safe.** The built-in providers copy the slot
verbatim (`src/config/json-file.js:22-39`, `src/config/static.js:26-38`), and both
factories read a fixed parameter list (`src/providers/openai.js:110-153`,
`src/providers/anthropic.js:290-334`), so an unrecognized key cannot reach the wire
and cannot throw. That safety statement is about **slot
objects** only: an unknown *top-level* `runToolLoop` option still throws
`TypeError` (see "`runToolLoop` options").

### Budget derivation

`budgetTokens = context.budgetTokens ?? computeBudget({ contextWindowTokens, maxOutputTokens })`
with `computeBudget = contextWindowTokens - maxOutputTokens - max(2000, ceil(window × 0.1))`
(`persist` at `src/loop/orchestrator.js`, `src/compact/budget.js:9-33`).
`budgetTokens` is the gate for context compaction, for the per-round aggregate
output budget, and for the budget block in the request view. The output-truncation
limit is a separate derivation: explicit `outputHygiene.limit` first, else
`clamp(15% × contextWindowTokens, 8192, 100000)`, else `4096`
(`persist` at `src/loop/orchestrator.js`).

| Condition at startup | Engine behavior |
|---|---|
| neither field found in any of the five candidates | **silent skip**: `budgetTokens` stays `undefined`, compaction and the aggregate output budget stay off, and exactly **one** `model_metadata_missing` event is emitted |
| fields found but malformed (non-integer, string, window ≤ 0, `maxOutputTokens` < 0) or too small (derived budget ≤ 0) | `computeBudget` **throws `invalid_budget`** before the first provider call |
| host supplies `context.budgetTokens` | derivation is bypassed entirely — compaction is on whatever that value enables, and **no** event is emitted whatever the probe found; a non-positive / non-integer value throws `invalid_budget` from `validateBudget` |
| host supplies `context.strategy` | the strategy is asked with `budgetTokens` as-is, so a configured strategy can gate compaction without any metadata (`stateAvailability` at `src/loop/orchestrator.js`); note the built-in sliding-window strategy compares against that value and therefore never fires on `undefined` (`src/compact/sliding-window.js:34-36`) |

Both `invalid_budget` shapes are **pre-execution** throws: the run lifecycle has
not begun, so the thrown error carries no `termination`, `usage`, `rounds`, or
`finalText` (see the scope note in "Termination payload (issue #176 / #180)").

### Compaction strategy selection (issue #167)

`context.strategy` accepts a strategy **object** (semantics unchanged, byte for byte) or
one of the built-in **names** `"sliding-window" | "fold-statistical" | "fold-llm"`.
A name is resolved **once at run startup** into the same object the host would have
built (`src/compact/strategy-resolution.js`, wired at
`src/loop/orchestrator.js`), so the downstream configured-strategy channel is
untouched. An unknown name, a blank string, or a value that is neither a string nor an
object throws a `TypeError` listing the legal values **before the first provider call**
— same pre-execution throw shape as above (no `termination`/`usage`/`rounds`/`finalText`).
A name-resolved strategy also picks up context-level `recoveryHint` and `stubFor`;
object-form hosts keep setting those on the object, and the engine never rewrites an
injected object — a hand-built `createFoldLlmStrategy` object still fails with its own
constructor `TypeError` when its `summarizer` is missing.

The `fold-llm` name injects a default summarizer that reuses **this run's provider**
(`src/compact/provider-summarizer.js`): one tool-free completion per compaction whose
input is `SUMMARIZER_PROMPT_GUIDE` plus a deterministic serialization of the folded
messages and the folded round range. Its cost and accounting are part of the contract:

- **One extra call on the run's main model per compaction**, with an input roughly the
  size of the folded rounds. `fold-llm` is therefore opt-in; `fold-statistical` remains
  the default everywhere (library default stays `sliding-window` when no strategy is set).
- Its usage is merged into the run aggregate through the same `addUsage` path as other
  auxiliary calls (`persist` at `src/loop/orchestrator.js`, `trackLatest: false`) and is also
  reported through `onUsage`, so `result.usage` / `error.usage` are complete. The call
  does **not** advance `rounds`, does not feed stall detection, and does not update the
  `latestApiInputTokens` / `latestApiEstimatedTokens` used by later compaction decisions.
- A rejected, throwing, or empty-text summary answer degrades to the statistical summary
  exactly like an injected summarizer (the `[fold-llm 摘要失败…]` marker then appears in
  the next round's context). A failed summary never kills the run.
- Injecting your own strategy object stays the override channel (e.g. a summarizer on a
  cheaper model). In that form the engine books **no** usage for the summary call — the
  host accounts for it.

### Assembly self-check assertion

`model_metadata_missing` (`{type, runId, detail}`, at most one per run) is the
host's assertion point for its own assembly. A host that expects compaction
asserts the event is **absent**; a host that intentionally runs uncompacted
asserts it is present exactly once. `detail` also names the output limit it
resolved to, so the same assertion catches "my window never reached the
truncation sizing". Assert it **before** starting, or abort after assembly: a
throwing `onEvent` on this startup event is no longer a rejection mechanism, it is
reported through `onObserverError` and the run continues
(`reportObserverError` at `src/loop/orchestrator.js`; see "Observer callback errors (issue #173)").

### Multi-model slot assembly (issue #182)

One directory of models, one slot per model, one slot chosen per run. Keeping
request parameters next to the budget metadata is what makes temperature,
`max_tokens`, and thinking tiers follow the model that was picked instead of
being pinned process-wide:

```json
{
  "slots": {
    "default": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "big-model",
      "contextWindowTokens": 200000,
      "maxOutputTokens": 8192,
      "maxTokens": 2048,
      "temperature": 0.2,
      "reasoning_effort": "low"
    },
    "triage": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "small-model",
      "contextWindowTokens": 32768,
      "maxOutputTokens": 4096,
      "maxTokens": 1024,
      "temperature": 0
    }
  }
}
```

```js
import { createJsonFileModelConfigProvider, createOpenAIProvider, runToolLoop } from "erix-agent";

const modelConfig = createJsonFileModelConfigProvider({ path: configPath });

// Per-run slot choice travels with the run, not with the process.
// Omitting the slot resolves the "default" slot; an explicit unknown name throws at
// startup (since 0.28.0 — up to 0.27.0 it silently fell back to "default"; 0.27.0 was never
// published, the last published release is 0.26.0, so 0.28.0 is the first release a host can
// actually install with the throwing behaviour, issue #518).
const modelSlot = run.triage ? "triage" : undefined;
const slot = await modelConfig.resolve(modelSlot);

// Pre-flight assertion, taken before the run exists. Throwing inside a callback is
// only reported now (issue #173), so "do not run without metadata" is decided here.
if (slot.contextWindowTokens === undefined || slot.maxOutputTokens === undefined) {
  throw new Error("slot carries no window metadata: compaction is off for this run");
}

const events = [];
const controller = new AbortController();
const result = await runToolLoop({
  provider: createOpenAIProvider(slot),  // request params: model / max_tokens / temperature come from the slot
  modelConfig,                           // budget metadata: re-resolved through session.modelSlot
  session: { id: run.id, modelSlot },
  // The seed message's canonical home (the flat `initialUserMessage` was retired in 0.28.0 — see
  // "Flat-spelling version policy" below).
  config: {
    input: { initialUserMessage: run.prompt },
    // `persistence` retired its flat spelling in 0.28.0 (`config.run.persistence`; same version
    // policy as the seed message above). One `config` container — a second one would silently win.
    run: { persistence: "none" },
  },
  executeTool,
  maxRounds: 8,
  signal: controller.signal,
  onEvent: (event) => {
    events.push(event.type);
    // Still a supported escape hatch after assembly: the only way a callback ends a run
    // is the abort signal, never a throw (issue #173).
    if (event.type === "model_metadata_missing") controller.abort();
  },
});

result.termination.reason; // "end_turn" — the pre-flight check above is what proves the budget was derived
```

The engine does not switch models mid-run: the host builds the provider from the
slot it selected, and the loop only re-reads the slot for budget metadata. A run
that must change models ends and starts a new run with a different
`session.modelSlot`.

## Multi-turn resume contract (issue #97)

To continue an existing run with a new user message, the host **pre-writes a
user turn** into the transcript store and then calls `runToolLoop` with
`resume: true`. When — and only when — `resume: true` is combined with a
supplied `store` and `runId` (the condition in
`restoreResume` (`src/loop/resume-manager.js`)), the engine rebuilds its message state from
`store.load(runId)` and **ignores `initialMessages` and
`initialUserMessage`** — a host-provided user message reaches the model only
through a pre-written record, never through those options. Resuming without a
`store` or without a `runId` is an unsupported call: the initial-message
options are not overridden in that case.

A correct pre-written `RoundRecord` must satisfy:

- **Shape:** `{ round, messages: [{ role: "user", content: [{ type: "text",
  text }] }], dedupKey, roundKey, ts }` with `ts` an ISO-8601 string
  (`new Date().toISOString()`). A pre-write row **must not** carry `kind` / `seq`:
  those two fields mark engine per-message rows (`kind: "message"` + a safe-integer
  `seq`), and a row carrying them is judged an engine row by
  `restoreResume` (`src/loop/resume-manager.js`) and counted into the **crash
  site** (replayed results then land after it, so `tool_use` and `tool_result`
  are no longer adjacent ⇒ `invalid_messages`).
- **Round:** reuse the existing maximum round across `load` results
  (`Math.max(0, ...rounds)`, `0` for an empty store). The engine resumes from
  that maximum round and writes its own records at later rounds; pre-writes
  must not advance it. An empty `load` result is the seed path: pre-write the
  turn at round `0`; the built-in CLI instead passes
  `initialMessages`/`initialUserMessage` without `resume` when no records
  exist yet, which is equivalent for the engine.
- **dedupKey:** namespaced `"<key>:input:<suffix>"`, unique per turn. The
  engine writes its own rows under `"<runId>:engine:round:<n>"`,
  `"…:engine:round:0:seed"` (the seed row), `"…:msg:<round>:<seq>"` (**one row per
  message, several per round** — see the journal row shapes section), `"…:resume"`,
  `"…:control:<slot>"`, and the fact rows `"…:fold:<fp>"` / `"…:ttl:<fp>"` (see the
  next bullet), so host `:input:` keys never collide with engine rows.
- **Engine control rows (issue #326):** text the engine injects into the model's
  context **after** the current round record has already been written — the judge
  advisory nudge, the extension continuation note, the final-guard revise note, and
  the forced-final instruction together with its final assistant message — is
  journaled **at the moment it is produced**, as an engine-namespace row keyed
  `"<runId>:engine:round:<n>:control:<slot>"` (`slot` ∈ `judge-nudge` /
  `extend` / `guard-revise` / `forced-final`). The row is an ordinary
  `RoundRecord` whose `messages` are ordinary messages carrying `meta.source`
  (the #323 marker): **no new record kind, no new message field**. Hosts therefore
  observe more rows than there are rounds — a projection that renders per round
  must key on `round` and deduplicate by `dedupKey`, and a UI that shows only
  user/assistant body text keeps skipping `meta.source === "judge-control"` as it
  already does. Replaying one slot is idempotent: a crash-rerun adds no second row,
  and the row's `ts` drift does not turn the replay into a payload conflict (#326
  dedup rule). Before this fix such text was visible to the model but absent from
  `load()`, so after a restart the engine had no record of what it had told itself.
  - **The judge direction hint is deliberately *not* one of those rows.** The hint
    queued by `pendingDirectionHints` (`src/loop/run-snapshot-executor.js`), worded by
    `directionHintText` (`src/loop/reflection.js`), is flushed into a standalone `user`
    message **before** that round's own `appendRound` runs: the flush site sits inside
    the tool block, while the round record is written at the bottom of the same
    iteration in `src/loop/orchestrator.js`. Its body is therefore carried by the round
    record itself — and on the resume path by the `"…:resume"` row, whose round is the
    restored run snapshot's round (`resumeRunSnapshot`, `src/loop/orchestrator.js`). Exactly
    one copy is in `load()`, and `restoreResume` (`src/loop/resume-manager.js`) rebuilds
    it exactly once. Adding a `:control:` row for this text would store the same body
    twice and make `restoreResume` feed it to the model twice — hosts must not expect a
    `direction-hint` slot in the list above, and a projection that recognizes engine
    text by `dedupKey` alone will find this one under the plain round key. The guards
    live in `test/loop-persist-engine-text.test.js`: the journal copy count must stay
    **1** (`0` = the flush site moved past the round-record write and the text is lost,
    `2` = a second copy landed and resume feeds it twice).
- **Idempotency:** the store deduplicates by `dedupKey` (falling back to
  `roundKey`, then to the store-generated `<runId>:round:<n>` key), and
  crash-rerun judgement is by `dedupKey`: a repeated append with the same
  `dedupKey` **and an unchanged payload** is a no-op, so a stable `dedupKey`
  (derived from a host message id) makes the pre-write safely repeatable. This
  guarantee is **sequential-rerun** semantics — crash-rerun or sequential retry
  by `dedupKey`. Concurrent appends against the same key are not covered: the
  host should serialize appends per key (or issue them inside its receiving
  transaction). The resolved value of `appendRound` is not part of the
  contract (the built-ins resolve to `undefined`); read the stored record back
  with `load`, or take the `record` field `appendUserTurn` returns.
- **Timing:** persist the user turn inside the transaction that accepts the
  user message (when the host decides the turn belongs to this run), not
  lazily after a worker picks the task up — a crash between acceptance and
  pre-write would otherwise lose the turn or duplicate it.

### The resumed run is told that it was resumed (issue #404)

A resumed run is **not** a continuous conversation: between the two segments the process died, so some
`tool_use` calls had no result at all, and the engine had to replay or annotate them before the next
request. Until issue #404 the model was never told any of that — it read the engine's replay results as
its own previous output, or re-issued a side-effecting call (`git commit`, `npm publish`, an HTTP `POST`,
an overwrite, a PR) whose first attempt may already have landed.

When — and only when — `resume: true` comes with a `store` and `runId` that actually produced a ledger,
`restoreResume` (`src/loop/resume-manager.js`) plans **one** engine control message and the loop injects it
**after** the restored context (and after the replayed tool results) but **before** the first request.
The body is four lines, and every fact in it already existed in the ledger:

| Line | Fact source |
| --- | --- |
| this is a restored run, the previous segment stopped at round N, plus the stop reason if the ledger has one | `runLoopState.rounds` and `deterministic.termination.reason` (`src/run-state.js`) |
| which `tool_use` calls had no result at the crash (`id` + tool name + argument summary) | `pendingTrailingToolUses` (`src/messages/rounds.js`), read **before** the replay |
| which files were written / which tools were called recently | `deterministic.filesWritten` and the governor timeline |
| verify before acting; do not re-issue side-effecting calls blindly | static text |

What a host can observe, and what it must not conclude:

- **It is a message in `messages`.** Shape: `{ role: "user", content: [{ type: "text", text }], meta:
  { source: "judge-control" } }` — the #323 marker, so judge input keeps skipping it while the main model
  reads it. It is **not** a new payload key, and nothing is added to the `finalGuard` payload.
- **It is journaled as an ordinary `:control:` row**, `dedupKey` `<runId>:engine:round:<n>:control:resume-notice:<fp>`,
  where `<fp>` is a fingerprint of the body. Same facts ⇒ same key ⇒ the crash-rerun writes no second row and
  the resumed run does not inject a second copy; different facts (e.g. the previous crash recorded
  `termination: failed`) ⇒ a different key ⇒ one more row, and the older notice stays in the context.
  A host that counts rows per round therefore sees **one more row than rounds** on a resumed run, exactly
  like the judge nudge / extension / forced-final rows.
- **`messages` grows by one.** A resumed run's first request carries one more message (and one more
  `:control:` row) than the crashed ledger did; `round` accounting, `result.messages`, and input-token
  counts all include it. A first (non-resumed) run is byte-for-byte unchanged.
- **It is not a verification mechanism.** It is advice to the model, not a gate: `verification` still comes
  from `finalGuard` / deliverables, and a resumed run with an `accept`ing guard is `verified` whether or
  not the model acted on the notice. The engine cannot make the model verify anything — so a host whose
  tools have side effects should still make those calls idempotent on its own side (a key, a lock, a
  dedupe table). See the upgrade guide's “what did not change” section.
- **It can be folded away.** The notice is the newest round, so the default `keepRounds` keeps it
  unfolded; with an aggressive compaction configuration (e.g. `keepRounds: 0`) it can be folded into the
  summary in the very same turn, in which case the model reads the summary and not the notice.

### Same-key payload conflicts (issue #326)

An `appendRound` whose key is already persisted is a no-op **only when the
payload is that same record**. The same key carrying a different payload is an
error: neither a silent overwrite nor a silent drop. Before issue #326 the
built-in stores accepted that case silently — the second payload was discarded
with no signal to the engine or the host — which is why a lost continuation
row or a re-pre-written turn with changed text could never be observed.
Both built-ins now reject it identically (`src/store/transcript-dedup.js` owns
that decision, so the two stores cannot drift):

- The thrown error carries a stable `code`, `dedup_payload_conflict`, so a host
  can branch on it without an `instanceof` check. Its message names the `runId`,
  the key, and both payload fingerprints (`sha256:<24 hex>`), plus the names of
  the top-level fields that differ. The same values are exposed as properties
  (`key`, `existingFingerprint`, `incomingFingerprint`, `differingFields`).
- The rejection is inert: the stored record keeps its bytes and no new row is
  appended. A later replay with the original payload is still idempotent.
- Hosts that relied on the old behavior — same key, different payload, second
  write silently ignored — now see this error. `runToolLoop` treats a throwing
  store as a persistence failure (retry, then `persistence_failed`), so the
  silent loss becomes a loud run failure instead of a transcript that quietly
  lost a row.

"Same payload" is a documented digest, not byte equality: `sha256` over the
canonical JSON of the record, with object keys sorted at every level (field
order is not semantics), array order preserved (message order **is** semantics),
and `undefined`/function/symbol members dropped exactly like `JSON.stringify`
does — that last part is what makes the in-process object and the line a
JSONL store reads back fingerprint identically. Four **top-level** fields are
removed first because they are the envelope, not the payload: `dedupKey` and
`roundKey` (they are the key that just matched) plus `round` and `ts`
(`appendUserTurn` derives `round` from the store's current maximum round and
stamps `ts` with `new Date()`, so a crash-rerun of one stable `dedupKey`
legitimately drifts on both). Treating that drift as a conflict would turn the
"safely repeatable pre-write" promised above into an error, and the two failure
directions are not symmetric: a false conflict is worse than a missed one. So
the exclusion list is exactly those four names, nested `ts` values are payload,
and everything else — `messages`, `response`, `foldedPayload`, `usage`,
`runState`, and every host-owned unknown field — must match.

### Load order

`load(runId)` must return records in persistence append order for the entire
result; in particular, records with the same `round` must retain their append
order (the earlier append comes first). SQL-backed stores should order by a
persisted append sequence, or by a persisted insertion timestamp plus a unique
secondary key. For example, `ORDER BY round_no, append_seq` is suitable when
rounds are monotonic in append order and `append_seq` is a persisted,
monotonically increasing column or part of a primary key. The ordering must
preserve append order across the whole result. Do not rely on query execution
plans, incidental primary-key scan order, or accidental `filesort` behavior.

`src/loop/resume-manager.js` rebuilds state in the order returned by `load()`
and does not sort records again. This order controls not only `messages`, but
also governor history (`:101-109`), round-0 seed messages used for
`taskBriefSource` (`:88-90`), and the order-sensitive snapshot
`recordedEntries` matching (`:152-200`). A typical tie is the previous engine
round at `round=max` followed by a pre-written user row at the same round,
because `appendUserTurn` deliberately reuses the maximum round. Reversing
those rows places the new user message before the previous engine turn and
changes the message sequence semantics.

The engine does not re-sort or repair same-round records, including by
heuristics such as `dedupKey` namespaces; maintaining this order is the host
store's responsibility. `appendUserTurn` continues to reuse the maximum
round, as already specified by this contract.

Hosts should not hand-roll this. The engine exports
`appendUserTurn(store, { key, text, messageId?, ts? })` which performs the
`load`, the round derivation, `dedupKey` generation, the idempotency check,
and the `appendRound` in one call. With `messageId` the `dedupKey` is stable
(`<key>:input:<messageId>`) and reruns are naturally idempotent; without it
the suffix degrades to timestamp + random UUID (unique per call). It resolves
to `{ key, dedupKey, round, written, record? }` — `written: false` plus the
existing `record` when the idempotency check hit. The built-in CLI and REPL
are the reference consumers.

`appendUserTurn` additionally accepts a **paired optional fast path** for
database-backed hosts (issue #157): when `store` implements both
`loadByDedupKey(key, dedupKey)` and `loadMaxRound(key)`, the helper derives
the `dedupKey` first, then point-queries `loadByDedupKey` — a hit returns
immediately (neither `loadMaxRound` nor `load` is called); on a miss it
derives `round` from `loadMaxRound` and appends. The fast path never calls
`store.load`. Implementing only one of the two probes behaves exactly like
implementing neither: the full-`load` path above runs unchanged. A
`loadByDedupKey` point query must match records by
`(record.dedupKey ?? record.roundKey) === dedupKey` — the same predicate the
full path applies to `load` results — and return the complete stored record
(hit) or `null`/`undefined` (miss). `loadMaxRound(key)` must be equivalent to
`Math.max(0, …safe-integer round…)` over the `load` results, returning
`null`/`undefined` (or a negative number) for an empty store. Contract
violations throw `TypeError`: a `loadByDedupKey` result that is neither an
object nor `null`/`undefined`; a `loadMaxRound` result that is neither a
number nor `null`/`undefined`; or a `loadMaxRound` number that is not a safe
integer. When a hit record's own `round` is not a safe integer, the helper
falls back to deriving it from `loadMaxRound`. The built-in file store
implements neither probe (point queries are meaningless for JSONL).

## Persistence failure reporting

Persistence failures are reported through two reliable channels; neither
depends on the model reading a hint:

- `result.unpersisted` — the error bill (schema frozen as an array). Each
  entry carries `ts`, `kind`, `port`, `operation`, optional `phase`, `fatal`,
  `repeat`, optional `lastTs` (set when the entry absorbed a duplicate),
  and `error: { name, message }` plus the additive `error.phase` (issue #439;
  present only when the error object carried one — see the `persistence_error`
  entry shape below). Message capped at 500 characters, stack dropped.
  `delivery_failure` entries additionally carry `failedEvent`
  (the identity of the event that could not be delivered). Identical failures —
  same port/operation/phase/fatal/message, same `error.phase` when the error
  carries one, and for `delivery_failure` also the same failed-event identity —
  are deduplicated into one entry with an increasing `repeat` count instead of
  flooding the bill.
- `diagnostics.error(event)` — the same identity as an event, delivered when
  the host configured a sink. A sink that throws is itself recorded as a
  `delivery_failure` entry.
- the thrown error — a run that dies on a store write throws a `KitError` whose
  field surface is the same on both outlets: `checkpoint_failed` at a tool
  boundary (`assertSnapshotPersisted`, `src/loop/run-snapshot-executor.js`) and
  `persistence_failed` at the run tail (`makePersistenceFailure`,
  `src/loop/orchestrator.js`). Both carry `operation`, `phase`, `sideEffect`,
  `persistence`, `persistenceError`, `cause`, `errorCode`, and `unpersisted`
  (issue #230), so a host can branch on the failure without parsing `message`.
  The symmetry is over **keys and value types** — a field that exists on both
  outlets under the same name always has the same shape there, so one read path
  serves both:

  - `cause` — the underlying error object on both outlets (never a string). On
    `checkpoint_failed` it is the deepest link in the chain, i.e. the error the
    store itself threw; with no store detail it falls back to the persistence
    failure itself. `err.cause?.code` therefore reads the same way whichever
    outlet you catch.
  - `errorCode` — a string on both outlets, read by the same caliber as
    `termination.errorCode` (`terminationErrorCodeForError`,
    `src/loop/termination.js`: the root cause's own `code`, else `"unknown"`).
    A host that only needs the classification reads this field and does not
    have to reach into `cause`; identical input yields the identical string on
    both outlets.
  - `unpersisted` — the raw frozen array on both outlets (the `result.unpersisted`
    schema, unchanged since issue #109), so `err.unpersisted.length` works on
    either side. The `{ count, items }` projection produced by
    `normalizeUnpersisted` (`src/run-state.js`) belongs to the
    `<runId>.state.json` path (`deterministic.errors.unpersisted`) and is
    **not** written into the error object.

  The error code itself and the `phase`/`sideEffect` semantics are unchanged by
  this: a pre-tool failure still reports `not_started` and blocks execution, a
  post-tool failure still reports `executed_uncommitted`.

The deterministic run state carries the same bill (`deterministic.errors.unpersisted`)
so a mid-run crash does not lose it; the model-visible render shows only the
count, never host error text.

The failure tiers are per operation, not per port: transcript append and
run-snapshot/run-state write failures terminate the run (side effects are
tracked, per ADR-013) — but only when the store actually advertises the
method; a store that lacks an optional capability degrades instead of failing
(see "TranscriptStore capability tiers" above). `notes` writes continue,
report, and return a tool result that does not look like a saved note. A host
port reports its own writes through the injected `reportPersistenceFailure`
bridge, which produces the same event and bill shapes as the transcript path.

`result.completionErrors[]` collects teardown failures (multiple failures do
not overwrite each other). When the main result is an exception, the original
error stays primary and the completion errors are attached to it as
`error.completionErrors`.

## Termination payload (issue #176 / #180)

Every terminal outcome hands the host the same facts, whether `runToolLoop`
returned or threw. All fields below are additive: no existing field changes
shape, value, or meaning, and a host that ignores them behaves exactly as before.

| Field | Present on | Contract |
|---|---|---|
| `termination.errorCode` | `result.termination` / `error.termination` when `reason === "failed"` | Root-cause class of the failure. The engine passes through the classification the error already carries (`KitError.code`, e.g. `timeout`, `rate_limited`, `auth`, `server`, `checkpoint_failed`) and falls back to `"unknown"` when the error carries none — it never invents or re-derives a code. No other reason gains the field. A host decision table can therefore branch on `errorCode` instead of parsing `termination.detail`. Provider HTTP failures contribute the `classifyHttpError` value set, so since issue #179 a rejected request surfaces here as `invalid_request`, `not_found`, or `conflict` where it used to surface as `unknown` (see "HTTP error classification (issue #179)"). |
| `error.usage`, `error.rounds`, `error.finalText` | every error thrown after the run lifecycle has begun — i.e. the terminal `fail()` path. Issue #173 deleted the second producer (the startup-diagnostic annotation), so `fail()` is the only one | The accumulated usage at the throw point — literally the same object `result.usage` would have carried, including `cacheRead`/`cacheWrite` — plus the round counter and the partial final text (`""` when nothing was produced). When nothing had accumulated these are **zero values, not absent fields**: `{ input_tokens: 0, output_tokens: 0 }`, `0`, `""`. Pre-execution validation errors (unknown/malformed option `TypeError`s, assembly failures, `modelConfig.resolve` rejections) are thrown before a run exists and carry none of these fields; neither does a host observer throw, which no longer throws at all (see "Observer callback errors (issue #173)"). |
| `termination.usage`, `termination.rounds`, `termination.partial` | `error.termination` when `reason === "aborted"` | The same values as on the error object (`termination.usage === error.usage`), with `partial: true` marking the text as a partial draft rather than a final answer. |

The abort payload exists because a run the user stopped really did spend tokens.
The engine's previous behavior — throwing with the accumulated usage and round
counter left inside the closure — forced hosts to hardcode
`usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0` in their `catch`
branch, so the longest (most expensive) runs were booked as zero, and summing
the per-round `usage` events does not recover the truth: those events are only
emitted after a provider response completes, and the closing `final_guard` /
forced-final provider calls never emit one. Hosts must read the payload off the
caught error; giving up on bookkeeping for a stopped run is not allowed.

`aborted` still means "the loop throws" — this change does not turn aborts into
normal returns, and the normal return path gains no `errorCode`, `partial`, or
nested `usage` field. Whether to re-run, alert, or merely bill is the host's
decision (see the termination-reason list under "Final-answer verification"
and the run state section).

### The CLI's idle kill keeps the payload (issue #440)

The CLI is itself a host, and its own watchdog (`--idle-timeout`) is one of the
two things that can end a run `aborted` — the other is the host's own
`signal.abort()`. Until issue #440 the watchdog threw a freshly built
`IdleTimeoutError` and **dropped everything above**, so a host or bench driving
the CLI could only learn "it timed out": not how many tokens the dead run had
burned, not which round it died in, not whether a partial draft existed — which
is exactly what makes a timeout unreviewable from the outside.

What the thrown error carries now:

| Fact | Value on the CLI's idle error | Notes |
|---|---|---|
| `error.code` | `"idle_timeout"` | **the discriminator, unchanged** — the CLI's top-level `catch`, the repl line handler, and external bench accounting all branch on it. `IDLE_TIMEOUT_CODE` (`bin/idle.js`) is its single declaration |
| `error.name` / `error.message` | `"IdleTimeoutError"` / `任务 <N> 秒无进展，已中止` | unchanged (human-facing text) |
| `error.termination` | the engine's own `aborted` termination | `reason: "aborted"`, `partial: true`, and its `usage` / `rounds` equal to the two fields below |
| `error.usage`, `error.rounds`, `error.finalText` | the engine's accumulated values | **the same objects**, not copies — `termination.usage === error.usage` holds, so treat both as **read-only**: mutating one mutates the other (that is already the engine's stance) |
| `error.cause` | the engine's original error | the `AbortError` that reached the terminal `fail()` |
| `error.partial` | **absent** | there is no top-level `partial` in this contract; the flag is `termination.partial` |

Two boundaries, stated as measured rather than assumed:

- **No fabrication.** The payload rides on the engine's error because `fail()`
  annotates it (`annotateTermination` (`src/loop/termination.js`)). If the
  watchdog fires while something *other* than that terminal path is in flight,
  the keys are **absent** — not `undefined`-valued properties, and never zero
  values. Hosts must therefore treat them as optional, exactly as the table
  above already says for pre-execution errors.
- **Where it is observable.** `erix chat` throws this error to its caller, so a
  host / bench reads the payload off it. The interactive `erix repl` turns it
  into one line of text and does not rethrow, so the payload is *not*
  observable there — the discriminator (`code` / `message`) is. Two facts, and
  they are **not** the same claim: ① **the construction entry point is single** —
  the error class and the payload-carrying logic live in one place
  (`idleTimeoutFailure` (`bin/idle.js`)), so there is no second implementation to
  drift out of sync; ② **how far the payload is observable differs by entry
  point** — on the `chat` side it is read off the error object thrown out of the
  `process` layer, while on the `repl` side only the discriminator surface is
  promised: there the error becomes one line of text and is never rethrown, so
  payload retention rests on the shared construction entry point, the
  argument-shape guard, and the observation-seam assertion in
  `test/repl-idle-payload.test.js` — **not** on anything the repl hands to a host.

Reachability, measured on this tree (see "Silence is a retryable deadline"): a
silent **`--stream`** run is ended by the provider's phase deadline first and
finishes `failed` / `errorCode: "timeout"` once the retries are exhausted, so
the idle kill is *not* the normal outcome there; a silent **non-streaming** run
still ends `idle_timeout` (the legacy `requestTimeoutMs` is deliberately not
derived) once the CLI's retry budget is exhausted, and so does any run whose
provider has no phase deadlines at all (e.g. a host-injected provider) or whose
idle window is not larger than the retry backoff.

### The CLI retries a silent kill from the transcript (issue #433 fix 1)

The idle watchdog used to be terminal: `bin/cli.js`'s top-level `catch` saw
`code === "idle_timeout"` and set `process.exitCode = 1`, throwing away a run
that had already paid for several rounds. The field data behind that decision
(55 watchdog-killed runs) is that the silence **usually heals itself**: 46 of
55 produced not a single byte, yet more than 300s of silence shows up 7 times
per 1,000 rounds in the uncensored window (median 400s, max 1168s), 18 of the
35 runs that went through such a silence still scored, and a *fresh* request
starts streaming in 3.4–15s. So the CLI now **backs off and resumes the same
run from its persisted transcript** instead of waiting forever or re-running
the task:

- `--idle-retry-budget <seconds>` (`chat` only, default **900**, `0` = off),
  measured as **wall-clock elapsed since the first kill** — backoffs *and* the
  retry attempts count, so it is not merely the sum of backoffs.
  **This changes the default wall clock of a silent run**: a host that relied on
  "silence ⇒ quick exit" must pass `--idle-retry-budget 0`. **Measured worst
  case** (permanently silent upstream, `--idle-timeout 1`, default budget):
  **130.3s** from start to exit, nine attempts, backoffs
  `1, 2, 4, 8, 16, 30, 30, 30`s — at that window size the attempt cap binds
  first. At the default `--idle-timeout 300` the budget binds instead:
  **~1200s** from start — **computed, not measured** (one 300s window + the
  900s budget + the last window: kills land at 300s / 601s / 903s / 1207s, and
  the fourth is where 907s of budget has elapsed). The model is verified by a
  scaled-down measurement rather than by a 20-minute run: `idle=2` / `budget=6`
  with a permanently silent upstream gives **9084ms**, three attempts, backoffs
  `[1000, 2000]`ms and `exhausted: "budget"` — the "first window + budget +
  one more window" model predicts 9.0s, whereas a "budget + start" model would
  predict 7s / two attempts and is ruled out by that measurement. The first
  retry starts **~2s** in (1s window + 1s first backoff).
- Exponential backoff: `IDLE_RETRY_BASE_DELAY_MS` (`bin/idle.js`) = 1000,
  doubled per retry, capped at `IDLE_RETRY_MAX_DELAY_MS` = 30000; each backoff
  is also clamped to the remaining budget.
- A second, independent gate: `IDLE_RETRY_MAX_ATTEMPTS` = 8 retries. The budget
  alone would let `--idle-timeout 1` spread 900s into hundreds of provider
  calls; with the 30s cap the eight backoffs sum to ~121s, so the two gates meet
  rather than one silently standing in for the other.
- The retry is a **resume, not a re-run**: the engine's `resume` path
  (`restoreResume` (`src/loop/resume-manager.js`)) rebuilds the context from
  the transcript and the run snapshot, so the paid rounds and tokens are kept —
  `rounds` keeps counting from the ledger and the resumed request carries the
  tool results that were already persisted.
- A retry is attempted only when the transcript is non-empty. A run whose store
  holds no record (e.g. persistence failed) ends `idle_timeout` directly,
  instead of being replaced by a resume error.

What a host can observe, and where:

| Fact | Channel |
|---|---|
| retry count, each backoff, budget, accumulated usage, which gate stopped it | `result.idleRetry` (success) / `error.idleRetry` (terminal) |
| one record per step (`phase: "backoff"` / `"recovered"` / `"exhausted"`, carrying `retries` / `backoffMs` / `usage` / `idleSeconds`) | `judge.log`, `type: "idle_retry"` |
| one human-readable line per retry plus a summary | stderr (the `idleLog` sink; injectable in-process) |

Boundaries, stated as measured:

- **Not every silence is rescued.** A `--stream` run hits the provider's
  retryable phase deadline first (previous section) and lands on the engine's
  retry loop; `--idle-timeout 0` disables the watchdog entirely (no retry); and
  `erix repl` has no retry (its default window is 0 and it is an interactive
  session).
- **The terminal is unchanged.** When the budget or the attempt cap runs out,
  the run ends exactly as before: `code === "idle_timeout"`,
  `name === "IdleTimeoutError"`, and the issue #440 payload
  (`termination` / `usage` / `rounds` / `finalText`, no top-level `partial`).
  `error.idleRetry.exhausted` says which gate stopped it (`"budget"` /
  `"max_attempts"` / `"no_transcript"`).
- **The engine's own retry counter is untouched.** Each retry attempt is a
  separate `runToolLoop` call, so provider-level `attempt` / `recovering`
  events restart per attempt and `judge.log` holds one `run_outcome` record per
  attempt (the last one is the terminal). The CLI's accounting is the
  `idleRetry` snapshot above, not a reconstruction of the engine's counters.
- **`usage` on the terminal error is the last attempt's usage** (the engine's
  contract shape); the cross-attempt total is `idleRetry.usage`.

### Tool execution is not silence, and `exec` cannot outlive the idle window (issue #433 fix 3 / fix 4)

Two CLI-side behaviours, no `src/` change:

- **Fix 3 — feeding.** While a tool runs, the watchdog is fed every
  `toolHeartbeatIntervalMs` (= `idle/4`, clamped to 250ms–30s), so a command
  that outlives the idle window no longer kills the run. The feeding is
  **bounded**: it stops after `toolHeartbeatCapMs` (= the `exec` ceiling, i.e.
  `max(30s, idle − 60s)`) and the silence window then starts over, so a tool
  that never returns is still collected — without that bound, feeding would turn
  fix 1 into "death is never declared". Evidence is observable: every fed execution logs
  `[idle-heartbeat] <tool>: fed the idle timer N times` (`N > 0` only) and
  reaching the cap logs a second line. The fed line also carries the effective
  cap (`上限 <n>ms`) — that is what pins the wiring, so a test can assert the
  assembled default without waiting 31s.
- **Fix 4 — the ceiling.** The effective `exec` timeout is
  `min(configured, max(30s, idle − 60s))` — **including** an explicit
  `ERIX_EXEC_TIMEOUT_MS`, which used to be used verbatim. When the clamp
  actually lowers the value the CLI logs one loud line; it does **not** refuse
  to start, because `exec == idle` is a real benchmark configuration and the
  criterion is "the run must not end `idle_timeout`". For `idle ≤ 30s` the 30s
  floor wins (`execCeilingMsForIdle` = `max(30s, idle − 60s)`, so the effective
  value is 30000ms ≥ idle) and `exec < idle` cannot hold at all; for
  `idle > 30s` — including 31 / 50 / 90s — the ceiling is strictly below the
  window and the invariant does hold. The `idle ≤ 30s` case is logged too (the
  log's own trigger is `effectiveMs >= idleMs`, the same boundary), and what is
  actually guaranteed there is the feeding above (worst case `30s + idle`,
  measured in the CLI README).

### Value-added calls before the terminal decision (issue #282)

The round judge and the final guard are *value-added* calls sitting between the last
model round and the terminal decision. Each costs a real provider round trip, and
neither of them may overwrite a user abort. The rule is one line, and since issue #282
it is enforced at the terminal decision itself instead of being patched in at each call
site: **`aborted` outranks `judge_done` and `final_guard_*`**.

| Scenario | Engine behaviour | What the host sees |
|---|---|---|
| `signal.abort()` was already set when the end-turn judge would start | the judge call is **skipped entirely** — the entry guard is `roundJudgeEnabled && isEndTurn && !signal?.aborted` in `src/loop/orchestrator.js` | one fewer model request than before issue #282, and stop latency drops from one LLM round trip to immediate |
| abort while the judge request is in flight | the judge call is interrupted and the abort error reaches `fail()` | `reason: "aborted"` carrying the issue #180 payload |
| abort after the judge returned, before the terminal reason is derived | the terminal `stop` branch checks the signal first (`throwIfAborted(signal)` at its head) and throws instead of returning the judge's verdict | `reason: "aborted"` plus `{usage, rounds, partial:true}` — **never** `judge_done` |
| abort while `finalGuard` runs | the same checkpoint immediately before `finish(reason)` re-checks the signal | `reason: "aborted"`, never `final_guard_unverified` |

Text the model already produced is not lost by the abort: it stays on `error.finalText`
(issue #180). When the judge did run, its verdict is still recorded on the judge-record
channel (see "Judge record correlation and run outcome (issue #165)"), so a host can tell
"the judge considered the work done" apart from "the user let the run finish".

### Where the facts live after an abort (issue #283)

An aborted run leaves **no transcript record that the engine wrote for the round that was
in flight**: the engine commits a round only when `appendRound` succeeds, and a round
interrupted before that commit is not retroactively written. One exception, stated so it is
not mistaken for a guarantee: `persist()` checks the signal **before** it calls the store
(`src/loop/orchestrator.js`, the retry loop opens with `throwIfAborted(signal)`), so an
`appendRound` that was already in flight when the abort landed can still commit. Treat the
in-flight round as having no record, and never as a count you can reconcile against.
This is a deliberate decision (issue #283,
option β), not an oversight — an interrupted round has no stable round key, its tool_use
blocks may have no `tool_result` pair (which would make the transcript unreplayable for
the resume contract), and writing a half round would silently change what `rounds` counts.

Therefore `termination.partial: true` means **the payload**, not the transcript: it
asserts that the caught error carries the partial facts (`error.finalText`,
`error.usage`, `error.rounds`, mirrored into `termination`), and it asserts nothing about
the store. A host that renders "what already happened" must read the channel that actually
holds each fact:

| Fact the host wants to show after an abort | Channel that holds it | Guaranteed? |
|---|---|---|
| Rounds the run had already finished | `RoundRecord` entries in the transcript store (written by `appendRound`) | yes — abort never rewrites or deletes committed rounds |
| Text already streamed in the interrupted round — **reasoning / thinking deltas never enter this channel** | run-snapshot channel, i.e. `partialPersistence:{intervalMs}` with `stream:true` | **best effort, may be missing entirely.** Only the *latest committed* partial **text** is there: a commit needs a delta of `minBytes` and the interval timer to fire, the timer is cleared when the attempt ends without flushing what is still buffered, and an abort does not force a flush. When it does exist it is at most `intervalMs` stale. Without the option the in-flight round has no snapshot at all (see the in-flight `appendRound` caveat above for the one exception) |
| The partial final text itself | `error.finalText` (and `termination.partial`), issue #180 | yes — `""` when nothing had been produced; **this is the only guaranteed partial-text channel** |
| What the stopped run actually cost | `error.usage` / `termination.usage`, `error.rounds` / `termination.rounds` | yes — same objects the normal return would have carried |
| The last judge verdict before the stop | judge-record channel (`onJudge` callback / `judge.log`), issue #165 | present when the judge actually ran; absent when the abort skipped it (see the table above) |
| The interrupted round as a transcript record | **nowhere the host can rely on** | no — the engine deliberately does not write an `interrupted` round (β); only an `appendRound` that happened to be in flight can land, and it is not a channel you can plan around |

Two consequences for hosts, both pinned by this section: a host that wants the partial
text on screen must read `error.finalText` — that is the guaranteed channel — while
`partialPersistence` buys a best-effort snapshot of the *committed* partial text only (no
reasoning, possibly nothing at all, up to `intervalMs` stale); and a host must not treat
"`partial: true` but zero `RoundRecord` for that round" as a persistence bug — that is the
documented shape of an abort without partial persistence.

Its value proposition comes down to one thing: `partialPersistence` lowers only the cost of
**regenerating that text when the run resumes**; it is not the channel that puts the text in
front of a user (that is `error.finalText`), and the snapshot writes it performs in steady
state are a net loss when a host's own crash-requeue rate is low. So measure that rate
before enabling it — the share of queued runs with `attempts > 1` (`run_queue.attempts`, the
number erix-station reads) — and decide from your own number rather than from a threshold
measured somewhere else. The host that asked for the option is itself the evidence, cited as
observation and not as advice: over ten days of development erix-station saw roughly one
natural crash-requeue (`attempts > 1` on 8 of 133 runs, 3 of those 8 being deliberate
`docker pause` / `kill -9` drills); ⚠ that is a single-machine, single-user sample taken
after the host had fixed its own defects — do not extrapolate it. It is not a reason to
retire the option either: it stays in the whitelist, five test files cover it, and it costs
nothing while it is off.

## Usage accounting: the round ledger vs engine overhead (issue #438)

`result.usage` is unchanged: it accumulates **every** provider call the run made — the model's
own responses and the calls the engine issues on its own behalf. Issue #438 adds the split, as
new keys only. No existing key changed shape or meaning, and a host that ignores the new keys
behaves exactly as before.

| Key | Lives on | Means |
|---|---|---|
| `usage` | `result` (unchanged) | run-cumulative over **all** provider calls: `modelUsage` + `engineUsage`, field by field (a missing field counts as 0) |
| `modelUsage` | `result` (**new**) | run-cumulative over the loop's own model responses, `max_tokens` continuations included |
| `engineUsage` | `result` (**new**) | run-cumulative over the calls the engine issued itself |
| `usage` | `RoundRecord` (**new**) | that round's **complete** model usage: every response of the round, continuations included |
| `engineUsage` | `RoundRecord` (**new**) | engine-issued calls that ran **during** that round; the key is **absent** when none did |
| `response.usage` | `RoundRecord` (unchanged) | the **last** response of the round only — the historical shape, kept byte for byte |

Four things a host has to read correctly, because getting them wrong silently miscounts money:

- **`record.response.usage` is not the round's bill.** It is literally the `usage` of the last
  provider response merged into the round. A round that hits `stopReason: "max_tokens"` is
  continued **inside the same round** (up to `maxTokenContinuations` extra requests, all merged
  into one assistant message and one `RoundRecord`), so `response.usage` then carries only the
  final shot. Measured on a real round: three shots of 700 + 700 + 7 `output_tokens` (1407 in
  total) left `response.usage.output_tokens === 7` — a 200× undercount. Before issue #438 this
  contract never said which of the two it was, so a host reading it as the round's usage was
  reading a number that had never been promised. **Read `record.usage` for the round.**
  `response.usage` stays byte-identical because hosts already read it — and so does the
  projection: `meta.usage` is still that same last-response value, deliberately not switched
  over by issue #438.
- **`record.usage` is the round ledger.** It sums every response of the round, so budgets,
  billing, and "how much did the model write per round" analyses should read it. `input_tokens`
  and `output_tokens` are **always present** (zero when the provider reported nothing — never
  an absent key), while `cacheRead` / `cacheWrite` appear only when some response reported them
  (the same field-presence rule `result.usage` follows). In a round with no continuation, whose
  provider reports all four fields, `record.usage` and `record.response.usage` are deep-equal;
  that equality is a test, not a coincidence. With no usage at all the key is still there, as
  `{ input_tokens: 0, output_tokens: 0 }`. A record written **before** this version — or by the
  host itself — simply has no `record.usage`: the key is additive, so absence means "this row
  predates the key", never "zero".
- **Engine overhead is a separate bucket, never inside the round ledger.** The engine issues
  provider calls the model did not ask for: the round judge, the wrap-up LLM normalizer, the
  fold summarizer, and the forced final (`forceFinalIfNeeded` (`src/loop/termination.js`)).
  Their usage lands in `engineUsage` — round-level for the first three (they run inside the
  round) and run-level for the forced final (it runs **after** the last round record is
  written, so it can never be attributed to a round). The round ledger therefore contains
  model output only, which is what keeps "the model wrote a lot" and "the engine spent a lot"
  distinguishable. On a `RoundRecord`, `engineUsage` is absent when the round issued no such
  call, and zero-valued when such calls ran but the provider reported no usage; the run-level
  key is always present. Both buckets are booked at the single accounting point
  (`addUsage` (`src/loop/orchestrator.js`)) through one `account` argument, so there is no
  second ledger to drift.
- **`finalGuard` usage is in neither bucket, and the abort payload carries no split.** The
  guard is a **host** callback: the engine never issues that call and cannot measure it, so it
  must not be counted as model output or as engine overhead — a host whose guard calls a model
  books that cost itself. And an aborted run still throws with `error.usage` /
  `termination.usage` only (issue #180). The two buckets are additive on the **success result**
  **only**, and there `usage` remains the sum of the two, field by field. A `RoundRecord` has no
  such key: it carries no `modelUsage`, so `record.usage` is the **model bucket alone** (the
  table row above says "complete **model** usage" for exactly this reason) and the round's total
  is `record.usage` (model bucket) + `record.engineUsage` (engine bucket) — with the second one
  **absent** when the round issued no engine call, so a host adding them reads absence as 0.
  What a host must not do is take `record.usage` for the round's whole bill: it is the model's
  share of it, and only `result.usage` (on the success result) is a ready-made sum.

## Judge record correlation and run outcome (issue #165)

Judge decisions are consumed off `onJudge` (the CLI appends them to `judge.log`;
a host may append them anywhere). Two additive fields make those records
groupable per model, and one additive event makes them joinable to a terminal
outcome. No existing field changes name, shape, or meaning, and a host that
ignores all three behaves exactly as before.

| Field | Present on | Contract |
|---|---|---|
| `runId` | every `onJudge` record and the `run_outcome` event | The run id the host passed to `runToolLoop`; it is the join key between the streamed decisions and the terminal record. When the host passed no `runId` the field is **absent** — the engine does not synthesize one. |
| `model` | every `onJudge` record and the `run_outcome` event | The model the run actually used when the judged decision was made, resolved from run options / provider configuration. Probe order matches `modelMetadataFor()` (`modelConfig` → `modelMetadata` → `model` → `provider` → `context`), key order `model` → `model_name` (same as provider construction), first hit wins and candidates are **not** merged. Never hardcoded. When no candidate yields a non-empty name the field is **absent**: writing `"unknown"` would make "no model configured" indistinguishable from a model literally named `unknown`. |
| `judgeModel` | `onJudge` records, only when the judge ran on a different evaluator model | Lets per-model calibration distinguish the evaluated model from the model evaluating it. Absent when the judge shares the run's model. |
| `compaction` stat | `onEvent` (`type: "compaction"`) and the `<runId>.state.json` `deterministic.compactionStats` window | Existing keys are unchanged. **Additive (issue #464 A):** `strategyName` is present only when the engine could state it truthfully — it names the strategy that **actually performed** this fold, including the library fallback (`"sliding-window"`), not the host's config value. Hosts that ignore it see the previous shape verbatim. **Additive (issue #469 ④):** `foldSummary` carries the **result state** of this fold's summarizer call — `degradeKind` (`timeout` / `context_window_exceeded` / `error`), `degradeReason`, `inputTruncated`, `droppedMessages`, `finishReason`, `inputTokens`, `outputTokens`, `priorSummaryTruncated`, `priorSummaryBytes`, `droppedRounds`, `attempts`, `budgetExhausted`, `reused`. Same discipline as `strategyName`: **no fact, no key** — a fold that produced nothing diagnostic leaves the shape byte-for-byte unchanged. The summary text itself never lands here (it lives on `record.foldedFacts`). |
| `compaction_strategy_fallback` event | `onEvent`, at most once per run | **Additive (issue #464 A).** `{ type: "compaction_strategy_fallback", round, detail }`, emitted exactly when `context.strategy` is **not** configured *and* the fold was budget-triggered, i.e. the engine's own `sliding-window` fallback ran (whole head rounds dropped with no summary and no anchors — issue #464 B). Shape follows `model_metadata_missing` (issue #182): the first sentence of `detail` is fixed text hosts can assert on, then `budgetTokens` / `estimatedTokens` are appended when a budget resolves. |
| `run_outcome` event | `onEvent`, exactly once per run — including runs where the judge never ran | `{ type: "run_outcome", runId?, model?, judgeModel?, rounds, judgeRecordCount, termination, verification }`. Emitted on the success path after persistence settles, and on the throwing path from `fail()`; a latch guarantees exactly one per run. `termination` / `verification` are copies of what `runToolLoop` returned (or what `fail()` built). |

Why a separate terminal record instead of writing the outcome back into the
decision records: judge records stream out while the run is still executing and
the outcome is only known at the end, so rewriting a run's already-emitted
records would break the append-only semantics of a JSONL log a host may already
be consuming. Correlation is therefore a **join**: every decision record carries
`runId`, the terminal record carries the outcome. Discriminator: a decision
record has `kind` (`round` / `intercept`); the terminal record has
`type: "run_outcome"` and carries neither `kind` nor `action`, so hosts that
count or filter decisions by `kind` / `action` are unaffected. `judgeRecordCount`
lets a host detect dropped lines: it equals the number of records the run handed
to `onJudge`.
Resume semantics: one `run_outcome` per `runToolLoop` invocation. A resumed run reuses
its `runId`, so a `runId` may legitimately carry several terminal records — take the last
one as the current outcome, or key on `(runId, ts)` when you need every attempt.

`run_outcome` is a new event type on the existing `onEvent` stream (additive
event type = semver minor); no new callback was introduced, because the `onJudge`
payload means "one judge decision" and pushing a terminal verdict into it would
silently skew hosts that count decisions. Host throws from this single terminal
event follow the unified observer rule (issue #173): they are reported through
`onObserverError` and never change the termination — an audit record must not
turn a finished run into `failed`.

Field stability: the record shape is a host consumption surface, so fields are
additive only — new optional fields may appear, existing ones are never renamed,
retyped, or removed within a major version. The archive stays a debug/analysis
surface, not a completion certificate: the loop still does not certify
completion (see "Final-answer verification").

## Termination decision table (issue #170)

A host should be able to decide what to do with a terminal outcome without
reading the loop. Every mechanism below writes the **same** `termination.reason`
field, but only one of them can win a given run: the mechanisms are ordered and
mutually exclusive. Line references are the implementation truth; if code and
table disagree, the code is right and this table is a bug.

Nine reasons are enumerable on the return path (`runToolLoop` at `src/loop/orchestrator.js`);
`persistence_failed` is a tenth that only ever appears on the throw path, so it
is listed too. `truncated` is `true` exactly for `max_rounds_cap`,
`continuation_exhausted`, `stall`, and `final_guard_unverified`
(`src/loop/termination.js:7-11`).

| `termination.reason` | Triggering mechanism (file:line) | Position in the precedence chain | Host switch | Recommended host action |
|---|---|---|---|---|
| `end_turn` | governance stop `completion` (`src/reflection/governor.js:118`) or the fall-through stop `complete` (`src/reflection/governor.js:134`), both mapped by `terminationReasonForAction` (`src/loop/termination.js:111`). Inputs: `shouldContinue` (`src/loop/orchestrator.js`), `completionSignalDetected` from a wrapup envelope `done:true`, a `completion.signals` text match, or the LLM normalizer (the end-turn wrap-up block in `src/loop/orchestrator.js`, which calls `normalizeWrapupText` (`src/reflection/wrapup.js`)) | lowest-priority stop in the round chain — every other stop and nudge is evaluated first, and the round judge can pre-empt it with `judge_done` (`src/loop/orchestrator.js`) | not disableable (it is the normal success exit). `wrapup:false` removes the JSON envelope path (`src/loop/orchestrator.js`); `completion:{signals:[…]}` widens keyword detection (`src/loop/orchestrator.js`) | **accept**, but only after inspecting `verification.status` — `end_turn` alone is not a delivery proof |
| `judge_done` | round judge `done:true` with `confidence >= 0.7` on an end-turn round (`src/loop/orchestrator.js:3357-3365`, `isEndTurn` at `3053`), mapped at `src/loop/termination.js:94` | highest stop in the round: evaluated before the governor, so it outranks stall and completion | `reflection:false`, `reflection:{roundJudge:false}`, `ERIX_NO_ROUND_JUDGE=1`, `ERIX_NO_REFLECTION=1` (`src/loop/orchestrator.js`). Note reflection auto-enables at `maxRounds >= 16` (`src/loop/orchestrator.js`, `src/loop/reflection.js:8`) | **accept then verify**: this is a model-side claim, not a check. Route it through `finalGuard` / CI before downstream use |
| `no_tool` | governance stop `noTool` (`src/reflection/governor.js:122`), gated by `noToolRound` (`src/loop/orchestrator.js`) and a streak `>= maxNoToolRounds`, default 3 (`maxNoToolRounds` at `src/loop/orchestrator.js`) | below the completion stop, above the `complete` fall-through | `completion:false` makes `noToolRound` permanently false, so the reason becomes **unreachable** and the run ends `end_turn` instead; `completion:{maxNoToolRounds:n}` moves the threshold (`0` stops on the first occurrence) | **retry / re-prompt**: the run stopped with no completion claim and `truncated:false`, so nothing was truncated — it stalled in prose. Alert if it repeats |
| `stall` | identical tool-call signature inside the detection window (`src/loop/orchestrator.js:2712-2726`), streak accumulation (`src/loop/orchestrator.js:2763-2770`), stop at `src/reflection/governor.js:67-70` with `STALL_STREAK_LIMIT = 3` (`src/reflection/governor.js:3`), mapped at `src/loop/termination.js:97` | second-highest stop — only `continuation_exhausted` outranks it; deliberately ordered above the wrap-up and repeated-error nudges so it cannot be starved (`src/reflection/governor.js:65`) | `stallDetection:false` makes it **unreachable** (`errorHashes` at `src/loop/orchestrator.js`); `stallDetection:{window,mode}` re-tunes it; `ERIX_STALL_MODE` overrides the mode unless the option is `false` | **alert + retry differently**: `truncated:true`, so never accept the text as an answer. The host's own repeat-guard should trip here |
| `continuation_exhausted` | provider kept answering `max_tokens` and the continuation budget ran out (`continuationExhausted` at `src/loop/orchestrator.js`, loop at `2635`); governance stop `cap` (`src/reflection/governor.js:62-64` / `133-135`) mapped to this reason **before** `max_rounds_cap` (`src/loop/termination.js:116`) | **first** check in both governance entry points — the top of the chain | `maxTokenContinuations` (`messageRounds` at `src/loop/orchestrator.js`, default 3; `0` makes the first `max_tokens` response terminal) | **retry with more output room** (larger `maxTokens`/`maxOutputTokens`), or accept the partial text and alert; `truncated:true` |
| `max_rounds_cap` | (a) governance stop `cap` when the limit is near and extension is not allowed (`src/reflection/governor.js:147-149`); (b) the round loop simply runs out (`runToolLoop` at `src/loop/orchestrator.js`, tail handling at `3189-3207`) | (a) budget boundary, below stall; (b) runs after the last round, before any post-stop guard verdict stands | `maxRounds` (required option); extension headroom via `reflection:{maxExtensions, maxRoundsCap, extensionStep}` (`termination` at `src/loop/orchestrator.js`); `ERIX_NO_REFLECTION=1` disables auto-reflection | **resume or accept-partial**: use the multi-turn resume contract to continue, otherwise book the partial result and alert; `truncated:true` |
| `final_guard_unverified` | a configured `finalGuard` ran and could not certify: non-continuable stop (`src/loop/orchestrator.js:3529-3542`), revision limit (`3544-3559`), or the budget-exhaustion tail (`3558-3578`). Only reachable for the six guard-eligible reasons (`src/loop/termination.js:14-21`) and only when `finalGuard` is a function (`src/loop/orchestrator.js`) | strictly **post-stop**: it replaces the reason after forced wrap-up and guard evaluation, never during round governance | omit `finalGuard` entirely (then `verification` is `skipped` / `no_final_guard`, `src/loop/orchestrator.js:1663-1665`); `finalGuardMaxRetries` moves the revision limit (default 2, `budgetRounds` at `src/loop/orchestrator.js`) | **do not consume as a verified fact**: `verification.status === "unverified"` (`non_continuable` / `max_retries`). Route to human review or the test system |
| `aborted` | the terminal `fail()` path while the host signal is aborted (`src/loop/orchestrator.js:1058-1116`; classification at `1061` and `1080-1085`, annotation at `1103-1108`) | overrides failure classification on the throw path — the signal is checked first. Since issue #173 a host callback cannot reach this row by throwing: `signal.abort()` is the only callback-side trigger, and the issue #180 payload rule above still applies to it. Since issue #282 the same check also runs at the head of the terminal `stop` branch and again before `finish(reason)`, so a pre-terminal value-added call (round judge / final guard) can no longer rewrite a user abort into `judge_done` or `final_guard_unverified` — see "Value-added calls before the terminal decision (issue #282)" | nothing to disable: the trigger is the host's own `AbortSignal` | **bill, do not auto-retry**: read `error.usage` / `error.rounds` / `error.finalText` (issue #180) and `termination.partial`; the user asked for this stop. A **silent** run is no longer guaranteed to land here: since issue #441 the CLI wires the engine's retryable phase deadlines, so silence ends `failed` / `errorCode: "timeout"` once the retries are exhausted (see "Silence is a retryable deadline"); this row now means the signal was really aborted — by the host, or by the idle watchdog when no phase deadline could fire. When the watchdog is the one that fired, the payload still rides on the thrown error under `code: "idle_timeout"` (issue #440, see "The CLI's idle kill keeps the payload") |
| `failed` | any error thrown inside the run lifecycle, via `fail()` (`src/loop/orchestrator.js:1058-1116`, loop catch at `3576-3580`), with `termination.errorCode` passed through (`src/loop/termination.js:43-57`). A host observer throw is no longer one of those sources (issue #173) | catch-all: it outranks every pending governance decision because the round never completed | `retry:{attempts, backoffBaseMs, backoffMaxMs}` decides how much is retried before this reason appears (`src/loop/orchestrator.js`); the reason itself is not disableable | **branch on `termination.errorCode`** (issue #176): retryable (`timeout`, `rate_limited`, `server`) → backoff retry; `auth` → alert and stop; `invalid_request` / `not_found` / `conflict` (issue #179) → fix the request, the model name, or the colliding resource — re-sending the same payload cannot help; `unknown` → inspect `termination.detail` |
| `persistence_failed` | same `fail()` path, selected when the error carries persistence info (`src/loop/orchestrator.js:1080-1085`), which also adds `operation` / `phase` / `sideEffect` (`src/loop/orchestrator.js`) | replaces `failed`, never the reverse; carries no `errorCode` (that field is `failed`-only) | `persistence:"none"` removes the transcript write path entirely; optional store capabilities degrade instead of failing (see capability tiers) | **alert**: side effects were tracked, so this is an integrity signal (ADR-013), not a retry candidate |

### Verification status and CLI exit codes

`verification` is a separate axis from the termination reason: an `end_turn` can
come back `unverified`, and a `max_rounds_cap` / `stall` /
`continuation_exhausted` can only ever end up `skipped` or `error` — with a guard
configured, a `verified` verdict is not available to them, because a guard
`accept` on those three reasons still terminates as `final_guard_unverified`
(`src/loop/orchestrator.js:3529-3542`). The CLI mapping is
`exitCodeForVerification` (`bin/cli.js`):

| `verification.status` | Meaning | `verification.reason` seen in practice | CLI exit code |
|---|---|---|---|
| `verified` | the configured guard accepted this final answer | — (no reason field) | `0` |
| `skipped` | nothing was checked — **not** a claim of correctness | `no_final_guard` (`src/loop/orchestrator.js`); CLI guard `no_capture_evidence` / `no_extractable_candidates` (`bin/final-guard.js:86,89`) | `4` |
| `unverified` | the check ran and was not satisfied | `non_continuable` (`src/loop/orchestrator.js`), `max_retries` (`3547-3551`) | `2` |
| `error` | the guard threw, decided invalidly, or timed out (fail-open for availability, never `verified`) | `timeout` or `error`, both resolved by `errorReason` (`src/loop/termination.js`) | `3` |

`exitCodeForVerification` returns `0` for any other status, including a missing
`verification` object, so **exit code 0 is not by itself proof of a verified
answer** — read `verification.status`. A run that threw exits `1` from the CLI's
top-level handler (`bin/cli.js:1032-1042`), which is a failure signal, not a
verification outcome.

### Mechanism precedence and mutual exclusion

Within one round, exactly one mechanism gets to decide, in this order
(`judge_done` at `src/loop/orchestrator.js`, `src/reflection/governor.js:59-126`,
`src/loop/termination.js:111`):

1. **token-continuation boundary** — repeated `max_tokens` responses set
   `continuationExhausted`, which is the first test in both governance entry
   points (`src/reflection/governor.js:62-64`, `133-135`). Because
   `continuationExhausted` is checked before the `cap` mapping
   (`src/loop/termination.js:116`), a `cap` stop caused by truncated output
   reports `continuation_exhausted`, never `max_rounds_cap`.
2. **stall stop** (`src/reflection/governor.js:67-70`) — above the wrap-up and
   repeated-error nudges on purpose, so a low-priority nudge cannot starve a
   genuine loop into `max_rounds_cap`.
3. **wrapup declaration** — a `done:true` envelope suppresses continuation and
   raises `completionSignalDetected` (`src/loop/orchestrator.js`),
   which both produces the `completion` stop (`src/reflection/governor.js:118`)
   and makes `noToolRound` false (`src/loop/orchestrator.js:3230-3233`). Declared
   completion and `no_tool` are therefore mutually exclusive.
4. **completion keyword fallback** — the same signal with no parseable envelope
   comes from `completion.signals` matching the final text
   the end-turn wrap-up block in `src/loop/orchestrator.js`), or from the LLM normalizer when an
   end-turn round produced no envelope at all **and the text is not empty**
   (the end-turn wrap-up block in `src/loop/orchestrator.js`, opt-in via `reflection.wrapupNormalize` /
   `ERIX_WRAPUP_NORMALIZE=1`).
5. **`no_tool` stop** — reachable only when nothing declared completion and the
   round produced no tool call (`src/loop/orchestrator.js:3230-3233`).
6. **round judge end-turn evaluation** — `judge_done` is evaluated *before* the
   governor (3253-3262), so it outranks 2-5 in the round it fires; it requires
   `isEndTurn`, i.e. `stopReason === "end_turn"` with no tool use
   (`src/loop/orchestrator.js`). A tool round can therefore never produce
   `judge_done`, and a `max_tokens` round can never produce both `judge_done`
   and `continuation_exhausted` (the mapping prefers `judge_done` anyway,
   `src/loop/termination.js:94`).
7. **post-stop verification** — after a stop reason exists, forced wrap-up may
   add one more provider call for the six wrap-up-eligible reasons — the three
   non-continuable ones plus `judge_done` (issue #467) plus `end_turn` and
   `no_tool`, which reach it only when the run has no body at all (issue #475) —
   and only when
   `hasFinalDraft` (`src/loop/termination.js`) is false, i.e. only when the run
   would otherwise end with no terminal text
   (`src/loop/termination.js:203-256`), then `finalGuard` may accept, skip,
   revise, or fail. A `revise` verdict is not terminal: it injects a user
   message and governance starts over for that round
   (`src/loop/orchestrator.js:3156-3178`). Revision retries are bounded by
   `finalGuardMaxRetries` (default 2, `budgetRounds` at `src/loop/orchestrator.js`),
   and the guard's own timeout defaults to 30 s
   (`budgetRounds` at `src/loop/orchestrator.js`).
   The wrap-up text is **payload-only** (issue #467): it reaches the host through
   `result.finalText`, plus one extra journal row written by
   `appendEngineMessagesToTranscript` (`src/loop/orchestrator.js`) whose
   `roundKey` is **shared** with the last round record — only `dedupKey`
   distinguishes the two — and it never reaches the host through an event:
   `forced_final` carries only `{type, round, reason}` and `run_outcome` carries
   no `finalText`. A host that renders from events alone therefore still shows the
   judge card last, even after issue #467. And since an `accept` verdict must never
   rest on `finalText` being non-empty (see `S6a`), a host-side acceptance decision
   has to read `termination.forcedFinal`.
8. **`fail()` classification** — any throw at any point replaces all of the
   above with `aborted` (signal set) or `failed` / `persistence_failed`
   (`src/loop/orchestrator.js:1058-1116`).

**Mid-run "goal achieved" advisory — `reflection.judgeDoneAdvisory` (issue #322).**
A transparent interception audit that returns `done: true` with
`confidence >= 0.7` currently only reaches a human: `directionHintText`
(`src/loop/reflection.js`) emits text for `off_track` alone, so that `reason`
never entered a later provider request. With the sub-key enabled (default
`false`), the verdict additionally feeds the opinion back to the **main model**
as one synthetic `user` text message, built by `judgeDoneAdvisoryText`
(`src/loop/reflection.js`), offered through the single-slot
`offerJudgeDoneAdvisory` (`src/loop/run-snapshot-executor.js`) and delivered by
`flushJudgeDoneAdvisory` (`src/loop/orchestrator.js`) at both flush points
(normal round and resume — one policy, one slot). Host-visible guarantees:

- the message carries `meta.source: "judge-control"`, so `renderConversation`
  (`src/reflection/judge.js`) keeps excluding it — the model reads it, the judge
  never reads its own opinion back. No new marker value was introduced and the
  exclusion predicate is unchanged;
- it is an **opinion**: no tool call is blocked, no round is stopped early, and
  nothing is written into `tool_result`. `termination`, the `tool_result` fact
  chain, usage and the tool-execution count are identical with the switch on or
  off; finishing leftover work after an "achieved" verdict stays legitimate;
- **one slot, not a queue**: repeated "achieved" verdicts inside one round
  overwrite the pending text instead of appending, so there is no per-round cap,
  no merge counter and no per-transcript quota — and it deliberately does not
  join the direction-hint FIFO or its two-per-round merge;
- the judge's `reason` is truncated to 200 characters and the whole advisory to
  400 (`JUDGE_DONE_ADVISORY_REASON_LIMIT` / `JUDGE_DONE_ADVISORY_LIMIT`,
  `src/loop/reflection.js`); the wording states the claim is **未独立核验** (not
  independently verified) and asks for a delivery summary with no new work, or
  only the necessary missing items — it never says 已核验/已验证;
- the same sub-key also gates the neutral `uncertain` wording in
  `directionHintText` (`src/loop/reflection.js`): off, an `uncertain` verdict
  still produces no direction-hint text and the provider request sequence stays
  byte-for-byte identical to a run without the option; on, `uncertain` stops
  being phrased as "your route may be off, consider another approach", which
  invited needlessly trying more routes. `off_track` wording and injection
  timing do not change in either case;
- a non-boolean value throws `TypeError: reflection.judgeDoneAdvisory must be a
  boolean` at startup, and no extra judge call is made;
- known gap (deliberately not fixed here): the pending advisory is not part of
  the run snapshot, so a resume before the first flush drops it.


## Reflection decision parsing (issue #305)

`parseReflectionDecision`（`src/loop/reflection.js`）turns one reflection model
answer into the decision object the governor acts on. It is a host-visible API:
the engine re-exports it from the package root（`src/index.js`）and from
`src/loop/orchestrator.js`, while the engine itself never calls it.

**JSON extraction is a top-level balanced scan**, not a greedy regex. The scan
lives in one shared place — `jsonCandidates`（`src/text/json-candidates.js`）,
extracted verbatim from the wrap-up parser (`tryParseWrapupJson`,
`src/reflection/wrapup.js`), which keeps its previous behavior word for word —
so the two model-JSON parsers in this package no longer disagree about where an
object ends. The scan is string- and escape-aware, yields **only** objects whose
brace depth returns to zero, and yields **nothing** for an object left unclosed.

| Field | Value | When the model omitted it |
|---|---|---|
| `progress` | finite number from `progress` | `undefined` |
| `stalled` | `true` only for a literal `stalled: true` | `false` |
| `continueFlag` | `true` only for a literal `continue: true` | `false` |
| `stallPattern` / `reason` / `plan` | `String(...)` of the field | `""` |
| `via` | `"json"` or `"prose_fallback"` | always present |

`via` names the **source** of the values, not a schema verdict: `"json"` means
the values came from a parsable top-level object, `"prose_fallback"` means they
came from keyword matching over the whole text. Every one of the six fields is
optional, so a half-populated object such as `{"progress":3}` is a legal
decision and stays on the `"json"` path. One deliberate exception: when a
top-level object parses but carries **none** of
`progress`/`stalled`/`continue`/`stallPattern`/`reason`/`plan`, there is nothing
to carry over and the result is reported as `"prose_fallback"`.

Before this fix the extraction was the greedy `/{[\s\S]*}/`, so a trailing
sentence containing a brace pair (a `{plan}` placeholder in prose, a fenced
answer followed by a remark, or two sibling objects) produced one
non-parsable blob; `JSON.parse` threw, and the keyword fallback ran over the
whole text **including the JSON itself** — which matched the key names and
silently inverted the booleans the model had just written
(`"continue": false` came back as `continueFlag: true`).

Two neighbors are **intentionally unchanged**: the fallback's `reason`
truncation stays `value.slice(0, 200)` (UTF-16 code units), even though
`truncate`（`src/reflection/judge.js`）counts code points with `Array.from` —
unifying them would change a host-visible value; and the round judge
（`parseJudgeDecision`，`src/reflection/judge.js`）still scans from **every** `{`, so an
unclosed outer object still yields its inner fragment. Issue #307 only moved that scan
into `parseModelJson`（`src/text/parse-model-json.js`）as its `topOnly: false` profile —
behavior word for word identical — and issue #309 owns changing the verdict itself.

## Unified model-JSON entry point `parseModelJson` (issue #307)

`parseModelJson`（`src/text/parse-model-json.js`）is the single public way this package
digs a JSON object out of model text. Before it, four places did that job with four
different answers to "where does the object end"; two of them (the reflection parser and
the round judge) are now served by this one entry point. It is exported from the package
root（`src/index.js`）and is covered by `engineApiContract`.

```js
import { parseModelJson } from "erix-agent";

// parseModelJson(text, { topOnly = true, requireKeys = null } = {}) ->
//   { ok: true, value, via: "json", candidates } | { ok: false, error, candidates }
const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
if (hit.ok) {
  // hit.value — the direct JSON.parse output (field validation stays with the caller),
  // hit.via — the literal "json", hit.candidates — every balanced slice, in order of appearance
} else {
  // hit.error — "no_candidate" | "unparsable" | "shape_mismatch"; there is no `value` key here
}

const unparsable = parseModelJson('{"a":,}');
const shapeMismatch = parseModelJson('{"confidence":0.5}', { requireKeys: ["done"] });
const noCandidate = parseModelJson('{"a":1');   // unclosed outer object: no candidate, no repair

if (hit.ok !== true || hit.via !== "json" || hit.value.done !== true) throw new Error("example input must hit");
if (unparsable.error !== "unparsable" || shapeMismatch.error !== "shape_mismatch"
  || noCandidate.error !== "no_candidate") throw new Error("the three failure kinds must stay distinguishable");
if ("value" in unparsable || "value" in shapeMismatch || "value" in noCandidate) {
  throw new Error("a miss carries no value key, not even value: undefined");
}
```

The failure is a **three-way** verdict, because the three causes need three host
reactions (send the model a different prompt / accept that it never answered in JSON /
ask for the missing field):

| `error` | when it fires |
|---|---|
| `no_candidate` | the scan produced nothing — prose only, or braces that never balance |
| `unparsable` | candidates exist but every `JSON.parse` threw (e.g. `{"a":,}`) |
| `shape_mismatch` | something parsed, but no candidate satisfies `requireKeys` |

**There is no repair.** No closing brace is appended, no trailing comma is dropped, no
value is rewritten: a candidate that does not parse simply loses (the "normalizers may
only carry things across" charter in this document). A failure result carries **no**
`value` key — not `value: undefined` — so `if (!result.ok)` really leaves you holding
nothing, and a failed parse can't be mistaken for "the model answered with an empty object".

`candidates` is always the **complete** scan output in order of appearance (losing
candidates included), so a caller can re-run its own stricter per-candidate validator on
it — that is exactly how `parseJudgeDecision`（`src/reflection/judge.js`）keeps its
behavior while no longer owning a scanner.

**Two profiles, still one file.** `topOnly` defaults to `true`: only objects whose brace
depth returns to zero are candidates, and an unclosed outer object yields nothing.
`topOnly: false` scans from **every** `{`, so an unclosed outer object yields its inner
fragment first; that profile exists only so `parseJudgeDecision`（`src/reflection/judge.js`）
can share the scan with **zero** behavior change (issue #309 owns changing that verdict).

`requireKeys` is any-of key **presence** — a candidate passes if it holds at least one of
the listed keys — and it never looks at value types. That is the same division of labour
as `jsonCandidates`（`src/text/json-candidates.js`）: the scan is shared, the verdict is the
caller's. An empty array or `null` means "no shape check".

Where the four sites went, and why:

| site | verdict | reason |
|---|---|---|
| `parseReflectionDecision`（`src/loop/reflection.js`） | **migrated** (default profile + `requireKeys` = the six decision keys) | behavior is word-for-word what issue #306 shipped; the differential test compares it against a copy of that implementation over the known shapes plus 3000 deterministic random inputs |
| `parseJudgeDecision`（`src/reflection/judge.js`） | scanner replaced by the entry point with `topOnly: false`; **its own candidate loop stays** | judge must skip a parseable-but-invalid candidate (`done` not a literal boolean, `confidence` outside [0,1]) and try the next one; the entry point returns a single `value`, so using it as the verdict would turn "skip this candidate" into "the whole parse failed" |
| `tryParseWrapupJson`（`src/reflection/wrapup.js`） | **not migrated**, still calls `jsonCandidates` directly | its guard is stricter than key presence (`done` must be a literal boolean; `action`/`note` sends the object back to the inline-L1 path) and it must also skip-and-continue. Skipping is load-bearing: `{"done":"true"}{"done":true}` has to return the second object. The inner `{"done":…}` must not bypass that mandatory-done guard（issue #30 follow-up）, which is why the scan stays top-level-only here |
| `extractL0Facts`（`src/reflection/l0.js`）、`parseFoldSummaryMatch`（`src/compact/fold-statistical.js`） | **out of scope** | neither is "find JSON in model prose": L0 lifts a `<erix-summary>` tag out of model prose — note that the engine does **not** ask the model to emit it (issue #465: `parseL1Summary` is read-side only, there is no prompt-injection site anywhere in `src/`, so a host that neither injects nor instructs always lands on `summary: "missing"`), and the fold summary reads a `导航记录：{…}` line the **engine itself** wrote, failing closed to `undefined`. Dropping the tag / the line anchor would widen what they accept — a behavior change, not a deduplication |

## Model-output normalization with an optional fallback: `normalizeModelJson` (issue #406)

`normalizeModelJson`（`src/normalization/parse-model-json.js`）is the **asynchronous**
sibling of `parseModelJson`（`src/text/parse-model-json.js`）. It exists because hosts were
each digging JSON out of model output themselves, and every dialect — a fenced block, a
trailing comma, single quotes, Python literals, a truncated answer — got a different
answer from a different implementation.

**It does not replace `parseModelJson`, and the two must not be merged into one function.**
One is synchronous and repairs nothing; the other is asynchronous and repairs structure,
with an optional model call at the end. A host that `await`s both would get a value from
one and a `Promise` from the other, and every existing `parseModelJson` caller would
silently change behaviour if the two were collapsed.

| | `parseModelJson`（`src/text/parse-model-json.js`） | `normalizeModelJson`（`src/normalization/parse-model-json.js`） |
|---|---|---|
| layer | L0, strict | L1 deterministic repair + gate + optional L2 fallback |
| sync | **synchronous** | **asynchronous** (always returns a `Promise`) |
| repairs | **never** | structure only — a value's bytes are preserved |
| model call | never | only when `llm: true`, candidates exist, **and** every deterministic candidate lost |
| result | `{ ok, value, via, candidates }` / `{ ok: false, error, candidates }` | `{ ok, value, repaired?, llmUsed?, dropped? }` / `{ ok: false, error, llmUsed? }` |

The failure kinds keep the **same three names**, but the mappings are not interchangeable —
a host must branch on the right one:

| `error` | `normalizeModelJson` | `parseModelJson` |
|---|---|---|
| `no_candidate` | empty input, or truncated input — **any** candidate is truncation-shaped (the completion rule can rewrite it) | nothing scanned out (prose only, or braces that never balance) |
| `unparsable` | candidates exist but every one threw — **prose lands here**, because the whole text is itself a candidate | candidates exist but every `JSON.parse` threw |
| `shape_mismatch` | something parsed, but no candidate passed `validate` | something parsed, but no candidate satisfied `requireKeys` |

Two divergences are disclosed here rather than papered over, because a host that reads either
of them as "the same answer as `parseModelJson`" will mis-branch.

**① `parseModelJson` can only ever return an object.** Its scan looks for balanced
**objects**, and its value check drops anything else (`src/text/parse-model-json.js` skips a
parsed array or non-object), so a top-level array or scalar is never a candidate: `[1,2]`,
`123`, `"hello"`, `null` and `true` all come back `no_candidate` there, while this entry
returns `ok` with that value — and **no** `repaired` key, because nothing was rewritten.
Read `no_candidate` from this entry as exactly the two cases in the table above, never as
"there is no JSON here".

**② Truncation the completion rule cannot fix is a class, not a single shape.** For every
shape in that class `parseModelJson` says `no_candidate` (the braces never balance, so its
scan yields nothing) while this entry says `unparsable` (the candidate set reuses that scan,
and none of the candidates it yields can be completed — completion requires the completed
text to `JSON.parse`). Measured on this branch:

- prose **before** the fragment — `前言 {"a":1`;
- prose **after** it — `{"a":1 以上是结果。`;
- the fragment is **not an object** — `前言 [1,2` (L0's scan only yields objects, so no
  candidate survives);
- prose after a truncation **inside a fence** — a `json` fence whose body is
  `{"a":1 以上是结果。` (the fence body is the whole rest of the block, prose included);
- the #406 scenario, a truncated **tool-argument** string whose value carries a **raw
  newline** — `{"tool":"readFile","args":{"path":"a<newline>以上`: completion would have to
  repair an illegal character, not just close a brace, so the text is not even
  truncation-shaped.

The last row has an edge worth naming: the same text with the newline written as the
**two-character JSON escape** `\n` (`{"tool":"readFile","args":{"path":"a\n以上`) *is*
truncation-shaped, completes to a parseable object, and is `no_candidate` on **both**
entries. The divergence is about a raw newline byte, not about the tool-argument shape.

Both entries are saying "there is no JSON here"; they count the attempts differently. This
is a **class** of shapes — any truncation the completion rule cannot turn into parseable
JSON — not one special case, and `test/normalization/parse-model-json.test.js` pins it with a
case per row.

**Provenance is `repaired`, and the key appears only when the text really changed.**
`repaired: { rule, trusted }`: `rule` is the ids of the rules that actually fired, in
application order, joined with `+`; `trusted` is `true` only when every one of them is an
engine rule. A rule the host injected through `repair.inject` always yields
`trusted: false` — the engine cannot prove byte preservation for someone else's rule. A
parseable input therefore carries **no** `repaired` key at all (not `repaired: null`).

**The gate is always judged against the candidate's original bytes.** `validate` is called
as `validate(value, source)`, where `source` is the **original slice of the input** — never
the repaired text. This is the load-bearing invariant of the whole layer: a repair that
rewrites a value (say `http\.request` → `http.request`) would otherwise pass a
`source.includes(value)` check against text the caller never saw, which is a silently
fabricated value. A **completed** candidate is under the same rule: the gate receives the
**pre-completion** original (`{"a":` for the input `{"a":`), not the completed `{"a":null}` —
otherwise a completion rule could fabricate a string value and every verbatim check would
wave it through. The second argument is additive: a one-argument `validate` still works, but
it has given up the ability to prove the value was not rewritten.

One limit on the `source.includes(value)` recipe, and it is the #406 main scenario (tool
arguments carry **code strings with `\n`**): that literal comparison only holds for string
values that contain **no JSON escape**. A value the model wrote as `"line1\nline2"`,
`"tab\there"` or `"quote\"inside"` arrives at `validate` **decoded** (`\n` is a real newline),
so the raw slice never contains it and a naive `includes` rejects a perfectly good value as
`shape_mismatch`. For those values compare after decoding both sides — parse the slice
(`JSON.parse(source)`) and compare the values, or compare against `JSON.stringify(value)`
without its outer quotes — instead of doing a byte-for-byte search on the raw text.

**Candidates** are the whole input, every fenced block (including the remaining body of an
**unclosed** fence), and every top-level balanced object L0's scan finds — in that order,
each tried independently and then gated; the first candidate that parses **and** passes the
gate wins. **Order is load-bearing**: fences are tried **before** L0's scan, so a fenced
object that appears later in the text outranks an earlier top-level object — `{"a":1}`
followed by a `json` fence containing `{"b":2}` yields `{"b":2}` here while
`parseModelJson` yields `{"a":1}`.
The third tier reuses L0's scan — `jsonCandidates`（`src/text/json-candidates.js`） — and
exists because of design decision D1 ("call L0, do not copy the scan"): with only the whole
input plus fences, this entry would be **weaker** than the L0 it claims to wrap. Each shape
pinned in the test file is a case where the whole input and every fence body fail to parse,
so the only candidate that can win is the one L0's scan contributes
(`好的，结果如下：{"done":true}`, `{"done":true} 以上是结果。`, `{"a":1}}extra{`,
`前言 {"outer":{"done":true}} 后语`, a `~~~json` fence). With `repair.truncateCompletion`
on, each candidate's completed form is appended as an **extra** candidate at the end.
Completion is **chained with the rule table** (the enabled rules first, `truncation` last),
which is what makes it actually rescue: a plain truncation, a truncation inside a fence
(closed **or unclosed**), and a truncation combined with a structural defect
(`{"a":"x\.y"` ⇒ `invalid-escape` doubles the escape, then the brace is closed) — and the
provenance names every rule that fired (`invalid-escape+truncation`). It does **not** rescue
a truncation it cannot fix (the class in the `no_candidate` note above), and it is off by
default so a complete input never gains a `truncation` provenance.

```js
import { normalizeModelJson } from "erix-agent";

// normalizeModelJson(rawText, { validate?, provider?, slot?, llm?, thinking?, maxTokens?, signal?, repair?, schema? })
//   -> Promise<{ ok: true, value, repaired?: {rule, trusted}, llmUsed?: true, dropped? }
//             | { ok: false, error: "no_candidate" | "unparsable" | "shape_mismatch", llmUsed?: true }>
const clean = await normalizeModelJson('{"done":true}');
if (clean.ok !== true || clean.repaired !== undefined) throw new Error("a parseable input is not repaired");

const repaired = await normalizeModelJson('{"done":true,}');
if (repaired.repaired.rule !== "trailing-comma" || repaired.repaired.trusted !== true) {
  throw new Error("provenance must name the rule and whether the engine trusts it");
}

// The gate's second argument is the candidate's ORIGINAL bytes, never the repaired text.
const raw = '{"path":"a\\.b"}';
const injected = { id: "host-unescape", apply: (text) => text.replace("a\\.b", "a.b") };
const gated = await normalizeModelJson(raw, {
  repair: { inject: [injected] },
  validate: (value, source) => ({ ok: source.includes(value.path) }),
});
if (gated.ok !== false || gated.error !== "shape_mismatch") {
  throw new Error("a value the original text does not contain must be rejected");
}

// Truncated input: the same verdict as the synchronous entry unless completion is opted in.
const truncated = await normalizeModelJson('{"outer":{"done":true}');
if (truncated.error !== "no_candidate") throw new Error("truncation is not repaired by default");
const completed = await normalizeModelJson('{"outer":{"done":true}', { repair: { truncateCompletion: true } });
if (completed.repaired.rule !== "truncation") throw new Error("opting in must be visible in provenance");
```

The optional model call (L2) is the **only** thing here that ever spends money, and
`llm: true` is its only switch: it fires only after every deterministic candidate lost, and
**never** when the candidate set is empty (an empty or whitespace-only input makes zero
requests — there is no original text to hand the model). The
request always carries `reasoning_effort` pinned to a non-thinking value (normalizing text
is not a reasoning task), and its answer still has to pass the same `validate` gate — L2
output that fails the gate is `shape_mismatch`, never a silent accept.

`loadModelSlot` / `createProviderForSlot`（`src/config/slot-provider.js`）exist so a host can
obtain the provider L2 needs without writing its own config reader: the first reads
`slots.default` and validates the required fields (`config_missing` / `config_invalid`), the
second flattens a slot into an OpenAI-compatible provider.

#### Cost of the optional call

Each call makes **at most one request and never retries**: `llm: true` buys one attempt at
normalizing the text, and a second request is never issued — not on a parse failure, not on
a gate rejection, not on a malformed answer. Nothing here imposes a cost ceiling: no
default `maxTokens` is invented (omit it and the provider's own default applies), and there
is no timeout knob on the option surface — the only timeout is the one the `slot` path
pins, `DEFAULT_PROVIDER_TIMEOUT_MS`（`src/config/slot-provider.js`）= 300 s of hard
wall-clock time per request. The `slot` route also means **reading the disk**: it starts
with `loadModelSlot`, which reads and validates the config file before any request is built
— so a host that takes that route in a hot path pays for file I/O on every call. Finally, a
provider that throws **propagates the exception** out of `normalizeModelJson`; it is not
folded into the three failure states. Wrap the call if the host needs a cost or failure
ceiling of its own.

#### The engine's wrap-up normalization uses this entry (issue #406 B2-b)

The loop's own end-of-turn normalization — the fallback that fires on an `end_turn` round
with no tool use and no parseable envelope, opt-in via `reflection.wrapupNormalize` /
`ERIX_WRAPUP_NORMALIZE=1` — no longer builds a private request. It calls
`normalizeWrapupText` in `src/reflection/wrapup.js`, which delegates to `normalizeModelJson`
with `thinking: "none"` and the envelope shape as the `schema` example; the public
`normalizeWrapupWithLlm` is a thin shell over the same function. One implementation means
one prompt, one gate, one non-thinking value and one failure fact for both callers. Five
consequences are host-observable:

- **One prompt, less context.** The old inline prompt (task brief, round count,
  `JSON.stringify(text)`) and the old wrap-up-specific prompt are gone. The surviving
  request is this entry's generic "normalize the raw text" prompt plus the envelope shape
  example, so the normalizer sees the raw text and the shape — **not** the task brief or
  the round count. **This is a quality risk, stated as a risk:** the only remaining cue for
  `done` is the shape example (whose `done` is `false`), because the old inline rule ("a clear
  conclusion / the artifact is ready ⇒ `done=true`; stopped or gave up ⇒ judge whether the output is
  decidable") was deleted with that prompt, and **no test pins `done` under the unified prompt**.
- **The gate is shared, and it judges the agent's own text.** Every `findings` value must
  occur verbatim in the agent's original text; entries that do not are dropped **silently at this
  entry** — the `dropped` list is only visible one level down, on the return value of
  `normalizeModelJson` / `wrapupGate`, never on the wrap-up return value — instead of rejecting the whole envelope. The check never uses the
  normalizer's own answer as the source — that would let the normalizer certify its own
  rewrites. The public entry now applies this gate too; before B2-b it accepted a rewritten
  value (e.g. `gold-4173` for an agent text that said `gold-417`) with no check at all.
- **Deterministic repair can answer without a request.** Shapes the L1 rules can fix — a
  trailing comma, a doubled illegal escape — are normalized with **zero** model calls, and
  their string values keep their original bytes. Before B2-b those shapes went to the
  model.
- **Empty or whitespace-only agent text makes zero requests.** The candidate set is empty,
  so this entry does not spend a call (see the L2 section above). The loop then takes its
  ordinary no-tool path and the final text stays exactly what the model produced
  (possibly empty). Before B2-b the inline path sent one request even for empty text.
- **Failures are structured.** The entry returns `{ ok: false, error }`; the loop still
  turns the normalization switch off for the rest of the run after the first failure (the
  same semantics as before — it is not retried every round), and a provider that throws
  still degrades through the loop's catch. `normalizeWrapupWithLlm` returns `null` for a
  failed normalization and still propagates evaluator exceptions.

Because the public entry is the same function, these consequences apply to it too: an
input that is already a parseable envelope, or one the L1 rules can repair, comes back
**without a model call**, and empty/whitespace-only input returns `null` without a request
(it used to send one). The normalizer's own answer also goes through the same L1 rules
(`{"done":true,}` used to count as a failure and switch normalization off for the run; it
is now repaired).

`summary` and `output` are prose for the user, not declared facts, so they are **not**
verbatim-checked; only `findings` is.

## Reusable normalization primitives

## Reusable normalization primitives

Hosts that provide their own OpenAI-compatible transport can import these
helpers from the package root. They perform no I/O or model calls:

| Export | Signature | Semantics |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | `null`/`undefined` return `undefined`; any other input returns an object mapping `prompt_tokens`/`completion_tokens` to `input_tokens`/`output_tokens` when present (so `{}`, an array, or a string yields `{}`). Canonical aliases are **not** accepted. |
| `normalizeOpenAIStopReason` | `(reason, fallback = "unknown") -> string` | Maps `stop`, `tool_calls`/`function_call`, and `length` to canonical stop reasons; unknown values pass through. |
| `parseOpenAIToolArguments` | `(rawArguments) -> any` | Parses JSON, uses `{}` when absent, and returns malformed values under `_truncatedArguments` and `_raw`. Since issue #409 it runs the same L0-then-L1 path as the engine's tool loop (invalid escapes are doubled, never deleted), so a payload that is repairable now comes back as a parsed object; a payload that still fails keeps the legacy `_truncatedArguments`/`_raw` shape byte for byte. The verdict itself is not on this return value — it rides on the `tool_use` block as `erix.argumentsParseError`. |
| `createOpenAIStreamAccumulator` | `() -> accumulator` | Accumulates indexed or legacy streamed tool-call fragments; `getToolUseBlocks()` returns canonical tool-use blocks. |

`createOpenAIStreamAccumulator().addToolCallDelta()` accepts an OpenAI delta
or `{ index, id, name, argumentsDelta }`, while
`addFunctionCallDelta()` accepts a legacy `function_call` delta. The malformed
argument behavior is intentionally the same as the library's canonical
response conversion.

## Final-answer verification

Before consuming a `runToolLoop` result, the host must inspect
`verification.status`:

| Status | Contract |
|---|---|
| `verified` | The only status the loop uses for a final answer accepted by the configured guard. |
| `skipped` | There was nothing the guard could compare, or the guard was not enabled. **This does not mean that the answer is correct** and must not be rewritten as `verified`. The CLI exits with code 4, so "not checked" is distinguishable from `verified` (exit code 0). |
| `unverified` | The required provenance check was not satisfied. The CLI exits with code 2; the host must not consume the result as a successful result. |
| `error` | The guard threw, returned an invalid decision, or timed out. The CLI exits with code 3; the host must not consume the result as a verified fact. |

`finalGuard` is opt-in in both `runToolLoop` and the CLI. Omitting it from
`runToolLoop` produces `status: "skipped"` with `reason: "no_final_guard"`.
The CLI enables it with `--final-guard` or `ERIX_FINAL_GUARD=1`; it is disabled
by default, and `--no-final-guard` is a compatibility no-op. The default
`finalGuardTimeoutMs` is 30000; non-positive values use that default. The
verification exit codes above describe verification outcomes only; ordinary
provider, tool, or loop failures follow the normal failure path.

`verification.metrics` is the guard's **decision counter**, not a second verdict:
`metrics.verified` counts guard calls that returned `accept`, so a run stopped by
`max_rounds_cap` with an `accept` verdict reads `metrics.verified: 1` while
`verification.status` stays `unverified` (`reason: "non_continuable"`,
`termination.reason: "final_guard_unverified"`) — the counter says "a verdict was
rendered", the status says "nothing was accepted". To decide whether an answer was
accepted, read `verification.status` **only**; `metrics` is observability and must never
be read as a status.

The loop calls a configured guard before stopping for
`end_turn`, `no_tool`, `judge_done`, `max_rounds_cap`, `stall`,
or `continuation_exhausted`. The guard receives
`finalText`, `findings`, `messages`, `round`, `rounds`, `signal`, and
`termination`. `findings` is the completion envelope's declared
`label -> exact value` map; it is the authoritative carrier for verifiable
claims, and `finalText` is not parsed for them. `{ action: "accept" }` permits normal
termination. `{ action: "skip", reason }` terminates with `skipped`. A
`{ action: "revise", message }` decision is injected as a separate user text
message and the loop continues, up to `finalGuardMaxRetries` revision retries
(default 2). If revision is still required at the limit, the loop keeps the
last `finalText`, sets `verification.status` to `unverified`, and terminates
with `termination.reason === "final_guard_unverified"` (fail-closed).

The non-continuable stop reasons `max_rounds_cap`, `stall`, and
`continuation_exhausted` cannot become verified merely
because a guard returns `accept`; they degrade to
`final_guard_unverified`. A guard exception, invalid decision, or timeout is
fail-open with respect to loop availability: the original termination reason is
preserved, but `verification.status` is `error` and the result is never
`verified`. Each guard outcome emits an `onEvent` event with
`type: "final_guard"` and an `action` of `accept`, `skip`, `revise`,
`degraded`, or `error`. When a store provides `markRunState`, the terminal state is
`unverified_error` for an unverified result, `guard_error` for a guard error,
and `succeeded` otherwise.

#### Budget-type stops: the opt-in guard bridge — `finalGuardExtend` (issue #386 slice 3)

`finalGuardExtend: boolean`, **default `false`** — written `config.guard.finalGuardExtend` since 0.28.0
(the flat spelling is rejected on the spot; see the `guard` group's version policy above). Absent or
`false`, every budget-type stop
behaves byte-for-byte as described above. With `finalGuardExtend: true`, a `revise` verdict on
a **budget-type** stop buys **at most one** extra round through the engine's *existing*
mid-run extension mechanism — `extensionAllowed` (`src/reflection/governor.js`), applied by
`applyGovernorExtension` (`src/loop/orchestrator.js`): the same counters, the same
`meta.source: "judge-control"` user message — instead of degrading. All four conditions must
hold:

| Condition | Detail |
|---|---|
| stop reason ∈ `{max_rounds_cap, continuation_exhausted}` | **`stall` is never extended** — a stall *is* "no progress", so granting it rounds only burns budget. The set is `FINAL_GUARD_EXTENDABLE_REASONS` (`src/loop/termination.js`); `FINAL_GUARD_NON_CONTINUABLE_REASONS` and every `termination.reason` value are unchanged |
| `finalGuardExtend === true` | host opt-in; `null` / numbers / strings throw `TypeError` (a `"false"` string must never switch it on) |
| guard verdict is `revise` | `accept`, `skip`, and guard errors never extend — the bridge only serves "the guard knows what is missing" |
| `extensionAllowed` **and** the budget gate | the same counters the mid-run extension reads (`extensionCount < reflection.maxExtensions && effectiveMaxRounds < reflection.maxRoundsCap`), plus: refuse when the last real API input already exceeded `context.budgetTokens` (`isApiInputOverBudget` (`src/loop/budget.js`)), or when the per-round aggregate output budget already archived/stubbed a tool result in this run (`src/loop/aggregate-budget.js`). Extending an over-budget run would tear the budget promise |

Cost and observability:

- **one extension per run** (`governorState.guardExtensionUsed`), independent of the
  governor's own extension quota — the guard never gets a second "go more" budget;
- the quota is **persisted in run state** (`deterministic.guardExtension.used`,
  `src/run-state.js`, restored by `src/loop/resume-manager.js`) and is **not reset by
  resume**: "run → crash → resume" must not mint a fresh quota every time. Older states
  without the field read as "not used";
- new event `{ type: "final_guard_extend", round, from_max_rounds, to_max_rounds, guard_extension: true }`,
  and `verification.metrics.guard_extensions: 1` — **only** when a bridge actually ran. A run
  that never opts in (or opts in and never bridges) keeps today's `verification` /
  `metrics` byte for byte;
- the extension happens **after** the forced wrap-up of the stop that triggered it, so a
  bridged run's `termination` may carry `forcedFinal: true` even when it ends `end_turn`
  (the forced wrap-up did run; the run then continued). The bridge never rewrites
  `termination.reason` values and never introduces a new stop reason.
- if that stop left a **pending `tool_use`** on the last assistant message — the forced wrap-up
  round answered with a tool call instead of text — the bridge first closes it with an
  engine-written `tool_result` (`is_error: true`, content is
  `PENDING_TOOL_RESULT_TEXT` (`src/loop/pending-tool-result.js`), starting with the `[erix]` marker)
  and only then injects the control text (issue #393). The injected user message must never
  split a `tool_use` from its result, or the library's own message validator throws locally
  with `invalid_messages` **before a single request leaves the process** (measured 2026-10-22:
  zero HTTP; the rule is the stricter of the two protocols this library speaks — an
  Anthropic-shaped upstream answers 400 for this shape, while an OpenAI-compatible relay answers
  200 and lets the model invent the outcome), and the host receives `termination: failed`. That `tool_result` reports a
  fact ("this call never ran"), so the call itself is **not** executed; a tail whose `tool_use`
  ids cannot be read is not repairable and is **not** extended — the run degrades exactly as
  without the bridge.
- **the same repair runs before every engine-written control message, not only on the bridge**
  (issue #394). Two other injection points had the same hole: the **forced wrap-up**
  (`forceFinalIfNeeded` (`src/loop/termination.js`), whose `【强制收尾】` instruction used to be
  pushed *before* validating the message order) and the **`revise` continuation message**
  (`applyGovernorExtension` (`src/loop/orchestrator.js`) covers the extension path; the
  post-stop `revise` message is the sibling). All three now call one shared implementation,
  `answerPendingTailToolUses` (`src/loop/pending-tool-result.js`), which reuses the pairing
  criterion `pendingTrailingToolUses` (`src/messages/rounds.js`) and the single result builder
  `buildToolResultFact` (`src/tool-fact.js`). So a run whose last assistant message carries an
  unanswered `tool_use` — a **truncated tool-call round**: the provider answered
  `max_tokens` / `finish_reason: "length"` with a `tool_calls` / `tool_use` block, and the
  continuation budget ran out — now reaches its real terminal state instead of
  `failed` / `invalid_messages`. **Behaviour change:** such a run used to be rejected with
  `termination: { reason: "failed", errorCode: "invalid_messages" }` (CLI exit code **1**) and
  **lost its final text**; it now ends `continuation_exhausted` with `finalText` populated (CLI
  exit code **4** when no `finalGuard` is configured, because `verification` is still
  `skipped` / `no_final_guard`), plus one extra engine-written `tool_result` and one
  `:control:` transcript row. That `tool_result` again only states a fact — the call is **not**
  executed, and the model may re-issue it; a tail whose `tool_use` ids cannot be read is **not**
  settled, so the run reports `invalid_messages` exactly as before. A host that treats
  `failed` (or exit code 1) as "retryable" must re-read those runs: they now finish.


The engine has no separate "delivery authentication" or "completion
authentication" layer. It reports facts such as rounds, tools, file calls,
archives, termination, and verification. Whether the task is complete,
whether the deliverable meets its requirements, and whether it may proceed
automatically downstream remain decisions for the host, test system, or human
review.

### The `finalGuard` payload: 7 contract keys plus 10 additive facts (issue #386)

`callFinalGuard` (`src/loop/termination.js`) assembles the payload. The seven keys listed
above (`finalText`, `findings`, `messages`, `round`, `rounds`, `signal`, `termination`) are
the original contract: their names, types, **order**, and values are unchanged. Ten
**additive** keys follow them. Each one is written only when the engine can actually read
that fact — absence is the "not probed / not provided" signal, and it is never faked with
`null`, `0`, `""`, or `{}`:

| Key | Type | Meaning | Bound |
|---|---|---|---|
| `cwd` | string | the `cwd` the host passed to `runToolLoop`, verbatim | none — the engine never interprets it (no `chdir`, no existence check, no path joins) |
| `runId` | string | the `runId` the host passed, verbatim | none |
| `filesWritten` | `[{ path, round }]` | write-tool calls recorded in the run's timeline ledger | **last 50** entries; older ones are dropped and `filesWrittenTruncated: true` is set |
| `fileWrites` | `[{ path, round, tool }]` | write-tool calls with the **raw** `tool_use.input[pathKey]` value (issue #388): not summarized, not truncated, safe to `stat()` | **last 50** entries (`FILE_LEDGER_LIMIT`, the same constant the engine's ledger uses); older ones are dropped and `fileWritesTruncated: true` is set |
| `toolStats` | `{ [toolName]: { calls, failures } }` | the run's tool counters, as a **plain object** (`JSON.stringify(new Map())` is `{}`, so a raw `Map` would reach you empty) | **top 40** tool names by `calls`; `toolStatsTruncated: true` |
| `taskBrief` | string | the brief `resolveTaskBrief` (`src/loop/task-brief.js`) produced for this run — the same text the judge and wrap-up see | 2000 code points; `taskBriefTruncated: true` |
| `selfReport` | `{ done, summary, output, findings }` | the model's **last normalized** wrap-up envelope (the LLM-normalized copy when normalization ran; never re-parsed from prose) | `summary` and `output` 2000 code points each; `selfReportSummaryTruncated` / `selfReportOutputTruncated` |
| `usage` | `{ input_tokens, output_tokens, cacheRead?, cacheWrite? }` | run-cumulative usage, the same object the result carries | none |
| `elapsedMs` | number | wall-clock milliseconds since the loop started | none |
| `attempt` | number | which guard call this is, **1-based and monotonic** across `revise` retries | none |
| `guardBudget` | number | the `finalGuardMaxRetries` in force for this run | none |

Four properties of this surface are worth stating explicitly, because they are the ones a
host is most likely to get wrong:

- **`selfReport.findings` is the same object as `findings`.** There is no path where
  `findings` has a value while `selfReport` lacks the key: the builder injects the payload's
  own `findings` into `selfReport`, so the two can never diverge. When the envelope declared
  nothing, **neither** carries the key.
- **`filesWritten[].path` is a summarized argument, not a canonical path.** It comes from the
  judge timeline (`summarizeArgument`（`src/reflection/judge.js`）), which caps it at 40 code
  points **without** a truncation marker. Treat it as a hint ("this run wrote something that
  starts like this") and verify against the filesystem, the tool results in `messages`, or
  `cwd`; do not use it as a join key. **Use `fileWrites[].path` when the answer must be exact**
  (issue #388): it is the raw input value, so `stat()`/`existsSync()` on it is meaningful,
  while the summary is not (a >40-code-point path is cut with no marker, and a criterion built
  on it rejects runs that already did the work).
- **`filesWritten` and `toolStats` are always present in a `runToolLoop` run** (an empty
  array / empty object means "the run recorded nothing", which is itself a fact). `cwd`,
  `runId`, `taskBrief`, and `selfReport` are present only when there was something to report.
- **The overhead is bounded and measured.** `node scripts/final-guard-probe.mjs` runs a
  30-round × 4 KB-tool-output scenario offline: `messages` is 257,618 bytes, the additive
  keys are 4,789 bytes — **1.86%** (2,242 B before `fileWrites` was added in issue #388),
  against a budget of < 2%. A host can therefore log or
  queue the whole payload without a size panic, and a guard can read the facts instead of
  re-parsing the transcript (a small run's `messages` is 611 bytes; a real one is tens of
  KB to MB).

**Authority precondition: `verified` is only as strong as the guard's evidence.** An `accept`
must rest on an **independent fact** — a file on disk, a command's exit code, a store row —
never on `finalText` being non-empty. The probe pins the counter-example as a scenario
(`S6a`): a guard that accepts whenever `finalText.trim() !== ""` returns `verified` for a run
whose declared deliverable **does not exist**, while the identical lying script under a
disk-checking guard is caught at `attempt: 1` and remediated at `attempt: 2`. The trap now has
a second cell (`S6b`): the same rubber-stamp guard plus a declared `deliverables` criterion
returns `unverified` / `deliverables_failed` — the machine gate, not a better prompt, is what
stops it (see the next section). All of it runs in `node scripts/final-guard-probe.mjs` with
zero model calls, so the trap is reproducible rather than folklore.

### Deliverable checks: the host-declared machine gate (issue #386 slice 2)

`deliverables` lets the **host** declare what "delivered" means, while the **engine** owns
two things: *when* the declaration is checked, and *what a failure costs*. This is the
answer to the rubber-stamp problem — a guard that accepts whenever `finalText.trim() !== ""`
can no longer turn a missing deliverable into `verified`.

Option shape and validation (every violation throws `TypeError` **before** the run starts,
same convention as the other options):

```text
deliverables?: [
  { name: string (non-empty, unique within the run), check: (facts) => boolean | {ok, detail?} | Promise<…> },
  … at most 20 entries …
]
```

- `deliverables` is optional; at most **20** entries; `[]` is treated as **not declared**
  (zero criteria is no criteria, so it behaves exactly like omitting the option).
- `name` must be a non-empty string and unique within one run.
- `check(facts)` may be sync or async. `facts` is the **same object the guard is about to
  receive** — the `buildFinalGuardPayload` output described above, so at least `cwd`,
  `fileWrites`, `filesWritten`, `toolStats`, `taskBrief`, `selfReport`, `findings`,
  `finalText`, `attempt`, `rounds`. It never contains `deliverables` itself (no
  self-reference).

Two fail-closed rules, fixed by contract — a broken or hanging criterion must **block**, not
pass:

| `check` outcome | Recorded result |
|---|---|
| returns `true` | `{ ok: true }` |
| returns `false` | `{ ok: false }` |
| returns `{ ok: boolean, detail? }` | carried over verbatim |
| returns anything else (a string, a number, `{ ok: "yes" }`, `undefined`) | `{ ok: false, detail: "invalid_result" }` |
| throws | `{ ok: false, detail: "threw" }` |
| runs longer than `finalGuardTimeoutMs` | `{ ok: false, detail: "timeout" }` |

The timeout reuses `finalGuardTimeoutMs` — there is **no** separate `deliverablesTimeoutMs`
knob, and the timer is per criterion (one slow criterion cannot make the next one look slow).

**Timing: checks run before *every* guard call**, not once per run. A `revise` decision is
therefore followed by a fresh computation on the next `attempt`, so a model that actually
remediates reaches `verified` and one that only re-words its claim does not.

Results reach both surfaces, and only when the host declared something:

- payload: `deliverables: [{ name, ok, detail? }]` plus `deliverablesAllPassed: boolean`.
  The guard sees them, so a well-written guard can weigh machine evidence instead of prose.
- `verification.metrics`: `deliverables_checked` / `deliverables_failed`, cumulative across
  guard calls, next to the existing `verified` / `skipped` / `revised` / `unverified` /
  `guard_error` counters (whose meaning is unchanged), plus `deliverables_machine_only`, which
  appears **only** when the criteria alone produced a `verified` (guard `skip`, issue #392).

The gate itself — the ruling this option exists for. It holds under **every** guard verdict, not
only `accept` (issue #392): `skip` means "this guard could not check", never "the deliverable
was not delivered", so the machine verdict outranks it in both directions.

| Deliverable result | Guard verdict | `verification.status` |
|---|---|---|
| all passed | `accept` | `verified` — as before, plus the two counters |
| **any failed** | `accept` | **`unverified`, `reason: "deliverables_failed"`** — machine evidence outranks the guard |
| **any failed** | `skip` | **`unverified`, `reason: "deliverables_failed"`** — evidence outranks "I could not check" |
| **all passed** | `skip` | **`verified`, `reason: "machine_only"`** — the machine criterion *is* the acceptance, and it is labelled as such |
| **any failed** | guard error / timeout | **`unverified`, `reason: "deliverables_failed"`** — a decided "no" beats an unknown |
| all passed | guard error / timeout | **`error` — deliberately not upgraded** (see the boundaries below) |
| any failed | `revise` | unchanged from today (retries exhaust into `unverified`, `non_continuable` on budget stops) |
| not declared | any | **byte-for-byte unchanged**: no payload key, no metric key, no event field |

`reason: "machine_only"` is the one thing a host must read literally: it means **the engine
accepted the run on the host's own criteria**, *not* that the guard judged it. If your policy
requires the guard itself to have passed, treat `machine_only` as "my guard skipped — tighten
the criteria or the guard", because that is exactly what happened. The counter
`metrics.deliverables_machine_only` (present **only** in that cell) is the same fact in
aggregate form, and `metrics.verified` deliberately does **not** move there: it counts guard
`accept` verdicts, whose meaning is unchanged.

Because `machine_only` is `verified`, a CLI run that declares criteria and whose guard skips
exits **0** instead of **4** when the criteria pass, and **2** when they fail.

Before this change the two surfaces contradicted each other: a run whose criteria had already
**failed** still exited **4** ("nobody checked") and printed the plain `=== 终稿 ===` title,
while the run's own metrics recorded `deliverables_failed: 1` — the machine had decided, and
the exit code a CI job reads said it had not. The pair measured on this machine before the
fix is `4` / `4` (criteria passing / failing); after it, `0` / `2`.

**Hosts that do not declare `deliverables` are untouched.** Without the option there is no
machine verdict to outrank anything: a guard `skip` still yields
`{ status: "skipped", reason: <the guard's own skip reason> }`, the CLI still exits **4**, and
no payload key, metric key or event field appears. That is also the class the engine's own
release smoke belongs to — `npm run check:release` runs a `chat` **without** criteria and
asserts exit **4**; it must keep exiting 4, and it does.

Four boundaries are deliberate:

- **`termination.reason` is not rewritten.** The gate changes `verification` only; it
  introduces no new stop reason, and the existing `final_guard_unverified` path (retry
  limit, non-continuable degradation) is untouched.
- **A guard error plus passing criteria stays `error`.** A guard that throws or times out is
  an **infrastructure failure** (a broken callback, a dead dependency), and upgrading it to
  `verified: machine_only` would let one machine criterion paper over a run whose guard face
  never ran — the host would read "at least the machine checked it" while the failure it
  should fix stays hidden. The asymmetry is intentional: a failing criterion still wins
  (`unverified`), because "the machine says no" is a decided answer, while "the guard is
  broken" is not.
- **Non-continuable stops still check once, and still degrade.** For `max_rounds_cap`,
  `stall`, and `continuation_exhausted` the criteria run once and the result is recorded,
  but a `revise` stop keeps its existing `non_continuable` verdict. The gate adds a label, it
  does not invent a stop.
- **The event gains one field.** A `type: "final_guard"` event carries
  `deliverables_failed: <n>` (present only when criteria were declared) and, in the
  machine-only cell, `machine_only: true` — its `action` stays `"skip"` and its `reason` stays
  the guard's own skip reason, so a host can observe the gate without reading metrics. Every
  existing event field is unchanged.

Which path key to use in a criterion: `fileWrites[].path` is the raw
`tool_use.input[pathKey]` value (verbatim, safe to `stat()`), while `filesWritten[].path` is
the 40-code-point judge-timeline summary (a hint only — see the payload table above). A
criterion built on the summary will systematically reject runs that already did the work.

**The hosts that ship here expose *named* criteria, not predicates (issue #391).** The CLI
(`erix chat` / `erix repl`) has `--require-deliverable [<path>]`, and the pi extension has
`requireDeliverable: true` plus `deliverablePaths: string[]`. Both factories live in
`bin/final-guard.js` — `createDeliverableChecks` (`bin/final-guard.js`) produces
`files_written_exist`, and `createNamedDeliverableChecks` (`bin/final-guard.js`) produces one
criterion per declared path. Neither host accepts a host-supplied `check` function: a function cannot cross the extension/tool boundary safely
(pi serializes `details` and `structuredContent`, and the extension loader is not a data
channel), so the surface only chooses *which named criteria* run.

**Two semantics, both kept on purpose.** They answer different questions, so neither is a
refinement of the other:

| Declared as | Question it answers | Criterion | Model declares nothing |
|---|---|---|---|
| `requireDeliverable: true` (bare `--require-deliverable`) | "is everything **you said you wrote** still on disk?" | `createDeliverableChecks()` reads `fileWrites` | **passes** (empty set ⇒ `every()` is vacuously true) |
| `deliverablePaths: [...]` (`--require-deliverable <path>`) | "are **the files this task demanded** on disk?" | `createNamedDeliverableChecks(paths)` reads the host's list | **fails** (the criterion never looks at what the model said) |

The boolean one is a "did not lie" criterion, not a "did the work" criterion: a run that
called **zero tools** declares no write paths, so the criterion passes and `verification`
becomes `verified` (measured in the issue #391 reply). "This task must deliver `report.md`"
can only be expressed by a named path. Conversely the named form cannot replace the boolean
one — an exploratory task does not know the file names up front, yet "don't claim you wrote A
and then lose A" still needs checking — so a host may declare both (they add up, and the
combined count is capped at `DELIVERABLES_LIMIT`).

Four consequences worth knowing:

- **Neither is standalone.** A criterion gates the guard's `accept`, and the engine runs
  criteria only when a `finalGuard` exists — so `--require-deliverable` without
  `--final-guard` (and `requireDeliverable` / `deliverablePaths` without
  `finalGuard: true`) is a **usage error**, not a silent no-op. In the CLI that combination
  changed from `exit 4` to `exit 1`.
- **`cwd` is the host's job.** A criterion that resolves a relative path against `cwd`
  receives `undefined` unless the host passed `runToolLoop({ cwd })`; the engine never fills
  it in, never `chdir`s and never checks that it exists — the criterion then fails closed
  (`ok:false`), which is exactly the #391 symptom. `erix chat --cwd <dir>` (default: the
  process working directory) and `erix_run`'s required `cwd` parameter are that wiring.
  Absolute paths do not need `cwd`.
- **Criteria and the guard share one budget.** Both are bounded by `finalGuardTimeoutMs`,
  and the criteria run *before* the guard on every attempt, so a host that sizes its hard
  abort by "3 × timeout" must add one timeout per declared criterion (one criterion ⇒
  3 × (10s + 10s) = 60s with the pi extension's 10s; N criteria ⇒ 3 × (10s + N × 10s)).
- **Known limit of the boolean form.** `fileWrites[].path` is the raw path the model passed.
  If it was relative and the host's `cwd` differs from the process working directory, the
  existence check resolves against the process cwd and can false-negative. Use a named path
  when a specific file must be on disk.

### Host-side guard wiring and the deadline tail (issue #314)

The pi host extension (`examples/pi-extension/erix-run-core.js`) carries a
`finalGuard` switch. It is **off by default**: with the switch off, the
extension hands `runToolLoop` an options object without a `finalGuard` key at
all (not one holding `undefined`), so `verification` stays
`{ status: "skipped", reason: "no_final_guard" }` and `end_turn` remains a claim
rather than a proof. Pass `finalGuard: true` and the loop receives the callback
plus an **explicitly small** `finalGuardTimeoutMs` (`FINAL_GUARD_TIMEOUT_MS`,
10000) instead of relying on the engine default of 30000.

The timeout has to be explicit because of where the guard sits. The engine only
consults the run deadline at round boundaries (`remainingMs`（`src/loop/orchestrator.js`）); there is no deadline check between the stop
decision and the guard call. A host sitting on top of the loop also owns a hard
abort timer (`runErixRun`（`examples/pi-extension/erix-run-core.js`）). With the
engine default, one guard call plus up to `finalGuardMaxRetries` revisions can
wait `3 × 30000` ms *after* the host timer has already expired: the tokens are
spent and the verdict is aborted away. The extension therefore both lowers the
per-call budget (`FINAL_GUARD_TIMEOUT_MS`（`examples/pi-extension/erix-run-final-guard.js`）) and pushes its own hard abort later by
`FINAL_GUARD_WORST_CASE_MS`（`examples/pi-extension/erix-run-final-guard.js`） (= 3 × 10000 ms), leaving the
run deadline it hands to the engine untouched.

Worst case cost of enabling it: **up to 2 extra model round trips** (the engine
`finalGuardMaxRetries` default) plus **up to 3 guard waits** bounded by
`finalGuardTimeoutMs`. Costs land in the host payload as
`diagnostics.finalGuard` (calls / elapsed ms / `reviseRounds` / declared and
untraceable bases / derived-conclusion reminders), next to the compaction and
notes layers; the engine's own counters stay on `verification.metrics`
(`guardMetrics`（`src/loop/orchestrator.js`）). A host must not read its own
counters as the engine's, so both carry a `source` field.

The extension's predicate (`inspectFinalDraft`（`examples/pi-extension/erix-run-final-guard.js`）) is deliberately narrow: a
four-section terminal draft (`FINAL_DRAFT_SECTIONS`（`examples/pi-extension/erix-run-final-guard.js`）, also appended to the system
prompt only when the switch is on), plus **one** hard gate — every literal
declared under the base-section heading must appear verbatim in a
`tool_result` block of *this* run (`collectToolResultText`（`examples/pi-extension/erix-run-final-guard.js`）). Anything else
(ratios, percentages, "total" claims) is reported, never rejected. No branch
returns `accept` when a declared base cannot be traced: at the retry limit the
loop ends as `final_guard_unverified` with `verification.status` `unverified`
(`max_retries`), which is a pass for the fail-closed rule, not for the answer.

### NotesStore interface, scope, and write contract (0.12.0)

The `NotesStore` port has six required methods:

```text
write, read, list, complete, revoke, purge
```

`createBuiltinNotesTools` validates them at assembler creation time via
`assertNotesStore` — a store missing any method throws `TypeError` before the
first run starts, instead of silently falling back to an implicit file store.
`write`/`read` are the run-scope record read/write pair; `list` returns a
plain array of matching records; `complete` and `revoke` are the lifecycle
methods; `purge` is the maintenance method described in
[Notes maintenance scheduling](#notes-maintenance-scheduling-0120).

`list()` returns `NoteRecord[]`, not a page object:

```js
const records = await store.list({
  scope: "run",
  scopeRef,
  // optional:
  limit,    // only when given: clamped to a maximum of 200; omit = all matches
  filters,  // { state, tag, source, minRelevance }
  sort,     // "relevance" | "pinned_updated" (stable comparisons, no localeCompare)
});
```

Without `limit`, every matching record is returned — the internal consumers
(`complete`, and host-built cleanup loops) rely on that full-collection
semantics. There is
no cursor, no `cursor_stale` status, and no scope revision protocol: a
maintainer review of real usage (average ~2 notes per run, peak 9) judged
pagination and version anchoring YAGNI for 0.12.0 (ADR-018 D3 reversal). `purge` has no pagination protocol — one call scans and processes every
scope (see [Notes maintenance scheduling](#notes-maintenance-scheduling-0120)).

An explicit `limit` is validated, then clamped (`src/store/notes-port.js:246-253`,
issue #183 item 5): a value that is not a positive safe integer — `0`, `-1`,
`1.5`, `NaN`, `2**53`, a string — throws `TypeError` before anything is read,
while any value above 200 is clamped down to 200 instead of erroring. The
contract suite now pins both halves against more than 200 stored records, so a
host that silently coerces `limit: 0` to `1`, or that returns 5000 records for
`limit: 5000`, goes red.

The file-backed `NotesStore` canonicalizes each `scopeRef` exactly at the
adapter boundary. Unsafe scope references such as `../escape`, absolute paths,
and encoded separators are mapped to a stable `run-h-...` directory; the same
canonical value is used for the directory and persisted `record.scopeRef`.
Hosts and skills must pass the original logical scope reference to the adapter,
not pre-canonicalize it. Existing directories whose scope reference is already
in canonical hashed form remain readable and participate in list, complete,
revoke, and purge operations.

The file adapter assumes one writer per scope/key. Concurrent read-modify-write
updates can lose one update and its superseded history (last-write-wins). This
one-writer rule is a property of **this adapter**, not of the port: a store that
rejects the losing side of a concurrent same-key write (compare-and-swap) is a
legal `NotesStore` implementation, and the shipped contract suite no longer
requires both concurrent writers to succeed — the last-write-wins assertion lives
in the file adapter's own test tree, and a compare-and-swap host registers the
optional `notesStoreCasContract` sub-suite instead (see
[Contract test suites](#contract-test-suites-issue-183)). Hosts that need
concurrent updates on the file adapter must serialize them at the host boundary;
the adapter does not add a lock or another concurrency mechanism. `revoke`
carries this one step further at the API level: an `expectedState` /
`expectedUpdatedAt` guard makes a revoke that raced with another writer return
`{ status: "unchanged" }` instead of overwriting a record it did not see.

What `revoke` promises is that the record **stops being observable** (issue #183
item 3, ruling B). After a `{ status: "found", revoked: 1 }` result a record must
no longer be readable as an active note: `read()` either returns a
`state: "revoked"` tombstone or returns `undefined` because the store deleted the
record outright, and both shapes are legal. What stays fixed is the guard
behaviour, not the storage form: a revoke against a key that is not there answers
`{ status: "missing", revoked: 0 }`, and a repeat revoke never counts a second
revocation (a tombstone store answers `unchanged`, a deleting store answers
`missing`). "A tombstone can never be revived" was never a current promise —
nothing in the engine consumes the `revoked` state, so a host that physically
deletes on revoke is not weaker, and no host may read "the row is still there"
as a guarantee.

Two scope topologies are legal and both are load-bearing (issue #183 item 7).
Interface-level multi-scope is a hard capability: every request carries its own
`scopeRef`, one store instance serves many scopes, and `purge` is the only method
that sweeps across them (it ignores `scopeRef`). Instance-level fixed scope is
equally legal: the official assembler `createBuiltinNotesTools` binds one logical
run scope at creation time (`src/tools/notes.js:627`) and every view reuses that
binding, so a host that
runs one store instance per tenant/expert against a shared multi-scope database
matches the upstream shape rather than deviating from it. To run the contract
suite against a fixed-scope host port, adapt at the factory: hand the suite a
factory that resolves the requested `scopeRef` to the instance bound to that
scope (create-on-demand is fine) instead of ignoring the field — assertions that
name two scopes (`other-run`, the canonicalized `run-h-...` forms) are exactly
the ones a factory that drops `scopeRef` will fail for the right reason.

Record time fields are normalized on every read: a record missing `updated_at`
falls back to `created_at`, and a record missing both gets the fixed
`1970-01-01T00:00:00.000Z` epoch (the adapter never fabricates "now" for a
record it did not write). `normalizeNoteRecord()` (exported from
`src/store/notes.js`) is the shared fallback used by the adapter read/list
exit and by the tool layer for injected stores.

### Notes tool registration

The canonical note tool implementation is `src/tools/notes.js`. A headless host
can call `createBuiltinNotesTools({ notesDir, notesStore, runId })` from the
package root or from `erix-agent/tools` (Tier 2 host integration). The factory
is a full assembler: it binds the logical run scope, the notes directory
(`notesDir` ?? `ERIX_NOTES_DIR` ?? `~/.erix/notes`), and a single `NotesStore`
instance at creation time, and every returned view reuses them while forcibly
overriding any caller-forged `__erix` injection. The returned object contains:

- `definitions` — the four `note_*` schemas;
- `resolveTools` — the registry schema-resolution view; hosts that need a
  `ToolProvider` shape (e.g. for `createCompositeToolProvider` aggregation)
  build it themselves:
  `createStaticToolProvider({ sets: { default: notes.definitions } })`;
- `executors(name, input, context)` — the registry positional view;
- `executeTool({id, name, input, context, signal})` — the structured view that
  matches the `runToolLoop` / run-snapshot-executor calling convention (the
  positional `executeTool(name, input, context)` form is retained for existing
  callers);
- `lifecycle` — a single completion hook (0.12.0). `onRunComplete` only
  calls `completeRun` (active → done) and returns `{ completed, errors }`.
  Completion errors are collected into the returned `errors[]` instead of
  throwing over the primary error. It accepts an optional
  `reportPersistenceFailure` reporter in its input
  (`onRunComplete({ reportPersistenceFailure })`); when injected, store
  failures during complete are reported through it exactly like tool
  execution failures. There is no `onRunStart` hook and no engine-side
  liveness: run start performs zero notes maintenance. Calling it with no
  arguments (as in the example below) keeps the previous behavior — failures
  surface only through the returned `errors[]` or the thrown error;
- `semanticStateProvider` — the ADR-015 fold-point notes directory (active
  only, max 20, pinned first then `updated_at` order, version echoing
  `state.stateVersion`). Its payload accepts an optional
  `reportPersistenceFailure`; when provided, a failed store list is reported
  through it (the provider still returns `undefined` in that case).

Typical wiring with an explicit try/finally:

```js
const notes = createBuiltinNotesTools({ runId, notesDir, notesStore });
try {
  return await runToolLoop({
    /* ... */
    tools: [...hostTools, ...notes.definitions],
    executeTool: async (execution) => {
      if (notesToolNames.has(execution.name)) {
        return notes.executeTool(execution);
      }
      return hostExecuteTool(execution);
    },
    semanticStateProvider: notes.semanticStateProvider,
  });
} finally {
  const { errors } = await notes.lifecycle.onRunComplete();
  for (const failure of errors) {
    hostReportCompletionError(failure.operation, failure.error);
  }
}
```

Notes write failures are reported through the engine's generic host-persistence
bridge (`context.reportPersistenceFailure`, `port: "notes"`); they are never
silently swallowed. The host remains responsible for choosing and injecting the
`NotesStore` and logical run scope.

Active orphan cleanup is entirely the host's: the engine has no liveness
knowledge. A host that wants to reclaim dead scopes' active notes builds the
three-line loop itself with the public primitives — `store.list({ filters:
{ state: "active" } })` + `store.revoke({ ..., expectedState, expectedUpdatedAt
})` — driven by the host's own knowledge of which scopes are alive (scheduler
state, process table, last heartbeat). The `expectedState` / `expectedUpdatedAt`
guards absorb the stale-read window between the host's list and revoke; a host
without such a loop never reclaims active orphans automatically (accumulation
is preferred over a wrongful kill).

**Note provenance is caller-reported metadata, not fact.** The `provenance`
fields on a note record other than `source` — `verified`, `toolUseId`, `round`
— are self-reported by the caller and can be forged; they must never be used as
an authorization input or as the basis of any guard. Ground truth about what
the run actually did is the archived transcript (`toolOutputs`, ADR-016), not
any field on a note record.

The CLI's bundled `skills/notes/skill.mjs` was retired in v0.11.0 (issue #61),
together with the assembler's alias keys: notes are delivered exclusively
through `createBuiltinNotesTools`, and `erix skills` no longer lists a bundled
notes skill (user/project skill discovery is unchanged). Legacy third-party
skill loaders should import `src/tools/notes.js` or the `erix-agent/tools`
subpath directly; the bundled notes shim's own `getSkillDefinition` export
(`getNotesSkillDefinition` on the `erix-agent/tools` subpath) was removed with
the shim — the generic skill loader still supports `getSkillDefinition()` for
third-party skills. It was never a second implementation or a portable standalone
copy; portable integrations should use the npm package entry point.

### File tool registration

The canonical file tool implementation is `src/tools/file-tools.js`. A headless
host can call `createFileTools({ cwd, allowRead, allowWrite })` **only** from the
`erix-agent/tools` subpath: it is **not** exported from the package root (ADR-005
Layer Two — "it is not part of the main export"; `package.json` `exports` maps
only `.` / `./tools` / `./contract-tests`, no deep path), which is the Tier 2
host integration. The library ships no
jail: the two predicates are the whole boundary surface, and both default to
`() => true`, which reproduces the historical `path.resolve(cwd, value)`
behaviour exactly — no containment, no safety promise (ADR-009 keeps the cage on
the host side). The library resolves every path itself and hands the
**absolute** path to the predicate, and it consults the predicate **per entry
during traversal**; that per-entry hook is exactly what a host cannot build by
wrapping `executeTool` from the outside.

The returned object contains:

- `definitions` — the seven `readFile` / `searchText` / `rg` / `grep` / `tree` /
  `edit` / `writeFile` schemas (the count is asserted by the contract suite
  `fileToolsContract`, `test/contract/file-tools.js`: `searchText` was added in
  issue #195 and `edit` in issue #191). Tool names and existing input fields (`offset`/`limit`/`path`/
  `pattern`/`glob`/`is_regex`/`max_results`/`maxResults`/`depth`) are unchanged,
  so registering this factory is a zero-migration change for a host that already
  shipped the CLI's copies — **with one behavioural caveat**: `rg`'s `is_regex`
  defaults to `true` (issue #184 round A, aligned with the real `rg` command),
  whereas the CLI's retired copy treated an omitted `is_regex` as a literal
  match, so a host that carried that default will see different hits (see the
  defaults list below); new parameters are snake_case, and both search-limit
  spellings (`max_results` and `maxResults`) are accepted by both search tools;
- `executeTool({id, name, input, context, signal})` — the structured view that
  matches the `runToolLoop` / run-snapshot-executor calling convention (the
  positional `executeTool(name, input, context)` form is retained for existing
  callers). A `signal` carried at the top level is folded into
  `context.signal`; traversals yield to the event loop every 32 entries **only
  when a signal is present**, so the non-abortable path keeps its previous cost
  and behaviour;
- `executors(name, input, context)` — the registry positional view, used by the
  CLI, which assembles its own `exec` and `todo_*` tools next to it (ADR-005
  keeps "a tool that executes" out of the library).

**Boundary semantics are Stable.** `allowRead` returning `false` for a traversal
entry makes the tool skip that entry and count it in the exclusion account
appended to the result; for `readFile`, and for a denied traversal root, the tool
returns an error result text (`错误：…`) instead of throwing. `allowWrite`
returning `false` likewise returns an error result text — no exception, and the
library introduces no error type of its own. Hosts may code against the
predicate signature `(absolutePath: string) => boolean` and against the
"false → error result, never a throw" rule; they must not code against the
wording of those error texts.

**Marker literals are Experimental** (issue #188 three-tier classification, may
change in any minor release). Every "skipped / truncated / no-match" string — the
`[已跳过 …]` exclusion account, the `[另有 N 条未列出 …]` and
`[另有 N 个目录未展开 …]` tree markers,
`[共 N 行（文件 <size>），剩余 M 行；下一步：readFile 传 offset=K 继续]` (the `<size>` segment is
that file's real size rendered by `formatSize()` — issue #267 added it, because a line count on its own
cannot answer "will what is left fit in one more call"; inside one result it never sits next to a raw
byte count), and the
`（无命中）` no-match result — is produced by a single marker function inside
`src/tools/file-tools.js` (the executors pass semantic values, they never build
bracketed strings themselves), which is why the wording can move without touching
five call sites. A host that needs a stable signal must branch on the tool
result it receives, not on a marker substring.

**A truncation marker must name an executable way out** (issue #196 R1). Reporting
that something was cut is only half the job: search `metadata` goes to the transcript
but never onto the wire, so the marker text is the only channel the model can read,
and a marker without an exit leaves it guessing a number. Every read/search
truncation marker therefore ends with a `；下一步：<tool> 传 <参数>=<值>` clause
carrying **this call's** values — the `offset` to hand the next `readFile` after a
line-window or `max_bytes` cut, the truncated line's **line number plus file path**
for an over-wide line, and the continuation `offset` after a capped search. The tool
names a marker may use are limited to this module's own (`readFile` / `searchText`):
`exec` belongs to the CLI assembly layer (`bin/tools.js`) and ADR-005 keeps
"executes something" out of the library, so naming it would hand the model a cheque
this library cannot cash — a tightening relative to the original issue text.
Two follow-up details (issue #196, second round): an over-wide line is reported even when
it never crossed a read block — a long line that fits inside one 64 KiB block is dropped
**whole** rather than half-returned, and the byte-cap `offset` is pinned to "the next
unread whole line", so following it walks straight past that line and its remainder is
unreachable; the two markers therefore appear in a fixed order (byte cap first, then the
clipped line's own line number / `offset` / path / file size) and the byte-cap wording
must not claim the content is complete. Second, the `rg` / `grep` aliases now quote the
same continuation number as `searchText` — this call's hit count, the very value
`metadata.searchNextOffset` carries — while still not accepting an `offset` parameter:
giving the number and taking the parameter are different promises.

**Byte quantities inside a result are human-readable** (issue #196 R2).
`formatSize()`, exported next to `toolMarker()` from `src/tools/file-tools.js`,
renders `B` / `KB` / `MB` / `GB` / `TB` on a 1024 base (`262144` → `256KB`,
`1572864` → `1.5MB`, `1536` → `2KB`, `1073741824` → `1.0GB`, `1649267441664` → `1.5TB`);
rounding that reaches `1024` **of the rendered value** promotes to the next unit, so no
output ever reads `1024.0MB`, and `1e12` is `931.3GB` rather than the six-digit
`953674.3MB` the MB-only version produced — a six-digit number with a unit is the same as
no unit at all (issue #196 follow-up). A result never shows the human-readable value next
to the raw byte count — two numbers for one quantity is a ledger the model cannot reconcile.
Thresholds stay raw in this document and in `metadata`, where there is no second copy
to contradict them.

**Export-surface caveat for these two helpers.** `formatSize()` and `toolMarker()`
are **module-level exports of `src/tools/file-tools.js`** — the wording above
describes the module, not a public API. They are **not on the public `exports`
surface**: `package.json` maps only `.` / `./tools` / `./contract-tests` (no deep
path), and the `erix-agent/tools` barrel does not re-export them either, so a host
consuming the npm package **cannot import them today**. Render the same values
yourself if you need them; promoting the two helpers onto `erix-agent/tools` is a
possible follow-up (an additive minor), and until then nothing in this paragraph
is an import promise — and the marker wording itself remains Experimental (see
above), so read the structured `metadata` fields instead of parsing marker text.

Defaults a host must know about, because they change what the model sees
(ADR-010: default denoising is legal only while it stays revocable):

- `rg` / `grep` / `tree` skip `node_modules`, `dist`, `build`, `target`,
  `vendor` and dot-directories (`.git` included) unless `include_vendor=true`
  / `include_hidden=true`, and state the skipped counts at the end of the
  result together with the switch names that undo them. The account names **the
  categories actually skipped this call** (vendor directories / hidden
  directories, each with its own count and a sample of the real directory names)
  and never a category whose count is zero; the switch hint only lists flags the
  caller has **not** set yet, so a call that already passed
  `include_vendor=true` is never told to pass it again (issue #222: the old fixed
  wording `node_modules/.git 等 N 个目录` plus an unconditional
  `include_vendor=true, include_hidden=true` hint made the model conclude its
  parameter had been ignored and abandon the tool for `shell grep`);
- **`tree`'s root label is replayable** (issue #215). The first line is `./`
  whenever the target resolves to the working-directory root — `path` omitted,
  `.`, `./`, the empty string, the absolute root path or a `..`-relative spelling
  all produce the same first line and the same entries — so feeding that first
  line back as `path` succeeds. It used to be the basename of the working
  directory for every spelling but the literal `.`, which read as "there is a
  subdirectory with that name" and made the replay fail with `ENOENT`;
- **a non-root `tree` target labels itself with a replayable relative path**
  (issue #358, the other half of #215). For a target below the root the first line
  is that target's path **relative to the tool root** — `<父目录>/sub/` — so copying
  it back into `path` (after dropping the trailing `/`) returns the same tree
  verbatim, and two directories sharing a basename can still be told apart. It used
  to print the bare basename, which replayed only by luck;
- **`readFile` reports every parameter it rewrote** (issue #358). `offset`,
  `limit` and `max_bytes` are normalized/clamped (a numeric string such as
  `offset:"120"` is not a number here, negatives clamp to 0, fractions floor,
  `max_bytes` clamps to `[1 KiB, 4 MiB]`), and since the fallback is the default
  value, "we changed it" and "you asked for that" used to be textually
  indistinguishable. Such a call now carries `[参数校正：…]` naming the original
  value and the effective one. Semantics are unchanged — this is reporting only.
  An `offset` past the end of the file returns `[已到末尾：…]` with the real line
  count instead of an empty string;
- **read-side path errors keep the channel but lose the errno** (issue #358,
  tail of #234). A missing `path` still **throws** — the engine turns a throw into
  `is_error: true` plus one `toolStats.failures` / `toolErrorCount` increment, and
  a text result would drop it from that ledger — but the message is this module's
  own phrasing and contains only the path relative to the tool root, so host
  absolute paths no longer leak into the transcript. `readFile` pointed at a
  **directory** returns a text result (`错误：路径是目录：…`), matching `edit`,
  because that is a caller-side mistake rather than an I/O failure;
- **both search tools default to regex matching** (`rg` and `grep` alike, which
  is what the real `rg` / `grep` commands do; issue #184 round A reversed an
  earlier `rg`-defaults-to-literal choice that made the two tools in one library
  disagree). `is_regex=false` is the literal escape hatch and is named after the
  real flags: it is `rg --fixed-strings` / `grep -F`. An invalid regular
  expression is returned as the tool error result `错误：无效正则：…` — it never
  throws, unlike the real commands exiting non-zero;
- **both search tools truncate each matched line to the same 500 characters**
  plus a trailing `…` — one shared limit, so `rg` and `grep` cannot drift apart
  (issue #184 round A: the limit used to be 200, which cut ordinary code lines
  in half and made the model misread them; and only `grep` truncated at all,
  leaving the two search tools in one library with opposite behaviour). Real
  `rg` / `grep` binaries do **not** truncate lines (verified: an 807 character
  hit is echoed verbatim), so this cut is **this implementation's own output
  budget** — a single long line (minified files routinely put hundreds of KB on
  one line) could otherwise blow up one tool call. The number is this
  implementation's default, not an obligation on hosts, and it is stated in both
  tool descriptions;
- an empty search result is `（无命中）`, never an empty string;
- `tree` truncation always carries a marker with the remainder count and the
  parameter that would widen it;
- `readFile` is bounded: one call returns at most `max_bytes` UTF-8 bytes
  (default `262144`, overridable through `ERIX_FILE_READ_MAX_BYTES`, clamped to
  1024–4194304) and scans lines block-by-block with early stop instead of
  reading the whole file into memory;
- every truncation marker ends with an executable next step carrying **this call's**
  values (the `readFile` `offset` to continue from, the truncated line's number and
  file path, or the search continuation `offset`), and it may only name `readFile`
  or `searchText` — `exec` is the CLI's own tool, not the library's (issue #196 R1);
- byte quantities inside a result are human-readable (`B`/`KB`/`MB`/`GB`/`TB`, 1024 base,
  via `formatSize`), and the human-readable value and the raw byte count never appear in
  the same result text (issue #196 R2); the raw defaults stay here and in `metadata`.

**Search is a pure-Node subset, not the `rg` / `grep` binary** (issue #184). The
default and the escape-hatch naming follow the real commands; the capability
surface deliberately does not: no `-i`, no `-A`/`-B` context lines, no
`--type`/`--include`, patterns are JavaScript regular expressions (ripgrep embeds
a different regex engine, and GNU `grep` defaults to BRE rather than the
JavaScript flavour used here), **`.gitignore` is not read at all**, and the
vendor exclusion is a hard-coded list (`node_modules`/`dist`/`build`/`target`/
`vendor`) reported as an exclusion account at the end of the result instead of
ripgrep's ignore-file walk. A host must not describe these tools as "the ripgrep
binary" to its model or its users.

The CLI keeps only assembly and presentation: `bin/tools.js` imports this module,
adds `exec` and `todo_*`, and passes no predicates, so CLI behaviour stays
"no boundary" exactly as before. `bin/` no longer owns a second copy of the file
tools (issue #184).

### Success result shapes (issue #220)

`createFileTools().executeTool()` returns a **successful** result in four different
top-level shapes. Those shapes are contract, not implementation detail: the packaged
`fileToolsContract` suite asserts the `typeof` of each one (and the `kind` returned by the
discriminator below), so flattening, wrapping, or "unifying" any of them fails the suite
instead of landing silently on a host's UI.

| Tool | Top-level shape on success | What it carries | `classifyFileToolResult().kind` |
|---|---|---|---|
| `readFile` | `string` | numbered lines; truncation and skip accounts are appended as trailing marker lines | `text` |
| `edit` | `string` | one summary line plus a unified diff | `text` |
| `writeFile` | `number` | bytes written — a real number, so `0` is a valid success value | `bytes` |
| `searchText` | `object` with exactly `content` and `metadata` | `content` is the hit text; `metadata` holds the structured account (truncation / skips / caps) | `content-metadata` |

Rules a host can code against:

- **Pin the shape with `classifyFileToolResult`, exported from `erix-agent/tools` — not with
  string containment.** It returns `{ kind, text, bytes, metadata }`, where `kind` is the
  discriminated union `"text" | "bytes" | "content-metadata" | "unknown"`. Switch on `kind`
  and close the switch with `default: assertNever(kind)`: when the engine adds a fifth shape,
  the host's own compile fails at that `default` instead of the UI rendering `[object Object]`.
- `typeof result === "string"` is **not** a success test: error results are strings too
  (`"错误：…"`), the same top-level shape as `readFile`. Separate them by the error prefix,
  never by shape.
- A bare `number` result is exactly why `if (!result)` is a bug: `writeFile` returning `0`
  means "wrote an empty file successfully".
- The suite's `contentOf` / `metadataOf` helpers remain as migration readers for hosts that
  still normalise by hand. They are readers, not the contract — the assertions above are.

### File edit tool `edit` (issue #191)

`edit` is the **second write tool** in the same `definitions` array and the same
`executeTool` entry point — a host that registers `File tool registration` above
gets it with zero extra wiring. It exists because the tool surface previously had
only `writeFile{path, content}`: a three-line change cost a full re-typed file
(`src/loop/orchestrator.js` at 3277 lines ≈ 33k output tokens), and that rewrite
can itself be cut off by the model's own output budget — `continuation_exhausted`
is a first-class terminal reason in this library. `edit` moves the cost of "change
a small span" from file-size to diff-size.

```js
import { createFileTools } from "erix-agent/tools";

const fileTools = createFileTools({ cwd, allowWrite: (absolutePath) => absolutePath === expectedPath });

const edited = await fileTools.executeTool({
  id: "toolu_edit_1",
  name: "edit",
  input: { path: "a.js", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
  context: {},
});

// 越界写：allowWrite false 走的是与 writeFile 同一份错误结果，不抛、不落盘
const denied = await createFileTools({ cwd, allowWrite: () => false })
  .executeTool({ id: "toolu_edit_2", name: "edit", input: { path: "a.js", edits: [{ oldText: "const a = 2;", newText: "const a = 3;" }] }, context: {} });
```


What a host can code against:

| Surface | Contract |
| --- | --- |
| Input | `{ path, edits }`. `edits` is accepted in exactly three shapes and no others: `[{oldText, newText}]`, a single `{oldText, newText}` object, or either of those as a JSON string. Every other shape (invalid JSON, a non-string `oldText`/`newText`, an empty list) is an error result. Tolerating the three shapes is normalising the **shape**, never guessing the intent |
| Matching | byte-exact. `oldText` must equal a span of the file character for character, whitespace and indentation included. **No fuzzy fallback**: no NFKC folding, no curly-quote folding, no trailing-whitespace tolerance |
| Uniqueness | each `oldText` must match exactly once. `0` matches and `N>1` matches are error results; the `N>1` text names the count and the first two hit lines |
| Independence | every `oldText` is matched against the **original** content, not against the state produced by earlier edits in the same call; matched ranges must not overlap |
| Atomicity | nothing is written unless every edit validated. There is no partial application, and an all-no-op call is an error result (`未做任何修改…`) rather than a silent success |
| Write boundary | `allowWrite(absolutePath)` — the same predicate `writeFile` uses, consulted before anything is read. A denial is an error result, never a throw, and the file keeps its previous bytes |
| Line endings | a BOM is preserved; a file whose newlines include CRLF is matched in LF space and written back with CRLF. A mixed-line-ending file is therefore normalised to CRLF on write — the result line says `CRLF 行尾已保留` rather than leaving that as hidden behaviour |
| Result | a summary line (`已编辑 <path>，替换 N 处，首个变更行 N，写入 N 字节`, plus the BOM/CRLF notes when they apply) followed by a unified-style diff with 3 context lines, grouped per edit region and capped at 8 hunks / 200 diff lines. A capped diff appends a truncation marker with the remaining count and a `readFile` next step (ADR-010: denoising stays revocable) |
| Diff fidelity | the diff is a **self-verification aid, not a patch**: hunks are per edit region with whole-line boundaries and prefix/suffix trimming, so it can show more changed lines than a minimal LCS diff (never fewer) and nothing promises `git apply` works. For byte-exact confirmation use `readFile` |
| Guards | a target over 4 MiB, more than 64 edits in one call, a NUL-containing (binary) file, a directory, and a missing path all return error results that name the next step (`writeFile` for new files, `readFile` to re-read) |
| Judge | `edit` is in the default `writeToolNames` (`["writeFile", "edit"]`), so its `path` reaches the judge's `filesWritten` without host configuration. An explicit host `writeToolNames` **replaces** that default outright — it is never merged with it |

**Why there is no fuzzy fallback in this round.** pi's `edit` carries NFKC
normalisation, curly-quote folding and trailing-whitespace tolerance, added
*after* its transcripts showed models mistyping a character while copying
`readFile` output. This library has no such transcript evidence (the same rule
that kept `-i`/`-A`/`.gitignore` out of `searchText` in issue #195 R4: no
evidence, no scope), and folding would exchange the one signal a model can
self-verify — `0 matches`, an error result it can act on — for a silent
"matched somewhere else". That is the exact class of silent lying issues
#184/#195 have been closing. Concretely: a wrong-but-plausible fuzzy match costs
a whole round-trip to notice, an exact-match miss costs one retry. Adopting a
fallback later is additive (it widens what matches, never narrows it), so nothing
here is a one-way door.

Hosts that classify tool side effects (journaling, permission prompts, TUI write
badges, replay policy) must treat `edit` as a **write**: its `path` argument looks
like `readFile`'s, and a name-based read/write table that keeps only `writeFile`
will under-report every edit. The retired `bin/tools.js` tool surface never had
one, and the CLI now lists `edit` in its tool-list line, which is why
`test/fixtures/cli-golden.json` changed in this release.

### Search tool (issue #195)

`searchText` is the single search entry point (Tier 2 host integration, same
registration path as `File tool registration`); `rg` and `grep` are now **thin
aliases** of it. Why a new name: `rg` and `grep` are our own pure-Node
implementations (no `execFile`/`spawn` anywhere), yet they borrow two CLI command
names — and a borrowed name carries borrowed priors. A model that sees `rg`
writes `glob: "**/*.test.ts"` (the name filter here never crosses `/`), assumes
`.gitignore` is honoured (it is not), and reads "no hits" as "absent from the
repository" when a whole `vendor` tree may have been skipped. That last class is
the silent-lying class issue #184 removed; only the liar changed from the output
to the **name**.

What a host can code against:

- `mode` is **required** and has **no default** — the only legal values are
  `"literal"` (fixed string) and `"regex"` (JavaScript regular expression). A
  missing or unknown `mode` returns the tool error result
  `错误：searchText 必须显式给出 mode … （无默认值）` and never falls back to a
  guess. That is the point of the tool: issue #184 had to reverse an
  `rg`-defaults-to-literal / `grep`-defaults-to-regex pair of opposite defaults,
  and "default to `literal`" would only move the ambiguity to the caller. Note
  the aliases keep the boolean escape hatch instead: `is_regex=false` is
  `mode: "literal"` there (`rg --fixed-strings` / `grep -F`), with the regex
  default unchanged.
- the name filter is `name_pattern`: it matches the **file name only** and
  **never crosses `/`**, so `**/*.ts`-style patterns match nothing. It is no
  longer called `glob` because a subset capability must not wear the full
  capability's name. `searchText` **does not accept `glob`** — passing it returns
  an error result pointing at `name_pattern` rather than silently ignoring a
  plausible-looking key; the `grep` alias keeps taking `glob` (same semantics)
  because its input shape is Stable.
- `content` is the flat `path:line:matched line` form, one hit per line. The
  aliases keep their own historical renderings (`rg` flat, `grep` grouped by
  file), so the cross-tool invariant is the **matched-line body**: one shared
  implementation produces it for all three entry points, including the
  500-character line-width cap, the `（无命中）` no-match text and the exclusion
  account. The contract suite pins this verbatim equality (issue #195 hard
  criterion); hosts must not build a parser that assumes the flat form on the
  aliases. The alias truncation marker carries the same number the canonical entry would
  (`…；下一步：改用 searchText 传 offset=N 继续（本别名不接受 offset）`, N = this call's hit
  count), so the aliases give the truth without acquiring the parameter (issue #196
  follow-up).
- a `path` that **does not exist** is an **error result, never `（无命中）`**
  (issue #219). `（无命中）` means "searched it, nothing there"; returning it for a
  typo'd path is a false negative — `metadata.searchFiles` goes into the
  transcript only, so the model's whole channel is that string and it would
  conclude "this code is not in the repo". All three entry points return the text
  result `错误：路径不存在：<path>` (same channel as the jail-denied and
  invalid-regex results: text, never a throw). The two cases stay strictly
  apart: an **existing** directory with no hits is still `（无命中）`, and a `path`
  naming a **file** searches that one file (unchanged behaviour, now pinned by
  the contract suite).
- `searchText` returns `{ content, metadata }`. `metadata` carries
  `searchHits`, `searchMatchedLines`, `searchFiles`, `searchLimit`,
  `searchOffset`, `searchTruncated`, `searchNextOffset` (only when truncated) and
  `searchSkipped { vendorDirectories, hiddenDirectories, largeFiles, binaryFiles,
  deniedPaths }`. These fields go **into the transcript, not onto the wire**: the
  model still reads the marker text (`[已跳过 …]`,
  `[命中过多，已按 max_results=N 截断；下一步：searchText 传 offset=N 继续]`,
  `（无命中）`), produced only by the single
  `toolMarker()` function (Experimental wording, issue #188). Hosts that need a
  stable signal branch on `metadata`, never on a marker substring, and must not
  require keys beyond the list above. `offset` continues a truncated search: pass
  `metadata.searchNextOffset` back in.
- alias deprecation is a **warning only** in this round (issue #188: tool names
  and input shapes are Stable, so removal needs a major bump). `rg` and `grep`
  append one line at the end of the result,
  `[已弃用 rg：它是 searchText 的薄别名，…]`. Hosts comparing tool output with
  exact string equality will see that line — it is a model-visible change, as is
  the CLI system prompt's tool-list line and `test/fixtures/cli-golden.json`.
  That line's migration hint is derived from **this call's arguments** (issue
  #221): `is_regex=false` → `mode="literal"`, otherwise → `mode="regex"`, and
  `grep` names `name_pattern` only when the call actually passed `glob`. A fixed
  `mode="regex"` hint would silently swap semantics — `literal` does not
  interpret metacharacters and `regex` does (`a.b`, `\d+`, `(x)` give different
  hit sets), and `mode` has no default, so the hint is the model's only migration
  evidence. The contract suite pins "rewrite as hinted → identical hit set".
- what did **not** happen (issue #195 R4): no `-i`, no `-A`/`-B`/`-C` context
  lines, no `--type`, no `.gitignore` support. Each of those crosses the
  boundary-injection, output-budget and abort paths (`-A`/`-B` breaks the byte
  bound; reading `.gitignore` must itself pass `allowRead`), so they wait for
  transcript evidence about which unsupported parameter shapes the model actually
  writes.
### Skills loader registration (issue #197)

The canonical skill-package loader is `src/skills/loader.js`, exported from
`erix-agent/tools` — deliberately **not** a new `./skills` subpath: the packaged
surface is unchanged, and a host that already reads `./tools` needs no second
import-map entry. `bin/skills.js` is assembly plus re-export only (its one job is
supplying the CLI's own bundled skill root), so `erix skills` and the REPL
`/skills` command behave exactly as they did before the move.

The surface is six functions:

- `skillDirectories({ home, cwd, skillsDir, bundledDir })` — the skill roots that
  exist, ordered user-global, project-local, bundled;
- `discoverSkills({ home, cwd, skillsDir, bundledDir })` — first-level skill
  directories as `[{ id, dir }]`, with a non-enumerable `errors` array attached;
- `loadSkill(dir)` / `loadAllSkills(options)` — validate one skill directory /
  everything that was discovered;
- `buildSkillTools({ home, cwd, skillsDir, bundledDir, excludeSkillIds, builtinNames })`
  — the assembled `{ tools, executeTool, errors }` triple, `errors` also carrying
  everything that got skipped;
- `warnBuiltinToolConflicts(errors, { warn })` — the CLI's one-line notice for
  same-name collisions.

**`bundledDir` is the option a host must understand.** The bundled skill root is
**caller-owned**: the library never derives it from its own file location, and an
omitted `bundledDir` means no bundled root participates in discovery at all —
only `<home>/.erix/skills` and `<cwd>/.erix/skills` are consulted. The reason is
concrete rather than stylistic: the retired `bin/skills.js` copy spelled the path
as `../skills` relative to `import.meta.url`, which happened to land on
`<package>/skills` while the file lived in `bin/`, lands one level off from
`src/skills/`, and lands somewhere else again for a host that resolves the
package out of `node_modules`. A wrong guess **fails silently** — the bundled
skills simply stop being discovered — which is why the parameter is the contract,
not a convenience. The CLI passes its own `<package>/skills`; a host passes its
own, or passes nothing and gets user and project skills only.

Precedence is fixed: a bundled skill loses a same-id contest to a user-global
skill, and a user-global skill loses to a project-local one (scan order
bundled → global → project, later entries replace earlier ones). `skillsDir` is
the single-directory override (the CLI's `--skills-dir`): when it is present only
that directory is scanned, and a relative value resolves against `cwd`.

**Discovery and validation never block, and every failure is enumerable.**
`loadSkill` throws for one directory (an unsupported `schema_version`, an
entrypoint that is absolute or escapes the skill root, empty / duplicate /
malformed `tools`, a module exporting neither `getSkillDefinition()` nor
`getTools()`), and `loadAllSkills` / `buildSkillTools` turn each throw into one
`{ skillId, dir, error }` record — `error` is a string, the skill is skipped **as
a whole** (no partial tool set survives), and every other skill under the same
root still assembles. A skill whose tool name collides with one of
`builtinNames` is reported the same way and skipped instead of silently
overriding the built-in tool. Hosts may code against the record shape and the
"skip the whole skill" rule; they must not code against the wording of those
error strings.

`buildSkillTools` returns the library's own `ToolSchema` list handed to
`createToolRegistry`, so registry input validation is live on skill tools: a
missing `required` field or a wrongly typed property comes back as the registry's
`Tool <name> …` text, an unregistered name comes back as `Unknown tool: <name>`,
and nothing throws. Skill modules are imported **in process, with the host's
privileges** — the library adds no sandbox (ADR-008, and ADR-009 keeps the cage
on the host side), so `excludeSkillIds` and `builtinNames` are policy inputs, not
a security boundary.

`skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })` in
`erix-agent/contract-tests` asserts the parameterised bundled root, the
precedence order, the non-blocking enumerable `errors` shape, and the
`ToolSchema` output shape for whichever implementation a host wires in.

### Notes maintenance scheduling (0.12.0)

The root rule is the **session clock** (ADR-018 D7): note lifetime = session
lifetime + a retention (autopsy) window. The session's last activity is
defined by the host — the CLI uses the transcript mtime (`30` days without
conversation activity and the session's notes are cleaned along with the
expired transcript), a scheduled host uses its scheduler state. The engine
never guesses and never asks.

The library `store.purge()` is the portable fallback baseline for hosts
without a session clock: for each scope directory, if the newest write across
all record files (max file mtime — no JSON parsing) is older than
`now - ERIX_NOTES_RETENTION_MS` (default 30 days), **every record file in
that scope is deleted together (including `active` ones)** and the empty
directory is removed; a scope with a recent write is exempt as a whole (even
very old notes inside it survive — a live session keeps its notebook).
`purge` runs one full scan per call — there is no `limit`/`cursor` protocol —
and returns `{ status, scanned, purged }` where `scanned` counts scope
directories and `purged` counts deleted record files. The optional `before`
parameter only ever narrows the window (an earlier cutoff; it can never
enlarge what gets deleted). The CLI chains its session-clock sweep after run
completion; embedded hosts schedule `purge()` themselves.

**Upstream promises no record-level expiry (issue #183 item 1).** `expires_at`
is a legacy field: the shipped file adapter never reads it, `purge` decides only
from the scope clock, and no upstream path turns a record invisible because a
timestamp elapsed. A host is free to run its own retention or expiry policy (a
TTL column, a per-run quota, a scheduled sweep) and the contract suite does not
assert one either way. Do not read `toolResultTtl` as a notes TTL: that knob
counts rounds in the provider request view for folding large tool results (see
[Retrieval and request-view folding](#retrieval-and-request-view-folding)) and
has nothing to do with note lifetime. The one lifecycle obligation that *is*
contractual is `complete` (flip `active` → `done` for the whole scope) and a
`purge` that really deletes what its clock says is expired and rejects an
unparseable `before`.

### CLI-side provenance guard

The CLI guard in `bin/final-guard.js` is a deterministic provenance checker,
not a task-completion evaluator (ADR-016). Evidence is the run transcript's
archived tool outputs (`toolOutputs`, byte-faithful) plus legacy capture
manifests; there is no replayability filter — every archived output is
evidence. The guard compares the envelope's declared `findings` against
archived capture values by exact string equality; free prose is never parsed.

- a declared label whose value matches an archived value → the entry passes;
- a declared label that exists in the archive but whose value differs →
`action: "revise"` (the forgery signal), including the captured values in
the message;
- a declared label that does not exist in the archive at all (e.g. derived
  counts) → warned and skipped, because it can be neither verified nor
  falsified; a revise here only provokes looping (measured);
- captures exist but the envelope declares nothing → `action: "revise"`.
  Having something to compare and not declaring it is the model skipping the
  declaration step, which is not the same as "this task has no verifiable
  values". The guard retries within `finalGuardMaxRetries` and then
  fail-closes to `unverified`; it never silently passes.

A run with no archived outputs returns `action: "skip"` with
`reason: "no_capture_evidence"`. Archived outputs with no extractable
candidates return `action: "skip"` with
`reason: "no_extractable_candidates"`. The guard does not add natural
language inference, keyword guessing, or similarity rules. A skipped check
is still not `verified`.

When the loop has to normalize a prose final answer into the envelope with
an LLM (`ERIX_WRAPUP_NORMALIZE=1` or `reflection.wrapupNormalize`), the
normalizer is only allowed to transcribe: every normalized finding value
must appear verbatim in the model's own final text, otherwise that entry is
dropped before the guard sees it. An LLM must not be able to "repair" a
model's value on the way to verification, which would make the check
irreproducible. That gate is the same one the wrap-up envelope gets from
`normalizeModelJson` (issue #406 B2-b), so the engine and the public normalizer cannot
disagree about what counts as verbatim.

## Retrieval and request-view folding

Model-facing retrieval is note-first: use `note_list` to discover saved notes,
then `note_read` to read the exact note. Do not guess forgotten values, and do
not depend on a transcript-recall API; the retired recall adapters are not part
of the 0.8.0 contract.

Old or large tool results may be folded only in the provider request view.
`toolResultTtl` defaults to `2` rounds (`0` disables folding), and
`toolResultFoldMinTokens` defaults to `4000` estimated tokens. The warning
round at `age === ttl - 1` asks the model to extract important facts with
`note_take`; the folded placeholder contains a navigation digest and, where
applicable, a JSON skeleton. Run snapshots retain the full tool-result text.
Note, todo, error, and explicitly protected results are not folded.

## Repeated commands and side effects (ADR-016)

The engine performs no replayability classification, rerun detection, or
rerun notices. A repeated command is executed normally and returns its fresh
output. The rerun-value-mismatch risk is carried by one line in the system
prompt: "Re-running the same command may produce a different value; when an
earlier exact value is needed, use note_list then note_read instead of relying
on memory."

The host must therefore carry side-effect and rerun risk in its tool
capabilities, permissions, sandbox, or idempotence layer, and decide whether
unverified results should trigger human review, a retry, or failure. The
guard remains an opt-in mechanical checker; do not add natural-language
inference, keyword guessing, or similarity rules to it.
## Error ledger (issue #109 step 1)

`runToolLoop` results carry two always-present ledger fields:

- `result.unpersisted: Entry[]` — the authoritative record of persistence
  failures during the run. Default: `[]`.
- `result.completionErrors: []` — reserved for completion-phase failures
  (wired in a later step); default `[]`.

An `Entry` is one of:

- `persistence_error`: `{ kind, port, operation, phase?, fatal, error: {name, message, phase?}, ts }`
  where `port` is `"transcript"` (today; `"resource"`/`"notes"` arrive with
  their integration steps). `error` is normalized to `{name, message}` with
  the message capped at 500 chars (bounds the result payload; stack traces
  are dropped). **Additive since issue #439:** `error.phase` is preserved
  when the thrown error carries one (a non-empty string, whitespace collapsed
  and capped at 32 chars — the same caliber as the run-state projection's
  `safeText(entry.phase, 32)`); an error without it produces **no `phase` key**
  at all (never `phase: undefined`, never a guessed value). This is what lets
  a host tell "the request never went out" (`phase: "request"`) from "the
  stream broke mid-way" (`phase: "stream"`) without parsing `message`; the
  two are not equally retryable. It is a **different field** from the entry's
  own `phase` (the persistence phase — `transcript` / `notes` /
  `checkpoint_before_tool` / …), which keeps its meaning unchanged.
- `delivery_failure`: a `diagnostics.error` (or `onPersistenceError`) sink
  itself threw — the error happened but the structured event was not
  delivered. `port` is always `"diagnostics"` (the failed channel); the
  origin port rides in `failedEvent.port`.
- `ledger_overflow`: synthetic entry reported when the ledger cap
  (`100` entries) dropped records; carries `dropped: number`.

Delivery guarantees: the ledger and the `diagnostics.error` event are the two
reliable channels; model-visible warnings are advisory only and never count
as delivery. On an exception-terminated run the ledger is attached to the
thrown persistence failure as `error.unpersisted`, as the raw frozen array on
both `persistence_failed` and `checkpoint_failed` (issue #230: the two outlets
carry the same shape, and the `{ count, items }` projection stays on the
`<runId>.state.json` path — see "Persistence failure reporting" above).

`persistence_error` diagnostic events now include `port: "transcript"`;
the field is additive and existing consumers are unaffected.

## Fold summary structure

Both round-folding strategies (`fold-statistical` and `fold-llm`) prepend a
single fold-summary text block to the head task message (or system message
with `summaryRole: "system"`). Its fixed sections, in order:

1. Marker line `【上下文折叠·v1·erix-9f6e2c】早期第 N–M 轮（共 K 轮）已折叠。`
   plus the deterministic tool footprint (`工具足迹：name×count, …` or `无`).
2. Optional `导航记录：{…}` line (bounded JSON, only when folded tool results
   carry archive artifacts).
3. Optional `[已折叠] …` stubs (at most 10).
4. The recovery hint line.
5. Optional **anchor index** section (mechanical extraction, no LLM rewrite):

   ```
   ## 锚点索引（机械抽取，未经 LLM 改写）
   paths: src/a/b.js:12, …
   shas: 1ed3f35, …
   issues: #32, …
   urls: https://…
   errors: TypeError: …, …
   ```

   Anchors are regex-extracted from the folded payload — only from
   `tool_result` content and real user messages, never from assistant prose.
   Kinds render in the fixed order `paths, shas, issues, urls, errors`;
   `errors` lines contain `Error`/`Exception`/`Traceback`/`fatal:` and are
   kept verbatim up to 120 chars, at most 5. Within a line, multiple values
   are joined with `, `; a literal `,` or `\` inside a value is escaped as
   `\,` / `\\` at render time and unescaped when the section is re-parsed,
   so every kind round-trips losslessly across repeated folds (e.g. an error
   line `Error: failed, retry later` or a URL query `?a=1,2` stays a single
   value). Note the `paths` regex charset excludes `,`, so paths containing
   commas are not extracted — an accepted false-negative tradeoff.
   Caps: 20 anchors total,
   1200 chars for the whole section (ranked by frequency, then first
   appearance). Across consecutive folds the section is re-parsed and merged
   as a per-kind union (existing entries first, new entries appended,
   deduplicated) and re-clamped, so anchors survive repeated folding without
   loss, duplication, or overflow.

   The anchor section is on by default. Pass `anchors: false` (strategy
   factory or per-`compact` options) to restore the exact 0.7.0 behavior —
   no anchor section, and anchor sections from previously folded summaries
   are dropped on merge (a later `anchors: false` fold fully removes an
   anchor section created by an earlier default fold); the rest of the
   summary is unchanged. An object form
   `anchors: { maxPerKind, maxChars }` clamps per-kind counts and section
   characters. In `fold-llm` the section is appended after the LLM summary
   (and after size enforcement), so `maxSummaryTokens` cannot truncate it.

## Store fidelity requirements

A host `TranscriptStore` must preserve the complete `RoundRecord` and complete
message objects, including fields it does not understand. It must not rebuild
records or messages from a field whitelist: required fields evolve with the
implementation, and dropping an unknown field can change engine behavior.

There are two separate fidelity requirements:

- **Display-projection fidelity** means retaining the fields that
  `projectTranscriptForDisplay` reads to produce correct turns, labels, tool
  previews, folded summaries, ordering, and timestamps.
- **Resume/model-context fidelity** means `load()` reconstructs the messages,
  their content blocks, metadata, order, and unknown fields so model replay and
  judge filtering see the same context. A plausible display projection does
  not prove resume fidelity.

The minimum fields relevant to projection and judge correctness include:

| Field | If it is lost |
|---|---|
| `messages[].meta.source` | Synthetic classification falls back to text-prefix heuristics; an injected judge direction hint can appear to be a real user message and can escape the judge's `judge-control` exclusion after resume. The current text heuristic does not recognize its `【Judge 评审意见】` prefix. Absence on an ordinary historical message is not evidence of store loss. |
| `messages[].content[type="tool_use"].id` and `messages[].content[type="tool_result"].tool_use_id` | Tool uses cannot be paired with their results, so the projected tool-result preview is missing. |
| `response.content`, including reasoning blocks | Assistant output, tool calls, or reasoning can disappear from the projection and from the reconstructed model context. |
| `folded` | The folded-round banner and folded-segment treatment are omitted. |
| `foldedRoundRange` | The banner loses the exact collapsed round range. |
| `foldedPayload` | The archived folded messages are unavailable for recovery and anchoring. |
| `navigationRecord` | Fold navigation and links to archived artifacts are missing. |
| `summary` | The composed fold summary loses its round action/note fallback. |
| `round` | Turns lose their round number and cannot be ordered by the recorded round. |
| `ts` | Projected turns lose their timestamp. |

A lossy store currently does not cause an error. The projection silently falls
back to text-prefix sniffing for some synthetic messages, `textPreview` when a
response is absent, or `summary` when a marked fold summary is unavailable;
these fallbacks do not detect or report store loss. Hosts are responsible for
proving fidelity, for example by running and extending the assertions in
`test/contract/transcript-store.js` for their own schema and unknown fields.

### Journal row shapes: message rows plus metadata-only round rows (ticket 261021)

Since 0.23.0 the engine writes a message into the journal **the moment it is
formed** instead of once per round. One journal row carries exactly one
message:

```ts
{ round, roundKey: `${runId}:round:${round}`,
  dedupKey: `${runId}:msg:${round}:${seq}`,   // seq counts up from 0 inside a round
  kind: "message", seq, messages: [that one message], ts,
  partOf?: string }                            // shard of an already-written message
```

The round row itself (`<runId>:engine:round:<n>`, built as `record` in
`src/loop/orchestrator.js#runToolLoop`) keeps **metadata only** for new runs:
`response`, `textPreview`, `toolUses`, `summary`, `l0facts`, `runState`,
`judge`, `wrapup`, `compactionStats`, `toolOutputs`, … — its `messages` field is
gone. `src/store/message-rows.js#foldMessageRows` (called by `load()` of both
built-in stores) folds the message rows back into that round row, so the
host-visible shape of `load()` — and therefore
`records.flatMap((record) => record.messages ?? [])` — is byte-identical to a
journal written before the change **except for the per-message `ts` added by
issue #439** (next bullet; golden: `scripts/message-journal-golden.mjs`, whose
fixture has no message rows and therefore pins the pre-#439 shape).

Consequences for a host store and for host readers:

- `kind`, `seq` and `partOf` are now **fidelity-bearing fields**: dropping them
  makes a message row unfoldable, which leaves it standing on its own in the
  `load()` array. Round grouping happens by `round`, ordering by `seq`.
- **Every logical message folded out of message rows carries its own `ts`
  (issue #439).** A message row stamps `ts` when the message is formed, so
  folding puts that stamp **on the message object**: each logical message in
  the `load()` result has `messages[i].ts`, taken from the **first slice's**
  row (the row that started the message — the same "the anchor is the first
  slice" caliber as issue #430; a `partOf` shard only appends content blocks
  and never rewrites the stamp).
  Without it a host doing timeline/latency analysis had **no timestamp for any
  message that went through the fold**: the carrier row's own `ts` is when the
  **round row** landed, not when the message formed. A row without `ts` (a
  hand-written row, a host store that does not stamp one) produces **no `ts`
  key** on the message — never `ts: undefined`.
  **What the qualifier excludes (two real shapes).** The promise is about
  messages *folded out of message rows*, so a `load()` message that never came
  from a row has no `ts`: (a) a carrier already folded by an older version
  (≤0.24.0, or a host's own fold) and (b) the engine-control body that a
  carrier row carries itself (the control text of a `…:resume` row).
  **The already-folded guard is deliberately blind to the stamp:** it asks
  whether the **same body text** was already folded, and it compares both
  sides with the envelope `ts` stripped (`withoutJournalTs`). So when the
  carrier already carries that same body, the round is skipped **even if those
  messages have no `ts` — or a different one**; they are **not backfilled**.
  This is additive: it changes no existing key, and the engine's own resume
  path deliberately reads the ledger
  as canonical messages **without** the per-message `ts` (`foldLedgerMessages`),
  so a fold input keeps one stable identity across a resume (the reuse key of
  the fold summary, issue #326, is computed over those messages).
  **Do not write a folded message back as a message row.** The `ts` on a folded
  message is a **nested** payload field, not the top-level envelope `ts` that
  the same-key digest drops: re-appending it under the same `dedupKey` is
  judged a payload conflict (`code: dedup_payload_conflict`,
  `differingFields: ["messages"]`; measured — the pre-#439 shape does not
  collide). The four excluded names are exactly the top-level ones, as stated
  in `### Same-key payload conflicts (issue #326)` (“nested `ts` values are
  payload”).
- Do not assume “round rows carry the messages”. The carrier may be
  `<runId>:engine:round:<n>`, `<runId>:round:<n>` (host default key) or
  `<runId>:engine:round:<n>:resume`; if a run crashed before its round row
  landed, the message rows stay in the array unchanged, which is the
  crash-recovery contract, not a store bug.
- Engine control text rows (`<runId>:engine:round:<n>:control:<slot>` from
  `src/loop/orchestrator.js#appendEngineMessagesToTranscript`, and the
  `…:fold:` / `…:ttl:` fact rows from `appendEngineFactToTranscript`) carry no
  `seq` by design, so folding passes them through untouched.
- **A resumed run leaves the ledger closed (ticket 261021).** Running the same
  `runId` again (`resume: true`) rebuilds the context from the ledger alone, and
  the ledger is **append-only**: already-landed rows are never rewritten, a
  resume only appends after them. So after folding, every logical message
  appears **exactly once**, and one tool call has **exactly one result** (same
  `erix.toolCallKey`, same `tool_use_id`) — **every** result becomes a row, not
  only the ones a resume re-executes. Results that had already finished
  executing when the process died (outcome formed, no row in the ledger) are
  written by `journalResumeUnpersistedToolResults` (`src/loop/orchestrator.js`)
  **before** the replay section, through the same writer a replayed result uses;
  both kinds are attached to the crash round's aggregated `tool_result` message
  through `partOf` instead of becoming a new message. The anchor is the row key
  `restoreResume` (`src/loop/resume-manager.js`) reads out of the ledger as
  `resumeToolResultRowKey`; when the crash round landed **no** result row at all,
  the first slice starts the aggregate itself and becomes the anchor for the
  rest. The anchor is always the **first slice** and it never advances with the
  slices: a slice's key is not an addressable `partOf` target (a slice adds no
  logical message, so folding maps its key to the *next* message), which is why
  chaining `partOf` at the previous slice made the third result start a message
  of its own. So **every** result of one crash round folds back into **one**
  aggregated `user` message, no matter how many there are (never one `user`
  message per result), and the `<runId>:msg:<round>:<seq>` sequence keeps the
  issue #326 order. Pinned by the `#430` end-to-end cases in
  `test/loop-resume-unpersisted-tool-results.test.js` (the shared crash scene is
  `threeToolCrashScene` (`test/loop-resume-unpersisted-tool-results.test.js`)),
  plus the four-row unit case in `test/store/message-rows-fold.test.js`; before
  the fix the measured fold for three tool calls was `[[t1,t2],[t3]]` and the
  next resume failed `invalid_messages` (issue #430). Before issue #420 that half
  was handed over
  on `resumeUnpersistedToolResults` with a comment promising it would be
  journaled, and nothing read it: its only carrier was the latest-only run
  snapshot, so the next round that really ran a tool overwrote it and that
  `runId` could never be resumed again (`invalid_messages` before the first
  model request, zero requests). **Upgrade-path guard (issue #424):** a ledger
  written before the per-message rows existed keeps the crash round's `assistant`
  body only in the run snapshot, so journaling those results would leave
  `tool_result` rows with no matching `assistant` and the next resume would fail
  the same way. `journalResumeUnpersistedToolResults` (`src/loop/orchestrator.js`)
  therefore first checks a fact `restoreResume` (`src/loop/resume-manager.js`)
  computed over the **folded** ledger entries — does the crash round's body
  already contain an `assistant` message? If it does not, the whole batch is
  skipped (the pre-#420 semantics: memory only, carried by the snapshot), the
  ledger ends up byte-identical to a pre-#420 journal, and exactly one
  `resume_journal_skipped` event (`{type, runId, round, reason, count}`) is
  emitted on `onEvent`. One host-visible ordering detail:
  the crash round's carrier row `…:engine:round:<n>:resume` is written **after**
  the host's `:input:` row, and folding places the body at the carrier's
  position (`load()` returns records in append order), so the resume prompt can
  precede the crash round's body in `load()` output; the model context is not
  affected by that order — `restoreResume` (`src/loop/resume-manager.js`) keeps
  the `:input:` row as a tail and splices it after the replayed results.
  Real-upstream guard: `examples/resume-real-e2e.test.mjs` (`ERIX_E2E_REAL=1`:
  real process SIGKILL → same `--session` resume → ledger closure / no loss /
  no duplicate execution / half-line quarantine).
- **Read the ledger through `load()`, never by re-folding raw rows by hand.**
  `foldMessageRows` (`src/store/message-rows.js`) is the only read side, and since issue
  #401 it is **public API**: `import { foldMessageRows } from "erix-agent"`. A host store
  that assembles its own `load()` return value calls it — the module's deep path is not in
  the package `exports`, and before #401 the function was not reachable from a packed
  install at all (`ERR_PACKAGE_PATH_NOT_EXPORTED`), so “implement the fold yourself” was
  the only thing on offer. A reader that re-implements the fold — de-duplicating messages on a
  content fingerprint, say — silently drops legitimate repeats: two long messages that
  share their first 400 characters collapse into one, and any census derived from that
  array is wrong in a way that depends on the payload text (a “did the CLI really run ≥2
  tools” check can read 1). In-repo precedent: `scripts/cli-real-smoke.mjs` takes its
  tool-result census from `createFileTranscriptStore({ dir }).load(runId)`.

### The row shape on disk is not the shape after `load()` (issue #361)

These are two different shapes, and only the second one is what a host reads.
Issue #353 was a host reading the first one and reporting a 0.23 regression that
does not exist.

**What `load(runId)` returns is the folded shape.** `foldMessageRows`
(`src/store/message-rows.js`) runs inside `load()` of both built-in stores —
`createMemoryTranscriptStore` (`src/store/memory.js`) and
`createFileTranscriptStore` (`src/store/file.js`) — and re-attaches the body of
every `kind: "message"` row to that round's carrier row before the array is
returned. `isRoundCarrier` (`src/store/message-rows.js`) is the predicate that
decides which row is the carrier. A host `TranscriptStore` must produce the same
result: folding is the read side, and it is not optional.

**What sits on disk is not that shape.** In the journal, the round carrier row
(`<runId>:engine:round:<n>`) carries metadata only and has **no `messages` key**
at all; the bodies live in their own `kind: "message"` rows. So counting rows,
counting rounds, and reading a body all have to go through `load()` — never
through a hand-rolled pass over the raw lines. A reader that takes the raw
journal and flattens `record.messages` gets an empty array, not a transcript.

**Row count ≥ round count is normal (since #326).** Besides the message rows, a
`load()` result also carries engine fact rows (`…:engine:round:<n>:fold:<fp>`
and `…:ttl:<fp>`, which are `messages: []` by construction) and engine control
rows (`…:engine:round:<n>:control:<slot>`, which do carry `messages` but no
`seq`). So “one record per round” has not been true since that change. A host
materializer — anything that turns `load()` output into rounds for display, for
a queue, or for a second store — must merge by `round` and de-duplicate by
`dedupKey`; it must not assume a one-to-one record-to-round mapping. That is
what issue #328 group C asks of the station and touwaka materializers, and this
paragraph is its authoritative source in this repository.

**One checkable criterion.** After `load()`, a round record's `messages` array
holds the `tool_use` block and its paired `tool_result` block — as two messages,
but inside the same record. That is the line between `[ok]` and `[pending]` in
the #353 probe: with folding in place, a resumed run rebuilds the governed
timeline with the tool call marked `[ok]`; without folding the use and the
result sit in different rows, cannot be paired, and the same timeline reads
`[pending]`.

### The fold is public API, and the engine covers one fallback (issue #401)

**Two symptoms of an unfolded store** (a `load()` that returns the on-disk rows as
they are — the real-upstream case behind issue #401):

1. **The governed timeline reads `[pending]` instead of `[ok]`.** A `tool_use` and its
   `tool_result` land in two different records, so they cannot be paired; the timeline
   entry for that round is built as “called, never answered”.
2. **One round is counted as many.** Every message row is its own record, so anything
   that counts records — the governor's round history, a `l0facts` re-extraction, a
   “how many tools did this run really call” census — reads the body of one round as
   several messages.

A third shape is not a symptom but a bug of its own: a store that folds **and** keeps the
raw message rows returns the same round body twice (measured: `assistant+user+assistant+user`
for a two-message round).

**What the engine does now.** `restoreResume` (`src/loop/resume-manager.js`) folds the
value `store.load()` returned once more before it rebuilds the context, so the resume path
no longer depends on the host having folded. The fold itself skips a round whose carrier
row **already holds that round's folded body** (`foldMessageRows`, exported from the
package root), which is what keeps the “both copies” shape from doubling the body.

**Still fold it yourself.** That fallback covers the **resume path only**. The display
projection (`projectTranscriptForDisplay`, `src/display/projection.js`) reads `load()`
output directly and is still wrong on an unfolded store, and so is every other reader you
wrote against `records.flatMap((record) => record.messages ?? [])`. Folding belongs inside
`load()`; `foldMessageRows` is now reachable from a packed install so that the obligation
is actually fulfillable, and `test/contract/transcript-store.js` now asserts it — three
cells that a pass-through store fails (measured: 22 existing cells green, all three fold
cells red).

## Tool result fact and field ownership (issue #284 / #285)

Every `tool_result` the engine produces is one **fact object** built at a single
construction point: `buildToolResultFact()` in `src/tool-fact.js`, re-exported from the
package root together with the constant below. “Who owns which field” is itself a
published constant, `TOOL_RESULT_CONTRACT`, and three parties consume that one copy: the
constructor writes its paths from it, `test/contract/tool-result-envelope.js` generates
its expected field sets from it, and the `check:docs` anchors compare the field lists of
this section against it in both directions (including the EN/CN statement counts). Add or
rename an engine field anywhere and the other two go red instead of quietly disagreeing.

Three hard rules:

1. host extensions may only be written into `metadata`; the engine never reads them out
   again to overwrite an engine fact;
2. engine facts may only be written into `erix`; the constructor writes that namespace
   last, so a host key flattened onto the top level cannot overwrite it;
3. `is_error` stays at the top level — it is a wire field (the Anthropic request builder
   emits it), not a namespace member.

`metadata` and `erix` are **reserved top-level key names**, registered as
`TOOL_RESULT_CONTRACT.reserved.topLevelKeys`. Since the retirement below there is no
flattening step left, so those two names are the constructor's outright rather than
"skipped by a filter": a host extension carrying one of them can only ever live inside the
host namespace, readable at `metadata.metadata` / `metadata.erix`. Before the retirement the
same-name key used to be written to the top level and then overwritten by its namespace one
statement later, so what survived depended on write order rather than on ownership. The
other four top-level names — `type`, `tool_use_id`, `content`, `is_error` — are **not**
registered as reserved, and this change deliberately does not change that registration (that
tightening is a separate decision, not this one's). What *did* change as a side effect is
worth knowing: while host keys were flattened onto the top level, a host extension spelled
`content` or `is_error` overwrote the protocol field; host extensions now have no path to the
top level at all, so they can no longer reach those fields.

The constructor never spreads `metadata` onto the top level, and since this change it writes
**no other top-level key at all**: an engine-built `tool_result` contains exactly the
protocol fields plus `metadata.*` plus `erix.*`. Nothing in `erix` or
`metadata` is sent to the provider: both protocol converters serialise `tool_result` from
an explicit field list, so the two namespaces are `onWire: false`. The output-hygiene,
aggregation and fold layers only ever replace `content`; the fact fields survive them.

### The field lists (anchored against `TOOL_RESULT_CONTRACT`)

The required protocol fields are `type` / `tool_use_id` / `content`. There is exactly one
conditional protocol field, and it is `is_error`: present only when the result is an
error or an interruption. The engine namespace has exactly five fields, every one of them
addressed as `erix.<field>`: `toolCallKey` / `round` / `durationMs` / `executionStatus` /
`success`. The host namespace is a single key holding whatever the executor returned.

| Field | Owner | Written when | Meaning |
|---|---|---|---|
| `type`, `tool_use_id`, `content` | protocol | always | `tool_use_id` is the provider pairing key: the engine reads it and never rewrites it (`groupIntoRounds`/`validateMessages` and run-snapshot replay lookups depend on it). |
| `is_error` | protocol | only error/interrupted results | Wire field, top level by design. |
| `erix.toolCallKey` | engine | every `tool_use` the engine accepts, and every result built from one | Cross-channel identity: one allocation per accepted call, carried by the first recognisable stream fragment, the `tool_use` block (and therefore the persisted block and the `tool_use` event clone), the `tool_result`, and the projection. Resume and replay **reuse** the persisted value; a value is never regenerated for a call that already had one. A provider pairing id is **not** an identity and is not guaranteed unique inside a run (per-round index prefixes, or the `call_legacy` fallback for malformed responses), so the same id reappearing in a later round is a **new call** and gets a new key: a key is inherited only where the call is confirmed to be the same one — the replay window of the current round, or the one pending call restored from the crash site. **Pre-contract records stay keyless on both ends** (see the carve-out below). |
| `erix.round` | engine | the call actually executed | The **execution** round. It is not the event envelope’s `round` (the delivery round), and the two are deliberately not merged. |
| `erix.durationMs` | engine | the executor promise settled or rejected | Milliseconds from “immediately before the executor is invoked” to “that promise settled or rejected”. |
| `erix.executionStatus` | engine | special states only | `intercepted` / `interrupted` / `rejected`. The existence condition is machine-readable as well: `TOOL_RESULT_CONTRACT.engine.fields.executionStatus` carries `writtenFor: "special states only"` plus `presentValues` (`src/tool-fact.js`), so a host that reads only the constant must not assume the field exists on every result block (issue #286). `rejected` (issue #409) means the call's arguments could not be parsed, so the tool **never ran** and the result content is the parser's verdict. |
| `erix.success` | engine | every result whose executor settled | The engine-normalised boolean (`success !== false`). Written unconditionally since the retirement of the top-level `success` key: with the top level gone, writing it only when the host declared a verdict would make "succeeded" and "no verdict declared" indistinguishable. A call that never ran (judge interception, interrupted replay) has no verdict and therefore no field. |
| `metadata.*` | host | whenever the executor returned extensions | The only namespace a host may write. |

### `durationMs` is measured at executor settle, and absent means unknown

`durationMs` covers exactly one interval: from immediately before the executor is invoked
to the moment that promise settles or rejects. It deliberately **excludes** the
`onToolResult` rewrite, output hygiene, and the per-round aggregation budget. A missing
`durationMs` means **unknown — not 0**: a call that never ran (judge interception), an
unsafe call replayed as interrupted, and a call aborted before its executor settled all
report no duration, and rendering `?? 0` turns “we do not know” into “it was instant”.
All six executor return forms (`string`, `number`, `{content, metadata}`, the legacy
`{data}` shape, a returned `Error`, and a thrown non-abort error) carry a duration,
because “it threw after 40 ms” is a fact too.

This is a tightened definition on one path, and the retirement closed the gap: the legacy
top-level `duration` key used to keep its historical behaviour, which included the
`onToolResult` rewrite time **only** when that hook returned a structured object, so during
the dual-write window the two numbers legitimately differed on that path. That top-level key
is retired now, so `erix.durationMs` is the only duration the engine publishes — one
measurement, one口径, no pair of numbers to reconcile.

### What retired with the end of the dual write

T1 promised one minor of dual writing; this is the change that ends it. The engine **no
longer writes** any of these top-level names, so a host still reading them has to move
(recorded as `Changed (BREAKING)`):

| Retired top-level name | New home |
|---|---|
| `erixRound` | `erix.round` |
| `duration` | `erix.durationMs` |
| `executionStatus` | `erix.executionStatus` |
| `success` | `erix.success` |
| any host key flattened to the top level | `metadata.<host key>` |

Two halves to keep straight:

1. **Writes stopped.** `buildToolResultFact()` has no flattening parameter left, so a retired
   name cannot come back from any call site. An engine-built `tool_result` carries exactly
   `type` / `tool_use_id` / `content` (plus `is_error` for error and interrupted results),
   `metadata.*`, and `erix.*`. A host extension spelled `content` or `is_error` can no longer
   overwrite a protocol field either; it is readable at `metadata.content` / `metadata.is_error`.
2. **Reads stay for one generation.** Records written before this upgrade may still carry
   those names, and every reader prefers `erix` and falls back to the top level: the TTL fold
   (`src/loop/tool-result-ttl.js`, the age marker), the display projection
   (`src/display/projection.js`, execution status), the resume replay path
   (`src/loop/orchestrator.js`, which returns the recorded block as it is instead of
   recomputing or back-filling), the per-round aggregate budget (`src/loop/aggregate-budget.js`,
   “an interception is not output”), the judge timeline and conversation renderer
   (`src/reflection/judge.js`), the L0 objective facts (`src/reflection/l0.js`), and
   `hasSuccessfulToolResult` (`src/loop/messages.js`). `TOOL_RESULT_CONTRACT.legacy` carries
   the same list with `written: false` and that read window, so the constant — not prose —
   is what says what is retired.

The one place where this change **adds** information instead of moving it: `erix.success` is
written for every result whose executor settled, not only when the host declared a verdict.
Its value is the same expression the retired top-level key used (`success !== false`), so
nothing a host relied on changed meaning; `success: 0` used to reach the top level as the raw
`0`, while `erix.success` has been the normalised `true` since T1 — that normalisation is not
new here.

### Existence matrix

The matrix is the acceptance table of `test/contract/tool-result-envelope.js`: one row per
row below, plus the reverse assertions (interception carries no duration, replay never
recomputes, a host key is present **only** in `metadata` and never at the top level, none of
the retired top-level names reappears anywhere, and the provider `id` is never rewritten).

| Case | erix.toolCallKey | erix.round | erix.durationMs | is_error | erix.executionStatus | record in B |
|---|---|---|---|---|---|---|
| success (string / number / structured / legacy all behave the same) | yes | yes | yes | absent | absent | yes |
| failure (returned Error / thrown non-abort) | yes | yes | yes | yes | absent | yes |
| judge interception | yes | absent | absent — never executed | absent | intercepted | yes |
| arguments could not be parsed (issue #409) | yes | absent | absent — never executed | yes | rejected | yes |
| resume replay of an unsafe interruption | yes, the persisted value | absent | absent | yes | interrupted | yes |
| replay of an already-completed result | yes, same value | original value | original value, never recomputed | original value | original value | reuses the original record |
| abort before the executor settles | present on the tool_use | absent | absent | absent | absent | may be absent |

`erix.success` is not a matrix column on purpose: the input side is the executor’s return
shape (`{content, success:false}`, with the historical `value.success ?? metadata.success`
compatibility read), while the output side is the normalised boolean in `erix.success`,
written for every result whose executor settled. The two sides must not be confused: an
**executor return** carrying `metadata.success` does participate in that normalisation (it is
the historical compatibility read above), so an executor can still report failure that way;
but a **host** that writes `metadata.success` into an already-produced `tool_result` (inside
`metadata.*`) changes only the record — `erix.success` is written by the engine at settle time
and is never re-derived from `metadata.*`.

### The one equation between the live event stream and the transcript

`tool_use` / `tool_result` events are emitted before the `RoundRecord` exists, so the
event stream is not derived from the record. Exactly one equality is promised: for a call
that was committed, the fact in the event and the block stored in the record carry the
same `toolCallKey`, the same pairing id, the same `is_error`, the same `erix.*`, and the
same `metadata` — two clones of one object. `content` is not part of the equation (a fold
may rewrite it), event envelopes and stream deltas never enter the record, folding never
flows back into an earlier event, and when a run aborts or the append fails the record may
simply be missing — the engine never invents a record to make the equation hold.

### Carve-out: replaying a record written before this contract

A run snapshot written before the fact contract carries no `erix` at all. Replaying such a
record is the one case where **both ends of one call legitimately have no `toolCallKey`**:
the engine replays the recorded result verbatim (it never rewrites a stored fact) and, for
that round, deliberately does **not** claim a key for the paired `tool_use` block either.
Missing on both ends is the truthful state — inventing a key would leave the `tool_use` end
carrying an identity the `tool_result` end does not have, which is worse than both being
absent, because a host could then not tell which side to trust. Concretely:

- the engine fabricates nothing: no `erix` object, no top-level `toolCallKey`, nothing
  derived from the pairing id;
- a host must therefore treat `toolCallKey` as **optional per call, not optional per
  version**: a run that resumes from a pre-contract checkpoint can intermit keyless facts
  with keyed ones, and must key its own card by the pairing id for the keyless ones;
- calls accepted after the upgrade are unaffected — they always carry a key on both ends.

This is asserted by `test/contract/tool-result-envelope.js` ("复放升级前的已记录结果").

## onEvent tool event field list (issue #284 / #285)

`onEvent` is one channel for structured events; the tool-related event types the loop
emits, and the payload fields each one carries, are listed here so a host does not have to
guess which identity field is where. Field names below are payload keys, not `erix` paths:
`toolUse` and `toolResult` are clones of the fact objects, so everything in the previous
section is reachable through them.

| Event type | Payload fields | Notes |
|---|---|---|
| `tool_use` | round, toolUse | Emitted once per accepted call, after the identity key has been attached to the block, so `toolUse.erix.toolCallKey` is always present for engine-accepted calls. |
| `tool_result` | round, toolResult | The fact clone described above. `round` is the delivery round: during a replay it can legitimately differ from the fact’s execution round. |
| `tool_replay_decision_required` | runId, round, toolUseId, toolName, replay, requiresHostDecision, partialOutputAvailable | Emitted immediately **before** the paired interrupted result. It still carries only the provider pairing key: adding the identity key here was out of scope for this ticket, so correlate the two by `toolUseId` for now. |
| `tool_output_aggregate` | round, toolUseId, name, action, reason, budgetTokens, inlineTokens, costTokens, projectedTokens, contentLength, archivedBytes | The per-round output budget. `projectedTokens` appears on the admission path and `archivedBytes` on the archive/unrecoverable paths; this event is about content size and never carries fact fields. |

Stream fragments are **not** an `onEvent` event: the engine loop delivers them through the
`onToolCall` callback, whose fragment keeps its historical shape (`index`, optional `id`,
optional `name`, optional `argumentsDelta`) and now also carries `toolCallKey` — the same
value the accepted `tool_use` block will carry, starting from the first recognisable
fragment. A provider invoked directly by a host can additionally emit its own `tool_call`
events to the `onEvent` callback it was handed; the loop does not inject that callback, so
an ordinary `runToolLoop` run emits none, and the shipped suite pins that fact.

## Host display projection

The transcript is the model-context truth: `RoundRecord` is byte-faithful for
replay and carries both model-facing payloads and display-oriented fields. Hosts
that need a human-readable chat view must derive it from the transcript instead
of maintaining a second lossy message table. `projectTranscriptForDisplay` is
the official, host-agnostic projection helper:

```js
import { projectTranscriptForDisplay } from "erix-agent";

const turns = projectTranscriptForDisplay(await store.load(runId));
// [{ key, role, text, blocks, toolCalls?, reasoning?, folded?, round, ts, meta }]
```

The **input must be `store.load()`'s folded output, not the raw journal lines.** `load()` is
the read side of the journal: since the journal became one row per message, a run's file
holds two kinds of lines — round rows (carrying `response.content` and **no** `messages`) and
message rows (assistant text, written **before** the tool runs, so they never carry the
`erix` execution facts). Feeding raw lines straight into the projection therefore projects
the same round twice (duplicate `toolCallKey`s) and drops execution facts such as
`erix.durationMs` — the projection is not wrong, the host's input is. Take the array from
the same accessor the engine's own resume path uses: `createFileTranscriptStore({ dir }).load(runId)`
for a file journal, `createMemoryTranscriptStore().load(runId)` for a memory one, and hand
**that** array to the projection.

It is a pure function: no I/O, no model calls, no mutation of the input records
while producing the result, and no host-specific assumptions. It accepts any
subset of records (a filtered or sliced `load()` result is fine) and returns
turns ordered by `round` ascending;
records without a usable `round` keep their input order and sort last (ties on
the same `round` also keep their input relative order).

### Projected identity and tool-call shape

Every projected turn has a `key` derived as
`${roundToken}#${recordIndex}:${entryIndex}`. `roundToken` is `String(round)`
for a usable round and `?` otherwise; `recordIndex` is the record's zero-based
position in the input array, and `entryIndex` is the turn's zero-based position
among entries projected from that record. Every tool call has a `key` derived
as `${turnKey}:t${toolCallIndex}`, where `toolCallIndex` is its zero-based
position in that turn's `toolCalls` array. These keys are unique within one
projection and deterministic when projecting the same input array again.
They are not durable identifiers: filtering, slicing, or appending to the
input array can change keys, and key stability across different input arrays
is not guaranteed.

`toolCalls` is an array of summaries with this public shape:
`{ key, name, id?, toolCallKey?, argsSummary?, resultPreview?, isError?, executionStatus?, durationMs? }`.

| Field | Meaning |
|---|---|
| `key` | Non-empty host-rendering identity for this tool call, derived from its turn key and position; it is not the provider's tool-use ID and not the engine's identity key. |
| `name` | Tool name as supplied by the provider, or an empty string when absent. |
| `id?` | Provider-supplied `tool_use.id`, stringified when present and omitted when absent; it remains the result-association ID, while `blocks[].id` passes through unchanged. |
| `toolCallKey?` | Engine identity key of this call (issue #284): taken from the `tool_use` block’s engine namespace, and from the paired result when the block does not carry one. Unlike `key` it is durable — stable across filtering, slicing, re-projection, and resume — so it is the field to key a host-side card on. Omitted for records written before issue #284, never synthesised. |
| `argsSummary?` | Bounded, one-line summary of the tool input, omitted when there is nothing to summarize. |
| `resultPreview?` | Bounded preview of the associated tool result, omitted when no non-empty result text is available. |
| `isError?` | Whether the associated result explicitly marks an error; omitted when no error flag is present. |
| `executionStatus?` | String execution status supplied by the associated result (top-level key first, falling back to the engine namespace when absent), omitted otherwise. |
| `durationMs?` | Executor settle duration of the paired result (issue #285), copied verbatim from the engine namespace. Omitted when the result has none — interception, interruption, and a call aborted before settling all lack it, and `0` would be a lie. |

Within a record, results are indexed by `tool_use_id` in message order; when
multiple `tool_result` blocks reuse an ID, the last result wins. Every tool
call in that record with the repeated ID receives that same last result. This
is the current behavior, not occurrence-order pairing; provider reuse of a
tool-use ID is degenerate input. Results are matched within one record only,
not across records. A missing provider ID does not prevent the tool call from
having a display `key`.

The result is not frozen or deep-copied. Each turn's `blocks` is a new array,
but ordinary block elements are shared references to the input; changing one
changes the input record. Only a block split to remove a fold marker is rebuilt
as `{ ...block, text: head }`, so changing that block does not change the input
block (nested objects on it remain shallow-shared). Each turn's `meta` object
is new, while nested values such as `meta.usage`, `meta.navigationRecord`,
`meta.foldedRoundRange`, `meta.summary`, `meta.judge`, and `meta.wrapup` are
shared references when present. Treat shared values as immutable if the source
records must remain unchanged.

### Which `RoundRecord` fields a host may render

| Field | Channel | Host guidance |
|---|---|---|
| `textPreview` | display | Bounded assistant text preview. Safe to render; the projection uses it only as a fallback when `response` is absent (legacy records). |
| `summary` | display | Per-round `{ action, note }` summary (or `"missing"`). Safe to render, typically as a one-line round caption. It is **not** the fold summary. |
| `folded` / `foldedRoundRange` | display | Marks a round whose earlier context was folded, and the folded round range. Safe to render as a "this span is collapsed" banner. |
| `foldedFacts` | display / forensics (bounded) | The mechanical stand-in for the **folded early history**: the return value of `buildFoldedFacts()` in `src/compact/fold-summary-journal.js`, `{ text, source, strategy, from, to, rounds, bytes, truncated?, degradeReason? }`, clamped to `FOLDED_FACTS_MAX_BYTES`. Purely additive: `summary` stays *this round's own* summary and is never overwritten by it, and `source` says whether the text came from the strategy or from the summarizer. On resume, `planFoldedHistoryTrim` may use it as the stand-in to drop bodies below the watermark, and reports `strategy` in `summarySource` (the model may never have seen this text) — issue #470. |
| `foldedPayload` | display (bounded) | The raw messages removed by folding **in this round only**: the engine de-duplicates against what the session already archived and clamps the archive to a byte budget (default 262144 bytes, `context.maxFoldedPayloadBytes` > env `ERIX_FOLD_ARCHIVE_MAX_BYTES` > default, `0` = pointers only) — issue #460. It is still an archive, not display text: do **not** dump it into the chat view. The projection reports only `meta.foldedPayloadMessages` (a count). |
> **Resume trims folded history (issue #462).** On resume the engine derives the fold watermark from round records (`foldedRoundRange.to`) and drops the rounds at or below it from the rebuilt context, then re-injects the fold summary the model was already shown (`record.foldedSummary`, planned by `planFoldedHistoryTrim` / `injectFoldSummaryIntoHead` in `src/compact/resume-fold-trim.js`). Hosts therefore see fewer round bodies replayed after a resume — the ledger is never rewritten, all dropped bodies keep their own rows. When **neither** key yields a fact that covers the watermark (transcripts written before these versions, or a fold whose text never reached either key), the resume context stays exactly as before and every body remains visible. Note the two keys carry **different interval shapes** — `foldedSummary` nests `foldedRoundRange.{from,to}` while `foldedFacts` is flat `{from,to}` — and the planner adapts to both (`pickCoveringFoldAlternative`). Since issue #470 a fold made by the built-in fallback strategy *does* carry a `foldedFacts` stand-in, so it is no longer byte-for-byte identical to pre-#462 behaviour: its bodies below the watermark are trimmed too.

> **Delivery hook `onFoldSummary` (issue #470).** The fold stand-in is a piece of **host-side data**, so hosts must not have to poll the ledger or re-derive what `record.foldedFacts` means. `onFoldSummary?.(payload)` is called **once per fold, at the exact point the stand-in is finalised**, with a clone of the very object that goes into the round record plus `round` (`{ ...foldedFacts, round }`: `text`, `source`, `strategy`, `from`, `to`, `rounds`, `bytes`, plus `truncated` / `degradeReason` when set). Four boundaries are contractual: **no text ⇒ no call** (nothing is delivered, and no empty banner is invented); a throwing or rejecting hook is **not** reported through `reportObserverError` but through `reportHostPersistenceFailure`, i.e. a `persistence_error` fact with `port: "notes"`, `operation: "onFoldSummary"`, `phase: "fold_summary_delivery"`, `fatal: false` (ledger + `diagnostics.error` + `onPersistenceError`); such a failure **never rewrites the run's outcome** and never kills the loop; omitting the hook leaves behaviour byte-for-byte unchanged. Assembly validates the shape up front: a non-function value throws `TypeError: onFoldSummary must be a function`, and the accompanying byte cap knob `context.maxFoldedFactsBytes` throws `maxFoldedFactsBytes must be a positive integer` unless it is a safe positive integer (default unchanged at `FOLDED_FACTS_MAX_BYTES` = 2048, so input limit / output budget / host container limit can share one source).

> **Where the hook lives, what the range keys scope to, and why `context.onFoldSummary` is retired (issue #499).** `onFoldSummary` is configured as the assembly policy option (`policy.onFoldSummary`) or as the top-level `runToolLoop({ onFoldSummary })` option — it is **not** read from `context`. A `context.onFoldSummary` is **retired** as of issue #499: the key was removed from the accepted `context` key set (`CONTEXT_OPTION_NAMES` (`src/assembly-validators.js`)), so it is now treated exactly like any other host-metadata key — the assembly-port route reports it in a `context_unknown_option` event, the fine-grained route passes it in silence, and **neither route throws**. Retiring rather than throwing is deliberate: a `context` key is a host-metadata shape, not a misspelled summarizer knob, so throwing would be a break (the #493 doctrine). Earlier revisions of this document described the key as "ignored", which is precisely the silent configuration this retirement removes: the engine never read it, and the whitelist entry only bought the host a green light and **no** event. The same payload carries the fold range (issue #479): `foldedRoundRange {from,to}` is **this** fold's round span, `foldedThrough` is the watermark **after** this fold, and `foldedRoundCount` is the **run-scoped** running total of rounds folded in this run — deliberately not a session/ledger total: after a resume it counts only what the resumed run folded, so a host that wants a session number must add the counts it already received from earlier runs.
>
> **The four caps are `context` knobs (issue #469, host audit B1):** `context.summarizerTimeoutMs` (provider-level **per-call** timeout, default `30000`), `context.summarizerBudgetMs` (strategy-level **whole-step deadline** shared by the first attempt and the context-window self-heal retry, default `30000`), `context.maxSummarizerInputBytes` (folded-window byte cap, default `49152`) and `context.maxPriorSummaryBytes` (continuation-base byte cap, default `24576`). The two timeout names are deliberately **not** collapsed into one: a per-call cap and a whole-step deadline answer different questions. Omitting a key leaves today's value byte-for-byte; an explicitly passed `summarizerTimeoutMs` acts as a **cap** (the smaller of it and the caller's remaining budget), otherwise the key would be silently overridden by the step deadline. Both entry routes validate both shapes up front through one shared gate (issue #496): a non-safe positive integer throws `TypeError: <key> must be a positive integer`, and an **unknown** `context` sub-key throws `unknown assembly policy context option: "…"` instead of being silently ignored (the `#331` shape). All four apply to the **built-in name form** only (`context.strategy: "fold-llm"`); an object-form strategy brings its own summarizer, so those caps are the host's own. **`context.maxSummaryTokens` is the fifth knob (issue #493, downstream fde-station):** it sets the summary's output budget (default `1400`) and it also **caps that one request's `maxTokens`** — the summary call used to inherit the run's `maxTokens` verbatim (32768 measured), so the model filled 32k and the result was then trimmed back to 1400: pure waste. The two are now aligned as `min(run maxTokens, maxSummaryTokens)`. **Unknown `context` keys are validated by family, not wholesale:** a misspelled summarizer knob (`maxPriorSummaryByte`, `summarizeBudgetMs`) — detected as **edit distance ≤ 2 to a known knob name**, not as "anything containing `summar`", so business keys such as `summaryStyle` or `summarizerNote` stay legal — throws on both routes, while any other unknown key is **tolerated as host metadata** (`src/loop/budget.js` itself reads `toolContext`, `expert`, `user`, `session`, `requestId` from `context`, and the opening section tells hosts to keep private metadata there) — a tolerated key is reported through a `context_unknown_option` event on the assembly-port route (the fine-grained route never emits that event, so it passes silently) instead of blocking the host. **Two operational notes:** the reuse fingerprint now includes the continuation base, so an **existing ledger misses once after upgrading** and that first resumed fold recomputes one summary; and when a **single round alone exceeds** the 48 KB input cap, no whole round can be dropped (`droppedRounds` stays 0) — the token guard is what trims individual messages in that case, and the omission note records it.
>
> **The continuation base is ledger-scoped (issue #469, host ruling A):** on a resumed run the first fold is seeded from the ledger, using the same "pick the alternative that covers the current watermark" rule the read-side trim uses (`pickCoveringFoldSummary` first, then `record.foldedFacts`; both the nested `foldedRoundRange.{from,to}` and the flat `{from,to}` shapes are accepted). Priority is contractual: **explicit call argument > strategy construction option > in-run closure > ledger seed**, so a non-resumed run — or one where no fact covers the watermark — is byte-for-byte what it was before. `compactionStats[].foldSummary` gains `priorSummaryOrigin: "ledger" | "in-run"` (no base ⇒ no key, the family's "no fact, no key" rule). The reuse fingerprint **includes the base**, so the first fold of a resumed run recomputes once instead of silently ignoring the seeded base (deliberate trade: one fewer cache hit beats a silently dropped thread).
>
> **The five-section summary contract is self-consistent by default (issue #469, host audit C):** `maxSummaryTokens` now defaults to `1400`, which is what a five-section summary of ~150 CJK characters per section actually costs (~1335 tokens measured); at the old `800` the contract only held for ~80 characters per section, so a compliant model answer was silently cut down to two of five sections. When the budget *is* tight, sections are pruned **lowest priority first and the heading is kept** (`## 标题` + a `[已修剪]` body) — a lost skeleton is harder to diagnose than lost prose, and the next fold's summarizer would not even know the section existed. Priority is now: `## 下一步` / `## 恢复提示` and `## 主题词面包屑` first, then `## 已验证项`, then `## 已改文件`. **`foldSummary.finishReason` value domain:** it is passed through as the provider normalized it (`end_turn`, `max_tokens`, `stop_sequence`, …); `max_tokens` means the summary itself was truncated by the model's output budget and is **not** a complete summary. Hosts must treat an unknown value as "unknown", never as "fine".
>
> **The fold summarizer call itself (issue #469 ①②③, erix-station ruling 2026-10-26).** Three boundaries are contractual, not configurable defaults. **(1) Thinking is explicitly off:** the request carries `reasoning_effort: "none"` **and** `enable_thinking: false` **and** `chat_template_kwargs: {"thinking": false}` — never relying on the model's default (a real run still produced 584 `reasoning_token` with `reasoning_effort` alone). A provider that rejects unknown fields may opt out with `thinkingMode: "inherit"`. **(2) 30 s is the deadline of the whole summarizer step, not of each attempt:** the remaining budget is handed to every attempt as `timeoutMs`, so the context-window self-heal retry shares the same 30 s; with less than 2 s left no retry happens and `budgetExhausted` is recorded. **A timeout is never retried.** **(3) Input scope is fixed:** only the rounds being folded **plus the previous fold summary** (the continuation base, separately budgeted at 24 KB, head-truncated and flagged as `priorSummaryTruncated`) — live, unfolded context is never fed (that is double spend *and* it invites the summary to restate what the model can still see). The folded window is capped at **48 KB** in bytes and trimmed by **whole rounds**, oldest first, never mid-round; the separate token guard derived from `budgetTokens` is the last line of defence against the model window and **may** drop individual oldest messages, so the 48 KB cap must not be read as "rounds are never split". Both layers leave an omission note.
| `foldedPayloadMeta` | display / forensics | `{ messages, bytes, capBytes, droppedMessages, droppedBytes, dedupedMessages, dedupedBytes }` — how much of the fold this archive actually carries, plus `rejectedByHost: true` when the host bounded the single record, the engine dropped the archive and retried. Advisory; safe to render as a "archive truncated" caption. |
| `navigationRecord` | display | Bounded archive pointers `{ roundFrom, roundTo, artifacts[], truncated? }` for recovered tool outputs. Render as navigation links/pointers, never as message content. |
| `messages` | model | The exact model-context slice, including `tool_use`/`tool_result` blocks and fold placeholders. Do not render it raw; the projection extracts displayable text and tool-call summaries from it. Since issue #335 this is also the **canonical source of the projected assistant body** (a message is persisted the moment it forms); `response.content` is only the legacy/host-written fallback. |
| `messages[].meta` | model / engine | Preserve this object, including unknown keys. `meta.source` is an engine-reserved marker used by projection classification and judge visibility; do not reuse it for host-owned source information. |
| `response` | model | Full provider response content (`text`, `reasoning`, `tool_use` blocks), `stopReason`, `usage`. Projected display text/blocks come from `messages`, not from here; only `stopReason`/`usage` are copied into the projection's `meta`. Its block shape is model-facing and may change. **Its `usage` is the last response of the round only** — the round's complete ledger is the sibling key `record.usage` (see "Usage accounting: the round ledger vs engine overhead (issue #438)"). |
| `l0facts`, `runState`, `compactionStats`, `judge`, `wrapup`, `toolOutputs`, `dedupKey`, `roundKey` | model / engine internals | Facts for the governor, resume, and diagnostics. Only `judge`/`wrapup`/`summary`/`stopReason`/`usage`/`toolUses`/`dedupKey` are copied into the projection's `meta` for optional labelling; the rest is not part of the display surface. |

### Stability promise

The **projection output shape is the contract surface hosts may depend on long
term**: `key`, `role`, `text`, `blocks`, `toolCalls` (including each tool call's
`key`), `reasoning`, `folded`, `round`, `ts`, `meta`. `RoundRecord` internals
are not. Field names, nesting, and
block shapes inside `messages`/`response`/`foldedPayload`/`runState` may change
between minor versions as long as the projection keeps producing the same
shape. Additions to projection entries and to `meta` are non-breaking; hosts must
ignore unknown `meta` keys and must not assert on key order. Breaking changes to
the projection shape follow the normal versioned-migration policy and are
announced in the upgrade guide.

`blocks` is the passthrough block array for hosts that want richer rendering
(code blocks, images, structured tool input). Hosts that only show plain text
should use `text` and `reasoning` instead.

### Folded rounds

A folded round is rendered as **summary plus range**, never as the original
payload:

- The projection emits a `role: "system"`, `folded: true` turn before the
  round's own content. Its `text` is the engine's marked fold summary when the
  record carries it (a resumed seed record keeps the summary block inside the
  head task message; the projection splits it out of the user bubble), and
  otherwise a bounded composition of `foldedRoundRange`, `summary`, and the
  `navigationRecord` artifact count.
- `meta.foldedRoundRange`, `meta.navigationRecord`, and
  `meta.foldedPayloadMessages` are provided for the host's collapsed-segment UI
  ("this span is folded, summary below", plus archive links).
- The host must not render `foldedPayload` content in the chat stream. It is the
  folded-away original material, kept for recovery and anchoring; showing it
  defeats the fold and re-introduces the payload the model no longer sees.
- **The archive is advisory and bounded (issue #460).** A host may bound a single
  record (this site: 1 MB). A host `400` on an oversized record must **not**
  become a run-ending `persistence_failed`: the engine strips `foldedPayload`,
  retries `appendRound` once, and records one non-fatal (`fatal: false`)
  persistence fact; the degraded record carries
  `foldedPayloadMeta.rejectedByHost: true`. Only a retry that fails too ends the
  run. Hosts must not read a missing or truncated archive as data loss: the
  originals are already persisted in their own round rows, and
  `foldedRoundRange` plus `navigationRecord` remain the bounded pointers.

### Reasoning

`reasoning` holds the round's reasoning text (canonical `reasoning` blocks plus
the provider-normalized `thinking`/`reasoning_content` shapes) and is **never**
merged into `text`. Recommendation: show it in a collapsed/expandable block by
default, since it is long and noisy, and keep it visually distinct from the
answer. Hosts must not silently drop reasoning from their own storage when they
also replay history to the model — reasoning replay is a model-side contract
(see the thinking-mode requirement), independent of this display field. Since
issue #407 the streaming path also folds `delta.reasoning` (either the string or
the `{ content: "…" }` shape) and `delta.reasoning_text` into that same canonical
`reasoning` block, so which name a relay uses no longer decides whether this
field has anything in it: the name follows the **request body**, not the model
(`streamReasoningText` (`src/providers/openai.js`)). One asymmetry is still open
— `reasoning_text` is not recognised on the non-streaming path.

### Synthetic messages

Runtime-injected messages are model-visible but not user-authored. The
projection keeps the underlying role (usually `user`, sometimes `system`) and
labels them:

- `meta.synthetic: true` for every non-user-authored turn; real user and
  assistant turns carry `meta.synthetic: false`.
- `meta.source` names the injector when the transcript carries the marker: `judge-control`
  (engine-authored control text: round-judge direction hints and continuation nudges, the
  extend / extend+redirect continuation text, the `finalGuard` `revise` message, the
  forced-wrap-up instruction, and the direction hint written into the snapshot by the
  blocked intercept path — issue #323), `audit-intercept`
  (repeated-command intercept text), `system`, `fold-summary` (the fold banner),
  `wrapup`, or `textPreview` (legacy preview fallback for the assistant turn).
- `judge-control` messages stay in the model-visible conversation (the main model must
  still see them); they are excluded only from the judge's own input, via the judge
  module's conversation rendering (`renderConversation`, same module as the
  `judge-control` exclusion documented above). Hosts must not delete them from
  transcript or context on the basis of that exclusion.
- `message.meta.source` is engine-reserved: the projection treats **any
  non-empty string** value as synthetic. Hosts must not store ordinary source
  information there, because that would misclassify a real message.
- `meta.sourceInferred: true` is added only when the projection classifies a
  synthetic message by matching a configured text prefix. It is an additive
  `meta` field (hosts must ignore unknown `meta` keys) that a UI may optionally
  show as "classification inferred heuristically". It is not a detector for a
  lossy store. It is absent when `message.meta.source` supplies the
  classification and when `role: "system"` alone makes the message synthetic.
- Round-level judgements appear in `meta.judge` and `meta.wrapup` when present,
  so a host can label a round without parsing prose.

Hosts should render synthetic turns distinctly (badge, muted style) or fold them
away, but should not drop them from a view that claims to mirror the transcript.

### Anti-pattern

Do not treat a second, lossy message table as the source of truth for model
context. A UI table that keeps only `{ role, text }` cannot round-trip tool
calls, reasoning, or fold state; once it exists, hosts are forced to re-inject
history into the model and thinking-mode providers reject text-only assistant
history. The supported pattern is single-store: the transcript stays the model
context, and every UI view is derived from it through
`projectTranscriptForDisplay` (the same theme as #91 and #135). Host-specific
anchors (session id, sequence number, attachments, run attribution) may live
beside the transcript, but message content must not be duplicated there.

## Run state

The engine builds a deterministic run state and can inject its bounded
rendering when context is folded. It replaces the single existing run-state
block rather than appending duplicates, and persists the current state with
`saveRunState` when the supplied `TranscriptStore` supports it. The
deterministic portion contains engine-known facts only: budget, tool call
counts and failures, written-file paths, injected todo state,
fold/navigation counts, termination, and tool/checkpoint/unpersisted error
counts. The current termination reason is exposed through the same
termination values as the loop, including `end_turn`, `no_tool`, `stall`,
`max_rounds_cap`, `judge_done`,
`continuation_exhausted`, `final_guard_unverified`, `aborted`, and `failed`.

`todoStateProvider` is an optional host callback for todo state.
`semanticStateProvider` is an optional host callback that supplies bounded
semantic text and a version. A version mismatch marks the semantic portion
`stale`; semantic data is additive and cannot overwrite deterministic facts.
The engine does not call a model to obtain semantic state.
**When the semantic portion is refreshed (issue #479, contractual):** `refreshRunState` is called with
`{ semantic: persistInject || requestInject, inject: persistInject }`, so `semanticStateProvider` runs only
when the engine is about to inject run state into the next request (low-budget injection or a requested
injection). A fold that happens **without** such an injection therefore still lands in the ledger and in the
session directory, but the note does not re-enter the model-visible context in that same round; it becomes
visible on the next ordinary injection. Hosts may rely on that boundary — it is behaviour, not an accident.

The persisted object is bounded by
`RUN_STATE_MAX_SERIALIZED_BYTES` (`64 * 1024`). The rendered prompt block is
bounded by `RUN_STATE_MAX_CHARS` (`1600`). The run-state helpers also cap tool
entries at 128, file entries at 128, todo entries at 64, ordinary bounded
name/path/id/status fields at 120 characters, and semantic source text at
1200 characters (multi-line: newlines are preserved so each directory entry
renders on its own line, at most 16 lines, and a line-count cut is reported as
`... (semantic lines truncated: N more)`). When entries or serialized state are
trimmed, `bounds.truncated` and the applicable omission counts are explicit;
the rendered block uses `[run state truncated]` when its 1600-character limit
is reached. Character-level trimming of the semantic text itself is reported by
the persisted `semantic.truncated` flag rather than rendered inline. The closing
`[/run state]` marker is always appended after rendering, so it survives
truncation and replaces the previous block in place instead of accumulating a
second copy.

`deterministic.compactionStats` is a **window**, not a full history: it keeps
only the last 32 entries so the state file stays bounded. Since issue #315 the
file says so itself — `deterministic.compactionStatsWindow`
(`{ limit, dropped, total }`) records the window size, how many entries were
dropped, and how many the run actually produced, so a host never has to read the
engine source to tell whether it is holding the whole array or its tail.
`total > limit` (equivalently `dropped > 0`) means the file is a tail; the run
result's `compactionStats` is still the full array. The field is present only
when the run produced at least one entry (`total > 0`); with no stats there is
nothing to truncate and the absence is not ambiguous. `bounds.truncated` covers
size-driven trims (tool/file/todo entries and serialized-size cuts), not this
fixed window; read the window field instead. A state written before this field
existed has no `compactionStatsWindow` and stays readable.

An unknown schema or incomplete persisted state is not silently treated as a
valid default. On resume it is exposed as
`runState.stateAvailability.status = "state_unavailable"` (for example,
`unknown_schema` or `missing_fields`). A corrupt file-store JSON state is also
reported as unavailable rather than restored. An entirely absent persisted
state is normal and is not the same as a present but invalid state.
`stateAvailability` is a diagnostic observation from the current resume attempt;
it is retained in persisted state but does not by itself reject a structurally
valid state on a later resume.

## erix_run final face: per-layer compaction and notes counters (issue #313)

The engine has reported per-layer compaction for every round all along: each `compactionStats`
entry carries a `layers` map keyed by the real layer ids derived from `COMPACTION_LAYER_IDS`
(`src/compact/pipeline.js`), filled by `observeCompactionLayer` (`src/compact/pipeline.js`) at
the loop's observation points and normalized by `createCompactionStat` (`src/compact/pipeline.js`).
The `erix_run` host extension used to fold those entries into three scalars and drop the map, so
a run whose `ttl` layer folded 69 tool results and saved 650,581 tokens still printed
`compaction=0/1` and was read as "compaction did nothing". `buildDiagnostics`
(`examples/pi-extension/erix-run-core.js`) now keeps the layers and the notes counters in the
final face. **Additive only**: the meaning and the values of `compacted` and `foldedRounds` are
unchanged, and `diagnostics.compaction.events` / `.compactedRounds` / `.foldedRounds` are exactly
what they were before this section exists.

| Final-face field | Real source | Meaning |
| --- | --- | --- |
| `diagnostics.compaction.events` / `.compactedRounds` / `.foldedRounds` | the `compactionStats` array | unchanged since before #313. The pair printed as `compaction=<compactedRounds>/<events>` is **not** "compaction had no effect" |
| `diagnostics.compaction.layers.roundsObserved` | stats entries that carry a `layers` object | how many round entries were actually evaluated for layers; `0` makes the text render `unknown` rather than "saved nothing" |
| `diagnostics.compaction.layers.tokensBeforePeak` | the maximum `tokensBefore` over those entries | the largest pre-compaction context the run reached |
| `diagnostics.compaction.layers.byLayerId.<id>` | `summarizeCompactionLayers` (`examples/pi-extension/erix-run-core.js`) summing `layers.<id>` across entries | `{triggered, tokensSaved}` per **engine-declared layer id**; this layer never invents or renames an id |
| `diagnostics.compaction.layers.roles[]` | `COMPACTION_LAYER_ROLES` (`examples/pi-extension/erix-run-core.js`) | the separately named buckets the text renders: `wholeRoundFold` (`slidingWindow`+`foldStatistical`+`foldLlm`), `ttlResultFold` (`ttl`), `outputClamp` (`enforceSize`), `foldFidelity` (`anchors`) |
| `diagnostics.compaction.layers.unattributed[]` | layer ids present in the data that no bucket names | forward-compatibility rail: a layer the engine adds later is still rendered, it cannot be swallowed by the bucket table |
| `diagnostics.notes.writes` / `.reads` / `.byName` / `.unclassified` | `countNoteToolEvent` (`examples/pi-extension/erix-run-core.js`) counting `tool_use` events off `onEvent` | write = `note_take` / `note_forget` (both move the store), read = `note_read` / `note_list`; an unrecognized `note_*` name goes only into `byName` / `unclassified` and is never folded into those two numbers |
| `diagnostics.notes.source` | `NOTE_COUNT_SOURCE` (`examples/pi-extension/erix-run-core.js`) | always `onEvent:tool_use`: the counters read the event stream, they are not computed out of some other field |
| `diagnostics.modelMetadataMissingEvents.count` | the `model_metadata_missing` events received by `onEvent` | event count. The pre-existing `modelMetadataMissing` flag keeps its own meaning and value |
| `diagnostics.notes.observed` / `diagnostics.modelMetadataMissingEvents.observed` | set when the inner loop was entered | `false` ⇒ the text renders `unknown`. A run that failed during assembly produced no event at all, and "no events" is not "zero calls" |

| `diagnostics.compaction.layers.source` / `.truncationNote` / `.compactionStatsWindow` | `COMPACTION_STATS_SOURCE` / `COMPACTION_STATS_TRUNCATION_NOTE` (`examples/pi-extension/erix-run-core.js`); the window account is read from `<runId>.state.json` (`readRunStateFile`) | which `compactionStats` the summary read: the **full** array on the run result (or the throw payload). The copy in `<runId>.state.json` goes through `normalizeCompactionStats(value, limit)` (`src/compact/pipeline.js`) from `createDeterministicRunState` (`src/run-state.js`), i.e. `value.slice(-limit)` keeps only the **last `limit`** entries — on a long run, counting off that file silently under-counts. Since issue #315 the file self-reports that window as `deterministic.compactionStatsWindow` (`{ limit, dropped, total }`); since issue #373 `truncationNote` **quotes those numbers from the file** (`layers.compactionStatsWindow` carries the same account structurally), and a file without that field (older run) says plainly that its entry count must not be read as the number of compactions |

`formatCompactionLayerSummary` (`examples/pi-extension/erix-run-core.js`) renders the buckets one
per line, so the accident run above now reads:

```text
[diagnostics] model=… compaction=0/2（=compactedRounds/events，不等于「压缩没生效」） … model_metadata_missing=YES events=1
  ↳ 整轮折叠（slidingWindow+foldStatistical+foldLlm）=0 次/0 tok
  ↳ 逐条TTL削减（ttl）=69 次/650581 tok
  ↳ 输出钳制（enforceSize）=0 次/0 tok
  ↳ 折叠锚点（anchors）=0 次/0 tok
  ↳ 分层观测=2 条评估条目，tokensBefore 峰值 130000
  ↳ 来源 runResult.compactionStats（全量）；若改读 state.json：该文件自报 deterministic.compactionStatsWindow：limit=32、dropped=0、total=2——没有丢条目，这份窗口就是全量
  ↳ notes 写=2/读=2 ｜ note_take=2 note_read=1 note_list=1 ｜ 来源 onEvent:tool_use
```

Host rules:

- Read layer savings from `layers.byLayerId` / `layers.roles`, never off `compacted` /
  `compactedRounds`: a run with `foldedRounds = 0` can still carry the whole savings in `ttl`.
- Treat `unknown` as "not measured", not as `0`; the extension renders it whenever the source of
  a counter did not exist, and it never estimates a number out of a neighbouring field.
- Do not match on layer ids that are not in `COMPACTION_LAYER_IDS` (`src/compact/pipeline.js`):
  the buckets above name engine ids, and anything new shows up in `layers.unattributed`.
- The final face reports its own data source (`layers.source`). Read it off the run result; if a
  host instead re-reads `<runId>.state.json`, it is reading a **last-32** window and must not
  present the totals as whole-run savings. That file self-reports the window since issue #315 as
  `deterministic.compactionStatsWindow` (`{ limit, dropped, total }`, see the Run state section).

## Contract test suites (issue #183)

`erix-agent/contract-tests` (the `./contract-tests` subpath export,
`test/contract/index.js`) ships ten suite files exposing **twelve** reusable
`node:test` registration functions (`execute-tool.js` carries two: the current and
the migration shape; `notes-store.js` carries two since issue #183: the general
suite and the optional CAS sub-suite). Every one is shaped `xxxContract(label, factory)`:
calling it registers assertions titled with `label`, and nothing executes until
`node --test` runs them. `npm run check:docs:strict` fails on any suite that
`test/contract/index.js` re-exports but the packaged `files` list omits (it is a
warn under the plain `npm run check:docs`), so the shipped set cannot shrink
unnoticed. **What ships is those files one by one**: `package.json`'s `files`
enumerates `test/contract/*.js` entry by entry — it does **not** take the
directory — so a `node --test` suite in the same folder is deliberately left
out. Measured: `npm pack --dry-run --json` lists **zero** `.test.js` files
(which is why `boundary-parity.test.js` (`test/contract/boundary-parity.test.js`),
which imports `test/helpers/`, never lands in a tarball), while the ten suite
files above are all listed by name. `toolResultEnvelopeContract` is the newest of the twelve (issue #284 / #285),
`skillsLoaderContract` is next (issue #197) and `fileToolsContract` follows
(issue #184): a host on an installed 0.18.0
has nine suite files and eleven registration functions, not ten and twelve.

**What each of the two numbers counts (measured)**: suite files = the `.js` files under
`test/contract/` other than `test/contract/index.js`, ten of them
(`test/contract/transcript-store.js`, `test/contract/model-config-provider.js`,
`test/contract/execute-tool.js`, `test/contract/assembly-port.js`,
`test/contract/notes-store.js`, `test/contract/engine-api.js`,
`test/contract/termination-payload.js`, `test/contract/file-tools.js`,
`test/contract/skills-loader.js`, `test/contract/tool-result-envelope.js`);
registration functions = the names `test/contract/index.js` re-exports, twelve of them
(`Object.keys(await import("erix-agent/contract-tests")).length` measured 12). Neither number
includes `test/contract/index.js` itself, and neither includes the same-directory `*.test.js`
files that are deliberately left out of the tarball.

### What the suites prove, and what they cannot prove (issue #183)

**A suite asserts the behaviour of the upstream implementation at the version
you installed.** Its value is a **drift sentinel for engine upgrades**: when you
bump `erix-agent`, re-run the suites against your own adapters and a red
assertion names the contract that moved. It is **not** a host conformance test,
and it cannot replace the host's own consistency tests:

- A suite pins only the assertions upstream actually wrote. Semantics your
  implementation adds, omits, or reinterprets *beyond* upstream's surface are
  invisible to it — nothing asserts what upstream never exercises.
- touwaka's evidence: deliberately changing its transcript store into a semantic
  upstream does not have left every shipped suite **green**. The suite did not
  disagree with the change because the change was outside its field of view.
- The same asymmetry cuts the other way: a green suite says nothing about your
  schema, your migration, your connection handling, or your cleanup. Those are
  adapter tests and stay yours (this is the standing rule in each suite header).
- So wire them as a **sentinel, not a gate on your own semantics**: run them on
  every engine version bump and treat a red assertion as a changelog line; keep
  a separate host-owned suite for the behaviour your implementation invented.
  Weakening a shipped assertion to make an upgrade pass discards the only signal
  the suite carries (the 0.16.0 guide says the same thing for the fidelity and
  ordering pair).
- A **relaxation is also a signal.** When a bump turns a previously red suite
  green, upstream widened a promise — read that as a changelog line too, because
  it is usually the licence your adapter was waiting for. Issue #183 is exactly
  that shape: `revoke` now promises observable disappearance (a tombstone *or*
  physical deletion), the last-write-wins concurrency assertion moved out of the
  general notes suite into the file adapter's own tests, and a compare-and-swap
  host gained the optional `notesStoreCasContract`. Nothing in that list makes an
  adapter that already passed go red, and nothing in it certifies a host either:
  the assertions that were relaxed stopped testing the relaxed-away behaviour
  upstream, so the host-side guarantee (if you want one) is now yours.
- A **tightening is the mirror case (issue #265).** The notes suite gained four
  assertions for behaviour the port typedef had already promised but the suite
  never exercised: an empty `filters.state` array and an unknown `filters.source`
  must throw `TypeError`, a visible revoke tombstone must carry `revoked_at` and
  `revoke_reason`, and `purge` must count scopes (not records) in `scanned` while
  `before` only shrinks the deletion window. They were added after the engine's
  own hand-ported in-memory adapter measured red on the suite — so a host adapter
  that silently ignored one of these behaviours will see **new failures** on the
  next engine bump. That is the sentinel reporting drift, not a new promise
  invented at suite level: every one of the four was already in the typedef.

**Where a suite asserts `deepEqual` on a record, that assertion is JSON-value
equality (issue #183 item 6).** It is testable and it is bounded, and both halves
are part of the promise:

- **every field of the JSON value comes back**, not a whitelisted subset: fields
  upstream does not know about (`extension`, a future metadata key) must survive
  the round trip exactly as written;
- **array order is part of the value**: `superseded`, `tags`, and `current.content`
  blocks come back element-for-element in the same order;
- **object key order carries no meaning** — two records that differ only in key
  order are equal, and a host is free to re-serialize;
- **values JSON cannot express are outside the promise**: `undefined` members, a
  value the JSON encoder drops, a `Date`/`BigInt`/`RegExp` instance, a function,
  `NaN`/`Infinity`, or a shared/cyclic reference. A record that reached the store
  through JSON is compared as JSON; a host that keeps such a value must project
  it to a JSON form at the port exit, which is exactly what the ruling asks of
  host-owned metadata columns (`record_version`, `expires_at`): keep them in the
  schema, drop them from the public record shape so the shape that goes in is the
  shape that comes out.

### Standard usage (issue #183)

Inject your implementation as the factory argument; `label` is the prefix of
every generated test title, so use one stable name per adapter. The suites are
registration-only, so an ordinary `node --test` run of your test tree executes
them. The factory must hand out a **clean** implementation on every call — each
assertion group treats it as a fresh namespace and several suites re-enter it:

```js
import { notesStoreCasContract, notesStoreContract, transcriptStoreContract } from "erix-agent/contract-tests";
import { createFileNotesStore, createMemoryNotesStore, createMemoryTranscriptStore } from "erix-agent";

transcriptStoreContract("my-host-store", () => createMemoryTranscriptStore());
// "clean on every call": hand out a fresh namespace per factory call — here a
// fresh subdirectory under the host's notes root
notesStoreContract("my-host-store", () => createFileNotesStore({ dir: mkdtempSync(notesDir + "/general-") }));
// the engine ships an in-memory NotesStore adapter since issue #265: register the
// same suite under a second label — the shape a host adapter is held to as well
notesStoreContract("my-memory-adapter", () => createMemoryNotesStore());
// optional sub-suite for a compare-and-swap store: it only requires at most one
// concurrent writer to fail and the winner to stay readable
notesStoreCasContract("my-host-store", () => createFileNotesStore({ dir: mkdtempSync(notesDir + "/cas-") }));
```

Since issue #265 the engine itself ships two NotesStore adapters — the file one
(`createFileNotesStore`) and an in-memory one (`createMemoryNotesStore`) — and
both run against this same suite in-repo, table-driven, under distinct labels.
They share a single implementation of the port semantics
(`src/store/notes-port.js`, internal, not exported): a host writing a third
adapter is held to exactly the same bar and gets the same failures for the same
omissions.

The same shape covers the rest; only the second argument differs:

| suite | second argument | what the factory must hand back |
|---|---|---|
| `transcriptStoreContract(label, createStore)` | factory | a clean `TranscriptStore` (required tier `appendRound`/`load`; the run-snapshot, run-state, and issue #157 probe methods are exercised when present) |
| `notesStoreContract(label, createStore)` | factory | a clean `NotesStore` (write/read/list/complete/revoke/purge) |
| `notesStoreCasContract(label, createStore)` | factory | the same `NotesStore`, registered **in addition** by a compare-and-swap host (issue #183): the concurrency assertion tolerates one writer being rejected instead of requiring both writes to land |
| `modelConfigProviderContract(label, setup, unknownSlot)` | async setup + a **mandatory** shape declaration | `{ provider, slot, expect: { defaultModel, slotModel, materializedKey } }`; the provider needs a `default` slot plus `slot`, whose key is reachable through an indirect reference. `unknownSlot` says which shape the provider is (issue #518): `{ mode: "throws", name, available }` for a slot map (an explicit unknown name must throw, naming the name and listing `available`), `{ mode: "single-config", name }` for a provider that carries exactly one config and ignores the slot name |
| `executeToolContract(label, createExecutor)` | factory | your `executeTool` function (or `{ executeTool }`) |
| `executeToolMigrationContract(label, createExecutor)` | factory | the same executor, asserted against the retired positional call shape |
| `assemblyPortContract(label, createPort)` | factory | your `AssemblyPort` object; the suite starts a real `runToolLoop` on it |
| `engineApiContract(label, getEntry)` | factory | the **package entry namespace**, i.e. `() => import("erix-agent")` — it asserts exported engine API, not your code |
| `terminationPayloadContract(label, getEntry)` | factory | the same entry namespace (`{ runToolLoop }`); it brings its own provider stub |
| `skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })` | three functions, not a factory | the skill-package loader a host wires in; it asserts the caller-owned `bundledDir`, the bundled → global → project precedence, the non-blocking `{skillId, dir, error}` failure shape, and the `ToolSchema` output shape |
| `toolResultEnvelopeContract(label, getEntry)` | factory | the same entry namespace (`{ runToolLoop, createMemoryTranscriptStore, projectTranscriptForDisplay, TOOL_RESULT_CONTRACT }`); it brings its own provider stubs and asserts the engine’s own tool-fact output, so it is a sentinel rather than a host conformance test |

### Suite inventory (issue #183)

"Harness" is what the suite runs against: your factory (host-side) or the
packaged engine (upstream-side, i.e. a pure drift sentinel).

| suite | what it asserts | yours to satisfy | upstream-internal detail it also pins |
|---|---|---|---|
| `transcript-store.js` (22 tests) | record round-trip fidelity (blocks, metadata, unknown fields, `meta.source`), same-round append order, unknown-key → `[]`, multi-run isolation, run-snapshot latest-only overwrite, run-state snapshot without `state`, throw-on-write-failure, `round: 0` seed, folded payload round-trip, the paired probe tier, and the same-key idempotency/conflict tier (issue #326: same payload replays — including drifted top-level `ts`/`round` and reordered fields — are no-ops, a differing payload rejects with `code` `dedup_payload_conflict`, array order and host-owned fields count as payload, and the fallback `roundKey`/`<runId>:round:<n>` keys are covered) | every one of them: it is the `TranscriptStore` contract, and the shipped fidelity/ordering assertions are exactly the ones a rebuild-from-whitelist adapter fails | the `:input:`/`:engine:round:` key shapes, the `(record.dedupKey ?? record.roundKey)` predicate and its `??`-not-`OR` fork (issue #171), `null`/`undefined` probe-result tolerance, the `dedup_payload_conflict` code |
| `notes-store.js` (9 tests) | port validation (`assertNotesStore`), malformed-record rejection before persistence, full record round-trip, scope isolation and explicit misses, unsafe-scope round-trip through lifecycle, the `limit` threshold (more than 200 stored records: a given limit clamps to exactly 200, an illegal limit throws), `revoke`'s observable disappearance with the `expectedState`/`expectedUpdatedAt` guards, and — since issue #265 — rejection of an empty `filters.state` array and an unknown `filters.source`, `revoked_at`/`revoke_reason` visible on a revoke tombstone, and `purge` scanning scopes (not records) with `before` only shrinking the window | the port surface and the record/guard semantics. Since issue #183 the split between upstream mandate and host policy is explicit: the port mandates observable disappearance (tombstone **or** physical delete) and leaves record expiry to the host, while the one-writer last-write-wins behaviour is the file adapter's own business and is no longer asserted here. The #265 additions only assert typedef-promised behaviour, but they are new assertions on a published surface: a host adapter that ignored one of them goes red after the bump | the file-store-shaped error texts (`/valid NoteRecord/`, `/parseable date/`, `/positive safe integer/`, `/filters\.state/`, `/filters\.source/`), retention/purge timing |
| `notes-store.js` → `notesStoreCasContract` (1 test, optional; issue #183) | concurrent same-key writers: at most one may fail, a failure must be a thrown error rather than a silent drop, and the winner is the record that stays readable in its full shape | compare-and-swap hosts only, and only in addition to `notesStoreContract` — this sub-suite is deliberately weaker than the retired last-write-wins assertion, so passing it says nothing about a store that serializes writers | the two payload contents it happens to exercise (`left`/`right`), not any conflict error text |
| `assembly-port.js` (5 tests) | a port boots a real loop to completion, `emit(type, payload)` receives the event types with their payload, an explicit fine-grained `provider` option overrides the port's provider on the **direct** route, `assemblyPortOptions(port, { provider })` is rejected at startup on the **override channel** (issue #498), and a provider missing `chat`/`chatStream` is rejected at startup by both `createAssemblyPort` and `runToolLoop` | your port's required adapters and its `emit` sink | the precedence rule (explicit option over port, direct route), the override-channel conflict text, the startup-validation error text |
| `execute-tool.js` (7 tests) + `execute-tool-migration-contract` (2 tests) | your executor receives exactly one structured execution object, and each canonical return form (`string`, `{content, metadata, success}`, legacy `{data}`, returned `Error`, thrown `Error`) becomes the documented `tool_result` | the call shape and the return shapes. The migration suite additionally proves that a bare positional `(name, input)` executor is **rejected**, not silently supported | that the assertions are observed through `runToolLoop`'s provider request rather than through a public result field |
| `model-config-provider.js` (4 tests) | `resolve()` → default slot, `resolve(slot)` → named slot, unknown slot → default fallback, and `apiKey` indirect-reference materialisation (ADR-001) | your provider's slot resolution and key materialisation | nothing engine-side: it never loads the engine |
| `engine-api.js` (2 tests) | the package entry exports `appendUserTurn` and `projectTranscriptForDisplay` as functions, and `appendUserTurn` completes one pre-write against a minimal store stub (including the `dedupKey`/`roundKey` shape and that the pre-write feeds the display projection) | nothing — this is an entry-surface sentinel; it goes red when an upstream bump renames or drops engine API | the exact pre-write record shape (`round: 0`, `dedupKey`, `roundKey`, `ts`) |
| `termination-payload.js` (4 tests) | a `failed` terminal outcome carries `termination.errorCode` (classification passthrough, `unknown` fallback), an abort throws with `usage`/`rounds`/`finalText` and `termination.partial`, cumulative usage is attributed per round, and the success path keeps its old shape (no `errorCode`/`partial`/`usage` appearing out of nowhere) | nothing directly — it is your host-side decision table's regression net (issue #170 / #176 / #180) | the stubbed provider script, the zero-vs-missing-field rule for `usage` |
| `tool-result-envelope.js` (26 tests) | the field ownership of every `tool_result` the engine builds, asserted against `TOOL_RESULT_CONTRACT` itself: the protocol fields stay at the top level, engine facts only appear under `erix`, host extensions appear only under `metadata` (no host key is flattened to the top level any more, and none of the retired top-level names may reappear), all six executor return forms carry `toolCallKey`/`round`/`durationMs`, interception and interrupted replay carry **no** `durationMs` and no `round`, a replayed completed result is returned with its original values (`durationMs` never recomputed, the executor never re-invoked), the stream fragment, the `tool_use` block, the `tool_result` and the projection all carry one identity key, the provider pairing id is never rewritten, and the projection omits `toolCallKey`/`durationMs` for pre-issue-#284 records instead of inventing them | nothing — the fact surface is engine-owned, so this is a pure drift sentinel (it also fails if the constant itself is trimmed) | the stubbed provider/judge scripts and the run-snapshot shapes it hand-writes, the `tc_` key format, the fact that the loop forwards no `tool_call` event to `onEvent` |

### Wiring rule for hosts

- Run every host-side suite (transcript store, notes store, model config
  provider, execute tool, assembly port) from your own test tree with your real
  adapter, on each engine bump, before the release-acceptance run.
- Add the entry-level sentinels (`engineApiContract`,
  `terminationPayloadContract`, `toolResultEnvelopeContract`) once; they cost three
  registrations and catch the
  "upstream renamed something I forgot to grep" class.
- Keep host-invented behaviour in host-owned tests. If a shipped suite disagrees
  with a host requirement, file it (issue tracker) rather than forking the
  suite: the fork loses the sentinel.
