import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";

test("prepends a deterministic tool-footprint summary before the head user task", async () => {
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
    "【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮（共 2 轮）已折叠。工具足迹：exec×1, writeFile×1。需要原文请重读文件或查看持久笔记；关键值应当已落盘";

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

test("appends a summary to array user content without adding a message", async () => {
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
  assert.equal(result.messages[0].content.length, 2);
});

test("omits recall from the default summary and accepts an injected recovery hint", async () => {
  const messages = [
    { role: "user", content: "request" },
    { role: "assistant", content: [{ type: "text", text: "old" }] },
    { role: "user", content: "recent" },
  ];
  const defaultResult = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 1 });
  const defaultSummary = defaultResult.messages[0].content[0].text;
  assert.doesNotMatch(defaultSummary, /recall/i);

  const hint = "恢复提示：请查看 durable-notes.md";
  const customResult = await createFoldStatisticalStrategy({ recoveryHint: hint })
    .compact(messages, { keepRounds: 1 });
  assert.match(customResult.messages[0].content[0].text, new RegExp(hint));
});

test("includes an archive path in a deterministic recovery hint", async () => {
  const archiveDir = "/tmp/erix-archive-recovery";
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "request" },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], {
    keepRounds: 1,
    recoveryHint: `早期轮次的工具输出原文已归档到 ${archiveDir}。必须先读取归档；不要重跑命令。`,
  });

  assert.match(result.messages[0].content[0].text, new RegExp(archiveDir));
  assert.match(result.messages[0].content[0].text, /必须先读取归档/u);
  assert.match(result.messages[0].content[0].text, /不要重跑命令/u);
});

test("merges consecutive fold summaries into one block before the task", async () => {
  const firstMessages = [
    { role: "user", content: "keep this task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a", content: "done" }],
    },
    { role: "assistant", content: [{ type: "text", text: "phase one" }] },
  ];
  const strategy = createFoldStatisticalStrategy();
  const first = await strategy.compact(firstMessages, {
    keepRounds: 1,
    roundNumbers: [1, 2],
  });
  const second = await strategy.compact([
    ...first.messages,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "b", name: "writeFile", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "b", content: "written" }],
    },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
  ], {
    keepRounds: 1,
    roundNumbers: [2, 3, 4],
  });

  const task = second.messages[0];
  const summaries = task.content.filter((block) => (
    block.type === "text" && block.text.startsWith("【上下文折叠·v1·erix-9f6e2c】")
  ));
  assert.equal(summaries.length, 1);
  assert.match(task.content[0].text, /【上下文折叠·v1·erix-9f6e2c】/); // 摘要在 content 最前
  assert.ok(task.content.some((block) => block.text === "keep this task")); // 任务原文仍保留
  assert.match(summaries[0].text, /早期第 1–3 轮（共 3 轮）已折叠/);
  assert.match(summaries[0].text, /exec×1, writeFile×1/);
  assert.equal(second.messages.length, 2);
});

test("call-level undefined does not clear factory options", async () => {
  const result = await createFoldStatisticalStrategy({ summaryRole: "system" }).compact([
    { role: "user", content: "task" },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], { keepRounds: 1, summaryRole: undefined });
  assert.equal(result.messages[0].role, "system");
});

test("legacy fold summaries are read but never removed from user content", async () => {
  const legacy = "【上下文折叠】早期第 1–1 轮（共 1 轮）已折叠。工具足迹：无。可用 recall(pattern: \"关键词\") 搜回细节，或 recall(fromRound: 1, toRound: 1) 取原文（大段可能截断，优先关键词）。";
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: legacy },
    { role: "assistant", content: "old" },
    { role: "user", content: "recent" },
  ], { keepRounds: 1 });
  assert.ok(result.messages[0].content.some((block) => block.text === legacy));
});
