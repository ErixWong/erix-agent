import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { KitError } from "../src/providers/errors.js";
import { computeBudget } from "../src/compact/budget.js";
import { estimateMessageTokens } from "../src/tokens.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createModelConfigResolver } from "../src/config/static.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function toolResponse(id = "tool-1", name = "work", input = {}) {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}

test("structured executeTool receives context and returns tool metadata", async () => {
  const provider = createFakeProvider([
    toolResponse("structured-1", "lookup", { key: "x" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  let received;

  await runToolLoop({
    provider,
    initialUserMessage: "look up x",
    executeTool: async (options) => {
      received = options;
      return { success: true, data: "found", toolMessageId: "message-1" };
    },
    expert: "expert-1",
    user: { id: "user-1" },
    task: { id: "task-1" },
    session: "session-1",
    requestId: "request-1",
    toolContext: { tenant: "tenant-1" },
    completion: false,
  });

  assert.equal(received.id, "structured-1");
  assert.equal(received.name, "lookup");
  assert.deepEqual(received.input, { key: "x" });
  assert.deepEqual(
    { ...received.context, reportPersistenceFailure: undefined },
    {
      tenant: "tenant-1",
      expert: "expert-1",
      user: { id: "user-1" },
      task: { id: "task-1" },
      session: "session-1",
      requestId: "request-1",
      round: 1,
      reportPersistenceFailure: undefined,
    },
  );
  // #109 第2步：宿主持久化失败报告桥随 context 注入
  assert.equal(typeof received.context.reportPersistenceFailure, "function");
  assert.ok(received.signal === undefined || received.signal instanceof AbortSignal);

  const result = provider.requests[1].messages.at(-1).content[0];
  assert.equal(result.content, "found");
  assert.equal(result.success, true);
  assert.equal(result.toolMessageId, "message-1");
  assert.equal(typeof result.duration, "number");
});

test("structured executeTool supports destructured tool fields", async () => {
  const provider = createFakeProvider([
    toolResponse("positional-1", "sum", { value: 3 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const calls = [];

  await runToolLoop({
    provider,
    initialUserMessage: "sum",
    executeTool: async ({ name, input }) => {
      calls.push([name, input]);
      return `${name}:${input.value}`;
    },
    completion: false,
  });

  assert.deepEqual(calls, [["sum", { value: 3 }]]);
  assert.equal(provider.requests[1].messages.at(-1).content[0].content, "sum:3");
});

test("structured executeTool observes loop abort", async () => {
  const controller = new AbortController();
  const provider = createFakeProvider([toolResponse("abort-1")]);
  let toolSignal;

  const run = runToolLoop({
    provider,
    initialUserMessage: "abort",
    executeTool: ({ signal }) => new Promise((resolve, reject) => {
      toolSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    signal: controller.signal,
    completion: false,
  });
  setTimeout(() => controller.abort(new Error("cancelled")), 5);

  await assert.rejects(run, (error) => error?.message === "cancelled");
  assert.equal(toolSignal, controller.signal);
});

test("completion is enabled by default after a tool round", async () => {
  const provider = createFakeProvider([
    toolResponse("complete-1"),
    { content: [{ type: "text", text: "still working" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "finish the work",
    executeTool: async () => "worked",
    maxRounds: 2,
  });

  assert.equal(result.truncated, true);
  assert.equal(provider.requests.length, 2);
  assert.equal(
    result.messages.at(-1).content[0].text,
    "（请继续完成任务）",
  );
});

test("derives the compaction budget from model metadata", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const calls = [];
  const strategy = {
    shouldCompact(_messages, budgetTokens) {
      calls.push(budgetTokens);
      return false;
    },
    async compact(messages) {
      return { messages, compacted: false, foldedRounds: 0 };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "budget",
    executeTool: async () => "unused",
    modelConfig: createModelConfigResolver({
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
    }),
    session: { id: "budget-model-config" },
    context: { strategy },
  });

  assert.deepEqual(calls, [computeBudget({
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
  })]);
});

test("rejects plain modelConfig at the fine-grained entry point", async () => {
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]),
      initialUserMessage: "plain config",
      executeTool: async () => "unused",
      modelConfig: { model: "plain" },
      completion: false,
    }),
    (error) => error instanceof TypeError
      && /modelConfig\.resolve/u.test(error.message)
      && /wrap plain config with createModelConfigResolver/u.test(error.message),
  );
});

test("rejects invalid explicit compaction budgets", async () => {
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialUserMessage: "invalid",
      executeTool: async () => "unused",
      context: { budgetTokens: 0 },
    }),
    (error) => error instanceof KitError && error.code === "invalid_budget",
  );
});

test("enforces the budget after an oversized fold result", async () => {
  const budgetTokens = 8;
  const provider = createFakeProvider([
    toolResponse("budget-1"),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const strategy = {
    shouldCompact() {
      return true;
    },
    async compact() {
      return {
        messages: [{
          role: "user",
          content: [{ type: "text", text: "oversized folded context ".repeat(40) }],
        }],
        compacted: true,
        foldedRounds: 1,
        foldedPayload: [],
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "budget",
    executeTool: async () => "worked",
    context: { strategy, budgetTokens },
    completion: false,
  });

  assert.ok(result.compactionStats.length >= 1);
  for (const request of provider.requests) {
    const persistentView = request.messages.filter((message) => (
      !Array.isArray(message.content) || !message.content.some((block) => (
        block?.type === "text"
        && /\[run state deterministic v/u.test(block.text ?? "")
      ))
    ));
    assert.ok(estimateMessageTokens(persistentView) <= budgetTokens);
  }
  assert.ok(result.compactionStats[0].tokensAfter <= budgetTokens);
});

test("downgrades the oldest protected message when the protected set exceeds the budget", async () => {
  const first = { role: "user", content: [{ type: "text", text: "first protected" }] };
  const second = { role: "user", content: [{ type: "text", text: "second protected" }] };
  const budgetTokens = estimateMessageTokens([first]) + 1;
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialMessages: [
      first,
      { role: "assistant", content: [{ type: "text", text: "middle" }] },
      second,
    ],
    executeTool: async () => "unused",
    completion: false,
    context: {
      budgetTokens,
      protectedMessage: (message) => message?.role === "user",
    },
  });

  assert.equal(result.compactionStats[0].protectedDowngraded, 1);
  assert.deepEqual(
    provider.requests[0].messages.map((message) => message.content?.[0]?.text),
    ["second protected"],
  );
});

test("rejects a single protected message that cannot fit the budget", async () => {
  const protectedMessage = {
    role: "user",
    content: [{ type: "text", text: "x".repeat(200) }],
  };

  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialMessages: [protectedMessage],
      executeTool: async () => "unused",
      completion: false,
      context: {
        budgetTokens: 20,
        protectedMessage: () => true,
      },
    }),
    (error) => error instanceof KitError
      && error.code === "invalid_budget"
      && /increase budgetTokens|reduce the protectedMessage set/.test(error.message),
  );
});

test("does not compact from cumulative API usage when local context fits", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "usage-1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 60, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 60, output_tokens: 1 },
    },
  ]);
  let compactions = 0;
  const strategy = {
    shouldCompact() {
      return false;
    },
    async compact() {
      compactions += 1;
      throw new Error("compaction should not be requested");
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    context: { strategy, budgetTokens: 100 },
  });

  assert.equal(compactions, 0);
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 2 });
});

test("keeps the configured keepRounds when only API usage is over budget", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "keep-1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  ]);
  const keepRounds = [];
  const strategy = {
    shouldCompact() {
      return true; // 走 configuredStrategy 路径，验证 keepRounds 动态收紧
    },
    async compact(_messages, options) {
      keepRounds.push(options.keepRounds);
      return { messages: [], compacted: true, foldedRounds: 1 };
    },
  };

  await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    context: { strategy, budgetTokens: 20, keepRounds: 6 },
  });

  assert.deepEqual(keepRounds, [6, 6]);
  assert.deepEqual(provider.requests[1].messages, []);
});

test("does not compact when per-request input fits budget and local context fits", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "projection-1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ]);
  const strategy = {
    shouldCompact() {
      return false;
    },
    async compact() {
      return {
        messages: [{ role: "user", content: "tiny" }],
        compacted: true,
        foldedRounds: 1,
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    context: { strategy, budgetTokens: 30 },
  });

  assert.equal(provider.requests.length, 2);
  assert.equal(result.compactionStats.length, 0);
  assert.equal(result.usage.input_tokens, 9);
});

test("compacts when the local context estimate exceeds the budget", async () => {
  const provider = createFakeProvider([
    toolResponse("local-budget-1"),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    context: { budgetTokens: 10 },
  });

  assert.ok(result.compactionStats.length >= 1);
  assert.ok(result.compactionStats.some((stat) => stat.compacted));
});

test("injects a task reminder after a late welcome response", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 6 }, (_value, index) => toolResponse(`memory-${index + 1}`)),
    {
      content: [{
        type: "text",
        text: "你好！我是 erix 编码助手。看起来你还没有输入具体任务，请告诉我你想做什么。",
      }],
      stopReason: "end_turn",
    },
    { content: [{ type: "text", text: "continued work" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "complete the task",
    executeTool: async () => "worked",
    maxRounds: 8,
    completion: false,
    stallDetection: false,
  });

  assert.equal(result.finalText, "continued work");
  assert.equal(provider.requests.length, 8);
  assert.ok(provider.requests[7].messages.some((message) => (
    message.content?.some((block) => block.text?.includes("你的任务仍在进行中"))
  )));
});

test("checkpoints before tools and resumes without replaying an executed tool", async () => {
  const store = createMemoryTranscriptStore();
  const events = [];
  const originalSaveCheckpoint = store.saveCheckpoint;
  store.saveCheckpoint = async (runId, checkpoint) => {
    events.push(["checkpoint", checkpoint.status]);
    return originalSaveCheckpoint.call(store, runId, checkpoint);
  };
  const provider = createFakeProvider([
    toolResponse("checkpoint-1"),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "checkpoint",
    executeTool: async () => {
      events.push(["tool"]);
      return "worked";
    },
    store,
    runId: "checkpoint-run",
    completion: false,
  });

  assert.deepEqual(events.slice(0, 2), [["checkpoint", "pending"], ["tool"]]);
  assert.equal((await store.loadRunState("checkpoint-run")).state, "succeeded");

  const resumeStore = createMemoryTranscriptStore();
  await resumeStore.appendRound("resume-checkpoint", {
    round: 0,
    messages: [{ role: "user", content: "resume" }],
  });
  await resumeStore.saveCheckpoint("resume-checkpoint", {
    round: 1,
    status: "executed",
    pendingToolUse: { type: "tool_use", id: "already-done", name: "work", input: {} },
    pendingToolUses: [{
      type: "tool_use",
      id: "already-done",
      name: "work",
      input: {},
    }],
    messages: [
      { role: "user", content: "resume" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "already-done", name: "work", input: {} }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "already-done",
          content: "replayed",
        }],
      },
    ],
    executedToolIds: ["already-done"],
    toolResults: [{
      toolUseId: "already-done",
      toolResult: {
        type: "tool_result",
        tool_use_id: "already-done",
        content: "replayed",
      },
    }],
  });
  let executions = 0;
  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "resumed" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider: resumedProvider,
    executeTool: async () => {
      executions += 1;
      return "must not run";
    },
    store: resumeStore,
    runId: "resume-checkpoint",
    resume: true,
    completion: false,
  });

  assert.equal(executions, 0);
  assert.equal(resumedProvider.requests[0].messages.at(-1).content[0].content, "replayed");
  assert.deepEqual(
    (await resumeStore.load("resume-checkpoint")).map((record) => record.round),
    [0, 1, 2],
  );
});

test("fails closed when a checkpoint cannot be persisted before a tool", async () => {
  const store = createMemoryTranscriptStore();
  store.saveCheckpoint = async () => {
    throw new Error("checkpoint disk full");
  };
  const provider = createFakeProvider([
    toolResponse("checkpoint-failure", "work"),
  ]);
  let executions = 0;

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "checkpoint failure",
      executeTool: async () => {
        executions += 1;
        return "must not run";
      },
      store,
      runId: "checkpoint-failure-run",
      completion: false,
      onPersistenceError: () => {},
    }),
    (error) => error instanceof KitError
      && error.code === "checkpoint_failed"
      && /checkpoint-failure-run/.test(error.message)
      && /round=1/.test(error.message)
      && error.termination?.reason === "persistence_failed",
  );
  assert.equal(executions, 0);
});

test("fails closed after a tool when its executed checkpoint cannot be persisted", async () => {
  const store = createMemoryTranscriptStore();
  const originalSaveCheckpoint = store.saveCheckpoint;
  let executions = 0;
  store.saveCheckpoint = async (runId, checkpoint) => {
    if (checkpoint.status === "executed") {
      throw new Error("checkpoint disk full after execution");
    }
    return originalSaveCheckpoint.call(store, runId, checkpoint);
  };

  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([
        toolResponse("post-checkpoint-failure", "work"),
      ]),
      initialUserMessage: "post checkpoint failure",
      executeTool: async () => {
        executions += 1;
        return "side effect completed";
      },
      store,
      runId: "post-checkpoint-failure-run",
      completion: false,
      onPersistenceError: () => {},
    }),
    (error) => error instanceof KitError
      && error.code === "checkpoint_failed"
      && /after tool execution/.test(error.message)
      && /already executed but result was not persisted/.test(error.message)
      && error.termination?.reason === "persistence_failed",
  );
  assert.equal(executions, 1);
  assert.equal((await store.loadRunState("post-checkpoint-failure-run")).state, "failed");
});

test("none persistence mode does not call a save-only checkpoint writer", async () => {
  const provider = createFakeProvider([
    toolResponse("save-only", "work"),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  let executions = 0;
  let saveAttempts = 0;

  const result = await runToolLoop({
    provider,
    initialUserMessage: "save only",
    executeTool: async () => {
      executions += 1;
      return "worked";
    },
    store: {
      async saveCheckpoint() {
        saveAttempts += 1;
        throw new Error("save-only store write failure");
      },
    },
    runId: "save-only-run",
    persistence: "none",
    completion: false,
    onPersistenceError: () => {},
  });

  assert.equal(executions, 1, "save-only store 不应阻止工具执行");
  assert.equal(result.finalText, "done");
  assert.equal(saveAttempts, 0, "none 模式不应调用持久化 writer");
});

test("executes tools normally without a checkpoint store", async () => {
  const provider = createFakeProvider([
    toolResponse("no-checkpoint", "work"),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  let executions = 0;

  const result = await runToolLoop({
    provider,
    initialUserMessage: "no checkpoint",
    executeTool: async () => {
      executions += 1;
      return "worked";
    },
    completion: false,
  });

  assert.equal(executions, 1);
  assert.equal(result.finalText, "done");
});

test("none persistence mode ignores an incomplete store without stopping the loop", async () => {
  const errors = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "persist",
    executeTool: async () => "unused",
    store: {
      async appendRound() {
        throw new Error("disk full");
      },
    },
    runId: "persistence",
    persistence: "none",
    onPersistenceError: (error) => errors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.equal(errors.length, 0);
});

test("keeps fold round numbers global across loop compactions", async () => {
  const provider = createFakeProvider([
    toolResponse("global-1"),
    toolResponse("global-2"),
    toolResponse("global-3"),
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  const offsets = [];
  const baseStrategy = createFoldStatisticalStrategy();
  const strategy = {
    shouldCompact() {
      return true;
    },
    async compact(messages, options) {
      offsets.push(options.roundOffset);
      return baseStrategy.compact(messages, { ...options, keepRounds: 0 });
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "global rounds",
    executeTool: async () => "worked",
    maxRounds: 3,
    completion: false,
    context: { strategy, budgetTokens: 20 },
    store,
    runId: "global-folds",
  });

  assert.equal(result.rounds, 3);
  assert.deepEqual(offsets.slice(-2), [undefined, 1]);
  assert.deepEqual(
    (await store.load("global-folds"))
      .filter((record) => record.folded)
      .map((record) => record.foldedRoundRange),
    [{ from: 1, to: 1 }, { from: 2, to: 2 }],
  );
});
