# REPORT-770 — 停写 run snapshot 的 `status` / `compactionStats` 两格

分支 `fix-261108-13-stop-status-compactionstats-erix`，基点 `855d6ff`（PR #779：两轴载荷表 + 锚点登记表）。
不 rebase、不 push、不开 PR；不碰 `/home/eric/wt-770w` 与其它 `~/wt-*`。

## 取证边界

- **证据来源只有当前工作树 `/home/eric/wt-770e`（HEAD 起于 `855d6ff`）上的工具返回**：`grep`/`searchText` 的 `文件:行` 命中、`readFile` 的带行号原文、闸命令的退出码与我自己在树里写下的注释/断言。任务书里给的坐标（`orchestrator.js:3038`、`:6160-6162`、`resume-manager.js:346`、`file.js:523`）只当线索，**每条都在当前树重新验过一遍才写进本报告的结论**。
- **不采信**：其它工作树（尤其对照树 `wt-770w`）、`node_modules`、dist/build、以及我记忆里"主会话实测过"的数字；凡引用数字（闸自报的地板/计数、用例总数、退出码）都在报告里注明来源命令与它当时的自报值。
- **行号会漂**：本文件里 `文件:行` 是写下那一刻的坐标；后续 commit 之后同坐标可能已不是同一行，以最近一次 `git diff`/`grep` 输出为准（每步都 dump 到 `/tmp/770e-mN.diff`）。
- 快照落盘字节由 `src/store/file.js` 的 `JSON.stringify(snapshot)` 决定 ⇒ **键的存在与顺序本身就是可见面**，本报告把"键消失"当可见变更对待（CHANGELOG 中英成对）。
- 不主动读密钥/`.env`；不跑 `npm test` 全套（按任务书点名跑用例）；不动 `test/test-suite-baseline.json`；不动 `BARE_LINE_REF_BASELINE`；棘轮基线不抬。

## 步骤 1 — 读者与断言枚举（清单）



坐标口径：以下全部 `文件:行` 是在 commit `8f408b4`（基点 `855d6ff` + 本报告骨架）上现取的，命令 `grep -rn "compactionStats" src/ bin/ test/ examples/ docs/ scripts/` 与 `grep -rn "\.status\b" …`（纯 Node 的 grep 别名跳过 node_modules/dist）。`examples/` 实测 `grep -rn "compactionStats\.\|\.status\b" examples/` 共 79 + 72 处命中，但**没有一处读快照那一格**：`examples/pi-extension/erix-run-core.js:1833` 明写 `COMPACTION_STATS_SOURCE = "runResult.compactionStats"`（读 run 返回值，且注释里专门说不是 `<runId>.state.json` 那份），`examples/` 里 `\.status` 全是 `verification.status` / `progress.status` / `<runId>.status.json`；唯一的快照现场 `examples/tool-fact-e2e.test.mjs:857-862` 是**手写 0.19 旧档**（`status: "done"`，引擎从不写这个值）⇒ 属旧档容忍，不是读者。

### 1.1 `status`（快照格 `snapshot.status`）的读者与断言

**`src/` 里唯一的真读者（不是宿主面，是引擎内部）**
- `src/loop/orchestrator.js:1473` —— `persist()` 的**通道 A 分类**：`args.at(-1)?.status === "executed" ? "checkpoint_after_tool" : "checkpoint_before_tool"`。`args.at(-1)` 就是它自己交给 `store.saveRunSnapshot` 的那份载荷 ⇒ 这是这一格在 `src/` 里唯一被读到的地方，读的是**自己刚写的载荷**。**它是停写前必须先搬走的读者**：搬法 = 调用点把自己的状态显式交进分类（与 `src/loop/run-snapshot-executor.js` 通道 B 的显式声明同源），不再从载荷里嗅探。
- `src/loop/orchestrator.js:2926`（入参 `status = "pending"`）、`:3026`（写点本身）、`:3022-3023`（注释：全仓 7 个调用点、5 个显式传值）。
- `src/loop/run-snapshot-executor.js:341 / :515 / :745` —— **调用点入参**（`status: "rejected" / "executed" / "intercepted"`），签名不动 ⇒ 不是快照格的读者。
- `src/store/file.js:587,590` —— 读的是 `<runId>.status.json`（`:75` 拼路径、`:492` 写）**另一个产物**；`src/compact/fold-statistical.js`、`src/store/notes*.js`、`src/tools/notes.js`、`src/run-state.js` 里的 `status` 全是别的产物。
- `bin/`：`grep -rn "\.status\b" bin/` 的命中全在 `--status` 旗标 / 轮记录 `record.judge.status` / `provider.status` 上，**没有**一处读快照那一格（`bin/final-guard-support.js` 读的是轮记录）。

**`test/` 里真拿快照格当证据的断言（= 本切片要改指向的）**
- `test/loop-persistence-phase.test.js:87` 把 `snapshot.status` 采集进 `writes`；消费点 `:224`（`:222-224` 找工具前写）、`:250`（找工具后写）、`:280`（同工具前）、`:322-326`（覆盖面自证 executed/intercepted/pending 三类）、`:369`（找工具后写）；`EXPECTED_BY_STATUS` 定义在 `:43-47`，sweep 里的映射消费在 `:349` 附近；`:14` 是讲这格的注释。**用途**：分辨是哪条调用点写下这条快照（#178 两通道守门全钉它）。
- `test/loop-invalid-arguments.test.js:235,236` —— `snapshots.find((entry) => entry.status === "rejected")` 造崩溃现场夹具（下一行 `:238-241` 已经在校验同一格载荷里的 `toolResult.erix.executionStatus === "rejected"`）。
- `test/loop-v020-rc.test.js:479` —— `events.push(["checkpoint", snapshot.status])`（记录写序）；`:605` —— `if (snapshot.status === "executed") throw …`（把失败注入到"工具后那次写"）。
- `test/persistence-diagnostics.test.js:171` —— `if (snapshot.status === "executed") throw new Error("snapshot unavailable")`，同一形状。
- `test/loop-snapshot-write-side-735.test.js` —— `:137`（PRESENT 清单）、`:162-173`（"`status` 这格仍如实分辨调用点"整条用例）、`:244`（键序清单）、`:274`（诊断打印）；`:22-25` 是文件顶注说明"为什么不停"；`:183 / :214` 是**手写旧档夹具**里的字段（不是读者，是旧形状容忍）。
- `test/contract-snapshot-cell-axes-767.test.js:515` —— 变异夹具里的字符串 `'snapshot.status inside a string'`，不是读者。

**不是读者的命中（登记以免误改）**
- `test/store/memory.test.js:17-21`、`test/store/file.test.js:468,520,521` —— 手写 `{round,status}` 过 store 往返，钉的是 store 透传；引擎写不写这格都照绿。
- `test/store/notes-store-forms.test.js:171,177`、`test/contract/notes-store.js:405`、`test/loop-snapshot-round-residue-735.test.js:425,426`、`test/contract/contract-export.test.js:251`、`test/cli-repl-render.test.js:109`、`test/helpers/loop-segments.js:222-229`、`test/persistence-coverage.test.js:79-106`、`test/loop-replay-context.test.js:390-403`、`test/run-snapshot-executor.test.js:98,191` —— 分别是 Promise.allSettled/notes 尝试/子进程退出码/引擎状态渲染/**executor 的调用点入参**，都不是快照格。
- 旧档夹具（读侧容忍，保留）：`test/fixtures/journal-0.22.0/work-*.snapshot.json`（`"status":"executed"`）。

**契约文档**
- `docs/host-consumer-contract.md`：表行 `status`（write=`written` / read=`not-source`，写点 `src/loop/orchestrator.js:3026`）+ 正文 `:2339` 起那段"`status` and `compactionStats` have zero engine readers, yet each is pinned by tests…"。
- `docs/host-consumer-contract_cn.md`：同表行 + 正文 `:1889` 起的对应段。

### 1.2 `compactionStats`（快照格 `snapshot.compactionStats`）的读者与断言

**权威来源（不动）**
- 轮记录侧写点：`src/loop/orchestrator.js:6160-6162`（`...(compactionStats.length > compactionStatsStart ? { compactionStats: cloneState(compactionStats.slice(compactionStatsStart)) } : {})`）。
- run-state deterministic：`src/loop/resume-manager.js:346` `ctx.compactionStats = deterministic.compactionStats;`（恢复侧读的是 **run-state**，不是快照那一格）；夹具 `test/loop-resume-prior-seed-469.test.js:16,53`。
- run 返回值：`src/loop/termination.js:696`（`result.compactionStats`），宿主侧读者一大批（`test/compaction-*.test.js`、`test/context-budget-*`、`test/cli-compaction-*`…），与快照格无关。

**拿快照格当证据的断言（= 要改指向的）**
- `test/compaction-observability.test.js:75-78` —— `loadLatestCheckpoint()` 之后 `checkpoint.compactionStats?.some(...)`；同一用例 `:64-66` 已断言 `result.runState.deterministic.compactionStats`，`:71-74` 已断言轮记录；标题 `:18` 写着「through result, state, archive, checkpoint, and events」五面。
- `test/loop-snapshot-write-side-735.test.js` —— `:25`（顶注）、`:138`（PRESENT 清单）、`:252`（键序清单）、`:192/:223`（手写旧档夹具字段，非读者）。
- `docs/…contract.md` / `_cn.md` 表行 `compactionStats`（写点 `:3038`(snapshot) 与 `:6161`(round record)、权威源列写 `resume-manager.js:346` + `orchestrator.js:6161`、读者列写 `test/compaction-observability.test.js:76`）+ 正文 `:2339` / `:1889`。

**不是读者的命中**
- `test/messages-identity.test.js:444` —— 断言的是 **run 返回值** 的键清单；`test/compaction-benefit-592.test.js:348` —— `decide()` 源码禁用字样守卫；`test/fixtures/message-journal-golden.json` 的 11 处 `"compactionStats": []` 嵌在**轮记录 / runState** 里（轮记录侧不停写 ⇒ 金样不动）；`test/fixtures/journal-0.22.0/*.snapshot.json`、`*.state.json` —— 旧档容忍。
- `scripts/docs-drift-check.mjs:5442` —— 禁用拼写表里的词面，不是读者。
（上表是**枚举**结果；下面步骤 2 逐条给出改法。）

## 步骤 2 — 先把读者/断言改指向权威来源（写点未动，改完全绿）

| 原证据（快照格） | 换成的权威来源 | 位置 |
| --- | --- | --- |
| `persist()` 从载荷嗅探 `args.at(-1)?.status`（`src/` 里唯一读者） | 调用点把状态**显式**交进分类：新增 `persistClassified(method, snapshotStatus, ...args)`，快照写点调用 `persistClassified(method, status, runId, {...})`；其余写（轮记录 / run-state）走 `persist()` 简写（那些方法的分类本来就不看状态） | `src/loop/orchestrator.js:1463-1490`（新函数 + 注释）、`:1530`（`persist` 简写）、`:3000-3003`（快照写点显式交状态） |
| 测试拿 `snapshot.status` 分辨调用点 | 载荷自带的引擎事实：最后一条 `tool_result` 的 `erix.executionStatus`（`rejected` / `intercepted`）+「在飞的那条调用就是最后那条结果且该 id 在 `executedToolIds` 里」= 工具后那次写；其余 = pending（含定时器写） | `test/loop-persistence-phase.test.js` 新增 `callSiteOf()`（`:53-80`），探针 store 采集处由 `status: snapshot.status` 改为 `status: callSiteOf(snapshot)`（`:130`），`EXPECTED_BY_STATUS` → `EXPECTED_BY_CALL_SITE` |
| `snapshots.find(e => e.status === "rejected")` 造崩溃夹具 | 同一条载荷里的 `toolResults[].toolResult.erix.executionStatus === "rejected"`（本用例下一行本来就在校验它） | `test/loop-invalid-arguments.test.js:235-242` |
| `events.push(["checkpoint", snapshot.status])` + `deepEqual([["checkpoint","pending"],["tool"]])` | 载荷里的执行事实：`executedToolIds` 为空 ⇒ 工具执行前那次写；标记改名 `pre-execution` / `post-execution` | `test/loop-v020-rc.test.js:478-485`、`:504` |
| 两处「拿 `status === "executed"` 当注入失败的开关」 | `snapshot.executedToolIds.length > 0`（工具真的执行过才会进这个集合） | `test/loop-v020-rc.test.js:609-613`、`test/persistence-diagnostics.test.js:170-173` |
| `loadLatestCheckpoint().compactionStats` 这一面 | 落盘 run-state 的 `deterministic.compactionStats`（`store.loadRunState()`，恢复侧读的就是它）；轮记录那一面（`store.load()`）与 run 返回值那一面本来就在断言里，未动 | `test/compaction-observability.test.js:18`（用例名去掉 checkpoint 面）、`:75-82` |
| 崩溃现场诊断打印里的 `entry.status` | `executedToolIds` 推出来的调用点标记 | `test/loop-snapshot-write-side-735.test.js:271-276` |

写序实测（`/tmp/probe770.mjs`，与 `test/loop-persistence-phase.test.js` 同一场景：两个工具块 + blocking judge + 定时器）：
`#0 pending(timer) → #1 pending(t1) → #2 executed(t1，executedToolIds=["t1"]、toolResultIds=["t1"]) → #3 pending(t2，仍带着 t1 的结果、executedToolIds=["t1"]) → #4 intercepted(t2，最后一条结果 executionStatus="intercepted") → #5 pending(timer,round2)`。
⇒ `callSiteOf()` 第一次只比「`executedToolIds` 非空」时把 `#3` 误标成 executed（这就是那条 sweep 用例当时的红），改成比「在飞的调用 == 最后那条结果的 id」后与旧 `status` 逐条一致。

**闸（步骤 2 之后，两格仍在写出）**：

```
$ node --test test/loop-persistence-phase.test.js test/loop-invalid-arguments.test.js \
    test/loop-v020-rc.test.js test/persistence-diagnostics.test.js test/compaction-observability.test.js \
    test/run-snapshot-executor.test.js test/loop-snapshot-write-side-735.test.js \
    test/loop-snapshot-round-residue-735.test.js
# tests 68 / # pass 68 / # fail 0        → NODE_EXIT=0
```

同一批里 `test/contract-snapshot-cell-axes-767.test.js` 有 7 条红（G4 与 G4-R1..R6），**全部是行号漂移**，红话原文举例：`cn：`round` 引用 src/loop/orchestrator.js:2986，但那一行没提到这个键名：const transcriptForSnapshot = messagesOverride ?? messages;`——这一条判据钉的是「表里写的 `path:line` ⇄ 锚点现算行号等值」，我在 `src/loop/orchestrator.js` 里加了注释行把它往下推了，属步骤 4 的同步范围，不在这里硬扛。

## 步骤 3 — 停止写入（两格从快照 payload 移除）

- `src/loop/orchestrator.js`：快照 payload 里删掉 `status,` 与 `compactionStats: cloneState(compactionStats),` 两行；
  同段注释重写成「四格全部停写 + 为什么这里没有写点」（`⇒ \`status\` 停写的理由：` / `⇒ \`compactionStats\` 停写的理由：`
  两行就是步骤 4 锚点要钉的注释行）。轮记录那处 `compactionStats`（`src/loop/orchestrator.js` 的 `persistRound` 段）
  **未动**，恢复侧的 `deterministic.compactionStats` **未动**。
- `test/loop-snapshot-write-side-735.test.js` 翻转的机器断言（这是本单唯一的「键存在性」机器面）：
  1. 判据 1「写侧 payload 不再带 …」：缺席清单 `["toolUse","ts"]` → `["toolUse","ts","status","compactionStats"]`；
  2. 「有读者的格照旧写出」：保留格清单里摘掉 `status` / `compactionStats`（原来带着「工单说零读者、实跑复核不是」的注记）；
  3. 「`status` 这格仍如实分辨调用点」→ 改成「`status` 停写之后调用点仍可分辨」：先断载荷里**没有** `status` 格，
     再用 `executedToolIds`（成功执行的唯一证据）+ 与之配对的 `toolResults` 二分工具前/工具后；
  4. 「保留格键序不动」：期望键序减去这两格，并加断 `status`/`compactionStats` 不在键序里；
  5. 「入参 status 透传不动」→ 「入参 status 不再被回音进载荷」：新增两条 `!Object.hasOwn(written, ...)` + 剩余 8 格集合对账；
  6. 「引擎亲笔新形状崩溃现场」：新形状缺席清单也扩到四格。
- 实测新键序（引擎亲笔，8 格）：`round, pendingToolUse, pendingToolUses, messages, persistedTranscriptLength, executedToolIds, toolResults, toolOutputs`（+ 崩溃时才有的 `partialText/partialRound`）。
- 一个踩过的坑：`erix.executionStatus` **只写在被拒/被拦/被中断**的结果上（`src/loop/run-snapshot-executor.js:330,721`、`src/loop/orchestrator.js:5378,5407`），成功执行没有这个标记 ⇒ 分辨「工具后」只能用 `executedToolIds`；第 3 条第一版拿它当必要条件是错的，已改。

```
$ node --test test/loop-snapshot-write-side-735.test.js test/loop-snapshot-round-residue-735.test.js \
    test/run-snapshot-executor.test.js test/loop-persistence-phase.test.js test/loop-invalid-arguments.test.js \
    test/loop-v020-rc.test.js test/persistence-diagnostics.test.js test/compaction-observability.test.js
# tests 68 / # pass 68 / # fail 0        → NODE_EXIT=0
```

## 步骤 4 — 契约与锚点同步（**部分收口：767 闸仍红，红话贴在下面**）

已做的三件事：
1. `src/loop/orchestrator.js:3029` / `:3038` 写出两行注释，内容就是「为什么这里没有写点」（`// ⇒ \`status\` 停写的理由：…` / `// ⇒ \`compactionStats\` 停写的理由：…`），各自在全文件唯一命中。
2. `scripts/cell-axes-anchors.mjs`：这两格的 `write` 轴条目改成 `kind: "comment"` 并钉上面那两行注释（重算行号 `[3029]` / `[3038, 6185]`——`6185` 是轮记录那处真写点，同轴另一条登记条目**保留**）；`CELL_AXES_REQUIRED_CELLS` 与条目总数（39）**未动**；另外把 `round|write` 的 `prev` 从 `^ +return await persist\(method, runId, \{$` 改成 `^ +return await persistClassified\(method, status, runId, \{$`（步骤 2 的显式分类改造成的真实行形变化，不改就会「锚点命中 0 行」）。
3. 两份契约表的**明细表**里这两格 write 判据改 `stopped`，并把两轴列里的 `src/loop/orchestrator.js:N` 引用按锚点重算值重排（EN 与 CN 同一形状）。

仍未收口的部分（闸自报，我没有手调判据）：

```
$ node --test test/contract-snapshot-cell-axes-767.test.js
# pass 8 / # fail 7
not ok 3  - G2 写轴对真载荷：声明 written/residue ⇒ 键必须在场，声明 stopped ⇒ 键必须缺席
not ok 8  - G4 表里每条 file:line 都复核（+ 两轴引用必须等于登记锚点重算的行号）
not ok 9  - G4-R1 反向证（写点换成同键名注释行 ⇒ 必红）
not ok 11 - G4-R3 反向证（表里多/少一条登记引用 ⇒ 必红）
not ok 12 - G4-R4 反向证（锚点种类是硬判据 ⇒ 必红）
not ok 13 - G4-R5 反向证（成对删登记条目与两份表引用 ⇒ 必红）
not ok 14 - G4-R6 特征用例（锚点改成同键名另一处真写入 + 两份引文同步改口 ⇒ 现在不红）
```

判读：`G4-R2`（锚点歧义）已经由红转绿，说明 `kind:"comment"` + 唯一命中这一步是对的；剩下的红集中在**两份表的引用集合与锚点重算值不完全等值**（两份 doc 里各有第二张「摘要表」也带同一批 `orchestrator.js:N` 引用，我按等值规则只重排了带引文的那张表；`G2` 也指向同一处口径没对齐）。修法是把两张表的引用一起纳入重排，或把摘要表的引用列改成不带具体行号的写法——两者都要按闸自报的「多一条/少一条」清单逐条对，不能手调地板。这一轮预算用尽，未继续。

## 步骤 5 — CHANGELOG 中英成对

`CHANGELOG.md` / `CHANGELOG_cn.md` 各一条，都挂在 `## [0.39.0]` 的 Changed 段首条；内容成对，都写明「键存在性是宿主可见面（`src/store/file.js:523` 直接 stringify）」「先改指向再停写」「停写后的键序」「旧档逐字读回」与机器缺席断言的位置。

## 未验证

- `test/contract-snapshot-cell-axes-767.test.js` 7 条红（见上），所以**契约文档/锚点/表三方尚未互相自洽**；`docs/host-consumer-contract*.md` 里两格下方的**正文段**（解释「继续写出」的那两段、以及 `compactionStats` 快照与轮记录同一表达式那段）**尚未按停写改写**，行号也未逐条复核——只有表里的两轴列被机器重排过。
- `npm run check:docs`、`:strict`、`:docs-spelling`、`:syntax`、`:agents-directives`、`node scripts/docs-drift-check.mjs --self-test`（约 7 分钟）与三档类型闸：**未跑**（预算用尽），因此两份 doc 的行号漂移会不会被这些闸抓住，未知。`BARE_LINE_REF_BASELINE` 未动。
- 全套 `npm test` 未跑（工单规定）；`test/test-suite-baseline.json` 未动：用例数**没有增删**（我只改了既有用例的断言指向，新增的 1 条 `callSiteOf()` 是 helper 不是用例；写侧文件里两条用例被改名但计数不变）。
- 除 `test/`、`docs/host-consumer-contract*`、`scripts/cell-axes-anchors.mjs`、`src/loop/orchestrator.js`、两份 CHANGELOG、`REPORT-770.md` 之外没有别的写入；未 rebase、未 push、未开 PR，未碰 `/home/eric/wt-770w` 与其它 `~/wt-*`。
