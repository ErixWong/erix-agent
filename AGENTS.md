# erix-agent — Project AGENTS.md

> Chinese version: [AGENTS_cn.md](AGENTS_cn.md)

Project-specific rules; shared/global conventions live in `~/projects/AGENTS.md` and are deliberately not duplicated here. This file travels with the repository (GitHub: ErixWong/erix-agent).

## 1. Project positioning

**A self-developed headless coding agent (headless agent)**: a zero-dependency LLM agent runtime (dual-protocol streaming + tool loop + compaction + checkpoint) for **unattended, host-orchestrated** scenarios (the app_container / touwaka embedded base).

- Product form = **headless agent**: the `runToolLoop` single-task lifecycle (start/run/stop/resume/event stream), with execution (`executeTool`) injected by the host; the **boundary ends at a single task lifecycle**; multi-role orchestration/arbitration/retry scheduling is the host's responsibility and is not absorbed into the library.
- **The CLI (`bin/`) is a validator/debugger, not the focus**: interactive TUI + the `chat` one-shot entry point (which can serve as a bench entry point); capability validation uses the erix-bench headless harness (container driver + scorer, comparing `--agent erix|pi`), while the interactive repl tests only human-agent collaboration.
- Relationship with pi: **pi = interactive agent (human in the loop); erix = headless agent (unattended, host-scheduled) — complementary, not competing**.
- **Known boundary gap: `erix_run` (`examples/pi-extension`) depends on `bin/tools.js`** to get `exec` and the tool-prompt assembly, because `exec` has never been promoted into the public `src/` surface (`grep 'name: "exec"' src/` is empty). Since `bin/` is a validator/debugger rather than a contract surface, any **new** dependency on `bin/` must first promote the capability into `src/` (or the host implements the tool itself) — see `examples/pi-extension/README.md`, section “边界：不得依赖 bin/”.
- Security layering (ADR-009): the agent does not build in security; **the user of it is responsible** (local = trust domain; embedded containers are isolated by the host).
- Red lines: **zero npm dependencies** (only import node: built-ins + relative paths), pure ESM, Node 22+, and never commit key/token.
  The red line constrains **imports, not the toolchain**: `typescript` + `@types/node` are devDependencies by user authorization
  (issue #213, published `.d.ts` type surface); they exist only to generate declarations, are never imported by `src/`/`bin/`, and never
  enter the tarball as dependencies. `package-lock.json` is deliberately git-ignored (the repository has never had a lockfile; adding one
  is a separate decision).

## 2. Code structure

```
src/
├── index.js
├── assembly.js    # AssemblyPort validation (host boundary)
├── assembly-validators.js  # shared port/option validators (internal)
├── run-state.js
├── tokens.js
├── loop/          # orchestration core: orchestrator (runToolLoop), option-normalization,
│                  # provider-runner, run-snapshot-executor, budget, aggregate-budget,
│                  # termination, resume-manager, error-ledger, messages, reflection,
│                  # task-brief, abort, block-helpers, tool-result-ttl
├── compact/       # context compaction: budget, pipeline, sliding-window, fold-statistical,
│                  # fold-llm, anchors, fold-fidelity, enforce-size, helpers
├── config/        # configuration adapters
├── messages/      # canonical message model + OpenAI/Anthropic conversion
├── providers/     # OpenAI/Anthropic dual-protocol providers
├── reflection/    # governor, judge, l0, wrapup
├── skills/        # canonical skill-pack loader (discovery/validation/assembly); the
│                  # bundled skill directory is injected by the caller (`bundledDir`) —
│                  # the library never derives it from its own file layout
├── store/         # file, memory, notes
├── text/          # shared text helpers (label normalization)
└── tools/         # registry, providers, notes, file tools, and the skill-loader re-export
                   # (opt-in erix-agent/tools subpath)
bin/              # CLI (validator/debugger): cli.js (entry/chat), repl.js (TUI), tools.js (built-in tools + prompts), skills.js (thin assembly over src/skills/loader.js), mcp.js, config.js, final-guard-support.js, final-guard.js, guard-metrics.js
test/             # unit tests (node --test), with compact/, providers/, tools/, config/, messages/, contract/, helpers/, fixtures/, integration/, and top-level test files
fixtures/         # test fixtures (mock MCP servers) — ⚠️ mock MCP servers must not be put under test/ (node --test runs all files under test and can hang)
examples/         # runnable demos (exec-demo.js + its gated e2e test), sample skill packs (skills/), the pi
                  # extension (pi-extension/), provenance reproduction, and the in-repo memory-benchmark.js.
                  # There is NO examples/benchmarks/ directory: capability benchmarks live in the separate
                  # `erix-bench` repository
docs/             # design documents, ADR decision records, research, and task documents
skills/           # skill definitions
scripts/          # experiment scripts and results
```

## 3. Development commands

| Command | Purpose |
|---|---|
| `npm test` | Full test suite (`node --test`) |
| `node --check <file>` | Syntax safety check |
| `npm run check:syntax` | **Full-tree** syntax check (issue #187): `scripts/syntax-check.mjs` walks every tracked `.js`/`.mjs`/`.cjs` from `git ls-files` (`src/`, `bin/`, `scripts/`, `test/`, `examples/`, `fixtures/`) through `node --check`, names each failing file, exits non-zero. `npm run check` deliberately stays the single-file `node --check src/index.js`: `check:docs` verifies that the commands the docs reference actually exist, so replacing it would manufacture doc drift |
| `npm run check:docs` | Documentation drift check (`scripts/docs-drift-check.mjs`: version claims, quoted `files`/`exports` lists, module map, referenced paths/commands, 14 key defaults read out of the source, EN/CN README skeleton) plus the EN/CN contract heading sync |
| `npm run check:docs:strict` | Same check, promoting its warnings to failures |
| `node scripts/docs-drift-check.mjs --self-test` | Reverse-proof self-test of the list/unit/enum anchors (issue #210): change one doc claim → red, change the source truth → red, change nothing → green; a mutation that stops applying also fails (issue #210 R2) **Run it in the development tree**: in a checkout where the untracked `docs/tasks/` directory is absent (that directory is never committed), 3 of the cases are known false reds (their expectations name neighbouring files that only exist on a development machine) — tracked and deliberately deferred in issue #281, not a regression. |
| `npm run check:docs-examples` | Executes the JavaScript fences in `docs/host-consumer-contract.md` (issue #158) |
| `npm run check:pack-links` | Link closure inside packaged Markdown |
| `npm run check:release` | The pre-release manual check as one command (issue #257 T5), five steps in order, red names the step: `npm pack` → assert the tarball (declarations present, both current-version upgrade guides, the shipped `test/contract/` files, nothing outside the `files` allowlist; Markdown link closure is delegated to `check:pack-links`) → install the tarball into a throwaway temp project and assert `import("erix-agent")`/`import("erix-agent/tools")` → run the shipped contract suites through the installed package → compile a real TypeScript host with `tsc --strict --skipLibCheck` (exit 0, and an unknown `runToolLoop` option key must fail with `TS2353`) and run the compiled host → smoke the installed `erix` CLI against the local scripted upstream (`--version` equals `package.json`; a successful `chat` exits **4** because verification is `skipped` without `--final-guard`; a missing `--session` exits 1). Offline (`--offline` npm + a throwaway cache/userconfig + fake `HOME`), self-cleaning, ~15 s |
| `npm run check:cli-real` | Gated real-upstream CLI smoke (ticket 261015 T5, #284/#285 wrap-up): `npm pack` → install the tarball into a throwaway project → drive the **installed `erix`** (not `node bin/cli.js`) against the real relay with a ≥2-tool task, then assert the exit-code promise (a success without `--final-guard` exits **4**, verification `skipped`), the `tool_result` field surface in the transcript, and the installed package's own projection. Runs only under `ERIX_E2E_REAL=1`; with the gate closed it exits 0 and prints a **categorized** reason (gate missing / config missing / unparsable JSON / missing field / endpoint unreachable). Model name is read from `slots.default` (`ERIX_E2E_CONFIG` overrides the path). Two sibling gated suites: `examples/tool-fact-e2e.test.mjs` and `examples/pi-extension/erix-run-e2e.test.mjs` (same gate; they skip under `npm test`, so the real upstream is never a hard dependency of the default suite). Needs `node_modules`; self-cleaning, and it never writes the real `~/.npmrc` or `~/.erix/config.json` |
| `npm run types:build` | Generate the published `.d.ts` into `src/**/*.d.ts` and keep them (issue #213; the `prepack` hook runs the same script) |
| `npm run check:types-build` | Assertion gate: `tsc` exit 0 / declaration count > 0 / `src/index.d.ts` contains `runToolLoop` / `src/tools/index.d.ts` contains `createFileTools`, then delete the artifacts (issue #213; needs `npm install --include=dev`) |
| `npm run check:types` | `--checkJs` **ratchet**: counts the type errors reachable from `src/index.js` and fails if the total exceeds the baseline constant **119** in `scripts/type-check-ratchet.mjs` (issue #214; ratchet = never up, going down is a pass with a "you may lower the baseline to N" hint; both tiers re-measured 2026-10-15 and lowered in the same commit). **Delete the generated `src/**/*.d.ts` first** — see the `--checkJs` ratchet rule below. `-- --with-tools` widens it to the `./tools` entry (baseline **162** / 31 files) |
| `node bin/cli.js ...` | Run the CLI locally (no installation required) |

- CI (issue #187): `.github/workflows/ci.yml` runs on `pull_request`, on `push` to `main`, and on `workflow_dispatch` (the manual re-run entry point; note that `POST …/dispatches` answers **404** until GitHub has seen this workflow once — a branch push plus any run registers it, then dispatch returns 204), on **node 22 and 24** with `fail-fast: false`. Install is `npm install --include=dev`, **never** `npm ci` — this repository gitignores `package-lock.json` on purpose (see the `npm lockfile` comment in `.gitignore`), and the two dev packages (`typescript`, `@types/node`, issue #213) are exactly what `check:types` / `check:types-build` / `check:pack-links` / `check:release` need to run at all. **Blocking** steps, in order: `check:syntax` → `test` → `check:docs` → `check:docs:strict` (it is green today, so it blocks — the `continue-on-error` proposed in issue #187 was retired before landing) → `check:docs-examples` → `check:pack-links` → `check:tests` → `check:types` → `check:types-build` → `check:cli-real` (the `ERIX_E2E_REAL` gate is closed in CI ⇒ it exits 0 with a categorized reason: it self-checks that harness, it is not a real-upstream signal) → `check:release` under `if: matrix.node == 22` (offline and self-cleaning, but running it twice per matrix is pure waste). `npm run soak` needs a real relay configuration and key ⇒ **never** in the default CI. The **only** observational step is `node scripts/docs-drift-check.mjs --self-test` with `continue-on-error: true`: on a clean clone the gitignored `docs/tasks/` directory is absent, so **3 cases are expected red** there (`#280 .gitignore`, `#278-P2`, `#278-P3`, tracked in issue #281) — a 4th red is a regression, not "just more redness". One known way to get **5** instead of 3 without any regression: an **empty** `docs/tasks/` directory sitting in the tree (`taskArchiveDirPresent()` turns true while nothing gets dropped, so the two `#280 树形对照` cases report "the tree hole did not land"). The producer was `npm test` itself — the end-to-end probe in `test/static-guards.test.js` creates that directory and, before issue #187, deleted only its own files and left the empty directory behind in a clean tree; it now removes the directory it created (with a reverse-proof assertion). A **second** measured way to reach more reds without any regression (2026-10-15): **adding a `.gitignore` directory rule without classifying it in `IGNORED_DIR_CLASSES`** in that same script. The delivery-report directory was the live case, measured three ways on three commits: unclassified + tracked → **6** reds; classified as `task-archive` + still tracked → **3** reds; classified + un-tracked → **3** reds. So the trigger was the missing classification (the checker says so itself: `.gitignore:10 的目录规则 … 没在 IGNORED_DIR_CLASSES 里分类`), and the archive/bare-name adjudication merely inherits whatever the classifier cannot resolve. `docs/delivery/` is therefore classified like `docs/tasks/` **and** left untracked, so **the durable delivery evidence lives in the PR/issue comments, not in the repository tree**. Gitea is a code mirror only: **no** Actions pipeline is set up there, GitHub stays the single runner.
- Gate reproducibility (issue #280): `npm run check:docs` and `npm run check:docs:strict` must exit 0 both in a development worktree and on a **fresh clone** (`git archive HEAD | tar -x -C <empty dir>`). The “local archive” class — files under `docs/tasks/`, a directory that is gitignored on purpose and therefore absent in any clone — is adjudicated by its **declaration** (an entry in `LOCAL_ARCHIVE_REFS`, or an in-line statement next to the reference); the physical file is verified only as a bonus when that directory happens to exist, and its absence never turns the gate red. The two gates that genuinely have a local prerequisite are `npm run check:pack-links` and `npm run check:release`: they need `node_modules`, because they shell out to `tsc` / `npm pack`.
- Test isolation rule: tests involving `~/.erix` or `~/.pi` must inject `home`/`cwd` parameters (the skills/mcp/config tests provide precedents), to avoid contaminating real user configuration.
- Type-surface rule (issue #213): `src/**/*.d.ts` are **generated, never committed** (`.gitignore` covers them); `files` already ships
  `src`, so the tarball carries declarations the repository does not. The `prepack` hook regenerates them on `npm pack`/`npm publish` and
  must log to **stderr only** — lifecycle scripts inherit npm's stdout, and `scripts/pack-link-check.mjs` parses `npm pack --dry-run --json`.
  Two JSDoc shapes silently degrade a parameter to `any` (no compile error, discovered only by reading the emitted `.d.ts`, both fixed in
  #213 R4): a **standalone `//` line inside an inline `@param {{ … }}` type literal**, and a **doc block that is not the comment directly
  above its declaration**. When a host-facing signature matters, read the generated `.d.ts`, not the source comment.
- `--checkJs` ratchet rule (issue #214): `npm run check:types` does **not** aim for zero errors — 119 of them
  (29 files) are accepted debt (the #214 measurement was 218; issue #177 knife 1 took one off
  `src/loop/orchestrator.js` by annotating `resumeRunSnapshot`; PR #249 — the #213 provider-factory JSDoc — took
  75 more, **all of it in two files**: `src/providers/openai.js` 46 → 7 and `src/providers/anthropic.js` 45 → 9,
  the other 27 error-carrying files moved by zero; issue #265's `src/store/notes.js` refactor took 21 more, again
  **all of it in one file**: `src/store/notes.js` 27 → 6, the two new `// @ts-check` modules
  (`src/store/notes-port.js`, `src/store/notes-memory.js`) contributing 0, and the other 28 error-carrying files
  moving by zero — verified file by file against the `7354fab^` tree exported with `git archive`, which reproduces
  142 / 185 verbatim). What it guarantees is **never up**: the total is compared against the
  `BASELINE_ROOT = 119` constant in `scripts/type-check-ratchet.mjs` (re-measured 2026-10-15 on the current tree
  with `typescript@5.9.3` + `@types/node@22.20.5`, **both tiers lowered in the same commit**; the 226 in the issue body
  reproduces on the pre-#213 tree `bc3ad02`, which is why the number committed at #214 was 218 and not 226).
  **Which half to pay down first**: 93 of the 119 (in 20 files) sit in files a host can actually reach — re-measured
  2026-10-13 by aggregating the tsc output per file and classifying each file against the closures, and re-derived 2026-10-15 after #292 (93 reachable + 26 implementation-only = 119: the −2 all landed in `src/compact/pipeline.js`, which sits in the implementation-only half, so the reachable share is unchanged at 93), **not** by
  subtracting 21 from the 142-era 114: the type-reference closure of the published `src/index.d.ts`
  and `src/tools/index.d.ts` is **40 modules** under `src/` (was 38; `src/store/notes-port.js` and
  `src/store/notes-memory.js` both joined it), 36 of them from the package root alone (was 34); the
  `export … from` closure of those two entries is **39** (was 37) — `src/assembly-validators.js` is still the one module that is
  type-reachable without being re-exported, and #214 reported the two counts as equal at 40, which no longer holds.
  the other 28 sit in the same 9 implementation-only modules no host can name (`run-snapshot-executor` 8,
  `compact/pipeline` 5, `error-ledger` 3, `providers/timeout` 3, and 5 more at 1-2 each) — re-measured unchanged,
  none of them moved, and all 21 units #265 removed fell on the public half, since `src/store/notes.js` is itself
  inside the public closure. Admission rules for the whitelist:
  - **New files must open `// @ts-check` on line 1.** It is a declaration of intent, not the scope control:
    `--checkJs` plus `src/index.js` already pulls the whole import graph — `--listFiles` measures **58 files under
    `src/`** reached from that one entry (re-measured 2026-10-13; 56 before #265, which added two `src/` modules),
    **29 of them carrying errors** — so picking "just the public entry" as
    the input file narrows nothing; the whitelist has to be per-file, which is exactly what #214 R2 asks for.
  - **Touching a file whose error count can go down is a drive-by opportunity** (the #179 pattern: fold it into
    the PR that is already in that file, never a standalone ticket). When the total drops, lower the baseline
    constant in a **separate commit** and say which file lost how many errors — the value of a ratchet is that
    the number only shrinks.
  - ⚠ **Delete the generated declarations before running it.** tsc resolves `./x.js` to a sibling `x.d.ts` first,
    so after `npm run types:build`/`prepack` the ratchet would be checking declarations instead of
    implementations: measured on the post-#249 tree (2026-10-11), **142 errors** with no `.d.ts` present, **0 errors**
    with the then-61 declarations present (`--skipLibCheck` skips declaration files), **13 errors all pointing at `.d.ts`** if
    `--skipLibCheck` is dropped; re-measured 2026-10-15 on the current tree (post-#292, where `npm run types:build`
    emits **65** declarations — the earlier counts 61 (the 2026-10-11 tree), 63 (`39e96f1`, 2026-10-13) and 64 (the 0.20.0 tarball) are **historical values**; current: **119 errors** with none present, **0 errors** with the 65 present, and the same **13 errors on `.d.ts` files** without `--skipLibCheck`.
    "0 errors < baseline" would be a **false green**, so the script hard-fails on
    stale `src/**/*.d.ts` (the repository commits zero `.d.ts`, so their presence always means generated).
    Fix: `find src -name '*.d.ts' -delete` — they are git-ignored and regenerable.
  - Known hole, deliberately left open by the spec: the second public entry `src/tools/index.js` pulls in
    `src/tools/file-tools.js` (27 errors) and `src/skills/loader.js` (16), which the package-root graph never
    reaches, so new errors there are **not** caught by the default gate. `npm run check:types -- --with-tools`
    gates the union (baseline **162** / 31 files = 119 + 27 + 16, re-measured 2026-10-15; the 27 and the 16 are
    re-counted every time the tiers are lowered, and both are unchanged) and is the cheap way to tighten this later.
    ⚠ The retired 261 had quietly kept the one unit #177 took off `orchestrator`, because that tier was never
    re-measured: **lower both tiers in the same commit**, after measuring both.
  - Toolchain allowance (issue #213, restated here for #214): `typescript` + `@types/node` may stay dev-only —
    the zero-runtime-dependency red line constrains what `src/`/`bin/` import (`node:` builtins + relative
    paths), and this gate adds no dependency either (only `node:` builtins, no tsconfig, no new tool).
- Documentation rule (issue #164): any change to `README*.md`, `docs/requirements*.md`, a default value, or the
  `files`/`exports` list must keep `npm run check:docs` green. The check reads ground truth from
  `package.json` and `src/`, so docs cannot silently drift; the required phrasing for
  "current version" claims is documented in the header comment of `scripts/docs-drift-check.mjs`.
  Chinese/English document pairs stay in sync (see `AGENTS_cn.md`).
- Anchor granularity (issue #210): **do not assume "delete one mention in the docs turns red"** — most anchors are
  *existence-level* (the whole `defaults` group, `modulemap`, `paths`: they ask "is this string present in that file",
  so deleting one extra mention of the same value stays green). Only these are *per-occurrence* (each declaration site
  is compared on its own, so missing / extra / renamed members all go red): the `version` claims, the README
  `files`/`exports` fences — compared **bidirectionally** with `package.json`, so renaming or dropping a key in the doc
  is red, not just adding one — and the list/unit/enum anchors (file-tool list, CLI tool list, vendor skip directories,
  `formatSize` unit tiers plus every `` `bytes` → `rendered` `` example claim, built-in compaction strategy names).
  Those anchors also reconcile the **number of declaration sites between the EN and the CN doc**, which is what catches
  "someone deleted the whole sentence on one side". Every per-occurrence rule carries its reverse proof in
  `node scripts/docs-drift-check.mjs --self-test`; run it after touching `scripts/docs-drift-check.mjs`. The level of
  every anchor, and why the remaining ones were *not* upgraded, is listed in the header comment of that script.
- Doc line anchors (issue #286, first batch T-a): docs must not lean on **bare line numbers**. `paths` used to strip
  `:1234` before resolving a reference, so only the file was ever checked — a line number that drifted into another
  function, or past the end of the file, stayed green (the contract pointed at line 398 of `src/store/notes.js`, a file that is 383 lines long). Three anchors now hold that line, all wired into `--self-test`:
  *`symbol-anchor`* is *per-occurrence*: every `` `symbol` (`path`) `` or `[symbol](path)` reference must find a real
  declaration of that symbol **in that file** (`function` / `class` / `const|let|var` binding / destructuring /
  re-export / method / object key / `process.env.X`). A missing symbol is red and the message names the nearest
  symbols actually declared there; a file from which no declaration can be extracted at all is red too (#164:
  no silent pass when ground truth cannot be read). Named string *values* — termination reasons, provider error
  codes — are the one weaker tier and are accepted only in the four files listed with a reason in
  `SYMBOL_VALUE_MEMBERSHIP` in `scripts/docs-drift-check.mjs`. Because the bare-line ratchet keys on
  (document, target file, line range) — **never on the doc's own line number** — rewriting
  `` `symbol` (`path:1517-1531`) `` into a bare `path:1517-1531` leaves that count untouched while deleting the
  symbol check entirely, so `symbols` carries its own **only-up floor** `SYMBOL_ANCHOR_MIN_UNIQUE = 42` (groups
  measured today: 42 unique (symbol, file) pairs over 91 occurrences, reproducible via `--verbose`; raised from 32
  when #313 added the "erix_run final face" section to the paired contract — a stale floor is **false green**, because
  both `--self-test` probes for that floor then fail open): dropping below it is
  red — that is the degeneration being caught, not a ratchet rise — and exceeding it earns a "raise the floor" note.
  Both numbers are read back out of the script's own text, which is what lets `--self-test` prove they are locks.
  *`symbol-anchor-span`* (#286 batch T-b1a) is the *per-occurrence* companion of the rule above: when a symbol anchor
  **carries a line range** — `` `symbol` (`path:1517-1531`) `` — that range must **intersect that symbol's own ground
  truth in the referenced file** (`lo <= p <= hi`). Ground truth = every declaration site of the name (not only the
  first: `sideEffect` legitimately appears both in the persistence normalizer and in `fail()`) plus, in the four
  membership files, the lines where that named string value occurs. A range pointing elsewhere is exactly the #286
  drift shape — symbol right, numbers wrong, invisible to the old `paths` anchor because it strips line numbers
  before resolving. Two legal fixes: **drop the range** (`` `symbol` (`path`) ``, preferred: numbers drift and
  `symbols` never needed them) or move it onto the declaration. Anchors *without* a range are outside this rule,
  which is also why dropping ranges makes the ratchet below go down legitimately.
  *`bare-lines`* is a *ratchet (only down)*: `src/**.js:N` / `:N-M` references, counted as unique
  (document, target file, line range), may never exceed `BARE_LINE_REF_BASELINE = 142` in that same script. The number
  is reproducible with `node scripts/docs-drift-check.mjs --verbose`: 146 measured minus 4 declaratively exempted
  example / host-repo paths (`BARE_LINE_EXEMPTIONS`: the entry names one document + one placeholder path, **and** that path plus a
  declaration word must both appear on the referencing line — a leftover "for example" elsewhere is not a declaration; an entry
  nobody uses goes red; and the register carries its own config check, so a declaration pattern that can match the empty
  string (or carries a `g` flag, making `.test()` stateful) is itself an error — same dual-condition family as #286's
  `test/static-guards.test.js`). An out-of-range line number is an
  error, not an observation. Scope is the 20 documents a host actually reads: the two READMEs, both AGENTS files, both
  contract files, plus **every** `docs/host-upgrade-guide*.md` (discovered from the directory, so a new guide is
  covered the moment it exists). Directory discovery has a silent failure mode — renaming a guide away from that
  pattern shrinks the coverage in the script **and** in the test that mirrors the same glob, so both numbers still
  agree: `REF_SCAN_DOCS_MINIMUM = 20` is the floor (6 pinned documents + the 14 guides found today), and
  `test/docs-anchor-ratchet.test.js` keeps its own pinned list of those 14 file names. Renaming or adding a guide is
  red until both places are updated. `CHANGELOG.md` is deliberately out of scope: its line numbers record what was true at
  release time, and rewriting them would fake history (same reasoning as the #278 shorthand register).
  Batch T-a built the infrastructure and the ratchet; batch T-b1a converted the contract's
  `src/loop/orchestrator.js` anchors that carry their own range (EN + CN in the same PR) and took the baseline from
  244 down to 232; batch T-b1b finished that family — every remaining bare `src/loop/orchestrator.js:N[-M]` in both
  contract files either lost its range (the preferred fix, with the real declaration name written into the sentence:
  `resolvedModelConfig`, `reportObserverError`, `persist`, `isEndTurn`, …) or stayed as a *range fact* whose range was
  checked against the code — taking the baseline from 232 down to 144. The sites left in `provider-runner.js` /
  `termination.js` / `governor.js` belong to batch T-b2, and *lowering* that constant (with a reason in the commit
  message) remains what "we removed some" has to look like.

## 4. npm publishing guide (verified against the 2026-08 policy)

### Prerequisites (`package.json`)
- `private` must be removed (otherwise 403); edit JSON with a node script, not sed to delete a line (a trailing comma would break JSON).
- `files`: `["src", "bin", "skills", "README.md", "CHANGELOG.md", "docs/host-consumer-contract.md", "test/contract", "LICENSE"]` — inspect the tarball with `npm publish --dry-run` before publishing.
- Use the `git+https://...` format for `repository.url` (or run `npm pkg fix`).
- Type surface (issue #213): `types` points at `./src/index.d.ts` and `exports["."]`/`exports["./tools"]` carry a matching `types`
  condition; `exports["./contract-tests"]` has **no** `types` key on purpose (its target lives under `test/`, outside the declaration graph).
  Declarations are generated by the `prepack` hook, so a clean checkout has none — `npm publish --dry-run` should list
  **67** `.d.ts` (measured 2026-10-16 on the post-#307 tree: `npm pack --dry-run --json` lists exactly 67 since #307 added `src/text/parse-model-json.js`; before that it was 66 since #305 added `src/text/json-candidates.js`, and 65 on the post-#292 tree (measured 2026-10-15); the 0.20.0 tarball had 64, the 0.19.0-era count was 63; +~44 kB packed / +~139 kB unpacked measured on 0.18.0); `npm run check:types-build` is the gate that they still generate.
- Current version: `0.20.0`; use `npm version <x.y.z> --no-git-tag-version` for version changes (do not use 0.0.0 for a feature-complete first release).

### npm 2026 policy changes (TOTP discontinued + bypass token restrictions)
- ❌ New TOTP enrollment is no longer supported (`enable-2fa` returns 404).
- ❌ bypass-2FA granular tokens lost direct publishing rights starting in 2026-08.
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

### Release verification loop
```bash
npm publish --dry-run        # 看 tarball 内容
npm publish                  # 发布（web 认证）
npm view erix-agent version  # 确认 registry
npm unlink -g <旧包名>        # 清本地 link 残留（否则 i -g 报文件冲突）
npm i -g erix-agent          # 全局安装正式包
erix --version && erix chat "..."   # 端到端验证（复用 ~/.erix/config.json）
```

### Pitfall quick reference
1. Edit `package.json` with a node script; after editing, validate it with `node -e "JSON.parse(...)"`.
2. Unlink the local link before publishing (`@erix/llm-kit` is a historical leftover).
3. npm policy changes quickly (TOTP/bypass transitioned in 2026) — when encountering 403/EOTP, check the official changelog first.
4. For the no-browser + non-TTY authentication flow (verified in 2026-09, on a machine without a desktop): wrap npm with Python pty (`pty.fork()` + `select` to read output), use `setsid nohup` to fully detach from the process group so the bash tool cannot clean it up; use a regex in the script to extract the auth URL into a file, then read the URL and pass it to the user for browser interaction; **do not press ENTER automatically** (see above). Successful login writes the token to `~/.npmrc`; successful publishing is marked by the log line `+ erix-agent@<ver>`; reference implementation `/tmp/npm-pty-login5.py`.
5. **Auth URL regex gotcha (0.7.0 postmortem)**: login prints `https://www.npmjs.com/login?next=/login/cli/<uuid>` and publish prints `https://www.npmjs.com/auth/cli/<uuid>` — a regex like `npmjs.com/(login|auth/cli)/<uuid>` matches NEITHER. Use `npmjs\.com/\S*<uuid>`.
6. **Auth URLs expire in minutes**: surface the URL to the user in the SAME message where it was captured (never a later turn); each `npm publish` requires its own fresh device-flow auth, and each session can be used exactly once — an aborted run invalidates its URL, always re-issue.
7. **Publish success ≠ registry availability**: after the `+ erix-agent@<ver>` success line, npm prints `Your package is being processed and may take a few minutes to become available` — the registry can lag minutes; poll `https://registry.npmjs.org/<pkg>` before declaring failure.
8. **Right after publishing, `npm i -g` hits stale cached metadata** (ETARGET / old version): install with `--prefer-online` or pin the exact version.
9. **npm 12 lives at `~/.npm-global/bin/npm` and is shadowed by `/usr/bin/npm` (10.x)** in default PATH — invoke it by absolute path in scripts, or a 404/401 PUT will mislead you into diagnosing the wrong layer.
10. **Stale token → publish PUT 404 (2026-09-30, 0.13.0)**: an expired `~/.npmrc` token makes `npm publish` fail with E404 on the PUT (misleading); `npm whoami` returning E401 is the ground truth. Re-run `npm login --auth-type=web` (pty URL capture per pitfall 4), then publish.
11. **npm 12 publish PUT returns 202 Accepted (async processing, 2026-09-30)**: the `+ erix-agent@<ver>` success line prints BEFORE the package is visible on the registry (~2 min lag observed). Poll `npm view <pkg> version --prefer-online` for a few minutes before declaring failure (extends pitfall 7).
12. **npm publish triggers its own device-flow auth EVERY time (2026 policy) — including after a fresh `npm login`**; the publish URL (`npmjs.com/auth/cli/<uuid>`) must be captured via pty in headless environments and surfaced to the user immediately (see pitfall 4/6).

## 5. Git and remotes

- **Two repos, one code line, dual push**: `origin` fetches from GitHub (the workflow source of truth) and pushes to **both** GitHub and Gitea — `git push origin <ref>` updates both.
  - `origin` fetch = `ErixWong/erix-agent` (GitHub)
  - `origin` push URLs = GitHub **+** `git.erix.vip/eric/erix-llm-kit` (Gitea)
- **GitHub** = development workflow source of truth: issues, PRs and reviews live here. The Gitea issue/PR area is a frozen historical archive — do not open or reply there.
- **Gitea** = code mirror only (same commits, dual-pushed).
- **The `sync-erix-mirror.sh` cron is disabled (2026-10-03)**: mirror crons have proven to re-sync wrong versions; dual push is the only sync mechanism. If a push fails on one URL, that side silently lags — verify both sides after pushing.
- Contribution flow: branch `feat-YYMMDD-NN-<描述>` → PR merged into main (for large changes); small changes/documentation can be pushed directly.
- Commit messages: conventional commits + 中文摘要
- History note: GitHub was the truth source until 2026-09-30, when a session flipped the roles to Gitea (commit `2ee65ce`, cron mirror + dual push URL). On 2026-10-03 the flip was reverted: GitHub is the workflow source of truth again, the cron was disabled, and the two repos are kept in sync by dual push. The old Gitea-first note misled later sessions — keep this section and `AGENTS_cn.md` in sync when it changes.

## 6. Local runtime data (not committed to the repository)

```
~/.erix/
├── config.json        # LLM config (endpoint/model/apiKey/maxOutputTokens/contextWindowTokens)
├── mcp.json           # MCP server registry (standard format; can reuse ~/.config/mcp/mcp.json)
├── <session>.json     # session history (id derived from cwd)
├── transcripts/
│   ├── <runId>.jsonl          # per-round records (includes judge decision fields)
│   └── outputs/<runId>/       # everything archived for this run: tool captures, reports, judge.log
│       └── judge.log          # judge decision JSONL (written here by default; override with --judge-log / ERIX_JUDGE_LOG)
├── skills/            # user-level skills (self-describing protocol)
└── todos/             # task lists (isolated per cwd)
```

- **Judge logs have a fixed home**: `transcripts/outputs/<runId>/judge.log`, same directory and lifecycle as the transcript/tool captures; supervisors should inspect judge behavior here instead of relying on `/tmp` redirection.
- **judge.log record shape (#165, additive)**: every decision record carries `runId` + the `model` the run actually used (plus `judgeModel` when the judge ran on a different evaluator model; unresolved values are omitted, never guessed), and the last line of every run is a `run_outcome` summary record (`termination` + `verification`) appended rather than written back. Per-model calibration metrics (blocked rate / false-block rate / extend ROI) are a `runId` join over these two record kinds.

## 7. Local environment facts

- Relay: `api.ai.erix.vip/v1`; the model must be configured by the user (`contextWindow 262144`, `maxOutputTokens 65536` → automatic compaction budget ~170k). This is the same file `erix_run` reads (`slots.default`); it does not follow pi's current model.
- For tool execution/validation, use `node bin/cli.js chat` for erix work (this repository); the supervisor watches `/tmp/erix-*-log.txt` for step-by-step output.
- Red lines for erix coding tasks: **estimate the read budget before reading and take it in one call** (the `readFile` tool description already carries the budget facts: default line count, per-call byte cap, and the token conversion) instead of conservatively paging small segments, break long tasks down with `todo_add` first, and make a verification declaration before reporting.

## 8. Model and cost discipline

- Never hardcode model names; always read them from the user configuration or use a model explicitly supplied by the user.
- If a model is unavailable, fail immediately; never replace it or fall back to another model.
- Before any batch experiment, report the model, call count, and a cost/time estimate based on historical averages, and obtain the user's confirmation.
- Respect the user's choice of vendor and quota; when the user changes models, it is usually for cost or quota reasons, so do not quietly switch back.
