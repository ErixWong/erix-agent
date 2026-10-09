import test from "node:test";
import assert from "node:assert/strict";

import { KitError } from "../src/providers/errors.js";
import { createRunSnapshotExecutor } from "../src/loop/run-snapshot-executor.js";

const TOOL_BLOCK = {
  type: "tool_use",
  id: "call-1",
  name: "readFile",
  input: { path: "README.md" },
};

function createHarness({
  persistenceResults = [true, true],
  executeTool = async () => ({ content: "file contents" }),
} = {}) {
  const persistenceCalls = [];
  const executionCalls = [];
  let markToolExecutedCount = 0;
  const ctx = {
    aggregateBudgetTokens: undefined,
    archivedOutputs: [],
    snapshotResults: new Map(),
    toolStats: new Map(),
    persistRunSnapshot: async (snapshot) => {
      persistenceCalls.push({
        ...snapshot,
        toolResults: [...snapshot.toolResults],
      });
      return persistenceResults[persistenceCalls.length - 1];
    },
    hasRunSnapshotStore: true,
    runSnapshotFailureCount: 0,
    lastPersistenceFailure: {
      operation: "saveRunSnapshot",
      persistence: "file",
      persistenceError: new Error("snapshot write failed"),
    },
    runId: "run-snapshot-executor-test",
    baseToolContext: { cwd: "/virtual/project" },
    toolSignal: undefined,
    executeTool: async (options) => {
      executionCalls.push(options);
      return executeTool(options);
    },
    awaitWithAbort: (promise) => promise,
    signal: undefined,
    markToolExecuted: () => {
      markToolExecutedCount += 1;
    },
    onToolResult: undefined,
    outputHygieneEnabled: false,
    outputHygieneLimit: 100,
    toolErrorCount: 0,
    governorState: { effectiveMaxRounds: 10 },
    budgetRounds: 1,
    lowBudgetPrompted: false,
    messages: [{ role: "assistant", content: [TOOL_BLOCK] }],
    executedToolIds: new Set(),
  };
  return {
    ctx,
    executor: createRunSnapshotExecutor(ctx),
    persistenceCalls,
    executionCalls,
    get markToolExecutedCount() {
      return markToolExecutedCount;
    },
  };
}

test("createRunSnapshotExecutor persists before and after execution and indexes the result by tool id", async () => {
  const harness = createHarness();
  const toolResults = [];
  const pendingToolUses = [TOOL_BLOCK];

  const result = await harness.executor.executeToolBlock(
    TOOL_BLOCK,
    4,
    toolResults,
    pendingToolUses,
  );

  assert.equal(harness.persistenceCalls.length, 2);
  const [before, after] = harness.persistenceCalls;
  assert.equal(before.round, 4);
  assert.equal(before.pendingToolUse, TOOL_BLOCK);
  assert.equal(before.pendingToolUses, pendingToolUses);
  assert.deepEqual(before.toolResults, []);
  assert.equal(Object.hasOwn(before, "status"), false);

  assert.equal(after.round, 4);
  assert.equal(after.pendingToolUse, TOOL_BLOCK);
  assert.equal(after.pendingToolUses, pendingToolUses);
  assert.deepEqual(after.toolResults, [result]);
  assert.equal(after.status, "executed");
  assert.ok(Array.isArray(after.messagesOverride));

  assert.equal(harness.executionCalls.length, 1);
  assert.deepEqual(harness.executionCalls[0], {
    id: TOOL_BLOCK.id,
    name: TOOL_BLOCK.name,
    input: TOOL_BLOCK.input,
    context: { cwd: "/virtual/project", round: 4 },
    signal: undefined,
  });
  assert.equal(harness.markToolExecutedCount, 1);
  assert.strictEqual(harness.ctx.snapshotResults.get(TOOL_BLOCK.id), result);
});

test("createRunSnapshotExecutor fails closed when the pre-execution snapshot fails", async () => {
  const harness = createHarness({ persistenceResults: [false] });

  await assert.rejects(
    harness.executor.executeToolBlock(TOOL_BLOCK, 2, []),
    (error) => error instanceof KitError
      && error.code === "checkpoint_failed"
      && error.phase === "checkpoint_before_tool",
  );

  assert.equal(harness.ctx.runSnapshotFailureCount, 1);
  assert.equal(harness.persistenceCalls.length, 1);
  assert.equal(harness.executionCalls.length, 0);
  assert.equal(harness.markToolExecutedCount, 0);
});

test("createRunSnapshotExecutor reports post-execution snapshot failure after running the tool", async () => {
  const harness = createHarness({ persistenceResults: [true, false] });
  const toolResults = [];

  await assert.rejects(
    harness.executor.executeToolBlock(TOOL_BLOCK, 3, toolResults),
    (error) => error instanceof KitError
      && error.code === "checkpoint_failed"
      && error.phase === "checkpoint_after_tool",
  );

  assert.equal(harness.ctx.runSnapshotFailureCount, 1);
  assert.equal(harness.persistenceCalls.length, 2);
  assert.equal(harness.executionCalls.length, 1);
  assert.equal(harness.markToolExecutedCount, 1);
  assert.equal(toolResults.length, 1);
  assert.strictEqual(
    harness.ctx.snapshotResults.get(TOOL_BLOCK.id),
    toolResults[0],
  );
});

test("只读放行集合含 searchText（issue #195：继任入口不得比 rg 别名更容易被拦）", async () => {
  const { READONLY_INTERCEPT_TOOLS } = await import("../src/loop/run-snapshot-executor.js");
  assert.ok(READONLY_INTERCEPT_TOOLS.has("rg"), "别名 rg 本来就在只读集合里");
  assert.ok(
    READONLY_INTERCEPT_TOOLS.has("searchText"),
    "searchText 是 rg 的规范继任入口：同一件只读工作换个名字，run 的拦截行为不该变",
  );
  assert.equal(READONLY_INTERCEPT_TOOLS.has("writeFile"), false, "写工具不得进只读集合");
  assert.equal(READONLY_INTERCEPT_TOOLS.has("exec"), false, "exec 有副作用，不属只读");
});
