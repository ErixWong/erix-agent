# Requirements — erix-agent

> Chinese version: [requirements_cn.md](requirements_cn.md)

This document was first drafted on 2026-08-29 and has been reconciled with the implementation shipped in version 0.5.1. It describes the library's actual scope and APIs, not an unqualified list of future plans.

## 1. Consumer context and pain points

### app_container (`apps/worker/src/pi/` + `packages/context`)

- Existing capabilities: dual-protocol normalization (OpenAI/Anthropic to common `tool_use`/`tool_result` blocks), stall detection based on signature-window comparison, a fixed ten-round hard window, `max_tokens` continuation, and skeleton folding for idea conversations (`chat_summary_json` plus the `foldedUpTo` watermark).
- Pain points: (1) the hard window silently discards early rounds, so a 24-round development task can lose half its history and the model may redo completed work; (2) a provider error fails the whole task and causes the reaper to start over, wasting the LLM calls already paid for; (3) `pi_models.context_window_tokens` is stored but was not wired into the loop (`llm-context-budget.md` §7, “not changed this cycle”); and (4) skeleton-folding output had no deterministic size enforcement, relying on the LLM to obey the budget instead of keeping the final size a code invariant.

### touwaka (`lib/agent/` + `lib/context-organizer/`)

- Existing capabilities: budget-driven whole-group folding with statistical summaries (`history-compactor`, R19-1), in-round snapshot retry (`round-state-snapshot`), completion-signal detection (R15), adjacent-assistant merging (R16-3), orphan-message protection, and the Psyche reflection system for conversation workloads.
- Pain point: the two implementations duplicate one another while evolving separately, and the lessons from compaction and retry do not flow back into a shared runtime.

## 2. Goals and non-goals

### Goals

1. Provide OpenAI-compatible (`chat/completions`) and Anthropic (`messages`) adapters with streaming and non-streaming calls, one canonical internal block format, and common error classification.
2. Provide the `runToolLoop` single-task lifecycle: injected tools and execution, `maxRounds`, optional in-round provider retry, stall detection, completion and no-tool policies, `max_tokens` continuation, checkpoint/resume, optional reflection/judge governance, and observable events.
3. Provide pluggable context-budget compaction: `sliding-window`, `fold-statistical`, and `fold-llm`, with archived folded payloads and bounded recall.
4. Keep configuration and persistence behind adapter contracts. The package includes static, environment, JSON-file, memory, and JSONL-file implementations; database adapters remain in consumer projects.
5. Remain zero-runtime-dependency, pure ESM, compatible with Node 22+, and testable with `node --test`.

The library boundary ends at the lifecycle of one agent task: start, run, stop, resume, and emit events for that task. Multi-agent orchestration, arbitration, task queues, and retry scheduling across tasks are the host's responsibility and are deliberately outside this package.

### Non-goals (never do)

- ❌ Do not make tool execution mandatory or implicit in the core loop. The host supplies `tools` and `executeTool`; the optional `erix-agent/tools` subpath contains reference helpers and reference executors, but the host must explicitly wire and govern them.
- ❌ Do not turn the library runtime into an agent-personality, skills, session-management, TUI, or MCP framework. Those are CLI or host concerns, not the `src/` runtime contract.
- ❌ Do not provide a security policy or security boundary (allowlists, secret-redaction policy, artifact gates, or host isolation). Security remains the host/runtime's responsibility.
- ❌ Do not choose a database engine or own a consumer project's database schema. Consumers implement the adapter contract on their side.
- ❌ Do not become a “mini pi”. Consumers that need a complete interactive agent should use pi itself or its SDK rather than expanding this package into one.
- ❌ Do not ship the planned `psyche` compaction strategy in the 0.5.1 runtime. Its context-shaping idea remains a future, conversation-oriented design candidate rather than a current implementation.

## 3. Functional requirements

### FR-1 Provider adapters

| # | Requirement | Status and implementation |
|---|---|---|
| FR-1.1 | OpenAI-compatible (`chat/completions`) and Anthropic (`messages`) protocols, both streaming and non-streaming | **Delivered.** `createOpenAIProvider` and `createAnthropicProvider` expose `chat` and `chatStream`. |
| FR-1.2 | Normalize both protocols into one internal block format (`text` / `tool_use` / `tool_result`) | **Delivered.** `src/messages/canonical.js` and `src/messages/anthropic.js` also preserve `raw`, image, and reasoning blocks where needed. |
| FR-1.3 | Common error classes: `timeout` / `rate_limited` / `auth` / `network` / `server`, with a retryability marker | **Delivered.** `src/providers/errors.js` provides `KitError`, HTTP classification, fetch-exception classification, and `retryable`; it also exposes explicit `aborted`, `provider_config`, `invalid_messages`, and related non-retryable errors. |
| FR-1.4 | For HTTP 2xx responses containing an error body, preserve the real upstream message instead of reporting a misleading missing-choice error | **Delivered.** Both providers inspect successful response bodies for provider errors and preserve the upstream message; OpenAI responses missing `choices` include a bounded response preview. |
| FR-1.5 | Pass model metadata (`contextWindowTokens` / `maxOutputTokens`) into the loop so it can derive a compaction budget | **Delivered, with an explicit input contract.** Provider factories return these metadata fields, and `runToolLoop` accepts them from `modelConfig`, `modelMetadata`, `model`, `provider`, or `context` and calls `computeBudget` when both values are available. A budget is not inferred when either value is absent. |

### FR-2 Tool loop (`runToolLoop`)

| # | Requirement | Status and implementation |
|---|---|---|
| FR-2.1 | The host injects `tools` with standard JSON Schema definitions and an `executeTool(name, input)` callback; the library does not own the execution policy | **Delivered.** `runToolLoop` passes the schemas to the provider and accepts either the positional callback or the structured `{ id, name, input, context, signal }` form. |
| FR-2.2 | Retry a retryable provider failure from an in-round snapshot, with a default of two retries and exponential backoff from 1.5s to a 10s cap; throw after the retries are exhausted | **Delivered as opt-in, not as a default.** With `retry: {}`, `runToolLoop` defaults to two retries, a 1.5s base delay, and a 10s cap, restores the round snapshot, and retries only errors marked `retryable`. The default is `retry: false`; tool execution itself is not automatically retried. |
| FR-2.3 | Detect stalls by comparing tool signatures in a sliding window, nudge first, and stop normally with `termination.reason="stall"` only after repeated excess | **Delivered.** `stallDetection` defaults to a four-signature window, supports `appear` and `consecutive` modes, nudges on early hits, and stops after the three-hit stall streak limit. |
| FR-2.4 | Apply a completion signal and no-tool-round policy: after tool history, treat a response without a completion signal as transitional text and continue; by default force termination after three consecutive no-tool rounds; merge adjacent assistant messages to avoid a 400 | **Delivered with explicit switches.** `completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`; the wrap-up JSON protocol supports `done: false` continuation and `done: true` completion, and `normalizeMessages` merges adjacent assistant messages. `completion: false` disables the no-tool policy for conversation-style hosts. |
| FR-2.5 | Continue a response truncated by `max_tokens` | **Delivered with a bound.** The loop continues up to `maxTokenContinuations` (default `3`) and then reports `termination.reason="continuation_exhausted"` when the cap is reached. |
| FR-2.6 | Run the compaction check before each LLM call and include compaction events in returned statistics | **Delivered when a budget or strategy is configured.** The loop checks before each round request and rechecks before a continuation when the request is over budget; returned `compactionStats` contains the compaction result and token counts. |

### FR-3 Context compaction

| # | Requirement | Status and implementation |
|---|---|---|
| FR-3.1 | `budget = contextWindowTokens − maxOutputTokens − max(2000, 10% of the window)` | **Delivered.** `computeBudget` implements this formula and rejects invalid or non-positive budgets. |
| FR-3.2 | Estimate tokens as 1.5 tokens per CJK character, 3.5 characters per non-CJK token, plus a 15% margin; remain conservative and make coefficients configurable | **Delivered with additional accounting.** `estimateTokens` uses those defaults and configurable coefficients, and message estimation adds per-message overhead plus image, reasoning, raw-block, tool-name, and tool-input costs where applicable. |
| FR-3.3 | Fold whole groups: a round is an assistant message plus its immediately following tool-result message, using each protocol's pairing rules; never fold the system header or first user message | **Delivered by the compaction strategies.** `validateMessages` and `groupIntoRounds` enforce adjacent tool pairs, and the strategies retain the head through the first real user message. `protectedMessage` can add guards. If a last-resort safe truncation is required to meet the budget, protected messages may be downgraded or a single over-budget protected message may fail with `invalid_budget`; this is not an unconditional promise that every fallback view can retain the head. |
| FR-3.4 | Provide the strategy progression `sliding-window` → `fold-statistical` → `fold-llm` (optional summarizer); define Psyche as a separate conversation-oriented context-shaping idea rather than a fourth shipped strategy | **Partly delivered and explicitly split.** `createSlidingWindowStrategy`, `createFoldStatisticalStrategy`, and `createFoldLlmStrategy` are shipped. No `psyche` strategy exists in `src/`; `src/reflection/` is a separate judge/governor/wrap-up/L0 governance layer, not a compaction strategy. |
| FR-3.5 | Enforce a deterministic size limit on LLM-produced summaries by pruning fields in code rather than trusting the LLM | **Delivered for `fold-llm`; not applicable to an unshipped Psyche strategy.** `src/compact/enforce-size.js` applies field priorities and `src/compact/fold-llm.js` enforces `maxSummaryTokens` with deterministic fallback truncation. `fold-statistical` is deterministic and does not rely on an LLM summary. |
| FR-3.6 | Track a `foldedUpTo` watermark; persist folded rounds in `TranscriptStore`; allow recall to retrieve them for near-lossless folding | **Delivered under a different API; the old field name is not shipped.** `runToolLoop` tracks an internal `foldedThrough` value, while records expose `foldedRoundRange` and `foldedPayload`. The memory and file stores persist folded payloads, and their legacy recall plus bounded object recall can read both current messages and folded payloads. |

### FR-4 Configuration and persistence adapters

| # | Requirement | Status and implementation |
|---|---|---|
| FR-4.1 | A `ModelConfigProvider` contract with static, environment, and JSON-file implementations; `apiKey` may refer indirectly to an environment variable or file | **Delivered as a duck-typed `resolve(slot)` contract rather than a class or formal interface.** `createStaticModelConfigProvider`, `createEnvModelConfigProvider`, and `createJsonFileModelConfigProvider` are implemented; `resolveApiKey` supports direct values, `apiKeyEnv`, and `apiKeyFile`. |
| FR-4.2 | A `TranscriptStore` contract with memory and JSONL-file implementations, including crash resume | **Delivered.** `createMemoryTranscriptStore` and `createFileTranscriptStore` implement append/load/recall plus run-state and checkpoint methods. The file store repairs or isolates a damaged trailing JSONL fragment, and `runToolLoop({ store, runId, resume: true })` restores transcript and pending checkpoint work. Exactly-once side effects remain the host's responsibility. |

### FR-5 Tool system

| # | Requirement | Status and implementation |
|---|---|---|
| FR-5.1 | Define a standard tool schema; let the adapter own protocol serialization; keep execution in the host | **Delivered.** `ToolSchema` uses `inputSchema`; `canonicalToolsToOpenAI` and `canonicalToAnthropicRequest` serialize it for each provider, while `executeTool` remains the loop's injected execution boundary. |
| FR-5.2 | Provide an optional `erix-agent/tools` subpath with recall, tool registration, and tool providers | **Delivered.** `package.json` exports `./tools` to `src/tools/index.js`, which exports `createRecallTool`, the tool registry, and tool providers. These are opt-in and are not automatically installed as loop tools; no path-jail or filesystem helper is included. |
| FR-5.3 | Make tool definitions pluggable (`static` / `json-file` / `composite`, with DB in the consumer project); keep the executor registry in code and fail closed on mismatch | **Delivered.** `src/tools/providers.js` implements the three providers and `src/tools/registry.js` keeps executors in a code-owned map, validates inputs, merges provider schema overlays, and throws `tool_unknown_executor` when a provider names an unavailable executor. No DB provider is included. |

## 4. Phasing and implementation status

The original phase plan is reconciled below with what exists in package version 0.5.1. “Delivered” describes repository code; consumer migrations and real-provider benchmark runs remain external acceptance work.

| Version | Scope | Acceptance/status |
|---|---|---|
| **v0.0 — delivered** | MVP vertical slice: OpenAI non-streaming provider, canonical messages, token estimation, the minimal `runToolLoop` (`maxRounds`, `executeTool`, stall detection), memory store, and `examples/exec-demo.js` with execution owned by the demo | The repository contains the mock-fetch test suite and the exec demo. A real LLM run against a local relay is an external check and is not asserted by this document. |
| **v0.1 — delivered** | Full provider layer (Anthropic plus streaming), `src/messages/`, tokens, the loop features represented by FR-1/2, `sliding-window`, `fold-statistical`, memory store, and static/environment config | The library surfaces are present and covered by repository tests. Complete `app_container` migration and the 24-round behavioral comparison are consumer-side acceptance criteria, not shipped facts verified here. |
| **v0.2 — delivered** | JSONL file store, recall, JSON-file config, `fold-llm` with an injected summarizer, and the optional `erix-agent/tools` export: jail, reference file tools, recall, registry, and tool providers | Crash repair/resume and folded-payload recall are implemented in the stores and loop. The host still chooses whether to use the reference tools. |
| **v0.3.x–v0.4.x — delivered** | Checkpoint/resume hardening and the optional reflection layer in `src/reflection/`: governor decisions, L0 facts, wrap-up parsing/normalization, round judge, transparent tool interception, direction hints, and `finalGuard`/verification hooks | The loop exposes these behaviors through `reflection`, `onJudge`, `finalGuard`, and returned termination/verification data. Reflection is automatically enabled for `maxRounds >= 16` unless explicitly disabled. |
| **v0.5.0–v0.5.1 — current** | Bounded recall in `src/store/bounded-recall.js` with `limit` / `cursor` / `maxBytes` / `artifactRef`; deterministic bounded run state in `src/run-state.js`; fold navigation records and stubs; resume-safe state persistence; and the `./tools` package export | `package.json` reports version `0.5.1` and exports `.`, `./tools`, and `./contract-tests`. Run-state persistence is bounded and explicit about unavailable or stale state; bounded recall is source-limited and cursor-bound. |
| **v1.0 candidate — not shipped** | A touwaka migration, initially limited to token utilities and the history compactor, with the full `AgentLoop` migration left as a separate decision | No touwaka migration is part of this repository's 0.5.1 implementation. Consumer-side regression and behavior checks must be run by the host project. |
| **v2 candidate — deferred** | Cold-loop distillation plus L3 fact injection for the context-shaping idea, and native Gemini support if a future provider-layer reassessment justifies it | No `psyche` or Gemini-native provider is present in `src/` at 0.5.1. This remains separately scoped work. |

## 5. Non-functional requirements

- `examples/` is a first-class integration surface. The repository currently includes an `exec` demo, a memory benchmark, and provenance reproduction coverage; a future consumer should be able to follow a runnable example, while a missing per-milestone dialogue or audit demo must not be treated as an implemented capability. Reference demos keep execution on the consumer side.
- Storage progression is memory first, then JSONL file so the full lifecycle can run with only a filesystem. A MariaDB or other database adapter is not shipped; consumer projects implement `TranscriptStore` and `ModelConfigProvider` against their own schema and infrastructure.
- There are no runtime dependencies, no build step, and no development dependency requirement beyond the built-in `node --test` runner.
- Repository files must not contain keys or tokens. The configuration adapters treat `apiKeyEnv` and `apiKeyFile` indirection as a first-class mechanism; direct `apiKey` values are accepted as configuration input but must not be committed.
- Compaction, retry, protocol adaptation, checkpoint/resume, reflection, and bounded-recall behavior are locked down by `node --test` tests, with provider tests using mock `fetch`. External consumer migrations and real-relay behavior require their own tests.
- Distribution is through the public npm package `erix-agent`.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Abstraction leakage: canonicalization hides a protocol-specific feature | Provider and message adapters preserve `raw` escape-hatch blocks; provider-specific payload options remain available through the adapter layer. |
| Touwaka migration regression: its `AgentLoop` contains the R15/R16/R19 production fixes | Keep the touwaka migration outside the 0.5.1 claim; migrate the pure utility layer first and make the full loop a separate decision with host-side regression tests. |
| Release friction for a single-maintainer project | Use semantic versioning and a changelog; consumers pin and deliberately upgrade versions. |
| Consumers defer migration because the immediate benefit does not offset integration cost | Treat consumer migration as an explicit host-project milestone. The 0.5.1 library is more than a utility package, but it cannot claim a migration that is not present in this repository. |
| Upstream APIs absorb context editing or server-side loop capabilities | Keep the value proposition anchored to self-hosted relays and open models where those services are unavailable; reassess the project boundary if that premise changes. |
| The compaction progression becomes a four-level promise while only the first level is used | Do not describe `psyche` as shipped. Move from `fold-statistical` to `fold-llm` only when behavior justifies it; evaluate the deferred context-shaping design separately and do not skip empirical gates. |
