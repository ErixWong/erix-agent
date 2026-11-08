# REPORT-769-r9 — 合并主干 `ad1ddd5` 之后的派生值重取（#769 合并前最后一段）

基点：`947a95f`（本支 merge `origin/main = ad1ddd5`，含 #778 / #754）
工作树：`/home/eric/wt-769w9`（独立树；`/home/eric/wt-769e4` 由主会话持有跑最终闸与推送）

## 取证边界

**只许使用的事实来源**（本次每一条数字都从这些地方现取，没有一条是手填/加法/记忆）：

1. `node scripts/docs-drift-check.mjs` 的 `cell-axes-anchors` 现报行 —— 每条自带「表写 X / 锚点实际 Y」，
   ①的每一个新行号都直接抄 Y，不做算术。
2. `scripts/cell-axes-anchors.mjs` 的 `anchorHitLines()` —— ②里测试的 `at:` 值用它在**当前树**上现算，
   不猜、不从旧树抄。
3. `scripts/flat-count-inventory.mjs --sync` / `scripts/mutation-sample-check.mjs --sync|--verify|--run` 的自报值 —— ③的表由脚本自己写。
4. `node --test --test-reporter=tap test/static-guards.test.js` 红行里守卫自报的「实测 N 对 ≠ 地板 M 对」——
   `CHANGELOG_PAIR_FLOOR` 取 N，并把该红行原文抄进注释。
5. `npm run check:docs-spelling` 现报 uses —— 拼写钉子按扫描器现报改，逐条定位写进注释。

**不许动的东西**（本切片边界）：

- `BARE_LINE_REF_BASELINE` = **6**，一字不动（不许抬到 72）。
- `test/test-suite-baseline.json`（TAP 登记由主会话在全量跑完后重取）。
- 三个类型棘轮基线常量（本切片不改 `src/`）。
- `test/contract-snapshot-cell-axes-767.test.js` 的断言形状：`deepEqual` 不许降级成「包含即可」，
  `at:` 的等值比较不许改成只比 path，不许删例 / 加 skip。
- 两轴载荷表不许为消红而删列或改成不带行号的形式。

**不在本切片范围内**：全量 `npm test`、`docs-drift-check --self-test`（~7.5 分钟）—— 主会话复跑。

## 现场（改前的红，命令现报）

```
$ node scripts/docs-drift-check.mjs
docs-drift-check: 失败 — 56 处漂移
  ✗ bare-lines: 裸行号引用（唯一 (文档,目标文件,行区间)）实测 **72** 处，超过棘轮基线 **6** 处——…
     分布：docs/host-consumer-contract.md 40、docs/host-consumer-contract_cn.md 40、
           docs/host-upgrade-guide-v030.md 1、docs/host-upgrade-guide-v030_cn.md 1
  ✗ cell-axes-anchors: …（en 27 条 + cn 27 条 = 54 条）
  ✗ bare-lines: 标记区定点豁免的机器复核不在场 —— 闸自己按登记锚点重算不过（共 54 条）
```

72 不是真新增裸行号：两轴载荷表在 `<!-- erix:snapshot-cell-axes:begin/end -->` 区域内**只在该区域每行都与
其锚点等值时**才豁免（#772 设计）。锚点对不上 ⇒ 整表掉回计数面。修好 ① 之后 72 自己回 6。

## 计划

### ① 两轴载荷表的 `path:line` 按锚点现算重登（EN + CN）

逐条照 `docs-drift-check` 现报的「锚点实际 Y」改表里那一格。判据：`cell-axes-anchors` 零条 **且** `bare-lines` 回到 6。

### ② `test/contract-snapshot-cell-axes-767.test.js` 六格红（G4 / G4-R1 / R3 / R4 / R5 / R6）

同成因：写死的 `at:`（`victims` 那批 + 注释锚点白名单）是各自树上的现测。
用 `anchorHitLines()` 在当前树重算；`G4-R4` 的白名单保留本支新增的三格读轴
（`executedToolIds|read` / `partialRound|read` / `partialText|read`），并把旁边「注释锚点只许 N 条」的文字按现算条数改。

### ③ 其余派生表（只走各自 --sync / 自报值）

- `flat-count-inventory.mjs . --sync test/compat-pin-inventory.md`
- `mutation-sample-check.mjs --sync test/mutation-samples.md` → **再手核「预期红的签名」列**（#770 栽过：行号同步了、签名还指着旧测试名）→ `--verify` → `--run`
- `CHANGELOG_PAIR_FLOOR` ← 守卫自报的 N（两边各加了一对中英，大概率 34，但取现报）
- 拼写钉子按 `npm run check:docs-spelling` 现报 uses 改

## 未验证

（收尾时填，保持最后一格）
