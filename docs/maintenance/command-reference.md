# Command reference — the cold half of `AGENTS.md` §3 and §4

> Chinese version: [command-reference_cn.md](command-reference_cn.md)

`AGENTS.md` is the instruction face: it is injected into every session and executed without verification, so it
carries only what every task has to obey, and its size is budgeted by `npm run check:agents-directives` (issue
#726). This page is the other half — the reference material behind each gate, which you read **when you are about
to touch that gate** and not before.

Every block below was moved out of `AGENTS.md` **verbatim** in issue #726 (the §3 command-table explanations and
the long notes that used to sit under it, plus the §4 paragraphs named in the pointers there). Nothing was
rewritten, and no discipline sentence was moved: the red lines, the release discipline, the git boundary and the
environment/model rules stay on the instruction face. The headings are the anchors the instruction face points at
(`#check-docs`, `#type-ratchets`, `#docs-anchors`, …), so a pointer from `AGENTS.md` lands on the section that
explains that gate.

## test-suite
Full test suite (`node --test`)

## check-single-file
Syntax safety check

## check-syntax
**Full-tree** syntax check (issue #187): `scripts/syntax-check.mjs` walks every tracked `.js`/`.mjs`/`.cjs` from `git ls-files` (`src/`, `bin/`, `scripts/`, `test/`, `examples/`, `fixtures/`) through `node --check`, names each failing file, exits non-zero. `npm run check` deliberately stays the single-file `node --check src/index.js`: `check:docs` verifies that the commands the docs reference actually exist, so replacing it would manufacture doc drift

## check-test-summary
**Deleted (issue #905).** It reconciled the `tests` / `pass` / `skipped` totals that `npm test` prints against a hand-maintained registry, but keeping that registry in sync was bookkeeping tax, not a judgement (a parallel commit's entire content was re-registering the numbers after the suite changed). The real criterion that stays is `npm test`'s exit code — the full suite runs in CI and a non-zero exit is red.

## check-changelog
**CHANGELOG coverage of public-surface merges** (issue #691 — the gate issue #636 predicted): `scripts/changelog-coverage-check.mjs` answers the question every other CHANGELOG gate skips — *should there be an entry at all*. Both the range and the section are read out of the tree, never off a hand-kept list: the version under test is the newest `## [x.y.z]` section of `CHANGELOG.md` (`--version` overrides it), the range is the greatest tag below that version `..` that version's own tag (or `HEAD` while the version is untagged), and the merge set is `git log --first-parent --merges`. A merge counts as **behaviour-visible** when its first-parent diff (`git diff --name-only <merge>^1 <merge>`) touches a public-surface path — `src/`, `bin/`, `package.json`, both READMEs, the host-consumer contract, the requirements files, or the current version's upgrade guide; a merge that only touches tests, internal docs, `scripts/`, delivery notes, `AGENTS*`, CI config or examples is a **category exemption decided by rule, not by register**. Coverage is checked in **one direction only** — every public-surface merge number must appear in that version's CHANGELOG section or in a registered exemption — because prose that cites an older issue is legitimate and the reverse direction would red on it. Red names the issue number, the merge's short sha and the public files it touched. `COVERAGE_EXEMPTIONS` exists for the reverse case only (a change that looks category-exempt but is behaviour-visible): every row needs a `why`, an idle row is red, an empty `why` is red, and the row count is reconciled against `COVERAGE_EXEMPTION_MAX` in both directions. An endpoint that does not resolve, a section that cannot be read, or git being unusable exits 2 rather than passing. `node scripts/changelog-coverage-check.mjs --self-test` is the gate's own reverse proof on a synthetic git repository built in `os.tmpdir()` (its own tags, branches and merges — never this repository's history), and it also checks the wiring itself: the blocking CI step sits after the Test suite step (`npm test`), the checkout fetches full history, and the npm script points at that file. **Who writes the entry (issue #702)**: the PR that touches the public surface puts **its own** issue number into the current version's CHANGELOG section, in that same PR. What the gate compares is the **number** — the section body and the merge subject go through the same reader, and an entry is never required to carry a merge sha (the sha of a merge that has not happened yet is not knowable, so a rule demanding it would be red against every PR including itself). Writing `#702` in the entry is therefore enough and the sha can be added later; forgetting the number goes red on `main`, and that red is the enforcement doing its job, not a bug and not a row for `COVERAGE_EXEMPTIONS` (which exists only for the reverse case: behaviour-visible yet category-exempt). `npm run release:day -- --stage preflight` runs this gate as step 1 with no waiver

## check-docs
Documentation drift check (`scripts/docs-drift-check.mjs`: version claims, quoted `files`/`exports` lists, module map, referenced paths/commands, the key defaults read out of the source (the rule set lives in the script; no count is copied here), the CLI flag list reconciled bidirectionally between `bin/cli.js`'s help text and the two READMEs' usage lines, EN/CN README skeleton, **and — since issue #511 — which version each sentence belongs to**: every upgrade guide must declare its own version on line 1, a sentence that attributes a fact to a *later* version must carry a forward pointer to that guide, a "no `config.X`" claim is checked against `CONFIG_NAMESPACE_SCHEMA` while an "added in V" claim is checked against that CHANGELOG section, every dated CHANGELOG section must say whether it was published, and the two "current version" sentences in `AGENTS*.md` are reconciled live against `package.json` (repo version) and npm's `dist-tags.latest` (published line) — with no measurement dates), **and — since issue #668 — the retired semantics**: a summarizer failure is a terminal error, so a sentence that pairs a degrade/fallback verb with a statistical summary must carry one of three legitimate readings — a direct negation, a contrast (`instead of` / `rather than`), or historical framing inside the same paragraph — and a plain claim is red, named by file and line, while the history-classed pages keep their bodies untouched; the rule is bound to source truth (the terminal-error path must still exist in `fold-llm`'s code face and the retired banner must not come back there), **and — since issue #677 — the contract's suite inventory**: the `model-config-provider.js` row of the EN/CN suite-inventory table is reconciled per provider shape against the `unknownSlot` modes of `test/contract/model-config-provider.js` — a slot-map provider (static / json-file) must throw for an unknown slot, naming it and listing the available ones, never falling back to default, while a single-config provider returns the same config under any slot name, which is a shape difference and not an unknown-slot fallback to default — so flattening the two shapes into one sentence, dropping a leg on one side only, or changing the truth's mode set without the docs is red, **and — under the same issue #677 slice — the forced-final eligibility clause**: contract §7 (post-stop verification) is gated the same way, so its eligibility must read as a state rather than a whitelist or a fixed count of reasons, the three non-continuable reasons it names must equal `FORCED_FINAL_TRUNCATED_REASONS` in `src/loop/termination.js` while `end_turn` / `no_tool` must really be members of `FINAL_GUARD_TERMINATION_REASONS` there, and flattening it back to the whitelist reading, dropping a leg on one side only, or changing either source set without the contract is red; and it reports its own counts (no number is copied here) plus the EN/CN contract heading sync
Same check, promoting its warnings to failures

## docs-anchors
Reverse-proof self-test of the list/unit/enum anchors (issue #210): change one doc claim → red, change the source truth → red, change nothing → green; a mutation that stops applying also fails (issue #210 R2) **Since issue #302 the tree it runs in does not change the verdict**: the two `#280` tree-shape cases run on a **synthetic tree fixture**, so the result no longer depends on whether this machine's untracked `docs/tasks/` directory (never committed) exists — the three shapes (no / empty / filled `docs/tasks/`) are each run on a `git archive HEAD | tar -x` checkout, and the command prints its own case count and red count (neither number is copied here). Before #302 it was the other way round: 3 of the cases were known false reds in a checkout without `docs/tasks/` (5 with an empty one), tracked in issue #281 — those reds are gone, so "run it in the development tree" is history, not a current requirement.
- Anchor granularity (issue #210): **do not assume "delete one mention in the docs turns red"** — most anchors are
  *existence-level* (the whole `defaults` group, `modulemap`, `paths`: they ask "is this string present in that file",
  so deleting one extra mention of the same value stays green). Only these are *per-occurrence* (each declaration site
  is compared on its own, so missing / extra / renamed members all go red): the `version` claims, the README
  `files`/`exports` fences — compared **bidirectionally** with `package.json`, so renaming or dropping a key in the doc
  is red, not just adding one — and the list/unit/enum anchors (file-tool list, CLI tool list, vendor skip directories,
  `formatSize` unit tiers plus every `` `bytes` → `rendered` `` example claim, built-in compaction strategy names), plus the
  `cli-flags` anchor (issue #391 R4: the flag set of the `erix chat` / `erix repl` usage lines is compared **both ways**
  against `bin/cli.js`'s help text, so a flag added to the help and forgotten in the READMEs is red — and so is one the
  README invents; aliases like `-c|--continue` and `--no-final-guard` are counted, and its exemption register must stay
  empty-or-justified, since an idle entry is itself red).
  Those anchors also reconcile the **number of declaration sites between the EN and the CN doc**, which is what catches
  "someone deleted the whole sentence on one side". Every per-occurrence rule carries its reverse proof in
  `node scripts/docs-drift-check.mjs --self-test`; run it after touching `scripts/docs-drift-check.mjs`. The level of
  every anchor, and why the remaining ones were *not* upgraded, is listed in the header comment of that script.
- Doc line anchors (issue #286, first batch T-a): docs must not lean on **bare line numbers**. `paths` used to strip
  `:1234` before resolving a reference, so only the file was ever checked — a line number that drifted into another
  function, or past the end of the file, stayed green (the contract pointed at line 398 of `src/store/notes.js`, a file that is 383 lines long). Three anchors now hold that line, all wired into `--self-test`:
  *`symbol-anchor`* is *per-occurrence*: every `` `symbol` (`path`) `` or `[symbol](path)` reference must find a real
  declaration of that symbol **in that file** (`function` / `class` / `const|let|var` binding / destructuring /
  re-export / method / object key / `process.env.X`). Extraction reads the **code** face only: comments and
  string literals are masked out first, so a name that appears only inside a comment or a quoted string is *not*
  a declaration (issue #299 — before that fix, `const X = 1;` written inside a block comment "proved" X was
  declared, and a quoted name in a comment fed the weak literal tier). A missing symbol is red and the message names the nearest
  symbols actually declared there; a file from which no declaration can be extracted at all is red too (#164:
  no silent pass when ground truth cannot be read). Named string *values* — termination reasons, provider error
  codes — are the one weaker tier and are accepted only in the five files listed with a reason in
  `SYMBOL_VALUE_MEMBERSHIP` in `scripts/docs-drift-check.mjs` (the fifth, `bin/final-guard.js`, was
  added for issue #743 so the CLI guard's two skip reasons are actually checked). A symbol anchor is judged by the
  symbol it names: rewriting `` `symbol` (`path:1517-1531`) `` into a bare `path:1517-1531` never changes whether
  that symbol exists in the target file, and `symbols` checks that ground truth directly — a named symbol that is
  absent is red. #908 removed the old **only-up floor** `SYMBOL_ANCHOR_MIN_UNIQUE` and the measurement log
  `docs/maintenance/symbol-anchor-ledger*.md` it used to point at (both deleted); the existence and span-intersection
  checks themselves are unchanged.
  *`symbol-shape`* (issue #755) covers the two **other** ways a document writes a symbol coordinate, both of
  which used to be invisible to `symbol-anchor`: **S2** `` `path`: `sym` and `sym` `` (file first, colon, one or more
  backticked symbols — the #755 field shape was `src/loop/tool-result-ttl.js`: `stubFor` and `placeholderFor`,
  neither of which exists in that file) and **S3** a single code span holding `path:sym`. Same declaration table as
  `symbol-anchor` minus `X:` (object keys are *not* accepted here: S2/S3 are one notch stricter than S1, because the
  colon form is what makes an object key look like a symbol). Path prefixes are an explicit registry
  (`src/` `bin/` `scripts/` `test/` `examples/` `fixtures/`), and references into another repository
  (`EXTERNAL_REPO_PREFIXES`) are not looked up. Prose that names a symbol **without** a file is deliberately out of
  scope — there is nothing to check it against. Existing violations are pinned by `SYMBOL_EXISTENCE_BASELINE`, an
  **only-down** ratchet with the same semantics as `check:types`: above it is red (the message names each
  document:line, symbol and file), below it is green plus a "you may lower this" note, and `--verbose` lists every
  remaining group so the baseline can actually be worked down. Three `--self-test` cases hold it: a fake S2 symbol is
  red, the same position with two real exports is green, and an external-repo prefix is not looked up.
  *`symbol-anchor-span`* (#286 batch T-b1a) is the *per-occurrence* companion of the rule above: when a symbol anchor
  **carries a line range** — `` `symbol` (`path:1517-1531`) `` — that range must **intersect that symbol's own ground
  truth in the referenced file** (`lo <= p <= hi`). Ground truth = every declaration site of the name (not only the
  first: `sideEffect` legitimately appears both in the persistence normalizer and in `fail()`) plus, in the four
  membership files, the lines where that named string value occurs. A range pointing elsewhere is exactly the #286
  drift shape — symbol right, numbers wrong, invisible to the old `paths` anchor because it strips line numbers
  before resolving. Two legal fixes: **drop the range** (`` `symbol` (`path`) ``, preferred: numbers drift and
  `symbols` never needed them) or move it onto the declaration. Anchors *without* a range are outside this rule,
  which is also why dropping ranges makes the ratchet below go down legitimately.
  *`bare-lines`* counts `src/**.js:N` / `:N-M` references as unique (document, target file, line range). Since #908
  it is an **advisory, not a blocker**: `check:docs` still counts them and prints a one-line
  `BARE-LINES-ADVISORY 现存 N 处（提示，不阻塞）` note, but never turns red over the count — the old **only-down**
  `BARE_LINE_REF_BASELINE` ratchet (and its measurement log `docs/maintenance/symbol-anchor-ledger*.md`) were removed by #908.
  The number is reproducible with `node scripts/docs-drift-check.mjs --verbose`, which prints the whole breakdown
  (occurrences / unique ranges / declaratively exempted
  example / host-repo paths (`BARE_LINE_EXEMPTIONS`: the entry names one document + one placeholder path, **and** that path plus a
  declaration word must both appear on the referencing line — a leftover "for example" elsewhere is not a declaration; an entry
  nobody uses goes red; and the register carries its own config check, so a declaration pattern that can match the empty
  string (or carries a `g` flag, making `.test()` stateful) is itself an error — same dual-condition family as #286's
  `test/static-guards.test.js`). An out-of-range line number is an
  error, not an observation.
  *Marked-region pinpoint exemption* (issue #772, reworked by R3): the two-axis payload table in both contract
  files — everything **between** the `<!-- erix:snapshot-cell-axes:begin -->` / `<!-- erix:snapshot-cell-axes:end
  -->` markers that is a `|`-prefixed table row — is exempt from this ratchet, and the exemption is **conditional
  on a machine check that the gate performs itself**. The anchor registry lives in `scripts/cell-axes-anchors.mjs`
  — one entry per cell **and per axis** (`{ key, axis, codePath, anchor, note }`, 8 entries / 7 groups over 4
  cell names, between the `CELL-AXES-ANCHORS:BEGIN/END` sentinels) — and **both** this gate and
  `test/contract-snapshot-cell-axes-767.test.js` import that one module, so there is no second copy to drift.
  An anchor is a **code shape** — the payload-assignment line, the guard's `if`, the return site — never the key
  name; it must hit its target file **exactly once** (0 hits = the anchor is dead, >1 = ambiguous, and an
  ambiguous anchor is not a baseline), and the cell's `path:line` must equal the recomputed line, otherwise the
  failure prints "the table says :N / the anchor says :M" and quotes both lines. The gate re-derives those line
  numbers **in its own process** — `node scripts/docs-drift-check.mjs` never spawns the test, it is a pure
  documentation gate — and reconciles each contract file against that file's own numbers, so one cell is checked
  twice with different answers (EN and CN differ). Exemption is granted **per group**: a reference whose anchor
  was deleted, weakened into a key name, or left pointing at a moved line drops out of the exemption and back
  into the ratchet, so deleting the anchor is no longer a way to hide the citation. That is what R3 changed: R2
  kept the registry inside the test file, re-extracted it with a regex, and matched the test file's *shape*
  (`G4_KEY_NAME_CHECK`'s definition, an `assert.ok(...)` around it, `G4_ANCHOR_EQ_CHECK`'s call). What that shape
  matching bought was nothing measurable: pointing a cell at a **comment** that merely mentions `compactionStats`
  (  a comment that mentions `compactionStats`, while the live ledger write site is elsewhere) turned
  `node --test test/contract-snapshot-cell-axes-767.test.js` red while `npm run check:docs` stayed at exit 0 —
  the exemption is issued by the gate, and the gate could not recompute. What the gate still asserts about the
  test is only what it can verify: the file is present and non-empty, and it imports the anchor module (one
  table, two readers). What it no longer claims: anything about the test's internals — a regex cannot tell a
  judgement from a weakened one. `--self-test` carries 19 cases in this family (14 red + 5 green controls): a
  reference copied outside the markers → red; the guard test emptied → red; the module import renamed inside the
  test → red; an anchor weakened to the bare key name → red, naming the ambiguity and its hit lines; the registry
  turned into a function call → red; **one anchor entry deleted** → that cell's reference is counted again, so the
  ratchet goes over its floor, and the missing registration is named by cell and axis; a table cell pointed at
  that comment line → red with "the table says :N / the anchor says :M" plus both lines; a caliber line added to
  `CELL_AXES_CALIBER_LINES` that nothing inside the region uses → red ("registered but nobody uses it"), and its
  live value is now read from this script's own text — that is what makes the self-test overlay of it bite at
  all, since an overlay changes text, not an already-loaded array (the R2 case for this rule was spinning).
  Comment-only edits → green. The floor stayed at 6: the exemption accounts for the table's 72 keys, while the
  bare line numbers the notes *under* the table had acquired were turned into symbol anchors (`residueStart` /
  `restoreResume`) rather than asking to raise the floor.
  *Anchor kind* (issue #772 R4 M-A): every registry entry also carries `kind: "code" | "comment"` — `code` for a
  write site or a reader, `comment` for the four entries whose whole point is a sentence inside a comment (`status`,
  `toolUse`, `ts`, and `compactionStats`). The judgement is one shared function — `anchorKindError()` in
  `scripts/cell-axes-anchors.mjs`, imported by the gate **and** by the contract test, so neither side owns a second
  copy of the rule: a `code` anchor whose single hit is a comment line (`^\s*(\/\/|\/\*|\*)`) is red, a `comment`
  anchor that lands on code is red, and the message names the cell, the axis, the hit line number and that line's
  raw text. It closes the shape a line-number reconciliation cannot see: pointing the `compactionStats` write anchor
  at `orchestrator.js:3015` (a comment that merely mentions the key) **while rewriting both contract tables'
  citation to the same line** is self-consistent — equal numbers, file present, in range — and used to sit at exit 0
  on both gates. `parseCellAxesAnchorTable()` also refuses the exemption when an entry's `kind` is missing or outside
  `code / comment`.
  *Coverage has a second, independent truth* (issue #772 R4 M-B): `CELL_AXES_REQUIRED_CELLS` is the human-reviewed
  list of `(key, axis, codePath, row)` slots those two tables must cover — 8 slots over 4 cell names, written by
  hand and never derived from the anchor registry (deriving it would stop being a second opinion). Every slot has to
  be present in the registry **and** in each contract file, counted per slot rather than "mentioned once"; the shared
  `checkCellAxesCoverage()` names the missing slot **and which file it is missing from**. The ratchet floors are now
  derived from that list — `CELL_AXES_ANCHOR_FLOORS = { entries: CELL_AXES_REQUIRED_CELLS.length, groups: distinct
  key|axis in the list }`, currently 8 / 7 — and must not be hand-tuned. That closes the silent thinning: deleting
  the duplicate `compactionStats|write` slot together with its matching rows in both tables leaves 7 entries /
  7 groups / 4 cells and is rejected by the derived coverage floor.
  *Known limit: semantics are not machine-checkable* (issue #772 R4, **registered, not patched**). Pointing
  `compactionStats`' write anchor at a **different real line that mentions the same key name** in the run-state
  payload, then rewriting both tables' citations to it in the same change, stays green today. Everything a machine can ask is
  answered: the file exists, the anchor hits exactly once, `kind: "code"` matches a code line, both tables equal the
  recomputed numbers, and the coverage list is still satisfied. What no anchor can express is "*this* line is the
  event *this* cell is about" — that is a reading judgement and stays with review. The leniency is pinned as a
  contract rather than quietly hoped away: `--self-test` carries a green-control case for exactly that shape
  (labelled 「#772 R4 已知限度（特征用例…）」), and `test/contract-snapshot-cell-axes-767.test.js` pins it as
  `G4-R6 …（已知限度，见 command-reference）`. Do not add heuristics to close it — a heuristic that guesses which
  event a line is about would itself be the thing nobody can review.
  *The region holds only the table* (issue #772 R2): every line strictly between the two markers must be a
  `|`-prefixed table row, a marker line, blank, or a **registered** caliber line (`CELL_AXES_CALIBER_LINES`, matched
  as whole trimmed text — and an entry nobody uses is itself red, the same no-back-door rule as the declarative
  exemptions above). Without this the exemption had no **positive** invariant: sliding `begin` three lines up drops a
  paragraph of ordinary prose into the exempted region and nothing reports it, and prose is exactly what grows next
  to a table. A cap on the number of exempted references was rejected on purpose — the next row added to the table
  would only raise it.
  Scope is the document set a host actually reads: the two READMEs, both AGENTS files, both
  contract files, both architecture docs, both chart docs, both requirements docs, `examples/pi-extension/README.md`,
  plus **every** `docs/host-upgrade-guide*.md` (discovered from the directory, so a new guide is
  covered the moment it exists). Directory discovery has a silent failure mode — renaming a guide away from that
  pattern shrinks the coverage in the script **and** in the test that mirrors the same glob, so both numbers still
  agree: the count it stands for (pinned documents + the guides the
  directory scan finds) is **reported, not judged** (261122): `check:docs` prints the measured numbers as a
  `ref-scan-claims` note every run, and a document that restates a different number is a **note**, not a red —
  restating a measurement nobody acts on was a self-referential gate (it taxed every new guide with four edits).
  Since #908 there is no numeric coverage floor: a guide renamed away from that pattern is caught by the pinned list below, not a count threshold.
  `test/docs-anchor-ratchet.test.js` keeps its own pinned list of the same documents. **Renaming or removing** a
  pinned guide is red (that is the coverage silently shrinking); **adding** one is not — it joins the anchor face
  automatically, because demanding that the pinned list match the discovered set exactly taxed every new guide with
  another edit and produced nothing a reader could see (261122). `CHANGELOG.md` is deliberately out of scope: its line numbers record what was true at
  release time, and rewriting them would fake history (same reasoning as the #278 shorthand register).
  Batch T-a built the infrastructure and the ratchet; batch T-b1a converted the contract's
  `src/loop/orchestrator.js` anchors that carry their own range (EN + CN in the same PR) and took the baseline from
  244 down to 232; batch T-b1b finished that family — every remaining bare `src/loop/orchestrator.js:N[-M]` in both
  contract files either lost its range (the preferred fix, with the real declaration name written into the sentence:
  `resolvedModelConfig`, `reportObserverError`, `persist`, `isEndTurn`, …) or stayed as a *range fact* whose range was
  checked against the code — taking the baseline from 232 down to 144. The sites left in `provider-runner.js` /
  `termination.js` / `governor.js` belong to batch T-b2, and *lowering* that constant (with a reason in the commit
  message) remains what "we removed some" has to look like.

## check-docs-examples
Executes the JavaScript fences in **both contract documents and both root READMEs** (`README.md` / `README_cn.md` since issue #576), three layers each — syntax compile, real-symbol link, real execution in a spawned subprocess — and the README target table is itself guarded (drop a target and the guard cell goes red). Execution is **offline**: scripted fake providers / `fetchImpl` stubs, no network, no `~/.erix` (issue #158, #576)

## check-pack-links
Link closure inside packaged Markdown, **plus** the `.d.ts` claim reconciliation: every "a packed install should list **N** `.d.ts`" claim in the four entry documents must equal the number of `src/**/*.d.ts` entries the same `npm pack --dry-run --json` lists (no extra `tsc` run), **plus** the `test/contract/` publish-surface reconciliation (issue #505): `files` lists that directory **file by file** and never as a directory, so a new `.js` that nobody added to `files` ships nowhere and **no gate went red** (`check:release` only asserts the opposite direction). Three criteria: **1 (red)** every non-`*.test.js` `.js` that exists under `test/contract/` but is absent from the tarball list is named — that is "forgot to add it to `files`"; **2 (red)** every `test/contract/...` entry in `files` that does not exist on disk is named — a dead entry left over from history; **3 (printed, never red)** every `test/contract/*.test.js` is listed with the command that runs it and the note that it is deliberately not published (they are `node --test` suites; `npm pack` lists **0** `*.test.js` — this line exists so the next reader does not file it as a missed package). "Deliberately unpublished" requires a register entry in `CONTRACT_PUBLISH_EXEMPTIONS` (the register's contents are the truth; its count is reconciled live against `CONTRACT_PUBLISH_EXEMPTION_MAX`, red on both more and fewer — the doc-example harness that once needed an entry has since been moved out of the publish-surface directory), and the register is guarded in both directions: an entry whose file is gone, an entry whose file now ships, an empty `why`, a `path` that is not a concrete file under `test/contract/`, or a count that drifts from `CONTRACT_PUBLISH_EXEMPTION_MAX` (red on both more and fewer) all fail. Still offline and still one `npm pack --dry-run --json`; `node scripts/pack-link-check.mjs --self-test` holds its own reverse-proof cases over in-memory fixtures plus this repo's real tree (the count is printed by the command; no `npm pack`, no network)

## check-release
The pre-release manual check as one command (issue #257 T5), six steps in order, red names the step:
`npm pack` → assert the tarball (declarations present, both current-version upgrade guides, the shipped
`test/contract/` files, nothing outside the `files` allowlist; Markdown link closure is delegated to
`check:pack-links`) → install the tarball into a throwaway temp project and assert `import("erix-agent")`
/`import("erix-agent/tools")`, **and** reconcile that installed package's runtime export surface against every
name the upgrade guide claims is removed (issue #687: a name the guide says is gone must really be absent from
the entry its guide row registers — either language half counts as a claim, and an unrecognised entry column
checks both entries instead of guessing; a name that is still exported is red and named
`name @ guide-file:line @ entry`, and the `KNOWN_NOT_REMOVED` ledger in `scripts/guide-removal-gate.mjs` is
the ratchet that tracks a gap between the two — since issue #688 really deleted the sixteen names the ledger
is **empty** and the gate is green because the installed package no longer exports any of them; every entry
carries a `why`, an idle entry (the guide no longer claims it, or the runtime no longer exports it), an empty
`why` and a count that drifts from the live red-name count in either direction are red, and a missing guide
file, an unparsable name table or a missing runtime surface exits 2 rather than passing; the command prints
its own counts and `node scripts/guide-removal-gate.mjs --self-test` is that gate's reverse proof) → run the
shipped contract suites through the installed package → compile a real TypeScript host with
`tsc --strict --skipLibCheck` (exit 0, and an unknown `runToolLoop` option key must fail with `TS2353`) and
run the compiled host — plus a sample derived from that host which gives `provider` on both the port and the
call site, which must exit non-zero naming `assemblyPort.provider` and `runToolLoop.provider` (the issue #519
direct-route conflict gate is a runtime rule; the spelling itself is legal TS, so only running it proves the
gate bites) → smoke the installed `erix` CLI against the local scripted upstream
(`--version` equals `package.json`; a successful `chat` exits **4** because verification is `skipped` without
`--final-guard`; a missing `--session` exits 1) → resume a run across two CLI runs through
`config.continuity.handoff` (issue #598: a zero-token two-round e2e — run A stores, run B recalls, the option
defaults off, an illegal value is rejected). Offline (`--offline` npm + a throwaway cache/userconfig + fake
`HOME`), self-cleaning, and it prints its own wall clock

## check-release-real
The **pre-release real model endpoint checklist** as one command (issue #817 renamed it from `check:release:real` — the name has to say **which side is real**, and the real side is the model service endpoint, not the scenario; ticket 261021-13, written after 0.23.0 shipped with neither the doc audit nor the real e2e suites actually run): the gated steps in order (the list and its count are the script's `STEPS`) — `node --test examples/tool-fact-e2e.test.mjs` → `examples/delegate-real-e2e.test.mjs` (parent run delegates a child run, issue #617) → `examples/normalize-truncation-real-e2e.test.mjs` (the normalizer's truncation verdict, issue #637) → `examples/resume-real-e2e.test.mjs` → `examples/cross-version-real-e2e.test.mjs` → `examples/pi-extension/erix-run-e2e.test.mjs` → `node scripts/cli-real-smoke.mjs` → `examples/fold-default-real-e2e.mjs` (the **CLI slot default** compaction strategy `fold-llm` on the real model endpoint, issue #619) — each announced as `[i/N] <name>` (N is `STEPS.length`) and summarized as `tests/pass/fail` plus elapsed time — except that the seventh step (`node scripts/cli-real-smoke.mjs`) is not a `node --test` suite, so two things were wrong at once: the TAP parser only reads TAP (all four fields stayed `?`), and that step's own `PASS`/`FAIL` lines were replayed **only when it went red**, so on a green run its checks never entered the summary at all. The fix takes the **machine-readable counts line** option (not the “replay the step's `PASS`/`FAIL` lines on green” one): the step now ends by printing one line — `RELEASE-REAL-SMOKE id=cli-real checks=… pass=… fail=… dry=… failed=… status=…` (format and parser in `scripts/smoke-summary-line.mjs`, one source for both sides) — and the checklist folds it into the same summary as `cli_real=<checks>/<pass>/<fail>` on green and red alike, adding `dry=true` when that run was `--dry` (only C8 runs then, so `checks=1`; the unrun C1–C7 are never counted as passed), `failed=C4,…` naming which checks went red, and `status=error` when the script itself threw. Those counts come from the smoke's own `check()` results, never from a literal, and the red tail replay stays a fallback instead of the only channel. A field that cannot be read keeps the `?` (a missing summary is never printed as zero failures, and a step that declares a summary but whose line is missing shows `cli_real=?`) — and that line counts as readable **only** when all seven declared fields are present and legal (`id=cli-real`, the three counts as **safe** integers with `pass + fail = checks` — an over-long numeric field parses to `Infinity` and `Infinity + 0 === Infinity` would slip past that check, so anything above `Number.MAX_SAFE_INTEGER` is unreadable too — `dry=true|false`, `failed=-` or a comma list whose length equals `fail`, and `status=ok|fail|error`), so a truncated line is never completed by defaults: `… checks=1 pass=1 fail=0` with the rest missing reads as unreadable and the summary stays `cli_real=?` instead of being filled in as `1/1/0` (the exact defect an independent review caught on PR #681), each with its own **900 s** hard timeout (a timeout is red, the whole process group is `SIGKILL`ed so no grandchild keeps burning tokens, and the run continues with the next step). Any red ⇒ **exit 1 after the list finishes**, with a closing block naming which steps failed; all green ⇒ exit 0 plus total time. Gate: without `ERIX_E2E_MODEL=1` it runs **nothing** (`ERIX_E2E_REAL` is retired: setting it no longer opens the gate, it exits 1 with a line naming both names — retiring it in silence would turn a misconfiguration into "the gate was closed, so nothing ran"), exits 0 and prints a categorized reason (same `GAP_CODES` as `examples/e2e-real-gate.mjs`), so it never becomes a hard dependency of any default gate; with the gate **open** but config/credential/endpoint unusable it exits **1** (a pre-release checklist that did not run must not be reported as green — the mirror image of PR #289 blocker 1), and a child that skips with a gate/config code is red too (the preflight and the child disagreeing means the harness is broken), while other skips (e.g. “old CLI 0.22.0 unavailable”) are named in the summary without turning the run red. Writes **nothing** itself: no temp tree, never `~/.erix`; isolation stays in each step

## release-day
**The release day as one command, minus the half only a human can do** (issue #689, written after 0.30.0 went out with a stale release state): `scripts/release-day.mjs` walks the day in four stages. `--stage preflight` is the §4 checklist in order — `check:changelog` → the `[Unreleased]` carry step (issue #715, an in-process reading rather than a spawned script: **red** when this version's section is open and entries are still parked under `## [Unreleased]`, **not judged** when the carry cannot be read because the version has no section yet or that section already carries a release date, **green** only when the section is open and `## [Unreleased]` is empty) → `check:docs` → `check:docs:strict` → `ERIX_E2E_MODEL=1 check:release:model-e2e` → `check:release` → `check:host-consumers -- --hosts …` — stopping at the first red and naming which step it was, and reporting a gated step that did not run as **not judged** (exit 2) instead of green, so a missing `ERIX_E2E_MODEL` or a `--hosts` directory that is not there can never look like a pass. `--stage publish` **does not fork `npm publish`**: the device-flow scan is the human half, so it prints the pitfalls that have bitten this repository (npm 12 lives at `~/.npm-global/bin/npm` and is shadowed by `/usr/bin/npm`, every publish needs its own device flow, a non-TTY URL is masked, ENTER kills npm, the registry lags after the `+ erix-agent@<ver>` line) and exits 3; `--publish-cmd` is an explicit opt-in that is off by default. `--stage writeback --version <x> --published <x>` is **the discipline this ticket is about**: after a successful publish the release state is written back *before* the tag — `scripts/docs-drift-check.mjs --sync` rewrites only the release-state sentences (the current-version claims in both READMEs, both requirements files and both AGENTS files, plus the current CHANGELOG section's heading — the `（未发布 / unpublished）` marker **and** the release date, written in the same step because they are two halves of the same fact: `--published-date <YYYY-MM-DD>` defaults to today in UTC+8) and leaves every other byte alone; the writeback is then committed and `check:docs` is re-run immediately as the proof that it is self-consistent. That re-run happens **before** the tag exists, so its `check:docs` answers exit 2 with `TAG_MISSING` — the date↔tag half has no truth yet; that is **not judged**, never red, and only when every not-judged reason is `TAG_MISSING` (any other unreadable truth stays red, and `finalize` re-runs the gate with the tag in place). `--stage finalize` clears `src/**/*.d.ts`, creates the annotated tag `v<version>` pointing at the **version-cut commit** (the commit `git blame` reports for the `package.json` `version` line — never the writeback commit), pushes `main` and the tag through `git push origin` (GitHub + Gitea, **never `--force`** — the ban is this script's own discipline, not an external gate: main has no branch protection today, a red CI blocks no merge either, and the live reading of that gate is the single command recorded in the script's finalize ④ comment, quoted nowhere else; the real hazard is that one remote carries two push URLs that each run on their own, GitHub first and Gitea second, while the mirror cron is off, so a force-push would rewrite history already published on GitHub and could update one side while the other silently lags behind, the only detector being the both-sides cross-check that runs after the push — hence a non-fast-forward has to fail the push itself), verifies **both** remote URLs with `git ls-remote` and reds when the two sides disagree, then runs `check:docs` / `check:docs:strict` again. `--all` walks the stages in order and **resumes from the state file** (`$RUNNER_TEMP`/temp dir, never committed): a `phase=published_unwritten` entry — written the moment the writeback starts — means "published, not written back", so a rerun continues at the writeback and never re-publishes, and `finalize` refuses unless the state says `phase=written` and the worktree is clean, so a tag can never go out while the docs still say unpublished. `--dry` writes nothing, publishes nothing, tags nothing and pushes nothing. `node scripts/release-day.mjs --self-test` is the offline reverse proof on synthetic trees and fake runners (a red step stops and is named, a closed gate is not judged, a failed writeback leaves the resumable state, finalize without a writeback is red, two disagreeing remotes are red, `--dry` writes not one byte, a `check:docs` exit 2 is not judged only when every reason is `TAG_MISSING`, and `--sync` touches only the release-state sentences — a hand-moved boundary reds); the case count is printed by the command
**The preflight list is five steps since 261109** (operator ruling): the two documentation steps (`check:docs`,
`check:docs:strict`) were removed, because a script cannot judge a document — it can only judge wording. The
mechanical half of documentation review moved to the periodic agent pass (`doc-review-pass.md`), and the release
keeps only the value-reconciliation family (`check:changelog`, the `[Unreleased]` carry, `check:release:model-e2e`,
`check:release`, `check:host-consumers`).

**Step 2 is the one that watches the carry (issue #715).** Every release used to depend on somebody remembering to insert a `## [<version>]` heading between `## [Unreleased]` and its entries, and nothing moved them or reminded: `--sync` only rewrites a version heading that already exists (a version with no section leaves CHANGELOG byte-for-byte untouched), `check:changelog` reads numeric sections only and compares PR numbers taken from merge subjects, `guide-coverage` only catches "the version was bumped but no section was opened", and the pairing guard only catches a newly opened section that is **empty** (its precondition wants a real entry on each side; an entry left in place makes the judged surface `[Unreleased]` itself, so pairing stays green). So this step answers in **three states**: **red** when this version's section is already open (still in its unpublished shape) and bullets are still parked under `## [Unreleased]` — the verdict names the count, prints the first 60 characters of each entry with its line number, and gives the executable fix (put the `## [<version>]` heading line between `## [Unreleased]` and the entries, exactly the shape of `4963293`; body untouched, `[Unreleased]` left empty); **not judged** (exit 2) when the carry cannot be read — the version in `package.json` has no section yet (cut first: bump, open the section, move the heading) or that section already carries a release date (the previous release is out and those entries belong to the next version, so a preflight that runs *before* the cut is never a false red); **green** only when the section is open and `## [Unreleased]` is empty. It does not parse CHANGELOG a second way: the scan surface is the one `test/static-guards.test.js` already uses (top `## [Unreleased]` down to the next `## `; a renamed top heading reds and names "no version section" instead of passing quietly), the date shape is `docs-drift-check.mjs`'s own, and the version comes from `package.json` rather than a literal.

**The §4 checklist rows are not free prose (issue #731).** The `#   [i/N] <command>` list above the paragraph is a hand-maintained copy of `PREFLIGHT_STEPS`, and `test/release-day.test.js` reconciles it row by row against the script — row count, ordinal sequence, the `/N` denominator (which is computed from `PREFLIGHT_STEPS.length`, so a hand-copied denominator that drifts is caught) and the **command column** (derived from each step's own definition: its `K=V` env prefix, the npm script name, the ` -- --hosts …` suffix for host-gated steps). Both AGENTS files are scanned, so adding a step in the script without adding a row in **both** documents, or renaming a script without editing the column, goes red. An inline-probe step has no `argv` to derive from and must declare `docCommand` explicitly — there is no default, missing is red (fail-closed).

**Why this page is the landing spot rather than a bigger byte budget (issue #731, following #726/#727).** `LENGTH_BUDGETS` in `scripts/agents-directive-scan.mjs` is refreshed by `--sync` in 512-byte steps, and `test/project-instructions-716.test.js` pins that budget against the injection ceiling: the worst two-page combination is 30,720 (global page) + 33,792 (this repository's page) = 64,512 inside a 65,536 ceiling, i.e. **1,024 bytes of headroom**. Raising the repository page one notch eats the headroom and the next sentence added anywhere tips the combination past 64 KiB — which is exactly the defect #721 removed ("the budget gate says it is legal, the injection surface cannot hold it"). So explanatory material about a gate lands **here**, and the directive page keeps one short sentence plus a pointer to this anchor.

**The doc audit is not optional either:** 0.23.0 shipped documentation that the audit would have caught (contract version labels, EN/CN pairing, storage diagrams).

**When preflight answers "not judged", the closing line of `--all` forks on the step id (issue #731).** A gated step that did not run has an **openable gate** (`ERIX_E2E_MODEL=1`, or a `--hosts <dir>` argument); step 2, the `[Unreleased]` carry, has **no gate at all** — it reads facts from `package.json` and `CHANGELOG.md`, so what is missing is an action only a human can take: **cut the version**. One hard-coded "open the gate and ship" sentence told the reader to go look for a gate that does not exist, so `unjudgedConclusion()` now derives the closing line from the unjudged ids (`UNJUDGED_ACTIONS`, two kinds: `open-gate` / `cut-version`) and every step that can answer not-judged must be registered there — `--self-test` reds on a new step that forgot the entry.

## check-long-task-e2e
Standalone real-model long-task E2E for the natural small-window path; it is deliberately not part of
`check:release:model-e2e` while runtime and stability are being observed. `npm run check:long-task-e2e` reads only
the repository's `src/` through local `listFiles` / `readFile` tools and uses a 65,536-token window with an
8,192-token output cap, leaving `budgetTokens` to the engine's normal `computeBudget` derivation. The L1 arm
requests the full `src/loop/orchestrator.js` and asserts the protected-message budget fact plus a non-failed run;
the default runs only L1 (~33 s). Pass `--with-l2` to `node scripts/long-task-real-e2e.mjs` to run both arms; the
full run takes about 13 minutes and uses about 380k tokens. `--l1-only` remains accepted as an alias for the default.
The L2 arm analyzes `src/loop/`, requires at least five `readFile` calls and six rounds before judging the
compaction / ledger / resume invariants, and reports a classified skip if that workload does not materialize.
`ERIX_E2E_MODEL=1` opens the shared real-model gate; with it closed the command prints the categorized reason and
exits 0. It uses the configured default model and a temporary transcript directory, never a hard-coded model name.

## check-cli-real
Gated real model endpoint CLI smoke (ticket 261015 T5, #284/#285 wrap-up): `npm pack` → install the tarball into a
throwaway project → drive the **installed `erix`** (not `node bin/cli.js`) against the real relay with a
≥2-tool task, then assert the exit-code promise (a success without `--final-guard` exits **4**, verification
`skipped`), the `tool_result` field surface in the transcript, and the installed package's own projection.
Runs only under `ERIX_E2E_MODEL=1` (the retired `ERIX_E2E_REAL` no longer opens it -- setting it exits 1 with a line naming both names); with the gate closed it exits 0 and prints a **categorized** reason (gate
missing / config missing / unparsable JSON / missing field / endpoint unreachable). Model name is read from
`slots.default` (`ERIX_E2E_CONFIG` overrides the path). The cross-version suite
(`examples/cross-version-real-e2e.test.mjs`) reads its **old ledger from a committed fixture**,
`test/fixtures/journal-0.22.0/` — a real `erix-agent@0.22.0` CLI product (4 rows, 2 `readFile` calls, plus
state/status/snapshot). That fixture is **read-only: never regenerate it in place** (regenerating rewrites the
bytes and the point of the test is that the bytes are what 0.22.0 actually wrote). Only the resume half needs the real model endpoint, so with the gate closed the suite still runs its offline half (2 pass / 0 skip) instead of
skipping wholesale. Two sibling gated suites: `examples/tool-fact-e2e.test.mjs` and
`examples/pi-extension/erix-run-e2e.test.mjs` (same gate; they skip under `npm test`, so the real model endpoint is never a hard dependency of the default suite). Needs `node_modules`; self-cleaning, and it never writes the
real `~/.npmrc` or `~/.erix/config.json`

## check-docs-spelling
**Blocking gate** (issue #560) for retired flat option spellings in the living docs (`scripts/retired-spelling-scan.mjs --strict`; the scanner is issue #523's): the retired set is derived from `CONFIG_SURFACE_OPTION_NAMES` minus `RUN_TOOL_LOOP_OPTION_NAMES` (never copied), hits count only in code context (fences and inline spans; `config: { … }` subtrees are skipped as leaf names, and `AMBIGUOUS_KEYS` — names that are also a parameter/field of something else — stay out of the verdict), and every **tracked** doc on the surface — `docs/**/*.md` plus the two root READMEs (issue #572) — is classified **by path**: current-state (`architecture*`, `charts*`, `requirements*`, `testing*`, `maintenance-policy*`, `soak.md`) must spell the current API; history (`decisions/*`, `v0.*`, `design/*`, `research/*`, `harness-comparison/*`, `suggestions/*`, `issue-469-*`, `tasks/*`, `host-upgrade-guide-*`), the contract (`host-consumer-contract*`) and the root docs (`README.md`, `README_cn.md` — the root-doc class, issue #572) keep their body byte-for-byte and are pinned by hit count (`ROOT_DOC_BODY_PINS` for the root docs; `SUSPECT(dropped)` = someone rewrote history into canonical form, `SUSPECT(raised)`, and `UNPINNED` = a history/contract/root-doc file with hits and no pin; pins may only name **tracked** files — a pin pointing at a path outside the manifest is a `DEAD-PIN` and red). **The file list comes from `git ls-files` only** (issue #560): the scan surface is the **tracked** `docs/**/*.md` plus the two tracked root READMEs (issue #572 — an **explicit** pathspec list, `SCAN_PATHSPECS`, never `.`, so the surface cannot silently become the whole repository), never a filesystem walk, because `docs/tasks/` and `docs/delivery/` are gitignored local archives — walking the disk made the same repository content answer `--strict` exit 1 in a developer tree and exit 0 in a clean clone (CI runs the clone, so that red was never visible). If `git` is unavailable, the directory is not a repository, the repository top level is not the scanner's own directory, or the manifest is empty, the scanner **fails loudly with exit 2** and **never** falls back to a filesystem walk (a silent fallback would leave the two-answer defect in place, just harder to see). **A `docs/**.md` in none of the lists is scanned as current-state** — the “this ticket did not cover it” class is gone, unknown is never exempt. `check:docs` reads no option spelling at all, which is why this is its own blocking step right after `check:docs:strict`; `node scripts/retired-spelling-scan.mjs --self-test` is the guard's own reverse proof (blocking, 22 cases; it scans a **copy of the tracked surface** for real and mutates it — three of the cases are the issue #572 surface-widening reverse proofs: a flat spelling dropped into `README.md` reddens both `--strict` and `--strict --json` and restoring it greens both, a root-doc pin that no longer matches is `SUSPECT(dropped)`, and a root-doc pin pointing outside the manifest is a `DEAD-PIN`). `--strict --json` is **the same gate** in machine-readable form (issue #575): the red set (`gateVerdicts()`) and the red-count-to-exit-code rule (`gateExitCode()`) exist once and both output branches only read them, so `--strict --json` answers exit 1 on a red surface exactly like the text branch does, and the JSON carries `gate.{strict,gating,mode,red,counts,exitCode,wouldExitCode}` — before #575 the `--json` branch set `process.exitCode = 0` unconditionally and every machine consumer read red as green. Report mode (`--json` without `--strict`) keeps exit 0 but still reports the same red count with `gating: false`

## check-agents-directives
**Blocking gate** (issue #726; the three text heuristics were removed by issue #909) for the **instruction face** — `AGENTS.md` / `AGENTS_cn.md`, the page every session injects and executes without verification. After #909 this gate has exactly **one** criterion: the **byte budget** (described in the paragraph below). The three text heuristics it used to run — a work-order status claim, an expiring measurement copy, and a bare source coordinate — together with their exception register, their per-file per-class debt-ceiling table, their own `--sync` path and their `--self-test` fixtures were all deleted. **Intentional behavior change (#909):** writing a fake version number, a stale measurement copy, or a bare coordinate into `AGENTS.md` / `AGENTS_cn.md` **no longer goes red here** — that "read the text and guess the semantics" job is owned by `check:docs`'s version reconciliation, not by this byte-budget gate. The file list still comes from `git ls-files` only (the #560 red line: no filesystem fallback), and `node scripts/agents-directive-scan.mjs --self-test` still exists but now exercises only the byte budget (its fixture: injecting 2 KB of junk into a synthetic `AGENTS.md` must go red, restoring must go green). `--sync <file>` is the only legal way to change a budget cell, `--verify <file>` reds on any cell not equal to the derived value (hand-copied = red both directions), and the CI step runs both

**Byte budget (issue #726 — the one block on this page that was *not* moved out of `AGENTS.md`).** The instruction face is part of the system prompt and folding does not touch it, so every byte here is re-sent on **every** turn; issue #726 therefore made length itself a criterion, judged as criterion ⑥ of `--strict`. The budget is **derived state, never a hand-written number**: `budgetFor(measured) = ceil512(measured) + 1024`, i.e. the measured byte count rounded up to the next 512-byte boundary plus a 1,024-byte headroom (total headroom ≤ 512 + 1,024 = 1,536 bytes, deliberately under 2,048: headroom is "how much this page may grow without going red", and a few kilobytes of it would turn the criterion into decoration). `--sync <file>` is the **only** legal way to change a cell — it writes exactly `budgetFor(measured)` and leaves every reason comment alone. `--verify <file>` reds on **any** cell that is not equal to that derived value, so a hand-copied budget is red in both directions, too high and too low, and the CI step runs `--strict` and `--verify` both. `--strict` itself is the ratchet: measured > budget ⇒ red, naming the measured bytes, the budget and the overflow (tokens folded at **3.4 bytes/token** — a 2026-11-05 relay measurement that is *not* a constant and is used for reporting only, never for judging); measured ≤ budget ⇒ green, which is exactly what the headroom is for. An **idle** cell is red on the same convention as the rest of this gate: a budget row whose file has left the instruction face (a dead entry), or a budget written as 0 (a cell that can never hold). The remedy for a real overflow is to move reference material onto this page, not to raise the budget; raising it needs a reason in the report and still only happens through `--sync`.

## types-build
Generate the published `.d.ts` into `src/**/*.d.ts` and keep them (issue #213; the `prepack` hook runs the same script)
Assertion gate: `tsc` exit 0 / declaration count > 0 / `src/index.d.ts` contains `runToolLoop` / `src/tools/index.d.ts` contains `createFileTools`, then delete the artifacts (issue #213; needs `npm install --include=dev`)

## type-ratchets
`--checkJs` **ratchet**: counts the type errors reachable from `src/index.js` and fails if the total exceeds the baseline constant **98** in `scripts/type-check-ratchet.mjs` (issue #214; ratchet = never up, going down is a pass with a "you may lower the baseline to N" hint; both tiers are counted and lowered in one commit, and the round-by-round history of that total lives in the header comment of `scripts/type-check-ratchet.mjs` — the command prints the current total, the per-file distribution and the "you may lower it to N" hint, so no count beyond the two baselines is copied here). **Delete the generated `src/**/*.d.ts` first** — see the `--checkJs` ratchet rule below. `-- --with-tools` widens it to the `./tools` entry (baseline **133** / 28 files)
- `--checkJs` ratchet rule (issue #214): `npm run check:types` does **not** aim for zero errors — 98 of them
  (26 files) are accepted debt (the #214 measurement was 218; issue #177 knife 1 took one off
  `src/loop/orchestrator.js` by annotating `resumeRunSnapshot`; PR #249 — the #213 provider-factory JSDoc — took
  75 more, **all of it in two files**: `src/providers/openai.js` 46 → 7 and `src/providers/anthropic.js` 45 → 9,
  the other 27 error-carrying files moved by zero; issue #265's `src/store/notes.js` refactor took 21 more, again
  **all of it in one file**: `src/store/notes.js` 27 → 6, the two new `// @ts-check` modules
  (`src/store/notes-port.js`, `src/store/notes-memory.js`) contributing 0, and the other 28 error-carrying files
  moving by zero — verified file by file against the `7354fab^` tree exported with `git archive`, which reproduces
  142 / 185 verbatim). What it guarantees is **never up**: the total is compared against the
  `BASELINE_ROOT = 98` constant in `scripts/type-check-ratchet.mjs` (lowered to **98** on 2026-11-22 by
  PR #885, where the reading was 98 / 26 files; the parenthetical below is history, not the current value —
  re-measured 2026-11-01 on the #661 wrap-up tree **at 102**, where the −4 is `src/compact/fold-llm.js` 5 → 1; the same day's earlier #177 slice-4 round read 107; 2026-10-31 on `c92c8fa` read 108
  with `typescript@5.9.3` + `@types/node@22.20.5`, **both tiers lowered in the same commit**: 110 → 108 and
  146 → 144, two units each, the whole of it `src/loop/orchestrator.js` 14 → 12 (the `deliverablesAllPassed` /
  `deliverablesFailures` block extracted two inline expressions into typed locals — a refactor side effect, not a
  deliberate type fix); the earlier 2026-10-31 round read 116 → 110 and
  152 → 146, six units each; the 2026-10-23 round before it read 117 → 116 and 153 → 152, one unit each; the 2026-10-21 round read 117 / 153 and 2026-10-15 read 119 / 162, all now
  **historical values**; the 226 in the issue body
  reproduces on the pre-#213 tree `bc3ad02`, which is why the number committed at #214 was 218 and not 226).
  **Which half to pay down first**: some errors sit in files a host can actually reach; others live in
  implementation-only modules, and all 21 units the `src/store/notes.js` refactor removed
  fell on the public half, since `src/store/notes.js` is itself inside the public closure. Which files sit on which
  side is decided by the `src/index.js` reference closure; the per-file counts are printed by
  `node scripts/type-check-ratchet.mjs --verbose` and the individual errors by `--show-errors N`, so neither the
  split nor the round-by-round history is copied here — every round that lowered a baseline says in the commit
  that lowered it which file lost how many units. Admission rules for the whitelist:
  - **New files must open `// @ts-check` on line 1.** It is a declaration of intent, not the scope control:
    `--checkJs` plus `src/index.js` already pulls the whole import graph — `--listFiles` prints how many files under
    `src/` that one entry reaches (the number lives in that output; the 65 recorded on 2026-10-21, the 58 on
    2026-10-13 and the 56 before #265 are **historical values**),
    **26 of them carrying errors** — so picking "just the public entry" as
    the input file narrows nothing; the whitelist has to be per-file, which is exactly what #214 R2 asks for.
  - **Touching a file whose error count can go down is a drive-by opportunity** (the #179 pattern: fold it into
    the PR that is already in that file, never a standalone ticket). When the total drops, lower the baseline
    constant in a **separate commit** and say which file lost how many errors — the value of a ratchet is that
    the number only shrinks.
  - ⚠ **Delete the generated declarations before running it.** tsc resolves `./x.js` to a sibling `x.d.ts` first,
    so after `npm run types:build`/`prepack` the ratchet would be checking declarations instead of
    implementations: **98 errors** with none present (the constant's value) against **0 errors** with the
    declarations present, because `--skipLibCheck` skips declaration files; drop `--skipLibCheck` and the same run
    reports a small set of errors that all point at `.d.ts` files (the command prints that count and those files).
    The declaration count itself is the one `check:pack-links` reconciles, not a copy here; the earlier readings
    (61 / 63 / 64 / 65 / 71 / 72) are **historical values**.
    "0 errors < baseline" would be a **false green**, so the script hard-fails on
    stale `src/**/*.d.ts` (the repository commits zero `.d.ts`, so their presence always means generated).
    Fix: `find src -name '*.d.ts' -delete` — they are git-ignored and regenerable.
  - Known hole, deliberately left open by the spec: the second public entry `src/tools/index.js` pulls in
    `src/tools/file-tools.js` and `src/skills/loader.js`, which the package-root graph never
    reaches, so new errors there are **not** caught by the default gate. `npm run check:types -- --with-tools`
    gates the union (baseline **133** / 28 files = 98 + 19 + 16, counted together with the fix that lowered it;
    **both tiers now have their own CI step** — the `--with-tools` steps sit right after the package-root ones, so
    a stale constant here reds like any other, issue #653). The per-file counts behind that union are printed by
    the command (`--verbose`), and gating that union is the cheap way to tighten this later; which file lost how
    many units in which round (issue #409's `parseToolArguments` routing, `parseJsonWithRepair`'s `@returns`, the
    `markerCount` narrowing of issue #356) is kept in the commits that lowered it, not here.
    ⚠ The retired 261 had quietly kept the one unit #177 took off `orchestrator`, because that tier was never
    re-measured: **lower both tiers in the same commit**, after measuring both.
  - Toolchain allowance (issue #213, restated here for #214): `typescript` + `@types/node` may stay dev-only —
    the zero-runtime-dependency red line constrains what `src/`/`bin/` import (`node:` builtins + relative
    paths), and this gate adds no dependency either (only `node:` builtins, no tsconfig, no new tool).
  - **Measurement discipline (issue #653), and it binds every ratchet and every derived table in this repository**:
    - **Take derived numbers and baselines on the final tree only.** A baseline, a derived table and a coverage
      floor are each a snapshot of the tree they were taken on; taking one while a sibling branch is still
      arriving yields a number for a tree nobody will ever build on.
    - **Rebase before measuring.** When this branch's base is behind `main`, rebase onto `main` first and take
      the numbers after that — a number read off a stale base describes a tree that no longer exists.
    - **A debt slice and its baseline / derived-table update go in as one PR, atomically.** Several commits
      inside that PR are fine (the review boundary stays readable), but the two halves arrive together: lowering
      debt without lowering the constant — or without refreshing the derived table — must never reach `main` on
      its own, because that intermediate state is exactly what made the strict ratchet's reverse proof disagree
      with the tree (issue #653).
- `--strict` ratchet rule (issue #417): the same `tsc` invocation as the `--checkJs` ratchet with `--strict`
  appended, compared against its **own** pair of baselines (`BASELINE_STRICT_ROOT` / `BASELINE_STRICT_WITH_TOOLS`
  in `scripts/type-check-ratchet.mjs`), is a **blocking** ratchet since #417 — #416 introduced it as an observation
  point (print the number, gate nothing) and the debt kept growing while nothing blocked on it. The contract is
  word-for-word the non-strict one: above the baseline ⇒ exit 1 with the over-count named, equal ⇒ green, below ⇒
  green plus a "you may lower it to N" hint, and **both tiers are measured and lowered in one commit**. The two
  totals are independent measurements, not a delta — never derive one from the other, and never copy either into a
  document (the constants are the only truth; the `check:types:strict` row in the command table says the same).
  **#417 only adds the gate**: the baseline is the total at introduction, the existing debt is paid down file by
  file in later slices, and what reds is a *new* strict error — including one added to a file the graph already covers.
  The measurement discipline stated in the `--checkJs` rule above binds this tier verbatim: derived numbers and
  baselines are taken on the final tree only, the branch is rebased onto `main` before that reading, and a debt
  slice arrives together with its baseline update in one PR — several commits inside it are fine, but the
  "debt lowered, baseline not lowered" state never reaches `main` alone (that is the state in which this tier's
  reverse proof and the tree disagree, issue #653).
**The strict ratchet — it blocks** (issue #417, upgrading the #416 observation point): re-runs the *same* `tsc` invocation as `npm run check:types` with `--strict` appended (same entry files, same dependency graph, same `typescript` + `@types/node` pair) and compares the total against the `BASELINE_STRICT_ROOT` / `BASELINE_STRICT_WITH_TOOLS` constants in `scripts/type-check-ratchet.mjs` — the same never-up contract as the non-strict ratchet, and the two tiers are counted and lowered **in one commit** (lowering only one tier just moves the difference onto the other). Above the baseline ⇒ exit 1, naming how many over and the top files; equal ⇒ exit 0; below ⇒ exit 0 plus a "you may lower the baseline to N" hint. The strict totals live in those two constants only — do not copy them here, and never use one tier's number to lower the other tier's baseline (they are two independent measurements, not a strict/non-strict delta). This ticket **adds the gate and pays no debt**: the baseline is the total at landing, so the existing strict debt stays green while a **new** strict error reds. A non-zero exit also means the script could not run — tsc missing, tsc exiting non-zero with nothing parsed, generated `src/**/*.d.ts` present (the shared stale-declaration guard rejects that instead of reporting a false zero: `npm run types:build` then this command exits 1), or a total of zero against a non-zero baseline (check-surface failure, not "debt repaid"). `-- --with-tools` runs the `./tools` union tier, `-- --verbose` prints the full distribution, `-- --show-errors N` locates individual errors

## check-mutation
**Committed mutation-sample table verification — DELETED (#906)** (was issue #257 T7): this step used to re-derive the table's three derived columns — anchor line number, anchor sha256 prefix, occurrence count — plus its summary line from the tree and diff them against the committed copy (`node scripts/mutation-sample-check.mjs --verify`, with `--sync` as the only legitimate way to rewrite those columns). That copy drifted, and the drift did not just make the copy red: when it did, the *real* judge `--run` refused to run too (running a mutation against a drifted copy = mutating the wrong line), so a stale transcription dragged the one true signal down with it. The mutation samples now live as a **semantic-only list** in `scripts/mutation-samples.mjs` (id / face / file / anchor / mutation / catcher / signature) — no line number, no sha, no hit count — so a code drift no longer requires re-syncing a table; the surviving machine evidence is `--run` below, which reads line numbers fresh from the tree and checks anchor liveness / uniqueness itself.
**The samples actually bite** (issue #257 T7): `node scripts/mutation-sample-check.mjs --run` walks every sample, writes the mutation into the real file, runs that sample's catcher through `node --test`, and requires a **non-zero exit whose `not ok N - …` line contains the sample's expected-red signature** — a passing `ok N -` line does not count, and neither does an unrelated red, because "exited non-zero" alone is also what a syntax error, a missing module and an already-red baseline produce. It then restores the file and requires **green**, which is what makes the red attributable to the mutation rather than to the tree. A mutation that does not apply is a **failure, not a pass** (the #210 R2 convention: the replacement silently returns the text unchanged, which would make the criterion vacuously true). Restores are verified byte-for-byte and hooked to `SIGINT`/`SIGTERM`; this is the only CI step that writes tracked sources, so it runs **last**. Every sample runs twice (mutated + restored); the sample count and the elapsed time are printed by the command, so neither is copied here

## check-exports
**已删除（#904，2026-11-25）。** 用户裁决：库不该管谁在用、更不该管别人电脑上装了什么。
原来的「公开面零消费者」清点与闸整套删掉；它量的那张面（开发树里的引用计数）没有人会跑，
而且「发布面」按目录前缀判、连不随包发布的 `*.test.js` 都算成消费者。
保留：`scripts/guide-removal-gate.mjs`（比安装包导出面 vs 指南声称，不看任何用户）。

## check-exports-deprecated
**已删除（#904，2026-11-25）。** 见上一节。`REMOVAL_REGISTRY` 里「已知破坏」的记录职责已随机制一起删除。

## check-host-consumers
**已删除（#904，2026-11-25）。** 扫宿主仓等于管别人的电脑；`release:day --stage preflight` 因此从 5 步变 4 步。

## check-inventory
Compatibility-pin write-point allowlist verification (issue #534; the 110 KB ledger deleted in #907): `node scripts/flat-count-inventory.mjs . --verify` re-derives the flat-spelling write points straight from the AST of every scanned test file and checks them against the whitelist `scripts/compat-pin-allowlist.mjs` — it exits 1 and names the file / face / count when (a) a file outside the list writes a retired flat spelling, or (b) a whitelist entry points at a file that no longer exists. It prints its own elapsed time and peak memory (both stay in the low seconds / low hundreds of MB), so it blocks in CI as `Compatibility-pin inventory verify`, placed after `Test suite` and before `Test hygiene guard`. The ledger (every file's point count copied into a committed table, refreshed with `--sync` on every code change) is gone: **`--sync` no longer exists and the gate no longer compares per-file counts** — a listed file's point count may change without reddening (an intentional behaviour change over the old ledger). To print the live AST truth the allowlist is generated from, run `node scripts/flat-count-inventory.mjs . --files` / `. --keys`. Cold note: the ledger was deleted because #498's migration slices were all done and the table only carried history; the one live judgement it doubled as — "an unregistered file may not write the retired flat spelling" (the 0.28 breaking retirement) — is exactly what the whitelist keeps

## check-config-leaf-values
Config-leaf value status table verification (issue #586): `node scripts/config-leaf-value-probe.mjs --verify docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md` re-runs the probe (every schema leaf × 8 fixed wrong values, each fed through a real two-round `runToolLoop`) and compares the regenerated EN/CN tables with the committed ones — any drift exits 1 and names the file. The probe **measures** the verdict per cell instead of asserting a wish: `G` / `V` refuse at the `config` gate / semantic phase, `S` refuses at run startup **and names the leaf**, `C` blows up at startup **without** naming it, `U` throws only after the first request, `A` is accepted-and-live (the run's fingerprint changed), `·` is accepted-and-inert (identical fingerprint). The refusal layer comes from the **stack frame** (file + function, never a line number, so unrelated refactors cannot redden it) and the effect from the **first differing path** in the fingerprint, so "silently accepted" is a location plus a pair of values rather than an adjective. `--sync` is the only legitimate way to refresh the table (hand-editing a number is fabrication), and the probe refuses to emit a table at all (`exit 2`) when `configSchemaSelfCheck` is red or when three baseline runs disagree — an unstable fingerprint would turn `A` / `·` into noise. It prints its own elapsed time (about a second), so it blocks in CI as `Config-leaf value status verify`, right after `Compatibility-pin inventory verify`. **It narrows nothing**: every type check shrinks the accepted surface ⇒ it must be booked as Breaking, and that ruling stays with the maintainer

## registry-updates
Use the table's owning generator to refresh derived cells; do not hand-edit them.

| Registry | Only generated update command |
|---|---|
| Compatibility-pin allowlist (regenerate from AST) | `node scripts/flat-count-inventory.mjs . --files` (or `. --keys`) to print the live AST truth; rebuild `scripts/compat-pin-allowlist.mjs` from `--files` |
| Config-leaf status (EN and CN) | `node scripts/config-leaf-value-probe.mjs --sync docs/config-leaf-value-status.md docs/config-leaf-value-status_cn.md` |

There is no longer a registered suite-summary floor to keep in sync: the reconciler and its registered floor
were deleted in issue #905 (keeping a registered total in sync was bookkeeping tax, not a judgement, and there was
deliberately no `--sync` because raising a floor was a human act). The CHANGELOG pairing guard in `test/static-guards.test.js` registers **no number at all**: the
`CHANGELOG_PAIR_FLOOR` calibration (a pair count measured on one section, only-up) was deleted in PR #826 --
it went stale at every release window and a human had to re-measure it, while what actually guards coverage
is "no entry on either side lacks a counterpart" plus "the judged face has a real entry on each side", both
of which self-calibrate. Deleting an entry **on both sides** belongs to the periodic documentation pass
(`docs/maintenance/doc-review-pass.md`), not to a registered count.

## cli-local
Run the CLI locally (no installation required)

## ci
- **`.github/workflows/ci.yml` runs on no event since 2026-11-25** — the `pull_request` and `push` triggers were
  retired by operator ruling (over the preceding fortnight 6 of its 9 reds were derived-table bookkeeping, 0 were
  `src/` behaviour regressions). Only `workflow_dispatch` remains, and the `main` gate is the ruleset
  `main-require-pr` (a PR is required, no status check is). **The consequence is the organising fact of this
  section: a step that no event triggers is a dashboard, not a gate** (issue #908 R2). "It runs in CI" in this
  repository means "it runs when somebody clicks".
- **One job, three kinds of truth** (261126, issue #908 R2). The workflow keeps only what a clean checkout or a
  second node major version can prove:
  - the full suite on **node 22 and node 24** with `fail-fast: false`. 22 is the declared `engines` floor *and*
    what the hosts actually run, so the pipeline verifies the runtime users are on; 24 is where agents and newer
    hosts land. Issue #774 added the second entry because **a judgment that only holds on one runner is not a
    judgment**: the mutation case in `scripts/mutation-sample-check.mjs` spawned its child without naming a
    reporter, Node 24's default reporter is spec, so the `not ok …③…` line it asserts on could never appear — and
    a single-entry matrix can never see the other entry's red. `npm test` pins `--test-reporter=tap` in
    `package.json` for the same reason (issue #301): the reporter a run emits must be named in argv.
  - the four `tsc --checkJs` ratchet tiers as **four separate blocking steps** with no `continue-on-error`;
    `test/type-check-strict-ratchet.test.js` pins that all four are present, none is advisory, and each tools-tier
    step follows its own root-tier step. `check:types-build` runs after them: it writes `src/**/*.d.ts`, and a
    declaration sitting next to its source makes `tsc --checkJs` measure declarations instead of implementations.
  - the clean-environment trio, each under `if: matrix.node == 22`: `check:release` (real tarball → real install
    → contract suites → CLI smoke), `check:pack-links` (the shipped surface is read out of a real pack) and
    `check:mutation:run` (it temporarily rewrites tracked sources, so it goes last, after the suite is green, so a
    red is attributable). **This trio is the irreducible reason the file exists**: "green in the development tree,
    red in a clean checkout" (issue #914's class) cannot be seen any other way.
- **What left, and where each piece went** (issue #908 R2). `ci.yml` is the step list; this page does not copy it.
  - Second-scale code gates moved **into the suite**, because that is the only place that runs every time:
    `test/gate-self-tests.test.js` spawns `syntax-check`, `test-hygiene-check` (verify and `--self-test`),
    `mutation-sample-check --self-test`, `pack-link-check --self-test` and `config-leaf-value-probe --verify`, and
    one of its cases pins that none of those commands creeps back into `ci.yml` as a duplicate step.
  - Duplicates deleted outright: `check:inventory`, `guide-removal-gate --self-test` and `release-day --self-test`
    were already spawned by `test/flat-count-inventory.test.js`, `test/guide-removal-gate.test.js` and
    `test/release-day.test.js`.
  - The doc family (`check:docs`, `check:docs:strict`, `check:docs-spelling`, `check:docs-examples`,
    `check:agents-directives`, `check:changelog`) lives at the version boundary where it is wired —
    `check:changelog` blocks as `PREFLIGHT_STEPS[0]`, `check:docs` re-runs inside `release:day --stage writeback` —
    and otherwise on the scheduled agent pass (`doc-review-pass.md`, entry `npm run docs:pass`). The operator
    ruling behind this is #802: a script can only judge wording, and that class produced the 25% red rate
    (138 pass / 49 fail / 13 cancelled over 200 runs; 9 of 12 sampled failures were registry drift, not
    behaviour) while catching almost no defect. `docs-drift-check --self-test` is minutes-slow and belongs to that
    pass, not to a per-commit gate (one-off timings: ≈7 min on 261109, ≈8.5 min on 261126 over 219 cases).
  - `check:cli:model-e2e` left CI: with `ERIX_E2E_MODEL` unset it exits 0 with a categorized reason, so as a CI
    step it only spun; the real endpoint run is preflight step 3.
- **Invariants that are not about steps**: install is `npm install --include=dev`, **never** `npm ci` —
  `package-lock.json` is gitignored on purpose and the two dev packages (`typescript`, `@types/node`, issue #213)
  are exactly what `check:types*` / `check:types-build` / `check:pack-links` / `check:release` need.
  `fetch-depth: 0` stays even though no step needs full history now (it used to be `check:changelog`'s hard
  precondition, issue #691): on a shallow clone a future tag-reading judgement comes back vacuous and green
  instead of red. `npm run soak` needs a real relay configuration and key ⇒ **never** in CI. Gitea is a code
  mirror: **no** Actions pipeline there, GitHub stays the single runner. `POST …/dispatches` answers **404** until
  GitHub has seen this workflow once — a branch push plus any run registers it, then dispatch returns 204.
- **`continue-on-error` is gone with the `registries` job**: "visible on a PR but not blocking" had nothing left
  to stratify once no event triggered the file. `npm run release:day -- --stage preflight` remains the place where
  the behaviour, changelog and packaging families are all blocking at once (`PREFLIGHT_STEPS`).

## gate-reproducibility
- Gate reproducibility (issue #280): `npm run check:docs` and `npm run check:docs:strict` must exit 0 both in a development worktree and on a **fresh clone** (`git archive HEAD | tar -x -C <empty dir>`). The “local archive” class — files under `docs/tasks/`, a directory that is gitignored on purpose and therefore absent in any clone — is adjudicated by its **declaration** (an entry in `LOCAL_ARCHIVE_REFS`, or an in-line statement next to the reference); the physical file is verified only as a bonus when that directory happens to exist, and its absence never turns the gate red. The gates that genuinely have a local prerequisite are the ones that need `node_modules` — the two dev packages `typescript` + `@types/node` (issue #213): `npm run check:inventory` (it parses every scanned test file with the TypeScript AST), `npm run check:types`, `npm run check:types:strict` and `npm run check:types-build` (all three drive `tsc`), and `npm run check:pack-links` / `npm run check:release` (they shell out to `npm pack`, whose `prepack` hook regenerates the declarations, plus `tsc`). In a checkout without `node_modules` those exit non-zero with `Cannot find module 'typescript'` — that is “the gate could not run”, never a regression; `npm install --include=dev` first. No other gate reads the toolchain.
- **Concurrent judgment (issue #799)**: never read `npm run check:docs`, `npm run check:docs:strict` or `node scripts/docs-drift-check.mjs` while `npm test` is still running in the same tree. Measured twice on one **committed** tree: with the suite in flight the command exited **0** and reported zero findings; the same tree, rerun after the suite had exited, exited **1** naming 20 drift items (`bare-lines` above its ratchet baseline, plus `cell-axes-anchors` read-column mismatches in both contract languages). After the drift was actually fixed, both shapes came back green — so the red was real and the green was the lie. This is the **silent-success** shape of failure: the exit code is exactly what the next reader consumes, and the wrong answer is the reassuring one, so "be careful" is not a control. **CI is not affected** (its steps are serial, see `ci`); only a local shell that overlaps a suite run triggers it. Until the attribution lands the ruling is procedural: **let the suite exit, then rerun, and treat only the clean run as the judgment** — a scan that overlaps another writer is *undetermined*, not a pass (the same rule issue #511 applies to a closed gate: not running is not a pass). Attribution is open in #799; the lead that the scan surface may pick up `src/**/*.d.ts` files that a suite member generates and deletes mid-flight is **a lead, not a finding** — whoever verifies it writes it here, and nobody copies it forward as fact.

## type-surface
- Type-surface rule (issue #213): `src/**/*.d.ts` are **generated, never committed** (`.gitignore` covers them); `files` already ships
  `src`, so the tarball carries declarations the repository does not. The `prepack` hook regenerates them on `npm pack`/`npm publish` and
  must log to **stderr only** — lifecycle scripts inherit npm's stdout, and `scripts/pack-link-check.mjs` parses `npm pack --dry-run --json`.
  Two JSDoc shapes silently degrade a parameter to `any` (no compile error, discovered only by reading the emitted `.d.ts`, both fixed in
  #213 R4): a **standalone `//` line inside an inline `@param {{ … }}` type literal**, and a **doc block that is not the comment directly
  above its declaration**. When a host-facing signature matters, read the generated `.d.ts`, not the source comment.
  Declarations are generated by the `prepack` hook, so a clean checkout has none — **how many a packed install lists is whatever
  `npm run check:pack-links` reports** (it reads the count out of the `npm pack` inventory and reconciles the claim in the four entry
  documents; this page deliberately carries no copy of the live number). Historical readings below, each measured on the tree named
  there, never the present value: **88** on the tree where issue #743 added
  `src/loop/event-tiers.js` — the event tier table, re-exported at the entry — to the declaration graph; before that
  **87** on the tree where issue #688
  took `src/tools/providers.js`, `src/providers/anthropic.js` and `src/config/env.js` out of the declaration
  graph — their only public re-export retired, so nothing imports them from the entries any more; before that
  **90** on the tree that added `src/loop/judge-runner.js` to the declaration graph; before that **89** on the #643 tree, since that slice
  added `src/compact/budget-fit.js` to the declaration graph; before that **88** on the #246 first-slice tree, which
  wired `src/loop/state-view.js` into the declaration graph so its declaration ships as well; before that **87**
  on the #626 C1 tree, since that slice added
  `src/tools/delegation/tail.js`; before that **86** on the #617 P1b tree, since that slice added
  `src/tools/delegation/tool.js`; before that **85** on the #617 P1a tree, since that slice added
  `src/tools/delegation/roster.js`, `src/tools/delegation/capacity.js` and `src/tools/delegation/notify.js`; before
  that **82** on the #568 tree, since that slice added
  `src/loop/continuity-block.js`; before that **81** on the #498 S4a tree, since that slice added
  `src/loop/capabilities-namespace.js`; before that **80** on the #497 tree, since that slice added
  `src/loop/config-namespace.js`; before that **79** measured 2026-10-25 on the #462 tree (exactly 79 since that
  slice added `src/compact/resume-fold-trim.js`; before that 78 measured 2026-10-24 on the #460 tree (exactly 78,
  since that slice added `src/compact/fold-archive.js`); before that 77 measured 2026-10-23 on the #406 B2-a tree, since that
  slice added `src/normalization/parse-model-json.js` and `src/config/slot-provider.js`; before that 75 since #409 added
  `src/text/repair-json.js` and `src/messages/tool-arguments.js`; before that 73 since #404 added
  `src/loop/resume-notice.js`; before that 72 since #394 added `src/loop/pending-tool-result.js`,
  71 since #386 slice 2 added `src/loop/deliverables.js`,
  70 since #333 added `src/store/message-rows.js`, 69 since #326
  added `src/store/transcript-dedup.js`, and #322 added `src/compact/fold-summary-journal.js`). **That number is reconciled against the tarball
  contents by `npm run check:pack-links` — never hand-copy it into these two files; the gate names the document and the line.**
  Historical values, kept as history: 67 (post-#307, measured 2026-10-16), 66 (after #305 added `src/text/json-candidates.js`),
  65 (post-#292, 2026-10-15), 64 (the 0.20.0 tarball), 63 (the 0.19.0 era); the 0.18.0 packed / unpacked size delta is history too (the tarball prints its own sizes).
  `npm run check:types-build` is the gate that they still generate.

## unattributed-merges
One more human pass before the tag, and it is the only thing standing between an unnamed public change and a released tag: when `check:changelog` prints its **`unattributed`** note — a merge that touched the public surface but whose subject carries no issue number, so the gate cannot attribute it to any entry — it **prints and does not block**, by design (a merge subject is prose, and demanding that some entry name it is not achievable). For every short sha in that note, read its first-parent diff (`git diff --name-only <merge>^1 <merge>`) and either confirm the public change is already described in this version's CHANGELOG section, or write down a reason a later reader can check. That list is printed on purpose so this step has an input; nothing in the machine gates will do it for you.

## npm-policy
- ✅ **The only path (`npm@12`)**:
  ```bash
  npm i -g npm@12                    # 升级（系统 npm 10 不支持新流程）
  npm login --auth-type=web          # 浏览器 OAuth + passkey
  npm publish                        # device flow：终端打印认证 URL
  ```
- **Publish interaction (verified in 2026-09)**: even after `npm login`, `npm publish` still triggers **a separate device flow authentication** (EOTP; each publish requires authentication again, rather than being covered by login) — the terminal prints `https://www.npmjs.com/auth/cli/<id>`; copy it into a browser, scan/confirm the passkey with a phone camera, and the command line continues automatically.
- ⚠️ **Prerelease versions require an explicit `--tag`** (enforced by npm12): `npm publish --tag latest`; otherwise it reports `You must specify a tag when publishing a prerelease version`.
- ⚠️ In non-TTY environments (scripts/pipes), the authentication URL is masked as `***` — **the user must run it in their own terminal**; on the agent side, use the Python pty approach to capture the real URL for the user (see pitfall 4).
- ⚠️ **Do not press ENTER at the "Press ENTER to open in the browser..." prompt** (verified in 2026-09): without a browser, pressing ENTER triggers `xdg-open` to fail and kills npm (`command failed`, code 3). If ENTER is not pressed, npm continues polling the authentication status and completes normally.

## local-runtime-data
## 6. Local runtime data (not committed to the repository)

```
~/.erix/
├── config.json        # LLM config (endpoint/model/apiKey/maxOutputTokens/contextWindowTokens)
├── mcp.json           # MCP server registry (standard format; can reuse ~/.config/mcp/mcp.json)
├── <session>.json     # session history (id derived from cwd)
├── transcripts/
│   ├── <runId>.jsonl          # metadata-only round rows + one row per message (`kind:"message"`, `seq` / `partOf?`); `load()` folds them back into round rows
│   └── outputs/<runId>/       # everything archived for this run: tool captures, reports, judge.log
│       └── judge.log          # judge decision JSONL (written here by default; override with --judge-log / ERIX_JUDGE_LOG)
├── skills/            # user-level skills (self-describing protocol)
└── todos/             # task lists (isolated per cwd)
```

- **Judge logs have a fixed home**: `transcripts/outputs/<runId>/judge.log`, same directory and lifecycle as the transcript/tool captures; supervisors should inspect judge behavior here instead of relying on `/tmp` redirection.
- **judge.log record shape (#165, additive)**: every decision record carries `runId` + the `model` the run actually used (plus `judgeModel` when the judge ran on a different evaluator model; unresolved values are omitted, never guessed), and the last line of every run is a `run_outcome` summary record (`termination` + `verification`) appended rather than written back. Per-model calibration metrics (blocked rate / false-block rate / extend ROI) are a `runId` join over these two record kinds.


## pitfall-4
4. For the no-browser + non-TTY authentication flow (verified in 2026-09, on a machine without a desktop): wrap npm with Python pty (`pty.fork()` + `select` to read output), use `setsid nohup` to fully detach from the process group so the bash tool cannot clean it up; use a regex in the script to extract the auth URL into a file, then read the URL and pass it to the user for browser interaction; **do not press ENTER automatically** (see above). Successful login writes the token to `~/.npmrc`; successful publishing is marked by the log line `+ erix-agent@<ver>`; reference implementation `/tmp/npm-pty-login5.py`.

## pitfall-5
5. **Auth URL regex gotcha (0.7.0 postmortem)**: login prints `https://www.npmjs.com/login?next=/login/cli/<uuid>` and publish prints `https://www.npmjs.com/auth/cli/<uuid>` — a regex like `npmjs.com/(login|auth/cli)/<uuid>` matches NEITHER. Use `npmjs\.com/\S*<uuid>`.

## pitfall-6
6. **Auth URLs expire in minutes**: surface the URL to the user in the SAME message where it was captured (never a later turn); each `npm publish` requires its own fresh device-flow auth, and each session can be used exactly once — an aborted run invalidates its URL, always re-issue.

## pitfall-7
7. **Publish success ≠ registry availability**: after the `+ erix-agent@<ver>` success line, npm prints `Your package is being processed and may take a few minutes to become available` — the registry can lag minutes; poll `https://registry.npmjs.org/<pkg>` before declaring failure.

## pitfall-8
8. **Right after publishing, `npm i -g` hits stale cached metadata** (ETARGET / old version): install with `--prefer-online` or pin the exact version.

## pitfall-9
9. **npm 12 lives at `~/.npm-global/bin/npm` and is shadowed by `/usr/bin/npm` (10.x)** in default PATH — invoke it by absolute path in scripts, or a 404/401 PUT will mislead you into diagnosing the wrong layer.

## pitfall-10
10. **Stale token → publish PUT 404 (2026-09-30, 0.13.0)**: an expired `~/.npmrc` token makes `npm publish` fail with E404 on the PUT (misleading); `npm whoami` returning E401 is the ground truth. Re-run `npm login --auth-type=web` (pty URL capture per pitfall 4), then publish.

## pitfall-11
11. **npm 12 publish PUT returns 202 Accepted (async processing, 2026-09-30)**: the `+ erix-agent@<ver>` success line prints BEFORE the package is visible on the registry (~2 min lag observed). Poll `npm view <pkg> version --prefer-online` for a few minutes before declaring failure (extends pitfall 7).

## pitfall-12
12. **npm publish triggers its own device-flow auth EVERY time (2026 policy) — including after a fresh `npm login`**; the publish URL (`npmjs.com/auth/cli/<uuid>`) must be captured via pty in headless environments and surfaced to the user immediately (see pitfall 4/6).

## pitfall-1
1. Edit `package.json` with a node script, never by deleting a line with `sed`: removing the `private` line that way
   leaves a trailing comma and the JSON stops parsing. Validate after editing:
   `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`.

## pitfall-2
2. Unlink any local link before publishing (`npm unlink -g <old name>`; `@erix/llm-kit` is a historical leftover) —
   otherwise `npm i -g` fails on a file conflict.

## pitfall-3
3. npm policy moves fast: new TOTP enrollment returns 404, and granular bypass-2FA tokens lost publishing rights in
   2026-08. On `403` / `EOTP`, read the official npm changelog before debugging this repository's setup.

## publish-prerequisites
Everything here is the end state; the route that produced it is `## npm-policy` above.
- `private` must be absent from `package.json` (otherwise the publish PUT is `403`); `repository.url` in
  `git+https://…` form, or run `npm pkg fix`.
- `files` is a long explicit allowlist, including `test/contract/*` enumerated file by file (no directory entry, which
  is why the `*.test.js` suites sitting next to them never ship). `package.json` is the only truth: never transcribe
  that list into a document. Inspect the artifact with `npm publish --dry-run`.
- **A version number is consumed by publishing it.** Check the number is free by **exit code**
  (`npm view <pkg>@<ver> version`), not by grepping the output: the not-found message repeats the version, so a grep
  reads a free number as taken. Use `npm version <x.y.z> --no-git-tag-version`; never `0.0.0` for a feature-complete
  first release.
- `0.24.0` was never published to the registry (the published line runs 0.23.0 → 0.25.0) and is deliberately not
  back-filled: `0.25.0` supersedes it, and `CHANGELOG.md` keeps its 0.24.0 section as what was true at that moment.
- **Human walkthrough that no anchor covers** (before the tag): walk the three classes of claimed values by hand —
  **defaults** (`default X` / the default `X`), **numbers** (N steps / N items / a constant's value) and **name sets**
  (strategy names, tool names, flags) — across both READMEs, both AGENTS files and both contract documents. An anchor
  only covers the dimensions somebody registered, and defaults are the class easiest to change and most expensive to
  get wrong: #614 flipped the CLI slot default compaction strategy while every machine gate stayed green. When a
  claim turns out to be machine-checkable, add the anchor while you are in there.
