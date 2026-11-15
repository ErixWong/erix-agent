<!-- doc-version: 0.33.0 -->
# Host upgrade guide: 0.33.0

> Scope: run-snapshot retirement and its host-facing consequences (#838), before the 0.33.0 version cut.
> An already-running process is not migrated in place.

## 1. Read this first

| If you … | then in 0.33.0 |
|---|---|
| keep `<runId>.snapshot.json` | it is a stale file and may be deleted; the engine no longer reads or writes it (§2.1) |
| implement `saveRunSnapshot` / `loadLatestRunSnapshot` or old `loadLatestCheckpoint` | the engine no longer calls these methods; keeping or removing them is harmless (§2.2) |
| have a run in flight during upgrade | finish it on the old version or restart it; the ledger is the only source of truth (§2.3) |
| need the body of an interrupted tool result | the crash gap can lose it; recovery reports only what the ledger proves (§2.4) |
| inspect `errors.checkpoint` in run-state | it remains for shape compatibility, is always `0`, and never increases |

## 2. Run-snapshot retirement (#838)

### 2.1 The engine no longer reads or writes run snapshots

`<runId>.snapshot.json` files left by older versions are stale artifacts, not recovery input. The
engine neither writes a new snapshot nor reads an old one. You may delete a stale file; there is no
snapshot migration to perform. Resume is reconstructed from the ledger.

### 2.2 Snapshot store methods are not called

`saveRunSnapshot` and `loadLatestRunSnapshot` are no longer called by the engine. The legacy name
`loadLatestCheckpoint` is also unused. Keeping these methods in a store implementation is harmless;
removing them does not cause an engine error. They are no longer a capability hosts need to provide.

### 2.3 Finish or restart in-flight runs

Before upgrading a process with a run in flight, either let that run finish on the old version or
stop it and restart from the ledger on the new version. Do not expect an in-memory or on-disk
snapshot to bridge the version change. The ledger is the sole recovery truth.

### 2.4 The tool-result crash gap can lose body text

If a process crashes after a tool returns but before its result is committed to the ledger, that
tool's result body is lost. When the ledger proves the tool ran, the engine uses
`UNPERSISTED_TOOL_RESULT_TEXT` (“ran, result unavailable”); with no execution evidence it uses
`NO_EVIDENCE_TOOL_RESULT_TEXT` (“unknown”). It does not claim “never executed” without evidence.

## Retired run-snapshot / checkpoint errors

Run snapshots no longer participate in persistence or recovery. The engine therefore no longer emits
`checkpoint_failed`, and `persistence_error.phase` no longer takes `checkpoint_before_tool` or
`checkpoint_after_tool`. These names remain only as deprecated historical values; they are not aliases for
current persistence failures.

Current transcript and run-state write failures continue to use `persistence_failed` and the applicable
ledger/run-state phase. Do not retry a run based on an assumption that a checkpoint was written or rejected.
`deterministic.errors.checkpoint` remains in the run-state shape but is permanently `0`; use
`deterministic.errors.unpersisted` and its entries for persistence-failure accounting.

The `saveRunSnapshot` / `loadLatestRunSnapshot` capability declaration has been removed. Hosts may
retain private storage for their own purposes, but erix no longer discovers or invokes those methods.
Recovery facts come from the ledger, including its recovery rows.

## 3. Verify on your side

- Delete stale `<runId>.snapshot.json` files if you want to reclaim disk space; the engine ignores them.
- Keep snapshot-store methods only if other code uses them; the engine no longer calls them.
- A store that writes its independent state.json through `saveRunState` no longer puts a per-round `runState` copy in the ledger; resume is unchanged. If your store implements only `loadRunState`, add `saveRunState` too, or the engine keeps writing the fallback copy each round.
- After an interrupted tool, distinguish “ran, result unavailable” from “unknown”; neither means the
  missing body can be recovered.
