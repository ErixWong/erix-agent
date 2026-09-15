# ADR-004: Reflection Deferred from the First Release, Reserved as an Optional summarizer Hook

> Chinese version: [004-reflection-deferred_cn.md](004-reflection-deferred_cn.md)

- Status: Decided (2026-08-29)
- Background: Psyche's core is "one reflective LLM call after every conversational round, updating structured state".
  The user's judgment: **not very helpful for development, so do not build it in the first release; it has higher value in conversations with humans.**
  **2026-08-31 correction (ADR-010)**: "reflection every round" itself was judged to be Psyche's wrong engineering form (the touwaka implementation is exactly this);
  Psyche's correct form is cold loop + L3 injection, so this ADR's conclusion "do not implement reflection every round" is consistent with and carries forward into ADR-010.

## Decision

The first release (v0.1/v0.2) **does not implement reflection after every round**. Reserve two hooks:

1. The `summarizer` injection point for the `fold-llm` strategy (ADR-003 ③)—call the LLM only at the fold point, not every round;
2. The interface slot for the `psyche` strategy (v2)—limited to conversation scenarios at that time.

## Rationale (theoretical formulation of the user's judgment)

- **State location principle** (already stated in ADR-003): the state of a development task is on disk and tools can reread it, so statistical traces + recall are enough to restore working context; the "intent/decisions" extracted by reflection in development scenarios can mostly be reconstructed from the git diff / file state, so the marginal value is low.
- **Unequal cost**: reflection every round = one additional LLM call per round. Tool loops have many rounds (24+ for development), so the cost doubles without a proportional gain; in a conversation, one reflection per round is an acceptable share, and what it buys is intent continuity across sessions—that is the sweet spot for reflection.
- **touwaka evidence**: its tool-oriented agent (anchor cleaning) solves context overflow through statistical folding (R19-1); Psyche is for companion conversations. The two paths each validate the user's judgment.
- Risk side: putting reflective output into context means "an LLM draft influences later decisions", which is acceptable in conversation scenarios, but dilutes app_container's hard evidence constraint in audit/development paths (conclusions must have real file evidence).

## Consequences

- The acceptance scenario for Psyche in v2 is touwaka's conversation path, not a tool loop.
- If future development tasks produce evidence that "statistical summaries are indeed insufficient" (the model repeatedly loses its way after folding), first upgrade to fold-llm (③); only if that is still insufficient should reflection every round be reconsidered—there is a clear upgrade ladder, with no jumping levels.
- **Research addendum (2026-08-29)**: the correct form for organizing during idle time has been externally validated as a **dual-agent architecture** (Letta sleep-time compute):
  the cold loop runs independently and can use a stronger model (extend the ADR-001 slot with an "archive" slot); it updates anytime without blocking the main loop;
  the main loop **deliberately does not attach** memory-management tools (too slow and unreliable). Design v2 in this form; see docs/research/2026-08-29-memory-context-research.md §3.4.
