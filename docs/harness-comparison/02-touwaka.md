# touwaka（touwaka-mate）上下文与记忆机制剖析

## 0. 版本与范围

- 对象：touwaka-mate，Node.js（ESM + Koa + Sequelize/MySQL）多角色「专家（expert）」agent 平台。版本 `0.4.0`（`package.json:3`），分析时 git HEAD 为 `bcf8ef8`。
- 仓库根：`/home/eric/projects/touwaka`。**本文所有路径均相对该仓库根**；`data/skills/...` 为随仓库分发的内置技能目录，`apps/...` 为挂在宿主上的子应用，与本文无关。
- 范围：只剖析「上下文构造 / 工具输出截断 / 记忆折叠与召回 / 技能与工具调用 / per-user 长期记忆」五个维度。多模态图片回收、前端渲染、文档平台（OCR、向量检索、审批流）只在直接影响上述维度时点出边界。
- 宿主形态：一个进程内既跑 Koa API、又跑 AgentLoop、ToolManager、记住「专家→技能→工具」的注册表；技能代码跑在子进程（`lib/skill-runner.js`），MCP 与委派子 agent 跑在「驻留」（resident）进程里。
- 三条并行的上下文策略，由专家配置 `expert.context_strategy` 选择，默认 `full`：`full`（近期消息 + 话题摘要 + 内心独白）、`simple`（更省 token）、`minimal`（用 Psyche 工作记忆替代原始消息流）。见 `lib/context-organizer/index.js:42-68`、`lib/context-manager.js:63-70`。
- 证据强度约定：每条结论后给 `路径:行号`；查证不到的一律写「未找到 / 未确认」，不做推测填充。
- 漂移提示：`docs/design/core/context-organization-architecture.md` 有若干与当前代码不一致的描述（例如声称 full 取「全部未归档消息」），本文一律以代码为准并在相关处标注。

## 1. 上下文构造

**system prompt 的拼装顺序**：统一由 `BaseContextOrganizer.buildBaseSystemPrompt()` 定义，是一个固定有序的 section 数组，最后用 `\n\n` 连接，顺序不可配置（`lib/context-organizer/base-organizer.js:979-990`）：

1. `base_prompt`：专家 `prompt_template || system_prompt || introduction`（来自 DB 的专家人设，priority 0）；
2. `timestamp`：当前日期/时间（中国标准时间 CST/UTC+8，priority 0，`base-organizer.js:159-176`）；
3. `soul`：核心价值观 / 行为准则 / 禁忌 / 情感基调 / 说话风格（priority 0，`base-organizer.js:182-211`）；
4. `skills`：技能使用指南表 + 命名空间说明（priority **3**，超预算时最先被丢）；
5. `task_context`：任务工作空间 / 技能目录 / 对话模式三种渲染（priority 0，`base-organizer.js:284-432` 经 `workspace-view-model.js` 渲染）；
6. `topic_summaries`：历史话题摘要 + recall 使用引导（priority **1**，`base-organizer.js:505-512`）；
7. `inner_voices`：前几轮反思独白（priority **2**，`base-organizer.js:517-556`）；
8. `user_info_guidance`：缺失用户信息的引导提示（priority **3**，`base-organizer.js:548-556`）。

同一顺序在旧类 `ContextManager.buildSystemPromptWithTopics()` 里被复制了一份（`lib/context-manager.js:178-207`），但生产路径是 `ContextManager.buildContext()` → `organizer.organize()`（`lib/context-manager.js:100-108`），旧方法只作兼容。

**每轮动态注入的内容**：环境变量、git 状态、工作目录树**未找到**注入点（在 `lib/context-organizer/`、`lib/chat/`、`lib/context-manager.js` 内检索 `git` / `environment` / `branch` 无命中）。真正逐轮变化的是：

- 时间戳段（`base-organizer.js:159-176`）；
- Topic 摘要：`getTopics(userId, 10, null)`，不过滤状态、倒序取最近 10 个，再反转成正序，并在标题后附 `(ID: xxx)` 供 recall 寻址（`full-organizer.js:96,160-176`）；
- Inner Voice：最近 3 条反思独白，若评分趋势下降会额外前置「【重要提醒】最近表现有下降趋势」并附上一轮建议（`full-organizer.js:89`、`base-organizer.js:517-556,558-590`）；
- 用户信息引导：每 3 轮对话最多一次，按 `conversationCount/3 % missing.length` 轮换追问缺失字段（称呼/性别/年龄/职业/所在地，`base-organizer.js:635-676`）；
- 任务工作空间段：当前目录文件清单（只扫 `input` 目录）、`README.md` 全文、`TODO.md` 全文、权限范围说明（`lib/context-organizer/workspace-view-model.js:43-70`；文件与 README/TODO 的读取见 `lib/chat-service.js:1621-1670`）；
- 召回证据段与文档证据段（见本节末尾）。

**指令文件（AGENTS.md / CLAUDE.md 类）**：**未找到**任何发现、合并、截断机制（在 `lib/ server/ apps/ frontend/ data/` 内 `grep AGENTS.md|CLAUDE.md` 零命中）。touwaka 的等价物是三条互不重叠的路径：

1. 工作空间 `README.md` / `TODO.md` 由 `ChatService.getTaskContext()` 直接 `fs.readFile` 后塞进 task_context 段（`lib/chat-service.js:1621-1645`）——**无大小上限、无截断**，只间接受 system prompt 预算约束；
2. 技能说明 `SKILL.md` **不进 prompt**，改为工具按需读：技能模式 prompt 明示 `cat SKILL.md` 或 `read_file`（`base-organizer.js:358-362`）；
3. 专家级系统提示词存 DB 字段 `experts.system_prompt`，由运营侧配置，无文件发现逻辑。

**上下文预算与截断**：`getBudgetConfig()` 取 `maxTokens`（模型上下文，默认 128000）、`expert.context_threshold`（默认 0.7）、`systemPromptRatio`（默认 0.35），于是 `totalBudget = maxTokens*0.7`、`systemBudget = totalBudget*0.35`（`base-organizer.js:734-745`）。system prompt 超预算时按两级降级：先按 priority 从高到低**整段删除**（顺序是 3 → 2 → 1，即先砍 skills/user_info_guidance，再 inner_voices，再 topic_summaries），仍超则按 `task_context → soul → timestamp → base_prompt` 顺序做 token 级截断，最后兜底硬截断整段 prompt（`base-organizer.js:750-820`）；截断后缀固定为 `[... 内容超出上下文预算已截断 ...]`（`base-organizer.js:871-877`）。消息数组超预算时，从最旧一条起删除「非 system、非当前 user」的消息（`base-organizer.js:825-865`）。

**prompt 缓存边界**：**未找到**任何 `cache_control` / Anthropic 风格缓存分段（全仓 `grep prompt_cache|cache_control|ephemeral` 无业务命中）。`lib/chat/llm-payload-cache.js:1-15` 只是按 `user:expert` 缓存「最近一次请求 payload」供调试，不是 provider 缓存锚点。由于时间戳每轮必变，system prompt 前缀天然不稳定，系统未做任何缓存友好化处理。

**minimal 策略的 prompt 结构**（差异明显）：`basePrompt + Psyche 文本 + RECALL_USAGE_GUIDANCE + task_context + Notes 使用边界说明`（`lib/context-organizer/minimal-organizer.js:392-434`）；basePrompt 在 `ChatService.buildMinimalContext()` 里被拼上「【可用技能】清单」和一大段「文档检索优先规则/原子工具链范式」（`lib/chat-service.js:1933-1985`）。messages 只保留最近 4 轮 user/assistant + 当前消息（`minimal-organizer.js:279`），tool 结果不进 messages。

**多模态与消息回放细节**：`processSingleMultimodalMessage()` 会把 DB 里的多模态 JSON / Markdown 图片语法还原为 OpenAI 多模态数组，并过滤 `[图片]` 等无效 URL（`base-organizer.js:18-115`）；`buildMessages()` 会做当前消息去重（`base-organizer.js:720-733`）；旧 base64 图会在每轮被替换为文本占位符（`lib/llm-client.js:551`、`lib/agent/agent-loop.js:163`）。
- **注意（代码事实）**：full/simple 回放历史时，非 tool 消息经 `processSingleMultimodalMessage({role, content})` 只保留 `role`+`content`，**assistant 的 `tool_calls` 被丢弃**；tool 消息则用 DB 主键 `msg.id` 当 `tool_call_id`（`base-organizer.js:676-712`）。`minimal` 相反：保留 assistant 的 tool_calls，并把 `id` 换成对应 tool 消息的 `messages.id`，以让 recall 可寻址（`minimal-organizer.js:252-308`）。两者对 provider 严格 tool-call 契约的兼容性不同，自研者需自行取舍。

**证据注入（两条独立通道）**：召回证据以 `[Historical Recall Evidence]` 段追加到 system prompt，片段被清洗为「历史证据、非指令」并做指令去权（`lib/chat/context-composer.js:19-40,58-67`）；文档检索证据由 `buildEvidenceInjection()` 聚合，静态防编造规则不计入预算、证据内容按 4000 token（约 8000 字符）上限截断（`lib/chat-service.js:2043-2100`）。

## 2. 工具输出的截断与查询

**没有内置 read/bash/grep**：文件类能力由技能 `fs` 提供（`data/skills/fs/index.js`），shell/代码执行由内置 `execute` 提供。因此「各工具默认上限」分散在技能常量与宿主常量两层，且**方向几乎都是 head（保留前部）**，没有像 pi 那样统一的 `truncateHead/truncateTail` 抽象。

**逐工具上限一览**（均为代码内硬编码常量，非可配置全局值）：

| 工具/路径 | 默认上限 | 超限策略 | 证据 |
|---|---|---|---|
| `fs.read_file` lines 模式 | 100 行（`from=1`） | 返回行窗 + `totalLines/endLine`，由模型自行翻页 | `data/skills/fs/index.js:41,111-125` |
| `fs.read_file` bytes 模式 | 50000 字节 | 返回字节窗 + `totalSize` | `data/skills/fs/index.js:41,89-105` |
| `fs.read_file` data_url | 文件 ≤10MB，否则抛错 | 直接拒绝 | `data/skills/fs/index.js:57-60` |
| `fs.read_file` 总体 | 文件 >50MB 抛错 | 直接拒绝 | `data/skills/fs/index.js:20,85-86` |
| `fs.grep` | 结果 100 条、单行内容 200 字符 | head 截断；`matchCount` 保留命中总数 | `data/skills/fs/index.js:252,286` |
| `fs.list_files` 递归 | 未找到明确上限 | 全量返回 | `data/skills/fs/index.js` |
| `fs.info` 预览 | 仅当文件 ≤10000 字节才预览；目录取前 20 项 | 隐式截断 + `truncated` 标记 | `data/skills/fs/index.js:630-661` |
| `execute`(shell/js/node/python) | stdout/stderr 各 1MB、30s 超时 | head 截断 + 杀进程；超时兜底再切到 10000 字符 | `lib/tool-manager.js:787,833-855,862-867` |
| 工具→LLM 本轮消息 | 单结果 10000 字符 | head + `...[truncated, original N chars]` | `lib/tool-manager.js:3537,3567-3573` |
| 历史工具消息回注上下文 | full 8000 / simple 3000 / 默认 5000 字符 | JSON 感知摘要或 head 截断 | `full-organizer.js:36`、`simple-organizer.js:33`、`base-organizer.js:673,889-950` |
| `recall` 列表 snippet | 200 字符 | head + `...` | `lib/tool-manager.js:35,2082-2085` |
| `recall` 明细 | 4000 字符（`max_chars` 上限也是 4000） | head + `...[recall detail truncated]`，返回 `content_truncated` | `lib/tool-manager.js:37,2087-2104` |
| `recall` 数量 | count 默认 10、最大 50 | 参数层夹取 | `lib/tool-manager.js:33-34,2059-2067` |
| `notes_take` | 正文 4000 字符 | 工具描述层声明上限 | `lib/tool-manager.js:39,182-184` |
| 文档检索 `read_document_content` | `max_chars` 参数控制 | 截断并标记 | `lib/tool-manager.js:322-355` |

**落盘（spill）与回读路径**：工具输出**不落临时文件**，而是落库。`ChatService.saveToolMessage()` 以 5000 字符为阈值：超阈值时 `content` 只存一条「摘要 + 回读指令」，完整结果 JSON 存进同一行的 `tool_calls.result` 字段（`lib/chat-service.js:1117-1195`）。回读靠内置 `recall` 工具：`recall({mode:'messages',action:'detail',message_id})` **优先读 `tool_calls.result`**，其次才读 `content`（`lib/tool-manager.js:2571-2602`），并显式返回 `is_from_result` 与 `content_length`。
- 摘要里的提示语本身就是可执行指令：`→ 调用 recall({ mode: 'messages', action: 'detail', message_id: "..." }) 获取完整结果`（`lib/chat-service.js:1222-1227`）。
- 权限：`recall detail` 会校验 `message.user_id !== userId` 即拒绝，避免跨用户读回（`lib/tool-manager.js:2548-2559`）。

**截断时给模型的提示语**（可直接参考的设计）：

- 基础组织器对工具消息分三种情形给不同提示：JSON 数组返回 `{_truncated:true,totalItems,_hint}`；`{success,data,error}` 结构返回 `_hint: 结果已截断，原始 N 字符`；纯文本返回 `... [上下文构建时截断，原始 N 字符]`（`base-organizer.js:889-950`）；
- system prompt 段截断统一加 `[... 内容超出上下文预算已截断 ...]`（`base-organizer.js:871-877`）；
- `recall` 明细加 `...[recall detail truncated]`（`tool-manager.js:2096`）；
- 话题摘要段会主动插入 recall 使用引导，明确「这只是部分历史」（`lib/context-organizer/recall-guidance.js:1-9`，由 `base-organizer.js:505-512` 调用）。

**图片的特殊路径**：`fs.read_file(mode='data_url')` 返回的 base64 会在入库时被清理成元信息（`lib/chat-service.js:1131-1147`），在发给 LLM 前经 `injectImageUserMessages()` 转成合成的 user 多模态消息而非塞进 tool 消息（`lib/agent/agent-loop.js:411`、`lib/tool-manager.js:3537-3564`）——即图片不参与上面的字符截断，但也不留在 tool 结果里。

**全局输出预算**：**未找到**「单轮所有工具输出总量」的配额。最接近的两个闸门是：(a) 每轮消息数组总预算 `applyMessageBudget`（`base-organizer.js:825-865`）；(b) AgentLoop 每轮调用前对消息做压缩（`lib/agent/agent-loop.js:166-186`）。单条 10000 字符与历史回注 8000 字符都是**逐条**上限，N 条工具结果可线性叠加，仅靠压缩兜底。

## 3. 记忆折叠与召回

touwaka 有**三套彼此独立的折叠机制**，理解它们的触发、产物与可恢复性，是做架构决策的关键。

**机制 A：Topic 压缩（在线主路径，所有策略都跑）**。每轮保存 user 消息之后、构建上下文之前，调用一次 `memorySystem.compressContext()`（`lib/chat-service.js:540-548`，重试路径 `:729-736`）。
- **触发条件**在 `_shouldCompressActiveTopic()`：当前 active topic 消息数 ≥ `minMessages=5`，且（估算 token ≥ `maxTokens*context_threshold` 或消息数 ≥ `maxMessages=50`）；`force` 可跳过阈值（`lib/memory-system.js:564-611`）。另有旧 legacy 通道按 `topic_id IS NULL` 的消息计数，属历史数据兼容路径（`memory-system.js:412-457`）。
- **摘要由谁生成**：表达模型（`llmClient.callExpressive`，temperature 0.3）。prompt 见 `memory-system.js:1186-1250`，要求产出 `topicName`（8-15 字）/`topicDescription`（30-60 字）/`keywords`/`category`/`userProfile`/`userInfo`，并明确要求标题「便于检索」、给出好/坏例子。
- **明确保留什么**：被归档 topic 的**全部消息不删除**，只是归属旧 topic；新建一个 active topic；本轮当前 user 消息通过 `carryMessageIds` 迁移到新 topic，避免刚输入的这轮被顺手归档（`memory-system.js:636-720`；参数来自 `chat-service.js:540-546`）。
- **产物存哪**：归档 topic 行（`title/description/keywords/status='archived'/start_time/end_time/message_count`）+ 新 active topic 行；**没有独立摘要表、没有 checkpoint 文件**（`memory-system.js:660-710`）。设计文档亦确认「普通历史摘要是否独立落库仍未确认」（`docs/development/chat-memory-boundaries.md:20-30`）。

**机制 B：AgentLoop 消息折叠（长工具任务防爆窗）**。`AgentLoop` 每轮 LLM 调用前估算 messages token，超过预算就把「最早的整轮（assistant + 其后连续 tool 消息）」折叠为一条统计摘要 system 消息，保留头部任务消息与最近 N 轮完整（`agent-loop.js:166-186`；实现 `lib/agent/history-compactor.js:139-190`）。
- 默认 `budgetTokens=80000`、`keepRounds=6`，可用环境变量 `CHAT_COMPACT_BUDGET_TOKENS` / `CHAT_COMPACT_KEEP_ROUNDS` 覆盖（`history-compactor.js:36-38`）。
- token 估算偏保守：中文 0.7 token/字、JSON 0.35 token/字符、总体 ×1.05（`history-compactor.js:40-58`）。
- 折叠摘要内容是工具调用计数，并提示「如需重新查看某次执行的具体结果，可重新调用对应工具获取最新数据」（`history-compactor.js:108-146`）。这是**纯内存替换**，不写库；`llmPayload._debug` 会记录 `compacted_rounds / tokens_before_compact / tokens_after_compact`（`agent-loop.js:170-174`）。

**机制 C：Psyche 折叠（仅 `minimal` 策略）**。每轮把最近对话喂给**反思模型**（`callReflective`，独立配置，默认 `gpt-4o-mini`）生成结构化 Psyche 更新（`lib/psyche/reflection-service.js:213-260`；prompt 模板 `:300-370`，要求输出 `session_meta/methodology/key_exchange/key_decisions/pending_questions/tool_summary/topics_context/working_memory`）。
- 输入先按 `lookbackRounds=4` 轮裁剪，再按「反思模型上下文 × 85%」做滑动窗口，从最旧消息开始移除，且**最少保留 4 条**（`reflection-service.js:61-120`、`minimal-organizer.js:52-64,112`）。
- 对话来源是 `getRecentDialogTimeBoundary(32)` 定的时间窗内全部消息（`minimal-organizer.js:343-360`）。
- Psyche 自身超限（`expressiveContextSize * maxTokensRatio(0.3)` 的 80%）时按固定优先级压缩：`temp_notes` 转 Notes → 删低相关 `notes_refs`（保留 relevance>0.5、上限 10）→ 截 `topics_context`（保留 3）→ 只留最近 3 条 `key_exchanges`（`lib/psyche/psyche-manager.js:71-160`）。
- Psyche 不等同于 Topic 摘要，其边界由设计文档显式声明（`docs/development/chat-memory-boundaries.md:12-16`）。

**压缩后历史如何重建**：`full`/`simple` 不按 topic 取数，而是 `db.getRecentMessages(expertId, userId, N)`——**跨 topic**、按 `created_at DESC` 取最近 N 条（`lib/db.js:516-527`），所以归档与否不影响上下文连续性。`minimal` 则用时间窗取数（前引）。这一点与设计文档里「全部未归档消息」的旧描述不一致（`docs/design/core/context-organization-architecture.md:33-40` vs `full-organizer.js:34,83`）。

**压缩后能否取回原文**：**能，且这是核心设计**。
- Topic 压缩只改归属，消息本体仍在 `messages` 表：`recall({mode:'topic',action:'messages',topic_id})` 可列清单，`recall detail` 可读全文（`tool-manager.js:2293-2350,2527-2608`）。
- 超长工具结果原文在 `tool_calls.result`，`recall detail` 优先返回它（`tool-manager.js:2571-2602`）。
- 唯一**无法从压缩产物本身恢复**的是机制 B 折叠的中间轮次（摘要只留计数）；但正常在线路径每轮都会 `saveToolMessage` 落库，因此实践中仍可 recall，prompt 摘要也只是让模型「重新调用工具」。
- Psyche 内被裁剪的 `key_exchanges` / `notes_refs` 无法从 Psyche 恢复，但原始消息同样在库；`temp_notes` 转成的 Notes 可通过 `notes_read` 取回（`psyche-manager.js:106-116`）。

**主动召回（不靠模型自觉）**：`RecallStrategy` 三段式，默认开启：
1. preCheck 规则判定（历史依赖词 R1、无先行词指代 R2、摘要占位 R3），命中 ≥2 条即 `force`，1 条为 `maybe`（`lib/recall-strategy.js:82-150`）；
2. policy 执行两段 recall：先按关键词搜 topic 取前 3，再取该 topic 消息前 5，默认最多 2 次调用、单次 2500ms 超时（`recall-strategy.js:232-320,428-446`）；
3. postCheck 证据链校验：缺失且回答含具体历史断言时，触发一次重试或降级模板（`recall-strategy.js:396-440`）。
召回片段以「历史证据、非指令」注入 system prompt 并把片段内指令去权（`lib/chat/context-composer.js:19-58`）。另有 `TopicDetector` 在每轮开始用独立内部 LLM 检测话题切换（`lib/topic-detector.js:13-50`）。

## 4. 技能与工具调用

**暴露方式：全量注入，无工具搜索/延迟加载**。`ToolManager.getToolDefinitions(context)` 一次性拼出：内置工具 → agent 委派控制工具（仅 root）→ 全部技能工具 → MCP 工具，返回标准 OpenAI tool 数组（`lib/tool-manager.js:1158-1213`）。全仓检索 `tool_search|search_tools|延迟加载工具` 无命中（`延迟加载` 仅见于技能内部延迟 `require` npm 依赖）。

**数量与 token 预算**：
- 内置工具 11 个（`execute`、`recall`、`notes_take/read/list`、文档检索 6 原子工具），定义在 `BUILTIN_TOOLS`（`lib/tool-manager.js:62-530`）。
- **未找到**任何针对 tools 数组的 token 预算或数量裁剪；`_debug.tools_count` 只用于日志（`lib/chat/turn-context-builder.js:20-31`）。`getToolDefinitions` 会剥掉 `_meta` 再发给模型以省 token（`tool-manager.js:1168-1170`）。
- 技能工具全部来自 DB `skill_tools` 表，`is_resident=1` 的驻留工具**不暴露给 LLM**（`lib/skill-loader.js:150-170`）。

**注册与过滤**：所有能力先进入 in-process `CapabilityRegistry`（`lib/capability-registry.js:1-14`），暴露前按 `allowedRoles` 过滤（`capability-registry.js:27-48`）。
- 例如 `execute` 的 `_meta.allowedRoles=['admin','creator']`（`tool-manager.js:99-104`），普通 user 看不到该工具；
- `notes_*` 只在 `context_strategy==='minimal'` 且 `enable_notes!==false` 时才暴露（`tool-manager.js:1033-1041,1161-1174`）；
- 委派工具 `agent_delegate_start/status/result/cancel` 只在 root agent 上下文暴露（`tool-manager.js:1373-1382`、`lib/agent/agent-delegate-control-facade.js:12-17`）。

**技能（skill）机制**：技能是 `data/skills/{name}/` 目录，约定含 `SKILL.md` + `index.js`（入口导出 `execute`）。
- 工具名统一为 `${skill.mark || skill.id}__${toolName}`（`lib/skill-tool-naming.js:7-12`，分隔符 `__`）。
- system prompt 里的技能表只给「标识 → 名称 → 使用场景」，工具完整 schema 走 tools 数组，两者保持单一出处（`base-organizer.js:213-260` 的设计注释）。
- **渐进式加载**：进 prompt 的技能描述是 `skill.description`；从 SKILL.md 兜底解析出的工具描述只取**第一句**（`skill-loader.js:1027`）。SKILL.md 正文不进 prompt，而是靠「技能模式」把工作目录指向技能目录、提示模型自己 `cat SKILL.md` / `read_file`（`base-organizer.js:358-362`）。
- **发现与注册**：不存在开机自动扫描目录注册。由「技能管理专家」先读 SKILL.md、再用 `skill-manager` 技能的 `register` 写库（`data/skills/skill-manager/SKILL.md:91-125`）；服务端 `server/services/skill-registration.service.js:185-256` 注册时会重读 SKILL.md 并重建 `skill_tools` 行。
- **执行**：普通技能在子进程 `skill-runner.js` 中执行，带路径白名单与 node/python 模块白名单（`lib/skill-runner.js:124-126,186-215,310-345`），并有 CPU/内存/超时限制（`lib/skill-loader.js:33-38`：60s、128MB）。驻留技能由 `ResidentSkillManager` 常驻进程承载（`lib/resident-skill-manager.js:1-30,435-480`）。

**MCP 集成与命名空间**：MCP 走「驻留技能」`mcp-client` 代理，`ToolManager` 通过 `ResidentSkillManager.invokeByName('mcp-client','invoke',{action:'list_tools'})` 拉取工具表（`tool-manager.js:1219-1300`）。命名空间为 `mcp_{server}_{tool}`（`data/skills/mcp-client/index.js:534`），描述前缀 `[MCP/{server}]` 供模型辨识（`tool-manager.js:1283-1287`）；每次取定义都会先清空并重建 MCP 注册表（`tool-manager.js:1220-1224`）。

**权限与审批**：只有两层——角色白名单（`allowedRoles`，见上）与技能子进程沙箱（路径白名单 + 模块白名单）。**未找到**工具级人工审批、危险操作二次确认、或每工具 `allow/deny` 策略（全仓 `grep 审批|approval` 只命中文档审批流，与工具调用无关）。

**子 agent 委派**：root agent 用 `agent_delegate_start/status/result/cancel` 发起异步 child run；`capability_scope.tools` 由宿主按父子关系裁剪（`lib/chat/turn-context-builder.js:33-76`、`lib/agent/capability-scope-builder.js`），子 run 的工具集与父会话不同（`lib/agent/expert-child-scoped-tools.js`）。

## 5. Per-user 长期记忆

**跨 session 的长期记忆确实存在，但落在「话题 + 用户画像 + 消息」三张 MySQL 表上**，不是向量库：

- `topics`：`user_id`+`expert_id`+`title/description/keywords/status/message_count/start_time/end_time`（`scripts/init-database.js:273-292`）；
- `messages`：含 `topic_id` 与 `inner_voice`（JSON）列（`init-database.js:294-312`）；
- `user_profiles`：`user_id`+`expert_id` 唯一，字段 `preferred_name/introduction/background/notes/first_met/last_active`（`init-database.js:212-231`）；
- 后台 `topic-archiver` 任务每 5 分钟跑一次，每用户只保留最近 2 个 active topic，其余做归档与摘要质量检查（`server/index.js:363-372`、`lib/topic-archiver.js:1-30`）。

**隔离维度：`user_id` × `expert_id`**（没有 project/agent 维度）。
- Psyche 存储 key 为 `psyche:${userId}:${expertId}`（`lib/psyche-store/memory-store.js:8-16`），Notes key 为 `notes:${userId}:${expertId}:${key}`（`memory-store.js:60-70`）。
- Topic / user_profile 查询一律带 `expert_id + user_id`（`lib/db.js:516-527,768-786`）。
- 跨用户读取被显式拦截：`recall detail` 校验 `message.user_id !== userId` 即拒绝（`tool-manager.js:2548-2559`）。

**写入方式**：
- **自动**：Topic 压缩时表达模型产出并写 `topicName/description/keywords`，同时写 `userProfile` 背景与 `userInfo`（性别/年龄/职业/城市写 `users` 表，称呼偏好写 `user_profiles`）（`memory-system.js:1094-1100,1186-1250,237-290`）。
- **半自动**：`ReflectiveMind` 每轮反思，检测到话题偏移时**强制** topic 压缩（`lib/chat-service.js:2326-2362`）；反思结果写回该 assistant 消息的 `inner_voice` 列（`chat-service.js:2326-2340`、`memory-system.js:1361-1384`）。
- **显式工具**：`notes_take/notes_read/notes_list` 是模型主动的手抄工作记忆（`tool-manager.js:178-260`），`notes_read` 命中会滑动续期（`lib/notes/notes-manager.js:16-22`）。
- **用户画像更新只发生在带 `currentTopicId` 的 `processHistory` 路径**（`memory-system.js:1090-1100`），不是每轮压缩都写。

**存储与生命周期**：Psyche 与 Notes 默认走**进程内存**（`PSYCHE_STORE` / `NOTES_STORE` 可切 Redis，`lib/psyche-store/index.js:60-105`）。
- Psyche 默认 TTL 3600s（`psyche-store/index.js:69-71`）；Notes 默认 TTL 86400s（可用 `NOTES_TTL_SECONDS` 覆盖），超 100 条自动遗忘 10%（`lib/notes/notes-manager.js:5,93-101`）。
- 工具描述已把「可能过期、可能不跨服务重启保留」写进给模型的说明（`tool-manager.js:182-184`），并在 minimal 的 system prompt 里重申 Notes 边界（`minimal-organizer.js:423-431`）。
- 结论：**Topic / 用户画像是真正跨 session 的长期记忆；Psyche / Notes 是带 TTL 的工作记忆**，多实例或重启即丢，除非切 Redis。

**检索方式：关键字 SQL LIKE，无向量**。
- 话题检索 = `title/description/keywords` 三列 `LIKE %kw%`（`lib/db.js:768-786`）。
- `RecallStrategy` 在此之上做启发式重排：标题精确匹配 +8、包含 +5、keywords +4、description +2，再叠加消息数（≤+2）、时效（≤+2）与 active 状态（+0.5）（`lib/recall-strategy.js:157-186`）。
- 仓库里确有 embedding / vector 组件，但只服务**文档平台**（`lib/document-embedding-*.js`、`lib/vector-utils.js`）；**未找到**用于对话记忆的向量检索或图检索。

**一个明确的落差**：用户画像 `background` 被自动写入 DB，也在 `hiddenContext` 里返回（`full-organizer.js:101,130-140`、`lib/context-manager.js:572-600`），但 `buildBaseSystemPrompt` 的 section 列表**没有** user_profile 段（`base-organizer.js:979-987`），生产路径也没有别处把它拼进 prompt（`grep hiddenContext|userProfile` 在 `lib/chat-service.js` 只用于日志/透传）。即：**用户画像目前是「存而不用」**，只有「缺失信息引导」间接利用了它的字段级空缺判断。

**子 agent（child run）的记忆隔离**：委派链路把 `principal_user_id`、caller/callee、`capability_scope`、`workspace_scope` 放进 invocation metadata，子 agent 的 messages 由 `buildChildAgentRunProjection()` 生成——**只有一条 system（子 agent 人设）+ 一条 user（任务包 JSON）**（`lib/agent/child-run-projection.js:76-98`）。
- 子 run 直接调 `agent_loop.run`，**不调用 `buildContext`**，因此拿不到父会话的 topic 摘要、Inner Voice、Psyche、用户画像（`lib/agent/expert-child-agent-runner.js:120-166`）。
- 审计身份留在 metadata 而非 prompt（`child-run-projection.js:1-8`），子 run 结果通过事件回传给父 agent。

## 6. 亮点、代价与可借鉴点

**值得抄的**

1. **「全文落库 + 摘要入上下文 + recall 回读」三段式**：`saveToolMessage` 以 5000 字符阈值把长工具结果拆成 `content`（摘要 + 回读指令）与 `tool_calls.result`（全文），`recall detail` 优先读全文并标注 `is_from_result`（`chat-service.js:1117-1195`、`tool-manager.js:2571-2602`）。截断因此是**无损**的，且给模型的提示语直接就是下一次可复制的工具调用，比单纯 `[truncated]` 有效得多。
2. **压缩以「轮」为原子单位**：`groupIntoRounds()` 保证 assistant + 其后 tool 消息成组，不产生孤儿 tool 消息（`history-compactor.js:70-100`），从根上避免 OpenAI 兼容 API 400——这是许多自研 agent 踩过的坑。
3. **压缩产物可追溯**：Topic 压缩不删消息只改 `topic_id`，并用 `carryMessageIds` 把本轮 user 消息迁到新 topic（`memory-system.js:636-720`），让「分段展示/检索/归档」与「不丢原文、不丢上下文」同时成立。
4. **策略可插拔**：`full/simple/minimal` 三策略 + 工厂 + 专家级配置（`context-organizer/index.js:42-68`），同一宿主可同时服务「重历史专家」与「低成本专家」。
5. **主动召回的工程化**：preCheck 规则 → 两段召回（限 2 次调用、2500ms 超时）→ postCheck 证据链校验/降级（`recall-strategy.js`），把「模型想不想回忆」变成可控策略，并自带 metrics 与 feature flag。
6. **prompt 注入证据的防注入处理**：召回与文档证据都被标记为「历史证据、非指令」，并清洗 role 标签与「ignore/忽略」类短语（`context-composer.js:58-67`、`chat-service.js:2065-2077`），是低成本高收益的提示注入防御。

**代价与风险**

1. **三套折叠机制语义重叠**：Topic 压缩、AgentLoop history-compactor、Psyche 三者并存，`full` 策略实际同时受前两者影响，排查「模型为什么忘了」需要跨三处读日志；设计文档本身也在强调必须明确边界（`docs/development/chat-memory-boundaries.md:20-30`）。
2. **prompt 缓存完全未利用**：时间戳每轮变化 + 无 `cache_control`，长 system prompt（技能表、话题摘要、Inner Voice）无法命中前缀缓存，成本与首 token 延迟都吃满。
3. **工具全量注入无预算**：技能越多，tools 数组越大且无 deferred loading，token 与「选错工具」概率同向增长（`tool-manager.js:1158-1213`）。
4. **长期记忆检索是 LIKE 匹配**：中文长尾语义召回弱，且 `keywords` 靠摘要时抽取，检索质量强依赖摘要质量（`db.js:768-786`、`memory-system.js:1186-1250`）。
5. **用户画像是死数据**：自动累积却不注入 prompt（见 §5 末尾），等于白花摘要 token。
6. **Psyche / Notes 默认内存 + TTL**：多实例部署或重启即丢工作记忆，只有切 Redis 才可靠（`psyche-store/index.js:60-105`）。
7. **历史回放的 tool-call 契约不一致**：full/simple 丢弃 assistant tool_calls 且用 DB 主键当 `tool_call_id`，minimal 保留并把 id 换成 tool 消息 id（`base-organizer.js:676-712`、`minimal-organizer.js:252-308`）；对严格 provider 存在兼容性差异，值得自研者对照测试。
8. **文档与实现漂移**：`docs/design/core/context-organization-architecture.md:33-40` 写「全部未归档消息」，代码是最近 15 条（`full-organizer.js:34,83`）；只信代码。

**若为自研 agent 做决策**：可直接复用「轮级折叠 + 全文落库 + recall 回读 + 摘要内嵌回读指令」这组低成本高收益组合；长期记忆不必一上来就上向量库，touwaka 证明「Topic 分段（用户可读）+ 关键字检索 + 用户画像」在结构化场景下够用——但要记得把用户画像真正注入 prompt，并从一开始就设计 prompt 前缀的稳定性（把时间戳等易变段后置/剥离），以便吃到 provider 缓存。
