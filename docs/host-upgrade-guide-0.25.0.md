<!-- doc-version: 0.25.0 -->
# Host upgrade guide: 0.25.0

**This is the "a fold stops re-billing you for bytes the ledger already has" release.** 0.24.0 changed what
the engine *tells* you about its own work; 0.25.0 changes what a fold **costs you on disk**. Before this
release every fold re-sent the whole removed body, so a long session re-copied the ledger from round 1 each
time and a single round record eventually outgrew the host's own per-record size gate — and that rejection
ended the run. Nothing is removed, nothing is renamed, no store method signature moved, no export or
dependency moved, and the runtime still has **zero** npm dependencies.

Every change below is **additive**: a host that compiles against 0.24.0 compiles and runs unchanged. What
you may *want* to look at is the one new knob (§2) and the one new ledger field (§3); §4 is the behavior
change you will notice in your failure channel. `CHANGELOG.md` stays the complete list.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| `record.foldedPayload` is de-duplicated per session and clamped to a byte budget (§2) | no — but you can now size it: `context.maxFoldedPayloadBytes` / `ERIX_FOLD_ARCHIVE_MAX_BYTES` |
| New `record.foldedPayloadMeta` reports what was deduplicated and what was clamped (§3) | no — additive; records without folding simply do not have it |
| A host rejection of one oversized round record degrades that record instead of ending the run (§4) | yes, if you alert on persistence facts — a new non-fatal fact can now appear |
| Read-side context trimming is still **not** done; tracked as #462 (§5) | no — nothing to migrate, just don't assume it landed |

### Files touched by this release (host-visible surface)

- `src/compact/fold-archive.js` — new module: session dedup ledger + byte clamp + meta.
- `src/loop/orchestrator.js` — writes `record.foldedPayloadMeta`; wraps `appendRound` with the degradation path.
- `context.maxFoldedPayloadBytes` — new option; `ERIX_FOLD_ARCHIVE_MAX_BYTES` — new env override.

## 2. `record.foldedPayload` is now de-duplicated per session and byte-clamped

Before: the payload the compaction strategy returned (`result.foldedPayload`) was written into the round
record verbatim, on **every** fold. It was a byte-for-byte copy of rows the ledger already had, and the
engine never read it back on resume — so a 160-round session accumulated O(n²) duplicated bytes. The real
case behind this release (erix-station v0.1.32, session `9e0c8a17`): fold rounds 100/121/137 produced
records of 569 518 / 742 771 / 960 703 bytes, of which the archive was 550 000 / 721 538 / 940 278 bytes
(the non-archive part stayed a stable ≈ 20 425 bytes), and the round-162 archive (≈ 1 114 000 bytes) pushed
that record past the host's 1 MB per-record gate.

After: the payload is still the content source your strategy provides — nothing about the in-memory value
your `onAfterFold` hook, `recoveryHint` or stub parsing receives has changed — but before it is written it
passes through three gates, in this order:

1. **Session-level deduplication.** Each message is fingerprinted (sha256 of its canonical JSON) and any
   message the session already archived is dropped. A resumed session is pre-accounted from
   `store.load()`, so a run that resumes does not re-archive what the earlier run already stored.
2. **Byte clamp.** The archive is kept to a byte budget, **tail-first**: the newest messages survive, older
   ones are dropped from the head. `0` is a legal budget and means "keep the pointer, write no body".
3. **Accounting.** Whatever the two gates above removed is reported, never silently swallowed (§3).

The budget resolves in this order — first winner takes it:

| Source | Notes |
| --- | --- |
| `context.maxFoldedPayloadBytes` | explicit option; a safe non-negative integer, `0` = pointer only |
| `ERIX_FOLD_ARCHIVE_MAX_BYTES` | env override, same value rules; an unparseable or negative value is ignored |
| `262144` bytes | default (`DEFAULT_FOLD_ARCHIVE_MAX_BYTES`, i.e. 256 KiB) |

If your store's per-record limit is smaller than 256 KiB, set the option (or the env) below your limit
instead of relying on §4's degradation path: the degradation path keeps the run alive, but the record that
loses its archive loses the forensic copy for that round.

## 3. `record.foldedPayloadMeta`: "clamped" and "never folded" are no longer the same shape

A field that got truncated has to say so, otherwise "the archive was clamped away" and "there was never a
fold" are the same thing in the ledger. On any round that folded, the record now carries:

| Key | Meaning |
| --- | --- |
| `messages` / `bytes` | what this record's archive actually contains (after dedup and clamp) |
| `capBytes` | the budget that was in force for this fold — so a reader can tell `0` (pointer only) from a real body |
| `droppedMessages` / `droppedBytes` | removed by the **clamp** (head dropped, tail kept) |
| `dedupedMessages` / `dedupedBytes` | removed by **session dedup** — the ledger already has those rows |

Two notes for anyone summing these up: `droppedBytes` is measured against the **post-dedup** source, so the
two pairs are not additive in the naive way; and on the §4 host-rejection path the record additionally gets
`rejectedByHost: true` with `droppedMessages` / `droppedBytes` set to the whole archive that was stripped,
while `record.foldedPayload` is deleted from that record.

`foldedPayload` stays an archive, not display text. The display projection still reports only
`meta.foldedPayloadMessages` (a count) — do not dump the body into a chat view.

## 4. A rejected oversized round record no longer ends the run

Before: `appendRound` rejected by the host (e.g. over a per-record size limit) was a terminal persistence
failure — `reason=persistence_failed` with `sideEffect=executed_uncommitted`, which also means the tools of
that round had already run but were not committed.

After: `appendRound` is wrapped. If it throws and the record carries a non-empty archive, the engine strips
the archive, writes the accounting into `foldedPayloadMeta` (`rejectedByHost: true`), and retries **once**.
That attempt is a non-fatal fact — `fatal: false`, `operation=appendRound`, `phase="transcript"` — so the
run continues. Only if the retry also fails is the old terminal behavior restored, because then it really is
a storage failure and not a too-large optional field.

Action for hosts: if you alert on persistence facts, filter on `fatal` rather than on presence — a
`fatal: false` record-level degradation is now an expected event on tight stores. If you assert that
`persistence_failed` implies "this round's archive is missing", that is still true, but no longer the only
place a missing archive can show up.

## 5. What did not change

- The in-memory `foldedPayload` handed to strategy hooks (`onAfterFold`), `recoveryHint` and stub parsing is
  still the full body; only the copy that reaches the store is bounded.
- `resume-manager` still uses `foldedThrough` for round-number offsetting only. **Read-side trimming of the
  replayed body is not part of this release** — it, the watermark advance/recompute question, and the
  "the summary is in no round record's `messages`" reconciliation gap are tracked as **#462**.
- No store signature, option rename, export change, dependency, or terminal-reason vocabulary change.

## 6. Verify it on your side

```bash
node --test test/compact/fold-archive.test.js   # the five criteria for this release
npm run check:release                           # packaging + contract suite + tsc host + CLI smoke
```

Then check one real session against your own limits: for each record with `foldedPayloadMeta`,
`bytes <= capBytes` must hold, and `capBytes` must be at or below your store's per-record gate. If
`rejectedByHost` appears in a session where you set `capBytes` below that gate, you are looking at a store
that rejects on something other than the archive.
