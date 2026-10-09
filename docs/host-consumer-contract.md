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
  `src/loop/orchestrator.js:898-904`). Fields are **never merged across
  candidates**: a slot with only `contextWindowTokens` plus a `modelMetadata`
  carrying `maxOutputTokens` derives no budget at all. Keep the pair in one
  object.
- `modelConfig` must be a resolver (`{ resolve(slot?) }`). A plain config object
  passed as `modelConfig` is rejected at startup with
  `assembly port is missing methods: modelConfig.resolve`, because the option
  name is read as a port whenever it is present (`src/loop/orchestrator.js:567-582`).
  The resolved value — not the resolver — is what the probe reads.
- Slot selection is per run: the slot name travels in `session.modelSlot`
  (`src/loop/orchestrator.js:584-587`). Both built-in providers fall back to the
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
(`src/loop/provider-runner.js:125-127`, `src/providers/openai.js:51-55`).

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
(`src/loop/orchestrator.js:924-933`, `src/compact/budget.js:9-33`).
`budgetTokens` is the gate for context compaction, for the per-round aggregate
output budget, and for the budget block in the request view. The output-truncation
limit is a separate derivation: explicit `outputHygiene.limit` first, else
`clamp(15% × contextWindowTokens, 8192, 100000)`, else `4096`
(`src/loop/orchestrator.js:906-917`).

| Condition at startup | Engine behavior |
|---|---|
| neither field found in any of the five candidates | **silent skip**: `budgetTokens` stays `undefined`, compaction and the aggregate output budget stay off, and exactly **one** `model_metadata_missing` event is emitted |
| fields found but malformed (non-integer, string, window ≤ 0, `maxOutputTokens` < 0) or too small (derived budget ≤ 0) | `computeBudget` **throws `invalid_budget`** before the first provider call |
| host supplies `context.budgetTokens` | derivation is bypassed entirely — compaction is on whatever that value enables, and **no** event is emitted whatever the probe found; a non-positive / non-integer value throws `invalid_budget` from `validateBudget` |
| host supplies `context.strategy` | the strategy is asked with `budgetTokens` as-is, so a configured strategy can gate compaction without any metadata (`src/loop/orchestrator.js:2129-2132`); note the built-in sliding-window strategy compares against that value and therefore never fires on `undefined` (`src/compact/sliding-window.js:34-36`) |

Both `invalid_budget` shapes are **pre-execution** throws: the run lifecycle has
not begun, so the thrown error carries no `termination`, `usage`, `rounds`, or
`finalText` (see the scope note in "Termination payload (issue #176 / #180)").

### Assembly self-check assertion

`model_metadata_missing` (`{type, runId, detail}`, at most one per run) is the
host's assertion point for its own assembly. A host that expects compaction
asserts the event is **absent**; a host that intentionally runs uncompacted
asserts it is present exactly once. `detail` also names the output limit it
resolved to, so the same assertion catches "my window never reached the
truncation sizing". A throwing `onEvent` on this startup event is fatal and is
reported with the standard `failed` / `aborted` termination shape
(`src/loop/orchestrator.js:938-952`).

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

const events = [];
const result = await runToolLoop({
  provider: createOpenAIProvider(slot),  // request params: model / max_tokens / temperature come from the slot
  modelConfig,                           // budget metadata: re-resolved through session.modelSlot
  session: { id: run.id, modelSlot },
  initialUserMessage: run.prompt,
  executeTool,
  maxRounds: 8,
  persistence: "none",
  onEvent: (event) => {
    events.push(event.type);
    if (event.type === "model_metadata_missing") {
      throw new Error("slot carries no window metadata: compaction is off for this run");
    }
  },
});

result.termination.reason; // "end_turn" — and the assertion above proves the budget was derived
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
| `error.usage`, `error.rounds`, `error.finalText` | every error thrown after the run lifecycle has begun (the terminal `fail()` path and the startup-diagnostic path) | The accumulated usage at the throw point — literally the same object `result.usage` would have carried, including `cacheRead`/`cacheWrite` — plus the round counter and the partial final text (`""` when nothing was produced). When nothing had accumulated these are **zero values, not absent fields**: `{ input_tokens: 0, output_tokens: 0 }`, `0`, `""`. Pre-execution validation errors (unknown/malformed option `TypeError`s, assembly failures, `modelConfig.resolve` rejections) are thrown before a run exists and carry none of these fields. |
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
silently skew hosts that count decisions. One deliberate asymmetry: unlike other
events (a host `onEvent` throwing mid-round is fatal, see issue #173), a throw
from this single terminal event is swallowed — an audit record must not turn a
finished run into `failed`.

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

Nine reasons are enumerable on the return path (`src/loop/orchestrator.js:468`);
`persistence_failed` is a tenth that only ever appears on the throw path, so it
is listed too. `truncated` is `true` exactly for `max_rounds_cap`,
`continuation_exhausted`, `stall`, and `final_guard_unverified`
(`src/loop/termination.js:7-11`).

| `termination.reason` | Triggering mechanism (file:line) | Position in the precedence chain | Host switch | Recommended host action |
|---|---|---|---|---|
| `end_turn` | governance stop `completion` (`src/reflection/governor.js:111-113`) or the fall-through stop `complete` (`src/reflection/governor.js:126-128`), both mapped by `terminationReasonForAction` (`src/loop/termination.js:93-100`). Inputs: `shouldContinue` (`src/loop/orchestrator.js:2668-2669`), `completionSignalDetected` from a wrapup envelope `done:true`, a `completion.signals` text match, or the LLM normalizer (`src/loop/orchestrator.js:2671-2674`, `2676-2730`) | lowest-priority stop in the round chain — every other stop and nudge is evaluated first, and the round judge can pre-empt it with `judge_done` (`src/loop/orchestrator.js:2866-2873`) | not disableable (it is the normal success exit). `wrapup:false` removes the JSON envelope path (`src/loop/orchestrator.js:1019-1023`); `completion:{signals:[…]}` widens keyword detection (`src/loop/orchestrator.js:1363`) | **accept**, but only after inspecting `verification.status` — `end_turn` alone is not a delivery proof |
| `judge_done` | round judge `done:true` with `confidence >= 0.7` on an end-turn round (`src/loop/orchestrator.js:2866-2873`, `isEndTurn` at `2574`), mapped at `src/loop/termination.js:94` | highest stop in the round: evaluated before the governor, so it outranks stall and completion | `reflection:false`, `reflection:{roundJudge:false}`, `ERIX_NO_ROUND_JUDGE=1`, `ERIX_NO_REFLECTION=1` (`src/loop/orchestrator.js:979-993`). Note reflection auto-enables at `maxRounds >= 16` (`src/loop/orchestrator.js:979-982`, `src/loop/reflection.js:8`) | **accept then verify**: this is a model-side claim, not a check. Route it through `finalGuard` / CI before downstream use |
| `no_tool` | governance stop `noTool` (`src/reflection/governor.js:114-117`), gated by `noToolRound` (`src/loop/orchestrator.js:2742-2746`) and a streak `>= maxNoToolRounds`, default 3 (`src/loop/orchestrator.js:1364-1366`) | below the completion stop, above the `complete` fall-through | `completion:false` makes `noToolRound` permanently false, so the reason becomes **unreachable** and the run ends `end_turn` instead; `completion:{maxNoToolRounds:n}` moves the threshold (`0` stops on the first occurrence) | **retry / re-prompt**: the run stopped with no completion claim and `truncated:false`, so nothing was truncated — it stalled in prose. Alert if it repeats |
| `stall` | identical tool-call signature inside the detection window (`src/loop/orchestrator.js:2607-2621`), streak accumulation (`src/loop/orchestrator.js:2658-2665`), stop at `src/reflection/governor.js:66-69` with `STALL_STREAK_LIMIT = 3` (`src/reflection/governor.js:3`), mapped at `src/loop/termination.js:97` | second-highest stop — only `continuation_exhausted` outranks it; deliberately ordered above the wrap-up and repeated-error nudges so it cannot be starved (`src/reflection/governor.js:65`) | `stallDetection:false` makes it **unreachable** (`src/loop/orchestrator.js:1348-1359`); `stallDetection:{window,mode}` re-tunes it; `ERIX_STALL_MODE` overrides the mode unless the option is `false` | **alert + retry differently**: `truncated:true`, so never accept the text as an answer. The host's own repeat-guard should trip here |
| `continuation_exhausted` | provider kept answering `max_tokens` and the continuation budget ran out (`src/loop/orchestrator.js:2567-2568`, loop at `2530`); governance stop `cap` (`src/reflection/governor.js:62-64` / `136-138`) mapped to this reason **before** `max_rounds_cap` (`src/loop/termination.js:95`) | **first** check in both governance entry points — the top of the chain | `maxTokenContinuations` (`src/loop/orchestrator.js:1367-1369`, default 3; `0` makes the first `max_tokens` response terminal) | **retry with more output room** (larger `maxTokens`/`maxOutputTokens`), or accept the partial text and alert; `truncated:true` |
| `max_rounds_cap` | (a) governance stop `cap` when the limit is near and extension is not allowed (`src/reflection/governor.js:150-152`); (b) the round loop simply runs out (`src/loop/orchestrator.js:2490`, tail handling at `3072-3090`) | (a) budget boundary, below stall; (b) runs after the last round, before any post-stop guard verdict stands | `maxRounds` (required option); extension headroom via `reflection:{maxExtensions, maxRoundsCap, extensionStep}` (`src/loop/orchestrator.js:1034-1049`); `ERIX_NO_REFLECTION=1` disables auto-reflection | **resume or accept-partial**: use the multi-turn resume contract to continue, otherwise book the partial result and alert; `truncated:true` |
| `final_guard_unverified` | a configured `finalGuard` ran and could not certify: non-continuable stop (`src/loop/orchestrator.js:3024-3037`), revision limit (`3039-3052`), or the budget-exhaustion tail (`3077-3090`). Only reachable for the six guard-eligible reasons (`src/loop/termination.js:14-21`) and only when `finalGuard` is a function (`src/loop/orchestrator.js:3013-3016`) | strictly **post-stop**: it replaces the reason after forced wrap-up and guard evaluation, never during round governance | omit `finalGuard` entirely (then `verification` is `skipped` / `no_final_guard`, `src/loop/orchestrator.js:1385-1387`); `finalGuardMaxRetries` moves the revision limit (default 2, `src/loop/orchestrator.js:1377-1380`) | **do not consume as a verified fact**: `verification.status === "unverified"` (`non_continuable` / `max_retries`). Route to human review or the test system |
| `aborted` | the terminal `fail()` path while the host signal is aborted (`src/loop/orchestrator.js:845-895`; classification at `847-848` and `867-872`, annotation at `887-894`) | overrides failure classification on the throw path — the signal is checked first, including in the startup-diagnostic path (`src/loop/orchestrator.js:938-951`) | nothing to disable: the trigger is the host's own `AbortSignal` | **bill, do not auto-retry**: read `error.usage` / `error.rounds` / `error.finalText` (issue #180) and `termination.partial`; the user asked for this stop |
| `failed` | any error thrown inside the run lifecycle, via `fail()` (`src/loop/orchestrator.js:845-895`, loop catch at `3068-3070`), with `termination.errorCode` passed through (`src/loop/termination.js:43-57`) | catch-all: it outranks every pending governance decision because the round never completed | `retry:{attempts, backoffBaseMs, backoffMaxMs}` decides how much is retried before this reason appears (`src/loop/orchestrator.js:675-686`); the reason itself is not disableable | **branch on `termination.errorCode`** (issue #176): retryable (`timeout`, `rate_limited`, `server`) → backoff retry; `auth` → alert and stop; `unknown` → inspect `termination.detail` |
| `persistence_failed` | same `fail()` path, selected when the error carries persistence info (`src/loop/orchestrator.js:867-872`), which also adds `operation` / `phase` / `sideEffect` (`src/loop/orchestrator.js:880-886`) | replaces `failed`, never the reverse; carries no `errorCode` (that field is `failed`-only) | `persistence:"none"` removes the transcript write path entirely; optional store capabilities degrade instead of failing (see capability tiers) | **alert**: side effects were tracked, so this is an integrity signal (ADR-013), not a retry candidate |

### Verification status and CLI exit codes

`verification` is a separate axis from the termination reason: an `end_turn` can
come back `unverified`, and a `max_rounds_cap` / `stall` /
`continuation_exhausted` can only ever end up `skipped` or `error` — with a guard
configured, a `verified` verdict is not available to them, because a guard
`accept` on those three reasons still terminates as `final_guard_unverified`
(`src/loop/orchestrator.js:3024-3037`). The CLI mapping is
`exitCodeForVerification` (`bin/cli.js:1015-1022`):

| `verification.status` | Meaning | `verification.reason` seen in practice | CLI exit code |
|---|---|---|---|
| `verified` | the configured guard accepted this final answer | — (no reason field) | `0` |
| `skipped` | nothing was checked — **not** a claim of correctness | `no_final_guard` (`src/loop/orchestrator.js:1385-1387`); CLI guard `no_capture_evidence` / `no_extractable_candidates` (`bin/final-guard.js:86,89`) | `4` |
| `unverified` | the check ran and was not satisfied | `non_continuable` (`src/loop/orchestrator.js:3025-3029`), `max_retries` (`3041-3045`) | `2` |
| `error` | the guard threw, decided invalidly, or timed out (fail-open for availability, never `verified`) | `timeout` or `error` (`src/loop/termination.js:173-176`) | `3` |

`exitCodeForVerification` returns `0` for any other status, including a missing
`verification` object, so **exit code 0 is not by itself proof of a verified
answer** — read `verification.status`. A run that threw exits `1` from the CLI's
top-level handler (`bin/cli.js:1032-1042`), which is a failure signal, not a
verification outcome.

### Mechanism precedence and mutual exclusion

Within one round, exactly one mechanism gets to decide, in this order
(`src/loop/orchestrator.js:2866-2891`, `src/reflection/governor.js:59-129`,
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
   raises `completionSignalDetected` (`src/loop/orchestrator.js:2668-2674`),
   which both produces the `completion` stop (`src/reflection/governor.js:111-113`)
   and makes `noToolRound` false (`src/loop/orchestrator.js:2742-2746`). Declared
   completion and `no_tool` are therefore mutually exclusive.
4. **completion keyword fallback** — the same signal with no parseable envelope
   comes from `completion.signals` matching the final text
   (`src/loop/orchestrator.js:2672-2674`), or from the LLM normalizer when an
   end-turn round produced no envelope at all (`2676-2730`, opt-in via
   `reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`).
5. **`no_tool` stop** — reachable only when nothing declared completion and the
   round produced no tool call (`src/loop/orchestrator.js:2742-2746`).
6. **round judge end-turn evaluation** — `judge_done` is evaluated *before* the
   governor (2866-2873), so it outranks 2-5 in the round it fires; it requires
   `isEndTurn`, i.e. `stopReason === "end_turn"` with no tool use
   (`src/loop/orchestrator.js:2574`). A tool round can therefore never produce
   `judge_done`, and a `max_tokens` round can never produce both `judge_done`
   and `continuation_exhausted` (the mapping prefers `judge_done` anyway,
   `src/loop/termination.js:94`).
7. **post-stop verification** — after a stop reason exists, forced wrap-up may
   add one more provider call for the three non-continuable reasons
   (`src/loop/termination.js:203-256`), then `finalGuard` may accept, skip,
   revise, or fail. A `revise` verdict is not terminal: it injects a user
   message and governance starts over for that round
   (`src/loop/orchestrator.js:3039-3061`). Revision retries are bounded by
   `finalGuardMaxRetries` (default 2, `src/loop/orchestrator.js:1377-1380`),
   and the guard's own timeout defaults to 30 s
   (`src/loop/orchestrator.js:1381-1383`).
8. **`fail()` classification** — any throw at any point replaces all of the
   above with `aborted` (signal set) or `failed` / `persistence_failed`
   (`src/loop/orchestrator.js:845-895`).

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

The file-backed `NotesStore` canonicalizes each `scopeRef` exactly at the
adapter boundary. Unsafe scope references such as `../escape`, absolute paths,
and encoded separators are mapped to a stable `run-h-...` directory; the same
canonical value is used for the directory and persisted `record.scopeRef`.
Hosts and skills must pass the original logical scope reference to the adapter,
not pre-canonicalize it. Existing directories whose scope reference is already
in canonical hashed form remain readable and participate in list, complete,
revoke, and purge operations.

The file adapter assumes one writer per scope/key. Concurrent read-modify-write
updates can lose one update and its superseded history (last-write-wins).
Hosts that need concurrent updates must serialize them at the host boundary;
the adapter does not add a lock or another concurrency mechanism. `revoke`
carries this one step further at the API level: an `expectedState` /
`expectedUpdatedAt` guard makes a revoke that raced with another writer return
`{ status: "unchanged" }` instead of overwriting a record it did not see.

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
