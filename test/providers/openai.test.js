import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KitError,
} from "../../src/providers/errors.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const request = {
  system: "You are a helpful assistant.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Please call the weather tool." }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will check." },
        {
          type: "tool_use",
          id: "call_weather",
          name: "get_weather",
          input: { city: "Paris", units: "metric" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_weather",
          content: '{"temperature":18}',
        },
      ],
    },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get current weather.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  maxTokens: 256,
  temperature: 0.2,
  topP: 0.9,
};

function makeProvider(responseScript, options = {}) {
  const fetchImpl = createMockFetch(responseScript);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1/",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    ...options,
  });
  return { fetchImpl, provider };
}

test("serializes canonical messages, tools, and optional parameters", async () => {
  const { fetchImpl, provider } = makeProvider([
    {
      json: {
        choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
      },
    },
  ]);

  await provider.chat(request);

  assert.deepEqual(fetchImpl.calls, [
    {
      url: "https://api.example.test/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Please call the weather tool." },
          {
            role: "assistant",
            content: "I will check.",
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris","units":"metric"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_weather",
            content: '{"temperature":18}',
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
      },
    },
  ]);
});

test("parses text response, usage, and stop finish reason", async () => {
  const { provider } = makeProvider([
    {
      json: {
        choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
    },
  ]);

  assert.deepEqual(await provider.chat({
    system: "",
    messages: [{ role: "user", content: "Hi" }],
  }), {
    content: [{ type: "text", text: "Hello" }],
    stopReason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 4 },
  });
});

test("parses a single tool call and normalizes tool_calls finish reason", async () => {
  const { provider } = makeProvider([
    {
      json: {
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"key":"value"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    },
  ]);

  const response = await provider.chat({
    system: "",
    messages: [{ role: "user", content: "Look it up." }],
  });
  assert.deepEqual(response, {
    content: [{
      type: "tool_use",
      id: "call_1",
      name: "lookup",
      input: { key: "value" },
    }],
    stopReason: "tool_use",
  });
  assert.equal(response.usage, undefined);
});

test("parses multiple tool calls and normalizes length finish reason", async () => {
  const { provider } = makeProvider([
    {
      json: {
        choices: [{
          message: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "first", arguments: "{}" },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "second", arguments: '{"n":2}' },
              },
            ],
          },
          finish_reason: "length",
        }],
      },
    },
  ]);

  const response = await provider.chat({
    system: "",
    messages: [{ role: "user", content: "Use both." }],
  });
  assert.deepEqual(response.content, [
    { type: "tool_use", id: "call_1", name: "first", input: {} },
    { type: "tool_use", id: "call_2", name: "second", input: { n: 2 } },
  ]);
  assert.equal(response.stopReason, "max_tokens");
});

test("classifies timeout, rate limit, auth, server, and network errors", async (t) => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const cases = [
    {
      name: "aborted",
      script: [{ throw: abortError }],
      code: "aborted",
      retryable: false,
    },
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
        provider.chat({ system: "", messages: [] }),
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

test("passes through a 2xx error body's upstream message", async () => {
  const { provider } = makeProvider([
    { status: 200, json: { error: { message: "The model is overloaded" } } },
  ]);

  await assert.rejects(
    provider.chat({ system: "", messages: [] }),
    (err) => {
      assert.ok(err instanceof KitError);
      assert.equal(err.code, "server");
      assert.equal(err.message, "The model is overloaded");
      return true;
    },
  );
});

test("passes through upstream error.message for non-2xx responses", async () => {
  const { provider } = makeProvider([
    { status: 400, json: { error: { message: "Invalid request" } } },
  ]);

  await assert.rejects(
    provider.chat({ system: "", messages: [] }),
    (err) => {
      assert.ok(err instanceof KitError);
      assert.equal(err.code, "unknown");
      assert.equal(err.message, "Invalid request");
      assert.equal(err.status, 400);
      return true;
    },
  );
});
