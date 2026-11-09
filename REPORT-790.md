# 报告 #790（恢复侧「请求视图桩」兜底：只改出网视图，不碰账本）

分支 `fix-261109-01-request-view-stub-790`，基点 = 主干 `040857c`（PR #795 合并后的 main）。

里程碑：① 取证与计划（本报告 M1 段）→ ② 实现 → ③ 单测 + 反向证 → ④ 派生登记与 CHANGELOG。

## 取证边界

**实际打开/读取过的路径**（全部可读，无 BLOCKED 文件）：

- `TICKET-790.md`（派单副本，收尾按工单要求不入库 ⇒ 仓里解不到，这是事实不是漏写）
- `AGENTS.md`（头部规矩 + 测试/提交纪律）
- `src/loop/provider-runner.js`（**全文**：`streamsThisRun` / `markStablePrefix` / `markTailCacheBoundary` / `callProvider` 的视图组装段与校验点）
- `src/loop/pending-tool-result.js`（**全文**：三条纪律、`scanMidSequence`、`buildUnpersistedToolResultStub`、四条 `MID_SEQUENCE_ABANDON_*` 成因名）
- `src/loop/resume-manager.js`（`restoreResume` 的账本重建段 500–580、崩溃现场分支 700–900、`persistedTranscriptLength` 赋值处 573–574）
- `src/loop/orchestrator.js`（`providerContext` 字面量 2785–2840、`emitResumeJournalSkip` / `groupResumeJournalSkips` 3335–3410、`executedToolIds` 与复放判据 2944 / 5868、`compactBeforeRound` 4245–4290）
- `src/store/append-user-turn.js`（#789 的「预写用户轮之前先结清」）、`src/store/recovery-rows.js`（`RECOVERY_ROW_KIND` / `RECOVERY_EVENT_TOOL_EXECUTED` / `readExecutedToolIdRecoveryRows`）
- `src/messages/rounds.js`（`validateMessages` 的逐对配对规则、`pendingTrailingToolUses`）、`src/loop/messages.js`（`normalizeMessages` 只合并相邻 assistant）
- `src/loop/request-user-view.js`（`ensureUserTurnView` 的回补来源与 `isRealUser` 口径）、`src/reflection/l0.js`（`extractL0Facts` 扫 `tool_result`）、`src/tool-fact.js`（`buildToolResultFact` 唯一构造点、`executionStatus` 闭集）
- `test/loop-resume-abandon-signals-730.test.js`（**全文**：夹具形状、`SOURCE_REASONS` / `SOURCE_DETAILS` 双向对账、四格断言）、`test/store/append-user-turn-settle-765.test.js`、`test/store/ledger-recovery-rows-769.test.js`、`test/loop-pending-tool-result.test.js`、`test/loop-547-provider-guard-channel.test.js`、`test/loop-run-stream-538.test.js`、`test/event-tier-coverage-743.test.js`、`test/tools/file-tools.test.js`（读数清单是**单向包含**，新增行不漂）、`test/compat-pin-inventory.md`（`--sync` 机器刷表口径）、`test/test-suite-baseline.json`
- `docs/host-consumer-contract.md` / `docs/host-consumer-contract_cn.md`（#730 那一节的成因表 + `Payload: {type, runId, parentRunId?, round, reason, count, detail?}` 那一行）
- `CHANGELOG.md`（`## [Unreleased]` 的中英成对形状）、`scripts/changelog-heading.mjs`、`test/static-guards.test.js`（`CHANGELOG_PAIR_FLOOR` 的校准面口径）
- 现造探针 `/tmp/probe790.mjs`（本次生成，下面「现场」全部输出由它打印）

**没有走的路（本单的边界，不是漏做）**：

- 不改账本写侧：`store.append*` / `appendRound` / `saveRunState` 在本单新增路径里**一次都不调**（`provider-runner.js` 今天全文不 import store，本单保持）。
- 不把桩塞进 `ctx.messages`：`ctx.persistedTranscriptLength`（`src/loop/resume-manager.js:573-574`）之后才有的这一层兜底只作用在**交给 provider 的那个数组**上。
- 不新增事件类型、不新增 `executionStatus` 第四个值（`src/tool-fact.js#TOOL_RESULT_CONTRACT` 是闭集，加值要动中英两份契约 + `test/contract/tool-result-envelope.js`）。
- 主会话独占的闸不在本单跑：`npm test` 全量、`check:types` / `check:types:strict` / `check:release` / `check:pack-links` / `check:mutation:run`；不 push、不开 PR、不合并。

## 现场（实测，`node /tmp/probe790.mjs`，基树 `040857c`）

夹具 = 「已经砖化的归档账本」形状（与 `test/loop-resume-abandon-signals-730.test.js` 的 `emptyAggregateScene` 同源）：

```
:msg:1:0  user      [text 任务]
:msg:2:0  assistant [tool_use t1]        ← 悬空
:msg:2:1  user      [text 一句文本]      ← 纯文本，没有任何 tool_result
:msg:2:2  assistant [text 继续]
```

1. 账本本身过不了严格配对：
   `ledger INVALID: invalid_messages | Invalid message at index 1: assistant tool_use has no immediately following user tool_result`
2. 续跑在任何出网之前死掉，栈落在请求视图组装处：
   ```
   KitError: Invalid message at index 1: assistant tool_use has no immediately following user tool_result
       at validateMessages (src/messages/rounds.js:89)
       at callProvider       (src/loop/provider-runner.js:131)   ← 就是本单要动的这一行
       at callProvider       (src/loop/orchestrator.js:2942)
   requests: 0
   ```
3. 宿主已经能听到的那条出声（#730 的既有词表，本单复用）：
   `[{"type":"resume_journal_skipped","runId":"probe-790","round":2,"reason":"mid_sequence_shape_not_supported","count":1,"detail":"aggregate_has_no_tool_result"}]`

**同一夹具在两种配置下死点不同**（记下来，别写回「只有 provider-runner 一处」）：上表探针没配压缩预算；若配了 `context.budgetTokens` + 策略，`compactBeforeRound`（`src/loop/orchestrator.js:4245`，里面 `normalizeMessages` + 策略自己的 `groupIntoRounds`）会**更早**在同一句上抛。本单按工单范围只修请求视图那一层，压缩那一层列为遗留（见末节）。

## 计划

### M2 实现（只改出网视图）

1. `src/loop/pending-tool-result.js`：新增第二句桩正文 `NO_EVIDENCE_TOOL_RESULT_TEXT` + 构造器 `buildNoEvidenceToolResultStub`（与 `buildUnpersistedToolResultStub` 同一处家，`buildToolResultFact` 仍是全仓唯一构造点，不新增 `executionStatus`）。新增只读函数 `stubUnsettledToolUsesForRequestView(messages, { executedToolIds })`：
   - 判据 = 「这条 assistant 的 `tool_use` **在整段上下文里没有任何对应 `tool_result`**」+「紧跟的那条消息一条 `tool_result` 都没有」（后者保证插页合法：不会把别处的结果挤成孤儿）+「id 全部可用」（沿用 `isUsableToolUseId`，不发明第三种兜底）+「不是最后一条消息」（尾部结清归 #394/#736/#789）。
   - 「全部未结清」是**整组**判据（与 `deriveLedgerCrashBoundary` 取舍 ① 同规则）：部分结清时插页会打散已有配对 ⇒ 不插。
   - 措辞二选一：`executedToolIds.has(id)` ⇒ 复用 `UNPERSISTED_TOOL_RESULT_TEXT`（执行过、结果没入账）；否则 ⇒ `NO_EVIDENCE_TOOL_RESULT_TEXT`（未知/无证据）。**绝不写「没执行」**（那句是 `PENDING_TOOL_RESULT_TEXT`，本单不产它）。
   - 插入的是**独立的新 user 页**，只装 `tool_result` 块 ⇒ 全仓档案里 0 个混合页这条不变。
   - 零改动保证：没有可补的 ⇒ 返回**同一个数组引用**（`{ messages: list, stubs: [] }`），健康路径逐字等价。
2. `src/loop/provider-runner.js`：`normalizeMessages(ctx.messages)` 之后、`validateMessages` 之前跑那一步；校验与后续折叠改吃视图（`foldToolResultsForRequest(view.messages, …)`）；`ensureUserTurnView(requestMessages, ctx.messages, userTurnGuard)` 那行**逐字不动**（#547 T3 结构判据钉着）。
3. 证据来源：`src/loop/orchestrator.js` 新增一个只服务出网措辞的集合（账本 `tool-executed` 恢复行**优先**、快照 `executedToolIds` 格只作兜底，顺位由 `restoreResume` 已有的读法决定），经 `providerContext` 交给 provider-runner。**不动** `resumeExecutedToolIds` / `executedToolIds` 那两格（它们参与复放与去重判据，动它们超出本单范围）。
4. 出声：仍走 `resume_journal_skipped`（不新增事件类型），`reason` 用新值 `mid_sequence_request_view_stub`，`detail` 复用既有两个取值，payload 追加**可选** `toolUseIds`。**为什么必须新增 reason**：既有四个 reason 全部说的是「**账本**这一格放弃了」，而本单这一格是「**账本仍然没修**，但请求视图修好了、run 能起来」——复用 `mid_sequence_shape_not_supported` 会让同一次续跑发出两条 `(reason, detail, count)` 完全相同的事件而含义相反，宿主恰好分不清 #730 要点名区分的那件事。中英两份契约的表与 `test/loop-resume-abandon-signals-730.test.js` 的 `SOURCE_REASONS` 同笔刷新。

### M3 测试（新文件 + 必红反向证）

见实现后追加的段落（验收 1～5 逐条）。

## 未验证（M1 时点）

- 实现与测试尚未落地（M2/M3 之后在本报告里逐条替换）。
- 配了压缩预算时死点前移到 `compactBeforeRound` 这一条只做了源码走读 + 一次未配预算的对照实测，没单独造配预算的夹具跑通。
