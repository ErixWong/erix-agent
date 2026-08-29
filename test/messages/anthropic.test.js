import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicResponseToCanonical,
  canonicalToAnthropicRequest,
  createAnthropicStreamAssembler,
} from "../../src/messages/anthropic.js";

test("serializes canonical Anthropic requests", () => {
  assert.deepEqual(
    canonicalToAnthropicRequest({
      model: "claude-test",
      system: "Be concise.",
      messages: [
        { role: "user", content: "Use the tool." },
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
      maxTokens: 128,
      temperature: 0.2,
      topP: 0.9,
      stream: true,
    }),
    {
      model: "claude-test",
      system: "Be concise.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Use the tool." }] },
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
      max_tokens: 128,
      tools: [{
        name: "lookup",
        description: "Look up a value.",
        input_schema: { type: "object", properties: { key: { type: "string" } } },
      }],
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    },
  );
});

test("requires maxTokens and maps non-stream responses", () => {
  assert.throws(
    () => canonicalToAnthropicRequest({
      model: "claude-test",
      messages: [],
    }),
    /maxTokens is required/,
  );

  assert.deepEqual(
    anthropicResponseToCanonical({
      content: [
        { type: "text", text: "Done" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "value" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 7 },
    }),
    {
      content: [
        { type: "text", text: "Done" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "value" } },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 7 },
    },
  );
});

test("assembles text and tool-use stream events", () => {
  const deltas = [];
  const assembler = createAnthropicStreamAssembler((text) => deltas.push(text));

  assembler.push("message_start", {
    type: "message_start",
    message: { usage: { input_tokens: 21 } },
  });
  assembler.push("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  });
  assembler.push("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: "Hello " },
  });
  assembler.push("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: "world" },
  });
  assembler.push("content_block_stop", { index: 0 });
  assembler.push("content_block_start", {
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
  });
  assembler.push("content_block_delta", {
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"key":' },
  });
  assembler.push("content_block_delta", {
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"value"}' },
  });
  assembler.push("content_block_stop", { index: 1 });
  assembler.push("message_delta", {
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 8 },
  });
  assembler.push("message_stop", { type: "message_stop" });

  assert.deepEqual(deltas, ["Hello ", "world"]);
  assert.deepEqual(assembler.finish(), {
    content: [
      { type: "text", text: "Hello world" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "value" } },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 21, output_tokens: 8 },
  });
});

test("keeps invalid streamed tool JSON as raw input", () => {
  const assembler = createAnthropicStreamAssembler();
  assembler.push("content_block_start", {
    index: 0,
    content_block: { type: "tool_use", id: "toolu_bad", name: "bad", input: {} },
  });
  assembler.push("content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"broken":' },
  });
  assembler.push("content_block_stop", { index: 0 });

  assert.deepEqual(assembler.finish().content, [{
    type: "tool_use",
    id: "toolu_bad",
    name: "bad",
    input: { _raw: '{"broken":' },
  }]);
});
