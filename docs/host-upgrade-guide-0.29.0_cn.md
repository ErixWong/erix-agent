<!-- doc-version: 0.29.0 -->
# 宿主升级指南：0.29.0

**版本：0.29.0（2026-10-31）。** 这一版让库学会**给子 run 记账**，而它自己从不启动任何东西。`runToolLoop`
的输入面一处没动：没有选项被退役、改名或搬家，所以只把版本号抬上去、别的一行不改的宿主，行为与以前逐字
一致。新增的是一条显式开启的面——`erix-agent/tools` 上的 `createDelegateTool`、一个配置叶子
`config.run.parentRunId`、五个**由你提供**的端口——外加一批只为了让名册与工具结果**说真话**的修正。

如果你既不调 `createDelegateTool`、也不传 `parentRunId`，对你可见的变化就是**名册多了三个字段**（§4），
仅此而已。如果你确实要派生，请先读 §3 再读 §2：宿主出错的地方都在端口上，而四个可选端口**全都是静默失败**
——失败的样子长得像「子 run 不听话」。

所以是两片。**§2–§5 是派生那一片**：一条新增的显式开启面，加上让它的记录说真话的那批修正。**§7 是压缩与
续接那一片**：一处默认值变了、一处文本形状变了、三处新事实要看——如果你解析折叠块文本、按事件名过滤告警，
或自己跑摘要器，请读它。§6 点名列出版本里其余的东西，§8 是「没有变的东西」。

## 1. 变更总览

| 你要改什么 | 为什么改 | 见 |
|---|---|---|
| 从 `erix-agent/tools` 导入 `createDelegateTool`（显式开启：库不替你注册任何东西） | 派生是簿记，库没能力启动子 run | §2 |
| 子 run 传 `config.run.parentRunId` | 一个不透明身份，镜像到四处，库从不解释它 | §2 |
| 接 `runChild`（必需）与 `notifyParent` / `transcriptPathFor` / `cwdFor` / `isProcessAlive`（可选，每个都有点名的代价） | 库不 fork、不猜你的目录布局、不替别人发明死亡 | §3 |
| 预期名册 21 个字段、`result.text`、`tail` 的两种失败理由 | 答不出「它到底说了什么」的记录不算记录 | §4 |
| 不派生的话：什么都不用改 | 没有选项搬家，读侧一行未动 | §8 |
| 如果你解析折叠块文本、按事件名过滤告警、或自己跑摘要器，请读 §7 | 一处默认值变了、一处文本形状变了、三处新事实要看 | §7 |

### 本版动到的宿主可见表面

* `src/tools/delegation/tool.js` — 工具工厂、六个动作与终止态映射（`createDelegateTool`）。
* `src/tools/delegation/roster.js` — 21 字段记录、读侧形状闸、陈旧重算（`reconcile`）。
* `src/tools/delegation/capacity.js` — 固定槽位池（`acquire` / `release`），跨进程原子。
* `src/tools/delegation/tail.js` — `action=tail` 背后的有界尾读（`tailChildTranscript`）。
* `src/tools/delegation/notify.js` — 完成标记键（`completionMarkerKey`）与固定前缀的一行式通知。
* `src/tools/index.js` — `erix-agent/tools` 的再导出（纯加法）。
* `src/loop/orchestrator.js`、`src/loop/judge-record.js`、`src/loop/config-namespace.js` —
  `config.run.parentRunId` 与它的四处投影。
* `bin/delegation.js` — CLI 对这套工具的装配：可运行示例，不是契约。
* `docs/host-consumer-contract.md`（与 `_cn`）—— 权威契约，全篇同步更新。

## 2. 新增公共面：一个工厂 + 一个叶子

`createDelegateTool({ runChild, rosterDir, … })`（`src/tools/delegation/tool.js`）返回
`{ definition, execute }`，与 `erix-agent/tools` 上其他工具同一个形状。一个工具、**六个动作**
（`DELEGATE_ACTIONS`）：`run`、`status`、`result`、`list`、`cancel`、`tail`。没有 `pause` / `resume` /
`retry`：一个重启不了子 run 的 v1，不许在描述里声称自己能重启。

| 动作 | 它回答什么 | 它不做什么 |
|---|---|---|
| `run` | 起一个子 run（前台，或 `background: true` 后台），返回子 `runId` | 从不 fork——它调你给的 `runChild` |
| `status` | 一条名册记录（先过陈旧重算） | 不消费完成事件 |
| `result` | 终态记录**加子 run 的终稿**；并把它标记为已自取 | 对活着的子答 `still_running` |
| `list` | 全部记录，外加 `corrupt` / `interrupted` / `foreignOwned` / `unverified` 四个桶 | 不隐藏任何一个桶 |
| `cancel` | 掐掉**本进程持有**的子 run | 对别人的一律答 `not_owned` |
| `tail` | 子 run transcript 尾部的有界读 | 不修复文件、不做重算 |

有两个形状值得钉住，因为宿主会照着它们写代码：前台 `run` 直接返回子的 `text` 与 `termination`；后台 `run`
返回 `state: "running"`，父 run 之后用 `result` 取终局。`list` 把四个桶作为**具名数组**返回，于是「一条记录
都没被动过」是可观测的，而不是靠推断。

`parentRunId` 是这条面的另一半。`config.run.parentRunId` 是一个引擎**只镜像、从不解释**的不透明字符串，从
同一个来源投影到四处：judge 记录的关联字段（`judgeRecordFields`（`src/loop/judge-record.js`））、
`run_outcome` 事件、每一条 `onEvent` 载荷、以及诊断 / 观察者错误的 detail。给子 run 设了它，宿主就能把子的
记录 join 到父的上面，不用解析任何东西。**它不是模型入参**：派生工具从执行上下文（`context.runId`）自取父
身份，它的 input schema 里根本没有 `parentRunId` 这个键——模型能填的身份就是能被伪造的身份。

## 3. 五个端口，以及漏接每一个的代价

库对「子 run 怎么跑」「它的 transcript 落在哪」「它跑在哪个目录」「某个 pid 还活着吗」一律没有意见。这四件
事各是一个端口。只有 `runChild` 是必需的；另外四个都可选，而**四个都是静默失败**——所以这一节值得读两遍。

### `runChild`（必需）——子 run **是什么**由你定

`runChild({ task, cwd?, parentRunId?, runId, model?, deadlineMs?, signal })` 返回
`Promise<{ text, termination?, verification? }>`。库不 fork、不 spawn、也不 import `child_process`：同进程、
子进程、远端 worker 都一样可以。你返回的 `termination` 必须用库的词汇——`TERMINATION_TO_STATE`
（`src/tools/delegation/tool.js`）把 `end_turn` / `judge_done` 映成 `completed`、`aborted` → `aborted`、
`timeout` / `timed_out` → `timeout`，而**其余一切（包括没列出来的词）→ `failed`**。别自创终止词：它会被
如实记下、并被读成失败。`runChild` 缺失会在工厂构造期抛——这一节里唯一一个响的失败。

### `notifyParent`（可选）——没有邮箱

后台子 run 到达终态时，`notifyParent(line)` 被调一次，参数是 `notificationText`
（`src/tools/delegation/notify.js`）拼出来的一行式文本——固定前缀在**代码里**（不在提示词里，所以上下文压缩
没法把它挪到别处）、子 `runId`、有则带 `parentRunId`、状态与 `endedAt`。不给它，你就一次唤醒都收不到：完成
事实照样写进名册，父 run 靠轮询 `status` / `result` / `list` 找到它。**没有**通往运行中 `runToolLoop` 的
队列，假装有是更糟的契约。这个回调按 `(runId, endedAt)` 二元组去重：已经用 `result` 自取过终局的父 run 不会
为同一次完成被再唤醒一次；而续跑复用同一个 `runId` 的那一次完成**会**再唤醒，因为那是一次新的完成。

### `transcriptPathFor`（可选）——不接它，`tail` 永远答 `no_transcript_path`

`transcriptPathFor(runId) => string` 告诉库「子 run 的 transcript 正写在哪」。记录是库建的，库不知道你的目录
布局，所以名册里的 `transcriptPath` 字段只有**你**填了才有。给了这个端口，路径就写进**创建记录的那一次原子
写**，所以派生后立刻 `tail` 的父 run 已经看得见——不存在「先建记录、再补写第二遍」的窗口。不给，字段照旧
缺省，而每一次 `tail` 都答 `no_transcript_path`——那是**你这侧**的配置缺陷，不是子 run 没了。路径请用你
store 自己的命名助手推导，不要自己拼 `<runId>.jsonl`：store 会把它认为不安全的 id 哈希掉，手拼的路径对那一
类 id 恒错，而错法只是「文件永远不存在」。返回值必须是非空字符串，否则在任何租约或记录落盘之前就抛。

### `cwdFor`（可选）——不接它，名册的 `cwd` 是请求、不是事实

`cwdFor(requested, runId) => string` 是子 run **实际**跑在的目录。模型给的 `cwd` 是请求：库不解析相对路径，
也不知道你的缺省目录是谁。给了这个端口，库就**只解析一次**，并且**同一个值**既写记录、又交给 `runChild`
——不存在「记录一个目录、执行另一个」。返回值必须是非空字符串，否则工厂当场抛。不给就保持旧行为，而那个旧
行为的老实话是：**名册的 `cwd` 字段不代表子 run 实际跑在哪。** 想要记录为真的宿主应当总是提供它；CLI 就是
这么做的（`cwdFor: (requested) => path.resolve(requested ?? parentCwd)`）。

### `isProcessAlive`（可选）——不接它，你拿不到任何陈旧清理

`isProcessAlive(pid) => boolean` 是陈旧重算用的存活谓词，它把「另一个宿主在同一个名册目录里养着的活子」
（列进 `foreignOwned`，记录一个字节都不动）与「已经没人认领」（写成 `interrupted`，且 `endedAt` 取那条记录
自己的 `updatedAt`，不是探测时刻）分开。**不给谓词，库就拒绝做任何判定**：带 `pid` 的活态记录进单独的
`unverified` 桶，盘上原样不动。这个取舍是刻意的——替别的进程的活子发明一个死亡是更糟的失败，而它在真机上
发生过（进程 A 派发了后台子，进程 B 只调了一次 `status` 就把 A 的记录改写成了 `interrupted`）。代价写在明面
上：**不接谓词，就没有陈旧清理。** 这条路不是只有长驻守护进程才会遇到：名册目录缺省是 `~/.erix/delegation/`，
也就是**共享**的，两个并发 CLI 会话就会踩上。CLI 传的是真谓词（`process.kill(pid, 0)`：成功 ⇒ 活，`EPERM`
⇒ 活但没权限，`ESRCH` ⇒ 死）。

## 4. 名册与结果现在会说什么

七处修正，方向是同一个：记录与工具结果不许让父 run 去猜。

* **名册是 21 个字段，不是 18 个。** 新增三个——`resultText`（子的终稿）、`resultTruncated`（恰好是
  `true`，且只在文本被截断时出现）、`errorMessage`（只在子抛错时写）。三者都落进**存终态 `state` 的同一次
  原子写**，不是事后补写第二遍，所以看到终态的 `result` 一定也看到与之配套的文本。没给的字段照样不出现，
  不写占位值。
* **`action=result` 带回子 run 的终稿。** `result` 返回终态记录的字段，再加 `text`、被截断时的 `truncated`、
  子抛错时的 `error`。两个上限：文本 **4000** 字符、错误 **1000** 字符。设上限不是为了整洁——子的终稿可能
  是一整份长报告，原样塞回父 run 的上下文等于把子那一轮的 token 账再付一遍；要细节的父 run 用 `tail`。
  在此之前，后台子 run 的终稿被直接丢掉：父只拿到 `state` 与 `termination`，答案是「猜」。
* **`tail` 把两种失败分开，而这个区分本身就是契约。** `no_transcript_path` 是记录里没有路径（**你这侧**的
  配置缺陷）；`no_transcript` 是路径在、文件不在或打不开（子还没落第一行，或档案已清理，**正常时序**；打不开
  时另带一个说明原因的 `detail`）。把两者合成一个，就会把「你没接」读成「子没干活」。读是有界的：缺省 8 行、
  上限 **20** 行、每行 300 字符（硬上限 1000），每行对工具调用给出工具名与参数摘要。`truncated: true` 表示
  更早的行没给；`partial: true` 表示最后一行正在写、被丢掉而不是当成乱码展示。
* **并发上限是槽位池，而且跨进程原子。** 抢一格现在是**一次独占创建**（对 `slot-<i>.lock` 用
  `open(..., "wx")`），判定与占位是同一次系统调用：两个进程再也不可能同时读到「还剩一格」然后各自建一份。
  池子满了是结构化失败（`capacity_full`，点名持有者）——不排队、不自旋。持有者能被**证明**已经不在了的格子
  当场回收：租约里带 pid 时由你的存活谓词裁定，只有没给谓词时才退回 30 分钟的年龄阈值（是兜底而不是权威
  判据，所以子 run 自己的时间预算应当明显低于它）。回收会再读一次那一格，只 unlink 它判定已死的那个确切
  持有者；归还则只删格里记着调用方自己身份的那一格。旧版本写的租约文件不再计入配额，也永不被删（它们本来
  就是短命文件，留着无害）。
* **`reconcile` 多了 `unverified` 桶，而 `running` 现在是你真会看到的状态。** 记录走 `queued` → `running` →
  终态，而 `running` 是在库调你那个子 run 函数**之前**写的——在此之前，那个七值状态机从来没写过 `running`，
  于是「在干活」与「卡在队列里」在名册上长得一模一样。`status`、`result`、`list` 都先跑重算；因为所有者死
  了而卡在活态的记录，以前会永远答 `still_running`，现在返回终态。真正在跑的子 run 照旧答 `still_running`
  ——重算不是「一律判死」的许可证。
* **显式 `--compact-budget` 会被子 run 继承。** 子 run 以前建压缩上下文时**完全没有**显式预算，于是父在
  命令行给的预算在子那一侧静默消失，只剩从配置的上下文窗口推出来的那个值。没给显式预算时旧推导照旧，
  一字不变。这一条是 CLI 接线而不是库的默认值：引擎从不为子 run 发明一个预算。
* **完成标记键多了分隔符。** `completionMarkerKey`（`src/tools/delegation/notify.js`）以前把 `runId` 与
  `endedAt` 直接拼在一起，中间什么都没有，只靠「时间戳恰好 13 位」才不碰撞。现在键是 `runId:endedAt`，于是
  `("a1", 23)` 与 `("a", 123)` 是两次不同的完成。如果你把 `collected` 标记持久化到重启之后，0.28.0 写下的
  旧键对不上：最坏情况是你已经自取过的那一次完成又唤醒你一次，而标记会在下一次 `result` 时以新形态重新记上。

## 5. v1 的边界（写清楚，不粉饰）

* **派生不递归。** 子 run 的工具面不含 `delegate` 本身，而且在进引擎之前就用父的工具白名单过滤过——派生绝不
  扩权。没有白名单时子照旧拿全量，与以前逐字一致。
* **`cancel` 只够得到本进程。** 它掐的是本工具实例为某个后台子 run 登记过的 `AbortController`；别的对象一律
  答 `not_owned`。它不撒谎，也不伸手进别人的进程。
* **`tail` 是读，读不修复。** 它走 store 的只读尾读，绝不走那条会 `repairTranscriptTail` 的加载器——对一个
  别的进程正在追加写的文件动刀，等于在那进程脚下把它截断。它**也不重算**：一边读别人的子、一边改写别人的
  名册记录，正是 `unverified` 桶存在要避免的越界。
* **回收窗口没有闭合。** 在第二次快照与 `unlink` 之间，两个进程可能同时对同一格判定同一个死持有者；Node
  核心没有 `flock`、也没有条件 unlink，所以这一片不假装能闭合它。窗口只有几微秒宽，且要求两个进程在同一
  瞬间打同一格。它能造成的代价是多发一格配额，不是一个丢掉的子 run。
* **没有队列，也没有守护进程。** 池子满了是结构化失败；崩溃的租约只在有人来抢那一格时才被回收。

## 6. 0.29.0 还带了什么

点名列出来，好让你自己决定要不要深读；每一项都有自己的 `CHANGELOG.md` 条目与契约小节。

* `createAgent({ config, capabilities, … })`（issue #571）——`runToolLoop` 之上的纯加法包装：只定一次的选项
  由 agent 对象拿住，`agent.run(input)` 只接受这一次调用的数据，于是「发一条消息」再也不会把整棵
  `policy.config` 顶掉。
* `config.folding.context.foldAtRatio`（issue #569）——折叠可以提前到预算的一个比例；默认 `1.0` 与今天的
  触发点逐字等价。
* `capabilities.hooks.continuityProvider` + `config.folding.context.continuityMaxTokens`（issue #568）——一块
  受预算约束的会话续接块。自 issue #598 起引擎就是它的**默认写者**（`config.continuity.handoff`，默认
  `off`）：开关一开，引擎自己注入交接指令，**不需要宿主提供 provider**；`continuityProvider` 是
  **override**。细节见 §7.2，这一版压缩与续接面的其余部分见 §7。
* `config.input.messages` 是一次 run 的种子数据的**那一个**叶子（issue #571 片2）。两种宿主形状被**点名**
  而不是留给人猜：`createAgent({ config })`（初始化那棵树是宿主的唯一配置来源，所以它照旧整棵覆盖
  `policy.config`）与 `runToolLoop({ config })`（直连路线）。`session.initialMessages` 是**端口级 feeder**，
  不是第二个叶子：叶赢，两者值不同时恰发一条 `config_override_conflict` 事件。那条事件是这个修法的另一半
  ——它只报**值不同**的叶子：递给 `createAgent` 的 `config: {}` 不再把端口写的叶子抹掉（以前会，而且是静默
  抹掉、冲突清单为空），因为一次不带任何配置叶子的调用现在**根本不递** `config` 这个键。

## 7. 压缩与续接面

这一侧有六处变化，按「宿主得动多少」排序。没有一处退役选项；两处改了**默认值**，一处改了宿主可能正在
解析的**文本形状**。

### 7.1 CLI 的默认压缩策略变成 `fold-llm`（issue #614）

`erix chat` 与 `erix repl` 以前默认用统计摘要器。现在默认是 LLM 驱动的折叠（`DEFAULT_COMPACTION_STRATEGY`
（`bin/config.js`）），统计摘要器降为**降级兜底**——它实际上一直是这个位置。代价是它排在第一位的理由：
**现在每次压缩都多一次主力模型调用。** 不想付这个代价的宿主传 `--compaction fold-statistical`，或把
`config.folding.context.strategy` 设成 `"fold-statistical"`；策略本身没有被删，名字集合一字未变
（`"sliding-window" | "fold-statistical" | "fold-llm"`）。

### 7.2 `config.continuity.handoff`：引擎就是默认写者（issue #598）

续接块——那条注入在请求尾部的会话快照——多了一个开关。`config.continuity.handoff` 取
`"off"`（默认）| `"prompt"` | `"prompt-and-fallback"`。打开它，**你不需要提供 provider**：引擎在请求尾部
注入一小段指令（`HANDOFF_INSTRUCTION`（`src/loop/continuity-block.js`），~80 token），模型在**同一次**响应里
顺手写出 `<handoff>` 块（零额外请求），引擎解析出三段、存到 `~/.erix/continuity/<project-key>.json`
——project-key 与 session id 用同一套工作目录派生规则，而 `resolveContinuityDir`
（`src/loop/continuity-block.js`）优先认 `ERIX_CONTINUITY_DIR`——并在下一次 run 启动时召回那份记录。缺段
记成 `unknown`：引擎绝不用机械文本冒充语义交接。`"prompt-and-fallback"` 允许多**恰好一次**补调用，只向模型
要那一段交接块，用于「这次 run 收尾时没写」的情况。`capabilities.hooks.continuityProvider` 现在是
**override**：你给了它，你的文本赢，默认写者让位。默认是 `off`，所以什么都不改的宿主看到零行为变更——
请求里没有那条指令、不写文件、不创建目录。

### 7.3 `context.workingSetRecentRounds` 是 opt-in，默认关（issue #608、#612）

把 `config.folding.context.workingSetRecentRounds` 设成 N > 0，就会把最近 N 个带 `tool_result` 的轮次留在
折叠之外。它是**排序偏好**而不是禁令：没有别的可折时引擎照旧折最老的一轮，所以折叠不会死锁。默认是
**0 = 关**，而这个默认值是重要的一半——机制是先量后定默认的，而量的结果走了反方向。同一个 `bigdoc` 场景
（单结果 119k token、64k 预算）下，每任务总输入 **11,467 → 46,476** token、重读次数 **3 → 9**，而事实命中
两臂都是 **0/5**：地板挡住了折叠，模型拿不到摘要，于是反复重试，为同一个答案付更多钱。那里模型缺的是
**经验**（哪些做完了、做到第几段、什么不能重做），不是**细节**——所以地板默认关，力气花在语义折叠上。

### 7.4 折叠块改成账本驱动渲染，所以它的文本形状变了（issue #601、#603、#605、#565）

替代被折历史的那个块，现在由**每次折叠的账本条目**渲染——一折一条 append-only 的 `foldedFacts`，各自带
自己的文本与自己那一段增量——而不是从一个累积字符串里反解出来。两处后果会到达宿主。块变成**分段**的：
最近几次折叠给全（标题、工具足迹、清单、摘要），更早的只留一行 title，因为完整那份还在账本里。清单取自
结构化的 `toolCalls` 投影，不是把渲染出来的文本再解析回去。如果你解析过那个块的文本，**形状变了**——去读
账本。`parseFoldSummaries`（`src/compact/fold-statistical.js`）仍然在，但它现在是旧 transcript 的兼容路径，
以及账本条目没有结构化键时的兜底。

### 7.5 摘要器提示词多了第六节，而空摘要现在算失败（issue #611）

折叠摘要器的提示词（`SUMMARIZER_PROMPT_GUIDE`（`src/compact/fold-llm.js`））多了第六节
`## 教训与坑（不要重犯的）`：试过但失败的做法与原因、不可违反的约束、已确认的坑——只从被折原文里抄，
没有就写「无」。如果你通过策略端口跑自己的摘要器，返回约定多了一条硬边：**空串或纯空白的摘要算失败，不算
成功。** 它会以新的 `empty_summary` 降级类型失败（错误码是 `summarizer_empty_summary`），而不是静默把你的
历史换成空。

### 7.6 四处新的可观测面（issue #588、#608、#594、#568）

* `compaction_deferred` 事件：当一次折叠因为还有悬空的 `tool_use` 没结清而被推迟时发出。它是既有观察者通道上
  一条 `fatal: false` 的事实，不是新回调。
* `budget_below_working_set` 诊断：当工作集单独就装不进预算、折叠只能停下时发出。载荷：`budgetTokens`、
  `workingSetTokens`、`suggestedBudgetTokens`、`repeatStreak`、`foldLayersOverBudget`（另有 `attempts` 与
  一句 `detail`）。
* `continuity_injection_skipped` 事件：当宿主**确实**给了续接块、但它没能落进请求时发出（它是 §7.2 那条
  「降采样绝不静默」的可见那一半）。同一条观察者通道、同样的 `fatal: false` 形状。
* run state 里的 `last=` 格：一个 ~10 token 的游标，记最近一次**入参不同**的工具调用，同一入参再调就长成
  `×N`——于是宿主（或续跑的模型）不必读 transcript 就知道跑到哪了。

如果你的告警按事件名过滤、或仪表盘按诊断字段白名单取值，把这四样加上。

## 8. 没有变的东西

* `runToolLoop` 的输入面：没有选项被退役、改名或搬家，`capabilities` 的形状就是 0.28.0 发出去的那一套。
  `config` 的 schema 是 **8 个分组 / 43 个叶子**。基线是 0.28.0 的七个分组、41 个叶子；这一版正好新增
  两个叶子——§2 的 `config.run.parentRunId` 与 §7.2 的 `config.continuity.handoff`——其余叶子一处没动。
  这两个数不是「写给人信的散文」：`check:docs` 每次运行都拿 `CONFIG_NAMESPACE_SCHEMA` 对一遍。
* 终止、核验与退出码语义；无 guard 时 `skipped` 的退出码仍是 `4`。
* transcript 与 run-state 的落盘格式；能从 0.28.0 写下的账本续跑。
* `delegate` 工具**默认关闭**：它不在默认工具面上、也不在默认系统提示里，`erix chat` / `erix repl` 只有
  加 `--delegate` 才注册它。三个旗标的默认值不变：`--delegate-max-children` 2、`--delegate-timeout-ms`
  600000、名册目录 `~/.erix/delegation/`（用 `ERIX_DELEGATION_DIR` 搬走）。
* 运行时零依赖红线：派生那几个模块只 import `node:` 内置与相对路径。

## 9. 在你自己这边验一遍

1. **不派生就到此为止。** §2–§5 与你无关；唯一可见的变化是 §4 的名册字段数，而且只在你亲自读名册文件时才
   看得见。
2. **证明 `tail` 是「接上了」，而不只是「存在」。** 在冒烟测试里起一个后台子 run，并在它写出任何东西之前调
   `tail`。`no_transcript` 是正常的（子还没落第一行）；`no_transcript_path` 说明 `transcriptPathFor` 没接
   ——先修接线，再相信任何一次尾读。
3. **证明结果带回文本。** 跑一个后台子 run，让它回答一个已知字符串，断言 `result.text` 含它。终态 `state`
   配空 `text`，说明你那个子 run 函数什么都没返回——库不会替它编一段正文。
4. **证明名册说的是事实。** 接了 `cwdFor`，就把记录里的 `cwd` 与子实际用的目录对一遍；不接，就把这个字段
   当模型给的请求读。
5. **用发布出去的声明文件做类型检查**（`tsc --strict`）。`createDelegateTool` 与它的动作联合类型在
   `erix-agent/tools` 的生成声明里；少一个导出或动作名写错是编译错误，不是运行时惊喜。
6. **如果你跑的是 CLI 自己的闸门**，端到端的证据是 `examples/delegate-real-e2e.test.mjs`，即
   `npm run check:release:real` 的第 2 步：真上游下父 run 派生一个子 run，断言子名册记录带的是父的
   `config.run.runId`、子 run 以 `end_turn` 收尾、名册终态 `completed`、父侧被唤醒**恰好一次**。
