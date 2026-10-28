import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 **F-2** 的行为锚定测试（纯新增，不改任何既有断言语义）——M2 两格。
//
// 为什么存在：`judgeInterceptCount`（原 :1228）与 `interceptJudgeDecision`（原 :1229）是 F 组里
// 唯一**在 orchestrator 内一次裸读写都没有**的两格：它们的全部可观察面都在**另两个文件**里，
// 经过**两个 ctx 对象上的四枚访问器**：
//   · `run-snapshot-executor.js:377` 读 `ctx.judgeInterceptCount >= ctx.judgeIntervalRound`
//     → 决定这次工具调用要不要审计；`:379` `+= 1`（未审计时累计）；`:416` 与 `:516` 复位 `= 0`；
//   · `run-snapshot-executor.js:424` 判 `ctx.interceptJudgeDecision === undefined`、`:425` 写入
//     nearLimit 时的扩轮决策 → 决策由 orchestrator 的轮内读点接走（每轮开头 `= undefined` 复位）；
//   · `resume-manager.js:227` 用 resume 快照里「已执行工具数」给计数**播种**。
// 所以两格的任何一格搬坏（访问器只委托一半、委托到错的格子、复位丢失）都表现为**拦截节奏**或
// **扩轮决策**这两个可观察量发生变化——下面各用例断言的正是这两件事：评估器的**请求条数与所在轮**、
// judge 记录的 kind/轮号、run 的轮数，以及落盘 round 记录上的 `judge` 字段有无。

const toolResponse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

const judgeResponse = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  stopReason: "end_turn",
});

const END = { content: [{ type: "text", text: "最终结论" }], stopReason: "end_turn" };

// 关掉归一化：它与 intercept 共用 judge provider，会把计数断言搅浑（与既有拦截用例同一手法）。
function withNormalizationOff(run) {
  const previous = process.env.ERIX_WRAPUP_NORMALIZE;
  process.env.ERIX_WRAPUP_NORMALIZE = "";
  return run().finally(() => {
    if (previous === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = previous;
  });
}

// —— judgeInterceptCount：runSnapshotContext 那一对访问器（executor 的读 / += / 复位全走它）——

test("F-2 judgeInterceptCount 经 runSnapshotContext：interval=1 时第三次工具不审计（+= 1 与审计后复位各自生效）", async () => {
  await withNormalizationOff(async () => {
    const provider = createFakeProvider([
      toolResponse("w1", "work", { step: 1 }),
      toolResponse("w2", "work", { step: 2 }),
      toolResponse("w3", "work", { step: 3 }),
      { content: [{ type: "text", text: '{"done":true,"output":"收尾"}' }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([judgeResponse({ done: true, confidence: 0.9, reason: "继续", evidence: "仍在方向" })]);
    const records = [];
    const executed = [];
    await runDirect({
      provider,
      initialUserMessage: "task",
      executeTool: async ({ input }) => {
        executed.push(input.step);
        return "ok";
      },
      maxRounds: 5,
      completion: false,
      reflection: { enabled: true, roundJudge: false, judgeIntervalRound: 1, judge: { provider: judge } },
      capabilities: { hooks: { onJudge: (info) => records.push(info) } },
    });
    // 工具1 只累计（+= 1）→ 工具2 计数到顶被审计并复位 → 工具3 计数不足 ⇒ 全程只审计一次
    assert.deepEqual(executed, [1, 2, 3]);
    assert.equal(judge.requests.length, 1, "计数没写进格子（或复位没生效）就会多审/少审");
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "intercept", "非扩轮审计走 kind: intercept + tool 字段（既有契约）");
    assert.equal(records[0].action, "executed");
    assert.equal(records[0].tool.id, "w2");
  });
});

// —— judgeInterceptCount：restoreResume 入参 ctx 那一对访问器（resume-manager:227 的播种写点）——

test("F-2 judgeInterceptCount 经 restoreResume ctx：resume 播种已执行工具数 ⇒ 续接的第一次工具就被审计", async () => {
  await withNormalizationOff(async () => {
    const store = createMemoryTranscriptStore();
    const runId = "resume-intercept-seed";
    await store.appendRound(runId, { round: 0, messages: [{ role: "user", content: "task" }] });
    await store.saveCheckpoint(runId, {
      round: 1,
      pendingToolUses: [{ type: "tool_use", id: "b", name: "work", input: { step: "b" } }],
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "work", input: { step: "a" } },
            { type: "tool_use", id: "b", name: "work", input: { step: "b" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "done-a" }] },
      ],
      executedToolIds: ["a"],
      toolResults: [{ toolUseId: "a", toolResult: { type: "tool_result", tool_use_id: "a", content: "done-a" } }],
    });
    const provider = createFakeProvider([
      { content: [{ type: "text", text: '{"done":true,"output":"收尾"}' }], stopReason: "end_turn" },
    ]);
    const judge = createFakeProvider([judgeResponse({ done: true, confidence: 0.9, reason: "继续", evidence: "仍在方向" })]);
    const records = [];
    await runToolLoop({
      provider,
      store,
      config: { run: { resume: true } },
      runId,
      completion: false,
      maxRounds: 6,
      executeTool: async () => "done-b",
      reflection: { enabled: true, roundJudge: false, judgeIntervalRound: 1, judge: { provider: judge } },
      capabilities: { hooks: { onJudge: (info) => records.push(info) } },
    });
    // 崩溃前已执行 1 个工具 ⇒ 计数播种为 1 ⇒ 续接的第一个工具（id b）就达到审计阈值
    assert.equal(judge.requests.length, 1, "播种写入没进格子（访问器只委托一半）就是 0 次审计");
    assert.equal(records.length, 1);
    assert.equal(records[0].tool.id, "b", "被审计的必须是续接回来的那次调用");
  });
});

// —— interceptJudgeDecision：写（executor:425）→ 读（orchestrator 轮内）——

const EXTEND_DECISION = {
  done: false,
  confidence: 0.8,
  reason: "仍需验证",
  evidence: "验证尚未完成",
  direction: "on_track",
  directionReason: "",
  extend: true,
  extendReason: "当前上限不足",
  plan: "完成最后验证",
};

async function runNearLimitIntercept({ maxExtensions = 1, withStore = false } = {}) {
  const store = withStore ? createMemoryTranscriptStore() : undefined;
  const provider = createFakeProvider([
    ...Array.from({ length: 6 }, (_value, index) => toolResponse(`work-${String(index + 1)}`, "work", { step: index + 1 })),
    END,
    END,
  ]);
  const judge = createFakeProvider([judgeResponse(EXTEND_DECISION), judgeResponse(EXTEND_DECISION), judgeResponse(EXTEND_DECISION)]);
  const records = [];
  const executed = [];
  const runId = withStore ? "intercept-decision-store" : "intercept-near-limit";
  const result = await runDirect({
    provider,
    runId,
    ...(store ? { store } : {}),
    initialUserMessage: "完成验证任务",
    executeTool: async ({ input }) => {
      executed.push(input.step);
      return "ok";
    },
    maxRounds: 5,
    completion: false,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 3,
      extensionStep: 2,
      maxExtensions,
      maxRoundsCap: 20,
      judge: { provider: judge },
    },
    capabilities: { hooks: { onJudge: (info) => records.push(info) } },
  });
  return { result, provider, judge, records, executed, store };
}

test("F-2 interceptJudgeDecision：nearLimit 拦截决策经访问器交回轮内，扩轮真的发生", async () => {
  await withNormalizationOff(async () => {
    const { result, judge, executed } = await runNearLimitIntercept();
    assert.equal(judge.requests.length, 1, "第 4 次工具被审计一次");
    assert.equal(result.rounds, 7, "决策被轮内读点接走 ⇒ 预算从 5 扩到 7；读点断链则停在 5");
    assert.equal(executed.length, 6);
  });
});

test("F-2 interceptJudgeDecision：决策被写进格子后落到当轮落盘记录的 judge 字段（跨文件写→读全链）", async () => {
  await withNormalizationOff(async () => {
    const { store, result } = await runNearLimitIntercept({ withStore: true });
    const records = (await store.load("intercept-decision-store"))
      .filter((record) => Number.isSafeInteger(record.round));
    const audited = records.find((record) => record.round === 4);
    assert.ok(audited, "第 4 轮的 round 记录必须落盘");
    assert.ok(audited.judge, "拦截决策经 interceptJudgeDecision 交给轮内 ⇒ 该轮记录带 judge 字段");
    assert.equal(audited.judge.extend, true);
    assert.equal(audited.judge.done, false);
  });
});

test("F-2 interceptJudgeDecision 复位：每轮开头写回 undefined，上一轮的决策不会漏到下一轮", async () => {
  await withNormalizationOff(async () => {
    // 不扩轮时第 5 轮就不会发生（maxExtensions:0 会在第 4 轮就收口），所以这里用默认 maxExtensions:1：
    // 第 4 轮被审计并存下决策（该轮记录带 judge），第 5/6/7 轮都是「没被审计的轮」：
    // 复位生效 ⇒ 这些轮都没有 judge 字段；复位丢失 ⇒ 第 4 轮的决策漏进它们的落盘记录。
    const { store, judge } = await runNearLimitIntercept({ withStore: true });
    const records = (await store.load("intercept-decision-store"))
      .filter((record) => Number.isSafeInteger(record.round));
    const audited = records.find((record) => record.round === 4);
    const following = records.filter((record) => record.round >= 5);
    assert.equal(judge.requests.length, 1, "全 run 只审计一次 ⇒ 只有第 4 轮可能携决策");
    assert.ok(audited?.judge, "第 4 轮（被审计那轮）带 judge 字段——本用例的前提");
    assert.equal(audited.judge.extend, true);
    assert.ok(following.length >= 2, `扩轮后的后续轮必须真的落盘（实测 ${String(following.length)} 轮）`);
    for (const record of following) {
      assert.ok(
        !("judge" in record),
        `第 ${String(record.round)} 轮凭空出现 judge 字段 ⇒ 每轮开头的 \`= undefined\` 复位丢失`,
      );
    }
  });
});
