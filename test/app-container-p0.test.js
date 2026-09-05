import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import {
  KitError,
  classifyFetchException,
} from "../src/providers/errors.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function successfulAnthropicResponse() {
  return {
    json: {
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    },
  };
}

function validProviderOptions(fetchImpl) {
  return {
    endpoint: "https://api.example.test",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  };
}

test("normalizes OpenAI endpoints with and without /v1", async () => {
  for (const endpoint of [
    "https://api.example.test",
    "https://api.example.test/",
    "https://api.example.test/v1",
    "https://api.example.test/v1/",
  ]) {
    const fetchImpl = createMockFetch([{
      json: { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
    }]);
    const provider = createOpenAIProvider({
      ...validProviderOptions(fetchImpl),
      endpoint,
    });

    await provider.chat({ system: "", messages: [] });
    assert.equal(fetchImpl.calls[0].url, "https://api.example.test/v1/chat/completions");
  }
});

test("fails fast for missing or non-string provider configuration without fetching", async () => {
  for (const [name, createProvider] of [
    ["OpenAI", createOpenAIProvider],
    ["Anthropic", createAnthropicProvider],
  ]) {
    for (const field of ["endpoint", "apiKey", "model"]) {
      let fetchCalls = 0;
      const fetchImpl = async () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called");
      };
      const missing = validProviderOptions(fetchImpl);
      delete missing[field];

      assert.throws(
        () => createProvider(missing),
        (error) => error instanceof KitError
          && error.code === "provider_config"
          && error.message.includes(field),
      );

      const nonString = { ...validProviderOptions(fetchImpl), [field]: 42 };
      assert.throws(
        () => createProvider(nonString),
        (error) => error instanceof KitError
          && error.code === "provider_config"
          && error.message.includes(field),
      );
      assert.equal(fetchCalls, 0, `${name} ${field} validation fetched unexpectedly`);
    }
  }
});

test("uses Anthropic max_tokens=4096 through direct and loop requests", async () => {
  const directFetch = createMockFetch([successfulAnthropicResponse()]);
  await createAnthropicProvider(validProviderOptions(directFetch)).chat({
    system: "",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(directFetch.calls[0].body.max_tokens, 4096);

  const loopFetch = createMockFetch([successfulAnthropicResponse()]);
  const result = await runToolLoop({
    provider: createAnthropicProvider(validProviderOptions(loopFetch)),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });
  assert.equal(result.finalText, "done");
  assert.equal(loopFetch.calls[0].body.max_tokens, 4096);

  const configuredFetch = createMockFetch([successfulAnthropicResponse()]);
  await createAnthropicProvider({
    ...validProviderOptions(configuredFetch),
    maxOutputTokens: 123,
  }).chat({ system: "", messages: [] });
  assert.equal(configuredFetch.calls[0].body.max_tokens, 123);
});

test("classifies AbortError and aborted signals as non-retryable aborted errors", () => {
  const abortError = new Error("fetch aborted");
  abortError.name = "AbortError";
  const classified = classifyFetchException(abortError);
  assert.equal(classified.code, "aborted");
  assert.equal(classified.retryable, false);

  const controller = new AbortController();
  controller.abort(new Error("user stopped"));
  const signalClassified = classifyFetchException(new Error("fetch failed"), {
    signal: controller.signal,
  });
  assert.equal(signalClassified.code, "aborted");
  assert.equal(signalClassified.retryable, false);
});

test("does not retry a fetch AbortError during an OpenAI stream", async () => {
  const streamAbort = new Error("stream aborted");
  streamAbort.name = "AbortError";
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return {
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ));
          controller.error(streamAbort);
        },
      }),
    };
  };
  const sleeps = [];

  await assert.rejects(
    runToolLoop({
      provider: createOpenAIProvider(validProviderOptions(fetchImpl)),
      initialUserMessage: "hello",
      executeTool: async () => "unused",
      stream: true,
      retry: {
        attempts: 3,
        sleepImpl: async (ms) => sleeps.push(ms),
      },
    }),
    (error) => error instanceof KitError
      && error.code === "aborted"
      && error.retryable === false,
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(sleeps, []);
});

test("external abort remains the winning OpenAI stream failure", async () => {
  const controller = new AbortController();
  const reason = new Error("user stopped");
  const fetchImpl = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("fetch abort")), { once: true });
  });
  const provider = createOpenAIProvider({
    ...validProviderOptions(fetchImpl),
    requestTimeoutMs: 1000,
  });
  const run = provider.chatStream({
    system: "",
    messages: [{ role: "user", content: "hello" }],
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(reason);

  await assert.rejects(run, (error) => error === reason);
});

test("returns truncated when max-token continuations are exhausted", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "one" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "two" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "three" }], stopReason: "max_tokens" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "write",
    executeTool: async () => "unused",
    maxTokenContinuations: 2,
  });

  assert.equal(result.finalText, "onetwothree");
  assert.equal(result.rounds, 1);
  assert.equal(result.truncated, true);
  assert.equal(provider.requests.length, 3);
});

test("includes the canonical response summary in onRound records", async () => {
  const records = [];
  const provider = createFakeProvider([
    {
      content: [
        { type: "text", text: "plan" },
        { type: "tool_use", id: "call-1", name: "write", input: { path: "x" } },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 2, output_tokens: 3 },
    },
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 1 },
    },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "write",
    executeTool: async () => "written",
    completion: false,
    onRound: async (record) => records.push(record),
  });

  assert.equal(records.length, 2);
  assert.deepEqual(records[0].response, {
    content: [
      { type: "text", text: "plan" },
      { type: "tool_use", id: "call-1", name: "write", input: { path: "x" } },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  assert.equal(records[0].textPreview, "plan");
  assert.equal(records[0].toolUses, 1);
  assert.deepEqual(records[1].response, {
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 1 },
  });
  assert.equal(records[1].textPreview, "done");
  assert.equal(records[1].toolUses, 0);
});

test("stall detection consecutive mode softens repeats and stops only after a streak", async (t) => {
  await t.test("nudges repeated identical calls, then the model turns and finishes", async () => {
    // window:2 consecutive → 需连续 3 次相同才首次 stalled（第3次时窗口满2）
    // 前 3 次 a1: 第3次 stalled → streak=1 → nudge 注入
    // 模型转向 b1 → 正常完成
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "a1", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a2", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a3", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b1", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    const result = await runToolLoop({
      provider,
      initialUserMessage: "repeat",
      executeTool: async () => "ok",
      completion: false,
      stallDetection: { window: 2, mode: "consecutive" },
    });
    assert.equal(result.termination.reason, "end_turn");
    assert.equal(result.truncated, false);
    // 第3次 a1 stalled → streak=1 → nudge 注入；第4次请求（b1 前）应含 nudge 文本
    const nudgeInjected = provider.requests.some((request) => (
      request.messages.some((message) => (
        Array.isArray(message.content)
        && message.content.some((block) => /疑似重复调用.*推进新步骤/.test(block.text ?? ""))
      ))
    ));
    assert.equal(nudgeInjected, true);
  });

  await t.test("stops normally after the stall streak limit", async () => {
    // window:2 consecutive：每 2 轮窗口满一次触发 stalled；streak 不清零（同签名继续）
    // round3 stalled(1) → nudge → round5 stalled(2) → nudge → round7 stalled(3) → stop
    const provider = createFakeProvider([{
      times: 9,
      content: [{ type: "tool_use", id: "call", name: "write", input: { n: 1 } }],
      stopReason: "tool_use",
    }]);

    const result = await runToolLoop({
      provider,
      initialUserMessage: "repeat",
      maxRounds: 9,
      executeTool: async () => "ok",
      completion: false,
      stallDetection: { window: 2, mode: "consecutive" },
    });
    assert.equal(result.termination.reason, "stall");
    assert.equal(result.truncated, true);
    assert.equal(provider.requests.length, 7);
  });

  await t.test("allows interleaved signatures", async () => {
    const provider = createFakeProvider([
      { content: [{ type: "tool_use", id: "a1", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b1", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a2", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "b2", name: "write", input: { n: 2 } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "a3", name: "write", input: { n: 1 } }], stopReason: "tool_use" },
    ]);

    const result = await runToolLoop({
      provider,
      initialUserMessage: "interleave",
      executeTool: async () => "ok",
      maxRounds: 5,
      stallDetection: { window: 2, mode: "consecutive" },
    });
    assert.equal(result.rounds, 5);
    assert.equal(result.truncated, true);
    assert.equal(provider.requests.length, 5);
  });
});
