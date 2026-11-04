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
| `/home/eric/projects/worktrees/erix-698` | 切版摞（`053d35e`，含 #698 的 §4 六格）：**只读**，只把它的 `git ls-files` 清单拷出来 |
| `/tmp/s1full` / `/tmp/s1full-selftest.log` | 主 agent 的最终验收树（`bde9ef8` = main + 切版 + #698 + 我的 `83ec163`）：**只读没改**（日志是主 agent 跑的） |
| `/tmp/p703/S1FULL2` | `/tmp/s1full` 的拷贝 + 只覆盖 `scripts/docs-drift-check.mjs`（`268637f`）+ 自建 tag/registry 桩 —— 最终树修完的读数在这棵上称 |
| `/tmp/p703/M698` | erix-698 工作树的入库清单拷贝 + 同一个覆盖 —— 同一形状的第二份对照 |
| `/tmp/p703/probe-full.log` / `/tmp/p703/probe-full2.log` | `npm run check:version-states` 全量输出（修前 2 红 / 修后四态全达预期） |
| `/tmp/p703/real-selftest-2.log` / `/tmp/p703/npm-test-final.log` / `/tmp/p703/g-docs.log` 等 | 最终态的真树自测、`npm test`、各条文档闸 |
| 本单新增的工作树文件 | `scripts/version-state-probe.mjs`、`test/version-state-probe-703.test.js`（新建）；`scripts/docs-drift-check.mjs`、`docs/testing.md`、`docs/testing_cn.md`、`package.json`（改） |

`.scratch/version-states/`（合成树与 registry 桩）：**写**（`.gitignore` 已登记为 scratch 类，不入库）。
**未写**：`docs/host-upgrade-guide-0.31.0*.md`、`CHANGELOG.md`、`src/`、`/home/eric/projects/erix-llm-kit`（工单禁）、
`/tmp/s1full`、`/home/eric/projects/worktrees/erix-698`。

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
| 1 | `#690（还原）EN 磁盘格式退回原句 ⇒ 红并点名 degradeReason` | 变异没落到 CHANGELOG.md 上 | **`fixture-invalid`（真 bug 一：转义；修完后仍剩「归错格」的真 bug 二）** | 修法一：转义改成 `\\[` / `\\]`（同文件的 `rewriteCurrentChangelogHeading` / `addGuideCoverageClaim` 用的都是这个形状，只有这一处漏了）。修法二（仅 1/5 两例需要）：注入的名字改为**只取判据会归回本格的成员**，见下节。 |
| 2 | `#690（还原）EN 诊断字段退回「observer events…」⇒ 红并点名 degradeKind` | 同上 | 同上（同一个根因，同一个注入器） | 同 #1 |
| 3 | `#690（还原）EN 终局载荷退回「Termination, verification…」⇒ 红并点名 exitCodeForRunFailure` | 同上 | 同上 | 同 #1 |
| 4 | `#690（中英各自判）CN 诊断字段整格缺席 ⇒ 红在 CN 侧（证据：degradeKind）` | 同上 | 同上 | 同 #1（这一例的 CHANGELOG 侧也走 `addSurfaceEvidence("diagnostics")`） |
| 5 | `#690 声明了变更却不点名该格字段 ⇒ 红（该格证据：degradeReason）` | 同上 | 同上 | 同 #1 |
| 6 | `#690（反向证）纯加法的名字不是变更证据：选项格写「不变」仍绿` | 本该绿，实测 2 处 `guide-coverage` 红（CN 指南没提 `config.metadata.model` / `config.metadata.modelMetadata`） | **`fixture-invalid`（变异只写了一半）** | 这一例把「本版新增叶子」那句话只写进 **EN 半** 的选项格；句里的 `config.metadata.modelMetadata.budgetTokens` 子串含代码侧清单里的两个叶子名 ⇒ `guide-coverage` 的中英成对那一半要求 CN 侧也提。0.30 两份指南**本来就都提过**这两个叶子（所以历史上没红），0.31 两份**都是 0 次提及**（已现查）⇒ 只改一侧就是凭空造一处中英背离。修法：这一例的中英**两半都写**（变异要落在它自己考的那一格，不能附带造出第二条红）；**不动 `docs/host-upgrade-guide-0.31.0*.md`**（#698 的地盘）。 |

**没有一例是 `real-regression`**：六例全红在自测夹具自身（三处：① 注入器正则转义漏了；② 一例的变异只写了一半；
③ 注入的名字没按判据的归属反查），#697 两条判据、`unchanged-surface` / `guide-coverage` 两个判据本体一行没改。
**修都是加限不让夹具说谎，不是放宽判据换绿灯**（硬约束）。

## 修了什么（逐条对应上表）

| 改动 | 位置 | 对应 |
|---|---|---|
| `addSurfaceEvidence` 的段首正则转义 `\[` → `\\[`、`\]` → `\\]` | `scripts/docs-drift-check.mjs` 的 `addSurfaceEvidence` | 6 例表 #1–#5 |
| `#690（反向证）纯加法` 那一例的变异**中英两半都写** | `SELF_TEST_CASES` 里那一例的 `overlay` | 6 例表 #6 |
| registry 事实可注入：`--registry-json <file>`（读不出 = exit 2，不是跳过） | `scripts/docs-drift-check.mjs` 的 `registryFacts` / `loadRegistryFixture` + 顶部旗标注释 | 活 1 |

### 第一轮修完只从 6 降到 2：剩下的两例是**另一个独立 bug**（不是同一个根因）

`npm run check:version-states` 的第一次全量跑（`/tmp/p703/probe-full.log`）报 **2/199**：

- `#690（还原）EN 磁盘格式退回改动前的原句 ⇒ 红并点名 degradeReason`
- `#690 声明了变更却不点名该格字段 ⇒ 红（该格证据：degradeReason）`

判词不是「变异没落上」了，而是「**红了但没点该点的名**」：

```
实测：unchanged-surface: docs/host-upgrade-guide-0.31.0.md:91 第「diagnostic fields」格写着不变，
      而本版 CHANGELOG 声明这些字段变了：degradeReason ——「不变」与同一版 CHANGELOG 打架（#690）
```

**根因**：`surfaceCaseEvidence("disk")` 从该格成员真值里取 `members[0]`，而 `degradeReason` **同时属于两格**
（它既是 `fold-summary-journal.js` 的账本记录字段，也是诊断字段），而 `surfaceCellOf` 是按
`SURFACE_CELLS` 的顺序**先命中的那格赢**（诊断字段排在磁盘格式前面）⇒ 注入下去的证人被裁判到了
**另一格**，红的是 diagnostic fields，用例要的是 on-disk formats。归类：**`fixture-invalid`**
（夹具挑名字时没反查归属），**不是 `unchanged-surface` 判据回归**。

**修法（没放宽任何判据）**：`surfaceCaseEvidence` 选名字时先按**判据自己的归属函数**过一遗
（`surfaceCellOf(name, { quoted: true, truths }).id === cellId`），只取会归回本格的成员。
`quoted: true` 与注入句里的反引号同口径。另外在 `runSelfTest` 的**静态校查**里加了一刀（与
「用例数被削」「符号锚点抽到 0 处」同一位置，跑变异**之前**报）：若某格的真值里**一个都**不被判据归回本格
⇒ 直接报「注入型证人无法成立」，这一刀在 0.30 树上也不空转（归属顺序飘了就会红）。
**未改** `unchanged-surface` / `guide-coverage` / `changelog-date` 任何一行判据；**未删**任何用例。

## 读数表

| # | 命令 | 期望 | 实测 | 日志 |
|---|---|---|---|---|
| 1 | 真树 `node scripts/docs-drift-check.mjs --self-test`（改前） | exit 0 / 198 | **exit 0 / 198 全绿** | `/tmp/p703/base-selftest.log` |
| 2 | S1 探针树 `--self-test`（改前） | — | exit 1 / **6** 例未达预期 | `/tmp/p703/S1-selftest.log` |
| 3 | S1 探针树 `--strict`（改前） | exit 0 | **exit 0** | `/tmp/p703/S1-strict.log` |
| 4 | 主 agent 的 S1 树 `--self-test`（改前） | — | **6/199**（与 #2 同批同判词） | `/tmp/s1-main-drift.log` |
| 5 | 真树 `--self-test`（改后） | exit 0 / 198（不许掉条数） | **exit 0 / 198 全绿** | `/tmp/p703/real-selftest-fixed.log` |
| 6 | S1 探针树 `--self-test`（只修了转义那一刀） | exit 0 | exit 1 / **2** 例（disk 那一格被归到了诊断字段） | `/tmp/p703/probe-full.log` |
| 7 | 真树 `--self-test`（归属反查修完之后） | exit 0 / 198 | **exit 0 / 198 全绿（无回归）** | `/tmp/p703/real-selftest-2.log` |
| 8 | **`npm run check:version-states` 全量（四态 + S1 整趟自测）** | 全部达预期 | **exit 0**：S1 `--strict` 0 + `--self-test` **198 全绿**；S2 **exit 2 点名 `TAG_MISSING`**；S3 **exit 0**；矛盾态 **exit 1 点名 `published-claim`** | `/tmp/p703/probe-full2.log` |

第 8 行的原文读数（逐字摘自探针自己的输出）：

```text
── S1：切版未发布（段首无日期 + 无 tag + registry 还是上一版）
    ✓ 段首是「未发布且无日期」形状（#697 ①）   ✓ AGENTS 的发布行声称 = 0.30.0   ✓ tag 面没有 v0.31.0
    ✓ exit 0（绿）
    ✓ `--self-test` exit 0（切版树上的 CI 阻断项）
         → docs-drift-check --self-test: OK — 198 例反向证/放行证全部按预期，对照组绿
── S2：✓ exit 2（未判定）  ✓ 点名 TAG_MISSING
── S3：✓ v0.31.0 的 tagger date = 2026-11-04  ✓ exit 0（绿）
── contradiction：✓ exit 1（红）  ✓ 点名 published-claim
version-state-probe: OK — 4 个发布态（S1/S2/S3/contradiction）全部达预期，含矛盾态反向证与 S1 的整趟 --self-test
```

条数：**198 → 198**（没涨也没掉；新闸不在自测里加例，而在 `runSelfTest` 的静态校查里 + 一个新测试文件 `test/version-state-probe-703.test.js`（4 例，进 `npm test`））。

## 其余门禁读数（本分支最终态）

| 命令 | 期望 | 实测 |
|---|---|---|
| `npm test` | 0 fail | **exit 0**：`# tests 3404 / pass 3391 / fail 0 / skipped 13 / cancelled 0`（日志 `/tmp/p703/npm-test-final.log`） |
| `npm run check:test-summary -- --log <上面那份>` | verdict ok | **exit 0**：`TEST-SUMMARY-VERDICT ok`（登记 3400，实测 3404，`TEST-SUMMARY-HINT` 提示可抬到 3404 —— **抬登记值仍是人的动作**，本单没改 `test/test-suite-baseline.json`） |
| `npm run check:docs` | exit 0 | **exit 0**（`docs-drift-check: OK — … 123 项对齐 package.json 0.30.0 与源码` + `docs-sync-check: OK — 中英契约标题结构对齐（106 节）`） |
| `npm run check:docs:strict` | exit 0 | **exit 0** |
| `npm run check:docs-spelling` | exit 0 | **exit 0**（`--strict: OK — 0 处红`） |
| `npm run check:agents-directives` | exit 0 | **exit 0**（`--strict: OK — 0 处红`，存量欠账 2 份登记・超上限 0・空转 0） |
| `npm run check:tests`（新增测试文件后补跑） | exit 0 | **exit 0**（扫 293 个文件，无 `/tmp` 字面量、无 `mkdtemp` 直调、无豁免） |
| `node --test test/static-guards.test.js` | 0 fail | **exit 0**：`# tests 54 / pass 54 / fail 0` |

**未跑**（本单预算不够，且不在工单要求的闸里）：`check:release` / `check:release:real` / `check:mutation:run` / `types` 家族。

## 最终验收树上的读数（主 agent 的树 = main + 切版 + #698 + #703）

主 agent 在 `/tmp/s1full`（`bde9ef8`，含我的 `83ec163`）上亲跑：**2/199 红**，与我同数同两条。
那两条的根因与修法见上面「第一轮修完只从 6 降到 2」那一节（已以 `268637f` 提交 —— **它不在 `/tmp/s1full` 里**，
所以那棵树自己跑仍是 2 红；我没有改它）。

为了在**那棵树的形状**上称修完的读数，我把它整棵拷到 `/tmp/p703/S1FULL2`（`tar` 排除 `node_modules`/`logs`/`.git`），
只覆盖 `scripts/docs-drift-check.mjs`（= `268637f`）+ `scripts/version-state-probe.mjs`，然后自己 `git init` +
按 CHANGELOG 带日期段建附注 tag（登记表里的 0.19.0 / 0.25.0 错开一天），**不建** `v0.31.0`（= S1 的 tag 面），
registry 桩用探针产的 `/tmp/p703/m698-s1.json`（latest=0.30.0）。结果：

| 树 | 命令 | 读数 |
|---|---|---|
| `/tmp/p703/S1FULL2`（= `/tmp/s1full` + `268637f`） | `node scripts/docs-drift-check.mjs --strict --registry-json …` | **exit 0**（125 项对齐 `package.json 0.31.0`） |
| 同一棵 | `node scripts/docs-drift-check.mjs --self-test --registry-json …` | **exit 0 / 198 例全绿，对照组绿**（`/tmp/p703/S1FULL2-selftest.log`） |
| 同一棵的形状的另一份（erix-698 工作树 + 同一个覆盖） | 同上两条 | 同样 **exit 0 / 198 全绿**（`/tmp/p703/M698-selftest.log`） |
| 真树（本分支 `268637f`） | `node scripts/docs-drift-check.mjs --self-test` | **exit 0 / 198 全绿（无回归）**（`/tmp/p703/real-selftest-2.log`） |

现在 disk 那一例点的名是 **`fingerprint`**（disk 格自己、且判据会归回 disk 的成员），不再是不属于本格的
`degradeReason`；期望签名仍硬指「on-disk formats」那一格，**没放宽成匹配任意格**。

## 交接 / 复现命令

```bash
# 三态探针（在主仓根上跑；会读一次 npm registry 拿 versions 名单）
npm run check:version-states            # 四态全跑（含 S1 的整趟 --self-test，约 8 分钟）
npm run check:version-states -- --fast  # 只跑逐态判定（秒级，进 npm test 的就是这一档）
npm run check:version-states -- --only S2,S3 --keep   # 只跑某几态并留着合成树
# 桩留在 .scratch/version-states/fixtures/{S1,S2,S3,contradiction}.json（.scratch 已登记为 scratch 类）
```

合完树之后最终验收就直接跑：`npm run check:version-states`（命令自己从当前工作树现取事实，不需要适配）。

## 遗留 / 风险

1. **`test/test-suite-baseline.json` 没抬**：`check:test-summary` 打 `TEST-SUMMARY-HINT`（登记 3400 → 实测 3404，+4 =
   本单新增的 `test/version-state-probe-703.test.js`）。抬登记值按那台闸的口径是**人的动作**（它只提示不改写）。
2. **探针需要一次真 registry 读数**（`versions` 名单的真值在 npm，不在 CHANGELOG：`0.21.0` / `0.24.0` 就是
   「有日期但从未发布」两个反例）⇒ 离线环境跑它会 **exit 2 并说明原因**，不会静默假绿。CI 本来就能联网。
3. **探针在「下一版已经发布」的机器上 exit 2**（registry 里已经有 `v下一版` ⇒ S1 不再是合法态）——设计如此，
   它要的是「切版与发布之间」这个窗口；下一次发布之后请在下一次切版（CHANGELOG 出现更高段）之后再跑。
   同理：CHANGELOG 没有高于 `package.json` 的段时它也 exit 2（本单没让探针自己造一个段，避免把「切版」做成
   第二份回写规则）。
4. **`#690` 那族在纯删除版上依赖「注入型证人」**：现在有三重钉 —— 变异不落上算失败（框架原有）、
   注入名字必须归回本格（`surfaceCaseEvidence` 反查）、某格一个都不归本格时 `runSelfTest` 静态校查直接报。
5. 本单**没改** `docs/host-upgrade-guide-0.31.0*.md`（#698 地盘）、没改 CHANGELOG 段内容、没动 `src/`。
6. 合成树里发现的一个**与本单无关的硬伤**（没修，只记一笔）：`read()`（`scripts/docs-drift-check.mjs:265`）
   对「index 里有、磁盘上没有」的入库文件直接 `readFileSync` ENOENT 抛死整个检查（实测
   `/tmp/p703/S1-selftest-fixed.log`），而不是计成 READ_FAILURES ⇒ 半删除态的工树会把 `check:docs` 砸成
   一个带堆栈的崩溃。另：本仓是 linked worktree，`.git` 是指针文件 ⇒ 任何「`cp -a` 一份树」的探针配方
   都会让子树继续读原仓 index/refs（tag 面失控 + index 漂移即砸）。

## 探针跑的是哪棵树（交接要点）

`scripts/version-state-probe.mjs` 的合成树 = **它自己所在的那份工作树**（入库清单 `git ls-files` + 工树内容）。
本轮读数跑在 `feat-261104-01-selftest-3state-703` = **main `3da5d76` + #703**，**不含 #698**：
那两份 `docs/host-upgrade-guide-0.31.0*.md` 在本分支上 §4 仍是一段散文（#698 的地盘，本单不改）。
⇒ **最终 S1 验收必须在「main + #703 + #698」合起来的树上重跑 `npm run check:version-states`**（命令本身不需适配：
它从当前工作树现取事实，合完树直接跑就是那棵树的读数；只是 §4 从散文变六格 bullet 后，`#690` 那六例的
前提两半都成在，读数应该仍是 198 全绿或因 #698 加例而更高）。本单**不**预先改 `docs/host-upgrade-guide-0.31.0*.md`。

## 未完成

- [x] 6 例逐条归类与修复（上三节：**6 → 2 → 0**，两个独立根因）
- [x] registry 事实可注入（`--registry-json`）+ 它自己的反向证（`test/version-state-probe-703.test.js` 的 C/D 两例）
- [x] S1/S2/S3 三态探针（`scripts/version-state-probe.mjs` + `npm run check:version-states`）+ 矛盾态反向证
- [x] S1 合成树 `--self-test` exit 0 的最终读数（198 全绿，`/tmp/p703/probe-full2.log`）
- [x] 「main + #703 + #698」三态读数的**形状对照**（见下两节：`/tmp/p703/S1FULL2`、`/tmp/p703/M698`）
- [x] 真树 `--self-test` 仍 198 全绿（无回归，`/tmp/p703/real-selftest-2.log`）
- [ ] `npm test` / `check:test-summary` / `check:docs` / `:strict` / `check:docs-spelling` / `check:agents-directives` / `static-guards`（下表逐条回填）
- [x] 最终验收树（main + 切版 + #698 + #703）上的 `--self-test` 读数：**exit 0 / 198 全绿**（`/tmp/p703/S1FULL2-selftest.log`）
- [x] `npm test` / `check:test-summary` / `check:docs` / `:strict` / `check:docs-spelling` / `check:agents-directives` / `check:tests` / `static-guards`（上表逐条）
