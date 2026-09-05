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
      { name: "exec", arg: "./sim 208" },
      { name: "writeFile", arg: "gates.txt" },
    ],
    outputs: [
      { cmd: "./sim 208", output: "104" },
      { cmd: "writeFile", output: "exit 0（无输出）" },
    ],
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
      toolCalls: [{ name: "exec", arg: "./sim 208" }],
      outputs: [{ cmd: "./sim 208", output: "104" }],
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

test("high-confidence round judge completion stops with judge-done", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    toolResponse("main-2", "work", { round: 2 }),
  ]);
  const judge = createFakeProvider([
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

  assert.deepEqual(result.termination, { reason: "judge-done" });
  assert.equal(result.rounds, 1);
  assert.equal(provider.requests.length, 1);
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
  assert.deepEqual(record.judge, { done: true, confidence: 0.9, reason: "交付" });
});
