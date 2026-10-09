import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import {
  judgeRecordFields,
  resolveModelName,
  resolveRunModelName,
  runOutcomeRecord,
} from "../src/loop/judge-record.js";
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

const ON_TRACK = {
  done: true,
  confidence: 0.9,
  reason: "已完成",
  evidence: "验证通过",
  direction: "on_track",
  directionReason: "已接近验证",
};

// 一次 run：按给定脚本与 reflection 配置跑 loop，收集 judge 记录与事件流。
async function runCase({ provider, judge, reflection, options = {} }) {
  const records = [];
  const events = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 4,
    completion: false,
    ...(reflection === undefined
      ? {}
      : { reflection: { ...reflection, judge: { ...(reflection.judge ?? {}), provider: judge } } }),
    onJudge: (info) => records.push(info),
    onEvent: (event) => events.push(event),
    ...options,
  });
  return { records, events, result };
}

// 两条 judge 产生路径：roundJudge=true 走 orchestrator 的轮次评估，
// roundJudge=false + judgeIntervalRound=1 走 run-snapshot-executor 的工具拦截评估。
const ROUND_JUDGE = { enabled: true, roundJudge: true };
const INTERCEPT_JUDGE = { enabled: true, roundJudge: false, judgeIntervalRound: 1 };

test("model name resolution: provider/modelConfig/model_name, no hardcoding, no fake values", () => {
  assert.equal(resolveModelName({ model: "glm-4.6" }), "glm-4.6");
  // 与 provider 构造侧 `model ?? model_name` 同口径。
  assert.equal(resolveModelName({ model_name: "kimi-k2" }), "kimi-k2");
  assert.equal(resolveModelName("deepseek-v3"), "deepseek-v3");
  assert.equal(resolveModelName({ model: "  spaced  " }), "spaced");
  // 探不到就 undefined（调用方据此**不写字段**，而不是写 "unknown" 之类的假值）。
  assert.equal(resolveModelName(undefined), undefined);
  assert.equal(resolveModelName(null), undefined);
  assert.equal(resolveModelName({}), undefined);
  assert.equal(resolveModelName({ model: "" }), undefined);
  assert.equal(resolveModelName({ model: "   " }), undefined);
  assert.equal(resolveModelName({ model: 42 }), undefined);
  // 宿主自定义对象的 getter 抛错：按探不到处理，观测面绝不因日志字段而抛。
  assert.equal(resolveModelName({
    get model() {
      throw new Error("host getter blew up");
    },
  }), undefined);

  // 候选顺序与 modelMetadataFor() 一致：modelConfig → modelMetadata → model → provider → context。
  assert.equal(resolveRunModelName({
    modelConfig: { model: "slot-model" },
    provider: { model: "provider-model" },
  }), "slot-model");
  assert.equal(resolveRunModelName({
    provider: { model: "provider-model" },
    context: { model: "context-model" },
  }), "provider-model");
  assert.equal(resolveRunModelName({
    context: { model_name: "context-model" },
  }), "context-model");
  assert.equal(resolveRunModelName({}), undefined);
  assert.equal(resolveRunModelName(), undefined);
});

test("judge record correlation fields are additive and omit what cannot be resolved", () => {
  assert.deepEqual(judgeRecordFields({}), {});
  assert.deepEqual(judgeRecordFields({ runId: "", model: "  " }), {});
  assert.deepEqual(judgeRecordFields({ runId: "run-1", model: "glm-4.6" }), {
    runId: "run-1",
    model: "glm-4.6",
  });
  // judge 与 run 同模型时不写冗余的 judgeModel；不同才写（校准要能区分被评模型与评它的模型）。
  assert.deepEqual(judgeRecordFields({ model: "glm-4.6", judgeModel: "glm-4.6" }), {
    model: "glm-4.6",
  });
  assert.deepEqual(judgeRecordFields({ model: "glm-4.6", judgeModel: "gpt-5" }), {
    model: "glm-4.6",
    judgeModel: "gpt-5",
  });
  // 探不到被评模型时，judgeModel 也无处可比：只写探得到的那个。
  assert.deepEqual(judgeRecordFields({ judgeModel: "gpt-5" }), { judgeModel: "gpt-5" });
});

test("run outcome record shape", () => {
  assert.deepEqual(runOutcomeRecord({
    runId: "run-1",
    model: "glm-4.6",
    rounds: 3,
    judgeRecordCount: 2,
    termination: { reason: "judge_done" },
    verification: { status: "skipped", reason: "no_final_guard" },
  }), {
    type: "run_outcome",
    runId: "run-1",
    model: "glm-4.6",
    rounds: 3,
    judgeRecordCount: 2,
    termination: { reason: "judge_done" },
    verification: { status: "skipped", reason: "no_final_guard" },
  });
  // 缺项一律不写成假值。
  assert.deepEqual(runOutcomeRecord({ termination: { reason: "failed", errorCode: "unknown" } }), {
    type: "run_outcome",
    termination: { reason: "failed", errorCode: "unknown" },
  });
  assert.deepEqual(runOutcomeRecord({}), { type: "run_outcome" });
  // termination/verification 是副本：宿主改记录不得回写 run 终局对象。
  const termination = { reason: "end_turn" };
  const record = runOutcomeRecord({ termination });
  record.termination.reason = "mutated";
  assert.equal(termination.reason, "end_turn");
});

test("every judge record carries runId and the resolved run model (both producer paths)", async () => {
  const cases = [
    {
      label: "round judge（orchestrator 产生路径）",
      reflection: ROUND_JUDGE,
      provider: createFakeProvider([
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      ]),
      judge: createFakeProvider([judgeResponse(ON_TRACK)]),
      expectKind: "round",
    },
    {
      label: "intercept judge（run-snapshot-executor 产生路径）",
      reflection: INTERCEPT_JUDGE,
      // 透明拦截的计数口径：先跑一次真工具，**下一次**调用才被审计——故需两次工具调用。
      provider: createFakeProvider([
        toolResponse("first", "work", { step: 1 }),
        toolResponse("second", "writeFile", { path: "a.txt", content: "x" }),
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn", times: 3 },
      ]),
      judge: createFakeProvider([
        judgeResponse({ ...ON_TRACK, done: false, confidence: 0.4 }),
      ]),
      expectKind: "intercept",
    },
  ];

  for (const testCase of cases) {
    const { records } = await runCase({
      provider: testCase.provider,
      judge: testCase.judge,
      reflection: testCase.reflection,
      options: { runId: "run-165" },
    });

    assert.ok(records.length > 0, `${testCase.label}：应产生 judge 记录`);
    assert.ok(
      records.some((record) => record.kind === testCase.expectKind),
      `${testCase.label}：应出现 kind=${testCase.expectKind}`,
    );
    for (const record of records) {
      assert.equal(record.runId, "run-165", testCase.label);
      assert.equal(record.model, "fake-model", `${testCase.label}：模型名来自 provider（不硬编码）`);
      assert.ok(!("judgeModel" in record), `${testCase.label}：judge 与 run 同模型时不写冗余字段`);
    }
  }

  // 既有字段/语义不动（additive）：决策与动作字段照旧在。
  const roundRun = await runCase({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    judge: createFakeProvider([judgeResponse(ON_TRACK)]),
    reflection: ROUND_JUDGE,
  });
  const roundRecord = roundRun.records.find((record) => record.kind === "round");
  assert.equal(roundRecord.action, "judge_done");
  assert.equal(roundRecord.decision.done, true);
  assert.equal(roundRecord.round, 1);
  assert.ok("raw" in roundRecord, "旧字段 raw 照旧在");
});

test("judgeModel is recorded only when the judge runs on a different model", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([judgeResponse(ON_TRACK)]);
  Object.defineProperty(judge, "model", { value: "judge-only-model", configurable: true });

  const { records } = await runCase({
    provider,
    judge,
    reflection: ROUND_JUDGE,
  });

  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.model, "fake-model");
    assert.equal(record.judgeModel, "judge-only-model");
  }
});

test("no model/runId configuration means the fields are absent, not fake", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  // 宿主没给模型名（provider 上探不到 model/model_name），也没给 runId。
  delete provider.model;
  const judge = createFakeProvider([judgeResponse(ON_TRACK)]);
  delete judge.model;

  const { records, events } = await runCase({ provider, judge, reflection: ROUND_JUDGE });

  assert.ok(records.length > 0, "judge 记录照旧产生");
  for (const record of records) {
    assert.ok(!("model" in record), `不该写假模型名：${JSON.stringify(record)}`);
    assert.ok(!("runId" in record));
    assert.ok(!("judgeModel" in record));
  }
  const outcome = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcome.length, 1);
  assert.ok(!("model" in outcome[0]));
  assert.ok(!("runId" in outcome[0]));
});

test("model name also resolves from modelConfig slots when the provider hides it", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  delete provider.model;
  const judge = createFakeProvider([judgeResponse(ON_TRACK)]);

  const { records } = await runCase({
    provider,
    judge,
    reflection: ROUND_JUDGE,
    options: {
      modelConfig: {
        resolve: async () => ({
          model: "slot-a-model",
          contextWindowTokens: 131072,
          maxOutputTokens: 32768,
        }),
      },
      session: { id: "slot-run", modelSlot: "a" },
    },
  });

  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record.model, "slot-a-model");
  }
});

test("exactly one run_outcome record per run joins the streamed decisions by runId", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([judgeResponse(ON_TRACK)]);

  const { records, events, result } = await runCase({
    provider,
    judge,
    reflection: ROUND_JUDGE,
    options: { runId: "run-join" },
  });

  const outcomes = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcomes.length, 1, "一次 run 恰好一条终局汇总");
  const [outcome] = outcomes;
  assert.equal(outcome.kind, undefined, "汇总记录不带 kind（决策流的判别键不受污染）");
  assert.equal(outcome.action, undefined);
  assert.equal(outcome.runId, "run-join");
  assert.equal(outcome.model, "fake-model");
  assert.equal(outcome.termination.reason, "judge_done");
  assert.equal(outcome.verification.status, "skipped");
  assert.equal(outcome.rounds, result.rounds);
  // join 完整性：judgeRecordCount 与本 run 流出的决策条数一致（宿主可据此发现掉行）。
  assert.equal(outcome.judgeRecordCount, records.length);
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.runId === outcome.runId));
  // 终局事件是事件流的末条（append-only：不回头改写既有事件与决策记录）。
  assert.equal(events.at(-1).type, "run_outcome");
});

test("run_outcome carries verification once a final guard ran", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const events = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 2,
    completion: false,
    reflection: false,
    finalGuard: async () => ({ action: "accept" }),
    runId: "run-guard",
    onEvent: (event) => events.push(event),
  });

  const [outcome] = events.filter((event) => event.type === "run_outcome");
  assert.deepEqual(outcome.verification, result.verification);
  assert.equal(outcome.verification.status, "verified");
  assert.deepEqual(outcome.termination, result.termination);
});

test("run_outcome is also emitted on the throwing terminal path (abort/failed)", async () => {
  const provider = createFakeProvider([]);
  provider.chat = async () => {
    throw new Error("upstream blew up");
  };
  const events = [];
  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "unused",
      maxRounds: 2,
      completion: false,
      reflection: false,
      runId: "run-failed",
      onEvent: (event) => events.push(event),
    }),
  );

  const outcomes = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcomes.length, 1, "抛错终局同样留一条汇总（没终局的 run 会被账本当成没跑过）");
  assert.equal(outcomes[0].runId, "run-failed");
  assert.equal(outcomes[0].model, "fake-model");
  assert.equal(outcomes[0].termination.reason, "failed");
  assert.equal(outcomes[0].termination.errorCode, "unknown");
  assert.equal(outcomes[0].judgeRecordCount, 0);
  assert.ok("verification" in outcomes[0], "verification 已进入作用域 → 携带");
});

test("aborted runs get exactly one run_outcome with reason aborted", async () => {
  const controller = new AbortController();
  const events = [];
  const provider = createFakeProvider([
    toolResponse("t1", "exec", { command: "ls" }),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => {
        controller.abort();
        return "ok";
      },
      maxRounds: 4,
      completion: false,
      reflection: false,
      signal: controller.signal,
      runId: "run-abort",
      onEvent: (event) => events.push(event),
    }),
  );

  const outcomes = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcomes.length, 1, "去重门：finish/fail 不得双发");
  assert.equal(outcomes[0].termination.reason, "aborted");
  assert.equal(outcomes[0].runId, "run-abort");
});

test("a host callback throwing on run_outcome never changes the run outcome", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "unused",
    maxRounds: 2,
    completion: false,
    reflection: false,
    onEvent: (event) => {
      if (event.type === "run_outcome") throw new Error("host log blew up");
    },
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
});
