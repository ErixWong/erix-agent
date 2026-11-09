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
import {
  CONTINUITY_WRITE_DEFAULT,
  CONTINUITY_WRITE_MODES,
} from "../src/loop/continuity-block.js";
import { PROVIDER_PHASE_TIMEOUT_FIELDS, assertPhaseTimeoutValue } from "./provider-timeouts.js";
// issue #798：`reasoning_effort` 的三通道优先级只有这一处实现（旗标 > env > slot）。
import { normalizeReasoningEffort, resolveReasoningEffort } from "./reasoning-effort.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * 压缩预算的**唯一**优先级实现（issue #682）：
 *
 *   旗标（`--compact-budget`） > 配置叶子（`slots.default.compactBudgetTokens`） > 窗口派生 > 关闭
 *
 * 为什么必须是**一个**函数：`bin/cli.js` / `bin/repl.js` / `bin/delegation.js`（子 run）与
 * `bin/config.js` 内部的 `buildCompactionContext` 是四处调用方。以前「显式预算」只走旗标，
 * 而子 run 读不到旗标 ⇒ 父显式给的预算在子侧静默丢失（#630 S2/F 才补了一根下传管子）。
 * 现在配置叶子天然被父子共享，下传管子退化为「只服务旗标临时覆盖」；四处共用本函数，
 * 不许任何一处另写一套次序。
 *
 * 四态（`COMPACTION_BUDGET_SOURCES`）是**可观测事实**，不是形容词：
 *   · `flag`     —— `--compact-budget <tokens>`（显式临时覆盖）；
 *   · `config`   —— `slots.default.compactBudgetTokens`（持久配置，父子自动继承）；
 *   · `derived`  —— 由 `contextWindowTokens` + `maxOutputTokens` 推导（`computeBudget`）；
 *   · `disabled` —— 没有窗口也没有显式预算 ⇒ **不折叠**（语义保留，只出声：一行 stderr 告警）。
 *
 * @param {{contextWindowTokens?: number, maxOutputTokens?: number, compactBudgetTokens?: number}|undefined} config
 * @param {number|undefined} explicitBudget CLI 旗标（`--compact-budget`）
 * @returns {{budgetTokens: number|undefined, source: "flag"|"config"|"derived"|"disabled"}}
 */
export function resolveCompactionBudget(config, explicitBudget) {
  if (explicitBudget !== undefined) {
    return { budgetTokens: explicitBudget, source: "flag" };
  }
  const configured = config?.compactBudgetTokens;
  if (configured !== undefined) {
    // load 期已经校过一次（`loadCliConfig`）；这里是**直接调用**（测试 / 宿主脚本）的第二道闸。
    // 非法值不许悄悄退回「派生」——那正是「配了等于没配」的静默形状。
    if (!Number.isSafeInteger(configured) || configured <= 0) {
      throw new Error(
        `compactBudgetTokens 必须是正整数（收到 ${JSON.stringify(configured)}）；`
        + "省略它则按上下文窗口推导预算。",
      );
    }
    return { budgetTokens: configured, source: "config" };
  }
  if (!config?.contextWindowTokens) {
    return { budgetTokens: undefined, source: "disabled" };
  }
  // issue #682：**两处兜底合一**。`maxOutputTokens` 缺省时只认 `DEFAULT_MAX_OUTPUT_TOKENS`
  // （与 `loadCliConfig` 同一个常量），不再有 `?? 65536` 这条能算出另一个数的侧门——
  // 同一个「没配这个字段」以前在 262144 窗口下差 49152 token（≈窗口 18.8%）。
  return {
    budgetTokens: computeBudget({
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    }),
    source: "derived",
  };
}

/** 压缩预算的四个来源态（`resolveCompactionBudget` 的 `source`）。 */
export const COMPACTION_BUDGET_SOURCES = Object.freeze(["flag", "config", "derived", "disabled"]);

/**
 * 缺窗口时那一行 stderr 告警（issue #682 判据：**只加告警**，不许改成启动失败）。
 *
 * 为什么需要它：`--compact-budget` 之前，缺 `contextWindowTokens` 的 run 会「整场不折叠且不出声」——
 * 用户看到的是「跑完了」，看不到「压缩从来没启用」。语义保留（不折叠），但必须说出来。
 */
export const COMPACTION_DISABLED_WARNING = "erix: 未配置上下文窗口（slots.default.contextWindowTokens）⇒ 本次不启用自动压缩；"
  + "可用 --compact-budget <tokens> 或 slots.default.compactBudgetTokens 显式指定预算。";

/** 进程内只打一次：父 run + 每个子 run 共用同一行告警，不刷屏。 */
let compactionDisabledWarned = false;

/** 测试用：把「已告警」的进程级水位复位（默认 sink 的去重标记）。 */
export function resetCompactionDisabledWarning() {
  compactionDisabledWarned = false;
}

/** 默认 sink：一行 stderr，进程内去重。 */
function warnCompactionDisabledOnce() {
  if (compactionDisabledWarned) return;
  compactionDisabledWarned = true;
  process.stderr.write(`${COMPACTION_DISABLED_WARNING}\n`);
}
// issue #614：CLI 默认走 **语义折叠**（fold-llm）。
//
// 为什么改（#614 / #607 的实测）：CLI 必然有可用 provider（它就是用来跑模型的），却曾默认
// 放弃语义那半 ⇒ 折叠块里只有**索引**（区间 / 工具足迹 / 清单 / 锚点），没有**概括**与**经验**
// （阶段 / 下一步 / 教训与坑）。64k 预算 / 300 段逐段翻译的实测里 80.3% 的重读有相当一部分
// 是「不知道做到哪 / 不知道结论」——正是语义折叠该给的那两节。
//
// 统计摘要（fold-statistical）的位置是**零 LLM 的替代选择**，不是 fold-llm 的自动兜底：
// issue #661 起摘要器失败（含默认 30s 上限的超时）是**终局错误** `summarizer_failed`，
// 引擎不再退回统计摘要（那条 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]` 路径已删）。
// 想要「一次 LLM 都不调、永不失败」的折叠就显式选它：`--compaction fold-statistical`
// / `config.compaction`。
//
// 显式选择**仍然生效**：`--compaction fold-statistical` / `config.compaction` 优先于本默认值
// （见 `resolveCompactionStrategyName`：`--compaction` > config.compaction > 这里）。
// 库层边界不动：引擎 `resolveCompactionStrategy(undefined) → undefined`（不折），
// 「默认用哪个策略」始终是**宿主/CLI 的选择**。
export const DEFAULT_COMPACTION_STRATEGY = "fold-llm";

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

/**
 * issue #598 —— `config.continuity.handoff` 的 CLI 接线（续接块**默认写者**的开关）。
 *
 * 为什么 CLI 必须自己读它（这是本单补的那一格）：引擎早就认 `config.continuity.handoff`
 * （`src/loop/config-namespace.js` 的 schema + 值规则），但 `bin/cli.js` 的 `loopOptions.config`
 * 是**手工装配**的——没接的键不会报错，只会被静默忽略。于是用户在 `~/.erix/config.json` 里写
 * `continuity: { handoff: "prompt" }` 等于什么都没写（「配了等于没配」的静默形状）。
 *
 * 形态照抄 `resolveCompactionStrategyName`（#167 的同一把尺子）：
 *   · 未配置（`continuity` 整组缺席 / `handoff` 缺席）⇒ `undefined`，`bin/cli.js` 因此**不写**
 *     `config.continuity` 这个键（请求逐字回到今天 = 零行为变更）；
 *   · 合法字面量 ⇒ `{ handoff }`，原样交给引擎（引擎再按 schema 校一次，两处同源不冲突）；
 *   · 非法字面量 ⇒ **load 期就抛**，报错里点名收到的值与**全部合法值**。合法值列表从
 *     `src/loop/continuity-block.js#CONTINUITY_WRITE_MODES` 取，**不在本文件抄字面量**
 *     （抄一份就多一个真相来源，改一处漏一处就是「配了没生效」的下一次事故）。
 *
 * 为什么不允许「非法值悄悄退回默认 `off`」：`off` 是「不注入指令、不读写 store」那一档，
 * 一个拼错的字面量落到它上面，用户看到的是「功能没了但没报错」——这正是本仓反复拒绝的形状。
 *
 * @param {{continuity?: {handoff?: unknown}}|undefined} config 已加载的 CLI 配置（`loadCliConfig` 的产物）
 * @returns {{handoff: string}|undefined} 未配置时 `undefined`
 */
export function buildContinuityConfig(config) {
  const group = config?.continuity;
  if (group === undefined || group === null) return undefined;
  if (typeof group !== "object" || Array.isArray(group)) {
    throw new Error(
      `config.continuity 必须是对象（例如 { "handoff": "prompt" }），实际收到 ${JSON.stringify(group)}。`
      + `可选值：${CONTINUITY_WRITE_MODES.join(" | ")}（默认：${CONTINUITY_WRITE_DEFAULT}）`,
    );
  }
  const raw = /** @type {{handoff?: unknown}} */ (group).handoff;
  if (raw === undefined || raw === null) return undefined;
  const mode = typeof raw === "string" ? raw.trim() : "";
  if (!CONTINUITY_WRITE_MODES.includes(mode)) {
    throw new Error(
      `未知的续接交接模式（config.continuity.handoff）：${JSON.stringify(raw)}。`
      + `可选值：${CONTINUITY_WRITE_MODES.join(" | ")}（默认：${CONTINUITY_WRITE_DEFAULT}）`,
    );
  }
  return { handoff: mode };
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

/**
 * issue #682：CLI slot 字段 `slots.default.compactBudgetTokens`（压缩预算的持久配置叶子）。
 *
 * 口径照同文件 `compaction`（#167）那个既有先例：**非法值在 load 期就报错**，带收到的值与
 * 省略后的行为，而不是悄悄退回 `undefined`（「配了等于没配」是本仓反复拒绝的形状）。
 *
 * @param {unknown} value `slots.default.compactBudgetTokens` 的原始值
 * @returns {number|undefined} 省略 / `null` ⇒ `undefined`（= 不覆盖，按窗口派生）
 */
function resolveCompactBudgetTokens(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = parsePositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(
      `config 字段 slots.default.compactBudgetTokens 必须是正整数（收到 ${JSON.stringify(value)}）。`
      + "省略它则按上下文窗口推导预算（slots.default.contextWindowTokens）；"
      + "要临时覆盖请用 --compact-budget <tokens>。",
    );
  }
  return parsed;
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

/**
 * issue #798：`reasoning_effort` 的 **env 消费方**（此前 `LLM_KIT_REASONING_EFFORT` 没有任何人读，
 * 尽管映射早在 `src/config/env.js`）。优先级 `--effort` > env > `slots.default.reasoning_effort`，
 * 与同函数里的 `model` **故意不同**：`model` 是 env **压过**旗标的历史形状，本字段取「旗标最优先」。
 * 值域不在这里校验（#788 parked）；空值 ⇒ 视为未提供。裁决实现见 `bin/reasoning-effort.js`。
 *
 * @param {{ configPath?: string, model?: string, effort?: string }} [input]
 */
export async function loadCliConfig({ configPath, model: modelOverride, effort: effortOverride } = {}) {
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
  // issue #682：slot 字段 compactBudgetTokens（非法值在 load 期就报错，照 `compaction` 的既有做法）。
  const compactBudgetTokens = resolveCompactBudgetTokens(fileConfig.compactBudgetTokens);
  // issue #167：config 字段 compaction（非法值在 load 期就报错，带合法值列表）
  const compaction = fileConfig.compaction === undefined
    ? undefined
    : resolveCompactionStrategyName(fileConfig.compaction);
  // issue #598：config 字段 continuity（同上：非法值在 load 期就报错，带合法值列表）
  const continuity = buildContinuityConfig({ continuity: fileConfig.continuity });
  // issue #798：这里只**裁决**，**不**把它写进下面的 `modelOptions.reasoning_effort`——那条路在引擎
  // 眼里是 `slotDefault`，会把「本次 CLI 覆盖」与「配置文件里写的」混成一格。取到的值与通道随配置
  // 交给 `bin/cli.js` / `bin/repl.js`，由它们注进**请求通道**（观测面因此报 `source:"request"`）。
  const reasoningEffort = resolveReasoningEffort({
    flag: effortOverride,
    env: process.env,
    slot: fileConfig.reasoning_effort,
  });
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
    // issue #798：`reasoning_effort` 的**空值口径**在这一格也成立。循环原先只跳 `undefined`，于是
    // 配置文件写 `"reasoning_effort": ""` 时空串一路穿过 provider 构造参数、进 payload，直接违反本单
    // 自己承诺的「空值 = 未提供（不发字段）」——旗标/env 那两条走 resolver 是干净的，slot 这条不是。
    // 这里**复用** resolver 那一份归一化，不写第二处空白判断（同一句理由：一个口径只许有一处实现）。
    // 归一化成 `undefined` ⇒ 这一格根本不写进 `modelOptions`（钉住它的用例是 wire 层那一条：断请求体里
    // **没有这个键**，见 `test/cli-reasoning-effort-798.test.js` 的「空值(slot 那条路)」。）
    const value = field === "reasoning_effort"
      ? normalizeReasoningEffort(fileConfig[field])
      : fileConfig[field];
    if (value === undefined) continue;
    modelOptions[field] = PROVIDER_PHASE_TIMEOUT_FIELDS.includes(field)
      ? assertPhaseTimeoutValue(field, value)
      : value;
  }

  return {
    endpoint,
    apiKey,
    model,
    ...modelOptions,
    maxOutputTokens,
    contextWindowTokens,
    // 没事实就不产键（与统计行同一条口径）。
    ...(reasoningEffort.value === undefined ? {} : { reasoningEffort }),
    ...(compactBudgetTokens === undefined ? {} : { compactBudgetTokens }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(continuity === undefined ? {} : { continuity }),
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

export function buildCompactionContext(config, explicitBudget, recoveryHint, stubFor, options = {}) {
  const strategyName = resolveCompactionStrategyName(config?.compaction);
  // issue #682：**唯一**的优先级实现（旗标 > 配置叶子 > 窗口派生 > 关闭），四处调用方共用。
  const resolved = resolveCompactionBudget(config, explicitBudget);
  if (resolved.budgetTokens === undefined) {
    // 缺窗口 ⇒ 保留「不折叠」（返回 undefined，引擎侧压缩总开关不进入），但**必须出声**：
    // 一行 stderr 告警（默认 sink 进程内去重；测试可注入自己的 sink 断言文本）。
    (options.warn ?? warnCompactionDisabledOnce)(COMPACTION_DISABLED_WARNING);
    return withRecoveryHint(undefined, strategyName, recoveryHint, stubFor);
  }

  return withRecoveryHint({
    budgetTokens: resolved.budgetTokens,
    // issue #682：来源进 `config.folding.context`（数据面），子 run 记录因此带得走四态。
    budgetSource: resolved.source,
    protectedMessage: isRealUser,
  }, strategyName, recoveryHint, stubFor);
}
