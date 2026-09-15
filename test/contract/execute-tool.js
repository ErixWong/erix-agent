// ToolExecutor 契约测试套件（ADR-014 §2.4）
// 用法：executeToolContract("mariadb", () => adapter.executeTool)
// 宿主适配器通过本套件即可锁定 runToolLoop 的结构化边界。

import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../../src/loop.js";

function createProvider() {
  const requests = [];
  let callCount = 0;
  return {
    requests,
    async chat(request) {
      requests.push(request);
      callCount += 1;
      return callCount === 1
        ? {
            content: [{
              type: "tool_use",
              id: "contract-tool-1",
              name: "lookup",
              input: { key: "value" },
            }],
            stopReason: "tool_use",
          }
        : {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
          };
    },
  };
}

async function resolveExecutor(createExecutor) {
  const candidate = await createExecutor();
  const executor = typeof candidate === "function" ? candidate : candidate?.executeTool;
  if (typeof executor !== "function") {
    throw new TypeError("executeToolContract factory must return a function or { executeTool }");
  }
  return executor;
}

async function runExecutor(executeTool) {
  const provider = createProvider();
  const result = await runToolLoop({
    provider,
    initialUserMessage: "lookup value",
    executeTool,
    completion: false,
  });
  return { provider, result };
}

function toolResultFrom(provider) {
  return provider.requests[1].messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block?.type === "tool_result");
}

export function executeToolContract(label, createExecutor) {
  test(`${label}: receives exactly one structured execution object`, async () => {
    const calls = [];
    const executor = await resolveExecutor(createExecutor);
    const { provider } = await runExecutor(async (...args) => {
      calls.push(args);
      return executor(...args);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.deepEqual(Object.keys(calls[0][0]).sort(), [
      "context",
      "id",
      "input",
      "name",
      "signal",
    ]);
    assert.equal(calls[0][0].id, "contract-tool-1");
    assert.equal(calls[0][0].name, "lookup");
    assert.deepEqual(calls[0][0].input, { key: "value" });
    assert.equal(typeof calls[0][0].context, "object");
    assert.ok(calls[0][0].signal instanceof AbortSignal);
    assert.equal(toolResultFrom(provider).type, "tool_result");
  });

  test(`${label}: string return becomes a successful tool_result`, async () => {
    const { provider } = await runExecutor(async () => "string result");
    assert.deepEqual(toolResultFrom(provider), {
      type: "tool_result",
      tool_use_id: "contract-tool-1",
      content: "string result",
    });
  });

  test(`${label}: structured return preserves content, metadata, and success`, async () => {
    const { provider } = await runExecutor(async () => ({
      content: "structured result",
      metadata: { artifactStatus: "ok" },
      success: true,
    }));
    assert.equal(toolResultFrom(provider).content, "structured result");
    assert.equal(toolResultFrom(provider).artifactStatus, "ok");
    assert.equal(toolResultFrom(provider).success, true);
    assert.equal(toolResultFrom(provider).is_error, undefined);
  });

  test(`${label}: returned Error becomes an error tool_result`, async () => {
    const { provider } = await runExecutor(async () => new Error("returned failure"));
    assert.equal(toolResultFrom(provider).content, "returned failure");
    assert.equal(toolResultFrom(provider).is_error, true);
  });

  test(`${label}: thrown Error becomes an error tool_result`, async () => {
    const { provider } = await runExecutor(async () => {
      throw new Error("thrown failure");
    });
    assert.equal(toolResultFrom(provider).content, "thrown failure");
    assert.equal(toolResultFrom(provider).is_error, true);
  });

  test(`${label}: host wrappers and two-argument functions do not use positional dispatch`, async () => {
    const positionalImplementation = async (name, input) => `${name}:${input.key}`;
    const touwakaStyleWrapper = async (execution) => (
      positionalImplementation(execution.name, execution.input)
    );
    const wrapped = await runExecutor(touwakaStyleWrapper);
    assert.equal(toolResultFrom(wrapped.provider).content, "lookup:value");

    const calls = [];
    const directTwoArgumentExecutor = async (name, input) => {
      calls.push({ name, input });
      return "direct result";
    };
    const direct = await runExecutor(directTwoArgumentExecutor);
    assert.equal(toolResultFrom(direct.provider).content, "direct result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, undefined);
    assert.equal(calls[0].name.name, "lookup");
    assert.deepEqual(calls[0].name.input, { key: "value" });
  });
}
