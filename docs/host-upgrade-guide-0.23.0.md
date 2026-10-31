<!-- doc-version: 0.23.0 -->
# Host upgrade guide: 0.23.0

**This is the storage-convergence release.** 0.22.0 shipped the persistence-truth work (issue #326);
0.23.0 changes *where the body text of a run lives*: the journal now gets **one row per message, written
the moment the message is final**, and a round row keeps **metadata only**. `store.load()` puts the body
back (it folds the message rows into their round), so a host that reads `load()` sees the same shape as
before. A host that reads **raw journal rows** no longer sees the body at all.

**No store method signature moved, no option was removed, no export was renamed, and the runtime still
has zero npm dependencies.** Four things are host-visible in a way you can trip over — §2 to §5. If a
section does not describe your code path, it is a no-op for you; `CHANGELOG.md` stays the complete list.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| Round rows no longer carry `messages`; the body lives in `kind:"message"` rows (§2) | yes, if you read the `.jsonl` yourself instead of calling `load()` |
| `onRound(record)` no longer carries `record.messages` (§3) | yes, if that callback renders or persists the round body |
| The run snapshot's `messages` is a **stale copy**, no longer the body source (§4) | yes, if you restore context from `.snapshot.json` |
| Display projection must be fed `store.load()`'s folded output (§5) | yes, if you feed raw rows into `projectTranscriptForDisplay` |

The one-line version: **`store.load()` is the body API.** Everything that used to be true of "the row I
read out of the journal" is now true of "the record `load()` handed me", and nothing else.

## 2. Round rows no longer carry `messages`

**Symptom.** A run's `.jsonl` now holds two families of rows. Measured on a two-round run (one tool call,
one final answer) with the built-in file store:

| Row (`dedupKey`) | `kind` | `seq` | carries `messages` |
| --- | --- | --- | --- |
| `<runId>:engine:round:0:seed` | — | — | yes (1) |
| `<runId>:msg:1:0` | `"message"` | `0` | yes (1) — the assistant turn, written **before** its tool runs |
| `<runId>:msg:1:1` | `"message"` | `1` | yes (1) — the tool result, written the moment it exists |
| `<runId>:engine:round:1` | — | — | **no such key at all** |
| `<runId>:msg:2:0` | `"message"` | `0` | yes (1) |
| `<runId>:engine:round:2` | — | — | **no such key at all** |

`load()` on the same run returns **3 records** whose `messages` flatten to **4** messages: the round rows
come back with their body re-attached by `foldMessageRows` (`src/store/message-rows.js`), which is the
function `src/loop/resume-manager.js` already uses to rebuild the model context.

**How to tell whether you are affected.** Grep your host for reads of the transcript file / the raw
`appendRound` payload: `JSON.parse(line).messages`, `record.messages` on a row you parsed yourself, a
column of your own DB that mirrors the journal line. If any of them expect the body, you are affected.

**Fix.** Read the body through `store.load(runId)` — `createFileTranscriptStore({ dir }).load(runId)` or
`createMemoryTranscriptStore().load(runId)` — and flatten with `records.flatMap((record) => record.messages ?? [])`,
which is the exact idiom the engine itself uses. Two things stay true and are safe to rely on:

- **`load()`'s shape did not change.** One record per round, body attached, plus the engine fact rows
  the engine's own fact/control rows (`:control:`, `:fold:`, `:ttl:` landed in 0.22.0; `:resume` and `:input:` are older) — those still exist and still
  may carry an empty or absent `messages`.
- **The row order is append order.** A message row is written *before* the tool it describes runs, so
  "the body of round N" is no longer "the row with round N".

If you need the raw rows for an audit (the engine's own real-upstream e2e does exactly that for its
"what is really on disk" assertions), keep reading them — just stop asking them for the body.

## 3. `onRound(record)` no longer carries `messages`

**Symptom.** The `record` handed to `onRound` is the round record the engine persists. Since that record
no longer writes `messages`, `record.messages` is now `undefined` (not an empty array). Everything else is
unchanged: `round`, `response` (`content` / `stopReason` / `usage`), `textPreview`, `summary`, `l0facts`,
`runState`, `toolUses`, `judge`, `wrapup`, `compactionStats`. (`foldedSummary` and `ttlDegradations` are
**not** round-record fields — they live on their own fact rows, `…:fold:<fp>` / `…:ttl:<fp>`, whose
`messages` is `[]`; read them from `load()` rows, not from `onRound`'s `record`.)

**How to tell.** `grep -n "onRound" your-host.js` and look for `record.messages` inside the callback.

**Fix.** Two honest options, both fine:

1. Use the round record for what it still carries (`response.content` still holds the assistant body of
   that round; `textPreview` is its first characters) and do not expect the conversation there.
2. Read the body from `store.load(runId)` when you actually need it — e.g. once at the end of the run,
   or inside the callback if you can afford a read per round.

Do **not** reconstruct the body by concatenating `onRound` records across rounds: the engine's own
injected text (judge advisory, extension notice, forced wrap-up) is journalled as separate `:control:` rows
and never appears in a round record, so a concatenation silently drops it.

## 4. The run snapshot's `messages` is a stale copy, not the body source

**Symptom — read this one carefully, because the intuitive reading is wrong.** The run snapshot
(`.snapshot.json`, written through `saveRunSnapshot`) **still contains a `messages` array**. Measured on the
same two-round run: `messages` has **3** entries, with `status:"executed"` and `round:1`. What changed is
that the engine **stopped using it as the body source**: since a snapshot is written *before* its round's
tools run, that copy is always **behind** the journal, and feeding it back as context rewinds the body.

So a host that restores context from `snapshot.messages` is not reading "the truth", it is reading a
snapshot of the truth taken at the last safe point — and after this release the engine's own resume path
ignores it (it rebuilds from `store.load()` and keeps the snapshot only for "which tool was in flight,
what partial text existed"). The snapshot's body copy survives only as an **upgrade path** for ledgers
written before 0.23.0, where the crashed round's body existed nowhere else.

**How to tell.** If your resume/restore path does `snapshot.messages` → your context, you are affected.

**Fix.** Rebuild context from `store.load(runId)` (folded), and take only *execution state* from the
snapshot: `pendingToolUses` / `toolResults` / `partialText` / `round` / `status` / `executedToolIds`.
If you have to keep a body fallback for old runs, gate it exactly the way the engine does: only use the
snapshot body when the ledger has nothing past the anchor, i.e. for ledgers that predate per-message
rows. Never merge both unconditionally — that is the double-feed bug the engine removed.

## 5. Display projection must be fed the folded `load()` output

**Symptom.** `projectTranscriptForDisplay` (`src/display/projection.js`) takes transcript records and
turns them into display entries. Fed **raw journal rows**, it now produces **duplicate entries and
missing execution facts**.

**The counter-example, concretely.** Take the two-round run from §2 and feed the raw lines to the
projection instead of `load()`'s output:

- every round appears **twice** — once from the round row (metadata, `response.content`) and once from
  the `kind:"message"` row that carries the same assistant text;
- `durationMs` is **missing** (`undefined`) on the tool entries, because the assistant call and its
  result live on **two different rows** in the new ledger (the call is journaled before the tool runs,
  the result right after), so a projection that works record-by-record cannot pair them;
- the same `toolCallKey` shows up twice, so any "one entry per call" assertion fails.

This is not hypothetical: the repository's own real-upstream smoke test had exactly this bug
(`scripts/cli-real-smoke.mjs`, fixed in this release) and the fix was to feed it
`createFileTranscriptStore({ dir: transcripts }).load(runId)` — nothing else changed, the assertions did
not get any weaker.

**How to tell.** Find where you call `projectTranscriptForDisplay` (or your own equivalent) and check
where its argument came from: a `readFile` + `split("\n")` + `JSON.parse`, a `for await` over a stream, or
a store method other than `load()`.

**Fix.** Pass `store.load(runId)`. If you need raw rows for something else, keep two variables — folded
for display, raw for audit — and never swap them.

## 6. Self-check

```bash
npm test                       # 1,842 tests, 0 failing (baseline 1,833 passing + 9 skipped)
npm run check:docs && npm run check:docs:strict
npm run check:release          # packs, installs into a throwaway project, runs the shipped contract suites
```

Against your own store and your own UI, four questions are worth answering with a test before you upgrade:

1. Raw journal rows for a run → round rows have no `messages`; `kind:"message"` rows do.
2. `store.load(runId)` → the same record count as before this version, body intact, `flatMap` yields the
   same message sequence the model saw.
3. `onRound` callback → `record.messages` is `undefined`, and your callback does not depend on it.
4. Projection fed `load()` → one entry per call, `durationMs` present; projection fed raw rows → duplicated
   entries (that is the regression you are guarding against).

## 7. What did not change

No store method signature, no return type, no option name, no export, no new record kind, no new message
field, no runtime dependency (still zero). `load()` returns the same record shape as 0.22.0, including the
fact rows introduced there. `projectTranscriptForDisplay`'s entry shape and semantics are untouched (the
projection now prefers the folded in-round assistant message over `record.response.content`, which is the
same text with a defined owner — see `CHANGELOG.md`). Termination reasons, the judge decision surface and
the final guard are untouched.

## 8. Migration recipe

1. Replace every body read that goes through raw rows with `store.load(runId)`.
2. In `onRound`, stop reading `record.messages`; keep using `response.content` / `textPreview`, or read the
   body from `load()` when you need the conversation.
3. In your restore path, rebuild context from the ledger and take only execution state from the snapshot;
   keep the snapshot-body fallback only for pre-0.23.0 ledgers, gated on "the ledger has nothing past the
   anchor".
4. Feed `projectTranscriptForDisplay` the folded output only.
5. Re-run your own "what did the model see" test: it should now pass against `load()` alone, with no
   knowledge of the on-disk row layout.
