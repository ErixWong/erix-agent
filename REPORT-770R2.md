# REPORT-770R2 — self-test 从 5/219 红回到 exit 0（R2 收口）

分支 `fix-261108-15-snapshot-stop-selftest-erix`，基点 `50e1d93`（#770 主切片头）。不 rebase、不 push、不开 PR。

## 取证边界

**只在这棵树工作**：`/home/eric/wt-770e2`。未碰 `/home/eric/wt-770w2`（同单对照树）、`/home/eric/wt-770e`、`/home/eric/wt-774*`、`/home/eric/wt-73*`、`/home/eric/wt-753*`。

**本片的输入事实（全部指回真跑过的命令或本仓文件的真行）**：

- 起点：`git log --oneline -1` → `50e1d93 docs(#770): 记 docs-drift --self-test 5/219 红的根因…`。
- 5 条红的根因表来自 `REPORT-770.md` 最后一节（该节自己给出 fixture 行号：`scripts/docs-drift-check.mjs:8725`（键名变异靶子）、`:8740`（R3 删行定位）、`:8547`（`CELL_AXES_DISTRACTOR_LINE = 3036`）、`:8805`、`:8846`（两条期望红话集合））；**例名与行号以本片自己复跑为准**，见下面「self-test 基线复跑」。
- #770 之后树上真值：`status` / `compactionStats` 两格 write 轴 `stopped`，锚点 `kind:"comment"` 钉 `src/loop/orchestrator.js:3029` / `:3038` 两行解释注释（`compactionStats|write` 另有 `:6185` 轮记录真写点这条登记条目）。
- 派生值纪律：`BARE_LINE_REF_BASELINE` **必须仍是 6**（本片实测的 8/10 计数按现测写进期望，不抬基线）；`CHANGELOG_PAIR_FLOOR`、`SYMBOL_ANCHOR_MIN_UNIQUE` 只能按闸/守卫**自报**现测值改。

**判据边界（工单原文）**：

1. `node scripts/docs-drift-check.mjs --self-test` exit 0（例数报出来）；一轮 ~8 分钟，最多两轮。
2. 每例一张「例子诚实性对账表」5 行：原来问什么 / 为什么 #770 之后问不到（fixture 哪一行）/ 新靶子坐标（文件:行）/ 它仍在问同一件事的证据。证据 = **我自己加的一条反向证**：削弱对应判据（或把靶子还原成旧形状）⇒ 该例必须红且点名它。
3. 禁止：把 expected 改成「红什么都算红」（必须点名具体红话）；把例子改成恒绿/跳过；抬派生值基线。
4. 闸：`node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js`、`node --test test/static-guards.test.js`、`npm run check:docs`、`:strict`、`:docs-spelling`、`:syntax`、`:agents-directives`。`npm test` 全套不跑；`test/test-suite-baseline.json` 不动；原则上不动 `src/`（若动则三档 typescript 棘轮按现测、基线不抬）。

**本片不做的事**：不改判据的语义强度（只换靶子坐标与期望集合的组成，且每条红话逐句点名）；不改 `src/`（除非常驻红无法在 fixture 层收口，届时在此追加理由与实测）；不动 `test/test-suite-baseline.json`。

## 基线复跑（动手前，例名以本次为准）

命令：`node scripts/docs-drift-check.mjs --self-test`（在 `/home/eric/wt-770e2`，node v22.23.2 = `which node`），日志 `/tmp/770r2e-selftest-base.log`：**`docs-drift-check --self-test: 失败 — 5/219 例未达预期`，EXIT=1**，218 绿。5 条 ✗ 的原文（逐字摘自日志第 220-232 行）：

| # | 例名（日志原文节选） | 框架给的失败原因（原文） |
|---|---|---|
| E1 | 「#772 豁免不是『行号在范围内就行』的免检通道：把 `status` 写点的锚点削弱成**键名本身**…」 | `变异没落到 scripts/cell-axes-anchors.mjs 上（反向证自身失效…）` |
| E2 | 「#772 R3 『删锚点躲过去』不成立：删掉 scripts/cell-axes-anchors.mjs 里 `status` 写点那一条登记…」 | 同上：`变异没落到 scripts/cell-axes-anchors.mjs 上` |
| E3 | 「#772 R2 评审第 3 节那个现场：把 CN 表 `src/loop/orchestrator.js:6185` 换成同一键名的注释行 :3036 …」 | `变异没落到 docs/host-consumer-contract_cn.md 上` |
| E4 | 「#772 R4 M-A 反方向：kind=comment 的锚点（`toolUse` 停写证据）被换成一句真代码 ⇒ 同样红（种类不许逆）」 | `红了，但错误信息没点该点的名…（未命中 /锚点种类不符/ ; /kind=comment/ ; /不是注释行/）`，实测里多出 `bare-lines: …实测 **8** 处，超过棘轮基线 **6** 处` |
| E5 | 「#772 R4 已知限度（特征用例…）：把写点锚点换到**同一键名的另一处真代码行** + 两份引文同步改口 ⇒ 机械上全绿」 | `变异之后本该绿…实测 4 处红`：`实测 **10** 处 > 基线 **6** 处` + 两份表「compactionStats write 列与登记锚点不等值——表写 :3038 / :3505 ／ 锚点实际 :3038 / **:3529**」 |

**派生值现测**（不改基线）：`BARE_LINE_REF_BASELINE` 仍是脚本里的 `6`（`grep -n '^const BARE_LINE_REF_BASELINE' scripts/docs-drift-check.mjs` → `2746:const BARE_LINE_REF_BASELINE = 6;`）；E4 变异体现测 8 处、E5 变异体现测 10 处，都按现测写进期望，基线不抬。

**新靶子坐标（全部现读实测，探针脚本 `/tmp/770r2e-probe.mjs`，用 `scripts/cell-axes-anchors.mjs` 自己的 `anchorHitLines()` 算）**：

- `status`|write 注释锚点 `^ {8}// ⇒ \`status\` 停写的理由：` → `src/loop/orchestrator.js:3029`
- `toolUse`|write 注释锚点 → `src/loop/orchestrator.js:3017`
- `compactionStats`|write：注释锚点 → `:3038`；kind=code 锚点（轮记录）→ `:6185`
- 同键名的**干扰注释行**（`/^ +\/\/ - \`compactionStats\`：/`）唯一命中 → `src/loop/orchestrator.js:3036`
- 「同一键名的另一处真代码行」`/^ {6}compactionStats,$/` 唯一命中 → `src/loop/orchestrator.js:3529`（`      compactionStats,`，run-state 落盘载荷，**不是**这格的写点）；旧靶子 `:3505` 上的那行已被 #770 删除
- CN 表 `compactionStats` 行 = `docs/host-consumer-contract_cn.md:1919`（EN = `docs/host-consumer-contract.md:2368`）；写点格现文 = `` `src/loop/orchestrator.js:3038`、`src/loop/orchestrator.js:6185` ``（旧夹具认的「（快照）」字样已不存在，但闸自己读的是 `cells[5]`，见 `cellAxesTableRefs`）

## 例子诚实性对账表（5 行 · 每条一个「新靶子 + 仍在问同一件事的证据」）

行号来源全部是本轮现读：`scripts/cell-axes-anchors.mjs` 的锚点表在 `// CELL-AXES-ANCHORS:BEGIN` 之后（`export const CELL_AXES_ANCHORS = [` 是第 110 行，一条登记占一行）；两轴表 CN 标记区 `docs/host-consumer-contract_cn.md:1903` 起、EN 标记区 `docs/host-consumer-contract.md:2352` 起。

### 例 1 —「把 `status` 写点锚点削弱成键名 ⇒ 锚点歧义」（`docs-drift-check.mjs` 里的 #772 免检通道那一例）

- **原来问什么**：锚点被削弱成「只是提到键名」的词面 ⇒ 词面在源码里命中多处 ⇒ 闸自己重算当场报「锚点歧义」，那条引用掉出逐组豁免 ⇒ 裸行号棘轮回红。
- **为什么 #770 之后问不到**：旧变异是 `replaceUnique('"^ {8}status,$"', '"status"')`，而 #770 把快照载荷里那行 `status,` 删了 ⇒ 锚点表里再也没有 `"^ {8}status,$"` 这个字面量 ⇒ 变异没落上（框架先报「变异没落到 `scripts/cell-axes-anchors.mjs` 上」，判据根本没被问到）。
- **新靶子坐标**：`scripts/cell-axes-anchors.mjs:112`（`status`|write，`kind: "comment"`，锚点命中 `src/loop/orchestrator.js:3029`）；定位不再拿整份文件的字面量，改成只在 `export const CELL_AXES_ANCHORS = [` 之后按 `key: "status", axis: "write"` + `anchor:` 现读那一行（`cellAxesAnchorTableRow` / `cellAxesStatusWriteAnchorRow` / `cellAxesWeakenAnchor`）。削弱后的锚点仍是**键名词面** `"status"`。
- **仍在问同一件事的证据**：① 永久反向证 R1（本轮新增，`--self-test` 里）＝把这一格锚点**还原成 #770 之前的旧形状** `^ {8}status,$` ⇒ 红，点名「锚点 0 命中（正则 ^ {8}status,$）」+「没有登记锚点…也不再被豁免」+ `status` + 棘轮回红；② 判据削弱影子跑 SA-W1（`hits.length !== 1` → `hits.length === 0`）⇒ 本例变红且缺 `/锚点歧义/`（见下表）。

### 例 2 —「删掉 `status` 写点登记 ⇒ 不再被豁免」（#772 R3 删锚点躲过去）

- **原来问什么**：把这一格这一轴的登记条目整条删掉 ⇒ 那条行号没有基准 ⇒ 闸点名「没有登记锚点 ⇒ 也不再被豁免」⇒ 回到裸行号棘轮计数。
- **为什么 #770 之后问不到**：旧定位要求「整份模块文本里恰好一行同时含 `key: "status", axis: "write"` 与 `anchor:`」；#770 给人审清单 `CELL_AXES_REQUIRED_CELLS`（同文件第 57 行）也补了 `kind`/`anchor` ⇒ 命中 2 行 ⇒ `hit.length !== 1` ⇒ 变异原样返回。
- **新靶子坐标**：还是 `scripts/cell-axes-anchors.mjs:112` 那一行整行删（`cellAxesDropStatusWriteAnchor`，只在 `CELL_AXES_ANCHORS` 数组段内定位）。问的事一字未改。
- **仍在问同一件事的证据**：① R2（本轮新增）＝登记那一行**留着**、只把它的锚点削弱成跑不通的正则 `^ {8}status(,$` ⇒ 同样点名「锚点正则跑不通」+「没有登记锚点」+「不再被豁免」+ `status` + 棘轮回红（证的是豁免要的是**能重算的锚点**，不是「表里有一行」）；② SA-W2（`if (anchorLines === undefined) {` 之后直接 `continue`，取消那句点名）⇒ 本例变红且缺 `/没有登记锚点/`。

### 例 3 —「CN 表把写点行号换到同一键名的注释行 ⇒ 闸重算发现行号漂了」（#772 R2 评审第 3 节现场）

- **原来问什么**：表里那条裸行号被改引到**同一键名的另一句注释**上（词面看着像、语义错了）⇒ 闸按登记锚点重算 ⇒「与登记锚点不等值」并把锚点那一行原文印出来。
- **为什么 #770 之后问不到**：旧 overlay 用 `cells.findIndex((c) => c.includes(CELL_AXES_DRIFT_PROBE) && c.includes("（快照）"))` 认写点列；#770 之后那一格写的是 `` `src/loop/orchestrator.js:3038`、`src/loop/orchestrator.js:6185` ``（解释缺席的注释 + 快照轮记录），「（快照）」字样没了 ⇒ `col < 0` ⇒ 变异空跑（框架报「变异没落到 `docs/host-consumer-contract_cn.md` 上」）。
- **新靶子坐标**：`docs/host-consumer-contract_cn.md:1920`（`compactionStats` 那一行）的「今天的写点」列；列号由 `cellAxesWriteColumnIndex` 从标记区表头 `docs/host-consumer-contract_cn.md:1904` 现算（闸自己读的是剥掉首尾竖线后的 `cells[5]`，与这里同一列）。打进去的是同键名的干扰注释行 `src/loop/orchestrator.js:3036`（现算自 `/^ +\/\/ - \`compactionStats\`：/`，旧 `CELL_AXES_DISTRACTOR_LINE = 3036` 手抄值现算后**恰好仍是 3036**）。
- **仍在问同一件事的证据**：① R3（本轮新增）＝把那一格**还原成 #770 之前的单条引用形状**（删掉锚点重算出的第二条 `…:6185`）⇒ 点名「`compactionStats` 的 write 列与登记锚点不等值——表写 `…:3038` / 锚点实际 `…:3038` `…:6185`」+「cn 表里只引了 1 处，人审清单要求 2 处」；② SA-W3（`anchorLinesEqual` 判据被短路成恒真）⇒ 本例变红且缺 `/登记锚点不等值/`。

### 例 4 —「kind=comment 的锚点被换成一句真代码 ⇒ 种类不许逆」（#772 R4 M-A 反方向）

- **原来问什么**：钉「为什么没有写点」的注释锚点被换成**一句真代码** ⇒ 种类对账必须红（`kind=comment` 而命中的不是注释行），并点名 `toolUse`。
- **为什么 #770 之后问不到**：旧 overlay 拿 `key:"status" && axis:"write"` 那条登记当「一句真代码」；#770 之后 `status` 写点自己就是注释锚点 ⇒ 换进去的还是注释 ⇒ 种类没被逆 ⇒ 实测只剩「行号不等值」+ 计数红，`/锚点种类不符/`、`/kind=comment/`、`/不是注释行/` 三条全不在场。
- **新靶子坐标**：被换方 = `scripts/cell-axes-anchors.mjs:124`（`toolUse`|write，`kind: "comment"`，锚点命中 `src/loop/orchestrator.js:3017` 那句注释）；换入方 = `scripts/cell-axes-anchors.mjs:113`（`pendingToolUse`|write，`kind: "code"`，装进 `toolUse` 那条后唯一命中 `src/loop/orchestrator.js:3052` 的真代码行 `pendingToolUse: cloneState(snapshotPendingToolUse),`）。靶子由 `CELL_AXES_R4_REVERSE_CODE_TARGET` 现读：把候选锚点装进 `toolUse` 那一条（`kind`/`prev`/`codePath` 都用 `toolUse` 的）再算命中，要求唯一且非注释。本轮第一轮跑出的真教训：表里第一条 `kind: "code"` 是 `round`（`:111`），它的锚点 `^ {8}round,$` **自带 `prev`**，单独扫会命中 4 行（`:2808 :3004 :5663 :6127`）⇒ 闸先报「锚点歧义」就停了，种类判据轮不到出场（`/tmp/770r2e-selftest-r1.log` 里那条 ✗ 就是它）；所以候选必须按闸的算法（带上被换条的 `prev`）现算，`round` 因此被跳过。
- **仍在问同一件事的证据**：① R4（本轮新增）＝锚点与两份表引用**都不动**、只把登记的 `kind` 从 `"comment"` 改成 `"code"`（种类登记造假）⇒ 点名「锚点种类不符…`kind=code`…那一行**是注释行**」+ `toolUse` + 棘轮回红；② SA-W4（`anchorKindError` 短路成 `null`）⇒ 本例变红且缺 `/锚点种类不符/`（同族的 M-A 正向例也一起红，是预期的连带，不算把红改绿）。

### 例 5 —「已知限度」特征用例（放行证：机械上必须全绿）

- **原来问什么**：把写点锚点换到**同一键名的另一处真代码行**、并且两份表的引文同步改口 ⇒ 闸机械上问不出问题（全绿）；这一例钉的是「这一族放行是真的放行」，不是恒绿。
- **为什么 #770 之后问不到**：旧 overlay 把两份表的引文同步到写死的 `"src/loop/orchestrator.js:3505"`，而 #770 删掉的正是那一行；锚点 `^ {6}compactionStats,$` 现在唯一命中 `:3529` ⇒ 表写 `:3505` 与锚点 `:3529` 不等值 ⇒ EN/CN 各一条「不等值」红 + 逐组豁免被撤 ⇒ 裸行号实测 **10 > 6**（这 4 处红里只有计数那条是 #770 的诚实后果，其余 3 条是靶子过时）。
- **新靶子坐标**：`src/loop/orchestrator.js:3529`（`      compactionStats,`，run-state 落盘载荷——**另一件产物**），由 `CELL_AXES_R4_SAME_NAME_CODE_LINE` 现算（`/^ {6}compactionStats,$/` 唯一命中且非注释行，否则 `null` ⇒ 变异打不上 ⇒ 报红）；配套把 `docs/maintenance/command-reference.md:164` 那句「已知限度」的举例行号从 `:3505` 同步改成 `:3529`，并写清它是 run-state 载荷、不是这格的写点。
- **仍在问同一件事的证据**：① R5（本轮新增）＝把「两份引文同步改口」只做一半（只改 EN、CN 留着旧行号）⇒ 必须红，点名「cn：`docs/host-consumer-contract_cn.md` 表里 `compactionStats` 的 write 列与登记锚点不等值」——证的是这条放行证的绿**依赖两份表真的同步**；② 把靶子还原成旧形状（`:3505`）就是本轮基线那一跑：`/tmp/770r2e-selftest-base.log` 里这条 ✗ 点名自己（`表写 …:3505 / 锚点实际 …:3529`）。

## 判据削弱影子跑（SA）——「削弱判据 ⇒ 该例自己变红并点名」的字面证据

跑法：`git archive HEAD | tar -x -C /tmp/770r2e-SA` + `ln -s` 主树 `node_modules`，只在影子里改**判据本身**（不改 fixture、不改 docs），然后 `node scripts/docs-drift-check.mjs --self-test`，日志 `/tmp/770r2e-selftest-SA.log`。

| 削弱 | 改在哪 | 该例结果 |
|---|---|---|
| W1 | `docs-drift-check.mjs` 逐组重算的 `if (hits.length !== 1) {` → `if (hits.length === 0) {`（歧义锚点也算基准） | 例 1 ✗（缺 `/锚点歧义/`） |
| W2 | 同文件 `if (anchorLines === undefined) {` 之后直接 `continue`（不再点名「没有登记锚点 ⇒ 不再被豁免」） | 例 2 ✗（缺 `/没有登记锚点/`） |
| W3 | 同文件 `if (!cellAxesAnchorLinesEqual(cited, anchorLines)) {` → `if (false && …)`（等值对账短路） | 例 3 ✗（缺 `/登记锚点不等值/`） |
| W4 | 同文件 `const kindError = cellAxesAnchorKindError(...)` → `const kindError = null`（种类对账不判） | 例 4 ✗（缺 `/锚点种类不符/`；M-A 正向例连带 ✗） |

## 收口结果（判据 1：`--self-test` 回到 exit 0）

| 轮 | 命令 | 结果（日志原文尾行） | 日志 |
|---|---|---|---|
| r1 | `node scripts/docs-drift-check.mjs --self-test`（改完 5 条靶子 + 加了 R1–R5 之后） | `docs-drift-check --self-test: 失败 — 1/224 例未达预期`，`SELFTEST_EXIT=1`：只剩例 4（M-A 反方向），原因是换进去的 `round` 锚点自带 `prev`，装进 `toolUse` 那条后命中 4 行 ⇒ 闸先报「锚点歧义」，种类判据没出场 | `/tmp/770r2e-selftest-r1.log` |
| r2 | 同上（修完例 4 的候选筛选：唯一性按闸的算法现算） | **`docs-drift-check --self-test: OK — 223 例反向证/放行证全部按预期，对照组绿`，`SELFTEST_EXIT=0`** | `/tmp/770r2e-selftest-r2.log` |

例数变化：`SELF_TEST_CASES` 从基线的 **218** 条涨到 **223** 条（本轮新增 5 条永久反向证 R1–R5；`node -e` 数 `label:` 条目 = 223，成功行打印的就是这个数，失败行分母是 `+1` 的对照组）。`MIN_SELF_TEST_CASES` 仍是 99，没动。5 条 ✗ 全部清零，**没有删除或跳过任何一条原例子**：`git diff 50e1d93..HEAD -- scripts/docs-drift-check.mjs` 里只有「靶子定位/换入形状」的改动与新增用例，`expect` 一律是点名具体红话的正则（见 `/tmp/770r2e-m1.diff`、`/tmp/770r2e-m2.diff`、合档 `/tmp/770r2e-m-all.diff`）。

派生值一条没抬：`BARE_LINE_REF_BASELINE` 仍是 6（`grep -n '^const BARE_LINE_REF_BASELINE' scripts/docs-drift-check.mjs` 现读）；`CHANGELOG_PAIR_FLOOR`、`SYMBOL_ANCHOR_MIN_UNIQUE` 本轮一个字没改（闸门自报值没变：`check:docs` 与 `static-guards` 都绿，见下）。

## 闸门（判据 4）

| 命令 | 结果 |
|---|---|
| `node --test test/contract-snapshot-cell-axes-767.test.js test/loop-snapshot-write-side-735.test.js` | EXIT=0（`/tmp/770r2e-gate-contract.log`） |
| `node --test test/static-guards.test.js` | EXIT=0，`# tests 58 / # pass 58 / # fail 0`（`/tmp/770r2e-gate-static-guards.log`） |
| `npm run check:docs` | EXIT=0（`/tmp/770r2e-gate-docs.log`） |
| `npm run check:docs:strict` | EXIT=0（`/tmp/770r2e-gate-docs-strict.log`） |
| `npm run check:docs-spelling` | EXIT=0（`/tmp/770r2e-gate-spelling.log`） |
| `npm run check:syntax` | EXIT=0（`/tmp/770r2e-gate-syntax.log`） |
| `npm run check:agents-directives` | EXIT=0（`/tmp/770r2e-gate-agents.log`） |
| `node scripts/docs-drift-check.mjs --self-test` | EXIT=0（r2，见上） |

`src/` 没动（`git diff --name-only 50e1d93..HEAD` 只有 `scripts/docs-drift-check.mjs`、`docs/maintenance/command-reference.md`、`REPORT-770R2.md`），所以三档 typescript 棘轮按任务口径不必跑；`npm test` 全套与 `test/test-suite-baseline.json` 按任务口径没跑/没碰。

### 「没把红改绿了事」的两条机械核对

- **一条例子都没被删/改名/跳过**：`node -e` 逐条比对 `SELF_TEST_CASES` 的 `label:` 行——基线树（`git show 50e1d93:scripts/docs-drift-check.mjs`）里 218 条的 label 在现树里**全部原样在场**（"label 变了/没了的条数: 0"），现树 223 条 = 218 + 本轮新增 5 条反向证；`MIN_SELF_TEST_CASES = 99` 未改。
- **期望仍是点名具体红话**：5 条被改的例子的 `expect` 各自保留了原来的那句红（例 1 `/锚点歧义/`、例 2 `/没有登记锚点/`+`/不再被豁免/`、例 3 `/登记锚点不等值/`+`/那一行原文/`、例 4 `/锚点种类不符/`+`/kind=comment/`+`/不是注释行/`、例 5 是放行证 `expectGreen: true`），只把靶子定位换成现读；例 3/例 4 额外**加**了 `裸行号引用（唯一 \(文档,目标文件,行区间\)）实测 \*\*\d+\*\* 处，超过棘轮基线 \*\*\d+\*\*` 这一句（#770 之后每格 write 轴引两条、引用掉出豁免时一次掉两条，这句红是真的多出来了，按现测写、没抬基线）。

### commit 落点（与纪律的偏差，如实记）

纪律要「每完成一条例子就 commit 一次」。实际 E1–E5 的靶子改造落在同一笔 commit `97b786f`：五条共用同一批助手函数（`cellAxesAnchorTableRow` / `cellAxesWeakenAnchor` / `cellAxesDropStatusWriteAnchor` / `cellAxesWriteColumnIndex` / `rewriteCellAxesRowKind`），拆成五笔会让前四笔处在「助手在场但例子还没换」的中间态。每例的靶子与期望改动可在 `/tmp/770r2e-m1.diff` 里按「例 1 … 例 5」小节的注释定位；例 4 的二轮修正在 `716e47c`（`/tmp/770r2e-m2.diff`）。报告与结果分别落在 `a49fce2`、`bcd596d`、`9484e67`。合档：`git diff 50e1d93..HEAD > /tmp/770r2e-m-all.diff`。
