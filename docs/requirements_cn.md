# 需求文档 — erix-agent

> English version: [requirements.md](requirements.md)

本文档初稿于 2026-08-29，现已与 0.5.1 版本交付的实现完成对照。它描述的是库的实际范围与 API，而不是未经限定的未来计划清单。

## 1. 消费方背景与痛点

### app_container（`apps/worker/src/pi/` + `packages/context`）

- 已有能力：双协议归一化（OpenAI/Anthropic → 统一的 `tool_use`/`tool_result` 块）、基于签名窗口比对的停滞检测、固定十轮硬窗口、`max_tokens` 续写，以及 idea 对话的骨架折叠（`chat_summary_json` 加 `foldedUpTo` 水位线）。
- 痛点：（1）硬窗口会静默丢弃早期轮次，因此一个 24 轮的开发任务可能丢失一半历史，模型可能重复已完成的工作；（2）provider 错误会使整个任务失败，导致 reaper 从头开始，浪费已经支付的 LLM 调用；（3）`pi_models.context_window_tokens` 已存储，却没有接入循环（`llm-context-budget.md` §7，“本周期不改”）；（4）骨架折叠输出没有确定性的大小约束，依赖 LLM 遵守预算，而不是将最终大小保持为代码不变量。

### touwaka（`lib/agent/` + `lib/context-organizer/`）

- 已有能力：基于预算的整组折叠与统计摘要（`history-compactor`、R19-1）、轮内快照重试（`round-state-snapshot`）、完成信号检测（R15）、相邻 assistant 合并（R16-3）、孤儿消息保护，以及面向对话负载的 Psyche 反思系统。
- 痛点：两套实现相互重复，却各自独立演进；压缩与重试方面的经验没有回流到共享运行时。

## 2. 目标与非目标

### 目标

1. 提供 OpenAI 兼容（`chat/completions`）和 Anthropic（`messages`）适配器，支持流式与非流式调用、统一的规范内部块格式，以及通用错误分类。
2. 提供 `runToolLoop` 单任务生命周期：注入工具与执行器、`maxRounds`、可选的轮内 provider 重试、停滞检测、完成与无工具策略、`max_tokens` 续写、检查点/恢复、可选的反思/裁决治理，以及可观测事件。
3. 提供可插拔的上下文预算压缩：`sliding-window`、`fold-statistical` 和 `fold-llm`，并支持归档折叠载荷与有界回忆。
4. 让配置与持久化处于适配器契约之后。包内包含 static、environment、JSON-file、memory 和 JSONL-file 实现；数据库适配器仍保留在消费方项目中。
5. 保持零运行时依赖、纯 ESM、兼容 Node 22+，并可使用 `node --test` 测试。

库的边界止于单个 agent 任务的生命周期：启动、运行、停止、恢复，以及为该任务发出事件。多 agent 编排、裁决、任务队列和跨任务重试调度由宿主负责，并有意排除在本包之外。

### 非目标（永远不做）

- ❌ 不要让工具执行在核心循环中成为强制或隐式行为。宿主提供 `tools` 和 `executeTool`；可选的 `erix-agent/tools` 子路径包含参考助手和参考执行器，但宿主必须显式接入并治理它们。
- ❌ 不要把库运行时变成 agent 人格、skills、会话管理、TUI 或 MCP 框架。这些属于 CLI 或宿主职责，不属于 `src/` 运行时契约。
- ❌ 不要提供安全策略或安全边界（白名单、密钥脱敏策略、产物闸门或宿主隔离）。安全仍由宿主/运行环境负责。
- ❌ 不要选择数据库引擎，也不要拥有消费方项目的数据库 schema。消费方在自己的侧实现适配器契约。
- ❌ 不要成为“mini pi”。需要完整交互式 agent 的消费方应直接使用 pi 本身或其 SDK，而不是把本包继续扩展成一个完整 agent。
- ❌ 不要在 0.5.1 运行时交付计划中的 `psyche` 压缩策略。它的上下文塑形理念仍是面向对话、属于未来的设计候选，不是当前实现。

## 3. 功能需求

### FR-1 Provider 适配器

| # | 需求 | 状态与实现 |
|---|---|---|
| FR-1.1 | OpenAI 兼容（`chat/completions`）和 Anthropic（`messages`）协议，均支持流式与非流式 | **已交付。** `createOpenAIProvider` 和 `createAnthropicProvider` 暴露 `chat` 与 `chatStream`。 |
| FR-1.2 | 将两种协议归一为一种内部块格式（`text` / `tool_use` / `tool_result`） | **已交付。** `src/messages/canonical.js` 和 `src/messages/anthropic.js` 还会在需要时保留 `raw`、图片和 reasoning 块。 |
| FR-1.3 | 通用错误类别：`timeout` / `rate_limited` / `auth` / `network` / `server`，并带有可重试标记 | **已交付。** `src/providers/errors.js` 提供 `KitError`、HTTP 分类、fetch 异常分类和 `retryable`；它还暴露显式的 `aborted`、`provider_config`、`invalid_messages` 及相关不可重试错误。 |
| FR-1.4 | 对于包含错误正文的 HTTP 2xx 响应，保留真实上游消息，而不是报告误导性的 missing-choice 错误 | **已交付。** 两个 provider 都会检查成功响应正文中的 provider 错误并保留上游消息；缺少 `choices` 的 OpenAI 响应会包含有界的响应预览。 |
| FR-1.5 | 将模型元数据（`contextWindowTokens` / `maxOutputTokens`）传入循环，使其能够推导压缩预算 | **已交付，并带有明确的输入契约。** Provider 工厂会返回这些元数据字段，`runToolLoop` 可从 `modelConfig`、`modelMetadata`、`model`、`provider` 或 `context` 接收它们，并在两个值都可用时调用 `computeBudget`。任一值缺失时都不会推断预算。 |

### FR-2 工具循环（`runToolLoop`）

| # | 需求 | 状态与实现 |
|---|---|---|
| FR-2.1 | 宿主注入带标准 JSON Schema 定义的 `tools`，以及 `executeTool(name, input)` 回调；库不拥有执行策略 | **已交付。** `runToolLoop` 将 schema 传给 provider，并接受位置参数回调或结构化的 `{ id, name, input, context, signal }` 形式。 |
| FR-2.2 | 从轮内快照重试可重试的 provider 失败，默认重试两次，并以 1.5s 起步、上限 10s 的指数退避；重试耗尽后抛出 | **已交付，但为可选而非默认。** 使用 `retry: {}` 时，`runToolLoop` 默认重试两次、基础延迟为 1.5s、上限为 10s，恢复轮内快照，并仅重试标记为 `retryable` 的错误。默认值为 `retry: false`；工具执行本身不会自动重试。 |
| FR-2.3 | 通过滑动窗口比较工具签名检测停滞，先 nudge，只有在重复超限后才以 `termination.reason="stall"` 正常停止 | **已交付。** `stallDetection` 默认为四签名窗口，支持 `appear` 和 `consecutive` 模式，早期命中时发送 nudge，并在停滞连续命中达到三次上限后停止。 |
| FR-2.4 | 应用完成信号与无工具轮策略：有工具历史后，将没有完成信号的响应视为过渡文本并继续；默认连续三轮无工具后强制终止；合并相邻 assistant 消息以避免 400 | **已交付，并提供显式开关。** `completion` 默认为 `{ signals: [], maxNoToolRounds: 3 }`；收尾 JSON 协议支持 `done: false` 继续和 `done: true` 完成，`normalizeMessages` 会合并相邻 assistant 消息。`completion: false` 会为对话式宿主禁用无工具策略。 |
| FR-2.5 | 继续被 `max_tokens` 截断的响应 | **已交付，并带有上限。** 循环最多继续 `maxTokenContinuations` 次（默认 `3`），达到上限后报告 `termination.reason="continuation_exhausted"`。 |
| FR-2.6 | 每次 LLM 调用前执行压缩检查，并将压缩事件纳入返回的统计信息 | **在配置预算或策略时已交付。** 循环会在每轮请求前检查，并在请求超出预算时于续写前再次检查；返回的 `compactionStats` 包含压缩结果和 token 数量。 |

### FR-3 上下文压缩

| # | 需求 | 状态与实现 |
|---|---|---|
| FR-3.1 | `budget = contextWindowTokens − maxOutputTokens − max(2000, 10% of the window)` | **已交付。** `computeBudget` 实现该公式，并拒绝无效或非正预算。 |
| FR-3.2 | 按每个 CJK 字符 1.5 tokens、每个非 CJK token 3.5 个字符估算 token，再加 15% 余量；保持保守，并使系数可配置 | **已交付，并增加了额外计费。** `estimateTokens` 使用这些默认值和可配置系数，消息估算还会在适用时加入每条消息开销以及图片、reasoning、raw-block、工具名和工具输入成本。 |
| FR-3.3 | 折叠整组：一轮是一个 assistant 消息及其紧随的工具结果消息，遵循各协议的配对规则；永不折叠 system header 或首个 user 消息 | **由压缩策略交付。** `validateMessages` 和 `groupIntoRounds` 强制相邻工具配对，策略会保留头部直到首个真实 user 消息。`protectedMessage` 可以增加保护。如果必须执行最后一道安全截断才能满足预算，受保护消息可能被降级，或者单条超预算的受保护消息可能以 `invalid_budget` 失败；这并不无条件保证每个回退视图都能保留头部。 |
| FR-3.4 | 提供策略演进 `sliding-window` → `fold-statistical` → `fold-llm`（可选 summarizer）；将 Psyche 定义为独立的、面向对话的上下文塑形理念，而不是第四种已交付策略 | **部分交付，并已明确拆分。** `createSlidingWindowStrategy`、`createFoldStatisticalStrategy` 和 `createFoldLlmStrategy` 已交付。`src/` 中不存在 `psyche` 策略；`src/reflection/` 是独立的 judge/governor/wrap-up/L0 治理层，而非压缩策略。 |
| FR-3.5 | 通过在代码中修剪字段，而不是信任 LLM，强制限制 LLM 生成摘要的确定性大小 | **`fold-llm` 已交付；不适用于未交付的 Psyche 策略。** `src/compact/enforce-size.js` 应用字段优先级，`src/compact/fold-llm.js` 通过确定性回退截断强制执行 `maxSummaryTokens`。`fold-statistical` 是确定性的，不依赖 LLM 摘要。 |
| FR-3.6 | 跟踪 `foldedUpTo` 水位线；将折叠轮次持久化到 `TranscriptStore`；允许 recall 取回它们，以实现近无损折叠 | **已交付，但使用不同的 API；旧字段名未交付。** `runToolLoop` 跟踪内部的 `foldedThrough` 值，而记录暴露 `foldedRoundRange` 和 `foldedPayload`。memory 和 file store 会持久化折叠载荷，其 legacy recall 和有界对象 recall 都能读取当前消息及折叠载荷。 |

### FR-4 配置与持久化适配器

| # | 需求 | 状态与实现 |
|---|---|---|
| FR-4.1 | `ModelConfigProvider` 契约，提供 static、environment 和 JSON-file 实现；`apiKey` 可间接引用环境变量或文件 | **已交付，但实现为 duck-typed 的 `resolve(slot)` 契约，而非类或正式接口。** `createStaticModelConfigProvider`、`createEnvModelConfigProvider` 和 `createJsonFileModelConfigProvider` 已实现；`resolveApiKey` 支持直接值、`apiKeyEnv` 和 `apiKeyFile`。 |
| FR-4.2 | `TranscriptStore` 契约，提供 memory 和 JSONL-file 实现，包括崩溃恢复 | **已交付。** `createMemoryTranscriptStore` 和 `createFileTranscriptStore` 实现 append/load/recall 以及运行状态和检查点方法。file store 会修复或隔离损坏的末尾 JSONL 片段，`runToolLoop({ store, runId, resume: true })` 会恢复 transcript 和待处理的检查点工作。恰好一次的副作用仍由宿主负责。 |

### FR-5 工具体系

| # | 需求 | 状态与实现 |
|---|---|---|
| FR-5.1 | 定义标准工具 schema；由适配器负责协议序列化；执行保留在宿主 | **已交付。** `ToolSchema` 使用 `inputSchema`；`canonicalToolsToOpenAI` 和 `canonicalToAnthropicRequest` 分别为各 provider 序列化它，而 `executeTool` 仍是循环注入的执行边界。 |
| FR-5.2 | 提供可选的 `erix-agent/tools` 子路径，其中包含 recall、工具注册表和工具 provider | **已交付。** `package.json` 将 `./tools` 导出到 `src/tools/index.js`，后者导出 `createRecallTool`、工具注册表和工具 provider。这些功能均为可选，不会自动安装为循环工具；不再包含路径牢笼或文件工具助手。 |
| FR-5.3 | 让工具定义可插拔（`static` / `json-file` / `composite`，DB 在消费方项目中）；让执行器注册表归代码所有，并在不匹配时 fail closed | **已交付。** `src/tools/providers.js` 实现三个 provider，`src/tools/registry.js` 将执行器保存在代码所有的 map 中，校验输入，合并 provider schema 覆盖项，并在 provider 指定不可用执行器时抛出 `tool_unknown_executor`。未包含 DB provider。 |

## 4. 分期与实现状态

下面将原始分期计划与 package 版本 0.5.1 中已有的内容对齐。“已交付”描述仓库代码；消费方迁移和真实 provider 基准运行仍属于外部验收工作。

| 版本 | 范围 | 验收/状态 |
|---|---|---|
| **v0.0 — 已交付** | MVP 垂直切片：OpenAI 非流式 provider、规范消息、token 估算、最小 `runToolLoop`（`maxRounds`、`executeTool`、停滞检测）、memory store，以及由 demo 负责执行的 `examples/exec-demo.js` | 仓库包含 mock-fetch 测试套件和 exec demo。针对本地 relay 的真实 LLM 运行属于外部检查，不由本文档断言。 |
| **v0.1 — 已交付** | 完整 provider 层（Anthropic 加流式）、`src/messages/`、tokens、FR-1/2 所代表的循环能力、`sliding-window`、`fold-statistical`、memory store，以及 static/environment 配置 | 库的表面能力已存在，并由仓库测试覆盖。完整的 `app_container` 迁移和 24 轮行为对比属于消费方验收标准，并非此处已验证的交付事实。 |
| **v0.2 — 已交付** | JSONL file store、recall、JSON-file 配置、注入 summarizer 的 `fold-llm`，以及可选的 `erix-agent/tools` 导出：jail、参考文件工具、recall、registry 和 tool providers | store 和循环已实现崩溃修复/恢复与折叠载荷 recall。宿主仍自行决定是否使用参考工具。 |
| **v0.3.x–v0.4.x — 已交付** | 检查点/恢复强化，以及 `src/reflection/` 中的可选反思层：governor 决策、L0 facts、收尾解析/归一化、轮次 judge、透明工具拦截、方向提示和 `finalGuard`/验证钩子 | 循环通过 `reflection`、`onJudge`、`finalGuard` 以及返回的终止/验证数据暴露这些行为。当 `maxRounds >= 16` 时，反思会自动启用，除非显式禁用。 |
| **v0.5.0–v0.5.1 — 当前** | `src/store/bounded-recall.js` 中带 `limit` / `cursor` / `maxBytes` / `artifactRef` 的有界 recall；`src/run-state.js` 中确定性有界运行状态；折叠导航记录和 stub；可安全恢复的状态持久化；以及 `./tools` package 导出 | `package.json` 报告版本 `0.5.1`，并导出 `.`, `./tools` 和 `./contract-tests`。运行状态持久化对不可用或过期状态有界且明确；有界 recall 受来源和 cursor 约束。 |
| **v1.0 候选 — 未交付** | touwaka 迁移，初步仅限 token 工具和 history compactor，完整 `AgentLoop` 迁移留作单独决策 | 本仓库的 0.5.1 实现不包含 touwaka 迁移。消费方回归和行为检查必须由宿主项目运行。 |
| **v2 候选 — 延后** | 面向上下文塑形理念的冷循环蒸馏加 L3 fact 注入，以及未来 provider 层重新评估认为合理时的原生 Gemini 支持 | 0.5.1 的 `src/` 中没有 `psyche` 或 Gemini-native provider。这仍是单独划定范围的工作。 |

## 5. 非功能需求

- `examples/` 是一等集成界面。仓库当前包含 exec demo、memory benchmark 和 provenance reproduction 覆盖；未来消费方应能够按照可运行示例操作，而缺少某个里程碑专属的对话或审计 demo 不能被当作已实现能力。参考 demo 将执行保留在消费方一侧。
- 存储演进顺序是先 memory，再 JSONL file，使完整生命周期只依赖文件系统即可运行。未交付 MariaDB 或其他数据库适配器；消费方项目根据自身 schema 和基础设施实现 `TranscriptStore` 与 `ModelConfigProvider`。
- 没有运行时依赖、没有构建步骤，除了内置的 `node --test` runner 外也不要求开发依赖。
- 仓库文件不得包含 key 或 token。配置适配器将 `apiKeyEnv` 和 `apiKeyFile` 间接引用视为一等机制；直接的 `apiKey` 值可以作为配置输入接受，但不得提交。
- 压缩、重试、协议适配、检查点/恢复、反思和有界 recall 行为均由 `node --test` 测试锁定，provider 测试使用 mock `fetch`。外部消费方迁移和真实 relay 行为需要各自的测试。
- 通过公开 npm package `erix-agent` 分发。

## 6. 风险

| 风险 | 缓解措施 |
|---|---|
| 抽象泄漏：规范化隐藏了协议特有功能 | provider 和消息适配器保留 `raw` 逃生舱块；provider 特有的 payload 选项仍可通过适配器层使用。 |
| Touwaka 迁移回归：其 `AgentLoop` 包含 R15/R16/R19 生产修复 | 将 touwaka 迁移排除在 0.5.1 声明之外；先迁移纯工具层，再将完整循环作为单独决策，并配合宿主侧回归测试。 |
| 单维护者项目的发布摩擦 | 使用语义化版本和 changelog；消费方锁定版本并有意升级。 |
| 消费方因即时收益抵不过集成成本而推迟迁移 | 将消费方迁移作为宿主项目的明确里程碑。0.5.1 库不只是工具包，但不能声称本仓库中不存在的迁移已经完成。 |
| 上游 API 吸收上下文编辑或服务端循环能力 | 将价值主张锚定在这些服务不可用的自托管 relay 和开放模型上；如果这一前提改变，重新评估项目边界。 |
| 压缩演进变成四级承诺，但实际只使用第一级 | 不要描述 `psyche` 已交付。只有在行为足以支持时才从 `fold-statistical` 进入 `fold-llm`；单独评估延后的上下文塑形设计，不跳过实证门槛。 |
