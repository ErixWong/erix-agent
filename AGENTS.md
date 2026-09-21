# erix-agent — Project AGENTS.md

> Chinese version: [AGENTS_cn.md](AGENTS_cn.md)

Project-specific rules; shared/global conventions live in `~/projects/AGENTS.md` and are deliberately not duplicated here. This file travels with the repository (GitHub: ErixWong/erix-agent).

## 1. Project positioning

**A self-developed headless coding agent (headless agent)**: a zero-dependency LLM agent runtime (dual-protocol streaming + tool loop + compaction + checkpoint) for **unattended, host-orchestrated** scenarios (the app_container / touwaka embedded base).

- Product form = **headless agent**: the `runToolLoop` single-task lifecycle (start/run/stop/resume/event stream), with execution (`executeTool`) injected by the host; the **boundary ends at a single task lifecycle**; multi-role orchestration/arbitration/retry scheduling is the host's responsibility and is not absorbed into the library.
- **The CLI (`bin/`) is a validator/debugger, not the focus**: interactive TUI + the `chat` one-shot entry point (which can serve as a bench entry point); capability validation uses the erix-bench headless harness (container driver + scorer, comparing `--agent erix|pi`), while the interactive repl tests only human-agent collaboration.
- Relationship with pi: **pi = interactive agent (human in the loop); erix = headless agent (unattended, host-scheduled) — complementary, not competing**.
- Security layering (ADR-009): the agent does not build in security; **the user of it is responsible** (local = trust domain; embedded containers are isolated by the host).
- Red lines: **zero npm dependencies** (only import node: built-ins + relative paths), pure ESM, Node 22+, and never commit key/token.

## 2. Code structure

```
src/
├── index.js
├── loop.js        # thin re-export shim (runToolLoop lives in loop/)
├── assembly.js    # AssemblyPort validation (host boundary)
├── run-state.js
├── tokens.js
├── loop/          # orchestration core: orchestrator (runToolLoop), provider-runner,
│                  # checkpoint-executor, budget, aggregate-budget, termination,
│                  # resume-manager, error-ledger, messages, reflection, task-brief, abort,
│                  # tool-result-ttl
├── compact/       # context compaction: budget, sliding-window, fold-statistical,
│                  # fold-llm, anchors, fold-fidelity, enforce-size
├── config/        # configuration adapters
├── messages/      # canonical message model + OpenAI/Anthropic conversion
├── providers/     # OpenAI/Anthropic dual-protocol providers
├── reflection/    # governor, judge, l0, wrapup
├── store/         # file, memory, notes
└── tools/         # registry, providers (opt-in erix-agent/tools subpath)
bin/              # CLI (validator/debugger): cli.js (entry/chat), repl.js (TUI), tools.js (built-in tools + prompts), skills.js, mcp.js, config.js, final-guard-support.js, final-guard.js, guard-metrics.js
test/             # unit tests (node --test), with compact/, providers/, tools/, config/, messages/, contract/, helpers/, fixtures/, integration/, and top-level test files
fixtures/         # test fixtures (mock MCP servers) — ⚠️ mock MCP servers must not be put under test/ (node --test runs all files under test and can hang)
examples/         # examples (skills/ examples, demos, and benchmarks)
docs/             # design documents, ADR decision records, research, and task documents
skills/           # skill definitions
scripts/          # experiment scripts and results
```

## 3. Development commands

| Command | Purpose |
|---|---|
| `npm test` | Full test suite (`node --test`) |
| `node --check <file>` | Syntax safety check |
| `node bin/cli.js ...` | Run the CLI locally (no installation required) |

- Test isolation rule: tests involving `~/.erix` or `~/.pi` must inject `home`/`cwd` parameters (the skills/mcp/config tests provide precedents), to avoid contaminating real user configuration.

## 4. npm publishing guide (verified against the 2026-08 policy)

### Prerequisites (`package.json`)
- `private` must be removed (otherwise 403); edit JSON with a node script, not sed to delete a line (a trailing comma would break JSON).
- `files`: `["src", "bin", "skills", "README.md", "CHANGELOG.md", "docs/host-consumer-contract.md", "test/contract", "LICENSE"]` — inspect the tarball with `npm publish --dry-run` before publishing.
- Use the `git+https://...` format for `repository.url` (or run `npm pkg fix`).
- Current version: `0.9.0`; use `npm version <x.y.z> --no-git-tag-version` for version changes (do not use 0.0.0 for a feature-complete first release).

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

## 5. Git and remotes

- **origin** = self-hosted Gitea (`git.erix.vip/eric/erix-llm-kit`, archived backup)
- **github** = `ErixWong/erix-agent` (main remote, public)
- Contribution flow: branch `feat-YYMMDD-NN-<描述>` → PR merged into main (for large changes); small changes/documentation can be pushed directly.
- Commit messages: conventional commits + 中文摘要

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

## 7. Local environment facts

- Relay: `api.ai.erix.vip/v1`; the model must be configured by the user (`contextWindow 131072`, `maxOutputTokens 32768` → automatic compaction budget ~85k).
- For tool execution/validation, use `node bin/cli.js chat` for erix work (this repository); the supervisor watches `/tmp/erix-*-log.txt` for step-by-step output.
- Red lines for erix coding tasks: read each file only once (in offset/limit segments), break long tasks down with `todo_add` first, and make a verification declaration before reporting.

## 8. Model and cost discipline

- Never hardcode model names; always read them from the user configuration or use a model explicitly supplied by the user.
- If a model is unavailable, fail immediately; never replace it or fall back to another model.
- Before any batch experiment, report the model, call count, and a cost/time estimate based on historical averages, and obtain the user's confirmation.
- Respect the user's choice of vendor and quota; when the user changes models, it is usually for cost or quota reasons, so do not quietly switch back.
