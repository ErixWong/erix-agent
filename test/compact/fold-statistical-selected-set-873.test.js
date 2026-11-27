// issue #873（PR #893，copilot 拦下的第 ② 条）—— `summaryOverheadTokens` 的回调必须拿到
// **实际选中的轮索引**，而不是只有「已折轮数」。
//
// 旧实现：`fold-statistical` 的开销回调用 `rounds.slice(0, foldedCount)` 重建摘要，即「前 N 轮」。
// 但选择器折的**不是连续前缀**——续接块 / 工作集地板都会让中间轮被保留
// ⇒ 估算对象与实际被折轮次不符：夹在中间那一轮（本夹具里带 10 条 TTL 句柄的大轮）被算进摘要，
// 而真被折的后续轮被漏掉。两种方向的错都可能发生（这里表现为「按前缀」高估 ⇒ 少折一轮）。
// 修复：`selectFoldedRounds` 把「此刻已选中的轮索引（升序）」作为回调第二参 `foldedIndexes`
// 传出，`fold-statistical` 按这个集合重建（范围句也走同一个 `roundRangeForIndexes` 口径）。
//
// ⚠ 夹具的取材在 issue #898 换过一次：原来这一格靠 `protectedMessage` 把中间那一轮钉成
// 「不可折」来制造非前缀的选中集合。该机制已随 #898 退役，于是改用**续接块**那一轮
// （`roundHoldsContinuityBlock`，#589）——它是引擎里今天真实存在的「中间轮不可折」机制，
// 制造出来的形状（中间一个洞 + 那个洞是最贵的一轮）与原夹具逐字同形，**断言意图不变**：
// ① 选中集合非前缀；② 两种重建口径落点不同；③ 策略跟「按选中集合」那支；④ 内容级覆盖选中集合。
//
// 判据：
//   ① 夹具让选中集合**非前缀**（夹着续接块的那一轮被跳过）；
//   ② 「按选中集合重建」与「按前缀重建」两种开销**给出不同的折叠轮数**（保证这一格分辨得出
//      被修的实现，而不是恒等）；
//   ③ 策略实际折叠轮数 = 「按选中集合」那一支，且 ≠ 「按前缀」那一支；`foldedPayload` 逐条
//      等于选中集合的轮次消息；
//   ④ 内容级：进消息的机械摘要覆盖的是**被选中**的轮（含只在选中集合里出现的那条 TTL 句柄），
//      不含被跳过那轮的锚点（估算与生产同源）。
//
// 零真实 LLM、不写盘。
import test from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../../src/tokens.js";
import { groupIntoRounds } from "../../src/messages/rounds.js";
import { collectTtlFoldStubs, selectFoldedRounds } from "../../src/compact/helpers.js";
import {
  buildFoldNavigationRecord,
  createFoldStatisticalStrategy,
  summarizeFoldedPayload,
} from "../../src/compact/fold-statistical.js";
import {
  CONTINUITY_BLOCK_START,
  isContinuityMessage,
  renderContinuityBlock,
} from "../../src/loop/continuity-block.js";

// 8 组「user → tool_use → tool_result」⇒ 15 轮（`groupIntoRounds` 按消息边界切轮）。
// 第 2 组（index 1）带一份续接块（⇒ 整轮不可折），且它的 `tool_result` 带 10 条 TTL 句柄行
//（进摘要时最贵的一层）；其余各组各带一条 TTL 句柄行。于是「把被跳过那组算进摘要」与
// 「把真被折的后续轮算进去」的估算差出一截，足以改变折叠轮数。
const GROUPS = 8;
const BLOCKED_GROUP = 1;
// × `FOLD_TARGET_RATIO`(0.65) ⇒ 目标 2200：探针实测【按选中集合重建 = 3 轮】而
//【按前缀重建 = 2 轮】——两支落点不同，这一格才分辨得出被修的实现（锚点退役后重标，改用 TTL stub 机制）。
const BUDGET = 3385;
const TARGET = Math.floor(BUDGET * 0.65);

/** 第 2 组那一轮的续接块正文（三段骨架齐全，走的是渲染器，不是手搓 marker）。 */
const BLOCKED_GROUP_BLOCK = renderContinuityBlock({
  sections: {
    contract: ["夹具目标：中间那一轮必须被跳过", "must: 不进 foldedPayload"],
    unfinished: ["夹具未完成项"],
    evidence: ["verified: keepRounds 0 已实测"],
  },
  version: 1,
});

function fixture() {
  const messages = [];
  for (let i = 0; i < GROUPS; i += 1) {
    const blockedRound = i === BLOCKED_GROUP;
    const resultText = blockedRound
      // 被跳过那一轮是「最贵的一轮」：它带 10 条 TTL 句柄行（进摘要时按 stub 逐条保留），
      // 于是「把它算进摘要」与「不把它算进去」的估算差出一截——这一机制不依赖已退役的锚点。
      ? Array.from({ length: 10 }, (_, j) => `【已折叠·TTL】read path=/blk-${j}.js`).join("\n")
      : `【已折叠·TTL】read path=/p-${i}.js\nRES-${i} ${"r".repeat(400)}`;
    messages.push({
      role: "user",
      content: blockedRound ? BLOCKED_GROUP_BLOCK.text : `R${i} ${"u".repeat(400)}`,
    });
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { path: `/p-${i}.js` } }],
    });
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: `t${i}`,
        content: [{ type: "text", text: resultText }],
      }],
    });
  }
  return messages;
}

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
  }));
}

function selectedBranch(view) {
  // 修复后：回调拿到第二参 ⇒ 按**实际选中**的轮索引重建。
  return selectFoldedRounds(view.rounds, 0, 0, {
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
  return selectFoldedRounds(view.rounds, 0, 0, {
    targetTokens: TARGET,
    headMessages: view.head,
    summaryOverheadTokens: (foldedCount) =>
      estimateOf(view.rounds, Array.from({ length: foldedCount }, (_, index) => index)),
  });
}

function messagesOf(result) {
  return result.foldedPayload.map((message) => JSON.stringify(message));
}

test("夹具：选中集合非前缀（夹着续接块的那一轮被跳过）", () => {
  const view = groupIntoRounds(fixture());
  assert.equal(view.rounds.length, 15, "前置：夹具的轮数形状变了就要重算目标");
  const direct = selectFoldedRounds(view.rounds, 0, 0, {
    targetTokens: TARGET,
    headMessages: view.head,
    summaryOverheadTokens: 0,
  });
  assert.ok(
    direct.foldedIndexes.length > 1,
    "前置：必须真选中多轮（≥ 2 轮才谈得上「前缀」与「非前缀」之别）",
  );
  const last = Math.max(...direct.foldedIndexes);
  const holes = [];
  for (let index = 0; index <= last; index += 1) {
    if (!direct.foldedIndexes.includes(index)) holes.push(index);
  }
  assert.ok(
    holes.length > 0,
    `选中集合必须是**非前缀**（实测 ${JSON.stringify(direct.foldedIndexes)}）`,
  );
  // 洞的来源必须是「夹在中间的那一轮带续接块」，而不是别的偶然（夹具本身也要钉住）。
  assert.ok(
    holes.every((index) => view.rounds[index].messages.some(isContinuityMessage)),
    `每个洞都必须是带续接块的那一轮（实测洞=${JSON.stringify(holes)}）`,
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

test("内容级：机械摘要覆盖被选中的轮，不含被跳过那轮（带续接块那一轮）的 TTL 句柄", async () => {
  const messages = fixture();
  const view = groupIntoRounds(messages);
  const bySelected = selectedBranch(view).foldedIndexes;
  const result = await createFoldStatisticalStrategy().compact(messages, {
    budgetTokens: BUDGET,
    keepRounds: 0,
    workingSetRecentRounds: 0,
  });
  const summary = result.foldSummary?.text ?? "";
  assert.notEqual(summary, "", "前置：这一折必须产出机械摘要");
  // 内容级证据：真被折的轮（选中集合）的 TTL 句柄必须进摘要（覆盖 = 选中集合）；
  // 带续接块那一轮没被折，它的续接块内容一条都不许进摘要（下面两条）。
  const foldedStub = collectTtlFoldStubs(
    bySelected.flatMap((index) => view.rounds[index].messages),
  )[0];
  assert.ok(foldedStub !== undefined, "前置：被选中的轮必须带 TTL 句柄行");
  assert.ok(summary.includes(foldedStub), `被选中的轮的 stub 必须进摘要（缺：${foldedStub}）`);
  // 被跳过那一轮（带续接块）的东西一条都不许进摘要——它没被折（这就是「覆盖 = 选中集合」
  // 而不是「覆盖 = 前缀」的内容级证据）。
  assert.ok(!summary.includes(CONTINUITY_BLOCK_START), "被跳过那轮的续接块不许进摘要");
  assert.ok(
    !summary.includes("夹具目标：中间那一轮必须被跳过"),
    "被跳过那轮的正文不许进摘要",
  );
});
