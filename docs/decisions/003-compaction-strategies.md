# ADR-003: Compaction Strategy Lineage—from sliding-window to three levels of fold-llm + psyche outside the lineage (later corrected by ADR-010), pluggable

> Chinese version: [003-compaction-strategies_cn.md](003-compaction-strategies_cn.md)

- Status: Decided (2026-08-29; the psyche entry corrected according to ADR-010 on 2026-08-31)
- Background: The two existing implementations each represent one level: app_container's fixed 10-round hard sliding window (silently discarded),
  touwaka's budget folding + statistical summary (R19-1), and touwaka's Psyche (persistent reflective state).
  The user specified both ends of the lineage: **psyche is the most aggressive, with a sliding window as fallback**.
  (2026-08-31: psyche was removed from this lineage according to ADR-010 and redefined as an a priori shaping philosophy for conversation scenarios; see table row ④.)

## Decision

Unify the strategy interface (`shouldCompact(messages, budget)` / `compact(messages, opts)`), ordered by aggressiveness:
(④psyche originally belonged to this lineage; it was removed according to ADR-010 on 2026-08-31, and the table retains the strikethrough form to show the history)

| Level | Strategy | Mechanism | Information retained | LLM cost | Use |
|---|---|---|---|---|---|
| ①a | `clear-results` (research addendum, v1.x) | Replace old tool_result blocks with placeholders, **retaining tool_use traces and the latest N complete results**; the protect list is configurable | Tool traces + recent results | 0 | Tool loops whose results can be reacquired (empirical: cost down 52% while resolution rate increased; see docs/research §3.1) |
| ① | `sliding-window` | Discard complete early rounds when over budget | None (recall fallback can be configured) | 0 | Short-task fallback, extremely tight budgets |
| ② | `fold-statistical` | Fold complete rounds into a **deterministic statistical summary** ("14 rounds total: writeProjectFile×12, exec×5; use recall to retrieve them") | Tool-call traces | 0 | **Default for tool loops** (v0.1) |
| ③ | `fold-llm` | Inject one LLM call at the fold point to merge folded rounds into a **work log** (phases/files changed/items verified/next steps); the result must pass deterministic size enforcement | Narrative-level | 1 call per fold | Upgrade after a second fold in a long development task (v0.2) |
| ④ | ~~`psyche`~~ (**removed from the lineage according to ADR-010 on 2026-08-31**) | ~~Continuously maintain a structured state object in place of raw messages in context~~ → redefined as an **a priori shaping philosophy for conversation scenarios**; the engineering form = cold-loop distillation + L3 injection (ADR-007 Decisions Three/Four), not an implementation of this interface | ~~State-level~~ | ~~1 call per round~~ (the correct form is low-frequency/asynchronous and does not touch the request path) | ~~Long-running conversation scenarios (v2)~~ → trigger for reevaluation in ADR-010 |

Common components: `computeBudget` (window − output − max(2000, 10%) headroom), `estimateTokens`
(Chinese 1.5 tok/character, other text 3.5 characters/tok, +15%; coefficients configurable—take
the more conservative one from the two implementations), and `groupIntoRounds` (whole-round rules
for both protocols, with zero tolerance for orphan messages).

**Folding + recall integration** (the increment over the two predecessors): when ②③④ fold, they
write the original text to the TranscriptStore through `foldedPayload` (ADR-002), and summary text
uniformly carries the instruction "use recall(round X–Y) to retrieve the original text".
Folding changes from lossy to nearly lossless.

> Timeline note: the recall tool only landed in v0.2. During v0.1, summaries first said "the early N rounds have been folded; the original text remains in the transcript store"; after recall became available in v0.2, the wording was uniformly replaced with the instruction.

## Rationale

- **The location of state determines the summary method**: the real state of a development task is on the **working copy on disk** (code can be reread through tools), so a statistical summary + recall is sufficient; the intent/decisions of a human conversation exist only in the **conversation itself** and cannot be reconstructed after loss, so they require LLM reflection. This explains why touwaka's tool loop only needs statistical folding, while companion conversations need Psyche.
- All four levels share the same interface and the same budget/grouping primitives. Callers choose the level for the scenario, and the upgrade path is changing a strategy object rather than rewriting the system.
- The zero LLM cost of ② is the reason it is the default: tool loops already spend money every round, so compaction should not add a recurring cost.

## Consequences

- v0.1 implements only ①②; ③ arrives with v0.2 (dependent on a fold slot in the json-file config); ④ is explicitly v2 and limited to conversation scenarios.
- ~~When psyche is implemented, first port the validated code from touwaka `lib/psyche/` rather than reinventing it.~~
  **Voided (2026-08-31, ADR-010)**: touwaka's implementation (full reflection every round) is the wrong form and the original implementation will not be ported;
  psyche is redefined as an "a priori shaping philosophy for conversation scenarios", whose correct engineering form = cold-loop distillation + L3 injection (ADR-007 Decisions Three/Four);
  see ADR-010 for details.
- **Research addendum (2026-08-29, docs/research/2026-08-29-memory-context-research.md)**:
  ①a The clear-results level comes from external best practices (clear results before discussing summaries); combined with recall it surpasses Anthropic clearing (cleared original text can be retrieved from the store).
  Trigger threshold: external guidance recommends compaction at an effective window of about 70% (context rot); this library's headroom formula max(2000,10%) triggers at approximately 90%,
  but conservative token estimation plus +15% is equivalent to triggering earlier. The default is not changed for now, pending app_container calibration with real measurements.
  The fold-llm summary template must contain "completed items must not be redone" (external evidence: when a summary hides the stop signal, the trajectory lengthens by 13–15%).
