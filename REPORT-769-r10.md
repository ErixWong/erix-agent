# REPORT-769-r10 —— `readFile` 行数档位（floor）**换人**，四处一起重登（工单 #769 R10）

工作树 `/home/eric/wt-769w10`（HEAD `7b0e850`）。**不 push、不开 PR、不动 `/home/eric/wt-769e4`。**

## 取证边界

- **一切数字现算**：口径不重写一份，而是把 `test/tools/file-tools.test.js` 里那几段源码（`READ_LINE_CAPACITY_DIRS`
  / `CJK_CHAR` / `measureReadLineCapacity` / `listShippedSourceFiles` / `READ_LINE_CAPACITY_SAMPLE`
  / `READ_LINE_CAPACITY_ROLES`）**按 marker 原样抽出 eval**（夹具 `/tmp/769w10-census.mjs`），
  预算常量也从 `src/tools/file-tools.js` 现场 import（`FILE_READ_MAX_BYTES_DEFAULT`）。
  复现命令：`node /tmp/769w10-census.mjs /home/eric/wt-769w10`（原始输出 `/tmp/769w10-census-before.json`）。
- 红/绿现报来自 `node --test --test-reporter=tap test/tools/file-tools.test.js`（`/tmp/769w10-red.txt`）。
- 跑闸前 `find src -name '*.d.ts' -delete`（本树当前 0 个 `.d.ts`，命令仍执行）。
- **没做**：全量 `npm test`（工单明令不用跑，主会话合并后重跑）；**没动** `test/test-suite-baseline.json`
  与三个类型棘轮基线常量（102 / 1887）。

## 现算输出（本树，2026-11-09，夹具 = 测试自己的函数）

```
budget = 262144   scanned = 118 个 *.js（src/bin/examples）   写死样本 = 83
全树「一次装得最少」：src/loop/resume-manager.js
  bytes 74603 / lines 1052 / 70.9154 B/line / capacity 3696 / CJK 37.37%（cjkShare 0.37370）
  档位 = floor(3696 / 50) * 50 = 3650
全树最少的五个：
  src/loop/resume-manager.js        74603 B / 1052 行 / 70.9154 → 3696（CJK 37.37%）  ← 新任 floor
  src/loop/pending-tool-result.js   25939 B /  367 行 / 70.6785 → 3708（CJK 39.14%）  ← 离任 floor
  src/loop/option-normalization.js  37333 B /  549 行 / 68.0018 → 3854（CJK 17.05%）
  bin/provider-timeouts.js          11888 B /  177 行 / 67.1638 → 3903（CJK 45.02%）
  bin/system-prompt.js              16152 B /  252 行 / 64.0952 → 4089（CJK 44.58%）
写死样本的 floor：src/loop/resume-manager.js 3696 —— 新 floor **本来就在样本清单里**（第 3 处因此无需增删）
```

其余四个角色一并现算（判据一条没放宽，用来确认「只有 `fewest` 需要刷」）：

| 角色 | 文件 | 记录值 | 本树实测 | 漂移 |
| --- | --- | --- | --- | --- |
| `densest` | `src/loop/state-view.js` | 2,643 B / 44 行 / 4,364 / CJK 37.0% | 2,631 B / 44 行 / 4,384 / CJK 36.60% | −0.45% / 0% / +0.46% / −0.40pt ⇒ 容差内，不刷 |
| `median` | `src/loop/error-ledger.js` | 6,727 B / 158 行 / 6,157 | 逐字相同 | 0% ⇒ 不刷 |
| `most` | `src/loop/abort.js` | 1,031 B / 37 行 / 9,407 | 逐字相同 | 0% ⇒ 不刷 |
| `self` | `src/tools/file-tools.js` | 130,123 B / 2,302 行 / 4,637 | 131,414 B / 2,312 行 / 4,611 | +0.99% / +0.43% / −0.56% ⇒ ±2% 内，不刷（本单对 `file-tools.js` 只做同位数替换，字节中性） |

## 改前红（现报）

`node --test --test-reporter=tap test/tools/file-tools.test.js` ⇒ `# tests 64 / # pass 62 / # fail 2 / # skipped 0`（`/tmp/769w10-red.txt`）

```
not ok - readFile 行数容量的五个角色锚点未漂移，样本清单仍盘上可寻（#271…#275）      ← :931
not ok - readFile 描述里的 floor == 全树真最小值（#453…#537：承诺粒度 = 向下取整到 50）  ← :1293
```

同一句现报（:1293 那格）：`全树「一次装得最少」已不是 src/loop/pending-tool-result.js（现在是 src/loop/resume-manager.js，3696 行 / 70.92 B/line）`；
守卫在同文件里打的信息性现报（`#275 read-line capacity sweep`）：`"fewest":{"file":"src/loop/resume-manager.js","capacity":3696,"bytesPerLine":70.92}`、`"fewestIsThePinnedOne":false`。

## 四处（各一笔 commit）

1. 角色表 `fewest` 那一行 → `src/loop/resume-manager.js`，五个 `recorded` 取上面现算值。
2. `src/tools/file-tools.js` 描述档位 `3,700 → 3,650`（两处）+ `fewest` 档均行字节 `70.0 → 70.9`（同位数）。
3. 样本清单 `READ_LINE_CAPACITY_SAMPLE` —— 现算证明新 floor 已在清单内（见上表），**零改动**。
4. CHANGELOG 中英成对一条 + 重跑 `test/static-guards.test.js` 取守卫**自报**值再抬 `CHANGELOG_PAIR_FLOOR`。

（各笔 diff 落在 `/tmp/769w10-mN.diff`。）

## 未验证

- 全量 `npm test`（工单明令不跑；主会话合并后重跑并登记 TAP 基线）。
- `test/test-suite-baseline.json` 的 3768/3751/2/15 是主会话现报，本树未复核。
