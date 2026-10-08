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

## 3. When to adopt

Adopt the probes when `appendUserTurn` runs inside a transaction that must
stay cheap (the contract Timing requirement) and your `load()` cost grows with
session size — row count, payload bytes, or both. Hosts whose sessions stay
small can stay on the full-`load` path indefinitely; nothing forces adoption.
