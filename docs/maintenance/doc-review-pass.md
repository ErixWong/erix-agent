# The periodic documentation pass (agent-run, no gate)

> 中文版：[doc-review-pass_cn.md](doc-review-pass_cn.md)。

**Decision (261109, user ruling).** Documentation review is **not** a CI gate and **not** a release-preflight
step. A script can only judge wording — "this sentence must exist", "both languages must have the same number of
occurrences" — and that class of judgement produced a 25% red rate on PRs while catching almost no real defects
(measured: 138 pass / 49 fail / 13 cancelled over 200 runs; 9 of 12 sampled failures were committed-table drift,
the real suite reddened once). The two classes that *do* matter — **reference integrity** (a document pointing at
a file that no longer exists) and **derived-value copies** (a document quoting a version or a count that the
source no longer says) — are now found by **an agent reading the documents on a schedule**, because judging
"is this sentence still true" is judgement, not a regex.

## When to run it

- On a schedule the operator picks (weekly is the shape that was agreed), and
- before a release **if** the operator wants a second pair of eyes (the release itself no longer blocks on it).

## What the agent runs

One command collects the mechanical half; the agent reads the output, it does not trust it:

```bash
npm run docs:pass
```

That runs, in order: `check:docs` (drift + EN/CN skeleton + version claims + referenced paths), `check:docs:strict`,
`check:docs-examples`, `check:agents-directives`. (`check:docs-spelling` used to sit between the two strict steps; it was
deleted by issue #961 — see the note in `.github/workflows/ci.yml` for what that costs.)
**Its exit code is evidence about the scripts, not about the documents** — the scripts cannot see a sentence that
is true-looking and wrong.

As of issue #908 R2 (261126) **CI carries no documentation gate at all** — `check:changelog` and the doc-oriented
self-tests are not pipeline steps any more. The mechanical half therefore has only two owners: this pass, and
the version boundary (`PREFLIGHT_STEPS[0]`, `release:day --stage writeback`).
**`docs-drift-check --self-test` no longer exists** (task 261126-59): its only consumer was this pass, it took
≈8.5 minutes, and it had gone red 23 cases without anyone noticing — a step no event triggers is a dashboard, not a
gate. What it covered is now covered by the judges themselves (`check:docs` / `check:docs:strict`) and by the code
suite. Second-scale **code** gates are not this pass's business either: they run inside `npm test`
(`test/gate-self-tests.test.js`).

## What the agent must judge by hand (this is the actual pass)

1. **Defaults** — every `default X` / `默认 X` sentence in both READMEs, both `AGENTS*.md` and both contract
   documents, read against the source constant or the CLI help text. #614 flipped the CLI slot default and every
   machine gate stayed green; that class only falls to a reader.
2. **Numbers** — step counts, item counts, table sizes, `N of them` claims. Compare with the command the document
   itself names, and run that command.
3. **Name sets** — strategy names, tool names, flag names, option keys. A renamed knob that survives in prose is
   the most expensive kind of stale sentence.
4. **Version claims** — "current version" / "published line" / "never published" sentences against
   `package.json`, `npm view <pkg> dist-tags.latest` and `git tag`.
5. **Reference integrity** — every `path/to/file` and every `#anchor` in the living documents: does it resolve?
   (`check:docs` covers the file half on the face it scans; the agent covers the rest, including cross-repository
   `<repo>:<path>` references.)
6. **Retired semantics** — anything the code stopped doing but the documents still promise. Read the CHANGELOG's
   Breaking sections of the last two versions and confirm each one is reflected where a host would look.
7. **CHANGELOG entry pairs** — an entry that disappeared from **both** language faces at once. The pairing guard
   proves every Chinese entry has an English counterpart and the reverse, and it registers no count (the old
   `CHANGELOG_PAIR_FLOOR` was deleted in PR #826 because it went stale at every release window), so "a pair was
   removed" is this pass's judgement, not a machine's. Compare the section against the merges it is supposed to
   name (`npm run check:changelog` covers the named-merge half).

## How to report

- One finding per line: `file:line — what the document says — what is true — the command that proves it`.
- No finding without the command that produced it; "this looks stale" is not a finding.
- Findings are **proposals**: the agent does not rewrite the documents on its own unless the operator asks for the
  fix in the same breath.
- If the pass finds nothing, say so explicitly and name what was read (a silent "all good" is indistinguishable
  from "I read nothing").

## What stays automated, and why it is not "documentation checking"

| Gate | Why it survives |
|---|---|
| `check:agents-directives` byte budget + status/expiry/bare-coordinate classes | The instruction face is re-sent every turn: its **length** is a cost, and a status sentence there is executed as truth. The ratchet numbers are `--sync`ed, never hand-written. |
| `check:config-leaf-values` | `check:config-leaf-values` regenerates a committed table from a probe and compares it with the tree. Both judge a **derived value**, not prose; the only legitimate way to move the derived state is the generator — no hand-edits. |
| `check:pack-links` | Packaged Markdown links must resolve; a dead link in a shipped README is a broken artifact, not a stale sentence. |
| `check:changelog` | A public-surface merge with no CHANGELOG entry is a missing record, not a wording issue. |

Everything else that used to live under "docs" — `check:docs`'s prose requirements, the EN/CN occurrence census,
the "this sentence must exist" families — was deleted by issue #802. `check:docs` still exists as a **manual tool**
(`npm run docs:pass`), it just no longer stops anything.
