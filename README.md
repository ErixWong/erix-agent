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

## 为什么自研（vs 现成框架）

调研结论（2026-08-29，详见 docs/research/）：

- **Vercel AI SDK**（`ai` v7）：provider 适配 + tool loop 成熟，但**上下文压缩明确不做**（官方 cookbook 让用户用 `prepareStep` 自己写）——最有价值的一半仍需自研。
- **LangChain.js / Mastra / LangGraph**：框架级抽象，两个消费项目（app_container / touwaka）都刻意不用框架。
- **oneringai 等全家桶**：形态不对（重依赖、语音/图像等无关能力）。
- **pi SDK**：交互 agent（人在环），形态与 erix 互补不竞争（详见上文定位）。

> 技术替代触发条件（接第三家非 OpenAI 兼容协议等）与项目止损线属内部决策，见 docs/。

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
├── tools/                # 【v0.2】可选工具库（subpath export）：路径牢笼/文件工具/recall/registry 参考实现（recall 由宿主按需接线）
└── loop.js        # runToolLoop  v0.0: 最小版 · v0.1: 轮内快照重试/死循环检测/完成信号/每轮压缩检查 全量
```

## 工程约束

- **零运行时依赖**、纯 ESM、Node 22+、无构建步骤
- 测试：`node --test`（app_container 侧需 Node 24 跑 `await using`，库本身 22 可测）
- 类型：JSDoc typedef（两个消费项目都是纯 JS）
- 分发：公开 npm（`erix-agent`），代码托管在 GitHub（ErixWong/erix-agent）
- 任何提交禁止 token/密钥明文

## API 说明（runToolLoop）

核心入口 `runToolLoop({ provider, executeTool, ... })`——单任务生命周期，事件流驱动（onRound/onDelta/onJudge/onEvent）。

- **完成信号**：默认启用 `completion: { signals: [], maxNoToolRounds: 3 }`（模型连续无工具轮达上限自动收尾）；传 `completion: false` 保留旧行为（end_turn 即停）。provider 重试默认关闭（`retry: false`，可选开启）。
- **确定性终稿核验（可选 `finalGuard`）**：在 `end_turn`、completion 或 `judge_done` 真正停机前调用
  `finalGuard({ finalText, messages, round, rounds, signal, termination })`。返回
  `{ action: "accept" }` 正常停机；返回 `{ action: "revise", message }` 会以独立的 user 文本消息注入
  `message` 并继续循环，最多由 `finalGuardMaxRetries`（默认 2）次。达到上限仍要求 revise 时，
  loop 保留原始 `finalText`，以 `termination.reason === "final_guard_unverified"` 停机（fail-closed），
  由宿主决定拒绝、人工复核或报告不可恢复。guard 抛错、返回非法结果或 timeout 时为保证可用性
  **fail-open 停机，但绝不视为 verified**，并发出
  `onEvent({ type: "final_guard", round, action: "error", reason })`；accept/revise/上限降级同样发出
  `final_guard` 事件。store 对未核验和 guard 异常分别记录 `unverified_error`、`guard_error`，不会写
  `succeeded`。guard 应使用 payload 的 `signal`，abort 不会被降级为 accept。
- **wrapup 收尾协议**（v0.3.3 可关）：end_turn 时模型输出 `{"done":true,"summary":"...","output":"..."}` 视为完成并展示 output/summary；解析要求 `done` 为自有 boolean 键。对自有终稿 JSON 契约的宿主（app_container 等）或自然语言对话宿主（touwaka），传 `wrapup: false` 同时关闭**指令注入 / JSON 解析 / finalText 替换 / LLM 归一化**；`ERIX_NO_WRAPUP_INSTRUCTION=1` env 运维兜底同语义（任一关即关整个协议）。不传保持默认开启，不影响既有调用方。
- **自主质量内建（judge 体系，v0.3.0）**：
  - **默认开启**：`runToolLoop` 在 `maxRounds ≥ 16` 且未显式传 `reflection` 时自动启用基础 judge（无头宿主零配置获得保护）；传 `reflection: false` 或设 `ERIX_NO_REFLECTION=1` 关闭。
  - 显式配置：`reflection: { enabled, roundJudge, judgeIntervalRound, judgeInterceptTimeoutMs, triggerRound, extensionStep, maxExtensions, maxRoundsCap, judge: { provider } }`。
  - **round judge**（end_turn 验证）：启用时每轮模型想停时独立评估，只有 judge 正常返回高置信完成（`done:true && confidence≥0.7`）才放行并产生 `judge_done`。解析失败、调用异常，或返回 `done:true` 但 `confidence<0.7` 时不产生 `judge_done`，回落既有 `completion`/`no-tool`/`end_turn` 决策，模型自报完成信号仍可能结束任务；连续失败达到上限会自动关闭 round judge。`roundJudge: false` 或 `ERIX_NO_ROUND_JUDGE=1` 关闭。审计任务基准优先级为 `runToolLoop` 的 `task` > `context.task` > 入口消息最后一条 user 文本；多轮会话宿主应传当前指令（#34）。
  - **透明劫持审计**：每 `judgeIntervalRound`（默认 5）次真实工具执行后，下一次工具调用先审计再执行——方向错（`done:false`）则不执行原工具（副作用拦截）并返回审计意见；通过则无感放行。`judgeIntercept: false` 单独关闭审计（保留 round judge）。审计失败/超时（`judgeInterceptTimeoutMs` 默认 30s）降级为直接执行原工具。
  - **direction 软提示**：judge 输出 `direction: off_track` 时不拦截（执行原工具），但附加方向提示让模型考虑换路线。
  - **观测**：每次决策 emit `onJudge`；CLI 可用 `--judge-log <path>` / `ERIX_JUDGE_LOG` 落盘 JSONL（已脱敏）。
  - **回调错误**：流式 `onDelta`/`onReasoningDelta`/`onToolCall`/`onUsage` 回调异常通过可选的 `onObserverError` 上报；未提供时记录 `console.error("Observer callback error:", error)`，不会走仅用于存储失败的 `onPersistenceError`。
- **executeTool 协议**：两种形式——位置参数 `(name, input)` 或结构化 `({ id, name, input, context, signal })`。结构化可返回 `{ success, data, duration, toolMessageId }`（loop 保留字符串结果并附加元数据）。
- **压缩预算**：从模型 `contextWindowTokens`/`maxOutputTokens` 推导；策略支持 `summaryRole`/`recoveryHint`/`protectedMessage`/`stripHistoricalImages`/`onBeforeFold`/`onAfterFold`/`stubFor`。宿主或 CLI 可注入 `stubFor(message)`，为被折叠的 `replayable: false` 工具结果保留不超过 200 字符、最多 3 个安全 `label=value` 的事实 stub；未注入时保持原有丢弃行为。凭据样值不会进入 stub。
  若保护集本身超预算，压缩会按消息顺序解除最旧 protected 消息的保护并折叠掉，保留较新的任务上下文；
  `compactionStats[].protectedDowngraded` 记录数量，CLI 会显示警告。单条 protected 消息自身超预算则以
  `invalid_budget` 明确失败，并提示提高预算或减少保护集。
- **折叠导航记录**：折叠摘要可包含替换式、有界的 `navigationRecord`，
  形如 `{ roundFrom, roundTo, artifacts: [{ id, locator, digest, status }] }`；
  最多 10 个 artifact 且最多 400 个字符，超限显式标记截断。它只用于按地址导航，
  不含工具值或凭据，也不是语义索引；`digest` 用于与归档对账。
- **调用级可重放性来源**：工具 metadata 和归档 sidecar 暴露
  `replayableSource: "declared" | "policy" | "heuristic" | "unknown"`，
  优先级为 declared > policy > heuristic > unknown。`unknown` 仍归档，但不代表
  已审计可重放，也不参与任何重跑阻断；`unknown` 不提供 `replayable` 布尔声明，
  不能把缺失声明当作安全默认值。
- **Judge 写入足迹**：`runToolLoop` 默认只把 `writeFile` 计入 `filesWritten`；宿主使用自定义写工具时显式传
  `writeToolNames: ["fs_write", "apply_patch"]`，不要依赖名称猜测。路径参数按
  `writeToolPathKeys`（默认 `["path", "file_path"]`）从前到后取第一个非空字符串，便于接入不同工具协议。
  Judge 的 `formatFiles` 会按配置后的路径显示最近写入文件。
- **TranscriptStore**：`appendRound` 按 run/round key 幂等；`store.recall(runId, fromRound?, toRound?, pattern?)` 是面向宿主/人的取数契约，不是 `runToolLoop` 默认暴露给模型的工具；宿主可从 `erix-agent/tools` 按需接入参考实现。精确取货也支持 `store.recall({ runId, fromRound, toRound, pattern, limit, cursor, maxBytes })`：在 store 读流源头按 `limit`/`maxBytes` 限制，返回 `{ text, truncated, nextCursor?, status }`，游标续取不重复；范围缺失/越界为 `unrecoverable`，数据版本变化为 `stale`。旧位置参数继续返回字符串兼容结果。该 API 不做语义搜索，也不重新暴露 CLI recall 工具，详见 [`bounded recall API`](docs/design/2026-09-14-bounded-recall-api.md)。store 可实现 `markRunState`、`saveRunState/loadRunState`、`saveCheckpoint`/`appendCheckpoint`、`loadLatestCheckpoint`；run state 只保留当前版本，resume 不重复注入。loop 在工具执行前后 checkpoint；成对提供读写的 store 在任一 checkpoint 写失败时 fail-closed（执行后失败会明确报告“工具已执行但结果未持久化”），resume 按原顺序补齐全部未完成的多工具调用。宿主的 `executeTool` 仍需按 tool id 做幂等保护，无法由 loop 保证 exactly-once。
- **provider**：`transport` 透传给 fetch 的 `dispatcher`；非法 OpenAI 工具参数用 `_truncatedArguments`（`_raw` 兼容别名）；不安全 runId 映射为 `run-<sha256 前 24 位 hex>`。

> 完整接口契约见 [docs/architecture.md](docs/architecture.md)；设计决策见 [docs/decisions/](docs/decisions/)（judge 机制 = ADR-011）。

## CLI：erix（无头 agent 的验证器 / 调试器）

`erix` 是构建在本库上、用于**验证与调试无头 agent** 的命令行入口（不是产品交付形态）：

- **入口**：`erix` 直接进交互 TUI（`erix repl` 等价）；`erix chat "<prompt>" [--stream]` 单次对话
  （`--reflection on|off` 控制自适应预算；`max-rounds >= 32` 时默认启用；终稿 provenance gate 默认关闭，
  用 `--final-guard` 或 `ERIX_FINAL_GUARD=1` 开启；`--no-final-guard` 仅为兼容 no-op 别名）
- **工具面**：readFile / rg / tree / writeFile / exec（任意路径、任意命令、git 不限）；配置归档目录后，较大的工具结果以及每次 `exec` 调用都会按本次 run 写入 `<transcriptDir>/outputs/<safeRunId>/<序号>-<toolName>.txt`（如 `001-exec.txt`），并写入带 `digest`、`locator`、`status`（`ok`/`truncated`）的 `.meta.json`；返回文本带绝对路径指引。归档目录也会写入 system prompt，便于折叠后寻回原文；折叠摘要会附带归档目录提示（recoveryHint），确保折叠后仍可寻回；需要原文时用 `readFile`/`cat` 读取归档，不要重跑命令。同一规范化命令在本次运行内重复执行时照常执行，每次结果各自归档，并在结果元数据中附 `rerunOf`（首次 round、artifactId、archivePath、digest、locator 与 `ok`/`truncated`/`missing`/`stale`/`unrecoverable` 状态）及告知文案；这不是拦截或正确性保证。归档单文件最多 1 MiB，写入失败时工具仍返回原结果并标注失败。默认不提供 agent 级 recall 工具——`store.recall()` 是面向宿主的契约方法，需要时可从 `erix-agent/tools` 自行接线——无内置安全层，见 ADR-009
- **skill 系统**：`~/.erix/skills/<id>/skill.mjs` 自描述脚本，导出 `getSkillDefinition()` 自报工具（ADR-008）；`erix skills` 查看；todo skill（跨会话任务清单，长任务拆解/划掉/恢复）
- **notes 技能（#63）**：用于记录任务中的关键事实、一次性值、决策与 artifact 引用，不是每轮日志。四个工具为 `note_take`、`note_read`、`note_list`、`note_forget`；当前只支持 `run` 作用域，记录按 key 保存当前值、最多 3 条已作废的 `superseded` 值和可见的 `folded` 遗忘计数。`note_list` 按 `relevance` 降序、再按 `updated_at` 降序输出，并支持 `minRelevance`、`tag`、`source` 筛选；输出仍受 `limit` 限制，返回 `relevance`、`source`、`tags` 元数据。自动捕获默认 relevance 为 `0.8`，旧记录缺失该字段按 `0.5` 处理。默认存储在 `~/.erix/notes/run/<safeRunId>/<safeKey>.json`（目录 `0700`、文件 `0600`），也可用 `ERIX_NOTES_DIR` 指定；run 完成后进入 `done`，到期由 janitor 转为 `revoked` 并保留墓碑。REPL 的 run scope 使用 `--session`（默认按工作目录派生），整个 REPL session 共用一个 run scope；宿主应显式传入 `__erix` scope。工具状态收敛为 `found`、`missing`、`revoked`、`invalid`、`unsupported`，模型需要早期细节时先 `note_list` 再 `note_read`。
- **auto_capture（值 + 引用）**：CLI 在 `exec` 工具执行完成时，每次非幂等命令只捕获一条有界输出摘录（最多 1000 字符）和 artifact 引用；逐行解析显式 `label=value`，任一行疑似凭据时只保存 `artifactRef`，不保存输出内容。notes 只是便利索引，最终核验不信任 notes。非幂等命令强制写 `<序号>-exec.txt` sidecar 和 `.meta.json`，元数据标明 `replayable=false` 及 `replayableSource`；未命中声明、policy 或 heuristic 的 `unknown` 仍归档但不宣称可重放，也不参与任何重跑阻断。原子写、归档权限和凭据 fail-closed 规则保持不变。
- **provenance gate 判定**：收尾时 CLI 只读取本 run `archiveDir` 下由 capture 写出的同名 `*.meta.json` manifest；notes/artifactRef 只是检索线索，不参与信任判定。manifest 必须声明 `digest/replayable/truncated/locator`，归档必须位于 archive root 内、通过 `realpath` 防符号链接逃逸、SHA-256 与磁盘内容一致，且只有 `replayable === false`、`truncated === false` 的归档才进入已知值集合。终稿按**来源契约**核验：由 manifest 建 `captures[{label,value,artifact,round,first}]`（每个 label 的**首次捕获为规范值**），终稿中锚定已知 label 的显式归属（`label=value`、`label：value`、`label 是 value`）按规则判定——等于首次捕获值直接放行；等于**后续重跑捕获值**时必须带来源（`来源=note_read:<key>` 或 `来源=归档:<文件名>`）且指向该 artifact（放行并记 `rerun_cited`），否则 revise；不对应任何捕获则 revise；找不到可比对项则 `skipped` 并警告。verification 同时输出 `verified`、`skipped`、`revised`、`rerun_cited`、`unverified`、`guard_error` 计数。
- **verification 消费契约**：宿主必须先检查 `runToolLoop` 返回的 `verification.status`，只有 `verified` 才能把 `finalText` 当作来源已核验的结果；guard 关闭时状态为 `skipped`，`skipped` **不得当作 verified**，也不得据此宣称“没有问题”。`unverified` 表示 guard 要求修订但已无法继续，`termination.reason` 为 `final_guard_unverified`，不得标记或消费为成功；`error` 表示 guard 异常/超时（默认 30 秒），为可用性会 fail-open 返回文本，但文本仍未核验，需按宿主策略人工处理；`skipped` 也用于终稿中没有可与 capture manifest 比对的显式来源归属（此时只能说明“没有可核验项”）。CLI 对 `unverified` 以退出码 2 结束，对 `error` 以不同的退出码 3 结束；`skipped` 正常退出但不会打印已核验标题。
- 需要恢复具体值时，已知 key 优先直接按 `note_read key=<key>`；不知道 key 才按 `note_list → note_read`。只有仅引用型笔记才按返回的 `artifactRef.archivePath` 与 `locator` 有界读取归档并声明核对结果，禁止遍历归档目录，不得重跑命令或凭记忆补值。归档保存原文，notes 保存短值与审计引用，两者职责不同。折叠发生时会在折叠点注入不含捕获值/key 的 `[本 run 状态]` 标记和最多 10 条的归档目录视图（文件名、命令摘要、是否不可重放；超出显示“另有 N 条”）；归档索引是导航，不是数据注入。对不可重放结果，CLI 注入的折叠 stub 仍只保留安全的最小事实。工具结果在剩余轮次不超过 2 时追加预算提示；因轮次上限、stall 或 continuation 耗尽且没有终稿时，loop 追加一次禁用工具的强制收尾（可用 `ERIX_NO_FORCED_FINAL=1` 关闭）。规范化命令再次执行时会前置告知首次安全记录与工件状态，但不会阻止本次执行；涉及本 run 捕获值的终稿应带来源（`来源=note_read:<key>` 或 `来源=归档:<文件名>`）。
- **MCP 对接**：`~/.erix/mcp.json` 标准配置，单代理工具（list/search/call/status）访问任意 MCP server（stdio + HTTP；实测 unifuncs 联网搜索、filesystem 读文件）
- **配置**：`~/.erix/config.json`（或 `$XDG_CONFIG_HOME/erix/`），env 优先；会话存档 `~/.erix/<session>.json`；todo 清单 `~/.erix/todos/`
- **流式**：repl 默认打字机；`chat --stream` 逐字输出；`--idle-timeout` 无进展自动中止；自动压缩预算（按模型窗口折叠）

> ⚠️ 安全声明：erix **不提供安全边界**。模型能读写任意文件、执行任意命令——
> 只在你自己信任的机器/沙盒里运行，别在不可信环境裸跑。

## 文档

- [docs/requirements.md](docs/requirements.md) — 需求与分期
- [docs/architecture.md](docs/architecture.md) — 接口契约与数据流
- [docs/decisions/](docs/decisions/) — 设计决策（ADR-001~013：配置/存取/压缩/反思/工具体系/工具定义分层/记忆架构/skill 系统/安全分层/judge 方向评估/引擎-模型-宿主责任边界/guard 章程）
- [docs/testing.md](docs/testing.md) — 测试方案（分层/基建/各阶段测试清单/行为指标）
- [docs/host-consumer-contract.md](docs/host-consumer-contract.md) — **宿主消费者契约**（verification、bounded recall、provenance 与重跑责任边界）
- [docs/host-upgrade-guide-v030.md](docs/host-upgrade-guide-v030.md) — **宿主升级指南（touwaka / app_container → v0.3.x）**：judge 默认开启等行为变化的应对
- [docs/maintenance-policy.md](docs/maintenance-policy.md) — 维护策略（内部：技术替代触发条件/止损线）
- [docs/research/](docs/research/) — 调研报告（记忆系统与上下文压缩外部实践，2026-08-29，ADR-007 的输入）

## 状态

- **v0.5.0（2026-09-15，准备发布）**：在 0.4.0 的宿主可见行为变更基础上，加入有界确定性 run state、
  对象式 bounded recall、重复执行结构化告知和 opt-in guard 契约；这是 minor 版本，升级前请阅读
  [宿主消费者契约](docs/host-consumer-contract.md)。
  **v0.4.0（2026-09-14）**：notes run scope 技能、工具产出归档与 provenance gate 完整落地，并在本版本内完成**记忆层瘦身**与**静默错答的结构性修复**。
  notes 记录为 `current` + 最多 3 条 `superseded` + 可见 `folded` 计数（#74 起**不再有版本链与有界历史压缩**），
  短值直接存入 `content` 并保留 `artifactRef` 审计链；`note_take` / `note_read` /
  `note_list` / `note_forget` 支持墓碑式撤销与 janitor/GC。工具归档写入
  `<transcriptDir>/outputs/<runId>/`；非幂等命令写 sidecar，同一规范化命令重跑照常执行并**前置告知首次安全记录与工件状态**，不承担拦截或正确性保证。
  终稿 provenance gate 只信任 capture manifest，采用**来源契约**：首次捕获值直接放行；后续重跑捕获值必须带可核验来源（记 `rerun_cited`）；
  无显式归属则 `skipped`。  折叠点注入不含值/key 的 `[本 run 状态]` 标记，并提供最多 10 条不含捕获值的归档目录视图；不可重放结果在 CLI 注入 stub 时保留最多 3 条安全 `label=value` 事实。
  `unverified` 记录 `unverified_error` 并由 CLI 退出码 2 表示，guard 异常/超时记录 `guard_error` 并由 CLI 退出码 3 表示。
  `runToolLoop` 的 `filesWritten` 可通过 `writeToolNames`（默认 `["writeFile"]`）和
  `writeToolPathKeys` 配置；protected 消息超预算会降级并记录 `compactionStats[].protectedDowngraded`。
- **v0.4.0 宿主接入要点**：CLI 默认关闭终稿 provenance gate；用 `--final-guard` 或 `ERIX_FINAL_GUARD=1` 开启，`--no-final-guard` 为兼容 no-op。CLI 仍可用 `--no-notes` 控制 notes（`--notes-ledger` 与 `ERIX_NOTES_LEDGER` 已移除）；需要自然语言终稿的宿主传 `wrapup: false`，或设置
  `ERIX_NO_WRAPUP_INSTRUCTION=1`。消费 loop 结果时必须区分 `verification.status`：
  `verified` 才是已核验终稿，`unverified`/`error` 分别对应退出码 2/3；`skipped` 仅表示没有可核验项。
  notes 是 pull-only 便利索引，不会自动把值注入模型上下文（折叠点的 `[本 run 状态]` 标记只含计数，不含值/key）；模型需先 `note_list` 再按 key 调用 `note_read`。
  宿主写入 scope 请显式传 `__erix`（`ERIX_RUN_ID` 已移除，仅保留 `ERIX_NOTES_DIR` 作为存储位置配置）。
- **v0.5.0 run state**：折叠时确定性 run state 以单个 marker 替换注入，不逐轮追加；store 支持
  `saveRunState/loadRunState` 的当前版本 upsert。宿主可注入 `todoStateProvider` 与
  `semanticStateProvider`，后者只提供有界、带版本的 derived 文本，过期版本显示为 `stale`。
- **v0.3.5（2026-09-12，npm 最新）**：全项目体检修复批次（#37~#45，PR #47~#56）——流式回调 retry=0 实时透传（`erix chat --stream` 与宿主 SSE 转发恢复实时增量）；
  checkpoint 执行后写失败 fail-closed（防崩溃恢复重复执行工具副作用）；resume 补执行全部 pending 工具（原只补一个致协议断裂）；
  双协议 SSE `data:` 无空格兼容、408 归 timeout 可重试、legacy `function_call` 转换、providerOptions 不再覆盖核心字段；
  file store runId 哈希命名空间隔离 + load 尾行修复 + state 原子写；repl 会话路径安全/原子写/0600 权限/Ctrl-C 中止；
  MCP 握手失败进程清理/池键隔离/HTTP id 校验；tokens 系数校验 + 工具字段计入等 8 项输入校验；round judge 降级语义文档化；新增 `onObserverError`。
  **宿主迁移注意（行为变化）**：①流式 onDelta 时机从「响应完成后批量」变为实时（依赖旧批处理时序的宿主需评估）；②checkpoint 执行后写失败现在显式 fail（宿主 executeTool 须按 tool id 幂等）；
  ③file store 不安全 runId 的映射文件名改为 `run-h-<hash>`（旧 `run-<hash>` 存档不再读取，合法 id 不受影响）；④token 估算系数非法值现在 fail-fast 抛 TypeError（原静默 NaN）；
  ⑤l0 `exitOk` 空工具结果轮次从 true 改为 false；⑥observer 回调异常改走 `onObserverError`（不再触发 onPersistenceError）。单测 473/0。
- **v0.3.4（2026-09-07）**：judge 任务简报修复（#34）——多轮会话延续宿主（touwaka 等传整段对话历史）不再拿过期任务当审计基准：
  显式 `task`/`context.task` 成为 judge/reflection/wrapup 最高权威基准（预算 1500 码点，多轮宿主应传当前任务/最新指令）；
  无显式 task 时 fallback 升级为**入口最后一条** user 文本（单任务首条=末条，行为不变）；入口快照防循环内注入（方向提示/nudge）污染；
  resume 只扫 round-0 seed 消息、无可信 seed 时**空基准宁缺勿错**（防跨 run 复现误判）；截断统一为码点语义。三轮独立复核收敛，单测 429/0。
- **v0.3.3（2026-09-06）**：wrapup 收尾协议开关化（#30/#32）——`wrapup: false` 同时关闭指令注入 / JSON 解析 / finalText 替换 / LLM 归一化；
  解析键守卫：done 必填 + 仅顶层对象（嵌套 {done} 不得绕过）。对话型宿主（touwaka）应显式传 `wrapup: false`。
- **v0.3.2（2026-09-06）**：MIT license + README 重构（无功能差异）。
- **v0.3.1（2026-09-06）**：README 定位更新到 v0.3.0 现状（无功能差异）。
- **v0.3.0（2026-09-06）**：judge 体系落地——透明劫持审计（工具中途拦截错误动作）、
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

## 发布前验证

发版前必须实跑：

```bash
LLM_KIT_E2E=1 node --test examples/*.test.mjs
```

该命令使用 relay 进行真实 E2E 验证；发布记录须注明实际模型。模型必须来自配置文件
`slots.default.model`、`LLM_KIT_MODEL` 或显式的 `ERIX_DEFAULT_MODEL`；未配置时直接报错。

批量 notes 实验不会内置模型白名单：模型来源按 `--model`、`ERIX_EXPERIMENT_MODEL`、
`--config`/`~/.erix/config.json` 的 `slots.default.model` 依次选择。运行前必须先查看成本
预览；不带 `--yes` 只 dry-run。默认 `--max-calls 40`，超过上限必须显式调高；任一模型调用
失败都会立即停止后续作业，不会切换或回退模型。

## Benchmark 验证（erix-bench / Terminal-Bench archive）

> 无头 harness（容器内驱动 + 官方判分器）跑 Terminal-Bench archive 任务；`--agent erix|pi` 对照。
> 完整报告与逐 run 数据见配套 erix-bench 仓库的 REPORT.md（本 README 只列结论）。

### 通过任务清单（reward=1，按模型）

> 注：historical-model 跑数多（早期主力、含 33 个失败对照全量）；historical-model-2 跑数少但
> 全部选难任务/翻盘任务（详见下方 judge 实证表）——通过数不可直接比模型强弱。

**historical-model：34 通过**（覆盖任务面广）

bn-fit-modify · break-filter-js-from-html · build-cython-ext · build-pmars · cancel-async-tasks · cobol-modernization · configure-git-webserver · constraints-scheduling · count-dataset-tokens · crack-7z-hash · custom-memory-heap-crash · extract-elf · financial-document-processor · fix-git · git-leak-recovery · git-multibranch · hf-model-inference · kv-store-grpc · log-summary-date-ranges · merge-diff-arc-agi-task · modernize-scientific-stack · mteb-retrieve · multi-source-data-merger · openssl-selfsigned-cert · polyglot-c-py · portfolio-optimization · prove-plus-comm · pypi-server · regex-log · reshard-c4-data · sam-cell-seg · sqlite-db-truncate · torch-tensor-parallelism · vulnerable-secret

**historical-model-2：11 通过**（低成本、能力强——近期验证主力）

adaptive-rejection-sampler · break-filter-js-from-html · build-cython-ext · build-pov-ray · cancel-async-tasks · chess-best-move · code-from-image · configure-git-webserver · db-wal-recovery · fix-code-vulnerability · password-recovery

**pi（historical-model-2 对照）：4 通过**

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

> 单测 419/415/0（2026-09-06）。judge 机制设计决策见 [ADR-011](docs/decisions/011-judge-direction.md)。

## License

MIT © 2026 ErixWong（见 [LICENSE](LICENSE)）。
