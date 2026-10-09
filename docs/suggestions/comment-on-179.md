# Comment to add on #179 (P2 cleanup list, item A14 / `resolveToolPath`)

> Not a new issue. ADR-009 deliberately removed the jail, allowlists and confirmation, and `requirements.md` lists "no security boundary" as a non-goal. This comment respects that and treats the problem as a guard against accidental damage, not a security feature.

---

+1 on the `resolveToolPath` item. Here is a suggestion that stays within ADR-009:

- **Not a security boundary.** `exec` still runs `/bin/sh -c`, so a path check can't contain anything, and it shouldn't pretend to.
- **Still a cheap guard against accidental damage.** Today `resolveToolPath` (`bin/tools.js:349-350`) is plain `path.resolve(root, value)`, so a model-supplied absolute path or `../..` silently writes outside the CLI's cwd. A minimal option:
  - `writeFile` (and a future `edit`) prints a one-line stderr warning when the resolved path is outside `root`.
  - An optional `--root-only` flag makes that warning an error, for people running `erix` in a scratch directory.
  - `readFile`, `rg` and `tree` stay unrestricted.
- If you'd rather keep the CLI completely policy-free, a sentence in the CLI help/README ("tools accept any path; run in a container if that matters") would close the item just as well.

For comparison, pi 1.1 also ships no sandbox and recommends containers. Codex CLI enforces `workspace-write` at the OS level (Seatbelt/bubblewrap). Either is consistent with ADR-009 as long as it's written down.
