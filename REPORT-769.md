# REPORT-769 —— run snapshot 独有格的账本恢复行载体（#767 的硬前置）

分支 `fix-261108-22-ledger-recovery-rows-erix`，基点 `7181a1b`。本切片**不删快照写点**（删是 #767 最后一步）：
只做「加载体 + 读侧优先读账本 + 宿主可见形状写进契约」。

## 取证边界

**这里每一条都是我自己在这棵树（`/home/eric/wt-769e`）现查的**，命令写在括号里。

### 已复核的现场坐标

| 事项 | 现测坐标 | 取法 |
| --- | --- | --- |
| 文件 store 工厂 | `src/store/file.js:403` `createFileTranscriptStore({ dir })` | `readFile` |
| 快照落盘是裸 `JSON.stringify` ⇒ **键序是宿主可见字节** | `src/store/file.js:519-525`（`saveRunSnapshot` 写 `.snapshot.json`，无 replacer、无键排序） | `readFile` |
| latest-only 三件套 | `.snapshot.json`(61)、`.state.json`(70)、`.status.json`(74)；`saveRunState` 是覆盖写 + `boundRunState` 合并 previous（`src/store/file.js:498-517`） | `readFile` |
| 行模型与整数守卫 | `src/store/message-rows.js`：`MESSAGE_ROW_KIND`(40)、`isFoldableMessageRow`(47，要 `kind` + `Number.isSafeInteger(seq)` + 非空 `messages`)、`isRoundCarrier`(78)、`nextMessageSeqByRound`(241，同样 `Number.isSafeInteger`) | `readFile` |
| `load()` 折叠、`loadRawRows()` 未折叠 | `src/store/file.js:466-484` | `readFile` |
| `:control:<slot>` 行 = **载着 `messages`** 的行 | `src/loop/orchestrator.js:3087-3099`（`appendEngineMessagesToTranscript`，`dedupKey = <runId>:engine:round:<n>:control:<slot>`） | `readFile` |
| **既有 append-only 事实行先例**（我照它的形状做，不另起炉灶） | `src/loop/orchestrator.js:3380-3391` `appendEngineFactToTranscript`：`messages: []` + 事实键摊进行里 + `dedupKey` 带**事实指纹后缀**（同事件幂等、不同事件换键） | `readFile` |
| 工具结果一产生就写账本 | `src/loop/orchestrator.js:3113-3134` `appendMessageRowToTranscript`（`kind:"message"` + `seq` + `partOf`）；崩溃轮补桩 `journalResumeUnpersistedToolResults`（`resume-manager.js:229`） | `readFile` |
| `executedToolIds` 在账本侧**零引用**（真·快照独有） | 全仓 `grep -n executedToolIds src bin` 只命中 `orchestrator.js`(2905/3056/4084/5776/6287)、`run-snapshot-executor.js:507`、`resume-manager.js`(657/704) —— **`src/store/*` 一条都没有** | `grep` |
| 执行时刻（恢复行必须钉在这里） | `src/loop/run-snapshot-executor.js:507` `if (block.id !== undefined) ctx.executedToolIds.add(block.id);`，紧接 `:510-517` 的 `status: "executed"` 快照写点（`:515`） | `readFile` |
| `partialText`/`partialRound` 只在 `stream:true` + `partialPersistence` 下存在 | `src/loop/orchestrator.js:949` `throw new TypeError("partialPersistence requires stream: true")`；写点 `3405-3417`（`commitPartialSnapshot`）+ 载荷条件格 `3063` `...(partialText === undefined ? {} : { partialText, partialRound })` | `readFile` |
| `saveRunState` **两处**写点（同量级通道，报省写放大必须并列） | `src/loop/orchestrator.js:1576`、`src/loop/orchestrator.js:3567` | `grep -n saveRunState src bin` |
| 读侧（快照→ctx）| `src/loop/resume-manager.js`：`executedToolIds` 657/704、`partialText` 541-542/634、`partialRound` 635、`toolResults` 537/661、账本侧已有 `ledgerToolResultIds`(487/496)/`ledgerResultsById`(498)/`crashRoundHasAssistantText`(505) | `readFile` |
| 两轴表锚点面 | `scripts/cell-axes-anchors.mjs`：`CELL_AXES_REQUIRED_CELLS` = **39 条 / 27 组 / 14 格名**（`node -e` 现算），`CELL_AXES_ANCHOR_FLOORS` 由它算出（`entries: c.length`, `groups: new Set(key|axis)`）；表在两份契约的 `<!-- erix:snapshot-cell-axes:begin/end -->` 之间（EN `docs/host-consumer-contract.md:2352-2370`、CN `docs/host-consumer-contract_cn.md:1903-1921`） | `node -e` + `grep` |
| 闸的逐组对账口径 | `scripts/docs-drift-check.mjs:2958-3010`：同一 `格|轴|同名第几行|文件` 组里多条锚点取**并集**，与表里 `path:line` 集合**等值**比较；登记了没人引 = 后门红；表里引了没登记 = 不再豁免 | `readFile` |
| `test/contract-snapshot-cell-axes-767.test.js` G1 | 表里格名集合必须**恰好**是那 14 个（`CELL_KEYS`）⇒ **新行类型不是快照 payload key，不许往这张表加格名**，只能给既有格加读者引用/改 read 轴 | `readFile` |
| 契约里**没有**「未知 `kind` 忽略」这句承诺 | `grep -rn "不认识的\|未知 kind\|unknown kind\|unrecognized" docs/host-consumer-contract*.md docs/architecture.md` 只命中 provider 槽位 / notes 计数 / JSON 字段三处，**没有一条讲账本行 `kind`**。现有最近的一句话是 EN `:6198-6207`「Row count ≥ round count is normal (since #326) … must merge by `round` and de-duplicate by `dedupKey`」——它管的是「多几行」，不管「多一种 `kind`」 | `grep` |

### 我从工单拿来、但**没有**在本树复现的（用时要谨慎）

- **#768 的三个字节数**：`partialText` 220 B / `partialRound` 1 B / 三格合计 371 B/轮，以及 `.state.json` 的 5,847 B / 7,827 B。
  本树里没有 #768 的报告（`ls REPORT-*.md` 只有 770/770R2/772/774/779R4/s1），`grep -rn "371 B\|5,847\|7,827"` 零命中。
  ⇒ **我自己现测一份并列报出**，不抄这些数。
- 工单给的行号（`:403` / `:515` / `:948`）我逐个重查过：`:403` 与 `:515` 对得上，`partialPersistence requires stream: true` 实际在 **`:949`**（工单写「`:948` 附近」）。

### 本切片**不**碰

- 不删任何快照写点（`orchestrator.js:3003-3064` 载荷、`run-snapshot-executor.js:510-517`、`commitPartialSnapshot`）；
- 不动 `test/test-suite-baseline.json`（主会话在合并树上统一现测）；`BARE_LINE_REF_BASELINE` 保持 **6**（现测：`scripts/docs-drift-check.mjs:63` 注释里的基线值）；
- 不动 `/home/eric/wt-769w`、`/home/eric/projects/erix-llm-kit`、`/home/eric/wt-75*`、`/home/eric/wt-76*`、`/home/eric/wt-77*`；
- 不 push、不开 PR；不新增 npm 依赖（只用 `node:` 内置 + 相对路径），纯 ESM。

### 语义红线（写进代码注释、测试与契约的那一条）

**「`tool_use` 没有对应 `tool_result`」推不出「工具没执行」**：执行发生在结果行落盘**之前**
（`run-snapshot-executor.js:507` 在 `:510` 之前，结果行更晚），所以「没执行」与「执行了但没入账」在账本里形状相同。
⇒ 「执行过没有」必须由恢复行**显式携带** `toolUseId`，不许由「缺 `tool_result`」反推。

## 计划（里程碑 = commit = end_turn）

- **M1 取证边界落盘**（本段）+ 基线闸。
- **M2 载体**：新增 `src/store/recovery-rows.js`（行形状 + 事件键 + 读侧聚合），写点接在
  `run-snapshot-executor.js` 的执行时刻（经 ctx 注入，形状同 `appendEngineFactToTranscript`）与
  `commitPartialSnapshot`；测试（具名断言 + 幂等 + 字节）。
- **M3 读侧优先读账本**：`resume-manager.js` 用账本恢复行喂 `resumeExecutedToolIds` / partial 正文，
  快照那几格退成兜底；测试断言「账本在场时不读快照格」。
- **M4 宿主可见面**：两份契约（行形状、写入时机、**未知 `kind` 的后果**）+ 锚点登记 + read 轴改口 + CHANGELOG。
- **M5 全闸 + 报告收口**。

## M3 / M4 收口（换道 + 宿主可见面）

**核心逻辑**（已 commit `issue #769 M3+M4`）：
- 载体：`src/store/recovery-rows.js` 造两种恢复行（`kind: "recovery"`，`recoveryEvent: "tool-executed" | "partial-text"`，
  `messages: []` 恒不载正文），事件键 = `dedupKey`（`recoveryEventKey()`）。
- **换道**：恢复行**不走 `appendRound`**，走新的可选 store 口 `appendRecoveryRow` / `listRecoveryRows` /
  `clearRecoveryRows`；文件 store 落 **`<dir>/<runId>.recovery.jsonl`**（新文件），`load()` / `loadRawRows()` /
  轮记录那份 `.jsonl` 一个恢复行都没有（`test/store/ledger-recovery-rows-769.test.js` 里三条断言钉住）。
- 写点：`src/loop/orchestrator.js:3426`（执行器返回即写 `tool-executed`）、`:3438`（`partialPersistence` 流式路径写
  `partial-text`）。读点：`src/loop/resume-manager.js:432`（`ctx.store.listRecoveryRows`，没实现就是空集 ⇒ 回落快照）。
  快照那三格在恢复路径上只剩**兜底**，不再是唯一来源。
- 宿主可见面：`docs/host-consumer-contract.md` 与 `_cn.md` 各追加一节「恢复行 —— 每本 run 多出的一份 `.jsonl`」，
  写清行形状、写入时机、三个 store 口是**可选能力**、以及**未知 `kind` 的后果**（本契约**没有**「不认识就忽略」的
  总承诺 ⇒ 直接写「对未知 kind 抛错的宿主、假设一个 run 只有一个文件的宿主、glob `*.jsonl` 全塞给轮记录解析器的宿主
  会坏；只读 `<runId>.jsonl` 或 `load()` 的宿主不受影响」）。

**现测字节**（`node --test test/store/ledger-recovery-rows-769.test.js` ⇒ 8 tests / 8 pass / 0 fail）：
- `#769 新增行字节 / 每轮：tool-executed 226 B + partial-text 256 B = 482 B`（载体行，样例正文 6 个 CJK 字）
- `#769 真跑一轮实测：一条 tool-executed 恢复行 = 234 B`（`partialPersistence` 关闭 ⇒ 没有 partial-text 行）
- 没有主张「省了写放大」：latest-only 的 `.state.json`（`saveRunState` 两处写点）本切片一个字节都没少。

**闸（本轮真跑过的）**：
- `node scripts/mutation-sample-check.mjs --sync test/mutation-samples.md` ⇒ 改动 8 行（只动派生列，手写「期望红话」列
  一个字没碰）；`--verify` ⇒ 0 处不一致。`--run` **未复跑**（见未验证）。
- 两轴表引用刷新：机械重算共 **81 处** `file:line`（行号全部由 `scripts/cell-axes-anchors.mjs` 的锚点现算，没手抄数字）。
- `node --test test/persistence-diagnostics.test.js test/loop-resume.test.js` ⇒ 40 tests / 40 pass / 0 fail
  （#78 的两处「每缺一个可选能力发一条诊断」计数随新可选能力从 3→4、2→3，并各自点名 `appendRecoveryRow`）。
- `npm test`（本轮全量，改动前）：tests 3724 / pass 3696 / fail 15；其中 2 条就是上面 #78 那两条（现已绿）。

## 未验证

- 全量 `npm test` 需要在最后两处改动（#78 计数）之后**复跑**：上一轮全量是 15 红，现已确认转绿的是
  `test/persistence-diagnostics.test.js` 与 `test/loop-resume.test.js` 两个文件（40/40）；其余 13 条红的归属：
  G4 家族 6（`test/contract-snapshot-cell-axes-767.test.js`，两轴表引用与锚点的**配对**还没咬合：`persistedTranscriptLength`
  写列出现 2997/3062 互指、另有一格少引一条 `src/loop/orchestrator.js:3045`）、#286 符号锚点 2、readFile 容量棘轮 2
  （`src/store/file.js` 字节数因本切片涨了，记录值待复测）、#417 strict 棘轮 2（并集档实测 2093 > 基线 2090）、
  版本探针 `--self-test` 1。这些都是**闸面值/棘轮**类，不是恢复行语义类。
- `npm run check:test-summary`、`npm run check:inventory`（新增测试文件登记）、`check:docs` / `:strict` /
  `:docs-spelling` / `:syntax` / `:agents-directives` / `:changelog`、`node --test test/static-guards.test.js`、
  `check:types` / `:strict` / `types:build`（动了 `src/` 要先 `find src -name '*.d.ts' -delete`）
  —— **本轮没跑到**（轮次预算用尽），交接给下一轮。
- `.state.json` 的 5,847 B / 7,827 B 与 #768 的 371 B/轮：来自 issue 文本，本树无 #768 报告可复核（见上文取证边界），
  本切片没有引用它们做结论。
- 既存问题（**非本切片引入**，基线 worktree @`7181a1b` 同样复现）：恢复一个「跑过工具」的 run 会抛
  `transcript appendRound dedup conflict (key=<runId>:msg:1:0)`。`#769 幂等（run 层）` 因此 catch 住它，
  只断言「恢复行不重复、已执行工具不重放」，并显式钉住只允许这一条既存冲突形状。
