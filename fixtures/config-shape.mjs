// 真配置形状构造器（issue #257 T3）——**全仓唯一一份**「假配置长什么样」的口径。
//
// 为什么存在：真实事故是 examples/ 里把 provider 槽位名写死成 `my-relay`，而真配置里
// 根本没有这个名字 ⇒ `LLM_KIT_E2E=1` 的四个真实场景起跑即失败，瞎了约三周。同类腐化的
// 根因是「假配置的形状由测试自己造、断言由同一个人写」——本文件把形状从**读取方代码**里
// 抄出来钉在一处，测试只填值、不发明字段名（发明不出来的键会被这里直接抛错）。
//
// ============================================================================
// 两套形状，**字段名不同，别混**（这是本文件存在的主要理由）
// ============================================================================
//
// 【形状 A】`~/.erix/config.json` —— CLI（`bin/cli.js`）与 erix_run 走这份
//   读取链：`bin/config.js#loadCliConfig` → `loadFileConfig` →
//             `src/config/json-file.js#createJsonFileModelConfigProvider({path}).resolve("default")`
//   路径解析：`bin/config.js#defaultConfigPath`（`XDG_CONFIG_HOME/erix/config.json` 优先，
//             否则 `<HOME>/.erix/config.json`）；`--config <path>` 覆盖。
//             examples/pi-extension/erix-run-core.js 有同式的 `defaultConfigPath`，
//             路径可用它导出的 `CONFIG_PATH_ENV`（`ERIX_CONFIG_PATH`）指定，
//             槽位读取在 `loadModelSlot`。
//   顶层只有 `slots`（`json-file.js` 的 `resolve` 只认 `parsed.slots`）：
//     请求的槽位不存在时回落 `slots.default`，两者都没有 → KitError「配置槽位不存在」。
//   **端点字段名是 `endpoint`**（`loadCliConfig` 读 `fileConfig.endpoint`）；
//   写成 `baseUrl` 的失败形状是 `exit 1` +「缺少环境变量：LLM_KIT_ENDPOINT」，一条请求也不会发。
//   槽位内被真实读取的键（逐个抄自 `loadCliConfig`，未被读取的键写了也惰性）：
//     endpoint / apiKey / model / maxOutputTokens / contextWindowTokens / compaction
//     + `loadCliConfig` 里 `forwardedFields` 那份模型选项透传清单（见 ERIX_SLOT_MODEL_OPTION_KEYS）
//   apiKey 还可以只给引用、不给值：`src/config/api-key.js#resolveApiKey` 认
//     `apiKey` → `apiKeyEnv`（环境变量名）→ `apiKeyFile`（文件路径，三选一，按此顺序）。
//   环境变量优先于文件（`loadCliConfig` 里是 `readEnvironmentValue("LLM_KIT_ENDPOINT") ?? fileConfig.endpoint`
//   这个方向），所以拿假 HOME 做测试时必须把 `MODEL_CONFIG_ENV_NAMES` 里那些清掉，
//   否则宿主 shell 里的真配置会盖掉假配置，用例绿得毫无意义。
//
// 【形状 B】`~/.pi/agent/models.json` —— `examples/*.test.mjs` 那条 relay 链走这份
//   读取链：`examples/exec-demo.js#loadRelayConfig`（路径就是 `join(homedir(), ".pi/agent/models.json")`，
//             **不认 XDG**，靠 `HOME` 造假家目录）。
//   顶层是 `providers`（槽位名 → 条目）；条目字段是 **`baseUrl`**（不是 endpoint）+ `apiKey`
//   + `models[]`，模型条目字段是 `id`（`modelIdsOf` 只认 `model.id`）、`maxTokens`、`contextWindow`。
//   `loadRelayConfig` 的取值口径：endpoint ← `entry.baseUrl`，contextWindowTokens ← `models[0].contextWindow`，
//   maxOutputTokens ← `Math.min(models[0].maxTokens ?? 8192, 8192)`（上限 8192 由 issue #245 钉过）。
//   槽位名的解析顺序在 `resolveProvider`：`LLM_KIT_RELAY_PROVIDER` 按名 → `LLM_KIT_RELAY_URL` 同源匹配
//   `baseUrl` → `LLM_KIT_MODEL` 反查 → 只有一个槽位就用它 → 否则抛错列候选。
//   ⇒ **槽位名随用户机器配置走，测试里不许写死**：要名字就从本文件拿（`RELAY_PROVIDER_SLOT`），
//     或者由 `providers` 的键推出来。事故里写死的 `my-relay` 以常量形式留在这里
//     （`HISTORIC_RELAY_PROVIDER_SLOT`），源码里再出现那个字面量会被静态守卫拦下。
//
// 【拼真上游】`fixtures/upstream.mjs#createScriptedUpstream(...).listen()` 返回
//   `http://127.0.0.1:<内核给的端口>`（**不带** `/v1`，路径由 provider 自己拼）。
//   同一个 URL 填进两套形状的**不同键名**：形状 A → `endpoint`，形状 B → `baseUrl`。
//   `upstreamFields()` 把这个差别摊开，免得再有人写反。
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 形状 A 的槽位名：`json-file.js` 的 `resolve()` 默认就取这个（缺失即报「配置槽位不存在」）。 */
export const ERIX_CONFIG_SLOT = "default";

/**
 * 形状 B 的默认槽位名。**故意用 `join` 拼出来**：这样源码里不存在 `"relay-slot"` 这个
 * 连续字面量，测试要名字必须 import 本常量——静态守卫（`test/static-guards.test.js`）
 * 就是把「字面槽位名」当违规来扫的。
 */
export const RELAY_PROVIDER_SLOT = ["relay", "slot"].join("-");

/** 事故里那个写死的槽位名（`examples/exec-demo.js` 曾写 `providers["…"]` 取它，真实机器上没有）。 */
export const HISTORIC_RELAY_PROVIDER_SLOT = ["my", "relay"].join("-");

/** 形状 A 槽位里 `loadCliConfig` 直接读取的核心键（`apiKey` 的三个变体见 `resolveApiKey`）。 */
export const ERIX_SLOT_CORE_KEYS = Object.freeze([
  "endpoint",
  "apiKey",
  "apiKeyEnv",
  "apiKeyFile",
  "model",
  "maxOutputTokens",
  "contextWindowTokens",
  "compaction",
  // issue #598：`loadCliConfig` 现在也读 `continuity`（`bin/config.js#buildContinuityConfig`
  // → `config.continuity.handoff`，续接块默认写者的开关）。名单口径照本文件头的纪律：
  // **先改读取方，再改这里**——读取方是 `bin/config.js#loadCliConfig`，不是本文件。
  "continuity",
]);

/**
 * 形状 A 槽位里被 `loadCliConfig` 的 `forwardedFields` 透传进 modelOptions 的键。
 * 名单以那份数组为准——**新增字段请改读取方，再改这里**，不要在测试里发明新名字。
 */
export const ERIX_SLOT_MODEL_OPTION_KEYS = Object.freeze([
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
]);

/** 形状 A 槽位允许出现的键全集（其余键本文件直接抛错，防「测试自己发明字段名」）。 */
export const ERIX_SLOT_ALLOWED_KEYS = Object.freeze([
  ...ERIX_SLOT_CORE_KEYS,
  ...ERIX_SLOT_MODEL_OPTION_KEYS,
]);

/** 形状 B 的 provider 条目键（`loadRelayConfig` / `resolveProvider` 只读这些）。 */
export const RELAY_ENTRY_KEYS = Object.freeze(["baseUrl", "apiKey", "models"]);

/** 形状 B 的模型条目键（`modelIdsOf` 认 `id`，`loadRelayConfig` 认 `contextWindow` / `maxTokens`）。 */
export const RELAY_MODEL_KEYS = Object.freeze(["id", "maxTokens", "contextWindow"]);

/**
 * 会**盖掉假配置文件**的环境变量：拿假 HOME 起 CLI / 调 `loadCliConfig` 时必须清掉。
 * 出处：`bin/config.js#loadCliConfig` 的 `readEnvironmentValue` 三处 + `ERIX_DEFAULT_MODEL`、
 * `examples/pi-extension/erix-run-core.js` 的 `CONFIG_PATH_ENV`、
 * `examples/exec-demo.js#resolveProvider` 的三个 relay 入口。
 */
export const MODEL_CONFIG_ENV_NAMES = Object.freeze([
  "LLM_KIT_ENDPOINT",
  "LLM_KIT_API_KEY",
  "LLM_KIT_MODEL",
  "ERIX_DEFAULT_MODEL",
  "ERIX_CONFIG_PATH",
  "LLM_KIT_RELAY_PROVIDER",
  "LLM_KIT_RELAY_URL",
  "XDG_CONFIG_HOME",
]);

function pickAllowed(source, allowed, label) {
  const out = {};
  const unknown = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) {
      unknown.push(key);
      continue;
    }
    out[key] = value;
  }
  if (unknown.length > 0) {
    throw new TypeError(
      `${label} 出现未被读取方读取的键 ${JSON.stringify(unknown.sort())}；`
      + `允许的键=${JSON.stringify(allowed)}。`
      + "假配置的字段名必须来自读取方（见本文件头注释），不要自己发明。",
    );
  }
  return out;
}

/**
 * 形状 A：造一份 `~/.erix/config.json` 的对象（不落盘）。
 *
 * 只写显式给出的键：`loadCliConfig` 对缺省的 `maxOutputTokens` 自带默认值
 * （`bin/config.js` 的 `DEFAULT_MAX_OUTPUT_TOKENS`），造出来的形状要能被「没写这个键」的路径复用。
 *
 * @param {{
 *   slot?: string,                       // 槽位名，默认 `ERIX_CONFIG_SLOT`
 *   endpoint?: string,                   // **不是 baseUrl**
 *   apiKey?: string, apiKeyEnv?: string, apiKeyFile?: string,
 *   model?: string,
 *   maxOutputTokens?: number, contextWindowTokens?: number,
 *   compaction?: string,
 *   continuity?: {handoff?: string},  // issue #598：`config.continuity.handoff`（默认 `off`）
 *   [modelOptionKey?: string]: unknown,  // 仅 `ERIX_SLOT_MODEL_OPTION_KEYS` 里的键
 * }} [fields]
 * @returns {{slots: Record<string, object>}}
 */
export function erixConfigShape(fields = {}) {
  const { slot = ERIX_CONFIG_SLOT, ...rest } = fields;
  return { slots: { [slot]: pickAllowed(rest, ERIX_SLOT_ALLOWED_KEYS, "erix config slot") } };
}

/**
 * 形状 B 的一个 provider 条目（`models.json` 里 `providers` 的值）。
 *
 * `modelIds` 是便捷入口：逐个建成 `{ id }` 并补上 `maxTokens` / `contextWindow`
 * （`loadRelayConfig` 只取 `models[0]` 的两个预算字段，所以这两值要显式给，别指望默认）。
 *
 * @param {{
 *   baseUrl: string,                     // **不是 endpoint**
 *   apiKey?: string,
 *   modelIds?: string[],
 *   models?: Array<{id:string, maxTokens?:number, contextWindow?:number}>,
 *   maxTokens?: number, contextWindow?: number,
 * }} fields
 */
export function relayProviderEntry(fields) {
  const { baseUrl, apiKey, modelIds, models, maxTokens, contextWindow } = fields ?? {};
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("relay provider 条目必须有 baseUrl（形状 B 的端点字段名，见文件头注释）");
  }
  const entries = models !== undefined
    ? models.map((model) => pickAllowed(model ?? {}, RELAY_MODEL_KEYS, "models[] 条目"))
    : (modelIds ?? []).map((id) => ({
      id,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }));
  return pickAllowed({ baseUrl, apiKey, models: entries }, RELAY_ENTRY_KEYS, "relay provider 条目");
}

/**
 * 形状 B：造一份 `~/.pi/agent/models.json` 的对象（不落盘）。
 *
 * 单槽位写法：`{ baseUrl, apiKey, modelIds }`（槽位名默认 `RELAY_PROVIDER_SLOT`）；
 * 多槽位写法：`{ providers: { 名字: relayProviderEntry(...) , ... } }`——多槽位用例常常要
 * 自己挑名字（测「按名命中」「按模型反查」），但**名字必须是变量或本文件的常量**，
 * 不许在 examples/ 与 test/ 里以字面量下标出现。
 *
 * @param {{
 *   baseUrl?: string, apiKey?: string, modelIds?: string[],
 *   maxTokens?: number, contextWindow?: number,
 *   providerName?: string,
 *   providers?: Record<string, object>,
 * }} [fields]
 * @returns {{providers: Record<string, object>}}
 */
export function relayModelsShape(fields = {}) {
  const { providerName = RELAY_PROVIDER_SLOT, providers, ...single } = fields;
  if (providers !== undefined) {
    for (const [name, entry] of Object.entries(providers)) {
      pickAllowed(entry ?? {}, RELAY_ENTRY_KEYS, `relay provider ${JSON.stringify(name)}`);
    }
    return { providers: { ...providers } };
  }
  return { providers: { [providerName]: relayProviderEntry(single) } };
}

/**
 * 真上游 URL 该填进两套形状的哪个键——写反过一次，所以摊开成数据结构而不是靠注释。
 *
 * @param {string} baseUrl `createScriptedUpstream().listen()` 的返回值
 * @returns {{erixSlot: {endpoint: string}, relayProvider: {baseUrl: string}}}
 */
export function upstreamFields(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("upstreamFields 需要上游 baseUrl（先 await upstream.listen()）");
  }
  return { erixSlot: { endpoint: baseUrl }, relayProvider: { baseUrl } };
}

/**
 * 把要写的两份配置落进一个假 HOME。目录不存在会建出来（幂等）。
 *
 * @param {{
 *   dir: string,                                  // 假 HOME 根目录
 *   erix?: Parameters<typeof erixConfigShape>[0],  // 给则写 `<dir>/.erix/config.json`
 *   relay?: Parameters<typeof relayModelsShape>[0],// 给则写 `<dir>/.pi/agent/models.json`
 * }} options
 * @returns {{home:string, configPath:string|undefined, modelsJsonPath:string|undefined}}
 */
export function writeConfigHome(options) {
  const { dir, erix, relay } = options ?? {};
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new TypeError("writeConfigHome 需要 dir（假 HOME 根目录）");
  }
  mkdirSync(dir, { recursive: true });
  let configPath;
  let modelsJsonPath;
  if (erix !== undefined) {
    configPath = join(dir, ".erix", "config.json");
    mkdirSync(join(dir, ".erix"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(erixConfigShape(erix), null, 2)}\n`, "utf8");
  }
  if (relay !== undefined) {
    modelsJsonPath = join(dir, ".pi", "agent", "models.json");
    mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
    writeFileSync(modelsJsonPath, `${JSON.stringify(relayModelsShape(relay), null, 2)}\n`, "utf8");
  }
  return { home: dir, configPath, modelsJsonPath };
}

/**
 * 便捷入口：自建临时目录（走 `os.tmpdir()`，尊重 `TMPDIR`）+ 落两份配置。
 *
 * @param {Parameters<typeof writeConfigHome>[0] & { prefix?: string }} options
 * @returns {Promise<{home:string, configPath:string|undefined, modelsJsonPath:string|undefined}>}
 */
export async function createFakeConfigHome(options = {}) {
  const { prefix = "erix-config-home-", dir, ...rest } = options;
  const home = dir ?? await mkdtemp(join(tmpdir(), prefix));
  return writeConfigHome({ ...rest, dir: home });
}

/**
 * 假 HOME 的子进程/进程内环境补丁：设 `HOME`/`USERPROFILE`，并清掉会盖掉假配置的环境变量。
 * `XDG_CONFIG_HOME` 也在清理名单里——不清它就会去读宿主用户的真实配置。
 *
 * @param {NodeJS.ProcessEnv} [base] 基环境（默认 `process.env`）
 * @param {{home: string, extra?: Record<string,string|undefined>}} options
 * @returns {Record<string,string|undefined>} 新对象（不改动 base）
 */
export function fakeHomeEnv(base = process.env, { home, extra = {} } = {}) {
  if (typeof home !== "string" || home.trim() === "") {
    throw new TypeError("fakeHomeEnv 需要 home");
  }
  const env = { ...base };
  for (const name of MODEL_CONFIG_ENV_NAMES) delete env[name];
  env.HOME = home;
  env.USERPROFILE = home;
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
