# erix-llm-kit

跨项目共享的 **LLM 对话循环引擎**：协议适配 + 工具调用循环 + 上下文预算压缩。
消费方：`app_container`（PI Agent 审计/开发链路）、`touwaka`（AgentLoop / 对话链路）。

> **定位红线：这是"脑干"，不是 agent。**
> 本库**不自带任何工具、不执行任何东西、没有人格、不做持久化决策**。
> 它只做一件事：把"LLM 请求工具调用 → 回调可信代码执行 → 结果回喂 → 直到终稿"
> 这段循环做到**长任务不爆窗、抖动不重跑、协议可换**。
> 工具白名单、路径牢笼、密钥脱敏、产物海关、SSE、落库——全在调用方。

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
├── tools/         # 【v0.2】可选工具库（subpath export）：路径牢笼 + 文件工具参考实现 + recall + registry
└── loop.js        # runToolLoop  v0.0: 最小版 · v0.1: 轮内快照重试/死循环检测/完成信号/每轮压缩检查 全量
```

## 工程约束

- **零运行时依赖**、纯 ESM、Node 22+、无构建步骤
- 测试：`node --test`（app_container 侧需 Node 24 跑 `await using`，库本身 22 可测）
- 类型：JSDoc typedef（两个消费项目都是纯 JS）
- 分发：Gitea npm registry（`@erix/llm-kit`），token 走构建期 secret，不进镜像
- 任何提交禁止 token/密钥明文

## 文档

- [docs/requirements.md](docs/requirements.md) — 需求与分期
- [docs/architecture.md](docs/architecture.md) — 接口契约与数据流
- [docs/decisions/](docs/decisions/) — 六个核心设计决策（配置/存取/压缩/反思/工具体系/工具定义分层）
- [docs/testing.md](docs/testing.md) — 测试方案（分层/基建/各阶段测试清单/行为指标）
- [docs/research/](docs/research/) — 调研报告（记忆系统与上下文压缩外部实践，2026-08-29）

## 状态

2026-08-29：v0.0 MVP（[issue #1](https://git.erix.vip/eric/erix-llm-kit/issues/1)，PR #2）与
v0.1 库侧（[issue #3](https://git.erix.vip/eric/erix-llm-kit/issues/3)，PR #4）已完成——
双协议（OpenAI + Anthropic，流式/非流式）、FR-2 全量循环、压缩①②、static/env config 均已落地，
92 单测全绿，真实 relay e2e 跑通多轮工具调用与强制压缩。
下一里程碑：app_container 迁移（v0.1 最终验收）→ v0.2（file store / recall / fold-llm / tools 子路径）。
