import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop.js";
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

test("returns max_rounds_cap when the effective round limit is reached", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      {
        times: 2,
        content: [{ type: "tool_use", id: "work", name: "work", input: {} }],
        stopReason: "tool_use",
      },
    ]),
    initialUserMessage: "continue",
    maxRounds: 2,
    executeTool: async () => "worked",
    completion: false,
    stallDetection: false,
  });

  assert.deepEqual(result.termination, { reason: "max_rounds_cap" });
  assert.equal(result.truncated, true);
  assert.equal(result.rounds, 2);
});

test("returns continuation_exhausted after max-token continuations run out", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "part one" }], stopReason: "max_tokens" },
      { content: [{ type: "text", text: "part two" }], stopReason: "max_tokens" },
    ]),
    initialUserMessage: "write",
    executeTool: async () => "unused",
    maxTokenContinuations: 1,
  });

  assert.deepEqual(result.termination, { reason: "continuation_exhausted" });
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
    assert.deepEqual(error.termination, {
      reason: "aborted",
      detail: "user stopped",
    });
    return true;
  });
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
      assert.deepEqual(error.termination, {
        reason: "failed",
        detail: "provider failed",
      });
      return true;
    },
  );
});

test("annotates stall errors as failed with the repeated-call detail", async () => {
  const provider = createFakeProvider([
    {
      times: 3,
      content: [{ type: "tool_use", id: "same", name: "same", input: { n: 1 } }],
      stopReason: "tool_use",
    },
  ]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "repeat",
      executeTool: async () => "ok",
      stallDetection: { window: 2 },
    }),
    (error) => {
      assert.equal(error.code, "llm_kit_stalled");
      assert.equal(error.termination.reason, "failed");
      assert.match(error.termination.detail, /Tool loop stalled on repeated call/);
      assert.match(error.termination.detail, /same/);
      return true;
    },
  );
});

test("returns reflection_stop when the evaluator declines continuation", async () => {
  const result = await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{
          type: "text",
          text: '{"continue":false,"reason":"complete","plan":""}',
        }],
        stopReason: "end_turn",
      },
    ]),
    initialUserMessage: "work",
    executeTool: async () => "worked",
    maxRounds: 1,
    reflection: {
      roundJudge: false,
      triggerRound: 1,
      maxExtensions: 1,
    },
  });

  assert.deepEqual(result.termination, {
    reason: "reflection_stop",
    detail: "complete",
  });
  assert.equal(result.truncated, false);
});
