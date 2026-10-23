import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWrapupWithLlm, tryParseWrapupJson } from "../src/reflection/wrapup.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { parseModelJson } from "../src/text/parse-model-json.js";

test("tryParseWrapupJson parses a plain protocol object", () => {
  assert.deepEqual(
    tryParseWrapupJson('{"done":true,"summary":"完成","output":"结果"}'),
    { done: true, summary: "完成", output: "结果" },
  );
});

test("tryParseWrapupJson tolerates a json code fence and surrounding text", () => {
  assert.deepEqual(
    tryParseWrapupJson('前置说明\n```json\n{"done":false,"summary":"进行中"}\n```\n后置'),
    { done: false, summary: "进行中", output: "" },
  );
});

test("tryParseWrapupJson returns null for non-JSON text", () => {
  assert.equal(tryParseWrapupJson("答案是 { not valid JSON"), null);
});

test("tryParseWrapupJson requires done and defaults optional fields", () => {
  assert.equal(tryParseWrapupJson('{"output":"只提供结果"}'), null);
  assert.deepEqual(
    tryParseWrapupJson('{"done":true}'),
    { done: true, summary: "", output: "" },
  );
});

test("host result objects without done are not mistaken for wrapup markers", () => {
  assert.equal(
    tryParseWrapupJson('{"summary":"完成","files":["README.md"],"notes":"已检查"}'),
    null,
  );
  assert.equal(
    tryParseWrapupJson('{"summary":"完成","passed":true,"issues":[]}'),
    null,
  );
});

test("nested {done,...} inside host JSON is not a wrapup candidate (review follow-up)", () => {
  // jsonCandidates must only scan top-level objects; an inner object shaped
  // like a wrap-up marker must not bypass the mandatory-done guard.
  assert.equal(
    tryParseWrapupJson('{"summary":"host","metadata":{"done":true,"output":"nested"}}'),
    null,
  );
  assert.equal(
    tryParseWrapupJson('{"summary":"host","issues":[{"done":true,"severity":"error"}]}'),
    null,
  );
  // Top-level protocol object with trailing nested object still parses.
  assert.deepEqual(
    tryParseWrapupJson('{"done":true,"summary":"s","meta":{"done":false}}'),
    { done: true, summary: "s", output: "" },
  );
});

test("tryParseWrapupJson rejects invalid protocol field types", () => {
  assert.equal(tryParseWrapupJson('{"done":"true","summary":"bad"}'), null);
  assert.equal(tryParseWrapupJson('{"done":true,"output":42}'), null);
});

test("done true end-turn stops the loop after one round and displays output", async () => {
  const provider = createFakeProvider([{
    content: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: '{"done":true,"summary":"完成","output":"最终答案"}' },
    ],
    stopReason: "end_turn",
  }]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "完成任务",
    executeTool: async () => "unused",
    maxRounds: 4,
  });

  assert.equal(result.rounds, 1);
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.finalText, "最终答案");
});

test("done false continues and a later done true response completes", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: '{"done":false,"summary":"还需验证"}' }],
      stopReason: "end_turn",
    },
    {
      content: [{ type: "text", text: '{"done":true,"summary":"已验证"}' }],
      stopReason: "end_turn",
    },
  ]);
  const toolCalls = [];
  const store = createMemoryTranscriptStore();

  const result = await runToolLoop({
    provider,
    initialUserMessage: "完成任务",
    executeTool: async (name) => {
      toolCalls.push(name);
      return "ok";
    },
    maxRounds: 4,
    completion: false,
    store,
    runId: "wrapup-progress",
  });

  assert.equal(toolCalls.length, 1);
  assert.equal(result.rounds, 3);
  assert.equal(result.finalText, "已验证");
  assert.equal(
    (await store.load("wrapup-progress")).find((record) => record.round === 2).summary,
    "还需验证",
  );
});

test("tool-use rounds do not parse JSON and still execute normally", async () => {
  const provider = createFakeProvider([
    {
      content: [
        { type: "text", text: "{not a wrapup}" },
        { type: "tool_use", id: "work-1", name: "work", input: {} },
      ],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: '{"done":true,"output":"完成"}' }],
      stopReason: "end_turn",
    },
  ]);
  let calls = 0;

  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => {
      calls += 1;
      return "ok";
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, "完成");
});

test("non-JSON end-turn text still completes through completion signals", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "任务已完成" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    completion: { signals: ["任务已完成"], maxNoToolRounds: 3 },
  });

  assert.equal(result.rounds, 2);
  assert.deepEqual(result.termination, { reason: "end_turn" });
});

test("wrapup:false disables parsing, replacement, normalization, and injection", async () => {
  const previousNormalization = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_WRAPUP_NORMALIZE = "1";
  try {
    const responseText = '{"done":true,"summary":"协议总结","output":"协议结果"}';
    const provider = createFakeProvider([{
      content: [{ type: "text", text: responseText }],
      stopReason: "end_turn",
    }]);
    const result = await runToolLoop({
      provider,
      wrapup: false,
      initialMessages: [
        { role: "system", content: [{ type: "text", text: "宿主系统" }] },
        { role: "user", content: [{ type: "text", text: "完成任务" }] },
      ],
      executeTool: async () => "unused",
    });

    assert.equal(result.finalText, responseText);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].system, undefined);
    assert.deepEqual(provider.requests[0].messages[0], {
      role: "system",
      content: [{ type: "text", text: "宿主系统" }],
    });
  } finally {
    if (previousNormalization === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = previousNormalization;
  }
});

test("wrapup:false keeps completion signals working on plain text", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "任务已完成" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    wrapup: false,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    completion: { signals: ["任务已完成"], maxNoToolRounds: 3 },
  });

  assert.equal(result.rounds, 2);
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.finalText, "任务已完成");
});

test("ERIX_NO_WRAPUP_INSTRUCTION disables the complete wrapup protocol", async () => {
  const previousInstruction = process.env.ERIX_NO_WRAPUP_INSTRUCTION;
  const previousNormalization = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_NO_WRAPUP_INSTRUCTION = "1";
  process.env.ERIX_WRAPUP_NORMALIZE = "1";
  try {
    const responseText = '{"done":true,"output":"协议结果"}';
    const provider = createFakeProvider([{
      content: [{ type: "text", text: responseText }],
      stopReason: "end_turn",
    }]);
    const result = await runToolLoop({
      provider,
      wrapup: true,
      initialUserMessage: "完成任务",
      executeTool: async () => "unused",
    });

    assert.equal(result.finalText, responseText);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].system, undefined);
  } finally {
    if (previousInstruction === undefined) delete process.env.ERIX_NO_WRAPUP_INSTRUCTION;
    else process.env.ERIX_NO_WRAPUP_INSTRUCTION = previousInstruction;
    if (previousNormalization === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = previousNormalization;
  }
});

test("LLM normalization may only transcribe: findings whose value is not verbatim in the agent text are dropped (issue #127)", async () => {
  const provider = createFakeProvider([
    // agent 原文里是打错的值 gold-417（没有末位 3）
    { content: [{ type: "text", text: "TARGET=gold-417" }], stopReason: "end_turn" },
    // 归一化器"好心"补全成 gold-4173——不是原文子串，必须被机械校验丢掉
    {
      content: [{
        type: "text",
        text: '{"done":true,"summary":"s","output":"TARGET=gold-417","findings":{"TARGET":"gold-4173"}}',
      }],
      stopReason: "end_turn",
    },
  ]);
  const seen = [];
  await runToolLoop({
    provider,
    initialUserMessage: "报出 TARGET",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: { wrapupNormalize: true, roundJudge: false, judgeIntercept: false },
    finalGuard: async ({ findings }) => {
      seen.push(findings);
      return { action: "accept" };
    },
  });
  // 归一化的 findings 被丢弃 → guard 看到的是"没声明"
  assert.deepEqual(seen, [undefined]);
});

test("LLM normalization keeps findings copied verbatim from the agent text", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "TARGET=gold-417" }], stopReason: "end_turn" },
    {
      content: [{
        type: "text",
        text: '{"done":true,"summary":"s","output":"TARGET=gold-417","findings":{"TARGET":"gold-417","note":"没有用过的值"}}',
      }],
      stopReason: "end_turn",
    },
  ]);
  const seen = [];
  await runToolLoop({
    provider,
    initialUserMessage: "报出 TARGET",
    executeTool: async () => "ok",
    maxRounds: 3,
    completion: false,
    reflection: { wrapupNormalize: true, roundJudge: false, judgeIntercept: false },
    finalGuard: async ({ findings }) => {
      seen.push(findings);
      return { action: "accept" };
    },
  });
  // 逐字子串的保留；凭空出现的值被剔除
  assert.deepEqual(seen, [{ TARGET: "gold-417" }]);
});

test("normalizeWrapupWithLlm parses the evaluator response", async () => {
  const requests = [];
  const evaluator = {
    async chat(request) {
      requests.push(request);
      return {
        content: [{ type: "text", text: '{"done":true,"summary":"归一化","output":"结果"}' }],
      };
    },
  };

  const result = await normalizeWrapupWithLlm("已经完成了", evaluator, {
    signal: "signal",
    maxTokens: 64,
    temperature: 0,
  });

  assert.deepEqual(result, { done: true, summary: "归一化", output: "结果" });
  assert.equal(requests[0].signal, "signal");
  assert.equal(requests[0].maxTokens, 64);
  assert.equal(requests[0].temperature, 0);
  assert.match(requests[0].messages[0].content[0].text, /已经完成了/);
});

// issue #419 ①：归一化调用必须**总是**带「不思考」，且不新增任何对外选项（三格一起钉住：
// 不传选项 / 传全选项 / 函数式 evaluator 分支），并落到真 provider 的 HTTP 请求体上。
test("normalizeWrapupWithLlm always sends reasoning_effort:none (issue #419)", async () => {
  const requests = [];
  const evaluator = {
    async chat(request) {
      requests.push(request);
      return { content: [{ type: "text", text: '{"done":true,"summary":"s","output":"o"}' }] };
    },
  };

  // ① 不传任何选项：字段仍然在场（默认语义，不是 opt-in）
  await normalizeWrapupWithLlm("已完成", evaluator);
  // ② 传全选项：字段不被调用方参数冲掉
  await normalizeWrapupWithLlm("已完成", evaluator, {
    signal: new AbortController().signal,
    maxTokens: 120,
    temperature: 0,
  });
  // ③ 函数式 evaluator（`typeof evaluator === "function"` 那条分支）拿到的也是同一份请求
  let functionFormRequest;
  await normalizeWrapupWithLlm("已完成", async (request) => {
    functionFormRequest = request;
    return { content: [{ type: "text", text: '{"done":true,"summary":"s","output":"o"}' }] };
  });

  assert.equal(requests.length, 2);
  for (const request of [...requests, functionFormRequest]) {
    assert.equal(request.reasoning_effort, "none");
  }
  // 反向钉：不该多出别的思考开关（只跟 judge 的既有写法一致，不自创第三种）
  assert.equal(Object.hasOwn(requests[0], "thinking"), false);
  assert.equal(Object.hasOwn(requests[0], "enable_thinking"), false);
  assert.equal(Object.hasOwn(requests[0], "chat_template_kwargs"), false);
});

test("normalizeWrapupWithLlm lands reasoning_effort:none in the real provider request body (issue #419)", async () => {
  const fetchImpl = createMockFetch([{
    json: {
      choices: [{
        message: { content: '{"done":true,"summary":"归一化","output":"结果"}' },
        finish_reason: "stop",
      }],
    },
  }]);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "qwen3.8-flash-next",
    fetchImpl,
  });

  const result = await normalizeWrapupWithLlm("已经完成了", provider, {
    maxTokens: 120,
    temperature: 0,
  });

  assert.deepEqual(result, { done: true, summary: "归一化", output: "结果" });
  // 「发出的请求体里必须有那个字段」——这里读的是 fetch 真正收到的那份 body
  const body = fetchImpl.calls[0].body;
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.max_tokens, 120);
  assert.equal(body.temperature, 0);
});

test("arbitrary JSON in prose is not mistaken for a wrapup marker (reviewer #1)", () => {
  assert.equal(tryParseWrapupJson('配置应为 {"timeout": 30} 即可生效。'), null);
  assert.equal(tryParseWrapupJson("结果 {} 见上"), null);
  assert.equal(tryParseWrapupJson('{"timeout":30}'), null);
});

test("legacy erix-summary marker is not parsed as wrapup (reviewer #10)", async () => {
  // 真 legacy marker：action/note 键 → 不应被误判为 wrapup，finalText 不被 output/summary 覆盖
  const provider = createFakeProvider([
    {
      content: [{
        type: "text",
        text: '做了些工作<erix-summary>{"action":"debug","note":"修复 replica"}</erix-summary>',
      }],
      stopReason: "end_turn",
    },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "任务",
    executeTool: async () => "ok",
    completion: false,
  });
  assert.equal(result.rounds, 1);
  // finalText 保持原文（无 output/summary 覆盖），仅剥 erix-summary 标记
  assert.ok(result.finalText.includes("做了些工作"));
  assert.ok(!result.finalText.includes("erix-summary"));
});

test("non-JSON end-turn without signals falls back to noToolStreak (reviewer #3)", async () => {
  // 归一化默认关闭（ERIX_WRAPUP_NORMALIZE 未设），专注验证 noToolStreak 兜底
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    completion: { signals: [], maxNoToolRounds: 3 },
  });
  // First no-tool round starts the streak; cap at 3 consecutive no-tool rounds.
  assert.equal(result.rounds, 4);
  assert.ok(["end_turn", "no_tool"].includes(result.termination.reason));
});

test("wrapup summary is recorded into runningLog with source json (reviewer #3)", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "text", text: '{"done":false,"summary":"阶段进展"}' }],
      stopReason: "end_turn",
    },
    { content: [{ type: "text", text: '{"done":true,"output":"收尾"}' }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  await runToolLoop({
    provider,
    initialUserMessage: "任务",
    executeTool: async () => "ok",
    completion: false,
    store,
    runId: "wrapup-log",
  });
  const records = await store.load("wrapup-log");
  const first = records.find((r) => r.round === 1);
  assert.equal(first.wrapup.summary, "阶段进展");
  assert.equal(first.wrapup.done, false);
  const last = records.find((r) => r.round === 2);
  assert.equal(last.wrapup.output, "收尾");
  assert.equal(last.wrapup.done, true);
});

test("normalizeWrapupWithLlm degrades on garbage evaluator output (reviewer #4)", async () => {
  const badEvaluator = {
    async chat() {
      return { content: [{ type: "text", text: "这不是 JSON" }] };
    },
  };
  assert.equal(await normalizeWrapupWithLlm("已完成", badEvaluator), null);

  const throwingEvaluator = {
    async chat() {
      throw new Error("boom");
    },
  };
  await assert.rejects(
    normalizeWrapupWithLlm("已完成", throwingEvaluator),
    /boom/,
  );
});

test("non-JSON end-turn triggers LLM normalization and done:true stops (loop wiring)", async () => {
  const prev = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_WRAPUP_NORMALIZE = "1";
  try {
    const sequence = createFakeProvider([
      { content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "做完了" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: '{"done":true,"summary":"归一化完成","output":"好了"}' }], stopReason: "end_turn" },
    ]);
    const result = await runToolLoop({
      provider: sequence,
      initialUserMessage: "工作",
      executeTool: async () => "ok",
      completion: { signals: [], maxNoToolRounds: 3 },
    });
    assert.equal(result.rounds, 2);
    assert.equal(result.finalText, "好了");
  } finally {
    if (prev === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = prev;
  }
});

test("done:false with completion word in text keeps going (reviewer #6)", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "text", text: '{"done":false,"summary":"还需确认一步"}' }],
      stopReason: "end_turn",
    },
    { content: [{ type: "text", text: '{"done":true,"output":"完成"}' }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    completion: { signals: ["已完成"], maxNoToolRounds: 3 },
  });
  // done:false 即使文本含完成词也继续（协议 done 优先）；下一轮 done:true 停
  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, "完成");
});

test("empty-text end_turn also triggers normalization (找不到 JSON 就该归一化)", async () => {
  const prev = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_WRAPUP_NORMALIZE = "1";
  try {
    // 模型超难任务放弃：空文本 end_turn（无 tool_use、无 text）
    const sequence = createFakeProvider([
      { content: [{ type: "text", text: "" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: '{"done":true,"summary":"模型空输出","output":"无结论"}' }], stopReason: "end_turn" },
    ]);
    const result = await runToolLoop({
      provider: sequence,
      initialUserMessage: "做一件不可能的事",
      executeTool: async () => "ok",
      completion: { signals: [], maxNoToolRounds: 3 },
    });
    // 空文本触发归一化 → judge 判 done:true → 1 轮停（非拖 3 轮 noToolStreak）
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.termination, { reason: "end_turn" });
    assert.equal(result.finalText, "无结论");
  } finally {
    if (prev === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = prev;
  }
});

// --- issue #307：`tryParseWrapupJson` **不迁**到公共入口，这里把「不迁的理由」钉成断言 ---

test("tryParseWrapupJson 不迁 parseModelJson：不合格候选必须被跳过，而不是让整次解析失败（#307）", () => {
  // 本文件的形状门槛（done 必须字面布尔 / 出现 action|note 就退回内联 L1）比 requireKeys 的
  // 键存在性判定严，且**不合格要续试下一个**：公共入口只返回单个 value，迁过去就会
  // 在这里返回 {"done":"true"} 而把行为改掉 —— 下面第二组断言就是这条差异的实据。
  assert.deepEqual(tryParseWrapupJson('{"done":"true"}{"done":true}'), { done: true, summary: "", output: "" });
  assert.deepEqual(tryParseWrapupJson('{"action":"implement","done":true}{"done":true,"summary":"s"}'), {
    done: true,
    summary: "s",
    output: "",
  });
  assert.equal(tryParseWrapupJson('{"done":true,"action":"implement"}'), null);
  // 内层 {"done":...} 不得绕过 mandatory-done 守卫（issue #30 follow-up，扫描只认顶层对象）
  assert.equal(tryParseWrapupJson('{"summary":"host","metadata":{"done":true}}'), null);

  // 差异实据：同一个输入走公共入口会在第一个候选停下（值还带着非法的字符串 done）
  const viaEntry = parseModelJson('{"done":"true"}{"done":true}', { requireKeys: ["done"] });
  assert.equal(viaEntry.ok, true);
  assert.deepEqual(viaEntry.value, { done: "true" });
});
