# Host upgrade guide for 0.14.0

Version 0.14.0 splits the run-state terminal status out of the snapshot channel
(issue #91 item 2, ADR-019), retires notes write-side credential detection
(issue #136), and drops two previously exported surfaces (`erix-agent/tools`
credential helpers, the `src/loop.js` forwarding shim). It also adds two
opt-in capabilities that change nothing by default: the tool replay
declaration (`replay` + `replayPolicy`) and partial stream persistence
(`partialPersistence`).

The breaking items are all host-facing reads/exports; the engine's default
resume behaviour is unchanged. See
[host-consumer-contract.md](host-consumer-contract.md) for the current contract
text, [ADR-019](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/019-run-state-store-authority.md) for the run-state
decision, and the changelog for the full entry list.

> **Scope note:** this is the 0.14.0 upgrade guide, not current release notes.
> If you migrate from <= 0.13.0, read the 0.13.0 changelog section first — that
> release renamed `saveCheckpoint`/`loadLatestCheckpoint` to
> `saveRunSnapshot`/`loadLatestRunSnapshot` and demoted the run-state methods to
> optional capabilities.

## 1. Run-state terminal status moved to its own channel

`loadRunState(runId)` used to return a mixed object: the latest snapshot fields
**plus** a `state` string (`running` / `succeeded` / `failed` / `aborted` /
`guard_error` / `unverified_error`). Those are now separate channels.

- `saveRunState` **no longer writes** the `state` key. It remains the latest-only
  snapshot (resume现场) only.
- `markRunState` writes the terminal status through its own channel.
- New host-facing reader: `loadRunStateStatus(runId)` → the status **string**
  (`Promise<string | undefined>`; `undefined` when no status is recorded for
  that run yet). It returns a plain string, not a status record object.
- A status file that is corrupt or malformed **throws** instead of silently
  falling back to a possibly stale value.
- Backward compatibility for stored data: `loadRunState` still passes an
  embedded legacy `state` through unchanged, and `loadRunStateStatus` falls back
  to it. **No data migration is required.**

```js
// <= 0.13.0
const runState = await store.loadRunState(runId);
if (runState?.state === "succeeded") { /* ... */ }

// 0.14.0
const status = await store.loadRunStateStatus(runId);   // host-facing read
if (status === "succeeded") { /* ... */ }
const snapshot = await store.loadRunState(runId);       // snapshot fields only
```

`loadRunStateStatus` resolves to the status string directly (compare it with
`===`, not `status?.status`); if you need snapshot fields such as
`stateVersion`, `deterministic`, or `semantic`, keep reading them from
`loadRunState`.

`loadRunStateStatus` is deliberately **not** part of `RUN_STATE_STORE_METHODS`
or `OPTIONAL_TRANSCRIPT_STORE_METHODS`: the engine never calls or validates it,
so stores that only implement the older three-method shape do not receive a
spurious `persistence_capability_degraded` event.

## 2. Notes write-side credential detection retired

`note_take` no longer inspects the key/content shape to block suspected
credentials. Writes and read-back are now consistent (issue #136): whatever the
host writes is what it reads.

- If you relied on the engine to refuse credential-shaped note writes, do that
  check in your own tool-call layer.
- `src/tools/credential-patterns.js` is retained for internal use (run-state
  redaction, `bin/final-guard*` candidate filtering) but is not a public surface.

## 3. `erix-agent/tools` no longer exports the credential helpers

`looksLikeCredential` and `normalizedLabel` are removed from the
`erix-agent/tools` subpath export. If you imported them, vendor your own
implementation (or use your host's own redaction policy) — they were
presentation helpers, not a contract.

## 4. `src/loop.js` forwarding shim deleted

`runToolLoop` and `parseReflectionDecision` are exported from the package entry
(`erix-agent`, `src/index.js`), which is unchanged. Only the internal relative
path `src/loop.js` disappeared:

```js
// <= 0.13.0 (deep relative import into the package)
import { runToolLoop } from "./node_modules/erix-agent/src/loop.js";

// 0.14.0
import { runToolLoop } from "erix-agent";
```

The package `exports` map never exposed `./loop.js`, so package-name subpath
imports were already unreachable; only hosts that reached into `src/` are
affected.

## 5. New opt-in capabilities (no action required)

Both default to the previous behaviour; enable them only if you need them.

### 5.1 Tool replay declaration (`replay` + `replayPolicy`)

Tool definitions may declare `replay: "safe" | "unsafe"` (omitted = `unsafe`;
other values are rejected at startup). The declaration is engine metadata and
is not sent to the model. `run snapshot.pendingToolUses` records the resolved
declaration per pending call.

- `replayPolicy: "always-replay"` (**default**) — unchanged: every pending tool
  replays after resume, declarations are ignored.
- `replayPolicy: "per-tool-declaration"` — only `safe` calls replay. An
  `unsafe` call (including one from an older snapshot with no `replay` field)
  is **not** executed; the model receives a `tool_result` with
  `executionStatus: "interrupted"`, `is_error: true`, and any captured output,
  and the engine emits the optional `tool_replay_decision_required` event for
  the host to resolve. The engine never retries it itself.

### 5.2 Partial stream persistence (`partialPersistence`)

`partialPersistence: false` (**default**) | `{ intervalMs, minBytes? }`.
When enabled, streamed assistant text is written to the existing run snapshot
on an interval (single-flight commits, `partialText` / `partialRound`), so a
crash loses at most one interval of generation instead of a whole round. Resume
appends a valid partial as an assistant message; snapshots without the field
are unaffected.

**Prerequisite:** it requires `stream: true`. The engine's `stream` default is
`false`, and enabling `partialPersistence` without streaming now fails fast at
startup with `TypeError: partialPersistence requires stream: true` (issue #143)
instead of silently persisting nothing.

## 6. Upgrade checklist

1. Replace `loadRunState(runId).state` reads with
   `loadRunStateStatus(runId)` — it resolves to the status string
   (`Promise<string | undefined>`), not a record object (keep `loadRunState`
   for snapshot fields).
2. Move any note-write credential policy into your own tool layer.
3. Drop imports of `looksLikeCredential` / `normalizedLabel` from
   `erix-agent/tools`; import the engine from the package entry rather than
   `src/loop.js`.
4. Optional: declare `replay` on side-effecting tools and opt into
   `replayPolicy: "per-tool-declaration"`; opt into `partialPersistence` only
   together with `stream: true`.
5. Run your host test suite; `node --test` on the engine is green
   (944 pass / 0 fail / 5 skipped at release).

## 7. Self-check commands for this release (issue #183)

This release moves data between host-side channels, and the new reader is the
one piece the engine will never validate for you. Verify it rather than
assuming your adapter has it:

```bash
# loadRunStateStatus is deliberately NOT part of RUN_STATE_STORE_METHODS:
# a store that lacks it produces no warning at all, so probe it explicitly.
node -e "import('./your-store.js').then(async (m) => {
  const store = await m.createStore();
  console.log(['appendRound', 'load', 'saveRunState', 'loadRunState', 'markRunState',
               'loadRunStateStatus'].filter((k) => typeof store[k] !== 'function'));
});"

# old terminal-status reads must be gone from your source
grep -rn "loadRunState(.*)?\\.state\\|loadRunState(.*)\\.state" src/ bin/

# the two removed exports must not be imported any more
grep -rn "looksLikeCredential\\|normalizedLabel" src/ bin/
```

If your host keeps the terminal status in a column rather than a file, the
column is host-owned: check it with

```sql
SHOW COLUMNS FROM your_runs LIKE 'status';
```

and land it on **both** the new-install baseline and the upgrade migration — a
status column added only to the migration path is missing on every fresh
install, where `loadRunStateStatus` then silently returns `undefined` (see
[host-upgrade-guide-0.17.0.md](host-upgrade-guide-0.17.0.md) §4 and §5).

`partialPersistence` (§5.2) carries its own self-check: boot once with
`partialPersistence: { intervalMs: 1000 }` and `stream` unset and require the
startup `TypeError` (`partialPersistence requires stream: true`). No error means
the option was dropped before it reached the engine — a host-side wiring bug,
not an engine bug.
