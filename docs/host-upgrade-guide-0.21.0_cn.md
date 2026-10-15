# 宿主升级指南：0.21.0

这本指南覆盖 0.21.0 里宿主**能看见**的变更，逐条点名：reflection 决策解析的缺陷修复
（issue #305）、新的公共入口 `parseModelJson`（issue #307）、user 轮请求形态守卫（issue #292）、
`erix_run` 更完整的终局面（issue #313）、需要显式开的 `finalGuard`（issue #314），以及
`erix_run` 的工具清单兜底（issue #312(b)）。**它们都没有挪走任何选项名、方法签名或导出，
也不会打断任何一个「不逐字断言文本」的调用点。**只有两处会改动宿主可能逐字断言的字符串——
#314（在你开启它之后）与 #312(b)（始终）——那两节各自写明了。还有一项改动（文档锚点纪律，
issue #286）属仓库内部纪律，列在这里只为让你知道为什么没有为它写更多东西。完整清单仍在
`CHANGELOG.md`；下面某一节没写到你的代码路径，那一节对你就是空操作。

**想跳过这本指南之前，先把这句读完：选项名一个没改，方法签名一个没改，导出一个没动。**
行为变了的两个函数都是宿主可见的小工具（`parseReflectionDecision`，`src/loop/reflection.js`），
外加一个全新的（`parseModelJson`，`src/text/parse-model-json.js`）；其余全是你在既有结构里
本来就会忽略的 additive 键。本版本唯一的参数面变化，是 `erix_run` 扩展工具上多了两个
**可选**键（`finalGuard` / `finalGuardTimeoutMs`，issue #314）——那个扩展住在
`examples/pi-extension/`，不进 npm tarball，而它的 `outputSchema` 没有多出一个键。包仍然是零 npm
运行时依赖、纯 ESM、要求 Node 22。

## 1. 变更总览

| 变更 | 会被它绊到的宿主 | 节 |
| --- | --- | --- |
| `parseReflectionDecision` 不再把模型明确写下的布尔值翻向，返回体新增来源标记 `via`（`"json"` \| `"prose_fallback"`）（issue #305） | 对整个返回对象做深比较，或曾假设手写的 `{…}` 决策可能被翻反 | 2 |
| `parseModelJson` 从包根导出，成为「从模型文本里抠 JSON」的唯一入口（issue #307） | 不会坏；自带花括号扫描器的宿主多了一个可选替代 | 3 |
| 发给上游的请求视图始终保留一条真 user 轮，极小 `context.budgetTokens` 不再触发 `400 No user query found in messages`（issue #292） | 不会坏；以前会以 `failed` 收场的 run 现在能跑 | 4 |
| 宿主可读文档里的裸行号变成只降不升的棘轮，代码引用改成符号锚点（issue #286） | 不会坏——这是仓库内的文档纪律 | 8 |
| `erix_run` 的终局面带上分层压缩账（`layers`）与 notes 计数，于是 `compacted:false` / `foldedRounds:0` 不再被读成「压缩没生效」（issue #313） | 不会坏；以前只凭那两个标量判断压缩有没有回报的宿主，现在能读到真数 | 5 |
| `erix_run` 多了需要显式开的 `finalGuard`；开启后终稿必须含四段具名小节，且声明的基点得能在本次 run 的 `tool_result` 里溯源（issue #314） | 开关关着时不会坏；会解析终稿文本的宿主多了一个可依赖的结构 | 6 |
| `erix_run` 的工具清单改由实际注册面生成：拿不到注册面时报 `tool_list_unavailable`，不再静默交一份短名单，`note_*` 也被点名了（issue #312(b)） | 对**扩展自己**的系统提示词做逐字断言的宿主（引擎那份提示词逐字节不变） | 7 |

## 2. 写下来的 `false` 不再以 `true` 回来（issue #305）

`parseReflectionDecision`（`src/loop/reflection.js`）从包根（`src/index.js`）导出，供自己
解析 reflection 回答的宿主使用，引擎内部也走它。它的抠取原先是贪婪的 `/\{[\s\S]*\}/`，于是
**尾话里的一对花括号**——散文中的一个 `{plan}` 占位符、```` ```json ```` 围栏后跟一句说明、
并列的两个顶层对象、外层未闭合——会让抠出来的一坨解析不了；`JSON.parse` 抛错后直接 fall
through 到关键词兜底，而**兜底跑在含 JSON 自身的整段文本上**：它匹配到的是键名，于是模型
明确写了 `"continue": false` 却回来 `continueFlag: true`，`progress` 一起丢掉。

现在抠取换成与 wrapup 解析器共用的**顶层平衡扫描**：`jsonCandidates`
（`src/text/json-candidates.js`）感知字符串与转义，只在括号深度归零处切候选，未闭合的外层
**什么都不产**。今天就是错的四种形状由此修好：issue 原形状、围栏 + 带括号尾话、并列两个顶层
对象、外层未闭合却包着一个完整的内层对象。

**返回对象多了一个键。** `via` 说明数值的来路：来自可解析的顶层对象是 `"json"`，来自对整段
文本做关键词匹配是 `"prose_fallback"`。在生成的声明里它是字面量联合
`"json" | "prose_fallback"`，不是 `string`，可以直接收窄。它只声明**来源**，不是 schema
结论：六个决策字段照旧全部可缺省，所以 `{"progress":3}` 仍是合法决策并留在 `"json"` 这一路。
唯一的刻意例外是顶层对象可解析却六个决策键一个都不含——什么都搬运不过来，按
`"prose_fallback"` 上报。

**要不要动作。** 不必。若你对整个决策对象做 `deepEqual`，把 `via` 加进断言；若想区分「模型用
JSON 回答了」与「我们从散文里猜的」，读 `via`，别再自己反推。两处邻近值**有意不变**：兜底里
`reason` 的截断仍是 UTF-16 码元的 `value.slice(0, 200)`（轮次 judge 的 `truncate`
（`src/reflection/judge.js`）按码点计数——统一会改一个你本来就能观察到的值）；
`parseJudgeDecision`（`src/reflection/judge.js`）仍从**每个** `{` 起扫一次，未闭合的外层照样
会交出它的内层残片。

## 3. 抠模型 JSON 只有一个入口（issue #307）

`parseModelJson`（`src/text/parse-model-json.js`）是新函数，从包根（`src/index.js`）导出。
它替本包那两个模型 JSON 解析器接管了四处「对对象到哪里结束各持一说」的自带扫描器。你不
欠它一次采用；但你的宿主若在做同一件事，就该用它。

```js
import { parseModelJson } from "erix-agent";

// parseModelJson(text, { topOnly = true, requireKeys = null } = {}) ->
//   { ok: true, value, via: "json", candidates } | { ok: false, error, candidates }
const hit = parseModelJson('reasoning {"done":true,"confidence":1} trailing prose');
if (hit.ok) {
  use(hit.value);          // 就是 JSON.parse 的产物；值校验仍归你
} else {
  // hit.error："no_candidate" | "unparsable" | "shape_mismatch"——而且这里没有 `value` 键
}
```

三条性质就是它存在的全部理由，并且三条都被随包契约套件（`engineApiContract`）钉住：

- **失败是三态**，因为三种成因需要三种不同反应（换个提示词重问 / 接受它这次没用 JSON
  回答 / 去要那个缺的字段）：`no_candidate`（扫描件什么都没产）、`unparsable`（有候选但每个
  `JSON.parse` 都抛，例 `{"a":,}`）、`shape_mismatch`（有候选解析成功，却没有一个满足
  `requireKeys`）。
- **失败结果里没有 `value` 键**——不是 `value: undefined`。写完 `if (!result.ok)` 你手里真的
  什么都没有，于是一次失败的解析不会被当成「模型回了个空对象」。
- **没有任何 repair。** 不补闭合括号、不删尾逗号、不改值。这就是
  [host-consumer-contract.md](host-consumer-contract.md) 里的「归一化器只许搬运」章程。

两档扫描，仍是一份文件：`topOnly` 缺省 `true`（只认括号深度归零的对象；未闭合的外层什么都不
产）。`topOnly: false` 从**每个** `{` 起扫一次，于是未闭合的外层会先交出内层残片——这一档
只是为了让 `parseJudgeDecision`（`src/reflection/judge.js`）**行为零变更**地共用这份扫描。
`requireKeys` 是键存在性的 any-of 判定，且从不在意值类型。`candidates` 恒为**完整**扫描结果
（含未胜出的），所以你可以在它之上跑自己那份更严的逐候选校验。

两处邻近实现刻意**没有**迁移，知道原因能省你一个缺陷单：`tryParseWrapupJson`
（`src/reflection/wrapup.js`）的门槛比键存在性更严且必须跳过并续试；L0 与 fold-summary 那两处
读取（`src/reflection/l0.js`、`src/compact/fold-statistical.js`）不属于同一类问题——前者取
引擎要求模型写的标签，后者读引擎自己写下的行并 fail-closed。

## 4. 极小的 token 额度不再把请求清空（issue #292）

`context.budgetTokens` 小到连一条消息都装不下时，压缩的 safety 层（`safeTruncateMessages`，
`src/loop/budget.js`）会从头删未保护的消息，可能把**唯一的 user 轮连同整个列表**一起删空。
真上游（OpenAI 兼容 relay）对此回 `400 invalid_request`——"No user query found in messages"——
于是小预算配置从「能跑」退化成「必然 `failed`」。

修法是不变量而不是调参：`ensureUserTurnView`（`src/loop/request-user-view.js`）在**视图定稿
处**执行——TTL 折叠与 run-state 追加之后、`request` 对象组装之前（`src/loop/provider-runner.js`，
一处守卫同时覆盖 `chat` 与 `chatStream`）——并在压缩结果写回持久消息列表之前再执行一次
（`src/loop/orchestrator.js`）。退让顺序是：视图本来就含一条真 user 轮就原样放行 → 否则从
**未折叠 / 未压缩**的源视图里保底保留**最新**一条 user 轮（连同它必需的 assistant 配对）→
否则放弃本次折叠、改用源视图 → 否则原样返回并把这一格记为不可回补。每一步都用
`validateMessages`（`src/messages/rounds.js`）验一遍，所以回补出来的视图不会带着孤儿
`tool_result` 或缺结果的 `tool_use`。尾部 pending `tool_use` 在放行格是被容忍的——那正是
`max_tokens` 续写与续跑留下的形状。

**要不要动作。** 不必。你会看到的变化：一个原本会抛 `400` 并以 `reason: "failed"` 收场的 run
现在能跑。若你钉着「小预算仍会压缩」，那条还在——守卫不是「预算小就整体不压缩」；健康预算下
压缩行为逐字不变（`compacted` 仍为真、`foldedRounds` 仍大于 0、`tokensAfter < tokensBefore`）。

**两个你可能会注意到的 additive 键，也可以完全无视。** 守卫真的生效那一次，该轮在
`compactionStats` 里的条目会带 `userTurnGuard`（`"preserved_latest_user_turn"` |
`"abandoned_fold"`，判别式是 `isUserTurnGuardAction`，`src/loop/request-user-view.js`）与
`userTurnGuardChannel`（`"chat"` | `"chatStream"` | `"persisted"`）。它们**只在真的发生了什么事
时才出现**——没用到守卫的 run 产出的键与升级前一字不差。`compactionStats` 是引擎内部的诊断
数据（见 [host-consumer-contract.md](host-consumer-contract.md) 的 transcript meta 表），不属于
展示投影，别在它上面搭 UI。

## 5. `erix_run` 的终局面给出分层削减账与 notes 计数（issue #313）

`erix_run` 是 `examples/pi-extension/` 下的 pi 宿主扩展——一个仓库层产物，不进 npm tarball。
引擎每轮都报了分层压缩账：每条 `compactionStats` 条目带一个以引擎真层 id
（`COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`））为键的 `layers` 映射，由
`observeCompactionLayer`（`src/compact/pipeline.js`）在循环的观测点填、`createCompactionStat`
（`src/compact/pipeline.js`）归一。宿主扩展把那些条目折成三个标量、把映射丢掉了，于是**一次
`ttl` 层折叠了 69 条工具结果、省下 650,581 tok 的 run 仍打成 `compaction=0/1`，被读成「压缩
没生效」**。

**终局面多了什么**——全部 additive，全部由 `buildDiagnostics`
（`examples/pi-extension/erix-run-core.js`）拼装：

- `diagnostics.compaction.layers`——`roundsObserved`、`tokensBeforePeak`、逐层
  `byLayerId.<id>.triggered` / `.tokensSaved`、`roles[]` 里的具名桶
  （`COMPACTION_LAYER_ROLES`（`examples/pi-extension/erix-run-core.js`）），以及归组表还没具名的
  任何层 id 会落进的 `unattributed[]`。求和靠 `summarizeCompactionLayers`
  （`examples/pi-extension/erix-run-core.js`），渲染靠 `formatCompactionLayerSummary`
  （`examples/pi-extension/erix-run-core.js`）（每桶一行）。
- `diagnostics.notes`——`writes` / `reads` / `byName` / `unclassified` / `source`，由
  `countNoteToolEvent`（`examples/pi-extension/erix-run-core.js`）从 `tool_use` 事件上数出来。
  `source` 就是常量 `NOTE_COUNT_SOURCE`（`examples/pi-extension/erix-run-core.js`）
  （`"onEvent:tool_use"`）：这些数是数出来的，不是从别的字段推出来的。
- `diagnostics.modelMetadataMissingEvents`——`count` / `observed`。既有的
  `modelMetadataMissing` 旗子自己的含义与取值一字未动。

**本条就是要杀掉的那个误读：`compacted: false` 或 `foldedRounds: 0` 不等于「没有削减」。**
这两个值没动——它们的语义与取值与 #313 之前一字不差，`diagnostics.compaction.events` /
`.compactedRounds` / `.foldedRounds` 也与本节存在之前相同。分层收益**只能**从 `layers` 读：上面
那个真实事故就是同一个 run 里 `foldedRounds = 0` 却省了 650,581 tok。

**`unknown` 不是 `0`。** 只要某个计数的源不存在（旧条目，或装配期就死掉的 run），文本就渲染
`unknown`、载荷里带 `observed: false`，而不是编一个数出来：一条事件都没产生的 run 不等于零次
调用。引擎今后新增的层 id 会落在 `unattributed[]`，不会被归组表吞掉，所以不要去匹配
`COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）之外的 id。

**总账要从 run 返回值读，不要从 `<runId>.state.json` 读。** 汇总读的是 run 返回值（或抛错载荷）
上那份**全量** `compactionStats`，并自报用了哪一份：`COMPACTION_STATS_SOURCE` /
`COMPACTION_STATS_TRUNCATION_NOTE`（`examples/pi-extension/erix-run-core.js`）落到
`layers.source` / `layers.truncationNote`。`<runId>.state.json` 里那份写盘前过了
`normalizeCompactionStats(value, limit = 32)`（`src/compact/pipeline.js`），调用点是
`createDeterministicRunState`（`src/run-state.js`），即 `value.slice(-limit)`——只剩**最后 32** 条。
超过 32 轮的 run 拿那份文件重数账会静默少算（那个截尾行为是 issue #315，本轮没动它）。

**要不要动作。** 不必。若你以前靠 `compacted` / `foldedRounds` 回答「压缩到底划不划算」，
改成读 `diagnostics.compaction.layers`；若你自己去重读 `<runId>.state.json` 拼总账，要么改读
run 返回值，要么把那个数说成「最后 32 条」的窗口。

## 6. `finalGuard` 要显式开，而它的终稿四段是一个可以解析的形状（issue #314）

**默认关。** `parseRunParams`（`examples/pi-extension/erix-run-core.js`）只把布尔 `true` 当作
`finalGuard`——其他任何东西都是 `bad_params`；没开开关却传 `finalGuardTimeoutMs` 也被拒，理由同
一个（它看起来像在核验，而其实什么都没核验）。开关关着时，`buildLoopOptions`
（`examples/pi-extension/erix-run-core.js`）交给 `runToolLoop` 的 options 对象**根本没有
`finalGuard` 这个键**——而不是一个值为 `undefined` 的键——于是 `verification` 仍是
`{ status: "skipped", reason: "no_final_guard" }`，`end_turn` 仍是一句声明而不是一个证明。这条默认
路径与 #314 之前逐字节相同，仓内三条断言与装好的 CLI 那个退出码 4 的冒烟钉着它。

**开启的代价：**最多**2 个额外的模型往返**（引擎 `finalGuardMaxRetries` 的默认值）加**最多 3 次
guard 等待**，受 `finalGuardTimeoutMs` 限定，而它的显式值是
`FINAL_GUARD_TIMEOUT_MS`（`examples/pi-extension/erix-run-final-guard.js`）= 10000 ms，而不是引擎
默认的 30000——最坏是 `FINAL_GUARD_WORST_CASE_MS`
（`examples/pi-extension/erix-run-final-guard.js`）= 30000 ms 的额外墙钟。成本落在同一棵诊断树的
`diagnostics.finalGuard` 里（`calls` / `elapsedMs` / `reviseRounds` / `accepted` /
`invalidDecisions` / `missingSections` / `declaredBases` / `untraceableBases` / `ratioFlags` /
`finalGuardTimeoutMs` / `worstCaseExtraMs` / `source`），而引擎自己的计数仍在 `verification.metrics`
上（`guardMetrics`（`src/loop/orchestrator.js`））；两边各带一个 `source`，所以你不会把宿主的计数
当成引擎的。没开启时，那个字段就是一行实话——`finalGuard=disabled`——绝不假称已通过。

**会咬人的是超时这条。** 引擎只在轮边界查运行截止线（`remainingMs`（`src/loop/orchestrator.js`）），
stop 判定与 guard 调用之间没有 deadline 检查，于是**整段 guard 尾巴可能在你自己的截止线已经过了
之后才跑完**。`runErixRun`（`examples/pi-extension/erix-run-core.js`）自己挂了一根硬 abort 定时器，
就是为这个把它往后推 `FINAL_GUARD_WORST_CASE_MS`；交给引擎的运行截止线则不动。若你在扩展外面又套
了自己的超时，请留出同样的余量——否则就是钱花了、把你自己的判定掐死了。

**你现在可以依赖的东西。** 开关打开后，终稿必须依次包含四段——`FINAL_DRAFT_SECTIONS`
（`examples/pi-extension/erix-run-final-guard.js`）：`## 取证边界`、`## 基点`、`## 结论`、
`## 未验证`——而这四段槽位的文案只在开关开着时才追加进系统提示词
（`FINAL_DRAFT_PROMPT`（`examples/pi-extension/erix-run-final-guard.js`））。它们后面只有一道硬闸：
`## 基点` 下声明的每个字面值，必须在**本次 run** 的某个 `tool_result` 块里逐字出现
（`collectToolResultText`（`examples/pi-extension/erix-run-final-guard.js`））。缺段、缺声明、基点
对不上，一律 `revise`，**没有任何分支会 accept 一个无法溯源的基点**；重试用尽后 run 以
`final_guard_unverified` 收场、`verification.status` 为 `unverified`（`max_retries`）——那是
fail-closed 规矩过了，不是答案过了。比值、百分比、「总计」类只上报（`ratioFlags`），不硬拒。
**如果你的宿主会解析终稿文本，这就是新增的、值得依赖的结构**——而若你对提示词做逐字断言，记住
那四段只在 `finalGuard: true` 时出现。

**要不要动作。** 默认不必。想拿到真核验的终答：传 `finalGuard: true`，把 `verification.status`
（`verified` / `unverified` / `skipped`）与 `diagnostics.finalGuard` 一起读，并给自定的超时算上
guard 尾巴。

## 7. `erix_run` 的工具清单：引擎提示词没动，宿主的兜底动了（issue #312(b)）

**引擎那一侧什么都没动。** `buildCliToolsSystemPrompt`（`bin/tools.js`）现在把清单行改为「遍历
注册面（`cliToolDefinitions`（`bin/tools.js`））＋逐名查一张文案表
（`CLI_TOOL_PROMPT_PHRASES`（`bin/tools.js`））」，并在 build 期双向抛错——文案表里有而注册面
没有、或注册面有而文案表里没有。但**它的输出逐字节不变**：golden 文件没重烤，读引擎提示词的宿主
拿到的字节与升级前一模一样。

**变的是扩展自己的兜底**：那是一句手抄的六件套，早已静默丢了 `searchText` 与 `edit`，且从不提
`note_forget`。`buildSystemPrompt`（`examples/pi-extension/erix-run-core.js`）现在从**真正交给
`runToolLoop` 的那个数组**生成这一行，并引用引擎导出的那张表，而不是再抄一份：

- 拿不到注册面时，你拿到一个错误码为 `tool_list_unavailable` 的 `ErixRunError`
  （`buildToolListLine`（`examples/pi-extension/erix-run-core.js`）），而不是一份更短的名单——
  **静默少两个工具本身就是缺陷**。
- 新增一行把宿主自己注册的 notes 工具点名（`note_take`、`note_list`、`note_read`、
  `note_forget`），文案来自 `HOST_REGISTERED_TOOL_PHRASES`
  （`examples/pi-extension/erix-run-core.js`）：`本工具面另注册：…`。引擎自己的散文只点名前三个，
  所以这一行是模型得知 `note_forget` 存在的唯一出处。
- `assertToolListMatchesRegistered`（`examples/pi-extension/erix-run-core.js`）会在写进提示词的名字
  不在 `tools` 数组里时让装配当场失败——典型形状是引擎清单带着 `todo_*`，而宿主把自己的数组里
  那几件滤掉了。

**本条就是会让你的测试变红的那一条。** 若你的宿主对**扩展自己**的系统提示词做逐字断言，重生成的
清单行加上新增的 `本工具面另注册：…` 一行会对不上旧快照：重烤它。对**引擎**提示词的断言仍绿——
那段文字没动。

## 8. 文档锚点纪律（issue #286）——宿主无需动作

本包每一份宿主可读文档（README、契约、以及本系列每一份升级指南）从此遵守两条规则：代码引用
是**符号锚点**（`` `名字` `` 加上它所在的文件），门禁会拿真声明去解它；**裸行号**是只降不升的
棘轮。对你而言，这意味着本系列较早指南里残留的行号是其中最不可信的部分，而新写的符号锚点是
机器核对过的。这条不花你任何成本。

## 9. 升级自查

1. `grep -rn "parseReflectionDecision" <your host>` —— 若你对返回对象做断言，补上 `via`；
   若你曾自己反推「这到底是 JSON 还是散文」，改成读 `via`（第 2 节）。
2. `grep -rn "JSON.parse\|\\\\{\\[\\\\s\\\\S\\]" <your host>` —— 凡是你自己扫模型文本的地方都是
   `parseModelJson` 的候选；若你保留自己的扫描器，务必确认未闭合的外层不会把内层残片当成答案
   （第 3 节）。
3. `grep -rn "budgetTokens" <your host>` —— 小预算不再需要绕道；把你为「首个请求会 400 所以
   重试」加的绷带拆掉（第 4 节）。
4. `grep -rn "No user query found" <your host>` —— 这个错误串从此不再到达；若你的代码为它开了
   特例，分支留着，但别再指望它命中。
5. 拿随包契约套件跑你的适配器（`erix-agent/contract-tests`）：`engineApiContract` 现已覆盖
   `parseModelJson` 的三种失败态与「失败不带 `value` 键」。
6. `grep -rn "compacted\|foldedRounds" <your host>` —— 若你曾凭这两个标量判断 `erix_run` 的压缩
   效果，改成读 `diagnostics.compaction.layers`，并且再也不把 `foldedRounds: 0` 叫作「没省」
   （第 5 节）。
7. `grep -rn "compactionStats" <your host>` —— 从 `<runId>.state.json` 里读到的那份
   `compactionStats` 是一个**最后 32 条**的窗口；要么说成窗口，要么改读 run 返回值（第 5 节）。
8. `grep -rn "finalGuard\|verification" <your host>` —— 默认没变（仍是 `skipped`）；想拿
   `verified` 就传 `finalGuard: true`，并把 guard 尾巴算进你自己的超时预算（第 6 节）。
9. `grep -rn "systemPrompt\|系统提示词" <your host>` —— 对 `erix_run` 系统提示词的逐字断言需要
   重烤（清单行是生成的，又多了 `note_*` 那一行）；引擎提示词的快照不用（第 7 节）。

## 10. 没有变的部分

选项名、方法签名、导出都没有被删除或改名；`runToolLoop` 的选项与 `TranscriptStore` 的方法
一字未动。`parseModelJson` 是 additive，`via` 是 additive，而 `#292` 那道守卫只会往一个本来
会被上游拒掉的视图里**加**消息。`finalGuard` 与 `finalGuardTimeoutMs` 是 `erix_run` 扩展工具上
两个**可选**参数，它的 `outputSchema` 没多一个键（issue #314）；引擎的工具清单提示词文案逐字节
不变（issue #312(b)）；`end_turn` 仍是正常成功出口，终止原因集合也没变——
`final_guard_unverified` 早就在 `FINAL_GUARD_TERMINATION_REASONS`
（`src/loop/termination.js`）里，#314 只是让宿主能够走到它。本指南英文原版：
[host-upgrade-guide-0.21.0.md](host-upgrade-guide-0.21.0.md)；契约本身是
[host-consumer-contract.md](host-consumer-contract.md)，其中文同步版是
[host-consumer-contract_cn.md](host-consumer-contract_cn.md)。
