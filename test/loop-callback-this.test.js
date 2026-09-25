import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";

test("invokes loop callbacks with undefined this", async () => {
  const deltas = [];
  const observerErrors = [];
  const responses = [
    {
      content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { key: "x" } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    },
  ];

  const provider = {
    async chatStream(request) {
      request.onDelta?.("delta");
      return responses.shift();
    },
  };

  function executeTool({ name, input }) {
    assert.equal(this, undefined);
    return `${name}:${input.key}`;
  }

  function onToolResult(name, result) {
    assert.equal(this, undefined);
    return `${name}:${result}`;
  }

  function finalGuard(payload) {
    assert.equal(this, undefined);
    assert.equal(payload.finalText, "done");
    return { action: "accept" };
  }

  function onDelta(chunk) {
    assert.equal(this, undefined);
    deltas.push(chunk);
  }

  const result = await runToolLoop({
    provider,
    initialUserMessage: "find x",
    executeTool,
    onToolResult,
    finalGuard,
    completion: false,
    stream: true,
    onDelta,
    onObserverError: (error) => observerErrors.push(error),
  });

  assert.equal(result.finalText, "done");
  assert.equal(result.verification.status, "verified");
  assert.equal(result.messages.at(-2).content[0].is_error, undefined);
  assert.equal(result.messages.at(-2).content[0].content, "lookup:lookup:x");
  assert.deepEqual(deltas, ["delta", "delta"]);
  assert.deepEqual(observerErrors, []);
});
