import test from "node:test";
import assert from "node:assert/strict";

import { parseReflectionDecision, runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function toolResponse(round) {
  return {
    content: [{
      type: "tool_use",
      id: `tool-${round}`,
      name: `work-${round}`,
      input: { round },
    }],
    stopReason: "tool_use",
  };
}

function judgeResponse(fields) {
  return {
    content: [{ type: "text", text: JSON.stringify(fields) }],
    stopReason: "end_turn",
  };
}

test("parseReflectionDecision accepts JSON, markdown JSON, and text fallback", () => {
  assert.deepEqual(
    parseReflectionDecision(JSON.stringify({
      progress: 70,
      stalled: false,
      continue: true,
      stallPattern: "",
      reason: "有新产物",
      plan: "运行测试",
    })),
    {
      progress: 70,
      stalled: false,
      continueFlag: true,
      stallPattern: "",
      reason: "有新产物",
      plan: "运行测试",
    },
  );
  assert.equal(
    parseReflectionDecision("```json\n{\"continue\":false,\"progress\":95}\n```").continueFlag,
    false,
  );
  assert.deepEqual(
    parseReflectionDecision("最近一直重复尝试，停止吧"),
    {
      progress: undefined,
      stalled: true,
      continueFlag: false,
      stallPattern: "",
      reason: "最近一直重复尝试，停止吧",
      plan: "",
    },
  );
});

test("reflection extends the budget and injects the plan into the next task request", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 7 }, (_value, index) => toolResponse(index + 1)),
    { content: [{ type: "text", text: "阶段结论" }], stopReason: "end_turn" },
    ...Array.from({ length: 3 }, (_value, index) => toolResponse(index + 9)),
    { content: [{ type: "text", text: "最终结论" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "仍有价值",
      evidence: "还有验证工作",
      direction: "on_track",
      extend: true,
      extendReason: "当前上限不足",
      plan: "做X",
    }),
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已验证" }),
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "完成一个重要任务",
    executeTool: async () => "ok",
    maxRounds: 10,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      extensionStep: 2,
      maxExtensions: 1,
      maxRoundsCap: 12,
      judge: { provider: judge },
    },
  });

  assert.equal(result.rounds, 12);
  assert.equal(result.truncated, false);
  assert.match(
    provider.requests[8].messages.at(-1).content[0].text,
    /下一步：做X/,
  );
  assert.match(judge.requests[0].messages[0].content[0].text, /extend=true/);
  assert.equal(
    result.messages.some((message) => (
      message.content?.[0]?.text?.includes("进度反思")
    )),
    false,
  );
});

test("default extension step scales with maxRounds instead of a fixed +32 (issue #127)", async () => {
  // 默认步长改按比例：16 轮的任务一次扩 8 轮（max(8, 16*0.5)），而不是一口气加到 48
  const provider = createFakeProvider([
    ...Array.from({ length: 11 }, (_value, index) => toolResponse(index + 1)),
    { content: [{ type: "text", text: "阶段结论" }], stopReason: "end_turn" },
    ...Array.from({ length: 11 }, (_value, index) => toolResponse(index + 13)),
    { content: [{ type: "text", text: "最终结论" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "仍有价值",
      evidence: "还有工作",
      extend: true,
      extendReason: "当前上限不足",
      plan: "继续做",
    }),
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已验证" }),
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "完成一个重要任务",
    executeTool: async () => "ok",
    maxRounds: 16,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      maxExtensions: 1,
      judge: { provider: judge },
    },
  });

  // 16 + max(8, 16*0.5) = 24；若还是旧的固定 +32 则会跑到 48
  assert.equal(result.rounds, 24);
  assert.equal(result.truncated, false);
  assert.equal(result.termination.reason, "judge_done");
});

test("judge can stop before the hard round limit without truncation", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 7 }, (_value, index) => toolResponse(index + 1)),
    { content: [{ type: "text", text: "阶段完成" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "已完成", evidence: "已完成" }),
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "完成任务",
    executeTool: async () => "ok",
    maxRounds: 10,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      judge: { provider: judge },
    },
  });

  assert.equal(result.rounds, 8);
  assert.equal(result.truncated, false);
  assert.equal(provider.requests.length, 8);
});

test("stalled judge extension injects a change-of-approach instruction", async () => {
  const provider = createFakeProvider([
    toolResponse(1),
    { content: [{ type: "text", text: "阶段结论" }], stopReason: "end_turn" },
    toolResponse(3),
    { content: [{ type: "text", text: "最终结论" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "重复旧方法",
      evidence: "没有新进展",
      direction: "off_track",
      extend: true,
      extendReason: "重复旧方法",
      plan: "改用另一种方法",
    }),
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已完成" }),
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "解决问题",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      extensionStep: 1,
      maxExtensions: 1,
      maxRoundsCap: 4,
      judge: { provider: judge },
    },
  });

  assert.equal(result.rounds, 4);
  assert.match(
    provider.requests[2].messages.at(-1).content[0].text,
    /检测到可能打转：重复旧方法。请换思路：改用另一种方法/,
  );
});

test("reflection remains disabled by default", async () => {
  const provider = createFakeProvider([
    toolResponse(1),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "短任务",
    executeTool: async () => "ok",
    maxRounds: 2,
  });

  assert.equal(provider.requests.length, 2);
  assert.equal(result.rounds, 2);
  assert.equal(result.truncated, true);
});

test("stores and strips an inline L1 summary", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([{
    content: [{
      type: "text",
      text: "完成了本轮 <erix-summary>{\"action\":\"implement\",\"note\":\"新增治理\"}</erix-summary>",
    }],
    stopReason: "end_turn",
  }]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "实现任务",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: false,
    store,
    runId: "summary-run",
  });
  const record = (await store.load("summary-run")).find((entry) => entry.round === 1);
  assert.deepEqual(record.summary, { action: "implement", note: "新增治理" });
  assert.equal(record.messages[0].content[0].text, "完成了本轮 ");
  assert.equal(result.finalText, "完成了本轮 ");
});

test("missing inline summaries downgrade to missing without retrying", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([{
    content: [{ type: "text", text: "没有标记" }],
    stopReason: "end_turn",
  }]);
  await runToolLoop({
    provider,
    initialUserMessage: "任务",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    store,
    runId: "missing-summary-run",
  });
  const record = (await store.load("missing-summary-run")).find((entry) => entry.round === 1);
  assert.equal(record.summary, "missing");
  assert.equal(provider.requests.length, 1);
});

test("memory loss is nudged in the same round and resets no-tool streak", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 6 }, (_value, index) => toolResponse(index + 1)),
    { content: [{ type: "text", text: "你好，我是你的助手。" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "恢复任务" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "继续做事",
    executeTool: async () => "ok",
    maxRounds: 8,
    completion: false,
  });
  assert.equal(result.rounds, 8);
  assert.ok(provider.requests[7].messages.some((message) => (
    message.content?.some((block) => /任务仍在进行/.test(block.text ?? ""))
  )));
});

test("resume judge sees the rebuilt L1 and L0 evidence", async () => {
  const store = createMemoryTranscriptStore();
  await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "resume-tool", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{
          type: "text",
          text: "继续 <erix-summary>{\"action\":\"work\",\"note\":\"出现错误\"}</erix-summary>",
        }],
        stopReason: "end_turn",
      },
    ]),
    initialUserMessage: "resume task",
    executeTool: async () => {
      throw new Error("resume error");
    },
    maxRounds: 2,
    completion: false,
    store,
    runId: "governor-resume",
  });
  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "round three" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.5,
      reason: "继续",
      evidence: "还需工作",
      extend: false,
      extendReason: "无需扩轮",
      plan: "收敛",
    }),
  ]);
  await runToolLoop({
    provider: resumedProvider,
    initialUserMessage: "ignored",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: true,
      judgeIntercept: false,
      judge: { provider: judge },
    },
    store,
    runId: "governor-resume",
    resume: true,
  });
  assert.match(judge.requests[0].messages[0].content[0].text, /resume error/);
  assert.match(judge.requests[0].messages[0].content[0].text, /resume/);
});

test("continuation exhaustion stops before reflection can extend", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "partial" }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "{\"continue\":true,\"plan\":\"more\"}" }] },
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "limited",
    executeTool: async () => "unused",
    maxRounds: 1,
    maxTokenContinuations: 0,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false, judgeIntercept: false,
      maxExtensions: 1,
    },
  });
  assert.equal(result.truncated, true);
  assert.equal(provider.requests.length, 2);
});
