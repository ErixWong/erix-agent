import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { CONTINUITY_BLOCK_START, renderContinuityBlock } from "../../src/loop/continuity-block.js";

function conversationWithImage() {
  return [
    { role: "user", content: "head" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "old" },
        { type: "image", source: { type: "url", url: "https://example.test/old.png" } },
      ],
    },
    { role: "user", content: "protected request" },
    { role: "assistant", content: [{ type: "text", text: "protected answer" }] },
    { role: "user", content: "recent request" },
    { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
  ];
}

test("compaction hooks, system summaries, and image cleanup are configurable（#898：不再有受保护的轮）", async () => {
  const before = [];
  const after = [];
  const messages = conversationWithImage();
  const result = await createFoldStatisticalStrategy({
    summaryRole: "system",
    stripHistoricalImages: true,
    onBeforeFold: (payload) => before.push(payload),
    onAfterFold: (payload) => after.push(payload),
  }).compact(messages, {
    // issue #873：本用例测的是**无预算的旧口径**（不传 `budgetTokens` ⇒ 选择器逐字退回按 `keepRounds`
    // 计数折）；本用例验的是 hooks / system 摘要 / 图片清理，与折叠目标比例无关，故保持旧口径。
    // issue #898：这里以前还传 `protectedMessage: (message) => message?.content === "protected request"`
    // 把那一轮钉住。机制已退役 ⇒ 同一个旋钮不再被接受，下面两条改钉**新行为**。
    keepRounds: 1,
  });

  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(result.messages[0].role, "system");
  // #898 的行为改变：以前被保护的那条现在会被折走（没有任何豁免）……
  assert.equal(
    result.messages.some((message) => message.content === "protected request"),
    false,
    "#898：以前被保护的那条不再幸存",
  );
  // ……但它的原文进了归档素材，**证据没变少**（#896 的 `recall_read` 读的就是这一份）。
  assert.equal(
    result.foldedPayload.some((message) => message?.content === "protected request"),
    true,
    "#898：被折走的原文必须在 foldedPayload 里",
  );
  assert.equal(result.foldedPayload.some((message) => (
    Array.isArray(message.content) && message.content[0]?.text === "protected answer"
  )), true);
  assert.equal(result.foldedPayload.some((message) => (
    Array.isArray(message.content) && message.content.some((block) => block.type === "image")
  )), false);
  assert.equal(before[0].roundRange.from, 1);
  assert.equal(after[0].foldedRounds, result.foldedRounds);
});

test("fold summarizer receives globally offset round ranges", async () => {
  let request;
  const result = await createFoldLlmStrategy({
    summarizer: async (input) => {
      request = input;
      return "## 下一步\n已完成项禁止重做";
    },
  }).compact([
    { role: "user", content: "head" },
    { role: "assistant", content: "old one" },
    { role: "user", content: "old two" },
    { role: "assistant", content: "recent" },
  ], { keepRounds: 1, roundOffset: 20 });

  assert.deepEqual(request.roundRange, { from: 21, to: 22 });
  assert.deepEqual(result.foldedRoundRange, { from: 21, to: 22 });
});

test("uses explicit global round numbers when a mid-conversation round creates gaps", async () => {
  // issue #898：以前这一格的「洞」是 `protectedMessage` 造出来的；机制退役后改用**续接块**
  // 那一轮（今天引擎里唯一还能让中间轮不可折的机制，#589），**判据意图不变**：
  // 被折的不是连续前缀时，`foldedRoundRange` 必须取显式轮号而不是数组下标。
  const gapText = renderContinuityBlock({
    sections: {
      contract: ["夹具：这一轮不可折"],
      unfinished: ["夹具未完成项"],
      evidence: ["verified: #898 换夹具"],
    },
    version: 1,
  }).text;
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "head" },
    { role: "assistant", content: "fold one" },
    { role: "user", content: gapText },
    { role: "assistant", content: "fold three" },
    { role: "assistant", content: "recent" },
  ], {
    keepRounds: 1,
    roundNumbers: [10, 20, 30, 40],
  });

  assert.deepEqual(result.foldedRoundRange, { from: 10, to: 40 });
  // 夹在中间那一轮（带续接块）仍在场 ⇒ 区间确实是「跳过中间一轮」取的首尾，不是连续段。
  //（拿块 marker 而不是整块文本比：折过的消息会被重新块化，JSON 里的换行是转义的。）
  assert.equal(
    result.messages.some((message) => JSON.stringify(message.content).includes(CONTINUITY_BLOCK_START)),
    true,
    "夹在中间那一轮必须仍在场（否则本题据退化成连续前缀）",
  );
});
