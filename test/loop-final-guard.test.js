import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
import { validateMessages } from "../src/messages/rounds.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("finalGuard accept preserves normal completion", async () => {
  const events = [];
  let payload;
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(result.verification, { status: "verified" });
  assert.equal(result.finalText, "done");
  assert.equal(payload.finalText, "done");
  assert.equal(payload.round, 1);
  assert.equal(payload.rounds, 1);
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(events.at(-1).action, "accept");
});

test("finalGuard revision is injected as a paired-safe user text message", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "unverified" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "verified" }], stopReason: "end_turn" },
  ]);
  let calls = 0;
  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    completion: false,
    finalGuard: async () => {
      calls += 1;
      return calls === 1
        ? { action: "revise", message: "请先核实原始值" }
        : { action: "accept" };
    },
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, "verified");
  assert.equal(result.verification.status, "verified");
  const continuation = provider.requests[1].messages.at(-1);
  assert.deepEqual(continuation, {
    role: "user",
    content: [{ type: "text", text: "请先核实原始值" }],
  });
  validateMessages(result.messages);
});

test("finalGuard can skip verification when no candidate is extractable", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "plain prose" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuard: async () => ({
      action: "skip",
      reason: "no_extractable_candidates",
    }),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(result.verification, {
    status: "skipped",
    reason: "no_extractable_candidates",
  });
});

test("finalGuard fail-closes after the retry limit without rewriting finalText", async () => {
  const events = [];
  const store = createMemoryTranscriptStore();
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "unsafe-1" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: "unsafe-2" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: "unsafe-3" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    completion: false,
    finalGuardMaxRetries: 2,
    finalGuard: async () => ({
      action: "revise",
      message: "请读取归档核实",
    }),
    store,
    runId: "guard-unverified-state",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "final_guard_unverified" });
  assert.equal(result.verification.status, "unverified");
  assert.equal(result.finalText, "unsafe-3");
  assert.equal(result.rounds, 3);
  assert.equal(events.filter((event) => event.action === "revise").length, 3);
  assert.deepEqual(events.at(-1), {
    type: "final_guard",
    round: 3,
    action: "degraded",
    reason: "max_retries",
  });
  assert.equal(
    (await store.loadRunState("guard-unverified-state")).state,
    "unverified_error",
  );
});

test("finalGuard errors fail open and emit an error event", async () => {
  const events = [];
  const store = createMemoryTranscriptStore();
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuard: async () => {
      throw new Error("guard unavailable");
    },
    store,
    runId: "guard-error-state",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.verification.status, "error");
  assert.equal(result.verification.reason, "error");
  assert.deepEqual(events.at(-1), {
    type: "final_guard",
    round: 1,
    action: "error",
    reason: "error",
  });
  assert.equal((await store.loadRunState("guard-error-state")).state, "guard_error");
});

test("finalGuard timeout is observable and returns an error verification", async () => {
  const events = [];
  const store = createMemoryTranscriptStore();
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuardTimeoutMs: 5,
    finalGuard: async () => new Promise(() => {}),
    store,
    runId: "guard-timeout-state",
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.verification.status, "error");
  assert.equal(result.verification.reason, "timeout");
  assert.equal(events.at(-1).reason, "timeout");
  assert.equal((await store.loadRunState("guard-timeout-state")).state, "guard_error");
});

test("finalGuard is called for non-continuable stop paths without another model round", async () => {
  const cases = [
    {
      name: "max_rounds_cap",
      options: {
        maxRounds: 1,
        providerResponses: [
          { content: [{ type: "tool_use", id: "cap", name: "noop", input: {} }], stopReason: "tool_use" },
        ],
      },
    },
    {
      name: "continuation_exhausted",
      options: {
        maxTokenContinuations: 0,
        providerResponses: [
          { content: [{ type: "text", text: "truncated" }], stopReason: "max_tokens" },
        ],
      },
    },
    {
      name: "stall",
      options: {
        maxRounds: 10,
        providerResponses: Array.from({ length: 15 }, (_, index) => ({
          content: [{ type: "tool_use", id: `stall-${index}`, name: "noop", input: {} }],
          stopReason: "tool_use",
        })),
      },
    },
    {
      name: "reflection_stop",
      options: {
        maxRounds: 2,
        reflection: {
          enabled: true,
          roundJudge: false,
          triggerRound: 1,
          maxExtensions: 1,
          maxRoundsCap: 3,
          extensionStep: 1,
        },
        providerResponses: [
          { content: [{ type: "text", text: "stopped" }], stopReason: "end_turn" },
          { content: [{ type: "text", text: '{"continue":false,"reason":"not worth continuing"}' }] },
        ],
      },
    },
  ];

  for (const testCase of cases) {
    let guardCalls = 0;
    const result = await runToolLoop({
      provider: createFakeProvider(testCase.options.providerResponses),
      initialUserMessage: "hello",
      executeTool: async () => "ok",
      completion: false,
      ...(testCase.options.maxRounds === undefined
        ? {}
        : { maxRounds: testCase.options.maxRounds }),
      ...(testCase.options.maxTokenContinuations === undefined
        ? {}
        : { maxTokenContinuations: testCase.options.maxTokenContinuations }),
      ...(testCase.options.reflection === undefined
        ? {}
        : { reflection: testCase.options.reflection }),
      finalGuard: async () => {
        guardCalls += 1;
        return { action: "accept" };
      },
    });

    assert.equal(guardCalls, 1, testCase.name);
    assert.equal(result.verification.status, "unverified", testCase.name);
    assert.equal(result.termination.reason, "final_guard_unverified", testCase.name);
  }
});

test("finalGuard covers no-tool, completion, and judge_done stops", async () => {
  const cases = [
    {
      name: "no_tool",
      responses: [
        { content: [{ type: "tool_use", id: "tool", name: "noop", input: {} }], stopReason: "tool_use" },
        { content: [{ type: "text", text: "draft" }], stopReason: "end_turn" },
      ],
      options: { completion: { signals: [], maxNoToolRounds: 1 } },
    },
    {
      name: "completion",
      responses: [
        { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
      ],
      options: { completion: { signals: ["完成"], maxNoToolRounds: 1 } },
    },
    {
      name: "judge_done",
      responses: [
        { content: [{ type: "text", text: "draft" }], stopReason: "end_turn" },
        { content: [{ type: "text", text: '{"done":true,"confidence":0.95,"reason":"ok","evidence":"done"}' }] },
      ],
      options: {
        completion: false,
        reflection: { enabled: true, roundJudge: true },
      },
    },
  ];
  for (const testCase of cases) {
    let guardCalls = 0;
    const result = await runToolLoop({
      provider: createFakeProvider(testCase.responses),
      initialUserMessage: "hello",
      executeTool: async () => "ok",
      ...testCase.options,
      finalGuard: async () => {
        guardCalls += 1;
        return { action: "accept" };
      },
    });
    assert.equal(guardCalls, 1, testCase.name);
    assert.equal(result.verification.status, "verified", testCase.name);
  }
});

test("abort during finalGuard propagates the abort", async () => {
  const controller = new AbortController();
  let called;
  const started = new Promise((resolve) => {
    called = resolve;
  });
  const run = runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    signal: controller.signal,
    finalGuard: async () => {
      called();
      return new Promise(() => {});
    },
  });

  await started;
  const reason = new Error("stopped");
  controller.abort(reason);
  await assert.rejects(run, (error) => {
    assert.equal(error, reason);
    assert.deepEqual(error.termination, {
      reason: "aborted",
      detail: "stopped",
    });
    return true;
  });
});
