import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { assemblyPortContract } from "./assembly-port.js";

function createProvider() {
  return {
    async chat() {
      return {
        content: [{ type: "text", text: "assembled" }],
        stopReason: "end_turn",
      };
    },
  };
}

assemblyPortContract("reference", () => ({
  modelConfig: createStaticModelConfigProvider({ model: "contract-model" }),
  provider: createProvider(),
  tools: {
    definitions: [],
    async executeTool() {
      return "unused";
    },
  },
  store: createMemoryTranscriptStore(),
  resourceStore: {
    async put(resource) {
      return {
        locator: { key: `resource-${String(resource)}` },
        digest: "a".repeat(64),
        display: `memory:${String(resource)}`,
      };
    },
    async get() {
      return "resource";
    },
  },
  session: { id: `assembly-contract-${process.pid}` },
}));

test("assembly port supports default and explicit modelConfig paths", async () => {
  let resolveCount = 0;
  const port = createAssemblyPort({
    modelConfig: {
      async resolve() {
        resolveCount += 1;
        return { contextWindowTokens: 100000, maxOutputTokens: 1000 };
      },
    },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `assembly-precedence-${process.pid}` },
  });

  const defaultResult = await runToolLoop({
    assemblyPort: port,
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.equal(defaultResult.termination.reason, "end_turn");
  resolveCount = 0;

  const explicitResult = await runToolLoop({
    assemblyPort: port,
    modelConfig: {
      async resolve() {
        return { contextWindowTokens: 100000, maxOutputTokens: 1000 };
      },
    },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });
  assert.equal(explicitResult.termination.reason, "end_turn");
  assert.equal(resolveCount, 0);
});

test("assembly port keeps its resourceStore when explicit context is supplied", async () => {
  let putCount = 0;
  const resourceStore = {
    async put(resource) {
      putCount += 1;
      return {
        locator: { id: `resource-${putCount}` },
        digest: "a".repeat(64),
        display: `opaque-resource-${putCount}`,
      };
    },
    async get() {
      return "resource";
    },
  };
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    resourceStore,
    session: { id: `assembly-resource-context-${process.pid}` },
  });

  await runToolLoop({
    assemblyPort: port,
    context: {
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: 1,
      keepRounds: 0,
    },
    initialMessages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "old", name: "tool", input: {} }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "old",
          content: "old",
          artifact: { resource: "materialize me" },
        }],
      },
      { role: "assistant", content: [{ type: "text", text: "recent" }] },
    ],
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });

  assert.equal(putCount, 1);
});

test("plain explicit modelConfig is rejected with resolver migration guidance", async () => {
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `assembly-plain-model-config-${process.pid}` },
  });
  const plainConfig = { model: "plain-config" };

  assert.throws(
    () => createAssemblyPort({
      ...port,
      modelConfig: plainConfig,
    }),
    (error) => error instanceof TypeError
      && /modelConfig\.resolve/u.test(error.message)
      && /wrap plain config with createModelConfigResolver/u.test(error.message),
  );
  await assert.rejects(
    runToolLoop({
      assemblyPort: port,
      modelConfig: plainConfig,
      completion: false,
      wrapup: false,
      maxRounds: 1,
    }),
    (error) => error instanceof TypeError
      && /modelConfig\.resolve/u.test(error.message)
      && /wrap plain config with createModelConfigResolver/u.test(error.message),
  );
});

test("fine-grained startup validation rejects incomplete assembly-shaped input", async () => {
  const { runToolLoop } = await import("../../src/loop.js");
  await assert.rejects(
    runToolLoop({
      provider: {},
      session: { id: "fine-invalid" },
      persistence: "none",
      maxRounds: 1,
    }),
    (error) => error instanceof TypeError
      && /provider\.chat or provider\.chatStream/u.test(error.message)
      && /executeTool/u.test(error.message)
      && /modelConfig\.resolve/u.test(error.message),
  );
});

test("assembly port without a store runs with no persistence", async () => {
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({}) },
    provider: createProvider(),
    tools: { definitions: [], async executeTool() {} },
    session: { id: `assembly-no-store-${process.pid}` },
  });

  const result = await runToolLoop({
    assemblyPort: port,
    completion: false,
    wrapup: false,
    maxRounds: 1,
  });

  assert.equal(result.finalText, "assembled");
  assert.equal(result.termination.reason, "end_turn");
});

test("assembly port rejects a store missing one of the required methods", () => {
  assert.throws(
    () => createAssemblyPort({
      modelConfig: { resolve: async () => ({}) },
      provider: createProvider(),
      tools: { definitions: [], async executeTool() {} },
      store: { appendRound() {} },
      session: { id: "assembly-incomplete-store" },
    }),
    (error) => error instanceof TypeError && /store\.load/u.test(error.message),
  );
});
