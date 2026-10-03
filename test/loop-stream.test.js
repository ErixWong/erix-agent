import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";

function createStreamingProvider(script) {
  const streamCalls = [];
  const steps = [...script];
  let index = 0;

  const nextResponse = () => {
    if (index >= steps.length) throw new Error("streaming provider script exhausted");
    const step = steps[index];
    index += 1;
    return step;
  };

  return {
    streamCalls,
    async chatStream(request) {
      streamCalls.push(request);
      const step = nextResponse();
      for (const chunk of step.deltas ?? []) {
        request.onDelta?.(chunk);
      }
      return step.response;
    },
  };
}

test("streams text deltas and keeps the batch loop result", async () => {
  const streamedChunks = [];
  const streamProvider = createStreamingProvider([{
    deltas: ["你", "好"],
    response: {
      content: [{ type: "text", text: "你好" }],
      stopReason: "end_turn",
      usage: {},
    },
  }]);
  const streamed = await runToolLoop({
    provider: streamProvider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => streamedChunks.push(chunk),
  });

  const batchProvider = {
    async chat() {
      return {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
        usage: {},
      };
    },
  };
  const batch = await runToolLoop({
    provider: batchProvider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.deepEqual(streamedChunks, ["你", "好"]);
  assert.equal(streamed.finalText, batch.finalText);
  assert.equal(streamed.rounds, batch.rounds);
  assert.equal(streamProvider.streamCalls.length, 1);
});

test("passes deltas through before chatStream returns when retry is disabled", async () => {
  const order = [];
  const provider = {
    async chatStream(request) {
      order.push("chatStream:start");
      for (const chunk of ["你", "好"]) {
        request.onDelta?.(chunk);
        order.push(`provider:delta:${chunk}`);
      }
      order.push("chatStream:return");
      return {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
      };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => order.push(`onDelta:${chunk}`),
  });

  assert.deepEqual(order, [
    "chatStream:start",
    "onDelta:你",
    "provider:delta:你",
    "onDelta:好",
    "provider:delta:好",
    "chatStream:return",
  ]);
});

test("isolates streaming observer failures from a successful provider call", async () => {
  const reported = [];
  const events = [];
  let calls = 0;
  const provider = {
    async chatStream(request) {
      calls += 1;
      request.onDelta?.("hello");
      request.onUsage?.({ input_tokens: 2, output_tokens: 1 });
      return {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    stream: true,
    onDelta: () => {
      throw new Error("delta observer failed");
    },
    onUsage: () => {
      throw new Error("usage observer failed");
    },
    onEvent: (event) => events.push(event),
    onObserverError: (error) => reported.push(error.message),
    retry: {
      attempts: 1,
      backoffBaseMs: 0,
      sleepImpl: async () => {},
    },
  });

  assert.equal(result.finalText, "done");
  assert.equal(result.usage.input_tokens, 2);
  assert.equal(calls, 1);
  assert.deepEqual(reported, ["delta observer failed", "usage observer failed"]);
  assert.deepEqual(events.filter((event) => event.type === "usage"), [{
    type: "usage",
    round: 1,
    usage: { input_tokens: 2, output_tokens: 1 },
  }]);
});

test("isolates streaming observer failures while flushing a retried attempt", async () => {
  let calls = 0;
  const reported = [];
  const provider = {
    async chatStream(request) {
      calls += 1;
      request.onDelta?.(calls === 1 ? "discarded" : "kept");
      if (calls === 1) {
        const error = new Error("temporary provider failure");
        error.retryable = true;
        throw error;
      }
      return {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    stream: true,
    onDelta: () => {
      throw new Error("queued observer failed");
    },
    onObserverError: (error) => reported.push(error.message),
    retry: {
      attempts: 1,
      backoffBaseMs: 0,
      sleepImpl: async () => {},
    },
  });

  assert.equal(result.finalText, "done");
  assert.equal(calls, 2);
  assert.deepEqual(reported, ["queued observer failed"]);
});

test("keeps streaming functional when observer error reporting is not configured", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const result = await runToolLoop({
      provider: {
        async chatStream(request) {
          request.onDelta?.("done");
          return {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
          };
        },
      },
      initialUserMessage: "task",
      executeTool: async () => "unused",
      stream: true,
      onDelta: () => {
        throw new Error("unhandled observer failed");
      },
    });

    assert.equal(result.finalText, "done");
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "Observer callback error:");
    assert.equal(logged[0][1].message, "unhandled observer failed");
  } finally {
    console.error = originalError;
  }
});

test("holds deltas until the successful attempt when retry is enabled", async () => {
  const order = [];
  let calls = 0;
  const provider = {
    async chatStream(request) {
      calls += 1;
      order.push(`chatStream:start:${calls}`);
      request.onDelta?.(calls === 1 ? "失败" : "成功");
      order.push(`chatStream:return:${calls}`);
      if (calls === 1) {
        const error = new Error("connection reset");
        error.retryable = true;
        throw error;
      }
      return {
        content: [{ type: "text", text: "成功" }],
        stopReason: "end_turn",
      };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (chunk) => order.push(`onDelta:${chunk}`),
    retry: {
      attempts: 1,
      backoffBaseMs: 0,
      sleepImpl: async () => {},
    },
  });

  assert.deepEqual(order, [
    "chatStream:start:1",
    "chatStream:return:1",
    "chatStream:start:2",
    "chatStream:return:2",
    "onDelta:成功",
  ]);
});

test("streams tool-loop responses while executing tools normally", async () => {
  const streamedChunks = [];
  const executed = [];
  const provider = createStreamingProvider([
    {
      response: {
        content: [{
          type: "tool_use",
          id: "call-1",
          name: "lookup",
          input: { key: "x" },
        }],
        stopReason: "tool_use",
        usage: {},
      },
    },
    {
      deltas: ["你", "好"],
      response: {
        content: [{ type: "text", text: "你好" }],
        stopReason: "end_turn",
        usage: {},
      },
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "find x",
    executeTool: async ({ name, input }) => {
      executed.push({ name, input });
      return "found";
    },
    completion: false,
    stream: true,
    onDelta: (chunk) => streamedChunks.push(chunk),
  });

  assert.equal(result.finalText, "你好");
  assert.equal(result.rounds, 2);
  assert.equal(provider.streamCalls.length, 2);
  assert.deepEqual(streamedChunks, ["你", "好"]);
  assert.deepEqual(executed, [{ name: "lookup", input: { key: "x" } }]);
});

test("falls back to chat when streaming is unavailable", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      return {
        content: [{ type: "text", text: "批式回复" }],
        stopReason: "end_turn",
        usage: {},
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
  });

  assert.equal(result.finalText, "批式回复");
  assert.equal(result.rounds, 1);
  assert.equal(calls.length, 1);
});

test("does not stream unless explicitly enabled", async () => {
  const provider = createStreamingProvider([{
    deltas: ["批式"],
    response: {
      content: [{ type: "text", text: "批式" }],
      stopReason: "end_turn",
      usage: {},
    },
  }]);
  const batchCalls = [];
  provider.chat = async () => {
    batchCalls.push(true);
    return {
      content: [{ type: "text", text: "批式" }],
      stopReason: "end_turn",
      usage: {},
    };
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.equal(result.finalText, "批式");
  assert.equal(provider.streamCalls.length, 0);
  assert.equal(batchCalls.length, 1);
});

test("partial persistence restores the latest committed text after an interruption mid-window", async () => {
  const intervalMs = 60;
  const store = createSnapshotStore();
  const controller = new AbortController();
  let streamedRequest;
  let resolveStreamStarted;
  const streamStarted = new Promise((resolve) => {
    resolveStreamStarted = resolve;
  });
  const provider = {
    async chatStream(request) {
      streamedRequest = request;
      resolveStreamStarted();
      return new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve({
          content: [],
          stopReason: "end_turn",
        }), { once: true });
      });
    },
  };

  const interrupted = runToolLoop({
    provider,
    initialUserMessage: "resume partial",
    executeTool: async () => "unused",
    store,
    runId: "partial-resume",
    signal: controller.signal,
    stream: true,
    partialPersistence: { intervalMs },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  await streamStarted;
  streamedRequest.onDelta("committed partial ");
  await waitFor(() => store.partialWrites.length === 1);
  const nextWindowStartedAt = Date.now();
  streamedRequest.onDelta("uncommitted tail");
  await delay(Math.floor(intervalMs / 2));
  assert.equal(store.partialWrites.length, 1, "no second write before the next interval");
  assert.ok(Date.now() - nextWindowStartedAt < intervalMs);

  controller.abort();
  await assert.rejects(interrupted, /aborted|abort/i);
  assert.equal(store.latestSnapshot.partialText, "committed partial ");

  let resumedRequest;
  const resumed = await runToolLoop({
    provider: {
      async chatStream(request) {
        resumedRequest = request;
        return {
          content: [{ type: "text", text: "continued" }],
          stopReason: "end_turn",
        };
      },
    },
    initialUserMessage: "ignored while resuming",
    executeTool: async () => "unused",
    store,
    runId: "partial-resume",
    resume: true,
    stream: true,
    partialPersistence: { intervalMs },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.ok(resumedRequest.messages.some((message) => (
    message.role === "assistant"
    && message.content.some((block) => block.type === "text"
      && block.text === "committed partial ")
  )));
  assert.equal(resumed.finalText, "continued");
});

test("partial persistence respects interval and minBytes with single-flight writes", async () => {
  const intervalMs = 40;
  const store = createSnapshotStore({ writeDelayMs: intervalMs * 1.5 });
  let streamedRequest;
  let resolveStreamStarted;
  let resolveStream;
  const streamStarted = new Promise((resolve) => {
    resolveStreamStarted = resolve;
  });
  const provider = {
    async chatStream(request) {
      streamedRequest = request;
      resolveStreamStarted();
      return new Promise((resolve) => {
        resolveStream = resolve;
      });
    },
  };

  const running = runToolLoop({
    provider,
    initialUserMessage: "throttle partial",
    executeTool: async () => "unused",
    store,
    runId: "partial-throttle",
    stream: true,
    partialPersistence: { intervalMs, minBytes: 2 },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  await streamStarted;
  streamedRequest.onDelta("a");
  await delay(intervalMs + 10);
  assert.equal(store.partialWrites.length, 0, "sub-threshold deltas do not schedule writes");

  streamedRequest.onDelta("é");
  const firstEligibleDeltaAt = Date.now();
  await waitFor(() => store.partialWrites.length === 1);
  assert.ok(store.partialWrites[0].startedAt - firstEligibleDeltaAt >= intervalMs - 2);
  assert.equal(store.partialWrites[0].snapshot.partialText, "aé");

  streamedRequest.onDelta("b");
  await delay(intervalMs * 2 + 10);
  assert.equal(store.partialWrites.length, 1, "a sub-threshold delta during a write does not schedule another");

  streamedRequest.onDelta("xy");
  const secondEligibleDeltaAt = Date.now();
  await delay(Math.floor(intervalMs / 2));
  assert.equal(store.partialWrites.length, 1, "writes are throttled to the configured interval");
  await waitFor(() => store.partialWrites.length === 2);
  assert.ok(store.partialWrites[1].startedAt - secondEligibleDeltaAt >= intervalMs - 2);
  assert.equal(store.maxActiveWrites, 1, "snapshot writes never overlap");
  assert.equal(store.partialWrites[1].snapshot.partialText, "aébxy");

  resolveStream({
    content: [{ type: "text", text: "finished" }],
    stopReason: "end_turn",
  });
  const result = await running;
  assert.equal(result.finalText, "finished");
});

test("partial snapshot from a retryable attempt is cleared before retry", async () => {
  const intervalMs = 20;
  const store = createSnapshotStore();
  let calls = 0;
  const result = await runToolLoop({
    provider: {
      async chatStream(request) {
        calls += 1;
        request.onDelta(calls === 1 ? "discarded partial" : "kept partial");
        if (calls === 1) {
          await delay(intervalMs + 10);
          const error = new Error("retryable stream failure");
          error.retryable = true;
          throw error;
        }
        return {
          content: [{ type: "text", text: "recovered" }],
          stopReason: "end_turn",
        };
      },
    },
    initialUserMessage: "retry partial",
    executeTool: async () => "unused",
    store,
    runId: "partial-retry",
    stream: true,
    partialPersistence: { intervalMs },
    retry: { attempts: 1, backoffBaseMs: 0, sleepImpl: async () => {} },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });

  assert.equal(result.finalText, "recovered");
  assert.equal(calls, 2);
  assert.equal(store.partialWrites.length, 1);
  assert.equal(store.latestSnapshot.partialText, undefined);
});

function createSnapshotStore({ writeDelayMs = 0 } = {}) {
  const records = [];
  const partialWrites = [];
  let latestSnapshot;
  let activeWrites = 0;
  let maxActiveWrites = 0;

  return {
    partialWrites,
    get latestSnapshot() {
      return latestSnapshot;
    },
    get maxActiveWrites() {
      return maxActiveWrites;
    },
    async appendRound(_runId, record) {
      records.push(structuredClone(record));
    },
    async load() {
      return records.map((record) => structuredClone(record));
    },
    async saveRunSnapshot(_runId, snapshot) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      const startedAt = Date.now();
      try {
        if (snapshot.partialText !== undefined) {
          partialWrites.push({
            startedAt,
            snapshot: structuredClone(snapshot),
          });
        }
        if (writeDelayMs > 0) await delay(writeDelayMs);
        latestSnapshot = structuredClone(snapshot);
      } finally {
        activeWrites -= 1;
      }
    },
    async loadLatestRunSnapshot() {
      return latestSnapshot === undefined ? undefined : structuredClone(latestSnapshot);
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await delay(5);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
