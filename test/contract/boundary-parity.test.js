import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyPort, assemblyPortOptions } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";

function createValidProvider() {
  return {
    async chat() {
      return { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" };
    },
  };
}

function createValidModelConfig() {
  return { resolve: async () => ({ model: "parity-model" }) };
}

function createValidTools() {
  return { definitions: [], async executeTool() { return "unused"; } };
}

const ASSEMBLY_PREFIX = "assembly port is missing methods: ";
const PERSISTENCE_PREFIX = "required persistence store is missing methods: ";

function missingItems(message, prefix) {
  assert.ok(message.startsWith(prefix), `unexpected prefix: ${message}`);
  return message.slice(prefix.length).split(", ");
}

test("boundary parity: missing provider.chat/chatStream reports identically in both shapes", async () => {
  const brokenProvider = { notChat: true };
  const providerItem = "provider.chat or provider.chatStream";

  // Shape 1: createAssemblyPort / assemblyPortOptions
  assert.throws(
    () => createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: brokenProvider,
      tools: createValidTools(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && error.message.includes(providerItem),
  );
  await assert.rejects(
    assemblyPortOptions({
      modelConfig: createValidModelConfig(),
      provider: brokenProvider,
      tools: createValidTools(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && error.message.includes(providerItem),
  );

  // Shape 2: runToolLoop with fine-grained options
  await assert.rejects(
    runToolLoop({
      provider: brokenProvider,
      executeTool: async () => "unused",
      modelConfig: createValidModelConfig(),
      session: { id: `parity-provider-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && error.message.includes(providerItem),
  );
});

test("boundary parity: plain modelConfig without resolve reports identically in both shapes", async () => {
  const plainConfig = { model: "plain" };
  const modelConfigItem = /modelConfig\.resolve \(modelConfig must expose resolve\(slot\); wrap plain config with createModelConfigResolver\(\.\.\.\)\)/u;

  // Shape 1: createAssemblyPort / assemblyPortOptions
  assert.throws(
    () => createAssemblyPort({
      modelConfig: plainConfig,
      provider: createValidProvider(),
      tools: createValidTools(),
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );
  await assert.rejects(
    assemblyPortOptions({
      modelConfig: plainConfig,
      provider: createValidProvider(),
      tools: createValidTools(),
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );

  // Shape 2: runToolLoop with fine-grained options (plain config object)
  await assert.rejects(
    runToolLoop({
      provider: createValidProvider(),
      executeTool: async () => "unused",
      modelConfig: plainConfig,
      session: { id: `parity-model-config-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && modelConfigItem.test(error.message),
  );
});

test("boundary parity: incomplete transcript store reports the same missing method list in both shapes", async () => {
  // Only appendRound present; the other seven methods are missing.
  const brokenStore = { appendRound: async () => {} };

  // Shape 1: createAssemblyPort rejects with the assembly prefix.
  assert.throws(
    () => createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && error.message.startsWith(ASSEMBLY_PREFIX)
      && error.message.includes("store.load")
      && error.message.includes("store.markRunState"),
  );

  // Shape 2: runToolLoop with fine-grained options + required persistence
  // keeps its own prefix but the missing-item list must be identical.
  let assemblyItems = null;
  try {
    createAssemblyPort({
      modelConfig: createValidModelConfig(),
      provider: createValidProvider(),
      tools: createValidTools(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    });
  } catch (error) {
    assemblyItems = missingItems(error.message, ASSEMBLY_PREFIX);
  }
  assert.ok(Array.isArray(assemblyItems));

  await assert.rejects(
    runToolLoop({
      provider: createValidProvider(),
      executeTool: async () => "unused",
      modelConfig: createValidModelConfig(),
      store: brokenStore,
      session: { id: `parity-store-${process.pid}` },
    }),
    (error) => error instanceof TypeError
      && (() => {
        const items = missingItems(error.message, PERSISTENCE_PREFIX);
        return error.message.startsWith(PERSISTENCE_PREFIX)
          && items.length === assemblyItems.length
          && items.every((item) => assemblyItems.includes(item));
      })(),
  );
});
