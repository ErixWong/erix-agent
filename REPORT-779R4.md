# REPORT-779R4 — issue #772 R4（锚点种类 + 独立覆盖面真值）

树 `/home/eric/wt-779e`，分支 `fix-261108-09-cell-axes-kind-required-erix`，基点 `5e819a4`（PR #779 头）。未 rebase / 未 push / 未开 PR。未碰 `/home/eric/wt-779w` 与 `/home/eric/wt-77*` 其它目录。

## 取证边界

**打开并读过的路径（本轮）**：
- `REVIEW-779.txt`（第二轮验收报告，两条 mandatory + 可复现变异）
- `scripts/cell-axes-anchors.mjs`（锚点登记：地板常量、数组字面量、`anchorHitLines()`、地板校验）
- `scripts/docs-drift-check.mjs` 的 #772 相关段（锚点 import、`cellAxesAnchorTable()`、锚点/表判据、`CELL_AXES_CALIBER_LINES` 自读、self-test `#772` 族与 harness）
- `test/contract-snapshot-cell-axes-767.test.js`（G4 一族）
- `docs/api/contract-snapshot-cell-axes.md`、`docs/api/contract-snapshot-cell-axes_cn.md`（两份契约表）
- `docs/maintenance/command-reference.md`（要登记已知限度的那份文档）
- `src/loop/orchestrator.js` 相关行（`:3015` 干扰注释、`:3017` 评审变异目标行、`:3038` 真实写点）与 `src/loop/state-view.js`（读取点）

**本轮不做的**：
- 不跑 `npm test` 全套（主会话跑），只跑任务清单里点名的闸
- 不动 `test/test-suite-baseline.json`（TAP 基线由主会话在合并树现取）
- 不加启发式去堵「锚点改到另一条真实代码行 + 引文同步改口」这条语义洞，只登记 + 特征用例
- 不改 `CHANGELOG_PAIR_FLOOR` / `SYMBOL_ANCHOR_MIN_UNIQUE` / `BARE_LINE_REF_BASELINE` 的手填值（只原话记录现报值）
- 不做 rebase / push / PR / 合并树相关操作

**已知限度（本轮只登记，不追打）**：见「M-C 已知限度」一格与 `docs/maintenance/command-reference.md` 新增段。
