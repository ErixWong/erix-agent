import assert from "node:assert/strict";
import test from "node:test";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #282（0.20.0 发版阻断项）：终局裁决的 `stop` 分支原先**不看** `signal.aborted`。
// 用户在「模型已给出最后一轮回答、end-turn judge 正在评估/已返回」的窗口里点停止，run 会
// 照原样跑完 judge（**再多烧一次模型调用**），终态被判成 `judge_done`——中止语义
// （`reason:"aborted"` / `partial` / `usage` / `rounds`）全部丢失。
//
// 本文件是那条优先级链的回归门：**`aborted` 永远优先于 judge / finalGuard**
// （裁决表见 docs/termination-decision-table.md，契约见 docs/host-consumer-contract*.md）。
//
// 「模型请求次数」的可核对口径：主模型走 `provider.chat`，judge 走 `capabilities.ports.judgeProvider`，
// 两者各计一次——任何一次多出来的调用都是真金白银（宿主实测 judge 单轮可达数十秒）。
//
// #498 S4c：本文件原先用 `reflection.judge.evaluator` 注入 judge（它与 `judge.provider` 是同一行
// `??` 的纯别名）。0.28 退役了那个别名（现在启动即抛，并指向 `capabilities.ports.judgeProvider`），
// 所以脚手架改用**规范之家**的端口位——判据一字未改。

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
 * judge 用 `capabilities.ports.judgeProvider` 注入，这样它的调用次数与主模型彻底解耦。
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
  const reflection = { enabled: true, roundJudge: true };
  const capabilities = {
    ports: {
      judgeProvider: async (request) => {
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
    capabilities,
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
  const run = runDirect({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    capabilities: {
      ...harness.capabilities,
      // `onJudge` 是宿主回调，调用点正好落在「judge 已返回、终局尚未定」这一段——
      // 也就是宿主用户点停止的真实时刻。
      hooks: { onJudge: () => controller.abort(new Error("user stop")) },
    },
    signal: controller.signal,
  });

  const error = await settle(run);
  // `hooks` 与 `ports` 必须**同场**（本格是 `{ ...harness.capabilities, hooks }` 的展开合并，
  // 不是并列两个 `capabilities` 键）：并列键是对象字面量重复键、**后者静默胜**，`ports.judgeProvider`
  // 会被吃掉，judge 回落到主 provider（`judgeProviderPort ?? judge?.provider ?? provider`）——那样
  // judge 走 degraded 分支，`onJudge` 照样发、abort 照样发生，本格会因为**完全不同的原因**变绿，
  // 同时多烧一次主模型调用。这条断言是唯一能抓住它的回归网（本格原先没有 `judgeCalls` 护栏）。
  assert.equal(
    harness.judgeCalls.length,
    1,
    "judge 必须走 capabilities.ports.judgeProvider 一次（不是回落到主 provider）",
  );
  assert.equal(harness.mainCalls.length, 1, "主模型只该被调用一次（judge 不得借用主 provider）");
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

  const error = await settle(runDirect({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    capabilities: harness.capabilities,
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

  const error = await settle(runDirect({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    capabilities: harness.capabilities,
    signal: controller.signal,
  }));

  assert.ok(error, "中止仍然必须抛错");
  assert.equal(error?.termination?.reason, "aborted");
  assert.equal(harness.mainCalls.length, 1, "主模型只该被调用一次");
  assert.equal(harness.judgeCalls.length, 0, "中止后不得再发起 judge 模型调用（省一次模型费用）");
  assert.equal(harness.modelCallCount(), 1, "整次 run 的模型请求次数必须是 1（issue #282 改前为 2）");
});

// ── issue #282 漏网面 · 路径 A：judge 判 `done:false` → nudge → continue，这条圈底完全绕过 #282 的两处守卫 ──
// 改前：宿主在「judge 已返回、终局未定」的窗口里点停止，只要 judge 给的是 done:false，循环就不看
// signal 地继续跑——**再多烧一次主模型调用**，最后由出圈的 cap 收尾伪装成轮数耗尽返回
// max_rounds_cap（连 #180 的抛错语义都没有）。
test("abort in the judge nudge window terminates as aborted and issues no further main-model call (issue #282 漏网面 · 路径 A)", async () => {
  const controller = new AbortController();
  const harness = makeHarness({
    // judge 说「还没完」⇒ 治理器给 nudge（continue），而不是 stop
    judgeEvaluator: async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          done: false,
          confidence: 0.9,
          reason: "还没有落盘证据",
          evidence: "本轮没有 writeFile",
          direction: "on_track",
        }),
      }],
      stopReason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 24 },
    }),
  });

  const error = await settle(runDirect({
    provider: harness.provider,
    initialUserMessage: "把活干完",
    executeTool: async () => "unused",
    reflection: harness.reflection,
    capabilities: {
      ...harness.capabilities,
      // onJudge 的调用点正好落在「judge 已返回、终局（nudge→continue）尚未执行」这一段
      hooks: { onJudge: () => controller.abort(new Error("user stop")) },
    },
    signal: controller.signal,
    maxRounds: 4,
    stallDetection: false,
  }));

  assert.ok(error, "nudge-continue 路径上的中止必须抛错（#180 语义），而不是安静地返回 max_rounds_cap");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "max_rounds_cap");
  assert.equal(error?.termination?.partial, true, "aborted 终局必须带 partial 载荷旗子");
  assert.ok(error?.termination?.usage, "aborted 终局必须带已发生的 usage（#180）");
  assert.equal(harness.mainCalls.length, 1, "中止后不得再发起主模型调用（改前会跑到轮数耗尽）");
  assert.equal(harness.judgeCalls.length, 1, "中止后也不得再发起 judge 调用");
});

// ── issue #282 漏网面 · 路径 B：循环**自然耗尽**后的 cap 收尾整段原先在 try/catch 之外 ────────────────
// 中止落在收尾的 finalGuard 里（宿主点停止 → guard 正常返回）：改前既不查 signal，也拿不到 error，
// 终局照原样是 final_guard_unverified / max_rounds_cap，且**不抛错**。
test("abort inside the post-loop max_rounds_cap finalization terminates as aborted (issue #282 漏网面 · 路径 B)", async () => {
  const controller = new AbortController();
  // 两轮都调工具 ⇒ 轮数自然耗尽（第三轮是 cap 收尾的 forced final）
  const provider = createFakeProvider([
    { times: 2, content: [{ type: "tool_use", id: "work", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: FINAL_TEXT }], stopReason: "end_turn" },
  ]);
  let guardCalls = 0;

  const error = await settle(runDirect({
    provider,
    initialUserMessage: "continue",
    executeTool: async () => "worked",
    maxRounds: 2,
    completion: false,
    stallDetection: false,
    signal: controller.signal,
    capabilities: {
      hooks: {
        finalGuard: async () => {
          guardCalls += 1;
          controller.abort(new Error("user stop during finalization"));
          return { action: "accept" };
        },
      },
    },
  }));

  assert.ok(error, "cap 收尾期间的中止必须抛错，不能返回一个正常终局");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "max_rounds_cap");
  assert.notEqual(error?.termination?.reason, "final_guard_unverified");
  assert.equal(error?.termination?.partial, true);
  assert.equal(guardCalls, 1, "中止确实落在 cap 收尾的 finalGuard 里（否则本测试没测到这段）");
});

// ── issue #282 漏网面 · 路径 B 的第二面：中止落在 cap 收尾的**模型调用**里 ⇒ 抛出的错误也必须带 #180 载荷 ──
// 改前：这段在 try/catch 之外，`awaitWithAbort` 抛出的 AbortError 裸冒出整次调用（全仓只有 `fail()`
// 会 annotateTermination），宿主拿到的是一个没有 `termination` / `usage` / `rounds` 的原始错误。
test("abort during the forced-final call of the cap finalization carries the #180 termination payload (issue #282 漏网面 · 路径 B 反向)", async () => {
  const controller = new AbortController();
  const requests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      requests.push(request);
      // 第 3 次调用是 cap 收尾的 forced final：在那里按下停止，并让请求永悬 ⇒ 由 abort 抢输
      if (requests.length === 3) {
        controller.abort(new Error("user stop during forced final"));
        return new Promise(() => {});
      }
      return {
        content: [{ type: "tool_use", id: `work-${String(requests.length)}`, name: "work", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };

  const error = await settle(runDirect({
    provider,
    initialUserMessage: "continue",
    executeTool: async () => "worked",
    maxRounds: 2,
    completion: false,
    stallDetection: false,
    signal: controller.signal,
  }));

  assert.ok(error, "收尾期间被中止必须抛错");
  assert.equal(requests.length, 3, "确认中止确实落在 forced final 那一次模型调用里");
  assert.equal(error?.termination?.reason, "aborted");
  assert.equal(error?.termination?.partial, true, "#180 载荷：partial 必须在");
  assert.ok(error?.usage?.input_tokens > 0, `#180 载荷：usage 必须在（实际 ${JSON.stringify(error?.usage)}）`);
  assert.equal(error?.termination?.usage, error?.usage, "termination.usage 与 error.usage 同一个对象");
});

// ── issue #282 漏网面 · 路径 B 的第三面：中止落在**最后一个预算轮的尾巴**里（onRound 之后、收尾之前）──────
// 圈顶的检查已经管不到它（本轮就是最后一轮，不会再进圈），收尾前那次检查才是唯一守门人。
// 改前：这条 run 无 store（`persist()` 因此不做 abort 检查），于是**正常返回** max_rounds_cap。
test("abort in the tail of the last budget round terminates as aborted before the cap finalization (issue #282 漏网面 · 收尾前)", async () => {
  const controller = new AbortController();
  const provider = createFakeProvider([
    { times: 2, content: [{ type: "tool_use", id: "work", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: FINAL_TEXT }], stopReason: "end_turn" },
  ]);

  const error = await settle(runDirect({
    provider,
    initialUserMessage: "continue",
    executeTool: async () => "worked",
    maxRounds: 2,
    completion: false,
    stallDetection: false,
    signal: controller.signal,
    // 第二轮（= 最后一个预算轮）的记录已经落定，宿主在此按下停止
    capabilities: {
      hooks: {
        onRound: (record) => {
          if (record.round === 2) controller.abort(new Error("user stop at the last round"));
        },
      },
    },
  }));

  assert.ok(error, "最后一轮尾巴上的中止也必须抛错，不能返回 max_rounds_cap");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "max_rounds_cap");
  assert.equal(error?.termination?.partial, true);
  assert.equal(error?.termination?.rounds, 2, "已跑完的两轮必须照常计入账单");
});

// ── issue #282 漏网面 · 路径 B 的第四面：收尾**不经过任何 await** 就能返回的那一格（变异证的靶子）──────────
// 关掉强制收尾（`ERIX_NO_FORCED_FINAL=1`）后，cap 收尾里 `forceFinalIfNeeded` 直接空转、也没有
// finalGuard ⇒ 出圈到 `finish("max_rounds_cap")` 之间没有任何 await，`awaitWithAbort` 那道自带的
// abort 检查根本不会被走到。删掉收尾前那次 `throwIfAborted` 就正好丢掉这条 run（已实测变异红）。
test("abort reaching the cap finalization with no value-added call left still terminates as aborted (issue #282 漏网面 · 收尾无 await 那格)", async () => {
  const controller = new AbortController();
  const provider = createFakeProvider([
    { times: 2, content: [{ type: "tool_use", id: "work", name: "work", input: {} }], stopReason: "tool_use" },
  ]);
  const previous = process.env.ERIX_NO_FORCED_FINAL;
  process.env.ERIX_NO_FORCED_FINAL = "1";
  let error;
  try {
    error = await settle(runDirect({
      provider,
      initialUserMessage: "continue",
      executeTool: async () => "worked",
      maxRounds: 2,
      completion: false,
      stallDetection: false,
      signal: controller.signal,
      capabilities: {
        hooks: {
          onRound: (record) => {
            if (record.round === 2) controller.abort(new Error("user stop before finalization"));
          },
        },
      },
    }));
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_FORCED_FINAL;
    else process.env.ERIX_NO_FORCED_FINAL = previous;
  }

  assert.ok(error, "收尾里没有任何 await 可守时，也必须以 aborted 收口");
  assert.equal(error?.termination?.reason, "aborted");
  assert.notEqual(error?.termination?.reason, "max_rounds_cap");
  assert.equal(error?.termination?.partial, true);
  assert.equal(provider.requests.length, 2, "关掉强制收尾后不得再多打一次模型请求");
});
