# feat(cli): add an `edit` tool (exact-match multi-edit) to the CLI reference tools

## Background

The CLI built-in tools (`bin/tools.js`) are `readFile`, `rg`, `grep`, `tree`, `writeFile`, `exec` and `todo_*`. There is no targeted edit tool, so every change to a file is a whole-file `writeFile`. That costs a lot of output tokens on large files and risks truncating or silently corrupting unrelated content. It also skews Terminal-Bench-style comparisons against harnesses that ship one: pi has `edit` and Codex has `apply_patch`.

Scope note: this is a **CLI / reference-tool** suggestion only. ADR-005 says "the library must never include tools that execute things", and nothing here changes that.

## Reference design: pi 1.1 `edit`

Source: `packages/coding-agent/src/core/tools/edit.ts` and `edit-diff.ts` in github.com/earendil-works/pi.

- **Input:** `{ path, edits: [{ oldText, newText }] }`.
- **Matching rules:**
  - Each `oldText` is matched against the **original** file, not the progressively edited one.
  - Each match must be unique, and edits must not overlap.
- **Matching order:** exact match first. If that fails, a conservative fuzzy pass:
  - normalise with NFKC and strip trailing whitespace;
  - fold smart quotes, dashes and odd spaces to ASCII;
  - copy unchanged lines back from the original.
- **File handling:**
  - Preserves BOM and CRLF.
  - Serialises concurrent edits to the same file.
- **Tolerant input parsing:** accepts `edits` as a JSON string, or a single object instead of an array.
- **Error messages tell the model what to do next:**
  - "Could not find edits[i] … must match exactly including all whitespace"
  - "Found N occurrences … provide more context"
  - "edits[a] and edits[b] overlap … merge them"
  - "No changes made"
- **Result:** a short unified diff plus the first changed line, so the model can verify without re-reading the file.

## Proposal

- Add `edit` to `bin/tools.js` with the semantics above. It needs only `node:fs` and is roughly 150–250 lines, with no dependencies.
- Start with exact matching only. Add the fuzzy fallback later if transcripts show whitespace and quote mismatches.
- Register it with judge's write-tool recognition. Related: closed #36 already anticipates write tools named `edit`.
- Default-on in the CLI tool set, and filterable with `--tools` like the others.

## Acceptance

- Unit tests cover: single edit, multi-edit, not found, ambiguous match, overlap, no-op, CRLF/BOM preservation.
- A fake-provider CLI test applies an edit and asserts the diff output.
- Optional: a token/cost comparison on one erix-bench task, `writeFile`-only vs `edit`.

## Semver

Minor (additive CLI tool).
