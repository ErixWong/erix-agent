# REPORT-769-r8（工单 #769 R8：`docs-drift-check --self-test` 唯一红——符号锚点下限常量陈旧）

树：`/home/eric/wt-769w8`，HEAD `727af80`（含主会话复原的 3 行锚点区间）。
`git status --porcelain` 开工时为空；`node_modules` 是软链（`ls -la node_modules` 过）。
本切片只动 `scripts/docs-drift-check.mjs` 与「声称该常量」的文档，**不碰 `src/`**、不碰
`test/test-suite-baseline.json` / `test/static-guards.test.js` / `scripts/retired-spelling-scan.mjs`。
不 push、不开 PR。

## 取证边界

以下每条都指回一条**我在这棵树上真跑过**的命令；抄的是现报原文。

1. **现测 243 > 下限 242（根因在场）** —— `node scripts/docs-drift-check.mjs --verbose`（退出码 0，6.2s）：

   ```
   ✓ symbol-anchor: 实测 243 组 > 下限 242 组——符号锚点在变多（好方向），请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243，否则下限就在空转
   ```

   同一轮另一条 note（分母）：`✓ symbol-anchor: 覆盖面 51 份文档里「符号 + 文件」锚点 814 处（唯一 (符号, 文件) 243 组：…）`。

2. **两例的期望数字本来就是从常量算出来的** —— `grep -n "SYMBOL_ANCHOR_MIN_UNIQUE" scripts/docs-drift-check.mjs`：
   `:2610` 是常量本体，`:9162` / `:9170` / `:9174` / `:9175` 那两例的 label 与 expect 全部写成
   `SYMBOL_ANCHOR_MIN_UNIQUE - 1` / `SYMBOL_ANCHOR_MIN_UNIQUE` / `SYMBOL_ANCHOR_MIN_UNIQUE + 1`，
   脚本里没有第二处字面量 `241` / `242`（`grep -n "24[12]" scripts/docs-drift-check.mjs` 只命中 `:2610` 一行）。
   ⇒ 半 A 把常量抬到 243 之后，这两例的前提数字**自动跟着现测走**（不是把断言改松）：
   - 「另一侧」那例的变异目标 = `243 + 1` = **244**（正是工单要的「现测 + 1」），期望仍是**必须红**；
   - 「退化」那例的 label/期望 = **242 < 243**，期望仍是**只有符号下限这一条红**。

3. **退化后的唯一组数 = 242（实测，不是算的）** —— 我自己照该例 overlay 的**同一条** `String.replace`
   在两份契约上手工落刀（CN `` `defaultSleep`（`src/loop/abort.js:16`） `` / EN
   `` `defaultSleep` (`src/loop/abort.js:16`) ``，两处 `grep -c` 各命中 1 处 ⇒ 变异靶子在场），跑
   `node scripts/docs-drift-check.mjs --verbose | grep -oE "唯一 \(符号, 文件\) [0-9]+ 组"`，现报：

   ```
   唯一 (符号, 文件) 242 组
   ```

   同轮裸行号侧一字未动（正是该例要证的形状）：`✓ bare-lines: … ⇒ 棘轮口径实测 **6** vs 基线 6`。
   跑完 `git checkout -- docs/host-consumer-contract_cn.md docs/host-consumer-contract.md` 复原（`git status` 干净）。
   这确认了 `CONST - 1 = 242` 与真实退化行为一致，也解释了**为什么现在这两例红**：常量还是 242 时，
   退化成 242 组**等于**下限 ⇒ `groups.size < minUnique` 不成立 ⇒ 那例等的那条红根本不出现（不是断言太严）。

4. **常量一改，文档声称面必须同批改**（闸 4 `node --test test/static-guards.test.js` 规则 4 会抓）——
   `test/static-guards.test.js:1355` 的 `CLAIMED_VALUE_CONSTANTS` 把 `SYMBOL_ANCHOR_MIN_UNIQUE` 的真值
   钉成 `scripts/docs-drift-check.mjs` 的文本，而 `CLAIMED_VALUE_DOC_RULES` 要求 `AGENTS.md` / `AGENTS_cn.md`
   各**至少一处** `` `SYMBOL_ANCHOR_MIN_UNIQUE = <数字>` `` 且**逐处等于真值**。现声称（`grep -rn "SYMBOL_ANCHOR_MIN_UNIQUE = " --include="*.md" .`）：
   `AGENTS.md:131` 与 `AGENTS_cn.md:113` 都写 242 ⇒ 半 A 必须同批把这两处抬到 243（中英同值），否则闸 4 红。
   `docs/maintenance/command-reference.md:69` / `_cn.md:55` 同形声称 242（不在静态守卫的声称面上，但同是**现值**句），同批抬。
   `REVIEW-772.md:45`（238）与 `docs/decisions/021-*`（191）是**历史**记述，不动。

5. **常量 `4f9b908`（主干合并）里就是 242** —— `git show 4f9b908:scripts/docs-drift-check.mjs | grep -n "^const SYMBOL_ANCHOR_MIN_UNIQUE"` 现报
   `2610:const SYMBOL_ANCHOR_MIN_UNIQUE = 242;` ⇒ 「243 不是从 242 上加出来的，是扫描器在这棵树上现报的」这句话是有据的。

6. **覆盖面没被脚本行号绑住** —— `grep -rn "docs-drift-check\.mjs:[0-9]" docs/ test/ | wc -l` ⇒ **0**，
   所以我往常量上面注释块里加字不会挪动任何被锚定的行号（裸行号棘轮只扫 `src/` 前缀：`BARE_LINE_RE`）。
   `--self-test` 用例数：`MIN_SELF_TEST_CASES = 99`（下限），CI 现报 224 例 ⇒ 我**不增不减用例**，
   条数保持 224。

**边界之外**（没在这棵树上量的就别当真值用）：CI 那三个红我没法本地重放（只有 `--self-test` 整体跑），
`--self-test` 一轮 ~7.5 分钟、本切片**最多 2 轮**，所以上面 1/3 两条用 `--verbose` + 手工 overlay 提前把逻辑定准。

## 打算怎么写（两半同一批，各自一笔 commit）

**半 A**（`scripts/docs-drift-check.mjs`）：`const SYMBOL_ANCHOR_MIN_UNIQUE = 242;` ⇒ `243`。
- 那一行**形状一字不变、仍是单独一行、无尾注**（自测 `:2615` 用 `^const SYMBOL_ANCHOR_MIN_UNIQUE = (\d+);` 从脚本自身文本读它，
  `test/static-guards.test.js` 的 `extractConstValue` 用同一形状读真值）。
- 解释写进**上面那个注释块的最后一行**（我把现有 `:2609` 那行扩写，**不新增行**，免得给上面第 6 条之外的东西挪行号），
  内容含：本树现报逐字（上面第 1 条）、「不在旧值上做加法：242 是主干 `4f9b908` 的值，243 是扫描器在这棵树上现报的」、
  以及「形状必须保持一行」的理由。
- 同批把第 4 条那四处**现值声称**（AGENTS.md / AGENTS_cn.md / command-reference.md / command-reference_cn.md）抬到 243。

**半 B**（同文件两例）：**语义不动**——两例的 `expect` 仍是「必须出现那条符号下限红」/「只有这一条红」，
变异目标随常量走到 244。要做的是把「为什么这两个数会自动跟着现测走」写成注释钉在两例上
（引第 1、3 条现报，并写明**不许**改成 `expectGreen` / 删例 / skip / 「任意红」），
让下一个人抬常量前先量一次而不是顺手把断言改松。用例条数、`expect` 条数、`expectFiles` 都不动。

**闸（只跑这些，`--self-test` 最多 2 轮）**：`node --check`；`--verbose`（要求「请把 … 升到 243」那句消失）；
`--self-test`（224 例全达预期、exit 0）；`npm run check:docs`、`npm run check:docs:strict`、
`node --test test/static-guards.test.js`（58/0）、`npm run check:docs-spelling`。全量 `npm test` 不跑（主会话复跑）。

## 未验证

- `--self-test` 里第三条红（`#286 T-b1a 区间相交的放行证`，`:9113`，`overlay: { [CONTRACT_CN]: mutateSymbolAnchorSpan("max_rounds_cap", "src/loop/termination.js", "") }`，
  `expectGreen: true`）我**没有单独重放**：它只在整轮自测里跑。我只量到了「变异靶子在场」这一半：
  `grep -n 'max_rounds_cap`（`src/loop/termination.js:116`）' docs/host-consumer-contract_cn.md` 现报 **1 处**（`docs/host-consumer-contract_cn.md:3053`，
  工单写的 `:3050` 是复原前的行号），且 `--verbose` 现报 `✓ symbol-anchor-span: 覆盖面 814 处符号锚点里自带区间 8 处：相交 8 处 / 不相交 0 处`。
  ⇒ 这条是否转绿，以闸 3 的 224/224 现报为准（我会在跑自测前用同一条 mutation 手工模拟一遍，见下）。
- 抬常量后**其它** 222 例是否受牵连（例：有没有别处拿 `242` 当字面量比）本地未整轮验证，同以闸 3 为准。
- 全量 `npm test`、CI 环境（node 22 干净检出、无 tag）未跑：按工单归主会话复跑。
