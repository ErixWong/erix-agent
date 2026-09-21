import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createJsonFileModelConfigProvider } from "../src/config/json-file.js";
import {
  computeBudget,
  createFoldStatisticalStrategy,
} from "../src/index.js";
import { isRealUser } from "../src/compact/helpers.js";

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
  if (missing.includes("LLM_KIT_MODEL or ERIX_DEFAULT_MODEL or slots.default.model")) {
    return new Error(
      `缺少配置：${missing.join("、")}。\n`
      + "请在配置文件 slots.default.model 设置 model，"
      + "或设置 LLM_KIT_MODEL/ERIX_DEFAULT_MODEL。",
    );
  }
  return new Error(
    `缺少环境变量：${missing.join("、")}。\n请先设置，例如：\n  export LLM_KIT_ENDPOINT="https://你的 OpenAI 兼容 API 地址"\n  export LLM_KIT_API_KEY="你的 API 密钥"`,
  );
}

export async function loadCliConfig({ configPath, model: modelOverride } = {}) {
  const fileConfig = await loadFileConfig(configPath ?? defaultConfigPath());
  const endpoint = readEnvironmentValue("LLM_KIT_ENDPOINT") ?? fileConfig.endpoint;
  const apiKey = readEnvironmentValue("LLM_KIT_API_KEY") ?? fileConfig.apiKey;
  const model = readEnvironmentValue("LLM_KIT_MODEL")
    || (typeof modelOverride === "string" ? modelOverride.trim() : undefined)
    || fileConfig.model
    || readEnvironmentValue("ERIX_DEFAULT_MODEL");
  const maxOutputTokens =
    parsePositiveInteger(fileConfig.maxOutputTokens)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const contextWindowTokens = parsePositiveInteger(fileConfig.contextWindowTokens);
  const missing = [];

  if (!endpoint) missing.push("LLM_KIT_ENDPOINT");
  if (!apiKey) missing.push("LLM_KIT_API_KEY");
  if (!model) missing.push("LLM_KIT_MODEL or ERIX_DEFAULT_MODEL or slots.default.model");
  if (missing.length > 0) throw missingConfigError(missing);

  const forwardedFields = [
    "protocol",
    "timeout",
    "model_type",
    "supports_reasoning",
    "thinking_format",
    "thinking",
    "reasoning",
    "reasoning_effort",
    "enable_thinking",
    "cacheCapable",
    "chat_template_kwargs",
    "providerOptions",
    "frequency_penalty",
    "presence_penalty",
    "response_format",
  ];
  const modelOptions = {};
  for (const field of forwardedFields) {
    if (fileConfig[field] !== undefined) modelOptions[field] = fileConfig[field];
  }

  return {
    endpoint,
    apiKey,
    model,
    ...modelOptions,
    maxOutputTokens,
    contextWindowTokens,
  };
}

function withRecoveryHint(context, recoveryHint, stubFor) {
  if (
    (typeof recoveryHint !== "string" || recoveryHint.trim() === "")
    && typeof recoveryHint !== "function"
    && typeof stubFor !== "function"
  ) {
    return context;
  }
  if (context === undefined) return {
    ...(recoveryHint === undefined ? {} : { recoveryHint }),
    ...(stubFor === undefined ? {} : { stubFor }),
  };
  return {
    ...context,
    ...(recoveryHint === undefined ? {} : { recoveryHint }),
    ...(stubFor === undefined ? {} : { stubFor }),
    strategy: createFoldStatisticalStrategy({
      ...(recoveryHint === undefined ? {} : { recoveryHint }),
      ...(stubFor === undefined ? {} : { stubFor }),
    }),
  };
}

export function buildCompactionContext(config, explicitBudget, recoveryHint, stubFor) {
  if (explicitBudget !== undefined) {
    return withRecoveryHint({
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: explicitBudget,
      protectedMessage: isRealUser,
    }, recoveryHint, stubFor);
  }
  if (!config.contextWindowTokens) return withRecoveryHint(undefined, recoveryHint, stubFor);

  const budget = computeBudget({
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens ?? 65536,
  });
  return withRecoveryHint({
    strategy: createFoldStatisticalStrategy(),
    budgetTokens: budget,
    protectedMessage: isRealUser,
  }, recoveryHint, stubFor);
}
