# 宿主升级指南：0.26.0

**这是「折叠把它的替代物交到你手上，且成功终局一定有正文」那一版。** 0.25.0 让一次折叠在磁盘上不再贵；
0.26.0 让一次折叠**说清它拿走了什么**，并在折叠定稿的那一刻把这份文本交给你。它还补掉了最后一个「run
成功结束却没有终稿正文」的口子。没有删除、没有改名，store 方法签名一个没动，导出与依赖一个没搬，运行时
依旧是**零** npm 依赖。

下面每一条要么是纯新增、要么是「只多不少」的加强：对着 0.25.0 编译得过的宿主，不改一行照样编译照跑，并且
白拿新的账本字段。§2 与 §3 是两个新表面，§4 是你会在 prompt 变小这件事上感觉到的续跑变化，§5 是你的验收
必须看的终局变化，§6 说清楚真正跑起来的是哪个压缩策略。完整清单仍以 `CHANGELOG.md` 为准。

## 1. 变更一览

| 变更 | 你要不要动手 |
| --- | --- |
| 每次折叠都写一份有界机械索引 `record.foldedFacts`（§2） | 不要——纯新增；没折叠的轮次就是没有这个键 |
| 新钩子**顶层** `onFoldSummary`（§3 标题里的 `context.` 前缀是错的——见 §3 末了指正）与新旋钮 `context.maxFoldedFactsBytes`（§3） | 不要——两个都不传，行为逐字节不变 |
| 续跑只重放折叠水位线尚未入账的那部分（§4） | 要——如果你对续跑正文的内容或大小有断言 |
| `judge_done` 停机补写终稿，验收改看 `termination.forcedFinal`（§5） | 要——如果你的验收口径是「终稿非空」 |
| `compaction.strategyName` 与一次性 `compaction_strategy_fallback` 事件（§6） | 不要——事件字段纯新增 |

### 本次发布动到的宿主可见表面

- `src/compact/fold-summary-journal.js` — `buildFoldedFacts` 与 `FOLDED_FACTS_MAX_BYTES`：替代物本体和它的字节上限。
- `src/loop/orchestrator.js` — 写 `record.foldedFacts`、触发 `onFoldSummary`、给 `judge_done` 停机补强制收尾。
- `src/compact/resume-fold-trim.js` — `planFoldedHistoryTrim`：按水位线裁剪 + 摘要回填。
- `src/compact/sliding-window.js` — 零 LLM 策略现在也交出同一份机械文本（`foldedSummaryText`）。
- `src/loop/resume-manager.js` — 续跑历史，以及 judge 的轮次历史不再吃到 `"missing"`。
- 顶层 `onFoldSummary`（**不是** `context.onFoldSummary`——见 §3 末指正）与 `context.maxFoldedFactsBytes` — 两个新选项。
- `compaction.strategyName` 与 `compaction_strategy_fallback` 事件 — 新的可观测字段。

## 2. `record.foldedFacts`：每次折叠都留下一份有界机械索引

改之前：压缩拿走若干轮之后，轮记录里留着归档（0.25.0 的 `foldedPayload`），却没有一件东西在**有界空间**里
说明「拿走了什么」。宿主想告诉用户「这些轮次对模型不再可见」，只能自己回账本重算——而引擎自己的 judge
轮次历史在那位置上拿到的是字面量 `"missing"`。

改之后：每次折叠都挂上 `record.foldedFacts`，由 `buildFoldedFacts`（`src/compact/fold-summary-journal.js`）产出：

| 键 | 含义 |
| --- | --- |
| `text` | 被折区间的机械索引：轮号、工具 / 退出码与路径锚点，顺序稳定 |
| `source` | `"strategy"`，除非宿主自己注入了文本 |
| `strategy` | 由哪个策略产出（无法归因时是 `"unknown"`） |
| `from` / `to` / `rounds` | 被折的轮次区间，能确定时才有 |
| `bytes` | 落下来的 `text` 的大小 |
| `truncated` 与 `bytesBefore` | 只有在字节上限截断时才出现，并交代代价 |
| `degradeReason` | 只有在替代物是「廉价路径」产出时才出现（截到 120 字符） |
| `fingerprint` | 文本的稳定身份，用来避免同一份正文入账两次 |

默认上限是 `FOLDED_FACTS_MAX_BYTES`（2048 字节），你自己的值走 `context.maxFoldedFactsBytes`（§3）。
`foldedFacts` 是索引不是展示文案：它该出现在横幅、日志行或一条笔记里；它故意足够小，小到一条轮记录不可能
像 0.25.0 的归档那样被宿主的单条记录大小闸门打死。

## 3. `context.onFoldSummary` 与 `context.maxFoldedFactsBytes`：替代物是投递给你的，不只是存着

这就是 0.25.0 指南在最后一节预告「随下一个 minor 生效」的那一节。它在这一版落地，而且正文从此只活在这一份
指南里，不再两处并存。

`context.onFoldSummary?.(payload)` 是纯新增，每次折叠触发一次，时机是确定性替代物定稿的那一刻，参数是
`{ ...record.foldedFacts, round }`——就是**同一个**要进轮记录的对象的一份克隆，不是另搓一份更好看的版本。
四条边界，它们就是契约：

1. **没有文本 ⇒ 不调用。** 这次折叠没产出替代物就不会打搅你。
2. **钩子抛错永不改变 run 的结果。** 它变成一条非致命事实：`persistence_error`，`operation: "onFoldSummary"`、
   `phase: "fold_summary_delivery"`、`fatal: false`。
3. **它是尽力而为，不是 observer 通道。** 这是你的数据，所以不走 observer 的 `console.error` 那条路。
4. **不传这个钩子，行为逐字节不变。**

`context.maxFoldedFactsBytes`（正整数，默认 2048）**就是**落到记录上的那个上限，所以你的输入上限、输出预算
和容器上限可以共用一个来源，而不是三个魔数。两者都在装配期校验：`onFoldSummary` 不是函数就抛
`TypeError: onFoldSummary must be a function`；`maxFoldedFactsBytes` 不是正整数就抛
`maxFoldedFactsBytes must be a positive integer`。

拿到它该干什么：把它作为这次折叠在时间线上的那条记录写进你的 notes / journal 存储（本仓自己的笔记工具就是
`note_take`），打上被折区间的标签，然后不再轮询账本去找你已经见过的折叠。要是你更愿意继续轮询，
`record.foldedFacts` 一直都在，而且内容完全一致。

⚠ **指正（2026-10-28，issue #499）。**上面关于钩子 **`context.`** 落点的说法**在发布当时就是错的**。
0.26.0 读的是**顶层** `onFoldSummary`，**从不读** `context.onFoldSummary`；当时未知的 `context` 子键是
**静默丢弃**的，而且 **0.26.0 根本没有 `context` 子键白名单**——那份名单是 0.27.0 周期的 issue #469
才引入的，所以放错位置的钩子连「被报出来」都做不到。把钩子配在 `context` 下的宿主：零调用、零错误、零事件。
（对照：`context.maxFoldedFactsBytes` 是真的，0.26.0 会读它。）这个钩子一直是**顶层** `onFoldSummary`；本节里的 `context.` 前缀是 0.26.0 的文档缺陷，
从来不是受支持的落点。现在 `context.onFoldSummary` 已从白名单退役（按宿主元数据对待，装配口路线经
`context_unknown_option` 报出），顶层钩子一字未动。退役细节见 0.27.0 指南。上方原文逐字保留作历史。

## 4. 续跑不再重放水位线已经入账的正文

`planFoldedHistoryTrim`（`src/compact/resume-fold-trim.js`）按折叠水位线裁续跑上下文：属于 `round <= foldedThrough`
的消息不再进重放；head（种子行、system、任务正文——一切 `round <= 0` 的东西）永不裁；并把一份替代摘要回填进
最后一条真实 user 消息，让模型用更小的空间继续持有同样的信息。`summarySource` 如实交代回填的是哪份文本：
`"journal"` 是模型当时真的见过的那份摘要，`"strategy"` 是策略算出的机械索引（模型未必见过，但信息等价）。

只有在找得到覆盖该区间的替代物时裁剪才生效，否则原样透传，并把原因记下来——`no-watermark`、`nothing-to-trim`、
`no-covering-summary`、`empty-summary`。升级后续跑 prompt 变小是目的而不是回归：如果你对续跑大小、或对某些较早
的轮次必须出现有断言，请改成对着 `foldedThrough` 断言。

同一会话里跨 run 续跑的宿主对这个差别最敏感：第二个 run 就是水位线发挥作用的地方——它让第二次不再把第一次
已经折过的东西从第 1 轮重新折一遍。

## 5. `judge_done` 停机现在会补写终稿：用 `termination.forcedFinal` 验收

改之前：末轮只出 reasoning（没有终稿正文）而停机原因是 `judge_done` 时，run 以成功终局结束**却没有终稿正文**。
什么都没崩，只是交付物为空，时间线上最后一条可见内容成了评审卡。按「终稿非空」验收的宿主，拿到一个成功的
run 和一片空白。

改之后：这条停机会像其他强制收尾一样补写终稿。引擎自写的正文在显示层被标明身份（`forced-final`），它复用末轮
记录的 round key 而不是另插一条记录，并且 run 上报 `termination.forcedFinal`（状态 getter `forcedFinal`，
`src/loop/orchestrator.js`）。

宿主要做的事：验收必须读 `termination.forcedFinal`，而不是只看「有没有正文」。强制收尾是引擎代写的正文，按 遵循 #323 的 marker 规矩，引擎代模型写的东西一定带标记——没有那个标记就别把它当成模型自己的回答呈现出去。两处紧邻
的缺口**故意**不在这一版：`end_turn` 与 `no_tool` 还不强制收尾（**#475**），强制收尾拿回空正文的情况单开一条
（**#476**）。至于 judge 自己判「做完了」时看的是什么，那是 **#473**，这里也没动。

## 6. 真正跑起来的是哪个压缩策略

如果你配的是 `fold-statistical`，而引擎悄悄退回 sliding-window，事后你根本分不出来——而这两者对「模型还留着
什么」的影响差得非常远。

- `compaction` 统计现在带 `strategyName`：这次压缩**实际**跑的策略。
- 一个 run 里第一次由配置策略被替换成兜底策略时，发一条一次性的 `compaction_strategy_fallback` 事件。
  `src/compact/pipeline.js` 在续跑时会重建同一个字段，所以它能跨重启存在，而不是每轮重新叙述一遍。

顺带一处归因更正（#465 B）：契约里说宿主必须提供 `erix-summary` 模型槽，这是错的——引擎从不要求它。

## 7. 没有变的东西

- 没有 store 签名变化、没有选项改名、没有导出变化、没有依赖变化、没有终局 reason 词表变化。
- `record.foldedPayload` 与 `record.foldedPayloadMeta` 保持 0.25.0 的语义。`foldedFacts` 是它们旁边的新增，
  不是替代，也没有任何东西把它当真相回读。
- 交给策略钩子（`onAfterFold`）、`recoveryHint` 与桩解析的内存态 `foldedPayload` 仍是完整正文；只有落到你
  存储里的那一份是有界的。
- `judge_done`、`end_turn`、`no_tool` 以及其余所有停机原因的姓名与含义不变；变的只有 `judge_done` 这条路径上
  「缺终稿正文」的行为。

## 8. 你这边怎么验

```bash
node --test test/loop-on-fold-summary.test.js test/compact/folded-facts.test.js
node --test test/loop-judge-done-forced-final.test.js test/loop-resume-summary-history.test.js
npm run check:release
```

再看一条真会话。每条折叠过的轮记录都必须满足 `foldedFacts.bytes <= maxFoldedFactsBytes`。如果你传了
`onFoldSummary`，调用次数必须等于「产出了文本的折叠次数」——对不上只有两种解释：要么钩子抛过（去翻
`phase: "fold_summary_delivery"` 那条 `persistence_error`），要么那次折叠本来就没产出替代物，那是合法的。
而如果一条 run 以 `termination.reason = "judge_done"` 结束，`termination.forcedFinal` 必须是 true 且终稿正文
非空；这条路径上出现 `forcedFinal` 为 false，就是值得开单一件事。
