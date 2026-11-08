# REPORT-769-r10 —— `readFile` 行数档位（floor）**换人**，四处一起重登（工单 #769 R10）

工作树 `/home/eric/wt-769w10`（起点 HEAD `7b0e850`）。**没 push、没开 PR、没碰 `/home/eric/wt-769e4`。**

## 取证边界

- **一切数字现算，口径不另抄一份**：夹具 `/tmp/769w10-census.mjs` 把 `test/tools/file-tools.test.js` 里的
  `READ_LINE_CAPACITY_DIRS` / `CJK_CHAR` / `measureReadLineCapacity` / `listShippedSourceFiles` /
  `READ_LINE_CAPACITY_SAMPLE` / `READ_LINE_CAPACITY_ROLES` **按 marker 原样抽出 eval**，预算常量
  `FILE_READ_MAX_BYTES_DEFAULT` 从 `src/tools/file-tools.js` 现场 import ⇒ 角色表 `recorded`、档位、
  样本 floor 全部是**测试自己那一份函数在本树上的读数**。复现：`node /tmp/769w10-census.mjs /home/eric/wt-769w10`
  （原始输出 `/tmp/769w10-census-before.json` = 改前、`/tmp/769w10-census-m4.json` = 改后）。
- 红/绿现报来自 `node --test --test-reporter=tap <闸文件>`（`/tmp/769w10-red.txt`、`/tmp/769w10-m2.txt`、
  `/tmp/769w10-sg1.txt`、`/tmp/769w10-sg2.txt`）。
- 跑闸前执行过 `find src -name '*.d.ts' -delete`（起跑时本树 0 个，命令照工单执行）。
- **没做**：全量 `npm test`（工单明令不跑，主会话合并后重跑并登记 TAP 基线）；**没动**
  `test/test-suite-baseline.json` 与三个类型棘轮基线（现闸自报 102 / 1887，见下表）。

## 现算输出（本树，改前一次、改后一次，同一夹具）

```
budget = 262144   扫描面 src/bin/examples = 118 个 *.js   写死样本 = 83 个路径
全树「一次装得最少」（改前即已是这个数，本轮只是把它登记上）：src/loop/resume-manager.js
  bytes 74,603 / lines 1,052 / 70.9154 B/line / capacity 3,696 / CJK 37.37%（cjkShare 0.37370）
  档位 = floor(3,696 / 50) × 50 = 3,650          ← 描述里那句承诺的唯一出处
全树最少的五个：
  src/loop/resume-manager.js        74,603 B / 1,052 行 / 70.9154 → 3,696（CJK 37.37%）  ← 新任 floor
  src/loop/pending-tool-result.js   25,939 B /   367 行 / 70.6785 → 3,708（CJK 39.14%）  ← 离任（本轮一字未动）
  src/loop/option-normalization.js  37,333 B /   549 行 / 68.0018 → 3,854（CJK 17.05%）
  bin/provider-timeouts.js          11,888 B /   177 行 / 67.1638 → 3,903（CJK 45.02%）
  bin/system-prompt.js              16,152 B /   252 行 / 64.0952 → 4,089（CJK 44.58%）
写死样本的 floor：src/loop/resume-manager.js 3,696 —— 与全树 floor **逐字同一个文件同一个数** ⇒ 第 3 处零增删
```

改后**五角色零漂移**（同一夹具 `/tmp/769w10-census-m4.json` 现报，`drift%` = 实测 vs 记录值）：

```
fewest   src/loop/resume-manager.js   drift {bytes:0, lines:0, capacity:0}  cjkDrift 0
densest  src/loop/state-view.js       drift {bytes:-0.45%, lines:0, capacity:+0.46%}  cjkDrift −0.40pt  ← 容差内，不刷
median   src/loop/error-ledger.js     drift 0/0/0（与记录逐字相同）
most     src/loop/abort.js            drift 0/0/0（与记录逐字相同）
self     src/tools/file-tools.js      drift 0/0/0（本轮重取，见「四处」第 ② 配套）
```

## 改前红（现报）

`node --test --test-reporter=tap test/tools/file-tools.test.js` ⇒ `# tests 64 / # pass 62 / # fail 2 / # skipped 0`

```
not ok - readFile 行数容量的五个角色锚点未漂移，样本清单仍盘上可寻（#271…#275）      ← :931
not ok - readFile 描述里的 floor == 全树真最小值（#453…#537：承诺粒度 = 向下取整到 50）  ← :1293
```

:1293 那格的现报判词：`全树「一次装得最少」已不是 src/loop/pending-tool-result.js（现在是 src/loop/resume-manager.js，3696 行 / 70.92 B/line）→ readFile 描述里的 floor 已不再对全树为真`；
同一次运行里守卫自己打的信息性现报：`"fewest":{"file":"src/loop/resume-manager.js","capacity":3696,"bytesPerLine":70.92}`、`"fewestIsThePinnedOne":false`。

## 四处（各一笔 commit；1+2 不合并，理由见下）

| # | 内容 | commit |
| --- | --- | --- |
| ⓪ | 报告骨架 + 现算输出（先落盘再动判据） | `405d1f3` |
| ① | `test/tools/file-tools.test.js` 角色表 `fewest` 换人 + 五个 `recorded` 现算（74,603 / 1,052 / 70.9154 / 3,696 / 0.37370）+ 其余四角色的现报漂移逐条入注 | `323f86b` |
| ② | `src/tools/file-tools.js` 描述两处档位 `3,700 → 3,650` + fewest 档均行字节 `70.0 → 70.9`（同位数）+ 描述上方的历史注 | `6fd8919` |
| ② 配套 | `self` 角色随本文件字节数重取（本轮新加的历史注自己长了字节，#537 先例：改描述句就会改这个文件自己的字节数）⇒ 130,123 → 133,104 B / 2,302 → 2,324 行 ⇒ 容量 4,637 → **4,577**，描述 `own source fits` 同位数跟着刷；**刷完再测逐字相同 ⇒ 已收敛** | `b38b1c6` |
| ③ | `READ_LINE_CAPACITY_SAMPLE` 现核后**零增删**（新 floor 本来就在 83 个路径里，且它同时是样本 floor 与全树 floor）；只把现核事实与出处记在清单头上 | `530b28b` |
| ④ | CHANGELOG 中英成对一条 + `CHANGELOG_PAIR_FLOOR` 34 → **35**（取守卫自报值） | `65c9e90` |

①②**没有**并成一笔：两笔各自都可独立复算（① 只动记录值、② 只动对外承诺），但**中间态是红的** ——
只改 ① 时 :1293 会红在 `assertTierTight` 的「档位虚高」（承诺 3,700 > 实测 3,696），这正是 #543 判据 ①
要抓的那一侧；所以 `git diff` 逐笔留档（`/tmp/769w10-m1.diff` … `/tmp/769w10-m5.diff`），绿态在 ② 之后。
④ 的两处（CHANGELOG 条目与配对地板）**同笔**：地板是在那一对上校准的，拆两笔必有一笔落在红色状态上。

**判据一条都没放宽**（逐条自证）：`assertTierTight` 三条零容差一字未动（本轮实测 `3,650 ≤ 3,696 < 3,700`，
且 3,650 是 50 的整数倍）；承诺没写高到 3,700；描述里仍**没有** `measured minimum N`（`#543` 的
`doesNotMatch` 在场且本轮通过）；`test/tools/file-tools.test.js` 未删例、未 skip（改前 `# tests 64`、改后
`# tests 64`）；`assertClose` 的 ±2% / ±1% / ±0.02 三个容差常量一字未动；`CHANGELOG_PAIR_FLOOR` 只随守卫
自报值上抬。

## 闸（跑前 `find src -name '*.d.ts' -delete`，全部在最终树上现跑）

| 命令 | 结果 | 现报要点 |
| --- | --- | --- |
| `node --test --test-reporter=tap test/tools/file-tools.test.js` | ✅ 0 fail | `# tests 64 / # pass 64 / # fail 0 / # skipped 0`（改前 62/2） |
| `npm run check:syntax` | ✅ | 499 个跟踪文件 `node --check` 全过 |
| `npm run check:types` | ✅ | 实测 **102** 个 `--checkJs` 错误 / 26 文件 = **基线 102**（棘轮没抬）；文档对账 4 处 M 相等 |
| `npm run check:types:strict` | ✅ | 实测 **1887** 个 strict 错误 / 72 文件 = **基线 1887**（没抬） |
| `npm run types:build` + `npm run check:types-build` | ✅ | `tsc exit 0`、90 个 `.d.ts`、四个断言全命中 |
| `npm run check:docs` / `check:docs:strict` | ✅（本切片内修好后） | 第一遍**红了一格**：`archive-refs` 判据把我这份报告里一个**不带目录的裸文件名**判为歧义（本仓有 `src/tools/file-tools.js` 与 `test/contract/file-tools.js` 两个同名件）⇒ 报告改成全路径后 0 漂移。**不是**放宽判据，是报告自己写歪了引用 |
| `npm run check:docs-spelling` | ✅ | `--strict: OK — 0 处红` |
| `npm run check:changelog` | ✅ | 0.31.0 段覆盖对账 OK（命中 8 / 豁免 0） |
| `npm run check:pack-links` | ✅ | `.d.ts` 声称对账 2 处 = 随包声明数 90 |
| `node --test --test-reporter=tap test/static-guards.test.js` | ✅ **58/0** | 抬地板之前先红并抄下守卫自报的两句（见下） |
| `npm run check:inventory` | ✅ | 逐文件：0 处不一致（本切片没动 `test/compat-pin-inventory.md`） |

配对地板的重取口径 = **守卫自报值**（抬常量前 `node --test --test-reporter=tap test/static-guards.test.js` 的原文，逐字）：

```
校准面（## [Unreleased]）上实测 35 对 ≠ 地板 34 对：地板必须恰等于校准面上的实测值（否则「掉一条就穿底」证不出来）。配对变多了 ⇒ 请抬地板到实测值
# 配对地板：判据面 = ## [Unreleased]（第 4 行，由 resolveChangelogScanSurface 选出：顶部 Unreleased 有内容）；中文 35 条 / 英文 35 条 / 配对 35 对（其中按「无 issue 引用 + 紧邻」配的 0 对）/ 无对应 0 条；地板 34（校准面 ## [Unreleased]）
```

⇒ 地板 = **35**（**不是 34 + 1**；「无对应 0 条」同时证成本片那对中英确实成对）。两句都逐字抄进了
`test/static-guards.test.js` 里常量上方的账目注。

## 遗留 / 需要关注

1. `self` 那一档现在是**逐字 0 漂移**（4,577 = 实测），但这是「本轮把注释加完之后收敛」的结果：
   `src/tools/file-tools.js` 每再加一段注释，`this tool's own source fits` 就要再刷一次——本轮两次实测是
   每加一行注释掉 **2.6～2.8 行**容量（130,123 B / 2,302 行 → 131,414 / 2,312 → 133,104 / 2,324，
   容量 4,637 → 4,611 → 4,577）。已在描述上方那条历史注里写明「刷完再测 ⇒ 已收敛」的收敛判据。
2. `densest`（`src/loop/state-view.js`）本轮 −0.45% 字节 / +0.46% 容量 / −0.40pt CJK，**在容差内所以没刷**；
   它与记录值的字节余量只剩 1.55pp（±2% 里用了 0.45pp 是小事，描述里 `4,387` 对实测 `4,384` 的 ±1% 只剩
   0.07pp 才是紧的那根）。下一轮只要再动这个文件就要连着刷描述那句「fits 4,387」。
3. 本切片只登记数字与文案，**没动 `readFile` 的任何行为**：`max_bytes` 默认值、截断 marker、CJK 计数口径一字未改。

## 未验证

- 全量 `npm test`（工单明令不跑）：`test/test-suite-baseline.json` 里的 3768 / 3751 / 2 / 15 是主会话在
  `/home/eric/wt-769e4` 的现报，本树未复核；合并后主会话重跑时会**第一次**把 `# tests` 数登记进基线，
  本轮之后 `test/tools/file-tools.test.js` 仍是 64 格（未增未删），`test/static-guards.test.js` 仍是 58 格。
- 新 floor 的容量随任何一次中文注释继续漂移（它现在是全树最宽行的文件，余量只有 4 行就到下一档）：
  均行字节现在 70.9154，两个方向都现算过：跌破下界 3,650 需均行字节 > 262,144÷3,650 = 71.8203（**+1.28%**）；涨破上界 3,700
  （回到上一档）需均行字节 ≤ 262,144÷3,700 = 70.8497（**−0.09%**）——上侧比下侧脆得多：去掉一段宽注释就会要求把承诺
  抬回 3,700（`assertTierTight` 的判据 ②，承诺落后实测 ≥ 50 行）。最近的赶者是 `src/loop/pending-tool-result.js`（3,708，
  它自己跨过 3,700 同样会把全树最小值顶回上一档）。
