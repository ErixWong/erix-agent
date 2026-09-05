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

test("judge runs on non-tool rounds only, with reasoning disabled (tool rounds skipped)", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }), // tool 轮：不调 judge
    { content: [{ type: "text", text: "干完了" }], stopReason: "end_turn" }, // end_turn：调 judge
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "产物就绪" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  // tool_use 轮不调 judge；仅 end_turn 轮调 1 次 → judge_done 停
  assert.equal(judge.requests.length, 1);
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
  // 工具调用未达到默认审计阈值，模型活到 end_turn 输出文本 → end_turn 轮才 judge_done
  assert.deepEqual(result.termination, { reason: "judge_done" });
  assert.equal(result.rounds, 2);
  // 关键断言：主模型第二次调用存在（end_turn 文本轮发生了）
  assert.equal(provider.requests.length, 2);
});

test("not-done round judge evidence is injected into the next user request", async () => {
  // round 1 tool 干活；round 2 end_turn（judge 判 done:false）→ evidence 注入 round 3 请求
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" }, // round 2: judge 打回
    { content: [{ type: "tool_use", id: "w2", name: "work", input: { round: 3 } }], stopReason: "tool_use" }, // round 3: 收到 evidence 后继续干
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "期望 377，实际 104" }),
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  // round 3 请求（provider.requests[2]）的 user 消息含 judge evidence
  const round3Request = provider.requests[2];
  const lastText = round3Request.messages.at(-1).content
    .filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.match(lastText, /期望 377，实际 104/);
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

test("tool-use rounds get transparent interception without preempting prior work", async () => {
  // 前 5 次工具调用照常执行，第 6 次先审计；拦截不影响模型自然收尾
  const provider = createFakeProvider([
    toolResponse("t1", "work", { round: 1 }),
    toolResponse("t2", "work", { round: 2 }),
    toolResponse("t3", "work", { round: 3 }),
    toolResponse("t4", "work", { round: 4 }),
    toolResponse("t5", "work", { round: 5 }),
    toolResponse("t6", "work", { round: 6 }), // 第 6 次调用触发透明审计
    { content: [{ type: "text", text: "任务完成" }], stopReason: "end_turn" }, // 模型自然收尾
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "在写 microsim 而非 gates.txt" }),
    judgeResponse({ done: true, confidence: 0.9, reason: "确认完成", evidence: "允许收尾" }),
  ]);
  const executed = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.round);
      return "ok";
    },
    maxRounds: 30,
    completion: false,
    reflection: { enabled: true, judgeIntervalRound: 5, judge: { provider: judge } },
  });
  // 第 6 次调用被拦截；随后 end_turn judge 独立完成最终判定
  assert.equal(judge.requests.length, 2);
  assert.equal(result.rounds, 7);
  assert.deepEqual(executed, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.termination, { reason: "judge_done" });
});

test("transparent interception returns correction evidence without executing the tool", async () => {
  const provider = createFakeProvider([
    toolResponse("t1", "work", { round: 1 }),
    toolResponse("t2", "work", { round: 2 }),
    toolResponse("t3", "work", { round: 3 }),
    toolResponse("t4", "work", { round: 4 }),
    toolResponse("t5", "work", { round: 5 }),
    toolResponse("t6", "work", { round: 6 }), // 第 6 次调用触发审计
    { content: [{ type: "text", text: "收到，改方向" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "写 microsim 而非 gates.txt" }),
  ]);
  const executed = [];
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.round);
      return "ok";
    },
    maxRounds: 20,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 5,
      judge: { provider: judge },
    },
  });
  assert.deepEqual(executed, [1, 2, 3, 4, 5]);
  const text = provider.requests.at(-1).messages.flatMap((m) => m.content ?? [])
    .filter((b) => b.type === "tool_result").map((b) => b.content).join("");
  assert.match(text, /【审计拦截】方向可能偏/);
  assert.match(text, /写 microsim 而非 gates\.txt/);
});

test("transparent interception releases the exact cached tool call when approved", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "writeFile", { path: "result.txt", content: "42" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "方向正确", evidence: "目标一致" }),
  ]);
  const calls = [];
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async (options) => {
      calls.push(options);
      return "ok";
    },
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
  });

  assert.equal(judge.requests.length, 1);
  assert.deepEqual(calls.map(({ id, name, input }) => ({ id, name, input })), [
    { id: "first", name: "work", input: { step: 1 } },
    { id: "second", name: "writeFile", input: { path: "result.txt", content: "42" } },
  ]);
});

test("transparent interception degrades to direct execution when the judge fails", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{ throw: new Error("judge unavailable") }]);
  const executed = [];
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.step);
      return "ok";
    },
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
  });

  assert.deepEqual(executed, [1, 2]);
  assert.equal(judge.requests.length, 1);
});

test("transparent interception degrades to direct execution on timeout", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const requests = [];
  const judge = {
    requests,
    async chat(request) {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return judgeResponse({ done: false, confidence: 1, reason: "late", evidence: "late" });
    },
  };
  const executed = [];
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.step);
      return "ok";
    },
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judgeInterceptTimeoutMs: 5,
      judge: { provider: judge },
    },
  });

  assert.deepEqual(executed, [1, 2]);
  assert.equal(judge.requests.length, 1);
});

test("transparent interception resets its counter after an audit", async () => {
  // 关闭 wrapup 归一化（它与 intercept 共用 judge provider，会干扰计数断言）
  // 确保 wrapup 归一化关闭（代码读 ERIX_WRAPUP_NORMALIZE，非 "1" 即关）——避免纯文本 end_turn 触发归一化消耗共享 judge provider
  const prev = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_WRAPUP_NORMALIZE = "";
  try {
    const provider = createFakeProvider([
      toolResponse("first", "work", { step: 1 }),
      toolResponse("second", "work", { step: 2 }),
      toolResponse("third", "work", { step: 3 }),
      { content: [{ type: "text", text: '{"done":true,"output":"收尾"}' }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([
      judgeResponse({ done: true, confidence: 0.9, reason: "继续", evidence: "仍在目标方向" }),
    ]);
    const executed = [];
    await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async ({ input }) => {
        executed.push(input.step);
        return "ok";
      },
      maxRounds: 5,
      completion: false,
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: judge },
      },
    });

    assert.deepEqual(executed, [1, 2, 3]);
    // judgeIntervalRound=1: 工具1 计数到 1，工具2 拦截审计（重置），工具3 不再拦截 → 仅 1 次 judge
    assert.equal(judge.requests.length, 1);
  } finally {
    if (prev === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = prev;
  }
});
