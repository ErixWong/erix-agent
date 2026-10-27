# Host upgrade guide: 0.26.0

**This is the "a fold hands you its substitute, and a finished run always has a body" release.** 0.25.0 made a
fold cheap on disk; 0.26.0 makes a fold **say what it removed**, and hands that text to you the moment the fold
is finalised. It also closes the last case in which a run could finish as a success with no final text at all.
Nothing is removed, nothing is renamed, no store method signature moved, no export or dependency moved, and the
runtime still has **zero** npm dependencies.

Every change below is additive or a strictly larger guarantee: a host that compiles against 0.25.0 compiles and
runs unchanged, and gets the new ledger field for free. §2 and §3 are the two new surfaces, §4 is the resume
behavior you will notice as a smaller prompt, §5 is the terminal behavior your acceptance check has to look at,
§6 says which compaction actually ran. `CHANGELOG.md` stays the complete list.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| Every fold writes a bounded machine index `record.foldedFacts` (§2) | no — additive; rounds that did not fold simply do not have it |
| New `context.onFoldSummary` hook and `context.maxFoldedFactsBytes` knob (§3) | no — omit both and behavior is byte-identical |
| Resume replays only what the fold watermark has not already accounted for (§4) | yes, if you assert on resumed prompt content or size |
| A `judge_done` stop force-writes a final; acceptance reads `termination.forcedFinal` (§5) | yes, if you accept runs by "final text is non-empty" |
| `compaction.strategyName` plus a one-time `compaction_strategy_fallback` event (§6) | no — additive event fields |

### Files touched by this release (host-visible surface)

- `src/compact/fold-summary-journal.js` — `buildFoldedFacts` and `FOLDED_FACTS_MAX_BYTES`: the substitute and its byte cap.
- `src/loop/orchestrator.js` — writes `record.foldedFacts`, fires `onFoldSummary`, force-finals a `judge_done` stop.
- `src/compact/resume-fold-trim.js` — `planFoldedHistoryTrim`: watermark trimming plus summary backfill.
- `src/compact/sliding-window.js` — zero-LLM strategies now hand out the same mechanical text (`foldedSummaryText`).
- `src/loop/resume-manager.js` — resumed history, and the judge's round history no longer receives `"missing"`.
- `context.onFoldSummary`, `context.maxFoldedFactsBytes` — new options.
- `compaction.strategyName` and the `compaction_strategy_fallback` event — new observability fields.

## 2. `record.foldedFacts`: every fold now leaves a bounded machine index

Before: when compaction removed rounds, the round record kept the archive (0.25.0's `foldedPayload`) but
nothing that said, in bounded space, *what* was removed. A host that wanted to tell a user "these rounds are no
longer visible to the model" had to re-derive it from the ledger — and the engine's own judge history received
the literal string `"missing"` where a summary should have been.

After: every fold attaches `record.foldedFacts`, built by `buildFoldedFacts` (`src/compact/fold-summary-journal.js`):

| Key | Meaning |
| --- | --- |
| `text` | the mechanical index of the folded range: round numbers, tool / exit-status and path anchors, in stable order |
| `source` | `"strategy"`, unless a host injected its own text |
| `strategy` | which strategy produced it (`"unknown"` when it cannot be attributed) |
| `from` / `to` / `rounds` | the folded round range, when known |
| `bytes` | the size of `text` as written |
| `truncated` and `bytesBefore` | present only when the byte cap cut the text, and what it cost |
| `degradeReason` | present only when the substitute came out the cheap way (capped at 120 characters) |
| `fingerprint` | stable identity of the text, used so the same body is never journaled twice |

The default cap is `FOLDED_FACTS_MAX_BYTES` (2048 bytes); `context.maxFoldedFactsBytes` sets it for you (§3).
`foldedFacts` is an index, not display prose: it is meant for a banner, a log line or a note, and it is
deliberately small enough that a round record cannot be killed by a per-record size gate the way 0.25.0's
archive could.

## 3. `context.onFoldSummary` and `context.maxFoldedFactsBytes`: the substitute is delivered, not just stored

This is the section the 0.25.0 guide announced at its very end as "lands with the next minor". It lands here,
and the text now lives in this guide rather than in both places.

`context.onFoldSummary?.(payload)` is additive and fires once per fold, at the point the deterministic
substitute is finalised, with `{ ...record.foldedFacts, round }` — the *same* object that goes into the round
record, cloned, not a prettier copy. Four boundaries, and they are the contract:

1. **No text ⇒ no call.** A fold that produced no substitute does not call you.
2. **A throwing hook never changes the run outcome.** It becomes a non-fatal fact: `persistence_error` with
   `operation: "onFoldSummary"`, `phase: "fold_summary_delivery"`, `fatal: false`.
3. **Best effort, not an observer channel.** This is your data, so it is not routed through the observer's
   `console.error` path.
4. **Omitting the hook keeps behavior byte-for-byte identical.**

`context.maxFoldedFactsBytes` (a positive integer, default 2048) *is* the cap that lands on the record, so your
input limit, your output budget and your container cap can share one source instead of three magic numbers.
Both are validated at assembly time: a non-function `onFoldSummary` raises `TypeError: onFoldSummary must be a
function`, and a non-positive-integer `maxFoldedFactsBytes` raises `maxFoldedFactsBytes must be a positive
integer`.

What to do with it: write it into your notes or journal store as the timeline entry for that fold, tagged with
the folded range, and stop polling the ledger for folds you have already seen. If you prefer to keep polling,
`record.foldedFacts` is still there and identical.

⚠ **Correction (2026-10-28, issue #499).** Everything above about the **`context.`** location was wrong at
publication time: `context.onFoldSummary` was accepted by the option whitelist but **never read** — a host
that configured it there got no call, no error and no event. The hook has always been the **top-level**
`onFoldSummary`; the `context.` prefix in this section is a documentation defect of 0.26.0, not a supported
location. `context.onFoldSummary` has now been retired from the whitelist (it is treated as host metadata
and reported through `context_unknown_option` on the assembly-port route); the top-level hook is unchanged.
See the 0.27.0 guide for the retirement. The original text above is kept verbatim as history.

## 4. Resume no longer replays what the fold watermark already accounts for

`planFoldedHistoryTrim` (`src/compact/resume-fold-trim.js`) trims the resumed context at the fold watermark:
messages belonging to rounds at or below `foldedThrough` drop out of the replay; the head (seed, system, the
task body — anything with round `<= 0`) is never trimmed; and a substitute summary is backfilled into the last
real user message, so the model keeps the information in less space. `summarySource` says which text was
backfilled: `"journal"` is the summary the model actually saw at the time, `"strategy"` is the mechanical index
(the model may not have seen it; the information is equivalent).

The trim applies only when a substitute covering the range exists; otherwise the context passes through
untouched, with the reason recorded — `no-watermark`, `nothing-to-trim`, `no-covering-summary`,
`empty-summary`. A smaller resumed prompt after this release is the point, not a regression: if you assert on
resumed prompt size, or on the presence of specific older turns, assert against `foldedThrough` instead.

If you resume inside one session across runs, the difference shows up on the second run: the watermark is what
keeps run two from re-folding everything run one already folded.

## 5. A `judge_done` stop force-writes a final: verify with `termination.forcedFinal`

Before: if the last round produced only reasoning — no final answer body — and the stop reason was
`judge_done`, the run terminated as a success **with no final text**. Nothing crashed; the deliverable was
empty, and the judge's card was the last visible thing in the timeline. A host that accepts runs by "final text
is non-empty" had a successful run and nothing to show for it.

After: that stop path force-writes a final, like every other forced final. The engine-written body is labelled
as such in the display layer (`forced-final`), it shares the last round record's round key instead of creating
a parallel record, and the run reports `termination.forcedFinal` (state getter `forcedFinal`,
`src/loop/orchestrator.js`).

Action for hosts: acceptance must read `termination.forcedFinal`, not merely "is there text". A forced final is
engine-written, and per the marker rule of #323 anything the engine writes on the model's behalf is labelled —
do not present it as the model's own answer without that label. Two adjacent gaps are deliberately *not* in this
release: `end_turn` and `no_tool` do not force a final yet (**#475**), and a forced final whose text came back
empty is tracked separately (**#476**). What the judge itself looks at when it decides "done" is **#473**, also
not addressed here.

## 6. Which compaction actually ran

If you configured `fold-statistical` and the engine quietly fell back to sliding-window, you could not tell the
two apart afterwards — and what the model keeps differs enormously between them.

- `compaction` statistics now carry `strategyName`: the strategy that actually ran for that compaction.
- The first time a configured strategy is replaced by the fallback inside a run, a one-time
  `compaction_strategy_fallback` event is emitted. `src/compact/pipeline.js` rebuilds the same field on resume,
  so it survives a restart instead of being re-narrated every round.

One attribution correction comes along with it (#465 B): the contract claimed a host had to provide an
`erix-summary` model slot. The engine never required one.

## 7. What did not change

- No store signature, no option rename, no export change, no dependency change, no terminal-reason vocabulary change.
- `record.foldedPayload` and `record.foldedPayloadMeta` keep their 0.25.0 semantics. `foldedFacts` sits next to
  them; it does not replace them, and nothing reads it back as truth.
- The in-memory `foldedPayload` handed to strategy hooks (`onAfterFold`), `recoveryHint` and stub parsing is
  still the full body; only what reaches your store is bounded.
- `judge_done`, `end_turn`, `no_tool` and every other stop reason keep their names and meanings; only the
  missing-final-text behavior on the `judge_done` path changed.

## 8. Verify it on your side

```bash
node --test test/loop-on-fold-summary.test.js test/compact/folded-facts.test.js
node --test test/loop-judge-done-forced-final.test.js test/loop-resume-summary-history.test.js
npm run check:release
```

Then look at one real session. Every round record that folded must satisfy `foldedFacts.bytes <=
maxFoldedFactsBytes`. If you passed `onFoldSummary`, the number of calls must equal the number of folds that
produced text — a difference means either a hook threw (check for `persistence_error` with
`phase: "fold_summary_delivery"`) or a fold produced no substitute, which is legitimate. And if a run ends with
`termination.reason = "judge_done"`, `termination.forcedFinal` must be true and the final text non-empty;
`forcedFinal` false on that path is a bug worth filing.
