// issue #873 验收阻断（PR #893）—— 折叠目标的两处语义修正的判据。
//
// 阻断 ①（目标不可达 ⇒ 必须留恰好 `MIN_KEEP_ROUNDS` 轮，不许把所有轮折光；下限从 1 抬到 5 是
// 用户裁决「留 1 轮等于没留」，见 `src/compact/helpers.js` 的 `MIN_KEEP_ROUNDS`）与
// 阻断 ②（摘要开销改由调用方声明 `target.summaryOverheadTokens`，三策略各按真实来源传）：
//   · fold-llm      ⇒ 传它自己配置的 `maxSummaryTokens`（模型摘要 ≤ 该上限）；
//   · fold-statistical ⇒ 传它**实际会拼出来的那份**机械摘要（含 inventory / stubs /
//                          navigation / recovery hint / anchors）的估算，≥「只有占位串」的估算；
//   · sliding-window   ⇒ 传 `0`（不往输入里 prepend 摘要）。
// 外加「刚好达到目标即停」（不多折一轮）这条边界判据。
//
// 全部纯函数 / fake summarizer，零真实 LLM、不写盘。
import test from "node:test";
import assert from "node:assert/strict";

import { groupIntoRounds } from "../../src/messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";
import {
  FOLD_TARGET_RATIO,
  MIN_KEEP_ROUNDS,
  collectTtlFoldStubs,
  selectFoldedRounds,
} from "../../src/compact/helpers.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  buildFoldNavigationRecord,
  createFoldStatisticalStrategy,
  formatFoldSummary,
  toolCallInventory,
} from "../../src/compact/fold-statistical.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { extractAnchors } from "../../src/compact/anchors.js";

// 6 个「user → tool_use → tool_result」轮；总量约 2.9k，预算 4200 ⇒ 目标 ≈ 2730。
// 该夹具下 folded 随摘要开销严格单调（0⇒1 / 500⇒3 / 900⇒5 / 1400⇒7），便于把「传了哪个
// 开销」从折叠轮数里读出来。
function roundFixture(count = 6) {
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    messages.push(
      { role: "user", content: [{ type: "text", text: "u".repeat(700) }] },
      { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `/x${i}.js` } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: "r".repeat(700) }] }] },
    );
  }
  return messages;
}

const BUDGET = 4200;
const TARGET = BUDGET * FOLD_TARGET_RATIO;

// 用与策略完全相同的 rounds / head / 入参直接跑选择器，把「某个开销」对应的折叠轮数取出来。
function foldedWithOverhead({ head, rounds }, overhead) {
  return selectFoldedRounds(rounds, 0, 0, {
    targetTokens: TARGET,
    headMessages: head,
    summaryOverheadTokens: overhead,
  }).folded.length;
}

// 「只有轮数」的占位串估算（旧口径漏掉了 inventory / stubs / navigation / anchors）。
function placeholderOverhead(foldedCount) {
  return estimateTokens(formatFoldSummary({ from: 1, to: foldedCount, count: foldedCount, tools: 0 }));
}

// ── 阻断 ① 的三条判据（纯选择器单元测试）────────────────────────────────────────────
test("阻断①（判据 7）：keepRounds=0 + 目标不可达 + 多轮 ⇒ 恰好留 5 轮（不是 1、不是全折）", () => {
  const { head, rounds } = groupIntoRounds(roundFixture(10)); // 19 轮，远大于下限 5
  assert.ok(rounds.length > MIN_KEEP_ROUNDS);
  const { folded, retained } = selectFoldedRounds(rounds, 0, 0, {
    targetTokens: 1,
    headMessages: head,
  });
  assert.equal(retained.length, MIN_KEEP_ROUNDS);
  assert.equal(folded.length, rounds.length - MIN_KEEP_ROUNDS);
  assert.notEqual(retained.length, 1, "用户裁决：留 1 轮等于没留");
  assert.notEqual(retained.length, rounds.length, "必须真的折掉一些，不是一轮不折");
});

test("下限：keepRounds 0/1–4 一律抬到 5；轮数 ≤ 有效下限 ⇒ 一轮都不折", () => {
  assert.equal(MIN_KEEP_ROUNDS, 5);
  const { head, rounds } = groupIntoRounds(roundFixture(10));
  for (const keepRounds of [0, 1, 4]) {
    const { retained } = selectFoldedRounds(rounds, keepRounds, 0, {
      targetTokens: 1, headMessages: head,
    });
    assert.equal(retained.length, MIN_KEEP_ROUNDS, `keepRounds=${keepRounds} 应被抬到 ${MIN_KEEP_ROUNDS}`);
  }
  // roundFixture(3) ⇒ 5 轮，恰好等于有效下限 ⇒ 没有可折的 ⇒ 一轮不折。
  const small = groupIntoRounds(roundFixture(3));
  assert.equal(small.rounds.length, MIN_KEEP_ROUNDS);
  const { folded } = selectFoldedRounds(small.rounds, 0, 0, {
    targetTokens: 1, headMessages: small.head,
  });
  assert.equal(folded.length, 0, "轮数 ≤ 有效下限时一轮都不折");
});

test("阻断①：keepRounds=6 仍留 6 轮（不被这条改坏）", () => {
  const { head, rounds } = groupIntoRounds(roundFixture(10));
  assert.ok(rounds.length > 6);
  const { folded, retained } = selectFoldedRounds(rounds, 6, 0, {
    targetTokens: 1, // 目标不可达 ⇒ 折到硬下限为止
    headMessages: head,
  });
  assert.equal(retained.length, 6);
  assert.equal(folded.length, rounds.length - 6);
});

test("阻断①：rounds.length===1 ⇒ 一轮都不折", () => {
  const { head, rounds } = groupIntoRounds(roundFixture(1));
  assert.equal(rounds.length, 1);
  const { folded } = selectFoldedRounds(rounds, 0, 0, {
    targetTokens: 1,
    headMessages: head,
  });
  assert.equal(folded.length, 0);
});

// ── 建议项 1①：刚好达到目标即停（不多折一轮）────────────────────────────────────────
test("边界：折到第 N 轮后恰好 ≤ target ⇒ folded.length === N（不多折一轮）", () => {
  const { head, rounds } = groupIntoRounds(roundFixture(8));
  assert.ok(rounds.length >= 8);
  // 用真实每轮估算，把目标定在「折掉最老 N 轮之后**正好等于** target」。
  const roundTokens = rounds.map((round) => estimateMessageTokens(round.messages));
  const N = 3;
  let total = estimateMessageTokens(head);
  for (const tokens of roundTokens) total += tokens;
  const target = total - roundTokens.slice(0, N).reduce((sum, tokens) => sum + tokens, 0);
  const { folded } = selectFoldedRounds(rounds, 0, 0, {
    targetTokens: target,
    headMessages: head,
    summaryOverheadTokens: 0,
  });
  assert.equal(folded.length, N);
});

// ── 阻断 ② 判据 1：fold-llm 传自己配置的 maxSummaryTokens（不是 0、不是机械摘要长度）──
test("阻断②：fold-llm 传给选择器的 summaryOverheadTokens = 解析后的 maxSummaryTokens", async () => {
  const messages = roundFixture();
  const view = groupIntoRounds(messages);
  const configured = 900;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => "short llm summary",
    maxSummaryTokens: configured,
  });
  const result = await strategy.compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  // 折叠轮数与「以 configured 为开销」直接跑选择器一致 ⇒ 策略确实传了 configured。
  assert.equal(result.foldedRounds, foldedWithOverhead(view, configured));
  // 且不是 0、不是默认 1400、不是「只有占位串」的机械估算（三者折叠轮数都与 configured 不同）。
  assert.notEqual(result.foldedRounds, foldedWithOverhead(view, 0));
  assert.notEqual(result.foldedRounds, foldedWithOverhead(view, 1400));
  assert.notEqual(result.foldedRounds, foldedWithOverhead(view, placeholderOverhead));
});

// ── 阻断 ② 判据 2：fold-statistical 的估算把真实组成部分算进去（≥ 只有占位串）──────────
test("阻断②：fold-statistical 的摘要估算 ≥ 只有占位串时的估算（真算了 stubs/navigation/anchors）", async () => {
  const messages = roundFixture();
  const view = groupIntoRounds(messages);
  const strategy = createFoldStatisticalStrategy();
  const result = await strategy.compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  // 占位串估算（只 from/to/count）下的折叠轮数。
  const placeholderFolded = foldedWithOverhead(view, placeholderOverhead);
  // 策略实际用了「含真实组成部分」的估算 ⇒ 开销更大 ⇒ 折得不少于占位串口径。
  assert.ok(result.foldedRounds >= placeholderFolded);
  // 且对含工具调用 / 锚点的夹具，真实估算严格更大（折得更多）⇒ 证明那些部分被算进去了。
  assert.ok(result.foldedRounds > placeholderFolded, "真实估算应比占位串更大");
  // 与「重建真实估算」的选择器结果一致 ⇒ 用的就是那套真实组成部分。
  const fullRecon = (foldedCount) => {
    const foldedMessages = view.rounds.slice(0, foldedCount).flatMap((round) => round.messages);
    return estimateTokens(formatFoldSummary({
      from: 1,
      to: foldedCount,
      count: foldedCount,
      tools: 0,
      inventory: toolCallInventory(foldedMessages),
      stubs: [...new Set(collectTtlFoldStubs(foldedMessages))],
      navigationRecord: buildFoldNavigationRecord(foldedMessages, { from: 1, to: foldedCount }),
      anchors: extractAnchors(foldedMessages, {}),
    }));
  };
  assert.equal(result.foldedRounds, foldedWithOverhead(view, fullRecon));
  // 逐点核对：真实估算在若干 foldedCount 上都 ≥ 占位串估算。
  for (let count = 1; count <= view.rounds.length; count += 1) {
    assert.ok(fullRecon(count) >= placeholderOverhead(count));
  }
});

// ── 阻断 ② 判据 3：sliding-window 传 0 ────────────────────────────────────────────
test("阻断②：sliding-window 的 summaryOverheadTokens = 0（不往输入里 prepend 摘要）", async () => {
  const messages = roundFixture();
  const view = groupIntoRounds(messages);
  const strategy = createSlidingWindowStrategy();
  const result = await strategy.compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  // 开销 0 ⇒ 折叠轮数与「零开销」直接跑选择器一致，且严格少于会预留摘要开销的策略。
  assert.equal(result.foldedRounds, foldedWithOverhead(view, 0));
  assert.ok(result.foldedRounds < foldedWithOverhead(view, 900));
  // 摘要只落账、不进模型输入：compactedMessages 里没有折叠摘要标记。
  const anySummaryMarker = result.messages.some((message) => {
    const text = typeof message?.content === "string"
      ? message.content
      : (message?.content ?? []).map((block) => block?.text ?? "").join("");
    return text.includes("已折叠");
  });
  assert.equal(anySummaryMarker, false);
});
