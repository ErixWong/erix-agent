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

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

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
/**
 * 落盘（issue #207 R3）：`transcript` 参数的两个同义写法与「不落盘」别名。
 * 缺省（两个参数都不传）= 纯内存，与 0.18 及之前的行为逐字一致。
 */
export const TRANSCRIPT_ALIAS_FILE = "file";
export const TRANSCRIPT_ALIASES_MEMORY = Object.freeze(["memory", "none", "off"]);
/** `transcript:"file"` 且没给目录时的缺省落点：`<home>/.erix/transcripts`（AGENTS.md §6 的本地布局）。 */
export const DEFAULT_SESSION_DIR_SEGMENTS = Object.freeze([".erix", "transcripts"]);
/**
 * 引擎侧 `reflection.maxExtensions` 的缺省值（`src/loop/orchestrator.js` 的
 * `reflectionMaxExtensions` 在字段缺失/非法时回落 2）。本层**不把它当默认值下发**
 * （下发就改了引擎默认），只在返回面里如实报「本次生效的扩轮上限」时引用。
 */
export const ENGINE_DEFAULT_MAX_EXTENSIONS = 2;
/** #207 R1：三个扩轮参数的入参校验上界（下界见 parseRunParams：maxExtensions 允许 0）。 */
export const MAX_MAX_EXTENSIONS = 1_000;
export const MAX_MAX_ROUNDS_CAP = 100_000;
export const MAX_EXTENSION_STEP = 10_000;
/** #207 R1：下发给引擎 `reflection:{…}` 的扩轮参数名单（也是 diagnostics 里 `requested` 的键）。 */
export const EXTENSION_PARAM_NAMES = Object.freeze(["maxExtensions", "maxRoundsCap", "extensionStep"]);
/**
 * 本层能不能续跑（#207 R4）。**只有 R2（`resume` 通道，另单）落地后才能翻成 true**；
 * 在 R2 之前声称可续跑就是假事实，所以这里是一个具名常量而不是一处字面量。
 */
export const RESUMABLE = false;
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

/**
 * 扩轮参数的整数校验（#207 R1）。非法值一律 `bad_params`（不抖给调用方：
 * `runErixRun` 会把 `ErixRunError` 归一成 `ok:false` 的终局载荷）。
 *
 * `zeroAllowed` 只影响文案，不影响判定（判定靠 `min`）：`maxExtensions` 的下界是 0，
 * **不能改用上面的 `positiveInt`**——引擎对它是 `>= 0` 判断（`src/loop/orchestrator.js` 的
 * `reflectionMaxExtensions`），`0` = 「关掉扩轮」是一个有效配置，不是「没传」。
 */
function intParam(value, { min, max, name, zeroAllowed = false }) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new ErixRunError(
      "bad_params",
      `${name} 必须是 ≥ ${min} 的整数`
      + (zeroAllowed ? "（0 是有效值，意思是「关掉扩轮」）" : "")
      + `，收到 ${JSON.stringify(value)}`,
    );
  }
  if (parsed > max) {
    throw new ErixRunError("bad_params", `${name} 不能超过 ${max}，收到 ${parsed}`);
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

/** 引擎 safeRunId 的保留前缀（见 src/store/file.js）。 */
const HASHED_RUN_ID_PREFIX = "run-h-";

/**
 * transcript 文件名的安全化形式——**与引擎 `src/store/file.js` 的 `safeRunId()` 逐字同式**。
 *
 * 为什么要照抄而不是拿：那个符号没从包根 `src/index.js` 导出（包根只导出
 * `createFileTranscriptStore`），而本层的零依赖红线只允许「`node:` 内置 + 相对路径 +
 * libIndex 导出」，深路径 import `src/store/file.js` 在只装了 npm 包时解不到。
 * 路径算错 = 报给宿主的 artifacts 是一个不存在的路径（= 编造），所以同式性由
 * `test/examples/erix-run-core.test.js` 拿**真引擎函数**逐字符对账钉住。
 */
export function safeRunIdForFile(runId) {
  const value = String(runId);
  if (/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)
    && value !== "." && value !== ".."
    && !value.startsWith(HASHED_RUN_ID_PREFIX)) {
    return value;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${HASHED_RUN_ID_PREFIX}${digest}`;
}

/**
 * judge 记录里的「扩轮字段判别键」（#207 R3）。
 *
 * 引擎把「judge 没给 `extend` 字段」表达成**缺字段**（`src/reflection/judge.js` 的
 * `parseJudgeDecision` 只在 `extend !== undefined` 时才写键，`src/loop/orchestrator.js` 的
 * `emitJudge` 同样条件展开），而缺字段在治理层等价于「不扩」（fail-closed）。
 * 两种事实的**因果不同**（模型拒扩 vs 模型没回答），只读 JSONL 的人很容易把它们看成同一件。
 * 所以下一条显式判别键（additive，引擎自己的字段一个不改）：
 *   - `"yes"`     —— judge 说了扩（`extend: true`）
 *   - `"no"`      —— judge 明确说不扩（`extend: false`，引擎 action `decline_extend`）
 *   - `"missing"` —— judge **没给** `extend` 字段 → 治理层 fail-closed 不扩
 *   - `"invalid"` —— 字段在但不是布尔值（引擎解析层不该出现，留作哨兵）
 * 没有 `decision` 对象的记录（`decision: null` 的 degraded / `run_outcome` 汇总）**不写该字段**。
 */
export function extendDecisionOf(record) {
  const decision = record?.decision;
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) return undefined;
  if (!("extend" in decision)) return "missing";
  if (decision.extend === true) return "yes";
  if (decision.extend === false) return "no";
  return "invalid";
}

/**
 * judge.log 一行的形状（#207 R3）：与 `bin/cli.js` 的 `appendJudgeLogRecord` 同构
 * （`ts` 在前 + 引擎记录原样），额外多一条 `extendDecision` 判别键。
 * 「原样」是红线：引擎记录里的 `runId` / `model` / `judgeModel` / `kind` / `action` /
 * `decision.extend` 缺省语义一律不动（AGENTS.md §6 与 host-consumer-contract「Judge record」）。
 */
export function judgeLogRecord(record, now = () => Date.now()) {
  const extendDecision = extendDecisionOf(record);
  return {
    ts: new Date(now()).toISOString(),
    ...(record ?? {}),
    ...(extendDecision === undefined ? {} : { extendDecision }),
  };
}

/**
 * 一个 run 的两个产物路径（#234：从 `createRunPersistence` 里提出来给异步层复用）。
 *
 * 布局只在这里定一处：`<dir>/<safeRunId>.jsonl` 与 `<dir>/outputs/<safeRunId>/judge.log`
 * （照 AGENTS.md §6，judge.log 位置与 CLI 默认一致）。异步层的 `status.json` 取 judge.log 的
 * 同目录，所以不会出现第二套布局。
 *
 * @param {{sessionDir:string, runId:string}} input
 * @returns {{transcriptPath:string, judgeLogPath:string}}
 */
export function artifactPaths({ sessionDir, runId }) {
  const safeId = safeRunIdForFile(runId);
  return {
    transcriptPath: path.join(sessionDir, `${safeId}.jsonl`),
    judgeLogPath: path.join(sessionDir, "outputs", safeId, "judge.log"),
  };
}

/**
 * 一次 run 的落盘面（#207 R3）：transcript 文件 store + judge.log 写入器 + 两个产物路径。
 *
 * 目录布局照 AGENTS.md §6：`<dir>/<runId>.jsonl` 与 `<dir>/outputs/<runId>/judge.log`
 * （judge.log 的位置**与 CLI 默认一致**，`--judge-log`/`ERIX_JUDGE_LOG` 那对覆盖变量是 CLI 的，
 * 本层不读，避免宿主环境里一个无关变量就把 erix_run 的审计面搬到别处）。
 *
 * @param {{libIndex:any, sessionDir?:string, runId:string, now?:()=>number, onWriteError?:(error:unknown)=>void}} input
 * @returns {{store:object, transcriptPath:string|undefined, judgeLogPath:string|undefined,
 *   appendJudgeLogRecord:((record:object)=>void)|undefined}}
 */
export function createRunPersistence({
  libIndex, sessionDir, runId, now = () => Date.now(), onWriteError,
}) {
  if (sessionDir === undefined || sessionDir === null || sessionDir === "") {
    // 不传参数 = 现有纯内存行为逐字不变（既不建目录也不建写入器）。
    return { store: libIndex.createMemoryTranscriptStore(), transcriptPath: undefined, judgeLogPath: undefined, appendJudgeLogRecord: undefined };
  }
  if (typeof libIndex?.createFileTranscriptStore !== "function") {
    throw new ErixRunError(
      "lib_missing",
      "要落盘就需要 erix-agent 入口导出 createFileTranscriptStore（包根 src/index.js 在 0.18 已有；"
      + "检查 ERIX_AGENT_LIB 指向的检出是否太旧）",
    );
  }
  const { transcriptPath, judgeLogPath } = artifactPaths({ sessionDir, runId });
  try {
    // 装配期就把目录建出来：坏路径在这里报 bad_params，而不是等到引擎落盘时变成半截 run。
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ErixRunError(
      "bad_params",
      `sessionDir 不可用：${sessionDir}（${error?.code ?? error?.message ?? String(error)}）`,
      { cause: error },
    );
  }

  let broken = false;
  let archiveReady = false;
  const appendJudgeLogRecord = (record) => {
    if (broken) return;
    try {
      if (!archiveReady) {
        mkdirSync(path.dirname(judgeLogPath), { recursive: true, mode: 0o700 });
        archiveReady = true;
      }
      appendFileSync(judgeLogPath, `${JSON.stringify(judgeLogRecord(record, now))}\n`, "utf8");
    } catch (error) {
      // 审计面写不进去不能反打已跑完的 run（与 bin/cli.js 同口径）：只记一次错、后续静默。
      broken = true;
      onWriteError?.(error);
    }
  };

  return {
    store: libIndex.createFileTranscriptStore({ dir: sessionDir }),
    transcriptPath,
    judgeLogPath,
    appendJudgeLogRecord,
  };
}

/**
 * 产物路径只在**文件真在盘上**时才报（#207 R4：宁给 null 也不猜路径）。
 * 未落盘、run 在第一轮之前就失败、judge 一次没跑（judge.log 没建）一律 `null`。
 */
export function resolveArtifacts({ transcriptPath, judgeLogPath }) {
  return {
    transcriptPath: transcriptPath !== undefined && existsSync(transcriptPath) ? transcriptPath : null,
    judgeLogPath: judgeLogPath !== undefined && existsSync(judgeLogPath) ? judgeLogPath : null,
  };
}

/**
 * 工具参数 → 归一化参数。抛 `ErixRunError("bad_params")`。
 *
 * @param {{task?:unknown, cwd?:unknown, maxRounds?:unknown, strategy?:unknown, timeoutMs?:unknown, model?:unknown,
 *   sessionDir?:unknown, transcript?:unknown, maxExtensions?:unknown, maxRoundsCap?:unknown, extensionStep?:unknown}} raw
 * @param {{home?:string}} [options]
 * @returns {{task:string, cwd:string, maxRounds:number, strategy?:string, timeoutMs:number, model?:string,
 *   sessionDir?:string, maxExtensions?:number, maxRoundsCap?:number, extensionStep?:number}}
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

  const sessionDir = parseSessionDir(raw, { home });
  if (sessionDir !== undefined) params.sessionDir = sessionDir;

  // #207 R1：扩轮三参数。**maxExtensions 允许 0**（引擎是 `>= 0` 判断，0 = 关掉扩轮），
  // 所以它走 nonNegativeInt 而不是现成的 positiveInt；另两个引擎要求正整数（0 会被引擎
  // 当成「没传」静默回落，那才是真的把用户意图吞掉）。
  if (raw?.maxExtensions !== undefined && raw?.maxExtensions !== null && raw?.maxExtensions !== "") {
    params.maxExtensions = intParam(raw.maxExtensions, {
      min: 0, max: MAX_MAX_EXTENSIONS, name: "maxExtensions", zeroAllowed: true,
    });
  }
  if (raw?.maxRoundsCap !== undefined && raw?.maxRoundsCap !== null && raw?.maxRoundsCap !== "") {
    params.maxRoundsCap = intParam(raw.maxRoundsCap, {
      min: 1, max: MAX_MAX_ROUNDS_CAP, name: "maxRoundsCap",
    });
  }
  if (raw?.extensionStep !== undefined && raw?.extensionStep !== null && raw?.extensionStep !== "") {
    params.extensionStep = intParam(raw.extensionStep, {
      min: 1, max: MAX_EXTENSION_STEP, name: "extensionStep",
    });
  }

  return /** @type {any} */ (params);
}

/**
 * `sessionDir` / `transcript` 两参数的归一化（#207 R3）。
 *
 * - `sessionDir`（首选）：`~` 会展开；**必须是绝对路径**（与 `cwd` 同口径：相对路径会随宿主
 *   工作目录漂移，落盘位置不该依赖它）。不存在则在建 store 时递归创建。
 * - `transcript`（同义写法）：`"file"` → 缺省目录 `<home>/.erix/transcripts`；其它非空串按目录
 *   路径处理；`"memory"|"none"|"off"` → 显式不落盘。
 * - 两个都给时 `sessionDir` 赢；都不给 → `undefined` = 纯内存（现有默认行为逐字不变）。
 *
 * @param {any} raw
 * @param {{home:string}} options
 * @returns {string|undefined}
 */
function parseSessionDir(raw, { home }) {
  const explicit = textOf(raw?.sessionDir).trim();
  const alias = textOf(raw?.transcript).trim();
  const spec = explicit !== "" ? explicit : alias;
  if (spec === "") return undefined;
  if (TRANSCRIPT_ALIASES_MEMORY.includes(spec.toLowerCase())) return undefined;
  if (spec === TRANSCRIPT_ALIAS_FILE) {
    return path.join(home, ...DEFAULT_SESSION_DIR_SEGMENTS);
  }
  const dir = expandUserPath(spec, { home });
  if (!path.isAbsolute(dir)) {
    throw new ErixRunError(
      "bad_params",
      `sessionDir 必须是绝对路径（或 ${TRANSCRIPT_ALIAS_FILE}），收到 ${JSON.stringify(spec)}`
      + "（相对路径会随 pi 的工作目录漂移）",
    );
  }
  return dir;
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
 *   onJudge?: (record:object)=>void,
 *   onProgress?: (line:string)=>void,
 *   diagnostics?: {error:(event:object)=>void},
 *   reflection?: object|false,
 * }} input
 * @returns {object} runToolLoop 的 options 对象
 */
export function buildLoopOptions(input) {
  const {
    params, slot, provider, tools, store, signal, runId,
    system, onEvent, onObserverError, onPersistenceError, onJudge, diagnostics,
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
    ...(onJudge === undefined ? {} : { onJudge }),
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
/**
 * 决策事实（#207 R4）：三个载荷出口共用的字段组，保证成功/抛错两条终路形状不分叉。
 *
 * - `artifacts`：**未落盘就是 `null`**，绝不猜路径（见 `resolveArtifacts`）。
 * - `extensionCount` / `maxExtensions`：本次 run 用了几次扩轮 / 生效上限是多少（0 = 根本没开）。
 * - `resumable`：读 `RESUMABLE` 常量（#207 R2 未落地前恒 `false`）。
 */
function decisionFacts(input) {
  const artifacts = input?.artifacts ?? { transcriptPath: null, judgeLogPath: null };
  return {
    artifacts: {
      transcriptPath: typeof artifacts.transcriptPath === "string" ? artifacts.transcriptPath : null,
      judgeLogPath: typeof artifacts.judgeLogPath === "string" ? artifacts.judgeLogPath : null,
    },
    extensionCount: Number.isSafeInteger(input?.extensionCount) ? input.extensionCount : 0,
    maxExtensions: Number.isSafeInteger(input?.maxExtensions) ? input.maxExtensions : 0,
    resumable: input?.resumable === true,
  };
}

/**
 * 正常返回 → 结构化载荷。
 *
 * @param {any} result runToolLoop 的返回值
 * @param {{timeout:boolean, aborted:boolean, observerErrors:any[], metadataEvents:any[],
 *   ledgerErrors:any[], context:object, artifacts?:object, extensionCount?:number,
 *   maxExtensions?:number, resumable?:boolean}} input
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
    ...decisionFacts(input),
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
    ...decisionFacts(input),
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
    // #207 R3/R4：落盘位置与扩轮闸门（requested = 宿主传了什么，enabled=false 就是没生效）。
    sessionDir: context.sessionDir ?? null,
    reflection: context.reflection ?? null,
  };
  if (typeof source?.termination?.errorCode === "string") {
    diagnostics.errorCode = source.termination.errorCode;
  }
  return diagnostics;
}

function newRunIdFromClock(now) {
  return `erix-run-${new Date(now()).toISOString().replaceAll(":", "-")}-${randomBytes(3).toString("hex")}`;
}

/**
 * runId 的唯一来源（#234：异步分支要在**起 run 之前**就拿到 id 当句柄，不能等到终局才从
 * diagnostics 里摸）。同步路径不传 `deps.runId`，行为与改动前逐字一致。
 */
export function newRunId(now = () => Date.now()) {
  return newRunIdFromClock(now);
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
  // #207 R2/R4：落盘面与扩轮余量。两个变量都要活到 catch 分支（装配期就失败的 run
  // 也要能把 artifacts 如实报成 null，而不是缺字段）。
  /** @type {{transcriptPath?:string, judgeLogPath?:string}|null} */
  let persistence = null;
  let extensionCount = 0;
  let maxExtensions = 0;
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
    const runId = deps.runId ?? newRunId(now);
    context.runId = runId;

    // 工具调用的进度不从这里发：引擎的 tool_use / tool_result 事件已覆盖同一事件，
    // 两处都报会在 pi 的进度窗口里出现重复行。
    // #207 R3：内层 store 的唯一注入缝仍是 deps.createStore（没新造管道）；没注入时按
    // sessionDir 选文件 store 或内存 store（不传 = 纯内存，与改动前逐字一致）。
    const runPersistence = deps.createStore
      ? {
        store: deps.createStore(),
        transcriptPath: undefined,
        judgeLogPath: undefined,
        appendJudgeLogRecord: undefined,
      }
      : createRunPersistence({
        libIndex,
        sessionDir: params.sessionDir,
        runId,
        now,
        onWriteError: (error) => {
          persistenceErrors.push({ channel: "judgeLog", message: textOf(error?.message ?? error) });
          progress(`⚠ judge.log 写入失败，后续审计行不再写：${preview(error?.message ?? error)}`);
        },
      });
    const store = runPersistence.store;
    const appendJudgeLogRecord = runPersistence.appendJudgeLogRecord;
    context.sessionDir = params.sessionDir;
    persistence = {
      transcriptPath: runPersistence.transcriptPath,
      judgeLogPath: runPersistence.judgeLogPath,
    };

    progress(
      `erix_run 启动：model=${context.model ?? "?"} cwd=${params.cwd} maxRounds=${params.maxRounds}`
      + ` strategy=${params.strategy ?? "（未配置，走引擎缺省）"} timeoutMs=${params.timeoutMs}`
      + `（lib: ${context.libSource}）`,
    );
    if (params.sessionDir !== undefined) {
      progress(`落盘：transcript=${runPersistence.transcriptPath} judgeLog=${runPersistence.judgeLogPath}`);
    }

    timer = setTimeout(() => {
      timedOut = true;
      progress(`⏱ 超时 ${params.timeoutMs}ms，abort 内层 run`);
      controller.abort(new Error(`erix_run 超时（${params.timeoutMs}ms）`));
    }, params.timeoutMs);

    const runLoop = deps.runLoop ?? libIndex.runToolLoop;
    // #207 R1：三个扩轮参数直传引擎 `reflection:{…}`，**不碰引擎默认值**（不传就是引擎自己的）。
    // 它们只在 judge 真的跑了时才生效（引擎仅在 nearLimit + judge 给了布尔 `extend` 时读它们，
    // 见 src/loop/orchestrator.js 的 `reflectionExtensionStep` / `reflectionMaxExtensions` /
    // `reflectionMaxRoundsCap` 与 src/reflection/governor.js 的 `extensionAllowed`）。
    const requestedExtensions = {};
    for (const key of EXTENSION_PARAM_NAMES) {
      if (params[key] !== undefined) requestedExtensions[key] = params[key];
    }
    // judge 开启闸门与改动前逐字一致（ERIX_NO_REFLECTION=1 优先，否则 maxRounds ≥ 16 自动开）。
    // 闸门关着时三个参数**整体不下发**，并在 diagnostics.reflection 里如实写「没生效」，
    // 不默默假称传了（本单只打通管道，不把「顺手改开 judge」的成本变化塞进来）。
    const reflectionEnabled = env.ERIX_NO_REFLECTION?.trim() !== "1" && params.maxRounds >= 16;
    maxExtensions = reflectionEnabled
      ? (params.maxExtensions ?? ENGINE_DEFAULT_MAX_EXTENSIONS)
      : 0;
    context.reflection = {
      enabled: reflectionEnabled,
      requested: requestedExtensions,
      // 生效上限：未传时是引擎缺省（ ENGINE_DEFAULT_MAX_EXTENSIONS，不是本层下发的默认值）。
      maxExtensions,
    };
    const reflection = reflectionEnabled
      ? {
        enabled: true,
        ...requestedExtensions,
        // 扩轮计数的唯一可靠入口：引擎只在真的执行了 extend / extend+redirect 时调它
        // （src/loop/orchestrator.js 里紧接 governorState.extensionCount += 1）。
        // ⚠ 它不在隔离名单里（契约「reflection.onReflection 仍按未隔离处理，抛错杀 run」），
        // 所以这个回调必须自防到一句 throw 也不会漏出去。
        onReflection: (info) => {
          try {
            extensionCount += 1;
            progress(
              `↻ 扩轮 ${extensionCount}/${maxExtensions}：round ${info?.round ?? "?"}`
              + ` → 上限 ${info?.extendedTo ?? "?"}`,
            );
          } catch {
            // 计数与进度都不允许把 run 带死
          }
        },
      }
      : false;

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
          // #207 R3：run 终局汇总也落进同一个 judge.log（照 bin/cli.js：只抄这一条，
          // 其余事件不抄），AGENTS.md §6「末行 run_outcome 汇总」就靠它。写入器内部吞错，
          // 不会把已跑完的 run 带成 failed。
          if (appendJudgeLogRecord !== undefined && event?.type === "run_outcome") {
            appendJudgeLogRecord(event);
          }
          const line = formatLoopEvent(event);
          if (line !== undefined) progress(line);
        } catch (observerError) {
          recordObserverError(observerError, { channel: "onEvent", type: event?.type });
        }
      },
      // #207 R3：每条 judge 决策原样落盘（+ ts 与 extendDecision 判别键）。
      // 不落盘时不传这个观察者，引擎行为与改动前逐字一致。
      onJudge: appendJudgeLogRecord,
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
      reflection,
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
      artifacts: resolveArtifacts(persistence),
      extensionCount,
      maxExtensions,
      resumable: RESUMABLE,
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
      artifacts: resolveArtifacts(persistence ?? {}),
      extensionCount,
      maxExtensions,
      resumable: RESUMABLE,
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
  // #207 R4：把决策事实也给模型看（它才能自己决定「去读 transcript」还是「直接重跑」）。
  const artifacts = payload?.artifacts;
  lines.push(`[facts] transcript=${artifacts?.transcriptPath ?? "none"}`
    + ` judgeLog=${artifacts?.judgeLogPath ?? "none"}`
    + ` extensions=${payload?.extensionCount ?? 0}/${payload?.maxExtensions ?? 0}`
    + ` resumable=${payload?.resumable === true}`
    + (payload?.resumable === true ? "" : "（本层未接 resume，终局不可续跑）"));
  const reflection = diagnostics?.reflection;
  if (reflection && reflection.enabled === false && Object.keys(reflection.requested ?? {}).length > 0) {
    // 传了扩轮参数但 judge 闸门没开 → 明说它没生效，别假称传了。
    lines.push(`  ↳ 扩轮参数未生效（judge 未开启，需 maxRounds ≥ 16 或去掉 ERIX_NO_REFLECTION）：`
      + JSON.stringify(reflection.requested));
  }
  if (payload?.error?.message) {
    lines.push(`[error] ${payload.error.code ?? payload.error.name ?? "Error"}: ${payload.error.message}`);
  }
  return lines.join("\n");
}
