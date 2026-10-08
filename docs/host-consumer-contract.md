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
