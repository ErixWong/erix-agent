# erix-agent

> Chinese version: [README_cn.md](README_cn.md)

**erix-agent** is a zero-dependency, pure ESM LLM runtime for headless coding
agents. It provides dual-protocol streaming providers, a tool-calling loop,
context compaction, checkpointing, resume, note-first retrieval, and an optional
reflection/judge layer for unattended work.

**Positioning: headless agent.** The product is an engine plus a
programmatic task entry point: a task enters, the agent runs its tool loop,
events leave the process, and the run can be resumed. It is not a UI and is
not designed for a person sitting in front of a terminal. `runToolLoop`
owns one agent task lifecycle: start, run, stop, resume, and stream events
through `onRound`, `onDelta`, `onToolCall`, `onUsage`, and `onEvent`.

The relationship with pi is complementary:

- **pi is an interactive agent**: human-in-the-loop, with TUI/subagent/MCP
  workflows.
- **erix is a headless agent**: unattended and scheduled by a host.

The boundary ends at one agent task lifecycle. Multi-role orchestration,
arbitration, retry scheduling, reapers, and task queues belong to the host
(`app_container` / `touwaka`), not to this library. Keeping that boundary
avoids turning a small runtime into a headless-agent platform and preserves
the zero-dependency design.

The CLI (`erix`) is a verifier and debugger, not the product:

- `erix chat` is a single-task entry point and can be used by a benchmark
  harness.
- `erix repl` is an interactive TUI and measures human-agent collaboration,
  not unattended autonomy.
- The intended unattended evaluation surface is the external
  **erix-bench** harness, which drives tasks in a container and compares
  `--agent erix|pi`.

The runtime also exposes extension surfaces for self-describing skills,
MCP integration, transcript stores, and host-provided task state. The
repository bundles the `notes` skill; the todo skill is an example under
`examples/skills/todo/`, not a built-in `runToolLoop` capability.

> **Security boundary:** the runtime does not enforce a security policy.
> The caller is responsible for safety. Running locally means giving the
> agent access to your local trust domain; embedded or sandboxed deployments
> must be isolated by the host. The CLI tools intentionally allow arbitrary
> file paths and shell commands and do not add an allowlist or confirmation
> prompt.

The project is intended for integrations including `app_container` (PI Agent
audit/development paths) and `touwaka` (AgentLoop/conversation paths). Those
host integrations are outside this package's lifecycle boundary.

## Quickstart

Install from npm (Node 22+):

```bash
npm i erix-agent
```

Minimal tool loop — the runtime owns one task lifecycle; you own the tools
and the safety policy:

```js
import {
  createOpenAIProvider,
  createMemoryTranscriptStore,
  runToolLoop,
} from "erix-agent";

const provider = createOpenAIProvider({
  endpoint: "https://your-relay.example.com/v1", // any OpenAI-compatible endpoint
  apiKey: process.env.LLM_API_KEY,
  model: "your-model",
});

const result = await runToolLoop({
  provider,
  system: "You are a coding assistant. Inspect with tools, then answer.",
  initialUserMessage: "List the JavaScript files in ./src and count their total lines.",
  tools: [{
    name: "exec",
    description: "Run a read-only shell command, returns stdout+stderr",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  }],
  executeTool: async ({ name, input }) => {
    // your execution + safety policy (the library never executes anything)
  },
  maxRounds: 16,
  store: createMemoryTranscriptStore(),
  runId: "demo-001",
});

console.log(result.finalText);            // final answer
console.log(result.rounds, result.usage); // run statistics
```

Or drive it from the CLI (reads `~/.erix/config.json`, see
[Configuration](#configuration-and-local-state)):

```bash
erix chat "Count the lines of code in this project" --max-rounds 32
```

## Why a unified headless agent?

Several in-house projects and vibe-coded prototypes need LLM capability, and
their authors are not necessarily fluent in prompting, context engineering,
tool calling, structured output, retries or cost control. Wiring each one
straight to a provider reproduces the same defects everywhere: inconsistent
call conventions, poorly shaped context, wasted tokens, flaky tool calls,
thin error handling, unpredictable agent behaviour. A shared headless runtime
exists so that application code depends on one stable programmatic interface
instead of re-solving the engineering underneath it.

| Requirement | Provided by this runtime | Owned by the host |
|---|---|---|
| Lower the barrier to LLM use | `runToolLoop` as the single entry point; dual-protocol providers; canonical message model; compaction; checkpoint/resume; classified errors | product-level prompt and workflow design |
| Centralised model configuration and run policy | duck-typed `ModelConfigProvider.resolve(slot)` with `static` / `env` / `json-file` adapters, per-slot models, `apiKey`/`apiKeyEnv`/`apiKeyFile` indirection, budget derivation | the configuration store itself (database or config centre), project and tenant quotas, fallback policy, prompt and agent versions |
| Traceable calls, cost analysis and audit | event stream (`onRound` / `onDelta` / `onToolCall` / `onUsage` / `onJudge` / `onEvent`), token accounting, `TranscriptStore` persistence, stable run ids, and checkpoints | log and cost storage, dashboards, retention, audit process |
| One tool, permission and safety boundary | a single execution entry (`executeTool`), an executor registry that data cannot extend, schema intersection, and note-first retrieval through `note_list` → `note_read` | the policy itself: which project may run which agent, which tools, which operations need confirmation, network and write access, rate and time limits |
| Contain third-party framework churn | zero runtime dependencies and an owned implementation, a stable exported surface plus `erix-agent/contract-tests` for consumers | — |
| Accumulate reusable agent engineering | canonical message and tool formats, ADR-tracked decisions, contract tests, benchmark harness | — |

Two boundaries keep this honest. The runtime **executes no policy** — it
exposes the hooks and the host decides
([ADR-009](docs/decisions/009-safety-layering.md)). And it **owns exactly one
task lifecycle** — queues, arbitration and retry scheduling stay with the host
([ADR-012](docs/decisions/012-engine-truth-model-efficiency-host-policy.md)).

## Why build our own?

The project research conclusion (2026-08-29; see the research index below)
is that the important gap is not another provider adapter:

- **Vercel AI SDK** (`ai` v7) has mature provider and tool-loop support, but
  context compaction is explicitly left to the application (the official
  cookbook uses `prepareStep` for application code). The most valuable part
  of this runtime would still need to be built.
- **LangChain.js / Mastra / LangGraph** provide framework-level abstractions,
  while both named host projects intentionally avoid taking a framework
  dependency.
- **oneringai and similar full stacks** have the wrong shape: heavy
  dependencies and unrelated audio/image capabilities.
- **pi SDK** is an interactive agent. Its human-in-the-loop shape is
  complementary to erix's headless lifecycle rather than a replacement for
  it.

The trigger for replacing this implementation (for example, adding a third
non-OpenAI-compatible protocol) and the project's stop-loss line are internal
decisions; they are not runtime capabilities.

## Module map

The public entry point is `src/index.js`; the complete current source tree is:

```text
src/
  index.js                         Public exports
  loop.js                          Thin re-export shim (runToolLoop lives in loop/)
  assembly.js                      AssemblyPort validation (host boundary)
  run-state.js                     Bounded deterministic and semantic run state
  tokens.js                        Conservative token estimation
  loop/                            # orchestration core
    orchestrator.js                runToolLoop main loop
    provider-runner.js             Provider call, retry, and snapshot rollback
    checkpoint-executor.js         Pre/post tool checkpoints and aggregate gate
    budget.js                      Budget validation and state cloning helpers
    aggregate-budget.js            Per-round aggregate output gate
    tool-result-ttl.js             Request-view TTL folding for old tool results
    termination.js                 Termination reason classification
    resume-manager.js              Resume restore and run-state application
    error-ledger.js                Repeated-error accounting
    messages.js                    Message/block helpers
    reflection.js                  Reflection prompts and decision parsing
    task-brief.js                  Task brief selection
    abort.js                       Abort-signal helpers
    block-helpers.js               Block access helpers
  providers/
    anthropic.js                   Anthropic provider and streaming
    errors.js                      Provider errors and classification
    openai.js                      OpenAI-compatible provider and streaming
    payload.js                     Provider payload and timeout options
    timeout.js                     Provider timeout handling
  messages/
    anthropic.js                   Anthropic protocol conversion and stream assembly
    canonical.js                   Canonical message/tool conversion
    openai-normalization.js        OpenAI-compatible normalization primitives
    rounds.js                      Message validation and round grouping
  compact/
    budget.js                      Context-budget calculation
    enforce-size.js                Field-size enforcement
    fold-llm.js                    LLM-assisted folding strategy
    fold-statistical.js            Statistical folding and navigation records
    anchors.js                     Mechanical anchor extraction (paths/SHAs/issues/URLs/errors)
    fold-fidelity.js               Verbatim user-input quotes and reverse-signal detection
    helpers.js                     Shared folding, protection, stub, and hook helpers
    sliding-window.js              Sliding-window folding strategy
  store/
    file.js                        JSONL transcript, checkpoint, and state store
    memory.js                      In-process transcript, checkpoint, and state store
    notes.js                       Host-side notes store
  config/
    api-key.js                     API-key materialization
    env.js                         Environment-backed model configuration
    json-file.js                   JSON-file model configuration
    static.js                      Static model configuration
  reflection/
    governor.js                    Deterministic round governance
    judge.js                       Objective timeline and judge prompt/response parsing
    l0.js                          Objective facts and summary parsing
    wrapup.js                      Wrap-up protocol parsing and normalization
  tools/
    index.js                       Optional tools subpath exports
    providers.js                   Tool-provider adapters
    registry.js                    Tool schemas and executor registry
```

`src/index.js` exports the providers, canonical message conversions, token
and compaction helpers, transcript stores, run-state helpers, configuration
providers, `runToolLoop`, and reflection helpers. The optional
`erix-agent/tools` subpath exports the tool registry and provider helpers;
model-facing retrieval is note-first (`note_list` → `note_read`).

## Host ports and the error ledger

Four adapter ports are validated once at the composition boundary; the rest of
the host boundary is passed as explicit `runToolLoop` options:

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider: { resolve(slot) }
  provider,    // { chat?, chatStream? }
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // optional TranscriptStore (eight methods)
  session: { id, resume?, initialMessages? },
  policy?,     // explicit runToolLoop options; unknown keys are rejected
  emit?,       // (eventType, payload) => void
});
```

`NotesStore` is a CLI-side engine skill (cross-run memory). Its write contract
lives in [docs/host-consumer-contract.md](docs/host-consumer-contract.md);
the engine never inspects notes, it only exposes the injected
`reportPersistenceFailure` bridge so host ports produce the same event and bill
shapes as the transcript path.

Persistence failures are never silent. Every `runToolLoop` result carries
`unpersisted: Entry[]` (deduplicated, message-capped at 500 characters) and
`completionErrors: []`; the same bill is mirrored into the deterministic run
state, and a thrown persistence failure carries it as `error.unpersisted`. A
diagnostics sink that itself throws is recorded as a `delivery_failure` entry
instead of disappearing.

## Reusable normalization primitives

The package root exports protocol normalization helpers for hosts that own
their provider transport. They are pure functions with no network or model
calls:

| Export | Signature | Semantics |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | `null`/`undefined` return `undefined`; other input returns `{ input_tokens?, output_tokens? }` built from `prompt_tokens`/`completion_tokens` (so `{}`, arrays, or strings yield `{}`). Canonical aliases are **not** accepted. |
| `normalizeOpenAIStopReason` | `(reason, fallback = "unknown") -> string` | Maps OpenAI finish reasons to canonical `end_turn`, `tool_use`, or `max_tokens`; unknown values pass through. |
| `parseOpenAIToolArguments` | `(rawArguments) -> any` | Parses JSON, defaults missing arguments to `{}`, and preserves invalid input in `_truncatedArguments`/`_raw` instead of throwing. |
| `createOpenAIStreamAccumulator` | `() -> accumulator` | Accumulates indexed OpenAI tool-call deltas; `getToolUseBlocks()` returns canonical tool-use blocks and malformed JSON follows `parseOpenAIToolArguments`. |

The OpenAI provider and `openAIResponseToCanonical` use these same helpers,
so host adapters do not need to maintain a second normalization
implementation. The stream accumulator also accepts the callback form
`{ index, id, name, argumentsDelta }`; its `addFunctionCallDelta` method
handles legacy `function_call` streams.

## Engineering constraints

- Zero runtime npm dependencies, pure ESM, Node 22+, and no build step.
- Tests use `node --test`; type information is expressed with JSDoc typedefs.
- The package is published as `erix-agent` on npm and hosted at
  `ErixWong/erix-agent` on GitHub.
- Never commit tokens, API keys, or other credentials.

The published package currently has version `0.9.0` in `package.json`. Its
declared `files` are:

```json
["src", "bin", "skills", "README.md", "README_cn.md", "CHANGELOG.md",
 "docs/host-consumer-contract.md", "docs/host-upgrade-guide-0.6.0.md",
 "test/contract/assembly-port.js", "test/contract/execute-tool.js",
 "test/contract/index.js", "test/contract/model-config-provider.js",
 "test/contract/notes-store.js", "test/contract/transcript-store.js",
 "LICENSE"]
```

Its public `exports` are:

```json
{
  ".": "./src/index.js",
  "./tools": "./src/tools/index.js",
  "./contract-tests": "./test/contract/index.js"
}
```

## `runToolLoop` API

The core entry point is:

```js
runToolLoop({ provider, executeTool, ...options })
```

It owns one task lifecycle and returns `finalText`, the current `messages`
and `transcript`, `rounds`, `truncated`, `termination`, `verification`,
optional `runState`, aggregate `usage`, and `compactionStats`.

### Completion, retries, and termination

- `completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`. When
  enabled, completion signals and consecutive no-tool rounds can stop a
  task. `completion: false` disables that completion layer.
- `retry` defaults to `false`. An object enables retries for provider errors
  classified as retryable; with `retry: {}` the default is two retries after
  the initial attempt. `backoffBaseMs` defaults to `1500` and
  `backoffMaxMs` to `10000`.
- A present assistant message with no text, tool call, or reasoning blocks is
  retryable. The CLI reads `ERIX_RETRY_ATTEMPTS` (default `2`) for this retry
  policy.
- `maxRounds` defaults to `8` in the library. The CLI supplies its own
  command-specific defaults.
- `maxTokenContinuations` defaults to `3`. A response ending in
  `max_tokens` can be continued up to that many times; exhaustion produces
  `termination.reason === "continuation_exhausted"`.
- `stallDetection` defaults to `{ window: 4 }`. The default mode is
  `appear`, which detects a repeated tool signature anywhere in the window;
  `mode: "consecutive"` requires the whole window to match. Pass
  `stallDetection: false` to disable it.
- `resume` defaults to `false`. With a `store` and `runId`, `resume: true`
  restores the transcript, run state, latest checkpoint, and all pending
  tool calls that still need execution. Checkpoint stores with both a writer
  (`saveCheckpoint` or `appendCheckpoint`) and `loadLatestCheckpoint` fail
  closed when a pre-execution or post-execution checkpoint cannot be
  persisted. The host's `executeTool` must still be idempotent by tool id;
  the loop cannot guarantee exactly-once external side effects.

The normal termination vocabulary is:

```text
end_turn
no_tool
stall
max_rounds_cap
reflection_stop
judge_done
continuation_exhausted
final_guard_unverified
aborted
failed
```

`aborted` and `failed` are also attached to thrown errors when the loop
cannot return a normal result.

### Final guard and wrap-up

- `finalGuard` is optional. Before a normal stop (`end_turn`, `no_tool`,
  `judge_done`, completion, or a non-continuable cap), it receives
  `{ finalText, findings, messages, round, rounds, signal, termination }`,
  where `findings` is the completion envelope's declared `label -> exact
  value` map (the authoritative carrier for verifiable claims; the guard
  does not parse free prose).
  It can return `{ action: "accept" }`, `{ action: "skip", reason }`, or
  `{ action: "revise", message }`.
- `finalGuardMaxRetries` defaults to `2`; `finalGuardTimeoutMs` defaults to
  `30000`. A revise decision injects the returned `message` as a user
  message and continues while retries remain. A revise decision on a
  non-continuable stop, or after retries are exhausted, returns
  `termination.reason === "final_guard_unverified"` with
  `verification.status === "unverified"`. A guard error or an explicit skip
  keeps the original termination reason.
  Guard errors and timeouts are reported as `verification.status ===
  "error"` and fail open for availability, but the text is not verified.
  Without a guard, verification is `skipped` with reason `no_final_guard`.
- `wrapup` defaults to `true`. With it enabled, the loop can interpret the
  top-level JSON protocol
  `{"done":true,"summary":"...","output":"..."}` at `end_turn`. Passing
  `wrapup: false`, or setting `ERIX_NO_WRAPUP_INSTRUCTION=1`, disables the
  instruction, JSON parsing, `finalText` replacement, and LLM
  normalization together.

Only `verification.status === "verified"` means that a final text passed a
guard. `skipped` means that no verification was performed or no comparable
capture existed; it is not a positive correctness result. The CLI therefore
uses a distinct exit code (`4`) for `skipped`, so callers cannot mistake
"not checked" for "checked and passed". Verification covers the values
declared in `findings`; statements that never enter `findings` are not
checked.

### Reflection and judge governance

When `reflection` is omitted, the library enables the basic judge
automatically for `maxRounds >= 16` (`DEFAULT_REFLECTION_MIN_ROUNDS`),
unless `ERIX_NO_REFLECTION=1` is set. Pass `reflection: false` to disable
it. The CLI reuses the same constant in `chat` (no separate threshold), so
the two defaults cannot drift apart; `repl` explicitly passes
`reflection: false`. The default extension step scales with the budget
(`max(8, maxRounds * 0.5)`), so a 16-round task is not extended by a fixed
+32 rounds. `ERIX_NO_ROUND_JUDGE=1` disables round judging
without disabling transparent interception.

The object form accepts:

```text
enabled
roundJudge
judgeIntercept
judgeIntervalRound
judgeInterceptTimeoutMs
judgeFailureLimit
extensionStep
maxExtensions
maxRoundsCap
format
wrapupNormalize
judge: { provider, evaluator }
onReflection
```

The defaults used by the loop are:

- `roundJudge` and `judgeIntercept` are enabled when reflection is enabled.
- `judgeFailureLimit` defaults to `3`; repeated round-judge failures then
  disable round judging for the remainder of the run.
- `judgeIntervalRound` is `10`; after that many real tool executions, the
  next tool call is independently audited before execution.
- `judgeInterceptTimeoutMs` is `30000`; an interception timeout or judge
  failure degrades to executing the original tool.
- At `nearLimit` (`budgetRounds >= floor(effectiveMaxRounds * 0.8)`), both
  end-turn judging and the next interception audit receive the current budget
  and extension count. The judge must additionally return `extend`,
  `extendReason`, and `plan`. An allowed `extend: true` decision increases
  the effective budget; `extend: false` nudges the model to converge.
- `extensionStep` defaults to `max(8, maxRounds * 0.5)`, `maxExtensions` to
  `2`, and `maxRoundsCap` to at least the initial `maxRounds` and otherwise
  `256`.
- A round judge can stop only with `done: true` and `confidence >= 0.7`.
  A `done: false` decision injects a continuation/nudge; near the limit,
  `extend: true` can instead extend the budget and `direction: "off_track"`
  turns that continuation into a change-of-approach instruction.
- Wrap-up LLM normalization is off by default; enable
  `wrapupNormalize: true` or `ERIX_WRAPUP_NORMALIZE=1`.

Judge interception uses a 6,000-token conversation budget; round-judge output
is capped at 1,024 tokens with `reasoning_effort: "none"`, and raw judge output
is written to `judge.log`. The final budget round forces a no-tools request.

`onJudge` receives round and interception decisions, including `judge_done`,
`nudge`, `continue`, `executed`, `blocked`, and `degraded` actions. The loop
does not treat a judge as a host-level completion certificate; hosts still
decide whether to consume the result.

### Tools, context, stores, and compaction

- `executeTool` receives one structured object
  `({ id, name, input, context, signal })`. Canonical results are `string`,
  `{ content, metadata?, success? }`, or `Error`. Legacy duck-typed results,
  including `{ data, success, ... }`, are normalized for compatibility but
  deprecated.
- `context` is optional and defaults to `undefined`; when supplied, it
  accepts `strategy`, `budgetTokens`, `keepRounds`, `toolContext`, and
  `task`. When `budgetTokens` is absent, the loop derives it from
  `contextWindowTokens` and `maxOutputTokens` found in `modelConfig`,
  `modelMetadata`, `model`, `provider`, or `context`. Compaction keeps six
  rounds by default when a strategy is active. A task brief takes precedence
  in this order: explicit `task`, `context.task`, then the last user message
  in the entry transcript.
- Compaction supports `summaryRole`, `recoveryHint`, `protectedMessage`,
  `stripHistoricalImages`, `onBeforeFold`, `onAfterFold`, and `stubFor`.
  Protected messages can be downgraded if the protected set itself cannot
  fit the budget; the result records `compactionStats[].protectedDowngraded`.
  A single protected message that cannot fit produces `invalid_budget`.
- A `stubFor(message)` hook can retain a bounded, non-secret stub for folded
  tool results (all of them, not a marked subset — ADR-016). The CLI's stub is
  limited to 200 characters and at most three safe `label=value` facts. Fold
  navigation records are address-only records of the form
  `{ roundFrom, roundTo, artifacts: [{ id, locator, digest, status }] }`,
  bounded to at most 10 artifacts and 400 characters. They are not semantic
  search or provenance proof.
- Tool-result TTL folding is separate from context compaction. It changes only
  the provider request view; checkpoints retain full tool-result text.
  `toolResultTtl` defaults to `2` rounds (`0` disables it), and
  `toolResultFoldMinTokens` defaults to `4000` estimated tokens. The warning
  round at `age === ttl - 1` asks the model to use `note_take`; folded
  placeholders contain a navigation digest and, for suitable JSON, a JSON
  skeleton. `note_*`, todo, error, and explicitly protected results are not
  folded.
- `writeToolNames` defaults to `["writeFile"]`; custom write tools must be
  named explicitly. `writeToolPathKeys` defaults to `["path", "file_path"]`.
  The judge's `filesWritten` footprint does not infer arbitrary write tools
  from their names.
- `TranscriptStore` implementations provide idempotent `appendRound` plus
  eight persistence methods for checkpoints and run state. Pass
  `persistence: "none"` to explicitly disable all writes. Model-facing
  retrieval is note-first: use `note_list` then `note_read`; there is no
  transcript retrieval API; the former recall adapters were retired in 0.8.0.
- `runState` is deterministic, bounded, and replace-injected at compaction
  points. Stores can implement `markRunState`,
  `saveRunState`/`loadRunState`, `saveCheckpoint`/`appendCheckpoint`, and
  `loadLatestCheckpoint`. Persisted run state has a 64 KiB serialized hard
  limit plus entry and field limits; truncation is visible through
  `bounds.truncated`. `todoStateProvider` and `semanticStateProvider` are
  host-injected; semantic state is bounded and versioned, and stale versions
  are marked `stale`. Invalid or corrupted state is reported as
  `state_unavailable` on resume rather than silently treated as a fresh
  state.
- Provider-specific details remain explicit: `transport` is passed through to
  fetch as a `dispatcher` (or can enhance fetch options), malformed OpenAI
  tool arguments are exposed as `_truncatedArguments` with `_raw` as a
  compatibility alias, and unsafe run IDs map to
  `run-h-<sha256 first 24 hex characters>`.

### Callbacks and events

The loop callbacks are:

```text
onRound
onJudge
onToolResult
onPersistenceError
onObserverError
onDelta
onReasoningDelta
onToolCall
onUsage
onEvent
```

Streaming observers (`onDelta`, `onReasoningDelta`, `onToolCall`, and
`onUsage`) report through `onObserverError` when an observer throws.
Persistence failures use `onPersistenceError`. `onEvent` receives structured
events including `round_start`, `round_end`, `tool_use`, `tool_result`,
`attempt`, `recovering`, `recovered`, `delta`, `reasoning_delta`, `tool_call`,
`usage`, `forced_final`, and `final_guard`.

## CLI: `erix`

`erix` is the repository's validation/debugging front end. It is not the
headless runtime's product interface.

### Commands and flags

```text
erix --version, -v
erix --help, -h
erix chat "<prompt>" [--stream] [--tools <names>] [--reflection <on|off>] [--final-guard|--no-final-guard] [--no-notes] [--timeout <ms>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--judge-log <path>]
erix repl [--tools <names>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard]
erix skills [--skills-dir <path>]
erix mcp [--config <path>]
```

Running `erix` with no arguments enters `repl`. The `chat` flags are
implemented by `bin/cli.js`; the `repl` flags above are implemented by
`bin/repl.js`. In particular, `repl` does not implement `--stream`,
`--reflection`, `--timeout`, `--no-notes`, or `--judge-log`.

`chat` defaults to 64 rounds, a 300-second idle timeout, reflection enabled
at `max-rounds >= 16` (`DEFAULT_REFLECTION_MIN_ROUNDS`, shared with the
library), and the final guard disabled. `repl` defaults to 32 rounds, no idle
timeout, `reflection: false`, and completion after one no-tool round.

The shared CLI flags are:

- `--stream` streams model text in `chat`.
- `--session <id>` selects the session; without an explicit chat session,
  `chat` creates a unique ID derived from the working directory.
- `--dir <path>` selects the transcript directory; the `chat` default is
  `~/.erix/transcripts`.
- `--max-rounds <n>` sets the tool-loop round limit.
- `--reflection <on|off>` selects chat reflection behavior.
- `--final-guard` enables the CLI provenance guard;
  `--no-final-guard` is a compatibility no-op because the default is already
  off.
- `--no-notes` (or `ERIX_NO_NOTES=1`) skips the notes factory assembly and excludes the bundled notes skill (`note_*` tools become unavailable); other skills stay loaded.
- `--timeout <ms>` supplies a soft task deadline to `chat`; it nudges the
  loop toward wrap-up rather than hard-killing the process.
- `--idle-timeout <seconds>` aborts after no progress; it defaults to 300
  for `chat` and 0 (disabled) for `repl`.
- `--compact-budget <tokens>` overrides the automatic compaction budget.
- `--tools <comma-separated names>` is a hard capability whitelist for both
  `chat` and `repl`; unknown names warn, and an empty filtered set is an error.
- `--judge-log <path>` appends redacted round/interception judge decisions
  as JSONL in `chat`.

The built-in CLI tools are `readFile`, `rg`, `grep`, `tree`, `writeFile`, and
`exec`. `grep` is a pure-Node search tool with simple glob filename filtering,
directory skipping, per-line limits, and a hard result cap of 200. They
operate on arbitrary paths and commands. Tool outputs are retained in full by
checkpoints while TTL folding may reduce only the provider request view.
There is no replayability classification, rerun detection, or rerun notice: a
repeated command executes normally and returns its fresh output (ADR-016).
When an earlier exact value is needed, use the note-first sequence
`note_list` → `note_read` instead of relying on memory. The system prompt
instructs internal thinking in English and user-visible output in the user's
language.

The built-in `notes` tools provide `note_take`, `note_read`, `note_list`, and
`note_forget`. They are a run-scoped, pull-only convenience index for facts,
one-time values, decisions, and artifact references; they are not a per-round
log. Headless hosts can assemble them with `createBuiltinNotesTools` from the
package root or `erix-agent/tools`; the factory returns the canonical 6-key API
(`definitions`, dual executor views `executors` / structured `executeTool`,
`resolveTools`, run lifecycle hooks `lifecycle.onRunStart` janitor /
`lifecycle.onRunComplete` completeRun+janitor, and the ADR-015 fold-point
`semanticStateProvider`) — all bound to one run scope and one `NotesStore`
instance. Hosts that need a `ToolProvider` shape can build one from
`createStaticToolProvider({ sets: { default: notes.definitions } })`. The CLI
retired the bundled `skills/notes/skill.mjs` compatibility shim in v0.11.0
(issue #61): notes are always assembled through the factory and `erix skills`
no longer lists a bundled notes skill; user and project skills can still be
supplied from `~/.erix/skills/`, the project `.erix/skills/`, or
`--skills-dir <path>`. `erix skills` lists discovered skills.

MCP uses standard `.mcp.json` configuration and supports both stdio and HTTP
servers. The `mcp` proxy exposes `list`, `search`, `call`, and `status`
actions. `erix mcp` lists configured servers and their connection status.

### Configuration and local state

The CLI reads model configuration from
`$XDG_CONFIG_HOME/erix/config.json` or `~/.erix/config.json`; `--config
<path>` overrides that location, and environment variables take precedence.
The required model inputs are `LLM_KIT_ENDPOINT`, `LLM_KIT_API_KEY`, and a
model from `LLM_KIT_MODEL`, `ERIX_DEFAULT_MODEL`, or
`slots.default.model`. `slots.default.maxOutputTokens` defaults to `16384`;
`slots.default.contextWindowTokens` enables automatic compaction, and
`--compact-budget` overrides its computed budget.

MCP configuration is read from the current directory's `.mcp.json` or
`~/.erix/mcp.json`. The main local layout is:

```text
~/.erix/
  config.json
  mcp.json
  transcripts/
    <safeRunId>.jsonl
    <safeRunId>.checkpoint.json
    <safeRunId>.state.json
  <session>.json                 REPL session snapshot
  notes/run/<safeRunId>/         NotesStore data
  skills/                        user skills
  todos/                         used by the example todo skill
```

`ERIX_NOTES_DIR` changes the notes root. Both CLI modes honor
`ERIX_EXEC_TIMEOUT_MS` and `ERIX_FINAL_GUARD`; `chat` additionally honors
`ERIX_NO_TOOL_ROUNDS`, `ERIX_MAX_ROUNDS`, `ERIX_REFLECTION`,
`ERIX_NO_REFLECTION`, `ERIX_NO_NOTES`, `ERIX_RETRY_ATTEMPTS`,
`ERIX_TOOL_RESULT_TTL`, `ERIX_TOOL_RESULT_FOLD_MIN_TOKENS`, and
`ERIX_JUDGE_LOG`. The
library-level controls
`ERIX_NO_WRAPUP_INSTRUCTION`, `ERIX_NO_FORCED_FINAL`, and
`ERIX_STALL_MODE` are also honored by the relevant loop behavior;
`ERIX_WRAPUP_NORMALIZE=1` enables wrap-up LLM normalization.

## Documentation

- [docs/requirements.md](docs/requirements.md) - requirements and stages
- [docs/architecture.md](docs/architecture.md) - API contracts and data flow
- [docs/decisions/](docs/decisions/) - design decisions, including
  configuration, storage, compaction, reflection, tools, skills, safety,
  judge direction, engine/model/host boundaries, and guard policy
- [docs/testing.md](docs/testing.md) - test strategy and behavior metrics
- [docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md) - 0.6.0
  breaking-window migration steps
- [docs/host-consumer-contract.md](docs/host-consumer-contract.md) - host
  consumer contract for verification, note-first retrieval, provenance, and reruns
- [docs/host-upgrade-guide-v030.md](docs/host-upgrade-guide-v030.md) - host
  upgrade guidance for `touwaka` / `app_container` and v0.3.x behavior
- [docs/maintenance-policy.md](docs/maintenance-policy.md) - maintenance
  policy and internal replacement/stop-loss criteria
- [docs/research/](docs/research/) - research reports (Chinese only)
- [docs/design/](docs/design/) - design and RFC material (Chinese only)
- [docs/tasks/](docs/tasks/) - active task documents (Chinese only)

## Status and version history

The current package version is **v0.9.0**. The 0.6.0 migration steps remain in
[docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md); the
complete history lives in [CHANGELOG.md](CHANGELOG.md).

- **v0.9.0 (2026-09-22)**: extension decisions move to the judge — at
  `nearLimit` the end-turn judge and the interception audit must return
  `extend`/`extendReason`/`plan`; an approved `extend: true` raises the
  effective round budget (the interception path closes the
  model-never-ends-a-turn blind spot). The legacy nearLimit reflection path
  is removed, so `reflection.triggerRound` is gone and `reflection_stop` has
  no current trigger path. Long tasks no longer hit `max_rounds_cap`
  un-evaluated.
- **v0.8.0 (2026-09-21)**: retires the recall adapters and bounded
  transcript retrieval; model-facing retrieval is note-first
  (`note_list` → `note_read`). Adds request-view tool-result TTL folding,
  retryable empty assistant messages, CLI tool whitelists, the pure-Node
  `grep` tool, and language-aware output instructions.
- **v0.7.0 (2026-09-19)**: per-round aggregate output budget, fold-summary
  anchors (paths/SHAs/URLs mechanically preserved), head+tail CLI exec
  truncation, interception interval 5→10 with on-track pass-through, stall
  detection default `consecutive`, and resume round-budget semantics
  (identity rounds vs per-run `budgetRounds`).

The host migration and benchmark work described by the project is ongoing
integration work, not a promise that a future host or sandbox component is
already released in this package.

## Release validation

The repository's release process uses real relay E2E tests when
`LLM_KIT_E2E=1`:

```bash
LLM_KIT_E2E=1 node --test examples/*.test.mjs
```

The tests require a configured model. The model is resolved from
`slots.default.model`, `LLM_KIT_MODEL`, or `ERIX_DEFAULT_MODEL`; an absent
configuration fails instead of silently selecting another model. The release
record should identify the actual model used.

The notes experiment scripts likewise take the model from `--model`,
`ERIX_EXPERIMENT_MODEL`, or `--config`/`~/.erix/config.json` in that order.
They provide a cost preview, default to dry-run without `--yes`, default to
`--max-calls 40`, and stop immediately on a failed model call rather than
switching models.

## Benchmark validation (erix-bench / Terminal-Bench archive)

The project reports headless harness results for Terminal-Bench archive tasks
using a container driver and the official grader, with `--agent erix|pi`
comparisons. The full per-run report is maintained in the companion
erix-bench repository; the figures below are the README's recorded results,
not a claim that this repository runs those tasks automatically.

### Passing tasks (reward=1, by model)

- `historical-model`: **34 passing tasks** across a broad task mix
  (`bn-fit-modify`, `break-filter-js-from-html`, `build-cython-ext`,
  `crack-7z-hash`, `fix-git`, `git-multibranch`, `prove-plus-comm`,
  `sqlite-db-truncate`, …).
- `historical-model-2` (recent difficult-task and recovery sample):
  **11 passing tasks** (`adaptive-rejection-sampler`, `chess-best-move`,
  `code-from-image`, `db-wal-recovery`, `fix-code-vulnerability`,
  `password-recovery`, …).
- `pi` comparison on the same `historical-model-2` sample: **4 passing
  tasks** (`break-filter-js-from-html`, `build-cython-ext`,
  `build-pov-ray`, `distribution-search`).

The two `historical-model` totals are not directly comparable: the first has
more runs and a broader task mix, while the second emphasizes difficult and
recovery tasks. The full per-task lists live in the erix-bench repository.

### Transparent interception and judge evidence

The recorded 2026-09 evidence for `erix main + PR #28/#29` describes
long-running headless tasks under transparent interception, round judge,
stall correction, and direction hints. Judge decisions were written to
`erix-state/judge.log` for audit:

| Task | Result | Reported judge evidence |
|---|---|---|
| db-wal-recovery | reward=1 (88s; historical 721s failure) | `direction: off_track` interception redirected a reconnaissance-only route toward repair |
| adaptive-rejection-sampler | reward=1 (12 rounds; historical 901s timeout) | Early judge interception prevented environment spinning |
| password-recovery | reward=1 (187s, flash first run) | **5 blocked** decisions stopped repeated partial submissions without the complete password |
| fix-code-vulnerability | reward=1 (123s, grader 6/6) | Round judge allowed wrap-up only after a positive completion assessment |
| cancel-async-tasks | reward=1 (117s) | Judge logging and transparent approval observed an on-track route |
| circuit-fibsqrt | reward=0 (64 complete rounds) | 11 real interception records; the report attributes the failure to model capability rather than the mechanism |

These benchmark figures are historical project evidence and are not an API
guarantee. The judge design decision is documented in
[ADR-011](docs/decisions/011-judge-direction.md).

## License

MIT © 2026 ErixWong (see [LICENSE](LICENSE)).
