import assert from "node:assert/strict";
import { test } from "node:test";

import { KitError } from "../../src/providers/errors.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const request = {
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Say hello." }],
  tools: [{
    name: "lookup",
    description: "Look something up.",
    inputSchema: { type: "object" },
  }],
  maxTokens: 128,
  temperature: 0.2,
  topP: 0.9,
};

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function makeProvider(fetchImpl, options = {}) {
  return createOpenAIProvider({
    endpoint: "https://api.example.test/v1/",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    ...options,
  });
}

function makeChunkedFetch(chunks, { error } = {}) {
  const calls = [];
  const bodyText = chunks.join("");
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: JSON.parse(options.body),
    });
    let nextChunk = 0;
    return {
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          if (nextChunk < chunks.length) {
            controller.enqueue(new TextEncoder().encode(chunks[nextChunk++]));
          } else if (error) {
            controller.error(error);
          } else {
            controller.close();
          }
        },
      }),
      async text() {
        return bodyText;
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("parses text across chunks, emits ordered deltas, maps usage, and stops at DONE", async () => {
  const stream = [
    sse({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] }),
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
    "data: [DONE]\n\n",
    "data: not valid JSON\n\n",
  ].join("");
  const fetchImpl = makeChunkedFetch([
    stream.slice(0, 17),
    stream.slice(17, 49),
    stream.slice(49, 91),
    stream.slice(91),
  ]);
  const deltas = [];

  const response = await makeProvider(fetchImpl).chatStream({
    ...request,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["Hel", "lo", "!"]);
  assert.deepEqual(response, {
    content: [{ type: "text", text: "Hello!" }],
    stopReason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 3 },
  });
  assert.deepEqual(fetchImpl.calls[0].body, {
    model: "test-model",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up.",
        parameters: { type: "object" },
      },
    }],
    max_tokens: 128,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test("assembles a streamed tool call from three argument deltas", async () => {
  const fetchImpl = createMockFetch([
    {
      body: [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_lookup",
                type: "function",
                function: { name: "lookup", arguments: '{"city"' },
              }],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: ':"Paris"' },
              }],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
        sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } }),
        "data: [DONE]\n\n",
      ].join(""),
    },
  ]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  assert.deepEqual(response, {
    content: [{
      type: "tool_use",
      id: "call_lookup",
      name: "lookup",
      input: { city: "Paris" },
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 11, output_tokens: 9 },
  });
});

test("preserves invalid streamed tool arguments as raw input", async () => {
  const fetchImpl = createMockFetch([{
    body: [
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_invalid",
              function: { name: "lookup", arguments: '{"city":' },
            }],
          },
          finish_reason: null,
        }],
      }),
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "Paris" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  assert.deepEqual(response.content, [{
    type: "tool_use",
    id: "call_invalid",
    name: "lookup",
    input: { _truncatedArguments: '{"city":Paris', _raw: '{"city":Paris' },
  }]);
});

test("keeps multiple streamed tool calls in index slots", async () => {
  const fetchImpl = createMockFetch([
    {
      body: [
        sse({
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_second",
                  function: { name: "second", arguments: '{"b":' },
                },
                {
                  index: 0,
                  id: "call_first",
                  function: { name: "first", arguments: '{"a":' },
                },
              ],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: "2}" } },
                { index: 0, function: { arguments: "1}" } },
              ],
            },
            finish_reason: "tool_calls",
          }],
        }),
        "data: [DONE]\n\n",
      ].join(""),
    },
  ]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  assert.deepEqual(response.content, [
    {
      type: "tool_use",
      id: "call_first",
      name: "first",
      input: { a: 1 },
    },
    {
      type: "tool_use",
      id: "call_second",
      name: "second",
      input: { b: 2 },
    },
  ]);
  assert.equal(response.stopReason, "tool_use");
});

test("normalizes all supported streamed finish reasons", async (t) => {
  for (const [finishReason, stopReason] of [
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
  ]) {
    await t.test(finishReason, async () => {
      const fetchImpl = createMockFetch([{
        body: [
          sse({
            choices: [{
              delta: { content: "done" },
              finish_reason: finishReason,
            }],
          }),
          "data: [DONE]\n\n",
        ].join(""),
      }]);

      const response = await makeProvider(fetchImpl).chatStream({
        system: "",
        messages: [],
      });

      assert.equal(response.stopReason, stopReason);
    });
  }
});

test("classifies a network error while reading the stream", async () => {
  const fetchImpl = makeChunkedFetch(
    [sse({ choices: [{ delta: { content: "partial" } }] })],
    { error: new TypeError("stream disconnected") },
  );

  await assert.rejects(
    makeProvider(fetchImpl).chatStream({ system: "", messages: [] }),
    (err) => {
      assert.ok(err instanceof KitError);
      assert.equal(err.code, "network");
      assert.equal(err.retryable, false);
      assert.equal(err.message, "stream disconnected");
      return true;
    },
  );
});

test("buffers an incomplete SSE data line across chunks", async () => {
  const event = sse({
    choices: [{ delta: { content: "buffered" }, finish_reason: "stop" }],
  });
  const fetchImpl = makeChunkedFetch([
    event.slice(0, 8),
    event.slice(8, -1),
    event.slice(-1),
    "data: [DONE]\n\n",
  ]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [],
  });

  assert.deepEqual(response.content, [{ type: "text", text: "buffered" }]);
  assert.equal(response.stopReason, "end_turn");
});
