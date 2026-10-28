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
import { PROVIDER_PHASE_TIMEOUT_FIELDS, assertPhaseTimeoutValue } from "./provider-timeouts.js";

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

  // issue #441：静默相位截止的四个键——两个流式相位由 CLI 按 `--idle-timeout` 派生（见
  // bin/provider-timeouts.js；非流式的 `requestTimeoutMs` 保持 legacy）；用户也能直接配。
  // 显式配置**优先于派生值**（只警告不改值）；非法取值报错并点名键（见 provider-timeouts.js）。
  const forwardedFields = [
    "protocol",
    "timeout",
    "requestTimeoutMs",
    "firstByteTimeoutMs",
    "streamIdleTimeoutMs",
    "streamTotalTimeoutMs",
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
    if (fileConfig[field] === undefined) continue;
    modelOptions[field] = PROVIDER_PHASE_TIMEOUT_FIELDS.includes(field)
      ? assertPhaseTimeoutValue(field, fileConfig[field])
      : fileConfig[field];
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

/**
 * issue #498 S5：把 `buildCompactionContext` 的那一块拆成**规位**的两半。
 *
 * 为什么必须拆（不是「整块搬」）：这一块里混着两类值——`budgetTokens` / `strategy` 是数据
 * （数字、内置策略名），`protectedMessage` / `recoveryHint` / `stubFor` 是函数。按母单 #495 的
 * 归属规则，数据进 `config.folding.context`，函数进 `capabilities.hooks.*`（S4c 的形态多态旋钮
 * 与折叠回调各归各位）。整块塞进 `config.folding.context` 会被 intake 当场拒绝——`config` 子树
 * 必须过 JSON round-trip，`collectFunctionPaths` 会点名 `config.folding.context.recoveryHint`
 * 并抛。
 *
 * 拆分口径是**值的形态**，不是键名白名单：函数 ⇒ 能力面，其余 ⇒ 配置面。这与 S4c 给
 * `protectedMessage` / `recoveryHint` 定的规则逐字同源（数据形态留 `config.folding.context`，
 * 函数形态进 `capabilities.hooks`），所以以后这一块多一个函数值也不会静默留在数据侧。
 *
 * ⚠ `strategy` 在本机 CLI 里**永远**是内置策略名（`resolveCompactionStrategyName` 返回字符串），
 * 所以它落数据侧；对象形态的策略对象属 `capabilities.ports.strategy`，CLI 不产生它——真出现时
 * 这里会把它当数据放进 `config.folding.context.strategy`，引擎照旧原样透传（`context.strategy`
 * 的对象形态语义不变），不是静默丢弃。
 *
 * @param {Record<string, unknown>|undefined} context `buildCompactionContext` 的返回值
 * @returns {{data?: Record<string, unknown>, hooks?: Record<string, Function>}}
 */
export function splitCompactionContext(context) {
  if (context === undefined) return {};
  const data = {};
  const hooks = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "function") hooks[key] = value;
    else data[key] = value;
  }
  return {
    ...(Object.keys(data).length === 0 ? {} : { data }),
    ...(Object.keys(hooks).length === 0 ? {} : { hooks }),
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
