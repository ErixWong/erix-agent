# 宿主消费者契约

> 英文版：[host-consumer-contract.md](host-consumer-contract.md)
> 同步基线：host-consumer-contract.md @ 2026-10-09（已同步 #165 judge 记录关联字段与 run 级 outcome 汇总事件；#170 终止裁决决策表；#182 模型元数据与预算推导 + 多模型槽位装配示例与一次性 `model_metadata_missing` 诊断事件；#181 provider 请求注入口 defaultHeaders/extraBody；#157 appendUserTurn 成对可选快路径探针；0.16.0 宿主保真、同轮保序契约与升级指南指针）

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
  （`src/loop/budget.js:59-69`，调用点 `src/loop/orchestrator.js:898-904`）。
  字段**从不跨候选合并**：slot 里只写 `contextWindowTokens`、`modelMetadata` 里只写
  `maxOutputTokens`，结果是什么预算也推不出来。这一对字段必须写在同一个对象里。
- `modelConfig` 必须是解析器（`{ resolve(slot?) }`）。直接把普通配置对象当
  `modelConfig` 传会在启动期抛 `assembly port is missing methods:
  modelConfig.resolve`——因为这个选项名一出现就被当成端口读
  （`src/loop/orchestrator.js:567-582`）。被探测的是**解析后的值**，不是解析器。
- 槽位选择是 per-run 的：槽位名经 `session.modelSlot` 传入
  （`src/loop/orchestrator.js:584-587`）。两个内置 provider 对不认识的槽位名都
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
slot 里的同名字段（`src/loop/provider-runner.js:125-127`、`src/providers/openai.js:51-55`）。

**slot 里的未知字段是惰性的，也是安全的。** 内置 provider 原样拷贝 slot
（`src/config/json-file.js:22-39`、`src/config/static.js:26-38`），两个工厂又只读固定的
参数列表（`src/providers/openai.js:110-153`、`src/providers/anthropic.js:290-334`），
所以认不出的键既上不了线，也不会抛错。这条安全声明只覆盖
**slot 对象**：*顶层* `runToolLoop` 选项写错名仍会抛 `TypeError`（见「`runToolLoop`
选项与工具执行契约」）。

### 预算推导

`budgetTokens = context.budgetTokens ?? computeBudget({ contextWindowTokens, maxOutputTokens })`，
其中 `computeBudget = contextWindowTokens - maxOutputTokens - max(2000, ceil(窗口 × 0.1))`
（`src/loop/orchestrator.js:924-933`、`src/compact/budget.js:9-33`）。
`budgetTokens` 是上下文压缩、单轮聚合输出预算、以及 request-view 预算块的总门。
输出截断上限是另一套推导：先看显式 `outputHygiene.limit`，否则
`clamp(15% × contextWindowTokens, 8192, 100000)`，否则 `4096`
（`src/loop/orchestrator.js:906-917`）。

| 启动时的条件 | 引擎行为 |
|---|---|
| 五个候选里两个字段都找不到 | **静默跳过**：`budgetTokens` 保持 `undefined`，压缩与聚合输出预算保持关，并且恰好发**一条** `model_metadata_missing` 事件 |
| 字段找到了但值非法（非整数、字符串、窗口 ≤ 0、`maxOutputTokens` < 0）或窗口不够大（算出的预算 ≤ 0） | `computeBudget` 在首次 provider 调用前**抛 `invalid_budget`** |
| 宿主自己给了 `context.budgetTokens` | 完全绕开推导——压缩是否启用只看这个值，且无论探测到什么**都不发**事件；非正 / 非整数值由 `validateBudget` 抛 `invalid_budget` |
| 宿主给了 `context.strategy` | 策略被询问时会原样拿到 `budgetTokens`，所以配了策略就能在零元数据下自己门控压缩（`src/loop/orchestrator.js:2129-2132`）；注意内置 sliding-window 策略也是拿这个值去比，`undefined` 时永不触发（`src/compact/sliding-window.js:34-36`） |

两种 `invalid_budget` 都是**运行前**抛错：运行生命周期尚未开始，抛出的错误不带
`termination`、`usage`、`rounds`、`finalText`（边界见「终局载荷（issue #176 / #180）」
里的范围声明）。

### 装配自检断言点

`model_metadata_missing`（`{type, runId, detail}`，每个 run 最多一条）就是宿主对自己
装配的断言点：指望压缩生效的宿主断言它**不出现**；故意不压缩的宿主断言它恰好出现一次。
`detail` 还报出实际解析到的输出上限，所以同一个断言也能接住「我的窗口没参与输出截断上限的计算」。
这个启动期事件上 `onEvent` 抛错是致命的，按标准的 `failed` / `aborted` 终局形状上报
（`src/loop/orchestrator.js:938-952`）。

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

const events = [];
const result = await runToolLoop({
  provider: createOpenAIProvider(slot),  // 请求参数：model / max_tokens / temperature 均来自 slot
  modelConfig,                           // 预算元数据：经 session.modelSlot 重新解析
  session: { id: run.id, modelSlot },
  initialUserMessage: run.prompt,
  executeTool,
  maxRounds: 8,
  persistence: "none",
  onEvent: (event) => {
    events.push(event.type);
    if (event.type === "model_metadata_missing") {
      throw new Error("slot carries no window metadata: compaction is off for this run");
    }
  },
});

result.termination.reason; // "end_turn"——而且上面的断言已经证明预算真的被推导出来了
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
| `error.usage`、`error.rounds`、`error.finalText` | 运行生命周期开始之后抛出的每一个错误（终局 `fail()` 路径与启动期诊断路径） | 抛错时刻的累计用量——就是 `result.usage` 本会携带的**同一个对象**（含 `cacheRead`/`cacheWrite`）——外加轮号与已产出的部分终稿（无产出时为 `""`）。尚未产生任何累计时，这些字段是**零值而不是缺字段**：`{ input_tokens: 0, output_tokens: 0 }`、`0`、`""`。运行开始前的校验错误（未知/非法选项 `TypeError`、装配失败、`modelConfig.resolve` 拒绝）时尚不存在 run，不携带这些字段。 |
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
按决策计数的宿主静默跑偏。一处刻意不同：与其他事件不同（轮次中宿主 `onEvent` 抛错是 fatal 的，
见 issue #173），这一个终局事件的宿主抛错被吞掉——审计记录不得把已跑完的 run 变成 `failed`。

字段稳定性：记录形状是宿主消费面，因此字段只 additive 演进——只会新增可选字段，同一主版本内
不重命名、不改型、不删字段。该档案仍是 debug/分析面，不是完成证书：循环依旧不仲裁完成（见「终答核验」）。

## 终止裁决决策表（issue #170）

宿主应该能不读循环就判断一个终局该怎么办。下面每个机制写的都是**同一个**
`termination.reason` 字段，但一个 run 里只能有一个机制获胜：它们是有序且互斥的。
行号引用是实现真相；代码与本表不一致时，代码是对的，本表就是 bug。

返回路径上可枚举的 reason 共 9 个（`src/loop/orchestrator.js:468`）；
`persistence_failed` 是第十个，只在抛错路径上出现，所以也列出。`truncated` 恰好
对 `max_rounds_cap`、`continuation_exhausted`、`stall`、`final_guard_unverified` 为
`true`（`src/loop/termination.js:7-11`）。

| `termination.reason` | 触发机制（file:line） | 在优先级链中的位置 | 宿主开关 | 推荐宿主动作 |
|---|---|---|---|---|
| `end_turn` | 治理层 stop `completion`（`src/reflection/governor.js:111-113`）或兜底 stop `complete`（`src/reflection/governor.js:126-128`），均由 `terminationReasonForAction` 映射（`src/loop/termination.js:93-100`）。输入：`shouldContinue`（`src/loop/orchestrator.js:2668-2669`）、`completionSignalDetected`（来自 wrapup 信封 `done:true`、`completion.signals` 关键词命中，或 LLM 归一化器（`src/loop/orchestrator.js:2671-2674`、`2676-2730`）） | 轮内优先级**最低**的 stop——其余 stop 与 nudge 都先被试过，且本轮 judge 可以用 `judge_done` 抢走它（`src/loop/orchestrator.js:2866-2873`） | 不可关（它是正常成功出口）。`wrapup:false` 拆掉 JSON 信封通路（`src/loop/orchestrator.js:1019-1023`）；`completion:{signals:[…]}` 拓宽关键词探测（`src/loop/orchestrator.js:1363`） | **接受**，但必须先看 `verification.status`——`end_turn` 本身不是交付证明 |
| `judge_done` | 本轮 judge `done:true` 且 `confidence >= 0.7` 且发生在 end-turn 轮（`src/loop/orchestrator.js:2866-2873`，`isEndTurn` 在 2574），映射在 `src/loop/termination.js:94` | 轮内**最高**的 stop：先于治理层评估，因此压过 stall 与 completion | `reflection:false`、`reflection:{roundJudge:false}`、`ERIX_NO_ROUND_JUDGE=1`、`ERIX_NO_REFLECTION=1`（`src/loop/orchestrator.js:979-993`）。注意 `maxRounds >= 16` 时 reflection 默认自动开启（`src/loop/orchestrator.js:979-982`、`src/loop/reflection.js:8`） | **先接受再核验**：这是模型侧的主张而不是检查。交给下游前先过 `finalGuard` / CI |
| `no_tool` | 治理层 stop `noTool`（`src/reflection/governor.js:114-117`），门在 `noToolRound`（`src/loop/orchestrator.js:2742-2746`）且连续数 `>= maxNoToolRounds`（默认 3，`src/loop/orchestrator.js:1364-1366`） | 在 completion stop 之下、`complete` 兜底之上 | `completion:false` 使 `noToolRound` 恒为 `false`，此 reason 因此**不可达**，run 会改以 `end_turn` 结束；`completion:{maxNoToolRounds:n}` 可调阈值（`0` 为首次即停） | **重试 / 重新提问**：既没声明完成、`truncated` 又为 `false`（什么都没被截断）——它只是在散文里空转。反复出现则告警 |
| `stall` | 同一工具调用签名在处理窗口内重复（`src/loop/orchestrator.js:2607-2621`）叠加 streak 累加（`src/loop/orchestrator.js:2658-2665`），stop 在 `src/reflection/governor.js:66-69`，`STALL_STREAK_LIMIT = 3`（`src/reflection/governor.js:3`），映射在 `src/loop/termination.js:97` | 仅次于 `continuation_exhausted` 的 stop；设计上就高于收尾/错误重复 nudge，不能被饿死（`src/reflection/governor.js:65`） | `stallDetection:false` 使其**不可达**（`src/loop/orchestrator.js:1348-1359`）；`stallDetection:{window,mode}` 可调；`ERIX_STALL_MODE` 覆盖 mode（选项为 `false` 时不覆盖） | **告警 + 换思路重试**：`truncated:true`，不要把文本当答案接受。宿主自己的重复检测应当在这一点上触发 |
| `continuation_exhausted` | provider 连续返 `max_tokens` 且补全预算耗尽（`src/loop/orchestrator.js:2567-2568`，循环在 2530）；治理层 stop `cap`（`src/reflection/governor.js:62-64` / `136-138`）被映射成本 reason，**优先于** `max_rounds_cap`（`src/loop/termination.js:95`） | 两个治理入口的**首要**检查——链顶 | `maxTokenContinuations`（`src/loop/orchestrator.js:1367-1369`，默认 3；`0` 使首次 `max_tokens` 就终局） | **用更多输出空间重试**（抬高 `maxTokens`/`maxOutputTokens`），或接受部分文本并告警；`truncated:true` |
| `max_rounds_cap` | (a) 治理层 stop `cap`：接近上限且不允许扩轮（`src/reflection/governor.js:150-152`）；(b) 轮循环自然跑完（`src/loop/orchestrator.js:2490`，收尾在 `3072-3090`） | (a) 预算边界，在 stall 之下；(b) 在最后一轮之后、任何停止后核验结论生效之前 | `maxRounds`（必需选项）；扩轮余量走 `reflection:{maxExtensions, maxRoundsCap, extensionStep}`（`src/loop/orchestrator.js:1034-1049`）；`ERIX_NO_REFLECTION=1` 关掉自动 reflection | **续跑或按部分交付记账**：用多轮续跑契约继续，否则拿部分结果记账并告警；`truncated:true` |
| `final_guard_unverified` | 配了 `finalGuard` 且它没能认证：不可续跑降级（`src/loop/orchestrator.js:3024-3037`）、修订次数触顶（`3039-3052`）、或轮循环跑完的收尾（`3077-3090`）。只对 6 个 guard 适用 reason 生效（`src/loop/termination.js:14-21`），且仅当 `finalGuard` 是函数（`src/loop/orchestrator.js:3013-3016`） | 严格位于 stop 之后的**后阶段**：它替换 reason，不介入轮内治理 | 整体不传 `finalGuard`（此时 `verification` 为 `skipped` / `no_final_guard`，`src/loop/orchestrator.js:1385-1387`）；`finalGuardMaxRetries` 调修订上限（默认 2，`src/loop/orchestrator.js:1377-1380`） | **不得当已验事实消费**：`verification.status === "unverified"`（`non_continuable` / `max_retries`）。转人工复核或测试系统 |
| `aborted` | 终局 `fail()` 路径且宿主 signal 已 abort（`src/loop/orchestrator.js:845-895`；分类在 847-848 与 867-872，注解在 887-894） | 在抛错路径上压过失败分类——信号先被检查，启动期诊断路径也一样（`src/loop/orchestrator.js:938-951`） | 没有可关项：触发者是宿主自己的 `AbortSignal` | **记账，不自建重跑**：读 `error.usage` / `error.rounds` / `error.finalText`（issue #180）与 `termination.partial`；是用户要停的 |
| `failed` | run 生命周期内抛出的任意错误，经 `fail()`（`src/loop/orchestrator.js:845-895`，循环 catch 在 `3068-3070`），并透传 `termination.errorCode`（`src/loop/termination.js:43-57`） | 兜底：轮根本没跑完，因此压过任何尚未完成的治理决策 | `retry:{attempts, backoffBaseMs, backoffMaxMs}` 决定到这步前重试多少（`src/loop/orchestrator.js:675-686`）；reason 本身不可关 | **按 `termination.errorCode` 分流**（issue #176）：可重试（`timeout`、`rate_limited`、`server`）→ 退避重试；`auth` → 告警并停；`unknown` → 转去查 `termination.detail` |
| `persistence_failed` | 同一个 `fail()` 路径，在错误携带持久化信息时被选中（`src/loop/orchestrator.js:867-872`），并额外挂上 `operation` / `phase` / `sideEffect`（`src/loop/orchestrator.js:880-886`） | 替换 `failed`，不会反向发生；不带 `errorCode`（该字段为 `failed` 专属） | `persistence:"none"` 直接移除 transcript 写入路径；可选 store 能力是降级而非失败（见能力分级） | **告警**：副作用被跟踪过，所以这是完整性信号（ADR-013），不是重试候选 |

### 核验状态与 CLI 退出码

核验结论与终局 reason 是两个独立的轴：`end_turn` 可以 `unverified`；而
`max_rounds_cap` / `stall` / `continuation_exhausted` 只能以 `skipped` 或 `error`
收尾——配了 guard 之后它们拿不到 `verified`，因为 guard 对这三个 reason 返回
`accept` 也仍然以 `final_guard_unverified` 终局（`src/loop/orchestrator.js:3024-3037`）。
CLI 映射在 `exitCodeForVerification`（`bin/cli.js:1015-1022`）：

| `verification.status` | 含义 | 实际会看到的 `verification.reason` | CLI 退出码 |
|---|---|---|---|
| `verified` | 已配置的 guard 接受了一份终答 | —（无 reason 字段） | `0` |
| `skipped` | 什么都没查——**不是**「答案对」的主张，不得改写成 `verified` | `no_final_guard`（`src/loop/orchestrator.js:1385-1387`）；CLI guard 的 `no_capture_evidence` / `no_extractable_candidates`（`bin/final-guard.js:86,89`） | `4` |
| `unverified` | 核验执行了但未通过 | `non_continuable`（`src/loop/orchestrator.js:3025-3029`）、`max_retries`（`3041-3045`） | `2` |
| `error` | guard 抛错、返回非法裁决或超时（对可用性 fail-open，但永远不会变 `verified`） | `timeout` 或 `error`（`src/loop/termination.js:173-176`） | `3` |

`exitCodeForVerification` 对其他任何 status（包括根本没有 `verification` 对象）都返回
`0`，所以**退出码 0 本身不是已验答案的证明**——请读 `verification.status`。抛错的 run
从 CLI 顶层 handler 退出 `1`（`bin/cli.js:1032-1042`），那是失败信号，不是核验结果。

### 机制优先级与互斥关系

同一个轮次内只有一个机制能拍板，顺序如下
（`src/loop/orchestrator.js:2866-2891`、`src/reflection/governor.js:59-129`、
`src/loop/termination.js:93-100`）：

1. **token 补全边界**——连续 `max_tokens` 响应置上 `continuationExhausted`，它是两个
   治理入口的首要检查（`src/reflection/governor.js:62-64`、`136-138`）。因为
   `continuationExhausted` 在 `cap` 映射之前被检查（`src/loop/termination.js:95`），
   由输出截断引起的 `cap` stop 报的是 `continuation_exhausted`，**永远不会**是
   `max_rounds_cap`。
2. **stall stop**（`src/reflection/governor.js:66-69`）——故意高于收尾 nudge 与错误
   重复 nudge，以免真打转被低优先级 nudge 拖到退化成 `max_rounds_cap`。
3. **wrapup 声明**——`done:true` 信封会压住 `shouldContinue` 并置上
   `completionSignalDetected`（`src/loop/orchestrator.js:2668-2674`），这既产生
   `completion` stop（`src/reflection/governor.js:111-113`），又使 `noToolRound`
   为假（`src/loop/orchestrator.js:2742-2746`）。**声明完成与 `no_tool` 因此互斥。**
4. **completion 关键词兜底**——同样这个信号，在没解析出信封时来自
   `completion.signals` 命中终答文本（`src/loop/orchestrator.js:2672-2674`），或来自
   end-turn 轮完全拿不到 JSON 时的 LLM 归一化器（`2676-2730`，开关是
   `reflection.wrapupNormalize` / `ERIX_WRAPUP_NORMALIZE=1`）。
5. **`no_tool` stop**——只在什么都没声明完成且本轮没调工具时可达
   （`src/loop/orchestrator.js:2742-2746`）。
6. **judge 的 end-turn 评估**——`judge_done` 在治理层**之前**被评估
   （`src/loop/orchestrator.js:2866-2873`），因此在其生效的那一轮压过 2-5；它要求
   `isEndTurn`，即 `stopReason === "end_turn"` 且无工具调用
   （`src/loop/orchestrator.js:2574`）。工具轮因此永远不可能产生 `judge_done`；
   `max_tokens` 轮也不可能同时产生 `judge_done` 与 `continuation_exhausted`
   （映射先优 `judge_done`，`src/loop/termination.js:94`）。
7. **停止后验证**——stop reason 定下来后，三个不可续跑 reason 可能多一次强制收尾的
   provider 调用（`src/loop/termination.js:203-256`），然后 `finalGuard` 可以 accept /
   skip / revise / 失败。`revise` 不是终局：它注入一条用户消息，本轮治理重新开始
   （`src/loop/orchestrator.js:3039-3061`）。修订重试次数受 `finalGuardMaxRetries`
   约束（默认 2，`src/loop/orchestrator.js:1377-1380`），guard 自身超时默认 30s
   （`src/loop/orchestrator.js:1381-1383`）。
8. **`fail()` 分类**——任何时刻抛错都会用 `aborted`（信号已置）或 `failed` /
   `persistence_failed` 替换掉上面全部（`src/loop/orchestrator.js:845-895`）。

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

文件型 `NotesStore` 在适配器边界上对每个 `scopeRef` 做一次规范化。`../escape`、绝对
路径、编码分隔符等不安全的 scope 引用会被映射为稳定的 `run-h-...` 目录；目录与持久化的
`record.scopeRef` 使用同一个规范值。宿主与技能必须把原始逻辑 scope 引用交给适配器，
不要预先规范化。已处于规范哈希形态的既有目录仍可读，并参与 list、complete、revoke、purge。

文件适配器假定每个 scope/key 只有一个写入者。并发的读-改-写更新可能丢一次更新及其被
取代的历史（last-write-wins）。需要并发更新的宿主必须在宿主边界串行化；适配器不提供
锁或其他并发机制。`revoke`
在 API 层再进一步：`expectedState` / `expectedUpdatedAt` 并发护栏让与其他写入方竞态的
revoke 返回 `{ status: "unchanged" }`，而不是覆盖它没见过的记录。

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
