import { createStaticModelConfigProvider } from "../../src/config/static.js";
import { modelConfigProviderContract } from "../contract/model-config-provider.js";

const KEY_ENV = `ERIX_STATIC_CONTRACT_KEY_${process.pid}`;
process.env[KEY_ENV] = "static-contract-secret";

modelConfigProviderContract("static", async () => ({
  provider: createStaticModelConfigProvider({
    slots: {
      default: { protocol: "anthropic", endpoint: "https://example.invalid", model: "default-model" },
      audit: { protocol: "openai", endpoint: "https://example.invalid", model: "audit-model", apiKeyEnv: KEY_ENV },
    },
  }),
  slot: "audit",
  expect: { defaultModel: "default-model", slotModel: "audit-model", materializedKey: "static-contract-secret" },
}));
