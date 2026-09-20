import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAIStreamAccumulator,
  normalizeOpenAIStopReason,
  normalizeOpenAIUsage,
  parseOpenAIToolArguments,
} from "../../src/index.js";

test("normalizes OpenAI usage aliases and ignores unknown fields", () => {
  assert.deepEqual(
    normalizeOpenAIUsage({
      prompt_tokens: 12,
      completion_tokens: 7,
    }),
    { input_tokens: 12, output_tokens: 7 },
  );
  assert.deepEqual(
    normalizeOpenAIUsage({
      input_tokens: 0,
      output_tokens: 9999999999,
      prompt_tokens: 4,
    }),
    { input_tokens: 4 },
  );
  assert.deepEqual(
    normalizeOpenAIUsage({
      prompt_tokens: 20,
      prompt_tokens_details: { cached_tokens: 15 },
    }),
    { input_tokens: 20, cacheRead: 15 },
  );
  assert.deepEqual(
    normalizeOpenAIUsage({ input_tokens: null }),
    {},
  );
});

test("preserves legacy usage presence and field filtering", () => {
  assert.equal(normalizeOpenAIUsage(undefined), undefined);
  assert.equal(normalizeOpenAIUsage(null), undefined);
  assert.deepEqual(normalizeOpenAIUsage({}), {});
  assert.deepEqual(normalizeOpenAIUsage([]), {});
  assert.deepEqual(normalizeOpenAIUsage("prompt_tokens"), {});
  assert.deepEqual(
    normalizeOpenAIUsage({ input_tokens: 3, output_tokens: 4 }),
    {},
  );
});

test("maps OpenAI stop reasons with fallback and passthrough behavior", () => {
  assert.equal(normalizeOpenAIStopReason("stop"), "end_turn");
  assert.equal(normalizeOpenAIStopReason("tool_calls"), "tool_use");
  assert.equal(normalizeOpenAIStopReason("function_call"), "tool_use");
  assert.equal(normalizeOpenAIStopReason("length"), "max_tokens");
  assert.equal(normalizeOpenAIStopReason("vendor_reason"), "vendor_reason");
  assert.equal(normalizeOpenAIStopReason(undefined), "unknown");
  assert.equal(normalizeOpenAIStopReason(null, "end_turn"), "end_turn");
});

test("parses tool arguments and preserves malformed values", () => {
  assert.deepEqual(
    parseOpenAIToolArguments('{"city":"Paris"}'),
    { city: "Paris" },
  );
  assert.deepEqual(parseOpenAIToolArguments(undefined), {});
  assert.deepEqual(
    parseOpenAIToolArguments('{"city":'),
    { _truncatedArguments: '{"city":', _raw: '{"city":' },
  );
  const longArguments = `{"value":"${"x".repeat(10000)}"}`;
  assert.equal(parseOpenAIToolArguments(longArguments).value.length, 10000);
  const malformed = "x".repeat(10000);
  assert.equal(parseOpenAIToolArguments(malformed)._raw, malformed);
  assert.deepEqual(
    parseOpenAIToolArguments({ already: "object" }),
    {
      _truncatedArguments: { already: "object" },
      _raw: { already: "object" },
    },
  );
});

test("accumulates indexed and legacy streamed tool-call deltas", () => {
  const accumulator = createOpenAIStreamAccumulator();
  assert.deepEqual(
    accumulator.addToolCallDelta({
      index: 0,
      id: "call_lookup",
      function: { name: "lookup", arguments: '{"city":' },
    }),
    {
      index: 0,
      id: "call_lookup",
      name: "lookup",
      argumentsDelta: '{"city":',
    },
  );
  assert.deepEqual(
    accumulator.addToolCallDelta({
      index: 0,
      function: { arguments: '"Paris"}' },
    }),
    {
      index: 0,
      id: "call_lookup",
      argumentsDelta: '"Paris"}',
    },
  );
  assert.deepEqual(accumulator.getToolUseBlocks(), [{
    type: "tool_use",
    id: "call_lookup",
    name: "lookup",
    input: { city: "Paris" },
  }]);

  const legacy = createOpenAIStreamAccumulator();
  assert.deepEqual(
    legacy.addFunctionCallDelta({ name: "lookup", arguments: "{}" }),
    {
      index: 0,
      id: "call_legacy",
      name: "lookup",
      argumentsDelta: "{}",
    },
  );
  assert.deepEqual(legacy.getToolCalls(), [{
    index: 0,
    id: "call_legacy",
    name: "lookup",
    arguments: "{}",
  }]);
});

test("accumulator handles empty, malformed, missing-index, and long deltas", () => {
  const accumulator = createOpenAIStreamAccumulator();
  assert.deepEqual(accumulator.addToolCallDeltas([]), []);
  assert.equal(accumulator.addToolCallDelta(null), undefined);
  assert.equal(accumulator.addToolCallDelta("not an object"), undefined);
  const longFragment = "x".repeat(10000);
  const fragments = accumulator.addToolCallDeltas([
    { index: 0, id: "call_a", function: { arguments: `{"value":"${longFragment}` } },
    { index: 0, function: { arguments: '"}' } },
    { function: { arguments: "{}" } },
  ]);
  assert.deepEqual(fragments.map(({ index }) => index), [0, 0, 1]);
  assert.equal(accumulator.getToolUseBlocks()[0].input.value.length, 10000);
  assert.deepEqual(accumulator.getToolUseBlocks()[1].input, {});
});

test("preserves legacy coercion for object arguments and numeric names", () => {
  const accumulator = createOpenAIStreamAccumulator();
  assert.deepEqual(
    accumulator.addToolCallDelta({
      index: 0,
      id: "call_object",
      function: { name: 42, arguments: { a: 1 } },
    }),
    {
      index: 0,
      id: "call_object",
      name: "42",
      argumentsDelta: "[object Object]",
    },
  );
  assert.deepEqual(accumulator.getToolCalls(), [{
    index: 0,
    id: "call_object",
    name: 42,
    arguments: "[object Object]",
  }]);
  assert.deepEqual(accumulator.getToolUseBlocks(), [{
    type: "tool_use",
    id: "call_object",
    name: 42,
    input: {
      _truncatedArguments: "[object Object]",
      _raw: "[object Object]",
    },
  }]);
});
