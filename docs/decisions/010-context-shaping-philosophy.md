# ADR-010: Context-Shaping Philosophy—Memento's Two Problem Domains and the Correct Form of psyche

> Chinese version: [010-context-shaping-philosophy_cn.md](010-context-shaping-philosophy_cn.md)

- Status: Decided (2026-08-31)
- Background: The original inspiration for the psyche design came from the film Memento: the protagonist has amnesia and relies on tattoos to remind himself of key information.
  Deeper discussion confirmed that this analogy points to **two independent problem domains**. psyche is often evaluated as a "memory system", while its essence
  is **context shaping**. This document distills the discussion into a design philosophy and corrects psyche's problem-domain definition and engineering form.
- Related: ADR-003 (compaction lineage, psyche as level ④), ADR-007 (memory architecture, L3 facts/cold loop), ADR-004 (deferred reflection).
  **This document is a correction and supplement to the positioning of psyche in 003 level ④ and 007.**

## Problem-domain decomposition (Memento analogy)

| Problem domain | Memento counterpart | Mechanism | Driver | Information semantics |
|---|---|---|---|---|
| ① Rebuilding context after amnesia | Tattoos/notes/photos, looked up when needed | **recall** (already implemented in erix) | Model-initiated | Information is in the repository, waiting for the model to retrieve it |
| ② Hiding the fluff before entering the room | Do not let you see the fluff; keep only "where we left off" | **psyche** (this is its essence) | System-initiated | Shaped before entering context |

**recall is a retrieval problem (information is in the repository and the model retrieves it as needed); psyche is an active allocation problem for the context budget (information is shaped before entering).**
The erix compaction system = the complete implementation of problem domain ① (near-lossless archiving + on-demand retrieval); psyche belongs to problem domain ② and is orthogonal to ①.

## Core decisions

### Decision one: psyche is context shaping, not a memory system

- psyche cannot be evaluated with an "information fidelity/recallability" yardstick—its value proposition is **steady focus + denoising**:
  - Fidelity is **targeted fidelity** (keep the important, discard the fluff), not full fidelity; in conversation, "full fidelity" was never the goal.
  - "Hiding the fluff" has real reasoning benefits: JetBrains evidence (observation masking, SWE-bench Verified)—
    keeping only the most recent N complete tool results → cost down 52%, **solve rate up 2.6%**. Moving low-value information out of context
    focuses the model's attention, and quality may actually increase. This is not a money-saving trick, but a means of improving reasoning quality.
- The cost accounting must include the opposing side: psyche spends a small amount each round (reflection can use an independent mini model, 2000 tok output),
  while it saves the large cost of stuffing N rounds of raw text into the conversation model each round (context grows linearly with rounds + long-context attention dilution).
  touwaka's reflectiveModel configured independently of the expression model is precisely this tradeoff.

### Decision two: the three mechanisms are orthogonal and do not replace one another

| Mechanism | Timing | Trigger | Granularity | Unique capability |
|---|---|---|---|---|
| fold (level ③) | After the fact | Passive (over budget) | Coarse (whole round) | Safety-valve overflow handling, near-lossless and auditable |
| recall | On demand | Model-driven | — | Rebuild after amnesia, retrieve the original text |
| psyche | Before the fact | Active (every round) | Fine (distillation per round) | **query-aware potential**: distill selectively after receiving the current question (tattoo customized for the task at hand) |

What psyche can do physically that fold/recall cannot: **pre-shaping + query-aware on-demand distillation**.
touwaka does not implement query-aware behavior (the reflection input does not include currentMessage), but this is a capability unique to the psyche concept,
which neither fold nor recall has, and an optional incremental gap in conversational scenarios.

### Decision three: touwaka's psyche implementation is the wrong form; do not port the original

touwaka turns "shaping" into "rewriting the entire state every round": one LLM call per round, resending all session_meta/methodology
scalar fields (scalar overwrite); lists are incrementally merged (key_decisions deduplicated and appended, key_exchanges appended, notes_refs upsert),
but **scalar full resend + deletion at the source for lists** (addKeyExchange cap 10, addTopicContext cap 5) means state capacity is still constrained by both
the output budget (2000 tok) and source-side limits. It also lacks query-aware behavior (does not inspect the current question), introduces iterative drift
(a local view with lookback=4 is asked to rebuild global state), pending_questions only grows and never shrinks (removePendingQuestion is never called
on the reflection path), and compaction deletes without pointers (filter/slice with no decaying archive), among other defects
(reviewer correction on 2026-08-31: updateFromReflection is actually scalar overwrite + list incremental merge, not full overwrite rewriting).
Additionally: psycheStore's default TTL is 3600s, so psyche's "cross-session continuity" is actually limited to 1 hour. touwaka achieves long-term continuity
through topics archiving + recall; psyche itself is only a within-session workbench—it was never long-term memory.

**The ADR-003 decision to "prioritize porting touwaka lib/psyche's validated code" is void**; "existing code is available" is a cost-reduction factor,
not a reason to build it.

### Decision four: psyche's correct engineering form = cold-loop distillation + L3 injection (ADR-007)

ADR-007's cold loop is not a "replacement" for psyche—it is psyche's correct engineering form:
- Retain the benefit of "key information stays resident, fluff stays hidden" (the insight of pre-shaping is not discarded);
- Remove the drawbacks of "paying every round and synchronous latency on the request path" (full reflection every round is the wrong form);
- Form = low-frequency/asynchronous distillation (cold-loop archive slot) + injection at session start (L3 facts);
- Optional increment: query-aware on-demand shaping (after receiving the question, distill once the "key information needed to answer this question").

## Scenario-specific conclusions

- **Coding scenarios (erix's current positioning)**: the benefit of psyche pre-shaping is small—coding source text has high information density
  (tool calls/errors/diffs are all useful), state can be reread from disk (artifact evidence), and the proportion of "fluff" is low.
  The compaction system + recall is already the optimal form, **so do not port psyche or change the compaction system because of it**.
- **Conversational scenarios (if a companion is hosted in the future)**: retain the idea of "pre-shaping", using the form in decision four.
  Re-evaluate when: ① the companion conversation path is confirmed to migrate into erix; ② memory evaluation fixtures show
  fold-llm+recall's recall rate is inadequate on conversational tasks and remains inadequate after upgrading the conversation template
  (ADR-004's discipline of not skipping levels).

## Consequences

- psyche is redefined from "compaction lineage level ④ (to be implemented)" to "the pre-shaping philosophy for conversational scenarios, with engineering form = cold loop + L3";
  the level ④ annotation in the 003 lineage table and the psyche entry in the 007 phased roadmap follow this document's interpretation.
- A unified yardstick for evaluating memory/context mechanisms is established: **choose the yardstick by problem domain**—use the fidelity yardstick for fold/recall
  (near-lossless/auditable), and the focus and denoising yardstick for shaping mechanisms (psyche/L3); mixing yardsticks leads to wrong conclusions
  (this discussion is the lesson: evaluating psyche by fidelity produced "lossy, poor" results, while the focus yardstick revealed its actual value).
- In future conversational-scenario design, psyche must not be implemented as touwaka-style "full reflection every round";
  nor should the correct idea of "pre-shaping" be discarded because "the touwaka implementation has defects".
