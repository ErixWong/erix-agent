# test(hygiene): replace hard-coded `/tmp` paths with `os.tmpdir()` (40 tests fail when /tmp is not writable)

## Background

Some tests create their temp directories under a literal `/tmp`. Others already use `os.tmpdir()`, e.g. `test/notes.test.js` and parts of `test/repl.test.js`. When `/tmp` is read-only or not shared, as in sandboxed CI runners, containers, macOS sandboxes or Windows, the literal-path tests fail with `EROFS`/`ENOENT`. Those are environment failures, not logic failures.

## Evidence (main @ 1545539, Node 24.20, `HOME` set to a temp dir, `/tmp` read-only)

```
ℹ tests 1163
ℹ pass 1118
ℹ fail 40
ℹ skipped 5
```

All 40 failures are `mkdtemp`/`mkdir` under `/tmp`: 39 × `EROFS` plus 1 × `ENOENT` on `/tmp/erix-cli-golden`. No failure has any other cause.

Main call sites:
- `test/cli.test.js`: `mkdtemp(join("/tmp", …))` repeated in many tests, starting near L185 (the CLI golden / archive guidance tests).
- `test/repl.test.js`: the `runRepl` tests that write archives and sessions.
- `test/sessions.test.js`: the `makeHome()` helper (`/tmp/erix-sessions-test-*`), shared by about 15 tests.

Strings that use `/tmp` as an inert path literal and never touch the disk (e.g. `cwd:` fields, `fixtures/cli-golden.json`) can stay as they are.

## Proposal

- Replace `join("/tmp", …)` with `join(tmpdir(), …)` (`import { tmpdir } from "node:os"`) at the disk-touching call sites.
- Optionally add one shared helper such as `test/helpers/tmp.js`: `makeTmp(prefix)` built on `mkdtemp(join(tmpdir(), prefix))`, plus cleanup.
- If the CLI golden test needs a stable path in its snapshot, derive the path and normalise it in the comparison. Do not hard-code it.

## Acceptance

- `TMPDIR=$(mktemp -d) node --test` passes with `/tmp` mounted read-only.
- `grep -rnE 'join\("/tmp"' test` returns no disk-touching hits.

## Semver

None (test-only).
