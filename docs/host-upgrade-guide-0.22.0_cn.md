<!-- doc-version: 0.22.0 -->
# 宿主升级指南：0.22.0

**先读这句：0.21.0 从来没发出去过。** registry 上最新是 `0.20.0`，所以本指南是 **0.20.0 → 0.22.0**
一次跨版本。0.21.0 的内容全部随本版一起发出，那些变更的逐条细文仍在
`docs/host-upgrade-guide-0.21.0.md`（反思判定修正 #305、`parseModelJson` #307、用户轮请求守卫
#292、`erix_run` 终局面 #313、可选 `finalGuard` #314、`erix_run` 工具清单回落 #312(b)、文档锚点
纪律 #286），它们在等待发版期间**一字未变**。本指南自己覆盖 0.22.0 新增的部分：issue **#322**、
**#323**，以及持久化改造 **#326**（第 1、3、4、5 步）。

**没有任何 store 方法签名搬家，没有删选项，没有改导出名。** 两处宿主会真踩到的可见变化：一笔原本
被静静吞掉的写入现在会**抛错**（§2），以及 `load()` 返回的**行数会多于轮数**（§3）。下面某一节
描述的不是你的代码路径，那节对你就是空操作；完整清单仍在 `CHANGELOG.md`。

## 1. 变更一览

| 变更 | 要不要动手 |
| --- | --- |
| 同 `dedupKey` 换内容变成硬冲突（§2） | 只有当你的 store 依赖过「静默丢弃」，或你生成的 `dedupKey` 不稳定时才要 |
| 一个 run 的账本行数超过轮数（§3） | 要——只要你把行投影到自己的表或 UI |
| 折叠摘要与 TTL 降级结果落账，且复用不重算（§4） | 只有当你的 store 用字段白名单重建记录时才要 |
| `reflection.judgeDoneAdvisory`（§5） | 默认关：不开就什么都不发生 |
| 引擎注入的消息带 `meta.source`（§5） | 拿它过滤展示，别拿它做判定 |
| 内置 CLI 按正文口径读行（§6） | 只有你在解析 `erix` 输出时才要 |

## 2. 同 key、内容不同的写入现在会响

`appendRound` 此前只按 key 去重（`dedupKey ?? roundKey ?? <runId>:round:<n>`）。**同 key、内容不同**
的第二笔写入会被「接受」然后静默丢掉：不落行、不报错、双方都没有信号。两个内置 store 现在都拒绝它
（判据集中在 `src/store/transcript-dedup.js`，memory 与 file 不可能各漂一套）：

- **同 key、同 payload** ⇒ no-op，与旧行为一致（`appendRound` 仍 resolve 成 `undefined`，返回值没加东西）；
- **同 key、不同 payload** ⇒ 抛 `TranscriptDedupConflictError`，`code === "dedup_payload_conflict"`；
  消息与属性里带 `runId`、key、两份 payload 指纹和顶层差异字段名。**既有记录字节不动、也不落新行**，
  所以拿原 payload 重放照旧幂等。

第一次撞上它之前，两件事要先知道：

- **崩溃重跑预写的用户轮仍然是安全的。** payload 指纹刻意不看顶层的 `dedupKey`、`roundKey`、`round`
  与 `ts`——它们是身份与墙钟，崩溃尝试与重试之间必然漂。而消息正文里嵌套的 `ts` 算内容，数组顺序也
  算内容：**消息顺序就是语义**。
- `runToolLoop` 把抛错的 store 当持久化失败（重试耗尽后 `termination.reason === "persistence_failed"`）。
  以前只是悄悄少一行的宿主，现在会看到一次 run 结束。**按 `code` 分支，不要按错误文案分支。**

如果你想给某一行保留旧的宽松行为，正确做法是给它一个稳定的、由你自己的消息 id 导出的 `dedupKey`，
而不是把 `appendRound` 包一层 `try/catch` 把错咽掉。

## 3. `load()` 现在返回的行数多于轮数

引擎自己也往同一本账里写行，0.22.0 新增三家：

| `dedupKey` 形状 | 装的是什么 | `messages` |
| --- | --- | --- |
| `<runId>:engine:round:<n>:control:<slot>` | 轮记录**已经落盘之后**引擎才注入给模型的文本——`slot` ∈ `judge-nudge`、`extend`、`guard-revise`、`forced-final`（收尾那一行还带终稿 assistant） | 普通消息，每条都带 `meta.source === "judge-control"` |
| `<runId>:engine:round:<n>:fold:<fp>` | 实际喂给模型的折叠摘要 | 可能为空，正文在 `foldedSummary` 里 |
| `<runId>:engine:round:<n>:ttl:<fp>` | 某条工具结果被降级成了什么 | 空，正文在 `ttlDegradations` 里 |

在这之前，这些话**只存在于模型的上下文里**：模型见过，进程重启后引擎对自己说过什么零档案。这次关掉
的缺口是难看的那一个：轮间崩溃时，**第二次** resume 交给模型的是「没有」（`0`），而第一次交的是那条
提示（`1`）。

**投影怎么读。** 按 `round` 归组、按 `dedupKey` 去重，凡是渲染用户/assistant 正文的地方跳过
`meta.source === "judge-control"`。一行不等于一轮，`messages` 为空也不是 bug——这些行里有好几类天生
就没有正文。如果你的投影把「行数」当「轮数」，现在它会偏大（内置 CLI 的「已恢复会话（N 条消息）」和
会话预览原本就是这个 bug）。

## 4. 折叠摘要与 TTL 降级现在是事实，而且复用不重算

`fold-llm` 的摘要原本现算现用：进了当次真实请求（模型看见了），却进不了账本——因为轮记录写的是
`messages.slice(roundStart)`，而 `roundStart` 取的是折叠**之后**的长度。恢复时引擎会再调一次摘要器，
并拿到**另一份**摘要。每轮现算既毁 prompt cache 命中，也让「模型当时到底看见了什么」无法回答。

0.22.0 把喂出去的东西记下来并复用：`src/compact/fold-summary-journal.js` 给摘要器的输入做指纹
（被折叠的负载 + 轮区间），resume 时用 `seedFromRecord` 把已入账那份灌回复用账本，于是同一指纹不会
调第二次摘要器。TTL 降级也带着 `toolUseId`、`createdRound`、`tokens`、`tokensAfter`、`chars` 与内容
指纹落账，「从什么降级成什么」变成可核对的东西，而不是一句计数。

**宿主动作：** 如果你的 store 对未知字段原样往返（这已是契约，issue #1146 就是先例），**什么都不用做**。
**必须动手**的情况是你的 store 按列白名单重建记录：`foldedSummary` 与 `ttlDegradations` 会在写入或读取
时被丢掉，而丢了它们的 store 会**静默**破坏「复用不重算」。三个内置压缩策略的生成行为一字未改——
这一刀只是「记下来，然后复用」。

## 5. `reflection.judgeDoneAdvisory` 与 `meta.source`

judge 是一个**意见**。中途治理判定目标已达成时，这个判定此前只能拿来「停」：理由本身从没说给模型——
于是出现「judge 说达成了，agent 又烧了十几轮」那个形状。打开 `reflection.judgeDoneAdvisory`
（默认 `false`）后，评审意见作为**一条**普通 `user` 文本消息在下一个安全点注入：一个槽位、一次一条、
没有队列。终止语义不变：软提示不是硬停止；而开关关着时，四份 fixture 的字节输出与
0.20.0/0.21.0 **完全相同**。

引擎注入的消息带 `meta.source`（当前只有一个取值 `"judge-control"`）。把它当**展示/投影层的标签**用：
用它把引擎的自说自话挡在你的转录 UI 之外，**不要**拿它写业务分支。没有新增 record kind，也没有新增
消息字段——同一形状，多一个元数据键。

## 6. 内置 CLI 按正文口径读行

`erix repl` 的恢复提示现在按正文消息计数（引擎提示不计，并说明隐藏了几条）；`erix sessions` 与
`-r` 选择器在取预览时会跳过事实行，不再出现空条目、也不会把 judge 的评语当会话标题。只有你在解析
`erix` 输出时才相关；为此 `src/` 一个字节都没动。

## 7. 文档锚点纪律（issue #286）——宿主无需动作

契约里的行号锚点改成了符号锚点，裸行号棘轮因此顺势下调。纯仓库内部事项，列出是为了让你不会因为
「少了这么一节」而困惑。

## 8. 自检

```bash
npm test                       # 1796 tests, 0 failing（node 22 与 24）
npm run check:docs && npm run check:docs:strict
npm run check:release          # 打包 → 装进一次性临时项目 → 跑随包契约套件
```

对着你自己的 store，升级前值得用测试回答三个问题：

1. 同 `dedupKey`、同 payload 写两次 ⇒ 只有一行、不抛错。
2. 同 `dedupKey`、不同 payload ⇒ 你看到 `code === "dedup_payload_conflict"`，且既有行原样不动。
3. 对一个用过 `fold-llm` 与 TTL 的 run 调 `load()` ⇒ `foldedSummary` 与 `ttlDegradations` 还能拿回来，
   而且你的投影没把事实行当轮数。

## 9. 没有变的东西

store 方法签名、返回类型（`appendRound` 仍 resolve 成 `undefined`）、选项名、导出名、record kind、
消息字段、运行时依赖（仍是零）、三个压缩策略的产出，全都没变。judge 的判定面、final guard 与终止
原因也没动——尤其：**软提示永远不会改变 `termination.reason`**。

## 10. 迁移做法

1. 给宿主预写的行一个由你自己的消息 id 导出的稳定 `dedupKey`，然后让冲突错误**保持响**；不要给
   `appendRound` 套一层笼统的 `try/catch`。
2. 投影与 UI：按 `round` 归组、按 `dedupKey` 去重、跳过 `meta.source === "judge-control"`，并且容忍
   `messages` 为空或缺失的行。
3. 如果你的 store 在进出时对字段做过滤，把 `foldedSummary` 与 `ttlDegradations` 加进去（或者干脆别过滤）。
4. 在你希望模型被告知「为什么说它做完了」的地方打开 `reflection.judgeDoneAdvisory`；其他地方先别开，
   等你看过那段文案再说。
