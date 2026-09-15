# ADR-002: Message Storage Through the TranscriptStore Adapter, with Built-in memory + file(JSONL)

> Chinese version: [002-transcript-store_cn.md](002-transcript-store_cn.md)

- Status: Decided (2026-08-29)
- Background: The loop itself only needs an in-memory array. Persistence has value in three respects:
  ① **Crash recovery**—the current app_container behavior reruns a failed task from the beginning, burning all tokens paid for 24 development rounds;
  ② **Auditing**—every round's transcript must be traceable (both projects need this);
  ③ **recall data source**—the original text of folded content must remain available somewhere (ADR-005).

## Decision

Define the `TranscriptStore` interface (appendRound / load / recall), with two built-in implementations:

| Adapter | Form | Purpose |
|---|---|---|
| `memory` | In-process Map | Default; one-off tasks and tests |
| `file` | `dir/<runId>.jsonl`, **one appended line per round** | Crash recovery + auditing + recall backend |

JSONL record format:

```json
{"round": 7, "folded": false, "ts": "…", "messages": [ /* canonical messages added in this round */ ]}
{"round": 8, "folded": true,  "ts": "…", "messages": […], "foldedPayload": [ /* original text from folded rounds */ ]}
```

**Key semantics: folding affects context, not the archive.** Folded rounds remain complete in the store,
`load()` can reconstruct the complete history; `recall(fromRound, toRound, pattern)` reads/greps the
original text within a range.

**Crash recovery**: `runToolLoop({ store, runId, resume: true })` calls `load()` at startup to restore
messages and the round number, then continues from the checkpoint. The app_container reaper's
task-level retry thereby upgrades from "rerun from the beginning" to "resume from the checkpoint".

Checkpoint writes for tool calls have two boundaries, before and after execution: for a store that
provides both a writer and a loader, a write failure at either boundary throws `checkpoint_failed`;
after-execution failure explicitly says that the tool has already run but its result has not yet been
persisted. The loop cannot promise exactly-once in this case, so the host's `executeTool` must be
idempotent by tool id. If a round contains multiple tool_use blocks, resume executes all tools not yet
confirmed in the checkpoint in their original order, and only requests the provider again after filling
in the corresponding tool_result messages.

DB adapters (app_container writes to `task_runs`; touwaka uses a payload cache) remain project-side
implementations of the same interface.

## Rationale

- JSONL append-only writes are naturally crash-safe (unlike a whole JSON file that can be corrupted by a partial write), and streaming line-by-line reads naturally support recall grep.
- A file is the lowest common denominator with zero infrastructure, following the same philosophy as ADR-001.
- Separating the "context view" from the "complete archive" is this library's core mental model: compaction operates on the **view**, while the archive is always complete.

## Consequences

- The caller must manage the file store directory lifecycle (clean up/archive it when the task ends); the library only provides `load/recall` and does not perform GC.
- The caller guarantees runId uniqueness (recommended = the task/run primary key).
- **Archive integrity addendum (2026-08-29, discovered through v0.2 memory benchmark testing)**:
  ① Initial messages (initialMessages/initialUserMessage) are not included in per-round incremental records—the runToolLoop startup first writes a **round 0 seed record**; otherwise the initial history never enters the archive, and recall cannot find it after folding; the resume base is changed to `max(record.round)` (compatible with seed records).
  ② The `recall` search corpus must cover both `record.messages` and `record.foldedPayload` at the same time (the original text from folded rounds is in foldedPayload)—both memory/file implementations and tools/recall have been corrected and regression-tested.
