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
- [x] **M5** 形状坏的 `tool-executed` 行被当执行证据 → 同码硬终止（点名不合字段）+ 测试 + 反向证
  - 判据与抛点：新增 `toolExecutedRecoveryRowShapeProblem(row)`（`src/store/recovery-rows.js:131-136`）逐项查
    `toolUseId` → `round`（`Number.isSafeInteger`，所以 JSON 里的 `null` / `1.5` / `NaN` 都不合）→ `dedupKey`；
    `readExecutedToolIdRecoveryRows` 遇到**本事件类型**而形状不合的行**抛 `TypeError`** 并点名是哪个字段
    （`recovery-rows.js:159-166`），不再静默跳过。不认识的 `recoveryEvent` 仍只是跳过（那是 M6 那条承诺）。
  - 收口点：`restoreResume` 把该抛包成**同一个** `recovery_rows_unreadable`（`src/loop/resume-manager.js:534-544`），
    终局面与读失败那格一致（`phase: "resume_recovery_rows"`、`sideEffect: "not_started"`），不新增第二个码。
  - 测试：`test/store/ledger-recovery-rows-769.test.js` 两格（纯函数格三种坏法各自点名字段 + 带正例与未知事件反例；
    续跑现场格断言 `code`、`termination.reason`、`termination.phase`、`cause` 里的字段名、工具零执行、零模型请求）。
  - 反向证（不原地改仓内 `src`，改前先存副本、还原后核 md5）：把抛错那一行换成 `continue` ⇒
    `# pass 16 / # fail 2`，红的正是两格且点名断言：`Missing expected exception: round 非安全整数（JSON 里的 null）：
    必须抛，不许静默跳过`、`坏行必须让 run 终止：修前它被当成「t1 执行过了」，同一个现场是**绿**的`；
    `cp` 还原后 `md5sum src/store/recovery-rows.js` 与变异前逐字一致（`582ddb5cf7580ad402277b2b6b376699`），18/18 回绿。
  - 契约：`docs/host-consumer-contract.md:7400-7404` / `_cn.md:5814-5817` 补「解析得动但形状不合也是同一条坏通道」，
    并点明只有不认识的 `recoveryEvent` 事件名才被忽略。
- [x] **M6** 未知 `recoveryEvent` 的前向兼容承诺进中英契约（只改文档）
  - `docs/host-consumer-contract.md:7444-7449`：在「未知 `kind` 没有总承诺」那一段之后明写——读侧只做**一条**
    前向兼容承诺且是引擎局部行为：不认识的 `recoveryEvent` 读回时忽略（点名
    `readExecutedToolIdRecoveryRows` / `readPartialTextRecoveryRow`），自己解析该文件的宿主自定策略。
  - CN 同段 `docs/host-consumer-contract_cn.md:5848-5851`（`check:docs` 的「中英逐处对账」认这条，见「闸」）。
  - **代码未动**（M6 是纯文档条）；`recovery-rows.js` 的注释承诺因此有了契约出处。

## 闸

（待填：逐条命令 + 退出码 + 关键数字）

## 未验证

（待填）
