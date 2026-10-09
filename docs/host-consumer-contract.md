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
must be placed in an explicit namespace such as `toolContext` or `context`.

```text
assemblyPort, provider, system, wrapup, initialUserMessage, initialMessages, tools,
writeToolNames, writeToolPathKeys, executeTool, maxRounds, maxTokens,
temperature, topP, timeoutMs, deadlineMs, reflection, stallDetection, retry,
completion, finalGuard, finalGuardMaxRetries, finalGuardTimeoutMs,
maxTokenContinuations, toolResultTtl, toolResultFoldMinTokens, context,
todoStateProvider, semanticStateProvider, partialPersistence,
modelConfig, modelMetadata, model, expert, user, task, session, requestId,
toolContext, store, persistence, runId, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent
```

`partialPersistence` defaults to `false`, preserving the existing no-write
streaming behavior. Set it to `{ intervalMs, minBytes? }` to opt into
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
  └─ reportObserverError(error, { channel, … })   src/loop/orchestrator.js:763-783
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
| `onEvent` | `type`, plus `round` when the event carries one | `emitEvent` (`src/loop/orchestrator.js:1517-1531`) |
| `onEvent` (startup diagnostics) | `type: "model_metadata_missing"`, or `type: "persistence_capability_degraded"` plus `method` | the local guards in `notifyCapabilitySkipped` / `notifyModelMetadataMissing` (`src/loop/orchestrator.js:847-900`), which call `onEvent` directly because they fire before `emitEvent` exists |
| `onRound` | `round` | `src/loop/orchestrator.js:3122-3130` |
| `onToolResult` | `toolName`, `round` | `src/loop/run-snapshot-executor.js:266-294` |
| `onJudge` | `round`, `kind` | `emitJudge` (`src/loop/orchestrator.js:1544-1557`) |
| `onDelta`, `onReasoningDelta`, `onToolCall`, `onUsage` | `round`, `type` (the streamed event type) | `dispatchAttemptEvent` (`src/loop/provider-runner.js:96-110`) |

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

## Retry budget (issue #183)

**Not configured means not retried.** `retry` defaults to `false`
(`src/loop/orchestrator.js:566`), and in that state the engine issues exactly
one provider attempt per round and one write per store call. A host that wants
retrying has to ask for it, and a host that does not ask must not assume a
provider call is ever repeated. This section is the whole rule set; the
termination side of it is the `failed` row of "Termination decision table
(issue #170)".

### Derived values

Only an **object** turns retrying on: `retryOptions = retry && typeof retry ===
"object" ? retry : null` (`src/loop/orchestrator.js:713`), so `retry: true` is
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
`src/loop/orchestrator.js:881-884`). Sleeping is abort-aware: the run's signal
is passed to `sleepImpl` and raced by `waitForRetry`
(`src/loop/orchestrator.js:1636-1641`), so `signal.abort()` during a backoff
wait throws the standard `aborted` shape with the issue #180 payload.

Only errors marked `retryable === true` are retried
(`src/loop/provider-runner.js:219`). That set is `KitError.code` ∈
`timeout`, `rate_limited`, `server`, `disconnect`
(`src/providers/errors.js:1,14-16`), HTTP 408/429/5xx through
`classifyHttpError` (`:86-99`), retryable transport failures through
`classifyFetchException` (`:141-172`, decided by
`isRetryableNetworkException` `:123-132`), and an assistant message that carries no
text, tool call, or reasoning (`src/messages/canonical.js:448-454`).
Everything else — `auth`, `aborted`, a `TypeError` from option validation, a
host store bug — is rethrown on first sight.

### One option, two independent loops

The same three numbers feed two loops with **separate counters**. They do not
multiply, and a host must not model them as one global attempt budget:

| loop | coordinate | gate | budget |
|---|---|---|---|
| per-round provider call | `src/loop/provider-runner.js:33-263` (`callProvider`) | `retryOptions !== null` **and** `error.retryable === true` (`:219`) | `retryAttempts + 1` provider calls **per round**; a run therefore tops out at `maxRounds × (retryAttempts + 1)` |
| persistence store write | `src/loop/orchestrator.js:872-888` | the same numbers, no `retryable` gate | `retryAttempts + 1` writes **per store call**, independent of the provider loop |

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
  (`src/reflection/wrapup.js:132-135`), and the `fold-llm` default summarizer
  (`src/loop/orchestrator.js:1063-1073`). None of them consumes this budget.
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
  fallback at `src/loop/orchestrator.js:714-718`. The CLI's own `2` comes from
  `ERIX_RETRY_ATTEMPTS` (`bin/cli.js:828-836`), which the CLI passes as
  `retry: { attempts: … }`; the **library** default stays `false`, so copying
  CLI behaviour into a host is how this number gets misattributed.
- `partialPersistence` is durability, not retry: it commits the partial text of
  a dying attempt (`onPartialAttemptEnd({ retrying: true })`,
  `src/loop/orchestrator.js:1919-1933`) and adds no attempt of its own.
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
| store-write retries | **no per-attempt event exists.** The only signal is the terminal `persistence_error` report after the loop is exhausted (`src/loop/orchestrator.js:889-896`); wrap your own store methods to count attempts, which is currently the only way to prove the store-side loop ran at all |

Leftover (issue #183): the run result carries no aggregate attempt/retry
counter, so a per-run total has to be assembled from events by the host. A
durable retry counter is **not** promised today; treat `attempt` / `recovering`
/ `recovered` and `retry.sleepImpl` as the only supported observation points.

## AssemblyPort

Hosts that assemble a complete run can provide one validated composition root
instead of repeating the individual wiring:

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider
  provider,    // Provider
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // optional TranscriptStore
  session: { id, resume?, initialMessages? },
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
  `src/loop/orchestrator.js:958-964`). Fields are **never merged across
  candidates**: a slot with only `contextWindowTokens` plus a `modelMetadata`
  carrying `maxOutputTokens` derives no budget at all. Keep the pair in one
  object.
- `modelConfig` must be a resolver (`{ resolve(slot?) }`). A plain config object
  passed as `modelConfig` is rejected at startup with
  `assembly port is missing methods: modelConfig.resolve`, because the option
  name is read as a port whenever it is present (`src/loop/orchestrator.js:592-607`).
  The resolved value — not the resolver — is what the probe reads.
- Slot selection is per run: the slot name travels in `session.modelSlot`
  (`src/loop/orchestrator.js:609-612`). Both built-in providers fall back to the
  `default` slot for an unknown name, so per-run selection never fails a run
  that only misspelled a slot.
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

The loop's own `maxTokens`, `temperature`, and `topP` options are injected into
every request and therefore **override** the same slot fields
(`src/loop/provider-runner.js:128-130`, `src/providers/openai.js:51-55`).

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
(`src/loop/orchestrator.js:984-993`, `src/compact/budget.js:9-33`).
`budgetTokens` is the gate for context compaction, for the per-round aggregate
output budget, and for the budget block in the request view. The output-truncation
limit is a separate derivation: explicit `outputHygiene.limit` first, else
`clamp(15% × contextWindowTokens, 8192, 100000)`, else `4096`
(`src/loop/orchestrator.js:966-977`).

| Condition at startup | Engine behavior |
|---|---|
| neither field found in any of the five candidates | **silent skip**: `budgetTokens` stays `undefined`, compaction and the aggregate output budget stay off, and exactly **one** `model_metadata_missing` event is emitted |
| fields found but malformed (non-integer, string, window ≤ 0, `maxOutputTokens` < 0) or too small (derived budget ≤ 0) | `computeBudget` **throws `invalid_budget`** before the first provider call |
| host supplies `context.budgetTokens` | derivation is bypassed entirely — compaction is on whatever that value enables, and **no** event is emitted whatever the probe found; a non-positive / non-integer value throws `invalid_budget` from `validateBudget` |
| host supplies `context.strategy` | the strategy is asked with `budgetTokens` as-is, so a configured strategy can gate compaction without any metadata (`src/loop/orchestrator.js:2200-2203`); note the built-in sliding-window strategy compares against that value and therefore never fires on `undefined` (`src/compact/sliding-window.js:34-36`) |

Both `invalid_budget` shapes are **pre-execution** throws: the run lifecycle has
not begun, so the thrown error carries no `termination`, `usage`, `rounds`, or
`finalText` (see the scope note in "Termination payload (issue #176 / #180)").

### Compaction strategy selection (issue #167)

`context.strategy` accepts a strategy **object** (semantics unchanged, byte for byte) or
one of the built-in **names** `"sliding-window" | "fold-statistical" | "fold-llm"`.
A name is resolved **once at run startup** into the same object the host would have
built (`src/compact/strategy-resolution.js`, wired at
`src/loop/orchestrator.js:988-1003`), so the downstream configured-strategy channel is
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
  auxiliary calls (`src/loop/orchestrator.js:979`, `trackLatest: false`) and is also
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
(`src/loop/orchestrator.js:876-900`; see "Observer callback errors (issue #173)").

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
// An unknown name falls back to the "default" slot instead of failing the run.
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
  initialUserMessage: run.prompt,
  executeTool,
  maxRounds: 8,
  persistence: "none",
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
`src/loop/resume-manager.js:75`), the engine rebuilds its message state from
`store.load(runId)` and **ignores `initialMessages` and
`initialUserMessage`** — a host-provided user message reaches the model only
through a pre-written record, never through those options. Resuming without a
`store` or without a `runId` is an unsupported call: the initial-message
options are not overridden in that case.

A correct pre-written `RoundRecord` must satisfy:

- **Shape:** `{ round, messages: [{ role: "user", content: [{ type: "text",
  text }] }], dedupKey, roundKey, ts }` with `ts` an ISO-8601 string
  (`new Date().toISOString()`).
- **Round:** reuse the existing maximum round across `load` results
  (`Math.max(0, ...rounds)`, `0` for an empty store). The engine resumes from
  that maximum round and writes its own records at later rounds; pre-writes
  must not advance it. An empty `load` result is the seed path: pre-write the
  turn at round `0`; the built-in CLI instead passes
  `initialMessages`/`initialUserMessage` without `resume` when no records
  exist yet, which is equivalent for the engine.
- **dedupKey:** namespaced `"<key>:input:<suffix>"`, unique per turn. The
  engine writes its own rows under `"<runId>:engine:round:<n>"` and
  `"…:resume"`, so host `:input:` keys never collide with engine rows.
- **Idempotency:** the store deduplicates by `dedupKey` (falling back to
  `roundKey`), and crash-rerun judgement is by `dedupKey`: a repeated append
  with the same `dedupKey` is a no-op, so a stable `dedupKey` (derived from a
  host message id) makes the pre-write safely repeatable. This guarantee is
  **sequential-rerun** semantics — crash-rerun or sequential retry by
  `dedupKey`. Concurrent appends against the same key are not covered: the
  host should serialize appends per key (or issue them inside its receiving
  transaction).
- **Timing:** persist the user turn inside the transaction that accepts the
  user message (when the host decides the turn belongs to this run), not
  lazily after a worker picks the task up — a crash between acceptance and
  pre-write would otherwise lose the turn or duplicate it.

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
  and `error: { name, message }` (message capped at 500 characters,
  stack dropped). `delivery_failure` entries additionally carry `failedEvent`
  (the identity of the event that could not be delivered). Identical failures —
  same port/operation/phase/fatal/message, and for `delivery_failure` also the
  same failed-event identity — are deduplicated into one entry with an
  increasing `repeat` count instead of flooding the bill.
- `diagnostics.error(event)` — the same identity as an event, delivered when
  the host configured a sink. A sink that throws is itself recorded as a
  `delivery_failure` entry.

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
| `termination.errorCode` | `result.termination` / `error.termination` when `reason === "failed"` | Root-cause class of the failure. The engine passes through the classification the error already carries (`KitError.code`, e.g. `timeout`, `rate_limited`, `auth`, `server`, `checkpoint_failed`) and falls back to `"unknown"` when the error carries none — it never invents or re-derives a code. No other reason gains the field. A host decision table can therefore branch on `errorCode` instead of parsing `termination.detail`. |
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

Nine reasons are enumerable on the return path (`src/loop/orchestrator.js:493`);
`persistence_failed` is a tenth that only ever appears on the throw path, so it
is listed too. `truncated` is `true` exactly for `max_rounds_cap`,
`continuation_exhausted`, `stall`, and `final_guard_unverified`
(`src/loop/termination.js:7-11`).

| `termination.reason` | Triggering mechanism (file:line) | Position in the precedence chain | Host switch | Recommended host action |
|---|---|---|---|---|
| `end_turn` | governance stop `completion` (`src/reflection/governor.js:111-113`) or the fall-through stop `complete` (`src/reflection/governor.js:126-128`), both mapped by `terminationReasonForAction` (`src/loop/termination.js:93-100`). Inputs: `shouldContinue` (`src/loop/orchestrator.js:2739-2740`), `completionSignalDetected` from a wrapup envelope `done:true`, a `completion.signals` text match, or the LLM normalizer (`src/loop/orchestrator.js:2742-2745`, `2747-2801`) | lowest-priority stop in the round chain — every other stop and nudge is evaluated first, and the round judge can pre-empt it with `judge_done` (`src/loop/orchestrator.js:2937-2944`) | not disableable (it is the normal success exit). `wrapup:false` removes the JSON envelope path (`src/loop/orchestrator.js:1069-1073`); `completion:{signals:[…]}` widens keyword detection (`src/loop/orchestrator.js:1413`) | **accept**, but only after inspecting `verification.status` — `end_turn` alone is not a delivery proof |
| `judge_done` | round judge `done:true` with `confidence >= 0.7` on an end-turn round (`src/loop/orchestrator.js:2937-2944`, `isEndTurn` at `2645`), mapped at `src/loop/termination.js:94` | highest stop in the round: evaluated before the governor, so it outranks stall and completion | `reflection:false`, `reflection:{roundJudge:false}`, `ERIX_NO_ROUND_JUDGE=1`, `ERIX_NO_REFLECTION=1` (`src/loop/orchestrator.js:1029-1043`). Note reflection auto-enables at `maxRounds >= 16` (`src/loop/orchestrator.js:1029-1032`, `src/loop/reflection.js:8`) | **accept then verify**: this is a model-side claim, not a check. Route it through `finalGuard` / CI before downstream use |
| `no_tool` | governance stop `noTool` (`src/reflection/governor.js:114-117`), gated by `noToolRound` (`src/loop/orchestrator.js:2813-2817`) and a streak `>= maxNoToolRounds`, default 3 (`src/loop/orchestrator.js:1414-1416`) | below the completion stop, above the `complete` fall-through | `completion:false` makes `noToolRound` permanently false, so the reason becomes **unreachable** and the run ends `end_turn` instead; `completion:{maxNoToolRounds:n}` moves the threshold (`0` stops on the first occurrence) | **retry / re-prompt**: the run stopped with no completion claim and `truncated:false`, so nothing was truncated — it stalled in prose. Alert if it repeats |
| `stall` | identical tool-call signature inside the detection window (`src/loop/orchestrator.js:2678-2692`), streak accumulation (`src/loop/orchestrator.js:2729-2736`), stop at `src/reflection/governor.js:66-69` with `STALL_STREAK_LIMIT = 3` (`src/reflection/governor.js:3`), mapped at `src/loop/termination.js:97` | second-highest stop — only `continuation_exhausted` outranks it; deliberately ordered above the wrap-up and repeated-error nudges so it cannot be starved (`src/reflection/governor.js:65`) | `stallDetection:false` makes it **unreachable** (`src/loop/orchestrator.js:1398-1409`); `stallDetection:{window,mode}` re-tunes it; `ERIX_STALL_MODE` overrides the mode unless the option is `false` | **alert + retry differently**: `truncated:true`, so never accept the text as an answer. The host's own repeat-guard should trip here |
| `continuation_exhausted` | provider kept answering `max_tokens` and the continuation budget ran out (`src/loop/orchestrator.js:2638-2639`, loop at `2601`); governance stop `cap` (`src/reflection/governor.js:62-64` / `136-138`) mapped to this reason **before** `max_rounds_cap` (`src/loop/termination.js:95`) | **first** check in both governance entry points — the top of the chain | `maxTokenContinuations` (`src/loop/orchestrator.js:1417-1419`, default 3; `0` makes the first `max_tokens` response terminal) | **retry with more output room** (larger `maxTokens`/`maxOutputTokens`), or accept the partial text and alert; `truncated:true` |
| `max_rounds_cap` | (a) governance stop `cap` when the limit is near and extension is not allowed (`src/reflection/governor.js:150-152`); (b) the round loop simply runs out (`src/loop/orchestrator.js:2561`, tail handling at `3151-3169`) | (a) budget boundary, below stall; (b) runs after the last round, before any post-stop guard verdict stands | `maxRounds` (required option); extension headroom via `reflection:{maxExtensions, maxRoundsCap, extensionStep}` (`src/loop/orchestrator.js:1084-1099`); `ERIX_NO_REFLECTION=1` disables auto-reflection | **resume or accept-partial**: use the multi-turn resume contract to continue, otherwise book the partial result and alert; `truncated:true` |
| `final_guard_unverified` | a configured `finalGuard` ran and could not certify: non-continuable stop (`src/loop/orchestrator.js:3103-3116`), revision limit (`3118-3131`), or the budget-exhaustion tail (`3156-3169`). Only reachable for the six guard-eligible reasons (`src/loop/termination.js:14-21`) and only when `finalGuard` is a function (`src/loop/orchestrator.js:3092-3095`) | strictly **post-stop**: it replaces the reason after forced wrap-up and guard evaluation, never during round governance | omit `finalGuard` entirely (then `verification` is `skipped` / `no_final_guard`, `src/loop/orchestrator.js:1435-1437`); `finalGuardMaxRetries` moves the revision limit (default 2, `src/loop/orchestrator.js:1427-1430`) | **do not consume as a verified fact**: `verification.status === "unverified"` (`non_continuable` / `max_retries`). Route to human review or the test system |
| `aborted` | the terminal `fail()` path while the host signal is aborted (`src/loop/orchestrator.js:905-955`; classification at `907-908` and `927-932`, annotation at `947-954`) | overrides failure classification on the throw path — the signal is checked first. Since issue #173 a host callback cannot reach this row by throwing: `signal.abort()` is the only callback-side trigger, and the issue #180 payload rule above still applies to it | nothing to disable: the trigger is the host's own `AbortSignal` | **bill, do not auto-retry**: read `error.usage` / `error.rounds` / `error.finalText` (issue #180) and `termination.partial`; the user asked for this stop |
| `failed` | any error thrown inside the run lifecycle, via `fail()` (`src/loop/orchestrator.js:905-955`, loop catch at `3147-3149`), with `termination.errorCode` passed through (`src/loop/termination.js:43-57`). A host observer throw is no longer one of those sources (issue #173) | catch-all: it outranks every pending governance decision because the round never completed | `retry:{attempts, backoffBaseMs, backoffMaxMs}` decides how much is retried before this reason appears (`src/loop/orchestrator.js:700-711`); the reason itself is not disableable | **branch on `termination.errorCode`** (issue #176): retryable (`timeout`, `rate_limited`, `server`) → backoff retry; `auth` → alert and stop; `unknown` → inspect `termination.detail` |
| `persistence_failed` | same `fail()` path, selected when the error carries persistence info (`src/loop/orchestrator.js:927-932`), which also adds `operation` / `phase` / `sideEffect` (`src/loop/orchestrator.js:940-946`) | replaces `failed`, never the reverse; carries no `errorCode` (that field is `failed`-only) | `persistence:"none"` removes the transcript write path entirely; optional store capabilities degrade instead of failing (see capability tiers) | **alert**: side effects were tracked, so this is an integrity signal (ADR-013), not a retry candidate |

### Verification status and CLI exit codes

`verification` is a separate axis from the termination reason: an `end_turn` can
come back `unverified`, and a `max_rounds_cap` / `stall` /
`continuation_exhausted` can only ever end up `skipped` or `error` — with a guard
configured, a `verified` verdict is not available to them, because a guard
`accept` on those three reasons still terminates as `final_guard_unverified`
(`src/loop/orchestrator.js:3103-3116`). The CLI mapping is
`exitCodeForVerification` (`bin/cli.js:1015-1022`):

| `verification.status` | Meaning | `verification.reason` seen in practice | CLI exit code |
|---|---|---|---|
| `verified` | the configured guard accepted this final answer | — (no reason field) | `0` |
| `skipped` | nothing was checked — **not** a claim of correctness | `no_final_guard` (`src/loop/orchestrator.js:1435-1437`); CLI guard `no_capture_evidence` / `no_extractable_candidates` (`bin/final-guard.js:86,89`) | `4` |
| `unverified` | the check ran and was not satisfied | `non_continuable` (`src/loop/orchestrator.js:3104-3108`), `max_retries` (`3120-3124`) | `2` |
| `error` | the guard threw, decided invalidly, or timed out (fail-open for availability, never `verified`) | `timeout` or `error` (`src/loop/termination.js:173-176`) | `3` |

`exitCodeForVerification` returns `0` for any other status, including a missing
`verification` object, so **exit code 0 is not by itself proof of a verified
answer** — read `verification.status`. A run that threw exits `1` from the CLI's
top-level handler (`bin/cli.js:1032-1042`), which is a failure signal, not a
verification outcome.

### Mechanism precedence and mutual exclusion

Within one round, exactly one mechanism gets to decide, in this order
(`src/loop/orchestrator.js:2937-2962`, `src/reflection/governor.js:59-129`,
`src/loop/termination.js:93-100`):

1. **token-continuation boundary** — repeated `max_tokens` responses set
   `continuationExhausted`, which is the first test in both governance entry
   points (`src/reflection/governor.js:62-64`, `136-138`). Because
   `continuationExhausted` is checked before the `cap` mapping
   (`src/loop/termination.js:95`), a `cap` stop caused by truncated output
   reports `continuation_exhausted`, never `max_rounds_cap`.
2. **stall stop** (`src/reflection/governor.js:66-69`) — above the wrap-up and
   repeated-error nudges on purpose, so a low-priority nudge cannot starve a
   genuine loop into `max_rounds_cap`.
3. **wrapup declaration** — a `done:true` envelope suppresses continuation and
   raises `completionSignalDetected` (`src/loop/orchestrator.js:2739-2745`),
   which both produces the `completion` stop (`src/reflection/governor.js:111-113`)
   and makes `noToolRound` false (`src/loop/orchestrator.js:2813-2817`). Declared
   completion and `no_tool` are therefore mutually exclusive.
4. **completion keyword fallback** — the same signal with no parseable envelope
   comes from `completion.signals` matching the final text
   (`src/loop/orchestrator.js:2743-2745`), or from the LLM normalizer when an
   end-turn round produced no envelope at all (`2747-2801`, opt-in via
   `reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`).
5. **`no_tool` stop** — reachable only when nothing declared completion and the
   round produced no tool call (`src/loop/orchestrator.js:2813-2817`).
6. **round judge end-turn evaluation** — `judge_done` is evaluated *before* the
   governor (2866-2873), so it outranks 2-5 in the round it fires; it requires
   `isEndTurn`, i.e. `stopReason === "end_turn"` with no tool use
   (`src/loop/orchestrator.js:2645`). A tool round can therefore never produce
   `judge_done`, and a `max_tokens` round can never produce both `judge_done`
   and `continuation_exhausted` (the mapping prefers `judge_done` anyway,
   `src/loop/termination.js:94`).
7. **post-stop verification** — after a stop reason exists, forced wrap-up may
   add one more provider call for the three non-continuable reasons
   (`src/loop/termination.js:203-256`), then `finalGuard` may accept, skip,
   revise, or fail. A `revise` verdict is not terminal: it injects a user
   message and governance starts over for that round
   (`src/loop/orchestrator.js:3118-3140`). Revision retries are bounded by
   `finalGuardMaxRetries` (default 2, `src/loop/orchestrator.js:1427-1430`),
   and the guard's own timeout defaults to 30 s
   (`src/loop/orchestrator.js:1431-1433`).
8. **`fail()` classification** — any throw at any point replaces all of the
   above with `aborted` (signal set) or `failed` / `persistence_failed`
   (`src/loop/orchestrator.js:905-955`).

## Reusable normalization primitives

Hosts that provide their own OpenAI-compatible transport can import these
helpers from the package root. They perform no I/O or model calls:

| Export | Signature | Semantics |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | `null`/`undefined` return `undefined`; any other input returns an object mapping `prompt_tokens`/`completion_tokens` to `input_tokens`/`output_tokens` when present (so `{}`, an array, or a string yields `{}`). Canonical aliases are **not** accepted. |
| `normalizeOpenAIStopReason` | `(reason, fallback = "unknown") -> string` | Maps `stop`, `tool_calls`/`function_call`, and `length` to canonical stop reasons; unknown values pass through. |
| `parseOpenAIToolArguments` | `(rawArguments) -> any` | Parses JSON, uses `{}` when absent, and returns malformed values under `_truncatedArguments` and `_raw`. |
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

The engine has no separate "delivery authentication" or "completion
authentication" layer. It reports facts such as rounds, tools, file calls,
archives, termination, and verification. Whether the task is complete,
whether the deliverable meets its requirements, and whether it may proceed
automatically downstream remain decisions for the host, test system, or human
review.

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

An explicit `limit` is validated, then clamped (`src/store/notes.js:398-405`,
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

- `definitions` — the six `readFile` / `searchText` / `rg` / `grep` / `tree` /
  `writeFile` schemas. Tool names and existing input fields (`offset`/`limit`/`path`/
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
`[共 N 行，剩余 M 行；下一步：readFile 传 offset=K 继续]`, and the
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

Defaults a host must know about, because they change what the model sees
(ADR-010: default denoising is legal only while it stays revocable):

- `rg` / `grep` / `tree` skip `node_modules`, `dist`, `build`, `target`,
  `vendor` and dot-directories (`.git` included) unless `include_vendor=true`
  / `include_hidden=true`, and state the skipped counts at the end of the
  result together with the switch names that undo them;
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
irreproducible.

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

- `persistence_error`: `{ kind, port, operation, phase?, fatal, error: {name, message}, ts }`
  where `port` is `"transcript"` (today; `"resource"`/`"notes"` arrive with
  their integration steps). `error` is normalized to `{name, message}` with
  the message capped at 500 chars (bounds the result payload; stack traces
  are dropped).
- `delivery_failure`: a `diagnostics.error` (or `onPersistenceError`) sink
  itself threw — the error happened but the structured event was not
  delivered. `port` is always `"diagnostics"` (the failed channel); the
  origin port rides in `failedEvent.port`.
- `ledger_overflow`: synthetic entry reported when the ledger cap
  (`100` entries) dropped records; carries `dropped: number`.

Delivery guarantees: the ledger and the `diagnostics.error` event are the two
reliable channels; model-visible warnings are advisory only and never count
as delivery. On an exception-terminated run the ledger is attached to the
thrown persistence failure as `error.unpersisted`.

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
`{ key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus? }`.

| Field | Meaning |
|---|---|
| `key` | Non-empty host-rendering identity for this tool call, derived from its turn key and position; it is not the provider's tool-use ID. |
| `name` | Tool name as supplied by the provider, or an empty string when absent. |
| `id?` | Provider-supplied `tool_use.id`, stringified when present and omitted when absent; it remains the result-association ID, while `blocks[].id` passes through unchanged. |
| `argsSummary?` | Bounded, one-line summary of the tool input, omitted when there is nothing to summarize. |
| `resultPreview?` | Bounded preview of the associated tool result, omitted when no non-empty result text is available. |
| `isError?` | Whether the associated result explicitly marks an error; omitted when no error flag is present. |
| `executionStatus?` | String execution status supplied by the associated result, omitted otherwise. |

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
| `foldedPayload` | display (bounded) | The raw messages removed by folding. It is a large archive; do **not** dump it into the chat view. The projection reports only `meta.foldedPayloadMessages` (a count). |
| `navigationRecord` | display | Bounded archive pointers `{ roundFrom, roundTo, artifacts[], truncated? }` for recovered tool outputs. Render as navigation links/pointers, never as message content. |
| `messages` | model | The exact model-context slice, including `tool_use`/`tool_result` blocks and fold placeholders. Do not render it raw; the projection extracts displayable text and tool-call summaries from it. |
| `messages[].meta` | model / engine | Preserve this object, including unknown keys. `meta.source` is an engine-reserved marker used by projection classification and judge visibility; do not reuse it for host-owned source information. |
| `response` | model | Full provider response content (`text`, `reasoning`, `tool_use` blocks), `stopReason`, `usage`. Display fields are derived from it; its block shape is model-facing and may change. |
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

### Reasoning

`reasoning` holds the round's reasoning text (canonical `reasoning` blocks plus
the provider-normalized `thinking`/`reasoning_content` shapes) and is **never**
merged into `text`. Recommendation: show it in a collapsed/expandable block by
default, since it is long and noisy, and keep it visually distinct from the
answer. Hosts must not silently drop reasoning from their own storage when they
also replay history to the model — reasoning replay is a model-side contract
(see the thinking-mode requirement), independent of this display field.

### Synthetic messages

Runtime-injected messages are model-visible but not user-authored. The
projection keeps the underlying role (usually `user`, sometimes `system`) and
labels them:

- `meta.synthetic: true` for every non-user-authored turn; real user and
  assistant turns carry `meta.synthetic: false`.
- `meta.source` names the injector when the transcript carries the marker: `judge-control`
  (round-judge direction hints and continuation nudges), `audit-intercept`
  (repeated-command intercept text), `system`, `fold-summary` (the fold banner),
  `wrapup`, or `textPreview` (legacy preview fallback for the assistant turn).
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

An unknown schema or incomplete persisted state is not silently treated as a
valid default. On resume it is exposed as
`runState.stateAvailability.status = "state_unavailable"` (for example,
`unknown_schema` or `missing_fields`). A corrupt file-store JSON state is also
reported as unavailable rather than restored. An entirely absent persisted
state is normal and is not the same as a present but invalid state.
`stateAvailability` is a diagnostic observation from the current resume attempt;
it is retained in persisted state but does not by itself reject a structurally
valid state on a later resume.

## Contract test suites (issue #183)

`erix-agent/contract-tests` (the `./contract-tests` subpath export,
`test/contract/index.js`) ships nine suite files exposing **eleven** reusable
`node:test` registration functions (`execute-tool.js` carries two: the current and
the migration shape; `notes-store.js` carries two since issue #183: the general
suite and the optional CAS sub-suite). Every one is shaped `xxxContract(label, factory)`:
calling it registers assertions titled with `label`, and nothing executes until
`node --test` runs them. `npm run check:docs:strict` fails on any suite that
`test/contract/index.js` re-exports but the packaged `files` list omits (it is a
warn under the plain `npm run check:docs`), so the shipped set cannot shrink
unnoticed. `skillsLoaderContract` is the newest of the eleven (issue #197) and
`fileToolsContract` is next (issue #184): a host on an installed 0.18.0
has nine, not eleven.

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
import { createFileNotesStore, createMemoryTranscriptStore } from "erix-agent";

transcriptStoreContract("my-host-store", () => createMemoryTranscriptStore());
notesStoreContract("my-host-store", () => createFileNotesStore({ dir: notesDir }));
// optional sub-suite for a compare-and-swap store: it only requires at most one
// concurrent writer to fail and the winner to stay readable
notesStoreCasContract("my-host-store", () => createFileNotesStore({ dir: notesDir }));
```

The same shape covers the other six; only the second argument differs:

| suite | second argument | what the factory must hand back |
|---|---|---|
| `transcriptStoreContract(label, createStore)` | factory | a clean `TranscriptStore` (required tier `appendRound`/`load`; the run-snapshot, run-state, and issue #157 probe methods are exercised when present) |
| `notesStoreContract(label, createStore)` | factory | a clean `NotesStore` (write/read/list/complete/revoke/purge) |
| `notesStoreCasContract(label, createStore)` | factory | the same `NotesStore`, registered **in addition** by a compare-and-swap host (issue #183): the concurrency assertion tolerates one writer being rejected instead of requiring both writes to land |
| `modelConfigProviderContract(label, setup)` | async setup | `{ provider, slot, expect: { defaultModel, slotModel, materializedKey } }`; the provider needs a `default` slot plus `slot`, whose key is reachable through an indirect reference |
| `executeToolContract(label, createExecutor)` | factory | your `executeTool` function (or `{ executeTool }`) |
| `executeToolMigrationContract(label, createExecutor)` | factory | the same executor, asserted against the retired positional call shape |
| `assemblyPortContract(label, createPort)` | factory | your `AssemblyPort` object; the suite starts a real `runToolLoop` on it |
| `engineApiContract(label, getEntry)` | factory | the **package entry namespace**, i.e. `() => import("erix-agent")` — it asserts exported engine API, not your code |
| `terminationPayloadContract(label, getEntry)` | factory | the same entry namespace (`{ runToolLoop }`); it brings its own provider stub |
| `skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })` | three functions, not a factory | the skill-package loader a host wires in; it asserts the caller-owned `bundledDir`, the bundled → global → project precedence, the non-blocking `{skillId, dir, error}` failure shape, and the `ToolSchema` output shape |

### Suite inventory (issue #183)

"Harness" is what the suite runs against: your factory (host-side) or the
packaged engine (upstream-side, i.e. a pure drift sentinel).

| suite | what it asserts | yours to satisfy | upstream-internal detail it also pins |
|---|---|---|---|
| `transcript-store.js` (16 tests) | record round-trip fidelity (blocks, metadata, unknown fields, `meta.source`), same-round append order, unknown-key → `[]`, multi-run isolation, run-snapshot latest-only overwrite, run-state snapshot without `state`, throw-on-write-failure, `round: 0` seed, folded payload round-trip, and the paired probe tier | every one of them: it is the `TranscriptStore` contract, and the shipped fidelity/ordering assertions are exactly the ones a rebuild-from-whitelist adapter fails | the `:input:`/`:engine:round:` key shapes, the `(record.dedupKey ?? record.roundKey)` predicate and its `??`-not-`OR` fork (issue #171), `null`/`undefined` probe-result tolerance |
| `notes-store.js` (7 tests) | port validation (`assertNotesStore`), malformed-record rejection before persistence, full record round-trip, scope isolation and explicit misses, unsafe-scope round-trip through lifecycle, the `limit` threshold (more than 200 stored records: a given limit clamps to exactly 200, an illegal limit throws), and `revoke`'s observable disappearance with the `expectedState`/`expectedUpdatedAt` guards | the port surface and the record/guard semantics. Since issue #183 the split between upstream mandate and host policy is explicit: the port mandates observable disappearance (tombstone **or** physical delete) and leaves record expiry to the host, while the one-writer last-write-wins behaviour is the file adapter's own business and is no longer asserted here | the file-store-shaped error texts (`/valid NoteRecord/`, `/parseable date/`, `/positive safe integer/`), retention/purge timing |
| `notes-store.js` → `notesStoreCasContract` (1 test, optional; issue #183) | concurrent same-key writers: at most one may fail, a failure must be a thrown error rather than a silent drop, and the winner is the record that stays readable in its full shape | compare-and-swap hosts only, and only in addition to `notesStoreContract` — this sub-suite is deliberately weaker than the retired last-write-wins assertion, so passing it says nothing about a store that serializes writers | the two payload contents it happens to exercise (`left`/`right`), not any conflict error text |
| `assembly-port.js` (4 tests) | a port boots a real loop to completion, `emit(type, payload)` receives the event types with their payload, an explicit fine-grained `provider` option overrides the port's provider, and a provider missing `chat`/`chatStream` is rejected at startup by both `createAssemblyPort` and `runToolLoop` | your port's required adapters and its `emit` sink | the precedence rule (explicit option over port), the startup-validation error text |
| `execute-tool.js` (7 tests) + `execute-tool-migration-contract` (2 tests) | your executor receives exactly one structured execution object, and each canonical return form (`string`, `{content, metadata, success}`, legacy `{data}`, returned `Error`, thrown `Error`) becomes the documented `tool_result` | the call shape and the return shapes. The migration suite additionally proves that a bare positional `(name, input)` executor is **rejected**, not silently supported | that the assertions are observed through `runToolLoop`'s provider request rather than through a public result field |
| `model-config-provider.js` (4 tests) | `resolve()` → default slot, `resolve(slot)` → named slot, unknown slot → default fallback, and `apiKey` indirect-reference materialisation (ADR-001) | your provider's slot resolution and key materialisation | nothing engine-side: it never loads the engine |
| `engine-api.js` (2 tests) | the package entry exports `appendUserTurn` and `projectTranscriptForDisplay` as functions, and `appendUserTurn` completes one pre-write against a minimal store stub (including the `dedupKey`/`roundKey` shape and that the pre-write feeds the display projection) | nothing — this is an entry-surface sentinel; it goes red when an upstream bump renames or drops engine API | the exact pre-write record shape (`round: 0`, `dedupKey`, `roundKey`, `ts`) |
| `termination-payload.js` (4 tests) | a `failed` terminal outcome carries `termination.errorCode` (classification passthrough, `unknown` fallback), an abort throws with `usage`/`rounds`/`finalText` and `termination.partial`, cumulative usage is attributed per round, and the success path keeps its old shape (no `errorCode`/`partial`/`usage` appearing out of nowhere) | nothing directly — it is your host-side decision table's regression net (issue #170 / #176 / #180) | the stubbed provider script, the zero-vs-missing-field rule for `usage` |

### Wiring rule for hosts

- Run every host-side suite (transcript store, notes store, model config
  provider, execute tool, assembly port) from your own test tree with your real
  adapter, on each engine bump, before the release-acceptance run.
- Add the entry-level sentinels (`engineApiContract`,
  `terminationPayloadContract`) once; they cost two registrations and catch the
  "upstream renamed something I forgot to grep" class.
- Keep host-invented behaviour in host-owned tests. If a shipped suite disagrees
  with a host requirement, file it (issue tracker) rather than forking the
  suite: the fork loses the sentinel.
