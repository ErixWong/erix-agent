import test from "node:test";
import assert from "node:assert/strict";
import { createEnvModelConfigProvider } from "../../src/config/env.js";
import { modelConfigProviderContract } from "../contract/model-config-provider.js";

const PREFIX = `ERIX_ENV_CONTRACT_${process.pid}_`;
const KEY_ENV = `${PREFIX}REFERENCED_KEY`;

function setupEnv() {
  process.env[`${PREFIX}PROTOCOL`] = "openai";
  process.env[`${PREFIX}ENDPOINT`] = "https://example.invalid";
  process.env[`${PREFIX}MODEL`] = "env-model";
  process.env[`${PREFIX}API_KEY_ENV`] = KEY_ENV;
  process.env[KEY_ENV] = "env-contract-secret";
}

// env 提供者是单配置形态：任何 slot 都返回同一份配置（slotModel === defaultModel）
modelConfigProviderContract("env", async () => {
  setupEnv();
  return {
    provider: createEnvModelConfigProvider(PREFIX),
    slot: "audit",
    expect: { defaultModel: "env-model", slotModel: "env-model", materializedKey: "env-contract-secret" },
  };
});

// ---- 实现特有：数字字段转换 ----
test("env: 数字字段转 number", async () => {
  setupEnv();
  process.env[`${PREFIX}CONTEXT_WINDOW_TOKENS`] = "200000";
  process.env[`${PREFIX}MAX_OUTPUT_TOKENS`] = "8192";
  process.env[`${PREFIX}TEMPERATURE`] = "0.2";

  const config = await createEnvModelConfigProvider(PREFIX).resolve();
  assert.equal(config.contextWindowTokens, 200000);
  assert.equal(config.maxOutputTokens, 8192);
  assert.equal(config.temperature, 0.2);
});

test("env: exposes reasoning model and payload fields", async () => {
  setupEnv();
  process.env[`${PREFIX}MODEL_TYPE`] = "chat";
  process.env[`${PREFIX}TIMEOUT`] = "45000";
  process.env[`${PREFIX}SUPPORTS_REASONING`] = "true";
  process.env[`${PREFIX}THINKING_FORMAT`] = "deepseek";
  process.env[`${PREFIX}THINKING`] = '{"type":"enabled"}';
  process.env[`${PREFIX}ENABLE_THINKING`] = "true";

  const config = await createEnvModelConfigProvider(PREFIX).resolve();
  assert.equal(config.protocol, "openai");
  assert.equal(config.model_type, "chat");
  assert.equal(config.timeout, 45000);
  assert.equal(config.supports_reasoning, true);
  assert.equal(config.thinking_format, "deepseek");
  assert.deepEqual(config.thinking, { type: "enabled" });
  assert.equal(config.enable_thinking, true);
  assert.equal(config.apiKey, "env-contract-secret");
});
