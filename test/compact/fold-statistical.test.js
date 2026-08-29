import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";

test("prepends a deterministic tool-footprint summary to the head user", async () => {
  const messages = [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "writeFile", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "written" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "b", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "b", content: "ran" }],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const strategy = createFoldStatisticalStrategy();
  const result = await strategy.compact(messages, { keepRounds: 1, budgetTokens: 0 });
  const summary =
    "【上下文折叠】早期第 1–2 轮（共 2 轮）已折叠。工具足迹：exec×1, writeFile×1。原文留存 transcript store。";

  assert.equal(strategy.name, "fold-statistical");
  assert.deepEqual(result.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: summary },
        { type: "text", text: "initial request" },
      ],
    },
    messages[5],
  ]);
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 2);
  assert.equal(result.compacted, true);
  assert.equal(JSON.stringify(result), JSON.stringify(
    await strategy.compact(messages, { keepRounds: 1, budgetTokens: 0 }),
  ));
});

test("converts an array user content to a prefixed block without adding a message", async () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "request" }] },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "assistant", content: [{ type: "text", text: "new" }] },
  ];
  const result = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, /工具足迹：无/);
  assert.deepEqual(result.messages[0].content[1], messages[0].content[0]);
});
