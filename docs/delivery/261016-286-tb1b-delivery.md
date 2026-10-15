# 261016-286-tb1b 交付报告 — issue #286 T-b 第一刀下半（orchestrator 族剩余裸区间清零）

- 分支 `feat-261016-03-286-tb1b`，基点 `main` = `f15cd07`（T-b1a 已合并，判据 `symbol-anchor-span` 已上线）。
- 版本仍 `0.20.0`；`src/` `bin/` `package.json` `files`/`exports`/`.gitignore` 一字未动；**EN 与 CN 同一 PR**。

## 1. 提交序列（按章节切，每枚自洽）

| 提交 | 内容 | 该枚 commit 上 `check:docs` |
|---|---|---|
| `12f66cb` | 章节一：契约「观察者回调抛错 / 重试预算 / 配置解析 / 运行快照与工具 replay / 压缩预算」各节，EN+CN 各 27 处区间删除；`BARE_LINE_REF_BASELINE` 232 → **178** | `check:docs` exit 0（实测 178 == 基线 178）|
| `7d103f1` | 章节二：终止裁决决策表（#170）+ 核验状态与退出码 + 机制优先级与互斥关系，EN+CN 各 18 处区间删除；基线 178 → **144** | `check:docs` exit 0（实测 144 == 基线 144）|
| `1d4580d` | AGENTS 中英声称值同步 144 + 自测下限期望改成从常量推导 | `check:docs` / `--strict` exit 0、`docs-anchor-ratchet` 6/6 |
| `cad85df` | 本报告 + `CHANGELOG.md` `[Unreleased] ### Chore` | exit 0（首跑曾红在 `archive-refs`：报告自己写了 `docs/tasks/active/…` 那条本机归档路径而没就地声明，改写后绿）|
| `bf7e48e` | **补正**：调用树图里 `reportObserverError` 的区间 `763-783` → **`889-896`**（763-783 那段其实是 `runLoopState` 字面量）；§3 保留清单改成逐条现算的 **16 条** | 全量门禁见 §6 |

每枚 commit 都是「文档 + 棘轮常量」同时落，**逐枚实跑 `check:docs` 均 exit 0**。
⚠ 但「AGENTS 声称值 == 脚本常量」那条钉子住在 `npm test`（`test/docs-anchor-ratchet.test.js`）而不是
`check:docs`，它要到 `1d4580d` 才绿：`12f66cb` / `7d103f1` 单拿出去跑 `npm test` 会在那一条上红
（其余 1667 条全绿）。全量 `npm test` fail=0 的是 `cad85df` 之后的树。

## 2. 结局 (a) 用掉的次数：改了多少条

| 文档 | 改前 orchestrator 唯一区间 | 改后 | Δ |
|---|---|---|---|
| `docs/host-consumer-contract.md` | 60 | 16 | −44 |
| `docs/host-consumer-contract_cn.md` | 60 | 16 | −44 |
| 合计（棘轮口径的唯一 (文档,目标,区间) 三元组） | 120 | 32 | **−88** |

orchestrator 族**区间条目本身**（不区分文档）：62 种 → **16 种**。写法一律从 `` `path:N-M` `` 变成
`` `符号名` at `path` ``（EN）/ `` `符号名`，`path` ``（CN）：能定到真名的把真名写进句子，
定不到真名的（纯叙述位置）只留 `` `path` ``。
**条目级改动次数**：EN 与 CN 各 **45 处**（章节一 27 + 章节二 18，成对同时改）；上表的 −44 是**唯一区间数**
（同一条区间在一份文档里出现两次只算一次，例如 `1055-1113` 同段被 `aborted` 与 `failed` 两行引用）。
写进句子的真名（全部经 `symbolTruthPositions` 复算，
命中该文件里的真声明处或具名字面量）：`runToolLoop` `resolvedModelConfig` `hasExplicitModelConfigOverride`
`partialPersistenceConfig` `persistenceMode` `hasReplayDeclarations` `runStateAvailability`
`reportObserverError` `notifyModelMetadataMissing` `persist` `emitRunOutcome` `markRunState`
`finalPersistence` `termination` `wrapupEnabled` `errorHashes` `messageRounds` `completionSignals`
`maxNoToolRounds` `forcedFinal` `roundEventDeltas` `stateAvailability` `guardedMessages`
`compactionStat` `isLowBudget` `isEndTurn` `budgetRounds` `continuationExhausted` `judge_done`。

## 3. 保留区间清单（**16 条**，主 agent 逐条复算用）

保留 = 条目讲的是**范围 / 数据流 / 调用点集合 / 范围性负事实**，行号是信息本体（工单 §2 结局 b）。
EN 与 CN 是同一批条目（同一目标 + 同一区间），下表只列一次；`真值位` 全部用
`scripts/docs-drift-check.mjs` 里那套提取器（`symbolDeclarations` + `valueLiterals`）从
`src/loop/orchestrator.js` 现算，不是抄文档。

| # | 区间 | 区间内的真值位（现算） | 保留理由 |
|---|---|---|---|
| 1 | `:872-888` | `port`@872 / `operation`@873 / `phase`@876 / `sideEffect`@878 / `error`@879 / `fatal`@880（对象键）| 「每次 store 调用 `retryAttempts + 1` 次写入」的**持久化重试循环体**，条目在数循环而不是问某个符号在哪 |
| 2 | `:889-896` | `reportObserverError`@889（binding）/ `channel`@890 / `detail`@895 | 观察者抛错包络的定义体。**本刀改正**：调用树图原先指 `:763-783`，那段其实是 `runLoopState` 的字面量（`currentTerminationReason` 等），真定义在 889 |
| 3 | `:913-966` | `notifyCapabilitySkipped`@913 / `notifyModelMetadataMissing`@942（binding），字面量 `model_metadata_missing`@951/963、`persistence_capability_degraded`@922/930 | 条目讲启动诊断这一族通知**在哪个函数里发出**、payload 的 `type` 从哪来；符号锚点自带区间，`symbol-anchor-span` 已判相交 |
| 4 | `:1055-1113` | `fail`@1055（binding）、`aborted`@1058/1072/1079、`persistence_failed`@1082、`failed`@1058/1081 | `aborted` 与 `failed` 两行**共用同一段真身**：分类 → 载荷标注 → 抛出，跨函数数据流；两处引用同一区间，只算一个唯一键 |
| 5 | `:1077-1082` | `persistenceFailure`@1077 / `reason`@1078（binding），`persistence_failed`@1082 | `persistence_failed` 的选取条件（错误里带 persistence 信息），条目在讲分支判据 |
| 6 | `:1090-1095` | `if`@1090、`operation`@1092 / `phase`@1093 / `sideEffect`@1094（对象键）| 「哪几类 stop reason 被标成有副作用」的数据流；`sideEffect` 锚点自带区间，已过相交判据 |
| 7 | `:1650-1652` | `verification`@1650（binding）、字面量 `no_final_guard`@1651、`skipped`@1651 | 弱档：条目要的是这个 reason 在 guard 判定的哪一行被写出（`skipped` 那一格）|
| 8 | `:1877-1889` | `layers`@1877（binding）| 「provider 工具表由几层装配而成」是**调用点集合**，条目正文明确写了「the **current** `tools` array」 |
| 9 | `:2678-2692` | `if`@2680、`compactionStat`@2691 | 「相同 tool-call 签名落在检测窗口内」是**窗口范围**事实 |
| 10 | `:2729-2736` | `semantic`@2733 / `inject`@2734（对象键）| stall 连击计数的累计点，条目在讲累计而非单行 |
| 11 | `:3118-3140` | `shouldContinue`@3118（binding）、`end_turn`@3131 | 「一轮里谁有权威、修订重试如何有界」的整块判据（机制优先级第 4 条引用它）|
| 12 | `:3121-3125` | `completionSignalDetected`@3121（binding）| 复述检测顺序/条件（wrapup 信封 / `completion.signals` 文本 / LLM 归一化三路）；符号锚点自带区间 |
| 13 | `:3192-3195` | `noToolRound`@3192（binding）| 该标志的置位条件（`completion:false` 令其恒假 → `no_tool` **不可达**，范围性负事实）|
| 14 | `:3318-3326` | 字面量 `judge_done`@3324、`kind`@3323 / `value`@3324 / `truncated`@3325 | 弱档：round judge 判 `done:true` 的落点（机制优先级第 1 条）|
| 15 | `:3490-3503` | `status`@3493 / `reason`@3494 / `detail`@3495、`final_guard_unverified`@3503、`non_continuable`@3494 | `final_guard_unverified` 的产出分支体，条目在讲「哪些 stop 落到这一支」|
| 16 | `:3492-3496` | `unverified`@3493 / `non_continuable`@3494 | `verification.status = unverified` 的 reason 来源（`non_continuable` 锚点自带区间）|

**没有删过一枚符号锚点**：符号锚点组数 **24 → 24**（`SYMBOL_ANCHOR_MIN_UNIQUE` 的下限没碰），
带区间的符号锚点仍是 30 处、`symbol-anchor-span` 的「**不相交 0 处**」保持不变——
上面 3/6/7/12/13/14/16 这 7 条就是锚点自带区间的那批，全部与真值位相交。

## 4. 判据原文（C1 / C2 / C3）

```
symbol-anchor-span: 覆盖面 44 处符号锚点里自带区间 30 处：相交 30 处 / 不相交 0 处（另 0 处抽不到真值位，同处已由 symbol-anchor 报红）；不带区间的 14 处本判据不适用
symbol-anchor: 覆盖面 20 份文档里「符号 + 文件」锚点 44 处（唯一 (符号, 文件) 24 组：…）
bare-lines: 覆盖面 20 份文档里裸行号引用 181 次出现 / 唯一 (文档,目标文件,行区间) 148 处，其中声明式豁免 4 处（4 条条目）⇒ 棘轮口径实测 **144** vs 基线 144
```

C2（`grep -c 'orchestrator\.js:[0-9]'`）：

| 文档 | 改前 | 改后 | Δ |
|---|---|---|---|
| `docs/host-consumer-contract.md` | 56 | 22 | −34 |
| `docs/host-consumer-contract_cn.md` | 57 | 23 | −34 |

**C1 −88 与 C2 −68 为什么不等**（口径差，与 T-b1a 同形）：C2 数的是「含至少一处 orchestrator 行号的**行**」，
且只看两份契约；C1 数的是「唯一 (文档, 目标文件, 行区间) 三元组」。本轮两处放大 C2 的口径损失：
① 一枚表行里常带 2–4 个 orchestrator 区间，全部删完后该行才从 C2 里消失（决策表 10 行 × 2 文档一次掉 1）；
② 有 4 个唯一区间删完后仍留在同一行（同行还留着别的目标文件的区间）。另有 2 个唯一键是
**同一段真身被两处引用共用**（`1055-1113` 同时是 `aborted` 与 `failed` 的落点），保留即两个口径都不掉。
逐条对账：C1 −88 = 22 种区间 × 中英两份；其中 17 种是「区间消失 + 符号名进句子」（C2 该行随之消失或保留），
5 种是原本就与别的引用同处一行。

## 5. `--self-test` 红集合（C3）：与基点**逐字同一集合**，本刀不新增红

```
  ✗ 分类真的读 .gitignore：把 docs/tasks/ 从 .gitignore 里去掉 → 本机档案登记与放行全部失效
  ✗ 白名单条目变空转：两处引用（examples README 与 CHANGELOG 的同名提及）全改掉 → 该登记被判失效
  ✗ #278-P2 改坏**已登记**的裸名（`repro-circular-details.mjs` 多个 Q）→ 红
  ✗ #278-P3 改坏**未登记**的裸名（`e2e-wake.mjs` 多个 Q）→ 红
  ✗ 登记表反向校扩到裸名（#278 第 4 件）：本仓文档里已没人引用已登记的裸名 → 销账红
  ✗ #279 提一句不许抢枪：CHANGELOG 靠前散文先提一句已登记的裸名 → 销账红必须照样在
docs-drift-check --self-test: 失败 — 6/96 例未达预期
```

⚠ **与工单说的「3 条」不一致，但不是本刀造成的**：同一命令在基点 `f15cd07` 的干净工作树里跑出来
**就是这 6 条**（对照用 `git worktree add /tmp/t286-base f15cd07` 实测），两侧红集合 diff 为空。
多出的三条（`白名单条目变空转`、`登记表反向校扩到裸名`、`#279 提一句不许抢枪`）与 tb1a §5 那三条
同一条根：用例期望的提示句里的 `docs/tasks/active/261010-13-erix-run-async/` 是**本机任务归档目录**
（`docs/tasks/` 整目录不入库，干净克隆里根本没这些文件），用例要本机真有那批归档实物才能拼出
「↳ 它跟本仓实物只差一点」那句提示，而这个 worktree 的 `docs/tasks/` 里只有本刀的工单文件——
**干净检出 / CI 上就是这个形态**。工单口径的「3 条」是 T-b1a 那台机器的本机形态。

本刀**修掉**了唯一一条因本轮改动而多的红：`#286 棘轮下限` 那条反向证把「实测 **232** / 基线 **231** /
把基线改成 232」写死在期望里，基线一降它就报「红了但没点该点的名」。改成从常量推导
（`ratchetOverBaseline(BARE_LINE_REF_BASELINE, BARE_LINE_REF_BASELINE - 1)`，同一份文件里现成的那个 helper，
3585 / 3611 / 3617 三处本来就在用它）——**这是本刀唯一动 `scripts/` 的必要性改动**，
锁本身没放宽：把 144 改成 143 依然红，且红话里点的就是新数。

## 6. 门禁逐项（跑前一律 `find src -name '*.d.ts' -delete`）

| 门禁 | 退出码 | 实测 |
|---|---|---|
| `npm test` | **0** | `# tests 1668 / pass 1661 / fail 0 / skipped 7`（工单基线 1668/1661/0/7，**逐字相同**）|
| `check:syntax` | 0 | 全量跟踪文件 `node --check` |
| `check:docs` | 0 | 64 项对齐（章节一/二各自单独 checkout 时也各跑过一次，均 exit 0）|
| `check:docs:strict` | 0 | 中英骨架对齐（EN/CN 同一条目同刀改，没有单边）|
| `check:docs-examples` | 0 | |
| `check:pack-links` | 0 | 打包 Markdown 链接 |
| `check:tests` | 0 | |
| `check:types` | 0 | **实测 119 个 `--checkJs` 错误 / 29 个文件 == 基线 119**（一字未动）|
| `check:types -- --with-tools` | 0 | **162 / 31 == 基线 162**（一字未动）|
| `check:cli-real` | 0 | `SKIP`（`ERIX_E2E_REAL` 未设的默认口径）|
| `test/docs-anchor-ratchet.test.js` | 0 | 6/6（含「脚本常量 == AGENTS 中英声称值」与「不相交 == 0 且 自带区间 == 相交 + 不相交」两条钉子）|

## 7. 复现命令

```bash
find src -name '*.d.ts' -delete
node scripts/docs-drift-check.mjs --verbose | grep -oE "(symbol-anchor-span|symbol-anchor|bare-lines): .*"
node scripts/docs-drift-check.mjs --self-test          # 6/96，与基点 f15cd07 同一集合
for d in docs/host-consumer-contract.md docs/host-consumer-contract_cn.md; do grep -c 'orchestrator\.js:[0-9]' $d; done   # 22 / 23
git diff f15cd07 --stat
```

## 8. 遗留 / 交给下一刀

1. **T-b2 的存量**（本刀一字未动）：`src/loop/termination.js` 20、`src/loop/provider-runner.js` 19、
   `src/reflection/governor.js` 18、`src/providers/errors.js` 6、`src/providers/openai.js` 6、
   `run-snapshot-executor.js` / `skills/loader.js` / `anthropic.js` 各 4——棘轮存量已从 232 降到 **144**，
   其中 orchestrator 族只剩 32 个唯一区间（保留清单 §3）。
2. 保留的 8 条**范围性事实**只有 orchestrator 族里「自带区间的那 7 条」被 `symbol-anchor-span` 真正核对过；
   另外 8 条是**裸区间**（没有符号紧邻），新判据接不到它们——它们只过越界校。
   要把它们也纳入事实校，就得按 T-b1a §9.2 说的建「区间 ↔ 事实」对账语义（T-c 量级），
   或者把它们改写成 `` `符号`（`path:区间`） `` 的锚点形状（小改，但要先确认符号名真的对得上）。
3. 本刀没动 `test/`：`test/docs-anchor-ratchet.test.js` 里没有写死 232 的断言（tb1a 已改成从常量推导），
   所以本轮只改了脚本自测里那一处写死的期望。
4. CI（node 22/24）交给 PR 自己跑，本报告不等。
