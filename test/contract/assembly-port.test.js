import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { createAssemblyPort } from "../../src/assembly.js";
import { runToolLoop } from "../../src/loop.js";
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

test("explicit fine-grained modelConfig skips the assembly resolver", async () => {
  let resolveCount = 0;
  const port = {
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
  };

  await import("../../src/loop.js").then(({ runToolLoop }) => runToolLoop({
    assemblyPort: port,
    modelConfig: { contextWindowTokens: 100000, maxOutputTokens: 1000 },
    completion: false,
    wrapup: false,
    maxRounds: 1,
  }));
  assert.equal(resolveCount, 0);
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
