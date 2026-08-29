import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalToOpenAIMessages,
  canonicalToolsToOpenAI,
  openAIResponseToCanonical,
} from "../../src/messages/canonical.js";
import {
  multipleToolCallsRound,
  pureTextConversation,
  singleToolCallRound,
} from "../fixtures/rounds-fixtures.mjs";

test("serializes system and string content, including an empty conversation", () => {
  assert.deepEqual(canonicalToOpenAIMessages("", []), []);
  assert.deepEqual(canonicalToOpenAIMessages(undefined, []), []);
  assert.deepEqual(
    canonicalToOpenAIMessages("You are concise.", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi." },
    ]),
    [
      { role: "system", content: "You are concise." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi." },
    ],
  );
});

test("serializes assistant text, tool calls, and mixed content", () => {
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, [
      { role: "assistant", content: [{ type: "text", text: "plain" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "before " },
          { type: "tool_use", id: "call-2", name: "lookup", input: { q: "y" } },
          { type: "text", text: "after" },
          { type: "raw", protocol: "vendor", payload: { ignored: true } },
        ],
      },
    ]),
    [
      { role: "assistant", content: "plain" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"x"}' },
          },
        ],
      },
      {
        role: "assistant",
        content: "before after",
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"y"}' },
          },
        ],
      },
    ],
  );
});

test("emits each user tool result separately and preserves mixed ordering", () => {
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "tool_result", tool_use_id: "call-1", content: "one" },
          { type: "text", text: "between" },
          { type: "tool_result", tool_use_id: "call-2", content: "two", is_error: true },
          { type: "text", text: "after" },
        ],
      },
    ]),
    [
      { role: "user", content: "before" },
      { role: "tool", tool_call_id: "call-1", content: "one" },
      { role: "user", content: "between" },
      { role: "tool", tool_call_id: "call-2", content: "two" },
      { role: "user", content: "after" },
    ],
  );
});

test("serializes canonical fixtures without collapsing tool result order", () => {
  assert.equal(canonicalToOpenAIMessages(undefined, pureTextConversation).length, 4);
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, singleToolCallRound).slice(1, 3),
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_status",
            type: "function",
            function: { name: "get_status", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_status", content: "ready" },
    ],
  );
  assert.deepEqual(
    canonicalToOpenAIMessages(undefined, multipleToolCallsRound).slice(1, 4),
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_tree",
            type: "function",
            function: { name: "tree", arguments: '{"depth":2}' },
          },
          {
            id: "call_status",
            type: "function",
            function: { name: "get_status", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_tree", content: "src/\ntest/" },
      { role: "tool", tool_call_id: "call_status", content: "clean" },
    ],
  );
});

test("serializes tool schemas", () => {
  assert.deepEqual(
    canonicalToolsToOpenAI([
      {
        name: "lookup",
        description: "Find a value.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Find a value.",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ],
  );
  assert.deepEqual(canonicalToolsToOpenAI(undefined), []);
});

test("parses text and tool calls, preserving invalid arguments as raw input", () => {
  assert.deepEqual(
    openAIResponseToCanonical({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "I will check.",
          tool_calls: [
            {
              id: "call-good",
              function: { name: "good", arguments: '{"value":1}' },
            },
            {
              id: "call-bad",
              function: { name: "bad", arguments: '{"value":' },
            },
          ],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }),
    {
      content: [
        { type: "text", text: "I will check." },
        { type: "tool_use", id: "call-good", name: "good", input: { value: 1 } },
        { type: "tool_use", id: "call-bad", name: "bad", input: { _raw: '{"value":' } },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 7 },
    },
  );
});

test("passes through unknown finish reasons and omits missing usage", () => {
  const response = openAIResponseToCanonical({
    choices: [{ finish_reason: "content_filter", message: { content: "" } }],
  });

  assert.deepEqual(response, {
    content: [{ type: "text", text: "" }],
    stopReason: "content_filter",
  });
  assert.equal("usage" in response, false);
});

test("throws a diagnostic error when choices are missing", () => {
  const oversizedResponse = { error: "bad response", detail: "x".repeat(700) };
  assert.throws(
    () => openAIResponseToCanonical(oversizedResponse),
    (error) => {
      assert.match(error.message, /missing choices/);
      assert.ok(error.message.includes('"error":"bad response"'));
      assert.ok(error.message.length < 560);
      return true;
    },
  );
});
