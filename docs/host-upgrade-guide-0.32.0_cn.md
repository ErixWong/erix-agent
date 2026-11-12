<!-- doc-version: 0.32.0 -->
# 宿主升级指南：0.32.0

> 范围：写本文件时 `CHANGELOG.md` 里 `## [Unreleased]` 之下的全部内容。
> 下面每一条都在 `origin/main`（f3e935a6）那棵树上**重新打开过源码**，不是照抄 changelog 的措辞。
> 本文件写在切版**之前**，与 0.31.0 那份同法（它也是发版那笔之前的一笔 docs 提交）。
> 只讲库的公共面；`erix_run` 扩展单列一节（§8），因为它不是公共 API。

## 1. 先读这张表

| 如果你 … | 那么 0.32.0 里 |
|---|---|
| 从 `snapshot.messages` 读正文 | **别再读**：它现在只交当前轮的残余（§2.2） |
| 读 `snapshot.toolUse` / `.ts` / `.status` / `.compactionStats` | 这四格**不再写入**（§2.2） |
| 续跑 261021 之前的旧档 | 它们**不再能续跑**（§2.1） |
| 调 `appendUserTurn` | 返回值多一个可选字段 `unsettledToolUses`（§4） |
| 想让崩溃缺口在账本里自己闭合 | 实现 `loadRawRows`（§3.1、§4） |
| 按契约套件写过 store | 新增可选第三参数，声明你到底实现了什么（§3.3） |
| 什么都不做 | 不会坏：新能力全部可选，跳过时会**出声**降级 |

这一版**没有删除或退役任何导出名**。`npm run check:host-consumers` 现算出待删候选 0 个、宿主命中 0
处，所以这一版不存在「哪个 import 会断」——**这也是本指南没有逐名表的原因**：下面讲的都是行为。

## 2. 会传到你的用户身上的行为变化

### 2.1 261021 之前的 run snapshot 不再能续跑（#754）

pre-261021 的升级闸门已关闭，且**没有替代路径**。那些归档带着三格今天的账本已经不再生产的
内容（截半的 assistant 正文、`toolResults`、`pendingToolUse`）；继续读它们，等于让一个 run
在崩溃已经丢掉的那份上下文上往下跑——而且是在生产里静默地跑。

- **你会看到**：续跑时发一条 `:control:resume-notice`，明说旧格式快照被丢弃、恢复上下文改由
  账本重建。**没有新事件类型，也没有新 reason 值**——它走的是既有那条告示通道。
- **你不会再看到**：空正文、被静默跳过的工具、假的成功。那三个才是原来的 bug。
- **一定要救这类归档**：自己把那三格读出来（盘上还在），自己决定该告诉模型什么；或者重开一个 run。

### 2.2 run snapshot 的载荷变小了（#735 片 1–2、#770，两轴口径 #767）

四格不再写入，四格的「恢复侧零读者」都是量出来的：

| 格子 | 由谁停写 | 为什么敢停 |
|---|---|---|
| `toolUse` | #735 片 1 | 它与 `pendingToolUse` 是同一次 clone 的两份 |
| `ts` | #735 片 1 | 恢复侧在快照对象那一层从不读它 |
| `status` | #770 | 分类改由调用点显式交进来 |
| `compactionStats` | #770 | 全仓只有一个测试读它 |

键的**顺序**刻意保持不变（`src/store/file.js` 直接序列化载荷，键序就是宿主可见的落盘字节），
并且有机器断言钉住这四格。

`snapshot.messages` 的语义变了（#735 片 2）：这一格现在**只交当前轮的残余**，残余之前的格子是
`null`。从 `snapshot.messages` 读正文**不再被支持**——**去读账本**。下标对齐保持不变，
`messages.slice(anchor)` 的含义与以前一致。要读快照的话，请打开 `docs/host-consumer-contract.md`
里那张两轴表（每一格都写明谁写它、谁读它）。

### 2.3 项目约定注入上限：32 KiB → 64 KiB（#721）

`PROJECT_INSTRUCTIONS_MAX_BYTES` 现在是 `64 * 1024`（`src/project-instructions.js`）。被截断时，
注入的正文末尾会追加一行截断标记；`discoverProjectInstructions()` 现在返回 `droppedSections`，
你能直接看到哪些段落没进去，不用猜。原先就贴着旧上限注入的宿主，**你的提示词变大了**，
请核一遍 token 预算。

## 3. 新增的可选 store 能力

这里没有一条是必需的。下表就是全部契约——右列是你跳过时会发生什么，每种情况 run 都还能跑。

| 能力 | 必需吗 | 跳过的后果 |
|---|---|---|
| `loadRawRows(runId)`（#714） | 否 | 崩溃缺口的桩只进本次请求视图，每对发一条 `resume_journal_skipped` |
| `appendRecoveryRow` / `listRecoveryRows` / `clearRecoveryRows`（#769） | 否 | 缺哪个方法，每个 run 各发一条 `persistence_capability_degraded`（读侧缺席则静默） |
| `transcriptStoreContract` 的第三参数（#739） | 否 | 套件继续假设你什么都没实现，那些用例被跳过 |

### 3.1 `loadRawRows`——唯一那把快刀在 `round` 的类型上

交回某个 run **未折叠的原始行**（与 `load()` 同一条读路径）。折叠会丢掉 `round` 不是安全整数的行：

```js
// src/store/message-rows.js
const round = Number.isSafeInteger(record?.round) ? record.round : undefined;
if ( round === undefined ) continue;   // 那一轮从重建视图里消失
```

所以请把数值类型一路保住。丢它的通常不是引擎：PG 列建成了 `text`，或者 MySQL 驱动开了
`bigNumberStrings`，整数就变成 `"2"`，那一轮于是消失。走引擎自己的写手写出来的行是安全的；
你手写的行归你管。**#811 把这道检查前移到写侧**：两个内置 store 的 `appendRound` /
`appendMessageRow` / `appendRecoveryRow` 与 `appendUserTurn`，交回的 `round` 不是 JS 安全整数时**直接抛
`TypeError`**——错误信息点名哪个入口、收到的值与类型；选 `TypeError` 是故意的，宿主错误映射会把它
当成客户端错误而不是服务端错误。**已经在档案里的行不会被追溯拒收**：读侧依旧宽容，两条折叠
现在也口径一致地让它**不参与折叠**（以前其中一条会把它挂到 round `0`，崩溃边界与整张轮次表都被它拖跑）。

### 3.2 恢复行（#769）——账本成了恢复侧的主通道

引擎现在把「这个工具执行过」「这段正文产出了、不可重放」作为**恢复行**记进账本，续跑时读回来。
快照那几格退成兜底，不再是唯一去处。对你的影响：

- 读侧方法**存在但 reject** 的 store，现在会让 run 以一个新增终局错误收场：
  `RECOVERY_ROWS_UNREADABLE`（`src/loop/resume-manager.js`；发到线上的值是该名的小写形式）
  ——**要么老实实现，要么干脆没有**；
- 写侧或清盘侧方法缺失的 store，每个 run 各得一条 `persistence_capability_degraded`；
- 恢复事件键是新出现的，与轮行/消息行不撞：`<runId>:engine:round:<n>:recovery:<event>:<discriminator>`
  （`recoveryEventKey`，`src/store/recovery-rows.js`）。判别位对 `tool-executed` 是 `toolUseId`，
  对 `partial-text` 是**正文指纹**——更长的半截正文是一个新事件，绝不是覆盖旧行；
- **那份新文件和账本同后缀 `.jsonl`**：`<dir>/<runId>.recovery.jsonl`（`recoveryRowsPath`，
  `src/store/file.js`）。在 store 目录里按 `*.jsonl` 枚举的宿主从此**每个 run 看到两份文件**，
  所有“一个 run 只有一个文件”的假设都会碎——契约的恢复行一节把这个坑
  当作严格校验的宿主必须处理的东西点名了出来；
- **已知限制，挂在 issue #791**：`partial-text` 行没有前缀上限、没有 TTL，每次成功的 partial commit
  都把**该轮到那时为止已写的整段正文**整段追写一行；那个文件只追加，只在一开始重开 run 时清盘
  （`clearRecoveryRows`，而且只在持久化开着、且 store 真有这个方法时清）⇒ 一个轮存下的字节数
  随提交次数平方级增长。本版没有任何东西限制它——半截正文很大的宿主应当把它算进预算，
  因为“删旧行”不是这一版会做的事。

### 3.3 契约套件不再逼你撒谎（#739）

`transcriptStoreContract(name, factory, optionalCapabilities)`——第三参数声明你的 store 真的实现了
哪些可选能力。**诚实声明有意义**：**整组缺席**是合法跳过，**半组实现**会被点名成契约违规。
`Object.freeze` 之后的 store 现在合法了；那份能力清单与装配校验器用的是同一个源，所以它不可能
与引擎实际会调的东西走偏。

## 4. `appendUserTurn` 多了一个返回字段（#765/#789）

在你那条用户行落盘**之前**，引擎现在会先把崩溃留下的悬空 `tool_use` 结清。
为什么是「之前」而不是「之后」：工具结果必须是紧跟其调用的那一页，而账本只能往后加——
你那条文本行一旦落盘，之后追加的任何一行都满足不了「紧跟」，于是每次续跑都死在本地校验。
以前你在崩溃后发一条消息就能把归档写砖；现在引擎先补缺口。

```js
const r = await appendUserTurn(store, { key: runId, text: userInput });
if (r.unsettledToolUses) {
  // r.unsettledToolUses.status === "settled" | "refused"
  // .round .toolUseIds .dedupKey .written? .reason?
}
```

**没有东西要结清时这个字段不存在**——除非你想统计，否则不必为它加分支。三条拒写原因（issue #811 删掉了 `round_not_safe_integer`：这种 `round`
现在在写侧就抛了，见 §3.1），
而「拒」不是错误：你那行照样写入，run 照样能续跑（#790 的请求视图兜底在后面接手）：

| reason | 含义 | 你能做什么 |
|---|---|---|
| `ledger_probe_absent` | 你的 store 没有 `loadRawRows` | 补上它（§3.1） |
| `round_carrier_has_body` | 那一轮的载体已带正文，桩会被折进错的页 | 没办法 |
| `tool_use_id_unusable` | `tool_use` 这个 id 本身不可用 | 没办法 |

dedup 命名空间新增 `<key>:settle:<round>:<tool_use id 排序后用 + 连接>`。实现了
`loadByDedupKey` 与 `loadMaxRound` 却**没有** `loadRawRows` 的 store，每次调用都会拿
`ledger_probe_absent`——`erix-station` 那个 PostgreSQL store 现在就是这个状态。

## 5. 新增的事件、reason 与 detail 取值

- **新事件名** `host_steer_injected`（tier `fact`，载荷 `round` / `chars`）——只有你实现了
  `capabilities.hooks.nextUserTurn` 才会发；这类 run 的 `diagnostics.steer` 会给
  `{offered, injected, rejected, lastRound}`。
- **`resume_journal_skipped` 新增 reason**：`mid_sequence_merge_refused`、
  `mid_sequence_shape_not_supported`、`mid_sequence_stub_row_write_refused`（#730），以及
  `mid_sequence_request_view_stub`（#790）。`mid_sequence_aggregate_row_not_in_ledger` 下的 `detail`
  现在区分 `anchor_probe_absent` / `round_carrier_has_body` / `aggregate_row_not_in_ledger`。
  **没有新事件类型**——放弃结算都挂在这条既有事件上。
- **一个从契约里退场的值**（#811）：`round_not_safe_integer` 现在**不存在了**——既不是
  `mid_sequence_stub_row_write_refused` 的事件 **detail**，也不是 `appendUserTurn` 的 **reason**，也不在
  #730 那个枚举闭集里。校验前移到了写侧（非法轮号在那里抛 `TypeError`，见 §3.1），会发它的那条分支
  于是构造性不可达，连同两个常量与中英两份契约里的行一起删了。#811 **没加事件类型、也没加
  reason/detail 取值**；一行带着不可用的轮号走到引擎时根本不发放弃结算事件（「store 拒写」与
  「轮号不可用」不再被当成同一件事）。
- **新增导出，帮你决定该留哪些行**（#743）：`EVENT_TIERS`、`eventTierOf`、`EVENT_TIER_VALUES`、
  `HOST_SIDE_EVENT_TYPE_NAMES`、`RUN_TERMINAL_STATUSES`、`RUN_CLEANUP_SAFE_STATUSES`、
  `streamCleanupEligible()`。引擎不会替你删任何东西；这些是你自己保留策略的查表面。

## 6. 你已经在读的记录上加了字段（无需动手）

全部是纯加法，而且规则对每一条都一样：**缺席就是「没有这个事实」，绝不是 0**。

- `usage.reasoningTokens`——只在上游回报时才有（怎么要见 §7）。
- `RoundRecord.sentRequestParams.reasoningEffort` = `{hostValue, sentValue, source, translated?}`——
  自建 provider 的实现永远不会产出这一格。
- `RoundRecord.runStateMeta` = `{bytes, capBytes, truncated}`——一本字节账，什么都没少。
- `compaction` / `deterministic.compactionStats` 新增 `foldArchive` 投影（`droppedMessages`、
  `droppedBytes`，有时还有 `capBytes` / `dedupedMessages`）——只在投影有事实时出现，
  所以旧形状逐字节不变。
- `foldedSummary.fedSummaryText`，加上规划器字段 `replaySource` / `savedSummaryBytes` /
  `replayedSummaryBytes` / `byteEqual ∈ equal|differ|unknown`。

## 7. CLI 面（#798）

`erix chat` 与 `erix repl` 接受 `--effort <档>`，并消费 `LLM_KIT_REASONING_EFFORT`。
优先级是 **`--effort` > env > `slots.default.reasoning_effort`**——与 `--model`（槽位赢）**故意相反**。
空值在所有位置都等于「未提供」。用量行只在上游回报时才打 `reasoningTokens=`。
没有上游映射的档位会被丢弃并计数，不会原样传给第三种协议。

## 8. 扩展面（`examples/pi-extension`，即 `erix_run` 工具）

不是库的公共 API——只用包的读者可以跳过本节。下面三条**都没碰** `src/` 与 `bin/`：

- `action: "steer"` 把话投进正在跑的后台任务；`steerPending` 恒在场（是 `0`，不是缺键），
  `diagnostics.steer` 透传到 `status` / `result` / `status.json`（#753 C2）。
- 旧扩展实例迟到的 `session_shutdown` 不再误摘活会话的句柄、也不再误清它的定时器；
  `handleReleaseRefusals` / `orphanRecoveries` / `orphanRecoveredAt` / `shutdownTimerSkips`
  都读得到，`session_start` 会补投孤儿任务（#800）。
- `finalGuard` 的取证面改成「存活窗口 ∪ 本次账本」；`diagnostics.finalGuard.evidence` 带
  `source` / `round` / `survivesLastCompaction`；`verification.reason` 新增 `not_in_ledger`
  （`status` 仍是 `unverified`）（#797）。

## 9. 没有变的东西

- **选项——本版变了一处，变的是载荷语义，不是键集合。**0.31 的每一个选项键含义照旧（唯一的增添是
  CLI 旗标 `--effort`，§6）；变的是 `snapshot.messages` 如今只装**残余**，而不是宿主以为能从那里
  读到的消息列表，所以正文要回到账本去读（#735 第二刀、#770、#767）；
- **默认值照 0.31 列的那样**——同一套默认面、嵌套位置照旧（`run.maxRounds`、`folding.toolResultTtl`、
  `guard.finalGuardMaxRetries`、`timing.timeoutMs` 等）。这里抬的是上限而不是默认值：
  `PROJECT_INSTRUCTIONS_MAX_BYTES` 从 32 KiB 抬到 64 KiB，超限的内容被截断并留一行标记，
  `droppedSections` 报出没塞进去的小节，不是整份丢（§2.3）；
- **观察者事件与 0.31 一致**：每一个既有事件名、每一个既有 `reason` 的含义不变，原本没有 `detail` 的
  事件依旧没有。本版增添的是两个名字（`context_pack_failed` §5、`persistence_capability_degraded` §3.2），
  不是改名；
- **诊断字段——`compactionStats` 本版改了一处：run snapshot 的载荷不再带它**（#770）。
  `createCompactionStat` 产出的条目形状与轮记录里那一份都没动，所以原先读快照那一格的宿主现在读轮记录；
- **磁盘格式——本版变了一处：一个 run 不再只有一个文件。**轮记录 `<dir>/<runId>.jsonl` 逐字不变，
  `seq` 也没动（CHANGELOG 提到它只作为行序键，#811 / #765）；新增的是每 run 的第二份文件与恢复事件键
  （§3.2）；
- **终局载荷——本版改了一个紧挨着它的字段，格子本身没动。**终局载荷的键集合就是 0.31 那一套。本版 CHANGELOG 点名的
  `truncated` 是轮记录里的一格（`runState.bounds.truncated`，0.31 就有；#742 在它旁边加了“这一轮副本
  多少字节”），所以宿主从一个已完成的 run 里读出来的东西没有挪；
- 没有删除导出、没有改名、`files` / `exports` 里没删过任何条目；
- `executionStatus` 的闭集仍是 `intercepted / interrupted / rejected`；
- 账本行格式不变；新增的 dedup 键只有 `<key>:settle:<round>:<ids>`（§4）与恢复事件键
  `<runId>:engine:round:<n>:recovery:<event>:<discriminator>`（§3.2）；
- 每一个既有事件名、每一个既有 reason 的含义不变；原本没有 `detail` 的事件形状逐字不变；
- `readFile` 的承诺没改，但它的模型可见容量行换到了更低一档（3,700 → 3,650 行），因为全树最紧的
  那个文件换了主人——这是提示词文案变了，不是行为变了。

## 10. 在你自己那边验一遍

```bash
npm view erix-agent version                      # 0.32.0（等 registry 可安装，别只看到 tag）
npm install erix-agent@0.32.0 --prefer-online

# 1. 你的 store 有没有声明新的可选探针？
grep -rn "loadRawRows\|appendRecoveryRow\|listRecoveryRows\|clearRecoveryRows" <你的 store 目录>

# 2. 你的 store 有没有把 round 保持成数值？
grep -rn "bigNumberStrings\|::text\|CAST(" <你的 store 目录>

# 3. 你有没有读这一版停写的快照格？
grep -rn "\.toolUse\b\|\.compactionStats\b" <你读快照的代码>

# 4. 用诚实的能力声明跑一遍随包发布的 store 契约套件
#    （第三参数；整组缺席就声明缺席，别半组实现）

# 5. 行为冒烟：续跑一个以前会砖掉的归档
#    期望：没有 invalid_messages / 没有 "assistant tool_use has no immediately following user
#    tool_result"；appendUserTurn 要么不带 unsettledToolUses，要么带 §4 里那条 reason。
```

想让账本自己闭合、而不是每次续跑都现场修补，你需要做的只有 §3.1 那一件事。
本指南其余内容全是可选的。
