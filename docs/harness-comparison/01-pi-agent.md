# pi 上下文与记忆机制剖析

## 0. 版本与范围

- 对象：`@earendil-works/pi-coding-agent`，包版本 `0.84.2`（包根 `package.json` 第 3 行）。形态是 TypeScript → `dist/*.js` 编译产物（可读），同目录 `docs/*.md` 为官方文档。
- 包根：`/home/eric/.npm-global/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent`。**本文所有 `dist/...`、`docs/...`、`examples/...` 路径均相对该包根**；少量越界引用（`../pi-ai/...`）会显式标注为「包外依赖」。
- 范围：只分析 pi-coding-agent 自身。**不含**外层 web harness（`@agegr/pi-web`）与 `pi-ai` / `pi-agent-core` / `pi-tui` 的内部实现（越界处会点明）。
- 读这份文档需要先知道的一个总纲：pi 的哲学是「小内核 + 扩展 / 技能 / 模板 / 包」（`docs/usage.md:298-302`），并且明确声明**不内置** MCP、子 agent、权限弹窗、plan mode、TODO、后台 bash（`docs/usage.md:304`）。这条声明解释了后面五个维度里大量「pi 没做，但留了钩子」的现象。
- 证据强度：每条结论后给 `路径:行号`。查证不到的一律写「未找到 / 未确认」，不做推测填充；文档与实现不一致处会并列写出（见 §3 的 `retainedTail`）。

一页速查（细节见各维度）：

| 维度 | pi 的答案 | 关键证据 |
|---|---|---|
| 上下文构造 | system prompt 纯字符串拼接 + 逐层 AGENTS.md；**每轮无动态注入** | `dist/core/system-prompt.js:7-109`、`dist/core/resource-loader.js:86-107` |
| 工具输出 | 2000 行 / 50KB「先到先算」；bash 落盘并把路径回给模型 | `dist/core/tools/truncate.js:10-11`、`dist/core/tools/bash.js:305-317` |
| 记忆折叠 | 用当前会话模型生成结构化摘要 + 保留最近 ~20k token 原文 + 累积文件账本 | `dist/core/compaction/compaction.js:74-78,308-352` |
| 工具与技能 | 7 个内置工具全量注入；扩展可做延迟加载；**无内置 MCP** | `dist/core/tools/index.js:17`、`docs/usage.md:304` |
| 长期记忆 | **无内置**；靠分层 AGENTS.md + session JSONL + 扩展自留文件 | `dist/core/resource-loader.js:31-51`、`docs/session-format.md:5-9` |

## 1. 上下文构造

**system prompt 是纯字符串拼接，顺序固定**（`dist/core/system-prompt.js:7-109`）。默认模板的拼装顺序为：

1. 固定头部：角色文案（"You are an expert coding assistant operating inside pi…"）+ `Available tools:` 列表 + `Guidelines:` 列表 + pi 自身文档的三条绝对路径（readme / docs / examples）与「何时去读它们」的规则（`dist/core/system-prompt.js:73-90`）；
2. `appendSystemPrompt` 追加段（`:91-93`）；
3. `<project_context>` 块，内部逐个包 `<project_instructions path="…">`（`:95-102`）；
4. `<available_skills>` 技能清单（`:104-106`）；
5. 末行 `Current working directory: <cwd>`（`:107`，cwd 里的 `\` 会被归一成 `/`，`:9`）。

**片段是条件注入、且会去重**。工具行只在调用方提供了「一行 snippet」时才出现在 `Available tools`（`dist/core/system-prompt.js:41-43`，snippet 由各工具定义提供，如 `dist/core/tools/read.js:22-25`）；guidelines 按已选工具动态生成——例如只有 bash 而没有 grep/find/ls 时才补一条「Use bash for file operations like ls, rg, find」（`dist/core/system-prompt.js:60-62`），扩展提供的 guidelines 去重后追加（`:63-68`），最后强制两条「Be concise…」「Show file paths clearly…」（`:70-71`）。技能段要求 read 工具可用才注入（`:104`；自定义 prompt 分支同规则 `:28-31`）。

**替换型 prompt**：项目或全局放了 `SYSTEM.md` 时走 `customPrompt` 分支，**整个默认模板被替换**，只保留 append 段、`<project_context>`、技能段、cwd 行（`dist/core/system-prompt.js:13-34`）。发现顺序是「项目 `.pi/SYSTEM.md`（要求项目已信任）→ 全局 `~/.pi/agent/SYSTEM.md`」（`dist/core/resource-loader.js:808-818`）；追加段 `APPEND_SYSTEM.md` 同规则（`:819-829`）。两者都通过 `resolvePromptInput()` 读入——注意它既能吃文件路径也能吃字面文本（`:16-30`）。

**指令文件（AGENTS.md / CLAUDE.md）的发现、合并、优先级**：单目录内按 `AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md → CLAUDE.MD` 取**第一个命中**，命中即返回，因此同目录只有一个文件生效（`dist/core/resource-loader.js:31-51`）。`loadProjectContextFiles()` 先放全局 agentDir 那份，再从 cwd 向上逐级到文件系统根收集，收集结果用 `unshift` 反向插入，形成「外层祖先 → 深层祖先 → cwd」的顺序（`:86-107`）；用 seenPaths 去重，并额外处理「linked git worktree 自己的同名 context 文件遮蔽主仓文件」的重复加载问题（`:61-80`）。**没有任何显式优先级语义**（后续文件不会「覆盖」前面的），效果完全等同于把文本按上述顺序拼接——层级越深、文本越靠后。

**没有截断，也没有预算**：这条链路上是 `readFileSync(filePath, "utf-8")` 整文件读入（`dist/core/resource-loader.js:40-44`），**未找到**任何字节/行数/token 上限，也**未找到**「context 文件总预算」这类机制。AGENTS.md 有多大，system prompt 就有多大。关闭方式是 `--no-context-files` / `-nc`（`docs/usage.md:230`）。

**每轮动态注入：默认没有**。在 `dist/` 中检索 `Current date` / `<environment` / `git status` / todo 类注入点均无命中。唯一每轮都在的「动态」信息是静态的 `Current working directory`。真正的挂载点是扩展事件 `before_agent_start`：扩展可返回 `systemPrompt` 替换本轮 prompt、返回 `message` 注入一条持久消息（`docs/extensions.md:521-556`）。实现上每轮调用 `emitBeforeAgentStart(...)`，无返回值时**显式重置** `_systemPromptOverride = undefined` 并回落到 base prompt，有返回值时覆盖并把 prompt 存进 `agent.state.systemPrompt`（`dist/core/agent-session.js:885-909`）；run 结束的 `finally` 再清一次（`:753`）；每轮还要通过 `prepareNextTurnWithContext` 把「当前 systemPrompt + 当前工具集」打包给下一 turn（`:274-293`）。git 类信息只出现在 TUI footer（`dist/core/footer-data-provider.js`），不进模型上下文。bash 工具侧另有一条轻量动态信息通道：命令进程的环境变量注入 `PI_SESSION_ID / PI_SESSION_FILE / PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL`（`dist/core/tools/bash.js:119-141`；`docs/environment-variables.md:26-29`），system prompt 里也提示模型可以读这些变量（`dist/core/tools/bash.js:34-37`）。

**拼出来的实际形态**（默认模板，省略大段文本）：

```
You are an expert coding assistant operating inside pi …  ← 角色 + Available tools + Guidelines + pi 文档路径
[APPEND_SYSTEM.md 追加段（若有）]
<project_context><project_instructions path="/repo/AGENTS.md">…全文…</project_instructions></project_context>
<available_skills>…</available_skills>
Current working directory: /repo
```

**system prompt 只在「结构性变化」时重建，而不是每轮重建**：`_rebuildSystemPrompt()` 仅在 ① 激活工具集变化（`setActiveToolsByName`，`dist/core/agent-session.js:643`）与 ② 扩展贡献了新资源/技能（`extendResourcesFromExtensions`，`:1778`）时被调用。这正是它前缀缓存友好的原因；与之相对，每轮唯一被重算的是 `before_agent_start` 的返回值（`:885-909`）。

**prompt 缓存边界**：pi-coding-agent 自身**不做** cache 分段，它只把「本轮 prompt + 工具集」交给 provider 层（`dist/core/agent-session.js:274-293`）。缓存策略由模型配置决定：`cacheControlFormat: "anthropic"`（`dist/core/model-config.js:85`）会把 `cache_control` 打在 system prompt、最后一个工具定义、以及最后一段用户/助手/工具结果文本上（`docs/custom-provider.md:262`）。pi 侧的两个主动动作是：(a) 摘要请求显式 `cacheRetention: "none"` 并用新的 routing sessionId，避免为一次性 prompt 写缓存（`dist/core/compaction/compaction.js:440-451`）；(b) 统计 cache 命中与 miss 并在 TUI 展示（`dist/core/cache-stats.js`，设置项 `showCacheMissNotices`）。实践约束写在文档里：动态增加带 `promptSnippet/promptGuidelines` 的工具会**重建 system prompt、打断前缀缓存**（`docs/extensions.md:2362-2369`）。

## 2. 工具输出的截断与查询

**统一的两个硬上限**：`DEFAULT_MAX_LINES = 2000` 行、`DEFAULT_MAX_BYTES = 50 * 1024`（50KB），「谁先到算谁」（`dist/core/tools/truncate.js:10-11`）。另有 grep 专用单行上限 `GREP_MAX_LINE_LENGTH = 500` 字符（`:12`）。

**没有全局输出预算**。检索全包**未找到**任何「跨工具的输出 token 配额 / 预算池」实现；只有每个工具各自的截断与条数上限。注意 `dist/core/output-guard.js` 名字容易误解，它做的是 stdout 接管、stderr 重定向与背压等待（`:38-88`），与截断无关。

**两个截断方向与各自的安全保证**：`truncateHead()` 保留前 N 行/字节，**永不返回半行**；若第一行本身就超过字节上限，直接返回空内容并置 `firstLineExceedsLimit=true`（`dist/core/tools/truncate.js:44-116`，关键分支 `:66-82`、`:98-100`）。`truncateTail()` 从尾部回溯保留最后 N 行/字节，**允许**在「最后一行本身就超上限」时返回半行（`:155-163`），并会向前找 UTF-8 字符边界以免切碎多字节字符（`:192-204`）。`truncateLine()` 用于 grep 行级截断，加 `... [truncated]` 后缀（`:209-214`）。

**各工具的实际上限与方向**：

| 工具 | 上限 | 方向 | 可调参数 |
|---|---|---|---|
| `read` | 2000 行 / 50KB | head | `offset` / `limit`（`dist/core/tools/read.js:17-21,218`） |
| `bash` | 2000 行 / 50KB | **tail**（想看错误和结尾） | 无，只有 `timeout`（`dist/core/tools/bash.js:233-235`） |
| `grep` | 100 条匹配 / 50KB，单行 500 字符 | head（行数上限被显式设为 `MAX_SAFE_INTEGER`，由匹配数兜底） | `limit`（`dist/core/tools/grep.js:26,81,262`） |
| `find` | 1000 条结果 / 50KB | head | `limit`（`dist/core/tools/find.js:30,81,139`） |
| `ls` | 500 条目 / 50KB | head | `limit`（`dist/core/tools/ls.js:18,63,128`） |
| `edit` / `write` | **未找到**任何截断逻辑 | — | — |

**截断时给模型的提示语——这是 pi 做得最漂亮的一处**：它们都被写成**可执行的下一步指令**，而不是道歉：

- read：`[Showing lines 12-2011 of 9000. Use offset=2012 to continue.]`（`dist/core/tools/read.js:231-236`）；首行就超限时干脆改教模型换工具：`[Line 12 is 80.0KB, exceeds 50.0KB limit. Use bash: sed -n '12p' <path> | head -c 51200]`（`:220-224`）；`limit` 提前停下但文件还有内容时也给续读 offset（`:239-244`）。
- bash：给的不是行号，而是**落盘全量路径**：`[Showing lines 3935-5934 of 5934. Full output: /tmp/pi-bash-<hex>.log]`（`dist/core/tools/bash.js:305-317`）；半行场景会说明「本行有多大 / 给了多大」（`:310-312`）。
- grep：`[100 matches limit reached. Use limit=200 for more, or refine pattern. Some lines truncated to 500 chars. Use read tool to see full lines]`（`dist/core/tools/grep.js:265-277`）。
- find：`[1000 results limit reached. Use limit=2000 for more, or refine pattern]`（`dist/core/tools/find.js:255-266`）；ls：`[500 entries limit reached. Use limit=1000 for more]`（`dist/core/tools/ls.js:131-140`）。

**落盘（spill to disk）与回读路径**：只有 bash 类输出会落盘。`OutputAccumulator` 流式累积、只保留约 `maxBytes * 2` 的滚动尾部，滚动窗口以行边界为裁剪基准（`dist/core/tools/output-accumulator.js:39-43,127-168`）；判定条件是「原始字节 > 50KB 或解码字节 > 50KB 或行数 > 2000」（`:169-171`），一旦命中就创建临时文件并把此前缓冲补写进去（`:172-182`）。`snapshot({persistIfTruncated:true})` 保证「只要被截断，盘上一定有完整副本」（`:87-94`）。文件名 `join(tmpdir(), "pi-bash-<8字节hex>.log")`（`:6-9`）。**回读路径就是模型看到的那条绝对路径**，模型用 `read`（可带 offset）或 `bash` 自己去读；**未找到**任何自动清理逻辑（`output-accumulator.js`、`tools/bash.js`、`bash-executor.js` 均无 unlink/rm），临时文件会一直留在 `/tmp`。交互模式的 `!command` 是独立实现：滚动缓冲上限 `2 * DEFAULT_MAX_BYTES`（`dist/core/bash-executor.js:25,53-58`），同样落 `/tmp/pi-bash-*.log`（`:34`），并额外做 `stripAnsi` + 二进制垃圾清洗 + `\r` 归一（`:44`）；其结果会以 `bashExecution` 消息进历史，截断时在文本里附上「Full output: <path>」（`dist/core/messages.js:35-37`），`!!` 前缀的命令可标 `excludeFromContext` 不进上下文（`dist/core/agent-session.js:2225-2247`；`docs/session-format.md:132-140`）。

**payload 层面的另一层预算**：图片。工具返回的图片块在进入历史前会被统一 `processImage` 归一/缩放（默认最长边 2000，`docs/settings.md:184`），理由是「超大图片会让 provider 拒绝整个会话，而不是只拒绝这一轮」（`dist/utils/tool-result-images.js:3-25`）；`read` 工具默认也走同一处理（`dist/core/tools/read.js:136,171-191`），且非视觉模型会收到一行 `[Current model does not support images…]` 说明（`:50-55`）。

**未落盘工具的代价**：`read` 是「整文件读进内存 → `split("\n")` → 再截断」（`dist/core/tools/read.js:195-218`），所以 50KB 上限保护的是**模型上下文**，不是进程内存；读一个超大文件仍会全量加载。`read` 的 `offset`/`limit` 语义也值得注意：显示给模型的 offset 是 1-indexed，内部转 0-indexed（`:200-201`）；**调用方给的 `limit` 优先于自动截断**，若因此提前停止而文件还有剩余，会额外给一条 `[N more lines in file. Use offset=M to continue.]`（`:209-216,239-244`）；offset 越界直接抛错并告知总行数（`:203-205`）。description 里也把 2000/50KB 两个数字直接写给了模型（`:141`）。

**输出格式约定（直接决定模型能不能“抄下来用”）**：grep 命中行是 `path:line: text`，上下文字是 `path-line- text`，`context` 参数默认 0（`dist/core/tools/grep.js:19,188-195,250-254`）；ls 输出按字母序、目录带 `/` 后缀、包含 dotfiles（`dist/core/tools/ls.js:63`）；find 返回相对搜索根的 posix 路径（`dist/core/tools/find.js:12-18`）。

**bash 侧的两个额外约束**：`timeout` 会做合法性校验并限制在 `MAX_TIMEOUT_MS = 2_147_483_647`（约 24.8 天）以内，超限直接抛错（`dist/core/tools/bash.js:16-29`）；超时或用户中断都会 `killProcessTree(pid)` 杀掉整个进程组，而不是只杀 shell（`:74-86,100-106`；`dist/utils/shell.js:172`）。find/grep 在非自实现路径上依赖外部二进制 `fd` / `rg`，缺失时会自动下载到 `~/.pi/agent/bin`（`dist/core/tools/find.js:161`、`dist/core/tools/grep.js:99`；目录定义 `dist/config.js:439-441`；下载器 `dist/utils/tools-manager.js`，`PI_OFFLINE` 可禁用联网下载 `:13-18`）。

## 3. 记忆折叠与召回

pi 的「折叠」有两条机制：**compaction**（上下文超限或 `/compact`）与 **branch summarization**（`/tree` 换分支时为被放弃的分支生成摘要），二者共用结构化摘要格式与累积文件追踪（`docs/compaction.md:16-22`）。

**触发条件**：

1. **阈值**：`contextTokens > contextWindow - reserveTokens`（`dist/core/compaction/compaction.js:160-164`）。默认 `enabled=true / reserveTokens=16384 / keepRecentTokens=20000`（`:74-78`；settings 层默认值同 `dist/core/settings-manager.js:506-528`；文档表 `docs/settings.md:117-118`），可写在 `~/.pi/agent/settings.json` 或 `.pi/settings.json`。
2. **溢出与异常恢复**：provider 报 context overflow，或响应因 `length` 停在下限以下时，先**移除**最后那条 assistant 消息（不进重试上下文），压缩后自动重试 **一次**；再失败就提示「减小上下文或换更大窗口的模型」（`dist/core/agent-session.js:1531-1561`）。
3. **手动**：`/compact [instructions]`（`dist/core/slash-commands.js:21`），交互层解析出可选的自定义关注点（`dist/modes/interactive/interactive-mode.js:2425-2426`），最终调用 `AgentSession.compact(customInstructions)`（`dist/core/agent-session.js:1362-1375`）；无事可做时报 "Nothing to compact (session too small)"（`:1382-1385`）。

触发前有防抖与去伪：位于上一次压缩边界之前的 assistant 消息不会再次触发压缩（`dist/core/agent-session.js:1526-1530`）；错误消息或零 usage 时改用估算，并校验「用到的 usage 来源必须晚于上一次压缩」，避免拿压缩前的旧 usage 误判（`:1562-1586`）。

**切点算法（这是「最近 N 轮」的真实实现）**：从最新条目向前累加估算 token，累计到 `keepRecentTokens` 即停，再把切点吸附到最近的合法切点（`dist/core/compaction/compaction.js:308-352`）。合法切点只包括 user / assistant / bashExecution / custom / branchSummary / compactionSummary，**绝不切在 toolResult**（`:227-254`）——因为 toolResult 必须紧跟它的 toolCall。单轮过大导致切点落在轮中（`isSplitTurn`）时，除历史摘要外再单独生成一份「本轮前缀」摘要，用 `\n\n---\n\n**Turn Context (split turn):**\n\n` 拼接（`:562-575,583-600`）。token 估算用「字符数 / 4」，图片按 4800 字符计（`:168,188-226`），并优先采用最后一次 assistant 消息的 `usage.totalTokens`，其后的消息再逐条估算相加（`:131-155`）。

**重复压缩从哪个边界开始**：上一份 compaction 存在时，本轮可摘要范围的下界是**上一份的 `firstKeptEntryId`（而不是 compaction 条目本身）**，找不到时才退化为「compaction 条目之后」；这意味着「上次为了保留原样而没摘要的最近内容」，在下次仍会被重新摘要一遍（`dist/core/compaction/compaction.js:496-511`）。同时 `tokensBefore` 是用**重建后的 session context**重新估算的，而不是沿用旧值（`:512`），所以 session 里记录的「压缩前 token」与当时上一条 assistant 的 usage 可能略有出入。

**什么情况下会拒绝压缩**：`prepareCompaction()` 在三种情形返回 `undefined`——路径最后一个条目已经是 compaction、找不到 `firstKeptEntryId` 对应的条目（提示 session 需要迁移）、以及待摘要消息集合为空（`dist/core/compaction/compaction.js:492-495,515-518,537-539`）。手动压缩会把这些情况翻译成人话报错（`dist/core/agent-session.js:1379-1386`）。

**流程事件与可干预点**：压缩全程发事件——`compaction_start`（带 `reason: "manual" | "threshold" | "overflow"`）与 `compaction_end`（带 `result` / `aborted` / `willRetry` / `errorMessage`）（`dist/core/agent-session.js:1370,1608,1624-1631,1694,1714-1723`）；扩展可在 `session_before_compact` 里 `{cancel:true}` 取消、或直接提供自己的 `compaction`（含自定义模型的摘要，`:1613-1650`），压缩完成后另有 `session_compact`（`:1677-1685`）。手动 `/compact` 会**先 abort 当前正在跑的 turn**（`:1368`），运行时也可用 `setAutoCompactionEnabled()` 开关自动压缩（`:1734-1740`）。`/tree` 触发的分支摘要有「不总结 / 默认总结 / 自定义关注点」三选一（`docs/sessions.md:129-139`）。

**摘要由谁生成**：**默认就是用当前会话的同一个模型**。`_getSummarizationRequestAuth(this.model)` 取的是 `this.model` 的鉴权与 baseUrl（`dist/core/agent-session.js:195-214`；自动压缩 `:1602`、手动 `:1375`、分支摘要 `:2373-2377`）。**未找到**任何「摘要用小模型」的内置设置项（settings 中没有 `summarizationModel` 之类字段）；要换模型只能写扩展拦截 `session_before_compact`（`docs/compaction.md` 的 custom-compaction 示例，`examples/extensions/custom-compaction.ts`）。摘要调用有独立的重试包装 `retryAssistantCall`，且**忽略主流程的流式函数**以保持路由隔离（`dist/core/compaction/compaction.js:434-451`）。

**Prompt 模板长什么样**：system prompt 是一句强约束——`You are a context summarization assistant… Do NOT continue the conversation. ONLY output the structured summary.`（`dist/core/compaction/utils.js:139-141`）；user 消息结构为 `<conversation>…</conversation>` +（可选）`<previous-summary>…</previous-summary>` + 指令模板（`dist/core/compaction/compaction.js:467-483`）。首压用 `SUMMARIZATION_PROMPT`，第二次起改用 `UPDATE_SUMMARIZATION_PROMPT`（第一条规则就是 PRESERVE all existing information）（`:356-425,463`）。模板强制输出 `## Goal / ## Constraints & Preferences / ## Progress(Done, In Progress, Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context`，并反复强调「Preserve exact file paths, function names, and error messages」（`:387,425`）。输出上限 `min(0.8 * reserveTokens, model.maxTokens)`（`:461`）；turn prefix 摘要更小，`0.5 *`（`:625`）。分支摘要另有模板 `BRANCH_SUMMARY_PROMPT`，`maxTokens: 2048`，且会加一句前言说明「用户此前探索了另一条分支」（`dist/core/compaction/branch-summarization.js:149-180,224,235`）。

**明确的保留策略**：(a) 最近约 `keepRecentTokens` 的**完整原文**不摘要；(b) 结构化摘要本身；(c) **文件账本**——从 assistant 的 toolCall 中抽 read/write/edit 的 `path`（`dist/core/compaction/utils.js:15-45`），跨次压缩累积（从上一份 compaction 的 `details.readFiles/modifiedFiles` 继承，`dist/core/compaction/compaction.js:15-38`），最终以 `<read-files>` / `<modified-files>` XML 追加到摘要尾（`utils.js:50-70`）。序列化给摘要模型的格式是 `[User]: …` / `[Assistant thinking]: …` / `[Assistant]: …` / `[Assistant tool calls]: name(k=v)` / `[Tool result]: …`（`utils.js:94-135`），并**刻意把 tool result 硬截到 2000 字符**、超出部分替换为 `[... N more characters truncated]`（`:74-85`）——这是整条压缩链路上最大的细节损失点。

**压缩后历史如何重建**：结果以 `CompactionEntry` 追加到 session 树（`dist/core/session-manager.js:803-818`，字段 `summary / firstKeptEntryId / tokensBefore / details / usage / fromHook`）。重建靠 `buildContextEntries()`：沿 leaf→root 取路径，只认**最后一个** compaction，输出 `[compaction, ...从 firstKeptEntryId 起的条目, ...compaction 之后的条目]`，更早的被摘要条目直接不进入上下文（`:198-226`）；`buildSessionContext()` 再把条目映射为消息，其中 `compaction` → `compactionSummary`、`branch_summary` → `branchSummary`，而 `custom / label / model_change / session_info` 一律不产生消息（`:166-189,232-237`），同时从路径上还原当时的 model 与 thinkingLevel（`:146-161`）。摘要**以 user 角色**注入，包在 `<summary>` 里：`The conversation history before this point was compacted into the following summary:\n\n<summary>…</summary>`（`dist/core/messages.js:7-17,103-110`），分支摘要同理（`:13-17,97-102`）。压缩落盘后 pi 直接 `agent.state.messages = sessionContext.messages` 重建运行时状态（`dist/core/agent-session.js:1670-1673`）。**注意文档与实现不一致**：`docs/session-format.md:237-246` 描述了一个更新的 `retainedTail`（把保留尾部直接物化到 compaction 条目上，使其成为自包含 checkpoint），但**本包 `dist/` 中 grep 不到 `retainedTail`**，实际仍是 `firstKeptEntryId` 回溯方案——该文档描述的是更新的 harness 产物。

**摘要本身的成本也被记账**：split turn 会把两次摘要的 usage 用 `combineUsage()` 相加（`dist/core/compaction/compaction.js:52-73`），并随 `CompactionEntry.usage` 落盘（`dist/core/agent-session.js:1670`），因此 `/session` 的 token/cost 总计里包含了压缩开销（`dist/core/usage-totals.js:31-34` 明确把 `compaction` / `branch_summary` 条目的 usage 归入 "Tools/summaries" 桶；字段语义 `docs/session-format.md:243-248`）。扩展提供的自定义摘要如果返回了 `usage`，同样会被算进总量（`docs/compaction.md` 的 `session_before_compact` 示例）。

**压缩产物存哪儿**：就存在**同一个 session JSONL 文件**里，作为树上的一个节点（`docs/session-format.md:229-249`；路径规则 `docs/sessions.md:5-8`：`~/.pi/agent/sessions/--<cwd 转义>--/<ISO 时间戳>_<uuid>.jsonl`）。同一份摘要也通过扩展事件 `session_compact` 暴露（`dist/core/agent-session.js:1676-1685`）。

**压缩后能否取回原文：能，但靠的是「读 session 文件」，没有专门的召回工具**。压缩只是把内容移出上下文，并不删除历史——新条目是 append 的（`dist/core/session-manager.js:803-818`），旧 JSONL 行仍在盘上。三条取回路径：(a) bash 工具环境里注入了 `PI_SESSION_FILE`（绝对路径，`dist/core/tools/bash.js:126-138`；`docs/environment-variables.md:27`），模型可以 `grep` / `read` / `tail` 那个 jsonl；(b) `/session` 显示当前 session 文件路径与统计；(c) TUI `/tree` 可导航到被摘要的节点查看或从那里重新分叉（`docs/sessions.md:69-85`）。**未找到**任何形如 `recall_compacted()` 的内置工具、向量索引或 FTS 索引。另一条官方「不靠压缩」的路线是扩展 `handoff`：**不压缩**，而是用模型抽取要保留的内容生成一段新 prompt，开一个干净 session（`examples/extensions/handoff.ts:1-40`）。

## 4. 技能与工具调用

**内置工具只有 7 个**：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`（`dist/core/tools/index.js:17`，工厂 `:18-84`）。默认启用其中 4 个（`read/bash/edit/write`，`dist/core/system-prompt.js:41`；`createCodingToolDefinitions` 为同一集合 `dist/core/tools/index.js:58-65`），只读组合是 read/grep/find/ls（`:66-73`），另有 `createAllTools` 提供全集（`:101-111`）。

**注册与暴露**：注册表是 `Map<name, tool>`。`_refreshToolRegistry()` 先塞内置（`sourceInfo: <builtin:name>`），再按顺序塞扩展工具与 SDK 自定义工具（`sourceInfo: <sdk:name>`）——**同名直接覆盖，未找到任何重复名报错**（`dist/core/agent-session.js:1954-1994`）。激活集合由 `setActiveToolsByName()` 维护，未知名字被静默忽略，并且**每次变更都会重建 system prompt**（`:631-645`）。扩展侧接口是 `pi.registerTool({name,label,description,promptSnippet?,promptGuidelines?,parameters,…})`（`dist/core/extensions/types.d.ts:344-357,902`；装载点 `dist/core/extensions/loader.js:215`），并且工具可以注册 CLI flag `--tool-*` 之类以供启用/禁用（`dist/core/extensions/types.d.ts:910-916`）。静态可用性控制：`defaultTools`（内置工具白名单）+ `--tools`（对所有工具的严格白名单）/ `--no-tools` / `--no-builtin-tools` / `--exclude-tools`（`docs/settings.md:221-231`）。扩展自省接口是 `getAllTools()`（返回 name/description/parameters/promptGuidelines/sourceInfo）与 `getToolDefinition(name)`（`dist/core/agent-session.js:610-624`）。完整工具列表随 `agent.state.tools` 进入每次模型请求（`:287`），其中的 `parameters` 是 TypeBox schema。

**暴露方式与 token 预算：默认全量注入，官方可选延迟加载**。默认把当前激活工具的定义（含 JSON Schema + description）整批发给模型；**没有**内置的工具数量上限，也**未找到**「工具定义 token 预算」这类机制——system prompt 里每个工具只占一行 snippet（`dist/core/system-prompt.js:42-43`），真正的 token 成本在 schema 与 description 上。pi 提供了一条自定义约束采样通道（实验开关）：`constrainedSampling: getExperimentalToolSampling()` 会为工具声明 prefer-strict sampling（`dist/core/experimental.js:5-7`；用法见 `dist/core/tools/read.js:145`、`bash.js:245`）。

**工具结果的拦截**：扩展还有 `tool_result` 钩子，语义像中间件——按加载顺序执行，每个 handler 看到前一个改动后的结果，可返回 `content` / `details` / `isError` / `usage` 的**局部补丁**（`docs/extensions.md:815-826`）。这是「不改内核就能做输出重写/脱敏/二次压缩」的口子。另一个易踩的细节：自定义工具若**不提供** `promptSnippet`，就不会出现在默认 system prompt 的 `Available tools` 段里（字段语义见 `dist/core/extensions/types.d.ts:351-352`），只靠 tool schema 的 `description` 让模型发现它。

**延迟加载 / 工具搜索（官方支持，但引擎不在本包）**。流程是「注册全部 → 只激活少数 loader（如 `search_tools`）→ loader 执行时纯增量 `pi.setActiveTools([...current, ...matched])` → pi 记录新增工具名到该 tool result → 下一次请求让新增定义生效」（`docs/extensions.md:2335-2361`）。对 Anthropic Sonnet/Opus/Fable 4.5+ 走原生 `defer_loading` + `tool_reference`，对 `gpt-5.4+` 走 `tool_search_call/tool_search_output`，其它模型退回「下一轮直接补发完整工具列表」（`docs/extensions.md:2351-2369`）。协议层实现落在**包外依赖**：`../pi-ai/dist/api/anthropic-messages.js:721`（`splitDeferredTools`）、`../pi-ai/dist/api/openai-responses.js:58`（`supportsToolSearch`）。文档给的代价提示很实在：给延迟加载的工具加 `promptSnippet/promptGuidelines` 会重建 system prompt、破坏前缀缓存，因此懒加载工具应只依赖 `description`（`docs/extensions.md:2362-2369`）。

**MCP：未内置，也没有命名空间约定**。全 `dist/` 只有两处无关的 "mcp" 命中——打包的 `highlight.min.js` 词表，以及 `dist/utils/tool-result-images.js:6` 的一句注释（把「MCP bridge」当作会产图片的外部工具来源）。文档明确写 "It intentionally does not include built-in MCP"（`docs/usage.md:304`）。因此 MCP server 只能写成扩展：自己建连、自己 `registerTool`。**未找到**任何工具名命名空间规范（如 `mcp__server__tool`）或名称冲突策略，只有 registry 的「同名覆盖」语义。

**skill 机制的发现 / 描述注入 / 渐进式加载 / 执行**：

- **发现**：目录含 `SKILL.md` 即视作技能根、不再下钻；否则加载根目录下的 `.md`，并递归子目录找 `SKILL.md`；跳过点开头目录与 `node_modules`；用 `.gitignore/.ignore/.fdignore` 过滤（`dist/core/skills.js:113-160`，忽略文件名列表 `:12`）。加载源包括 `~/.pi/agent/skills`、`~/.agents/skills`、`.pi/skills`、项目 `.agents/skills`、package、settings `skills` 数组、`--skill`（`docs/skills.md:20-42`；默认源是否加载由 `includeDefaults` 控制，`dist/core/skills.js:329-332`）。同名按「先加载者胜」，后到者记为 collision 诊断（`:300-328`）。校验对 `name ≤ 64`、`description ≤ 1024` 等规范违规报错但**仍宽容加载**（`:9-11,63-86`；`docs/skills.md:5`）。
- **描述注入**：只有 name / description / location 常驻上下文，XML 格式 `<available_skills><skill><name>…</name><description>…</description><location>…</location></skill></available_skills>`，并附「技能内相对路径按 SKILL.md 所在目录解析」的指示（`dist/core/skills.js:257-278`）。
- **渐进式加载与执行**：没有专门的 skill 执行器——系统提示就是让模型「任务匹配时用 read 工具去读技能文件」，全文按需加载（`docs/skills.md:64-70`）。`disableModelInvocation: true` 的技能不注入 prompt，只能 `/skill:name` 显式调用（`dist/core/skills.js:254-258`；字段文档 `docs/skills.md:149`）。`/skill:name args` 会把参数以 `User: <args>` 追加到技能内容之后（`docs/skills.md:73-82`）。TUI 会把 read 到 `SKILL.md` 的调用折叠成一行 `[skill] <name>`（`dist/core/tools/read.js:80-103`）。

**权限与审批：没有内置工具审批，全在信任 + 扩展两层**。

- **项目信任**决定「是否加载项目本地 settings / resources / package / extension」，是**输入加载守卫**而非沙箱（`docs/security.md:5-27`）。决策存 `~/.pi/agent/trust.json`（`dist/core/trust-manager.js:172`），`--approve/-a`、`--no-approve/-na` 可单次覆盖；非交互模式默认按 `defaultProjectTrust`（默认 `ask` → 视为不信任）（`docs/security.md:17-27`）。被拒绝时 AGENTS.md 类 context 文件仍会加载（`docs/security.md:27`）。
- **扩展 `tool_call` 钩子**可返回 `{block: true, reason?, terminate?}` 拦截任意工具调用；`event.input` 可变（原地改写参数即生效，且不再重新校验），handler 抛错等于 fail-safe 阻塞（`dist/core/extensions/types.d.ts:686-690,781-789`；语义与顺序 `docs/extensions.md:751-771`；错误策略 `docs/extensions.md:2894`）。官方示例：`examples/extensions/permission-gate.ts`（危险 bash 弹确认，无 UI 时默认 block）、`examples/extensions/protected-paths.ts`（保护 `.env`、`.git/`、`node_modules/`）。
- 底线声明：pi 没有内置沙箱，工具以 pi 进程权限执行，真实隔离要靠容器/VM（`docs/security.md:31-33,44-59`）。

## 5. Per-user 长期记忆

**核心结论：pi-coding-agent 没有内置的跨 session 长期记忆**——没有向量库、没有 embedding、没有 recall 工具、没有后台整理进程。全 `dist/` 检索 `memory|embedding|vector` 只命中「in-memory 模式」这类无关标识（如 `SessionManager.inMemory`，`dist/core/session-manager.js:1223-1224`）；`docs/` 下也**未找到**任何 memory 章节。下面写它用什么替代。

**替代一：分层指令文件（事实上的「用户级长期记忆」）**。`~/.pi/agent/AGENTS.md` 是**每用户全局**的持久指令，每次启动读进 system prompt；项目 `AGENTS.md` / `CLAUDE.md` 按 cwd 逐级叠加，同目录内 `AGENTS.override.md` 优先（`dist/core/resource-loader.js:31-51,86-107`）。写入方式是**人或模型直接用 write/edit 改文件**，没有自动提取、没有后台归档，也没有长度上限（见 §1）。粒度是「user（HOME）+ 项目目录层级」，不是 agent 实例。

**替代二：session 文件（短期记忆的持久化形态）**。位置 `~/.pi/agent/sessions/--<cwd 转义>--/<ISO 时间戳>_<uuid>.jsonl`；格式为 JSONL + 树结构（`id`/`parentId`），条目类型包括 message / compaction / branch_summary / custom / custom_message / label / model_change / thinking_level_change / session_info（`docs/session-format.md:5-9,187-305`）；文件头带 version（v1 线性、v2 树、v3 `hookMessage`→`custom` 改名），加载时自动迁移（`docs/session-format.md:19-27`）。恢复入口：`pi -c` 续最近、`pi -r` / `/resume` 选择、`--session <path|id>`、`--fork <path|id>`、`/fork`、`/clone`（`docs/sessions.md:9-35`）。**隔离维度是 cwd（项目）**：session 目录按 cwd 编码（`dist/core/session-manager.js:242-247`），`SessionManager.forkFrom(sourcePath, targetCwd)` 可把别的项目的 session 搬过来（`docs/session-format.md:390-397`）。**不按用户区分**——多用户共用一个 `$HOME` 就共用同一份记忆；不同 `$HOME` 天然隔离。跨机共享靠 `/export` 或 `/share`（私有 gist）（`docs/sessions.md:22-35`）。检索/聚合层面提供 `SessionManager.list(cwd, …)`（按项目）与 `listAll()`（跨项目），以及对外的 `pi -r` 选择器（`docs/session-format.md:397-399`）；注意这只是「列出 session 文件」，不是对内容做索引。

**替代三：扩展自定义持久化**。`appendCustomEntry(customType, data)` 把任意 JSON 存进 session 树，但**明确不参与 LLM 上下文**（`dist/core/session-manager.js:819-830`；`docs/session-format.md:263-272`）；要进上下文得用 `appendCustomMessageEntry` 或 `before_agent_start` 注入消息（`docs/extensions.md:540-552`）。轻量的「会话内标记」用 label 条目（`/tree` 里可见，官方 `examples/extensions/bookmark.ts`）。要真正跨 session 记东西，只能自己读写文件——示例里三条可用思路：`bookmark.ts`（label 书签）、`git-checkpoint.ts`（git 检查点）、`handoff.ts`（生成交接 prompt 开新 session，`examples/extensions/handoff.ts:1-40`）。

**隔离维度对照**（这张表是「多用户/多项目能不能共享记忆」的直接答案）：

| 维度 | pi 的隔离方式 | 证据 |
|---|---|---|
| user | 隐式靠 `$HOME`（`~/.pi/agent` 是唯一 agentDir） | `dist/config.js:412-417` |
| project | session 目录按 cwd 编码；settings 项目层覆盖全局层 | `dist/core/session-manager.js:242-247`、`dist/core/settings-manager.js:46-47` |
| agent | **不存在「agent 实例」这一维度**，也没有多 agent 注册表 | `dist/config.js:412-417` |
| session | 一个 JSONL 内是一棵树；可 `--fork` / `/clone` / `createBranchedSession` 派生 | `docs/session-format.md:386-415` |

**检索方式：文件 + 关键字，没有索引**。实际检索工具就是 `grep` / `read` / `find` / `ls` 作用在 session JSONL、AGENTS.md 以及项目文件上；`/resume` 选择器的搜索是纯文本匹配（`docs/sessions.md:43`），命名靠 `pi --name` / `/name`（`docs/sessions.md:52-60`）。**未找到**向量检索、图检索或 BM25 索引。

**命名的作用**：`/name` / `--name` 会写一条 `session_info` 条目，`/resume` 选择器优先显示这个名称而不是首条消息，便于在堆积的 session 里做「人工检索」（`dist/core/session-manager.js` 的 `getSessionName()`/`appendSessionInfo()`；`docs/sessions.md:52-60`）。label 条目则把书签绑在具体条目上（`docs/session-format.md:286-294`）。二者都不进入 LLM 上下文（`dist/core/session-manager.js:188`）。

**其它 per-user 落盘状态**（是配置而非记忆，但决定「用户隔离」的真实边界）：`~/.pi/agent/settings.json`（全局设置，`.pi/settings.json` 项目覆盖，`dist/core/settings-manager.js:46-47`）、`~/.pi/agent/auth.json`（凭据，`dist/core/auth-storage.js:17`）、`~/.pi/agent/models.json`、`~/.pi/agent/prompts/`、`~/.pi/agent/trust.json`（`dist/core/trust-manager.js:172`）、`~/.pi/agent/sessions/`、`~/.pi/agent/bin/`（`dist/config.js:412-453`）。**pi 层不存在多租户隔离**，官方建议靠「不同 HOME / 容器」实现，并特别提醒「不要挂载宿主 `~/.pi/agent`，除非你确实想让容器访问宿主的 session、设置与凭据」（`docs/security.md:44-59`）。

## 6. 亮点、代价与可借鉴点

**最值得抄的 4 个设计**

1. **截断提示 = 可执行的下一步**。read 给 `offset=` 续读、首行超限时给出可直接粘贴的 `sed -n '12p' | head -c 51200`、grep 给 `limit=200` 与「用 read 看整行」、bash 给落盘全量路径（`dist/core/tools/read.js:220-244`、`grep.js:265-277`、`bash.js:305-317`）。它把「信息丢失」转译成了动作，比 `[truncated]` 有用一个数量级。
2. **压缩保留一份跨次累积的「文件账本」**：从 toolCall 抽 `read/write/edit` 路径、从上一份 `details` 继承、以 XML 附在摘要尾部（`dist/core/compaction/utils.js:50-70`、`compaction.js:15-38,607-609`）。摘要文字可以模糊，但「碰过哪些文件」这条硬事实不丢——这是让压缩后模型还能继续动手的关键。
3. **切点安全 + split turn 双摘要**：绝不切在 toolResult（否则 tool_use/tool_result 配对断裂），单轮过大时额外生成 turn-prefix 摘要并拼接（`dist/core/compaction/compaction.js:227-254,583-600`）。这两条约束几乎适用于任何会做上下文折叠的 agent。
4. **「压缩 ≠ 删除」+ 稳定暴露原文路径**：只改「进入上下文的路径」，历史 JSONL 一行不删，并把 `PI_SESSION_FILE` 注入 bash 环境让模型能自己回读（`dist/core/session-manager.js:803-818`、`dist/core/tools/bash.js:126-138`）。召回 = 让模型 grep 备份，比自己造召回工具更简单、更可验证。

**代价与坑**

- **摘要用主模型**，没有内置的小模型档位；压缩本身是一次「大输入」请求，成本可观（`dist/core/agent-session.js:1602`）。
- **摘要输入主动丢细节**：tool result 在序列化时截到 2000 字符（`dist/core/compaction/utils.js:75`），一次 `read` 出来的一大段代码在摘要里只剩开头。
- **没有全局输出预算**：N 个工具调用 × 50KB 就能把窗口填满，只能靠压缩兜底；`read` 还会把整个文件读进内存（`dist/core/tools/read.js:195-198`）。
- **临时输出文件不清理**：`/tmp/pi-bash-*.log` 只写不删（`output-accumulator.js`、`bash-executor.js` 均无清理逻辑），长跑机器会积累垃圾。
- **AGENTS.md 无长度上限**（`dist/core/resource-loader.js:40-44`）：monorepo 里多层指令文件叠加会静默吃掉窗口，且没有任何提示。
- **上下文增强全靠扩展**：git 状态、时间、环境、TODO、审批、MCP 都要自己写 extension；而 `before_agent_start` 一旦返回 `systemPrompt` 就整体替换本轮 prompt，写错会打断 prompt cache（`dist/core/agent-session.js:900-909`；`docs/extensions.md:2362-2369`）。
- **无长期记忆基础设施**：跨 session 的「用户偏好 / 项目知识」只能落在 AGENTS.md 或扩展自管文件里，检索只有 grep；session 目录还会按 cwd 无限增长，pi 只提供 `/resume` 里的手动删除与 `trash` 兜底（`docs/session-format.md:13-17`）。
- **延迟加载是「扩展自己实现」的能力**：pi 只提供了 `setActiveTools` 的增量语义与 provider 侧的原生 deferred 协议，**未找到**内置的 `search_tools` 或工具检索实现——每个项目要自己写一遍 loader（`docs/extensions.md:2335-2372`）。

**如果你要为自己的 agent 做决策**

- **工具多又想省 token** → 抄 pi 的「全量默认 + 扩展驱动延迟加载」：注册全部、只激活 loader、纯增量 `setActiveTools`，并按 provider 能力决定用原生 deferred schema 还是退回全量补发（`docs/extensions.md:2335-2369`）。前提是工具名与描述保持稳定，否则前缀缓存保不住；懒加载工具别带 `promptSnippet`。
- **要做长期记忆** → pi 的答案是「不给内置，只给钩子」：文件型（AGENTS.md 层级）承载稳定事实，session JSONL 承载可回滚原文，扩展承载结构化偏好。若你要做向量记忆，需自己在 `before_agent_start` 注入检索结果，并接受它可能打断缓存这一代价。
- **要做「压缩后可召回」** → 直接抄 pi：不删原文，只缩短「进入上下文的路径」，并稳定地把原始文件路径暴露给模型（`PI_SESSION_FILE`）。成本极低，且召回质量可以被 grep 验证。
- **prompt 缓存优先级**：把每轮会变的东西（时间、git 状态、TODO）放在上下文**尾部**或以独立消息注入，而不是改 system prompt——pi 默认完全不注入这些，是它缓存命中率高的隐性原因（`dist/core/system-prompt.js:107` 只放了一行 cwd）。
