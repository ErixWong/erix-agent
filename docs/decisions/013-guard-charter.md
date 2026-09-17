# ADR-013: Guard Charter—A Mechanical Checker That Must Not Expand

> Chinese version: [013-guard-charter_cn.md](013-guard-charter_cn.md)

- Status: Decided (2026-09-15)
- **Amended by ADR-016 (2026-09-17)**: the guard no longer verifies only non-replayable
  captured values; it verifies explicit `label=value` attributions against **all** archived
  tool outputs. Source-reference requirements and `rerun_cited` are retired.
- Background: The final-draft provenance gate (guard) went through multiple attempts to "make it smarter" during 2026-09-12~14, all disproved by evidence:
  - **Form-based token scanning** (guessing "which string is the value" from final-draft prose): it both **wrongly killed correct answers**
    (when the final draft contained the archive path `001-exec.txt`, it treated `001-exec` as an unknown value → marked `unverified`)
    and **failed to catch genuine fabrication** (a free-floating token without a label → `accept`).
  - Among effective samples with guard enabled: `skipped ≈ 93%`, `revised = 0`, `rerun_cited = 0` (almost entirely spinning).
  - Root cause: **inferring provenance from the result (natural language)** is inherently unreliable—it is not an implementation defect, but the wrong direction.
  - The default has now been changed to opt-in (`--final-guard`).
- Risk: later people (or agents) will continue to "add intelligence" to it because it looks like a "security mechanism", and every expansion will reintroduce false kills/misses and complexity.
- Related: **ADR-012** (engine truth / model efficiency / host policy), ADR-010 (context shaping and the two problem domains),
  `docs/design/2026-09-14-memory-and-compaction-rfc.md` and two review/evaluation documents.

## Decision (five charter rules, applicable to all guard-like mechanisms)

### 1. Perform exact comparison only
The guard's inputs are **limited to data recorded by the engine itself** (capture manifest, artifact digest/locator/status, tool-call metadata),
and comparisons must be **exact string/set equality** (or an equivalent mechanical judgment). No "approximate", "similarity", or "semantic" judgment may be introduced.

### 2. Do not parse model natural language
**Do not** apply form matching, length/charset guessing, keyword/regular-expression heuristics, or intent inference to the final draft.
Only declarations that are **explicit, formatted, and anchored to a known label/source** in the final draft may participate in comparison; everything else is `skipped`.

### 3. Before adding a rule, first answer "can it be eliminated at the source?"
Any proposal to "add a rule to the guard" must first prove that the failure mode **cannot** be solved through a source mechanism:
`compaction stub (value remains in context)` / `structured notice (rerunOf, artifact status)` / `producer declaration (replayable/effect)` / `bounded retrieval (return exactly by address)`.
**If it can → fix the source; if it cannot → only then consider adding a rule, and the ADR must record why the source is infeasible.**

### 4. Every new state must have a clear consumer
The guard's output is a **state** (`verified` / `suspect` / `mismatch` / `skipped` / `unverified` / `error` / `rerun_cited`), **not an evaluation**.
- Do not output judgments such as "quality/compliance/whether requirements are met" (those belong to the host, tests, or people).
- Every new state must be **read in code or the host contract**; otherwise it must not be added.

### 5. Keep it opt-in, with a code-size limit
- The guard is disabled by default and explicitly enabled by the host (`--final-guard` / `ERIX_FINAL_GUARD=1` / library parameter).
- `bin/final-guard.js` **must not exceed 300 lines** (2026-09-14 baseline ≈215 lines). Exceeding the limit first requires review under rule 3 and an update to this ADR.

## Known boundaries (explicit and not to be evaded)

- **A free-floating value without a label cannot be detected**: if the final draft fabricates a value that does not correspond to any known label, the guard can only return `skipped`.
  This is neither fixed nor concealed—**the host/consumer bears this risk through archive audits, tests, or manual verification**
  (ADR-009 safety layering: this library does not provide a security boundary).
- **`skipped` does not mean "no problem"**: it only means "there was nothing comparable". The host consumption contract must state:
  only `verified` may be considered source-verified (see the verification consumption contract in README).

## Consequences

- **Positive**: guard complexity remains controlled, false-kill risk is low, and responsibility boundaries are clear; failure modes are forced to be solved
  at the **source** (stub/notice/declaration/bounded retrieval), rather than through after-the-fact detection.
- **Negative**: sacrifice detection capability that "looks more comprehensive" in exchange for reliability and maintainability; known detection gaps
  (free-floating values) must be handled by the upper layer and explicitly documented.
- **Constraint**: every subsequent guard-related PR **must be reviewed against this charter**; violations of rules 1/2 are rejected directly,
  while violations of rules 3/4/5 require an additional record in this ADR.
