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

// issue #785 P1 ①：推理 token 保真。两个方向各自只能被一个写法满足，所以下面三格是反向可证的：
//   · 把 `openai-normalization.js` 里写 `reasoningTokens` 的那两行删掉 ⇒ 第一格红；
//   · 把它改成「缺省填 0」⇒ 第二格红（键出现了，且值是 0）；
//   · 把它改成 `?? 0` 之外还改了上游真的报 0 那一发 ⇒ 第三格红。
// 上游回报口径只认 `completion_tokens_details.reasoning_tokens`（2026-11-08 真上游实测字段名）。
test("#785 keeps reasoning_tokens as reasoningTokens when the upstream reports it", () => {
  assert.deepEqual(
    normalizeOpenAIUsage({
      prompt_tokens: 4561,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 20 },
    }),
    { input_tokens: 4561, output_tokens: 20, reasoningTokens: 20 },
  );
});

test("#785 leaves the reasoningTokens key ABSENT (never a fabricated 0) when upstream reports nothing", () => {
  const normalized = normalizeOpenAIUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
  });
  assert.equal(
    Object.hasOwn(normalized, "reasoningTokens"),
    false,
    `未回报就不许出现该键，实际键集 = ${JSON.stringify(Object.keys(normalized))}`,
  );
  assert.deepEqual(normalized, { input_tokens: 10, output_tokens: 5 });
  // details 在场但没带 reasoning_tokens，同样不许凭空长出一个键
  const detailsOnly = normalizeOpenAIUsage({
    prompt_tokens: 1,
    completion_tokens: 2,
    completion_tokens_details: { audio_tokens: 3 },
    prompt_tokens_details: { cached_tokens: 4 },
  });
  assert.equal(Object.hasOwn(detailsOnly, "reasoningTokens"), false);
  assert.deepEqual(detailsOnly, { input_tokens: 1, output_tokens: 2, cacheRead: 4 });
});

test("#785 keeps a reported zero reasoningTokens as a real measurement, not as absence", () => {
  // 真上游实测：`reasoning_effort:"none"` 那一发的 reasoning_tokens 真值就是 0。
  // 「回报了 0」与「没回报」是两个不同的事实，不能混成一个 0。
  assert.deepEqual(
    normalizeOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 3,
      completion_tokens_details: { reasoning_tokens: 0 },
    }),
    { input_tokens: 10, output_tokens: 3, reasoningTokens: 0 },
  );
});

test("#785 规范化 usage 原有三键语义一字不改（reasoningTokens 是纯加法）", () => {
  const before = normalizeOpenAIUsage({
    prompt_tokens: 8,
    completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 2 },
  });
  assert.deepEqual(before, { input_tokens: 8, output_tokens: 3, cacheRead: 2 });
  assert.equal(Object.hasOwn(before, "reasoningTokens"), false);
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
  const [objectBlock] = accumulator.getToolUseBlocks();
  assert.deepEqual(objectBlock, {
    type: "tool_use",
    id: "call_object",
    name: 42,
    input: {
      _truncatedArguments: "[object Object]",
      _raw: "[object Object]",
    },
    // issue #409：判词挂在块上（additive 可选键），`input` 形状逐字未变。
    erix: {
      argumentsParseError: {
        reason: "unparsable",
        message: objectBlock.erix.argumentsParseError.message,
        text: "[object Object]",
      },
    },
  });
  assert.equal(typeof objectBlock.erix.argumentsParseError.message, "string");
});
