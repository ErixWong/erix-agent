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
  |                               |-- round archive                  |
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

The runtime uses one internal block format. The OpenAI-compatible adapter converts
to and from the wire representation; a host that speaks another protocol brings its
own provider object and converts outside this library.

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
 * @property {{input_tokens?:number, output_tokens?:number, cacheRead?:number, cacheWrite?:number}} [usage]
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

```

**`createOpenAIProvider` is the only provider the package ships.** The library speaks
exactly one wire protocol (OpenAI-compatible `chat/completions`); it contains no
conversion, payload shaping or parameter policy for any other protocol. A host that
speaks something else builds the duck-typed `{ protocol, model, chat, chatStream }`
object itself and converts to canonical messages on its own side — the engine only
calls `provider.chat()` / `chatStream()` and never looks at `protocol`.

The factory also accepts the snake-case timeout aliases and the
provider-specific reasoning/payload fields implemented in
`src/providers/openai.js`. `model_name` is an alias for `model`; `protocol`
defaults to `"openai"`. `endpoint`, `apiKey`, and the selected model must be non-empty
strings. The default request timeout is `120000` ms. Without explicit
phase-specific settings, streaming uses a `120000` ms first-byte timeout,
`120000` ms idle timeout, and `300000` ms total timeout. The legacy
`timeout`/`timeoutMs` setting remains one request-wide deadline.

`chatStream` emits optional `onDelta`, `onReasoningDelta`, `onToolCall`,
`onUsage`, and `onEvent` callbacks supplied on the request. The OpenAI adapter
uses chat/completions serialization and SSE parsing and returns `ChatResponse` in
canonical form.

Provider failures are represented by `KitError`. HTTP status classification
maps 408 to `timeout`, 429 to `rate_limited`, 401/403 to `auth`, 5xx to
`server`, 400/422 to `invalid_request`, 404 to `not_found`, and 409 to
`conflict` (issue #179; the three added codes are non-retryable, exactly like
the `unknown` they replaced), and every other status to `unknown`. Fetch and
abort failures are classified separately, and the error carries `retryable`
plus available status, phase, and elapsed-time metadata.

### 3.2 `runToolLoop`

`runToolLoop` is the single-task lifecycle entry point. Its current option
surface has **three stations**, and the station decides the spelling:

- the **capability plane** and the permanent **top-level** keys (behaviour
  carriers, identity containers, the tool list) stay top-level;
- every **data** knob lives under the `config` namespace — `config.input.*`,
  `config.run.*`, `config.tuning.*`, `config.timing.*`, `config.folding.*`,
  `config.guard.*`, `config.metadata.*`;
- the **flat** spellings the pre-0.28 drafts showed (`system`, `timeoutMs`,
  `toolResultTtl`, `initialMessages`, `context`, …) are **retired**: the name
  gate rejects them on the spot and the message names the canonical home, e.g.
  `unknown runToolLoop option: "timeoutMs" (its canonical home is
  config.timing.timeoutMs; the flat spelling is rejected)`.

The authoritative table (which leaf lives in which group, and the version each
flat key was retired in) is in `docs/host-consumer-contract.md`.

```js
runToolLoop({
  // capability plane + permanent top-level keys (not data — unchanged)
  provider,
  tools = [],
  executeTool,
  store,
  todoStateProvider,
  semanticStateProvider,
  modelConfig,
  session,
  runState,
  finalGuard,
  signal,
  onRound,
  onJudge,
  onToolResult,
  onPersistenceError,
  onObserverError,
  onDelta,
  onReasoningDelta,
  onToolCall,
  onUsage,
  onEvent,
  // the config plane: data only (this subtree must survive a JSON round-trip)
  config: {
    input: {
      system,
      wrapup = true,
      initialUserMessage,
      messages,          // the leaf; the flat `initialMessages` is retired
    },
    run: {
      partialPersistence = false,
      maxRounds = 8,
      reflection,
      stallDetection = { window: 4 },
      completion = { signals: [], maxNoToolRounds: 3 },
      maxTokenContinuations = 3,
      writeToolNames = ["writeFile", "edit"],
      writeToolPathKeys = ["path", "file_path"],
      runId,
      resume = false,
      stream = false,
    },
    tuning: { maxTokens, temperature, topP },
    timing: { timeoutMs, deadlineMs, retry = false },
    folding: { context, toolResultTtl = 2, toolResultFoldMinTokens = 4000 },
    guard: { finalGuardMaxRetries = 2, finalGuardTimeoutMs = 30000 },
    metadata: { modelMetadata, model, expert, user, task, requestId, toolContext },
  },
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

`config.input.messages` takes precedence over `config.input.initialUserMessage`.
With `config.run.resume: true`, `restoreResume` (`src/loop/resume-manager.js`)
rebuilds the loop state from the transcript ledger, the persisted run-state
record, and the recovery rows for `config.run.runId`, using the persisted
messages and round state instead of the initial messages. It does not read a
run snapshot.

`config.run.partialPersistence` is disabled by default. Opting in with
`{ intervalMs, minBytes? }` persists streamed assistant text into the transcript
ledger as a partial-text recovery row (appended through `appendRecoveryRow`);
a crash loses at most the text generated since the last commit. With the default
threshold, the engine commits a partial recovery row at least once per
`intervalMs` while text is arriving. Writes are single-flight; deltas received
during a write are coalesced into the next commit. A configured `minBytes`
suppresses timer scheduling for smaller individual deltas. On resume, a matching
partial is appended as assistant text only when restoring the round it was
captured in and that round's assistant message has not already been persisted.
When the store does not implement `appendRecoveryRow`, this persistence degrades
as an optional capability. Prerequisite: set `config.run.stream: true`;
otherwise startup throws.

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

`config.run.writeToolNames` is an explicit set used only for judge file-footprint
reporting; it does not infer write tools. For each configured write tool,
`config.run.writeToolPathKeys` supplies the priority order for extracting a path.

#### Completion, retries, and termination

- `config.timing.retry` is opt-in. `false` or omission performs no provider
  retry. With an object, `attempts` defaults to `2` retries after the initial call,
  `backoffBaseMs` defaults to `1500`, `backoffMaxMs` defaults to `10000`, and
  `sleepImpl` defaults to the loop's abort-aware sleeper. Only errors marked
  `retryable` are retried.
- A present assistant message with no text, tool call, or reasoning blocks is
  retryable. `config.timing.retry: {}` therefore retries this empty response
  twice after the initial call; the CLI reads `ERIX_RETRY_ATTEMPTS` (default
  `2`) for the same policy.
- `config.run.completion` defaults to `{ signals: [], maxNoToolRounds: 3 }`. A
  completion signal can stop a no-tool response, and after tool use the no-tool
  streak stops at `maxNoToolRounds`. `config.run.completion: false` disables
  this policy.
- `config.run.stallDetection` defaults to `{ window: 4, mode: "consecutive" }`:
  the whole window must hold the same tool signature. Pass `{ mode: "appear" }`
  to treat a signature anywhere in the window as a stall, or `false` to disable
  detection. `ERIX_STALL_MODE` can provide the mode unless the option is
  explicitly `false`.
- `config.run.maxTokenContinuations` defaults to `3`. A response ending with
  `stopReason === "max_tokens"` can therefore receive up to three continuation
  calls in the same round.
- `config.run.maxRounds` defaults to `8` and must be a positive safe integer. Normal
  termination reasons are `end_turn`, `no_tool`, `stall`, `max_rounds_cap`,
  `judge_done`, and `continuation_exhausted`; aborts and
  uncaught failures use `aborted` and `failed`.

When enabled, `config.input.wrapup` appends the end-of-turn instruction
requiring this JSON shape:

```json
{"done":true,"summary":"Task summary","output":"Final result for the user"}
```

The parser requires `done` to be an own boolean property. `done: true` makes
the response complete and replaces `finalText` with `output` or `summary`;
`done: false` continues the loop. `config.input.wrapup: false`, or
`ERIX_NO_WRAPUP_INSTRUCTION=1`, disables instruction injection, JSON parsing,
`finalText` replacement, and wrap-up normalization together. Optional
normalization is enabled by `ERIX_WRAPUP_NORMALIZE=1` or
`config.run.reflection.wrapupNormalize === true`.

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

The default `config.guard.finalGuardMaxRetries` is `2`. A positive
`config.guard.finalGuardTimeoutMs` is used as-is; a non-positive or non-finite
value uses the default `30000` ms. The guard runs for non-abort stop paths including
`end_turn`, `no_tool`, `judge_done`, `max_rounds_cap`, `stall`,
`continuation_exhausted`. `accept` produces
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
      verified, skipped, revised, unverified, guard_error
    }
  },
  runState?,
  usage: { input_tokens, output_tokens, cacheRead?, cacheWrite? },
  compactionStats: [{
    compacted,
    foldedRounds,
    tokensBefore,
    tokensAfter
  }]
}
```

`transcript` is the current in-memory message snapshot. The configured
`TranscriptStore` is the persistence/archive interface and is separate from
that return value.

#### Reflection and judge governance

If `config.run.reflection` is omitted, `config.run.maxRounds >= 16`, and
`ERIX_NO_REFLECTION` is not `1`, the loop enables `{ enabled: true }`
automatically. `config.run.reflection: false` disables it;
`config.run.reflection: true` enables it with the defaults below. An object can
configure:

```js
config: { run: { reflection: {
  enabled,
  roundJudge = true,
  judgeIntercept = true,
  judgeIntervalRound = 10,
  judgeInterceptTimeoutMs = 30000,
  judgeFailureLimit = 3,
  extensionStep = Math.max(8, Math.floor(config.run.maxRounds * 0.5)),
  maxExtensions = 2,
  maxRoundsCap = Math.max(config.run.maxRounds, 256),
  wrapupNormalize,
  judge: { provider }, // `evaluator` retired (issue #498 S4c)
  onReflection,
} } }
```

`ERIX_NO_ROUND_JUDGE=1` disables the end-turn judge independently of tool
interception. The round judge evaluates an `end_turn` response with a separate
or shared provider. Only `done: true` with `confidence >= 0.7` yields
`judge_done`; `done: false` injects a corrective continuation message. Parse
failures and evaluator errors degrade to the normal governor, and the round
judge is disabled after `judgeFailureLimit` consecutive failures.

At `nearLimit` (`budgetRounds >= floor(effectiveMaxRounds * 0.8)`) the judge
prompt additionally requires `extend`, `extendReason`, and `plan`; this
applies to both the end-turn judge and the next interception audit, so a
model that never emits `end_turn` still reaches the extension decision.
`extend: true` (while `extensionCount < maxExtensions` and below
`maxRoundsCap`) adds `extensionStep` rounds to the effective budget and
injects the plan as a continuation message; `direction: "off_track"` turns
that continuation into a change-of-approach instruction. `extend: false`
nudges the model to converge instead. A missing or unparseable `extend`
field means no extension (fail-closed); the final budget round falls back to
the forced no-tools final answer.

After `judgeIntervalRound` tool executions, the next tool call is transparently
audited. A `done: false` audit blocks the original execution and returns an
audit result to the model. Audit errors and timeouts degrade to direct
execution. A judge result with `direction: "off_track"` does not block the
tool; it adds a direction hint to the next model context. `onJudge` receives
round and interception decisions, including degraded decisions.

The governor is deterministic and side-effect free. It handles repeated
errors, memory-loss responses, no-tool streaks, stall streaks, time
deadlines, judge-driven extensions, and completion. Judge extensions add
`extensionStep` rounds up to `maxRoundsCap`, at most `maxExtensions` times.
The task brief used by judge and wrap-up is selected in this order:
`config.metadata.task`, `config.folding.context.task`, then the latest user
text in the entry transcript.

Judge interception uses a 6,000-token conversation budget, round-judge requests
cap output at 1,024 tokens and set `reasoning_effort: "none"`. Raw judge output
is retained in `judge.log`. The final budget round always sends a no-tools
request.

#### Prompt cache (issue #192, revised by #926)

The library no longer places cache breakpoints. Breakpoint marking
(`cacheBoundary` on the system prompt / first user message / rolling tail) and the
`config.input.cacheStablePrefix` switch existed to emit Anthropic `cache_control`
markers; with the Anthropic adapter retired they would be a knob that changes
nothing, so both are gone.

What remains is the accounting half, which is protocol-independent: the OpenAI
response's `prompt_tokens_details.cached_tokens` is normalized into
`usage.cacheRead` (`src/messages/openai-normalization.js`), and a host that sets
`usage.cacheRead` on the way in gets it serialized back as `cached_tokens`. OpenAI
caches prefixes automatically, so nothing has to be marked for it to happen.

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

The `config.folding.context` option accepts `strategy`, `budgetTokens`,
`keepRounds`, `toolContext`, and `task`. Strategy options forwarded by the loop
include `summaryRole` (default `"user"`), `recoveryHint`,
`stripHistoricalImages` (default `false`), `onBeforeFold`, `onAfterFold`, and
`stubFor` (`protectedMessage` was retired by issue #898). `keepRounds` defaults to `6`. If no `config.folding.context` or
budget is configured, the loop does not compact. If a budget is configured
without a strategy, the loop uses the sliding-window fallback when the budget
is exceeded.

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
  maxSummaryTokens = 1400, // DEFAULT_SUMMARY_MAX_TOKENS in src/compact/fold-llm.js
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
truncation. That final fallback can trim fields, remove images, clear tool
inputs and remove whole messages as needed. Issue #898 retired the
`protectedMessage` knob together with `compactionStats[].protectedDowngraded`:
no message is exempt any more, and every message the safety layer removes one
by one now goes into `foldedPayload`, so its original text stays in the ledger
archive (and stays reachable through `recall_read`, issue #896). A run whose
best-effort copy still cannot fit does not throw: the safety layer returns
the best-effort messages with `budgetUnreachable`, surfaced through the existing
`compaction` event and CLI stderr.

#### Tool-result TTL folding

Independent of context compaction, old or large tool results can be folded in
the provider request view. `config.folding.toolResultTtl` defaults to `2` rounds
(`0` disables it), and `config.folding.toolResultFoldMinTokens` defaults to
`4000` estimated tokens. At `age === ttl - 1`, a warning round asks the model to extract
important facts with `note_take` — but only on note evidence (issue #741: the whole
note family on the host-supplied tool surface **and** a `note_take` write in the visible
ledger that is paired, payload-confirmed and not later revoked); with either fact
missing, that round asks for a re-read of the source file instead. At the TTL, the
request view replaces the result with a navigation digest and, for suitable JSON, a
JSON skeleton; a `readFile` call additionally gets one runnable retrieval command.
Checkpoint and transcript persistence retain the full tool-result text.
`note_*`, todo, error, and explicitly protected results are not folded.

### 3.4 Model configuration providers

```js
createStaticModelConfigProvider(configOrSlots)
createJsonFileModelConfigProvider({ path })
resolveApiKey(config = {})
```

`createStaticModelConfigProvider` accepts one config object or
`{ slots: { default, ... } }`. Its `resolve(slot = "default")` selects the
requested slot, falling back to `default`. **The environment-variable provider
is no longer published** (`createEnvModelConfigProvider` retired with the 0.31
bundle): a host that reads its configuration out of the environment implements
the same duck-typed `resolve(slot)` itself. The JSON-file provider requires a
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
 *   Required methods (issue #78):
 * @property {(runId:string, record:object) => Promise<void>} appendRound
 * @property {(runId:string) => Promise<object[]>} load
 *   Optional run-state capability:
 * @property {(runId:string, state:string) => Promise<void>} markRunState
 * @property {(runId:string, state:object) => Promise<void>} saveRunState
 * @property {(runId:string) => Promise<object|undefined>} loadRunState
 *   Host-facing optional terminal-status reader (not consumed or validated by the engine):
 * @property {(runId:string) => Promise<string|undefined>} loadRunStateStatus
 *   Optional ledger recovery-row capability (issue #769):
 * @property {(runId:string, record:object) => Promise<boolean|void>} appendRecoveryRow
 * @property {(runId:string) => Promise<object[]>} listRecoveryRows
 * @property {(runId:string) => Promise<void>} clearRecoveryRows
 */
```

The memory implementation is a cloned in-process `Map`. The file
implementation stores one JSON object per line in
`<safeRunId(runId)>.jsonl`, plus the current run-state snapshot in
`<safeRunId(runId)>.state.json` and terminal status in
`<safeRunId(runId)>.status.json`; recovery rows are appended to a separate
per-run `<safeRunId(runId)>.recovery.jsonl`.
`appendRound` is idempotent by
`dedupKey`, `roundKey`, or the run/round key generated by the store.

The store is designed for one writer per `runId` and process. It repairs a
complete JSONL record missing its final newline and isolates an incomplete
trailing fragment. Cross-process locking is outside the store contract.

`runToolLoop` uses `config.run.persistence: "required"` by default when a store is
provided and validates the two required methods before the provider is
called; the run-state and recovery-row methods are optional capabilities.
When an optional method is absent, the engine emits one
`persistence_capability_degraded` event per missing method (`{type, runId,
method, detail}`; deduplicated for the whole run) and skips that persistence
— the run completes normally, only mid-flight crash resume is unavailable.
Run-snapshot persistence was retired in 0.33.0 (issue #838): the engine neither
writes nor reads a run snapshot, and there is no fallback to one.
`config.run.persistence: "none"` is an explicit no-op mode. Writes to methods the store does advertise use the
loop retry policy; an exhausted write emits a `persistence_error` through
`diagnostics.error` and terminates with `reason: "persistence_failed"`.
Ledger appends record each round: when a required append fails before a tool has
run in the current round it reports `sideEffect: "not_started"`, and when it
fails after a tool has run it reports `sideEffect: "executed_uncommitted"` (the
side effect happened but was not committed). Resume replays pending tool calls in
their original order; the pending calls are derived from the ledger by
`resumePendingTools` on the resume path (`src/loop/orchestrator.js`), not read
from a run snapshot. Hosts must still make side-effecting
`executeTool` implementations idempotent. Tool schemas may declare
`replay: "safe" | "unsafe"` (omission defaults to unsafe), which is applied when
recovering the pending tool calls. The engine-level
`config.run.replayPolicy: "always-replay"` default ignores that declaration during
recovery. With `"per-tool-declaration"`, safe calls replay as before and
unsafe calls are skipped and returned to the model as interrupted tool results;
the optional `tool_replay_decision_required` event marks them for host
resolution.

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
```

**Tool providers are host-built.** The three factories that used to sit here
(`createStaticToolProvider`, `createJsonFileToolProvider`,
`createCompositeToolProvider`) retired with the 0.31 bundle: a `ToolProvider` is
a duck-typed `{ listTools(sel) }` object, so the host writes the one it needs
instead of importing a factory.

The executor map is the code-owned capability set. A `ToolProvider` selects
schemas and can overlay descriptions and constraints, but cannot introduce an
executor that is absent from the registry. `resolveTools` fails with
`KitError("tool_unknown_executor", ...)` for such a schema. Registry execution
validates `required`, property `type`, and `maxLength` before calling the
executor; invalid input becomes an error string and does not reach the
executor. Direct `runToolLoop` callers that do not use `createToolRegistry`
are responsible for their own input validation.

A host-built provider selects `sel.set` or `default`; merging several providers
by name is the host's own composition. The
`erix-agent/tools` subpath exports the tool registry, the
canonical file tools (`src/tools/file-tools.js`, issue #184) and the skill-package
loader (`src/skills/loader.js`, issue #197). These are opt-in helpers, not an
implicit tool set installed into `runToolLoop`, and none of them is on the package
root export. Two history facts that are easy to collapse into one wrong sentence:
the jail helpers (`JailError` / `createJail`) together with the `createFileTools`
of that day were deleted in the **0.6.0** breaking window (commit `a8cd193`; 0.5.1
was the last release that carried them), and `createFileTools` came back in
**0.18.0** as the canonical implementation named above. The jail never came back —
per ADR-009 the library provides no security boundary. Model-facing retrieval
is note-first **when there are notes to point at**: use `note_list` followed by
`note_read`; there is no transcript transcript retrieval API; recall adapters
were retired in 0.8.0. Since issue #741 **the fold substitute and the TTL
placeholder** say so only on evidence (the note family on the tool surface plus a
successful `note_take` in the visible ledger — paired with a result for that
`tool_use_id`, its payload confirming success, and not later revoked by a successful
`note_forget`); otherwise those two places state that no recoverable decision record
exists, with the reason (one of: no note tools, no note write, notes revoked, no note
evidence), and **their** text drops every `note_*` mention. **Coverage, as of issue #746 is a registered roster, not a claim that every prompt site is
clean** (the sentence this paragraph used to carry, "coverage is exactly those two entry points",
became false with #746; `test/prompt-note-coverage-746.test.js` reddens any wording that slides
back into the unqualified universal, and it reddens a roster that over-claims). Two gates of
different strength are in play and must not be merged: the **tool-surface gate** (is the whole
`note_*` family on the assembled surface?) and the **ledger-evidence gate** (that, *plus* a
`note_take` write in the visible ledger that still resolves right now).

**On the full evidence gate (surface + ledger)** — these are retrieval instructions; they say
"where to fetch it now": #741's TTL placeholder — `foldToolResultsForRequest` in
`src/loop/tool-result-ttl.js`, which resolves the recall verdict once per request view — and
#741's fold substitute, whose advertising sentence is decided by `resolveFoldRecoveryHint` →
`noteRecallFromMessages` in `src/compact/helpers.js` while the mechanical substitute itself is
rendered by `src/compact/fold-statistical.js` and `src/compact/fold-llm.js` (that file's own
comment at line 352 calls it 机械替代物). Plus #746's aggregate-limit stub (`src/loop/aggregate-budget.js`)
and the per-output stub (`src/loop/run-snapshot-executor.js`, same wording as the
aggregate stub), plus three `bin/` sites: the guard's run-state summary and its revise pointer
(`bin/final-guard.js`), and the fold-stub suffix plus the recovery hint
(`bin/final-guard-support.js` and `bin/final-guard.js`'s `buildCaptureRecoveryHint`), plus the
two child-run sites in `bin/delegation.js` (its fold stub and recovery hint), which share the
**child's own tool surface** with the parent-side derivation — the single source of truth review
round 2 asked for. The child's system prompt is not in this class: it is the child-side twin of
capability-statement item 1 below, on the tool-surface gate alone, and its surface fact is the
**child's own name list** (round 3, must-fix ①: `notes` is derived from `toolNames` instead of
being handed in separately by the caller). The evidence here is an **assembly fact plus the ledger**, never the `--no-notes` flag: a `--tools`
allowlist strips the family just as well, and reading only the flag misses that.

**Capability statements — deliberately on the tool-surface gate only, never on the ledger gate**
(each carries its reason; this is a judgement, not a to-do list):

1. The `[Your situation]` paragraph and the "exact values must come from" bullet of the CLI
   system prompt (`bin/system-prompt.js`), and the archive notice (`bin/tools.js`), all derived
   from the assembled tool surface through `notesOnToolSurface`; `bin/delegation.js`'s child-run
   prompt is the **child-side twin of the same site**, derived through `notesOnToolNames` (the
   name-list side of the same `hasNoteToolSurface` truth). Four reasons: (a) they are assembled **before the run
   starts** (once for `chat`, once at REPL session start), where there is no ledger to consult —
   scoring them against the four #741 states could only ever land on "no note writes", which
   reports "not known" as "this run recorded nothing": the mirror image of the error #746 fixed
   on the guard side; (b) the sentences are **capability claims** ("this session ships `note_*`;
   look before you re-read"), whose truth depends only on the assembly fact, which *is* gated —
   and the action sentences are no exception: they are a **conditional workflow** whose trigger is
   the model's own state ("you need an early detail and cannot recall it"), not a claim that the
   note is there; rewriting them as existence claims ("the notes you recorded", "the notes
   contain") would be the lie; (c) forcing the ledger gate in would mean plumbing `messages` into the assembly layer
   (`chat` has no history; the REPL would have to re-assemble per round) and would buy exactly one
   new falsehood: "the family is present, but this run could never have written anything";
   (d) the default rendering is pinned **byte-for-byte by goldens**
   (`buildCliToolsSystemPrompt() === CLI_TOOLS_SYSTEM_PROMPT`, `test/fixtures/cli-golden.json`,
   plus the host-side "default list line is byte-identical" assertion in `examples/pi-extension`):
   wiring the ledger gate necessarily rewrites that default, so demanding the four #741 states
   here pays a golden re-bake and still buys back the falsehood in (a).
   **Reverse guard:** if an existence claim shows up in those paragraphs,
   `test/prompt-note-coverage-746.test.js` goes red — and its probe now passes an `archiveDir`,
   so the archive-notice branch is inside the scanned text (round 2's probe did not, which is how
   an existence-claim mutation there slipped through).
2. The read-only tool whitelist text in `src/loop/run-snapshot-executor.js`, where `note_list`
   names a *permitted* tool (#195) — a capability statement, not a retrieval instruction; the
   evidence gate would false-positive there.
3. The memory-loss nudge (`src/reflection/governor.js`) is the **low-risk tier**: it never
   commands a tool call, so #746 only made its wording conditional ("if this run has notes …") and
   kept a re-read fallback. It runs inside the engine and could reach the context, but its job is
   "you may have lost something", not "the notes definitely contain it"; the whole-family gate
   would turn a nudge into noise.
4. `examples/pi-extension/erix-run-core.js`'s `buildSystemPrompt` is the host-side twin of item 1,
   but it **is not yet on the tool-surface gate** — see the paragraph below.

The evidence-backed sentence is conditional retrieval guidance; it never claims this result's key
points are already recorded. Note availability stays host configuration — the engine writes no
notes.

The roster above is registered, not a claim of universal cleanliness: item 4, the host site
(`examples/pi-extension/erix-run-core.js`, whose `buildSystemPrompt` calls
`buildCliToolsSystemPrompt` without `notes`), is **known to be still unconditional** — its inner
run may pass `notes: false`, so that prompt can still name `note_*` tools that are not on the
surface. The fix is one line (derive `notes` from the inner tool surface), but that host lives
outside the `src/` and `bin/` surfaces this branch touches, so #746 left it alone; the coordinate
and the consequence are recorded in the issue #746 work report.

## 4. Source layout

The authoritative, current source tree lives in the **Module map** section of
`README.md`: `npm run check:docs` reconciles that inventory item-by-item against
`src/`, so this document keeps a single pointer instead of a second tree that
would drift out of date. The responsibilities of each area are described in the
interface sections above (Providers, runToolLoop, compaction, TranscriptStore,
and the tool-provider / registry section). The structural facts stated below do
not depend on individual file additions or removals.

The root export is `src/index.js`; the optional reference tools are exported
through the `erix-agent/tools` subpath — `createFileTools` and the skills-loader
symbols included, and the root export carries neither of them. The current tree
intentionally has no `src/providers/index.js`, and `src/skills/` ships
`loader.js` only (no `src/skills/index.js`, and no `./skills` subpath export).

## 5. Invariants

1. Tool implementations belong to the host. `executeTool` is the only
   execution boundary used by the loop.
2. Canonical tool-call rounds are folded as complete assistant/tool-result
   groups, so normal compaction does not create orphan tool messages.
3. Whole-round strategies keep system messages and the first real user message
   in the head. The emergency safe-truncation fallback may reduce or remove
   content if the request still exceeds its budget (issue #898: nothing is exempt).
4. LLM-generated fold summaries pass deterministic size enforcement before they
   are inserted into the context.
5. Context compaction may return `foldedPayload` for persistence, while
   tool-result TTL folding changes only the provider request view; the ledger
   retains the complete tool-result text.
6. No secret is embedded in the library source. API keys can be supplied
   directly or resolved indirectly through `apiKeyEnv` and `apiKeyFile`.
7. The executor registry is code-owned. JSON or other provider data can select
   and constrain exposed schemas, but cannot add executable capabilities.
8. `verification.status === "verified"` is the only result state that permits
   a host to treat `finalText` as final-guard verified. `skipped`,
   `unverified`, and `error` require host-specific handling.
