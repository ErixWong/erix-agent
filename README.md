# erix-agent

**自研轻量编码 agent**：零依赖的 LLM 对话循环引擎 + 交互式 CLI（erix）+ 可扩展生态（skill 自描述协议 / MCP 对接 / 任务管理）。

**定位：这是一个完整的 agent，不是库。** 三件套：

1. **引擎**（src/，零执行零安全）：协议适配 + 工具调用循环 + 上下文预算压缩——
   流式/压缩折叠/续写/死循环检测/信号中止，长任务不爆窗、抖动不重跑、协议可换。
2. **CLI**（bin/，erix 命令）：交互式 TUI + 单次对话；工具面全面直通（readFile/writeFile/rg/tree/exec，
   任意路径任意命令）；配置/会话/任务全量家目录管理（~/.erix/）。
3. **生态**（可扩展）：skill 自描述协议（~/.erix/skills/*，脚本自报工具，ADR-008）+ **MCP 对接**
   （单代理工具访问任意 MCP server，stdio + HTTP，复用标准 .mcp.json 配置）+ todo 任务管理。

> **安全边界由运行环境提供**（[ADR-009](docs/decisions/009-safety-layering.md)）：**谁用这个 agent 谁负责安全**——
> 本地跑就是你的机器（信任域），嵌入容器/沙盒场景由宿主隔离。
> CLI 不内置白名单/牢笼/确认弹窗，工具面全面直通（含写与执行）。

消费方：`app_container`（PI Agent 审计/开发链路）、`touwaka`（AgentLoop / 对话链路）。

## 为什么是自研而不是 Vercel AI SDK / LangChain

调研结论（2026-08-29）：

- **Vercel AI SDK**（`ai` v7）：provider 适配 + tool loop 成熟，但**上下文压缩明确不做**（官方 cookbook 让用户用 `prepareStep` 自己写）。最有价值的一半仍需自研。
- **oneringai**：全家桶 agent 平台（语音/图像/MCP/22 个重依赖），形态不对。
- **LangChain.js / Mastra / LangGraph**：框架级抽象，两个消费项目都刻意不用框架。
- **pi SDK**：完整 agent（session 格式/资源加载/自带工具执行），撞 app_container "LLM 无任何直接执行面"不变量。

触发重估的条件（写死）：**需要接第三家非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁到 AI SDK 为底座。

## 模块地图

```
src/
├── providers/     # OpenAI 兼容 + Anthropic 双协议 → 统一内部块格式（流式/非流式）
│                  #   v0.0: openai 非流式 · v0.1: +anthropic +流式
├── messages/      # 规范消息模型 + 轮次分组（两种协议的成对规则）  v0.0
├── tokens.js      # 中英混合保守 token 估算  v0.0
├── compact/       # 压缩策略  v0.1: sliding-window / fold-statistical · v0.2: fold-llm · v2: psyche
├── store/         # TranscriptStore：v0.0 memory · v0.2 file(JSONL) · DB 适配器在项目侧（MariaDB）
├── config/        # ModelConfigProvider：v0.1 static / env · v0.2 json-file · DB 适配器在项目侧
├── tools/         # 【v0.2】可选工具库（subpath export）：路径牢笼/文件工具/recall/registry 参考实现
└── loop.js        # runToolLoop  v0.0: 最小版 · v0.1: 轮内快照重试/死循环检测/完成信号/每轮压缩检查 全量
```

## 工程约束

- **零运行时依赖**、纯 ESM、Node 22+、无构建步骤
- 测试：`node --test`（app_container 侧需 Node 24 跑 `await using`，库本身 22 可测）
- 类型：JSDoc typedef（两个消费项目都是纯 JS）
- 分发：公开 npm（`erix-agent`），代码托管在 GitHub（ErixWong/erix-agent）
- 任何提交禁止 token/密钥明文

## CLI：erix（agent 形态）

`erix` 是构建在本库上的交互式编码助手：

- **入口**：`erix` 直接进交互 TUI（`erix repl` 等价）；`erix chat "<prompt>" [--stream]` 单次对话
- **工具面**：readFile / rg / tree / writeFile / exec（任意路径、任意命令、git 不限）——无内置安全层，见 ADR-009
- **skill 系统**：`~/.erix/skills/<id>/skill.mjs` 自描述脚本，导出 `getSkillDefinition()` 自报工具（ADR-008）；`erix skills` 查看；todo skill（跨会话任务清单，长任务拆解/划掉/恢复）
- **MCP 对接**：`~/.erix/mcp.json` 标准配置，单代理工具（list/search/call/status）访问任意 MCP server（stdio + HTTP；实测 unifuncs 联网搜索、filesystem 读文件）
- **配置**：`~/.erix/config.json`（或 `$XDG_CONFIG_HOME/erix/`），env 优先；会话存档 `~/.erix/<session>.json`；todo 清单 `~/.erix/todos/`
- **流式**：repl 默认打字机；`chat --stream` 逐字输出；`--idle-timeout` 无进展自动中止；自动压缩预算（按模型窗口折叠）

> ⚠️ 安全声明：erix **不提供安全边界**。模型能读写任意文件、执行任意命令——
> 只在你自己信任的机器/沙盒里运行，别在不可信环境裸跑。

## 文档

- [docs/requirements.md](docs/requirements.md) — 需求与分期
- [docs/architecture.md](docs/architecture.md) — 接口契约与数据流
- [docs/decisions/](docs/decisions/) — 九个核心设计决策（配置/存取/压缩/反思/工具体系/工具定义分层/记忆架构/skill 系统/安全分层）
- [docs/testing.md](docs/testing.md) — 测试方案（分层/基建/各阶段测试清单/行为指标）
- [docs/research/](docs/research/) — 调研报告（记忆系统与上下文压缩外部实践，2026-08-29，ADR-007 的输入）

## 状态

2026-08-30：改名 **erix-agent** 并推 GitHub（ErixWong/erix-agent）——
双协议流式、FR-2 全量循环、压缩策略（自动预算折叠）、file store/recall/fold-llm、json-file config、
CLI 交互 TUI、配置/会话持久化、skill 自描述生态（todo 任务管理）、内置工具面（读写执行）、
流式打字机、MCP 对接（stdio + HTTP，联网搜索实测）、idle 超时。236 单测全绿（+4 条件跳过），
真实 e2e 跑通多轮工具调用、压缩、流式与 MCP 联网调研。
下一里程碑：npm 发布（erix-agent）→ app_container 迁移（以 erix-agent 引擎构建可控编码 agent，容器沙盒由 app_container 提供）→ 通用 sandbox 组件（独立于 agent，另立 ADR）。
