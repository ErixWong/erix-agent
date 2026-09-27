# Host upgrade guide for 0.12.0

Version 0.12.0 re-contracts the notes subsystem (issues #67 / ADR-018). The
changes below are breaking for hosts that integrate notes through
`createBuiltinNotesTools` or a custom `NotesStore`. Nothing outside notes
changes in this release. See
[host-consumer-contract.md](host-consumer-contract.md) for the current contract
text and [ADR-018](decisions/018-notes-lifecycle-pagination.md) for the
reasoning.

> **Scope note:** this is the 0.12.0 upgrade guide, not current release notes.
> The bundled notes skill was already retired in 0.11.0; if you still migrate
> from <= 0.10.x, read the 0.11.0 changelog entries first.

## 1. Lifecycle is a three-phase contract

The old `lifecycle.onRunStart` / `lifecycle.onRunComplete` pair ran janitor
around the run. That coupling is gone:

- `onRunStart()` is now a **no-op compatibility entry**. It runs no notes GC
  and returns `{ status: "skipped", reason: "notes janitor is host-scheduled; run start performs no notes GC" }`. Calling it is harmless; deleting the call is
  the migration.
- `onRunComplete()` **only** completes the run (active → done). It returns
  `{ completed, errors }` — the old `janitor` field on that result is removed.
- `lifecycle.revokeInactive({ scopeRefs, reason? })` is new: it is the entry
  point for the host's active-orphan cleanup and is described in §2.

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
  // store failures land in `errors[]` (never thrown over the primary error);
  // inject { reportPersistenceFailure } to also report them through the
  // engine's persistence-failure bridge.
  for (const failure of errors) hostReportCompletionError(failure.operation, failure.error);
}
```

## 2. Active orphan cleanup is the host's liveness decision

The engine no longer guesses whether a scope is dead. Time-heuristic orphan
cleanup (the old `ERIX_NOTES_GRACE_MS` behavior) is removed because a quiet
scope is not proof of a dead run. Since 0.12.0 a host that wants active orphan
reclamation passes a liveness port to the assembler:

```js
const notes = createBuiltinNotesTools({
  runId,
  notesDir,
  notesStore,
  liveness: {
    ttlMs: 60 * 60 * 1000,              // scope considered dead after 1h of silence
    isAlive: (scopeRef, { now, ttlMs }) => {
      const last = hostLastHeartbeatAt(scopeRef); // host's own knowledge
      return now - last < ttlMs;
    },
  },
});

// scheduled by the host, not by the engine:
const result = await notes.lifecycle.revokeInactive({
  scopeRefs: hostListScopeRefs(),       // host enumerates candidate scopes
  reason: "scope_inactive",
});
// { checked, alive, revoked, skipped, errors? }
```

`liveness.ttlMs` must be a positive safe integer and `liveness.isAlive` must
return a boolean; otherwise the assembler throws at creation time. An
`isAlive` throw is a failure signal reported in `errors[]` — it is never
interpreted as "dead", so a flaky liveness probe cannot trigger revokes.

A host **without** liveness keeps every active note forever: active orphans
are never reclaimed automatically. Accumulation is the intended behavior —
better than killing a live run's notes.

## 3. `NotesStore` grew to seven required methods

The store port is now:

```text
write, read, list, complete, revoke, janitor, purge
```

`createBuiltinNotesTools` validates all seven at creation time
(`assertNotesStore`); a custom store missing any of them throws `TypeError`
before the first run instead of silently falling back to the implicit file
adapter. What the new/changed methods do:

- `revoke(request)` — writes a tombstone for one key. `expectedState` /
  `expectedUpdatedAt` are concurrency guards: if the record changed since the
  caller read it, the call returns `{ status: "unchanged" }` instead of
  overwriting. `note_forget` now goes through this method (it no longer
  writes the tombstone itself).
- `janitor(request)` — narrowed to expired-done cleanup only: it revokes
  records whose state is `done` and whose `expires_at` has passed. The result
  is `{ status, scanned, revoked, nextCursor }`; the old `changed` field is
  gone, and the cursor is a numeric offset.
- `purge(request)` — really deletes tombstone files (`state: "revoked"` whose
  `revoked_at` is older than the retention window), re-reading each candidate
  before `unlink`. Its cursor is an opaque per-entry key — do not construct it
  yourself — because a numeric offset would skip entries as files are removed.

## 4. `list()` returns an array again — `note_list` dropped cursor and limit

`store.list()` returns a plain `NoteRecord[]` (0.11.x returned an array too;
the paged `NotesListPage` experiment never shipped). Requests take an optional
`limit` (only when given, clamped to a maximum of 200 — omit it for all
matching records, which is what the internal `complete`/`revokeInactive`
consumers rely on), `filters` (`state`, `tag`, `source`, `minRelevance`), and
`sort` (`"relevance"` | `"pinned_updated"`). There is no cursor and no
`cursor_stale` status: a maintainer review of real usage (average ~2 notes per
run, peak 9) judged pagination and the scope-revision anchor YAGNI for 0.12.0
(ADR-018 D3 reversal), and 0.12.0 is unreleased, so cutting the protocol costs
no extra breaking change. The `.revision` metadata file is gone as well.

The `note_list` tool follows the same simplification — both `cursor` and
`limit` are removed, and it always returns every matching note in the scope:

```js
// 0.11.x — integer offset cursor / limit paging, output had `total`
await note_list({ limit: 50, cursor: 200 });

// 0.12.0 — no cursor, no limit; narrow with filters when the list is long
const listed = JSON.parse(await note_list({ tag: "value" }));
// { status: "found", count, notes, next }
```

`note_list` output carries `count` and the note metadata array; `total`,
`nextCursor`, and `revision` are gone. If the list is longer than useful,
narrow it with `tag`/`source`/`minRelevance` filters.

## 5. Maintenance scheduling moved to the host

Run start/end no longer trigger janitor, and nothing purges tombstones on its
own. The host owns three explicit maintenance loops:

```js
// (a) expired done cleanup — numeric cursor
let cursor;
do {
  const page = await store.janitor({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
  cursor = page.nextCursor;              // null terminates the loop
} while (cursor !== null);

// (b) tombstone cleanup — opaque per-entry cursor
let purgeCursor;
do {
  const page = await store.purge({ limit: 200, ...(purgeCursor === undefined ? {} : { cursor: purgeCursor }) });
  purgeCursor = page.nextCursor;
} while (purgeCursor !== null);

// (c) active orphan cleanup — host liveness (see §2)
await notes.lifecycle.revokeInactive({ scopeRefs: hostListScopeRefs() });
```

Configuration for (a) and (b):

| Environment variable | Default | Semantics |
|---|---|---|
| `ERIX_NOTES_DONE_GRACE_MS` | 7 days | done retention — `complete` sets `expires_at = now + this` |
| `ERIX_NOTES_GRACE_MS` | — | deprecated alias of the above; still read when the new name is absent, but it has lost the old active-orphan cleanup meaning |
| `ERIX_NOTES_TOMBSTONE_RETENTION_MS` | 30 days | `purge` only deletes tombstones older than this |

## 6. Schema is run-only and auto-capture is gone

The four `note_*` schemas accept only `scope: "run"`. Passing `project` or
`user` now returns an `invalid` tool result instead of a "not yet supported"
placeholder — hosts that forwarded user-level or project-level scope requests
must stop sending them (there is no scheduled replacement).

`recordAutoCapture()` is deleted (ADR-016 follow-through): `note_take` is the
only write entry. Reading historical auto-sourced records still works — the
`source` filter and the `@auto` provenance marker remain. Hosts that called
`recordAutoCapture` (or the retired `bin/auto-capture.js` bridge) drop those
calls; the model writes what matters via `note_take`.

## 7. Housekeeping details worth knowing

- `normalizeNoteRecord()` is exported from `src/store/notes.js`. Record time
  fields are normalized on every read: missing `updated_at` falls back to
  `created_at`; a record missing both gets the fixed epoch
  `1970-01-01T00:00:00.000Z` (the adapter never fabricates "now").
- `notesStoreContract` in `erix-agent/contract-tests` locks the new store
  surface (required methods, array-returning `list`). Run it against a
  custom store before upgrading.
