# erix-agent

> English version: [README.md](README.md)

**erix-agent** 是一个零依赖、纯 ESM 的无头编码 agent LLM 运行时。它提供双协议流式 provider、工具调用循环、上下文压缩、run snapshot（latest-only autosave）、恢复、note-first 取回，以及可选的 reflection/judge 层，用于无人值守工作。

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

## 快速开始

从 npm 安装（Node 22+）：

```bash
npm i erix-agent
```

最小工具循环——运行时只管理一个任务生命周期，工具和安全策略归调用方：

```js
import {
  createOpenAIProvider,
  createMemoryTranscriptStore,
  runToolLoop,
} from "erix-agent";

const provider = createOpenAIProvider({
  endpoint: "https://your-relay.example.com/v1", // 任意 OpenAI 兼容端点
  apiKey: process.env.LLM_API_KEY,
  model: "your-model",
});

const result = await runToolLoop({
  provider,
  system: "你是编码助手。先用工具检查，再回答。",
  initialUserMessage: "统计 ./src 下 JS 文件数量和总行数。",
  tools: [{
    name: "exec",
    description: "执行只读 shell 命令，返回 stdout+stderr",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  }],
  executeTool: async ({ name, input }) => {
    // 你的执行逻辑 + 安全策略（库本身不执行任何东西）
  },
  maxRounds: 16,
  store: createMemoryTranscriptStore(),
  runId: "demo-001",
});

console.log(result.finalText);            // 最终回答
console.log(result.rounds, result.usage); // 运行统计
```

或者用 CLI 驱动（读取 `~/.erix/config.json`，见[配置与本地状态](#配置与本地状态)）：

```bash
erix chat "统计这个项目的代码行数" --max-rounds 32
```

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
| 统一记录调用、支撑成本分析与事后审计 | 事件流（`onRound` / `onDelta` / `onToolCall` / `onUsage` / `onJudge` / `onEvent`）、token 计量、`TranscriptStore` 落盘、稳定 run id 和 run snapshot（latest-only autosave） | 日志与成本存储、监控看板、保留策略、审计流程 |
| 统一安全、权限与工具调用边界 | 唯一执行入口（`executeTool`）；数据无法扩张的执行器注册表；schema 求交；通过 `note_list` → `note_read` 的 note-first 取回 | 策略本身：哪个项目能用哪些 Agent、可调哪些工具、哪些操作需人工确认、是否允许联网与写操作、调用次数与时长限制 |
| 降低第三方框架升级的影响 | 零运行时依赖、自有实现；稳定导出面 + 面向消费方的 `erix-agent/contract-tests` | — |
| 沉淀统一的 Agent 能力与工程规范 | 规范消息与工具格式、ADR 决策记录、契约测试、基准 harness | — |

两条边界让这张表站得住：运行时**不执行任何策略**——只提供钩子，由宿主决定
（[ADR-009](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/009-safety-layering_cn.md)）；运行时**只负责单个任务生命周期**——
队列、仲裁与重试调度留在宿主
（[ADR-012](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/012-engine-truth-model-efficiency-host-policy_cn.md)）。

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
  assembly.js                      AssemblyPort 校验（宿主边界）
  assembly-validators.js           端口/选项校验共享实现（内部模块）
  run-state.js                     有界的确定性与语义运行状态
  tokens.js                        保守的 token 估算
  tool-fact.js                     工具事实契约面（单一构造器 + 字段归属常量）
  loop/                            # 编排核心
    orchestrator.js                runToolLoop 主循环
    option-normalization.js        runToolLoop 选项白名单、未知键建议与选项合并
    provider-runner.js             provider 调用、重试与快照回滚
    run-snapshot-executor.js       工具前后检查点与聚合闸门
    budget.js                      预算校验与状态克隆辅助函数
    aggregate-budget.js            单轮聚合输出闸门
    tool-result-ttl.js             旧工具结果的 request-view TTL 折叠
    request-user-view.js           视图定稿处不变量：发给上游/写回的视图不得没有 user 轮（issue #292）
    termination.js                 终态归类
    deliverables.js                宿主声明的交付物判据（finalGuard 之前的机器闸门）
    pending-tool-result.js         注入控制文本前结清尾部悬空 tool_use 的共享实现（issue #394）
    resume-manager.js              断点恢复与 run-state 应用
    resume-notice.js               恢复运行注入给模型的「这是复活赛」告示（issue #404）
    error-ledger.js                重复错误记账
    messages.js                    消息/block 辅助函数
    reflection.js                  反思提示与决策解析
    task-brief.js                  任务简报选取
    abort.js                       中止信号辅助函数
    block-helpers.js               block 访问辅助函数
    judge-record.js                judge 记录关联字段（模型标识、run 级 outcome 汇总）
    state-view.js                  活引用状态视图工厂（按显式字段清单生成，#246，尚未接线）
  providers/
    anthropic.js                   Anthropic provider 与流式处理
    errors.js                       provider 错误与分类
    http-shared.js                  两个 provider 共用的 HTTP 与注入 helper（header/extraBody 红线）
    openai.js                       OpenAI-compatible provider 与流式处理
    payload.js                      provider payload 与超时选项
    timeout.js                      provider 超时处理
  messages/
    anthropic.js                   Anthropic 协议转换与流组装
    canonical.js                    规范消息/工具转换
    openai-normalization.js         OpenAI-compatible 归一化原语
    tool-arguments.js               工具引数解析：先 L0 再 L1 修复，修不出来给解析器原判词（issue #409）
    rounds.js                       消息校验与轮次分组
  compact/
    budget.js                       上下文预算计算
    pipeline.js                     压缩流水线声明
    enforce-size.js                 字段大小限制
    fold-llm.js                     LLM 辅助的折叠策略
    fold-summary-journal.js         折叠摘要事实账本：指纹、复用备忘、事实回读
    fold-statistical.js             统计折叠与导航记录
    provider-summarizer.js          用本 run provider 的 fold-llm 默认 summarizer
    strategy-resolution.js          context.strategy 内置策略名解析
    anchors.js                      机械锚点抽取（路径/SHA/issue/URL/错误行）
    fold-fidelity.js                用户输入逐字引用与反向信号检测
    helpers.js                      共享的折叠、保护、stub 与 hook 辅助函数
    sliding-window.js               滑动窗口折叠策略
  store/
    file.js                         JSONL transcript、checkpoint 与状态存储
    memory.js                        进程内 transcript、checkpoint 与状态存储
    notes.js                        宿主侧 notes 存储
    notes-memory.js                 进程内 NotesStore 适配器（共用 src/store/notes-port.js）
    notes-port.js                   NotesStore 端口语义共享实现（内部模块）
    append-user-turn.js             多轮续跑契约的预写 user 轮
    message-rows.js                 读侧折叠：把 `kind:"message"` 行按轮拼回轮行（内部模块）
    transcript-dedup.js             appendRound 去重的 payload 判据（内部模块）
  config/
    api-key.js                      API key 物化
    env.js                          基于环境变量的模型配置
    json-file.js                    基于 JSON 文件的模型配置
    slot-provider.js                模型槽位 → provider 构造件：loadModelSlot / createProviderForSlot（issue #406）
    static.js                       静态模型配置
  display/
    projection.js                   宿主展示投影（RoundRecord[] 的读侧视图）
  normalization/
    parse-model-json.js             模型输出归一化：normalizeModelJson——L1 保字节修复、闸门判原始字节、可选 L2 LLM 兜底（issue #406）
  reflection/
    governor.js                     确定性的轮次治理
    judge.js                        objective timeline 与 judge prompt/response 解析
    l0.js                           objective facts 与摘要解析
    wrapup.js                       wrap-up 协议解析与规范化
  skills/
    loader.js                         技能包发现 / 校验 / 装配（issue #197）
  text/
    json-candidates.js              顶层平衡 JSON 对象扫描（wrapup 与 reflection 共用）
    parse-model-json.js             统一的「模型文本抠 JSON」入口：三态失败、无 repair（issue #307）
    repair-json.js                  L1 确定性修复规则：只动结构字符，绝不动值的字节（issue #409）
    label.js                        note/findings label 归一化
  tools/
    file-tools.js                    文件工具规范实现：readFile/searchText/rg/grep/tree/edit/writeFile
    index.js                        可选 tools 子路径导出
    notes.js                        宿主侧 notes 工具
    providers.js                    tool-provider adapter
    registry.js                     工具 schema 与 executor registry
```

`src/index.js` 导出 provider、规范消息转换、token 与压缩辅助函数、transcript store、run-state 辅助函数、宿主展示投影（`projectTranscriptForDisplay`）、多轮预写辅助函数（`appendUserTurn`）、配置 provider、`runToolLoop` 以及 reflection 辅助函数，另有模型输出归一化底座（`normalizeModelJson`，issue #406——带确定性修复与可选 LLM 兜底的**异步**入口，**不**取代同步 L0 的 `parseModelJson`）与槽位 → provider 构造件（`loadModelSlot` / `createProviderForSlot`）。可选的 `erix-agent/tools` 子路径导出工具 registry 和 provider 辅助函数、文件与 notes 的规范工厂，
以及技能包 loader（`discoverSkills` / `loadSkill` / `buildSkillTools`，issue #197——内置技能
目录由调用方以 `bundledDir` 传入，库内不按自身文件层级猜路径）；模型侧取回采用 note-first（`note_list` → `note_read`）。

## 宿主端口与错误账本

组合边界上一次性校验四个适配器端口，其余宿主边界作为显式 `runToolLoop` 选项传入：

```js
const assemblyPort = createAssemblyPort({
  modelConfig, // ModelConfigProvider: { resolve(slot) }
  provider,    // { chat?, chatStream? }
  tools: { definitions, executeTool, getToolMetadata? },
  store?,      // 可选 TranscriptStore（必需：appendRound、load；可选：run-snapshot/run-state）
  session: { id, resume?, initialMessages? },
  policy?,     // 显式 runToolLoop 选项；陌生键会被拒绝
  emit?,       // (eventType, payload) => void
});
```

`NotesStore` 是 CLI 侧引擎技能（面向 run 的事实/一次性值/artifact 引用速记本），其写契约见
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
  ".": {
    "types": "./src/index.d.ts",
    "default": "./src/index.js"
  },
  "./tools": {
    "types": "./src/tools/index.d.ts",
    "default": "./src/tools/index.js"
  },
  "./contract-tests": "./test/contract/index.js"
}
```

类型声明随包发布（issue #213）：顶层 `types` 指向 `./src/index.d.ts`，`.` 与 `./tools`
两个子路径各带一个 `types` 条件。`./contract-tests` **刻意不带** `types` 键：它的目标落在
`test/` 下，不在声明依赖图里，`prepack` 永远不为它产出声明，挂 `types` 就是清单里一句永远不成立的
话。宿主 import 该子路径拿到的是标准的「无声明模块」信号（实测 `TS7016 Could not find a declaration
file for module 'erix-agent/contract-tests'`），这是诚实的口径——而把 `types` 指向一个不存在的文件
不是（实测：`tsc` 随后静默解析到 JavaScript，一个错都不报）。

声明是生成物、不入库：`npm run types:build` 把它们写到 `src/**/*.d.ts`（`files` 白名单里
本来就有 `src`，因此不用改白名单），`prepack` 钩子在 `npm pack` / `npm publish` 之前跑同一个
生成器——消费者从 registry 安装时不跑，这正是「tarball 里有声明而仓库里没有」的原因——而
`npm run check:types-build` 断言仍能生成、且产物里含 `runToolLoop` / `createFileTools`，
跑完把生成物删掉以保持工作树干净。

发布包本身由一条命令验收（issue #257 T5）：`npm run check:release` 先打包并断言 tarball 的形状（声明文件在、
当前版本的中英两份升级指南都在、随包的 `test/contract/` 文件一个不少、`files` 白名单之外没有杂物——Markdown
链接闭合仍归 `npm run check:pack-links`，不在这里重写），再把这份 tarball 装进一个一次性临时项目，用**装好的包**
跑随包契约套件，用 `tsc --strict --skipLibCheck` 编译一个真 TypeScript 宿主（退 0，且未知的 `runToolLoop` option
键必须被 `TS2353` 拒掉——这就是「类型面不是 `any`」的证据）并把编译产物真跑一遍，最后拿本地假上游冒烟装好的
命令行。它全程离线（一次性 npm cache 与 userconfig、假 `HOME`）、跑完把临时目录和生成的声明一并清掉，红的时候点名第几步。

真上游那一半也是一条命令（工单 261021-13）：`npm run check:release:real` 按顺序跑四条同闸门的真 e2e 套件
（`examples/tool-fact-e2e.test.mjs`、`examples/resume-real-e2e.test.mjs`、
`examples/cross-version-real-e2e.test.mjs`、`examples/pi-extension/erix-run-e2e.test.mjs`），
再跑 `npm run check:cli-real`；每条单独 900 秒硬超时，跑完整张清单才判红并点名是哪几条。
不带 `ERIX_E2E_REAL=1` 时它一步都不跑、exit 0 并打分类原因，因此永远不会变成默认门禁的硬依赖——
但闸门开着而配置不可用是**错误**，不是跳过。它和文档审计（`npm run check:docs` /
`npm run check:docs:strict`）都是每次发布前**必跑**的。

## 工程约束

- 零运行时 npm 依赖、纯 ESM、Node 22+，发布的 JavaScript 没有构建步骤。本仓库唯一的 npm
  依赖是**仅 dev** 的工具链（`typescript` + `@types/node`，issue #213）：它们只为生成随包发布
  的 `.d.ts` 声明而存在，`src/` 与 `bin/` 从不 import 它们（那里只允许 `node:` 内置与相对路径）。
- 测试使用 `node --test`；类型信息通过 JSDoc typedef 表达。
- 文档事实受机器校验，陈旧的 README 不可能静默过线：`npm run check:docs` 将版本声明、
  引用的 `files`/`exports` 清单、模块地图、文中路径与命令，以及关键默认值白名单逐个比对
  `package.json` 与源码，并对齐本文与 [README.md](README.md) 的标题骨架；
  `npm run check:docs-examples` 真实执行契约里的 js 围栏；`npm run check:pack-links` 检查随包
  Markdown 的链接闭合；`npm run check:types-build` 断言随包声明仍能从源码生成，跑完把生成物清掉。
- 包以 `erix-agent` 发布到 npm，代码托管于 GitHub 的 `ErixWong/erix-agent`。
- 永远不要提交 token、API key 或其他凭据。

权威的版本口径是 [`package.json`](package.json) 的 `version` 字段（`npm run check:docs` 会校验本文的
发布行）。当前发布版本：**v0.24.0**。下面引用的 `files` 清单以 `package.json` 为权威：

```json
[
  "src",
  "bin",
  "skills",
  "README.md",
  "README_cn.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/host-consumer-contract.md",
  "docs/host-consumer-contract_cn.md",
  "docs/host-upgrade-guide-0.6.0.md",
  "docs/host-upgrade-guide-0.12.0.md",
  "docs/host-upgrade-guide-0.14.0.md",
  "docs/host-upgrade-guide-0.15.0.md",
  "docs/host-upgrade-guide-0.16.0.md",
  "docs/host-upgrade-guide-0.17.0.md",
  "docs/host-upgrade-guide-0.18.0.md",
  "docs/host-upgrade-guide-0.18.0_cn.md",
  "docs/host-upgrade-guide-0.19.0.md",
  "docs/host-upgrade-guide-0.19.0_cn.md",
  "docs/host-upgrade-guide-0.20.0.md",
  "docs/host-upgrade-guide-0.20.0_cn.md",
  "docs/host-upgrade-guide-0.21.0.md",
  "docs/host-upgrade-guide-0.21.0_cn.md",
  "docs/host-upgrade-guide-0.22.0.md",
  "docs/host-upgrade-guide-0.22.0_cn.md",
  "docs/host-upgrade-guide-0.23.0.md",
  "docs/host-upgrade-guide-0.23.0_cn.md",
  "docs/host-upgrade-guide-0.24.0.md",
  "docs/host-upgrade-guide-0.24.0_cn.md",
  "test/contract/assembly-port.js",
  "test/contract/engine-api.js",
  "test/contract/execute-tool.js",
  "test/contract/file-tools.js",
  "test/contract/index.js",
  "test/contract/model-config-provider.js",
  "test/contract/notes-store.js",
  "test/contract/skills-loader.js",
  "test/contract/termination-payload.js",
  "test/contract/tool-result-envelope.js",
  "test/contract/transcript-store.js",
  "test/helpers/tmp.js"
]
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
- 存在但没有文本、工具调用或 reasoning block 的 assistant 消息会被标记为可重试。CLI 读取 `ERIX_RETRY_ATTEMPTS`（默认 `2`）使用该重试策略。
- 库中的 `maxRounds` 默认为 `8`。CLI 提供自己的命令级默认值。
- `maxTokenContinuations` 默认为 `3`。以 `max_tokens` 结束的响应最多可以继续指定次数；耗尽后产生 `termination.reason === "continuation_exhausted"`。
- `stallDetection` 默认为 `{ window: 4, mode: "consecutive" }`：整个四签名窗口都必须是同一签名，因此合法地重读同一个文件不再被判为 stall。传入 `{ mode: "appear" }` 会检测窗口内任意位置重复的工具签名；传入 `stallDetection: false` 可禁用检测（同时使 `termination.reason === "stall"` 不可达）。`ERIX_STALL_MODE` 会覆盖 mode，除非该选项显式为 `false`；传入对象但未写 `mode` 时仍回落为 `appear`（只有引擎默认值才是 `consecutive`）。
- `resume` 默认为 `false`。配合 `store` 和 `runId` 时，`resume: true` 会恢复 transcript、运行状态、最新 run snapshot，以及所有仍需执行的待处理工具调用。若 store 同时提供快照 writer（`saveRunSnapshot`；仅实现旧名的 store 仍被接受，fallback 链 `saveRunSnapshot` → `saveCheckpoint` → `appendCheckpoint`）与 loader（`loadLatestRunSnapshot`，或 deprecated 的 `loadLatestCheckpoint`），则在执行前或执行后 snapshot 无法持久化时会 fail closed。快照/run-state 方法为可选 capability：缺失时引擎对每个缺失方法只发一条 `persistence_capability_degraded` 事件（`{type, runId, method, detail}`，run 正常跑完，仅不支持中途 crash resume）。宿主的 `executeTool` 仍必须按 tool id 保证幂等；循环无法保证外部副作用 exactly-once。

正常终止词汇为：

```text
end_turn
no_tool
stall
max_rounds_cap
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
judgeDoneAdvisory
judgeFailureLimit
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
- `judgeIntervalRound` 为 `10`；完成这么多次真实工具执行后，下一次工具调用会在执行前独立审计。
- `judgeInterceptTimeoutMs` 为 `30000`；拦截超时或 judge 失败时，会降级为执行原始工具。
- `judgeDoneAdvisory` 默认为 `false`。开启后，透明拦截审计若判定 `done: true` 且
  `confidence >= 0.7`（同一个共享常量 `JUDGE_DONE_CONFIDENCE_THRESHOLD`，见 `src/loop/reflection.js`），
  会把这条评审意见同时回灌给**主模型**：一条合成的 `user` 文本消息，带
  `meta.source: "judge-control"`——主模型看得见，judge 自己读不回（`src/reflection/judge.js` 的
  `renderConversation` 按该 marker 排除）。它是**意见而非裁决**：绝不拦写工具、绝不提前终止
  （主体完成但还有扫尾工作是合法状态）、不进 `tool_result`；投递面是**单槽**——同一轮第二次「达成」
  覆盖前一条，而不是排队。`reason` 截断到 200 字符、整条 advisory 截断到 400 字符。同一个子键还同时
  门控 `uncertain` 的**中性**方向提示文案（`src/loop/reflection.js` 的 `directionHintText`）：关闭时
  `uncertain` 仍然一条方向提示都不产、请求序列与没开本选项时**逐字相同**；开启时才改用中性文案
  （不再把「方向未定」说成「当前路线可能偏，可考虑换思路」）。非布尔值会在启动期抛
  `TypeError: reflection.judgeDoneAdvisory must be a boolean`。待投递的 advisory 不进 run snapshot，
  因此首次 flush 之前 resume 会丢掉它（已知毛刺）。
- 当进入 `nearLimit`（`budgetRounds >= floor(effectiveMaxRounds * 0.8)`）时，
  end-turn judge 和下一次工具拦截审计都会收到当前预算与扩轮次数。Judge 还必须返回
  `extend`、`extendReason` 和 `plan`；允许 `extend: true` 会增加有效预算，
  `extend: false` 会提示模型尽快收敛。
- `extensionStep` 默认为 `max(8, maxRounds * 0.5)`，`maxExtensions` 默认为 `2`，`maxRoundsCap` 至少为初始 `maxRounds`，否则为 `256`。
- round judge 只有在 `done: true` 且 `confidence >= 0.7` 时才能停止。`done: false` 决策会注入 continuation/nudge；
  nearLimit 时 `extend: true` 可以扩轮，`direction: "off_track"` 会把 continuation
  变为换思路指令。
- wrap-up LLM 规范化默认关闭；启用 `wrapupNormalize: true` 或 `ERIX_WRAPUP_NORMALIZE=1`。

Judge 拦截使用 6,000 token 的会话预算；round judge 最多输出 1,024 token，
并设置 `reasoning_effort: "none"`，原始 judge 输出写入 `judge.log`。
最终预算轮次强制发送不带工具的请求。

`onJudge` 接收轮次和拦截决策，包括 `judge_done`、`nudge`、`continue`、`executed`、`blocked` 和 `degraded` 操作。每条记录额外带 `runId`，以及被评决策发生时 run **实际使用**的 `model`（judge 走另一个 evaluator 模型时再带 `judgeModel`）；从 run 选项 / provider 配置里探不到的值一律**缺省**，不写占位值。到终局时，循环在 `onEvent` 上追加一条 additive 的 `run_outcome` 事件（`{type, runId, model, rounds, judgeRecordCount, termination, verification}`），而不是回头改写已流出的决策记录；`chat` 会把这条汇总追写到同一份 `judge.log`——因此 per-model 的 judge 指标（blocked 率 / 误拦率 / extend ROI）只是一次 `runId` join，不再是人工考古。字段形状与 additive-only 的稳定性承诺写在 `docs/host-consumer-contract_cn.md`。循环不会把 judge 当作宿主级完成证书；宿主仍需决定是否消费结果。

### 工具、上下文、存储与压缩

- `executeTool` 只接收结构化对象 `({ id, name, input, context, signal })`。三种规范返回形态是 `string`、`{ content, metadata?, success? }` 和 `Error`；旧的 `{ data, success, ... }` 及其他 duck-typed 形状仍会宽容归一化，但已弃用，不应依赖。
- `context` 可选，默认为 `undefined`；提供时接受 `strategy`、`budgetTokens`、`keepRounds`、`toolContext` 和 `task`。`strategy` 可以是策略对象，也可以是内置策略名 `"sliding-window" | "fold-statistical" | "fold-llm"`（issue #167）：未知名字或其他类型会在 run 启动期抛 `TypeError`；`fold-llm` 名字形态下引擎会用**本 run 的主力 provider**做摘要（每次压缩多一次无工具补全，usage 已计入 `result.usage` 并通过 `onUsage` 暴露）。没有 `budgetTokens` 时，循环会从 `modelConfig`、`modelMetadata`、`model`、`provider` 或 `context` 中的 `contextWindowTokens` 和 `maxOutputTokens` 推导。策略启用时，压缩默认保留六轮。任务 brief 的优先级依次为：显式 `task`、`context.task`，然后是入口 transcript 中最后一条 user message。
- 压缩支持 `summaryRole`、`recoveryHint`、`protectedMessage`、`stripHistoricalImages`、`onBeforeFold`、`onAfterFold` 和 `stubFor`。如果 protected set 本身无法放入预算，protected messages 可能降级；结果会记录 `compactionStats[].protectedDowngraded`。单个无法放入预算的 protected message 会产生 `invalid_budget`。
- `stubFor(message)` hook 可以为折叠后的工具结果保留有界、非秘密 stub（**全部** tool_result，不再有可重放性标记子集——ADR-016）。CLI 的 stub 限制为 200 个字符，最多包含三个安全的 `label=value` fact。折叠导航记录是形如 `{ roundFrom, roundTo, artifacts: [{ id, locator, digest, status }] }` 的仅地址记录，最多 10 个 artifact、400 个字符。它们不是语义搜索，也不是 provenance 证明。
- tool-result TTL 折叠独立于上下文压缩，只改变 provider request view；checkpoint 保留完整工具结果文本。`toolResultTtl` 默认为 `2` 轮（`0` 表示禁用），`toolResultFoldMinTokens` 默认为估算的 `4000` token。`age === ttl - 1` 的 warning round 会要求模型使用 `note_take`；折叠占位符包含 navigation digest，并在适用的 JSON 中包含 JSON skeleton。`note_*`、todo、错误和显式保护的结果不会折叠。
- `writeToolNames` 默认为 `["writeFile", "edit"]`（`edit` 于 0.18.0 进入默认集，issue #191——judge 看不见的 `edit` 就是一次被静默漏掉的写入）；自定义写工具仍必须显式命名。`writeToolPathKeys` 默认为 `["path", "file_path"]`。judge 的 `filesWritten` 足迹不会根据工具名称推断任意写工具。
- `TranscriptStore` 实现提供幂等的 `appendRound` 与 `load`（两个必需方法），以及可选的 run-snapshot（`saveRunSnapshot`/`loadLatestRunSnapshot`）与 run-state（`markRunState`、`saveRunState`/`loadRunState`）capability——分级详见 `docs/host-consumer-contract.md`。传入 `persistence: "none"` 可显式禁用所有写入。模型侧取回采用 note-first：先用 `note_list`，再用 `note_read`；transcript recall API 已在 0.8.0 退役。
- `runState` 是确定性的、有界的，并在压缩点以替换方式注入。store 可以实现 `markRunState`、`saveRunState`/`loadRunState`、`saveRunSnapshot` 和 `loadLatestRunSnapshot`。持久化 run state 有 64 KiB 序列化硬上限，以及条目和字段上限；裁剪通过 `bounds.truncated` 可见。`todoStateProvider` 和 `semanticStateProvider` 由宿主注入；语义状态有界且带版本，过期版本标记为 `stale`。无效或损坏的状态在 resume 时报告为 `state_unavailable`，而不是静默当作全新状态。
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

流式 observer（`onDelta`、`onReasoningDelta`、`onToolCall` 和 `onUsage`）在 observer 抛出异常时通过 `onObserverError` 报告——其余 observer 回调同样如此（issue #173，详见下文）。持久化失败使用 `onPersistenceError`。`onEvent` 接收包括 `round_start`、`round_end`、`tool_use`、`tool_result`、`attempt`、`recovering`、`recovered`、`delta`、`reasoning_delta`、`tool_call`、`usage`、`forced_final`、`final_guard` 和 `persistence_capability_degraded`（每个缺失的可选 store capability 各发一条）在内的结构化事件。

上述九个观察者回调均已做错误隔离（issue #173）：任何一个抛错都会经 `onObserverError(error, {channel, runId?, …})` 上报，并且 **run 继续跑**——抛错再也改变不了 `termination.reason`。观察者错误是 best-effort，不进持久化错误账本，因此宿主必须自己对 `onObserverError` 计数。要从回调里终结 run，请调 `signal.abort()`（抛出的错误携带 issue #180 载荷）；回调必须同步返回——只有被 await 的 `onRound` 与 `onToolResult` 会额外吸收 rejected Promise。`onToolResult` 是在**改写**工具结果而不是单纯观察：抛错时引擎保留自己的**原始**结果并上报，因此写在这个 hook 里的脱敏逻辑必须自己防住自己。完整契约见 `docs/host-consumer-contract_cn.md`「观察者回调抛错（issue #173）」。

## CLI：`erix`

`erix` 是仓库的验证/调试前端，不是无头运行时的产品接口。

### 命令与参数

```text
erix --version, -v
erix --help, -h
erix chat "<prompt>" [--stream] [--tools <names>] [--reflection <on|off>] [--final-guard|--no-final-guard] [--require-deliverable [<path>]] [--no-notes] [--no-todo] [--timeout <ms>] [--cwd <dir>] [--config <path>] [--skills-dir <path>] [--session <id>] [-c|--continue] [-r] [--dir <path>] [--compact-budget <tokens>] [--compaction <name>] [--max-rounds <n>] [--idle-timeout <seconds>] [--idle-retry-budget <seconds>] [--judge-log <path>] [--error-log <path>]
erix repl [--tools <names>] [--config <path>] [--skills-dir <path>] [--session <id>] [--dir <path>] [--compact-budget <tokens>] [--compaction <name>] [--max-rounds <n>] [--idle-timeout <seconds>] [--final-guard|--no-final-guard] [--require-deliverable [<path>]]
erix skills [--skills-dir <path>]
erix mcp [--config <path>]
```

不带参数运行 `erix` 会进入 `repl`。`chat` 参数由 `bin/cli.js` 实现；上面的 `repl` 参数由 `bin/repl.js` 实现。特别是，`repl` 不实现 `--stream`、`--reflection`、`--timeout`、`--no-notes` 或 `--judge-log`。

`chat` 默认 64 轮、300 秒 idle timeout、在 `max-rounds >= 16` 时启用 reflection，并关闭 final guard。`repl` 默认 32 轮、无 idle timeout、`reflection: false`，并在一轮无工具轮次后完成。

共享 CLI 参数包括：

- `--stream` 在 `chat` 中流式输出模型文本。
- `--session <id>` 选择 session；未显式指定 chat session 时，`chat` 会创建一个从工作目录派生的唯一 ID。显式 `--session <id>` 优先级最高——与 `-c`/`--continue` 或 `-r` 同时使用会直接报参数错误。
- `-c`、`--continue` 接续当前工作目录最近一次的会话（等价 `--session <最近id>`；与 `--session` 和 `-r` 互斥）。
- `-r` 打开交互式会话选择器（方向键移动，Enter 选中，Esc 取消）；需要 TTY，非交互环境请改用 `-c`/`--continue` 或 `--session <id>`。
- `--dir <path>` 选择 transcript 目录；`chat` 默认使用 `~/.erix/transcripts`。
- `--max-rounds <n>` 设置工具循环轮次上限。
- `--reflection <on|off>` 选择 chat reflection 行为。
- `--final-guard` 启用 CLI provenance guard；`--no-final-guard` 是兼容性 no-op，因为默认已关闭。
- `--require-deliverable [<path>]` 打开交付物机器判据。它**默认关闭**、**可重复**，且有**两种语义**（issue #391）：
  - **裸用** —— 「本 run 用写工具**声明过的**每个路径，收尾时都必须真的在盘上」（读 `fileWrites` 原始路径）。模型什么都不声明时空集合恒真 ⇒ 它判的是「没撒谎」，不是「做了事」。
  - **带值** —— 「**这次任务必须交付的这些文件**在盘上」，每条一个判据（相对路径按 `--cwd` 解析）。模型一次工具都没调也照样判不过——「必须交付 `report.md`」只能用这一种。
  两种写法都收：`--require-deliverable report.md` 与 `--require-deliverable=report.md`。值是可选的，所以裸用时后面别紧跟非旗标 token（prompt 写最前，或裸旗标放末尾）。判据合计最多 20 条（`DELIVERABLES_LIMIT`），路径不许重复。
  它**必须与 `--final-guard` 同用**（或 `ERIX_FINAL_GUARD=1`）：判据是拦 guard `accept` 的闸门，没有 guard 就没有闸门——单独给是 usage error（exit 1），不是静默空转。判据没过 ⇒ 终局 `unverified:deliverables_failed`（exit 2）。
- `--cwd <dir>` 设置本次 run 报给 guard 与模型的工作目录（默认：进程工作目录；必须是已存在的目录）。它正是 `finalGuard` / `deliverables` 载荷里的 `cwd`，所以用 `path.join(cwd, …)` 的判据开箱即用。
- `--no-notes`（或 `ERIX_NO_NOTES=1`）不装配 notes 工厂（`note_*` 工具不再可用），保留其他已加载的 skill。
- `--no-todo`（或 `ERIX_NO_TODO=1`）彻底关闭 todo：内置 `todo_*` 四工具不注册、系统提示不含 todo、用户级 todo skill 一并排除。
- `--error-log <path>` 把持久化错误事件追加写入 JSONL 文件（等价 `ERIX_ERROR_LOG`；默认只进 stderr）。
- `--timeout <ms>` 为 `chat` 提供软任务截止时间；它会推动循环进入 wrap-up，而不是强制杀死进程。
- `--idle-timeout <seconds>` 在没有进展后中止；`chat` 默认为 300，`repl` 默认为 0（禁用）。**工具执行时间不再计入静默窗口**（issue #433）：工具跑着的时候看门狗持续被喂表，所以一条长的安装/编译命令不会再打死整个 run——而且每次被喂过表的工具执行都会在 stderr 留一行 `[idle-heartbeat] <工具名>：执行期喂过 idle 计时器 N 次`（只在 `N > 0` 时打），这就是这件事的可观测证据。这份喂表是有上限的——`exec` 的天花板被钳到 `idle − 60s`（下限 30s），所以真正挂住的命令仍然以「命令超时」收场（默认 240s，即 `300 − 60`），而不是被看门狗悄悄吃掉。显式设置的 `ERIX_EXEC_TIMEOUT_MS` 若**等于或高于**该天花板，会被**收敛**成 `min(exec, idle − 60s)` 并打一条 loud 日志（issue #433 fix 4）；CLI **不**启动即报错——`exec == idle` 是 bench 两臂的真实配置，判据是「终局不得是 `idle_timeout`」。**这份让步有界，但不是没有代价**：`idle ≤ 30s` 时下限 30s 压过 `idle − 60s`，`exec < idle` 根本不可能成立，工具执行期最坏 = `30s + idle`——实测 `idle=1` → 30.8s、`30` → 52.5s、`120` → 150s，默认 `300` 的上界 540s（= `240 + 300`）。这一种情形也会打日志。
- `--idle-retry-budget <seconds>`（仅 `chat`，默认 900）是**判死后从 transcript 续跑**的总预算（issue #433 fix 1）：看门狗命中之后，CLI 指数退避（`1s`、`2s`、`4s`……上限 30s）再从**持久化 transcript** 恢复同一个 run（`resume`），而不是把任务从头重跑——已经付过费的轮次与 token 都留着。**这改变了静默 run 的默认墙钟**：依赖「静默 ⇒ 快速退出」的宿主必须显式传 `--idle-retry-budget 0`（一次 `idle_timeout`，即 #433 之前的形状）。双闸都要过：预算——**从第一次判死起的墙钟总时长**（退避**与**重试尝试都算），不是「退避之和」——以及次数硬上限 8 次。**实测最坏**（上游永久静默、`--idle-timeout 1`、默认预算）：从启动到退出 **130.3s**，共 9 发，退避 `1, 2, 4, 8, 16, 30, 30, 30` 秒（第 5 次重试之后 30s 上限开始生效）——这个窗口下先撞的是**次数**闸。默认 `--idle-timeout 300` 时先撞的是预算：从启动约 **903s**（300s 首次判死、两次重试，第三次判死已越过 900s）。**第一次重试约在 2s 时发起**（1s 窗口 + 1s 首段退避）。预算用尽时终局仍然是 `idle_timeout`（并保留 issue #440 的四件载荷），而记账（重试次数 / 每次退避 / 累计 usage）会挂在终局载荷上（`result.idleRetry` / `error.idleRetry`），并在 `judge.log` 里逐步写 `type: "idle_retry"` 记录。它**不是**「所有静默都被救」：`--stream` 的静默先撞 provider 的可重试相位截止（issue #441），`erix repl` 也没有重试。
- `--compact-budget <tokens>` 覆盖自动压缩预算。
- `--compaction <名>` 选择压缩策略（`sliding-window | fold-statistical | fold-llm`，默认 `fold-statistical`；也可用 `slots.default.compaction` 固定）。`fold-llm` 每次压缩多一次主力模型调用。
- `--tools <逗号分隔名称>` 是 `chat` 和 `repl` 的硬能力白名单；未知名称会告警，过滤后为空会报错。
- `--judge-log <path>` 在 `chat` 中以 JSONL 追加轮次/judge 拦截决策，每条带 `runId` 与解析出的 `model`，末尾再追加一条 run 级 `run_outcome` 汇总记录（这条终局记录即使 judge 关闭也会写——它是 run 的终局记录而非决策，有了它就不必为了 per-model 记账再开第二份档案）；默认落 `<归档目录>/judge.log`，探不到的字段缺省而非写占位值；档案原样落盘（脱敏已于 #55 退役）。

### 会话接续

`chat` 可以接续之前的会话，而不是每次新建。`-c`/`--continue` 接续**当前工作目录**最近一次的会话；`-r` 对同一份「本目录」列表打开交互式选择器（最近的在前，每行显示时间、完整会话 id 和首条 prompt 预览）。两者解析后与显式 `--session <id>` 走同一条路径——与 `-c` 或 `-r` 同时使用会直接报参数错误。

会话发现是**无状态**的：不再有会话索引。两个旗标都现场扫 `~/.erix/transcripts/`（实测真实 home 里 414 个 transcript 相关文件，全量 `readdir + stat` 只要 **29.7 ms**），而「这条 transcript 属于哪个目录」直接从文件名读出来——派生会话 id 恒以 `<目录名>-<sha256(绝对路径) 前 8 位>` 开头，所以按目录筛选不需要任何持久状态。这条哈希式自此是**行为契约**：`-c` 的按目录语义建立在它上面，`test/session-scan.test.js` 把它与 `bin/repl.js`、`src/tools/notes.js` 两处实现一起钉住（issue #168）。

两个必须知道的后果：

- **显式 `--session <id>` 必须存在。** 该 id 没有非空 transcript 时，`chat` 现在非零退出并给出可操作提示，而不再静默用这个名字开新会话（旧行为一个字的提示都不给，还多落一份 transcript）。给新会话命名在 `repl` 里照旧正常——`repl` 的 `--session` 是命名旗标。出路（`erix --help` 与那条报错文案里就是这么写的）：要**新建**就干脆不带 `--session`（不带才是新建）；要续**本目录最近一次**用 `-c`/`--continue`；要看有哪些能续用 `erix chat -r`（交互式选择器，需 TTY，**没有 `--resume` 这个旗标**，非交互环境改用 `-c` 或 `--session <完整 id>`）；`--session` 传**完整 id**（transcript 文件名去掉 `.jsonl`）。
- **看不见 ≠ 恢复不了。** 只有形如上面派生式的 id 才对 `-c`/`-r` 可见。你自己取的名字，以及目录名含 `[A-Za-z0-9._-]` 之外字符（空格、中文）因而文件名被哈希成 `run-h-*` 的那些，都不会出现在列表里——但它们都仍可用 `--session <完整 id>` 恢复，那条路径只要求存在非空 transcript。

内置 CLI 工具为 `readFile`、`searchText`、`rg`、`grep`、`tree`、`edit`、`writeFile` 和 `exec`。`searchText` 是唯一的搜索入口（issue #195）：它的 `mode` **必填且无默认值**——`literal` 按字面量匹配、`regex` 按 JavaScript 正则匹配，没传或传了非法 `mode` 都是显式报错而不是猜一个。它的名称过滤参数叫 `name_pattern`，**只匹配文件名、不跨 `/`**（所以 `**/*.ts` 一律不命中）。`rg` 与 `grep` 现在是它的**薄别名**（两者都映射到 `mode` = `regex`，`grep` 继续吃 `glob` 作为文件名过滤），各自在结果尾部挂一行弃用提示，而工具名与入参形状照用——移除它们要等 major bump（issue #188）。**三个**搜索工具都是纯 Node 实现，不是 `rg`/`grep` 二进制：别名的 `is_regex` 默认 `true`，即默认走正则（与真实命令一致）；传 `is_regex=false` 走字面量，等价 `rg --fixed-strings` / `grep -F`。每条命中行按**同一个**共享上限截到 500 字符，默认跳过 `node_modules`/`dist`/`build`/`target`/`vendor` 与 `.` 开头的目录（结果尾部回报跳过数量；**不读** `.gitignore`），并有 200 条硬结果上限。`readFile` 在字节上限内有界读取（默认 `262144`，可用 `ERIX_FILE_READ_MAX_BYTES` 覆盖）。工具操作任意路径和命令；checkpoint 保留完整结果，而 TTL 折叠只缩减 provider request view。没有可重放性分类、重跑检测或重跑告知：重复命令正常执行并返回新输出（ADR-016）。需要早期精确值时使用 note-first 顺序 `note_list` → `note_read`，不要依赖记忆。系统提示要求内部思考使用 English，面向用户的输出遵循用户语言。

重复的 `exec` 命令会正常执行并返回新输出：引擎不做幂等分类、不检测重跑、也不发重跑告知（ADR-016）。重跑值可能不同，所以副作用与重跑风险由宿主的权限/沙箱/幂等层承担——引擎的审计事实是归档输出本身，而不是"这条命令是否可重放"。

内置的 `notes` 工具提供 `note_take`、`note_read`、`note_list` 和 `note_forget`。它是一个面向 run、pull-only 的便利索引，用于事实、一次性值、决策和 artifact 引用；它不是逐轮日志，也不是 provenance 证据源（guard 的证据是 transcript 的归档输出）。headless 宿主可以从包根或 `erix-agent/tools` 通过 `createBuiltinNotesTools` 全套装配工厂注册；工厂返回 6 键 canonical API（`definitions`、双视图执行器 `executors` / 结构化 `executeTool`、`resolveTools`、run 生命周期钩子 `lifecycle.onRunComplete`（只 completeRun——过期清理归宿主按会话时钟调度 `store.purge`，CLI 在 run 收尾后接着执行）、ADR-015 折叠点 `semanticStateProvider`）——全部绑定同一 run scope 与同一 `NotesStore` 实例。需要 `ToolProvider` 形态的宿主可用 `createStaticToolProvider({ sets: { default: notes.definitions } })` 自建。CLI 已于 v0.11.0 退役 bundled `skills/notes/skill.mjs` 兼容 shim（issue #61）：启用 notes 时统一经工厂装配（可用 `--no-notes` / `ERIX_NO_NOTES=1` 关闭），`erix skills` 不再列出 bundled notes skill；用户和项目 skill 仍可从 `~/.erix/skills/`、项目的 `.erix/skills/` 或 `--skills-dir <path>` 提供。`erix skills` 会列出发现的 skill。

MCP 使用标准 `.mcp.json` 配置，并支持 stdio 和 HTTP server。`mcp` proxy 提供 `list`、`search`、`call` 和 `status` action。`erix mcp` 会列出已配置的 server 及其连接状态。

### 配置与本地状态

CLI 从 `$XDG_CONFIG_HOME/erix/config.json` 或 `~/.erix/config.json` 读取模型配置；`--config <path>` 覆盖该位置，环境变量优先。必需的模型输入为 `LLM_KIT_ENDPOINT`、`LLM_KIT_API_KEY`，以及来自 `LLM_KIT_MODEL`、`ERIX_DEFAULT_MODEL` 或 `slots.default.model` 的模型。`slots.default.maxOutputTokens` 默认为 `16384`；`slots.default.contextWindowTokens` 会启用自动压缩，`--compact-budget` 覆盖计算出的预算。

MCP 配置从当前目录的 `.mcp.json` 或 `~/.erix/mcp.json` 读取。本地主要目录结构为：

```text
~/.erix/
  config.json
  mcp.json
  sessions.json                已退役（issue #168）：不再读写，可安全删除
  session-meta.json            已退役（issue #168）：不再读写，可安全删除
  transcripts/
    <safeRunId>.jsonl
    <safeRunId>.snapshot.json
    <safeRunId>.checkpoint.json  旧快照后缀（读取兼容）
    <safeRunId>.state.json
  <session>.json                 REPL session 快照
  notes/run/<safeRunId>/         NotesStore 数据
  skills/                        用户 skill
  todos/                         由示例 todo skill 使用
```

`ERIX_NOTES_DIR` 会修改 notes 根目录。两种 CLI 模式都支持 `ERIX_EXEC_TIMEOUT_MS` 和 `ERIX_FINAL_GUARD`；`chat` 还支持 `ERIX_NO_TOOL_ROUNDS`、`ERIX_MAX_ROUNDS`、`ERIX_REFLECTION`、`ERIX_NO_REFLECTION`、`ERIX_NO_NOTES`、`ERIX_RETRY_ATTEMPTS`、`ERIX_TOOL_RESULT_TTL`、`ERIX_TOOL_RESULT_FOLD_MIN_TOKENS` 和 `ERIX_JUDGE_LOG`。库级控制项 `ERIX_NO_WRAPUP_INSTRUCTION`、`ERIX_NO_FORCED_FINAL` 和 `ERIX_STALL_MODE` 也会由相关循环行为使用；`ERIX_WRAPUP_NORMALIZE=1` 会启用 wrap-up LLM 规范化。

## 文档

- [docs/requirements_cn.md](https://github.com/ErixWong/erix-agent/blob/main/docs/requirements_cn.md) - 需求与阶段
- [docs/architecture_cn.md](https://github.com/ErixWong/erix-agent/blob/main/docs/architecture_cn.md) - API 契约与数据流
- [docs/decisions/](https://github.com/ErixWong/erix-agent/tree/main/docs/decisions) - 设计决策，包括配置、存储、压缩、reflection、工具、skill、安全、judge 方向、引擎/模型/宿主边界和 guard policy
- [docs/testing_cn.md](https://github.com/ErixWong/erix-agent/blob/main/docs/testing_cn.md) - 测试策略与行为指标
- [docs/host-consumer-contract_cn.md](docs/host-consumer-contract_cn.md) - 关于核验、note-first 取回、provenance 和重跑的宿主消费者契约；内含终止裁决决策表（逐 reason 的触发机制、优先级位置、宿主开关、推荐动作）与模型元数据 / 预算推导字段契约及多模型槽位装配示例
- [docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md) - 0.6.0 破坏窗口迁移步骤（英文）
- [docs/host-upgrade-guide-0.24.0.md](docs/host-upgrade-guide-0.24.0.md) / [docs/host-upgrade-guide-0.24.0_cn.md](docs/host-upgrade-guide-0.24.0_cn.md) - 最新的宿主迁移指南（中英成对），**0.23.0 → 0.24.0**：「运行时不再替你做猜测」那一版。两处增量/修好的信息面——`<runId>.state.json` 自报 `deterministic.compactionStatsWindow`（`{ limit, dropped, total }`），`checkpoint_failed` 的 `cause` / `errorCode` / `unpersisted` 与 `persistence_failed` **键名与取值类型都相同**——加上四处**模型可见**的工具输出修正：`tree` 非根目标首行改成可回放的相对路径、`readFile` 改写你入参时给 `[参数校正：…]`、读到末尾给 `[已到末尾：…]` 而不是空串、搜索根不存在返回错误文本而不是 `（无命中）`、`rg`/`grep` 的弃用提示按本次调用的真实 mode 说话。没有 store 签名、选项或导出搬家（更早一份见 [docs/host-upgrade-guide-0.23.0.md](docs/host-upgrade-guide-0.23.0.md)，覆盖 0.22.0 → 0.23.0）
- [docs/host-upgrade-guide-0.18.0.md](docs/host-upgrade-guide-0.18.0.md) / [docs/host-upgrade-guide-0.18.0_cn.md](docs/host-upgrade-guide-0.18.0_cn.md) - 更早一个破坏窗口的宿主迁移指南（中英成对）：judge 的 `writeToolNames` 默认值、七项文件工具清单、`rg`/`grep` 的弃用提示行、属 Experimental 的 marker 文案、以及 `erix-agent/tools` 导入路径；之后每个破坏窗口都随包发一份 `docs/host-upgrade-guide-<version>.md`（随包清单见上文）
- [docs/host-upgrade-guide-0.17.0.md](docs/host-upgrade-guide-0.17.0.md) - 更早的破坏窗口迁移指南：成对可选快路径探针（英文）
- [docs/host-upgrade-guide-v030_cn.md](https://github.com/ErixWong/erix-agent/blob/main/docs/host-upgrade-guide-v030_cn.md) - 面向 `touwaka` / `app_container` 的宿主升级指南与 v0.3.x 行为
- [docs/maintenance-policy_cn.md](https://github.com/ErixWong/erix-agent/blob/main/docs/maintenance-policy_cn.md) - 维护策略与内部替换/止损标准
- [docs/research/](https://github.com/ErixWong/erix-agent/tree/main/docs/research) - 调研报告（仅中文）
- [docs/design/](https://github.com/ErixWong/erix-agent/tree/main/docs/design) - 设计与 RFC 材料（仅中文）

### 文档家族与真值口径

本仓不是每份 Markdown 都在声明同一件事，门禁也按不同的口径筛（`scripts/docs-drift-check.mjs` + `test/docs-anchor-ratchet.test.js`）。三类：

- **活文档——有门禁，必须「今天为真」。** `README*.md`、`AGENTS*.md`、中英契约（`docs/host-consumer-contract.md` /
  `docs/host-consumer-contract_cn.md`）、**全部** `docs/host-upgrade-guide*.md`（当前 22 份，按目录实扫），再加上
  工单 261021-03 B1 新纳面的中英架构（`docs/architecture.md` / `docs/architecture_cn.md`）、中英图表
  （`docs/charts.md` / `docs/charts_cn.md`）、中英需求对照（`docs/requirements.md` / `docs/requirements_cn.md`）
  与 `erix_run` 的 README（`examples/pi-extension/README.md`）。共 35 份（`REF_SCAN_DOCS_MINIMUM = 35`）：文件改名、
  行号漂到另一个函数、符号在 `src/` 里已不存在，都会把 `npm run check:docs` 压红。
- **快照档案——「首部写的那一日为真」。** `docs/v0.0-contracts*.md` / `docs/v0.1-contracts*.md` /
  `docs/v0.2-contracts*.md`、`docs/design/`、`docs/research/`、`docs/harness-comparison/`（共 28 份）。每份首部都有一行
  `> 快照档案（<日期>）`：里面的路径、数字与结论按**当时**为真，“现在是什么”由中英契约与 `CHANGELOG.md` 回答而不是由它们
  回答。把它们改成“跟今天一致”等于揉掉它们作为证据的身份——这也是它们故意不进棘轮面的理由。
- **ADR——编号就是时间点。** `docs/decisions/NNN-*.md` 记的是“那一刻做了什么决定”，不加快照抬头：ADR 的编号**就是**
  时间戳，它不会“今天错了”，只会被后面那个编号推翻。

`docs/` 剩下的那些（`docs/testing*.md`、`docs/maintenance-policy*.md`、`docs/mcp-design*.md`、`docs/soak.md`）两边都不算：
既不在棘轮面内，也没有快照抬头——当“有日期的辅助说明”读，不要当现行契约读。而引用**别的仓库**的文件时一律写成
`<仓名>:<那个仓里的路径>`（例 `touwaka:lib/agent/`）；**不带**前缀的路径就是本仓路径，必须能在本仓解到。

## 状态与版本历史

权威的版本口径是 [`package.json`](package.json) 的 `version` 字段，`npm run check:docs` 会校验下面这行发布声明。当前发布版本：**v0.24.0**（2026-10-22）。完整且权威的历史见 [CHANGELOG.md](CHANGELOG.md)；下面条目只列出改变了宿主消费方式的发布。0.6.0 破坏窗口的迁移步骤见
[docs/host-upgrade-guide-0.6.0.md](docs/host-upgrade-guide-0.6.0.md)。

- **v0.24.0 (2026-10-22)**：「运行时不再替你做猜测」那一版——引擎没有改它**做**什么，改的是它**说**什么。
  `<runId>.state.json` 自报削减账窗口（`deterministic.compactionStatsWindow = { limit, dropped, total }`，
  增量字段：读的人不必读源码就能分清「尾巴」与「全量」），两个持久化失败出口（`persistence_failed` /
  `checkpoint_failed`）从此带**同名同类型**的 `cause`（是 `Error`）、`errorCode`（是字符串）、
  `unpersisted`（是裸数组），宿主不必再解析 `message` 字符串。四处**模型可见**的工具输出变诚实：`tree`
  非根目标首行改成相对工具根目录的可回放路径（不再是 basename）、`readFile` 改写
  `offset`/`limit`/`max_bytes` 时给 `[参数校正：…]`、越过末尾给 `[已到末尾：…]` 而不是空串、搜索根不存在返回
  错误文本而不是 `（无命中）`、`rg`/`grep` 的弃用提示按本次调用的真实 mode 给（`is_regex: false` 是字面量，
  劝 `mode="regex"` 等于静默换语义）。打包：tarball 新增 `test/helpers/tmp.js`（随包契约套件要 import 它）。
  没有 store 签名、选项、导出或依赖搬家。迁移见 [docs/host-upgrade-guide-0.24.0_cn.md](docs/host-upgrade-guide-0.24.0_cn.md)，覆盖 0.23.0 → 0.24.0。

- **v0.23.0 (2026-10-21)**：存储收敛那一版（工单 261021 三刀）——账本改成**一条消息一行**、消息一成型就落盘，
  轮行只留**元数据**；`store.load()` 把消息行折回所属的轮，所以读 `load()` 的宿主看到的记录形状不变。宿主必须
  处理四处后果：原始 journal 行不再带正文（改读 `load()`）、`onRound(record)` 不再交出 `record.messages`、
  run snapshot 的 `messages` 只是**落后副本**（写于本轮工具执行之前）而不是正文来源、`projectTranscriptForDisplay`
  必须喂 `load()` 的折叠输出（喂原始行会重复出条目并丢掉 `durationMs`）。没有 store 签名、选项、导出或依赖搬家。
  迁移见 [docs/host-upgrade-guide-0.23.0_cn.md](docs/host-upgrade-guide-0.23.0_cn.md)，覆盖 0.22.0 → 0.23.0。
- **v0.22.0 (2026-10-21)**：持久化真相专场（issue #322 / #323 / #326）——引擎在**轮记录已经落盘之后**才注入给模型的文本（judge 评审意见、扩轮提示、guard 返工意见、强制收尾指令与它的终稿 assistant）从此在同一轮里就写进档案；折叠摘要与 TTL 降级结果同样落账，并在 resume 时**复用而不是重算**，于是「模型当时到底看见了什么」变成可以从档案里回答的问题。宿主必须处理的两处后果：同 `dedupKey` 却换内容的写入从此抛 `code === "dedup_payload_conflict"`，不再悄悄消失；`load()` 返回的**行数多于轮数**（其中一些 `messages` 为空）——按 `round` 归组、按 `dedupKey` 去重、跳过 `meta.source === "judge-control"`。新增可选 `reflection.judgeDoneAdvisory`，把「治理凭什么说目标已达成」说给模型听（默认关，终止语义一字未改）。**0.21.0 从来没发出去过**，因此本版把它一并带上：迁移见 [docs/host-upgrade-guide-0.22.0_cn.md](docs/host-upgrade-guide-0.22.0_cn.md)，那份指南是 0.20.0 → 0.22.0 一跳到位。
- **v0.21.0 (2026-10-16)**：模型 JSON 专场——`parseModelJson`（`src/text/parse-model-json.js`，从包根导出）成为「从模型文本里抠 JSON」的唯一入口：失败三态可分（`no_candidate` / `unparsable` / `shape_mismatch`）、失败结果**不带** `value` 键、**没有任何 repair**、`topOnly` 两档扫描。`parseReflectionDecision` 不再把模型明确写下的布尔值翻向（贪婪花括号正则换成顶层平衡扫描），返回体新增 `via: "json" | "prose_fallback"`（随包声明里是字面量联合）。把 `context.budgetTokens` 配得很小的宿主从此不再收到 `400 No user query found in messages`：发给上游的请求视图始终保留一条真 user 轮（run 就是能跑了；守卫真生效时才多出两个 additive 的 `compactionStats` 键）。本版**没有任何一处会打断调用点**。迁移见 [docs/host-upgrade-guide-0.21.0.md](docs/host-upgrade-guide-0.21.0.md)。
- **v0.20.0 (2026-10-15)**：工具事实专场——引擎拥有的每一条 `tool_result` 事实从此只落 `erix.*` 命名空间（`toolCallKey` / `round` / `durationMs` / `executionStatus` / `success`），宿主扩展只落 `metadata.*`；顶层摊平别名（`erixRound`、`duration`、`executionStatus`、`success`，以及过去被摊到顶层的任意宿主键）**停写**，升级前落盘的记录保留**一代读兼容**。「停止」从此压过 end-turn judge 与 final guard（终局 `reason` 是 `aborted`，不再是 `judge_done`），且 `termination.partial: true` 只担保终局载荷、对 store 不作断言（issue #283，裁决 = β）。`createFileTools().executeTool()` 的四种成功形态由随包契约套件逐工具钉死，并新增从 `erix-agent/tools` 导出的判别式 `classifyFileToolResult`。迁移见 [docs/host-upgrade-guide-0.20.0.md](docs/host-upgrade-guide-0.20.0.md)。
- **v0.19.0 (2026-10-13)**：随包类型面专场——npm 包从此携带包根与 `erix-agent/tools` 的 `.d.ts` 声明（`package.json` 新增顶层 `types`，这两个 `exports` 各加 `types` 条件；声明由 `prepack` 钩子生成、不入库，干净检出里一个都没有、tarball 里有；`exports["./contract-tests"]` 刻意不带 `types`）；`classifyHttpError` 补上 400/422 → `invalid_request`、404 → `not_found`、409 → `conflict`，不再落 `unknown`（既有映射、`retryable` 取值与重试行为逐字未动——按 `code === "unknown"` 分支的宿主需把新 code 列进「改请求而不是重试」的分支）；CLI 的 `chat --session <id>` 在该 id 没有非空 transcript 时报错退出（此前是静默新开会话），会话索引状态文件退役，`-c`/`-r` 改为现扫现算。内部：`runToolLoop` 内的两项**限定范围**重构——选项规范化整块逐字外提到 `src/loop/option-normalization.js`、循环闭包 `let` 折成单个 `runLoopState` 对象字面量；已对 v0.18.0 逐行对账，**残留 0 行、无可观察行为变化**（新增的 `src/loop/state-view.js` 目前没有任何文件 import，它**不是**上面那个统一状态对象；同窗口的 `#213` JSDoc 大重组不在本条声称范围内），仓库新增仅 dev 的 `--checkJs` 棘轮门禁 `npm run check:types`。2026-10-13 并入同一版的改动**是 additive（不必改调用点），但其中两处宿主可观测**（`readFile` 续读 marker 新增了文件大小、`runToolLoop` 返回值的 typedef 由单行改成多行块——见该指南第 6 节与 issue #293）：`src/index.js` 新增导出 `createMemoryNotesStore`；pi extension `erix_run` 交回**完整**终稿正文（宿主层截断已删）、异步 `action: "result"` 从此真能取到 `finalText`、其 `outputSchema` 补声明 `verification` 与 `error`（引擎自己的验证结论首次能到宿主手上）、文件读取工具描述带上实测额度事实。`erix_run` 与本包**同一版本号**，且**不进 tarball**。全量清单见 CHANGELOG。
- **v0.18.0 (2026-10-09)**：宿主集成面专场——观察者回调从此杀不掉 run（九通道一律经 `onObserverError` 记账后继续，终止 run 走 `signal.abort()`，抛出的错误携带 `usage`/`rounds`/`finalText`）；failed 终局携带 `termination.errorCode`；`context.strategy` 可按名选内置策略（`"fold-llm"` 开箱自带主力 provider summarizer，每次压缩多一次调用、usage 计入总账）；新增一次性 `model_metadata_missing` 与终局 `run_outcome` 事件，judge 记录增补 `model` 归因；provider 新增 `defaultHeaders`/`extraBody` 注入口；token 估算热路径优化（逐字节同值，每轮估算 CPU 约 −88%）。0.17 宿主无必改的 API 适配，但三种宿主习惯各需要查一次——judge 的 `writeToolNames`（显式传是整体替换，`edit` 不会被并入）、被钉死的文件工具名清单（现为七项）、以及对 `rg`/`grep` 输出的逐字匹配（每次调用尾部多一行弃用提示）：见 [docs/host-upgrade-guide-0.18.0_cn.md](docs/host-upgrade-guide-0.18.0_cn.md)，全量清单见 CHANGELOG。
- **v0.17.0 (2026-10-08)**：`appendUserTurn` 新增成对可选快路径探针 `loadByDedupKey`/`loadMaxRound`（DB 宿主预写 user 轮不再每轮全量读），契约文档的 js 围栏改为可执行测试（`npm run check:docs-examples`）。
- **v0.15.0–v0.16.0 (2026-10-07/08)**：「transcript 即真相」的宿主侧接口——读侧 `projectTranscriptForDisplay`、写侧 `appendUserTurn`（多轮续跑契约）、投影稳定 `key`，以及 store 保真义务（保留完整 `RoundRecord`、同轮记录按追加顺序 `load()`）。
- **v0.14.0 (2026-10-03)**：run-state 终态改由 `markRunState`/`loadRunStateStatus` 承载（latest-only 快照不再写 `state`）、工具可声明 `replay: "safe"|"unsafe"` 并配合 `replayPolicy`、新增可选 partial 落盘，删除 `src/loop.js` 转发 shim。
- **v0.13.0 (2026-09-30)**：run snapshot 更名与 `TranscriptStore` capability 分级公开，CLI 会话索引（`~/.erix/sessions.json`，已于 #168 退役成无状态扫描）。
- **v0.11.0–v0.12.0 (2026-09-26/27)**：notes 迁到宿主侧 `NotesStore` 并收敛为单一保留期旋钮（`ERIX_NOTES_RETENTION_MS`），`createBuiltinNotesTools()` 收敛为 6 键 canonical API（退役 bundled notes skill shim）。
- **v0.9.0 (2026-09-22)**：扩轮决策统一归 judge——nearLimit 时 end-turn judge 与工具拦截审计必须返回 `extend`/`extendReason`/`plan`；批准的 `extend: true` 提升有效轮数预算（拦截路径补上了「模型从不 end_turn」的盲区）。删除 legacy nearLimit reflection 路径：`reflection.triggerRound` 移除，`reflection_stop` 当前无触发路径。长任务不再「未评估即撞 `max_rounds_cap`」。
- **v0.8.0 (2026-09-21)**：recall 适配器和有界 transcript 取回退役；模型侧改为 note-first（`note_list` → `note_read`）。新增 request-view 工具结果 TTL 折叠、可重试的空 assistant 消息、CLI 工具白名单、纯 Node `grep` 工具和按语言输出指令。
- **v0.7.0 (2026-09-19)**：单轮聚合输出预算、折叠摘要锚点（路径/SHA/URL 机械保真）、CLI exec 截断改 head+tail、intercept 审计间隔 5→10 且 on_track 放行、stall 检测默认 `consecutive`、resume 轮号/轮预算拆分。
- **v0.6.0 (2026-09-18)**：ADR-015/ADR-016 破坏窗口收口——可重放概念（`rerunOf` 告知、重跑检测、auto-capture）与 `resourceStore` 端口删除；guard 改为核验结束信封的 `findings` 与全部归档输出比对；引擎标配 transcript 输出卫生（`toolOutputs`）；持久化失败通过 `unpersisted`/`completionErrors` 上报；陌生 run 选项抛错。详见 CHANGELOG 与 0.6.0 升级指南。
- 更早版本（v0.2.0 ~ v0.5.1）：见 [CHANGELOG.md](CHANGELOG.md)。

项目所描述的宿主迁移和 benchmark 工作仍在进行中，不能据此承诺未来的宿主或 sandbox 组件已经包含在本包中。

## 发布验证

仓库的发布流程在 `LLM_KIT_E2E=1` 时使用真实 relay E2E 测试：

```bash
LLM_KIT_E2E=1 node --test examples/*.test.mjs
```

测试需要已配置的模型。模型按 `slots.default.model`、`LLM_KIT_MODEL` 或 `ERIX_DEFAULT_MODEL` 的顺序解析；缺少配置时会失败，而不是静默选择其他模型。发布记录应标明实际使用的模型。

示例从 pi 的 `~/.pi/agent/models.json` 读 relay 配置，既不写死 provider 槽位名，也不写死模型名。provider 槽位按以下顺序解析：`LLM_KIT_RELAY_PROVIDER`（槽位名）、`LLM_KIT_RELAY_URL`（与 `baseUrl` 同源匹配，比较前规范化尾部斜杠）、`LLM_KIT_MODEL`（模型列表含该 id 的槽位），其次只有一个槽位时直接用它；否则运行失败并列出候选槽位及其 baseUrl 与模型列表。模型在 `LLM_KIT_MODEL` 设了时直接采用；否则取声明的 demo 偏好表里该槽位真正提供的第一项，交集为空则失败，而不是静默选择一个槽位并未声明的模型。

Notes 实验脚本同样按 `--model`、`ERIX_EXPERIMENT_MODEL` 或 `--config`/`~/.erix/config.json` 的顺序获取模型。它们提供成本预览；不带 `--yes` 时默认为 dry-run；默认 `--max-calls 40`；模型调用失败后立即停止，而不是切换模型。

## 基准验证（erix-bench / Terminal-Bench archive）

项目使用容器驱动和官方 grader，报告 Terminal-Bench archive 任务的无头 harness 结果，并比较 `--agent erix|pi`。完整的逐次运行报告维护在配套的 erix-bench 仓库中；下面的数字是 README 记录的结果，并不表示本仓库会自动运行这些任务。

### 通过任务（reward=1，按模型）

- `historical-model`：广泛任务集 **34 个通过**（`bn-fit-modify`、`break-filter-js-from-html`、`build-cython-ext`、`crack-7z-hash`、`fix-git`、`git-multibranch`、`prove-plus-comm`、`sqlite-db-truncate` 等）。
- `historical-model-2`（较新的困难任务与恢复样本）：**11 个通过**（`adaptive-rejection-sampler`、`chess-best-move`、`code-from-image`、`db-wal-recovery`、`fix-code-vulnerability`、`password-recovery` 等）。
- 同样本上的 `pi` 对照：**4 个通过**（`break-filter-js-from-html`、`build-cython-ext`、`build-pov-ray`、`distribution-search`）。

两个 `historical-model` 总数不可直接比较：前者运行次数更多、任务组合更广；后者更强调困难任务和恢复任务。逐任务明细见 erix-bench 仓库。

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

这些 benchmark 数字是项目历史证据，不是 API 保证。Judge 设计决策记录在 [ADR-011](https://github.com/ErixWong/erix-agent/blob/main/docs/decisions/011-judge-direction_cn.md)。

## 许可证

MIT © 2026 ErixWong（见 [LICENSE](LICENSE)）。
