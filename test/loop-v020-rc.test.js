import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { KitError } from "../src/providers/errors.js";
import { computeBudget } from "../src/compact/budget.js";
import { estimateMessageTokens } from "../src/tokens.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
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
  assert.deepEqual(received.context, {
    tenant: "tenant-1",
    expert: "expert-1",
    user: { id: "user-1" },
    task: { id: "task-1" },
    session: "session-1",
    requestId: "request-1",
    round: 1,
  });
  assert.ok(received.signal === undefined || received.signal instanceof AbortSignal);

  const result = provider.requests[1].messages.at(-1).content[0];
  assert.equal(result.content, "found");
  assert.equal(result.success, true);
  assert.equal(result.toolMessageId, "message-1");
  assert.equal(typeof result.duration, "number");
});

test("positional executeTool remains supported", async () => {
  const provider = createFakeProvider([
    toolResponse("positional-1", "sum", { value: 3 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const calls = [];

  await runToolLoop({
    provider,
    initialUserMessage: "sum",
    executeTool: async (name, input) => {
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
    modelConfig: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 },
    context: { strategy },
  });

  assert.deepEqual(calls, [computeBudget({
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
  })]);
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
    assert.ok(estimateMessageTokens(request.messages) <= budgetTokens);
  }
  assert.ok(result.compactionStats[0].tokensAfter <= budgetTokens);
});

test("uses the latest API input usage instead of the cumulative total for compaction", async () => {
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

test("reduces keepRounds for severe API overage and resets the API snapshot", async () => {
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

  assert.deepEqual(keepRounds, [6, 2]);
  assert.deepEqual(provider.requests[1].messages, []);
});

test("uses API usage projection when local compaction appears within budget", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "projection-1", name: "work", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 80, output_tokens: 1 },
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
    context: { strategy, budgetTokens: 20 },
  });

  assert.deepEqual(provider.requests[1].messages, []);
  assert.equal(result.compactionStats[0].tokensAfter, 0);
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

test("reports persistence failures without stopping the loop", async () => {
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
    onPersistenceError: (error) => errors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.message === "disk full"));
});

test("keeps fold recall round numbers global across loop compactions", async () => {
  const provider = createFakeProvider([
    toolResponse("global-1"),
    toolResponse("global-2"),
    toolResponse("global-3"),
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
