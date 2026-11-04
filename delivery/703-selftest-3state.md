# #703：`--self-test` 的「当前版」靠改 `package.json` 模拟 → 改成 registry/tag 桩 + S1/S2/S3 三态探针

- 分支：`feat-261104-01-selftest-3state-703`
- 基点：main `3da5d76`（版本 `0.30.0`）
- 纪律：每完成一步立刻 commit；实测数据当场追加，不攒到最后

## 取证边界

打开过（读 / 跑）的绝对路径：

| 路径 | 用途 |
|---|---|
| `/home/eric/projects/worktrees/erix-703/scripts/docs-drift-check.mjs` | 判据本体 + `--self-test` 的 198 例（本次唯一要改的判据脚本） |
| `/home/eric/projects/worktrees/erix-703/scripts/release-day.mjs` | `--sync` 回写在发版日里的调用面（S1/S2 形状的既成口径） |
| `/home/eric/projects/worktrees/erix-703/CHANGELOG.md` | 本版 `0.30.0` 段（有变更证据）/ `0.31.0` 段（纯删除，零加法句，段首无日期） |
| `/home/eric/projects/worktrees/erix-703/docs/host-upgrade-guide-0.30.0.md` / `_cn.md` | 真树的当前版指南（§4 是**六格 bullet** 形状） |
| `/home/eric/projects/worktrees/erix-703/docs/host-upgrade-guide-0.31.0.md` / `_cn.md` | 切版树上的当前版指南（§4 是**散文**形状；本单**只读不改**，#698 的地盘） |
| `/home/eric/projects/worktrees/erix-703/AGENTS.md` / `AGENTS_cn.md` | 发布行 / 本仓版本两句（`published-claim` 的真值面） |
| `/home/eric/projects/worktrees/erix-703/docs/requirements.md` / `_cn.md` | `CURRENT_CLAIMS` + §4 阶段表 current 行 |
| `/home/eric/projects/worktrees/erix-698/` | 主 agent 的正确 S1 树（`053d35e`：切版 + #698 指南 §4 + `--sync` 回写），**只读** |
| `/tmp/p703/base-selftest.log` | 我自己跑的**真树 0.30 基线**：`--self-test` exit 0，198 例全绿（6m23s） |
| `/tmp/p703/S1/` | 我自建的第一棵探针树（形状见下节），日志 `/tmp/p703/S1-selftest.log` / `/tmp/p703/S1-strict.log` |
| `/tmp/s1-main-drift.log` | 主 agent 在 erix-698 上跑的 S1 读数：**6/199** |

没有打不开的路径。`/home/eric/projects/erix-llm-kit` 未被读写（工单禁）。
`docs/host-upgrade-guide-0.31.0*.md` 只读：**本单不动**（#698 的地盘）。

## 基点：我自己现跑的读数（2026-11-04，UTC+8）

| 树 | 命令 | 读数 |
|---|---|---|
| 真树 `3da5d76`（`0.30.0`） | `node scripts/docs-drift-check.mjs --self-test` | **exit 0 / 198 例全绿**（6m23s，`/tmp/p703/base-selftest.log`） |
| 自建探针树 `/tmp/p703/S1`（见下） | 同上 | **exit 1 / 6 例未达预期**（6m5s，`/tmp/p703/S1-selftest.log`） |
| 同一棵 `/tmp/p703/S1` | `node scripts/docs-drift-check.mjs --strict` | **exit 0**（`/tmp/p703/S1-strict.log`：125 项对齐 `package.json 0.31.0`） |
| 主 agent 的 S1 树 erix-698 `053d35e` | 同上 `--self-test` | **6/199**（主 agent 2026-11-03 现跑，`/tmp/s1-main-drift.log`；我逐条比对：与我自建树的 6 例**同一批、同一判词**） |

`/tmp/p703/S1` 的形状（我自己按「同形树」口径造的，为的是让读数与主 agent 的可比）：
`tar` 分支工作树（排除 `node_modules` / `.git` / `logs`）→ `cp -a` 分支的 `.git`（**有** tag 面：`v0.30.0` / `v0.31.0`）→ `package.json` 置 `0.31.0` → 跑 `node scripts/docs-drift-check.mjs --sync --published 0.30.0` 做发布态回写。
**没有**跑 `#698` 的指南 §4 那一刀（那两份指南本单不许动），**没有** v0.31.0 的「未发布段带日期」形状。 ⇒ 与主 agent 的树唯一差在 §4 指南内容，而两棵树报的是**同样 6 例、同样判词**。

## 更正记录（主 agent 两条 steer，落账）

1. **S1 起点是 6 例，不是 44。** 工单正文里的 `44/199` 来自一棵**不合法的探针树**（改 `package.json` 到 `0.31.0` 但既没补 #698 的指南 §4、也没跑 `--sync` 回写），它同时声称「已发布 0.31」与「registry 最新 0.30」——现实中不存在的状态。补上「切版 + 指南 + `--sync` 回写」之后 44 → **6**。那批读数归 **`fixture-invalid`**（探针树不合法），**不是基线**。
2. **那两行 `guide-coverage`（`config.metadata.model` / `modelMetadata`）不是 0.31 指南的真实中英不对称。** 现查：`docs/host-upgrade-guide-0.31.0.md` 与 `_cn.md` 对这两个叶子**都是 0 次提及**（中英对称）。⇒ 只能来自**那条用例自己的变异形状**（`#690（反向证）纯加法` 那一例把叶子名只写进了 EN 半），归 **`fixture-invalid`**，按 #210 R2 修成「变异要落到该用例真正要判的那一格」。**不改指南。**

## 6 例逐条归类

读数来源：`/tmp/p703/S1-selftest.log`（我自建的 S1 树）与 `/tmp/s1-main-drift.log`（主 agent 的 S1 树），
**同一批 6 例、同一批判词**（逐行 diff 过）。归类口径：`fixture-invalid` = 测的是夹具自身（红在夹具的
形状/错字上，不是产品回归）；`version-dependent` = 钉在 0.30 的字面量上，换版就失效；`real-regression` = 真回归。

| # | 用例 | 实测判词 | 归类 | 根因与修法 |
|---|---|---|---|---|
| 1 | `#690（还原）EN 磁盘格式退回原句 ⇒ 红并点名 degradeReason` | 变异没落到 CHANGELOG.md 上 | **`fixture-invalid`（真 bug：自测夹具自己的正则转义错）** | `addSurfaceEvidence`（`scripts/docs-drift-check.mjs:6708`）写的是模板字面量 `` `^## \[${esc(PKG_VERSION)}\].*$` ``：JS 先把 `\[` / `\]` 吃成 `[` / `]` ⇒ 正则源是 `^## [0\.31\.0].*$` = **字符类**（只认 `0 . 3 1` 五个字符），而段首真实文本是 `## [0.31.0]（未发布 / unpublished）`，`## ` 后面紧跟的是字面 `[` ⇒ 永不命中 ⇒ 变异不落上。**0.30 真树上这一族 `inject=false`（本版段里已有该格证据）⇒ 这个笔误从不被调用 ⇒ 198 全绿把它藏了一整版**；0.31 是纯删除版（段里 70 处反引号全是退役导出名，不属于六格）⇒ `inject=true` ⇒ 五例同时报信。⇒ **这不是假阳，是反向证自己把潜伏的夹具 bug 报出来了**（#210 R2 要的就是这个）。修法：转义改成 `\\[` / `\\]`（同文件的 `rewriteCurrentChangelogHeading` / `addGuideCoverageClaim` 用的都是这个形状，只有这一处漏了）。 |
| 2 | `#690（还原）EN 诊断字段退回「observer events…」⇒ 红并点名 degradeKind` | 同上 | 同上（同一个根因，同一个注入器） | 同 #1 |
| 3 | `#690（还原）EN 终局载荷退回「Termination, verification…」⇒ 红并点名 exitCodeForRunFailure` | 同上 | 同上 | 同 #1 |
| 4 | `#690（中英各自判）CN 诊断字段整格缺席 ⇒ 红在 CN 侧（证据：degradeKind）` | 同上 | 同上 | 同 #1（这一例的 CHANGELOG 侧也走 `addSurfaceEvidence("diagnostics")`） |
| 5 | `#690 声明了变更却不点名该格字段 ⇒ 红（该格证据：degradeReason）` | 同上 | 同上 | 同 #1 |
| 6 | `#690（反向证）纯加法的名字不是变更证据：选项格写「不变」仍绿` | 本该绿，实测 2 处 `guide-coverage` 红（CN 指南没提 `config.metadata.model` / `config.metadata.modelMetadata`） | **`fixture-invalid`（变异只写了一半）** | 这一例把「本版新增叶子」那句话只写进 **EN 半** 的选项格；句里的 `config.metadata.modelMetadata.budgetTokens` 子串含代码侧清单里的两个叶子名 ⇒ `guide-coverage` 的中英成对那一半要求 CN 侧也提。0.30 两份指南**本来就都提过**这两个叶子（所以历史上没红），0.31 两份**都是 0 次提及**（已现查）⇒ 只改一侧就是凭空造一处中英背离。修法：这一例的中英**两半都写**（变异要落在它自己考的那一格，不能附带造出第二条红）；**不动 `docs/host-upgrade-guide-0.31.0*.md`**（#698 的地盘）。 |

**没有一例是 `real-regression`**：六例全红在自测夹具自身（一处转义错 + 一处只写一半的变异），#697 两条判据、
`unchanged-surface` / `guide-coverage` 两个判据本体一行没改。

## 修了什么（逐条对应上表）

| 改动 | 位置 | 对应 |
|---|---|---|
| `addSurfaceEvidence` 的段首正则转义 `\[` → `\\[`、`\]` → `\\]` | `scripts/docs-drift-check.mjs` 的 `addSurfaceEvidence` | 6 例表 #1–#5 |
| `#690（反向证）纯加法` 那一例的变异**中英两半都写** | `SELF_TEST_CASES` 里那一例的 `overlay` | 6 例表 #6 |
| registry 事实可注入：`--registry-json <file>`（读不出 = exit 2，不是跳过） | `scripts/docs-drift-check.mjs` 的 `registryFacts` / `loadRegistryFixture` + 顶部旗标注释 | 活 1 |

## 读数表

| # | 命令 | 期望 | 实测 | 日志 |
|---|---|---|---|---|
| 1 | 真树 `node scripts/docs-drift-check.mjs --self-test`（改前） | exit 0 / 198 | **exit 0 / 198 全绿** | `/tmp/p703/base-selftest.log` |
| 2 | S1 探针树 `--self-test`（改前） | — | exit 1 / **6** 例未达预期 | `/tmp/p703/S1-selftest.log` |
| 3 | S1 探针树 `--strict`（改前） | exit 0 | **exit 0** | `/tmp/p703/S1-strict.log` |
| 4 | 主 agent 的 S1 树 `--self-test`（改前） | — | **6/199**（与 #2 同批同判词） | `/tmp/s1-main-drift.log` |
| 5 | 真树 `--self-test`（改后） | exit 0 / 198（不许掉条数） | **exit 0 / 198 全绿** | `/tmp/p703/real-selftest-fixed.log` |
| 6 | S1 探针树 `--self-test`（改后） | **exit 0** | 待重跑（上一轮 S1 树因共享 index 里新增了 `delivery/703-*.md` 而 ENOENT 崩，已改为机械建树） | `/tmp/p703/S1-selftest-fixed.log` |

## 未完成

- [x] 6 例逐条归类与修复（上两节）
- [x] registry 事实可注入（`--registry-json`）
- [ ] S1/S2/S3 三态探针（进工作树 `scripts/version-state-probe.mjs`，禁止人肉 `cp -a`）+ 矛盾态反向证 + 一条 `npm run`
- [ ] `npm test` / `check:docs` / `:strict` / `check:docs-spelling` / `check:agents-directives` / `static-guards` / `check:test-summary`
- [ ] S1 合成树 `--self-test` exit 0 的最终读数
