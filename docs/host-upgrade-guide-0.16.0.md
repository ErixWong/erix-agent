# Host upgrade guide: 0.16.0

Version 0.16.0 adds two explicit `TranscriptStore` requirements and additive
fields to the display projection. There are no API removals, no call-site
changes, and no breaking engine behavior.

## 1. Change summary

### Store fidelity

A host store must round-trip complete `RoundRecord` and message objects,
including fields unknown to the host. Do not rebuild stored objects from a
field whitelist. In particular, preserve `messages[].meta.source`: it is an
engine-reserved marker used to classify synthetic messages, not a host-owned
source label.

`load()` must return records with the same `round` in their persisted append
order. The engine consumes that order as stored and does not sort records a
second time. For example, a SQL-backed store should use an explicit ordering:

```sql
SELECT *
FROM transcript_records
WHERE run_id = ?
ORDER BY round_no, append_seq;
```

Adapt the column names to the host schema and persist an append sequence. Do
not rely on a database execution plan, primary-key scan order, or incidental
row layout to preserve insertion order.

### Additive display projection fields

`projectTranscriptForDisplay(records)` now includes a turn-level `key` and a
`key` on each `toolCalls[]` summary. Keys are unique within one projection and
deterministic when projecting the same input array again. They are generated
from the input positions, not persisted: filtering, slicing, or appending to
the input can change them. A projection `key` is neither a durable ID nor the
provider's `tool_use.id`; `toolCalls[].id` remains a separate optional field.

The public `toolCalls[]` summary shape is:

```text
{ key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus? }
```

The additive `meta.sourceInferred: true` field appears only when the
projection classifies a synthetic message by matching a configured text
prefix. It is absent when the classification comes from `message.meta.source`
or from `role: "system"` alone. As with other additive projection fields,
hosts should ignore unknown `meta` keys.

## 2. What hosts need to do

1. Update the store adapter and its persistence schema, if necessary, to
   preserve complete records/messages and unknown fields, including
   `messages[].meta.source`.
2. Make `load()` use an explicit persisted append sequence for records with
   equal `round` values; do not depend on storage-engine scan order.
3. Run the host's `TranscriptStore` contract tests. The shipped
   `test/contract/transcript-store.js` now includes fidelity round-trip and
   same-round ordering assertions. Reuse these assertions in the host's
   contract suite or add equivalent checks for its schema. Both assertions
   intentionally fail for a non-conforming store; that failure is the
   migration signal, not a test to weaken.
4. Treat projection keys as view identities only. Use a host-owned persisted
   identifier where durable identity is required, and do not substitute
   `key` for a provider `tool_use.id`.

No application call-site changes are required for this release.

## 3. Compatibility

All projection additions (`key`, `meta.sourceInferred`, and the registered
`toolCalls[]` child fields) are additive. There are no API removals, and the
engine introduces no breaking behavior change. The stricter store
requirements make previously lossy or order-dependent adapters fail the
contract suite so that their persisted context and display order are not
silently corrupted.

## 4. Verification

Run the host's own `TranscriptStore` contract suite against its real adapter.
Confirm that it:

- round-trips the complete record and message objects, including unknown
  fields and `messages[].meta.source`; and
- returns same-round records in persisted append order.

Then run the host test suite and inspect the display projection without
assuming its generated `key` values are persistent IDs.
