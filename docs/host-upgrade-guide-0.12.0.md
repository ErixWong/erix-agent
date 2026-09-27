# Host upgrade guide for 0.12.0

Version 0.12.0 re-contracts the notes subsystem (issues #67 / ADR-018, plus a
pre-release audit pass: unified retention, janitor removal, liveness framework
removal, purge de-pagination). The changes below are breaking for hosts that
integrate notes through `createBuiltinNotesTools` or a custom `NotesStore`.
Nothing outside notes changes in this release. See
[host-consumer-contract.md](host-consumer-contract.md) for the current contract
text and [ADR-018](decisions/018-notes-lifecycle-pagination.md) for the
reasoning.

> **Scope note:** this is the 0.12.0 upgrade guide, not current release notes.
> The bundled notes skill was already retired in 0.11.0; if you still migrate
> from <= 0.10.x, read the 0.11.0 changelog entries first.

## 1. Lifecycle is a single completion hook

The old `lifecycle.onRunStart` / `lifecycle.onRunComplete` pair ran janitor
around the run. That coupling is gone, and the no-op compatibility stub went
with it:

- `lifecycle.onRunStart` **is deleted**. Delete the call; run start performs
  zero notes maintenance.
- `lifecycle.onRunComplete()` **only** completes the run (active → done). It
  returns `{ completed, errors }` — store failures land in `errors[]` (never
  thrown over the primary error); inject `{ reportPersistenceFailure }` to
  also report them through the engine's persistence-failure bridge.
- The CLI/REPL chain their notes maintenance right after completion (see
  §5). Embedded hosts schedule their own.

```js
// <= 0.11.0
await notes.lifecycle.onRunStart();
try {
  return await runToolLoop({ /* ... */ });
} finally {
  const { errors } = await notes.lifecycle.onRunComplete();
}

// 0.12.0
try {
  return await runToolLoop({ /* ... */ });
} finally {
  const { completed, errors } = await notes.lifecycle.onRunComplete();
  // `completed` is the number of records flipped active → done.
  for (const failure of errors) hostReportCompletionError(failure.operation, failure.error);
  await hostScheduleNotesPurge(); // the host's own maintenance (§5)
}
```

## 2. Active orphan cleanup is the host's own three-line loop

The engine no longer guesses whether a scope is dead, and the 0.12.0 pre-release
audit removed the liveness port entirely: the host knows which scopes are alive
(scheduler state, process table, last heartbeat), and the public store
primitives are all it needs:

```js
const records = await store.list({ scope: "run", scopeRef, filters: { state: "active" } });
for (const record of records) {
  await store.revoke({
    scope: "run", scopeRef, key: record.key, reason: "scope_inactive",
    expectedState: "active", expectedUpdatedAt: record.updated_at,
  });
}
```

`expectedState` / `expectedUpdatedAt` are stale-read guards: they absorb the
window between the host's list and the revoke (a racing write turns the call
into `{ status: "unchanged" }` instead of overwriting a record the host did
not see). This is deliberately not a store-level CAS — the file adapter keeps
its single-writer assumption and the host serializes at the host boundary.

A host without such a loop keeps every active note forever: accumulation is
the intended behavior — better than killing a live run's notes.

## 3. `NotesStore` is six required methods, and `purge` is now one shot

The store port is now:

```text
write, read, list, complete, revoke, purge
```

`createBuiltinNotesTools` validates all six at creation time
(`assertNotesStore`); a custom store missing any of them throws `TypeError`
before the first run instead of silently falling back to the implicit file
adapter. What the methods do since 0.12.0:

- `revoke(request)` — writes a tombstone for one key. `expectedState` /
  `expectedUpdatedAt` are concurrency guards: if the record changed since the
  caller read it, the call returns `{ status: "unchanged" }` instead of
  overwriting. `note_forget` goes through this method.
- `purge(request?)` — **janitor is gone**; `purge` is the only maintenance
  method. One call scans every scope and processes it wholly; there is no
  `limit`/`cursor` protocol and no `nextCursor` — the result is
  `{ status, scanned, purged }` (`scanned` counts scope directories, `purged`
  counts deleted record files). The optional `before` date can only narrow
  the deletion window, never enlarge it.

## 4. `list()` returns an array again — `note_list` dropped cursor, limit, and the `source`/`minRelevance` filters

`store.list()` returns a plain `NoteRecord[]` (0.11.x returned an array too;
the paged `NotesListPage` experiment never shipped). Requests take an optional
`limit` (only when given, clamped to a maximum of 200 — omit it for all
matching records, which is what the internal consumers rely on), `filters`
(`state`, `tag`, `source`, `minRelevance` — the store-level filter capability
stays for internal consumers and remote-store contracts), and `sort`
(`"relevance"` | `"pinned_updated"`). There is no cursor and no
`cursor_stale` status: a maintainer review of real usage (average ~2 notes per
run, peak 9) judged pagination and the scope-revision anchor YAGNI for 0.12.0
(ADR-018 D3 reversal), and 0.12.0 is unreleased, so cutting the protocol costs
no extra breaking change. The `.revision` metadata file is gone as well.

The `note_list` tool follows the same simplification — both `cursor` and
`limit` are removed, and its filter surface shrank to `tag` / `includeInactive`
(the `source` and `minRelevance` inputs were cut; the output still carries the
derived per-note `source` marker):

```js
// 0.11.x — integer offset cursor / limit paging, output had `total`
await note_list({ limit: 50, cursor: 200 });

// 0.12.0 — no cursor, no limit, no source/minRelevance inputs
const listed = JSON.parse(await note_list({ tag: "value" }));
// { status: "found", count, notes, next }
```

`note_list` output carries `count` and the note metadata array; `total`,
`nextCursor`, and `revision` are gone.

## 5. Maintenance: one retention knob, one purge call, host-scheduled

The root rule is the **session clock** (ADR-018 D7): note lifetime = session
lifetime + the retention window. The host defines "session last activity" —
the CLI uses the transcript mtime (a session whose transcript has had no
activity for 30 days gets its notes cleaned along with the expired
transcript; a scope whose transcript is missing falls back to the newest note
file mtime), a scheduled host uses its scheduler state. The engine never
guesses and never asks.

```js
// embedded host baseline: one call, full scan, no loop
await store.purge();                       // { status, scanned, purged }
await store.purge({ before: cutoffIso });  // only ever narrows the window
```

For each scope directory, if the newest write across all its record files
(max file mtime — no JSON parsing) is older than the retention, every record
file in that scope (including `active` ones) is deleted together and the
empty directory is removed; a scope with a recent write is exempt as a whole,
even very old notes inside it. `done` / `revoked` are pure semantic labels
now — they drive model visibility and forensics, never cleanup.
`complete()` no longer writes `expires_at` (the field is retired legacy;
purge ignores it, old files need no migration).

Configuration — a single knob:

| Environment variable | Default | Semantics |
|---|---|---|
| `ERIX_NOTES_RETENTION_MS` | 30 days | unified retention: session clock (CLI host) / scope newest-write clock (`store.purge`) |
| `ERIX_NOTES_GRACE_MS` | — | deprecated alias of the above (shipped in 0.11.0); read only when the new name is absent |

`ERIX_NOTES_DONE_GRACE_MS` and `ERIX_NOTES_TOMBSTONE_RETENTION_MS` never
shipped in a release and are gone entirely — there is nothing to migrate.

## 6. Schema is run-only and auto-capture is gone

The four `note_*` schemas accept only `scope: "run"`. Passing `project` or
`user` now returns an `invalid` tool result instead of a "not yet supported"
placeholder — hosts that forwarded user-level or project-level scope requests
must stop sending them (there is no scheduled replacement).

`recordAutoCapture()` is deleted (ADR-016 follow-through): `note_take` is the
only write entry. Reading historical auto-sourced records still works — the
`@auto` provenance marker remains in `note_list` output. Hosts that called
`recordAutoCapture` (or the retired `bin/auto-capture.js` bridge) drop those
calls; the model writes what matters via `note_take`.

## 7. Housekeeping details worth knowing

- `normalizeNoteRecord()` is exported from `src/store/notes.js`. Record time
  fields are normalized on every read: missing `updated_at` falls back to
  `created_at`; a record missing both gets the fixed epoch
  `1970-01-01T00:00:00.000Z` (the adapter never fabricates "now"). The field
  is semantic metadata (sorting) since 0.12.0 — cleanup never reads it.
- `notesStoreContract` in `erix-agent/contract-tests` locks the new store
  surface (six required methods, array-returning `list`). Run it against a
  custom store before upgrading.
