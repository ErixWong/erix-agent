// 终局载荷契约套件（issue #176 / #180）：锁定「失败与中断路径也必须把终局事实交给宿主」。
//   - reason === "failed" 的终局必带 `errorCode`（错误无分类字段时为 "unknown"）；
//   - abort 抛出的错误必带 `usage` / `rounds` / `finalText`（无用量时为 0 / 0 / ""），
//     且 termination 同步 {usage, rounds, partial:true}——「abort = 抛错」语义不变；
//   - 其余 reason 的终局形状保持不变（不得凭空多出 errorCode / partial / usage）。
// 用法（宿主拿到的是包入口命名空间）：
//   import { terminationPayloadContract } from "erix-agent/contract-tests";
//   terminationPayloadContract("reference", async () => await import("erix-agent"));
// 只依赖入口导出的 `runToolLoop`，自带 provider stub，不引用 test/helpers（未发布）。

import test from "node:test";
import assert from "node:assert/strict";

function toolRound(id) {
  return {
    content: [{ type: "tool_use", id, name: "work", input: { n: 1 } }],
    stopReason: "tool_use",
  };
}

function stubProvider(script) {
  let index = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      const step = script[index];
      index += 1;
      if (step === undefined) throw new Error("stub provider script exhausted");
      if (step.throw !== undefined) throw step.throw;
      return step;
    },
  };
}

/**
 * @param {string} label 实现名（测试标题前缀）
 * @param {() => {runToolLoop: Function} | Promise<{runToolLoop: Function}>} getEntry
 *        返回带 `runToolLoop` 的引擎入口命名空间
 */
export function terminationPayloadContract(label, getEntry) {
  test(`${label}: failed 终局携带 errorCode（有分类用分类，无分类为 unknown）`, async () => {
    const { runToolLoop } = await getEntry();
    const coded = new Error("upstream timed out");
    coded.code = "timeout";

    await assert.rejects(
      runToolLoop({
        provider: stubProvider([{ throw: coded }]),
        initialUserMessage: "fail",
        executeTool: async () => "unused",
      }),
      (error) => {
        assert.equal(error.termination.reason, "failed");
        assert.equal(error.termination.errorCode, "timeout",
          `errorCode 必须透出错误分类，实际：${String(error.termination.errorCode)}`);
        assert.equal(error.code, "timeout");
        return true;
      },
    );

    await assert.rejects(
      runToolLoop({
        provider: stubProvider([{ throw: new Error("provider exploded") }]),
        initialUserMessage: "fail",
        executeTool: async () => "unused",
      }),
      (error) => {
        assert.equal(error.termination.reason, "failed");
        assert.equal(error.termination.errorCode, "unknown",
          "无分类字段的错误也必须给出 errorCode");
        return true;
      },
    );
  });

  test(`${label}: abort 抛出的错误必带 usage/rounds/finalText（无用量时为 0）`, async () => {
    const { runToolLoop } = await getEntry();
    const controller = new AbortController();
    controller.abort(new Error("user stopped"));

    await assert.rejects(
      runToolLoop({
        provider: stubProvider([toolRound("c1")]),
        initialUserMessage: "never",
        executeTool: async () => "unused",
        signal: controller.signal,
      }),
      (error) => {
        assert.equal(error.termination.reason, "aborted");
        assert.equal(typeof error.usage, "object", "abort 错误必须携带 usage 对象");
        assert.equal(error.usage.input_tokens, 0);
        assert.equal(error.usage.output_tokens, 0);
        assert.equal(error.rounds, 0);
        assert.equal(error.finalText, "");
        assert.deepEqual(
          { usage: error.termination.usage, rounds: error.termination.rounds, partial: error.termination.partial },
          { usage: error.usage, rounds: 0, partial: true },
        );
        return true;
      },
    );
  });

  test(`${label}: abort 错误携带逐轮累计的 usage 与轮号（宿主按停止的 run 计费）`, async () => {
    const { runToolLoop } = await getEntry();
    const controller = new AbortController();
    let calls = 0;
    const provider = {
      protocol: "fake",
      model: "fake-model",
      async chat() {
        calls += 1;
        if (calls > 2) return new Promise(() => {}); // 第 3 轮永悬，由 abort 抢输
        return {
          ...toolRound(`c${calls}`),
          usage: { input_tokens: 100 * calls, output_tokens: 10 * calls, cacheRead: 700, cacheWrite: 3 },
        };
      },
    };

    await assert.rejects(
      runToolLoop({
        provider,
        initialUserMessage: "work",
        executeTool: async () => "worked",
        signal: controller.signal,
        maxRounds: 10,
        completion: false,
        stallDetection: false,
        onEvent: (event) => {
          if (event.type === "round_end" && event.round === 2) controller.abort(new Error("user stopped"));
        },
      }),
      (error) => {
        assert.equal(error.termination.reason, "aborted");
        assert.ok(error.usage.input_tokens > 0,
          `两轮已产出的用量必须出现在 error.usage 上，实际：${JSON.stringify(error.usage)}`);
        assert.equal(error.usage.input_tokens, 300);
        assert.equal(error.usage.output_tokens, 30);
        assert.equal(error.usage.cacheRead, 1400);
        assert.equal(error.usage.cacheWrite, 6);
        assert.equal(error.rounds, 2);
        assert.equal(error.termination.rounds, 2);
        assert.equal(error.termination.partial, true);
        assert.equal(error.termination.usage, error.usage, "termination.usage 与 error.usage 同口径");
        assert.equal(typeof error.finalText, "string");
        return true;
      },
    );
  });

  test(`${label}: 正常返回路径的终局形状不变（无 errorCode / partial / usage 字段）`, async () => {
    const { runToolLoop } = await getEntry();
    const result = await runToolLoop({
      provider: stubProvider([
        { ...toolRound("c1"), usage: { input_tokens: 42, output_tokens: 7 } },
        { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 8, output_tokens: 2 } },
      ]),
      initialUserMessage: "work",
      executeTool: async () => "worked",
      maxRounds: 10,
      completion: false,
      stallDetection: false,
    });

    assert.equal(result.termination.reason, "end_turn");
    assert.equal("errorCode" in result.termination, false);
    assert.equal("partial" in result.termination, false);
    assert.equal("usage" in result.termination, false);
    assert.equal(result.rounds, 2);
    assert.equal(result.usage.input_tokens, 50);
    assert.equal(result.usage.output_tokens, 9);
    assert.equal(result.finalText, "done");
  });
}
