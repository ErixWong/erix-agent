import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalToOpenAIMessages,
  openAIResponseToCanonical,
} from "../../src/messages/canonical.js";

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
      content: "",
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
