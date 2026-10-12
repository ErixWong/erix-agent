// 真上游 HTTP 端到端层（issue #257 T1）。
//
// 与 test/providers/*.test.js 的**相反**做法：这里**不注入 fetchImpl**，用真的
// `createOpenAIProvider` / `createAnthropicProvider` 打 `fixtures/upstream.mjs`
// 起的真 `http.createServer`，于是 SSE 分帧、跨包切片、半截流、真 HTTP 状态码与
// 首字节超时都是**真 socket 上发生的事**，而不是测试自己写的假 fetch 的形状。
//
// 离线、确定、默认跑：上游只绑 127.0.0.1:0，延迟一律 ≤ 50ms，不依赖外网与真实秒级等待。
import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicTextEvents,
  createScriptedUpstream,
  DEFAULT_IRREGULAR_SLICE_CYCLE,
  jsonResponse,
  openAITextChunks,
  sseAnthropic,
  sseOpenAI,
  sseResponse,
  textResponse,
} from "../../fixtures/upstream.mjs";
import { createAnthropicProvider } from "../../src/providers/anthropic.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";

const API_KEY = "scripted-key";
const MODEL = "scripted-model";

// ---------------------------------------------------------------------------
// 代理防御（工单硬要求 1）：宿主/CI 可能设了代理，且 Node ≥ 24 打开
// NODE_USE_ENV_PROXY=1 时，**127.0.0.1 也会被送给代理** → 真 socket 层要么连不上
// （假红），要么被代理应答（假绿）。所以每条用例进出都保存并删除这些变量，
// t.after 还原。NODE_USE_ENV_PROXY 本身也一起摘掉：它就是「按环境变量走代理」的开关。
// ---------------------------------------------------------------------------
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
];

function isolateProxyEnv(t) {
  const saved = new Map();
  for (const key of PROXY_ENV_KEYS) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// 上游一律绑端口 0（写死端口会撞车）；close() 必须挂在 t.after 上，漏关会挂住整个套件。
async function startUpstream(t, options) {
  isolateProxyEnv(t);
  const upstream = createScriptedUpstream(options);
  t.after(() => upstream.close());
  const baseUrl = await upstream.listen();
  return { upstream, baseUrl };
}

function openAIProvider(baseUrl) {
  return createOpenAIProvider({ endpoint: baseUrl, apiKey: API_KEY, model: MODEL });
}

function anthropicProvider(baseUrl) {
  return createAnthropicProvider({ endpoint: baseUrl, apiKey: API_KEY, model: MODEL });
}

const USER_MSG = [{ role: "user", content: "go" }];

// 真 socket 层不该有隐藏默认值：所有 provider 请求都用这一份最小请求体。
function providerRequest(overrides = {}) {
  return { messages: USER_MSG, ...overrides };
}

async function rejection(promise) {
  try {
    const value = await promise;
    return { threw: false, value };
  } catch (err) {
    return { threw: true, err };
  }
}

function kitShape(err) {
  return {
    name: err?.name,
    code: err?.code,
    retryable: err?.retryable,
    ...(err?.phase === undefined ? {} : { phase: err.phase }),
    ...(err?.status === undefined ? {} : { status: err.status }),
  };
}

// 上游收到的请求体应当**逐字节相同**（重发的价值就在此：不是「又发了一次」，
// 而是「把同一份 payload 又发了一次」）。
function assertIdenticalBodies(requests) {
  const [first, ...rest] = requests;
  for (const entry of rest) {
    assert.equal(entry.bodyText, first.bodyText, "重发请求体必须与首发逐字节相同");
    assert.equal(entry.headers.authorization, first.headers.authorization, "重发必须带上同一份鉴权头");
  }
}

// 把帧拼回字符串，并给出「每个切片结束时的累计偏移」——用它证明**包边界落在帧内部**
// （即真的跨包），而不是恰好都压在帧边界上。
function boundariesInsideFrames(frames, sliceSizes) {
  const frameEnds = new Set();
  let cursor = 0;
  for (const frame of frames) {
    cursor += frame.length;
    frameEnds.add(cursor);
  }
  const offsets = [];
  cursor = 0;
  for (const size of sliceSizes) {
    cursor += size;
    offsets.push(cursor);
  }
  // 最后一个偏移就是全文末尾，必然压帧边界，排除后再判断。
  return offsets.slice(0, -1).filter((offset) => !frameEnds.has(offset));
}

// ---------------------------------------------------------------------------
// 1. 流完整性（两种协议各一条）
// ---------------------------------------------------------------------------

const OPENAI_TOOL_FRAMES = sseOpenAI([
  { choices: [{ index: 0, delta: { role: "assistant", content: "我先" } }] },
  { choices: [{ index: 0, delta: { content: "看一眼" } }] },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: "" },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a/b"}' } }] } }] },
  {
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
  },
]);

test("真上游：OpenAI 流完整性——文本增量、tool_calls 跨帧累加、usage 与鉴权头都走真 socket（#257 T1）", async (t) => {
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames: OPENAI_TOOL_FRAMES })],
  });

  const deltas = [];
  const events = [];
  const usageCallbacks = [];
  const result = await openAIProvider(baseUrl).chatStream(providerRequest({
    onDelta: (text) => deltas.push(text),
    onEvent: (event) => events.push(event.type),
    onUsage: (usage) => usageCallbacks.push(usage),
  }));

  assert.equal(deltas.join(""), "我先看一眼", "文本增量拼接必须完整");
  assert.deepEqual(deltas, ["我先", "看一眼"], "增量边界必须就是帧边界");
  assert.deepEqual(result.content, [
    { type: "text", text: "我先看一眼" },
    { type: "tool_use", id: "call_1", name: "exec", input: { path: "a/b" } },
  ], "tool_call 参数分三帧到达也必须累加成一个完整 input");
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 5, cacheRead: 2 });
  assert.deepEqual(usageCallbacks, [
    { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } },
  ], "onUsage 必须把上游原始 usage 交出去");
  assert.ok(events.includes("usage"), "usage 事件也要经 onEvent 出来");

  // 服务端视角：先等服务端写循环跑完（客户端读完 ≠ 服务端写完），只发了一发，
  // 且 payload/header 是真 HTTP 收到的形状。
  await upstream.settled();
  assert.equal(upstream.requestCount, 1);
  const request = upstream.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.json.model, MODEL);
  assert.equal(request.json.stream, true);
  assert.deepEqual(request.json.stream_options, { include_usage: true });
  // 一帧一次 write：写分片数必须等于帧数（也是「协议确实发全了」的证据）。
  assert.equal(upstream.responses[0].writes.length, OPENAI_TOOL_FRAMES.length);
});

test("真上游：Anthropic 流完整性——event/data 双行帧、usage 合并、stop_reason 走真 socket（#257 T1）", async (t) => {
  const events = anthropicTextEvents(["你好", " Anthropic"], {
    usage: { input_tokens: 7, output_tokens: 5 },
  });
  const frames = sseAnthropic(events);
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames })],
  });

  const deltas = [];
  const usageCallbacks = [];
  const result = await anthropicProvider(baseUrl).chatStream(providerRequest({
    onDelta: (text) => deltas.push(text),
    onUsage: (usage) => usageCallbacks.push(usage),
  }));

  assert.equal(deltas.join(""), "你好 Anthropic");
  assert.deepEqual(result.content, [{ type: "text", text: "你好 Anthropic" }]);
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 5 }, "message_start 的 input 与 message_delta 的 output 必须合并");
  assert.equal(usageCallbacks.length, 1);

  await upstream.settled();
  const request = upstream.requests[0];
  assert.equal(request.path, "/v1/messages");
  assert.equal(request.headers["x-api-key"], API_KEY);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.json.stream, true);
  // 协议完整性：message_start → …→ message_stop 六个事件必须**逐个一次 write** 发完，
  // 且**服务端实际发出的最后一帧**就是 message_stop（取服务端记录，不是测试自指）。
  assert.equal(upstream.responses[0].writes.length, events.length);
  assert.ok(
    String(upstream.responses[0].frames.at(-1)).includes("message_stop"),
    "服务端发出的最后一帧必须是 message_stop",
  );
  assert.ok(
    String(upstream.responses[0].frames[0]).includes("message_start"),
    "服务端发出的第一帧必须是 message_start",
  );
});

test("真上游：Anthropic 缺 message_stop 时引擎当前行为（容忍，不报错）（#257 T1）", async (t) => {
  // 「当前行为」：装配器在流 EOF 处收尾，少一个 message_stop 不改变 content/usage，
  // 只有 stop_reason 的来源会丢（这里 message_delta 已给，所以整体不变）。
  // 之所以钉住：如果哪天引擎改成「必须见到 message_stop」，这条会红，而不是静默漂移。
  const events = anthropicTextEvents(["少了", "收尾"]);
  const frames = sseAnthropic(events.slice(0, -1));
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames })],
  });

  const result = await anthropicProvider(baseUrl).chatStream(providerRequest());
  await upstream.settled();
  assert.deepEqual(result.content, [{ type: "text", text: "少了收尾" }]);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(upstream.responses[0].writes.length, frames.length);
  assert.equal(upstream.responses[0].completed, true, "这一条是正常 end，不是 destroy");
});

// ---------------------------------------------------------------------------
// 2. 跨包分帧：字节级 / 不规则切片必须与正常分帧**逐字相同**
// ---------------------------------------------------------------------------

test("真上游：夹具自检——1 字节写真的把一帧切成多个 TCP 包，包边界落在帧内部（#257 T1）", async (t) => {
  // 用裸 fetch 读（不经过 provider），直接数**客户端收到的 chunk**：
  // 这是「跨包」的客户端侧证据；provider 侧的断言只能看解析结果。
  const frames = sseOpenAI(openAITextChunks(["跨包", "分帧", "验证"]), { done: false });
  const body = frames.join("");
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames, framing: "byte" })],
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const decoder = new TextDecoder();
  const chunks = [];
  for await (const value of response.body) {
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  await upstream.settled();

  const received = chunks.join("");
  assert.equal(received, body, "分片写出去的字节拼起来必须就是原文");
  assert.ok(chunks.length > 1, `客户端必须看到多个包，实际 ${chunks.length} 个`);

  const plan = upstream.responses[0].writes;
  assert.deepEqual(plan, new Array(body.length).fill(1), "1 字节写：每片长度都是 1");
  const inside = boundariesInsideFrames(frames, plan);
  assert.ok(inside.length > 0, "必须存在落在帧内部的包边界，否则根本没跨包");
  // 至少要有一个包边界落在帧内部：客户端收到的包里有**不以空行结尾**的包，
  // 就说明包尾停在帧中间（半行 JSON）——跨包解析最容易翻车的地方。
  assert.ok(
    chunks.some((chunk) => chunk.length > 0 && !chunk.endsWith("\n\n")),
    `必须有包停在帧中间，实际包边界：${JSON.stringify(chunks.map((chunk) => chunk.length))}`,
  );
  assert.ok(
    Math.min(...chunks.map((chunk) => chunk.length)) < frames[0].length,
    "必须有包比一帧还短（包尾在帧内）",
  );
});

const OPENAI_SPLIT_FRAMES = sseOpenAI([
  ...openAITextChunks(["alpha", " beta", " gamma"]),
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "readFile", arguments: '{"pa' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '/y"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 3 } },
]);

async function runOpenAIWithFraming(t, framing) {
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames: OPENAI_SPLIT_FRAMES, framing })],
  });
  const deltas = [];
  const result = await openAIProvider(baseUrl).chatStream(providerRequest({
    onDelta: (text) => deltas.push(text),
  }));
  // 写计划是**服务端侧**记录，必须等它跑完才能断言。
  await upstream.settled();
  return { upstream, deltas, result };
}

test("真上游：1 字节切片的解析结果与正常分帧**逐字相同**（#257 T1）", async (t) => {
  const baseline = await runOpenAIWithFraming(t, "frames");
  const split = await runOpenAIWithFraming(t, "byte");

  // 跨包断言：切片必须比帧多，且存在帧内部的边界——否则「跨包」是假的。
  assert.ok(
    split.upstream.responses[0].writes.length > OPENAI_SPLIT_FRAMES.length,
    "byte 分片的写次数必须大于帧数（真的把帧切开了）",
  );
  assert.ok(
    boundariesInsideFrames(OPENAI_SPLIT_FRAMES, split.upstream.responses[0].writes).length > 0,
    "必须存在帧内部边界",
  );
  assert.equal(baseline.upstream.responses[0].writes.length, OPENAI_SPLIT_FRAMES.length);

  assert.deepEqual(split.deltas, baseline.deltas, "增量序列必须逐字相同");
  assert.deepEqual(split.result, baseline.result, "终局结果必须逐字相同");
  assert.equal(split.deltas.join(""), "alpha beta gamma");
  assert.deepEqual(split.result.content, [
    { type: "text", text: "alpha beta gamma" },
    { type: "tool_use", id: "call_9", name: "readFile", input: { path: "x/y" } },
  ], "半行 JSON 的 tool 参数也必须拼对");
  assert.deepEqual(split.result.usage, { input_tokens: 8, output_tokens: 3 });
});

test("真上游：不规则切片（irregular 循环）与正常分帧逐字相同（#257 T1）", async (t) => {
  const baseline = await runOpenAIWithFraming(t, "frames");
  const split = await runOpenAIWithFraming(t, "irregular");

  const plan = split.upstream.responses[0].writes;
  assert.ok(plan.length > OPENAI_SPLIT_FRAMES.length);
  assert.ok(new Set(plan).size > 1, "切片长度必须是不规则的");
  assert.deepEqual(
    plan.slice(0, DEFAULT_IRREGULAR_SLICE_CYCLE.length),
    DEFAULT_IRREGULAR_SLICE_CYCLE,
    "切片必须真的按 irregular 循环走",
  );
  assert.ok(boundariesInsideFrames(OPENAI_SPLIT_FRAMES, plan).length > 0);
  assert.deepEqual(split.deltas, baseline.deltas);
  assert.deepEqual(split.result, baseline.result);
});

// ---------------------------------------------------------------------------
// 3. 半截流（三种畸形流之二）：如实按实测钉
// ---------------------------------------------------------------------------

test("真上游：OpenAI 半截流——帧写完但无 [DONE] 就 destroy，按实测当前行为（#257 T1）", async (t) => {
  const frames = sseOpenAI(openAITextChunks(["半", "截"]), { done: false });
  const { upstream, baseUrl } = await startUpstream(t, {
    // destroyDelayMs=20：先给客户端 20ms 把已发帧读走，再 destroy——这才是
    // “收到一半后断”。实测：不留这个间隙时 undici 会把已缓冲的帧连错误一起丢掉。
    script: [sseResponse({ frames, truncateAfterWrites: frames.length, destroyDelayMs: 20 })],
  });

  const deltas = [];
  const { threw, err, value } = await rejection(
    openAIProvider(baseUrl).chatStream(providerRequest({ onDelta: (text) => deltas.push(text) })),
  );

  assert.equal(upstream.responses[0].truncated, true, "上游必须真的 destroy 而不是 end");
  assert.equal(upstream.responses[0].completed, false);
  // 当前行为（不美化）：chunked 流没有终止块 → fetch 读体报错 → 归类 network，且**不重试**。
  assert.equal(threw, true, `必须失败，实际拿到 ${JSON.stringify(value)}`);
  assert.equal(err.name, "KitError");
  assert.equal(err.code, "network");
  assert.equal(err.retryable, false);
  assert.equal(err.phase, "streamIdle", "错误必须带上报流阶段（已经收到过数据后断的）");
  assert.equal(err.status, 200, "状态码要保留：半截流是 200 之后断的");
  assert.equal(deltas.join(""), "半截", "已到达的增量不能丢");
  assert.equal(upstream.requestCount, 1, "provider 自己不重试");
});

test("真上游：OpenAI 半截流（帧中间断，半行 JSON）当前行为（#257 T1）", async (t) => {
  const frames = sseOpenAI(openAITextChunks(["半行", "JSON"]), { done: false });
  const { upstream, baseUrl } = await startUpstream(t, {
    // 不规则切片 + 写到第 30 片就 destroy：必然断在某一帧的中间。
    script: [sseResponse({ frames, framing: [1, 2], truncateAfterWrites: 30 })],
  });

  const { threw, err } = await rejection(openAIProvider(baseUrl).chatStream(providerRequest()));
  await upstream.settled();
  const plan = upstream.responses[0].writes;
  assert.equal(plan.length, 30);
  assert.ok(boundariesInsideFrames(frames, plan).length > 0, "断点必须在帧内部，否则没测到半行 JSON");
  assert.equal(threw, true);
  assert.equal(err.code, "network");
  assert.equal(err.retryable, false);
});

test("真上游：Anthropic 半截流——无 message_stop 就 destroy，当前行为（#257 T1）", async (t) => {
  const events = anthropicTextEvents(["断了", "一半"]);
  const frames = sseAnthropic(events.slice(0, 4));
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames, truncateAfterWrites: frames.length, destroyDelayMs: 20 })],
  });

  const deltas = [];
  const { threw, err, value } = await rejection(
    anthropicProvider(baseUrl).chatStream(providerRequest({ onDelta: (text) => deltas.push(text) })),
  );
  assert.equal(upstream.responses[0].truncated, true);
  await upstream.settled();
  assert.equal(upstream.responses[0].truncated, true, "destroy 不能被后续写覆盖");
  assert.equal(threw, true, `必须失败，实际拿到 ${JSON.stringify(value)}`);
  assert.equal(err.name, "KitError");
  assert.equal(err.code, "network");
  assert.equal(err.retryable, false);
  assert.equal(err.status, 200);
  assert.equal(deltas.join(""), "断了一半", "destroy 之前送达的增量必须已经回调出去");
});

// ---------------------------------------------------------------------------
// 4. 状态码分类走真 HTTP（retryable 是既有契约，一个不许动）
// ---------------------------------------------------------------------------

async function expectStatusError(t, status, { via, provider = openAIProvider, headers = {} }) {
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [jsonResponse({ error: { message: `upstream says ${status}`, type: "upstream_error" } }, { status, headers })],
  });
  const instance = provider(baseUrl);
  const call = via === "stream" ? instance.chatStream(providerRequest()) : instance.chat(providerRequest());
  const { threw, err, value } = await rejection(call);
  assert.equal(threw, true, `status ${status} 必须失败，实际拿到 ${JSON.stringify(value)}`);
  return { err, upstream };
}

test("真上游：400 → invalid_request / retryable=false，上游只收到一发（#257 T1）", async (t) => {
  const { err, upstream } = await expectStatusError(t, 400, { via: "body" });
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "invalid_request", retryable: false, phase: "request", status: 400,
  });
  assert.equal(err.message, "upstream says 400", "上游错误文案必须透传");
  assert.equal(upstream.requestCount, 1, "不可重试的错误绝不能发第二发");
  assert.equal(upstream.responses[0].status, 400, "上游必须真的回了 400（不是测试自己伪造）");
});

test("真上游：404 → not_found / retryable=false，只发一发（#257 T1）", async (t) => {
  const { err, upstream } = await expectStatusError(t, 404, { via: "body" });
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "not_found", retryable: false, phase: "request", status: 404,
  });
  assert.equal(upstream.requestCount, 1);
});

test("真上游：409 → conflict / retryable=false，只发一发（#257 T1）", async (t) => {
  const { err, upstream } = await expectStatusError(t, 409, { via: "body" });
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "conflict", retryable: false, phase: "request", status: 409,
  });
  assert.equal(upstream.requestCount, 1);
});

test("真上游：429 → rate_limited / retryable=true，宿主重发时真发出第二发且请求体相同（#257 T1）", async (t) => {
  const { err, upstream } = await expectStatusError(t, 429, {
    via: "body",
    headers: { "retry-after": "0" },
  });
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "rate_limited", retryable: true, phase: "request", status: 429,
  });
  assert.equal(upstream.responses[0].headers["retry-after"], "0", "上游确实回了 retry-after");
  assert.equal(upstream.requestCount, 1, "provider 本身不重试：重试是 loop/宿主层的契约");

  // retryable=true 的全部意义：宿主按契约重发。这里真的再发一次，验它到得了、且 payload 不变。
  const second = await rejection(
    openAIProvider(upstream.baseUrl).chat(providerRequest()),
  );
  assert.equal(second.threw, true);
  assert.equal(second.err.code, "rate_limited");
  assert.equal(upstream.requestCount, 2, "重发必须真的到上游");
  assertIdenticalBodies(upstream.requests);
});

test("真上游：503 → server / retryable=true，流式路径同样分类，只发一发（#257 T1）", async (t) => {
  const { upstream, baseUrl } = await startUpstream(t, {
    // 真上游用 text/plain 回 5xx：验引擎不靠 content-type 猜状态语义。
    script: [textResponse("upstream exploding", { status: 503 })],
  });
  const { err } = await rejection(openAIProvider(baseUrl).chatStream(providerRequest()));
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "server", retryable: true, phase: "request", status: 503,
  });
  assert.equal(err.message, "upstream exploding");
  assert.equal(upstream.requestCount, 1);
});

// ---------------------------------------------------------------------------
// 5. 超时 / 中止（三种畸形流之三：迟迟不发 header）
// ---------------------------------------------------------------------------

const SLOW_FRAMES = sseOpenAI(openAITextChunks(["慢"]), { done: false });

test("真上游：header 迟迟不到 → timeout / retryable=true / phase=request，不发第二发（#257 T1）", async (t) => {
  const { upstream, baseUrl } = await startUpstream(t, {
    // 上游 45ms 才发 header，provider 20ms 就放弃：仍是毫秒级，不拖慢套件。
    // undici 的 fetch() 要收到 header 才 resolve，所以这一路命中的是 **request** 阶段。
    // 20ms 而不是 5ms：request 阶段的时钟从调用起就开着，5ms 会跟 TCP 连接建立赛跑，
    // 请求可能根本没上线 → “不发第二发”退化成“一发也没发”的偶发红。
    script: [sseResponse({ frames: SLOW_FRAMES, delayFirstByteMs: 45 })],
  });

  const { err } = await rejection(
    openAIProvider(baseUrl).chatStream(providerRequest({ requestTimeoutMs: 20 })),
  );
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "timeout", retryable: true, phase: "request",
  });
  await upstream.settled();
  assert.equal(upstream.requestCount, 1, "超时后绝不能自己补一发");
  assert.equal(upstream.responses[0].truncated, "client-gone", "上游必须观察到客户端真的走了");
});

test("真上游：header 已到、body 字节迟迟不到 → phase=firstByte，不发第二发（#257 T1）", async (t) => {
  // 与上一条分开钉：firstByte 时钟从 header **之后**才起算，两者是不同的分类通道。
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames: SLOW_FRAMES, delayBodyMs: 45 })],
  });

  const { err } = await rejection(
    openAIProvider(baseUrl).chatStream(providerRequest({ firstByteTimeoutMs: 10 })),
  );
  assert.deepEqual(kitShape(err), {
    name: "KitError", code: "timeout", retryable: true, phase: "firstByte",
  });
  await upstream.settled();
  assert.equal(upstream.requestCount, 1);
  assert.equal(upstream.responses[0].truncated, "client-gone");
});

test("真上游：外部 AbortSignal 打断非流式 → aborted / retryable=false，不发第二发（#257 T1）", async (t) => {
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames: SLOW_FRAMES, delayFirstByteMs: 45 })],
  });
  const controller = new AbortController();
  const pending = openAIProvider(baseUrl).chat(providerRequest({ signal: controller.signal }));
  pending.catch(() => {});
  // 等上游真的收到这一发再中止：否则中止可能赢在 TCP 连接建立之前，
  // “不发第二发”会退化成“一发也没发”的假断言。
  assert.equal(await upstream.waitForRequests(1), true, "上游必须先收到首发");
  controller.abort();

  const { err } = await rejection(pending);
  assert.equal(err.name, "KitError");
  assert.equal(err.code, "aborted");
  assert.equal(err.retryable, false);
  assert.equal(upstream.requestCount, 1);
});

test("真上游：外部 AbortSignal 打断流式 → 抛原始 AbortError（当前行为），不发第二发（#257 T1）", async (t) => {
  // 当前行为：流式路径把外部中止**原样**抛出（AbortError，而不是 KitError），
  // 与 chat() 的 KitError("aborted") 不同口径——本单不改 src/，只把差异钉住。
  const { upstream, baseUrl } = await startUpstream(t, {
    script: [sseResponse({ frames: SLOW_FRAMES, delayFirstByteMs: 45 })],
  });
  const controller = new AbortController();
  const pending = openAIProvider(baseUrl).chatStream(providerRequest({ signal: controller.signal }));
  pending.catch(() => {});
  assert.equal(await upstream.waitForRequests(1), true, "上游必须先收到首发");
  controller.abort();

  const { threw, err } = await rejection(pending);
  assert.equal(threw, true);
  assert.equal(err.name, "AbortError");
  assert.notEqual(err.code, "aborted", "流式路径当前不包装成 KitError（如实钉住）");
  assert.equal(upstream.requestCount, 1);
});

// ---------------------------------------------------------------------------
// 6. 端到端接线：只有这一条碰 runToolLoop
// ---------------------------------------------------------------------------

test("真上游：runToolLoop 一轮——429 触发真重发，终局与 usage 形状（#257 T1）", async (t) => {
  const okFrames = sseOpenAI([
    {
      choices: [{ index: 0, delta: { content: "收尾文本" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    },
  ]);
  const { upstream, baseUrl } = await startUpstream(t, {
    // 第一发 429（可重试），第二发成功：脚本按请求序号取用，正好覆盖重发。
    script: [
      jsonResponse({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "0" } }),
      sseResponse({ frames: okFrames }),
    ],
  });

  const result = await runToolLoop({
    provider: openAIProvider(baseUrl),
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 2,
    stallDetection: false,
    completion: false,
    stream: true,
    retry: { attempts: 1, backoffBaseMs: 0 },
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
  assert.equal(upstream.requestCount, 2, "429 必须由 loop 层真的重发到上游");
  assertIdenticalBodies(upstream.requests);
  assert.equal(upstream.responses[0].status, 429);
  assert.equal(upstream.responses[1].status, 200);
});
