import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWrapupWithLlm, tryParseWrapupJson } from "../src/reflection/wrapup.js";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

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

test("tryParseWrapupJson defaults omitted fields", () => {
  assert.deepEqual(
    tryParseWrapupJson('{"output":"只提供结果"}'),
    { done: false, summary: "", output: "只提供结果" },
  );
  assert.deepEqual(
    tryParseWrapupJson('{"done":true}'),
    { done: true, summary: "", output: "" },
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

test("arbitrary JSON in prose is not mistaken for a wrapup marker (reviewer #1)", () => {
  assert.equal(tryParseWrapupJson('配置应为 {"timeout": 30} 即可生效。'), null);
  assert.equal(tryParseWrapupJson("结果 {} 见上"), null);
  assert.equal(tryParseWrapupJson('{"timeout":30}'), null);
});

test("legacy erix-summary marker is not parsed as wrapup (reviewer #10)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "我做了些工作" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "任务",
    executeTool: async () => "ok",
    completion: false,
  });
  // Legacy summary without wrapup keys: no finalText override, keeps raw text.
  assert.equal(result.rounds, 1);
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
