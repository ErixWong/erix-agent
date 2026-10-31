<!-- doc-version: 0.20.0 -->
# Host upgrade guide: 0.20.0

This guide covers the changes a host has to **act on** in 0.20.0. Two families: the storage
side (T1/T2, issues #284 / #285 — the field namespace inside a stored tool result, plus the
CLI exit code and packaging facts that ride along with them) and the abort side (issues #282 and
its follow-up, and #283 — what a stopped run means and what it leaves behind), plus one pinned shape
change (issue #220). `CHANGELOG.md` remains the complete list; if a section below does not
describe your code path, that section is a no-op for you.

**Read this sentence before you skip the guide: the field names inside a stored tool result
changed.** The protocol fields and the wire format did not — `type` / `tool_use_id` /
`content` / `is_error` are still where the Anthropic and OpenAI converters put them, and
`TranscriptStore` method signatures and the top-level `RoundRecord` shape are unchanged.
What changed is the **namespace inside the stored block**: engine facts moved from the top
level into `erix.*`, and your own extension keys moved from the flattened top level into
`metadata.*`. No option name and no method signature moved. The package still has zero npm
runtime dependencies, is still pure ESM, and still requires Node 22.

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| Tool result facts now live in `erix.*` / `metadata.*`; the flattened top-level names are retired (T1/T2, issues #284 / #285) | reads `block.erixRound`, `block.duration`, `block.executionStatus`, `block.success`, or its own flattened extension key off a result block written by 0.20.0 | 2 |
| Old records stay readable for one generation, with the engine namespace winning | relies on the top-level legacy names being *gone*, or relies on the top-level names winning when both sides are present | 3 |
| `aborted` now outranks `judge_done` and `final_guard_unverified` at the terminal decision, on every path that can reach a terminal decision (issue #282 and its follow-up) | treats "no exception, reason `judge_done`" as proof the run was not stopped | 4 |
| An aborted run writes **no** transcript record for the round that was in flight, and `termination.partial` describes the payload, not the store (issue #283, ruling = β) | reads "partial results" out of the transcript store, or files a bug when a stopped run has zero records for its last round | 5 |
| The four success return shapes of `createFileTools().executeTool()` are pinned by the packaged contract suite (issue #220) | nothing breaks; hosts gain a discriminator instead of a hand-written shape-guessing layer | 6 |
| `TOOL_RESULT_CONTRACT` now records the **existence condition** of `erix.executionStatus` (issue #286 follow-up); the engine behaviour itself is unchanged | a host read only the constant and assumed every result block carries `erix.executionStatus` | 7 |
| `erix run` exits **4** when verification did not run (`verification.status === "skipped"`), and `examples/` / `scripts/` are not in the published tarball | a CI script that maps only 0/1/2/3, or a host that `require`s a path under `examples/` from the installed package | 8 |

## 2. Tool result facts moved into `erix.*` and `metadata.*` (T1/T2, issues #284 / #285)

`buildToolResultFact()` in `src/tool-fact.js` is the single construction point for a
`tool_result` block, and `TOOL_RESULT_CONTRACT` (exported from the package root) is the
single statement of who owns which field. As of 0.20.0 the `legacyTopLevel` argument and the
"flatten the host map onto the top level" step are **gone**: a block the engine produces is
exactly the protocol fields (`type` / `tool_use_id` / `content`, plus `is_error` on error and
interrupted results) + `metadata.*` + `erix.*`.

The retired list (`TOOL_RESULT_CONTRACT.legacy` holds this same table, and the packaged
contract suite has a sentinel that turns red if any of these names appears at the top level
again):

| Retired top-level name | Read this instead |
| --- | --- |
| `erixRound` | `erix.round` |
| `duration` | `erix.durationMs` |
| `executionStatus` | `erix.executionStatus` |
| `success` | `erix.success` |
| `toolCallKey` (never existed at the top level; named here so the five are complete) | `erix.toolCallKey` |
| any host extension key flattened to the top level (`artifactStatus`, `path`, …) | `metadata.<your key>`, e.g. `metadata.artifactStatus` |

The five engine fields, in one place:

| Field | What it is |
| --- | --- |
| `erix.toolCallKey` | durable identity of one accepted call (see below) |
| `erix.round` | the round that produced the result |
| `erix.durationMs` | executor wall time, captured once (see below) |
| `erix.executionStatus` | present **only** in the two special states — see section 7 |
| `erix.success` | now written **unconditionally** (`success !== false`, the same expression the retired top-level `success` used) |

**`erix.success` is always there.** Before the retirement it was written only when the host
or an `onToolResult` hook had actually stated an opinion; with the top-level key gone, a
conditional write would make "succeeded" and "nobody said" indistinguishable, which is
exactly the misjudgement class of issue #234. Read `erix.success` as a boolean, always
present.

**`erix.durationMs` missing means *unknown*, not 0.** It covers exactly one interval — from
just before the executor is invoked until that promise settles or rejects, captured once —
and it deliberately excludes `onToolResult` rewriting, output hygiene and the per-round
aggregate budget. Three states have **no** `durationMs` at all: judge interception (the call
never executed), an interrupted unsafe replay, and an abort before the executor settled.
`?? 0` renders "we do not know" as "it finished instantly". The retired top-level `duration`
did not have that property: it was only self-consistent on one path, which is why the two
numbers legitimately differed during the dual-write period.

**`erix.toolCallKey` is the cross-channel correlation key.** One accepted call gets one key,
allocated once, and it is carried from the first recognizable streaming `onToolCall`
fragment through the `tool_use` block, the `tool_result`, the `onEvent` payload clone and the
display projection. Resume and run-snapshot replay **reuse the persisted value**; a call that
already has an identity never gets a new one. `provider id` / `tool_use_id` remain the
protocol pairing keys — the engine reads them and never rewrites them. `createDisplayProjection`
`toolCalls[]` entries gained `toolCallKey` and `durationMs`, and on records written before T1
both are **absent rather than synthesized**.

**Two side effects worth a look if you own either:**

- Your extension keys named `content` or `is_error` used to be able to overwrite the protocol
  fields of the same name (the flat map was spread last). They can no longer: they now live at
  `metadata.content` / `metadata.is_error` and the protocol fields win. `metadata` and `erix`
  are constructor-owned namespaces. (`type` / `tool_use_id` / `content` / `is_error` are still
  not registered in `TOOL_RESULT_CONTRACT.reserved.topLevelKeys`; tightening that is a separate
  decision.)
- The packaged contract suite's own assertions moved with it: `test/contract/execute-tool.js`
  now asserts a host extension key at `metadata.artifactStatus` and that the top level must
  **not** carry it. A host running the packaged suite against an old-shaped expectation will
  see red — that is this change, not a broken suite.

**What to do.** Grep your host for the five retired names and for any place that reads its
own extension key off a result block's top level, and switch every read to `erix.*` /
`metadata.*` today (that was already the forward-compatible reading during the dual-write
period). If you write result blocks yourself, write into `metadata.*`. Full field-ownership
tables: [host-consumer-contract.md](host-consumer-contract.md), "Tool result fact and field
ownership (issue #284 / #285)" and "onEvent tool event field list (issue #284 / #285)".

## 3. The read side keeps one generation of compatibility

Records written **before** this release still carry the retired top-level names, and every
engine read path is now "engine namespace first, top level only as a fallback for old
records": the TTL request-view folding, the display projection, resume replay (carried back
verbatim — neither recomputed nor back-filled), the "interception is not output" exclusion in
the per-round aggregate budget, the judge timeline and conversation rendering, the L0
objective facts, and `hasSuccessfulToolResult`. Consequences you can rely on:

- a record you wrote in 0.19 with only `erixRound` / `duration` / `executionStatus` at the top
  level is still read correctly by 0.20 — the fallback is real, pinned by reverse tests;
- when **both** spellings are present and disagree, `erix.*` wins. Do not read the top level
  to "see what the engine really thought";
- one generation, not forever: the fallback exists for records already on disk, so migrate
  reads now and do not add new top-level reads.
- one silent bug went away with this flip: the aggregate budget excluded intercepted output by
  checking `block.executionStatus`, a key that was **never written**, so "interception does not
  count as output" had silently stopped working. Both spellings are read now, which also
  protects records written during the T1 dual-write period.

## 4. A stop beats the round judge and the final guard (issue #282 and its follow-up)

Before this release, the terminal `stop` branch derived `termination.reason` from the
governance action and never looked at `signal.aborted`. Two consequences, both measured on
the fake-provider harness in `test/loop-abort-terminal-priority.test.js`:

- press stop in the window where the last round had already answered and the end-turn
  judge had returned, and the run **returned normally** with
  `{ termination: { reason: "judge_done" } }` — no `aborted`, no `partial`, no `usage`,
  no `rounds`. The host could not tell a stopped run from a finished one.
- the engine issued the judge's model request even when the abort had already landed:
  **2 model requests** for a one-round run, one of them pure waste.

Now the priority rule is enforced once, at the terminal decision:
**`aborted` outranks `judge_done` / `final_guard_*`.** The same run above throws with

```
{ reason: "aborted", detail: "user stop", usage: {…}, rounds: 1, partial: true }
```

on the caught error (`error.termination`, plus `error.usage` / `error.rounds` /
`error.finalText` per issue #180), and a run whose signal was already aborted when the
end-turn judge would have started issues **1 model request** — the judge call is skipped
outright, so the stop takes effect immediately instead of after one LLM round trip.

The follow-up to #282 closed the two windows that #282 missed — the two a host under real
load hits most: a judge verdict of `done: false` selects a **nudge**, which `continue`s
without ever entering the `stop` branch (so the loop ran one more main-model round and then
reported `max_rounds_cap` for a run the user had stopped), and the post-loop round-budget
finalization sat **outside** the loop's `try`/`catch`, so an abort landing during that
finalization escaped as a bare `AbortError` with no `termination` at all, or — if the abort
landed inside your `finalGuard` — was reported as `max_rounds_cap`. Both are covered now:

| Stop lands here | Engine | You see |
| --- | --- | --- |
| before the judge starts | judge call skipped | one fewer model request, immediate stop |
| while the judge is in flight | judge interrupted | `aborted` + issue #180 payload |
| after the judge returned, verdict "stop" | reason derivation refuses the judge's verdict | `aborted` + `{usage, rounds, partial:true}`, never `judge_done` |
| after the judge returned, verdict "keep going" (nudge / extend) | round budget is checked before the next round starts | `aborted` + the same payload, never `max_rounds_cap`, and **no further model request** |
| while the post-loop forced-final call runs | the finalization is inside the same error path now | `aborted` **with** the issue #180 payload (before: a bare `AbortError` with no `termination`) |
| while `finalGuard` runs | signal re-checked before the terminal return | `aborted`, never `final_guard_unverified` or `max_rounds_cap` |

**What to do.** If your host switches on `termination.reason`, nothing to change — you now
receive the row you should have been receiving. If it switches on the *absence* of an
exception ("it returned, so it wasn't stopped"), that assumption is the bug: `aborted` has
always been a throw (issue #180), and since this release it is also reachable from places
where it used to be rewritten. Keep the abort payload — `partial: true` means the partial
text is on `error.finalText`, and the usage on the error is the real bill for the stopped
run. One side effect of closing the finalization window: if **your own** finalization callback
(`forceFinalizer`, `finalGuard`) throws, that no longer escapes the whole call as a raw
exception; it becomes a terminal object with `reason: "failed"` and an `errorCode`, the same
posture this package already uses for every other host callback.

## 5. What a stopped run actually leaves behind (issue #283)

The ruling for #283 is **β: the engine does not retroactively write an `interrupted`
round record.** A round is committed when `appendRound` succeeds; a round interrupted
before that point has no round key and may hold `tool_use` blocks with no paired
`tool_result`, which would make the transcript unreplayable for the resume contract.

So `termination.partial: true` names **the payload on the error**, and asserts nothing
about the store. Read each fact from the channel that holds it — the six-row table is in
[host-consumer-contract.md](host-consumer-contract.md), "Where the facts live after an
abort (issue #283)". Short version:

| You want | Read |
| --- | --- |
| rounds that had already finished | the transcript store (untouched by the abort) |
| text already streamed in the interrupted round | the run-snapshot channel: `partialPersistence` + `stream: true` — **off by default, best effort**: committed partial text only, **no reasoning**, possibly nothing at all, up to `intervalMs` stale |
| the partial final text | `error.finalText` — the only guaranteed partial-text channel |
| what the stopped run cost | `error.usage` / `error.rounds` |
| the last judge verdict | the judge-record channel (`onJudge` / `judge.log`, issue #165) |

**What to do.** If your UI shows "the assistant's reply disappeared after stop", the fix is
on your side of the boundary: render `error.finalText`. Turn on `partialPersistence` (with
`stream: true`) only if you also want the in-flight round's committed partial text — it is a
snapshot, not a guarantee, and it never contains reasoning. Do not file a persistence bug for
"zero `RoundRecord` for the last round" — that is the documented shape.

## 6. Tool result shapes are now pinned (issue #220)

`createFileTools().executeTool()` has always returned successful results in four different
top-level shapes. The packaged contract suite used to only *read* those shapes; it now
asserts them, and the package exports a discriminator so you can delete your own
shape-guessing layer:

| Tool | Success shape | `classifyFileToolResult().kind` |
| --- | --- | --- |
| `readFile` | `string` | `text` |
| `edit` | `string` | `text` |
| `writeFile` | `number` (bytes written) | `bytes` |
| `searchText` | `{ content, metadata }` | `content-metadata` |

```js
import { createFileTools, classifyFileToolResult } from "erix-agent/tools";

const result = await tools.executeTool("writeFile", { path: "a.txt", content: "" });
const fact = classifyFileToolResult(result);
switch (fact.kind) {
  case "text": render(fact.text); break;
  case "bytes": billBytes(fact.bytes); break;
  case "content-metadata": render(fact.text); account(fact.metadata); break;
  case "unknown": escalate({ tool: name, value: result }); break;
  default: assertNever(fact.kind); // a fifth shape from upstream fails your compile, here
}
```

`classifyFileToolResult` is exported from the `erix-agent/tools` subpath (not from the
package root, per ADR-005) and its return type is a discriminated union on `kind`, so
`fact.bytes` is a `number` exactly in the `"bytes"` arm. Two traps this closes, both
reported by a real host: `writeFile` returning `0` is a **successful** write of an empty
file (`if (!result)` is wrong), and a bare `typeof result === "string"` is **not** a success
test, because error results are strings too (same top-level shape as `readFile`). Full rule
list: [host-consumer-contract.md](host-consumer-contract.md), "Success result shapes (issue
#220)".

## 7. `erix.executionStatus` exists only in special states (issue #286 follow-up)

In one line: **some hosts read the top-level `executionStatus` as always present → as of
0.20.0 it is not at the top level at all, and inside `erix.*` it exists only in the two
special states (`intercepted` = audit interception, `interrupted` = resume rewrite). On an
ordinary success or failure result block the field is absent (`undefined`) — not an empty
string, not an `ok` placeholder.**

| | Old (the 0.19 misreading) | New (what is now pinned) |
| --- | --- | --- |
| Location | top-level `executionStatus` | only `erix.executionStatus` (the flattened top-level key is retired, section 2) |
| Presence | read as "on every result block" | conditional: only the two special states `intercepted` / `interrupted` |
| Machine-readable condition | not recorded anywhere | `TOOL_RESULT_CONTRACT.engine.fields.executionStatus.writtenFor === "special states only"` plus `presentValues: ["intercepted", "interrupted"]` (`src/tool-fact.js`) |
| Assertion shape | "check it if it is there" | `Object.hasOwn(block.erix, "executionStatus") === false` (the packaged `toolResultEnvelopeContract` asserts the absence unconditionally on ordinary blocks) |

Engine behaviour did not change here — what changed is that the constant surface no longer
invites the wrong reading. If your host branches on "status present" to mean "this block is
interesting", switch to comparing the value against the two special states.

## 8. CLI exit code 4, and what is not in the tarball

`erix run` now distinguishes "verification passed" from "verification never ran"
(`bin/cli.js`, `exitCodeForVerification`):

| Exit code | Meaning |
| --- | --- |
| 0 | finished and verification accepted the final answer |
| 2 | `verification.status === "unverified"` |
| 3 | `verification.status === "error"` |
| **4** | `verification.status === "skipped"` — verification did not execute (no archived output, or nothing verifiable in it) |

A CI wrapper that maps only 0/1/2/3 will treat "nobody actually checked" as success or as a
crash; add the 4 arm.

`package.json`'s `files` allowlist publishes `src`, `bin`, `skills`, `docs` and the
`test/contract/*.js` suites — **`examples/` and `scripts/` are not in it**, so nothing in
those two directories is present in an installed package. `require`ing or importing a path
under `examples/` (for instance the `erix_run` progress formatter) works inside this
repository and fails after install: copy the code you need, or run the packaged contract
suites via `erix-agent/contract-tests`.

## 9. Self-check

1. `grep -rn "erixRound\|\.duration\b\|executionStatus\|\.success\b\|toolCallKey" <your host>`
   — every hit must read `erix.round` / `erix.durationMs` / `erix.executionStatus` /
   `erix.success` / `erix.toolCallKey`, not the top level (sections 2 and 3).
2. `grep -rn "<your own extension key>" <your host>` — a key you put on a result block must be
   read from `metadata.*`, and `durationMs` absence must not be collapsed into `0` (section 2).
3. `grep -rn "judge_done" <your host>` — every hit must be reachable only when
   `signal.aborted` was not set (issue #282 及其漏网补口, section 4).
4. `grep -rn "partial" <your host>` — anywhere that reads `termination.partial` must read
   `error.finalText` for the text, not the transcript store (issue #283, section 5).
5. `grep -rn "typeof result\|String(result)\|\[object Object\]" <your host>` — replace ad-hoc
   shape handling with `classifyFileToolResult` and an exhaustive switch (issue #220, section 6).
6. `grep -rn "examples/" <your host>` — nothing may depend on a path that the tarball does not
   ship (section 8).
7. Run the packaged suites against your adapters (`erix-agent/contract-tests`); the
   `fileToolsContract` suite now contains the four shape assertions, and
   `toolResultEnvelopeContract` now refuses the retired top-level names.

## 10. What did not change

No option name and no method signature moved. `TranscriptStore`'s methods and the top-level
`RoundRecord` shape are unchanged, and the two protocol converters still emit exactly the
wire fields they always did (`type` / `tool_use_id` / `content`, plus `is_error` when the
result is an error or was interrupted) — `erix.*` and `metadata.*` never go on the wire.
`end_turn` remains the normal success exit, and `judge_done` remains reachable for every run
that was not stopped. Hosts pinning exact `deepEqual` on a terminal object need no change
unless they exercised the abort-inside-a-value-added-call path. Chinese version of this
guide: [host-upgrade-guide-0.20.0_cn.md](host-upgrade-guide-0.20.0_cn.md); the contract
itself is [host-consumer-contract.md](host-consumer-contract.md) with
[host-consumer-contract_cn.md](host-consumer-contract_cn.md) as its synchronized Chinese
counterpart.
