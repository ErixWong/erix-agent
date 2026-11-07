# erix-agent — Project AGENTS.md

> Chinese version: [AGENTS_cn.md](AGENTS_cn.md)

Project-specific rules; shared/global conventions live in `~/projects/AGENTS.md` and are deliberately not duplicated here. This file travels with the repository (GitHub: ErixWong/erix-agent).

## 1. Project positioning

**A self-developed headless coding agent (headless agent)**: a zero-dependency LLM agent runtime (dual-protocol streaming + tool loop + compaction + checkpoint) for **unattended, host-orchestrated** scenarios (the fde-workshop / touwaka embedded base).

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

One row per gate, three things only: the command, **what it judges**, and the imperative that sends you to
`docs/maintenance/command-reference.md` (the cold half: rationale, reverse proofs, trap notes) before you touch what
that gate owns. Do not skip the third column: every trap it names has bitten this repository once.

| Command | What it judges | Before you change it |
|---|---|---|
| `npm test` | the whole suite (`node --test`) | adding or editing a test ⇒ read `docs/maintenance/command-reference.md#test-suite` |
| `node --check <file>` | one file's syntax | checking a single file ⇒ nothing else to read |
| `npm run check:syntax` | syntax of **every tracked** `.js`/`.mjs`/`.cjs` | moving or renaming a tracked file ⇒ read `docs/maintenance/command-reference.md#check-syntax` |
| `npm run check:test-summary` | the suite summary against its registered baseline | touching `test/test-suite-baseline.json` ⇒ read `docs/maintenance/command-reference.md#check-test-summary` |
| `npm run check:changelog` | CHANGELOG coverage of public-surface merges | merging anything that touches the public surface ⇒ read `docs/maintenance/command-reference.md#check-changelog` |
| `npm run check:docs` | doc drift + EN/CN sync (versions, lists, module map, paths, claims) | touching `README*`, `docs/`, `files`/`exports`, a default or a version ⇒ read `docs/maintenance/command-reference.md#check-docs` |
| `npm run check:docs:strict` | the same, warnings block too | same triggers as the row above ⇒ read `docs/maintenance/command-reference.md#check-docs` |
| `node scripts/docs-drift-check.mjs --self-test` | the anchors' own reverse proof — **Since issue #302 the tree it runs in does not change the verdict**: Before #302 it was the other way round: 3 of the cases were known false reds in a checkout without `docs/tasks/` (not committed); those reds are gone | editing `scripts/docs-drift-check.mjs` ⇒ read `docs/maintenance/command-reference.md#docs-anchors` |
| `npm run check:docs-examples` | the JS fences of both contract docs and both READMEs | editing a fenced example there ⇒ read `docs/maintenance/command-reference.md#check-docs-examples` |
| `npm run check:pack-links` | packaged-Markdown links + the `.d.ts` and publish-surface claims | touching `files`/`exports` or a declaration count ⇒ read `docs/maintenance/command-reference.md#check-pack-links` |
| `npm run check:release` | the offline pre-release checklist as one command | changing anything a packed install ships ⇒ read `docs/maintenance/command-reference.md#check-release` |
| `npm run check:release:real` | the gated real-upstream checklist | running it before a release, with `ERIX_E2E_REAL=1` ⇒ read `docs/maintenance/command-reference.md#check-release-real` |
| `npm run release:day` | the release day in four `--stage`s; the writeback face is `--sync` (`scripts/release-day.mjs`) | releasing ⇒ read `docs/maintenance/command-reference.md#release-day` |
| `npm run check:cli-real` | the **installed** CLI against the real upstream (gated) | touching `bin/` ⇒ read `docs/maintenance/command-reference.md#check-cli-real` |
| `npm run check:docs-spelling` | retired flat option spellings in the living docs | adding or editing any `docs/**.md` or a README ⇒ read `docs/maintenance/command-reference.md#check-docs-spelling` |
| `npm run check:agents-directives` | this page: status claims, expiring measurements, bare coordinates, **the byte budget** | editing `AGENTS.md`/`AGENTS_cn.md` ⇒ read `docs/maintenance/command-reference.md#check-agents-directives` |
| `npm run types:build` | generates the published `src/**/*.d.ts` | touching a host-facing signature ⇒ read `docs/maintenance/command-reference.md#type-surface` |
| `npm run check:types-build` | the declarations still generate and carry the entry symbols | same ⇒ read `docs/maintenance/command-reference.md#type-surface` |
| `npm run check:types` | the `--checkJs` error-count ratchet (`--with-tools`: baseline **138** / 29 files) | touching `src/` ⇒ read `docs/maintenance/command-reference.md#type-ratchets` |
| `npm run check:mutation` | the committed mutation-sample table against the tree | editing `test/mutation-samples.md` ⇒ read `docs/maintenance/command-reference.md#check-mutation` |
| `npm run check:mutation:run` | the samples actually bite (mutate → red → restore → green) | same ⇒ read `docs/maintenance/command-reference.md#check-mutation` |
| `npm run check:exports` | who consumes each exported name — **no gate, no judgement**; three entries incl. `test/contract/`, plus an `internal-only` tier (`scripts/export-consumer-check.mjs`) | removing an export ⇒ read `docs/maintenance/command-reference.md#check-exports` |
| `npm run check:exports:deprecated` | the zero-consumer deletion registry and the `@deprecated` marker rules | marking or deleting an export ⇒ read `docs/maintenance/command-reference.md#check-exports-deprecated` |
| `npm run check:host-consumers` | host-side imports of the names marked for removal — judged only with `--hosts`, never in CI, candidate list recomputed live by the probe's own `computeInventory`, never copied (`scripts/host-consumer-probe.mjs`) | before a breaking release ⇒ read `docs/maintenance/command-reference.md#check-host-consumers` |
| `npm run check:inventory` | the compatibility-pin table against the tests' AST | touching a compatibility pin ⇒ read `docs/maintenance/command-reference.md#check-inventory` |
| `npm run check:config-leaf-values` | the config-leaf value-status tables against a live probe | touching the config schema ⇒ read `docs/maintenance/command-reference.md#check-config-leaf-values` |
| `npm run check:types:strict` | the strict ratchet — it blocks; its two baselines live in the script, **do not copy them here** | touching `src/` ⇒ read `docs/maintenance/command-reference.md#type-ratchets` |
| `node bin/cli.js ...` | runs the CLI locally | debugging only ⇒ nothing else to read |

- **CI wiring is not the gate list** (issue #187): `.github/workflows/ci.yml` runs the blocking steps in a fixed order, and the install is `npm install --include=dev` — **never** `npm ci` (this repository gitignores `package-lock.json` on purpose). Editing it ⇒ read `docs/maintenance/command-reference.md#ci` first: the ordered step list and the two shapes that are red on purpose are there.
- **Gate reproducibility** (issue #280): `npm run check:docs` and `check:docs:strict` must exit 0 in a development worktree **and** on a fresh clone. The gates that need `node_modules` (`check:inventory`, the three `tsc` ratchets, `check:pack-links`, `check:release`) fail with `Cannot find module 'typescript'` in a bare checkout — that is "the gate could not run", never a regression. The local-archive class is adjudicated by declaration: `docs/maintenance/command-reference.md#gate-reproducibility`.
- Test isolation rule: tests involving `~/.erix` or `~/.pi` must inject `home`/`cwd` parameters (the skills/mcp/config tests provide precedents), to avoid contaminating real user configuration.
- Type-surface rule (issue #213): `src/**/*.d.ts` are **generated, never committed** (`.gitignore` covers them); `prepack` regenerates them and must log to **stderr only**; when a host-facing signature matters, read the generated `.d.ts`, not the source comment. Two JSDoc shapes silently degrade a parameter to `any` — read `docs/maintenance/command-reference.md#type-surface` before you write one.
- Type ratchets (`check:types` / `check:types:strict`, issues #214 / #417): `npm run check:types` does **not** aim for zero errors — 103 of them (27 files) are accepted debt, compared against the `BASELINE_ROOT = 103` constant in `scripts/type-check-ratchet.mjs` (that is the baseline constant **103**; the two tiers are independent measurements); above it ⇒ exit 1, equal ⇒ green, below ⇒ green plus a "you may lower the baseline to N" hint, so the total never goes up. **Which half to pay down first**: 74 of the 103 sit in files a host can actually reach, the other 29 in implementation-only modules — **27 of them carrying errors**. With the generated declarations present the same command reports **103 errors** with none present against 0 with them, so stale `src/**/*.d.ts` is a hard fail rather than a false green. `npm run check:types -- --with-tools` widens the union to the `./tools` entry (baseline **138** / 29 files = 103 + 19 + 16); `check:types:strict` re-runs the same invocation with `--strict` against its own pair of baselines in the same script, blocks, and **both tiers are lowered in one commit**. Per-file counts and errors are printed by the command (`--verbose`, `--show-errors N`); the round-by-round history stays in the commits that lowered a baseline.
  - **New files must open `// @ts-check` on line 1.** It declares intent; it is not scope control — the entry's import graph is the scope.
  - **Historical values stay historical, and the constant is the only truth**: the earlier readings measured
    142 / 185 / 218 / 226 / 261 on their own trees are **historical values**, never current state. The current
   reading is the constant's: measured 103 errors (`BASELINE_ROOT = 103`, reconciled by `npm run check:docs`).
  - ⚠ **Delete the generated declarations before running a ratchet**: `find src -name '*.d.ts' -delete`. While they are present `tsc` resolves `./x.js` to a sibling `x.d.ts` and checks declarations instead of implementations.
  - **Measurement discipline (issue #653), and it binds every ratchet and every derived table in this repository**:
    - **Take derived numbers and baselines on the final tree only.**
    - **Rebase before measuring.** When this branch's base is behind `main`, rebase onto `main` first and take
      the numbers after that.
    - **A debt slice and its baseline / derived-table update go in as one PR, atomically.** Several commits
      inside that PR are fine, but the two halves arrive together. Why each of the three is load-bearing is in
      `docs/maintenance/command-reference.md#type-ratchets`.
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
- **Anchor granularity and doc line anchors** (issues #210 / #286): four gate-owned numbers are the only truth on
  this page — `BASELINE_ROOT = 103`, the symbol-anchor floor `SYMBOL_ANCHOR_MIN_UNIQUE = 237` (only-up: dropping
  below it is red, that is the degeneration being caught), the bare-line ratchet `BARE_LINE_REF_BASELINE = 6`
  (only-down), and the anchor-face floor `REF_SCAN_DOCS_MINIMUM = 51`. Docs must not lean on bare line numbers:
  point at a symbol with its file (`` `symbol` (`path`) ``), never at `path:123`. The measurement log that used to
  sit here now lives in `docs/maintenance/symbol-anchor-ledger.md` — history, not current state. Which anchors are
  per-occurrence, the span rule, the exemption registers and their self-test: read
  `docs/maintenance/command-reference.md#docs-anchors` before you add or move one.

## 4. npm publishing guide (verified against the 2026-08 policy)

### Prerequisites (`package.json`)
- `private` must be removed (otherwise 403); edit JSON with a node script, not sed to delete a line (a trailing comma would break JSON).
- `files` is a **long explicit allowlist** — `package.json` is the only truth, do not transcribe it from here: `src`, `bin`, `skills`, `README.md`, `README_cn.md`, `CHANGELOG.md`, the host-consumer contract pair, the host-upgrade guides (each one listed by name), `LICENSE`, and the contract suites under `test/contract/` **enumerated file by file** (`test/contract/assembly-port.js`, `…`, no directory entry, which is why the `*.test.js` suites next to them never ship). Inspect the tarball with `npm publish --dry-run` before publishing.
- Use the `git+https://...` format for `repository.url` (or run `npm pkg fix`).
- Type surface (issue #213): `types` points at `./src/index.d.ts` and `exports["."]`/`exports["./tools"]` carry a matching `types`
  condition; `exports["./contract-tests"]` has **no** `types` key on purpose (its target lives under `test/`, outside the declaration graph).
  Declarations are generated by the `prepack` hook, so a clean checkout has none — a packed install should list
  **89** `.d.ts`; **that number is reconciled against the tarball contents by `npm run check:pack-links` — never
  hand-copy it into these two files.** `npm run check:types-build` is the gate that they still generate. Which slice
  added which module to the declaration graph, and every earlier count, is history:
  `docs/maintenance/command-reference.md#type-surface`.

- Current version: `package.json` says `0.31.0` (the repo version) and the published line — npm's `dist-tags.latest` — is `0.31.0`; `check:docs` reconciles both **live** on every run (it reads `package.json` and the registry and reds on a stale sentence), so neither number carries a measurement date: a date cannot expire by itself, and a live reconciliation needs no second source of truth (issue #511). Use `npm version <x.y.z> --no-git-tag-version` for version changes (do not use 0.0.0 for a feature-complete first release). `0.24.0` was **never published** to the registry (the published line is 0.23.0 -> 0.25.0) and is deliberately not back-filled: `0.25.0` supersedes it, and `CHANGELOG.md` keeps its 0.24.0 section as what was true at that moment.

### npm 2026 policy changes (TOTP discontinued + bypass token restrictions)
- ❌ New TOTP enrollment is no longer supported (`enable-2fa` returns 404).
- ❌ bypass-2FA granular tokens lost direct publishing rights starting in 2026-08.
- ✅ **The only path (`npm@12`)**: `npm i -g npm@12` → `npm login --auth-type=web` → `npm publish` (device flow; the terminal prints the auth URL).
- ⚠️ **Every publish triggers its own device-flow auth**, even right after `npm login`, and the URL must reach the user **in the same message where it was captured** (it expires in minutes; each publish needs a fresh one). In a non-TTY environment it is masked as `***` — the user runs it in their own terminal; the headless pty recipe is `docs/maintenance/command-reference.md#pitfall-4`.
- ⚠️ **Never press ENTER at the "Press ENTER to open in the browser..." prompt**: without a browser it triggers `xdg-open`, which fails and kills npm (code 3). Leave it polling.
- ⚠️ **Prerelease versions require an explicit `--tag`** (enforced by npm12): `npm publish --tag latest`; otherwise it reports `You must specify a tag when publishing a prerelease version`.

### Pre-release checklist (mandatory — the 0.23.0 lesson)

Two things are **mandatory before every publish**, and 0.23.0 went out with neither of them because both were “remembered by hand”: the **documentation audit** and the **real-upstream checklist**. Both are now one command, and it is the only thing to remember:

```bash
npm run release:day -- --stage preflight --hosts <host repo dirs>
#   [1/7] check:changelog                       every public-surface merge is named in this version's CHANGELOG section (issue #691)
#   [2/7] CHANGELOG [Unreleased] carry          entries still parked under `## [Unreleased]` after this version's section was opened (issue #715)
#   [3/7] check:docs                            documentation audit (drift + EN/CN sync)
#   [4/7] check:docs:strict                     same, warnings block too
#   [5/7] ERIX_E2E_REAL=1 check:release:real    real upstream; a closed gate is NOT JUDGED, never green
#   [6/7] check:release                         offline: tarball shape / installed package / TS host / CLI fake upstream
#   [7/7] check:host-consumers -- --hosts …     host-side probe: every hit must already be covered by the upgrade guide
```

It runs those in order and **stops at the first red, naming the step**. Without `ERIX_E2E_REAL=1` the real-upstream step runs **nothing** — that is not a pass, and the command says so and exits 2 rather than 0, so "the real-upstream half did not happen" can no longer look like a green release. The doc audit is not optional either: 0.23.0 shipped documentation that the audit would have caught (contract version labels, EN/CN pairing, storage diagrams).


- **The `[Unreleased]` carry** (issue #715) is step 2 of that list and it answers in three states (red / not judged / green). Which state is which, why `--sync` cannot move the entries for you, and the exact fix it prints are in `docs/maintenance/command-reference.md#release-day` — read it before you open a version section or move its heading.

After that the manual half is exactly **publish and the scan**, and the two steps that used to be remembered by hand are stages too:

```bash
npm run release:day -- --stage publish     # prints the operation sheet, exits 3; run `npm publish` in your own terminal
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]   # write back → commit → check:docs
npm run release:day -- --stage finalize    # tag (version-cut commit) → dual push → both sides verified → docs gates
```

`--stage writeback` is the one that must never be skipped: it rewrites the release state (and nothing else) and re-runs `check:docs` before anything is tagged. `finalize` refuses to tag unless that state is on disk and the worktree is clean, so a tag cannot go out while the docs still say unpublished.

- **Step 5 is mandatory for the 0.31 release** (issue #429): `npm run check:host-consumers -- --hosts <host repo dirs>` walks the host checkouts and requires every import of a name marked for removal to already have a row in the current version's upgrade guide — **the criterion is coverage, not a veto** (this repository is the upstream, so a host hit is a reason the guide must say what to replace the name with, never a reason to keep it). Pass every live checkout; it does not run in CI and must not start doing so. The full ruling is in `docs/maintenance/command-reference.md#check-host-consumers`.

**Beyond the mechanical gates** (`check:docs` / `check:docs:strict` / `check:release`), a human still walks the three classes of **claimed values** by hand before the tag: **defaults** (`default X` / the default `X`), **numbers** (N steps / N items / a constant's value) and **name sets** (strategy names, tool names, flags). Scope: both READMEs, both AGENTS files and both contract documents.
The reason is that an anchor only covers the dimensions somebody registered, and the class that is **easiest to change and most expensive to get wrong** — defaults — has slipped through before: #614 flipped the **CLI slot default** compaction strategy to `fold-llm` while the READMEs and the contract still said `fold-statistical`, with `check:docs` fully green.
When a claim turns out to be machine-checkable, **add the anchor while you are in there** (one cost, permanently immune); only what cannot be mechanised stays on this human list.

- **The `unattributed` pass** is the last human step before the tag: when `check:changelog` prints its `unattributed` note (a public-surface merge whose subject carries no issue number, printed and deliberately not blocking), every short sha in it must be walked by hand — read its first-parent diff and either confirm the change is already described in this version's CHANGELOG section, or write down a reason a later reader can check. The procedure is `docs/maintenance/command-reference.md#unattributed-merges`.

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

4. **No-browser / non-TTY auth flow**: wrap npm in a pty, detach it with `setsid nohup`, extract the URL into a file and hand it to the user — **never press ENTER automatically**. The working recipe is `docs/maintenance/command-reference.md#pitfall-4`.
5. **Auth URL regex gotcha (0.7.0 postmortem)**: the login and publish URLs differ and a naive regex matches neither — use `npmjs\.com/\S*<uuid>` (`docs/maintenance/command-reference.md#pitfall-5`).
6. **Auth URLs expire in minutes**: surface the URL in the SAME message where it was captured, and each publish needs its own fresh device flow (`docs/maintenance/command-reference.md#pitfall-6`).
7. **Publish success ≠ registry availability**: the registry lags after the `+ erix-agent@<ver>` line — poll before declaring failure (`docs/maintenance/command-reference.md#pitfall-7`).
8. **`npm i -g` right after publishing hits stale cached metadata**: install with `--prefer-online` or pin the exact version (`docs/maintenance/command-reference.md#pitfall-8`).
9. **npm 12 lives at `~/.npm-global/bin/npm` and is shadowed by `/usr/bin/npm` (10.x)** — invoke it by absolute path, or a 404/401 PUT sends you to the wrong layer (`docs/maintenance/command-reference.md#pitfall-9`).
10. **Stale token ⇒ publish PUT 404** (misleading): `npm whoami` returning E401 is the ground truth — log in again, then publish (`docs/maintenance/command-reference.md#pitfall-10`).
11. **npm 12's publish PUT returns 202 Accepted** (async processing): the success line prints before the package is visible — poll `npm view <pkg> version --prefer-online` (`docs/maintenance/command-reference.md#pitfall-11`).
12. **Every publish triggers its own device-flow auth**, including right after a fresh `npm login` — capture and surface the URL immediately (`docs/maintenance/command-reference.md#pitfall-12`).

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

Everything the runtime writes lives under `~/.erix/` and is **never committed**: the LLM config, the MCP server
registry, session history (id derived from cwd), transcripts (per-run round rows plus one row per message, and the
per-run archive), user-level skills and per-cwd task lists.

- **Judge logs have a fixed home**: `transcripts/outputs/<runId>/judge.log`, same directory and lifecycle as the
  transcript/tool captures; supervisors inspect judge behaviour there instead of relying on `/tmp` redirection.
- Per-model calibration (blocked rate / false-block rate / extend ROI) is a `runId` join over the decision records
  and the per-run `run_outcome` summary — the record shape, the tree diagram and the rest of that note are in
  `docs/maintenance/command-reference.md#local-runtime-data`.

## 7. Local environment facts

- Relay: `api.ai.erix.vip/v1`; the model must be configured by the user (`contextWindow 262144`, `maxOutputTokens 65536` → automatic compaction budget ~170k). This is the same file `erix_run` reads (`slots.default`); it does not follow pi's current model.
- For tool execution/validation, use `node bin/cli.js chat` for erix work (this repository); the supervisor watches `/tmp/erix-*-log.txt` for step-by-step output.
- Red lines for erix coding tasks: **estimate the read budget before reading and take it in one call** (the `readFile` tool description already carries the budget facts: default line count, per-call byte cap, and the token conversion) instead of conservatively paging small segments, break long tasks down with `todo_add` first, and make a verification declaration before reporting.

## 8. Model and cost discipline

- Never hardcode model names; always read them from the user configuration or use a model explicitly supplied by the user.
- If a model is unavailable, fail immediately; never replace it or fall back to another model.
- Before any batch experiment, report the model, call count, and a cost/time estimate based on historical averages, and obtain the user's confirmation.
- Respect the user's choice of vendor and quota; when the user changes models, it is usually for cost or quota reasons, so do not quietly switch back.