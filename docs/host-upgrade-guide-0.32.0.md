<!-- doc-version: 0.32.0 -->
# Host upgrade guide: 0.32.0

> Scope: everything parked under `## [Unreleased]` in `CHANGELOG.md` at the time of writing.
> Every claim below was re-opened in the tree at `origin/main` (f3e935a6) rather than copied from the
> changelog wording. This file is written **before** the version is cut, the same way the 0.31.0 guide
> was (added by a docs commit ahead of the release commit).
> Library surface only; the `erix_run` extension has its own section (§8) because it is not public API.

## 1. Read this first

| If you … | then in 0.32.0 |
|---|---|
| read `snapshot.messages` for body text | **stop**: it now carries only the current round's residue (§2.2) |
| read `snapshot.toolUse` / `.ts` / `.status` / `.compactionStats` | those four cells are **no longer written** (§2.2) |
| resume archives older than 261021 | they **no longer resume** (§2.1) |
| call `appendUserTurn` | you get one new optional return field, `unsettledToolUses` (§4) |
| want the crash-gap to close in the ledger | implement `loadRawRows` (§3.1, §4) |
| wrote a store against the contract suite | optional third parameter declares what you implement (§3.3) |
| do nothing at all | nothing breaks: every new capability is optional and degrades loudly |

No exported name is removed or retired in this version. `npm run check:host-consumers` prints zero
removal candidates and zero host hits, so this release has no known import that stops resolving —
**that is also why this guide has no name table**: the content below is behavior, not renames.

## 2. Behavior changes that can reach your users

### 2.1 Run snapshots from before 261021 no longer resume (#754)

The upgrade gate for pre-261021 run snapshots was closed with no replacement. Those archives carry
three cells (a truncated assistant body, `toolResults`, `pendingToolUse`) that the engine cannot
rebuild from today's ledger, and reading them made a run continue on context the crash had already
lost — silently, in production.

- **What you see**: resume emits `:control:resume-notice` telling you the legacy snapshot was dropped
  and recovery was rebuilt from the ledger. **No new event type, no new reason value** — it rides the
  notice channel that already exists.
- **What you do not see**: an empty body, a silently skipped tool, a fake success. Those were the bug.
- **If you must recover such an archive**: read it yourself (the three cells are still on disk) and
  decide what the model should be told, or start a fresh run.

### 2.2 The run-snapshot payload got smaller (#735 slices 1–2, #770, contract axes #767)

Four cells are no longer written, all four with a measured zero reader on the recovery side:

| cell | stopped by | why it was safe |
|---|---|---|
| `toolUse` | #735 slice 1 | same source cloned twice as `pendingToolUse` |
| `ts` | #735 slice 1 | read side never touches it at snapshot-object level |
| `status` | #770 | classification is passed explicitly at the call site instead |
| `compactionStats` | #770 | only a test read it |

Key **order** is unchanged on purpose (`src/store/file.js` serializes the payload directly, so key
order is on-disk bytes visible to you); a machine-absence assertion pins the four cells.

`snapshot.messages` semantics changed (#735 slice 2): the cell now delivers **only the residue of the
current round**; cells before the residue are `null`. Reading body text out of `snapshot.messages` is
no longer supported — **read the ledger**. Index alignment is preserved, so `messages.slice(anchor)`
still means what it meant. If you read snapshots, open the two-axis table in
`docs/host-consumer-contract.md` (each cell now says who writes it and who reads it).

### 2.3 Project instructions: cap 32 KiB → 64 KiB (#721)

`PROJECT_INSTRUCTIONS_MAX_BYTES` is now `64 * 1024` (`src/project-instructions.js`). When content is
truncated the injected block ends with a truncation marker line, and
`discoverProjectInstructions()` returns `droppedSections` so you can see what did not fit instead of
guessing. If you injected near the old ceiling, your prompt got bigger — check your token budget.

## 3. New optional store capabilities

Nothing here is required. The table is the whole contract: the right column is what happens when you
skip it, and in every case the run keeps working.

| capability | required | if you skip it |
|---|---|---|
| `loadRawRows(runId)` (#714) | no | crash-gap stubs go to the request view only, one `resume_journal_skipped` per pair |
| `appendRecoveryRow` / `listRecoveryRows` / `clearRecoveryRows` (#769) | no | one `persistence_capability_degraded` per missing method per run (read side missing: silent) |
| third argument of `transcriptStoreContract` (#739) | no | the suite keeps assuming you implement nothing, so it skips those cases |

### 3.1 `loadRawRows` — the one sharp edge is the `round` type

Return the **un-folded rows** of one run (same read path as `load()`). Folding drops a row whose
`round` is not a safe integer:

```js
// src/store/message-rows.js
const round = Number.isSafeInteger(record?.round) ? record.round : undefined;
if (round === undefined) continue;   // that round disappears from the rebuilt view
```

So keep the numeric type end to end. The usual way to lose it is not the engine: a PG column typed
`text`, or a MySQL driver with `bigNumberStrings` on, turns your integer into `"2"` and that round
vanishes. Rows you wrote through the engine's own writers are safe; rows you hand-write are yours.

### 3.2 Recovery rows (#769) — the ledger became the primary recovery channel

The engine now journals "this tool executed" and "this text was produced, unreplayable" as **recovery
rows** in the ledger, and reads them back on resume. Snapshot cells are the fallback, not the only
home. Consequences for you:

- a store whose read method **exists but rejects** now ends the run with a new terminal error,
  `RECOVERY_ROWS_UNREADABLE` (`src/loop/resume-manager.js`; the value on the wire is the lower-cased
  form of that name) — implement it honestly or not at all;
- a store whose write or clear method is missing gets one `persistence_capability_degraded` per run;
- the dedup namespace `<key>:recovery:<seq>` is new and does not collide with round/message rows.

### 3.3 The contract suite stopped forcing you to lie (#739)

`transcriptStoreContract(name, factory, optionalCapabilities)` — the third argument declares which
optional capabilities your store really implements. Honest declarations matter: an **entire group
absent** is a legal skip, a **half-implemented group** is named as a violation. Stores behind
`Object.freeze` are legal now, and the capability list is derived from the same source the assembly
validator uses, so it cannot drift from what the engine actually calls.

## 4. `appendUserTurn` grew one return field (#765/#789)

Before writing your user row, the engine now settles a `tool_use` that a crash left without a result.
Why before and not after: a tool result must be the page **immediately after** its call, and the
ledger is append-only — once your text row is on disk, no appended row can satisfy that rule, and
every resume dies in local validation. You used to be able to brick an archive by sending a message
after a crash; now the engine closes the gap first.

```js
const r = await appendUserTurn(store, { key: runId, text: userInput });
if (r.unsettledToolUses) {
  // r.unsettledToolUses.status === "settled" | "refused"
  // .round .toolUseIds .dedupKey .written? .reason?
}
```

The field is **absent** when there was nothing to settle — you do not need to branch on it unless you
want to. Four refusal reasons, and a refusal is not an error: your row still gets written and the run
still resumes (the request-view fallback of #790 handles it later):

| reason | what it means | what you can do |
|---|---|---|
| `ledger_probe_absent` | your store has no `loadRawRows` | implement it (§3.1) |
| `round_not_safe_integer` | a raw row's `round` came back non-integer | fix the type (§3.1) |
| `round_carrier_has_body` | that round's carrier already has body text; a stub would fold into the wrong page | nothing |
| `tool_use_id_unusable` | the `tool_use` id itself is unusable | nothing |

The dedup namespace `<key>:settle:<round>:<tool_use ids sorted, joined with +>` is new. A store that
implements `loadByDedupKey` and `loadMaxRound` but **not** `loadRawRows` gets `ledger_probe_absent` on
every call — that is the current state of the PostgreSQL store in `erix-station`.

## 5. New event, reason and detail values

- **New event name** `host_steer_injected` (tier `fact`, payload `round` / `chars`) — emitted only if
  you implement `capabilities.hooks.nextUserTurn`; `diagnostics.steer` reports
  `{offered, injected, rejected, lastRound}` for those runs.
- **`resume_journal_skipped` gained reasons**: `mid_sequence_merge_refused`,
  `mid_sequence_shape_not_supported`, `mid_sequence_stub_row_write_refused` (#730) and
  `mid_sequence_request_view_stub` (#790). Under `mid_sequence_aggregate_row_not_in_ledger` the
  `detail` now distinguishes `anchor_probe_absent` / `round_carrier_has_body` /
  `aggregate_row_not_in_ledger`. **No new event type** — abandonments ride this event.
- **A documented value that is not currently emitted**: `round_not_safe_integer` as an event **detail**
  of `mid_sequence_stub_row_write_refused` has no reachable producer in this version — ledger rounds
  are normalized before a stub can be built, and an anchorless stub stops earlier. The same word is
  live as an **`appendUserTurn` reason** (§4). Treat the event detail as reserved; do not build
  behavior on it, and do not remove your branch until the contract says otherwise.
- **New exports to help you decide what to keep** (#743): `EVENT_TIERS`, `eventTierOf`,
  `EVENT_TIER_VALUES`, `HOST_SIDE_EVENT_TYPE_NAMES`, `RUN_TERMINAL_STATUSES`,
  `RUN_CLEANUP_SAFE_STATUSES`, `streamCleanupEligible()`. The engine deletes nothing from your side;
  these are the lookup tables for your own retention policy.

## 6. Fields added to records you already read (no action)

All additive, and the rule is the same for every one: **absent means "no fact", never a zero**.

- `usage.reasoningTokens` — only when the upstream reports it (§7 for how to ask).
- `RoundRecord.sentRequestParams.reasoningEffort` = `{hostValue, sentValue, source, translated?}` —
  your own provider implementation never produces it.
- `RoundRecord.runStateMeta` = `{bytes, capBytes, truncated}` — a byte account, nothing was dropped.
- `compaction` / `deterministic.compactionStats` gained a `foldArchive` projection
  (`droppedMessages`, `droppedBytes`, sometimes `capBytes` / `dedupedMessages`) — only when the
  projection has facts, so old shapes are byte-identical.
- `foldedSummary.fedSummaryText` plus planner fields `replaySource` / `savedSummaryBytes` /
  `replayedSummaryBytes` / `byteEqual ∈ equal|differ|unknown`.

## 7. CLI surface (#798)

`erix chat` and `erix repl` accept `--effort <tier>`, and `LLM_KIT_REASONING_EFFORT` is consumed.
Precedence is **`--effort` > env > `slots.default.reasoning_effort`** — deliberately the **opposite**
of `--model`, where the slot wins. An empty value means "not provided" everywhere. The usage line
prints `reasoningTokens=` only when the upstream reported it. A tier with no upstream mapping is
dropped and counted, not passed through to a third protocol.

## 8. Extension surface (`examples/pi-extension`, the `erix_run` tool)

Not library API — skip this section if you consume the package only. `src/` and `bin/` are untouched
by all three items:

- `action: "steer"` feeds a running background job; `steerPending` is always present (`0`, not a
  missing key) and `diagnostics.steer` reaches `status` / `result` / `status.json` (#753 C2).
- A late `session_shutdown` from an old extension instance can no longer detach a live session's
  handle or clear its timer; `handleReleaseRefusals` / `orphanRecoveries` / `orphanRecoveredAt` /
  `shutdownTimerSkips` are readable, and `session_start` re-queues orphans (#800).
- `finalGuard` evidence is now "surviving window ∪ this run's ledger"; `diagnostics.finalGuard.evidence`
  carries `source` / `round` / `survivesLastCompaction`, and `verification.reason` gained
  `not_in_ledger` (`status` stays `unverified`) (#797).

## 9. What does not change

- no export removed, no export renamed, no entry deleted from `files`/`exports`;
- the closed set of `executionStatus` values stays `intercepted / interrupted / rejected`;
- ledger row format unchanged; the only new dedup namespaces are `<key>:settle:<round>:<ids>` (§4)
  and `<key>:recovery:<seq>` (§3.2);
- every existing event name and every existing reason keeps its meaning; events with no `detail`
  keep their exact shape;
- `readFile`'s promise is unchanged, but its model-facing capacity line moved to a lower tier
  (3,700 → 3,650 lines) because the tightest file in the tree changed owner — a prompt-text change,
  not a behavior change.

## 10. Verify it on your side

```bash
npm view erix-agent version                      # 0.32.0 (wait for the registry, not the tag)
npm install erix-agent@0.32.0 --prefer-online

# 1. does your store declare the new optional probes?
grep -rn "loadRawRows\|appendRecoveryRow\|listRecoveryRows\|clearRecoveryRows" <your store dir>

# 2. does your store keep round numeric?
grep -rn "bigNumberStrings\|::text\|CAST(" <your store dir>

# 3. do you read any snapshot cell this version stopped writing?
grep -rn "\.toolUse\b\|\.compactionStats\b" <your code that reads snapshots>

# 4. run the shipped store contract suite with an honest capability declaration
#    (third argument; an absent group must be declared absent, not half-implemented)

# 5. behaviour smoke test: resume an archive that used to brick
#    expect: no invalid_messages / no "assistant tool_use has no immediately following user
#    tool_result", and on appendUserTurn either no unsettledToolUses or a reason from §4.
```

If you want the ledger to close by itself rather than being repaired on every resume, the only thing
you need is §3.1. Everything else in this guide is optional.
