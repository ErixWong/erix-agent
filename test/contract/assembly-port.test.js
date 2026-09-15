import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createStaticModelConfigProvider } from "../../src/config/static.js";
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
