# 扁平选项写点清点表（#498 S7 的退役前置清单）

> 用途：**#498 S9 一次性退役 11 个顶层扁平回调键**那一刀，要靠这张表决定「改哪些文件、哪些文件
> 一个字都不许动」。所以下面每一行都是**文件级、可核对**的条目，不是散文。
>
> 本文件随 `test/` 落盘、**不进 npm 包**（`package.json` 的 `files` 没有它）。
>
> ⚠ **附表口径刷新（#498 S3 第十二片 `run` 组 A12 + A12b：退役 `partialPersistence`，本片）**：
> 附表 **1342 → 1343**（净 +1，行数 115 → 116）、主表 **170 → 170**（不变，行数 23 → 23）。净 +1 是两笔的差：
>   · **−2**：`test/loop-resume.test.js` 71 → **69**。本片把顶层扁平 `partialPersistence` 退役（规范之家
>     `config.run.partialPersistence`），那两个扁平写点搬进容器 ⇒ `config` 数到就停，两个点**离开**计数口径；
>   · **+3**：本片新增的切片钉子文件 `test/loop-run-slice-498s3a12.test.js`（`completion`×1 /
>     `stallDetection`×1 / `wrapup`×1 —— 都是搭台写点；它的能力面写点是 **0**，所以主表不受影响）。
> 其余 114 行一个数字都没动：本片删的是一个顶层拼写，不是一整组键。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1343 都是 AST 实测）。
>
> ⚠ **#529（同一片落账）：量尺进仓库了。** 上面那张表以前只能靠「把 heredoc 粘到 `/tmp/flat-count.cjs`」
> 复现，复跑命令因此全写成 `node /tmp/flat-count.cjs …` —— **复现路径在仓库外面**，干净检出上跑不通，
> 于是表一漂移就没人刷得动（第十一片与 A12 都是这么卡住的）。现在生成器是仓库内的
> **`scripts/flat-count-inventory.mjs`**（口径五条原样搬过去，另加 `--sync` 机器刷表模式），
> 本节所有复跑命令已改指仓库内路径，**`/tmp/` 不再是复现基准**。本片的表是 `--sync` 机器刷出来的
> （数字与明细列都由 AST 重写、漏行按实测补），**没有一个数字是手改的**。
>
> ⚠ **附表口径刷新（#498 S3 第十一片 `run` 组 A11：小四件删键，本片）**：附表 **1324 → 1342**
> （净 +18，行数 114 → 115）、主表 **170 → 170**（不变，行数 23 → 23）。这 18 点**全部来自本片新增的
> 切片钉子文件** `test/loop-run-slice-498s3a11.test.js`（`completion`×7 / `wrapup`×7 / `reflection`×2 /
> `context`×1 / `tools`×1 —— 都是搭台写点；它的能力面写点是 **0**，所以主表不受影响）。
> 本片删的四个顶层扁平键 `invalidArguments` / `replayPolicy` / `writeToolNames` / `writeToolPathKeys`
> **本来就不在计数口径里**（顶部「生成方式」写明：`writeToolNames` / `writeToolPathKeys` 是字符串数组、
> 元素不是子键；`invalidArguments` / `replayPolicy` 是标量）⇒ 删键**不改变任何既有行**的归属判断。
> 实测逐文件零变化：`test/judge.test.js` 122、`test/loop-resume.test.js` 71、
> `test/loop-config-namespace-497.test.js` 61、`test/loop-option-normalization.test.js` 23、
> `test/loop-invalid-arguments.test.js` 7 —— 五个被本片改过写侧的文件，计数**一个都没变**
> （写点从扁平搬进 `config.run.*`，而 `config` 是容器、数到就停）。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1342 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#531 `session` 立为第三站：拆掉 `config.metadata.session` 叶子，本片）**：
> 附表 **1324 → 1324**（净 ±0，行数 114 → 114）、主表 **170 → 170**（不变，行数 23 → 23）。
> 净 ±0 是两笔的差，方向相反、恰好抵消：
>   · **+1**：`test/loop-config-namespace-497.test.js` 44 → **45**（`session`×3 → ×4）。`config.metadata.session`
>     那个规位写点（`config` 是容器，规则 4 数到就停 ⇒ 本来就不在计数口径里）改成**扁平** `session` 写点
>     ——A4 ④ 的两处行为证据（`session: {}` 与 `session: { id, modelSlot }`）现在是顶层写点，另外
>     B2 的 `VALUES` 里删掉一条 `session`（它没有嵌套家了），三处相抵净 +1；
>   · **−1**：`test/loop-capabilities-namespace-498.test.js` 23 → **22**（`session`×2 → ×1）。它的
>     `REPRESENTATIVE_CONFIG_VALUES` 是**按叶子名索引**的 round-trip 覆盖表，`session` 不再是配置叶子
>     ⇒ 那一行必须删（留着会红：覆盖表键集必须与 schema 叶子集逐字相等），于是少一个 `session` 写点。
> 本片删的 `config.metadata.session` 是**容器内**写点，本来就不进表；`session` 的顶层扁平写点一个都没
> 退役（它是第三站成员，不是退役键），所以其余 112 个写点与那 22 个文件一行未动。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1324 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#498 S3 第十片 `metadata` A9：`user` / `model` / `task` 三键删键，本片）**：
> 附表 **1304 → 1324**（净 +20，行数 113 → 114）、主表 **170 → 170**（不变，行数 23 → 23）。
> 净 +20 是三笔的差：
>   · **+19**：本片新增的切片钉子文件 `test/loop-metadata-keys-slice-498s3a9.test.js`
>     （`completion`×4 / `session`×4 / `wrapup`×4 / `context`×3 / `reflection`×2 / `tools`×2 —— 都是搭台写点；
>     它的能力面写点是 **0**，所以主表不受影响）；
>   · **+1**：A8 那个钉子文件 `test/loop-metadata-keys-slice-498s3a8.test.js` 从 15 → **16**。原因是 F1 的
>     函数差异 as-is 钉从 `user` 搬到 `session`（`user` 退役后扁平写法不再收函数），而 `session` 是附表
>     数据面键表里的成员、`user` 明确被排除在计数口径之外 ⇒ 同一格钉子换名字，计数 +1；
>   · **±0**：本片删的三个顶层键 `user` / `model` / `task` **本来就不在计数口径里**（顶部「生成方式」写明：
>     它们是**不透明载荷**，引擎不按名字读子键 ⇒ 归 NOT-OPTION-SURFACE），所以删键**不改变任何既有行**的
>     归属判断。`session` 经同值判定**退回**，它那 112 个写点与那 22 个文件一行未动。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1324 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#498 S3 第九片 `metadata` A8：四个小键删键，本片）**：附表 **1299 → 1304**（净 +5，
> 行数 112 → 113）、主表 **170 → 170**（不变，行数 23 → 23）。净 +5 是两笔的差：
>   · **−10**：本片把四个扁平写点搬进规位 `config.metadata.*`，`config` 是容器（规则 4 数到就停）⇒
>     `output-hygiene` −4、`model-metadata-diagnostics` −3、`loop-config-namespace-497` −2、
>     `compaction-strategy-fallback` −1；
>   · **+15**：本片新增的切片钉子文件 `test/loop-metadata-keys-slice-498s3a8.test.js`（`tools`×6 /
>     `modelMetadata`×3 / `completion`×2 / `wrapup`×2 / `context`×1 / `session`×1 —— 都是搭台写点；
>     它的能力面写点是 **0**，所以主表不受影响）。
> 本片删的四个顶层键里，`requestId` / `expert` 是标量（本来就不在计数口径里），`modelMetadata` /
> `toolContext` 是壳但**叶子仍在 schema 里**（退役的是顶层拼写）——所以删键**不改变任何既有行**的
> 归属判断，只改变「写点写在哪」的那 10 点。复跑：
> `node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1304 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#527 `tools` 拆叶子）**：附表 **1299 → 1299**（不变，行数 112 → 112）、
> 主表 **170 → 170**（不变，行数 23 → 23）。原因是 #527 只把 `tools` 的**规位写点**（`config.input.tools`）
> 改回扁平 `tools`：`config` 是容器，按规则 4 数到就停，所以那些写点本来就不在计数口径里；改回扁平后
> 两处 `tools` 写点重新进表（`loop-config-namespace-497` +1、`loop-capabilities-namespace-498` −1，
> 两文件此消彼长，总数不变）。复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md`
> **exit=0**，逐行零误差。
>
> 生成方式（可复跑，不许凭感觉）：AST 走 `test/**`（排除 `test/contract/**`，那是 #498 S8 独占），
> 数**属性写法**的命中次数（`PropertyAssignment` / `ShorthandPropertyAssignment` 的名字），规则五条：
>
> 1. 只数属性名（注释、字符串、白名单数组里的字样都不算）；
> 2. **数到被数的键就停**，不再往它的值里走（`retry: { sleepImpl }` 只算 `retry` 一个）；
> 3. `capabilities` / `config` 容器同样数到就停（容器里的同名叶子是**规位写法**，不是扁平写点）；
> 4. **进 `context` 同名壳也停**（`context: { onFoldSummary }` 与 `context: foldContext({ onFoldSummary })`
>    都只算 `context` 一个——壳内写点不是扁平写点）；
> 5. 不数「同名变量落进记录对象」的简写（`onObserverError: (error, context) => seen.push({ error, context })`
>    里的 `context` 不算）——这条是规则 2 的推论。**简写本身照数**（`return { rounds, onRound }` 里的
>    `onRound` 算一个，`test/loop-usage-accounting.test.js` 的 8 个就是这么来的）；只有落在**已被数过的键
>    的值**里的不再下钻。
>
> 按这五条：**迁移前 388 / S7a 后 351 / S7b 后 256 / S7c 后 170 / 附表 1299 / COMPAT-PIN 67**。复跑命令在
> ⚠ **附表口径刷新（#498 S3 第八片 `input` 组 A6 段收尾，本片）**：附表 **1283 → 1299**（+16，行数 111 → 112）、
> 主表 **170 → 170**（不变，行数 23 → 23）。这 16 点**全部来自本片新增的切片钉子文件**
> `test/loop-input-keys-slice-498s3a6.test.js`（`wrapup`×7 / `completion`×4 / `tools`×4 / `context`×1 ——
> 都是搭台写点，含闸口二那四格 `tools` 形状对照）。本片删的顶层扁平键 `system` 是**标量**
> （无子键 ⇒ 按顶部「生成方式」不是壳），它本来就不在计数口径里（顶部「明确排除」一节已写明
> `system` 归 NOT-OPTION-SURFACE：它的值是不透明载荷，且还出现在 provider 请求体里），所以删键
> **不改变任何既有行**；只增了新文件那一行。`wrapup` / `tools` 本片**退回不删**，它们的行一个字未动。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1299 都是 AST 实测）。
> ⚠ **附表口径刷新（#498 S3 第七片 `tuning` A5 段收尾）**：附表 **1276 → 1283**（+7，行数 110 → 111）、
> 主表 **170 → 170**（不变，行数 23 → 23）。这 7 点**全部来自本片新增的切片钉子文件**
> `test/loop-tuning-keys-slice-498s3a5.test.js`（`completion`×2 / `wrapup`×2 / `context`×1 / `session`×1 /
> `tools`×1 —— 都是搭台写点）。本片删的三个顶层扁平键（`maxTokens` / `temperature` / `topP`）**都是标量**
> （无子键 ⇒ 按顶部「生成方式」不是壳），它们本来就不在计数口径里，所以删键**不改变任何既有行**；
> 只增了新文件那一行。复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md`
> **exit=0**，逐行零误差（主表 170 / 附表 1283 都是 AST 实测）。
> ⚠ **附表口径刷新（#498 S3 第六片 `guard` 段收尾）**：附表 **1270 → 1276**（+6，行数 109 → 110）、
> 主表 **169 → 170**（+1，行数 22 → 23）。这 7 点**全部来自本片新增的切片钉子文件**
> `test/loop-guard-slice-498s3e.test.js`（附表 6：`completion`×2 / `wrapup`×2 / `context`×1 / `reflection`×1；
> 主表 1：`finalGuard`×1 —— 都是搭台写点）。本片删的三个顶层扁平键
> （`finalGuardMaxRetries` / `finalGuardTimeoutMs` / `finalGuardExtend`）**都是标量**（无子键 ⇒ 按顶部
> 「生成方式」不是壳），它们本来就不在计数口径里，所以删键**不改变任何既有行**；只增了新文件那两行。
> 复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 170 / 附表 1276 都是 AST 实测）。
> ⚠ **附表口径刷新（#498 S3 第五片 `tuning` 段收尾，本片）**：附表从 **1263 → 1270**（+7，行数 108 → 109）。
> 这 7 点**全部来自本片新增的切片钉子文件** `test/loop-tuning-slice-498s3d.test.js`（`completion`×3 /
> `wrapup`×2 / `context`×1 / `stallDetection`×1 —— 都是搭台写点）。本片删的顶层扁平键
> `cacheCapable` 是**布尔标量**（无子键 ⇒ 按顶部「生成方式」不是壳），它本来就不在计数口径里，
> 所以删键**不改变任何既有行**；只增了新文件那一行。复跑：
> `node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 169 / 附表 1270 都是 AST 实测）。
> ⚠ **附表口径刷新（#498 S3 第四片 `input` A2b 段收尾，本片）**：附表从 **1259 → 1263**（+4，行数 107 → 108）。
> 这 4 点**不是本片新写出来的**：`test/loop-seed-fixture-521.test.js`（#521 的夹具钉子文件）在 A2 那一刀里
> 就带了 `completion`×2 / `wrapup`×2 四个数据面写点，只是那一刀没给它加行，`--verify` 只核**已登记**的行，
> 所以「逐行零误差」当时是绿的、总数却是低的。本片补上这一行并重新对账。
> 本片（A2b）**删掉了 `initialUserMessage` 的扁平写法**，而它本来就不在计数口径里（顶部「生成方式」写明：
> 标量键没有子键 ⇒ 不是壳），所以删键**不改变任何计数**；本片新增的 `config: { input: { … } }` 写点同样不计
> （`config` 是容器，规则 4 数到就停）。复跑：`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md`
> **exit=0**，逐行零误差（主表 169 / 附表 1263 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#498 S3 第三片 `input` A 段收尾）**：附表从 **1269 → 1259**（−10，文件数 106 → 107）。
> 同样是**实测**：本片把顶层扁平 `cacheStablePrefix` / `initialMessages` 摘掉（`initialMessages` 是附表
> 数据面键表里的一员，它的 12 个扁平写点随写侧迁移一起消失，其中 10 个落在 10 个既有文件里），
> 新增的切片钉子文件 `test/loop-input-slice-498s3c.test.js` 自己带 12 个搭台写点。
> `node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，逐行零误差
> （主表 169 / 附表 1263 都是 AST 实测）。
>
> ⚠ **附表口径刷新（#498 S3 第二片 `folding` 收尾）**：附表从 **1354 → 1269**（−85，文件数 104 → 106）。
> 这是**实测**，不是手改：S3 的 `timing` / `folding` 两片把 `retry` / `context` / `toolResultTtl` /
> `toolResultFoldMinTokens` 的扁平写法从树上摘掉了（写点随写侧迁移一起消失），另外新增两个切片钉子文件
> 各带 7 个搭台写点。`node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md` **exit=0**，
> 逐行零误差（主表 169 / 附表 1269 都是 AST 实测）。
>
> 按这五条（历史口径）：**迁移前 388 / S7a 后 351 / S7b 后 256 / S7c 后 169 / 附表 1354 / COMPAT-PIN 66**。复跑命令在
> 文末「复跑方法」，跑出来逐字就是这几个数；**漏掉规则 2/4 会得 390 / 353**（多出来的 2 个写点都藏在
> 「被数的键的值」里，例如 `test/loop-context-on-fold-summary-retired-499.test.js` 的
> `context: foldContext({ onFoldSummary })`）。
>
> ⚠ 附表从 **678 → 680 → 1354**：
> · 678 → 680 是 #498 S7b 补的那格 `onReflection` 断言（`test/cli.test.js`）自带两个数据面写点
>   （`prompt`×1 / `reflection`×1）——不是「又冒出脏点」，是新增测试的搭台选项。
> · 680 → **1354** 是 #498 S7c 的**计数器扩键**（见下节「数据面键表：从白名单枚举」）：原键表只有 10 个键，
>   漏掉了 `completion` / `session` / `wrapup` / `stallDetection` / `outputHygiene` / `modelMetadata` /
>   `partialPersistence` 这 7 个**同样是壳**的顶层键 ⇒ 「680」是低估。`--verify` 已逐行对账。
>
> 计数口径：`onEvent` / `onRound` / `onJudge` / `onToolResult` / `onDelta` / `onReasoningDelta` /
> `onToolCall` / `onUsage` / `onObserverError` / `onPersistenceError` / `onFoldSummary` 这 **11 个是
> S9 的退役面**；`finalGuard` / `deliverables` 同属能力面，**且已有规位**（`capabilities.hooks.finalGuard` /
> `capabilities.checks.deliverables`，见 `docs/host-consumer-contract.md`）⇒ 按母单裁决属 **S9 的移除项**：
> 本表把它们计入 `MIGRATE`，**必须继续迁**，不是「可选清理」。附表那 **1354** 个数据面壳内写点也**不是可选
> 清理**：母单 #495 的裁决更正（见下节「裁决更正」）把「删顶层扁平配置键」的 S3 判据定成「顶层 **67** → 33」，
> 而那 1354 个写点住的 `context` / `reflection` / `retry` / `wrapup` / `completion` / `session` **正是 S3 要删的壳**
> ⇒ 它们是 **S3 的硬前置**。
>
> 五类（机器可判，判据见下）。**三类是外部所有权**（S5 / S6 / S8），S7 一律不碰；
> 只有 `MIGRATE` 是 S7 自己的活：
> * **COMPAT-PIN** —— 那格测试的**被测对象就是选项面本身**。不许迁：它们是「扁平写法仍然可用」的
>   兼容钉，S9 退役那天才由那一刀统一改。
> * **OWNED-BY-S5** —— 文件里的**选项装配断言区**由 #498 S5 提前迁移（见下节），本轮任何人别碰。
> * **OWNED-BY-S6** —— `test/examples/*` 里断言 `buildLoopOptions` **装配形状**的那 5 个文件归
>   #498 S6（见下节），本轮任何人别碰。
> * **SKIP-S8** —— `test/contract/**`（#498 S8 独占，S7 一个字不碰；本表不列）。
> * **MIGRATE** —— 断言测的是别的机制（折叠 / 持久化 / 预算 / 续跑 / 工具环 / 压缩策略 / 观察者通道…），
>   扁平键只是**搭台**。按 S7a / S7b / S7c 三片分派。

## 裁决更正（母单 #495，S7b 落账 / S7c 校准）：数据面 **1354**（今 **1269**）是 **S3 的硬前置**，不是可选清理

早先本表在附表与顶部两处写「迁数据面是可选的整洁 / 不在 0.28 路径上 / S9 不需要等它」。**那句作废。**

* **S3（删顶层扁平配置键）在做，并入 0.28 破坏包**；判据已更正为「顶层 **顶层 67 → **24**（S3 之后）→ **13**（S9 之后）——**机器口径，不传 prose 数字**：S3 之前实测 `RUN_TOOL_LOOP_OPTION_NAMES.length === 67`（**S3 的 `timing` + `folding` 两片之后是 61** = 67 − 3 − 3，现场 `node -e` 直读，别抄）= 配置面有规位 **43** + 能力面有规位 **13** + 无规位 **11**（`assemblyPort` / `provider` / `executeTool` / `todoStateProvider` / `semanticStateProvider` / `modelConfig` / `store` / `diagnostics` / `signal` / `config` / `capabilities`）；S3 只删「配置面有规位」那 43 个 ⇒ 67 − 43 = **24**；S9 再退 11 个扁平 `on*` 回调 ⇒ **13**。⚠ 母单 #495 里那句「65 → 33」是**当时的分类算术**（提交人自己在 2026-10-27 的更正里就是这么定性那句「45 是我的分类算术，仓库里没有可复现依据」），今天按上式重算，**不要再往工单里抄 33****」。
  ⚠ **口径修正（#498 S7c）**：本表早先两处写「顶层 65」，那是**没实测**的旧数。实测
  `RUN_TOOL_LOOP_OPTION_NAMES.length === 67`（`node -e` 直读，见「复跑方法」第 6 条）；65 是 #517 之前的快照。
  **S3 两片之后是 61**（`timing` 三键 + `folding` 三键离开白名单），同样现场派生、不抄数。
* 今天实测：`RUN_TOOL_LOOP_OPTION_NAMES` **67** 个顶层键，其中 **56 个已有规位**
  （`config.*` / `capabilities.*`），剩 11 个是纯装配/身份键（`provider` / `executeTool` / `store` /
  `signal` / `assemblyPort` / `modelConfig` / `todoStateProvider` / `semanticStateProvider` /
  `diagnostics` / `config` / `capabilities` 这些容器/端口本身不删）。
* 附表那 1354 个写点住的 `context` / `reflection` / `retry` / `resume` / `tools` / `strategy` /
  `completion` / `session` / `wrapup` 等**壳**，正是 S3 要删的东西 ⇒ 壳删了、写点还按壳写 = 1354 处当场红。
  **它们是 S3 的硬前置。**
* 反过来说：`capabilities.hooks.*` / `capabilities.checks.deliverables` / `capabilities.ports.*`
  这一侧的写点（本表主表）与 S3 **无关**，它们是 S9（退役 11 个扁平回调键）的前置。

## 判据：什么样的文件算 COMPAT-PIN

文件里存在**至少一格**，它的断言直接读选项面本身，即出现下列任一「机器可判」的记号：

* `config_override_conflict`（容器与扁平键冲突的事件名）；
* 命名空间报错文案：`unknown capabilities` / `is not accepted` / `must be a function`；
* 名单本身：`RUN_TOOL_LOOP_OPTION_NAMES` / `CAPABILITY_*` / `CONFIG_*`（导出名）；
* 白名单计数（`RUN_TOOL_LOOP_OPTION_NAMES.length` 之类的字面值对账）；
* 选项闸文案：`unknown runToolLoop option`（接受面 = 白名单的那句报错）。

⚠ 三个「记号命中但整文件不是 COMPAT-PIN」的坑（本表按**格**判，不按记号判）：

* `test/loop.test.js` 命中 `unknown runToolLoop option`，但那是**一格**（「rejects unknown runToolLoop
  options with a close suggestion」）；文件其余部分测的是别的机制 ⇒ 分类为 `MIGRATE · 含 COMPAT-PIN 格`，
  迁搭台写点时**别动那一格**。
* `test/loop-on-fold-summary.test.js` 命中 `must be a function`（`assembly policy option onFoldSummary
  must be a function (or omitted)`），那是 #499 的形状报错钉 ⇒ 同样只留那一格。
* `test/loop-deliverables.test.js` 命中 `deliverables[0].check must be a function`，那是**值形状**钉
  （S9 之后它仍在扁平侧），也只留那一格。

## COMPAT-PIN（不许迁，登记备查）

| 文件 | 扁平写点 | 它钉的是哪一面 |
| --- | --- | --- |
| `test/loop-option-normalization.test.js` | 0（容器/白名单面） | `RUN_TOOL_LOOP_OPTION_NAMES` 的**顺序与 67 条**、未知键建议、预检相位（`Proxy` 钉「端口未被触碰」）、容器展开顺序 |
| `test/loop-config-namespace-497.test.js` | 16 | `config` 名称/形状预检、`config_override_conflict`、函数值拒绝（`is not accepted`）、三向闭合自检 |
| `test/loop-capabilities-namespace-498.test.js` | 20 | `capabilities` 名称/形状预检、`hooks` 叶子必须是函数（`must be a function`）、`config_override_conflict`（`path: "hooks.<leaf>"`）、容器赢扁平的优先级 |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 7 | `ports.*` / 4 个 in-shell 回调 / 两个形态多态旋钮的**目的地表**与冲突路径、`sleepImpl` 被真的调到（行为证据） |
| `test/loop-option-gate-496.test.js` | 15 | 选项闸：接受面 = 白名单（`unknown runToolLoop option`）、语义相取值校验、`onFoldSummary` / `finalGuard` / `deliverables` 的形状报错 |
| `test/loop-guard-slice-498s3e.test.js` | 1 | #498 S3 `guard` 片的**选项面钉**：三个数据键的旧名反向拒绝（逐字文案 + 新家路径）、混装壳只点一站、**`finalGuard` / `finalGuardVerdict` 没被本刀动过**（P5）、三向闭合与 schema 自检、禁手抄键数（A2 扫全 `test/`） |
| `test/loop-tuning-keys-slice-498s3a5.test.js` | 0（容器/白名单面） | #498 S3 `tuning` A5 片的**选项面钉**：三个采样/预算键的旧名反向拒绝（逐字文案 + 新家路径）、混装壳只点一站、**`maxTokenContinuations` 与槽位面同名字段没被本刀动过**（P5，另加装配口 `policy.maxTokens` 与 provider 请求字段两个旁证面）、三向闭合与 schema 自检、禁手抄键数（A2 扫全 `test/`）。**能力面 0 写点**（它不碰任何 `on*` 回调），所以本表这一行是 `0` 而不是数字 |
| `test/loop-input-keys-slice-498s3a6.test.js` | 0（容器/白名单面） | #498 S3 `input` 组 A6 片的**选项面钉**：`system` 的旧名反向拒绝（逐字文案 + 新家路径 + 数据键里的函数值只点一站）、**`tools` 的闸口二 as-is 钉（G1–G4：函数成员扁平可达 / 规位不可达，两个协议投影都不带它）**、**#527 的闭门钉（G2/G5：`config.input.tools` 作为未知叶子当场拒，文案指向顶层第三站）**、`wrapup` 退回清单的机器派生（S 段）、四向闭合与 schema 自检、禁手抄键数（A2 扫全 `test/`）。**能力面 0 写点**（它不碰任何 `on*` 回调），所以本表这一行是 `0` 而不是数字 |
| `test/loop-run-slice-498s3a11.test.js` | 0（容器/白名单面） | #498 S3 `run` 组 A11 片的**选项面钉**：小四件的旧名反向拒绝（逐字文案 + 新家路径）、**闸口二八格矩阵（合法形状扁平/规位两侧 exit 0，数组夹函数那一格 as-is）**、数据键里的函数值只点一站、**读侧不动**（引数裁决 / resume 重放 / judge 的写工具集与路径键优先级）、`session` #531 裁决与 `maxTokenContinuations` 撞名归属、四向闭合与 schema 自检、禁手抄键数（A3 扫全 `test/`）。**能力面 0 写点**（它不碰任何 `on*` 回调），所以本表这一行是 `0` 而不是数字 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 8 | #499 的**范围钉**：`context.onFoldSummary` 退役、**顶层扁平 `onFoldSummary` 必须还在**（它 `import` 了 `RUN_TOOL_LOOP_OPTION_NAMES` 并断言 `includes("onFoldSummary")`）⇒ S9 之前这里必须保持扁平 |


### COMPAT-PIN 逐文件判定（#498 S3 第九片 `metadata` A8：四个小键删键）

判据同上：**数据面就地翻成反向拒绝钉；行为面 `on*` 一个字不动**。本片删的是
`modelMetadata` / `requestId` / `toolContext` / `expert`（四个都是数据面），所以动到的只有**数据面**
那几格。九个 COMPAT-PIN 文件逐个给证据：

| 文件 | 面 | 本片（`metadata` A8）的处置 | 证据 |
| --- | --- | --- | --- |
| `test/loop-option-normalization.test.js` | **数据面** | 翻成反向钉 | 内联白名单副本（`OPTION_WHITELIST`）删掉四项（A0 的双向差集 + 位置对账保证副本 ≡ 源名单）；建议矩阵**不用换键**——实测 `optionSuggestion("modelMetadata")` = `undefined`（距离 8 > 阈值 5），所以没有「被建议成 `model`」的噪声，矩阵里本来也没有以 `modelMetadata` 为答案的行（这一点与本片工单的担心相反，见新钉子文件 **S1/S2**）。反向钉本体在 `test/loop-metadata-keys-slice-498s3a8.test.js` 的 **P / P2 / P3** |
| `test/loop-config-namespace-497.test.js` | **数据面** | 翻成反向钉 | `RETIRED_FLAT_VALUES` 增四条（`expert` / `requestId` / `toolContext` / `modelMetadata`）；`VALUES`（仍可扁平写的那张）同步删掉它们。B2 开头断言两张表键集**逐字相等**（派生自 `CONFIG_SURFACE_OPTION_NAMES ∖ RUN_TOOL_LOOP_OPTION_NAMES`）⇒ 删键而漏给取值会红；于是 B2 同时证明：扁平形态**不再产生**这四个 `effectiveOptions.*`、config 形态**逐字写回**它们。⚠ 这段判断逻辑**一行未改**（A2b 那刀就把它派生了），本片只补了四条取值。另：`A5`（runId / cwd）那格的两处扁平 `modelMetadata` 写点并进**同一个** `config` 容器（不造第二个 `config` 键） |
| `test/loop-capabilities-namespace-498.test.js` | **行为面 `on*` + 数据面（叶子名索引）** | **未动**（本片零改动） | `git diff --stat` 里没有它。它那张 `REPRESENTATIVE_CONFIG_VALUES` 按**叶子名**索引（`metadata: expert / requestId / toolContext / modelMetadata …` 那几行照旧）——叶子仍在 schema 里，删了反而漏测 round-trip |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-option-gate-496.test.js` | 数据面（闸口相位） | **未动**（本片零改动） | `git diff --stat` 里没有它；它写的 `context.toolContext` 是**壳内**写法（规则 5 数到 `context` 就停），且 `context.toolContext` 的读侧本片一字未动（新钉子文件 P5-b 用真 run 钉住） |
| `test/loop-context-on-fold-summary-retired-499.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-guard-slice-498s3e.test.js` | 数据面（`guard` 片的钉子） | **未动**（本片零改动） | `git diff --stat` 里没有它。它钉的是 `guard` 组三键，与 `metadata` 组无关 |
| `test/loop-input-keys-slice-498s3a6.test.js` | 数据面（`input` A6 的钉子） | 一处**逐字文案**跟进 | 本片把「数据键里的函数值」那条文案补了一句「the engine never calls it, it only forwards the value」（工单硬义务：别让宿主以为丢了能力）。A6 的 **P4** 是**逐字相等**断言，所以跟着改；**主张一字未变**，只是把「没丢能力」说出来。行为面无改动 |
| `test/loop-metadata-keys-slice-498s3a8.test.js` | **选项面本身** | **本片新增** | 它测的就是「扁平写法现在抛错」这件事，所以按判据登记为 COMPAT-PIN（同 `loop-option-normalization.test.js` 那一行）。能力面写点 **0** ⇒ 主表不受影响（附表 +15） |

合计仍是 **67** 个写点（本片新增的钉子文件在**能力面**上 0 个写点：它不写任何 `on*` 回调）。

### COMPAT-PIN 逐文件判定（#498 S3 第八片 `input` A6：`system` 删键）

判据同上：**数据面就地翻成反向拒绝钉；行为面 `on*` 一个字不动**。本片只删了 `system`（标量、数据面），
`wrapup` / `tools` **退回不删**，所以它们的行与写点一字未动。九个 COMPAT-PIN 文件逐个给证据：

| 文件 | 面 | 本片（`input` A6）的处置 | 证据 |
| --- | --- | --- | --- |
| `test/loop-option-normalization.test.js` | **数据面** | 翻成反向钉 | 内联白名单副本（`OPTION_WHITELIST`）删掉 `system` 一项（A0 的双向差集 + 位置对账保证副本 ≡ 源名单）；建议矩阵的**平局行**换键：`strtem` → {system, stream} 里的 `system` 已不在候选池，改钉 `modls` → {tools, model}（同为长度 5 / 阈值 2 / 距离 2 的分支，白名单顺序仍压过字典序）；「默认值 cacheStablePrefix = true 与 wrapup = true」那格的两处 `system: "SYS"` 写点搬到 `config.input.system`，**断言一字未改**。反向钉本体在 `test/loop-input-keys-slice-498s3a6.test.js` 的 **P / P2 / P3**（逐字文案 + 叶子仍在 schema + 顶层键已不在白名单） |
| `test/loop-config-namespace-497.test.js` | **数据面** | 翻成反向钉 | `RETIRED_FLAT_VALUES` 增一条（`system: "you are a test"`）；`VALUES`（仍可扁平写的那张）同步删掉它。B2 开头断言两张表键集**逐字相等**（派生自 `CONFIG_SURFACE_OPTION_NAMES ∖ RUN_TOOL_LOOP_OPTION_NAMES`）⇒ 删键而漏给取值会红；于是 B2 同时证明：扁平形态**不再产生** `effectiveOptions.system`、config 形态**逐字写回**它。⚠ 这一段判断逻辑**一行未改**（A2b 那刀就把它派生了），本片只补了一条取值 |
| `test/loop-input-slice-498s3c.test.js` | 数据面（`input` A 段的钉子） | 两处写点改拼写，断言未动 | `R1` 的两格 `system: "SYS"` 搬到 `config.input.system`（其中一格与既有的 `config.input.cacheStablePrefix` 并进**同一个** `config.input`，不造第二个 `config` 键）。它钉的是 `cacheStablePrefix`，与 `system` 退役无关，所以判据一字未改 |
| `test/loop-capabilities-namespace-498.test.js` | **行为面 `on*` + 数据面（叶子名索引）** | **未动**（本片零改动） | `git diff --stat` 里没有它。它那张 `REPRESENTATIVE_CONFIG_VALUES` 按**叶子名**索引（`input: system / …` 那几行照旧）——叶子仍在 schema 里，删了反而漏测 round-trip |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-option-gate-496.test.js` | 数据面（闸口相位） | **未动**（本片零改动） | `git diff --stat` 里没有它；它的闸口断言测的是「接受面 = 白名单」这条机制，与具体哪个键退役无关 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-guard-slice-498s3e.test.js` | 数据面（`guard` 片的钉子） | **未动**（本片零改动） | `git diff --stat` 里没有它。它钉的是 `guard` 组三键，与 `input` 组无关 |
| `test/loop-input-keys-slice-498s3a6.test.js` | **选项面本身** | **本片新增** | 它测的就是「扁平写法现在抛错」这件事，所以按判据登记为 COMPAT-PIN（同 `loop-option-normalization.test.js` 那一行）。能力面写点 **0** ⇒ 主表不受影响 |

合计仍是 **67** 个写点（本片新增的钉子文件在**能力面**上 0 个写点：它不写任何 `on*` 回调）。

### COMPAT-PIN 逐文件判定（#498 S3 第七片 `tuning` A5：三个采样/预算键删键）

判据同上：**数据面就地翻成反向拒绝钉；行为面 `on*` 一个字不动**。本片动到的只有**数据面**那两格；
八个 COMPAT-PIN 文件逐个给证据（不是「我看过了」）：

| 文件 | 面 | 本片（`tuning` A5）的处置 | 证据 |
| --- | --- | --- | --- |
| `test/loop-option-normalization.test.js` | **数据面** | 翻成反向钉 | 内联白名单副本（`OPTION_WHITELIST`）删掉 `maxTokens` / `temperature` / `topP` 三项（A0 的双向差集 + 位置对账保证副本 ≡ 源名单）；建议矩阵的**平局行**换键：`too` → {tools, topP} 里的 `topP` 已不在候选池，改钉 `tos` → {tools, task}（同为长度 3 / 阈值 2 / 距离 2 的分支，白名单顺序仍压过字典序）；三处合并语义格（`undefined` 不覆盖 / `null` 覆盖 / 非 `undefined` 覆盖）的写点从扁平搬到 `config.tuning.maxTokens`，**断言一字未改**。反向钉本体在 `test/loop-tuning-keys-slice-498s3a5.test.js` 的 **P / P2**（逐字文案 + 叶子仍在 schema + 顶层键已不在白名单） |
| `test/loop-config-namespace-497.test.js` | **数据面** | 翻成反向钉 | `RETIRED_FLAT_VALUES` 增三条（`maxTokens: 512` / `temperature: 0.2` / `topP: 0.9`）；`VALUES`（仍可扁平写的那张）同步删掉它们。B2 开头断言两张表键集**逐字相等**（派生自 `CONFIG_SURFACE_OPTION_NAMES ∖ RUN_TOOL_LOOP_OPTION_NAMES`）⇒ 删键而漏给取值会红；于是 B2 同时证明：扁平形态**不再产生**这三个 `effectiveOptions.*`、config 形态**逐字写回**它们。C1 的「同一个值写两边 ⇒ 不记冲突」通道从 `temperature` 换成 `maxTokenContinuations`（仍可扁平写的配置叶子）——顺带证明本刀没动它 |
| `test/loop-capabilities-namespace-498.test.js` | **行为面 `on*` + 数据面（叶子名索引）** | **未动**（本片零改动） | `git diff --stat` 里没有它。它那张 `REPRESENTATIVE_CONFIG_VALUES` 是**按叶子名索引**的代表性取值表（`tuning: maxTokens / temperature / topP / cacheCapable` 四行照旧），不是顶层扁平写点——叶子仍在 schema 里，所以这四行**必须**留着，删了反而漏测 round-trip |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-option-gate-496.test.js` | 数据面（闸口相位） | **未动**（本片零改动） | `git diff --stat` 里没有它；它的闸口断言测的是「接受面 = 白名单」这条机制，与具体哪三个键退役无关 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-guard-slice-498s3e.test.js` | 数据面（`guard` 片的钉子） | **未动**（本片零改动） | `git diff --stat` 里没有它。它钉的是 `guard` 组三键，与 `tuning` 组无关 |
| `test/loop-tuning-keys-slice-498s3a5.test.js` | **选项面本身** | **本片新增** | 它测的就是「扁平写法现在抛错」这件事，所以按判据登记为 COMPAT-PIN（同 `loop-option-normalization.test.js` 那一行）。能力面写点 **0** ⇒ 主表不受影响 |

合计仍是 **67** 个写点（本片新增的钉子文件在**能力面**上 0 个写点：它不写任何 `on*` 回调）。
⚠ `tuning` 组这三个键是**标量**，本来就不在附表口径里（顶部「生成方式」：标量无子键 ⇒ 不是壳），
所以本片删键**不改变附表任何既有行**——只增了新钉子文件的 7 点（附表 1276 → 1283）。

### COMPAT-PIN 逐文件判定（#498 S3 第六片 `guard`：三个数据键删键）

判据同上：**数据面就地翻成反向拒绝钉；行为面 `on*` 一个字不动**。本片动到的只有**数据面**那两格；
六个 COMPAT-PIN 文件逐个给证据（不是「我看过了」）：

| 文件 | 面 | 本片（`guard`）的处置 | 证据 |
| --- | --- | --- | --- |
| `test/loop-option-normalization.test.js` | **数据面** | 翻成反向钉 | 内联白名单副本（`OPTION_WHITELIST`）删掉 `finalGuardMaxRetries` / `finalGuardTimeoutMs` / `finalGuardExtend` 三项（A0 的双向差集 + 位置对账保证副本 ≡ 源名单）；建议矩阵里 `finalGuardTimout → finalGuardTimeoutMs` 那一行**换了键**（候选池 = 白名单，退役键不再是候选），改钉 `onReasoningDxxtb → onReasoningDelta`（同为长度 16 / 阈值 5 / 距离 3 的分支）。反向钉本体在 `test/loop-guard-slice-498s3e.test.js` 的 **P/P2**（逐字文案 + 叶子仍在 schema + 顶层键已不在白名单） |
| `test/loop-config-namespace-497.test.js` | **数据面** | 翻成反向钉 | `RETIRED_FLAT_VALUES` 增三条（`finalGuardMaxRetries: 1` / `finalGuardTimeoutMs: 5000` / `finalGuardExtend: false`）；`VALUES`（仍可扁平写的那张）同步删掉它们。B2 开头断言两张表键集**逐字相等**（派生自 `CONFIG_SURFACE_OPTION_NAMES ∖ RUN_TOOL_LOOP_OPTION_NAMES`）⇒ 删键而漏给取值会红；于是 B2 同时证明：扁平形态**不再产生**这三个 `effectiveOptions.*`、config 形态**逐字写回**它们 |
| `test/loop-capabilities-namespace-498.test.js` | **行为面 `on*` + 数据面（叶子名索引）** | **未动**（本片零改动） | `git diff --stat` 里没有它。它那张 `VALUES` 是**按叶子名索引**的代表性取值表（`guard: finalGuardMaxRetries / finalGuardTimeoutMs / finalGuardExtend` 三行照旧），不是顶层扁平写点——叶子仍在 schema 里，所以这三行**必须**留着，删了反而漏测 round-trip |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-option-gate-496.test.js` | 数据面（闸口相位） | **未动**（本片零改动） | `git diff --stat` 里没有它；它的闸口断言测的是「接受面 = 白名单」这条机制，与具体哪三个键退役无关 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |

合计 **67** 个写点（本片 +1：新钉子文件 `test/loop-guard-slice-498s3e.test.js` 的 `finalGuard`×1）。
⚠ `guard` 组的三个键是**标量**，本来就不在附表口径里（顶部「生成方式」：标量无子键 ⇒ 不是壳），
所以本片删键**不改变附表任何既有行**——只增了新钉子文件的 6 点。

### COMPAT-PIN 逐文件判定（#498 S3 第四片 A2b：`initialUserMessage` 删键）

判据：**数据面就地翻成反向拒绝钉；行为面 `on*` 一个字不动**。逐文件给证据（不是「我看过了」）：

| 文件 | 面 | A2b 的处置 | 证据 |
| --- | --- | --- | --- |
| `test/loop-option-normalization.test.js` | **数据面** | 翻成反向钉 | 内联白名单副本（`OPTION_WHITELIST`）删掉 `initialUserMessage` 一项；「白名单逐项都被接受」那格因此**不再**证明它被接受（A0 的双向差集 + 位置对账保证副本 ≡ 源名单）。反向钉本体在 `test/loop-input-slice-498s3c.test.js` 的 **P4**（逐字文案 + 叶子仍在 schema + 顶层键已不在白名单） |
| `test/loop-config-namespace-497.test.js` | **数据面** | 翻成反向钉 | `RETIRED_FLAT_VALUES` 增一条 `initialUserMessage: "go"`（B2 开头断言这张表与派生集合 `RETIRED_FLAT_KEYS` **逐字相等** ⇒ 删键而漏给取值会红）；`VALUES`（仍可扁平写的那张）同步删掉它。B2 于是同时证明：扁平形态**不再产生** `effectiveOptions.initialUserMessage`、config 形态**逐字写回**它 |
| `test/loop-option-gate-496.test.js` | 数据面（闸口相位） | 只改搭台，不改断言 | 本文件没有 `initialUserMessage` 的接受面断言；只把 `assemblyError()` 的种子搬进 **policy 的 config 树**（调用级 `config` 会整棵覆盖 `policy.config`，写成显式 config 会把本格要测的坏值顶掉 ⇒ 假绿）。12 格全绿 |
| `test/loop-capabilities-namespace-498.test.js` | **行为面 `on*`** | **未动**（本片零改动） | `git diff --stat` 里没有它 |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | **行为面 `on*`** | **未动**（本片零改动） | 同上 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | **行为面 `on*`** | 只改搭台，不改断言 | 两处裸 `runToolLoop` 的种子经 `withSeed` 翻译（`onFoldSummary` 的「顶层扁平必须还在」那格一字未改） |

合计 **66** 个写点。这 6 个文件在 S9 那一刀里是 **11 个退役键**的唯一「扁平写点保留区」；退役时它们要逐个
改写为「扁平写法现在抛错」的**反向钉**，而不是删掉。（附表那 1354 个数据面壳内写点不在 S9 的退役面内，
但它们**在 S3 的删除面内**——见「裁决更正」与「数据面切片方案」两节。）

## OWNED-BY-S5（本轮别碰，S5 提前做）

#498 S5 迁 `bin/` 时必须同步改「捕获到的扁平选项」那 24 行断言
（`captured.cwd` / `captured.tools` / `captured.deliverables` / `captured.finalGuard` /
`captured.finalGuardMaxRetries` / `captured.context.recoveryHint`），
那 24 行按本表的分类规则本来也属 MIGRATE，现**提前由 S5 做**，因此这 **5** 个文件本轮任何切片都不得改：

| 文件 | 扁平写点 | 谁拥有哪一区 |
| --- | --- | --- |
| `test/cli.test.js` | 2（`finalGuard`×2） | **选项装配断言区**（`captured.*` 的 24 行）归 S5；其余 CLI 行为断言不属 S7 范围 |
| `test/repl.test.js` | 1（`finalGuard`×1） | 同上（REPL 侧的同族捕获断言） |
| `test/host-cwd-wiring.test.js` | 8（`finalGuard`×5, `deliverables`×3） | **整个文件的选项装配断言区**归 S5（cwd 透传与交付物判据的装配断言） |
| `test/notes-final-guard.test.js` | 2（`finalGuard`×2） | 同上（notes 侧 finalGuard 装配断言） |
| `test/integration/no-todo-switch.test.js` | 0（能力面口径） | 同上：S5 在里面加**双向读取器**（规位 `config.input.*` 读不到值就红 + 扁平位不得与规位同存），断言测的是装配形状。本树里它的 6 个写点全在数据面（`prompt`×5 / `tools`×1，见附表），**能力面 0 个** |

合计 **13** 个能力面写点 / **5** 个文件（第 5 个文件贡献 0 个能力面写点，它的 6 个写点在附表里清点）。
理由：这些文件的扁平写点**与 `bin/` 的捕获断言是同一批**——S5 改 `bin/` 的同时必须改它们，两边分开做
会出现「`bin/` 已改、断言还按旧形状读」的中间态红。S9 退役时这 5 个文件由 S5 的交接口径直接处理，
不需要 S7 再插一手。

✅ **S5 已合并（`598a7ea`）后重测（基点 `97f7d30`，用本表内嵌计数器跑 `--verify`）**：这 5 个文件的
能力面写点**仍是 13**，不是 0。原因不是 S5 没干完，而是这 13 点的**宿主不是引擎选项面**：
`test/cli.test.js` 那 2 个 `finalGuard` 是 **`runChat({ ... })` 的 CLI 输入**（`bin/cli.js` 自己的参数面，
S9 退役的是引擎的扁平键，不是 CLI 的入参）、`test/host-cwd-wiring.test.js` 的 8 点同理走 `erix_run` 的
**扩展入参**。S5 迁的是「`captured.*` 那 24 行**装配断言**」——那部分已经改读规位（`canonicalLoopOption`），
本表的**写点**口径看不到这个变化，因为它数的是**调用点属性名**。
⇒ 结论：**「S5 合并后这两类归零」这个预期是错的**；13 就是合并后的真值，`--verify` 逐文件对得上。

✅ **S7c 落账前重测（`bcc1606` 基点）**：S5 这 5 个文件的能力面写点**仍是 13**（`cli.test.js` 2 /
`repl.test.js` 1 / `host-cwd-wiring.test.js` 8 / `notes-final-guard.test.js` 2 /
`integration/no-todo-switch.test.js` 0），**一点没变**——原因与上面那段同一条（宿主是 `runChat` /
`erix_run` 的**入参面**，不是引擎的扁平键），不是 S5 有欠账，也不是 S7c 漏迁。

## OWNED-BY-S6（本轮别碰，S6 提前做）

这 5 个文件断言的是 `buildLoopOptions`（`examples/pi-extension/` 侧）递给引擎的**装配形状**——
而「改这个形状」正是 #498 S6 的交付物本体。所以它们的扁平写点**不能**由 S7 单独迁：S7 先把断言
改成规位，S6 再改装配形状，两边会互相打脸（断言先绿后红，或者为了绿而把 S6 的形状改动顶回去）。

| 文件 | 扁平写点 | 它断言的是哪一面 |
| --- | --- | --- |
| `test/examples/erix-run-core.test.js` | 21（`finalGuard`×19, `onEvent`×1, `onObserverError`×1） | `buildLoopOptions` 的完整装配形状（含 `finalGuard` 与两条观察者出口） |
| `test/examples/erix-run-details.test.js` | 0 | 装配形状的细节字段（本文件当前只有壳内写点） |
| `test/examples/erix-run-readchain.test.js` | 0 | 读链装配（本文件当前没有上表口径内的写点） |
| `test/examples/erix-run-tool-list.test.js` | 0 | 工具清单装配（本文件当前只有 `tools` / `prompt` 壳内写点） |
| `test/examples/erix-run-notes-lifecycle.test.js` | 0 | notes 生命周期装配（本文件当前只有 `tools` 壳内写点） |

合计 **21** 个上表口径内的写点（另有 38 个壳内写点）。交接口径：S6 改完 `buildLoopOptions` 之后，
这 5 个文件的断言由 S6 一并对齐到新形状；S9 退役扁平键时它们已经是规位写法，S7 不需要再插一手。

✅ **S6 已合并（`336a32e` + `97f7d30`）后重测**：这 5 个文件的上表口径写点**仍是 21**（不是 0）。
同样不是漏做：`test/examples/erix-run-core.test.js` 的 19 个 `finalGuard` 是 **`erix_run` 扩展的入参**
（pi 侧公开面，S6 明确「对 pi 的参数面零变化」），S6 迁的是 `buildLoopOptions` **内部映射**——
那条链的断言已经改读 `captured.options.capabilities.hooks.finalGuard` / `config.guard.finalGuardTimeoutMs`
（见该文件 :1580-1611），而**入参**仍是扁平的 `finalGuard: true`，这是 S6 的**交付口径**，不是欠账。
⇒ 21 就是合并后的真值，`--verify` 逐文件对得上。

✅ **S7c 落账前重测（`bcc1606` 基点）**：S6 这 5 个文件的上表口径写点**仍是 21**（全部来自
`test/examples/erix-run-core.test.js`：`finalGuard`×19 + `onEvent`×1 + `onObserverError`×1），
其余 4 个文件 0。**没变**，理由同上面那段（`erix_run` 的 pi 侧入参面，S6 的交付口径是「对 pi 参数面零变化」）。

⚠ `test/examples/erix-run-core.smoke.test.js`（0 个上表口径内的写点）、`test/examples/erix-run-async.test.js`、
`test/examples/erix-run-pi-load.test.js` **不在** S6 的这 5 个之内——它们不在这份所有权清单里，
本表按各自的实际写点归类。

## MIGRATE（S7a / S7b / S7c 分派）

> 口径：**这张表只列「现在仍在树上」的能力面写点**（#498 S7c 迁完之后实测）。S7a / S7b / S7c 三片
> 已全部迁完（各自的迁移前基线见对应清单），所以它们的文件在这里**不出现**——`--verify` 逐文件对账
> 的仍然是「表列写点 == AST 写点」，行不在表里就意味着该文件 0 点。
>
> 表里剩下 4 类、23 个文件、**170** 点，全部**不是 S7 的活**（见各行「分类」列的理由）。

| 文件 | 写点 | 明细 | 分类 |
| --- | --- | --- | --- |
| `test/loop-deliverables.test.js` | 24 | `deliverables`×11, `finalGuard`×11, `onEvent`×2 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/examples/erix-run-core.test.js` | 21 | `finalGuard`×19, `onEvent`×1, `onObserverError`×1 | OWNED-BY-S6 |
| `test/loop-capabilities-namespace-498.test.js` | 20 | `deliverables`×9, `onEvent`×5, `finalGuard`×4, `onRound`×2 | COMPAT-PIN |
| `test/loop-config-namespace-497.test.js` | 16 | `onEvent`×13, `finalGuard`×2, `onObserverError`×1 | COMPAT-PIN |
| `test/loop-option-gate-496.test.js` | 15 | `onFoldSummary`×7, `finalGuard`×6, `deliverables`×2 | COMPAT-PIN |
| `test/loop-on-fold-summary.test.js` | 13 | `onFoldSummary`×11, `onPersistenceError`×2 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/e2e/upstream.test.js` | 8 | `onDelta`×5, `onUsage`×2, `onEvent`×1 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/host-cwd-wiring.test.js` | 8 | `finalGuard`×5, `deliverables`×3 | OWNED-BY-S5 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 8 | `onFoldSummary`×7, `onEvent`×1 | COMPAT-PIN |
| `test/providers/v020-beta.test.js` | 8 | `onEvent`×2, `onReasoningDelta`×2, `onToolCall`×2, `onUsage`×2 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 7 | `onEvent`×7 | COMPAT-PIN |
| `test/providers/openai-stream.test.js` | 6 | `onEvent`×2, `onReasoningDelta`×2, `onDelta`×1, `onUsage`×1 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/cli.test.js` | 2 | `finalGuard`×2 | OWNED-BY-S5 |
| `test/compact/provider-summarizer.test.js` | 2 | `onUsage`×2 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/notes-candidates-and-scopes.test.js` | 2 | `finalGuard`×2 | MIGRATE · NOT-OPTION-SURFACE（runChat 入参，非引擎选项面） |
| `test/notes-final-guard.test.js` | 2 | `finalGuard`×2 | OWNED-BY-S5 |
| `test/providers/anthropic.test.js` | 2 | `onDelta`×2 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/integration/todo-builtin.test.js` | 1 | `finalGuard`×1 | MIGRATE · NOT-OPTION-SURFACE（runChat 入参，非引擎选项面） |
| `test/loop-guard-slice-498s3e.test.js` | 1 | `finalGuard`×1 | COMPAT-PIN |
| `test/loop.test.js` | 1 | `onToolResult`×1 | MIGRATE · 含 COMPAT-PIN 格 |
| `test/repl.test.js` | 1 | `finalGuard`×1 | OWNED-BY-S5 |
| `test/run-snapshot-executor.test.js` | 1 | `onToolResult`×1 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |
| `test/tool-fact-success-parity.test.js` | 1 | `onToolResult`×1 | MIGRATE · NOT-OPTION-SURFACE（非 runToolLoop 选项面，无规位） |

### 分派小结（按上表口径，**S7c 迁完之后**实测）

**「写点」这一列的口径是「现在仍在树上的写点数」**，所以列和必须 = 合计 **170**（逐点只算一次）。

| 类 | 文件数 | 写点（现在仍在树上） |
| --- | --- | --- |
| `MIGRATE · S7a`（已迁完：**迁移前** 37 个写点，现在 **0**） | 7 | 0（迁移前 37，已不在树里） |
| `MIGRATE · S7a 遗留`（3 个 `finalGuard`；**已补进下行 S7c 的 90**，本行不重复计） | 3（⊂ 上行的 7） | 0（已计入 S7c） |
| `MIGRATE · S7b`（已迁完 95 点，剩 0；迁移前 24 文件 / 124 点，明细见 S7b 清单） | 17 | 0 |
| `MIGRATE · S7c`（**本刀已迁完 90 点中的 87**；另 3 点重分类，见下条） | 17 | 0 |
| `MIGRATE · 含 COMPAT-PIN 格`（迁搭台写点，**逐格**跳过选项面断言） | 3 | 38 |
| `MIGRATE · NOT-OPTION-SURFACE`（重分类：不是 `runToolLoop` 选项面，**没有规位**） | 9 | 31 |
| `COMPAT-PIN` | 10 | 67 |
| `OWNED-BY-S5` | 5 | 13 |
| `OWNED-BY-S6` | 5 | 21 |
| **合计（现在实测）** | **64** | **170** |

脚注：

* 写点列和 = `0 + 0 + 0 + 0 + 38 + 31 + 67 + 13 + 21 = 170`，与本列合计逐字相等（`--verify` 逐行核）。
* `NOT-OPTION-SURFACE` 这一类的 31 点**不是「没做完」**：它们是 provider `chatStream(...)` 的回调
  （24）、`createProviderSummarizer({ onUsage })`（2）、`run-snapshot-executor` 的 ctx 字段（1）、
  `tool-fact-success-parity` 里 `MIGRATION_TABLE` 的**数据行字段**（1），**加上 S7c 本刀重分类的 3 点**
  （`test/notes-candidates-and-scopes.test.js` 2 + `test/integration/todo-builtin.test.js` 1 的
  `runChat({ finalGuard: false })`——见下节「S7c 的重分类」）。这些对象的宿主是 provider / summarizer /
  executor / **`runChat` 的入参面**，不是 `runToolLoop` 的选项面，`capabilities.hooks` 不是它们的家
  （改了就是「配了等于没配」）。
* 文件数 **63** 是**去重后**的；写点列和按「逐点只算一次」算，两者口径不同。
* 上表「分类」列是逐点归片的**唯一权威**：同一文件跨片时写 `MIGRATE · S7b（3）+ S7c（1）`，两片各数各的。
  核对命令（文末「复跑方法」第 3 条）会把这张小结与本表逐行对账，退出码非 0 就是列语义又坏了。
* ⚠ 三刀的**实测**：能力面 **388 → 351（S7a −37）→ 256（S7b −95）→ 169（S7c −87）**；
  附表 **678 → 680（S7b +2）→ 1354（S7c 扩键 +674）**。

## S7b 清单（迁移前 24 个文件 / **124** 个能力面写点 ⇒ 本刀迁 **95**，重分类 **28**，S7c 让出 **1**）

主题：**观察者通道与流式回调**（`onEvent` / `onObserverError` / `onPersistenceError` / `onDelta` /
`onReasoningDelta` / `onToolCall` / `onUsage` / `onToolResult` / `onRound`）。
冲突面：**不碰 `bin/`、不碰 `src/`**（全部是纯测试文件）；与 S5 的唯一重叠面是「S5 若顺手改
`src/providers/**` 的选项读法」——那会同时改 `test/providers/*` 的期望值，动之前先对表。
与 S6 无重叠（S6 的 5 个文件全在 `test/examples/`）。

**本刀的账**：`124 = 95（迁完）+ 28（重分类，见下节）+ 1（`finalGuard` 让给 S7c）`。
迁移手法：`onX: fn` ⇒ `capabilities: { hooks: { onX: fn } }`，**同一个对象字面量里的多个叶子合成一个
`capabilities.hooks`**（并列两个 `capabilities` 键是重复键、后者静默胜，S7a 评审记过这个坑）。

| 文件 | 现在仍在树上 | 明细 |
| --- | --- | --- |
| 文件 | 现在仍在树上 | 明细 |
| --- | --- | --- |
| `test/loop-observer-isolation.test.js` | 0 | 已迁完（迁移前 33 点） |
| `test/model-metadata-diagnostics.test.js` | 0 | 已迁完（迁移前 15 点） |
| `test/loop-stream.test.js` | 0 | 已迁完（迁移前 11 点） |
| `test/loop-usage-accounting.test.js` | 0 | 已迁完（迁移前 8 点） |
| `test/loop-v020-rc.test.js` | 0 | 已迁完（迁移前 4 点） |
| `test/loop-resume-unpersisted-tool-results.test.js` | 0 | 已迁完（迁移前 3 点） |
| `test/output-aggregate-budget.test.js` | 0 | 已迁完（迁移前 3 点） |
| `test/loop-v020-beta.test.js` | 0 | 已迁完（迁移前 3 点） |
| `test/persistence-diagnostics.test.js` | 0 | 已迁完（迁移前 2 点） |
| `test/run-state.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-invalid-arguments.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/compaction-strategy-fallback.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/app-container-p0.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/compaction-observability.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-termination.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-forced-final-by-state-475.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-callback-this.test.js` | 0 | S7b 的 3 点已迁完（第 4 点 `finalGuard` 归 S7c，见那张清单） |

### 迁移前 → 现在（逐文件）

| # | 文件 | 迁移前写点 | 现在 |
| --- | --- | --- | --- |
| 1 | `test/loop-observer-isolation.test.js` | 33 | 0 |
| 2 | `test/model-metadata-diagnostics.test.js` | 15 | 0 |
| 3 | `test/loop-stream.test.js` | 11 | 0 |
| 4 | `test/loop-usage-accounting.test.js` | 8 | 0 |
| 5 | `test/e2e/upstream.test.js` | 8 | 8 |
| 6 | `test/providers/v020-beta.test.js` | 8 | 8 |
| 7 | `test/providers/openai-stream.test.js` | 6 | 6 |
| 8 | `test/loop-v020-rc.test.js` | 4 | 0 |
| 9 | `test/tool-fact-success-parity.test.js` | 4 | 1 |
| 10 | `test/loop-callback-this.test.js` | 4 | 1 |
| 11 | `test/loop-resume-unpersisted-tool-results.test.js` | 3 | 0 |
| 12 | `test/output-aggregate-budget.test.js` | 3 | 0 |
| 13 | `test/loop-v020-beta.test.js` | 3 | 0 |
| 14 | `test/persistence-diagnostics.test.js` | 2 | 0 |
| 15 | `test/providers/anthropic.test.js` | 2 | 2 |
| 16 | `test/compact/provider-summarizer.test.js` | 2 | 2 |
| 17 | `test/run-state.test.js` | 1 | 0 |
| 18 | `test/loop-invalid-arguments.test.js` | 1 | 0 |
| 19 | `test/compaction-strategy-fallback.test.js` | 1 | 0 |
| 20 | `test/app-container-p0.test.js` | 1 | 0 |
| 21 | `test/compaction-observability.test.js` | 1 | 0 |
| 22 | `test/loop-termination.test.js` | 1 | 0 |
| 23 | `test/run-snapshot-executor.test.js` | 1 | 1 |
| 24 | `test/loop-forced-final-by-state-475.test.js` | 1 | 0 |

### 重分类：`NOT-OPTION-SURFACE`（28 点 / 7 文件，**不许迁**）

这 28 点被原表按 AST 命中的**键名**归进 S7b，但它们所在的对象**不是 `runToolLoop` 的选项**，
`capabilities.hooks` 不是它们的家。逐点证据（每一条都指向调用点）：

| # | 文件 | 现在仍在树上 | 它到底是什么对象 | 为什么没有规位 |
| --- | --- | --- | --- | --- |
| 1 | `test/e2e/upstream.test.js` | 8 | `openAIProvider(baseUrl).chatStream(providerRequest({ onDelta, onEvent, onUsage }))` | provider **适配器**的回调，不是 run 的选项；`capabilities.hooks` 是 `runToolLoop` 的选项容器 |
| 2 | `test/providers/v020-beta.test.js` | 8 | `provider.chatStream({ ...streamRequest, onEvent, onReasoningDelta, onToolCall, onUsage })` | 同上（provider 端口 API） |
| 3 | `test/providers/openai-stream.test.js` | 6 | `makeProvider(fetchImpl).chatStream({ ...request, onDelta, onEvent, onReasoningDelta })` | 同上 |
| 4 | `test/providers/anthropic.test.js` | 2 | `provider.chatStream({ onDelta })` | 同上 |
| 5 | `test/compact/provider-summarizer.test.js` | 2 | `createProviderSummarizer({ chat, onUsage })` | summarizer 工厂自己的选项面（`src/compact/provider-summarizer.js` 读 `onUsage`），与 run 的 hooks 无关 |
| 6 | `test/run-snapshot-executor.test.js` | 1 | `{ ..., onToolResult: undefined, ... }`（`run-snapshot-executor` 的 **ctx** 字段） | 引擎内部 ctx 的形状钉，不是宿主选项 |
| 7 | `test/tool-fact-success-parity.test.js` | 1 | `MIGRATION_TABLE` 的**数据行字段** `onToolResult:` | 表驱动的夹具数据（真写点在 `options` 里，已迁）；改字段名只是躲计数器，不是迁移 |

⚠ 结论：**provider / summarizer / executor 的端口 API 没有 `capabilities` 容器**，这 28 点在 S9 退役
扁平键时**不受影响**（它们本来就不是扁平 run 选项），也不会被 S3 的壳删除波及。它们该归
`test/contract/model-config-provider.js`（#498 S8 独占）那条**适配器契约**线去讨论，不属 S7。


## S7c 清单（**17** 个纯 MIGRATE 文件 / **90** 个写点 ⇒ 本刀迁 **87**，重分类 **3**）

这 17 个 = 原 13 个 + 4 个 `finalGuard` 写点所在文件（S7a 遗留 3 + S7b 让出 1）；
`finalGuard` 有规位（`capabilities.hooks.finalGuard`）⇒ 属 S9 的移除项，**必须继续迁**，不是可选清理。

主题：**强制收尾 / 交付物判据 / 折叠摘要**（`finalGuard` / `deliverables` / `onFoldSummary`）。
冲突面：**不碰 `bin/`、不碰 `src/`**；与 S5 的重叠面是 `finalGuard` 的**装配断言**（S5 已拿走
`test/cli.test.js` / `test/repl.test.js` / `test/host-cwd-wiring.test.js` / `test/notes-final-guard.test.js`
那 13 个写点）——S7c 动的是**行为**断言，两边按文件切开，不交叉。
与 S6 无重叠。

| 文件 | 写点 | 明细 |
| --- | --- | --- |
| `test/loop-guard-extend.test.js` | 0 | 已迁完（迁移前 26 点） |
| `test/loop-deliverables-outrank.test.js` | 0 | 已迁完（迁移前 25 点） |
| `test/loop-final-guard.test.js` | 0 | 已迁完（迁移前 14 点） |
| `test/loop-resume.test.js` | 0 | 已迁完（迁移前 5 点） |
| `test/loop-final-guard-payload.test.js` | 0 | 已迁完（迁移前 5 点） |
| `test/compaction-strategy-name.test.js` | 0 | 已迁完（迁移前 2 点） |
| `test/wrapup.test.js` | 0 | 已迁完（迁移前 2 点） |
| `test/notes-candidates-and-scopes.test.js` | 2 | **重分类**：`runChat({ finalGuard: false })` 是 CLI 入参，不是引擎选项面（见下节） |
| `test/messages-identity.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-persist-engine-text.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/integration/todo-builtin.test.js` | 1 | **重分类**：同上（`runChat({ finalGuard: false })`） |
| `test/wrapup-normalization-unified.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-pending-tool-result.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-callback-this.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/judge-record.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-abort-terminal-priority.test.js` | 0 | 已迁完（迁移前 1 点） |
| `test/loop-governance-cells.test.js` | 0 | 已迁完（迁移前 1 点） |

### S7c 的重分类（3 点 / 2 文件，**不许迁**）

这 3 点被原表按 AST 键名归进 S7c，但它们**不是 `runToolLoop` 的选项**：

| # | 文件 | 现在仍在树上 | 它到底是什么对象 | 为什么没有规位 |
| --- | --- | --- | --- | --- |
| 1 | `test/notes-candidates-and-scopes.test.js` | 2 | `runChat({ …, finalGuard: false, … })`（`bin/cli.js` 的 `runChat` 入参） | `runChat` 自己 destructure `finalGuard` 后调 `resolveFinalGuard()`（`bin/cli.js:320`）再**自己**拼 `capabilities.hooks.finalGuard` 递给引擎；它**不透传** `capabilities` ⇒ 写 `capabilities` 进去是死选项 |
| 2 | `test/integration/todo-builtin.test.js` | 1 | 同上 | 同上 |

判据与 S7b 对 `OWNED-BY-S5` 那 13 点用的是**同一条**（本表已落账：「`test/cli.test.js` 那 2 个
`finalGuard` 是 `runChat({...})` 的 CLI 输入……S9 退役的是引擎的扁平键，不是 CLI 的入参」）。
⇒ 这 3 点留在扁平侧，S7c 的 90 = **87 迁完 + 3 重分类**，逐点对得上。

含 COMPAT-PIN 格（**逐格**跳过选项面断言，其余照迁）：

| 文件 | 写点 | 明细 | 哪一格留扁平 |
| --- | --- | --- | --- |
| `test/loop-deliverables.test.js` | 24 | `finalGuard`×11, `onEvent`×2, `deliverables`×11 | `deliverables[0].check must be a function` 那一格（值形状钉） |
| `test/loop-on-fold-summary.test.js` | 13 | `onFoldSummary`×11, `onPersistenceError`×2 | `assembly policy option onFoldSummary must be a function (or omitted)` 那一格（#499 形状钉） |
| `test/loop.test.js` | 1 | `onToolResult`×1 | 「rejects unknown runToolLoop options with a close suggestion」那一格 |

## 附表：`finalGuard` / `deliverables` 之外的**壳内写点**（数据面，S9 不退役）

这些键的规范之家是 `config.*`（数据 ⇒ `config.*`），**它们不在 S9 的 11 个退役键里**——扁平数据键
在 S9 之后仍然被接受（`config` 是加法，优先级是「容器赢扁平」）。

⚠ **裁决更正（母单 #495，S7b 落账，S7c 校准）**：早先这里写「迁它们是**可选的整洁**，S9 不需要等它，
另立单做」——**那句作废**。S3（删顶层扁平配置键）已并入 0.28 破坏包，判据更正为「顶层 **67** → 33」。
而下面这些写点住的 `context` / `reflection` / `retry` / `wrapup` / `completion` / `session` 等**壳**
正是 S3 要删的东西 ⇒ **它们是 S3 的硬前置**，不是可选清理：壳删了、写点还按壳写，就是当场红。
切片方案见文末「数据面 1354 的垂直切片方案（S7d / S7e / S7f / S7g）」。（那份方案是 S3 之前写的，
分片数字保留为**历史规划口径**；今天的实测总数是 **1343**，见文末「复跑方法」。）

计数口径与上表同（AST、数到被数的键就停、进了同名壳就停，于是 `context: { strategy }` 只算 `context` 一个）。
**合计 1343**（= `node scripts/flat-count-inventory.mjs .` 的第二个数；下面 **116** 行逐行相加也是 1343）。
（S3 之前是 1354 / 104 行，两片之后 1269 / 106 行；差额与原因见文件头的「附表口径刷新」注。）

### 数据面键表：从白名单枚举（#498 S7c 扩键，680 → 1354）

**判据（机器可判，不凭记忆）**：顶层白名单键 K 进数据面键表 ⇔ **K 属配置面**（`CONFIG_SURFACE_OPTION_NAMES`）
**且**在 `test/**` 里至少出现过一次 `K: { … }`（对象字面量 ⇒ 引擎按名字读子键的**壳**）。逐键枚举
（`node scripts/flat-count-inventory.mjs . --keys`）：

| 键 | 写点 | 文件数 | 进表？ | 备注 |
| --- | --- | --- | --- | --- |
| `completion` | 370 | 72 | ✅ **本刀新增** | `config.run.completion`（`{ signals, maxNoToolRounds }`） |
| `reflection` | 173 | 38 | ✅ 原有 | `config.run.reflection` |
| `context` | 133 | 43 | ✅ 原有 | `config.folding.context` |
| `tools` | 117 | 36 | ✅ 原有 | `config.input.tools` |
| `session` | 112 | 22 | ✅ **本刀新增** | `config.metadata.session`（`{ id, modelSlot, resume, initialMessages }`） |
| `wrapup` | 90 | 24 | ✅ **本刀新增**（S7b 点名） | `config.input.wrapup` |
| `resume` | 75 | 28 | ✅ 原有 | `config.run.resume`（整块开关，布尔） |
| `stallDetection` | 63 | 24 | ✅ **本刀新增**（S7b 点名） | `config.run.stallDetection` |
| `prompt` | 58 | 12 | ✅ 原有 | **不是** runToolLoop 选项：`bin/cli.js` 的 `runChat({ prompt })` 入参 |
| `strategy` | 50 | 14 | ✅ 原有 | 非白名单**在壳叶子**：`context.strategy`（壳中壳） |
| `retry` | 39 | 13 | ✅ 原有 | `config.timing.retry` |
| `initialMessages` | 24 | 9 | ✅ 原有 | `config.input.messages`（唯一一条别名） |
| `outputHygiene` | 19 | 7 | ✅ **本刀新增**（S7b 点名） | `config.run.outputHygiene` |
| `modelMetadata` | 12 | 5 | ✅ **本刀新增** | `config.metadata.modelMetadata`（`{ contextWindowTokens, maxOutputTokens }`） |
| `partialPersistence` | 11 | 7 | ✅ **本刀新增** | `config.run.partialPersistence` |
| `judgeProvider` | 4 | 2 | ✅ 原有 | 非白名单在壳叶子：`reflection.judge.provider`（已有规位 `capabilities.ports`） |
| `sleepImpl` | 4 | 2 | ✅ 原有 | 非白名单在壳叶子：`retry.sleepImpl`（已有规位 `capabilities.ports`） |
| **合计** | **1354** | **104** | | 680（原 10 键）+ 674（新增 7 键净增） |

**明确排除的键（每条都有机器可判的理由，不是凭记忆漏的）**：

* `system` / `user` / `task` / `model` / `toolContext`：值是不透明**载荷**（`{ id }` / `{ content }`），
  引擎不按名字读子键；`system` 还在 **provider 请求体**里出现（`test/messages/anthropic.test.js:125`），
  那不是 `runToolLoop` 的选项面 ⇒ 归 `NOT-OPTION-SURFACE`，不进本表。
* `writeToolNames` / `writeToolPathKeys`：字符串数组，元素不是子键。
* 其余标量键（`maxRounds` 451 / `runId` 441 / `cwd` 346 / `initialUserMessage` 452 / `stream` 59 /
  `maxTokens` 46 …）：**没有子键 ⇒ 不是壳**。S3 删它们是一键一处改写，不是拆壳；它们的消费者面用
  「删键后全量红格数」校准（见文末「校准方法」）。
* ⚠ **`session` 进表会吞掉 3 点**：`session: { resume, initialMessages }` 的两个同名子键在规则
  「数到被数的键就停」下不再计（`resume` 77→75、`initialMessages` 25→24）。这是**口径的正确行为**
  （壳内叶子不是扁平写点），也是 680 + 677（7 键裸计数）− 3 = 1354 的来源。

### 逐文件明细（110 行 / 1276 点；S3 前 104 行 / 1354 点）

| 文件 | 写点 | 明细 |
| --- | --- | --- |
| `test/judge.test.js` | 122 | `completion`×55, `reflection`×52, `wrapup`×11, `resume`×2, `stallDetection`×2 |
| `test/loop-capabilities-ports-hooks-498s4c.test.js` | 82 | `completion`×24, `wrapup`×24, `context`×7, `onEvent`×7, `reflection`×6, `retry`×6, `judgeProvider`×3, `session`×3, `sleepImpl`×3, `strategy`×3, `tools`×3 |
| `test/cli.test.js` | 74 | `session`×36, `prompt`×29, `reflection`×4, `tools`×3, `finalGuard`×2, `completion`×1, `context`×1 |
| `test/loop-resume.test.js` | 69 | `completion`×33, `resume`×23, `tools`×8, `reflection`×3, `wrapup`×2 |
| `test/loop-option-gate-496.test.js` | 28 | `completion`×7, `context`×7, `onFoldSummary`×7, `finalGuard`×6, `reflection`×5, `tools`×3, `deliverables`×2, `session`×2, `partialPersistence`×1, `sleepImpl`×1, `stallDetection`×1, `wrapup`×1 |
| `test/loop-config-namespace-497.test.js` | 45 | `onEvent`×13, `completion`×11, `wrapup`×11, `tools`×6, `session`×4, `context`×2, `finalGuard`×2, `initialMessages`×2, `resume`×2, `retry`×2, `modelMetadata`×1, `onObserverError`×1, `outputHygiene`×1, `partialPersistence`×1, `reflection`×1, `stallDetection`×1 |
| `test/loop-resume-anchor.test.js` | 38 | `completion`×8, `stallDetection`×8, `wrapup`×8, `resume`×7, `tools`×6, `partialPersistence`×1 |
| `test/loop-v020-rc.test.js` | 24 | `completion`×19, `session`×3, `resume`×1, `stallDetection`×1 |
| `test/loop-resume-notice.test.js` | 29 | `completion`×11, `tools`×9, `resume`×7, `reflection`×2 |
| `test/loop.test.js` | 31 | `completion`×15, `stallDetection`×12, `reflection`×2, `onToolResult`×1, `tools`×1, `wrapup`×1 |
| `test/examples/erix-run-core.test.js` | 24 | `finalGuard`×19, `tools`×14, `strategy`×4, `context`×3, `reflection`×3, `onEvent`×1, `onObserverError`×1 |
| `test/loop-capabilities-namespace-498.test.js` | 22 | `deliverables`×9, `completion`×5, `onEvent`×5, `wrapup`×5, `finalGuard`×4, `retry`×3, `onRound`×2, `context`×1, `modelMetadata`×1, `outputHygiene`×1, `partialPersistence`×1, `reflection`×1, `resume`×1, `session`×1, `stallDetection`×1, `tools`×1 |
| `test/loop-option-normalization.test.js` | 23 | `session`×8, `completion`×7, `tools`×5, `wrapup`×3 |
| `test/reflection.test.js` | 23 | `completion`×12, `reflection`×10, `resume`×1 |
| `test/judge-record.test.js` | 20 | `reflection`×13, `completion`×5, `context`×1, `session`×1 |
| `test/integration/memento-scenario.test.js` | 16 | `completion`×4, `reflection`×4, `tools`×4, `wrapup`×4 |
| `test/loop-guard-extend.test.js` | 16 | `reflection`×13, `outputHygiene`×2, `resume`×1 |
| `test/loop-persist-engine-text.test.js` | 19 | `reflection`×8, `tools`×6, `resume`×2, `completion`×1, `stallDetection`×1, `wrapup`×1 |
| `test/messages-identity.test.js` | 17 | `strategy`×12, `completion`×2, `tools`×2, `context`×1 |
| `test/loop-request-user-invariant.test.js` | 16 | `initialMessages`×5, `completion`×4, `stallDetection`×3, `tools`×3, `resume`×1 |
| `test/loop-stream.test.js` | 14 | `completion`×5, `partialPersistence`×4, `wrapup`×4, `resume`×1 |
| `test/output-aggregate-budget.test.js` | 14 | `outputHygiene`×7, `completion`×4, `reflection`×2, `resume`×1 |
| `test/output-hygiene.test.js` | 14 | `completion`×7, `outputHygiene`×6, `resume`×1 |
| `test/wrapup.test.js` | 17 | `completion`×11, `reflection`×3, `wrapup`×3 |
| `test/loop-context-on-fold-summary-retired-499.test.js` | 16 | `onFoldSummary`×7, `context`×6, `completion`×2, `stallDetection`×2, `tools`×2, `wrapup`×2, `onEvent`×1, `session`×1, `strategy`×1 |
| `test/sessions.test.js` | 16 | `session`×16 |
| `test/loop-abort-terminal-priority.test.js` | 15 | `reflection`×5, `stallDetection`×5, `completion`×4, `judgeProvider`×1 |
| `test/loop-metadata-keys-slice-498s3a8.test.js` | 16 | `tools`×6, `modelMetadata`×3, `completion`×2, `session`×2, `wrapup`×2, `context`×1 |
| `test/loop-run-slice-498s3a11.test.js` | 18 | `completion`×7, `wrapup`×7, `reflection`×2, `context`×1, `tools`×1 |
| `test/loop-metadata-keys-slice-498s3a9.test.js` | 19 | `completion`×4, `session`×4, `wrapup`×4, `context`×3, `reflection`×2, `tools`×2 |
| `test/loop-fold-context-knobs-469.test.js` | 14 | `strategy`×6, `context`×2, `session`×2, `tools`×2, `completion`×1, `wrapup`×1 |
| `test/loop-on-fold-summary.test.js` | 12 | `onFoldSummary`×11, `tools`×3, `completion`×2, `context`×2, `onPersistenceError`×2, `stallDetection`×2, `wrapup`×2, `session`×1 |
| `test/loop-folding-slice-498s3b.test.js` | 7 | `completion`×3, `wrapup`×3, `context`×1 |
| `test/loop-timing-slice-498s3.test.js` | 7 | `completion`×3, `stallDetection`×2, `retry`×1, `wrapup`×1 |
| `test/loop-input-slice-498s3c.test.js` | 12 | `wrapup`×4, `completion`×2, `initialMessages`×2, `session`×2, `tools`×2 |
| `test/loop-fr2.test.js` | 7 | `completion`×7 |
| `test/model-metadata-diagnostics.test.js` | 8 | `completion`×5, `outputHygiene`×1, `session`×1, `tools`×1 |
| `test/persistence-diagnostics.test.js` | 11 | `completion`×9, `reflection`×2 |
| `test/run-state.test.js` | 10 | `completion`×7, `resume`×3 |
| `test/compaction-strategy-name.test.js` | 10 | `strategy`×8, `completion`×2 |
| `test/loop-termination.test.js` | 12 | `completion`×6, `stallDetection`×5, `reflection`×1 |
| `test/cli-idle-retry.test.js` | 11 | `retry`×5, `prompt`×3, `session`×3 |
| `test/integration/no-todo-switch.test.js` | 11 | `prompt`×5, `session`×5, `tools`×1 |
| `test/loop-final-guard.test.js` | 11 | `completion`×7, `reflection`×4 |
| `test/cli-idle.test.js` | 10 | `prompt`×5, `session`×5 |
| `test/compact/resume-fold-trim.test.js` | 9 | `strategy`×5, `resume`×3, `completion`×1 |
| `test/loop-governance-switch-cells.test.js` | 10 | `completion`×4, `reflection`×4, `wrapup`×2 |
| `test/loop-persist-compaction-facts.test.js` | 8 | `completion`×3, `reflection`×3, `resume`×1, `strategy`×1 |
| `test/loop-resume-unpersisted-tool-results.test.js` | 10 | `resume`×6, `completion`×1, `stallDetection`×1, `tools`×1, `wrapup`×1 |
| `test/examples/erix-run-tool-list.test.js` | 9 | `tools`×7, `prompt`×2 |
| `test/loop-resume-fold-immunity.test.js` | 9 | `completion`×2, `reflection`×2, `tools`×2, `wrapup`×2, `resume`×1 |
| `test/notes-candidates-and-scopes.test.js` | 9 | `session`×7, `finalGuard`×2, `prompt`×2 |
| `test/repl.test.js` | 9 | `session`×6, `completion`×1, `finalGuard`×1, `prompt`×1, `tools`×1 |
| `test/governor.test.js` | 8 | `completion`×4, `stallDetection`×4 |
| `test/loop-error-budget-cells.test.js` | 8 | `completion`×4, `stallDetection`×3, `resume`×1 |
| `test/loop-guard-slice-498s3e.test.js` | 6 | `completion`×2, `wrapup`×2, `context`×1, `finalGuard`×1, `reflection`×1 |
| `test/app-container-p0.test.js` | 6 | `completion`×3, `stallDetection`×3 |
| `test/compact/folded-facts.test.js` | 6 | `strategy`×4, `completion`×1, `reflection`×1 |
| `test/loop-governance-cells.test.js` | 7 | `completion`×3, `reflection`×3, `resume`×1 |
| `test/loop-intercept-count-cells.test.js` | 7 | `completion`×3, `reflection`×3, `resume`×1 |
| `test/loop-invalid-arguments.test.js` | 7 | `completion`×3, `tools`×3, `resume`×1 |
| `test/loop-resume-prior-seed-469.test.js` | 5 | `completion`×2, `reflection`×2, `resume`×1 |
| `test/capture-honesty.test.js` | 6 | `prompt`×3, `session`×3 |
| `test/examples/erix-run-async.test.js` | 6 | `tools`×4, `context`×1, `strategy`×1 |
| `test/loop-folded-facts-sliding-resume.test.js` | 5 | `completion`×1, `stallDetection`×1, `strategy`×1, `tools`×1, `wrapup`×1 |
| `test/loop-persistence-phase.test.js` | 5 | `completion`×1, `partialPersistence`×1, `reflection`×1, `tools`×1, `wrapup`×1 |
| `test/notes-final-guard.test.js` | 6 | `prompt`×3, `session`×3, `finalGuard`×2 |
| `test/tool-fact-success-parity.test.js` | 5 | `completion`×2, `onToolResult`×1, `outputHygiene`×1, `reflection`×1, `resume`×1 |
| `test/display/projection.test.js` | 4 | `wrapup`×2, `completion`×1, `reflection`×1 |
| `test/loop-fold-count-cells.test.js` | 4 | `completion`×2, `resume`×1, `stallDetection`×1 |
| `test/loop-usage-accounting.test.js` | 4 | `reflection`×2, `completion`×1, `stallDetection`×1 |
| `test/loop-v020.test.js` | 3 | `completion`×3 |
| `test/compact/fold-archive.test.js` | 2 | `completion`×2 |
| `test/compaction-strategy-fallback.test.js` | 1 | `completion`×1 |
| `test/loop-message-rows-crash-matrix.test.js` | 4 | `completion`×1, `stallDetection`×1, `tools`×1, `wrapup`×1 |
| `test/loop-observer-isolation.test.js` | 4 | `completion`×2, `context`×1, `reflection`×1 |
| `test/loop-run-state-cells.test.js` | 4 | `completion`×2, `resume`×2 |
| `test/loop-termination-reason-cell.test.js` | 4 | `completion`×2, `stallDetection`×2 |
| `test/cli-process.test.js` | 3 | `prompt`×3 |
| `test/e2e/upstream.test.js` | 2 | `onDelta`×5, `onUsage`×2, `completion`×1, `onEvent`×1, `stallDetection`×1 |
| `test/examples/erix-run-notes-lifecycle.test.js` | 3 | `tools`×3 |
| `test/loop-forced-final-by-state-475.test.js` | 3 | `completion`×3 |
| `test/tools/notes.test.js` | 3 | `context`×3 |
| `test/cli-idle-payload.test.js` | 2 | `prompt`×1, `session`×1 |
| `test/compaction-observability.test.js` | 1 | `completion`×1 |
| `test/examples/erix-run-core.smoke.test.js` | 2 | `strategy`×2 |
| `test/examples/erix-run-details.test.js` | 2 | `reflection`×1, `strategy`×1 |
| `test/integration/todo-builtin.test.js` | 2 | `finalGuard`×1, `prompt`×1, `session`×1 |
| `test/loop-inject-flags.test.js` | 2 | `completion`×1, `stallDetection`×1 |
| `test/loop-judge-done-forced-final.test.js` | 2 | `completion`×1, `reflection`×1 |
| `test/loop-run-loop-state-tdz.test.js` | 2 | `completion`×1, `reflection`×1 |
| `test/loop-v020-beta.test.js` | 0 | |
| `test/messages/anthropic.test.js` | 2 | `tools`×2 |
| `test/messages/tool-result-content.test.js` | 2 | `completion`×2 |
| `test/providers/anthropic.test.js` | 2 | `onDelta`×2, `tools`×2 |
| `test/providers/openai-stream.test.js` | 2 | `onEvent`×2, `onReasoningDelta`×2, `tools`×2, `onDelta`×1, `onUsage`×1 |
| `test/providers/openai.test.js` | 2 | `tools`×2 |
| `test/skills.test.js` | 2 | `tools`×2 |
| `test/tokens-estimate-hotpath.test.js` | 1 | `completion`×1 |
| `test/tools.test.js` | 2 | `context`×2 |
| `test/wrapup-normalization-unified.test.js` | 2 | `completion`×1, `reflection`×1 |
| `test/wrapup-protocol-observer.test.js` | 2 | `completion`×1, `reflection`×1 |
| `test/display/projection-keys.test.js` | 1 | `wrapup`×1 |
| `test/helpers/engine-fact-rows.js` | 1 | `strategy`×1 |
| `test/host-cwd-wiring.test.js` | 1 | `finalGuard`×5, `deliverables`×3, `tools`×1 |
| `test/loop-callback-this.test.js` | 1 | `completion`×1 |
| `test/loop-final-guard-payload.test.js` | 1 | `completion`×1 |
| `test/loop-resume-summary-history.test.js` | 1 | `resume`×1 |
| `test/provider-runner.test.js` | 1 | `context`×1 |
| `test/providers/error-classification.test.js` | 0 | |
| `test/run-snapshot-executor.test.js` | 1 | `context`×1, `onToolResult`×1 |
| `test/loop-seed-fixture-521.test.js` | 4 | `completion`×2, `wrapup`×2 |
| `test/loop-tuning-slice-498s3d.test.js` | 7 | `completion`×3, `wrapup`×2, `context`×1, `stallDetection`×1 |
| `test/loop-tuning-keys-slice-498s3a5.test.js` | 7 | `completion`×2, `wrapup`×2, `context`×1, `session`×1, `tools`×1 |
| `test/loop-input-keys-slice-498s3a6.test.js` | 16 | `wrapup`×7, `completion`×4, `tools`×4, `context`×1 |
| `test/loop-run-slice-498s3a12.test.js` | 2 | `completion`×1, `wrapup`×1 |
| `test/loop-run-slice-498s3a13.test.js` | 4 | `completion`×1, `outputHygiene`×1, `stallDetection`×1, `wrapup`×1 |
| `test/loop-run-slice-498s3a14.test.js` | 6 | `completion`×3, `wrapup`×3 |

## 数据面 1354 的垂直切片方案（S7d / S7e / S7f / S7g）——**按配置组垂直切**（S3 前口径；今实测 1269）

**只交方案，不干活**（S7c 的交付物就是这张切片表）。

⚠ **切片单位改了（母单 #495 主 agent 裁决，S7c 落账）**：S7b 那一版是按**壳**横切（`context` 一片、
`reflection` 一片…）。**那一版作废**——壳横切的每一刀都要动同一批文件的不同位置，删键时两侧（白名单
+ schema 组表）对不齐，会留下「键已删、叶子还在」或「叶子已删、键还在」的中间态。
**现口径：按 `CONFIG_NAMESPACE_SCHEMA` 的配置组垂直切**，一刀做完该组的**全部**六件事：

1. **删白名单键**：`RUN_TOOL_LOOP_OPTION_NAMES` 里该组的所有顶层扁平键；
2. **删 schema 组表 / 别名表叶子**：`CONFIG_NAMESPACE_SCHEMA[<组>]` 的对应叶子（`input.messages` 这条
   `CONFIG_LEAF_ALIASES` 条目随组删）；
3. **迁所有消费者**：`src/**`、`bin/**`、**`examples/**`**、`test/**`——一处不留（含 `test/contract/**`
   与 `test/examples/**`，它们不再享有 S7 阶段的「别人拥有」豁免，S8/S6 已合并）；
4. **更新账目格**：本表的行、分派小结、以及 `configSchemaSelfCheck()` 的期望值；
5. **给旧名加反向拒绝钉**：旧扁平键写进 `runToolLoop` 必须**当场抛**（`unknown runToolLoop option`
   那一句，带 close suggestion），不是「静默忽略」——「配了等于没配」是这一族最阴的坑；
6. **校准**（见下「校准方法」）：跑全量 `npm test`，把红格数记进账。

### 按配置组的写点数（S7c 扩键后实测）

| S3 删除组 | 组内壳键 | 写点 | 文件数 | 与 COMPAT-PIN 重叠 | 切片 |
| --- | --- | --- | --- | --- | --- |
| `folding` | `context`(133) + `strategy`(50) | **183** | 46 | 5 文件 | **S7d** |
| `run` | `completion`(370) + `reflection`(173) + `resume`(75) + `stallDetection`(63) + `outputHygiene`(19) + `partialPersistence`(11) | **711** | 76 | 6 文件 | **S7e** |
| `timing` | `retry`(39) | **39** | 13 | 4 文件 | **S7f-1** |
| `input` | `tools`(117) + `wrapup`(90) + `initialMessages`(24) | **231** | 45 | 6 文件 | **S7f-2** |
| `metadata` | `session`(112) + `modelMetadata`(12) | **124** | 24 | 6 文件 | **S7g**（新增：S7b 的表里没有这一组） |
| 无组（能力面端口位 / CLI 入参） | `prompt`(58) + `judgeProvider`(4) + `sleepImpl`(4) | **66** | 15 | 2 文件 | 不切片：`sleepImpl`/`judgeProvider` 改成 `capabilities.ports.*` 随 `timing`/`run` 顺带；`prompt` 是 `bin/cli.js` 的入参面，归 `bin/` 消费者线（S5 口径），本表只清点 |
| **合计** | | **1354**（S3 前口径；今实测 **1269**） | **104（去重；今 106）** | | |

`183 + 711 + 39 + 231 + 124 + 66 = 1354` ✅（**S3 之前**的 AST 合计；S3 的 `timing` / `folding` 两片
把 `retry` / `context` / `toolResultTtl` / `toolResultFoldMinTokens` 的扁平写法摘掉之后，今天的实测合计是
**1259**（`timing` + `folding` 两片之后是 1269），`--verify` 逐行零误差。分组的逐项数字保留为 S3 前的规划口径。）

### 三片（+1）的边界与先后

| 片 | 内容 | 写点 | 文件数 | 为什么这么切 |
| --- | --- | --- | --- | --- |
| **S7d** | `folding` 组（`context` + `strategy`） | 183 | 46 | `strategy` 是**壳中壳**（`context.strategy`）——同一个删除组、同一批文件，横切会互相打脸 |
| **S7e** | `run` 组（`completion` / `reflection` / `resume` / `stallDetection` / `outputHygiene` / `partialPersistence`） | 711 | 76 | 最大的一刀（占 52%）；`judgeProvider` 的端口迁移顺带在这里收尾 |
| **S7f** | `timing` + `input`（`retry` / `tools` / `wrapup` / `initialMessages`） | 270 | — | 输入载荷族 + 退避：`tools` 与 `initialMessages` 同一组、`retry` 独立成组；`sleepImpl` 的端口迁移随 `timing` 收尾 |
| **S7g** | `metadata` 组（`session` + `modelMetadata`） | 124 | 24 | **S7b 的表里没有这一组**（它的键表漏了 `session`）。`session` 的壳里还套着 `resume` / `initialMessages` 两个同名子键 ⇒ 必须排在 S7e / S7f **之后**（否则那两个子键会被 S7g 的壳一起带走，两刀互相覆盖） |

### 校准方法（**必读**：写点数 ≠ 消费者面）

写点数（本表那 1269，S3 前是 1354）只是「扁平写法出现的地方」，**不是**删一个键会红多少格。真实消费者面必须
**实测**，方法是「只删一个键、两侧都摘、跑全量」：

```
1) 从 RUN_TOOL_LOOP_OPTION_NAMES 删掉一个键（例如 maxRounds）
2) 从 CONFIG_NAMESPACE_SCHEMA 的组表里删掉同一个叶子
3) npm test  →  记下 fail 格数
```

主 agent 在 #495 的实测基准：**只删 `maxRounds` 一个键、两侧都摘 ⇒ `configSchemaSelfCheck()` 自检
返回 `[]`（绿），但全量 `npm test` 红 507 格**。这就是 `maxRounds` 的**真实消费者面**：
`configSchemaSelfCheck()` 只核「每个顶层键恰好一个家」，它**看不见**消费者；
而 507 格红是 `src/` / `bin/` / `examples/` / `test/` 里每一处按旧名读/写 `maxRounds` 的断言。

⚠ 因此每片的**验收数**是两个，不是一个：
* 写点数（本表）= 迁移面；
* **删键后全量红格数**（校准）= 消费者面。片内红格必须全部消掉、且 `npm test` 回到基线，
  才算这一片做完；只把写点数降到 0 而红格还在 = 没做完（写点数看不见 `src/` 里的消费者）。

⚠ 两点提醒（给接 S7d/S7e/S7f/S7g 的人）：

1. **COMPAT-PIN 的 6 个文件合计 129 个数据面写点**，四片都会碰到它们：规则不变——**逐格跳过**
   「断言直接读选项面」的那几格，其余照迁。**S7c 之后它们仍是唯一的「扁平写点保留区」。**
2. **`test/contract/**` 一个字不碰**（S8 独占，且 #518a 正在并行改 `test/config/**` /
   `test/static-guards.test.js`）；`context` / `reflection` 的壳内还有 `onBeforeFold` /
   `onAfterFold` / `stubFor` / `onReflection` / `protectedMessage` / `recoveryHint` 这些**能力面**叶子，
   迁壳时要按 S4c 的形态多态表拆成两侧（函数 ⇒ `capabilities.hooks`，数据 ⇒ `config.*`），
   **一个旋钮只写一侧**。

## 复跑方法

数字是**一次性 AST 走查**的产物（口径逐字写在顶部「生成方式」里，规则五条）。走查脚本**就在仓库里**：
**`scripts/flat-count-inventory.mjs`**。

> ⚠ **#529：`/tmp/` 不再是复现基准。** #529 之前这一节是把脚本 heredoc 粘到 `/tmp/flat-count.cjs` 再跑，
> 复跑命令因此长成 `node scripts/flat-count-inventory.mjs …` —— 复现路径落在仓库**外面**：干净检出上跑不通，
> 表一漂移就没人能刷（第十一片与 A12 两片都是这么卡住的）。现在脚本是仓库内的一个文件，
> **所有复跑 / 刷表 / 反向证命令一律写 `node scripts/flat-count-inventory.mjs …`**；
> 禁止再以 `/tmp/` 下的副本当复现基准（`/tmp/base-498` 那种**被测的树**是另一回事，见第 2 条）。

放在 `scripts/` 的理由：仓库的 node 工具一律住这里、以 `node scripts/<name>.mjs` 调用（`package.json`
的 `check:*` 全是这个形状），`test/` 只放**被测**的东西（放量尺进去会被 `node --test` 收走）。
**`scripts/` 里已有的门禁脚本一个都没改**——这是**新增**的一个文件。

`typescript` 在 `devDependencies` 里，`npm ci` 后就有；脚本按**自身位置**解析它，所以在哪个 cwd 跑都行。

```bash
# 1) 现在的三个总数（本表主表 170 / 附表 1343 / 全部 1513）
node scripts/flat-count-inventory.mjs .                       # ⇒ 能力面 13 键 170 / 数据面 17 键 1343 / 全部 1513
node scripts/flat-count-inventory.mjs . --keys                # ⇒ 逐键明细（17 个数据面键 + 13 个能力面键，见「数据面键表」）
node scripts/flat-count-inventory.mjs . --files               # ⇒ 逐文件明细（117 文件 / 1513 点，与本表逐行零误差）

# 2) 迁移前基线（388 / 1351 / 1739）：把 S7a 迁移前的树解到 /tmp/base-498
#    注意 `/tmp/base-498` 是**被测的树**（tree root 参数），不是脚本的存放地——脚本永远从仓库内跑。
rm -rf /tmp/base-498 && mkdir -p /tmp/base-498 && git archive 0b2d858 test | tar -x -C /tmp/base-498
node scripts/flat-count-inventory.mjs /tmp/base-498           # ⇒ 能力面 13 键 388 / 数据面 17 键 1351 / 全部 1739
                                                 #    388 − 37（S7a 已迁）= 351 ✅
                                                 #    注意：数据面这里是**扩键后**的口径（1351），
                                                 #    旧 10 键口径下才是本表早先写的 678。

# 3) 与本表逐行对账（主表 23 行 + 附表 116 行 + 分派小结的加总式；不一致 ⇒ 退出码 1）
node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md; echo "EXIT=$?"   # ⇒ EXIT=0

# 3b) 表漂移了怎么办：**机器刷**，不许手改数字
node scripts/flat-count-inventory.mjs . --sync test/compat-pin-inventory.md     # 数字与明细列都由 AST 重写，漏行按实测补
node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md; echo "EXIT=$?"   # ⇒ 必须 EXIT=0
```

其余几条核对（同一棵树实测）：

```bash
# 4) 两个交叉核对的 grep（口径比 AST 宽：会数到注释与断言里的字样，所以数字只会 ≥ 本表）
#    COMPAT-PIN 记号命中（哪些文件「被测对象就是选项面」）
grep -rln 'config_override_conflict\|unknown capabilities\|is not accepted\|must be a function\|unknown runToolLoop option\|RUN_TOOL_LOOP_OPTION_NAMES\|CAPABILITY_\|CONFIG_' test --include='*.js' | grep -v '^test/contract/'
#    11 个退役键的**剩余**扁平写点（S7 每落一片，这个数字必须往下走）
grep -rc '^ *\(onEvent\|onRound\|onJudge\|onToolResult\|onDelta\|onReasoningDelta\|onToolCall\|onUsage\|onObserverError\|onPersistenceError\|onFoldSummary\) *:' test --include='*.js' | grep -v ':0$'

# 5) 基线计数（A12b 之后：2557 格 / 2548 通过 / 0 红 / 9 skip）
node --test 2>&1 | grep -E '^# (tests|pass|fail|skipped) '     # ⇒ 2557 / 2548 / 0 / 9

# 6) 白名单条数（「顶层 65」那个旧数就是没跑这条；A12 退役 `partialPersistence` 后 39 → 38）
node -e 'import("./src/loop/option-normalization.js").then(m=>console.log(m.RUN_TOOL_LOOP_OPTION_NAMES.length))'
                                                 # ⇒ 38

# 7) 反向证（口径自检真的会红）：把附表里某一行 +3，`--verify` 必须 exit=1 并**点名该文件**
sed -i 's/^| `test\/judge.test.js` | 122 |/| `test\/judge.test.js` | 125 |/' test/compat-pin-inventory.md
node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md; echo "EXIT=$?"   # ⇒ EXIT=1，且打印
                                                 #    ✗ 附表 test/judge.test.js：表 125 / AST 122
git checkout -- test/compat-pin-inventory.md     # 还原：git 就是备份，不落盘 /tmp 副本
```

⚠ 第 5 条**不能**写成 `grep -c '^test(' test/*.test.js | awk …`：那条命令只数顶层文件里行首的 `test(`，
实测 **1221**，既漏掉缩进的格、也漏掉子目录（`test/**/**.test.js`），跑不出 2548。
