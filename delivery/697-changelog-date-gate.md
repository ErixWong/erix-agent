# #697 CHANGELOG 段首日期进真值面（未发布段不许带日期 / 已发布段对 tag 日期）

- 工单：ErixWong/erix-agent#697（`fix(docs-gate): CHANGELOG 段首日期是事实而不是占位`）
- 分支：`feat-261103-08-changelog-date-gate-697`，基点 main `a5cc4ba`
- 日期实测环境：`date` = **Tue Nov 3 02:58:14 PM CST 2026**（UTC+8），node v22.23.2

## 取证边界

**真跑（真实真值面）**

- `scripts/docs-drift-check.mjs` 判据模式跑在**本工作树**上：`git for-each-ref refs/tags` 读到本仓真实
  11 个 tag（附注/轻量两种形态都覆盖），registry 走真实 `npm view erix-agent versions dist-tags --json`
  （测量时联网可用，`dist-tags.latest = 0.30.0`，31 个已发布版本）。
- 反向证里有三条是**对真树做的临时变异**（改完立即 `cp` 还原，还原后 exit 0 已复验）：
  ① 把 `- 2026-11-10` 加回 0.31.0 段首 ⇒ exit 1 并点名；② 删掉 `CHANGELOG_DATE_TAG_EXEMPTIONS` 里
  0.25.0 那条 ⇒ exit 1 并点名 `2026-10-24` vs `2026-10-25`；③ 在 `probeTagDates()` 里临时滤掉
  `0.30.0` ⇒ 打出 `docs-drift-check: 未判定 TAG_MISSING — …` 且 **exit 2**（不是 exit 1）。
- `--sync` 的两态实测：在 `os.tmpdir()` 的合成树上跑真脚本（`--root`），前后用 `diff -r` / 逐行比对。

**夹具（自测内，不碰真实 tag / registry / 网络）**

- `--self-test` 的 tag 面 = `selfTestTagFacts()`（从 CHANGELOG 派生；登记在
  `CHANGELOG_DATE_TAG_EXEMPTIONS` 里的版本故意错开一天，好让那两条登记在自测里不是空转条目），
  registry 面 = 既有的 `selfTestRegistry()`。对照组也在夹具下跑（`SIM_TAG_FACTS` 在对照组前后挂/还原），
  所以自测结论**不依赖本机 tag 面**——这是工单「自测不许依赖真实 tag/registry」的要求。
- `release-day --self-test` 全离线：合成树 + 假 runner，`--sync` 是子进程真跑（真脚本、合成树）。

**没做的**

- 没有对 npm 真发布，也没有真跑 `--stage writeback` / `--stage finalize` 的完整链路（写回后的
  `check:docs` 会因「0.31.0 真的还没发布」判红，那是真值面的事实，不是本单的判据）。writeback ③ 的
  exit 2 分工用假 runner 证（③b / ③c），`--sync` 的窄面用合成树逐字节证。
- 按工单要求**没有跑** `check:mutation:run` 与 `check:release:real`。
- 历史段的两个「日期 ↔ tag」不一致（0.19.0 / 0.25.0）**没有改**：工单边界写明「不许为了绿去改历史事实」，
  它们进登记表并带理由（见下）。

## 判据与两种 exit 的分工

### 判据（`scripts/docs-drift-check.mjs` §17b `changelog-date`）

1. **正在准备的那一段不许带日期**：版本序最高的版本段（今天 = `## [0.31.0]`）若标了「未发布 / unpublished」
   又带发布日期 ⇒ 红，并点名行号 + 日期 + 合法形状。这一半**不依赖 registry**（标记本身就是「没发布」的
   声称），所以离线、无 registry 也判（自测 ① 用 `simulateRegistry: {ok:false}` 证过）。
   **历史段不受这一条管**：本仓 0.24.0 / 0.21.0 / 0.12.0 / 0.8.0 都是「带日期 + 正文标未发布」的历史记录，
   改它们等于改历史事实；自测里有一条放行证专门钉这一格（历史段改日期仍绿）。
2. **已发布段的日期必须与 tag 日期同一天**（UTC+8 本地日历日；附注 tag 取 tagger date，轻量 tag 取所指
   提交的 author date）。不一致 ⇒ 红并**点名两个日期**。真树实测：8 段对账通过，2 段登记为历史不一致，
   10 段没有 tag 不判（note 会打印这三个数，别在这里抄）。
3. **`--sync` 在翻标记的同一步写日期**：`--published-date <YYYY-MM-DD>`，缺省 = 当天 UTC+8。段首那一行
   按**规范形状**整行重写：已发布 ⇒ `## [X.Y.Z] - <日期>`；未发布 ⇒ `## [X.Y.Z]（未发布 / unpublished）`。
   两个方向都写，所以「标记新、日期旧」这种半新半旧不可能出现。行外一个字节都不动。

### 为什么「registry 说已发布但 tag 不存在」是 exit 2（未判定）而不是红

`release:day` 的发版顺序是 **publish → writeback（翻标记 + 写日期）→ finalize（打 tag）**。writeback 之后
立刻要跑一次 `check:docs` 作为「回写自洽」的证明——那一刻 registry 已经是新版本，`vX.Y.Z` tag 还**没有**。
如果把它判成红，writeback 就会被它自己刚做的那件事判死（而它做的正是本单要求的事）。所以：

- 这一类给机器可读的 `TAG_MISSING`，主路径印成
  `docs-drift-check: 未判定 TAG_MISSING — …`，退出码 **2**（与 `READ_FAILURES` 同一族：读不出真值 ≠ 绿 ≠ 红）；
- 退出码收敛成**单一来源** `docsDriftExitCode({errors, warnings, readFailures, notJudged, strict})`，
  主路径与 `--self-test` 读同一份——所以「未判定 ⇒ exit 2 而不是红」在自测里是**可证**的（自测 ③ 用
  `expectExit: 2` + `expectNotJudged: ["TAG_MISSING"]` 两条一起钉）；
- `release-day` 的 writeback ③ 因此把 `check:docs` 的 exit 2 分两种：**每一处**未判定原因都是 `TAG_MISSING`
  ⇒ 未判定（回写照常落账、`phase=written`，finalize 照走）；其余（别的读不出 / 一处标记都读不到 / exit 1）
  ⇒ 仍然红。这一条不靠退出码一个数字，靠 stdout 里 `docs-drift-check: 未判定 <CODE> — ` 前缀（③b / ③c 各一例）。

### `TAG_MISSING` 只咬 registry 的 `latest`（一个必须写明的范围决定）

工单写「registry 说已发布但 `vX.Y.Z` 不存在 ⇒ exit 2」，但如果对**每个**已发布段都要求 tag，这条闸会永久
exit 2：本仓 31 个已发布版本里只有 **11** 个有 tag（打 tag 是 0.14.0 之后才零星开始的：0.8–0.13、0.20–0.24、
0.26–0.28 都没有）。「永久 exit 2」等于没有闸，也违反「`check:docs` 必须绿」的交付口径。所以：

- **registry 的 `latest` 缺 tag ⇒ `TAG_MISSING`（exit 2）**——被验证的「发布这件事」永远是 registry 说的
  latest，这正是 writeback 那一刻的状态；
- **更早的已发布段有 tag 才判**，没有 tag 就记一笔跳过（note 里报个数）。自测 ③（历史段无 tag 不判）用
  「只有 latest 那个 tag」的夹具把这条范围钉住，免得它被当成漏判。

## `--sync` 窄面的两态实测

合成树（`package.json` 0.31.0 + 两份 README + 两份 requirements + 两份 AGENTS + CHANGELOG），真脚本子进程跑：

**态 A（发布）：`--sync --published 0.31.0 --published-date 2026-11-03`**

```
docs-drift-check --sync: 回写 11 处发布态句子（7 个文件）——本仓版本 0.31.0 / 发布行 0.31.0：
  · README.md:3 「README 当前发布行」 0.30.0 → 0.31.0
  …
  · CHANGELOG.md:5 0.31.0 段首 ## [0.31.0]（未发布 / unpublished） → ## [0.31.0] - 2026-11-03
```

逐字节 `diff -r`：只有那 7 个文件里**被点名的那几行**变；CHANGELOG 只有第 5 行变：

```
5c5
< ## [0.31.0]（未发布 / unpublished）
---
> ## [0.31.0] - 2026-11-03
```

**态 B（未发布，段首带着占位日期）：`--sync --version 0.31.0 --published 0.30.0`**

```
docs-drift-check --sync: 段还没发布（发布行 0.30.0 ≠ 本仓版本 0.31.0）——段首只写「未发布」标记，不写日期
  · CHANGELOG.md:5 0.31.0 段首 ## [0.31.0] - 2026-11-10（未发布 / unpublished） → ## [0.31.0]（未发布 / unpublished）
```

逐行比对：**恰好 1 行变，行数不变**（`release-day --self-test` ⑦e 把这两条都固化成断言）。
`--published-date` 形状不对（`2026/11/03`）⇒ exit 2 且 **0 字节写入**（⑦g）。

`release-day` 侧：`--stage writeback` 新增 `--published-date` 透传（不给就由 `--sync` 自己取当天 UTC+8，
真值只有一个来源）；`--all` 也把它带到续跑那一支。

## 自测条数与反向证

| 命令 | 改前 | 改后 | 退出码 |
| --- | --- | --- | --- |
| `node scripts/docs-drift-check.mjs --self-test` | **189 例** | **198 例** | 0 |
| `node scripts/release-day.mjs --self-test` | 52 条 `expect` | **61 条判据** | 0 |

新增 9 例（`#697` 一族）：

1. **①** 正在准备的那一段标了未发布却带日期 ⇒ 红（`simulateRegistry: {ok:false}`，证这一半与 registry 无关）；
2. **②** 已发布段日期与 tag 不一致 ⇒ 红并点名两个日期（`2026-11-04` vs `2026-11-03`）；
3. **②（登记证）** 同一处不一致登记进 `CHANGELOG_DATE_TAG_EXEMPTIONS` ⇒ 绿；
4. **②（空转证）** 登记表里一条对不上任何不一致的条目 ⇒ 红（#210 R2）；
5. **③** registry 说 latest 已发布、没有 tag ⇒ 未判定 `TAG_MISSING` + `expectExit: 2`（**不是红**）；
6. **③（历史段无 tag 不判）** 已发布但不是 latest、又没有 tag ⇒ 记一笔跳过，不 exit 2；
7. **历史段不受 (a) 管**：历史段「带日期 + 正文标未发布」改日期仍绿；
8. **⑤（放行证）** 未发布段换成本仓另一种合法无日期形状（`— 截至本提交尚未发布`）⇒ 绿；
9. **干净检出**：tag 面读不出 ⇒ 日期↔tag 这一半跳过、不判红（#280 口径）。

变异没落上算失败：所有 overlay 都走 `runSelfTest` 既有的「`after === before` ⇒ 红」判据；tag 面 / 登记表
走 `simulateTagFacts` / `simulateDateTagExemptions` 配置口子，跑完在 `finally` 里还原（一条也不留在全局）。

`release-day --self-test` 新增：⑦c（段首**同一行**写成 `## [0.31.0] - 2026-11-03`，全树逐字节比对）、
⑦e（未发布态拿掉日期 + 只有一行变 + 行数不变）、⑦f（缺省日期 = 当天 UTC+8，用运行前后两天的并集兜住
跨零点）、⑦g（日期形状不对 ⇒ exit 2、0 字节）、③b（`check:docs` exit 2 / 仅 `TAG_MISSING` ⇒ 回写不判红、
状态进 `written`）、③c（exit 2 但原因不是 `TAG_MISSING`、或一处标记都读不到 ⇒ 仍红、状态留
`published_unwritten`）。

## 改动了既有期望的地方（逐条理由）

1. **`CHANGELOG.md:6` 段首** `## [0.31.0] - 2026-11-10（未发布 / unpublished）` → **`## [0.31.0]（未发布 / unpublished）`**
   （逐字等于另一条分支 `feat-261103-06-release-031-cut` 的目标文本）。理由：工单判据 1；只动这一行。
2. **`test/static-guards.test.js` 的 `CHANGELOG_PAIR_FLOOR_SURFACE`**：校准面标题跟着段首一起改成新文本
   （外加那段注释补一句「bullet 一条没动 ⇒ 实测仍 3 对、地板 3 不变」）。理由：那条守卫的校准面是
   **段首字面量**，标题变了它找不到面就会静默失去校准依据；条目集合没动，所以地板不重测。
3. **`scripts/release-day.mjs` 的 `SYNC_FIXTURE` CHANGELOG**：`## [0.31.0] - 2026-11-10（未发布 / unpublished）`
   → `## [0.31.0]（未发布 / unpublished）`。理由：夹具必须与本仓**当前的合法形状**一致，否则 ⑦c 测的是
   一个已经不存在的输入。
4. **`release-day --self-test` ⑦c 的期望**：从「摘掉标记、留下 `- 2026-11-10`」改成「段首那一行写成
   `## [0.31.0] - 2026-11-03`」，并显式传 `--published-date 2026-11-03`。理由：判据 3 要求标记与日期
   **同一步写**，旧期望正好是本单要消灭的「标记摘了、日期还是占位」那一态；显式给日期是为了不把自测
   绑在「今天是哪天」上。
5. **⑦d（幂等）**也显式传 `--published-date`。理由：缺省值 = 当天，跨零点跑会假红。
6. **`release-day` writeback ③ 从 `run` 改成 `capture`，且 exit 2 不再一律红**：只有「每一处未判定原因都是
   `TAG_MISSING`」才算未判定。理由：工单判据 2 的后半句；这是**有条件的**放宽，条件本身由 ③c 两例钉住
   （别的 exit 2 仍然红）。
7. **`docs-drift-check` 退出码尾部重构成 `docsDriftExitCode`**：0/1/2 的语义不变（`READ_FAILURES` 仍是
   exit 2 且先于 errors 打印），只是多了「未判定」这一族并让主路径与自测读同一份。理由：#575 的纪律
   （同一判据只能有一个退出码来源），否则「未判定 ≠ 红」只能靠读代码相信。
8. **自测对照组改用 tag 夹具**（`SIM_TAG_FACTS` 在对照组前后挂/还原）。理由：工单要求自测不依赖真实 tag；
   对照组绑在「这台机器碰巧有哪几个 tag」上就不再是自测。
9. **`AGENTS.md` / `AGENTS_cn.md` 的 `release:day` 行 + §4 命令行（中英成对）**：写明段首「标记与日期同一步
   写」、`--published-date`（缺省当天 UTC+8）、以及 writeback 那次 `check:docs` 的 exit 2/`TAG_MISSING` 口径。
   理由：口径变了就要写在指令面上（否则下一次发版日没人知道为什么 exit 2 不是红）。

## 判据清单（逐条退出码，本机实测）

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `npm run check:syntax` | 0 | |
| `node scripts/docs-drift-check.mjs --self-test` | 0 | **198 例**（改前 189） |
| `npm run check:docs` | 0 | 123 项 |
| `npm run check:docs:strict` | 0 | |
| `npm run check:docs-spelling` | 0 | |
| `npm run check:agents-directives` | 0 | |
| `node scripts/agents-directive-scan.mjs --self-test` | 0 | 16 例 × 3 形态 |
| `npm run check:docs-examples` | 0 | |
| `npm run check:pack-links` | 0 | |
| `node scripts/pack-link-check.mjs --self-test` | 0 | |
| `npm run check:changelog` | **1** | **基线 `a5cc4ba` 上就是 1**（见下「遗留问题」），与本次改动无关 |
| `npm test` | 0 | tests **3400** / suites 13 / pass **3387** / fail **0** / skipped **13** |
| `npm run check:test-summary -- --log <tap>` | 0 | `TEST-SUMMARY-VERDICT ok`（tests=3400 / fail=0 / maxSkipped=15） |
| `npm run check:test-summary -- --self-test` | 0 | 16 例 |
| `npm run check:inventory` | 0 | 逐文件 0 处不一致（未新增兼容钉子 ⇒ 不需要 `--sync`） |
| `npm run check:config-leaf-values` | 0 | |
| `npm run check:mutation` | 0 | |
| `node scripts/mutation-sample-check.mjs --self-test` | 0 | 26 例 |
| `npm run check:types` | 0 | 94 / 26 文件（基线 103，低于基线 ⇒ 绿 + 可下调提示；**未**下调，不是本单的事） |
| `npm run check:types -- --with-tools` | 0 | 129 / 28（基线 138） |
| `npm run check:types:strict` | 0 | 1845 / 70（基线 1892） |
| `npm run check:types:strict -- --with-tools` | 0 | 2058 / 76（基线 2122） |
| `npm run check:types-build` | 0 | 87 个 `.d.ts`，跑完已清理 |
| `npm run check:exports:deprecated` | 0 | |
| `node scripts/guide-removal-gate.mjs --self-test` | 0 | 18 条判据 |
| `node scripts/test-hygiene-check.mjs --self-test` | 0 | 13 例 |
| `node scripts/release-day.mjs --self-test` | 0 | **61 条判据**（改前 52 条 `expect`） |
| `npm run check:release` | 0 | 6 步全绿 |

额外两条**真值面**复验（不在清单里，但本单依赖它们）：

- **干净克隆**：`git clone <worktree> /tmp/clone697` ⇒ `node scripts/docs-drift-check.mjs` exit **0**
  （`changelog-date: … 8 段 … 2 段登记 … 10 段没有 tag`）。
- **`--offline`**：`node scripts/docs-drift-check.mjs --offline` exit **0**，日期↔tag 那一半按 registry 不可得
  跳过并打印原因（与 #511 的既有口径一致）。

## 未验证项 / 遗留问题

1. **`npm run check:changelog` 在基点 `a5cc4ba` 上就是红的**（不是本单造成）：在 `a5cc4ba` 的独立 worktree 上
   跑同一条命令，输出逐字相同 ——
   `✗ #691 的合并 a5cc4ba 碰到了公开面（package.json），而 0.31.0 段里没有它` /
   `✗ #696 的合并 a5cc4ba 碰到了公开面（package.json），而 0.31.0 段里没有它`（exit 1）。
   修它要往 **0.31.0 段正文**加条目，而本单的文件所有权写明「CHANGELOG.md 只准动 0.31.0 段首那一行」，
   所以**没有动**。这是 main 上的一个既有缺口（#691 自己的合并没有被它自己那道闸记进 0.31.0 段），
   需要另一张单/另一条分支补一条 `#691 / PR #696` 的记录。
2. **`TAG_MISSING` 的范围**（只咬 registry 的 latest）是一个**写明了的范围决定**，理由与代价都写在上面；
   如果维护者要求「每个已发布段都必须有 tag」，本仓历史会让 `check:docs` 永久 exit 2 —— 那需要先把历史
   tag 补齐（另一个决定）。
3. **`CHANGELOG_DATE_TAG_EXEMPTIONS` 的两条历史不一致没有回填**（0.19.0 tagger 2026-10-14 00:50 +0800
   vs CHANGELOG 2026-10-13；0.25.0 tagger 2026-10-25 02:15 +0000 = UTC+8 10:15 vs CHANGELOG 2026-10-24）：
   都是「发版作业跨了零点」的真实历史，工单边界要求不许为了绿去改历史事实。登记表条目空转即红，所以
   将来真要对齐日期，必须同时删掉对应条目。
4. **跨零点的发版作业**：`--sync` 缺省写「回写那一刻的当天」，而 tag 是 finalize 打的。若 finalize 跨到
   第二天，`check:docs` 会红并点名两个日期（这是设计意图），修法是用 `--published-date <tag 那一天>` 重跑
   回写。这条路径没有在真实发版里跑过（没发布 0.31.0）。
5. 自测 ⑦f 断言「缺省日期 = 当天 UTC+8」用了运行前后的两天并集来兜跨零点；若机器时钟在运行中被拨动，
   这一例会红（可接受的边界，已写在这里）。
