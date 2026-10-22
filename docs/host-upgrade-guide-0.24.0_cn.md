# 宿主升级指南：0.24.0

**这是「运行时不再替你做猜测」那一版。** 0.23.0 改的是**一个 run 的正文存在哪儿**；0.24.0 改的是
**引擎怎么汇报它自己干过的事**：状态文件现在自报它留下了多少条削减账，两个持久化失败出口从此带
**同名同类型**的字段，还有几处工具输出不再「悄悄改参数 / 悄悄说没错」而是把真实情况写出来。没有删
东西、没有改名、没有 store 方法签名搬家，运行时依赖仍然是**零**。

**其中三处是增量信息，其余是模型可见文本。** 这里没有任何一处会让今天能编译的宿主编译不过——
但如果你断言工具输出文本，或者靠猜去读 `err.unpersisted` / `err.cause`，你会**看见**差别，而且应该看见：
那些读法从此是「有定义的」，不再是「读过源码才成立」。下面某一节描述的不是你的代码路径，那节对你就是
空操作；完整清单仍在 `CHANGELOG.md`。

## 1. 变更一览

| 变更 | 要不要动手 |
| --- | --- |
| `<runId>.state.json` 自报 `deterministic.compactionStatsWindow = { limit, dropped, total }`（§2） | 不用——增量字段；旧文件就是没有这个键 |
| `checkpoint_failed` 现在带 `cause` / `errorCode` / `unpersisted`，与 `persistence_failed` **键名与取值类型都相同**（§3） | 不用——但请停止解析 `message` 字符串，并复查 `Array.isArray` / `err.cause.message` 这类探针 |
| `tree` 的非根目标：首行是**相对路径**，不再是 basename（§4） | 要——只要你比较或回放工具输出文本 |
| `readFile` 改写你入参时给 `[参数校正：…]`，读到末尾给 `[已到末尾：…]` 而不是空串（§5） | 要——只要你断言 `readFile` 输出 |
| `rg` / `grep` / `searchText`：搜索根不存在是**错误文本**而不再是 `（无命中）`；`rg`/`grep` 的弃用提示按**本次**语义给 mode（§6） | 要——只要你比较工具输出文本 |
| tarball 现在随包 `test/helpers/tmp.js`；门禁侧落地三项（§7） | 不用——只关乎打包与门禁 |
| `finalGuard` 现在除原有 7 键外还拿到 10 个加法事实（`cwd`、`runId`、`filesWritten`、`toolStats`、`taskBrief`、`selfReport`、`usage`、`elapsedMs`、`attempt`、`guardBudget`）（§8） | 不用——纯加法；只有你原本在重解析 `messages` 或拿 `finalText` 猜结论时才要动手 |

一句话版本：**以前要靠你推断的事实，现在写在明面上了。** 引擎没有改它**做**什么，改的是它**说**什么——
状态文件里、错误对象上，以及模型会读到的那几处工具输出。

## 2. `<runId>.state.json` 自报削减账的窗口

**现象。** `<runId>.state.json` 里的 `deterministic.compactionStats` 一直是**尾巴**：状态文件有体积预算，
只留最后 `COMPACTION_STATS_STATE_LIMIT`（`src/compact/pipeline.js`）条——值 `32`——字段名里零提示，于是
「去 state 文件数削减账」的宿主在**长 run**（恰恰是算成本的那类）上读到的是被切过尾的数据，而且分不清
「原本 30 条」与「原本 300 条」。

**新东西。** `compactionStatsWindow`（`src/run-state.js`）与那个数组同时落盘：

| 字段 | 含义 |
| --- | --- |
| `limit` | 窗口条数（仍是 `32`，体积预算没动） |
| `dropped` | 被丢弃条数（`max(0, total − limit)`） |
| `total` | 本次 run 实际产出条数 |

所以 `total > limit`（⇔ `dropped > 0`）即说明「你手里这份是尾巴」。`dropped > 0` 时
`dropped === total − limit` 恒成立，否则 `dropped === 0`。

**三条边界值得知道。**

- **只在 `total > 0` 时出现。** 一条统计都没有的 run 没有可截断的东西，于是这个键**缺席**而不是一行零——
  这里的缺席不是歧义。
- **第二道截断也让账对得上。** 序列化后仍超过 `RUN_STATE_MAX_SERIALIZED_BYTES`（`src/run-state.js`）——64 KiB——
  时，数组会再切到最后 `COMPACTION_STATS_SERIALIZED_LIMIT`（`src/run-state.js`）——8 条——窗口账**跟着改口**
  （`limit: 8`、`dropped`/`total` 重算）。你不会看到「数组 8 条、账说 32」。
- **run 返回值仍是全量。** `runToolLoop` 的 `compactionStats` 从来没被截断，这次也没截；被截的只有状态文件。

**读旧文件。** `validateRunState`（`src/run-state.js`）**放过**没有该字段的旧档（不判坏档），只有「有、但形状
坏了」才判坏。旧账本照旧 validate、照旧可续跑——这条是本次发布里**真跑**过的用例，不是推测。

**改法。** 不用改。如果你此前靠重读 transcript 或数 `compaction` 事件来补这个截断，现在可以直接读
`compactionStatsWindow.total`；想知道手里是不是全量，比 `dropped` 与 `0`。

## 3. `checkpoint_failed` 与 `persistence_failed` 从此对称——键名**与取值类型**都对称

**现象。** 同一次底层故障（run snapshot 落盘失败）有两个出口。run 末尾那个 `persistence_failed` 带根因
与未落盘清单；工具调用点的 `checkpoint_failed` 只透传 `operation` / `persistence` / `persistenceError` 与
调用点自己的 `phase` / `sideEffect`。宿主按「能不能恢复」/「要不要重放」分流时，后者只能去解析 `message`
字符串——正是 issue #176 当初要消灭的用法。

**新东西。** 两个出口现在都带这三个字段，而且——这一句要读两遍——**取值类型也相同**：

| 字段 | 类型 | 是什么 |
| --- | --- | --- |
| `cause` | **`Error` 对象**（不是字符串） | 底层失败本身；`checkpoint_failed` 上取链上最深那一环，即 store 自己抛的那个错 |
| `errorCode` | **字符串** | 与 `termination.errorCode` 同一套分类，由 `terminationErrorCodeForError`（`src/loop/termination.js`）产出：取根因自己的 `code`，取不到即 `"unknown"` |
| `unpersisted` | **原始数组** | 与 `persistence_failed` 一直以来的形状相同（`errorLedger.toUnpersisted()`），于是 `err.unpersisted.length` 两侧同读 |

工具调用点那一侧由 `assertSnapshotPersisted`（`src/loop/run-snapshot-executor.js`）写；run 末尾那一侧由
`makePersistenceFailure`（`src/loop/orchestrator.js`）写。三个字段**两侧都无条件写**，且两侧都经 `KitError`
的 `{ cause }` 选项进构造函数 ⇒ 两侧的 `cause` 都是**不可枚举**自有属性，`Object.keys(err)` 与 `{ ...err }`
给出同一形状。

**没变的。** 错误码、`phase` / `sideEffect` 的语义、fail-closed 的早退条件、公共导出面，一字未动。
`{ count, items }` 投影仍只在它该在的地方——`<runId>.state.json` 里的 `deterministic.errors.unpersisted`；
错误对象上**不许**出现第二形状，每处只有一种形状。

**判据。** 在你的宿主里 grep `checkpoint_failed` / `persistence_failed` 附近的
`err.message.includes(`、`typeof err.cause === "string"`、`err.unpersisted.count`。前两条现在不必要
（第二条现在**是错的**），第三条在错误对象上从来就是错的。

**改法。** `Array.isArray(err.unpersisted)`、`err.cause.message` / `err.cause.code`、`err.errorCode`。
如果你此前靠字符串匹配决定「重试还是重放」，改用 `errorCode`——它与引擎自己的终局载荷同一套分类，
一个读法管两个出口。

## 4. `tree` 的非根目标现在打可回放的相对路径

**现象。** 根标签在 0.23.0 修好了（解析到工作目录根的**任何**写法都打 `./`）。**非根**目标仍走
`path.basename`，于是 `tree { path: "nested/sub" }` 的首行是 `sub/`。它「看起来能回放」，其实不能：
两个不同父目录下的 `sub` 首行一模一样，绝对路径入参更是把父链整个丢掉。

**新东西。** 首行是 `displayName`（`src/tools/file-tools.js`）——**相对工具工作目录**的路径，上面那个调用
给 `nested/sub/`。把这一行抄回 `path`（去掉尾斜杠）逐字得到同一棵树。根那一格未变（`./`），条目、depth /
条目上限 marker、排除账文本同样未变。

**判据。** 如果你解析 `tree` 输出，找那种把首行当**目录名**用的代码（例如 `lines[0].replace("/", "")`
再 `path.join(某个父目录, name)`）——它现在会拼出重复的路径。

**改法。** 把首行原样当 `path` 用，或者干脆别解析它——它是个标签，唯一的契约是「喂回去得到同一棵树」。

## 5. `readFile` 改写你入参时会说，读到末尾不再回答「什么都没有」

**现象。** 两个静默行为，都让模型对文件的认知是错的：

- `offset: "120"`（数字串）被当非数字归 `0`；`offset: -5` 钳到 `0`；`limit: 1.9` 向下取整；`max_bytes`
  越界回默认值。四种改写在输出里**读不出来**——而兜底值恰好等于默认值，于是「我改了」与「你本来就要这个」
  逐字不可分。
- `offset` 越过文件末尾返回**空串**，与「文件是空的」不可分。

**新东西。** `toolMarker`（`src/tools/file-tools.js`）现在在读取路径上渲染两个 marker：

- `[参数校正：<原值> … 已按 <生效值> 处理；…重传 readFile 并传整数 <names>]`——只在真的改写过时报，
  且原值按 JSON 字面量给出（数字串与数字可分）、生效值、以及怎么重传。
- `[已到末尾：offset=<N> 越过文件末尾（共 <total> 行，最后一行 offset=<last>），本次无新内容]`——
  顶替原来的空串。

**语义没变。** 归一化与钳制的结果与旧行为逐字相同；marker 只报告。契约套件里带反向对照：正常调用
**两个 marker 都不得出现**。

**改法。** 如果你断言 `readFile` 输出，要么忽略尾部 marker 行，要么就传整数。**不要**在给模型看之前把
marker 抹掉——它是「你看到的这段不是你要求的那个切片」的唯一信号。

## 6. `rg` / `grep`：搜索根不存在是错误，弃用提示按你的 mode 说话

**两处独立的文本变更，同一族：输出从前是「静默错的」。**

**6a. 搜索根不存在不再返回 `（无命中）`。** `searchText` / `rg` / `grep` 对 `path: "nope"` 从前答「没有命中」，
模型读成「这个仓库里没有」——一次**假阴性**，且没有错误信号（`metadata.searchFiles = 0` 只进 transcript、
不上 wire）。`searchRootError`（`src/tools/file-tools.js`）现在在**读边界判定之后**（越界路径不该知道它存不存在）
判一次调用方亲自给的根，返回错误**文本**——与 jail 越界、无效正则同一条通道，仍然不抛：

- 根不存在（或 `ENOTDIR`）：`错误：路径不存在：<path>（相对路径按工具根目录解析；先用 tree 确认要搜的目录是否存在）`
- 根读不到（其余 errno）：`错误：读不到 <path>（<code>）：先用 tree 确认这个路径可读`

三种情形严格分开：根存在但没有命中仍是 `（无命中）`；`path` 指向**文件**时仍只搜这个文件。

**6b. `rg` / `grep` 的弃用提示现在说的是本次调用的真实 mode。** 这行从前无条件写
`请改用 searchText with mode="regex"`——包括 `rg { is_regex: false }`，而它的语义是**字面量**。
`literal` 不解释元字符、`regex` 解释，`a.b` / `\d+` / `(x)` 两种模式的命中集不同；而 `searchText.mode`
必填且**无默认值**，这行提示就是模型唯一的迁移依据。`withDeprecation`（`src/tools/file-tools.js`）现在
由 `toolMarker`（`src/tools/file-tools.js`）按**本次**调用的取值生成：

- `rg` → 它别名映射真的用的那个 mode（`is_regex: false` 是 `literal`，否则 `regex`）；
- `grep` → 默认 `regex`（它就是 `grep -E`），`is_regex: false` 才是 `literal`（那是 `grep -F`）；
- `name_pattern` 只在本次真的传了 `glob` 时才点名。

**改法。** 如果你逐字比较工具输出文本，把这两行重新基线化：它们**刻意**变了，新的那两行才是真的。
如果你此前把 `（无命中）` 当「路径大概写错了」的信号用，现在会拿到一条真错误文本——按错误处理它。

## 7. 打包与门禁（不改运行时）

**7a. `package.json` 的 `files` 现在含 `test/helpers/tmp.js`。** 随包的契约套件
（`test/contract/file-tools.js` / `skills-loader.js`，经 `erix-agent/contract-tests` 再导出）现在 import
`../helpers/tmp.js`，缺了它宿主跑随包套件会得到 `ERR_MODULE_NOT_FOUND`。tarball 其余形状未变；
`README` / `README_cn` 的 `files` 围栏照 `package.json` 逐字同步。

**7b. `npm run check:types -- --with-tools` 的基线是 153** —— `BASELINE_WITH_TOOLS`（`scripts/type-check-ratchet.mjs`）；
包根入口是 117，并集是 `117 + 20 + 16` 个 / 31 文件。`src/tools/file-tools.js` 从 27 个降到 20 个——
tree/marker 那一刀的窄化、以及读侧诚实性那一刀（`editDiffTruncated` 并入那个联合类型）顺带消掉的；
**没有为了凑数压掉任何错**。

**7c. `node scripts/docs-drift-check.mjs --self-test` 与本机 `docs/tasks/` 解耦。** 它的树形用例改跑**合成
夹具**，不再数本机真实档案，于是同一提交在全新 clone / CI / `docs/tasks/` 为空的机器上都是绿的。因此 CI
把它转成**阻塞**步骤（此前的 `continue-on-error` 已摘掉）。

**7d. 测试卫生守卫转阻塞。** `npm run check:tests` 现在对 `test/**` 里除 `test/helpers/tmp.js` 之外的任何
`mkdtemp` / `mkdtempSync` 调用**失败**（共用助手是 `makeTmp`（`test/helpers/tmp.js`）），不再只打一行提示。存在**逐行**
豁免机制（调用行或紧邻上一行写 `test-hygiene-exempt: <理由>`，理由必填）；当前树上**零豁免**。这是仓库
卫生，永不在你的宿主里跑。

## 8. `finalGuard` 拿到的不再只是 transcript，而是这个 run 的事实（issue #386）

**现象。** guard 回调是引擎里唯一**有牙**的复核——它能把一个声称变成 `verified`，也能逼一次 `revise`
并在重试上限处把终局原因改写成 `final_guard_unverified`。可它的载荷一直只有 7 个键
（`finalText`、`findings`、`messages`、`round`、`rounds`、`signal`、`termination`）。验收决策要的那些
事实——写了哪些文件、哪些工具跑过几次失败几次、任务到底是什么、模型自报了什么、这个 run 花了多少、
这是第几次 guard 调用——一项都不在里面。于是宿主要么去重解析 `messages`（玩具 run 611 字节，真实 run
几十 KB 到 MB），要么直接拿 `finalText` 打分。

**新增了什么。** 10 个加法键，每个都只在引擎真读得到那份事实时才写（缺席 = 「没探到」，绝不用
`null`/`0`/`""` 冒充）：

| 键 | 给你什么 | 上限 |
|---|---|---|
| `cwd` | 宿主的 `cwd`，原样——新选项 `runToolLoop({ cwd })`，只透传 | 无 |
| `runId` | 宿主的 `runId`，原样 | 无 |
| `filesWritten` | `[{ path, round }]`——本 run 记录的写工具调用 | 最后 50 条（`filesWrittenTruncated`） |
| `toolStats` | `{ [工具名]: { calls, failures } }`，**plain object** | 前 40 个（`toolStatsTruncated`） |
| `taskBrief` | judge 与收尾看到的那份任务简报 | 2000 码点（`taskBriefTruncated`） |
| `selfReport` | 模型最后一次**归一化后**的 wrap-up：`{ done, summary, output, findings }` | `summary`/`output` 各 2000 |
| `usage` | run 累计 usage | 无 |
| `elapsedMs` | 从 loop 起算的墙钟毫秒 | 无 |
| `attempt` | 第几次 guard 调用，1 起，跨 `revise` 单调递增 | 无 |
| `guardBudget` | 本次生效的 `finalGuardMaxRetries` | 无 |

完整表格、截断标记与缺席语义在契约里：`### `finalGuard` 载荷：既有 7 键 + 10 个加法事实（issue #386）`
（`docs/host-consumer-contract_cn.md`）。

**怎么用它做机器判据的验收。** 三种以前做不到的形状：

1. **有文件才算数。** 只在交付物存在**且**内容对得上时才 accept——`fs.statSync(path.join(payload.cwd, 期望))`
   ——并用 `payload.filesWritten` 把「模型压根没试着写」与「写了但写错」区分开；`attempt` 再告诉你手上这份是
   第一次声称还是 `revise` 之后的第 N 次。
2. **声称对证据。** `payload.selfReport.findings` 与 `payload.findings` 是**同一个对象**：模型声明的每个
   `label -> value` 都能和你自己算出来的值逐条对账。信封什么都没声明时两边都没有该键——那是「模型跳过了声明
   步骤」，不等于「没有可核验的值」。
3. **成本与重试记账。** `payload.usage` + `payload.elapsedMs` + `payload.attempt` 让宿主不必给 provider 埋点
   就能记下每次 guard 往返的价钱（每次 `revise` 就是一次额外的模型往返），`payload.toolStats` 给出每个工具的
   失败比例，用来识别「这个 run 在原地打转」。

**这一版**没有**消除的三个坑，信任这些键之前先读一遍。**

- **`finalText` 仍然不是证据。** 只看 `finalText` 非空就 accept 的 guard，会为一个交付物根本不存在的 run 返回
  `verified`。探针把这个反例做成了场景（`S6`），旁边就是查磁盘的那个 guard：同一份撒谎脚本在 `attempt: 1`
  被抓住、`attempt: 2` 被补救。
- **`filesWritten[].path` 是摘要参数的 40 码点前缀，且不带截断标记。** 它来自 judge 的时间线
  （`summarizeArgument`（`src/reflection/judge.js`）），长路径会被静默截短。当提示用；权威路径是 `messages`
  里的 tool_result，或者你自己在 `cwd` 下 stat 的那个文件。
- **`cwd` 引擎从不解释。** 不 `chdir`、不校验存在性、不拼路径——它只是一条透传，让你的 guard 不必通过旁路
  才能知道工作目录。传非字符串会抛 `TypeError: cwd must be a string`。

**不用花一个 token 就能验证。** `node scripts/final-guard-probe.mjs`（也可 `npm run check:final-guard-probe`）
用脚本化的假 provider 驱动整个面：payload 键与逐键字节、假完成 → `revise` → 补救、重试耗尽、guard 抛错、
guard 超时、橡皮章陷阱，以及开销上限（30 轮 × 4KB 工具输出：`messages` 257,618 B vs 加法键 2,122 B =
**0.82%**，预算 < 2%）。每个场景都**断言**；语义一动，进程就以非零退出。

**要不要动手？** 不用。原有 7 键的名字、类型、顺序、取值不变；裁决语义（`accept` / `skip` / `revise` /
重试上限 / fail-closed）一字未动。如果你原本在重解析 `messages` 去捞上面那些事实，那段代码可以删了——
这正是本切片的意义。

## 9. 自检

```bash
npm test                       # 1,881 tests，0 失败（1,872 通过 + 9 skipped）
npm run check:docs && npm run check:docs:strict
npm run check:final-guard-probe # 离线、零模型调用；断言 finalGuard 的载荷面
npm run check:release          # 打包 → 装进一次性项目 → 跑随包契约套件
```

对你的宿主，升级前有五个问题值得用测试回答：

1. **状态文件。** 造一个削减账超过 32 条的 run：`compactionStatsWindow.total` 等于全量条数、
   `dropped === total − 32`，并且**旧**状态文件（没有窗口键）照旧 validate、照旧可续跑。
2. **失败出口。** 在工具调用点与 run 末尾各造一次快照写失败：两个错误都给出 `Error` 型 `cause`、字符串
   `errorCode`、`Array` 型 `unpersisted`，且两侧 `Object.keys` 一致。
3. **工具文本。** `tree { path: "some/nested/dir" }` → 首行就是那条相对路径且回放得到同一棵树；
   `readFile { offset: "3" }` → 出现 `[参数校正：…]`；短文件上 `readFile { offset: 999999 }` → `[已到末尾：…]`；
   `rg { pattern: "x", path: "nope" }` → 错误文本，不是 `（无命中）`。
4. **随包套件。** 把 tarball 装进一次性项目并跑 `erix-agent/contract-tests`——不许在 `../helpers/tmp.js`
   上失败。
5. **guard 载荷。** 给 `runToolLoop` 传 `cwd`，在你的 guard 里把整个 payload 记下来，并断言：强制一次
   `revise` 时 `attempt` 递增、`selfReport.findings === findings`、你的 accept 路径仍然会拒掉一个交付物
   缺失的 run（§8 的 `S6` 反例）。

## 10. 没变的

没有 store 方法签名、没有返回类型、没有选项名、没有导出、没有记录种类、没有消息字段、没有终止原因、
没有错误码搬家，运行时依赖仍是零。`store.load()` 的形状与 0.23.0 一致。`deterministic.compactionStats`
仍是最后 32 条。judge 决策面与续跑路径一字未动；final guard 的**裁决**语义也一字未动——它的载荷多了几个加法键（§8），
那是信息，不是新规则。整个发布里唯一**行为**变化是「搜索根不存在
返回错误文本而不是 `（无命中）`」——而那是修一次假阴性，不是新规则。

## 11. 迁移配方

1. 如果你读 `<runId>.state.json` 的削减账，改读 `compactionStatsWindow.total`（与 `dropped`），别再数数组；
   把键的缺席理解成「没有统计」，而不是「零」。
2. 把 `persistence_failed` / `checkpoint_failed` 上的 `message` 字符串解析换成 `errorCode`；`cause`（是
   `Error`）与 `unpersisted`（是数组）直接用。删掉任何 `typeof cause === "string"` 分支。
3. `tree` 的首行原样喂回 `path`（或者忽略它），别再当裸目录名。
4. 重新基线化你断言的工具输出文本：`readFile` 的两个 marker、`rg`/`grep` 的弃用提示行、根不存在的错误文本。
   能断言 marker 的**存在**就别断言它的逐字内容。
5. 拿新文本重跑你自己那条「模型当时看见了什么」的测试——它们每一处现在说的都是真实情况，这正是本次发布
   的全部意义。
6. 删掉你 `finalGuard` 里为了捞「写了哪些文件 / 工具计数 / 任务简报 / 模型自报 / usage / 耗时」而做的
   `messages` 重解析：改读 `filesWritten`、`toolStats`、`taskBrief`、`selfReport`、`usage`、`elapsedMs`（§8）。
   `messages` 只留给你读工具结果的**内容**。
