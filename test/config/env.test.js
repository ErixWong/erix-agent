import test from "node:test";
import assert from "node:assert/strict";

import { createEnvModelConfigProvider } from "../../src/config/env.js";

test("reads prefixed model variables and converts numeric values", async () => {
  const prefix = `ERIX_LLM_KIT_${process.pid}_`;
  const keyEnvName = `${prefix}REFERENCED_KEY`;
  const variables = {
    [`${prefix}PROTOCOL`]: "anthropic",
    [`${prefix}ENDPOINT`]: "https://example.invalid",
    [`${prefix}MODEL`]: "env-model",
    [`${prefix}API_KEY_ENV`]: keyEnvName,
    [`${prefix}CONTEXT_WINDOW_TOKENS`]: "200000",
    [`${prefix}MAX_OUTPUT_TOKENS`]: "8192",
    [`${prefix}TEMPERATURE`]: "0.2",
    [`${prefix}TOP_P`]: "0.95",
    [keyEnvName]: "env-secret",
  };
  const previous = new Map();

  try {
    for (const [name, value] of Object.entries(variables)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }

    assert.deepEqual(await createEnvModelConfigProvider(prefix).resolve("audit"), {
      protocol: "anthropic",
      endpoint: "https://example.invalid",
      model: "env-model",
      apiKeyEnv: keyEnvName,
      contextWindowTokens: 200000,
      maxOutputTokens: 8192,
      temperature: 0.2,
      topP: 0.95,
      apiKey: "env-secret",
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
