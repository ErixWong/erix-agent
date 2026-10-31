<!-- doc-version: 0.19.0 -->
# Host upgrade guide: 0.19.0

0.19.0 removes nothing: no symbol disappeared, no signature changed, no stored format
moved. It is **not** a no-op upgrade though. Three things a host can observe changed:
the CLI's `--session` entry point, the `code` a 4xx provider error carries, and the fact
that the package now ships `.d.ts` at all. Each has a self-check below; if none of the
three is yours, upgrade as-is.

None of the three needs a change on the happy path; each needs a **decision**: an exit
path, a branch for a code that used to read `unknown`, and a look at type errors that
were always there but unreported.

## 1. Change summary

| Change | Breaks a host that … | Section |
| --- | --- | --- |
| `chat --session <id>` exits non-zero when that id has no non-empty transcript (issue #168) | passes an id it is not sure exists, and read "it created one for me" as success | 2 |
| `classifyHttpError` now returns `invalid_request` / `not_found` / `conflict` for 400/422/404/409 (issue #179) | branches on `code === "unknown"` as its "the request is wrong" bucket | 3 |
| The package ships `.d.ts` for `.` and `./tools` (issue #213, completed by #249 / #253) | is a TypeScript host: positions that resolved to `any` can now report real errors | 4 |

## 2. `--session <id>` has to name a session that exists

`erix chat --session <id>` stops when that id has no non-empty transcript: exit code
`1`, plus a message that names the way out.

What 0.18 documented, verbatim from `git show v0.18.0:README.md`:

> - `--session <id>` selects the session; without an explicit chat session,
>   `chat` creates a unique ID derived from the working directory.

Same release, same section: *"resuming still requires a non-empty transcript for the
session."* **0.18 never promised "name it and it gets created"** — undocumented
behaviour, and a trap: one mistyped character left you with an empty session you
believed you were continuing, no hint, and an extra transcript on disk. That is why this
is a minor, not a major.

Measured, same command and transcript directory, unreachable endpoint; 0.18 tree first:

```
$ erix chat "hello" --session typo-session-id --dir ./tr          # 0.18
错误：fetch failed                                                # nothing about the session
$ ls ./tr                                                         # it went and made one
typo-session-id.jsonl  typo-session-id.state.json  typo-session-id.status.json
```

```
$ erix chat "hello" --session typo-session-id --dir ./tr          # 0.19
错误：会话不存在：typo-session-id（./tr 下没有它的非空 transcript）。
可用 erix chat -r 列出本目录可续跑的会话，或 --session <完整 id> 传完整 id；不带 --session 则是新建会话（默认 id 形如 <目录名>-<sha256(目录)[:8]>-<随机后缀>）。
$ echo $?
1
$ ls ./tr
outputs/                                                          # no transcript was written
```

CLI text is Chinese in both releases; only the outcome changed. Exit `1` is the
documented "usage error / session does not exist" row; `erix --help` carries the new
semantics on the `--session`, `-c` and `-r` lines.

**The way out** (this is exactly what the error message says — nothing invented):

| You want to … | Do this |
| --- | --- |
| start a **new** session | pass no `--session` at all — the derived id is `<dir-name>-<sha256(path)[:8]>-<random>` |
| resume **this directory's** latest run | `-c` / `--continue` |
| pick among this directory's sessions | `-r` — interactive picker, **needs a TTY**; there is **no `--resume` flag**, so in a non-TTY use `-c` or `--session <full id>` |
| resume one exact session | `--session <full id>` — the id is the transcript file name minus `.jsonl` |
| name a brand-new session | `erix repl --session <id>`: unchanged, it is a naming flag there |

Two notes on what `-c`/`-r` can see: `~/.erix/sessions.json` and
`~/.erix/session-meta.json` are **retired** (discovery scans the transcripts directory
live), stay on disk, and are safe to delete. Only ids in the derived shape appear in the
list: self-chosen ids, and directories named outside `[A-Za-z0-9._-]` (spaces, CJK →
names hashed to `run-h-*`), are invisible but **still resumable** with `--session
<full id>`.

Self-check — find every id that reaches the CLI, then ask whether it exists:

```bash
grep -rn -- "--session" your-host/ scripts/ Makefile   # and where each id comes from
test -s "$HOME/.erix/transcripts/<full id>.jsonl" && echo resumable || echo "exits 1 on 0.19"
```

Fix per call site: drop the flag (new run), resolve the id first (`-c`, or `-r` in a
terminal), or keep it and handle exit `1` instead of assuming `0`.

## 3. 4xx errors stop reporting `unknown`

`classifyHttpError` (`src/providers/errors.js`) is a public export from the package
root, and the same `code` reaches hosts through `termination.errorCode` (issue #176).
Measured on this tree:

| status | `code` on 0.18 | `code` on 0.19 | `retryable` (unchanged) |
| --- | --- | --- | --- |
| 400 | `unknown` | `invalid_request` | `false` |
| 404 | `unknown` | `not_found` | `false` |
| 409 | `unknown` | `conflict` | `false` |
| 422 | `unknown` | `invalid_request` | `false` |
| 401 / 403 | `auth` | `auth` | `false` |
| 408 | `timeout` | `timeout` | `true` |
| 429 | `rate_limited` | `rate_limited` | `true` |
| 500–599 | `server` | `server` | `true` |
| anything else (measured 418) | `unknown` | `unknown` | `false` |

**Retry behaviour did not move**: none of the three new codes is retryable — exactly
what `unknown` was. Classification is what moves: a host that used `code === "unknown"`
as its "fix the request, do not retry" bucket now falls into its else branch for those
four statuses.

Self-check, then fix:

```bash
grep -rn '"unknown"' your-host/   # every bucket that used to catch a 400
node -e "import('erix-agent').then((m) =>
  console.log([400, 404, 409, 422].map((s) =>
    s + '→' + m.classifyHttpError(s, 'x').code).join('  ')));"
# expect: 400→invalid_request  404→not_found  409→conflict  422→invalid_request
```

Add the three names to the "bad request" branch. **Keep the `unknown` bucket** — it got
narrower, it did not go away.

## 4. `.d.ts` ships: expect new type errors, and keep `--skipLibCheck`

`package.json` grew a top-level `types`, and `exports["."]` / `exports["./tools"]` each
gained a `types` condition (the `default` targets are byte-identical to 0.18, so runtime
resolution did not change). Declarations come from a `prepack` hook: the tarball carries
them, a clean checkout has none (measured: **61** `.d.ts` under `src/` after
`npm run types:build`). `exports["./contract-tests"]` deliberately has **no** `types`:
importing that subpath reports "no declaration file" instead of silently resolving to
JavaScript.

Measured on a throwaway TypeScript host (`tsc --strict --module nodenext`,
`--skipLibCheck` on), 0.18 tree first:

| what the host compiles | on 0.18 | on 0.19 |
| --- | --- | --- |
| `import { runToolLoop } from "erix-agent"` | `TS7016: Could not find a declaration file for module 'erix-agent'` | **0 errors** |
| the same file with `--allowJs` | 0 errors — every symbol is `any` | 0 errors |
| `runToolLoop({ provider, executeTool, bogusOption: 1 })` | 0 errors (silent `any`) | `TS2353: … 'bogusOption' does not exist in type { … 56 more … }` |

Read the third row as the point of the release: that error is not a regression — it is a
call site that was always wrong and had no type to be wrong against. Fix the call site
(option names are checked, `provider` / `executeTool` are required); do not restore the
silence by removing the declarations.

**The honest limit.** "0 errors at the host layer" (PR #249 / #253) is measured for the
entry-level surface — `runToolLoop`, the two provider factories, `createFileTools` —
with `--skipLibCheck` **on**, and it is not a claim about the whole package. Dropping
`--skipLibCheck` on that same host file measured **27 errors, every one of them inside
the package's own declaration files**: `src/skills/loader.d.ts` 14, `src/run-state.d.ts`
7, `src/reflection/wrapup.d.ts` 3, `src/providers/errors.d.ts` 3. That is accepted debt
for now; the host-side answer is to **keep `--skipLibCheck` on**.

Self-check:

```bash
npx tsc --noEmit --skipLibCheck 2>&1 | grep erix-agent              # your new type errors, if any
npx tsc --noEmit --skipLibCheck --listFiles | grep -c 'erix-agent/.*\.d\.ts'
# 0 = still compiling against `any`: check the installed version and the subpath
```

## 5. Upgrade checklist

- [ ] Every scripted `chat --session <id>` has a guaranteed id or handles exit `1`; new runs pass no `--session`.
- [ ] Verified the new answer: `erix chat "x" --session definitely-not-there` → exit `1`, no new transcript.
- [ ] Non-TTY automation uses `-c` (or a full id), not `-r`; no code invents a `--resume` flag.
- [ ] `code === "unknown"` branches now list `invalid_request` / `not_found` / `conflict` beside it; the `unknown` bucket is still there.
- [ ] TS host compiled before and after; each new error was read as a call-site bug, not squashed.
- [ ] `--skipLibCheck` is still on.

## 6. Everything else folded into 0.19.0 on 2026-10-13 — **no call-site change**, but two host-observable strings

This release was cut on 2026-10-12 but never published; a further 16 changes landed on
2026-10-13 and were folded into the same version instead of opening 0.20.0. **None of them
requires a call-site change.** Two of them, however, are **observable** by a host that pins
strings or comments byte-for-byte — this section used to file them under "no host action",
which was too optimistic (issue #293, reported by a host that spent time ruling them out as
regressions):

- **The `readFile` continuation marker gained the file size.** `readFile`（`src/tools/file-tools.js`）
  now answers `[共 3 行（文件 9B），剩余 K 行；…]` where it used to answer
  `[共 3 行，剩余 K 行；…]`. Semantics unchanged; the **text** changed, and this text is sent to
  the model. If your host pins this marker verbatim (outside `TOOL_RESULT_CONTRACT`, this is
  practically the only other string surface hosts pin), that assertion goes red — fix the
  expected string, do not relax the assertion.
- **The JSDoc typedef of `runToolLoop`'s return value moved from one line to a multi-line
  block** (`runToolLoop`, `src/loop/orchestrator.js`). Behaviour is identical — the nine
  `termination.reason` values are the same set — but a host that **parses that comment** as a
  machine-readable drift guard (e.g. extracting the `termination:{reason:"end_turn"|…}` typedef
  and cross-checking it against its own constant) had to loosen its regex to tolerate the line
  break and the JSDoc `*` gutter. Worth stating as a rule: **when a comment is referenced as a
  truth source (like `TOOL_RESULT_CONTRACT` and the contract document are), its layout is part
  of the host-observable surface, not a private detail.**

Everything below in this section stays a genuine no-op for every host.

- **`src/index.js` exports `createMemoryNotesStore`.** An in-memory `NotesStore` shipped by
  the engine, built on the same port as the file and CLI stores (`src/store/notes-port.js`),
  so all three answer the same contract suite. Use it when a run's notes should live only
  for the run (tests, disposable sandboxes, one-shot hosts with no scratch directory).
- **The `erix_run` pi extension returns the complete final text.** The host-side truncation
  layer is deleted: a long `finalText` and the `artifacts` paths (`transcriptPath`,
  `judgeLogPath`) arrive intact instead of being cut off mid-report.
- **`erix_run`'s async `action: "result"` can actually retrieve `finalText` again**, and its
  async terminal view now carries `diagnostics` too — so a background run is answerable from
  disk after a host restart, not only through the live handle.
- **`erix_run`'s `outputSchema` now declares `verification` and `error` (13 keys → 15).**
  The engine's own verification verdict reaches the model and the host for the first time.
  Read it as a verdict about the *answer*, not as acceptance: **only `verified` may be
  consumed as a verified fact**; `skipped` is what you get when no final guard ran, and it
  is not a failure.
- **`erix_run`'s file-read tool description carries measured budget facts** (a conversion
  formula plus this repository's own re-measured line capacity), so the model can decide how
  many lines to read instead of guessing; the wording no longer claims a file count for this
  repository.

**Two facts about `erix_run` worth knowing before you adopt it:** it is **not part of the npm
tarball** (`examples/` is outside `files`) — adoption today means copying
`examples/pi-extension/` into `~/.pi/agent/extensions/erix-run/` — and it **carries this
package's version number rather than its own**, because it is developed in lockstep with the
engine and loads that engine by package name. There is currently no version stamp inside the
installed directory, so "which build is installed" is answered by comparing file hashes.

**For contributors to this repository:** `node scripts/docs-drift-check.mjs --self-test`
can be run in this repository's tree. 0.19.0 had one further restriction: in a checkout without
the git-ignored local archive directory, 3 of its cases were known false reds (their
expectations name neighbouring files that only exist on a development machine) — those reds were
tracked in issue #281 and are gone: **that was before #302**, after which the tree-shape cases
run on a synthetic tree fixture (103 cases, all green on a clean checkout); see `AGENTS.md` for
the current wording.

Prior guides in this series:
[0.18.0](host-upgrade-guide-0.18.0.md),
[0.17.0](host-upgrade-guide-0.17.0.md),
[0.16.0](host-upgrade-guide-0.16.0.md),
[0.15.0](host-upgrade-guide-0.15.0.md).
Full contract text: [host-consumer-contract.md](host-consumer-contract.md).
