# Maintenance Policy (Internal Decision, Not for Public Distribution)

> Chinese version: [maintenance-policy_cn.md](maintenance-policy_cn.md)

## Documentation Revision Conventions

- **Living docs** (architecture.md, testing.md, charts.md, README, etc.) describe "now" — update them to the latest state when behavior changes.
- **Dated snapshot docs** (docs/design/<date>-*.md, docs/tasks/, docs/research/, meeting/review records) are point-in-time history — never rewrite them; record changes only as appended revision notes in the corresponding ADR (e.g. ADR-007 §issue #55).

## Technical Replacement Trigger Conditions

1. **When a third non-OpenAI-compatible native protocol (Gemini native / Bedrock / Azure) needs to be integrated**, migrate to AI SDK as the foundation.

## Quarterly Review (Stop-Loss Threshold)

If, for 6-12 consecutive months, `app_container` remains the only consumer and no new headless use case is initiated
→ consolidate into an `app_container`-private package and stop maintaining the public npm package (transfer versioning and contract-tests to app_container).
