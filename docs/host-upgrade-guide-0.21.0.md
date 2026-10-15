# Host upgrade guide: 0.21.0

This guide covers the changes a host can **see** in 0.21.0. There are three, and **none of
them breaks a call site**: one is a bug fix that only removes failures the engine used to
cause (issue #305), one is a new public entry point you may adopt (issue #307), and one is a
request-shape guard that only ever **reduces** upstream `400`s (issue #292). A fourth change
(documentation anchor discipline, issue #286) is repository-internal and listed here only so
you know why nothing is written about it. `CHANGELOG.md` remains the complete list; if a
section below does not describe your code path, that section is a no-op for you.

**Read this sentence before you skip the guide: no option name, no method signature, and no
export moved.** The two functions that changed behaviour are host-visible helpers
(`parseReflectionDecision`, `src/loop/reflection.js`) and a brand-new one (`parseModelJson`,
`src/text/parse-model-json.js`); everything else is additive keys in structures you already
ignore. The package still has zero npm runtime dependencies, is still pure ESM, and still
requires Node 22.

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| `parseReflectionDecision` no longer inverts the booleans the model wrote, and its result gained a `via` source marker (`"json"` \| `"prose_fallback"`) (issue #305) | deep-equals the whole returned object, or assumed a hand-written `{…}` decision could come back inverted | 2 |
| `parseModelJson` is exported from the package root as the one way to dig JSON out of model text (issue #307) | nothing breaks; hosts holding their own brace-scanner gain an alternative | 3 |
| The request view sent upstream always keeps a real user turn, so tiny `context.budgetTokens` stops producing `400 No user query found in messages` (issue #292) | nothing breaks; a run that used to end `failed` now runs | 4 |
| Bare line numbers in host-readable docs are now a ratchet, and references are symbol anchors (issue #286) | nothing — this is repository documentation discipline | 5 |

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

## 5. Documentation anchor discipline (issue #286) — no host action

Two rules now hold for every host-readable document in this package (README, the contract, and
every upgrade guide in this series): a code reference is a **symbol anchor** (`` `name` `` plus
its file) that a gate resolves against the real declaration, and a **bare line number** is a
ratchet that only goes down. For you this means the line numbers you may still find in older
guides of this series are the least trustworthy part of them, and the symbol anchors in newer
ones are machine-checked. It costs you nothing.

## 6. Self-check

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

## 7. What did not change

No option name, no method signature, no export was removed or renamed;
`runToolLoop`'s options and `TranscriptStore`'s methods are untouched. `parseModelJson` is
additive, `via` is additive, and the `#292` guard only ever **adds** a message to a view that
would otherwise have been rejected. `end_turn` remains the normal success exit and the
terminal reason set is unchanged. Chinese version of this guide:
[host-upgrade-guide-0.21.0_cn.md](host-upgrade-guide-0.21.0_cn.md); the contract itself is
[host-consumer-contract.md](host-consumer-contract.md) with
[host-consumer-contract_cn.md](host-consumer-contract_cn.md) as its synchronized Chinese
counterpart.
