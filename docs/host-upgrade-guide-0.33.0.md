<!-- doc-version: 0.33.0 -->
# Host upgrade guide: 0.33.0

> Scope: run-snapshot retirement and contract cleanup (#838 S2). This guide records the host-facing names and
> values that are no longer part of the active persistence contract.

## Read this first

| If you … | then in 0.33.0 |
|---|---|
| catch `checkpoint_failed` | stop treating it as a current engine error; it is deprecated and never emitted since run-snapshot retirement |
| branch on `persistence_error.phase` | remove `checkpoint_before_tool` and `checkpoint_after_tool` from active phase handling; neither is emitted now |
| inspect `errors.checkpoint` in run-state | the field remains for shape compatibility, is always `0`, and never increases |
| implement run-snapshot methods only for erix | remove that optional capability from the adapter contract; the engine no longer calls it |
| recover a run | rely on the transcript ledger and run-state, not run-snapshot fallback fields |

<a id="retired-run-snapshot-checkpoint-errors"></a>
## Retired run-snapshot checkpoint errors

Run snapshots no longer participate in persistence or recovery. The engine therefore no longer emits
`checkpoint_failed`, and `persistence_error.phase` no longer takes `checkpoint_before_tool` or
`checkpoint_after_tool`. These names remain only as deprecated historical values; they are not aliases for
current persistence failures.

Current transcript and run-state write failures continue to use `persistence_failed` and the applicable
ledger/run-state phase. Do not retry a run based on an assumption that a checkpoint was written or rejected.
`deterministic.errors.checkpoint` remains in the run-state shape but is permanently `0`; use
`deterministic.errors.unpersisted` and its entries for persistence-failure accounting.

The `saveRunSnapshot` / `loadLatestRunSnapshot` capability declaration has been removed. Hosts may retain
private storage for their own purposes, but erix no longer discovers or invokes those methods. Recovery facts
come from transcript rows, recovery rows, and run-state.
