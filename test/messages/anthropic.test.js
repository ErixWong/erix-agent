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

test("keeps an unmarked string-system request byte-compatible with the baseline", () => {
  const payload = canonicalToAnthropicRequest({
    model: "claude-test",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 32,
  });

  assert.equal(
    JSON.stringify(payload),
    '{"model":"claude-test","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"max_tokens":32,"system":"system"}',
  );
});

test("passes through an unmarked system array without remapping block metadata", () => {
  const system = [{
    type: "text",
    text: "system",
    citations: [{ source: "doc-1", start: 0, end: 6 }],
    metadata: { source: "host" },
  }];
  const payload = canonicalToAnthropicRequest({
    model: "claude-test",
    system,
    messages: [],
    maxTokens: 32,
  });

  assert.strictEqual(payload.system, system);
  assert.equal(
    JSON.stringify(payload),
    '{"model":"claude-test","messages":[],"max_tokens":32,"system":[{"type":"text","text":"system","citations":[{"source":"doc-1","start":0,"end":6}],"metadata":{"source":"host"}}]}',
  );
});

test("normalizes unmarked system content objects to strings or block arrays", () => {
  const blocks = [{
    type: "text",
    text: "system",
    citations: [{ source: "doc-1" }],
  }];
  assert.equal(
    canonicalToAnthropicRequest({
      model: "claude-test",
      system: { content: "system" },
      messages: [],
      maxTokens: 32,
    }).system,
    "system",
  );
  assert.deepEqual(
    canonicalToAnthropicRequest({
      model: "claude-test",
      system: { content: blocks },
      messages: [],
      maxTokens: 32,
    }).system,
    blocks,
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

test("maps canonical cache hints to Anthropic breakpoints and keeps four", () => {
  const marked = canonicalToAnthropicRequest({
    model: "claude-test",
    system: [{ type: "text", text: "stable system", cache: true }],
    messages: [
      { role: "user", content: "first", cacheBoundary: true },
      { role: "assistant", content: [{ type: "text", text: "second", cache: true }] },
    ],
    maxTokens: 32,
  });
  assert.deepEqual(marked.system, [{
    type: "text",
    text: "stable system",
    cache_control: { type: "ephemeral" },
  }]);
  assert.deepEqual(marked.messages.map((message) => message.content), [
    [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
    [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
  ]);

  const capped = canonicalToAnthropicRequest({
    model: "claude-test",
    system: [{ type: "text", text: "system", cache: true }],
    messages: Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
      cacheBoundary: true,
    })),
    maxTokens: 32,
  });
  const breakpoints = [
    ...(capped.system ?? []),
    ...capped.messages.flatMap((message) => message.content),
  ].filter((block) => block.cache_control !== undefined);
  assert.equal(breakpoints.length, 4);
  assert.deepEqual(
    capped.messages.map((message) => message.content[0].cache_control !== undefined),
    [false, true, true, true, true],
  );
});

test("counts native cache_control blocks toward the four-breakpoint cap", () => {
  const capped = canonicalToAnthropicRequest({
    model: "claude-test",
    messages: Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{
        type: "text",
        text: `message-${index}`,
        cache_control: { type: "ephemeral" },
      }],
    })),
    maxTokens: 32,
  });
  const blocks = capped.messages.map((message) => message.content[0]);

  assert.equal(blocks.filter((block) => block.cache_control !== undefined).length, 4);
  assert.equal(blocks[0].cache_control, undefined);
  assert.deepEqual(blocks.slice(1).map((block) => block.cache_control), [
    { type: "ephemeral" },
    { type: "ephemeral" },
    { type: "ephemeral" },
    { type: "ephemeral" },
  ]);
});

test("normalizes Anthropic cache usage for batch and stream responses", () => {
  assert.deepEqual(
    anthropicResponseToCanonical({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      },
    }).usage,
    {
      input_tokens: 20,
      output_tokens: 4,
      cacheRead: 15,
      cacheWrite: 5,
    },
  );

  const assembler = createAnthropicStreamAssembler();
  assembler.push("message_start", {
    message: {
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      },
    },
  });
  assembler.push("message_delta", {
    usage: { output_tokens: 4 },
    delta: { stop_reason: "end_turn" },
  });
  assert.deepEqual(assembler.finish().usage, {
    input_tokens: 20,
    output_tokens: 4,
    cacheRead: 15,
    cacheWrite: 5,
  });
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
    input: { _truncatedArguments: '{"broken":', _raw: '{"broken":' },
  }]);
});

test("wraps unknown streamed blocks as Anthropic raw blocks", () => {
  const assembler = createAnthropicStreamAssembler();
  const payload = {
    type: "server_tool_use",
    id: "server_1",
    name: "web_search",
    input: { query: "weather" },
  };

  assembler.push("content_block_start", { index: 0, content_block: payload });

  assert.deepEqual(assembler.finish().content, [{
    type: "raw",
    protocol: "anthropic",
    payload,
  }]);
});
