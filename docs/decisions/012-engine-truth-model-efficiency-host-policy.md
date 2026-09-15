# ADR-012: Responsibility Boundaries Between the Engine, Model, and Host

> Chinese version: [012-engine-truth-model-efficiency-host-policy_cn.md](012-engine-truth-model-efficiency-host-policy_cn.md)

- Status: Decided (2026-09-14)
- Related: ADR-007 (memory architecture), ADR-009 (safety layering), ADR-010 (context-shaping philosophy), ADR-011 (judge direction evaluation)

## Background

The main problem in long-task failures is not that the model "does not verify", but that context compaction loses the truth needed later,
after which the model cannot converge within a limited number of rounds. Shortcuts (notes) can improve efficiency, but cannot become the sole
dependency for correctness. The system needs to assign truth, behavioral efficiency, and runtime policy to different responsibility domains,
avoiding the use of prompts to conceal fact loss on the engine side.

## Decision

> **Guard charter (non-expansible)**: see **ADR-013**—guard performs only exact comparison, must not parse model natural language (no form/keyword heuristics),
> and before adding a rule, first prove that it cannot be eliminated at the source (stub / notice / producer declaration / bounded retrieval);
> keep it opt-in, and `bin/final-guard.js` has a 300-line limit. PR reviews for all guard-like mechanisms must be conducted against this charter.

### Three-party responsibilities

1. **The engine is responsible for truth and mechanisms**: retain the minimum facts needed for tool results and provenance, maintain the protocol
   invariants for compaction, archiving, termination, budgets, and checkpoints; the engine must not outsource correctness to whether the model follows prompts.
2. **The model is responsible for efficiency**: decide when to use notes, how to plan and verify, and how to provide a conclusion within the budget.
   The model may reduce searching and repeated reads, but model behavior is not the source of truth.
3. **The host is responsible for policy and LTM**: inject tool execution, archive retrieval, `stubFor`, `finalGuard`, and TranscriptStore policies;
   long-term memory (LTM) belongs on the host side and does not enter the core engine of this library.

### Default-value criteria

- **Mechanisms that prevent the environment from lying are enabled by default**: for example, safe retention of facts that cannot be replayed,
  archive digest/provenance constraints, and deterministic termination signals.
- **Features that change model behavior are disabled by default**: for example, the CLI final provenance guard must be explicitly enabled
  through `--final-guard` or `ERIX_FINAL_GUARD=1`. The library API continues to accept an explicitly injected host
  `finalGuard` without changing its compatibility semantics.

### Correctness must not depend on model behavior

The test: delete all prompts, tool descriptions, and recovery suggestions; the system must still not silently deliver incorrect facts because of
compaction or replay. If deleting prompts produces a silent wrong answer, that correctness mechanism must be lowered into a deterministic protocol
of the engine or host. Prompts may improve efficiency and explainability, but cannot replace truth preservation, source verification, or fail-closed state expression.

### Probes and experiments

Probes are not a routine operating method. Before expanding an experiment, first conduct **3–5 pilot runs** and confirm that the probe can distinguish
the target hypothesis from noise; all experiments must use an explicit budget, cost floor, and reproducible experiment record.

## Consequences

- Compaction stubs and bounded archive indexes belong to engine/CLI mechanisms and navigation; do not inject complete archive values into context.
- notes are shortcuts and pull-only indexes; LTM, cross-run organization, and policy orchestration are determined by the host.
- Forced wrap-up and low-budget hints help the model converge, but even if the model ignores them, the termination reason and `forcedFinal`
  marker are maintained deterministically by the engine.
- The CLI guard being disabled by default is an intentional behavior change: it changes the model/host interaction path, rather than
  being a low-level mechanism that prevents the environment from lying.

## Relationship to existing ADRs

- **ADR-007** defines memory layering and the direction of recall; this ADR makes clear that LTM does not enter the core library, while notes/archive
  remain short-term recovery mechanisms integrated by the host.
- **ADR-009** delegates the security boundary to the sandbox/host; this ADR continues that layering, while requiring the engine to remain responsible
  for its own fact chain, archive integrity, and termination protocol.
- **ADR-010** context shaping may optimize usable context, but cannot remove truth the engine must retain.
- **ADR-011** judge/direction continues to serve efficiency and direction correction without changing the principle that "the model is not the source of truth".
