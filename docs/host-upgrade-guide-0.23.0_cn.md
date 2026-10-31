<!-- doc-version: 0.23.0 -->
# 宿主升级指南：0.23.0

**这是「存储收敛」那一版。** 0.22.0 交的是持久化真相（issue #326）；0.23.0 改的是**一个 run 的正文
存在哪儿**：账本改成**一条消息一行、消息一成型就落盘**，轮行只留**元数据**。`store.load()` 负责把正文
拼回去（它把消息行折回所属的轮），所以读 `load()` 的宿主看到的形状与上一版一致；而**直接读原始 journal
行**的宿主从此**看不到正文**。

**没有任何 store 方法签名搬家，没有删选项，没有改导出名，运行时依赖仍是零。** 有四处宿主会真踩到的
可见变化——§2 到 §5。下面某一节描述的不是你的代码路径，那节对你就是空操作；完整清单仍在 `CHANGELOG.md`。

## 1. 变更一览

| 变更 | 要不要动手 |
| --- | --- |
| 轮行不再带 `messages`，正文在 `kind:"message"` 行里（§2） | 要——只要你绕过 `load()` 自己读 `.jsonl` |
| `onRound(record)` 的 `record` 不再带 `messages`（§3） | 要——只要那个回调要渲染或落盘本轮正文 |
| run snapshot 的 `messages` 只是**落后副本**，不再是正文来源（§4） | 要——只要你从 `.snapshot.json` 恢复上下文 |
| 展示投影必须喂 `store.load()` 的折叠输出（§5） | 要——只要你把原始行喂给 `projectTranscriptForDisplay` |

一句话版本：**`store.load()` 就是正文 API。** 以前「我从 journal 里读出来的那一行」成立的事，现在
只对「`load()` 交给我的那条记录」成立，别的地方都不成立。

## 2. 轮行不再带 `messages`

**现象。** 一个 run 的 `.jsonl` 现在有两种行。用内置 file store 实测一次两轮的 run（一次工具调用 +
一句终稿）：

| 行（`dedupKey`） | `kind` | `seq` | 是否带 `messages` |
| --- | --- | --- | --- |
| `<runId>:engine:round:0:seed` | — | — | 带（1 条） |
| `<runId>:msg:1:0` | `"message"` | `0` | 带（1 条）——assistant 正文，落盘在它的工具**执行之前** |
| `<runId>:msg:1:1` | `"message"` | `1` | 带（1 条）——工具结果，一产生就落盘 |
| `<runId>:engine:round:1` | — | — | **根本没有这个键** |
| `<runId>:msg:2:0` | `"message"` | `0` | 带（1 条） |
| `<runId>:engine:round:2` | — | — | **根本没有这个键** |

同一个 run 上 `load()` 返回 **3 条记录**，摊开是 **4 条**消息：轮行的正文由 `foldMessageRows`
（`src/store/message-rows.js`）折回去——`src/loop/resume-manager.js` 重建模型上下文用的就是它。

**判据。** 在你的宿主里 grep 读 transcript 文件 / 原始 `appendRound` payload 的地方：
`JSON.parse(line).messages`、自己解析出来的行上的 `record.messages`、你自己库里镜像 journal 行的列。
其中任何一处指望那里有正文，你就受影响。

**改法。** 正文一律走 `store.load(runId)`——`createFileTranscriptStore({ dir }).load(runId)` 或
`createMemoryTranscriptStore().load(runId)`——再按 `records.flatMap((record) => record.messages ?? [])`
摊平，这正是引擎自己用的口径。两条仍然成立、可以放心依赖：

- **`load()` 的形状没变。** 一轮一条记录、正文挂在上面，另外引擎自己的事实/控制行（`:control:` / `:fold:` / `:ttl:` 由 0.22.0 引入，`:resume` / `:input:` 更早）照旧存在，它们的 `messages` 照旧可能为空或缺失。
- **行序就是追加序。** 消息行写在它描述的那次工具**执行之前**，所以「第 N 轮的正文」不再是
  「round 为 N 的那一行」。

如果你读原始行是为了审计（引擎自己的真上游 e2e 就是这么干的，它要断言「盘上真相」），继续读——只是
别再向它要正文。

## 3. `onRound(record)` 不再带 `messages`

**现象。** 递给 `onRound` 的 `record` 就是引擎落盘的那条轮记录。既然轮记录不再写 `messages`，
`record.messages` 现在是 `undefined`（不是空数组）。其余字段一字未变：`round`、`response`
（`content` / `stopReason` / `usage`）、`textPreview`、`summary`、`l0facts`、`runState`、`toolUses`、
`judge`、`wrapup`、`compactionStats`。（`foldedSummary` 与 `ttlDegradations` **不是**轮记录字段——它们各有自己的
事实行 `…:fold:<fp>` / `…:ttl:<fp>`，`messages` 为 `[]`；要读就从 `load()` 的行里读，别从 `onRound` 的
`record` 里要。）

**判据。** `grep -n "onRound" your-host.js`，看回调里有没有 `record.messages`。

**改法。** 两个诚实的选择，都行：

1. 只用它还剩的东西：`response.content` 仍是本轮的 assistant 正文，`textPreview` 是它的前若干字符，
   但别指望在回调里拿到整段对话；
2. 真需要正文时读 `store.load(runId)`——比如 run 结束时读一次，或者你能接受每轮一次读，就在回调里读。

**不要**把各轮的 `onRound` 记录首尾相接来重建正文：引擎自己注入的文本（judge 评审意见、扩轮提示、
强制收尾）落在独立的 `:control:` 行里，从不出现在轮记录中，拼接会**静默丢掉**它们。

## 4. run snapshot 的 `messages` 是落后副本，不是正文来源

**现象——这条要仔细读，直觉的读法是错的。** run snapshot（`.snapshot.json`，经 `saveRunSnapshot` 写）
**仍然带一个 `messages` 数组**。同一次两轮 run 实测：`messages` **3 条**，`status:"executed"`、
`round:1`。变的是引擎**不再拿它当正文来源**：快照写于本轮工具执行**之前**，那份副本必然**落后于**账本，
把它当上下文喂回去等于把正文回滚。

所以从 `snapshot.messages` 恢复上下文的宿主，读到的不是「真相」，而是「最后一个安全点上的真相」——
本版之后引擎自己的恢复路径已经不看它了（它从 `store.load()` 重建，只把快照留着回答「哪个工具还在飞、
有没有半截正文」）。快照那份正文副本只剩一个用途：**升级路径**——给 0.23.0 之前写的账本用，那些账本里
崩溃轮的正文**只**存在于快照。

**判据。** 你的 resume / 恢复路径里是否有 `snapshot.messages` → 你的上下文。有就受影响。

**改法。** 上下文从 `store.load(runId)`（折叠输出）重建，快照只取**执行状态**：`pendingToolUses` /
`toolResults` / `partialText` / `round` / `status` / `executedToolIds`。若你必须为老 run 留一条正文
回退，就照引擎那样加闸门：**只**在「账本在锚点之后一条都没有」时才用快照正文，也就是只对逐条落盘之前
的账本生效。**永远不要无条件两份都用**——那正是引擎这次删掉的双喂 bug。

## 5. 展示投影必须喂 `load()` 的折叠输出

**现象。** `projectTranscriptForDisplay`（`src/display/projection.js`）吃 transcript 记录、产出展示
条目。喂**原始 journal 行**，它现在会**重复出条目**，并且**缺执行事实**。

**反例，具体到可复现。** 拿 §2 那个两轮 run，把原始行而不是 `load()` 的输出喂给投影：

- 每一轮出现**两遍**——一遍来自轮行（元数据 + `response.content`），一遍来自携带同一段 assistant
  正文的 `kind:"message"` 行；
- 工具条目的 `durationMs` **缺失**（`undefined`），因为在新账本里 assistant 的调用与它的结果落在
  **两行**上（调用在工具执行前就落盘，结果在跑完后落盘），逐条记录配对的投影根本配不上；
- 同一个 `toolCallKey` 出现两次，于是任何「一次调用一条」的断言都红。

这不是假设：本仓自己的真上游冒烟脚本就踩了这个坑（`scripts/cli-real-smoke.mjs`，本版修掉），修法就是
把输入换成 `createFileTranscriptStore({ dir: transcripts }).load(runId)`——别的一处没改，断言一条没放宽。

**判据。** 找到你调 `projectTranscriptForDisplay`（或你自己的等价物）的地方，看实参从哪来：
`readFile` + `split("\n")` + `JSON.parse`、对流的 `for await`、或者任何不是 `load()` 的 store 方法。

**改法。** 传 `store.load(runId)`。若你还要原始行做别的事，就留两个变量——折叠的给展示、原始的给审计——
永远别互换。

## 6. 自检

```bash
npm test                       # 1,842 例，0 失败（基线 1,833 通过 + 9 skip）
npm run check:docs && npm run check:docs:strict
npm run check:release          # 打包、装进临时工程、跑随包契约套件
```

针对你自己的 store 和 UI，升级前值得用测试回答四问：

1. 一个 run 的原始 journal 行 → 轮行没有 `messages`；`kind:"message"` 行有。
2. `store.load(runId)` → 记录条数与上一版一致、正文完整、`flatMap` 出来的消息序列与模型当时看到的一致。
3. `onRound` 回调 → `record.messages` 是 `undefined`，且你的回调不依赖它。
4. 投影喂 `load()` → 一次调用一条、`durationMs` 在；投影喂原始行 → 条目重复（这就是你要防的回归）。

## 7. 没有变的东西

没有 store 方法签名、没有返回类型、没有选项名、没有导出、没有新 record kind、没有新消息字段、没有运行时
依赖（仍是零）。`load()` 返回的记录形状与 0.22.0 一致，包括那一版引入的事实行。`projectTranscriptForDisplay`
的条目形状与语义一字未动（投影现在优先取折叠后的轮内 assistant 消息、而不是 `record.response.content`
——同一段文字，只是归属被定死了，详见 `CHANGELOG.md`）。终止原因、judge 判定面、final guard 都没动。

## 8. 迁移配方

1. 所有经过原始行的正文读取，换成 `store.load(runId)`。
2. `onRound` 里停止读 `record.messages`；继续用 `response.content` / `textPreview`，真需要整段对话时读 `load()`。
3. 恢复路径：上下文从账本重建，快照只取执行状态；快照正文回退只留给 0.23.0 之前的账本，并以「账本在锚点
   之后一条都没有」为闸门。
4. `projectTranscriptForDisplay` 只喂折叠输出。
5. 重跑你自己那条「模型当时看到了什么」的测试：它现在应当只靠 `load()` 就能过，完全不需要知道盘上的行布局。
