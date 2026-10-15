# Host upgrade guide: 0.21.0

This guide covers the changes a host can **see** in 0.21.0, named one by one: the
reflection-decision fix (issue #305), the new `parseModelJson` entry point (issue #307), the
user-turn request guard (issue #292), `erix_run`'s richer final face (issue #313), the opt-in
`finalGuard` (issue #314), and the `erix_run` tool-list fallback (issue #312(b)). **None of them
moves an option name, a method signature, or an export, and none breaks a call site that does not
assert on text.** Two of them do change strings a host may assert on verbatim — #314 when you turn
the switch on, #312(b) always — and those sections say so. A further change (documentation anchor
discipline, issue #286) is repository-internal and is listed here only so you know why nothing is
written about it. `CHANGELOG.md` remains the complete list; if a section below does not describe
your code path, that section is a no-op for you.

**Read this sentence before you skip the guide: no option name, no method signature, and no
export moved.** The two functions that changed behaviour are host-visible helpers
(`parseReflectionDecision`, `src/loop/reflection.js`) and a brand-new one (`parseModelJson`,
`src/text/parse-model-json.js`); everything else is additive keys in structures you already
ignore. The only parameter-face change in this release is two **optional** keys on the
`erix_run` extension tool (`finalGuard`, `finalGuardTimeoutMs`, issue #314) — that extension lives
in `examples/pi-extension/` and is not shipped in the tarball, and its published `outputSchema`
gained no key. The package still has zero npm runtime dependencies, is still pure ESM, and still
requires Node 22.

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| `parseReflectionDecision` no longer inverts the booleans the model wrote, and its result gained a `via` source marker (`"json"` \| `"prose_fallback"`) (issue #305) | deep-equals the whole returned object, or assumed a hand-written `{…}` decision could come back inverted | 2 |
| `parseModelJson` is exported from the package root as the one way to dig JSON out of model text (issue #307) | nothing breaks; hosts holding their own brace-scanner gain an alternative | 3 |
| The request view sent upstream always keeps a real user turn, so tiny `context.budgetTokens` stops producing `400 No user query found in messages` (issue #292) | nothing breaks; a run that used to end `failed` now runs | 4 |
| Bare line numbers in host-readable docs are now a ratchet, and references are symbol anchors (issue #286) | nothing — this is repository documentation discipline | 8 |
| `erix_run`'s final face carries per-layer compaction (`layers`) and note counters, so `compacted:false` / `foldedRounds:0` no longer reads as "compaction did nothing" (issue #313) | nothing breaks; a host that judged compaction off those two scalars can now read the real numbers | 5 |
| `erix_run` gained an opt-in `finalGuard`; with the switch on, the terminal draft must carry four named sections and every declared base must trace to a `tool_result` of that run (issue #314) | nothing breaks while the switch stays off; a host that parses the terminal text gains a structure it can rely on | 6 |
| The `erix_run` tool list is generated from the tools actually registered: an unavailable registration now raises `tool_list_unavailable` instead of a silently short list, and the `note_*` tools are now named (issue #312(b)) | asserts the **extension's** system prompt verbatim (the engine prompt is byte-identical) | 7 |

## 2. A written-down `false` stops coming back as `true` (issue #305)

`parseReflectionDecision`（`src/loop/reflection.js`）is exported from the package root
（`src/index.js`）for hosts that parse a reflection answer themselves; the engine also uses
it internally. Its extraction used to be the greedy `/\{[\s\S]*\}/`, so one brace pair in a
trailing sentence — a `{plan}` placeholder in prose, a fenced answer followed by a remark,
two sibling objects, or an outer object left unclosed — made the captured blob
non-parsable. `JSON.parse` threw, the code fell through to the keyword fallback, **and that
fallback ran over the whole text including the JSON itself**: it matched the key names, so a
model that had written `"continue": false` came back as `continueFlag: true` and its
`progress` was dropped along with it.

Now the extraction is a top-level balanced scan shared with the wrap-up parser:
`jsonCandidates`（`src/text/json-candidates.js`）is string- and escape-aware, cuts a
candidate only where brace depth returns to zero, and yields **nothing** for an object left
unclosed. Four input shapes that were wrong today are right: the issue's original shape, a
fenced answer with a braced remark after it, two sibling top-level objects, and an unclosed
outer object wrapping a complete inner one.

**The result object gained one key.** `via` says where the values came from: `"json"` when
they came from a parsable top-level object, `"prose_fallback"` when they came from keyword
matching over the whole text. In the generated declarations it is the literal union
`"json" | "prose_fallback"`, not `string`, so you can narrow on it. It names the **source**
only — it is not a schema verdict: all six decision fields stay optional, so `{"progress":3}`
is a legal decision and stays on the `"json"` path. The one deliberate exception is a
top-level object that parses but carries none of the six decision keys: nothing can be
carried over, so it is reported as `"prose_fallback"`.

**What to do.** Nothing is required. If you `deepEqual` the whole decision object against a
fixture, add `via`. If you want to distinguish "the model answered in JSON" from "we guessed
from its prose", read `via` instead of re-deriving it. Two nearby values are **intentionally
unchanged**: the fallback's `reason` truncation stays `value.slice(0, 200)` in UTF-16 code
units (the round judge's `truncate`（`src/reflection/judge.js`）counts code points —
unifying them would change a value you can already observe), and
`parseJudgeDecision`（`src/reflection/judge.js`）still scans from **every** `{`, so an
unclosed outer object still yields its inner fragment.

## 3. One entry point for digging JSON out of model text (issue #307)

`parseModelJson`（`src/text/parse-model-json.js`）is new and exported from the package root
（`src/index.js`）. It replaces, for the two model-JSON parsers in this package, four
in-house scanners that disagreed about where an object ends. You are not required to use it;
you should use it if your host does the same job by hand.

```js
import { parseModelJson } from "erix-agent";

// parseModelJson(text, { topOnly = true, requireKeys = null } = {}) ->
//   { ok: true, value, via: "json", candidates } | { ok: false, error, candidates }
const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
if (hit.ok) {
  use(hit.value);          // the direct JSON.parse output; value validation stays yours
} else {
  // hit.error: "no_candidate" | "unparsable" | "shape_mismatch" — and there is no `value` key
}
```

Three properties are the whole reason it exists, and all three are pinned by the packaged
contract suite (`engineApiContract`):

- **The failure is three-way**, because the three causes need three different reactions
  (re-prompt / accept that it never answered in JSON / ask for the missing field):
  `no_candidate` (the scan produced nothing), `unparsable` (candidates exist but every
  `JSON.parse` threw, e.g. `{"a":,}`), `shape_mismatch` (something parsed, but no candidate
  satisfies `requireKeys`).
- **A miss carries no `value` key** — not `value: undefined`. After `if (!result.ok)` you are
  holding nothing, so a failed parse cannot be mistaken for "the model answered with an empty
  object".
- **There is no repair.** No closing brace is appended, no trailing comma dropped, no value
  rewritten. This is the "normalizers may only carry things across" charter of
  [host-consumer-contract.md](host-consumer-contract.md).

Two profiles, one file: `topOnly` defaults to `true` (only objects whose brace depth returns
to zero are candidates; an unclosed outer object yields nothing). `topOnly: false` scans from
**every** `{`, so an unclosed outer object yields its inner fragment first — that profile
exists only so `parseJudgeDecision`（`src/reflection/judge.js`）could share the scan with
**zero** behaviour change. `requireKeys` is any-of key **presence** and never looks at value
types. `candidates` is always the complete scan output in order of appearance, so you can run
your own stricter per-candidate validator on top of it.

Two neighbours deliberately did **not** migrate, and knowing why saves you a bug report:
`tryParseWrapupJson`（`src/reflection/wrapup.js`）has a gate stricter than key presence and
must skip-and-retry, and the L0 / fold-summary readers（`src/reflection/l0.js`,
`src/compact/fold-statistical.js`）are not the same problem — one reads a label the engine
asked the model to emit, the other reads lines the engine itself wrote and fails closed.

## 4. A tiny token budget no longer empties the request (issue #292)

With `context.budgetTokens` small enough that not even one message fits, the compaction
safety layer (`safeTruncateMessages`, `src/loop/budget.js`) deleted unprotected messages from
the head and could delete the **only user turn along with the whole list**. A real
OpenAI-compatible relay answers that with `400 invalid_request` — "No user query found in
messages" — so a small-budget configuration degraded from "runs" to "always `failed`".

The fix is an invariant, not a tuned threshold: `ensureUserTurnView`
（`src/loop/request-user-view.js`）runs where the request view is finalized — after TTL
folding and run-state appending, before the `request` object is assembled
(`src/loop/provider-runner.js`, one guard covering both `chat` and `chatStream`) — and once
more before a compaction result is written back to the persisted message list
（`src/loop/orchestrator.js`）. The concession order is: pass the view through if it already
holds a real user turn → otherwise keep the **latest** user round (with the assistant pairing
it needs) from the **unfolded / uncompressed** source view → otherwise abandon this fold and
use the source view → otherwise return the view untouched and record the case as
unrecoverable. Every step is checked with `validateMessages`（`src/messages/rounds.js`）, so
a rescued view never carries an orphan `tool_result` or a `tool_use` without its result. A
trailing pending `tool_use` is tolerated by the pass-through arm, which is the shape a
`max_tokens` continuation and a resumed run leave behind.

**What to do.** Nothing. What changes for you: a run that used to throw a `400` and end
`reason: "failed"` now runs. If you assert that small budgets still compact, that still
holds — the guard is not "skip compaction when the budget is small"; under a healthy budget
compaction behaviour is byte-identical (`compacted` stays true, `foldedRounds` stays above
zero, `tokensAfter < tokensBefore`).

**Two additive keys you may notice, and may ignore.** When the guard actually fires, that
round's entry in `compactionStats` carries `userTurnGuard` (`"preserved_latest_user_turn"` |
`"abandoned_fold"`, from `isUserTurnGuardAction`, `src/loop/request-user-view.js`) and
`userTurnGuardChannel` (`"chat"` | `"chatStream"` | `"persisted"`). They appear **only when
something actually happened** — a run that never needed the guard produces exactly the keys
it produced before. `compactionStats` is engine-internal diagnostic data (see
[host-consumer-contract.md](host-consumer-contract.md), the transcript meta table): it is not
part of the display projection, so do not build a UI on it.

## 5. `erix_run`'s final face shows per-layer savings and note counters (issue #313)

`erix_run` is the pi host extension under `examples/pi-extension/` — a repository artifact that is
not part of the npm tarball. The engine has reported per-layer compaction for every round all
along: each `compactionStats` entry carries a `layers` map keyed by the engine's own layer ids
(`COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）), filled at the loop's observation points by
`observeCompactionLayer`（`src/compact/pipeline.js`） and normalized by `createCompactionStat`
（`src/compact/pipeline.js`）. The extension folded those entries into three scalars and threw the
map away, so a run whose `ttl` layer folded 69 tool results and saved 650,581 tokens still printed
`compaction=0/1` and was read as "compaction did nothing".

**What the final face gained** — all of it additive, all of it assembled by `buildDiagnostics`
（`examples/pi-extension/erix-run-core.js`）:

- `diagnostics.compaction.layers` — `roundsObserved`, `tokensBeforePeak`, per-layer
  `byLayerId.<id>.triggered` / `.tokensSaved`, the named buckets in `roles[]`
  (`COMPACTION_LAYER_ROLES`（`examples/pi-extension/erix-run-core.js`）), and `unattributed[]` for any
  layer id the bucket table does not name yet. Summed by `summarizeCompactionLayers`
  （`examples/pi-extension/erix-run-core.js`）, rendered one line per bucket by
  `formatCompactionLayerSummary`（`examples/pi-extension/erix-run-core.js`）.
- `diagnostics.notes` — `writes` / `reads` / `byName` / `unclassified` / `source`, counted off the
  `tool_use` events by `countNoteToolEvent`（`examples/pi-extension/erix-run-core.js`）. `source` is
  the constant `NOTE_COUNT_SOURCE`（`examples/pi-extension/erix-run-core.js`）
  (`"onEvent:tool_use"`): the numbers are counted, never derived from some other field.
- `diagnostics.modelMetadataMissingEvents` — `count` / `observed`. The pre-existing
  `modelMetadataMissing` flag keeps its own meaning and its own value.

**The misreading this exists to kill: `compacted: false` or `foldedRounds: 0` is not "nothing was
saved".** Those two values did not move — their meaning and their numbers are what they were before
#313, and `diagnostics.compaction.events` / `.compactedRounds` / `.foldedRounds` are what they were
before this section exists. Layer savings are readable **only** off `layers`: the accident above has
`foldedRounds = 0` and 650,581 tokens saved in the same run.

**`unknown` is not `0`.** Wherever the source of a counter did not exist (an older record, or a run
that died during assembly) the text renders `unknown` and the payload carries `observed: false`
instead of inventing a number: a run that produced no events at all is not a run that made zero
calls. A layer id the engine adds later lands in `unattributed[]` rather than being swallowed by the
bucket table, so do not match on ids outside `COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）.

**Read the totals off the run result, not off `<runId>.state.json`.** The summary reads the **full**
`compactionStats` array on the run result (or on the throw payload) and says which copy it used:
`COMPACTION_STATS_SOURCE` / `COMPACTION_STATS_TRUNCATION_NOTE`
（`examples/pi-extension/erix-run-core.js`） arrive as `layers.source` / `layers.truncationNote`. The
copy in `<runId>.state.json` went through `normalizeCompactionStats(value, limit = 32)`
（`src/compact/pipeline.js`） from `createDeterministicRunState`（`src/run-state.js`）, i.e.
`value.slice(-limit)` — the **last 32** entries. On a run longer than 32 rounds, re-counting off
that file silently under-states the savings (that truncation is issue #315; nothing about it
changed here).

**What to do.** Nothing is required. If you answer "did compaction pay off?" from `compacted` /
`foldedRounds`, read `diagnostics.compaction.layers` instead; if you re-read `<runId>.state.json` to build
your own totals, either stop or present the number as a last-32 window.

## 6. `finalGuard` is opt-in, and its four-section draft is a shape you can parse (issue #314)

**Off by default.** `parseRunParams`（`examples/pi-extension/erix-run-core.js`） accepts `finalGuard`
only as the boolean `true` — anything else is `bad_params`, and `finalGuardTimeoutMs` without the
switch is rejected for the same reason (it would look like verification while nothing was being
verified). With the switch off, `buildLoopOptions`（`examples/pi-extension/erix-run-core.js`） hands
`runToolLoop` an options object carrying **no** `finalGuard` key at all — not one holding
`undefined` — so `verification` stays `{ status: "skipped", reason: "no_final_guard" }` and
`end_turn` stays a claim rather than a proof. That default path is byte-identical to the pre-#314
one, and three repository assertions plus the installed CLI's exit-code-4 smoke pin it.

**What it costs when you turn it on:** up to **2 extra model round trips** (the engine's
`finalGuardMaxRetries` default) plus **up to 3 guard waits** bounded by `finalGuardTimeoutMs`, whose
explicit value is `FINAL_GUARD_TIMEOUT_MS`（`examples/pi-extension/erix-run-final-guard.js`） =
10000 ms rather than the engine's 30000 — worst case `FINAL_GUARD_WORST_CASE_MS`
（`examples/pi-extension/erix-run-final-guard.js`） = 30000 ms of extra wall clock. Costs land in the
same diagnostics tree as `diagnostics.finalGuard` (`calls` / `elapsedMs` / `reviseRounds` /
`accepted` / `invalidDecisions` / `missingSections` / `declaredBases` / `untraceableBases` /
`ratioFlags` / `finalGuardTimeoutMs` / `worstCaseExtraMs` / `source`), while the engine's own
counters stay on `verification.metrics` (`guardMetrics`（`src/loop/orchestrator.js`）); both sides
carry a `source` so you cannot read the host's counters as the engine's. Disabled, that field is
one honest line — `finalGuard=disabled` — and never claims a pass.

**The timeout rule is the part that bites.** The engine consults the run deadline only at round
boundaries (`remainingMs`（`src/loop/orchestrator.js`）) and there is no deadline check between the
stop decision and the guard call, so the entire guard tail can run **after** your own deadline has
already passed. `runErixRun`（`examples/pi-extension/erix-run-core.js`） owns a hard abort timer and
pushes it back by `FINAL_GUARD_WORST_CASE_MS` for exactly that reason; the run deadline handed to
the engine is left alone. If you wrap the extension in your own timeout, leave the same room —
otherwise you pay for the tokens and abort the verdict you asked for.

**What you can now depend on.** With the switch on, the terminal draft must contain four sections in
this order — `FINAL_DRAFT_SECTIONS`（`examples/pi-extension/erix-run-final-guard.js`）: `## 取证边界`,
`## 基点`, `## 结论`, `## 未验证` — and the wording of those slots is appended to the system prompt
only while the switch is on (`FINAL_DRAFT_PROMPT`（`examples/pi-extension/erix-run-final-guard.js`）).
One hard gate sits behind them: every literal declared under `## 基点` must appear verbatim in a
`tool_result` block **of this run** (`collectToolResultText`
（`examples/pi-extension/erix-run-final-guard.js`）). A missing section, a missing declaration, or an
untraceable base all yield `revise`, and no branch ever `accept`s an untraceable base; at the retry
limit the run ends `final_guard_unverified` with `verification.status` `unverified` (`max_retries`)
— that is the fail-closed rule passing, not the answer. Ratios, percentages and "total" claims are
only reported (`ratioFlags`), never rejected. **If your host parses the terminal text, this is the
new structure worth depending on** — and if you assert on the prompt verbatim, remember those four
slots appear only with `finalGuard: true`.

**What to do.** Nothing by default. To get a verified terminal answer: pass `finalGuard: true`, read
`verification.status` (`verified` / `unverified` / `skipped`) together with
`diagnostics.finalGuard`, and size your own timeout for the guard tail.

## 7. The tool list in `erix_run`: engine prompt unchanged, the extension's fallback is not (issue #312(b))

**Nothing moved on the engine side.** `buildCliToolsSystemPrompt`（`bin/tools.js`） now builds its
list line by walking the registered definitions (`cliToolDefinitions`（`bin/tools.js`）) and looking
every name up in one phrase table (`CLI_TOOL_PROMPT_PHRASES`（`bin/tools.js`）), and it throws at
build time in both directions — a name in the table with no registration, or a registered tool with
no wording. **Its output is byte-identical**: the golden fixture was not re-baked, so a host reading
the engine prompt receives exactly the same bytes as before.

**What changed is the extension's own fallback**, which had been a hand-copied six-tool sentence
that had silently lost `searchText` and `edit` and never named `note_forget`. `buildSystemPrompt`
（`examples/pi-extension/erix-run-core.js`） now generates that line from the array actually handed to
`runToolLoop`, quoting the table the engine exports instead of copying it a second time:

- When the registration is unavailable you get an `ErixRunError` whose code is
  `tool_list_unavailable` (`buildToolListLine`（`examples/pi-extension/erix-run-core.js`）) instead of
  a shorter list — a silently incomplete list *was* the bug.
- One new line names the host-registered notes tools (`note_take`, `note_list`, `note_read`,
  `note_forget`) out of `HOST_REGISTERED_TOOL_PHRASES`（`examples/pi-extension/erix-run-core.js`）:
  `本工具面另注册：…`. The engine's own prose names only the first three, so that line is the only
  place the model learns `note_forget` exists.
- `assertToolListMatchesRegistered`（`examples/pi-extension/erix-run-core.js`） fails assembly when a
  name written into the prompt is not in the `tools` array — the classic shape being an engine list
  carrying `todo_*` while the host filtered them out of its own array.

**This is the item that can turn your tests red.** If your host asserts the **extension's** system
prompt verbatim, the regenerated list line plus the new `本工具面另注册：…` line will not match the
old fixture: re-baseline it. Assertions against the **engine** prompt stay green — that text did not
move.

## 8. Documentation anchor discipline (issue #286) — no host action

Two rules now hold for every host-readable document in this package (README, the contract, and
every upgrade guide in this series): a code reference is a **symbol anchor** (`` `name` `` plus
its file) that a gate resolves against the real declaration, and a **bare line number** is a
ratchet that only goes down. For you this means the line numbers you may still find in older
guides of this series are the least trustworthy part of them, and the symbol anchors in newer
ones are machine-checked. It costs you nothing.

## 9. Self-check

1. `grep -rn "parseReflectionDecision" <your host>` — if you assert on the returned object,
   add `via`; if you re-derived "was this JSON?", read `via` instead (section 2).
2. `grep -rn "JSON.parse\|\\\\{\\[\\\\s\\\\S\\]" <your host>` — anywhere you scan model text
   yourself is a candidate for `parseModelJson`; if you keep your own scanner, make sure an
   unclosed outer object does not yield an inner fragment as if it were the answer (section 3).
3. `grep -rn "budgetTokens" <your host>` — a small budget no longer needs a workaround;
   remove any "retry because the first request 400s" band-aid you added (section 4).
4. `grep -rn "No user query found" <your host>` — that error string should stop arriving; if
   your code special-cases it, keep the arm but stop expecting it.
5. Run the packaged suites against your adapters (`erix-agent/contract-tests`):
   `engineApiContract` now covers `parseModelJson`'s three failure kinds and its missing
   `value` key.
6. `grep -rn "compacted\|foldedRounds" <your host>` — if you judged compaction off those two
   scalars on `erix_run`'s final face, read `diagnostics.compaction.layers` instead, and never call
   `foldedRounds: 0` "no savings" (section 5).
7. `grep -rn "compactionStats" <your host>` — a copy of `compactionStats` read out of
   `<runId>.state.json` is a **last-32** window; present it as such or read the run result
   (section 5).
8. `grep -rn "finalGuard\|verification" <your host>` — the default did not move (`skipped`); to get
   `verified`, pass `finalGuard: true` and add the guard tail to your own timeout budget
   (section 6).
9. `grep -rn "system prompt\|systemPrompt" <your host>` — a verbatim assertion on `erix_run`'s
   system prompt needs re-baselining (generated list line + the new `note_*` line); the engine
   prompt fixture does not (section 7).

## 10. What did not change

No option name, no method signature, no export was removed or renamed;
`runToolLoop`'s options and `TranscriptStore`'s methods are untouched. `parseModelJson` is
additive, `via` is additive, and the `#292` guard only ever **adds** a message to a view that
would otherwise have been rejected. `finalGuard` and `finalGuardTimeoutMs` are two **optional**
parameters of the `erix_run` extension tool and its published `outputSchema` gained no key
(issue #314); the engine's tool-list prompt text is byte-identical (issue #312(b)); and
`end_turn` remains the normal success exit with an unchanged terminal reason set —
`final_guard_unverified` was already in `FINAL_GUARD_TERMINATION_REASONS`
（`src/loop/termination.js`）, #314 only made it reachable from the host. Chinese version of this
guide: [host-upgrade-guide-0.21.0_cn.md](host-upgrade-guide-0.21.0_cn.md); the contract itself is
[host-consumer-contract.md](host-consumer-contract.md) with
[host-consumer-contract_cn.md](host-consumer-contract_cn.md) as its synchronized Chinese
counterpart.
