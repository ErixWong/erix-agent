# 修复方案：#470（替代物落账）与 #469（摘要拿不到）

> 配套分析：`docs/issue-469-470-analysis.md`（同批勘误见本文 §6）。
> 基线 `HEAD=2ef01490`；本文所有落点都是**本树复核过的 path:line**，未复核的推测一律标 ⚠。

## 0 总览

拆成 4 个可独立交付、可独立 revert 的 PR。**PR-1 零 LLM、纯加法、零行为回归，先做**（与 #469 评论里「本站倾向先做 #470」一致）。

| PR | 内容 | 兼容性 | 覆盖判据 | 估算 |
|---|---|---|---|---|
| **PR-1** | #470-A：折叠替代物投影进轮记录（新键 `foldedFacts`）+ #470-B 尺寸上界 + C 档 sliding-window 产出 | 纯加法 | #470 判据 1 / 3 / 4 | 小 |
| **PR-2** | #470-A2：`"missing"` 占位退役（缺替代物 ⇒ 不写键、不补历史条目） | **行为变更**，可推迟 | #470 判据 2 | 小（但要宿主同步） |
| **PR-3** | #469-④：摘要预算与 5 节合同自洽（默认值 + 修剪保骨架 + 摘要专属 `maxTokens`） | 默认值变更 | #469 判据 3 | 小 |
| **PR-4** | #469-②③①：输入有界 + `finishReason`/降级原因入账 + 摘要专属超时 | 纯加法（默认逐字不变） | #469 判据 1 / 2 / 4 | 中 |

建议顺序 **1 → 3 → 4 → 2**（PR-2 是语义变更，等宿主 erix-station 的 `hasSummary` 一起收口）。

---

## PR-1 · #470：把已有的替代物投影到账本（零 LLM）

### 现状（已核）
`orchestrator.js:3241-3273` 已按**对象身份**把「本次折叠造出来、确实进了请求的那条消息」的正文写成轮记录上的 `foldedSummary` 事实行（`fold-llm` 降级与 `fold-statistical` 两档**都已入账**）；但轮记录自己的 `summary`（`:4254 summary: roundSummary`）语义是「本轮自身摘要」，与折叠无关。⇒ 缺的是**投影**，不是产出。

### 做法：新增轮记录键 `foldedFacts`（不覆盖 `summary`）
```js
foldedFacts: {
  text,                 // = fedSummaryText（机械文本，与喂给模型的那份逐字相同）
  kind: "llm" | "statistical",   // lastFoldSummaryOutcome?.reused === false && 无降级标记 ⇒ "llm"，否则 "statistical"
  strategy,             // strategy?.name ?? "unknown"
  from, to, rounds,     // 折叠区间与轮数
  bytes,                // UTF-8 字节数，供尺寸上界断言
  degradeReason,        // 仅降级时在场（LLM 失败的降级痕迹，同时是「下界锁」的证据）
  fingerprint,          // 与 foldedSummary 事实行同一指纹，便于对账
}
```
**为什么不直接填 `record.summary`**：#470 判据 1 只要求「该轮 record 上出现非空机械摘要/事实键」，不要求占用 `summary`。`summary` 是既有语义（本轮摘要，宿主横幅/#326 归档都读它），覆盖 = 行为变更，且会把「本轮干了什么」与「被折掉的早期历史长什么样」两件事混成一条。⇒ 覆盖留 PR-2 一起拍。

### 落点
1. `src/loop/orchestrator.js:3247-3273`（折叠收尾，`fedSummaryText` / `foldedSummaryFact` 已在作用域内；同段 `:3045` 已有同生命周期的 `let foldedSummaryFact`）→ 新增闭包变量 `pendingFoldedFacts`，在写 `foldedSummary` 事实行的同一处一并填。
2. `src/loop/orchestrator.js:4254` 附近的轮记录对象 → `...(pendingFoldedFacts === undefined ? {} : { foldedFacts: cloneState(pendingFoldedFacts) })`。
3. **C 档（`sliding-window` 真的没产出）**：`src/compact/sliding-window.js:71-85` 结果补一份 `foldedSummaryText`（用现成的 `summarizeFoldedPayload(foldedPayload, {…})`），**只用于落账、不 prepend 进 `compactedMessages`** ⇒ 模型输入零变化、零回归风险。
4. 文档与类型（AGENTS.md 规则 10 的交付清单）：`src/store/file.js:26` / `src/store/memory.js:20` 的 record JSDoc、`docs/host-consumer-contract.md` + `_cn`、`docs/host-upgrade-guide-0.26.0.md` + `_cn`、`CHANGELOG.md [Unreleased]`，然后 `npm run types:build`。
5. resume：`resume-manager.js` **不需要**播种 `foldedFacts`（播种走 `seedFoldSummaries`（`orchestrator.js:1628`）读 `foldedSummary`，已覆盖）；`isEngineFactRow`（`:229-231`）语义逐字不动。

### 尺寸上界（#470-B）
`foldedFacts.text` 由 `formatFoldSummary` 产出，锚点节自带 `maxPerKind`/`maxChars`（`src/compact/anchors.js:23` + clamp），量级 ≤ 2 KiB。断言两件事：**单次 ≤ 声明上限**，且**连续 N 次折叠不随 N 线性增长**（照 #460 那种「连续 8 次」的写法，防 O(n) 在摘要面复发）。⚠ 注意 `foldedFacts` 只挂在**发生折叠的那一轮**，不是每轮都写 ⇒ 天然不累积；这条要在测试里锁住，别写成每轮重复。

### 测试
- `test/loop-persist-compaction-facts.test.js`：配 `context.strategy:"fold-statistical"` 折一轮 ⇒ 轮记录出现 `foldedFacts`，文本含**范围句 + 工具足迹**，`summary` 仍是本轮摘要（不被覆盖）。
- `test/compact/sliding-window.test.js`：`foldedSummaryText` 存在、且**没有**进 `compactedMessages`（逐字不变判据）。
- 下界锁：注入必然失败的 summarizer ⇒ `foldedFacts.kind === "statistical"` 且 `degradeReason` 在场（#470 判据 3 = #469 的合流验收点）。
- `npm run check:tests` / `check:types`（新键必须进 JSDoc，ratchet 基线不得上升）。

---

## PR-2 · #470-A2：`"missing"` 退役（行为变更，建议与宿主同批）

- 落点：`src/loop/resume-manager.js:231 const summary = record.summary ?? "missing"`；种子记录 `:533 summary: "missing"`。
- 改法：真的没有替代物 ⇒ **不写 `summary` 键**，且 `resume-manager` **不为该轮补 `"missing"` 历史条目**。
- ⚠ 风险（必须在 PR 描述里写清）：老账本里大量轮记录正是靠 `"missing"` 进 judge 的轮次历史，条目减少会改变 governor 的 `stalled` 输入 ⇒ 这是**可观察行为变更**，按 AGENTS.md「行为变更默认拒绝、另开单、配逐字不变判据」走，并建议配 opt-in（例如 `transcript?: { strictSummary?: true }`），默认逐字不变。
- 宿主侧配套：erix-station 的 `hasSummary` 判据与契约哨兵可随之删除（那是它为一个占位字面量自建的整套防御）。

---

## PR-3 · #469-④：预算与 5 节合同自洽

**先纠一个容易误判的点**：真机「800 顶格」是**API 侧输出的 `max_tokens`**——`summarizerRequest` 继承 run 的 `maxTokens`（`orchestrator.js:1257`），而 `fold-llm.js:272 maxSummaryTokens = 800` 是**引擎侧的摘要预算**。今天两者恰好同值，所以「5 节只剩 1 节」同时被两把刀削：模型被 API 截断（`finish_reason="length"`），引擎侧就算拿到全文也只留 800。**只改 `maxSummaryTokens` 不会让判据 3 变绿。**

三处一起动：
1. `src/compact/fold-llm.js:272`：默认 `maxSummaryTokens` 800 → **1600**（真机 5 节实测 `completion_tokens=1484`，含留痕规则；显式配置照旧覆盖）。
2. `src/compact/provider-summarizer.js:93-100`：请求里给**摘要专属** `maxTokens`（不再蹭 run 的 `maxTokens`），建议 = `maxSummaryTokens` + 余量。⚠ 这是对 #309「继承宿主 `maxTokens`」先例的改口径，必须在 `host-consumer-contract.md` 记账，并让宿主显式配置优先。
3. `src/compact/enforce-size.js:36`：修剪时**保留节标题骨架**——现在 `result[index] = { …, text: "[已修剪]" }` 把 `## 标题` 一起吃掉，于是「只剩 1 节」。改成保留该 field 的首行标题再写 `[已修剪]`（`fold-llm.js:143-150 priorityForHeading` 已经把 `## 下一步`/`恢复提示` 排到最后被剪，骨架一留就满足 #469-C「优先保下一步与主题词面包屑」的语义）。
   - 附带一条要单独拍的小改：现表里 `主题词` priority=3 比 `已改文件`=2 **更先被剪**；若确实要「优先保主题词」，需调整 `priorityForHeading` 并配测试。

判据：`test/compact/fold-llm.test.js` 用 fake provider 断言 ①请求带摘要专属 `maxTokens`、②默认参数下产出含 5 个 `## ` 标题、③超限时被剪节仍留标题（骨架可见）。

---

## PR-4 · #469-②③①：输入有界 + 结果状态入账 + 专属超时

### ② 输入有界
- 落点：`src/compact/provider-summarizer.js:46-49`（那句 *"Input size is bounded by what was already in context, so no truncation is applied"* 就是缺口本身）+ `serializeFoldedMessages(messages, roundRange)`。
- 改法：新增 `maxSummarizerInputTokens`，**默认值由 orchestrator 侧算**（provider-summarizer 拿不到预算：`budgetTokens` 在 `orchestrator.js:1225-1243` 作用域内），建议 `budgetTokens - summaryBudget - 余量`。超限时从**最旧**侧整条丢弃、保留尾部（最近性），并在开头注一行「前 N 条已省略」。
- 重试一次再降级：`fold-llm.js:336-370` 的 `catch` 里，若错误像超窗 ⇒ 先用裁剪后的输入重试一次，仍失败才落既有 `[fold-llm 摘要失败…]` 降级（不改 #33 D 的降级语义）。
- 事实：`summarizerInputTruncated: true`（进下面的 `compactionStats.foldSummary`）。

### ③ 看结果状态
- `createProviderSummarizer` **返回值必须保持 string**（`fold-llm.js:338-340` 对非 string 抛错，宿主自带 summarizer 也是 string）⇒ 用新增回调带出元数据：`createProviderSummarizer({ chat, onUsage, onMeta })`，`onMeta({ finishReason, inputTokens, outputTokens, estimatedInputTokens })`。
- 入账落点（**勘误：不是新 helper 文件**，见 §6）：`src/compact/pipeline.js` 的 `createCompactionStat`（现有字段 `compacted / foldedRounds / tokensBefore / tokensAfter / layers / protectedDowngraded / userTurnGuard`）新增可选
  `foldSummary?: { finishReason?, degraded?, degradeReason?, degradeKind?, inputTruncated?, inputTokens?, outputTokens?, reused? }`，
  由 `orchestrator.js:3282 recordCompactionStat({…})` 传入 ⇒ `record.compactionStats` 与 `onEvent({type:"compaction"})` 同时可见，**#469 判据 4「成本不隐身」由此闭环**（`engineUsage` 已由 #438 提供 token 面，这里补的是「为什么没拿到摘要」）。

### ① 摘要专属超时（照抄同文件的现成模板）
- **不要**用 run 的 `signal` 做超时（会连坐整轮 run）。`orchestrator.js:2823-2862` 的 judge 拦截调用已经是正确形状：独立 `AbortController` → `request.signal = timeoutController.signal` → 父 signal 转发 → `Promise.race` + `error.code = "judge_intercept_timeout"` → `finally` 清理。新 `summarizerTimeoutMs` 复用这套即可。
- 默认 `undefined` ⇒ 走原 `awaitWithAbort`（`:1259`，它不接时间参数），**不配时逐字不变**。
- 降级原因可区分（今天三者塌成 `fold-llm.js:346` 那条 `slice(0,120)` 字符串）：
```js
degradeKind = err?.code === "summarizer_timeout" ? "timeout"
  : /maximum context length|context_length_exceeded|ContextWindowExceeded/i.test(msg) ? "context_window_exceeded"
  : "error";
```
  分类函数放 `src/compact/fold-llm.js`（或 `helpers.js`），结果写进 `compactionStats.foldSummary.degradeKind`。

---

## 5 判据 → 测试映射

| 判据 | 测试 |
|---|---|
| #470-1 折一轮 ⇒ record 上有非空机械事实（范围句 + 工具足迹） | `test/loop-persist-compaction-facts.test.js`（PR-1） |
| #470-3 下界锁：LLM 必败 ⇒ 机械事实仍在 | 同上，注入失败 summarizer（PR-1） |
| #470-4 尺寸上界 + 不随折叠次数线性增长 | 新用例，连续 5 次折叠比字节数（PR-1） |
| #470-2 缺席语义（不写键、不补 `"missing"`） | `test/loop-resume.test.js` + `test/compact/resume-fold-trim.test.js`（PR-2） |
| #469-3 默认参数 5 节齐全 | `test/compact/fold-llm.test.js`（PR-3） |
| #469-1 限时：不 abort run、折叠照常完成、原因可见 | 新用例：挂起的 fake provider + `summarizerTimeoutMs`（PR-4） |
| #469-2 有界：不再「400 → 静默降级」 | 新用例：超窗 provider 首次抛 400、裁剪后成功（PR-4） |
| #469-4 成本不隐身（3 次折叠的降级原因可对齐） | `compactionStats` 断言，再仿 `scripts/probe-326-compaction-facts.mjs` 补一支折叠摘要事实探针（脚本名以实际新增为准） |

验收命令：`npm test`（全量约 300s）、`npm run check:docs`（新键不进 `host-consumer-contract` 会直接红）、`npm run types:build` + `npm run check:types`、`npm run check:tests`。

---

## 6 勘误（上一份分析里的两处，以本文为准）

1. ⚠ **`src/compact/fold-summary-outcome.js` / `foldSummaryOutcomeForCompact` 在本树不存在**（`ls src/compact` 只有 14 个文件，全仓 grep 零命中）。#469-③ 的正确落点是 `src/compact/pipeline.js` 的 `createCompactionStat` + `orchestrator.js:3282`。
2. 「800 顶格」有**两把刀**（API 的 `max_tokens` 与引擎的 `maxSummaryTokens`），见 PR-3；只改引擎侧默认值不会让 #469 判据 3 变绿。

另一处措辞收窄：#469 说的「唯一阀门是 `signal.abort()`」在**引擎层**成立，但 provider 层不是裸奔——摘要器复用同一个 provider 实例，`src/providers/timeout.js` 的 legacy `timeoutMs` 与 `bin/provider-timeouts.js` 从 idle 派生的相位预算对它同样生效。所以 PR-4-① 的定位是「补摘要专属预算 + 让降级原因可区分」，不是「从零加超时」。

---

## 7 需要拍三件事

1. 新键名：`foldedFacts`（推荐）还是直接填 `summary`（后者是行为变更，需宿主同步）。
2. `maxSummaryTokens` 默认 800 → 1600 是否接受（每次折叠多花约一倍输出 token；真机数据支持这个量级）。
3. `"missing"` 退役放本次 minor，还是等 erix-station 的 `hasSummary` 一起收口（PR-2）。
