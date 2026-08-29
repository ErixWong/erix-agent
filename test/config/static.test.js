import test from "node:test";
import assert from "node:assert/strict";

import { createStaticModelConfigProvider } from "../../src/config/static.js";

test("resolves a single static config and materializes its direct key", async () => {
  const input = {
    protocol: "openai",
    endpoint: "https://example.invalid",
    model: "test-model",
    apiKey: "secret",
  };
  const result = await createStaticModelConfigProvider(input).resolve();

  assert.deepEqual(result, input);
  assert.deepEqual(input, {
    protocol: "openai",
    endpoint: "https://example.invalid",
    model: "test-model",
    apiKey: "secret",
  });
});

test("falls back from a missing slot to default", async () => {
  const provider = createStaticModelConfigProvider({
    slots: {
      default: {
        protocol: "anthropic",
        endpoint: "https://example.invalid",
        model: "default-model",
      },
      audit: {
        protocol: "openai",
        endpoint: "https://example.invalid",
        model: "audit-model",
      },
    },
  });

  assert.equal((await provider.resolve("audit")).model, "audit-model");
  assert.equal((await provider.resolve("missing")).model, "default-model");
});
