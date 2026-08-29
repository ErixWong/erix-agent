import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function retryableError(message = "temporary failure") {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

test("retries a retryable provider error with the original messages", async () => {
  const provider = createFakeProvider([
    { throw: retryableError() },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const sleeps = [];

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    retry: { sleepImpl: async (ms) => sleeps.push(ms) },
  });

  assert.equal(result.finalText, "done");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1].messages, provider.requests[0].messages);
  assert.deepEqual(sleeps, [1500]);
  assert.deepEqual(result.compactionStats, []);
});

test("exhausts retry attempts and uses exponential capped backoff", async () => {
  const exhausted = retryableError("still failing");
  const provider = createFakeProvider([{ throw: exhausted, times: 3 }]);
  const sleeps = [];

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "hello",
      executeTool: async () => "unused",
      retry: {
        attempts: 2,
        sleepImpl: async (ms) => sleeps.push(ms),
      },
    }),
    (error) => error === exhausted,
  );

  assert.equal(provider.requests.length, 3);
  assert.deepEqual(sleeps, [1500, 3000]);
});

test("does not retry a non-retryable provider error", async () => {
  const failure = new Error("invalid request");
  let slept = false;
  const provider = createFakeProvider([{ throw: failure }]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "hello",
      executeTool: async () => "unused",
      retry: {
        attempts: 3,
        sleepImpl: async () => {
          slept = true;
        },
      },
    }),
    (error) => error === failure,
  );

  assert.equal(provider.requests.length, 1);
  assert.equal(slept, false);
});

test("ends completion when a signal appears in a no-tool response", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "lookup-1", name: "lookup", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "结果已完成: DONE" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "查找结果",
    executeTool: async () => "found",
    completion: { signals: ["DONE"] },
  });

  assert.equal(result.finalText, "结果已完成: DONE");
  assert.equal(result.rounds, 2);
  assert.equal(result.truncated, false);
  assert.equal(provider.requests.length, 2);
});

test("ends immediately when completion has no tool history", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "普通回复" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "你好",
    executeTool: async () => "unused",
    completion: { signals: ["DONE"] },
  });

  assert.equal(result.rounds, 1);
  assert.equal(result.truncated, false);
  assert.equal(provider.requests.length, 1);
});

test("continues after transition text when tools were used", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "处理中" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "完成 DONE" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "开始",
    executeTool: async () => "ok",
    completion: { signals: ["DONE"], maxNoToolRounds: 3 },
  });

  assert.equal(result.finalText, "完成 DONE");
  assert.equal(result.rounds, 3);
  assert.deepEqual(provider.requests[2].messages.at(-1), {
    role: "user",
    content: [{ type: "text", text: "（请继续完成任务）" }],
  });
});

test("forces completion after maxNoToolRounds without a signal", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "过渡一" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "过渡二" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "不应调用" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "开始",
    executeTool: async () => "ok",
    completion: { signals: ["DONE"], maxNoToolRounds: 2 },
  });

  assert.equal(result.finalText, "过渡二");
  assert.equal(result.rounds, 3);
  assert.equal(result.truncated, false);
  assert.equal(provider.requests.length, 3);
});

test("completion false preserves the v0.0 end-turn behavior", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "过渡文本" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "开始",
    executeTool: async () => "ok",
    completion: false,
  });

  assert.equal(result.finalText, "过渡文本");
  assert.equal(result.rounds, 2);
  assert.equal(provider.requests.length, 2);
});

test("continues max_tokens responses in one assistant message", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "part-1" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "part-2" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "write",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "part-1part-2done");
  assert.deepEqual(result.messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "part-1part-2done" }],
  });
  assert.deepEqual(provider.requests[1].messages.at(-1), {
    role: "assistant",
    content: [{ type: "text", text: "part-1" }],
  });
  assert.deepEqual(provider.requests[2].messages.at(-1), {
    role: "assistant",
    content: [{ type: "text", text: "part-1part-2" }],
  });
  assert.equal(result.rounds, 1);
});

test("merges adjacent assistant messages before every provider call", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider,
    initialMessages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ],
    executeTool: async () => "unused",
  });

  assert.deepEqual(provider.requests[0].messages, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  ]);
});

test("compacts context before the second round and records its payload and stats", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const shouldCompactCalls = [];
  const records = [];
  const foldedPayload = [{ round: 1, text: "original context" }];
  const replacement = [{
    role: "user",
    content: [{ type: "text", text: "compacted context" }],
  }];
  const strategy = {
    shouldCompact(messages, budgetTokens) {
      shouldCompactCalls.push({ messages, budgetTokens });
      return shouldCompactCalls.length === 2;
    },
    async compact(messages, options) {
      assert.equal(messages.at(-1).role, "user");
      assert.deepEqual(options, { keepRounds: 4, budgetTokens: 99 });
      return {
        messages: replacement,
        compacted: true,
        foldedRounds: 1,
        tokensBefore: 120,
        tokensAfter: 20,
        foldedPayload,
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    context: { strategy, budgetTokens: 99, keepRounds: 4 },
    store: {
      async appendRound(_runId, record) {
        records.push(structuredClone(record));
      },
    },
    runId: "fr2",
  });

  assert.equal(shouldCompactCalls.length, 2);
  assert.equal(shouldCompactCalls[0].budgetTokens, 99);
  assert.deepEqual(provider.requests[1].messages[0], replacement[0]);
  assert.equal(records[1].folded, true);
  assert.deepEqual(records[1].foldedPayload, foldedPayload);
  assert.deepEqual(result.compactionStats, [{
    compacted: true,
    foldedRounds: 1,
    tokensBefore: 120,
    tokensAfter: 20,
  }]);
});
