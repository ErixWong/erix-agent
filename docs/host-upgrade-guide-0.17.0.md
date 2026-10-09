# Host upgrade guide: 0.17.0

Version 0.17.0 is additive: no API removals, no call-site changes, and no
mandatory store changes. Hosts on 0.16.x can upgrade as-is; the fast path
below is opt-in per store implementation.

## 1. Change summary

- **`appendUserTurn` paired optional fast path (issue #157).** Database-backed
  hosts may implement two optional store probes so the pre-write stops doing a
  full `load()` inside the receive-message transaction. See section 2.
- **Built-in file store idempotency cache (issue #160).** `appendRecord` now
  checks duplicates against an in-process dedup key cache (validated by
  `(size, mtimeMs)`), so `appendUserTurn` per turn drops from 2 full reads to
  1 (CLI resume path 3→2; 300-round single-call p50 50 ms → 22.5 ms). No API,
  format, or semantic changes.
- Repository-side only: contract-document example checks (issue #158,
  `npm run check:docs-examples`). No host impact.

## 2. Fast-path probes (optional, paired)

When a store implements **both** methods, `appendUserTurn` derives the
`dedupKey` first, point-queries `loadByDedupKey` — a hit returns immediately
(neither probe nor `load` is called again) — and only on a miss calls
`loadMaxRound` to derive `round`. The fast path **never calls `store.load`**.
Implementing only one of the two behaves exactly like implementing neither: the
full-`load` path runs unchanged.

```js
// Postgres single-row record store sketch
store.loadByDedupKey = async (key, dedupKey) => {
  const { rows } = await pool.query(
    `SELECT record FROM transcript_rounds
     WHERE key = $1
       AND (record->>'dedupKey' = $2 OR record->>'roundKey' = $2)
     LIMIT 1`,
    [key, dedupKey],
  );
  return rows[0]?.record ?? null; // full stored record on hit, null on miss
};

store.loadMaxRound = async (key) => {
  const { rows } = await pool.query(
    `SELECT MAX((record->>'round')::int) AS max_round
     FROM transcript_rounds WHERE key = $1`,
    [key],
  );
  return rows[0]?.max_round ?? null; // null (or a negative number) for empty
};
```

Contract rules (full text:
[host-consumer-contract.md](host-consumer-contract.md), "TranscriptStore
capability tiers" and "Multi-turn resume contract"):

- `loadByDedupKey(key, dedupKey)` must match by
  `(record.dedupKey ?? record.roundKey) === dedupKey` — the same predicate the
  full path applies to `load` results — and return the complete stored record
  (hit) or `null`/`undefined` (miss).
- `loadMaxRound(key)` must be equivalent to `Math.max(0, …safe-integer
  round…)` over the `load` results; empty store returns `null`/`undefined` (or
  a negative number).
- Contract violations throw `TypeError` (a probe result that is neither an
  object nor `null`/`undefined`; a non-number, non-safe-integer
  `loadMaxRound` result). Surface these as store bugs; they never degrade
  silently.
- `written` semantics and the return shape are unchanged, and a hit still
  returns the existing `record`.

`erix-agent/contract-tests` includes the optional probe conformance checks;
run the suite against your store to verify the implementation before rolling
out.

The built-in file store implements neither probe on purpose: point queries are
meaningless for JSONL, and issue #160 already covers its cost side.

**Self-check before turning the probes on.** The contract locks *semantics*;
the speed of the point query is your schema's property, so verify it: the
dedup key must be reachable by an index, not by a scan. Replace the table and
column names with your own:

```sql
-- MySQL / MariaDB: is the dedup/round key indexed?
SHOW INDEX FROM transcript_rounds
 WHERE Column_name IN ('dedup_key', 'round_key');

-- MySQL / MariaDB: does the max-round aggregate use an index?
EXPLAIN SELECT MAX((record->>'$.round') + 0) FROM transcript_rounds WHERE run_id = 1;
-- Expect key != NULL / rows < table row count; a full scan here means the
-- "fast" path is still O(table).
```

A `SHOW INDEX` empty set is the expected result before you add the index, and
the reason to run this check instead of trusting the guide.

## 3. When to adopt

Adopt the probes when `appendUserTurn` runs inside a transaction that must
stay cheap (the contract Timing requirement) and your `load()` cost grows with
session size — row count, payload bytes, or both. Hosts whose sessions stay
small can stay on the full-`load` path indefinitely; nothing forces adoption.

## 4. "The engine emits X" never means "your table has X" (issue #183)

Standing rule, learned from the 0.17.0 upgrade of the touwaka host (its issues
#1151 / PR #1163): the engine never reads or writes a host schema, so **every
host-side column, table, or field a host wants must be verified by the host and
landed by the host**. A guide sentence like "this release gives you per-tool
duration" is a statement about the data the engine emits, not about your
storage.

Worked example — tool duration, the claim that misled touwaka:

- The engine stamps `duration` (milliseconds) into `execution.metadata` for
  every executed tool (`src/loop/run-snapshot-executor.js:99` and
  `:116`) and flattens that metadata onto the `tool_result` block
  (`src/loop/run-snapshot-executor.js:325-330`). It has done so since well
  before 0.14 (`git log -S "metadata.duration" -- src/`), so this is **not** a
  0.17 addition either.
- That value lives **inside the stored messages**. There is no top-level
  `RoundRecord.duration`, and the display projection's `toolCalls[]` summary
  has no duration field (shape:
  [host-consumer-contract.md](host-consumer-contract.md), "Projected identity
  and tool-call shape").
- Therefore a `duration_ms` **column** is entirely host-owned: your adapter has
  to read `tool_result.duration` and write it. No engine upgrade ever creates,
  renames, or backfills that column.
- touwaka's production database did not have the column at all. Adding it took
  three separate host-side fixes — the DDL, the write side (it stored a literal
  `NULL`), and the read side (the controller `SELECT` omitted the column).
  None of them was an upstream change.

Run a self-check per host-side field instead of assuming. Shapes you can copy
(substitute your table/column names):

```sql
-- MySQL / MariaDB: does the column exist?
SHOW COLUMNS FROM agent_rounds LIKE 'duration_ms';

-- Any INFORMATION_SCHEMA engine: where do I carry this field at all?
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE COLUMN_NAME = 'duration_ms'
   AND TABLE_SCHEMA = DATABASE();

-- SQLite (no LIKE form)
-- PRAGMA table_info('agent_rounds');
```

```bash
# CLI forms, one per engine; each must print a row, not an empty set
mariadb "$ERIX_DB" -e "SHOW COLUMNS FROM agent_rounds LIKE 'duration_ms'"
psql "$ERIX_DATABASE" -c "\d agent_rounds"
sqlite3 "$ERIX_SQLITE_DB" "PRAGMA table_info(agent_rounds);"
```

Existence is only the first third of the check. The other two thirds are
executable assertions on live data, and both caught touwaka's bugs:

```sql
-- write side: a finished round must carry a number, never a literal NULL
SELECT duration_ms FROM chat_tool_calls ORDER BY id DESC LIMIT 1;
-- read side: the API view must surface it (a missing SELECT column is invisible
-- to every write-side test)
SELECT id, duration_ms FROM chat_tool_calls WHERE run_id = ?;
```

The same asymmetry applies to store **capabilities**, which are not columns: the
run-state status reader (`loadRunStateStatus`, 0.14.0 §1) is deliberately not
engine-validated, so a missing implementation stays silent — probe your own
adapter:

```bash
node -e "import('./your-store.js').then(async (m) => {
  const store = await m.createStore();
  const want = ['appendRound', 'load', 'saveRunSnapshot', 'loadLatestRunSnapshot',
                'saveRunState', 'loadRunState', 'markRunState', 'loadRunStateStatus'];
  console.log(want.filter((k) => typeof store[k] !== 'function'));
});"
```

An empty array is the pass condition; anything else is a capability your host
believes it has and does not. For the schema-independent part of that surface,
the shipped suite is the stronger check: register `transcriptStoreContract`
against the real adapter (usage in
[host-consumer-contract.md](host-consumer-contract.md), "Contract test
suites").

## 5. Land every host-side change on both install paths (issue #183)

Hosts commonly provision a database two mutually exclusive ways: an empty
database runs a **new-install baseline**, an existing one runs the **upgrade
migration**. touwaka is such a host (its `init-database.js` versus
`upgrade-database.js`), and the consequence bit it twice (#1151 / #1163):

> A migration written only into the upgrade path never reaches a fresh install,
> and a baseline-only change never reaches an existing deployment.

So every requirement in these guides — column, table, index, or seed row — is a
**two-sided obligation**. The check that catches a one-sided landing costs one
scratch database:

```bash
# 1. provision a scratch database through the NEW-INSTALL path only
#    (your baseline initializer; no upgrade migration runs)
#    <your-new-install-command>
# 2. re-run the §4 self-check commands against that scratch database —
#    every one of them must pass there too
# 3. run the shipped contract suite against the same scratch database
node --test your-tests/erix-contract.test.mjs   # your adapter's contract test file
```

Put step 2–3 in CI. A self-check that only ever runs against a database that
has been upgraded for two years proves nothing about a new install.

## 6. Self-check coverage across the 0.14.0 → 0.17.0 guides

Every host-side "you need this" statement in the four guides, and whether a
command can carry it. Statements without a command are listed with the reason,
so "no command" is a decision rather than an omission:

| Guide § | Host-side claim | Self-check |
|---|---|---|
| 0.14.0 §1 | adapter must expose `loadRunStateStatus`; the engine never validates it | **code probe** (0.17.0 §4 one-liner) + `SHOW COLUMNS FROM your_runs LIKE 'status'` if the status lives in a column |
| 0.14.0 §1 (data compat) | old embedded `state` keys keep working | no command: the rule is "no migration required", and reading an existing row with `loadRunStateStatus` is the assertion |
| 0.14.0 §2/§3 | drop two `erix-agent/tools` imports; move note credential policy into your layer | source-level: `grep -rn "looksLikeCredential\|normalizedLabel\|src/loop.js" src/` must print nothing |
| 0.14.0 §5.1 | `replay` declarations on your own tool definitions | `node -e` over your tool list: every side-effecting tool must declare `replay: "unsafe"` or omit it |
| 0.14.0 §5.2 | `partialPersistence` requires `stream: true` | startup `TypeError` is itself the self-check: boot once with `partialPersistence` and no `stream` and expect `partialPersistence requires stream: true` |
| 0.15.0 §1/§2 | entry exports `appendUserTurn` / `projectTranscriptForDisplay`; `load()` must return an array | `node -e "import('erix-agent').then(m => console.log([m.appendUserTurn, m.projectTranscriptForDisplay].map(t => typeof t)))"` → `['function','function']`; then `transcriptStoreContract` |
| 0.15.0 Checklist 2 | optional host-side anchor columns (session id, seq, attachments, run attribution) | `SHOW COLUMNS FROM your_table LIKE 'seq'` (0.17.0 §4 shapes); optional, so an empty set is a decision, not a failure |
| 0.16.0 §1 fidelity | the whole record/message objects survive the round trip, unknown fields included | `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'transcript_records' AND DATA_TYPE IN ('json','longtext','mediumtext','text')` (a rebuild-from-whitelist schema shows up here), plus the suite's fidelity assertion |
| 0.16.0 §1 ordering | a **persisted** append sequence exists and `load()` orders by it | `SHOW COLUMNS FROM transcript_records LIKE 'append_seq'` + `SHOW INDEX FROM transcript_records`; then run two same-round appends and re-read — the order must be stable across restarts |
| 0.16.0 §1 projection fields | `key`, `meta.sourceInferred`, `toolCalls[]` children | nothing to check in storage: projection fields are generated per projection and never persisted (see "Host display projection") |
| 0.17.0 §2 | the dedup key must be point-queryable and the max-round aggregate cheap | `SHOW INDEX` + `EXPLAIN` (0.17.0 §2) |

If a future guide adds a host-side field without a self-check command and
without a reason in this table, that is a documentation bug — say so on the
issue tracker rather than assuming your database already has it.
