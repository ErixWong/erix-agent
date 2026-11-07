# REPORT-770 — 停写 run snapshot 的 `status` / `compactionStats` 两格

分支 `fix-261108-13-stop-status-compactionstats-erix`，基点 `855d6ff`（PR #779：两轴载荷表 + 锚点登记表）。
不 rebase、不 push、不开 PR；不碰 `/home/eric/wt-770w` 与其它 `~/wt-*`。

## 取证边界

- **证据来源只有当前工作树 `/home/eric/wt-770e`（HEAD 起于 `855d6ff`）上的工具返回**：`grep`/`searchText` 的 `文件:行` 命中、`readFile` 的带行号原文、闸命令的退出码与我自己在树里写下的注释/断言。任务书里给的坐标（`orchestrator.js:3038`、`:6160-6162`、`resume-manager.js:346`、`file.js:523`）只当线索，**每条都在当前树重新验过一遍才写进本报告的结论**。
- **不采信**：其它工作树（尤其对照树 `wt-770w`）、`node_modules`、dist/build、以及我记忆里"主会话实测过"的数字；凡引用数字（闸自报的地板/计数、用例总数、退出码）都在报告里注明来源命令与它当时的自报值。
- **行号会漂**：本文件里 `文件:行` 是写下那一刻的坐标；后续 commit 之后同坐标可能已不是同一行，以最近一次 `git diff`/`grep` 输出为准（每步都 dump 到 `/tmp/770e-mN.diff`）。
- 快照落盘字节由 `src/store/file.js` 的 `JSON.stringify(snapshot)` 决定 ⇒ **键的存在与顺序本身就是可见面**，本报告把"键消失"当可见变更对待（CHANGELOG 中英成对）。
- 不主动读密钥/`.env`；不跑 `npm test` 全套（按任务书点名跑用例）；不动 `test/test-suite-baseline.json`；不动 `BARE_LINE_REF_BASELINE`；棘轮基线不抬。

## 步骤 1 — 读者与断言枚举（清单）

（进行中）
