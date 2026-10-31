<!-- doc-version: 0.22.0 -->
# Host upgrade guide: 0.22.0

**Read this first: 0.21.0 was never published.** The registry's newest release is `0.20.0`, so
this guide covers **0.20.0 → 0.22.0** in one hop. Everything 0.21.0 contained ships in this
version too; `docs/host-upgrade-guide-0.21.0.md` stays the detailed text for those changes
(the reflection-decision fix #305, `parseModelJson` #307, the user-turn request guard #292,
`erix_run`'s richer final face #313, opt-in `finalGuard` #314, the `erix_run` tool-list fallback
#312(b), documentation anchor discipline #286) and nothing in them changed while they waited.
This guide's own sections cover what 0.22.0 adds on top: issues **#322**, **#323** and the
persistence work of **#326** (steps 1, 3, 4, 5).

**No store method signature moved, no option was removed, and no export was renamed.** Two
things are host-visible in a way you can trip over: a write that used to be swallowed now
**throws** (§2), and `load()` now returns **more rows than there are rounds** (§3). If a section
below does not describe your code path, it is a no-op for you; `CHANGELOG.md` stays the complete
list.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| Same `dedupKey` with a different payload is a hard conflict (§2) | only if your store relied on the silent drop, or if you generate unstable `dedupKey`s |
| Journal rows per run grow past the round count (§3) | yes, if you project rows into your own tables or UI |
| Compaction summary and TTL degradation are journaled, and reused instead of recomputed (§4) | only if your store rebuilds records from a field whitelist |
| `reflection.judgeDoneAdvisory` (§5) | opt-in, default off: nothing happens until you set it |
| Engine-injected messages carry `meta.source` (§5) | use it to filter display, not to make decisions |
| Built-in CLI reads rows by body text (§6) | only if you parse `erix` output |

## 2. A same-key write with different content now fails loudly

`appendRound` used to deduplicate on the key alone (`dedupKey ?? roundKey ?? <runId>:round:<n>`).
The second write with the **same key but different content** was accepted and then silently
discarded: no row, no error, no signal to either side. Both built-in stores now reject it
(`src/store/transcript-dedup.js` owns the decision, so memory and file cannot drift):

- **same key, same payload** → no-op, exactly as before (`appendRound` still resolves to
  `undefined`; nothing was added to its return value);
- **same key, different payload** → throws `TranscriptDedupConflictError` with
  `code === "dedup_payload_conflict"`. The message and the properties carry `runId`, the key,
  both payload fingerprints and the names of the top-level fields that differ. The stored record
  keeps its bytes and no new row is appended, so replaying the original payload is still
  idempotent.

Two things you should know before you panic on the first one:

- **A crash-rerun of a pre-written user turn is still safe.** The payload fingerprint deliberately
  ignores the top-level `dedupKey`, `roundKey`, `round` and `ts` — those are identity and wall
  clock, and they always drift between a crashed attempt and its retry. Nested `ts` inside message
  bodies counts as content, as does array order: **message order is semantics**.
- `runToolLoop` treats a throwing store as a persistence failure (retry, then
  `termination.reason === "persistence_failed"`). A host that previously lost a row quietly now
  sees a run end. Branch on the code, not on the message text.

If you want the old leniency for a specific row, the fix is to give that row a stable, unique
`dedupKey` (derived from your message id) rather than to catch the error and swallow it.

## 3. `load()` now returns more rows than there are rounds

The engine writes its own rows into the same journal, and 0.22.0 adds three families of them:

| `dedupKey` shape | What it holds | `messages` |
| --- | --- | --- |
| `<runId>:engine:round:<n>:control:<slot>` | text the engine injects *after* the round record was already written — `slot` ∈ `judge-nudge`, `extend`, `guard-revise`, `forced-final` (the forced-final row also carries the final assistant message) | ordinary messages, each tagged `meta.source === "judge-control"` |
| `<runId>:engine:round:<n>:fold:<fp>` | the compaction summary that was actually fed to the model | may be empty; the payload sits in `foldedSummary` |
| `<runId>:engine:round:<n>:ttl:<fp>` | what a degraded tool result was turned into | empty; the payload sits in `ttlDegradations` |

Before this, all of that text existed **only** in the model's context: the model had seen it, and
after a restart the engine had no record of what it had told itself. The measured gap this closes
is the ugly one: with a crash between rounds, the *second* resume used to hand the model nothing
(`0`) where the first had handed it the note (`1`).

**How to project these rows.** Key on `round`, deduplicate by `dedupKey`, and skip
`meta.source === "judge-control"` wherever you render user/assistant body text. A row is not a
turn and an empty `messages` array is not a bug — several of these rows exist precisely because
they carry no conversation body. If your projection counts rows as rounds, its counts are now
too high (the built-in CLI had exactly that bug in its "restored N messages" line and in its
session preview).

## 4. Compaction summaries and TTL degradations are facts now — and they are reused

`fold-llm` summaries used to be computed on the spot and used once: they entered the real request
(the model saw them) but never entered the journal, because a round record writes
`messages.slice(roundStart)` and `roundStart` is re-read from the post-compaction length. On
resume, the engine called the summarizer again and got a **different** summary. Every-round
recomputation cost prompt-cache hits and made "what did the model actually see" unanswerable.

0.22.0 journals what was fed and reuses it: `src/compact/fold-summary-journal.js` fingerprints the
summarizer's input (folded payload plus round range) and `seedFromRecord` re-seeds that ledger on
resume, so the same fingerprint never calls the summarizer twice. TTL degradations are journaled
with `toolUseId`, `createdRound`, `tokens`, `tokensAfter`, `chars` and a content fingerprint, so
"degraded from what to what" is checkable instead of a counter.

**Host action:** none if your store round-trips unknown fields (that fidelity is already contract,
and issue #1146 is the precedent for keeping `record_json` verbatim). **Action required** if your
store rebuilds a record from a whitelist of columns: `foldedSummary` and `ttlDegradations` would
be dropped on write or on read, and a store that drops them breaks the reuse guarantee silently.
None of the three built-in compaction strategies changed their behaviour — this is purely
"journal it, then reuse it".

## 5. `reflection.judgeDoneAdvisory` and `meta.source`

Judge is an **opinion**. When mid-run governance decides the goal is reached, that decision used
to be usable only as a stop: the reason itself was never said to the model, which is the shape
of "the judge says done, and the agent burns a dozen more rounds". Turning on
`reflection.judgeDoneAdvisory` (default `false`) injects the advisory as **one** ordinary `user`
text message at the next safe point — one slot, one message at a time, no queue. Termination
semantics are unchanged: an advisory is not a hard stop, and with the switch off the byte output
of the four fixtures is identical to 0.20.0/0.21.0.

Engine-injected messages carry `meta.source` (currently the single value `"judge-control"`).
Treat it as a **display/projection label**: use it to keep the engine's own voice out of your
transcript UI, and do not branch business logic on it. No new record kind and no new message
field were introduced — this is the same message shape with one more metadata key.

## 6. The built-in CLI reads rows by body text

`erix repl`'s restored-session line now counts body messages (engine notes excluded, and it says
how many were hidden), and `erix sessions` / the `-r` picker skip fact rows when picking a preview
instead of showing an empty entry or the judge's note as a session title. Only relevant to you if
you parse `erix` output; nothing in `src/` moved for this.

## 7. Documentation anchor discipline (issue #286) — no host action

Line-number anchors in the contract were replaced by symbol anchors, and the bare-line ratchet was
lowered as a side effect. Repository-internal; listed so the absence of a section does not confuse
you.

## 8. Self-check

```bash
npm test                       # 1796 tests, 0 failing (node 22 and 24)
npm run check:docs && npm run check:docs:strict
npm run check:release          # packs, installs into a throwaway project, runs the shipped contract suites
```

Against your own store, three questions are worth answering with a test before you upgrade:

1. Same `dedupKey`, same payload, twice → exactly one row, no throw.
2. Same `dedupKey`, different payload → you see `code === "dedup_payload_conflict"` and the stored
   row is unchanged.
3. `load()` on a run that used `fold-llm` and TTL → you still get `foldedSummary` and
   `ttlDegradations` back, and your projection does not count fact rows as rounds.

## 9. What did not change

No store method signature, no return type (`appendRound` still resolves to `undefined`), no option
name, no export, no new record kind, no new message field, no runtime dependency (still zero), and
the three compaction strategies still produce what they produced. The judge's decision surface,
the final guard, and the termination reasons are untouched — in particular an advisory never
changes `termination.reason`.

## 10. Migration recipe

1. Give host-written pre-writes a stable `dedupKey` derived from your own message id, then let the
   conflict error stay loud. Do not wrap `appendRound` in a blanket `try/catch`.
2. In projections and UI: group by `round`, deduplicate by `dedupKey`, skip
   `meta.source === "judge-control"`, tolerate rows whose `messages` is empty or absent.
3. If your store filters fields on the way in or out, add `foldedSummary` and `ttlDegradations`
   (or stop filtering).
4. Turn on `reflection.judgeDoneAdvisory` where you want the model to be told *why* it was told it
   was done; leave it off everywhere else until you have looked at the text.
