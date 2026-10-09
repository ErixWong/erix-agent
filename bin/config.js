import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createJsonFileModelConfigProvider } from "../src/config/json-file.js";
import {
  BUILTIN_COMPACTION_STRATEGY_NAMES,
  computeBudget,
  isBuiltinCompactionStrategyName,
} from "../src/index.js";
import { isRealUser } from "../src/compact/helpers.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
// issue #167：默认仍为 fold-statistical（零额外模型调用），fold-llm 需用户显式选择
export const DEFAULT_COMPACTION_STRATEGY = "fold-statistical";

/**
 * CLI 旗标形态的校验：不合法名字直接报错（带合法值列表），而非默默回到默认值。
 * @param {string} rawValue
 * @returns {string} 规范化后的策略名
 */
export function normalizeCompactionOption(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (value === "" || !isBuiltinCompactionStrategyName(value)) {
    throw new Error(
      `未知的压缩策略：${JSON.stringify(rawValue)}；可选值：${BUILTIN_COMPACTION_STRATEGY_NAMES.join(" | ")}`,
    );
  }
  return value;
}

/**
 * CLI/config 的压缩策略名解析（#167）：`--compaction` > config.compaction > 默认值。
 * 名字以**字符串**形式向下传递，由引擎解析并（对 fold-llm）注入默认 summarizer——
 * CLI 因此不需要自己写调模型的胶水。
 */
export function resolveCompactionStrategyName(value) {
  if (value === undefined || value === null) return DEFAULT_COMPACTION_STRATEGY;
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || !isBuiltinCompactionStrategyName(name)) {
    throw new Error(
      `未知压缩策略：${JSON.stringify(value)}。可选值：${BUILTIN_COMPACTION_STRATEGY_NAMES.join(" | ")}`
      + `（默认：${DEFAULT_COMPACTION_STRATEGY}）`,
    );
  }
  return name;
}

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
  // issue #167：config 字段 compaction（非法值在 load 期就报错，带合法值列表）
  const compaction = fileConfig.compaction === undefined
    ? undefined
    : resolveCompactionStrategyName(fileConfig.compaction);
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
    ...(compaction === undefined ? {} : { compaction }),
  };
}

function withRecoveryHint(context, strategyName, recoveryHint, stubFor) {
  if (context === undefined) {
    if (
      (typeof recoveryHint !== "string" || recoveryHint.trim() === "")
      && typeof recoveryHint !== "function"
      && typeof stubFor !== "function"
    ) {
      return undefined;
    }
    // 无预算但宿主/CLI 给了恢复提示：保持旧行为（只带提示，不启用压缩）
    return {
      ...(recoveryHint === undefined ? {} : { recoveryHint }),
      ...(stubFor === undefined ? {} : { stubFor }),
    };
  }
  return {
    ...context,
    strategy: strategyName,
    ...(recoveryHint === undefined ? {} : { recoveryHint }),
    ...(stubFor === undefined ? {} : { stubFor }),
  };
}

export function buildCompactionContext(config, explicitBudget, recoveryHint, stubFor) {
  const strategyName = resolveCompactionStrategyName(config?.compaction);
  if (explicitBudget !== undefined) {
    return withRecoveryHint({
      budgetTokens: explicitBudget,
      protectedMessage: isRealUser,
    }, strategyName, recoveryHint, stubFor);
  }
  if (!config.contextWindowTokens) {
    return withRecoveryHint(undefined, strategyName, recoveryHint, stubFor);
  }

  const budget = computeBudget({
    contextWindowTokens: config.contextWindowTokens,
    maxOutputTokens: config.maxOutputTokens ?? 65536,
  });
  return withRecoveryHint({
    budgetTokens: budget,
    protectedMessage: isRealUser,
  }, strategyName, recoveryHint, stubFor);
}
