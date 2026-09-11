import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop.js";

function createStreamingProvider(script) {
  const streamCalls = [];
  const steps = [...script];
  let index = 0;

  const nextResponse = () => {
    if (index >= steps.length) throw new Error("streaming provider script exhausted");
    const step = steps[index];
    index += 1;
    return step;
  };

  return {
    streamCalls,
    async chatStream(request) {
      streamCalls.push(request);
      const step = nextResponse();
      for (const chunk of step.deltas ?? []) {
        request.onDelta?.(chunk);
      }
      return step.response;
    },
  };
}

test("streams text deltas and keeps the batch loop result", async () => {
  const streamedChunks = [];
  const streamProvider = createStreamingProvider([{
    deltas: ["你", "好"],
    response: {
      content: [{ type: "text", text: "你好" }],
      stopReason: "end_turn",
      usage: {},
    },
  }]);
  const streamed = await runToolLoop({
    provider: streamProvider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => streamedChunks.push(chunk),
  });

  const batchProvider = {
    async chat() {
      return {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
        usage: {},
      };
    },
  };
  const batch = await runToolLoop({
    provider: batchProvider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.deepEqual(streamedChunks, ["你", "好"]);
  assert.equal(streamed.finalText, batch.finalText);
  assert.equal(streamed.rounds, batch.rounds);
  assert.equal(streamProvider.streamCalls.length, 1);
});

test("passes deltas through before chatStream returns when retry is disabled", async () => {
  const order = [];
  const provider = {
    async chatStream(request) {
      order.push("chatStream:start");
      for (const chunk of ["你", "好"]) {
        request.onDelta?.(chunk);
        order.push(`provider:delta:${chunk}`);
      }
      order.push("chatStream:return");
      return {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
      };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => order.push(`onDelta:${chunk}`),
  });

  assert.deepEqual(order, [
    "chatStream:start",
    "onDelta:你",
    "provider:delta:你",
    "onDelta:好",
    "provider:delta:好",
    "chatStream:return",
  ]);
});

test("holds deltas until the successful attempt when retry is enabled", async () => {
  const order = [];
  let calls = 0;
  const provider = {
    async chatStream(request) {
      calls += 1;
      order.push(`chatStream:start:${calls}`);
      request.onDelta?.(calls === 1 ? "失败" : "成功");
      order.push(`chatStream:return:${calls}`);
      if (calls === 1) {
        const error = new Error("connection reset");
        error.retryable = true;
        throw error;
      }
      return {
        content: [{ type: "text", text: "成功" }],
        stopReason: "end_turn",
      };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => order.push(`onDelta:${chunk}`),
    retry: {
      attempts: 1,
      backoffBaseMs: 0,
      sleepImpl: async () => {},
    },
  });

  assert.deepEqual(order, [
    "chatStream:start:1",
    "chatStream:return:1",
    "chatStream:start:2",
    "chatStream:return:2",
    "onDelta:成功",
  ]);
});

test("streams tool-loop responses while executing tools normally", async () => {
  const streamedChunks = [];
  const executed = [];
  const provider = createStreamingProvider([
    {
      response: {
        content: [{
          type: "tool_use",
          id: "call-1",
          name: "lookup",
          input: { key: "x" },
        }],
        stopReason: "tool_use",
        usage: {},
      },
    },
    {
      deltas: ["你", "好"],
      response: {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
        usage: {},
      },
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "find x",
    executeTool: async (name, input) => {
      executed.push({ name, input });
      return "found";
    },
    completion: false,
    stream: true,
    onDelta: (chunk) => streamedChunks.push(chunk),
  });

  assert.equal(result.finalText, "你好");
  assert.equal(result.rounds, 2);
  assert.equal(provider.streamCalls.length, 2);
  assert.deepEqual(streamedChunks, ["你", "好"]);
  assert.deepEqual(executed, [{ name: "lookup", input: { key: "x" } }]);
});

test("falls back to chat when streaming is unavailable", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      return {
        content: [{ type: "text", text: "批式回复" }],
        stopReason: "end_turn",
        usage: {},
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
  });

  assert.equal(result.finalText, "批式回复");
  assert.equal(result.rounds, 1);
  assert.equal(calls.length, 1);
});

test("does not stream unless explicitly enabled", async () => {
  const provider = createStreamingProvider([{
    deltas: ["批式"],
    response: {
      content: [{ type: "text", text: "批式" }],
      stopReason: "end_turn",
      usage: {},
    },
  }]);
  const batchCalls = [];
  provider.chat = async () => {
    batchCalls.push(true);
    return {
      content: [{ type: "text", text: "批式" }],
      stopReason: "end_turn",
      usage: {},
    };
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "批式");
  assert.equal(provider.streamCalls.length, 0);
  assert.equal(batchCalls.length, 1);
});
