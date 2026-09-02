# Task: 反思驱动自适应预算 + 统一治理重构（Issue #18）

> 状态：设计中 v2（已按 reviewer 审计 9 条意见修订，待复审）
> 分支：feat-260902-04-reflection-budget（已有 copilot 初版 reflection 实现，未 merge）
> 关联：Issue #18、Issue #11（压缩）、PR #17（失忆修复）

## 1. 背景与动机

### 1.1 Benchmark 实测问题（erix + flash, Terminal-Bench archive 33 任务）
- 大量任务 `rounds=64 truncated=true` 被 maxRounds=64 硬切：5 个失败任务 + 4 个通过任务全撞 64 轮上限
- 被切时仍在实质推进（build-cython-ext 判分 9/11 差 2 步、compile-compcert 还在 make）
- 单轮上下文从未超预算（24-77K << 203K）→ 压缩不该触发（正确）→ 轮数是唯一硬约束
- 次约束：官方 task.toml agent.timeout_sec（900s/1800s/3600s）→ **governor 必须感知时间**

### 1.2 核心洞察
"轮数上限是拍脑袋固定值，没有与任务价值挂钩"：
- 打转/空转任务：64 轮全是浪费（应更早停）
- 接近完成任务（9/11 测试过）：64 轮被硬切（应继续）

### 1.3 现状代码（分支 feat-260902-04-reflection-budget 已有 copilot 初版）
- copilot 已实现单层 reflection：接近上限时 LLM 判断 {progress, stalled, continue, plan} → 扩轮/停/换思路
- 5 测试全过，全量 317/313/0
- **问题**：reflection 与既有 5 机制（stall/memoryLoss/completion/noTool/continuationExhausted）各自独立 if，状态散 6 变量，有叠床架屋趋势

## 2. 设计：三层信息架构 + 统一治理

### 2.1 三层信息架构

```
┌────────────────────────────────────────────────────┐
│ L0 客观事实（代码提取，不信模型）                    │
│   每轮从 tool_result 提取：result(exitOk)/errorHash │
│   /testPassed?/fileChanged? → 挂 record             │
│   ★ 每条错误附截断摘录（≤500 字符）供评估者读内容    │
├────────────────────────────────────────────────────┤
│ L1 轮末增量总结（主模型现场，delta 约束）            │
│   模型每轮响应末尾用文本内嵌格式输出 summary         │
│   只写"相对 runningLog 的增量"（不重复历史）         │
│   存 record.summary（L1 只含 action/note，客观字段  │
│   由 L0 独占——避免"校验覆盖"冗余）                  │
├────────────────────────────────────────────────────┤
│ L2 价值判断（独立评估者，冷视角）                    │
│   L2a 启发式（每轮，0 LLM 成本）                    │
│   L2b LLM 评估（触发时）                            │
│   输入 = 任务 + L0 事实链 + L1 日志链（恒定小）      │
│   输出 = {stalled?, continue?, reason, plan}        │
└────────────────────────────────────────────────────┘
```

**信息流**：L1 基于 L0（模型写 summary 时可参考）；L2 基于 L0+L1 链（评估者看客观轨迹，不信模型自述——解决 cancel-async-tasks 类"自报完成但实际没完成"）。

### 2.2 与现有机制的关系（收敛矩阵）★v2 修订

| 现有机制 | 去向 | 理由 |
|---|---|---|
| stall（recentSignatures 同签名停） | **保留**（执行期硬保护，throw→markRunState("failed")） | 确定性故障，不等 LLM；工具循环内 throw 走 catch 路径，与治理层"优雅 stop"不同类 |
| noToolRounds（无工具 N 轮停） | **并入 L2a**（每轮启发式判定） | 本来就是轮末决策；L2a 每轮跑不丢延迟 |
| memoryLossDetected（欢迎语拉回） | **并入 L2a 确定性分支**（每轮检测+当轮拉回，**不进 LLM**） | ★v2：必须保持"每轮检测+当轮注入拉回"行为（现状 loop.js:1434-1449，零成本零延迟）。若推迟到周期 LLM 评估=行为回归。**保留 noToolStreak=0 重置耦合**（现状 loop.js:1447） |
| completion maxNoToolRounds | **保留为 L2a 快速路径** | 纯启发式先判（免 LLM），LLM 兜底 |
| continuationExhausted（maxTokenContinuations 耗尽截断） | **保留独立退出路径**，与 governor 交互 | ★v2 补：loop.js:1549-1550 独立于 4 机制。governor 化后保留 `continuationExhausted` 优先退出（若本轮同时触发 reflection，优先 continuationExhausted → finish(true)），防 max_tokens 耗尽轮被 reflection 误判 extend |
| reflection（copilot 单层） | **升级为 L2b**（看 L0+L1 链，非全量 messages） | 评估上下文恒定小 + 冷视角 |
| maxRounds | **变 effectiveMaxRounds**（L2 扩轮） | 预算驱动 |

**★v2 补充——L0 与 stall 分工声明**：stall 看 tool_use **签名**（调用侧：发了什么命令）；L0 errorHash 看 tool_result（结果侧：得到什么错）。二者互补不冲突；未来新增检测须归入其一，禁止第三类。

### 2.3 统一治理点（governor）★v2 修订

**原则：判定收敛到一层；主循环只 dispatch action，不含机制特有逻辑**

```js
// 每轮结束：收集信号 → decide（纯函数）→ dispatch 副作用
const action = governor.decide({
  round,
  hasToolUse,
  l0: { errorRepeat, exitOkRate, testTrend, recentErrorText },
  l1: runningLogTail,
  signals: {
    stallSignature, noToolStreak, memoryLoss,
    nearLimit, continuationExhausted,   // ★v2 补
    elapsedMs, remainingMs,             // ★v2 补：时间维度
  },
});
// action: "throw" | "nudge(memoryLoss)" | "nudge(noTool)" | "extend"
//       | "extend+redirect" | "stop(value)" | "continue" | "reflect"
```

**决策层级（★v2 重排）**：

1. **确定性终止（最高优先，每轮）**：
   - `continuationExhausted` → finish(true)（保留现状，不进 governor action 表）
   - stall 签名 → throw（执行期已抛，轮末不再见）
2. **L2a 确定性分支（每轮，0 LLM 成本）**：
   - memoryLoss → 当轮注入拉回消息 + `noToolStreak=0` + continue
   - noToolStreak ≥ maxNoToolRounds → stop(noTool)
3. **L2b LLM 评估（★v2：默认唯一扩轮路径；不做启发式 extend）**：
   - 触发：`nearLimit && extensionCount < maxExtensions && !completionSignalDetected`
   - **v1 一律调 LLM**（reviewer 意见 c：启发式 extend 省 1-2 次调用但误判代价 32 轮执行，不值；"有进展就扩"信号太弱——edit-revert 每轮 fileChanged）
   - 输入含最近 distinct 错误摘录 → 输出 continue/stalled/stop + plan
   - 时间守卫：`remainingMs < 安全阈值` 时不 extend（避免扩轮撞墙钟超时）

**action → 副作用映射（主循环唯一 dispatch 点）**：
```js
switch (action.kind) {
  case "throw": throw stallError(...);                    // 实际执行期已抛
  case "nudge": pushUserMessage(action.text); continue;
  case "extend": case "extend+redirect":
    governorState.effectiveMaxRounds += step; pushUserMessage(action.text); continue;
  case "stop": finish(action.value === "truncated"); break;  // value: "noTool"→false, "reflection-stop"→false, "cap"→true
  case "continue": /* 正常下一轮 */ break;
  case "reflect": /* 本轮已处理，见 L2b */ break;
}
```

### 2.4 状态收敛（governorState）★v2 补 resume

```js
const governorState = {
  effectiveMaxRounds,   // 原 maxRounds（CLI 默认 64）
  extensionCount,       // 原 reflectionExtensionCount
  nextReflectionRound,  // 原 nextReflectionRound
  noToolStreak,         // 原 noToolRounds
  runningLog: [],       // L1 日志（每轮一条 {round, action, note, ts}）
  l0Facts: [],          // L0 事实（每轮一条 {round, exitOk, errorHash, errorText, testPassed}）
};
```

**★v2 resume 条款**：
- checkpoint 持久化仅 round/messages/executedToolIds/toolResults（现状）
- **resume 时必须从 persisted records 重建 runningLog/l0Facts**（records 已含每轮 summary+l0facts，数据已在 store，只缺重建逻辑）
- extensionCount/effectiveMaxRounds/nextReflectionRound **不持久化**（重置默认，有 maxRoundsCap 兜底——resume 后按全新 budget 重新评估，可接受）

## 3. 改动文件

- `src/loop.js`：governor dispatch + L0 提取 + record.summary + 主循环收敛 + resume 重建
- `bin/cli.js`：`--reflection on|off`（已有）+ `--judge-model`（可选独立评估模型）
- 新增 `src/reflection/governor.js`（纯 decide 函数，可单测）+ `src/reflection/l0.js`（事实提取）
- 测试：test/reflection.test.js 扩展 + test/governor.test.js

## 4. 评估者独立性

- **L2b 默认 = 主 provider 但独立 system 角色**（"你是严格评审者不是执行者"）+ **冷上下文**（只喂 L0+L1 链 + 任务目标，不喂主 messages 推理）→ 0 额外成本消角色偏差
- **可选 judge-provider**：`reflection.judge = {model?} | {provider?}` 换模型评估。默认 undefined = 主 provider
- 不做多评估者投票（复杂度不值）

## 5. 关键实现决策 ★v2 L1 协议补齐（reviewer 意见 1）

### 5.1 L1 summary 产生协议（明确到可实现）
- **输出位置**：模型响应文本内的**内嵌标记块**：
  ```
  <erix-summary>{"action":"…","note":"…"}</erix-summary>
  ```
  出现在 assistant 文本末尾（tool_use 之外独立 text block 或同一 text 尾部）。Anthropic/OpenAI 协议无响应侧信道，只能文本内嵌——用明确分隔符，解析时正则提取。
- **指令注入**：loop 组装 provider 请求时，在 system prompt **尾部追加一段 summary 指令**（"每轮结束时输出 <erix-summary>…"）。★对调用方契约的影响：loop 需记录是否已追加（幂等），调用方传的 system 原样保留 + 追加指令块。CLI 层 system 由 cli.js 组装，故追加在 loop 内对 CLI 透明。
- **模型不遵守时的 fallback（关键）**：解析不到 `<erix-summary>` → runningLog 该轮标记 `{summary: "missing"}`，**仅靠 L0**；不报错、不重试、不打断（flash 级模型大概率经常不写，这是预期内降级而非异常）。
- **streaming/reasoning 交互**：summary 解析在**完整响应后**做（非 delta 流式解析）；reasoning tokens 不算 delta（只有最终 text 参与）。
- **LLM 成本**：指令在 system 追加 ~150 token 一次性；模型输出 summary ~50-100 token/轮。运行日志总量预算 ~4K token（§5.2）。

### 5.2 L1 增量约束与 squash
- L1 只写 delta（相对 runningLog 已有内容的增量，不重复历史）
- runningLog 总量预算 ~4K token：超预算时 squash 最老段（30 轮 → 3 句阶段性小结，类似 fold 但针对日志），squash 仅在必要时触发
- L1 字段瘦身：**只含 action/note**（客观字段 L0 独占）——消除"代码校验覆盖模型字段"的冗余设计

### 5.3 反思消息隔离
- L2b 评估请求**不入任务 messages**（独立请求）；只有 plan 以 user 消息注入任务对话
- truncated 语义：扩到 cap 仍不够 → finish(true)；价值判断停 → finish(false)

## 6. 测试计划 ★v2 更新

- 单测：governor.decide 各 action 分支（纯函数，含时间守卫、continuationExhausted 交互）
- 单测：L0 提取（error hash 去重、exitOk、错误摘录截断）
- 单测：parseReflectionDecision 容错（已有）
- 单测：L1 summary 解析器（内嵌标记提取、缺失 fallback → "missing"）
- 集成：主模型返回含 `<erix-summary>` → record.summary 正确存
- 集成：模型不返回 summary → runningLog 标记 missing，不报错
- 集成：memoryLoss 当轮拉回（回归现有行为，断言走 L2a）
- 集成：接近上限 → 调 LLM 评估 → continue(扩轮)/stalled(换思路)/stop
- 集成：resume 后 runningLog/l0Facts 从 records 重建
- 回归：现有 317 测试全绿（memoryLoss/noTool 断言适配 L2a，行为不变）

## 7. 验收标准 ★v2 改写

- [ ] **主循环不含机制特有逻辑，只 dispatch governor action**（非"≤1 个 if"的可钻空子指标）
- [ ] memoryLoss 保持**每轮确定性检测 + 当轮拉回**（不推迟到 LLM 周期）——回归不得发生
- [ ] noToolStreak 无工具连续判定仍在 L2a 每轮执行
- [ ] continuationExhausted 独立退出路径保留，优先于 reflection extend
- [ ] 每轮 record 含 summary（L1, action/note）+ l0facts（含错误摘录 ≤500 字符）
- [ ] L2b 评估输入 = 任务 + L0+L1 链（恒定 < 4K token）+ 最近 distinct 错误摘录，非全量 messages
- [ ] governor 信号含时间维度（elapsedMs/remainingMs），临近超时不 extend
- [ ] resume 从 persisted records 重建 runningLog/l0Facts
- [ ] 现有 317 测试 + 新增 ≥ 10 全绿
- [ ] 不破坏 stall 执行期保护、compaction（L1 在 messages 外天然免疫折叠）、resume

## 8. v1 范围裁剪（避免一次全做）

- **v1 只做**：L0（errorHash+摘录）→ L1 协议（内嵌 summary+missing fallback）→ L2a（memoryLoss/noTool 确定性）→ L2b（单层 LLM 评估看 L0+L1，替代 copilot 全量 messages 版）→ governor dispatch → resume 重建
- **v1 不做**：judge-provider 换模型（留 hook，默认 undefined）；启发式 extend；多轮 squash（runningLog 超预算先直接 trim 最老，squash 语义后续）
- squash/judge-model 作为 v1.1 增量
