import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

// issue #173（PR-B 语义锁）：宿主观察者回调抛错的**统一后果 = 观察者隔离**
// ============================================================================
// PR-B（业主决策 2026-10-09，行为放宽 = semver minor）之后，九个观察者通道只有一种后果：
//
//   | 回调 | 抛错后果 | 记账 |
//   |---|---|---|
//   | onEvent / onRound / onToolResult / onJudge / onDelta / onReasoningDelta /
//   | onToolCall / onUsage（+ 启动期直调 onEvent 的两条诊断事件） |
//   | **run 继续跑到正常终局** | onObserverError(error, {channel, ...定位上下文})；
//     未配置 onObserverError 时退到 console.error("Observer callback error:", err, ctx) |
//
// 抛错**不再是** run 的控制流：要终止 run 用 `signal.abort()`（抛出的错误带 #180 载荷）。
// `onToolResult` 是改写钩子（返回值替换工具结果），其异常 fallback 额外钉死为
// 「保留引擎原始执行结果」——见下方 fallback 单点用例。
//
// 实现锚点（行号会随版本漂移，按符号名定位为准）：
//   - 统一记账口：orchestrator.js `reportObserverError(error, context)`
//   - onEvent：orchestrator.js `emitEvent`（try/catch → channel:"onEvent"）
//   - onRound：orchestrator.js 轮末 `await onRound(record)`（try/catch → channel:"onRound"）
//   - onToolResult：run-snapshot-executor.js（try/catch + 保留原始结果 → channel:"onToolResult"）
//   - onJudge：orchestrator.js `emitJudge`（PR-A 的裸 catch 已改为上报 → channel:"onJudge"）
//   - 流式四通道：provider-runner.js `dispatchAttemptEvent`（沿用自身通道名上报，语义不回退）
//   - 启动期直调：orchestrator.js `notifyCapabilitySkipped` / `notifyModelMetadataMissing`
//
// ⚠️ 本文件锁的是 **PR-B 契约语义**（不再是 PR-A 的「现状锁」）。任何一处回到
//    「观察者抛错杀 run / 静默吞」的改动都会让本文件变红。
// ⚠️ docs/host-consumer-contract.md（中英）与 runToolLoop JSDoc 与本文件对齐。
// ============================================================================

const BASE_OPTIONS = {
  initialUserMessage: "go",
  executeTool: async () => "ok",
  persistence: "none",
  completion: false,
};

function toolUseResponse(round) {
  return {
    content: [{ type: "tool_use", id: `tool-${round}`, name: "work", input: { round } }],
    stopReason: "tool_use",
  };
}

function finalResponse(text = "done") {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** 只实现 chatStream 的假 provider：按 emits 依次触发 provider-runner 的流式观察者入口。 */
function createStreamProvider({ response, emits = [] }) {
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chatStream(request) {
      requests.push(request);
      for (const emit of emits) emit(request);
      return response;
    },
  };
}

/** 把 onObserverError 收到的 {error, context} 落成可断言的紧凑记录。 */
function observerSink() {
  const seen = [];
  return {
    seen,
    callback: (error, context) => seen.push({ error, context }),
    get messages() {
      return seen.map((entry) => entry.error.message);
    },
    get contexts() {
      return seen.map((entry) => entry.context);
    },
    get channels() {
      return seen.map((entry) => entry.context.channel);
    },
  };
}

/** 从 provider 后续请求里取工具结果文本（验证「原始结果送下一轮」）。 */
function toolResultContentOf(request) {
  const blocks = (request?.messages ?? []).flatMap((message) => (
    Array.isArray(message?.content) ? message.content : []
  ));
  return blocks
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.content)
    .join("|");
}

// ── onEvent：PR-A 的 fatal 已翻转为 isolated ────────────────────────────────

test("pr-b #173: a throwing onEvent is isolated into onObserverError and the run finishes", async () => {
  const boom = new Error("host onEvent blew up");
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const events = [];
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    runId: "observer-on-event-isolated",
    store: createMemoryTranscriptStore(),
    onEvent: (event) => {
      events.push(event.type);
      throw boom; // 每个事件都抛（含启动期的 model_metadata_missing 直调路径）
    },
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" }, "onEvent 抛错不再杀 run");
  assert.equal(result.rounds, 2);
  // 事件流不再断裂：抛错之后引擎照常继续发事件（对比 PR-A：只到第一个事件就死）
  assert.deepEqual(events, [
    "model_metadata_missing",
    "round_start", "attempt", "tool_use", "tool_result", "round_end",
    "round_start", "attempt", "round_end",
  ]);
  // 每次抛错各记一笔，且带定位上下文
  assert.equal(observers.seen.length, events.length);
  assert.ok(observers.seen.every((entry) => entry.error === boom));
  assert.deepEqual(observers.contexts[0], {
    runId: "observer-on-event-isolated",
    channel: "onEvent",
    type: "model_metadata_missing",
  }, "启动期直调路径与 emitEvent 同口径（channel:\"onEvent\"）");
  assert.deepEqual(observers.contexts[1], {
    runId: "observer-on-event-isolated",
    channel: "onEvent",
    type: "round_start",
    round: 1,
  }, "每条上报都带 runId：并行多 run 的宿主靠它归因");
  assert.deepEqual(
    observers.contexts.at(-1),
    { runId: "observer-on-event-isolated", channel: "onEvent", type: "round_end", round: 2 },
  );
});

test("pr-b #173: onEvent is isolated on every event type, not just the first one", async () => {
  // 隔离只取决于「是否走观察者通道」，与事件类型无关：任何事件上抛错都记账并继续。
  for (const eventType of ["attempt", "tool_use", "tool_result", "round_end"]) {
    const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
    const seen = [];
    const observers = observerSink();

    const result = await runToolLoop({
      ...BASE_OPTIONS,
      provider,
      onEvent: (event) => {
        seen.push(event.type);
        if (event.type === eventType) throw new Error(`boom-${eventType}`);
      },
      onObserverError: observers.callback,
    });

    assert.equal(result.finalText, "done", `${eventType} 抛错后 run 照常跑完`);
    assert.deepEqual(result.termination, { reason: "end_turn" });
    assert.ok(seen.includes(eventType));
    assert.ok(
      observers.messages.length > 0 && observers.messages.every((message) => message === `boom-${eventType}`),
      `${eventType} 抛错必须全部记账，实际：${JSON.stringify(observers.messages)}`,
    );
    assert.ok(
      observers.contexts.some((context) => (
        context.channel === "onEvent" && context.type === eventType
      )),
      `记账上下文必须带 channel+事件类型，实际：${JSON.stringify(observers.contexts)}`,
    );
  }
});

// ── onRound：轮已落库后抛错 → run 继续、后续轮照跑 ──────────────────────────

test("pr-b #173: a throwing onRound is isolated after the round was persisted and later rounds still run", async () => {
  const boom = new Error("host onRound blew up");
  const provider = createFakeProvider([toolUseResponse(1), toolUseResponse(2), finalResponse()]);
  const store = createMemoryTranscriptStore();
  const rounds = [];
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    persistence: undefined, // 本例要验证「轮已落库后抛错」，必须真的写库
    provider,
    store,
    runId: "observer-on-round-isolated",
    maxRounds: 4,
    // onRound 是被 await 的：同步 throw 与 rejected Promise 后果同构，都在隔离通道内
    onRound: async (record) => {
      rounds.push(record.round);
      throw boom;
    },
    onObserverError: observers.callback,
  });

  assert.deepEqual(result.termination, { reason: "end_turn" }, "onRound 抛错不再改写终局");
  assert.equal(result.rounds, 3);
  // 抛错后 run 继续：第 2、3 轮照跑（PR-A 现状是第 2 轮 provider 请求从未发出）
  assert.deepEqual(rounds, [1, 2, 3]);
  assert.equal(provider.requests.length, 3);
  assert.deepEqual(observers.messages, [boom.message, boom.message, boom.message]);
  assert.deepEqual(observers.contexts, [
    { channel: "onRound", round: 1, runId: "observer-on-round-isolated" },
    { channel: "onRound", round: 2, runId: "observer-on-round-isolated" },
    { channel: "onRound", round: 3, runId: "observer-on-round-isolated" },
  ]);
  // 轮次确实已落库（抛错发生在 persist 之后，落库不受影响）；round 0 是引擎预写的 user 轮
  const persisted = await store.load("observer-on-round-isolated");
  assert.deepEqual(persisted.map((record) => record.round), [0, 1, 2, 3]);
});

// ── onToolResult：改写钩子，fallback = 保留原始结果 ──────────────────────────

test("pr-b #173: a throwing onToolResult keeps the ORIGINAL engine result and reports with toolName", async () => {
  const boom = new Error("host onToolResult blew up");
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const seen = [];
  const events = [];
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS, // executeTool 固定返回 "ok"
    provider,
    onToolResult: async (name) => {
      seen.push(name);
      throw boom; // 宿主改写结果时抛错
    },
    onEvent: (event) => events.push(event.type),
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(seen, ["work"]);
  // fallback 边界②：送给下一轮的是**引擎原始执行结果**，不是部分改写、也不是空结果
  assert.equal(toolResultContentOf(provider.requests[1]), "ok");
  // 事件流不再断裂：tool_result 事件照常发出
  assert.ok(events.includes("tool_result"), `tool_result 应已发出，实际：${events.join(",")}`);
  assert.deepEqual(observers.messages, [boom.message]);
  assert.deepEqual(observers.contexts, [{
    channel: "onToolResult",
    toolName: "work",
    round: 1,
  }]);
});

test("pr-b #173: a rejected onToolResult promise also falls back to the original result", async () => {
  // onToolResult 是被 await 的通道，rejected Promise 与同步 throw 同构（契约第 3 条）
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    onToolResult: () => Promise.reject(new Error("async rewrite failed")),
    onObserverError: observers.callback,
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(toolResultContentOf(provider.requests[1]), "ok");
  assert.deepEqual(observers.messages, ["async rewrite failed"]);
  assert.deepEqual(observers.contexts, [{
    channel: "onToolResult",
    toolName: "work",
    round: 1,
  }]);
});

test("pr-b #173: a successful onToolResult rewrite still replaces the result (fallback is throw-only)", async () => {
  // 反向锁：没抛错时改写语义完全不变，别把 fallback 做成「永远保留原始结果」
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    onToolResult: (name, content) => `${content}:${name}`,
    onObserverError: observers.callback,
  });

  assert.equal(toolResultContentOf(provider.requests[1]), "ok:work");
  assert.deepEqual(observers.seen, []);
});

// ── 流式四通道：语义不回退，只是补上自身通道名 ──────────────────────────────

test("pr-b #173: a throwing onDelta is isolated into onObserverError and the run finishes", async () => {
  const deltas = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [
      (request) => request.onDelta?.("a"),
      (request) => request.onDelta?.("b"),
      (request) => request.onDelta?.("c"),
    ],
  });
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onDelta: (chunk) => {
      deltas.push(chunk);
      throw new Error(`host onDelta blew up on ${chunk}`);
    },
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.rounds, 1);
  // 每次抛错各记一笔，且后续 delta 照常投递（抛错不吞后续流）
  assert.deepEqual(deltas, ["a", "b", "c"]);
  assert.deepEqual(
    observers.messages,
    ["host onDelta blew up on a", "host onDelta blew up on b", "host onDelta blew up on c"],
  );
  assert.ok(observers.seen.every((entry) => entry.error instanceof Error));
  // PR-B 新增：流式通道也必须报出自己的名字（不回退到 unknown / onEvent）
  assert.deepEqual(observers.channels, ["onDelta", "onDelta", "onDelta"]);
  assert.deepEqual(observers.contexts[0], { channel: "onDelta", round: 1, type: "delta" });
});

test("pr-b #173: a throwing onReasoningDelta is isolated and names its own channel", async () => {
  const chunks = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onReasoningDelta?.("thinking", { channel: "reasoning" })],
  });
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onReasoningDelta: (chunk) => {
      chunks.push(chunk);
      throw new Error("host onReasoningDelta blew up");
    },
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(chunks, ["thinking"]);
  assert.deepEqual(observers.messages, ["host onReasoningDelta blew up"]);
  assert.deepEqual(observers.contexts, [{
    channel: "onReasoningDelta",
    round: 1,
    type: "reasoning_delta",
  }]);
});

test("pr-b #173: a throwing onToolCall is isolated and names its own channel", async () => {
  const fragments = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onToolCall?.({ id: "call-1", name: "work", input: {} })],
  });
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onToolCall: (fragment) => {
      fragments.push(fragment);
      throw new Error("host onToolCall blew up");
    },
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(fragments, [{ id: "call-1", name: "work", input: {} }]);
  assert.deepEqual(observers.messages, ["host onToolCall blew up"]);
  assert.deepEqual(observers.contexts, [{
    channel: "onToolCall",
    round: 1,
    type: "tool_call",
  }]);
});

test("pr-b #173: a throwing onUsage is isolated and usage accounting is unaffected", async () => {
  const usageEvents = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onUsage?.({ input_tokens: 7, output_tokens: 3 })],
  });
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onUsage: () => {
      throw new Error("host onUsage blew up");
    },
    onEvent: (event) => {
      if (event.type === "usage") usageEvents.push(event.usage);
    },
    onObserverError: observers.callback,
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  // usage 事件由引擎自己发（在宿主回调之外），宿主抛错不影响事件流与记账
  assert.deepEqual(usageEvents, [{ input_tokens: 7, output_tokens: 3 }]);
  assert.deepEqual(observers.messages, ["host onUsage blew up"]);
  assert.deepEqual(observers.contexts, [{
    channel: "onUsage",
    round: 1,
    type: "usage",
  }]);
});

// ── onJudge：PR-A 的静默吞改为记账 ──────────────────────────────────────────

test("pr-b #173: a throwing onJudge is reported to onObserverError (was swallowed)", async () => {
  const rounds = [];
  const judge = createFakeProvider([
    finalResponse(JSON.stringify({
      done: true,
      confidence: 0.9,
      reason: "完成",
      evidence: "通过",
    })),
  ]);
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider: createFakeProvider([finalResponse("完成")]),
    maxRounds: 1,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: () => {
      throw new Error("host onJudge blew up");
    },
    onRound: (record) => rounds.push(record.round),
    onObserverError: observers.callback,
  });

  assert.deepEqual(result.termination, { reason: "judge_done" });
  assert.deepEqual(rounds, [1], "onJudge 抛错后 run 照常收尾");
  // PR-A 锁的是「连 onObserverError 都不通知」；PR-B 统一为记账
  assert.deepEqual(observers.messages, ["host onJudge blew up"]);
  assert.deepEqual(observers.contexts, [{ channel: "onJudge", round: 1, kind: "round" }]);
});

// ── reportObserverError 的 context 形状与 best-effort 语义 ──────────────────

test("pr-b #173: reportObserverError hands the host (error, {channel, ...}) and never rethrows", async () => {
  // context 形状：channel 恒存在且是回调名；其余字段按通道给定位上下文；宿主自己抛错也不炸。
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const seen = [];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const result = await runToolLoop({
      ...BASE_OPTIONS,
      provider,
      onRound: () => {
        throw new Error("round blew up");
      },
      onObserverError: (error, context) => {
        seen.push({ error, context });
        throw new Error("reporter itself blew up"); // 宿主记账口自己炸
      },
    });

    assert.deepEqual(result.termination, { reason: "end_turn" }, "reporter 炸了也不影响 run");
    // 本例跑 2 轮（工具轮 + 收尾轮），每轮 onRound 各抛一次 → 各记一笔
    assert.equal(seen.length, 2);
    assert.equal(seen[0].error.message, "round blew up");
    assert.equal(seen[0].error instanceof Error, true);
    // context 是普通对象，channel 必有；不携带无关字段
    assert.deepEqual(Object.keys(seen[0].context).sort(), ["channel", "round"]);
    assert.deepEqual(seen[0].context, { channel: "onRound", round: 1 });
    // 回退口径：先报「reporter failed」，再把原始观察者错误打到 console（每轮一对）
    assert.deepEqual(logged.map((entry) => entry[0]), [
      "Observer error reporter failed:",
      "Observer callback error:",
      "Observer error reporter failed:",
      "Observer callback error:",
    ]);
    assert.equal(logged[1][1].message, "round blew up");
    assert.deepEqual(logged[1][2], { channel: "onRound", round: 1 });
  } finally {
    console.error = originalError;
  }
});

test("pr-b #173: without onObserverError the isolation still holds and console carries the channel", async () => {
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const result = await runToolLoop({
      ...BASE_OPTIONS,
      provider,
      onToolResult: () => {
        throw new Error("unconfigured observer failed");
      },
    });

    assert.deepEqual(result.termination, { reason: "end_turn" });
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "Observer callback error:");
    assert.equal(logged[0][1].message, "unconfigured observer failed");
    assert.deepEqual(logged[0][2], { channel: "onToolResult", toolName: "work", round: 1 });
  } finally {
    console.error = originalError;
  }
});

// ── 启动期直调路径（边界③）：两条绕过 emitEvent 的诊断事件同样被隔离 ──────────

test("pr-b #173: a throwing startup onEvent continues the run with exactly one model_metadata_missing", async () => {
  const provider = createFakeProvider([finalResponse()]);
  const seen = [];
  const observers = observerSink();

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    runId: "observer-startup-metadata",
    store: createMemoryTranscriptStore(),
    onEvent: (event) => {
      seen.push(event.type);
      throw new Error("host onEvent blew up at startup");
    },
    onObserverError: observers.callback,
  });

  assert.deepEqual(result.termination, { reason: "end_turn" }, "启动期抛错不再是 run 的终止机制");
  assert.equal(provider.requests.length, 1, "首次 provider 调用照常发生");
  // 去重语义不受抛错影响：本 run 恰好一条 model_metadata_missing
  assert.deepEqual(seen.filter((type) => type === "model_metadata_missing"), ["model_metadata_missing"]);
  assert.equal(observers.channels[0], "onEvent");
  assert.equal(observers.contexts[0].type, "model_metadata_missing");
});

test("pr-b #173: a throwing startup onEvent on the capability-degraded path is isolated too", async () => {
  // notifyCapabilitySkipped 直调 onEvent（restoreResume 的 markRunState 早于 emitEvent 定义）
  const store = createMemoryTranscriptStore();
  delete store.markRunState;
  const provider = createFakeProvider([finalResponse()]);
  const seen = [];
  const observers = observerSink();

  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    completion: false,
    store,
    runId: "observer-startup-capability",
    // 只放行能力降级事件，其他事件不抛，避免与上一条用例混在一起
    onEvent: (event) => {
      seen.push(event.type);
      if (event.type === "persistence_capability_degraded") throw new Error("startup throw");
    },
    onObserverError: observers.callback,
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.ok(seen.includes("persistence_capability_degraded"), `实际事件：${seen.join(",")}`);
  assert.deepEqual(observers.messages, ["startup throw"]);
  assert.deepEqual(observers.contexts, [{
    channel: "onEvent",
    type: "persistence_capability_degraded",
    method: "markRunState",
    runId: "observer-startup-capability",
  }]);
});

// ── 统一语义总表：唯一的「通道 → 后果」契约矩阵 ─────────────────────────────

test("pr-b #173: the unified isolation matrix (every observer channel is isolated + reported)", async () => {
  const CASES = [
    { channel: "onEvent", termination: "end_turn" },
    { channel: "onRound", termination: "end_turn" },
    { channel: "onToolResult", termination: "end_turn" },
    { channel: "onDelta", termination: "end_turn" },
    { channel: "onReasoningDelta", termination: "end_turn" },
    { channel: "onToolCall", termination: "end_turn" },
    { channel: "onUsage", termination: "end_turn" },
    { channel: "onJudge", termination: "judge_done" },
  ];

  for (const { channel, termination } of CASES) {
    const boom = new Error(`host ${channel} blew up`);
    const observers = observerSink();
    const options = {
      ...BASE_OPTIONS,
      provider: channel === "onJudge"
        ? createFakeProvider([finalResponse("完成")])
        : createFakeProvider([toolUseResponse(1), finalResponse()]),
      maxRounds: channel === "onJudge" ? 1 : 4,
      onObserverError: observers.callback,
    };
    if (channel === "onJudge") {
      options.reflection = {
        enabled: true,
        judge: { provider: createFakeProvider([finalResponse(JSON.stringify({
          done: true, confidence: 0.9, reason: "完成", evidence: "通过",
        }))]) },
      };
    }
    if (["onDelta", "onReasoningDelta", "onToolCall", "onUsage"].includes(channel)) {
      options.provider = createStreamProvider({
        response: finalResponse(),
        // onToolCall 的 fragment 形态与 onDelta 的字符串不同，但后果同构，这里统一触发一次
        emits: [(request) => request[channel]?.(
          channel === "onToolCall" ? { id: "call-1", name: "work", input: {} } : "x",
        )],
      });
      options.stream = true;
    }
    options[channel] = () => {
      throw boom;
    };

    const result = await runToolLoop(options);
    assert.deepEqual(
      result.termination,
      { reason: termination },
      `${channel} 抛错后 run 必须走到正常终局（不是 failed）`,
    );
    assert.ok(
      observers.messages.includes(boom.message),
      `${channel} 抛错必须经 onObserverError 记账`,
    );
    assert.ok(
      observers.channels.every((name) => name === channel),
      `${channel} 的记账上下文必须报自己的通道名，实际：${JSON.stringify(observers.channels)}`,
    );
  }
});
