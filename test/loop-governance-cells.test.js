import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
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
    () => runToolLoop({
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
      finalGuard: async () => ({ action: "accept" }),
      onEvent: (event) => events.push(event),
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
    () => runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 3,
      completion: false,
      reflection: false,
      onEvent: (event) => events.push(event),
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
