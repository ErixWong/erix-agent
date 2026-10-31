# Host upgrade guide: 0.29.0

**Release: 0.29.0 (2026-10-31).** This is the release where the library learns to **bookkeep** a child
run without ever starting one. Nothing on `runToolLoop`'s input surface moves: no option is retired,
renamed or re-homed, so a host that upgrades by bumping the version and changing nothing else keeps
running exactly as before. What is new is an opt-in surface — `createDelegateTool` on
`erix-agent/tools`, one config leaf `config.run.parentRunId`, and five ports **you** supply — plus a
set of corrections that exist only so that the roster and the tool result tell the truth.

If you never call `createDelegateTool` and never pass `parentRunId`, the observable change for you is
**three roster fields** (§4) and nothing else. If you do delegate, read §3 before §2: the ports are
where a host gets this wrong, and every one of them fails *quietly*, in a way that reads like the
child misbehaving.

Two slices, then. **§2–§5 are the delegation slice**: a new opt-in surface plus the corrections that
make its records true. **§7 is the compaction and continuity slice**: one default changed, one text
shape changed, three new facts to observe — read it if you parse the folded-history block, filter
observer events by name, or run your own summarizer. §6 names the rest of the release, and §8 is the
list of things that did not change.

## 1. Change summary

| What you change | Why it changed | Where |
|---|---|---|
| Import `createDelegateTool` from `erix-agent/tools` (opt-in: nothing is registered for you) | delegation is bookkeeping; the library cannot start a child | §2 |
| Pass `config.run.parentRunId` when a run is a child | one opaque identity, mirrored in four places, never interpreted | §2 |
| Wire `runChild` (required) and `notifyParent` / `transcriptPathFor` / `cwdFor` / `isProcessAlive` (optional, each with a named cost) | the library never forks, never guesses your layout, never invents a death | §3 |
| Expect 21 roster fields, `result.text`, and `tail`'s two failure reasons | a record that cannot answer "what did it say" is not a record | §4 |
| Nothing at all, if you do not delegate | no option moved, no read side changed | §8 |
| Read §7 if you parse the folded-history block, filter observer events, or own a summarizer | one default changed, one text shape changed, three new facts to observe | §7 |

### Files touched by this release (host-visible surface)

* `src/tools/delegation/tool.js` — the tool factory, the six actions and the terminal-state mapping
  (`createDelegateTool`).
* `src/tools/delegation/roster.js` — the 21-field record, the shape gate on read, the stale recompute
  (`reconcile`).
* `src/tools/delegation/capacity.js` — the fixed slot pool (`acquire` / `release`), cross-process
  atomic.
* `src/tools/delegation/tail.js` — the bounded tail read behind `action=tail`
  (`tailChildTranscript`).
* `src/tools/delegation/notify.js` — the completion marker key (`completionMarkerKey`) and the
  fixed-prefix notification line.
* `src/tools/index.js` — the `erix-agent/tools` re-exports (purely additive).
* `src/loop/orchestrator.js`, `src/loop/judge-record.js`, `src/loop/config-namespace.js` —
  `config.run.parentRunId` and its four projections.
* `bin/delegation.js` — the CLI's assembly of the tool: the runnable example, not a contract.
* `docs/host-consumer-contract.md` (and `_cn`) — the authoritative contract, updated throughout.

## 2. The new public surface: one factory and one leaf

`createDelegateTool({ runChild, rosterDir, … })` (`src/tools/delegation/tool.js`) returns
`{ definition, execute }`, the same shape as every other tool on `erix-agent/tools`. One tool, **six
actions** (`DELEGATE_ACTIONS`): `run`, `status`, `result`, `list`, `cancel`, `tail`. There is no
`pause` / `resume` / `retry`: a v1 that cannot restart a child must not advertise restarting one.

| action | what it answers | what it does not do |
|---|---|---|
| `run` | starts a child (foreground, or background with `background: true`) and returns the child `runId` | never forks — it calls your `runChild` |
| `status` | one roster record, after the stale recompute | does not consume the completion |
| `result` | the terminal record **plus the child's final text**; marks it consumed | answers `still_running` for a live child |
| `list` | every record, plus the `corrupt` / `interrupted` / `foreignOwned` / `unverified` buckets | does not hide a bucket |
| `cancel` | aborts a child **this process owns** | answers `not_owned` for anybody else's |
| `tail` | a bounded read of the child transcript's tail | does not repair the file, does not reconcile |

Two shapes are worth pinning because hosts build on them: a foreground `run` returns the child's
`text` and `termination` directly, while a background `run` returns `state: "running"` and the parent
collects the outcome later with `result`; and `list` returns the buckets as **named arrays**, so "no
record was touched" is observable rather than inferred.

`parentRunId` is the second half of the surface. `config.run.parentRunId` is one opaque string the
engine **mirrors and never interprets**, projected from one source into four places: the judge record
correlation (`judgeRecordFields` (`src/loop/judge-record.js`)), the `run_outcome` event, every
`onEvent` payload, and the diagnostics / observer-error detail. A host that sets it on a child run can
join the child's records to the parent's without parsing anything. **It is not a model input**: the
delegate tool takes the parent identity from the execution context (`context.runId`), and its input
schema has no `parentRunId` key — an identity a model can fill in is an identity that can be spoofed.

## 3. The five ports, and what each one costs when you skip it

The library holds no opinion about *how* a child runs, *where* its transcript lives, *which* directory
it runs in, or *whether* a pid is alive. Each of those is a port. Only `runChild` is required; the
other four are optional, and **all four fail quietly**, so this section is the one to read twice.

### `runChild` (required) — you decide what a child *is*

`runChild({ task, cwd?, parentRunId?, runId, model?, deadlineMs?, signal })` returns
`Promise<{ text, termination?, verification? }>`. The library does not fork, spawn or import
`child_process`: same process, a subprocess, a remote worker are all equally fine. The `termination`
you return must use the library's vocabulary — `TERMINATION_TO_STATE` (`src/tools/delegation/tool.js`)
maps `end_turn` / `judge_done` → `completed`, `aborted` → `aborted`, `timeout` / `timed_out` →
`timeout`, and **everything else, including unlisted words, → `failed`**. Do not invent a termination
word: it will be recorded faithfully and read as a failure. A missing `runChild` throws at factory
time, which is the only failure in this section that is loud.

### `notifyParent` (optional) — there is no mailbox

`notifyParent(line)` is called once when a background child reaches a terminal state, with the
one-line text built by `notificationText` (`src/tools/delegation/notify.js`) — a fixed prefix in
**code** (not in a prompt, so compaction cannot re-file it), the child `runId`, the `parentRunId` when
present, the state and `endedAt`. Without it you get no wake-up at all: the completion is still
written to the roster, and the parent finds it by polling `status` / `result` / `list`. There is no
queue into a running `runToolLoop`, and pretending otherwise would be the worse contract. The
callback is deduplicated on the `(runId, endedAt)` pair: a parent that already collected the outcome
with `result` is not woken for the same completion, and a resumed run that reuses a `runId` **is**
woken again, because that is a new completion.

### `transcriptPathFor` (optional) — without it `tail` always answers `no_transcript_path`

`transcriptPathFor(runId) => string` tells the library where the child's transcript is being written.
The record is created by the library and the library does not know your layout, so the roster's
`transcriptPath` field is only filled when **you** fill it. When you supply the port, the path is
written in the **same atomic write that creates the record**, so a parent that calls `tail`
immediately after `run` already sees it — there is no "create, then patch a second time" window.
Without the port the field stays absent, exactly as before, and every `tail` answers
`no_transcript_path` — a configuration defect on your side, not a missing child. Derive the path with
your store's own naming helper rather than concatenating `<runId>.jsonl`: ids the store considers
unsafe are hashed, and a hand-built path is wrong for that class in a way that only shows up as "the
file never exists". A non-empty string is required; anything else throws before a lease or a record is
written.

### `cwdFor` (optional) — without it the roster's `cwd` is a request, not a fact

`cwdFor(requested, runId) => string` is where the child **actually** runs. A model's `cwd` is a
request: the library does not resolve relative paths and does not know your default directory. Supply
the port and the library resolves the value **once** and uses that same value for both the record and
`runChild` — never "record one directory, execute in another". Its return value must be a non-empty
string or the factory throws. Without the port the old behaviour stands, and the honest description
of that behaviour is: **the roster's `cwd` field does not describe where the child ran.** A host that
wants a true record should always supply it; the CLI does
(`cwdFor: (requested) => path.resolve(requested ?? parentCwd)`).

### `isProcessAlive` (optional) — without it you get no stale cleanup at all

`isProcessAlive(pid) => boolean` is the liveness predicate the stale recompute uses to separate "a
live child another host is keeping in this same roster directory" (listed as `foreignOwned`, record
untouched) from "nobody owns this any more" (written as `interrupted`, with `endedAt` taken from that
record's own `updatedAt` rather than from the probe time). **Without the predicate the library refuses
to judge**: live records that carry a `pid` go into a separate `unverified` bucket and are left on
disk byte for byte. That trade is deliberate — inventing a death for another process's live child is
the worse failure, and it happened on a real machine (process A dispatched a background child; process
B answered one `status` call and rewrote A's record as `interrupted`). The cost is written on the
face of it: **no predicate, no stale cleanup.** This is not a daemon-only path: the roster directory
defaults to `~/.erix/delegation/`, so it is shared, and two concurrent CLI sessions meet there. The
CLI passes the real predicate (`process.kill(pid, 0)`: success means alive, `EPERM` means alive
without permission, `ESRCH` means dead).

## 4. What the roster and the result now say

Seven corrections, all in the same direction: the record and the tool result must not require the
parent to guess.

* **The roster has 21 fields, not 18.** Three were added — `resultText` (the child's final text),
  `resultTruncated` (exactly `true`, and only when the text was cut) and `errorMessage` (written only
  when the child threw). All three land in the **same atomic write** that stores the terminal
  `state`, not in a follow-up patch, so a `result` that sees a terminal state always sees the text
  that goes with it. Absent fields stay absent; nothing is written as a placeholder.
* **`action=result` carries the child's final text.** `result` returns the terminal record's fields
  plus `text`, `truncated` when it was cut, and `error` when the child threw. Two caps: **4000**
  characters for the text and **1000** for the error. The cap is not tidiness — the child's final
  answer can be a whole report, and pasting it back into the parent's context bills the child's round
  a second time; a parent that wants detail calls `tail`. Before this, a background child's text was
  dropped on the floor: the parent got `state` and `termination` and had to guess the answer.
* **`tail` separates two failures, and the split is the contract.** `no_transcript_path` means the
  record carries no path (**your** configuration defect); `no_transcript` means the path is recorded
  but the file is absent or unreadable (the child has not written its first row yet, or the file was
  cleaned up — **normal timing**, and an unreadable file adds a `detail` with the reason). Collapsing
  them would make "you never wired it" read as "the child did nothing". The read is bounded: 8 rows
  by default, at most **20**, 300 characters per row (hard cap 1000), each row carrying the tool name
  and an args digest for tool calls. `truncated: true` means older rows were left out; `partial: true`
  means the last row was mid-write and was dropped rather than shown as garbage.
* **The concurrency cap is a slot pool, and it is atomic across processes.** Taking a slot is now a
  single exclusive create (`open(..., "wx")` on `slot-<i>.lock`), so the decision and the claim are
  the same system call: two processes can no longer both read "one slot left" and both create one.
  A full pool fails structurally (`capacity_full`, naming the holders) — it never queues and never
  spins. A slot whose holder can be **proven** gone is reclaimed on the spot: your liveness predicate
  decides whenever the lease carries a pid, and only without a predicate does a 30-minute age
  threshold apply — a fallback, not an authority, which is why a child's own time budget should stay
  well below it. Reclaiming re-reads the slot and unlinks only the exact holder it judged dead;
  releasing removes only a slot that records the caller's own identity. Lease files written by older
  versions no longer count against the quota and are never deleted (they were short-lived by nature,
  so leaving them is harmless).
* **`reconcile` has an `unverified` bucket, and `running` is now a state you will actually see.** The
  record moves `queued` → `running` → a terminal state, and `running` is written **before** the
  library calls your run function — before this, the seven-value state machine never wrote `running`,
  so a child that was working and a child stuck in the queue looked identical. `status`, `result` and
  `list` all run the recompute first; a record stuck in a live state because its owner died used to
  answer `still_running` forever and now returns the terminal outcome. A child that really is running
  still answers `still_running` — the recompute is not a licence to declare everything dead.
* **An explicit `--compact-budget` is inherited by child runs.** The child used to build its
  compaction context with no explicit budget at all, so a budget the parent passed on the command line
  silently disappeared one level down and only the value derived from the configured context window
  survived. With no explicit budget the old derivation stands, unchanged. This one is CLI wiring
  rather than a library default: the engine never invents a budget for a child.
* **The completion marker key has a separator.** `completionMarkerKey` (`src/tools/delegation/notify.js`)
  used to concatenate `runId` and `endedAt` with nothing between them, which only stayed unambiguous
  because timestamps happen to be 13 digits. The key is now `runId:endedAt`, so `("a1", 23)` and
  `("a", 123)` are different completions. If you persist `collected` markers across restarts, old
  keys written by 0.28.0 will not match: the worst case is one extra wake-up for a completion you had
  already collected, and the marker is re-recorded in the new form on the next `result`.

## 5. Boundaries in v1 (written down, not papered over)

* **Delegation does not recurse.** The child's tool face excludes `delegate` itself, and it is
  filtered with the parent's tool allowlist before the engine sees it — delegation never widens
  permissions. With no allowlist the child keeps the full face, exactly as before.
* **`cancel` only reaches this process.** It aborts an `AbortController` this tool instance
  registered for a background child; anything else answers `not_owned`. It does not lie, and it does
  not reach into another process.
* **`tail` is a read, and reads do not repair.** It uses the store's read-only tail reader, never the
  loader that repairs a transcript tail — repairing a file another process is appending to would
  truncate it under that process's feet. It also does **not** reconcile, because rewriting somebody
  else's roster record while reading it is exactly the overreach the `unverified` bucket exists to
  avoid.
* **The reclaim window is not closed.** Between the second snapshot and the `unlink`, two processes
  that both judge the same dead holder on the same slot can race; Node's core has no `flock` or
  conditional unlink, so this slice does not pretend to close it. The window is microseconds wide and
  requires both processes to target the same slot at the same instant. What it can cost is one
  over-issued slot, not a lost child.
* **There is no queue and no daemon.** A full pool is a structured failure, and a crashed lease is
  reclaimed only when somebody tries to take that slot.

## 6. What else is in 0.29.0

Named here so you can decide whether to read further; each has its own `CHANGELOG.md` entry and its
own contract section.

* `createAgent({ config, capabilities, … })` (issue #571) — a pure-addition wrapper over
  `runToolLoop` that holds the once-only options and lets `agent.run(input)` take only this call's
  data, so a message can no longer replace the whole `policy.config` tree.
* `config.folding.context.foldAtRatio` (issue #569) — fold earlier at a fraction of the budget; the
  default `1.0` is byte-for-byte today's trigger.
* `capabilities.hooks.continuityProvider` + `config.folding.context.continuityMaxTokens` (issue #568)
  — a budgeted session continuity block. Since issue #598 the engine is its **default writer**
  (`config.continuity.handoff`, default `off`): turn the switch on and the engine injects the handoff
  instruction itself, so no host provider is needed; `continuityProvider` is an **override**. §7.2 has
  the details, and §7 has the rest of this release's compaction and continuity surface.

## 7. The compaction and continuity surface

Six changes on this side of the release, ordered by how much a host has to do about them. None of them
retires an option; two change **defaults**, and one changes the **shape of text** a host may be
parsing.

### 7.1 The CLI's default compaction strategy is now `fold-llm` (issue #614)

`erix chat` and `erix repl` used to default to the statistical summarizer. The default is now the
LLM-driven fold (`DEFAULT_COMPACTION_STRATEGY` (`bin/config.js`)), with the statistical one demoted to
the **degradation fallback** it already was in practice. The cost is the reason this is item one:
**every compaction now costs one extra main-model call.** A host that does not want that trade passes
`--compaction fold-statistical`, or sets `config.folding.context.strategy` to `"fold-statistical"`; the
strategy itself was not removed, and the name set is unchanged (`"sliding-window" | "fold-statistical"
| "fold-llm"`).

### 7.2 `config.continuity.handoff`: the engine is the default writer (issue #598)

The continuity block — the session snapshot injected at the request tail — gained a switch.
`config.continuity.handoff` is `"off"` (default) | `"prompt"` | `"prompt-and-fallback"`. Turn it on and
**you do not have to supply a provider**: the engine injects a short instruction
(`HANDOFF_INSTRUCTION` (`src/loop/continuity-block.js`), ~80 tokens) at the request tail, the model
writes a `<handoff>` block inside the **same** response (zero extra requests), the engine parses the
three sections and stores them at `~/.erix/continuity/<project-key>.json` — the key is derived from the
working directory the same way the session id is, and `resolveContinuityDir`
(`src/loop/continuity-block.js`) honours `ERIX_CONTINUITY_DIR` first — then recalls that record at the
start of the next run. A missing section is recorded as `unknown`: the engine never writes a mechanical
substitute for a semantic handoff. `"prompt-and-fallback"` allows **exactly one** extra call that asks
only for the block, for a run that ended without one. `capabilities.hooks.continuityProvider` is now an
**override** — supply it and your text wins, with the default writer standing down. The default is
`off`, so a host that changes nothing sees zero behaviour change: no instruction in the request, no
file written, no directory created.

### 7.3 `context.workingSetRecentRounds` is opt-in and off by default (issues #608, #612)

Setting `config.folding.context.workingSetRecentRounds` to N > 0 keeps the last N rounds that carry a
`tool_result` out of the fold. It is a **sorting preference**, not a ban: when nothing else can be
folded the engine still folds the oldest round, so folding cannot deadlock. The default is **0 = off**,
and that default is the important half — the mechanism was measured before it was defaulted, and the
measurement went the wrong way. On the same `bigdoc` scenario (one 119k-token result, 64k budget) total
input went **11,467 → 46,476** tokens and re-reads went **3 → 9**, while fact recall was **0/5 in both
arms**: the floor stops the fold, the model never gets a summary, retries, and pays more for the same
answer. What the model was missing there is *experience* (what is done, how far it got, what must not be
redone), not *detail* — which is why the floor ships off and the effort went into the semantic fold.

### 7.4 The fold block is rendered from the ledger, so its text shape changed (issues #601, #603, #605, #565)

The block that replaces folded history is now rendered from the per-fold ledger entries — one
append-only `foldedFacts` entry per fold, each carrying its own text and its own increment — instead of
being re-parsed out of one accumulated string. Two consequences reach a host. The block is **sectioned**:
the most recent folds are printed in full (title, tool footprint, inventory, summary) while older ones
keep only a title line, because the full text is still in the ledger. And the inventory comes from the
structured `toolCalls` projection, not from parsing the rendered text back. If you parsed that block's
text, **the shape changed** — read the ledger instead. `parseFoldSummaries`
(`src/compact/fold-statistical.js`) still exists, but it is now the compatibility path for old
transcripts and the fallback when an entry carries no structured keys.

### 7.5 The summarizer prompt gained a sixth section, and an empty summary is now a failure (issue #611)

The fold summarizer prompt (`SUMMARIZER_PROMPT_GUIDE` (`src/compact/fold-llm.js`)) has a sixth section,
`## 教训与坑（不要重犯的）`: what was tried and failed and why, the constraints that must not be
violated, and the confirmed traps — copied from the folded text only, `无` when there is nothing. If you
run your own summarizer through a strategy port, the return contract got one hard edge: **an empty or
whitespace-only summary is a failure, not a success.** It degrades with the new `empty_summary` kind
(the error code is `summarizer_empty_summary`) instead of silently replacing your history with nothing.

### 7.6 Three new things to observe (issues #588, #608, #594)

* The `compaction_deferred` event: emitted when a fold is postponed because a dangling `tool_use` has
  not been settled yet. A `fatal: false` fact on the existing observer channel, not a new callback.
* The `budget_below_working_set` diagnostics: emitted when the working set alone cannot fit the budget
  and folding has to stop. Payload: `budgetTokens`, `workingSetTokens`, `suggestedBudgetTokens`,
  `repeatStreak`, `foldLayersOverBudget` (plus `attempts` and a `detail` string).
* The run state's `last=` cell: a ~10-token cursor naming the most recent tool call whose arguments
  **differ** from the previous one, growing to `×N` when the same call repeats — so a host (or a
  resumed model) can see where the run got to without reading the transcript.

If your alerts filter on event names, or your dashboards whitelist diagnostic fields, add these three.

## 8. What did not change

* The `runToolLoop` input surface: no option retired, renamed or re-homed; the accepted top-level name
  set, the `config` schema and the `capabilities` shape are the ones 0.28.0 shipped.
* Termination, verification and exit-code semantics; the `skipped`-without-guard exit code stays `4`.
* Transcript and run-state on-disk formats; resume from a ledger written by 0.28.0.
* The `delegate` tool is **off by default**: it is not in the default tool face and not in the default
  system prompt, and `erix chat` / `erix repl` only register it with `--delegate`. Its three flags
  keep their defaults: `--delegate-max-children` 2, `--delegate-timeout-ms` 600000, roster directory
  `~/.erix/delegation/` (moved by `ERIX_DELEGATION_DIR`).
* The zero-runtime-dependency rule: the delegation modules import `node:` built-ins and relative paths
  only.

## 9. Verify it on your side

1. **If you do not delegate, stop here.** Nothing in §2–§5 applies; the only visible change is the
   roster field count in §4, and only if you read roster files yourself.
2. **Prove `tail` is wired, not merely present.** In a smoke test, dispatch a background child and
   call `tail` before the child has written anything. `no_transcript` is fine (the child has not
   written its first row); `no_transcript_path` means `transcriptPathFor` is missing — fix the wiring
   before you trust any tail.
3. **Prove the result carries text.** Run one background child that answers a known string and assert
   `result.text` contains it. An empty `text` with a terminal `state` means the child's run function
   returned nothing — the library does not invent a body.
4. **Prove the roster describes reality.** With `cwdFor` wired, compare the record's `cwd` with the
   directory the child actually used; without it, treat the field as the model's request.
5. **Type-check against the published declarations** (`tsc --strict`). `createDelegateTool` and its
   action union are in the generated declarations for `erix-agent/tools`; a missing export or a
   wrong action name is a compile error, not a runtime surprise.
6. **If you run the CLI's own gate**, the end-to-end proof is `examples/delegate-real-e2e.test.mjs`,
   step 2 of `npm run check:release:real`: a real-upstream parent run delegates a child, and the test
   asserts the child's roster record carries the parent's `config.run.runId`, the child ends
   `end_turn`, the roster ends `completed`, and the parent is woken **exactly once**.
