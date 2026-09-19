# erix-agent 上下文 / 记忆机制改进方案

- 状态：**待评审**
- 日期：2026-09-17
- 依据：[`docs/harness-comparison/`](../harness-comparison/README.md)（pi / touwaka / codex / hermes 五方代码级对比）
- 关联：ADR-005（工具契约）、ADR-007（记忆架构）、ADR-009（安全分层）、ADR-012（引擎真相/宿主策略）、**ADR-015（上下文卫生引擎化，在飞）**、issue #115
- 基线：`0c309e6`（v0.5.1，ADR-015 Phase1–3 已落），工作树有 Phase4a/4b 未提交改动

---

## 0. TL;DR

1. 本项目「折叠即可字节保真召回」的闭环是**五方对比里最好的**（引擎标配 recall + stub 内嵌配方 + 四路语料 + marker 合并），**这条主线不要动**。
2. 真正的缺口只有两个，且都是「事后无法补救」型：**① 单轮内多条工具输出没有聚合预算**（一次并行 10 个大输出即可顶穿窗口）；**② 折叠摘要里没有任何「未经模型改写」的精确标识**（PR/SHA/路径/错误串全靠模型复述）。
3. 三个「低成本高杠杆」的补充：折叠模板的**防退化规则**（取消信号 / 禁改写标识 / 未决风险单列）、**折叠摘要落点可选**（为 prompt 前缀缓存让路，opt-in）、**契约文档修正**（220 vs 1200 字符已漂移）。
4. 长期记忆在本项目**明确不做**（ADR-009 单用户信任域），若产品需要必须另立 ADR，不能塞进 0.6 线。
5. 建议节奏：**Phase A（0.6.0）→ Phase B（0.7.0）→ Phase C（另立 ADR）**；A 全部落地后跑三个验收实验（§8），其中「精确值召回率」是唯一能证明本项目核心卖点的实验。

---

## 1. 前提与边界

| 前提 | 含义 |
|---|---|
| **ADR-015 在飞** | Phase4a/4b（ResourceStore 模型侧退役、提示词收口）未提交。**A/B 任何改动都必须在 Phase4b 合入之后再开始**，否则 `checkpoint-executor.js` / `bin/tools.js` 会冲突 |
| 零依赖、纯 ESM、Node 22+ | 新增能力不得引入 npm 依赖（无 tantivy、无 BM25 库；检索只能自研或复用 store） |
| 引擎不拥有工具面 | 引擎能凭空造的只有「自己存过什么」与「怎么取回」；给模型的新工具必须走 `createRecallTool` 同款路径（引擎能力自持） |
| 宿主契约优先 | 任何 `runToolLoop` 选项 / stub 文案 / 摘要格式变化都要写进 `docs/host-consumer-contract.md` 并升 minor |
| ADR-009 | 不做安全/权限/审批；不引入沙箱 |
| 语言分层 | 先做**引擎层**能力（可被所有宿主复用），宿主层（CLI/REPL）只做默认值与提示词 |

**本方案不做**：向量检索、知识图谱、embedding、工具搜索（BM25）、子进程技能隔离、审批 UI、多租户。理由见 §11。

---

## 2. 现状盘点

| 维度 | 现状 | 缺口（对比结论） | 优先级 |
|---|---|---|---|
| 上下文构造 | 引擎不拼 prompt（宿主全权）；折叠发生轮注入 run-state（marker upsert） | 无片段类型体系（codex `ContentItemKind`）；折叠原地改写历史，前缀缓存全灭（hermes/codex 的做法） | P1（B1/B3） |
| 工具输出截断 | 四道闸门：CLI 4096 → 引擎 `outputHygiene` 4096（全量入档 + stub + recall 配方）→ recall 段预算 → store 游标 | **无单轮聚合预算**（hermes 有 `clamp(30%×窗口,16k,200k)`）；无同调用去重（hermes） | **P0（A1）** |
| 折叠与召回 | 统计折叠（零 LLM）/ LLM 折叠（5 节模板）；`keepRounds=6` + 真实 user 保护；marker 合并防堆叠；recall 三级渐进 + 四路语料 | 摘要里**没有不经 LLM 的精确标识层**（hermes 正则锚点）；模板缺取消信号与「未决风险」；固定 4096 阈值不随窗口缩放（次要） | **P0（A2/A3）** |
| 技能与工具 | 脚本自描述 + 全量注入；MCP 单代理工具（1 schema） | 无工具面 token 计量（cx 有 `ToolExposure` 预算、hermes 有清单预算） | P2（B4） |
| per-user 记忆 | 无跨 session；notes 为 run 作用域 | 与 tw/cx/hm 差距最大的一维 | 不做（C1 另立 ADR） |
| 文档 | — | `host-consumer-contract.md` 仍写 semantic 220 字符 / run-state 400 字符，代码已是 1200 | **P0（A0）** |

---

## 3. 方案总览

| ID | 名称 | 层 | 类型 | 优先级 | 依赖 | 规模 |
|---|---|---|---|---|---|---|
| A0 | 契约文档与代码对齐（semantic 1200 / run-state 渲染） | 文档 | 修正 | P0 | 无 | S |
| **A1** | **单轮聚合输出预算** | 引擎 | 新选项（默认开） | **P0** | Phase4b | M |
| **A2** | **精确锚点索引（不经 LLM）** | 引擎 | 行为变更（摘要内容） | **P0** | Phase4b | M |
| A3 | 折叠模板防退化规则（取消信号 / 禁改写 / 未决风险） | 引擎 | 行为变更（模板） | P0 | A2 | S |
| B1 | `origin` 片段类型判定收敛（重构，无行为变更） | 引擎 | 重构 | P2 | A2 | M |
| B2 | 同轮相同调用结果去重（opt-in） | 引擎 | 新选项（默认关） | P1 | A1 | S |
| **B3** | **折叠摘要落点可选 `boundary`（缓存友好，opt-in）** | 引擎 | 新选项（默认关） | P1 | A2 | M |
| B4 | 工具面 token 计量与告警 | 引擎 | 新诊断字段 | P2 | 无 | S |
| C1 | 跨 session 长期记忆 | — | **另立 ADR** | 不做 | — | — |
| C2 | 验收实验（精确值召回率等 3 个场景） | 测试 | 新增 | P0 | A1/A2 | S |

规模：S ≈ 单文件 + 单测；M ≈ 2–4 文件 + 单测 + 契约文档。

---

## 4. Phase A（目标版本 0.6.0）

### A0 契约文档与代码对齐

**问题**：`docs/host-consumer-contract.md:437` 写「semantic source text at 220 characters」，代码是 1200（`src/run-state.js:87`）；同段说 rendered block 上限 400（`src/run-state.js:3` 确为 400），但 semantic 多行渲染另有 16 行上限（`src/run-state.js:88`、`:350`），文档未提。

**方案**：修 §Run state 段：220 → 1200、补 16 行渲染上限、补「semantic 承载宿主目录（如 notes 小抄）」的用途说明。`220` 在文档里出现多次（`07-takeaways` 亦引用），一并核。

**验收**：`grep -n "220" docs/host-consumer-contract.md` 无残留；文档描述与 `src/run-state.js:3,87,88` 一致。
**规模**：S（纯文档）。

---

### A1 单轮聚合输出预算 🔴

**问题**：`outputHygiene.limit`（默认 4096 字符）是**逐条**上限。一轮里 10 个工具各返回 4000 字符即可注入 4 万字符（≈1.5–2 万 token），远超单轮合理占比；当前只能靠**下一轮**折叠兜底，而这一轮已经付出了一次超长请求的代价（甚至可能直接触发 provider 溢出）。

**方案**：在引擎侧增加「本轮所有工具输出合计」预算，与逐条阈值**串联**：

```
逐条：content.length > limit            → 归档 + stub（现有逻辑，含 ADR-015 全文入档）
聚合：roundTokens + estimateTokens(new) > turnBudgetTokens → 归档 + stub（新增）
```

判定用**到达顺序的增量累计**（不是「从大到小重排」）：

- 优点：stub 在写入 round record 之前就已决定，checkpoint / resume 语义完全不变（不需要回写已 checkpoint 的 tool_result）。
- 缺点：不是全局最优（后到的小结果可能被截，而先到的大结果保留）。**明示这一取舍**，把「按大小重排」列为后续优化（需要推迟 checkpoint，风险大，不建议现在做）。

**接口**（`runToolLoop` 选项，additive）：

```js
outputHygiene: {
  limit: 4096,                 // 现有：逐条字符上限
  turnBudgetTokens: 12000,     // 新增：可选，本轮工具输出合计 token 上限
  turnBudgetRatio: 0.25,       // 新增：未显式给 turnBudgetTokens 时 = 0.25 × budgetTokens
  turnBudgetMin: 4000,         // 新增：夹取下限（token）
  turnBudgetMax: 40000,        // 新增：夹取上限（token）
}
```

- 默认**开启**聚合预算（与 `outputHygiene` 本身一样，仅在 store 可用时生效）；`turnBudgetTokens: 0` 或 `turnBudgetRatio: 0` 表示关闭该层。
- 有效值 = `clamp(turnBudgetTokens ?? turnBudgetRatio × budgetTokens, turnBudgetMin, turnBudgetMax)`，其中 `budgetTokens` 是引擎已算出的 `computeBudget()` 结果（`src/compact/budget.js`）。**不引入新的窗口来源**。
- 校验：三个新字段必须是 `Number.isSafeInteger` 或有限正数；非法值抛 `TypeError`（与现有 `outputHygiene.limit` 一致）。

**落点**

| 文件 | 改动 |
|---|---|
| `src/loop/orchestrator.js:496-513` | 解析 / 校验新字段，算 `turnBudgetTokens`，传给 checkpoint ctx |
| `src/loop/checkpoint-executor.js:148-164` | 在现有逐条判定之后追加聚合判定；维护 `ctx.roundOutputTokens`（每轮开始时归零） |
| `src/loop/orchestrator.js:1293` | round record 的 `toolOutputs` 已按 round 过滤，无需改；新增 `roundOutputBudgetApplied` 计数进 diagnostics |
| `docs/host-consumer-contract.md` | 新增 `outputHygiene.turnBudget*` 说明 + stub 文本不变（**重要**：stub 文案保持唯一格式，原因靠 metadata 区分） |

**stub 文案**：保持现有唯一格式
`[完整输出已由引擎归档（第 N 轮，共 M 字符）。需要原文：recall({ round: N, pattern: "关键词" })；不要重跑有副作用的命令]`
原因（逐条 / 聚合）写进归档条目的 `metadata.reason`，不进模型视野——避免模型学会「区分两种截断」这种无价值信息。

**测试**（`test/output-hygiene.test.js` 扩展）

1. 单轮 3 个各 5000 字符结果、`turnBudgetTokens: 2000` → 只保留第 1 个，后 2 个 stub；3 条全部在 `toolOutputs` 里可 recall。
2. `turnBudgetTokens` 极大 → 逐条阈值独立生效（回归）。
3. resume：从 checkpoint 恢复后 stub 与全文仍然对应（复用现有 resume 断言风格）。
4. 边界：`turnBudgetTokens` 小于单个 stub 长度 → 不得死循环、不得丢结果（保留 stub，总数不再收缩）。

**风险**：低。默认值不会让任何现有测试变化（现有测试多用单工具或小输出）；唯一行为变化是「密集工具轮会被更早归档」，这正是目的。
**验收**：新增 4 条测试全绿；`npm test` 全绿；契约文档已更新。

---

### A2 精确锚点索引（不经 LLM） 🔴

**问题**：折叠摘要完全由「轮次范围 + 工具足迹 + 模型写的散文」构成。被折轮次里的 **PR 号 / commit SHA / 文件路径 / URL / 错误串** 只能靠模型复述——而 LLM 改写在标识符上必然有损耗（hermes 用正则机械抽取正面解决了这一点）。这些标识符正是 `recall({pattern})` 最好的搜索关键词。

**方案**：新增引擎模块 `src/compact/anchors.js`，从**工具结果 + 真实 user 消息**（不看 assistant 散文，降误报）中确定性抽取五类锚点，去重、限条数、限总量后，作为**独立一节**追加到折叠摘要尾部，且**在尺寸截断之后**追加（保证锚点不会被摘要预算吃掉）。

**接口**

```js
// src/compact/anchors.js
export function extractAnchors(messages, {
  maxPerKind = 12,     // 每类上限
  maxChars = 1200,     // 锚点节总字符上限
} = {}): { text: string, byKind: { paths, shas, issues, urls, errors } }
```

抽取规则（全部为正则，零 LLM，可单测）：

| 类型 | 规则要点 | 上限 |
|---|---|---|
| `path` | 至少含一个 `/`、无空格的 `a/b.c` 形态（含相对/绝对），排除 URL | 12 |
| `sha` | `\b[0-9a-f]{7,40}\b` 且**同时含数字与字母**（滤纯数字噪声，如行号） | 8 |
| `issue` | `#\d{1,6}` | 8 |
| `url` | `https?://…` | 8 |
| `error` | 行首/句中含 `Error\|Exception\|Traceback\|fatal:` 的行，取前 120 字符 | 5 |

**渲染**（固定格式，便于 parse/merge）：

```
## 精确锚点（原文抽取，未经模型改写）
paths: a/b.ts, c/d.py, …
shas: 1ed3f35, 0c309e6
issues: #115, #109
urls: https://…
errors: TypeError: xxx | ENOENT: no such file
```

**落点**

| 文件 | 改动 |
|---|---|
| `src/compact/anchors.js` | 新增（约 120 行） |
| `src/compact/fold-statistical.js:159-226,281-350` | ① `formatFoldSummary` 增加 `anchors` 参数；② `parseFoldSummary` 解析锚点节；③ `mergedFoldSummaryContent` 合并时按 kind **并集去重**（新增项在后）并重新夹取上限 |
| `src/compact/fold-llm.js:187-198,214-303` | 在 `enforceSummarySize()` **之后**追加锚点节；预算 = `maxSummaryTokens + anchorTokens`（锚点预算默认 400 token） |
| `src/compact/helpers.js` | `foldOptions` 透传 `anchors: false \| { maxPerKind, maxChars }` |
| `docs/host-consumer-contract.md` | 摘要格式新增固定节的说明 |

**为什么必须做「parse + merge」**：连续折叠时摘要会被重新格式化（`mergedFoldSummaryContent`）。若不把锚点作为结构化字段参与合并，第二次折叠就会丢掉第一次的锚点——这正是 0.5.1 修复过的同类缺陷。

**测试**（新增 `test/compact/anchors.test.js` + 扩展 `fold-statistical.test.js` / `fold-llm.test.js`）

1. 抽取：五类各命中；纯数字 7 位不被当 SHA；URL 不被当路径；散文里的「大致是这样」不上钩。
2. 上限：超量时按「首次出现」截断，总字符 ≤ maxChars。
3. 尺寸交互：`maxSummaryTokens` 极小（如 50）时，摘要被削但锚点节完整保留。
4. 多次折叠：折叠 3 次后锚点并集正确、无重复、不超限（**关键回归**）。
5. `anchors: false` 时行为与 0.5.1 完全一致（向后兼容）。
6. 端到端：锚点里的 SHA 用 `recall({ pattern: "<sha>" })` 能命中（复用 `test/integration/memento-scenario.test.js` 风格，断言打到 provider 请求负载）。

**风险**：中。误报（把普通单词当路径）会污染摘要。缓解：严格规则 + 只扫工具结果与真实 user 消息 + 上限 + 可通过 `anchors: false` 关闭。
**验收**：上述 6 组测试全绿；人工检查一个真实 run 的锚点节，误报 ≤1 条。

---

### A3 折叠模板防退化规则

**问题**：`fold-llm` 的 5 节模板（阶段 / 已改文件 / 已验证项 / 下一步 / 主题词面包屑）有三个已知退化点没有防护：
① 用户中途取消/撤销的任务，仍留在「下一步」；
② 模型改写 PR 号 / SHA / 路径 / 错误串（A2 用正则兜底，但模板应明确禁止重复劳动）；
③ 未决风险（如「这个改动可能破坏 X」「没能验证 Y」）无处安放，会被压缩掉。

**方案**（`src/compact/fold-llm.js:15-32` 的 `createSummarizerPromptGuide`）：

1. 新增一节 `## 未决风险`（写：尚未验证的假设、已知可能出错点、被跳过的检查；没有则写「无」）。
2. 新增两条强制规则：
   - 「**禁止改写**标识符（PR 号 / commit SHA / 文件路径 / 错误串 / 命令）——原样抄写；引擎会另行追加机器抽取的锚点清单，你不需要翻译它们。」
   - 「若被折轮次内用户明确取消、撤销或否定过某个任务（stop / undo / 不用了 / 取消 / never mind），必须从『下一步』移除，并在『未决风险』记录该取消事实。」
3. `priorityForHeading`（`fold-llm.js:100-108`）补 `未决风险 → 1`（与「已验证项」同级，只在压力大时才削）。

**关于「用户最新未解决输入」字段的取舍**：对比文档（`07` P0#3）建议加这个字段，但本项目默认 `protectedMessage: isRealUser`（`bin/config.js:131,143`）——`selectFoldedRounds`（`src/compact/helpers.js:54-73`）**整轮跳过含受保护消息的轮次**，因此真实 user 消息在默认配置下**几乎不会被折**。加一个常态为空的字段是负收益；改为在保护被降级（`protectedDowngraded`）时才需要，故本条以「取消信号规则」覆盖同一风险，不新增字段。

**落点**：`src/compact/fold-llm.js`（模板 + 优先级映射）、`src/compact/helpers.js`（`DEFAULT_RECOVERY_HINT` 文案核对）。
**测试**：`test/compact/fold-llm.test.js` 增加：① 模板包含新节与两条规则；② `maxSummaryTokens` 紧张时「未决风险」不被优先削；③ 已有快照/断言同步更新。
**风险**：低（纯提示词）。**注意**：这是**行为变更**，进 CHANGELOG 的 Changed。

---

## 5. Phase B（目标版本 0.7.0）

### B1 `origin` 片段类型判定收敛（重构，无行为变更）

**问题**：现在判断「这是什么消息」散落四处：`isRealUser`（`src/compact/helpers.js:46`）、`isProtectedMessage`（`:39`）、stub 解析（`resolveFoldStubs`，`:115`）、run-state 定位（`src/run-state.js:376-431`，靠 marker 正则）。四处各自维护 marker 知识，新增一种引擎注入（如 A2 的锚点节、B3 的边界摘要）就要改四处。

**方案**：新增 `src/messages/origin.js`，把 marker 知识集中：

```js
export const ORIGIN = {
  USER: "user",              // 真实用户消息
  TOOL_RESULTS: "tool-results",
  ENGINE_RUN_STATE: "engine-run-state",
  ENGINE_FOLD_SUMMARY: "engine-fold-summary",
  ENGINE_NOTICE: "engine-notice",   // stub / 归档公告等
  MIXED: "mixed",                    // 真实用户文本 + 引擎摘要共存（当前默认折叠形态）
};
export function originOf(message);           // 结构化判定，不抛错
export function isRealUserContent(message);  // 替代 isRealUser
```

- **不新增消息字段**：消息直接进 provider payload，加未知字段有泄漏风险；一律用**文本 marker**（已存在的 `FOLD_SUMMARY_MARKER` / `DETERMINISTIC_MARKER` / `SEMANTIC_MARKER`）判定，天然穿透持久化与 resume。
- 现有调用点改为委托（`isRealUser` 保留为薄封装，避免破坏导出契约）。

**落点**：`src/messages/origin.js`（新增）、`src/compact/helpers.js`、`src/compact/fold-statistical.js`、`src/run-state.js`。
**测试**：`test/messages/origin.test.js`；现有 fold/run-state 测试全绿即证明无行为变更（这是本项的验收标准）。
**价值**：为 B3 与未来的 C1 提供「哪里可以放引擎文本」的单一事实源；把「MIXED 消息」这一现状显式化（当前折叠摘要与真实用户文本确实共存于一条消息，`isRealUser` 因此返回 true——这是既有行为，重构后必须保持）。

### B2 同轮相同调用结果去重（opt-in，默认关）

**问题**：模型在同一轮里重复发完全相同的调用（同工具 + 同参数）是常见模式，第二次的结果与第一次逐字节相同，纯属浪费。

**方案**（保守，默认关闭）：

- 新选项 `dedupeIdenticalToolCalls: false`（默认）。
- 开启后：本轮内 `toolName + canonical JSON(input)` 相同，**仍然执行**（不改变副作用语义），但第二次起的结果替换为：
  `[与第 N 轮 <tool> 的相同调用结果一致，完整输出见 recall({ round: N, pattern: "关键词" })]`（若首次结果已归档）或 `[与本次第 N 次调用结果一致，见上方 tool_result]`（未归档）。
- **硬约束**：仅当宿主在 `executeTool` 的 metadata 里显式声明 `replayable: true` 时才去重；`replayable === false` 或未声明一律不去重（避免把「相同输入、不同输出」的工具误判）。
- 计数进 diagnostics（`dedupedToolCalls`）。

**落点**：`src/loop/checkpoint-executor.js`（轮内 Map + 替换）、`src/loop/orchestrator.js`（选项校验与透传）。
**测试**：`test/output-hygiene.test.js` 或新 `test/tool-dedupe.test.js`：① 默认关，行为不变；② 开启 + `replayable:true` → 第二次变 stub 且首次归档可 recall；③ 开启但 `replayable` 缺失 → 不去重（**关键安全断言**）；④ 相同工具不同参数 → 不去重。
**风险**：低（默认关 + 双门禁）。**价值**：中等，主要针对「模型重复查询」这一高频浪费。

### B3 折叠摘要落点可选 `boundary`（缓存友好，opt-in）🔶

**问题**：当前折叠把摘要**合并进最早的真实 user 消息**（`src/compact/fold-statistical.js:358-403` 的 `prependSummary`）。这意味着**每一次折叠都改写历史最前端**，system prompt 之后的所有 token 前缀全部失效——任何 provider 侧 prompt cache 在折叠轮全灭（对比文档 §1.4 的分水岭）。

**方案**：新增 `context.strategy` 折叠选项 `summaryPlacement: "head"（默认，现状）| "boundary"`：

- `boundary`：摘要作为**独立消息**插在「保留窗口的第一轮」之前，而不是合并进最早的真实 user 消息；run-state 块也使用同一条边界消息承载（`upsertRunStateInMessages` 已经是「找折叠摘要所在消息」，改后自然落到边界消息）。
- 效果：折叠点**之前**的历史字节不变 → 缓存只需从折叠边界之后重算，而不是从 system prompt 末尾重算。
- 代价：摘要不再挨着最初的任务描述；需要在契约文档说明两种落点的语义差异。默认保持 `head`，**0.5.x 行为不变**。

**落点**：`src/compact/fold-statistical.js`（`prependSummary` / `mergedFoldSummaryContent` 分支）、`src/compact/fold-llm.js`（装配分支）、`src/loop/orchestrator.js`（透传 `summaryPlacement` 到 strategy）、`src/run-state.js`（确认定位逻辑对独立消息形态成立）。
**测试**（**验收标准是字节稳定性**）：

1. 连续折叠两次，断言 `messages` 中「折叠边界之前的全部条目序列化结果」两次完全一致（这是本项存在的唯一理由）。
2. `head`（默认）行为与 0.5.1 逐字节一致（回归保护）。
3. `boundary` 下 resume 正常、`recall` 水位线正确、run-state 不重复。
4. `foldedThrough` / `firstKept` 语义在两种落点下一致。

**风险**：中。`boundary` 改变了「摘要与用户任务同处一条消息」的既有结构，需要确认下游没有依赖该结构（`run-state.js:376-431` 的回落分支「含『上下文折叠』的首个 user 文本块前插入」正是强耦合点，实现时要一并处理）。

### B4 工具面 token 计量与告警

**问题**：本地工具/skill 全量注入且**没有任何计量**；工具变多时成本线性上涨且不可见。

**方案**：纯观测，不改行为。引擎在每轮请求前把 `estimateTokens(JSON.stringify(providerTools))` 写入 `diagnostics.toolsTokenEstimate`；若宿主传入 `toolsBudgetTokens` 且超限，通过 `onEvent`（或新增 `diagnostics.toolsBudgetExceeded: true`）告警一次。**不裁剪工具**（裁剪是宿主策略）。

**落点**：`src/loop/orchestrator.js`（计算 + diagnostics）、`docs/host-consumer-contract.md`（诊断字段）。
**测试**：`test/loop.test.js` 或新用例：diagnostics 字段存在且随工具数单调增长；超限标志置位。
**风险**：极低。

---

## 6. Phase C

### C1 跨 session 长期记忆 —— 建议**另立 ADR**，不塞进 0.6/0.7

**结论**：本项目定位是「本地单用户信任域的无头 agent」（ADR-009），长期记忆是**产品决策**而不是技术补课。若产品确实需要，建议单独立 ADR，方向（取自对比结论，不做实现承诺）：

| 决策点 | 建议 | 依据 |
|---|---|---|
| 载体 | **可读文本文件**（`~/.erix/memory/<scope>/<key>.md`），不用向量库 | cx / hm / pi 三家默认都不是向量；可审计、可手改、可 git 回滚 |
| 写入 | **冷路径**：复用现有 `completeRun` + janitor 时机做整理，主循环零写工具 | ADR-007 已定；hm（后台 fork）/ cx（两阶段流水线）同向 |
| 注入 | 只在**折叠发生时**注入有界摘要（与 notes 目录同一缝），不每轮注入 | hm 的冻结快照思路；避免缓存击穿 |
| 隔离 | 先做 `profile = 目录`（`ERIX_MEMORY_DIR`），per-user 字段级隔离不做 | tw 是唯一做了字段隔离的，但其画像「存而不用」；hm 把它交给外部 provider |
| 检索 | 关键字 + 文件枚举，与 recall 同构；**不引入 embedding** | 零依赖红线 |

**明确不做**：向量检索、知识图谱、自动实体消解、多用户共享/隔离。

### C2 验收实验（必须做，成本很低）

见 §8。

---

## 7. 契约与版本策略

| 版本 | 内容 | 语义化版本理由 |
|---|---|---|
| 0.6.0 | A0–A3 | A1 新增选项（additive）；**A2/A3 改变折叠摘要内容与模板（宿主可见行为变更）** → minor |
| 0.6.x | 缺陷修复 | |
| 0.7.0 | B1–B4 | B2/B3 新增默认关闭选项；B1 重构（无行为变更）；B4 新增诊断字段 → minor |
| 0.8.0 / v2 | C1（若批准） | 新能力域，需 ADR |

**契约文档更新清单**（`docs/host-consumer-contract.md`）：

1. §`runToolLoop` options：新增 `outputHygiene.turnBudget*`、`dedupeIdenticalToolCalls`、`toolsBudgetTokens`。
2. §Bounded recall：说明「聚合预算归档的输出同样进 `toolOutputs` 语料」（不新增通道）。
3. §Run state：修正 220 → 1200，补 16 行渲染上限（A0）。
4. 新增小节「折叠摘要结构」：固定节清单（含 A2 的锚点节）、marker 语义、`summaryPlacement` 两种落点。
5. CHANGELOG：`### Added` / `### Changed`（A2/A3 必须显式说明「折叠摘要新增固定节，消费方若做摘要结构断言需同步」）。

---

## 8. 测试与验收

### 8.1 每项的测试落点

| ID | 测试文件 | 关键断言 |
|---|---|---|
| A1 | `test/output-hygiene.test.js` | 聚合超限后只留前若干条 + 全部可 recall；resume 一致；不死循环 |
| A2 | `test/compact/anchors.test.js` | 五类抽取 / 误报 / 上限 / 尺寸交互 / **三次折叠并集** |
| A3 | `test/compact/fold-llm.test.js` | 新节存在；优先级正确；快照更新 |
| B1 | `test/messages/origin.test.js` | 各类消息判定；MIXED 形态保持既有语义 |
| B2 | `test/tool-dedupe.test.js` | 默认关；双门禁；参数不同不去重 |
| B3 | `test/compact/fold-boundary.test.js` | **边界前字节稳定**；head 回归；resume / 水位线一致 |
| B4 | `test/loop.test.js` | diagnostics 字段与超限标志 |
| A0 | — | `grep 220` 无残留 |

### 8.2 端到端验收实验（建议全部落地为 `test/integration/` 场景或 erix-bench 场景）

1. **精确值召回率（最重要）**：构造 40+ 轮任务，在第 5 轮的工具输出里埋入随机 token（如 `VALUE-7f3a9c`）；第 35 轮提问该值。三组对照：`默认（有 recall + 锚点）` / `recall:false` / `不折叠（基线）`。指标 = 命中率、总 token、轮数、recall 调用次数。
   → 这是唯一能证明本项目核心卖点的实验，**A2 上线后必须补**。
2. **聚合预算的收益**：单轮 10 个各 4000 字符的工具输出，比较开启/关闭 A1 时的「请求 payload 峰值 token」与「是否触发 provider 溢出」。
3. **缓存友好折叠的收益**：连续折叠 2 次，比较 `head` / `boundary` 两种落点下「折叠边界之前的字节变化量」（离线断言，不需要真实 provider 计费）。

### 8.3 回归门

- `npm test` 全绿（含 `test/contract/*` 双实现契约）。
- `node bin/cli.js chat` 在真实任务上跑通一次含折叠的长任务，`~/.erix/transcripts/outputs/<runId>/judge.log` 无异常。
- ADR-015 §三 的野外复测（命令密集型任务，回填 recall 使用率 + auto-capture 触发率）与 A 阶段改动合并执行，**复用同一次野外测试的数据**。

---

## 9. 排期建议

```
Phase 4b（在飞，必须先行）
   └─ A0（文档，可并行）
        └─ A1  ──┐
        └─ A2  ──┼─→ A3 ─→ 验收实验 1/2 ─→ 0.6.0 发布门（含 ADR-015 野外复测）
                 │
        B2 ──────┘（依赖 A1 的聚合计数）
        └─ B3（依赖 A2 的锚点节结构）
        └─ B1（依赖 A2 落地后收敛 marker 知识）
        └─ B4（独立，可随时做）
                  └─→ 验收实验 3 ─→ 0.7.0
C1：另立 ADR（不在本方案排期内）
```

**建议派单顺序**：A0 → A1 → A2 → A3 →（0.6.0）→ B4 → B2 → B3 → B1 →（0.7.0）。
每项独立可验收、可单独 PR；A1/A2 是小步快跑的首选，B3 风险最高应放最后。

---

## 10. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| A2 锚点误报污染摘要 | 摘要噪声、模型被无关路径带偏 | 严格正则 + 只扫工具结果/真实 user 消息 + 条数与字符双上限 + `anchors:false` 一键关闭；上线后人工抽查一个真实 run |
| A1 增量顺序非最优 | 后到的小结果被截，先到的大结果留存 | 明示取舍；如需最优需推迟 checkpoint（风险更大），列为后续优化 |
| B3 改变摘要落点语义 | 下游依赖「摘要与用户任务同处一条消息」的代码可能失效 | 默认 `head`；先用字节稳定性测试把现有结构钉死；`run-state.js:376-431` 的回落分支一并适配 |
| B2 误去重非纯工具 | 结果错误、模型被误导 | 默认关 + 双重门禁（选项 + `replayable:true`），并在契约里写明「去重是宿主显式声明的能力，不是引擎猜测」 |
| 与 ADR-015 Phase4b 冲突 | 合并冲突 / 语义打架 | **A/B 一律在 Phase4b 合入后开工**；A1 直接构建在 Phase4b 的 stub 语义之上 |
| 版本节奏 | 0.6.0 被 A2/A3 的行为变更撑大 | A2/A3 是 P0，必须进 0.6.0；CHANGELOG 显式标注，宿主按契约文档升级 |

---

## 11. 明确不做（附决议依据）

| 不做 | 依据 |
|---|---|
| 向量 / embedding / 图检索 | 五家默认都不是向量（`06` §5）；零依赖红线；本项目规模不需要 |
| 工具搜索 / BM25 渐进披露 | ADR-008 已明确用「脚本自描述」替换渐进披露；A/B 阶段先补**可观测性**（B4），不补机制 |
| 子进程技能隔离、审批 UI、沙箱 | ADR-009（安全由宿主负责） |
| 多租户 / per-user 字段隔离 | 单用户信任域是产品定位；若变化需另立 ADR |
| 指令文件（AGENTS.md）引擎化 | 本项目 `task brief` 已覆盖该角色，且宿主层的做法更灵活；若宿主通用化再议 |
| 按大小重排的单轮预算（全局最优） | 需要推迟 checkpoint 持久化，复杂度与风险不成比例 |
| 给模型区分「两种截断原因」 | 无价值信息，浪费 token；原因放 metadata |
| LLM 小模型专门做摘要 | 默认统计折叠已零成本；LLM 折叠由宿主注入 summarizer，模型选择是宿主策略（ADR-012） |

---

## 附：与对比文档 P0/P1 清单的对应

| `07-takeaways` 条目 | 本方案 | 说明 |
|---|---|---|
| P0#1 单轮聚合预算 | **A1** | 直接对应 |
| P0#2 锚点索引 | **A2** | 直接对应 |
| P0#3 摘要模板补字段 | **A3** | 部分采纳：不新增「用户最新未解决输入」（受保护消息本就不会被折），改为覆盖同一风险的取消信号规则 |
| P0#4 stub 补「不要重跑」 | 已在 Phase4b | 代码已含该文案，无需额外工作 |
| P0#5 阈值按窗口缩放 | **降级** | 改为「契约文档给出推荐公式 + CLI 显式默认值」；引擎默认保持 4096 以免破坏既有行为（A1 已解决真正的风险） |
| P1#6 片段类型标签 | **B1** | 降级为无行为变更的重构 |
| P1#7 缓存友好折叠 | **B3** | opt-in |
| P1#8 同调用去重 | **B2** | opt-in + 双门禁（比原建议更保守） |
| P1#9 指令文件引擎化 | 不做 | 见 §11 |
| P1#10 工具面计量 | **B4** | 只做计量与告警 |
| P2#11 长期记忆 | **C1** | 另立 ADR |
| P2#12 per-user 隔离 | 不做 | 见 §11 |
| P2#13 压缩效果闭环验证 | **C2** | 提前到 Phase A 就做 |
