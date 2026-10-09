# 宿主消费者契约

> 英文版：[host-consumer-contract.md](host-consumer-contract.md)
> 同步基线：host-consumer-contract.md @ 2026-10-09（已同步 #197 技能加载器注册（`bundledDir` 归调用方、库内不猜层级、内置 < 全局 < 项目的优先级、不阻塞且可枚举的 `{skillId, dir, error}` 失败形状、产出即 `ToolSchema`、无新沙箱）与 `skillsLoaderContract` 套件；#184 文件工具注册（`allowRead`/`allowWrite` 谓词与「false → 错误结果而不抛」属 Stable、marker 字面量属 Experimental → #188 三层分级；追加轮 A：`rg` 默认翻回**正则**与真实命令一致、`is_regex=false` = `rg --fixed-strings`/`grep -F`、不读 `.gitignore` 与硬编码 vendor 跳过的偏离声明）；#165 judge 记录关联字段与 run 级 outcome 汇总事件；#167 压缩策略选择（`context.strategy` 名字|对象、fold-llm 默认 summarizer 的成本与 usage 记账）；#170 终止裁决决策表；#182 模型元数据与预算推导 + 多模型槽位装配示例与一次性 `model_metadata_missing` 诊断事件；#181 provider 请求注入口 defaultHeaders/extraBody；#173 观察者回调抛错统一隔离；#183 重试预算（`retry` 默认 false / 两条独立循环 / 不覆盖清单 / 可断言观测点）与契约测试套件定位（漂移哨兵≠宿主一致性测试、标准注入用法、套件清单）；#157 appendUserTurn 成对可选快路径探针；0.16.0 宿主保真、同轮保序契约与升级指南指针）

本文定义 `erix-agent` 的宿主集成边界。引擎维护可审计的运行事实；工具权限、归档策略、
重试/重跑策略以及最终消费决策归宿主。责任边界见
[ADR-012](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/012-engine-truth-model-efficiency-host-policy.md) 与
[ADR-013](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/013-guard-charter.md)。0.6.0 迁移步骤见
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md)；0.12.0 notes 契约迁移步骤见
[host-upgrade-guide-0.12.0.md](host-upgrade-guide-0.12.0.md)；0.16.0 store 保真、同轮保序与
展示投影增量变更的迁移步骤见
[host-upgrade-guide-0.16.0.md](host-upgrade-guide-0.16.0.md)。

## `runToolLoop` 选项与工具执行契约

`runToolLoop` 只接受以下顶层选项键。陌生键抛 `TypeError`，不再被静默忽略。宿主的私有
元数据必须放进显式命名空间，例如 `toolContext` 或 `context`。

```text
assemblyPort, provider, system, wrapup, initialUserMessage, initialMessages, tools,
writeToolNames, writeToolPathKeys, executeTool, maxRounds, maxTokens,
temperature, topP, timeoutMs, deadlineMs, reflection, stallDetection, retry,
completion, finalGuard, finalGuardMaxRetries, finalGuardTimeoutMs,
maxTokenContinuations, toolResultTtl, toolResultFoldMinTokens, context,
todoStateProvider, semanticStateProvider, partialPersistence,
modelConfig, modelMetadata, model, expert, user, task, session, requestId,
toolContext, store, persistence, runId, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent
```

`partialPersistence` 默认为 `false`，保持既有的流式零写入行为。设为
`{ intervalMs, minBytes? }` 可启用按间隔节流的部分 assistant 文本快照。它复用既有的
latest-only `saveRunSnapshot` capability，不引入新的 store 方法；缺该 capability 时
不发生部分写入。恢复时，较新快照中形状完好的 `partialText`/`partialRound` 会被作为
assistant 文本消费，而不带这些字段的旧快照保持既有行为。设了 `minBytes` 时，比它小的
单个 delta 不会触发写入；当间隔损失界限必须作用于每一个到来的 delta 时就不要传它。
前提：设 `stream: true`，否则启动即抛。

`executeTool` 边界只有一种调用形态，不做 arity 协商：

```js
executeTool({ id, name, input, context, signal })
```

规范的执行结果只有三种形态：

- `string`
- `{ content, metadata?, success? }`
- `Error`

旧的 `{ data, success, ... }` 形态与其他鸭子类型形态为兼容起见仍被宽松归一化，但已废弃，
不得依赖。

## 观察者回调抛错（issue #173）

宿主共有九个回调在观察一个 run：八个事件通道 `onEvent`、`onRound`、`onToolResult`、
`onJudge`、`onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage`，加上错账户本身
（`onObserverError`）。**其中任何一个抛错，都是「记一笔、继续跑」**——后果只有一种。
改动之前同一类故障有三种后果：`onEvent`、`onRound`、`onToolResult` 抛错会以
`termination.reason: "failed"` 杀掉整个 run，流式通道经 `onObserverError` 上报，而
`onJudge` 消失在一个裸 `catch {}` 里。

```text
观察者同步抛错，或返回 rejected Promise（onRound / onToolResult）
  └─ reportObserverError(error, { channel, … })   src/loop/orchestrator.js:763-783
       ├─ onObserverError(error, context)         宿主错账户，同步调用
       └─ console.error("Observer callback error:", error, context)
                                                  未配置错账户、或错账户自己抛错时
```

1. **run 继续跑。** 任何观察者错误都改变不了 `termination.reason`、返回结果与已落盘的
   内容。`onRound` 抛错时该轮已经 `appendRound` 落库，后续轮照跑；`onToolResult` 抛错时
   工具结果照常送给模型；`onEvent` 抛错后引擎继续发事件（事件流不再在第一次宿主失败处
   断裂）。仍能终结 run 的只有引擎自己的路径：见「终止裁决决策表（issue #170）」。
2. **每一笔上报都报出自己的通道。** `onObserverError(error, context)` 收到的是一个普通
   对象，恒带 `channel`——即回调名，引擎若未给出则为 `"unknown"`；宿主传了 `runId` 选项时
   恒带 `runId`，因此并行跑多个 run 的宿主能把错误归因到具体 run。下表列出每个通道额外的
   字段全集，均为 additive 字段，宿主不得要求更多：

| `context.channel` | 额外字段 | 引擎防护点 |
|---|---|---|
| `onEvent` | `type`，事件自带 `round` 时再带 `round` | `emitEvent`（`src/loop/orchestrator.js:1517-1531`） |
| `onEvent`（启动期诊断） | `type: "model_metadata_missing"`，或 `type: "persistence_capability_degraded"` 加 `method` | `notifyCapabilitySkipped` / `notifyModelMetadataMissing` 里的本地防护（`src/loop/orchestrator.js:847-900`）：这两条路径在 `emitEvent` 定义之前就触发，因此直调 `onEvent` |
| `onRound` | `round` | `src/loop/orchestrator.js:3122-3130` |
| `onToolResult` | `toolName`、`round` | `src/loop/run-snapshot-executor.js:266-294` |
| `onJudge` | `round`、`kind` | `emitJudge`（`src/loop/orchestrator.js:1544-1557`） |
| `onDelta`、`onReasoningDelta`、`onToolCall`、`onUsage` | `round`、`type`（流式事件类型） | `dispatchAttemptEvent`（`src/loop/provider-runner.js:96-110`） |

   启动期诊断事件即使宿主抛错也保持「每个 run 恰好一条」的去重承诺：去重标记在回调之前
   就已置位。
3. **观察者错误是 best-effort，且不在任何其他账上。** 它们永不进入
   `result.unpersisted`，不产生 `delivery_failure` 条目，也不写进 run state。要计数就
   由宿主自己在 `onObserverError` 侧累计；持久化的观察者错误计量另立课题（issue #173
   已定边界：按现状接受）。
4. **错账户自己不要抛。** `onObserverError` 抛错时引擎先打
   `Observer error reporter failed:`，随后回落到
   `console.error("Observer callback error:", error, context)`。两种情况 run 都不受影响。
   没配错账户时 console 那一行就是唯一信号，所以生产宿主必须自己配一个并计数。
5. **抛错不是宿主停机的手段。** 请用 `signal.abort()`：循环随即抛出标准的 `aborted`
   形状，并携带 issue #180 载荷（`error.usage` / `error.rounds` / `error.finalText`）。
   原先靠「sink 抛错」终止 run 的宿主必须迁移到 abort 信号——现在抛错只会上报。
6. **回调必须同步返回。** 只有 `onRound` 与 `onToolResult` 是被 await 的，因此也只有这两
   条通道同时隔离 rejected Promise 与同步 throw。`onEvent`、`onJudge` 与四条流式通道只接
   同步 throw：`async` 回调稍后 reject 的 Promise 会以 unhandled rejection 逃到宿主侧。
   请保持回调同步，或在回调内部自己把异步包起来。
7. **`onToolResult` 是数据改写钩子，不是纯观察者。** 它的返回值会**替换**工具结果（返回
   `undefined` 才保留引擎结果），所以它失败时有数据后果：异常 fallback 是
   **原样保留的引擎执行结果**——绝不是部分改写、也不是空结果——外加一条带 `toolName` 与
   `round` 的 `channel: "onToolResult"` 上报。在这个 hook 里做脱敏、裁剪、格式改写的宿主
   必须自己防住自己的逻辑：脱敏函数一抛错，送给模型的就是未脱敏的引擎原始结果。

这条通道只覆盖上述回调。`executeTool` 的错误会变成工具结果，`onPersistenceError` 与
`diagnostics.error` 走持久化账本与 `delivery_failure`（见「持久化失败上报」），
`finalGuard` 以 `verification.status: "error"` 呈现，`reflection.onReflection` 与压缩钩子
`onBeforeFold` / `onAfterFold` 的未捕获抛错仍会抵达 `fail()`，`todoStateProvider` 与
`semanticStateProvider` 则以 `status: "error"` 的 run-state 片段呈现。别把观察者隔离
外推到这些回调上。

## Provider 请求注入口（issue #181）

`createOpenAIProvider` 与 `createAnthropicProvider` 新增两个完全可选的选项，让宿主无需
包装 `fetchImpl` 就能给自己的请求打上归因标识（会话级 / run 级）：

```js
const provider = createOpenAIProvider({
  endpoint, apiKey, model,
  defaultHeaders: { "X-Station-Run-Id": runId, "X-Station-Session-Id": sessionId },
  extraBody: { user: `${fde}:${sessionId}` },
});
await provider.chat({ messages });
```

- `defaultHeaders` 是**追加**到引擎自有请求头之后，引擎头的值与顺序保持不变。引擎头
  不可被覆盖：宿主传入与 OpenAI 侧 `Authorization` / `Content-Type` 或 Anthropic 侧
  `x-api-key` / `anthropic-version` / `content-type` 同名（大小写不敏感）的键时，在
  **构造时**抛 `TypeError`，而不是静默忽略。值为 `undefined` / `null` 的键跳过（供宿主
  条件注入）；其余值必须是字符串、数字或布尔，且不得包含 CR、LF、NUL。
- **header 值不得进入错误文案与日志。** 该注入口新增的每一条文案只写 header 名字，不写
  值 —— 与 `apiKey` 脱敏同口径，因为宿主会把网关 key 放进 header。
- `extraBody` 在引擎组装**之后**合并进 JSON 请求体，因此引擎自有字段永远优先，宿主无法
  悄悄改掉 `stream` 或 `model`。保留字段为 `model`、`messages`、`system`、`tools`、
  `max_tokens`、`temperature`、`top_p`、`stream`、`stream_options`、`frequency_penalty`、
  `presence_penalty`、`response_format`；宿主传保留字段一律丢弃，与引擎当次请求已写入的
  字段同名（例如经 `providerOptions` 带进来的）同样丢弃。
- 每一个被丢弃的字段都会通过 `console.warn` 向 stderr 告警，只带字段名（不带值），且每个
  provider 实例每个字段只说一次：保留字段在构造时告警，逐请求冲突在首次出现时告警。
- 两个注入口都在构造时取**顶层**快照：事后改宿主自己的对象不会改变线上行为；但
  **`extraBody` 里的嵌套对象仍按引用共享**——需要稳定的值请自行深拷贝/冻结。宿主本来就是按 run
  构造 provider，这也正是设计粒度。
- 两个参数都不传时，发出的请求头与请求体与之前版本**逐字节一致**。`providerOptions` 仍是
  payload 逃生口，对核心字段依旧**静默**丢弃；`extraBody` 是会告警的那条通道。

预算元数据是另一份契约：模型 slot 能携带哪些字段、按什么顺序被探测、loop 何时发出一次性的
`model_metadata_missing` 诊断事件，全部在下文「模型元数据与预算推导（issue #182）」里定义
（issue #182）。

## 重试预算（issue #183）

**不配置就是不重试。** `retry` 默认 `false`（`src/loop/orchestrator.js:566`），在该状态下
引擎每轮**恰好**发一次 provider 调用、每次 store 调用**恰好**写一次。想要重试的宿主必须显式
要求；没要求的宿主不得假设一次 provider 调用会被重发。本节就是完整规则集；它的终局一面是
下文「终止裁决决策表（issue #170）」里的 `failed` 行。

### 派生值

只有**对象**才会打开重试：`retryOptions = retry && typeof retry === "object" ? retry : null`
（`src/loop/orchestrator.js:713`），所以 `retry: true` **不是**「启用重试」——它与完全不写
该选项完全等价。

| 输入 | 生效值 | 推导 |
|---|---|---|
| `retry` 缺省 / `false` / `true` | `retryAttempts = 0`，完全没有重试路径 | `:713-715` |
| `retry: {}` | `retryAttempts = 2` → 每轮最多 3 次 provider 调用 | `Number.isInteger(attempts) ? Math.max(0, attempts) : 2`（`:714-718`） |
| `retry: { attempts: n }` | **整数** `n` 取 `Math.max(0, n)` | `:716-717` |
| `retry: { attempts: 2.5 }` / `{ attempts: "2" }` | 静默变 `2` —— 非整数值被丢弃，从不校验 | `:716`，回落 `:718` |
| `retry: { attempts: -1 }` | `0`（夹取，不报错） | `:717` |
| `retry.backoffBaseMs` | 缺省或非有限值时 `1500`；负数夹到 `0` | `:719-721` |
| `retry.backoffMaxMs` | 缺省或非有限值时 `10000`；负数夹到 `0` | `:722-724` |
| `retry.sleepImpl` | `defaultSleep`（`src/loop/abort.js:16`）；宿主传值按 `sleepImpl(delay, signal)` 调用 | `:725`、`:885`、`:1636-1641` |

第 *n* 次重试（0 起始）前的等待在两条循环里都是
`Math.min(backoffBaseMs * 2 ** n, backoffMaxMs)`
（`src/loop/provider-runner.js:246-249`、`src/loop/orchestrator.js:881-884`）。睡眠是
可中断的：run 的 signal 会传给 `sleepImpl` 并被 `waitForRetry` 竞争
（`src/loop/orchestrator.js:1636-1641`），因此在退避等待期间 `signal.abort()` 抛出的是
标准的 `aborted` 形状，携带 issue #180 的载荷。

只有被标为 `retryable === true` 的错误才会被重试
（`src/loop/provider-runner.js:219`）。该集合是 `KitError.code` ∈ `timeout`、
`rate_limited`、`server`、`disconnect`（`src/providers/errors.js:1,14-16`），经
`classifyHttpError` 得知的 HTTP 408/429/5xx（`:86-99`），经 `classifyFetchException`
得知的可重试传输失败（`:141-172`，由 `isRetryableNetworkException` `:123-132` 判定），
以及一条既无文本、也无工具调用、也无推理的 assistant 消息
（`src/messages/canonical.js:448-454`）。其余一切 —— `auth`、`aborted`、选项校验抛的
`TypeError`、宿主 store 的 bug —— 首次见到就原样重抛。

### 一个选项，两条独立循环

同样三个数字喂给两条**计数器相互独立**的循环。它们不会相乘，宿主不得把它们建模成一个
全局尝试预算：

| 循环 | 坐标 | 门槛 | 预算 |
|---|---|---|---|
| 每轮 provider 调用 | `src/loop/provider-runner.js:33-263`（`callProvider`） | `retryOptions !== null` **且** `error.retryable === true`（`:219`） | **每轮** `retryAttempts + 1` 次 provider 调用；一个 run 因此封顶于 `maxRounds × (retryAttempts + 1)` |
| 持久化 store 写入 | `src/loop/orchestrator.js:872-888` | 同一组数字，**没有** `retryable` 门槛 | **每次 store 调用** `retryAttempts + 1` 次写入，与 provider 循环无关 |

持久化重试绝不会重发 provider 调用，provider 重试也绝不会重写记录。
`retry: { attempts: 0 }` 与 `retry: false` 在观测上等价：一次 provider 调用、一次 store
写入、没有 `recovering` 事件，且 `attempt` 事件上 `maxAttempts: 1`。

### 这条预算不覆盖什么

不要把它外推到引擎其余部分：

- **工具从不重试。** 失败的 `executeTool` 变成一条 `is_error` 的 `tool_result`；要不要
  重跑是宿主的决定（见「工具重放策略（issue #139）」，那一节说的是 resume，不是重试）。
- **轮外补全各只有一次尝试**：收尾调用（`src/loop/termination.js:234`）、收尾/`judge`
  文本归一化器（`src/reflection/wrapup.js:132-135`）、以及 `fold-llm` 默认 summarizer
  （`src/loop/orchestrator.js:1063-1073`）。它们都不消耗本预算。
- **run 本身从不重试。** 整 run 重跑/重排队策略属于宿主（ADR-012），而
  `maxTokenContinuations`（默认 `3`）与 `finalGuardMaxRetries` 是另外的预算：前者续写被
  `max_tokens` 截断的响应，后者重新询问终答 guard。两者都不是错误重试预算，也不受
  `retry` 影响。

### 流式：同一份预算，一处需要知道的行为变化

**不存在第二个流重试计数器**。对 `stream: true` 的 run 而言，上面那条循环*就是*流恢复：
`recovering` / `recovered` 是它的事件面，失败的尝试会先回滚到尝试前快照，再重新请求
整个补全（`src/loop/provider-runner.js:224-243`）。

- `DEFAULT_STREAM_RECOVERY_MAX_ATTEMPTS` **不是本包里的标识符**（grep 证真）。被当作它的
  值引用的那个 `2`，其实是 `src/loop/orchestrator.js:714-718` 的 `retryAttempts` 回落值。
  CLI 自己的那个 `2` 来自 `ERIX_RETRY_ATTEMPTS`（`bin/cli.js:828-836`），CLI 把它作为
  `retry: { attempts: … }` 传下；**库**默认仍是 `false`，所以「把 CLI 行为抄进宿主」正是
  这个数字被误归因的方式。
- `partialPersistence` 是持久性而非重试：它提交一个将死尝试的部分文本
  （`onPartialAttemptEnd({ retrying: true })`，`src/loop/orchestrator.js:1919-1933`），
  不额外增加任何尝试。
- **值得在你自己的测试里断言的一个副作用：**当 `retryAttempts > 0` 时，流式观察者回调会
  按尝试缓存，只在该尝试成功后才-次派发
  （`src/loop/provider-runner.js:111-117`，在 `:192-194` 冲刷），于是
  `onDelta`/`onReasoningDelta`/`onToolCall`/`onUsage` 是在尝试末尾一次到达而非逐段到达。
  `retry: false`（或 `attempts: 0`）时它们逐段到达
  （`src/loop/provider-runner.js:112-115`）。因此启用重试会改变你的渲染节奏；这是上游
  行为，不是宿主 bug。

### 宿主可断言的观测点

| 想钉住什么 | 可断言的通道 |
|---|---|
| 每轮 provider 尝试数 | `attempt` 事件 `{ type, round, attempt, maxAttempts }`（`src/loop/provider-runner.js:86-91`）；`maxAttempts === retryAttempts + 1`，所以宿主无需知道选项值就能断言这个上限 |
| 重试真的发生了 | `recovering` 事件（`src/loop/provider-runner.js:252-258`）；`recovered` 标记重试后成功的那一次（`:188-191`、`:203-206`） |
| 退避时序，且不付墙钟代价 | 注入 `retry.sleepImpl` 并记录每一个 `delay` —— 条数就是实际发生的重试次数，记录到的值能钉死 `min(base × 2ⁿ, max)` 公式 |
| 没有 N×M 的 provider 放大 | 你自己的 provider 包装的请求计数器，对着 `attempt` 事件对、也对着 `maxRounds × (retryAttempts + 1)` 断言 |
| store 写入重试 | **不存在逐尝试事件。** 唯一信号是两条循环走完后的终局 `persistence_error` 上报（`src/loop/orchestrator.js:889-896`）；包上你自己的 store 方法计数，这是目前唯一能证明 store 侧循环跑过的办法 |

遗留（issue #183）：运行结果不携带聚合的尝试/重试计数，因此每 run 总量得宿主自己从事件
里拼。今天**不承诺**可持久化的重试计数器；请把 `attempt` / `recovering` / `recovered` 与
`retry.sleepImpl` 当作受支持的观测点全集。

## AssemblyPort

装配完整 run 的宿主可以只提供一个经过校验的组合根，而不必重复逐项接线：

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider
  provider,    // Provider
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // 可选 TranscriptStore
  session: { id, resume?, initialMessages? },
  policy?,     // 显式 run 选项
  emit?,       // (eventType, payload) => void
});

await runToolLoop({ assemblyPort });
```

传给 `createAssemblyPort` 时，`modelConfig`、`provider`、`tools`、`store`、`session`
和 `policy` 也可以是同步的零参工厂。启动时必须具备 `modelConfig.resolve`、
`provider.chat` 或 `provider.chatStream`、`tools.definitions`、`tools.executeTool`、
`session.id`。若提供 `store`，它必须具备两个必需方法 `appendRound` 与 `load`；
缺必需方法在 run 开始前抛 `TypeError`。`policy` 只装具名的 `runToolLoop` 选项；
陌生 policy 键会被拒绝。

### TranscriptStore capability 分级（issue #78）

原 "checkpoint" 表面更名为 **run snapshot** 并降级为可选 capability。实际语义从来就是
latest-only 自动保存（每轮覆盖同一槽位、仅用于中断恢复现场），从来不是多版本 checkpoint。
分级如下：

| 分级 | 方法 | 缺失时行为 |
| --- | --- | --- |
| 必需 | `appendRound`、`load` | assembly/startup 抛 `TypeError` |
| 可选 run snapshot | `saveRunSnapshot`、`loadLatestRunSnapshot` | 跳过快照持久化；run 正常跑完，仅不支持中途 crash resume |
| 可选 run-state | `saveRunState`、`loadRunState`、`markRunState` | 跳过 run-state 持久化；run 正常跑完 |
| 宿主面向的可选终态读取 | `loadRunStateStatus` | 引擎不调用、不校验；缺失不会发出 capability 降级事件 |
| 可选预写快路径探针（issue #157） | `loadByDedupKey`、`loadMaxRound` | `appendUserTurn` 回退全量 `load`（成对生效：只实现其一等同全不实现） |

`loadRunStateStatus` 解析为终态**字符串**——`(runId: string) => Promise<string | undefined>`，
该 run 未记录终态时返回 `undefined`——不是状态记录对象（与 `src/store/memory.js` /
`src/store/file.js` 的源 typedef 一致）。

可选方法缺失时，引擎对每个缺失方法只发**一条**
`persistence_capability_degraded` 事件（`{type, runId, method, detail}`），
随后整轮 run 跳过对应持久化——不每轮刷屏。`getToolMetadata` 与 `emit` 仍是可选项。

### 工具重放策略（issue #139）

工具 schema 可以在每个规范 `tools` 定义上声明 `replay: "safe" | "unsafe"`；省略即
`unsafe`，其他取值在启动时被拒绝。该声明是引擎元数据，不会发送给模型。run snapshot
会把解析后的声明持久化到每个 `pendingToolUses` 条目上，因此恢复时使用发起该工具调用
时记录下来的意图。

`replayPolicy` 默认为 `"always-replay"`，无论声明如何都保持既有的续跑行为。选择
`"per-tool-declaration"` 则只重放被记录为 `safe` 的条目。unsafe 条目（包括没有
`replay` 字段的旧快照）不会被执行；模型会收到一条 `tool_result`，带
`executionStatus: "interrupted"`、`is_error: true`，外加解释说明以及 run snapshot 中
可用的已捕获输出。引擎发出可选的 `tool_replay_decision_required` 事件，带 run/tool 的
ID 与 `requiresHostDecision: true`。任何后续处置决策归宿主；引擎不会调度或重试该工具。

`saveRunState`/`loadRunState` 管理每个 run 的单份 latest-only 结构化快照，不保留版本历史。
新写入的快照不再持久化 `state` 键；`markRunState` 通过独立通道写终态。宿主需要读取终态时，
应使用可选的 `loadRunStateStatus`（返回终态字符串，`Promise<string | undefined>`；形状见上方
说明）。引擎不会调用或校验这个宿主面向的方法。该方法优先读取独立
status，再回落读取旧 `.state.json` 数据内嵌的 `state`。`loadRunState` 对旧快照对象仍原样透传，
包括其中的 `state` 键。仅当 status 文件不存在时才回落；status JSON 损坏或解析后没有字符串
`status` 时会抛错，不会回落到可能过期的旧值。

**迁移指引。** 将宿主的 `loadRunState(runId).state` 改为 `loadRunStateStatus(runId)`；继续用
`loadRunState` 读取 `stateVersion`、`deterministic`、`semantic` 等快照字段。旧的内嵌终态仍可读取，
但新写入的快照不再带 `state`。

**更名与合并。** `saveCheckpoint` → `saveRunSnapshot`，
`loadLatestCheckpoint` → `loadLatestRunSnapshot`。`appendCheckpoint` **并入
`saveRunSnapshot`**：两者本来就是同一语义的 latest-only 覆盖写，单独保留 "append"
只会误导出"有版本"的错觉。file store 的快照落盘文件改为 `<runId>.snapshot.json`
（原 `<runId>.checkpoint.json`）；读取时新后缀不存在则回落旧后缀（读取兼容，不做数据迁移）。

**过渡期别名（deprecated）。** 库内 store 仍保留
`saveCheckpoint` / `appendCheckpoint` / `loadLatestCheckpoint`，标记 `@deprecated`
并内部委托新方法。只实现旧名的第三方 store 继续可用：引擎按
`saveRunSnapshot` → `saveCheckpoint` → `appendCheckpoint` 解析快照写入，
`loadLatestRunSnapshot` → `loadLatestCheckpoint` 解析快照读取。宿主应迁移到新名；
未来 major 版本可能移除别名。

**已知重复（已决策，未移除）。** 最新 run-state 被双写：既内嵌在每轮
round record（`RoundRecord.runState`）里，又经独立 run-state 方法
（`saveRunState`/`markRunState`）落盘。两份拷贝都是承重的，所以 issue #82 选择保留而非删除
其中一份——权威规则、以及被拒绝/推迟的备选见
[ADR-019](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/019-run-state-store-authority.md)。
独立 run-state（`saveRunState`/`loadRunState`）是 latest-only 权威状态；随 transcript
保存的 `RoundRecord.runState` 属于 history 侧的每轮快照。引擎恢复时优先采用有效的独立 state；
仅当独立 state 不存在时才回落到最新 record；若独立 state 存在但无效，则报告
`state_unavailable`，且不回落。

`modelConfig` 始终是 resolver 形态的 `ModelConfigProvider`——即便它是随 `assemblyPort`
一起显式提供的覆盖项。plain 配置对象会被拒绝并给出迁移提示，请用
`createModelConfigResolver(config)`（或 `createStaticModelConfigProvider(config)`）包装。

既有的细粒度 `runToolLoop` 选项继续受支持。两种形式同时存在时，先解析 AssemblyPort，
显式提供的细粒度选项覆盖对应的装配值。这样端口留在组合边界上，不包裹也不改动循环的注入
契约。若提供了 `emit`，它作为默认事件 sink；显式 `onEvent` 仍然优先。
`erix-agent/contract-tests` 的 `assemblyPortContract` 锁定这些启动与优先级规则。
装配形态的细粒度入口在第一次 provider 调用前执行同等的 provider、executor、
model-config、session 与 required 持久化 fail-fast 校验。`persistence: "none"`
不要求 TranscriptStore。

库内 `createAssemblyPort` 是参考装配实现，不做任何 I/O。CLI 继续使用它自己的文件型
provider、工具与 transcript 适配器，因此没有宿主需要一次性迁移到该端口。

## 模型元数据与预算推导（issue #182）

`modelConfig` 与 `modelMetadata` 是白名单选项名，但它们能携带哪些字段此前契约零字。
其中只有 `contextWindowTokens` 与 `maxOutputTokens` 这一对字段对引擎自己的预算推算
有分量（且必须成对），其余字段全部流向 provider 请求。两个预算字段都不写的宿主，
整个 run 的上下文压缩与单轮聚合输出预算都是关的，唯一的信号就是下文的
`model_metadata_missing` 事件。

### 探测顺序与槽位选择

| 探测位次 | 候选 | 需要装什么 |
|---|---|---|
| 1 | **已解析的** `modelConfig` | `modelConfig.resolve(session?.modelSlot)` 返回的对象——解析器本身从不被探测 |
| 2 | `modelMetadata` | 只承载元数据；没有其他地方读它 |
| 3 | `model` | `model` 选项对象 |
| 4 | `provider` | 两个内置工厂在构造时拿到 `contextWindowTokens` / `maxOutputTokens` 后，会将其回挂在返回的对象上（`src/providers/openai.js:575-584`、`src/providers/anthropic.js:541-550`） |
| 5 | `context` | 压缩上下文选项 |

- 探测按上述固定顺序 duck-type，返回**第一个**携带任一字段的候选
  （`src/loop/budget.js:59-69`，调用点 `src/loop/orchestrator.js:958-964`）。
  字段**从不跨候选合并**：slot 里只写 `contextWindowTokens`、`modelMetadata` 里只写
  `maxOutputTokens`，结果是什么预算也推不出来。这一对字段必须写在同一个对象里。
- `modelConfig` 必须是解析器（`{ resolve(slot?) }`）。直接把普通配置对象当
  `modelConfig` 传会在启动期抛 `assembly port is missing methods:
  modelConfig.resolve`——因为这个选项名一出现就被当成端口读
  （`src/loop/orchestrator.js:592-607`）。被探测的是**解析后的值**，不是解析器。
- 槽位选择是 per-run 的：槽位名经 `session.modelSlot` 传入
  （`src/loop/orchestrator.js:609-612`）。两个内置 provider 对不认识的槽位名都
  回落到 `default` 槽，所以拼错槽位名不会让这个 run 失败。
- `createJsonFileModelConfigProvider` 从 JSON 文件读
  `{ "slots": { "<name>": { … } } }`；`createStaticModelConfigProvider` 接内存里的同构形状。
  两者都是**原样**返回 slot，只额外物化一个 `apiKey`
  （`apiKey` → `apiKeyEnv` → `apiKeyFile`，`src/config/api-key.js:9-36`）。

### 字段契约

| slot 字段 | 单位 | 进 provider 请求 | 驱动预算 / 压缩 | 缺省行为 |
|---|---|---|---|---|
| `contextWindowTokens` | token（正安全整数） | 否 | **是**——预算输入，也决定输出截断上限的尺寸 | 推不出预算 → 压缩与聚合输出预算均关；上限退回 `4096` |
| `maxOutputTokens` | token（≥ 0 的安全整数） | 是，作为 `maxTokens` 缺席时的 `max_tokens` 默认值 | **是**——第二个必需的预算输入 | OpenAI 不写 `max_tokens`；Anthropic 用 `4096`；推不出预算 |
| `maxTokens` | token | 是——请求 `max_tokens`，优先于 `maxOutputTokens` | **否**，从不参与预算 | 字段省略 |
| `temperature` | 数值 | 是——`temperature` | 否 | 字段省略 |
| `topP` | 数值 | 是——`top_p` | 否 | 字段省略 |
| `thinking`、`reasoning`、`reasoning_effort`、`enable_thinking`、`chat_template_kwargs` | 因协议而异 | 是，原样拷进 payload | 否 | 字段省略；推理模型识别关闭 |
| `model_type`、`supports_reasoning`、`thinking_format` | 因协议而异 | 否，但它们会把端点标为推理模型并打开 stream-usage 探针；回挂在 provider 对象上 | 否 | 探针关闭 |
| `frequency_penalty`、`presence_penalty`、`response_format`、`providerOptions` | 因协议而异 | 是（`providerOptions` 里核心字段是**静默**丢弃的，见 #181） | 否 | 字段省略 |
| `timeoutMs`、`requestTimeoutMs`、`firstByteTimeoutMs`、`streamIdleTimeoutMs`、`streamTotalTimeoutMs`（snake_case 别名同样接受） | ms | 请求 / 流超时 | 否 | 引擎默认值 |
| `endpoint`、`apiKey` / `apiKeyEnv` / `apiKeyFile`、`model` / `model_name`、`protocol` | — | 端点与凭据身份；`protocol` 选的是**宿主自己**要构造哪个工厂——引擎从不按它分发 | 否 | endpoint / key / model 解析后为空时，provider 构造抛 `provider_config`（`src/providers/errors.js:37-51`） |

循环自身的 `maxTokens`、`temperature`、`topP` 选项会注入每一次请求，因此**覆盖**
slot 里的同名字段（`src/loop/provider-runner.js:128-130`、`src/providers/openai.js:51-55`）。

**slot 里的未知字段是惰性的，也是安全的。** 内置 provider 原样拷贝 slot
（`src/config/json-file.js:22-39`、`src/config/static.js:26-38`），两个工厂又只读固定的
参数列表（`src/providers/openai.js:110-153`、`src/providers/anthropic.js:290-334`），
所以认不出的键既上不了线，也不会抛错。这条安全声明只覆盖
**slot 对象**：*顶层* `runToolLoop` 选项写错名仍会抛 `TypeError`（见「`runToolLoop`
选项与工具执行契约」）。

### 预算推导

`budgetTokens = context.budgetTokens ?? computeBudget({ contextWindowTokens, maxOutputTokens })`，
其中 `computeBudget = contextWindowTokens - maxOutputTokens - max(2000, ceil(窗口 × 0.1))`
（`src/loop/orchestrator.js:984-993`、`src/compact/budget.js:9-33`）。
`budgetTokens` 是上下文压缩、单轮聚合输出预算、以及 request-view 预算块的总门。
输出截断上限是另一套推导：先看显式 `outputHygiene.limit`，否则
`clamp(15% × contextWindowTokens, 8192, 100000)`，否则 `4096`
（`src/loop/orchestrator.js:966-977`）。

| 启动时的条件 | 引擎行为 |
|---|---|
| 五个候选里两个字段都找不到 | **静默跳过**：`budgetTokens` 保持 `undefined`，压缩与聚合输出预算保持关，并且恰好发**一条** `model_metadata_missing` 事件 |
| 字段找到了但值非法（非整数、字符串、窗口 ≤ 0、`maxOutputTokens` < 0）或窗口不够大（算出的预算 ≤ 0） | `computeBudget` 在首次 provider 调用前**抛 `invalid_budget`** |
| 宿主自己给了 `context.budgetTokens` | 完全绕开推导——压缩是否启用只看这个值，且无论探测到什么**都不发**事件；非正 / 非整数值由 `validateBudget` 抛 `invalid_budget` |
| 宿主给了 `context.strategy` | 策略被询问时会原样拿到 `budgetTokens`，所以配了策略就能在零元数据下自己门控压缩（`src/loop/orchestrator.js:2200-2203`）；注意内置 sliding-window 策略也是拿这个值去比，`undefined` 时永不触发（`src/compact/sliding-window.js:34-36`） |

两种 `invalid_budget` 都是**运行前**抛错：运行生命周期尚未开始，抛出的错误不带
`termination`、`usage`、`rounds`、`finalText`（边界见「终局载荷（issue #176 / #180）」
里的范围声明）。

### 压缩策略选择（issue #167）

`context.strategy` 既接受策略**对象**（语义逐字不变），也接受内置**名字**
`"sliding-window" | "fold-statistical" | "fold-llm"`。名字在 **run 启动期一次性**解析成宿主自己
也能构造出的那个实例（`src/compact/strategy-resolution.js`，接入点 `src/loop/orchestrator.js:988-1003`），
因此下游 configuredStrategy 通道零改动。未知名字、空字符串、以及既不是字符串也不是对象的值，
都会在**首次 provider 调用前**抛 `TypeError` 并列出合法值——与上面同一种「运行前」抛错形状
（不带 `termination`/`usage`/`rounds`/`finalText`）。名字形态的策略还会接上 context 级的
`recoveryHint` 与 `stubFor`；对象形态依旧由宿主自己设在对象上，引擎绝不重写注入的对象——
手工 `createFoldLlmStrategy` 但缺 `summarizer` 时，仍按它自己的构造期 `TypeError` 失败。

`fold-llm` 名字形态会注入一个复用**本 run 主力 provider** 的默认 summarizer
（`src/compact/provider-summarizer.js`）：每次压缩一次无工具补全，输入是
`SUMMARIZER_PROMPT_GUIDE` + 被折叠消息的确定性序列化 + 被折叠轮次范围。成本与记账属于契约：

- **每次压缩多一次主力模型调用**，输入体量约等于被折叠的老轮次。因此 `fold-llm` 只能显式选用；
  默认 everywhere 仍是 `fold-statistical`（库层未配策略时仍为 `sliding-window`）。
- 它的 usage 走与其他辅助调用同一的 `addUsage` 路径并入 run 总账（`src/loop/orchestrator.js:979`，
  `trackLatest: false`），并通过 `onUsage` 上报，因此 `result.usage` / `error.usage` 是完整的。这次调用
  **不推 `rounds`**、不参与 stall 检测、也不更新后续压缩判断用的 `latestApiInputTokens` / `latestApiEstimatedTokens`。
- summarizer reject / throw / 返回空文本时，与注入式 summarizer 一样降级到统计摘要（下一轮上下文里
  会出现 `[fold-llm 摘要失败…]` 标记）。摘要失败不会杀死 run。
- 自己注入策略对象仍是覆盖通道（比如把 summarizer 接成便宜模型）。该形态下引擎**不**为摘要记账——由宿主自己算。

### 装配自检断言点

`model_metadata_missing`（`{type, runId, detail}`，每个 run 最多一条）就是宿主对自己
装配的断言点：指望压缩生效的宿主断言它**不出现**；故意不压缩的宿主断言它恰好出现一次。
`detail` 还报出实际解析到的输出上限，所以同一个断言也能接住「我的窗口没参与输出截断上限的计算」。
断言请在**启动之前**做，或者在装配后用 `signal.abort()`：这个启动期事件上 `onEvent` 抛错
不再是「拒掉 run」的机制，而是经 `onObserverError` 上报后 run 继续
（`src/loop/orchestrator.js:876-900`；见「观察者回调抛错（issue #173）」）。

### 多模型槽位装配示例（issue #182）

一份模型目录、一个模型一个 slot、每个 run 选一个 slot。把请求参数与预算元数据
放在一起，才能让 temperature、`max_tokens`、思考档位跟着被选中的模型走，而不是
被钉在整个进程上：

```json
{
  "slots": {
    "default": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "big-model",
      "contextWindowTokens": 200000,
      "maxOutputTokens": 8192,
      "maxTokens": 2048,
      "temperature": 0.2,
      "reasoning_effort": "low"
    },
    "triage": {
      "protocol": "openai",
      "endpoint": "https://gateway.example/v1",
      "apiKeyEnv": "GATEWAY_KEY",
      "model": "small-model",
      "contextWindowTokens": 32768,
      "maxOutputTokens": 4096,
      "maxTokens": 1024,
      "temperature": 0
    }
  }
}
```

```js
import { createJsonFileModelConfigProvider, createOpenAIProvider, runToolLoop } from "erix-agent";

const modelConfig = createJsonFileModelConfigProvider({ path: configPath });

// per-run 的槽位选择跟着 run 走，不跟着进程走。
// 不认识的槽位名会回落到 "default" 槽，而不是让这个 run 失败。
const modelSlot = run.triage ? "triage" : undefined;
const slot = await modelConfig.resolve(modelSlot);

// 启动前的预检：现在在回调里抛错只会得到上报（issue #173），所以「没元数据就
// 不要启动」这个决定必须在 run 存在之前做。
if (slot.contextWindowTokens === undefined || slot.maxOutputTokens === undefined) {
  throw new Error("slot carries no window metadata: compaction is off for this run");
}

const events = [];
const controller = new AbortController();
const result = await runToolLoop({
  provider: createOpenAIProvider(slot),  // 请求参数：model / max_tokens / temperature 均来自 slot
  modelConfig,                           // 预算元数据：经 session.modelSlot 重新解析
  session: { id: run.id, modelSlot },
  initialUserMessage: run.prompt,
  executeTool,
  maxRounds: 8,
  persistence: "none",
  signal: controller.signal,
  onEvent: (event) => {
    events.push(event.type);
    // 装配之后仍可用的逃生口：回调终结 run 只能靠 abort 信号，绝不能靠抛错（issue #173）。
    if (event.type === "model_metadata_missing") controller.abort();
  },
});

result.termination.reason; // "end_turn"——真正证明预算被推导出来的是上面那个启动前预检
```

引擎不会在 run 中途换模型：宿主用自己选的 slot 构造 provider，循环只是重新读一次
slot 拿预算元数据。一个确实需要换模型的 run 应当结束，随后换一个
`session.modelSlot` 开新 run。

## 多轮续跑契约（issue #97）

要用新的用户消息继续一个既有 run，宿主需**预写入一个用户轮**到 transcript store，
然后以 `resume: true` 调用 `runToolLoop`。当且仅当 `resume: true` 与提供的 `store`、
`runId` 同时成立时（即 `src/loop/resume-manager.js:75` 的条件分支），引擎会从
`store.load(runId)` 重建消息状态，并**忽略 `initialMessages` 与 `initialUserMessage`**
——宿主提供的用户消息只能通过预写记录到达模型，绝不通过这两个选项。resume 而缺少
`store` 或 `runId` 属于未支持的调用：此时初始消息选项不会被覆盖。

正确的预写 `RoundRecord` 必须满足：

- **形状：** `{ round, messages: [{ role: "user", content: [{ type: "text",
  text }] }], dedupKey, roundKey, ts }`，`ts` 为 ISO-8601 字符串
  （`new Date().toISOString()`）。
- **round：** 复用 `load` 结果中的现有最大 round（`Math.max(0, ...rounds)`，空
  store 为 `0`）。引擎从该最大 round 续起并把自身记录落在更后的 round；预写不得推
  进它。空 `load` 结果是种子路径：在 round `0` 预写该轮；内置 CLI 则在没有既有记录
  时不带 `resume` 地传 `initialMessages`/`initialUserMessage`，对引擎而言等价。
- **dedupKey：** 命名空间为 `"<key>:input:<suffix>"`，每轮唯一。引擎自身行写在
  `"<runId>:engine:round:<n>"` 与 `"…:resume"` 下，宿主 `:input:` 键永不与引擎行碰撞。
- **幂等性：** store 按 `dedupKey`（回落 `roundKey`）去重，崩溃重跑的判定依据是
  `dedupKey`：同 `dedupKey` 的重复 append 是 no-op，因此稳定的 `dedupKey`（由宿主消
  息 id 推导）使预写可安全重复。这个保证是**顺序重跑**语义——崩溃重跑或按
  `dedupKey` 的顺序重试。同一 key 的并发追加不在保证范围内：宿主应按 key 串行发起
  追加（或在接收事务内发起）。
- **时机：** 在接受用户消息的事务内持久化该轮（当宿主决定该轮属于本 run 时），
  而不是懒到 worker 接手之后再写——否则接受与预写之间崩溃会丢失或重复该轮。

### load 返回顺序

`load(runId)` 必须按持久化追加顺序返回全部记录；尤其是同一 `round` 的多条记录必须保留
追加顺序（先追加的先返回）。SQL 类 store 应按持久化追加序号排序，或按持久化插入时间加
唯一次级键排序。例如，当 round 按追加顺序单调递增时，可用
`ORDER BY round_no, append_seq`，其中 `append_seq` 是单调递增的持久化列或持久化主键的一
部分。排序必须保证整个结果集都与追加顺序一致；不得依赖查询执行计划、主键扫描巧合或
`filesort` 的偶然结果。

`src/loop/resume-manager.js` 按 `load()` 返回顺序重建状态，且不对记录二次排序。受顺序
影响的不只是 `messages`，还包括 governor history（`:101-109`）、供
`taskBriefSource` 使用的 round 0 seed 消息（`:88-90`），以及对顺序敏感的 snapshot
`recordedEntries` 匹配（`:152-200`）。典型平局是上一段引擎轮处于 `round=max`，预写 user
行也处于同一 round——因为 `appendUserTurn` 刻意复用最大 round。若这两行顺序反转，新用户
消息就会排在上一段引擎轮之前，改变消息序列语义。

引擎不会对同 round 记录二次排序或修正，包括不会按 `dedupKey` 命名空间等启发式处理；
顺序是宿主 store 的责任。`appendUserTurn` 继续复用最大 round，这是本契约的既有约定。

宿主不应手写这套逻辑。引擎导出
`appendUserTurn(store, { key, text, messageId?, ts? })`，一次调用完成 `load`、round
推导、`dedupKey` 生成、幂等检查与 `appendRound`。带 `messageId` 时 `dedupKey` 稳定
（`<key>:input:<messageId>`），重跑天然幂等；不带时后缀退化为时间戳 + 随机 UUID（每次
调用唯一）。它解析为 `{ key, dedupKey, round, written, record? }`——幂等检查命中时
`written: false` 并附既有 `record`。内置 CLI 与 REPL 是参考消费者。

`appendUserTurn` 另为数据库型宿主提供**成对可选快路径**（issue #157）：当 `store`
同时实现 `loadByDedupKey(key, dedupKey)` 与 `loadMaxRound(key)` 时，助手先算出
`dedupKey` 再点查 `loadByDedupKey`——命中立即返回（既不调 `loadMaxRound` 也不调
`load`）；未命中才由 `loadMaxRound` 推导 `round` 后追加。快路径全程不调用
`store.load`。只实现两个探针之一等同全不实现：上方全量 `load` 路径原样执行。
`loadByDedupKey` 点查必须按 `(record.dedupKey ?? record.roundKey) === dedupKey`
匹配——与全量路径对 `load` 结果使用的判据相同——并返回完整既存记录（命中）或
`null`/`undefined`（未命中）。`loadMaxRound(key)` 必须等价于对 `load` 结果取
`Math.max(0, …安全整数 round…)`，空 store 返回 `null`/`undefined`（或负数）。
违约抛 `TypeError`：`loadByDedupKey` 返回值既非对象也非 `null`/`undefined`；
`loadMaxRound` 返回值既非 number 也非 `null`/`undefined`；或 `loadMaxRound` 返回的
number 不是安全整数。命中记录自身 `round` 不是安全整数时，助手回落由
`loadMaxRound` 推导。内置 file store 两个探针都不实现（点查对 JSONL 无意义）。

## 持久化失败上报

持久化失败有两条可靠通道，都不依赖模型是否读提示：

- `result.unpersisted` —— 错误账单（数组，schema 冻结）。每条含 `ts`、`kind`、`port`、
  `operation`、可选 `phase`、`fatal`、`repeat`、可选 `lastTs`（吸收重复失败时更新）
  与 `error: { name, message }`（message 截断到 500 字符、不带堆栈）；
  `delivery_failure` 条目额外带 `failedEvent`（没能送出去的事件身份）。完全相同的
  失败——同 port/operation/phase/fatal/message，`delivery_failure` 还要同 failedEvent
  身份——会去重成一条并累加 `repeat`，不会刷屏。
- `diagnostics.error(event)` —— 同一身份的事件；宿主编排了 sink 时投递。sink 自身抛错
  也会记成一条 `delivery_failure`。

deterministic run-state 里带同一份账单（`deterministic.errors.unpersisted`），run 中途
崩溃也不会丢；模型可见渲染只给条数，不把宿主错误正文灌进上下文。

失败档位按操作而非按端口划分：transcript 的 append 与 run-snapshot/run-state 写失败会终止
run（副作用被追踪，见 ADR-013）——但仅当 store 实现了该方法；缺可选 capability 的 store 是
降级而非报错（见上文「TranscriptStore capability 分级」）。notes 写失败则继续 + 事件 + 账单，
且工具结果不会长得像“已保存”。宿主端口通过注入的 `reportPersistenceFailure` 桥上报自己的写
失败，事件与账单形状与 transcript 路径一致。

`result.completionErrors[]` 收集收尾失败（多个失败互不覆盖）。主结果若是异常，原异常
仍是主，收尾失败挂在 `error.completionErrors` 上。

## 终局载荷（issue #176 / #180）

无论 `runToolLoop` 是正常返回还是抛错，终局都要把同一套事实交给宿主。下列字段全部是
additive：既有字段不变形状、不变值、不变语义，忽略它们的宿主行为与从前一致。

| 字段 | 出现在 | 契约 |
|---|---|---|
| `termination.errorCode` | `result.termination` / `error.termination` 且 `reason === "failed"` 时 | 失败的根因分类。引擎只透传错误**已有**的分类字段（`KitError.code`，如 `timeout`、`rate_limited`、`auth`、`server`、`checkpoint_failed`），没带分类时回落 `"unknown"`——绝不自己发明或重新归因。其他 reason 不得多出该字段。宿主裁决表因此可以直接按 `errorCode` 分流，而不是解析 `termination.detail` 字符串。 |
| `error.usage`、`error.rounds`、`error.finalText` | 运行生命周期开始之后抛出的每一个错误——即终局 `fail()` 路径；issue #173 删掉了第二个生产者（启动期诊断注解），因此 `fail()` 是唯一来源 | 抛错时刻的累计用量——就是 `result.usage` 本会携带的**同一个对象**（含 `cacheRead`/`cacheWrite`）——外加轮号与已产出的部分终稿（无产出时为 `""`）。尚未产生任何累计时，这些字段是**零值而不是缺字段**：`{ input_tokens: 0, output_tokens: 0 }`、`0`、`""`。运行开始前的校验错误（未知/非法选项 `TypeError`、装配失败、`modelConfig.resolve` 拒绝）时尚不存在 run，不携带这些字段；宿主观察者抛错也不携带了——它现在根本不会抛错（见「观察者回调抛错（issue #173）」）。 |
| `termination.usage`、`termination.rounds`、`termination.partial` | `error.termination` 且 `reason === "aborted"` 时 | 与错误对象上的量同口径（`termination.usage === error.usage`），`partial: true` 表示这是部分稿而非终稿。 |

abort 载荷的存在理由：用户点「停止」的 run 真的花了 token。引擎此前的行为是抛出异常而
把累计量留在函数作用域里，宿主只能在 `catch` 分支写死
`usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0`——于是最长（最贵）的那批 run 记账为
0；靠累加 `usage` 事件也求不出真值：该事件只在 provider 响应完成后才发，而收尾的
`final_guard` / 强制收尾请求根本不发 `usage` 事件。宿主必须从接到的错误上读这份载荷；
「停掉的 run 就不记账」不是合法行为。

`aborted` 仍然意味着「循环抛错」——本次改动不把 abort 变成正常返回，正常返回路径也不会
多出 `errorCode`、`partial` 或嵌套 `usage` 字段。要不要重跑、要不要告警、怎么记账，仍然是
宿主的决策（reason 枚举见下文「终答核验」，终态另见运行状态一节）。

## judge 记录关联字段与 run 级 outcome（issue #165）

judge 决策经 `onJudge` 交给宿主消费（CLI 把它们追加进 `judge.log`，宿主可落任意去处）。
两个 additive 字段让这些记录能按模型分组，一个 additive 事件让它们能与终局 join。
既有字段名称、形状、语义一律不动，完全不读这三个新字段的宿主行为与之前一致。

| 字段 | 出现在 | 契约 |
|---|---|---|
| `runId` | 每条 `onJudge` 记录与 `run_outcome` 事件 | 宿主传给 `runToolLoop` 的 run 标识，也是流式决策与终局记录之间的 join 键。宿主没传 `runId` 时该字段**缺省**——引擎不自己编一个。 |
| `model` | 每条 `onJudge` 记录与 `run_outcome` 事件 | 被评决策发生时 run **实际使用**的模型标识，从 run 选项 / provider 配置解析。探测顺序与 `modelMetadataFor()` 一致（`modelConfig` → `modelMetadata` → `model` → `provider` → `context`），键顺序 `model` → `model_name`（与 provider 构造侧同口径），首个命中且**不合并**。绝不硬编码。任一候选都探不到非空名字时该字段**缺省**：写 `"unknown"` 会让「没配模型」与「真有个叫 unknown 的模型」在账面上无法区分。 |
| `judgeModel` | `onJudge` 记录，仅当 judge 走了与 run 不同的 evaluator 模型 | 让 per-model 校准能区分「被评的模型」与「评它的模型」。judge 与 run 同模型时缺省。 |
| `run_outcome` 事件 | `onEvent`，一次 run 恰好一条——judge 从未运行的 run 同样发 | `{ type: "run_outcome", runId?, model?, judgeModel?, rounds, judgeRecordCount, termination, verification }`。成功路径在持久化落地后发，抛错路径在 `fail()` 里发；去重门保证一个 run 恰好一条。`termination` / `verification` 是 `runToolLoop` 返回值（或 `fail()` 构造出的终局）的副本。 |

为什么是一条独立的终局记录，而不是把 outcome 回写进决策记录：judge 记录是 run 还在跑时
就流出、outcome 到终局才知道，回头改写已发出的记录会破掉 JSONL 的 append-only 语义（宿主
可能已在消费）。因此关联方式是 **join**：每条决策记录带 `runId`，终局记录带 outcome。
判别键：决策记录带 `kind`（`round` / `intercept`）；终局记录带 `type: "run_outcome"` 且
**不带** `kind` 与 `action`，故按 `kind` / `action` 计数或过滤决策的宿主代码不受影响。
`judgeRecordCount` 可让宿主发现掉行：它等于本 run 交给 `onJudge` 的记录条数。
续跑语义：一次 `runToolLoop` 调用发一条 `run_outcome`。续跑复用同一个 `runId`，因此一个 `runId`
可能合法地带着多条终局记录——取最后一条作为当前终局，需要逐次尝试时按 `(runId, ts)` 作键。

`run_outcome` 是既有 `onEvent` 流上的新增事件类型（additive 事件类型 = semver minor）；
没有引入新回调，因为 `onJudge` 的 payload 语义是「一条 judge 决策」，把终局裁决塞进去会让
按决策计数的宿主静默跑偏。宿主在这个终局事件上的抛错遵循统一观察者规则（issue #173）：
经 `onObserverError` 上报、绝不改变终局——审计记录不得把已跑完的 run 变成 `failed`。

字段稳定性：记录形状是宿主消费面，因此字段只 additive 演进——只会新增可选字段，同一主版本内
不重命名、不改型、不删字段。该档案仍是 debug/分析面，不是完成证书：循环依旧不仲裁完成（见「终答核验」）。

## 终止裁决决策表（issue #170）

宿主应该能不读循环就判断一个终局该怎么办。下面每个机制写的都是**同一个**
`termination.reason` 字段，但一个 run 里只能有一个机制获胜：它们是有序且互斥的。
行号引用是实现真相；代码与本表不一致时，代码是对的，本表就是 bug。

返回路径上可枚举的 reason 共 9 个（`src/loop/orchestrator.js:493`）；
`persistence_failed` 是第十个，只在抛错路径上出现，所以也列出。`truncated` 恰好
对 `max_rounds_cap`、`continuation_exhausted`、`stall`、`final_guard_unverified` 为
`true`（`src/loop/termination.js:7-11`）。

| `termination.reason` | 触发机制（file:line） | 在优先级链中的位置 | 宿主开关 | 推荐宿主动作 |
|---|---|---|---|---|
| `end_turn` | 治理层 stop `completion`（`src/reflection/governor.js:111-113`）或兜底 stop `complete`（`src/reflection/governor.js:126-128`），均由 `terminationReasonForAction` 映射（`src/loop/termination.js:93-100`）。输入：`shouldContinue`（`src/loop/orchestrator.js:2739-2740`）、`completionSignalDetected`（来自 wrapup 信封 `done:true`、`completion.signals` 关键词命中，或 LLM 归一化器（`src/loop/orchestrator.js:2742-2745`、`2747-2801`）） | 轮内优先级**最低**的 stop——其余 stop 与 nudge 都先被试过，且本轮 judge 可以用 `judge_done` 抢走它（`src/loop/orchestrator.js:2937-2944`） | 不可关（它是正常成功出口）。`wrapup:false` 拆掉 JSON 信封通路（`src/loop/orchestrator.js:1069-1073`）；`completion:{signals:[…]}` 拓宽关键词探测（`src/loop/orchestrator.js:1413`） | **接受**，但必须先看 `verification.status`——`end_turn` 本身不是交付证明 |
| `judge_done` | 本轮 judge `done:true` 且 `confidence >= 0.7` 且发生在 end-turn 轮（`src/loop/orchestrator.js:2937-2944`，`isEndTurn` 在 2645），映射在 `src/loop/termination.js:94` | 轮内**最高**的 stop：先于治理层评估，因此压过 stall 与 completion | `reflection:false`、`reflection:{roundJudge:false}`、`ERIX_NO_ROUND_JUDGE=1`、`ERIX_NO_REFLECTION=1`（`src/loop/orchestrator.js:1029-1043`）。注意 `maxRounds >= 16` 时 reflection 默认自动开启（`src/loop/orchestrator.js:1029-1032`、`src/loop/reflection.js:8`） | **先接受再核验**：这是模型侧的主张而不是检查。交给下游前先过 `finalGuard` / CI |
| `no_tool` | 治理层 stop `noTool`（`src/reflection/governor.js:114-117`），门在 `noToolRound`（`src/loop/orchestrator.js:2813-2817`）且连续数 `>= maxNoToolRounds`（默认 3，`src/loop/orchestrator.js:1414-1416`） | 在 completion stop 之下、`complete` 兜底之上 | `completion:false` 使 `noToolRound` 恒为 `false`，此 reason 因此**不可达**，run 会改以 `end_turn` 结束；`completion:{maxNoToolRounds:n}` 可调阈值（`0` 为首次即停） | **重试 / 重新提问**：既没声明完成、`truncated` 又为 `false`（什么都没被截断）——它只是在散文里空转。反复出现则告警 |
| `stall` | 同一工具调用签名在处理窗口内重复（`src/loop/orchestrator.js:2678-2692`）叠加 streak 累加（`src/loop/orchestrator.js:2729-2736`），stop 在 `src/reflection/governor.js:66-69`，`STALL_STREAK_LIMIT = 3`（`src/reflection/governor.js:3`），映射在 `src/loop/termination.js:97` | 仅次于 `continuation_exhausted` 的 stop；设计上就高于收尾/错误重复 nudge，不能被饿死（`src/reflection/governor.js:65`） | `stallDetection:false` 使其**不可达**（`src/loop/orchestrator.js:1398-1409`）；`stallDetection:{window,mode}` 可调；`ERIX_STALL_MODE` 覆盖 mode（选项为 `false` 时不覆盖） | **告警 + 换思路重试**：`truncated:true`，不要把文本当答案接受。宿主自己的重复检测应当在这一点上触发 |
| `continuation_exhausted` | provider 连续返 `max_tokens` 且补全预算耗尽（`src/loop/orchestrator.js:2638-2639`，循环在 2601）；治理层 stop `cap`（`src/reflection/governor.js:62-64` / `136-138`）被映射成本 reason，**优先于** `max_rounds_cap`（`src/loop/termination.js:95`） | 两个治理入口的**首要**检查——链顶 | `maxTokenContinuations`（`src/loop/orchestrator.js:1417-1419`，默认 3；`0` 使首次 `max_tokens` 就终局） | **用更多输出空间重试**（抬高 `maxTokens`/`maxOutputTokens`），或接受部分文本并告警；`truncated:true` |
| `max_rounds_cap` | (a) 治理层 stop `cap`：接近上限且不允许扩轮（`src/reflection/governor.js:150-152`）；(b) 轮循环自然跑完（`src/loop/orchestrator.js:2561`，收尾在 `3151-3169`） | (a) 预算边界，在 stall 之下；(b) 在最后一轮之后、任何停止后核验结论生效之前 | `maxRounds`（必需选项）；扩轮余量走 `reflection:{maxExtensions, maxRoundsCap, extensionStep}`（`src/loop/orchestrator.js:1084-1099`）；`ERIX_NO_REFLECTION=1` 关掉自动 reflection | **续跑或按部分交付记账**：用多轮续跑契约继续，否则拿部分结果记账并告警；`truncated:true` |
| `final_guard_unverified` | 配了 `finalGuard` 且它没能认证：不可续跑降级（`src/loop/orchestrator.js:3103-3116`）、修订次数触顶（`3118-3131`）、或轮循环跑完的收尾（`3156-3169`）。只对 6 个 guard 适用 reason 生效（`src/loop/termination.js:14-21`），且仅当 `finalGuard` 是函数（`src/loop/orchestrator.js:3092-3095`） | 严格位于 stop 之后的**后阶段**：它替换 reason，不介入轮内治理 | 整体不传 `finalGuard`（此时 `verification` 为 `skipped` / `no_final_guard`，`src/loop/orchestrator.js:1435-1437`）；`finalGuardMaxRetries` 调修订上限（默认 2，`src/loop/orchestrator.js:1427-1430`） | **不得当已验事实消费**：`verification.status === "unverified"`（`non_continuable` / `max_retries`）。转人工复核或测试系统 |
| `aborted` | 终局 `fail()` 路径且宿主 signal 已 abort（`src/loop/orchestrator.js:905-955`；分类在 907-908 与 927-932，注解在 947-954） | 在抛错路径上压过失败分类——信号先被检查。issue #173 之后，宿主回调无法靠抛错抵达本行：`signal.abort()` 是回调侧唯一的触发器，上面那条 issue #180 载荷规则对它照常生效 | 没有可关项：触发者是宿主自己的 `AbortSignal` | **记账，不自建重跑**：读 `error.usage` / `error.rounds` / `error.finalText`（issue #180）与 `termination.partial`；是用户要停的 |
| `failed` | run 生命周期内抛出的任意错误，经 `fail()`（`src/loop/orchestrator.js:905-955`，循环 catch 在 `3147-3149`），并透传 `termination.errorCode`（`src/loop/termination.js:43-57`）；宿主观察者抛错不再是它的来源之一（issue #173） | 兜底：轮根本没跑完，因此压过任何尚未完成的治理决策 | `retry:{attempts, backoffBaseMs, backoffMaxMs}` 决定到这步前重试多少（`src/loop/orchestrator.js:700-711`）；reason 本身不可关 | **按 `termination.errorCode` 分流**（issue #176）：可重试（`timeout`、`rate_limited`、`server`）→ 退避重试；`auth` → 告警并停；`unknown` → 转去查 `termination.detail` |
| `persistence_failed` | 同一个 `fail()` 路径，在错误携带持久化信息时被选中（`src/loop/orchestrator.js:927-932`），并额外挂上 `operation` / `phase` / `sideEffect`（`src/loop/orchestrator.js:940-946`） | 替换 `failed`，不会反向发生；不带 `errorCode`（该字段为 `failed` 专属） | `persistence:"none"` 直接移除 transcript 写入路径；可选 store 能力是降级而非失败（见能力分级） | **告警**：副作用被跟踪过，所以这是完整性信号（ADR-013），不是重试候选 |

### 核验状态与 CLI 退出码

核验结论与终局 reason 是两个独立的轴：`end_turn` 可以 `unverified`；而
`max_rounds_cap` / `stall` / `continuation_exhausted` 只能以 `skipped` 或 `error`
收尾——配了 guard 之后它们拿不到 `verified`，因为 guard 对这三个 reason 返回
`accept` 也仍然以 `final_guard_unverified` 终局（`src/loop/orchestrator.js:3103-3116`）。
CLI 映射在 `exitCodeForVerification`（`bin/cli.js:1015-1022`）：

| `verification.status` | 含义 | 实际会看到的 `verification.reason` | CLI 退出码 |
|---|---|---|---|
| `verified` | 已配置的 guard 接受了一份终答 | —（无 reason 字段） | `0` |
| `skipped` | 什么都没查——**不是**「答案对」的主张，不得改写成 `verified` | `no_final_guard`（`src/loop/orchestrator.js:1435-1437`）；CLI guard 的 `no_capture_evidence` / `no_extractable_candidates`（`bin/final-guard.js:86,89`） | `4` |
| `unverified` | 核验执行了但未通过 | `non_continuable`（`src/loop/orchestrator.js:3104-3108`）、`max_retries`（`3120-3124`） | `2` |
| `error` | guard 抛错、返回非法裁决或超时（对可用性 fail-open，但永远不会变 `verified`） | `timeout` 或 `error`（`src/loop/termination.js:173-176`） | `3` |

`exitCodeForVerification` 对其他任何 status（包括根本没有 `verification` 对象）都返回
`0`，所以**退出码 0 本身不是已验答案的证明**——请读 `verification.status`。抛错的 run
从 CLI 顶层 handler 退出 `1`（`bin/cli.js:1032-1042`），那是失败信号，不是核验结果。

### 机制优先级与互斥关系

同一个轮次内只有一个机制能拍板，顺序如下
（`src/loop/orchestrator.js:2937-2962`、`src/reflection/governor.js:59-129`、
`src/loop/termination.js:93-100`）：

1. **token 补全边界**——连续 `max_tokens` 响应置上 `continuationExhausted`，它是两个
   治理入口的首要检查（`src/reflection/governor.js:62-64`、`136-138`）。因为
   `continuationExhausted` 在 `cap` 映射之前被检查（`src/loop/termination.js:95`），
   由输出截断引起的 `cap` stop 报的是 `continuation_exhausted`，**永远不会**是
   `max_rounds_cap`。
2. **stall stop**（`src/reflection/governor.js:66-69`）——故意高于收尾 nudge 与错误
   重复 nudge，以免真打转被低优先级 nudge 拖到退化成 `max_rounds_cap`。
3. **wrapup 声明**——`done:true` 信封会压住 `shouldContinue` 并置上
   `completionSignalDetected`（`src/loop/orchestrator.js:2739-2745`），这既产生
   `completion` stop（`src/reflection/governor.js:111-113`），又使 `noToolRound`
   为假（`src/loop/orchestrator.js:2813-2817`）。**声明完成与 `no_tool` 因此互斥。**
4. **completion 关键词兜底**——同样这个信号，在没解析出信封时来自
   `completion.signals` 命中终答文本（`src/loop/orchestrator.js:2743-2745`），或来自
   end-turn 轮完全拿不到 JSON 时的 LLM 归一化器（`2747-2801`，开关是
   `reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`）。
5. **`no_tool` stop**——只在什么都没声明完成且本轮没调工具时可达
   （`src/loop/orchestrator.js:2813-2817`）。
6. **judge 的 end-turn 评估**——`judge_done` 在治理层**之前**被评估
   （`src/loop/orchestrator.js:2937-2944`），因此在其生效的那一轮压过 2-5；它要求
   `isEndTurn`，即 `stopReason === "end_turn"` 且无工具调用
   （`src/loop/orchestrator.js:2645`）。工具轮因此永远不可能产生 `judge_done`；
   `max_tokens` 轮也不可能同时产生 `judge_done` 与 `continuation_exhausted`
   （映射先优 `judge_done`，`src/loop/termination.js:94`）。
7. **停止后验证**——stop reason 定下来后，三个不可续跑 reason 可能多一次强制收尾的
   provider 调用（`src/loop/termination.js:203-256`），然后 `finalGuard` 可以 accept /
   skip / revise / 失败。`revise` 不是终局：它注入一条用户消息，本轮治理重新开始
   （`src/loop/orchestrator.js:3118-3140`）。修订重试次数受 `finalGuardMaxRetries`
   约束（默认 2，`src/loop/orchestrator.js:1427-1430`），guard 自身超时默认 30s
   （`src/loop/orchestrator.js:1431-1433`）。
8. **`fail()` 分类**——任何时刻抛错都会用 `aborted`（信号已置）或 `failed` /
   `persistence_failed` 替换掉上面全部（`src/loop/orchestrator.js:905-955`）。

## 可复用的归一化原语

自带 OpenAI 兼容传输层的宿主可以从包根导入这些辅助函数。它们不做 I/O，也不调用模型：

| 导出 | 签名 | 语义 |
|---|---|---|
| `normalizeOpenAIUsage` | `(usage) -> canonical usage \| undefined` | `null`/`undefined` 返回 `undefined`；其他输入返回对象，把存在的 `prompt_tokens`/`completion_tokens` 映射为 `input_tokens`/`output_tokens`（所以 `{}`、数组、字符串都得到 `{}`）。**不接受** canonical alias。 |
| `normalizeOpenAIStopReason` | `(reason, fallback = "unknown") -> string` | 把 `stop`、`tool_calls`/`function_call`、`length` 映射为规范 stop reason；未知值原样透传。 |
| `parseOpenAIToolArguments` | `(rawArguments) -> any` | 解析 JSON；缺省时返回 `{}`；畸形值放在 `_truncatedArguments` 与 `_raw` 下返回。 |
| `createOpenAIStreamAccumulator` | `() -> accumulator` | 累积带索引的或 legacy 的流式 tool-call 片段；`getToolUseBlocks()` 返回规范 tool-use 块。 |

`createOpenAIStreamAccumulator().addToolCallDelta()` 接受 OpenAI delta 或
`{ index, id, name, argumentsDelta }`；`addFunctionCallDelta()` 接受 legacy
`function_call` delta。畸形参数的行为刻意与库内规范响应转换保持一致。

## 终答核验

宿主消费 `runToolLoop` 结果前，必须检查 `verification.status`：

| 状态 | 契约 |
|---|---|
| `verified` | loop 用于表示由已配置 guard 接受的终答的唯一状态。 |
| `skipped` | 没有可供 guard 比较的内容，或 guard 未启用。**这不表示答案正确**，不得改写为 `verified`。CLI 退出码为 4，因此“没核验”与 `verified`（退出码 0）可区分。 |
| `unverified` | 未满足所需的来源核验。CLI 退出码为 2；宿主不得将该结果作为成功结果消费。 |
| `error` | guard 抛出异常、返回无效决策或超时。CLI 退出码为 3；宿主不得将该结果作为已核验事实消费。 |

`finalGuard` 在 `runToolLoop` 和 CLI 中均为 opt-in。在 `runToolLoop` 中省略它会产生
`status: "skipped"` 且 `reason: "no_final_guard"`。CLI 用 `--final-guard` 或
`ERIX_FINAL_GUARD=1` 启用；默认关闭，`--no-final-guard` 是兼容 no-op。`finalGuardTimeoutMs`
默认 30000，非正值使用默认值。上述退出码只描述核验结果；常规 provider、工具或循环失败
走正常失败路径。

loop 在因 `end_turn`、`no_tool`、`judge_done`、`max_rounds_cap`、`stall`、
`continuation_exhausted` 停机前，会调用已配置的 guard。guard 收到
`finalText`、`findings`、`messages`、`round`、`rounds`、`signal` 与 `termination`。
`findings` 是结束信封声明的 `label -> 精确值` 映射，是可核验断言的权威载体；核验不解析
`finalText`。`{ action: "accept" }` 允许正常终止。`{ action: "skip", reason }` 以
`skipped` 终止。`{ action: "revise", message }` 会作为独立 user 文本消息注入并继续循环，
最多 `finalGuardMaxRetries` 次修正重试（默认 2）。若到上限仍需修正，loop 保留最后的
`finalText`，把 `verification.status` 置为 `unverified`，并以
`termination.reason === "final_guard_unverified"` 终止（fail-closed）。

不可续的停机原因 `max_rounds_cap`、`stall`、`continuation_exhausted`
不会仅因 guard 返回 `accept` 就变成 verified；它们降级为
`final_guard_unverified`。guard 抛错、返回无效决策或超时，对循环可用性是 fail-open：
原终止原因保留，但 `verification.status` 为 `error`，结果永远不会是 `verified`。
每种 guard 结果都发出 `onEvent` 事件，`type: "final_guard"`，`action` 为 `accept`、
`skip`、`revise`、`degraded` 或 `error`。当 store 提供 `markRunState` 时，终态为：
未核验结果 `unverified_error`、guard 错误 `guard_error`、其余 `succeeded`。

引擎没有独立的“交付认证”或“完成认证”层。它报告轮数、工具、文件调用、归档、终止与核验
等事实。任务是否完成、交付物是否满足要求、能否自动进入下游，仍由宿主、测试系统或人工
审核决定。

### NotesStore 接口、作用域与写契约（0.12.0）

`NotesStore` 端口有六个必需方法：

```text
write, read, list, complete, revoke, purge
```

`createBuiltinNotesTools` 在 assembler 创建期即经 `assertNotesStore` 校验——缺任一方法
在第一轮 run 之前抛 `TypeError`，不再静默回退到隐式 file store。`write`/`read` 是 run
作用域的记录读写对；`list` 返回朴素数组；`complete`、`revoke` 是生命周期方法；
`purge` 是维护方法，见 [notes 维护调度](#notes-维护调度0120)。

`list()` 返回 `NoteRecord[]`，不再是分页页面对象：

```js
const records = await store.list({
  scope: "run",
  scopeRef,
  // 均可选：
  limit,    // 仅显式传入时生效：钳制最大 200；不传 = 返回全部匹配记录
  filters,  // { state, tag, source, minRelevance }
  sort,     // "relevance" | "pinned_updated"（稳定比较，不裸调 localeCompare）
});
```

不给 `limit` 返回全部匹配记录——内部消费方（`complete` 与宿主自建清理循环）依赖这个
全量语义。无 cursor、无 `cursor_stale` 状态、无 scope revision 协议：维护者复盘实测
（单 run 平均约 2 条、峰值 9 条）判定翻页与版本锚为 YAGNI，0.12.0 出厂前削减
（ADR-018 D3 决策反转）。`purge` 无分页协议——一次调用全量扫描处理每个 scope
（见 [notes 维护调度](#notes-维护调度0120)）。

显式传入的 `limit` 先校验再钳制（`src/store/notes.js:398-405`，issue #183 第 5 组）：
不是正 safe integer 的值——`0`、`-1`、`1.5`、`NaN`、`2**53`、字符串——在读取任何数据
之前就抛 `TypeError`；而任何大于 200 的值被钳到 200，不是报错。契约套件现在用
超过 200 条存量钉住这两半：默默把 `limit: 0` 归一化成 `1`、或对 `limit: 5000`
返回 5000 条的宿主会变红。

文件型 `NotesStore` 在适配器边界上对每个 `scopeRef` 做一次规范化。`../escape`、绝对
路径、编码分隔符等不安全的 scope 引用会被映射为稳定的 `run-h-...` 目录；目录与持久化的
`record.scopeRef` 使用同一个规范值。宿主与技能必须把原始逻辑 scope 引用交给适配器，
不要预先规范化。已处于规范哈希形态的既有目录仍可读，并参与 list、complete、revoke、purge。

文件适配器假定每个 scope/key 只有一个写入者。并发的读-改-写更新可能丢一次更新及其被
取代的历史（last-write-wins）。这条一写者规则是**这个适配器**的属性，不是端口的：
拒绝并发同键写中落后一方的 store（比较-交换）是合法的 `NotesStore` 实现，随包契约
套件已不再要求两个并发写都成功——last-write-wins 断言已搬到文件适配器自己的测试树，
比较-交换宿主改跑可选的 `notesStoreCasContract` 子套件（见
[契约测试套件](#契约测试套件issue-183)）。在文件适配器上需要并发更新的宿主必须在
宿主边界串行化；适配器不提供锁或其他并发机制。`revoke`
在 API 层再进一步：`expectedState` / `expectedUpdatedAt` 并发护栏让与其他写入方竞态的
revoke 返回 `{ status: "unchanged" }`，而不是覆盖它没见过的记录。

`revoke` 承诺的是记录**不再可被观察到**（issue #183 第 3 组，裁决 3B）。一次
`{ status: "found", revoked: 1 }` 的结果之后，记录不得还能被当成 active 笔记读到：
`read()` 要么返回一个 `state: "revoked"` 的墓碑，要么因为 store 已把记录直接删掉而返回
`undefined`，两种形态都合法。不变的是护栏行为而不是存储形态：对不存在的 key 的
revoke 答 `{ status: "missing", revoked: 0 }`，重复 revoke 不得再多加一次撤销（墓碑
宿主答 `unchanged`，物理删除宿主答 `missing`）。「墓碑不可复活」从未是现行承诺——
引擎里没有任何路径消费 `revoked` 态，所以 revoke 时物理删除的宿主不是较弱实现，
宿主也不得把「行还在」读成一个保证。

两种 scope 拓扑都合法且都在承重（issue #183 第 7 组）。**接口级多 scope 是硬能力**：
每个请求自带 `scopeRef`，一个 store 实例服务多个 scope，而 `purge` 是唯一扫遍
所有 scope 的方法（它忽略 `scopeRef`）。**实例级固定 scope 同样合法**：官方 assembler
`createBuiltinNotesTools` 就是在创建期绑定一个逻辑 run scope（`src/tools/notes.js:627`）、
全部返回视图复用该绑定，因此一个「每租户/expert 一个 store 实例、底层共享多 scope 数据库」
的宿主与上游同形，不是偏航。要拿固定 scope 的宿主端口跑契约套件，适配点在 factory：交给套件一个能把
请求里的 `scopeRef` 解析到该 scope 对应实例（按需创建即可）的 factory，而不是把
这个字段丢掉——套件里那些同时点名两个 scope 的断言（`other-run`、规范化的
`run-h-...` 形态）正好是丢弃 `scopeRef` 的 factory 会为之变红的那几条。

记录时间字段在每次读取时兜底：缺 `updated_at` 回退 `created_at`，两者都缺用固定 epoch
`1970-01-01T00:00:00.000Z`（适配器绝不替没写过的记录伪造"现在"）。
`normalizeNoteRecord()`（从 `src/store/notes.js` 导出）是适配器 read/list 出口与
tools 层（注入 store）共用的兜底。

### Notes 工具注册来源

规范的 notes 工具实现位于 `src/tools/notes.js`。headless 宿主可以从包根或
`erix-agent/tools` 子路径调用 `createBuiltinNotesTools({ notesDir, notesStore, runId })`
（Tier 2 宿主集成）。工厂是全套 assembler：创建时即绑定逻辑 run scope、notes 目录
（`notesDir` ?? `ERIX_NOTES_DIR` ?? `~/.erix/notes`）与单一 `NotesStore` 实例，
所有返回视图共用它们，并强制覆盖调用方伪造的 `__erix` 注入。返回对象包含：

- `definitions`——四个 `note_*` schema；
- `resolveTools`——registry schema 解析视图；需要 `ToolProvider` 形态的宿主
  （如用于 `createCompositeToolProvider` 聚合）可自行构建：
  `createStaticToolProvider({ sets: { default: notes.definitions } })`；
- `executors(name, input, context)`——registry 位置参数形态；
- `executeTool({id, name, input, context, signal})`——结构化形态，对齐 `runToolLoop`/
  run-snapshot-executor 的调用约定（位置参数形态 `executeTool(name, input, context)`
  为兼容既有调用方保留）；
- `lifecycle`——单一收尾钩子（0.12.0）。`onRunComplete` 只调 `completeRun`
  （active → done），返回 `{ completed, errors }`。收尾错误收集在返回值的
  `errors[]` 里返回，不抛出覆盖主错误。入参接受可选的 `reportPersistenceFailure`
  reporter（`onRunComplete({ reportPersistenceFailure })`）：注入后 complete 期间的
  store 失败像工具执行失败一样经它上报。没有 `onRunStart` 钩子，引擎侧也没有
  liveness：run 起点对 notes 零维护。无参调用（如下例）保持原行为——失败只经
  返回值的 `errors[]` 或抛出的错误可见；
- `semanticStateProvider`——ADR-015 折叠点 notes 小抄目录（仅 active、最多 20 条、
  pinned 优先后按 `updated_at` 排序、版本回声 `state.stateVersion`）。入参 payload
  接受可选的 `reportPersistenceFailure`：显式传入时，store list 失败经它上报
  （该情形下 provider 仍返回 `undefined`）。

典型接线（显式 try/finally）：

```js
const notes = createBuiltinNotesTools({ runId, notesDir, notesStore });
try {
  return await runToolLoop({
    /* ... */
    tools: [...hostTools, ...notes.definitions],
    executeTool: async (execution) => {
      if (notesToolNames.has(execution.name)) {
        return notes.executeTool(execution);
      }
      return hostExecuteTool(execution);
    },
    semanticStateProvider: notes.semanticStateProvider,
  });
} finally {
  const { errors } = await notes.lifecycle.onRunComplete();
  for (const failure of errors) {
    hostReportCompletionError(failure.operation, failure.error);
  }
}
```

notes 写失败经引擎的通用宿主持久化失败报告桥上报（`context.reportPersistenceFailure`，
`port: "notes"`），不得静默吞错。宿主仍负责选择并注入 `NotesStore` 与逻辑 run scope。

active orphan 清理完全是宿主的事：引擎没有 liveness 知识。想回收死 scope 的 active
笔记的宿主，用公开原语自己写三行循环——`store.list({ filters: { state: "active" } })` +
`store.revoke({ ..., expectedState, expectedUpdatedAt })`——死活判据用宿主自己的知识
（调度器状态、进程表、最后心跳）。`expectedState`/`expectedUpdatedAt` 护栏吸收
宿主 list 与 revoke 之间的陈旧读窗口；没有这类循环的宿主永不自动回收 active orphan
（宁积累不误杀）。

**note 的 provenance 是调用方自报的 metadata，不是事实。** 记录上 `source` 以外的
`provenance` 字段——`verified`、`toolUseId`、`round`——由调用方自报、可被伪造，
不得作为授权输入或任何 guard 的依据。run 实际做了什么，事实依据是归档 transcript
（`toolOutputs`，ADR-016），而不是 note 记录上的任何字段。

CLI 的 bundled `skills/notes/skill.mjs` 已于 v0.11.0 退役（issue #61），与 assembler
别名键一并移除：notes 统一经 `createBuiltinNotesTools` 工厂交付，`erix skills`
不再列出 bundled notes skill（用户/项目 skill 发现不受影响）。旧第三方 skill
loader 请直接 import `src/tools/notes.js` 或 `erix-agent/tools` 子路径；bundled notes
shim 自身的 `getSkillDefinition` 导出（`erix-agent/tools` 子路径的
`getNotesSkillDefinition`）已随 shim 一并删除，通用 skill loader 对第三方 skill 的
`getSkillDefinition()` 支持不受影响。它不是第二套
实现，也不再是可独立复制运行的 skill；
可移植集成应使用 npm 包入口。

### 文件工具注册

文件工具的规范实现是 `src/tools/file-tools.js`。无头宿主**只能**从 `erix-agent/tools`
子路径调用 `createFileTools({ cwd, allowRead, allowWrite })`——它**不**从包根导出
（ADR-005 第二层：「不属于主导出，只能经显式 `import … from "erix-agent/tools"`」；
`package.json` 的 `exports` 只有 `.` / `./tools` / `./contract-tests`，无深路径），
这就是 Tier 2 host integration。库不带牢笼：两个谓词就是边界的全部，默认都是
`() => true`，与历史 `path.resolve(cwd, value)` 行为完全一致（不做 containment、
不做安全承诺；ADR-009 把牢笼留给宿主）。路径归一由库自己做，喂给谓词的是
**绝对路径**，而且是在遍历中**逐条**判定；这个逐条挂钩正是宿主在外面包一层
`executeTool` 做不到、必须在库里挂钩的理由。

返回对象包含：

- `definitions`：`readFile` / `searchText` / `rg` / `grep` / `tree` / `edit` / `writeFile` 七个
  schema（项数由契约套件 `fileToolsContract` 断言：`searchText` 由 issue #195 加入、`edit` 由
  issue #191 加入）。工具名与既有字段（`offset`/`limit`/`path`/`pattern`/`glob`/`is_regex`/
  `max_results`/`maxResults`/`depth`）保持不变，自带过 CLI 那份实现的宿主接上本
  工厂是零迁移——**但有一条行为口径要注意**：`rg` 的 `is_regex` 默认是 `true`（#184
  追加轮 A，与真实 `rg` 命令一致），而已退役的 CLI 那份实现把「不传 `is_regex`」当作
  字面量，携那个默认的宿主会看到不同的命中结果（见下面的默认值清单）；新参数一律
  snake_case，两个搜索工具都同时接受 `max_results` 与 `maxResults` 两种上限写法；
- `executeTool({id, name, input, context, signal})`：与 `runToolLoop` /
  run-snapshot-executor 调用约定对齐的结构化视图（同时保留位置形态
  `executeTool(name, input, context)` 以兼容现有调用方）。放在**顶层**的 `signal`
  会被并入 `context.signal`；遍历每 32 个条目让出一次事件循环，且**仅在存在
  signal 时**插入，所以不可中止路径的开销与行为零变化；
- `executors(name, input, context)`：registry 的位置参数视图，CLI 用的就是它，
  并在它旁边拼上自己的 `exec` 与 `todo_*`（ADR-005：库不自带会执行的工具）。

**边界语义属 Stable。** `allowRead` 对某个遍历条目返回 `false`，工具就跳过该条目，
并把计数写进结果尾部的排除账；`readFile` 以及被拒的遍历根路径则返回错误结果文本
（`错误：…`）而非抛异常。`allowWrite` 返回 `false` 同样返回错误结果文本：不抛，
库也不引入自己的错误类型。宿主可以依赖两件事：谓词签名
`(absolutePath: string) => boolean`，以及「返回 `false` → 工具返回错误结果而不抛
异常」这条规则；但不得把错误文本的措辞当契约。

**marker 字面量属 Experimental**（issue #188 三层分级，可在任意 minor 变）。所有
「跳过 / 截断 / 空命中」字符串：`[已跳过 …]` 排除账、`[另有 N 条未列出 …]` 与
`[另有 N 个目录未展开 …]` 两个 tree marker、
`[共 N 行，剩余 M 行；下一步：readFile 传 offset=K 继续]`，以及空命中
的 `（无命中）`，全部由 `src/tools/file-tools.js` 里**单一** marker 生成函数产出
（executor 只传语义值，不各自拼带方括号的字符串）。这正是文案能只改一处、而不是
改五个调用点的原因。需要稳定信号的宿主只能按拿到的工具结果分支，不得按 marker
子串匹配。

**截断 marker 必须给出一条可执行的出口**（issue #196 R1）。只报告「已经截断了」是半件事：
搜索的 `metadata` 进 transcript 但**不上 wire**，marker 文本是模型唯一读得到的通道，
一条没有出口的 marker 等于让模型自己猜那个数。所以每一处读/搜截断的 marker 都以
`；下一步：<工具> 传 <参数>=<值>` 收尾，带的是**本次调用**的真值——行窗口或 `max_bytes`
触顶后下一次 `readFile` 该传的 `offset`、超宽行的**行号加文件路径**、命中截断后的续读
`offset`。marker 里允许出现的工具名只有本模块自己的（`readFile` / `searchText`）：
`exec` 属 CLI 装配层（`bin/tools.js`），ADR-005 把「会执行东西的工具」挡在库外，写进去
就是给模型开一张本库兑不了现的支票——这一条相对 issue 原文是收紧。
两个追加细节（issue #196 第二轮）：其一，超宽行**没跨读块**时也要回报——整行落在一个
64 KiB 读块内时它是一字节都没回来（而不是回了一半），而 `max_bytes` 触顶 marker 的
`offset` 语义钉死为「下一个未读整行」，照做正好跳过它，那条行的剩余内容永远取不到；
所以两条 marker 的先后是固定的（触顶在前，被裁那行自己的行号 / `offset` / 路径 / 文件
大小在后），且触顶那条**不得声称内容完整**。其二，`rg` / `grep` 别名的截断 marker 现在
给出与 `searchText` 同源的数（本次返回的命中条数，也就是 `metadata.searchNextOffset`
里那个值），但它自己仍不接受 `offset` 参数——给数与吃参数是两条承诺。

**结果文本里的字节数一律人类可读**（issue #196 R2）。`formatSize()`（与 `toolMarker()`
同文件、由 `src/tools/file-tools.js` 导出）按 1024 基数渲染 `B`/`KB`/`MB`/`GB`/`TB`
（`262144` → `256KB`、`1572864` → `1.5MB`、`1536` → `2KB`、`1073741824` → `1.0GB`、
`1649267441664` → `1.5TB`）；进位判据看的是**渲染后的值**是否到 1024，到就晋级上一档，
所以永远不会出现 `1024.0MB`，而 `1e12` 是 `931.3GB` 而不是只有 MB 档时那个六位数的
`953674.3MB`——六位数带单位等于没单位（issue #196 追加轮）。并且同一段结果文本里
**不会**同时出现可读值与裸字节数——同一件事给两个数，模型对不上账。阈值本身在本文与
`metadata` 里仍写裸数字，那里没有第二份数字互相打脸。

宿主必须知道的默认值，因为它们会改变模型看到的东西（ADR-010：默认去噪只有在可撤销
时才是合法的）：

- `rg` / `grep` / `tree` 默认跳过 `node_modules`、`dist`、`build`、`target`、
  `vendor` 与 `.` 开头的目录（含 `.git`），除非传 `include_vendor=true` /
  `include_hidden=true`；结果尾部会带跳过数量，以及能撤销它们的开关名；
- **两个搜索工具都默认按正则匹配**（`rg` 与 `grep` 一致，也是真实 `rg` / `grep`
  命令自己的默认；#184 追加轮 A 推翻了此前「`rg` 默认字面量」的选择——同一库里两个
  搜索工具默认相反才是本轮修掉的反常）。`is_regex=false` 是字面量逃生口，按真实旗标
  命名：等价 `rg --fixed-strings` / `grep -F`。非法正则返回工具错误结果
  `错误：无效正则：…`，**绝不抛异常**（真实命令是非零退出）；
- **两个搜索工具把每条命中行截到同一个 500 字符** + 尾部一个 `…`，共用**同一个**上限，两边不可能
  再各自漂移（#184 追加轮 A：上限原先是 200，会把正常代码行截成半行，模型看到半行容易误判；且当时
  只有 `grep` 截、`rg` 原样输出，同一库里两个搜索工具口径相反）。真实 `rg` / `grep` 命令**都不截行**
  （已实测：807 字符的命中行逐字节原样输出），所以这个截断是**本实现自己的输出预算**——一个超长行
  （minified 文件常见：一行几百 KB）能独自把一次工具调用撑爆。这个数是**本实现的默认值**，不是对宿主
  的要求，且已写进两个工具的描述；
- 空命中结果是 `（无命中）`，不再是空串；
- `tree` 截断永远带 marker，并给出剩余计数与能放宽它的参数；
- `readFile` 有界：单次返回不超过 `max_bytes` 个 UTF-8 字节（默认 `262144`，可用
  `ERIX_FILE_READ_MAX_BYTES` 覆盖，钳到 1024-4194304），行窗口按块扫行 + 早停，
  不再把整个文件读进内存；
- 每条截断 marker 都以「可执行的下一步」收尾，带的是**本次调用**的真值（续读要传的
  `readFile` `offset`、被截那行的行号与文件路径、或搜索的续读 `offset`），且只允许点名
  `readFile` 或 `searchText`——`exec` 是 CLI 自己的工具，不属于库（issue #196 R1）；
- 结果文本里的字节数一律人类可读（`B`/`KB`/`MB`/`GB`/`TB`，1024 基数，走 `formatSize`），
  可读值与裸字节数不在同一段结果文本里并存（issue #196 R2）；裸的默认值继续留在本文
  与 `metadata` 里。

**搜索是纯 Node 子集，不是 `rg` / `grep` 二进制**（issue #184）。只有默认值与逃生口命名
跟真实命令一致，能力面故意不一致：没有 `-i`、没有 `-A`/`-B` 上下文行、没有 `--type`/
`--include`，模式是 JavaScript 正则（ripgrep 内置的是另一套正则引擎，GNU `grep` 默认是
BRE，都不是这里用的 JavaScript flavor），**完全不读 `.gitignore`**，vendor 排除是一份硬
编码清单（`node_modules`/`dist`/`build`/`target`/`vendor`），以结果尾部的排除账回报，而不
是 ripgrep 那套 ignore 文件遍历。宿主不得把自己的模型或用户误导成「这就是 ripgrep 二进制」。

CLI 只保留装配与呈现：`bin/tools.js` import 本模块，自己只加 `exec` 与 `todo_*`，
且不传任何谓词，所以 CLI 行为与以前一致，仍是「无边界」。`bin/` 不再持有第二套
文件工具实现（issue #184）。

### 文件编辑工具 `edit`（issue #191）

`edit` 是同一个 `definitions` 数组、同一个 `executeTool` 入口里的**第二个写工具**——
已经按上面「文件工具注册」接线的宿主，零额外接线就拿到它。它存在的理由：工具面此前
只有 `writeFile{path, content}`，改三行就得重打整份文件（`src/loop/orchestrator.js`
3277 行 ≈ 33k 输出 token），而这次整写本身还可能被模型自己的输出预算切断——
`continuation_exhausted` 在本库是一等的终止原因。`edit` 把「改一小段」的成本从
整文件量级降到 diff 量级。

```js
import { createFileTools } from "erix-agent/tools";

const fileTools = createFileTools({ cwd, allowWrite: (absolutePath) => absolutePath === expectedPath });

const edited = await fileTools.executeTool({
  id: "toolu_edit_1",
  name: "edit",
  input: { path: "a.js", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
  context: {},
});

// 越界写：allowWrite false 走的是与 writeFile 同一份错误结果，不抛、不落盘
const denied = await createFileTools({ cwd, allowWrite: () => false })
  .executeTool({ id: "toolu_edit_2", name: "edit", input: { path: "a.js", edits: [{ oldText: "const a = 2;", newText: "const a = 3;" }] }, context: {} });
```

宿主可以依赖的事实：

| 面 | 契约 |
| --- | --- |
| 入参 | `{ path, edits }`。`edits` 只收三种形状、且只收这三种：`[{oldText, newText}]`、单个 `{oldText, newText}` 对象、或上面两种的 JSON 字符串。其余形状（非法 JSON、`oldText`/`newText` 不是字符串、空列表）一律错误结果。收这三种形状是归一**形状**，从不猜意图 |
| 匹配 | 逐字节精确。`oldText` 必须与文件里某段文本逐字符相等，空白与缩进也算。**没有模糊兜底**：不做 NFKC 折叠、不做弯引号折叠、不做行尾空白容忍 |
| 唯一性 | 每条 `oldText` 必须命中且仅命中一次。0 次与 `N>1` 次都是错误结果；`N>1` 的文案会报出到底几处，以及前两处的行号 |
| 独立性 | 每条 `oldText` 都对**原文**匹配，而不是对同一次调用里前几条改完的中间态匹配；各条命中区间不得重叠 |
| 原子性 | 全部通过校验才写入。没有部分落盘，且「全部无变化」也是错误结果（`未做任何修改…`），不是静默成功 |
| 写边界 | `allowWrite(absolutePath)`——与 `writeFile` 同一个谓词，且在读任何内容之前判定。越界是错误结果、绝不抛，文件保持原有字节 |
| 行尾 | BOM 保留；行尾里含 CRLF 的文件在 LF 空间里匹配、按 CRLF 写回。因此混合行尾的文件写回时会被归一到 CRLF——结果首行会写 `CRLF 行尾已保留`，而不是把这件事藏起来 |
| 结果 | 一行摘要（`已编辑 <path>，替换 N 处，首个变更行 N，写入 N 字节`，按实际情况追加 BOM/CRLF 说明），随后是 3 行上下文的 unified 风格 diff，按编辑区间分组，上限 8 段 / 200 行。被截断时追加一条带剩余计数与 `readFile` 下一步的截断 marker（ADR-010：去噪必须可撤销） |
| diff 保真度 | 这个 diff 是**自证凭证，不是补丁**：hunk 按编辑区间切、取整行边界并剪公共前后缀，因此它可能比最小 LCS diff **多**报变更行（绝不会少报），并且不承诺 `git apply` 可用。要逐字节确认请用 `readFile` |
| 护栏 | 目标超过 4 MiB、单次超过 64 条、含 NUL 的（二进制）文件、目录、不存在的路径，全部返回错误结果并给出下一步（新建走 `writeFile`，回读走 `readFile`） |
| judge | `edit` 在默认 `writeToolNames`（`["writeFile", "edit"]`）里，因此宿主不配置也能让它的 `path` 进入 judge 的 `filesWritten`。宿主显式传入的 `writeToolNames` 是**整体替换**那个默认值——绝不与它合并 |

**为什么本轮不做模糊兜底。** pi 的 `edit` 带 NFKC 归一、弯引号折叠与行尾空白容忍，
那是它的 transcript **踩坑之后**加的：模型从 `readFile` 回显里抄错一个字符就 0 命中。
本库没有这类 transcript 证据（与 issue #195 R4 把 `-i`/`-A`/`.gitignore` 挡在
`searchText` 门外是同一条规则：没证据就别扩面），而兜底会把模型唯一能自证的信号
——`0 命中`，一个它可以据此行动的错误结果——换成「静默改到了另一个位置」。这正是
issue #184/#195 一路在收的那类静默撒谎。具体算账：一个看着像但错的模糊命中要一整轮
往返才能发现，一次精确匹配落空只花一次重试。日后要加兜底是 additive 的（它只放宽
匹配面，从不收窄），所以这里没有任何单向门。

给工具副作用分类的宿主（写日志、权限确认、TUI 的写入标记、重放策略）必须把 `edit`
当**写**：它的 `path` 参数长得和 `readFile` 一样，一份只把 `writeFile` 记成写工具的
名单会漏报每一次编辑。退役前的 `bin/tools.js` 工具面从来没有过这件事，而 CLI 现在把
`edit` 列进了工具清单行——这正是本次发布 `test/fixtures/cli-golden.json` 变更的原因。

### 搜索工具（issue #195）

`searchText` 是唯一的搜索入口（Tier 2 host integration，注册路径与「文件工具注册」
一致），`rg` 与 `grep` 现在它的**薄别名**。为什么要一个新名字：`rg` 与 `grep` 是我们
自己写的纯 Node 实现（整文件工具里没有任何 `execFile`/`spawn`），却借了两个 CLI 命令的
名字——**借来的名字会带来借来的先验**。模型看到 `rg` 就会写 `glob: "**/*.test.ts"`（这里
的名称过滤从不跨 `/`）、先验地以为 `.gitignore` 生效（不生效）、把「没命中」读成「仓库里
真没有」（其实可能整棵 `vendor` 被跳过）。最后一类正是 issue #184 干掉的那批静默撒谎，
只是撒谎的主体从输出换成了**名字**。

宿主可以依赖的契约面：

- `mode` **必填且无默认值**——合法取值只有 `"literal"`（字面量）与 `"regex"`（JavaScript
  正则）。没传或传了非法值会返回工具错误结果`错误：searchText 必须显式给出 mode …
  （无默认值）`，绝不自己猜一个。这就是这个工具的存在理由：issue #184 不得不翻转一对
  「`rg` 默认字面量 / `grep` 默认正则」的相反默认，而「默认 `literal`」只会把歧义留给
  调用方。别名仍保留布尔逃生口：那里的 `is_regex=false` 就是 `mode: "literal"`（等价
  `rg --fixed-strings` / `grep -F`），正则默认未动。
- 名称过滤参数叫 `name_pattern`：它**只匹配文件名**、**从不跨 `/`**，所以 `**/*.ts`
  这类模式一律不命中。它不再叫 `glob`——**只有子集能力就不该顶着完整能力的名字**。
  `searchText` **不接受 `glob`**：传了会返回一错误结果并指向 `name_pattern`，而不是
  静默忽略一个「看着能用」的键；`grep` 别名继续吃 `glob`（语义相同），因为它的入参
  形状属 Stable。
- `content` 是扁平的 `path:line:命中行` 形态，一行一条命中。两个别名保留各自的历史渲染
  （`rg` 扁平、`grep` 按文件分组），所以**跳工具的不变式是「命中行正文」**：三个入口共跑
  同一份实现体，连 500 字符行宽上限、`（无命中）` 口径与排除账都一起产生。契约套件逐字钉
  住了这个等式（issue #195 硬判据）；宿主不得在别名上假定扁平形态去写解析器。别名的截断 marker 带的是与规范入口同一个数
（`…；下一步：改用 searchText 传 offset=N 继续（本别名不接受 offset）`，N = 本次返回的
命中条数），即别名**给真值但不因此获得参数**（issue #196 追加轮）。
- `searchText` 返回 `{ content, metadata }`。`metadata` 携带 `searchHits`、
  `searchMatchedLines`、`searchFiles`、`searchLimit`、`searchOffset`、`searchTruncated`、
  `searchNextOffset`（仅在截断时）与 `searchSkipped { vendorDirectories,
  hiddenDirectories, largeFiles, binaryFiles, deniedPaths }`。这些字段**进 transcript、
  不上 wire**：模型侧读的仍是 marker 文本（`[已跳过 …]`、`[命中过多，已按
  max_results=N 截断；下一步：searchText 传 offset=N 继续]`、`（无命中）`），
  仍由单一 `toolMarker()` 函数产出（文案属
  Experimental，issue #188）。需要稳定信号的宿主按 `metadata` 分支，**不要按 marker 子串
  匹配**，也不要要求上面没列出的键。`offset` 用来续读被截断的结果：把
  `metadata.searchNextOffset` 原样传回来即可。
- 本轮弃用只是**告警**（issue #188：工具名与入参形状属 Stable，移除要等 major）。
  `rg` 与 `grep` 会在结果尾部挂一行 `[已弃用 rg：它是 searchText 的薄别名，…]`。拿工具
  输出做逐字相等比较的宿主会看到这一行——它是模型可见变更；CLI 系统提示的工具清单行与
  `test/fixtures/cli-golden.json` 同理。
- **没发生**的事（issue #195 R4）：没加 `-i`、没加 `-A`/`-B`/`-C` 上下文行、没加
  `--type`、没加 `.gitignore` 感知。每一条都会与边界注入/输出预算/中止交叉（`-A`/`-B`
  会顶破字节上限；读 `.gitignore` 本身要过 `allowRead`），所以上游要求先看 transcript
  证据——模型到底写了哪些我们不支持的参数形状、因此误判了几次。
### 技能加载器注册（issue #197）

技能包 loader 的规范实现是 `src/skills/loader.js`，经 `erix-agent/tools` 导出——
**故意没有**新增 `./skills` 子路径：打包面一字不改，本来就读 `./tools` 的宿主不需要多一条 import 映射。
`bin/skills.js` 只剩装配 + re-export（它唯一的职责是把自己那份内置技能目录补进去），
所以 `erix skills` 与 repl 的 `/skills` 行为与搬迁前逐字一致。

公开面是六个函数：

- `skillDirectories({ home, cwd, skillsDir, bundledDir })` — 返回真实存在的技能根，顺序是
  用户全局 → 项目本地 → 内置；
- `discoverSkills({ home, cwd, skillsDir, bundledDir })` — 一级技能目录 `[{ id, dir }]`，
  尾部挂一个不可枚举的 `errors` 数组；
- `loadSkill(dir)` / `loadAllSkills(options)` — 校验单个技能目录 / 全部已发现的目录；
- `buildSkillTools({ home, cwd, skillsDir, bundledDir, excludeSkillIds, builtinNames })` —
  装配出 `{ tools, executeTool, errors }`，`errors` 同时带上所有被跳过的原因；
- `warnBuiltinToolConflicts(errors, { warn })` — CLI 那条同名冲突的一次性告警。

**`bundledDir` 是宿主必须看懂的那个选项。** 内置技能目录**归调用方所有**：库绞不按自身
文件位置推导它，不传 `bundledDir` 就等于内置根压根不参与发现——只看 `<home>/.erix/skills`
与 `<cwd>/.erix/skills`。理由不是风格：退役前的 `bin/skills.js` 把路径写成相对 `import.meta.url`
的 `../skills`，文件住在 `bin/` 时恰好命中 `<package>/skills`，搬到 `src/skills/` 就差一层，
宿主从 `node_modules` 里解析这个包时又是另一套。猜错的失败方式是**静默**的——内置技能就是
发现不到了——所以这个参数是契约而不是便利顶。CLI 传自己的 `<package>/skills`；宿主传自己
那一份，或者什么都不传、只拿用户级与项目级技能。

优先级是定死的：内置技能在同名竞争里输给用户全局技能，用户全局技能又输给项目本地技能
（扫描顺序 内置 → 全局 → 项目，后者替换前者）。`skillsDir` 是单目录覆盖（即 CLI 的
`--skills-dir`）：一旦给出就只扫那一个目录，相对值按 `cwd` 解析。

**发现与校验都不阻塞，且每个失败都可枚举。** `loadSkill` 对单个目录是抛错（不支持的
`schema_version`、绝对路径或逃逸技能根的 entrypoint、空 / 重复 / 畸形的 `tools`、既没导出
`getSkillDefinition()` 也没导出 `getTools()` 的模块），`loadAllSkills` / `buildSkillTools`
会把每一次抛错转成一条 `{ skillId, dir, error }` 记录——`error` 是字符串，该技能**整体**被
跳过（不会留下半套工具），同一根下的其他技能照常装配。工具名与 `builtinNames` 冲突的技能
也按同一条路回报并被跳过，而不是静默覆盖内置工具。宿主可以对「记录形状」与「整体跳过」这两件事
编码，不得对那些错误文案编码。

`buildSkillTools` 交出去的就是本库的 `ToolSchema` 列表，直接交给 `createToolRegistry`，所以
技能工具身上 registry 的 input 校验是真生效的：缺 `required` 字段或字段类型不符会拿回
registry 的 `Tool <name> …` 文本，未注册的名字拿回 `Unknown tool: <name>`，都不抛。
技能模块是**在宿主进程内、以宿主的权限**被 import 的——库不提供任何沙箱（ADR-008，
ADR-009 把牢笼留在宿主侧），所以 `excludeSkillIds` 与 `builtinNames` 是策略输入，不是安全边界。

`erix-agent/contract-tests` 里的 `skillsLoaderContract(label, { discoverSkills, loadSkill,
buildSkillTools })` 会断言「内置目录由参数决定」「优先级」「不阻塞且可枚举的 errors 形状」
「产出是 ToolSchema 形态」四组事实，对宿主接进来的任何实现都跑同一套。

### notes 维护调度（0.12.0）

根规则是**会话时钟**（ADR-018 D7）：笔记寿命 = 会话寿命 + 保留期（尸检期）。
会话最后活动由宿主定义——CLI 用 transcript mtime（30 天无对话活动的 session，
其笔记随 transcript 过期一起清理）；调度型宿主用调度器状态。引擎不猜不问。

库内 `store.purge()` 是没有会话时钟的宿主的可移植兜底基线：对每个 scope 目录，
若全部记录文件的最新写入（最大文件 mtime——不解析 JSON）早于
`now - ERIX_NOTES_RETENTION_MS`（默认 30 天），**该 scope 的全部记录文件（含
active）整体删除**，空目录一并移除；未超期的 scope 整体豁免（其中很老的笔记也
保留——会话活着，笔记本整体保留）。`purge` 每次调用一次全量扫描——没有
`limit`/`cursor` 协议——返回 `{ status, scanned, purged }`（`scanned` 为扫描的
scope 目录数，`purged` 为删除的记录文件数）。可选 `before` 参数只能缩小范围
（取更早的 cutoff，绝不放大删除窗口）。CLI 在 run 收尾后接着跑会话时钟清扫；
嵌入式宿主自行调度 `purge()`。

**上游不承诺记录级过期（issue #183 第 1 组）。** `expires_at` 是历史遗留字段：内置
文件适配器从不读它，`purge` 只看 scope 时钟，也没有任何上游路径因为时间戳到期而
把记录变得不可见。宿主完全可以自定保留/过期策略（TTL 列、每 run 限额、定时清扫），
契约套件也不会往任何一个方向断言。不要把 `toolResultTtl` 当成 notes TTL：那个旋钮数
的是 provider request-view 里折叠大工具结果的轮数（见
[取回与 request-view 折叠](#取回与-request-view-折叠)），与笔记寿命无关。真正属于
契约的生命周期义务只有 `complete`（把整个 scope 的 `active` 置成 `done`）与一个
真的按自己的时钟删到期记录、并对不可解析的 `before` 报错的 `purge`。

### CLI 侧来源 guard

`bin/final-guard.js` 中的 CLI guard 是确定性的来源检查器，而不是任务完成度评估器
（ADR-016）。证据是本 run transcript 的归档工具输出（`toolOutputs`，字节保真）；没有可重放性过滤——每条归档输出都是证据。（旧 transcript 的 legacy capture manifest 仍可读，但新 run 不再写。）guard 用字符串相等
比对信封声明的 `findings` 与归档捕获值；**从不解析自由散文**。

- 声明的 label 命中归档值 → 该条通过；
- 声明的 label 在归档里存在但值不符 → `action: "revise"`（伪造信号），消息里带上捕获值；
- 声明的 label 在归档里完全不存在（例如派生计数）→ 告警并跳过该条：既无法核验也无法
  证伪，在此处打回只会诱发绕路（已实测）；
- 归档里有捕获值、信封却一条都不声明 → `action: "revise"`。有东西可比却不声明，是模型
  跳过了声明步骤，并不等于“本任务没有可核验值”。guard 在 `finalGuardMaxRetries` 内重试，
  之后 fail-closed 到 `unverified`；绝不会静默放过。

整个 run 没有归档输出时返回 `action: "skip"` 与 `reason: "no_capture_evidence"`。
归档输出里没有可提取候选值时返回 `action: "skip"` 与
`reason: "no_extractable_candidates"`。guard 不添加自然语言推断、关键词猜测或相似度
规则。跳过检查仍不等于 `verified`。

当 loop 必须用 LLM 把散文终答归一化成信封时（`ERIX_WRAPUP_NORMALIZE=1` 或
`reflection.wrapupNormalize`），归一化器只许搬运：每个归一化后的 finding 值都必须逐字
出现在模型自己的终答文本里，否则该条在 guard 看到之前就被丢弃。LLM 不得在通往核验的
路上“修好”模型的值，那会让核验不可复现。

## 取回与 request-view 折叠

模型侧取回采用 note-first：先用 `note_list` 发现已保存的笔记，再用
`note_read` 读取精确内容。不要猜测遗忘的值，也不要依赖 transcript recall API；
recall 适配器已在 0.8.0 契约中退役。

旧的或较大的工具结果只会在 provider request view 中折叠。`toolResultTtl`
默认为 `2` 轮（`0` 表示禁用），`toolResultFoldMinTokens` 默认为估算的
`4000` token。在 `age === ttl - 1` 的 warning round 中，模型会被要求使用
`note_take` 提取重要事实；折叠占位符包含 navigation digest，并在适用时包含
JSON skeleton。run snapshot 保留完整工具结果文本。note、todo、错误和显式保护的
结果不会折叠。

## 重复命令与副作用（ADR-016）

引擎不做可重放性分类、重跑检测或重跑告知。重复命令会正常执行并返回它的新输出。重跑值
错配的风险由系统提示里的一行承担：“重跑同一命令可能得到不同的值；需要早期精确值时先
用 note_list 再用 note_read，不要凭记忆。”

因此宿主必须在自己的工具能力、权限、沙箱或幂等层里承担副作用与重跑风险，并决定未核验
结果应当触发人工审核、重试还是失败。guard 仍是一个 opt-in 的机械检查器；不要往里面加
自然语言推断、关键词猜测或相似度规则。

## 错误账本（issue #109 第 1 步）

`runToolLoop` 结果带两个恒定存在的账本字段：

- `result.unpersisted: Entry[]` —— run 期间持久化失败的权威记录。默认 `[]`。
- `result.completionErrors: []` —— 预留给收尾阶段失败（在后续步骤接线）；默认 `[]`。

`Entry` 取值之一：

- `persistence_error`：`{ kind, port, operation, phase?, fatal, error: {name, message}, ts }`，
  其中今天 `port` 为 `"transcript"`；`"resource"`/`"notes"` 随各自接入步骤出现。`error`
  归一化为 `{name, message}`，message 截断到 500 字符（约束 result 体积；丢弃堆栈）。
- `delivery_failure`：`diagnostics.error`（或 `onPersistenceError`）sink 自己抛错——错误
  发生了但结构化事件没送达。`port` 恒为 `"diagnostics"`（坏掉的通道）；出事的端口在
  `failedEvent.port`。
- `ledger_overflow`：账本达到上限（100 条）丢弃记录时生成的申报条目，带 `dropped: number`。
- 另外，`repeat` 字段表示同一失败被去重合并的次数（首条为 1）。

投递保证：账本与 `diagnostics.error` 事件是两条可靠通道；模型可见提示仅为 advisory，
从不计入投递。异常终止的 run 会把账本挂在抛出的持久化失败上，即 `error.unpersisted`。

`persistence_error` 诊断事件现在带 `port: "transcript"`；该字段是增量添加，既有消费者
不受影响。

## 折叠摘要结构

两种轮次折叠策略（`fold-statistical` 与 `fold-llm`）都会在头部任务消息（或
`summaryRole: "system"` 时的 system 消息）前部冠以单个折叠摘要文本块。其固定分节，按顺序为：

1. 标记行 `【上下文折叠·v1·erix-9f6e2c】早期第 N–M 轮（共 K 轮）已折叠。`，
   外加确定性的工具足迹（`工具足迹：name×count, …` 或 `无`）。
2. 可选的 `导航记录：{…}` 行（有界 JSON，仅当被折叠的工具结果携带归档产物时出现）。
3. 可选的 `[已折叠] …` 存根（最多 10 条）。
4. 恢复提示行。
5. 可选的**锚点索引**分节（机械抽取，不经 LLM 改写）：

   ```
   ## 锚点索引（机械抽取，未经 LLM 改写）
   paths: src/a/b.js:12, …
   shas: 1ed3f35, …
   issues: #32, …
   urls: https://…
   errors: TypeError: …, …
   ```

   锚点用正则从被折叠的负载中抽取——只取自 `tool_result` 内容与真实用户消息，绝不取自
   assistant 散文。各类按固定顺序 `paths, shas, issues, urls, errors` 渲染；
   `errors` 行含 `Error`/`Exception`/`Traceback`/`fatal:`，逐字保留至多 120 字符、
   最多 5 条。同一行内多个值以 `, ` 连接；值内的字面 `,` 或 `\` 在渲染时转义为
   `\,` / `\\`，在该分节被重新解析时反转义，因此每一类都能在反复折叠之间无损往返
   （例如错误行 `Error: failed, retry later` 或 URL 查询串 `?a=1,2` 仍是单个值）。
   注意 `paths` 的正则字符集排除了 `,`，含逗号的 paths 不会被抽取——这是接受的漏报代价。
   上限：锚点总计 20 个，整个分节 1200 字符（按频次排序，其次按首次出现）。连续折叠之间
   该分节会被重新解析并按类做并集合并（既有条目在前、新条目追加、去重）后重新钳制，
   因此锚点在反复折叠中不丢失、不重复、不溢出。

   锚点分节默认开启。传 `anchors: false`（策略工厂或每次 `compact` 的选项）可恢复
   0.7.0 的确切行为——没有锚点分节，且此前折叠摘要中带有的锚点分节会在合并时被丢弃
   （一次 `anchors: false` 折叠会彻底移除早先默认折叠创建的锚点分节）；摘要其余部分
   不变。对象形态 `anchors: { maxPerKind, maxChars }` 可钳制每类条数与分节字符数。
   在 `fold-llm` 中，该分节在 LLM 摘要之后（且在尺寸钳制之后）追加，因此
   `maxSummaryTokens` 截不到它。

## Store 保真要求

宿主 `TranscriptStore` **必须保留完整的 `RoundRecord` 与完整 message 对象**，包括宿主不认识
的字段。不得按字段白名单重建 record 或 message：必需字段会随实现演进，丢弃未知字段可能改变
引擎行为。

这里有两个彼此独立的保真口径：

- **展示投影保真**：保留 `projectTranscriptForDisplay` 读取并生成正确轮次、标签、工具预览、
  折叠摘要、排序与时间戳所需的字段。
- **resume / 模型上下文保真**：`load()` 必须重建相同的 messages、内容块、元数据、顺序与未知
  字段，使模型回放与 judge 过滤看到相同上下文。展示投影看似正常，不能证明 resume 保真。

与投影和 judge 正确性相关的最小字段至少包括：

| 字段 | 丢失后的退化 |
|---|---|
| `messages[].meta.source` | 合成分类会回退到文本前缀启发式；引擎注入的 judge 方向提示可能显示成真实用户消息，并在 resume 后逃过 judge 的 `judge-control` 排除。当前文本启发式不识别其 `【Judge 评审意见】` 前缀。普通历史消息没有该字段，并不能证明 store 有损。 |
| `messages[].content[type="tool_use"].id` 与 `messages[].content[type="tool_result"].tool_use_id` | 工具调用无法与结果配对，投影中的工具结果预览会丢失。 |
| `response.content`（含 reasoning 块） | assistant 输出、工具调用或推理可能从投影及重建的模型上下文中消失。 |
| `folded` | 折叠轮横幅与折叠段呈现被省略。 |
| `foldedRoundRange` | 横幅失去精确的折叠轮次范围。 |
| `foldedPayload` | 恢复与锚定所需的折叠归档消息不可用。 |
| `navigationRecord` | 折叠导航及归档产物链接丢失。 |
| `summary` | 组合折叠摘要失去轮次 action/note 兜底内容。 |
| `round` | 轮次丢失轮号，无法按记录的轮号排序。 |
| `ts` | 投影轮次失去时间戳。 |

有损 store 当前不会触发报错。投影会静默回退：部分合成消息使用文本前缀嗅探，缺少 response
时用 `textPreview`，缺少带标记的折叠摘要时用 `summary` 兜底；这些回退不会检测或报告 store
有损。宿主必须自证保真，例如针对自身 schema 与未知字段运行并扩展
`test/contract/transcript-store.js` 中的断言。

## 宿主展示投影

transcript 就是模型上下文真相：`RoundRecord` 为回放保持字节保真，同时携带模型面对的
负载与面向展示的字段。需要人类可读聊天视图的宿主应从 transcript 派生，而不是维护第二
张有损消息表。`projectTranscriptForDisplay` 是官方、宿主无关的投影助手：

```js
import { projectTranscriptForDisplay } from "erix-agent";

const turns = projectTranscriptForDisplay(await store.load(runId));
// [{ key, role, text, blocks, toolCalls?, reasoning?, folded?, round, ts, meta }]
```

它是纯函数：无 I/O、无模型调用、构造结果时不变更输入记录、无宿主特有假设。它接受任意记录
子集（过滤或切片后的 `load()` 结果均可），按 `round` 升序返回轮次；没有可用 `round` 的记
录保持输入顺序并排在最后（同 `round` 的记录也保持输入相对顺序）。

### 投影身份与工具调用形状

每条投影轮次都有一个 `key`，派生格式为 `${roundToken}#${recordIndex}:${entryIndex}`。
`roundToken` 在 round 可用时为 `String(round)`，否则为 `?`；`recordIndex` 是记录在输入数组
中的零起始位置，`entryIndex` 是该记录所投影出的轮次零起始位置。每个工具调用也有一个
`key`，格式为 `${turnKey}:t${toolCallIndex}`，其中 `toolCallIndex` 是该轮 `toolCalls` 数组
中的零起始位置。同一次投影内这些 key 唯一；使用同一输入数组再次投影时，它们具有确定性。
它们不是持久标识：过滤、切片或追加输入数组都可能改变 key，不保证不同输入数组之间保持稳定。

`toolCalls` 是摘要数组，其公开形状为：
`{ key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus? }`。

| 字段 | 含义 |
|---|---|
| `key` | 宿主渲染用的非空工具调用身份，由所属轮次 key 与位置派生；它不是 provider 的工具调用 ID。 |
| `name` | provider 提供的工具名；缺失时为空字符串。 |
| `id?` | provider 提供的 `tool_use.id`，存在时转为字符串，缺失时省略；它仍用于结果关联，而 `blocks[].id` 原样透传。 |
| `argsSummary?` | 工具输入的有界单行摘要；没有可摘要内容时省略。 |
| `resultPreview?` | 关联工具结果的有界预览；没有非空结果文本时省略。 |
| `isError?` | 关联结果是否明确标记为错误；没有错误标记时省略。 |
| `executionStatus?` | 关联结果提供的字符串执行状态；否则省略。 |

在单条记录内，结果按消息顺序以 `tool_use_id` 建索引；多个 `tool_result` 块复用同一 ID 时，
后写入的结果覆盖先前结果。该记录中所有 ID 相同的工具调用都会拿到同一条最后结果。这是当前
行为，不是按出现顺序配对；provider 复用工具调用 ID 属于退化输入。结果仅在单条记录内关联，
不会跨记录匹配。provider 未提供 ID 时，工具调用仍有展示 `key`。

投影结果不会被冻结或深拷贝。每轮的 `blocks` 是新数组，但普通块元素与输入共享引用；修改
元素会改到输入记录。只有为移除折叠标记而拆分的块才会重建为 `{ ...block, text: head }`，
修改该块不会改到输入块（其中嵌套对象仍是浅层共享）。每轮的 `meta` 对象是新建的，但存在时其内嵌值
（如 `meta.usage`、`meta.navigationRecord`、`meta.foldedRoundRange`、`meta.summary`、
`meta.judge`、`meta.wrapup`）与输入共享引用。若需保持源 record 不变，宿主应把这些共享值
视为不可变。

### 宿主可渲染哪些 `RoundRecord` 字段

| 字段 | 通道 | 宿主指引 |
|---|---|---|
| `textPreview` | 展示 | 有界的 assistant 文本预览。可安全渲染；投影仅在 `response` 缺失（旧记录）时用它兜底。 |
| `summary` | 展示 | 每轮的 `{ action, note }` 摘要（或 `"missing"`）。可安全渲染，通常作单行轮次注解。它**不是**折叠摘要。 |
| `folded` / `foldedRoundRange` | 展示 | 标记早期上下文被折叠的轮次及被折叠的 round 区间。可安全渲染为“此段已折叠”横幅。 |
| `foldedPayload` | 展示（有界） | 被折叠移除的原始消息。体积很大的归档；**不要**倒进聊天视图。投影只报 `meta.foldedPayloadMessages`（计数）。 |
| `navigationRecord` | 展示 | 有界归档指针 `{ roundFrom, roundTo, artifacts[], truncated? }`，指向被恢复的工具输出。渲染为导航链接/指针，绝不作为消息内容。 |
| `messages` | 模型 | 精确的模型上下文切片，含 `tool_use`/`tool_result` 块与折叠占位符。不要裸渲染；投影从中提取可展示文本与工具调用摘要。 |
| `messages[].meta` | 模型 / 引擎 | 保留该对象及未知键。`meta.source` 是引擎保留标记，投影分类与 judge 可见性依赖它；不得复用它承载宿主自己的来源信息。 |
| `response` | 模型 | 完整的 provider 响应内容（`text`、`reasoning`、`tool_use` 块）、`stopReason`、`usage`。展示字段由它派生；其块形状是模型面向的，可能变化。 |
| `l0facts`、`runState`、`compactionStats`、`judge`、`wrapup`、`toolOutputs`、`dedupKey`、`roundKey` | 模型 / 引擎内部 | 给 governor、resume、诊断用的事实。只有 `judge`/`wrapup`/`summary`/`stopReason`/`usage`/`toolUses`/`dedupKey` 被拷进投影的 `meta` 供可选标注；其余不属于展示表面。 |

### 稳定性承诺

**投影输出形状就是宿主可长期依赖的契约表面**：`key`、`role`、`text`、`blocks`、
`toolCalls`（包括每个工具调用的 `key`）、`reasoning`、`folded`、`round`、`ts`、`meta`。
`RoundRecord` 内部细节不是。只要投影继续
产出相同形状，`messages`/`response`/`foldedPayload`/`runState` 内部的字段名、嵌套与块形
状可在次版本间变化。投影条目与 `meta` 的增量追加是非破坏性的；宿主必须忽略未知的
`meta` 键，不得对键顺序做断言。投影形状的破坏性变更遵循常规版本化迁移策略，并在升级
指南中公告。

`blocks` 是透传的块数组，供需要更丰富渲染（代码块、图片、结构化工具输入）的宿主使用。
只展示纯文本的宿主应改用 `text` 与 `reasoning`。

### 折叠轮次

折叠轮次始终以**摘要加区间**渲染，绝不渲染原始负载：

- 投影会在该轮自身内容之前发出一条 `role: "system"`、`folded: true` 的轮次。当记录携带
  带标记的折叠摘要时其 `text` 就是该摘要（恢复后的种子记录把摘要块留在头部任务消息里，
  投影会把它从用户气泡里拆出）；否则是 `foldedRoundRange`、`summary` 与
  `navigationRecord` 产物计数的有界组合。
- `meta.foldedRoundRange`、`meta.navigationRecord`、`meta.foldedPayloadMessages` 为宿主
  的折叠段 UI 提供信息（“此段已折叠，摘要如下”，外加归档链接）。
- 宿主不得在聊天流中渲染 `foldedPayload` 内容。它是被折叠掉的原始材料，为恢复与锚点
  保留；展示它会破坏折叠，把模型已看不到的负载重新塞回来。

### 推理文本

`reasoning` 携带该轮的推理文本（规范 `reasoning` 块，外加 provider 归一化的
`thinking`/`reasoning_content` 形状），**从不**合并进 `text`。建议默认用折叠/可展开块
展示，因为它长且噪，并与答案保持视觉区分。宿主在向模型回放历史时，不得在自己的存储
中静默丢弃推理——推理回放是模型侧契约（见 thinking 模式要求），与本展示字段无关。

### 合成消息

运行时注入的消息对模型可见但非用户撰写。投影保留其底层 role（通常是 `user`，有时是
`system`）并加标签：

- 每个非用户撰写轮次都带 `meta.synthetic: true`；真实用户与 assistant 轮带
  `meta.synthetic: false`。
- transcript 带标记时 `meta.source` 标明注入方：`judge-control`（round-judge 方向提示与
  续跑催促）、`audit-intercept`（重复命令拦截文本）、`system`、`fold-summary`（折叠横幅）、
  `wrapup`，或 `textPreview`（assistant 轮的旧版预览兜底）。
- `message.meta.source` 是引擎保留字段：投影把**任何非空字符串**值判为 synthetic。宿主不得
  在其中存放普通来源信息，否则真实消息也会被误分类。
- 只有投影通过匹配已配置的文本前缀来判断合成消息时，才会添加
  `meta.sourceInferred: true`。它是增量 `meta` 字段（宿主须忽略未知 `meta` 键），UI 可选展示
  “此条分类来自启发式”；它不是有损 store 检测标记。由 `message.meta.source` 提供分类时，
  以及仅因 `role: "system"` 而判为合成时，均不会添加该字段。
- 轮级判定在存在时出现在 `meta.judge` 与 `meta.wrapup`，宿主无需解析散文就能标注一轮。

宿主应区分地渲染合成轮（徽标、淡化样式）或折叠它们，但不得从声称镜像 transcript 的视图
中丢弃它们。

### 反模式

不要把第二张有损消息表当作模型上下文的真相源。只存 `{ role, text }` 的 UI 表无法往返
工具调用、推理与折叠状态；它一旦出现，宿主就被迫向模型重新注入历史，而 thinking 模式
provider 会拒收纯文本的 assistant 历史。受支持的模式是单 store：transcript 保持模型
上下文，每个 UI 视图都通过 `projectTranscriptForDisplay` 从它派生（与 #91、#135 同一
主题）。宿主特有锚点（session id、序号、附件、run 归属）可以存在 transcript 旁边，但
消息内容不得在那里重复一份。

## 运行状态

引擎构建确定性的运行状态，并能在上下文折叠时注入其有界渲染。它会替换既有的单个 run-state
块而不是追加重复块，并在提供的 `TranscriptStore` 支持时用 `saveRunState` 持久化当前状态。
确定性部分只包含引擎已知事实：预算、工具调用次数与失败次数、已写文件路径、注入的 todo
状态、折叠/导航计数、终止原因，以及工具/checkpoint/未存上（`unpersisted`）计数。
当前终止原因使用与 loop 相同的取值，包括 `end_turn`、`no_tool`、`stall`、
`max_rounds_cap`、`judge_done`、`continuation_exhausted`、
`final_guard_unverified`、`aborted`、`failed`。

`todoStateProvider` 是可选的宿主 todo 状态回调。`semanticStateProvider` 是可选的宿主回调，
提供有界语义文本与版本。版本不匹配会把语义部分标为 `stale`；语义数据是增量，不能覆盖
确定性事实。引擎不调用模型来获取语义状态。

持久化对象受 `RUN_STATE_MAX_SERIALIZED_BYTES`（`64 * 1024`）约束。渲染的提示块受
`RUN_STATE_MAX_CHARS`（`1600`）约束。run-state 辅助函数还把工具条目限制为 128、文件条目
128、todo 条目 64、普通受限的 name/path/id/status 字段 120 字符、语义源文本 1200 字符
（多行：保留换行，每条目录条目单独成行，最多 16 行，行数被裁剪时显式报告
`... (semantic lines truncated: N more)`）。条目或序列化状态被裁剪时，`bounds.truncated`
与相应的省略计数是显式的；渲染块在触到 1600 字符上限时使用 `[run state truncated]`。
语义文本自身的字符级裁剪由持久化的 `semantic.truncated` 标志表达，不内联渲染。
闭合标记 `[/run state]` 在渲染之后恒被追加，因此截断时依然存活——旧块会被原地替换，
而不会在上下文中累积出第二份。

未知 schema 或不完整的持久化状态不会被静默当作有效默认值。恢复时它表现为
`runState.stateAvailability.status = "state_unavailable"`（例如 `unknown_schema` 或
`missing_fields`）。损坏的 file-store JSON 状态同样报告为不可用，而不是被恢复。完全不存
在的持久化状态是正常的，不等同于“存在但无效”。
`stateAvailability` 是本次 resume 的诊断观测结果，会随 state 保留用于诊断，但不会仅因该标记
而拒绝下一次 resume 时结构仍然有效的 state。

## 契约测试套件（issue #183）

`erix-agent/contract-tests`（即 `./contract-tests` 子路径导出，`test/contract/index.js`）
随包发布九个套件文件、共**十一个**可复用的 `node:test` 注册函数（`execute-tool.js` 里有两个：
现行形状与迁移形状；`notes-store.js` 自 issue #183 起也有两个：通用套件与可选的 CAS
子套件）。每一个的签名都是 `xxxContract(label, factory)`：调用它即注册一批以
`label` 命名的断言，在 `node --test` 跑起来之前什么都不会执行。`npm run check:docs:strict`
会对「被 `test/contract/index.js` 再导出、但 `files` 白名单漏掉」的套件直接失败（在普通的
`npm run check:docs` 下它是 warn），因此随包集合不可能无声变小。十一个里最新的是
`skillsLoaderContract`（issue #197），其次是 `fileToolsContract`（issue #184）：
装在已发布的 0.18.0 上的宿主只有九个，不是十一个。

### 套件能证明什么、不能证明什么（issue #183）

**一个套件断言的是「你安装的那个版本上，上游实现的行为」。** 它的价值是**引擎升级的漂移
哨兵**：当你 bump `erix-agent` 版本时，对着你自己的适配器重跑这些套件，一条变红的断言就
指名了哪个契约动了。它**不是**宿主一致性测试，也替代不了宿主自己的一致性测试：

- 一个套件只钉住上游**真正写过**的那些断言。你的实现游走在上游表面*之外*的语义 —— 无论是
  新增、省略还是重新解释 —— 对它都是不可见的：上游从不触碰的东西，没有任何东西在断言它。
- touwaka 的实证：把它的 transcript store 故意改成上游并不具备的一种语义，随包的套件**照样
  全绿**。套件没有对这个改动提出异议，是因为改动就在它的视野之外。
- 同一个不对称也反向成立：套件全绿，对你的 schema、你的迁移、你的连接管理、你的清理机制
  一无所知。那些属于适配器测试，归你负责（这条规则写在各套件的头部注释里）。
- 所以把它们接成**哨兵，而不是你自己语义的门禁**：每次引擎版本 bump 都跑一遍，把一条变红的
  断言当作一行 changelog 来读；为你自己发明出来的行为另留一套宿主所有的套件。为了让升级变绿
  而弱化一条随包的断言，等于丢掉这个套件携带的唯一信号（0.16.0 升级指南对「保真 + 保序」这一
  对断言说的是同一件事）。
- **放宽也是一个信号。** 一次版本 bump 把原来红的套件变绿，意味着上游放宽了一个承诺
  ——这同样要当 changelog 读，因为它往往就是自家适配器在等的那张许可证。issue #183 就是
  这个形状：`revoke` 现在承诺的是「可观察消失」（墓碑**或**物理删除皆可），last-write-wins
  并发断言从通用 notes 套件移到了文件适配器自己的测试里，比较-交换宿主新增了可选的
  `notesStoreCasContract`。这几条不会让原本就能过的适配器变红，也不会反过来给宿主作保：
  上游不再断言被放宽的那部分，所以那份保证（如果你需要）现在归你自己写测试。

**套件里对记录做 `deepEqual` 的地方，那条断言是 JSON 值相等（issue #183 第 6 组）。**
它可测，也有边界，两半都是承诺的一部分：

- **JSON 值的每一个字段都必须回来**，不是白名单子集：上游不认识的字段（`extension`、
  未来的元数据键）也必须原样往返；
- **数组序是值的一部分**：`superseded`、`tags` 与 `current.content` 块必须逐元素同序回来；
- **对象键序不承重**——只有键序不同的两条记录是相等的，宿主可以重序列化；
- **JSON 不可表示的值不在承诺内**：`undefined` 成员、编码器会丢掉的值、`Date`/`BigInt`/`RegExp`
  实例、函数、`NaN`/`Infinity`，以及共享/循环引用。一个值经 JSON 抵达 store，就按 JSON 形态比；
  宿主自留这类值时必须在端口出口投影成 JSON 形态——这正是裁决对宿主自有元数据列（
  `record_version`、`expires_at`）的要求：列留在 schema 里，从公共记录形状里去掉，
  使「进去的形状」就是「出来的形状」。

### 标准用法（issue #183）

把你的实现作为 factory 参数注入；`label` 是生成的每条测试标题的前缀，所以每个适配器用一个
稳定的名字。这些套件只做注册，因此对你自己的测试树跑一次普通的 `node --test` 就会执行它们。
factory 必须**每次调用都交出一个干净的**实现 —— 每个断言组都把它当作一个全新命名空间，且
多个套件会反复进入它：

```js
import { notesStoreCasContract, notesStoreContract, transcriptStoreContract } from "erix-agent/contract-tests";
import { createFileNotesStore, createMemoryTranscriptStore } from "erix-agent";

transcriptStoreContract("my-host-store", () => createMemoryTranscriptStore());
notesStoreContract("my-host-store", () => createFileNotesStore({ dir: notesDir }));
// 比较-交换型 store 额外注册这个可选子套件：它只要求并发写至多一方失败、胜者可读
notesStoreCasContract("my-host-store", () => createFileNotesStore({ dir: notesDir }));
```

其余六个是同一个形状，只有第二个参数不同：

| 套件 | 第二个参数 | factory 必须交回什么 |
|---|---|---|
| `transcriptStoreContract(label, createStore)` | factory | 一个干净的 `TranscriptStore`（必需层 `appendRound`/`load`；run snapshot、run-state 与 issue #157 探针这些方法在存在时会被检验） |
| `notesStoreContract(label, createStore)` | factory | 一个干净的 `NotesStore`（write/read/list/complete/revoke/purge） |
| `notesStoreCasContract(label, createStore)` | factory | 同一个 `NotesStore`，由比较-交换型宿主**额外**注册（issue #183）：并发那条断言容忍一方被拒，不再要求两写都落盘 |
| `modelConfigProviderContract(label, setup)` | async setup | `{ provider, slot, expect: { defaultModel, slotModel, materializedKey } }`；provider 需要一个 `default` 槽加上 `slot`，且 `slot` 的 key 要能经间接引用被物化 |
| `executeToolContract(label, createExecutor)` | factory | 你的 `executeTool` 函数（或 `{ executeTool }`） |
| `executeToolMigrationContract(label, createExecutor)` | factory | 同一个执行器，针对已退役的位置参数调用形状做断言 |
| `assemblyPortContract(label, createPort)` | factory | 你的 `AssemblyPort` 对象；套件会在它之上启动一个真实的 `runToolLoop` |
| `engineApiContract(label, getEntry)` | factory | **包入口命名空间**，即 `() => import("erix-agent")` —— 它断言的是导出的引擎 API，不是你的代码 |
| `terminationPayloadContract(label, getEntry)` | factory | 同一个入口命名空间（`{ runToolLoop }`）；它自带 provider 桩 |
| `skillsLoaderContract(label, { discoverSkills, loadSkill, buildSkillTools })` | 三个函数，不是 factory | 宿主接进来的技能包 loader；它断言 `bundledDir` 归调用方、内置 → 全局 → 项目的优先级、不阻塞的 `{skillId, dir, error}` 失败形状，以及 `ToolSchema` 产出形态 |

### 套件清单（issue #183）

「harness」指该套件跑在什么上面：你的 factory（宿主侧），还是打包的引擎（上游侧，即纯漂移
哨兵）。

| 套件 | 断言什么 | 你必须满足的部分 | 它顺带钉住的上游内部细节 |
|---|---|---|---|
| `transcript-store.js`（16 条） | 记录往返保真（块结构、元数据、未知字段、`meta.source`）、同轮追加顺序、未知键 → `[]`、多 run 隔离、run snapshot 的 latest-only 覆盖写、不带 `state` 的 run-state 快照、写失败向上抛、`round: 0` 种子、折叠载荷往返，以及成对的探针层 | 全部这些：它就是 `TranscriptStore` 契约本身，而随包的保真/保序断言恰恰是「从字段白名单重建」型适配器会挂掉的那几条 | `:input:`/`:engine:round:` 键形状、`(record.dedupKey ?? record.roundKey)` 谓词及其 `??`-而非-`OR` 分叉（issue #171）、探针结果 `null`/`undefined` 的容忍 |
| `notes-store.js`（7 条） | 端口校验（`assertNotesStore`）、落盘前拒绝畸形记录、完整记录往返、作用域隔离与显式未命中、不安全作用域经规范存储与生命周期往返、`limit` 阈值（存量超过 200：给了 limit 就钳到恰好 200，非法 limit 抛错），以及带 `expectedState`/`expectedUpdatedAt` guard 的 revoke 可观察消失 | 端口面与记录/guard 语义。issue #183 之后上游硬义务与宿主策略的分界已写死：端口只承诺「可观察消失」（墓碑**或**物理删除皆可）且不管记录过期，而一写者 last-write-wins 是文件适配器自己的事，已不在这里断言 | 文件存储形状的错误文案（`/valid NoteRecord/`、`/parseable date/`、`/positive safe integer/`）、保留期/purge 时机 |
| `notes-store.js` → `notesStoreCasContract`（1 条，可选；issue #183） | 并发同键写：至多一方失败，失败必须是抛错而不是静默丢弃，胜者必须是那条以完整形状可读的记录 | 只给比较-交换宿主跑，且是在 `notesStoreContract` 之外的**额外**一层 —— 这个子套件刻意比被移除的 last-write-wins 断言更弱，跑绿它对串行化写者一无所证 | 它顺便踩到的两个载荷内容（`left`/`right`），而不是任何冲突错误文案 |
| `assembly-port.js`（4 条） | 端口能启动一个真实 loop 并跑完，`emit(type, payload)` 收到带 payload 的事件类型，显式的细粒度 `provider` 选项覆盖端口自带的 provider，缺少 `chat`/`chatStream` 的 provider 在启动时被 `createAssemblyPort` 与 `runToolLoop` 双双拒绝 | 你的端口所必需的适配器与它的 `emit` 接收端 | 优先级规则（显式选项胜过端口）、启动校验的错误文案 |
| `execute-tool.js`（7 条）+ `executeToolMigrationContract`（2 条） | 你的执行器恰好收到一个结构化执行对象，且每种规范返回形态（`string`、`{content, metadata, success}`、遗留的 `{data}`、返回的 `Error`、抛出的 `Error`）都变成文档规定的 `tool_result` | 调用形状与返回形状。迁移套件还额外证明：裸的位置参数 `(name, input)` 执行器是被**拒绝**的，不是被静默支持 | 这些断言是通过 `runToolLoop` 的 provider 请求观测到的，而不是通过某个公开结果字段 |
| `model-config-provider.js`（4 条） | `resolve()` → default 槽，`resolve(slot)` → 具名槽，未知槽 → 回落 default，以及 `apiKey` 间接引用物化（ADR-001） | 你的 provider 的槽位解析与 key 物化 | 没有任何引擎侧内容：它从不加载引擎 |
| `engine-api.js`（2 条） | 包入口把 `appendUserTurn` 与 `projectTranscriptForDisplay` 导出为函数，且 `appendUserTurn` 在一个最小 store stub 上完成一次预写（含 `dedupKey`/`roundKey` 形状，以及这次预写能喂给展示投影） | 无 —— 这是入口面的哨兵；上游某次 bump 重命名或删掉引擎 API 时它会变红 | 预写记录的确切形状（`round: 0`、`dedupKey`、`roundKey`、`ts`） |
| `termination-payload.js`（4 条） | `failed` 终局携带 `termination.errorCode`（分类透传、`unknown` 回落），abort 抛错携带 `usage`/`rounds`/`finalText` 与 `termination.partial`，累计 usage 按轮归属，成功路径保持旧形状（不会凭空冒出 `errorCode`/`partial`/`usage`） | 不直接对应 —— 它是你宿主侧裁决表的回归网（issue #170 / #176 / #180） | 被打桩的 provider 脚本、`usage` 的「零值 vs 缺字段」规则 |

### 宿主接线规则

- 在你的自己的测试树里，用真实适配器，在每次引擎 bump 之后、发布验收之前，跑完所有宿主侧
  套件（transcript store、notes store、model config provider、execute tool、assembly port）。
- 把入口级哨兵（`engineApiContract`、`terminationPayloadContract`）接一次即可；成本是两次
  注册，换来的是接住「上游重命名了我忘记 grep 的东西」这一类事故。
- 宿主自己发明的行为留在宿主所有的测试里。如果某个随包套件与一条宿主需求冲突，提 issue
  反馈，而不是 fork 套件：fork 掉就丢掉了哨兵。
