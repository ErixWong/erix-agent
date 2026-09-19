import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJudgePrompt,
  buildTimeline,
  parseJudgeDecision,
  renderConversation,
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

function writeFileResponse(round, path = `file-${round}.txt`) {
  return toolResponse(`write-${round}`, "writeFile", { path, content: "x" });
}

function judgeResponse(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("buildTimeline extracts tool arguments and result statuses", () => {
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
      { name: "exec", arg: "./sim 208", status: "ok" },
      { name: "writeFile", arg: "gates.txt", status: "ok" },
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
  assert.match(prompt, /R3: exec \.\/sim 208 \[pending\]/);
  assert.doesNotMatch(prompt, /输出: 104/);
  assert.match(prompt, /gates\.txt\(R3\)/);
  assert.match(prompt, /expected 377, got 104/);
  assert.match(prompt, /"confidence":0-1/);
  assert.match(prompt, /"direction":"on_track\|uncertain\|off_track"/);
  assert.match(prompt, /direction 只是提示，不影响 done/);
});

test("buildTimeline labels errors, interceptions, pending calls, and repeated parameters", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "exec", input: { command: "npm test" } },
        { type: "tool_use", id: "b", name: "exec", input: { command: "npm test" } },
        { type: "tool_use", id: "c", name: "writeFile", input: { path: "out.txt", content: "x" } },
        { type: "tool_use", id: "d", name: "readFile", input: { path: "missing.txt" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", is_error: true, content: "failed" },
        { type: "tool_result", tool_use_id: "b", is_error: true, content: "failed" },
        {
          type: "tool_result",
          tool_use_id: "c",
          executionStatus: "intercepted",
          content: "【审计拦截】未执行",
        },
      ],
    },
  ];

  assert.deepEqual(buildTimeline(messages).toolCalls, [
    { name: "exec", arg: "npm test", status: "error" },
    { name: "exec", arg: "npm test", status: "error" },
    { name: "writeFile", arg: "out.txt", status: "intercepted" },
    { name: "readFile", arg: "missing.txt", status: "pending" },
  ]);
  assert.equal(buildTimeline(messages).errorRepeat, 2);
  assert.match(
    buildJudgePrompt("task", 1, [{ round: 1, ...buildTimeline(messages) }]),
    /R1: exec npm test \[error，重复第2次\]/,
  );
});

test("counts configured write tools and extracts file_path for judge filesWritten", async () => {
  const provider = createFakeProvider([
    toolResponse("write-1", "fs_write", { file_path: "custom.txt", contents: "x" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    { content: [{ type: "text", text: JSON.stringify({
      done: true,
      confidence: 1,
      reason: "done",
      evidence: "written",
    }) }] },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "write one file",
    executeTool: async () => "written",
    maxRounds: 2,
    completion: false,
    writeToolNames: ["fs_write"],
    writeToolPathKeys: ["file_path"],
    reflection: {
      enabled: true,
      judgeIntercept: false,
      maxExtensions: 0,
      judge: { provider: judge },
    },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.match(prompt, /custom\.txt\(R1\)/);
});

test("loop keeps at most the latest 50 distinct written files for the judge", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 100 }, (_value, index) => writeFileResponse(index + 1)),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 1, reason: "done", evidence: "done" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "write files",
    executeTool: async () => "written",
    maxRounds: 101,
    completion: false,
    stallDetection: false,
    reflection: {
      enabled: true,
      judgeIntercept: false,
      maxExtensions: 0,
      judge: { provider: judge },
    },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  const writtenFiles = prompt.split("写过的文件：")[1].split("\n最近验证输出：")[0];
  const entries = writtenFiles.split(", ").filter(Boolean);
  assert.equal(entries.length, 50);
  assert.match(writtenFiles, /file-100\.txt\(R100\)/);
  assert.doesNotMatch(writtenFiles, /file-50\.txt\(R50\)/);
});

test("loop keeps only the latest entry when a file is written repeatedly", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 100 }, (_value, index) => writeFileResponse(index + 1, "same.txt")),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 1, reason: "done", evidence: "done" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "rewrite one file",
    executeTool: async () => "written",
    maxRounds: 101,
    completion: false,
    stallDetection: false,
    reflection: {
      enabled: true,
      judgeIntercept: false,
      maxExtensions: 0,
      judge: { provider: judge },
    },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  const writtenFiles = prompt.split("写过的文件：")[1].split("\n最近验证输出：")[0];
  assert.equal(writtenFiles, "same.txt(R100)");
});

test("parseJudgeDecision accepts clean and noisy JSON and rejects invalid output", () => {
  assert.deepEqual(
    parseJudgeDecision('```json\n{"done":true,"confidence":0.9,"reason":"完成","evidence":"测试通过"}\n```'),
    {
      done: true,
      confidence: 0.9,
      reason: "完成",
      evidence: "测试通过",
      direction: undefined,
      directionReason: "",
    },
  );
  assert.deepEqual(
    parseJudgeDecision('评审结果：{"done":false,"confidence":0.2,"reason":"缺文件","evidence":"无 gates","direction":"off_track","directionReason":"反复调试同一实现"}'),
    {
      done: false,
      confidence: 0.2,
      reason: "缺文件",
      evidence: "无 gates",
      direction: "off_track",
      directionReason: "反复调试同一实现",
    },
  );
  assert.equal(parseJudgeDecision("不是 JSON"), null);
  assert.equal(parseJudgeDecision('{"done":"true","confidence":1}'), null);
});

test("parseJudgeDecision ignores invalid direction values while preserving compatibility", () => {
  assert.deepEqual(
    parseJudgeDecision('{"done":true,"confidence":0.8,"direction":"sideways","directionReason":42}'),
    {
      done: true,
      confidence: 0.8,
      reason: "",
      evidence: "",
      direction: undefined,
      directionReason: "",
    },
  );
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

test("round judge emits an onJudge decision event", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
  ]);
  const judgeDecision = {
    done: true,
    confidence: 0.9,
    reason: "已完成",
    evidence: "验证通过",
    direction: "on_track",
    directionReason: "已接近验证",
  };
  const judge = createFakeProvider([judgeResponse(judgeDecision)]);
  const events = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    round: 1,
    kind: "round",
    decision: judgeDecision,
    action: "judge_done",
  }]);
});

test("onJudge callback errors do not abort the loop", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "通过" }),
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: () => {
      throw new Error("observer failed");
    },
  });

  assert.deepEqual(result.termination, { reason: "judge_done" });
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
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
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

test("off-track round judge nudge includes the direction hint", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "继续处理" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "还未完成",
      evidence: "验证输出不符合目标",
      direction: "off_track",
      directionReason: "持续反复调试同一实现细节",
    }),
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 2,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const continuation = provider.requests[1].messages.at(-1).content
    .filter((block) => block.type === "text").map((block) => block.text).join("");
  assert.match(continuation, /方向提示：持续反复调试同一实现细节/);
});

test("renderConversation keeps the task and the latest answer, and labels pending/intercepted calls", () => {
  const text = renderConversation([
    { role: "user", content: [{ type: "text", text: "任务：只读分析，输出问题清单" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "readFile", input: { path: "AGENTS.md" } },
      { type: "tool_use", id: "t2", name: "exec", input: { command: "ls" } },
      { type: "tool_use", id: "t3", name: "tree", input: { path: "." } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容" }] },
    { role: "user", content: [{
      type: "tool_result",
      tool_use_id: "t2",
      executionStatus: "intercepted",
      content: "【审计拦截】方向可能偏: x/y。原工具调用未执行。",
    }] },
    { role: "assistant", content: [{ type: "text", text: "问题清单：1. 回滚资产失效" }] },
  ]);
  assert.match(text, /任务：只读分析/);
  assert.match(text, /问题清单：1\. 回滚资产失效/);
  assert.match(text, /工具结果\n文件内容/);
  assert.match(text, /控制事件（该工具调用未执行）/);
  // 未执行的调用不能被当成已执行
  assert.match(text, /tree（本轮尚未执行，等待结果）/);
});

test("renderConversation excludes judge-control messages", () => {
  const text = renderConversation([
    { role: "user", content: [{ type: "text", text: "真实任务" }] },
    { role: "user", meta: { source: "judge-control" }, content: [{ type: "text", text: "【Judge 评审意见】继续" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "工具输出原文" }] },
    { role: "assistant", content: [{ type: "text", text: "最新答复" }] },
  ]);
  assert.doesNotMatch(text, /Judge 评审意见/);
  assert.match(text, /工具输出原文/);
});

test("renderConversation always keeps the task and latest answer under a tiny budget", () => {
  const filler = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `中间内容 ${index} ${"x".repeat(200)}` }],
  }));
  const text = renderConversation([
    { role: "user", content: [{ type: "text", text: "任务原文：只读分析" }] },
    ...filler,
    { role: "assistant", content: [{ type: "text", text: "最终交付：问题清单已完成" }] },
  ], { maxTokens: 60 });
  assert.match(text, /任务原文：只读分析/);
  assert.match(text, /最终交付：问题清单已完成/);
  assert.match(text, /省略/);
});

test("buildJudgePrompt appends the untrusted conversation section only when provided", () => {
  const without = buildJudgePrompt("task", 1, [], [], []);
  assert.doesNotMatch(without, /完整对话记录/);
  assert.match(without, /若方向错误、关键产物缺失或验证输出不符合目标/);
  const withConversation = buildJudgePrompt("task", 1, [], [], [], "### user\n只读分析");
  assert.match(withConversation, /完整对话记录（原始材料/);
  assert.match(withConversation, /### user\n只读分析/);
});

test("round judge sees the inline deliverable in the full conversation", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "问题清单：1. 回滚资产失效 2. 端口暴露" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "已交付清单", evidence: "对话中已给出清单" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "只做只读分析，输出问题清单，不要修改任何文件",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.match(prompt, /问题清单：1\. 回滚资产失效 2\. 端口暴露/);
  assert.match(prompt, /不能因为“没有写过文件”判 done=false/);
});

test("round judge fallback uses the latest non-empty user task from a multi-turn entry", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialMessages: [
      { role: "user", content: "请用一句话介绍你自己" },
      { role: "assistant", content: "我是助手" },
      { role: "user", content: "哈罗" },
      { role: "assistant", content: "你好" },
      { role: "user", content: "新任务：在当前任务目录创建一个俄罗斯方块网页游戏，网页版的。" },
    ],
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  const taskLine = prompt.match(/任务目标：([^\n]*)/)?.[1] ?? "";
  assert.match(taskLine, /俄罗斯方块/);
  assert.doesNotMatch(taskLine, /介绍你自己/);
  // 早期对话按设计进入完整记录
  assert.match(prompt, /完整对话记录（原始材料/);
});

test("explicit task overrides the multi-turn entry messages for the round judge", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialMessages: [
      { role: "user", content: "请用一句话介绍你自己" },
      { role: "assistant", content: "我是助手" },
      { role: "user", content: "哈罗" },
      { role: "assistant", content: "你好" },
      { role: "user", content: "新任务：在当前任务目录创建一个俄罗斯方块网页游戏，网页版的。" },
    ],
    task: "全新任务：写一个俄罗斯方块网页游戏",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  const taskLine = prompt.match(/任务目标：([^\n]*)/)?.[1];
  assert.equal(taskLine, "全新任务：写一个俄罗斯方块网页游戏");
  assert.doesNotMatch(taskLine, /介绍你自己/);
});

test("context.task takes precedence over the multi-turn entry messages for the round judge", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialMessages: [
      { role: "user", content: "请用一句话介绍你自己" },
      { role: "assistant", content: "我是助手" },
      { role: "user", content: "新任务：在当前任务目录创建一个俄罗斯方块网页游戏，网页版的。" },
    ],
    context: { task: "CTX任务摘要" },
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.equal(prompt.match(/任务目标：([^\n]*)/)?.[1], "CTX任务摘要");
});

test("whitespace task falls back to the latest non-empty entry user text", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialMessages: [
      { role: "user", content: "请用一句话介绍你自己" },
      { role: "assistant", content: "我是助手" },
      { role: "user", content: "新任务：在当前任务目录创建一个俄罗斯方块网页游戏，网页版的。" },
    ],
    task: "   ",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  const taskLine = prompt.match(/任务目标：([^\n]*)/)?.[1];
  assert.equal(taskLine, "新任务：在当前任务目录创建一个俄罗斯方块网页游戏，网页版的。");
  assert.doesNotMatch(taskLine, /介绍你自己/);
});

test("explicit task briefs keep content beyond the legacy 500-code-point cap", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);
  const task = `${"任务内容".repeat(220)}TAIL_MARKER_9F3C`;

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    task,
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.match(prompt, /TAIL_MARKER_9F3C/);
  assert.ok(prompt.length < 2000);
});

test("resumed judge briefs scan only the original round-zero seed messages", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "task-brief-resume";
  const firstProvider = createFakeProvider([
    {
      content: [
        { type: "tool_use", id: "work-1", name: "work", input: { step: 1 } },
        { type: "tool_use", id: "work-2", name: "work", input: { step: 2 } },
      ],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const firstJudge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "偏离",
      evidence: "需要继续",
      direction: "off_track",
      directionReason: "偏离",
    }),
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "偏离",
      evidence: "需要继续",
      direction: "off_track",
      directionReason: "偏离",
    }),
  ]);

  await runToolLoop({
    provider: firstProvider,
    initialMessages: [{ role: "user", content: "任务A：修登录bug" }],
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
    wrapup: false,
    reflection: {
      enabled: true,
      judgeIntervalRound: 1,
      judge: { provider: firstJudge },
    },
    store,
    runId,
  });

  const records = await store.load(runId);
  assert.ok(records.some((record) => (
    (record.messages ?? []).some((message) => (
      message.role === "user"
      && JSON.stringify(message.content).includes("附方向提示")
    ))
  )), "run A should persist the synthetic direction hint");

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "继续完成" }], stopReason: "end_turn" },
  ]);
  const resumedJudge = createFakeProvider([
    judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已完成" }),
  ]);

  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    executeTool: async () => "unused",
    maxRounds: 3,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: resumedJudge } },
    store,
    runId,
  });

  assert.ok(resumedJudge.requests.length >= 1, "resume run should trigger at least one judge call");
  const prompt = resumedJudge.requests[0].messages[0].content[0].text;
  const taskLine = prompt.match(/任务目标：([^\n]*)/)?.[1];
  assert.equal(taskLine, "任务A：修登录bug");
  assert.doesNotMatch(taskLine, /附方向提示|偏离/);
});

test("resume without a round-zero seed keeps the judge brief empty", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "task-brief-resume-without-seed";
  await store.appendRound(runId, {
    round: 1,
    dedupKey: `${runId}:round:1`,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "（附方向提示：不要继续当前实现）" }],
    }],
  });

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "继续完成" }], stopReason: "end_turn" },
  ]);
  const resumedJudge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.2,
      reason: "无法判断",
      evidence: "缺少任务目标",
    }),
  ]);

  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    executeTool: async () => "unused",
    // 预算计数器拆分（issue #32 #8）后 resume 的轮预算从 0 起算，
    // maxRounds=1 即续接会话只跑一轮（judge 恰好被调用一次）
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: resumedJudge } },
    store,
    runId,
  });

  assert.equal(resumedJudge.requests.length, 1);
  const prompt = resumedJudge.requests[0].messages[0].content[0].text;
  // 任务目标行仍取最新快照，不受历史/方向提示污染
  assert.match(prompt, /任务目标：\（未提供\）/);
  assert.doesNotMatch(prompt.split("完整对话记录")[0], /附方向提示/);
});

test("single-task entry fallback remains the same for the round judge", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  const prompt = judge.requests[0].messages[0].content[0].text;
  assert.equal(prompt.match(/任务目标：([^\n]*)/)?.[1], "task");
});

test("round judge task brief stays on the entry snapshot after injecting direction hints", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我认为完成了" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "继续处理" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: false,
      confidence: 0.8,
      reason: "还未完成",
      evidence: "继续工作",
      direction: "off_track",
      directionReason: "持续反复调试",
    }),
    judgeResponse({ done: false, confidence: 0.8, reason: "继续", evidence: "还需工作" }),
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 2,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: judge } },
  });

  assert.equal(judge.requests.length, 2);
  for (const request of judge.requests) {
    const prompt = request.messages[0].content[0].text;
    const taskLine = prompt.match(/任务目标：([^\n]*)/)?.[1];
    assert.equal(taskLine, "task");
    // task 行不受污染；且 judge 自己的方向提示/评审意见带 meta，不进完整对话（避免自证循环）
    assert.doesNotMatch(prompt.split("完整对话记录")[0], /附方向提示|持续反复调试/);
    assert.doesNotMatch(prompt, /【Judge 评审意见】|附方向提示/);
  }
});

test("round judge errors degrade to the existing loop path", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{ throw: new Error("judge unavailable"), times: 20 }]);
  const events = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(provider.requests.length, 2);
  // round judge 抛错也应 emit degraded（审计完整性——阻断项修复）
  const degraded = events.find((event) => event.action === "degraded" && event.kind === "round");
  assert.ok(degraded, "round judge 抛错应 emit degraded 事件");
  assert.equal(degraded.decision, null);
  assert.equal(degraded.error, "error");
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

test("long runs enable the round judge by default", async () => {
  const previous = process.env.ERIX_NO_REFLECTION;
  delete process.env.ERIX_NO_REFLECTION;
  try {
    const provider = createFakeProvider([
      toolResponse("main-1", "work", { round: 1 }),
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
      judgeResponse({ done: true, confidence: 0.9, reason: "完成", evidence: "已验证" }),
    ]);

    await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 16,
      completion: false,
    });

    const judgeRequests = provider.requests.filter((request) => request.messages?.some((message) => (
      message.content?.some((block) => block.type === "text" && block.text.includes("【每轮 Judge】"))
    )));
    assert.equal(judgeRequests.length, 1);
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_REFLECTION;
    else process.env.ERIX_NO_REFLECTION = previous;
  }
});

test("short runs do not enable the round judge by default", async () => {
  const previous = process.env.ERIX_NO_REFLECTION;
  delete process.env.ERIX_NO_REFLECTION;
  try {
    const provider = createFakeProvider([
      toolResponse("main-1", "work", { round: 1 }),
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);

    await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 15,
      completion: false,
    });

    assert.equal(provider.requests.some((request) => request.messages?.some((message) => (
      message.content?.some((block) => block.type === "text" && block.text.includes("【每轮 Judge】"))
    ))), false);
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_REFLECTION;
    else process.env.ERIX_NO_REFLECTION = previous;
  }
});

test("explicit reflection false disables the default round judge", async () => {
  const provider = createFakeProvider([
    toolResponse("main-1", "work", { round: 1 }),
    { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
  ]);

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 16,
    completion: false,
    reflection: false,
  });

  assert.equal(provider.requests.some((request) => request.messages?.some((message) => (
    message.content?.some((block) => block.type === "text" && block.text.includes("【每轮 Judge】"))
  ))), false);
});

test("ERIX_NO_REFLECTION disables automatic reflection", async () => {
  const previous = process.env.ERIX_NO_REFLECTION;
  process.env.ERIX_NO_REFLECTION = "1";
  try {
    const provider = createFakeProvider([
      toolResponse("main-1", "work", { round: 1 }),
      { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
    ]);

    await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 16,
      completion: false,
    });

    assert.equal(provider.requests.some((request) => request.messages?.some((message) => (
      message.content?.some((block) => block.type === "text" && block.text.includes("【每轮 Judge】"))
    ))), false);
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_REFLECTION;
    else process.env.ERIX_NO_REFLECTION = previous;
  }
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
    direction: undefined,
    directionReason: "",
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
  // 状态按 tool_use_id 配对到正确调用，不因结果乱序错配
  const sim208 = result.toolCalls.find((c) => c.arg === "./sim 208");
  const sim20000 = result.toolCalls.find((c) => c.arg === "./sim 20000");
  const write = result.toolCalls.find((c) => c.arg === "g.txt");
  assert.equal(sim208.status, "ok");
  assert.equal(sim20000.status, "ok");
  assert.equal(write.status, "ok");
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

test("judge intercept interval defaults to 10 (runtime eval §5.1: the denser default caused false blocks)", async () => {
  const previous = process.env.ERIX_JUDGE_INTERVAL;
  delete process.env.ERIX_JUDGE_INTERVAL;
  try {
    // 6 次工具执行：默认间隔 10 时都不该触发审计（默认 5 时第 6 次会被拦截）
    const provider = createFakeProvider([
      toolResponse("t1", "work", { round: 1 }),
      toolResponse("t2", "work", { round: 2 }),
      toolResponse("t3", "work", { round: 3 }),
      toolResponse("t4", "work", { round: 4 }),
      toolResponse("t5", "work", { round: 5 }),
      toolResponse("t6", "work", { round: 6 }),
      { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([
      judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "未创建产物" }),
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
      reflection: { enabled: true, roundJudge: false, judge: { provider: judge } },
    });
    assert.deepEqual(executed, [1, 2, 3, 4, 5, 6]);
    assert.equal(judge.requests.length, 0);
  } finally {
    if (previous === undefined) delete process.env.ERIX_JUDGE_INTERVAL;
    else process.env.ERIX_JUDGE_INTERVAL = previous;
  }
});

test("ERIX_JUDGE_INTERVAL overrides the intercept interval and invalid values fall back to the default", async () => {
  const previous = process.env.ERIX_JUDGE_INTERVAL;
  const runWithTools = async (toolCount) => {
    const responses = [];
    for (let round = 1; round <= toolCount; round += 1) {
      responses.push(toolResponse(`t${round}`, "work", { round }));
    }
    responses.push({ content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" });
    const provider = createFakeProvider(responses);
    const judge = createFakeProvider([
      judgeResponse({ done: false, confidence: 0.8, reason: "方向偏了", evidence: "未创建产物" }),
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
      reflection: { enabled: true, roundJudge: false, judge: { provider: judge } },
    });
    return { executed, judgeCalls: judge.requests.length, provider };
  };
  try {
    // 间隔 3：前 3 次执行计数到 3，第 4 次先审计（done:false → 拦截未执行）
    process.env.ERIX_JUDGE_INTERVAL = "3";
    const overridden = await runWithTools(4);
    assert.deepEqual(overridden.executed, [1, 2, 3]);
    assert.equal(overridden.judgeCalls, 1);
    const intercepted = overridden.provider.requests.at(-1).messages
      .flatMap((m) => m.content ?? []).filter((b) => b.type === "tool_result")
      .map((b) => b.content).join("");
    assert.match(intercepted, /【审计拦截】方向可能偏/);

    // 非法值（非正整数）忽略 → 回退默认 10：6 次执行都不触发审计
    process.env.ERIX_JUDGE_INTERVAL = "abc";
    const invalid = await runWithTools(6);
    assert.deepEqual(invalid.executed, [1, 2, 3, 4, 5, 6]);
    assert.equal(invalid.judgeCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.ERIX_JUDGE_INTERVAL;
    else process.env.ERIX_JUDGE_INTERVAL = previous;
  }
});

test("transparent interception releases the exact cached tool call when approved and keeps on-track execution unannotated", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "writeFile", { path: "result.txt", content: "42" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: true,
      confidence: 0.9,
      reason: "方向正确",
      evidence: "目标一致",
      direction: "on_track",
      directionReason: "正在推进目标",
    }),
  ]);
  const calls = [];
  const result = await runToolLoop({
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
  const secondResult = result.transcript.flatMap((message) => message.content ?? [])
    .find((block) => block.tool_use_id === "second");
  assert.equal(secondResult.content, "ok");
});

test("transparent interception executes done tools marked off-track and appends a direction hint", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    judgeResponse({
      done: true,
      confidence: 0.9,
      reason: "允许执行",
      evidence: "工具调用本身有效",
      direction: "off_track",
      directionReason: "连续反复调试同一实现细节",
    }),
  ]);
  const executed = [];
  const result = await runToolLoop({
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
  // 方向提示为独立 user text 消息（不污染 tool_result 事实链）
  const toolResultBlock = result.transcript.flatMap((message) => message.content ?? [])
    .find((block) => block.tool_use_id === "second");
  assert.doesNotMatch(toolResultBlock.content, /附方向提示/);
  assert.doesNotMatch(toolResultBlock.content, /审计拦截/);
  const hintText = result.transcript
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .find((text) => /附方向提示：连续反复调试同一实现细节/.test(text ?? ""));
  assert.ok(hintText, "应存在独立的方向提示 user 消息");
});

test("transparent interception emits an executed onJudge event when approved", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "writeFile", { path: "result.txt", content: "42" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const decision = {
    done: true,
    confidence: 0.9,
    reason: "方向正确",
    evidence: "目标一致",
    direction: "on_track",
    directionReason: "正在推进目标",
  };
  const judge = createFakeProvider([judgeResponse(decision)]);
  const events = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "writeFile", input: { path: "result.txt", content: "42" } },
    decision,
    action: "executed",
  }]);
});

test("transparent interception emits a blocked onJudge event when denied", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "改方向后收尾" }], stopReason: "end_turn" },
  ]);
  const decision = {
    done: false,
    confidence: 0.8,
    reason: "方向偏了",
    evidence: "需要重新确认目标",
    direction: "off_track",
    directionReason: "当前方法反复失败",
  };
  const judge = createFakeProvider([judgeResponse(decision)]);
  const events = [];
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
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(executed, [1]);
  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision,
    action: "blocked",
  }]);
});

test("transparent interception executes on-track calls even when the judge reports done:false", async () => {
  // issue #32 / 运行时评估 §5：任务中途 done:false 是常态，direction 自评 on_track 的调用不该被拦截
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "writeFile", { path: "result.txt", content: "42" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const decision = {
    done: false,
    confidence: 0.6,
    reason: "任务尚未完成",
    evidence: "还剩两项验证",
    direction: "on_track",
    directionReason: "正在按计划推进",
  };
  const judge = createFakeProvider([judgeResponse(decision)]);
  const events = [];
  const calls = [];

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ id, name, input }) => {
      calls.push({ id, name, input });
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
    onJudge: (info) => events.push(info),
  });

  // 工具照常执行（第二个调用没有被取消）
  assert.deepEqual(calls, [
    { id: "first", name: "work", input: { step: 1 } },
    { id: "second", name: "writeFile", input: { path: "result.txt", content: "42" } },
  ]);
  const secondResult = result.transcript.flatMap((message) => message.content ?? [])
    .find((block) => block.tool_use_id === "second");
  assert.equal(secondResult.content, "ok");
  assert.equal(secondResult.executionStatus, undefined);
  // 无【审计拦截】文本注入
  const toolResultText = result.transcript.flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content)).join("\n");
  assert.doesNotMatch(toolResultText, /审计拦截/);
  // judge 事件仍可区分放行：action=executed + passThrough=on_track
  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "writeFile", input: { path: "result.txt", content: "42" } },
    decision,
    action: "executed",
    passThrough: "on_track",
  }]);
});

test("transparent interception still blocks done:false calls marked off-track", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "改方向后收尾" }], stopReason: "end_turn" },
  ]);
  const decision = {
    done: false,
    confidence: 0.8,
    reason: "方向偏了",
    evidence: "需要重新确认目标",
    direction: "off_track",
    directionReason: "当前方法反复失败",
  };
  const judge = createFakeProvider([judgeResponse(decision)]);
  const events = [];
  const executed = [];

  const result = await runToolLoop({
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
    onJudge: (info) => events.push(info),
  });

  // done:false + 非 on_track（off_track/uncertain/缺失）维持拦截：第二个调用未执行
  assert.deepEqual(executed, [1]);
  const auditText = result.transcript.flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(block.content)).join("\n");
  assert.match(auditText, /【审计拦截】方向可能偏/);
  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision,
    action: "blocked",
  }]);
});

test("transparent interception emits degraded when the judge fails", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{ throw: new Error("judge unavailable") }]);
  const events = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision: null,
    action: "degraded",
    error: "error",
  }]);
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

test("round judge decision event carries the call usage for transcript accounting (issue #33 B)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{
    ...judgeResponse({ done: true, confidence: 0.9, reason: "已完成", evidence: "验证通过" }),
    usage: { input_tokens: 1234, output_tokens: 56 },
  }]);
  const events = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    round: 1,
    kind: "round",
    decision: {
      done: true,
      confidence: 0.9,
      reason: "已完成",
      evidence: "验证通过",
      direction: undefined,
      directionReason: "",
    },
    action: "judge_done",
    usage: { input_tokens: 1234, output_tokens: 56 },
  }]);
});

test("round judge parse failure still reports usage on the degraded event (review fix)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  // decision 文本不可解析（parse 失败），但 response.usage 已可取得。
  const judge = createFakeProvider([{
    content: [{ type: "text", text: "totally not a json decision" }],
    usage: { input_tokens: 432, output_tokens: 7 },
    times: 5,
  }]);
  const events = [];

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(events, [{
    round: 1,
    kind: "round",
    decision: null,
    action: "degraded",
    error: "parse",
    usage: { input_tokens: 432, output_tokens: 7 },
  }]);
});

test("intercept judge parse failure still reports usage on the degraded event (review fix)", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{
    content: [{ type: "text", text: "not parseable at all" }],
    usage: { input_tokens: 99, output_tokens: 3 },
  }]);
  const events = [];
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
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision: null,
    action: "degraded",
    error: "parse",
    usage: { input_tokens: 99, output_tokens: 3 },
  }]);
  // degraded 后工具照常执行（既有行为不变）。
  assert.deepEqual(executed, [1, 2]);
});

test("intercept judge event carries usage and omits it on timeout (issue #33 B)", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "work", { step: 1 }),
    toolResponse("second", "work", { step: 2 }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([{
    ...judgeResponse({
      done: false,
      confidence: 0.6,
      reason: "任务尚未完成",
      evidence: "还剩两项验证",
      direction: "on_track",
      directionReason: "正在按计划推进",
    }),
    usage: { input_tokens: 777, output_tokens: 12 },
  }]);
  const events = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision: {
      done: false,
      confidence: 0.6,
      reason: "任务尚未完成",
      evidence: "还剩两项验证",
      direction: "on_track",
      directionReason: "正在按计划推进",
    },
    action: "executed",
    passThrough: "on_track",
    usage: { input_tokens: 777, output_tokens: 12 },
  }]);

  // 超时路径：usage 缺省、事件其余字段不变、不炸。
  const slowJudge = {
    async chat() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ...judgeResponse({ done: false, confidence: 1, reason: "late", evidence: "late" }),
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    },
  };
  const timeoutEvents = [];
  await runToolLoop({
    provider: createFakeProvider([
      toolResponse("first", "work", { step: 1 }),
      toolResponse("second", "work", { step: 2 }),
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judgeInterceptTimeoutMs: 5,
      judge: { provider: slowJudge },
    },
    onJudge: (info) => timeoutEvents.push(info),
  });

  assert.deepEqual(timeoutEvents, [{
    kind: "intercept",
    tool: { id: "second", name: "work", input: { step: 2 } },
    decision: null,
    action: "degraded",
    error: "timeout",
  }]);
  assert.equal("usage" in timeoutEvents[0], false);
});

test("readonly tools pass through interception even when off-track, exec stays blocked (issue #33 C)", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "readFile", { path: "src/a.js" }),
    toolResponse("second", "exec", { command: "rm -rf build" }),
    toolResponse("third", "readFile", { path: "src/b.js" }),
    toolResponse("fourth", "readFile", { path: "src/c.js" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  // 两次拦截（judgeIntervalRound=1：每第 2 个工具触发审计，1/3 直通）：
  // 工具2 exec（写路径，应 blocked），工具4 readFile（只读，应放行）。
  const decisionExec = {
    done: false,
    confidence: 0.8,
    reason: "方向偏了",
    evidence: "需要重新确认目标",
    direction: "off_track",
    directionReason: "当前方法反复失败",
  };
  const decisionRead = {
    done: false,
    confidence: 0.8,
    reason: "方向偏了",
    evidence: "需要重新确认目标",
    direction: "off_track",
    directionReason: "当前方法反复失败",
  };
  const judge = createFakeProvider([judgeResponse(decisionExec), judgeResponse(decisionRead)]);
  const events = [];
  const executed = [];

  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ name, input }) => {
      executed.push({ name, input });
      return "ok";
    },
    maxRounds: 10,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
    onJudge: (info) => events.push(info),
  });

  // 只读 readFile 照常执行；exec 在同决策下仍 blocked。
  assert.deepEqual(executed, [
    { name: "readFile", input: { path: "src/a.js" } },
    { name: "readFile", input: { path: "src/b.js" } },
    { name: "readFile", input: { path: "src/c.js" } },
  ]);
  const readResult = result.transcript.flatMap((message) => message.content ?? [])
    .find((block) => block.tool_use_id === "fourth");
  assert.equal(readResult.content, "ok");
  assert.equal(readResult.executionStatus, undefined);
  const execResult = result.transcript.flatMap((message) => message.content ?? [])
    .find((block) => block.tool_use_id === "second");
  assert.match(String(execResult.content), /【审计拦截】方向可能偏/u);
  assert.equal(execResult.executionStatus, "intercepted");

  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "exec", input: { command: "rm -rf build" } },
    decision: decisionExec,
    action: "blocked",
  }, {
    kind: "intercept",
    tool: { id: "fourth", name: "readFile", input: { path: "src/c.js" } },
    decision: decisionRead,
    action: "executed",
    passThrough: "readonly",
  }]);

  // directionHint 照常附加（放行路径也注入提示，供模型换思路）。
  const hintText = result.transcript.flatMap((message) => message.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text)).join("\n");
  assert.match(hintText, /方向提示/u);
});

test("readonly pass-through also applies to uncertain direction", async () => {
  const provider = createFakeProvider([
    toolResponse("first", "recall", { pattern: "nonce" }),
    toolResponse("second", "recall", { pattern: "anchor" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const decision = {
    done: false,
    confidence: 0.5,
    reason: "不确定",
    evidence: "上下文不足",
    direction: "uncertain",
    directionReason: "难以判断",
  };
  const judge = createFakeProvider([judgeResponse(decision)]);
  const events = [];
  const executed = [];

  await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async ({ input }) => {
      executed.push(input.pattern);
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
    onJudge: (info) => events.push(info),
  });

  assert.deepEqual(executed, ["nonce", "anchor"]);
  assert.deepEqual(events, [{
    kind: "intercept",
    tool: { id: "second", name: "recall", input: { pattern: "anchor" } },
    decision,
    action: "executed",
    passThrough: "readonly",
  }]);
});
