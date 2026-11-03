# #700 补齐 0.31.0 段欠的 CHANGELOG 条目（`check:changelog` 点名的 #691 / #696）

- 工单：ErixWong/erix-agent#700（纯 CHANGELOG 内容活）
- 分支：`feat-261103-10-changelog-entries-700`，基点 main `dc5783f`
- 唯一判据：`npm run check:changelog` **exit 0**（改前 exit 1，见「闸前后对照」）

## 取证边界

**打开过（读）的路径** —— 全部读成功，无 `BLOCKED`：

- `CHANGELOG.md`（`## [Unreleased]` / `## [0.31.0]` 全段、`## [0.30.0]` 的 `### 补记（issue #691）` 那批条目形状）
- `scripts/changelog-coverage-check.mjs`（`PUBLIC_SURFACE_RULES` / `EXEMPT_CATEGORIES` /
  `COVERAGE_EXEMPTIONS` / `issueNumbersIn()` / 裁决段 / `unattributed` 只打印不判红那半边）
- `test/static-guards.test.js`（规则 8 R1–R5、规则 9 中英配对判据 + 配对地板 `CHANGELOG_PAIR_FLOOR` /
  `CHANGELOG_PAIR_FLOOR_SURFACE`、以及 `resolveChangelogScanSurface` 的「顶部 Unreleased 为空 ⇒ 退到刚开的版本节」）
- `AGENTS.md`（§3 `check:changelog` 行、§4 人工补偿清单）、`delivery/697-changelog-date-gate.md`（本报告形状）
- `package.json`（scripts 面）、`docs/host-upgrade-guide-0.30.0.md`（那条合并对它的改动，用来核对摘要口径）

**真跑（真实真值面，就在本工作树）**

- `npm run check:changelog` 改前/改后各跑一次（真 git 历史 + 真 tag 面：`v0.30.0..HEAD`，0.31.0 无 tag ⇒ 上端 `HEAD`）。
- 区间与公开面**自己复核过一遍**，不是照抄闸的措辞：
  `LC_ALL=C git log --first-parent --merges v0.30.0..HEAD --pretty='%h|%s'`（6 条合并）+
  逐条 `LC_ALL=C git diff --name-only <merge>^1 <merge>`（取号一律 `LC_ALL=C`，避开 `#398③` 那类带圈字符）。
- `node scripts/changelog-coverage-check.mjs --self-test`：18 条判据全过（合成 git 仓，不依赖本仓历史）。
- 配对地板是**派生数字**：先跑守卫拿到它自己打印的 diagnostic（「实测 4 对 > 地板 3 对 ⇒ 可以抬地板到 4」），
  再把 `CHANGELOG_PAIR_FLOOR` 抬到 4；抬后再跑，反向证仍证得到拦截力（删一条英文 ⇒ 3 对「已穿底」）。
  两段 diagnostic 原文都贴进 `test/static-guards.test.js` 的注释里（顺序反了就等于拿常量凑实测）。
- 中英成对自查用守卫自己的口径（整条 bullet 解析 + CJK 占比判语种 + issue 集合相等才算配对）现算，见下表。

**没做的（边界）**

- 没有改 `scripts/changelog-coverage-check.mjs` 一行：本单是**内容活**，判据本身不动，也不新增任何豁免
  （`COVERAGE_EXEMPTIONS` 仍是空表、`COVERAGE_EXEMPTION_MAX` 仍是 0）。
- 没有跑 types 家族、`check:release`、`check:release:real`、`check:mutation:run`（工单写明纯 CHANGELOG 活用不到）。
- 没有跑 `check:agents-directives` 与其 `--self-test`：**AGENTS\* 一个字都没动**（`git diff --stat dc5783f..HEAD`
  只有 `CHANGELOG.md` 与 `test/static-guards.test.js`），且那道闸对 `CHANGELOG.md` 是「计数不裁决」。
- 没动 `package.json` 的版本、没动段首（`## [0.31.0]（未发布 / unpublished）` 仍不带日期，#697 的口径）。

## 补了哪几条（每条的现查证据）

闸点名的缺项是 **2 个号**，但它们来自**同一条合并**，所以补的是 **1 条条目（中英一对）**——
形状照抄同段 `#688 / PR #694`、`#689 / PR #695`：归因括号里同时给出 issue 号与 PR 号，条目里带合并短 sha。

| 补的条目 | 号 | 合并 sha（现查） | 它碰到的公开面文件（现查） |
|---|---|---|---|
| `### Added` 里新增一对：`npm run check:changelog` 落地 | `#691`（issue）、`#696`（PR）、`#700`（本单自登记） | `a5cc4baa3c72fa28f14a3bf85a2f53da06131f0d`（短 `a5cc4ba`，`git log` 现查） | **只有 `package.json`**：`+ "check:changelog": "node scripts/changelog-coverage-check.mjs"`（`git diff a5cc4ba^1 a5cc4ba -- package.json` 现读） |

摘要内容**全部从那条合并自己现读**，不凭记忆：

- 主题：`Merge PR #696: #691 CHANGELOG 覆盖闸 + 0.30.0 段一次性补齐 44 条`。
- first-parent diff 的 11 个文件里，只有 `package.json` 命中 `PUBLIC_SURFACE_RULES`；其余
  `.github/workflows/ci.yml`（+20：阻塞步骤 + checkout `fetch-depth: 0`）、`scripts/changelog-coverage-check.mjs`（新增 1003 行）、
  `scripts/release-day.mjs`（preflight 五步 → 六步，新闸是第 1 步）、`CHANGELOG.md`（+305：0.30.0 段那 44 条补记）、
  `AGENTS*`、`delivery/`、`test/`、`docs/host-upgrade-guide-0.30.0*.md`（**历史**指南，非本版）全归**类别豁免**。
- 「浅克隆 ⇒ 浅历史 + 无 tag ⇒ 闸只能 exit 2」这句写进条目，是从 `ci.yml` 那段 diff 的注释里读来的，不是推断。
- 病根数字（53 个合并碰到公开面 / 44 个合并一个号都没有 / 落到号上 48 个 / 人工只找出 4 条）读自
  `scripts/changelog-coverage-check.mjs` 头注与 `CHANGELOG.md` 里 0.30.0 段 `### 补记` 的引子段。

**闸没点名、因此**没有**补条目的合并**（如实记录，不顺手加）：

| 合并 | 公开面？ | 判据依据 |
|---|---|---|
| `dc5783f`（PR #701 / `#697`） | 否 | first-parent diff 只有 `AGENTS*` / `CHANGELOG.md` / `delivery/` / `scripts/` / `test/` ⇒ 类别豁免 ⇒ `#697` 与 `#701` 两个号**都不要求**进段（工单第 3 条是「若闸点名」的条件式，实测没点名） |
| `1d86fbc`（PR #693 / `#690`） | 否 | 只碰 `docs/host-upgrade-guide-0.30.0*.md`（历史指南）与 `scripts/docs-drift-check.mjs`；本版是 0.31.0 ⇒ `guide` 规则只认 `docs/host-upgrade-guide-0.31.0*.md` |
| `00baa4b`（PR #692 / `#687`） | 否 | `scripts/` + `AGENTS*` + `.github/` + `test/` |

碰到公开面的 3 条（`a5cc4ba`、`1d1ba3c`、`9b370df`）现在**全部**在段里：`#688/#694`、`#689/#695` 早就有，`#691/#696` 本单补上。

## 闸前后对照（`npm run check:changelog` 原样）

改前（**exit 1**）：

```
  · 区间合并 6 个，其中碰到公开面 3 个（类别豁免 3 个：agents=4 changelog=1 delivery=1 scripts=5 test=4 internal-docs=2 ci=1）
  · 公开面合并号 6 个：命中 4 / 登记豁免 0 / 缺项 2
  ✗ #691 的合并 a5cc4ba 碰到了公开面（package.json），而 0.31.0 段里没有它
  ✗ #696 的合并 a5cc4ba 碰到了公开面（package.json），而 0.31.0 段里没有它
changelog-coverage: 红 2 处（缺项 2 个，见上）
```

（本工单描述里写的是「区间合并 5 个 / 类别豁免 2 个」；当场实测是 **6 个 / 3 个**——基点 `dc5783f` 已经比
写工单时多了一条合并（PR #701），但它是类别豁免，缺项集合不变。以当场输出为准。）

改后（**exit 0**）：

```
  · 区间合并 6 个，其中碰到公开面 3 个（类别豁免 3 个：agents=4 changelog=1 delivery=1 scripts=5 test=4 internal-docs=2 ci=1）
  · 公开面合并号 6 个：命中 6 / 登记豁免 0 / 缺项 0
changelog-coverage: OK — 0.31.0 段覆盖了区间 v0.30.0..v0.31.0 里每一个碰到公开面的合并号（命中 6 / 登记豁免 0 / 缺项 0）
```

## 中英成对自查（用守卫自己的口径现算）

`## [0.31.0]` 段的 8 条 bullet（用 `test/static-guards.test.js` 的解析单位 + CJK 占比判语种 + `#NNN` 取号现算）：

```
L10  en [688,694]           - **The sixteen names the 0.30.0 guide announced are reall
L31  en [686]               - **Errata for the 0.30.0 page (issue #686).** 0.30.0 regi
L35  cn [688,694]           - **0.30.0 指南宣布的那 16 个名字现在真的删了（issue #688，PR #694）。**
L52  en [689,695]           - **The release day is one command, minus the half only a
L58  cn [689,695]           - **发版日收敛成一条命令，人工只剩那一半（issue #689，PR #695）。**
L63  cn [686]               - **0.30.0 那一页的勘误（issue #686）。** 0.30.0 登记了标记
L68  en [686,691,696,700]   - **`npm run check:changelog` lands: a merge that touched      ← 本单
L93  cn [686,691,696,700]   - **新增 `npm run check:changelog`：碰到公开面的合并必须在本版 CHANGELOG 段   ← 本单
```

- 新加的两条语种判定正确（一 `en` 一 `cn`），**issue 引用集合逐字相等**（`[686,691,696,700]`）⇒ 配对判据成立。
- 守卫当场打印：`中文 4 条 / 英文 4 条 / 配对 4 对（其中按「无 issue 引用 + 紧邻」配的 0 对）/ 无对应 0 条`。
- 本单自登记：`#700` 在中英两份里各出现一次（`backfilled by #700` / `#700 补记`），照 0.30.0 段
  「`；#691 补记`」的同一种归因形状，没有为它另开一条（本单的合并只碰 `CHANGELOG.md` 与 `test/` ⇒ 类别豁免，
  闸不要求条目；按 #702 的约定主动登记）。
- R1（同节逐字不重复）、R4（同语言 + 同 issue 集合 + 同反引号符号集合算近重复）、R5（小节顺序 + 无段首游离
  正文）三条也自查过：新条目的 issue 集合在本语言内唯一；新小节 `### Added` 不在 R5 的必需三件里
  （`changelogExpectedShapeComplaints()` 独立推导，形状判词跟着面走）；条目正文全部是 bullet + 两空格缩进续行。

## 派生数字：配对地板 3 → 4（先贴 diagnostic，再动常量）

`CHANGELOG_PAIR_FLOOR` 是在校准面 `## [0.31.0]（未发布 / unpublished）` 上**实测**的配对数，
新增一对条目 ⇒ 必须重测（守卫自己判红：「配对变多了 ⇒ 请抬地板到实测值」）。抬前/抬后两条 diagnostic 原文
已逐字贴进 `test/static-guards.test.js` 的注释；抬后该格 `ok`，反向证仍打印「删掉英文条目 ⇒ 3 对（地板 4，已穿底）」。

## 门禁实测（逐条退出码）

| 命令 | 退出码 | 当场事实 |
|---|---|---|
| `npm run check:changelog` | **0** | `命中 6 / 登记豁免 0 / 缺项 0`（唯一判据） |
| `npm run check:docs` | 0 | `docs-drift-check: OK … 共 123 项对齐 package.json 0.30.0 与源码` + `docs-sync-check: OK（106 节）` |
| `npm run check:docs:strict` | 0 | 同上，`--strict` 无升级项 |
| `npm run check:docs-spelling` | 0 | `--strict: OK — 0 处红`（④ 有命中却没钉 0 份；⑥ 退役措辞行 227 处不计入） |
| `npm run check:agents-directives` / `--self-test` | 跳过 | 本单**没动** `AGENTS*`（diff 只有 `CHANGELOG.md` + `test/static-guards.test.js`），且该闸对 `CHANGELOG.md` 计数不裁决 |
| `npm run check:syntax` | 0 | 全量 465 个跟踪 `.js/.mjs/.cjs` 过 `node --check` |
| `npm test` | 0 | `tests 3400 / pass 3387 / fail 0 / skipped 13`（四计数，装了 dev 工具链的那一轮） |
| `npm run check:test-summary -- --log <log>` | 0 | `TEST-SUMMARY tests=3400 pass=3387 fail=0 skipped=13` + `TEST-SUMMARY-VERDICT ok` |
| `node scripts/changelog-coverage-check.mjs --self-test` | 0 | 18 条判据按预期（额外自证，非工单清单要求） |
| `test/static-guards.test.js` 单跑 | 0 | 54 tests / 54 pass / 0 fail（配对地板那格 `ok`） |

**`check:test-summary` 第一轮的 red 是环境，不是本刀**：本工作树 `node_modules` 是空的，
`typescript` / `@types/node` 没装 ⇒ 4 条 `# SKIP typescript 未安装（devDependency…）` 的用例落进 skipped，
`skipped 17 > 登记上限 15` 判红 `SKIPPED_OVER`。`npm install --include=dev --offline` 之后重跑：
`tests 3400 / pass 3387 / fail 0 / skipped 13` ⇒ `TEST-SUMMARY-VERDICT ok`。`tests` 与登记值逐字相等
（3400 = 3400）、`fail` 恒 0 ⇒ 本单既没加用例也没掉用例（diff 里只有一处**注释**改动 + 常量 3→4）。

## 未验证项 / 遗留

- **没跑**：types 家族（`check:types` / `:strict` / `:build`）、`check:release`、`check:release:real`、
  `check:mutation:run`（工单边界写明用不到）；`check:docs-examples` / `check:pack-links` / `check:inventory` /
  `check:config-leaf-values` / `check:mutation` 也没跑——本单不碰源码、不碰 `files`/`exports`、不碰钉表与
  变异样本表，CI 里它们仍会跑。
- `npm run check:test-summary` 的**空 `node_modules` 环境**这一轮是红的（`SKIPPED_OVER +2`）；CI 用
  `npm install --include=dev`，那里是绿的。这是登记基线自己的口径（上限是「已量到的最大环境」），不是待修的事。
- 合并时的冲突面（给主 agent）：并行分支 `feat-261103-09-docs-gate-fixes-699`（#702）只动 `AGENTS*` /
  `scripts/docs-drift-check.mjs` / `scripts/release-day.mjs` / `delivery/699-*` / `docs/host-upgrade-guide-0.31.0_cn.md`，
  **没动 `CHANGELOG.md`、也没动 `CHANGELOG_PAIR_FLOOR`**（它的地板工作已在 main `dc5783f` 里）⇒ 预期与本单无冲突。
  若之后任何分支又往 `## [0.31.0]` 段加条目，合并后**必须重测**配对地板（守卫会打印实测值，手抄数字就是伪造）。
- 本单合并主题的注意点：它只碰 `CHANGELOG.md` + `test/`（+ 本 `delivery/` 报告）⇒ 类别豁免，闸不会因为
  主题里的号而红；而 `#700` 已经在段里，所以即便那条合并日后被算成公开面，段里也已经认得它。
- 段首仍是 `## [0.31.0]（未发布 / unpublished）`（无日期）——发布态回写时由 `docs-drift-check.mjs --sync` 与
  tag 日期一起改，本单不碰。
