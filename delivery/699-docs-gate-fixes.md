# #699（主）+ #702（顺带）：文档闸四格误报修复 + 发布面约定

- 分支：`feat-261103-09-docs-gate-fixes-699`
- 基点：main `dc5783f`（已含 #697 的段首日期闸）
- 版本面：本版仍 `0.30.0`；`0.31.0` 只作为**合成切版树**出现在 `/tmp/b699/` 下的副本里（不提交、不改 `package.json`）
- 纪律：每格一次 commit；每格的实测数据当场追加进本文件

## 取证边界

打开过（读 / 跑）的绝对路径：

| 路径 | 用途 |
|---|---|
| `/home/eric/projects/worktrees/erix-699/scripts/docs-drift-check.mjs` | ①②③④ 四格的判据与自测都在这一个文件里 |
| `/home/eric/projects/worktrees/erix-699/scripts/release-day.mjs` | ④ 的窄面反向证（`--sync` 的逐字节比对夹具 `SYNC_FIXTURE`） |
| `/home/eric/projects/worktrees/erix-699/docs/requirements.md` | ④ 的阶段表 `current` 行（`v0.9.0–v0.30.0 — current`） |
| `/home/eric/projects/worktrees/erix-699/docs/requirements_cn.md` | ④ 的中文侧同一行 |
| `/home/eric/projects/worktrees/erix-699/docs/host-upgrade-guide-0.30.0.md` / `_cn.md` | #690 自测靶子（当前版指南 §4 的 bullet 形状） |
| `/home/eric/projects/worktrees/erix-699/docs/host-upgrade-guide-0.31.0.md` / `_cn.md` | 合成 0.31 树上的当前版指南（§4 是**散文**形状，与 0.30 的 bullet 形状不同） |
| `/home/eric/projects/worktrees/erix-699/CHANGELOG.md` | 0.31.0 段（纯删除 + 勘误 + 发版流程，零加法句）与 0.30.0 段（有变更证据） |
| `/home/eric/projects/worktrees/erix-699/AGENTS.md` / `AGENTS_cn.md` | #702 的落点（中英成对） |
| `/home/eric/projects/worktrees/erix-699/scripts/changelog-coverage-check.mjs` | #702 要写进约定面的那三条事实（`issueNumbersIn()` / 段侧取号 / 裁决比较 / `unattributed` note） |
| `/tmp/b699/selftest-before.log` | 真树 0.30 改前基线：198 例全绿（不重测） |
| `/tmp/b699/selftest-cut031-before.log` | 合成 0.31 树改前基线：**54/199 例未达预期**（不重测） |
| `/tmp/b699/selftest-cut031g-before.log` | 同一棵合成树的 git 版（50/199），用来分辨「哪些失败来自树不是 git 仓」 |
| `/tmp/b699/docs-cut031-before.log` / `/tmp/b699/docs-strict-before.log` | `check:docs` 在切版树上 exit 2 / 真树 exit 0 的改前记录（写成绝对路径：裸文件名会被 `archive-refs` 判成「指向被 `.gitignore` 忽略的仓内路径且未分类」，于是这份报告自己让 `check:docs` 红） |

没有打不开的路径。`/home/eric/projects/erix-llm-kit` 未被读写（工单禁）。

## 四格改前 / 改后

（逐格在下面「① …」「② …」小节里填，每格对应一个 commit）

## 改前 / 改后 `--self-test` 条数

| 树 | 改前 | 改后 |
|---|---|---|
| 真树（`package.json` = 0.30.0） | 198/198 绿（`/tmp/b699/selftest-before.log`） | 待填 |
| 合成切版树（`package.json` = 0.31.0） | **54/199 未达预期**（`/tmp/b699/selftest-cut031-before.log`） | 待填 |

## ③ 自测期望把「当前版」钉成字面量（`scripts/docs-drift-check.mjs` 的 `SELF_TEST_CASES`）

**改前**（合成 0.31 树上实测的失败，`/tmp/b699/selftest-cut031g-before.log`）：期望正则里抄死了
`docs/host-upgrade-guide-0\.30\.0`，而生产判据一侧本来就是 `SURFACE_GUIDE_EN/CN = docs/host-upgrade-guide-${PKG_VERSION}.md`
（`:6626-6627`，动态）⇒ 切版当天「判据点对 0.31 那份指南，期望还在要 0.30 那份」，一族反向证集体红。
同族的另外三处同一病：AGENTS 本仓版本句的变异锚 `says \`0.30.0\` (the repo version)`、
CHANGELOG 本版段首锚 `## [0.30.0] - 2026-11-03`（两处）、以及 `读不到 CHANGELOG 的 0\.30\.0 段` 这两条期望。

**改后**：

| 位置 | 改法 |
|---|---|
| `unchanged-surface` 6 条期望（含 CN 那条的 `reject`） | 全部换成 `guideExpectRe("unchanged-surface", SURFACE_GUIDE_EN/CN, /…/)`：路径由常量现读，`judge` 前缀与 `tail` 保持原红话形状 |
| `#511 判据 2c` 中英两条（`guide-claim`） | 靶子与期望都改成当前版指南（label 里那句「0.30 指南」同步改成「当前版本那份」） |
| `#636` 中文侧 `compaction` 那一条 | 靶子 `[SURFACE_GUIDE_CN]` + 期望 `guideExpectRe("guide-coverage", …)`（**名字本身仍是 0.30 那笔加法**，见下面「前提型残留」） |
| `#690 读不出（②）` / `#636（fail-closed）` | 变异器换成 `rewriteCurrentChangelogHeading(...)`（按 `^## [${PKG_VERSION}]` 现定位本版段首），期望换成 `new RegExp(… ${esc(PKG_VERSION)} 段)` |
| `#511` 两条 AGENTS 变异 | `mutateRepoVersionClaim("0.28.0")` / `addMeasurementDateToRepoClaim(date)`——都走 `VERSION_CLAIM_RULES[0].repoRe`，即判据读的同一形状 |
| 防它再烂回来 | `runSelfTest` 里加一刀静态校：`unchanged-surface` / `guide-coverage` 的期望或 reject 里出现**等于本版**的 `host-upgrade-guide-<N>` 字面量、且不是 `guideExpectRe` 构造的 ⇒ 直接记失败（`bundle-table` 那份是 0.31 破坏包的历史逐名表、0.27 / 0.29 是历史指南，都不受这一刀管） |

**没动的历史夹具**（按工单点名）：`#621` / `#391 R4` / `#668 ①` 那三条（`docs/host-consumer-contract*`、README 旗标行），
以及 `#511 判据 2b`（0.29 指南）、`#636` 的 0.29 靶子、`14b` 全族（钉的是 0.31 破坏包逐名表——那份指南是历史文档，
路径不随当前版走）。`test/docs-anchor-ratchet.test.js:61-64` 已同时列 0.30 / 0.31 两对，未改。

**实测**：真树 `node scripts/docs-drift-check.mjs --self-test` = **198 例全绿**（`/tmp/b699/selftest-real-step2.log`，
与改前基线同数）；`node --test test/docs-anchor-ratchet.test.js` = **6/6 绿**；
合成 0.31 切版树同一步从 **50 → 7**（`/tmp/b699/selftest-cutB-step2.log`，剩下 7 条见「前提型残留」）。

## 顺带（① 解除短路后被抓到的一条真漂移）：0.31 中文指南 §4 标题

`docs/host-upgrade-guide-0.31.0_cn.md:72` 写的是 `## 4. 不变的部分`，而 `unchanged-surface` 要求的规范标题是
`## N. 没有变的东西`（`host-upgrade-guide-0.30.0_cn.md:214` 用的就是它）。① 之前那一族在零归属分支就
`return done()` 收口了，这一格从来没被审到；短路解除后它当场红：

```
unchanged-surface: docs/host-upgrade-guide-0.31.0_cn.md 里找不到「不变」那一节（标题应为 `## N. 没有变的东西`）——读不出这一节就等于没有声明可对账（读不出 = 红，exit 2）
```

这是**真漂移**（不是误报），改法是把标题对齐规范名，一个字节的内容不改；改完合成树的
`node scripts/docs-drift-check.mjs` 从 exit 2 变 **exit 0**（`125 项对齐 package.json 0.31.0 与源码`），
真树 `check:docs` 仍 **exit 0**（0.31 那一版还没成为当前版，这一格在真树上不参与判定）。

## 三态反向证

（待填）

## 改动了哪些既有期望（逐条理由）

（待填）

## #702：约定落在 AGENTS 哪几句

（待填）

## #702：AGENTS 指令面写清「条目由谁写、编号即可、sha 可后补」+ 真盲区的人工补偿

**没动 `CHANGELOG.md`**（本单一字未改；`## [0.31.0]` 段现在仍缺 `#691` / `#696` 的归因条目，那是 **#700** 的活）。
判据事实（`scripts/changelog-coverage-check.mjs`，逐条读过）：取号 `issueNumbersIn()`（`:151`，把 `#398③` 归一成 `398`）、
段侧取号 `sectionNumbers: new Set(issueNumbersIn(section.body))`（`:508`）、裁决「段里有这个号 = 绿 / 在豁免表里 = 跳过 / 否则红」
（`:413-423`）、真盲区「主题里没有号的合并」只打印不判红（`:345-350` 收集、`:427-430` 打印）——
**比较的是 issue 编号，条目从不要求带 sha**，所以「合并 sha 合并前不可知 ⇒ 闸对自己恒红」是误述，本次不加任何豁免。

新增句子原文（中英成对，各两句）：

**`AGENTS.md` §3 命令表 `check:changelog` 行末**：
> **Who writes the entry (issue #702)**: the PR that touches the public surface puts **its own** issue number into the current version's CHANGELOG section, in that same PR. What the gate compares is the **number** — the section body and the merge subject go through the same reader, and an entry is never required to carry a merge sha (the sha of a merge that has not happened yet is not knowable, so a rule demanding it would be red against every PR including itself). Writing `#702` in the entry is therefore enough and the sha can be added later; forgetting the number goes red on `main`, and that red is the enforcement doing its job, not a bug and not a row for `COVERAGE_EXEMPTIONS` (which exists only for the reverse case: behaviour-visible yet category-exempt). `npm run release:day -- --stage preflight` runs this gate as step 1 with no waiver

**`AGENTS.md` §4 发版前必跑清单末尾（「Beyond the mechanical gates」那段之后）**：
> One more human pass before the tag, and it is the only thing standing between an unnamed public change and a released tag: when `check:changelog` prints its **`unattributed`** note — a merge that touched the public surface but whose subject carries no issue number, so the gate cannot attribute it to any entry — it **prints and does not block**, by design (a merge subject is prose, and demanding that some entry name it is not achievable). For every short sha in that note, read its first-parent diff (`git diff --name-only <merge>^1 <merge>`) and either confirm the public change is already described in this version's CHANGELOG section, or write down a reason a later reader can check. That list is printed on purpose so this step has an input; nothing in the machine gates will do it for you.

**`AGENTS_cn.md` §3 同位置**：
> **这条条目由谁写（issue #702）**：碰到公开面的那个 PR，在**它自己这个 PR 里**把自己那个 issue 号写进本版 CHANGELOG 段。闸比的是**编号**——段正文与合并主题走的是同一个取号器，而条目从来不要求带合并 sha（还没发生的那次合并的 sha 不可知，要求它等于让每一条 PR 对自己恒红）。所以条目里写 `#702` 就够了，sha 事后可以补；忘写编号就会红在 `main` 上，那道红是强制在生效，不是 bug，也不是塞进 `COVERAGE_EXEMPTIONS` 的理由（那张表只为反向情形存在：看着属类别豁免、实则行为可见）。`npm run release:day -- --stage preflight` 第一步照旧跑它，没有豁免

**`AGENTS_cn.md` §4 同位置**：
> 打 tag 前还有一遍人工，而它是「一个没被点名的公开改动」与「已经发布的 tag」之间唯一的屏障：`check:changelog` 打印 **`unattributed`** 那条 note 时——碰到公开面的合并，主题里一个 issue 号都没有，闸归因不到任何条目——它**只打印、不阻塞**，这是设计（合并主题是散文，要求某条条目必须点名它做不到）。对那条 note 里的每一个短 sha，读它的 first-parent diff（`git diff --name-only <merge>^1 <merge>`），要么确认那个公开改动已经写进本版 CHANGELOG 段，要么留下一个后来的人能复核的理由。这张清单是**故意打印**的，好让这一步有输入；机器门禁里没有任何一条会替你做这件事。

**门禁实测**（工单要求「随后跑 `check:agents-directives` 与其 `--self-test`」）：
`npm run check:agents-directives` ⇒ `--strict: OK — 0 处红` + `--verify`「2 份指令面文件 × 3 类，逐格等于实测」，exit 0；
`node scripts/agents-directive-scan.mjs --self-test` ⇒ **16 例 × 3 种欠账形态全部按预期**，exit 0。
每格上限与改后实测（`--json` 报告）：`AGENTS.md` A=4/上限 4、B=0/0、C=0/0；`AGENTS_cn.md` A=1/上限 1、B=0/0、C=0/0。
新句**没有**给指令面添任何新命中（A/C 两格都在上限上、`--verify` 要求逐格相等还能绿，就是这件事的证明）：
两句都不写工单状态词、不抄实测数、不写裸行号坐标。

## 闸内实红与归属（#700 的活，本单没碰）

`npm run check:changelog` 在 base `dc5783f` 与本分支上都是 **exit 1**（改前 / 改后同一份输出，字节相同）：
本版段缺 `#691`、`#696`、`#700` 等公开面合并的归因条目。**这是闸按设计红**（#702 的原话：忘写编号就红在 main），
不是误报，也不该由本单补写——补写就是往别人的段里塞别人的条目。

## 未验证项

（待填）

## ① `unchanged-surface` 的零归属误报（`collectUnchangedSurfaceErrors`）

**改前**（`scripts/docs-drift-check.mjs`，`declared.namesSeen > 0 && declared.anyMember === 0` 那一支）：

```
fail("unchanged-surface: CHANGELOG 的 ${PKG_VERSION} 段里有 N 处反引号字段名，但一格也没解析出来——
      六格的成员判据（或真值提取器）坏了，本判据正在空跑");
return done();          // 直接收口，指南一侧一格都不判
```

- 0.31.0 是**纯删除版**：段里 70 处反引号全是**已经从导出面消失**的导出名（`estimateMessagesTokens` /
  `setNotesClock` / `NOTE_VALUE_MAX_CHARS` …）。六格量的是「这一版还在的输入面 / 诊断字段 / 磁盘格式 /
  事件 / 默认值 / 终局载荷」，退役导出名按定义进不了六格 ⇒ `anyMember === 0` 恒真 ⇒
  `check:docs` 在 0.31 上**永远 exit 2**（切版树与「切版 + 已补 §4」树都实测过，`/tmp/b699/docs-cut031-before.log`）。

**改后**：

```
notes.push("unchanged-surface: CHANGELOG <v> 段里有 N 处反引号字段名，但一处也没落进六格
           （各格真值规模：diagnostics=N / disk=N / …）——这是「本版只有删除 / 勘误 / 发版流程」的
           合法形状：那些名字已从导出面消失，按定义不属于六格，所以不判红；
           真值集本身抽不出来（提取器坏了）由上面那条「抽不到成员真值」判红（#699 ①）");
```

- **判据一格没删**：`cell.truth()` 返回 null 的那条 `fail("抽不到「X」格的成员真值…")` 原样保留（它在
  零归属分支**之前**跑，所以「提取器坏了」仍然 exit 2）。修的是误报条件，不是判据。
- 「本判据正在空跑」这句话只留在真值集为空的那条 fail 里；零归属的说明里**不出现**它。
- 零归属分支不再 `return done()`：指南一侧照样逐格判（§4 找不到 / 该格缺席 / 写着不变 / 声明变更不点名
  四条都还在跑），只是这一版六格都没有变更证据 ⇒ 按既有的「② 反向」放行。
- 打印里带**每格真值规模**，读者能当场看见「六格都在、只是这一版没动它们」——这是它降级成说明后仍然
  可核对的证据面。

## ② `guide-coverage` 的「下限 4」误报（`collectGuideCoverageErrors`）

**改前**：`GUIDE_COVERAGE_MIN_NAMES = 4`，判据是

```
if (checked < GUIDE_COVERAGE_MIN_NAMES) fail("guide-coverage: 本版只判到 0 个名字（下限 4）——抽取逻辑或
                                              CHANGELOG 段被削，这条判据正在空跑");
```

`checked` = `releaseAddedNames()` 从**本版段的加法句**里点到的 inventory 名字数。0.31 段全是删除 / 勘误 /
发版流程，一个加法句都没有 ⇒ `checked = 0` ⇒ 恒红（主 agent 把 ① 短路之后实测 `check:docs` **exit 1**，
红话就是这一句）。**合法零新增版恒假**。

**改后**：健康判据换成「代码侧名字集还抽不抽得出来」，即 `NAME_INVENTORY_MIN_NAMES = 92`（0.30 这棵树
实测：config 叶子 + 观察者事件 + 压缩策略名 + 环境变量 = 92），低于它才红：

```
guide-coverage: 从代码侧只抽到 N 个名字（下限 92）——抽取逻辑被削了（四张脸里有一张抽不出来）…
```

- 「与本版段交集 ≥ 4」不再是否决条件：`checked === 0` 时只打印一条说明
  （「本版是零新增版，这一半无可判项；不是抽取器坏了：代码侧清单仍然抽到 92 个名字」），不红、不 exit。
- 92 是**只许涨不许降**的棘轮（与 `REF_SCAN_DOCS_MINIMUM` / `SYMBOL_ANCHOR_MIN_UNIQUE` /
  `MIN_SELF_TEST_CASES` 同构）：降它要写理由。
- 原有的 `!inventory.size` fail 与「读不到 CHANGELOG 段」fail 原样保留（fail-closed 那两条没动）。
