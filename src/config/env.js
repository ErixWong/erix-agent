import { resolveApiKey } from "./api-key.js";

const STRING_FIELDS = [
  ["PROTOCOL", "protocol"],
  ["ENDPOINT", "endpoint"],
  ["MODEL", "model"],
  ["MODEL_TYPE", "model_type"],
  ["API_KEY", "apiKey"],
  ["API_KEY_ENV", "apiKeyEnv"],
  ["API_KEY_FILE", "apiKeyFile"],
  ["THINKING_FORMAT", "thinking_format"],
  ["REASONING_EFFORT", "reasoning_effort"],
];

const NUMBER_FIELDS = [
  ["CONTEXT_WINDOW_TOKENS", "contextWindowTokens"],
  ["MAX_OUTPUT_TOKENS", "maxOutputTokens"],
  ["TEMPERATURE", "temperature"],
  ["TOP_P", "topP"],
  ["TIMEOUT", "timeout"],
  ["FREQUENCY_PENALTY", "frequency_penalty"],
  ["PRESENCE_PENALTY", "presence_penalty"],
];

const BOOLEAN_FIELDS = [
  ["SUPPORTS_REASONING", "supports_reasoning"],
  ["ENABLE_THINKING", "enable_thinking"],
];

const JSON_FIELDS = [
  ["THINKING", "thinking"],
  ["REASONING", "reasoning"],
  ["CHAT_TEMPLATE_KWARGS", "chat_template_kwargs"],
  ["PROVIDER_OPTIONS", "providerOptions"],
  ["RESPONSE_FORMAT", "response_format"],
];

function parseJsonOrString(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

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
  for (const [suffix, field] of BOOLEAN_FIELDS) {
    const value = process.env[`${prefix}${suffix}`];
    if (value !== undefined) {
      config[field] = value === "true" ? true : value === "false" ? false : Boolean(value);
    }
  }
  for (const [suffix, field] of JSON_FIELDS) {
    const value = process.env[`${prefix}${suffix}`];
    if (value !== undefined) config[field] = parseJsonOrString(value);
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
