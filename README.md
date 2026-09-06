# erix-agent

**自研无头编码 agent（headless agent）**：零依赖的 LLM agent 运行时——双协议流式 + 工具循环 + 上下文压缩 + checkpoint，面向**无人值守、宿主调度**场景（app_container / touwaka 嵌入式底座）。CLI（erix）不是产品，是验证与调试器。

**定位：无头 agent。** 交付物 = 引擎 + 编程式任务入口（任务进 → 自主工具循环 → 事件出 → 可恢复），不带 UI、
不面向终端前的人。与 pi 的关系：**pi 是交互 agent（人在环，TUI/subagent/MCP 生态），erix 是无头 agent
（无人环，被平台调度）——互补，不竞争**（见「为什么是自研」）。

- **产品形态（无头运行时）**：`runToolLoop` 单任务生命周期——起、跑、停、恢复、事件流
  （onRound/onDelta/onToolCall/onUsage/onEvent）；压缩不自爆（computeBudget 谱系）；失败可分类可重试（checkpoint/resume）。
- **自主质量内建（v0.3.0 judge 体系）**：无人值守下不依赖模型自报完成——独立 judge LLM 在
  工具循环中途透明审计（副作用前拦截错误动作）+ end_turn 验证 + direction 方向软提示 + stall 防空转软纠正；
  每次 judge 决策可落盘审计（onJudge / --judge-log）。**`runToolLoop` 在 maxRounds≥16 且未显式配置时默认启用**
  （无头宿主零配置获得保护，可 `reflection:false` 关闭）。benchmark 实证：历史失败任务翻盘（见下方 Benchmark 节）。
- **边界：止于单个 agent 任务的生命周期**。多角色编排、仲裁、重试调度、任务队列是**宿主职责**
  （app_container 的 arbitrate/reaper/三角色），不吸入库——一旦承诺编排就滑向「无头 agent 平台」，
  撞 OpenAI Agent SDK / LangGraph / pi RPC 赛道，零依赖小包优势尽失。
- **CLI = 验证器，不是重点**：交互 TUI + 单次对话（`erix chat` 可作 bench 入口）；工具面全面直通
  （readFile/writeFile/rg/tree/exec，任意路径任意命令）；配置/会话/任务家目录管理（~/.erix/）。
  用途 = 开发期调试、冒烟、benchmark 入口。⚠️ 交互 repl 测的是**人机协作**，不是无头自主能力；
  「验证 agent 能力」的主体是 **erix-bench 无头 harness**（容器内驱动 + 判分器，`--agent erix|pi` 对照）。
- **生态**（可扩展，服务于无头场景）：skill 自描述协议（~/.erix/skills/*，脚本自报工具，ADR-008）+ **MCP 对接**
  （stdio + HTTP，复用标准 .mcp.json 配置）+ todo 任务管理。

> **安全边界由运行环境提供**（[ADR-009](docs/decisions/009-safety-layering.md)）：**谁用这个 agent 谁负责安全**——
> 本地跑就是你的机器（信任域），嵌入容器/沙盒场景由宿主隔离。
> CLI 不内置白名单/牢笼/确认弹窗，工具面全面直通（含写与执行）。

消费方：`app_container`（PI Agent 审计/开发链路，迁移进行中：erix-agent 替换自研 pi/ 层）、`touwaka`（AgentLoop / 对话链路）。

## 为什么是自研而不是 Vercel AI SDK / LangChain

调研结论（2026-08-29）：

- **Vercel AI SDK**（`ai` v7）：provider 适配 + tool loop 成熟，但**上下文压缩明确不做**（官方 cookbook 让用户用 `prepareStep` 自己写）。最有价值的一半仍需自研。
- **oneringai**：全家桶 agent 平台（语音/图像/MCP/22 个重依赖），形态不对。
- **LangChain.js / Mastra / LangGraph**：框架级抽象，两个消费项目都刻意不用框架。
- **pi SDK / pi**：**交互 agent**（人在环：TUI / subagent / skills / MCP / extensions 生态；SDK 可嵌入但依赖树 ~134MB、
  agent 形态自带执行、压缩为 LLM 摘要型）。**erix 与 pi 互补不竞争**：pi 面向终端前的人，erix 面向宿主调度的
  无头长任务（零依赖、executeTool 宿主注入、统计折叠零成本保底、checkpoint 重放——pi SDK 均无对应一等抽象）。

触发重估的条件（写死）：
1. **需要接第三家非 OpenAI 兼容的原生协议（Gemini native / Bedrock / Azure）时**，迁到 AI SDK 为底座。
2. **季度检视（止损线）**：连续 6-12 个月消费方仍只有 `app_container` 一家、且无新增无头场景立项 → 收缩为 `app_container` 私有 package、停止公共 npm 维护（版本与 contract-tests 移交 app_container）。

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

## v0.2.0-rc API additions

- `runToolLoop` completion is enabled by default with `{ signals: [], maxNoToolRounds: 3 }`;
  pass `completion: false` to retain immediate end-turn behavior. Provider retries remain opt-in:
  `retry: false` is the default.
- `runToolLoop` supports opt-in reflection-driven budget extensions via
  `reflection: { enabled, roundJudge, judgeIntervalRound, judgeInterceptTimeoutMs,
  triggerRound, extensionStep, maxExtensions, maxRoundsCap }`.
  When reflection is enabled, an independent round judge runs by default; set
  `roundJudge: false` or `ERIX_NO_ROUND_JUDGE=1` to disable it.
  After every `judgeIntervalRound` real tool executions, the next tool call is
  audited before execution (transparent interception); `judgeIntercept: false`
  disables the audit while keeping end-turn round judge (and vice versa with
  `roundJudge: false`). A failed or timed-out audit falls back to executing
  the original call.
  A reflection call can inject a next-step plan or stop with `truncated: false`; the
  reflection prompt itself is not added to the task transcript.
- `executeTool` accepts either the existing positional `(name, input)` form or
  `({ id, name, input, context, signal })`. The structured form may return
  `{ success, data, duration, toolMessageId }`; the loop keeps string tool-result content and
  adds metadata such as measured `duration`.
- Compaction budgets can be derived from model `contextWindowTokens` and `maxOutputTokens`.
  Strategies also accept `summaryRole`, `protectedMessage`, `stripHistoricalImages`,
  `onBeforeFold`, and `onAfterFold`.
  `TranscriptStore.appendRound` is idempotent by run/round key; stores may also implement
  `markRunState`, `saveCheckpoint`/`appendCheckpoint`, and `loadLatestCheckpoint`. The loop
  checkpoints before tool execution and replays recorded results on resume.
- Provider `transport` is forwarded to `fetch` as `dispatcher`. Malformed OpenAI tool arguments
  use canonical `_truncatedArguments`, with `_raw` retained as a compatibility alias. Unsafe file
  store run IDs map to `run-<first-24-sha256-hex>`; simple IDs are kept unchanged.

## CLI：erix（无头 agent 的验证器 / 调试器）

`erix` 是构建在本库上、用于**验证与调试无头 agent** 的命令行入口（不是产品交付形态）：

- **入口**：`erix` 直接进交互 TUI（`erix repl` 等价）；`erix chat "<prompt>" [--stream]` 单次对话
  （`--reflection on|off` 控制自适应预算；`max-rounds >= 32` 时默认启用）
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

- **v0.3.0（2026-09-06，npm 最新）**：judge 体系落地——透明劫持审计（工具中途拦截错误动作）、
  round judge（end_turn 验证）、direction 软提示（方向漂移引导）、stall 防空转软纠正（不再误杀长任务）；
  judge 决策可观测（onJudge / --judge-log 脱敏落盘）；`runToolLoop` reflection 默认开启（maxRounds≥16 无头零配置）；
  静态审计硬化（store 崩溃恢复 / checkpoint fail-closed / 输入校验）。单测 419/415/0。
  benchmark 实证：Terminal-Bench archive 多任务 reward=1，历史失败任务翻盘（db-wal-recovery 721s→88s 等，见下）。
- v0.2.0（2026-09-01）：双协议流式、FR-2 全量循环、压缩策略（自动预算折叠）、file store/recall/fold-llm、
  json-file config、CLI 交互 TUI、配置/会话持久化、skill 自描述生态（todo 任务管理）、内置工具面（读写执行）、
  流式打字机、MCP 对接（stdio + HTTP，联网搜索实测）、idle 超时。

当前里程碑：app_container 迁移收尾（阶段 1/2 完成：worker 替换 + idea 对话 SSE 真机通过）→
无头能力 benchmark（erix-bench Terminal-Bench 对照，进行中）→ 宿主持久化接线（touwaka #1116 / app_container #71）
→ 通用 sandbox 组件（独立于 agent，另立 ADR）。

## Benchmark 验证（erix-bench / Terminal-Bench archive）

> 无头 harness（容器内驱动 + 官方判分器）跑 Terminal-Bench archive 任务；`--agent erix|pi` 对照。
> 完整报告与逐 run 数据见配套 erix-bench 仓库的 REPORT.md（本 README 只列结论）。

### 通过任务清单（reward=1，按模型）

> 注：kimi-for-coding 跑数多（早期主力、含 33 个失败对照全量）；deepseek-v4-flash 跑数少但
> 全部选难任务/翻盘任务（详见下方 judge 实证表）——通过数不可直接比模型强弱。

**kimi-for-coding：34 通过**（覆盖任务面广）

bn-fit-modify · break-filter-js-from-html · build-cython-ext · build-pmars · cancel-async-tasks · cobol-modernization · configure-git-webserver · constraints-scheduling · count-dataset-tokens · crack-7z-hash · custom-memory-heap-crash · extract-elf · financial-document-processor · fix-git · git-leak-recovery · git-multibranch · hf-model-inference · kv-store-grpc · log-summary-date-ranges · merge-diff-arc-agi-task · modernize-scientific-stack · mteb-retrieve · multi-source-data-merger · openssl-selfsigned-cert · polyglot-c-py · portfolio-optimization · prove-plus-comm · pypi-server · regex-log · reshard-c4-data · sam-cell-seg · sqlite-db-truncate · torch-tensor-parallelism · vulnerable-secret

**deepseek-v4-flash：11 通过**（能力强、免费——近期验证主力）

adaptive-rejection-sampler · break-filter-js-from-html · build-cython-ext · build-pov-ray · cancel-async-tasks · chess-best-move · code-from-image · configure-git-webserver · db-wal-recovery · fix-code-vulnerability · password-recovery

**pi（deepseek-v4-flash 对照）：4 通过**

break-filter-js-from-html · build-cython-ext · build-pov-ray · distribution-search

### 透明劫持 / judge 体系实证（2026-09，erix main + PR #28/#29）

无头长任务在 judge 体系（透明劫持审计 + round judge + stall 软纠正 + direction 软提示）下的验证——
历史失败任务翻盘或首次通过，每 run 的 judge 决策全落盘可审计（erix-state/judge.log）：

| 任务 | 结果 | judge 价值证据 |
|---|---|---|
| db-wal-recovery | reward=1（88s，历史 721s 失败） | direction off_track 拦截：纯侦察阶段提示转向实际修复 |
| adaptive-rejection-sampler | reward=1（12 轮，历史 901s 超时失败） | judge 早期拦截防环境空转 |
| password-recovery | reward=1（187s，flash 首跑） | **5 次 blocked**：反复拦“未提取完整密码”的半成品提交 |
| fix-code-vulnerability | reward=1（123s，判分 6/6） | round judge 验证通过才收尾（历史 23 轮空转 reward=0） |
| cancel-async-tasks | reward=1（117s） | judge-log 观测 + 审计放行（方向对无感） |
| circuit-fibsqrt | reward=0（64 轮完整跑） | 11 次真实审计拦截记录（模型能力不足，非机制失败） |

> 单测 400/396/0（2026-09-06）。judge 机制设计决策见 [ADR-011](docs/decisions/011-judge-direction.md)。
