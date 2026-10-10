# Maintenance Policy (Internal Decision, Not for Public Distribution)

> Chinese version: [maintenance-policy_cn.md](maintenance-policy_cn.md)

## Documentation Revision Conventions

- **Living docs** (architecture.md, testing.md, charts.md, README, etc.) describe "now" — update them to the latest state when behavior changes.
- **Dated snapshot docs** (docs/design/<date>-*.md, docs/tasks/, docs/research/, meeting/review records) are point-in-time history — never rewrite them; record changes only as appended revision notes in the corresponding ADR (e.g. ADR-007 §issue #55).

## Technical Replacement Trigger Conditions

1. **When a third non-OpenAI-compatible native protocol (Gemini native / Bedrock / Azure) needs to be integrated**, migrate to AI SDK as the foundation.

### Revision (2026-10-10, issue #189) — defining the trigger term in rule 1

Rule 1 above is kept verbatim; this note only defines the term it left ambiguous ("a third non-OpenAI-compatible native protocol") and records one ruling, so a later session does not have to relitigate it.

- **What counts**: the counting unit is *a vendor family outside the OpenAI family whose native protocol needs its own adapter*. The two shipped protocols are OpenAI-compatible `chat/completions` and Anthropic `messages`; the trigger is the next (third) one, and it must come from a **non-OpenAI vendor** — the examples already named in rule 1 (Gemini native / Bedrock / Azure) are illustrative, not an exhaustive list.
- **What does not count**: another API surface from the OpenAI family itself. **OpenAI Responses (`/v1/responses`) is ruled out of scope and is explicitly not a trigger** (issue #189, maintainer decision 2026-10-10, original wording: "no need to consider the responses API, no real demand"). Read literally, rule 1 would have swallowed it — Responses is not a `chat/completions`-compatible protocol, so it looks like "the third protocol" — but counting it was never the intent, and the literal reading is what this note closes.
- **Why**: carrying `reasoning` items across rounds is multi-turn orchestration owned by the **host**, which sits on the far side of the library boundary (`AGENTS.md` §1: "the boundary ends at a single task lifecycle"), and matches the `docs/requirements.md` §2 non-goal "Do not become a 'mini pi'". This is a scope decision, not a missing capability — the endpoint does reach the API layer on our relay (measured in issue #189: `/v1/responses` returns a gateway 401, while the `/responses` and `/bogus` controls return 200 with the same frontend HTML), and a host that needs cross-round reasoning items for OpenAI reasoning models uses its own relay or adapter.
- **Effect on the counter**: Responses never enters the tally, so the AI SDK migration stays triggered by the first **non-OpenAI-family** native protocol.

The corresponding scope entry lives in `docs/requirements.md` §2 "Non-goals (never do)".

## Quarterly Review (Stop-Loss Threshold)

If, for 6-12 consecutive months, `app_container` remains the only consumer and no new headless use case is initiated
→ consolidate into an `app_container`-private package and stop maintaining the public npm package (transfer versioning and contract-tests to app_container).
