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

## 结果（主会话合并后复跑，不采信自报）

本切片由 worker 跑到 ③ 后**预算耗尽（30 分钟超时）**，④ 由主会话收尾。执行体判定按 `git status`，不按完成通知。

| 件 | 改动 | 现报 |
|---|---|---|
| ① | 两轴表 `path:line` 按锚点重登（EN/CN 各 15 行） | `node scripts/docs-drift-check.mjs` **exit 0**，`cell-axes-anchors` **0 条**；`bare-lines` 掉回棘轮面内（≤ 6，`BARE_LINE_REF_BASELINE` 一宇未动） |
| ② | `test/contract-snapshot-cell-axes-767.test.js` 的 `victims` `at:` 按 `anchorHitLines()` 现算 | `node --test --test-reporter=tap test/contract-snapshot-cell-axes-767.test.js` ⇒ **# pass 15 / # fail 0**（改前 6 格红）；`git show f6cfea8` 里新增/删除行**没有一行**动 `deepEqual` / `skip`（断言形状零变更） |
| ③ | `test/mutation-samples.md` 走 `--sync`（行号列 9 行） | `check:mutation` **exit 0**、`check:mutation:run` **exit 0**（后者是真变异→红→还原→绿）；`check:inventory` **exit 0**（兼容钉子表本树未变） |
| ④ | `CHANGELOG_PAIR_FLOOR` 33 → **34**（主会话补，commit `7b0e850`） | 守卫现报「校准面（## \[Unreleased\]）上实测 34 对 ≠ 地板 33 对」逐字抄进注释；同次观测行「中文 34 条 / 英文 34 条 / 配对 34 对 / 无对应 0 条」 ⇒ **不是 33+1**（两侧各自登记的常量现查都是 33）；`static-guards` ⇒ **# pass 58 / # fail 0** |

主会话在合并后的树上跑的整批（`7b0e850`）：14 道闸全 `exit 0`（`docs` / `:strict` / `docs-spelling` / `syntax` / `types` / `types:strict` / `inventory` / `mutation` / `mutation:run` / `docs-examples` / `pack-links` / `agents-directives` / `changelog` / `exports`）、`types:build` + `check:types-build` `0`、无 `*.d.ts` 时两道类型棘轮 `0`、`docs-drift-check --self-test` **OK — 223 例**（exit 0，`✗` 行数 0）。全量 `npm test`：**`# tests 3768 / pass 3751 / fail 2 / skipped 15`**。

## 未验证

- **那 `fail 2` 不在本切片范围**，且本切片没修它：两格都在 `test/tools/file-tools.test.js`（`:931` / `:1293`），现报「全树「一次装得最少」已不是 `src/loop/pending-tool-result.js`（现在是 `src/loop/resume-manager.js`，3696 行 / 70.92 B/line）」——这是 **`readFile` 行数容量档位换人**（本支 #769 + 主干 #754 的中文注释抬高了均行字节），已另开 R10 重登（工单在本会话的仓外工作目录里，克隆后解不到，故不写它的文件名）。**不把它计作本切片已验。**
- ② 只改了行号与「注释锚点只许 N 条」的**现算条数**；三格读轴措辞（恢复行优先 / 快照兜底）属 #769 主体，本切片未动。
- TAP 基线登记（`test/test-suite-baseline.json`）本切片按约定**没动**，由主会话在最终树上重取。
- 两轴表的内容口径（哪一格算 source / fallback）本切片只**重登行号**，没重新判据；口径变更需人审，不在重取范围内。
