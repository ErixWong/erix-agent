import test from "node:test";
import assert from "node:assert/strict";
import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 F-1 的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：F-1 把 `readLoopPayload` / `verificationReader` / `judgeRecordCorrelation` /
// `judgeRecordCount` 四个「治理记账 / 记录关联」闭包 `let` 迁进 `runLoopState`。这四格的
// 特殊形状在于：**初值是默认桩，真值由后面的原位赋值接管**（issue #180 / #165 的「可变槽位」
// 手法）。于是同一格有两条彼此独立的可观察路径：
//   · **接管前**：`restoreResume` 的 catch 里 `ctx.fail()`（实测 `resume-manager.js:271`）是
//     全仓唯一一次早于接管点的 `fail()`——它必须读到默认桩（usage 全 0 / rounds 0 /
//     finalText ""），且 `run_outcome` **不带** `verification` 字段；
//   · **接管后**：主 try 的 `fail()` 必须读到累计量实值与真实 verification。
// 任一格搬坏（写成 `undefined`、丢掉接管赋值、读点指错格子）都必须在下面某条用例上变红。

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

// —— M1：readLoopPayload / verificationReader ——

test("F-1 早退路径：接管前的 fail() 读到默认桩（usage 全 0 / rounds 0 / 无 verification 字段）", async () => {
  // 空 store + resume:true ⇒ restoreResume 在 `records.length === 0` 处抛，catch 里调
  // ctx.fail()：这是唯一一次**早于** `:1578` / `:1595` 两处接管赋值的 fail()。
  const store = createMemoryTranscriptStore();
  const events = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "never reached" }], stopReason: "end_turn" },
  ]);

  await assert.rejects(
    () => runDirect({
      provider,
      store,
      resume: true,
      runId: "governance-early-exit",
      initialUserMessage: "task",
      executeTool: async () => "unused",
      maxRounds: 2,
      completion: false,
      reflection: false,
      // 有 finalGuard：接管后的 verification 会是 {status:"unverified"...}；
      // 早退路径读到的是默认桩 ⇒ 字段必须**缺席**，而不是写一个假状态。
      capabilities: {
        hooks: {
          finalGuard: async () => ({ action: "accept" }),
          onEvent: (event) => events.push(event),
        },
      },
    }),
    (error) => {
      assert.match(error.message, /无可恢复记录/);
      assert.equal(provider.requests.length, 0, "失败发生在任何模型调用之前");
      // 默认桩的三个值（issue #180：字段形状恒成立，但值是「无用量」）
      assert.deepEqual(error.usage, { input_tokens: 0, output_tokens: 0 });
      assert.equal(error.rounds, 0);
      assert.equal(error.finalText, "");
      return true;
    },
  );

  const outcomes = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcomes.length, 1, "抛错终局同样留一条 run 级汇总");
  assert.equal(outcomes[0].termination.reason, "failed");
  assert.equal(outcomes[0].rounds, 0);
  assert.ok(
    !("verification" in outcomes[0]),
    "verification 尚未进入作用域 ⇒ 不写字段（条件展开 :998），而不是写假状态",
  );
});

test("F-1 接管路径：接管后的 fail() 读到累计量实值与真实 verification", async () => {
  const events = [];
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "ls" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    { throw: new Error("upstream blew up after takeover") },
  ]);

  await assert.rejects(
    () => runDirect({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 3,
      completion: false,
      reflection: false,
      capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    }),
    (error) => {
      assert.match(error.message, /blew up after takeover/);
      // 接管闭包读的是真实的 `usage` / `runLoopState.rounds` / `finalText`
      assert.equal(error.usage.input_tokens, 7);
      assert.equal(error.usage.output_tokens, 3);
      assert.equal(error.rounds, 1);
      assert.equal(error.finalText, "");
      return true;
    },
  );

  const outcomes = events.filter((event) => event.type === "run_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].rounds, 1);
  assert.deepEqual(
    outcomes[0].verification,
    { status: "skipped", reason: "no_final_guard" },
    "verificationReader 已接管 ⇒ run_outcome 带的是 verification 变量的实值",
  );
});

// —— M2：judgeRecordCorrelation / judgeRecordCount ——

const ON_TRACK = {
  done: true,
  confidence: 0.9,
  reason: "已完成",
  evidence: "验证通过",
  direction: "on_track",
  directionReason: "已接近验证",
};

const judgeResponse = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

// 同一份 round-judge fixture，唯一变量是**宿主有没有挂 onJudge**：
// 两条用例合起来把「关联字段来自接管后的格子」与「计数只在真的送达时才 +1」分别钉死。
async function runJudgeCase({ withOnJudge }) {
  const records = [];
  const events = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([judgeResponse(ON_TRACK)]);
  const result = await runDirect({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 4,
    completion: false,
    reflection: { enabled: true, roundJudge: true, judge: { provider: judge } },
    capabilities: {
      hooks: {
        ...(withOnJudge ? { onJudge: (info) => records.push(info) } : {}),
        onEvent: (event) => events.push(event),
      },
    },
    runId: "governance-m2",
  });
  return { records, events, result, outcome: events.filter((e) => e.type === "run_outcome")[0] };
}

test("F-1 judge 决策的关联字段来自接管后的格子，run_outcome 的计数与实收记录数一致", async () => {
  const { records, outcome, result } = await runJudgeCase({ withOnJudge: true });
  assert.equal(records.length, 1, "fixture 必须真的产生一条 judge 决策");
  // emitJudge 的展开读点：...runLoopState.judgeRecordCorrelation 必须先铺上 runId + model
  assert.equal(records[0].runId, "governance-m2");
  assert.equal(records[0].model, "fake-model");
  assert.ok(!("judgeModel" in records[0]), "judge 与 run 同模型 ⇒ 不写冗余字段（字段缺省语义）");
  assert.equal(records[0].action, "judge_done", "既有决策字段语义不动（additive）");
  // emitRunOutcome 的展开读点 + 对象简写读点（键名必须是 judgeRecordCount）
  assert.equal(outcome.runId, "governance-m2");
  assert.equal(outcome.model, "fake-model");
  assert.equal(outcome.judgeRecordCount, records.length);
  assert.equal(outcome.termination.reason, result.termination.reason);
});

test("F-1 没挂 onJudge 时 judge 决策照样生效但不计数（+= 留在早退之后的原分支）", async () => {
  const { records, outcome } = await runJudgeCase({ withOnJudge: false });
  assert.equal(records.length, 0);
  // judge 确实跑了（决策改变了终局）⇒ 不是「整条 judge 路径没执行」的空断言
  assert.equal(outcome.termination.reason, "judge_done");
  assert.equal(
    outcome.judgeRecordCount,
    0,
    "宿主没挂 onJudge ⇒ 一条都没送达 ⇒ 计数保持初值 0",
  );
});
