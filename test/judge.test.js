import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJudgePrompt,
  buildTimeline,
  parseJudgeDecision,
} from "../src/reflection/judge.js";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function toolResponse(id, name, input) {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}

function judgeResponse(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("buildTimeline extracts tool arguments and paired verification output", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "task" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "exec-1", name: "exec", input: { command: "./sim 208" } },
        { type: "tool_use", id: "write-1", name: "writeFile", input: { path: "gates.txt", content: "x" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "exec-1", content: "104" },
        { type: "tool_result", tool_use_id: "write-1", content: "exit 0（无输出）" },
      ],
    },
  ];

  assert.deepEqual(buildTimeline(messages, 1), {
    toolCalls: [
      { name: "exec", arg: "./sim 208", output: "104" },
      { name: "writeFile", arg: "gates.txt", output: "exit 0（无输出）" },
    ],
    outputs: [],
    exitOk: true,
    errors: [],
    errorRepeat: 0,
  });
});

test("buildJudgePrompt includes the recent timeline, files, and errors", () => {
  const prompt = buildJudgePrompt(
    "generate gates",
    3,
    [{
      round: 3,
      toolCalls: [{ name: "exec", arg: "./sim 208", output: "104" }],
    }],
    [{ path: "gates.txt", round: 3 }],
    ["expected 377, got 104"],
  );

  assert.match(prompt, /任务目标：generate gates/);
  assert.match(prompt, /R3: exec \.\/sim 208; 输出: 104/);
  assert.match(prompt, /gates\.txt\(R3\)/);
  assert.match(prompt, /expected 377, got 104/);
  assert.match(prompt, /"confidence":0-1/);
});

test("parseJudgeDecision accepts clean and noisy JSON and rejects invalid output", () => {
  assert.deepEqual(
    parseJudgeDecision('```json\n{"done":true,"confidence":0.9,"reason":"完成","evidence":"测试通过"}\n```'),
    { done: true, confidence: 0.9, reason: "完成", evidence: "测试通过" },
  );
  assert.deepEqual(
    parseJudgeDecision('评审结果：{"done":false,"confidence":0.2,"reason":"缺文件","evidence":"无 gates"}'),
    { done: false, confidence: 0.2, reason: "缺文件", evidence: "无 gates" },
  );
  assert.equal(parseJudgeDecision("不是 JSON"), null);
  assert.equal(parseJudgeDecision('{"done":"true","confidence":1}'), null);
});

test("round judge runs every enabled round with reasoning disabled", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    toolResponse("main-2", "work", { round: 2 }),
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.2, reason: "继续", evidence: "还缺验证" }),
    judgeResponse({ done: false, confidence: 0.2, reason: "继续", evidence: "还缺验证" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  assert.equal(judge.requests.length, 2);
  assert.equal(judge.requests[0].reasoning_effort, "none");
  assert.equal(judge.requests[0].maxTokens, 8000);
  assert.equal(judge.requests[0].temperature, 0);
});

test("high-confidence judge completion on an end-turn round stops with judge_done", async () => {
  // 模型先干活（tool_use），随后 end_turn 给结论 → judge 判 done 才终止
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "结果 42" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    // tool_use 轮 judge（方向检查，done 不触发停止）
    judgeResponse({ done: true, confidence: 0.9, reason: "已完成", evidence: "验证通过" }),
    // end_turn 轮 judge（允许完成判定）
    judgeResponse({ done: true, confidence: 0.9, reason: "已完成", evidence: "验证通过" }),
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: { maxNoToolRounds: 3 },
    reflection: { enabled: true, judge: { provider: judge } },
  });

  assert.deepEqual(result.termination, { reason: "judge_done" });
  assert.equal(result.rounds, 2);
  assert.equal(provider.requests.length, 2);
});

test("tool-use round judge done does not preempt the model's own wind-down (real-run regression)", async () => {
  // 实测 bug：模型 exec echo hello 后 judge 判 done 抢停，模型没机会输出最终文本
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "echo 输出 hello" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 1.0, reason: "已运行", evidence: "有输出" }), // tool_use 轮: done 不触发停止
    judgeResponse({ done: true, confidence: 1.0, reason: "已运行且模型收尾", evidence: "有输出" }), // end_turn 轮: 允许 judge_done
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: { maxNoToolRounds: 3 },
    reflection: { enabled: true, judge: { provider: judge } },
  });
  // tool_use 轮 judge done:true 未抢停（模型活到 end_turn 输出文本）→ end_turn 轮才 judge_done
  assert.deepEqual(result.termination, { reason: "judge_done" });
  assert.equal(result.rounds, 2);
  // 关键断言：主模型第二次调用存在（end_turn 文本轮发生了，未被 tool_use 轮 judge 抢停）
  assert.equal(provider.requests.length, 2);
});

test("not-done round judge evidence is injected into the next user request", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "继续" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "期望 377，实际 104" }),
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已修正" }),
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  assert.match(
    provider.requests[1].messages.at(-1).content[0].text,
    /期望 377，实际 104/,
  );
});

test("round judge errors degrade to the existing loop path", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{ throw: new Error("judge unavailable"), times: 20 }]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(provider.requests.length, 2);
});

test("reflection false does not call the round judge", async () => {
  const provider = createFakeProvider([{
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
  }]);
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: false,
  });

  assert.equal(provider.requests.length, 1);
});

test("round judge decisions are persisted in round records", async () => {
  const store = createMemoryTranscriptStore();
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "交付", evidence: "产物存在" }),
  ]);
  await runToolLoop({
    provider: createFakeProvider([{
      content: [{ type: "text", text: "完成" }],
      stopReason: "end_turn",
    }]),
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    store,
    runId: "judge-record",
  });

  const record = (await store.load("judge-record")).find((entry) => entry.round === 1);
  assert.deepEqual(record.judge, {
    done: true,
    confidence: 0.9,
    reason: "交付",
    evidence: "产物存在",
  });
});

test("low-confidence done falls back to existing logic, no deadlock (reviewer P2#1)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: '{"done":true,"summary":"完成","output":"结果"}' }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    { content: [{ type: "text", text: '{"done":true,"confidence":0.5,"reason":"低置信"}' }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });
  // conf<0.7: 不走 judge_done；end_turn 无工具 → 正常 complete 停，不死锁
  assert.notEqual(result.termination.reason, "judge_done");
  assert.ok(result.rounds <= 2);
});

test("judge disables after consecutive failures reaching the limit (reviewer P2#2)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "w1", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{ throw: new Error("boom"), times: 20 }]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: { signals: [], maxNoToolRounds: 3 },
    reflection: { enabled: true, judgeFailureLimit: 2, judge: { provider: judge } },
  });
  // judge 失败 2 次后关闭 → judge.requests 停在 2，后续轮不再调
  assert.equal(judge.requests.length, 2);
  assert.ok(result.rounds >= 2);
  assert.ok(["end_turn", "no_tool"].includes(result.termination.reason));
});

test("ERIX_NO_ROUND_JUDGE env disables the round judge (reviewer P2#3)", async () => {
  const prev = process.env.ERIX_NO_ROUND_JUDGE;
  process.env.ERIX_NO_ROUND_JUDGE = "1";
  try {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([{ content: [{ type: "text", text: '{"done":true,"confidence":0.9}' }], stopReason: "end_turn" }]);
    await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 2,
      completion: false,
      reflection: { enabled: true, judge: { provider: judge } },
    });
    // round judge 关闭（其请求特征 reasoning_effort:'none'）；legacy callReflection 仍可能调 judge（nearLimit）——用特征区分
    const roundJudgeCalls = judge.requests.filter((r) => r.reasoning_effort === "none").length;
    assert.equal(roundJudgeCalls, 0);
  } finally {
    if (prev === undefined) delete process.env.ERIX_NO_ROUND_JUDGE;
    else process.env.ERIX_NO_ROUND_JUDGE = prev;
  }
});

test("buildTimeline pairs outputs by tool_use_id even when results arrive out of order (reviewer)", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "task" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "exec", input: { command: "./sim 208" } },
        { type: "tool_use", id: "b", name: "writeFile", input: { path: "g.txt", content: "x" } },
        { type: "tool_use", id: "c", name: "exec", input: { command: "./sim 20000" } },
      ],
    },
    {
      role: "user",
      content: [
        // b 的结果先到，然后 a、c —— 乱序
        { type: "tool_result", tool_use_id: "b", content: "written" },
        { type: "tool_result", tool_use_id: "c", content: "10000" },
        { type: "tool_result", tool_use_id: "a", content: "104" },
      ],
    },
  ];

  const result = buildTimeline(messages, 1);
  // 输出按 tool_use_id 配对到正确调用，不因结果乱序错配
  const sim208 = result.toolCalls.find((c) => c.arg === "./sim 208");
  const sim20000 = result.toolCalls.find((c) => c.arg === "./sim 20000");
  const write = result.toolCalls.find((c) => c.arg === "g.txt");
  assert.equal(sim208.output, "104");
  assert.equal(sim20000.output, "10000");
  assert.equal(write.output, "written");
});
