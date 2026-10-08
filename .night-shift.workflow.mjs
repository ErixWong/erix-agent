const COMMON = `
## 仓库与工作纪律（所有 worker 通用）
- 仓库：erix-agent（零运行时依赖、纯 ESM、Node 22+、无构建步骤；红线：不新增 npm 依赖、不提交密钥）
- 你在一个隔离 worktree 里工作（harness 已分配），当前分支就是你的工作分支。**禁止 git push、禁止动 main、禁止碰其他目录**。
- 基线：npm test 应全绿（1029 tests / 1024 pass / 0 fail / 5 skipped）。开工前先跑一次确认；完成后必须再跑一次并全绿。
- 完成后在**当前分支**提交（可多个 commit）：conventional commits + （issue #NNN）+ 中文摘要。
- 只改任务书列出的文件面；发现必须越界时，在报告里显式声明改了什么、为什么。
- 交付报告必须包含：改动文件清单与净行数、npm test 末尾输出、每条验收项的自证（命令+结果）、未做/存疑事项。
- 可用 gh CLI 读 issue 原文：gh issue view <N> -R ErixWong/erix-agent（正文里已给关键信息，issue 原文是权威细节）。
`;

const results = await runs.all([
  { key: "A-176-180", agent: "worker", isolation: "worktree", task: `#176+#180 终局载荷 additive（一个 PR 组，两件事）${COMMON}
## 任务 1（#176）：termination 携带 errorCode
- src/loop/termination.js + src/loop/orchestrator.js 的 fail()/makeResult 路径：当 reason === "failed" 时挂 termination.errorCode = error?.code ?? "unknown"（有则带、无则 unknown）。additive 字段，semver minor。
- 单测：provider 抛 timeout KitError（retry 关闭）→ result.termination.errorCode === "timeout"。
## 任务 2（#180）：abort 错误携带 usage/rounds/finalText（方案 A：仍抛错，只挂字段）
- 现状：signal.aborted 时 orchestrator.js fail()（约 734-771）→ annotateTermination（termination.js:40-49）只挂 {reason,detail}，累计的 usage（orchestrator :1219 建、:1280-1297 addUsage 逐轮累加含 cacheRead/cacheWrite）与 rounds/finalText 丢失。
- 修法：抛错前在同一错误对象上挂 error.usage（与 makeResult 同一对象口径）、error.rounds、error.finalText ?? ""；并在 termination 里同步 {usage, rounds, partial:true}。不改变「abort=抛错」语义。
- 单测：provider 在第 2 轮响应后置 signal.abort() → 抛出错误满足 error.usage.input_tokens > 0、error.rounds === 2、error.termination.reason === "aborted"。
- 回归：正常返回路径 usage/rounds 数值逐字段不变。
- 契约测试：test/contract/ 增加「abort 错误必带 usage/rounds（无用量时为 0）」断言（参考 test/contract/engine-api.js 形状，注册进 index.js）。
- 契约文档：docs/host-consumer-contract.md 加 errorCode 字段一行 + abort 载荷一段；CN 版（host-consumer-contract_cn.md）同步（小节标题结构对齐，可跑 node scripts/docs-sync-check.mjs 自查）。
## 文件面：src/loop/termination.js、src/loop/orchestrator.js（fail/makeResult 相关段）、docs/host-consumer-contract.md、docs/host-consumer-contract_cn.md、test/（新增或扩展 loop-termination + contract）。不要动 compactBeforeRound、trimGovernorHistory、tokens.js、providers/、upgrade guide。
参考：gh issue view 176 -R ErixWong/erix-agent；gh issue view 180 -R ErixWong/erix-agent` },

  { key: "B-172", agent: "worker", isolation: "worktree", task: `#172 token 估算热路径三连（零行为变化）${COMMON}
## 三个子项（一个 PR）
1. 删 compactBeforeRound 3 对纯重复全量估算：src/loop/orchestrator.js 中 1983↔2000（messages）、2055↔2072（compactedMessages）、2093↔2110（compactedMessages）——同一数组两次调用间无变更，复用第一次结果。**逐行确认中间确实无变更再删**（若发现某对之间有变更，保留并在报告说明）。
2. src/tokens.js estimateTokens 加 ASCII 快路径：对 code < 0x3400 的字符直接按 non-CJK 口径计，跳过 isCjkUnifiedIdeograph 的 8 区间扫描；只对少数非 ASCII 字符走原判定。**必须逐字节同值**（这是纯加速不改口径）。实测参考：210k 字符 13.94ms→2.40ms（5.8×）。注意原实现用 for...of 迭代器，快路径可用索引循环但注意代理对语义与原实现一致。
3. trimGovernorHistory O(n²) 线性化（orchestrator.js 约 959-965）：while 内每移出一个元素就对剩余全量 JSON.stringify+估算两遍 → 改为先估一次、按被移出条目的估算值递减。保留「至少留 1 条」与 4000 阈值语义。
## 验收（写进新单测）
- estimateTokens 新旧实现**逐字节同值**：中英混排、纯 CJK、emoji 代理对、含 image/tool_use/raw 块的消息级估算
- compaction 相关测试（tokensBefore/After 断言）全绿；npm test 全绿
- /tmp 基准脚本对比每轮估算耗时，报告数字（非仓库产物）
## 文件面：src/tokens.js、src/loop/orchestrator.js（compactBeforeRound 段 + trimGovernorHistory）、test/（新增）。不要动 fail()/termination、providers/、docs。
参考：gh issue view 172 -R ErixWong/erix-agent；架构评审 docs/design/2026-10-08-architecture-review.md §7` },

  { key: "C-175-181", agent: "worker", isolation: "worktree", task: `#175+#181 providers 域（提取 + 注入接口，同一 PR 组）${COMMON}
## 任务 1（#175）：逐字节相同 helper 提取
- src/providers/openai.js 与 anthropic.js 中逐字节相同的私有 helper：hasOwn、parseJson、timeoutError、fetchOptionsWithTransport（truncateBody 由你逐字节比对定夺）→ 提取到 src/providers/http-shared.js；**readResponseBody 两边有差异，保留不并**。纯移动+改 import，零行为变化。
## 任务 2（#181）：defaultHeaders + extraBody 注入口（两个 provider 一致实现，semver minor）
- createOpenAIProvider / createAnthropicProvider 各加两个选项：defaultHeaders（追加到请求头）、extraBody（合并进请求体）。现状：header 是写死字面量（openai.js:286-292 非流式、:379-385 流式；anthropic.js:397-399 复用于 :426/:512）。
- 红线：①受保护 header 不可覆盖——openai 侧 Authorization/Content-Type、anthropic 侧 x-api-key/anthropic-version，宿主传同名 → 抛 TypeError；②header 值不得进日志与错误文案（与 key 脱敏同口径，写防泄漏断言）；③extraBody 与引擎自有字段冲突时**引擎字段优先**并显式 warn（宿主不能悄悄改 stream/model）。
## 验收
- test/providers/ 双侧覆盖：defaultHeaders 出现在实际请求且与 Authorization 共存；宿主传受保护 header → TypeError；extraBody.user 出现在 body 且不覆盖 model/stream；错误信息不含 header 值
- 契约文档：docs/host-consumer-contract.md 加 provider 注入口简述 + 红线；CN 同步（跑 node scripts/docs-sync-check.mjs 自查标题对齐）
- npm test 全绿
## 文件面：src/providers/*.js、src/providers/http-shared.js（新）、test/providers/、docs/host-consumer-contract(.md/_cn.md)。不要动 src/loop/、tokens.js。
参考：gh issue view 175 -R ErixWong/erix-agent；gh issue view 181 -R ErixWong/erix-agent` },

  { key: "D-171", agent: "worker", isolation: "worktree", task: `#171 升级指南 sketch 与运行时判据不等价修复（宿主照抄会静默丢一轮）${COMMON}
## 事实（issue 原文可复核：gh issue view 171 -R ErixWong/erix-agent）
三处矛盾：upgrade guide 0.17.0 §2 参考 SQL 用 OR；契约正文与运行时（src/store/append-user-turn.js:139-141）用 (record.dedupKey ?? record.roundKey) === dedupKey。分叉条件：record 同时具有不等值的 dedupKey 与 roundKey，查询值等于 roundKey——?? 判 miss，OR 判 hit（快路径多命中 → appendUserTurn 直接 already-appended，这轮静默不追加）。
## 改动（采纳方案 1「以 nullish 为准」，运行时不动）
1. docs/host-upgrade-guide-0.17.0.md §2 sketch 改为等价 nullish：WHERE (record->>'$.dedupKey' = $2 OR (record->>'$.dedupKey' IS NULL AND record->>'$.roundKey' = $2))，旁注「sketch 必须与全量路径同一判据；与正文/运行时不一致时以正文/运行时为准」
2. test/contract/transcript-store.js 补 fixture：record 同时有 dedupKey:"A" 与 roundKey:"B"（A≠B），断言 loadByDedupKey(key,"B") 返回 null/undefined（永久锁 nullish 语义）
3. 契约（EN+CN）写明 loadMaxRound 边界：非空存储必须返回 ≥0 安全整数；负数/null/undefined 仅作为空存储信号
4. 契约（EN+CN）声明宿主保留前缀：宿主内部记账键使用 __ 前缀（RoundRecord 里引擎不产出也不消费 __ 前缀键，出现属未定义行为），宿主可零冲突借用
## 验收
- npm test 全绿（新 fixture 在旧运行时语义下必须绿——运行时本来就是 ??，这是补测试不是改行为）
- node scripts/docs-sync-check.mjs EN/CN 标题对齐自查
## 文件面：docs/host-upgrade-guide-0.17.0.md、docs/host-consumer-contract.md、docs/host-consumer-contract_cn.md、test/contract/transcript-store.js。不要动任何 src/ 运行时。` },

  { key: "E-173a", agent: "worker", isolation: "worktree", task: `#173 PR-A：观察者抛错「现状」锁行为测试（纯新增测试，不改任何行为/文档）${COMMON}
## 要锁的现状（实测已复现，见 gh issue view 173 -R ErixWong/erix-agent）
- onEvent 抛错 → runToolLoop 抛出/终止，error.termination = {reason:"failed", detail:<宿主错误消息>}（emitEvent 无 try，orchestrator.js:1256-1258）
- onRound 抛错 → 同样终止（orchestrator.js:2825 await onRound）
- onToolResult 抛错 → 同样终止（run-snapshot-executor.js:258）
- onDelta（及 onReasoningDelta/onToolCall/onUsage）抛错 → 经 onObserverError 记录后 run 正常完成
- onJudge 抛错（reflection 开启时）→ 被裸 catch 吞，run 正常完成（orchestrator.js:1271-1279 附近）
## 要求
- 新建 test/loop-observer-isolation.test.js；复用 test/loop.test.js 等现有 mock provider 模式（persistence:"none" 即可）
- 每个通道一条明确断言 + 注释标注「这是 2026-10-08 现状锁，#173 PR-B 若统一隔离语义需同步更新本文件」
- **零生产代码改动**；npm test 全绿
## 文件面：仅 test/loop-observer-isolation.test.js。` },

  { key: "F-182e", agent: "worker", isolation: "worktree", task: `#182 代码部分：model_metadata_missing 一次性诊断事件（文档字段表面由主 agent 另做）${COMMON}
## 背景（gh issue view 182 -R ErixWong/erix-agent）
宿主不传 contextWindowTokens/maxOutputTokens 时：压缩整体不启用、单轮聚合输出预算关闭、输出上限退回 4096——全链路零告警（真机 92 轮 run compaction=0）。需要一条一次性事件让宿主可断言装配是否把压缩关掉了。
## 改动
- src/loop/orchestrator.js：当预算元数据探测失败（budgetTokens 因 metadata 缺失无法推导，见约 797-810 的推导段与 budget.js modelMetadataFor）时，发一次性事件：{ type: "model_metadata_missing", runId, detail: "contextWindowTokens/maxOutputTokens unavailable; compaction and aggregate output budget are disabled for this run; output limit falls back to 4096" }
- 实现风格照抄 persistence_capability_degraded 的一次性去重（orchestrator.js 约 666-677；注意它绕开 emitEvent 直调 onEvent?.() 的 TDZ 原因，你的事件如果在 emitEvent 定义前触发也要用同样方式）；每 run 最多一条
- additive 事件类型 = semver minor；契约文档在事件类型清单处补一行（EN+CN，跑 node scripts/docs-sync-check.mjs 自查）
## 验收（单测）
- 无 metadata 装配 → onEvent 收到恰好一条 model_metadata_missing
- 有 metadata 装配 → 零条
- 多轮运行不重复发
- npm test 全绿
## 文件面：src/loop/orchestrator.js（预算推导段 + 事件发射）、docs/host-consumer-contract(.md/_cn.md)（事件清单一行）、test/（新增或扩展）。不要动 fail()、compactBeforeRound 逻辑本身、tokens.js、providers/。` },
]);

const reports = {};
for (const r of results) {
  reports[r.key] = { status: r.status, ok: r.ok, summary: String(r.output || r.error || "").slice(0, 3500) };
}
return {
  note: "6 个 worker 已在各自 worktree 提交；主 agent 需逐一审查 diff 后按 D→E→C→B→A→F 顺序合入 main，每步 npm test 复跑",
  deferred: "#173 PR-B（行为决策）、#177、#178（touwaka 窗口）、#179、#182 文档字段表与示例、#170 裁决表（主 agent 写）",
  reports,
};
