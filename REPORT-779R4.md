# REPORT-779R4 — issue #772 的 R4（M-A 锚点种类 + M-B 独立覆盖面真值）

树：`/home/eric/wt-779e`，分支 `fix-261108-09-cell-axes-kind-required-erix`，基点 `5e819a4`（PR #779 的头）。
未 rebase、未 push、未开 PR；未碰 `/home/eric/wt-779w` 与其它 `wt-77*`。

## 取证边界

**打开并读过的路径**：

- `REVIEW-779.txt`（本轮验收报告，两条 mandatory 的变异原文）
- `scripts/cell-axes-anchors.mjs`（锚点登记表 + 哨兵区 + 解析/求值函数）
- `scripts/docs-drift-check.mjs`（`checkCellAxesAnchorTable` 一族、裸行号棘轮、`--self-test` 框架与本族用例）
- `test/contract-snapshot-cell-axes-767.test.js`（G1–G5 与本族反向证）
- `test/loop-snapshot-write-side-735.test.js`（只读，确认未被本轮改动牵连）
- `docs/host-consumer-contract.md` / `docs/host-consumer-contract_cn.md`（两份契约表的标记区，只动标记区内的两轴引用格）
- `docs/maintenance/command-reference.md`（本轮新增「已知限度」那条）
- `test/static-guards.test.js` 的配对地板一节与 `AGENTS*.md` 的常量声称行（只读，取现报值）
- `src/loop/orchestrator.js` / `src/loop/snapshot.mjs`（只用来自现读代码的行号当锚点靶子）
- `package.json` 的 `check:*` 脚本面

**没做的**：

- 没跑 `npm test` 全套（按派单，主会话跑）；没跑 `npm run verify` / pg 套件
- 没跑 `check:exports` / `types:build` / schema 类闸（本轮没动公共面与类型）
- 没动 `test/test-suite-baseline.json`（TAP 基线留给主会话在合并树现取）
- 没为「已知限度」加启发式（按派单：只登记 + 特征用例，不追打）
- 没 rebase / push / 开 PR；没碰对照树

## M-A：锚点「种类」成为硬判据（已关）

- `scripts/cell-axes-anchors.mjs`：39 条登记每条加 `kind: "code" | "comment"`。`comment` 共 **3** 条（`toolUse`+`write`、`ts`+`write` 的「解释为什么没有写点」那句注释，以及 resume 侧「不要相信快照里的 `persistedTranscriptLength`」那条）；其余 **36** 条 `code`。
- 判据只有一份：`anchorKindError()` 住在 `scripts/cell-axes-anchors.mjs`，**闸（`checkCellAxesAnchorTable`）与契约测试都 import 它**，两处不再各写一遍。规则：`kind=code` 而锚点唯一命中那行是注释行（`^\s*(\/\/|\/\*|\*)`）⇒ 红；`kind=comment` 而命中的不是注释行 ⇒ 红；`kind` 缺失或不在 `code|comment` ⇒ `parseCellAxesAnchorTable()` 拒绝发豁免。
- 报错点名「哪一格哪一轴 + 命中行号 + 命中那一行原文」（原文见下面的闸报错）。
- 提交：`59e80cf`（判据）、`85c93d0`（测试）；`/tmp/779r4-m-a.diff`（48377 字节，与 `/tmp/779r4-wip.diff` 同一份快照）。

## M-B：独立的「必须存在的格子」真值（已关）

- 新增 `CELL_AXES_REQUIRED_CELLS`：人审手写的 `(key, axis, codePath, row)` 清单，**39 个槽位 / 27 组 / 14 格名**；刻意**不**从 `CELL_AXES_ANCHORS` 现算（现算就不是第二份真值）。
- 判据 `checkCellAxesCoverage()`（同一份，闸与测试共同 import）：每一格必须在 ① 人审清单 ② `CELL_AXES_ANCHORS` 登记 ③ EN 表 ④ CN 表四处**各自**在场，引用是**逐槽计数**而不是「提过一次」；缺任一处 ⇒ 红并点名「缺哪一格、缺在哪一份」。
- 地板改成**由清单算出**：`CELL_AXES_ANCHOR_FLOORS = { entries: CELL_AXES_REQUIRED_CELLS.length, groups: new Set(CELL_AXES_REQUIRED_CELLS.map(c => `${c.key}|${c.axis}`)).size }` ⇒ 现报 **39 / 27**；注释里写明「只许随清单涨，不许手调」，旧的独立手填数 **30 / 25** 不再存在。
- `/tmp/779r4-m-b.diff`（16079 字节）。

## 已知限度（登记，不堵）

把 `compactionStats` 的写点锚点改成**同一键名的另一处真代码行** `src/loop/orchestrator.js:3505`（那行是 `compactionStats,`，在轮记录/payload 打包处，不是快照写点 `:3038`），并把两份契约表的引文**同步**改口 ⇒ 机械上仍全绿。原因写在 `docs/maintenance/command-reference.md` 的 `## docs-anchors` 一节（*Known limit: semantics are not machine-checkable*）：文件在场、锚点唯一命中、`kind: "code"` 与代码行相符、两表与重算数字相等、覆盖面清单仍满足——机器问得出的一问不差；「这一行就是本格讲的那个事件」是阅读判断，留在人审。**没加启发式**。

钉成契约的两处：

- `--self-test` 绿控例：`#772 R4 已知限度（特征用例，见 docs/maintenance/command-reference.md）：… ⇒ 机械上全绿（… 故本例断言它**不红**）`
- 测试例：`G4-R6 特征用例（已知限度，见 command-reference）…`（断言当前**不红**）

## self-test（主判据）

- `node scripts/docs-drift-check.mjs --self-test` → **exit 0**，**219 例**全绿（见下方实测轮次原文）。
- 例数：本轮前（基点 `5e819a4` 的脚本）数组里 **212** 条 `label:`、实跑 **213** 例；本轮 **+6** 例（M-A 红 ×3、M-B 红 ×2、已知限度绿控 ×1）⇒ 现 **218** 条 `label:`、实跑 **219** 例。`#772` 一族由 **13**（9 红 + 4 绿控）涨到 **19**（14 红 + 5 绿控），文档那句声称已同步改。
- 第一轮实测 **1/219 失败**（不是判据错，是变异靶子过期）：`#772 R3 「删锚点躲过去」不成立` 的变异按 `key: "status", axis: "write"` 过滤行，而 M-B 的人审清单里也有 `status`+write 那一格 ⇒ 命中 2 行、变异放弃、判「变异没落上」。修法：过滤再加 `&& l.includes("anchor:")`，只挑登记表那一条。第二轮见下。

## 闸门结果（派单点名的那些，逐条实测）

| 命令 | 结果 |
| --- | --- |
| `node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js` | **exit 0**，`# tests 22 / # pass 22 / # fail 0` |
| `node --test test/static-guards.test.js` | **exit 0** |
| `npm run check:docs` | **exit 0** — `docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 126 项对齐 package.json 0.31.0 与源码`；`docs-sync-check: OK — 中英契约标题结构对齐（115 节，锚点齐全）` |
| `npm run check:docs:strict` | **exit 0** — `docs-drift-check: OK … 共 126 项对齐 package.json 0.31.0 与源码` |
| `npm run check:docs-spelling` | **exit 0** — `--strict: OK — 0 处红` |
| `npm run check:docs-examples` | **exit 0**（`# duration_ms 4804.708916`） |
| `npm run check:syntax` | **exit 0** — `syntax-check: OK — 全量 494 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过（口径：git ls-files，含 src/ bin/ scripts/ test/ examples/ fixtures/）` |
| `npm run check:agents-directives` | **exit 0** — `2 份指令面文件 × 3 类，逐格等于实测；2 份指令面文件的字节数逐格等于推出来的那一格（ceil512(实测) + 1024）` |

## 派生值（照闸/守卫自己打印的原话）

- `BARE_LINE_REF_BASELINE`：**仍是 6**（`scripts/docs-drift-check.mjs:2746`）。守卫打印的声称面对账原文：
  `#   AGENTS.md：SYMBOL_ANCHOR_MIN_UNIQUE=238@131, BARE_LINE_REF_BASELINE=6@132, REF_SCAN_DOCS_MINIMUM=51@133, BASELINE_ROOT=99@105, ...`
- `SYMBOL_ANCHOR_MIN_UNIQUE`：**238**（同上那行原话，未被本轮改动挪动）。
- `CHANGELOG_PAIR_FLOOR`（本树 27）：守卫现报原文
  `# 配对地板：判据面 = ## [Unreleased]（第 4 行，由 resolveChangelogScanSurface 选出：顶部 Unreleased 有内容）；中文 27 条 / 英文 27 条 / 配对 27 对（其中按「无 issue 引用 + 紧邻」配的 0 对）/ 无对应 0 条；地板 27（校准面 ## [Unreleased]）`
  反向证那一行：`# 配对地板反向证：删掉第 9 行英文条目 ⇒ 26 对（地板 27，已穿底）+ 中文第 10 行无对应；把该条的 #286 改成 #999（数量不变）⇒ 26 对；还原 ⇒ 27 对全绿`
- `CELL_AXES_ANCHOR_FLOORS`：**改成导出值**，推导 = `{ entries: CELL_AXES_REQUIRED_CELLS.length, groups: new Set(...map(c => `${c.key}|${c.axis}`)).size }` ⇒ 现报 **39 条 / 27 组**（14 格名）。它随清单涨，不再是独立手填数。
- TAP 基线：`test/contract-snapshot-cell-axes-767.test.js` 顶层用例 **12 → 15**（新增 `G4-R4`、`G4-R5`、`G4-R6`），`test/loop-snapshot-write-side-735.test.js` 不变（7）⇒ 派单点名的两个文件合跑由 19 → **22**（实测 `# tests 22`）。基线文件未动。

## 未验证

- **语义真值**：锚点指的是不是「本格所讲的那个事件」机器证不了（已登记 + 特征用例钉住，见上）。
- `--self-test` 只在**本树**跑过；合并树里若别的分支也动 `#772` 一族常量（`CELL_AXES_REQUIRED_CELLS` 条数、`BARE_LINE_REF_BASELINE`、`SYMBOL_ANCHOR_MIN_UNIQUE`、配对地板），需要主会话在合并树上重跑取新现报值。
- `npm test` 全套、`npm run verify`、pg 套件、`check:exports` / `types:build`：本轮没跑（派单不要求）。
- 覆盖面清单的**完整性**本身（39 格是否就是「应当覆盖的全部格子」）是人审结论，机器只能证「清单里每格四处都在」，不能证「清单没有漏格」——漏格仍要人审或评审变异来发现。
- 对照树 `/home/eric/wt-779w` 的取舍与本轮无关（未读、未比）。
