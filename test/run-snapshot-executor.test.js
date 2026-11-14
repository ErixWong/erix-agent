import test from "node:test";
import assert from "node:assert/strict";

import { renderConversation } from "../src/reflection/judge.js";
import { createRunSnapshotExecutor } from "../src/loop/run-snapshot-executor.js";

const TOOL_BLOCK = {
  type: "tool_use",
  id: "call-1",
  name: "readFile",
  input: { path: "README.md" },
};

function createHarness({ executeTool = async () => ({ content: "file contents" }) } = {}) {
  const executionCalls = [];
  let markToolExecutedCount = 0;
  const ctx = {
    aggregateBudgetTokens: undefined,
    archivedOutputs: [],
    toolStats: new Map(),
    toolResultsById: new Map(),
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
    executionCalls,
    get markToolExecutedCount() {
      return markToolExecutedCount;
    },
  };
}

test("createRunSnapshotExecutor executes a tool and indexes its result by tool id", async () => {
  const harness = createHarness();
  const toolResults = [];
  const pendingToolUses = [TOOL_BLOCK];

  const result = await harness.executor.executeToolBlock(
    TOOL_BLOCK,
    4,
    toolResults,
    pendingToolUses,
  );

  assert.equal(harness.executionCalls.length, 1);
  assert.deepEqual(harness.executionCalls[0], {
    id: TOOL_BLOCK.id,
    name: TOOL_BLOCK.name,
    input: TOOL_BLOCK.input,
    context: { cwd: "/virtual/project", round: 4 },
    signal: undefined,
  });
  assert.equal(harness.markToolExecutedCount, 1);
  assert.strictEqual(harness.ctx.toolResultsById.get(TOOL_BLOCK.id), result);
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

test("#323 blocked 分支把方向提示与被拦结果分开，tool_result 事实不受影响", async () => {
  const blockedTool = {
    type: "tool_use",
    id: "call-blocked-1",
    name: "writeFile",
    input: { path: "src/a.js" },
  };
  const harness = createHarness();
  Object.assign(harness.ctx, {
    judgeInterceptEnabled: true,
    judgeInterceptCount: 1,
    judgeIntervalRound: 1,
    emitJudge: () => {},
    callRoundJudge: async () => ({
      decision: {
        done: false,
        confidence: 0.9,
        reason: "写文件超出任务范围",
        evidence: "目标只要求读",
        direction: "off_track",
        directionReason: "先核对任务边界再动手 #323-hint-probe",
      },
    }),
  });

  const toolResults = [];
  await harness.executor.executeToolWithIntercept(blockedTool, 3, toolResults, [blockedTool]);

  assert.ok(harness.executor.pendingDirectionHints.some((text) => text.includes("#323-hint-probe")),
    "方向提示必须独立交给调用方");
  assert.ok(toolResults.some((result) => JSON.stringify(result).includes("【审计拦截】")),
    "被拦结果仍应作为 tool_result 事实返回");
  const rendered = renderConversation([{ role: "assistant", content: [blockedTool] },
    { role: "tool", content: toolResults }]);
  assert.ok(!rendered.includes("#323-hint-probe"), "方向提示不得被混入 judge 可见的工具结果");
  assert.match(rendered, /【审计拦截】/u, "被拦事实必须仍进 judge 输入");
});
