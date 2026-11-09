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

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

// #314：终稿核验（finalGuard）谓词层。本文件只做「开关 + 透传 + 成本计数 + 账本读口」，
// 谓词本体（四段存在性 / 基点溯源 / 派生结论提醒）在 erix-run-final-guard.js。
// issue #797：证据面从「只有存活窗口」换成「存活窗口 ∪ 账本」——账本的**读**在本文件
// （`readLedgerEvidence`：只有 store 这个注入端口，谓词层依旧不读盘），**匹配**在谓词层。
import {
  buildLedgerEvidence,
  createFinalGuardTally,
  createFinalGuardVerify,
  finalGuardWorstCaseMs,
  FINAL_DRAFT_PROMPT,
  FINAL_GUARD_TIMEOUT_MS,
  FINAL_GUARD_WORST_CASE_MS,
  honestVerificationReason,
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
/**
 * issue #391 R1：`deliverablePaths` 的条数上限（宿主侧**前置**挡，不等引擎 `TypeError`）。
 *
 * 真值在引擎（`src/loop/deliverables.js` 的 `DELIVERABLES_LIMIT = 20`）。本文件**不能**静态 import
 * 它：这一层是扩展侧的纯逻辑层，库根目录由 `ERIX_AGENT_LIB` 决定、可能是另一份安装的副本，
 * 装载期硬依赖会把「库没装好」变成「扩展加载不了」。所以这里存一份值 + 一条对账用例
 * （`test/examples/erix-run-core.test.js` 拿它与引擎常量逐字比），漂了当场红。
 */
export const DELIVERABLE_PATHS_LIMIT = 20;
/** #207 R1：下发给引擎 `reflection:{…}` 的扩轮参数名单（也是 diagnostics 里 `requested` 的键）。 */
export const EXTENSION_PARAM_NAMES = Object.freeze(["maxExtensions", "maxRoundsCap", "extensionStep"]);
/**
 * `resume` 参数接受的两种**文件坐标**（#207 R2）：`status.json`（异步面落盘的那份状态）与
 * transcript（账本本体 `<sessionDir>/<runId>.jsonl`）。扩展名是判别键，所以只认这两个。
 */
export const RESUME_PATH_EXTENSIONS = Object.freeze([".json", ".jsonl"]);
export const RESUME_STATUS_EXTENSION = ".json";
export const RESUME_TRANSCRIPT_EXTENSION = ".jsonl";
/**
 * 终局「不能续跑」的两种**具体**原因（#207 R2）。`resumable` 不再是常量：它是「盘上有没有可续跑的
 * 账本」这条事实（见 `resumeFactsOf`），所以两种不成立的情形必须各自说清，不拿一句「不可续跑」糊住。
 */
export const RESUME_REASON_MEMORY = "没有可续跑的账本：这次 run 没传 sessionDir / transcript（纯内存 store，进程退出即丢）";
export const RESUME_REASON_NO_TRANSCRIPT = "没有可续跑的账本：transcript 没写出来（装配期就失败 / 落盘失败），artifacts.transcriptPath 为 null";
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

/**
 * 展开 `~` 前缀。**只认正斜杠 `~/`**——与库内文件工具的 `expandHomePath`
 * （`src/tools/file-tools.js`；CLI 的文件工具五件套也走它）同一条口径：
 *
 *   - `~`     → `home`
 *   - `~/x`   → `<home>/x`
 *   - `~\x`   → **原样返回**（不猜「Windows 风格分隔符」：POSIX 下反斜杠是合法文件名字符）
 *   - `~x`    → **原样返回**（未知用户前缀，不猜）
 *
 * 为什么 #194 改的是这一侧：库侧（`erix-agent/tools`）是宿主可见契约，且 CLI 自己就 import 它，
 * 改库 = 给所有宿主换语义；本文件是示例扩展，只影响 `erix_run` 一条通道。同口径由
 * `test/examples/erix-run-core.test.js` 拿**真库函数**（`expandHomePath`）逐一相等钉住。
 *
 * @param {unknown} value
 * @param {{home?:string}} [options]
 * @returns {string}
 */
export function expandUserPath(value, { home = homedir() } = {}) {
  const raw = String(value ?? "");
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.resolve(home, raw.slice(2));
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
 * #207 R2：`resume` 在场时 `task` 与 `cwd` 都可省（续跑可以不带新任务；工作目录可以由账本坐标里的
 * `status.json.cwd` 提供）。`resume` 的**形状**在这里校（字符串 / 绝对路径 / 只认 .json 与 .jsonl），
 * 坐标的**存在性**在 `resolveResumeTarget` 里校（要读盘）。
 *
 * @param {{task?:unknown, cwd?:unknown, maxRounds?:unknown, strategy?:unknown, timeoutMs?:unknown, model?:unknown,
 *   sessionDir?:unknown, transcript?:unknown, maxExtensions?:unknown, maxRoundsCap?:unknown, extensionStep?:unknown,
 *   judgeDoneAdvisory?:unknown, finalGuard?:unknown, finalGuardTimeoutMs?:unknown,
 *   requireDeliverable?:unknown, deliverablePaths?:unknown, resume?:unknown}} raw
 * @param {{home?:string}} [options]
 * @returns {{task:string, cwd?:string, maxRounds:number, strategy?:string, timeoutMs:number, model?:string,
 *   sessionDir?:string, maxExtensions?:number, maxRoundsCap?:number, extensionStep?:number,
 *   judgeDoneAdvisory?:boolean, finalGuard?:boolean, finalGuardTimeoutMs?:number,
 *   requireDeliverable?:boolean, deliverablePaths?:string[], resume?:object}}
 */
export function parseRunParams(raw = {}, { home = homedir() } = {}) {
  // #207 R2：resume 先解析——它决定 `task` / `cwd` 的必填性（续跑可以不带新任务、也可以沿用账本里的
  // 工作目录），所以它的形状校验必须早于这两个字段。
  const resumeSpec = parseResumeSpec(raw, { home });

  const task = textOf(raw?.task).trim();
  if (task === "" && resumeSpec === undefined) {
    throw new ErixRunError("bad_params", "task 必填且不能是空字符串");
  }

  const rawCwd = textOf(raw?.cwd).trim();
  let cwd;
  if (rawCwd === "") {
    // 续跑时 cwd 可以省：账本坐标是 `status.json` 的话里面有原始 `cwd`（见 `resolveResumeTarget`），
    // 解析在 `runErixRun` 里做（要读盘）。不带 resume 时仍是硬必填。
    if (resumeSpec === undefined) throw new ErixRunError("bad_params", "cwd 必填（绝对路径）");
  } else {
    cwd = expandUserPath(rawCwd, { home });
    if (!path.isAbsolute(cwd)) {
      throw new ErixRunError(
        "bad_params",
        `cwd 必须是绝对路径，收到 ${JSON.stringify(rawCwd)}（相对路径会随 pi 的工作目录漂移）`,
      );
    }
    if (!existsSync(cwd)) {
      throw new ErixRunError("bad_cwd", `cwd 不存在：${cwd}`);
    }
  }

  /** @type {Record<string, unknown>} */
  const params = {
    task,
    ...(cwd === undefined ? {} : { cwd }),
    maxRounds: positiveInt(raw?.maxRounds, DEFAULT_MAX_ROUNDS, {
      min: 1, max: MAX_MAX_ROUNDS, name: "maxRounds",
    }),
    timeoutMs: positiveInt(raw?.timeoutMs, DEFAULT_TIMEOUT_MS, {
      min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS, name: "timeoutMs",
    }),
    ...(resumeSpec === undefined ? {} : { resume: resumeSpec }),
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

  // issue #391 R5：交付物判据开关，**默认关**。形状照 `finalGuard`（只认真布尔，只保留 true）。
  // 这里**只给命名判据**，不开放「宿主自定义 check 函数」入口：跨扩展边界传函数不安全
  // （pi 的扩展装载/序列化面不可控，`details` 与 `structured_output` 更是要求纯数据），
  // 所以判据本体由 `bin/final-guard.js` 的 `createDeliverableChecks()` 提供，宿主只能选「用不用」。
  const requireDeliverableRaw = raw?.requireDeliverable;
  if (requireDeliverableRaw !== undefined && requireDeliverableRaw !== null && requireDeliverableRaw !== "") {
    if (typeof requireDeliverableRaw !== "boolean") {
      throw new ErixRunError(
        "bad_params",
        `requireDeliverable 只能是 true | false，收到 ${JSON.stringify(requireDeliverableRaw)}`,
      );
    }
    if (requireDeliverableRaw) params.requireDeliverable = true;
  }
  // 与 CLI 逐字同口径（#391 R2）：判据是拦 guard `accept` 的闸门，引擎只在 `finalGuard` 存在时
  // 才核它 ⇒ 没有 `finalGuard: true` 时交付物判据是**静默空转**，必须显式失败
  // （不替宿主自动开 guard：那会改掉「不传 finalGuard ⇒ verification 恒 skipped」这条承诺）。
  //
  // issue #391 R1：**命名**交付物判据（`deliverablePaths`）——与上面那个布尔开关是**两个不同的问题**，
  // 两个都要留：
  //   · `requireDeliverable: true` 问「**你说过要写的东西**还在盘上吗」（读 `fileWrites`）。模型什么都不
  //     声明时集合为空、`every()` 恒真 ⇒ 一次工具都没调的 run 也能 `verified`（#391 回帖实测）。
  //   · `deliverablePaths: [...]` 问「**这次任务要求的这些文件**在盘上吗」（不读模型说了什么）。
  //     「必须交付 report.md」只能靠这一条。
  // 相对路径不在本层 join：判据收到的是引擎 payload 里的 `facts.cwd`（= 本层下发的 `params.cwd`），
  // 由 `bin/final-guard.js` 的 `createNamedDeliverableChecks()` 在那里 `resolve`。
  const deliverablePathsRaw = raw?.deliverablePaths;
  if (deliverablePathsRaw !== undefined && deliverablePathsRaw !== null && deliverablePathsRaw !== "") {
    if (!Array.isArray(deliverablePathsRaw)) {
      throw new ErixRunError(
        "bad_params",
        `deliverablePaths 必须是字符串数组，收到 ${JSON.stringify(deliverablePathsRaw)}`,
      );
    }
    if (deliverablePathsRaw.length === 0) {
      // 空集合的判据集合恒真——那正是 #391 要杀的真空通过形状，不能当「没声明」静默吞掉。
      throw new ErixRunError(
        "bad_params",
        "deliverablePaths 传了就必须至少一条：空清单等于没有判据（恒真），"
        + "要「声明过的写路径都在盘上」请用 requireDeliverable: true",
      );
    }
    if (deliverablePathsRaw.length > DELIVERABLE_PATHS_LIMIT) {
      throw new ErixRunError(
        "bad_params",
        `deliverablePaths 最多 ${DELIVERABLE_PATHS_LIMIT} 条（引擎 DELIVERABLES_LIMIT），`
        + `收到 ${deliverablePathsRaw.length} 条`,
      );
    }
    const seen = new Set();
    const paths = [];
    for (const [index, entry] of deliverablePathsRaw.entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new ErixRunError(
          "bad_params",
          `deliverablePaths[${index}] 必须是非空字符串，收到 ${JSON.stringify(entry)}`,
        );
      }
      // 引擎要求 `deliverables[].name` 在同一 run 内唯一，而这里的 name 就是路径本身
      // ⇒ 重复路径必须在宿主侧就挡（否则到引擎才吃一个 TypeError）。
      if (seen.has(entry)) {
        throw new ErixRunError(
          "bad_params",
          `deliverablePaths[${index}] 重复：${JSON.stringify(entry)}（判据名 = 路径，引擎要求唯一）`,
        );
      }
      seen.add(entry);
      paths.push(entry);
    }
    params.deliverablePaths = paths;
  }
  const declaredCriteria = (params.requireDeliverable === true ? 1 : 0)
    + (params.deliverablePaths?.length ?? 0);
  if (declaredCriteria > 0 && params.finalGuard !== true) {
    throw new ErixRunError(
      "bad_params",
      "交付物判据（requireDeliverable / deliverablePaths）只在 finalGuard: true 时有意义："
      + "判据是拦 guard accept 的闸门，没有 guard 就没有闸门（单独开等于什么都不核）",
    );
  }
  // 条数上限是**合计**的：布尔那条也占一个 `deliverables` 槽位（引擎看的是数组长度）。
  if (declaredCriteria > DELIVERABLE_PATHS_LIMIT) {
    throw new ErixRunError(
      "bad_params",
      `交付物判据合计最多 ${DELIVERABLE_PATHS_LIMIT} 条（引擎 DELIVERABLES_LIMIT），`
      + `收到 ${declaredCriteria} 条（requireDeliverable ${params.requireDeliverable === true ? 1 : 0} + deliverablePaths ${params.deliverablePaths?.length ?? 0}）`,
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
 * `resume` 参数的**形状**解析（#207 R2）：只回答「宿主想续哪个 run、用哪种坐标说的」，不碰 fs。
 *
 * 接受三种形态（其余一律 `bad_params`，不静默当「没传」）：
 *   1. `status.json` 的绝对路径 → `{kind:"status", path}`（异步面的 status.json 里带着 `runId` /
 *      `sessionDir` / `cwd`，所以这是**最完整**的一种坐标）；
 *   2. transcript（`<sessionDir>/<runId>.jsonl`）的绝对路径 → `{kind:"transcript", path}`；
 *   3. 裸 `runId` 字符串 → `{kind:"runId", runId}`（**必须**同时给 `sessionDir` / `transcript`，
 *      否则 `resolveResumeTarget` 无处找账本）。
 *
 * 判别顺序是「先看是不是路径（带分隔符或 .json/.jsonl 后缀）」，所以 `runId` 里恰好带点（
 * `a.b.c`）但没后缀时仍当 `runId`；而 `notes.txt` 这种**看着像路径**又不以 `.json/.jsonl`
 * 结尾的会被当场拒掉（不当 `runId` 静默建一个新 run）。
 *
 * @param {any} raw 工具入参
 * @param {{home:string}} options
 * @returns {{raw:string, kind:"runId"|"status"|"transcript", runId?:string, path?:string}|undefined}
 */
export function parseResumeSpec(raw, { home }) {
  const value = raw?.resume;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ErixRunError(
      "bad_params",
      `resume 只能是字符串（runId，或 status.json / transcript 的绝对路径），收到 ${JSON.stringify(value)}`,
    );
  }
  const spec = value.trim();
  if (spec === "") {
    throw new ErixRunError("bad_params", "resume 传了值就不能是空白字符串（不传 = 不续跑，起一次全新 run）");
  }
  const expanded = expandUserPath(spec, { home });
  const looksLikePath = expanded.includes("/") || /\.(?:json|jsonl)$/iu.test(expanded);
  if (!looksLikePath) {
    if (/\s/u.test(spec)) {
      throw new ErixRunError("bad_params", `resume 的 runId 不能含空白字符，收到 ${JSON.stringify(spec)}`);
    }
    return { raw: spec, kind: "runId", runId: spec };
  }
  if (!path.isAbsolute(expanded)) {
    throw new ErixRunError(
      "bad_params",
      `resume 的路径必须是绝对路径，收到 ${JSON.stringify(spec)}（相对路径会随 pi 的工作目录漂移）`,
    );
  }
  const ext = path.extname(expanded).toLowerCase();
  if (!RESUME_PATH_EXTENSIONS.includes(ext)) {
    throw new ErixRunError(
      "bad_params",
      `resume 路径只认 ${RESUME_PATH_EXTENSIONS.join(" / ")}（status.json 或 transcript），收到 ${JSON.stringify(spec)}`,
    );
  }
  return {
    raw: spec,
    kind: ext === RESUME_TRANSCRIPT_EXTENSION ? "transcript" : "status",
    path: expanded,
  };
}

/**
 * `resume` 坐标 → 引擎能用的那一组身份（#207 R2）：`{runId, sessionDir, transcriptPath, cwd?}`。
 *
 * 引擎的续跑入口是 **`config.run.resume: true` + `runId` + 装着账本的 store**（`restoreResume`
 * 只认账本），所以本函数只负责「把宿主给的坐标变成那三件东西」，并在任一件不成立时**明确报错**：
 *   - 坐标文件不存在 / 账本是空的 ⇒ `resume_not_found`（不是 `bad_params`：形状是对的，是那个 run 不存）
 *   - 形状对但**无法反推**（`run-h-*` 哈希化文件名、`runId` 却没给 `sessionDir`）⇒ `bad_params`
 *
 * `cwd` 只在坐标自带时返回（`status.json` 有 `cwd`）；没有就由调用方决定（要么宿主传了，要么报错）。
 *
 * @param {{spec:object, sessionDir?:string, home?:string,
 *   exists?:(p:string)=>boolean, readFile?:(p:string, enc:"utf8")=>string, sizeOf?:(p:string)=>number}} input
 * @returns {{kind:string, handle:string, runId:string, sessionDir:string, transcriptPath:string, cwd?:string}}
 */
export function resolveResumeTarget({
  spec, sessionDir, home = homedir(), exists = existsSync, readFile = readFileSync, sizeOf,
} = {}) {
  if (spec === undefined || spec === null || typeof spec !== "object") {
    throw new ErixRunError("bad_params", "resolveResumeTarget 需要 parseResumeSpec 的产物");
  }
  const sizeOfFile = sizeOf ?? ((file) => statSync(file).size);
  /** 账本必须真在盘上且**不是空的**：空账本引擎会以「resume: 无可恢复记录」把真正的终局原因盖掉。 */
  const assertLedger = ({ runId, dir, handle }) => {
    const transcriptPath = artifactPaths({ sessionDir: dir, runId }).transcriptPath;
    if (!exists(transcriptPath)) {
      throw new ErixRunError(
        "resume_not_found",
        `resume 指向的 run 没有账本：${transcriptPath} 不存在`
        + `（runId=${JSON.stringify(runId)} sessionDir=${JSON.stringify(dir)}；`
        + "是不是 runId 与 sessionDir 不配对，或那次 run 没传 sessionDir？）",
      );
    }
    if (sizeOfFile(transcriptPath) === 0) {
      throw new ErixRunError(
        "resume_not_found",
        `resume 指向的 run 账本是空的：${transcriptPath}（一条记录都没落盘 ⇒ 没有可续跑的现场）`,
      );
    }
    return { handle, runId, sessionDir: dir, transcriptPath };
  };

  if (spec.kind === "transcript") {
    if (!exists(spec.path)) {
      throw new ErixRunError("resume_not_found", `resume 指向的 transcript 不存在：${spec.path}`);
    }
    const dir = path.dirname(spec.path);
    const runId = path.basename(spec.path, RESUME_TRANSCRIPT_EXTENSION);
    if (runId.startsWith(HASHED_RUN_ID_PREFIX)) {
      // 引擎的 `safeRunId()` 把过长的 id 哈希成 `run-h-*`，从文件名反推不回原 id；硬猜就是
      // 用一个错的 runId 去读一个错的账本。此时只能走 status.json 或 runId+sessionDir 两种坐标。
      throw new ErixRunError(
        "bad_params",
        `resume 不能只给哈希化的 transcript 文件名（${path.basename(spec.path)}）：`
        + "该形态反推不回 runId，请改传 status.json 的绝对路径，或传 runId + sessionDir",
      );
    }
    return { kind: spec.kind, ...assertLedger({ runId, dir, handle: spec.path }) };
  }

  if (spec.kind === "status") {
    if (!exists(spec.path)) {
      throw new ErixRunError("resume_not_found", `resume 指向的 status.json 不存在：${spec.path}`);
    }
    let status;
    try {
      status = JSON.parse(readFile(spec.path, "utf8"));
    } catch (error) {
      throw new ErixRunError(
        "bad_params",
        `resume 指向的 status.json 不是合法 JSON：${spec.path}（${error?.message ?? String(error)}）`,
        { cause: error },
      );
    }
    const runId = typeof status?.runId === "string" && status.runId !== "" ? status.runId : undefined;
    if (runId === undefined) {
      throw new ErixRunError(
        "bad_params",
        `resume 指向的 status.json 里没有 runId 字段：${spec.path}（这不是 erix_run 写的 status.json？）`,
      );
    }
    // 布局只由 `artifactPaths` 定：`<sessionDir>/outputs/<safeRunId>/status.json` ⇒ 往上两层就是
    // sessionDir。status.json 自带 sessionDir 时以它为准（宿主可能搬过目录）。
    const dir = typeof status.sessionDir === "string" && status.sessionDir !== ""
      ? status.sessionDir
      : path.resolve(path.dirname(spec.path), "..", "..");
    const target = assertLedger({ runId, dir, handle: spec.path });
    return {
      kind: spec.kind,
      ...target,
      ...(typeof status.cwd === "string" && status.cwd !== "" ? { cwd: status.cwd } : {}),
    };
  }

  // kind === "runId"：必须能从别处拿到 sessionDir。
  const dir = typeof sessionDir === "string" && sessionDir !== "" ? sessionDir : undefined;
  if (dir === undefined) {
    throw new ErixRunError(
      "bad_params",
      `resume 传 runId（${JSON.stringify(spec.runId)}）时必须同时给 sessionDir（或 transcript），`
      + "否则本层无处找它的账本；也可以直接传 status.json / transcript 的绝对路径",
    );
  }
  const target = assertLedger({ runId: spec.runId, dir, handle: spec.runId });
  return { kind: spec.kind, ...target };
}

/**
 * 终局的「能不能续跑」事实（#207 R2）——取代了旧的 `RESUMABLE = false` 常量。
 *
 * 判据只有一条：**盘上有没有可续跑的账本**，也就是 `artifacts.transcriptPath` 此刻是不是一个真路径。
 * 没有就写明是哪一种没有（没传 sessionDir / 落盘失败），不拿一句「不可续跑」糊住。
 *
 * `handle` 就是**原样回传给 `resume` 参数**的那个字面值（这里是 transcript 的绝对路径）；
 * `resumedFrom` 只在本次 run 本身是续跑时非 null。
 *
 * @param {{runId?:string, sessionDir?:string|null, artifacts?:object, resumedFrom?:object|null}} input
 * @returns {{resumable:boolean, handle:string|null, handleKind:string|null, runId:string|null,
 *   sessionDir:string|null, transcriptPath:string|null, reason?:string, resumedFrom:object|null}}
 */
export function resumeFactsOf({ runId, sessionDir, artifacts, resumedFrom } = {}) {
  const transcriptPath = typeof artifacts?.transcriptPath === "string" ? artifacts.transcriptPath : null;
  const resumable = transcriptPath !== null;
  const dir = typeof sessionDir === "string" && sessionDir !== "" ? sessionDir : null;
  return {
    resumable,
    handle: resumable ? transcriptPath : null,
    handleKind: resumable ? "transcript" : null,
    runId: typeof runId === "string" && runId !== "" ? runId : null,
    sessionDir: dir,
    transcriptPath,
    ...(resumable ? {} : { reason: dir === null ? RESUME_REASON_MEMORY : RESUME_REASON_NO_TRANSCRIPT }),
    resumedFrom: resumedFrom ?? null,
  };
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
 *   binToolsEntry: string, binFinalGuard?: any, binFinalGuardEntry?: string, source: string,
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
    // #391 R5：交付物判据（`createDeliverableChecks`）住在 `bin/final-guard.js`。它是**按需**依赖：
    // 只有 `requireDeliverable: true` 的 run 才会读它，装载期失败只记一条（不拖累默认路径），
    // 真要用时由 runErixRun 明确报 `lib_missing`。为什么复用 bin/ 那一份而不是在本层重写：
    // 判据口径只能有一份（`fileWrites` 原始路径 + `existsSync`），第二份实现就是第二种口径。
    const binFinalGuardEntry = libRoot === undefined
      ? undefined
      : path.join(libRoot, "bin", "final-guard.js");
    let binFinalGuard;
    if (binFinalGuardEntry !== undefined && exists(binFinalGuardEntry)) {
      try {
        binFinalGuard = await importModule(pathToFileURL(binFinalGuardEntry).href);
      } catch (error) {
        failures.push(`${binFinalGuardEntry}: ${textOf(error)}`);
        binFinalGuard = undefined;
      }
    }

    return {
      index,
      binTools,
      binFinalGuard,
      libEntry: candidate.libEntry,
      libRoot,
      binToolsEntry,
      binFinalGuardEntry,
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
 * ⚠ **已升进 `src/config/slot-provider.js`（#406 B2-a），本份是 B2-b 要删的遗留件，勿在此演进。**
 * 新代码一律用包根导出的那份（`import { loadModelSlot } from "erix-agent"`）；本份只为了让
 * `erix_run` 在 B2-a 落地后仍能跑（同一批要动 `src/loop/orchestrator.js`，被 #430 占着）。
 * 两份的总差异**是五条，不是一条**（合并前评审实测，`src/config/slot-provider.js` 文件头也列了同一份）：
 *   1. **首参**：本份 `loadModelSlot({lib, …})` / `createProviderForSlot(lib, slot, …)` 带 `lib`（扩展动态加载的产物），
 *      `src/` 那份直接 import，没有这个首参；
 *   2. **`ERIX_CONFIG_PATH`**：本份的 `defaultConfigPath` **不读**它（只在错误文案里承诺），`src/` 那份真读；
 *   3. **`warn`（M7）**：本份的 `createProviderForSlot` 没有 `warn` 注入口，`src/` 那份有（接到 `createRequestInjection`）；
 *   4. **错误载体**：本份每条错误都带 `ErixRunError(code, msg, {detail})`（`detail` 恒为字符串），`src/`
 *      那份**只有解析失败**那一条带附加字段 `{cause: <Error>}`，其余三条（`config_missing` / 非对象 /
 *      缺必填字段）是裸 `KitError(code, msg)`；`code` 字面值相同，且本份多一个 `lib_missing` 分支；
 *   5. **`metadataMissing` 的键存在性**：本份**总是**带这个键（可能是 `undefined`），`src/` 那份缺元数据时才出现。
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

/**
 * provider 构造：relay 是 OpenAI 协议，直接用 createOpenAIProvider（src/providers/openai.js 的具名参数）。
 *
 * ⚠ **已升进 `src/config/slot-provider.js`（#406 B2-a），本份是 B2-b 要删的遗留件，勿在此演进。**
 * 差异（与 `loadModelSlot` 同一份清单的第 1 / 3 条）：本份首参是 `lib`；本份**没有** `warn` 注入口
 * （M7 只落在 `src/` 那份），所以经本份构造的 provider 接不住注入冲突的 warn。
 */
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
 * **issue #498 S6：内部映射搬到两个命名空间**（母单 #495）。本函数以前把 27 个键平铺着递给
 * `runToolLoop`；现在**数据**走 `config.*`、**回调**走 `capabilities.*`，顶层只剩引擎的端口对象 /
 * 信号 / 错误出口。⚠ 对 pi 的**工具参数面**零变化：`erix-run.ts` 的 schema（`task` / `cwd` /
 * `model` / `maxRounds` / `strategy` / `timeoutMs` / `sessionDir` / `transcript` / `maxExtensions` /
 * `maxRoundsCap` / `extensionStep` / `async` / `quiet` / `action` / `runId` / `finalGuard` /
 * `requireDeliverable` / `deliverablePaths` / `judgeDoneAdvisory` / `finalGuardTimeoutMs` /
 * `resume`）一个字节
 * 没动，返回的四件套（`finalText` / `termination` / `verification` / `artifacts`）也不变——变的只有
 * **这一层递给引擎的形状**。逐条去向（叶子名 = 顶层键名，别名表在引擎侧，本层不手抄第二套）：
 *
 * | 扁平键（旧） | 新规位 |
 * | --- | --- |
 * | `system` / `initialUserMessage` / `tools` / `wrapup` | `config.input.*` |
 * | `maxRounds` / `stream` / `runId` / `cwd` / `completion` | `config.run.*` |
 * | `resume`（#207 R2：续跑开关；只在宿主传了 `resume` 参数时出现，默认连键都没有） | `config.run.resume` |
 * | `reflection`（数据半边：`enabled` / 扩轮三参数 / `judgeDoneAdvisory`） | `config.run.reflection` |
 * | `timeoutMs` / `retry` | `config.timing.*` |
 * | `context`（内置策略名是数据，不是端口实现） | `config.folding.context` |
 * | `finalGuardTimeoutMs` | `config.guard.finalGuardTimeoutMs` |
 * | `task` / `modelMetadata` | `config.metadata.*` |
 * | `onEvent` / `onObserverError` / `onPersistenceError` / `onJudge` / `finalGuard` | `capabilities.hooks.*` |
 * | `reflection.onReflection`（回调半边） | `capabilities.hooks.onReflection`（嵌套槽位：引擎解析回
 *   `reflection.onReflection`，容器赢） |
 * | `deliverables`（`requireDeliverable` / `deliverablePaths` 编译出的 `{name, check}`） |
 *   `capabilities.checks.deliverables` |
 *
 * **留在顶层**的只有 `provider` / `executeTool` / `store` / `signal` / `diagnostics`：它们是引擎的
 * 适配器端口对象 / 中止信号 / 错误出口，`capabilities.ports` 明确**不接**适配器端口对象
 * （只有 `sleepImpl` / `judgeProvider` / `strategy` 三个「壳内实现」在那一组里，见
 * `src/loop/capabilities-namespace.js` 的文件头）。所以这五项既没有 `config.*` 也没有
 * `capabilities.*` 规位，搬它们才是发明第三种类别。
 *
 * **一个旋钮只写一侧**：同一个键既写扁平又写 `config.<group>.<leaf>`（值不同）⇒ 引擎记一条
 * `config_override_conflict`。本层因此**不留扁平兼容键**（`examples/pi-extension/erix-run-config-migration.test.mjs`
 * 逐键断言「数据在 `config.*`、回调在 `capabilities.*`、顶层没有同名扁平键」）。
 *
 * @param {{
 *   params: {task:string, cwd:string, maxRounds:number, timeoutMs:number, strategy?:string,
 *     resume?:object,
 *     finalGuardTimeoutMs?:number},
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
 *   // #314 R1：终稿核验回调。引擎要的就是一个函数（载荷 `{finalText, findings, messages,
 *   //   round, rounds, signal, termination}`，见 `src/loop/termination.js` 的 `callFinalGuard`）。
 *   // **不传就是不透传** ⇒ 引擎侧 verification 保持 `skipped`。
 *   finalGuard?: (payload:object)=>Promise<{action:string, message?:string, reason?:string}>,
 *   // #391 R5：宿主声明的交付物判据（**已组装好的** `[{ name, check }]`）。本层只做「传 / 不传」，
 *   //   判据本体由 `bin/final-guard.js` 的 `createDeliverableChecks()` 给（不在这里手抄第二份口径）。
 *   //   不传 ⇒ options 上连这个键都没有（引擎「未声明 ⇒ 逐字不变」的回归锚靠的就是这个形状）。
 *   deliverables?: {name:string, check:Function}[],
 * }} input
 * @returns {object} runToolLoop 的 options 对象（`config` / `capabilities` 两个容器 + 端口对象）
 */
export function buildLoopOptions(input) {
  const {
    params, slot, provider, tools, store, signal, runId,
    system, onEvent, onObserverError, onPersistenceError, onJudge, diagnostics,
    reflection, finalGuard, deliverables, nextUserTurn,
  } = input;

  // #498 S6：`reflection` 是「一块数据 + 一个回调」的复合旋钮，按判据一分为二：
  //   数据半边（`enabled` / 扩轮三参数 / `judgeDoneAdvisory`）⇒ `config.run.reflection`；
  //   回调半边（`onReflection`）⇒ `capabilities.hooks.onReflection`（引擎的嵌套槽位把它解析回
  //   `reflection.onReflection`）。**只搬函数值**：非函数留在数据半边，引擎的语义相仍按老文案
  //   报 `reflection.onReflection must be a function (or omitted)`，不把「配错型」变成静默丢弃。
  const reflectionIsObject = reflection !== null && typeof reflection === "object";
  const onReflection = reflectionIsObject && typeof reflection.onReflection === "function"
    ? reflection.onReflection
    : undefined;
  let reflectionData = reflection;
  if (onReflection !== undefined) {
    const { onReflection: _dropped, ...rest } = reflection;
    reflectionData = rest;
  }

  /** @type {Record<string, Function>} */
  const hooks = {};
  if (onEvent !== undefined) hooks.onEvent = onEvent;
  if (onObserverError !== undefined) hooks.onObserverError = onObserverError;
  if (onPersistenceError !== undefined) hooks.onPersistenceError = onPersistenceError;
  if (onJudge !== undefined) hooks.onJudge = onJudge;
  // #314 R1 / #498 S4b：`finalGuard` 的值必须是函数 ⇒ 按判据它是行为载体，规位在能力面。
  if (finalGuard !== undefined) hooks.finalGuard = finalGuard;
  if (onReflection !== undefined) hooks.onReflection = onReflection;
  // issue #753 C2：轮边界转向钩子（引擎面 C1 的槽位 `capabilities.hooks.nextUserTurn`）。
  // **只有调用方递了才装**（判据 2「没人 steer ⇒ 一个钩子都不装」）：没这个键时引擎的
  // `steerMetrics` 是 `undefined` ⇒ 既不数 `offered` 也不发 `diagnostics.steer`，options 对象
  // 逐字不多一个字节（同 `finalGuard` 的「默认路径不回归」约束）。回调是**行为载体**，
  // 按 #498 S6 的划分规位在能力面，不新增 `config.*` 叶（C1 也刻意没加）。
  if (nextUserTurn !== undefined) hooks.nextUserTurn = nextUserTurn;

  /** @type {Record<string, unknown>} */
  const config = {
    input: {
      system: system ?? buildSystemPrompt({ lib: { binTools: {} }, cwd: params.cwd, tools: tools.tools }),
      // #207 R2：续跑可以不带新任务（纯接着跑），那时**不写这个键**——空串会被引擎当成一条
      // 空正文用户轮（非 resume 路径上真的会发出去），少一个键比发一条空消息安全。
      ...(params.task === "" ? {} : { initialUserMessage: params.task }),
      // 对话型宿主（pi 是人机协同侧）：收尾 JSON 信封会污染交回给 pi 的终稿文本，关掉。
      wrapup: false,
    },
    run: {
      maxRounds: params.maxRounds,
      stream: false,
      runId,
      // #207 R2：引擎的续跑开关。规位是 `config.run.resume`（扁平 `resume` 已在 #498 S3 A19
      // 退役），读侧是 `src/loop/resume-manager.js` 的 `restoreResume`（它只认 `ctx.resume`
      // + `ctx.runId` + 装着账本的 `ctx.store`）。不传 ⇒ 连这个键都没有（默认行为逐字不变）。
      ...(params.resume === undefined ? {} : { resume: true }),
      // #391 R1：`cwd` 是引擎的**纯透传**选项（只进 finalGuard / deliverables 的事实载荷）。
      // 本层早已有 `params.cwd`（绝对路径 + 存在性都已验），漏的只是往下传：不传的话
      // 升级指南 §9 的判据会拼成 `"undefined/report.md"`，每次 accept 都被判 `deliverables_failed`。
      cwd: params.cwd,
      completion: { signals: [...COMPLETION_SIGNALS], maxNoToolRounds: 3 },
      ...(reflectionData === undefined ? {} : { reflection: reflectionData }),
    },
    timing: {
      // run 级截止线（引擎在轮边界上按剩余时间收尾）；硬 abort 由 runErixRun 的定时器负责。
      timeoutMs: params.timeoutMs,
      retry: { attempts: 2 },
    },
    // 契约「#1.3 硬注意」/task 选项：判官/收尾的简报取显式 task，多轮宿主必须显式传。
    metadata: { task: params.task },
    // #167：内置策略名是**数据**（引擎在启动期实例化），所以走配置面的 `folding.context`。
    ...(params.strategy === undefined ? {} : { folding: { context: { strategy: params.strategy } } }),
    // #314 R1：只有调用方给了 `finalGuard` 才下发它的超时（默认关时 options 对象上**一个字节都不多**，
    // 这正是 C6「默认路径不回归」的硬约束）。`finalGuardTimeoutMs` 必须**显式给**：
    // 引擎默认 30_000 × 最多 3 次等待（1 + 2 次 revise）会撑爆宿主自己那根硬 abort（坑 ①）。
    ...(finalGuard === undefined
      ? {}
      : { guard: { finalGuardTimeoutMs: params.finalGuardTimeoutMs ?? FINAL_GUARD_TIMEOUT_MS } }),
  };

  // #182：两个预算字段必须成对给（引擎跨候选不合并），缺任何一个都不如不给。
  if (Number.isSafeInteger(slot.contextWindowTokens) && Number.isSafeInteger(slot.maxOutputTokens)) {
    config.metadata.modelMetadata = {
      contextWindowTokens: slot.contextWindowTokens,
      maxOutputTokens: slot.maxOutputTokens,
    };
  }

  /** @type {Record<string, unknown>} */
  const capabilities = {};
  if (Object.keys(hooks).length > 0) capabilities.hooks = hooks;
  // #391 R5 / #498 S4b：交付物判据的规位是能力面（每一条都带函数 `check`）；默认关时连这一组都没有。
  if (deliverables !== undefined) capabilities.checks = { deliverables };

  return {
    // 端口对象 / 中止信号 / 错误出口：**留在顶层**（`capabilities.ports` 不接适配器端口对象）。
    provider,
    executeTool: tools.executeTool,
    // issue #527：`tools` 是永久顶层面（第三站），与 provider / executeTool / store 同类。
    tools: tools.tools,
    signal,
    store,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    config,
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
  };
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
 * - `resumable`：**事实而不是能力声明**（#207 R2）——盘上有可续跑的账本才是 `true`，
 *   即 `input.resume.resumable`（见 `resumeFactsOf`）。坐标全貌在 `diagnostics.resume`。
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
    // #207 R2：**事实**而不是能力声明 —— 盘上有可续跑的账本才是 true（见 `resumeFactsOf`）。
    // 坐标（handle / runId / sessionDir）走 `diagnostics.resume`（同一份事实的可机读全貌）。
    resumable: input?.resume?.resumable === true,
  };
}

/**
 * issue #797：读本次 run 的**账本**并折成谓词能用的证据面。只在**开了 `finalGuard`** 时被调，
 * 且调用点在 guard 回调内部（不是装配期，也不是 run 之前）。
 *
 * 读口优先级（#714）：`store.loadRawRows`（原始行，每条 `tool_result` 逐字在账）→ 回落
 * `store.load`（折叠后的行）→ 两个都没有 = **没有账本**。三种失败形态（探针缺席 / 读抛错 /
 * 行超限截断）都**只记录事实、不改行为**：`ledgerComplete:false` ⇒ 谓词不许下 `not_in_ledger`。
 *
 * 本函数只递一个**注入端口**（store），不 `import node:fs`——谓词层依旧零依赖不读盘，读盘
 * 发生在真 store 里（文件 store 或内存 store）。
 *
 * **输出一律是 `buildLedgerEvidence` 重算出来的那份**（R2 F1）：包括注入读口返「成形证据对象」时
 * 也只取它的 `rows` 与 `source`，元数据全部重建；注入函数自己抛错被吞成 `source:"injected:error"`
 * 的不完整证据（R2 F2）——这两个口子都是为了让「不完整 ⇒ 不下 `not_in_ledger`」没法被调用方饶过。
 *
 * @param {{store?:object, runId?:string, deps?:object}} input
 * @returns {Promise<object>} `buildLedgerEvidence` 的输出（**永不抛**：读账本失败不能把 guard 带死）
 */
export async function readLedgerEvidence({ store, runId, deps = {} } = {}) {
  const rowLimit = Number.isSafeInteger(deps.finalGuardLedgerRowLimit) && deps.finalGuardLedgerRowLimit > 0
    ? deps.finalGuardLedgerRowLimit
    : undefined;
  // 注入缝：`deps.finalGuardLedger` 是函数时**替掉默认读口**（返行数组，或返一个「成形」的证据对象）。
  if (typeof deps.finalGuardLedger === "function") {
    let given;
    try {
      given = await deps.finalGuardLedger({ runId, store });
    } catch (error) {
      // R2 F2：注入函数抛错 / 拒绝不能逃出读口（上面那句 JSDoc 承诺「永不抛」）。
      // 它与「store 探针抛错」同格：返一份**不完整**的证据，行为逐字回到今天的 `max_retries`。
      return buildLedgerEvidence(undefined, {
        source: "injected:error",
        readError: textOf(error?.message ?? error),
        ...(rowLimit === undefined ? {} : { rowLimit }),
      });
    }
    // R2 F1：**不论注入的是行数组还是成形证据对象，一律重建**。成形对象只许贡献两样东西：
    // 它的 `rows`（当那是数组时）与它的 `source` 字符串（缺省 `"injected"`）。
    // `ledgerComplete` / `truncated` / `foldCeiling` / `foldRows` 这些元数据**不读注入值**——
    // 否则调用方递 `{rows:[], truncated:true, ledgerComplete:true}` 就能把「账本不完整 ⇒ 不下结论」
    // 这条安全纪律饶过去，`rowLimit` 也会一起被绕过（copilot 审计的 F1，主会话复现探针①②）。
    const preformed = given !== null && typeof given === "object" && !Array.isArray(given) ? given : undefined;
    const rows = Array.isArray(given)
      ? given
      : (Array.isArray(preformed?.rows) ? preformed.rows : undefined);
    return buildLedgerEvidence(rows, {
      source: typeof preformed?.source === "string" && preformed.source !== "" ? preformed.source : "injected",
      ...(rowLimit === undefined ? {} : { rowLimit }),
    });
  }
  if (store === null || typeof store !== "object") {
    return buildLedgerEvidence(undefined, { source: "no_store" });
  }
  const probe = typeof store.loadRawRows === "function"
    ? "loadRawRows"
    : (typeof store.load === "function" ? "load" : "no_probe");
  if (probe === "no_probe") {
    // 「宿主没给探针」与「账本真的空」是两件事（#714 已把这条口径定死），必须分得开。
    return buildLedgerEvidence(undefined, {
      source: "no_probe",
      readError: "store 既不提供 loadRawRows 也不提供 load ⇒ 本次没有账本可读",
      ...(rowLimit === undefined ? {} : { rowLimit }),
    });
  }
  try {
    const rows = await store[probe](runId);
    return buildLedgerEvidence(rows, { source: probe, ...(rowLimit === undefined ? {} : { rowLimit }) });
  } catch (error) {
    return buildLedgerEvidence(undefined, {
      source: `${probe}:error`,
      readError: textOf(error?.message ?? error),
      ...(rowLimit === undefined ? {} : { rowLimit }),
    });
  }
}

/**
 * issue #797 判据 ①：把终局 `verification` 按诚实原因改写一次（判据本体在谓词层的
 * `honestVerificationReason`，这里只做载荷装配）。
 *
 * 只在判到 `not_in_ledger` 时产出**新对象**，且只动 `reason` 一个键（`status` / `guardVerdict` /
 * `metrics` 原样），引擎原值留在 `engineReason` 供审计；其余情形**逐字递回引擎那份对象**。
 */
function honestVerification(verification, tally) {
  const rewritten = honestVerificationReason({ verification, tally });
  if (rewritten === null) return verification ?? undefined;
  return { ...verification, reason: rewritten, engineReason: verification.reason };
}

/**
 * 正常返回 → 结构化载荷。
 *
 * @param {any} result runToolLoop 的返回值
 * @param {{timeout:boolean, aborted:boolean, observerErrors:any[], metadataEvents:any[],
 *   ledgerErrors:any[], context:object, artifacts?:object, extensionCount?:number,
 *   maxExtensions?:number, resume?:object}} input
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
    // issue #797 判据 ①：开了 guard 且**触发过压缩**的 run，不得含糊地因 `max_retries` 落到
    // unverified；基点真的不在账本里就报 `not_in_ledger`（只改 `reason`，引擎原值留在
    // `engineReason`）。不成立时 `honestVerification` 原样递回引擎那份对象（载荷逐字回到今天）。
    verification: honestVerification(result?.verification, input.finalGuardTally),
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
 * `normalizeCompactionStats`（`src/compact/pipeline.js`）的 `value.slice(-limit)` 截尾（limit 的
 * 唯一声明是同一文件的 `COMPACTION_STATS_STATE_LIMIT`，调用点 `src/run-state.js` 的
 * `createDeterministicRunState`），长 run 上「去 state.json 数削减账」会静默少算前面那些轮。
 * 所以终局面自带这一份源声明（`layers.source` / `layers.truncationNote`，并渲染进文本）。
 */
export const COMPACTION_STATS_SOURCE = "runResult.compactionStats";

/**
 * #373：`layers.truncationNote` 的文案**不再硬编码条数**，一律念 `<runId>.state.json` 自报的
 * `deterministic.compactionStatsWindow`（#315 起该字段就一直在文件里，只是没人念）。
 *
 * 病根（#313 遗留）：老提示把窗口大小**写死在文案里**（当时是 state 文件体积约束的那个常数，
 * 换个上限就得改文案）。可 state 文件里有**两条**截断路径——
 * `createDeterministicRunState`（`src/run-state.js`）按 `COMPACTION_STATS_STATE_LIMIT`
 * （`src/compact/pipeline.js`）切一次；序列化超限时 `compactStateForSize`（`src/run-state.js`）
 * 再切一次（更小的 limit）。提示与真相分叉 ⇒ 宿主照提示数 `length`，在第二条路径下会把
 * 「压缩只跑了 limit 次」当成事实。现在数字**全部来自文件**：
 *   - 文件里有窗口账 ⇒ 引用它的 limit / dropped / total（本文件不写任何条数常数）；
 *   - 文件在、但没有这个字段（#315 之前落盘的老档）⇒ 明说「没有自报窗口，条数不可当压缩次数用」；
 *   - 连文件都读不到（纯内存 run / 落盘失败）⇒ 明说没有窗口账可引用。
 */
export const COMPACTION_STATS_TRUNCATION_NOTE =
  "该文件没有自报 deterministic.compactionStatsWindow，里面的条数不可当压缩次数用";

/** 连 `<runId>.state.json` 都读不到时的文案（纯内存 run / 落盘失败）：没有窗口账可引用。 */
export const COMPACTION_STATS_NO_STATE_NOTE =
  "本次 run 没有可读的 state.json（未给 sessionDir 或落盘失败），没有窗口账可引用，条数不可当压缩次数用";

/**
 * `state.json` 里的窗口账 → `{ limit, dropped, total }`；形状不对 / 缺席一律 `null`（不猜）。
 *
 * @param {any} runState 解析后的 `<runId>.state.json`（`readRunStateFile` 的返回值）
 * @returns {{limit:number, dropped:number, total:number}|null}
 */
export function compactionStatsWindowOf(runState) {
  const window = runState?.deterministic?.compactionStatsWindow;
  if (window === null || typeof window !== "object" || Array.isArray(window)) return null;
  const { limit, dropped, total } = /** @type {any} */ (window);
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  if (!Number.isSafeInteger(dropped) || dropped < 0) return null;
  if (!Number.isSafeInteger(total) || total < 0) return null;
  return { limit, dropped, total };
}

/**
 * 读 `<sessionDir>/<safeRunId>.state.json`（#373：提示文案的唯一真值来源）。
 *
 * 文件名与引擎 `src/store/file.js` 的 `statePath()` 同式（`<safeRunId>.state.json`，`safeRunId`
 * 由本文件的 `safeRunIdForFile` 逐字复刻）。读不到 / 坏档一律 `null`：提示层只是旁证，不该因为
 * 「读不动一份旁证」把一次已经跑完的 run 弄红。
 *
 * @param {{sessionDir?:string, runId?:string, readFile?:(path:string, encoding:"utf8")=>string}} [input]
 * @returns {any|null} 解析后的 state 对象；读不到即 `null`
 */
export function readRunStateFile({ sessionDir, runId, readFile = readFileSync } = {}) {
  if (typeof sessionDir !== "string" || sessionDir === "") return null;
  if (typeof runId !== "string" || runId === "") return null;
  const statePath = path.join(sessionDir, `${safeRunIdForFile(runId)}.state.json`);
  try {
    return JSON.parse(readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 窗口账 → 提示文案（#373）：数字一律来自**文件**，本文件不写死任何条数。
 *
 * @param {any} runState 解析后的 `<runId>.state.json`（`null` = 没读到文件）
 * @returns {string}
 */
export function compactionStatsTruncationNote(runState) {
  const window = compactionStatsWindowOf(runState);
  if (window !== null) {
    const { limit, dropped, total } = window;
    const head = `该文件自报 deterministic.compactionStatsWindow：limit=${limit}、dropped=${dropped}、total=${total}`;
    return dropped > 0
      ? `${head}——只留最后 ${limit} 条，拿它数削减账会少算 ${dropped} 条`
      : `${head}——没有丢条目，这份窗口就是全量`;
  }
  if (runState === null || runState === undefined) return COMPACTION_STATS_NO_STATE_NOTE;
  return COMPACTION_STATS_TRUNCATION_NOTE;
}

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
 * #373：`truncationNote` / `compactionStatsWindow` 来自**文件**——调用方把解析后的
 * `<runId>.state.json`（`readRunStateFile` 的返回值，没有就 `null`）当第二参数传进来；
 * 不传时文案就如实说「没有窗口账可引用」，绝不回退到写死的条数。
 *
 * @param {Array<{tokensBefore?:number, layers?:Record<string,{triggered?:number,tokensSaved?:number}>}>} compactionStats
 * @param {any} [runState] 解析后的 `<runId>.state.json`（`null`/不传 = 没读到文件）
 * @returns {{roundsObserved:number, tokensBeforePeak:number, byLayerId:Record<string,{triggered:number,tokensSaved:number}>, roles:Array<{key:string,label:string,layerIds:string[],triggered:number,tokensSaved:number}>, unattributed:Array<{layerId:string,triggered:number,tokensSaved:number}>, source:string, compactionStatsWindow:{limit:number,dropped:number,total:number}|null, truncationNote:string}}
 */
export function summarizeCompactionLayers(compactionStats, runState) {
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
    // #313 追加：自报数据源（本层读 run 返回值那份全量统计）。
    source: COMPACTION_STATS_SOURCE,
    // #373：窗口账与文案都从文件里读（没有就 `null` / 如实说没得引用），不写死条数。
    compactionStatsWindow: compactionStatsWindowOf(runState),
    truncationNote: compactionStatsTruncationNote(runState) };
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
      + `；若改读 state.json：${layers.truncationNote ?? compactionStatsTruncationNote(null)}`;
  }
  const rows = layers.roles.map((role) => `  ↳ ${role.label}（${role.layerIds.join("+") || "本 run 未出现"}）`
    + `=${role.triggered} 次/${role.tokensSaved} tok`);
  for (const extra of layers.unattributed ?? []) {
    rows.push(`  ↳ ${extra.layerId}（未归组层 id）=${extra.triggered} 次/${extra.tokensSaved} tok`);
  }
  rows.push(`  ↳ 分层观测=${layers.roundsObserved} 条评估条目，tokensBefore 峰值 ${layers.tokensBeforePeak}`);
  // #313 追加 / #373：自报数据源，并给出**文件里**的窗口账（有就引它的数字，没有就说没有）。
  rows.push(`  ↳ 来源 ${layers.source ?? COMPACTION_STATS_SOURCE}（全量）`
    + `；若改读 state.json：${layers.truncationNote ?? compactionStatsTruncationNote(null)}`);
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
  // #373：窗口账从 `<sessionDir>/<runId>.state.json` **读文件**（不写死条数）。
  // `input.runState` 是显式覆盖口（测试 / 宿主已经读过那份文件时不必再读一遍）；
  // 读不到文件（纯内存 run / 落盘失败）就是 `null`，文案会如实说没有窗口账可引用。
  const runState = input.runState !== undefined
    ? input.runState
    : readRunStateFile({ sessionDir: context.sessionDir, runId: context.runId });
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
      // #373：第二个参数是那份 state 文件（决定 `truncationNote` 引哪几个数字）。
      layers: summarizeCompactionLayers(compactionStats, runState),
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
    // #207 R2：**续跑坐标**（与顶层 `resumable` 同一份事实的可机读全貌）。这里同时是异步面
    // `status.json` 的来源（`jobView` 整块投 `diagnostics`）⇒ 盘上那唯一残留里就带着
    // 「拿什么参数可以接着跑」：`handle` 原样回传给 `resume` 即可，`runId` / `sessionDir`
    // 是另一种等价写法（`resume: runId` + `sessionDir`）。
    resume: input.resume ?? resumeFactsOf({
      runId: context.runId,
      sessionDir: context.sessionDir,
      artifacts: input.artifacts,
      resumedFrom: context.resumedFrom,
    }),
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
  // issue #753 C2：内层 run 的**转向账目原样透传**（引擎 C1 的 `result.diagnostics.steer` =
  // `{offered,injected,rejected,lastRound}`）。判据：只有**装了钩子**的 run 才有这一格，没装的人
  // 看到的形状逐字不变（additive）。透传而不重算：`offered` 是引擎问了几次轮边界，本层数不出来。
  // 走 `diagnostics` 而不是顶层字段：异步面的 `jobView` 整块投 `diagnostics` ⇒ 同步面与
  // `action:"status"`/`"result"`/`status.json` 自动同形（判据 4）。
  if (source?.diagnostics?.steer !== undefined && typeof source.diagnostics.steer === "object") {
    diagnostics.steer = { ...source.diagnostics.steer };
  }
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
 *   runId?:string,             // 显式 runId（异步层派工时给；与 resume 指向的 runId 必须一致）
 *   resumeTarget?:object,      // 已解析的续跑坐标（异步层先解一次，免得两边各解一份）
 *   readFile?:Function, exists?:Function, sizeOf?:Function,  // resolveResumeTarget 的注入缝
 *   finalGuardInspect?:(payload:object)=>object|Promise<object>,  // #314：guard 谓词注入缝
 *   // #797：证据面的**账本回落**。缺省 = 开（`store.loadRawRows` → 回落 `store.load`）；
 *   // `false` = 关掉回落（只留 `ctx.messages`，即修前口径，反向证第二半靠它）；
 *   // 函数 = 替掉默认读口（返行数组或已成形的证据面）。只在开了 finalGuard 时生效。
 *   finalGuardLedger?:false|((input:{runId?:string, store?:object})=>any|Promise<any>),
 *   finalGuardLedgerRowLimit?:number,  // #797：证据面行上限（缺省 LEDGER_EVIDENCE_ROW_LIMIT；截断格用小值）
 * }} [deps]
 */
export async function runErixRun(rawParams = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const onProgress = deps.onProgress;
  // issue #753 C2：轮边界转向钩子（由 `erix-run-jobs.js` 在**异步派工**时递进来）。
  // 只认函数：没递（同步面 / 没收件箱）就是 `undefined`，`buildLoopOptions` 连那个键都不写。
  const nextUserTurn = typeof deps.nextUserTurn === "function" ? deps.nextUserTurn : undefined;

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
    // #207 R2：续跑坐标先落地（要读盘）——它决定 `runId` / `sessionDir` / `cwd` 三件东西，
    // 所以必须在装配任何端口之前定下来。坐标不成立就在这里报 `resume_not_found` / `bad_params`，
    // **绝不静默起一个全新 run**（那会让宿主以为在续跑旧会话，实际上又花了一整单钱）。
    const resumeTarget = deps.resumeTarget ?? (params.resume === undefined
      ? undefined
      : resolveResumeTarget({
        spec: params.resume,
        sessionDir: params.sessionDir,
        home,
        ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }),
        ...(deps.exists === undefined ? {} : { exists: deps.exists }),
        ...(deps.sizeOf === undefined ? {} : { sizeOf: deps.sizeOf }),
      }));
    if (resumeTarget !== undefined) {
      // 工作目录：宿主传了就用宿主的；没传就用坐标里带的（只有 status.json 有 `cwd`）。
      // 两处都没有 ⇒ 明确报错，不猜一个（猜错就是在一个不相干的目录里继续跑旧账本）。
      if (params.cwd === undefined) {
        if (typeof resumeTarget.cwd !== "string" || resumeTarget.cwd === "") {
          throw new ErixRunError(
            "bad_params",
            `resume 续跑 ${resumeTarget.runId} 需要 cwd：这个坐标里没有原始工作目录`
            + "（transcript / runId 坐标不带 cwd）⇒ 请显式传 cwd",
          );
        }
        params.cwd = resumeTarget.cwd;
      }
      // 续跑必须沿用原 `sessionDir`：账本在那边，换一个目录就是另一个 run。
      params.sessionDir = resumeTarget.sessionDir;
      context.resumedFrom = {
        handle: resumeTarget.handle,
        kind: resumeTarget.kind,
        runId: resumeTarget.runId,
        sessionDir: resumeTarget.sessionDir,
        transcriptPath: resumeTarget.transcriptPath,
      };
    }
    context.cwd = params.cwd;
    context.strategy = params.strategy;
    context.maxRounds = params.maxRounds;
    context.timeoutMs = params.timeoutMs;

    // #314 R1/R3：只有显式开了 finalGuard 才建计数器与回调；默认关 ⇒ 下面透传链上一个键都不多。
    // #391 R5：交付物判据条数（0..N）。它同时决定「最坏开销」与 tally 里的说明——
    // 判据跑在 guard **之前**且共享同一个 `finalGuardTimeoutMs`，所以每次 attempt 的上限要
    // 加上「判据条数 × 该上限」（见 `finalGuardWorstCaseMs`）。
    // #391 R1：布尔开关与命名清单是两种语义，条数相加（两个都给了就两条都核）。
    const deliverableCriteria = (params.requireDeliverable === true ? 1 : 0)
      + (params.deliverablePaths?.length ?? 0);
    finalGuardTally = params.finalGuard === true
      ? createFinalGuardTally({
        finalGuardTimeoutMs: params.finalGuardTimeoutMs,
        deliverableCriteria,
      })
      : undefined;
    // issue #797：guard 回调要读账本，而 store / runId 要到下面才存；读口只能拿引用，
    // 不能拿值 ⇒ 这个 holder 与 `finalGuardVerify` 同生命周期（只在 guard 被调时读）。
    const ledgerTarget = { store: undefined, runId: undefined };
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
        // issue #797：证据面 = 存活窗口 ∪ 账本。**只在开了 finalGuard 时建这条管道**（默认关 ⇒
        // options 面一个字节都不许多）。`deps.finalGuardLedger`：缺省 = 开；`false` = 关掉账本
        // 回落（只留 `ctx.messages`，即修前口径）；函数 = 替掉默认读口。
        // 读账本发生在 **guard 回调内部**，而 store 要到下面才装配 ⇒ 这里递一个**迟到绑定**的
        // 读口：它只在 run 里被调，那时 `ledgerTarget` 两个字段都已赋上（见下方 `ledgerTarget.store = …`）。
        ...(finalGuardTally === undefined || deps.finalGuardLedger === false
          ? {}
          : { readLedger: (payload) => readLedgerEvidence({ store: ledgerTarget.store, runId: payload?.runId ?? ledgerTarget.runId, deps }) }),
      });
    // 坑 ①：guard 的等待（最多 1 + 2 次 × `finalGuardTimeoutMs`）发生在 stop 判定之后，
    // 而引擎只在**轮边界**查截止线（`src/loop/orchestrator.js` 的 `remainingMs()`），
    // stop → guard 之间没有 deadline 检查。本层那根 `setTimeout` 硬 abort 若仍卡在
    // `params.timeoutMs`，就会把「钱已花、正要把 verified 交出来」的 run 掐死（宿主自己
    // 把核验抢掉）。以开启时把硬 abort 往后挪 `finalGuardWorstCaseMs(...)`（未声明判据 = 3 × 10s，
    // 声明 1 条判据 = 3 × (10s + 10s)）；run 自身的截止线（下发给引擎的 `timeoutMs`）**不动**，
    // 不拿它去掩盖额外开销。
    const guardHeadroomMs = finalGuardTally === undefined
      ? 0
      : finalGuardWorstCaseMs({ deliverableCriteria });

    const lib = deps.loadLib
      ? await deps.loadLib()
      : await loadErixAgent({ env, home });
    const libIndex = lib?.index ?? lib;
    context.libSource = lib.source ?? lib.libEntry;

    // #391 R5/R1：声明了任何一条交付物判据时才去拿判据本体。装载面缺这一份就**当场报错**
    // （`lib_missing`），不静默降级成「没有判据」——那正是 #391 要杀的静默空转。
    // 两个工厂都住 `bin/final-guard.js`：布尔那条是 `createDeliverableChecks`（读 `fileWrites`），
    // 命名那条是 `createNamedDeliverableChecks`（读宿主声明的清单）。本层**不**手抄第二份口径。
    let deliverableChecks;
    if (deliverableCriteria > 0) {
      const binFinalGuard = lib?.binFinalGuard;
      const missingFactory = (name) => {
        if (typeof binFinalGuard?.[name] === "function") return undefined;
        return new ErixRunError(
          "lib_missing",
          `交付物判据需要 <libRoot>/bin/final-guard.js 导出的 ${name}`
          + `（${lib?.binFinalGuardEntry ?? "包根目录未解析"}）。`
          + "本层不手抄第二份判据口径：要么把它装上，要么别声明交付物",
        );
      };
      const checks = [];
      if (params.requireDeliverable === true) {
        const error = missingFactory("createDeliverableChecks");
        if (error !== undefined) throw error;
        checks.push(...binFinalGuard.createDeliverableChecks());
      }
      if (params.deliverablePaths !== undefined) {
        const error = missingFactory("createNamedDeliverableChecks");
        if (error !== undefined) throw error;
        checks.push(...binFinalGuard.createNamedDeliverableChecks(params.deliverablePaths));
      }
      deliverableChecks = checks;
    }

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
    // #207 R2：续跑**必须沿用原 runId**（账本、judge.log、status.json 都按它命名）。显式给了
    // 一个不同的 runId 就是两个身份撞在一起，当场报错而不默默盖掉其中一个。
    if (resumeTarget !== undefined && deps.runId !== undefined && deps.runId !== resumeTarget.runId) {
      throw new ErixRunError(
        "bad_params",
        `resume 指向 run ${resumeTarget.runId}，与显式 runId ${deps.runId} 冲突`
        + "（续跑只能沿用原 runId：账本与产物都按它命名）",
      );
    }
    const runId = resumeTarget?.runId ?? deps.runId ?? newRunId(now);
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
    // issue #797：账本证据面的读口到这才真能读到东西（上面只建了回调）。
    ledgerTarget.store = store;
    ledgerTarget.runId = runId;
    const appendJudgeLogRecord = runPersistence.appendJudgeLogRecord;
    context.sessionDir = params.sessionDir;
    persistence = {
      transcriptPath: runPersistence.transcriptPath,
      judgeLogPath: runPersistence.judgeLogPath,
    };

    // #207 R2：续跑时把**这次的新任务**当成一个用户轮写进账本（与 CLI `-c` 同一条通道：
    // 引擎公共导出 `appendUserTurn`，round 复用账本最大轮号，dedupKey 走 `:input:` 命名空间）。
    // 不自己手搭记录：round 推导 / 去重 / 记录形状都是引擎的契约，抄一份就是两份口径。
    if (resumeTarget !== undefined && params.task !== "") {
      const appendUserTurn = libIndex?.appendUserTurn;
      if (typeof appendUserTurn !== "function") {
        throw new ErixRunError(
          "lib_missing",
          "续跑要把本次新任务作为用户轮写进账本，需要 erix-agent 入口导出 appendUserTurn"
          + "（包根 src/index.js 已有；检查 ERIX_AGENT_LIB 指向的检出是否太旧）",
        );
      }
      await appendUserTurn(store, { key: runId, text: params.task });
      progress(`续跑：本次任务已作为用户轮追加到账本（runId=${runId}，round 复用账本最大轮号）`);
    }

    progress(
      `erix_run 启动：model=${context.model ?? "?"} cwd=${params.cwd} maxRounds=${params.maxRounds}`
      + ` strategy=${params.strategy ?? "（未配置，走引擎缺省）"} timeoutMs=${params.timeoutMs}`
      // #314：开了 guard 就把「多给了多少硬 abort 余量」当面说出来，别让开销隐形。
      + (guardHeadroomMs > 0
        ? ` finalGuard=on（硬 abort 余量 +${guardHeadroomMs}ms，等待上限 ${params.finalGuardTimeoutMs}ms）`
        : "")
      // #207 R2：续跑就把「从哪接着跑」当面说出来（宿主看进度就能分清「续跑」与「整单重跑」）。
      + (resumeTarget === undefined
        ? ""
        : ` resume=on（runId=${resumeTarget.runId} handle=${resumeTarget.handle}）`)
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
      // issue #753 C2：钩子只在**递了**时往下传（不递 ⇒ `buildLoopOptions` 不写 `hooks.nextUserTurn`，
      // 装配出来的 options 与改前逐字一致）。引擎在 `runToolLoop` 入口一次性捕获它，所以必须在
      // 装配时就在位（这也是钩子归 jobs 层长期持有、而不是「steer 到达时才装」的原因）。
      ...(nextUserTurn === undefined ? {} : { nextUserTurn }),
      // #391 R5/R1：交付物判据（默认关）。判据本体来自 `bin/final-guard.js` 的两个工厂
      // （`createDeliverableChecks` = 布尔那条，`createNamedDeliverableChecks` = 命名清单那条）
      // ——**复用 CLI 那一份**，本层不手抄第二份口径；宿主面只给命名开关 / 命名路径，
      // 不开放自定义 `check` 函数（跨扩展边界传函数不安全，理由见 README 参数表与契约）。
      ...(deliverableChecks === undefined ? {} : { deliverables: deliverableChecks }),
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
      // #207 R2：续跑坐标与「能不能续跑」的事实（旧版这里是一个恒 false 的常量）。
      resume: resumeFactsOf({
        runId: context.runId,
        sessionDir: context.sessionDir,
        artifacts: resolveArtifacts(persistence),
        resumedFrom: context.resumedFrom,
      }),
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
      resume: resumeFactsOf({
        runId: context.runId,
        sessionDir: context.sessionDir,
        artifacts: resolveArtifacts(persistence ?? {}),
        resumedFrom: context.resumedFrom,
      }),
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
    // issue #753 C2：转向账目（只有装了钩子的 run 才有这一行）。口径：`injected` 是真进了内层 run
    // 消息历史条数（不是「发了几条」），`rejected` 是抛错/返回非字符串（降级不致命）。
    if (diagnostics.steer !== undefined && diagnostics.steer !== null) {
      lines.push(`  ↳ steer：offered=${diagnostics.steer.offered ?? 0}`
        + ` injected=${diagnostics.steer.injected ?? 0}`
        + ` rejected=${diagnostics.steer.rejected ?? 0}`
        + ` lastRound=${diagnostics.steer.lastRound ?? "-"}`
        + `（来自内层 capabilities.hooks.nextUserTurn；injected 是真被当成一条 role:"user" 轮读进去的条数）`);
    }
    for (const failure of diagnostics.notesLifecycle?.errors ?? []) {
      lines.push(`  ↳ notes 收尾失败（${failure?.operation ?? "?"}）：${failure?.message ?? ""}（不影响终局）`);
    }
  }
  // #207 R4：把决策事实也给模型看（它才能自己决定「去读 transcript」还是「直接重跑」）。
  const artifacts = payload?.artifacts;
  // #207 R2：`resumable` 现在是**事实**（盘上有可续跑的账本）。true 时把 handle 与 cwd 一并给出去——
  // 模型只要把这两个字面值原样回传给 `resume` / `cwd` 就能接着跑（transcript 坐标本身不带工作目录，
  // 所以 cwd 必须跟 handle 一起给；status.json 坐标自带 cwd，那里可以省）；false 时说出**是哪一种没有**。
  const resume = payload?.diagnostics?.resume;
  lines.push(`[facts] transcript=${artifacts?.transcriptPath ?? "none"}`
    + ` judgeLog=${artifacts?.judgeLogPath ?? "none"}`
    + ` extensions=${payload?.extensionCount ?? 0}/${payload?.maxExtensions ?? 0}`
    + ` resumable=${payload?.resumable === true}`
    + (payload?.resumable === true
      ? `（要接着跑就传 resume=${JSON.stringify(resume?.handle ?? "")}`
        + ` cwd=${JSON.stringify(diagnostics?.cwd ?? "")}）`
      : `（${resume?.reason ?? "没有可续跑的账本"}）`)
    + (resume?.resumedFrom ? ` 本次是续跑（from=${resume.resumedFrom.handle}）` : ""));
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
