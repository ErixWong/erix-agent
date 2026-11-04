# #698 交付报告：0.31.0 升级指南补 §4「没有变的东西」六格

**结论先说**：两份 0.31.0 指南（EN / CN）各补上一节 §4，六格逐格成对、逐格点名成员，**六格全部写「不变」**——
这个方向由本版真值作证（`[0.31.0]` 段里 28 个不同的反引号名字，落进六格的是 **0 个**）。本单**没有**、也**不能**
把 `check:docs` / `check:docs:strict` 弄绿：剩下的红是判据自己的空转守卫（已另立 **#699**，与 #697 同文件串行），
原文与定位见 §4。本单的判据文件、测试、CHANGELOG、`package.json`、`src/` **零改动**。

## 取证边界

打开过（全部为只读）：

| 路径 | 用途 |
|---|---|
| `scripts/docs-drift-check.mjs` | 现读 `SURFACE_CELLS`（六格 id / 中英格名 / 中英标记正则 / 真值构造器）、`SURFACE_SECTION_HEADING`（节标题正则）、`SURFACE_CHANGED_MARK`（「这一格变了」话术）、`SURFACE_BULLET`（六格行首锚）、`SURFACE_NAME_SHAPE`、`SURFACE_CHANGE_SHAPES`、`surfaceClaimBlocks` / `collectUnchangedSurfaceErrors` / `collectGuideCoverageErrors` / `changedMark` 的判定流程 |
| `docs/host-upgrade-guide-0.31.0.md`、`docs/host-upgrade-guide-0.31.0_cn.md` | 被改的两份（唯一改动面） |
| `docs/host-upgrade-guide-0.30.0.md`、`docs/host-upgrade-guide-0.30.0_cn.md` | §4 的**形状**样板（六格 bullet 的写法与顺序） |
| `CHANGELOG.md` | `[0.31.0]` 段（本版真值面）、`[0.30.0]` 段（对照） |
| `package.json` | `version` = 0.31.0、`scripts` 表（判据清单） |
| `AGENTS.md` | 门禁清单、提交与交付规矩、交付报告的两处落点（本机档案那处不入库、仓库根这处入库）的口径 |
| `.gitignore` | `node_modules`、`src/**/*.d.ts` 的忽略口径（`npm install` 与 `prepack` 的前提） |
| `docs/requirements.md`、`docs/requirements_cn.md` | 只为定位 `--strict` 下那 2 处 `version` 告警的来源（见 §5） |
| `scripts/docs-sync-check.mjs` | 确认 `check:docs` 的第二条腿只比 `host-consumer-contract` 中英骨架，与本单无关 |

**没有直接打开**（六格的成员真值由判据自己的提取器现读，我只读它抽出来的名字集合）：
`src/loop/orchestrator.js`（观察者事件 / 折叠记录字面量）、`src/compact/pipeline.js`（`createCompactionStat`）、
`src/compact/fold-summary-journal.js`（`*_RECORD_FIELD`）、`src/loop/termination.js`（`makeResult` / `termination`）、
`bin/cli.js`（CLI 旗标 / 退出码符号）、`bin/config.js`（`DEFAULT_*`）。

**刻意没碰**：`/home/eric/projects/erix-llm-kit`（主检出）、`main` 分支、`scripts/docs-drift-check.mjs`
（另一个 worker / #699 正在改它）、`CHANGELOG.md`、`scripts/release-day.mjs`、`src/compact/fold-llm.js`。

**打不开的路径**：无（`BLOCKED` 为空）。

## 1. 六格各写了什么、依据是什么

写法照 0.30.0 指南 §4 的同一形状（六条 bullet、同一顺序：选项 → 默认值 → 观察者事件 → 诊断字段 → 磁盘格式 →
终局载荷），行首锚与格标记**逐字**对上判据现读的那两组常量。节编号接在文件既有小节之后：两份 0.31.0 指南
本来就是 §1…§5 五节，§4 原本是一段**没有六格**的散文（EN 标题 `## 4. What does not change`、CN 标题
`## 4. 不变的部分`），所以本单**不需要重编号**，只把 §4 换成六格形状；CN 标题按判据现读的
`/^##\s*\d+\.\s*没有变的东西/u` 改成「没有变的东西」。第一行自声明版本保持 `<!-- doc-version: 0.31.0 -->`。

| 格（id） | EN 行 / CN 行 | 这一格写了什么（不变的具体含义） | 本版真值里有这一格的名字吗 |
|---|---|---|---|
| options | 89 / 74 | 没有 `runToolLoop` 选项被退役、改名或搬家；配置命名空间的分组/叶子集合与 0.30.0 相同（点名 `run.maxRounds`、`folding.toolResultTtl`、`guard.finalGuardMaxRetries`、`timing.timeoutMs`、`metadata.modelMetadata`）；CLI 旗标集合不增不减（点名 `--compaction`、`--compact-budget`、`--final-guard`、`--require-deliverable`、`--delegate`） | **没有**。真值集 125 个成员；`[0.31.0]` 段的 28 个名字里落进本格 0 个 |
| defaults | 103 / 84 | 既有选项缺省值一个没重定；承载它们的 `DEFAULT_MAX_OUTPUT_TOKENS` / `DEFAULT_COMPACTION_STRATEGY` 取值与 0.30.0 相同 | **没有**。真值集 2 个成员；落进本格 0 个 |
| events | 106 / 86 | 事件名与载荷照旧（点名 `round_start`、`round_end`、`tool_use`、`tool_result`、`usage`、`run_outcome`、`persistence_error`、`compaction`、`compaction_strategy_fallback`）；`type: "compaction"` 含义不变 | **没有**。真值集 23 个成员；落进本格 0 个 |
| diagnostics | 110 / 89 | `compactionStats` 条目保持 0.30.0 的形状，含 0.30.0 挪过的那几个：`strategyName`、`foldSummary` 子对象、`degradeKind` / `degradeReason`（仍无树内写者）、失败分支的 `budgetExhausted` | **没有**。真值集 25 个成员；落进本格 0 个 |
| disk | 114 / 92 | 折叠账本形状不变（`foldedFacts` 连同 `foldId`、`seq`、`text`、`source`、`strategy`、`roundRange`），0.30.0 写的账本可直接续跑、不需要迁移或补号 | **没有**。真值集 14 个成员；落进本格 0 个 |
| finalPayload | 118 / 95 | `makeResult` 返回同一组键（点名 15 个）；失败 run 仍带 `termination.errorCode`；`exitCodeForRunFailure` / `exitCodeForVerification` 与用法错误码互不共用 | **没有**。真值集 18 个成员；落进本格 0 个 |

**「一个都没有」是怎么量出来的**（不是推理）：把 `[0.31.0]` 段按判据的 `surfaceNamesIn` 扫一遍，再用判据自己的
`surfaceCellOf` 逐名归类，结果是 **28 个不同的名字，全部不落任何一格**（`anyMember = 0`）——这正是判据自报
`70 处反引号字段名，但一格也没解析出来` 的来源。28 个名字是：

```
serializeFoldedMessages serializeFoldedMessagesWithMeta extractL0 extractL0Fact extractL0Facts
parseSummary parseReflectionSummary parseL1Summary MESSAGE_OVERHEAD_TOKENS MESSAGE_OVERHEAD
estimateMessagesTokens estimateMessageTokens createAnthropicProvider createEnvModelConfigProvider
createStaticToolProvider createJsonFileToolProvider createCompositeToolProvider createOpenAIProvider
resolveFileReadMaxBytes setNotesClock removeRecord NOTE_VALUE_MAX_CHARS
canonicalToAnthropicRequest anthropicResponseToCanonical createAnthropicStreamAssembler
REMOVAL_REGISTRY package.json import
```

它们全是**导出名 / 模块名 / 记账表名**，没有一个是选项、默认值常量、事件名、诊断字段、磁盘字段或终局载荷键
——0.31.0 只删导出，六格没动，所以六格写「不变」是本版唯一说真话的方向。
（处数口径：判据自报 70 处；我逐行枚举到 71 处，差 1 处不影响结论——两种枚举下落进六格的都是 0 个。）

### 1.1 格标记与行首锚：12/12 命中（现读脚本里的正则，不抄）

用 `/tmp` 下的一个一次性核对脚本，**现读** `scripts/docs-drift-check.mjs` 文本里的
`SURFACE_CELLS[].marker`、`SURFACE_SECTION_HEADING`、`SURFACE_CHANGED_MARK`、`SURFACE_BULLET` 四组字面量，
按 `unchangedSurfaceSection` + `surfaceClaimBlocks` 的同语义（块 = bullet + 续行，空白行断块，首处声明为准）
去 match 我实际写下的行：

```
=== docs/host-upgrade-guide-0.31.0.md
  第一行（自声明版本）：<!-- doc-version: 0.31.0 -->
  §4 标题在第 87 行，命中现读正则 /^##\s*\d+\.\s*What does not change\b/u；节内 42 行
  ✓ diagnostics  第 110 行命中 /\bdiagnostic fields?\b|\bdiagnostics\b/iu；行首锚 "* **Diagnostic fields —" 在；changed 话术=false
  ✓ disk         第 114 行命中 /\bon-disk\b|\bdisk formats?\b/iu；行首锚 "* **On-disk formats —" 在；changed 话术=false
  ✓ events       第 106 行命中 /\bobserver events?\b/iu；行首锚 "* **Observer events —" 在；changed 话术=false
  ✓ options      第  89 行命中 /\boptions?\b|\binput surface\b|\bconfiguration leaf\b/iu；行首锚 "* **Options —" 在；changed 话术=false
  ✓ defaults     第 103 行命中 /\bdefaults?\b/iu；行首锚 "* **Defaults —" 在；changed 话术=false
  ✓ finalPayload 第 118 行命中 /\bfinal payload\b|\bterminal payload\b|\bexit[- ]codes?\b/iu；行首锚 "* **Final payload —" 在；changed 话术=false
=== docs/host-upgrade-guide-0.31.0_cn.md
  第一行（自声明版本）：<!-- doc-version: 0.31.0 -->
  §4 标题在第 72 行，命中现读正则 /^##\s*\d+\.\s*没有变的东西/u；节内 31 行
  ✓ diagnostics  第  89 行命中 /诊断字段/u；行首锚 "* **诊断字段——" 在；changed 话术=false
  ✓ disk         第  92 行命中 /磁盘格式|磁盘/u；行首锚 "* **磁盘格式——" 在；changed 话术=false
  ✓ events       第  86 行命中 /观察者事件/u；行首锚 "* **观察者事件——" 在；changed 话术=false
  ✓ options      第  74 行命中 /选项|输入面|配置叶子/u；行首锚 "* **选项——" 在；changed 话术=false
  ✓ defaults     第  84 行命中 /默认值|默认/u；行首锚 "* **默认值——" 在；changed 话术=false
  ✓ finalPayload 第  95 行命中 /终局载荷|终局|退出码/u；行首锚 "* **终局载荷——" 在；changed 话术=false
结果：六格 × 中英 = 12/12 全部被现读标记正则命中，行首锚 12/12 在
```

「changed 话术=false」是刻意的：`SURFACE_CHANGED_MARK` 的英文侧是 `/changed in this release|…/iu`，
**没有词边界**，所以「un**changed** in this release」也会被它当成「这一格变了」。六格都写「不变」时这句
只是说明写法安全；一旦哪一格真变了，那句话必须改写成 `changed in this release` 并点名该格字段（见 §2 态 C）。

### 1.2 中英成对与既有小节未被改坏

* 两份指南的 `## ` 小节编号与条数一致（1…5 各一节，§4 位置相同）；只有 §4 的标题文字按各自语言不同。
* `git diff 5b9e7c9` 的改动面：EN 只有一处 hunk（`@@ -86,10 +86,46 @@`），CN 只有一处 hunk（`@@ -69,11 +69,37 @@`），
  两处都在 §4 内；§2 的十六名删除表与 §3 的 `createAnthropicProvider` 表**一行未动**。
* `node scripts/guide-removal-gate.mjs --self-test` → exit 0（18 条判据全按预期；它不读 §4，但读 §2/§3 的名集与入口列，
  它绿即证明那两张表没被改坏）。

## 2. 两态取证（含一条必须说清的：本单**做不到**「文档侧写反 ⇒ 红」）

取证用的探针是 `scripts/` 下的**一次性副本**（只做两处内存改动：① 放宽 `anyMember === 0` 那条空转守卫；
② 可选地往 `[0.31.0]` 段注入一条合成变更声明），跑完即删；**仓库里的判据文件逐字节未改**
（`git status` 干净，见 §6）。真树的两态（态 A / 态 B）用的是真 `CHANGELOG.md`。

| 态 | 做了什么 | 期望 | 实测 |
|---|---|---|---|
| **态 A** | 最终树（本单提交后的指南）+ 探针放宽两处空转守卫 | 六格全绿 | **绿**：`docs-drift-check: OK — …共 120 项对齐 package.json 0.31.0 与源码`，`unchanged-surface` 0 条（exit 0） |
| **态 B** | 同一棵树 + 往 `[0.31.0]` 段注入 `strategyName moves to strategyNameV2 in this release`（合成），指南仍写「不变」 | 红，且点名**格名 + 字段名** | **红 2 处**（中英各一），原文见下 |
| **态 C** | 同注入下把中英「诊断字段」格改成 `changed in this release` / `这一版变了` 并点名 `strategyName` | 绿 | **绿**（exit 0） |
| **态 D** | 真 CHANGELOG（无注入），指南写成「这一版变了」+ 一个本版真值里没有的字段名 | —— | **仍是绿**：本版该格没有变更证据时判据整格跳过（`if (!changedNames.length) continue`），**文档侧单方面写反不可能红** |

态 B 的红话（逐字）：

```
docs-drift-check: 失败 — 2 处漂移
  ✗ unchanged-surface: docs/host-upgrade-guide-0.31.0.md:110 第「diagnostic fields」格写着不变，而本版 CHANGELOG 声明这些字段变了：strategyName——「不变」与同一版 CHANGELOG 打架（#690）
  ✗ unchanged-surface: docs/host-upgrade-guide-0.31.0_cn.md:89 第「诊断字段」格写着不变，而本版 CHANGELOG 声明这些字段变了：strategyName——「不变」与同一版 CHANGELOG 打架（#690）
```

**这条必须写进交付**：工单要求的两态之一（「把没动的格写成变了并填一个本版真值里没有的名字 ⇒ 必须红」）在
**0.31.0 这一版不可能成立**，因为红的唯一触发条件是「本版 CHANGELOG 声明该格某字段变了」，而 0.31.0 一个都没有。
态 B/C 是把真值侧注入一条合成声明后才成立的——它证明的是**我这六格真的被读、格名与字段名真的被点名**，
不是「写反就会红」。真正的空转是判据自己那两条守卫（§4）。

态 A 之后我又用同一个探针把「注入变更声明」关掉、只放宽守卫跑了一遍**真树**：0 处漂移。
换句话说：**本单写下的六格在「判据不再空转」之后是绿的**；现在红的原因是判据的空转守卫，不是文档。

## 3. 判据退出码表（最终树，逐条记退出码）

`npm install --include=dev` 先跑过（本工作树原本没有 `node_modules`，`prepack` 的 `tsc` 找不到 ⇒ 见 §5 的
「环境」一行）；下表除特别注明外都在装好依赖之后跑。

| 判据 | 退出码 | 关键输出 |
|---|---|---|
| `npm run check:syntax` | **0** | 465 个跟踪的 `.js/.mjs/.cjs` 全过 |
| `npm run check:docs` | **2** | `unchanged-surface: CHANGELOG 的 0.31.0 段里有 70 处反引号字段名，但一格也没解析出来…`（#699） |
| `npm run check:docs:strict` | **2** | 同一句，一字不差（**与改动前同一个退出码**，本单没有改变这个裁决） |
| `node scripts/docs-drift-check.mjs --self-test` | **1** | `46/190 例未达预期`（工单记的 189 例是切版前的数；切版后是 **190 例**，见 §5） |
| `npm run check:docs-spelling` | **0** | `--strict: OK — 0 处红`（新增文本没有引入退役拼写，也没有抬高历史类钉数） |
| `npm run check:agents-directives` | **0** | `--strict: OK — 0 处红`；`--verify` 逐格等于实测 |
| `npm run check:changelog` | **1** | `#691 的合并 a5cc4ba 碰到了公开面（package.json），而 0.31.0 段里没有它`（+ `#696` 同一条），**切版提交就带着的红**，见 §5 |
| `npm test` | **1** | `# tests 3400` / `# pass 3385` / `# fail 2` / `# skipped 13` |
| `npm run check:test-summary -- --log <日志>` | **1** | `TEST-SUMMARY tests=3400 pass=3385 fail=2 skipped=13`；`FAIL_NONZERO: fail 2 ≠ 登记值 0`（两个红用例是 #699 的下游，见 §5） |
| `npm run check:pack-links` | **0** | 39 份随包 Markdown 无死链；`test/contract/` 11 条；`.d.ts` 2 处声明位 = 87 |
| `npm run check:release` | **0** | `6 步全绿，累计 19.5s` |
| `node scripts/guide-removal-gate.mjs --self-test` | **0** | 18 条判据全按预期（§2/§3 删除表未坏） |

## 4. 本单不能让 `check:docs` 变绿：剩下的红是 #699

主 agent 已亲跑确认，补完 §4 之后 `check:docs` / `check:docs:strict` 仍 exit 2，红话一字未变：

```
✗ unchanged-surface: CHANGELOG 的 0.31.0 段里有 70 处反引号字段名，但一格也没解析出来——六格的成员判据（或真值提取器）坏了，本判据正在空转
```

根因在判据自己（`scripts/docs-drift-check.mjs` 的 `collectUnchangedSurfaceErrors`）：

```js
if (declared.namesSeen > 0 && declared.anyMember === 0) {   // ← 这一条对本版恒真
  fail(`unchanged-surface: CHANGELOG 的 ${PKG_VERSION} 段里有 ${declared.namesSeen} 处反引号字段名，`
    + "但一格也没解析出来——六格的成员判据（或真值提取器）坏了，本判据正在空跑");
  return done();
}
```

它把「本版确实没动那六格」当成了「提取器坏了」。0.31.0 是纯删除导出 + 工具/文档面改动，六格成员名
**一个都没有**（§1 已量到 28 个名字、落格 0 个）⇒ `anyMember === 0` 恒真 ⇒ 判据在**判格之前**就 `return done()`，
`exit 2`。**这一条已另立 #699，与 #697 同文件必须串行，不归本单。**

顺带记下同一族的**第二处**空转（也在同一文件、也不归本单，供 #699 一并处置）：把上面那条守卫放宽后，
`collectGuideCoverageErrors` 会立刻接上另一条同类红——`guide-coverage: 本版只判到 0 个名字（下限 4）`。
它的真值是「CHANGELOG 本版段里的**加法句**名字」，而 0.31.0 没有新增任何公共面名字（下限 4 是 0.29.0 那一版的实测值）。

## 5. 改动了既有期望的地方

**零改动。** 本单的 diff 只有两份指南（`git diff 5b9e7c9 --stat` = 2 files / 71 insertions / 9 deletions），
没有改判据、没有改测试、没有改期望、没有改 CHANGELOG / `package.json` / `src/`。因此上面那些红一条都不是
「为了绿而改口径」的结果；相反，§2 态 B/C 是**真值侧注入**证明判据咬人，不是把期望放宽。

## 6. 未验证项 / 需要主 agent 处置

1. **`check:docs` / `check:docs:strict` 未达 exit 0**——被 #699（判据空转守卫）挡住，见 §4。本单在文件所有权内
   能做的都做了：六格写全、格标记 12/12 命中、放宽守卫后 0 漂移。
2. **`--self-test` 46/190 红，且工单记的「189 例」与实测「190 例」不符**——切版把 `PKG_VERSION` 从 0.30.0 推到
   0.31.0 之后，`#690` 那一族的期望正则把路径**写死成** `docs/host-upgrade-guide-0\.30\.0\.md` / `_cn.md`，
   于是实际红话里的 `0.31.0` 永远匹配不上；同族的另外几条又把「变异靶」钉在 0.30.0 的旧句子上。
   本单的改动让其中 4 条从「变异没落到」变成「变异落上了、只是期望里的版本号不对」
   （`变异没落到` 计数 **8 → 2**，用例总数与红数 46/190 不变）。修法是把期望里的版本号改成
   `${SURFACE_GUIDE_EN}` 一类的现读值——**属于判据文件，不归本单**。
3. **`check:changelog` 红 2 处**：合并 `a5cc4ba`（`Merge PR #696: #691 …`）碰到了公开面 `package.json`，
   而 `[0.31.0]` 段里没有它。这是**切版提交本身就带着的**红（该合并在本单基点之前），修它要动 `CHANGELOG.md`
   或 `scripts/changelog-coverage-check.mjs`，两者都不在本单文件面。
4. **`npm test` 的 2 个红用例是 #699 的下游**：`test/docs-anchor-ratchet.test.js` 的第 734 / 735 例都要
   `node scripts/docs-drift-check.mjs --verbose` 退出 0，而它现在是 exit 2（§4 那条守卫）。改动前我跑过一次
   同样的命令，当时也是 exit 2 ⇒ 这两例在本单基点就是红的，不是本单引入的。
5. **`--strict` 下另有 2 处 `version` 告警**（不改退出码，但 `--strict` 会把告警算成 exit 1）：
   `docs/requirements.md` 与 `docs/requirements_cn.md` 的阶段表 current 行还停在 `v0.9.0–v0.30.0`。
   这两份文件不在本单文件面；#699 修好之后，`check:docs:strict` 仍会因这两处告警 exit 1，需要有人认领。
6. **环境**：本工作树初始没有 `node_modules`，`check:pack-links` / `check:release` 第一次跑都因
   `prepack` 找不到 `tsc` 而红；`npm install --include=dev` 之后两条都 exit 0。这一条不是树的问题，
   但复跑的人会撞上，记在这里。
7. 探针脚本（放宽守卫 / 注入合成声明的那个副本）已删除，仓库里 `scripts/` 下无遗留文件；
   `git status` 在提交前为干净（只多本报告）。

## 7. 改动文件

* `docs/host-upgrade-guide-0.31.0.md`（§4 换成六格，44 行增 / 少量删）
* `docs/host-upgrade-guide-0.31.0_cn.md`（§4 标题按判据现读正则改为「没有变的东西」并换成六格，36 行增）
* `delivery/698-guide-031-unchanged.md`（本报告）
