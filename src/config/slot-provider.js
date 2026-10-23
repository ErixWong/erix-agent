// @ts-check
/**
 * 槽位 → provider 的构造件（issue #406 B2-a 的 C-a，设计稿 §4「只把『槽位 → provider』那几行升进 `src/`」）。
 *
 * 为什么要有这个文件：宿主想用 `normalizeModelJson`（`src/normalization/parse-model-json.js`）
 * 的 L2 兜底，就得先有 provider；而「读 `~/.erix/config.json` 的 `slots.default` → 校验必填字段 →
 * 摊平成 `createOpenAIProvider` 的具名参数」这三件事，今天**每个宿主各写一份**
 * （本仓的 `examples/pi-extension/erix-run-core.js` 就有一份，`erix_run` 正是靠它绕的）。
 * 一份口径两处实现 = 两条漂移路径，所以把它升成契约面。
 *
 * **只做三件事**（设计稿的边界，别扩）：
 *   1. 默认路径解析（`~` 展开 + 配置路径环境变量 `ERIX_CONFIG_PATH` + `XDG_CONFIG_HOME`）；
 *   2. 必填字段校验 + 人可读错误文案（`config_missing` / `config_invalid` 两个 code 保留）；
 *   3. 槽位摊平桥接到 `createOpenAIProvider`。
 *
 * **刻意不做的**（拖进来就等于把 `bin/` 变成契约面，设计稿 §4 明令禁止）：
 *   - 不 import `bin/tools.js` 的 `createCliTools`、也不 import `bin/final-guard.js` 的
 *     `createDeliverableChecks`——工具装配与交付物判据是 CLI 侧的事，不是宿主契约；
 *   - 不做动态 `import()` 探测（那只是 pi 扩展的加载形态，`src/` 里可以直接 import）；
 *   - 不自己挑协议：今天只有 OpenAI 兼容这一条路（`createProviderForSlot` 的名字就是承诺），
 *     加第三条协议是另一张票的事。
 *
 * 与 example 那份的关系（**报告里点名**的事实）：`examples/pi-extension/erix-run-core.js` 的
 * `loadModelSlot` / `createProviderForSlot` **还在**，两份实现同时存在。删它属于 B2-b / 公开面清理
 * （同一批还要动 `src/loop/orchestrator.js`，被 #430 占着），本单不碰。
 *
 * 两份的差异**不是一条，是五条**（合并前评审实测；原先这里写「差异只有一条」，与下文自相矛盾）：
 *   1. **首参**：example 那份的 `loadModelSlot({lib, …})` / `createProviderForSlot(lib, slot, …)` 带 `lib`
 *      （扩展动态加载的产物），本文件在 `src/` 里直接 import，**没有那个首参**；
 *   2. **`ERIX_CONFIG_PATH`**：example 的 `defaultConfigPath` **实际不读**它（只在错误文案里承诺「可用
 *      `ERIX_CONFIG_PATH` 指定别的路径」——文案兑现了、代码没兑现），本文件的 `resolveConfigPath` 真的读
 *      （排在显式 `configPath` 之后、`XDG_CONFIG_HOME` 之前）；
 *   3. **`warn`（M7）**：只有本文件的 `createProviderForSlot` 有 `warn` 注入口（一路接到
 *      `createRequestInjection`），example 那份没有——宿主在 example 路径上接不住那条 warn；
 *   4. **错误载体**：example 抛 `ErixRunError(code, message, {detail})`，本文件抛 `KitError(code, message,
 *      {cause})`——`code` 字面值相同（`config_missing` / `config_invalid`），但**结构化细节的键名不同**
 *      （`detail` vs `cause`），且 example 多一个 `lib_missing` 分支（它靠动态加载拿库，`src/` 不需要）；
 *   5. **`metadataMissing` 的键存在性**：example 的返回值**总是**带这个键（可能是 `undefined`），
 *      本文件**缺元数据时才出现该键**（「探不到就不写键」）——于是 `"metadataMissing" in result` 在
 *      两份实现上答案相反。
 *
 * 迁移到本文件时这五条都要逐条对账，不能当「同一份实现搬了个家」。
 *
 * 零依赖：只用 `node:` 内建与相对路径。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { KitError } from "../providers/errors.js";
import { createOpenAIProvider } from "../providers/openai.js";
import { createJsonFileModelConfigProvider } from "./json-file.js";

/** 配置路径环境变量（与 `examples/pi-extension/erix-run-core.js` 的 `CONFIG_PATH_ENV` 同一个名字）。 */
export const CONFIG_PATH_ENV = "ERIX_CONFIG_PATH";

/** 单次请求的默认硬超时（与 example 的 `PROVIDER_TIMEOUT_MS` 同值：5 分钟）。 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

/**
 * `~` / `~/x` 展开（不解析环境变量、不猜别的简写）。
 *
 * @param {unknown} value
 * @param {{home?:string}} [options]
 * @returns {string}
 */
function expandUserPath(value, { home = homedir() } = {}) {
  const raw = String(value ?? "");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.resolve(home, raw.slice(2));
  return raw;
}

/**
 * 配置缺省路径：显式 `configPath` > `ERIX_CONFIG_PATH` > `$XDG_CONFIG_HOME/erix/config.json`
 * > `~/.erix/config.json`。
 *
 * 为什么环境变量排在 XDG 之前：`ERIX_CONFIG_PATH` 是**本包自己**的旋钮（错误文案里一直这么
 * 承诺），而 `XDG_CONFIG_HOME` 是整台机器的通用约定——宿主显式设了前者就是更具体的意图。
 * 注：example 那份的 `loadModelSlot` 只在**错误文案**里提到 `ERIX_CONFIG_PATH`，实际并不读它
 * （文案承诺了、代码没兑现）；本文件把这个洞补上（两份实现的总差异清单见文件头五条）。
 *
 * @param {{configPath?:string, env?:Record<string,string|undefined>, home?:string}} [options]
 * @returns {string}
 */
function resolveConfigPath({ configPath, env = process.env, home = homedir() } = {}) {
  if (configPath !== undefined && configPath !== null && String(configPath) !== "") {
    return expandUserPath(configPath, { home });
  }
  const fromEnv = env[CONFIG_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return expandUserPath(fromEnv, { home });
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (typeof xdgConfigHome === "string" && xdgConfigHome.trim() !== "") {
    return path.join(xdgConfigHome, "erix", "config.json");
  }
  return path.join(home, ".erix", "config.json");
}

/** @param {unknown} value */
function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value ?? "");
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读 `slots.default` 并校验必填字段。
 *
 * 返回形状与 example 那份逐字一致（`{slot, configPath, metadataMissing}`）：`metadataMissing`
 * 不是必填校验，而是**如实报告**「预算元数据缺了哪些」——引擎的 `model_metadata_missing`
 * 事件与它是同一口径（缺元数据 = 压缩与聚合输出预算整轮关闭）。少了它，宿主就得自己再判一次
 * `Number.isSafeInteger`，那就是第二份口径。
 *
 * @param {{
 *   configPath?:string,
 *   modelOverride?:string,
 *   env?:Record<string,string|undefined>,
 *   home?:string,
 * }} [options]
 * @returns {Promise<{
 *   slot: Record<string, any>,
 *   configPath: string,
 *   metadataMissing?: {detail:string, missingFields:string[], source:string},
 * }>}
 */
export async function loadModelSlot({
  configPath,
  modelOverride,
  env = process.env,
  home = homedir(),
} = {}) {
  const resolvedPath = resolveConfigPath({ configPath, env, home });

  if (!existsSync(resolvedPath)) {
    throw new KitError(
      "config_missing",
      `模型配置不存在：${resolvedPath}（需要 slots.default 提供 endpoint/model/apiKey；`
      + `可用 ${CONFIG_PATH_ENV} 指定别的路径）`,
    );
  }

  /** @type {unknown} */
  let rawSlot;
  try {
    rawSlot = await createJsonFileModelConfigProvider({ path: resolvedPath }).resolve("default");
  } catch (error) {
    throw new KitError(
      "config_invalid",
      `模型配置解析失败（${resolvedPath}）：${textOf(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(rawSlot)) {
    throw new KitError(
      "config_invalid",
      `模型配置 slots.default 必须是对象（${resolvedPath}）`,
    );
  }

  const slot = { .../** @type {Record<string, any>} */ (rawSlot) };
  if (modelOverride !== undefined) slot.model = modelOverride;

  /** @type {string[]} */
  const missing = [];
  if (typeof slot.endpoint !== "string" || slot.endpoint.trim() === "") missing.push("endpoint");
  if (typeof slot.model !== "string" || slot.model.trim() === "") missing.push("model");
  if (typeof slot.apiKey !== "string" || slot.apiKey.trim() === "") {
    missing.push("apiKey|apiKeyEnv|apiKeyFile");
  }
  if (missing.length > 0) {
    throw new KitError(
      "config_invalid",
      `模型配置 slots.default 缺少必填字段 ${missing.join(", ")}（${resolvedPath}）`,
    );
  }

  const budgetFields = ["contextWindowTokens", "maxOutputTokens"];
  const missingFields = budgetFields.filter((field) => !Number.isSafeInteger(slot[field]));
  const metadataMissing = missingFields.length === budgetFields.length
    ? {
      detail: `slots.default 缺少 ${missingFields.join("/")};`
        + " compaction and aggregate output budget are disabled for this run",
      missingFields,
      source: "config",
    }
    : undefined;

  return {
    slot,
    configPath: resolvedPath,
    ...(metadataMissing === undefined ? {} : { metadataMissing }),
  };
}

/**
 * 槽位 → OpenAI 兼容 provider。
 *
 * 槽位**整体摊平**进去：内置 provider 读固定参数清单，未知字段惰性（契约「Unknown slot fields
 * are inert and safe」）；`maxTokens` 回落到 `maxOutputTokens`，把 `contextWindowTokens` /
 * `maxOutputTokens` 重新暴露到 provider 对象上（引擎元数据探测的第 4 顺位）。
 *
 * `warn`（issue #406 M7）：宿主注入口 `extraBody` / `defaultHeaders` 冲突时引擎会显式 warn
 * （`createInjectionWarner`，每个字段只说一次）。在此之前那条 warn 只能打印到 console，
 * 宿主既接不住也测不到——本函数把它一路接到 `createRequestInjection`，宿主拿到的是一个回调。
 *
 * @param {Record<string, any>} slot
 * @param {{timeoutMs?:number, warn?:(message:string)=>void}} [options]
 * @returns {ReturnType<typeof createOpenAIProvider>}
 */
export function createProviderForSlot(slot, { timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, warn } = {}) {
  if (!isRecord(slot)) {
    throw new TypeError("createProviderForSlot: slot 必须是对象（loadModelSlot 的返回值里的 slot）");
  }
  return createOpenAIProvider({
    ...slot,
    endpoint: slot.endpoint,
    apiKey: slot.apiKey,
    model: slot.model,
    maxTokens: slot.maxTokens ?? slot.maxOutputTokens,
    timeoutMs,
    ...(warn === undefined ? {} : { warn }),
  });
}
