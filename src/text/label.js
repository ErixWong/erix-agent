/**
 * Normalize a note/findings label into a canonical comparison key:
 * NFKC, trimmed, lowercased, whitespace/dashes collapsed to `_`,
 * non-letter/digit/underscore characters stripped, capped at 128 chars.
 *
 * Used by final-guard to compare declared findings against archived note
 * labels — the matching semantics must stay stable.
 */
export function normalizedLabel(label) {
  return String(label ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[\s-]+/gu, "_")
    .replaceAll(/[^\p{L}\p{N}_]+/gu, "")
    .slice(0, 128);
}
