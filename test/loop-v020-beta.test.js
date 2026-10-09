import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";

test("restores a round snapshot and flushes only the successful attempt events", async () => {
  const text = [];
  const reasoning = [];
  const events = [];
  let calls = 0;
  const provider = {
    async chatStream(request) {
      calls += 1;
      if (calls === 1) request.messages[0].content[0].text = "mutated";
      request.onDelta?.("same");
      request.onReasoningDelta?.("thinking");
      if (calls === 1) {
        const error = new Error("connection reset");
        error.retryable = true;
        throw error;
      }
      assert.equal(request.messages[0].content[0].text, "hello");
      return {
        content: [{ type: "text", text: "same" }],
        stopReason: "end_turn",
      };
    },
  };

  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    stream: true,
    onDelta: (delta) => text.push(delta),
    onReasoningDelta: (delta) => reasoning.push(delta),
    onEvent: (event) => events.push(event),
    retry: {
      attempts: 1,
      backoffBaseMs: 0,
      sleepImpl: async () => {},
    },
  });

  assert.equal(result.finalText, "same");
  assert.deepEqual(text, ["same"]);
  assert.deepEqual(reasoning, ["thinking"]);
  assert.deepEqual(events.map((event) => event.type), [
    // issue #182：本用例不传模型元数据 → 启动期先落一条一次性预算元数据诊断事件，
    // 之后才是轮次事件（additive，不影响既有事件顺序）。
    "model_metadata_missing",
    "round_start",
    "attempt",
    "recovering",
    "attempt",
    "recovered",
    "round_end",
    // issue #165：run 终局追加一条 `run_outcome` 汇总记录（走既有 onEvent 通道，additive），
    // 既有事件顺序不变。
    "run_outcome",
  ]);
});

test("aborting during retry backoff stops without starting another provider attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      const error = new Error("temporary");
      error.retryable = true;
      throw error;
    },
  };
  const sleepImpl = (_delay, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const run = runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    signal: controller.signal,
    retry: { attempts: 3, sleepImpl },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("user stopped"));

  await assert.rejects(run, (error) => error?.message === "user stopped");
  assert.equal(calls, 1);
});
