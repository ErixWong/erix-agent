# REPORT-770R2 — self-test 从 5/219 红回到 exit 0（R2 收口）

分支 `fix-261108-15-snapshot-stop-selftest-erix`，基点 `50e1d93`（#770 主切片头）。不 rebase、不 push、不开 PR。

## 取证边界

**只在这棵树工作**：`/home/eric/wt-770e2`。未碰 `/home/eric/wt-770w2`（同单对照树）、`/home/eric/wt-770e`、`/home/eric/wt-774*`、`/home/eric/wt-73*`、`/home/eric/wt-753*`。

**本片的输入事实（全部指回真跑过的命令或本仓文件的真行）**：

- 起点：`git log --oneline -1` → `50e1d93 docs(#770): 记 docs-drift --self-test 5/219 红的根因…`。
- 5 条红的根因表来自 `REPORT-770.md` 最后一节（该节自己给出 fixture 行号：`scripts/docs-drift-check.mjs:8725`（键名变异靶子）、`:8740`（R3 删行定位）、`:8547`（`CELL_AXES_DISTRACTOR_LINE = 3036`）、`:8805`、`:8846`（两条期望红话集合））；**例名与行号以本片自己复跑为准**，见下面「self-test 基线复跑」。
- #770 之后树上真值：`status` / `compactionStats` 两格 write 轴 `stopped`，锚点 `kind:"comment"` 钉 `src/loop/orchestrator.js:3029` / `:3038` 两行解释注释（`compactionStats|write` 另有 `:6185` 轮记录真写点这条登记条目）。
- 派生值纪律：`BARE_LINE_REF_BASELINE` **必须仍是 6**（本片实测的 8/10 计数按现测写进期望，不抬基线）；`CHANGELOG_PAIR_FLOOR`、`SYMBOL_ANCHOR_MIN_UNIQUE` 只能按闸/守卫**自报**现测值改。

**判据边界（工单原文）**：

1. `node scripts/docs-drift-check.mjs --self-test` exit 0（例数报出来）；一轮 ~8 分钟，最多两轮。
2. 每例一张「例子诚实性对账表」5 行：原来问什么 / 为什么 #770 之后问不到（fixture 哪一行）/ 新靶子坐标（文件:行）/ 它仍在问同一件事的证据。证据 = **我自己加的一条反向证**：削弱对应判据（或把靶子还原成旧形状）⇒ 该例必须红且点名它。
3. 禁止：把 expected 改成「红什么都算红」（必须点名具体红话）；把例子改成恒绿/跳过；抬派生值基线。
4. 闸：`node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js`、`node --test test/static-guards.test.js`、`npm run check:docs`、`:strict`、`:docs-spelling`、`:syntax`、`:agents-directives`。`npm test` 全套不跑；`test/test-suite-baseline.json` 不动；原则上不动 `src/`（若动则三档 typescript 棘轮按现测、基线不抬）。

**本片不做的事**：不改判据的语义强度（只换靶子坐标与期望集合的组成，且每条红话逐句点名）；不改 `src/`（除非常驻红无法在 fixture 层收口，届时在此追加理由与实测）；不动 `test/test-suite-baseline.json`。
