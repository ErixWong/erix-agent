# OpenAI Codex CLI（codex-rs）上下文与记忆机制剖析

## 0. 版本与范围

- 对象：OpenAI Codex CLI 的 Rust 实现 `codex-rs`（Cargo workspace，含 `core` / `prompts` / `skills` / `memories` / `ext` / `state` / `tools` / `context-fragments` 等 100+ 个 crate）。仓库根 `/home/eric/projects/github/codex`，HEAD=`800d183`（depth=1）。
- 路径约定：下文 `路径:行号` 一律相对仓库根；主代码在 `codex-rs/` 下。
- 阅读范围：`core/src/{session,context,context_manager,tools,prompts,compact*,agents_md*,skills,skills.rs,mcp*,exec,unified_exec}`、`context-fragments/`、`ext/{memories,skills,history-notes}/`、`memories/{read,write}/`、`state/`、`utils/{string,output-truncation}/`、`tools/`、`models-manager/models.json`、`features/src/lib.rs`。
- **必须先记住的一条**：codex 同时存在「旧路径」和「新路径」，新路径大多被 feature flag 关着。`TokenBudget`、`ContextManagement`、`RolloutBudget`、`DeferredToolWorldState`、`CodeMode` 都是 `Stage::UnderDevelopment, default_enabled:false`（`codex-rs/features/src/lib.rs:1637`、`:1643`、`:1649`、`:1367`、`:1033`），`MemoryTool` 是 Stable 但同样默认关闭（`codex-rs/features/src/lib.rs:1123`）。所以默认运行的是「AGENTS.md + 环境上下文 + 摘要式压缩」；「新窗口 + history/notes 召回 + 文件式长期记忆」需要显式开启。
- 未确认项：服务端实现（远端 compaction v2 的压缩质量、`alpha/history|notes` API 语义、模型目录下发时机）只能看到客户端契约，本文不推测。
- 证据强度：每条结论均给 `路径:行号`；查不到的写「未找到」。

## 1. 上下文构造

**① system prompt（base instructions）不是本地模板，而是模型目录产物**
- `render_model_instructions()` 取 `model_info.model_messages.instructions_template`，取不到返回空串并 warn（`codex-rs/prompts/src/model_instructions.rs:8-16`）；正文见 `codex-rs/models-manager/models.json:493`（各模型条目同字段，如 `:622`）。用户覆盖链 `model_instructions_file` → 内联 `instructions` → 默认模板，并把 provenance 标成 `Custom`（`codex-rs/core/src/config/mod.rs:3897-3905`）。
- 仓库里的 `codex-rs/core/gpt_5_codex_prompt.md` 与 `codex-rs/core/templates/model_instructions/*.md` **没有任何代码引用**（全仓 grep 只命中 `.git/index`）；它们是历史快照，勿当成运行时 prompt。

**② 请求形状决定 base instructions 落在哪个字段**
- 默认（非 responses-lite）：走 Responses API 顶层 `instructions` + `tools`，`store:false`（`codex-rs/core/src/client.rs:893-897`）；片段定义是 role=developer、无 marker、要求独立成条（`codex-rs/core/src/context/base_instructions.rs:7-28`）。
- responses-lite：改写为 input 前缀两条——`AdditionalTools`(developer) + 独立 `BaseInstructionsFragment`（`:859-890`）；前缀 id 用 `Uuid::new_v5(thread_id, 内容)`，注释明说是为「重试/恢复会话保持 identity」，即人为构造稳定前缀以命中缓存（`:861-878`）。

**③ 每轮的上下文拼装中心是 `WorldState`，section 顺序 = 插入顺序**
- 构建入口 `Session::build_world_state_for_step`（`codex-rs/core/src/session/world_state.rs:35-289`），插入顺序为 `model` → `context_window` → `context_window_guidance` → `realtime` → `agents_md` → `permissions`/`compact_permissions` → `collaboration_mode` → `persistent_mode` → `environments` → `environments_instructions` → `apps` → `plugins` → `tools` → 扩展 section → multi-agent 提示与模式 → `managed_developer_instructions`（关键行号 `:89`、`:102`、`:133`、`:147`、`:163`、`:198`、`:208`、`:228`、`:241`、`:283`、`:285`）。
- 条件性：`model` 只在模型真的变化时输出 `<model_switch>`（`codex-rs/core/src/context/world_state/model.rs:41-53`）；扩展插入的 `host_skills` 被强制前插到 `permissions` 之前（`codex-rs/core/src/context/world_state/mod.rs:322-336`）；扩展还有第二入口 `contribute_turn_context`，只在 TurnContext 变化时追加（`codex-rs/core/src/session/mod.rs:4155-4200`）。

**④ 渲染成 message 的顺序**
- `build_initial_context_with_world_state`（`codex-rs/core/src/session/mod.rs:4184`）按 role 分桶：developer 碎片合并成**一条** developer message，`requires_separate_message()` 的各自成条，user 碎片合并成一条 user message。
- push 顺序：developer bundle → 各 standalone developer → 初始 multi-agent mode → user bundle → guardian policy（仅 guardian 会话）→ managed developer instructions（`:4372-4442`）；合并逻辑见 `codex-rs/core/src/context_manager/updates.rs:12-45`，每个 content item 带 `ContentItemKind`（`codex-rs/context-fragments/src/fragment.rs:66-70`）。

**⑤ 全量上下文只注入一次，之后只发 diff（缓存友好设计的核心）**
- `record_context_updates_and_set_reference_context_item` 在 `reference_context_item == None` 时才全量注入并记录 `WorldStateItem::full(snapshot)`，否则只调 `history.update_world_state()` 产出变化片段（`codex-rs/core/src/session/mod.rs:4557-4630`，分流点 `:4568`）。
- diff 用 RFC 7386 merge patch（`codex-rs/core/src/context/world_state/mod.rs:296-320`），语义由各 section 自定——AGENTS.md 自带台词 `These AGENTS.md instructions replace all previously provided AGENTS.md instructions.`（`codex-rs/core/src/context/world_state/agents_md.rs:9-11`、`:60-75`）。
- 注释明确：这是「正常运行时路径」，mid-turn 压缩是另一条会重建 reference 的路径（`codex-rs/core/src/session/mod.rs:4545-4556`）。

**⑥ 每轮动态注入的内容**
- 环境上下文：cwd / shell / shell_version / current_date / timezone / network / filesystem（含 workspace_roots + 权限剖面）/ 子 agent 列表（`codex-rs/core/src/context/world_state/environment.rs:46-100`，渲染 `:311-380`）；多环境按 `<environment id=… primary=…>` 分组，单环境退回 legacy 扁平形态（`:236-300`）。
- 时间提醒：独立 feature `current_time_reminder`（默认 off，`codex-rs/features/src/lib.rs:1661`），按 `reminder_interval_seconds` 节流后注入 `<current_time_reminder>It is … UTC.</current_time_reminder>`（`codex-rs/core/src/session/time_reminder.rs:146-199`、`codex-rs/core/src/context/current_time_reminder.rs:29-35`）；时钟失败且开启 `NonfatalClockReadErrors` 时注入 unavailable 提示（`codex-rs/core/src/session/time_reminder.rs:100-145`）。
- **未找到** git status 注入（`collect_git_info` 只被测试与 TUI diff 展示侧引用，`codex-rs/core/src/git_info_tests.rs`）；todo/plan 也不回注：`update_plan` 只发一条 `PlanUpdate` 事件、没有对应 section（`codex-rs/core/src/tools/handlers/plan.rs:93-99`），而 `without_update_plan_instructions()` 反而会按配置删掉模型模板里的 plan 段落（`codex-rs/prompts/src/update_plan_instructions.rs:4-30`）。

**⑦ 指令文件（AGENTS.md 类）：发现 / 合并 / 截断**
- 发现：从 cwd 向上找项目根（`project_root_markers`，默认 `.git`；空列表禁用向上遍历），收集「项目根 → cwd」每层的**第一个命中文件**，按目录由浅到深拼接；同目录候选名顺序 `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`（`codex-rs/core/src/agents_md.rs:11-25`、`:264-288`、`:195-236`）。
- 合并与形态：host 注入的 user / thread instructions 排最前（`:366-398`），内部与项目片段以 `\n\n--- project-doc ---\n\n` 分隔（`:44-45`）；多环境时按 environment 打标签并省略外层 cwd 头（`:399-440`、`:466-476`）；最终注入成 role=user 的 `# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>…`（`codex-rs/core/src/context/user_instructions.rs:14-27`）。
- 截断：总预算 `project_doc_max_bytes` 默认 32 KiB（`codex-rs/config/src/config_toml.rs:74`、`codex-rs/core/src/config/mod.rs:250`），按文件顺序累减、超出部分静默 `truncate` 并 warn（`codex-rs/core/src/agents_md.rs:145-172`）。
- 信任门与刷新：项目未受信时只保留 host instructions（`:57-62`）；刷新由 `AgentsMdManager` 用 semaphore 串行化，按 (environments, trust level) 缓存（`codex-rs/core/src/agents_md_manager.rs:64-120`）。

**⑧ prompt 缓存边界**
- 显式参数 `prompt_cache_key` = 会话 id（guardian 可覆写；内部子会话用 `"<source>:<parent_thread_id>"`）（`codex-rs/core/src/client.rs:541-553`、`:934`）。
- 三道隐式边界：world-state diff 保证历史前缀不重写（见 ⑤）；WebSocket 增量续写只在「非 input 字段全等 + 有 previous_response_id」时把末尾新增 item 当 delta 发送（`:1348-1405`、`:1918-1930`）；合成 tool output 的 UUID 命名空间带注释「改这个值会改变模型可见 id 并击穿 prompt cache」（`codex-rs/core/src/context_manager/normalize.rs:18-19`）。结论：**id 稳定性被当成缓存协议的一部分**，section 级 diff 是维持前缀稳定的主要手段。

## 2. 工具输出的截断与查询

**① 默认预算与通用策略**
- 模型级默认预算来自 `truncation_policy`：本地模型目录里 9 个模型全是 `{mode:"tokens", limit:10000}`（`codex-rs/models-manager/models.json:16-19`，各模型同值见 `:185`、`:315`、`:440`）；代码里的兜底也是 10000（bytes 口径，`codex-rs/protocol/src/openai_models.rs:947`）。
- 写入历史时乘 20% 序列化余量：`with_serialization_allowance(policy) = policy * 1.2`，注释说明余量留给序列化与 header（`codex-rs/utils/output-truncation/src/lib.rs:16-19`），应用点是 `record_items_with_metadata`（`codex-rs/core/src/context_manager/history.rs:428-440`）。
- 截断算法是 **middle truncation（保头保尾、砍中间）**：预算左右各半、按 UTF-8 字符边界切、中间插标记 `…N tokens truncated…` / `…N chars truncated…`（`codex-rs/utils/string/src/truncate.rs:15-36`、`:128-136`）。
- 给模型的提示语：`formatted_truncate_text` 加三行头 `Warning: truncated output (original token count: N)\nTotal output lines: M\n\n<body>`（`codex-rs/utils/output-truncation/src/lib.rs:20-31`）。
- 内容项形态的输出（含图片/音频）走 `truncate_function_output_payload` 与 `truncate_function_output_items_with_policy`，音频 token 由调用方传入估算函数（`codex-rs/utils/output-truncation/src/lib.rs:41-70`、`:115`）。

**② exec 系（`shell` / `unified_exec` / code-mode 内 exec）单独一档**
- 进程内缓冲：字节上限 1 MiB，token 上限 = 1 MiB / 4 = 262144（`codex-rs/core/src/unified_exec/mod.rs:79-81`）。
- 保留策略用 `HeadTailBuffer`：头 50% + 尾 50%，中间丢弃并累计 `omitted_bytes`，被丢弃部分以 `... N bytes omitted ...` 标记（`codex-rs/core/src/unified_exec/head_tail_buffer.rs:5-30`、`codex-rs/core/src/unified_exec/mod.rs:229-231`）。
- 工具参数可自带上限：`exec_command.max_output_tokens` 默认 10000，schema 描述写明「larger requests may be capped by policy」（`codex-rs/core/src/tools/handlers/shell_spec.rs:59-64`）；`write_stdin` 同参数（`codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs:31`）。
- 模型可见文本 = header（Chunk ID / Wall time / exit code / session id / original token count / `Output:`）+ 被截断 body；策略取 `min(请求值, 模型 policy)`，若仍超 `with_serialization_allowance(policy)` 就**循环收紧**直到落进预算（`codex-rs/core/src/tools/context.rs:472-566`）。
- 非交互 exec 另有每次调用 10000 条输出 delta 的上限，超出不再累积（`codex-rs/core/src/exec.rs:79-83`、`:1212`；`EXEC_OUTPUT_MAX_BYTES = DEFAULT_OUTPUT_BYTES_CAP = 1 MiB`，`codex-rs/utils/pty/src/lib.rs:14`）。
- 长驻进程：返回 `chunk_id` / session id，模型可继续用 `write_stdin` 取后续输出（`codex-rs/core/src/tools/context.rs:514-538`）。
- 诊断类文本也按同一大预算截断：沙箱拒绝路径上的 stderr 片段用 `UNIFIED_EXEC_OUTPUT_MAX_TOKENS` 截断后再入库（`codex-rs/core/src/unified_exec/process.rs:307-334`）。
- code-mode 输出单独走 `resolve_max_tokens(请求值)`，默认同为 10000（`codex-rs/core/src/tools/code_mode/mod.rs:329-344`、`codex-rs/core/src/unified_exec/mod.rs:225-227`）。

**③ 其它有独立上限的位置**
- 扩展注入的 additional context 值 ≤1000 tokens（`codex-rs/context-fragments/src/additional_context.rs:6`）；long-term memory 注入碎片 ≤8.9 KB（`codex-rs/core/src/context/memory.rs:31-35`）；history-notes 的 thread hint ≤4000 bytes（`codex-rs/ext/history-notes/src/extension.rs:31`）。
- skill 元数据默认 8000 字符，或按上下文窗口 2%，或用显式值（上限 10000 tokens）（`codex-rs/ext/skills/src/render.rs:17-22`）。
- `tool_search` 的 source 描述清单上限 512 KiB（`codex-rs/core/src/tools/handlers/tool_search_spec.rs:8`）。
- 历史侧预算可被工具覆写：`CodexHarnessMetadata::history_truncation_token_limit`（覆写值被视为已含序列化余量，`codex-rs/core/src/context_manager/history.rs:434-439`）。
- tool-search 返回的工具结果进历史时另有 `truncate_assistant_output_text_to_token_budget` 处理（`codex-rs/tools/src/response_history.rs:37-65`）。

**④ 是否落盘 spill、回读路径是什么**
- **未找到 spill-to-disk。** 全仓检索 `spill` 只命中 TUI 表格渲染（`codex-rs/tui/src/markdown_render.rs`），没有「把完整输出写文件、再给模型路径」的实现。
- 回读靠「就地重取」而非文件：`ExecCommandToolOutput.raw_output` 在本次调用内仍完整，截断只在转成模型可见文本时按需发生（`codex-rs/core/src/tools/context.rs:485-487`）；进程存活时用 `write_stdin` + `max_output_tokens` 续读（`codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs:93`），或直接调大 `max_output_tokens` 重跑命令。
- 也就是说：**截断是有损的，且模型只能靠重跑来补**——没有「tail -n / 偏移读取」这种按范围回读工具（未找到）。

**⑤ 是否有全局输出预算**
- 唯一的会话级预算是 rollout budget（默认 off）：剩余额度以 `<rollout_budget>You have N weighted tokens left in the shared session token budget.</rollout_budget>` 注入（`codex-rs/core/src/context/rollout_budget.rs:6-27`），超支抛 `SessionBudgetExceeded`（`codex-rs/core/src/session/rollout_budget.rs:40-48`）。
- **没有「单轮所有工具输出合计 N token」的预算**；实际生效的只有模型级 `truncation_policy`（见 ①）。

## 3. 记忆折叠与召回

**① 触发条件（三条入口共用同一个 `run_auto_compact`）**
- 自动阈值：`auto_compact_token_limit` 默认取 `context_window * 9 / 10`（`codex-rs/protocol/src/openai_models.rs:521-532`）。
- 比对口径分 `Total` 与 `BodyAfterPrefix`（后者只算「初始前缀之后」的增量），并叠加 token-budget 的 fallback buffer 后才判定超限（`codex-rs/core/src/session/context_window.rs:60-110`，判定 `:99-110`）。
- 手动入口是 `/compact` 斜杠命令（`codex-rs/tui/src/slash_command.rs:39`、描述 `:93`）→ `CompactTask`（`codex-rs/core/src/tasks/compact.rs:28-70`）；第三条是模型变化触发的 previous-model inline compaction（`codex-rs/core/src/session/turn.rs:1247-1256`）。

**② 触发时机与变体选择**
- **pre-turn**（`codex-rs/core/src/session/turn.rs:1247-1268`）与 **mid-turn**（采样后若仍需 follow-up 且超限，`:603-636`）。
- token-budget feature 打开时走「不摘要、换新窗口」，否则按 provider 能力走远端 v2 或本地摘要（`:1424-1470`）；压缩前后各跑一次 hook，hook 可以 `Stopped` 中止本次压缩（`codex-rs/core/src/compact.rs:186-200`）。

**③ 摘要由谁生成、prompt 模板长什么样**
- 由**主模型在同一会话里**生成：把 `compact_prompt`（默认 `SUMMARIZATION_PROMPT`）作为一条 user 消息记入 history，再跑一次普通推理，取最后一条 assistant 消息当摘要（`codex-rs/core/src/compact.rs:120-134`、`:236-260`、`:354`）。
- 模板只有 9 行，要求输出：当前进度与关键决策 / 重要上下文与约束与用户偏好 / 剩余待办 / 继续所需关键数据（`codex-rs/prompts/templates/compact/prompt.md:1-9`）；恢复时前置 `SUMMARY_PREFIX` 拼成 `"{SUMMARY_PREFIX}\n{summary}"`（`codex-rs/prompts/templates/compact/summary_prefix.md`）。可用 `experimental_compact_prompt_file` / `compact_prompt` 替换（`codex-rs/core/src/config/mod.rs:3880-3884`、`:3939-3946`）。
- 若本地压缩自身撞上上下文上限，会**从头删最老的一条**再重试，注释说明「保留前缀以维持缓存、保留近期消息」（`:283-300`）。

**④ 明确保留哪些内容**
- 只保留**真实 user 消息**：harness 注入的 contextual user 片段被 `parse_user_message` 直接判为非用户消息（`codex-rs/core/src/event_mapping.rs:98-101`），摘要消息本身也被 `is_summary_message` 排除以免二次收集（`codex-rs/core/src/compact.rs:590-600`）。
- 收集方式是**从历史尾部往前累加**，总预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`，超预算的最后一条被截断后停止（`:60`、`:554-590`、`:679-720`）——「最近 N 轮」不是显式规则，而由 20k token 预算隐式决定。
- **assistant 消息、reasoning、工具调用与工具输出全部丢弃**：重建历史只 push 选中的 user 消息 + 一条 `CompactionSummary` 片段（`:666-760`）；压缩完成后发 warning「长线程和多次压缩会降低准确率，尽量新开线程」（`:400-404`）。

**⑤ 压缩后历史如何重建**
- 本地路径：`build_compacted_history` → `insert_initial_context_before_last_real_user_or_summary` → `Session::replace_compacted_history` → `ContextManager::replace_compacted`（`:301-330`、`:608-664`、`codex-rs/core/src/session/mod.rs:4019`、`codex-rs/core/src/context_manager/history.rs:566`）。
- 初始上下文插入位置规则：优先插在最后一条**真实** user 消息之前；没有真实 user 消息则插在最后一条 user-like（含摘要）之前；再退化为插在 compaction item 之前；都没有则追加（`:608-664`）。
- 设计理由写在 `InitialContextInjection` 注释里：pre-turn/手动压缩用 `DoNotInject`（替换后清 reference，下一轮再全量重注），mid-turn 必须用 `BeforeLastUserMessage`，因为模型被训练为「压缩摘要出现在历史末尾」（`:52-79`）。
- 规范化与恢复：`normalize.rs` 补齐缺失的 tool output、删孤儿 output、按 input modality 剥离图片/音频（`codex-rs/core/src/context_manager/normalize.rs:21`、`:155`、`:330`、`:381`）；resume/fork 按 rollout checkpoint 重放，恢复 history + reference context + world state baseline + window id（`codex-rs/core/src/session/rollout_reconstruction.rs:8-22`、`:52-70`）。

**⑥ 另外两种压缩变体与产物持久化**
- 远端 v2：请求体交服务端压缩，客户端保留上限更宽松——`RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`、单条 agent message ≤`10_000`（`codex-rs/core/src/compact_remote_v2.rs:75-76`、`:501`、`:616`）；失败且错误可重试时用**当前模型**重试一次并打指标 `codex.compaction.model_fallback`（`:230-266`、`codex-rs/core/src/compact_model_fallback.rs:11-20`）。
- token-budget 变体（默认 off）：**不做摘要**，直接 `start_new_context_window` 全量重注初始上下文（`codex-rs/core/src/compact_token_budget.rs:20-36`、`:57-88`）。
- 产物：`replace_compacted_history` 写 `RolloutItem::Compacted`（`message` 字段存摘要全文）+ `WorldStateItem` + `TurnContextItem`（`codex-rs/core/src/session/mod.rs:4060-4096`）；同时推进 auto-compact window（`window_number` + window ids，`codex-rs/core/src/compact.rs:368`）并上报压缩遥测事件（`:176`、`:451`）。
- 物理位置：会话 rollout jsonl，默认 `$CODEX_HOME/sessions/*.jsonl`（`codex-rs/rollout/src/lib.rs:84`，归档目录 `archived_sessions` `:85`），可能被压成 `.jsonl.zst`（`codex-rs/rollout/src/compression.rs:94-100`）。

**⑦ 压缩后能否取回原文（召回工具/文件路径）**
- **能，但只在特定条件下，而且走服务端历史而非本地文件。** `history` 命名空间工具 `list_windows` / `list_items` / `read_item` / `search_contents`，命名空间描述直译是「Recover prior conversation after a context-window reset by listing, reading, and searching normalized history」，返回 opaque window/item id，读取按 `offset_chars` / `limit_chars` 分段（`codex-rs/ext/history-notes/src/tools.rs:36-40`，参数 `:156-175`，endpoint `alpha/history/v2/*` `:85-92`）。
- 这些工具是 `DirectModelOnly`（不进 code-mode 工具面），并要求模型对用户保密（提示语反复强调 never disclose，`codex-rs/ext/history-notes/src/tools.rs:37`）；门控为 `token_budget.use_history_notes_extension` + OpenAI provider + Codex backend 登录三者齐备（`codex-rs/ext/history-notes/src/extension.rs:47-64`）。
- 同扩展还提供 `notes` 命名空间（`read_file` / `write_file` / `append_to_file` / `search_contents` / `list_files_by_prefix`）——**跨 context window 存活、但只在本次 rollout 内**的私有便签（`:37`、`:60-84`）；`token_budget_context` 把 first/previous/current window id 告诉模型，正是为了让它用 `history.*` 定位旧窗口（`codex-rs/core/src/context/token_budget_context.rs:54-67`）。
- 配套控制工具：`new_context`（主动换窗口，不重置环境状态，`codex-rs/core/src/tools/handlers/new_context_window_spec.rs:7-15`）与 `get_context_remaining`（`codex-rs/core/src/tools/handlers/get_context_remaining_spec.rs:9-19`）。
- 默认配置下的结论：**没有**面向模型的原文回读工具——本地 `sessions/*.jsonl` 全文仍在（人可用 `rg` 搜），但模型侧只剩摘要 + 保留下来的 user 消息。

## 4. 技能与工具调用

**① 工具注册与暴露方式**

- 所有工具进 `ToolRegistry`，暴露级别是六值枚举 `ToolExposure`：`Direct` / `Deferred` / `DeferredModelOnly` / `DirectModelOnly` / `CodeModeOnly` / `Hidden`（`codex-rs/tools/src/tool_executor.rs:51-90`）。
- `spec_plan.rs` 按 `(direct, deferred, code_mode)` 三元组计算最终 exposure，并允许 code-mode-only 会话把普通工具从直接工具面隐藏（`codex-rs/core/src/tools/spec_plan.rs:250-270`、`:765-775`、`:580-590`）。
- `Deferred` 的工具必须提供 search 元数据，否则不出现在初始工具表（`codex-rs/tools/src/tool_executor.rs:58-62`）。

**② 延迟加载 / 工具搜索**

- MCP 工具在 `tool_search` 可用时统一降级为 `Deferred`（`codex-rs/core/src/mcp_tool_exposure.rs:90-93`）。
- `tool_search` 用 tantivy BM25 建索引，默认返回 8 条（`TOOL_SEARCH_DEFAULT_LIMIT = 8`，`codex-rs/core/src/tools/handlers/tool_search.rs:157-164`、`:212`、`codex-rs/tools/src/tool_discovery.rs:6-7`）。
- 被 defer 的命名空间会作为 world state `tools` section 通告（`codex-rs/core/src/session/world_state.rs:236-248`），受 `DeferredToolWorldState` 控制（默认 off）。
- agent/plugin 的 MCP spec 另有硬预算：单条 8 KB、总量 64 KB，超限直接标 `Hidden`（`codex-rs/core/src/mcp_tool_exposure.rs:23-24`、`:137-141`）。

**③ 工具数量与 token 预算**

- **未找到「工具数量上限」或「工具 schema 总 token 预算」**；能做的是 defer / hidden（上文）。唯一带数字的预算是 agent/plugin MCP spec 的 8 KB / 64 KB。

**④ MCP 集成与命名空间**

- 命名空间形如 `mcp__<server>`，完整调用名 `mcp__<server>__<tool>`（`codex-rs/core/src/tools/handlers/mcp.rs:46`、`:101-106`）。
- 去前缀工具名是单独 feature `NonPrefixedMcpToolNames`（默认 off）。
- hooks 侧统一补 `mcp__` 前缀（`codex-rs/core/src/tools/handlers/mcp.rs:109-116`）。

**⑤ skill 机制：发现 / 描述注入 / 渐进式加载 / 执行**

- 发现：由 host provider 提供技能源，再按 `SkillListQuery` 过滤（`codex-rs/ext/skills/src/sources.rs:77-120`）；排序按 scope 权重 `System < Admin < Repo < User < 无` 再按名字（`codex-rs/ext/skills/src/render.rs:47-60`）。
- 描述注入：只注入「name + description + locator（或短别名路径）」，包在 `<skills_instructions>` 块里，`content_kind = skills.catalog`（`codex-rs/ext/skills/src/fragments.rs:36-59`、`codex-rs/ext/skills/src/world_state.rs:8-14`）。
- 渐进式加载协议写在同一块里：必须先完整读 `SKILL.md` 再动手，若分页则跟随 `next_cursor` 到 EOF；引用文件按 `SKILL.md` 的路由指令按需读取；**禁止把读/摘要技能说明外包给子 agent**（`codex-rs/ext/skills/src/catalog_prompt.rs:24-41`）。同时给出触发规则（用户点名或任务匹配即必须使用）与「跳过明显适用技能要说明理由」。
- 预算：目录默认取上下文窗口 2%，或显式 `skills.max_context_tokens`（上限 10000）；超预算先截断 description，再整段移除并附「Exceeded skills context budget…」警告（`codex-rs/ext/skills/src/render.rs:121-145`、`:17-26`；配置 `codex-rs/config/src/skills_config.rs:29-45`；可用 `skills.include_instructions=false` 关闭整块）。
- 因为是 world state section，技能清单只在变化时重新注入（`codex-rs/ext/skills/src/world_state.rs:80-118`）。
- 执行：技能本体是文件（`SKILL.md` + scripts/assets/references），由主 agent 读文件或调用 `skills.read` / `skills.list` 工具（非文件系统技能走工具），不经过专门的「技能运行器」（`codex-rs/ext/skills/src/tools/`）。

**⑥ 权限与审批**

- permissions 作为 world state section 注入：permission profile、approval policy、当前 exec policy 允许前缀、已批准前缀增量（`codex-rs/core/src/session/world_state.rs:141-164`；渲染 `codex-rs/prompts/src/permissions_instructions.rs`）。
- 状态用 `WorldStateHash`（fragment 的 SHA1）比较，只有指令或已批准前缀变化才重发（`codex-rs/core/src/context/world_state/permissions.rs:32-60`、`codex-rs/core/src/context/world_state/mod.rs:243-256`）。
- 相关 feature（`ExecPermissionApprovals`、`RequestPermissionsTool`）默认 off。
- 工具每次调用前跑 pre-tool-use hook、结果被接受后跑 post-tool-use hook，两条路径都在 registry 调度里（`codex-rs/core/src/tools/registry.rs:598`、`:714`）；并行/串行调度在 `codex-rs/core/src/tools/parallel.rs:44-112`。

## 5. Per-user 长期记忆

**① 是否有跨 session 记忆**

- 有。是「文件 + sqlite + 两阶段后台 LLM 流水线」，不是向量库。总体设计见 `codex-rs/memories/README.md:1-30`。
- 触发时机：root session 启动时后台触发，条件为「非 ephemeral、feature 开启、非子 agent、state DB 可用」（`codex-rs/memories/write/src/start.rs:21-40`）。

**② 存储位置与格式**

- 记忆根：`$CODEX_HOME/memories`（V1）/ `$CODEX_HOME/memories_v2`（V2，独立目录便于分别清理与回滚）（`codex-rs/memories/read/src/lib.rs:12-14`、`codex-rs/protocol/src/memory_version.rs:15-22`）。
- 目录产物：`memory_summary.md`（首行必须恰好是 `v1`，否则整文件重生成）、`MEMORY.md`（grep 用 handbook，块头 `# Task Group: <cwd/…>` + 强制 `applies_to: cwd=…`）、`raw_memories.md`（阶段 1 机械合并，临时）、`rollout_summaries/<slug>.md`、`skills/<skill>/SKILL.md`（`codex-rs/memories/write/templates/memories/stage_one_system.md`、`consolidation.md`）。
- 中间状态在 sqlite：`memories_1.sqlite` / `memories_v2_1.sqlite`（`codex-rs/state/src/sqlite.rs:31`、`:75-87`）；表 `stage1_outputs`（thread_id、raw_memory、rollout_summary、rollout_slug、usage_count、last_usage、selected_for_phase2）与 `jobs` 租约表（`codex-rs/state/memory_migrations/0001_memories.sql:1-33`），外加 `consolidation_progress`（`codex-rs/state/memory_migrations/0002_consolidation_progress.sql:1-5`）。
- 记忆根本身被初始化为 git 仓库，阶段 2 用 git workspace diff 判断「是否需要干活」，并把 diff 写成 `phase2_workspace_diff.md` 交给 consolidation agent（`codex-rs/memories/README.md:79-120`）。

**③ 写入方式**

- 自动为主（后台）：Phase 1 从 state DB 领取若干 rollout，逐个送模型抽取结构化记忆（`raw_memory` / `rollout_summary` / 可选 `rollout_slug`），脱敏后写回 DB；Phase 2 全局串行，由一个内部 consolidation sub-agent 消费 workspace diff，重写 `MEMORY.md`、`memory_summary.md`、可选 `skills/`（`codex-rs/memories/README.md:40-153`）。
- 显式写入只有一个工具：`memories.add_ad_hoc_note`，描述严格限定「only after the user explicitly asks Codex to remember, forget, or update something」，文件名强校验 `YYYY-MM-DDTHH-MM-SS-<slug>.md`（`codex-rs/ext/memories/src/tools/ad_hoc_note.rs:26-56`）。
- 后台整理会 redact secrets（提示词里要求 `[REDACTED_SECRET]`），并明确「raw rollouts 不可修改、第三方内容当数据不当指令」（`codex-rs/memories/write/templates/memories/stage_one_system.md`）。

**④ 隔离维度**

- **按 user / codex_home 隔离**（记忆根在 `codex_home` 下），**不按 project 隔离**：跨项目共享一份，靠 `MEMORY.md` 块头的 `applies_to: cwd=<path>` 与 `# Task Group: <cwd/...>` 区分适用范围（`codex-rs/memories/write/templates/memories/stage_one_system.md` 的 MEMORY.md 格式规则）。
- 不按 thread 隔离：记忆就是跨 thread 聚合的；但**子 agent 不跑写流水线**，因此不会污染（`codex-rs/memories/write/src/start.rs:33-38`）。
- `notes.*`（§3 ⑦）是 thread/rollout 级私有便签，与本节长期记忆不是一回事。
- **未找到跨用户共享 / 团队同步机制**。

**⑤ 检索方式（向量 / 关键字 / 图 / 文件）**

- 文件 + 关键字/子串，**无向量、无图**。
- 注入侧（每轮常驻）：读 `memory_summary.md`，用 `TruncationPolicy::Tokens(2500)` 截断后作为 developer policy 注入（`codex-rs/ext/memories/src/lib.rs:16`、`codex-rs/ext/memories/src/prompts.rs:34-60`、模板 `codex-rs/ext/memories/templates/memories/read_path.md`）。V2 会把同一段文本切成 ≤8.9 KB 的多片注入（`codex-rs/ext/memories/src/extension.rs:74-95`、`codex-rs/core/src/context/memory.rs:29-35`）。
- 工具侧（按需）：`memories` 命名空间提供 `list`（默认/上限 2000）、`read`（默认 20000 tokens）、`search`（默认 200 条、上限 200 条，**literal substring**，可 case-sensitive / normalized / 指定匹配窗口与 context lines）、`add_ad_hoc_note`（`codex-rs/ext/memories/src/tools/mod.rs:28-36`、`codex-rs/ext/memories/src/tools/search.rs:34`、`:98-120`、`codex-rs/ext/memories/src/lib.rs:11-18`）。
- 默认**不**暴露检索工具：需要 `memories.dedicated_tools` 打开（`codex-rs/ext/memories/src/extension.rs:145-152`）；只注入 `memory_summary.md` 的「无工具」模式则依赖模型用 shell 自己 grep。
- 注入协议的决策边界写在模板里：何时该 skip 记忆、quick pass 预算（4~6 次搜索）、记忆与验证的取舍、以及 `MEMORY.md` 优先于直接翻 rollout（`codex-rs/ext/memories/templates/memories/read_path.md:1-60`）。

## 6. 亮点、代价与可借鉴点

- 亮点 A：**「全量一次 + 之后只发 diff」的 world-state 设计**（§1 ⑤）。它把「稳定前缀」变成系统不变量：缓存友好、可审计、可回放，而且 diff 的语义由每个 section 自己定义（AGENTS.md 甚至自带「替换/失效」台词）。
- 代价 A：section 数量多（本仓库 20+），每个都要写 snapshot / render_diff / legacy matcher 三套逻辑；`codex-rs/core/src/context/world_state/` 单目录已 5000+ 行。
- 亮点 B：**每个注入片段带 `ContentItemKind` 分类**（`codex-rs/context-fragments/src/fragment.rs:66-70`），使 harness 能区分「自己注入的内容」与「真实用户消息」。压缩时「只保留真实 user 消息」正是靠它（§3 ④ 与 `codex-rs/core/src/event_mapping.rs:98-101`）。这是低成本、高杠杆的基础设施，强烈建议自研时照搬。
- 亮点 C：截断策略统一且可解释——middle truncation + 明确 warning 头 + 20% 序列化余量；exec 侧另有 head/tail 缓冲与 `bytes omitted` 标记，模型能自知「看到的是残缺的」。
- 代价 B：**压缩后原文取回默认不可用**。默认路径下工具调用记录被彻底丢弃，只有 user 消息 + 摘要活着；要「可召回」必须开 `token_budget` + history-notes 扩展，且依赖服务端 `alpha/history|notes` API（§3 ⑦）。
- 代价 C：长期记忆是「文件 + substring 检索 + 两阶段 LLM 流水线」：写入延迟高（启动后台跑）、检索弱（只有 `MEMORY.md` 的 grep 约定，没有 embedding）；换来的是可读、可 diff、可 git 回滚、用户可手改。
- 代价 D：**大量机制默认关闭**（`features/src/lib.rs` 表），读代码时必须一直对照 flag；`Stage::UnderDevelopment` 的 TokenBudget / CodeMode / DeferredToolWorldState 在生产里可能完全没跑到，抽象成本却已经付了。
- 可借鉴清单（面向自研 agent 的架构决策）：
  1. 把注入上下文做成「有类型的 section + 增量 diff」，而不是每轮重拼一个大字符串；为此值得接受 section 框架的抽象成本。
  2. 给每个注入片段打 kind 标签；压缩、回放、审计、UI 折叠都靠它。
  3. 截断必须自带「截断了多少」的可见信号，且全局统一为一种策略（middle），再给个别工具独立上限。
  4. 压缩留两种模式并显式区分：**摘要式**（保语义、丢原文）与 **reset 式 + 检索工具**（不摘要、靠 `history.*` 类工具按需召回）。选哪种取决于你能否提供「按 window/item id 检索旧历史」的接口。
  5. 长期记忆用两级结构：小摘要常驻注入（几千 token 上限）+ 大存量用工具按需检索；配合 progressive disclosure 的技能目录，别把记忆全塞进 prompt。
  6. 长期记忆按「文件 + git 基线 + workspace diff」实现增量整理，把「遗忘」表达成 diff 里的删除，比维护一套 embedding 索引更可控（代价是检索靠关键字）。
