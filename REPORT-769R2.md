# #769 R2 收口报告（只清 11 条坐标/锚点类红，不改设计）

分支 `fix-261108-24-ledger-recovery-rows-r2-erix`，起点 HEAD `4070ff0`（已 rebase 到 `origin/main = e1bd9cf`）。

## 取证边界

- 工作树：只写 `/home/eric/wt-769e2`；`/home/eric/wt-769e`（上一段）、`/home/eric/wt-769w`（对照）、`/home/eric/projects/erix-llm-kit`、`/home/eric/wt-75*`/`76*`/`77*` 只读不写。
- 本段允许的改动面：测试里的**坐标/行号/锚点/期望红话/基线常数**，以及 `scripts/cell-axes-anchors.mjs`、`scripts/docs-drift-check.mjs` 的登记锚点表。**不改**引擎 `persist("appendRecoveryRow")` 可选能力通道、store 三方法语义、`src/store/recovery-rows.js` 行形状单一定义。
- 判据来源：每个数字指回一条我真跑过的命令；闸只认退出码 + 点名到具体断言。
- 不许放宽判据：`G4-R*` 是反向证，期望必须点名到具体那句红话。
- #286 两格的数字只来自 `node scripts/docs-drift-check.mjs --verbose` 真输出。
- `test/test-suite-baseline.json` 不动（主会话在合并树统一现测）；`BARE_LINE_REF_BASELINE` 必须仍是 6。
- 未跑：（待填）

## 逐条诊断与处置（11 条）

（待填）

## 闸

（待填）

## 未验证

（待填）
