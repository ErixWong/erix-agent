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

## 4. `list()` returns a page, not an array — and `note_list` paginates

`store.list()` returns a `NotesListPage`:

```js
{
  status: "found" | "cursor_stale",
  records,        // this page only
  nextCursor,     // opaque "<revision>:<offset>" string, or null at the end
  revision,       // scope revision this page was bound to
}
```

Requests take `limit` (default 50, clamped to 200), `cursor` (the previous
response's `nextCursor` — opaque, never built by hand), `filters`
(`state`, `tag`, `source`, `minRelevance`), and `sort`
(`"relevance" | "pinned_updated"`). When the scope changes mid-pagination the
page comes back `status: "cursor_stale"` with an empty window and
`nextCursor: null`; restart from the first page.

The `note_list` tool follows the same contract, replacing the 0.11.x offset
cursor:

```js
// 0.11.x — integer offset cursor, and the output had `total`
await note_list({ limit: 50, cursor: 200 });

// 0.12.0 — opaque cursor taken from the previous response; `total` is gone
let cursor;
const all = [];
do {
  const page = JSON.parse(await note_list({ limit: 50, ...(cursor ? { cursor } : {}) }));
  if (page.status === "cursor_stale") {
    cursor = undefined;      // scope changed while paging; restart
    all.length = 0;
    continue;
  }
  all.push(...page.notes);   // `count` = page size; there is no `total`
  cursor = page.nextCursor;  // null when the listing is exhausted
} while (cursor);
```

`note_list` output now carries `count` (page size) and `nextCursor`, and no
longer promises `total`. A stale cursor is a recoverable structured result —
`{ status: "cursor_stale", notes: [], count: 0, nextCursor: null, revision }` —
not an error.

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
| `ERIX_NOTES_DONE_GRACE_MS` | 24h | done retention — `complete` sets `expires_at = now + this` |
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
- Each scope directory now contains a hidden `.revision` metadata file that
  anchors list cursors and the semantic-state incremental cache. External
  enumeration of the notes directory must skip dot files.
- `notesStoreContract` in `erix-agent/contract-tests` locks the new store
  surface (required methods, page shape, cursor stability). Run it against a
  custom store before upgrading.
