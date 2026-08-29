import { resolveApiKey } from "./api-key.js";

const STRING_FIELDS = [
  ["PROTOCOL", "protocol"],
  ["ENDPOINT", "endpoint"],
  ["MODEL", "model"],
  ["API_KEY", "apiKey"],
  ["API_KEY_ENV", "apiKeyEnv"],
  ["API_KEY_FILE", "apiKeyFile"],
];

const NUMBER_FIELDS = [
  ["CONTEXT_WINDOW_TOKENS", "contextWindowTokens"],
  ["MAX_OUTPUT_TOKENS", "maxOutputTokens"],
  ["TEMPERATURE", "temperature"],
  ["TOP_P", "topP"],
];

function readConfig(prefix) {
  const config = {};

  for (const [suffix, field] of STRING_FIELDS) {
    const value = process.env[`${prefix}${suffix}`];
    if (value !== undefined) config[field] = value;
  }
  for (const [suffix, field] of NUMBER_FIELDS) {
    const value = process.env[`${prefix}${suffix}`];
    if (value !== undefined) config[field] = Number(value);
  }

  return config;
}

/**
 * Create a provider reading one model config from environment variables.
 *
 * @param {string} [prefix="LLM_KIT_"]
 * @returns {{resolve: (slot?:string) => Promise<object>}}
 */
export function createEnvModelConfigProvider(prefix = "LLM_KIT_") {
  return {
    async resolve() {
      const config = readConfig(prefix);
      const apiKey = await resolveApiKey(config);
      return apiKey === undefined ? config : { ...config, apiKey };
    },
  };
}
