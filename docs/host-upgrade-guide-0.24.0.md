# Host upgrade guide: 0.24.0

**This is the "the runtime stops guessing on your behalf" release.** 0.23.0 changed *where the body of a
run lives*; 0.24.0 changes *what the engine tells you about its own work*: the state file now says how much
of its own compaction ledger it kept, the two persistence-failure exits carry the **same keys with the same
value types**, and the tool outputs that used to be silently wrong (or silently rewritten) now say what
actually happened. Nothing is removed, nothing is renamed, no store method signature moved, and the
runtime still has **zero** npm dependencies.

**Three of the changes are additive information; the tool-output ones are model-visible text.** Nothing here breaks a host
that compiles today — but a host that asserts on tool output text, or that reads `err.unpersisted` /
`err.cause` by guessing, will *see* the difference, and it should: those reads are now well-defined instead
of "works if you read the source". If a section below is not your code path, it is a no-op for you;
`CHANGELOG.md` stays the complete list.

## 1. Change summary

| Change | Do you have to act |
| --- | --- |
| `<runId>.state.json` reports `deterministic.compactionStatsWindow = { limit, dropped, total }` (§2) | no — additive; old files simply do not have it |
| `checkpoint_failed` now carries `cause` / `errorCode` / `unpersisted`, same names **and same value types** as `persistence_failed` (§3) | no — but stop parsing `message` strings, and re-check any `Array.isArray` / `err.cause.message` probe |
| `tree` on a non-root target: the first line is the **relative path**, not the basename (§4) | yes, if you compare tool output text or replay it |
| `readFile` now emits `[参数校正：…]` when it rewrote your arguments and `[已到末尾：…]` instead of an empty string (§5) | yes, if you assert on `readFile` output |
| `rg` / `grep` / `searchText`: a search root that does not exist is an **error text**, not `（无命中）`; the `rg`/`grep` deprecation line names *your* mode (§6) | yes, if you compare tool output text |
| The tarball now ships `test/helpers/tmp.js`; three gate-side changes landed (§7) | no — packaging and gates only |
| `finalGuard` now receives 10 additive facts (`cwd`, `runId`, `filesWritten`, `toolStats`, `taskBrief`, `selfReport`, `usage`, `elapsedMs`, `attempt`, `guardBudget`) next to the original 7 keys (§8) | no — additive; act only if you were re-parsing `messages` or guessing from `finalText` |
| New `deliverables` option + payload key `fileWrites`: host-declared machine criteria, checked before **every** guard call; a failing criterion turns a guard's `accept` into `unverified` / `deliverables_failed` (§9) | no — opt-in; act if your guard does its own disk checks today |
| New `finalGuardExtend` option (**default `false`**): a `revise` on `max_rounds_cap` / `continuation_exhausted` buys at most one more round per run; `stall` never extends (§10) | no — opt-in, and off by default keeps every budget-type stop byte-for-byte as in 0.23.0 |

The one-line version: **the facts you used to infer are now written down.** The engine did not change what
it *does*; it changed what it *says* — in the state file, in the error objects, and in the tool outputs the
model reads.

## 2. `<runId>.state.json` now reports its own compaction window

**Symptom.** `deterministic.compactionStats` in `<runId>.state.json` has always been a **tail**: the state
file keeps only the last `COMPACTION_STATS_STATE_LIMIT` (`src/compact/pipeline.js`) entries — value `32` —
because the file has a size budget. The field name said nothing about that, so a host that counted
compaction savings by reading the state file was reading a truncated ledger on exactly the long runs where
counting matters — and could not tell "there were 30" from "there were 300".

**What is new.** `compactionStatsWindow` (`src/run-state.js`) is written next to the array:

| Field | Meaning |
| --- | --- |
| `limit` | how many entries the window holds (still `32`; the size budget did not move) |
| `dropped` | how many entries were dropped (`max(0, total − limit)`) |
| `total` | how many entries this run actually produced |

So `total > limit` (⇔ `dropped > 0`) means "what you are holding is a tail". `dropped === total − limit`
holds whenever `dropped > 0`, and `dropped === 0` otherwise.

**Three boundaries worth knowing.**

- **It only appears when `total > 0`.** A run with no compaction statistics has nothing to truncate, so the
  key is absent rather than a row of zeros — absence is not ambiguity here.
- **The second truncation keeps the books honest.** When the serialized state still exceeds
  `RUN_STATE_MAX_SERIALIZED_BYTES` (`src/run-state.js`) — 64 KiB — the array is cut again to
  `COMPACTION_STATS_SERIALIZED_LIMIT` (`src/run-state.js`) — 8 entries — and the window is rewritten with
  `limit: 8` and a recomputed `dropped`/`total`. You will never see "8 entries, ledger says 32".
- **The run's return value is still the full list.** `runToolLoop`'s `compactionStats` was never truncated
  and is not now; only the state file is.

**Reading old files.** `validateRunState` (`src/run-state.js`) accepts a state file **without** the field
(it is not a bad file), and only rejects a file that *has* it with a broken shape. Old ledgers validate and
resume exactly as before — measured in this release's tests, not assumed.

**Fix.** Nothing to fix. If you were compensating for the truncation by re-reading the transcript or by
counting `compaction` events, you can read `compactionStatsWindow.total` instead — and if you want to know
whether you have the whole ledger, compare `dropped` with `0`.

## 3. `checkpoint_failed` and `persistence_failed` now match — in names *and* value types

**Symptom.** One underlying failure (a run-snapshot write failing) has two exits. The one at the end of a
run, `persistence_failed`, carried the root cause and the list of what was not persisted; the one at a tool
call site, `checkpoint_failed`, carried only `operation` / `persistence` / `persistenceError` plus its own
`phase` / `sideEffect`. A host that sorts "can I resume?" from "do I replay?" had to parse the latter's
`message` string — the exact anti-pattern issue #176 was opened to kill.

**What is new.** Both exits now carry all three fields, and — this is the part to read twice — **with the
same value types**:

| Field | Type | What it is |
| --- | --- | --- |
| `cause` | **`Error` object** (not a string) | the underlying failure; on `checkpoint_failed` it is the deepest link of the chain, i.e. the error the store itself threw |
| `errorCode` | **string** | same classification as `termination.errorCode`, produced by `terminationErrorCodeForError` (`src/loop/termination.js`): the root cause's own `code`, or `"unknown"` |
| `unpersisted` | **raw array** | the same shape `persistence_failed` has always had (`errorLedger.toUnpersisted()`), so `err.unpersisted.length` reads the same on both |

`assertSnapshotPersisted` (`src/loop/run-snapshot-executor.js`) writes the tool-call-site side;
`makePersistenceFailure` (`src/loop/orchestrator.js`) writes the run-end side. Both write all three
**unconditionally**, and both put `cause` in through `KitError`'s `{ cause }` option, so on both exits
`cause` is a **non-enumerable** own property — `Object.keys(err)` and `{ ...err }` agree.

**What did *not* change.** Error codes, the `phase` / `sideEffect` semantics, the fail-closed early-exit
conditions and the public export surface are untouched. The `{ count, items }` projection stays where it
belongs — `deterministic.errors.unpersisted` inside `<runId>.state.json`. It is **not** used for error
objects; there is exactly one shape per place.

**How to tell whether you are affected.** Grep your host for `err.message.includes(` near
`checkpoint_failed` / `persistence_failed`, for `typeof err.cause === "string"`, and for
`err.unpersisted.count`. The first two are now unnecessary (and the second is now *wrong*); the third was
always wrong on the error object.

**Fix.** `Array.isArray(err.unpersisted)`, `err.cause.message` / `err.cause.code`, `err.errorCode`. If you
were string-matching to decide "retry or replay", switch to `errorCode` — it is the same classification the
engine's own termination payload uses, so one reader covers both.

## 4. `tree` on a non-root target now prints a replayable relative path

**Symptom.** The root label was fixed in 0.23.0 (`tree` on the working-directory root always prints `./`,
however you spelled the path). A **non-root** target still went through `path.basename`, so
`tree { path: "nested/sub" }` printed `sub/` on its first line. That looks replayable and is not: two
directories named `sub` under different parents print the same first line, and an absolute input throws the
whole parent chain away.

**What is new.** The first line is `displayName` (`src/tools/file-tools.js`) — the path **relative to the
tool's working directory** — so `nested/sub/` for the call above. Copy that line back into `path` (minus the
trailing slash) and you get the same tree. The root case is unchanged (`./`), and so are entries, depth /
entry-cap markers and the skip account.

**How to tell.** If you parse `tree` output, look for code that treats the first line as a directory *name*
(e.g. `lines[0].replace("/", "")` then `path.join(someParent, name)`). That now produces a doubled path.

**Fix.** Use the first line as `path` verbatim, or stop parsing it — it is a label, and its only contract is
"feeding it back gets you the same tree".

## 5. `readFile` says when it rewrote your arguments, and no longer answers "nothing" at EOF

**Symptom.** Two silent behaviours, both of which made the model's view of the file wrong:

- `offset: "120"` (a numeric string) was treated as non-numeric and fell back to `0`; `offset: -5` was
  clamped to `0`; `limit: 1.9` was floored; an out-of-range `max_bytes` fell back to the default. Four
  rewrites you could not read out of the output — and since the fallbacks happened to equal the defaults,
  "I changed it" and "you asked for it" were byte-identical.
- An `offset` past the end of the file returned an **empty string**, which is indistinguishable from "the
  file is empty".

**What is new.** `toolMarker` (`src/tools/file-tools.js`) now renders two markers on the read path:

- `[参数校正：<original> … 已按 <effective> 处理；…重传 readFile 并传整数 <names>]` — emitted only when
  something was actually rewritten, and it reports the original value as a JSON literal (so a numeric string
  and a number are distinguishable), the effective value, and how to re-send it.
- `[已到末尾：offset=<N> 越过文件末尾（共 <total> 行，最后一行 offset=<last>），本次无新内容]` — emitted
  instead of the empty string.

**Semantics did not change.** Normalisation and clamping produce exactly the same values as before; the
markers only report. The contract suite carries the reverse control: a normal call must contain **neither**
marker.

**Fix.** If you assert on `readFile` output, either ignore the trailing marker lines or pass integers. Do
not "fix" a marker by stripping it before showing the file to the model — the marker is the only signal that
the text you are showing is not the slice that was asked for.

## 6. `rg` / `grep`: a missing search root is an error, and the deprecation line names your mode

**Two separate text changes, same family: the output used to be silently wrong.**

**6a. A search root that does not exist is no longer `（无命中）`.** `searchText` / `rg` / `grep` on
`path: "nope"` used to answer "no matches", which the model reads as "this repository does not contain it" —
a false negative with no error signal (`metadata.searchFiles = 0` only reaches the transcript, never the
wire). `searchRootError` (`src/tools/file-tools.js`) now checks the caller's own root *after* the read
boundary check (an out-of-jail path must not learn whether it exists) and returns an error **text** — same
channel as the jail denial and the invalid-regex result, still not a throw:

- root missing (or `ENOTDIR`): `错误：路径不存在：<path>（相对路径按工具根目录解析；先用 tree 确认要搜的目录是否存在）`
- root unreadable (any other code): `错误：读不到 <path>（<code>）：先用 tree 确认这个路径可读`

The three cases stay strictly separated: root exists but nothing matched is still `（无命中）`; `path`
pointing at a **file** still searches just that file.

**6b. The `rg` / `grep` deprecation line now names the mode your call actually used.** The line used to say
`请改用 searchText with mode="regex"` unconditionally — including for `rg { is_regex: false }`, whose
semantics are **literal**. `literal` does not interpret metacharacters and `regex` does, so following that
advice on `a.b` / `\d+` / `(x)` silently changed the match set. Since `searchText.mode` is required with no
default, that line is the model's only migration hint. `withDeprecation` (`src/tools/file-tools.js`) now
builds it from `toolMarker` (`src/tools/file-tools.js`) using the values of *this* call:

- `rg` → the mode its alias mapping really used (`literal` for `is_regex: false`, `regex` otherwise);
- `grep` → `regex` by default (it is `grep -E`), `literal` for `is_regex: false` (that is `grep -F`);
- `name_pattern` is only mentioned when this call actually passed `glob`.

**Fix.** If you compare tool output text byte-for-byte, re-baseline those two lines: they are deliberately
different, and the new ones are the true ones. If you were using `（无命中）` as a "path probably wrong"
signal, you now get an actual error text — treat it as one.

## 7. Packaging and gates (no runtime change)

**7a. `package.json`'s `files` now includes `test/helpers/tmp.js`.** The packaged contract suites
(`test/contract/file-tools.js` / `skills-loader.js`, re-exported as `erix-agent/contract-tests`) now import
`../helpers/tmp.js`, so without that file a host running the shipped suites gets
`ERR_MODULE_NOT_FOUND`. The tarball is otherwise unchanged in shape; `README` / `README_cn`'s `files` fence
follows `package.json` verbatim.

**7b. `npm run check:types -- --with-tools` baseline is 153** — `BASELINE_WITH_TOOLS` (`scripts/type-check-ratchet.mjs`);
the package-root entry is 117, and the union is `117 + 20 + 16` over 31 files. `src/tools/file-tools.js` is down to 20
errors from 27 — the tree/marker narrowing and the read-side honesty work (the `editDiffTruncated` cause joining that
union) knocked them out as a side effect; no error was suppressed to reach the number.

**7c. `node scripts/docs-drift-check.mjs --self-test` is decoupled from this machine's local task archive**
(`docs/tasks/`, untracked and never committed). Its tree-shape cases now run against a synthetic fixture
instead of counting real local archives, so the same commit is green on a fresh clone / CI / a machine whose
local archive (`docs/tasks/`, never committed) is empty. CI therefore runs it as a **blocking** step (the
`continue-on-error` it used to carry is gone).

**7d. The test-hygiene guard is blocking.** `npm run check:tests` now **fails** on any `mkdtemp` /
`mkdtempSync` call in `test/**` outside `test/helpers/tmp.js` (the shared helper is
`makeTmp` (`test/helpers/tmp.js`)), instead of printing a hint. A per-line exemption exists
(`test-hygiene-exempt: <reason>` on the call line or the line above, with a mandatory reason); the tree
currently has zero exemptions. This is repository hygiene — it never runs in your host.

## 8. `finalGuard` now receives the run's facts, not just the transcript (issue #386)

**Symptom.** The guard callback is the only *toothed* check the engine has — it can turn a
claim into `verified`, or force a `revise` and, at the retry limit, replace the terminal
reason with `final_guard_unverified`. Yet its payload carried exactly seven keys
(`finalText`, `findings`, `messages`, `round`, `rounds`, `signal`, `termination`). None of
the facts an acceptance decision needs — which files were written, which tools ran and how
often they failed, what the task actually was, what the model claimed, how much the run
cost, which guard attempt this is — were in it. So a host either re-parsed `messages` (611
bytes on a toy run, tens of KB to MB on a real one) or graded the answer on `finalText`.

**What is new.** Ten additive keys, each written only when the engine can actually read that
fact (absence = "not probed", never `null`/`0`/`""`):

| Key | What it gives you | Bound |
|---|---|---|
| `cwd` | the host's `cwd`, verbatim — new option `runToolLoop({ cwd })`, passed through only | none |
| `runId` | the host's `runId`, verbatim | none |
| `filesWritten` | `[{ path, round }]` — write-tool calls this run recorded | last 50 (`filesWrittenTruncated`) |
| `toolStats` | `{ [toolName]: { calls, failures } }` as a **plain object** | top 40 (`toolStatsTruncated`) |
| `taskBrief` | the brief the judge and wrap-up saw | 2000 code points (`taskBriefTruncated`) |
| `selfReport` | the model's last **normalized** wrap-up: `{ done, summary, output, findings }` | `summary`/`output` 2000 each |
| `usage` | run-cumulative usage | none |
| `elapsedMs` | wall-clock ms since the loop started | none |
| `attempt` | which guard call this is, 1-based, monotonic across `revise` | none |
| `guardBudget` | the `finalGuardMaxRetries` in force | none |

The full table, the truncation markers, and the absence semantics live in the contract:
`### The `finalGuard` payload: 7 contract keys plus 10 additive facts (issue #386)`
(`docs/host-consumer-contract.md`).

**How to use it for machine-checkable acceptance.** Three shapes that used to be impossible:

1. **File-or-nothing.** Accept only when the deliverable exists *and* its content matches —
   `fs.statSync(path.join(payload.cwd, expected))` — and use `payload.filesWritten` to tell
   "the model never even tried to write" apart from "it wrote the wrong thing". `attempt`
   then tells you whether you are looking at the first claim or a post-`revise` retry.
2. **Claim-versus-evidence.** `payload.selfReport.findings` is the *same object* as
   `payload.findings`: every declared `label -> value` the model claims can be diffed against
   a value you computed yourself. If the envelope declared nothing, both keys are absent —
   that is "the model skipped the declaration step", which is not "nothing to verify".
3. **Cost and retry accounting.** `payload.usage` + `payload.elapsedMs` + `payload.attempt`
   let a host log the price of each guard round trip (each `revise` is one more model round
   trip) without instrumenting the provider, and `payload.toolStats` gives the failure ratio
   per tool for a "the run was thrashing" signal.

**Three traps this release does not remove — read them before you trust the keys.**

- **`finalText` is still not evidence.** A guard that accepts when `finalText` is non-empty
  returns `verified` for a run whose deliverable does not exist. The probe ships that
  counter-example as a scenario (`S6`), next to the disk-checking guard that catches the same
  lying script at `attempt: 1` and remediates it at `attempt: 2`.
- **`filesWritten[].path` is a 40-code-point prefix of a summarized argument, with no
  truncation marker.** It comes from the judge timeline (`summarizeArgument`
  (`src/reflection/judge.js`)), so long paths are silently shortened. Use it as a hint; the
  authoritative path is the tool result in `messages` or the file you stat under `cwd`.
- **`cwd` is never interpreted by the engine.** No `chdir`, no existence check, no path
  joins — it is a pass-through so that *your* guard does not have to be told the directory
  out of band. A non-string value throws `TypeError: cwd must be a string`.

**Verify it without spending a token.** `node scripts/final-guard-probe.mjs` (also
`npm run check:final-guard-probe`) drives the whole surface with a scripted fake provider:
payload keys and per-key bytes, fake-completion → `revise` → remediation, retry exhaustion,
guard throw, guard timeout, the rubber-stamp trap, and the overhead bound (30 rounds × 4 KB
tool output: `messages` 257,618 B vs additive keys 2,242 B = **0.87%**, budget < 2%). Every
scenario **asserts**; the process exits non-zero if the semantics move.

**Do you have to act?** No. The seven original keys keep their names, types, order, and
values; the verdict semantics (`accept` / `skip` / `revise` / retry limit / fail-closed) are
untouched. If you were re-parsing `messages` to recover any of the facts above, you can
delete that code — that is the point of the slice.

## 9. Build `accept` on disk facts: `deliverables` + `fileWrites` (issue #386 slice 2, #388)

**Symptom.** §8 handed the guard the run's facts, but the engine still had no opinion about
them: a guard that accepts whenever `finalText.trim() !== ""` keeps returning `verified` for a
run whose deliverable does not exist. Facts without a gate are an invitation, not a check.

**What is new.** Two additions, both purely additive:

1. **`fileWrites`** (issue #388) — the payload's raw-path companion to `filesWritten`:

   | Key | Value | Safe to `stat()`? |
   |---|---|---|
   | `filesWritten` | `[{ path, round }]`, `path` = the judge timeline's `summarizeArgument` output — **40 code points, no truncation marker** | **no**: a long path is silently cut, so `existsSync()` on it fails for a run that did write the file |
   | `fileWrites` | `[{ path, round, tool }]`, `path` = the verbatim `tool_use.input[pathKey]` value | **yes** — this is the key a criterion must read |

   Both are capped by the **same** constant (`FILE_LEDGER_LIMIT`, 50 entries, newest kept) and
   both carry a truncation marker (`filesWrittenTruncated` / `fileWritesTruncated`). Use
   `filesWritten` when you want a human-readable hint; use `fileWrites` when the answer must
   be exact.

2. **`deliverables`** — the host declares what "delivered" means, the engine decides when it
   is checked and what a failure costs:

   ```js
   runToolLoop({
     // … your usual options …
     deliverables: [{
       name: "report",
       // `facts` is the payload the guard is about to receive (attempt/rounds/cwd/fileWrites/…).
       check: ({ cwd, fileWrites }) => {
         const target = path.join(cwd, "report.md");
         const wrote = fileWrites.some((write) => write.path === target);
         return { ok: wrote && fs.existsSync(target), detail: wrote ? "missing on disk" : "never written" };
       },
     }],
   });
   ```

   At most 20 criteria, `{ name: string, check: function }`, unique names, `TypeError`
   otherwise. `check` may be async. Two fail-closed rules: **a throw is `ok:false` +
   `detail:"threw"`, and exceeding `finalGuardTimeoutMs` is `ok:false` + `detail:"timeout"`**
   — a broken or hanging criterion blocks, it never passes. Returning anything that is not
   `true` / `false` / `{ ok: boolean }` is `ok:false` + `detail:"invalid_result"`, so
   `return "ok"` cannot be mistaken for a pass.

**The gate.** Criteria are re-checked **before every guard call** (so a `revise` →
remediation → second attempt really can reach `verified`), and when any criterion fails a
guard's `accept` yields `verification.status === "unverified"` with
`reason: "deliverables_failed"`. That is the whole point: machine evidence outranks the
guard's opinion. `termination.reason` is **not** rewritten (no new stop reason, and
`final_guard_unverified` keeps its meaning), non-continuable stops still degrade to
`non_continuable`, and `verification.metrics` gains `deliverables_checked` /
`deliverables_failed` next to the five existing counters.

**Zero regression when undeclared.** Omit `deliverables` (or pass `[]`) and nothing changes:
no payload key, no metric key, no event field, no verdict. The regression anchor in
`test/loop-deliverables.test.js` compares `verification`, `verification.metrics`, and the
payload key set byte-for-byte against the pre-slice behaviour.

**CLI.** `erix chat --require-deliverable [<path>]` is **off by default**, so the exit-code
promise (`0` verified / `2` unverified / `3` error / `4` skipped) is unchanged unless you ask
for it. It is repeatable and carries **two semantics** (issue #391) — pick by *whether you
give it a path*, not by "how strict you feel":

- **bare** (`--require-deliverable`) — "every path this run **declared it wrote** must still
  exist on disk" (`createDeliverableChecks`, reads `fileWrites`). A run that declared nothing
  passes vacuously, so this says "did not lie", not "did the work".
- **with a path** (`--require-deliverable report.md`, or `--require-deliverable=report.md`;
  repeatable) — "**these files this task demanded** must exist on disk"
  (`createNamedDeliverableChecks`, one criterion per path, relative paths resolved against
  `cwd`). A model that called no tool at all still fails. "This task must deliver
  `report.md`" can only be expressed this way. Up to 20 criteria in total
  (`DELIVERABLES_LIMIT`), names unique, `bad_params` / `exit 1` otherwise.

Three things changed in issue #391 (host adoption):

- **It must be used together with `--final-guard`** (or `ERIX_FINAL_GUARD=1`). The criterion is
a *gate on the guard's `accept`*; with no guard there is no gate, so `--require-deliverable`
alone used to be a silent no-op. It is now a **usage error** (`exit 1`, the message names both
flags and the reason). That one combination changes behaviour: `exit 4` → `exit 1`.
- **The run's working directory is now wired**: `erix chat --cwd <dir>` (default: the process
working directory, must be an existing directory or it is a usage error). `cwd` is the value
the `deliverables` / `finalGuard` payload carries, so the recipe above (`path.join(cwd, …)`)
works out of the box. `erix repl` passes the process working directory; `erix_run` passes its
own required `cwd` parameter.
- **Named paths are a host parameter, not a predicate.** The pi extension exposes
`deliverablePaths: string[]` next to `requireDeliverable: true`, and neither the CLI nor the
extension accepts a host-supplied `check` function (a function cannot cross the extension/tool
boundary safely). Both spellings share one implementation: `bin/final-guard.js`.

**Host-side `cwd` (issue #391).** `runToolLoop({ cwd })` has existed since §8 as a pure
pass-through. What was missing was *the hosts using it*: the CLI, the REPL and the `erix_run`
extension all built their options without `cwd`, so §9's criterion received `undefined` and
`path.join(undefined, "report.md")` threw on every accept — a permanent
`unverified:deliverables_failed` that looked like "the deliverable is missing". If you copied
§9 into your own host and it never verified, check that you pass `cwd`; the engine never
fills it in for you.

**Do you have to act?** No, but if your guard currently does its own disk checking, move that
check into `deliverables` and let the engine enforce it: then a future guard rewrite cannot
silently turn the check back into a rubber stamp.

## 10. Budget-type stops can buy one more round: `finalGuardExtend` (issue #386 slice 3)

**Symptom.** A run whose `maxRounds` budget runs out while the model is still calling tools
ends `max_rounds_cap` → `verification: { status: "unverified", reason: "non_continuable" }`.
The guard saw exactly what was missing and answered `revise`, and nothing happened: on the
three non-continuable reasons the engine had no continuation to spend (§8's `E4` cell).

**What is new.** One option, **off by default**:

```js
runToolLoop({ finalGuardExtend: true, /* … your usual options … */ });
```

With it on, a `revise` verdict on `max_rounds_cap` / `continuation_exhausted` borrows the
engine's **existing** mid-run extension mechanism — `extensionAllowed`
(`src/reflection/governor.js`), applied by `applyGovernorExtension`
(`src/loop/orchestrator.js`) — for **at most one extra round per run**, and then the loop
resumes. `stall` is **never** extended — a stall *is* "no progress", so granting it rounds
only burns budget. The remaining conditions: your opt-in, a `revise` verdict (never `accept`
/ `skip` / guard error), extension headroom from the **same** counters the mid-run extension
reads, and no budget already breached (last real API input over `context.budgetTokens`, or
the per-round aggregate output budget having archived/stubbed a result in this run).

**What you will see.** A `{ type: "final_guard_extend", round, from_max_rounds,
to_max_rounds, guard_extension: true }` event and `verification.metrics.guard_extensions: 1`
— both **only** when a bridge actually ran, so an opted-out (or opted-in but never bridged)
run keeps today's `verification` / `metrics` byte for byte. The quota lives in run state
(`deterministic.guardExtension.used`, restored by `src/loop/resume-manager.js`) and is **not**
reset by resume, so "run → crash → resume" cannot mint a second one. `termination.reason`
values are unchanged, and a bridged run may carry `forcedFinal: true`: the forced wrap-up of
the first stop did run, then the loop continued.

**Do you have to act?** No. Leave `finalGuardExtend` alone and every budget-type stop behaves
byte-for-byte as in 0.23.0. Turn it on only when your guard's `revise` messages are specific
enough that one more round plausibly closes the gap — that is the only thing the bridge buys.

## 11. Self-check

```bash
npm test                       # 1,895 tests, 0 failing (1,886 passing + 9 skipped)
npm run check:docs && npm run check:docs:strict
npm run check:final-guard-probe # offline, zero model calls; asserts the finalGuard payload surface
npm run check:release          # packs, installs into a throwaway project, runs the shipped contract suites
```

Against your own host, seven questions are worth answering with a test before you upgrade:

1. **State file.** Take a run with more than 32 compaction entries: `compactionStatsWindow.total` equals
   the full count, `dropped === total − 32`, and an **old** state file (no window key) still validates and
   resumes.
2. **Failure exits.** Force a snapshot write failure at a tool call and at run end: both errors expose an
   `Error` `cause`, a string `errorCode`, and an `Array` `unpersisted`, and `Object.keys` agrees on the two.
3. **Tool text.** `tree { path: "some/nested/dir" }` → first line is that relative path and replaying it
   yields the same tree; `readFile { offset: "3" }` → a `[参数校正：…]` line; `readFile { offset: 999999 }` on
   a short file → `[已到末尾：…]`; `rg { pattern: "x", path: "nope" }` → an error text, not `（无命中）`.
4. **Packaged suites.** Install the tarball in a throwaway project and run
   `erix-agent/contract-tests` — it must not fail on `../helpers/tmp.js`.
5. **Guard payload.** Pass `cwd` to `runToolLoop`, log the whole payload in your guard, and
   assert that `attempt` increments across a forced `revise`, that `selfReport.findings ===
   findings`, and that your accept path still refuses a run whose deliverable is missing
   (§8's `S6` counter-example).
6. **Deliverable gate.** Declare one `deliverables` criterion that stats a file under `cwd`,
   keep the naive `finalText` guard, and assert that a run which never wrote the file ends
   `unverified` / `deliverables_failed` — then remove the option and assert the same run goes
   back to `verified` (that pair is the proof the gate, not your prompt, is doing the work;
   §9's `S6a`/`S6b` cells are the shipped version of it).
7. **Budget bridge.** Take a run with `maxRounds: 1`, a guard that returns `revise` on the
   first call and `accept` on the second, and `finalGuardExtend: true`: the result must be
   `verified`, the event log must carry one `final_guard_extend` with
   `from_max_rounds: 1`, and the model must have done the missing step. Then delete the
   option and assert the same script ends `unverified` / `non_continuable` — and that a
   `stall` run never extends even with the option on (§10's cells are the shipped version).

## 12. What did not change

No store method signature, no return type, no option name, no export, no record kind, no message field, no
termination reason, no error code, and no runtime dependency (still zero). `store.load()`'s shape is
unchanged from 0.23.0. `deterministic.compactionStats` still holds the last 32 entries. The judge decision
surface and the resume path are untouched; the final guard's *verdict* semantics are
untouched too — its payload gained additive keys (§8), which is information, not a new rule. The only *behavioural* change in the whole
release is that a missing search root returns an error text instead of `（无命中）` — and that one is a
correction of a false negative, not a new rule.

## 13. Migration recipe

1. If you read `<runId>.state.json`'s compaction ledger, read `compactionStatsWindow.total` (and
   `dropped`) instead of counting the array — and treat the key's absence as "no statistics", not "zero".
2. Replace `message`-string parsing on `persistence_failed` / `checkpoint_failed` with `errorCode`; use
   `cause` (an `Error`) and `unpersisted` (an array) directly. Drop any `typeof cause === "string"` branch.
3. Feed `tree`'s first line back as `path` (or ignore it); do not treat it as a bare directory name.
4. Re-baseline the tool-output texts you assert on: the `readFile` markers, the `rg`/`grep` deprecation
   line, and the missing-root error text. Assert on the *presence* of a marker, not on its exact bytes, if
   you can.
5. Re-run your own "what did the model see" test against the new texts — every one of them now says what
   actually happened, which is the whole point of this release.
6. Delete any `messages` re-parsing in your `finalGuard` that recovers files written, tool
   counts, the task brief, the model's self-report, usage, or elapsed time: read `filesWritten`,
   `toolStats`, `taskBrief`, `selfReport`, `usage`, `elapsedMs` instead (§8). Keep reading
   `messages` only for the *contents* of a tool result.
7. Move your guard's disk/existence checks into `deliverables` (§9): the engine then enforces
   them on **every** attempt, a `revise` really gets re-checked, and a later guard rewrite
   cannot quietly turn the check back into a rubber stamp. Switch any `stat()` you do today
   from `filesWritten[].path` (40-code-point summary) to `fileWrites[].path` (verbatim) — the
   summary silently rejects runs that already wrote the file.
8. If you want budget-type stops to be recoverable, set `finalGuardExtend: true` (§10) — and
   then make your guard's `revise` messages name the missing step, because that message is
   what the extra round is spent on. Leave it unset and nothing changes.
