// `erix.success` 的迁移等价（工单 261014 T2 §4）。
//
// 停写前，「引擎归一化后的成败」这个值住在**顶层** `success` 键上（由
// `run-snapshot-executor.js` 的 `normalizeExecutionResult` 算出：
// `success = value.success ?? metadata.success ?? true` 再过 `success !== false`，
// 遗留 `{data}` 路径是 `structured.success ?? true` 再过 `metadata.success !== false`）。
// 停写后顶层那个键没了，值改住 `erix.success`，而 T2 的裁定是**取消「宿主显式声明过才写」
// 这个条件**（顶层没了之后还按条件写，宿主就分不清「成功」与「未声明」）。
//
// 于是本文件的判据只有一条：**逐形态比对新家的值与旧表达式会算出的值**。
// 期望值写在下面的表里、和实现无关（`legacyTopLevelSuccess` 那一列是按上面两个表达式**手算**
// 出来的停写前顶层值，不是从当前实现反推的）；`undefined` 表示停写前顶层根本没有这个键。
//
// 六种形态是工单点名的：成功 / 返回 Error / 抛异常 / 聚合 stub / judge 拦截 / 复放。
// 前四种走 executor settle（有值），后两种**从未执行**（没有值，宁缺不造）。

import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const DONE = { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" };

function toolRound(id, name = "work") {
  return { content: [{ type: "tool_use", id, name, input: { n: 1 } }], stopReason: "tool_use" };
}

/** 逐情形跑一次，交回事件流里那条 tool_result（观测点与 test/contract/tool-result-envelope.js 一致）。 */
async function runOnce(executeTool, { script = [toolRound("call-1"), DONE], options = {} } = {}) {
  const provider = createFakeProvider(script);
  const events = [];
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool,
    store: createMemoryTranscriptStore(),
    runId: `success-parity-${Math.random().toString(16).slice(2)}`,
    completion: false,
    ...options,
    // 规位：`onEvent` 与 `options` 可能带来的另一个 `hooks` 叶子必须落在**同一个**容器里。
    // 并列两个 `capabilities` 键是对象字面量重复键、后者静默胜（S7a 评审记过这个坑），
    // 这里显式合并 hooks，`options` 侧只覆盖同名叶子。
    capabilities: {
      ...options.capabilities,
      hooks: { onEvent: (event) => events.push(event), ...options.capabilities?.hooks },
    },
  });
  return events.filter((event) => event?.type === "tool_result").map((event) => event.toolResult);
}

/**
 * 迁移对照表。`legacyTopLevelSuccess` 一列是**停写前顶层 `success` 会是什么**（手算）：
 *   · `value.success ?? metadata.success ?? true` 再过 `success !== false`（`{content,…}` 与
 *     非结构化路径；非结构化路径不写 `metadata.success`，所以旧顶层**没有**这个键）；
 *   · `structured.success ?? true` 再过 `!== false`（遗留 `{data}` 路径总是写 `metadata.success`，
 *     所以旧顶层总有这个键）；
 *   · 返回 Error / 抛异常走 `metadata: {}`，旧顶层也没有这个键；
 *   · judge 拦截与复放不经 executor settle，旧顶层同样没有这个键。
 */
const MIGRATION_TABLE = [
  {
    name: "成功（string 返回）",
    executor: async () => "plain text",
    legacyTopLevelSuccess: undefined,   // 旧顶层无键；引擎表达式的值是 true
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "成功（number 返回）",
    executor: async () => 42,
    legacyTopLevelSuccess: undefined,
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "成功（{content,metadata,success:true}）",
    executor: async () => ({ content: "structured", metadata: { artifactStatus: "ok" }, success: true }),
    legacyTopLevelSuccess: true,        // 旧顶层写了 metadata.success = true
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "成功但未声明 success（{content}）",
    executor: async () => ({ content: "no verdict", metadata: { artifactStatus: "ok" } }),
    legacyTopLevelSuccess: undefined,   // 旧顶层无键；这正是「一律写」新增可见性的那一格
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "宿主显式 success:false",
    executor: async () => ({ content: "partial", success: false }),
    legacyTopLevelSuccess: false,
    expectedSuccess: false,
    expectIsError: true,
  },
  {
    name: "遗留 {data,success:true}",
    executor: async () => ({ data: "legacy payload", success: true, toolMessageId: "m-1" }),
    legacyTopLevelSuccess: true,
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "遗留 {data}（未声明 success，旧顶层被补成 true）",
    executor: async () => ({ data: "legacy payload" }),
    legacyTopLevelSuccess: true,        // structured.success ?? true
    expectedSuccess: true,
    expectIsError: false,
  },
  {
    name: "遗留 {data,success:false}",
    executor: async () => ({ data: "legacy payload", success: false }),
    legacyTopLevelSuccess: false,
    expectedSuccess: false,
    expectIsError: true,
  },
  {
    name: "返回 Error",
    executor: async () => new Error("executor said no"),
    legacyTopLevelSuccess: undefined,   // metadata 为 {}
    expectedSuccess: false,
    expectIsError: true,
  },
  {
    name: "抛异常（非 abort）",
    executor: async () => {
      throw new Error("executor threw");
    },
    legacyTopLevelSuccess: undefined,
    expectedSuccess: false,
    expectIsError: true,
  },
  {
    name: "非布尔 success（宿主写 0）：旧顶层是裸值 0，新家仍是归一化后的布尔",
    executor: async () => ({ content: "falsy verdict", success: 0 }),
    legacyTopLevelSuccess: 0,           // metadata.success = value.success（原样，未归一化）
    expectedSuccess: true,              // (0 !== false) === true：归一化口径与 erix.success 从 T1 起一致
    expectIsError: false,
  },
  {
    name: "onToolResult 改写钩子声明 success:false（两个通道取与）",
    executor: async () => ({ content: "fast", success: true }),
    onToolResult: async () => ({ content: "rewritten", success: false }),
    legacyTopLevelSuccess: false,       // 合并口径 execution.success && normalized.success
    expectedSuccess: false,
    expectIsError: true,
  },
  {
    name: "单轮聚合 stub 化（只换 content，不动成败）",
    executor: async () => ({ content: "巨".repeat(120000), metadata: { artifactStatus: "ok" } }),
    options: { context: { budgetTokens: 53337 }, outputHygiene: { limit: 1_000_000 } },
    legacyTopLevelSuccess: undefined,   // 未声明，且聚合层只替换 content
    expectedSuccess: true,
    expectIsError: false,
    stubbed: true,
  },
];

for (const entry of MIGRATION_TABLE) {
  test(`erix.success 迁移等价：${entry.name}`, async () => {
    const facts = await runOnce(entry.executor, {
      script: entry.script ?? [toolRound("call-1"), DONE],
      options: {
        ...(entry.options ?? {}),
        ...(entry.onToolResult === undefined
          ? {}
          : { capabilities: { hooks: { onToolResult: entry.onToolResult } } }),
      },
    });
    assert.equal(facts.length, 1, `本例必须恰好一条 tool_result，实测 ${facts.length} 条`);
    const fact = facts[0];
    if (entry.stubbed === true) {
      assert.match(fact.content, /预算/u, "本例必须真的走到聚合 stub，否则等于没测");
    }

    // 新家：值必须等于旧表达式的值（期望值来自本文件上面的表，不是从实现反推）。
    assert.equal(fact.erix.success, entry.expectedSuccess,
      `erix.success 必须等于停写前旧表达式会算出的值（旧顶层 = ${
        JSON.stringify(entry.legacyTopLevelSuccess)}）`);
    assert.equal(Object.hasOwn(fact.erix, "success"), true,
      "executed 结果一律写 erix.success：顶层停写后它是成败的唯一出口");
    // wire 侧的 is_error 口径不许被这次改动带动。
    assert.equal(fact.is_error, entry.expectIsError ? true : undefined);
    // 退役的那一半：旧顶层键必须真的没了，值只能从新家读到。
    // （上面那句 `expectedSuccess` 与下表 `legacyTopLevelSuccess` 的关系就是「迁移等价」本体：
    //   新家的值 == 旧表达式会算出的值；旧键从「等于手算旧值」换成「不得出现」就是这一刀。）
    assert.equal(fact.success, undefined,
      `顶层 success 已退役，值只能在 erix.success 读（旧顶层本应是 ${
        JSON.stringify(entry.legacyTopLevelSuccess)}）：实测 ${JSON.stringify(fact.success)}`);
  });
}

// —— 从未执行的两行：没有值才是对的（宁缺不造），与旧顶层同样无键对齐 ——

test("erix.success 迁移等价：judge 拦截（从未执行 ⇒ 没有 success，旧顶层同样没有）", async () => {
  const judgeProvider = {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      return {
        content: [{ type: "text", text: JSON.stringify({
          done: false, confidence: 0.8, reason: "方向可能偏", evidence: "证据不足",
        }) }],
        stopReason: "end_turn",
      };
    },
  };
  const executed = [];
  const facts = await runOnce(async ({ id }) => {
    executed.push(id);
    return "ok";
  }, {
    script: [toolRound("a1"), toolRound("a2"), DONE],
    options: {
      maxRounds: 8,
      reflection: {
        enabled: true, roundJudge: false, judgeIntervalRound: 1, judge: { provider: judgeProvider },
      },
    },
  });
  const intercepted = facts.find((fact) => fact.erix?.executionStatus === "intercepted");
  assert.ok(intercepted, `应有一条 intercepted 事实，实际：${JSON.stringify(facts.map((f) => f.erix))}`);
  assert.deepEqual(executed, ["a1"], "第二次调用应被拦截，本例必须真的走到拦截");
  assert.equal(Object.hasOwn(intercepted.erix, "success"), false,
    "没跑过的调用没有成败可言：不得为「一律写」把它编成 true");
  assert.deepEqual(intercepted.success, undefined, "顶层旧键同样不存在（迁移前后都是缺）");
});

test("erix.success 迁移等价：复放已完成结果 ⇒ 沿用原记录的值，不重算也不补写", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "success-parity-replay";
  const recorded = {
    type: "tool_result",
    tool_use_id: "done-1",
    content: "recorded before the crash",
    erix: { toolCallKey: "tc_1234567890ab", round: 3, durationMs: 777, success: false },
  };
  await store.appendRound(runId, { round: 0, messages: [{ role: "user", content: "task" }] });
  await store.saveCheckpoint(runId, {
    round: 3,
    pendingToolUses: [{ type: "tool_use", id: "done-1", name: "work", input: {} }],
    messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_use", id: "done-1", name: "work", input: {}, erix: { toolCallKey: "tc_1234567890ab" } }] },
    ],
    executedToolIds: ["done-1"],
    toolResults: [{ toolUseId: "done-1", toolResult: recorded }],
  });

  let calls = 0;
  const events = [];
  await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "done-1", name: "work", input: {} }], stopReason: "tool_use" },
      DONE,
    ]),
    resume: true,
    store,
    runId,
    completion: false,
    executeTool: async () => {
      calls += 1;
      return "must not execute again";
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.equal(calls, 0, "复放路径不得二次执行 executor");
  const replayed = events.filter((event) => event?.type === "tool_result")
    .map((event) => event.toolResult)
    .find((fact) => fact.tool_use_id === "done-1");
  assert.ok(replayed, "应发出复放的 tool_result 事件");
  assert.equal(replayed.erix.success, false,
    "崩溃前写下的 false 必须原样带回：复放不重算，也不把「这次没跑」当成成功");
  assert.equal(replayed.success, undefined, "顶层旧键不在复放路径上被补出来（旧记录本来写了什么的，原样保留）");
});
