# #469 / #470 分析：折叠摘要的「拿不到」与「没落账」

- 基线：`erix-agent` 0.25.0，`HEAD=f489398e`（本仓当前树，行号均在本树复核）
- 来源：宿主 erix-station 真机会话 `9e0c8a17…` 三次折叠的真归档，喂本地 vLLM `qwen3.8-flash-next`（窗口 262 144）
- 两单关系（issue #469 评论已定调）：#469 = 「去调 LLM 也拿不到东西」；#470 = 「不调 LLM 时东西也没落到 `record.summary`」。**本站倾向先做 #470。**

---

## 1 逐条核账（issue 的说法 vs 本树实际）

### #469 四项事实

| # | issue 声称 | 本树复核 | 判定 |
|---|---|---|---|
| ① 无超时口径 | `orchestrator.js` 构造 `summarizerRequest` 只带 `signal` + 继承 `maxTokens`，「这次调用在轮次循环之外」 | `src/loop/orchestrator.js:1254-1258` 确实是 `{...request, signal, ...(maxTokens)}`；`awaitWithAbort`（`:1999`）只做 `Promise.race([promise, abort])`，**无时间参数** | ✅ 成立，但需收窄（见下） |
| ② 输入不设上限 | `provider-summarizer.js` 注释自证「不截断」；`serializeFoldedMessages` 全量序列化 | `src/compact/provider-summarizer.js:46-49` 注释原文即此；`:93-100` 组装请求 = promptGuide + 全量序列化正文，**无任何裁剪**；折叠区间默认 `{from:1,…}`（`fold-llm.js:324`、`fold-statistical.js:534`）⇒ 单次 O(折叠头)、累计 O(n²) | ✅ 成立 |
| ③ 从不看结果状态 | 只判「空字符串」，`finish_reason` 不进任何事实行 | `provider-summarizer.js:110-113` 唯一的异常判据是 `summary === ""`；`fold-llm.js:227-249 enforceSummarySize` 只做预算截断；全仓 `finish_reason`/`stopReason` 在该路径上不出现 | ✅ 成立（与 #419② 同族） |
| ④ 默认预算与 5 节合同不自洽 | `maxSummaryTokens=800` vs 5 节 prompt | `fold-llm.js:272` 默认 800；`:23-40` 的 guide 要求 5 节 + 恢复提示 + 留痕规则；真机 `finish_reason="length"`、800 顶格、只剩 `## 阶段` | ✅ 成立 |

**需要收窄的一处（issue 文案偏严，修的时候别按字面做）**：
「唯一阀门是 `signal.abort()`」在**引擎层**为真，但 provider 层并非裸奔——摘要器复用的是**同一个 `provider.chat/chatStream` 实例**（`orchestrator.js:1260-1263`），因此 `src/providers/timeout.js` / `bin/provider-timeouts.js` 那套 legacy `timeoutMs`（默认 300s）与从 CLI idle 派生的静默相位预算对它**同样生效**。真缺陷不是「完全无超时」，而是三条：
- 引擎侧没有**摘要专属**的预算，只能蹭宿主给主轮次配的那条（300s 量级 ≫ 摘要该有的量级）；
- 超时/abort 一响是**整轮 run 的 signal**，与「折叠可降级」的语义不匹配；
- 降级原因不可区分：`fold-llm.js:345-348` 把 `error.message` 截 120 字符塞进 `degradeReason`，**超时 / 报错 / 超窗三者塌成一条字符串**。

⇒ #469 的真实优先级：**④ > ② > ③ > ①**。（④ 用今天的默认值跑真机就是红的，改动最小；② 是唯一让最大那次折叠彻底拿不到东西的原因；① 是治理面补票。）

### #470 四项事实

| # | issue 声称 | 本树复核 | 判定 |
|---|---|---|---|
| ① 零件齐备 | `formatFoldSummary` / `summarizeFoldedPayload` / `extractAnchors`（带夹取） | `src/compact/fold-statistical.js:284`、`:450`；`src/compact/anchors.js:23 ANCHOR_KINDS=["paths","shas","issues","urls","errors"]`（带 `maxPerKind`/`maxChars`） | ✅ 成立 |
| ② 产物只进消息流 | 统计策略只把摘要 prepend 进 head | `fold-statistical.js:526-545` + `prependSummary`；`sliding-window.js:71-85` 结果里**根本没有 summary 字段**，只有 `navigationRecord` | ✅ 成立 |
| ③ `summarizeFoldedPayload` 折叠路径上唯一调用点在 fold-llm 降级分支 | 全仓调用点：`fold-llm.js:360`（降级分支）+ 定义处 | ✅ 字面成立 | ⚠️ **结论要改**（见下） |
| ④ 账本那格与下游 | `record.summary` 唯一来源是本轮摘要（**写侧 + 投影那格仍成立**）；读侧的 `"missing"` **已由 #477 补平**，不再是本判据的一部分 | `orchestrator.js:4382 summary: roundSummary`；`src/loop/resume-manager.js:235` 现在是 `record.summary === "missing" ? undefined : record.summary`（#477 判据②，提交 `5ad2d78e`）；`:537` 种子记录仍硬编码 `summary:"missing"`；`isEngineFactRow` 守卫（`:229-230`）只挡带 `foldedSummary`/`ttlDegradations` 的行 | ⚠️ **半成立**（写侧成立 / 读侧已补平——本行原先写的是 `record.summary ?? "missing"` ⇒ 已过期） |

**③ 的重要修正（会直接改变 #470 的实现范围）**：机械替代物**并非完全没落账**。`orchestrator.js:3241-3273` 的 #326 wo-C 缝是按**对象身份**取「本次折叠造出来、确实进了请求的那条消息」的正文写 `foldedSummary` 事实行：

- `fold-llm` 降级分支 → prepend 的是 `[fold-llm 摘要失败…]\n` + `summarizeFoldedPayload(...)` ⇒ **机械文本已经进了 `foldedSummary` 事实行**；
- `fold-statistical` → prepend 的是 `formatFoldSummary(...)` ⇒ 同样入账；
- `sliding-window`（库层兜底）→ 只 append stubs，无摘要 ⇒ **这一档真的什么都没有**（即 #470 的 C 档，确实是缺口）。

所以准确表述是：**信息落在 `foldedSummary` 事实行，但没有落到宿主与 judge 真正读的 `record.summary` 那一格**。⇒ #470-A 的主体不是「新增一份机械摘要」，而是「把已有的那份机械文本**同时投影**到 `record.summary` / 新增 `foldedFacts` 键」；真正需要新产出机械文本的只有 `sliding-window`。

---

## 2 根因（两单是同一处切面的两面）

折叠产物有**三个消费面**：模型上下文（`compactedMessages`）、引擎账本（轮记录）、宿主展示（横幅）。代码只在第一个面上做了工作：

1. **产出侧只喂模型**：`prependSummary` 把摘要塞进 head，账本那格（`record.summary`）语义是「本轮自身摘要」，二者从未打通。
2. **缺省写占位字面量**：`?? "missing"` 与 `summary:"missing"` 让下游必须反向猜「这是占位串还是真摘要」，宿主为此自建 `hasSummary` + 契约哨兵（erix-station #390）。
3. **调用侧无边界**：输入不设上限（②）、默认预算配不上自家 prompt（④）、结果状态不看（③）、降级原因不可区分（①）——四条共同导致「越需要摘要的大折叠越拿不到摘要，且失败静默」。

真机形状（同一条会话三次折叠，`tokensSaved` 188 510 / 248 767 / 327 720，区间都从 `from:1` 起）：
前两次拿到 1/5 节（`finish_reason="length"`，39.9s），第三次 `261 345 > 262 144` 直接 `ContextWindowExceededError`（400，7.4s 白费）⇒ 最需要摘要的那次拿不到；而宿主端只看得见 `foldLlm.triggered` + 一条降级痕迹。
同一包真数据用现成零件零 LLM 现算 = **743 字符 / 849 字节**（范围句 + 工具足迹 + 锚点索引），对 550 KB 归档是两个数量级的代价差。

---

## 3 修复建议

### #470（建议先做：纯加法、零 LLM、零行为回归面）

- **A1 投影而非重造**：在 `orchestrator.js` 折叠收尾处，把本轮 `foldedSummaryFact.text`（缺 `sliding-window` 时另由 `summarizeFoldedPayload` 现算）**同时**写入轮记录：新增 `foldedFacts`（推荐，形状自选）或按「LLM 摘要在场则不覆盖」的规则填 `summary`。保留 `foldSummaryLedger` 的按指纹去重，避免重复折叠重复入账。
- **A2 缺省语义**：`summary` 无真摘要时**不写该键**（而非 `"missing"`）；`resume-manager.js:231` 相应改为「缺键 ⇒ 不为该轮生成历史条目」，`:533` 种子记录同批处理。`isEngineFactRow` 守卫语义逐字不动（判据 2）。
- **B 尺寸上界**：机械摘要走 `extractAnchors` 现成的 `maxPerKind`/`maxChars`，声明 ≤ 2 KiB，并断言**不随折叠次数线性增长**（防 #460 的 O(n) 在摘要面复发；与 #335 重复存储同族）。
- **C（可拆）**：`sliding-window` 也产这份摘要——这是唯一需要新增产出的部分。
- 风险点：`record.summary` 形状变化会影响已有宿主；建议优先走**新增键**，把「`"missing"` 退役」留作后续可拍的行为变更。

### #469（按 ④→②→③→① 拆，四条可分别拍）

- **④ 预算自洽**（最小红）：默认 `maxSummaryTokens` 与 5 节合同对齐（上调默认值），或截断时**按节保留骨架**，优先保 `## 下一步` 与 `## 主题词面包屑`（续跑与检索真正要用的两节）。
- **② 输入有界**：新增 `maxSummarizerInputTokens`（默认 ≈ 窗口 − 输出预算 − 余量）；超限先用现成零件（`extractAnchors` / 最近性截断）**裁一次重试**，仍不行才走 #33 D 降级并记 `summarizerInputTruncated`。落点：`provider-summarizer.js:46-49`（注释即缺口）。这是 #460 写侧修完之后，读侧/调用侧的同一件事。
- **③ 看结果**：`finish_reason` 与截断事实写进 `compactionStats` / 摘要事实行（记账面已由 #438 `engineUsage` 够用，缺的是可区分性）。
- **① 限时**：`summarizerRequest` 支持摘要专属超时（**不要**复用整轮 `signal`），超时走既有降级并单独记 `reason:"timeout"`；判据「不配时行为逐字不变」要求这是纯加法。落点：`orchestrator.js:1254-1258` + `awaitWithAbort` 的调用形态（它现在不接超时参数）。

### 判据自检

#469 判据 3（默认参数下一次折叠 5 节齐全）**今天的默认值跑真机就是红的**——建议先落 ④ 把它转绿，再落 ②/③/①；#470 判据 1/2/3/4 与上面 A1/A2/B/C 一一对应，判据 3（注入必然失败的 summarizer ⇒ 机械事实仍在账上）恰好也是 #469 与 #470 的合流验收点。

---

## 4 结论

- 两单的**事实面基本可复核**（行号在本树全部对得上，个别 ±1~4 行漂移）。
- 两处需要修正认知：#469 的「唯一阀门是 abort」在 provider 层偏严（legacy `timeoutMs` 与 idle 派生相位对它同样生效，真缺陷是**无专属预算 + 降级原因不可区分**）；#470 的「不调 LLM 就完全没有摘要落账」在 `fold-llm` 降级 / `fold-statistical` 两档**不成立**（机械文本已在 `foldedSummary` 事实行，缺的是投影到 `record.summary` 那一格），真缺口只有 `sliding-window` 一档。
- 落地顺序：**#470-A1/A2/B（加法、零 LLM）→ #469④ → #469②③ → #469①**。
- 关联：#167（fold-llm 去留，本实测是它唯一消费者的负载形状）、#419②（不看 stopReason 同族）、#33 D（降级语义）、#309（继承宿主 `maxTokens` 先例）、#460/#462（写侧/读侧裁剪）、#438（`engineUsage` 记账已够）、#121（锚点零件）、#326（引擎事实入账链）、#335（重复存储）；宿主侧 erix-station #390 / #392。
