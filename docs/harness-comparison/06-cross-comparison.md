# 横向对比：上下文、截断、折叠召回、工具技能、长期记忆

> 单项目事实与证据见同目录 `01`~`05`；本文只做**对照**，行号级证据请回各单项目文档。
> 缩写：**pi** = pi-coding-agent 0.84.2 / **tw** = touwaka-mate / **cx** = OpenAI Codex CLI（codex-rs）/ **hm** = Hermes Agent / **ex** = 本项目 erix-agent。

## 0. 对比范围

| | pi | tw | cx | hm | ex |
|---|---|---|---|---|---|
| 语言/形态 | TS（编译产物） | Node ESM + MySQL | Rust | Python | 零依赖 Node ESM |
| 定位 | 交互式编码 agent（人在环） | 多角色专家平台（服务端多租户） | 编码 agent（本地 CLI + 云端） | 通用 agent（CLI/Gateway/Desktop） | 无头 agent 运行时（宿主编排） |
| 是否拥有工具面 | 是（内置 7 工具） | 是（内置 + 技能 + MCP） | 是（100+ crate） | 是（core ~40 + MCP） | **否，宿主注入**（引擎只内置 recall） |
| 是否拥有 UI/会话 | 是 | 是 | 是 | 是 | 否（宿主负责） |

这个「谁拥有工具面」的差异会贯穿全文：ex 在 §1/§4 大量机制「未找到」，不是缺失而是**被显式放到宿主层**（ADR-005「契约在库里、执行在调用方」）。

---

## 1. 上下文构造

### 1.1 system prompt 组装

| | 组装方式 | 顺序是否可变 | 预算/截断 |
|---|---|---|---|
| pi | 单函数纯字符串拼接：角色+工具表+guidelines+docs 路径 → `APPEND_SYSTEM.md` → `<project_context>`（AGENTS.md 全文） → `<available_skills>` → cwd 行 | 固定；`SYSTEM.md` 可整体替换模板 | **无**：AGENTS.md 整文件读入，无字节/token 上限 |
| tw | 固定 8 段 section 数组 + 每段 `priority`，按 token 预算降级 | 固定；专家可换 `context_strategy`(full/simple/minimal) | `totalBudget=maxTokens×0.7`、`systemBudget=totalBudget×0.35`；超限按 priority 3→2→1 整段删除，再 token 截断 |
| cx | `WorldState`：20+ 个**有类型 section** 按插入顺序渲染 | 固定（扩展可强制前插） | 各 section 自带上限（如 AGENTS.md 总 32 KiB） |
| hm | `stable / context / volatile` 三层，各层内 `\n\n` 连接 | 固定，且**顺序即缓存优先级** | context 文件 `clamp(context_length×4×6%, 20k, 500k)` 字符 |
| ex | 引擎只做两段：宿主 `system` + `WRAPUP_INSTRUCTION`；宿主（CLI）拼「身份一句话 + 工具纪律 + 归档公告」 | 宿主自由 | 引擎无；任务简报截 500 / 1500 字符 |

**要点**

- pi / cx 都把 system prompt 视为「可以很长但必须稳定」的产物；tw / ex 把它视为「可以按预算裁剪」的产物——这决定了后面 §1.4 的缓存命运。
- cx 的 `WorldState` 是唯一把「注入片段」做成**有类型 + 可 diff + 可单独失效**的体系；其余四家都是字符串拼接（hm 是拼接但分了层）。
- ex 是唯一**引擎不碰 system prompt 内容**的：宿主想注入什么就注入什么，引擎只负责在末尾追加「收官指令」。

### 1.2 指令文件（AGENTS.md / CLAUDE.md 类）

| | 候选与优先级 | 合并方式 | 截断 |
|---|---|---|---|
| pi | 同目录 `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`，**首个命中即止** | 全局 agentDir → 祖先 → cwd，逐级拼接（无覆盖语义） | **无** |
| tw | **无此机制**（等价物：工作区 `README.md`/`TODO.md` 全文进 task_context） | — | 无上限，仅间接受 system 预算约束 |
| cx | 同目录 `AGENTS.override.md > AGENTS.md > project_doc_fallback_filenames`，逐层各取首个 | 从 project root（默认 `.git`）到 cwd 逐层拼接 | 总预算 32 KiB，超出静默截断 + warn |
| hm | 类型级优先级 `.hermes.md/HERMES.md > AGENTS.md 链 > CLAUDE.md > .cursorrules`，**只有第一个有非空文件的类型生效**；AGENTS 链内逐目录合并后去重 | 类型内逐目录合并 | 合并后整体二次截断，head 0.7 + tail 0.2，marker 内含 `read_file` 原文路径 |
| ex | **无此机制**（等价物：宿主组装的 task brief） | — | 简报截 500 / 1500 字符 |

**要点**

- 只有 hm 的截断是「**可自愈**」的：marker 里直接给出原文读取路径，模型能自己补回；cx 是静默截断（最危险的一种）。
- pi / cx / hm 的「同目录首个命中」语义一致：同目录不会同时生效两个指令文件。
- ex / tw 没有指令文件机制，但 ex 的 `task brief` 与 tw 的 `README/TODO 全文` 是同一角色的替代品——**都是无预算的隐式风险点**（ex 有显式截断）。

### 1.3 每轮动态注入

| | 每轮注入什么 | 挂载点 |
|---|---|---|
| pi | **默认无**（只有静态 cwd 行）；git 信息只进 TUI footer | 扩展事件 `before_agent_start`（可替换整轮 prompt 或注入持久消息） |
| tw | 时间戳（每轮变）、最近 10 个 topic 摘要、最近 3 条 inner voice、每 3 轮一次的用户信息追问、工作区文件清单 | organizer 直接拼进 system prompt |
| cx | `<environment>`（cwd/shell/date/timezone/network/fs/subagents）、时间提醒（默认 off）、模型切换提示 | `WorldState` section（**只发 diff**） |
| hm | system prompt **不动**：ephemeral system prompt、记忆 prefetch 进当前 user 消息（`api_content` 逐字重放）、子目录 hints 追加到工具结果、`@` 引用 | API 时临时层 / 工具结果信道 |
| ex | `run-state` 块（轮次/工具足迹/文件/折叠水位），**只在折叠发生的那一轮** | marker 替换（upsert），不是追加 |

**要点**

- 只有 pi 敢「什么都不注入」，因为它是交互式的：人类会提供最新状态。
- hm 的处理最激进也最有启发：动态内容一律改走 **user 消息侧信道**，且把「实际发出的字节」存进 `api_content` 供后续轮次原样重放——缓存稳定 + 忠实回放两全。
- cx 的 `<environment>` 每轮都在，但通过 diff 保证历史前缀不被重写。
- ex 的「只在折叠轮注入」是刻意的：run-state 是给失忆后的模型看的，不需要每轮出现。

### 1.4 prompt 缓存边界（本维度最大的分水岭）

| | 做法 | 效果 |
|---|---|---|
| pi | 只在**结构变化**（工具集变化、扩展新增资源）时重建 system prompt；`cacheControlFormat:"anthropic"` 由 provider 层打点；摘要请求显式 `cacheRetention:"none"` | 前缀缓存友好；改工具 snippet 会打断 |
| tw | **未找到**任何 cache 分段；时间戳每轮必变 | 长 system prompt 每轮重算，缓存基本无收益 |
| cx | `prompt_cache_key = session id`；world-state **全量一次 + 之后只发 merge-patch diff**；合成 tool output 的 UUID 用 `v5(thread_id, content)` 保证稳定，注释明写「改它会改变模型可见 id 并击穿 prompt cache」 | 把稳定前缀做成**系统不变量**，最强 |
| hm | stable 层缓存为 `_cached_system_prompt_static`，Anthropic 默认 4 个 breakpoint；workspace 快照 / 技能索引 / 记忆快照**会话级冻结**；唯一重建触发是压缩 | 与 cx 并列最强，代价是组装行为变更必须同步维护持久化 prompt 的校验与还原 |
| ex | **未找到**；折叠把摘要插进最早的真实 user 消息、run-state 原地 upsert | 折叠轮必然全量重算前缀；这是明确取舍（换来可审计 + 近无损） |

**要点**：若目标场景依赖 prompt caching（长 system prompt + 多轮），pi / cx / hm 是可直接参考的三个模板；tw / ex 需要改造（把易变段后置或以独立消息注入）。

---

## 2. 工具输出的截断与查询

### 2.1 阈值与方向

| | 默认单结果上限 | 截断方向 | 特例 |
|---|---|---|---|
| pi | **2000 行 / 50 KB**（先到先算） | read/grep/find/ls = head；**bash = tail** | grep 单行 500 字符；read 首行超限则返回空 + 教模型换 `sed` |
| tw | 工具→LLM 单条 **10000 字符**；历史回注 full 8000 / simple 3000 / 默认 5000 | 几乎全是 **head** | `fs.read_file` 100 行 / 50000 字节；`execute` 1 MB / 30 s；grep 100 条 × 200 字符 |
| cx | 模型级 `truncation_policy = tokens 10000`（代码兜底 bytes 10000）× 1.2 序列化余量 | **middle**（保头保尾、砍中间，`…N tokens truncated…`） | exec 独立一档：进程内 1 MiB buffer + HeadTailBuffer(50/50) + `max_output_tokens` |
| hm | 终端 **50000 字符**；`read_file` 100000 字符 / 2000 行；search 50 条/页 × 500 字符 | 终端 **head+tail(40/60)**；`read_file` head + 续读游标 | 单行 2000 字符；MCP 单块 2M；error body 2048 |
| ex | CLI 工具 4096 字符 → 引擎 `outputHygiene` 4096 字符（可配） | head（recall 内部按命中位置**居中窗口**） | readFile 200 行；rg 50 条 + 跳过 >1 MiB 文件；tree 500；exec 1 MiB / 120 s |

**要点**

- 「先到先算」（pi，行/字节双限）比单一口径更鲁棒：不会出现「只有 3 行但每行 1 MB」的情况。
- **方向选择有语义**：bash 取 tail（错误与结尾最重要）、read 取 head（要能续读）、cx 取 middle（信息两端密度更高）。全用 head 的 tw 在长日志场景会丢关键报错。
- hm / ex 是唯二**按用途给不同方向**的（hm 终端 head+tail、read head+游标；ex recall 居中）。

### 2.2 落盘 / 落库与回读路径

| | 是否持久化完整输出 | 存哪儿 | 模型如何取回 |
|---|---|---|---|
| pi | **只有 bash** 落盘 | `/tmp/pi-bash-<hex>.log` | 截断提示里给**绝对路径**，模型用 read/bash 自取；无清理逻辑 |
| tw | 落库（阈值 5000 字符） | `messages.content`（摘要+指令）+ `messages.tool_calls.result`（全文） | 内置 `recall({mode:'messages',action:'detail',message_id})` **优先读 result**，上限 4000 字符；带跨用户校验 |
| cx | **不落盘** | — | 靠**原地重取**：进程存活时 `write_stdin` + 调大 `max_output_tokens`，或重跑命令 |
| hm | 落盘（超阈值） | `$HERMES_HOME/cache/spillover/<tool_call_id>.txt` | `<persisted-output>` 块：原始字符数 + `Full output saved to: <path>` + 显式指令「用 read_file 分页 / 用 execute_code 处理；不要重新向远端 API 要同一份数据」；**写入做无损校验**（字节比对 + `wc -c` 往返） |
| ex | 落档（引擎层） | transcript round record 的 `toolOutputs` + 折叠 `foldedPayload` | 引擎内置 `recall` 工具三级渐进：总览 → `{pattern}` 摘录 → `{fromRound,toRound}` 原文；四路语料（messages + foldedPayload + toolOutputs）；**字节保真** |

**要点**

- **只有 cx 默认不可召回**：截断是有损的，取回只能重跑，而重跑对非幂等命令是危险的。hm 与 ex 都在提示语里显式写了「不要重跑副作用命令」。
- hm 的「落盘后做无损校验，校验不过就删档退回内联截断」值得直接抄——**指向一个残缺归档比直接截断更糟**。
- tw / ex 的共同点是「回读是一个工具」而不是「回读是一个文件路径」，这让回读带上了参数校验、权限校验与分段预算。

### 2.3 单轮聚合预算与去重

| | 单轮所有输出合计上限 | 去重/节流 |
|---|---|---|
| pi | **未找到** | 无 |
| tw | **未找到**；只有消息数组总预算 + 每轮折叠 | 无 |
| cx | **未找到**；只有默认关闭的 rollout budget（会话级） | 无 |
| hm | **有**：`clamp(30% × 窗口字符数, 16k, 200k)`；批末从最大结果开始逐个落盘直到回到预算内 | 同轮**字节完全相同**的重复调用结果替换为引用 stub |
| ex | **未找到**；最接近的是三个软预算（run-state 400 字符、judge 40000 tok、guard 4000 tok） | 无（靠折叠兜底） |

**要点**：hm 是唯一把「输出预算」做成**按模型窗口缩放**的（单结果 15%、单轮 30%），也是唯一同时做去重的。其余四家在密集工具轮（一次并行 10 个大输出）都只能靠下一轮压缩兜底。

### 2.4 截断提示的可执行性（质量差异最大的一处）

| | 典型提示语 |
|---|---|
| pi | `[Showing lines 12-2011 of 9000. Use offset=2012 to continue.]` / `[Line 12 is 80.0KB… Use bash: sed -n '12p' <path> \| head -c 51200]` / `Full output: /tmp/pi-bash-….log` |
| tw | `→ 调用 recall({ mode:'messages', action:'detail', message_id:"…" }) 获取完整结果`；JSON 返回带 `{_truncated,totalItems,_hint}` |
| cx | `Warning: truncated output (original token count: N)\nTotal output lines: M`（说明丢了多少，但**不给出取回方式**） |
| hm | marker 内嵌 `read_file` 原文路径；spill 块内嵌「不要重新请求远端 + 用 read_file 分页」 |
| ex | `[完整输出已由引擎归档（第 9 轮，共 51234 字符）。需要原文：recall({ round: 9, pattern: "关键词" })]` |

**结论**：pi / hm / tw / ex 的提示语都是**下一步动作**；cx 是**状态告知**。前者把信息丢失转译成动作，后者要求模型自己推理补救方式——这是低成本、高回报的差异。

---

## 3. 记忆折叠与召回

### 3.1 触发与判据

| | 触发 | 阈值（默认） | 手动入口 |
|---|---|---|---|
| pi | 每轮请求前判定 + provider 溢出恢复 | `contextTokens > window − reserveTokens(16384)`；保留 `keepRecentTokens(20000)` 原文 | `/compact [instructions]` |
| tw | **三套**：Topic 压缩（主路径，每轮存 user 消息后）、AgentLoop history-compactor（每轮调用前）、Psyche 折叠（仅 minimal） | Topic：≥5 条且 (token ≥70% 或 ≥50 条)；compactor：80000 tok / keep 6 轮 | 无（`force` 由反思触发） |
| cx | pre-turn + mid-turn + 模型切换 | `auto_compact_token_limit = window × 9/10` | `/compact` |
| hm | pre-API 闸门 + gateway 安全网 | agent **50%**（窗口 <512K 时抬到 ≥75%）；gateway **85%** | `/compress [focus]` |
| ex | 每轮请求前 | 纯预算：`estimate > window − maxOutput − max(2000, 10%)` | **无** |

**要点**

- hm 是唯一有**两级闸门 + 反抖动状态机**的：agent 侧 50% 主动压、gateway 侧 85% 兜底，且 token 计数不可靠时**故意多等一个请求**才压。代价是大量冷却/strike/breaker 代码。
- cx 的 90% 阈值最晚，因为它默认只能丢信息（见 3.3）；hm 的 50% 最早，因为它保证可召回。**阈值高低与「丢了能不能捡回来」直接相关**。
- tw 的三套机制语义重叠，是唯一会出现「同一段历史被两种机制分别处理」的实现（也是它自己文档承认的复杂度来源）。

### 3.2 摘要由谁生成

| | 生成者 | prompt 形态 | 失败处理 |
|---|---|---|---|
| pi | **当前会话模型**（无小模型档位，除非写扩展拦截） | 结构化 6 节（Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context）+ 第二次起用 UPDATE 模板（首条规则 = PRESERVE all existing information） | `retryAssistantCall` 重试；摘要请求 `cacheRetention:"none"` |
| tw | Topic：**表达模型**（temp 0.3）；Psyche：**反思模型**（独立配置，默认 gpt-4o-mini） | Topic：产 topicName/description/keywords/category/userProfile；Psyche：8 字段结构 | 反思有滑动窗口与最少保留 4 条 |
| cx | **主模型**（把 `SUMMARIZATION_PROMPT` 作为一条 user 消息记入 history，再跑一次普通推理，取最后一条 assistant） | 模板仅 9 行：进度与决策 / 上下文与约束与偏好 / 剩余待办 / 继续所需数据 | 若摘要自身超窗，**从头删最老的一条再重试** |
| hm | **辅助模型**（`auxiliary.compression`，单次调用） | 契约式 13 段，含 `## Historical Task Snapshot`（逐字引用用户最新未完成输入，并识别 stop/undo 反向信号）、`## Completed Actions` 带 `[tool: name]`、`## Detailed Session Log` | 摘要模型失败 → 回退主模型一次 → 冷却 → **确定性本地正则兜底摘要** |
| ex | **默认不是模型**（统计折叠：轮次范围 + 工具足迹 + 导航记录）；LLM 折叠须宿主注入 `summarizer` | LLM 折叠固定 5 节（阶段 / 已改文件 / 已验证项 / 下一步 / 主题词面包屑），`maxSummaryTokens=800` 按分节优先级削 | 统计折叠无失败面；LLM 折叠无 summarizer 直接抛错（不静默降级） |

**要点**

- 「摘要用主模型」是 pi / cx 的选择（质量一致但贵且与主上下文竞争）；hm 明确用辅助模型并可回退；tw 用两个专用模型；ex 干脆把语义摘要**外包给宿主**，开箱给的是**索引而非总结**。
- hm 的「正则锚点索引」（PR / SHA / 路径 / 错误串，**不经过 LLM**）是对「让模型复述精确标识必然丢东西」的正面回答，所有实现都值得抄。
- ex 的「没有 summarizer 就抛错」避免了「摘要静默变空转」。

### 3.3 压缩时保留什么（最能区分路线）

| | 保留 | 丢弃 |
|---|---|---|
| pi | 最近 ~20k token 原文 + 结构化摘要 + **跨次累积的文件账本**（`<read-files>`/`<modified-files>`） | 被摘要的历史（但对摘要模型的输入里 tool result 硬截到 2000 字符） |
| tw | Topic：**不删任何消息**，只改 `topic_id` 归属 + `carryMessageIds` 迁移本轮 user；compactor：头部任务消息 + 最近 6 轮；Psyche：结构化字段 | compactor 折叠掉的中间轮次（只留调用计数）；Psyche 被裁剪的 key_exchanges |
| cx | **只有真实 user 消息**（从尾往前累到 20k token 预算）+ 一条 `CompactionSummary` | assistant 消息、reasoning、**工具调用与工具输出全部丢弃** |
| hm | 头部 3 条 + 尾部 `clamp(2.5%×窗口,10k,25k)` token（至少 1 条真实 user）+ **每条真实 user 消息逐字引用（24k 字符）** + 正则锚点索引 + 最近 6 轮工具结果 + 最新 3 张工具图片 | 中间轮次；旧工具结果先降级为 `[Old tool output cleared…]` |
| ex | `keepRounds=6`（>2× 预算时收紧到 2）+ 受保护的真实 user 消息 + `replayable:false` 捕获的无损 stub（≤10 条）+ notes 目录 | 被折轮次（但原文写入 `foldedPayload`） |

**要点**

- **cx 是唯一默认丢弃工具输出的**：这意味着默认路径下「我之前读过什么」在压缩后不可恢复——它自己也发 warning「长线程与多次压缩会降低准确率，尽量新开线程」。
- hm 的「每条真实 user 消息逐字引用」+「反向信号识别（stop/undo 取消旧任务）」直接命中压缩后最常见的失败模式：答非所问、把已取消的任务当待办。
- pi 的**文件账本**与 ex 的**导航记录**（`{roundFrom,roundTo,artifacts:[{id,locator,digest,status}]}`）是同一思路：摘要文字可以模糊，「碰过哪些文件」这类硬事实不能丢。

### 3.4 产物与「压缩后能否取回原文」

| | 产物位置 | 原文是否还在 | 模型侧召回手段（默认） |
|---|---|---|---|
| pi | 同一个 session JSONL 的 `CompactionEntry`（append，不删行） | **在**（旧 JSONL 行） | 无专用工具；靠 bash 环境注入的 `PI_SESSION_FILE` 让模型自己 grep/read 那个 jsonl |
| tw | Topic 行（status='archived'）+ 新 active topic 行；compactor 纯内存替换 | **在**（`messages` 表 + `tool_calls.result`） | `recall`（topic/messages/notes 三种 mode）；并有**主动召回** `RecallStrategy`（preCheck 规则 → 最多 2 次调用 / 2500ms 超时 → postCheck 证据链校验） |
| cx | rollout jsonl 的 `RolloutItem::Compacted`（+ window id 递增） | **在盘上，但模型侧默认拿不到** | 默认无；需开启 `token_budget` + history-notes 扩展才得到 `history.*`（list_windows / read_item / search_contents，服务端 `alpha/history` API）+ `notes.*` 便签 |
| hm | `state.db` messages 表**就地**软归档（老行 `active=0, compacted=1`），watermark 保证压缩期间新到的行不被吃进摘要 | **在**（仍可被 FTS5 搜到） | `session_search`（单工具多形态：关键词 / 锚点窗口 / 整段 / 浏览，**不打 LLM**）；FTS5 过滤条件显式包含 `compacted=1`；摘要与 stub 里都写死了恢复指令 |
| ex | round record 的 `foldedPayload` + transcript JSONL + checkpoint；摘要块合并进最早真实 user 消息 | **在**（字节保真） | 引擎内置 `recall`（三级渐进、四路语料）；stub 内嵌 `recall({round, pattern})` 配方 |

**这就是「两条路线」的定义**：
- **无损召回派**（hm / tw / ex / pi）：压缩只改「进入上下文的路径」，并**在信息被藏掉的原地**给出召回方式。区别只在召回是「专用工具」（hm/tw/ex）还是「让模型自己 grep 备份」（pi）。
- **有损摘要派**（cx 默认）：压缩是丢弃，取回要靠显式开启另一套 feature + 服务端 API。

---

## 4. 技能与工具调用

### 4.1 暴露方式与预算

| | 暴露模型 | 延迟加载 / 工具搜索 | 工具 token 预算 |
|---|---|---|---|
| pi | 7 内置工具，默认启用 4 个；**全量注入 schema**（system prompt 里每工具一行 snippet） | 官方支持但**引擎不在本包**：扩展自己写 loader（`setActiveTools` 纯增量）+ provider 原生 `defer_loading` / `tool_search_call` | **未找到** |
| tw | 内置 11 + 全部技能工具 + MCP 工具，**全量注入** | **未找到** | **未找到**（`_debug.tools_count` 只用于日志） |
| cx | `ToolExposure` 六值（Direct / Deferred / DeferredModelOnly / DirectModelOnly / CodeModeOnly / Hidden） | 有：`tool_search` 用 **tantivy BM25**（默认 8 条）；MCP 工具在 `tool_search` 可用时统一降级为 Deferred | 未找到 schema 总预算；agent/plugin MCP spec 有 8 KB / 64 KB 硬预算 |
| hm | 注册（registry）与可见（toolset）**两级**；core ~40 常驻 | 有：`tool_search`/`tool_describe`/`tool_call` 桥；**清单本身三级退化**（名字+描述 → 只有名字 → 每源一行）；清单预算 5% × 窗口 / 4000 tok；本地 BM25 + Snowball | 同上（清单预算即工具面预算） |
| ex | 宿主全量注入；引擎内置仅 `recall` 1 个 | 本地工具无；**MCP 走单代理工具** | **未找到** |

**要点**

- tw 是唯一「注册即全量可见」的实现：技能一多，tools 数组线性膨胀，且没有税（预算）——这是最容易被工具数量击穿的一家。
- **三种解法各有适用面**：cx/hm 的 BM25 工具搜索适合「工具池很大、单轮只用几个」；ex 的单代理工具适合「工具来自 N 个外部 MCP server、不值得逐个暴露 schema」；pi 的「全量默认 + 扩展自选」适合「内置工具少、扩展需要精细控制缓存」。
- hm 记了一条很实用的观察：模型会**用可见的 core 工具绕过延迟工具**（例如在终端跑 `gh`），或干脆宣称没有该能力——所以延迟加载必须同时给「清单」。

### 4.2 MCP

| | 命名空间 | 结果处理 |
|---|---|---|
| pi | **无内置 MCP**（`docs/usage.md` 明确声明），只能写扩展；**无命名空间约定**，registry 同名覆盖 | — |
| tw | `mcp_{server}_{tool}`，描述前缀 `[MCP/{server}]`；每次取定义先清空重建注册表 | — |
| cx | `mcp__<server>__<tool>`；hooks 侧统一补前缀 | — |
| hm | `mcp__<sanitizedServer>__<sanitizedTool>`，超 64 字符追加确定性 hash 后缀 | 过滤 `_meta`；图片/音频落盘成 `MEDIA:<path>`；**未知内容块不静默丢弃**而是内联 type/mime/uri/size 提示 |
| ex | 单代理 `mcp`，action = `list/search/call/status`；内部 ID `mcp_<server>_<tool>`（最长 server 名前缀解析）；server 懒启动 + 连接池按 (name, cwd, configPath, config) 复用 | 结果截 4096 字符 + 原始字数 |

**要点**：`mcp__server__tool` 是事实共识（cx/hm），tw 用单下划线；ex 直接把这层压成一个 schema。若你的 MCP server 数量少（<5），单代理工具的 token 收益最大；数量多且需要按名精确调用时，双下划线命名 + 工具搜索更合适。

### 4.3 技能（skill）机制

| | 发现 | 常驻注入 | 渐进加载 | 执行 |
|---|---|---|---|---|
| pi | 目录含 `SKILL.md` 即技能根（不再下钻）；源：`~/.pi/agent/skills`、`~/.agents/skills`、`.pi/skills`、项目 `.agents/skills`、package、settings、`--skill` | `<available_skills>` 里只有 name / description / location | 系统提示让模型 **用 read 工具读技能文件**（无专用执行器）；`disableModelInvocation` 的技能只能 `/skill:name` 调用 | 模型读文件后自行照做 |
| tw | **无开机自动扫描**：由「技能管理专家」读 SKILL.md 再用 `skill-manager` 技能的 `register` **写 DB**（`skill_tools` 表） | system prompt 只给「标识 → 名称 → 使用场景」表 + 命名空间说明 | SKILL.md **不进 prompt**，靠技能模式把工作目录指向技能目录、提示 `cat SKILL.md`；工具描述只取第一句 | 子进程 `skill-runner.js`（路径白名单 + 模块白名单 + 60 s / 128 MB 限额）；驻留技能常驻进程 |
| cx | host provider 提供技能源，按 `SkillListQuery` 过滤；scope 权重 `System < Admin < Repo < User` | `<skills_instructions>` 块：name + description + locator | 协议写死在块里：**必须先完整读 SKILL.md 再动手**（分页跟随 `next_cursor` 到 EOF）；引用文件按路由按需读；**禁止把读/摘要技能说明外包给子 agent** | 主 agent 读文件或调 `skills.read` / `skills.list` |
| hm | 递归扫 `<HERMES_HOME>/skills/` + 外部目录 + 项目本地；frontmatter 条件激活规则 | `<available_skills>` 索引进 volatile 层（措辞强制「相关就必须 `skill_view`」）；`compact_categories` 只降级为只有名字，**从不隐藏** | Level 0 索引 → Level 1 `skill_view(name)` 拿全文 → Level 2 `skill_view(name, file_path)` 拿 references/templates/scripts | 加载时做 `${HERMES_SKILL_DIR}` 模板替换；`!`cmd`` 内联 shell **默认关闭**；`auto_load` 技能整块进 stable 层 |
| ex | 目录 + `skill.mjs` 导出 `getSkillDefinition()` **自描述**（宿主不维护清单）；三处发现：内置 `skills/`、`~/.erix/skills/`、`<cwd>/.erix/skills/` | **全量注入工具面**（ADR-008 明确把渐进披露换成脚本自描述） | 无（没有按需 describe） | `import()` 进**同一进程**执行（不做子进程隔离）；工具名冲突则报错并整体跳过该 skill |

**要点**

- 唯一「工具面全量、无渐进」的是 ex；唯一「技能需要先注册进 DB」的是 tw；唯一把「先完整读 SKILL.md」写成协议硬规则的是 cx。
- hm 的渐进三级 + 索引强制措辞 + `auto_load` 冻结到 stable 层，是工程完备度最高的一套。
- 执行隔离上只有 tw（子进程 + 限额）与 hm（`!`cmd`` 默认关）做了实质约束；pi / cx / ex 的技能就是「读文件后照做」。

### 4.4 权限与审批

| | 机制 |
|---|---|
| pi | 项目**信任门**（决定是否加载项目本地 settings/resources/extensions，是输入加载守卫而非沙箱）+ 扩展 `tool_call` 钩子（可 `{block:true}`，`event.input` 可就地改写）；无内置沙箱 |
| tw | 只有两层：`allowedRoles` 角色白名单（如 `execute` 仅 admin/creator）+ 技能子进程沙箱；**无工具级人工审批** |
| cx | permissions 作为 world state section 注入（profile / approval policy / 已批准前缀），用 fragment SHA1 比较、只在变化时重发；每次调用前后跑 pre/post-tool-use hook |
| hm | 统一 gate：硬线规则 / permanent allowlist / user deny / sudo-stdin 守卫 / gateway 排队等人类 / smart guardian LLM；`HERMES_YOLO_MODE` 在 **import 时冻结**（防运行期改环境变量绕过）；另有循环护栏（per-turn 上限、重复失败 warn/block、无进展阈值） |
| ex | **无**（ADR-009：库零执行零安全规则）；只有 schema 求交校验 + 宿主自己的 `executeTool` + 可选 judge 拦截（每 N 次执行后审下一次） |

---

## 5. Per-user 长期记忆

| | 有无跨 session 记忆 | 存储 | 写入方式 | 隔离维度 | 检索 |
|---|---|---|---|---|---|
| pi | **无内置** | — | 人或模型直接改 `AGENTS.md`（user = `$HOME` 全局 + 项目层级）+ session JSONL + 扩展自管文件 | `$HOME`（隐式）/ cwd（session 目录按 cwd 编码）；**无 user 维度、无 agent 维度** | grep / read（无索引） |
| tw | **有** | MySQL 三表：`topics` / `messages` / `user_profiles`；Psyche 与 Notes 默认进程内存（TTL 1 h / 24 h，可切 Redis） | topic 压缩时表达模型自动产出 topicName/keywords/userProfile + 反思强制压缩 + `notes_take` 显式 | **`user_id × expert_id`**（无 project 维度）；`recall detail` 校验 `user_id` 防跨用户 | SQL `LIKE` on title/description/keywords + 启发式重排（标题 +8 / 包含 +5 …）；**无向量** |
| cx | **有** | `$CODEX_HOME/memories(_v2)`：`memory_summary.md` / `MEMORY.md` / `raw_memories.md` / `rollout_summaries/` / `skills/`；中间状态在 sqlite（`stage1_outputs` + `jobs` 租约表） | **两阶段后台 LLM 流水线**：stage1 从 state DB 领 rollout 抽结构化记忆 → stage2 consolidation 子 agent 消费 git workspace diff 重写 `MEMORY.md`；显式写入只有 `memories.add_ad_hoc_note`（仅用户明确要求时） | **user / codex_home**（记忆根在 home 下，**不按 project**，靠 `MEMORY.md` 块头 `applies_to: cwd=<path>` 区分）；子 agent 不跑写流水线 | 每轮注入 `memory_summary.md`（截 2500 tokens）；工具侧 literal substring（`memories.search` 默认 200 条）；`memories.dedicated_tools` **默认关闭** |
| hm | **有（profile 粒度）** | `<HERMES_HOME>/memories/MEMORY.md`（2200 字符）+ `USER.md`（1375 字符），`§` 分隔 | 显式 `memory(action=add/replace/remove/batch)`（**无 read**，读靠注入）+ **每 10 轮后台 review fork**（`skip_memory=True`，不污染主对话与缓存）+ 外部 provider `sync_turn`；**超限直接报错不静默丢** | **profile**（一个 profile 一个 home）；同一 profile 下所有 gateway 用户**共享** `MEMORY.md`/`USER.md`；per-user 需外部 provider（honcho `peerName` / openviking user scope） | 内置为「冻结快照注入 system prompt」；外部 8 个 provider 各自不同（FTS5+HRR / 向量+BM25+rerank / 知识图谱 / 文件层级 …），同一时刻**只允许一个**外部 provider |
| ex | **无跨 session** | `~/.erix/notes/run/<runId>/<key>.json`（0700/0600）+ transcript JSONL | `note_take` 显式 + 不可重放 `exec` 自动捕获（`auto-<hash>` 键）+ `completeRun` + janitor（宽限 24 h）；原则是「主循环零写工具」 | **只有 run**（schema 允许 `run\|project\|user` 但非 run 值直接报错）；REPL 默认 runId = `<cwd>-<hash8>`（同目录可续），`chat` 每次新 run | 精确 key + `note_list` 目录枚举；折叠时把 ≤20 条 active 笔记渲染成目录（1200 字符）注入 semantic 槽位 |

**要点**

- **隔离维度的四套答案**：`$HOME`（pi）/ `user_id × expert_id`（tw）/ `codex_home`（cx）/ `profile`（hm）/ `run`（ex）。真正做了 per-user 字段级隔离的只有 tw；hm 把它交给外部 provider；cx 与 pi 是「一个 home 一个用户」；ex 明确单用户信任域。
- **写入策略的共识**：主循环尽量少写、整理移到冷路径。四处实现（hm 的 review fork、cx 的两阶段流水线、ex 的 janitor、tw 的 topic 压缩顺带）都是这个思路的不同变体。
- **检索方式的现实分布**：文件 + 关键字（pi / cx / ex）、SQL LIKE（tw）、FTS5（hm 内置 provider / tw 文档平台）、向量/图（仅 hm 的外部 provider）。**「记忆 = 向量库」在这五个实现里都不是默认答案**。
- hm 的「冻结快照注入」是一个被低估的设计：会话中写入只落盘、不改 prompt，既省 token 又避免缓存击穿；代价是「刚记住的事本轮看不到」。
- ex / pi / cx 的长期记忆都是**可被人类直接读写的文件**（notes json / AGENTS.md / MEMORY.md）——可审计、可手改、可 git 回滚，是刻意的取舍。

---

## 6. 横向谱系：分水岭与相对位置

### 6.1 五个实现的一句话画像

- **pi**：**极简内核 + 全扩展化**。工具少、system prompt 短、压缩用主模型、没有 MCP / 长期记忆 / 沙箱，但每个缺口都留了干净的钩子；截断提示语质量全场第一。适合「交互式、人类兜底」。
- **touwaka**：**数据库驱动的多租户业务 agent**。能力全（topic / 画像 / Psyche / Notes / 主动召回 / 委派），但三套折叠机制语义重叠、prompt 缓存完全未利用、长期记忆检索只有 LIKE；用户画像甚至「存而不用」。适合「结构化业务场景 + 服务端多用户」。
- **codex**：**把上下文当作有类型、可 diff、可回放的系统状态**。world-state 增量 diff + `ContentItemKind` + 稳定 id 是全场最强的工程抽象；代价是 default-off 的 feature 太多、压缩默认丢工具输出、抽象成本高（单目录 5000+ 行）。适合「长会话 + 强缓存诉求」。
- **hermes**：**把 prompt 缓存稳定性当一级架构约束的通用 harness**。三层 prompt + 冻结快照 + `api_content` 重放 + 软归档 + FTS5 召回 + 四层输出防线 + 三级工具清单退化，工程完备度最高；代价是反抖动状态机与持久化 prompt 校验带来的复杂度，以及 per-user 记忆缺位。适合「多平台 gateway + 长会话」。
- **erix-agent**：**无头运行时里的「压缩即可召回」最小闭环**。不做工具面、不做指令文件、不做长期记忆，但把「折叠后原文可字节保真召回」这条链路做成引擎内置能力（`recall` 工具 + `outputHygiene` 归档 + stub 内嵌配方），并且「说出口必兑现」（缺 store 直接抛错）。适合「宿主编排的无头任务」。

### 6.2 三条分水岭

1. **压缩是「改路径」还是「丢内容」** → 决定阈值高低、召回工具有无、以及「压缩后还能不能继续动手」。
   `无损召回派`（hm > ex ≈ tw > pi）↔ `有损摘要派`（cx 默认）。
2. **prompt 缓存是否成为架构不变量** → 决定每轮动态内容走 system prompt 还是 user 消息/工具结果。
   `强`（hm ≈ cx）> `中`（pi）>> `弱`（tw / ex）。
3. **per-user 长期记忆有没有真正的租户边界** → 决定多用户场景能否共享一个部署。
   `有字段级隔离`（tw）> `靠外部 provider`（hm）> `一个 home 一个用户`（cx / pi）> `无`（ex）。

### 6.3 本项目（ex）在谱系中的位置

| 维度 | ex 的位置 | 差距/优势 |
|---|---|---|
| 上下文构造 | **最简**：引擎不拼 prompt，宿主全权 | 差距：无 fragment 类型体系（cx）、无缓存分层（hm）。优势：引擎与宿主契约清晰，宿主可自由定制 |
| 工具输出截断 | **中上**：四道闸门 + 引擎层归档 + 字节保真召回 | 差距：无单轮聚合预算（hm 独有）、无同调用去重、无按窗口缩放；工具级阈值偏小（4096）导致归档频繁 |
| 折叠与召回 | **第一梯队**：三级渐进 recall + 四路语料 + stub 配方 + marker 合并防堆叠 | 优势：召回是**引擎内置且默认注册**（不像 cx 要开 feature、pi 要模型自己 grep）；折叠默认零 LLM 成本且摘要不漂移。差距：无基线对比实验证明召回质量 |
| 技能与工具 | **最简**：全量注入、脚本自描述、同进程执行 | 差距：无渐进披露（ADR-008 是明确取舍）、无工具搜索、无审批（ADR-009 是明确取舍）、技能无隔离 |
| Per-user 记忆 | **无**（run 作用域 notes） | 差距：这是与 tw/cx/hm 差距最大的一维；ADR-007 的 L2/L3 仍是路线图 |

### 6.4 未被任何一方解决的共同难题

- **「压缩后仍能正确继续」缺乏验证手段**：五家都只提供机制与提示语，谁都没有内置「压缩后重放历史任务看是否退化」的评估（hm 有 `evals/compaction`，cx 有指标，但都不是闭环）。
- **精确标识的保真**：只有 hm 用正则锚点索引正面解决；其余依赖摘要模型复述。
- **多轮压缩的语义漂移**：pi 用「第二次起用 UPDATE 模板（PRESERVE all existing information）」，ex 用 marker 合并，hm 用「上一份摘要作为 Previous Summary Snapshot」；tw 三套机制并存时没有统一保证。
- **「模型不按提示召回」**：hm 用 Tool Search 清单暴露了这个现象（模型宁愿用可见工具绕过），但五家都没有「强制召回」手段，只能靠提示语强度。
