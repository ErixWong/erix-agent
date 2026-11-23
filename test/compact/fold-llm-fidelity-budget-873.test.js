// issue #873（PR #893，copilot 拦下的第 ① 条）—— 声明给选择器的摘要开销必须是**上界**。
//
// 旧顺序：`enforceSummarySize(...)` 先把模型摘要夹到 `summaryBudget`，`appendFoldFidelity`
// 随后又把机械保真层（逐字引用 / 锚点索引 / 反向信号）追加在夹断结果**之后** ⇒ 实际进消息的
// 摘要**大于**声明值 ⇒ 选择器过早停折，落点高于 `FOLD_TARGET_RATIO × budgetTokens`。
// 新顺序（修复后）：保真层先拼、尺寸后管，整份摘要一起过 `enforceSummarySize(summaryBudget)`。
//
// 本文件的判据：
//   ① 夹具确实会产出保真层，且它**单独**就大于 `summaryBudget`；并且「保留部分 + 声明开销 +
//      保真层」大于目标 ⇒ 旧顺序的落点必然破目标（这条钉住「旧行为是红的」）；
//   ② 最终进消息的摘要估算 ≤ `summaryBudget`（声明值 = 真上界），保真层被压进预算而不是被删；
//   ③ 选择器落点在目标内：`tokensAfter ≤ FOLD_TARGET_RATIO × budgetTokens`，且折叠轮数与
//      「以 `summaryBudget` 为开销」直接跑选择器一致。
//
// 夹具口径：6 组「user（长正文）→ tool_use → tool_result」⇒ 11 轮，`keepRounds: 0` 抬到
// `MIN_KEEP_ROUNDS=5` ⇒ 可折上界 6 轮；预算 5000 ⇒ 目标 3250 落在「折 6 轮（2748+开销）」可达
// 的区间内（预算再小就撞 keepFloor、目标不可达，落点判据就没有意义）。
// 全部 fake summarizer，零真实 LLM、不写盘。
import test from "node:test";
import assert from "node:assert/strict";

import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";
import { FOLD_TARGET_RATIO, selectFoldedRounds } from "../../src/compact/helpers.js";
import { groupIntoRounds } from "../../src/messages/rounds.js";
import { buildFoldFidelitySection } from "../../src/compact/fold-fidelity.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";

const BUDGET = 5000;
const TARGET = BUDGET * FOLD_TARGET_RATIO;
// 刻意压小：保真层（逐字引用 + 锚点）单独就远超它 ⇒ 旧顺序（追加在夹断之后）必然破预算。
const SUMMARY_BUDGET = 160;

function roundFixture(count = 6) {
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    messages.push(
      {
        role: "user",
        content: [{
          type: "text",
          text: `第 ${i} 轮请求：请检查 src/compact/module-${i}.js 并把错误 ERR_FOLD_${i} 修掉。`
            + "背景说明".repeat(90),
        }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `/src/compact/module-${i}.js` } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: "r".repeat(700) }] }],
      },
    );
  }
  return messages;
}

// 一份「够长且分节」的模型摘要：正文本身就超 `SUMMARY_BUDGET`，逼 enforce 层真动手。
function longLlmSummary() {
  return [
    "## 阶段",
    `已完成六轮排查。${"细节".repeat(120)}`,
    "## 已改文件",
    `src/compact/module-0.js、src/compact/module-1.js ${"改动说明".repeat(80)}`,
    "## 已验证项",
    `npm test 全绿 ${"证据".repeat(80)}`,
    "## 下一步（含\"已完成项禁止重做\"）",
    `继续修剩余模块 ${"待办".repeat(80)}`,
    "## 主题词面包屑",
    "fold, fidelity, anchors, budget",
  ].join("\n");
}

function makeStrategy() {
  return createFoldLlmStrategy({
    summarizer: async () => longLlmSummary(),
    maxSummaryTokens: SUMMARY_BUDGET,
  });
}

function fidelityOf(foldedPayload) {
  return buildFoldFidelitySection(foldedPayload, {});
}

test("夹具：本折确实产出保真层，且它单独就大于 summaryBudget（旧顺序必破上界）", async () => {
  const messages = roundFixture();
  const result = await makeStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  assert.ok(result.foldedRounds > 0, "前置：这一折必须真折了轮");
  const fidelity = fidelityOf(result.foldedPayload);
  assert.equal(typeof fidelity, "string", "夹具必须产出保真层（逐字引用 / 锚点）");
  assert.notEqual(fidelity, "", "夹具必须产出保真层（逐字引用 / 锚点）");
  // 旧顺序 = 先夹到 ≤ SUMMARY_BUDGET、**再**追加保真层 ⇒ 最终摘要 ≥ 保真层单独的长度 > 声明值。
  assert.ok(
    estimateTokens(fidelity) > SUMMARY_BUDGET,
    `夹具的保真层单独应超过声明值（${SUMMARY_BUDGET}），否则对比不出旧 bug`,
  );
});

test("夹具：旧顺序的落点必然破目标（保留部分 + 声明开销 + 保真层 > 目标）", async () => {
  const messages = roundFixture();
  const result = await makeStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  const fidelity = fidelityOf(result.foldedPayload);
  const { head, rounds } = groupIntoRounds(messages);
  const direct = selectFoldedRounds(rounds, 0, undefined, 0, {
    targetTokens: TARGET,
    headMessages: head,
    summaryOverheadTokens: SUMMARY_BUDGET,
  });
  const keptEstimate = estimateMessageTokens([
    ...head,
    ...direct.retained.flatMap((round) => round.messages),
  ]);
  // 新口径成立：保留部分 + 声明开销 ≤ 目标 ⇒ 选择器按声明停手是安全的。
  assert.ok(keptEstimate + SUMMARY_BUDGET <= TARGET, "新口径：声明开销下落点在目标内");
  // 旧顺序的落点：保留部分 + 夹断后的模型摘要 + 躲在预算外的保真层 ⇒ 必破目标。
  assert.ok(
    keptEstimate + SUMMARY_BUDGET + estimateTokens(fidelity) > TARGET,
    "旧顺序（保真层在预算外）的落点必须高于目标，否则这一格钉不住被修的 bug",
  );
});

test("修复①：最终进消息的摘要（模型正文+恢复提示+保真层）整体 ≤ summaryBudget", async () => {
  const messages = roundFixture();
  const result = await makeStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  const summaryText = result.foldSummary?.text;
  assert.equal(typeof summaryText, "string", "前置：这一折必须产出进消息的摘要正文");
  assert.ok(
    estimateTokens(summaryText) <= SUMMARY_BUDGET,
    `声明值是上界：实际进消息的摘要 ${estimateTokens(summaryText)} 必须 ≤ ${SUMMARY_BUDGET}`,
  );
  // 尺寸修剪留骨架（`prunedFieldText` 保留 `## 标题`）⇒ 保真层是被**压进预算**而不是被删光；
  // 极端情形整体夹断也必须有显式截断标记。
  assert.ok(
    summaryText.includes("## 用户最新未解决输入")
      || summaryText.includes("[摘要已整体截断]")
      || summaryText.includes("[已截断]"),
    "保真层应被压进预算（修剪留标题骨架），而不是躲在预算外或无痕消失",
  );
});

test("修复①：选择器落点仍在目标内，且折叠轮数 = 以 summaryBudget 为开销的直接选择结果", async () => {
  const messages = roundFixture();
  const result = await makeStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  // 落点：折后本地估算 ≤ 0.65 × 预算（旧顺序下摘要比声明值大，这一格会红）。
  assert.ok(
    result.tokensAfter <= TARGET,
    `落点必须在目标内：tokensAfter=${result.tokensAfter}，目标=${TARGET}`,
  );
  assert.ok(estimateMessageTokens(result.messages) <= TARGET);
  // 折叠轮数与「以 summaryBudget 为声明开销」直接跑选择器一致 ⇒ 声明的开销确实被选择器吃到。
  const { head, rounds } = groupIntoRounds(messages);
  const direct = selectFoldedRounds(rounds, 0, undefined, 0, {
    targetTokens: TARGET,
    headMessages: head,
    summaryOverheadTokens: SUMMARY_BUDGET,
  });
  assert.equal(result.foldedRounds, direct.folded.length);
});
