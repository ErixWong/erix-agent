import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { KitError, classifyFetchException, classifyHttpError } from "../../src/providers/errors.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function openAIProvider(responseScript, options = {}) {
  return createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: createMockFetch(responseScript),
    ...options,
  });
}

function anthropicProvider(responseScript, options = {}) {
  return createAnthropicProvider({
    endpoint: "https://api.example.test",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: createMockFetch(responseScript),
    maxTokens: 64,
    ...options,
  });
}

const streamRequest = {
  system: "",
  messages: [{ role: "user", content: "hello" }],
};

test("OpenAI emits reasoning, incremental tool-call, usage, and neutral events", async () => {
  const events = [];
  const reasoning = [];
  const toolCalls = [];
  const usage = [];
  const provider = openAIProvider([{
    body: [
      sse({ choices: [{ delta: { reasoning_content: "think " }, finish_reason: null }] }),
      sse({ choices: [{ delta: { content: "done" }, finish_reason: null }] }),
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-1",
              function: { name: "lookup", arguments: "{\"city\":" },
            }],
          },
          finish_reason: null,
        }],
      }),
      sse({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] },
          finish_reason: "tool_calls",
        }],
      }),
      sse({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);

  const response = await provider.chatStream({
    ...streamRequest,
    onEvent: (event) => events.push(event),
    onReasoningDelta: (delta) => reasoning.push(delta),
    onToolCall: (fragment) => toolCalls.push(fragment),
    onUsage: (reportedUsage) => usage.push(reportedUsage),
  });

  assert.deepEqual(reasoning, ["think "]);
  assert.deepEqual(toolCalls, [
    {
      index: 0,
      id: "call-1",
      name: "lookup",
      argumentsDelta: "{\"city\":",
    },
    {
      index: 0,
      id: "call-1",
      argumentsDelta: "\"Paris\"}",
    },
  ]);
  assert.deepEqual(usage, [{ prompt_tokens: 4, completion_tokens: 5 }]);
  assert.deepEqual(response.content, [
    { type: "reasoning", text: "think " },
    { type: "text", text: "done" },
    { type: "tool_use", id: "call-1", name: "lookup", input: { city: "Paris" } },
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning_delta",
    "delta",
    "tool_call",
    "tool_call",
    "usage",
  ]);
});

test("Anthropic assembles thinking snapshots/signatures and emits tool fragments", async () => {
  const events = [];
  const reasoning = [];
  const toolCalls = [];
  const usage = [];
  const provider = anthropicProvider([{
    body: [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thin"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta.snapshot","thinking":"thinking"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu-1","name":"lookup","input":{}}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""),
  }]);

  const response = await provider.chatStream({
    ...streamRequest,
    onEvent: (event) => events.push(event),
    onReasoningDelta: (delta) => reasoning.push(delta),
    onToolCall: (fragment) => toolCalls.push(fragment),
    onUsage: (reportedUsage) => usage.push(reportedUsage),
  });

  assert.deepEqual(reasoning, ["thin", "king"]);
  assert.deepEqual(toolCalls, [
    { index: 1, id: "toolu-1", name: "lookup" },
    {
      index: 1,
      id: "toolu-1",
      name: "lookup",
      argumentsDelta: "{\"x\":1}",
    },
  ]);
  assert.deepEqual(usage, [{ input_tokens: 3, output_tokens: 6 }]);
  assert.deepEqual(response.content, [
    { type: "reasoning", text: "thinking", signature: "sig" },
    { type: "tool_use", id: "toolu-1", name: "lookup", input: { x: 1 } },
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning_delta",
    "reasoning_delta",
    "reasoning_delta",
    "tool_call",
    "tool_call",
    "usage",
  ]);
});

function pendingResponse({ firstChunk } = {}) {
  let sent = false;
  return {
    status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (firstChunk && !sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(firstChunk));
          return;
        }
      },
    }),
  };
}

test("stream request timeout reports request phase and elapsed time", async () => {
  const provider = openAIProvider([], {
    requestTimeoutMs: 5,
    firstByteTimeoutMs: 100,
    streamIdleTimeoutMs: 100,
    streamTotalTimeoutMs: 100,
    fetchImpl: () => new Promise(() => {}),
  });

  await assert.rejects(
    provider.chatStream(streamRequest),
    (error) => error instanceof KitError
      && error.code === "timeout"
      && error.retryable === true
      && error.phase === "request"
      && error.elapsedMs >= 0,
  );
});

test("stream first-byte timeout protects a response that never yields data", async () => {
  const provider = openAIProvider([], {
    requestTimeoutMs: 100,
    firstByteTimeoutMs: 5,
    streamIdleTimeoutMs: 100,
    streamTotalTimeoutMs: 100,
    fetchImpl: async () => pendingResponse(),
  });

  await assert.rejects(
    provider.chatStream(streamRequest),
    (error) => error instanceof KitError && error.phase === "firstByte",
  );
});

test("stream idle and total timeouts identify their respective phases", async (t) => {
  await t.test("idle", async () => {
    const provider = openAIProvider([], {
      requestTimeoutMs: 100,
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 5,
      streamTotalTimeoutMs: 100,
      fetchImpl: async () => pendingResponse({
        firstChunk: sse({ choices: [{ delta: { content: "a" } }] }),
      }),
    });
    await assert.rejects(
      provider.chatStream(streamRequest),
      (error) => error instanceof KitError
        && error.code === "timeout"
        && error.retryable === true
        && error.phase === "streamIdle"
        && error.elapsedMs >= 0,
    );
  });

  await t.test("total", async () => {
    const provider = openAIProvider([], {
      requestTimeoutMs: 100,
      firstByteTimeoutMs: 100,
      streamIdleTimeoutMs: 100,
      streamTotalTimeoutMs: 5,
      fetchImpl: async () => pendingResponse({
        firstChunk: sse({ choices: [{ delta: { content: "a" } }] }),
      }),
    });
    await assert.rejects(
      provider.chatStream(streamRequest),
      (error) => error instanceof KitError
        && error.code === "timeout"
        && error.retryable === true
        && error.phase === "streamTotal"
        && error.elapsedMs >= 0,
    );
  });
});

test("classifies disconnect codes and gateway statuses as retryable", () => {
  for (const code of ["ECONNRESET", "EPIPE", "EAI_AGAIN", "ENOTFOUND"]) {
    const error = new Error(code);
    error.code = code;
    const classified = classifyFetchException(error);
    assert.equal(classified.code, "network");
    assert.equal(classified.retryable, true);
  }
  for (const status of [502, 503, 504]) {
    const classified = classifyHttpError(status, "gateway");
    assert.equal(classified.code, "server");
    assert.equal(classified.retryable, true);
    assert.equal(classified.status, status);
  }
});
