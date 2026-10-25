# 宿主升级指南：0.25.0

**这是「折叠不再为你已经付过钱的字节重复计费」那一版。** 0.24.0 改的是引擎**怎么汇报**它自己干过的事；
0.25.0 改的是一次折叠在**磁盘上花你多少钱**。在此之前每次折叠都会把被折走的正文整段重发一遍，于是长会话
每次折叠都从第 1 轮重新抄账，单条轮记录迟早越过宿主自己的单记录尺寸闸——而那次拒收会把 run 判死。
没有删东西、没有改名、没有 store 方法签名搬家、没有导出或依赖变动，运行时依赖仍然是**零**。

下面每一处都是**纯新增**：今天能对 0.24.0 编译通过的宿主，不改一行照样编译照样跑。你**可能想看的**是那个
新旋钮（§2）和新字段（§3）；§4 才是你会在失败通道里注意到的行为变化。完整清单仍在 `CHANGELOG.md`。

## 1. 变更一览

| 变更 | 你必须动手吗 |
| --- | --- |
| `record.foldedPayload` 改为会话级去重 + 字节夹断（§2） | 不用——但可以定尺寸了：`context.maxFoldedPayloadBytes` / `ERIX_FOLD_ARCHIVE_MAX_BYTES` |
| 新字段 `record.foldedPayloadMeta` 汇报「去重掉多少、夹断掉多少」（§3） | 不用——纯新增；没折叠过的记录本来就没有它 |
| 单条超大轮记录被宿主拒收时，降级那条记录而不是判死整个 run（§4） | 要——如果你在持久化事实上报警：从此会出现一条非致命事实 |
| 读侧正文裁剪**仍然没做**，另由 #462 跟踪（§5） | 不用——只是别以为它已经落地 |

### 本次发布动到的宿主可见表面

- `src/compact/fold-archive.js` —— 新模块：会话级去重账本 + 字节夹断 + 留痕。
- `src/loop/orchestrator.js` —— 写 `record.foldedPayloadMeta`；给 `appendRound` 包上降级路径。
- `context.maxFoldedPayloadBytes` —— 新选项；`ERIX_FOLD_ARCHIVE_MAX_BYTES` —— 新环境变量覆盖。

## 2. `record.foldedPayload`：会话级去重 + 字节夹断

以前：折叠策略返回的那份 payload（`result.foldedPayload`）会被**逐字**写进轮记录，**每次**折叠都写一遍。
它是账本里已有行的逐字节复制，而引擎在 resume 时从不回读——于是 160 轮的会话累积出 O(n²) 的重复字节。
本单的真机数据（erix-station v0.1.32，会话 `9e0c8a17`）：折叠轮 100/121/137 的记录是 569 518 / 742 771 /
960 703 字节，其中归档占 550 000 / 721 538 / 940 278 字节（非归档部分三行都稳定在 ≈ 20 425 字节），
而 round 162 的归档（≈ 1 114 000 字节）把那条记录顶过了宿主 1 MB 的单记录闸。

现在：内容源仍然是你的策略给的那份 payload——你的 `onAfterFold` 钩子、`recoveryHint`、stub 解析吃到的
**内存里那份全量一字未动**——但落盘前按顺序过三道闸：

1. **会话级去重。** 每条消息按规范化 JSON 的 sha256 打指纹，本会话已经归档过的直接丢掉。**resume 过的
   会话会从 `store.load()` 预入账**，所以恢复运行不会把上一段 run 已存的内容再归档一次。
2. **字节夹断。** 归档被夹进字节预算，**保尾丢头**：新的留下，老的从头丢。`0` 是合法预算，含义是
   「只留指针、不写正文」。
3. **留痕。** 上面两道丢掉的东西一律记账汇报（§3），不会被悄悄吞掉。

预算的取值顺序——先到先得：

| 来源 | 说明 |
| --- | --- |
| `context.maxFoldedPayloadBytes` | 显式选项；安全非负整数，`0` = 只留指针 |
| `ERIX_FOLD_ARCHIVE_MAX_BYTES` | 环境变量覆盖，取值规则相同；解析不出或为负数则忽略 |
| `262144` 字节 | 默认值（`DEFAULT_FOLD_ARCHIVE_MAX_BYTES`，即 256 KiB） |

如果你 store 的单记录上限小于 256 KiB，请把选项（或环境变量）设到你的上限**之下**，别去依赖 §4 的降级
路径：降级路径保住的是 run，但那条丢了归档的记录会丢掉它这一轮的取证副本。

## 3. `record.foldedPayloadMeta`：「被夹断」与「没折过」不再同形

被夹断的字段必须自报，否则「归档被夹没了」和「这一轮压根没折叠」在账本上是同一个形状。凡是折叠过的轮次，
记录现在带上：

| 键 | 含义 |
| --- | --- |
| `messages` / `bytes` | 这条记录的归档**实际**装了什么（去重与夹断之后） |
| `capBytes` | 本次折叠生效的预算——读的人由此能分清 `0`（只留指针）与真有正文 |
| `droppedMessages` / `droppedBytes` | 被**夹断**丢掉的（丢头保尾） |
| `dedupedMessages` / `dedupedBytes` | 被**会话级去重**丢掉的——账本里已经有那些行 |

要给这些数求和的人提两点：`droppedBytes` 是拿**去重之后**的源量算的，所以两组数不是朴素可加的；而在 §4
的宿主拒收路径上，记录会额外带 `rejectedByHost: true`，并把 `droppedMessages` / `droppedBytes` 置成被剥掉
的整份归档，同时从这条记录上**删除** `record.foldedPayload`。

`foldedPayload` 依旧是归档而不是展示文本。展示投影仍然只报 `meta.foldedPayloadMessages`（一个计数）——
别把正文倒进聊天视图。

## 4. 宿主拒收超大轮记录，不再把 run 判死

以前：`appendRound` 被宿主拒（例如越过单记录尺寸上限）就是终局性持久化失败——`reason=persistence_failed`
带 `sideEffect=executed_uncommitted`，也就是这一轮的工具**已经执行过但没入账**。

现在：`appendRound` 被包了一层。如果它抛错且这条记录带着非空归档，引擎会剥掉归档、把账写进
`foldedPayloadMeta`（`rejectedByHost: true`），然后**重试一次**。这一笔是非致命事实——`fatal: false`、
`operation=appendRound`、`phase="transcript"`——run 继续。只有重试也失败，才恢复原来的终局行为，因为那时
它真的是存储故障，而不是一个可选字段太大。

宿主侧要做的：如果你按持久化事实报警，请按 `fatal` 过滤而不是按「有没有这条事实」——在尺寸吃紧的 store 上，
`fatal: false` 的记录级降级从此是预期事件。如果你曾断言「`persistence_failed` 就意味着这轮归档缺失」，
这句仍然成立，但它不再是归档缺失的**唯一**出处。

## 5. 没有变的东西

- 交给策略钩子（`onAfterFold`）、`recoveryHint` 与 stub 解析的**内存态** `foldedPayload` 仍是全量；
  被夹断的只有落盘那一份。
- `resume-manager` 仍然只用 `foldedThrough` 做轮号偏移。**读侧对被重放正文的裁剪不在本次发布里**——
  它、水位线的推进/重算口径，以及「摘要不进任何轮记录的 `messages`」这条对账缺口，一起由 **#462** 跟踪。
- 没有 store 签名、选项更名、导出变动、依赖变动，也没有终止 reason 词表的变动。

## 6. 你这边怎么验

```bash
node --test test/compact/fold-archive.test.js   # 本次发布的五条判据
npm run check:release                           # 打包 + 契约套件 + tsc 宿主 + CLI 冒烟
```

再拿一个真实会话对着你自己的上限核一遍：每条带 `foldedPayloadMeta` 的记录都必须满足 `bytes <= capBytes`，
而 `capBytes` 必须不高于你 store 的单记录闸。如果你已经把 `capBytes` 设在那道闸之下却仍看到
`rejectedByHost`，那说明你的 store 是因为归档以外的东西拒收的。
