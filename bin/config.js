import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createJsonFileModelConfigProvider } from "../src/config/json-file.js";
import {
  computeBudget,
  createFoldStatisticalStrategy,
} from "../src/index.js";

const DEFAULT_MODEL = "kimi-for-coding";
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

export function defaultConfigPath() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, "erix", "config.json");
  return join(homedir(), ".erix", "config.json");
}

async function loadFileConfig(configPath) {
  try {
    await access(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  return createJsonFileModelConfigProvider({ path: configPath }).resolve("default");
}

function readEnvironmentValue(name) {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

function parsePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function missingConfigError(missing) {
  return new Error(
    `缺少环境变量：${missing.join("、")}。\n请先设置，例如：\n  export LLM_KIT_ENDPOINT="https://你的 OpenAI 兼容 API 地址"\n  export LLM_KIT_API_KEY="你的 API 密钥"`,
  );
}

export async function loadCliConfig({ configPath } = {}) {
  const fileConfig = await loadFileConfig(configPath ?? defaultConfigPath());
  const endpoint = readEnvironmentValue("LLM_KIT_ENDPOINT") ?? fileConfig.endpoint;
  const apiKey = readEnvironmentValue("LLM_KIT_API_KEY") ?? fileConfig.apiKey;
  const model = readEnvironmentValue("LLM_KIT_MODEL")
    || fileConfig.model
    || DEFAULT_MODEL;
  const maxOutputTokens =
    parsePositiveInteger(fileConfig.maxOutputTokens)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const contextWindowTokens = parsePositiveInteger(fileConfig.contextWindowTokens);
  const missing = [];

  if (!endpoint) missing.push("LLM_KIT_ENDPOINT");
  if (!apiKey) missing.push("LLM_KIT_API_KEY");
  if (missing.length > 0) throw missingConfigError(missing);

  return {
    endpoint,
    apiKey,
    model,
    maxOutputTokens,
    contextWindowTokens,
  };
}

export function buildCompactionContext(config, explicitBudget) {
  if (explicitBudget !== undefined) {
    return {
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: explicitBudget,
    };
  }
  if (!config.contextWindowTokens) return undefined;

  const budget = computeBudget({
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens ?? 65536,
  });
  return {
    strategy: createFoldStatisticalStrategy(),
    budgetTokens: budget,
  };
}
