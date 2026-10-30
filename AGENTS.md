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
│                  # task-brief, abort, block-helpers, tool-result-ttl, deliverables
├── compact/       # context compaction: budget, pipeline, sliding-window, fold-statistical,
│                  # fold-llm, anchors, fold-fidelity, enforce-size, helpers
├── config/        # configuration adapters (incl. the slot → provider constructors
│                  # loadModelSlot / createProviderForSlot, issue #406)
├── messages/      # canonical message model + OpenAI/Anthropic conversion
├── normalization/ # model-output normalization: normalizeModelJson (L1 byte-preserving repair,
│                  # gate on the original bytes, optional L2 LLM fallback, issue #406) — a
│                  # separate asynchronous entry from the synchronous L0 parseModelJson in text/
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
| `npm run check:docs` | Documentation drift check (`scripts/docs-drift-check.mjs`: version claims, quoted `files`/`exports` lists, module map, referenced paths/commands, 14 key defaults read out of the source, the CLI flag list reconciled bidirectionally between `bin/cli.js`'s help text and the two READMEs' usage lines, EN/CN README skeleton) plus the EN/CN contract heading sync |
| `npm run check:docs:strict` | Same check, promoting its warnings to failures |
| `node scripts/docs-drift-check.mjs --self-test` | Reverse-proof self-test of the list/unit/enum anchors (issue #210): change one doc claim → red, change the source truth → red, change nothing → green; a mutation that stops applying also fails (issue #210 R2) **Since issue #302 the tree it runs in does not change the verdict**: the two `#280` tree-shape cases run on a **synthetic tree fixture**, so the result no longer depends on whether this machine's untracked `docs/tasks/` directory (never committed) exists — measured on `git archive HEAD | tar -x` checkouts with no / empty / filled `docs/tasks/`: **103 cases, 0 red in all three shapes**. Before #302 it was the other way round: 3 of the cases were known false reds in a checkout without `docs/tasks/` (5 with an empty one), tracked in issue #281 — those reds are gone, so "run it in the development tree" is history, not a current requirement. |
| `npm run check:docs-examples` | Executes the JavaScript fences in **both contract documents and both root READMEs** (`README.md` / `README_cn.md` since issue #576), three layers each — syntax compile, real-symbol link, real execution in a spawned subprocess — and the README target table is itself guarded (drop a target and the guard cell goes red). Execution is **offline**: scripted fake providers / `fetchImpl` stubs, no network, no `~/.erix` (issue #158, #576) |
| `npm run check:pack-links` | Link closure inside packaged Markdown, **plus** the `.d.ts` claim reconciliation: every "a packed install should list **N** `.d.ts`" claim in the four entry documents must equal the number of `src/**/*.d.ts` entries the same `npm pack --dry-run --json` lists (no extra `tsc` run), **plus** the `test/contract/` publish-surface reconciliation (issue #505): `files` lists that directory **file by file** and never as a directory, so a new `.js` that nobody added to `files` ships nowhere and **no gate went red** (`check:release` only asserts the opposite direction). Three criteria: **1 (red)** every non-`*.test.js` `.js` that exists under `test/contract/` but is absent from the tarball list is named — that is "forgot to add it to `files`"; **2 (red)** every `test/contract/...` entry in `files` that does not exist on disk is named — a dead entry left over from history; **3 (printed, never red)** every `test/contract/*.test.js` is listed with the command that runs it and the note that it is deliberately not published (they are `node --test` suites; `npm pack` lists **0** `*.test.js` — this line exists so the next reader does not file it as a missed package). "Deliberately unpublished" requires a register entry in `CONTRACT_PUBLISH_EXEMPTIONS` (today exactly one: the doc-example harness that only the `check:docs-examples` suite imports — the real fix is moving it out of the publish-surface directory, which is #498 S8's job), and the register is guarded in both directions: an entry whose file is gone, an entry whose file now ships, an empty `why`, a `path` that is not a concrete file under `test/contract/`, or a count that drifts from `CONTRACT_PUBLISH_EXEMPTION_MAX` (**1**, red on both more and fewer) all fail. Still offline and still one `npm pack --dry-run --json`; `node scripts/pack-link-check.mjs --self-test` holds **16 cases** (in-memory fixtures plus this repo's real tree, no `npm pack`, no network) |
| `npm run check:release` | The pre-release manual check as one command (issue #257 T5), five steps in order, red names the step: `npm pack` → assert the tarball (declarations present, both current-version upgrade guides, the shipped `test/contract/` files, nothing outside the `files` allowlist; Markdown link closure is delegated to `check:pack-links`) → install the tarball into a throwaway temp project and assert `import("erix-agent")`/`import("erix-agent/tools")` → run the shipped contract suites through the installed package → compile a real TypeScript host with `tsc --strict --skipLibCheck` (exit 0, and an unknown `runToolLoop` option key must fail with `TS2353`) and run the compiled host → smoke the installed `erix` CLI against the local scripted upstream (`--version` equals `package.json`; a successful `chat` exits **4** because verification is `skipped` without `--final-guard`; a missing `--session` exits 1). Offline (`--offline` npm + a throwaway cache/userconfig + fake `HOME`), self-cleaning, ~15 s |
| `npm run check:release:real` | The **pre-release real-upstream checklist** as one command (ticket 261021-13, written after 0.23.0 shipped with neither the doc audit nor the real e2e suites actually run): seven gated steps in order — `node --test examples/tool-fact-e2e.test.mjs` → `examples/delegate-real-e2e.test.mjs` (parent run delegates a child run, issue #617) → `examples/resume-real-e2e.test.mjs` → `examples/cross-version-real-e2e.test.mjs` → `examples/pi-extension/erix-run-e2e.test.mjs` → `node scripts/cli-real-smoke.mjs` → `examples/fold-default-real-e2e.mjs` (default compaction strategy `fold-llm` on the real upstream, issue #619) — each announced as `=== [i/7] <name> ===` and summarized as `tests/pass/fail` plus elapsed time, each with its own **900 s** hard timeout (a timeout is red, the whole process group is `SIGKILL`ed so no grandchild keeps burning tokens, and the run continues with the next step). Any red ⇒ **exit 1 after the list finishes**, with a closing block naming which steps failed; all green ⇒ exit 0 plus total time. Gate: without `ERIX_E2E_REAL=1` it runs **nothing**, exits 0 and prints a categorized reason (same `GAP_CODES` as `examples/e2e-real-gate.mjs`), so it never becomes a hard dependency of any default gate; with the gate **open** but config/credential/endpoint unusable it exits **1** (a pre-release checklist that did not run must not be reported as green — the mirror image of PR #289 blocker 1), and a child that skips with a gate/config code is red too (the preflight and the child disagreeing means the harness is broken), while other skips (e.g. “old CLI 0.22.0 unavailable”) are named in the summary without turning the run red. Writes **nothing** itself: no temp tree, never `~/.erix`; isolation stays in each step |
| `npm run check:cli-real` | Gated real-upstream CLI smoke (ticket 261015 T5, #284/#285 wrap-up): `npm pack` → install the tarball into a throwaway project → drive the **installed `erix`** (not `node bin/cli.js`) against the real relay with a ≥2-tool task, then assert the exit-code promise (a success without `--final-guard` exits **4**, verification `skipped`), the `tool_result` field surface in the transcript, and the installed package's own projection. Runs only under `ERIX_E2E_REAL=1`; with the gate closed it exits 0 and prints a **categorized** reason (gate missing / config missing / unparsable JSON / missing field / endpoint unreachable). Model name is read from `slots.default` (`ERIX_E2E_CONFIG` overrides the path). The cross-version suite (`examples/cross-version-real-e2e.test.mjs`) reads its **old ledger from a committed fixture**, `test/fixtures/journal-0.22.0/` — a real `erix-agent@0.22.0` CLI product (4 rows, 2 `readFile` calls, plus state/status/snapshot). That fixture is **read-only: never regenerate it in place** (regenerating rewrites the bytes and the point of the test is that the bytes are what 0.22.0 actually wrote). Only the resume half needs the real upstream, so with the gate closed the suite still runs its offline half (2 pass / 0 skip) instead of skipping wholesale. Two sibling gated suites: `examples/tool-fact-e2e.test.mjs` and `examples/pi-extension/erix-run-e2e.test.mjs` (same gate; they skip under `npm test`, so the real upstream is never a hard dependency of the default suite). Needs `node_modules`; self-cleaning, and it never writes the real `~/.npmrc` or `~/.erix/config.json` |
| `npm run check:docs-spelling` | **Blocking gate** (issue #560) for retired flat option spellings in the living docs (`scripts/retired-spelling-scan.mjs --strict`; the scanner is issue #523's): the retired set is derived from `CONFIG_SURFACE_OPTION_NAMES` minus `RUN_TOOL_LOOP_OPTION_NAMES` (never copied), hits count only in code context (fences and inline spans; `config: { … }` subtrees are skipped as leaf names, and `AMBIGUOUS_KEYS` — names that are also a parameter/field of something else — stay out of the verdict), and every **tracked** doc on the surface — `docs/**/*.md` plus the two root READMEs (issue #572) — is classified **by path**: current-state (`architecture*`, `charts*`, `requirements*`, `testing*`, `maintenance-policy*`, `soak.md`) must spell the current API; history (`decisions/*`, `v0.*`, `design/*`, `research/*`, `harness-comparison/*`, `suggestions/*`, `issue-469-*`, `tasks/*`, `host-upgrade-guide-*`), the contract (`host-consumer-contract*`) and the root docs (`README.md`, `README_cn.md` — the root-doc class, issue #572) keep their body byte-for-byte and are pinned by hit count (`ROOT_DOC_BODY_PINS` for the root docs; `SUSPECT(dropped)` = someone rewrote history into canonical form, `SUSPECT(raised)`, and `UNPINNED` = a history/contract/root-doc file with hits and no pin; pins may only name **tracked** files — a pin pointing at a path outside the manifest is a `DEAD-PIN` and red). **The file list comes from `git ls-files` only** (issue #560): the scan surface is the **tracked** `docs/**/*.md` plus the two tracked root READMEs (issue #572 — an **explicit** pathspec list, `SCAN_PATHSPECS`, never `.`, so the surface cannot silently become the whole repository), never a filesystem walk, because `docs/tasks/` and `docs/delivery/` are gitignored local archives — walking the disk made the same repository content answer `--strict` exit 1 in a developer tree and exit 0 in a clean clone (CI runs the clone, so that red was never visible). If `git` is unavailable, the directory is not a repository, the repository top level is not the scanner's own directory, or the manifest is empty, the scanner **fails loudly with exit 2** and **never** falls back to a filesystem walk (a silent fallback would leave the two-answer defect in place, just harder to see). **A `docs/**.md` in none of the lists is scanned as current-state** — the “this ticket did not cover it” class is gone, unknown is never exempt. `check:docs` reads no option spelling at all, which is why this is its own blocking step right after `check:docs:strict`; `node scripts/retired-spelling-scan.mjs --self-test` is the guard's own reverse proof (blocking, 22 cases; it scans a **copy of the tracked surface** for real and mutates it — three of the cases are the issue #572 surface-widening reverse proofs: a flat spelling dropped into `README.md` reddens both `--strict` and `--strict --json` and restoring it greens both, a root-doc pin that no longer matches is `SUSPECT(dropped)`, and a root-doc pin pointing outside the manifest is a `DEAD-PIN`). `--strict --json` is **the same gate** in machine-readable form (issue #575): the red set (`gateVerdicts()`) and the red-count-to-exit-code rule (`gateExitCode()`) exist once and both output branches only read them, so `--strict --json` answers exit 1 on a red surface exactly like the text branch does, and the JSON carries `gate.{strict,gating,mode,red,counts,exitCode,wouldExitCode}` — before #575 the `--json` branch set `process.exitCode = 0` unconditionally and every machine consumer read red as green. Report mode (`--json` without `--strict`) keeps exit 0 but still reports the same red count with `gating: false` |
| `npm run types:build` | Generate the published `.d.ts` into `src/**/*.d.ts` and keep them (issue #213; the `prepack` hook runs the same script) |
| `npm run check:types-build` | Assertion gate: `tsc` exit 0 / declaration count > 0 / `src/index.d.ts` contains `runToolLoop` / `src/tools/index.d.ts` contains `createFileTools`, then delete the artifacts (issue #213; needs `npm install --include=dev`) |
| `npm run check:types` | `--checkJs` **ratchet**: counts the type errors reachable from `src/index.js` and fails if the total exceeds the baseline constant **110** in `scripts/type-check-ratchet.mjs` (issue #214; ratchet = never up, going down is a pass with a "you may lower the baseline to N" hint; both tiers are re-measured together on every lowering — the 2026-10-31 round moved **both** by six units, 116 → 110 and 152 → 146, the same six on both tiers, and the 2026-10-23 round before it moved both by one unit each). **Delete the generated `src/**/*.d.ts` first** — see the `--checkJs` ratchet rule below. `-- --with-tools` widens it to the `./tools` entry (baseline **146** / 29 files) |
| `npm run check:exports` | Export-consumer inventory (issue #406 ruling ③; also serves the #419③ “imported but never called” class; the counting criteria were repaired in #429): `scripts/export-consumer-check.mjs` reads the entry list out of `package.json`'s `exports` instead of hard-coding it, so **all three** public entry points are walked (`.` → `src/index.js`, `./tools` → `src/tools/index.js`, `./contract-tests` → `test/contract/index.js`), and every exported name is bucketed by who actually consumes it: **in-package consumers** (`src/`, `bin/`), **publish-surface consumers** (`examples/`, `test/contract/` — `test/contract` ships in `files` and the host runs it after install, so a hit there is real use), and exposure only (`test/` outside `test/contract/`, `docs/`, `scripts/`, reported as own test count / doc mentions / script mentions and deliberately **not** counted as consumption). A name still referenced inside its own defining file beyond the declaration is reported as **internal-only** — not a dead export (the removal is dropping the `export`, not the symbol) — and is kept out of the candidate list. A deletable candidate therefore needs zero hits in **both** consumer tiers *and* zero internal use; measured today: 130 exported names, 15 candidates, 19 internal-only, 12 publish-surface. Output is one table per tier plus the criteria and a verbatim reproduce command; `--json` carries the same facts (`candidates` / `publishConsumers` / `internalOnly` / `tiers`). **Inventory only — no gate, no judgement**: zero consumers is not an error (exit 0) and nothing is deleted (removal waits for host migration plus a version boundary, a separate ticket); it goes red (exit 2) only when the truth cannot be read — `package.json` or its `exports` unreadable, an unreadable entry, a scanned directory or file that cannot be read, an export name that does not parse, an `export *` / non-list export form it refuses to expand, a definition file that is missing, or one that exists but does not contain the symbol. `--self-test` holds the reverse proofs: deleting one real consumer ⇒ candidates +1, restoring it ⇒ back to the original count, a stateful `g` regex undercounting, a comment inside the braces being read as a name, `export *` being named instead of silently dropped, and one three-state proof per repaired criterion (third entry, publish-surface tier, internal-only tier, unreadable directory, missing definition symbol). Not wired into `.github/workflows/ci.yml` on purpose — it is meant to be read for a few rounds first |
| `npm run check:inventory` | Compatibility-pin inventory verification (issue #534): `node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` re-derives the flat-spelling pin counts straight from the AST of every scanned test file and compares them with the committed table — any mismatch exits 1 and names the file plus both numbers. Measured **1.8 s / ~150 MB**, so it blocks in CI as `Compatibility-pin inventory verify`, placed after `Test suite` and before `Test hygiene guard` (the table inventories test files, so verifying it before the tests ran would be meaningless). The same script's **`--sync`** mode is the **only** legitimate way to change that table — hand-editing a number is fabrication — so **any slice touching compatibility pins must re-run `--sync` in the same slice**: `node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md` (and `--verify` likewise needs the table path). **Drop the table path and it crashes**: the script reads `process.argv[4]` as the table path, so `node scripts/flat-count-inventory.mjs . --sync` alone is a `readFileSync(undefined)` `ERR_INVALID_ARG_TYPE`, not a no-op. Rationale: the table claimed "zero per-row deviation" while A12 shipped 3 inconsistencies that only a hand-run `--verify` caught. The generator itself lives in the repository since #529; before that the documented reproduce command pointed at a `/tmp` copy, which is exactly what left a later worker unable to refresh the table at all |
| `npm run check:types:strict` | **Observation only — it gates nothing** (issue #416): re-runs the *same* `tsc` invocation as `npm run check:types` with `--strict` appended (same entry files, same dependency graph, same `typescript` + `@types/node` pair) and prints the total plus the per-file and per-error-code distribution, with the reproduce command in its header. **The measured number never affects the exit code**, whatever it is; a non-zero exit means the *script* could not run — tsc missing, tsc exiting non-zero with nothing parsed, or generated `src/**/*.d.ts` present (the shared stale-declaration guard rejects that instead of reporting a false 0; measured: `npm run types:build` then `--strict-report` exits **1**) — which is why the CI step is `continue-on-error: true`. **The ratchet number is the non-strict one** — `npm run check:types` is what blocks; this row exists so the strict debt shows up in every log instead of staying invisible. The strict total is **not a gate, is not pinned, and drifts** (snapshot 2026-10-23: **1690 errors / 65 files** on the `#416` branch, **1687 / 65** on the integration tree the same day — both true, the tree differs): the command output is the only truth, so do not sync these literals and do not assert a concrete number anywhere. `-- --with-tools` covers the `./tools` entry, `-- --verbose` prints the full distribution |
| `node bin/cli.js ...` | Run the CLI locally (no installation required) |

- CI (issue #187): `.github/workflows/ci.yml` runs on `pull_request`, on `push` to `main`, and on `workflow_dispatch` (the manual re-run entry point; note that `POST …/dispatches` answers **404** until GitHub has seen this workflow once — a branch push plus any run registers it, then dispatch returns 204), on **node 22** with `fail-fast: false` — 22 is the declared `engines` floor **and** what the hosts actually run, so the gate verifies the runtime users are on rather than a newer one nobody deploys. Install is `npm install --include=dev`, **never** `npm ci` — this repository gitignores `package-lock.json` on purpose (see the `npm lockfile` comment in `.gitignore`), and the two dev packages (`typescript`, `@types/node`, issue #213) are exactly what `check:types` / `check:types-build` / `check:pack-links` / `check:release` need to run at all. **Blocking** steps, in order: `check:syntax` → `test` → `check:docs` → `check:docs:strict` (it is green today, so it blocks — the `continue-on-error` proposed in issue #187 was retired before landing) → `check:docs-spelling` (issue #560: the retired flat-spelling gate, `scripts/retired-spelling-scan.mjs --strict`) → `node scripts/retired-spelling-scan.mjs --self-test` → `check:docs-examples` → `check:pack-links` → `node scripts/pack-link-check.mjs --self-test` → `check:inventory` (issue #534: re-derives the compatibility-pin table from the AST and compares it with the committed numbers; measured 1.8 s, so it blocks) → `check:tests` → `test-hygiene-check --self-test` → `check:types` → `check:types-build` → `check:cli-real` (the `ERIX_E2E_REAL` gate is closed in CI ⇒ it exits 0 with a categorized reason: it self-checks that harness, it is not a real-upstream signal) → `check:release` under `if: matrix.node == 22` (offline and self-cleaning; the condition is trivially true on today's single-entry matrix and stays as the guard if a second node version is ever added back) → `docs-drift-check --self-test`. One step is deliberately **not** blocking: the issue #416 strict observation (`npm run check:types:strict`) carries `continue-on-error: true` — the number it prints never decides anything, but the script itself can still exit 1 on a dirty tree (residual `src/**/*.d.ts`), so "observation only" is enforced by that flag rather than by the command's own exit code. `node scripts/test-hygiene-check.mjs --self-test` is the hygiene guard's own reverse proof, **blocking** since issue #374: the same rule table runs over an **in-memory fake file set** (nothing is written, `test/` is not touched) — `mkdtempSync(...)`, `mkdtemp(...)` and `fs.mkdtemp(...)` must each come back red, `makeTmp(...)` green, the `test-hygiene-exempt: <reason>` comment green while the reason-less form is red and names the line, `test/helpers/tmp.js` itself uncounted, and a mutation that stops applying also fails (the #210 R2 convention). It is a separate CI step from `check:tests` on purpose: `check:tests` proves today's `test/` is clean, this one proves the rule table still bites — breaking the table leaves the former green (measured: dropping the `Sync` variant from `bare-mkdtemp` keeps `check:tests` at exit 0 while this step goes red on 3 cases). `npm run soak` needs a real relay configuration and key ⇒ **never** in the default CI. `node scripts/docs-drift-check.mjs --self-test` is a **blocking** step since issue #302: its expectation set is decoupled from whether the gitignored `docs/tasks/` directory exists — the two `#280` tree-shape cases now run on a **synthetic tree fixture** (no archive directory / empty archive directory / filled archive directory, each of the three shapes run separately), and the landing check compares the fixture's declared archive inventory with the index instead of counting this machine's real files. Measured on three `git archive HEAD | tar -x` trees: **103 cases, 0 red in all three shapes** — the clean-clone reds tracked by issue #281 (3 expected reds, 5 with an empty `docs/tasks/` in the tree) are **gone**, so the `continue-on-error: true` of that era was retired. Two shapes still red without any regression, and both are meant to: **adding a `.gitignore` directory rule without classifying it in `IGNORED_DIR_CLASSES`** (the checker names the rule itself: `.gitignore:N 的目录规则 … 没在 IGNORED_DIR_CLASSES 里分类`), and — since #302 — the **reverse** direction, a class in `IGNORED_DIR_CLASSES` whose rule no longer exists in `.gitignore` (an idle entry; `test/static-guards.test.js` guards the pair in both directions, and that is how the dead `build-output` entry (the dist directory: no `.gitignore` rule for it ever existed) was found and removed). `docs/delivery/` is classified like `docs/tasks/` **and** left untracked, so **the durable delivery evidence lives in the PR/issue comments, not in the repository tree**. Gitea is a code mirror only: **no** Actions pipeline is set up there, GitHub stays the single runner.
- Gate reproducibility (issue #280): `npm run check:docs` and `npm run check:docs:strict` must exit 0 both in a development worktree and on a **fresh clone** (`git archive HEAD | tar -x -C <empty dir>`). The “local archive” class — files under `docs/tasks/`, a directory that is gitignored on purpose and therefore absent in any clone — is adjudicated by its **declaration** (an entry in `LOCAL_ARCHIVE_REFS`, or an in-line statement next to the reference); the physical file is verified only as a bonus when that directory happens to exist, and its absence never turns the gate red. The two gates that genuinely have a local prerequisite are `npm run check:pack-links` and `npm run check:release`: they need `node_modules`, because they shell out to `tsc` / `npm pack`.
- Test isolation rule: tests involving `~/.erix` or `~/.pi` must inject `home`/`cwd` parameters (the skills/mcp/config tests provide precedents), to avoid contaminating real user configuration.
- Type-surface rule (issue #213): `src/**/*.d.ts` are **generated, never committed** (`.gitignore` covers them); `files` already ships
  `src`, so the tarball carries declarations the repository does not. The `prepack` hook regenerates them on `npm pack`/`npm publish` and
  must log to **stderr only** — lifecycle scripts inherit npm's stdout, and `scripts/pack-link-check.mjs` parses `npm pack --dry-run --json`.
  Two JSDoc shapes silently degrade a parameter to `any` (no compile error, discovered only by reading the emitted `.d.ts`, both fixed in
  #213 R4): a **standalone `//` line inside an inline `@param {{ … }}` type literal**, and a **doc block that is not the comment directly
  above its declaration**. When a host-facing signature matters, read the generated `.d.ts`, not the source comment.
- `--checkJs` ratchet rule (issue #214): `npm run check:types` does **not** aim for zero errors — 110 of them
  (27 files) are accepted debt (the #214 measurement was 218; issue #177 knife 1 took one off
  `src/loop/orchestrator.js` by annotating `resumeRunSnapshot`; PR #249 — the #213 provider-factory JSDoc — took
  75 more, **all of it in two files**: `src/providers/openai.js` 46 → 7 and `src/providers/anthropic.js` 45 → 9,
  the other 27 error-carrying files moved by zero; issue #265's `src/store/notes.js` refactor took 21 more, again
  **all of it in one file**: `src/store/notes.js` 27 → 6, the two new `// @ts-check` modules
  (`src/store/notes-port.js`, `src/store/notes-memory.js`) contributing 0, and the other 28 error-carrying files
  moving by zero — verified file by file against the `7354fab^` tree exported with `git archive`, which reproduces
  142 / 185 verbatim). What it guarantees is **never up**: the total is compared against the
  `BASELINE_ROOT = 110` constant in `scripts/type-check-ratchet.mjs` (re-measured 2026-10-31 on the current tree
  with `typescript@5.9.3` + `@types/node@22.20.5`, **both tiers lowered in the same commit**: 116 → 110 and
  152 → 146, six units each; the 2026-10-23 round before it read 117 → 116 and 153 → 152, one unit each; the 2026-10-21 round read 117 / 153 and 2026-10-15 read 119 / 162, both now
  **historical values**; the 226 in the issue body
  reproduces on the pre-#213 tree `bc3ad02`, which is why the number committed at #214 was 218 and not 226).
  **Which half to pay down first**: 81 of the 110 (in 18 files) sit in files a host can actually reach — re-measured
  2026-10-31 after the #630 S2 round (81 reachable + 29 implementation-only = 110: the −6 landed in
  `src/run-state.js` −6, `src/loop/orchestrator.js` −3 and `src/reflection/wrapup.js` −3, which left the
  error-carrying set entirely, while `src/compact/pipeline.js` +3 and `src/compact/fold-llm.js` +3 sit on the
  implementation-only / public halves respectively, so the reachable share went 90 → 81 and its file count 19 → 18),
  re-measured
  2026-10-13 by aggregating the tsc output per file and classifying each file against the closures, re-derived 2026-10-15 after #292 (93 reachable + 26 implementation-only = 119: the −2 all landed in `src/compact/pipeline.js`, which sits in the implementation-only half, so the reachable share was unchanged at 93), and re-derived again 2026-10-23 after #409 (90 reachable + 26 implementation-only = 116: this time the −1 landed in `src/messages/openai-normalization.js`, which **is** in the public half — `src/index.js` re-exports it directly — so the reachable share dropped 91 → 90 and its file count 20 → 19 while the 26 / 9 implementation-only side did not move; the round before that, 2026-10-21 after #335's first step, read 91 reachable + 26 implementation-only = 117, the −2 having landed in `src/display/projection.js`), **not** by
  subtracting 21 from the 142-era 114: the type-reference closure of the published `src/index.d.ts`
  and `src/tools/index.d.ts` is **51 modules** under `src/` (re-measured 2026-10-31 by walking the relative
  specifiers of the emitted declarations transitively, the two entries themselves excluded; 53 with them
  included). The older counts in this paragraph (42 on 2026-10-21, 40 / 38 / 41 in the rounds before it) came from
  a narrower walker and are **historical values** — what the number is for is deciding which files sit on the
  implementation-only side, and that set is unchanged at 9 files.
  the other 29 sit in the same 9 implementation-only modules no host can name (`run-snapshot-executor` 8,
  `compact/pipeline` 6, `error-ledger` 3, `providers/timeout` 3, and 5 more at 1-2 each) — re-measured
  2026-10-31, still the same 9 files (only `compact/pipeline` moved, +3), and all 21 units #265 removed fell on
  the public half, since `src/store/notes.js` is itself inside the public closure. Admission rules for the whitelist:
  - **New files must open `// @ts-check` on line 1.** It is a declaration of intent, not the scope control:
    `--checkJs` plus `src/index.js` already pulls the whole import graph — `--listFiles` measures **70 files under
    `src/`** reached from that one entry (re-measured 2026-10-23; the 65 recorded on 2026-10-21, the 58 on
    2026-10-13 and the 56 before #265 are **historical values**),
    **27 of them carrying errors** — so picking "just the public entry" as
    the input file narrows nothing; the whitelist has to be per-file, which is exactly what #214 R2 asks for.
  - **Touching a file whose error count can go down is a drive-by opportunity** (the #179 pattern: fold it into
    the PR that is already in that file, never a standalone ticket). When the total drops, lower the baseline
    constant in a **separate commit** and say which file lost how many errors — the value of a ratchet is that
    the number only shrinks.
  - ⚠ **Delete the generated declarations before running it.** tsc resolves `./x.js` to a sibling `x.d.ts` first,
    so after `npm run types:build`/`prepack` the ratchet would be checking declarations instead of
    implementations: measured on the post-#249 tree (2026-10-11), **142 errors** with no `.d.ts` present, **0 errors**
    with the then-61 declarations present (`--skipLibCheck` skips declaration files), **13 errors all pointing at `.d.ts`** if
    `--skipLibCheck` is dropped; re-measured 2026-10-31 on the current tree (where `npm run types:build`
    emits **87** declarations — the earlier counts 61 (the 2026-10-11 tree), 63 (`39e96f1`, 2026-10-13), 64 (the 0.20.0 tarball), 65 (the post-#292 tree, 2026-10-15), 71 (the post-#386 tree, 2026-10-22) and 72 (the post-#339 tree, 2026-10-21) are **historical values**; current: **110 errors** with none present, **0 errors** with the 87 present, and the same **13 errors on `.d.ts` files** without `--skipLibCheck`.
    "0 errors < baseline" would be a **false green**, so the script hard-fails on
    stale `src/**/*.d.ts` (the repository commits zero `.d.ts`, so their presence always means generated).
    Fix: `find src -name '*.d.ts' -delete` — they are git-ignored and regenerable.
  - Known hole, deliberately left open by the spec: the second public entry `src/tools/index.js` pulls in
    `src/tools/file-tools.js` (20 errors) and `src/skills/loader.js` (16), which the package-root graph never
    reaches, so new errors there are **not** caught by the default gate. `npm run check:types -- --with-tools`
    gates the union (baseline **146** / 29 files = 110 + 20 + 16, re-measured 2026-10-31; the per-file counts are
    re-counted every time the tiers are lowered — this round both tiers lost the same six units and none of them is
    in `src/tools/file-tools.js` or `src/skills/loader.js` (still 20 / 16): the −6 is `src/run-state.js` 10 → 4,
    `src/loop/orchestrator.js` 17 → 14, `src/reflection/wrapup.js` 3 → 0 (that file leaves the error-carrying set)
    against `src/compact/pipeline.js` 3 → 6 and `src/compact/fold-llm.js` 2 → 5, and the round before it lost a
    single unit that is
    `src/messages/openai-normalization.js` going 1 → 0 as a side effect of issue #409 (`6b604e7` routed
    `parseOpenAIToolArguments` through the shared `parseToolArguments`, and `d9a0989` flattened
    `parseJsonWithRepair`'s `@returns`, which also removed the one unit the new `src/messages/tool-arguments.js`
    had briefly added), so the error-carrying file count went 31 → 30; the previous round (2026-10-22)
    `src/tools/file-tools.js` went 23 → 20 while `src/skills/loader.js` stayed
    at 16, and those 3 units are the whole of the 156 → 153 drop, knocked out as a side effect of the read-side
    honesty work PR #370 did for issue #358 (`editDiffTruncated` joined that cause union); the earlier 160 → 156 drop
    was the same file going 27 → 23 through the `markerCount` narrowing PR #356 added for `toolMarker`) and is the cheap way to tighten this later.
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
- Referring to a file in **another repository** (issue #286 family, 工单 261021-03 B1): write it as
  `<repo-name>:<path inside that repo>` — e.g. `touwaka:lib/agent/`,
  `pi-subagents:src/runs/background/async-execution.js:4`. A prefixed reference is *not* looked up in this repository
  and its line numbers do **not** count against the bare-line ratchet below; the repo name must be one registered in
  `EXTERNAL_REPO_PREFIXES` in `scripts/docs-drift-check.mjs` (an unregistered name is red, and a registered name that
  nothing references is red too). **A path without a prefix is a path inside this repository and must resolve here** —
  that is the whole point of the marker: it names ownership instead of granting a free pass.
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
  re-export / method / object key / `process.env.X`). A missing symbol is red and the message names the nearest
  symbols actually declared there; a file from which no declaration can be extracted at all is red too (#164:
  no silent pass when ground truth cannot be read). Named string *values* — termination reasons, provider error
  codes — are the one weaker tier and are accepted only in the four files listed with a reason in
  `SYMBOL_VALUE_MEMBERSHIP` in `scripts/docs-drift-check.mjs`. Because the bare-line ratchet keys on
  (document, target file, line range) — **never on the doc's own line number** — rewriting
  `` `symbol` (`path:1517-1531`) `` into a bare `path:1517-1531` leaves that count untouched while deleting the
  symbol check entirely, so `symbols` carries its own **only-up floor** `SYMBOL_ANCHOR_MIN_UNIQUE = 175` (groups measured today: 175 unique (symbol, file) pairs over 535 occurrences — docs-261031-01 moved the delegate section out of the paired 0.28.0 guide into a new paired 0.29.0 guide (`docs/host-upgrade-guide-0.29.0.md` and `docs/host-upgrade-guide-0.29.0_cn.md`), a net +3 groups / +5 occurrences over the previous floor; before that 172 groups / 530 occurrences — issue #617 P2's paired 0.28.0 guide section on the CLI's `delegate` sample cited `createDelegateTool` / `TERMINATION_TO_STATE` (`src/tools/delegation/tool.js`), `writeRecord` (`src/tools/delegation/roster.js`) and `createCliDelegation` (`bin/delegation.js`) ⇒ +2 groups / +3 occurrences — slice A2 of the same pre-release docs work (issue #578, issues #588 / #589) added two additive-event rows to the observer-event table and two structural rules to the continuity section, citing `pendingTailToolUses` (`src/loop/pending-tool-result.js`), `roundHoldsContinuityBlock`, `selectFoldedRounds` and `isProtectedMessage` (`src/compact/helpers.js`), `summarizeFoldedPayload` (`src/compact/fold-statistical.js`) and `ensureUserTurnView` (`src/loop/request-user-view.js`) ⇒ +4 groups / +5 occurrences over slice A; the A slice (#569 / #568 contract section) had taken it from 158 to 164 with +6 groups / +24 occurrences, measured against the backed-up contract pair in the same tree (158 groups / 492 occurrences — the 489 this sentence used to carry was itself stale by 3). ⚠ **This sentence is itself inside the anchor face**: its own `(path)` anchors lifted `AGENTS.md` 20 → 25 groups and `AGENTS_cn.md` 43 → 47, so the floor must be re-measured **after** editing AGENTS — measuring first and writing second yields a low number (163 was such a read), and since both `--self-test` cases key on measured == floor, a low floor turns them red; before that 158 unique (symbol, file) pairs over 489 occurrences — issue #571 slice 1 landed the `createAgent` contract section as an EN/CN pair, citing `createAgent` (`src/loop/orchestrator.js`) plus `CONFIG_LEAF_BINDING`, `configSchemaSelfCheck` and `configLeafNamesForBinding` (`src/loop/config-namespace.js`) ⇒ +4 groups / +16 occurrences; before that 154 unique (symbol, file) pairs over 473 occurrences — issue #545 turned `policy` into a data-only surface, which moved the “construction-time value + same key at call time” live sample off `policy.todoStateProvider` onto a port-derived key, so both contract languages now cite `assertAssemblyOverrideConflicts` (`src/assembly.js`) ⇒ +1 group / +1 occurrence, measured with `--verbose` on the tree after merging main `66a362f`; previously 153 unique pairs over 452 occurrences — issue #498 S4c added +2 groups / +8 occurrences over base `cdf0f6d`'s 151 / 444: the contract pair's new `#### capabilities.ports (issue #498 S4c)` subsection cites `CAPABILITY_SLOT_DESTINATIONS` (`src/loop/capabilities-namespace.js`, the nine leaves that have no flat alias) twice per language and `resolveCompactionStrategy` (`src/compact/strategy-resolution.js`, the object-passthrough the strategy port relies on) once per language (+2 groups / +6 occurrences), and this very claim sentence cites those two groups once each (+2 occurrences), re-measured with `--verbose` on this branch's tree; before that 151 / 444 — issue #498 S4b's contract pair added one group / six occurrences: the `config` section's new `CONFIG_LEAF_ALIAS_PATHS` (`src/loop/config-namespace.js`) anchor for the one registered leaf alias, plus extra occurrences of `normalizeDeliverables` (`src/loop/deliverables.js`) and of that same alias symbol where the `capabilities.checks` rules say the shape is not restated there, re-measured on this branch's tree; before that 150 / 438 — the contract EN/CN each gained a paired “The `capabilities` namespace (issue #498)” section that cites three symbols from the new `capabilities-namespace.js` module (its schema table, the hook list and the derived alias map) ⇒ +3 groups / +8 occurrences, re-measured on main `b3ee7f1`; before that 147 / 430 — 147 / 432 on the **final tree** of the #497 review, minus 2 occurrences when the second-round cleanup restored this very sentence's serialised chain item: the `again to 121` / `again to 122` items had been swallowed into a duplicated block, deleting the duplicate removed two anchors and changed no group, bare line numbers still 130 vs 130; that 147 / 432 was itself re-measured after the six must-fix items of the #497 review — the R1 criterion rewrite, the R4 per-leaf conflicts between the two config sources and the R6 shipped-surface correction — made the contract EN/CN cite `resolveAssemblyMember` (`src/assembly.js`) and `modelMetadataFor` (`src/loop/budget.js`), +2 groups / +9 occurrences over 145 / 423; before that 145 / 423, re-measured on main `109a0a3` (after #499) after issue #497's contract pair `### The config namespace (issue #497)` / `### config 命名空间（issue #497）` added six symbols — the `config` schema and its derived alias/surface tables, the schema self-check and the capability list in `src/loop/config-namespace.js`, plus the normaliser that expands the namespace — +6 groups / +7 occurrences; before that 139 / 416, re-measured on main `109a0a3` after issue #499 retired `context.onFoldSummary`, which made the contract EN/CN plus both README claim sentences cite `CONTEXT_OPTION_NAMES` (`src/assembly-validators.js`) (+1 group / +4 occurrences); before that 138 / 412, re-measured on this branch after issue #496's contract pair `### Where option validation happens (issue #496)` / `### 选项校验发生在哪里（issue #496）` added four gate symbols — `assertRunToolLoopOptionNames` (`src/loop/option-normalization.js`), `assertSemanticOptionValues` / `collectSemanticOptionProblems` (`src/assembly-validators.js`) and `normalizeDeliverables` (`src/loop/deliverables.js`); before that 134 / 398, re-measured on this branch after the 0.26.0 host-upgrade guide pair (`docs/host-upgrade-guide-0.26.0.md` / `docs/host-upgrade-guide-0.26.0_cn.md`) each cited two symbols together with their files — `buildFoldedFacts` (`src/compact/fold-summary-journal.js`, the constructor of the fold substitute) and `planFoldedHistoryTrim` (`src/compact/resume-fold-trim.js`, the watermark trim planner) — +2 groups / +8 occurrences), re-raised to 132 when issue #467's new Termination contract paragraphs added two pairs — `hasFinalDraft` (`src/loop/termination.js`) and `appendEngineMessagesToTranscript` (`src/loop/orchestrator.js`), EN +2 / CN +1 occurrences), re-raised to 130 when issue #433 fix 1 (the CLI resumes a silent kill from the transcript) added a paired contract section citing `IDLE_RETRY_BASE_DELAY_MS` (`bin/idle.js`) and re-citing the existing `restoreResume` (`src/loop/resume-manager.js`) — +1 group / +4 occurrences), re-raised to 129 when issue #440 (CLI idle kill keeps the engine's termination payload) added a paired contract section citing `idleTimeoutFailure` / `IDLE_TIMEOUT_CODE` (`bin/idle.js`) and `annotateTermination` (`src/loop/termination.js`) — +3 groups, re-measured on the tree merged with main as 129 groups / 380 occurrences (the branch-local figure 128 / 391 is kept as history, not as the floor), re-raised to 126 when PR #451 (issue #406 B2-b) replaced the two bare line ranges pointing at the end-turn wrap-up block with a symbol anchor `normalizeWrapupText` (`src/reflection/wrapup.js`), one per contract language (+1 group, measured on the tree merged with main `7d0e9dd`), raised from 32 when the 0.21.0 guide pair
  landed, again for the #293 fixes to the 0.19.0 guide, again to 45 when #313's contract section merged on top
  of them, again to 53 when #314's host-side guard section landed as a pair, and again to 63 when the 0.21.0 guide
  pair grew the #313 / #314 / #312(b) host sections during the 0.21.0 fold-in (工单 261016-021), reproducible via `--verbose`, and again to 67 when the #326 store-dedup contract section landed as an EN/CN pair, and again to 72 when 架构×2 / 图表×2 / 需求对照×2 and `examples/pi-extension/README.md` joined the coverage (工单 261021-03 B1 — five new groups: `resolvedToolResultTtl`, `markStablePrefix`, `loadModelSlot`, `createProviderForSlot`, `createJsonFileModelConfigProvider`, and again to 75 when the direction-hint archive-row wording landed as an EN/CN contract pair (工单 261021-04 — three new groups: `pendingDirectionHints`, `directionHintText`, `restoreResume`), and again to 77 when the 0.23.0 host-upgrade guide pair landed (工单 261021-12 — `projectTranscriptForDisplay` / `foldMessageRows`), again to 80 when the #361 "row shape on disk is not the shape after `load()`" contract section landed as an EN/CN pair (工单 F2 — three new groups: `isRoundCarrier`, `createMemoryTranscriptStore`, `createFileTranscriptStore`), and again to 95 when the 0.24.0 host-upgrade guide pair landed (工单 261022-17 — fourteen new groups, e.g. `compactionStatsWindow` / `validateRunState` in `src/run-state.js`, `COMPACTION_STATS_STATE_LIMIT` in `src/compact/pipeline.js`, `assertSnapshotPersisted` / `makePersistenceFailure`, `toolMarker` / `displayName` / `searchRootError` / `withDeprecation` in `src/tools/file-tools.js`, plus `BASELINE_WITH_TOOLS` and `makeTmp`), and again to 98 when the #386 `finalGuard` payload contract section
  landed as an EN/CN pair (工单 P — three new groups: `callFinalGuard` in `src/loop/termination.js`,
  `summarizeArgument` in `src/reflection/judge.js`, `resolveTaskBrief` in `src/loop/task-brief.js`), and again to 102 when the
  #386 slice-3 budget-bridge contract section landed as an EN/CN pair (工单 R — four new groups: `extensionAllowed`
  in `src/reflection/governor.js`, `applyGovernorExtension` in `src/loop/orchestrator.js`,
  `FINAL_GUARD_EXTENDABLE_REASONS` in `src/loop/termination.js`, `isApiInputOverBudget` in `src/loop/budget.js`), and again to 103 when the
  #393 pending-`tool_use` tail repair landed as an EN/CN contract pair (one new group: `PENDING_TOOL_RESULT_TEXT`
  in `src/loop/pending-tool-result.js` since issue #394 moved it next to the repair action), again to 105 when #391 的交付物小节中英成对改成「只给命名判据」并新增 `createNamedDeliverableChecks`（工单 V——两个新组：`createDeliverableChecks` 与 `createNamedDeliverableChecks`，都在 `bin/final-guard.js`；`--verbose` 实测 **105 组 / 264 处**，契约 EN 75 / CN 74）, and again to 109 when #394 的「强制收尾 / guard 续跑注入前结清悬空 `tool_use`」落成契约 + 指南中英成对的一节（工单 Z——四个新组：`answerPendingTailToolUses` 与 `PENDING_TOOL_RESULT_TEXT` 都在 `src/loop/pending-tool-result.js`、`pendingTrailingToolUses` 在 `src/messages/rounds.js`、`buildToolResultFact` 在 `src/tool-fact.js`、`exitCodeForVerification` 在 `bin/cli.js`；`--verbose` 实测 **109 组 / 287 处**，契约 EN 81 / CN 78，0.24.0 指南 EN 20 / CN 22）, and again to 114 when #407 的流式思考别名（只认 `delta.reasoning_content` ⇒ 走引擎自己拼的请求时**两个模型的思考 100% 丢失**）落成 CHANGELOG（不入面）+ 契约中英「推理文本」各一句 + 0.24.0 指南中英 §15 + 中英 AGENTS 声称句（工单 A — 五个新锚点：`streamReasoningText` / `REASONING_DELTA_FIELDS` / `chatStream` / `probeStreamUsage`（`src/providers/openai.js`）与 `openAIResponseToCanonical`（`src/messages/canonical.js`）；声称句自己也入锚点面：`AGENTS.md` 0 → 2 组、`AGENTS_cn.md` 15 → 17，`--verbose` 实测 **114 组 / 317 处**，契约 EN 84 → 85 / CN 80 → 81，0.24.0 指南 EN 21 → 29 / CN 24 → 32）, and again to 119 when #409 的「工具引数解析失败 ⇒ 不执行该工具 + 把解析器原判词作为 `is_error` 的 `tool_result` 回退给模型」落成契约中英成对的一节（工单 B — 五个新组，各中英两处：`REPAIR_RULES` 与 `parseJsonWithRepair` 在 `src/text/repair-json.js`、`parseToolArguments` 与 `describeToolArgumentsParseError` 在 `src/messages/tool-arguments.js`、`RUN_TOOL_LOOP_OPTION_NAMES` 在 `src/loop/option-normalization.js`；`--verbose` 实测 **119 组 / 327 处**，契约 EN 85 → 90 / CN 81 → 86）, and again to 120 when #420 widened the "a resumed run leaves the ledger closed" sentence from replayed results to every result (工单 C — one new group, `journalResumeUnpersistedToolResults` in `src/loop/orchestrator.js`, EN/CN contract one site each; `--verbose` measured **120 groups / 335 occurrences** — AGENTS_cn 20 → 21, contract EN 92 / CN 88), again to 121 when the #430 slice-anchor fix landed as an EN/CN contract pair — every result of one crash round folds back into **one** aggregated `user` message, no matter how many there are, because the anchor is the first slice and never advances (one new group: `threeToolCrashScene`, the shared crash scene in `test/loop-resume-unpersisted-tool-results.test.js`; `--verbose` measured **121 groups / 341 occurrences** — contract EN 95 / CN 91), and again to 122 when #438's per-round usage accounting section landed as an EN/CN contract pair (one new group, `addUsage` in `src/loop/orchestrator.js` — the single accounting point the split is booked at; `--verbose` measured **122 groups / 346 occurrences** — contract EN 97 / CN 93, the merge with #430 putting the `threeToolCrashScene` anchor of this very claim sentence into `AGENTS.md` as well), again to 122 when #406 B2-a landed the `normalizeModelJson` contract section as an EN/CN pair (工单 D — two new groups: `normalizeModelJson` in `src/normalization/parse-model-json.js` and `createProviderForSlot` in `src/config/slot-provider.js`; `--verbose` measured **122 groups / 350 occurrences**, contract EN 94 → 99 / CN 90 → 94), and again to 123 when PR #443's pre-merge review landed the `#### Cost of the optional call` / `#### 可选调用的成本` contract pair (one new group: `DEFAULT_PROVIDER_TIMEOUT_MS` in `src/config/slot-provider.js`, EN/CN one site each; `--verbose` measured **123 groups / 355 occurrences**, contract EN 99 → 101 / CN 94 → 96)):
  dropping below it is red — that is the degeneration being caught, not a ratchet rise — and exceeding it earns a "raise the floor" note.
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
  (document, target file, line range), may never exceed `BARE_LINE_REF_BASELINE = 130` in that same script (lowered from 132:
  PR #451 turned the contract's two bare ranges pointing at the end-turn wrap-up block into a symbol anchor).
  The number
  is reproducible with `node scripts/docs-drift-check.mjs --verbose`: 134 unique ranges minus 4 declaratively exempted
  example / host-repo paths (`BARE_LINE_EXEMPTIONS`: the entry names one document + one placeholder path, **and** that path plus a
  declaration word must both appear on the referencing line — a leftover "for example" elsewhere is not a declaration; an entry
  nobody uses goes red; and the register carries its own config check, so a declaration pattern that can match the empty
  string (or carries a `g` flag, making `.test()` stateful) is itself an error — same dual-condition family as #286's
  `test/static-guards.test.js`). An out-of-range line number is an
  error, not an observation. Scope is the 37 documents a host actually reads: the two READMEs, both AGENTS files, both
  contract files, both architecture docs, both chart docs, both requirements docs, `examples/pi-extension/README.md`,
  plus **every** `docs/host-upgrade-guide*.md` (discovered from the directory, so a new guide is
  covered the moment it exists). Directory discovery has a silent failure mode — renaming a guide away from that
  pattern shrinks the coverage in the script **and** in the test that mirrors the same glob, so both numbers still
  agree: `REF_SCAN_DOCS_MINIMUM = 45` is the floor (13 pinned documents + the 32 guides found today; raised from 22
  when the 0.22.0 guide pair landed, and from 24 to **31** in 工单 261021-03 B1 because 架构×2 + 图表×2 + 需求对照×2 +
  `examples/pi-extension/README.md` were brought into scope — those seven documents are read as *current state*, so a dead
  reference in them is worth at least as much as one in an entry document), and `test/docs-anchor-ratchet.test.js`
  keeps its own pinned list of those 13 + 26
  file names. Renaming or adding a guide is
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
- `files` is a **long explicit allowlist** — `package.json` is the only truth, do not transcribe it from here: `src`, `bin`, `skills`, `README.md`, `README_cn.md`, `CHANGELOG.md`, the host-consumer contract pair, the host-upgrade guides (each one listed by name), `LICENSE`, and the contract suites under `test/contract/` **enumerated file by file** (`test/contract/assembly-port.js`, `…`, no directory entry, which is why the `*.test.js` suites next to them never ship). Inspect the tarball with `npm publish --dry-run` before publishing.
- Use the `git+https://...` format for `repository.url` (or run `npm pkg fix`).
- Type surface (issue #213): `types` points at `./src/index.d.ts` and `exports["."]`/`exports["./tools"]` carry a matching `types`
  condition; `exports["./contract-tests"]` has **no** `types` key on purpose (its target lives under `test/`, outside the declaration graph).
  Declarations are generated by the `prepack` hook, so a clean checkout has none — a packed install should list
  **87** `.d.ts` (measured on the #626 C1 tree: `npm pack --dry-run --json` lists exactly 87 since that slice added
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
  65 (post-#292, measured 2026-10-15), 64 (the 0.20.0 tarball), 63 (the 0.19.0 era); +~44 kB packed / +~139 kB unpacked measured on 0.18.0.
  `npm run check:types-build` is the gate that they still generate.
- Current version: `package.json` says `0.27.0`, **unpublished** — the npm registry still serves `0.26.0` (measured `npm view erix-agent version`, 2026-10-28); use `npm version <x.y.z> --no-git-tag-version` for version changes (do not use 0.0.0 for a feature-complete first release). `0.24.0` was **never published** to the registry (the published line is 0.23.0 -> 0.25.0) and is deliberately not back-filled: `0.25.0` supersedes it, and `CHANGELOG.md` keeps its 0.24.0 section as what was true at that moment.

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

### Pre-release checklist (mandatory — the 0.23.0 lesson)

Two things are **mandatory before every publish**, and 0.23.0 went out with neither of them because both were “remembered by hand”: the **documentation audit** and the **real-upstream checklist**. Run them in this order, and only then `npm publish`:

```bash
npm run check:docs && npm run check:docs:strict   # documentation audit (drift + EN/CN sync)
ERIX_E2E_REAL=1 npm run check:release:real        # real upstream, six steps, names the red ones
npm run check:release                             # offline: tarball shape / installed package / TS host / CLI fake upstream
```

Without `ERIX_E2E_REAL=1` the middle line runs **nothing** and exits 0 — that is not a pass, it means the real-upstream half of the release check did not happen, so the release is not verified. The doc audit is not optional either: 0.23.0 shipped documentation that the audit would have caught (contract version labels, EN/CN pairing, storage diagrams).

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
│   ├── <runId>.jsonl          # metadata-only round rows + one row per message (`kind:"message"`, `seq` / `partOf?`); `load()` folds them back into round rows
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
