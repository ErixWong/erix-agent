import assert from "node:assert/strict";
import test from "node:test";

import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const baseRequest = {
  system: "",
  messages: [{ role: "user", content: "hello" }],
};

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

test("Anthropic forwards alpha payload fields and provider-specific options", async () => {
  const fetchImpl = createMockFetch([{
    json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
  }]);
  const provider = createAnthropicProvider({
    endpoint: "https://api.example.test",
    apiKey: "test-key",
    model: "claude-test",
    fetchImpl,
  });

  await provider.chat({
    ...baseRequest,
    maxTokens: 32,
    thinking: { type: "enabled", budget_tokens: 1000 },
    reasoning: { effort: "medium" },
    reasoning_effort: "medium",
    enable_thinking: true,
    chat_template_kwargs: { enable_thinking: true },
    providerOptions: {
      anthropic: { custom_header_mode: "compat", secret: "must-not-leak" },
    },
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: { type: "json_object" },
  });

  assert.deepEqual(fetchImpl.calls[0].body, {
    model: "claude-test",
    system: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    max_tokens: 32,
    thinking: { type: "enabled", budget_tokens: 1000 },
    reasoning: { effort: "medium" },
    reasoning_effort: "medium",
    enable_thinking: true,
    chat_template_kwargs: { enable_thinking: true },
    custom_header_mode: "compat",
    frequency_penalty: 0,
    presence_penalty: 0,
    response_format: { type: "json_object" },
  });
});
