# 架构与接口契约 — erix-agent

> English version: [architecture.md](architecture.md)

## 1. 数据流概览

```text
调用方                         erix-agent                         LLM API
  |                               |                                  |
  |  system / 初始消息             |                                  |
  |  tools / executeTool          |                                  |
  |  provider / TranscriptStore   |                                  |
  |-------------- runToolLoop --->|                                  |
  |                               |-- 每轮前 compact                 |
  |                               |-- provider.chat 或 chatStream -->|
  |                               |<-- 规范响应 ---------------------|
  |                               |-- tool_use -> executeTool ------>| 调用方代码
  |                               |<-- tool_result ------------------|
  |                               |-- completion / stall / judge     |
  |                               |-- checkpoint 与轮次归档          |
  |<------------- 结果 -----------|                                  |
```

运行时拥有一个任务生命周期：启动、执行、停止、恢复和发出事件。工具实现、持久化及模型传输仍是显式注入点。
`provider` 执行模型 I/O，提供时由 `store` 执行持久化，`executeTool` 是宿主的工具边界；循环本身不会发现或实现工具。

CLI 可以在工具执行周围加入自己的产出归档行为。这属于库契约之外的机制，不由 `runToolLoop` 执行。

## 2. 规范消息模型

运行时使用一种内部块格式。OpenAI 和 Anthropic 适配器负责与各自协议的原生表示相互转换。

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

`validateMessages` 强制执行规范消息规则：

- 角色仅限 `system`、`user` 和 `assistant`；system 消息必须位于会话消息之前。
- `tool_use` 块仅可出现在 `assistant` 消息中，`tool_result` 块仅可出现在 `user` 消息中。
- 包含工具调用的 assistant 消息后必须紧跟包含匹配工具结果的 user 消息。工具使用 ID 必须非空、在 assistant 消息内唯一，并且与结果 ID 匹配。

`groupIntoRounds` 将 system 消息和首个真实 user 消息视为不可变头部。包含工具调用的轮次由 assistant 消息及其紧随其后的 user 工具结果消息组成；其他每条消息都是一个单消息轮次。此分组会在协议特定序列化之前应用于规范消息。

## 3. 核心接口

### 3.1 提供器

该包导出分离的提供器工厂。不存在 `src/providers/index.js`，也不导出通用的 `createProvider` 工厂。

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

实际工厂还接受 snake-case 超时别名，以及 `src/providers/openai.js` 和 `src/providers/anthropic.js` 实现的提供器专用 reasoning/payload 字段。`model_name` 是 `model` 的别名；`protocol` 分别默认为 `"openai"` 或 `"anthropic"`。`endpoint`、`apiKey` 和所选模型必须是非空字符串。默认请求超时为 `120000` ms。未显式设置分阶段参数时，流式传输使用 `120000` ms 首字节超时、`120000` ms 空闲超时和 `300000` ms 总超时。旧版 `timeout`/`timeoutMs` 设置仍是覆盖整个请求的截止时间。

`chatStream` 会发出请求中提供的可选 `onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage` 和 `onEvent` 回调。OpenAI 适配器使用 chat/completions 序列化和 SSE 解析；Anthropic 适配器使用 Messages 序列化和 content-block SSE 解析。两者都以规范形式返回 `ChatResponse`。

提供器失败表示为 `KitError`。HTTP 状态分类将 408 映射为 `timeout`，429 映射为 `rate_limited`，401/403 映射为 `auth`，5xx 映射为 `server`，其他状态映射为 `unknown`。Fetch 和 abort 失败分别分类，错误中还带有可用的 `retryable` 以及 status、phase 和 elapsed-time 元数据。

### 3.2 `runToolLoop`

`runToolLoop` 是单任务生命周期入口。当前选项表面为：

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
  toolResultTtl = 2,
  toolResultFoldMinTokens = 4000,
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

`initialMessages` 优先于 `initialUserMessage`。当 `resume: true` 时，循环加载 `runId` 对应的 transcript 和 checkpoint，使用持久化的消息及轮次状态，而不是初始消息。

`executeTool` 支持以下任一形式：

```js
(name, input) => Promise<string>
({ id, name, input, context, signal }) =>
  Promise<string|{content:any, metadata?:object, success?:boolean}|Error>
```

结构化形式会接收合并后的 `toolContext`，以及 `expert`、`user`、`task`、`session` 和 `requestId` 值。结构化结果使用 `data` 作为工具结果内容；循环会添加执行元数据，并将失败结果转换为带有 `is_error` 的规范 `tool_result` 块。

`writeToolNames` 是仅用于 judge 文件足迹报告的显式集合；它不会推断写工具。对于每个配置的写工具，`writeToolPathKeys` 提供提取路径的优先级顺序。

#### 完成、重试与终止

- `retry` 是选择启用的。`false` 或省略表示不重试提供器。使用对象时，`attempts` 默认为初始调用之后重试 `2` 次，`backoffBaseMs` 默认为 `1500`，`backoffMaxMs` 默认为 `10000`，`sleepImpl` 默认为循环中支持 abort 的 sleeper。仅标记为 `retryable` 的错误会重试。
- 存在但没有文本、工具调用或 reasoning block 的 assistant 消息会被标记为可重试。`retry: {}` 因此会在初始调用后默认重试两次；CLI 读取 `ERIX_RETRY_ATTEMPTS`（默认 `2`）使用同一策略。
- `completion` 默认为 `{ signals: [], maxNoToolRounds: 3 }`。完成信号可以停止无工具响应；工具使用后，无工具连续轮次在达到 `maxNoToolRounds` 时停止。`completion: false` 会禁用此策略。
- `stallDetection` 默认为 `{ window: 4, mode: "consecutive" }`：整个窗口内必须是同一个工具签名。传 `{ mode: "appear" }` 表示窗口内出现过同一签名即判停滞，传 `false` 会禁用检测。除非选项显式为 `false`，否则 `ERIX_STALL_MODE` 可以提供该模式。
- `maxTokenContinuations` 默认为 `3`。因此，以 `stopReason === "max_tokens"` 结束的响应可以在同一轮中最多接收三次续接调用。
- `maxRounds` 默认为 `8`，且必须是正的安全整数。正常终止原因包括 `end_turn`、`no_tool`、`stall`、`max_rounds_cap`、`reflection_stop`、`judge_done` 和 `continuation_exhausted`；中止和未捕获失败使用 `aborted` 和 `failed`。

启用时，`wrapup` 会追加要求以下 JSON 形状的回合结束指令：

```json
{"done":true,"summary":"任务摘要","output":"给用户的最终结果"}
```

解析器要求 `done` 是对象自身的布尔属性。`done: true` 会使响应完成，并用 `output` 或 `summary` 替换 `finalText`；`done: false` 会继续循环。`wrapup: false` 或 `ERIX_NO_WRAPUP_INSTRUCTION=1` 会一并禁用指令注入、JSON 解析、`finalText` 替换和收尾规范化。可选规范化由 `ERIX_WRAPUP_NORMALIZE=1` 或 `reflection.wrapupNormalize === true` 启用。

`finalGuard` 是可选的、由宿主提供的 provenance 或完成检查：

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

默认 `finalGuardMaxRetries` 为 `2`。正的 `finalGuardTimeoutMs` 按原值使用；非正值或非有限值使用默认值 `30000` ms。对于包括 `end_turn`、`no_tool`、`judge_done`、`max_rounds_cap`、`stall`、`continuation_exhausted` 和 `reflection_stop` 在内的非 abort 停止路径，都会运行 guard。`accept` 产生 `verification.status === "verified"`。`skip` 产生 `"skipped"`。当循环可以继续时，`revise` 会将返回的消息作为 user 消息注入。如果不可继续的停止路径无法修订，或达到重试上限，结果为 `"unverified"`，且 `termination.reason === "final_guard_unverified"`。guard 错误或超时会返回最终文本并使用 `"error"` 状态；不会将其视为已验证。未配置 guard 会产生原因是 `"no_final_guard"` 的 `"skipped"`。

结果形状为：

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

`transcript` 是当前的内存中消息快照。已配置的 `TranscriptStore` 是持久化/归档接口，与该返回值分离。

#### 反思与 judge 治理

如果省略 `reflection`、`maxRounds >= 16` 且 `ERIX_NO_REFLECTION` 不为 `1`，循环会自动启用 `{ enabled: true }`。`reflection: false` 会禁用它；`reflection: true` 会使用以下默认值启用它。对象可以配置：

```js
reflection: {
  enabled,
  roundJudge = true,
  judgeIntercept = true,
  judgeIntervalRound = 10,
  judgeInterceptTimeoutMs = 30000,
  judgeFailureLimit = 3,
  extensionStep = Math.max(8, Math.floor(maxRounds * 0.5)),
  maxExtensions = 2,
  maxRoundsCap = Math.max(maxRounds, 256),
  wrapupNormalize,
  judge: { provider, evaluator },
  onReflection,
}
```

`ERIX_NO_ROUND_JUDGE=1` 会独立于工具拦截禁用回合结束 judge。回合 judge 使用独立或共享的提供器评估 `end_turn` 响应。只有 `done: true` 且 `confidence >= 0.7` 才会产生 `judge_done`；`done: false` 会注入纠正性的续接消息。解析失败和评估器错误会降级到普通 governor；连续失败达到 `judgeFailureLimit` 后，回合 judge 会被禁用。

进入 `nearLimit`（`budgetRounds >= floor(effectiveMaxRounds × 0.8)`）后，judge prompt 会额外要求返回 `extend`、`extendReason` 和 `plan`；这同时适用于 end-turn judge 和下一次工具拦截审计，因此模型即使从不输出 `end_turn` 也能触达扩轮决策。`extend: true`（且 `extensionCount < maxExtensions`、未达 `maxRoundsCap`）会把有效预算增加 `extensionStep` 轮，并把 plan 作为 continuation 消息注入；`direction: "off_track"` 会把该 continuation 变为换思路指令。`extend: false` 则提示模型尽快收敛。`extend` 字段缺失或解析失败意味着不扩轮（fail-closed）；最终预算轮回退到强制无工具的终稿请求。

每执行 `judgeIntervalRound` 次工具后，下一次工具调用会被透明审计。`done: false` 的审计会阻止原始执行，并向模型返回审计结果。审计错误和超时会降级为直接执行。带有 `direction: "off_track"` 的 judge 结果不会阻止工具；它会向下一次模型上下文添加方向提示。`onJudge` 会接收回合和拦截决策，包括降级决策。

governor 是确定性的且无副作用。它处理重复错误、记忆丢失响应、无工具连续轮次、停滞连续轮次、时间截止、judge 驱动的扩轮和完成。judge 扩轮会把轮次增加 `extensionStep`，上限为 `maxRoundsCap`，最多进行 `maxExtensions` 次。judge 和 wrap-up 使用的任务简述按以下顺序选择：`task`、`context.task`，然后是入口 transcript 中最新的 user 文本。

Judge 拦截使用 6,000 token 的会话预算；round judge 请求最多输出 1,024 token，并设置 `reasoning_effort: "none"`。原始 judge 输出保留在 `judge.log` 中。最终预算轮次始终发送不带工具的请求。

### 3.3 压缩

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

`context` 选项接受 `strategy`、`budgetTokens`、`keepRounds`、`toolContext` 和 `task`。循环转发的策略选项包括 `summaryRole`（默认 `"user"`）、`recoveryHint`、`protectedMessage`、`stripHistoricalImages`（默认 `false`）、`onBeforeFold`、`onAfterFold` 和 `stubFor`。`keepRounds` 默认为 `6`。如果未配置 `context` 或预算，循环不会压缩。如果配置了预算但没有策略，超出预算时循环使用滑动窗口回退。

```js
computeBudget({ contextWindowTokens, maxOutputTokens }) => number
```

`computeBudget` 从 `contextWindowTokens` 中扣除 `maxOutputTokens` 和安全余量；余量取 `2000` token 与上下文窗口 10% 两者中的较大值，并向上取整。两个输入都必须是安全整数 token 数量，所得预算必须为正数。

内置策略为：

```js
createSlidingWindowStrategy(options = {})
createFoldStatisticalStrategy(options = {})
createFoldLlmStrategy({
  summarizer,
  maxSummaryTokens = 800,
  ...options
})
```

三者都会分组并移除完整轮次。`fold-statistical` 会记录确定性的工具足迹、折叠存根和有界的产物导航记录。`fold-llm` 使用折叠载荷调用注入的 `summarizer`，并通过 `enforceSize` 确定性地强制摘要大小。两种折叠策略都会保留 `foldedPayload` 以便归档恢复。

当配置的策略仍使请求超出预算时，循环首先回退到保留数为零的滑动窗口，然后使用确定性的安全截断。最终回退会按需裁剪未受保护的字段、移除图像、清空工具输入并降级受保护消息；`compactionStats[].protectedDowngraded` 会记录这类降级。无法容纳的单个受保护消息会产生 `KitError("invalid_budget", ...)`。

#### Tool-result TTL 折叠

独立于上下文压缩，旧的或较大的工具结果可以在 provider request view 中折叠。`toolResultTtl` 默认是 `2` 轮（`0` 表示禁用），`toolResultFoldMinTokens` 默认是估算的 `4000` token。在 `age === ttl - 1` 时，warning round 会要求模型使用 `note_take` 提取重要事实；达到 TTL 后，request view 会将结果替换为 navigation digest，并在适合的 JSON 内容中附带 JSON skeleton。checkpoint 和 transcript 持久化保留完整工具结果文本。`note_*`、todo、错误以及显式保护的结果不会折叠。

### 3.4 模型配置提供器

```js
createStaticModelConfigProvider(configOrSlots)
createEnvModelConfigProvider(prefix = "LLM_KIT_")
createJsonFileModelConfigProvider({ path })
resolveApiKey(config = {})
```

`createStaticModelConfigProvider` 接受一个配置对象或 `{ slots: { default, ... } }`。其 `resolve(slot = "default")` 选择请求的槽位，找不到时回退到 `default`。JSON-file 提供器要求一个包含 `slots` 对象的 JSON 对象，并使用相同的槽位回退。环境提供器从给定前缀读取一个配置，并忽略槽位参数。

`resolveApiKey` 依次检查 `apiKey`、由 `apiKeyEnv` 指定的环境变量，以及由 `apiKeyFile` 指定的文件。凭据文件可读取但对组/其他用户可读时会发出警告，不会拒绝。解析后的配置由宿主传给提供器工厂。

### 3.5 `TranscriptStore`

```js
/**
 * @typedef {Object} TranscriptStore
 * @property {(runId:string, record:object) => Promise<void>} appendRound
 * @property {(runId:string) => Promise<object[]>} load
 * @property {(runId:string, state:string) => Promise<void>} markRunState
 * @property {(runId:string, state:object) => Promise<void>} saveRunState
 * @property {(runId:string) => Promise<object|undefined>} loadRunState
 * @property {(runId:string, checkpoint:object) => Promise<void>} saveCheckpoint
 * @property {(runId:string, checkpoint:object) => Promise<void>} appendCheckpoint
 * @property {(runId:string) => Promise<object|undefined>} loadLatestCheckpoint
 */
```

内存实现是进程内 `Map` 的克隆。文件实现将每行一个 JSON 对象存储在 `<safeRunId(runId)>.jsonl` 中，并将当前运行状态存储在 `<safeRunId(runId)>.state.json`、最新 checkpoint 存储在 `<safeRunId(runId)>.checkpoint.json` 中。`appendRound` 通过 `dedupKey`、`roundKey` 或存储器生成的 run/round key 实现幂等。

该存储器设计为每个 `runId` 和每个进程一个写入方。它会修复缺少末尾换行符的完整 JSONL 记录，并隔离不完整的尾部片段。跨进程锁定不属于存储器契约。

`runToolLoop` 在提供 store 时默认使用 `persistence: "required"`，并在 provider 调用前校验全部八个方法；`persistence: "none"` 是显式的完全 no-op 模式。required 写入复用 loop retry 策略，重试耗尽后通过 `diagnostics.error` 发出 `persistence_error`，并以 `persistence_failed` 终止。checkpoint 在工具前后都执行：前置失败报告 `sideEffect: "not_started"` 且阻止工具执行；后置失败报告 `sideEffect: "executed_uncommitted"`，同时保留 `checkpoint_failed` 错误类。恢复会按原始顺序重放待处理的工具调用；宿主仍必须使有副作用的 `executeTool` 实现具备幂等性。

安全文件名命名空间会让匹配 `[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*` 的简单 ID 保持可读，但 `"."`、`".."` 和保留的 `run-h-` 前缀除外。其他 ID 会变成 `run-h-` 加其 SHA-256 摘要的前 24 个十六进制字符。

### 3.6 工具提供器与 `ToolRegistry`

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

执行器映射是由代码拥有的能力集合。`ToolProvider` 选择 schema，并可以覆盖描述和约束，但不能引入注册表中不存在的执行器。对于此类 schema，`resolveTools` 会以 `KitError("tool_unknown_executor", ...)` 失败。注册表执行会在调用执行器前校验 `required`、属性 `type` 和 `maxLength`；无效输入会变成错误字符串，不会到达执行器。不使用 `createToolRegistry` 的直接 `runToolLoop` 调用方须负责自己的输入校验。

static 和 JSON-file 提供器选择 `sel.set` 或 `default`。composite 提供器按提供器顺序以名称合并 schema。`erix-agent/tools` 子路径导出工具注册表和工具 provider。这些是显式选择的助手，不是安装到 `runToolLoop` 中的隐式工具集（原有的 path-jail 与 file-tools 助手已在 0.5.1 窗口移除；按 ADR-009，本库不提供安全边界）。模型侧取回采用 note-first：先使用 `note_list`，再使用 `note_read`；transcript recall API 已在 0.8.0 退役。

## 4. 源码布局

```text
src/
├── index.js                  # 公共根导出
├── loop.js                   # 薄转发垫片（runToolLoop / parseReflectionDecision）
├── assembly.js               # AssemblyPort 校验与 port→options 转换
├── run-state.js              # 有界的确定性与语义运行状态
├── tokens.js                 # 无依赖的 token 估算
├── loop/                     # 编排核心
│   ├── orchestrator.js       # runToolLoop 主循环（轮循环、wrapup、治理接线）
│   ├── provider-runner.js    # provider 调用、重试与快照回滚
│   ├── checkpoint-executor.js# 工具前后检查点与单轮聚合闸门
│   ├── budget.js             # 预算校验与状态克隆辅助函数
│   ├── aggregate-budget.js   # 单轮聚合输出闸门（issue #32）
│   ├── tool-result-ttl.js    # 旧工具结果的 request-view TTL 折叠（issue #32）
│   ├── termination.js        # 终态归类
│   ├── resume-manager.js     # 断点恢复与 run-state 应用
│   ├── error-ledger.js       # 重复错误记账
│   ├── messages.js           # 消息/block 辅助函数（tool-result 合并、文本抽取）
│   ├── reflection.js         # 反思提示与决策解析
│   ├── task-brief.js         # judge/reflection/wrapup 的任务简报选取
│   ├── abort.js              # 中止信号辅助函数
│   └── block-helpers.js      # block 访问辅助函数
├── providers/
│   ├── anthropic.js          # Anthropic Messages 请求与流式传输
│   ├── errors.js             # KitError 与提供器错误分类
│   ├── openai.js             # OpenAI chat/completions 请求与流式传输
│   ├── payload.js            # 提供器 payload 选项与超时解析
│   └── timeout.js            # 请求与流式超时协调
├── messages/
│   ├── anthropic.js          # 规范 <-> Anthropic 转换与 SSE 组装
│   ├── canonical.js          # 规范块与 OpenAI 转换
│   ├── openai-normalization.js # OpenAI usage/stopReason 归一化与流聚合器
│   └── rounds.js             # 消息校验与轮次分组
├── compact/
│   ├── budget.js             # computeBudget
│   ├── enforce-size.js       # 确定性字段裁剪
│   ├── fold-llm.js           # LLM 驱动的整轮折叠
│   ├── fold-statistical.js   # 确定性的整轮折叠
│   ├── anchors.js            # 机械锚点抽取（路径/SHA/issue/URL/错误行）
│   ├── fold-fidelity.js      # 用户输入逐字引用与反向信号检测
│   ├── helpers.js            # 共享的折叠选择与钩子辅助函数
│   └── sliding-window.js     # 整轮滑动窗口折叠
├── store/
│   ├── file.js               # JSONL transcript、状态与 checkpoint 存储
│   ├── memory.js             # 进程内 transcript、状态与 checkpoint 存储
│   └── notes.js              # 宿主侧 notes 存储
├── config/
│   ├── api-key.js            # 直接、环境和文件密钥解析
│   ├── env.js                # 基于环境的模型配置
│   ├── json-file.js          # 基于 JSON 文件的模型配置
│   └── static.js              # 静态模型配置
├── reflection/
│   ├── governor.js           # 确定性的续接与停止决策
│   ├── judge.js              # 客观时间线与 judge 解析
│   ├── l0.js                 # 客观工具结果事实与摘要解析
│   └── wrapup.js             # 回合结束 JSON 解析与规范化
└── tools/
    ├── index.js               # erix-agent/tools 子路径导出
    ├── providers.js           # static、JSON-file 和 composite ToolProvider
    └── registry.js             # 由代码拥有的执行器/schema 注册表
```

根导出是 `src/index.js`；可选的参考工具通过 `erix-agent/tools` 子路径导出。当前目录树特意不包含 `src/providers/index.js`。

## 5. 不变量

1. 工具实现属于宿主。`executeTool` 是循环使用的唯一执行边界。
2. 规范工具调用轮次按完整的 assistant/tool-result 组折叠，因此正常压缩不会产生孤立的工具消息。
3. 整轮策略会将 system 消息和首个真实 user 消息保留在头部。如果请求仍超出预算，紧急安全截断回退可以减少或移除未受保护的内容。
4. LLM 生成的折叠摘要在插入上下文前会经过确定性的尺寸强制。
5. 上下文压缩可以返回用于持久化的 `foldedPayload`；tool-result TTL 折叠只改变 provider request view，checkpoint 保留完整的工具结果文本。
6. 库源码中不嵌入 secret。API key 可以直接提供，也可以通过 `apiKeyEnv` 和 `apiKeyFile` 间接解析。
7. 执行器注册表由代码拥有。JSON 或其他提供器数据可以选择和约束暴露的 schema，但不能添加可执行能力。
8. 只有 `verification.status === "verified"` 这一结果状态允许宿主将 `finalText` 视为经过 final-guard 验证。`skipped`、`unverified` 和 `error` 需要宿主按自身规则处理。
