# REPORT-772 — 两轴载荷表的「标记区定点豁免」（代号 261107-21）

## 取证边界

- **树与基点**：`/home/eric/wt-767f`，分支 `fix-261107-19-s1r-erix`，基点 `origin/main = 762ef52`；本单新增提交 `362863a`（实现 + 契约表外裸行号改锚点）、`9f1b037`（自测用例 + 登记册 + 中英 CHANGELOG + 配对地板），报告随最后一笔提交入库。核对：`git log --oneline -3`。
- **本树跑了的**：`node scripts/docs-drift-check.mjs`（含 `--verbose`）、`npm run check:docs`、`npm run check:docs:strict`、`npm run check:docs-spelling`、`npm run check:syntax`、`node --test test/contract-snapshot-cell-axes-767.test.js`、`node --test test/static-guards.test.js`、三组手工反向证（改盘跑完已还原、`git status --short` 为空）、`node scripts/docs-drift-check.mjs --self-test` 全量 **2 轮**（第 1 轮 2 例未达预期 → 修 → 第 2 轮全绿；更早两次未跑完即被终止的不计为完成轮）。
- **本树没跑的**：依赖 `typescript` 的三档棘轮（`check:types` / 三档棘轮）——按分工留给主会话；**不 push、不开 PR**；未碰 `/home/eric/wt-773` 与其它 `wt-767*` 树。
- **数字来源**：下面每个数字都指回一条我实际跑过的命令；报告里没有从别的树或别的轮次抄来的数。唯一的外部参照值（`--self-test` 在 `762ef52` 上 ~6m41s / 199 例）写在任务书里，只用作耗时对照，不参与任何判据。

## 一件事怎么解的

`bare-lines` 是**唯一**剩下的一条红（任务书陈述，本树起点复现见下）。做法是给裸行号棘轮加一条**有条件**的定点豁免，而不是抬地板：

1. **位置**（`scripts/docs-drift-check.mjs` 的 `cellAxesRegion()` + `collectBareLineRefErrors()`）：只豁免 `docs/host-consumer-contract*.md` 里 `<!-- erix:snapshot-cell-axes:begin -->` / `<!-- erix:snapshot-cell-axes:end -->` 这对标记**之间**、且以 `|` 开头的表格行。标记区外的裸行号照旧逐条计数；同一个 `(文档, 目标文件, 行区间)` 只要在区外还出现过一次，就**整体不豁免**（`regionHits` 与 `regionOutside` 双集合）。
2. **机器复核**（`cellAxesGuardVerdict()`）：豁免只在 `test/contract-snapshot-cell-axes-767.test.js` 的 `G4` 真在场时生效。绑的不是标题或注释，而是 `G4_KEY_NAME_CHECK` 的**定义（两个参数都真被用到，靠回溯 + 前瞻）**加它在 `assert.ok(…)` 里的**调用**。那个文件被改名/删除、或键名判据被削弱成「行号存在就行」⇒ 判据不在场 ⇒ 豁免自动失效，并且**额外**发一条点名错误（不是静默少算）。
3. **不静默**：豁免数进 `--verbose` 的分解那一行；`越界 / 目标文件不存在 / 反向区间` 三项对被豁免的引用**照旧逐条查**（豁免只免「计入棘轮」这一档）。
4. 表**下**口径段那 4 处裸行号（中英各 2 处，是上一轮我自己写进去的、在标记区**外**）按 #286 首选修法改成「符号 + 文件」锚点：`src/loop/orchestrator.js:2975` → `` `residueStart`（`src/loop/orchestrator.js`）``、`src/loop/resume-manager.js:430` → `` `restoreResume`（`src/loop/resume-manager.js`）``。**没有**伸手要地板。

## 判据逐条对账

| # | 判据 | 结果 | 复现命令 |
| --- | --- | --- | --- |
| 1 | `--self-test` 全绿 + 两条新反向证 | 第 2 轮全绿：**203 例全部按预期**（含本单新增 4 例，包含任务书要的那两条）；三条反向证又做了手工实测 | `node scripts/docs-drift-check.mjs --self-test` |
| 2 | `check:docs` / `check:docs:strict` 全绿；`BARE_LINE_REF_BASELINE` 仍是 6 | `check:docs` exit 0、`check:docs:strict` exit 0；常量定义仍是 `const BARE_LINE_REF_BASELINE = 6;`（第 2723 行），`git diff origin/main..HEAD` 里只有一行**新增**用例引用它，没有对定义本身的改动 | `npm run check:docs` / `npm run check:docs:strict` / `grep -n "^const BARE_LINE_REF_BASELINE" scripts/docs-drift-check.mjs` / `git diff origin/main..HEAD -- scripts/docs-drift-check.mjs \| grep BARE_LINE_REF_BASELINE` |
| 3 | `--verbose` 分解里指得到本区豁免计数 | 那一行读作：覆盖面 51 份文档 / 裸行号引用 **97** 次出现 / 唯一 **(文档,目标文件,行区间) 82** 处 / 声明式豁免 **4** 处 / **标记区定点豁免 72** 处（机器复核在场=是，绑 `test/contract-snapshot-cell-axes-767.test.js` 的 G4）⇒ 棘轮口径实测 **6** vs 基线 **6**；另有外仓前缀 3 处 | `node scripts/docs-drift-check.mjs --verbose \| grep bare-lines` |
| 4 | 削弱键名判据 ⇒ 闸仍红 | 见「反向证 ④」：exit 1，且被削弱后的 G4 自己仍是 9 pass（正是必须绑在闸上的理由） | 见下 |
| 5 | `check:docs-spelling` / `check:syntax` / 契约测试 全绿 | spelling exit 0；syntax exit 0（493 个跟踪文件 `node --check` 全过）；`node --test test/contract-snapshot-cell-axes-767.test.js` = 9 pass / 0 fail | `npm run check:docs-spelling` / `npm run check:syntax` / `node --test test/contract-snapshot-cell-axes-767.test.js` |
| 6 | CHANGELOG 中英各一条，写明豁免条件 | `### Changed` 顶部中英配对各一条，条件写成 (a) 位置 + (b) G4 在场（含「只查行号存在 ⇒ 免检通道」这句反面） | `git show 9f1b037 --stat` |
| 7 | 配对地板按守卫**现报**数字改 | 改 CHANGELOG 后守卫报「实测 **25** 对 > 地板 23 ⇒ 可以抬地板到 25」⇒ `test/static-guards.test.js` 的 `CHANGELOG_PAIR_FLOOR` 23 → **25**（只动这一处；该文件另一执行体的规则 3 未碰）。改后 `node --test test/static-guards.test.js` = 56 pass / 0 fail | `node --test test/static-guards.test.js`（看 `# 配对地板：实测 … 可以抬地板到 …`） |
| 8 | 三档 typescript 棘轮不跑、不 push | 未跑、未 push、未开 PR | `git status -sb` |
| 9 | 本报告第一格是取证边界 | 本节 | — |

## 反向证（真命令 + 真退出码，跑完已还原）

三条都在本树真跑，`git status --short` 跑完为空、`node scripts/docs-drift-check.mjs` 还原后 exit 0。

- **① 同一条裸行号放到标记区外 ⇒ 红**：把表里那条 `src/loop/orchestrator.js:2986` 原样抄到 `<!-- erix:snapshot-cell-axes:begin -->` **之前**（CN 契约），`node scripts/docs-drift-check.mjs` → **exit 1**，红因 `bare-lines: 裸行号引用（唯一 (文档,目标文件,行区间)）实测 **7** 处，超过棘轮基线 **6** 处`。同一引用、只差位置 ⇒ 红只能来自「区外照旧计数」这条口径。
- **② G4 那个测试文件改名 ⇒ 豁免失效、闸回红**：`mv test/contract-snapshot-cell-axes-767.test.js /tmp/g4-renamed.js`，`node scripts/docs-drift-check.mjs` → **exit 1**，两条红：`实测 **78** 处，超过棘轮基线 **6** 处`（72 处标记区豁免整体作废）+ `bare-lines: 标记区定点豁免的机器复核不在场 —— test/contract-snapshot-cell-axes-767.test.js 不在场（被改名或删除 ⇒ 表里那些 file:line 没人逐条复核）…`。跑完 `mv` 回原位。
- **④ 把 G4 的「那一行确实提到这格的键名」削弱成只查行号存在 ⇒ 闸仍红**：把 `G4_KEY_NAME_CHECK` 的函数体换成 `return typeof lineText === "string";`（键名参数不再被用），`node scripts/docs-drift-check.mjs` → **exit 1**，两条红：`实测 **78** 处 > 基线 **6**` + `机器复核不在场 —— G4 的键名判据 \`G4_KEY_NAME_CHECK\` 的定义不在场，或它的两个参数没有真被用到（只查行号存在 = 免检通道，不配拿豁免）`。同一次削弱下 `node --test test/contract-snapshot-cell-axes-767.test.js` 仍 **exit 0 / 9 pass**（自测用例：把断言里的调用换成不判键名的表达式，同样判红）。⇒ 豁免不是「行号在范围内就行」的免检通道，而且这一层只能绑在闸上：测试自己发现不了自己被削弱。

## self-test

- 手工 4 例先在**副本 + 用例过滤器**上验过（`DT_FILTER="#772"`，只在 `/tmp`/`scripts/tmp-*.mjs` 临时副本里注入过滤口，跑完删除）：4 例全部达预期（3 红 + 1 绿对照），唯一失败是副本自带的「用例数被削：现在 4 例，下限 99 例」——过滤口的人造物，不是判据红。
- 全量 `node scripts/docs-drift-check.mjs --self-test` 共两轮（预算上限就是两轮）：
  - **第 1 轮（`362863a`+`9f1b037` 上）：失败 — 2/204 例未达预期**。两条红都不是 #772 的用例，而是 #286 返工 R1 的符号下限夹具（「`defaultSleep` 退化成裸行号 ⇒ 只有符号下限红」与「把 `SYMBOL_ANCHOR_MIN_UNIQUE` 升到 238 ⇒ 必须红」，都是「改了但没红」）。红因：把表**下**口径那 4 处裸行号改成符号锚点后新增一组唯一 `(符号, 文件)`，实测从 237 抬到 **238**（note 原句：「实测 238 组 > 下限 237 组…请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 238」），±1 靶子跟着实测上移。修法：按 note 现报值抬到 238，并同步 AGENTS 中英与中英登记册现值（提交 `19d5170`）。
  - **第 2 轮（`19d5170` 上）：`docs-drift-check --self-test: OK — 203 例反向证/放行证全部按预期，对照组绿`**；日志 `/tmp/selfB.log` 里 `✓` 208 行、`✗` 计数 **0**。例数 203 = 任务书在 `762ef52` 上量的 199 + 本单新增 4；耗时 ~7m20s（起 02:43:39，日志写完落在 02:49:49–02:51:35 之间）。
- **退出码口径（诚实声明）**：单轮超 exec 的 120s 上限，两轮都是后台跑（`setsid nohup … > /tmp/selfB.log`），后台进程退出码没被直接捕获；判据取自脚本自己的收尾行——第 1 轮「失败 — 2/204 例未达预期」（该路径即非零退出），第 2 轮「OK — … 全部按预期」且 `✗` 计数 0。预算内没再跑第 3 轮去补那个退出码数字。

## 改了什么（文件清单）

- `scripts/docs-drift-check.mjs`：新增 `CELL_AXES_MARK_*` / `CELL_AXES_GUARD_*` 常量、`cellAxesRegion()`、`cellAxesGuardVerdict()`；`collectBareLineRefErrors()` 里加 `regionHits` / `regionOutside` / `regionGuard` 与 measured 公式 `unique − 声明式豁免 − 标记区豁免`；`--verbose` 那一行加「标记区定点豁免 N 处（机器复核在场=是/否）」；判据不在场时点名报错。新增 4 条 `--self-test` 用例（区外红 / 守卫清空红 / 键名判据削弱红 / 只加注释绿）。
- `test/contract-snapshot-cell-axes-767.test.js`：把 G4 的键名判据抽成 `G4_KEY_NAME_CHECK(lineText, key)` 并在断言里调用（行为不变，9 pass 不变），让闸能机器绑定它。
- `docs/host-consumer-contract.md` / `_cn.md`：表下口径段的 4 处裸行号改成符号锚点。
- `docs/maintenance/command-reference.md#docs-anchors`：登记这条定点豁免（范围、条件、什么情况下失效、四条反向证、地板仍是 6）。
- `CHANGELOG.md`：中英各一条（写明两个条件）。
- `test/static-guards.test.js`：`CHANGELOG_PAIR_FLOOR` 23 → 25（守卫现报值，只动这一处）。
