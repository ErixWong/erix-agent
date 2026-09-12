import { readFile, stat } from "node:fs/promises";

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
    if (typeof config.apiKeyFile !== "string" || config.apiKeyFile.trim() === "") {
      throw new TypeError("apiKeyFile must be a non-empty string path");
    }
    const keyPath = config.apiKeyFile;
    const fileStats = await stat(keyPath);
    if (!fileStats.isFile()) {
      throw new TypeError(`apiKeyFile must reference a regular file: ${keyPath}`);
    }
    if ((fileStats.mode & 0o044) !== 0) {
      // Warn rather than reject: existing deployments may rely on shared-readable
      // credential files, while callers still get an actionable security signal.
      console.error(`Warning: apiKeyFile is readable by group/other users: ${keyPath}`);
    }
    return (await readFile(keyPath, "utf8")).trim();
  }

  return undefined;
}
