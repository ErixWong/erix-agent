# 测试 — erix-agent

> English version: [testing.md](testing.md)

测试套件零依赖：使用 `node:test` 和 `node:assert/strict`，在协议边界 mock `fetch`，并使用 fake provider 测试循环编排。真实 LLM 调用仅限于可选的示例 E2E 测试。本项目没有浏览器 UI，因此不需要 Playwright 或 vision 工具。

## 0. 测试分层与基础设施

### 分层

| 层 | 命令 | 范围 | 运行时机 |
|---|---|---|---|
| 单元测试与本地集成测试 | `npm test`（`node --test`） | 仓库的 test tree；无需外部 LLM 或网络服务 | 每次提交前；套件必须全绿 |
| 语法检查 | `npm run check`（`node --check src/index.js`） | 当前由 `check` script 配置的命令 | 作为工程 sanity check |
| 单个测试文件 | `node --test test/loop.test.js` | 聚焦某一区域时，将路径替换为任意单个测试文件 | 聚焦开发期间 |
| 可选的真实 relay E2E | `LLM_KIT_E2E=1 node --test examples/*.test.mjs` | `examples/exec-demo.test.mjs`、`examples/memory-benchmark.test.mjs` 和 `examples/provenance-repro.test.mjs`；只有设置 `LLM_KIT_E2E=1` 才会运行，否则跳过 | 手动里程碑或发布验收 |

package 将 `./contract-tests` 导出定义为 `./test/contract/index.js`。契约测试是供消费者提供的适配器注册的可复用 `node:test`，不是 `package.json` 中的独立命令。消费者适配器测试导入公共入口并调用相应契约：

```js
import { transcriptStoreContract, modelConfigProviderContract } from "erix-agent/contract-tests";
transcriptStoreContract("mariadb", () => createMariaTranscriptStore(...));
modelConfigProviderContract("mariadb", async () => ({ provider, slot, expect }));
```

### 测试基础设施

1. **Mock fetch**（`test/helpers/mock-fetch.js`）提供可编程的 `fetchImpl`。它记录请求 URL、方法、请求头和解析后的请求体，然后返回脚本化的 JSON、文本、字节或流式响应，也可以抛出脚本化错误。协议适配器测试使用它而不是网络。
2. **Fake provider**（`test/helpers/fake-provider.js`）是内存中的、符合 `LlmProvider` 形状的 provider。它记录请求，返回脚本化文本和 `tool_use` 内容，支持重复的脚本步骤，也可以抛出脚本化错误。循环测试直接使用它，因为测试对象是编排而不是 HTTP。
3. **Canonical round fixtures**（`test/fixtures/rounds-fixtures.mjs`）提供具有代表性的纯文本、单工具、多工具和混合多轮对话，供消息转换和压缩测试使用。
4. **本地 MCP fixtures** 位于仓库根目录的 `fixtures/` 目录：`fixtures/mock-mcp-server.mjs` 和 `fixtures/mock-mcp-http-server.mjs`。它们是供 `test/mcp.test.js` 使用的可执行 stdio 和 HTTP server。请将这些 server 保持在 `test/` 之外：`node --test` 会发现 test tree 下的文件，将长驻 fixture server 当作测试文件执行可能导致测试运行挂起。`test/fixtures/` 下的数据 fixture 由测试导入，并不是 server 入口。
5. **契约 helpers**（`test/contract/index.js`、`test/contract/transcript-store.js`、`test/contract/model-config-provider.js`、`test/contract/assembly-port.js`、`test/contract/execute-tool.js`、`test/contract/notes-store.js` 和 `test/contract/recall-contract.js`）定义宿主端口的共享断言。内置的 memory/file store 和 config provider 会在各自测试中注册这些契约。

完整的、已跟踪的 `test/` tree 如下：

```text
test/
├── app-container-p0.test.js
├── capture-honesty.test.js
├── cli.test.js
├── codewrite.test.js
├── config.test.js
├── error-ledger.test.js
├── governor.test.js
├── judge.test.js
├── loop-callback-this.test.js
├── loop-final-guard.test.js
├── loop-fr2.test.js
├── loop-resume.test.js
├── loop-stream.test.js
├── loop-termination.test.js
├── loop-v020-beta.test.js
├── loop-v020-rc.test.js
├── loop-v020.test.js
├── loop.test.js
├── mcp.test.js
├── notes-autocapture.test.js
├── notes-directory.test.js
├── notes-experiment.test.js
├── notes-final-guard.test.js
├── notes.test.js
├── output-aggregate-budget.test.js
├── output-hygiene.test.js
├── persistence-diagnostics.test.js
├── recall-standard.test.js
├── reflection.test.js
├── repl.test.js
├── run-state.test.js
├── skills.test.js
├── tokens.test.js
├── tools.test.js
├── wrapup.test.js
├── compact/
│   ├── anchors.test.js
│   ├── budget.test.js
│   ├── enforce-size.test.js
│   ├── fold-fidelity.test.js
│   ├── fold-llm.test.js
│   ├── fold-statistical.test.js
│   ├── sliding-window.test.js
│   └── v020-rc.test.js
├── config/
│   ├── api-key.test.js
│   ├── env.test.js
│   ├── json-file.test.js
│   └── static.test.js
├── contract/
│   ├── assembly-port.js / assembly-port.test.js
│   ├── execute-tool.js / execute-tool.test.js
│   ├── index.js
│   ├── model-config-provider.js
│   ├── notes-store.js
│   ├── recall-contract.js
│   └── transcript-store.js
├── fixtures/
│   ├── notes/
│   └── rounds-fixtures.mjs
├── helpers/
│   ├── fake-provider.js
│   └── mock-fetch.js
├── integration/
│   └── memento-scenario.test.js
├── messages/
│   ├── anthropic.test.js
│   ├── canonical.test.js
│   ├── openai-normalization.test.js
│   ├── rounds.test.js
│   └── v020-alpha.test.js
├── providers/
│   ├── anthropic.test.js
│   ├── openai-stream.test.js
│   ├── openai.test.js
│   ├── v020-alpha.test.js
│   ├── v020-beta.test.js
│   └── v020-rc.test.js
├── store/
│   ├── file.test.js
│   ├── memory.test.js
│   └── v020-rc.test.js
└── tools/
    ├── providers.test.js
    ├── recall.test.js
    └── registry.test.js
```

（上图是地图，不是清单；权威目录以 `find test -name "*.js" | sort` 为准。）

## 1. v0.0（MVP）——基础路径可用

原始 MVP 覆盖仍由以下测试表示：

| 区域 | 文件 | 覆盖内容 |
|---|---|---|
| Provider 与错误 | `test/providers/openai.test.js`、`test/app-container-p0.test.js` | OpenAI 请求/响应映射、工具调用、endpoint 规范化、配置校验、错误分类、abort 行为，以及基础 Anthropic/loop 路径 |
| Canonical 消息 | `test/messages/canonical.test.js` | Canonical 转换、tool-result 顺序、工具 schema、旧版 function calls、无效响应诊断和原始协议字段 |
| Token 估算 | `test/tokens.test.js` | CJK 与非 CJK 估算、安全余量、可配置系数、消息/块成本和工具标识符 |
| 工具循环 | `test/loop.test.js` | 文本完成、工具结果反馈、`maxRounds`、stall 提示与终止、工具错误、`onToolResult`、轮次快照和 usage 累计 |
| Memory transcript store | `test/store/memory.test.js` | Memory-store 行为以及可复用的 transcript-store 契约 |

示例 E2E 覆盖已不再是单独执行 `node examples/exec-demo.test.mjs`。当前的可选集合是上方分层表中的 `examples/*.test.mjs` 命令。`examples/exec-demo.test.mjs` 仍会检查真实的多轮工具任务和压缩行为；另外两个示例文件覆盖 memory benchmark 和 provenance reproducibility。demo 的 `exec` 工具仍采用 allowlist 并受时间限制，用于示范调用方的安全责任。

## 2. v0.1（完整 FR-1/FR-2 与首批压缩策略）——行为正确

| 区域 | 文件 | 覆盖内容 |
|---|---|---|
| Anthropic 与 OpenAI 协议路径 | `test/providers/anthropic.test.js`、`test/providers/openai-stream.test.js`、`test/messages/anthropic.test.js`、`test/messages/rounds.test.js` | 非流式和 SSE 转换、流式文本与工具调用组装、usage、畸形流式输入、错误分类、受保护的消息头、工具配对和校验错误 |
| Loop 重试与完成 | `test/loop-fr2.test.js`、`test/loop-stream.test.js`、`test/loop-termination.test.js` | 可重试与不可重试错误、原始消息重试、退避上限、完成信号、无工具完成、`max_tokens` continuation、相邻 assistant 合并、流式 observer、流式重试、回退到 `chat` 和终止原因 |
| 预算与压缩 | `test/compact/budget.test.js`、`test/compact/sliding-window.test.js`、`test/compact/fold-statistical.test.js`、`test/compact/enforce-size.test.js` | 预算计算、完整轮次滑动窗口、确定性的统计折叠、有界导航与恢复 stub、受保护的头部，以及确定性的字段优先级尺寸执法 |
| Model 配置 | `test/config/static.test.js`、`test/config/env.test.js`、`test/config/api-key.test.js` | 静态和基于环境的 provider、数字和布尔解析、无效配置错误，以及直接/environment/file API-key 优先级 |

迁移验收标准仍在仓库之外：`app_container` 完成 `runToolLoop` 迁移后，其自身的 `npm test` 必须全绿。仓库测试覆盖库的行为；它们不声称度量独立的 24 轮应用对比。

## 3. v0.2（持久化、恢复、LLM 折叠、工具和 CLI 表面）——可承受中断并保持可恢复

| 区域 | 文件 | 覆盖内容 |
|---|---|---|
| Provider/message 版本回归 | `test/providers/v020-alpha.test.js`、`test/providers/v020-beta.test.js`、`test/providers/v020-rc.test.js`、`test/messages/v020-alpha.test.js` | 可选 provider payload、reasoning 和 image block、provider options、流式 reasoning/tool 事件、timeout 阶段、重试分类、transport 转发和 Anthropic system summary |
| Loop 版本回归 | `test/loop-v020.test.js`、`test/loop-v020-beta.test.js`、`test/loop-v020-rc.test.js` | 消息重新校验、continuation 压缩、snapshot 重试、结构化和位置式工具执行、完成默认值、压缩预算、checkpoint 行为和持久化失败处理 |
| Resume 与 run state | `test/loop-resume.test.js`、`test/run-state.test.js` | 恢复时不重放付费 provider 调用或已执行工具、部分工具结果、折叠 checkpoint、有界/脱敏 run state、schema 可用性、幂等替换和持久化的工具事实 |
| Store 与压缩 | `test/store/file.test.js`、`test/store/v020-rc.test.js`、`test/compact/fold-llm.test.js`、`test/compact/v020-rc.test.js` | JSONL append/load、畸形尾部和崩溃安全处理、原子 state 写入、去重、有界 recall cursor、注入的 LLM summarizer、尺寸执法、受保护轮次、全局轮次偏移和 image 清理 |
| 配置 | `test/config/json-file.test.js`、`test/config.test.js` | JSON-file slot、API-key materialization、default-slot 回退、CLI 配置路径、环境覆盖、context-window 解析和压缩上下文构建 |
| 工具 | `test/tools/providers.test.js`、`test/tools/recall.test.js`、`test/tools/registry.test.js`、`test/tools.test.js` | tool-provider 组合、recall 与折叠 payload、schema 交集和输入校验、CLI 工具执行、归档和输出限制 |
| CLI、REPL、MCP 与 skills | `test/cli.test.js`、`test/repl.test.js`、`test/mcp.test.js`、`test/skills.test.js`、`test/codewrite.test.js` | CLI/repl 参数和 session 处理、MCP stdio 与 HTTP fixtures、工具发现/调用/错误、skill 发现/加载/冲突，以及 CLI 写代码工具 |

仓库还有一个场景级测试 `test/integration/memento-scenario.test.js`。它跨 loop、tools、compaction 和 memory store，测试折叠、不可重放值、凭据排除、归档指针、重复折叠以及逐字节一致的有界 recall。

## 4. v0.3 及当前行为——判定、反思、笔记和恢复无回归

后续/当前套件由以下测试表示：

| 区域 | 文件 | 覆盖内容 |
|---|---|---|
| Judge 与 governor | `test/judge.test.js`、`test/governor.test.js` | 轮次和工具使用判定、透明拦截、方向提示、降级 judge 行为、进度/错误治理、反思请求、收尾提示和可观测的 judge 决策 |
| Reflection 与最终校验 | `test/reflection.test.js`、`test/wrapup.test.js`、`test/loop-final-guard.test.js` | 反思决策、收尾解析与循环行为、final-guard 验收/修订、provenance、重试上限、超时/错误报告和 fail-closed 校验 |
| Notes 与 capture | `test/notes.test.js`、`test/notes-autocapture.test.js`、`test/notes-final-guard.test.js`、`test/notes-experiment.test.js` | 笔记生命周期和作用域、provenance、凭据过滤、自动捕获和归档、final-guard 集成、实验规划/成本门槛、usage 摘要和可复现性报告 |
| 档案、recall 与输出卫生（ADR-015） | `test/output-hygiene.test.js`、`test/output-aggregate-budget.test.js`、`test/recall-standard.test.js`、`test/persistence-diagnostics.test.js`、`test/error-ledger.test.js`、`test/capture-honesty.test.js`、`test/compact/anchors.test.js`、`test/compact/fold-fidelity.test.js` | 引擎 recall 工具注册、bounded-recall 游标契约、输出 stub 与单轮聚合闸门、持久化诊断、重复错误记账、机械锚点、用户输入逐字保真和 capture 诚实性 |

这些是当前产品表面的测试，不是对上面按版本标记的回归文件的新替代；`npm test` 会将它们一起运行。

## 5. v1.0（消费者迁移与兼容性）

纯函数和应用行为的消费者侧迁移仍是外部验收活动。`app_container` 和 `touwaka` 应运行各自迁移后的测试，并针对共享对话 fixtures 比较压缩边界和摘要输出；这些消费者项目测试不属于本仓库的 `test/` tree。

仓库侧可复用的兼容层是 `test/contract/` 中的契约套件。它通过 `./contract-tests` 导出为 `./test/contract/index.js`，因此 MariaDB、PostgreSQL 或其他适配器都可以注册同一组 transcript-store 和 model-config-provider 断言。内置的 memory/file store 和 config provider 在测试中使用同一批 helpers。适配器特有的连接管理、清理和崩溃恢复仍属于适配器测试，而不是契约断言。导入和注册示例见 §0。

## 6. 跨领域约定

- **单元测试不调用外部服务。** 协议测试使用 `test/helpers/mock-fetch.js`；循环测试使用 `test/helpers/fake-provider.js`。MCP 覆盖使用仓库根目录 `fixtures/` 中的本地 server。
- **对确定性行为使用确定性断言。** 预算计算、统计折叠、`enforce-size`、run-state 渲染、有界 recall 以及 provenance/脱敏行为都必须精确断言。不要为本质上可变的 LLM 输出做 snapshot。
- **主动覆盖失败路径。** 错误分类、可重试性、abort、畸形数据、持久化失败、过期或被篡改的 cursor、无效工具输入以及 fail-closed 行为，都是套件的一部分，而不是事后补充。
- **保持测试状态隔离。** 触及 `~/.erix`、`~/.pi`、环境变量、sessions 或 MCP 配置的测试必须注入 `home`、`cwd`、临时目录，或恢复环境，避免使用真实用户的配置。
- **示例是集成文档。** `examples/` 程序展示调用方集成和可选的真实 relay 行为；保持可读，并使用 `LLM_KIT_E2E=1` 显式运行。
- **Node 版本范围。** `package.json` 声明 Node `>=22`。仓库 README 另行说明 `app_container` 消费者侧需要 Node 24 才能使用 `await using`；库自身的测试目标仍为 Node 22+。
- **库不提供浏览器测试层。** 终端 REPL 在 `test/repl.test.js` 中有直接覆盖，但浏览器自动化和 vision 测试不在本项目范围内。
