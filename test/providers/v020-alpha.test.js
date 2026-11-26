import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const baseRequest = {
  system: "",
  messages: [{ role: "user", content: "hello" }],
};

async function openAIRequestBody(model, request = {}) {
  const fetchImpl = createMockFetch([{
    json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  }]);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model,
    fetchImpl,
  });

  await provider.chat({ ...baseRequest, ...request });
  return fetchImpl.calls[0].body;
}

test("OpenAI leaves optional alpha payload fields absent when unset", async () => {
  const fetchImpl = createMockFetch([{
    json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  }]);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });

  await provider.chat(baseRequest);

  assert.deepEqual(fetchImpl.calls[0].body, {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  });
});

test("OpenAI forwards alpha thinking fields and sanitized provider options", async () => {
  const fetchImpl = createMockFetch([{
    json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  }]);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });

  await provider.chat({
    ...baseRequest,
    thinking: { type: "enabled" },
    reasoning: { effort: "high" },
    reasoning_effort: "high",
    enable_thinking: true,
    chat_template_kwargs: { enable_thinking: true },
    providerOptions: {
      openai: {
        custom_route: "fast",
        apiKey: "must-not-leak",
        nested: { access_token: "must-not-leak", keep: true },
      },
      anthropic: { ignored_for_openai: true },
    },
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: { type: "json_object" },
  });

  assert.deepEqual(fetchImpl.calls[0].body, {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled" },
    reasoning: { effort: "high" },
    reasoning_effort: "high",
    enable_thinking: true,
    chat_template_kwargs: { enable_thinking: true },
    custom_route: "fast",
    nested: { keep: true },
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: { type: "json_object" },
  });
});

test("OpenAI translates GLM reasoning_effort none to low", async () => {
  const body = await openAIRequestBody("glm-5.3-flash-awq", {
    reasoning_effort: "none",
  });

  assert.equal(body.reasoning_effort, "low");
});

test("OpenAI preserves reasoning_effort none for non-GLM models", async () => {
  const body = await openAIRequestBody("deepseek-flash", {
    reasoning_effort: "none",
  });

  assert.equal(body.reasoning_effort, "none");
});

test("OpenAI preserves GLM reasoning_effort low", async () => {
  const body = await openAIRequestBody("glm-5.3-flash-awq", {
    reasoning_effort: "low",
  });

  assert.equal(body.reasoning_effort, "low");
});

test("OpenAI omits reasoning_effort when it is not provided", async () => {
  const body = await openAIRequestBody("glm-5.3-flash-awq");

  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
});

test("providerOptions cannot override core payload fields", async () => {
  const openAIFetch = createMockFetch([{
    json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  }]);
  const openAI = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: openAIFetch,
  });
  await openAI.chat({
    ...baseRequest,
    maxTokens: 32,
    providerOptions: {
      openai: {
        model: "wrong-model",
        messages: [{ role: "user", content: "wrong" }],
        max_tokens: 1,
        stream: true,
        temperature: 0,
      },
    },
  });
  assert.equal(openAIFetch.calls[0].body.model, "test-model");
  assert.deepEqual(openAIFetch.calls[0].body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(openAIFetch.calls[0].body.max_tokens, 32);
  assert.equal(openAIFetch.calls[0].body.stream, undefined);
  assert.equal(openAIFetch.calls[0].body.temperature, undefined);
  // issue #926：这一格原本还有 Anthropic 的一半（同一个「providerOptions 不得覆盖 core 字段」
  // 判据在两个适配器上各验一次）；Anthropic 适配器退役后只剩 OpenAI 这一半，判据本身未放宽。
});
