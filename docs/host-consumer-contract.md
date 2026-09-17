# Host Consumer Contract

> Chinese version: [host-consumer-contract_cn.md](host-consumer-contract_cn.md)

This document defines the host integration boundary for `erix-agent`. The engine
maintains auditable run facts; the host owns tool permissions, archive policy,
retry/rerun policy, and the final consumption decision. See
[ADR-012](decisions/012-engine-truth-model-efficiency-host-policy.md) and
[ADR-013](decisions/013-guard-charter.md) for the responsibility boundary.
The 0.6.0 migration steps are in
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md).

## `runToolLoop` options

`runToolLoop` accepts only the following top-level option keys. An unknown key
throws `TypeError` instead of being silently ignored. Host-private metadata
must be placed in an explicit namespace such as `toolContext` or `context`.

```text
assemblyPort, provider, system, wrapup, initialUserMessage, initialMessages, tools,
writeToolNames, writeToolPathKeys, executeTool, maxRounds, maxTokens,
temperature, topP, timeoutMs, deadlineMs, reflection, stallDetection, retry,
completion, finalGuard, finalGuardMaxRetries, finalGuardTimeoutMs,
maxTokenContinuations, context, resourceStore, todoStateProvider, semanticStateProvider,
modelConfig, modelMetadata, model, expert, user, task, session, requestId,
toolContext, store, persistence, runId, runState, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent
```

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

## AssemblyPort

Hosts that assemble a complete run can provide one validated composition root
instead of repeating the individual wiring:

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider
  provider,    // Provider
  tools: { definitions, executeTool, getToolMetadata? },
  store,       // complete TranscriptStore
  session: { id, resume?, initialMessages? },
  resourceStore?, // opaque archive adapter
  policy?,     // explicit run options
  emit?,       // (eventType, payload) => void
});

await runToolLoop({ assemblyPort });
```

`modelConfig`, `provider`, `tools`, `store`, `session`, `resourceStore`, and `policy` may also
be synchronous zero-argument factories when passed to `createAssemblyPort`.
The required methods are checked at assembly/startup: `modelConfig.resolve`,
either `provider.chat` or `provider.chatStream`, `tools.definitions`,
`tools.executeTool`, `session.id`, and
all nine `TranscriptStore` methods. A missing method throws `TypeError`
before the run starts. `policy` contains only named `runToolLoop` options;
unknown policy keys are rejected.

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
`resourceStore` is a top-level loop option rather than a field tunneled through
`context`; an explicit `context` therefore cannot discard the assembled archive
adapter.
An assembly-shaped fine-grained entry performs the same provider, executor,
model-config, session, and required-persistence fail-fast checks before the
first provider call. `persistence: "none"` does not require a TranscriptStore.

The library's `createAssemblyPort` is the reference assembly implementation;
it performs no I/O. The CLI continues to use its existing file-backed
provider, tool, and transcript adapters, so no host needs to adopt the port
in one migration.

## ResourceStore

`ResourceStore` is the boundary for archived or otherwise external resources.
Its locator is opaque to the library:

```js
resourceStore.put(bytesOrText)
// -> Promise<{ locator, digest, display }>

resourceStore.get(locator)
// -> Promise<string|Uint8Array>
```

`put` must return the exact locator used by `get`, a stable digest of the
stored bytes, and a non-empty host-facing `display` string. `get` returns the
stored resource unchanged; an unknown locator must reject with an explicit
not-found error, and adapter failures must propagate. The engine never parses
locator fields or assumes paths, URI syntax, line numbers, or byte offsets.
Fold navigation records carry the adapter's locator and display; display is
the only string intended for a model-facing stub.

`createFileResourceStore({ dir })` is the built-in filesystem adapter. Its
locator is an opaque object and its display is an opaque model-facing reference;
hosts may replace it with an object store, database, or service
without changing folding or recall code. `resourceStoreContract` checks
round-trip fidelity, stable/different digests, store isolation, unknown-locator
behavior, return shapes, and failure propagation. CLI compression writes new
capture artifacts through the run-local `createFileResourceStore`; manifests
carry opaque locators and the final guard reads them through `store.get()`.
Older manifests containing only `archivePath` and line locators remain readable
through the legacy filesystem path and are marked legacy by the reader.

## Reusable normalization primitives

Hosts that provide their own OpenAI-compatible transport can import these
helpers from the package root. They perform no I/O or model calls:

| Export | Signature | Semantics |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | Maps OpenAI token fields and canonical aliases to `input_tokens`/`output_tokens`; empty or non-object input is omitted. |
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
| `skipped` | There was nothing the guard could compare, or the guard was not enabled. **This does not mean that the answer is correct** and must not be rewritten as `verified`. |
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
`continuation_exhausted`, or `reflection_stop`. The guard receives
`finalText`, `messages`, `round`, `rounds`, `signal`, and `termination`. `{ action: "accept" }` permits normal
termination. `{ action: "skip", reason }` terminates with `skipped`. A
`{ action: "revise", message }` decision is injected as a separate user text
message and the loop continues, up to `finalGuardMaxRetries` revision retries
(default 2). If revision is still required at the limit, the loop keeps the
last `finalText`, sets `verification.status` to `unverified`, and terminates
with `termination.reason === "final_guard_unverified"` (fail-closed).

The non-continuable stop reasons `max_rounds_cap`, `stall`,
`continuation_exhausted`, and `reflection_stop` cannot become verified merely
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

### NotesStore scope and write contract

The file-backed `NotesStore` canonicalizes each `scopeRef` exactly at the
adapter boundary. Unsafe scope references such as `../escape`, absolute paths,
and encoded separators are mapped to a stable `run-h-...` directory; the same
canonical value is used for the directory and persisted `record.scopeRef`.
Hosts and skills must pass the original logical scope reference to the adapter,
not pre-canonicalize it. Existing directories whose scope reference is already
in canonical hashed form remain readable and participate in list, complete, and
janitor operations.

The file adapter assumes one writer per scope/key. Concurrent read-modify-write
updates can lose one update and its superseded history (last-write-wins).
Hosts that need concurrent updates must serialize them at the host boundary;
the adapter does not add a lock or another concurrency mechanism.

### CLI-side provenance guard

The CLI guard in `bin/final-guard.js` is a deterministic provenance checker,
not a task-completion evaluator (ADR-016). Evidence is the run transcript's
archived tool outputs (`toolOutputs`, byte-faithful) plus legacy capture
manifests; there is no replayability filter — every archived output is
evidence. An explicit `label=value` in the final text must match an archived
value, otherwise the guard returns `revise`. Missing, forged, escaped, or
truncated evidence cannot establish verification.

A run with no archived outputs returns `action: "skip"` with
`reason: "no_capture_evidence"`. Archived outputs with no extractable
candidates return `action: "skip"` with
`reason: "no_extractable_candidates"`. A final answer with no comparable
explicit label returns `action: "skip"` with
`reason: "no_comparable_label"`. The guard does not add natural
language inference, keyword guessing, or similarity rules. A skipped check
is still not `verified`.

## Bounded recall

Use the object form of the store API for precise, bounded retrieval. Every
limit must be enforced at the store source:

```js
const page = await store.recall({
  runId,
  fromRound,
  toRound,
  pattern,
  artifactRef,
  limit,
  maxBytes,
  cursor,
});
```

`runId`, `fromRound`, `toRound`, `pattern`, `artifactRef`, `limit`,
`maxBytes`, and `cursor` are the object-form request fields. `fromRound` and
`toRound` are non-negative integer bounds; `pattern` is an optional substring
filter. `artifactRef` may identify one exact artifact by its string identity
or by fields such as `artifactId`, `id`, `archivePath`, or `digest`. `limit`
and `maxBytes` are optional caps; `limit: 0` and `maxBytes: 0` are rejected
with `status: "error"` and no cursor. The legacy positional
`store.recall(runId, fromRound, toRound, pattern)` form remains a separate
string-returning interface and does not provide bounded-page statuses or
cursors.

`cursor` is opaque. Do not parse, concatenate, edit, or reuse it across a
different `runId`, range, `pattern`, `limit`, `maxBytes`, `artifactRef`, or
source version. It binds all of those values plus cursor version `v` and a
`sig`. The signature is a SHA-256 digest of the normalized payload truncated
to 16 hexadecimal characters. Callers must not depend on or modify the
encoding, field layout, or payload. A malformed or empty cursor, invalid
base64url, non-JSON payload, missing field, unknown version, or failed
signature returns `status: "cursor_mismatch"`, empty `text`, and no new
cursor. The implementation must not silently restart from the beginning or
skip content. A valid cursor whose source version or bound request no longer
matches returns `status: "stale"`, also with no consumable text. Both
`cursor_mismatch` and `stale` must be discarded rather than consumed.

The result is an object containing `text`, `truncated`, and `status`, with
`nextCursor` when more bounded content remains and `error` when applicable.
`truncated` requires the caller to resume with the returned `nextCursor`; a
single bounded page is not a complete archive. Retrieval slices by UTF-8
bytes without splitting a code point, so continuation can reassemble a
fragment without duplicate or omitted fragment bytes. The file store caps a
single JSONL source record at 64 KiB for bounded parsing. If that record is
larger, it is skipped and the file store returns `truncated` with
`error.code: "record_too_large"` and a resumable cursor.

`artifactRef` selects only the exact matching artifact. If it is not found,
the result is `status: "unrecoverable"` rather than a successful empty
string. `unrecoverable` also reports an absent or incomplete requested range
that cannot be proved complete. `empty` means that no fragment matched when
no exact artifact was requested. Invalid request parameters and zero caps
use `status: "error"`. The memory store uses a revision source version; the
file store uses the transcript file identity, size, and modification time.
A file-store cursor can therefore be resumed by a new store instance when
the source has not changed, but the signature is not keyed and is not an
adversarial authentication boundary.

Bounded recall is raw transcript navigation, not semantic search, completion
proof, or provenance verification. This library does not provide a security
boundary; under ADR-009, the host remains responsible for permissions,
leases, and adversarial authentication.

`createMemoryTranscriptStore` and `createFileTranscriptStore` isolate
transcript records by `runId`. `appendRound` deduplicates by
`dedupKey`, then `roundKey`, then `${runId}:round:${round}`. This is
persistence idempotence only; it does not deduplicate or suppress tool
execution. The file store is designed for one writer per `runId`; concurrent
cross-process writes require a host-provided file lock.

## Repeated commands and side effects (ADR-016)

The engine performs no replayability classification, rerun detection, or
rerun notices. A repeated command is executed normally and returns its fresh
output. The rerun-value-mismatch risk is carried by one line in the system
prompt: "Re-running the same command may produce a different value; when an
earlier exact value is needed, retrieve it with recall instead of relying on
memory."

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

## Run state

The engine builds a deterministic run state and can inject its bounded
rendering when context is folded. It replaces the single existing run-state
block rather than appending duplicates, and persists the current state with
`saveRunState` when the supplied `TranscriptStore` supports it. The
deterministic portion contains engine-known facts only: budget, tool call
counts and failures, written-file paths, injected todo state,
fold/navigation/capture counts, termination, and tool/checkpoint/archive
error counts. The current termination reason is exposed through the same
termination values as the loop, including `end_turn`, `no_tool`, `stall`,
`max_rounds_cap`, `reflection_stop`, `judge_done`,
`continuation_exhausted`, `final_guard_unverified`, `aborted`, and `failed`.

`todoStateProvider` is an optional host callback for todo state.
`semanticStateProvider` is an optional host callback that supplies bounded
semantic text and a version. A version mismatch marks the semantic portion
`stale`; semantic data is additive and cannot overwrite deterministic facts.
The engine does not call a model to obtain semantic state.

The persisted object is bounded by
`RUN_STATE_MAX_SERIALIZED_BYTES` (`64 * 1024`). The rendered prompt block is
bounded by `RUN_STATE_MAX_CHARS` (`400`). The run-state helpers also cap tool
entries at 128, file entries at 128, todo entries at 64, ordinary bounded
name/path/id/status fields at 120 characters, and semantic source text at 220
characters. When entries or serialized state are trimmed,
`bounds.truncated` and the applicable omission counts are explicit; the
rendered block uses `[run state truncated]` when its 400-character limit is
reached.

An unknown schema or incomplete persisted state is not silently treated as a
valid default. On resume it is exposed as
`runState.stateAvailability.status = "state_unavailable"` (for example,
`unknown_schema` or `missing_fields`). A corrupt file-store JSON state is also
reported as unavailable rather than restored. An entirely absent persisted
state is normal and is not the same as a present but invalid state.
