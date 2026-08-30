import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";

function jsonResponse(value) {
  return {
    status: 200,
    async text() {
      return JSON.stringify(value);
    },
  };
}

function streamResponse(text) {
  return {
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

test("forwards transport as dispatcher to OpenAI chat and chatStream", async () => {
  const transport = { name: "rc-transport" };
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      return jsonResponse({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      });
    }
    return streamResponse(
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
      + "data: [DONE]\n\n",
    );
  };
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test",
    apiKey: "key",
    model: "model",
    fetchImpl,
    transport,
  });

  await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  await provider.chatStream({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].dispatcher, transport);
  assert.equal(calls[1].dispatcher, transport);
});

test("forwards transport as dispatcher to Anthropic chat and chatStream", async () => {
  const transport = { name: "rc-transport" };
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      return jsonResponse({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return streamResponse(
      "event: message_start\n"
      + 'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
      + "event: content_block_start\n"
      + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
      + "event: content_block_delta\n"
      + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n'
      + "event: message_delta\n"
      + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
      + "event: message_stop\n"
      + 'data: {"type":"message_stop"}\n\n',
    );
  };
  const provider = createAnthropicProvider({
    endpoint: "https://api.example.test",
    apiKey: "key",
    model: "model",
    fetchImpl,
    transport,
  });

  await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  await provider.chatStream({ messages: [{ role: "user", content: "hi" }] });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].dispatcher, transport);
  assert.equal(calls[1].dispatcher, transport);
});

test("maps canonical system summary messages to Anthropic top-level system", async () => {
  let requestBody;
  const provider = createAnthropicProvider({
    endpoint: "https://api.example.test",
    apiKey: "key",
    model: "model",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      });
    },
  });

  await provider.chat({
    messages: [
      { role: "system", content: [{ type: "text", text: "folded summary" }] },
      { role: "user", content: "continue" },
    ],
  });

  assert.equal(requestBody.system, "folded summary");
  assert.deepEqual(requestBody.messages, [{
    role: "user",
    content: [{ type: "text", text: "continue" }],
  }]);
});
