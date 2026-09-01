import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("returns a single-turn final response", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "done");
  assert.equal(result.rounds, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
});

test("feeds tool results back to the provider on the next round", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "found" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "find x",
    executeTool: async (name, input) => `${name}:${input.key}`,
    completion: false,
  });

  assert.equal(result.finalText, "found");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1].messages.at(-1), {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "call-1",
      content: "lookup:x",
    }],
  });
});

test("returns truncated after maxRounds", async () => {
  const provider = createFakeProvider([
    {
      times: 2,
      content: [{ type: "tool_use", id: "call", name: "step", input: { n: 1 } }],
      stopReason: "tool_use",
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "continue",
    maxRounds: 2,
    executeTool: async () => "ok",
    stallDetection: false,
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.finalText, "");
});

test("throws llm_kit_stalled for repeated calls in a full signature window", async () => {
  const provider = createFakeProvider([
    {
      times: 5,
      content: [{ type: "tool_use", id: "call", name: "same", input: { n: 1 } }],
      stopReason: "tool_use",
    },
  ]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "repeat",
      maxRounds: 8,
      executeTool: async () => "ok",
      stallDetection: { window: 2 },
    }),
    (error) => error?.code === "llm_kit_stalled",
  );
  assert.equal(provider.requests.length, 3);
});

test("feeds executeTool errors back as is_error and continues", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "bad", name: "fail", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "run",
    executeTool: async () => {
      throw new Error("permission denied");
    },
    completion: false,
  });

  assert.equal(result.finalText, "recovered");
  assert.deepEqual(provider.requests[1].messages.at(-1).content[0], {
    type: "tool_result",
    tool_use_id: "bad",
    content: "permission denied",
    is_error: true,
  });
});

test("onToolResult can rewrite a result before it is fed back", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "secret", name: "read", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "redacted" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "read",
    executeTool: async () => "top secret",
    completion: false,
    onToolResult: async (name, result) => `${name}:${result.replace("top ", "")}`,
  });

  assert.equal(provider.requests[1].messages.at(-1).content[0].content, "read:secret");
});

test("stores each round snapshot and can rebuild the transcript", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "tool-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    runId: "run-1",
    initialUserMessage: "start",
    executeTool: async () => "worked",
    store,
    completion: false,
  });
  const records = await store.load("run-1");

  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.round), [0, 1, 2]);
  assert.deepEqual(records[0].messages, result.messages.slice(0, 1)); // round 0 种子 = 初始消息入档
  assert.equal(records[1].messages.at(-1).content[0].content, "worked");
  assert.equal(records[2].messages[0].content[0].text, "complete");
  assert.deepEqual(result.messages, records.flatMap((record) => record.messages));
});

test("accumulates input and output usage", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "u1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "done",
    completion: false,
  });

  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 5 });
});

test("stall detection can be disabled", async () => {
  const provider = createFakeProvider([
    {
      times: 3,
      content: [{ type: "tool_use", id: "same", name: "same", input: {} }],
      stopReason: "tool_use",
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "repeat",
    maxRounds: 3,
    executeTool: async () => "ok",
    stallDetection: false,
  });

  assert.equal(result.rounds, 3);
  assert.equal(result.truncated, true);
});

test("ERIX_STALL_MODE env overrides stall detection mode", async () => {
  const previous = process.env.ERIX_STALL_MODE;
  process.env.ERIX_STALL_MODE = "consecutive";
  try {
    // appear 模式下（默认），两个相同调用出现在窗口内即 stalled；
    // consecutive 模式下，交替签名不会触发停滞。
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "a1", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b1", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a2", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b2", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a3", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
    ]);

    const result = await runToolLoop({
      provider,
      initialUserMessage: "env-override",
      maxRounds: 5,
      executeTool: async () => "ok",
      stallDetection: { window: 2 }, // 未指定 mode，应由 ERIX_STALL_MODE 接管
    });
    assert.equal(result.rounds, 5);
    assert.equal(result.truncated, true);
    assert.equal(provider.requests.length, 5);
  } finally {
    if (previous === undefined) {
      delete process.env.ERIX_STALL_MODE;
    } else {
      process.env.ERIX_STALL_MODE = previous;
    }
  }
});
