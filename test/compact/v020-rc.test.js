import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";

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

test("compaction hooks, system summaries, protected rounds, and image cleanup are configurable", async () => {
  const before = [];
  const after = [];
  const messages = conversationWithImage();
  const result = await createFoldStatisticalStrategy({
    summaryRole: "system",
    protectedMessage: (message) => message?.content === "protected request",
    stripHistoricalImages: true,
    onBeforeFold: (payload) => before.push(payload),
    onAfterFold: (payload) => after.push(payload),
  }).compact(messages, { keepRounds: 1, budgetTokens: 10_000 });

  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages.some((message) => message.content === "protected request"), true);
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

test("uses explicit global round numbers when protected rounds create gaps", async () => {
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "head" },
    { role: "assistant", content: "fold one" },
    { role: "user", content: "protected" },
    { role: "assistant", content: "fold three" },
    { role: "assistant", content: "recent" },
  ], {
    keepRounds: 1,
    protectedMessage: (message) => message?.content === "protected",
    roundNumbers: [10, 20, 30, 40],
  });

  assert.deepEqual(result.foldedRoundRange, { from: 10, to: 40 });
});
