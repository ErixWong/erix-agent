import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { parseReflectionDecision } from "../src/loop/reflection.js";
import { parseModelJson } from "../src/text/parse-model-json.js";
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

// --- issue #307：公共入口 parseModelJson（三态失败 / 无 repair / topOnly 两档）---

test("parseModelJson 命中：ok:true + via:\"json\" + value 是 JSON.parse 的直接产物（#307 R1）", () => {
  const result = parseModelJson('散文前置 {"progress":3,"reason":"在打转"} 尾话');
  assert.equal(result.ok, true);
  assert.equal(result.via, "json");
  assert.deepEqual(result.value, { progress: 3, reason: "在打转" });
  assert.deepEqual(result.candidates, ['{"progress":3,"reason":"在打转"}']);
});

test("parseModelJson 失败态一 no_candidate：纯文本一个候选都没有（#307 C3）", () => {
  const result = parseModelJson("这段值得继续做下去，没有花括号");
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_candidate");
  assert.deepEqual(result.candidates, []);
});

test("parseModelJson 失败态二 unparsable：有候选但 JSON.parse 全失败（#307 C3）", () => {
  const result = parseModelJson('{"a":,}');
  assert.equal(result.ok, false);
  assert.equal(result.error, "unparsable");
  assert.deepEqual(result.candidates, ['{"a":,}']); // 候选仍在，供宿主诊断
});

test("parseModelJson 失败态三 shape_mismatch：解析成功却不含 requireKeys（#307 C3）", () => {
  const result = parseModelJson('{"confidence":0.5,"reason":"没有 done 键"}', { requireKeys: ["done"] });
  assert.equal(result.ok, false);
  assert.equal(result.error, "shape_mismatch");
  assert.deepEqual(result.candidates, ['{"confidence":0.5,"reason":"没有 done 键"}']);
});

test("parseModelJson 三种失败都**不带 value 键**，不是 value:undefined（#307 C3 红线）", () => {
  const misses = [
    parseModelJson("纯散文"),
    parseModelJson('{"a":,}'),
    parseModelJson('{"foo":1}', { requireKeys: ["done"] }),
  ];
  assert.deepEqual(misses.map((result) => result.error), ["no_candidate", "unparsable", "shape_mismatch"]);
  for (const result of misses) {
    assert.equal(result.ok, false);
    assert.ok(!("value" in result), `失败分支不得带 value 键：${JSON.stringify(result)}`);
    assert.ok(!("via" in result), `失败分支不得带 via 键：${JSON.stringify(result)}`);
  }
});

test("parseModelJson 没有 repair：未闭合不补括号、坏 JSON 不改值（#307 R1 红线）", () => {
  // 缺右花括：topOnly 口径下不产候选（而不是补一个 } 再解析成 {a:1}）。
  assert.deepEqual(parseModelJson('{"a":1'), { ok: false, error: "no_candidate", candidates: [] });
  // 尾逗号 / 单引号：解析失败就报 unparsable，不做任何修补。
  assert.equal(parseModelJson('{"a":1,}').error, "unparsable");
  assert.equal(parseModelJson("{'a':1}").error, "unparsable");
  // 真值不搬家：0 / false / null / "" 原样保留，不被"顺手归一化"。
  const result = parseModelJson('{"n":0,"b":false,"z":null,"s":""}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { n: 0, b: false, z: null, s: "" });
});

test("parseModelJson topOnly 两档：默认只产顶层对象，false 逐字复刻 every-start（#307 R1）", () => {
  const unclosed = '{"outer":{"done":true,"confidence":0.5,"reason":"内层残片"}';
  // 默认：外层未闭合 ⇒ 一个候选都不产（这是 wrapup / reflection 用的档位）。
  assert.deepEqual(parseModelJson(unclosed).candidates, []);
  assert.equal(parseModelJson(unclosed).error, "no_candidate");
  // topOnly:false：内层残片成为候选（judge 的现状语义，issue #309 才改）。
  const everyStart = parseModelJson(unclosed, { topOnly: false });
  assert.equal(everyStart.ok, true);
  assert.deepEqual(everyStart.value, { done: true, confidence: 0.5, reason: "内层残片" });
  assert.deepEqual(everyStart.candidates, ['{"done":true,"confidence":0.5,"reason":"内层残片"}']);
  // 平衡的外层对象：两档的候选数不同（every-start 会把内层也各扫一次）。
  const nested = '{"a":{"b":1}}';
  assert.deepEqual(parseModelJson(nested).candidates, [nested]);
  assert.deepEqual(parseModelJson(nested, { topOnly: false }).candidates, [nested, '{"b":1}']);
});

test("parseModelJson requireKeys 是「任一键在场」，且不合格候选继续试下一个（#307 R1）", () => {
  // 半集是合法输入（issue #305 契约）：只要一个键在场就通过。
  assert.equal(parseModelJson('{"progress":3}', { requireKeys: ["progress", "done"] }).ok, true);
  // 首个候选形状不合格 ⇒ 跳过它试下一个，而不是直接失败。
  const skipped = parseModelJson('{"foo":1}{"done":true}', { requireKeys: ["done"] });
  assert.equal(skipped.ok, true);
  assert.deepEqual(skipped.value, { done: true });
  assert.deepEqual(skipped.candidates, ['{"foo":1}', '{"done":true}']);
  // 空数组 / null 表示不做形状校验。
  assert.equal(parseModelJson('{"foo":1}', { requireKeys: [] }).ok, true);
  assert.equal(parseModelJson('{"foo":1}', { requireKeys: null }).ok, true);
});

test("parseModelJson 的候选顺序与文本出现顺序一致，并列顶层对象互不污染（#307 R1）", () => {
  const result = parseModelJson('{"a":1} 中间话 {"b":2} {"c":,}');
  assert.deepEqual(result.candidates, ['{"a":1}', '{"b":2}', '{"c":,}']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { a: 1 });
});

/**
 * 迁移前（main 9021d74，issue #306 定稿）的 parseReflectionDecision，**逐字搬进测试**
 * 当对拍参照物：迁移只允许换掉「扫描 + 试解析 + 已知键筛选」这段的载体，
 * 输出必须逐字相同（`via` 两档、灰区落兜底、`reason` 的 slice(0, 200) 口径全保持）。
 */
function legacyParseReflectionDecision(text) {
  const value = String(text ?? "");
  for (const candidate of legacyTopLevelCandidates(value)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!["progress", "stalled", "continue", "stallPattern", "reason", "plan"]
      .some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) continue;
    return {
      progress: typeof parsed.progress === "number" && Number.isFinite(parsed.progress) ? parsed.progress : undefined,
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

function legacyTopLevelCandidates(text) {
  const value = String(text ?? "");
  const out = [];
  let candidateStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") {
      if (depth === 0) candidateStart = index;
      depth += 1;
    } else if (character === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && candidateStart >= 0) {
        out.push(value.slice(candidateStart, index + 1));
        candidateStart = -1;
      }
    }
  }
  return out;
}

test("parseReflectionDecision 与迁移前实现逐字对拍：同一语料同输入同输出（#307 C2）", () => {
  const corpus = [
    // issue #306 的 6 个形状（工单 261016-307 R2 点名要覆盖）
    '{"progress":3,"stalled":true,"continue":false,"stallPattern":"反复读同一文件","reason":"在打转","plan":"改用 grep"}\n以上是我的判断，把 {plan} 里的下一步做完就行。',
    "```json\n{\"progress\":8,\"stalled\":false,\"continue\":false,\"reason\":\"有新方向\",\"plan\":\"跑测试\"}\n```\n好的，按 {plan} 继续推进。",
    '{"stalled":false,"continue":false}\n{"progress":5,"stalled":true,"continue":true,"reason":"第二个"}',
    '{"outer":{"progress":3,"stalled":false,"continue":true,"reason":"内层残片"}',
    '{"progress":4,"stalled":true,"continue":false,"reason":"值里有 \\" 与 } 两个字符"}',
    '{"foo":1}{"stalled":true}',
    // 灰区与兜底：解析不了 / 没有已知键 / 纯散文 / 关键词正负号
    '{"foo":1}\n这段值得继续做下去。',
    '{"foo":1}{"bar":2}',
    '{"a":,}',
    '{"a":,}{"progress":1}',
    "",
    "   ",
    "这个方向值得继续，先不判停",
    "一直在打转，放弃吧",
    "不值得继续，放弃这个方案",
    '{"reason":"' + "x".repeat(250) + '"}',
    "大文本".repeat(300) + '{"continue":true}',
    '{"progress":null,"stalled":"true","continue":1,"reason":42}',
    '{"nested":{"x":"{y}"},"progress":2}',
    "{\"a\":1 未闭合 后面 {\"stalled\":true}",
  ];
  for (const input of corpus) {
    assert.deepEqual(
      parseReflectionDecision(input),
      legacyParseReflectionDecision(input),
      `对拍不一致：${JSON.stringify(input.slice(0, 60))}`,
    );
  }
});
