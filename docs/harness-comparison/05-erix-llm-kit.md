# erix-agent / erix-llm-kit 上下文与记忆机制剖析

## 0. 版本与范围

- 项目：**erix-agent**（包名 `erix-llm-kit`，`package.json` 的 `name` 为 `erix-agent`），版本 `0.5.1`（package.json:3）。
  定位是「零依赖 Node ESM 无头 agent 运行时」：引擎（`src/`）只做循环/压缩/持久化，CLI（`bin/`）是验证器与调试外壳（package.json:4）。
- 仓库根 `/home/eric/projects/erix-llm-kit`，本文基于 HEAD=`0c309e6`。ADR-015 的实现已落在 HEAD，但 ADR 正文
  `docs/decisions/015-context-hygiene-unification.md` **不在 HEAD**，只在分支 `docs-260916-01-adr015-context-hygiene`（`git show` 可读）。文中引用它时已标注。
- 工作树状态：`git status` 显示 `bin/{cli,repl,tools,final-guard}.js`、`src/loop/checkpoint-executor.js` 有**未提交**改动
  （ADR-015 Phase4「退役清理」进行中）。**本文全部行号以 HEAD 为准**；凡工作树行为与 HEAD 不同之处均标 `[工作树 Phase4]`，
  并已核对过差异内容，避免读者 checkout HEAD 后对不上号。
- 阅读范围：`src/loop/*`、`src/compact/*`、`src/store/*`、`src/tools/*`、`src/messages/*`、`src/run-state.js`、
  `src/tokens.js`、`bin/{cli,repl,tools,skills,mcp,auto-capture,assembly-root,config}.js`、`skills/notes/*`、
  `docs/decisions/00{3,5,7,8,9,10,14}.md`、`docs/host-consumer-contract.md`、`docs/design/2026-09-14-*.md`、`docs/mcp-design.md`。
- 重要分层前提（影响全部结论）：**引擎不拥有工具面**。工具定义与执行都由宿主注入（`tools` + `executeTool`，
  src/loop/orchestrator.js:388-391），因此系统提示词、指令文件、环境/git/时间注入这类「片段拼装」在引擎里几乎不存在，
  全部由宿主（此处即 CLI）负责。ADR-005（docs/decisions/005-tool-system.md:11-21）明确「契约在库里，执行在调用方」。

## 1. 上下文构造

**引擎侧拼装：只有两段。**

- 引擎唯一的系统提示词拼装是 `mainSystem = (wrapup === false ? system : system + "\n\n" + WRAPUP_INSTRUCTION)`：
  宿主给的 `system` 在前，引擎追加的收官指令在后（src/loop/orchestrator.js:764-766）。`WRAPUP_INSTRUCTION` 要求
  「不再调工具时输出 `{"done":true,"summary":...,"output":...}`」（src/loop/reflection.js:3-6）。可用 `ERIX_NO_WRAPUP_INSTRUCTION=1` 关掉（src/loop/orchestrator.js:762-763）。
- 请求体只有 `system / messages / tools / signal`（src/loop/provider-runner.js:58-63）。Anthropic 侧会把
  `messages` 中 role=system 的条目抽出来按序合并进 `request.system`（src/providers/anthropic.js:80-97），
  这给压缩摘要「以 system 角色前置」留了口子（`summaryRole: "system"`，src/compact/fold-llm.js:66-82）。

**CLI（宿主）侧拼装：一句话 + 一段工具/纪律说明 + 一段归档公告。**

- `systemPrompt = "你是 erix 编码助手，工作目录 ${cwd}。" + CLI_TOOLS_SYSTEM_PROMPT + buildArchiveNotice(...)`，
  MCP 启用时再追加一句代理工具说明（bin/cli.js:704-711；REPL 同构，bin/repl.js:424-431）。
- `CLI_TOOLS_SYSTEM_PROMPT` 是常量字符串（bin/tools.js:217-234），含「你的处境」（上下文会被折叠、你会真的忘记、
  拿到关键值立刻 `note_take`、非幂等命令不得重跑、不得凭记忆给值）与「工具纪律」。`buildArchiveNotice` 在 HEAD 上分两支：
  无 ResourceStore 时把**归档目录绝对路径**写进提示并要求「读取明确的归档文件」，有 ResourceStore 时改说「完整输出由
  ResourceStore 保存」（bin/tools.js:247-253）。`[工作树 Phase4]` 已合并为一支：「大输出已由引擎全量归档。需要早期原文时用
  `recall({ pattern: "关键词" })` 取回，捕获值用 `note_list/note_read` 读取」。

**每轮动态注入：只有 run-state 块，而且只在折叠发生的那一轮。**

- `refreshRunState({semantic, inject})` 每轮都会重建状态，但 `inject`（把渲染块塞进消息）只在
  `foldedStateChanged` 为真时置位（src/loop/orchestrator.js:1805-1810）。非折叠轮不注入任何环境块。
- 渲染内容（src/run-state.js:340-355）：`run/v/轮次/剩余/低预算`、`tools=名=调用数/失败数`、`files=`、`todo=`、`fold=折叠轮数/导航记录数/不可重放捕获数`、`termination/errors`，以及 `[run state semantic derived]` 槽位。
- 注入采用**标记替换**而非追加：按 `[run state deterministic v1] ... [/run state]` 正则替换，找不到才回落到
  「含『上下文折叠』的首个 user 文本块前插入」（src/run-state.js:357-431），因此反复折叠/resume 不会重复堆叠。
- todo 与语义槽位都是宿主回调：`todoStateProvider({runId, rounds})`（src/loop/orchestrator.js:1309-1318）、
  `semanticStateProvider({runId, state, previous})`，后者带版本；版本不一致标 `stale`（src/run-state.js:96-112）。

**指令文件 / 环境 / 时间：未找到。**

- 全仓库 **没有** AGENTS.md / CLAUDE.md 之类的指令文件发现、合并或截断逻辑（全仓 grep `AGENTS.md|CLAUDE.md` 只命中
  `docs/tasks/active/task-20260830-touwaka-full-integration/BRANCH.md:20` 的流程说明）。也 **没有** git 状态、系统时间、文件树的自动注入。
- 等价物是「任务简报」：`resolveTaskBrief` 支持宿主显式传 `task`（截 1500 字符）、`context.task`（同），否则回落到最后一条真实 user 消息并截 500 字符（src/loop/task-brief.js:3-30）；注释明确了分工：「Hosts compose explicit briefs from a task directory, README digest, and latest instruction」（src/loop/task-brief.js:25-27）。

**Prompt 缓存边界：未找到。** `src/`、`bin/` 内没有任何 `cache_control` / `prompt_cache` / 缓存断点代码；压缩与 run-state 注入都是
**原地改写历史**（把摘要插到最早真实 user 消息里，src/compact/fold-statistical.js:358-403），天然破坏「稳定前缀」——这是明确取舍而非遗漏。

## 2. 工具输出的截断与查询

**四道闸门，从工具到底层逐层收紧。**

| 层 | 位置 | 默认上限 | 超限策略 |
|---|---|---|---|
| CLI 工具返回 | bin/tools.js:18,329-334 | 4096 字符（`OUTPUT_LIMIT`） | head 截断 + `[已截断，共 N 字符]` |
| 引擎输出卫生 | src/loop/checkpoint-executor.js:148-164 | 4096 字符（可配 `outputHygiene.limit`） | 全量入档 + 上下文 stub（含 recall 配方） |
| recall 工具输出 | src/tools/recall.js:4-7,102-167 | 段 300 tok / ≤5 段 / 总 1500 tok；range 段 500 tok / 总 2000 tok；总览 500 tok | 逐段截断 + `[段截断]` / `[截断，共 N 段，offset=M 继续]` |
| store 级 bounded recall | src/store/bounded-recall.js:230-405 | `limit`/`maxBytes` 硬上限（调用方给） | 字节切片 + 不透明 `nextCursor`；单条源记录 >64 KiB 跳过并报 `record_too_large`（src/store/file.js:13） |

**各工具默认上限（CLI 内置工具）。** `readFile`：`limit` 默认 **200 行**，未读完追加 `[共 N 行，offset=X 继续]`（bin/tools.js:816-826）。
`rg`：`maxResults` 默认 **50 条**、单文件 >1 MiB 跳过（`MAX_FILE_BYTES`，bin/tools.js:16,831-852）。`tree`：**500** 条目封顶（bin/tools.js:17,890-927）。
`exec`：`maxBuffer` **1 MiB**（超限回「命令输出超过 1MB 上限」）、默认超时 120s、安装/编译类前缀 300s（bin/tools.js:21-23,305-310）。

**落盘（spill）与回读路径：两条并存。**

1. **CLI 归档（工具层）**：HEAD 上 `shouldArchive = 输出长度 > ARCHIVE_THRESHOLD(=800) || name === "exec"`（bin/tools.js:19,1002-1005），
   写入 `~/.erix/transcripts/outputs/<safeRunId>/NNN-<tool>.txt` + `.meta.json`（bin/assembly-root.js:53；archiveResult 见 bin/tools.js:480-507）；
   归档本体上限 **1 MiB**，超限只保留前缀并追加 `[归档仅保留前 1048576 字节，原始输出共 N 字节]`（bin/tools.js:519-543）。
   回读提示写死在返回里：`[完整输出已归档：<路径>（需要原始内容请用 readFile/cat 读取该路径；不要重跑命令…）]`（bin/tools.js:459-467）。
   `[工作树 Phase4]` 已把归档收窄为「仅 `exec` 且 `replayable === false`」的 capture 证据角色，并把模型侧截断/归档整体退役给引擎。
2. **引擎归档（ADR-015 Phase2）**：结果长度 > `outputHygieneLimit`（默认 4096，src/loop/orchestrator.js:511-512）时，引擎把
   **宿主最终交出的内容**（`onToolResult` 改写之后，src/loop/checkpoint-executor.js:148-150）推进 `archivedOutputs`，随 round record
   落盘为 `toolOutputs`，上下文留 stub：`[完整输出已由引擎归档（第 9 轮，共 51234 字符）。需要原文：recall({ round: 9, pattern: "关键词" })]`
   （HEAD 版：src/loop/checkpoint-executor.js:160-162；`[工作树 Phase4]` 在 `]` 前追加了「；不要重跑有副作用的命令」）。
   前提是必须有 transcript store，否则 `outputHygiene` 直接抛错（src/loop/orchestrator.js:506-510）；
   resume 时从 checkpoint 的 `toolOutputs` 回填，保证崩溃恢复后 recall 仍能兑现（src/loop/resume-manager.js:203-212）。

**截断提示语是设计资产。** 「未命中」会给替代方案（src/tools/recall.js:3）；超长单行按命中位置**居中窗口**截取，保证命中词不被下游截掉
（src/tools/recall.js:180-187,212-220）。**全局输出预算：未找到**——没有「整轮工具输出总量 ≤ X」的机制，最接近的三个软预算：
run-state 渲染块 400 字符（src/run-state.js:3,245）、judge 会话摘录 40000 tok（src/reflection/judge.js:230,274）、
guard 历史 L0+L1 累计 >4000 tok 丢最旧（src/loop/orchestrator.js:852-858）。

## 3. 记忆折叠与召回

**触发条件：纯预算驱动，每轮请求前判定，无手动命令。** `compactBeforeRound` 在调 provider 前跑（src/loop/orchestrator.js:1664-1668）：
本地估算 `estimateMessageTokens(messages) > budgetTokens`、API 上报输入超预算、或宿主策略 `shouldCompact()` 三者任一即折
（src/loop/orchestrator.js:1669-1672）。预算默认 `contextWindow - maxOutputTokens - max(2000, 10%×window)`（src/compact/budget.js:23-25），
`--compact-budget` 可覆盖（bin/cli.js:284-285）。没有「消息数」维度，也没有 `/compact` 之类的手动压缩命令（bin/repl.js:49,174-198）。

**摘要由谁生成：默认不是模型。** CLI 默认 `createFoldStatisticalStrategy`（bin/config.js:119,129,141）——摘要文本由代码拼出：
`【上下文折叠·v1·erix-9f6e2c】早期第 A–B 轮（共 N 轮）已折叠。工具足迹：name×k,…` + 可选「导航记录」JSON + 折叠 stub + 恢复提示
（src/compact/fold-statistical.js:18,281-310）。LLM 折叠 `createFoldLlmStrategy` 必须由宿主注入 `summarizer`，否则抛错
（src/compact/fold-llm.js:222-224）；其 prompt 模板固定五节——`## 阶段 / ## 已改文件 / ## 已验证项 / ## 下一步（含"已完成项禁止重做"）
/ ## 主题词面包屑`，外加「恢复提示」与「历史工具结果留痕规则：记录工具名/调用轮次/查询词/结论，内容必须来自原文」
（src/compact/fold-llm.js:15-32）。摘要自身限 `maxSummaryTokens`=800，超限按分节优先级先削后截并留 `[摘要已整体截断]`
（src/compact/fold-llm.js:47-51,100-107,187-198）。

**明确保留什么。** `keepRounds` 默认 **6**，估算量 >2× 预算时收紧到 **2** 防「刚折完又超」（src/loop/orchestrator.js:1679-1684）。
被保护消息默认是**真实 user 消息**（`protectedMessage: isRealUser`，bin/config.js:124）；保护集放不进预算时逐条降级并记
`protectedDowngraded`（src/loop/budget.js:141-150,259-274；REPL 会打警告 bin/repl.js:700-704）。`replayable: false` 的工具结果另有无损兜底：
`stubFor` 产出 ≤200 字符 stub（≤10 条）以 `[已折叠]…` 并入头部（src/compact/helpers.js:115-125,127-152）。

**压缩后如何重建、产物存哪儿。** 折叠视图 = 头部（system + 摘要块 + 真实 user 消息）+ 保留的最近 6 轮（src/compact/fold-statistical.js:489-492）；
摘要块合并进最早真实 user 消息最前部，旧摘要按 marker 合并（轮次范围取并集、工具足迹累加、stub 去重）不会一轮叠一轮
（src/compact/fold-statistical.js:312-350）；run-state 块同轮 upsert 替换（§1），`foldedThrough` 水位线推进（src/loop/orchestrator.js:1782-1785）。
导航记录是只留地址不留内容的 objects：`{roundFrom, roundTo, artifacts:[{id,locator,digest,status}]}`，≤10 条/400 字符
（src/compact/fold-statistical.js:19-20,94-157）。被折原文以 `foldedPayload` 写入当轮 round record（src/loop/orchestrator.js:2322-2326）；
transcript 每 run 一个 JSONL：`~/.erix/transcripts/<safeRunId>.jsonl`，另有 `.checkpoint.json`/`.state.json`
（src/store/file.js:43-52；内存版用 Map，src/store/memory.js:55-59）。初始消息先以 `round:0` 种子入档，否则折叠后 recall 找不到
初始历史（src/loop/resume-manager.js:241-253）。

**压缩后能否取回原文：能，这是本项目的核心卖点。** ADR-015 Phase1 让引擎**默认注册** `recall` 工具：store 有 `load()` 且 `runId` 非空
即注册，除非 `recall: false` 显式 opt-out；宿主自带同名 `recall` 定义则宿主优先、不重复注册（src/loop/orchestrator.js:483-492,516-530）。
`createRecallTool` 提供三级渐进查询（src/tools/recall.js:285-361）：`recall()` 总览（每轮一行 + `折叠水位线: A-B`，≤500 tok）→
`recall({pattern})` 首选（grep -C 式摘录，命中行居中 + 上下各 2 行，300 tok/段、≤5 段、1500 tok）→
`recall({fromRound,toRound})` 按轮取原文（500 tok/条、2000 tok）。检索语料**四路覆盖** `record.messages` + `foldedPayload`
（被折原文）+ `toolOutputs`（ADR-015 归档的全量输出）（src/tools/recall.js:22-48），store 侧同样覆盖这三类
（src/store/file.js:328-348，src/store/memory.js:103-126）。取回的是**字节保真的原文**而非摘要；底层 `store.recall({...})` 对象形式另给
不透明 `nextCursor`/`maxBytes`/`artifactRef` 与 `cursor_mismatch`/`stale`/`unrecoverable` 等机器可辨状态
（src/store/bounded-recall.js:21-27,86-90；契约见 docs/host-consumer-contract.md:247-310）。

## 4. 技能与工具调用

**工具注册与暴露：全量注入，无延迟加载、无工具搜索（本地工具）。** 宿主把 `tools: definitions[]` 与 `executeTool`
一起交给循环（src/loop/orchestrator.js:388-391），当轮请求直接带全量 schema（src/loop/provider-runner.js:61）。
`createToolRegistry` 做名字派发 + `inputSchema` 校验（缺字段/类型不符给人类可读字符串而非抛错，src/tools/registry.js:136-145），
并支持 tool provider 按 `sel.set` 选集合：static / JSON 文件 / composite 三种（src/tools/providers.js:30-147）。
provider 与代码 schema 合并是**求交而非覆盖**：`maxLength` 取更小值、overlay 不能放宽必填
（src/tools/registry.js:64-105，注释直接写「Loosening overlays are ignored: the code schema remains the security floor」）。

**引擎内置工具只有 1 个：`recall`**（§3）。它也是唯一「引擎拦截服务」的工具——同名调用被引擎截走
（src/loop/orchestrator.js:523-530），宿主同定义时让位（src/loop/orchestrator.js:518-521），
显式 `recall: true` 但缺 store/runId 会「撕票」报错而不是静默降级（src/loop/orchestrator.js:489-492）。

**工具数量与 token 预算：未找到显式预算。** 代码里没有任何「工具 schema 占多少 token」的计量或上限；只有
ADR-007 引用的外部经验「19 个精确工具优于 46 个」作为方向（docs/decisions/007-memory-architecture.md:76）。
实测量级：CLI 内置 5 个（readFile/rg/tree/writeFile/exec，bin/tools.js:147-215）+ notes skill 4 个
（skills/notes/skill.mjs:768-830）+ 可选 1 个 MCP 代理 + 引擎 1 个 recall ≈ **10-11 个**。

**MCP 集成：单一代理工具 + 命名空间 ID。** 无论配了多少 server，模型只多看到**一个** `mcp` 工具，action 为
`list|search|call|status`；`search` 是元数据检索（匹配 server/工具名/描述并回传完整 inputSchema），
`call` 支持 `mcp_<server>_<tool>` 内部 ID（按最长 server 名前缀解析，兼容含下划线的 server 名）；
server 懒启动、连接池按 (name, cwd, configPath, config) 键复用（bin/mcp.js:690-698；docs/mcp-design.md:63-80）。
MCP 返回结果也截到 4096 字符并附原始字数（docs/mcp-design.md:59）。这条设计的好处很直接：**N 个 MCP server
≈ 1 个 schema 的上下文成本**。

**Skill 机制：脚本自描述 + 全量注入 + 进程内执行。** skill = 目录 + `skill.mjs`，导出 `getSkillDefinition()`
（或 legacy `getTools()`）自报 `schema_version/skill/tools`，宿主**不维护清单**（bin/skills.js:115-139；
docs/decisions/008-skill-system.md:21-35）。发现三处：内置 `skills/`、`~/.erix/skills/`、`<cwd>/.erix/skills/`，
项目级覆盖全局同名（bin/skills.js:166-198）；entrypoint 必须相对路径且不得逃逸技能根（bin/skills.js:30-48）；
工具名与内置冲突则**报错并整体跳过该 skill**，不静默覆盖（bin/skills.js:267-278）。
**没有渐进式加载/按需 describe**：读到的 schema 全量进工具面——ADR-008 明确把「渐进披露」换成了「脚本自描述」。
执行是 `import()` 进同一进程，不做子进程隔离（docs/decisions/008-skill-system.md:45-56）。内置 `notes` skill 的
工具名被硬编码做输入过滤（只放行 schema 里声明的键，注入 `__erix` 宿主作用域，bin/skills.js:315-333）。

**权限与审批：Agent 里没有。** ADR-009 把整个安全层撤掉了：库零执行零安全规则，CLI 工具面「完全直接」，
无 jail / 白名单 / 高危确认（docs/decisions/009-safety-layering.md:7-30）。引擎里唯一的「闸门」是
§3/§4 提到的 schema 求交校验、宿主自己的 `executeTool`、以及可选的**裁判拦截**：每 N 次真实工具执行后，
judge 会审下一次调用，判定 `done === false` 时**不执行**该工具并回一条
`【审计拦截】方向可能偏: …。原工具调用未执行…`（src/loop/checkpoint-executor.js:217-227,315-331）。

## 5. Per-user 长期记忆

**结论先行：本仓库没有跨 session 的「长期记忆」层。** 唯一的持久化记忆机制是 **run 作用域**的 notes；
ADR-007 设计的 L2 episode / L3 事实 / 冷循环归档**均未实现**（docs/decisions/007-memory-architecture.md:13-31 是路线图
而非现状，第 110-119 行把 L2/L3 放在 v1.x/v2）。

- **存储位置/格式**：`~/.erix/notes/run/<safeRunId>/<key>.json`，目录 0700、文件 0600；记录含
  `key/scope/scopeRef/current/superseded(≤3)/folded/tags/relevance/state(active|done|revoked)/时间戳`
  （src/store/notes.js:14-44,157-174）。root 可用 `ERIX_NOTES_DIR` 改（skills/notes/skill.mjs:72-78）。
  transcript 侧是 `~/.erix/transcripts/<runId>.jsonl`（§3）。
- **写入方式：三种，全部显式或规则触发，无后台整理。**
  ① 模型显式调 `note_take`（skills/notes/skill.mjs:770-787，`when-to-use` 直接写在 description 里）；
  ② CLI 包装层对**不可重放**的 `exec` 自动捕获一条 pinned 笔记（`auto-<hash>` 键、正文 ≤1000 字符、
  含凭据则只存 artifact 引用），条件是命中 `NON_REPLAYABLE_COMMAND_PATTERNS`（bin/auto-capture.js:12,96-136；
  bin/tools.js:25-35）；③ run 结束时 `completeRun` + `janitor`（bin/cli.js:822-823；宽限期默认 24h，
  docs/decisions/007-memory-architecture.md:70 的原则是「主循环零写工具」，实测野外 43 轮只触发 1 次 `note_take`、
  0 次 auto-capture，见 ADR-015 草案 1.1 节）。
- **隔离维度**：实现层面**只有 run**。schema 里 `scope` 允许 `run|project|user`，但任何非 run 值都返回
  「当前阶段只支持 run 作用域」（skills/notes/skill.mjs:139-145,346-347；src/store/notes.js:97-99）。
  于是「跨 session」是否成立**完全取决于 runId 怎么取**：`erix chat` 默认用带随机后缀的 session id（每次调用都是新 run，
  bin/cli.js:524；默认值构造见 bin/repl.js:145-151），**REPL 默认用 `<cwd basename>-<hash8>`**，
  所以同一项目目录重启 REPL 能续上 notes，而 chat 逐次调用天然是全新 run——这是容易被忽略的实际行为差异。
- **检索方式：精确 key + 枚举，没有向量/关键词/图检索。** `note_read key=…`、`note_list`（只回 key/标签/元数据，
  不回全文）、`note_forget`（留墓碑）；底层是 `NotesStore.list()` 目录扫描（src/store/notes.js:302-313）。
- **注入路径**：折叠发生时，`createNotesDirectoryProvider` 把 ≤20 条 active 笔记（pinned 优先、然后按 updated_at 倒序）
  渲染成 `[notes 小抄目录]（note_read key=... 取全文）` 塞进 run-state 的 semantic 槽位；空目录返回 `undefined`
  「不装懂」（bin/cli.js:895-936；槽位容量在 ADR-015 Phase3 从 220 扩到 1200 字符、最多渲 16 行，src/run-state.js:87-88,348-351）。
  这正是「笔记是暗藏的、需要目录」而「归档输出是自标记的、不需要目录」的设计判断。
- **多用户隔离与共享**：没有 user 维度，也没有跨用户共享/隔离代码；定位是单用户信任域
  （docs/decisions/009-safety-layering.md:27-30）。并发方面实现直接声明「一 scope/一 key 单写者」，
  并发读改写会 last-write-wins，需要并发必须宿主自己串行化（src/store/notes.js:46-54；docs/host-consumer-contract.md:213-217）。
  多租户隔离只能靠 `ERIX_NOTES_DIR` / `--dir` 换目录来做。

## 6. 亮点、代价与可借鉴点

**亮点（值得抄的）**

1. **「说出口必兑现」的能力闭环**：引擎说自己注册了 `recall`，就保证 store + 工具都在自己手里；`outputHygiene`
   要求有 store 否则直接抛错（src/loop/orchestrator.js:506-510）——避免了「stub 指向一个不存在的工具」这种
   空头支票（ADR-015 草案 1.3 节把这称为「抽象失败靠巧合续命」）。对比很多框架的「截断提示写得很漂亮但取不回」，
   这是质变。
2. **stub 内嵌可照抄的配方**：`recall({ round: 9, pattern: "关键词" })；不要重跑有副作用的命令`
   （src/loop/checkpoint-executor.js:161-162）。把「该怎么取回」直接放在信息被藏掉的原地，不需要模型自己推理工具用法。
3. **摘要分节 + 优先级截断**：把摘要当结构化产物（阶段/已改文件/已验证项/下一步/主题词），预算不够时先削低价值节，
   而不是整段砍（src/compact/fold-llm.js:100-107,187-198）。「主题词面包屑」「已完成项禁止重做」两节本质上是在
   给未来的 recall 与避免返工预埋索引。
4. **反复折叠不污染**：摘要块、导航记录、stub、run-state 块全部按 marker 解析 + 合并 + 替换（src/compact/fold-statistical.js:190-226,312-350；
   src/run-state.js:357-431）。这是「压缩 N 次」的真实工程难点，很多实现第二次折就出现摘要叠摘要。
5. **不透明的 store 游标**：`nextCursor` 绑定 runId/范围/pattern/limit/maxBytes/artifactRef/数据版本，参数变了就
   `stale`/`cursor_mismatch` 而不是从错误位置续读（src/store/bounded-recall.js:1-75,243-266）。
6. **可靠通道 vs 顾问通道分离**：持久化失败无条件进 error ledger，模型可见的警告「只算建议、不算送达」
   （docs/host-consumer-contract.md:405-409）——上下文里的提示语不可信这件事被制度化了。

**代价（需警惕的）**

1. **前缀缓存基本自毁**：折叠把摘要插进最早的真实 user 消息（src/compact/fold-statistical.js:358-403），
   run-state 原地 upsert（src/run-state.js:376-431），历史中段被改写 ⇒ 任何按前缀命中的 prompt cache 在折叠轮全部失效。
   收益是「近无损 + 可审计」，代价是每折一次重算一次全量前缀。若你的 agent 依赖 prompt caching，需要重新设计
   （例如把摘要放尾部、把 run-state 放独立消息）。
2. **两套归档并存（过渡态）**：CLI 的 `ResourceStore` 文件归档（bin/tools.js:459-467，提示里仍带真实路径）与引擎
   的 `toolOutputs`（src/loop/checkpoint-executor.js:152-157）在 HEAD 上同时存在，取回词表因此有两套（readFile 路径 vs recall）。
   ADR-015 的目标是退役前者（工作树 Phase4 已开始，见 §2）。
3. **默认摘要无 LLM**：CLI 默认统计折叠，摘要里只有轮次范围 + 工具足迹 + 地址。这意味着「语义摘要」质量被外包给宿主，
   开箱即用的是**索引而非总结**。好处是零成本零漂移，坏处是模型仍需自己 recall。
4. **全局输出预算缺失**：没有「整轮工具输出总量」上限，只有单条上限 + 事后压缩。密集工具轮（例如一次并行 10 个大输出）
   仍可能在一轮内把上下文顶穿，只能靠下一轮压缩兜底。
5. **工具面全量注入、无 token 计量**：工具多了成本直接线性上涨，MCP 靠「单代理工具」化解，本地 tool/skill 没有同类机制。
6. **文档漂移**：docs/host-consumer-contract.md:437-438 仍写「semantic source text at 220 characters」，
   而代码已是 1200（src/run-state.js:87）。接入方按文档实现会低估。

**给你的架构决策清单**

- 若你的痛点是「压缩后模型找不到原文」：抄 §3 的三级 recall + §2 的 stub 配方，这是收益最直接的一组。
- 若你的痛点是「多轮折叠后摘要越来越乱」：抄 markdown marker + 合并/替换（§3），而不是追加。
- 若你依赖 prompt cache：**不要抄本项目的原地改写**，改为「折叠摘要挂在滚动尾部 + run-state 独立消息」。
- 若你要跨 session 记忆：本项目**没有**可抄的实现（notes 是 run 作用域）。但可抄它的两个判断：
  ① 主循环零写工具、记忆整理移到冷路径（docs/decisions/007-memory-architecture.md:70）；
  ② 记忆目录在**失忆点**注入，而不是每轮（bin/cli.js:895-936）。
- 若你要多租户：本项目按单用户信任域设计，隔离只能靠换目录/换 store（docs/decisions/009-safety-layering.md:27-30）。
