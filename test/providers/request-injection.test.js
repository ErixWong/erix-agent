// issue #181：宿主注入口 defaultHeaders / extraBody —— 两个 provider 一致实现，双侧覆盖。
// 三条红线的断言口径：
//   ① 受保护 header 不可覆盖 → TypeError（构造即失败，不静默忽略）；
//   ② header 值不进错误文案与日志（防泄漏断言与 key 脱敏同口径：只出现名字，不出现值）；
//   ③ extraBody 与引擎自有字段冲突 → 引擎字段优先 + 显式 warn（宿主不能悄悄改 stream/model）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import {
  applyExtraBody,
  createInjectionWarner,
  resolveExtraBody,
  resolveRequestHeaders,
} from "../../src/providers/http-shared.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const HOST_VALUE = "host-secret-value-4f3c";        // 任何日志/错误文案里都不许出现
const HOST_MODEL = "host-tried-to-change-model";

const openaiCase = {
  label: "openai",
  create: createOpenAIProvider,
  baseOptions: {
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
  },
  url: "https://api.example.test/v1/chat/completions",
  engineHeaders: {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  },
  // openai 侧受保护 header：Authorization / Content-Type（大小写变体同样受保护）
  protectedHeaders: ["Authorization", "authorization", "CONTENT-TYPE", "content-Type"],
  request: { messages: [{ role: "user", content: "hi" }], maxTokens: 32 },
  okResponse: {
    json: { choices: [{ message: { content: "Done" }, finish_reason: "stop" }] },
  },
  streamResponse: {
    body: [
      'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
  },
};

const anthropicCase = {
  label: "anthropic",
  create: createAnthropicProvider,
  baseOptions: {
    endpoint: "https://api.example.test",
    apiKey: "test-key",
    model: "claude-test",
  },
  url: "https://api.example.test/v1/messages",
  engineHeaders: {
    "x-api-key": "test-key",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  // anthropic 侧受保护 header：x-api-key / anthropic-version（content-type 同属引擎自有）
  protectedHeaders: ["x-api-key", "X-Api-Key", "anthropic-version", "Anthropic-Version", "Content-Type"],
  request: { messages: [{ role: "user", content: "hi" }], maxTokens: 32 },
  okResponse: {
    json: { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" },
  },
  streamResponse: {
    body: [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}\n\n',
      "event: content_block_stop\n",
      'data: {"type":"content_block_stop","index":0}\n\n',
      "event: message_delta\n",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      "event: message_stop\n",
      'data: {"type":"message_stop"}\n\n',
    ].join(""),
  },
};

const cases = [openaiCase, anthropicCase];

function makeProvider(testCase, options = {}, responseScript) {
  const fetchImpl = createMockFetch(responseScript ?? [testCase.okResponse]);
  const provider = testCase.create({
    ...testCase.baseOptions,
    fetchImpl,
    ...options,
  });
  return { fetchImpl, provider };
}

/** 捕获 console.warn（provider 的冲突告警走 stderr，宿主可整块截走）。 */
async function withWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

for (const testCase of cases) {
  const runChat = (provider) => provider.chat(testCase.request);
  const runStream = (provider) => provider.chatStream(testCase.request);

  test(`${testCase.label}: defaultHeaders 出现在实际请求头且与引擎自有 header 共存（非流式）`, async () => {
    const { fetchImpl, provider } = makeProvider(
      testCase,
      { defaultHeaders: { "X-Station-Run-Id": "run-1", "X-Station-Session-Id": "sess-1" } },
    );
    await runChat(provider);

    const call = fetchImpl.calls[0];
    assert.equal(call.url, testCase.url);
    assert.deepEqual(call.headers, {
      ...testCase.engineHeaders,
      "X-Station-Run-Id": "run-1",
      "X-Station-Session-Id": "sess-1",
    });
    // 引擎自有 header 排在前面：注入是「追加」，不会把 Authorization 挤掉
    assert.deepEqual(
      Object.keys(call.headers).slice(0, Object.keys(testCase.engineHeaders).length),
      Object.keys(testCase.engineHeaders),
    );
  });

  test(`${testCase.label}: defaultHeaders 在流式请求里同样生效（两处 header 构造点一致）`, async () => {
    const { fetchImpl, provider } = makeProvider(
      testCase,
      { defaultHeaders: { "X-Station-Run-Id": "run-2" } },
      [testCase.streamResponse],
    );
    await runStream(provider);

    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(fetchImpl.calls[0].headers, {
      ...testCase.engineHeaders,
      "X-Station-Run-Id": "run-2",
    });
  });

  test(`${testCase.label}: 宿主传受保护 header → TypeError（构造即失败，文案只带名字）`, () => {
    for (const name of testCase.protectedHeaders) {
      assert.throws(
        () => makeProvider(testCase, { defaultHeaders: { [name]: HOST_VALUE } }),
        (error) => {
          assert.ok(error instanceof TypeError, `expected TypeError for ${name}`);
          assert.match(error.message, /engine-owned header/);
          assert.ok(
            error.message.toLowerCase().includes(name.toLowerCase()),
            `message should name "${name}"`,
          );
          assert.ok(
            !error.message.includes(HOST_VALUE),
            "message must not leak the host-supplied header value",
          );
          return true;
        },
        `protected header ${name} must be rejected`,
      );
    }
  });

  test(`${testCase.label}: 不传新参数时请求头与请求体逐字节不变`, async () => {
    const baseline = makeProvider(testCase);
    const explicit = makeProvider(testCase, {
      defaultHeaders: undefined,
      extraBody: undefined,
    });
    await runChat(baseline.provider);
    await runChat(explicit.provider);

    assert.deepEqual(explicit.fetchImpl.calls, baseline.fetchImpl.calls);
    assert.deepEqual(Object.keys(baseline.fetchImpl.calls[0].headers), Object.keys(testCase.engineHeaders));
    assert.equal(
      JSON.stringify(explicit.fetchImpl.calls[0].body),
      JSON.stringify(baseline.fetchImpl.calls[0].body),
    );
  });

  test(`${testCase.label}: extraBody.user 出现在请求体（非流式与流式），且引擎字段优先`, async () => {
    const nonStream = makeProvider(testCase, {
      extraBody: { user: "fde:sess-1", tags: ["run-1"] },
    });
    await runChat(nonStream.provider);
    assert.equal(nonStream.fetchImpl.calls[0].body.user, "fde:sess-1");
    assert.deepEqual(nonStream.fetchImpl.calls[0].body.tags, ["run-1"]);
    assert.equal(nonStream.fetchImpl.calls[0].body.model, testCase.baseOptions.model);

    const streaming = makeProvider(
      testCase,
      { extraBody: { user: "fde:sess-2" } },
      [testCase.streamResponse],
    );
    await runStream(streaming.provider);
    assert.equal(streaming.fetchImpl.calls[0].body.stream, true);
    assert.equal(streaming.fetchImpl.calls[0].body.user, "fde:sess-2");
  });

  test(`${testCase.label}: extraBody 想改 model/stream/messages 一律引擎优先并显式 warn（warn 不带值）`, async () => {
    const { value, warnings } = await withWarnings(async () => {
      const { fetchImpl, provider } = makeProvider(
        testCase,
        {
          extraBody: {
            model: HOST_MODEL,
            stream: false,
            messages: "host-messages",
            user: "fde:sess-3",
          },
        },
        [testCase.okResponse, testCase.streamResponse],
      );
      await runChat(provider);
      await provider.chatStream(testCase.request);
      return fetchImpl.calls;
    });

    assert.equal(value.length, 2);
    const [nonStream, streaming] = value;
    // 非流式：model 与 messages 是引擎自有字段，stream 由引擎逐次调用决定
    assert.equal(nonStream.body.model, testCase.baseOptions.model);
    assert.ok(!("stream" in nonStream.body), "宿主不得把非流式调用偷偷改成流式");
    assert.ok(Array.isArray(nonStream.body.messages));
    assert.equal(nonStream.body.user, "fde:sess-3");
    // 流式：stream 仍为 true，model 仍为引擎值
    assert.equal(streaming.body.stream, true);
    assert.equal(streaming.body.model, testCase.baseOptions.model);
    assert.ok(warnings.some((line) => line.includes("\"model\"")));
    assert.ok(warnings.some((line) => line.includes("\"stream\"")));
    assert.ok(warnings.some((line) => line.includes("\"messages\"")));
    assert.ok(
      warnings.every((line) => !line.includes(HOST_MODEL) && !line.includes("host-messages")),
      "warn 文案只带字段名，不带宿主值",
    );
  });

  test(`${testCase.label}: extraBody 保留字段冲突按 provider 实例去重告警，且告警不含字段值`, async () => {
    const { value, warnings } = await withWarnings(async () => {
      const { fetchImpl, provider } = makeProvider(
        testCase,
        { extraBody: { max_tokens: 7, temperature: 1.5, user: "u" } },
        [testCase.okResponse, testCase.okResponse],
      );
      await runChat(provider);
      await runChat(provider);
      return fetchImpl.calls;
    });

    const body = value[0].body;
    assert.ok(body.max_tokens !== 7, "engine max_tokens wins over extraBody");
    assert.ok(!("temperature" in body), "保留键即使引擎未写也不让宿主塞进来");
    assert.equal(body.user, "u");
    const conflictMessages = warnings.filter((line) => line.includes("extraBody"));
    assert.ok(conflictMessages.length > 0, "reserved extraBody keys must be warned");
    assert.ok(conflictMessages.some((line) => line.includes("\"max_tokens\"")));
    assert.ok(
      conflictMessages.every((line) => !line.includes("host-secret") && !line.includes(String(1.5))),
      "warn output carries field names only, never host values",
    );
    // 同一字段只说一次（第二次请求不得重复刷屏）
    const modelWarnings = warnings.filter((line) => line.includes("\"max_tokens\""));
    assert.equal(modelWarnings.length, 1);
  });

  test(`${testCase.label}: 引擎已写入的同名非保留字段仍是引擎优先（providerOptions 通道）`, async () => {
    const { value, warnings } = await withWarnings(async () => {
      const { fetchImpl, provider } = makeProvider(testCase, {
        providerOptions: { user: "engine-user" },
        extraBody: { user: "host-user" },
      });
      await runChat(provider);
      return fetchImpl.calls;
    });

    assert.equal(value[0].body.user, "engine-user");
    assert.ok(warnings.some((line) => line.includes("\"user\"")));
    assert.ok(warnings.every((line) => !line.includes("host-user")));
  });

  test(`${testCase.label}: 逐请求 header 是新副本（宿主 transport 改写不得污染后续请求）`, async () => {
    const seen = [];
    const transport = (options) => {
      seen.push({ ref: options.headers, hadTrace: "X-Transport-Trace" in options.headers });
      options.headers["X-Transport-Trace"] = "added-by-wrapper";
      return options;
    };
    const { fetchImpl, provider } = makeProvider(
      testCase,
      { defaultHeaders: { "X-Station-Run-Id": "run-x" }, transport },
      [testCase.okResponse, testCase.okResponse],
    );
    await runChat(provider);
    await runChat(provider);

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].ref, seen[1].ref, "两个请求不得共享同一个 header 对象");
    assert.deepEqual(
      seen.map((entry) => entry.hadTrace),
      [false, false],
      "包装层改写不得泄到下一个请求",
    );
    assert.equal(seen[1].ref["X-Station-Run-Id"], "run-x");
    assert.equal(fetchImpl.calls[1].headers.Authorization, testCase.engineHeaders.Authorization);
  });

  test(`${testCase.label}: 默认 header 值不进日志与错误文案（HTTP 错误 / 网络异常两条路径）`, async () => {
    const failing = makeProvider(
      testCase,
      { defaultHeaders: { "X-Station-Run-Id": HOST_VALUE } },
      [{ status: 500, body: "upstream exploded" }],
    );
    await assert.rejects(
      () => runChat(failing.provider),
      (error) => {
        assert.ok(!String(error.message).includes(HOST_VALUE), "HTTP error text must not carry header value");
        assert.ok(!String(error?.cause?.message ?? "").includes(HOST_VALUE));
        return true;
      },
    );
    assert.equal(failing.fetchImpl.calls[0].headers["X-Station-Run-Id"], HOST_VALUE);

    const throwing = makeProvider(
      testCase,
      { defaultHeaders: { "X-Station-Run-Id": HOST_VALUE } },
      [{ throw: new Error("socket hang up") }],
    );
    await assert.rejects(
      () => runChat(throwing.provider),
      (error) => {
        assert.ok(!String(error.message).includes(HOST_VALUE), "network error text must not carry header value");
        return true;
      },
    );
  });

  test(`${testCase.label}: header 名/值校验失败一律 TypeError，且文案不回显宿主值`, () => {
    const badCases = [
      { input: "not-an-object", error: /plain object/ },
      { input: ["X-A", "1"], error: /plain object/ },
      { input: { "X Bad": "1" }, error: /invalid header name/ },
      { input: { "": "1" }, error: /non-empty header names/ },
      { input: { "X-Bad": `line1\nline2-${HOST_VALUE}` }, error: /CR, LF, or NUL/ },
      { input: { "X-Bad": { nested: HOST_VALUE } }, error: /string, number, or boolean/ },
    ];
    for (const { input, error } of badCases) {
      assert.throws(
        () => makeProvider(testCase, { defaultHeaders: input }),
        (err) => {
          assert.ok(err instanceof TypeError, `expected TypeError for ${JSON.stringify(input)}`);
          assert.match(err.message, error);
          assert.ok(!err.message.includes(HOST_VALUE), "validation message must not echo the value");
          return true;
        },
        `rejected defaultHeaders: ${JSON.stringify(input)}`,
      );
    }
  });

  test(`${testCase.label}: 值为 undefined/null 的 header 跳过（宿主条件注入）`, async () => {
    const { fetchImpl, provider } = makeProvider(testCase, {
      defaultHeaders: { "X-Set": "1", "X-Absent": undefined, "X-Null": null, "X-Num": 42, "X-Flag": true },
    });
    await runChat(provider);
    assert.deepEqual(fetchImpl.calls[0].headers, {
      ...testCase.engineHeaders,
      "X-Set": "1",
      "X-Num": "42",
      "X-Flag": "true",
    });
  });

  test(`${testCase.label}: extraBody 形态非法 → TypeError；构造后宿主改对象不影响请求`, async () => {
    assert.throws(
      () => makeProvider(testCase, { extraBody: "user=1" }),
      (error) => error instanceof TypeError && /plain object/.test(error.message),
    );
    assert.throws(
      () => makeProvider(testCase, { extraBody: ["user"] }),
      (error) => error instanceof TypeError && /plain object/.test(error.message),
    );

    const extraBody = { user: "fde:sess-9" };
    const { fetchImpl, provider } = makeProvider(testCase, { extraBody });
    extraBody.user = "mutated-after-construction";
    delete extraBody.user;
    extraBody.late = "added-after-construction";
    await runChat(provider);
    assert.equal(fetchImpl.calls[0].body.user, "fde:sess-9");
    assert.ok(!("late" in fetchImpl.calls[0].body));
  });
}

// 上面「引擎字段优先」用例里流式那一段需要真实 SSE 响应，单独收尾，避免脚本耗尽。
test("http-shared: resolveRequestHeaders 追加而非覆盖，引擎 header 排在前", () => {
  const headers = resolveRequestHeaders(
    { Authorization: "Bearer k", "Content-Type": "application/json" },
    { "X-Run": "r" },
  );
  assert.deepEqual(Object.keys(headers), ["Authorization", "Content-Type", "X-Run"]);
  assert.throws(
    () => resolveRequestHeaders({ "x-api-key": "k" }, { "X-API-KEY": "v" }),
    /engine-owned header "x-api-key"/,
  );
  // 受保护名字即使值为 undefined 也拒：宿主写了它就不是「没写」。
  assert.throws(
    () => resolveRequestHeaders({ Authorization: "Bearer k" }, { authorization: undefined }),
    /engine-owned header "Authorization"/,
  );
  assert.deepEqual(resolveRequestHeaders({ A: "1" }, undefined), { A: "1" });
  assert.deepEqual(resolveRequestHeaders({ A: "1" }, {}), { A: "1" });
});

test("http-shared: applyExtraBody 引擎优先、跳过 undefined、不碰保留键", () => {
  const conflicts = [];
  const payload = applyExtraBody(
    { model: "engine", stream: true, user: "engine-user" },
    { model: "host", stream: false, user: "host", temperature: 1, note: undefined, tag: "t" },
    (field) => conflicts.push(field),
  );
  assert.deepEqual(payload, {
    model: "engine",
    stream: true,
    user: "engine-user",
    tag: "t",
  });
  assert.deepEqual(conflicts, ["model", "stream", "user", "temperature"]);
  assert.deepEqual(applyExtraBody({ a: 1 }, undefined), { a: 1 });
});

test("http-shared: createInjectionWarner 去重且只打印字段名", () => {
  const lines = [];
  const warn = createInjectionWarner((message) => lines.push(message));
  warn("model");
  warn("model");
  warn("stream");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /extraBody field "model"/);
  assert.match(lines[1], /engine value wins/);
});

test("http-shared: resolveExtraBody 构造期就对保留键告警，值为 undefined 不算冲突", () => {
  const conflicts = [];
  const resolved = resolveExtraBody({ stream: true, user: "u" }, (field) => conflicts.push(field));
  assert.deepEqual(conflicts, ["stream"]);
  assert.deepEqual(resolved, { stream: true, user: "u" });
  assert.equal(resolveExtraBody(undefined), undefined);
  assert.equal(resolveExtraBody(null), undefined);
  assert.throws(() => resolveExtraBody("user=1"), TypeError);

  const untouched = [];
  assert.deepEqual(
    resolveExtraBody({ stream: undefined }, (field) => untouched.push(field)),
    { stream: undefined },
  );
  assert.deepEqual(untouched, [], "值为 undefined 的保留键不构成冲突");
});
