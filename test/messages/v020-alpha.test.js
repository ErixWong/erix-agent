import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalToOpenAIMessages,
  openAIResponseToCanonical,
} from "../../src/messages/canonical.js";
import {
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
} from "../../src/messages/anthropic.js";

const touwakaReasoning = {
  type: "raw",
  protocol: "touwaka",
  payload: { kind: "reasoning", text: "check the repository first" },
};

test("OpenAI maps canonical reasoning and touwaka raw reasoning to reasoning_content", () => {
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, [{
      role: "assistant",
      content: [
        touwakaReasoning,
        { type: "text", text: "The repository is ready." },
      ],
    }]),
    [{
      role: "assistant",
      content: "The repository is ready.",
      reasoning_content: "check the repository first",
    }],
  );

  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, [{
      role: "assistant",
      content: [{ type: "reasoning", text: "native reasoning" }],
    }]),
    [{
      role: "assistant",
      content: null,
      reasoning_content: "native reasoning",
    }],
  );
});

test("OpenAI response maps reasoning_content and image content parts", () => {
  assert.deepEqual(
    openAIResponseToCanonical({
      choices: [{
        finish_reason: "stop",
        message: {
          reasoning_content: "I inspected the inputs.",
          content: [
            { type: "text", text: "Done." },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "high" } },
          ],
        },
      }],
    }),
    {
      content: [
        { type: "reasoning", text: "I inspected the inputs." },
        { type: "text", text: "Done." },
        { type: "image", url: "data:image/png;base64,AAA", detail: "high" },
      ],
      stopReason: "end_turn",
    },
  );
});

test("OpenAI maps canonical URL and base64 images while preserving raw blocks", () => {
  const raw = { type: "raw", protocol: "vendor", payload: { kind: "trace", id: 7 } };
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, [{
      role: "user",
      content: [
        { type: "text", text: "Inspect these." },
        { type: "image", url: "https://example.test/image.png", detail: "low" },
        { type: "image", base64: "AAA", mediaType: "image/png" },
        raw,
      ],
    }]),
    [{
      role: "user",
      content: [
        { type: "text", text: "Inspect these." },
        { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "low" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
      raw_blocks: [raw],
    }],
  );
});

test("Anthropic maps reasoning, touwaka raw reasoning, images, and raw blocks", () => {
  const raw = { type: "raw", protocol: "vendor", payload: { kind: "trace" } };
  assert.deepEqual(
    canonicalToAnthropicRequest({
      model: "claude-test",
      maxTokens: 128,
      messages: [{
        role: "assistant",
        content: [
          { type: "reasoning", text: "native", signature: "sig" },
          touwakaReasoning,
          { type: "image", url: "https://example.test/image.png" },
          { type: "image", base64: "AAA", mediaType: "image/png" },
          raw,
        ],
      }],
    }),
    {
      model: "claude-test",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "native", signature: "sig" },
          { type: "thinking", thinking: "check the repository first" },
          { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          raw,
        ],
      }],
      max_tokens: 128,
    },
  );

  assert.deepEqual(
    anthropicResponseToCanonical({
      content: [
        { type: "thinking", thinking: "reason", signature: "sig" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
        { type: "custom", value: 1 },
      ],
      stop_reason: "end_turn",
    }),
    {
      content: [
        { type: "reasoning", text: "reason", signature: "sig" },
        { type: "image", base64: "BBB", mediaType: "image/jpeg" },
        { type: "raw", protocol: "anthropic", payload: { type: "custom", value: 1 } },
      ],
      stopReason: "end_turn",
    },
  );
});
