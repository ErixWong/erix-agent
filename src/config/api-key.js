import { readFile } from "node:fs/promises";

/**
 * Resolve a model API key using direct, environment, then file references.
 *
 * @param {{apiKey?: string, apiKeyEnv?: string, apiKeyFile?: string}} [config]
 * @returns {Promise<string|undefined>}
 */
export async function resolveApiKey(config = {}) {
  if (config.apiKey !== undefined && config.apiKey !== null) {
    return config.apiKey;
  }

  if (config.apiKeyEnv !== undefined && process.env[config.apiKeyEnv] !== undefined) {
    return process.env[config.apiKeyEnv];
  }

  if (config.apiKeyFile !== undefined) {
    return (await readFile(config.apiKeyFile, "utf8")).trim();
  }

  return undefined;
}
