// issue #873（PR #893，copilot 拦下的第 ② 条）—— `summaryOverheadTokens` 的回调必须拿到
// **实际选中的轮索引**，而不是只有「已折轮数」。
//
// 旧实现：`fold-statistical` 的开销回调用 `rounds.slice(0, foldedCount)` 重建摘要，即「前 N 轮」。
// 但选择器折的**不是连续前缀**——`protectedMessage` / 连续性块 / 工作集地板都会让中间轮被保留
// ⇒ 估算对象与实际被折轮次不符：被保护那轮（本夹具里带 20 条锚点的大轮）被算进摘要，
// 而真被折的后续轮被漏掉。两种方向的错都可能发生（这里表现为「按前缀」高估 ⇒ 少折一轮）。
// 修复：`selectFoldedRounds` 把「此刻已选中的轮索引（升序）」作为回调第二参 `foldedIndexes`
// 传出，`fold-statistical` 按这个集合重建（范围句也走同一个 `roundRangeForIndexes` 口径）。
//
// 判据：
//   ① 夹具让选中集合**非前缀**（被保护的两轮夹在中间被跳过）；
//   ② 「按选中集合重建」与「按前缀重建」两种开销**给出不同的折叠轮数**（保证这一格分辨得出
//      被修的实现，而不是恒等）；
//   ③ 策略实际折叠轮数 = 「按选中集合」那一支，且 ≠ 「按前缀」那一支；`foldedPayload` 逐条
//      等于选中集合的轮次消息；
//   ④ 内容级：进消息的机械摘要覆盖的是**被选中**的轮（含只在选中集合里出现的那条 TTL 句柄），
//      不含被保护那轮的锚点（估算与生产同源）。
//
// 零真实 LLM、不写盘。
import test from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../../src/tokens.js";
import { groupIntoRounds } from "../../src/messages/rounds.js";
import { collectTtlFoldStubs, selectFoldedRounds } from "../../src/compact/helpers.js";
import { extractAnchors } from "../../src/compact/anchors.js";
import {
  buildFoldNavigationRecord,
  createFoldStatisticalStrategy,
  summarizeFoldedPayload,
} from "../../src/compact/fold-statistical.js";

// 8 组「user → tool_use → tool_result」⇒ 15 轮（`groupIntoRounds` 按消息边界切轮）。
// 第 2 组（index 1）整组被保护，且它的 `tool_result` 带 20 条路径锚点（摘要里最贵的一层）；
// 其余各组各带一条 TTL 句柄行。于是「把被保护那组算进摘要」与「把真被折的后续轮算进去」
// 的估算差出一截，足以改变折叠轮数。
const GROUPS = 8;
const PROTECTED_GROUP = 1;
// × `FOLD_TARGET_RATIO`(0.65) ⇒ 目标 2399：选中 6 轮、按前缀估会少折一轮（探针实测）。
const BUDGET = 3692;
const TARGET = Math.floor(BUDGET * 0.65);

function fixture() {
  const messages = [];
  for (let i = 0; i < GROUPS; i += 1) {
    const protectedRound = i === PROTECTED_GROUP;
    const resultText = protectedRound
      ? `${Array.from({ length: 20 }, (_, j) => `src/prot/f${j}.js:${100 + j}`).join(" ")} ${"p".repeat(2000)}`
      : `【已折叠·TTL】read path=/p-${i}.js\nRES-${i} ${"r".repeat(400)}`;
    messages.push({ role: "user", content: `R${i} ${"u".repeat(400)}`, protectedRound });
    messages.push({
      role: "assistant",
      protectedRound,
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `/p-${i}.js` } }],
    });
    messages.push({
      role: "user",
      protectedRound,
      content: [{
        type: "tool_result",
        tool_use_id: `t${i}`,
        content: [{ type: "text", text: resultText }],
      }],
    });
  }
  return messages;
}

const guard = (message) => message?.protectedRound === true;

// 与策略内部同一套生产函数（`summarizeFoldedPayload` + stubs / navigation / anchors）。
function estimateOf(rounds, indexes) {
  const messages = indexes.flatMap((index) => rounds[index].messages);
  const range = {
    from: Math.min(...indexes) + 1,
    to: Math.max(...indexes) + 1,
  };
  return estimateTokens(summarizeFoldedPayload(messages, {
    from: range.from,
    to: range.to,
    count: indexes.length,
    stubs: [...new Set(collectTtlFoldStubs(messages))],
    navigationRecord: buildFoldNavigationRecord(messages, range),
    anchors: extractAnchors(messages, {}),
  }));
}

function selectedBranch(view) {
  // 修复后：回调拿到第二参 ⇒ 按**实际选中**的轮索引重建。
  return selectFoldedRounds(view.rounds, 0, guard, 0, {
    targetTokens: TARGET,
    headMessages: view.head,
    summaryOverheadTokens: (foldedCount, foldedIndexes) => {
      assert.ok(Array.isArray(foldedIndexes), "回调必须收到第二参（已选中的轮索引）");
      assert.equal(foldedIndexes.length, foldedCount, "第二参长度必须等于已折轮数");
      assert.deepEqual(
        foldedIndexes,
        [...foldedIndexes].sort((a, b) => a - b),
        "第二参必须是升序索引",
      );
      return estimateOf(view.rounds, foldedIndexes);
    },
  });
}

function prefixBranch(view) {
  // 旧实现：只有轮数 ⇒ 按前缀重建。
  return selectFoldedRounds(view.rounds, 0, guard, 0, {
    targetTokens: TARGET,
    headMessages: view.head,
    summaryOverheadTokens: (foldedCount) =>
      estimateOf(view.rounds, Array.from({ length: foldedCount }, (_, index) => index)),
  });
}

function messagesOf(result) {
  return result.foldedPayload.map((message) => JSON.stringify(message));
}

test("夹具：选中集合非前缀（被保护的轮夹在中间被跳过）", () => {
  const view = groupIntoRounds(fixture());
  assert.equal(view.rounds.length, 15, "前置：夹具的轮数形状变了就要重算目标");
  const direct = selectFoldedRounds(view.rounds, 0, guard, 0, {
    targetTokens: TARGET,
    headMessages: view.head,
    summaryOverheadTokens: 0,
  });
  assert.ok(direct.foldedIndexes.length > 2, "前置：必须真选中多轮");
  const last = Math.max(...direct.foldedIndexes);
  const holes = [];
  for (let index = 0; index <= last; index += 1) {
    if (!direct.foldedIndexes.includes(index)) holes.push(index);
  }
  assert.ok(
    holes.length > 0,
    `选中集合必须是**非前缀**（实测 ${JSON.stringify(direct.foldedIndexes)}）`,
  );
});

test("两种重建口径给出不同的折叠轮数（这一格分辨得出被修的 bug）", () => {
  const view = groupIntoRounds(fixture());
  const bySelected = selectedBranch(view).folded.length;
  const byPrefix = prefixBranch(view).folded.length;
  assert.notEqual(bySelected, byPrefix, "按选中集合与按前缀两种估算必须落点不同");
});

test("策略按实际选中的轮次重建开销估算，foldedPayload 逐条等于选中集合", async () => {
  const messages = fixture();
  const view = groupIntoRounds(messages);
  const bySelected = selectedBranch(view);
  const byPrefix = prefixBranch(view);
  const result = await createFoldStatisticalStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
    protectedMessage: guard,
  });
  assert.ok(result.foldedRounds > 0, "前置：这一折必须真折了轮");
  assert.equal(result.foldedRounds, bySelected.folded.length, "策略必须与「按选中集合重建」一致");
  assert.notEqual(result.foldedRounds, byPrefix.folded.length, "且与「按前缀重建」不同（旧实现落在那一支）");
  assert.deepEqual(
    messagesOf(result),
    bySelected.foldedIndexes.flatMap((index) => view.rounds[index].messages).map((m) => JSON.stringify(m)),
    "foldedPayload 必须逐条等于选中集合的轮次消息",
  );
});

test("内容级：机械摘要覆盖被选中的轮，不含被保护那轮的锚点", async () => {
  const messages = fixture();
  const view = groupIntoRounds(messages);
  const bySelected = selectedBranch(view).foldedIndexes;
  const result = await createFoldStatisticalStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
    protectedMessage: guard,
  });
  const summary = result.foldSummary?.text ?? "";
  assert.notEqual(summary, "", "前置：这一折必须产出机械摘要");
  // 只在「选中集合」里出现、不在同长度前缀里出现的轮：它的 TTL 句柄必须进摘要。
  const prefixSameLength = bySelected.slice(0, bySelected.length).map((_, index) => index);
  const extraRounds = bySelected.filter((index) => !prefixSameLength.includes(index));
  assert.ok(extraRounds.length > 0, "前置：选中集合必须比同长度前缀多至少一轮");
  const extraStub = collectTtlFoldStubs(extraRounds.flatMap((index) => view.rounds[index].messages))[0];
  assert.ok(extraStub !== undefined, "前置：额外那一轮必须带 TTL 句柄行");
  assert.ok(summary.includes(extraStub), `摘要必须覆盖只在选中集合里出现的那轮（缺：${extraStub}）`);
  // 被保护那一组的锚点一条都不许出现（它没被折）。
  assert.ok(!summary.includes("src/prot/f0.js"), "被保护那轮的锚点不许进摘要");
  assert.ok(!summary.includes(`RES-${PROTECTED_GROUP}`), "被保护那轮的正文不许进摘要");
});
