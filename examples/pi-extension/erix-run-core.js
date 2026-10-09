// erix_run 的纯逻辑层：参数解析 / erix-agent 装载 / 配置装配 / runToolLoop 选项装配 /
// 终局载荷组装。
//
// 设计约束（examples/pi-extension/README.md 有面向用户的说明）：
//   - **不 import pi**：本文件必须能被 `node --test` 直接加载，因此 pi 的类型与
//     `defineTool` 只出现在 erix-run.ts 里；本文件只做「宿主侧」的装配工作。
//   - 所有外部依赖（lib 装载、provider 工厂、工具装配、runToolLoop、时钟）都可从
//     deps 注入，单测用 fake provider / fake lib 覆盖，不触网。
//   - 终止裁决一律读引擎给的 `termination`（docs/host-consumer-contract.md
//     「Termination decision table」/「Termination payload (#176/#180)」），本层不
//     自己发明 reason，也不把 abort 粉饰成正常返回。
//   - 观察者（onEvent 等）在 0.18 之后是安全的（抛错经 onObserverError 上报、不改
//     termination），本层仍接 onObserverError 并计数进 diagnostics。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** erix-agent 库入口（目录或文件）的环境变量。 */
export const LIB_ENV = "ERIX_AGENT_LIB";
/** 模型配置 JSON 文件路径的环境变量（缺省 XDG_CONFIG_HOME/erix/config.json → ~/.erix/config.json）。 */
export const CONFIG_PATH_ENV = "ERIX_CONFIG_PATH";
/** 单次 erix_run 的默认硬超时（10 分钟）。 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** 缺省内层轮数预算（与 erix runToolLoop 缺省一致）。 */
export const DEFAULT_MAX_ROUNDS = 8;
export const MAX_MAX_ROUNDS = 100;
/** provider 单次请求/流的超时（对齐 bin/cli.js 的 300s，非 run 级超时）。 */
export const PROVIDER_TIMEOUT_MS = 300_000;
/**
 * 可选压缩策略名（与引擎 `context.strategy` 的内置名字同一集合，
 * src/compact/strategy-resolution.js；引擎自己会在启动期再校验一次）。
 */
export const STRATEGY_NAMES = Object.freeze([
  "sliding-window",
  "fold-statistical",
  "fold-llm",
]);
/** 内置工具结果送回模型视野前的字符上限（head+tail，复用 bin/tools.js 的 truncateResult）。 */
export const TOOL_RESULT_LIMIT = 4_096;
/** diagnostics 里各类样本的保留条数。 */
const SAMPLE_LIMIT = 10;

/** 完成信号词表（对齐 bin/cli.js 的 completion.signals 默认值）。 */
const COMPLETION_SIGNALS = Object.freeze([
  "任务已完成",
  "已完成",
  "全部完成",
  "无需继续",
  "任务结束",
  "没有更多步骤",
]);

/**
 * 本层的错误类型：`code` 是宿主可读的失败类别，`stage` 标出装配的哪一步失败。
 * 抛错只用于「run 还没开始就没救」的装配期失败；run 起来之后的终局一律走载荷。
 */
export class ErixRunError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{stage?:string, detail?:string, cause?:unknown}} [extra]
   */
  constructor(code, message, { stage = "assembly", detail, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ErixRunError";
    this.code = code;
    this.stage = stage;
    if (detail !== undefined) this.detail = detail;
  }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value ?? "");
}

function positiveInt(value, fallback, { min, max, name }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ErixRunError("bad_params", `${name} 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
  if (parsed < min || parsed > max) {
    throw new ErixRunError(
      "bad_params",
      `${name} 必须在 ${min}..${max} 之间，收到 ${parsed}`,
    );
  }
  return parsed;
}

/** 展开 `~` 前缀，与 bin/tools.js 的工具路径口径一致。 */
export function expandUserPath(value, { home = homedir() } = {}) {
  const raw = String(value ?? "");
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.resolve(home, raw.slice(2));
  return raw;
}

/** 配置缺省路径（对齐 bin/config.js defaultConfigPath()）。 */
export function defaultConfigPath({ env = process.env, home = homedir() } = {}) {
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (typeof xdgConfigHome === "string" && xdgConfigHome.trim() !== "") {
    return path.join(xdgConfigHome, "erix", "config.json");
  }
  return path.join(home, ".erix", "config.json");
}

/**
 * 工具参数 → 归一化参数。抛 `ErixRunError("bad_params")`。
 *
 * @param {{task?:unknown, cwd?:unknown, maxRounds?:unknown, strategy?:unknown, timeoutMs?:unknown, model?:unknown}} raw
 * @param {{home?:string}} [options]
 * @returns {{task:string, cwd:string, maxRounds:number, strategy?:string, timeoutMs:number, model?:string}}
 */
export function parseRunParams(raw = {}, { home = homedir() } = {}) {
  const task = textOf(raw?.task).trim();
  if (task === "") {
    throw new ErixRunError("bad_params", "task 必填且不能是空字符串");
  }

  const rawCwd = textOf(raw?.cwd).trim();
  if (rawCwd === "") {
    throw new ErixRunError("bad_params", "cwd 必填（绝对路径）");
  }
  const cwd = expandUserPath(rawCwd, { home });
  if (!path.isAbsolute(cwd)) {
    throw new ErixRunError(
      "bad_params",
      `cwd 必须是绝对路径，收到 ${JSON.stringify(rawCwd)}（相对路径会随 pi 的工作目录漂移）`,
    );
  }
  if (!existsSync(cwd)) {
    throw new ErixRunError("bad_cwd", `cwd 不存在：${cwd}`);
  }

  /** @type {Record<string, unknown>} */
  const params = {
    task,
    cwd,
    maxRounds: positiveInt(raw?.maxRounds, DEFAULT_MAX_ROUNDS, {
      min: 1, max: MAX_MAX_ROUNDS, name: "maxRounds",
    }),
    timeoutMs: positiveInt(raw?.timeoutMs, DEFAULT_TIMEOUT_MS, {
      min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS, name: "timeoutMs",
    }),
  };

  const strategy = raw?.strategy;
  if (strategy !== undefined && strategy !== null && strategy !== "") {
    const name = textOf(strategy).trim();
    if (!STRATEGY_NAMES.includes(name)) {
      throw new ErixRunError(
        "bad_params",
        `strategy 只能是 ${STRATEGY_NAMES.join(" | ")}，收到 ${JSON.stringify(strategy)}`,
      );
    }
    params.strategy = name;
  }

  const model = raw?.model;
  if (model !== undefined && model !== null && model !== "") {
    const name = textOf(model).trim();
    if (name === "") {
      throw new ErixRunError("bad_params", "model 传了值就不能是空白字符串");
    }
    params.model = name;
  }

  return /** @type {any} */ (params);
}

/**
 * 解析 erix-agent 的入口候选（不做 import，便于单测断言回退顺序）。
 *
 * 1. `ERIX_AGENT_LIB`：目录（自动补 src/index.js）或直接指向入口文件；
 * 2. 裸包名 `erix-agent`（发版后可用）。
 *
 * @param {{env?:NodeJS.ProcessEnv, exists?:(p:string)=>boolean, home?:string}} [options]
 * @returns {{entries:{libEntry:string, libRoot:string, source:string}[], tried:string[]}}
 */
export function resolveLibCandidates({
  env = process.env,
  exists = existsSync,
  home = homedir(),
} = {}) {
  const tried = [];
  const entries = [];
  const envValue = textOf(env[LIB_ENV]).trim();
  if (envValue !== "") {
    const target = path.resolve(expandUserPath(envValue, { home }));
    const candidates = target.endsWith(".js")
      ? [target]
      : [path.join(target, "src", "index.js"), target];
    const hit = candidates.find((candidate) => exists(candidate));
    tried.push(target);
    if (hit !== undefined) {
      // 入口在 <root>/src/index.js 时 root 取其父目录；直接指到别处时 root 就取文件所在目录。
      const parent = path.dirname(hit);
      const libRoot = path.basename(parent) === "src" ? path.dirname(parent) : parent;
      entries.push({ libEntry: hit, libRoot, source: `${LIB_ENV}=${envValue}` });
    }
  }
  tried.push("erix-agent");
  // 裸包名要由 import() 自己解析，root 只能解析完才知道，这里先占位。
  entries.push({ libEntry: "erix-agent", libRoot: undefined, source: "import(\"erix-agent\")" });
  return { entries, tried };
}

/** 从已解析的入口模块（file: URL 或绝对路径）反推包根目录。 */
export function packageRootFromEntry(moduleUrl) {
  if (typeof moduleUrl !== "string" || moduleUrl === "") return undefined;
  let entryFile;
  try {
    entryFile = moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : path.resolve(moduleUrl);
  } catch {
    return undefined;
  }
  const parent = path.dirname(entryFile);
  return path.basename(parent) === "src" ? path.dirname(parent) : parent;
}

/**
 * 装载 erix-agent（runToolLoop / provider 工厂 / 配置提供者 / 内存 store）
 * 与 bin/tools.js 的内置工具装配。
 *
 * 都失败时抛 `ErixRunError("lib_missing")`——调用方（pi 工具）把它转成可读的
 * 工具错误，绝不让 pi 崩。
 *
 * @param {{
 *   env?:NodeJS.ProcessEnv,
 *   importModule?:(specifier:string)=>Promise<any>,
 *   resolve?:(specifier:string)=>string,
 *   exists?:(p:string)=>boolean,
 *   home?:string,
 * }} [options]
 * @returns {Promise<{
 *   index: any, binTools: any, libEntry: string, libRoot: string,
 *   binToolsEntry: string, source: string,
 * }>}
 */
export async function loadErixAgent({
  env = process.env,
  importModule = (specifier) => import(specifier),
  resolve = (specifier) => import.meta.resolve(specifier),
  exists = existsSync,
  home = homedir(),
} = {}) {
  const { entries, tried } = resolveLibCandidates({ env, exists, home });
  const failures = [];

  for (const candidate of entries) {
    let index;
    try {
      const specifier = candidate.libEntry === "erix-agent"
        ? candidate.libEntry
        : pathToFileURL(candidate.libEntry).href;
      index = await importModule(specifier);
    } catch (error) {
      failures.push(`${candidate.source}: ${textOf(error)}`);
      continue;
    }
    const missing = ["runToolLoop", "createOpenAIProvider", "createJsonFileModelConfigProvider",
      "createMemoryTranscriptStore", "resolveApiKey"]
      .filter((name) => typeof index?.[name] !== "function");
    if (missing.length > 0) {
      failures.push(`${candidate.source}: 入口缺少导出 ${missing.join(", ")}`);
      continue;
    }

    // 裸包名走 exports 白名单（`.` → src/index.js）；bin/tools.js 不在白名单里，
    // 只能先用 import.meta.resolve 反推包根，再按 file: URL 直接 import 那个文件。
    const libRoot = candidate.libRoot ?? (() => {
      try {
        return packageRootFromEntry(resolve("erix-agent"));
      } catch {
        return undefined;
      }
    })();
    const binToolsEntry = libRoot === undefined
      ? undefined
      : path.join(libRoot, "bin", "tools.js");
    let binTools;
    if (binToolsEntry !== undefined && exists(binToolsEntry)) {
      try {
        binTools = await importModule(pathToFileURL(binToolsEntry).href);
      } catch (error) {
        failures.push(`${binToolsEntry}: ${textOf(error)}`);
        continue;
      }
    } else {
      // 内置工具装配是硬依赖（没有它内层 run 就没工具可用）。
      failures.push(`${binToolsEntry ?? "包根目录未解析"}: 找不到内置工具装配（bin/tools.js）`);
      continue;
    }
    if (typeof binTools?.createCliTools !== "function") {
      failures.push(`${binToolsEntry}: bin/tools.js 未导出 createCliTools`);
      continue;
    }

    return {
      index,
      binTools,
      libEntry: candidate.libEntry,
      libRoot,
      binToolsEntry,
      source: candidate.source,
    };
  }

  throw new ErixRunError(
    "lib_missing",
    `找不到 erix-agent 库。已尝试：${tried.join(" / ")}。`
    + `失败明细：${failures.join(" ;; ")}。`
    + `请设 ${LIB_ENV}=<erix-agent 检出目录或 src/index.js 路径>（发版后 npm i -g erix-agent 即可省略）`,
    { detail: failures.join(" ;; "), cause: undefined },
  );
}

/**
 * 读 `~/.erix/config.json` 的 `slots.default`（库自带 createJsonFileModelConfigProvider 负责
 * 槽位选取 + apiKey/apiKeyEnv/apiKeyFile 落值），支持 `model` 参数覆盖槽位里的模型名。
 *
 * @param {{
 *   lib: any,
 *   configPath?:string,
 *   modelOverride?:string,
 *   env?:NodeJS.ProcessEnv,
 *   home?:string,
 * }} input
 * @returns {Promise<{slot:object, configPath:string, metadataMissing?:{detail:string, missingFields:string[]}}>}
 */
export async function loadModelSlot({
  lib,
  configPath,
  modelOverride,
  env = process.env,
  home = homedir(),
}) {
  const resolvedPath = configPath === undefined || configPath === ""
    ? defaultConfigPath({ env, home })
    : expandUserPath(configPath, { home });

  if (!existsSync(resolvedPath)) {
    throw new ErixRunError(
      "config_missing",
      `模型配置不存在：${resolvedPath}（需要 slots.default 提供 endpoint/model/apiKey；`
      + `可用 ${CONFIG_PATH_ENV} 指定别的路径）`,
      { detail: resolvedPath },
    );
  }

  const providerFactory = lib?.createJsonFileModelConfigProvider;
  if (typeof providerFactory !== "function") {
    throw new ErixRunError("lib_missing", "erix-agent 入口未导出 createJsonFileModelConfigProvider");
  }

  let slot;
  try {
    slot = await providerFactory({ path: resolvedPath }).resolve("default");
  } catch (error) {
    throw new ErixRunError(
      "config_invalid",
      `模型配置解析失败（${resolvedPath}）：${textOf(error)}`,
      { detail: resolvedPath, cause: error },
    );
  }
  if (slot === null || typeof slot !== "object" || Array.isArray(slot)) {
    throw new ErixRunError(
      "config_invalid",
      `模型配置 slots.default 必须是对象（${resolvedPath}）`,
      { detail: resolvedPath },
    );
  }

  const resolved = { ...slot };
  if (modelOverride !== undefined) resolved.model = modelOverride;

  const missing = [];
  if (typeof resolved.endpoint !== "string" || resolved.endpoint.trim() === "") {
    missing.push("endpoint");
  }
  if (typeof resolved.model !== "string" || resolved.model.trim() === "") {
    missing.push("model");
  }
  if (typeof resolved.apiKey !== "string" || resolved.apiKey.trim() === "") {
    missing.push("apiKey|apiKeyEnv|apiKeyFile");
  }
  if (missing.length > 0) {
    throw new ErixRunError(
      "config_invalid",
      `模型配置 slots.default 缺少必填字段 ${missing.join(", ")}（${resolvedPath}）`,
      { detail: `${resolvedPath}: ${missing.join(", ")}` },
    );
  }

  const budgetFields = ["contextWindowTokens", "maxOutputTokens"];
  const missingFields = budgetFields.filter((field) => !Number.isSafeInteger(resolved[field]));
  const metadataMissing = missingFields.length === budgetFields.length
    ? {
      // 与引擎 model_metadata_missing 事件同口径：缺元数据 = 压缩与聚合输出预算整轮关闭。
      detail: `slots.default 缺少 ${missingFields.join("/")};`
        + " compaction and aggregate output budget are disabled for this run",
      missingFields,
      source: "config",
    }
    : undefined;

  return { slot: resolved, configPath: resolvedPath, metadataMissing };
}

/** provider 构造：relay 是 OpenAI 协议，直接用 createOpenAIProvider（src/providers/openai.js 的具名参数）。 */
export function createProviderForSlot(lib, slot, { timeoutMs = PROVIDER_TIMEOUT_MS } = {}) {
  // 槽位整体摊平进去：内置 provider 读固定参数清单，未知字段惰性（契约
  // 「Unknown slot fields are inert and safe」），顺带把 contextWindowTokens /
  // maxOutputTokens 重新暴露到 provider 对象上（元数据探测第 4 顺位）。
  return lib.createOpenAIProvider({
    ...slot,
    endpoint: slot.endpoint,
    apiKey: slot.apiKey,
    model: slot.model,
    maxTokens: slot.maxTokens ?? slot.maxOutputTokens,
    timeoutMs,
  });
}

/**
 * 内层工具集：复用 bin/tools.js 的同一装配函数 `createCliTools`
 * （readFile/rg/grep/tree/writeFile/exec，todo 四件套默认关，见 README）。
 *
 * @param {{
 *   lib: any,
 *   cwd: string,
 *   todo?: boolean,
 *   resultLimit?: number,
 *   onToolEvent?: (info:{phase:string, name:string, input?:object, chars?:number, isError?:boolean}) => void,
 * }} input
 * @returns {{tools:object[], executeTool:(options:object)=>Promise<string>}}
 */
export function createInnerTools({
  lib,
  cwd,
  todo = false,
  resultLimit = TOOL_RESULT_LIMIT,
  onToolEvent,
}) {
  const cliTools = lib.binTools.createCliTools({ cwd, todo });
  const truncate = typeof lib.binTools.truncateResult === "function"
    ? (text) => lib.binTools.truncateResult(text)
    : (text) => text;

  async function executeTool(execution = {}) {
    const name = typeof execution === "object" ? execution.name : execution;
    const input = typeof execution === "object" ? execution.input : undefined;
    onToolEvent?.({ phase: "start", name, input });
    try {
      // bin/tools.js 的 executor 只吃 input（context/signal 不参与执行，exec 自带
      // ERIX_EXEC_TIMEOUT_MS 超时），所以这里只做结果截断与进度留痕。
      const raw = await cliTools.executeTool(name, input, {
        ...(execution.context ?? {}),
        toolUseId: execution.id,
        signal: execution.signal,
      });
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      const clipped = text.length > resultLimit ? truncate(text) : text;
      onToolEvent?.({ phase: "end", name, chars: text.length, isError: /^\s*错误[：:]/u.test(text) });
      return clipped;
    } catch (error) {
      onToolEvent?.({ phase: "error", name, isError: true });
      throw error;
    }
  }

  return { tools: cliTools.tools, executeTool, cliTools };
}

/** 内层 system prompt：复用 bin/tools.js 的工具提示词装配（与 CLI 同一口径）。 */
export function buildSystemPrompt({ lib, cwd, todo = false }) {
  const base = typeof lib.binTools.buildCliToolsSystemPrompt === "function"
    ? lib.binTools.buildCliToolsSystemPrompt({ todo })
    : "可用工具：readFile/rg/grep/tree/writeFile/exec。";
  return `你是被 pi 调度的 erix 编码助手，工作目录 ${cwd}。${base}`
    + "\n\n交付规则：直接在工作目录里改文件（writeFile/readFile/exec），"
    + "收尾只写简短摘要——改了什么、为什么、如何验证；不要粘贴大段代码或文件全文。"
    + "\n\n任务完成时首行写「任务已完成」，再接摘要。"
    + "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";
}

function preview(value, limit = 120) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 引擎事件 → 一行人类可读进度（onEvent 的 type 取自 src/loop/orchestrator.js 的 emitEvent：
 * round_start / tool_use / tool_result / compaction / model_metadata_missing / run_outcome …）。
 *
 * @param {object} event
 * @returns {string|undefined}
 */
export function formatLoopEvent(event) {
  if (event === null || typeof event !== "object") return undefined;
  switch (event.type) {
    case "round_start":
      return `round ${event.round} 开始`;
    case "tool_use":
      return `→ ${event.toolUse?.name ?? "?"} ${preview(event.toolUse?.input)}`;
    case "tool_result": {
      const content = typeof event.toolResult?.content === "string" ? event.toolResult.content : "";
      const flag = event.toolResult?.is_error === true ? " [error]" : "";
      const dur = Number.isFinite(event.toolResult?.duration) ? ` ${event.toolResult.duration}ms` : "";
      return `← ${preview(content, 160) || "(空结果)"}${dur}${flag}`;
    }
    case "round_end":
      return `round ${event.round} 结束（stop=${event.stopReason ?? "?"}，`
        + `↑${event.usage?.input_tokens ?? 0}/↓${event.usage?.output_tokens ?? 0}）`;
    case "compaction":
      // 事件载荷是 createCompactionStat 的形状（compacted/foldedRounds/tokensBefore/tokensAfter/layers）
      return `压缩：round ${event.round}，折叠 ${event.compaction?.foldedRounds ?? 0} 轮，`
        + `tokens ${event.compaction?.tokensBefore ?? "?"}→${event.compaction?.tokensAfter ?? "?"}`;
    case "model_metadata_missing":
      return `⚠ model_metadata_missing：${preview(event.detail, 200)}`;
    case "final_guard":
      return `final_guard：${event.action ?? "?"}${event.reason ? `（${event.reason}）` : ""}`;
    case "persistence_error":
      return `⚠ 持久化错误：${preview(event?.error?.message ?? event?.message ?? "")}`;
    case "recovering":
      return `重试中（attempt ${event.attempt ?? "?"}）：${preview(event?.error?.message ?? "")}`;
    case "run_outcome":
      return `终局：${event.termination?.reason ?? "?"}`;
    default:
      return undefined;
  }
}

/**
 * runToolLoop 选项装配（#182：预算元数据只走 modelMetadata 单一载体；
 * #167：strategy 用内置名字，由引擎在启动期实例化）。
 *
 * @param {{
 *   params: {task:string, cwd:string, maxRounds:number, timeoutMs:number, strategy?:string},
 *   slot: object,
 *   provider: object,
 *   tools: {tools:object[], executeTool:Function},
 *   store: object,
 *   signal: AbortSignal,
 *   runId: string,
 *   system?: string,
 *   onEvent?: (event:object)=>void,
 *   onObserverError?: (error:Error, context:object)=>void,
 *   onPersistenceError?: (error:Error)=>void,
 *   onProgress?: (line:string)=>void,
 *   diagnostics?: {error:(event:object)=>void},
 *   reflection?: object|false,
 * }} input
 * @returns {object} runToolLoop 的 options 对象
 */
export function buildLoopOptions(input) {
  const {
    params, slot, provider, tools, store, signal, runId,
    system, onEvent, onObserverError, onPersistenceError, diagnostics,
    reflection,
  } = input;

  /** @type {Record<string, unknown>} */
  const options = {
    provider,
    system: system ?? buildSystemPrompt({ lib: { binTools: {} }, cwd: params.cwd }),
    initialUserMessage: params.task,
    // 契约「#1.3 硬注意」/task 选项：判官/收尾的简报取显式 task，多轮宿主必须显式传。
    task: params.task,
    tools: tools.tools,
    executeTool: tools.executeTool,
    maxRounds: params.maxRounds,
    // run 级截止线（引擎在轮边界上按剩余时间收尾）；硬 abort 由 runErixRun 的定时器负责。
    timeoutMs: params.timeoutMs,
    stream: false,
    signal,
    runId,
    store,
    // 对话型宿主（pi 是人机协同侧）：收尾 JSON 信封会污染交回给 pi 的终稿文本，关掉。
    wrapup: false,
    retry: { attempts: 2 },
    completion: { signals: [...COMPLETION_SIGNALS], maxNoToolRounds: 3 },
    ...(reflection === undefined ? {} : { reflection }),
    ...(params.strategy === undefined ? {} : { context: { strategy: params.strategy } }),
    ...(onEvent === undefined ? {} : { onEvent }),
    ...(onObserverError === undefined ? {} : { onObserverError }),
    ...(onPersistenceError === undefined ? {} : { onPersistenceError }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };

  // #182：两个预算字段必须成对给（引擎跨候选不合并），缺任何一个都不如不给。
  if (Number.isSafeInteger(slot.contextWindowTokens) && Number.isSafeInteger(slot.maxOutputTokens)) {
    options.modelMetadata = {
      contextWindowTokens: slot.contextWindowTokens,
      maxOutputTokens: slot.maxOutputTokens,
    };
  }

  return options;
}

/** 引擎 usage（{input_tokens,output_tokens,cacheRead,cacheWrite}）→ pi 的 Usage 形状。 */
export function toPiUsage(usage) {
  if (usage === null || typeof usage !== "object") return undefined;
  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  // 装配期就失败（模型一次都没跑）时不报零用量：AgentToolResult.usage 的语义是「确有发生」。
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    // 成本由 relay 侧记账，库不报单价：这里给 0，别把它当真实价格。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function zeroUsage() {
  return { input_tokens: 0, output_tokens: 0 };
}

function sampleList(items) {
  return {
    count: items.length,
    samples: items.slice(0, SAMPLE_LIMIT).map((item) => ({
      channel: item.channel ?? "unknown",
      message: preview(item.message ?? "", 200),
      ...(item.type === undefined ? {} : { type: item.type }),
      ...(item.round === undefined ? {} : { round: item.round }),
    })),
  };
}

/**
 * 正常返回 → 结构化载荷。
 *
 * @param {any} result runToolLoop 的返回值
 * @param {{timeout:boolean, aborted:boolean, observerErrors:any[], metadataEvents:any[],
 *   ledgerErrors:any[], context:object}} input
 */
export function buildSuccessPayload(result, input) {
  const termination = result?.termination ?? { reason: "failed", detail: "engine returned no termination" };
  return {
    // 采纳判据（契约 Termination decision table）：end_turn/judge_done 才是「可以当答案用」；
    // no_tool/stall/max_rounds_cap/… 都是要宿主再决策的终局，不粉饰成成功。
    ok: termination.reason === "end_turn" || termination.reason === "judge_done",
    finalText: typeof result?.finalText === "string" ? result.finalText : "",
    rounds: Number.isFinite(result?.rounds) ? result.rounds : 0,
    truncated: result?.truncated === true,
    usage: result?.usage ?? zeroUsage(),
    termination: { ...termination },
    verification: result?.verification ?? undefined,
    timeout: input.timeout === true,
    aborted: input.aborted === true,
    diagnostics: buildDiagnostics(input, result),
  };
}

/**
 * 抛错路径 → 结构化载荷。#180：终局抛错一定带 error.usage/rounds/finalText（零值而非缺字段），
 * 中止还带 termination.usage/rounds/partial，这里一律读出来，绝不把最贵的 run 记成 0。
 */
export function buildErrorPayload(error, input) {
  const terminationFromError = error?.termination;
  const aborted = input.aborted === true || terminationFromError?.reason === "aborted";
  const termination = terminationFromError !== null && typeof terminationFromError === "object"
    ? { ...terminationFromError }
    : {
      reason: aborted ? "aborted" : "failed",
      detail: textOf(error?.message ?? error),
      ...(aborted ? {} : { errorCode: typeof error?.code === "string" ? error.code : "unknown" }),
    };
  const usage = error?.usage ?? terminationFromError?.usage ?? zeroUsage();

  return {
    ok: false,
    finalText: typeof error?.finalText === "string"
      ? error.finalText
      : (typeof terminationFromError?.partial === "string" ? terminationFromError.partial : ""),
    rounds: Number.isFinite(error?.rounds) ? error.rounds : (terminationFromError?.rounds ?? 0),
    truncated: false,
    usage,
    termination: { ...termination, ...(aborted ? { partial: true } : {}) },
    verification: error?.verification,
    timeout: input.timeout === true,
    aborted,
    error: {
      name: error?.name ?? "Error",
      message: textOf(error?.message ?? error),
      code: typeof error?.code === "string" ? error.code : undefined,
      stage: typeof error?.stage === "string" ? error.stage : undefined,
    },
    diagnostics: buildDiagnostics(input, error),
  };
}

function buildDiagnostics(input, source) {
  const { context, observerErrors = [], metadataEvents = [], ledgerErrors = [] } = input;
  const compactionStats = Array.isArray(source?.compactionStats) ? source.compactionStats : [];
  /** @type {Record<string, unknown>} */
  const diagnostics = {
    observerErrors: sampleList(observerErrors),
    modelMetadataMissing: metadataEvents.length > 0
      // 引擎每轮最多一条；这里保留 detail 供宿主自查装配（契约「Assembly self-check assertion」）。
      ? { count: metadataEvents.length, detail: preview(metadataEvents[0]?.detail, 300) }
      : (context.metadataMissing ?? null),
    ledgerErrors: sampleList(ledgerErrors),
    persistenceErrors: sampleList(input.persistenceErrors ?? []),
    compaction: {
      events: compactionStats.length,
      compactedRounds: compactionStats.filter((stat) => stat?.compacted === true).length,
      foldedRounds: compactionStats.reduce(
        (total, stat) => total + (Number.isFinite(stat?.foldedRounds) ? stat.foldedRounds : 0),
        0,
      ),
    },
    model: context.model,
    configPath: context.configPath,
    cwd: context.cwd,
    libSource: context.libSource,
    strategy: context.strategy,
    runId: context.runId,
    maxRounds: context.maxRounds,
    timeoutMs: context.timeoutMs,
    elapsedMs: context.elapsedMs,
  };
  if (typeof source?.termination?.errorCode === "string") {
    diagnostics.errorCode = source.termination.errorCode;
  }
  return diagnostics;
}

function newRunId(now) {
  return `erix-run-${new Date(now()).toISOString().replaceAll(":", "-")}-${randomBytes(3).toString("hex")}`;
}

/**
 * 一次完整的 erix_run：装配 → runToolLoop → 结构化载荷。**不抛**（装配期失败也转成
 * 载荷里的 ok:false + error.code），因此 pi 工具永远拿得到一个可解释的结果。
 *
 * @param {object} rawParams 工具入参
 * @param {{
 *   env?:NodeJS.ProcessEnv, home?:string,
 *   signal?:AbortSignal, onProgress?:(line:string)=>void,
 *   configPath?:string,
 *   loadLib?:()=>Promise<any>, loadSlot?:(input:{lib:object})=>Promise<any>,
 *   createProvider?:(lib:object,slot:object)=>object,
 *   createAssembly?:(input:{lib:object, cwd:string, onToolEvent:Function})=>any,
 *   createStore?:()=>object,
 *   runLoop?:(options:object)=>Promise<any>,
 *   now?:()=>number,
 * }} [deps]
 */
export async function runErixRun(rawParams = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const onProgress = deps.onProgress;

  const observerErrors = [];
  const metadataEvents = [];
  const ledgerErrors = [];
  const persistenceErrors = [];
  /** @type {{model?:string, configPath?:string, cwd?:string, libSource?:string, strategy?:string, runId?:string, maxRounds?:number, timeoutMs?:number, elapsedMs?:number, metadataMissing?:object}} */
  const context = { cwd: textOf(rawParams?.cwd), strategy: textOf(rawParams?.strategy) || undefined };

  const recordObserverError = (error, info = {}) => {
    observerErrors.push({
      channel: info?.channel, type: info?.type, round: info?.round,
      message: textOf(error?.message ?? error),
    });
  };
  // 进度通道就是 pi 的 onUpdate：它抛错只能算「宿主观察者错了」，绝不能反过来打断内层 run。
  const progress = (line) => {
    if (onProgress === undefined) return;
    try {
      onProgress(line);
    } catch (progressError) {
      recordObserverError(progressError, { channel: "onProgress" });
    }
  };

  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const relayCancel = () => {
    cancelled = true;
    controller.abort(new Error("erix_run 被调用方取消"));
  };
  const userSignal = deps.signal;
  if (userSignal !== undefined && userSignal !== null) {
    if (userSignal.aborted) relayCancel();
    else userSignal.addEventListener("abort", relayCancel, { once: true });
  }
  let timer;

  try {
    const params = parseRunParams(rawParams, { home });
    context.cwd = params.cwd;
    context.strategy = params.strategy;
    context.maxRounds = params.maxRounds;
    context.timeoutMs = params.timeoutMs;

    const lib = deps.loadLib
      ? await deps.loadLib()
      : await loadErixAgent({ env, home });
    const libIndex = lib?.index ?? lib;
    context.libSource = lib.source ?? lib.libEntry;

    const slotResult = deps.loadSlot
      ? await deps.loadSlot({ lib: libIndex })
      : await loadModelSlot({
        lib: libIndex,
        configPath: deps.configPath ?? env[CONFIG_PATH_ENV],
        modelOverride: params.model,
        env,
        home,
      });
    const slot = slotResult?.slot ?? slotResult;
    context.model = slot?.model;
    context.configPath = slotResult?.configPath;
    if (slotResult?.metadataMissing !== undefined) {
      context.metadataMissing = slotResult.metadataMissing;
    }

    const provider = deps.createProvider
      ? deps.createProvider(libIndex, slot)
      : createProviderForSlot(libIndex, slot);
    const tools = deps.createAssembly
      ? deps.createAssembly({ lib: libIndex, cwd: params.cwd, onToolEvent: (info) => {
        if (info?.phase === "start") progress(`→ ${info.name} ${preview(info.input)}`);
      } })
      : createInnerTools({ lib, cwd: params.cwd });
    // 工具调用的进度不从这里发：引擎的 tool_use / tool_result 事件已覆盖同一事件，
    // 两处都报会在 pi 的进度窗口里出现重复行。
    const store = deps.createStore
      ? deps.createStore()
      : libIndex.createMemoryTranscriptStore();

    const runId = newRunId(now);
    context.runId = runId;
    progress(
      `erix_run 启动：model=${context.model ?? "?"} cwd=${params.cwd} maxRounds=${params.maxRounds}`
      + ` strategy=${params.strategy ?? "（未配置，走引擎缺省）"} timeoutMs=${params.timeoutMs}`
      + `（lib: ${context.libSource}）`,
    );

    timer = setTimeout(() => {
      timedOut = true;
      progress(`⏱ 超时 ${params.timeoutMs}ms，abort 内层 run`);
      controller.abort(new Error(`erix_run 超时（${params.timeoutMs}ms）`));
    }, params.timeoutMs);

    const runLoop = deps.runLoop ?? libIndex.runToolLoop;
    const options = buildLoopOptions({
      params,
      slot,
      provider,
      tools,
      store,
      signal: controller.signal,
      runId,
      system: lib.binTools === undefined
        ? undefined
        : buildSystemPrompt({ lib, cwd: params.cwd }),
      // 观察者必须自带防护：0.18 起引擎会隔离抛错并经 onObserverError 报告，但进度通道
      // （pi 的 onUpdate）在引擎直调路径上仍可能同步抛错。
      onEvent: (event) => {
        try {
          if (event?.type === "model_metadata_missing") {
            metadataEvents.push({ detail: event.detail });
          }
          const line = formatLoopEvent(event);
          if (line !== undefined) progress(line);
        } catch (observerError) {
          recordObserverError(observerError, { channel: "onEvent", type: event?.type });
        }
      },
      onObserverError: recordObserverError,
      onPersistenceError: (error) => {
        persistenceErrors.push({ channel: "onPersistenceError", message: textOf(error?.message ?? error) });
        progress(`⚠ 持久化错误：${preview(error?.message ?? error)}`);
      },
      diagnostics: {
        error: (event) => {
          ledgerErrors.push({
            channel: "diagnostics.error",
            type: event?.type ?? event?.code,
            message: textOf(event?.message ?? event?.error?.message ?? event),
          });
        },
      },
      reflection: env.ERIX_NO_REFLECTION?.trim() === "1"
        ? false
        : (params.maxRounds >= 16 ? { enabled: true } : false),
    });

    const result = await runLoop(options);
    context.elapsedMs = now() - startedAt;
    const payload = buildSuccessPayload(result, {
      timeout: timedOut,
      aborted: cancelled,
      observerErrors,
      metadataEvents,
      ledgerErrors,
      persistenceErrors,
      context,
    });
    progress(
      `erix_run 结束：termination=${payload.termination.reason}`
      + ` rounds=${payload.rounds} ↑${payload.usage?.input_tokens ?? 0}/↓${payload.usage?.output_tokens ?? 0}`,
    );
    return payload;
  } catch (error) {
    context.elapsedMs = now() - startedAt;
    const payload = buildErrorPayload(error, {
      timeout: timedOut,
      aborted: cancelled || controller.signal.aborted,
      observerErrors,
      metadataEvents,
      ledgerErrors,
      persistenceErrors,
      context,
    });
    progress(
      `erix_run 终局（抛错路径）：${payload.termination.reason}`
      + ` code=${payload.error?.code ?? "?"} timeout=${payload.timeout}`
      + ` usage=↑${payload.usage?.input_tokens ?? 0}/↓${payload.usage?.output_tokens ?? 0}`,
    );
    return payload;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (userSignal !== undefined && userSignal !== null) {
      userSignal.removeEventListener?.("abort", relayCancel);
    }
  }
}

/**
 * 载荷 → 交回给 pi 模型的文本。终稿在前，机器可读摘要在后（终稿可能被截断，
 * 完整结构在 structuredContent/details 里）。
 */
export function formatPayloadForModel(payload, { limit = 20_000 } = {}) {
  const finalText = typeof payload?.finalText === "string" ? payload.finalText : "";
  const clipped = finalText.length > limit
    ? `${finalText.slice(0, limit)}\n…[终稿截断，共 ${finalText.length} 字符]`
    : finalText;
  const usage = payload?.usage ?? {};
  const lines = [
    clipped === "" ? "(内层 run 没有产出终稿文本)" : clipped,
    "",
    `[erix_run] termination=${payload?.termination?.reason ?? "?"}`
      + `${payload?.termination?.errorCode ? ` errorCode=${payload.termination.errorCode}` : ""}`
      + ` rounds=${payload?.rounds ?? 0} truncated=${payload?.truncated === true}`
      + ` timeout=${payload?.timeout === true} aborted=${payload?.aborted === true}`
      + ` verification=${payload?.verification?.status ?? "n/a"}`
      + ` usage=↑${usage.input_tokens ?? 0}/↓${usage.output_tokens ?? 0}`
      + ` cacheR=${usage.cacheRead ?? 0}/cacheW=${usage.cacheWrite ?? 0}`,
  ];
  const diagnostics = payload?.diagnostics;
  if (diagnostics) {
    lines.push(`[diagnostics] model=${diagnostics.model ?? "?"}`
      + ` strategy=${diagnostics.strategy ?? "engine default"}`
      + ` compaction=${diagnostics.compaction?.compactedRounds ?? 0}/${diagnostics.compaction?.events ?? 0}`
      + ` observerErrors=${diagnostics.observerErrors?.count ?? 0}`
      + ` persistenceErrors=${diagnostics.persistenceErrors?.count ?? 0}`
      + ` model_metadata_missing=${diagnostics.modelMetadataMissing ? "YES" : "no"}`);
    if (diagnostics.modelMetadataMissing?.detail) {
      lines.push(`  ↳ ${diagnostics.modelMetadataMissing.detail}`);
    }
  }
  if (payload?.error?.message) {
    lines.push(`[error] ${payload.error.code ?? payload.error.name ?? "Error"}: ${payload.error.message}`);
  }
  return lines.join("\n");
}
