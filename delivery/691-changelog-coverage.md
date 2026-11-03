# 691 — CHANGELOG 覆盖闸 + 0.30.0 段一次性补齐

分支 `feat-261103-05-changelog-coverage-691`，基点 main `1d1ba3c`，工作树
`/home/eric/projects/worktrees/erix-691`。实施分五个提交，本报告每一节都是**现跑现贴**的实测，
不写「应该」。

## 取证边界

实际打开 / 读取过的路径（全部在本工作树内，**没有**打不开的路径，因此没有 `BLOCKED:` 条目）：

- issue 正文与评论：`gh api repos/ErixWong/erix-agent/issues/691`（正文）＋
  `…/issues/691/comments`（判据定稿与实测数字那一条）。**这是唯一的仓外读取。**
- 新建：`scripts/changelog-coverage-check.mjs`、本报告。
- 改动：`package.json`、`.github/workflows/ci.yml`、`AGENTS.md` / `AGENTS_cn.md`、
  `scripts/release-day.mjs`、`CHANGELOG.md`、`docs/host-upgrade-guide-0.30.0.md` /
  `docs/host-upgrade-guide-0.30.0_cn.md`、`test/static-guards.test.js`。
- 只读脚本（读写法范式与口径，不改）：`scripts/docs-drift-check.mjs`（`SURFACE_CELLS` /
  `SURFACE_CHANGE_SHAPES` / `declaredSurfaceChanges` / `releaseAddedNames` / `guide-coverage`）、
  `scripts/guide-removal-gate.mjs`（登记表纪律与 `--self-test` 的范式来源）、
  `scripts/pack-link-check.mjs`（`CONTRACT_PUBLISH_EXEMPTION_MAX` 的双向对账口径）、
  `scripts/suite-summary-reconcile.mjs`（CI 接线自测的写法）、`scripts/agents-directive-scan.mjs`
  （A/B/C 三类与上限）、`scripts/mutation-sample-check.mjs`、`scripts/flat-count-inventory.mjs`、
  `scripts/config-leaf-value-probe.mjs`、`scripts/deprecated-export-check.mjs`、
  `scripts/bundle-guide-table.mjs`。
- 只读数据 / 文档：`CHANGELOG.md`（0.30.0 段与 0.31.0 段）、`docs/host-upgrade-guide-0.30.0{,_cn}.md`
  §1/§4/§4.1、`test/static-guards.test.js`（配对地板常量与它上方的历史 diagnostic）、
  `test/test-suite-baseline.json`、`delivery/688-delete-retired-exports.md` / `delivery/689-release-day.md`（格式）。
- 源码只读（为了写准条目）：`src/loop/orchestrator.js`（`type: "compaction"` 事件的载荷）、
  `src/compact/pipeline.js`、`src/loop/termination.js`、`src/providers/anthropic.js`（#429 三刀的
  `@deprecated` 标记 diff）、`src/tools/file-tools.js`、`src/tools/delegation/capacity.js`。
- git 只读（全部 `LC_ALL=C`）：`git log --first-parent --merges v0.29.0..v0.30.0 --pretty=%H%x1f%s`、
  `git diff --name-only <merge>^1 <merge>`（72 个合并逐个）、`git diff --numstat`（47 个合并的公开面
  文件增删行）、`git diff <merge>^1 <merge> -- <公开面文件>`（#429 三刀、#177/#246 的 README 模块地图行、
  #301/#417/#642/#644/#257/#586 的 `package.json` 那几行）、`git tag --list`、`git rev-parse v0.30.0`。
- 日志（都在 `/tmp`）：`/tmp/test-suite-691.log`（`npm test` 全量 TAP）、`/tmp/gates-691.txt`（30 条判据的
  逐条退出码）、`/tmp/analysis.json`（72 个合并的号/公开面文件的中间结果）、`/tmp/backfill.md`（44 条补记
  的草稿，落盘前逐条对着 `git diff --numstat` 校过）。
- 刻意没打开：`/home/eric/projects/erix-llm-kit`（任务红线）、`~/.erix/**`、真实 npm registry
  （`check:release` 自己离线跑，本单不联网发布）。

## 判据与类别边界（写进脚本里的那几条）

`scripts/changelog-coverage-check.mjs` 只回答一个问题：**「该不该有一条」**。判据一条：

```
碰到公开面的合并号  ⊆  本版 CHANGELOG 段的号  ∪  带 why 的豁免登记
```

**方向只查一边**。反向不查的理由是实测的：0.30.0 段里那 9 个号中有 2 个（`#109`、`#464`）在本区间
根本没有合并——它们是散文里的历史引用。反向判据会把这两条判成假红，所以不做。

「行为可见」用**路径类别**判，不靠人脑：

| 类别 | 路径 | 裁决 |
|---|---|---|
| 公开面 | `src/`、`bin/`、`package.json`、`README.md` / `README_cn.md`、`docs/host-consumer-contract{,_cn}.md`、`docs/requirements{,_cn}.md`、`docs/host-upgrade-guide-<本版>{,_cn}.md` | 必须被本版 CHANGELOG 段点名 |
| 类别豁免 | `test/`、非公开 `docs/`、`scripts/`、`delivery/`、`AGENTS*`、`.github/`、`examples/`、`fixtures/`、`skills/`、`CHANGELOG.md` 自身 | **规则算出来的**，不逐条登记 |
| 反向豁免 | 只碰测试 / 内部面、但确实行为可见 | 逐条进 `COVERAGE_EXEMPTIONS`，必须带 `why`；空转红、空 `why` 红、条数与 `COVERAGE_EXEMPTION_MAX` 双向红 |

两个刻意的口径选择，写在这里备查：

1. **`package.json` 整份算公开面**，不细分 `scripts` / `exports`。「这个键宿主管不管得着」是人的判断，
   一旦写进判据就会变成逐条豁免的借口；代价是「新增一条 npm script」也要一条 CHANGELOG 条目——本单的
   #301 / #257 / #417 / #586 / #642 / #644 / #429 七条就是这样补进来的（它们是命令面变更，本来也该有）。
2. **「本版升级指南」只认当前版本那一份**，历史指南不算。历史指南的措辞会随事实更新（#690 就是这样），
   那不是新行为；把它们算进公开面只会让「改一句历史措辞」变成必须开 CHANGELOG 条目。

区间与段**从树里现读，不手抄**：本版 = `CHANGELOG.md` 最新版本段（`--version` 可指定）；区间 = 版本序上
比本版小的最大 tag `..` 本版的 tag（本版没打 tag 时上端取 `HEAD`）；段 = 同一个文件里 `## [<本版>]` 到下一个
`## ` 之间。任一端读不出（无 tag / 段读不到 / git 不可用 / 某个合并的 diff 拿不到）⇒ **exit 2**。

### 今天真树上的三类计数（`node scripts/changelog-coverage-check.mjs` 现跑）

| 运行 | 区间 | 合并 | 碰公开面 | 类别豁免 | 公开面号 | 命中 | 登记豁免 | 缺项 | exit |
|---|---|---|---|---|---|---|---|---|---|
| 默认（本版 = 0.31.0，未打 tag） | `v0.30.0..HEAD` | 4 | 2 | 2 | 4 | 4 | 0 | 0 | 0 |
| `--version 0.30.0`（一次性补齐的验收面） | `v0.29.0..v0.30.0` | 72 | 53 | 19 | 53 | **53** | 0 | **0** | 0 |

0.30.0 那一跑还把**已知盲区**打印出来（只打印、不判红）：碰到公开面但合并主题里**没有 issue 号**的合并
4 个 —— `2fe4424`（`chore(release): 0.30.0 切版`）、`6e2f834`（0.30 中英宿主升级指南波）、`084668c`
（波12 c2：废弃闸逐版本 + 2 个宿主在用的导出挪到 0.31）、`039491d`（波12 c3：契约 capacity 双回收者并发）。
本闸靠合并主题里的号归因，这 4 个归不到任何条目上——要求「必须被某条条目点名」是做不到的，所以它不判红，
但绝不静默。

### 44 与 48 的差：把评论里那个数算清

评论里写「碰到公开面而 CHANGELOG 一个号都没提到 = 44」，本单实测到的**号**是 **48**。两个数都对，量的是
两件不同的事：

| 量 | 数 | 怎么来的 |
|---|---|---|
| 碰到公开面的合并 | 53 | `git diff --name-only <merge>^1 <merge>` 命中公开面规则 |
| 其中主题里**没有** issue 号的合并 | 4 | `2fe4424` / `6e2f834` / `084668c` / `039491d`（本闸无法归因，只打印） |
| 有号的公开面合并 | 49 | 53 − 4 |
| 其中**一个号都没**被 0.30.0 段提到 | **44** | 49 − 5（`#475`/`#657`/`#661`/`#673`/`#682` 各自所在的合并） |
| 被提到过、但**还有别的号没提** | 3 | `8e531ab`（#475 有、#484 无）、`8e97c41`（#657 有、#660 无）、`4d5015f`（#682 有、#684 无） |
| 没被覆盖的**号** | **48** | 44 个合并贡献 45 个号 + 那 3 个合并各补 1 个（484 / 660 / 684） |

⇒ 评论里的 44 = 53 − 9，把 `#109`/`#464`（区间外）与 `#678`/`#681`（来自一个只碰
`AGENTS*`/`scripts/`/`test/` 的合并，属类别豁免）也当成了覆盖项。按定稿判据（一边、按号）算，缺的是
**48 个号**；按「合并」算是 **44 个合并需要新条目**。本单两者都补齐：44 条新条目 + 3 条既有条目补 PR 号。

## 44 条补齐：条目 ↔ 来源 commit

每条都是**从它自己的合并提交现读**（主题 + 那次合并改了哪些公开面文件 + 增删行），按合并时间从早到晚
排在 `CHANGELOG.md` 0.30.0 段末尾的 `### 补记（issue #691）` 一节里，中英成对，条目末尾写着来源合并的短
sha 与「#691 补记」字样——**不伪装成发布当天写的**。

| # | 来源合并 | 公开面文件数 | 举例（最多 3 个） |
|---|---|---|---|
| #595 #503 #506 | `81541c5` | 3 | `docs/host-consumer-contract.md`, `_cn.md`, `src/loop/orchestrator.js` |
| #621 #208 | `165d48d` | 3 | 契约中英两份, `src/tools/file-tools.js` |
| #296 | `87c6879` | 5 | 契约中英两份, `src/loop/orchestrator.js` … |
| #640 | `bf2c88d` | 1 | `src/loop/continuity-block.js` |
| #586 | `af2d54e` | 1 | `package.json` |
| #257 | `3ee458d` | 1 | `package.json` |
| #473 #435 | `c92c8fa` | 11 | `README.md`, `README_cn.md`, `bin/cli.js` … |
| #194 | `b495364` | 1 | `src/tools/file-tools.js` |
| #637 | `ddcfc82` | 3 | 契约中英两份, `src/normalization/parse-model-json.js` |
| #641 | `f0d8fcd` | 3 | 契约中英两份, `src/loop/orchestrator.js` |
| #246 | `9efe38e` | 4 | `README.md`, `README_cn.md`, `src/loop/orchestrator.js` … |
| #511 | `2065a26` | 2 | 契约中英两份 |
| #286 | `f959722` | 2 | 契约中英两份 |
| #429 | `b508528` | 10 | `package.json`, `src/providers/anthropic.js`, `src/tokens.js` … |
| #642 #429 | `f4733ce` | 1 | `package.json` |
| #375 #286 | `d067d54` | 4 | 契约中英两份, `src/tools/file-tools.js`, `src/tools/index.js` |
| #308 #286 #375 | `ac3ca5d` | 4 | 两份 README, 契约中英两份 |
| #246 | `fd3ad48` | 4 | 两份 README, `src/loop/orchestrator.js`, `src/loop/state-view.js` |
| #643 | `a65acba` | 6 | 两份 README, 契约中英两份, `src/compact/budget-fit.js` … |
| #644 | `3dca9a7` | 1 | `package.json` |
| #286 | `4840004` | 2 | 契约中英两份 |
| #417 | `ff4cf11` | 1 | `package.json` |
| #567 | `83796b9` | 4 | 契约中英两份, `src/compact/fold-summary-journal.js`, `src/loop/orchestrator.js` |
| #519 | `2d310b6` | 4 | 契约中英两份, `src/assembly.js`, `src/loop/option-normalization.js` |
| #436 #435 | `8e4fcf8` | 5 | 契约中英两份, `src/loop/orchestrator.js`, `src/reflection/governor.js` … |
| #192 | `9579798` | 2 | `src/loop/provider-runner.js`, `src/loop/termination.js` |
| #417 #192 | `b232e17` | 1 | `src/loop/provider-runner.js` |
| #519 | `64aca52` | 1 | `src/loop/orchestrator.js` |
| #375 | `9c0fbeb` | 1 | `src/tools/file-tools.js` |
| #648 | `5bb7f12` | 3 | 契约中英两份, `src/loop/termination.js` |
| #518 #297 | `69e39f7` | 2 | 契约中英两份 |
| #301 | `2e996b2` | 1 | `package.json` |
| #177 | `91dbe09` | 6 | 两份 README, 契约中英两份, `src/loop/judge-runner.js` … |
| #429 | `cbb695c` | 1 | `src/providers/anthropic.js` |
| #652 | `111537b` | 4 | 契约中英两份, `src/tools/delegation/capacity.js`, `…/tool.js` |
| #644 #635 | `78fb44f` | 2 | 两份 README |
| #650 #668 | `efeef10` | 4 | 两份 README, 契约中英两份 |
| #668 | `ba98ff6` | 2 | `docs/requirements.md`, `_cn.md` |
| #476 | `26e5a0c` | 4 | 契约中英两份, `src/loop/orchestrator.js`, `src/loop/termination.js` |
| #663 #429 | `a68137f` | 6 | 两份 README, 契约中英两份, 需求中英两份 |
| #674 #429 | `086781d` | 1 | `src/providers/anthropic.js` |
| #675 #498 | `e6713ab` | 2 | 契约中英两份 |
| #680 #668 | `27e0063` | 2 | `src/compact/fold-statistical.js`, `src/compact/provider-summarizer.js` |
| #683 #677 | `99fe074` | 2 | 契约中英两份 |

另外三条**不是新条目**，只给既有条目补上它们的 PR 号（同一个合并里已有一个号被写到，缺的是 PR 号）：
`8e531ab` → `#475` 条目补 **PR #484**；`8e97c41` → `#657` 条目补 **PR #660**；`4d5015f` → `#682` 条目补
**PR #684**。0.31.0 段同理：`9b370df` → `#688` 条目补 **PR #694**；新写 `#689` 条目（含 **PR #695**）。

## 对 #690 那把秤（`unchanged-surface`）的影响与处置

`unchanged-surface` 读的正是 **`package.json` 那一版（0.30.0）** 的 CHANGELOG 段：它把段里每一句带反引号
字段名、且带「变更形状」的句子归到六格里，再要求指南 §4 对应那格不许写「不变」。补记落进 0.30.0 段之后
这一步的实测（`node scripts/docs-drift-check.mjs --verbose`）：

```
✓ unchanged-surface: CHANGELOG 0.30.0 段解析出 203 处反引号字段名，其中 7 处是变更证据、
  落到 3 格（diagnostics / disk / finalPayload）；指南 …0.30.0.md / …_cn.md 各判 6 格
```

三格（诊断字段 / 磁盘格式 / 终局载荷）本来就是「这一版变了」，补记只是让它们的证据变多；`options` /
`defaults` / `events` 三格**机械上没有翻**。但「闸不响」不等于「文案是真的」——按事实核了一遍，有两处
确实该改（都已改，见下一节）：

1. **`#519`（`2d310b6`，0.30.0 破坏项）**：同一个键在装配端口与调用点各给一次，以前一侧静默赢，现在**启动期
   直接抛**。指南 §4 的「Options — unchanged」和 §1 的「no option … moves」都不含这条 ⇒ 改成
   「名字不变，一条接受规则变严了」并点名 #519。闸对这一格没有字段真值（`assemblyPort.provider` 不是六格
   成员），所以这条是**按事实改的，不是被闸逼着改的**。
2. **§4 末尾那条「notes 工具面、文件工具、派生簿记模块、provider 协议件」的清单**：补记里有三笔直接改了
   `src/tools/file-tools.js`（`~` 只认 `~/`，`#194`；区间引用与单行引用共用一条剥号路径，`#621`）与
   `src/tools/delegation/capacity.js`（占格改「全量写临时文件 + `link(2)` 发布」，`#652`）。**导出名一个没变、
   边界行为变了**，所以那句「这些都没动」是假话 ⇒ 改成「真正没动的：notes 工具面 / provider 协议件 /
   零依赖规矩」+ 一条点名那两个模块的边界变更。
3. **§1 变更摘要第 3 行**（`no option, default, event or on-disk format moves`）与 §4 自相矛盾：§4 自己说
   磁盘格式变了（那是 #690 那一刀留下的）。本单把这一行改成「除了 §4 逐格列出的那几处」——这是**修一处
   既存矛盾**，不是本单造成的，但补记让它更显眼，所以一并处置。

**没有**为了让文案过关去动闸的判据：`scripts/docs-drift-check.mjs` 一个字节没改，
`node scripts/docs-drift-check.mjs --self-test` 仍是 **189 例全绿**（与 main 同数）。

`check:docs` 的另一把秤（`guide-coverage`）也没被牵动：`releaseAddedNames` 只认「加法句 + 代码侧清单里的
名字」，补记里的加法句点到 5 个名字（与改前同数），两份指南都提到了它们。

## 自测条数与反向证

`node scripts/changelog-coverage-check.mjs --self-test` = **18 条判据全绿**，全部跑在 `os.tmpdir()` 里
**自建的合成 git 仓**上（自己 `git init`、造 tag `v1.0.0`、造分支、`git merge --no-ff` 造合并），
**不读本仓历史、不依赖本机 tag 面**：

| 例 | 钉的是什么 |
|---|---|
| ① | 合并碰 `src/` 而本版段没写它 ⇒ 红 `MISSING_COVERAGE`，点名号 + 短 sha + 公开面文件 |
| ①b | 把那个号补进本版段 ⇒ 缺项消失、绿（正向那条真的在判段里有没有它） |
| ② | **同一条合并改成只碰 `test/` ⇒ 绿**（类别豁免生效，不是碰巧没扫到） |
| ③ | 登记表里挂一条**已补齐**的号 ⇒ 红 `EXEMPTION_IDLE`（空转条目就是后门） |
| ④ | 登记理由写成空白 ⇒ 红 `EXEMPTION_NO_WHY` |
| ④b | 登记表条数与上限**双向**漂移（多一条 / 少一条）⇒ 都红 `EXEMPTION_COUNT_DRIFT` |
| ④c | 放行证：给一个真缺项的号登记带 why 的豁免 ⇒ 绿（登记分支真的被读到，不是恒红） |
| ⑤ | 区间一端没有 tag ⇒ exit 2 `RANGE_UNRESOLVED`（不是绿） |
| ⑤b | 本版段在 CHANGELOG 里读不到 ⇒ exit 2 `NO_VERSION_SECTION` |
| ⑤c | CHANGELOG 里一个版本段都解析不出 ⇒ exit 2 `SECTION_UNREADABLE` |
| ⑤d | git 不可用（不是仓）⇒ exit 2 `GIT_UNAVAILABLE` |
| ⑥ | **`#398③` 归一到 398**（写成断言：`issueNumbersIn("Merge PR #398③: …")` 必须等于 `[398]`） |
| ⑥b | 多个号 + 裸圈码 `①②③` ⇒ 只抽出真正的号（`[286, 308, 375]`），裸圈码不算号 |
| ⑥c | 端到端：主题写 `#398③`、本版段写 `#398` ⇒ 判成覆盖（归一在抽号里发生，不在比对里） |
| ⑦ | 区间与段都从树里现读：打了 tag 的版本按 tag 判，未打 tag 的最新段按 `HEAD` 判 |
| ⑧ | CI / `package.json` / 两份 AGENTS 的接线：阻塞步存在、位置在 `check:test-summary` 之后 `check:docs` 之前、checkout 取全历史 |
| ⑧b | 把 CI 里那一行删掉 ⇒ 接线检查必须点名（**变异没落上算失败**：`mutated !== ciText` 也断言了） |
| ⑧c | 去掉 checkout 的 `fetch-depth: 0` ⇒ 接线检查必须点名 |

「变异没落上算失败」在这套自测里落在两处：⑧b/⑧c 都先断言 `mutated !== ciText`（文本真的变了）才判红；
①b/④c/⑥c/⑦ 是**放行侧**的对照，防的是「判据恒红也全绿」那类假通过。

## 接线路径（CI + AGENTS + preflight）

1. **CI**（`.github/workflows/ci.yml`）：新增阻塞步 `CHANGELOG coverage of public-surface merges`
   → `npm run check:changelog`，位置在 `Test suite summary reconcile self-test` 之后、
   `Documentation drift check`（`check:docs`）之前。同一步还加了 **`fetch-depth: 0`**——这是本闸的硬前置：
   默认浅克隆既没有 tag 也没有合并史，那时它按设计 exit 2（读不出真值 ≠ 绿），CI 会一直红。
2. **`package.json`**：`"check:changelog": "node scripts/changelog-coverage-check.mjs"`。
3. **AGENTS**（`AGENTS.md` / `AGENTS_cn.md`）：命令表各加一行（说明里**没有抄判据条数**），并把 §4 发版前
   清单从 `[1/5]…[5/5]` 改成 `[1/6]…[6/6]`，第 1 步是 `check:changelog`。
4. **`release:day` 的 preflight**（`scripts/release-day.mjs`）：`PREFLIGHT_STEPS` 第 1 位插
   `{ id: "changelog", label: "check:changelog" }`，于是 `npm run release:day -- --stage preflight` 的第一
   步就是它，红就停在那一步并点名（口径与既有五步一致）；`AGENTS*.md` §4 与脚本顶部注释同步成六步。

## 改动了既有期望的地方（逐条理由）

| 位置 | 改前 → 改后 | 为什么 |
|---|---|---|
| `scripts/release-day.mjs` 自测 ① | `failedAt === 4` → `=== 5`；「第 5 步」→「第 6 步」 | preflight 多了第 1 步，`release` 从第 4 步变第 5 步。判据没变，锚点跟着步表走 |
| `scripts/release-day.mjs` 自测 ②c | `steps.length === 5` → `=== PREFLIGHT_STEPS.length` | 同上；顺手把硬编码 5 换成步表长度，下次加步不会再红一次 |
| `test/static-guards.test.js` `CHANGELOG_PAIR_FLOOR` | 2 → 3 | 0.31.0 段新增一对条目（`#689`），校准面实测 3 对。守卫自己打印的 diagnostic 原文已贴到常量上方（本仓惯例：先贴实测、再动常量） |
| `docs/host-upgrade-guide-0.30.0{,_cn}.md` §4「选项」格 | 「不变」→「名字不变，一条接受规则变严了」+ 点名 `#519` | 见上一节第 1 条：这是按事实改，闸没有字段真值 |
| `docs/host-upgrade-guide-0.30.0{,_cn}.md` §4 末尾模块清单 | 「notes 工具面、文件工具、派生簿记模块、provider 协议件」都「不变」→ 只留真正没动的 + 点名两个模块的边界变更 | 见上一节第 2 条 |
| `docs/host-upgrade-guide-0.30.0{,_cn}.md` §1 变更摘要第 3 行 | 「no option, default, event or on-disk format moves」→「除了 §4 逐格列出的那几处」 | 与 §4 自相矛盾的既存句（#690 那一刀留下的），补记让它更显眼 |
| `CHANGELOG.md` 0.30.0 段既有三条条目 | 补上 `PR #484` / `PR #660` / `PR #684` | 那三个合并里各有一个号已写到、PR 号没写；判据按号算，缺一个号就是缺项 |
| `CHANGELOG.md` 0.31.0 段 `#688` 条目 | 补上 `PR #694` | 同上 |

**没有**改的：`scripts/docs-drift-check.mjs`（一把秤的判据一个字节没动）、`test/test-suite-baseline.json`
（本次实测 `tests=3400 / fail=0 / skipped=13`，`skipped 13 ≤ 15`，没有任何漂移，所以按「只按实测改」的
纪律**不改**）、`test/compat-pin-inventory.md`（`check:inventory` 逐文件 0 处不一致，不需要 `--sync`）、
`src/compact/fold-llm.js`（CI 变异靶，没碰）。

## 判据清单（逐条退出码）

`npm test` 的 TAP 汇总：`# tests 3400` / `# pass 3387` / `# fail 0` / `# cancelled 0` / `# skipped 13` /
`# todo 0`（日志 `/tmp/test-suite-691.log`）。

```
check:syntax                                         exit=0   465 个跟踪文件全过
changelog --self-test                                exit=0   18 条判据
changelog (本版 0.31.0，v0.30.0..HEAD)               exit=0   命中 4 / 豁免 0 / 缺项 0
changelog --version 0.30.0 (v0.29.0..v0.30.0)        exit=0   命中 53 / 豁免 0 / 缺项 0（另打印 4 个无法归因的合并）
npm test                                             exit=0   tests 3400 / pass 3387 / fail 0 / skipped 13
check:test-summary -- --log <log>                    exit=0   TEST-SUMMARY-VERDICT ok
check:test-summary -- --self-test                    exit=0   16 例
check:docs                                           exit=0   122 项 + 中英契约 106 节
check:docs:strict                                    exit=0
docs-drift-check --self-test                         exit=0   189 例（与 main 同数）
check:docs-spelling                                  exit=0   0 处红
check:agents-directives                              exit=0   A/B/C 逐格等于实测
agents-directive-scan --self-test                    exit=0   16 例 × 3 种欠账形态
check:docs-examples                                  exit=0
check:pack-links                                     exit=0   2 处声明位 = 87 个随包 .d.ts
pack-link-check --self-test                          exit=0   18 例
check:inventory                                      exit=0   逐文件 0 处不一致
check:config-leaf-values                             exit=0   两张表与实测一致
check:mutation                                       exit=0   16 条样本 / 8 个目标文件 / 12 个捕获者，0 处不一致
mutation-sample-check --self-test                    exit=0   26 例
check:types                                          exit=0   94 错 / 26 文件（基线 103）
check:types -- --with-tools                          exit=0   129 错 / 28 文件（基线 138）
check:types:strict                                   exit=0   1845 错 / 70 文件（基线 1892）
check:types:strict -- --with-tools                   exit=0   2058 错 / 76 文件（基线 2122）
check:types-build                                    exit=0   87 个 .d.ts，断言全过，跑完自清
check:exports:deprecated                             exit=0
guide-removal-gate --self-test                       exit=0   18 例
test-hygiene-check --self-test                       exit=0   13 例
release-day --self-test                              exit=0   51 例（加了 preflight 第 1 步之后重跑）
check:release                                        exit=0   6 步全绿，19.4s
```

`check:mutation:run` 与 `check:release:real` 按派单要求**没有跑**。

## 未验证项 / 已知盲区

1. **本闸在 CI 上还没真跑过。** 本地 30 条判据全绿、接线检查（含 `fetch-depth: 0`）由 `--self-test` 钉住，
   但「GitHub Actions 上 `git tag` 与合并史真的在」只有推上去才看得见。这是**本单唯一的未验证面**。
2. **主题里没有 issue 号的合并归不了因。** 0.30.0 区间有 4 个（`2fe4424` / `6e2f834` / `084668c` / `039491d`）。
   本闸只打印不判红：要求它「必须被某条条目点名」在判据上做不到（没有号可比）。要堵这个洞得改归因口径
   （例如按 merge commit 的 body 抽号，或要求「碰公开面就必须带号」），那是另一件工单。
3. **`package.json` 整份算公开面**带来一条噪声：只加 npm script 的合并也要一条 CHANGELOG 条目。本单照这个
   口径补了 7 条（#301 / #257 / #417 / #586 / #642 / #644 / #429 之一）。若判据日后要细化到「只认随包字段」，
   那是收紧/放宽口径的独立决定，不该在补记这一单里顺手做。
4. **历史段（0.20–0.28）不回填。** 那些版本多数没有 tag，本闸的区间口径对它们不成立；本单只对
   「上一个 tag → 本版」生效，与 issue 的「不做」一致。
5. **`#475`/`#657`/`#682` 三条既有条目的正文没重写**，只补了 PR 号；它们的叙述与合并提交一致与否不在本单
   的判据面内（本闸只查有无，不评语义）。
6. **`--self-test` 的合成仓用的是本机 `git`**（`node:child_process` 调 `git`）。若某台机器没有 git，
   `--self-test` 会红在「合成仓建不起来」而不是跳过——这是有意的（读不出 ≠ 绿），但意味着本闸的自测依赖 git。
