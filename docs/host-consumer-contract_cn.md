# 宿主消费者契约

> 英文版：[host-consumer-contract.md](host-consumer-contract.md)

本文定义 `erix-agent` 的宿主集成边界。引擎维护可审计的运行事实；工具权限、归档策略、
重试/重跑策略以及最终消费决策归宿主。责任边界见
[ADR-012](decisions/012-engine-truth-model-efficiency-host-policy.md) 与
[ADR-013](decisions/013-guard-charter.md)。0.6.0 迁移步骤见
[host-upgrade-guide-0.6.0.md](host-upgrade-guide-0.6.0.md)。

## `runToolLoop` 选项与工具执行契约

`runToolLoop` 只接受以下顶层选项键。陌生键抛 `TypeError`，不再被静默忽略。宿主的私有
元数据必须放进显式命名空间，例如 `toolContext` 或 `context`。

```text
assemblyPort, provider, system, wrapup, initialUserMessage, initialMessages, tools,
writeToolNames, writeToolPathKeys, executeTool, maxRounds, maxTokens,
temperature, topP, timeoutMs, deadlineMs, reflection, stallDetection, retry,
completion, finalGuard, finalGuardMaxRetries, finalGuardTimeoutMs,
maxTokenContinuations, toolResultTtl, toolResultFoldMinTokens, context,
todoStateProvider, semanticStateProvider,
modelConfig, modelMetadata, model, expert, user, task, session, requestId,
toolContext, store, persistence, runId, resume, onRound, onJudge,
onToolResult, onPersistenceError, diagnostics, onObserverError, signal, stream,
onDelta, onReasoningDelta, onToolCall, onUsage, onEvent
```

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
`session.id`。若提供 `store`，它必须具备完整八方法 `TranscriptStore`；缺方法在 run 开始前抛 `TypeError`。
`policy` 只装具名的 `runToolLoop` 选项；陌生 policy 键会被拒绝。
这八个 store 方法是 `appendRound`、`load`、`saveCheckpoint`、
`appendCheckpoint`、`loadLatestCheckpoint`、`saveRunState`、`loadRunState`
和 `markRunState`；`getToolMetadata` 与 `emit` 仍是可选项。

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

失败档位按操作而非按端口划分：transcript 的 append/checkpoint/run-state 写失败会终止
run（副作用三态不变，#103）；notes 写失败则继续 + 事件 + 账单，且工具结果不会长得像
“已保存”。宿主端口通过注入的 `reportPersistenceFailure` 桥上报自己的写失败，事件与
账单形状与 transcript 路径一致。

`result.completionErrors[]` 收集收尾失败（多个失败互不覆盖）。主结果若是异常，原异常
仍是主，收尾失败挂在 `error.completionErrors` 上。

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
`continuation_exhausted` 或 `reflection_stop` 停机前，会调用已配置的 guard。guard 收到
`finalText`、`findings`、`messages`、`round`、`rounds`、`signal` 与 `termination`。
`findings` 是结束信封声明的 `label -> 精确值` 映射，是可核验断言的权威载体；核验不解析
`finalText`。`{ action: "accept" }` 允许正常终止。`{ action: "skip", reason }` 以
`skipped` 终止。`{ action: "revise", message }` 会作为独立 user 文本消息注入并继续循环，
最多 `finalGuardMaxRetries` 次修正重试（默认 2）。若到上限仍需修正，loop 保留最后的
`finalText`，把 `verification.status` 置为 `unverified`，并以
`termination.reason === "final_guard_unverified"` 终止（fail-closed）。

不可续的停机原因 `max_rounds_cap`、`stall`、`continuation_exhausted`、
`reflection_stop` 不会仅因 guard 返回 `accept` 就变成 verified；它们降级为
`final_guard_unverified`。guard 抛错、返回无效决策或超时，对循环可用性是 fail-open：
原终止原因保留，但 `verification.status` 为 `error`，结果永远不会是 `verified`。
每种 guard 结果都发出 `onEvent` 事件，`type: "final_guard"`，`action` 为 `accept`、
`skip`、`revise`、`degraded` 或 `error`。当 store 提供 `markRunState` 时，终态为：
未核验结果 `unverified_error`、guard 错误 `guard_error`、其余 `succeeded`。

引擎没有独立的“交付认证”或“完成认证”层。它报告轮数、工具、文件调用、归档、终止与核验
等事实。任务是否完成、交付物是否满足要求、能否自动进入下游，仍由宿主、测试系统或人工
审核决定。

### NotesStore 作用域与写契约

文件型 `NotesStore` 在适配器边界上对每个 `scopeRef` 做一次规范化。`../escape`、绝对
路径、编码分隔符等不安全的 scope 引用会被映射为稳定的 `run-h-...` 目录；目录与持久化的
`record.scopeRef` 使用同一个规范值。宿主与技能必须把原始逻辑 scope 引用交给适配器，
不要预先规范化。已处于规范哈希形态的既有目录仍可读，并参与 list、complete、janitor。

文件适配器假定每个 scope/key 只有一个写入者。并发的读-改-写更新可能丢一次更新及其被
取代的历史（last-write-wins）。需要并发更新的宿主必须在宿主边界串行化；适配器不提供
锁或其他并发机制。

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
JSON skeleton。checkpoint 保留完整工具结果文本。note、todo、错误和显式保护的
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
- `result.completionErrors: []` —— 预留给收尾阶段失败；默认 `[]`。

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

## 运行状态

引擎构建确定性的运行状态，并能在上下文折叠时注入其有界渲染。它会替换既有的单个 run-state
块而不是追加重复块，并在提供的 `TranscriptStore` 支持时用 `saveRunState` 持久化当前状态。
确定性部分只包含引擎已知事实：预算、工具调用次数与失败次数、已写文件路径、注入的 todo
状态、折叠/导航计数、终止原因，以及工具/checkpoint/未存上（`unpersisted`）计数。
当前终止原因使用与 loop 相同的取值，包括 `end_turn`、`no_tool`、`stall`、
`max_rounds_cap`、`reflection_stop`、`judge_done`、`continuation_exhausted`、
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
