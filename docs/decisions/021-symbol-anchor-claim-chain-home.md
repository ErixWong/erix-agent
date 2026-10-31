# ADR-021: Where the symbol-anchor claim chain lives — evaluation and migration plan (issue #644 ③)

> **Status: proposal (2026-10-31).** This record evaluates the question and fixes the migration
> checklist. It does **not** move the chain: the move changes which documents the anchor face covers
> and how the only-up floor is bucketed, so it gets its own ticket, its own reverse proofs and its own
> measurement on the merged tree.

- Related: issue #642 (the instruction-face scanner `scripts/agents-directive-scan.mjs`), issue #644 ① / ②
  (the scanner's reverse proof and `--sync`), issue #286 T-a (symbol anchors + the bare-line ratchet),
  issue #302 (synthetic-tree fixtures), issue #164 / #274 (the docs gate)
- Basis: `scripts/docs-drift-check.mjs` (anchor face `refScanDocs()`, floor `SYMBOL_ANCHOR_MIN_UNIQUE`,
  coverage floor `REF_SCAN_DOCS_MINIMUM`, ratchet `BARE_LINE_REF_BASELINE`),
  `scripts/agents-directive-scan.mjs` (`DEBT_CEILINGS`), `scripts/retired-spelling-scan.mjs`
  (`HISTORY_DOC_PATTERNS` + `HISTORY_BODY_PINS`), `test/docs-anchor-ratchet.test.js` (the test-side pin)

## 1. What the chain is

Both `AGENTS.md` and `AGENTS_cn.md` describe the `symbols` anchor in one bullet. That bullet carries the
**current** value of the only-up floor and then, in the same breath, a running log of every merge that
raised it — the "again to N when issue #X's section landed as an EN/CN pair" chain. One item per merge,
each one naming the symbols the new contract section cited.

Two properties of that log matter here:

1. **It is history, not status.** Every item says what was true *at that merge* (`measured N groups` on
   *that* tree). Nothing in it tells a reader what to do today.
2. **It is inside the page every session injects.** `AGENTS.md` / `AGENTS_cn.md` are read and executed
   without verification, which is exactly why issue #642 put a gate on them.

## 2. What it costs (measured)

Removing **only** the chain spans (both languages; the "current value" sentence and everything else in
both files stay) and re-running the gates gives:

| Reading | Today | Chain span removed |
|---|---|---|
| `AGENTS.md` A class (work-order status claims) | 20 | **8** |
| `AGENTS.md` B class (expiring measurement copies) | 24 | **20** |
| `AGENTS_cn.md` A class | 4 | **1** |
| `AGENTS_cn.md` B class | 29 | **21** |
| `AGENTS.md` hits waved through by an exception | 11 | 7 |
| `AGENTS_cn.md` hits waved through by an exception | 38 | 13 |
| `symbols` unique (symbol, file) groups | 191 | **186** |
| `symbols` occurrences | 637 | **535** |
| … of which `AGENTS.md` / `AGENTS_cn.md` | 51 / 51 | **0 / 0** |
| bare-line ratchet (`BARE_LINE_REF_BASELINE`) | 80 | 80 |

So the chain is **12 of the 20 + 3 of the 4** A-class hits and **4 of 24 + 8 of 29** B-class hits — 27 of
the 77 non-exempt hits on the instruction face — and it is **all** of the symbol anchors either AGENTS
file carries. It carries no bare coordinates at all (the ratchet does not move), because its references
are symbol anchors or registered external-repo prefixes.

That is the disease issue #642 named, in numbers: a debt whose service interval is "every merge" is
sitting on the page whose job is "what is true now". Today it has already cost two ceiling raises
(18 → 20 in `DEBT_CEILINGS`, issue #642's own residual note).

## 3. Decision

**Move the chain to `docs/`; keep the current value plus one reproduction command on the instruction
face.** Concretely, `AGENTS.md` / `AGENTS_cn.md` keep exactly this shape:

> … so `symbols` carries its own only-up floor `SYMBOL_ANCHOR_MIN_UNIQUE = 191`: dropping below it is
> red — that is the degeneration being caught, not a ratchet rise — and exceeding it earns a "raise the
> floor" note. Both numbers are read back out of the script's own text, which is what lets
> `--self-test` prove they are locks. Current reading: `node scripts/docs-drift-check.mjs --verbose`.

Two reasons this is the right split, and not merely a shorter page:

- The value is already a **gate-owned constant**, so the `gate-owned-constant` exception reconciles it
  **live** against `scripts/docs-drift-check.mjs`: a copy that drifts from the constant stops being
  exempt and turns red. That is the strongest available form for a number on the instruction face.
- The reproduction command replaces the log. Anyone who needs the history gets it from `docs/` (and
  from `git log`), and anyone who needs today's number runs one command.

## 4. Migration plan (the next ticket's checklist, in order)

0. **Measure on the merged tree first.** Every number in this ADR is from the tree that carried issue
   #644. A branch-local reading is void after the merge (that is how 163-as-a-floor happened).
1. Create `docs/symbol-anchor-claim-chain.md` + `docs/symbol-anchor-claim-chain_cn.md` and move the chain
   **verbatim**, item for item, same order on both sides. Leave the sentence grammar whole where the span
   was cut (`… `SYMBOL_ANCHOR_MIN_UNIQUE = 191`: dropping below it is red`).
2. **Keep the floor from dropping** — this is the step that decides whether the move is a move:
   - add **both** new files to `SYMBOL_DOCS_STATIC` in `scripts/docs-drift-check.mjs`;
   - raise `REF_SCAN_DOCS_MINIMUM` by 2 (13 pinned + 32 scanned guides = 45 today);
   - update the test-side list in `test/docs-anchor-ratchet.test.js` if it enumerates the pinned docs.
3. **Classify the new pair as history in the spelling gate.** `docs/**` that no pattern claims is scanned
   as *current*, and the chain quotes retired flat option names — they would red as `REGRESSION`. Add a
   `HISTORY_DOC_PATTERNS` entry for the pair, and record its `HISTORY_BODY_PINS` count **from the live
   reading of `node scripts/retired-spelling-scan.mjs`** (never by hand).
4. **Decide the `paths` face.** Adding the pair to `PATH_DOCS` is the consistent choice (a document whose
   symbol anchors are checked should have its plain path references checked too); it costs 2 more docs in
   that face and may surface pre-existing dead paths in the chain — fix them, do not exempt them.
5. **Re-derive the ceilings with `--sync`, never by hand** (issue #644 ②): after the move the four cells
   should land near the numbers in §2 (`AGENTS.md` A 8 / B 20, `AGENTS_cn.md` A 1 / B 21) — but re-measure
   and let `--sync` write them, then re-run `--verify`.
6. **Prove the floor did not drop.** `SYMBOL_ANCHOR_MIN_UNIQUE` must stay at its merged-tree value or rise.
   A drop is **not** "the floor was too high": it means the destination is outside the anchor face (step 2
   skipped) or anchors were lost while transcribing (step 1). Fix the move; never lower the floor.
7. Gates that must be re-run and reported: `check:docs`, `check:docs:strict`, `check:docs-spelling`,
   `check:agents-directives` (`--strict` **and** `--verify`), `node scripts/docs-drift-check.mjs
   --self-test`, `node scripts/retired-spelling-scan.mjs --self-test`, `npm test`.

## 5. Why the floor should not drop — the argument in one paragraph

`SYMBOL_ANCHOR_MIN_UNIQUE` counts **unique (symbol, file) pairs across the whole anchor face**, and the
face already contains `docs/**`-shaped documents (the contract pair, the architecture / charts /
requirements pairs, every upgrade guide). Moving the chain therefore does not delete a pair: the pair
stops being cited by `AGENTS.md` and starts being cited by the new document, and the count is a set union.
The only way the number moves is if the destination is **not in the face** — and that is exactly what §2
measures: 191 → 186 groups (−5) and 637 → 535 occurrences (−102) when the chain lands outside, because
those 5 pairs were cited by AGENTS alone. With step 2 done, the same 191 pairs and 637 occurrences are
still there, bucketed differently. **A drop after the move is a lost anchor, not a lower floor.**

## 6. Reproducing the numbers in §2

The readings come from a throwaway clone of the tree, with the two chain spans cut out and nothing else
touched. The spans are delimited by markers that the chain itself carries:

```bash
git clone --no-hardlinks . /tmp/probe-644 && cd /tmp/probe-644
python3 - <<'PY'
en = open("AGENTS.md", encoding="utf-8").read()
i = en.index("(groups measured today:")
j = en.index("CN 94 → 96)):") + len("CN 94 → 96)):")
open("AGENTS.md", "w", encoding="utf-8").write(en[:i] + ":" + en[j:])
cn = open("AGENTS_cn.md", encoding="utf-8").read()
k = cn.index("（**现值** **191 组**")
end = cn.index("`--verbose` 可复核）", k) + len("`--verbose` 可复核）")
open("AGENTS_cn.md", "w", encoding="utf-8").write(cn[:k] + "（现值由脚本自身文本读回，`--verbose` 可复核）" + cn[end:])
PY
node scripts/docs-drift-check.mjs --verbose | grep -E "symbol-anchor:|bare-lines:"
node scripts/agents-directive-scan.mjs | sed -n '/射程三类/,/A = 工单/p'
```

`docs-drift-check` will report the floor as violated in that clone (186 < 191) — that red **is** the
measurement: it is the number the move would cost if the destination stayed outside the face.

## 7. Out of scope for this record

- Moving the chain (this ticket evaluates only; the move touches `SYMBOL_ANCHOR_MIN_UNIQUE`'s buckets and
  the coverage face, which needs its own reverse proofs).
- Trimming the rest of the instruction-face debt (A 8 / 4 and B 20 / 21 that survive the move are ordinary
  status sentences and measurement copies; they are paid down by rewriting, not by moving).
- Any change to `SYMBOL_ANCHOR_MIN_UNIQUE`, `REF_SCAN_DOCS_MINIMUM` or `BARE_LINE_REF_BASELINE` now.
