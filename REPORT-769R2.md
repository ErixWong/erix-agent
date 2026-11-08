# #769 R2 收口报告（只清坐标/锚点类红，不改设计）

分支 `fix-261108-24-ledger-recovery-rows-r2-erix`，起点 HEAD `4070ff0`（已 rebase 到 `origin/main = e1bd9cf`）。
本段三笔：`ccb95f5`（报告骨架）→ `28bf279`（#271 容量角色 + #417 strict 类型）→ `84e6bf6`（契约钉子 + 变异表行号）。

## 取证边界

- 工作树：只写 `/home/eric/wt-769e2`。`/home/eric/wt-769e`（上一段树）、`/home/eric/wt-769w`（对照）、`/home/eric/projects/erix-llm-kit`、`/home/eric/wt-75*`/`76*`/`77*` 全程未写。
- 只读对照：为了把「主干现测」和「本树现测」分开，临时挂了 `git worktree add --detach /tmp/main-base-check e1bd9cf`（node_modules 是软链到本树），只用它跑 `check:types:strict` 与 tsc 对照；**收尾会 `git worktree remove`**（见「未验证」最后一条）。
- 本段改动面：测试里的记录值/期望值（`test/tools/file-tools.test.js`）、`src/tools/file-tools.js` 的两处**同位数**数字与其历史注、`src/store/file.js` / `src/store/memory.js` / `src/loop/resume-manager.js` 的 **JSDoc 类型**（三处都刻意**行数中性**）、`scripts/retired-spelling-scan.mjs` 的两枚契约钉子、`test/mutation-samples.md` 的 `--sync` 派生列。**没有**动：`persist("appendRecoveryRow")` 的可选能力通道、store 三方法语义、`src/store/recovery-rows.js` 的行形状、任何谓词/判据常量（±2%、±1%、`CJK_DENSE_SAMPLE_FLOOR`、`LEGACY_*`、两档 strict 基线、`BARE_LINE_REF_BASELINE`、`test/test-suite-baseline.json` 全部一字未动）。
- 为什么坚持「行数中性」：两轴表在 `docs/host-consumer-contract*.md` 里引用的是 `src/loop/resume-manager.js:<行号>` 这类**裸行号**（两份契约共 42 处引用，其中 30 处行号 > 439），`scripts/cell-axes-anchors.mjs` 的锚点是**文本锚**、行号在检查时重算 ⇒ 只要我在 resume-manager 里加一行，上一笔 `4070ff0` 刚对完的整批引用就要重刷。实测确认过：先按常规写法加 5 行 ⇒ G4 / G4-R1 / R3 / R4 / R5 / R6 / G6 **七条当场复红**；改成行数中性后这七条回到绿，且没碰任何引用。
- 判据来源：下面每个数字都指回一条我真跑过的命令（日志留在 `/tmp/r2-full-3.log`、`/tmp/dd-v.log`、`/tmp/nt769e2.log` 是主会话给的上一段日志）。闸的判定只认退出码 + 点名到具体断言。

## 逐条诊断与处置（11 条）

先说一件事：**主会话给的 11 条不是本树当前的红集。** `/tmp/nt769e2.log` 里 11 条 `location:` 的绝对路径全部是 `/home/eric/wt-769e/...`（上一段树、`4070ff0` **之前**的状态）。本树在起点 `4070ff0` 现测 `npm test` = `tests 3725 / pass 3708 / fail 4`（`/tmp/r2-full-1.log`），4 条红是：`test/tools/file-tools.test.js:898`、`:953`、`test/type-check-strict-ratchet.test.js:214`、`:249`。所以：清单 11 条 = 7 条已在前一笔提交里绿 + 1 条（file-tools）本树仍红 + 3 条本树新面（清单里没有）。逐条如下。

1. **`contract-snapshot-cell-axes-767.test.js:734`（G4 两轴引用必须等于锚点重算行号）** — 为什么红（当时）：`5b57219` 新增恢复行三面后，两轴表里的 `file:line` 引用没跟着锚点重算。**本树处置：无**。证据：起点树上单跑该文件 + 四个原红文件合跑 `92 tests / 90 pass / 2 fail`（2 条都是 file-tools）⇒ G4 已绿；本段修 `#417` 时刻意保持三个 src 文件行数不变（`git show HEAD:<f> | wc -l` vs `wc -l < <f>`：memory 196/196、file 636/636、resume-manager 907/907），修完再跑该文件仍绿。
2. **`:792` G4-R1 反向证（写点被换成同键名注释行 ⇒ 必红）** — 同上：判据本身没动，起点树已绿；本段没放宽任何期望（该族在本树最终全绿，见「闸」）。
3. **`:869` G4-R3 反向证（多一条没登记的引用 / 少一条已登记的引用 ⇒ 必红并点名）** — 同 1/2。
4. **`:889` G4-R4 反向证（锚点「种类」硬判据 code↔comment 互指必红）** — 同 1/2。
5. **`:976` G4-R5 反向证（成对删登记条目与两份表引用 ⇒ 覆盖面真值必红）** — 同 1/2；`4070ff0` 那一笔已把它引用的 victims 行号跟锚点重算过一次。
6. **`:1075` G4-R6 特征用例（锚点改成同键名另一处真写点）** — 同 1/2。
7. **`:1109` G6（被引为读点的恢复侧行号必须是剥完源码真存在的读点）** — 同 1；`scripts/cell-axes-anchors.mjs:96-98/152-154` 里那三条 `kind:"comment"` 锚点指 `src/store/recovery-rows.js` 的格名注释，本段没动那个文件，所以读轴对账一字未改。
   > 这 7 条我**没有**用「改判据让它绿」的手法：起点树已绿，我做的事是**保证自己不再把它弄红**（上面那行「当场复红七条 → 改行数中性 → 回绿」就是证据）。
8. **`test/docs-anchor-ratchet.test.js:138`（#286 T-b1a 符号锚点区间与声明处相交，note 必须「不相交 0 处」）** 与 9. **`:148`（棘轮实测恰好等于基线）** — 本树已绿，但我按工单要求**用 `node scripts/docs-drift-check.mjs --verbose` 的真输出复核过**（exit 0，`/tmp/dd-v.log`）：
   - `symbol-anchor-span: 覆盖面 805 处符号锚点里自带区间 5 处：相交 5 处 / 不相交 0 处`（`5 = 5 + 0` ⇒ 逐处过问，不是抽样）；
   - `bare-lines: … ⇒ 棘轮口径实测 **6** vs 基线 6` ⇒ **基线常数不用改**：`BARE_LINE_REF_BASELINE` 仍是 **6**（`scripts/docs-drift-check.mjs:2747`）。为什么没涨：上一段 `4070ff0` 已把新增引用放进 `scripts/cell-axes-anchors.mjs` 的**标记区定点豁免**（该 note 自己写着「锚点表 41 条 / 合格 34 组」），本段新增的两处数字改动是**同位数**、没引入新的裸行号；
   - `symbol-anchor: 覆盖面 51 份文档里「符号 + 文件」锚点 805 处（唯一 (符号, 文件) 238 组…）`。
10. **`test/tools/file-tools.test.js:904`（本树 `:898`：五个角色锚点未漂移 + 样本清单仍盘上可寻）** 与 11. **`test/version-state-probe-703.test.js:66`（探针 `--self-test` 15 例）** — 第 11 条本树已绿（起点合跑 92/90 里它不在 2 条红里；本段末再单跑 36/36 全绿，谓词一字未动）。第 10 条是真红：
    - **为什么红**：本切片给 `src/store/file.js` 加了恢复行独立通道（`recoveryRowsPath()` + 它自己那份 `recoveryDedupCaches` + `appendRecoveryRow()` / `listRecoveryRows()`），把它从 **25,021 → 27,505 字节（+9.93%）**，超 `#271` 的 ±2% 记录值容差。红话点名的是 `median` 角色的字节数那一格（其余四格当场复测过都在容差内）。
    - **处置**：按 `#271` 自己的口径复测并**只刷那一格**（`node /tmp/measure-271.mjs`，复刻 `measureReadLineCapacity`）：`median src/store/file.js` 记录值 25,021/593/42.1939/6,212/19.867% → **27,630/636/43.4434/6,034/21.314%**（最终值含我补的 `@returns` 类型那 1 行）；描述那一档同位数刷新 `median 6,212 (42.2)` → **`median 6,034 (43.4)`**，另把「this tool's own source fits」`4,678 → 4,637`（同位数 ⇒ 对模型可见面字节中性）；`self` 那格按新实测刷新（127,815/2,281/56.0346/4,678 → **130,123/2,302/56.5261/4,637/28.874%**，累计 +1.81%，离 ±2% 只剩 0.19pp）。`fewest`（`src/loop/pending-tool-result.js` 25,326/362/69.9613/3,746/38.735%）与 `most`（`src/loop/abort.js` 1,031/37/27.8649/9,407/0）当场复测**逐字等于**记录值 ⇒ 没动；`densest` 4,384（记录 4,364，+0.46%）在容差内 ⇒ 没动。角色**不换人**（先例 `#714 cdb90de` 同根因只刷实测；`#730 c83022d` 才换人），但我把两个余量当场写进注释：本文件现在在 83 个写死样本里按容量排第 **40/83**，样本中位是 **6,157**（`src/loop/error-ledger.js`）⇒「描述声称的中位行数容量」那条只剩 **0.14 个行数**的余量（|6,034 − 6,157| = 123，容差 6,157×2% = 123.14）。
12–14. **清单外的三条（本树真实红集的另一半）** — `test/tools/file-tools.test.js:953`（描述 median 档 == `src/store/file.js` 当场实测）与 `test/type-check-strict-ratchet.test.js:214` / `:249`：
    - `:953` 与第 10 条同根因（红话：`实测/基准 6061，另一次 6212，差 2.49% 超出 ±2.0%`），随第 10 条一起按实测刷新解决；没动 ±2%/±1%/±5% 任何一个容差。
    - `:214` / `:249`：**为什么红**：本切片新增代码自己带进 **5 个 strict 错**，把两档实测从主干的 `1875 / 72` 与 `2088 / 78` 顶到 `1880 / 72` 与 `2093 / 78`，越过 `BASELINE_STRICT_ROOT = 1877` / `BASELINE_STRICT_WITH_TOOLS = 2090`（红话逐字：`干净树上 --strict 必须 exit 0（等于或低于基线），实际 1：… 实测 1880 个 strict 错误 / 72 个文件` 与 `并集档实测 2093 > 基线 2090——两档要么一起降、要么都不动`）。逐条定位（同 msg 计数差 + 行号，`tsc --strict src/index.js` 在 `/tmp/main-base-check` 与本树各跑一次对账）：`src/store/file.js:491` TS2353 `appendRecoveryRow` 不在 store 工厂 `@returns` 内联类型里；`src/store/memory.js:94` 同；`src/store/memory.js:97` TS7006 `rows.find((item) => …)`（`recoveryLedger` 是无值类型的 `new Map()`）；`src/loop/resume-manager.js:440` TS2339 `Property 'role' does not exist on type 'object'`、`:441` 同 `content`（`foldLedgerMessages` 把 `message` 写成 `object`）。
      **处置**：基线**一字不抬**，改的是**新增代码自己的类型**——两份 store 工厂的 `@returns` 内联类型登记 `appendRecoveryRow: (runId:string, record:object) => Promise<boolean>` 与 `listRecoveryRows: (runId:string) => Promise<object[]>`（这是把已验收的宿主可见面写进类型，不是新语义）；`recoveryLedger` 写成 `/** @type {Map<string, object[]>} */ (new Map())`；resume-manager 那一处用**就地** `/** @type {{role?:string, content?:unknown}} */` 断言，**不改** `foldLedgerMessages` 的共享返回类型（改了会牵动别的文件的计数）。结果：两档实测回到 **1875 / 2088**，与主干同值，仍分别低于基线 2 个。

## 闸

跑闸前一律 `find src -name '*.d.ts' -delete`（`types:build` 之后没再删就跑 ratchet 会得到 `EXIT=1` 的「确需带着生成物跑」那条，我第一次就踩了）。

- `npm test` → **EXIT 0**；`# tests 3725` / `# suites 14` / `# pass 3712` / **`# fail 0`** / `# cancelled 0` / `# skipped 13` / `# todo 0`（`/tmp/r2-full-3.log`；起点同命令是 `pass 3708 / fail 4`，`/tmp/r2-full-1.log`）。
- `npm run check:test-summary -- --log /tmp/r2-full-3.log` → `TEST-SUMMARY tests=3725 pass=3712 fail=0 skipped=13 todo=0 cancelled=0` / `TEST-SUMMARY-EXPECTED tests=3717 fail=0 maxSkipped=16 registry=test/test-suite-baseline.json` / `TEST-SUMMARY-VERDICT ok` / **`TEST-SUMMARY-HINT 登记值可抬到 3725（当前登记值 3717，本次实测 3725，+8）——多出来的用例不是事故，抬登记值仍是人的动作：本脚本只提示，不改写 test/test-suite-baseline.json（没有 --sync）`**。`test/test-suite-baseline.json` 我**没动**（`git status` 里没有它）。
- 四个原红文件：`node --test test/tools/file-tools.test.js` → `64 tests / 64 pass / 0 fail`；`node --test test/type-check-strict-ratchet.test.js test/contract-snapshot-cell-axes-767.test.js test/docs-anchor-ratchet.test.js test/version-state-probe-703.test.js` → `36 tests / 36 pass / 0 fail`。
- `node --test test/static-guards.test.js` → **EXIT 0**，`58 tests / 58 pass / 0 fail`。
- `npm run check:inventory` → **EXIT 0**（`逐文件：0 处不一致`）。本段没新增测试文件，也不需 `--sync`。
- `npm run check:docs` **0** / `check:docs:strict` **0**（`docs-drift-check: OK … 126 项对齐 package.json 0.31.0 与源码`、`docs-sync-check: OK — 116 节`）/ `check:syntax` **0**（496 个跟踪文件 `node --check`）/ `check:agents-directives` **0** / `check:changelog` **0** / `check:exports` **0** / `check:host-consumers` **0**。
- `npm run check:docs-spelling`：改钉前 **EXIT 1**（`--strict: 2 处红`：`docs/host-consumer-contract.md [contract] verdict=SUSPECT(raised) pin=457 uses=458`、`docs/host-consumer-contract_cn.md … pin=571 uses=579`）→ 把两枚钉子按**扫描器现报的 uses** 登记成 458 / 579，并把逐条定位写进脚本注释（EN 新增行 6 处命中在 `:3740` `completion`×2 + `wrapup`、`:3744` `maxTokenContinuations` + `maxTokens`、`:7391` `partialPersistence`，同刀删改带走 5 处 ⇒ 净 +1；CN 新增行 10 处：`:2965` 两处、`:5786/:5793/:5801×2/:5802/:5807` 共 6 处 `runId`（store 方法入参名）、`:5811` `partialPersistence`，带走 2 处 ⇒ 净 +8）→ **EXIT 0**（`--strict: OK — 0 处红`）。
- `npm run check:mutation`：改表前 **EXIT 1**（`✗ M10（src/tools/file-tools.js）：行号 表 1609 / 树 1615` —— 我加的 6 行历史注把它顶下去了）→ `node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md`（`改动 1 行（派生列由真树重算；手写列一个字都没碰）`，手写「期望红话」列我没改也不需要改：M10 那句锚的是 `value: maxBytesRequest` 那一行，措辞未变）→ `check:mutation` **EXIT 0**（`逐条：0 处不一致`）；`npm run check:mutation:run` **EXIT 0**（`OK — 29 条样本逐条「变异 → 红在该报的断言上 → 还原 → 绿」`）。
- 类型面（`find src -name '*.d.ts' -delete` 后）：`check:types` **0**（`实测 99 个 --checkJs 错误 / 26 个文件，等于基线 99`）；`check:types -- --with-tools` **0**（`134 / 28 = 基线 134`）；`check:types:strict` **0**（`实测 1875 个 strict 错误 / 72 个文件 … 比基线 1877 少 2 个`）；`check:types:strict -- --with-tools` **0**（`2088 / 78 … 比基线 2090 少 2 个`）；`types:build` **0**、`check:types-build` **0**（`src/ 下 90 个 .d.ts`，跑完再 `find src -name '*.d.ts' -delete`）。**四个基线一个都没抬**。
- `BARE_LINE_REF_BASELINE` 现值 **6**（`grep -n "^const BARE_LINE_REF_BASELINE = " scripts/docs-drift-check.mjs` → `2747:const BARE_LINE_REF_BASELINE = 6;`），与 `--verbose` 的「棘轮口径实测 **6** vs 基线 6」一致。
- 收尾：`git worktree remove /tmp/main-base-check`（见「未验证」）。

## 未验证

- **`node scripts/docs-drift-check.mjs --self-test` 没跑**：判据是「动了 `scripts/docs-drift-check.mjs` 或锚点面才跑」，本段两处都没动（`git diff --stat e1bd9cf..HEAD -- scripts/docs-drift-check.mjs scripts/cell-axes-anchors.mjs` 为空：anchors 那 18 行的改动是上一段 `5b57219`/`4070ff0` 做的）。省下的是一轮 ~7.5 分钟。
- **真机那半没跑**：`skipped 13` 里含 `ERIX_E2E_REAL` 门禁的续跑面（S1–S6 / Z1）——上一段也是同一口径跳过。
- **合并树上的 `test/test-suite-baseline.json` 现测**：登记 3717 vs 实测 3725（+8）留给主会话抬，我没 `--sync`。
- **一处中英契约的说法与树不符，我没擅自改**：`docs/host-consumer-contract.md:7377-7378` 与 `_cn:5801-5802` 写「Store surface: `appendRecoveryRow(runId, row)` … `listRecoveryRows(runId)` … `clearRecoveryRows(runId)`. **All three** are optional / 三者都是可选能力」，但 `grep -rn "clearRecovery" src/ test/ scripts/` 在 src/test/scripts 下**零命中**（只有这两份文档命中）⇒ 树上只实现了两个方法。它不进任何闸（`check:docs` / `docs-drift-check` 的锚点不覆盖这句），所以本段是绿的；要不要补第三枚方法或把「三者」改成「两者」，属已验收架构面的裁决，我按「别改设计」留着。
- `npm pack` / `check:release` 面没跑（本段没动版本号与打包面）。
- `/tmp/main-base-check` 这个只读对照 worktree 需要在主会话侧 `git worktree remove` 清掉（我在最后一笔里删；若报告时它还在，就是被这条覆盖）。
