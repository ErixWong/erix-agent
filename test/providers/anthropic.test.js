import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { KitError } from "../../src/providers/errors.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const request = {
  system: "You are helpful.",
  messages: [
    { role: "user", content: "Call the tool." },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_1",
        name: "lookup",
        input: { key: "value" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "found",
      }],
    },
  ],
  tools: [{
    name: "lookup",
    description: "Look up a value.",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  }],
  maxTokens: 256,
  temperature: 0.2,
  topP: 0.9,
};

function makeProvider(responseScript, options = {}) {
  const fetchImpl = createMockFetch(responseScript);
  const provider = createAnthropicProvider({
    endpoint: "https://api.example.test",
    apiKey: "test-key",
    model: "claude-test",
    fetchImpl,
    ...options,
  });
  return { fetchImpl, provider };
}

test("serializes Anthropic request messages, tools, and parameters", async () => {
  const { fetchImpl, provider } = makeProvider([{
    json: {
      content: [{ type: "text", text: "Done" }],
      stop_reason: "end_turn",
    },
  }]);

  await provider.chat(request);

  assert.deepEqual(fetchImpl.calls, [{
    url: "https://api.example.test/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: {
      model: "claude-test",
      system: "You are helpful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Call the tool." }] },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: { key: "value" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "found",
          }],
        },
      ],
      tools: [{
        name: "lookup",
        description: "Look up a value.",
        input_schema: { type: "object", properties: { key: { type: "string" } } },
      }],
      max_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
    },
  }]);
});

test("parses non-streaming responses and supports an endpoint ending in /v1", async () => {
  const { provider } = makeProvider([{
    json: {
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 4 },
    },
  }], { endpoint: "https://api.example.test/v1/" });

  assert.deepEqual(await provider.chat({
    system: "",
    messages: [{ role: "user", content: "Hi" }],
    maxTokens: 64,
  }), {
    content: [{ type: "text", text: "Hello" }],
    stopReason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 4 },
  });
});

test("assembles streaming text, tool JSON, and merged usage", async () => {
  const deltas = [];
  const { fetchImpl, provider } = makeProvider([{
    body: [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop","index":0}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"key\\":"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"value\\"}"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop","index":1}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""),
  }]);

  const response = await provider.chatStream({
    ...request,
    onDelta: (text) => deltas.push(text),
  });

  assert.deepEqual(deltas, ["Hi ", "there"]);
  assert.deepEqual(response, {
    content: [
      { type: "text", text: "Hi there" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "value" } },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 9, output_tokens: 6 },
  });
  assert.equal(fetchImpl.calls[0].body.stream, true);
});

test("classifies timeout, rate limit, auth, server, and network errors", async (t) => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const cases = [
    { name: "timeout", script: [{ throw: abortError }], code: "timeout", retryable: true },
    {
      name: "rate limited",
      script: [{ status: 429, json: { error: { message: "Slow down" } } }],
      code: "rate_limited",
      retryable: true,
    },
    {
      name: "auth",
      script: [{ status: 401, json: { error: { message: "Bad key" } } }],
      code: "auth",
      retryable: false,
    },
    {
      name: "server",
      script: [{ status: 500, json: { error: { message: "Upstream failed" } } }],
      code: "server",
      retryable: true,
    },
    {
      name: "network",
      script: [{ throw: new TypeError("fetch failed") }],
      code: "network",
      retryable: false,
    },
  ];

  for (const errorCase of cases) {
    await t.test(errorCase.name, async () => {
      const { provider } = makeProvider(errorCase.script);
      await assert.rejects(
        provider.chat({ system: "", messages: [], maxTokens: 32 }),
        (err) => {
          assert.ok(err instanceof KitError);
          assert.equal(err.code, errorCase.code);
          assert.equal(err.retryable, errorCase.retryable);
          return true;
        },
      );
    });
  }
});

test("passes through error bodies for non-2xx and 2xx error responses", async () => {
  const non2xx = makeProvider([{
    status: 400,
    json: { type: "error", error: { type: "invalid_request", message: "Invalid request" } },
  }]);
  await assert.rejects(
    non2xx.provider.chat({ system: "", messages: [], maxTokens: 32 }),
    (err) => {
      assert.equal(err.code, "unknown");
      assert.equal(err.message, "Invalid request");
      assert.equal(err.status, 400);
      return true;
    },
  );

  const twoxx = makeProvider([{
    status: 200,
    json: { type: "error", error: { type: "overloaded", message: "Try later" } },
  }]);
  await assert.rejects(
    twoxx.provider.chat({ system: "", messages: [], maxTokens: 32 }),
    (err) => {
      assert.equal(err.code, "server");
      assert.equal(err.message, "Try later");
      return true;
    },
  );
});

test("truncates unparseable error bodies and forwards all stream deltas", async () => {
  const raw = "x".repeat(700);
  const { provider } = makeProvider([{ status: 500, body: raw }]);
  await assert.rejects(
    provider.chat({ system: "", messages: [], maxTokens: 32 }),
    (err) => {
      assert.equal(err.code, "server");
      assert.equal(err.message, raw.slice(0, 500));
      return true;
    },
  );

  const deltas = [];
  const streamProvider = makeProvider([{
    body: [
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"b"}}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""),
  }]);
  await streamProvider.provider.chatStream({
    system: "",
    messages: [{ role: "user", content: "go" }],
    maxTokens: 32,
    onDelta: (text) => deltas.push(text),
  });
  assert.deepEqual(deltas, ["a", "b"]);
});
