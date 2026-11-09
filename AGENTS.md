# erix-agent — Project AGENTS.md

> Chinese version: [AGENTS_cn.md](AGENTS_cn.md). Machine-wide conventions: `~/projects/AGENTS.md`.
> **This page is part of the system prompt: it is re-sent in full every turn and context folding does not touch it**
> (`npm run check:agents-directives` budgets its bytes, issue #726). It therefore carries only facts that change what
> an agent does here. History, policy evolution, postmortems and per-file numbers live in the cold layer
> `docs/maintenance/command-reference.md`; the last column names which half to open before editing what that gate
> owns. A number on this page is either owned by a gate (reconciled live) or a pointer — never a hand-made copy.

## 1. What this repository is

- **A self-developed headless coding agent**: a zero-dependency LLM runtime (dual-protocol streaming + tool loop +
  compaction + checkpoint + resume) that runs unattended inside a host (fde-workshop / touwaka).
  pi = interactive (human in the loop), erix = headless (host-scheduled): complementary, not competing.
- **The boundary is one task lifecycle** — `runToolLoop` with `executeTool` injected by the host. Multi-role
  arbitration, retry scheduling and orchestration are the host's job and are not absorbed into the library.
- **`bin/` is a validator/debugger, not a contract surface.** A *new* dependency on `bin/` must first be promoted
  into `src/`. The one existing loan: `exec` exists only in `bin/tools.js` and is borrowed by
  `examples/pi-extension` — see that README, section 「边界：不得依赖 bin/」. Capability benchmarks run headless in
  the separate `erix-bench` repository; this repository has no examples/benchmarks directory.
- Security is not built in (ADR-009): the domain using the agent owns it; embedded runs are isolated by the host.
- **Red lines**: zero npm dependencies (import only `node:` built-ins and relative paths), pure ESM, Node 22+, never
  commit a token. The line binds imports, not the toolchain: `typescript` and `@types/node` are devDependencies by
  user authorization (issue #213) — they exist to generate declarations, are never imported by `src/` or `bin/`, and
  never enter the tarball as dependencies.
- `package-lock.json` is git-ignored on purpose ⇒ install with `npm install --include=dev`, **never** `npm ci`.

## 2. Where the code layout lives

`README.md` → the "Module map" section is the tree, and it is the copy `check:docs` reconciles; how big the tree is
is one command (`find src -name '*.js' -not -name '*.d.ts' | wc -l`). This page keeps no copy of the tree, and that
is a rule, not an oversight: the drift check reds a documented path that stops existing but never reds a file nobody
wrote down, so a hand-copied tree on this page rots silently while still costing every turn.

- The one layout fact that *is* a rule: **mock MCP servers stay in `fixtures/`, never under `test/`** — `node --test`
  runs every file under `test/` and those servers hang it.

## 3. Development commands

One row per gate: the command, what it judges, and the cold-layer anchor to read before editing what that gate owns
(all anchors are sections of `docs/maintenance/command-reference.md`).

| Command | What it judges | Anchor to read first |
|---|---|---|
| `npm test` | the whole suite (`node --test`) | `#test-suite` |
| `node --check <file>` | one file's syntax | — |
| `npm run check:syntax` | syntax of every tracked `.js`/`.mjs`/`.cjs` | `#check-syntax` |
| `npm run check:test-summary` | the suite summary against its registered baseline | `#check-test-summary` |
| `npm run check:changelog` | CHANGELOG coverage of public-surface merges | `#check-changelog` |
| `npm run check:docs` | doc drift + EN/CN sync (versions, lists, module map, paths, defaults) | `#check-docs` |
| `npm run check:docs:strict` | the same, warnings block too | `#check-docs` |
| `node scripts/docs-drift-check.mjs --self-test` | the anchors' own reverse proof — **Since issue #302 the tree it runs in does not change the verdict**: Before #302 it was the other way round: 3 of the cases were known false reds in a checkout without `docs/tasks/` (not committed); those reds are gone | `#docs-anchors` |
| `npm run check:docs-examples` | the JS fences of both contract docs and both READMEs | `#check-docs-examples` |
| `npm run check:pack-links` | packaged Markdown links + the `.d.ts` / publish-surface claims | `#check-pack-links` |
| `npm run check:release` | the offline pre-release checklist as one command | `#check-release` |
| `npm run check:release:real` | the gated real-upstream checklist (`ERIX_E2E_REAL=1`) | `#check-release-real` |
| `npm run release:day` | the release day in four `--stage`s; the writeback face is `--sync` (`scripts/release-day.mjs`) | `#release-day` |
| `npm run check:cli-real` | the installed CLI against the real upstream (gated) | `#check-cli-real` |
| `npm run check:docs-spelling` | retired flat option spellings in the living docs | `#check-docs-spelling` |
| `npm run check:agents-directives` | this page: status claims, expiring copies, bare coordinates, byte budget | `#check-agents-directives` |
| `npm run types:build` | generates the published `src/**/*.d.ts` | `#type-surface` |
| `npm run check:types-build` | those declarations still generate and carry the entry symbols | `#type-surface` |
| `npm run check:types` | the `--checkJs` error-count ratchet (`--with-tools`: baseline **137** / 28 files) | `#type-ratchets` |
| `npm run check:types:strict` | the strict ratchet — it blocks; its two baselines live in the script, **do not copy them here** | `#type-ratchets` |
| `npm run check:mutation` | the committed mutation-sample table against the tree | `#check-mutation` |
| `npm run check:mutation:run` | the samples bite (mutate → red → restore → green) | `#check-mutation` |
| `npm run check:exports` | who consumes each exported name — **no gate, no judgement**; three entries incl. `test/contract/`, plus an `internal-only` tier (`scripts/export-consumer-check.mjs`) | `#check-exports` |
| `npm run check:exports:deprecated` | the zero-consumer deletion registry and the marker rules | `#check-exports-deprecated` |
| `npm run check:host-consumers` | host-side imports of names marked for removal — judged only with `--hosts`, never in CI; the candidate list is recomputed live by `computeInventory`, never copied (`scripts/host-consumer-probe.mjs`) | `#check-host-consumers` |
| `npm run check:inventory` | the compatibility-pin table against the tests' AST | `#check-inventory` |
| `npm run check:config-leaf-values` | the config-leaf value tables against a live probe | `#check-config-leaf-values` |
| `node bin/cli.js …` | the CLI locally, for debugging | `#cli-local` |

- CI (`.github/workflows/ci.yml`) is **three jobs by judgement class** (issue #802): `real` (behaviour — blocking on
  every event, node 22 **and** 24), `registries` (committed tables vs the tree) and `docs` (document/instruction
  face) — the last two are visible but **not blocking on `pull_request`**. A release is still strict: `release:day
  --stage preflight` runs all three as blocking steps. Install is `npm install --include=dev`, never `npm ci`.
  Editing the workflow ⇒ `#ci` first. `check:host-consumers` and `npm run soak` stay out of CI.
- **Gate reproducibility**: `check:docs` and `check:docs:strict` must exit 0 in a development worktree *and* on a
  fresh clone. A gate that needs `node_modules` (`check:inventory`, the `tsc` ratchets, `check:pack-links`,
  `check:release`) failing with `Cannot find module 'typescript'` in a bare checkout means **the gate could not
  run**, never a regression ⇒ `#gate-reproducibility`.
- Test isolation: a test touching `~/.erix` or `~/.pi` must inject `home` / `cwd` (skills/mcp/config tests are the
  precedents) so it cannot contaminate real user configuration.
- Type surface (issue #213): `src/**/*.d.ts` are **generated, never committed**; `prepack` regenerates them and logs
  to **stderr only**; when a host-facing signature matters, read the generated `.d.ts`. Two JSDoc shapes silently
  degrade a parameter to `any` ⇒ `#type-surface`.
- **Type ratchets** (`check:types` / `check:types:strict`, issues #214 / #417): `npm run check:types` does **not**
  aim for zero errors — 102 of them (26 files) are accepted debt, compared against the `BASELINE_ROOT = 102`
  constant (baseline constant **102**) in `scripts/type-check-ratchet.mjs`: above it ⇒ exit 1, equal ⇒ green, below ⇒
  green plus a "you may lower the baseline" hint, so the total never rises. Which file carries how much, and whether
  it is host-reachable, is printed by `--verbose`; what this page claims and the measurement reconciles is the file
  count: **26 of them carrying errors** (26 of the 102). ⚠ **Delete the generated declarations before running a
  ratchet** (`find src -name '*.d.ts' -delete`): while declarations sit next to their sources, `tsc` resolves `./x.js`
  to the sibling declaration, so it checks declarations instead of implementations. With them present the same
  command reports **102 errors** with none present against 0 with them, so a stale `src/**/*.d.ts` is a hard fail
  rather than a false green.
  `npm run check:types -- --with-tools` widens the union to the `./tools` entry (baseline **137** / 28 files
  = 102 + 19 + 16); `check:types:strict` re-runs it with `--strict` against its own baselines, blocks, and **both
  tiers drop in one commit**. Historical readings (142 / 185 / 218 / 226 / 261) are historical values, never current
  state; the reading that counts is measured 102 errors (`BASELINE_ROOT = 102`).
- **Measurement discipline** (issue #653, binding for every ratchet and derived table here): take derived numbers and
  baselines on the **final tree**, rebase onto `main` first when the base is behind, and land a debt slice together
  with its baseline / derived-table update in **one** PR.
- New files open with `// @ts-check` on line 1 (intent, not scope control — the entry's import graph is the scope).
- Documentation rule (issue #164): changing `README*.md`, `docs/requirements*.md`, a default value or the
  `files`/`exports` list must keep `npm run check:docs` green; it reads ground truth from `package.json` and `src/`.
  The required phrasing for "current version" claims is in the header comment of `scripts/docs-drift-check.mjs`.
  EN/CN document pairs stay in sync (this file pairs with `AGENTS_cn.md`).
- Referring to a file in **another repository**: write `<repo-name>:<path inside that repo>` — e.g.
  `pi-subagents:src/runs/background/async-execution.js:4`. The repo name must be registered in
  `EXTERNAL_REPO_PREFIXES` in `scripts/docs-drift-check.mjs` (an unregistered name is red; a registered name nobody
  references is red too). A prefixed path is not resolved here and its line number does not count against the
  ratchet below; **an unprefixed path is a path in this repository and must resolve here.**
- **Anchors**: four gate-owned numbers are the only truth on this page — `BASELINE_ROOT = 102`, the symbol-anchor
  floor `SYMBOL_ANCHOR_MIN_UNIQUE = 243` (only-up: falling below it is red, that is anchor degeneration being
  caught), the bare-line ratchet `BARE_LINE_REF_BASELINE = 6` (only-down), and the anchor-face floor
  `REF_SCAN_DOCS_MINIMUM = 51`. Docs must not lean on bare line numbers: point at a symbol with its file
  (`` `symbol` (`path`) ``), never at `path:123`. The measurement log lives in
  `docs/maintenance/symbol-anchor-ledger.md` — history, not current state. Read `#docs-anchors` before adding or
  moving an anchor.

## 4. Release day

Four commands, in this order. The seven checklist rows below are reconciled row by row against `PREFLIGHT_STEPS` in
`scripts/release-day.mjs`, and what each step means is `#release-day`:

```bash
npm run release:day -- --stage preflight --hosts <host repo dirs>
#   [1/7] check:changelog                       every public-surface merge named in this version's section
#   [2/7] CHANGELOG [Unreleased] carry          entries still parked under `## [Unreleased]`
#   [3/7] check:docs                            documentation audit (drift + EN/CN sync)
#   [4/7] check:docs:strict                     the same, warnings block too
#   [5/7] ERIX_E2E_REAL=1 check:release:real    real upstream; without the env a gate runs nothing = NOT judged
#   [6/7] check:release                         offline: tarball / installed package / TS host / CLI fake upstream
#   [7/7] check:host-consumers -- --hosts …     every host hit must already be covered by this version's guide
npm run release:day -- --stage publish       # prints the operation sheet, exits 3; run `npm publish` yourself
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
npm run release:day -- --stage finalize      # tag the version cut → dual push → verify both sides → doc gates
```

- `writeback` rewrites the release state and re-runs `check:docs`; `finalize` refuses to tag unless that state is on
  disk and the worktree is clean. Never skip `writeback`.
- **The host-consumer step answers with coverage, not a veto**: this repository is the upstream, so a host import of
  a name marked for removal is a reason the upgrade guide must say what replaces it, never a reason to keep the name.
- npm 12 lives at `~/.npm-global/bin/npm` and `/usr/bin/npm` (10.x) shadows it in `PATH` ⇒ call it by absolute path.
- Authentication is device flow (`npm login --auth-type=web`) and **every publish authenticates again**. In a non-TTY
  the URL is masked as `***`; surface the URL **in the same message that captured it** (it expires in minutes).
  **Never press ENTER** at the "Press ENTER to open in the browser" prompt: with no browser it triggers `xdg-open`,
  which fails and kills npm (code 3) — leave it polling. Prerelease versions need an explicit `--tag`.
- Publish burns the version number; a `+ erix-agent@<ver>` line is not availability (the registry lags) ⇒ poll
  `npm view erix-agent version --prefer-online`, then install with `--prefer-online` and run
  `erix --version && erix chat "…"`.
- Current version: `package.json` says `0.31.0` (the repo version) and the published line — npm's `dist-tags.latest` — is `0.31.0`.
  `check:docs` reconciles both numbers **live** against `package.json` and the registry on every run, so neither
  carries a measurement date. Use `npm version <x.y.z> --no-git-tag-version`.
- `package.json` face: `private` absent, `repository.url` in `git+https://…` form, `files` a long explicit
  allowlist (read `package.json`, never transcribe it), and inspect with `npm publish --dry-run` — details, the
  version-number rule and the retired policy: `docs/maintenance/command-reference.md#publish-prerequisites` and
  `#npm-policy`. A packed install should list **90** `.d.ts` (they are generated by `prepack`; the count is
  reconciled by `npm run check:pack-links`, so it carries no measurement date here).
- **Two human passes before the tag**, because an anchor only covers the dimensions somebody registered:
  ① walk the claimed **defaults**, **numbers** and **name sets** by hand across both READMEs, both AGENTS files and
  both contract documents; ② if `check:changelog` prints an `unattributed` note, read the first-parent diff of every
  short sha in it ⇒ `#unattributed-merges`.

## 5. Git and remotes

- **One code line, dual push**: `origin` fetches `ErixWong/erix-agent` (GitHub) and pushes to GitHub **and** Gitea
  (`git.erix.vip/eric/erix-llm-kit`); `git push origin <ref>` updates both. Push the pair yourself — the
  `sync-erix-mirror.sh` cron is off and must stay off (a mirror cron re-synced the wrong version once), so if one
  push URL fails that side lags silently: **verify both sides after pushing**.
- **GitHub is the workflow truth**: issues, PRs and reviews live there. Gitea is a code mirror only (no Actions
  pipeline; its issue/PR area is a frozen archive — do not open or reply there).
- Contribution flow: branch `feat-YYMMDD-NN-<描述>` / `fix-YYMMDD-NN-<描述>` → PR into `main` for anything touching
  the public surface; small fixes and documentation may go direct. Commit messages: conventional commits + 中文摘要.

## 6. Runtime data and local environment

- Everything the runtime writes lives under `~/.erix/` and is **never committed** (LLM config, MCP registry, session
  history, transcripts, user skills, per-cwd todos) ⇒ the tree diagram is `#local-runtime-data`.
- **Judge decisions have a fixed home**: `~/.erix/transcripts/outputs/<runId>/judge.log`, next to the transcript and
  the tool captures — inspect judge behavior there, not in `/tmp`.
- Model configuration comes from `~/.erix/config.json` slot `default` (relay `api.ai.erix.vip/v1`) — the same file
  the `erix_run` extension reads; it does not follow pi's current model.
- Local debugging runs the CLI from this repository (`node bin/cli.js chat`); the supervisor watches
  `/tmp/erix-*-log.txt` for step-by-step output.
- When an agent works in this repository: **estimate the read budget before reading and take it in one call** (the
  `readFile` tool description carries the line count, byte cap and token conversion), break long tasks down with
  `todo_add` first, and state the verification claim before reporting.

## 7. Model and cost discipline

- Never hardcode model names: read them from the user's configuration, or use a model the user named explicitly.
- If a model is unavailable, fail; do not substitute one and do not fall back quietly.
- Before any batch experiment, report the model, the call count and a cost/time estimate, and get confirmation.
