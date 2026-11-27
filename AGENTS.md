# erix-agent — Project AGENTS.md

> Chinese version: [AGENTS_cn.md](AGENTS_cn.md). Machine-wide conventions: `~/projects/AGENTS.md`.
> **This page is part of the system prompt: re-sent in full every turn, and context folding does not touch it**
> an agent does here; history, policy evolution, postmortems and per-file numbers live in the cold layer
> pointer — never a hand-made copy.

## 1. What this repository is

- **A self-developed headless coding agent**: a zero-dependency LLM runtime (dual-protocol streaming + tool loop +
  compaction + checkpoint + resume) that runs unattended inside a host (fde-workshop / touwaka).
  pi = interactive (human in the loop), erix = headless (host-scheduled): complementary, not competing.
- **The boundary is one task lifecycle** — `runToolLoop` with `executeTool` injected by the host. Multi-role
  arbitration, retry scheduling and orchestration are the host's job and are not absorbed into the library.
- **`bin/` is a validator/debugger, not a contract surface.** A *new* dependency on `bin/` must first be promoted
  into `src/`. The one existing loan: `exec` (only in `bin/tools.js`) is borrowed by `examples/pi-extension`.
  Capability benchmarks run headless in the separate `erix-bench` repository.
- Security is not built in (ADR-009): the domain using the agent owns it; embedded runs are isolated by the host.
- **Red lines**: zero npm dependencies (import only `node:` built-ins and relative paths), pure ESM, Node 22+, never
  commit a token. The line binds imports, not the toolchain: `typescript` and `@types/node` are devDependencies by
  user authorization (issue #213) — they exist to generate declarations and are never imported by `src/` or `bin/`.
- `package-lock.json` is git-ignored on purpose ⇒ install with `npm install --include=dev`, **never** `npm ci`.

## 2. Where the code layout lives

`README.md` → the "Module map" section is the tree. Nothing reconciles it any more (the gates that did are gone,
issue #967), so it is maintained by hand: **keep it short, and add a new module in the same PR that creates it.**
**Never copy that tree onto this page** — a hand-copied tree rots silently while still costing every turn.

- The one layout fact that *is* a rule: **mock MCP servers stay in `fixtures/`, never under `test/`** — `node --test`
  runs every file under `test/` and those servers hang it.

## 3. Development commands

- **There are no gates in this repository.** Every `check:*` npm script, the CI workflow and the cold-layer gate
  manual were deleted (issues #961 / #967): a judgement that reddens on a legitimate change and whose fix is
  re-copying a constant carries no information. **`npm test` is the only automated criterion.** `npm run soak` and
  the `*-experiment.mjs` / `bench-*.mjs` scripts are tools, not gates: run them when you are measuring something.
- `package.json` is the list of scripts; this page does not repeat it.
- Before a PR: `find src -name '*.d.ts' -delete && npm test`. The declarations are generated next to their sources,
  and while they sit there `tsc` resolves `./x.js` to the sibling declaration and checks declarations instead of
  implementations.
- Test isolation: a test touching `~/.erix` or `~/.pi` must inject `home` / `cwd` (skills/mcp/config tests are the
  precedents) so it cannot contaminate real user configuration.
- Type surface (issue #213): `src/**/*.d.ts` are **generated, never committed**; `prepack` regenerates them and logs
  to **stderr only**. Two JSDoc shapes silently degrade a parameter to `any` ⇒ `#type-surface`.
- New files open with `// @ts-check` on line 1 (intent, not scope control — the entry's import graph is the scope).
- Referring to a file in **another repository**: write `<repo-name>:<path inside that repo>` — e.g.
  `pi-subagents:src/runs/background/async-execution.js:4`. **An unprefixed path is a path in this repository and must
  resolve here.**
- **Anchors**: prefer pointing at a symbol with its file (`` `symbol` (`path`) ``) over `path:123`. A line number has
  to be *true* — a reference that points past the end of a file, or names a symbol that no longer exists in `src/`,
  is a bug even though nothing automated will say so.
- Documentation rule (issue #164): changing `README*.md`, `docs/requirements*.md`, a default value or the
  `files`/`exports` list means updating the EN and CN copies **in the same PR**; EN/CN pairs never drift.

## 4. Release day

Three commands, in this order (the `preflight` stage was deleted together with the gates):

```bash
npm run release:day -- --stage publish       # prints the operation sheet, exits 3; run `npm publish` yourself
npm run release:day -- --stage writeback --version <x.y.z> --published <x.y.z> [--published-date <YYYY-MM-DD>]
npm run release:day -- --stage finalize      # tag the version cut → dual push → verify both sides
```

- `writeback` rewrites the release state; `finalize` refuses to tag unless that state is on disk and the worktree is
  clean. Never skip `writeback`.
- npm 12 lives at `~/.npm-global/bin/npm` and `/usr/bin/npm` (10.x) shadows it in `PATH` ⇒ call it by absolute path.
- Authentication is device flow (`npm login --auth-type=web`) and **every publish authenticates again**. In a non-TTY
  the URL is masked as `***`, so surface it **in the same message that captured it** (it expires in minutes), and
  **never press ENTER** at "Press ENTER to open in the browser" — with no browser that triggers `xdg-open`, which
  fails and kills npm (code 3); leave it polling. Prerelease versions need an explicit `--tag`.
- Publish burns the version number; a `+ erix-agent@<ver>` line is not availability (the registry lags) ⇒ poll
  `npm view erix-agent version --prefer-online`, then install with `--prefer-online` and run
  `erix --version && erix chat "…"`.
- Current version: `package.json` says `0.34.0`; npm's `dist-tags.latest` is `0.34.0`. Use
  `npm version <x.y.z> --no-git-tag-version`.
- `package.json` face: `private` absent, `repository.url` in `git+https://…` form, `files` a long explicit allowlist
  (read `package.json`, never transcribe it); inspect with `npm publish --dry-run`.
- **Two human passes before the tag**: ① walk the claimed **defaults**, **numbers** and **name sets** by hand across
  both READMEs, both AGENTS files and both contract documents; ② read the first-parent diff of every merge in this
  version's CHANGELOG section. Nothing automated does either pass any more.

## 5. Git and remotes

- **One code line, dual push**: `origin` fetches `ErixWong/erix-agent` (GitHub) and pushes to GitHub **and** Gitea
  (`git.erix.vip/eric/erix-llm-kit`); `git push origin <ref>` updates both. Push the pair yourself — the
  `sync-erix-mirror.sh` cron is off and must stay off, so a failing push URL leaves that side lagging silently:
  **verify both sides after pushing**.
- **A rejected push to `main` is the remote's answer, not a permission problem**: read what the remote reports
  (`GH013` / "required status checks are expected" = the checks have not run on **the sha being pushed**) and read
  the live ruleset (`gh api repos/<owner>/<repo>/rulesets`) — never copy rule state onto a page, and never assume a
  rejection means "must go by PR" without reading it. Never `--force`: the two push URLs above run independently, so
  a rejected push can leave the mirror ahead of GitHub — read both sides back before deciding anything.
- **GitHub is the workflow truth**: issues, PRs and reviews live there. Gitea is a code mirror only (no Actions
  pipeline; its issue/PR area is a frozen archive — do not open or reply there).
- Contribution flow: branch `feat-YYMMDD-NN-<描述>` / `fix-YYMMDD-NN-<描述>` → **PR into `main`, always** — the live
  ruleset (`main-require-pr`) rejects a direct push with `GH013`, and `origin` has two push URLs that run independently,
  so a push that GitHub rejects can still land on the Gitea mirror and leave the two sides forked. Push the branch, open
  the PR, merge it, then read `refs/heads/main` back on both URLs. Commit messages: conventional commits + 中文摘要.

## 6. Runtime data and local environment

- Everything the runtime writes lives under `~/.erix/` and is **never committed** (LLM config, MCP registry, session
  history, transcripts, user skills, per-cwd todos) ⇒ the tree diagram is `#local-runtime-data`.
- **Judge decisions have a fixed home**: `~/.erix/transcripts/outputs/<runId>/judge.log`, next to the transcript and
  the tool captures — inspect judge behavior there, not in `/tmp`.
- Model configuration comes from `~/.erix/config.json` slot `default` (relay `api.ai.erix.vip/v1`) — the same file
  the `erix_run` extension reads; it does not follow pi's current model.
- Local debugging runs the CLI from this repository (`node bin/cli.js chat`).
- When an agent works in this repository: **estimate the read budget before reading and take it in one call**,
  and state the verification claim before reporting.

## 7. Model and cost discipline

- Never hardcode model names: read them from the user's configuration, or use a model the user named explicitly.
- If a model is unavailable, fail; do not substitute one and do not fall back quietly.
- Before any batch experiment, report the model, the call count and a cost/time estimate, and get confirmation.
