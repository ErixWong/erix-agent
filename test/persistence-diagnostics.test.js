import assert from "node:assert/strict";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const REQUIRED_STORE_METHODS = [
  "appendRound",
  "load",
];

// issue #78：run-state 为可选 capability，缺失不得在启动时报错。
const OPTIONAL_STORE_METHODS = [
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

test("required persistence validates required store methods before provider or tool execution", async () => {
  for (const missing of REQUIRED_STORE_METHODS) {
    const store = fullStore();
    delete store[missing];
    const provider = textProvider();
    let executions = 0;

    await assert.rejects(
      runDirect({
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

test("missing optional run-state methods do not fail startup (issue #78)", async () => {
  for (const missing of OPTIONAL_STORE_METHODS) {
    const store = fullStore();
    delete store[missing];
    const provider = textProvider();

    const result = await runDirect({
      provider,
      store,
      runId: `missing-optional-${missing}`,
      initialUserMessage: "validate",
      executeTool: async () => "unused",
    });
    assert.equal(result.finalText, "done", missing);
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
    runDirect({
      provider,
      store,
      runId: "append-failure",
      initialUserMessage: "persist",
      executeTool: async () => "unused",
      completion: false,
      config: { timing: { retry: { attempts: 2, backoffBaseMs: 1, backoffMaxMs: 2 } } },
      capabilities: { ports: { sleepImpl: async (ms) => sleeps.push(ms) } },
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

// 载体已退役（#838 S2），上述四格随之退役。

test("appendRound failure after a tool preserves the result in the recovery ledger", async () => {
  const store = fullStore();
  const originalAppendRound = store.appendRound.bind(store);
  // 工单 261021 写侧之后，一轮里不再只有一条 `appendRound`：本轮 assistant 正文行（seq 0）在
  // **工具执行前**就落盘，工具结果行（seq 1）才是「工具已经执行」之后的那一条。
  // 结果行拒写后，`tool-result-unledgered` 恢复行是其正文载体；只对带走 `tool_result` 的行注入故障。
  store.appendRound = async (runId, record) => {
    const carriesToolResult = (record.messages ?? []).some((message) => (
      (Array.isArray(message?.content) ? message.content : [])
        .some((block) => block?.type === "tool_result")
    ));
    if (record.round === 1 && carriesToolResult) throw new Error("transcript unavailable after tool");
    return originalAppendRound(runId, record);
  };
  const events = [];
  let executions = 0;

  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "append-after-tool", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    store,
    runId: "append-after-tool",
    initialUserMessage: "work",
    executeTool: async () => {
      executions += 1;
      return "executed";
    },
    completion: false,
    diagnostics: { error: (event) => events.push(event) },
  });
  assert.equal(result.finalText, "done");
  assert.equal(provider.requests.length, 2);
  assert.equal(executions, 1);
  const recovered = (await store.listRecoveryRows("append-after-tool"))
    .filter((row) => row.recoveryEvent === "tool-result-unledgered");
  assert.equal(recovered.length, 1, "无法写消息行的结果必须恰有一条恢复行");
  assert.equal(recovered[0].toolResult.content, "executed",
    "恢复行必须保留本次执行的正文，而不是声称执行状态未知");
  assert.ok(events.some((event) => event.operation === "appendRound"),
    "结果行写入失败仍必须经 diagnostics 暴露");
});

test("appendRound failure preserves the independent failed run-state", async () => {
  const store = fullStore();
  store.appendRound = async () => {
    throw new Error("transcript unavailable");
  };

  await assert.rejects(
    runDirect({
      provider: textProvider("done"),
      store,
      runId: "append-failure-state",
      initialUserMessage: "persist",
      executeTool: async () => "unused",
      completion: false,
      config: { timing: { retry: { attempts: 0 } } },
    }),
    (error) => error.termination?.reason === "persistence_failed"
      && error.operation === "appendRound",
  );

  const status = await store.loadRunStateStatus("append-failure-state");
  const persisted = await store.loadRunState("append-failure-state");
  assert.equal(status, "failed");
  assert.equal(persisted, undefined);
});

test("none persistence mode is a no-op even with an incomplete failing store", async () => {
  let calls = 0;
  const result = await runDirect({
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
    runDirect({
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
  const result = await runDirect({
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
    capabilities: {
      hooks: {
        onPersistenceError: (error) => {
          sinkErrors.push(error);
        },
      },
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
  const result2 = await runDirect({
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
  const result = await runDirect({
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

test("minimal store (required methods only) runs to completion with one-shot capability diagnostics (issue #78)", async () => {
  const store = {
    appendRound: async () => {},
    load: async () => [],
  };
  const events = [];
  let executions = 0;
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "tool-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: "minimal store done" }],
      stopReason: "end_turn",
    },
  ]);

  const result = await runDirect({
    provider,
    store,
    runId: "minimal-store-run",
    initialUserMessage: "work",
    executeTool: async () => {
      executions += 1;
      return "worked";
    },
    completion: false,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  // run 正常执行（含工具调用），仅不支持 run-state resume
  assert.equal(result.finalText, "minimal store done");
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.equal(result.unpersisted.length, 0);

  // 缺失的可选 run-state 与恢复行方法各只诊断一次（不每轮刷屏）。
  const degraded = events.filter((event) => event.type === "persistence_capability_degraded");
  // issue #769 起，恢复行通道同样是**可选能力**：最小 store 没有 `appendRecoveryRow` ⇒ 一条降级诊断。
  // 缺席是合法的，但必须**说出来**，不许静默丢掉这一格的写入。
  // issue #769 R3（A/C1）又加一条：fresh start（`resume !== true`）要清上一代的恢复行，而最小 store
  // 也没有 `clearRecoveryRows` ⇒ 第五格降级诊断。它是**载重的**（不是“写了没人调”）：没实现就等于
  // 本宿主放弃了同 runId 的代际隔离，必须能在事件流里看到这句话。
  assert.equal(degraded.length, 4, `降级诊断总数必须为 4，实际：${degraded.map((e) => e.method).join(",")}`);
  const byMethod = new Map(degraded.map((event) => [event.method, event]));
  for (const method of ["saveRunState", "markRunState", "appendRecoveryRow", "clearRecoveryRows"]) {
    assert.ok(byMethod.has(method), `必须诊断缺失的 ${method}`);
    const event = byMethod.get(method);
    assert.equal(event.runId, "minimal-store-run");
    assert.match(event.detail, new RegExp(method), "detail 必须点名缺失方法");
  }
});
