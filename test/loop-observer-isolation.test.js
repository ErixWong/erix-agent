import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #173（PR-A 现状锁）：宿主观察者回调抛错的三种不同后果
// ============================================================================
// 2026-10-08 实测的现状（本文件锁的就是这张表，**不是**理想语义声明）：
//
//   | 回调 | 抛错后果 | 记账 |
//   |---|---|---|
//   | onEvent / onRound / onToolResult | **整个 run 终止**：runToolLoop 抛出宿主错误对象，
//     并带 error.termination = {reason:"failed", detail:<宿主错误消息>} | 无 |
//   | onDelta / onReasoningDelta / onToolCall / onUsage | run 正常完成 | onObserverError
//     （未配置时退到 console.error("Observer callback error:", err)，见 loop-stream.test.js） |
//   | onJudge | run 正常完成 | 无（裸 catch 静默吞） |
//
// 实现锚点（PR-B 改动点，行号会随版本漂移，按符号名定位为准）：
//   - emitEvent 无 try：orchestrator.js `emitEvent`（1256-1258）
//   - onRound 直接 await：orchestrator.js（2825）
//   - onToolResult 直接 await：run-snapshot-executor.js（258）
//   - 流式回调经 dispatchAttemptEvent 的 try → reportObserverError：provider-runner.js（93-107）
//   - onJudge 裸 catch：orchestrator.js `emitJudge`（1271-1278）
//
// ⚠️ 这是 **2026-10-08 现状锁**：#173 PR-B 若把三类后果统一为「观察者隔离」，必须同步更新本文件
//    （预期改法：fatal 三条从「run 终止」改判为「run 完成 + onObserverError 记账」，
//     onJudge 从「不通知 onObserverError」改判为「通知」，末尾总表 outcome 全部变 isolated）。
// ⚠️ docs/host-consumer-contract.md 与 runToolLoop JSDoc 的语义变更也要与本文件对齐。
// ============================================================================

const BASE_OPTIONS = {
  initialUserMessage: "go",
  executeTool: async () => "ok",
  persistence: "none",
  completion: false,
};

function toolUseResponse(round) {
  return {
    content: [{ type: "tool_use", id: `tool-${round}`, name: "work", input: { round } }],
    stopReason: "tool_use",
  };
}

function finalResponse(text = "done") {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** 只实现 chatStream 的假 provider：按 emits 依次触发 provider-runner 的流式观察者入口。 */
function createStreamProvider({ response, emits = [] }) {
  const requests = [];
  return {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chatStream(request) {
      requests.push(request);
      for (const emit of emits) emit(request);
      return response;
    },
  };
}

// ── 第一岔路：杀 run ────────────────────────────────────────────────────────

test("status quo #173: a throwing onEvent aborts the run with a failed termination", async () => {
  const boom = new Error("host onEvent blew up");
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const events = [];
  const observerErrors = [];

  await assert.rejects(
    runToolLoop({
      ...BASE_OPTIONS,
      provider,
      onEvent: (event) => {
        events.push(event.type);
        throw boom; // 第一个事件（round_start）就抛
      },
      onObserverError: (error) => observerErrors.push(error),
    }),
    (error) => {
      assert.equal(error, boom, "现状：宿主错误对象原样穿透，不包装");
      assert.equal(error.termination.reason, "failed");
      assert.equal(error.termination.detail, "host onEvent blew up");
      return true;
    },
  );

  // 事件流就地断裂：round_start 之后的 attempt/tool_use/tool_result/round_end 都没发过
  assert.deepEqual(events, ["round_start"]);
  // run 在任何 provider 调用之前就死了（第一次 round_start 早于第一次请求）
  assert.equal(provider.requests.length, 0);
  // 且完全不走 onObserverError 记账——宿主只拿到一个 rejected promise
  assert.deepEqual(observerErrors, []);
});

test("status quo #173: onEvent is fatal on every event type, not just the first one", async () => {
  // 隔离与否只取决于「哪个回调」，与事件类型无关：round_start 之后的每个事件类型抛错都杀 run。
  for (const eventType of ["attempt", "tool_use", "tool_result", "round_end"]) {
    const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
    const seen = [];
    const observerErrors = [];

    await assert.rejects(
      runToolLoop({
        ...BASE_OPTIONS,
        provider,
        onEvent: (event) => {
          seen.push(event.type);
          if (event.type === eventType) throw new Error(`boom-${eventType}`);
        },
        onObserverError: (error) => observerErrors.push(error),
      }),
      (error) => {
        assert.deepEqual(
          error.termination,
          { reason: "failed", detail: `boom-${eventType}` },
          `onEvent throwing on ${eventType} must fail the run`,
        );
        return true;
      },
    );

    assert.ok(seen.includes(eventType));
    assert.deepEqual(observerErrors, [], `${eventType} 抛错不记账（现状）`);
  }
});

test("status quo #173: a throwing onRound aborts the run after the round was already persisted", async () => {
  const boom = new Error("host onRound blew up");
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const rounds = [];
  const observerErrors = [];

  await assert.rejects(
    runToolLoop({
      ...BASE_OPTIONS,
      provider,
      // onRound 是 await 的异步回调：reject 与同步抛错后果一致
      onRound: async (record) => {
        rounds.push(record.round);
        throw boom;
      },
      onObserverError: (error) => observerErrors.push(error),
    }),
    (error) => {
      assert.equal(error, boom);
      assert.deepEqual(error.termination, { reason: "failed", detail: "host onRound blew up" });
      return true;
    },
  );

  // 回调确实被调用过（round 1 收尾时），随后 run 死掉：第 2 轮 provider 请求从未发出
  assert.deepEqual(rounds, [1]);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(observerErrors, []);
});

test("status quo #173: a throwing onToolResult aborts the run before the result reaches the model", async () => {
  const boom = new Error("host onToolResult blew up");
  const provider = createFakeProvider([toolUseResponse(1), finalResponse()]);
  const seen = [];
  const events = [];
  const observerErrors = [];

  await assert.rejects(
    runToolLoop({
      ...BASE_OPTIONS,
      provider,
      onToolResult: async (name) => {
        seen.push(name);
        throw boom; // 宿主改写结果时抛错
      },
      onEvent: (event) => events.push(event.type),
      onObserverError: (error) => observerErrors.push(error),
    }),
    (error) => {
      assert.equal(error, boom);
      assert.deepEqual(error.termination, { reason: "failed", detail: "host onToolResult blew up" });
      return true;
    },
  );

  assert.deepEqual(seen, ["work"]);
  // tool_result 事件从未发出：抛错发生在 onToolResult 里，早于 emitEvent({type:"tool_result"})
  assert.equal(events.includes("tool_result"), false);
  // 结果也没能回到模型：只请求了第 1 轮
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(observerErrors, []);
});

// ── 第二岔路：隔离并记账 ────────────────────────────────────────────────────

test("status quo #173: a throwing onDelta is isolated into onObserverError and the run finishes", async () => {
  const observerErrors = [];
  const deltas = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [
      (request) => request.onDelta?.("a"),
      (request) => request.onDelta?.("b"),
      (request) => request.onDelta?.("c"),
    ],
  });

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onDelta: (chunk) => {
      deltas.push(chunk);
      throw new Error(`host onDelta blew up on ${chunk}`);
    },
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.rounds, 1);
  // 每次抛错各记一笔，且后续 delta 照常投递（抛错不吞后续流）
  assert.deepEqual(deltas, ["a", "b", "c"]);
  assert.deepEqual(
    observerErrors.map((error) => error.message),
    ["host onDelta blew up on a", "host onDelta blew up on b", "host onDelta blew up on c"],
  );
  assert.ok(observerErrors.every((error) => error instanceof Error));
});

test("status quo #173: a throwing onReasoningDelta is isolated and the run finishes", async () => {
  const observerErrors = [];
  const chunks = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onReasoningDelta?.("thinking", { channel: "reasoning" })],
  });

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onReasoningDelta: (chunk) => {
      chunks.push(chunk);
      throw new Error("host onReasoningDelta blew up");
    },
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(chunks, ["thinking"]);
  assert.deepEqual(observerErrors.map((error) => error.message), ["host onReasoningDelta blew up"]);
});

test("status quo #173: a throwing onToolCall is isolated and the run finishes", async () => {
  const observerErrors = [];
  const fragments = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onToolCall?.({ id: "call-1", name: "work", input: {} })],
  });

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onToolCall: (fragment) => {
      fragments.push(fragment);
      throw new Error("host onToolCall blew up");
    },
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(fragments, [{ id: "call-1", name: "work", input: {} }]);
  assert.deepEqual(observerErrors.map((error) => error.message), ["host onToolCall blew up"]);
});

test("status quo #173: a throwing onUsage is isolated and usage accounting is unaffected", async () => {
  const observerErrors = [];
  const usageEvents = [];
  const provider = createStreamProvider({
    response: finalResponse(),
    emits: [(request) => request.onUsage?.({ input_tokens: 7, output_tokens: 3 })],
  });

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider,
    stream: true,
    onUsage: () => {
      throw new Error("host onUsage blew up");
    },
    onEvent: (event) => {
      if (event.type === "usage") usageEvents.push(event.usage);
    },
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  // usage 事件由引擎自己发（在宿主回调之外），宿主抛错不影响事件流与记账
  assert.deepEqual(usageEvents, [{ input_tokens: 7, output_tokens: 3 }]);
  assert.deepEqual(observerErrors.map((error) => error.message), ["host onUsage blew up"]);
});

// ── 第三岔路：裸 catch 静默吞 ───────────────────────────────────────────────

test("status quo #173: a throwing onJudge is swallowed silently (not even onObserverError)", async () => {
  // 现状与第一/第二岔路都不同：既不断 run，也不记账。
  // （test/judge.test.js 的 "onJudge callback errors do not abort the loop" 只锁了「不断 run」，
  //   这里额外锁「连 onObserverError 都不通知」——PR-B 改的就是这一点。）
  const observerErrors = [];
  const rounds = [];
  const judge = createFakeProvider([
    finalResponse(JSON.stringify({
      done: true,
      confidence: 0.9,
      reason: "完成",
      evidence: "通过",
    })),
  ]);

  const result = await runToolLoop({
    ...BASE_OPTIONS,
    provider: createFakeProvider([finalResponse("完成")]),
    maxRounds: 1,
    reflection: { enabled: true, judge: { provider: judge } },
    onJudge: () => {
      throw new Error("host onJudge blew up");
    },
    onRound: (record) => rounds.push(record.round),
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.deepEqual(result.termination, { reason: "judge_done" });
  assert.deepEqual(rounds, [1], "onJudge 抛错后 run 照常收尾");
  assert.deepEqual(observerErrors, [], "现状：onJudge 的裸 catch 不通知 onObserverError");
});

// ── 三岔路总表：PR-B 统一语义时唯一需要改的地方 ─────────────────────────────

test("status quo #173: the three-way divergence table (update this matrix in PR-B)", async () => {
  const CASES = [
    { channel: "onEvent", outcome: "fatal" },
    { channel: "onRound", outcome: "fatal" },
    { channel: "onToolResult", outcome: "fatal" },
    { channel: "onDelta", outcome: "isolated" },
    { channel: "onReasoningDelta", outcome: "isolated" },
    { channel: "onToolCall", outcome: "isolated" },
    { channel: "onUsage", outcome: "isolated" },
    { channel: "onJudge", outcome: "swallowed" },
  ];

  for (const { channel, outcome } of CASES) {
    const boom = new Error(`host ${channel} blew up`);
    const observerErrors = [];
    const options = {
      ...BASE_OPTIONS,
      provider: channel === "onJudge"
        ? createFakeProvider([finalResponse("完成")])
        : createFakeProvider([toolUseResponse(1), finalResponse()]),
      maxRounds: channel === "onJudge" ? 1 : 4,
      onObserverError: (error) => observerErrors.push(error),
    };
    if (channel === "onJudge") {
      options.reflection = {
        enabled: true,
        judge: { provider: createFakeProvider([finalResponse(JSON.stringify({
          done: true, confidence: 0.9, reason: "完成", evidence: "通过",
        }))]) },
      };
    }
    if (["onDelta", "onReasoningDelta", "onToolCall", "onUsage"].includes(channel)) {
      options.provider = createStreamProvider({
        response: finalResponse(),
        // onToolCall 的 fragment 形态与 onDelta 的字符串不同，但后果同构，这里统一触发一次
        emits: [(request) => request[channel]?.(
          channel === "onToolCall" ? { id: "call-1", name: "work", input: {} } : "x",
        )],
      });
      options.stream = true;
    }
    options[channel] = () => {
      throw boom;
    };

    if (outcome === "fatal") {
      await assert.rejects(
        runToolLoop(options),
        (error) => {
          assert.equal(error, boom, `${channel} 现状：直接杀 run`);
          assert.deepEqual(error.termination, { reason: "failed", detail: boom.message });
          return true;
        },
        `${channel} 应当（现状）终止 run`,
      );
      assert.deepEqual(observerErrors, [], `${channel} 现状：不记账`);
      continue;
    }

    const result = await runToolLoop(options);
    if (outcome === "isolated") {
      assert.equal(result.termination.reason, "end_turn", `${channel} 现状：run 正常完成`);
      assert.deepEqual(
        observerErrors.map((error) => error.message),
        [boom.message],
        `${channel} 现状：经 onObserverError 记账`,
      );
    } else {
      assert.equal(result.termination.reason, "judge_done", `${channel} 现状：run 正常完成`);
      assert.deepEqual(observerErrors, [], `${channel} 现状：静默吞，不记账`);
    }
  }
});
