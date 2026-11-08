# #769 R5 处置报告（copilot 复审三条阻断 + 三条次要）

起点 `0dbdde8`（分支 `fix-261108-27-recovery-read-strict-erix`，已含 R2/R3/R4）。
复审原文只读 `/home/eric/copilot-sbx/rv769b/REVIEW-769B.md`；裁决全部来自工单 `/home/eric/store-review-261106/tickets/769-r5.md`，未自行换语义。

## 取证边界

- **只在本树取证**：`/home/eric/wt-769e4`。对照树 `wt-769e3` / `wt-769e2` / `wt-769e` / `wt-769w*` 一律未读、未引用其产物；主仓 `/home/eric/projects/erix-llm-kit` 未读写。
- **复审文档只读一份**：`/home/eric/copilot-sbx/rv769b/REVIEW-769B.md`（49 行），其「实测」结论我只当作**指路**，每条都在本树重跑过才算数（下表逐条给了真跑命令）。
- **本报告的每个数字都指回一条我真跑过的命令**；只跑了定向文件的地方不声称全量结论，未跑的口径一律进 `## 未验证`。
- 行号坐标以起点 `0dbdde8` 为准；我改动之后的行号若有漂移，以报告正文当次引用的命令输出为准。
- 未 push、未开 PR。

## 逐条处置（M1-M6）

- [ ] **M1（阻断）** `listRecoveryRows` 成功返回非数组被吞成空集 → 同码 `recovery_rows_unreadable` 硬终止 + 测试 + 反向证
- [ ] **M2（阻断）** fresh start 清盘失败无 `termination` → `persistence_failed` + `phase:"recovery_rows_clear"` 硬终止 + 契约理由 + phase 面补格 + 反向证
- [ ] **M3** 生命周期段无条件口气 → 改有条件（持久化开着 + store 实现了 `clearRecoveryRows`）+ 宿主义务，中英同数
- [ ] **M4（假话）** `CHANGELOG.md:9-10` 中英条「截到 200 字符」→ 改既有条目；契约成本段补 `482 B` 口径与 issue #791
- [ ] **M5** 形状坏的 `tool-executed` 行被当执行证据 → 同码硬终止（点名不合字段）+ 测试 + 反向证
- [ ] **M6** 未知 `recoveryEvent` 的前向兼容承诺进中英契约（只改文档）

## 闸

（待填：逐条命令 + 退出码 + 关键数字）

## 未验证

（待填）
