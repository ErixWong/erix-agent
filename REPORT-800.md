# REPORT-800 — erix_run 异步唤醒把活会话判成孤儿（摘键无归属）

> 本轮范围：**只有判据 1（摘键要有归属）+ 判据 2（同 sessionId 双实例的顺序守网）**。
> 判据 3（恢复回路）/ 4（`orphaned` 措辞）/ 5（`shutdown` 按实例归属）留下一轮，见 `## 未验证`。

## 取证边界

实际打开并逐字读过的路径（本轮受读取预算约束，主会话给定的清单）：

- `examples/pi-extension/erix-run.ts` 的 `:596-665`（`sessionHandle` 定义、`session_start` 的 rebind
  摘旧键 `:629`、`session_shutdown` 的摘键 `:662`）——两处都是**裸 `Map.delete` 式的键删除**，
  不检查「表里这条还是不是我那个句柄」。
- `examples/pi-extension/erix-run-jobs.js` 的 `createSessionHandleRegistry`（`:349-366`：
  `delete: (sessionId) => handles.delete(sessionId)`，无归属校验）与 `jobView`（`:577-629`，
  `status.json` 的内容就是这个函数的返回）。
- `test/examples/erix-run-async.test.js` 的 `:540-600`（`fakeCtx`，已带 `stale` 开关）、
  `:1470-1520`（`loadExtensionModule` / `startSession`）、`:1590-1700`（`#654` 的 orphaned 格与
  quit/reload 摘句柄格）。
- 结论：`:1608` 那一格是**手工** `sessionHandles.delete(sessionA)` 模拟会话走了，
  从不走「同 id 双实例 + 旧实例迟到 shutdown」这个顺序 ⇒ 本轮新增的那格是这个形状的第一份覆盖。
- 打不开/没打开的：**没有**打开 `scripts/*.mjs`、`test/test-suite-baseline.json`、
  `test/mutation-samples.md`（本轮按预算明令禁止，且本轮不动派生登记表）。
  本轮不需要引擎侧证据（缺陷全在扩展面 `examples/pi-extension/`），`src/` 未被打开也未被改动。

## 基点

（提交后回填，见下方 `## 结论` 的同一笔现测；下面是本轮起点）

- 分支 `fix-261109-05-handle-owner-guard`，起点 HEAD = `f405264`（= `origin/main`，本轮开始时
  `git status --porcelain` 0 行、`git diff --numstat origin/main..HEAD` 空）。

## 结论

（本轮改动、五条判据中前两条的现场、反向证现场、门禁退出码 —— 见提交后补全）

## 未验证

- **判据 3（恢复回路）未做**：`session_start` 重新登记 owner 后扫 `delivery:"orphaned"` 的 job 补投一次，
  本轮一行没写 ⇒ 盘上已有的 `orphaned` job 仍**不会**被救回（本轮只保证「不再新造 orphaned」）。
- **判据 4（措辞诚实）未做**：`erix-run-jobs.js:178` 与 `examples/pi-extension/README.md:385`
  仍写「owner 会话 `<id>` 已不在」，本轮一字未改。
- **判据 5（兄弟洞）未做**：`erix-run.ts:655` 的 `asyncRuntime().shutdown(sessionId)` 仍按 **owner**
  清而不按**实例**清 ⇒ 旧实例迟到的 shutdown 仍会连带摘掉活实例那批 job 的看门狗与投递重试定时器。
- **未跑的门禁**（本轮按指示只跑串行四步）：`npm test` 整套、`check:test-summary`、`check:changelog`、
  `check:docs` / `:strict` / `docs-drift-check --self-test`、`check:agents-directives`、
  `check:docs-spelling` / `:examples` / `:pack-links`、`check:inventory`、`check:config-leaf-values`、
  `check:mutation` / `:run`、`check:exports:deprecated`、类型四档 + `check:types-build`、`check:release`。
  ⇒ 本轮**不能**声称整套门禁绿；派生登记表（`test/test-suite-baseline.json` 等）本轮**未更新**，
  新增一格用例后 `# tests` 会比登记值高（棘轮方向是绿，但下一轮要现测抬值）。
- 真机/真上游路径（`ERIX_E2E_REAL=1`）没跑；本轮证据全部来自离线单测 + 一次人工变异。
