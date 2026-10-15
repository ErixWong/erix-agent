# 261016-286-tb1a 交付报告 — issue #286 T-b 第一刀 · 前半（判据 + 契约错位清零）

- 分支 `feat-261016-02-286-tb1a`，基线 `main` = `ec3728f`。
- 完整 diff：`git diff main > /tmp/286-tb1a-final.diff`（**918 行 / 8 个文件 / +442 −89**：`scripts/docs-drift-check.mjs` `docs/host-consumer-contract.md` `docs/host-consumer-contract_cn.md` `test/docs-anchor-ratchet.test.js` `AGENTS.md` `AGENTS_cn.md` `CHANGELOG.md`，以及本报告自己）。
- 版本仍 `0.20.0`；`src/` `bin/` `package.json` `files`/`exports`/`.gitignore` 一字未动。

## 1. 提交序列

| 提交 | 内容 |
|---|---|
| `f33d2e0` | 新判据 `symbol-anchor-span`（脚本头部清单里的 **2.8.1b**）+ 配套提取器扩展（`declsAll` / `literalLines`）|
| `56ac016` | 契约 EN/CN 的 `src/loop/orchestrator.js` 锚点族错位清零（同一个 PR，中英成对）|
| `20e1de7` | 四条 `--self-test` 反向证 + 棘轮期望改成从常量推导 + `test/docs-anchor-ratchet.test.js` 新钉子 + AGENTS 中英补 `symbol-anchor-span` |
| `f4968fc` | `CHANGELOG.md` `[Unreleased] ### Chore` 条目 |

## 2. 新判据（2.8.1b `symbol-anchor-span`）的规格

符号锚点**自带行号区间**时（`` `sym`（`path:1517-1531`） ``），区间必须与该符号在被引文件里的**真值位相交**（`lo <= p <= hi`）。逐处判，不是抽样。

- **真值位** = 该名字的**全部**声明处（不只首处；`sideEffect` 在持久化归一化与 `fail()` 里各合法出现一次，两处都算）＋ 在 `SYMBOL_VALUE_MEMBERSHIP` 点名的 4 份文件里、该**具名字面量**的出现行（弱档，范围与 `symbol-anchor` 同一套，不额外扩面）。
- 抽不到真值位 → **红**（#164 口径：抽不到真值不许静默放行）。
- 被引文件读不到 → 本判据**不适用**（存在性/越界由 `paths` 报，同一处不报两次）。
- 不带区间的锚点 → 本判据不适用（这正是「删区间」是合法修法、且会让下面那道棘轮合法下降的原因）。
- 病根：`paths` 在解析引用前把 `:1234` 剥掉 ⇒ 「符号对、行号错」以前全绿。

## 3. 门禁逐项（跑前一律 `find src -name '*.d.ts' -delete`）

| 门禁 | 退出码 | 备注 |
|---|---|---|
| `npm test` | **0** | `# tests 1668 / pass 1661 / fail 0 / skipped 7`（基线 1667/1660/0/7，**+1** 全部来自 `test/docs-anchor-ratchet.test.js` 新增的那条新判据钉子）|
| `check:syntax` | 0 | 全量 259 个跟踪文件 |
| `check:docs` | 0 | 中英契约 70 节对齐 |
| `check:docs:strict` | 0 | 64 项对齐 |
| `check:docs-examples` | 0 | |
| `check:pack-links` | 0 | 17 份打包 Markdown |
| `check:tests` | 0 | 145 个测试文件 |
| `check:types` | 0 | **119** / 29 文件（未动）|
| `check:types -- --with-tools` | 0 | **162** / 31 文件（未动）|
| `check:cli-real` | 0 | `SKIP`（`ERIX_E2E_REAL` 未设，默认口径）|

⚠ 环境注记：这个 worktree 起跑时没装 devDependency（`typescript` 缺失 ⇒ `check:pack-links` 首跑 exit 1，因为它 `npm pack` 会触发 `prepack → check:types-build`）。`npm install --include=dev` 之后 exit 0。**与本轮改动无关**，但换机器复现要记得装 dev 依赖。

## 4. 三常量自洽（`--verbose` 原文）

```
symbol-anchor-span: 覆盖面 44 处符号锚点里自带区间 30 处：相交 30 处 / 不相交 0 处（另 0 处抽不到真值位，同处已由 symbol-anchor 报红）；不带区间的 14 处本判据不适用
symbol-anchor: 覆盖面 20 份文档里「符号 + 文件」锚点 44 处（唯一 (符号, 文件) 24 组：docs/host-consumer-contract.md 22、docs/host-consumer-contract_cn.md 20、docs/host-upgrade-guide-0.19.0.md 1、docs/host-upgrade-guide-0.19.0_cn.md 1）；其中「具名字面量成员」一档 8 组…抽不到真值 0 组
bare-lines: 覆盖面 20 份文档里裸行号引用 271 次出现 / 唯一 (文档,目标文件,行区间) 236 处，其中声明式豁免 4 处（4 条条目）⇒ 棘轮口径实测 **232** vs 基线 232
```

- `BARE_LINE_REF_BASELINE = 232` == 实测 232 ✅（`--verbose` 不再打「请把基线降下来」）
- `SYMBOL_ANCHOR_MIN_UNIQUE = 24` == 实测 24 组 ✅（只增不减，本轮没掉）
- `REF_SCAN_DOCS_MINIMUM = 20` == 覆盖面 20 份 ✅
- `symbol-anchor-span` 的「不相交 **0** 处」✅，且 `自带区间 30 == 相交 30 + 不相交 0`（测试侧钉的就是这个等式，防「抽样冒充逐处」）

## 5. `--self-test` 最终红集合（原文）

```
  ✗ 分类真的读 .gitignore：把 docs/tasks/ 从 .gitignore 里去掉 → 本机档案登记与放行全部失效：红了，但错误信息没点该点的名／没覆盖该覆盖的文件（未命中 /登记为本机档案.*但 \.gitignore 并不忽略/）
  ✗ #278-P2 改坏**已登记**的裸名（`repro-circular-details.mjs` 多个 Q）→ 红（修前 exit 0：脱离登记就静默放行）：红了，但错误信息没点该点的名／没覆盖该覆盖的文件（未命中 /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/repro-circular-details\.mjs/）
  ✗ #278-P3 改坏**未登记**的裸名（`e2e-wake.mjs` 多个 Q）→ 红（修前 exit 0：它本来连被检资格都没有）：红了，但错误信息没点该点的名／没覆盖该覆盖的文件（未命中 /↳ 它跟本仓实物只差一点：docs\/tasks\/active\/261010-13-erix-run-async\/e2e-wake\.mjs（比实物名字干多写了 “Q”）/）
docs-drift-check --self-test: 失败 — 3/96 例未达预期
```

**就是工单点名的那 3 条**（`#280 .gitignore`、`#278-P2`、`#278-P3`），93 例通过。三条都要求本机存在 `docs/tasks/active/261010-13-erix-run-async/` 的档案实物才能拼出「↳ 它跟本仓实物只差一点」那句提示；这个 worktree 里没有该目录（`docs/tasks/` 整目录不入库），所以期望落空 ⇒ 与本轮改动无关。

本轮新增的 4 条反向证（全通过，一条都没靠删用例或放宽判据变绿）：

```
✓ 改窄区间：`terminationReasonForAction`（termination.js:93-100）→ :94-100 ⇒ 声明在 93，红
✓ 区间整段挪走：`defaultSleep`（abort.js:16）→ :30（不越界、符号也在）⇒ 只有相交这条红
✓ 删掉区间：`no_final_guard`（orchestrator.js:1650-1652）→ 不带区间 ⇒ 本判据不适用，0 错（放行证）
✓ 弱档真值位：`judge_done`（orchestrator.js:3318-3326）→ :3318-3323 ⇒ 字面量在 3324，红
```

顺带修掉变异器自身一处坏掉（`mutateSymbolAnchorSpan` 多补一个反引号 ⇒ 变异结果里锚点整条解体，那一例报的是「符号下限 24→23」而不是本判据的红）。#279 口径下它本来就红，但报错报错对象会让人误判成「锚点在退化」，所以修的是变异器，不是期望。

`test/docs-anchor-ratchet.test.js`：基线断言从 `== 244` 改成 `<= 244`（棘轮只能降），并新增一条钉子——`不相交 == 0` **且** `自带区间数 == 相交 + 不相交`。6/6 pass。

## 6. C2 前后对账（`grep -c 'orchestrator\.js:[0-9]'`，主 agent 复测）

| 文档 | main | 本轮 | Δ |
|---|---|---|---|
| `docs/host-consumer-contract.md` | 58 | **56** | −2 |
| `docs/host-consumer-contract_cn.md` | 59 | **57** | −2 |

**为什么 −4 而不是 −12**（C1 基线降幅）：两个数不同径。C2 数的是**含至少一处 `orchestrator.js:<数字>` 的行**，且只看 orchestrator；C1 数的是**唯一 (文档, 目标文件, 行区间) 三元组**，覆盖 20 份文档与所有 `src/**.js`。逐条对账（每份文档）：

- 删区间造成的唯一键消失：`orchestrator.js:1517-1531`（`emitEvent`）、`1544-1557`（`emitJudge`）、`2739-2740`（`shouldContinue`）= 3 个；这 3 行里有两行（EN:1132 / CN:922 那一类）同处还有别的 orchestrator 引用，所以行没消失 ⇒ C2 只 −2（EN:99/100、CN:83/84 那两行整行不再带行号）。
- 另有 1 个唯一键是 `provider-runner.js:96-110`（`dispatchAttemptEvent`）删掉的 ⇒ C2 根本不看它。
- 还有 2 个唯一键是**合并**：`2739-2745` / `2742-2745` / `2743-2745` 三种写法指的其实是同一段真身 `completionSignalDetected` 的声明处 `3121-3125`，三条并一条 ⇒ −2。
- 其余 17 处是**改正**（旧键消失 + 新键出现，唯一键数不变），行仍然带行号 ⇒ C2 不变。
- 合计每份文档 −6，两份 **−12** ✅ = 基线 244 → 232。逐条理由也写在 `BARE_LINE_REF_BASELINE` 的注释里。

## 7. 保留区间的条目清单（主 agent 说要逐条抽核；`真值位` 列由判据自己算，可复算）

保留 = 条目本身在讲**范围 / 数据流 / 调用点**，行号是信息而不是负债。EN 与 CN 是同一批条目（同一目标 + 同一区间），下表只列一次；`未动` 表示本轮范围外（非 orchestrator 族）且已在新判据下为绿。

| 条目符号 | 目标:区间 | 真值形态 | 真值位 | 一句话理由 |
|---|---|---|---|---|
| `notifyModelMetadataMissing` | `src/loop/orchestrator.js:913-966` | binding | 942 | 条目讲的是启动诊断这一族通知**在哪个函数里发出**，区间是那段发信体 |
| `ERIX_RETRY_ATTEMPTS` | `bin/cli.js:841-848` | 环境变量读取处 | 843 | 条目复述「读数 + clamp 到区间」的事实，区间就是那 8 行 clamp |
| `exitCodeForVerification` | `bin/cli.js:1053-1060` | function | 1053 | 条目复述 verification → 退出码的**映射表**，映射整体在这 8 行 |
| `terminationReasonForAction` | `src/loop/termination.js:93-100` | function | 93 | 条目讲的是 action → reason 的映射范围，不是「符号在哪」 |
| `errorReason` | `src/loop/termination.js:173-176` | binding | 173 | 条目说 `timeout` 与 `error` 两条都由它决出，区间覆盖两个分支 |
| `completionSignalDetected` | `src/loop/orchestrator.js:3121-3125` | binding | 3121 | 条目复述检测顺序/条件（原来此处有三种漂移写法，已并成一条）|
| `noToolRound` | `src/loop/orchestrator.js:3192-3195` | binding | 3192 | 条目讲该标志的置位条件，就是这四行 if 体 |
| `sideEffect` | `src/loop/orchestrator.js:1090-1095` | 对象键/类字段 | 194 / 878 / 980 / 1094 | 条目讲「哪几类 stop reason 被标成有副作用」的数据流，取这一处出现 |
| `no_final_guard` | `src/loop/orchestrator.js:1650-1652` | 具名字面量成员 | 1651 | 弱档：条目要的是「这个 reason 在 guard 判定的哪一行被写出」 |
| `non_continuable` | `src/loop/orchestrator.js:3492-3496` | 具名字面量成员 | 3494 … | 同上：该 reason 的分支体 |
| `judge_done` | `src/loop/orchestrator.js:3318-3326` | 具名字面量成员 | 3324（另有 283/449/3298）| 弱档：条目讲 round judge 判 `done:true` 的落点 |
| `max_rounds_cap` | `src/loop/termination.js:93-98` | 具名字面量成员 | 98（另有 8/18/24…）| 条目指 reason 映射表里的那一支（原来指 `:95`，落在 93-98 内）|
| `completion` | `src/reflection/governor.js:108-110` | 具名字面量成员 | 109 / 140 | stop 种类 ↔ 产生位置 的对照表，行号是事实本体 |
| `complete` | `src/reflection/governor.js:123-125` | 具名字面量成员 | 125 | 同上 |
| `noTool` | `src/reflection/governor.js:111-114` | 具名字面量成员 | 113 / 118 | 同上 |
| `defaultSleep` | `src/loop/abort.js:16` | function | 16 | `未动`（单行且正是声明行；本轮拿它当「挪走就红」的靶子）|
| `provider_config` | `src/providers/errors.js:37-51` | 具名字面量成员 | 45 | `未动`（provider 族属 T-b1b）|

**删掉区间的 4 条**（事实只是「这个符号在这个文件里」，行号纯属负债；中英两侧同时删）：`emitEvent`（原 `orchestrator.js:1517-1531`）、`emitJudge`（原 `1544-1557`）、`shouldContinue`（原 `2739-2740`）、`dispatchAttemptEvent`（原 `provider-runner.js:96-110`）。

**改写符号名 1 条**：`error`（`src/loop/termination.js:173-176`）原先符号名指向的是一个**值**而不是声明（该文件里没有叫 `error` 的声明 ⇒ 本来就抽不到真值），改写成真正的 `errorReason`，并在中英两侧把句子写成「`timeout` 与 `error` 都由 `errorReason` 决出」。⚠ 这里踩过一次：CN 侧最初写成「…由 `errorReason` 决出（`path`）」，`（` 紧跟的是散文而不是符号 ⇒ 锚点整条消失、符号组数 24→23。锚点要求符号与括号**紧邻**。

## 8. 复现命令

```bash
find src -name '*.d.ts' -delete
node scripts/docs-drift-check.mjs --verbose | grep -oE "(symbol-anchor-span|symbol-anchor|bare-lines): .*"
node scripts/docs-drift-check.mjs --self-test          # 期望：3/96，且就是 §5 那三条
for d in docs/host-consumer-contract.md docs/host-consumer-contract_cn.md; do grep -c 'orchestrator\.js:[0-9]' $d; done
git diff main > /tmp/286-tb1a-final.diff
```

## 9. 遗留 / 交给下一刀

1. **orchestrator 族剩余部分留给 T-b1b**（本轮按工单只做前半）。剩余存量 **232** 处唯一区间，其中契约 EN 117 / CN 116 是主体。
2. 新判据目前只覆盖**符号锚点自带区间**；「裸区间指向哪一段真身」仍只有越界校 + 棘轮，没有事实校——那是 T-c 的量级（要建「区间 ↔ 事实」的对账语义，不是加一条正则）。
3. 弱档（具名字面量成员）真值位取的是「该字面量在点名文件里的出现行」，同一名字多处出现时**任一**出现行落入区间即放行（`judge_done` 有 4 处）。这是有意的（避免把文档逼到只能引用第一处），但意味着弱档的区间约束比强档松一档——`--verbose` 的分档计数把它单独打出来了，将来要收紧就在 `symbolTruthPositions` 一处改。
4. 本机档案相关的 3 条 `--self-test` 红在全新 clone / CI 上的形态与本机不同（那里没有 `docs/tasks/`），主 agent 若要拿 CI 的红集合当基线，需要单独确认一次。
5. PR 上 CI（node 22/24 矩阵）已交给它跑，本报告不等它跑完。
