import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
import { KitError } from "../src/providers/errors.js";

test("rejects invalid initial message pairs before the first provider call", async () => {
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      return { content: [{ type: "text", text: "unexpected" }], stopReason: "end_turn" };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      initialMessages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "bad" }],
      }],
      executeTool: async () => "unused",
    }),
    (error) => error instanceof KitError && error.code === "invalid_messages",
  );
  assert.equal(calls, 0);
});

test("revalidates messages before each later provider round", async () => {
  let calls = 0;
  const provider = {
    async chat(request) {
      calls += 1;
      if (calls === 1) {
        request.messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "orphan", content: "bad" }],
        });
        return {
          content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "unexpected" }], stopReason: "end_turn" };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "start",
      executeTool: async () => "done",
      completion: false,
    }),
    (error) => error instanceof KitError && error.code === "invalid_messages",
  );
  assert.equal(calls, 1);
});

test("allows a truncated tool response to request its continuation", async () => {
  const requests = [];
  const provider = {
    async chat(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
          stopReason: "max_tokens",
        };
      }
      return {
        content: [{ type: "text", text: "continued" }],
        stopReason: "end_turn",
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "unused",
    completion: false,
  });

  assert.equal(requests.length, 2);
  assert.equal(result.finalText, "continued");
});

test("compacts over-budget messages during max_tokens continuation", async () => {
  // reasoning 模型单次响应常因推理过长触发 max_tokens 截断；
  // 若 messages 已超预算，补全循环内应先压缩再继续（Issue #11）
  let compactedCalls = 0;
  let requests = 0;
  const strategy = {
    async shouldCompact() {
      return true;
    },
    async compact(messages, options) {
      compactedCalls += 1;
      return { messages: [{ role: "user", content: [{ type: "text", text: "[折叠摘要]" }] }], compacted: true };
    },
  };
  const provider = {
    async chat(request) {
      requests += 1;
      if (requests === 1) {
        // 首次响应 max_tokens 截断且无工具调用
        return { content: [{ type: "text", text: "long reasoning..." }], stopReason: "max_tokens" };
      }
      return { content: [{ type: "text", text: "最终答复" }], stopReason: "end_turn" };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "unused",
    completion: false,
    context: { strategy, budgetTokens: 10 }, // 小预算确保超限
  });

  assert.ok(compactedCalls >= 1, "补全循环内应触发至少一次压缩");
  // 压缩后 messages 被折叠摘要替换，最终答复包含折叠后的内容
  assert.ok(result.finalText.includes("最终答复") || result.finalText.includes("折叠"));
});
