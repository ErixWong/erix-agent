import { KitError } from "../providers/errors.js";
import { computeBudget } from "../compact/budget.js";
import { createProviderSummarizer } from "../compact/provider-summarizer.js";
import { resolveCompactionStrategy } from "../compact/strategy-resolution.js";
import { createSlidingWindowStrategy } from "../compact/sliding-window.js";
import { mergeFoldNavigationRecords } from "../compact/fold-statistical.js";
import {
  countEstimateCharacters,
  estimateMessageTokens,
  estimateTokensFromCharacterCounts,
} from "../tokens.js";
import { groupIntoRounds } from "../messages/rounds.js";
import { decideRoundAction, decideWithEvaluation } from "../reflection/governor.js";
import { extractL0Facts, parseL1Summary } from "../reflection/l0.js";
import { tryParseWrapupJson, normalizeWrapupWithLlm } from "../reflection/wrapup.js";
import {
  buildJudgePrompt,
  buildTimeline,
  DEFAULT_WRITE_TOOL_NAMES,
  INTERCEPT_CONVERSATION_TOKENS,
  parseJudgeDecision,
  renderConversation,
} from "../reflection/judge.js";
import {
  createDeterministicRunState,
  renderRunState,
  upsertRunStateInMessages,
  withSemanticRunState,
} from "../run-state.js";
import {
  appendAssistantContent,
  blocksFor,
  hasSuccessfulToolResult,
  hasToolUse,
  hasToolUseInMessages,
  mergeToolResultsIntoMessages,
  normalizeMessages,
  textFromBlocks,
} from "./messages.js";
import {
  DEFAULT_REFLECTION_MIN_ROUNDS,
  WRAPUP_INSTRUCTION,
  isLikelyWelcomeResponse,
  parseReflectionDecision,
} from "./reflection.js";
import {
  resolveTaskBrief,
} from "./task-brief.js";
import {
  FINAL_GUARD_NON_CONTINUABLE_REASONS,
  FINAL_GUARD_TERMINATION_REASONS,
  annotateTermination,
  createTerminationManager,
  makeTermination,
  terminationDetailForError,
  terminationReasonForAction,
  withErrorCode,
  withTerminationPayload,
} from "./termination.js";
import { createErrorLedger } from "./error-ledger.js";
import {
  judgeRecordFields,
  resolveModelName,
  resolveRunModelName,
  runOutcomeRecord,
} from "./judge-record.js";
import {
  cloneState,
  isApiInputOverBudget,
  modelMetadataFor,
  normalizeToolNameSet,
  projectedApiInputTokens,
  safeTruncateMessages,
  toolContextFor,
  validateBudget,
} from "./budget.js";
import { abortError, defaultSleep, throwIfAborted } from "./abort.js";
import { callProvider as runProvider } from "./provider-runner.js";
import {
  createCompactionStat,
  createEmptyCompactionLayers,
  getCompactionFallbackChain,
  getCompactionLayer,
  getCompactionLayerForStrategy,
  observeCompactionLayer,
} from "../compact/pipeline.js";
import {
  TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT,
  TOOL_RESULT_TTL_DEFAULT,
} from "./tool-result-ttl.js";
import { createRunSnapshotExecutor } from "./run-snapshot-executor.js";
import { restoreResume } from "./resume-manager.js";
import { assemblyPortOptions } from "../assembly.js";
import {
  collectLoopCapabilitiesMissing,
  validateTranscriptStore,
} from "../assembly-validators.js";

export { parseReflectionDecision };

/**
 * Governor 历史的估算上限（与 #172 A4 之前的内联 4000 同口径）。
 */
export const GOVERNOR_HISTORY_TOKEN_LIMIT = 4000;

/**
 * 逐条目估算字符计数 + JSON 数组骨架，供 {@link trimGovernorHistory} 递减。
 *
 * @param {unknown[]} entries
 * @returns {{ perEntry: [number, number][], total: [number, number] }}
 */
function governorHistoryCounts(entries) {
  const perEntry = entries.map((entry) => countEstimateCharacters(
    // 数组位上的 undefined / 函数在 JSON 里就是 null，逐条序列化必须同口径
    JSON.stringify(entry) ?? "null",
  ));
  const total = [0, 0];
  for (const [cjk, other] of perEntry) {
    total[0] += cjk;
    total[1] += other;
  }
  // JSON 数组骨架：两个方括号 + (n-1) 个逗号，全部非 CJK
  total[1] += entries.length === 0 ? 2 : entries.length + 1;
  return { perEntry, total };
}

/**
 * 从账本里减去第 index 条（即刚被弹出队头的那一条）与其分隔逗号。
 *
 * @param {{ perEntry: [number, number][], total: [number, number] }} history
 * @param {number} index
 */
function dropGovernorHistoryEntry(history, index) {
  const entry = history.perEntry[index];
  if (entry === undefined) return;
  history.total[0] -= entry[0];
  // 条目自身 + 它带来的一个分隔逗号；弹到空数组时括号仍是 2 个（增量 0）
  history.total[1] -= entry[1] + (history.perEntry.length - index - 1 === 0 ? 0 : 1);
}

/**
 * 修剪 governor 历史：估算总量超预算就从队头弹出，**至少保留 1 条**（语义不变）。
 *
 * #172 A4：旧实现（orchestrator.js:959-965）在 `while` 里每移出一个元素就对**剩余
 * 全量** `runningLog`/`l0Facts` 各跑一遍 JSON.stringify + estimateTokens，弹 k 条
 * 就付 O(k·n) 次全量扫描。现在改成逐条目只序列化/计数一次，总量按被移出条目递减。
 *
 * 口径逐位不变：`JSON.stringify([a,b]) === "[" + stringify(a) + "," + stringify(b) + "]"`，
 * 而 `estimateTokens` 的两个字符类计数对拼接可加（ceil 只在尾部做一次），骨架字符
 * （括号/逗号）全为非 CJK——所以下面的递减账本与旧实现的「每次全量重估」逐位相等。
 *
 * @param {{runningLog: unknown[], l0Facts: unknown[]}} state
 * @param {number} [tokenLimit=4000]
 * @returns {number} 被移出的条目数
 */
export function trimGovernorHistory(state, tokenLimit = GOVERNOR_HISTORY_TOKEN_LIMIT) {
  const runningLog = governorHistoryCounts(state.runningLog);
  const l0Facts = governorHistoryCounts(state.l0Facts);
  const historyTokens = (history) => estimateTokensFromCharacterCounts(history.total);
  let dropped = 0;
  while (runningLog.perEntry.length > dropped + 1
    && historyTokens(runningLog) + historyTokens(l0Facts) > tokenLimit) {
    dropGovernorHistoryEntry(runningLog, dropped);
    dropGovernorHistoryEntry(l0Facts, dropped);
    dropped += 1;
  }
  if (dropped > 0) {
    // 等价于 shift() 调用 dropped 次，但只动一次数组
    state.runningLog.splice(0, dropped);
    state.l0Facts.splice(0, dropped);
  }
  return dropped;
}

const RUN_TOOL_LOOP_OPTION_NAMES = [
  "assemblyPort",
  "provider",
  "system",
  "cacheStablePrefix",
  "wrapup",
  "initialUserMessage",
  "initialMessages",
  "tools",
  "outputHygiene",
  "writeToolNames",
  "writeToolPathKeys",
  "executeTool",
  "replayPolicy",
  "partialPersistence",
  "maxRounds",
  "cacheCapable",
  "toolResultTtl",
  "toolResultFoldMinTokens",
  "maxTokens",
  "temperature",
  "topP",
  "timeoutMs",
  "deadlineMs",
  "reflection",
  "stallDetection",
  "retry",
  "completion",
  "finalGuard",
  "finalGuardMaxRetries",
  "finalGuardTimeoutMs",
  "maxTokenContinuations",
  "context",
  "todoStateProvider",
  "semanticStateProvider",
  "modelConfig",
  "modelMetadata",
  "model",
  "expert",
  "user",
  "task",
  "session",
  "requestId",
  "toolContext",
  "store",
  "persistence",
  "runId",
  "resume",
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  "diagnostics",
  "onObserverError",
  "signal",
  "stream",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
  "onEvent",
];
const RUN_TOOL_LOOP_OPTION_SET = new Set(RUN_TOOL_LOOP_OPTION_NAMES);

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

function optionSuggestion(unknownName) {
  let best;
  for (const optionName of RUN_TOOL_LOOP_OPTION_NAMES) {
    const distance = levenshteinDistance(unknownName, optionName);
    if (best === undefined || distance < best.distance) {
      best = { name: optionName, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(unknownName.length / 3));
  return best?.distance <= threshold ? best.name : undefined;
}

function persistenceInfoFor(error) {
  if (!error || typeof error !== "object") return undefined;
  if (error.persistence && typeof error.persistence === "object") {
    return error.persistence;
  }
  if (
    typeof error.operation === "string"
    && typeof error.phase === "string"
    && typeof error.sideEffect === "string"
  ) {
    return {
      operation: error.operation,
      phase: error.phase,
      sideEffect: error.sideEffect,
    };
  }
  return undefined;
}

function persistenceErrorEvent({ port = "transcript", operation, phase, runId, sideEffect, error, fatal = true }) {
  return {
    type: "persistence_error",
    port,
    phase,
    operation,
    runId,
    fatal,
    sideEffect,
    error: {
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? ""),
    },
    ts: new Date().toISOString(),
  };
}

// 归一化结果的机械校验：LLM 只许搬运，不许改写。
// 每个 finding 值必须是 agent 原文的逐字子串，否则丢弃该条（宁少不多）。
function filterFindingsBySource(findings, sourceText) {
  if (findings === undefined || findings === null
    || typeof findings !== "object" || Array.isArray(findings)) {
    return undefined;
  }
  const source = typeof sourceText === "string" ? sourceText : "";
  const kept = {};
  for (const [key, value] of Object.entries(findings)) {
    const text = typeof value === "string" ? value : String(value);
    if (text.length > 0 && source.includes(text)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function makePersistenceFailure({ operation, phase, sideEffect, runId, error, event, errorLedger }) {
  const failure = new KitError(
    "persistence_failed",
    `Persistence operation ${operation} failed during ${phase} (runId=${String(runId)}): ${String(error?.message ?? error)}`,
    { retryable: false, cause: error },
  );
  failure.operation = operation;
  failure.phase = phase;
  failure.sideEffect = sideEffect;
  failure.persistence = {
    operation,
    phase,
    sideEffect,
    event,
  };
  failure.persistenceError = event;
  // 账单可靠性（issue #109）：异常终止时 run 不会返回 result，账单必须随异常走，
  // 否则 sink 失败留痕与未持久化事实一起丢失。
  failure.unpersisted = errorLedger?.toUnpersisted?.() ?? [];
  return failure;
}

/**
 * @typedef {object} LoopEvent
 * @property {"round_start"|"attempt"|"recovering"|"recovered"|"usage"|"tool_use"|"tool_result"|"tool_replay_decision_required"|"round_end"|"compaction"|"final_guard"|"persistence_capability_degraded"|"model_metadata_missing"|"run_outcome"} type
 * @property {number} [round]
 * @property {number} [attempt] 1-based provider attempt within the round.
 * @property {number} [maxAttempts] Retry count plus the initial attempt.
 * @property {object} [usage] Provider usage reported after a successful call.
 * @property {object} [toolUse] Completed canonical tool_use block.
 * @property {object} [toolResult] Canonical tool_result block.
 * @property {string} [runId] Run identity on host-facing diagnostics.
 * @property {string} [detail] One-shot capability diagnostic text (persistence_capability_degraded, model_metadata_missing).
 * @property {string} [toolUseId] Tool invocation requiring host replay decision.
 * @property {string} [toolName] Tool name requiring host replay decision.
 * @property {boolean} [requiresHostDecision] Whether the host must decide whether to retry.
 * @property {boolean} [partialOutputAvailable] Whether captured output was included in the interrupted result.
 * @property {string} [finalText] Text accumulated at round end.
 * @property {string} [stopReason] Canonical provider stop reason.
 * @property {"accept"|"skip"|"revise"|"degraded"|"error"} [action]
 * @property {string} [reason]
 */

/**
 * @typedef {object} JudgeEvent
 * @property {number} [round]
 * @property {"round"|"intercept"} kind
 * @property {{id?:string, name?:string, input?:object}} [tool]
 * @property {{done:boolean, confidence:number, reason:string, evidence:string}|null} [decision]
 * @property {"judge_done"|"nudge"|"continue"|"executed"|"blocked"|"degraded"} action
 * @property {"timeout"|"error"|"parse"} [error]
 * @property {string} [runId] issue #165（additive）：宿主传入的 run 标识，用于与本 run 的
 *   `run_outcome` 事件 join；宿主没给 `runId` 时该字段缺省（不写假值）。
 * @property {string} [model] issue #165（additive）：被评决策发生时 run 实际使用的模型标识，
 *   由 run 选项 / provider 配置解析而来（`src/loop/judge-record.js`）；探不到则缺省。
 * @property {string} [judgeModel] issue #165（additive）：仅当 judge 走了与 run 不同的
 *   evaluator 模型时出现（校准指标要能区分被评模型与评它的模型）。 */

/**
 * Run the minimum tool-calling loop against an injected provider.
 *
 * When `reflection` is omitted, the basic judge is enabled automatically for
 * runs with `maxRounds >= 16`; pass `reflection: false` to disable it.
 *
 * Stall detection defaults to `consecutive`, which requires the entire window to
 * hold the same signature (legitimate re-reads of a file no longer count as a
 * stall); pass `{ mode: "appear" }` to detect a signature anywhere in the
 * window instead. `ERIX_STALL_MODE` overrides the mode unless `stallDetection`
 * is explicitly `false`.
 *
 * @param {{
 *   assemblyPort?: import("../assembly.js").AssemblyPort,
 *   provider: {chat?: (request: object) => Promise<object>, chatStream?: (request: object) => Promise<object>},
 *   system?: string,
 *   cacheStablePrefix?: boolean, // Marks the stable system and first user prefix boundaries by default.
 *   wrapup?: boolean, // Controls instruction injection, JSON parsing, finalText replacement, and LLM normalization.
 *   initialUserMessage?: string,
 *   initialMessages?: object[],
 *   tools?: object[],
 *   outputHygiene?: false | { limit?: number }, // Engine-side output hygiene (ADR-015); see `outputHygiene` below.
 *   writeToolNames?: string[], // Explicit tool names counted in judge filesWritten.
 *   writeToolPathKeys?: string[], // Path argument priority for configured write tools.
 *   executeTool: (options:{id:string, name:string, input:object, context:object, signal:AbortSignal})
 *     => Promise<string|{content:any, metadata?:object, success?:boolean}|Error>,
 *   replayPolicy?:"always-replay"|"per-tool-declaration", // Default always-replay preserves existing resume behavior.
 *   partialPersistence?:false|{intervalMs:number,minBytes?:number}, // Default false; persist partial streamed text on an interval.
 *   maxRounds?: number,
 *   cacheCapable?: boolean, // cache-capable 端点默认关闭工具结果 TTL 折叠；显式 toolResultTtl 优先。
 *   toolResultTtl?: number, // 工具结果 TTL 折叠存活轮数；未设置时默认 2。
 *   maxTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   timeoutMs?: number,
 *   deadlineMs?: number,
 *   reflection?: {enabled?:boolean, roundJudge?:boolean, judgeIntercept?:boolean,
 *     judgeIntervalRound?:number, judgeInterceptTimeoutMs?:number,
 *     extensionStep?:number,
 *     maxExtensions?:number, maxRoundsCap?:number, format?:"json"|"text",
 *     judge?:{provider?:object,evaluator?:object},
 *     onReflection?:(info:{round:number, decision:object, extendedTo:number}) => void}|false,
 *   stallDetection?: {window?:number, mode?:"appear"|"consecutive"}|false, // Defaults to consecutive mode.
 *   retry?: {attempts?:number, backoffBaseMs?:number, backoffMaxMs?:number,
 *     sleepImpl?:(ms:number)=>Promise<void>}|false,
 *   completion?: {signals?:string[], maxNoToolRounds?:number}|false,
 *   finalGuard?:(payload:{finalText:string,messages:object[],round:number,rounds:number,signal:AbortSignal,termination:object}) => Promise<{action:"accept"}|{action:"skip",reason:string}|{action:"revise",message:string}>,
 *   finalGuardMaxRetries?: number,
 *   finalGuardTimeoutMs?: number, // Defaults to 30000; non-positive values use the default.
 *   maxTokenContinuations?: number,
 *   context?: {strategy?: object|"sliding-window"|"fold-statistical"|"fold-llm", budgetTokens?:number, keepRounds?:number, toolContext?:object, task?:string}, // strategy accepts a strategy object or a built-in name (#167); task is the judge/reflection/wrapup brief fallback after explicit task; see task param.
 *   todoStateProvider?:(payload:{runId?:string,rounds:number})=>object|Promise<object>,
 *   semanticStateProvider?:(payload:{runId?:string,state:object,previous?:object})=>{text:string,version:number}|Promise<{text:string,version:number}>,
 *   modelConfig?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   modelMetadata?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   model?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   expert?:any, user?:any,
 *   task?:any, // Explicit judge/reflection/wrapup brief; non-empty values take precedence as task > context.task > entry transcript's last user text. Explicit values use a 1500-code-point budget; message fallback uses 500. Multi-turn hosts should pass the current/latest instruction as a string.
 *   session?:any, requestId?:string, toolContext?:object,
 *   store?: {appendRound?: Function, load?:Function, // required pair (issue #78)
 *     saveRunSnapshot?:Function, loadLatestRunSnapshot?:Function, // optional run-snapshot capability
 *     markRunState?:Function, saveRunState?:Function, loadRunState?:Function}, // optional run-state capability
 *   persistence?:"none"|"required", // Defaults to required with a store and none without one.
 *   diagnostics?: {error:(event:object)=>void|Promise<void>},
 *   runId?: string,
 *   resume?: boolean,
 *   onRound?: (record:object) => void,      // 观察者（issue #173 PR-B）：抛错/rejected Promise 均被隔离
 *   onJudge?:(info:JudgeEvent) => void,     // 观察者（issue #173 PR-B）：抛错被隔离
 *   onToolResult?: (name:string, result:string, metadata?:object) => any,
 *   onPersistenceError?: (error:Error) => void,
 *   onObserverError?: (error:Error, context:{channel:string, runId?:string, type?:string, round?:number, toolName?:string, method?:string}) => void,
 *   signal?: AbortSignal,
 *   stream?: boolean,
 *   onDelta?: (chunk:string) => void,       // 观察者（issue #173 PR-B）：抛错被隔离
 *   onReasoningDelta?: (chunk:string) => void, // 同上
 *   onToolCall?: (fragment:object) => void, // 同上
 *   onUsage?: (usage:object) => void,       // 同上
 *   onEvent?: (event:LoopEvent) => void,    // 观察者（issue #173 PR-B）：抛错被隔离（启动期直调路径同口径）
 * }} options
 *
 * Per-option notes (behaviour defaults and boundaries). These are prose, deliberately
 * **outside** the `{{ … }}` type literal: TypeScript's JSDoc type parser rejects a
 * standalone `//` line inside an inline object type and silently degrades the whole
 * `options` parameter to `any` (issue #213 R4 — this exact silent fallback is what
 * left the single most host-facing type of the package untyped). A trailing `//` on a
 * property line is safe; a comment line of its own is not. Grouped by the option.
 *
 * `wrapup`:
 *   Defaults to true (omit = enabled). ERIX_NO_WRAPUP_INSTRUCTION=1 env overrides even an
 *   explicit wrapup:true — either off disables the whole protocol.
 *
 * `outputHygiene`:
 *   When enabled, tool results larger than `limit` characters are archived in full into
 *   the round record
 *   (toolOutputs) and stubbed in the context view. Requires a
 *   transcript store (the archive lives in the record). Defaults to enabled when a
 *   store is present; pass false to opt out. Default limit: 15% of the host-provided
 *   contextWindowTokens clamped to [8192, 100000], else 4096; an explicit limit wins.
 *
 *   A second, round-level layer (issue #32 #2) chains onto the per-result limit:
 *   the combined inline cost of one round's tool results is capped at
 *   clamp(0.30 x budgetTokens, 16000, 200000) **estimated tokens** (estimateTokens,
 *   stub text and per-result framing included; intercepted control results excluded,
 *   failed results counted). Budget base is the engine's existing budgetTokens
 *   (computeBudget / context.budgetTokens) — no second window source. Admission is
 *   incremental in arrival order: results keep declaration order and ids, nothing is
 *   rewritten after its run snapshot, so snapshot/resume semantics are unchanged.
 *   The layer is off when budgetTokens is absent or outputHygiene is false.
 *
 * `writeToolNames`:
 *   Defaults to ["writeFile", "edit"] (DEFAULT_WRITE_TOOL_NAMES in src/reflection/judge.js — the single
 *   truth shared by this default, the normalizeToolNameSet fallback below, and the judge
 *   timeline; issue #191 added `edit`). An explicit host value always wins: it replaces the
 *   default outright and is never merged with it.
 *
 * `stallDetection`:
 *   {window:4, mode:"consecutive"} (the entire window must hold the same signature);
 *   ERIX_STALL_MODE overrides the mode unless the option is explicitly false.
 *
 * `store`:
 *   Deprecated aliases still honoured at runtime: saveCheckpoint/appendCheckpoint/loadLatestCheckpoint.
 *
 * `onToolResult`:
 *   改写钩子（非纯观察者）：返回值会替换工具结果。抛错/rejected Promise 被隔离，
 *   fallback 是【保留引擎原始执行结果】后继续跑——改写/脱敏逻辑必须在本 hook 内自防（issue #173 PR-B）
 *
 * `onObserverError`:
 *   统一观察者错账户（issue #173 PR-B）：第二参带出错通道与定位上下文。channel 恒存在，取值
 *   "onEvent"|"onRound"|"onToolResult"|"onJudge"|"onDelta"|"onReasoningDelta"|"onToolCall"|"onUsage"；
 *   宿主传了 runId 时每条上报都带 runId（并行多 run 的宿主靠它归因）；其余字段按通道附送
 *   （type/round/toolName/method）。本回调同步抛错时退到 console，不影响 run
 *
 * 宿主观察者回调的统一语义（issue #173 PR-B，行为放宽 = semver minor）：
 *   1. 九个宿主观察者回调——八条通道 onEvent / onRound / onToolResult / onJudge / onDelta /
 *      onReasoningDelta / onToolCall / onUsage，加上一条不承诺异步的错账户 onObserverError
 *      自身（它炸了退到 console）——抛错后一律「记一笔、继续跑」：经
 *      onObserverError(error, {channel, runId?, ...}) 报告，run 的 termination 不因观察者抛错
 *      而改变（旧行为：onEvent/onRound/onToolResult 会杀 run、onJudge 静默吞）。onEvent 的两条
 *      启动期直调诊断路径（model_metadata_missing / persistence_capability_degraded）同口径。
 *   2. 抛错不是控制流。要终止 run 请 `signal.abort()`（抛出的错误带 #180 载荷），
 *      或依靠引擎自身的治理/失败裁决；宿主不得依赖回调抛错来中止或降级 run。
 *   3. 回调必须**同步返回**。async 回调的 rejected Promise 仅在被 await 的两个通道
 *      （onRound、onToolResult）上承诺隔离；其余通道（含 onEvent）只接同步 throw，
 *      开异步回调请自带 try/catch。
 *   4. 观察者错误是 best-effort：不落持久化错误账本（`delivery_failure` 不覆盖它们），
 *      宿主应自己计数 onObserverError；`onToolResult` 是数据改写钩子，其异常 fallback 为
 *      保留原始结果（详见 docs/host-consumer-contract.md「Observer callback errors」）。
 *   5. 不在这条通道里的宿主回调各有各的错误口径，别外推：`executeTool`（工具错误）、
 *      `onPersistenceError`/`diagnostics.error`（持久化账本 + delivery_failure）、
 *      `finalGuard`（核验状态）、`reflection.onReflection`（仍按未隔离处理，抛错杀 run）。
 * @returns {Promise<{
 *   finalText:string,
 *   messages:object[],
 *   transcript:object[],
 *   rounds:number,
 *   truncated:boolean,
 *   termination:{
 *     reason:"end_turn"|"no_tool"|"stall"|"max_rounds_cap"|"judge_done"|"continuation_exhausted"|"final_guard_unverified"|"aborted"|"failed",
 *     detail?:string,
 *     errorCode?:string,   // issue #176：仅 reason==="failed" 携带（根因 KitError.code，探不到则 "unknown"）
 *     usage?:object,       // issue #180：仅 reason==="aborted" 携带，与抛出的 error.usage 同一个对象
 *     rounds?:number,      // issue #180：仅 reason==="aborted" 携带
 *     partial?:boolean     // issue #180：reason==="aborted" 时恒为 true
 *   },
 *   verification:{status:"verified"|"unverified"|"skipped"|"error", reason?:string, detail?:string},
 *   runState?:object,
 *   usage:{input_tokens:number, output_tokens:number, cacheRead?:number, cacheWrite?:number},
 *   compactionStats:{compacted:boolean, foldedRounds:number, tokensBefore:number, tokensAfter:number, layers:object}[]
 * }>}
 */
export async function runToolLoop(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("runToolLoop options must be an object");
  }
  for (const optionName of Object.keys(options)) {
    if (!RUN_TOOL_LOOP_OPTION_SET.has(optionName)) {
      const suggestion = optionSuggestion(optionName);
      throw new TypeError(
        `unknown runToolLoop option: ${JSON.stringify(optionName)}`
        + (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : ""),
      );
    }
  }

  const { assemblyPort, ...explicitOptions } = options;
  const assembledOptions = assemblyPort === undefined
    ? {}
    : await assemblyPortOptions(
      assemblyPort,
      explicitOptions.modelConfig === undefined
        ? {}
        : { modelConfig: explicitOptions.modelConfig },
    );
  const effectiveOptions = { ...assembledOptions };
  for (const [key, value] of Object.entries(explicitOptions)) {
    if (value !== undefined) effectiveOptions[key] = value;
  }

  const {
    provider,
    system,
    cacheStablePrefix = true,
    wrapup = true,
    initialUserMessage,
    initialMessages,
    tools = [],
    outputHygiene,
    writeToolNames = DEFAULT_WRITE_TOOL_NAMES,
    writeToolPathKeys = ["path", "file_path"],
    executeTool,
    replayPolicy = "always-replay",
    partialPersistence = false,
    maxRounds = 8,
    cacheCapable = false,
    toolResultTtl,
    toolResultFoldMinTokens = TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT,
    maxTokens,
    temperature,
    topP,
    timeoutMs,
    deadlineMs,
    reflection,
    stallDetection = { window: 4, mode: "consecutive" },
    retry = false,
    completion = { signals: [], maxNoToolRounds: 3 },
    finalGuard,
    finalGuardMaxRetries = 2,
    finalGuardTimeoutMs = 30_000,
    maxTokenContinuations = 3,
    context,
    todoStateProvider,
    semanticStateProvider,
    modelConfig,
    modelMetadata,
    model,
    expert,
    user,
    task,
    session,
    requestId,
    toolContext,
    store,
    persistence,
    runId,
    resume = false,
    onRound,
    onJudge,
    onToolResult,
    onPersistenceError,
    diagnostics,
    onObserverError,
    signal,
    stream = false,
    onDelta,
    onReasoningDelta,
    onToolCall,
    onUsage,
    onEvent,
  } = effectiveOptions;
  const resolvedToolResultTtl = toolResultTtl === undefined && cacheCapable === true
    ? 0
    : toolResultTtl ?? TOOL_RESULT_TTL_DEFAULT;
  const fineGrainedPortShape = assemblyPort === undefined && (
    (session !== undefined && session !== null && typeof session === "object")
    || Object.hasOwn(explicitOptions, "modelConfig")
    || typeof modelConfig?.resolve === "function"
  );
  const startupMissing = collectLoopCapabilitiesMissing({
    provider,
    executeTool,
    modelConfig,
    session,
    fineGrainedPortShape,
    hasExplicitModelConfigOverride: assemblyPort !== undefined
      && explicitOptions.modelConfig !== undefined,
  });
  if (startupMissing.length > 0) {
    throw new TypeError(`assembly port is missing methods: ${startupMissing.join(", ")}`);
  }
  let resolvedModelConfig = modelConfig;
  if (typeof modelConfig?.resolve === "function") {
    resolvedModelConfig = await modelConfig.resolve(session?.modelSlot);
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) {
    throw new TypeError("maxRounds must be a finite positive integer");
  }
  if (replayPolicy !== "always-replay" && replayPolicy !== "per-tool-declaration") {
    throw new TypeError('replayPolicy must be "always-replay" or "per-tool-declaration"');
  }
  if (partialPersistence !== false && !stream) {
    throw new TypeError("partialPersistence requires stream: true");
  }
  if (partialPersistence !== false
    && (partialPersistence === null
      || typeof partialPersistence !== "object"
      || Array.isArray(partialPersistence))) {
    throw new TypeError("partialPersistence must be false or an object");
  }
  if (partialPersistence !== false
    && (!Number.isSafeInteger(partialPersistence.intervalMs)
      || partialPersistence.intervalMs <= 0)) {
    throw new TypeError("partialPersistence.intervalMs must be a positive integer");
  }
  if (partialPersistence !== false
    && partialPersistence.minBytes !== undefined
    && (!Number.isSafeInteger(partialPersistence.minBytes)
      || partialPersistence.minBytes < 0)) {
    throw new TypeError("partialPersistence.minBytes must be a non-negative integer");
  }
  const partialPersistenceConfig = partialPersistence === false
    ? undefined
    : {
      intervalMs: partialPersistence.intervalMs,
      ...(partialPersistence.minBytes === undefined
        ? {}
        : { minBytes: partialPersistence.minBytes }),
    };
  if (Array.isArray(tools)) {
    for (const [index, tool] of tools.entries()) {
      if (tool?.replay !== undefined
        && tool.replay !== "safe"
        && tool.replay !== "unsafe") {
        throw new TypeError(`tools[${index}].replay must be "safe" or "unsafe"`);
      }
    }
  }

  const persistenceMode = persistence ?? (store === undefined ? "none" : "required");
  if (persistenceMode !== "none" && persistenceMode !== "required") {
    throw new TypeError('persistence must be "none" or "required"');
  }
  // 输出卫生：档案在 round record（toolOutputs）里，必须有 store 落盘，否则 stub 就是纯丢失。
  if (outputHygiene !== undefined && outputHygiene !== false
    && (outputHygiene === null || typeof outputHygiene !== "object"
      || Array.isArray(outputHygiene))) {
    throw new TypeError("outputHygiene must be false or an object like { limit: 4096 }");
  }
  if (
    outputHygiene && outputHygiene !== false
    && outputHygiene.limit !== undefined
    && (!Number.isSafeInteger(outputHygiene.limit) || outputHygiene.limit <= 0)
  ) {
    throw new TypeError("outputHygiene.limit must be a positive integer");
  }
  const outputHygieneCapable = store !== undefined && persistenceMode !== "none";
  if (outputHygiene && outputHygiene !== false && !outputHygieneCapable) {
    throw new TypeError("outputHygiene requires a transcript store (archive lives in the round record)");
  }
  const outputHygieneEnabled = outputHygiene !== false && outputHygieneCapable;
  const archivedOutputs = [];
  const persistenceRequired = persistenceMode === "required";
  if (persistenceRequired) {
    const missingMethods = validateTranscriptStore(store);
    if (missingMethods.length > 0) {
      throw new TypeError(
        `required persistence store is missing methods: ${missingMethods.join(", ")}`,
      );
    }
  }
  const hasReplayDeclarations = Array.isArray(tools) && tools.some((tool) => (
    tool && typeof tool === "object" && Object.hasOwn(tool, "replay")
  ));
  const providerTools = hasReplayDeclarations
    ? tools.map((tool) => {
      if (!tool || typeof tool !== "object" || !Object.hasOwn(tool, "replay")) return tool;
      const { replay: _replay, ...providerTool } = tool;
      return providerTool;
    })
    : tools;

  const retryOptions = retry && typeof retry === "object" ? retry : null;
  const retryAttempts = retryOptions === null
    ? 0
    : Number.isInteger(retryOptions.attempts)
      ? Math.max(0, retryOptions.attempts)
      : 2;
  const backoffBaseMs = Number.isFinite(retryOptions?.backoffBaseMs)
    ? Math.max(0, retryOptions.backoffBaseMs)
    : 1500;
  const backoffMaxMs = Number.isFinite(retryOptions?.backoffMaxMs)
    ? Math.max(0, retryOptions.backoffMaxMs)
    : 10000;
  const sleepImpl = retryOptions?.sleepImpl ?? defaultSleep;
  let toolExecutedThisRound = false;
  const errorLedger = createErrorLedger();

  const reportPersistenceError = async (error, event) => {
    // 账本 = 权威记录：失败无条件入账，不依赖 sink 是否送达。
    errorLedger.record({
      port: event.port,
      operation: event.operation,
      phase: event.phase,
      fatal: event.fatal,
      error,
    });
    if (typeof onPersistenceError === "function") {
      try {
        await onPersistenceError(error);
      } catch (observerFailure) {
        errorLedger.recordDeliveryFailure({ event, error: observerFailure });
      }
    }
    if (typeof diagnostics?.error === "function") {
      try {
        await diagnostics.error(event);
      } catch (sinkError) {
        // 事件通道自身降级必须留痕：sink 抛错 → 账本记 delivery_failure（评审修正 1/遗漏面）。
        errorLedger.recordDeliveryFailure({ event, error: sinkError });
      }
    }
  };
  // #109 第2步：通用持久化失败报告桥——宿主端口（notes 等）写失败的唯一入账通道。
  // 引擎不认识 notes：宿主只报 port/operation/phase/error；非致命（继续 + 事件 + 账单）。
  // 经 executeTool context 注入，宿主调它即可获得与 transcript 同构的事件/账单/observer 链路。
  const reportHostPersistenceFailure = async (info = {}) => {
    const event = persistenceErrorEvent({
      port: typeof info.port === "string" && info.port !== "" ? info.port : "host",
      operation: typeof info.operation === "string" && info.operation !== ""
        ? info.operation
        : "unknown",
      phase: typeof info.phase === "string" && info.phase !== "" ? info.phase : "write",
      runId,
      sideEffect: info.sideEffect,
      error: info.error,
      fatal: false,
    });
    await reportPersistenceError(info.error, event);
  };
  // issue #173 PR-B：观察者回调抛错的唯一记账口。九个观察者通道（onEvent / onRound /
  // onToolResult / onJudge，以及流式 onDelta / onReasoningDelta / onToolCall / onUsage）的
  // 宿主异常一律经此上报后**继续跑**，不再改写 run 的终局（要终止 run 请 signal.abort()）。
  // context 至少带 {channel}（回调名）与定位所需的最小上下文（type/round/toolName），宿主据此
  // 分流与计数。best-effort 语义不变：宿主 onObserverError 自己抛错时退到 console，绝不二次抛出。
  const reportObserverError = (error, context = {}) => {
    const channel = typeof context?.channel === "string" && context.channel !== ""
      ? context.channel
      : "unknown";
    // runId 在记账口统一注入而不是各通道自己拼：宿主（touwaka / erix-station）并行跑多个 run，
    // 拿不到 runId 的观察者错误无法归因。没传 runId 时不编造字段。
    const detail = {
      ...(runId === undefined ? {} : { runId }),
      ...context,
      channel,
    };
    if (typeof onObserverError === "function") {
      try {
        onObserverError(error, detail);
        return;
      } catch (reportError) {
        console.error("Observer error reporter failed:", reportError);
      }
    }
    console.error("Observer callback error:", error, detail);
  };
  // issue #78：可选 capability（run snapshot / run-state）缺失时跳过对应持久化，
  // 只发一次诊断事件（不每轮刷屏）；run 正常执行，仅不支持中途 crash resume。
  const skippedCapabilityMethods = new Set();
  const notifyCapabilitySkipped = (method) => {
    if (skippedCapabilityMethods.has(method)) return;
    skippedCapabilityMethods.add(method);
    // 直接用 onEvent（函数参数，任何时点可用）；emitEvent 的 const 定义在下方，
    // restoreResume 早于它执行（markRunState("running")），不能引用。
    // issue #173 PR-B 边界③：这条直调路径绕过 emitEvent，因此隔离防护在此本地复刻一份，
    // 口径与 emitEvent 完全一致（同一 reportObserverError、同一 channel:"onEvent" 上下文）。
    try {
      onEvent?.({
        type: "persistence_capability_degraded",
        runId,
        method,
        detail: `store does not implement ${method}; the corresponding persistence is skipped for this run`,
      });
    } catch (hostError) {
      reportObserverError(hostError, {
        channel: "onEvent",
        type: "persistence_capability_degraded",
        method,
      });
    }
  };
  // issue #182：预算元数据缺失时本 run 的压缩总开关不进入（budgetTokens 未定义 → overBudget 恒
  // false）、单轮聚合输出预算（#120）整体关闭、输出截断上限退回 4096，而此前全链路零告警
  // （真机 92 轮 run compaction=0）。一次性诊断事件让宿主能在验收/CI 里直接断言「我的装配是否
  // 把压缩关掉了」；去重与直调 onEvent?.() 的风格照抄上方 notifyCapabilitySkipped（同样绕开
  // 定义在下方的 emitEvent，本事件在启动期预算推导段触发，引用会踩 TDZ），每 run 最多一条。
  // 同理，detail 引用的 outputHygieneLimit 也在下方声明：本函数的唯一调用点在它之后，更早调用会踩 TDZ。
  let modelMetadataNoticeSent = false;
  const notifyModelMetadataMissing = () => {
    if (modelMetadataNoticeSent) return;
    modelMetadataNoticeSent = true;
    // detail 前三句是 issue #182 约定的固定原文（宿主可直接断言）；输出上限一句按实际解析值
    // 说真话——显式 outputHygiene.limit 或只带了 contextWindowTokens 时并不是 4096。
    // issue #173 PR-B 边界③：同 notifyCapabilitySkipped，直调路径本地复刻 emitEvent 的隔离防护。
    // 去重标记先置位：宿主抛错也视作「本 run 已发过」，保证事件恰好一条。
    try {
      onEvent?.({
        type: "model_metadata_missing",
        runId,
        detail: "contextWindowTokens/maxOutputTokens unavailable; compaction and aggregate output"
          + " budget are disabled for this run;"
          + (outputHygieneLimit === 4096
            ? " output limit falls back to 4096"
            : ` output limit resolves to ${outputHygieneLimit}`),
      });
    } catch (hostError) {
      // runId 由 reportObserverError 统一注入，此处不重复拼。
      reportObserverError(hostError, {
        channel: "onEvent",
        type: "model_metadata_missing",
      });
    }
  };
  const persist = async (method, ...args) => {
    if (!persistenceRequired) return false;
    if (typeof store?.[method] !== "function") {
      notifyCapabilitySkipped(method);
      return false;
    }
    const phase = method === "appendRound"
      ? "transcript"
      : method === "saveRunState" || method === "markRunState"
        ? "run_state"
        : args.at(-1)?.status === "executed"
          ? "checkpoint_after_tool"
          : "checkpoint_before_tool";
    const sideEffect = method === "appendRound"
      ? (toolExecutedThisRound ? "executed_uncommitted" : "not_started")
      : phase === "checkpoint_after_tool"
        ? "executed_uncommitted"
        : "not_started";
    let lastError;
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        await store[method](...args);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt >= retryAttempts) break;
        const delay = Math.min(
          backoffMaxMs,
          backoffBaseMs * (2 ** attempt),
        );
        await sleepImpl(delay, signal);
        throwIfAborted(signal);
      }
    }
    const event = persistenceErrorEvent({
      operation: method,
      phase,
      runId,
      sideEffect,
      error: lastError,
    });
    await reportPersistenceError(lastError, event);
    throw makePersistenceFailure({
      operation: method,
      phase,
      sideEffect,
      runId,
      error: lastError,
      event,
      errorLedger,
    });
  };
  const markRunState = async (state) => {
    await persist("markRunState", runId, state);
  };
  // issue #180（方案 A）：抛错路径的终局载荷来源。fail() 在累计量声明之前也可能被调用
  // （ctx 构建的早退 catch，那时 usage/finalText 还在 TDZ），所以这里用可变槽位持有读取器，
  // 累计量就绪后由下方赋值接管；未接管前按「无用量 = 0」交付，保证字段形状恒成立。
  let readLoopPayload = () => ({
    usage: { input_tokens: 0, output_tokens: 0 },
    rounds: 0,
    finalText: "",
  });
  // issue #165：judge 记录的关联字段（runId + 模型标识）与 run 级 outcome 汇总。
  // 沿用 #180 `readLoopPayload` 的可变槽位手法：模型名要等 provider/模型配置与 reflection 段
  // 解析完才可得（下方 `judgeRecordCorrelation` 在那里接管），`verification` 则到累计量声明区才存
  // 在（早退 catch 时还在 TDZ），所以未就绪时一律「不写字段」而非写假值。
  let judgeRecordCorrelation = judgeRecordFields({ runId });
  let verificationReader = () => undefined;
  let judgeRecordCount = 0;
  let runOutcomeEmitted = false;
  // run 级 outcome 汇总走既有 onEvent 通道（新增事件类型 `run_outcome`，不新增回调）：
  // `onJudge` 的 payload 语义是「一条 judge 决策」，把终局裁决塞进去会让宿主按决策计数/过滤
  // 的代码静默跑偏。宿主回调抛错经 reportObserverError 记账（#173 PR-B 统一口径：一切观察者
  // 抛错都上报、都不改变终局——这条是审计面记录，run 已跑完，宿主日志失败不会让它变 `failed`）。
  const emitRunOutcome = (outcome) => {
    if (typeof onEvent !== "function" || runOutcomeEmitted) return;
    runOutcomeEmitted = true;
    try {
      const verification = outcome?.verification ?? verificationReader();
      onEvent(runOutcomeRecord({
        ...judgeRecordCorrelation,
        ...outcome,
        judgeRecordCount,
        ...(verification === undefined ? {} : { verification }),
      }));
    } catch (hostError) {
      reportObserverError(hostError, { channel: "onEvent", type: "run_outcome" });
    }
  };
  const fail = async (error) => {
    let finalError = error;
    const originalPersistence = persistenceInfoFor(error);
    const initialReason = signal?.aborted ? "aborted" : "failed";
    currentTerminationReason = initialReason;
    if (!originalPersistence && currentRunState?.deterministic) {
      currentRunState.deterministic.termination = { reason: initialReason };
      currentRunState.rendered = renderRunState(currentRunState);
      try {
        await persist("saveRunState", runId, currentRunState);
      } catch (persistenceError) {
        finalError = persistenceError;
      }
    }
    const finalPersistence = persistenceInfoFor(finalError);
    if (finalPersistence?.operation !== "markRunState") {
      try {
        await markRunState(signal?.aborted ? "aborted" : "failed");
      } catch (persistenceError) {
        if (!persistenceInfoFor(finalError)) finalError = persistenceError;
      }
    }
    const persistenceFailure = persistenceInfoFor(finalError);
    const reason = signal?.aborted
      ? "aborted"
      : persistenceFailure === undefined
        ? "failed"
        : "persistence_failed";
    currentTerminationReason = reason;
    // issue #176：reason === "failed" 时把根因分类（error.code，无则 unknown）一并交出，
    // 宿主无需解析 detail 字符串就能按根因分流（#170 裁决表的数据面）。
    const termination = withErrorCode(
      makeTermination(reason, terminationDetailForError(finalError)),
      finalError,
    );
    if (persistenceFailure !== undefined) {
      Object.assign(termination, {
        operation: persistenceFailure.operation,
        phase: persistenceFailure.phase,
        sideEffect: persistenceFailure.sideEffect,
      });
    }
    // issue #180（方案 A）：抛错也要带已累计量——「停止」的 run 在宿主账面上不再是 0。
    // 语义不变：abort 仍然抛错，只是同一个错误对象上多了 usage/rounds/finalText，
    // aborted 时 termination 里同步 {usage, rounds, partial:true}。
    const loopPayload = readLoopPayload();
    const annotated = annotateTermination(
      finalError,
      withTerminationPayload(termination, loopPayload),
      loopPayload,
    );
    // issue #165：抛错终局（aborted/failed/persistence_failed）同样留一条 run 级 outcome 记录——
    // 没终局的 run 在 per-model 账面上会被当成「没跑过」。
    emitRunOutcome({
      rounds: loopPayload.rounds,
      termination,
    });
    throw annotated;
  };
  const metadata = modelMetadataFor({
    modelConfig: resolvedModelConfig,
    modelMetadata,
    model,
    provider,
    context,
  });
  // ADR-015：截断阈值按窗口缩放——宿主提供 contextWindowTokens 时取 15% 窗口（夹在 8k–100k），
  // 否则维持 4096（未接模型元数据的宿主行为不变）。显式 outputHygiene.limit 优先级最高。
  const outputHygieneExplicitLimit = outputHygiene && outputHygiene !== false
    ? outputHygiene.limit
    : undefined;
  const outputHygieneWindowTokens = Number.isFinite(metadata?.contextWindowTokens)
    && metadata.contextWindowTokens > 0
    ? metadata.contextWindowTokens
    : undefined;
  const outputHygieneLimit = outputHygieneExplicitLimit ?? (outputHygieneWindowTokens === undefined
    ? 4096
    : Math.min(100000, Math.max(8192, Math.floor(outputHygieneWindowTokens * 0.15))));
  const resolvedWriteToolNames = normalizeToolNameSet(writeToolNames, DEFAULT_WRITE_TOOL_NAMES);
  const resolvedWriteToolPathKeys = Array.isArray(writeToolPathKeys)
    ? writeToolPathKeys.filter((key) => typeof key === "string" && key.trim() !== "")
    : ["path", "file_path"];
  // issue #182：预算元数据齐备性是压缩的隐含总开关——computeBudget 需要 contextWindowTokens 与
  // maxOutputTokens 同时可得，缺一个就推不出 budgetTokens。把它抽成一个判据，推导段与诊断段共用，
  // 避免两处口径漂移。
  const budgetMetadataComplete = metadata?.contextWindowTokens !== undefined
    && metadata?.maxOutputTokens !== undefined;
  let budgetTokens = context?.budgetTokens;
  if (budgetTokens === undefined && budgetMetadataComplete) {
    budgetTokens = computeBudget({
      contextWindowTokens: metadata.contextWindowTokens,
      maxOutputTokens: metadata.maxOutputTokens,
    });
  }
  if (budgetTokens !== undefined) validateBudget(budgetTokens);
  // issue #182：预算推不出来且原因确实是元数据不齐（宿主自己给了 context.budgetTokens 时
  // 压缩仍然启用，不该告警）——发一次性诊断事件。
  // issue #173 PR-B 决策③：启动期这条直调 onEvent 路径不再是 run 的终止机制。原先「宿主回调
  // 抛错 → 按 fail() 同口径注解终局后抛出（abort 优先于 failed）」的整段逻辑删除：抛错现在由
  // notifyModelMetadataMissing 内部的 try/catch 吸收，经 reportObserverError(channel:"onEvent")
  // 记账后 run 继续（要终止 run 请用 signal.abort()，载荷见 #180）。
  if (budgetTokens === undefined && !budgetMetadataComplete) {
    notifyModelMetadataMissing();
  }
  // 单轮聚合输出预算（issue #32 #2）：口径统一写在 src/loop/aggregate-budget.js 顶部（估算 token、
  // 计入 stub 开销与 framing）。预算基准**复用**上面算出的 budgetTokens，不新引 contextWindowTokens
  // 第二套口径；budgetTokens 不存在（宿主无窗口配置）或 outputHygiene 被 opt-out 时聚合层整体关闭。
  const aggregateBudgetTokens = outputHygieneEnabled ? budgetTokens : undefined;
  // issue #167 方案 C：`context.strategy` 允许内置策略名字符串。名字形态时引擎注入默认
  // summarizer = 本 run 的主力 provider（宿主不再需要自己写调模型的胶水）。用法记账走
  // addUsage（trackLatest:false，与 wrapup judge 同口径：并入 run 总账但不污染压缩判断用的
  // latestApiInputTokens），并转发宿主 onUsage；这次调用在轮次循环之外，故天然不计轮次/stall。
  // 闭包引用后文才声明的 awaitWithAbort/addUsage：只在压缩触发时才被调用，无 TDZ 风险。
  const compactionSummarizer = createProviderSummarizer({
    chat: async (request) => {
      if (typeof provider?.chat !== "function" && typeof provider?.chatStream !== "function") {
        throw new TypeError("fold-llm default summarizer requires a provider with chat/chatStream");
      }
      const summarizerRequest = {
        ...request,
        signal,
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
      const response = await awaitWithAbort(
        typeof provider.chat === "function"
          ? provider.chat(summarizerRequest)
          : provider.chatStream({ ...summarizerRequest, onDelta: () => {} }),
      );
      addUsage(response, undefined, { trackLatest: false });
      return response;
    },
    ...(onUsage === undefined ? {} : { onUsage }),
  });
  // main 的 ADR-016 退役了 resourceStore 端口——compactionContext 不再拼它（两侧语义合并）
  // 名字在启动期一次性解析成实例（未知名字/非法类型 → 启动期 TypeError）；对象形态原样
  // 透传（同一引用），下游 configuredStrategy 通道零改动。名字形态额外吃 context 级的
  // recoveryHint/stubFor（对象形态这两个字段依旧由宿主自己在策略对象上给，语义不变）。
  const resolvedContextStrategy = context?.strategy === undefined
    ? undefined
    : resolveCompactionStrategy(context.strategy, {
      options: {
        ...(context.recoveryHint === undefined ? {} : { recoveryHint: context.recoveryHint }),
        ...(context.stubFor === undefined ? {} : { stubFor: context.stubFor }),
      },
      foldLlmOptions: { summarizer: compactionSummarizer },
    });
  const compactionContext = context === undefined && budgetTokens === undefined
    ? undefined
    : {
        ...(context ?? {}),
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
        ...(resolvedContextStrategy === undefined ? {} : { strategy: resolvedContextStrategy }),
      };
  const baseToolContext = {
    ...toolContextFor({
      toolContext,
      context,
      expert,
      user,
      task,
      session,
      requestId,
    }),
    // #109 第2步：宿主侧端口（notes 等）持久化失败的通用报告桥
    reportPersistenceFailure: reportHostPersistenceFailure,
  };
  const toolSignal = signal ?? new AbortController().signal;
  // reflection 未显式配置时，长任务（>=16 轮）默认开启基础 judge——无头宿主零配置获得保护
  const resolvedReflectionOption = reflection === undefined
    && maxRounds >= DEFAULT_REFLECTION_MIN_ROUNDS
    && process.env.ERIX_NO_REFLECTION?.trim() !== "1"
    ? { enabled: true }
    : reflection;
  const effectiveReflection = resolvedReflectionOption === true
    ? {}
    : resolvedReflectionOption && typeof resolvedReflectionOption === "object"
      ? resolvedReflectionOption
      : undefined;
  const reflectionEnabled = resolvedReflectionOption === true
    || (effectiveReflection !== undefined && effectiveReflection.enabled !== false);
  let roundJudgeEnabled = reflectionEnabled
    && effectiveReflection?.roundJudge !== false
    && process.env.ERIX_NO_ROUND_JUDGE?.trim() !== "1";
  const roundJudgeFailureLimit = Number.isSafeInteger(effectiveReflection?.judgeFailureLimit)
    && effectiveReflection.judgeFailureLimit > 0
    ? effectiveReflection.judgeFailureLimit
    : 3;
  let roundJudgeFailures = 0;
  // 透明拦截审计开关：与 roundJudge 正交（roundJudge:false 只关 end_turn 评估，审计可独立关）
  const judgeInterceptEnabled = reflectionEnabled
    && effectiveReflection?.judgeIntercept !== false;
  // 工具透明审计频率：每 judgeIntervalRound 次真实工具执行后，审计下一次调用。
  // 默认 10（运行时评估 §5.1：默认 5 过密，任务中途 done:false 必然成立 → 大量误拦截与成本税）。
  // 无有效配置时取 ERIX_JUDGE_INTERVAL；非法值（非正整数）忽略并回退默认 10。
  const envJudgeInterval = Number(process.env.ERIX_JUDGE_INTERVAL);
  const judgeIntervalRound = Number.isSafeInteger(effectiveReflection?.judgeIntervalRound)
    && effectiveReflection.judgeIntervalRound > 0
    ? effectiveReflection.judgeIntervalRound
    : Number.isSafeInteger(envJudgeInterval) && envJudgeInterval > 0
      ? envJudgeInterval
      : 10;
  const judgeInterceptTimeoutMs = Number.isFinite(effectiveReflection?.judgeInterceptTimeoutMs)
    && effectiveReflection.judgeInterceptTimeoutMs > 0
    ? effectiveReflection.judgeInterceptTimeoutMs
    : 30_000;
  const judgeInterceptConversationTokens = INTERCEPT_CONVERSATION_TOKENS;
  let judgeInterceptCount = 0;
  let interceptJudgeDecision;
  const wrapupEnabled = wrapup !== false
    && process.env.ERIX_NO_WRAPUP_INSTRUCTION?.trim() !== "1";
  const mainSystem = wrapupEnabled
    ? `${system ?? ""}${system ? "\n\n" : ""}${WRAPUP_INSTRUCTION}`
    : system;
  // 归一化 evaluator：复用 judge/provider 配置（无 judge 时主 provider），供 wrapup LLM 归一化用
  const judgeConfig = effectiveReflection?.judge;
  const wrapupEvaluator = judgeConfig?.provider ?? judgeConfig?.evaluator ?? provider;
  // issue #165：接管 judge 记录的关联字段——每个 judge 决策（round / intercept / degraded，
  // 含 run-snapshot-executor 里的拦截决策）都经下方 `emitJudge` 这个唯一收口打上 runId 与
  // 模型标识。模型名一律从 run 选项/provider 配置探（`judge-record.js`），探不到就不写字段；
  // judge 走独立 evaluator 时额外写 `judgeModel`，与 run 同名时不写（无冗余字段）。
  judgeRecordCorrelation = judgeRecordFields({
    runId,
    model: resolveRunModelName({
      modelConfig: resolvedModelConfig,
      modelMetadata,
      model,
      provider,
      context,
    }),
    judgeModel: resolveModelName(judgeConfig?.provider ?? judgeConfig?.evaluator),
  });
  // wrapup LLM 归一化（默认关闭：保持既有纯文本轮行为与旧测试兼容）。
  // 开启：ERIX_WRAPUP_NORMALIZE=1 或 reflection.wrapupNormalize===true。
  // benchmark/harness 场景应开启——找不到 JSON（含空文本）就该归一化。
  let wrapupNormalizationEnabled = wrapupEnabled && (
    process.env.ERIX_WRAPUP_NORMALIZE?.trim() === "1"
      || effectiveReflection?.wrapupNormalize === true
  );
  const reflectionExtensionStep = Number.isSafeInteger(effectiveReflection?.extensionStep)
    && effectiveReflection.extensionStep > 0
    ? effectiveReflection.extensionStep
    // 默认按当前上限的一半扩——固定 +32 是给大任务调的数，16 轮的任务一次加到 48 比例失衡
    : Math.max(8, Math.floor(maxRounds * 0.5));
  const reflectionMaxExtensions = Number.isSafeInteger(effectiveReflection?.maxExtensions)
    && effectiveReflection.maxExtensions >= 0
    ? effectiveReflection.maxExtensions
    : 2;
  const reflectionMaxRoundsCap = Math.max(
    maxRounds,
    Number.isSafeInteger(effectiveReflection?.maxRoundsCap)
      && effectiveReflection.maxRoundsCap > 0
      ? effectiveReflection.maxRoundsCap
      : 256,
  );
  const governorState = {
    effectiveMaxRounds: maxRounds,
    extensionCount: 0,
    noToolStreak: 0,
    wrapUpNudged: false,
    errorSeen: new Map(),
    runningLog: [],
    l0Facts: [],
    timeline: [],
    filesWritten: [],
  };
  const toolStats = new Map();
  let lowBudgetPrompted = false;
  let foldedRoundCount = 0;
  let navigationRecordCount = 0;
  let toolErrorCount = 0;
  let runSnapshotFailureCount = 0;
  let runStateVersion = 0;
  let ttlInjectArmed = false;
  let ttlInjectConsumed = false;
  let lowBudgetInjectFired = false;
  let currentRunState;
  let runStateAvailability = { status: "available" };
  let currentTerminationReason = "running";
  let todoState;
  let semanticState;
  const compactionStats = [];
  const trimFilesWritten = () => {
    const seen = new Set();
    const kept = [];
    for (let index = governorState.filesWritten.length - 1;
      index >= 0 && kept.length < 50;
      index -= 1) {
      const file = governorState.filesWritten[index];
      if (!seen.has(file.path)) {
        seen.add(file.path);
        kept.push(file);
      }
    }
    governorState.filesWritten = kept.reverse();
  };
  let stallStreak = 0;
  let lastStallSignature = null;
  const startedAt = Date.now();
  const configuredDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : Number.isFinite(timeoutMs) && timeoutMs > 0
      ? startedAt + timeoutMs
      : undefined;
  const elapsedMs = () => Date.now() - startedAt;
  const remainingMs = () => configuredDeadline === undefined
    ? undefined
    : configuredDeadline > startedAt
      ? configuredDeadline - Date.now()
      : configuredDeadline - elapsedMs();
  // #172 A4：修剪逻辑已上提为模块级 `trimGovernorHistory`（线性化、可单测）。
  const addGovernorHistory = (round, summary, l0facts, ts, wrapup, judge) => {
    governorState.runningLog.push({
      round,
      summary,
      ...(summary && typeof summary === "object" ? summary : {}),
      ...(wrapup === undefined || wrapup === null ? {} : {
        planned: "",
        actual: wrapup.summary,
        next: "",
        source: wrapup.done ? "json-done" : "json",
      }),
      ...(judge === undefined || judge === null ? {} : { judge }),
      ts,
    });
    governorState.l0Facts.push({ round, ...l0facts });
    // #172 A4：线性修剪（原为闭包内 O(n²) 的 while 全量重估）
    trimGovernorHistory(governorState);
  };
  const restoreErrorSeen = (l0facts) => {
    // 优先 errorCounts（每轮持久化的累计 count，resume 精确重建）；
    // 旧 schema fallback：errorHashes 每 hash +1（近似，同轮多次同错会少计）
    const counts = l0facts?.errorCounts;
    if (counts && typeof counts === "object") {
      for (const [errorHash, count] of Object.entries(counts)) {
        const current = governorState.errorSeen.get(errorHash)?.count ?? 0;
        governorState.errorSeen.set(errorHash, {
          count: Math.max(current, Number.isFinite(count) ? count : 0),
        });
      }
      return;
    }
    const errorHashes = l0facts?.errorHashes
      ?? (l0facts?.errorHash ? [l0facts.errorHash] : []);
    for (const errorHash of errorHashes) {
      const previous = governorState.errorSeen.get(errorHash);
      const previousCount = Number.isSafeInteger(previous?.count) ? previous.count : 0;
      governorState.errorSeen.set(errorHash, {
        ...(previous ?? {}),
        count: previousCount + 1,
      });
    }
  };
  let messages = initialMessages !== undefined
    ? [...initialMessages]
    : initialUserMessage !== undefined
      ? [{ role: "user", content: [{ type: "text", text: initialUserMessage }] }]
      : [];
  let taskBriefSource = messages;
  const messageRounds = new WeakMap();
  for (const message of messages) messageRounds.set(message, 0);
  // 双计数器约定（issue #32 #8）——改这两处语义前先读这里：
  // - `rounds`：**身份**轮号。跨 resume 单调递增（resume 从 transcript 最大 round 续起），
  //   用于 round 编号 / `roundKey` / messageRounds / judge 的"已运行轮数"展示 /
  //   run snapshot round / 结果 `result.rounds`。它**不是**轮预算。
  // - `budgetRounds`：**本次 runToolLoop 的预算消耗**。每次调用从 0 起计，
  //   resume **不**继承历史（否则续接轮轮号已到顶，主循环一次进不去，
  //   直接被 max_rounds_cap 强制收尾）。用于主循环条件 / `remainingRounds` /
  //   budget hint / reflection `nearLimit` / memory-loss 阈值。
  // 契约：非 resume 单段调用两者数值恒等（都从 0 起、同步自增）。
  let rounds = 0;
  let budgetRounds = 0;
  let foldedThrough = 0;
  let resumeRunSnapshot;
  let resumePendingTools = [];
  let resumeTailMessages = [];
  let resumeTranscriptStart;
  let resumeRunSnapshotMessages = [];
  let persistedTranscriptLength = 0;
  const resumeExecutedToolIds = new Set();
  const resumeRunSnapshotResults = new Map();
  let lastPersistenceFailure;
  try {
    await restoreResume({
    resume,
    store,
    persistenceRequired,
    runId,
    archivedOutputs,
    // issue #78 验收修正：resume 消费可选能力（loadRunState / snapshot loader）
    // 缺失时走与 persist 守卫同一的单条去重诊断通道。
    notifyCapabilitySkipped,
    get currentRunState() {
      return currentRunState;
    },
    set currentRunState(value) {
      currentRunState = value;
    },
    get runStateAvailability() {
      return runStateAvailability;
    },
    set runStateAvailability(value) {
      runStateAvailability = value;
    },
    get runStateVersion() {
      return runStateVersion;
    },
    set runStateVersion(value) {
      runStateVersion = value;
    },
    get messages() {
      return messages;
    },
    set messages(value) {
      messages = value;
    },
    get taskBriefSource() {
      return taskBriefSource;
    },
    set taskBriefSource(value) {
      taskBriefSource = value;
    },
    messageRounds,
    get rounds() {
      return rounds;
    },
    set rounds(value) {
      rounds = value;
    },
    get foldedThrough() {
      return foldedThrough;
    },
    set foldedThrough(value) {
      foldedThrough = value;
    },
    get resumeRunSnapshot() {
      return resumeRunSnapshot;
    },
    set resumeRunSnapshot(value) {
      resumeRunSnapshot = value;
    },
    get resumePendingTools() {
      return resumePendingTools;
    },
    set resumePendingTools(value) {
      resumePendingTools = value;
    },
    get resumeTailMessages() {
      return resumeTailMessages;
    },
    set resumeTailMessages(value) {
      resumeTailMessages = value;
    },
    get resumeTranscriptStart() {
      return resumeTranscriptStart;
    },
    set resumeTranscriptStart(value) {
      resumeTranscriptStart = value;
    },
    get resumeRunSnapshotMessages() {
      return resumeRunSnapshotMessages;
    },
    set resumeRunSnapshotMessages(value) {
      resumeRunSnapshotMessages = value;
    },
    get persistedTranscriptLength() {
      return persistedTranscriptLength;
    },
    set persistedTranscriptLength(value) {
      persistedTranscriptLength = value;
    },
    resumeExecutedToolIds,
    resumeRunSnapshotResults,
    toolStats,
    governorState,
    resolvedWriteToolNames,
    resolvedWriteToolPathKeys,
    markRunState,
    persist,
    fail,
    restoreErrorSeen,
    addGovernorHistory,
    trimFilesWritten,
    get lowBudgetPrompted() {
      return lowBudgetPrompted;
    },
    set lowBudgetPrompted(value) {
      lowBudgetPrompted = value;
    },
    get foldedRoundCount() {
      return foldedRoundCount;
    },
    set foldedRoundCount(value) {
      foldedRoundCount = value;
    },
    get navigationRecordCount() {
      return navigationRecordCount;
    },
    set navigationRecordCount(value) {
      navigationRecordCount = value;
    },
    get toolErrorCount() {
      return toolErrorCount;
    },
    set toolErrorCount(value) {
      toolErrorCount = value;
    },
    get runSnapshotFailureCount() {
      return runSnapshotFailureCount;
    },
    set runSnapshotFailureCount(value) {
      runSnapshotFailureCount = value;
    },
    get semanticState() {
      return semanticState;
    },
    set semanticState(value) {
      semanticState = value;
    },
    get compactionStats() {
      return compactionStats;
    },
    set compactionStats(value) {
      compactionStats.splice(0, compactionStats.length, ...(Array.isArray(value) ? value : []));
    },
    get todoState() {
      return todoState;
    },
    set todoState(value) {
      todoState = value;
    },
    get judgeInterceptCount() {
      return judgeInterceptCount;
    },
    set judgeInterceptCount(value) {
      judgeInterceptCount = value;
    },
    get interceptJudgeDecision() {
      return interceptJudgeDecision;
    },
    set interceptJudgeDecision(value) {
      interceptJudgeDecision = value;
    },
    });
  } catch (error) {
    await fail(error);
  }
  const taskBrief = resolveTaskBrief({ task, context, messages: taskBriefSource });
  const recentSignatures = [];
  const envStallMode = process.env.ERIX_STALL_MODE;
  // 默认 stallDetection 为 {window:4, mode:"consecutive"}（参数默认值，真实项目评估 §5.2：appear 误杀合法重读）。
  // stallDetection:false 显式关闭优先于环境变量（调用方显式关闭不应被 env 重新打开）。
  // 调用方显式传对象时缺省 mode 仍为 appear（只有引擎默认值才是 consecutive）。
  const resolvedStallDetection = stallDetection === false
    ? false
    : envStallMode
      ? { window: stallDetection?.window ?? 4, mode: envStallMode }
      : stallDetection;
  const stallWindow = resolvedStallDetection === false
    ? 0
    : Number.isInteger(resolvedStallDetection?.window) && resolvedStallDetection.window > 0
      ? resolvedStallDetection.window
      : 4;
  const stallMode = resolvedStallDetection?.mode === "consecutive" ? "consecutive" : "appear";
  const usage = { input_tokens: 0, output_tokens: 0 };
  let latestApiInputTokens;
  let latestApiEstimatedTokens;
  const completionEnabled = completion !== false;
  const completionSignals = Array.isArray(completion?.signals) ? completion.signals : [];
  const maxNoToolRounds = Number.isInteger(completion?.maxNoToolRounds)
    ? Math.max(0, completion.maxNoToolRounds)
    : 3;
  const continuationLimit = Number.isInteger(maxTokenContinuations)
    ? Math.max(0, maxTokenContinuations)
    : 3;
  let finalText = "";
  // issue #180：累计量就绪，接管 fail() 的载荷读取器（闭包在调用时读实值，含逐轮累加的
  // cacheRead/cacheWrite；usage 与 makeResult 交出的是同一个对象）。
  readLoopPayload = () => ({ usage, rounds, finalText });
  let declaredFindings;
  let forcedFinal = false;
  let lastAssistantContent = [];
  const finalGuardRetryLimit = Number.isSafeInteger(finalGuardMaxRetries)
    && finalGuardMaxRetries >= 0
    ? finalGuardMaxRetries
    : 2;
  const finalGuardTimeout = Number.isFinite(finalGuardTimeoutMs) && finalGuardTimeoutMs > 0
    ? finalGuardTimeoutMs
    : 30_000;
  let finalGuardRetries = 0;
  let verification = typeof finalGuard !== "function"
    ? { status: "skipped", reason: "no_final_guard" }
    : { status: "unverified", reason: "pending" };
  // issue #165：verification 已进入作用域，接管读取器（在此之前的早退 fail() 读到 undefined
  // → run_outcome 记录不带 verification 字段，而不是写一个假状态）。
  verificationReader = () => verification;
  const guardMetrics = {
    verified: 0,
    skipped: 0,
    revised: 0,
    unverified: 0,
    guard_error: 0,
  };
  let hadToolUse = hasToolUseInMessages(messages);
  let roundStopReason;
  let roundEventDeltas = [];

  const emitEvent = (event) => {
    // issue #173 PR-B：onEvent 抛错从「杀 run」改为「记一笔、继续跑」，与流式观察者同构。
    // 契约（docs/host-consumer-contract.md）：观察者抛错永不改变 run 的终局；要终止 run 用
    // signal.abort()。回调必须同步返回——async 回调的 rejected Promise 不在本通道承诺范围
    // （只有被 await 的 onRound/onToolResult 覆盖）。
    try {
      onEvent?.(event);
    } catch (hostError) {
      reportObserverError(hostError, {
        channel: "onEvent",
        ...(event?.type === undefined ? {} : { type: event.type }),
        ...(event?.round === undefined ? {} : { round: event.round }),
      });
    }
  };

  const recordCompactionStat = (stat, round) => {
    const normalized = createCompactionStat(stat);
    compactionStats.push(normalized);
    emitEvent({
      type: "compaction",
      round,
      compaction: cloneState(normalized),
    });
    return normalized;
  };

  const emitJudge = (info) => {
    if (typeof onJudge !== "function") return;
    // issue #165（additive）：先铺关联字段再铺决策字段——既有字段名与语义一律不动，
    // 只增 runId/model/judgeModel（探不到时字段缺省）；旧宿主按原字段读，行为不变。
    judgeRecordCount += 1;
    try {
      onJudge({ ...judgeRecordCorrelation, ...info });
    } catch (hostError) {
      // issue #173 PR-B：原先是裸 `catch {}`（连 onObserverError 都不通知）。观察者抛错一律
      // 记账：宿主自此能数出自己哪个回调在炸，run 仍照常收尾。
      reportObserverError(hostError, {
        channel: "onJudge",
        ...(info?.round === undefined ? {} : { round: info.round }),
        ...(info?.kind === undefined ? {} : { kind: info.kind }),
      });
    }
  };

  const addUsage = (response, estimatedTokens, { trackLatest = true } = {}) => {
    const inputTokens = response?.usage?.input_tokens;
    if (Number.isFinite(inputTokens)) {
      usage.input_tokens += inputTokens;
      if (trackLatest) {
        latestApiInputTokens = inputTokens > 0 ? inputTokens : undefined;
        latestApiEstimatedTokens = Number.isFinite(estimatedTokens)
          ? estimatedTokens
          : undefined;
      }
    }
    if (Number.isFinite(response?.usage?.output_tokens)) {
      usage.output_tokens += response.usage.output_tokens;
    }
    for (const key of ["cacheRead", "cacheWrite"]) {
      const value = response?.usage?.[key];
      if (Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
    }
  };

  const awaitWithAbort = async (promise) => {
    if (!signal) return promise;
    throwIfAborted(signal);
    let removeAbortListener;
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(abortError(signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      removeAbortListener?.();
    }
  };

  const waitForRetry = async (delay) => {
    const sleeping = Promise.resolve().then(() => sleepImpl(delay, signal));
    await awaitWithAbort(sleeping);
    throwIfAborted(signal);
  };

  const providerContext = {
    provider,
    mainSystem,
    cacheStablePrefix,
    tools: providerTools,
    signal,
    maxTokens,
    temperature,
    topP,
    stream,
    onDelta,
    onReasoningDelta,
    onToolCall,
    onUsage,
    retryOptions,
    retryAttempts,
    backoffBaseMs,
    backoffMaxMs,
    emitEvent,
    recordCompactionLayer: async ({
      layerId,
      round,
      triggered,
      tokensBefore,
      tokensAfter,
    }) => {
      if (
        layerId === "ttl"
        && Number.isFinite(triggered)
        && triggered > 0
        && !ttlInjectConsumed
      ) {
        ttlInjectArmed = true;
      }
      const layers = createEmptyCompactionLayers();
      observeCompactionLayer(layers, layerId, {
        triggered,
        tokensBefore,
        tokensAfter,
      });
      recordCompactionStat({
        tokensBefore,
        tokensAfter,
        layers,
      }, round);
    },
    reportObserverError,
    awaitWithAbort,
    waitForRetry,
    estimateMessageTokens,
    // TTL 折叠配置（issue #35）。终稿保护口径与 run-snapshot-executor 的 budgetHintFor 对齐：
    // 最后一轮（omitTools 终稿轮）/ 剩余轮数 <= 2 / 已发低预算提示时不折叠——
    // 收尾阶段模型常要回头引用早期证据，此时折叠净收益为负。返回 null = 本轮关闭。
    get toolResultFold() {
      const ttlLayer = getCompactionLayer("ttl");
      if (!ttlLayer?.shouldSchedule({
        budgetRounds,
        effectiveMaxRounds: governorState.effectiveMaxRounds,
        lowBudgetPrompted,
      })) return null;
      return { ttl: resolvedToolResultTtl, minTokens: toolResultFoldMinTokens };
    },
    get messages() {
      return messages;
    },
    set messages(value) {
      messages = value;
    },
    get roundEventDeltas() {
      return roundEventDeltas;
    },
    set roundEventDeltas(value) {
      roundEventDeltas = value;
    },
    get finalText() {
      return finalText;
    },
    set finalText(value) {
      finalText = value;
    },
    get declaredFindings() {
      return declaredFindings;
    },
    set declaredFindings(value) {
      declaredFindings = value;
    },
    get usage() {
      return usage;
    },
    get latestApiInputTokens() {
      return latestApiInputTokens;
    },
    set latestApiInputTokens(value) {
      latestApiInputTokens = value;
    },
    get latestApiEstimatedTokens() {
      return latestApiEstimatedTokens;
    },
    set latestApiEstimatedTokens(value) {
      latestApiEstimatedTokens = value;
    },
    get roundStopReason() {
      return roundStopReason;
    },
    set roundStopReason(value) {
      roundStopReason = value;
    },
  };
  const callProvider = (options) => runProvider(providerContext, options);

  const executedToolIds = new Set(resumeExecutedToolIds);
  const snapshotResults = new Map(resumeRunSnapshotResults);
  // issue #78：run snapshot 是可选 capability。优先新方法 saveRunSnapshot；
  // 旧名（saveCheckpoint/appendCheckpoint）作为过渡期 fallback 继续支持第三方 store；
  // 三者皆无 → 无快照能力：跳过快照持久化，工具照常执行（仅失去中途 crash resume）。
  const snapshotSaveMethod = typeof store?.saveRunSnapshot === "function"
    ? "saveRunSnapshot"
    : typeof store?.saveCheckpoint === "function"
      ? "saveCheckpoint"
      : typeof store?.appendCheckpoint === "function"
        ? "appendCheckpoint"
        : undefined;
  const hasRunSnapshotStore = persistenceRequired && snapshotSaveMethod !== undefined;
  const replayForToolUse = (toolUse) => {
    const resumedToolUse = resumePendingTools.find((candidate) => (
      candidate?.id === toolUse?.id
      && candidate?.name === toolUse?.name
    ));
    if (resumedToolUse?.replay === "safe" || resumedToolUse?.replay === "unsafe") {
      return resumedToolUse.replay;
    }
    const definition = Array.isArray(tools)
      ? tools.find((candidate) => candidate?.name === toolUse?.name)
      : undefined;
    return definition?.replay === "safe" ? "safe" : "unsafe";
  };
  const withReplayDeclaration = (toolUse) => (
    toolUse && typeof toolUse === "object"
      ? { ...toolUse, replay: replayForToolUse(toolUse) }
      : toolUse
  );
  const persistRunSnapshot = async ({
    round,
    pendingToolUse,
    pendingToolUses = [],
    toolResults = [],
    status = "pending",
    messagesOverride,
    partialText,
    partialRound,
  }) => {
    lastPersistenceFailure = undefined;
    const method = snapshotSaveMethod;
    if (method === undefined) {
      // 无快照能力：单条诊断（Set 去重，不每轮刷屏），工具照常执行。
      // persistence "none" 模式本来就不要求持久化，不诊断。
      if (persistenceRequired) notifyCapabilitySkipped("saveRunSnapshot");
      return false;
    }
    try {
      const snapshotPendingToolUse = withReplayDeclaration(pendingToolUse);
      const snapshotPendingToolUses = pendingToolUses.length > 0
        ? pendingToolUses.map(withReplayDeclaration)
        : pendingToolUse === undefined
          ? pendingToolUses
          : [snapshotPendingToolUse];
      return await persist(method, runId, {
        round,
        status,
        pendingToolUse: cloneState(snapshotPendingToolUse),
        toolUse: cloneState(snapshotPendingToolUse),
        pendingToolUses: cloneState(snapshotPendingToolUses),
        messages: cloneState(messagesOverride ?? messages),
        persistedTranscriptLength,
        executedToolIds: [...executedToolIds],
        toolResults: toolResults.map((toolResult) => ({
          toolUseId: toolResult.tool_use_id,
          toolResult: cloneState(toolResult),
        })),
        // 本 round 已归档的全量输出随 run snapshot 落盘，保证崩溃恢复后证据仍可核验
        toolOutputs: cloneState(archivedOutputs.filter((entry) => entry.round === round)),
        compactionStats: cloneState(compactionStats),
        ...(partialText === undefined ? {} : { partialText, partialRound }),
        ts: new Date().toISOString(),
      });
    } catch (error) {
      if (persistenceInfoFor(error) !== undefined) {
        lastPersistenceFailure = error;
        return false;
      }
      throw error;
    }
  };

  if (partialPersistenceConfig !== undefined && hasRunSnapshotStore) {
    const { intervalMs, minBytes } = partialPersistenceConfig;
    const maxTimerDelay = 2_147_483_647;
    let partialAttempt;

    const clearPartialTimer = (attempt) => {
      if (attempt.timer !== undefined) {
        clearTimeout(attempt.timer);
        attempt.timer = undefined;
      }
    };

    const commitPartialSnapshot = async (attempt) => {
      if (attempt.closed || attempt.inFlight !== undefined
        || !attempt.dirty || attempt.failure !== undefined) return;
      const partialText = attempt.text;
      attempt.dirty = false;
      const write = (async () => {
        try {
          await persistRunSnapshot({
            round: attempt.round,
            status: "pending",
            partialText,
            partialRound: attempt.round,
          });
          if (lastPersistenceFailure !== undefined) throw lastPersistenceFailure;
          attempt.persistedText = partialText;
        } catch (error) {
          attempt.failure = error;
          clearPartialTimer(attempt);
        }
      })();
      attempt.inFlight = write;
      await write;
      if (attempt.inFlight === write) attempt.inFlight = undefined;
      if (attempt.closed || attempt.failure !== undefined || !attempt.dirty) return;
      if (attempt.commitDue) {
        attempt.commitDue = false;
        void commitPartialSnapshot(attempt);
      }
    };

    const schedulePartialCommit = (attempt) => {
      if (attempt.timer !== undefined || attempt.closed || attempt.failure !== undefined) return;
      attempt.timerStartedAt = performance.now();
      const onTimer = () => {
        const remaining = intervalMs - (performance.now() - attempt.timerStartedAt);
        if (remaining > 0) {
          attempt.timer = setTimeout(onTimer, Math.min(remaining, maxTimerDelay));
          return;
        }
        attempt.timer = undefined;
        if (attempt.inFlight !== undefined) {
          attempt.commitDue = true;
          return;
        }
        void commitPartialSnapshot(attempt);
      };
      attempt.timer = setTimeout(onTimer, Math.min(intervalMs, maxTimerDelay));
    };

    providerContext.onPartialDelta = (chunk, round) => {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      if (partialAttempt === undefined || partialAttempt.round !== round) {
        partialAttempt = {
          round,
          text: "",
          dirty: false,
          timer: undefined,
          inFlight: undefined,
          commitDue: false,
          closed: false,
          persistedText: undefined,
          failure: undefined,
        };
      }
      partialAttempt.text += chunk;
      partialAttempt.dirty = true;
      if (minBytes === undefined || Buffer.byteLength(chunk, "utf8") >= minBytes) {
        schedulePartialCommit(partialAttempt);
      }
    };

    providerContext.onPartialAttemptEnd = async ({ round, retrying }) => {
      const attempt = partialAttempt;
      if (attempt === undefined || attempt.round !== round) return;
      attempt.closed = true;
      clearPartialTimer(attempt);
      try {
        if (attempt.inFlight !== undefined) await attempt.inFlight;
        if (attempt.failure !== undefined) throw attempt.failure;
        if (retrying && attempt.persistedText !== undefined) {
          await persistRunSnapshot({ round, status: "pending" });
          if (lastPersistenceFailure !== undefined) throw lastPersistenceFailure;
        }
      } finally {
        if (partialAttempt === attempt) partialAttempt = undefined;
      }
    };
  }

  const refreshRunState = async ({
    semantic = false,
    inject = false,
  } = {}) => {
    if (typeof todoStateProvider === "function") {
      try {
        todoState = await todoStateProvider({ runId, rounds });
      } catch (error) {
        todoState = {
          status: "error",
          detail: String(error?.message ?? error).slice(0, 80),
        };
      }
    }
    const deterministic = createDeterministicRunState({
      runId,
      stateVersion: runStateVersion,
      rounds,
      runRounds: budgetRounds,
      maxRounds: governorState.effectiveMaxRounds,
      lowBudgetPrompted,
      toolStats,
      filesWritten: governorState.filesWritten,
      todo: todoState,
      foldedRounds: foldedRoundCount,
      navigationRecords: navigationRecordCount,
      terminationReason: currentTerminationReason,
      toolErrorCount,
      // 键名保持旧名 checkpointFailureCount（issue #83）：它是 createDeterministicRunState 的
      // 导出选项键，且其值以 `errors.checkpoint` 落盘、渲染进模型可见的 run-state 文本行——
      // 三处均属宿主/持久化契约，改名是破坏性变更，故此处只改引擎内部变量名、不改键名。
      checkpointFailureCount: runSnapshotFailureCount,
      unpersisted: errorLedger.toUnpersisted(),
      compactionStats,
    });
    if (semantic && typeof semanticStateProvider === "function") {
      try {
        const provided = await semanticStateProvider({
          runId,
          state: deterministic,
          previous: semanticState,
        });
        if (provided !== undefined) semanticState = provided;
      } catch (error) {
        semanticState = {
          status: "error",
          text: "",
          semanticStateVersion: runStateVersion,
          detail: String(error?.message ?? error).slice(0, 80),
        };
      }
    } else if (
      semanticState
      && semanticState.semanticStateVersion !== undefined
      && semanticState.semanticStateVersion !== runStateVersion
    ) {
      semanticState = {
        ...semanticState,
        status: "stale",
      };
    }
    currentRunState = withSemanticRunState({
      ...deterministic,
      stateAvailability: { ...runStateAvailability },
    }, semanticState);
    currentRunState.rendered = renderRunState(currentRunState);
    if (inject) messages = upsertRunStateInMessages(messages, currentRunState.rendered);
    await persist("saveRunState", runId, currentRunState);
    return currentRunState;
  };

  const terminationContext = {
    finalGuard,
    finalGuardTimeout,
    toolSignal,
    signal,
    awaitWithAbort,
    emitEvent,
    guardMetrics,
    addUsage,
    estimateMessageTokens,
    mainSystem,
    cacheStablePrefix,
    maxTokens,
    temperature,
    topP,
    provider,
    wrapupEnabled,
    throwIfAborted,
    messageRounds,
    usage,
    compactionStats,
    refreshRunState,
    markRunState,
    fail,
    // issue #165：终局汇总记录的发射口（实现在上方 fail 附近，自己吞宿主回调抛错）。
    emitRunOutcome,
    errorLedger,
    get messages() {
      return messages;
    },
    get finalText() {
      return finalText;
    },
    set finalText(value) {
      finalText = value;
    },
    get declaredFindings() {
      return declaredFindings;
    },
    set declaredFindings(value) {
      declaredFindings = value;
    },
    get rounds() {
      return rounds;
    },
    get lastAssistantContent() {
      return lastAssistantContent;
    },
    set lastAssistantContent(value) {
      lastAssistantContent = value;
    },
    get roundStopReason() {
      return roundStopReason;
    },
    set roundStopReason(value) {
      roundStopReason = value;
    },
    get forcedFinal() {
      return forcedFinal;
    },
    set forcedFinal(value) {
      forcedFinal = value;
    },
    get verification() {
      return verification;
    },
    set verification(value) {
      verification = value;
    },
    get currentRunState() {
      return currentRunState;
    },
    get currentTerminationReason() {
      return currentTerminationReason;
    },
    set currentTerminationReason(value) {
      currentTerminationReason = value;
    },
  };
  const terminationManager = createTerminationManager(terminationContext);
  const {
    callFinalGuard,
    forceFinalIfNeeded,
    finish,
  } = terminationManager;

  const callRoundJudge = async (round, currentL0, { timeoutMs, conversationBudgetTokens } = {}) => {
    const l0Facts = [...governorState.l0Facts, { round, ...currentL0 }];
    const recentErrors = l0Facts
      .flatMap((fact) => fact.errorTexts ?? (fact.errorText ? [fact.errorText] : []))
      .filter((text, index, values) => values.indexOf(text) === index)
      .slice(-5);
    const judge = effectiveReflection?.judge;
    const evaluator = judge?.provider ?? judge?.evaluator ?? provider;
    const nearLimit = budgetRounds >= Math.floor(
      governorState.effectiveMaxRounds * 0.8,
    );
    const request = {
      system: "你是交付评审者，独立判断任务是否完成。只输出 JSON。",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: buildJudgePrompt(
            taskBrief,
            budgetRounds,
            governorState.timeline,
            governorState.filesWritten,
            recentErrors,
            renderConversation(messages, {
              maxTokens: Number.isFinite(conversationBudgetTokens)
                ? conversationBudgetTokens
                : undefined,
            }),
            {
              budgetRounds,
              effectiveMaxRounds: governorState.effectiveMaxRounds,
              extensionCount: governorState.extensionCount,
              maxExtensions: reflectionMaxExtensions,
              nearLimit,
            },
          ),
        }],
      }],
      // 2026-09-20 基准实测：judge 只输出一段 JSON，8000 上限纯浪费（输出越长漂移越大）；
      // 但 512 实测会被 glm 冗长 JSON 截断致 parse 失败 → 1024。
      maxTokens: 1024,
      temperature: 0,
      // judge 继续发送 reasoning_effort:"none"（统一语义=不思考）；OpenAI provider
      // 的 payload 层会将 GLM 系模型自动转译为 "low"（见
      // src/providers/payload.js 的 OpenAI 载荷组装出口），因为该 relay 把 GLM 的
      // "none" 处理成思考漏进 content。deepseek/qwen 在同一 relay 上语义正确，不受影响。
      reasoning_effort: "none",
    };
    let timeoutController;
    let timeoutId;
    let removeParentAbort;
    if (timeoutMs !== undefined) {
      timeoutController = new AbortController();
      request.signal = timeoutController.signal;
      if (signal !== undefined) {
        const onParentAbort = () => timeoutController.abort(signal.reason);
        if (signal.aborted) onParentAbort();
        else signal.addEventListener("abort", onParentAbort, { once: true });
        removeParentAbort = () => signal.removeEventListener("abort", onParentAbort);
      }
    } else if (signal !== undefined) {
      request.signal = signal;
    }
    const responsePromise = Promise.resolve().then(() => (
      typeof evaluator === "function"
        ? evaluator(request)
        : evaluator.chat(request)
    ));
    let response;
    try {
      if (timeoutMs === undefined) {
        response = await awaitWithAbort(responsePromise);
      } else {
        response = await Promise.race([
          awaitWithAbort(responsePromise),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              timeoutController.abort(new Error("Judge interception timed out"));
              const error = new Error("Judge interception timed out");
              error.code = "judge_intercept_timeout";
              reject(error);
            }, timeoutMs);
          }),
        ]);
      }
    } finally {
      clearTimeout(timeoutId);
      removeParentAbort?.();
    }
    addUsage(response, undefined, { trackLatest: false });
    // 带出当次 judge 调用的用量（issue #33 B）：judge.log / 逐轮 transcript 可对账；
    // 超时/出错路径 response 为 undefined，usage 缺省（调用方不设置该字段）。
    const inputTokens = response?.usage?.input_tokens;
    const outputTokens = response?.usage?.output_tokens;
    const judgeUsage = Number.isFinite(inputTokens) || Number.isFinite(outputTokens)
      ? {
        ...(Number.isFinite(inputTokens) ? { input_tokens: inputTokens } : {}),
        ...(Number.isFinite(outputTokens) ? { output_tokens: outputTokens } : {}),
      }
      : undefined;
    // 原始输出未截断带出（可审计性）：intercept 落 judge.log 时截断由调用方负责。
    const rawText = textFromBlocks(blocksFor(response?.content));
    return {
      decision: parseJudgeDecision(rawText),
      usage: judgeUsage,
      raw: rawText,
    };
  };

  const runSnapshotContext = {
    runId,
    executeTool,
    baseToolContext,
    outputHygieneEnabled,
    outputHygieneLimit,
    aggregateBudgetTokens,
    emitEvent,
    archivedOutputs,
    toolSignal,
    signal,
    onToolResult,
    // issue #173 PR-B：onToolResult 的异常 fallback（保留原始结果）要把错误记回同一个观察者
    // 通道，故在此透传 reportObserverError（不新建平行机制）。
    reportObserverError,
    persistRunSnapshot,
    hasRunSnapshotStore,
    toolStats,
    governorState,
    get budgetRounds() {
      return budgetRounds;
    },
    awaitWithAbort,
    emitJudge,
    callRoundJudge,
    judgeInterceptEnabled,
    judgeIntervalRound,
    judgeInterceptTimeoutMs,
    judgeInterceptConversationTokens,
    get messages() {
      return messages;
    },
    markToolExecuted() {
      toolExecutedThisRound = true;
    },
    get lowBudgetPrompted() {
      return lowBudgetPrompted;
    },
    set lowBudgetPrompted(value) {
      lowBudgetPrompted = value;
    },
    get toolErrorCount() {
      return toolErrorCount;
    },
    set toolErrorCount(value) {
      toolErrorCount = value;
    },
    get runSnapshotFailureCount() {
      return runSnapshotFailureCount;
    },
    set runSnapshotFailureCount(value) {
      runSnapshotFailureCount = value;
    },
    get lastPersistenceFailure() {
      return lastPersistenceFailure;
    },
    set lastPersistenceFailure(value) {
      lastPersistenceFailure = value;
    },
    get judgeInterceptCount() {
      return judgeInterceptCount;
    },
    set judgeInterceptCount(value) {
      judgeInterceptCount = value;
    },
    get interceptJudgeDecision() {
      return interceptJudgeDecision;
    },
    set interceptJudgeDecision(value) {
      interceptJudgeDecision = value;
    },
    executedToolIds,
    snapshotResults,
    // 「没存上」账本（ADR-016）：聚合层 fail-closed 丢原文时必须留痕——
    // main 退役了 run-state 的 errors.archive 计数，账本是其继任通道
    errorLedger,
  };
  const runSnapshotExecutor = createRunSnapshotExecutor(runSnapshotContext);
  const {
    executeToolWithIntercept,
    pendingDirectionHints,
  } = runSnapshotExecutor;

  const roundNumbersForMessages = (currentMessages) => {
    const grouped = groupIntoRounds(currentMessages).rounds;
    return grouped.map((group, index) => {
      const known = group.messages
        .map((message) => messageRounds.get(message))
        .find((roundNumber) => Number.isSafeInteger(roundNumber) && roundNumber > 0);
      return known ?? foldedThrough + index + 1;
    });
  };

  const compactBeforeRound = async (round = rounds + 1) => {
    normalizeMessages(messages);
    const configuredStrategy = compactionContext?.strategy;
    // API input usage is per request; keep the aggregate for billing output.
    // 压缩判断：主用本地估算（真实上下文大小），API usage 辅助取单轮完整输入
    // Some APIs report full historical input; cumulative usage is billable input
    // and can otherwise trigger compaction too early.
    const apiInputTokens = latestApiInputTokens;
    const estimatedTokens = estimateMessageTokens(messages);
    const overBudget = budgetTokens !== undefined
      && (estimatedTokens > budgetTokens || isApiInputOverBudget(apiInputTokens, budgetTokens));
    const strategyRequestsCompaction = configuredStrategy
      ? await configuredStrategy.shouldCompact(messages, budgetTokens)
      : false;
    let foldedPayload = [];
    let foldedRoundRange;
    let navigationRecord;
    let foldedRounds = 0;
    let compacted = false;
    let protectedDowngraded = 0;
    if (strategyRequestsCompaction || overBudget) {
      const [budgetFallbackLayer, safetyFallbackLayer] = getCompactionFallbackChain();
      const strategy = strategyRequestsCompaction
        ? configuredStrategy
        : createSlidingWindowStrategy();
      // messages 自 estimatedTokens 起只被读取（shouldCompact 为纯判定），直接复用（#172 A2）
      const tokensBefore = estimatedTokens;
      const layers = createEmptyCompactionLayers();
      const selectedLayer = getCompactionLayerForStrategy(strategy);
      const configuredKeepRounds = compactionContext.keepRounds ?? 6;
      // 上下文膨胀到预算 2 倍以上时收紧 keepRounds（防折叠后立刻再超预算的恶性循环）
      const keepRounds = estimatedTokens / budgetTokens > 2
        ? Math.min(configuredKeepRounds, 2)
        : configuredKeepRounds;
      const compactOptions = {
        keepRounds,
        budgetTokens,
      };
      Object.defineProperty(compactOptions, "roundNumbers", {
        value: roundNumbersForMessages(messages),
        enumerable: false,
      });
      if (foldedThrough > 0) compactOptions.roundOffset = foldedThrough;
      Object.defineProperty(compactOptions, "onLayer", {
        enumerable: false,
        value: ({
        layerId,
        tokensBefore: layerTokensBefore,
        tokensAfter: layerTokensAfter,
        }) => {
          observeCompactionLayer(layers, layerId, {
            tokensBefore: layerTokensBefore,
            tokensAfter: layerTokensAfter,
          });
        },
      });
      for (const key of [
        "summaryRole",
        "protectedMessage",
        "stripHistoricalImages",
        "onBeforeFold",
        "onAfterFold",
        "stubFor",
      ]) {
        if (compactionContext[key] !== undefined) compactOptions[key] = compactionContext[key];
      }
      const result = await strategy.compact(messages, compactOptions);
      if (!Array.isArray(result?.messages)) {
        throw new TypeError("Compaction strategy must return a messages array");
      }
      let compactedMessages = result.messages;
      foldedPayload = Array.isArray(result.foldedPayload)
        ? result.foldedPayload
        : [];
      foldedRoundRange = result.foldedRoundRange;
      navigationRecord = result.navigationRecord;
      foldedRounds = Number.isSafeInteger(result.foldedRounds)
        ? result.foldedRounds
        : 0;
      compacted = result.compacted === true;
      protectedDowngraded = 0;
      let tokensAfter = estimateMessageTokens(compactedMessages);
      if (selectedLayer !== undefined && foldedRounds > 0) {
        observeCompactionLayer(layers, selectedLayer.id, {
          tokensBefore,
          tokensAfter,
        });
      }
      const apiEstimateBefore = latestApiEstimatedTokens ?? tokensBefore;
      let apiTokensAfter = projectedApiInputTokens(
        apiInputTokens,
        apiEstimateBefore,
        tokensAfter,
      );
      if (
        (budgetTokens !== undefined && tokensAfter > budgetTokens)
        || isApiInputOverBudget(apiTokensAfter, budgetTokens)
      ) {
        // 同一 compactedMessages，自 tokensAfter 之后只做了 observeCompactionLayer /
        // 投影计算（#172 A2：复用上一次全量估算，不再重跑）
        const fallbackTokensBefore = tokensAfter;
        const fallback = await createSlidingWindowStrategy().compact(compactedMessages, {
          keepRounds: 0,
          budgetTokens,
          protectedMessage: compactionContext.protectedMessage,
          stripHistoricalImages: compactionContext.stripHistoricalImages,
          stubFor: compactionContext.stubFor,
          roundOffset: foldedThrough,
          roundNumbers: roundNumbersForMessages(compactedMessages),
        });
        compactedMessages = fallback.messages;
        foldedPayload = [...foldedPayload, ...(fallback.foldedPayload ?? [])];
        foldedRounds += fallback.foldedRounds ?? 0;
        compacted = compacted || fallback.compacted === true;
        if (foldedRoundRange === undefined) foldedRoundRange = fallback.foldedRoundRange;
        if (fallback.navigationRecord !== undefined) {
          navigationRecord = mergeFoldNavigationRecords(
            [navigationRecord, fallback.navigationRecord],
            foldedRoundRange,
          );
        }
        tokensAfter = estimateMessageTokens(compactedMessages);
        if (fallback.foldedRounds > 0) {
          observeCompactionLayer(layers, budgetFallbackLayer?.id, {
            tokensBefore: fallbackTokensBefore,
            tokensAfter,
          });
        }
        apiTokensAfter = projectedApiInputTokens(
          apiInputTokens,
          apiEstimateBefore,
          tokensAfter,
        );
      }
      if (
        (budgetTokens !== undefined && tokensAfter > budgetTokens)
        || isApiInputOverBudget(apiTokensAfter, budgetTokens)
      ) {
        // 同一 compactedMessages，与下方 safety 层的 tokensBefore 等价（#172 A2）
        const safetyTokensBefore = tokensAfter;
        const apiAwareBudget = isApiInputOverBudget(apiTokensAfter, budgetTokens)
          ? Math.max(
            1,
            Math.floor(budgetTokens * apiEstimateBefore / apiInputTokens),
          )
          : budgetTokens;
        const fallback = await safeTruncateMessages(
          compactedMessages,
          apiAwareBudget,
          compactionContext.protectedMessage,
          compactionContext.stubFor,
        );
        compactedMessages = fallback.messages;
        foldedPayload = [...foldedPayload, ...(fallback.foldedPayload ?? [])];
        compacted = compacted || fallback.protectedDowngraded > 0;
        tokensAfter = fallback.tokensAfter;
        protectedDowngraded = fallback.protectedDowngraded;
        observeCompactionLayer(layers, safetyFallbackLayer?.id, {
          tokensBefore: safetyTokensBefore,
          tokensAfter,
        });
      }
      messages = compactedMessages;
      latestApiInputTokens = undefined;
      latestApiEstimatedTokens = undefined;
      hadToolUse = hadToolUse || hasToolUseInMessages(messages);
      if (foldedRoundRange?.to !== undefined) {
        foldedThrough = Math.max(foldedThrough, foldedRoundRange.to);
      }
      if (
        foldedRounds > 0
        || foldedRoundRange !== undefined
        || navigationRecord !== undefined
      ) {
        foldedRoundCount += foldedRounds;
        if (navigationRecord !== undefined) navigationRecordCount += 1;
      }
      const compactionStat = {
        compacted,
        foldedRounds,
        tokensBefore,
        tokensAfter,
        layers,
      };
      recordCompactionStat({
        ...compactionStat,
        protectedDowngraded,
      }, round);
    }
    const foldedStateChanged = foldedRounds > 0
      || foldedRoundRange !== undefined
      || navigationRecord !== undefined;
    // 低预算按本次调用的 budgetRounds 计算；resume 时不能用跨会话身份轮号 rounds。
    const remainingRounds = governorState.effectiveMaxRounds - budgetRounds;
    const isLowBudget = remainingRounds <= 2;
    const persistInject = foldedStateChanged;
    const requestInject = !persistInject
      && (ttlInjectArmed || (isLowBudget && !lowBudgetInjectFired));
    // 折叠轮优先把新鲜状态持久挂到摘要块（通道 A）；只有没有持久挂载时，
    // 才追加请求视图尾部（通道 B），避免同一轮同时产生两个 run-state 块。
    if (persistInject || requestInject) {
      runStateVersion += 1;
      if (requestInject && ttlInjectArmed) {
        // TTL 首折和低预算门各只消费一次，避免每轮改写破坏前缀缓存。
        ttlInjectArmed = false;
        ttlInjectConsumed = true;
      }
      if (requestInject && isLowBudget && !lowBudgetInjectFired) {
        lowBudgetInjectFired = true;
      }
    }
    const runState = (
      strategyRequestsCompaction
      || overBudget
      || persistInject
      || requestInject
    )
      ? await refreshRunState({
          semantic: persistInject || requestInject,
          inject: persistInject,
        })
      : undefined;
    normalizeMessages(messages);
    return {
      folded: compacted,
      foldedPayload: compacted ? foldedPayload : undefined,
      foldedRoundRange,
      navigationRecord,
      runState,
      requestStateBlock: requestInject ? runState?.rendered : undefined,
    };
  };

  const appendToolResultsToTranscript = (toolResults, roundNumber) => {
    if (toolResults.length === 0) return;
    const target = mergeToolResultsIntoMessages(messages, toolResults);
    if (target !== false) {
      if (roundNumber !== undefined) {
        messageRounds.set(target, roundNumber);
      }
      return;
    }
    const message = { role: "user", content: toolResults };
    messages.push(message);
    if (roundNumber !== undefined) messageRounds.set(message, roundNumber);
  };

  const appendResumeTailMessages = () => {
    for (const entry of resumeTailMessages) {
      const message = cloneState(entry.message);
      messages.push(message);
      messageRounds.set(message, entry.round);
    }
    resumeTailMessages = [];
  };

  try {
    await refreshRunState();
    // resume 后注入旗标按本次 run 重置；后续 TTL 折叠/低预算会重新注入请求视图，
    // 无需把 run-state 写入 run snapshot 或持久 transcript。
    ttlInjectArmed = false;
    ttlInjectConsumed = false;
    lowBudgetInjectFired = false;
    throwIfAborted(signal);
    if (resumePendingTools.length > 0) {
      const resumedToolResults = [];
      for (const [index, resumePendingTool] of resumePendingTools.entries()) {
        const resumedToolUse = { ...resumePendingTool };
        delete resumedToolUse.replay;
        emitEvent({ type: "tool_use", round: rounds, toolUse: cloneState(resumedToolUse) });
        if (replayPolicy === "per-tool-declaration" && resumePendingTool.replay !== "safe") {
          const existingToolResult = messages
            .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
            .find((block) => (
              block?.type === "tool_result"
              && block.tool_use_id === resumePendingTool.id
            ));
          const partialOutput = [
            archivedOutputs.find((output) => output.toolUseId === resumePendingTool.id)?.content,
            existingToolResult?.content,
          ]
            .filter((content, outputIndex, outputs) => (
              typeof content === "string"
              && content.length > 0
              && outputs.indexOf(content) === outputIndex
            ))
            .join("\n\n");
          const toolResult = {
            type: "tool_result",
            tool_use_id: resumePendingTool.id,
            content: "The previous execution was interrupted before its outcome could be recorded. "
              + "This unsafe tool was not replayed; the host must decide whether to retry it."
              + (typeof partialOutput === "string" && partialOutput.length > 0
                ? `\n\nPreviously captured partial output:\n${partialOutput}`
                : ""),
            is_error: true,
            executionStatus: "interrupted",
          };
          if (existingToolResult) {
            existingToolResult.content = toolResult.content;
            existingToolResult.is_error = true;
            existingToolResult.executionStatus = "interrupted";
          }
          resumedToolResults.push(toolResult);
          emitEvent({
            type: "tool_replay_decision_required",
            runId,
            round: rounds,
            toolUseId: resumePendingTool.id,
            toolName: resumePendingTool.name,
            replay: "unsafe",
            requiresHostDecision: true,
            partialOutputAvailable: partialOutput.length > 0,
          });
          emitEvent({ type: "tool_result", round: rounds, toolResult: cloneState(toolResult) });
          continue;
        }
        await executeToolWithIntercept(
          resumedToolUse,
          rounds,
          resumedToolResults,
          resumePendingTools.slice(index),
        );
      }
      appendToolResultsToTranscript(resumedToolResults, rounds);
      // resume 路径也 flush 方向提示（与主循环一致，限 2 条；独立 user text 消息）
      if (pendingDirectionHints.length > 0) {
        const hints = pendingDirectionHints.length > 2
          ? [...pendingDirectionHints.slice(0, 2), "（另有多次方向提示已合并）"]
          : [...pendingDirectionHints];
        const hintMessage = {
          role: "user",
          meta: { source: "judge-control" },
          content: hints.map((text) => ({ type: "text", text })),
        };
        messages.push(hintMessage);
        if (rounds !== undefined) messageRounds.set(hintMessage, rounds);
        pendingDirectionHints.length = 0;
      }
      resumePendingTools = [];
    }
    if (resumeRunSnapshot && resumeTranscriptStart !== undefined) {
      const resumeRecordMessages = messages.slice(resumeTranscriptStart);
      const resumeMessagesToPersist = [
        ...resumeRunSnapshotMessages,
        ...resumeRecordMessages,
      ];
      const persisted = await persist("appendRound", runId, {
        round: resumeRunSnapshot.round,
        roundKey: `${String(runId)}:round:${String(resumeRunSnapshot.round)}`,
        // 引擎命名空间：宿主可能已用默认键 `${runId}:round:N` 写入自己的行（追问/历史种子），
        // 同键会被 appendRound 去重 → 续接轮（含补跑工具结果）落盘被静默丢弃，
        // transcript 只剩宿主那条近空行（issue #32 #8）。`:resume` 幂等，重启重跑不重复写。
        dedupKey: `${String(runId)}:engine:round:${String(resumeRunSnapshot.round)}:resume`,
        messages: cloneState(resumeMessagesToPersist),
        ...(archivedOutputs.some((entry) => entry.round === resumeRunSnapshot.round)
          ? {
            toolOutputs: archivedOutputs
              .filter((entry) => entry.round === resumeRunSnapshot.round)
              .map(({ toolUseId, name, content }) => ({ toolUseId, name, content })),
          }
          : {}),
        ts: new Date().toISOString(),
      });
      if (persisted) persistedTranscriptLength += resumeMessagesToPersist.length;
      resumeTranscriptStart = undefined;
      resumeRunSnapshotMessages = [];
    }
    appendResumeTailMessages();

    // 预算条件用 budgetRounds（本次 runToolLoop 的消耗），不是身份轮号 rounds：
    // resume 续接时 rounds 已到顶，用它当预算会导致续接轮一次进不了循环。
    while (budgetRounds < governorState.effectiveMaxRounds) {
    // 轮预算在进入本轮时自增（与既有 `round` 语义对齐：budgetRounds === 本轮序号），
    // 这样预算提示 / 剩余轮数在工具执行期读到的就是正确值
    budgetRounds += 1;
    const round = rounds + 1;
    toolExecutedThisRound = false;
    interceptJudgeDecision = undefined;
    roundEventDeltas = [];
    roundStopReason = undefined;
    let stallSuspicion = false;
    let stallSignature = null;
    let lastSignatureThisRound = null;
    emitEvent({ type: "round_start", round });
    const compactionStatsStart = compactionStats.length;
    const compaction = await compactBeforeRound(round);
    let requestStateBlock = compaction.requestStateBlock;
    const roundStart = messages.length;
    // 预算兜底（2026-09-20 基准实测：剩余轮数耗尽时模型无视文字提示继续调工具，
    // 撞 max_rounds 被 truncate，靠 wrapup 全量重发历史 + 额外 4 分钟兜底）：
    // 本轮是最后一个预算轮时不带 tools，强制输出文本终稿。此时消息历史里所有
    // tool_use 均已配平 tool_result（结果总在下一轮请求前追加），无 tools 请求安全。
    const isFinalBudgetRound = budgetRounds >= governorState.effectiveMaxRounds;
    let providerResult = await callProvider({
      round,
      omitTools: isFinalBudgetRound,
      requestStateBlock,
    });
    let response = providerResult.response;
    let content = blocksFor(response?.content);

    const assistantMessage = { role: "assistant", content };
    messages.push(assistantMessage);
    messageRounds.set(assistantMessage, round);
    addUsage(response, providerResult.estimatedTokens);
    if (!providerResult.usageEmitted && response?.usage !== undefined) {
      emitEvent({ type: "usage", round, usage: response.usage });
    }
    roundStopReason = response?.stopReason;

    let tokenContinuationCount = 0;
    while (response?.stopReason === "max_tokens"
      && tokenContinuationCount < continuationLimit) {
      // reasoning 模型单次响应常因推理过长触发 max_tokens 截断；
      // 若 messages 已超预算，先压缩再补全，避免截断循环耗尽预算（Issue #11）
      if (budgetTokens !== undefined
        && (
          estimateMessageTokens(messages) > budgetTokens
          || isApiInputOverBudget(latestApiInputTokens, budgetTokens)
        )) {
        const continuationCompaction = await compactBeforeRound(round);
        requestStateBlock = continuationCompaction.requestStateBlock;
      }
      tokenContinuationCount += 1;
      providerResult = await callProvider({
        allowPendingToolUse: true,
        round,
        omitTools: isFinalBudgetRound,
        requestStateBlock,
      });
      response = providerResult.response;
      const continuation = blocksFor(response?.content);
      const assistant = messages.at(-1);
      if (assistant?.role === "assistant") {
        assistant.content = appendAssistantContent(assistant.content, continuation);
        content = appendAssistantContent(content, continuation);
      } else {
        content = appendAssistantContent(content, continuation);
        const assistantMessage = { role: "assistant", content };
        messages.push(assistantMessage);
        messageRounds.set(assistantMessage, round);
      }
      addUsage(response, providerResult.estimatedTokens);
      if (!providerResult.usageEmitted && response?.usage !== undefined) {
        emitEvent({ type: "usage", round, usage: response.usage });
      }
      roundStopReason = response?.stopReason;
    }
    const continuationExhausted = response?.stopReason === "max_tokens"
      && tokenContinuationCount >= continuationLimit;
    lastAssistantContent = content;
    const responseText = textFromBlocks(content);
    // OpenAI 规范：finish_reason=stop 是模型自然停止的唯一标识。
    // 但社区实测存在 stop 但 content 带 tool_calls 的边界（非标准）——双保险：stop && 无 tool_use
    // 才算真正说完（tool_calls 轮即使报 stop 也是要调工具，不该 judge/wrapup）
    const isEndTurn = roundStopReason === "end_turn" && !hasToolUse(content);
    const wrapupJson = wrapupEnabled && isEndTurn
      ? tryParseWrapupJson(responseText)
      : null;
    const parsedSummary = parseL1Summary(responseText);
    declaredFindings = wrapupJson?.findings;
    let roundSummary = wrapupJson === null
      ? parsedSummary.summary
      : wrapupJson.summary;
    content = content.map((block) => (
      block?.type === "text"
        ? { ...block, text: parseL1Summary(block.text).text }
        : block
    ));
    const assistant = messages.at(-1);
    if (assistant?.role === "assistant") assistant.content = content;
    finalText = textFromBlocks(content);
    if (wrapupJson !== null) {
      finalText = wrapupJson.output || wrapupJson.summary;
    }

    if (hasToolUse(content)) {
      hadToolUse = true;
      governorState.noToolStreak = 0;
    }

    if (response?.stopReason === "tool_use") {
      const toolResults = [];
      const pendingToolUses = content.filter((candidate) => candidate?.type === "tool_use");
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        emitEvent({ type: "tool_use", round, toolUse: cloneState(block) });

        const signature = `${block.name}${JSON.stringify(block.input)}`;
        const stalled = stallMode === "consecutive"
          ? recentSignatures.length >= stallWindow
            && recentSignatures.slice(-stallWindow).every((recent) => recent === signature)
          : recentSignatures.length >= stallWindow
            && recentSignatures.includes(signature);
        if (stallWindow > 0 && stalled) {
          stallSuspicion = true;
          stallSignature = signature;
          recentSignatures.length = 0;
        }
        lastSignatureThisRound = signature;
        if (stallWindow > 0) {
          recentSignatures.push(signature);
          if (recentSignatures.length > stallWindow) recentSignatures.shift();
        }

        const recordedToolResult = snapshotResults.get(block.id);
        const toolResult = executedToolIds.has(block.id) && recordedToolResult !== undefined
          ? cloneState(recordedToolResult)
          : await executeToolWithIntercept(
            block,
            round,
            toolResults,
            pendingToolUses.slice(pendingToolUses.findIndex((candidate) => candidate === block)),
          );
        if (!toolResults.includes(toolResult)) toolResults.push(toolResult);
        emitEvent({ type: "tool_result", round, toolResult: cloneState(toolResult) });
      }
      if (toolResults.length > 0) {
        const toolResultMessage = { role: "user", content: toolResults };
        messages.push(toolResultMessage);
        messageRounds.set(toolResultMessage, round);
      }
      if (pendingDirectionHints.length > 0) {
        // 方向提示独立 user text 消息（模型可见，但不混入 tool_result 事实链——避免污染后续 judge 输入）
        // 限 2 条/轮防膨胀（同轮多个 off_track 合并）
        const hints = pendingDirectionHints.length > 2
          ? [...pendingDirectionHints.slice(0, 2), "（另有多次方向提示已合并）"]
          : [...pendingDirectionHints];
        const hintMessage = {
          role: "user",
          meta: { source: "judge-control" },
          content: hints.map((text) => ({ type: "text", text })),
        };
        messages.push(hintMessage);
        messageRounds.set(hintMessage, round);
        pendingDirectionHints.length = 0;
      }
    }
    // streak 只累积 stalled 命中；出现不同签名（模型转向）才清零
    if (stallSuspicion) {
      stallStreak += 1;
      lastStallSignature = stallSignature;
    } else if (lastStallSignature !== null && lastSignatureThisRound !== null
      && lastSignatureThisRound !== lastStallSignature) {
      // 本轮调用了与上次 stalled 不同的签名 → 模型转向，清零
      stallStreak = 0;
      lastStallSignature = null;
    }

    let shouldContinue = response?.stopReason === "tool_use"
      || (wrapupJson !== null && wrapupJson.done === false);
    let normalizedWrapup = null;
    let completionSignalDetected = wrapupJson?.done === true
      || (wrapupJson === null && completionSignals.some(
      (completionSignal) => typeof completionSignal === "string"
        && finalText.includes(completionSignal),
      ));
    // LLM 归一化兑底：end_turn + 无工具 + 没解析出 JSON（含空文本/自然语言/杂讯）→
    // 调 judge 归一化为 {done,summary,output}，统一交给下游判定。
    // 触发条件刻意宽松：找不到 JSON 就该归一化（覆盖空文本/难任务放弃场景）。
    if (
      wrapupJson === null
      && response?.stopReason === "end_turn"
      && !hasToolUse(content)
      && wrapupNormalizationEnabled
    ) {
      try {
        const requestForJudge = {
          system: "你是输出协议归一化器，只输出有效 JSON。",
          messages: [{
            role: "user",
            content: [{ type: "text", text: `【归一化】判断 agent 是否完成任务。
任务目标：${taskBrief || "（未提供）"}
已运行轮数：${rounds}
本轮 agent 最终输出（可能为空）：${JSON.stringify(responseText).slice(0, 2000)}
若 agent 已给出明确结论/产物就绪则 done=true；若它在工作中途停下/放弃则判断产出是否可判定，可判定则 done=true 否则 done=false。
只输出 JSON：{"done":true|false,"summary":"任务总结或当前进展","output":"给用户的最终结果","findings":{"label":"value"}}。findings 只做搬运：value 必须逐字摘自本轮 agent 原文（原样复制，不得改写/规整/补全/翻译，包括引号与标点）；原文里抄不到的值的就省略该条，宁可少写。` }],
          }],
          signal,
        };
        if (maxTokens !== undefined) requestForJudge.maxTokens = maxTokens;
        if (temperature !== undefined) requestForJudge.temperature = temperature;
        const judgeResponse = await awaitWithAbort(wrapupEvaluator.chat(requestForJudge));
        addUsage(judgeResponse, undefined, { trackLatest: false });
        const candidate = tryParseWrapupJson(
          textFromBlocks(blocksFor(judgeResponse?.content)),
        );
        if (candidate !== null) {
          // 归一化只许“搬运”：LLM 给出的每个 finding 值必须是 agent 原文的逐字子串；
          // 不是就丢掉该条（不得靠 LLM 改写去“修好”模型输出，那会把核验变成不可复现）。
          candidate.findings = filterFindingsBySource(candidate.findings, responseText);
          normalizedWrapup = candidate;
          if (candidate.summary !== "" || candidate.output !== "") {
            roundSummary = candidate.summary || candidate.output || roundSummary;
          }
          if (candidate.done === true) {
            shouldContinue = false;
            completionSignalDetected = true;
            if (candidate.output !== "" || candidate.summary !== "") {
              finalText = candidate.output || candidate.summary || finalText;
            }
          } else {
            shouldContinue = true;
          }
        } else {
          // 归一化失败：关闭开关，避免每轮都烧 token
          wrapupNormalizationEnabled = false;
        }
      } catch {
        // 归一化失败降级：走现有 noToolStreak/completion 兑底，不崩 loop
      }
    }
    // LLM 归一化路径也要把 findings 透给 guard——否则模型没用 JSON 信封时，
    // 归一化出来的声明会静默消失，guard 只能看到“没声明”
    if (normalizedWrapup?.findings !== undefined) {
      declaredFindings = normalizedWrapup.findings;
    }
    // 失忆兑底：超过 5 轮后模型若输出欢迎语（误以为新会话），注入任务提醒并继续
    // （上下文折叠可能让模型丢失任务感；此处把主线拉回，避免空转）
    const memoryLossDetected = budgetRounds > 5
      && wrapupJson === null
      && !hasToolUse(content)
      && isLikelyWelcomeResponse(finalText);
    const noToolRound = !hasToolUse(content)
      && completionEnabled
      && !completionSignalDetected
      && hadToolUse;
    if (hasToolUse(content)) {
      governorState.noToolStreak = 0;
    } else if (noToolRound) {
      governorState.noToolStreak += 1;
    }

    // 身份轮号自增（非 resume 单段调用 budgetRounds 与 rounds 恒等；resume 后 rounds 领先）
    rounds = round;
    const currentRoundMessages = messages.slice(roundStart);
    const currentL0 = extractL0Facts(currentRoundMessages, {
      seenErrors: governorState.errorSeen,
    });
    const currentTimeline = buildTimeline(messages, roundStart, {
      writeToolNames: resolvedWriteToolNames,
      writeToolPathKeys: resolvedWriteToolPathKeys,
    });
    governorState.timeline.push({ round, ...currentTimeline });
    governorState.timeline = governorState.timeline.slice(-12);
    for (const call of currentTimeline.toolCalls) {
      if (resolvedWriteToolNames.has(call.name) && call.arg) {
        governorState.filesWritten.push({ path: call.arg, round });
        trimFilesWritten();
      }
    }
    const actionSignals = {
      round,
      // 治理层的 rounds 只用于推进速率估算（elapsedMs / rounds），跟预算同域：
      // resume 后 elapsedMs 是本次会话的，必须配本次会话的轮数（budgetRounds）
      rounds: budgetRounds,
      hasToolUse: hasToolUse(content),
      shouldContinue,
      noToolRound,
      noToolStreak: governorState.noToolStreak,
      maxNoToolRounds,
      errorRepeat: currentL0.errorRepeat,
      hasProgress: hasSuccessfulToolResult(currentRoundMessages),
      memoryLoss: memoryLossDetected,
      completionSignalDetected,
      continuationExhausted,
      stallSuspicion,
      stallStreak,
      wrapUpNudged: governorState.wrapUpNudged,
      nearLimit: budgetRounds >= Math.floor(governorState.effectiveMaxRounds * 0.8),
      extensionCount: governorState.extensionCount,
      maxExtensions: reflectionMaxExtensions,
      effectiveMaxRounds: governorState.effectiveMaxRounds,
      maxRoundsCap: reflectionMaxRoundsCap,
      extensionStep: reflectionExtensionStep,
      elapsedMs: elapsedMs(),
      remainingMs: remainingMs(),
    };
    let judgeDecision = interceptJudgeDecision;
    let judgeUsage;
    // end_turn 轮完整评估；工具中途审计的 nearLimit 扩轮决策已由拦截器回传。
    if (roundJudgeEnabled && isEndTurn) {
      try {
        const judged = await callRoundJudge(round, currentL0);
        judgeDecision = judged.decision;
        judgeUsage = judged.usage;
        const judgeRaw = judged.raw;
        if (judgeDecision === null) {
          roundJudgeFailures += 1;
          if (roundJudgeFailures >= roundJudgeFailureLimit) roundJudgeEnabled = false;
          emitJudge({
            round,
            kind: "round",
            decision: null,
            action: "degraded",
            error: "parse",
            // parse 失败但 response.usage 已可取得（issue #33 评审修复）：
            // degraded 事件同样带 usage，judge.log 可对账这部分消耗。
            ...(judgeUsage ? { usage: judgeUsage } : {}),
            // 原文落盘（可审计性）：parse 失败时最需要看 judge 到底输出了什么
            ...(typeof judgeRaw === "string" && judgeRaw !== "" ? { raw: judgeRaw } : {}),
          });
        } else {
          roundJudgeFailures = 0;
          const extensionAction = judgeDecision.extend === true
            ? (judgeDecision.direction === "off_track" ? "extend+redirect" : "extend")
            : judgeDecision.extend === false
              ? "decline_extend"
              : undefined;
          emitJudge({
            round,
            kind: "round",
            decision: {
              done: judgeDecision.done,
              confidence: judgeDecision.confidence,
              reason: judgeDecision.reason,
              evidence: judgeDecision.evidence,
              direction: judgeDecision.direction,
              directionReason: judgeDecision.directionReason,
              ...(judgeDecision.extend === undefined ? {} : { extend: judgeDecision.extend }),
              ...(judgeDecision.extendReason === undefined
                ? {}
                : { extendReason: judgeDecision.extendReason }),
              ...(judgeDecision.plan === undefined ? {} : { plan: judgeDecision.plan }),
            },
            action: judgeDecision.done === true && judgeDecision.confidence >= 0.7
              ? "judge_done"
              : (extensionAction ?? (judgeDecision.done === false ? "nudge" : "continue")),
            ...(judgeUsage ? { usage: judgeUsage } : {}),
            ...(typeof judgeRaw === "string" && judgeRaw !== "" ? { raw: judgeRaw } : {}),
          });
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        roundJudgeFailures += 1;
        if (roundJudgeFailures >= roundJudgeFailureLimit) roundJudgeEnabled = false;
        emitJudge({
          round,
          kind: "round",
          decision: null,
          action: "degraded",
          error: error?.code === "judge_intercept_timeout" ? "timeout" : "error",
        });
      }
    }

    let action;
    if (judgeDecision?.done === true
      && judgeDecision.confidence >= 0.7
      && isEndTurn) {
      action = {
        kind: "stop",
        value: "judge_done",
        truncated: false,
      };
    } else if (actionSignals.nearLimit
      && typeof judgeDecision?.extend === "boolean") {
      action = decideWithEvaluation(actionSignals, judgeDecision);
    } else if (judgeDecision?.done === false) {
      const reason = judgeDecision.reason || "任务尚未完成";
      const evidence = judgeDecision.evidence || "评审未提供更多证据";
      const directionHint = judgeDecision.direction === "off_track"
        ? `\n方向提示：${judgeDecision.directionReason || "当前路线可能偏，可考虑换思路/方法"}（仅提示，可考虑替代路线）`
        : "";
      action = {
        kind: "nudge",
        reason: "judge",
        text: `【Judge 评审意见】${reason}\n证据：${evidence}${directionHint}\n请根据评审意见继续完成任务。`,
        continue: true,
      };
    } else {
      action = decideRoundAction(actionSignals);
    }
    if ((action.kind === "extend" || action.kind === "extend+redirect")
      && typeof effectiveReflection?.onReflection === "function") {
      await effectiveReflection.onReflection({
        round,
        decision: judgeDecision,
        extendedTo: Math.min(
          governorState.effectiveMaxRounds + reflectionExtensionStep,
          reflectionMaxRoundsCap,
        ),
      });
    }
    addGovernorHistory(
      round,
      roundSummary,
      currentL0,
      new Date().toISOString(),
      wrapupJson,
      judgeDecision,
    );
    const roundRunState = await refreshRunState();

    const record = {
      round,
      roundKey: `${String(runId)}:round:${String(round)}`,
      // 引擎命名空间（同 resume 预落盘，见上方注释）：宿主若已用默认键
      // `${runId}:round:N` 写了同行号的行，引擎本轮的完整记录不会被去重丢掉。
      dedupKey: `${String(runId)}:engine:round:${String(round)}`,
      messages: messages.slice(roundStart),
      ts: new Date().toISOString(),
      response: {
        content,
        stopReason: response?.stopReason,
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
      },
      textPreview: textFromBlocks(content),
      toolUses: content.filter((block) => block?.type === "tool_use").length,
      summary: roundSummary,
      l0facts: currentL0,
      runState: cloneState(roundRunState),
      ...(compactionStats.length > compactionStatsStart
        ? { compactionStats: cloneState(compactionStats.slice(compactionStatsStart)) }
        : {}),
      ...(judgeDecision === null || judgeDecision === undefined ? {} : {
        judge: {
          done: judgeDecision.done,
          confidence: judgeDecision.confidence,
          reason: judgeDecision.reason,
          evidence: judgeDecision.evidence,
          direction: judgeDecision.direction,
          directionReason: judgeDecision.directionReason,
          ...(judgeDecision.extend === undefined ? {} : { extend: judgeDecision.extend }),
          ...(judgeDecision.extendReason === undefined
            ? {}
            : { extendReason: judgeDecision.extendReason }),
          ...(judgeDecision.plan === undefined ? {} : { plan: judgeDecision.plan }),
        },
      }),
      ...(wrapupJson === null ? {} : { wrapup: wrapupJson }),
      ...(archivedOutputs.some((entry) => entry.round === round)
        ? {
          toolOutputs: archivedOutputs
            .filter((entry) => entry.round === round)
            .map(({ toolUseId, name, content }) => ({ toolUseId, name, content })),
        }
        : {}),
    };
    if (compaction.folded) {
      record.folded = true;
      if (compaction.foldedPayload !== undefined) {
        record.foldedPayload = compaction.foldedPayload;
      }
      if (compaction.foldedRoundRange !== undefined) {
        record.foldedRoundRange = compaction.foldedRoundRange;
      }
      if (compaction.navigationRecord !== undefined) {
        record.navigationRecord = compaction.navigationRecord;
      }
    }
    const persisted = await persist("appendRound", runId, record);
    if (persisted) persistedTranscriptLength += record.messages.length;
    if (onRound) {
      // issue #173 PR-B：onRound 是被 await 的钩子，同步 throw 与 rejected Promise 都在此吸收。
      // 轮次此刻已经落库，宿主回调失败不得改写 run 终局——记一笔后继续跑下一轮。
      try {
        await onRound(record);
      } catch (hostError) {
        reportObserverError(hostError, { channel: "onRound", round });
      }
    }

    executedToolIds.clear();
    snapshotResults.clear();
    toolExecutedThisRound = false;
    emitEvent({
      type: "round_end",
      round,
      finalText,
      stopReason: roundStopReason,
      usage: { ...usage },
    });
    if (action.kind === "nudge") {
      const continuationMessage = {
        role: "user",
        meta: { source: "judge-control" },
        content: [{ type: "text", text: action.text }],
      };
      messages.push(continuationMessage);
      messageRounds.set(continuationMessage, round);
      if (action.resetNoToolStreak) governorState.noToolStreak = 0;
      if (action.wrapUpNudged === true) governorState.wrapUpNudged = true;
      continue;
    }
    if (action.kind === "extend" || action.kind === "extend+redirect") {
      governorState.effectiveMaxRounds = Math.min(
        governorState.effectiveMaxRounds + reflectionExtensionStep,
        reflectionMaxRoundsCap,
      );
      governorState.extensionCount += 1;
      const continuationMessage = {
        role: "user",
        content: [{ type: "text", text: action.text }],
      };
      messages.push(continuationMessage);
      messageRounds.set(continuationMessage, round);
      continue;
    }
    if (action.kind === "stop") {
      const reason = terminationReasonForAction(action, continuationExhausted);
      await forceFinalIfNeeded(reason);
      if (
        typeof finalGuard === "function"
        && FINAL_GUARD_TERMINATION_REASONS.has(reason)
      ) {
        const guardDecision = await callFinalGuard(reason);
        if (guardDecision.action === "error") {
          return finish(reason);
        }
        if (guardDecision.action === "skip") {
          return finish(reason);
        }
        if (FINAL_GUARD_NON_CONTINUABLE_REASONS.has(reason)) {
          guardMetrics.unverified += 1;
          verification = {
            status: "unverified",
            reason: "non_continuable",
            detail: reason,
          };
          emitEvent({
            type: "final_guard",
            round: rounds,
            action: "degraded",
            reason: "non_continuable",
          });
          return finish("final_guard_unverified");
        }
        if (guardDecision.action === "revise") {
          if (finalGuardRetries >= finalGuardRetryLimit) {
            guardMetrics.unverified += 1;
            verification = {
              status: "unverified",
              reason: "max_retries",
            };
            emitEvent({
              type: "final_guard",
              round: rounds,
              action: "degraded",
              reason: "max_retries",
            });
            return finish("final_guard_unverified");
          }
          finalGuardRetries += 1;
          const continuationMessage = {
            role: "user",
            content: [{ type: "text", text: guardDecision.message }],
          };
          messages.push(continuationMessage);
          messageRounds.set(continuationMessage, round);
          continue;
        }
      }
      return finish(reason);
    }
    if (action.kind === "continue") continue;
    }
  } catch (error) {
    await fail(error);
  }

  await forceFinalIfNeeded("max_rounds_cap");
  if (typeof finalGuard !== "function") return finish("max_rounds_cap");
  const guardDecision = await callFinalGuard("max_rounds_cap");
  if (guardDecision.action === "error") return finish("max_rounds_cap");
  if (guardDecision.action === "skip") return finish("max_rounds_cap");
  guardMetrics.unverified += 1;
  verification = {
    ...verification,
    status: "unverified",
    reason: "non_continuable",
    detail: "max_rounds_cap",
  };
  emitEvent({
    type: "final_guard",
    round: rounds,
    action: "degraded",
    reason: "non_continuable",
  });
  return finish("final_guard_unverified");
}
