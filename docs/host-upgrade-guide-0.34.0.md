<!-- doc-version: 0.34.0 -->
# Host upgrade guide: 0.34.0

> Scope: the 0.34.0 version cut. **Nothing is removed, renamed or re-defaulted in this release** — what it
> adds is *observability*: three facts that used to be invisible (a final text that is really a textualized
> tool call, a run-state injection that really happened, and a deliverable criterion that could not decide),
> plus the shell writes that used to be missing from the write ledger.
> An already-running process is not migrated in place.

## 1. Read this first

| If you … | then in 0.34.0 |
|---|---|
| read `result.finalText` and treat any text as a body | check the new `result.finalTextShape` first: when it is present, the "body" is a tool call the model wrote as text (§2.1) |
| run with a `finalGuard` and want to know when the criterion was blind | subscribe to the new one-shot `deliverable_blind` event (§2.3) |
| rely on `fileWrites` to prove "no file was written" | it now also carries what the model wrote through the shell, and says so when it could not parse the payload (§2.4) |
| judge `judge_done` deliverable permissions | a textualized tool call no longer counts as a deliverable (§2.2) |
| read `round_end` | its payload gains `runStateInject`; nothing is removed (§2.5) |

## 2. What this release adds

### 2.1 `result.finalTextShape` — the final text is a textualized tool call (#862)

Additive field. When the model writes a tool call as prose instead of emitting it, the run still ends, but
`result.finalTextShape` now says so: `{ textualizedToolCall: true, marker: "<the marker found>" }`. Absent
means "not detected" — **the key is omitted, never `false`**. The same fact is emitted once per run as the
`final_text_textualized_tool_call` event, and the CLI prints one line for it.

### 2.2 A textualized tool call is not a deliverable (#865)

`judge_done` used to treat that text as a delivered body. It no longer does: the deliverable classifier gains
a fourth kind, `textualized_tool_call`, and `roundDeliverableFacts` reports the count as `textualizedBlocks`.
No event is renamed; the judge's own criteria are unchanged. The shape being reclassified is the one where a
round shows no `tool_use`, an `end_turn`, and a non-empty body — such a round no longer proves delivery.

### 2.3 `deliverable_blind` — "the criterion could not decide" is now an event (#881)

Additive, one-shot per run, tier **fact**. Emitted right after the final-guard payload is built and before the
host's own `deliverables` checks run, carrying the payload's own counters (`execWriteCount`,
`execWriteUnresolvedCount`) when they are present. It only fires when a `finalGuard` is configured. The
verdict itself does not change: a host that ignores the event sees exactly what it saw before.

### 2.4 The write ledger sees shell writes (#711)

`fileWrites` now includes paths the model wrote through `exec` (heredoc, `>`, `>>`, `tee`, `sed -i`), and the
final-guard payload gains `execWriteCount`, `fileWritesBlindToExec` and `execWriteUnresolvedCount` — the last
one is a **lower bound**: a payload it cannot parse is counted as one unresolved write, never guessed.
`recordFileWrites` / `trimFileWrites` / `FILE_LEDGER_LIMIT` are the same three shapes as before.

### 2.5 `round_end.runStateInject` (#872)

Additive sub-object on the existing `round_end` payload: `{ lowBudget, request, persist, remainingRounds,
injections }`. It records whether a run-state injection actually happened on that round, instead of leaving
the host to infer it from `runState`.

### 2.6 Truncation is no longer silent (#609)

When a single piece of content is over budget, the engine says which of the three ways it was cut. The
`readFile` description no longer quotes numbers measured in this repository (#628), so the model-facing text
stops drifting with our own tree.

## 3. What does not change

- **Options — changed in this release:** `reflection.roundJudge` keeps its key, type and default, but a host
  running with it on can now see **one extra round** on a run whose judged round contains nothing but a
  textualized tool call (§2.2). Every other option is unchanged; the only new *output* keys are the ones
  listed in §2.
- **Defaults —** unchanged: `maxRounds` (engine 8, CLI 64), `stallDetection` `{ window: 4, mode:
  "consecutive" }`, `compaction` `fold-llm`, `finalGuardTimeoutMs` 30000, and the five summarizer knobs.
- **Observer events —** no event renamed or removed. Additions only: `final_text_textualized_tool_call`
  (§2.1) and `deliverable_blind` (§2.3); `round_end` gains a sub-object (§2.5).
- **Diagnostic fields —** the existing names keep their meaning; `fileWrites` now carries more of the same
  kind of fact (§2.4), and three counters are added next to it.
- **On-disk formats —** unchanged. `<runId>.jsonl`, `.recovery.jsonl`, `.partial.jsonl`, `.state.json` and
  `.status.json` are written exactly as in 0.33.0; nothing new is written and nothing old is dropped.
- **Final payload —** additive only: `finalTextShape` (§2.1). `finalText`, `verification`, `error`,
  `termination` and the exit-code meanings 0, 1, 2 and 4 are unchanged.

## 4. Verify on your side

- Run one of your own scenarios and assert `result.finalTextShape` is absent for a normal body — absence, not
  `false`, is the "not detected" shape.
- If you rely on `fileWrites` to prove a negative, check `fileWritesBlindToExec` first: when it is `true` the
  ledger could not see everything the model wrote through the shell.
- If you read `deliverable_blind`, remember it is **one-shot per run** and fires only with a `finalGuard`.
- `npm run check:release` and `ERIX_E2E_MODEL=1 npm run check:release:model-e2e` are the two commands this
  repository runs before cutting a version; both are green on the 0.34.0 tree.
