import assert from "node:assert/strict";
import { test } from "node:test";

import { KitError } from "../../src/providers/errors.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const request = {
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Say hello." }],
  tools: [{
    name: "lookup",
    description: "Look something up.",
    inputSchema: { type: "object" },
  }],
  maxTokens: 128,
  temperature: 0.2,
  topP: 0.9,
};

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function makeProvider(fetchImpl, options = {}) {
  return createOpenAIProvider({
    endpoint: "https://api.example.test/v1/",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    ...options,
  });
}

function makeChunkedFetch(chunks, { error } = {}) {
  const calls = [];
  const bodyText = chunks.join("");
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: JSON.parse(options.body),
    });
    let nextChunk = 0;
    return {
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          if (nextChunk < chunks.length) {
            controller.enqueue(new TextEncoder().encode(chunks[nextChunk++]));
          } else if (error) {
            controller.error(error);
          } else {
            controller.close();
          }
        },
      }),
      async text() {
        return bodyText;
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("parses text across chunks, emits ordered deltas, maps usage, and stops at DONE", async () => {
  const stream = [
    sse({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }),
    sse({ choices: [{ delta: { content: "!" }, finish_reason: "stop" }] }),
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } }),
    "data: [DONE]\n\n",
    "data: not valid JSON\n\n",
  ].join("");
  const fetchImpl = makeChunkedFetch([
    stream.slice(0, 17),
    stream.slice(17, 49),
    stream.slice(49, 91),
    stream.slice(91),
  ]);
  const deltas = [];

  const response = await makeProvider(fetchImpl).chatStream({
    ...request,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["Hel", "lo", "!"]);
  assert.deepEqual(response, {
    content: [{ type: "text", text: "Hello!" }],
    stopReason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 3 },
  });
  assert.deepEqual(fetchImpl.calls[0].body, {
    model: "test-model",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up.",
        parameters: { type: "object" },
      },
    }],
    max_tokens: 128,
    temperature: 0.2,
    top_p: 0.9,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test("probes usage for reasoning streams that omit a usage event", async () => {
  const fetchImpl = createMockFetch([
    {
      body: [
        sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ].join(""),
    },
    {
      json: {
        choices: [{ message: { content: "" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 37,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      },
    },
  ]);
  const usage = [];

  const response = await makeProvider(fetchImpl, {
    model: "reasoning-test-model",
    supports_reasoning: true,
  }).chatStream({
    ...request,
    onUsage: (reportedUsage) => usage.push(reportedUsage),
  });

  assert.deepEqual(response, {
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    usage: { input_tokens: 37, output_tokens: 1, cacheRead: 30 },
  });
  assert.deepEqual(usage, [{
    prompt_tokens: 37,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 30 },
  }]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].body.stream, undefined);
  assert.equal(fetchImpl.calls[1].body.max_tokens, 1);
});

test("does not add a usage probe to non-reasoning streams", async () => {
  const fetchImpl = createMockFetch([{
    body: [
      sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.deepEqual(response, {
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test("assembles a streamed tool call from three argument deltas", async () => {
  const fetchImpl = createMockFetch([
    {
      body: [
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_lookup",
                type: "function",
                function: { name: "lookup", arguments: '{"city"' },
              }],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: ':"Paris"' },
              }],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
        sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } }),
        "data: [DONE]\n\n",
      ].join(""),
    },
  ]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  assert.deepEqual(response, {
    content: [{
      type: "tool_use",
      id: "call_lookup",
      name: "lookup",
      input: { city: "Paris" },
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 11, output_tokens: 9 },
  });
});

test("preserves invalid streamed tool arguments as raw input", async () => {
  const fetchImpl = createMockFetch([{
    body: [
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_invalid",
              function: { name: "lookup", arguments: '{"city":' },
            }],
          },
          finish_reason: null,
        }],
      }),
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: "Paris" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  const [block] = response.content;
  assert.deepEqual(block, {
    type: "tool_use",
    id: "call_invalid",
    name: "lookup",
    input: { _truncatedArguments: '{"city":Paris', _raw: '{"city":Paris' },
    // issue #409：判词挂在块上（additive 可选键），`input` 形状逐字未变。
    erix: {
      argumentsParseError: {
        reason: "unparsable",
        message: block.erix.argumentsParseError.message,
        text: '{"city":Paris',
      },
    },
  });
  // 解析器原话逐字透传（V8 的文案随输入变化，这里只钉「非空 + 确实来自 JSON.parse」）。
  assert.equal(typeof block.erix.argumentsParseError.message, "string");
  assert.match(block.erix.argumentsParseError.message, /JSON|token|position/);
});

test("keeps multiple streamed tool calls in index slots", async () => {
  const fetchImpl = createMockFetch([
    {
      body: [
        sse({
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_second",
                  function: { name: "second", arguments: '{"b":' },
                },
                {
                  index: 0,
                  id: "call_first",
                  function: { name: "first", arguments: '{"a":' },
                },
              ],
            },
            finish_reason: null,
          }],
        }),
        sse({
          choices: [{
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: "2}" } },
                { index: 0, function: { arguments: "1}" } },
              ],
            },
            finish_reason: "tool_calls",
          }],
        }),
        "data: [DONE]\n\n",
      ].join(""),
    },
  ]);

  const response = await makeProvider(fetchImpl).chatStream(request);

  assert.deepEqual(response.content, [
    {
      type: "tool_use",
      id: "call_first",
      name: "first",
      input: { a: 1 },
    },
    {
      type: "tool_use",
      id: "call_second",
      name: "second",
      input: { b: 2 },
    },
  ]);
  assert.equal(response.stopReason, "tool_use");
});

test("normalizes all supported streamed finish reasons", async (t) => {
  for (const [finishReason, stopReason] of [
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
  ]) {
    await t.test(finishReason, async () => {
      const fetchImpl = createMockFetch([{
        body: [
          sse({
            choices: [{
              delta: { content: "done" },
              finish_reason: finishReason,
            }],
          }),
          "data: [DONE]\n\n",
        ].join(""),
      }]);

      const response = await makeProvider(fetchImpl).chatStream({
        system: "",
        messages: [],
      });

      assert.equal(response.stopReason, stopReason);
    });
  }
});

test("classifies a network error while reading the stream", async () => {
  const fetchImpl = makeChunkedFetch(
    [sse({ choices: [{ delta: { content: "partial" } }] })],
    { error: new TypeError("stream disconnected") },
  );

  await assert.rejects(
    makeProvider(fetchImpl).chatStream({ system: "", messages: [] }),
    (err) => {
      assert.ok(err instanceof KitError);
      assert.equal(err.code, "network");
      assert.equal(err.retryable, false);
      assert.equal(err.message, "stream disconnected");
      return true;
    },
  );
});

test("buffers an incomplete SSE data line across chunks", async () => {
  const event = sse({
    choices: [{ delta: { content: "buffered" }, finish_reason: "stop" }],
  });
  const fetchImpl = makeChunkedFetch([
    event.slice(0, 8),
    event.slice(8, -1),
    event.slice(-1),
    "data: [DONE]\n\n",
  ]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [],
  });

  assert.deepEqual(response.content, [{ type: "text", text: "buffered" }]);
  assert.equal(response.stopReason, "end_turn");
});

test("accepts SSE data lines without a space after the colon", async () => {
  const fetchImpl = makeChunkedFetch([
    'data:{"choices":[{"delta":{"content":"compact"},"finish_reason":"stop"}]}\n\n',
    "data:[DONE]\n\n",
  ]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [],
  });

  assert.deepEqual(response.content, [{ type: "text", text: "compact" }]);
  assert.equal(response.stopReason, "end_turn");
});

test("assembles legacy streamed function_call deltas as tool_use", async () => {
  const fetchImpl = createMockFetch([{
    body: [
      'data: {"choices":[{"delta":{"function_call":{"name":"lookup","arguments":"{\\"city\\":"}},"finish_reason":null}]}\n\n',
      'data:{"choices":[{"delta":{"function_call":{"arguments":"\\"Paris\\"}"}},"finish_reason":"function_call"}]}\n\n',
      "data:[DONE]\n\n",
    ].join(""),
  }]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [],
  });

  assert.deepEqual(response, {
    content: [{
      type: "tool_use",
      id: "call_legacy",
      name: "lookup",
      input: { city: "Paris" },
    }],
    stopReason: "tool_use",
  });
});

test("normalizes cached prompt tokens from streamed usage", async () => {
  const fetchImpl = createMockFetch([{
    body: [
      sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
      sse({
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 15 },
        },
      }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);

  const response = await makeProvider(fetchImpl).chatStream({
    system: "",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.deepEqual(response.usage, {
    input_tokens: 20,
    output_tokens: 3,
    cacheRead: 15,
  });
});

// ---------------------------------------------------------------------------
// issue #407：流式思考字段的别名。中继（one-api 系）**按模型发不同字段**，2026-10-23 实测
// `stream:true` 下 `qwen3.8-flash-next`（默认模型）发 `delta.reasoning`、`deepseek-flash` 发
// `delta.reasoning_content`。原先流式只认后者 ⇒ 前者的思考全丢。下面每一组别名共用**同一份**
// 判据（assertReasoningPipeline）：只换字段名或值的形状，管道三处与最终 content 必须一模一样。
// 全部离线脚本化，不碰真实上游。
// ---------------------------------------------------------------------------

const REASONING_FRAGMENTS = ["First thought. ", "Second thought."];
const ALIAS_USAGE = { prompt_tokens: 5, completion_tokens: 7 };

// 脚本：思考块与文本块交替，末尾带 usage（带 usage 就不会触发 usage 探针，
// 下面的 calls.length === 1 因此也是判据的一部分）。
function reasoningAliasStream(field, fragments) {
  const chunks = [];
  fragments.forEach((fragment, index) => {
    chunks.push(sse({
      choices: [{ delta: { [field]: fragment }, finish_reason: null }],
    }));
    chunks.push(sse({
      choices: [{
        delta: { content: index === 0 ? "o" : "k" },
        finish_reason: index === fragments.length - 1 ? "stop" : null,
      }],
    }));
  });
  chunks.push(sse({ choices: [], usage: ALIAS_USAGE }));
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

async function runReasoningAliasStream(field, fragments) {
  const events = [];
  const reasoning = [];
  const fetchImpl = createMockFetch([{ body: reasoningAliasStream(field, fragments) }]);
  const response = await makeProvider(fetchImpl).chatStream({
    ...request,
    onEvent: (event) => events.push(event),
    onReasoningDelta: (delta) => reasoning.push(delta),
  });
  return { events, reasoning, response, fetchImpl };
}

// 别名用例共用的那一组断言：思考被累加、onReasoningDelta 被调、reasoning_delta 事件发出、
// 最终 content 里有 {type:"reasoning"} 块——四项一起，且与 reasoning_content 逐字同形。
function assertReasoningPipeline(got) {
  assert.deepEqual(got.reasoning, ["First thought. ", "Second thought."]);
  assert.deepEqual(got.events, [
    { type: "reasoning_delta", delta: "First thought. " },
    { type: "delta", delta: "o" },
    { type: "reasoning_delta", delta: "Second thought." },
    { type: "delta", delta: "k" },
    { type: "usage", usage: ALIAS_USAGE },
  ]);
  assert.deepEqual(got.response, {
    content: [
      { type: "reasoning", text: "First thought. Second thought." },
      { type: "text", text: "ok" },
    ],
    stopReason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 7 },
  });
  assert.equal(got.fetchImpl.calls.length, 1);
}

test("issue #407: accumulates delta.reasoning (qwen3.8-flash-next shape)", async () => {
  assertReasoningPipeline(await runReasoningAliasStream("reasoning", REASONING_FRAGMENTS));
});

test("issue #407: keeps delta.reasoning_content (deepseek-flash shape) byte-identical", async () => {
  assertReasoningPipeline(
    await runReasoningAliasStream("reasoning_content", REASONING_FRAGMENTS),
  );
});

test("issue #407: accumulates the delta.reasoning_text alias", async () => {
  assertReasoningPipeline(await runReasoningAliasStream("reasoning_text", REASONING_FRAGMENTS));
});

test("issue #407: accepts delta.reasoning as a { content } object", async () => {
  assertReasoningPipeline(await runReasoningAliasStream(
    "reasoning",
    REASONING_FRAGMENTS.map((fragment) => ({ content: fragment })),
  ));
});

// 单个 delta 里多个思考字段同时在场：只取优先级最高的那一个，不重复累加/回调/发事件。
async function runSharedChunkDelta(delta) {
  const events = [];
  const reasoning = [];
  const fetchImpl = createMockFetch([{
    body: [
      sse({ choices: [{ delta, finish_reason: null }] }),
      sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
      sse({ choices: [], usage: ALIAS_USAGE }),
      "data: [DONE]\n\n",
    ].join(""),
  }]);
  const response = await makeProvider(fetchImpl).chatStream({
    ...request,
    onEvent: (event) => events.push(event),
    onReasoningDelta: (value) => reasoning.push(value),
  });
  return { events, reasoning, response };
}

function assertSingleReasoning(got, winner) {
  assert.deepEqual(got.reasoning, [winner]);
  assert.deepEqual(got.events, [
    { type: "reasoning_delta", delta: winner },
    { type: "delta", delta: "ok" },
    { type: "usage", usage: ALIAS_USAGE },
  ]);
  assert.deepEqual(got.response.content, [
    { type: "reasoning", text: winner },
    { type: "text", text: "ok" },
  ]);
}

test("issue #407: takes only reasoning_content when all three aliases share one chunk", async () => {
  assertSingleReasoning(await runSharedChunkDelta({
    reasoning_content: "from reasoning_content",
    reasoning: "from reasoning",
    reasoning_text: "from reasoning_text",
  }), "from reasoning_content");
});

test("issue #407: takes reasoning over reasoning_text when reasoning_content is absent", async () => {
  assertSingleReasoning(await runSharedChunkDelta({
    reasoning: "from reasoning",
    reasoning_text: "from reasoning_text",
  }), "from reasoning");
});

test("issue #407: an empty alias does not shadow a lower-priority field that has text", async () => {
  assertSingleReasoning(await runSharedChunkDelta({
    reasoning_content: "",
    reasoning: "from reasoning",
  }), "from reasoning");
});
