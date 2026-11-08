# REPORT-769-wording（工单 #769 R6：两处「文档说的 ≠ 实际行为」的纯文案修正）

工作树 `/home/eric/wt-769w6`，分支 `fix-261108-32-capability-wording`，基点 HEAD `7095ef6`。
**只改文案**：`CHANGELOG.md`、`docs/host-consumer-contract.md`、`docs/host-consumer-contract_cn.md`，外加
`scripts/retired-spelling-scan.mjs` 里两条**命中数钉子重登**（钉子值 = 扫描器现报的 `uses`，不是行为面）。
`src/` 一个字没动；`test/test-suite-baseline.json` 与 `scripts/type-check-ratchet.mjs` 的三个基线常量没动。

## 取证边界

边界：下面每一条事实都指回一条我在 `/home/eric/wt-769w6` 上**真跑过**的命令；闸门输出抄现报原文，不转述、不美化。
没跑的一律进最后一格 `## 未验证`。

代码事实（照这个写文案，不照旧文案写）：

- **读侧缺席静默**：`grep -n 'typeof ctx.store?.listRecoveryRows !== "function"' src/loop/resume-manager.js`
  ⇒ `91:  if (typeof ctx.store?.listRecoveryRows !== "function") return [];` —— 直接返回空数组，**不发任何事件**。
- **写侧 / 清盘侧缺席各发一条（按方法名去重）**：`sed -n '1478,1545p' src/loop/orchestrator.js` ⇒ `persistClassified`
  开头两行就是这件事：`if (!persistenceRequired) return false;` / `if (typeof store?.[method] !== "function") { notifyCapabilitySkipped(method); return false; }`；
  `notifyCapabilitySkipped`（`src/loop/orchestrator.js:1378`）自己带 `skippedCapabilityMethods` 去重集，事件名是
  **`persistence_capability_degraded`**。
- **只有三处会发这条事件**：`grep -n "notifyCapabilitySkipped" src/loop/*.js` ⇒ `orchestrator.js:1481`（persistClassified，
  覆盖 `appendRecoveryRow` / `clearRecoveryRows`）、`orchestrator.js:2990`（`saveRunSnapshot`）、
  `resume-manager.js:468`（`loadRunState`）、`resume-manager.js:653`（`loadLatestRunSnapshot`）。
  **读侧 `listRecoveryRows` 不在任何一条里** ⇒ 旧文档那句「三者都报」确实与实际行为不符。
- **清盘只在持久化开着时才发生**：`sed -n '2240,2275p' src/loop/orchestrator.js` ⇒ 清盘点是
  `if (resume !== true) { try { await persist("clearRecoveryRows", runId); } … }`，而 `persist` ⇒ `persistClassified`
  第一行 `if (!persistenceRequired) return false;`；`grep -n "persistenceRequired\s*=" src/loop/*.js` ⇒
  `orchestrator.js:1026: const persistenceRequired = persistenceMode === "required";` ⇒ `persistence: "none"` 时
  **既不清也不发诊断**。
- **`capability_skipped` 这个名字引擎从来没发过**：`grep -rn "capability_skipped" src bin scripts examples test | wc -l` ⇒ `0`
  （只有 `notifyCapabilitySkipped` 这个**内部函数名**；旧 CHANGELOG 把它当成了事件名写在文档面上）。
- **两条前提在契约里本来就写全了（所以我用指向而不是复制）**：`grep -n "runId 生命周期" docs/host-consumer-contract_cn.md`
  ⇒ `_cn.md:5902` 起（EN 对应 `host-consumer-contract.md:7506` 的 "**runId lifecycle.**"）已逐条列出
  「持久化开着」+「store 实现了 `clearRecoveryRows`」两个条件；本次只把**能力表那一行**与 **CHANGELOG** 指过去。

## 基点

- 起点：`7095ef6`（`fix-261108-32-capability-wording`，已含主干 `1751f28` 与 strict 修复）。
- 我这三笔：`b5a47f9`（报告骨架 + 取证边界）→ `62b7bec`（①）→ `80d86cf`（②）。
- 改动面：`git diff --stat 7095ef6..HEAD` = `CHANGELOG.md`、`docs/host-consumer-contract.md`、
  `docs/host-consumer-contract_cn.md`、`scripts/retired-spelling-scan.mjs`（钉子）、`REPORT-769-wording.md`。
- 逐笔 diff：`/tmp/769w7-m1.diff`（①）、`/tmp/769w7-m2.diff`（②）。
- 没跑 `git push`、没开 PR、没碰 `/home/eric/wt-769e4`、`/home/eric/wt-769w4`、`/home/eric/wt-769w5`、
  `/home/eric/copilot-sbx/*`、主仓。

## 结论：改了什么

### ① commit `62b7bec` —— 拆掉「三者都可选 ⇒ 引擎报 `capability_skipped` 并读不到东西」那一锅烩

改成：**缺席不算错，但事件面分两种**。写侧 `appendRecoveryRow` 与清盘侧 `clearRecoveryRows` 缺席各发一条
按方法名去重的 `persistence_capability_degraded`；**读侧 `listRecoveryRows` 缺席是静默的**（宿主想知道就得自己查
store 有没有实现这个方法），并把「维持静默」的理由写成裁决（每次续跑都会命中，发事件 = 把静态事实重报成噪音）。
**没加事件、没改行为**。落点（自己 grep 定准的，比工单列的多一处）：

- `CHANGELOG.md:9`（EN）/ `:10`（CN）：那句 "the engine reports `capability_skipped` and reads nothing" 与
  「每个缺席方法一条 `capability_skipped`」都换成真事件名 + 分侧口径，并写明本句是 R6 复核后改口。
- 能力表 `Optional ledger recovery rows (issue #769)` 行（EN `docs/host-consumer-contract.md:2264` /
  CN `docs/host-consumer-contract_cn.md:1834`）。
- 恢复行章节「All three are **optional**」段的 **Absent** 那一格（EN `:7480` 起 / CN `:5884` 起）：拆成两个子项，
  写侧与清盘侧一条、读侧静默，并指回 `readRecoveryRowsOrRefuse`（`src/loop/resume-manager.js`）。
- **工单没列但我 grep 到的同一处假话**：能力表下面那段「The **two** read-side probes … are the exception」
  （EN 原 `:2272-2279` / CN 原 `:1841-1846`）—— 它把例外只算成 `loadRunStateStatus` 与 `loadRawRows` 两个，
  而 `listRecoveryRows` 缺席同样是静默读侧。已改成三个例外并分别写理由（中英成对）。

### ② commit `80d86cf` —— 「fresh start 会清恢复行」补上两个前提

必须写全的那句已写全：清盘只在 **持久化开着**（`persistence` 不是 `"none"`）**且 store 实现了 `clearRecoveryRows`**
时才发生；缺任何一个 ⇒ 旧行留在场上，此时复用同一个 `runId` 只许「永不续跑」，否则换新 `runId`。
**用指向**：条件本体只在契约「runId 生命周期 / runId lifecycle」那一段写一遍，本行的两处落点指过去，不复制第二份真相。

- 能力表 `Optional ledger recovery-row clear (issue #769 R3)` 行（EN `docs/host-consumer-contract.md:2265` /
  CN `docs/host-consumer-contract_cn.md:1835`）。
- `CHANGELOG.md:9`（EN）/ `:10`（CN）里那句「called once on a fresh (`resume !== true`) start, so reusing a `runId`
  cannot mix two processes' rows」。

### 钉子重登（`scripts/retired-spelling-scan.mjs`，只动数值与注释）

`CONTRACT_BODY_PINS` 两份契约的命中数随真名入面而变，数**只取扫描器现报**，并在注释里逐条定位：

- ① `docs/host-consumer-contract_cn.md` 585 → 587（EN 侧同一刀净 0，扫描器现报 `verdict=ok`）：
  `:5888` 事件字段面 `{type, runId, method, detail}` 里的 `runId`、`:5889` 路径 `src/loop/resume-manager.js` 里的 `resume`，
  两者都在 `AMBIGUOUS_KEYS` 里（同名异义，不进退役判据，但计入钉子）。
- ② `docs/host-consumer-contract.md` 463 → 465、`docs/host-consumer-contract_cn.md` 587 → 589：
  EN `:2265` / CN `:1835` 那一行从 1 处（`runId`）变 3 处（`persistence` + `runId` ×2），中英同数。

## 闸门（跑前都执行过 `find src -name '*.d.ts' -delete`）

改文案前（基点 `7095ef6`）的两道基线现报：

```
docs-drift-check: OK — 版本/默认值/清单（含中英逐处对账）/模块地图/路径/中英骨架共 126 项对齐 package.json 0.31.0 与源码
docs-sync-check: OK — 中英契约标题结构对齐（117 节，锚点齐全）
…  ③ 历史/契约/根文档正文钉子：78 + 2 + 2 份，全部等于实测
--strict: OK — 0 处红
```

① 落盘后、重登钉子**前**的现报红（这就是扫描器教我把逐条定位写进注释的那一条）：

```
  ✗ docs/host-consumer-contract_cn.md  [contract]  verdict=SUSPECT(raised)  pin=585  uses=587
  ③ 历史/契约/根文档正文钉子：78 + 2 + 2 份，1 份不符 ⇒ 见上
--strict: 1 处红
```

② 落盘后、重登钉子**前**的现报红：

```
  ✗ docs/host-consumer-contract.md  [contract]  verdict=SUSPECT(raised)  pin=463  uses=465
  ✗ docs/host-consumer-contract_cn.md  [contract]  verdict=SUSPECT(raised)  pin=587  uses=589
  ③ 历史/契约/根文档正文钉子：78 + 2 + 2 份，2 份不符 ⇒ 见上
--strict: 2 处红
```

最终树（`HEAD = 80d86cf`，`find src -name '*.d.ts' -delete` 之后）逐条现报：

| 闸 | 命令 | 现报 |
| --- | --- | --- |
| `check:docs` | `npm run check:docs` | `docs-drift-check: OK — … 共 127 项对齐 package.json 0.31.0 与源码` + `docs-sync-check: OK — 中英契约标题结构对齐（117 节，锚点齐全）`（exit 0） |
| `check:docs:strict` | `npm run check:docs:strict` | `docs-drift-check: OK — … 共 125 项对齐 …`（exit 0） |
| `check:docs-spelling` | `npm run check:docs-spelling` | `③ 历史/契约/根文档正文钉子：78 + 2 + 2 份，全部等于实测（没有人在改写历史/契约/根文档）` / `④ 有命中却没钉：0 份` / `--strict: OK — 0 处红` |
| 同门的反向证（顺手自证钉子没被我把舵拔掉） | `node scripts/retired-spelling-scan.mjs --self-test` | `retired-spelling-scan --self-test: OK — 23 例反向证/放行证全部按预期` |
| `check:changelog` | `npm run check:changelog` | `changelog-coverage: OK — 0.31.0 段覆盖了区间 v0.30.0..v0.31.0 里每一个碰到公开面的合并号（命中 8 / 登记豁免 0 / 缺项 0）` |
| `check:docs-examples` | `npm run check:docs-examples` | `# pass 66` / `# fail 0` |
| 逐字判词闸 | `node --test test/contract-verbatim-verdicts-553.test.js` | `# pass 20` / `# fail 0`（EN 落单反引号那一格没被本次改动绊到） |
| 静态守卫 | `node --test test/static-guards.test.js` | `# pass 58` / `# fail 0`，且守卫自报：`配对地板：判据面 = ## [Unreleased] … 中文 32 条 / 英文 32 条 / 配对 32 对 … / 地板 32` ⇒ `CHANGELOG_PAIR_FLOOR = 32` 未被踩穿也未被抬（没新增配对条，没在粗体标题里套 `**`） |

中英对账口径：两处改口 EN/CN **同数同义**（能力表 1 行 ↔ 1 行、恢复行章节 1 段 ↔ 1 段、表下那段 1 段 ↔ 1 段、
CHANGELOG EN ↔ CN），由 `docs-sync-check`（117 节锚点齐全）与 `docs-drift-check` 的中英逐处对账共同绿着背书；
钉子增量中英同为 +2（②），也是同一处数法出来的旁证。

## 需要主会话处置（不卡本切片，但别让它烂在地下）

- **`SYMBOL_ANCHOR_MIN_UNIQUE` 现在少绑 1 组**：本切片新增的符号锚点 `readRecoveryRowsOrRefuse`（EN + CN 各一处，
  已由 drift-check 逐条验到它真的解析到 `src/loop/resume-manager.js` 里的声明）把「唯一 (符号, 文件) 组」从
  `242` 顶到 `243`。闸仍绿（✓，它管的是「只增不减」），但现报把登记入口写得很明白：
  `✓ symbol-anchor: 实测 243 组 > 下限 242 组——符号锚点在变多（好方向），请把 SYMBOL_ANCHOR_MIN_UNIQUE 升到 243，否则下限就在空转`
  （命令：`node scripts/docs-drift-check.mjs --strict --verbose`）。常量在 `scripts/docs-drift-check.mjs:2610`。
  我**没抬**它：工单只给了文案 + spelling 钉子两类改动面，而这个常量的登记面按 #772 的口径还要动
  `docs/maintenance/command-reference.md#docs-anchors`（中英两份），属另一个切片的活。不抬的后果不是红，
  是「下限空转」——谁接谁抬。
- 同一轮 verbose 对账旁证：`check:docs` 的检查项从 `126` 变 `127`（多的那一条就是上面那条 symbol-anchor 提示），
  不是某条检查掉了；逐条 item 对账用 `diff <(基线 verbose 输出) <(现 verbose 输出)` 做的，除那一条以外逐行同。

## 未验证

- **全量 `npm test` 没跑**（工单交给主会话复跑）。若有测试断言的是这两段契约的**旧原句**，只有全量能暴露；
  我这边做的替代取证是两条 grep（不是全量）：
  `grep -rn "All three are\|三者都是\|all three optional\|per missing method\|每个缺失方法\|每个缺席方法" test/ scripts/` ⇒ `0`，
  以及 `grep -rn "Optional ledger recovery\|可选恢复行" test/ scripts/` ⇒ 只有 2 处命中，且两处都是本切片自己在
  `scripts/retired-spelling-scan.mjs:407` / `:475` 新写的钉子注释（`test/` 里 0 命中）——都是 grep，不是全量。
- `check:types` / `check:types:strict` 没跑（本切片不碰 `src/`，三个基线常量未动）。
- `test/test-suite-baseline.json` 没动也没复核其内容与本轮用例数的关系（交给主会话那棵树）。
- 恢复行章节里我**没有**改的东西：「present and rejecting」那一大段（含 `recovery_rows_unreadable` 的字段面与
  `phase` 三格）只做了缩进/上下文衔接，没逐字复核它与 R5 M1 代码是否还有别的偏差 —— 不在本工单两格里。
- **一次过程事故（已复原，但要说）**：为量「改文案前/后」的钉子现报我用了 `git stash` / `git stash pop`。
  在 ② 已 commit、工作树干净的那一刻我又敲了一次 `git stash`（无内容可存 ⇒ 没建条目），紧跟的 `git stash pop`
  于是把**本树上早先存在、属于别的分支的那条** stash（`stash@{0}: On feat-261107-11-host-steer-turn:
  753-wip-agents-floors-baseline`，动 `AGENTS.md` / `AGENTS_cn.md` / `test/static-guards.test.js` /
  `test/test-suite-baseline.json`）弹进了工作树并产生 4 处冲突。处理：`git reset --hard HEAD` ⇒ 那四份文件回到
  `HEAD` 内容，`git status --porcelain` 干净，我的三笔 commit 完好；那条 stash **仍在 `git stash list` 原位**
  （pop 因冲突而保留条目），没有丢东西。后果：如果主会话打算在这棵树上用那条 stash，它现在还是原样。
