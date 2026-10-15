# Host upgrade guide: 0.20.0

This guide covers the changes a host has to **act on** in 0.20.0: the three release
blockers around what a stopped run means and what a tool result looks like
(issue #282, issue #283, issue #220). `CHANGELOG.md` remains the complete list; if a
section below does not describe your code path, that section is a no-op for you.

Nothing here changes an option name, a method signature, or a stored format. Two of the
three changes are observable in a terminal outcome, and one is observable in a tool
result. The package still has zero npm runtime dependencies, is still pure ESM, and still
requires Node 22.

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| `aborted` now outranks `judge_done` and `final_guard_unverified` at the terminal decision (issue #282) | treats "no exception, reason `judge_done`" as proof the run was not stopped | 2 |
| An aborted run writes **no** transcript record for the round that was in flight, and `termination.partial` describes the payload, not the store (issue #283, ruling = β) | reads "partial results" out of the transcript store, or files a bug when a stopped run has zero records for its last round | 3 |
| The four success return shapes of `createFileTools().executeTool()` are pinned by the packaged contract suite (issue #220) | nothing breaks; hosts gain a discriminator instead of a hand-written shape-guessing layer | 4 |
| `TOOL_RESULT_CONTRACT` now records the **existence condition** of `erix.executionStatus` (issue #286 follow-up); the engine behaviour itself is unchanged | a host read only the constant and assumed every result block carries `erix.executionStatus` | 5 |

## 2. A stop beats the round judge and the final guard (issue #282)

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

**What to do.** If your host switches on `termination.reason`, nothing to change — you now
receive the row you should have been receiving. If it switches on the *absence* of an
exception ("it returned, so it wasn't stopped"), that assumption is the bug: `aborted` has
always been a throw (issue #180), and since this release it is also reachable from places
where it used to be rewritten. Keep the abort payload — `partial: true` means the partial
text is on `error.finalText`, and the usage on the error is the real bill for the stopped
run.

Behaviour of the two value-added calls at a stop, in one table (full version:
[host-consumer-contract.md](host-consumer-contract.md), "Value-added calls before the
terminal decision (issue #282)"):

| Stop lands here | Engine | You see |
| --- | --- | --- |
| before the judge starts | judge call skipped | one fewer model request, immediate stop |
| while the judge is in flight | judge interrupted | `aborted` + issue #180 payload |
| after the judge returned | reason derivation refuses the judge's verdict | `aborted` + `{usage, rounds, partial:true}`, never `judge_done` |
| while `finalGuard` runs | signal re-checked before the terminal return | `aborted`, never `final_guard_unverified` |

## 3. What a stopped run actually leaves behind (issue #283)

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
| text already streamed in the interrupted round | the run-snapshot channel: `partialPersistence` + `stream: true` — **off by default** |
| the partial final text | `error.finalText` |
| what the stopped run cost | `error.usage` / `error.rounds` |
| the last judge verdict | the judge-record channel (`onJudge` / `judge.log`, issue #165) |

**What to do.** If your UI shows "the assistant's reply disappeared after stop", the fix is
on your side of the boundary: render `error.finalText`, or turn on `partialPersistence`
(and `stream: true`) if you need the in-flight round's partial text rather than the final
draft. Do not file a persistence bug for "zero `RoundRecord` for the last round" — that is
the documented shape.

## 4. Tool result shapes are now pinned (issue #220)

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

Two traps this closes, both reported by a real host: `writeFile` returning `0` is a
**successful** write of an empty file (`if (!result)` is wrong), and a bare
`typeof result === "string"` is **not** a success test, because error results are strings
too (same top-level shape as `readFile`). Full rule list:
[host-consumer-contract.md](host-consumer-contract.md), "Success result shapes (issue #220)".

## 5. `erix.executionStatus` exists only in special states (issue #286 follow-up)

Old → new, in one line: **before 0.19 some hosts treated the top-level `executionStatus` as
always present → as of 0.20.0 it is not at the top level at all, and inside `erix.*` it exists
only in the two special states (`intercepted` = audit interception, `interrupted` = resume
rewrite). On an ordinary success or failure result block the field is absent (`undefined`) —
not an empty string, not an `ok` placeholder.**

| | Old (the 0.19 misreading) | New (what is now pinned) |
| --- | --- | --- |
| Location | top-level `executionStatus` | only `erix.executionStatus` (the flattened top-level key is retired) |
| Presence | read as "on every result block" | conditional: only the two special states `intercepted` / `interrupted` |
| Machine-readable condition | not recorded anywhere | `TOOL_RESULT_CONTRACT.engine.fields.executionStatus.writtenFor === "special states only"` plus `presentValues: ["intercepted", "interrupted"]` (`src/tool-fact.js`) |
| Assertion shape | "check it if it is there" | `Object.hasOwn(block.erix, "executionStatus") === false` (the packaged `toolResultEnvelopeContract` asserts the absence unconditionally on ordinary blocks) |

Engine behaviour did not change here — what changed is that the constant面 no longer invites the wrong
reading. If your host branches on "status present" to mean "this block is interesting", switch to
comparing the value against the two special states.

## 6. Self-check

1. `grep -rn "judge_done" <your host>` — every hit must be reachable only when
   `signal.aborted` was not set (issue #282).
2. `grep -rn "partial" <your host>` — anywhere that reads `termination.partial` must read
   `error.finalText` for the text, not the transcript store (issue #283).
3. `grep -rn "typeof result\|String(result)\|\[object Object\]" <your host>` — replace ad-hoc
   shape handling with `classifyFileToolResult` and an exhaustive switch (issue #220).
4. Run the packaged suites against your adapters (`erix-agent/contract-tests`); the
   `fileToolsContract` suite now contains the four shape assertions.

## 7. What did not change

No option or method signature moved; no stored format moved; `end_turn` remains the normal
success exit, and `judge_done` remains reachable for every run that was not stopped. Hosts
pinning exact `deepEqual` on a terminal object need no change unless they exercised the
abort-inside-the-judge-window path. Chinese version of this guide:
[host-upgrade-guide-0.20.0_cn.md](host-upgrade-guide-0.20.0_cn.md); the contract itself is
[host-consumer-contract.md](host-consumer-contract.md) with
[host-consumer-contract_cn.md](host-consumer-contract_cn.md) as its synchronized Chinese
counterpart.
