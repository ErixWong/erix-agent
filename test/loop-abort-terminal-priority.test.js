import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";

// issue #282（0.20.0 发版阻断项）：终局裁决的 `stop` 分支原先**不看** `signal.aborted`。
// 用户在「模型已给出最后一轮回答、end-turn judge 正在评估/已返回」的窗口里点停止，run 会
// 照原样跑完 judge（**再多烧一次模型调用**），终态被判成 `judge_done`——中止语义
// （`reason:"aborted"` / `partial` / `usage` / `rounds`）全部丢失。
//
// 本文件是那条优先级链的回归门：**`aborted` 永远优先于 judge / finalGuard**
// （裁决表见 docs/termination-decision-table.md，契约见 docs/host-consumer-contract*.md）。
//
// 「模型请求次数」的可核对口径：主模型走 `provider.chat`，judge 走 `reflection.judge.evaluator`，
// 两者各计一次——任何一次多出来的调用都是真金白银（宿主实测 judge 单轮可达数十秒）。

const FINAL_TEXT = "交付完成：全部改动已落盘";
const JUDGE_DONE_TEXT = JSON.stringify({
  done: true,
  confidence: 0.95,
  reason: "任务已交付",
  evidence: "writeFile 成功且终稿已给出",
  direction: "on_track",
});

const judgeDoneResponse = {
  content: [{ type: "text", text: JUDGE_DONE_TEXT }],
  stopReason: "end_turn",
  usage: { input_tokens: 120, output_tokens: 24 },
};

const finalTextResponse = {
  content: [{ type: "text", text: FINAL_TEXT }],
  stopReason: "end_turn",
  usage: { input_tokens: 800, output_tokens: 12 },
};

/**
 * 一个把「主模型调用」与「judge 模型调用」分开计数的 run 脚手架。
 * judge 用 `reflection.judge.evaluator` 注入，这样它的调用次数与主模型彻底解耦。
 */
function makeHarness({ judgeEvaluator, onMainCall, store } = {}) {
  const mainCalls = [];
  const judgeCalls = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests: mainCalls,
    async chat(request) {
      mainCalls.push(request);
      onMainCall?.();
      return { ...finalTextResponse };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
  const reflection = {
    enabled: true,
    roundJudge: true,
    judge: {
      evaluator: async (request) => {
        judgeCalls.push(request);
        return judgeEvaluator
          ? judgeEvaluator(request)
          : { ...judgeDoneResponse };
      },
    },
  };
  return {
    provider,
    reflection,
    mainCalls,
    judgeCalls,
    modelCallCount: () => mainCalls.length + judgeCalls.length,
    ...(store === undefined ? {} : { store }),
  };
}

async function settle(promise) {
  return await promise.then(() => null, (error) => error);
}

// ── 判据 1（本单的主红测）：judge 已返回、终局尚未定 ⇒ 终态必须是 aborted ──────────────
test("abort in the window after the end-turn judge returns terminates as aborted, not judge_done (issue #282)", async () => {
  const controller = new AbortController();
  const harness = makeHarness();
  const run = runToolLoop({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    signal: controller.signal,
    // `onJudge` 是宿主回调，调用点正好落在「judge 已返回、终局尚未定」这一段——
    // 也就是宿主用户点停止的真实时刻。
    onJudge: () => controller.abort(new Error("user stop")),
  });

  const error = await settle(run);
  assert.ok(error, "中止仍然必须抛错（#180 的「abort = 抛错」语义不回退）");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "judge_done");
  assert.equal(error?.termination?.partial, true, "aborted 终局必须带 partial 载荷旗子");
  assert.ok(error?.termination?.usage, "aborted 终局必须带已发生的 usage（#180）");
  assert.equal(error?.termination?.rounds, 1);
  assert.equal(error?.termination?.detail !== undefined, true, "detail 仍可解释中止原因");
  assert.equal(error?.finalText, FINAL_TEXT, "已产出的终稿文本必须保留（不是丢成空串）");
});

// ── 判据 2（反向）：judge 请求仍在飞的时候就中止 ⇒ 同样 aborted，行为不回退 ─────────────
test("abort during the judge call still terminates as aborted (issue #282 反向)", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    // 中止落在 judge 请求仍在飞期间（早于它返回）：这条路径改前就能抓住，本测试是**不回退**门。
    judgeEvaluator: async () => {
      controller.abort(new Error("user stop"));
      return { ...judgeDoneResponse };
    },
  });

  const error = await settle(runToolLoop({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    signal: controller.signal,
  }));

  assert.ok(error, "中止仍然必须抛错");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "judge_done");
  assert.equal(error?.termination?.partial, true);
});

// ── 判据 3：中止之后 judge 不得再发起模型调用（防「为了修文案而继续烧钱」）───────────────
test("once aborted, the end-turn judge must not issue another model call (issue #282 判据 3)", async () => {
  const controller = new AbortController();
  // 把中止精确落在「主模型已经吐完这一轮、end-turn judge 尚未发起」的窗口：
  // 假 provider 不看 signal，所以中止一定先落在 signal 上、再走到 judge 的入口守卫。
  const harness = makeHarness({ onMainCall: () => controller.abort(new Error("user stop")) });

  const error = await settle(runToolLoop({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    signal: controller.signal,
  }));

  assert.ok(error, "中止仍然必须抛错");
  assert.equal(error?.termination?.reason, "aborted");
  assert.equal(harness.mainCalls.length, 1, "主模型只该被调用一次");
  assert.equal(harness.judgeCalls.length, 0, "中止后不得再发起 judge 模型调用（省一次模型费用）");
  assert.equal(harness.modelCallCount(), 1, "整次 run 的模型请求次数必须是 1（issue #282 改前为 2）");
});
