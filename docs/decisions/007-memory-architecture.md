# ADR-007: Memory System Architecture—five memory layers / episode / three-state recall / hot-cold dual loop

> Chinese version: [007-memory-architecture_cn.md](007-memory-architecture_cn.md)

- Status: Decided (directional architecture, v1.x/v2 design input; aligned with the "Consequences" section in v0.2) 2026-08-29
- Background: The original intent of psyche was "a tiny initial context + the right recall tool = infinite expansion", with LLMs organizing archives during idle time;
  touwaka topics are an initial implementation of archiving. See external research in docs/research/2026-08-29-memory-context-research.md
  (Letta sleep-time dual agent, three production context-engineering mechanisms, A-MEM, Generative Agents).
- Related: ADR-002 (archive/view separation), ADR-003 (compaction lineage), ADR-004 (reflection deferred and cold-loop form), ADR-005 (reason for built-in recall).
  **2026-08-31 correction (ADR-010)**: psyche was redefined from a "memory mechanism" to an a priori context-shaping philosophy for conversation scenarios;
  the cold loop + L3 injection in this ADR is psyche's correct engineering form, and psyche is no longer an independent module awaiting implementation; see ADR-010.

## Decision One: Five-layer memory model + five drivers

```
In context │ L3 facts + memory map (tiny hard budget)  ▲ ⑤ injection: session start
           │ L1 fold summary (replacing folded rounds)  ▲ ② budget-driven: check each round
           │ L0 working memory (raw messages from the latest N rounds)  ▲ ① loop-driven: each round
───────────┼──────────────────────────────────────────
Out of context │ L2 episode (summary + index + pointer)  ▲ ③ event-driven (hot archive) ④ idle-driven (cold loop)
               │ Foundation: TranscriptStore complete original text  ▲ ① loop-driven (snapshot every round)
                       ◀── three-state recall (⑤ on demand by the model)──
```

| # | Driver | Executor | LLM cost | Applies to |
|---|---|---|---|---|
| ① | Loop-driven (automatic every round) | runToolLoop | 0 | Foundation, L0 |
| ② | Budget-driven (triggered over threshold) | CompactionStrategy | 0 or 1 per fold | L1 |
| ③ | Event-driven (run/session ends) | Hot archive (caller's task) | 1 per episode | L2 creation |
| ④ | Idle-driven (periodic idle) | Cold-loop agent (archive slot) | Configured by frequency | L2 organization, L3 distillation |
| ⑤ | On-demand (model/injection) | recall tool + session injection | No LLM cost for retrieval | L2/L3 → context |

Cost-structure principle: **the main loop (①②⑤) spends almost no LLM money; comprehension work (③④) moves out of the user's waiting path** (the Pareto improvement of sleep-time compute).

## Decision Two: episode definition—lineage, not correspondence

episode = **an archive item for a complete "experience"** (borrowed from episodic memory in cognitive science, paired with L3 semantic memory).
The boundary = **the goal boundary (run/task), not the number of rounds, message indices, or topic segments**.
Thirty rounds are one episode; 30 rounds + an audit failure + another 30 rounds are still one episode—the audit failure is an internal turning point,
not a boundary. touwaka topics' segmentation into "time-contiguous segments strongly corresponding to messages" has been disproved (incorrect topic detection fragments the semantics).

```js
episode = {
  id, summary,                    // narrative reconstruction; observed facts and inferred intent are labeled separately (inferences do not enter the audit evidence chain)
  phases: [{ name, rounds, outcome }],       // internal phases/attempt structure
  index: { keywords, entities,
           decisions: [{ what, why }],
           openItems, importance /* 1-10, assigned by the LLM during archiving */,
           artifacts: { filesChanged, commits, verifiedBy } },  // first-class index fields for coding scenarios
  sourceRef: [{ runId, fromRound, toRound }, ...],  // pointer array: create a segment, merge and append, may span runs
  access: { count, lastAt },      // touch on recall hit, feeding forgetting
}
```

Three pointer semantics: ① **lineage, not identity**—answer "which original text produced this summary"; an episode is a derived object and can be merged/split across sessions;
② **weak reference**—the store lifecycle belongs to the caller (ADR-002), so a pointer may dangle; when recall retrieves original text, degrade gracefully
("the original text has been archived and cleaned up; only the summary remains" + confidence tiers: original text verifiable > summary only > degraded old summary);
③ **do not store an original-text copy**—the single source of truth is TranscriptStore, while episodes remain lightweight (objects subject to degradation through decay).

## Decision Three: Hot-cold dual loop

- **Hot archive (③)**: triggered when a run/session ends; read the full picture from the **archive** (not context; folding does not affect the archive, invariant 5),
  and use **one LLM call to produce summary + index + phases simultaneously** (index and summary share a source, preventing drift).
  The archivist has the benefit of hindsight and can infer the true causal chain from tool sequences/artifacts/audit conclusions (learned context > raw context).
- **Cold loop (④)**: an **independent agent** (extend the ADR-001 slot with an "archive" slot; a stronger model may be configured), updating anytime without blocking the main loop. Three responsibilities, independently switchable:
  ① Distill L3 facts (extract across episodes, organized by partition: preferences/project facts/decisions/open items);
  ② Merge highly overlapping episodes / split overly coarse ones (append to sourceRef, do not renumber);
  ③ Decay: downgrade and then refold summaries whose `access.count` remains zero for a long time (**do not delete original text**);
  conflicting facts are not overwritten; mark them with `supersededBy + timestamp` (bi-temporal: facts expire, while old values remain archived for auditing).
- **The main loop has zero write tools** (the core sleep-time lesson: attaching memory-editing tools to the main agent is slow and unreliable).
  When the model says "remember this", record it in the transcript and let the cold loop distill it naturally. Exception: the `note` tool (explicit preference memory)
  carries project policy and belongs on the caller side (touwaka INotesStore is an existing implementation), not in the library.

## Decision Four: recall—one tool, three progressive states (the only memory tool in the main loop)

Tool-budget discipline (external evidence: 19 precise tools outperform 46): L3 facts/memory map enter through **injection**, not a tool;
the main loop gets only one tool and expands progressively by parameter:

| Call | Behavior | Hard cap (configurable by default) |
|---|---|---|
| `recall()` | Memory map: one line per episode (id/title/importance/time/open items) + fold watermark | 500 tok, truncated by importance |
| `recall({pattern})` | **Preferred use**: search index fields + folded rounds, grep -C excerpts + follow-up pointers | 300 per segment / up to 5 segments / 1500 tok total |
| `recall({episodeId}` or round range) | Return original text from the archive (for reconciliation); degrade according to Decision Two if dangling | 500 per result / 2000 tok total |

**Four layers against overflow**: ① three progressive states (small cost first, large cost later); ② hard caps at every level + a truncation marker ("[truncated, 12k total, offset=5 to continue]",
never silently cut); ③ pass through the `onToolResult` gateway before feeding back (the library provides the truncateToTokens helper); ④ system self-stabilization
(compress on the next round when over budget) + anti-ping-pong (stallDetection catches repeated signatures; **fold summaries must leave a trace**: "recalled
'JWT' at round X (conclusion: …)" so recalled facts enter the summary and are not recalled repeatedly).

**Five-layer guidance** (the model does not recall spontaneously; guidance is designed):
① Summary breadcrumbs—fold summaries carry topic words/open items/actionable recall examples (the summary is the context projection of the retrieval index);
② Low-friction interface—**pattern first, round range second** (a direct correction to the v0.2 recall specification); empty results provide alternatives;
③ put the trigger timing in the description; ④ **proactive loop hint**—when signs of being lost are detected (repeated work/stall precursor), inject
"early rounds have been folded; use recall to find them" (a runToolLoop hook; a framework-level product would hard-code it, while we provide a mounting point as a library);
⑤ inject the memory map into the initial context.

## Decision Five: Coding-scenario specialization

The raw material of coding memory is **actions rather than words**: `memory = artifact evidence (hard) + tool sequence (trace) + archived inferred narrative (soft, labeled) + a small number of decision notes`.

- `index.artifacts` (filesChanged/commits/verifiedBy) is a first-class index field—"why was this changed at the time" is best evidenced by
  the diff/file state/test results, which can be reread and rerun during recall (the state-location principle applied for the third time).
- Solution to the missing-thought gap (a lot was considered but not said) = archive reconstruction + artifact checking + inference labels, **not round-by-round recording**;
  decision notes follow the caller's prompt policy ("state the reason in one sentence for directional decisions");
  if the upstream returns a thinking block, store it in the store but not in context (raw escape hatch, reconsider in v1.x, an enhancement rather than the primary defense).
- This section reaffirms ADR-004: in coding scenarios, "why" can be reconstructed from artifacts during archiving; reflection every round doubles the cost to buy nothing.

## Decision Six: Phased roadmap and evaluation discipline

| Step | Content | Independent acceptance |
|---|---|---|
| 1. v0.2 | file store + recall (pattern first) + fold-llm (summary template includes "completed items must not be redone" + topic-word breadcrumbs + trace) + tools subpath | Is recall useful? |
| 2. Memory evaluation fixture v1 (with v0.2) | Plant known facts in a long conversation → fold → ask a question → assert hit rate and **spontaneous model call rate** | Regression net for all later memory work |
| 3. app_container migration | 24-round real scenario | Calibrate default budget values and the real redo rate |
| 4. v1.x | clear-results (ADR-003 ①a) + episode structure + ArchiveStore interface (built-in memory/file) + hot archive | Index-field extraction quality |
| 5. v2 | Cold loop (archive slot) + L3 facts injection + episode linkage (the Psyche philosophy lands here; see ADR-010) | Recall rate across the full pipeline |

Discipline: **retrieval fields first, independent acceptance at every step, and later steps must not degrade earlier-step metrics** (roll back cold-loop distillation if it lowers recall).
The greatest failure mode of a memory system is "beautiful architecture, terrible recall"; the evaluation fixture is the only safeguard.

## Appendix: Example scenario (anchored in a real case)

Using 2026-08-29 erix-agent v0.1 development (~40 rounds of tool calls) as a complete example:
the episode contains phases (contract scaffolding → four workers in parallel → integration troubleshooting → merge), decisions (relay rejected Qwen3.5, so switched to
historical-model; forced-compression e2e constructed history with initialMessages to trigger deterministically), artifacts (31 files/commits 8cd7022/
92 tests green), and openItems (app_container migration); three days later `recall({pattern:"强制压缩"})` `// "forced compaction"` finds an excerpt,
`access.count++`; one week later the cold loop distills the L3 fact "my-relay token is not enabled for Qwen3.5" into the initial context;
once it is enabled later, the old fact is marked superseded and retained for auditing; after three months without access, the summary is downgraded while the 40 rounds of original text remain untouched.
(This example is also the design reference for the v0.2 memory evaluation fixture.)
