import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { assemblyPortOptions, createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";
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

  test("assemblyPortOptions applies explicit fine-grained overrides", async () => {
    const explicitModelConfig = { resolve: async () => ({ model: "explicit" }) };
    const port = createAssemblyPort({
      modelConfig: { resolve: async () => ({ model: "assembly" }) },
      provider: createProvider(),
      tools: { definitions: [], async executeTool() {} },
      store: createMemoryTranscriptStore(),
      session: { id: `assembly-helper-overrides-${process.pid}` },
    });

    const options = await assemblyPortOptions(port, {
      modelConfig: explicitModelConfig,
    });
    assert.equal(options.modelConfig, explicitModelConfig);
    await assert.rejects(
      assemblyPortOptions(port, { modelConfig: { model: "plain" } }),
      (error) => error instanceof TypeError
        && /modelConfig\.resolve/u.test(error.message)
        && /wrap plain config with createModelConfigResolver/u.test(error.message),
    );
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
  const { runToolLoop } = await import("../../src/loop/orchestrator.js");
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
