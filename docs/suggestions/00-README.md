# erix-agent suggestions: drafts for GitHub (ErixWong/erix-agent)

Checked against **main @ 1545539** (2026-10-09), the maintainer's architecture review, ADRs, `requirements.md` and open/closed issues as of 2026-10-09. Nothing here has been posted.

Body format follows the maintainer's issue style: background → evidence (file:line) → proposal → acceptance → semver. Titles use conventional-commit prefixes. Written in English; the maintainer writes mostly Chinese with English identifiers, so a CN summary line could be added.

## To file (suggested order)

| # | File | Type | Size | Why it's not a duplicate |
|---|---|---|---|---|
| 1 | 01-test-tmpdir.md | test hygiene | S | No issue covers it; reproduced 40/1163 failures |
| 2 | 02-ci.md | process | S | No CI config; #158 mentions it only in passing |
| 3 | 03-cli-edit-tool.md | CLI feature | M | No edit tool; scoped to CLI to respect ADR-005 |
| 4 | 04-stability-policy.md | docs/process | S | No issue proposes a policy or 1.0 criteria |
| 5 | 05-pi-1x-refresh.md | docs + ideas | S–M | Comparison doc pins pi 0.84.2; 4 facts now wrong |
| 6 | 06-responses-api-question.md | decision request | – | No issue; conflicts with maintenance-policy rule 1, so asked as a question |
| – | comment-on-179.md | comment | – | Path escape is already tracked (#179 / A14) and ADR-009 rejects a sandbox |

## Dropped after checking (do not file)

- **README says v0.9.0**: fixed upstream (#164, f953f1e).
- **.d.ts types**: open #169.
- **runToolLoop god-function / observer isolation**: #177 (open umbrella) / #173 (done).
- **MCP in library, subagents, sandbox**: deliberately out of scope (`requirements.md` non-goals, ADR-009, closed #49).
- **Token-estimate calibration from real usage**: already done (`projectedApiInputTokens`, `src/loop/budget.js:47`).
- **Replay-safe tools on resume (pi-durable style)**: already done (`replayPolicy: "per-tool-declaration"`).
- **Prompt-cache-friendly folding**: already researched and B3 proposed; folded into #5 as supporting evidence, not filed separately.
