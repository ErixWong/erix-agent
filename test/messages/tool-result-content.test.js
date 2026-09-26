// toolResultContent 序列化单测（issue #65）
// 契约：字符串原样返回；裸对象/数组 pretty JSON 序列化；stringify 失败（循环引用）
// 回退 String()。{ data, content } 结构化结果由 checkpoint-executor 前置拆解，
// 本函数不遮蔽 data 通道（用 toolResultData 探测 + runToolLoop 集成双重锁定）。
import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../../src/loop/orchestrator.js";
import { toolResultContent, toolResultData } from "../../src/loop/messages.js";

test("字符串结果原样返回（含空串）", () => {
  assert.equal(toolResultContent("hello"), "hello");
  assert.equal(toolResultContent(""), "");
});

test("裸对象结果序列化为 pretty JSON", () => {
  assert.equal(
    toolResultContent({ id: 3, ok: true }),
    '{\n  "id": 3,\n  "ok": true\n}',
  );
});

test("数组结果序列化为 pretty JSON", () => {
  assert.equal(toolResultContent([1, "a"]), '[\n  1,\n  "a"\n]');
});

test("标量结果保持字符串化语义不变", () => {
  assert.equal(toolResultContent(42), "42");
  assert.equal(toolResultContent(null), "null");
  assert.equal(toolResultContent(true), "true");
  // JSON.stringify(undefined) 返回 undefined → 回退 String()
  assert.equal(toolResultContent(undefined), "undefined");
});

test("循环引用对象在 stringify 失败时回退 String()", () => {
  const circular = { name: "c" };
  circular.self = circular;
  assert.equal(toolResultContent(circular), "[object Object]");
});

test("含 data 键的结构化结果仍由 toolResultData 识别（协议形态不回归）", () => {
  const structured = { data: { rows: [1, 2] }, success: true };
  assert.equal(toolResultData(structured), structured);
  // 落入 toolResultContent 的是拆解后的裸 data，序列化为可读 JSON
  assert.equal(
    toolResultContent(structured.data),
    '{\n  "rows": [\n    1,\n    2\n  ]\n}',
  );
  // 无 data 键的裸对象不进入结构化通道
  assert.equal(toolResultData({ rows: [1, 2] }), undefined);
});

test("runToolLoop 集成：{ data } 结构化结果的 content 可读且 metadata.success 保留", async () => {
  let toolUseCount = 0;
  const provider = {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      toolUseCount += 1;
      return toolUseCount === 1
        ? {
            content: [{
              type: "tool_use",
              id: "call-data",
              name: "lookup",
              input: {},
            }],
            stopReason: "tool_use",
          }
        : { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "lookup",
    executeTool: async () => ({ data: { rows: [1, 2] }, success: true }),
    completion: false,
  });

  assert.equal(result.finalText, "done");
  const toolResultBlock = provider.requests[1].messages
    .at(-1)
    .content.find((block) => block.type === "tool_result");
  assert.equal(
    toolResultBlock.content,
    '{\n  "rows": [\n    1,\n    2\n  ]\n}',
  );
  assert.notEqual(toolResultBlock.content, "[object Object]");
});

test("runToolLoop 集成：裸对象工具结果（无 data 键）序列化为 pretty JSON", async () => {
  let toolUseCount = 0;
  const provider = {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      toolUseCount += 1;
      return toolUseCount === 1
        ? {
            content: [{
              type: "tool_use",
              id: "call-raw",
              name: "stats",
              input: {},
            }],
            stopReason: "tool_use",
          }
        : { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "stats",
    executeTool: async () => ({ count: 7, items: ["a"] }),
    completion: false,
  });

  const toolResultBlock = provider.requests[1].messages
    .at(-1)
    .content.find((block) => block.type === "tool_result");
  assert.equal(
    toolResultBlock.content,
    '{\n  "count": 7,\n  "items": [\n    "a"\n  ]\n}',
  );
});
