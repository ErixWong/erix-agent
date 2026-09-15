# Architecture and Interface Contract - erix-agent

> Chinese version: [architecture_cn.md](architecture_cn.md)

## 1. Data flow overview

```text
Caller                         erix-agent                         LLM API
  |                               |                                  |
  |  system / initial messages    |                                  |
  |  tools / executeTool          |                                  |
  |  provider / TranscriptStore   |                                  |
  |-------------- runToolLoop --->|                                  |
  |                               |-- compact before a round        |
  |                               |-- provider.chat or chatStream -->|
  |                               |<-- canonical response ----------|
  |                               |-- tool_use -> executeTool ------>| Caller-owned code
  |                               |<-- tool_result ------------------|
  |                               |-- completion / stall / judge     |
  |                               |-- checkpoint and round archive  |
  |<------------- result ---------|                                  |
```

The runtime owns one task lifecycle: start, execute, stop, resume, and emit
events. Tool implementations, persistence, and model transport remain explicit
injection points. `provider` performs model I/O, `store` performs persistence
when supplied, and `executeTool` is the host's tool boundary; the loop does not
discover or implement tools by itself.

The CLI may add its own output-archive behavior around tool execution. That is
outside the library contract and is not performed by `runToolLoop`.

## 2. Canonical message model

The runtime uses one internal block format. The OpenAI and Anthropic adapters
convert to and from their protocol-native representations.

```js
/**
 * @typedef {(
 *   {type:"text", text:string} |
 *   {type:"image", url?:string, base64?:string, mediaType?:string, [key:string]:any} |
 *   {type:"reasoning", text:string, [key:string]:any} |
 *   {type:"tool_use", id:string, name:string, input:object, [key:string]:any} |
 *   {type:"tool_result", tool_use_id:string, content:string, is_error?:boolean, [key:string]:any} |
 *   {type:"raw", protocol:string, payload:any}
 * )} Block
 *
 * @typedef {Object} CanonicalMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string|Block[]} content
 *
 * @typedef {Object} ToolSchema
 * @property {string} name
 * @property {string} [description]
 * @property {object} inputSchema
 *
 * @typedef {Object} ChatResponse
 * @property {Block[]} content
 * @property {string} stopReason
 * @property {{input_tokens?:number, output_tokens?:number}} [usage]
 */
```

`validateMessages` enforces the canonical message rules:

- Roles are limited to `system`, `user`, and `assistant`; system messages must
  precede conversation messages.
- `tool_use` blocks are legal only in `assistant` messages, and `tool_result`
  blocks are legal only in `user` messages.
- An assistant message containing tool calls must be followed immediately by a
  user message containing the matching tool results. Tool-use IDs must be
  non-empty, unique within the assistant message, and match the result IDs.

`groupIntoRounds` treats the system messages and the first real user message as
the immutable head. A round containing tool calls is the assistant message and
its immediately following user tool-result message; every other message is a
single-message round. This grouping is applied to canonical messages before
protocol-specific serialization.

## 3. Core interfaces

### 3.1 Providers

The package exports separate provider factories. There is no
`src/providers/index.js` and no exported generic `createProvider` factory.

```js
/**
 * @typedef {Object} LlmProvider
 * @property {(req: object) => Promise<ChatResponse>} chat
 * @property {(req: object) => Promise<ChatResponse>} chatStream
 * @property {string} model
 * @property {"openai"|"anthropic"} protocol
 */

createOpenAIProvider({
  endpoint,
  apiKey,
  model,
  model_name,
  fetchImpl = fetch,
  transport,
  protocol = "openai",
  timeoutMs,
  timeout,
  requestTimeoutMs,
  firstByteTimeoutMs,
  streamIdleTimeoutMs,
  streamTotalTimeoutMs,
  timeouts,
  clock,
  maxTokens,
  maxOutputTokens,
  temperature,
  topP,
  thinking,
  reasoning,
  reasoning_effort,
  enable_thinking,
  chat_template_kwargs,
  providerOptions,
  frequency_penalty,
  presence_penalty,
  response_format,
  model_type,
  supports_reasoning,
  thinking_format
}) => LlmProvider

createAnthropicProvider({
  endpoint,
  apiKey,
  model,
  model_name,
  fetchImpl = fetch,
  transport,
  protocol = "anthropic",
  timeoutMs,
  timeout,
  requestTimeoutMs,
  firstByteTimeoutMs,
  streamIdleTimeoutMs,
  streamTotalTimeoutMs,
  timeouts,
  clock,
  maxTokens,
  maxOutputTokens,
  temperature,
  topP,
  thinking,
  reasoning,
  reasoning_effort,
  enable_thinking,
  chat_template_kwargs,
  providerOptions,
  frequency_penalty,
  presence_penalty,
  response_format,
  model_type,
  supports_reasoning,
  thinking_format
}) => LlmProvider
```

The actual factories also accept the snake-case timeout aliases and the
provider-specific reasoning/payload fields implemented in
`src/providers/openai.js` and `src/providers/anthropic.js`. `model_name` is an
alias for `model`; `protocol` defaults to `"openai"` or `"anthropic"`
respectively. `endpoint`, `apiKey`, and the selected model must be non-empty
strings. The default request timeout is `120000` ms. Without explicit
phase-specific settings, streaming uses a `120000` ms first-byte timeout,
`120000` ms idle timeout, and `300000` ms total timeout. The legacy
`timeout`/`timeoutMs` setting remains one request-wide deadline.

`chatStream` emits optional `onDelta`, `onReasoningDelta`, `onToolCall`,
`onUsage`, and `onEvent` callbacks supplied on the request. The OpenAI adapter
uses chat/completions serialization and SSE parsing; the Anthropic adapter uses
Messages serialization and content-block SSE parsing. Both return
`ChatResponse` in canonical form.

Provider failures are represented by `KitError`. HTTP status classification
maps 408 to `timeout`, 429 to `rate_limited`, 401/403 to `auth`, 5xx to
`server`, and other statuses to `unknown`. Fetch and abort failures are
classified separately, and the error carries `retryable` plus available
status, phase, and elapsed-time metadata.

### 3.2 `runToolLoop`

`runToolLoop` is the single-task lifecycle entry point. Its current option
surface is:

```js
runToolLoop({
  provider,
  system,
  wrapup = true,
  initialUserMessage,
  initialMessages,
  tools = [],
  writeToolNames = ["writeFile"],
  writeToolPathKeys = ["path", "file_path"],
  executeTool,
  maxRounds = 8,
  maxTokens,
  temperature,
  topP,
  timeoutMs,
  deadlineMs,
  reflection,
  stallDetection = { window: 4 },
  retry = false,
  completion = { signals: [], maxNoToolRounds: 3 },
  finalGuard,
  finalGuardMaxRetries = 2,
  finalGuardTimeoutMs = 30000,
  maxTokenContinuations = 3,
  context,
  todoStateProvider,
  semanticStateProvider,
  modelConfig,
  modelMetadata,
  model,
  expert,
  user,
  task,
  session,
  requestId,
  toolContext,
  store,
  runId,
  runState,
  resume = false,
  onRound,
  onJudge,
  onToolResult,
  onPersistenceError,
  onObserverError,
  signal,
  stream = false,
  onDelta,
  onReasoningDelta,
  onToolCall,
  onUsage,
  onEvent,
}) => Promise<{
  finalText,
  messages,
  transcript,
  rounds,
  truncated,
  termination,
  verification,
  runState?,
  usage,
  compactionStats,
}>
```

`initialMessages` takes precedence over `initialUserMessage`. With `resume:
true`, the loop loads the transcript and checkpoint for `runId` and uses the
persisted messages and round state instead of the initial messages.

`executeTool` receives one structured execution object:

```js
({ id, name, input, context, signal }) =>
  Promise<string|{content:any, metadata?:object, success?:boolean}|Error>
```

The structured form receives the merged `toolContext` plus `expert`, `user`,
`task`, `session`, and `requestId` values. The loop adds execution metadata and
converts failed results to canonical `tool_result` blocks with `is_error`.
Legacy duck-typed results, including `{ data, success, ... }`, are normalized
for compatibility but deprecated.

`writeToolNames` is an explicit set used only for judge file-footprint
reporting; it does not infer write tools. For each configured write tool,
`writeToolPathKeys` supplies the priority order for extracting a path.

#### Completion, retries, and termination

- `retry` is opt-in. `false` or omission performs no provider retry. With an
  object, `attempts` defaults to `2` retries after the initial call,
  `backoffBaseMs` defaults to `1500`, `backoffMaxMs` defaults to `10000`, and
  `sleepImpl` defaults to the loop's abort-aware sleeper. Only errors marked
  `retryable` are retried.
- `completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`. A completion
  signal can stop a no-tool response, and after tool use the no-tool streak
  stops at `maxNoToolRounds`. `completion: false` disables this policy.
- `stallDetection` defaults to `{ window: 4 }` with mode `"appear"`. Mode
  `"consecutive"` requires the same tool signature throughout the window;
  `false` disables detection. `ERIX_STALL_MODE` can provide the mode unless
  the option is explicitly `false`.
- `maxTokenContinuations` defaults to `3`. A response ending with
  `stopReason === "max_tokens"` can therefore receive up to three continuation
  calls in the same round.
- `maxRounds` defaults to `8` and must be a positive safe integer. Normal
  termination reasons are `end_turn`, `no_tool`, `stall`, `max_rounds_cap`,
  `reflection_stop`, `judge_done`, and `continuation_exhausted`; aborts and
  uncaught failures use `aborted` and `failed`.

When enabled, `wrapup` appends the end-of-turn instruction requiring this JSON
shape:

```json
{"done":true,"summary":"Task summary","output":"Final result for the user"}
```

The parser requires `done` to be an own boolean property. `done: true` makes
the response complete and replaces `finalText` with `output` or `summary`;
`done: false` continues the loop. `wrapup: false`, or
`ERIX_NO_WRAPUP_INSTRUCTION=1`, disables instruction injection, JSON parsing,
`finalText` replacement, and wrap-up normalization together. Optional
normalization is enabled by `ERIX_WRAPUP_NORMALIZE=1` or
`reflection.wrapupNormalize === true`.

`finalGuard` is an optional host-supplied provenance or completion check:

```js
finalGuard({
  finalText,
  messages,
  round,
  rounds,
  signal,
  termination,
  rerunDetected,
}) => Promise<
  {action:"accept", rerunCited?:boolean} |
  {action:"skip", reason:string} |
  {action:"revise", message:string}
>
```

The default `finalGuardMaxRetries` is `2`. A positive
`finalGuardTimeoutMs` is used as-is; a non-positive or non-finite value uses
the default `30000` ms. The guard runs for non-abort stop paths including
`end_turn`, `no_tool`, `judge_done`, `max_rounds_cap`, `stall`,
`continuation_exhausted`, and `reflection_stop`. `accept` produces
`verification.status === "verified"`. `skip` produces `"skipped"`.
`revise` injects the returned message as a user message when the loop can
continue. If a non-continuable stop path cannot be revised, or the retry
limit is reached, the result is `"unverified"` with
`termination.reason === "final_guard_unverified"`. A guard error or timeout
returns the final text with `"error"` status; it is not treated as verified.
No configured guard produces `"skipped"` with reason `"no_final_guard"`.

The result shape is:

```js
{
  finalText,
  messages,
  transcript,
  rounds,
  truncated,
  termination: { reason, detail?, forcedFinal? },
  verification: {
    status: "verified" | "unverified" | "skipped" | "error",
    reason?,
    detail?,
    metrics: {
      verified, skipped, revised, rerun_cited, unverified, guard_error
    }
  },
  runState?,
  usage: { input_tokens, output_tokens },
  compactionStats: [{
    compacted,
    foldedRounds,
    tokensBefore,
    tokensAfter,
    protectedDowngraded?
  }]
}
```

`transcript` is the current in-memory message snapshot. The configured
`TranscriptStore` is the persistence/archive interface and is separate from
that return value.

#### Reflection and judge governance

If `reflection` is omitted, `maxRounds >= 16`, and
`ERIX_NO_REFLECTION` is not `1`, the loop enables `{ enabled: true }`
automatically. `reflection: false` disables it; `reflection: true` enables it
with the defaults below. An object can configure:

```js
reflection: {
  enabled,
  roundJudge = true,
  judgeIntercept = true,
  judgeIntervalRound = 5,
  judgeInterceptTimeoutMs = 30000,
  judgeFailureLimit = 3,
  triggerRound = Math.max(1, Math.floor(maxRounds * 0.8)),
  extensionStep = 32,
  maxExtensions = 2,
  maxRoundsCap = Math.max(maxRounds, 256),
  wrapupNormalize,
  judge: { provider, evaluator },
  onReflection,
}
```

`ERIX_NO_ROUND_JUDGE=1` disables the end-turn judge independently of tool
interception. The round judge evaluates an `end_turn` response with a separate
or shared provider. Only `done: true` with `confidence >= 0.7` yields
`judge_done`; `done: false` injects a corrective continuation message. Parse
failures and evaluator errors degrade to the normal governor, and the round
judge is disabled after `judgeFailureLimit` consecutive failures.

After `judgeIntervalRound` tool executions, the next tool call is transparently
audited. A `done: false` audit blocks the original execution and returns an
audit result to the model. Audit errors and timeouts degrade to direct
execution. A judge result with `direction: "off_track"` does not block the
tool; it adds a direction hint to the next model context. `onJudge` receives
round and interception decisions, including degraded decisions.

The governor is deterministic and side-effect free. It handles repeated
errors, memory-loss responses, no-tool streaks, stall streaks, time
deadlines, reflection extensions, and completion. Reflection extensions add
`extensionStep` rounds up to `maxRoundsCap`, at most `maxExtensions` times.
The task brief used by judge and reflection is selected in this order:
`task`, `context.task`, then the latest user text in the entry transcript.

### 3.3 Compaction

```js
/**
 * @typedef {Object} CompactionStrategy
 * @property {string} name
 * @property {(messages: CanonicalMessage[], budgetTokens: number) => boolean} shouldCompact
 * @property {(messages: CanonicalMessage[], options?: object) => Promise<CompactResult>} compact
 *
 * @typedef {Object} CompactResult
 * @property {CanonicalMessage[]} messages
 * @property {boolean} compacted
 * @property {number} foldedRounds
 * @property {number} tokensBefore
 * @property {number} tokensAfter
 * @property {CanonicalMessage[]} [foldedPayload]
 * @property {{from:number,to:number}} [foldedRoundRange]
 * @property {object} [navigationRecord]
 */
```

The `context` option accepts `strategy`, `budgetTokens`, `keepRounds`,
`toolContext`, and `task`. Strategy options forwarded by the loop include
`summaryRole` (default `"user"`), `recoveryHint`, `protectedMessage`,
`stripHistoricalImages` (default `false`), `onBeforeFold`, `onAfterFold`, and
`stubFor`. `keepRounds` defaults to `6`. If no `context` or budget is
configured, the loop does not compact. If a budget is configured without a
strategy, the loop uses the sliding-window fallback when the budget is
exceeded.

```js
computeBudget({ contextWindowTokens, maxOutputTokens }) => number
```

`computeBudget` subtracts `maxOutputTokens` and safety headroom from
`contextWindowTokens`; headroom is the greater of `2000` tokens and 10% of
the context window, rounded up. Both inputs must be safe integer token counts,
and the resulting budget must be positive.

The built-in strategies are:

```js
createSlidingWindowStrategy(options = {})
createFoldStatisticalStrategy(options = {})
createFoldLlmStrategy({
  summarizer,
  maxSummaryTokens = 800,
  ...options
})
```

All three group and remove complete rounds. `fold-statistical` records a
deterministic tool footprint, folded stubs, and bounded artifact navigation
records. `fold-llm` calls the injected `summarizer` with the folded payload and
enforces the summary size deterministically with `enforceSize`. Both folding
strategies retain `foldedPayload` for archival recovery.

When a configured strategy still leaves the request over budget, the loop first
falls back to a zero-keep sliding window and then uses deterministic safe
truncation. That final fallback can trim unprotected fields, remove images,
clear tool inputs, and downgrade protected messages as needed;
`compactionStats[].protectedDowngraded` records such downgrades. A single
protected message that cannot fit produces `KitError("invalid_budget", ...)`.

### 3.4 Model configuration providers

```js
createStaticModelConfigProvider(configOrSlots)
createEnvModelConfigProvider(prefix = "LLM_KIT_")
createJsonFileModelConfigProvider({ path })
resolveApiKey(config = {})
```

`createStaticModelConfigProvider` accepts one config object or
`{ slots: { default, ... } }`. Its `resolve(slot = "default")` selects the
requested slot, falling back to `default`. The JSON-file provider requires a
JSON object with a `slots` object and uses the same slot fallback. The
environment provider reads one config from the supplied prefix and ignores the
slot argument.

`resolveApiKey` checks `apiKey`, then the environment variable named by
`apiKeyEnv`, then the file named by `apiKeyFile`. A readable credential file is
warned about when group/other-readable, but is not rejected. The resolved
configuration is passed to a provider factory by the host.

### 3.5 `TranscriptStore`

```js
/**
 * @typedef {Object} TranscriptStore
 * @property {(runId:string, record:object) => Promise<void>} appendRound
 * @property {(runId:string) => Promise<object[]>} load
 * @property {(runId:string, fromRound?:number, toRound?:number, pattern?:string) => Promise<string|object>} recall
 * @property {(runId:string, state:string) => Promise<void>} markRunState
 * @property {(runId:string, state:object) => Promise<void>} saveRunState
 * @property {(runId:string) => Promise<object|undefined>} loadRunState
 * @property {(runId:string, checkpoint:object) => Promise<void>} saveCheckpoint
 * @property {(runId:string, checkpoint:object) => Promise<void>} appendCheckpoint
 * @property {(runId:string) => Promise<object|undefined>} loadLatestCheckpoint
 */
```

The memory implementation is a cloned in-process `Map`. The file
implementation stores one JSON object per line in
`<safeRunId(runId)>.jsonl`, plus current run state in
`<safeRunId(runId)>.state.json` and the latest checkpoint in
`<safeRunId(runId)>.checkpoint.json`. `appendRound` is idempotent by
`dedupKey`, `roundKey`, or the run/round key generated by the store.

The legacy positional `recall(runId, fromRound?, toRound?, pattern?)` form
returns a string. The object form supports bounded recall options including
`artifactRef`, `limit`, `cursor`, and `maxBytes`, and returns
`{ text, truncated, status, nextCursor?, error? }`. Cursors are bound to the
run, range, pattern, limits, artifact reference, and source version. Missing
records or ranges can be reported as `unrecoverable`; changed source or
parameters report `stale`; oversized JSONL records report `record_too_large`.

The store is designed for one writer per `runId` and process. It repairs a
complete JSONL record missing its final newline and isolates an incomplete
trailing fragment. Cross-process locking is outside the store contract.

`runToolLoop` uses `persistence: "required"` by default when a store is
provided and validates all nine methods before the provider is called.
`persistence: "none"` is an explicit no-op mode. Required writes use the
loop retry policy; an exhausted write emits a `persistence_error` through
`diagnostics.error` and terminates with `reason: "persistence_failed"`.
Checkpoint persistence is used before and after tool execution. A pre-tool
failure reports `sideEffect: "not_started"` and prevents execution; a
post-tool failure reports `sideEffect: "executed_uncommitted"` while retaining
the `checkpoint_failed` error class. Resume replays pending tool calls in
their original order; hosts must still make side-effecting `executeTool`
implementations idempotent.

The safe file-name namespace keeps simple IDs matching
`[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*` readable, except `"."`, `".."`, and
the reserved `run-h-` prefix. Other IDs become `run-h-` followed by the first
24 hexadecimal characters of their SHA-256 digest.

### 3.6 Tool providers and `ToolRegistry`

```js
/**
 * @typedef {Object} ToolProvider
 * @property {(sel?:{set?:string}) => Promise<ToolSchema[]>} listTools
 */

createToolRegistry({ executors, schemas }) => {
  executeTool,
  resolveTools(provider, sel)
}

createStaticToolProvider({ sets })
createJsonFileToolProvider({ path })
createCompositeToolProvider({ providers })
```

The executor map is the code-owned capability set. A `ToolProvider` selects
schemas and can overlay descriptions and constraints, but cannot introduce an
executor that is absent from the registry. `resolveTools` fails with
`KitError("tool_unknown_executor", ...)` for such a schema. Registry execution
validates `required`, property `type`, and `maxLength` before calling the
executor; invalid input becomes an error string and does not reach the
executor. Direct `runToolLoop` callers that do not use `createToolRegistry`
are responsible for their own input validation.

The static and JSON-file providers select `sel.set` or `default`. The
composite provider merges schemas by name in provider order. The
The `erix-agent/tools` subpath also exports `createRecallTool`, the tool
registry, and tool providers. These are opt-in helpers, not an implicit tool
set installed into `runToolLoop`; path-jail and filesystem helpers are not
part of the library.

## 4. Source layout

```text
src/
├── index.js                  # Public root exports
├── loop.js                   # runToolLoop and reflection decision parsing
├── run-state.js              # Bounded deterministic and semantic run state
├── tokens.js                 # Dependency-free token estimates
├── providers/
│   ├── anthropic.js          # Anthropic Messages requests and streaming
│   ├── errors.js             # KitError and provider error classification
│   ├── openai.js             # OpenAI chat/completions requests and streaming
│   ├── payload.js            # Provider payload options and timeout resolution
│   └── timeout.js            # Request and stream timeout coordination
├── messages/
│   ├── anthropic.js          # Canonical <-> Anthropic conversion and SSE assembly
│   ├── canonical.js          # Canonical blocks and OpenAI conversion
│   └── rounds.js             # Message validation and round grouping
├── compact/
│   ├── budget.js             # computeBudget
│   ├── enforce-size.js       # Deterministic field pruning
│   ├── fold-llm.js           # LLM-backed whole-round folding
│   ├── fold-statistical.js   # Deterministic whole-round folding
│   ├── helpers.js             # Shared folding selection and hook helpers
│   └── sliding-window.js     # Whole-round sliding-window folding
├── store/
│   ├── bounded-recall.js     # Bounded, cursor-based recall implementation
│   ├── file.js               # JSONL transcript, state, and checkpoint store
│   └── memory.js             # In-process transcript, state, and checkpoint store
├── config/
│   ├── api-key.js            # Direct, environment, and file key resolution
│   ├── env.js                # Environment-backed model configuration
│   ├── json-file.js          # JSON-file-backed model configuration
│   └── static.js              # Static model configuration
├── reflection/
│   ├── governor.js            # Deterministic continuation and stop decisions
│   ├── judge.js               # Objective timeline and judge parsing
│   ├── l0.js                  # Objective tool-result facts and summary parsing
│   └── wrapup.js              # End-of-turn JSON parsing and normalization
└── tools/
    ├── index.js               # erix-agent/tools subpath exports
    ├── providers.js           # Static, JSON-file, and composite ToolProvider
    ├── recall.js              # Bounded transcript recall tool adapter
    └── registry.js             # Code-owned executor/schema registry
```

The root export is `src/index.js`; the optional reference tools are exported
through the `erix-agent/tools` subpath. The current tree intentionally has no
`src/providers/index.js`.

## 5. Invariants

1. Tool implementations belong to the host. `executeTool` is the only
   execution boundary used by the loop.
2. Canonical tool-call rounds are folded as complete assistant/tool-result
   groups, so normal compaction does not create orphan tool messages.
3. Whole-round strategies keep system messages and the first real user message
   in the head. The emergency safe-truncation fallback may reduce or remove
   unprotected content if the request still exceeds its budget.
4. LLM-generated fold summaries pass deterministic size enforcement before they
   are inserted into the context.
5. Folded content is returned as `foldedPayload` and is included in persisted
   round records when a `TranscriptStore` is configured; folding changes the
   model view, not the archive source.
6. No secret is embedded in the library source. API keys can be supplied
   directly or resolved indirectly through `apiKeyEnv` and `apiKeyFile`.
7. The executor registry is code-owned. JSON or other provider data can select
   and constrain exposed schemas, but cannot add executable capabilities.
8. `verification.status === "verified"` is the only result state that permits
   a host to treat `finalText` as final-guard verified. `skipped`,
   `unverified`, and `error` require host-specific handling.
