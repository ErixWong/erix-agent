# erix-agent 架构级评审（代码架构层）

> 独立架构评审（subagent 产出，主 agent 抽验复核：A2/A4/A5/A6/A9 证据与 npm test 基线均复核相符；A9 中 truncateBody 主 agent 粗窗口比对显示有差异，落地时按实际逐字节比对为准）。任务清单见 GitHub issues #164-#170（产品层，本报告不重复）。

- **日期**：2026-10-08（任务单写 2026-10-09，`date +%F` 实测为 **2026-10-08**，按纪律自校正；运行时输出文件名仍为 `2026-10-09-architecture-review.md`，落地到仓库时建议改名 `2026-10-08-architecture-review.md`）
- **基点**：`8a784b5`（0.17.0）
- **范围**：**代码架构层**。产品层结论（#164–#170）不重复讨论；仅对 #166（assemblyPort 双轨）与 #170（终止裁决表）补实现面证据。
- **边界前提**：`runToolLoop` 单任务生命周期、安全与多任务编排归宿主（ADR-009/012）；红线 = 零运行时 npm 依赖 / 纯 ESM / Node 22+ / 无构建步骤。
- **基线验证**：`npm test` → **1029 tests / 1024 pass / 0 fail / 5 skipped / 4.9s**（全绿，见文末）
- **规模**：src+bin = 21242 行；`src/loop/orchestrator.js` = **2944 行**，其中 `runToolLoop` **单函数 2551 行（394–2944）**

---

## 一页总览表

| # | 发现 | 证据位置 | 类型 | 净行数 | 宿主 API | 优先级 |
|---|---|---|---|---|---|---|
| A1 | `runToolLoop` 单函数 2551 行；**93 个 getter/setter**（≈186 行）仅为把可变闭包状态穿给 4 个协作者 | `orchestrator.js:394-2944`；访问器分布 1038-1256(46)/1326-1433(16)/1692-1768(17)/1885-1958(14) | 重构 | +250（分文件后） | 无 | **P1** |
| A2 | 3 处**纯重复全量 token 估算**（同一数组、中间无变更） | `orchestrator.js:1983` vs `2000`；`2055` vs `2072`；`2093` vs `2110` | 重构（性能） | ≈0 | 无 | **P0**（白送的性能） |
| A3 | `estimateTokens` 逐字符 + 8 区间线性扫描：217k token 上下文 **53ms/次**，每轮全量估算 8–10 次 → **~0.45s/轮 CPU** | `tokens.js:31-36,45-65`；实测见 §7 | 重构（性能） | +8 | 无 | **P1**（ASCII 快路径实测 **5.8×**，结果逐字节相同） |
| A4 | `trimGovernorHistory` **O(n²)**：while 每移出一个元素就全量 `JSON.stringify` + 估算两遍 | `orchestrator.js:959-965` | 重构（性能） | ±0 | 无 | **P1** |
| A5 | `run-snapshot-executor` **4× 复制 fail-closed 块**（各 14–15 行，仅 phase/sideEffect/文案不同） | `run-snapshot-executor.js:213-226,331-344,374-387,550-564` | 重构 | **−45** | 无 | **P1** |
| A6 | **观察者隔离不一致**：`onEvent`/`onRound`/`onToolResult` 抛错**直接终结整个 run**，而 `onDelta/onUsage/onToolCall/onJudge` 被吞 | 实测：见 §5 表；`orchestrator.js:1256-1258`（`emitEvent` 无 try）、`2825`、`run-snapshot-executor.js:258` | **行为变化** | +20 | **有**（语义收紧/放宽，需 semver 决策） | **P0** |
| A7 | `persist()` 用**字符串猜 phase**（`args.at(-1)?.status === "executed"`），再由调用方覆写纠正——两条通道可能给出不一致 phase | `orchestrator.js:684-692` vs `run-snapshot-executor.js:218-224,336-342` | 重构 | −25 | 无（诊断字段更准） | **P1** |
| A8 | 能力探测散落 **6 处**；`assembly-validators.js` 已有清单但无 resolver | `orchestrator.js:1441-1447,679-681`；`resume-manager.js:54,143-147,268`；`assembly-validators.js:34-56,99-103`；`store/file.js:383-402` | 重构 | −20 | 无 | **P1** |
| A9 | `providers/{openai,anthropic}.js` **4 个函数逐字节完全相同** + 1 个近似重复 | 实测 IDENTICAL：`hasOwn`/`truncateBody`/`parseJson`/`timeoutError`/`fetchOptionsWithTransport`（共 33 行）；`readResponseBody` DIFFERS | 重构 | **−40** | 无 | **P1** |
| A10 | `bin/{tools,mcp}.js` **两套 `truncateResult`**，策略不同（head+tail vs 纯 head）且互不复用 | `tools.js:443-451`（4096，head+tail 25% 尾部）vs `mcp.js:614-619`（RESULT_LIMIT，纯 head） | 重构 | −10 | 无 | **P2** |
| A11 | `messages ↔ providers` **名义环**（经 `providers/errors.js`+`payload.js` 两个零 import 叶子） | `messages/rounds.js:6`、`canonical.js:3`、`anthropic.js:5` ↔ `providers/{openai,anthropic}.js:4-17` | 重构 | ±0 | 无 | **P2** |
| A12 | `classifyHttpError` 归类黑洞：400/404/422 全落 `code:"unknown"`；`terminationDetailForError` **不做归类**，`result.termination.detail` 是裸 message | `providers/errors.js:86-101`；`termination.js:36-38` | 行为变化（可选） | +15 | 可能（新增 code 值） | **P2** |
| A13 | `bin/cli.js`(1045) 与 `bin/repl.js`(784) 的 `loopOptions` 装配块 **288 行 vs 125 行**，10 个字段重复装配 | `cli.js:21 字段 / repl.js:16 字段`，交集：`completion executeTool finalGuard maxRounds onDelta onRound onToolResult reflection semanticStateProvider system tools` | 重构 | −80 | 无 | **P2** |
| A14 | `bin/tools.js` **无统一安全/超时/截断管道**：`resolveToolPath` 仅 `path.resolve`（绝对路径直接逃逸 root）、仅 `exec` 有超时、截断分散 3 处 | `tools.js:349-351,371-400,443-451,484-497` | 行为变化 | +40 | 无（CLI 非库 API） | **P2** |
| — | **不做**：合并 governor/termination/内联为单一决策器；给 `groupIntoRounds`/`validateMessages` 加缓存；给 `appendUserTurn` 补 file-store 探针 | §6/§7 实测数据 | — | — | — | 建议不做 |

---

## 1. `orchestrator.js` 责任测绘与切分

### 1.1 现状：不是「大文件」问题，是「单函数」问题

`runToolLoop` 从 **394 行起、2944 行止**：单函数 **2551 行**。文件里只有 6 个模块级函数（`levenshteinDistance:150`、`optionSuggestion:166`、`persistenceInfoFor:178`、`persistenceErrorEvent:197`、`filterFindingsBySource:217`、`makePersistenceFailure:231`），其余全部在同一个作用域里。

实测责任段（行号为 grep 定位，非估算）：

| 行区间 | 行数 | 实际职责 |
|---|---|---|
| 140–215 | 76 | 选项白名单 + Levenshtein 未知选项建议 |
| 178–251 | 74 | persistence 事件构造 / 失败归一化 helper |
| 252–393 | 142 | `runToolLoop` JSDoc typedef（公共契约文档） |
| 395–600 | 206 | **选项解析与校验**（`throw TypeError` 集中营，全文件 78 处 typeof/isFinite/isSafeInteger） |
| 600–800 | 201 | 重试退避、error-ledger、`persist()` 管道、`fail()` 终局裁决 |
| 820–930 | 111 | reflection/judge 选项解析（含 853-880 拦截器参数） |
| 930–1000 | 71 | governor 状态容器 + `trimGovernorHistory`(O(n²)) + `restoreErrorSeen` |
| 1030–1256 | **227** | resume 装配：`restoreResume({...})` 内联 context 对象，**其中 46 个是 getter/setter** |
| 1256–1330 | 75 | 事件/usage/abort 小工具 |
| 1326–1434 | 109 | `providerContext`（**16 个访问器**） |
| 1434–1620 | 187 | snapshot 能力解析（3 级 fallback）+ `persistRunSnapshot` + partialPersistence 定时器 |
| 1620–1692 | 73 | run-state 语义快照构造 + `upsertRunStateInMessages` 注入 |
| 1692–1775 | 84 | `terminationContext`（**17 个访问器**） |
| 1776–1885 | 110 | `callRoundJudge`（judge 调用 + usage 带出 + 超时） |
| 1885–1965 | 81 | `runSnapshotContext`（**14 个访问器**） |
| 1975–2204 | **230** | `compactBeforeRound`：三级压缩 fallback 链（策略 → 滑窗 → safeTruncate） |
| 2204–2240 | 37 | transcript 尾部小工具 |
| 2340–2920 | **581** | 主循环体（provider 调用 → 工具执行 → L0/timeline → judge → 治理裁决 → 落盘 → final guard） |
| 2920–2944 | 25 | 收尾 `max_rounds_cap` + final guard |

**架构诊断**：93 个访问器 / 约 186 行样板，全部服务于一件事——**可变循环状态住在闭包里，协作者（`restoreResume`/`runProvider`/`createTerminationManager`/`createRunSnapshotExecutor`）需要读写它**。这不是风格问题，是**状态所有权没定下来**的症状：模块切了一半（4 个 manager 已提出去），但状态没跟着搬过去，于是用访问器「远程操作别人的局部变量」。文件里已有注释自证这个约束：

> `orchestrator.js:670` — “`emitEvent` 的 const 定义在下方，`restoreResume` 早于它执行（`markRunState("running")`），不能引用。”

即：**声明顺序已成为正确性约束**，这是单函数 2551 行最直接的代价。

### 1.2 提取缝（保持 `runToolLoop` 公共 API 不变）

`runToolLoop(options)` 的入参/出参形状完全不动（`src/index.js:74` 唯一导出点），只搬内部实现：

| 提取目标 | 来源行区间 | 迁移量 | 依赖 | 前置条件 |
|---|---|---|---|---|
| `loop/option-normalization.js`（选项校验 + 未知选项建议） | 140–215 + 395–600 | ~280 行外提 | 纯函数，零闭包 | **无**——最容易的一刀，全为 `throw TypeError` 的纯校验 |
| `loop/persistence-channel.js`（`persist`/`reportPersistenceError`/`notifyCapabilitySkipped`/`makePersistenceFailure`/`persistenceErrorEvent`） | 178–251 + 600–760 | ~230 行 | `errorLedger`、`retry` 参数 | 把 `retryAttempts/backoff/sleepImpl/errorLedger/toolExecutedThisRound` 收成一个对象传入；A7 先做会更干净 |
| `loop/compaction-orchestrator.js`（三级 fallback 链） | 1975–2204 | ~230 行 | `latestApiInputTokens/latestApiEstimatedTokens/foldedThrough/messages` | 传入 `{ messages, budgetTokens, apiUsage, foldedThrough }`，返回 `{ messages, stats, foldedPayload, navigationRecord }` |
| `loop/judge-runner.js`（`callRoundJudge` + intercept 参数解析） | 820–930 + 1776–1885 | ~190 行 | `provider`、`reflection` 配置、`judgeUsage` 回传 | 已接近纯函数，只需入参化 |
| `loop/loop-state.js`（**治本**：把 93 个访问器换成一个显式状态对象） | 900–1000 + 各 context 块 | 净减 ~150 | 全部 4 个 manager | 最后做；前面 4 刀完成后剩余状态才看得清 |

**最难测试的段落（及原因）**：

1. **2340–2920 主循环体**（581 行）——它同时读写约 **20 个可变闭包变量**（`messages/rounds/budgetRounds/foldedThrough/persistedTranscriptLength/toolExecutedThisRound/currentRunState/runStateVersion/interceptJudgeDecision/judgeInterceptCount/governorState.*` × 多），且中间穿插 `persist()`（可抛）与 `emitEvent`（宿主可抛）。任何一条分支测试都要**先把整个 2551 行作用域搭起来**——这就是为什么现有测试是 31 个文件 / 13922 行走**全量 `runToolLoop` 集成**路径（`test/loop-resume.test.js` 1321 行、`loop-v020-rc` 727、`loop.test.js` 697），而不是单元路径。
2. **`fail()`（734–800）**——终局裁决与 `persistenceInfoFor` 的错误对象自省耦合（读 `error.persistence` 或 `operation/phase/sideEffect` 三元组），要测「markRunState 失败 vs saveRunState 失败 vs 都失败」得手工构造 3 种形状的伪错误。
3. **1620–1692 语义快照构造**——`runStateVersion`/`semanticStateVersion` 一致性断言 + 可选 `inject`，状态跨 `resume-manager` 与 `termination` 两个模块，无独立入口。

---

## 2. 模块依赖图

`src/` 全部相对 import 的实测聚合（脚本化，按目录归并）：

```
(root)   -> compact(6) config(4) display(1) loop(2) messages(4) providers(3) reflection(4) store(4) tools(1)
loop     -> (root)(9) compact(5) messages(4) providers(3) reflection(7)
compact  -> (root)(4) messages(3) providers(1)
messages -> providers(3)      ←┐
providers-> messages(3)       ←┴─ 唯一的相互指向
reflection-> (root)(1)
store    -> (root)(2)
config   -> providers(1)
display  -> compact(1)
tools    -> providers(1) store(1)
```

**结论 1：没有真实环。** `messages ↔ providers` 是唯一双向边，但两条边都穿过**零 import 的叶子模块**（`providers/errors.js`、`providers/payload.js`——`grep -n '^import'` 两者均无输出）。所以是**名义环、非构造环**，不会导致初始化顺序问题。真正的问题是**分层语义错了**：`KitError` 是跨层原语（`messages/rounds.js:6`、`canonical.js:3` 都要用），却住在 `providers/` 里。修法：把 `errors.js`/`payload.js` 提到 `src/internal/`（或与 `tokens.js`/`run-state.js` 同级的 root kernel 层）。**零行为变化、纯移动 + 改 import 路径**。

**结论 2：`src/` 根目录已经是个没名字的层。** `tokens.js`/`run-state.js`/`assembly-validators.js` 被跨层共享（`tokens.js` 被 compact/loop/reflection 共 9 个文件引用；`run-state.js` 被 loop×3 + store×2 引用），`loop → (root)` 达 9 个 file-pair。建议显式命名该层（`src/internal/`），否则新代码不知道该往哪放。

**结论 3：`reflection` 该不该被 `loop` 反向调用？——已经正确，别动。** 实测 `src/reflection/*.js` 的全部 import 只有：`judge.js → ./l0.js + ../tokens.js`，`l0.js → node:crypto`。**reflection 是纯函数叶子层，不认识 loop**；`loop → reflection` 7 个 file-pair 单向。这正是想要的形状：`decideRoundAction/decideWithEvaluation`（`governor.js:59,135`）、`extractL0Facts`（`l0.js`）、`buildJudgePrompt/parseJudgeDecision`（`judge.js`）都是可单测纯函数（`test/governor.test.js`、`test/judge.test.js` 已在测）。**不需要改成回调注入**——回调注入会让治理逻辑失去可单测性，是倒退。

---

## 3. `run-snapshot-executor` / `provider-runner` / `resume-manager` / `termination` 交互

四者规模：574 / 256 / 290 / 263 行。边界**总体清晰**（快照执行、provider 重试、崩溃恢复、终止裁决各管一段），但有两处实质问题：

### 3.1 fail-closed 路径复制 4 份（应集中）

`checkpoint` 保存点 pre/post 的 fail-closed 处理，在 `run-snapshot-executor.js` 里**逐字重复 4 次**：

| 位置 | 保存点 | 行数 |
|---|---|---|
| `213-226` | pre-tool（`executeToolBlock`） | 14 |
| `331-344` | post-tool（`status:"executed"`） | 14 |
| `374-387` | pre-tool（intercept 路径） | 14 |
| `550-564` | post-intercept-result | 15 |

四段结构完全相同：`if (!persisted && ctx.hasRunSnapshotStore) { ctx.runSnapshotFailureCount += 1; const failure = new KitError("checkpoint_failed", <文案>); if (ctx.lastPersistenceFailure) { 逐字段拷贝 operation/phase/sideEffect/persistence/persistenceError } throw failure; }`。

**风险不只是重复**：`checkpoint_failed` 只在 `run-snapshot-executor.js` 构造（5 处），**没有集中点**——将来加第 5 个保存点（例如 partialPersistence 独立成路径）时，漏掉 fail-closed 检查不会报错，会**静默降级为 at-least-most-once 语义**（工具执行了但快照没落，崩溃恢复重复副作用）。而 5 个字段的手工拷贝，漏一个字段就会让宿主拿到半截 `failure.persistence`。

**方案**：提取 `assertSnapshotPersisted({ persisted, phase, sideEffect, message })`（约 12 行），4 处各调 1 行。**净减约 45 行**，行为不变（需逐字段比对确认四段除 phase/sideEffect/文案外全同——已比对，一致）。

### 3.2 快照状态与快照持久化分家

`persistRunSnapshot` 定义在 **orchestrator**（`1467-1518`），但调用点在 **run-snapshot-executor**（`207,323,368,542`）——它作为 `ctx.persistRunSnapshot` 注入，且在 4 处被重新取到不同局部名（`persistRunSnapshot` / `persistRunSnapshotAfter` / `persistRunSnapshotAfterIntercept` / `persistRunSnapshotForInterceptResult`，见 `206,322,367,541`）。这 4 个别名是**为绕开闭包捕获**而写的（同文件里 `const x = ctx.x` 的模式在 `run-snapshot-executor.js` 出现 20+ 次）。这属于 §1 的状态所有权问题在下游的回声。

**快照/回滚/恢复逻辑有无重复？** 有一处：`provider-runner.js:63-75` 构造 `snapshot = { messages, eventDeltas, finalText, ... }` 用于**重试回滚**，与 run-snapshot（崩溃恢复）是两个不同概念但共享了 `cloneState` 与「messages 深拷贝」的隐含约定；`resume-manager.js` 恢复的是后者。两者语义正交，**不建议合并**，但命名值得区分（`retrySnapshot` vs `runSnapshot`）——现状 `snapshot` 裸名在同目录里指两件事。

---

## 4. store 能力探测散落（#166 的实现面）

**清单已集中，解析没集中。** `assembly-validators.js` 已声明 `TRANSCRIPT_STORE_METHODS:34`、`RUN_SNAPSHOT_STORE_METHODS:34-36`、`RUN_STATE_STORE_METHODS:47-51`、`OPTIONAL_TRANSCRIPT_STORE_METHODS:56-59`，但**运行时选哪个方法**的逻辑散在 6 处：

| # | 位置 | 探测内容 |
|---|---|---|
| 1 | `orchestrator.js:1441-1447` | `saveRunSnapshot → saveCheckpoint → appendCheckpoint → undefined` 三级 fallback |
| 2 | `orchestrator.js:679-681` | `persist()` 里 `typeof store?.[method] !== "function"` → `notifyCapabilitySkipped` |
| 3 | `orchestrator.js:684-692` | 由方法名推 `phase`（`appendRound`→transcript / `save\|markRunState`→run_state / 否则看 `args.at(-1).status`） |
| 4 | `resume-manager.js:54` | `typeof ctx.store?.loadRunState !== "function"` |
| 5 | `resume-manager.js:143-147` | `loadLatestRunSnapshot → loadLatestCheckpoint` 二级 fallback |
| 6 | `resume-manager.js:13` + `268` | 写 `ctx.runStateAvailability = {...}` + 再次 `notifyCapabilitySkipped` |
| 7 | `store/file.js:383-402` / `memory.js:95-101` | 旧别名由 store 自己实现转发 |

`persistence_capability_degraded` 事件只在 `orchestrator.js:666-677` 产生，且**刻意绕开 `emitEvent` 直接调 `onEvent?.()`**（原因见 `:670` 注释的 TDZ 约束）。`runStateAvailability` 的**写入方在 `resume-manager`（第 6 项），声明方在 orchestrator（`:926`）**，跨模块远程赋值——正是 93 访问器模式。

**值得收敛成一个 capability resolver 吗？值得，但范围要小。** 建议 `loop/store-capabilities.js`（约 60 行），一次性解析出：

```js
{ snapshotSave: "saveRunSnapshot"|…|undefined, snapshotLoad: …|undefined,
  runState: { save, load, mark } 或 undefined, transcript: true,
  missing: [ "saveRunSnapshot", … ] }   // 供一次性诊断
```

`persist()` 的 method→phase/sideEffect 映射同时从「字符串猜测」升级为 resolver 里的显式表（顺带解决 A7）。**净减约 20 行**，风险低（能力解析在 run 生命周期内本就是启动期一次性事实）。**不影响宿主 API**：方法名兼容与 `persistence_capability_degraded` 事件形状原样保留。

**与 #166 的关系**：`assemblyPortOptions`（`orchestrator.js:411`）与细粒度选项双轨的实现面证据——两条形状在启动期汇流到同一批局部变量，且 `collectLoopCapabilitiesMissing`（`assembly-validators.js:118`）要用 `fineGrainedPortShape` / `hasExplicitModelConfigOverride` 两个布尔参数区分形状，说明**双轨在能力校验上已经开始分叉**。这是「保留但收紧」的信号，不是「立刻删除」的信号。

---

## 5. 事件 / 诊断管道一致性

### 5.1 现状矩阵（★=实测，非读码推断）

| 通道 | 定义位置 | 宿主抛错后果 | 记账（errorLedger） | 二次兜底 | 隔离 |
|---|---|---|---|---|---|
| `onEvent` | `orchestrator.js:1256` `emitEvent` | **run 终止** `termination.failed` ★ | 否 | 无 | ❌ |
| `onRound` | `orchestrator.js:2825` `await onRound(record)` | **run 终止** ★ | 否 | 无 | ❌ |
| `onToolResult` | `run-snapshot-executor.js:258` | **run 终止** ★ | 否 | 无 | ❌ |
| `onDelta/onReasoningDelta/onToolCall/onUsage` | `provider-runner.js:93-105` `dispatchAttemptEvent` | 记录后继续 ★ | 否 | `onObserverError`→`console.error` | ✅ |
| `onJudge` | `orchestrator.js:1271-1279` | 静默吞（`catch {}`） | 否 | 无 | ✅（过度） |
| `onPersistenceError` | `orchestrator.js:610-628` | 记 `delivery_failure` 后继续 | ✅ | ledger | ✅ |
| `diagnostics.error` | `orchestrator.js:629-636` | 记 `delivery_failure` 后继续 | ✅ | ledger | ✅ |
| `reportHostPersistenceFailure` | `orchestrator.js:638-650` | 同上（`fatal:false`） | ✅ | ledger | ✅ |
| `onObserverError` | `orchestrator.js:652-662` | `console.error` | 否 | 控制台 | ✅ |

实测复现（`persistence:"none"`，最小 provider）：

```
throwing onEvent   => THREW Error | host sink bug    | termination= {"reason":"failed","detail":"host sink bug"}
throwing onRound   => THREW Error | host round bug   | termination= {"reason":"failed","detail":"host round bug"}
throwing onToolResult => THREW Error | boom
throwing onDelta   => OK termination: {"reason":"end_turn"}
onJudge / onUsage  => OK（静默）
```

**语义不正交**：同一类故障（宿主回调抛错）走 **3 种不同后果**——终止 run / 进 ledger / 静默吞。而且**没有任何测试锁定 `onEvent` 抛错终止 run 这一行为**（`grep` 全 test/ 无匹配），`runToolLoop` JSDoc（`orchestrator.js:368-380`）也**没写**哪些回调必须自己保证不抛。等于一个未声明、未测试、宿主一踩就炸的隐式契约。**这是本项目对宿主最容易踩的架构级坑**（P0）。

### 5.2 字段形状漂移

- **同一故障双通道**：`persist()` 失败时，①`reportPersistenceError` 发 `persistence_error` 事件（携带由 `:684-692` **猜**出来的 phase），②`makePersistenceFailure` 抛异常（携带同一 phase，但**随后被 `run-snapshot-executor` 手工覆写**为 `checkpoint_before_tool`/`checkpoint_after_tool`，见 `:218-224`、`:336-342`）。当事件已按猜的值发出、异常带的是纠正后的值 → **宿主从 `diagnostics.error` 与从异常里读到的 `phase` 可能对不上**。具体触发：`partialPersistence` 的定时器写快照（`orchestrator.js:1539`，`status:"pending"` 且**没有 pending tool**）会被猜成 `checkpoint_before_tool`。
- **事件类型清单**（`orchestrator.js` 内 `emitEvent` 实发）：`round_start`/`round_end`/`usage`/`tool_use`/`tool_result`/`text`/`compaction`/`final_guard`/`forced_final`/`tool_replay_decision_required`/`persistence_error`/`persistence_capability_degraded`；provider 层另发 `delta`/`reasoning_delta`/`tool_call`（`messages/anthropic.js:660,683,709`、`providers/openai.js:432`）。**`usage` 在两层都发**（`orchestrator.js:2378,2416` 与 `provider-runner.js:96`），去重靠 `attemptUsage !== undefined`（`provider-runner.js:98`）这个隐式约定。

**建议**：把 `emitEvent`/`onRound`/`onToolResult` 统一走「观察者隔离」包装（复用已有 `reportObserverError`），`onJudge` 的裸 `catch {}` 改为同一通道（现在它连 `onObserverError` 都不通知）。**这是行为变化**：现在会因宿主回调抛错而失败的 run，之后会跑完 → 对宿主更宽松、不破坏既有正确代码，**建议 semver minor + 文档明确契约**，不要静默改。

---

## 6. 终止 / 治理决策流（#170 的实现面）

三处现状：

1. **`termination.js`（263 行）**——`terminationReasonForAction:51`（`judge_done → continuation_exhausted → no_tool → stall → max_rounds_cap → end_turn` 优先级映射）+ `TRUNCATED_TERMINATION_REASONS` + `FINAL_GUARD_*` 集合 + `createTerminationManager`（含 final guard 调用、`forceFinalIfNeeded:161`、`makeResult:215`、`finish:240`）。
2. **`governor.js`（179 行）**——`decideRoundAction:59`（9 级顺序）与 `decideWithEvaluation:135`（judge 在场时 6 级）。**已是纯函数、已有单测**（`test/governor.test.js`）。
3. **`orchestrator.js` 内联**——`actionSignals` 装配 **38 个字段**（`2624-2652`）、judge 置信度阈值 **`>= 0.7` 魔法数出现 2 次**（`2697`、`2720`）、`nearLimit` 的 **`0.8` 魔法数**（`2641`）、以及 `terminationReasonForAction` 的调用点。

**职责重叠度评估：中低。** 真正重叠的只有「cap/stall/noTool/judge_done 这几種终局在 governor 与 termination 两处都出现」，但二者角色不同（governor 出 `action`，termination 把 `action` 映射成 `reason`），是**正交的两步**，不是重复实现。

**实现层要不要合并成单一决策器？不要大改，只做 3 件小事**（P2）：

- 把 `0.7` / `0.8` 两个魔法数提成命名常量并与 judge 文档同处（`JUDGE_DONE_CONFIDENCE_MIN`、`NEAR_LIMIT_RATIO`）——`#170` 的裁决表文档要引用它们，散落 2 处的阈值会让文档与实现漂移。
- `actionSignals` 38 字段构造（28 行）外提为 `buildGovernorSignals(...)`，纯函数、可直接单测，主循环体当场瘦 28 行。
- **不建议**把 `createTerminationManager` 与 `decideRoundAction` 合并：前者有 IO 副作用（final guard 调 LLM、`emitEvent`、`finish` 落盘），后者是纯映射；合并等于把可单测的纯函数拖回 IO——逆 §1 的方向。

---

## 7. 性能热点（实测，非猜测）

### 7.1 主热点：全量 token 估算重复跑（最值得优化）

`estimateMessageTokens` 是 O(全部消息字符数)，内层 `isCjkUnifiedIdeograph`（`tokens.js:31-36`）对**每个字符**做 `CJK_RANGES.some(...)` 的 8 次区间比较，且用 `for (const character of value)`（字符串迭代器，比索引循环慢一个量级）。

实测（180 条消息 / 217k 估算 token，≈ 131k 上下文 2 倍的真实长任务）：

```
estimateMessageTokens per call: 53.35 ms
groupIntoRounds per call:        0.30 ms   ← 便宜 178 倍
validateMessages per call:       1.35 ms   ← 便宜 40 倍
```

每轮 `compactBeforeRound` 全量估算 **5 次**（`1983,2000,2055,2072,2093,2110`）+ `provider-runner` 每次请求 **2 次**（`62,68`）+ `max_tokens` 续写分支 `2389` → **约 8 次/轮**：

```
每轮 CPU ≈ 8 × 53ms ≈ 427ms      100 轮 ≈ 42.7 秒纯估算（单核，不算网络）
```

**其中 3 对是纯重复**（同一数组、两次调用之间无变更，已逐行核对）：

| 对 | 行 | 被重复估算的对象 |
|---|---|---|
| 1 | `1983` → `2000` | `messages`（中间只算 keepRounds，无数组变更） |
| 2 | `2055` → `2072` | `compactedMessages`（中间只 `observeCompactionLayer`/投影） |
| 3 | `2093` → `2110` | `compactedMessages`（中间只 `projectedApiInputTokens`） |

**优化 1（零风险，先做）**：删这 3 次重复 → **8 次降到 5 次，−37% 估算 CPU，净行数 ≈0，行为完全不变**。

**优化 2（5.8×，同样零行为变化）**：`estimateTokens` 加 ASCII 快路径——`code < 0x3400` 直接算 non-CJK，跳过 8 区间扫描；只对少数非 ASCII 字符走原路径。实测：

```
chars 210000 | current 13.94ms | fast 2.40ms | speedup 5.8x
same result?  true   152786 === 152786
```

即**结果逐字节相同**（这是纯加速，不改口径），+8 行。两项叠加：每轮 427ms → **约 30ms**（14×）。

### 7.2 次热点：`trimGovernorHistory` 是 O(n²)

`orchestrator.js:959-965`：`while` 每移出一个元素，就对**剩余全部** `runningLog` 与 `l0Facts` 各做一次 `JSON.stringify` + `estimateTokens`。日志越长、需要修剪越多 → 平方级。修成「先估一次，超量则按被移出条目的估算值递减」即可，行为需保留「至少留 1 条」。

### 7.3 file store 剩余 O(n) 路径（#160 之后）

`#160` 已把 `appendRecord` 的幂等判定从「每次全量读全文」改成进程内 dedup key 缓存 + `(size,mtimeMs)` 新鲜度戳（`file.js:171-232`，命中后 O(1)），并让 0 字节文件直接构造空集。剩余 O(n)：

1. **`repairTrailingFragment`**（`file.js:117-146`）：尾部字节非 `\n` 时 `await handle.readFile()` **读全文件**。正常路径只 `read(1 byte)` 即返回（`:121-122`），**只有崩溃后的下一次 append 才付全量代价**——频率低、语义需要，**不建议优化**。
2. **`store.load()`**（`file.js:263/320`）：全量流式 parse，被 **`appendUserTurn` 慢路径**（`append-user-turn.js:125`）每轮用户输入付一次。内置 file store **不实现** `loadByDedupKey/loadMaxRound` 探针（`append-user-turn.js:26,92-93`，注释明确「点查对 JSONL 无意义」，实测 grep 无实现），所以 CLI/repl 的多轮路径（`cli.js:651`、`repl.js:627`）**每轮 1 次全量 load**。这是**设计取舍而非遗漏**：JSONL 点查本身也要扫全文，除非 file store 额外维护 round/dedupKey 索引——而 #160 的 dedup 缓存已经建了 key set，**复用该缓存维护「最大 round」是唯一低成本的增量**（约 15 行），但收益只落在 CLI 多轮（非宿主热路径），**P2，可不做**。
3. `loadRecords` 在 resume 时全量读——一次性成本，正常。

### 7.4 judge prompt 成本

`renderConversation`（`judge.js:270-330`）每次对**全量 messages** 逐块渲染并**对每段调 `estimateTokens(text)`**（`:327`）。成本 O(全量文本)，但只在 end_turn 轮与 intercept 时跑（远少于每轮 8 次的估算），且已有 `INTERCEPT_CONVERSATION_TOKENS` 预算封顶。§7.1 的 ASCII 快路径会**自动加速它**，无需单独处理。

---

## 8. 重复实现检测

| 候选 | 判定 | 证据 |
|---|---|---|
| `messages/rounds.js` vs `loop/messages.js` | **不是重复** | rounds 出 `validateMessages:43`/`groupIntoRounds:129`（消息**合法性与轮划分**）；loop/messages 出 12 个**块操作**（`mergeToolResultsIntoMessages`/`normalizeMessages`/`hasToolUse`…）。零函数重叠，且 `groupIntoRounds` 被 6 处共享（compact×3、loop×2、index 导出） |
| `messages/canonical` vs `messages/anthropic` vs `openai-normalization` | **合理协议分层** | canonical 出 `canonicalToOpenAIMessages/canonicalToolsToOpenAI/openAIResponseToCanonical`；anthropic 出 `canonicalToAnthropicRequest/anthropicResponseToCanonical/createAnthropicStreamAssembler`；normalization 出 4 个 OpenAI 归一化函数。形状相似是协议对称的必然，**不是重复** |
| `providers/openai.js` vs `providers/anthropic.js` 私有 helper | **真重复（P1）** | 逐字节比对：`hasOwn`(3) / `truncateBody`(3) / `parseJson`(7) / `timeoutError`(8) / `fetchOptionsWithTransport`(12) **完全相同**；`readResponseBody` **有差异**（差异需保留，可能各自流式语义不同）→ 提取 5 个到 `providers/http-shared.js`，**净减约 40 行** |
| `bin/tools.js` `truncateResult` vs `bin/mcp.js` `truncateResult` | **真重复且已漂移（P2）** | `tools.js:443`：4096 上限、**head+tail**（尾部占 25%，注释「尾部报错比中段 filler 有价值」）、带「已归档」幂等正则；`mcp.js:614`：默认 `RESULT_LIMIT`、**纯 head 截断**。同名不同策略，`headTailTruncate`（`tools.js:432`）已导出却无人复用 |
| `bin/cli.js` vs `bin/repl.js` `loopOptions` | **部分重复（P2）** | 21 vs 16 字段，交集 10 项（`completion executeTool finalGuard maxRounds onDelta onRound onToolResult reflection semanticStateProvider system tools`），装配块 **288 行 vs 125 行**。共享面其实做得不错（都走 `assembly-root.js:78` 建 store、都复用 `config/mcp/skills/final-guard/guard-metrics`），重复只在「装配」这一层 → 提一个 `buildBaseLoopOptions(context)` |
| `governor.decideRoundAction` vs `decideWithEvaluation` | **不是重复** | 两个入口共享 `isStuckOnRepeatedError:15`/`shouldWrapUp:26` 谓词，judge 在场时才走 evaluation 分支；合并会牺牲可单测性 |

---

## 9. 错误分类一致性

四层现状与归类漏洞：

1. **`KitError`（`providers/errors.js:57-78`）**——`code` 自由字符串，`retryable` 缺省由 `defaultRetryable(code)` 查 `RETRYABLE_CODES:1`（`timeout/rate_limited/server/disconnect`）。全仓 `new KitError("<code>")` 实测使用 6 种 code：`server`×14、`timeout`×4、`unknown`、`tool_unknown_executor`、`invalid_messages`、`aborted`。另在别处手工挂 `code`：`run-snapshot-executor.js:212…` 的 `checkpoint_failed`（**用 `new KitError("checkpoint_failed", …)`，共 5 处**）、`orchestrator.js:1855` 的 `judge_intercept_timeout`、`termination.js:2:77`(final guard) 的 `timeout`。
2. **`classifyHttpError`（`errors.js:86-101`）**——只映射 408→timeout、429→rate_limited、401/403→auth、5xx→server，**其余全部 `code:"unknown"`**。**黑洞在此**：400（请求体不合法/工具 schema 错）、404（模型名错）、422、409 都落 `unknown` 且 `retryable:false`。宿主想区分「模型名配错了」与「端点挂了」只能读 `status`，`code` 层丢失信息。
3. **`classifyFetchException`（`:141-169`）**——abort/timeout/其余一律 `code:"network"` + 靠 `isRetryableNetworkException:120-131` 的**中英文正则**（`socket hang up|connection reset|broken pipe|\bEOF\b|do request failed|连接重置|连接被对端关闭`）判可重试。归类正确但**判据含文案匹配**——relay 换措辞即静默失去重试能力。
4. **`terminationDetailForError`（`termination.js:36-38`）**——`String(error.message)`，**完全不归类**。所以 `result.termination = { reason, detail }` 里**没有 `code`**：`reason` 只有 9 个枚举值（`end_turn/no_tool/stall/max_rounds_cap/judge_done/continuation_exhausted/final_guard_unverified/aborted/failed`），任何 `failed` 的**根因分类对宿主不可见**，只能解析 detail 字符串，或 catch 异常读 `error.code`（**成功返回路径拿不到 code**）。
5. **`error-ledger`（`error-ledger.js`）**——只管持久化账（`kind` 默认 `persistence_error`，`dedupKey` 由 kind/port/operation/phase/fatal/name/message 拼），**不消费 KitError.code**。

**冲突/黑洞结论**：无互相矛盾（四层对象不同：HTTP 传输 / 治理终局 / 持久化账），但有 2 个真问题：

- **黑洞 A（P2）**：4xx 客户端错全落 `unknown`。修法是补 `invalid_request`(400/422)/`not_found`(404)/`conflict`(409) 三个 code，**新增 code 值属于对宿主可见的取值面扩展**→ semver minor，非 BREAKING。
- **黑洞 B（P1，与 #170 直接相关）**：`result.termination` 不带错误分类。建议 `makeResult`/`fail` 在 `reason:"failed"` 时挂 `termination.errorCode = error?.code`（有则带，无则 `unknown`），约 +10 行、纯增量字段。这样 #170 的裁决表文档才有可实现、可断言的落点。

---

## 10. CLI 侧架构

**共享良好、装配重复**：`cli.js`(1045) 与 `repl.js`(784) 共同依赖 `assembly-root.js`（store 只在 `assembly-root.js:78` 一处构造）、`config.js`(`loadCliConfig`/`buildCompactionContext`)、`mcp.js`、`skills.js`、`final-guard.js`、`sessions.js`、`guard-metrics.js`、`tools.js`——**基础设施没有重复**。`repl.js` 由 `cli.js:23` 导入（单向）。重复集中在两处：

1. `loopOptions` 装配（§8：288 行 vs 125 行，10 字段交集）。
2. 两者各自 `import { runToolLoop }` 并各自收尾（`cli.js:844`、`repl.js:715`，都支持 `loopOverride`/`io.loop` 注入，测试面这点做得好）。

**`bin/tools.js` 内置工具没有统一的安全/超时/截断管道**（P2，CLI 非库 API，不影响 semver）：

| 维度 | 现状 | 证据 |
|---|---|---|
| 路径安全 | `resolveToolPath(root, value) = path.resolve(root, value)`——**无 root 包含性校验**，绝对路径直接逃逸（实测 `path.resolve("/proj/","/etc/passwd") === "/etc/passwd"`）。5 个 handler 调它（`:563,580,665,755,807`） | `tools.js:349-351` |
| 超时 | **只有 `exec` 有**（`getCommandTimeoutMs`，120s / 安装类 300s，`:86-107,389`）。`readFile`/`grep`/`tree` 靠 `MAX_FILE_BYTES`(1MB) 与 `GREP_MAX_RESULTS_HARD_CAP`(200) 间接限流 | `:78-88,591,678` |
| 截断 | 分散 3 处、3 种口径：① `truncateResult` 4096 head+tail（`:443`）；② `summarizeToolResult` 显示层 `TOOL_RESULT_LIMIT` 200 / exec 4096（`:454-455,484-497`）；③ `mcp.js:614` 自己的纯 head。**且 `truncateResult` 全仓仅 2 个调用点**（`:923` 导出、`mcp.js` 用自己的），说明**没有管道，只有各自为政** | `:443,488` |
| 统一入口 | `executeTool(name, input, context)`（`:905-916`）只做 `executors[name]` 查找 + `normalizeToolInput`，**不含超时/截断/路径守卫**——三件事全在各 handler 内 | `:905` |

建议（P2）：`executeTool` 包一层 `withSafety(executor)`（路径包含性 + 默认超时 + 出口统一 `headTailTruncate`），并让 `mcp.js` 复用 `tools.js` 的 `headTailTruncate`。**注意 `readFile` 的 `offset/limit` 窗口语义要原样保留**（`:425` 注释已声明「readFile 不经过截断，行为不变」），统一管道必须允许 handler 声明「已自带窗口」。

---

## 11. 分阶段重构路线

### 阶段 0：下一次发布前（低风险小切面，全部行为不变）

| 项 | 动作 | 净行数 | 验证 |
|---|---|---|---|
| **A2** | 删 `compactBeforeRound` 3 对重复估算 | ≈0 | `npm test` 全绿 + `compaction-observability.test.js` 断言 `tokensBefore/After` 不变 |
| **A3** | `estimateTokens` ASCII 快路径 | +8 | 新增单测：中英混排/CJK/emoji 代理对/image·tool_use·raw 块，断言与旧实现**逐字节同值** |
| **A5** | 4× fail-closed 块提 helper | −45 | 现有 checkpoint 失败路径测试须逐条保持（`grep -rn 'checkpoint_failed' test/`） |
| **A9** | provider 共享 helper 提取（5 个逐字节相同者） | −40 | `test/providers/` 全绿 |
| **A6 前置** | 先给 `onEvent/onRound/onToolResult` 抛错行为**补测试锁定现状** | +60 测试 | 为后续行为变更留证据，避免「顺手改语义没人知道」 |

理由：这 5 项**零宿主可见行为变化**、每项独立可回滚，且 A2/A3 直接砍掉每轮 ~0.4s CPU——长任务（≥16 轮）收益立竿见影。

### 阶段 1：touwaka 宿主迁移落地后再做（中等动作，需协调窗口）

| 项 | 动作 | 为何要等 |
|---|---|---|
| **A6** | 观察者隔离统一（`onEvent/onRound/onToolResult` 走 `reportObserverError`） | **行为变化 + semver 决策**：现在因宿主回调抛错而 `failed` 的 run 会变成跑完。必须等宿主代码稳定，才好判断宿主有没有**依赖**「回调抛错 = 终止 run」这个隐式语义 |
| **A8 + A7** | capability resolver + `phase/sideEffect` 显式表 | 触碰 store 能力解析路径，宿主自定义 DB store（touwaka 的正是）是最大变量；迁移落地后才能用真 store 验证。做完 `persistence_error` 的 `phase` 会更准（对宿主是修 bug 级改进，宜与 semver minor 一起发） |
| **A1 分刀** | 依次外提 `option-normalization` → `persistence-channel` → `compaction-orchestrator` → `judge-runner`；最后才做 `loop-state` | 前三刀无状态、纯函数，随时可做；**`loop-state`（治 93 访问器）要等宿主迁移稳定**——它改动面最大、收益是长期维护性而非近期正确性 |

### 阶段 2：机会性（P2，不单独立项）

A10（CLI 截断统一）、A11（`internal/` 层与 provider 叶子归位）、A13（`buildBaseLoopOptions`）、A14（CLI 安全/超时管道）、A12 黑洞 A（补 4xx code）、§6（魔法数提常量 + `buildGovernorSignals`）。其中 **A12 黑洞 B（`termination.errorCode`）建议提前**：它是 #170 裁决表文档的实现前提，+10 行纯增量字段，不值得等。

### 建议**不做**（防过度重构；对齐 ADR-016/018 的「实测再删」传统）

1. **不合并 `governor` 与 `termination` 成单一决策器**——`decideRoundAction` 已是纯函数且有单测；合并会把 IO 拖进纯函数，逆「可单测」方向。只做 §6 的三件小事。
2. **不给 `groupIntoRounds`/`validateMessages` 加缓存或增量化**——实测 0.30ms / 1.35ms，比 token 估算便宜 40–178 倍；A2/A3 之后它们连噪声都算不上。**先测后优**（这正是本项目 ADR-016/018 的传统）。
3. **不给 file store 实现 `loadByDedupKey/loadMaxRound` 探针**——JSONL 点查要额外维护索引，收益只落在 CLI 多轮（非宿主热路径）；#160 的 dedup 缓存已解决真正的 O(n) 大头。若将来做，唯一低成本路径是复用 dedup 缓存顺带记 max round（+15 行）。
4. **不改 `reflection` 为回调注入**——依赖图已是 `loop → reflection` 单向、reflection 纯叶子，现状即最优解。
5. **不拆 `messages/anthropic.js`(763) / `messages/canonical.js`(509)**——形状相似是 OpenAI/Anthropic 协议对称的必然，不是重复实现。
6. **不动 `runToolLoop` 公共 API 形状**——31 个测试文件 / 13922 行走集成路径，加上宿主直连 `src/index.js:74`；改入参/出参的代价远大于收益。

---

## 附：基线与验证

```
$ npm test
1..1029
# tests 1029
# suites 0
# pass 1024
# fail 0
# cancelled 0
# skipped 5
# todo 0
# duration_ms 4894.885
```

**基线全绿**（1024/1029，5 skip，0 fail）。性能实测与「抛错后果」实测均为脚本复现，脚本置于 `/tmp`（未写入仓库，遵守只读分析约束）。

**本次分析未修改任何源码/文档/测试，未执行任何 git 写操作。**
