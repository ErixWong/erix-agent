// issue #296 的**整条链**：守卫分支（`unrecoverable`）→ **真适配器**发出请求 → 上游 400 分类 →
// 终局。`test/loop-296-user-turn-unrecoverable.test.js` 用的是文件内自写的 `scriptedProvider`
// （400 只活在注释里），`test/providers/*.test.js` 只把 400/422 分类成 `invalid_request` 而从不
// 让一条**真的**请求带着「没有 user 轮」的形状走到那一步。两者之间的缝就是本文件补的那一格：
//
//   · provider 是**真的** `createOpenAIProvider` / `createAnthropicProvider`（真适配器自己拼 URL、
//     自己组 body、自己解析状态码），只有 `fetchImpl` 是离线的——不碰网络、不要密钥、不写盘、
//     不读 `~/.erix`；
//   · stub 上游**不是无条件回 400**：它读请求体，`messages` 里真有 `role:"user"` 就回 200。于是
//     「400 是这条 user 消息形态招来的」由上游自己证出来，而不是测试写死一个状态码。
//
// 一条测试里跑完的四件事（#296 原始抱怨的对照面：以前宿主「只能看到一个和守卫无关的 400」）：
//   1) 守卫退到 `unrecoverable` ⇒ 事件真的发出（宿主可观察）；
//   2) 请求真的经真适配器发出，且请求体里**没有** user 轮（正是上游拒绝的那种形态）；
//   3) 400 被分类成 `invalid_request`（不是被吞成普通失败 / `unknown`）；
//   4) 同一份终局里**既**拿得到事件、**也**拿得到错误分类（事件先到 ⇒ 宿主能把 400 归到它身上）。
//
// 判据之外的一条纪律：事件必须在**请求发出之前**就到（`src/loop/orchestrator.js` 里
// `recordUserTurnUnrecoverable` 的理由就是这么写的）。所以 stub 上游在被调用的**那一刻**数一遍
// 已经收到的 `user_turn_guard_unrecoverable`——顺序不是靠事件数组的先后猜的。

import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";

const API_KEY = "offline-stub-key";
const MODEL = "offline-stub-model";
/** 真上游（OpenAI 兼容 relay）对没有 user 轮的 messages 回的那句话（`request-user-view.js` 文件头同源）。 */
const UPSTREAM_MESSAGE = "No user query found in messages";

const PAD_TOOL = {
  name: "pad",
  description: "returns deterministic filler",
  inputSchema: { type: "object", properties: { step: { type: "number" } }, required: [] },
};

const executeTool = async () => ({ content: [{ type: "text", text: "pad-result" }] });

/** 最小 fetch 响应（只带适配器真读的字段：`status` / `text` / `json`）。 */
function stubResponse(status, value) {
  const bodyText = JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    async text() { return bodyText; },
    async json() { return JSON.parse(bodyText); },
  };
}

/**
 * 严格 stub 上游：**读请求体**再决定状态码。
 *
 * 没有 `role:"user"` ⇒ 400 + 上游原话（这就是真 relay 的行为）；有 user 轮 ⇒ 200（这一格是
 * 反向证明：若哪一天视图里凭空多出一条 user 轮，这条测试不会「照样绿」，而是 400 消失、终局
 * 断言立刻红）。
 *
 * `calls[i].guardEventsAtCallTime` 在**被调用的那一瞬间**数已收到的守卫事件 ⇒ 钉住「事件先于
 * 请求」，不依赖事件数组的书写顺序。
 */
function strictRelay({ events }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const roles = messages.map((message) => message?.role);
    calls.push({
      url: String(url),
      method: init.method,
      body,
      roles,
      guardEventsAtCallTime: events.filter(
        (event) => event?.type === "user_turn_guard_unrecoverable",
      ).length,
    });
    if (roles.includes("user")) {
      return stubResponse(200, {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    }
    return stubResponse(400, {
      error: { message: UPSTREAM_MESSAGE, type: "invalid_request_error", code: "invalid_request" },
    });
  };
  return { fetchImpl, calls };
}

/**
 * 宿主给的初始消息：**没有**真 user 轮（纯 assistant 文本），但本身通过 `validateMessages`。
 * 这就是「视图违反 I1、源里也没有可回补的 user 轮」那一格最直接的可达形状（与
 * `test/loop-296-user-turn-unrecoverable.test.js` 的 T1 同一个前提，那里用脚本化 provider 证过）。
 */
const assistantOnlyHistory = () => [
  { role: "assistant", content: [{ type: "text", text: "orphan assistant text" }] },
];

function baseOptions({ provider, events, stream = false }) {
  return {
    provider,
    tools: [PAD_TOOL],
    executeTool,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    config: {
      run: { maxRounds: 4, completion: false, stallDetection: false, stream },
      input: { system: "call pad each round, then answer", messages: assistantOnlyHistory() },
    },
  };
}

const unrecoverableEvents = (events) => events.filter(
  (event) => event?.type === "user_turn_guard_unrecoverable",
);

/** 跑一次并把抛出来的东西抓住（`failed` 终局在本仓是**抛错**，不是返回值）。 */
async function runCapturing(options) {
  try {
    return { result: await runToolLoop(options), failure: undefined };
  } catch (error) {
    return { result: undefined, failure: error };
  }
}

test("T1 #296 真 OpenAI 适配器：守卫 unrecoverable → 真请求被上游 400 → invalid_request 与事件同在终局", async () => {
  const events = [];
  const relay = strictRelay({ events });
  // 真适配器：URL / body / 状态码解析全在 `src/providers/openai.js` 里发生，只有 fetch 是离线的。
  const provider = createOpenAIProvider({
    endpoint: "https://relay.invalid",
    apiKey: API_KEY,
    model: MODEL,
    fetchImpl: relay.fetchImpl,
  });

  const { failure, result } = await runCapturing(baseOptions({ provider, events }));

  // ── (2) 请求真的经真适配器发出 ────────────────────────────────────────────────
  assert.equal(relay.calls.length, 1, "invalid_request 不可重试 ⇒ 上游只该收到一发（不是脚本化 provider 的重复调用）");
  assert.equal(
    relay.calls[0].url,
    "https://relay.invalid/v1/chat/completions",
    "URL 必须是适配器自己拼出来的那条（`endpoint` + `/v1/chat/completions`）",
  );
  assert.equal(relay.calls[0].method, "POST");
  assert.equal(relay.calls[0].body.model, MODEL, "model 由适配器写进请求体（不是测试手搓的 canonical 请求）");

  // 请求体里那条「user 消息」的形态 = **没有**：除了引擎自己的 system 轮，`messages` 只剩一条
  // assistant 轮（OpenAI 协议把 system 也放进 `messages`，Anthropic 协议放在 `system` 字段）。
  assert.equal(
    relay.calls[0].roles.includes("user"),
    false,
    `上游拒绝的就是这个形态：请求体里不许出现 user 轮，实测 ${JSON.stringify(relay.calls[0].roles)}`,
  );
  assert.deepEqual(
    relay.calls[0].roles.filter((role) => role !== "system"),
    ["assistant"],
    `除 system 外只该剩那条孤儿 assistant 轮，实测 ${JSON.stringify(relay.calls[0].roles)}`,
  );

  // ── (3) 守卫事件先到，且形状可断言 ────────────────────────────────────────────
  assert.equal(
    relay.calls[0].guardEventsAtCallTime,
    1,
    "守卫事件必须在请求发出**之前**就到达宿主（否则宿主没法把随后的 400 归因到它）",
  );
  const guardEvents = unrecoverableEvents(events);
  assert.equal(
    guardEvents.length,
    1,
    `必须恰好一条 user_turn_guard_unrecoverable，实际 ${JSON.stringify(events.map((event) => event.type))}`,
  );
  assert.equal(guardEvents[0].reason, "no_user_turn", "子原因：视图非空但没有真 user 轮");
  assert.equal(guardEvents[0].channel, "chat", "通道名必须报真被调用的那条");
  assert.equal(guardEvents[0].round, 1);

  // ── (3') 400 被分类成 invalid_request，不是被吞成普通失败 ─────────────────────
  assert.ok(failure, "上游 400 ⇒ run 必须以 failed 收口（本仓 `failed` 是抛错），不许悄悄继续");
  assert.equal(failure.code, "invalid_request", "400 → invalid_request（不是 unknown / network / server）");
  assert.equal(failure.status, 400, "上游状态码原样带出");
  assert.equal(failure.retryable, false, "invalid_request 不可重试");
  assert.equal(failure.message, UPSTREAM_MESSAGE, "上游错误文案必须透传（宿主 grep 得到同一句）");
  assert.equal(failure.termination?.reason, "failed");
  assert.equal(failure.termination?.errorCode, "invalid_request", "终局里拿得到错误分类");
  assert.equal(result, undefined, "前提：这一跑真的没有返回值（failed 走抛错）");

  // ── (4) 同一份终局里**既**有事件、**也**有错误分类（#296 的对照面）────────────
  const outcome = events.find((event) => event?.type === "run_outcome");
  assert.ok(outcome, "failed 也要留一条 run 级 outcome（#165）");
  assert.equal(outcome.termination?.reason, "failed");
  assert.equal(
    outcome.termination?.errorCode,
    "invalid_request",
    "run_outcome 里的错误分类必须和抛出的错误同值 ⇒ 宿主在同一份事件流里既看到守卫事件、也看到 400 的分类",
  );
  assert.equal(
    events.indexOf(guardEvents[0]) < events.indexOf(outcome),
    true,
    "顺序：守卫事件在 run_outcome 之前（「先有归因，后有终局」）",
  );
});

test("T1b #296 真 Anthropic 适配器 + 流式通道：同一条链，事件通道名跟着真调用走", async () => {
  const events = [];
  const relay = strictRelay({ events });
  const provider = createAnthropicProvider({
    endpoint: "https://relay.invalid",
    apiKey: API_KEY,
    model: MODEL,
    fetchImpl: relay.fetchImpl,
  });

  const { failure } = await runCapturing(baseOptions({ provider, events, stream: true }));

  assert.equal(relay.calls.length, 1, "不可重试 ⇒ 只发一发");
  assert.equal(
    relay.calls[0].url,
    "https://relay.invalid/v1/messages",
    "Anthropic 适配器自己拼的那条 URL",
  );
  assert.equal(relay.calls[0].body.stream, true, "前提：这一跑真的走了流式通道（适配器把 stream 写进 body）");
  assert.equal(
    relay.calls[0].roles.includes("user"),
    false,
    `同一个被拒形态：流式通道的请求体里也没有 user 轮，实测 ${JSON.stringify(relay.calls[0].roles)}`,
  );
  assert.deepEqual(
    relay.calls[0].roles,
    ["assistant"],
    "Anthropic 协议的 system 走独立字段 ⇒ `messages` 里只剩那条孤儿 assistant 轮",
  );
  assert.equal(relay.calls[0].guardEventsAtCallTime, 1, "流式通道下事件同样先于请求");

  const guardEvents = unrecoverableEvents(events);
  assert.equal(guardEvents.length, 1);
  assert.equal(guardEvents[0].channel, "chatStream", "通道名必须报真被调用的那一条（不许写死 chat）");

  assert.ok(failure, "流式通道的 400 同样以 failed 收口");
  assert.equal(failure.code, "invalid_request");
  assert.equal(failure.status, 400);
  assert.equal(failure.termination?.errorCode, "invalid_request");
  const outcome = events.find((event) => event?.type === "run_outcome");
  assert.equal(outcome?.termination?.errorCode, "invalid_request");
});
