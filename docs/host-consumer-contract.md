# Host Consumer Contract

> Chinese version: [host-consumer-contract_cn.md](host-consumer-contract_cn.md)

This document defines the host integration boundary for `erix-agent`. The engine
maintains auditable run facts; the host owns tool permissions, archive policy,
retry/rerun policy, and the final consumption decision. See
[ADR-012](decisions/012-engine-truth-model-efficiency-host-policy.md) and
[ADR-013](decisions/013-guard-charter.md) for the responsibility boundary.

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
`finalText`, `messages`, `round`, `rounds`, `signal`, and `termination`, plus
the current `rerunDetected` value. `{ action: "accept" }` permits normal
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
`degraded`, or `error`. An accepted decision with `rerunCited: true` is still
`verified`, but is counted separately in `verification.metrics.rerun_cited`.
When a store provides `markRunState`, the terminal state is
`unverified_error` for an unverified result, `guard_error` for a guard error,
and `succeeded` otherwise.

The engine has no separate "delivery authentication" or "completion
authentication" layer. It reports facts such as rounds, tools, file calls,
archives, termination, and verification. Whether the task is complete,
whether the deliverable meets its requirements, and whether it may proceed
automatically downstream remain decisions for the host, test system, or human
review.

### CLI-side provenance guard

The CLI guard in `bin/final-guard.js` is a deterministic provenance checker,
not a task-completion evaluator. It considers only capture manifests under
`archiveDir` that can be verified as `kind: "erix.tool-capture"` with
`schemaVersion: 1`, a matching archive path inside the run archive root, a
regular non-symlink archive file, `replayable: false`, `truncated: false`, a
64-character hexadecimal `digest`, a valid `locator`, and a digest matching
the archive bytes. Replayable artifacts and artifacts with `unknown`
replayability do not become trusted capture values. Missing, forged, escaped,
truncated, or digest-mismatched captures cannot establish verification.

No capture manifest returns `action: "skip"` with
`reason: "no_capture_manifest"`. A readable artifact with no extractable
candidates returns `action: "skip"` with
`reason: "no_extractable_candidates"`. A final answer with no comparable
explicit label returns `action: "skip"` with
`reason: "no_comparable_label"`. Explicit attributions are compared with
captured values. A value from the first capture may be accepted directly; a
value from a later rerun requires an explicit source reference such as
`来源=note_read:<key>` or `来源=归档:<file>`, and is returned as
`{ action: "accept", rerunCited: true }`. The guard does not add natural
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

## `replayableSource` and artifact state

The trust order for `replayableSource` is:

`declared > policy > heuristic > unknown`.

An explicit declaration wins first, then the configured non-replayable
policy, then the built-in `exec` heuristic. `unknown` means that there is
not enough declaration to make a replayability claim: it must not be treated
as safe, replayable, or verified, and it must not be converted into a
boolean safety assertion. In the `unknown` case, `replayable` is omitted
rather than defaulted.

Archive and artifact facts use `ok`, `truncated`, `missing`, `stale`, and
`unrecoverable`. An artifact carries an `artifactId`, `archivePath`, `digest`,
`locator`, and status metadata; consumers must return to that exact
`artifact`/`locator` and verify the `digest` instead of trusting a display
string. Archives larger than 1 MiB are stored with `truncated: true` and a
digest of the bytes actually on disk; such an artifact cannot pass the CLI
provenance guard.

`createMemoryTranscriptStore` and `createFileTranscriptStore` isolate
transcript records by `runId`. `appendRound` deduplicates by
`dedupKey`, then `roundKey`, then `${runId}:round:${round}`. This is
persistence idempotence only; it does not deduplicate or suppress tool
execution. The file store is designed for one writer per `runId`; concurrent
cross-process writes require a host-provided file lock.

## Repeated commands and side effects

With a CLI `archiveDir`, the same normalized `exec` command is **executed and
reported**, not blocked. Normalization trims outer whitespace and normalizes
line endings. Duplicate tracking is scoped to the archive directory and
hydrates existing capture metadata, so it can identify a prior execution in a
new CLI tool instance. Each execution attempts its own archive; an archive
failure leaves no recoverable artifact.

The structured tool-result metadata reports the first execution through
`rerunOf`:

```js
{
  round,
  artifactId,
  archivePath,
  digest,
  locator,
  status,
}
```

The model-facing notice is only a bounded display of the safe first value,
archive path, and artifact status. Hosts that need `round`, `digest`,
`locator`, or the complete provenance record must read the structured
metadata, not parse the notice. Repeated execution also sets
`runState.rerunDetected`; it does not prove that the model will use the first
source correctly. `rerunOf` and its notice cannot undo a payment, deletion,
publication, write, or external API side effect that has already occurred.

The host must therefore carry side-effect and rerun risk in its tool
capabilities, permissions, sandbox, or idempotence layer, and decide whether
`unrecoverable`, `stale`, or `unverified` should trigger human review, a
retry, or failure. The guard remains an opt-in mechanical checker; do not add
natural-language inference, keyword guessing, or similarity rules to it.
Prefer source-level mechanisms such as folded stubs, structured notices,
producer declarations, and bounded retrieval.

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
