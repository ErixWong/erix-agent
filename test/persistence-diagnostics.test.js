import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const STORE_METHODS = [
  "appendRound",
  "load",
  "saveCheckpoint",
  "appendCheckpoint",
  "loadLatestCheckpoint",
  "saveRunState",
  "loadRunState",
  "markRunState",
];

function fullStore() {
  return createMemoryTranscriptStore();
}

function textProvider(text = "done") {
  return createFakeProvider([{
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  }]);
}

function toolProvider(id = "tool-1") {
  return createFakeProvider([{
    content: [{ type: "tool_use", id, name: "work", input: {} }],
    stopReason: "tool_use",
  }]);
}

test("required persistence validates every store method before provider or tool execution", async () => {
  for (const missing of STORE_METHODS) {
    const store = fullStore();
    delete store[missing];
    const provider = textProvider();
    let executions = 0;

    await assert.rejects(
      runToolLoop({
        provider,
        store,
        runId: `missing-${missing}`,
        initialUserMessage: "validate",
        executeTool: async () => {
          executions += 1;
          return "unreachable";
        },
      }),
      (error) => error instanceof TypeError
        && error.message.includes(missing)
        && error.message.includes("required persistence store is missing methods"),
    );
    assert.equal(provider.requests.length, 0, missing);
    assert.equal(executions, 0, missing);
  }
});

test("required persistence retries appendRound and terminates with a transcript diagnostic", async () => {
  const store = fullStore();
  let appendAttempts = 0;
  const originalAppendRound = store.appendRound.bind(store);
  store.appendRound = async (runId, record) => {
    appendAttempts += 1;
    if (appendAttempts > 1) throw new Error("transcript unavailable");
    return originalAppendRound(runId, record);
  };
  const events = [];
  const sleeps = [];
  const provider = createFakeProvider([
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    },
  ]);

  await assert.rejects(
    runToolLoop({
      provider,
      store,
      runId: "append-failure",
      initialUserMessage: "persist",
      executeTool: async () => "unused",
      completion: false,
      retry: {
        attempts: 2,
        backoffBaseMs: 1,
        backoffMaxMs: 2,
        sleepImpl: async (ms) => sleeps.push(ms),
      },
      diagnostics: { error: (event) => events.push(event) },
    }),
    (error) => error.termination?.reason === "persistence_failed"
      && error.operation === "appendRound"
      && error.phase === "transcript"
      && error.sideEffect === "not_started",
  );
  assert.equal(provider.requests.length, 1);
  assert.equal(appendAttempts, 4);
  assert.deepEqual(sleeps, [1, 2]);
  assert.deepEqual(
    events.map(({ type, phase, operation, runId, fatal, sideEffect }) => (
      { type, phase, operation, runId, fatal, sideEffect }
    )),
    [{
      type: "persistence_error",
      phase: "transcript",
      operation: "appendRound",
      runId: "append-failure",
      fatal: true,
      sideEffect: "not_started",
    }],
  );
});

test("checkpoint failure before a tool reports not_started and skips execution", async () => {
  const store = fullStore();
  store.saveCheckpoint = async () => {
    throw new Error("checkpoint unavailable");
  };
  const events = [];
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider: toolProvider("before"),
      store,
      runId: "checkpoint-before",
      initialUserMessage: "work",
      executeTool: async () => {
        executions += 1;
        return "must not run";
      },
      completion: false,
      diagnostics: { error: (event) => events.push(event) },
    }),
    (error) => error.code === "checkpoint_failed"
      && error.termination?.reason === "persistence_failed"
      && error.operation === "saveCheckpoint"
      && error.phase === "checkpoint_before_tool"
      && error.sideEffect === "not_started",
  );
  assert.equal(executions, 0);
  assert.equal(events[0].sideEffect, "not_started");
});

test("checkpoint failure after a tool reports executed_uncommitted and terminates", async () => {
  const store = fullStore();
  store.saveCheckpoint = async (_runId, checkpoint) => {
    if (checkpoint.status === "executed") throw new Error("checkpoint unavailable");
  };
  const events = [];
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider: toolProvider("after"),
      store,
      runId: "checkpoint-after",
      initialUserMessage: "work",
      executeTool: async () => {
        executions += 1;
        return "executed";
      },
      completion: false,
      diagnostics: { error: (event) => events.push(event) },
    }),
    (error) => error.code === "checkpoint_failed"
      && error.termination?.reason === "persistence_failed"
      && error.operation === "saveCheckpoint"
      && error.phase === "checkpoint_after_tool"
      && error.sideEffect === "executed_uncommitted",
  );
  assert.equal(executions, 1);
  assert.equal(events[0].sideEffect, "executed_uncommitted");
});

test("intercept pre-tool checkpoint failure fails closed before judging or executing", async () => {
  const store = fullStore();
  const originalSaveCheckpoint = store.saveCheckpoint.bind(store);
  let checkpointCalls = 0;
  store.saveCheckpoint = async (runId, checkpoint) => {
    checkpointCalls += 1;
    if (checkpointCalls === 3) throw new Error("intercept checkpoint unavailable");
    return originalSaveCheckpoint(runId, checkpoint);
  };
  const judge = textProvider(JSON.stringify({
    done: true,
    confidence: 0.9,
    reason: "allow",
    evidence: "safe",
  }));
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "first", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "intercepted", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "must not be returned" }], stopReason: "end_turn" },
  ]);
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider,
      store,
      runId: "intercept-before-failure",
      initialUserMessage: "work",
      executeTool: async () => {
        executions += 1;
        return "executed";
      },
      completion: false,
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: judge },
      },
    }),
    (error) => error.code === "checkpoint_failed"
      && error.termination?.reason === "persistence_failed"
      && error.sideEffect === "not_started",
  );
  assert.equal(checkpointCalls, 3);
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.equal(judge.requests.length, 0);
});

test("intercept result checkpoint failure terminates without running the blocked tool", async () => {
  const store = fullStore();
  const originalSaveCheckpoint = store.saveCheckpoint.bind(store);
  let checkpointCalls = 0;
  store.saveCheckpoint = async (runId, checkpoint) => {
    checkpointCalls += 1;
    if (checkpointCalls === 4) throw new Error("intercept result unavailable");
    return originalSaveCheckpoint(runId, checkpoint);
  };
  const judge = textProvider(JSON.stringify({
    done: false,
    confidence: 0.9,
    reason: "方向偏离",
    evidence: "需要重新评估",
  }));
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "first", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "blocked", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "must not be returned" }], stopReason: "end_turn" },
  ]);
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider,
      store,
      runId: "intercept-result-failure",
      initialUserMessage: "work",
      executeTool: async () => {
        executions += 1;
        return "executed";
      },
      completion: false,
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: judge },
      },
    }),
    (error) => error.code === "checkpoint_failed"
      && error.termination?.reason === "persistence_failed"
      && error.sideEffect === "not_started",
  );
  assert.equal(checkpointCalls, 4);
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.equal(judge.requests.length, 1);
});

test("appendRound failure after a tool reports executed_uncommitted", async () => {
  const store = fullStore();
  const originalAppendRound = store.appendRound.bind(store);
  store.appendRound = async (runId, record) => {
    if (record.round === 1) throw new Error("transcript unavailable after tool");
    return originalAppendRound(runId, record);
  };
  const events = [];
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider: toolProvider("append-after-tool"),
      store,
      runId: "append-after-tool",
      initialUserMessage: "work",
      executeTool: async () => {
        executions += 1;
        return "executed";
      },
      completion: false,
      diagnostics: { error: (event) => events.push(event) },
    }),
    (error) => error.termination?.reason === "persistence_failed"
      && error.operation === "appendRound"
      && error.phase === "transcript"
      && error.sideEffect === "executed_uncommitted",
  );
  assert.equal(executions, 1);
  assert.equal(events.at(-1).operation, "appendRound");
  assert.equal(events.at(-1).sideEffect, "executed_uncommitted");
});

test("none persistence mode is a no-op even with an incomplete failing store", async () => {
  let calls = 0;
  const result = await runToolLoop({
    provider: textProvider("no persistence needed"),
    store: {
      appendRound: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    },
    persistence: "none",
    runId: "none-mode",
    initialUserMessage: "run once",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "no persistence needed");
  assert.equal(calls, 0);
});

test("persistence_error events carry the port field", async () => {
  const store = fullStore();
  store.appendRound = async () => {
    throw new Error("append down");
  };
  const events = [];
  await assert.rejects(
    runToolLoop({
      provider: textProvider(),
      store,
      runId: "port-field",
      initialUserMessage: "work",
      executeTool: async () => "unused",
      diagnostics: { error: (event) => events.push(event) },
    }),
    (error) => error.termination?.reason === "persistence_failed",
  );
  const event = events.at(-1);
  assert.equal(event.type, "persistence_error");
  assert.equal(event.port, "transcript");
});

test("diagnostics sink failure is recorded in result.unpersisted as a delivery failure", async () => {
  const store = fullStore();
  let sinkCalls = 0;
  const sinkErrors = [];
  const result = await runToolLoop({
    provider: textProvider("sink broken"),
    store,
    runId: "sink-failure",
    initialUserMessage: "work",
    executeTool: async () => "unused",
    diagnostics: {
      error: () => {
        sinkCalls += 1;
        throw new Error("sink exploded");
      },
    },
    // 观察者通道仍正常：保证 loop 不会因缺 diagnostics 语义而改变终止行为。
    onPersistenceError: (error) => {
      sinkErrors.push(error);
    },
  });

  // run 本身正常完成（sink 失败不改变主流程语义）
  assert.equal(result.finalText, "sink broken");
  assert.equal(sinkCalls, 0); // 本场景无持久化失败，sink 不该被调
  assert.deepEqual(result.unpersisted, []);
  assert.deepEqual(result.completionErrors, []);

  // 真正的 teeth：持久化失败 + sink 抛错 → delivery_failure 必须进账单
  const failingStore = fullStore();
  failingStore.appendRound = async () => {
    throw new Error("append down");
  };
  const events = [];
  const result2 = await runToolLoop({
    provider: textProvider(),
    store: failingStore,
    runId: "sink-failure-real",
    initialUserMessage: "work",
    executeTool: async () => "unused",
    completion: false,
    diagnostics: {
      error: (event) => {
        events.push(event);
        throw new Error("sink exploded too");
      },
    },
  }).catch((error) => error);

  assert.equal(result2?.termination?.reason ?? result2?.code, "persistence_failed");
  assert.equal(events.length, 1);
  // 异常终止时账单必须挂在异常上（run 不会返回 result）
  const ledgerEntries = result2?.unpersisted ?? [];
  assert.ok(ledgerEntries.length > 0, "terminated run must carry the ledger on the exception");
  const delivery = ledgerEntries.find((entry) => entry.kind === "delivery_failure");
  assert.equal(delivery?.port, "diagnostics");
  assert.equal(delivery?.failedEvent?.port, "transcript");
  assert.equal(delivery?.error?.message, "sink exploded too");
  assert.equal(delivery?.failedEvent?.operation, "appendRound");
  const persisted = ledgerEntries.find((entry) => entry.kind === "persistence_error");
  assert.equal(persisted?.port, "transcript");
  assert.equal(persisted?.operation, "appendRound");
});

test("happy-path result always exposes unpersisted and completionErrors", async () => {
  const result = await runToolLoop({
    provider: textProvider("clean run"),
    store: fullStore(),
    runId: "ledger-schema",
    initialUserMessage: "work",
    executeTool: async () => "unused",
  });
  assert.deepEqual(result.unpersisted, []);
  assert.deepEqual(result.completionErrors, []);
  assert.ok(Object.isFrozen(Object.getPrototypeOf(result)) || Array.isArray(result.unpersisted));
});
