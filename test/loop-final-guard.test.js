import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
import { validateMessages } from "../src/messages/rounds.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("finalGuard accept preserves normal completion", async () => {
  const events = [];
  let payload;
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuard: async (value) => {
      payload = value;
      return { action: "accept" };
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.equal(result.finalText, "done");
  assert.equal(payload.finalText, "done");
  assert.equal(payload.round, 1);
  assert.equal(payload.rounds, 1);
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(events.at(-1).action, "accept");
});

test("finalGuard revision is injected as a paired-safe user text message", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "unverified" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "verified" }], stopReason: "end_turn" },
  ]);
  let calls = 0;
  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    completion: false,
    finalGuard: async () => {
      calls += 1;
      return calls === 1
        ? { action: "revise", message: "请先核实原始值" }
        : { action: "accept" };
    },
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, "verified");
  const continuation = provider.requests[1].messages.at(-1);
  assert.deepEqual(continuation, {
    role: "user",
    content: [{ type: "text", text: "请先核实原始值" }],
  });
  validateMessages(result.messages);
});

test("finalGuard fail-closes after the retry limit without rewriting finalText", async () => {
  const events = [];
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "unsafe-1" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: "unsafe-2" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: "unsafe-3" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    completion: false,
    finalGuardMaxRetries: 2,
    finalGuard: async () => ({
      action: "revise",
      message: "请读取归档核实",
    }),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "final_guard_unverified" });
  assert.equal(result.finalText, "unsafe-3");
  assert.equal(result.rounds, 3);
  assert.equal(events.filter((event) => event.action === "revise").length, 3);
  assert.deepEqual(events.at(-1), {
    type: "final_guard",
    round: 3,
    action: "degraded",
    reason: "max_retries",
  });
});

test("finalGuard errors fail open and emit an error event", async () => {
  const events = [];
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    finalGuard: async () => {
      throw new Error("guard unavailable");
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result.termination, { reason: "end_turn" });
  assert.deepEqual(events.at(-1), {
    type: "final_guard",
    round: 1,
    action: "error",
    reason: "error",
  });
});

test("abort during finalGuard propagates the abort", async () => {
  const controller = new AbortController();
  let called;
  const started = new Promise((resolve) => {
    called = resolve;
  });
  const run = runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    signal: controller.signal,
    finalGuard: async () => {
      called();
      return new Promise(() => {});
    },
  });

  await started;
  const reason = new Error("stopped");
  controller.abort(reason);
  await assert.rejects(run, (error) => {
    assert.equal(error, reason);
    assert.deepEqual(error.termination, {
      reason: "aborted",
      detail: "stopped",
    });
    return true;
  });
});
