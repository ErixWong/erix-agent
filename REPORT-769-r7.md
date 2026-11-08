# REPORT-769-r7 —— 第四轮独立验收剩下的四处文案（纯文档/注释，行为不变）

工作树 `/home/eric/wt-769w7`，基点 HEAD `a60a17a`，分支 `fix-261109-01-capability-docs-audit`。未 push、未开 PR。
提交（每处一笔，外加报告骨架一笔）：

```
24be34a docs(#769 R7 ④): file store 的 clearRecoveryRows 注释同补「只在持久化开着时才会走到」
6e264e8 docs(#769 R7 ③): orchestrator 的 fresh-start 清盘注释补上「只在持久化开着时才会走到」
5204736 docs(#769 R7 ②): 能力表那一行不再自相矛盾 —— 只留两个前提 + 一句指向，删掉展开的后果
dc73fcb docs(#769 R7 ①): README 事件清单不再把静默的读侧算成会发事件
168ba66 docs(#769 R7): 报告骨架 + 取证边界
```

累计 `git diff --stat a60a17a..HEAD`：`CHANGELOG.md` `README.md` `README_cn.md` `docs/host-consumer-contract.md`
`docs/host-consumer-contract_cn.md` `scripts/retired-spelling-scan.mjs`（钉子注释）`src/loop/orchestrator.js`
`src/store/file.js` + `REPORT-769-r7.md` ⇒ 9 文件 / +58 −12。**测试文件一个没动**（`git diff --stat` 里无 `test/`），
`test/test-suite-baseline.json` 与三个类型棘轮基线常量未碰。分片 diff：`/tmp/769w8-m1.diff` … `/tmp/769w8-m4.diff`。

## 取证边界（每条指回一条真跑过的命令，全部在 `/home/eric/wt-769w7`）

- `sed -n '85,95p' src/loop/resume-manager.js` ⇒ 读侧缺席**静默**确认：`async function readRecoveryRowsOrRefuse(ctx) {`
  下一行就是 `if (typeof ctx.store?.listRecoveryRows !== "function") return [];`，**没有**任何 `notify` / `onEvent`。
- `grep -rn "notifyCapabilitySkipped" src/` ⇒ 全仓 4 个真调用点：`orchestrator.js:1481`（`persistClassified` 里的通用
  能力位）、`orchestrator.js:2990`（`saveRunSnapshot`）、`resume-manager.js:468`（`loadRunState`）、
  `resume-manager.js:653`（`loadLatestRunSnapshot`）；`sed -n '1378,1392p' src/loop/orchestrator.js` 显示事件名
  `persistence_capability_degraded`、去重集合 `skippedCapabilityMethods`（按**方法名**）。`listRecoveryRows` 不在调用点里。
- `grep -n "const persist = \|const persistClassified" src/loop/orchestrator.js` ⇒ `:1542 const persist = async (method, ...args) => persistClassified(method, undefined, ...args);`
  与 `:1478 const persistClassified = async (method, snapshotStatus, ...args) => { if (!persistenceRequired) return false; …}`
  ⇒ 清盘点 `orchestrator.js:2262 await persist("clearRecoveryRows", runId)` 确实被第一行短路挡住。
- `grep -rn "persistenceMode" src/loop/orchestrator.js` ⇒ `:988 persistence ?? (store === undefined ? "none" : "required")`、
  `:989` 只允许 `"none" | "required"`、`:1026 const persistenceRequired = persistenceMode === "required"`
  ⇒ 「持久化开着（`persistence` 不是 `"none"`）」与 `persistenceRequired` 在这份取值域里等价，可以这么写。
- 四处落点：`grep -n "persistence_capability_degraded" README.md README_cn.md`（EN `:813`、CN `:548`）、
  `sed -n '2265p' docs/host-consumer-contract.md` / `grep -n "clearRecoveryRows" docs/host-consumer-contract_cn.md`
  （CN `:1835`）、`sed -n '9,10p' CHANGELOG.md`、`sed -n '2246,2250p' src/loop/orchestrator.js`、
  `sed -n '513,518p' src/store/file.js`。
- 生命周期段只读未改：`sed -n '7516,7518p' docs/host-consumer-contract.md`、`sed -n '5910,5912p' docs/host-consumer-contract_cn.md`
  （改后仍在原位，`git diff` 里这两段一行未现）。

## 四处改了什么

**① README 事件清单（`README.md:813-814` + `README_cn.md:548`，一笔 `dc73fcb`）**
旧的括注 `(one shot per missing optional store capability)` / 「每个缺失的可选 store capability 各发一条」把静默的
读侧也算成会发事件。现在中英各一句同义括注：按缺失**方法名**各一条、整轮去重；引擎要调用的可选 store 能力缺席就发，
恢复行的**写侧** `appendRecoveryRow` 与**清盘侧** `clearRecoveryRows` 在其中；恢复行的**读侧** `listRecoveryRows`
**不**在其中 —— 它缺席时一声不响，想要这个答案的宿主只能自己去查 store。中英各 1 处括注、同数同义。
措辞取舍见「遗留」第 2 条。

**② 能力表那一行的自相矛盾（EN `:2265` + CN `:1835` + CHANGELOG `:9-10`，一笔 `5204736`）**
那一行原本既写两个前提、又用 `runId` 把后果复述一遍（EN 「reusing one `runId` is only safe for a host that **never
resumes**; anything else moves to a new `runId`」/ CN「复用同一个 `runId` 只对**永不续跑**的宿主才安全；别的都得换新
`runId`」），结尾还自称「this row points there instead of restating them」/「本行只是指过去，不在这里复述一遍」——
前半段已经复述过 ⇒ 这句话本身在自相矛盾，就是「两处真相」。现在只留两个前提（持久化开着、且 store 实现了
`clearRecoveryRows`）+ 一句指向「缺任何一个的后果与宿主义务见下面恢复行一节的 **runId 生命周期**段」。生命周期段
（EN `:7516-7526` / CN `:5910-5919`）是写全后果的唯一落点，**一个字未动**（该段里 `runId` 计数没变，钉子才会只剩两行红）。
CHANGELOG 那对条目同一处理：删掉「With either missing the rows … moves to a new `runId`」/「缺任何一个，上一个进程写的
行就还在盘上 … 否则就得换新 `runId`」的展开，收成一句指向；**没新增配对条**、粗体标题里没套 `**`。

钉子（数只取扫描器现报，未手算）：

```
  ✗ docs/host-consumer-contract.md     [contract]  verdict=SUSPECT(dropped)  pin=465  uses=463
  ✗ docs/host-consumer-contract_cn.md  [contract]  verdict=SUSPECT(dropped)  pin=589  uses=587
```

⇒ EN 465→463、CN 589→587（各净 −2，删掉的正是展开后果的那两个 `runId`，指针那一个保留），逐条定位写在
`scripts/retired-spelling-scan.mjs` 的钉子注释里（EN `:2265` 一行 / CN `:1835` 一行）。改后现报：钉子「全部等于实测」。

**③ `src/loop/orchestrator.js:2249`（一笔 `6e264e8`）／④ `src/store/file.js:516`（一笔 `24be34a`）—— 注释，代码一字未动**
两处旧句都把 fresh-start 清盘写成无条件。各补上限定：**只在持久化开着时才会走到**（`persistence` 不是 `"none"` 时
`persistenceRequired` 才为真，而 `persistClassified` 第一行 `if (!persistenceRequired) return false;` 就先短路 ⇒
持久化关着时既不碰 store／不删文件，也不发任何诊断；③ 还多写一句「宿主不能把『没收到诊断』读成『清过了』」）。
两处都刻意做成**零行位移**（③ 净 +1 −1：新增一行同时把原来那两行注释合成一行；④ 是同一行原地改写）：
`git diff --stat` 分别 2/2 与 1/1，全是注释行，`if (resume !== true) {` 仍在 `:2260`，被文档引用的
`src/loop/orchestrator.js:2823…6297`（`grep -rho "orchestrator\.js:[0-9]\+" docs README* CHANGELOG test | sort -u` 数出的
28 个行号）与 `src/store/file.js:523` 一个都不位移。

## 闸（最终 HEAD 上重跑一遍的现报，跑前 `find src -name '*.d.ts' -delete`）

```
### check:docs        docs-drift-check: OK — …共 127 项对齐 package.json 0.31.0 与源码
                      docs-sync-check: OK — 中英契约标题结构对齐（117 节，锚点齐全）
### check:docs:strict docs-drift-check: OK — （同上 127 项）
### check:docs-spelling  ① 现状类：干净（0 处退役拼写）；另有 170 处同名异义（ambiguous，不进判据）
                      ③ 历史/契约/根文档正文钉子：78 + 2 + 2 份，全部等于实测（没有人在改写历史/契约/根文档）
                      ④ 有命中却没钉：0 份   ⑤ 钉子与扫描面同源：全部在 `git ls-files` 清单里
                      --strict: OK — 0 处红
### check:changelog   changelog-coverage: OK — 命中 8 / 登记豁免 0 / 缺项 0
### check:docs-examples  # tests 66 / # pass 66 / # fail 0
### verbatim (553)    # tests 20 / # pass 20 / # fail 0
### static-guards     # tests 58 / # pass 58 / # fail 0     （`CHANGELOG_PAIR_FLOOR = 32` 未动：test/ 不在 diff 里）
```

另跑（因为动了 `src/` 的注释，多验一步）：`npm run check:syntax` OK（498 个跟踪文件全过）、
`npm run check:types` OK（实测 102 个 `--checkJs` 错误 / 26 个文件 == 基线 102，基线常量未动）、
`node --test test/store/ledger-recovery-rows-769.test.js` ⇒ 18/0（清盘与能力位那条用例 `store 没实现 clearRecoveryRows ⇒
走能力位` 仍绿 ⇒ 注释改动没带动行为）。**全量 `npm test` 按工单没跑**（主会话复跑）。

## 遗留问题 / 需要关注

1. **工单 ① 说 CN 对应句「不在 `:548`」—— 这条落点说明和仓库现状不符。** `grep -n "persistence_capability_degraded" README_cn.md`
   只有两处：`:432` 是 `resume` 那一栏（对应 EN `README.md:556-569`，讲的是 snapshot/run-state 可选能力，**那句话本来就对**，
   未动），`:548` 才是 EN `:813` 的同段对应句（两份都是同一段流式 observer 段）。我按 `grep` 的结果改了 `:548`。
2. **① 的措辞没有写成「只有写侧与清盘侧才发」的排他句。** 代码事实：两个**读侧** loader 缺席**是**发事件的
   （`resume-manager.js:468` `loadRunState`、`:653` `loadLatestRunSnapshot`），若照字面写「只对写侧与清盘侧发」README
   就会新增一处假话。现在写的是「…恢复行写侧与清盘侧在其中；恢复行**读侧** `listRecoveryRows` **不**在其中（缺席静默）」——
   工单裁决的三个要点（按方法名去重、读侧 `listRecoveryRows` 不发、宿主自查）全在里面，只是没把「只」推成排他断言。
   要真排他，得先决定 `loadRunState` / `loadLatestRunSnapshot` 这两处发事件怎么表述（那是改语义，不在这次范围内）。
3. ③④ 新增的限定句较长（③ 那一行 ~150 字符）。这是为了**零行位移**（文档里的行号引用不能位移）刻意合成的长行；
   仓里本来就有 >130 字符的注释行（这两个文件里 20 行，最长 594），也没有 formatter/linter 闸管行宽（`check` 脚本清单里无 lint）。
4. 观察到一处**先于本次**的陈旧引用（未动、也未判红）：`CHANGELOG.md` 的 #770 条目写 `src/store/file.js:523`，而
   `JSON.stringify(snapshot)` 现在在 `src/store/file.js:599`（基点 `a60a17a` 上同样是 599）。历史条目里的行号，`check:docs`
   不判死，本次也没让它变更坏。
5. 全量 `npm test` 未跑（工单要求）；`npm run check`（全套）也未跑，只跑了工单点名的闸 + `check:syntax` + `check:types`
   + 一条恢复行用例。

## 未验证

- **没有跑全量 `npm test` 与 `npm run check`**：只跑了工单点名的 7 个闸（全绿，现报已抄）+ `check:syntax` +
  `check:types` + `test/store/ledger-recovery-rows-769.test.js`。其它用例是否被这四处文案影响 = 未验证（主会话复跑）。
- **中英「同数同义」是我逐段对照 + `check:docs`（127 项对账 / 117 节骨架）的机器面**，没有独立的「语义等价」机器判据：
  若存在我没找到的对账用例在全量 `npm test` 里，它可能还有话说。
- ③④ 的「行为不变」只有间接证据（注释 diff + `check:syntax` + `check:types` 基线不动 + 那条 18/0 用例）；
  没做「编译产物逐字节比对」这类直接证明。
- ①/② 的括注里「宿主只能自己去查 store」这类宿主义务，未在任何宿主侧 e2e 里跑过（本来就是契约文字面）。
