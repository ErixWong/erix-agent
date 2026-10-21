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

// #314：终稿核验（finalGuard）谓词层。本文件只做「开关 + 透传 + 成本计数」，
// 谓词本体（四段存在性 / 基点溯源 / 派生结论提醒）在 erix-run-final-guard.js。
import {
  createFinalGuardTally,
  createFinalGuardVerify,
  FINAL_DRAFT_PROMPT,
  FINAL_GUARD_TIMEOUT_MS,
  FINAL_GUARD_WORST_CASE_MS,
  summarizeFinalGuard,
} from "./erix-run-final-guard.js";

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
 *   sessionDir?:unknown, transcript?:unknown, maxExtensions?:unknown, maxRoundsCap?:unknown, extensionStep?:unknown,
 *   judgeDoneAdvisory?:unknown}} raw
 * @param {{home?:string}} [options]
 * @returns {{task:string, cwd:string, maxRounds:number, strategy?:string, timeoutMs:number, model?:string,
 *   sessionDir?:string, maxExtensions?:number, maxRoundsCap?:number, extensionStep?:number,
 *   judgeDoneAdvisory?:boolean}}
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

  // #314 R1：终稿核验开关，**默认关**（不往下传 ⇒ 引擎 verification 恒 `skipped`，
  // 现有断言一条不改）。只认**真布尔 true**：`"true"` / `1` 这类脏值直接报错，
  // 静默当成「没开」就是把用户的核验意图吞掉。
  const finalGuardRaw = raw?.finalGuard;
  if (finalGuardRaw !== undefined && finalGuardRaw !== null && finalGuardRaw !== "") {
    if (typeof finalGuardRaw !== "boolean") {
      throw new ErixRunError(
        "bad_params",
        `finalGuard 只能是 true | false，收到 ${JSON.stringify(finalGuardRaw)}`,
      );
    }
    if (finalGuardRaw) {
      params.finalGuard = true;
      // 坑 ①：guard 等待发生在 stop 判定之后，而引擎只在**轮边界**看截止时间
      //（`src/loop/orchestrator.js` 的 `remainingMs()`），本层那根 `setTimeout` 硬 abort
      // 却在 `params.timeoutMs` 上。所以开启时**显式**下发一个比引擎默认（30s）小得多的
      // 等待上限，并把宿主硬 abort 往后挪 `FINAL_GUARD_WORST_CASE_MS`（见 runErixRun）。
      params.finalGuardTimeoutMs = positiveInt(raw?.finalGuardTimeoutMs, FINAL_GUARD_TIMEOUT_MS, {
        min: 200, max: 600_000, name: "finalGuardTimeoutMs",
      });
    }
  }
  // 没开启时 `finalGuardTimeoutMs` 是个无意义的悬空值，不能让它悄悄出现在 params 里。
  if (params.finalGuard !== true && raw?.finalGuardTimeoutMs !== undefined
    && raw?.finalGuardTimeoutMs !== null && raw?.finalGuardTimeoutMs !== "") {
    throw new ErixRunError(
      "bad_params",
      "finalGuardTimeoutMs 只在 finalGuard: true 时有意义（没开启就别传，否则容易误以为在核验）",
    );
  }

  // issue #322 的宿主侧口子：评审意见回灌开关，**默认关**（没传就不写进 params，
  // 让引擎自己的缺省 false 生效——本层不替引擎造默认值）。形状照上面的 `finalGuard`：
  // 只认真布尔，`"true"` / `1` 这类脏值直接报错（当成「没传」就是把用户意图吞掉）。
  // 与 finalGuard 的**唯一**差别：`false` 也原样保留（宿主明确说「关」，透传下去就是事实，
  // 不是替引擎填的默认值）。
  const judgeDoneAdvisoryRaw = raw?.judgeDoneAdvisory;
  if (judgeDoneAdvisoryRaw !== undefined && judgeDoneAdvisoryRaw !== null && judgeDoneAdvisoryRaw !== "") {
    if (typeof judgeDoneAdvisoryRaw !== "boolean") {
      throw new ErixRunError(
        "bad_params",
        `judgeDoneAdvisory 只能是 true | false，收到 ${JSON.stringify(judgeDoneAdvisoryRaw)}`,
      );
    }
    params.judgeDoneAdvisory = judgeDoneAdvisoryRaw;
  }

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
 * NotesStore 的**内存**适配器：issue #265 之后实现归引擎——
 * `src/store/notes-memory.js`，与文件适配器共用 `src/store/notes-port.js` 那份端口
 * 语义（记录校验、scopeRef 规范化、list filters/sort/limit、revoke 字段写入、purge
 * 的 before/保留期/scanned），并由 `test/contract/notes-store.js` 同一套契约套件
 * 按 label table-driven 各跑一遍。本层原先约 100 行的手抄实现已删——它只被
 * `assertNotesStore`（查方法不查语义）量过，从没被契约量过，量一次就红 2 条
 * （记录完全不校验、purge 的「刚写入 scope 豁免保留期」被忽略）。
 *
 * 转发方式：`createInnerNotesTools` 优先取注入 lib 的 `libIndex.createMemoryNotesStore`
 * （与 lib 同版本）；本导出直接取本仓 `src/index.js` 的同一函数对象（相对路径动态
 * import，仓库布局下即引擎导出本身）。README 的部署是 `cp -r` 出去，那里
 * `../../src/index.js` 解不到 → 本导出不存在（undefined），装配路径仍走 libIndex，不受影响。
 */
let engineCreateMemoryNotesStore;
try {
  ({ createMemoryNotesStore: engineCreateMemoryNotesStore } = await import(
    new URL("../../src/index.js", import.meta.url).href
  ));
} catch {
  engineCreateMemoryNotesStore = undefined;
}
export const createMemoryNotesStore = engineCreateMemoryNotesStore;

/**
 * notes 四件套的内层装配（引擎公共导出 `createBuiltinNotesTools`，参 bin/cli.js 的用法）。
 *
 * 为什么必须接：R1 之后结果不再被宿主截到 4KB，引擎的 TTL 预警（src/loop/tool-result-ttl.js
 * 「请现在用 note_take 记录要点」）与折叠占位符（「先用 note_list 查找，再用 note_read 读取」）
 * **第一次真正会触发**——文案点名的工具在内层工具面里必须真存在，否则是给模型开一张
 * 兜不了现的支票。
 *
 * 落点纪律：跟着 `sessionDir` 走（`<sessionDir>/notes`，与 transcript/judge.log 同根）；
 * 不传 sessionDir → 引擎的内存 store（#265，`createMemoryNotesStore` 导出），
 * **绝不写 `~/.erix`**。
 *
 * @param {{lib:any, runId?:string, sessionDir?:string, notesStore?:object}} input
 * @returns {object|undefined} assembler（无 createBuiltinNotesTools 导出时降级为 undefined）
 */
export function createInnerNotesTools({ lib, runId, sessionDir, notesStore }) {
  const libIndex = lib?.index ?? lib;
  if (typeof libIndex?.createBuiltinNotesTools !== "function") return undefined;
  if (notesStore === undefined && sessionDir === undefined) {
    // 无 sessionDir：纯内存，不走 resolveNotesDir 的 ~/.erix/notes 缺省。
    // #265：实现归引擎。优先用注入 lib 自带的导出（与 lib 同版本，含只装了
    // npm 包的部署）；lib 太旧没有它时退到本模块对仓内 src/index.js 的转发。
    const factory = typeof libIndex.createMemoryNotesStore === "function"
      ? libIndex.createMemoryNotesStore
      : createMemoryNotesStore;
    if (typeof factory !== "function") return undefined;
    return libIndex.createBuiltinNotesTools({ runId, notesStore: factory() });
  }
  if (notesStore !== undefined) {
    return libIndex.createBuiltinNotesTools({ runId, notesStore });
  }
  const notesDir = path.join(sessionDir, "notes");
  if (typeof libIndex.createFileNotesStore !== "function") return undefined;
  return libIndex.createBuiltinNotesTools({
    runId,
    notesDir,
    notesStore: libIndex.createFileNotesStore({ dir: notesDir }),
  });
}

/**
 * #266：内层 notes 的收尾收口（`lifecycle.onRunComplete`，把 run scope 的 active 笔记 → done）。
 *
 * 为什么必须由本层来调：assembler 是在 `createInnerTools` 里装配的（返回值的 `notes` 字段），
 * 而端口注释（src/tools/notes.js 的 lifecycle）写明 **purge 与 active orphan 清理是宿主职责**，
 * 钩子本身只做 `completeRun`。erix_run 就是内层 notes 的宿主：收尾不接上，
 * `<sessionDir>/notes/run/<runId>/` 里的记录**永远停在 active**，而 `note_list` 默认只列 active
 * （src/tools/notes.js:382），事后翻档案完全看不出这条 run 已经收口。
 *
 * 三条纪律（姿势照 bin/cli.js:935-946 的同一段收尾）：
 * 1. **只在 notes 真被装配时调**：`deps.createAssembly` 给的自定义装配没有 `notes` 字段时直接跳过
 *    （存在判定，不硬取属性，绝不 TypeError）；
 * 2. **收尾绝不改变终局**：钩子抛错、或返回 `errors[]` 非空，都只写进 `diagnostics.notesLifecycle`
 *    留痕；终局的 `ok` / `termination` / `usage` 一字不动（收尾失败不等于任务失败）；
 * 3. **不顺手加 purge**：`purge` 是无视 scopeRef 的全量清扫（src/store/notes.js 的 typedef），
 *    在内层加它需要单独论证，本单只接 `onRunComplete`。
 *
 * @param {{lifecycle?: {onRunComplete?: (input?: object) => Promise<{completed?: {completed?: number}, errors?: Array<{operation?: string, error?: any}>}>}}|undefined} notesAssembler
 * @param {{progress?: (line:string)=>void}} [hooks]
 * @returns {Promise<{attempted: boolean, completed: number, errors: Array<{operation: string, message: string}>}>}
 */
async function completeInnerNotes(notesAssembler, { progress } = {}) {
  const onRunComplete = notesAssembler?.lifecycle?.onRunComplete;
  if (typeof onRunComplete !== "function") {
    return { attempted: false, completed: 0, errors: [] };
  }
  const errors = [];
  let completed = 0;
  try {
    const outcome = await onRunComplete();
    completed = Number.isFinite(outcome?.completed?.completed) ? outcome.completed.completed : 0;
    // 钩子把 store 层的失败收集在 errors[] 里返回（不抛），这里逐条转成可 JSON 化的留痕。
    for (const failure of outcome?.errors ?? []) {
      errors.push({
        operation: textOf(failure?.operation ?? "notes_complete_run"),
        message: textOf(failure?.error?.message ?? failure?.error ?? failure),
      });
    }
  } catch (error) {
    // 收尾自身失败不得掩盖主结果：吞掉异常，只留痕（与 bin/cli.js 的 completionErrors 同一语义）。
    errors.push({ operation: "notes_lifecycle", message: textOf(error?.message ?? error) });
  }
  for (const failure of errors) {
    progress?.(`⚠ notes 收尾失败（${failure.operation}）：${failure.message}——不影响本次终局，仅留痕`);
  }
  return { attempted: true, completed, errors };
}

/**
 * 内层工具集：复用 bin/tools.js 的同一装配函数 `createCliTools`
 * （readFile/rg/grep/tree/writeFile/exec，todo 四件套默认关，见 README）。
 *
 * ⚠ **本层不得对工具结果做任何截断**（issue #261 系列修复，见 README「宿主层不再截结果」）：
 * 1. 引擎已有归档语义——`outputHygiene`（ADR-015）在结果超限时把**原文**归档进 round record 的
 *    `toolOutputs`，模型只看到 stub + 指针，内容随时可取回；`aggregate-budget` 再管单轮合计；
 *    exec 自带 maxBuffer 硬顶。宿主先在下游截到几 KB，就把这三层整个架空（归档分支从未触发）。
 * 2. 宿主截断是**就地销毁**：head+tail 按字符 slice 会切在行中间，`readFile` 承诺的
 *    「整行 + offset 续读」契约当场失效（实测：请求 offset=0,limit=200 拿到 1-66 + 182-200，
 *    中段约 115 行静默消失，模型连补 5 轮）。bin/tools.js 的分工注释本就写着 readFile 不经截断。
 *
 * @param {{
 *   lib: any,
 *   cwd: string,
 *   todo?: boolean,
 *   runId?: string,
 *   sessionDir?: string,
 *   notesStore?: object,
 *   notes?: boolean,
 *   onToolEvent?: (info:{phase:string, name:string, input?:object, chars?:number, isError?:boolean}) => void,
 * }} input
 * @returns {{tools:object[], executeTool:(options:object)=>Promise<string>}}
 */
export function createInnerTools({
  lib,
  cwd,
  todo = false,
  runId,
  sessionDir,
  notesStore,
  notes = true,
  onToolEvent,
}) {
  const cliTools = lib.binTools.createCliTools({ cwd, todo });
  // note_* 不在 bin/tools.js 里（它属于 src/ 公共面），在本层拼上，见 createInnerNotesTools。
  const notesAssembler = notes === false
    ? undefined
    : createInnerNotesTools({ lib, runId, sessionDir, notesStore });
  const notesToolNames = new Set(notesAssembler?.definitions?.map((tool) => tool.name) ?? []);
  const tools = notesAssembler === undefined
    ? cliTools.tools
    : [...cliTools.tools, ...notesAssembler.definitions];

  async function executeTool(execution = {}) {
    const name = typeof execution === "object" ? execution.name : execution;
    const input = typeof execution === "object" ? execution.input : undefined;
    onToolEvent?.({ phase: "start", name, input });
    try {
      // bin/tools.js 的 executor 只吃 input（context/signal 不参与执行，exec 自带
      // ERIX_EXEC_TIMEOUT_MS 超时）。结果**原样返回**，理由见 createInnerTools 的注释：
      // 体积护栏是引擎 outputHygiene + aggregate-budget + exec maxBuffer 的职责，不是这里的。
      // note_* 走引擎的 notes assembler（同一个 (name, input, context) 位置参数形状）。
      const raw = await (notesToolNames.has(name) ? notesAssembler.executors : cliTools.executeTool)(
        name, input, {
          ...(execution.context ?? {}),
          toolUseId: execution.id,
          signal: execution.signal,
        },
      );
      const text = typeof raw === "string" ? raw : String(raw ?? "");
      onToolEvent?.({ phase: "end", name, chars: text.length, isError: /^\s*错误[：:]/u.test(text) });
      return text;
    } catch (error) {
      onToolEvent?.({ phase: "error", name, isError: true });
      throw error;
    }
  }

  return { tools, executeTool, cliTools, notes: notesAssembler };
}

/**
 * 宿主自己拼进工具面的那批工具（`note_*`，由引擎 notes assembler 提供）的清单文案。
 * 它不在 `bin/tools.js` 的注册面上，所以引擎侧短语表里没有它（issue #312(b) R3 选 (i)）。
 *
 * 为什么选 (i) 而不是白名单 (ii)：这 4 个名字确实被 `createInnerTools` 拼进了交给 `runToolLoop`
 * 的 `tools`，白名单只是把「模型能叫、却没被告知存在」写成合法，而事实一致性正是本单要治的东西；
 * 而宿主文案没有 golden 钉（全仓就这一处），改它零成本。引擎散文只提到 note_take/list/read、
 * 偏偏漏了 note_forget，恰好是「靠散文兼容靠不住」的现成证据。
 */
export const HOST_REGISTERED_TOOL_PHRASES = {
  note_take: "note_take 记下后面还要用的具体值/决定",
  note_list: "note_list 列出已记笔记的 key",
  note_read: "note_read 按 key 读回笔记",
  note_forget: "note_forget 撤销一条笔记",
};

/** 从实际注册数组取名字（顺序即注册顺序；没有名字就交回空数组，由调用方决定怎么硬失败）。 */
function registeredToolNames(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === "string" ? tool.name : undefined))
    .filter((name) => typeof name === "string" && name !== "");
}

/**
 * 合一张短语表：引擎侧 `bin/tools.js` 导出的 `CLI_TOOL_PROMPT_PHRASES`（只引用，不手抄）
 * ＋ 宿主自己注册的 note_*。没拿到引擎表（旧 lib / 测试桩）时只覆盖 note_*，其余名字会在
 * `buildToolListLine` 里因「查不到文案」而显式抛错，而不是退一份旧名单。
 */
function resolveToolPhrases(lib) {
  const merged = { ...HOST_REGISTERED_TOOL_PHRASES };
  const enginePhrases = lib?.binTools?.CLI_TOOL_PROMPT_PHRASES;
  if (enginePhrases !== null && typeof enginePhrases === "object") {
    for (const [name, entry] of Object.entries(enginePhrases)) {
      merged[name] = typeof entry === "string" ? entry : entry?.phrase;
    }
  }
  return merged;
}

/**
 * 由**实际注册数组**生成工具清单行（issue #312(b) R1：这里曾是「readFile/rg/grep/tree/writeFile/exec」
 * 的手抄，已经少列了 `searchText` 与 `edit`）。名单 = 遍历注册数组 ⇒「注册面 ⊆ 清单」在构造上
 * 不可能漏列；文案 = 查短语表（引擎表优先，只引用不手抄），查不到就退到**裸工具名**——
 * 宁可写得干，也不能静默丢一个工具。名字空集 ⇒ 抛错（拿不到注册面就不拼清单）。
 */
export function buildToolListLine({ tools, phrases = {}, lead = "可用工具：" } = {}) {
  const names = registeredToolNames(tools);
  if (names.length === 0) {
    throw new ErixRunError(
      "tool_list_unavailable",
      "生成工具清单行时拿不到实际注册面（tools 空或不可用）——手抄兜底已删，不许静默退成另一份名单",
    );
  }
  return `${lead}${names.map((name) => phrases[name] ?? name).join("、")}。`;
}

/**
 * 装配期双向断言的第三句（issue #312(b) R3）：**提示词里出现的工具名 ⊆ 实际交给 `runToolLoop`
 * 的那个 `tools` 数组**（含 `createInnerTools` 在 `:841-843` 拼进去的 `note_*`）。
 *
 * 名字不是靠「把清单行按标点切开」抽的（那样会被文案里的顿号与括号骗到），而是只拿**清单行**
 * （以「可用工具：」/「本工具面另注册：」开头的两段）去比一张**有界候选集**（引擎短语表的 key
 * ∪ 宿主 note_* 表）。散文段（引擎提示词的 [你的处境] / [工具纪律] 里提到 note_take/note_read）
 * **不**算登记：散文段提及 ≠ 清单登记（issue #312(b) R3 的注脚），否则 `notes:false` 的宿主会
 * 因引擎自己的散文而红，而那不是它能修的。
 */
export function assertToolListMatchesRegistered({ prompt, tools, universe } = {}) {
  const candidates = [...new Set([
    ...(Array.isArray(universe) ? universe : []),
    ...Object.keys(HOST_REGISTERED_TOOL_PHRASES),
  ])];
  const registered = new Set(registeredToolNames(tools));
  const listLines = [...String(prompt ?? "").matchAll(/(?:可用工具|本工具面另注册)：[^\n]*/gu)]
    .map((match) => match[0]);
  const ghosts = candidates.filter((name) => !registered.has(name)
    && listLines.some((line) => mentionsToolName(line, name)));
  if (ghosts.length > 0) {
    throw new ErixRunError(
      "tool_list_unavailable",
      `提示词清单里写了工具面里未注册的工具：${ghosts.join("、")}（提示词 ⊄ 注册面；常见成因：清单与 tools 的 todo/notes 开关不一致）`,
    );
  }
  return ghosts;
}

/** 整词匹配（工具名都是 ASCII 标识符）：避开把 `note_read` 算进 `note_reader` 这种误伤。 */
function mentionsToolName(text, name) {
  return new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([^A-Za-z0-9_]|$)`, "u")
    .test(text);
}

/** 内层 system prompt：复用 bin/tools.js 的工具提示词装配（与 CLI 同一口径）。 */
export function buildSystemPrompt({ lib, cwd, todo = false, tools, finalDraft = false } = {}) {
  // 兜底不再手抄名单（R1）：能拿到引擎装配就用它；否则用**实际注册数组**生成（优先用调用方
  // 传进来的 `tools`——那正是交给 runToolLoop 的那一个；拿不到则现场调 `createCliTools`）。
  // 两者都拿不到 ⇒ `buildToolListLine` 抛错（C4：不许出现「少两个工具的名单」）。
  const registered = tools ?? (typeof lib?.binTools?.createCliTools === "function"
    ? lib.binTools.createCliTools({ cwd, todo }).tools
    : undefined);
  const hostNames = registeredToolNames(registered);
  // 引擎清单只认 bin/ 的注册面；宿主自己拼的 note_* 靠本层补一行（R3 选 (i)），
  // 否则 note_forget 连名字都不会到模型眼前。
  const extras = hostNames.filter((name) => HOST_REGISTERED_TOOL_PHRASES[name] !== undefined);
  const base = typeof lib?.binTools?.buildCliToolsSystemPrompt === "function"
    ? lib.binTools.buildCliToolsSystemPrompt({ todo })
    : buildToolListLine({ tools: registered, phrases: resolveToolPhrases(lib) });
  const hostGenerated = typeof lib?.binTools?.buildCliToolsSystemPrompt !== "function";
  const supplement = extras.length === 0
    ? ""
    : `\n\n本工具面另注册：${extras.map((name) => HOST_REGISTERED_TOOL_PHRASES[name]).join("、")}。`;
  const prompt = `你是被 pi 调度的 erix 编码助手，工作目录 ${cwd}。${base}`
    + supplement
    + "\n\n交付规则：直接在工作目录里改文件（清单里的写类工具都能用），"
    + "收尾只写简短摘要——改了什么、为什么、如何验证；不要粘贴大段代码或文件全文。"
    + "\n\n任务完成时首行写「任务已完成」，再接摘要。"
    // #314 R2：终稿四段的槽位只在**开了 finalGuard 时**写进提示词——默认关时提示词
    // 一个字节不变（C6 的默认路径零行为变化），也不让模型去满足一个没人校验的格式。
    // 文案与 guard 的段名常量同源：`FINAL_DRAFT_SECTIONS` / `FINAL_DRAFT_PROMPT`。
    + (finalDraft === true ? FINAL_DRAFT_PROMPT : "")
    + "\n\n每轮开始先用一句话（≤30字）说明当前计划，再调用工具。";
  // 装配期断言（R3 第三条）。作用域只到**本层自己写进清单的名字**：
  //   · 引擎给了 base ⇒ 引擎清单已由 `bin/tools.js` 在 build 期钉过「提示词 ⊆ 注册面」，而宿主这一层
  //     拿到的可能是 `deps.createAssembly` 的自定义工具面（#266 允许它长得什么都不像），
  //     拿引擎名单去要求它是假红；本层只对 note_* 补行负责。
  //   · 本层自己生成清单 ⇒ 整行都是本层写的，全部纳入。
  // 全量严格版（拿引擎短语表当候选集）导给了测试，见 `assertToolListMatchesRegistered`。
  if (hostNames.length > 0) {
    assertToolListMatchesRegistered({
      prompt,
      tools: registered,
      universe: hostGenerated ? Object.keys(resolveToolPhrases(lib)) : Object.keys(HOST_REGISTERED_TOOL_PHRASES),
    });
  }
  return prompt;
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
      // 耗时字段的现役名字是 `erix.durationMs`（issue #284/#285：0.20.0 T2 停写顶层摊平名）。
      // 这里曾经读的是**退役名** `event.toolResult.duration`——T2 停写后它永远 undefined，
      // 于是进度行**静默丢掉耗时**（不抛错、不报错，正是本仓一路在防的那一类腐化）。
      // 口径与仓内其余读路径逐字一致（`src/display/projection.js`、`src/loop/tool-result-ttl.js`）：
      // `erix.*` 优先，顶层旧名只作**一代读窗口**的回退（读 0.19 及更早落盘的历史块 / 老事件）。
      const rawDuration = event.toolResult?.erix?.durationMs ?? event.toolResult?.duration;
      const dur = Number.isFinite(rawDuration) ? ` ${rawDuration}ms` : "";
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
 *   diagnostics?: {error:(event:object)=>void},
 *   reflection?: object|false,
 *   // #314 R1：终稿核验回调。引擎要的就是一个函数（载荷 `{finalText, findings, messages,
 *   //   round, rounds, signal, termination}`，见 `src/loop/termination.js` 的 `callFinalGuard`）。
 *   // **不传就是不透传** ⇒ 引擎侧 verification 保持 `skipped`。
 *   finalGuard?: (payload:object)=>Promise<{action:string, message?:string, reason?:string}>,
 * }} input
 * @returns {object} runToolLoop 的 options 对象
 */
export function buildLoopOptions(input) {
  const {
    params, slot, provider, tools, store, signal, runId,
    system, onEvent, onObserverError, onPersistenceError, onJudge, diagnostics,
    reflection, finalGuard,
  } = input;

  /** @type {Record<string, unknown>} */
  const options = {
    provider,
    system: system ?? buildSystemPrompt({ lib: { binTools: {} }, cwd: params.cwd, tools: tools.tools }),
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
    // #314 R1：只有调用方给了回调才下发这两个键（默认关时 options 对象上**一个字节都不多**，
    // 这正是 C6「默认路径不回归」的硬约束）。`finalGuardTimeoutMs` 必须**显式给**：
    // 引擎默认 30_000 × 最多 3 次等待（1 + 2 次 revise）会撑爆宿主自己那根硬 abort（坑 ①）。
    ...(finalGuard === undefined ? {} : {
      finalGuard,
      finalGuardTimeoutMs: params.finalGuardTimeoutMs ?? FINAL_GUARD_TIMEOUT_MS,
    }),
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

/**
 * #313 R1/R2：终局面的分层削减汇总（**additive**，不改任何判定语义）。
 *
 * 层 id **一律取引擎声明里的真实 id**：`COMPACTION_LAYER_IDS`（`src/compact/pipeline.js`）由
 * `COMPACTION_PIPELINE`（`src/compact/pipeline.js`）的 id 派生，当前是
 * ttl / slidingWindow / foldStatistical / foldLlm / anchors / enforceSize；下面四个展示归组
 * 的依据就是那份声明里的 `granularity` / `phase` 字段（whole-round → 整轮折叠，
 * single-result → 逐条 TTL 削减，safety 阶段的 fields-and-messages → 输出钳制，
 * fidelity → 折叠锚点/保真）。本表只做**展示归组**：不新增层、不重命名层、不参与判定。
 * 数据里出现的**未知层 id** 一律进 `unattributed` 并单独渲染，绝不静默丢弃——引擎加层时
 * 这里最坏是「归组名字还没起」，不会重演「数字被 compacted=false 盖掉」那次事故。
 */
export const COMPACTION_LAYER_ROLES = Object.freeze([
  Object.freeze({
    key: "wholeRoundFold",
    label: "整轮折叠",
    layerIds: Object.freeze(["slidingWindow", "foldStatistical", "foldLlm"]),
  }),
  Object.freeze({ key: "ttlResultFold", label: "逐条TTL削减", layerIds: Object.freeze(["ttl"]) }),
  Object.freeze({ key: "outputClamp", label: "输出钳制", layerIds: Object.freeze(["enforceSize"]) }),
  Object.freeze({ key: "foldFidelity", label: "折叠锚点", layerIds: Object.freeze(["anchors"]) }),
]);

/**
 * #313 追加（主 agent 实测定调）：汇总读的是**哪一个** `compactionStats`。
 *
 * 本层读的是 **run 返回值（或抛错载荷）上那份全量 `compactionStats`**（`buildDiagnostics` 从
 * `source.compactionStats` 取），不是 `<runId>.state.json` 里那份。后者写盘前要过
 * `normalizeCompactionStats(value, limit = 32)`（`src/compact/pipeline.js`）的 `value.slice(-limit)`
 * 截尾（调用点 `src/run-state.js` 的 `createDeterministicRunState`），>32 轮的 run 上「去 state.json 数削减账」
 * 会静默少算前面那些轮（截尾本身已另开 **issue #315**，本单不修它）。字段名毫无提示，所以终局面
 * 自带这一份源声明（`layers.source` / `layers.truncationNote`，并渲染进文本）。
 */
export const COMPACTION_STATS_SOURCE = "runResult.compactionStats";
export const COMPACTION_STATS_TRUNCATION_NOTE =
  "state.json 的 deterministic.compactionStats 经 normalizeCompactionStats(value, limit=32) 截尾到最后 32 条（issue #315）；>32 轮的 run 拿它当源会静默少算";

/**
 * 把每轮 `compactionStats[].layers` 折成**每个层 id** 的 triggered / tokensSaved 总和。
 *
 * 数据来源（不推算、不冒充）：引擎在 `createCompactionStat`（`src/compact/pipeline.js`）里给
 * 每条统计都补齐全层 id（`createEmptyCompactionLayers`（`src/compact/pipeline.js`）），
 * `src/loop/orchestrator.js` 的 5 处观测点用 `observeCompactionLayer`（`src/loop/orchestrator.js`）
 * 写 triggered/tokensSaved，并把 `layers` 带进每轮 `compactionStats` 条目。这里只做求和：
 * `roundsObserved` 是**带 layers 字段的条目数**（0 = 本次拿到的统计没有分层信息，渲染成 unknown），
 * `tokensBeforePeak` 是所有条目 `tokensBefore` 的最大值（评估轮数与峰值就是工单 R1 要的两个数）。
 *
 * @param {Array<{tokensBefore?:number, layers?:Record<string,{triggered?:number,tokensSaved?:number}>}>} compactionStats
 * @returns {{roundsObserved:number, tokensBeforePeak:number, byLayerId:Record<string,{triggered:number,tokensSaved:number}>, roles:Array<{key:string,label:string,layerIds:string[],triggered:number,tokensSaved:number}>, unattributed:Array<{layerId:string,triggered:number,tokensSaved:number}>}}
 */
export function summarizeCompactionLayers(compactionStats) {
  const stats = Array.isArray(compactionStats) ? compactionStats : [];
  /** @type {Record<string, {triggered:number, tokensSaved:number}>} */
  const byLayerId = {};
  let roundsObserved = 0;
  let tokensBeforePeak = 0;
  for (const stat of stats) {
    const before = Number.isFinite(stat?.tokensBefore) ? stat.tokensBefore : 0;
    if (before > tokensBeforePeak) tokensBeforePeak = before;
    const layers = stat?.layers;
    if (layers === null || typeof layers !== "object") continue;
    roundsObserved += 1;
    for (const [layerId, entry] of Object.entries(layers)) {
      const acc = byLayerId[layerId] ??= { triggered: 0, tokensSaved: 0 };
      const triggered = Number.isFinite(entry?.triggered) && entry.triggered > 0 ? entry.triggered : 0;
      const tokensSaved = Number.isFinite(entry?.tokensSaved) && entry.tokensSaved > 0
        ? Math.floor(entry.tokensSaved)
        : 0;
      acc.triggered += triggered;
      acc.tokensSaved += tokensSaved;
    }
  }
  const attributed = new Set();
  const roles = COMPACTION_LAYER_ROLES.map((role) => {
    const layerIds = role.layerIds.filter((layerId) => {
      const hit = byLayerId[layerId] !== undefined;
      if (hit) attributed.add(layerId);
      return hit;
    });
    return {
      key: role.key,
      label: role.label,
      layerIds,
      triggered: layerIds.reduce((total, id) => total + byLayerId[id].triggered, 0),
      tokensSaved: layerIds.reduce((total, id) => total + byLayerId[id].tokensSaved, 0),
    };
  });
  const unattributed = Object.entries(byLayerId)
    .filter(([layerId]) => !attributed.has(layerId))
    .map(([layerId, totals]) => ({ layerId, ...totals }));
  return { roundsObserved, tokensBeforePeak, byLayerId, roles, unattributed,
    // #313 追加：自报数据源（本层读 run 返回值那份全量统计；state.json 那份会截尾 32 条）。
    source: COMPACTION_STATS_SOURCE,
    truncationNote: COMPACTION_STATS_TRUNCATION_NOTE };
}

/**
 * 分层汇总 → 终局面文本（#313 R2：整轮折叠 / 逐条 TTL 削减 / 输出钳制**分别命名分别渲染**，
 * 不许只留一个 `compacted` 式的布尔比数）。
 *
 * @param {ReturnType<typeof summarizeCompactionLayers>} [summary]
 * @returns {string}
 */
export function formatCompactionLayerSummary(summary) {
  const layers = summary ?? summarizeCompactionLayers([]);
  if (!(layers.roundsObserved > 0)) {
    return "分层削减=unknown（拿到的 compactionStats 条目没有 layers 字段）"
      + `\n  ↳ 来源 ${layers.source ?? COMPACTION_STATS_SOURCE}（全量）`
      + `；若改读 state.json：${layers.truncationNote ?? COMPACTION_STATS_TRUNCATION_NOTE}`;
  }
  const rows = layers.roles.map((role) => `  ↳ ${role.label}（${role.layerIds.join("+") || "本 run 未出现"}）`
    + `=${role.triggered} 次/${role.tokensSaved} tok`);
  for (const extra of layers.unattributed ?? []) {
    rows.push(`  ↳ ${extra.layerId}（未归组层 id）=${extra.triggered} 次/${extra.tokensSaved} tok`);
  }
  rows.push(`  ↳ 分层观测=${layers.roundsObserved} 条评估条目，tokensBefore 峰值 ${layers.tokensBeforePeak}`);
  // #313 追加：自报数据源，并声明「若改读 state.json 则只覆盖最后 32 条」。
  rows.push(`  ↳ 来源 ${layers.source ?? COMPACTION_STATS_SOURCE}（全量）`
    + `；若改读 state.json：${layers.truncationNote ?? COMPACTION_STATS_TRUNCATION_NOTE}`);
  return rows.join("\n");
}

/**
 * #313 R3：notes 工具调用计数的**唯一来源**声明。
 *
 * 计数从引擎事件流的 `tool_use` 事件取（`emitEvent`（`src/loop/orchestrator.js`）发的
 * `{type:"tool_use", toolUse}`，本层 onEvent 本来就在收），**不是**从别的字段推算的。
 * 工具名真值来自引擎的 notes assembler：`createBuiltinNotesTools`（`src/tools/notes.js`）
 * 的定义表里只有 note_take / note_read / note_list / note_forget 四个：前两者动 store
 * （note_take 写入、note_forget 留撤销墓碑）算「写」，后两者只读算「读」。出现了第四个名字之外的
 * `note_*` 时它只进 `byName` 与 `unclassified`，**不**并进写/读两个数（宁可少算也不冒充）。
 */
export const NOTE_COUNT_SOURCE = "onEvent:tool_use";
const NOTE_WRITE_TOOLS = Object.freeze(["note_take", "note_forget"]);
const NOTE_READ_TOOLS = Object.freeze(["note_read", "note_list"]);

/** notes 计数的初始形状（observed=false ⇒ 渲染 unknown，不假称 0）。 */
export function createNoteCallTally() {
  return {
    observed: false,
    source: NOTE_COUNT_SOURCE,
    writes: 0,
    reads: 0,
    unclassified: 0,
    byName: /** @type {Record<string, number>} */ ({}),
  };
}

/**
 * 把一个引擎事件里的 `tool_use` 记进 notes 计数（非 note_* 工具、非 tool_use 事件一律忽略）。
 *
 * @param {ReturnType<typeof createNoteCallTally>} tally
 * @param {object} [event]
 */
export function countNoteToolEvent(tally, event) {
  if (tally === undefined || tally === null || event?.type !== "tool_use") return tally;
  const name = typeof event?.toolUse?.name === "string" ? event.toolUse.name : "";
  if (!name.startsWith("note_")) return tally;
  tally.byName[name] = (tally.byName[name] ?? 0) + 1;
  if (NOTE_WRITE_TOOLS.includes(name)) tally.writes += 1;
  else if (NOTE_READ_TOOLS.includes(name)) tally.reads += 1;
  else tally.unclassified += 1;
  return tally;
}

/** notes 计数 → 终局面文本；事件流没建立（run 没进循环）时如实渲染 unknown。 */
function formatNoteTally(notes) {
  if (notes === null || typeof notes !== "object" || notes.observed !== true) {
    return "notes 写/读=unknown/unknown（事件流未建立，没有 tool_use 可数）";
  }
  const names = Object.entries(notes.byName ?? {})
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  return `notes 写=${notes.writes ?? 0}/读=${notes.reads ?? 0}`
    + `${notes.unclassified ? `（未归类 note_* ${notes.unclassified}）` : ""}`
    + `${names === "" ? "" : ` ｜ ${names}`} ｜ 来源 ${notes.source ?? NOTE_COUNT_SOURCE}`;
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
      // ⚠ 这三个字段的**含义与取值一律不动**（#313 R2：判定语义不变，additive only）：
      //    compactedRounds 仍是「compacted===true 的条目数」，foldedRounds 仍是整轮折叠轮数总和。
      //    事故现场（69 次 TTL 削减 / 650,581 tok 被 `compacted:false` 盖掉）由下面新增的
      //    `layers` 承担，不是靠改这三个数。
      events: compactionStats.length,
      compactedRounds: compactionStats.filter((stat) => stat?.compacted === true).length,
      foldedRounds: compactionStats.reduce(
        (total, stat) => total + (Number.isFinite(stat?.foldedRounds) ? stat.foldedRounds : 0),
        0,
      ),
      // #313 R1：分层削减（每个真实层 id 的 triggered / tokensSaved）+ 评估条目数 + tokensBefore 峰值。
      layers: summarizeCompactionLayers(compactionStats),
    },
    // #313 R3：notes 写/读计数（来源：事件流 tool_use，见 `countNoteToolEvent` 的注释）与
    // model_metadata_missing **事件数**（来源：onEvent 收到的该类型事件，一条都不落）。
    notes: input.noteToolCalls ?? createNoteCallTally(),
    modelMetadataMissingEvents: {
      count: metadataEvents.length,
      observed: input.eventStreamObserved === true,
      source: `onEvent:${"model_metadata_missing"}`,
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
    // #314 R3：guard 的成本接在同一棵 diagnostics 树下（不另起顶层字段）。
    // 未开启时也要留一行如实的话：默认关 ⇒ 引擎给的 verification 只能是 `skipped`。
    finalGuard: input.finalGuardTally ?? {
      enabled: false,
      reason: "not requested（默认关；要核验就传 finalGuard: true）",
      calls: 0,
      elapsedMs: 0,
      reviseRounds: 0,
      source: "host finalGuard wrapper (erix-run-final-guard.js)",
    },
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
  // #313 R3：notes 写/读计数的累加器（来源：事件流 tool_use）与「事件流是否建立」标记：
  // 后者只为「没进循环 ⇒ 一个事件也没收」时把计数渲染成 unknown，而不是假称 0。
  const noteToolCalls = createNoteCallTally();
  let eventStreamObserved = false;
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
  // #266：两个都要活到 finally——装配发生在 try 里（`tools.notes`），而收口发生在公共收尾；
  // 异常路径的 payload 同样在 catch 里构造完才进 finally，所以收尾留痕只能靠这个引用补上。
  /** @type {any} */
  let notesAssembler;
  /** @type {object|undefined} */
  let terminalPayload;
  // #314：guard 计数器要活到 catch（装配期就失败的 run 也要在 diagnostics 里如实写
  // 「没开启」而不是缺一个字段），所以与 `notesAssembler` 同一层级声明。
  /** @type {object|undefined} */
  let finalGuardTally;
  let finalGuardVerify;
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

    // #314 R1/R3：只有显式开了 finalGuard 才建计数器与回调；默认关 ⇒ 下面透传链上一个键都不多。
    finalGuardTally = params.finalGuard === true
      ? createFinalGuardTally({ finalGuardTimeoutMs: params.finalGuardTimeoutMs })
      : undefined;
    finalGuardVerify = finalGuardTally === undefined
      ? undefined
      : createFinalGuardVerify({
        tally: finalGuardTally,
        now,
        // 测试缝：谓词可注入（与 deps.loadLib / deps.runLoop 同一条纪律），用来造「guard 很慢」
        // 这种真时钟下不好复现的场景（坑 ① 的回归用例靠它）。
        ...(deps.finalGuardInspect === undefined
          ? {}
          : { inspect: deps.finalGuardInspect }),
      });
    // 坑 ①：guard 的等待（最多 1 + 2 次 × `finalGuardTimeoutMs`）发生在 stop 判定之后，
    // 而引擎只在**轮边界**查截止线（`src/loop/orchestrator.js` 的 `remainingMs()`），
    // stop → guard 之间没有 deadline 检查。本层那根 `setTimeout` 硬 abort 若仍卡在
    // `params.timeoutMs`，就会把「钱已花、正要把 verified 交出来」的 run 掐死（宿主自己
    // 把核验抢掉）。以开启时把硬 abort 往后挪 `FINAL_GUARD_WORST_CASE_MS`（= 3 × 10s）；
    // run 自身的截止线（下发给引擎的 `timeoutMs`）**不动**，不拿它去掩盖额外开销。
    const guardHeadroomMs = finalGuardTally === undefined ? 0 : FINAL_GUARD_WORST_CASE_MS;

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
    // runId 先算：notes 的 scope（notesDir 下的 run/<scopeRef>/）与 transcript 同一身份。
    const runId = deps.runId ?? newRunId(now);
    context.runId = runId;
    const tools = deps.createAssembly
      ? deps.createAssembly({ lib: libIndex, cwd: params.cwd, runId, sessionDir: params.sessionDir, onToolEvent: (info) => {
        if (info?.phase === "start") progress(`→ ${info.name} ${preview(info.input)}`);
      } })
      : createInnerTools({ lib, cwd: params.cwd, runId, sessionDir: params.sessionDir });
    // #266：自定义装配（deps.createAssembly）可以根本没有 notes 字段，甚至返回 undefined——
    // 只做存在判定，后续 completeInnerNotes 对非函数一律跳过（不硬取属性，不会 TypeError）。
    notesAssembler = tools?.notes;

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
      // #314：开了 guard 就把「多给了多少硬 abort 余量」当面说出来，别让开销隐形。
      + (guardHeadroomMs > 0
        ? ` finalGuard=on（硬 abort 余量 +${guardHeadroomMs}ms，等待上限 ${params.finalGuardTimeoutMs}ms）`
        : "")
      + `（lib: ${context.libSource}）`,
    );
    if (params.sessionDir !== undefined) {
      progress(`落盘：transcript=${runPersistence.transcriptPath} judgeLog=${runPersistence.judgeLogPath}`);
    }

    timer = setTimeout(() => {
      timedOut = true;
      progress(`⏱ 超时 ${params.timeoutMs}ms，abort 内层 run`);
      controller.abort(new Error(`erix_run 超时（${params.timeoutMs}ms）`));
    }, params.timeoutMs + guardHeadroomMs);

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
    // issue #322：`judgeDoneAdvisory` 的下发体：没传就是空对象 ⇒ 下发给引擎的 reflection 里
    // 一个键也不多（不许替引擎造默认值，引擎缺省 false）。
    const advisoryRequested = params.judgeDoneAdvisory;
    const advisoryOption = advisoryRequested === undefined
      ? {}
      : { judgeDoneAdvisory: advisoryRequested };
    // diagnostics 里的那一份：requested = 宿主传了什么、enabled = 本次真下发了吗。
    const advisoryDiagnostic = advisoryRequested === undefined
      ? {}
      : {
        judgeDoneAdvisory: reflectionEnabled
          ? { requested: advisoryRequested, enabled: true }
          : {
            requested: advisoryRequested,
            enabled: false,
            reason: "judge 未开启（需 maxRounds ≥ 16 且未设 ERIX_NO_REFLECTION=1）⇒ 开关没下发，本次没生效",
          },
      };
    context.reflection = {
      enabled: reflectionEnabled,
      requested: requestedExtensions,
      // 生效上限：未传时是引擎缺省（ ENGINE_DEFAULT_MAX_EXTENSIONS，不是本层下发的默认值）。
      maxExtensions,
      // issue #322：评审意见回灌开关按既有 requested / enabled 同族口径透出：judge 闸门关着时
      // requested 是宿主传的值而 enabled=false ⇒「传了但没生效」看得见，不静默；没传时整个键
      // 不存在（而不是写个 false 冒充「宿主说了关」）。
      ...advisoryDiagnostic,
    };
    const reflection = reflectionEnabled
      ? {
        enabled: true,
        ...requestedExtensions,
        // issue #322：评审意见回灌开关，**与上面三个扩轮参数合并而不是覆盖**（两边各自展开，
        // 同传时四个键都在），且只在宿主真传了的时候出现（没传就不写这个键 ⇒ 引擎缺省 false）。
        // judge 闸门关着时 reflection 整块是 false、**不把这个开关塞进去**：judge 没跑就没有
        // 「中途判定目标已达成」这件事，下发一个永不被读的键只会让人以为它在生效。
        ...advisoryOption,
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
        : buildSystemPrompt({
          lib,
          cwd: params.cwd,
          tools: tools.tools,
          finalDraft: params.finalGuard === true,
        }),
      // #314 R1：没开启时这个键不存在（不是 `undefined`），以免被当成「传了但空」。
      ...(finalGuardVerify === undefined ? {} : { finalGuard: finalGuardVerify }),
      // 观察者必须自带防护：0.18 起引擎会隔离抛错并经 onObserverError 报告，但进度通道
      // （pi 的 onUpdate）在引擎直调路径上仍可能同步抛错。
      onEvent: (event) => {
        try {
          if (event?.type === "model_metadata_missing") {
            metadataEvents.push({ detail: event.detail });
          }
          // #313 R3：notes 写/读只从事件流的 tool_use 数（真来源，不拿 notesLifecycle 推算）。
          countNoteToolEvent(noteToolCalls, event);
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

    // 事件流从这一行起才存在（onEvent 只能收到 runToolLoop 里发的事）；装配期就报错的 run
    // 一个 tool_use 也没收过，notes 计数就是 unknown，而不是假装「0 次调用」。
    eventStreamObserved = true;
    noteToolCalls.observed = true;
    const result = await runLoop(options);
    context.elapsedMs = now() - startedAt;
    const payload = buildSuccessPayload(result, {
      timeout: timedOut,
      aborted: cancelled,
      observerErrors,
      metadataEvents,
      ledgerErrors,
      persistenceErrors,
      noteToolCalls,
      eventStreamObserved,
      finalGuardTally,
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
    terminalPayload = payload;
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
      noteToolCalls,
      eventStreamObserved,
      finalGuardTally,
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
    terminalPayload = payload;
    return payload;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (userSignal !== undefined && userSignal !== null) {
      userSignal.removeEventListener?.("abort", relayCancel);
    }
    // #266：两种终局都在这一处收口（成功 return / 抛错 / timeout 到点 / aborted / 内层抛错）。
    // 放 finally 而不是两个出口各写一遍，是为了让它们共用同一条收口路径。
    // 收尾失败只把留痕挂到已构造好的 payload.diagnostics.notesLifecycle，**不改** ok/termination/usage；
    // 选 diagnostics 而不是新增顶层字段或 finalText：它与其他宿主自查通道（observerErrors /
    // persistenceErrors / ledgerErrors）同类，且 finalText 是模型输出、不能塞运维噪声。
    try {
      const notesCompletion = await completeInnerNotes(notesAssembler, { progress });
      if (terminalPayload !== undefined && notesCompletion.attempted) {
        terminalPayload.diagnostics = {
          ...(terminalPayload.diagnostics ?? {}),
          notesLifecycle: notesCompletion,
        };
      }
    } catch (completionError) {
      // 兜底：收尾路径本身绝不允许改写已定局的返回值（finally 里的 await 也能抖住交付）。
      progress(`⚠ notes 收尾留痕失败：${preview(completionError?.message ?? completionError)}`);
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
      // #313 R2：这一对比数就是 `compactedRounds`/`events`，**不是**「压缩有没有生效」：
      // 整轮折叠 / 逐条 TTL 削减 / 输出钳制在下一段分开命名分别渲染（事故现场正是被它盖掉的）。
      + `（=compactedRounds/events，不等于「压缩没生效」）`
      + ` observerErrors=${diagnostics.observerErrors?.count ?? 0}`
      + ` persistenceErrors=${diagnostics.persistenceErrors?.count ?? 0}`
      + ` model_metadata_missing=${diagnostics.modelMetadataMissing ? "YES" : "no"}`
      // #313 R3：事件数只从 onEvent 收到的 model_metadata_missing 数（事件流未建立 ⇒ unknown）。
      + ` events=${diagnostics.modelMetadataMissingEvents?.observed === true
        ? diagnostics.modelMetadataMissingEvents?.count ?? 0
        : "unknown"}`
      // #266：notes 收口结果（只有真装配了 notes 才有这一行）；收尾失败不改终局，但要让宿主看见。
      + (diagnostics.notesLifecycle
        ? ` notesClosed=${diagnostics.notesLifecycle.completed ?? 0}`
          + `/errors=${diagnostics.notesLifecycle.errors?.length ?? 0}`
        : ""));
    if (diagnostics.modelMetadataMissing?.detail) {
      lines.push(`  ↳ ${diagnostics.modelMetadataMissing.detail}`);
    }
    // #313 R1/R2/R3：分层削减分别命名分别渲染，再补 notes 写/读计数（同一来源纪律：取不到就 unknown）。
    lines.push(formatCompactionLayerSummary(diagnostics.compaction?.layers));
    lines.push(`  ↳ ${formatNoteTally(diagnostics.notes)}`);
    // #314 R3：guard 的成本与结论（开启时是次数/累计等待/revise 轮数 + 本次 verification，
    // 没开启时是一行 disabled，不说「已通过」）。
    lines.push(`  ↳ ${summarizeFinalGuard(diagnostics.finalGuard)}`
      + ` ｜ verification=${payload?.verification?.status ?? "n/a"}`
      + `${payload?.verification?.reason ? `/${payload.verification.reason}` : ""}`);
    for (const failure of diagnostics.notesLifecycle?.errors ?? []) {
      lines.push(`  ↳ notes 收尾失败（${failure?.operation ?? "?"}）：${failure?.message ?? ""}（不影响终局）`);
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
  if (reflection?.judgeDoneAdvisory?.requested === true && reflection.judgeDoneAdvisory.enabled === false) {
    // 同上口径：传了 true 但 reflection 整块没下发 ⇒ 本次一条评审意见也不会回灌给模型。
    lines.push(`  ↳ judgeDoneAdvisory 未生效（judge 未开启，需 maxRounds ≥ 16 或去掉 ERIX_NO_REFLECTION）`
      + `：传了 true，但本次不会有任何评审意见回灌给模型`);
  }
  if (payload?.error?.message) {
    lines.push(`[error] ${payload.error.code ?? payload.error.name ?? "Error"}: ${payload.error.message}`);
  }
  return lines.join("\n");
}
