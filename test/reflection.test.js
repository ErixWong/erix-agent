import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { parseReflectionDecision } from "../src/loop/reflection.js";
import { parseModelJson } from "../src/text/parse-model-json.js";
import { jsonCandidates } from "../src/text/json-candidates.js";
import { numberOr } from "../src/loop/budget.js";
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
      via: "json",
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
      via: "prose_fallback",
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

// --- issue #305：顶层平衡扫描 + via 来源标记（工单 261016-305 C1/C2/C4 用例） ---

test("parseReflectionDecision: issue 原形状（JSON + 尾话带 {plan}）不再翻转 continue=false（C1）", () => {
  const decision = parseReflectionDecision(
    '{"progress":3,"stalled":true,"continue":false,"stallPattern":"反复读同一文件","reason":"在打转","plan":"改用 grep"}\n'
    + "以上是我的判断，把 {plan} 里的下一步做完就行。",
  );
  assert.equal(decision.via, "json");
  assert.equal(decision.continueFlag, false);
  assert.equal(decision.progress, 3);
  assert.equal(decision.stalled, true);
});

test("parseReflectionDecision: ```json 围栏 + 尾话带 {plan} 时 stalled/continue 双双保持 false（C2）", () => {
  const decision = parseReflectionDecision(
    "```json\n{\"progress\":8,\"stalled\":false,\"continue\":false,\"reason\":\"有新方向\",\"plan\":\"跑测试\"}\n```\n好的，按 {plan} 继续推进。",
  );
  assert.equal(decision.via, "json");
  assert.equal(decision.stalled, false);
  assert.equal(decision.continueFlag, false);
  assert.equal(decision.progress, 8);
});

test("parseReflectionDecision: 并列两个顶层对象时第一个胜出，第二个不污染（C2）", () => {
  const decision = parseReflectionDecision(
    '{"stalled":false,"continue":false}\n{"progress":5,"stalled":true,"continue":true,"reason":"第二个"}',
  );
  assert.equal(decision.via, "json");
  assert.equal(decision.stalled, false);
  assert.equal(decision.continueFlag, false);
  assert.equal(decision.progress, undefined);
});

test("parseReflectionDecision: 外层未闭合 + 内层完整 ⇒ prose_fallback，不返回内层残片（C2 哨兵）", () => {
  const decision = parseReflectionDecision(
    '{"outer":{"progress":3,"stalled":false,"continue":true,"reason":"内层残片"}',
  );
  assert.equal(decision.via, "prose_fallback");
  assert.equal(decision.progress, undefined);
});

test("parseReflectionDecision: 值内同时含转义引号与右花括时仍按完整对象解析（C4-③ 判别用例）", () => {
  // 两个要素必须同时在场：只含 } 或只含 \" 的用例今天就绿，没有判别力。
  const payload = JSON.stringify({
    progress: 4,
    stalled: true,
    continue: false,
    reason: '值里有 \" 与 } 两个字符',
  });
  assert.ok(payload.includes('\\"') && payload.includes("} 两个字符"));
  const decision = parseReflectionDecision(payload);
  assert.equal(decision.via, "json");
  assert.equal(decision.progress, 4);
  assert.equal(decision.continueFlag, false);
  assert.equal(decision.stalled, true);
});

test("parseReflectionDecision: 首个顶层候选不含已知键时跳过它、试下一个候选（R1 灰区 continue 语义）", () => {
  // 本条钉的是 src/loop/reflection.js 灰区分支的 `continue`，不是 `break`：
  // 改成 break（首个候选不含已知键就立刻落兜底）必须红——via 会退成 prose_fallback，
  // continueFlag 会由关键词在整段文本上匹配到 "continue" 而翻成 true。
  const decision = parseReflectionDecision('{"foo":1}{"stalled":true}');
  assert.equal(decision.via, "json");
  assert.equal(decision.stalled, true);
  assert.equal(decision.continueFlag, false);
});

test("parseReflectionDecision: 顶层对象可解析但六字段一个都不含 ⇒ 按 prose_fallback 处理（R2 灰区）", () => {
  const decision = parseReflectionDecision('{"foo":1}\n这段值得继续做下去。');
  assert.equal(decision.via, "prose_fallback");
  assert.equal(decision.progress, undefined);
  assert.equal(decision.continueFlag, true);
});

test("parseReflectionDecision: 纯散文走 prose_fallback，关键词行为逐字不变（C5）", () => {
  const decision = parseReflectionDecision("这个方向值得继续，先不判停");
  assert.equal(decision.via, "prose_fallback");
  assert.equal(decision.stalled, false);
  assert.equal(decision.continueFlag, true);
});

// --- issue #307：公共入口 parseModelJson + 迁移点对拍（工单 261016-307 C2/C3/C4 用例） ---

/**
 * #306（main `9021d74`）的 `parseReflectionDecision` 对照件：整段逐字搬来，只改了函数名，
 * 扫描仍走它自己的 `jsonCandidates`。它只在测试里活着，作用是把「迁移到 parseModelJson
 * 之后行为与 #306 逐字等价」变成一条会红的断言，而不是提交信息里的一句话。
 * 动它 = 这条对拍作废（要动请连同 src/loop/reflection.js 一起动，那才是宿主可见真身）。
 */
const LEGACY_DECISION_KEYS = ["progress", "stalled", "continue", "stallPattern", "reason", "plan"];

function legacyParseReflectionDecision(text) {
  const value = String(text ?? "");
  for (const candidate of jsonCandidates(value)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!LEGACY_DECISION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) continue;
    return {
      progress: numberOr(parsed.progress),
      stalled: parsed.stalled === true,
      continueFlag: parsed.continue === true,
      stallPattern: String(parsed.stallPattern ?? ""),
      reason: String(parsed.reason ?? ""),
      plan: String(parsed.plan ?? ""),
      via: "json",
    };
  }
  return {
    progress: undefined,
    stalled: /打转|重复|无进展|stalled/i.test(value),
    continueFlag: /继续|值得|continue/i.test(value) && !/不值得|放弃|停止/i.test(value),
    stallPattern: "",
    reason: value.slice(0, 200),
    plan: "",
    via: "prose_fallback",
  };
}

test("parseModelJson: 三态失败各自可分，且失败结果里根本没有 value 键（C3）", () => {
  const noCandidate = parseModelJson("纯散文，一个花括号都没有");
  assert.deepEqual(noCandidate, { ok: false, error: "no_candidate", candidates: [] });

  const unparsable = parseModelJson('前置说明 {"a":,} 尾话');
  assert.equal(unparsable.error, "unparsable");
  assert.deepEqual(unparsable.candidates, ['{"a":,}']);

  const shapeMismatch = parseModelJson('{"progress":3}', { requireKeys: ["done"] });
  assert.equal(shapeMismatch.error, "shape_mismatch");
  assert.deepEqual(shapeMismatch.candidates, ['{"progress":3}']);

  const kinds = new Set([noCandidate.error, unparsable.error, shapeMismatch.error]);
  assert.equal(kinds.size, 3, "三态必须互不相同");
  for (const miss of [noCandidate, unparsable, shapeMismatch]) {
    assert.equal(miss.ok, false);
    assert.ok(!("value" in miss), `失败结果不许带 value 键：${JSON.stringify(miss)}`);
    assert.ok(!("via" in miss), `失败结果不该带 via：${JSON.stringify(miss)}`);
  }
});

test("parseModelJson: 命中原样搬运值，没有任何 repair（R1「只许搬运」）", () => {
  assert.deepEqual(
    parseModelJson('结论：\n```json\n{"done":true,"note":"a}\\"b"}\n```\n尾话 {plan}'),
    {
      ok: true,
      value: { done: true, note: 'a}"b' },
      via: "json",
      candidates: ['{"done":true,"note":"a}\\"b"}', "{plan}"],
    },
  );
  // 不补闭合括号：外层未闭合就一个候选都不产，也不「修好」它
  assert.equal(parseModelJson('{"done":true').error, "no_candidate");
  // 不改值、不删逗号：坏 JSON 就是 unparsable，不会被救回来
  assert.equal(parseModelJson('{"done":true,,}').error, "unparsable");
});

test("parseModelJson: requireKeys 只问键在不在（any-of），值类型不归它管（R1）", () => {
  assert.equal(parseModelJson('{"done":"true"}', { requireKeys: ["done"] }).ok, true);
  assert.equal(parseModelJson('{"progress":3}', { requireKeys: ["done", "progress"] }).ok, true);
  assert.equal(parseModelJson('{"a":1}', { requireKeys: [] }).ok, true);
  assert.equal(parseModelJson('{"a":1}', { requireKeys: null }).ok, true);
  // 候选顺序 = 出现顺序，第一个「可解析且形状合格」的胜出，后面的一个不看
  const first = parseModelJson('{"note":1}{"done":true}', { requireKeys: ["done"] });
  assert.deepEqual(first.value, { done: true });
  assert.deepEqual(first.candidates, ['{"note":1}', '{"done":true}']);
});

test("parseModelJson: topOnly 两档的分工 —— 内层残片只在 false 档出现（C4-① 的靶子）", () => {
  const text = '{"outer":{"done":true,"confidence":0.5,"reason":"内层残片"}';
  const topOnly = parseModelJson(text);
  assert.equal(topOnly.ok, false);
  assert.equal(topOnly.error, "no_candidate");
  const everyStart = parseModelJson(text, { topOnly: false });
  assert.equal(everyStart.ok, true);
  assert.deepEqual(everyStart.value, { done: true, confidence: 0.5, reason: "内层残片" });
  assert.deepEqual(everyStart.candidates, ['{"done":true,"confidence":0.5,"reason":"内层残片"}']);
});

test("parseReflectionDecision 与 #306 实现逐字对拍：已知形状 + 确定性随机语料 0 差异（C2）", () => {
  const known = [
    // #306 那六个形状（test/reflection.test.js 上方 #305 段落里的输入，逐条抄来）
    '{"progress":3,"stalled":true,"continue":false,"stallPattern":"反复读同一文件","reason":"在打转","plan":"改用 grep"}\n以上是我的判断，把 {plan} 里的下一步做完就行。',
    "```json\n{\"progress\":8,\"stalled\":false,\"continue\":false,\"reason\":\"有新方向\",\"plan\":\"跑测试\"}\n```\n好的，按 {plan} 继续推进。",
    '{"stalled":false,"continue":false}\n{"progress":5,"stalled":true,"continue":true,"reason":"第二个"}',
    '{"outer":{"progress":3,"stalled":false,"continue":true,"reason":"内层残片"}',
    JSON.stringify({ progress: 4, stalled: true, continue: false, reason: '值里有 " 与 } 两个字符' }),
    '{"foo":1}{"stalled":true}',
    '{"foo":1}\n这段值得继续做下去。',
    "这个方向值得继续，先不判停",
    "",
    null,
  ];
  // 确定性 LCG 随机语料：花括号 / 引号 / 转义 / 中文关键词的排列组合（不是抽样，跑满 3000 条）
  const atoms = ['{', '}', '"', '\\', '{"done":true}', '{"progress":3,"continue":false}',
    '{"outer":{"stalled":true}', '{"foo":1}', '{"a":,}', "尾话", "继续", "打转", "放弃",
    "```json", "```", " ", "\n", '{"reason":"a\\"}b"}', '{"continue":true,,}'];
  let seed = 20261016;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const random = [];
  for (let i = 0; i < 3000; i += 1) {
    const len = 1 + Math.floor(rnd() * 6);
    let s = "";
    for (let k = 0; k < len; k += 1) s += atoms[Math.floor(rnd() * atoms.length)];
    random.push(s);
  }
  for (const input of [...known, ...random]) {
    assert.deepEqual(
      parseReflectionDecision(input),
      legacyParseReflectionDecision(input),
      `迁移前后同输入必须同输出，输入：${JSON.stringify(input)}`,
    );
  }
});
