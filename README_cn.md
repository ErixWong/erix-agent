# erix-agent

> English version: [README.md](README.md)

**erix-agent** 是一个零依赖、纯 ESM 的无头编码 agent LLM 运行时。它提供双协议流式 provider、工具调用循环、上下文压缩、checkpoint、恢复、有界 recall，以及可选的 reflection/judge 层，用于无人值守工作。

**定位：无头 agent。** 产品形态是一个引擎加编程式任务入口：任务进入，agent 运行工具循环，事件离开进程，运行可以恢复。它不是 UI，也不是为坐在终端前的人设计的。`runToolLoop` 管理一个 agent 任务的完整生命周期：启动、运行、停止、恢复，并通过 `onRound`、`onDelta`、`onToolCall`、`onUsage` 和 `onEvent` 流式传出事件。

erix 与 pi 的关系是互补的：

- **pi 是交互式 agent**：人在环，支持 TUI/subagent/MCP 工作流。
- **erix 是无头 agent**：无人值守，由宿主调度。

边界止于一个 agent 任务生命周期。多角色编排、仲裁、重试调度、reaper 和任务队列属于宿主（`app_container` / `touwaka`）的职责，不属于本库。保持这一边界，可以避免把小型运行时变成无头 agent 平台，并保留零依赖设计。

CLI（`erix`）是验证器和调试器，不是产品：

- `erix chat` 是单任务入口，也可以供 benchmark harness 使用。
- `erix repl` 是交互式 TUI，衡量人机协作，而不是无人值守自主能力。
- 预期的无人值守评估入口是外部 **erix-bench** harness：它在容器中驱动任务，并比较 `--agent erix|pi`。

运行时还提供自描述 skill、MCP 集成、transcript store 和宿主提供的任务状态等扩展面。仓库内置 `notes` skill；todo skill 是 `examples/skills/todo/` 下的示例，不是内置的 `runToolLoop` 能力。

> **安全边界：** 运行时不执行安全策略。安全责任由调用方承担。在本地运行意味着让 agent 访问你的本地信任域；嵌入式或沙盒部署必须由宿主隔离。CLI 工具有意允许任意文件路径和 shell 命令，不添加白名单或确认提示。

项目面向包括 `app_container`（PI Agent 审计/开发路径）和 `touwaka`（AgentLoop/对话路径）在内的集成。这些宿主集成不属于本包的生命周期边界。

## 为什么需要统一的 Headless Agent？

多个自研项目与 vibe coding 项目需要接入 LLM，但开发者未必熟悉 Prompt、上下文工程、
Tool Calling、结构化输出、重试与成本控制。每个项目各自接入，会把同一批问题重复一遍：
调用方式不统一、上下文组织不合理、Token 消耗过高、工具调用不稳定、错误处理不完善、
Agent 行为难以预测。统一 Headless Agent 的价值，就是让业务代码依赖**一套稳定的编程接口**，
而不必重复解决底层的工程问题。

| 需求 | 本运行时提供 | 由宿主负责 |
|---|---|---|
| 降低使用 LLM 的门槛 | `runToolLoop` 单一入口；双协议 provider；规范消息模型；上下文压缩；checkpoint/resume；错误分类 | 产品级的 Prompt 与流程设计 |
| 统一管理模型配置与运行策略 | 鸭子类型的 `ModelConfigProvider.resolve(slot)`，内置 `static` / `env` / `json-file` 适配器；按 slot 选模型；`apiKey`/`apiKeyEnv`/`apiKeyFile` 间接引用；预算推导 | 配置来源本身（数据库/配置中心）、项目与租户额度、fallback 策略、Prompt 与 Agent 版本 |
| 统一记录调用、支撑成本分析与事后审计 | 事件流（`onRound` / `onDelta` / `onToolCall` / `onUsage` / `onJudge` / `onEvent`）、token 计量、`TranscriptStore` 落盘、稳定 run id、checkpoint 与有界 recall（支持回放） | 日志与成本存储、监控看板、保留策略、审计流程 |
| 统一安全、权限与工具调用边界 | 唯一执行入口（`executeTool`）；数据无法扩张的执行器注册表；schema 求交；`erix-agent/tools` 下内置的 `recall` 取回工具 | 策略本身：哪个项目能用哪些 Agent、可调哪些工具、哪些操作需人工确认、是否允许联网与写操作、调用次数与时长限制 |
| 降低第三方框架升级的影响 | 零运行时依赖、自有实现；稳定导出面 + 面向消费方的 `erix-agent/contract-tests` | — |
| 沉淀统一的 Agent 能力与工程规范 | 规范消息与工具格式、ADR 决策记录、契约测试、基准 harness | — |

两条边界让这张表站得住：运行时**不执行任何策略**——只提供钩子，由宿主决定
（[ADR-009](docs/decisions/009-safety-layering_cn.md)）；运行时**只负责单个任务生命周期**——
队列、仲裁与重试调度留在宿主
（[ADR-012](docs/decisions/012-engine-truth-model-efficiency-host-policy_cn.md)）。

## 为什么构建自有实现？

项目调研结论（2026-08-29；见下方调研索引）是：关键缺口不是再增加一个 provider adapter：

- **Vercel AI SDK**（`ai` v7）拥有成熟的 provider 和工具循环支持，但上下文压缩明确留给应用实现（官方 cookbook 使用 `prepareStep` 编写应用代码）。因此，这个运行时最有价值的部分仍需自行构建。
- **LangChain.js / Mastra / LangGraph** 提供框架级抽象，而两个指定宿主项目都刻意避免引入框架依赖。
- **oneringai 及类似的完整技术栈** 形态不合适：依赖沉重，并包含无关的音频/图像能力。
- **pi SDK** 是交互式 agent。它的人在环形态与 erix 的无头生命周期互补，而不是替代 erix。

替换本实现的触发条件（例如增加第三种非 OpenAI 兼容协议）以及项目止损线属于内部决策，不是运行时能力。

## 模块地图

公共入口是 `src/index.js`；当前完整源码树如下：

```text
src/
  index.js                         公共导出
  loop.js                          薄转发垫片（runToolLoop 本体在 loop/）
  assembly.js                      AssemblyPort 校验（宿主边界）
  run-state.js                     有界的确定性与语义运行状态
  tokens.js                        保守的 token 估算
  loop/                            # 编排核心
    orchestrator.js                runToolLoop 主循环
    provider-runner.js             provider 调用、重试与快照回滚
    checkpoint-executor.js         工具前后检查点与聚合闸门
    budget.js                      预算校验与状态克隆辅助函数
    aggregate-budget.js            单轮聚合输出闸门
    termination.js                 终态归类
    resume-manager.js              断点恢复与 run-state 应用
    error-ledger.js                重复错误记账
    messages.js                    消息/block 辅助函数
    reflection.js                  反思提示与决策解析
    task-brief.js                  任务简报选取
    abort.js                       中止信号辅助函数
    block-helpers.js               block 访问辅助函数
  providers/
    anthropic.js                   Anthropic provider 与流式处理
    errors.js                       provider 错误与分类
    openai.js                       OpenAI-compatible provider 与流式处理
    payload.js                      provider payload 与超时选项
    timeout.js                      provider 超时处理
  messages/
    anthropic.js                   Anthropic 协议转换与流组装
    canonical.js                    规范消息/工具转换
    rounds.js                       消息校验与轮次分组
  compact/
    budget.js                       上下文预算计算
    enforce-size.js                 字段大小限制
    fold-llm.js                     LLM 辅助的折叠策略
    fold-statistical.js             统计折叠与导航记录
    anchors.js                      机械锚点抽取（路径/SHA/issue/URL/错误行）
    fold-fidelity.js                用户输入逐字引用与反向信号检测
    helpers.js                      共享的折叠、保护、stub 与 hook 辅助函数
    sliding-window.js               滑动窗口折叠策略
  store/
    bounded-recall.js               有界、基于游标的 recall 实现
    file.js                         JSONL transcript、checkpoint 与状态存储
    memory.js                        进程内 transcript、checkpoint 与状态存储
    notes.js                        宿主侧 notes 存储
  config/
    api-key.js                      API key 物化
    env.js                          基于环境变量的模型配置
    json-file.js                    基于 JSON 文件的模型配置
    static.js                       静态模型配置
  reflection/
    governor.js                     确定性的轮次治理
    judge.js                        objective timeline 与 judge prompt/response 解析
    l0.js                           objective facts 与摘要解析
    wrapup.js                       wrap-up 协议解析与规范化
  tools/
    index.js                        可选 tools 子路径导出
    providers.js                    tool-provider adapter
    recall.js                       可选 recall tool adapter
    registry.js                     工具 schema 与 executor registry
```

`src/index.js` 导出 provider、规范消息转换、token 与压缩辅助函数、transcript store、run-state 辅助函数、配置 provider、`runToolLoop` 以及 reflection 辅助函数。可选的 `erix-agent/tools` 子路径导出上面列出的工具辅助函数。

## 工程约束

- 零运行时 npm 依赖、纯 ESM、Node 22+，无构建步骤。
- 测试使用 `node --test`；类型信息通过 JSDoc typedef 表达。
- 包以 `erix-agent` 发布到 npm，代码托管于 GitHub 的 `ErixWong/erix-agent`。
- 永远不要提交 token、API key 或其他凭据。

当前 `package.json` 中发布包的版本是 `0.6.0`。声明的 `files` 为：

```json
["src", "bin", "skills", "README.md", "README_cn.md", "CHANGELOG.md",
 "docs/host-consumer-contract.md", "docs/host-upgrade-guide-0.6.0.md",
 "test/contract/assembly-port.js", "test/contract/execute-tool.js",
 "test/contract/index.js", "test/contract/model-config-provider.js",
 "test/contract/notes-store.js", "test/contract/recall-contract.js",
 "test/contract/transcript-store.js", "LICENSE"]
```

## 宿主端口与错误账本

组合边界上一次性校验四个适配器端口，其余宿主边界作为显式 `runToolLoop` 选项传入：

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider: { resolve(slot) }
  provider,    // { chat?, chatStream? }
  tools: { definitions, executeTool, getToolMetadata? },
  store,       // 完整 TranscriptStore（九方法），除非 persistence: "none"
  session: { id, resume?, initialMessages? },
  policy?,     // 显式 runToolLoop 选项；陌生键会被拒绝
  emit?,       // (eventType, payload) => void
});
```

`NotesStore` 是 CLI 侧引擎技能（跨 run 记忆），其写契约见
[docs/host-consumer-contract_cn.md](docs/host-consumer-contract_cn.md)；引擎不检查 notes
内容，只提供注入的 `reportPersistenceFailure` 桥，让宿主端口产生与 transcript 路径一致的
事件与账单形状。

持久化失败不再静默：每个 `runToolLoop` 结果都带 `unpersisted: Entry[]`（去重、错误消息
截断到 500 字符）与 `completionErrors: []`；同一份账单会镜像进确定性 run state，抛出型
持久化失败则挂在 `error.unpersisted`。diagnostics sink 自身抛错会记成 `delivery_failure`
条目，而不是凭空消失。

## 可复用的归一化原语

自带 OpenAI 兼容传输层的宿主可以从包根导入这些辅助函数（不做 I/O、不调用模型）：
`normalizeOpenAIUsage`、`normalizeOpenAIStopReason`、`parseOpenAIToolArguments`、
`createOpenAIStreamAccumulator`。完整语义表见
[docs/host-consumer-contract_cn.md](docs/host-consumer-contract_cn.md)。

公共 `exports` 为：

```json
{
  ".": "./src/index.js",
  "./tools": "./src/tools/index.js",
  "./contract-tests": "./test/contract/index.js"
}
```

## `runToolLoop` API

核心入口是：

```js
runToolLoop({ provider, executeTool, ...options })
```

它管理一个任务生命周期，并返回 `finalText`、当前 `messages` 和 `transcript`、`rounds`、`truncated`、`termination`、`verification`、可选的 `runState`、汇总 `usage` 以及 `compactionStats`。

### 完成、重试与终止

- `completion` 默认为 `{ signals: [], maxNoToolRounds: 3 }`。启用后，完成信号和连续无工具轮次可以停止任务。`completion: false` 会禁用这一完成层。
- `retry` 默认为 `false`。传入对象后，会针对被归类为可重试的 provider 错误启用重试；`retry: {}` 表示初始尝试之外默认重试两次。`backoffBaseMs` 默认为 `1500`，`backoffMaxMs` 默认为 `10000`。
- 库中的 `maxRounds` 默认为 `8`。CLI 提供自己的命令级默认值。
- `maxTokenContinuations` 默认为 `3`。以 `max_tokens` 结束的响应最多可以继续指定次数；耗尽后产生 `termination.reason === "continuation_exhausted"`。
- `stallDetection` 默认为 `{ window: 4 }`。默认模式是 `appear`，会检测窗口内任意位置重复的工具签名；`mode: "consecutive"` 要求整个窗口都匹配。传入 `stallDetection: false` 可禁用。
- `resume` 默认为 `false`。配合 `store` 和 `runId` 时，`resume: true` 会恢复 transcript、运行状态、最新 checkpoint，以及所有仍需执行的待处理工具调用。若 checkpoint store 同时提供 writer（`saveCheckpoint` 或 `appendCheckpoint`）和 `loadLatestCheckpoint`，则在执行前或执行后 checkpoint 无法持久化时会 fail closed。宿主的 `executeTool` 仍必须按 tool id 保证幂等；循环无法保证外部副作用 exactly-once。

正常终止词汇为：

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

当循环无法返回正常结果时，`aborted` 和 `failed` 也会附加到抛出的错误上。

### 终稿 guard 与收尾

- `finalGuard` 是可选的。在正常停止（`end_turn`、`no_tool`、`judge_done`、completion 或不可继续的 cap）之前，它会接收 `{ finalText, findings, messages, round, rounds, signal, termination }`，其中 `findings` 是结束信封声明的 `label -> 精确值` 映射（可核验断言的权威载体，guard 不解析散文）。它可以返回 `{ action: "accept" }`、`{ action: "skip", reason }` 或 `{ action: "revise", message }`。
- `finalGuardMaxRetries` 默认为 `2`；`finalGuardTimeoutMs` 默认为 `30000`。revise 决策会将返回的 `message` 注入为 user message，并在仍有重试次数时继续。对不可继续的停止进行 revise，或重试耗尽后仍 revise，会返回 `termination.reason === "final_guard_unverified"`，并令 `verification.status === "unverified"`。guard 错误或显式 skip 会保留原始终止原因。guard 错误和超时会报告 `verification.status === "error"`，为保证可用性而 fail open，但文本并未得到核验。

没有 guard 时，verification 为 `skipped`，原因是 `no_final_guard`。

- `wrapup` 默认为 `true`。启用后，循环可以在 `end_turn` 解释顶层 JSON 协议 `{"done":true,"summary":"...","output":"..."}`。传入 `wrapup: false` 或设置 `ERIX_NO_WRAPUP_INSTRUCTION=1`，会同时禁用指令、JSON 解析、`finalText` 替换和 LLM 规范化。

只有 `verification.status === "verified"` 表示终稿通过了 guard。`skipped` 表示没有执行核验，或没有可比较的 capture；它不是正确性的正面结论。

### Reflection 与 judge 治理

省略 `reflection` 时，当 `maxRounds >= 16`（`DEFAULT_REFLECTION_MIN_ROUNDS`），库会自动启用基础 judge，除非设置了 `ERIX_NO_REFLECTION=1`。传入 `reflection: false` 可禁用。CLI 的 `chat` 复用同一个常量（不再有单独门槛），因此两边默认值不会漂移；`repl` 显式传入 `reflection: false`。`ERIX_NO_ROUND_JUDGE=1` 会禁用 round judging，但不会禁用透明拦截。

对象形式接受：

```text
enabled
roundJudge
judgeIntercept
judgeIntervalRound
judgeInterceptTimeoutMs
judgeFailureLimit
triggerRound
extensionStep
maxExtensions
maxRoundsCap
format
wrapupNormalize
judge: { provider, evaluator }
onReflection
```

循环使用的默认值如下：

- reflection 启用时，`roundJudge` 和 `judgeIntercept` 都启用。
- `judgeFailureLimit` 默认为 `3`；round judge 连续失败后，剩余运行期间会禁用 round judging。
- `judgeIntervalRound` 为 `5`；完成这么多次真实工具执行后，下一次工具调用会在执行前独立审计。
- `judgeInterceptTimeoutMs` 为 `30000`；拦截超时或 judge 失败时，会降级为执行原始工具。
- `triggerRound` 默认为初始 `maxRounds` 的 80%。
- `extensionStep` 默认为 `max(8, maxRounds * 0.5)`，`maxExtensions` 默认为 `2`，`maxRoundsCap` 至少为初始 `maxRounds`，否则为 `256`。
- round judge 只有在 `done: true` 且 `confidence >= 0.7` 时才能停止。`done: false` 决策会注入 continuation/nudge；`direction: "off_track"` 是软方向提示，本身不会阻止工具执行。
- wrap-up LLM 规范化默认关闭；启用 `wrapupNormalize: true` 或 `ERIX_WRAPUP_NORMALIZE=1`。

`onJudge` 接收轮次和拦截决策，包括 `judge_done`、`nudge`、`continue`、`executed`、`blocked` 和 `degraded` 操作。循环不会把 judge 当作宿主级完成证书；宿主仍需决定是否消费结果。

### 工具、上下文、存储与压缩

- `executeTool` 只接收结构化对象 `({ id, name, input, context, signal })`。三种规范返回形态是 `string`、`{ content, metadata?, success? }` 和 `Error`；旧的 `{ data, success, ... }` 及其他 duck-typed 形状仍会宽容归一化，但已弃用，不应依赖。
- `context` 可选，默认为 `undefined`；提供时接受 `strategy`、`budgetTokens`、`keepRounds`、`toolContext` 和 `task`。没有 `budgetTokens` 时，循环会从 `modelConfig`、`modelMetadata`、`model`、`provider` 或 `context` 中的 `contextWindowTokens` 和 `maxOutputTokens` 推导。策略启用时，压缩默认保留六轮。任务 brief 的优先级依次为：显式 `task`、`context.task`，然后是入口 transcript 中最后一条 user message。
- 压缩支持 `summaryRole`、`recoveryHint`、`protectedMessage`、`stripHistoricalImages`、`onBeforeFold`、`onAfterFold` 和 `stubFor`。如果 protected set 本身无法放入预算，protected messages 可能降级；结果会记录 `compactionStats[].protectedDowngraded`。单个无法放入预算的 protected message 会产生 `invalid_budget`。
- `stubFor(message)` hook 可以为折叠后的工具结果保留有界、非秘密 stub（**全部** tool_result，不再有可重放性标记子集——ADR-016）。CLI 的 stub 限制为 200 个字符，最多包含三个安全的 `label=value` fact。折叠导航记录是形如 `{ roundFrom, roundTo, artifacts: [{ id, locator, digest, status }] }` 的仅地址记录，最多 10 个 artifact、400 个字符。它们不是语义搜索，也不是 provenance 证明。
- `writeToolNames` 默认为 `["writeFile"]`；自定义写工具必须显式命名。`writeToolPathKeys` 默认为 `["path", "file_path"]`。judge 的 `filesWritten` 足迹不会根据工具名称推断任意写工具。
- `TranscriptStore` 实现提供幂等的 `appendRound`，以及可选的 checkpoint 和 run-state 持久化。`store.recall()` 的对象形式支持 `fromRound`、`toRound`、`pattern`、`artifactRef`、`limit`、`cursor` 和 `maxBytes`，返回 `{ text, truncated, nextCursor?, status }`。这是有界的精确取回，不是语义搜索、完成证明或 provenance 核验。`cursor` 与其 run、范围、筛选条件、限制和 source version 绑定；不匹配时会拒绝，而不是静默重新开始。`limit: 0` 和 `maxBytes: 0` 会被拒绝。File store 会将过大的源记录报告为 `status: "truncated"`，并令 `error.code === "record_too_large"`。旧的位置参数 recall 仍可用，并返回字符串。
- `runState` 是确定性的、有界的，并在压缩点以替换方式注入。store 可以实现 `markRunState`、`saveRunState`/`loadRunState`、`saveCheckpoint`/`appendCheckpoint` 和 `loadLatestCheckpoint`。持久化 run state 有 64 KiB 序列化硬上限，以及条目和字段上限；裁剪通过 `bounds.truncated` 可见。`todoStateProvider` 和 `semanticStateProvider` 由宿主注入；语义状态有界且带版本，过期版本标记为 `stale`。无效或损坏的状态在 resume 时报告为 `state_unavailable`，而不是静默当作全新状态。
- Provider 特有的细节保持显式：`transport` 作为 `dispatcher` 透传给 fetch（也可以增强 fetch options）；格式错误的 OpenAI 工具参数以 `_truncatedArguments` 暴露，`_raw` 为兼容别名；不安全的 run ID 映射为 `run-h-<sha256 first 24 hex characters>`。

### 回调与事件

循环回调包括：

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

流式 observer（`onDelta`、`onReasoningDelta`、`onToolCall` 和 `onUsage`）在 observer 抛出异常时通过 `onObserverError` 报告。持久化失败使用 `onPersistenceError`。`onEvent` 接收包括 `round_start`、`round_end`、`tool_use`、`tool_result`、`attempt`、`recovering`、`recovered`、`delta`、`reasoning_delta`、`tool_call`、`usage`、`forced_final` 和 `final_guard` 在内的结构化事件。

## CLI：`erix`

`erix` 是仓库的验证/调试前端，不是无头运行时的产品接口。

### 命令与参数

```text
erix --version, -v
erix --help, -h
erix chat "<prompt>" [--stream] [--reflection <on|off>] [--final-guard|--no-final-guard] [--no-notes] [--timeout <ms>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--judge-log <path>]
erix repl [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard]
erix skills [--skills-dir <path>]
erix mcp [--config <path>]
```

不带参数运行 `erix` 会进入 `repl`。`chat` 参数由 `bin/cli.js` 实现；上面的 `repl` 参数由 `bin/repl.js` 实现。特别是，`repl` 不实现 `--stream`、`--reflection`、`--timeout`、`--no-notes` 或 `--judge-log`。

`chat` 默认 64 轮、300 秒 idle timeout、在 `max-rounds >= 16` 时启用 reflection，并关闭 final guard。`repl` 默认 32 轮、无 idle timeout、`reflection: false`，并在一轮无工具轮次后完成。

共享 CLI 参数包括：

- `--stream` 在 `chat` 中流式输出模型文本。
- `--session <id>` 选择 session；未显式指定 chat session 时，`chat` 会创建一个从工作目录派生的唯一 ID。
- `--dir <path>` 选择 transcript 目录；`chat` 默认使用 `~/.erix/transcripts`。
- `--max-rounds <n>` 设置工具循环轮次上限。
- `--reflection <on|off>` 选择 chat reflection 行为。
- `--final-guard` 启用 CLI provenance guard；`--no-final-guard` 是兼容性 no-op，因为默认已关闭。
- `--no-notes` 只移除 `notes` skill，保留其他已加载的 skill。
- `--timeout <ms>` 为 `chat` 提供软任务截止时间；它会推动循环进入 wrap-up，而不是强制杀死进程。
- `--idle-timeout <seconds>` 在没有进展后中止；`chat` 默认为 300，`repl` 默认为 0（禁用）。
- `--compact-budget <tokens>` 覆盖自动压缩预算。
- `--judge-log <path>` 在 `chat` 中以 JSONL 追加经过脱敏的轮次/judge 拦截决策。

内置 CLI 工具为 `readFile`、`rg`、`tree`、`writeFile` 和 `exec`。它们操作任意路径和命令。超过 4096 字符的工具输出由引擎全量归档进 transcript 的字节保真 `toolOutputs`，模型可见侧只看到截断 stderr/提示与 recall 配方（ADR-015）；CLI 不再写第二份 archive 文件，也没有 `.meta.json` sidecar。早期精确值用 `recall({ pattern: "关键词" })` 搜索、或 `recall({ fromRound, lineOffset, lineLimit })` 按行直读取回。

重复的 `exec` 命令会正常执行并返回新输出：引擎不做幂等分类、不检测重跑、也不发重跑告知（ADR-016）。重跑值可能不同，所以副作用与重跑风险由宿主的权限/沙箱/幂等层承担——引擎的审计事实是归档输出本身，而不是"这条命令是否可重放"。

内置的自描述 `notes` skill 提供 `note_take`、`note_read`、`note_list` 和 `note_forget`。它是一个面向 run、pull-only 的便利索引，用于事实、一次性值、决策和 artifact 引用；它不是逐轮日志，也不是 provenance 证据源（guard 的证据是 transcript 的归档输出）。内置 skill 从 `skills/notes/` 加载；用户和项目 skill 可以从 `~/.erix/skills/`、项目的 `.erix/skills/` 或 `--skills-dir <path>` 提供。`erix skills` 会列出发现的 skill。

MCP 使用标准 `.mcp.json` 配置，并支持 stdio 和 HTTP server。`mcp` proxy 提供 `list`、`search`、`call` 和 `status` action。`erix mcp` 会列出已配置的 server 及其连接状态。

### 配置与本地状态

CLI 从 `$XDG_CONFIG_HOME/erix/config.json` 或 `~/.erix/config.json` 读取模型配置；`--config <path>` 覆盖该位置，环境变量优先。必需的模型输入为 `LLM_KIT_ENDPOINT`、`LLM_KIT_API_KEY`，以及来自 `LLM_KIT_MODEL`、`ERIX_DEFAULT_MODEL` 或 `slots.default.model` 的模型。`slots.default.maxOutputTokens` 默认为 `16384`；`slots.default.contextWindowTokens` 会启用自动压缩，`--compact-budget` 覆盖计算出的预算。

MCP 配置从当前目录的 `.mcp.json` 或 `~/.erix/mcp.json` 读取。本地主要目录结构为：

```text
~/.erix/
  config.json
  mcp.json
  transcripts/
    <safeRunId>.jsonl
    <safeRunId>.checkpoint.json
    <safeRunId>.state.json
  <session>.json                 REPL session 快照
  notes/run/<safeRunId>/         notes skill 数据
  skills/                        用户 skill
  todos/                         由示例 todo skill 使用
```

`ERIX_NOTES_DIR` 会修改 notes 根目录。两种 CLI 模式都支持 `ERIX_EXEC_TIMEOUT_MS` 和 `ERIX_FINAL_GUARD`；`chat` 还支持 `ERIX_NO_TOOL_ROUNDS`、`ERIX_MAX_ROUNDS`、`ERIX_REFLECTION`、`ERIX_NO_REFLECTION`、`ERIX_NO_NOTES` 和 `ERIX_JUDGE_LOG`。库级控制项 `ERIX_NO_WRAPUP_INSTRUCTION`、`ERIX_NO_FORCED_FINAL` 和 `ERIX_STALL_MODE` 也会由相关循环行为使用；`ERIX_WRAPUP_NORMALIZE=1` 会启用 wrap-up LLM 规范化。

## 文档

- [docs/requirements_cn.md](docs/requirements_cn.md) - 需求与阶段
- [docs/architecture_cn.md](docs/architecture_cn.md) - API 契约与数据流
- [docs/decisions/](docs/decisions/) - 设计决策，包括配置、存储、压缩、reflection、工具、skill、安全、judge 方向、引擎/模型/宿主边界和 guard policy
- [docs/testing_cn.md](docs/testing_cn.md) - 测试策略与行为指标
- [docs/host-consumer-contract_cn.md](docs/host-consumer-contract_cn.md) - 关于核验、有界 recall、provenance 和重跑的宿主消费者契约
- [docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md) - 0.6.0 破坏窗口迁移步骤（英文）
- [docs/host-upgrade-guide-v030_cn.md](docs/host-upgrade-guide-v030_cn.md) - 面向 `touwaka` / `app_container` 的宿主升级指南与 v0.3.x 行为
- [docs/maintenance-policy_cn.md](docs/maintenance-policy_cn.md) - 维护策略与内部替换/止损标准
- [docs/research/](docs/research/) - 调研报告（仅中文）
- [docs/design/](docs/design/) - 设计与 RFC 材料（仅中文）
- [docs/tasks/](docs/tasks/) - 当前任务文档（仅中文）

有界 recall 设计说明是 [docs/design/2026-09-14-bounded-recall-api.md](docs/design/2026-09-14-bounded-recall-api.md)（仅中文）。

## 状态与版本历史

当前包版本为 **v0.6.0**，依据 `package.json` 和 `CHANGELOG.md`，日期为 2026-09-18。0.6.0 破坏窗口的迁移步骤见
[docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md)。

- **v0.6.0 (2026-09-18)**：ADR-015/ADR-016 破坏窗口收口——可重放概念（`rerunOf` 告知、重跑检测、auto-capture）与 `resourceStore` 端口删除；guard 改为核验结束信封的 `findings` 与全部归档输出比对；引擎标配 recall 工具与输出卫生（`toolOutputs`）；持久化失败通过 `unpersisted`/`completionErrors` 上报；陌生 run 选项抛错。详见 CHANGELOG 与 0.6.0 升级指南。
- **v0.5.1 (2026-09-15)**：通过识别并替换 fold marker，修复 fold summary、导航记录、stub、`[本 run 状态]` 和 run state 反复累积的问题；增加端到端 Memento 场景覆盖折叠后的 truth、凭据安全 stub、重跑、重复折叠和有界 recall。
- **v0.5.0 (2026-09-15)**：将 CLI provenance guard 改为 opt-in；规范化重跑会执行并报告 `rerunOf`（该概念与告知已在 0.6.0 删除），而不是被阻止；增加对象形式的有界 recall、cursor 与 source binding、可重放性 provenance、有界 fold navigation 和 stub、确定性 run state、宿主注入的 `todoStateProvider`/`semanticStateProvider` 以及 forced-final 处理。
- **v0.4.0 (2026-09-14)**：（历史）增加 run-scoped notes skill、工具输出 archive 和 provenance capture；archive/capture 机制已在 0.6.0 退役。Notes 使用 `current` 加最多三个 `superseded` 值以及可见的 `folded` 计数；旧 notes ledger、version chain 和相关环境变量已移除。Provenance guard 比较 capture manifest，而不是信任 notes。
- **v0.3.5 (2026-09-12)**：大范围兼容性与持久化修复批次，包括实时流式回调、工具执行后 checkpoint 持久化失败时 fail-closed、完整 pending-tool resume、provider SSE 和 legacy `function_call` 兼容、更安全的 file-store ID、REPL 持久化、MCP 清理、输入校验和 `onObserverError`。
- **v0.3.4 (2026-09-07)**：修正多轮宿主的任务 brief 选择。显式 `task` 和 `context.task` 优先级最高，其次是入口 transcript 的最后一条 user message；resume 不再使用不可信的历史 task seed。
- **v0.3.3 (2026-09-06)**：`wrapup: false` 同时禁用整个 wrap-up 指令/解析/替换/规范化协议，并加强顶层 `done` 校验。
- **v0.3.2 (2026-09-06)**：MIT 许可和 README 重构；无运行时功能变化。
- **v0.3.0 (2026-09-06)**：judge 治理可用：透明工具拦截、round judge、方向提示、stall 修正以及 `onJudge` / `--judge-log` 可观测性。省略时，`maxRounds >= 16` 的库默认启用 reflection。
- **v0.2.0 (2026-09-01)**：双协议流式、完整工具循环、自动按预算折叠、file store 与 recall、JSON-file 配置、交互式 CLI、持久化、自描述 skill、内置 CLI 工具、流式输出和 MCP stdio/HTTP 集成，以及 idle timeout。

项目所描述的宿主迁移和 benchmark 工作仍在进行中，不能据此承诺未来的宿主或 sandbox 组件已经包含在本包中。

## 发布验证

仓库的发布流程在 `LLM_KIT_E2E=1` 时使用真实 relay E2E 测试：

```bash
LLM_KIT_E2E=1 node --test examples/*.test.mjs
```

测试需要已配置的模型。模型按 `slots.default.model`、`LLM_KIT_MODEL` 或 `ERIX_DEFAULT_MODEL` 的顺序解析；缺少配置时会失败，而不是静默选择其他模型。发布记录应标明实际使用的模型。

Notes 实验脚本同样按 `--model`、`ERIX_EXPERIMENT_MODEL` 或 `--config`/`~/.erix/config.json` 的顺序获取模型。它们提供成本预览；不带 `--yes` 时默认为 dry-run；默认 `--max-calls 40`；模型调用失败后立即停止，而不是切换模型。

## 基准验证（erix-bench / Terminal-Bench archive）

项目使用容器驱动和官方 grader，报告 Terminal-Bench archive 任务的无头 harness 结果，并比较 `--agent erix|pi`。完整的逐次运行报告维护在配套的 erix-bench 仓库中；下面的数字是 README 记录的结果，并不表示本仓库会自动运行这些任务。

### 通过任务（reward=1，按模型）

`historical-model` 在广泛的任务集中有 **34 个通过任务**：

```text
bn-fit-modify
break-filter-js-from-html
build-cython-ext
build-pmars
cancel-async-tasks
cobol-modernization
configure-git-webserver
constraints-scheduling
count-dataset-tokens
crack-7z-hash
custom-memory-heap-crash
extract-elf
financial-document-processor
fix-git
git-leak-recovery
git-multibranch
hf-model-inference
kv-store-grpc
log-summary-date-ranges
merge-diff-arc-agi-task
modernize-scientific-stack
mteb-retrieve
multi-source-data-merger
openssl-selfsigned-cert
polyglot-c-py
portfolio-optimization
prove-plus-comm
pypi-server
regex-log
reshard-c4-data
sam-cell-seg
sqlite-db-truncate
torch-tensor-parallelism
vulnerable-secret
```

`historical-model-2` 在较新的困难任务样本中有 **11 个通过任务**：

```text
adaptive-rejection-sampler
break-filter-js-from-html
build-cython-ext
build-pov-ray
cancel-async-tasks
chess-best-move
code-from-image
configure-git-webserver
db-wal-recovery
fix-code-vulnerability
password-recovery
```

`historical-model-2` 样本中的 `pi` 对照有 **4 个通过任务**：

```text
break-filter-js-from-html
build-cython-ext
build-pov-ray
distribution-search
```

两个 `historical-model` 总数不可直接比较：前者运行次数更多、任务组合更广；后者更强调困难任务和恢复任务。

### 透明拦截与 judge 证据

记录于 2026-09 的 `erix main + PR #28/#29` 证据描述了在透明拦截、round judge、stall 修正和方向提示下运行的长期无头任务。Judge 决策写入 `erix-state/judge.log` 供审计：

| 任务 | 结果 | 报告的 judge 证据 |
|---|---|---|
| db-wal-recovery | reward=1 (88s；历史失败 721s) | `direction: off_track` 拦截将仅侦察路线转向修复 |
| adaptive-rejection-sampler | reward=1（12 轮；历史超时 901s） | 早期 judge 拦截阻止环境空转 |
| password-recovery | reward=1（187s，flash 首次运行） | **5 次 blocked** 决策阻止在没有完整密码时反复进行不完整提交 |
| fix-code-vulnerability | reward=1（123s，grader 6/6） | round judge 只在正向完成评估后允许 wrap-up |
| cancel-async-tasks | reward=1（117s） | Judge logging 和透明放行观察到一条正确路线 |
| circuit-fibsqrt | reward=0（64 个完整轮次） | 11 条真实拦截记录；报告将失败归因于模型能力，而非该机制 |

这些 benchmark 数字是项目历史证据，不是 API 保证。Judge 设计决策记录在 [ADR-011](docs/decisions/011-judge-direction_cn.md)。

## 许可证

MIT © 2026 ErixWong（见 [LICENSE](LICENSE)）。
