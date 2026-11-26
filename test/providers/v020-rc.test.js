import assert from "node:assert/strict";
import test from "node:test";

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
