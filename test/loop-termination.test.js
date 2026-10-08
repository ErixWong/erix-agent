import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { KitError } from "../src/providers/errors.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("returns end_turn for a normal model completion", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.truncated, false);
});

test("returns no_tool after the configured no-tool streak", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "not yet" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "still not yet" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "work",
    executeTool: async () => "worked",
    completion: { maxNoToolRounds: 2 },
  });

  assert.deepEqual(result.termination, { reason: "no_tool" });
  assert.equal(result.truncated, false);
  assert.equal(result.rounds, 3);
});

test("adds the low-budget hint only when two rounds or fewer remain", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "first", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "second", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "work",
    maxRounds: 4,
    executeTool: async () => "result",
    completion: false,
    stallDetection: false,
  });
  assert.doesNotMatch(JSON.stringify(provider.requests[0].messages), /预算/u);
  assert.match(JSON.stringify(provider.requests[2].messages), /本轮后仅剩 2 轮/u);
});

test("returns max_rounds_cap when the effective round limit is reached", async () => {
  const provider = createFakeProvider([
    {
      times: 2,
      content: [{ type: "tool_use", id: "work", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "continue",
    maxRounds: 2,
    executeTool: async () => "worked",
    completion: false,
    stallDetection: false,
  });

  assert.deepEqual(result.termination, { reason: "max_rounds_cap", forcedFinal: true });
  assert.equal(result.truncated, true);
  assert.equal(result.rounds, 2);
  const forcedFinal = provider.requests.at(-1);
  assert.equal(forcedFinal.system.cacheBoundary, true);
  assert.equal(forcedFinal.messages[0].cacheBoundary, true);
});

test("returns continuation_exhausted after max-token continuations run out", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "part one" }], stopReason: "max_tokens" },
      { content: [{ type: "text", text: "part two" }], stopReason: "max_tokens" },
      { content: [{ type: "text", text: "cannot recover" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "write",
    executeTool: async () => "unused",
    maxTokenContinuations: 1,
  });

  assert.deepEqual(result.termination, { reason: "continuation_exhausted", forcedFinal: true });
  assert.equal(result.truncated, true);
});

test("annotates aborted errors with an aborted termination", async () => {
  const controller = new AbortController();
  const reason = new Error("user stopped");
  const provider = {
    async chat({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("provider stopped")), {
          once: true,
        });
      });
    },
  };
  const run = runToolLoop({
    provider,
    initialUserMessage: "wait",
    executeTool: async () => "unused",
    signal: controller.signal,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(reason);

  await assert.rejects(run, (error) => {
    assert.equal(error, reason);
    // issue #180：抛错路径也带终局载荷；未产生用量时为 0，字段形状恒成立。
    assert.deepEqual(error.termination, {
      reason: "aborted",
      detail: "user stopped",
      usage: { input_tokens: 0, output_tokens: 0 },
      rounds: 0,
      partial: true,
    });
    assert.deepEqual(error.usage, { input_tokens: 0, output_tokens: 0 });
    assert.equal(error.rounds, 0);
    assert.equal(error.finalText, "");
    return true;
  });
});

test("carries accumulated usage and rounds on the thrown abort error (issue #180)", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      calls += 1;
      if (calls > 2) return new Promise(() => {}); // 第 3 轮永悬，由 abort 抢输
      return {
        content: [{ type: "tool_use", id: `work-${calls}`, name: "work", input: { n: calls } }],
        stopReason: "tool_use",
        usage: { input_tokens: 100 * calls, output_tokens: 10 * calls, cacheRead: 500, cacheWrite: 5 },
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
      // 第 2 轮完整产出（响应已计入 usage、轮号已自增）后置 abort：第 3 轮进 provider 即被打断
      onEvent: (event) => {
        if (event.type === "round_end" && event.round === 2) controller.abort(new Error("user stopped"));
      },
    }),
    (error) => {
      assert.equal(error.termination.reason, "aborted");
      assert.ok(error.usage.input_tokens > 0, `usage.input_tokens: ${error.usage.input_tokens}`);
      assert.equal(error.usage.input_tokens, 300);
      assert.equal(error.usage.output_tokens, 30);
      assert.equal(error.usage.cacheRead, 1000);
      assert.equal(error.usage.cacheWrite, 10);
      assert.equal(error.rounds, 2);
      assert.equal(error.finalText, "");
      // termination 与错误对象上的量同一个口径（同一个对象）
      assert.equal(error.termination.usage, error.usage);
      assert.equal(error.termination.rounds, 2);
      assert.equal(error.termination.partial, true);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("annotates failed provider errors with a failed termination", async () => {
  const failure = new Error("provider failed");
  const provider = createFakeProvider([{ throw: failure }]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "fail",
      executeTool: async () => "unused",
    }),
    (error) => {
      assert.equal(error, failure);
      // issue #176：无分类字段的错误回落 errorCode: "unknown"。
      assert.deepEqual(error.termination, {
        reason: "failed",
        detail: "provider failed",
        errorCode: "unknown",
      });
      // issue #180：failed 抛错同样带已累计量（本轮未产出任何用量）。
      assert.deepEqual(error.usage, { input_tokens: 0, output_tokens: 0 });
      assert.equal(error.rounds, 0);
      assert.equal(error.finalText, "");
      return true;
    },
  );
});

test("carries the error code on a failed termination (issue #176)", async () => {
  // retry 默认关闭（retry: false）：timeout KitError 直接以原始分类抛出。
  const failure = new KitError("timeout", "upstream timed out after 30s");
  const provider = createFakeProvider([{ throw: failure }]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "fail",
      executeTool: async () => "unused",
    }),
    (error) => {
      assert.equal(error, failure);
      // 宿主的裁决表（#170）无需解析 detail 字符串即可按根因分流。
      assert.deepEqual(error.termination, {
        reason: "failed",
        detail: "upstream timed out after 30s",
        errorCode: "timeout",
      });
      // 与既有的 error.code 保持一致（additive 字段不改变原始错误）。
      assert.equal(error.code, "timeout");
      return true;
    },
  );
});

test("keeps errorCode off non-failed terminations (issue #176 additive shape)", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
  });

  // 成功返回路径的终局与载荷形状不变：无 errorCode、无 partial。
  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal("errorCode" in result.termination, false);
  assert.equal("partial" in result.termination, false);
  assert.equal("usage" in result.termination, false);
  assert.equal(result.usage.input_tokens, 0);
});

test("returns a truncated stall termination after the repeated-call limit", async () => {
  const provider = createFakeProvider([
    {
      times: 8,
      content: [{ type: "tool_use", id: "same", name: "same", input: { n: 1 } }],
      stopReason: "tool_use",
    },
  ]);

  const result = await runToolLoop({
    provider,
    initialUserMessage: "repeat",
    executeTool: async () => "ok",
    completion: false,
    stallDetection: { window: 2 },
  });
  assert.equal(result.termination.reason, "stall");
  assert.equal(result.truncated, true);
  assert.equal(provider.requests.length, 8);
  assert.deepEqual(provider.requests.at(-1).tools, []);
  assert.equal(result.termination.forcedFinal, true);
});

test("can disable the forced final call with the environment switch", async () => {
  const previous = process.env.ERIX_NO_FORCED_FINAL;
  process.env.ERIX_NO_FORCED_FINAL = "1";
  try {
    const provider = createFakeProvider([{
      content: [{ type: "tool_use", id: "work", name: "work", input: {} }],
      stopReason: "tool_use",
    }]);
    const result = await runToolLoop({
      provider,
      initialUserMessage: "work",
      maxRounds: 1,
      executeTool: async () => "worked",
      completion: false,
      stallDetection: false,
    });
    assert.deepEqual(result.termination, { reason: "max_rounds_cap" });
    assert.equal(provider.requests.length, 1);
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_FORCED_FINAL;
    else process.env.ERIX_NO_FORCED_FINAL = previous;
  }
});

test("caps the run when the judge declines extension", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "stopped" }],
        stopReason: "end_turn",
      },
      {
        content: [{
          type: "text",
          text: '{"done":false,"confidence":0.9,"reason":"complete","evidence":"verified","extend":false,"extendReason":"sufficient","plan":""}',
        }],
        stopReason: "end_turn",
      },
      {
        content: [{ type: "text", text: "final" }],
        stopReason: "end_turn",
      },
    ]),
    initialUserMessage: "work",
    executeTool: async () => "worked",
    maxRounds: 2,
    reflection: {
      roundJudge: true,
      maxExtensions: 1,
    },
  });

  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.truncated, true);
});
