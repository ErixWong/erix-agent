import { KitError } from "../providers/errors.js";
import { computeBudget } from "../compact/budget.js";
import { createProviderSummarizer, summarizerThinkingMode } from "../compact/provider-summarizer.js";
import { DEFAULT_SUMMARY_MAX_TOKENS } from "../compact/fold-llm.js";
import { resolveCompactionStrategy } from "../compact/strategy-resolution.js";
// issue #469（裁决 A）：resume 后的续写基底从账本播种，取源就复用 #462 的「按水位线挑覆盖事实」。
import { pickCoveringFoldAlternative } from "../compact/resume-fold-trim.js";
import { createSlidingWindowStrategy } from "../compact/sliding-window.js";
import { mergeFoldNavigationRecords } from "../compact/fold-statistical.js";
import {
  buildFoldedRecordArchive,
  createFoldArchiveLedger,
  payloadByteLength,
} from "../compact/fold-archive.js";
import {
  countEstimateCharacters,
  estimateMessageTokens,
  estimateTokensFromCharacterCounts,
} from "../tokens.js";
import { groupIntoRounds } from "../messages/rounds.js";
// issue #394：结清尾部悬空 `tool_use` 的**共享实现**（判据 / 结果块 / 正文三件事实都在那一份里）。
// 本文件只负责给它注入入账口径（`:control:` 行的槽位名），不再自己拼 `tool_result`。
import {
  answerPendingTailToolUses as settlePendingTailToolUses,
  pendingTailToolUsesAreAnswerable,
} from "./pending-tool-result.js";
import { MESSAGE_ROW_KIND } from "../store/message-rows.js";
import {
  decideRoundAction,
  decideWithEvaluation,
  // issue #386 切片 3：guard 补跑桥复用**同一份**扩轮准入判据（判定表一字未动，只是改了可见性）。
  extensionAllowed,
} from "../reflection/governor.js";
import { extractL0Facts, parseL1Summary } from "../reflection/l0.js";
// issue #406 B2-b：收尾归一化**只有一个实现**——`normalizeWrapupText`（`src/reflection/wrapup.js`）
// 转调 `normalizeModelJson`。引擎与公开入口 `normalizeWrapupWithLlm` 都走它 ⇒ 同一份提示词、
// 同一道闸门、同一个「思考恒关」取值、同一份失败事实。`tryParseWrapupJson` 仍是每轮先用一次的
// 同步严格档（零修复、零请求），两者分工见 `src/reflection/wrapup.js` 的文件头。
import { normalizeWrapupText, tryParseWrapupJson } from "../reflection/wrapup.js";
import {
  buildJudgePrompt,
  buildTimeline,
  DEFAULT_WRITE_TOOL_NAMES,
  INTERCEPT_CONVERSATION_TOKENS,
  parseJudgeDecision,
  rawWritePaths,
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
  JUDGE_DONE_CONFIDENCE_THRESHOLD,
  WRAPUP_INSTRUCTION,
  isLikelyWelcomeResponse,
  judgeDoneAdvisoryText,
  parseReflectionDecision,
} from "./reflection.js";
import {
  resolveTaskBrief,
} from "./task-brief.js";
import {
  FILE_LEDGER_LIMIT,
  FINAL_GUARD_EXTENDABLE_REASONS,
  FINAL_GUARD_NON_CONTINUABLE_REASONS,
  FINAL_GUARD_TERMINATION_REASONS,
  annotateTermination,
  createTerminationManager,
  makeTermination,
  terminationDetailForError,
  terminationErrorCodeForError,
  terminationReasonForAction,
  withErrorCode,
  withTerminationPayload,
} from "./termination.js";
import { normalizeDeliverables } from "./deliverables.js";
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
import { ensureUserTurnView, isUserTurnGuardAction } from "./request-user-view.js";
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
import {
  buildFoldedFacts,
  createFoldSummaryLedger,
  FOLDED_FACTS_RECORD_FIELD,
  foldSummaryFingerprint,
  stableFingerprint,
} from "../compact/fold-summary-journal.js";
import { summarizeFoldedPayload } from "../compact/fold-statistical.js";
import { createRunSnapshotExecutor } from "./run-snapshot-executor.js";
import {
  buildToolResultFact,
  createToolCallKeyRegistry,
  ensureToolCallKeyOnBlock,
} from "../tool-fact.js";
import { restoreResume } from "./resume-manager.js";
import {
  collectLoopCapabilitiesMissing,
  validateTranscriptStore,
} from "../assembly-validators.js";
import { CAPABILITY_CONTEXT_HOOK_NAMES, assertCapabilitiesNamespace } from "./capabilities-namespace.js";
import {
  assertRunToolLoopOptionNames,
  normalizeRunToolLoopOptions,
  RUN_TOOL_LOOP_OPTION_SET,
} from "./option-normalization.js";
import {
  CONFIG_NAMESPACE_GROUPS,
  assertConfigNamespace,
  configBindingForLeaf,
  configBindingForLeafName,
  configLeafNamesForBinding,
  configLeafPathForName,
} from "./config-namespace.js";

export { parseReflectionDecision };

/**
 * Governor 历史的估算上限（与 #172 A4 之前的内联 4000 同口径）。
 */
export const GOVERNOR_HISTORY_TOKEN_LIMIT = 4000;

/**
 * issue #393 / #394：那条引擎自写的 `tool_result` 正文，**定义**已搬到共享实现
 * `src/loop/pending-tool-result.js`（与结清动作放在一起：正文、构造器、判据三件事实同源）。
 *
 * 这里保留一次再导出只是为了让既有调用点/测试的 import 路径不变；`src/index.js` 依旧不转出它
 * （不属公开契约面）。
 */
export { PENDING_TOOL_RESULT_TEXT } from "./pending-tool-result.js";

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
  // issue #230：与 `checkpoint_failed`（`src/loop/run-snapshot-executor.js#assertSnapshotPersisted`）
  // **取值也对称**——两个出口是同一次底层故障的两张脸，同名字段两种类型等于把「宿主只能读源码
  // 才知道」换了个坑。`errorCode` 与 `termination.errorCode` 同一套口径（`terminationErrorCodeForError`：
  // 取根因自己的 `code`，取不到即 `"unknown"`），`cause` 仍是底层错误对象（既有形状，不动）。
  // 用 `Object.assign` 写入：`KitError` 的 JSDoc 没声明这个 additive 字段，直接赋值会让 `--checkJs`
  // 棘轮多背一个 TS2339（#214 的「只减不增」）。
  Object.assign(failure, { errorCode: terminationErrorCodeForError(error) });
  // 账单可靠性（issue #109）：异常终止时 run 不会返回 result，账单必须随异常走，
  // 否则 sink 失败留痕与未持久化事实一起丢失。
  failure.unpersisted = errorLedger?.toUnpersisted?.() ?? [];
  return failure;
}

/**
 * @typedef {object} LoopEvent
 * @property {"round_start"|"attempt"|"recovering"|"recovered"|"usage"|"tool_use"|"tool_result"|"tool_replay_decision_required"|"round_end"|"compaction"|"final_guard"|"persistence_capability_degraded"|"model_metadata_missing"|"resume_journal_skipped"|"compaction_strategy_fallback"|"config_override_conflict"|"run_outcome"} type
 * @property {number} [round]
 * @property {number} [attempt] 1-based provider attempt within the round.
 * @property {number} [maxAttempts] Retry count plus the initial attempt.
 * @property {object} [usage] Provider usage reported after a successful call.
 * @property {object} [toolUse] Completed canonical tool_use block.
 * @property {object} [toolResult] Canonical tool_result block.
 * @property {string} [runId] Run identity on host-facing diagnostics.
 * @property {string} [detail] One-shot capability diagnostic text (persistence_capability_degraded, model_metadata_missing, compaction_strategy_fallback).
 * @property {string} [toolUseId] Tool invocation requiring host replay decision.
 * @property {string} [toolName] Tool name requiring host replay decision.
 * @property {boolean} [requiresHostDecision] Whether the host must decide whether to retry.
 * @property {boolean} [partialOutputAvailable] Whether captured output was included in the interrupted result.
 * @property {string} [finalText] Text accumulated at round end.
 * @property {string} [stopReason] Canonical provider stop reason.
 * @property {"accept"|"skip"|"revise"|"degraded"|"error"} [action]
 * @property {string} [reason]
 * @property {number} [count] issue #424（additive）：被跳过/涉及的消息条数（`resume_journal_skipped` 用它报 A 集合大小）
 * @property {Array<{path: string, key: string}>} [conflicts] issue #497（S2，additive）：`config_override_conflict`
 *   的载荷——冲突叶子的 schema 路径（`"run.maxRounds"`）与顶层键名，**只带路径与键名**（值可能是
 *   函数/大对象，不进事件）。两个来源都算：`config.*` vs 同名扁平键、调用级 `config` vs 装配口
 *   `policy.config`（复审 R4）。按 path 去重，顺序 = schema 分组顺序 + 组内顺序。
 *   issue #498（S4a，additive）：第二个容器同一条出口——`capabilities.hooks.*` vs 同名扁平回调，
 *   path 形如 `"hooks.onEvent"`（同一个载荷、同一个去重与排序规则）。
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
 * When `config.run.reflection` is omitted, the basic judge is enabled
 * automatically for runs with `config.run.maxRounds >= 16`; pass
 * `config.run.reflection: false` to disable it.
 *
 * Stall detection defaults to `consecutive`, which requires the entire window to
 * hold the same signature (legitimate re-reads of a file no longer count as a
 * stall); pass `{ mode: "appear" }` as `config.run.stallDetection` to detect a
 * signature anywhere in the window instead. `ERIX_STALL_MODE` overrides the mode
 * unless `config.run.stallDetection` is explicitly `false`.
 *
 * The top-level property set of the `options` type below is **exactly**
 * `RUN_TOOL_LOOP_OPTION_NAMES` (`src/loop/option-normalization.js`) — the single
 * source of "which options `runToolLoop` accepts". Every retired flat spelling
 * moved into the nested `config` / `capabilities` containers and is rejected at
 * startup when written flat, so declaring it here would advertise a spelling the
 * runtime refuses. `test/type-surface-522.test.js` compares the two sets both
 * ways, so a name added to one side only goes red.
 *
 * @param {{
 *   assemblyPort?: import("../assembly.js").AssemblyPort,
 *   provider: {chat?: (request: object) => Promise<object>, chatStream?: (request: object) => Promise<object>},
 *   tools?: object[],
 *   executeTool: (options:{id:string, name:string, input:object, context:object, signal:AbortSignal})
 *     => Promise<string|{content:any, metadata?:object, success?:boolean}|Error>,
 *   finalGuard?:(payload:{finalText:string,messages:object[],round:number,rounds:number,signal:AbortSignal,termination:object}) => Promise<{action:"accept"}|{action:"skip",reason:string}|{action:"revise",message:string}>,
 *   deliverables?: {name: string, check: (facts: object) => any}[], // issue #386 slice 2: host-declared delivery checks, verified before every guard call (the canonical home is `capabilities.checks.deliverables`; the flat spelling is a live option).
 *   config?: { // issue #497（S2）：嵌套配置命名空间，七组见下（叶子名逐字等于同名顶层选项，类型也一致；唯一例外是 `input.messages` → `initialMessages`，见 `CONFIG_LEAF_ALIASES`）。
 *     input?: {system?: string, cacheStablePrefix?: boolean, initialUserMessage?: string, messages?: object[], wrapup?: boolean, tools?: object[]},
 *     run?: {maxRounds?: number, maxTokenContinuations?: number,
 *       stallDetection?: {window?: number, mode?: "appear"|"consecutive"}|false,
 *       completion?: {signals?: string[], maxNoToolRounds?: number}|false,
 *       replayPolicy?: "always-replay"|"per-tool-declaration", invalidArguments?: "reject"|"execute",
 *       partialPersistence?: false|{intervalMs: number, minBytes?: number}, persistence?: "none"|"required",
 *       outputHygiene?: false|{limit?: number}, writeToolNames?: string[], writeToolPathKeys?: string[],
 *       resume?: boolean, stream?: boolean, reflection?: object|false,
 *       runId?: string, cwd?: string},
 *     tuning?: {maxTokens?: number, temperature?: number, topP?: number, cacheCapable?: boolean},
 *     timing?: {timeoutMs?: number, deadlineMs?: number,
 *       retry?: {attempts?: number, backoffBaseMs?: number, backoffMaxMs?: number,
 *         sleepImpl?: (ms: number) => Promise<void>}|false},
 *     folding?: {context?: {strategy?: object|"sliding-window"|"fold-statistical"|"fold-llm", budgetTokens?: number,
 *       keepRounds?: number, toolContext?: object, task?: string, session?: any},
 *       toolResultTtl?: number, toolResultFoldMinTokens?: number},
 *     guard?: {finalGuardMaxRetries?: number, finalGuardTimeoutMs?: number, finalGuardExtend?: boolean},
 *     metadata?: {expert?: any, user?: any, task?: any, requestId?: string, toolContext?: object,
 *       model?: {contextWindowTokens?: number, maxOutputTokens?: number},
 *       modelMetadata?: {contextWindowTokens?: number, maxOutputTokens?: number}},
 *   },
 *   capabilities?: { // issue #498 (S4a / S4b / S4c): the capability container. Three groups: `hooks` (16 host callbacks + 2 polymorphic knobs), `checks` (deliverables checks), `ports` (infrastructure / strategy implementations).
 *     hooks?: {onEvent?: (event: LoopEvent) => void, onObserverError?: (error: Error, context: {channel: string, runId?: string, type?: string, round?: number, toolName?: string, method?: string}) => void,
 *       onPersistenceError?: (error: Error) => void,
 *       onRound?: (record: object) => void, onJudge?: (info: JudgeEvent) => void,
 *       onToolResult?: (name: string, result: string, metadata?: object) => any,
 *       onDelta?: (chunk: string) => void, onReasoningDelta?: (chunk: string) => void,
 *       onToolCall?: (fragment: object) => void, onUsage?: (usage: object) => void,
 *       onFoldSummary?: (payload: object) => void|Promise<void>,
 *       finalGuard?: (payload: object) => Promise<{action: "accept"}|{action: "skip", reason: string}|{action: "revise", message: string}>,
 *       onReflection?: (info: {round: number, decision: object, extendedTo: number}) => void,
 *       onBeforeFold?: (payload: object) => void|Promise<void>, onAfterFold?: (payload: object) => void|Promise<void>,
 *       stubFor?: (message: object) => string|Promise<string|undefined>, // per-message fold stub text
 *       protectedMessage?: (message: object) => boolean, // function form of the polymorphic knob (string / string[] is the config-side data form)
 *       recoveryHint?: (context: object) => string|Promise<string>}, // function form of the polymorphic knob
 *     checks?: {deliverables?: {name: string, check: (facts: object) => any}[]},
 *     ports?: {sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *       judgeProvider?: object|((request: object) => Promise<object>), // callable or `{chat}`
 *       strategy?: {shouldCompact: Function, compact: Function}}, // a strategy object, not a built-in name (a name is data: use context.strategy / config.folding.context.strategy)
 *   },
 *   todoStateProvider?:(payload:{runId?:string,rounds:number})=>object|Promise<object>,
 *   semanticStateProvider?:(payload:{runId?:string,state:object,previous?:object})=>{text:string,version:number}|Promise<{text:string,version:number}>,
 *   modelConfig?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   session?:any,
 *   store?: {appendRound?: Function, load?:Function, // required pair (issue #78)
 *     saveRunSnapshot?:Function, loadLatestRunSnapshot?:Function, // optional run-snapshot capability
 *     markRunState?:Function, saveRunState?:Function, loadRunState?:Function}, // optional run-state capability
 *   diagnostics?: {error:(event:object)=>void|Promise<void>},
 *   onRound?: (record:object) => void,      // 观察者（issue #173 PR-B）：抛错/rejected Promise 均被隔离
 *   onJudge?:(info:JudgeEvent) => void,     // 观察者（issue #173 PR-B）：抛错被隔离
 *   onToolResult?: (name:string, result:string, metadata?:object) => any,
 *   onPersistenceError?: (error:Error) => void,
 *   onFoldSummary?: ((payload: object) => void | Promise<void>)|undefined,
 *   onObserverError?: (error:Error, context:{channel:string, runId?:string, type?:string, round?:number, toolName?:string, method?:string}) => void,
 *   signal?: AbortSignal,
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
 * `config.input.wrapup`:
 *   Defaults to true (omit = enabled). ERIX_NO_WRAPUP_INSTRUCTION=1 env overrides even an
 *   explicit wrapup:true — either off disables the whole protocol.
 *
 * `config.run.outputHygiene`:
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
 * `config.run.writeToolNames`:
 *   Defaults to ["writeFile", "edit"] (DEFAULT_WRITE_TOOL_NAMES in src/reflection/judge.js — the single
 *   truth shared by this default, the normalizeToolNameSet fallback below, and the judge
 *   timeline; issue #191 added `edit`). An explicit host value always wins: it replaces the
 *   default outright and is never merged with it.
 *
 * `config.run.stallDetection`:
 *   {window:4, mode:"consecutive"} (the entire window must hold the same signature);
 *   ERIX_STALL_MODE overrides the mode unless the option is explicitly false.
 *
 * `store`:
 *   Deprecated aliases still honoured at runtime: saveCheckpoint/appendCheckpoint/loadLatestCheckpoint.
 *
 * `config`:
 *   issue #497（S2）：`config` 是一棵**嵌套命名空间**，叶子是既有顶层扁平键的别名（别名 = schema
 *   路径，叶子名逐字等于顶层键名，唯一例外是 `input.messages` → `initialMessages`）。七个分组
 *   **就是**这七个：`input` / `run` / `tuning` / `timing` / `folding` / `guard` / `metadata`
 *   （schema 见 `CONFIG_NAMESPACE_SCHEMA`（`src/loop/config-namespace.js`）；写错组名启动即抛）。
 *   同名时 `config.*` 赢，扁平键继续接受；两种写法给了**不同的值**时发一条
 *   `config_override_conflict`（`conflicts: [{ path, key }]`，只带路径与键名）。装配口的
 *   `policy.config` 与调用级 `config` 同时在场时取值仍是「后写者胜、整棵覆盖」，但逐叶冲突走
 *   同一条事件（复审 R4）——只写在被覆盖那棵树里的叶子会被丢掉，别把它当逐叶合并用。
 *   能力面（`provider` / `executeTool` / `store` / `modelConfig` / `assemblyPort` /
 *   `signal` / 状态源 / 回调出口 / `finalGuard` / `deliverables` …）写进 `config` 一律启动即抛
 *   并点名该键。
 *   **`config` 里不许有函数值**（#498 S4a）：整棵树逐节点扫，函数一律启动即抛并点名完整路径
 *   （`config.folding.context.onBeforeFold`），报错说清规范之家（`capabilities.hooks.<name>` /
 *   `capabilities.checks.deliverables` / `capabilities.ports.<slot>` — since #498 S4c the third tier
 *   names the real destination, e.g. `config.timing.retry.sleepImpl` ⇒
 *   `capabilities.ports.sleepImpl`).
 *   `runId` / `cwd` / `tools` 是配置面（`config.run.runId` / `config.run.cwd` /
 *   `config.input.tools`）：它们是字符串标量 / 工具声明数组，而「`config` 子树过 JSON round-trip
 *   等值」要求能力面只剩函数/端口对象（见 `src/loop/config-namespace.js` 文件头约束 3 / 4）。
 *   **不透明 per-run 载荷的家（#551 裁决甲）是 `config.folding.context.session`**——折叠壳的**保留键**，
 *   引擎把它作为 `context.session` 交给 `executeTool`。`config.metadata.*` 装的是引擎**按字段名**读的
 *   宿主数据（`expert` / `user` / `task` / `requestId` / `toolContext` / `model` / `modelMetadata`），
 *   所以它**不是**载荷的家：写 `config.metadata.session` 会被拒，判词直接点名折叠壳那个键。
 *   顶层 `session` 是**身份容器**（`session.id` / `session.modelSlot` / `session.initialMessages`），
 *   不是第二个载荷入口。
 *
 * `capabilities`:
 *   issue #498 (S4a / S4b / S4c): the capability container, treated **exactly like `config`** (same
 *   pre-check phase, same "container beats flat" precedence, same conflict event). Three groups:
 *   · `hooks` — the canonical home of the **16 host callbacks** (`onEvent` / `onObserverError` /
 *     `onPersistenceError` / `onRound` / `onJudge` / `onToolResult` / `onDelta` / `onReasoningDelta` /
 *     `onToolCall` / `onUsage` / `onFoldSummary` / `finalGuard` / `onReflection` / `onBeforeFold` /
 *     `onAfterFold` / `stubFor`; see `CAPABILITY_HOOK_NAMES`
 *     (`src/loop/capabilities-namespace.js`)) **plus** the function form of the two polymorphic knobs
 *     (`protectedMessage` / `recoveryHint`, see `CAPABILITY_POLYMORPHIC_HOOK_NAMES`). Every `hooks`
 *     value must be a function (that is not relaxed for those two);
 *   · `checks` — deliverables checks (`deliverables`, each entry `{name, check}`, `check` a function);
 *   · `ports` — infrastructure / strategy implementations the engine **dereferences or calls**
 *     (#498 S4c): `sleepImpl` / `judgeProvider` (a callable or a `{chat}` object) / `strategy` (a
 *     strategy object). The difference from `hooks`: a port slot may be an object, a hook must be
 *     callable.
 *   The flat top-level spellings of the 12 observer channels / `finalGuard` / `deliverables` **keep
 *   working** (the published 0.26 surface; this release removes none of them); the nine leaves added
 *   by this slice (`ports.*` and
 *   `hooks.{onReflection,onBeforeFold,onAfterFold,stubFor,protectedMessage,recoveryHint}`) have **no**
 *   top-level flat alias (they never were top-level options) — which is why none of them ever entered the allowlist.
 *   Unknown sub-keys (`capabilities.hoks` / `capabilities.check` / `capabilities.ports.sleeplmp`) and
 *   "given but wrong shape" all throw at startup with the full path named. The `config.observers`
 *   group is gone entirely (0.27 was never published ⇒ zero cost).
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
 *   modelUsage:{input_tokens:number, output_tokens:number, cacheRead?:number, cacheWrite?:number},  // issue #438：run 累计里主模型自己的那份（含续写每一发）
 *   engineUsage:{input_tokens:number, output_tokens:number, cacheRead?:number, cacheWrite?:number}, // issue #438：run 累计里引擎自发起的调用那份（judge / 归一化 / 折叠摘要 / 强制收尾）
 *   compactionStats:{compacted:boolean, foldedRounds:number, tokensBefore:number, tokensAfter:number, layers:object, userTurnGuard?:string, userTurnGuardChannel?:string}[]
 * }>}
 */
export async function runToolLoop(options) {
  // 选项规范化（形状/未知键白名单 + 未知键建议 + assemblyPort 合并）已外提到
  // src/loop/option-normalization.js（issue #177 刀1）；检查次序不变：
  // 形状检查 → 未知键检查 → assemblyPortOptions → 显式值合并（`!== undefined` 才覆盖）。
  const {
    assemblyPort,
    explicitOptions,
    effectiveOptions,
    configConflicts,
    capabilitySlots,
  } = await normalizeRunToolLoopOptions(options);

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
    // issue #409 需求②：引数解析失败 ⇒ 不执行该工具（默认），判词经 `is_error` 的 `tool_result`
    // 回给模型。`"execute"` 是显式回退，行为逐字等于 #409 之前。
    invalidArguments = "reject",
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
    // issue #386 切片 3：预算类停机上的补跑开关。**默认 `false`** ⇒ 不传时行为与今天逐字一致
    // （这一条会改停机时的行为，不是纯加法；默认关让升级风险为零，宿主侧启用放在切片 4）。
    finalGuardExtend = false,
    // issue #386 切片 2：宿主声明的交付物判据（引擎在每次 guard 调用前核一遍）。
    deliverables,
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
    cwd,
    resume = false,
    onRound,
    onJudge,
    onToolResult,
    onPersistenceError,
    onFoldSummary,
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
  // #498 S4c: the nine capability leaves that have **no flat alias** (see
  // `CAPABILITY_SLOT_DESTINATIONS` in `src/loop/capabilities-namespace.js`). They are the canonical
  // home of behaviour carriers that used to live in a nested shell slot (`retry.sleepImpl`,
  // `reflection.judge.provider`, `context.strategy`, `reflection.onReflection`,
  // `context.{onBeforeFold,onAfterFold,stubFor,protectedMessage,recoveryHint}`). Expansion hands them
  // over on this side channel instead of inventing flat keys, so the top-level allowlist stays at 67;
  // every consumption point below resolves `capabilityPorts.X ?? shell.X` (the container wins, the
  // same direction `config.*` wins over the flat key).
  const capabilityPorts = capabilitySlots?.ports ?? {};
  const capabilityHooks = capabilitySlots?.hooks ?? {};
  // The five capability hooks whose legacy home is a `context` sub-key (not `onReflection`, which
  // lives in the `reflection` shell). Resolved once so the two consumers below cannot drift:
  // `resolveCompactionStrategy` (name-form strategies read `recoveryHint` / `stubFor`) and
  // `compactionContext` (which `compactOptions` copies the fold hooks out of).
  const foldHookValue = (name) => capabilityHooks[name] ?? context?.[name];
  const capabilityFoldHooks = {};
  for (const name of CAPABILITY_CONTEXT_HOOK_NAMES) {
    if (capabilityHooks[name] !== undefined) capabilityFoldHooks[name] = capabilityHooks[name];
  }
  const resolvedToolResultTtl = toolResultTtl === undefined && cacheCapable === true
    ? 0
    : toolResultTtl ?? TOOL_RESULT_TTL_DEFAULT;
  // #551 (#545 discipline): the `typeof session === "object"` test that used to sit here could
  // never be false. The semantic phase runs earlier (`assertSemanticOptionValues` inside
  // `normalizeRunToolLoopOptions`, above) and `collectSessionContainerProblems` refuses every
  // non-object `session` on **both** routes, so by this line "session is an object" is already
  // guaranteed — the criterion was permanently true. The live discriminator is **presence**: a
  // session container means the direct route must satisfy the assembly-port member contract.
  const fineGrainedPortShape = assemblyPort === undefined && (
    session !== undefined
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
  // issue #409：只认两个字面量。显式错型不许静默折成默认值——「要不要执行一个引数写坏的调用」
  // 是宿主的安全决策，猜错的代价是工具带着假参数跑起来。
  if (invalidArguments !== "reject" && invalidArguments !== "execute") {
    throw new TypeError('invalidArguments must be "reject" or "execute"');
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
  // issue #386 切片 1：`cwd` 是**纯透传**选项（只进 `finalGuard` payload），所以这里只校类型。
  // 引擎不解释它：不 chdir、不校验目录存在、不把它拼进任何路径。`undefined`（未提供）与
  // `""`（提供了空串）必须可区分——缺省时 payload 里根本不写 `cwd` 键。
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new TypeError("cwd must be a string");
  }
  // issue #386 切片 2：`deliverables` 的校验必须**早于**任何宿主端口被调用（与其它选项同一口径），
  // 且校验结果就是后续唯一被读的那一份（`undefined` = 未声明 ⇒ 下面所有分支都走「今天」的路）。
  const resolvedDeliverables = normalizeDeliverables(deliverables);
  // issue #386 切片 3：`finalGuardExtend` 只接受布尔。`undefined`（未提供）已由解构默认值折成
  // `false`，所以这里拒的是 `null` / 数字 / 字符串这类显式错型——静默当 truthy 处理会让
  // 「补跑」这个**会改停机行为**的开关被 `"false"` 这种写法意外打开。
  if (typeof finalGuardExtend !== "boolean") {
    throw new TypeError("finalGuardExtend must be a boolean");
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
  // #498 S4c: `capabilities.ports.sleepImpl` is the canonical home of the timer injection point,
  // and since issue #498 S3 (timing slice) it is the **only** host-reachable spelling: the flat
  // `retry` spelling is refused by the name gate (its home is `config.timing.retry`), and a
  // function inside `config.timing.retry` is refused by the "config holds data only" rule. #520
  // removed the `retryOptions?.sleepImpl` term that used to sit in the middle of this chain: no
  // producer could reach it (the producer sweep is in that issue), so it was a dead read. The
  // `?? defaultSleep` fallback is load-bearing: without it a run that retries with no injected
  // timer would call `undefined` (pinned by `test/loop-option-gate-496.test.js` D③).
  const sleepImpl = capabilityPorts.sleepImpl ?? defaultSleep;
  // issue #177 刀5：runToolLoop 可变状态收口对象（闭包 `let` → 显式状态对象，分组迁入）。
  // 初值与语义与原 `let` 逐字一致（`foldedThrough` 原初值就是数字 `0`，不是 `false`）：
  // 【A 轮次记账 + 一次性去重标记】`rounds` / `foldedThrough`（原 :1235 / :1237，双计数器口径
  //   见下方 issue #32 #8 原注释；与仍留在闭包里的 `budgetRounds` 是两个不同语义，**没有**合并）、
  //   `modelMetadataNoticeSent` / `runOutcomeEmitted`（#182 / #165 去重标记，原 :749 / :846）。
  // 【B 本轮进度 / stall 判定】`toolExecutedThisRound`（原 :647）、`hadToolUse`（原 :1488，
  //   初值由 `hasToolUseInMessages(messages)` 现算，求值点仍留在原声明处，见下方那条赋值）、
  //   `stallStreak` / `lastStallSignature`（原 :1175 / :1176）。
  // 声明点取本组已迁入符号里最早的**可读点**之前（原 `toolExecutedThisRound` 的声明处）：
  // 后到的四个符号在原声明点之前没有任何语句能读到（逐符号 `rg` 核过），把它们从 TDZ 变成
  // 已初始化不改变可观察行为；其余声明（含 `emitEvent` 在 `notifyModelMetadataMissing` 下方
  // 这个次序）一行没动。
  // 【C resume 尾队列】`resumePendingTools` / `resumeTailMessages` / `resumeRunSnapshotMessages`
  //   （原 :1266 / :1267 / :1269，初值都是空数组 `[]`）与 `persistedTranscriptLength`（原 :1270，
  //   初值是数字 `0`）。本组**只加格子**：扁平放置、不套子对象，【A】【B】的格子一行没动。
  // TDZ：这四个符号在原声明点（:1266/:1267/:1269/:1270）之前没有任何语句能读到（逐符号 `rg` 核过，
  //   原声明点就是它们在文件里的首次出现），把它们从 TDZ 变成已初始化不改变可观察行为。
  // 【C resume 尾队列（续）】`resumeTranscriptStart`（原 :1268）与 `lastPersistenceFailure`（原 :1273）
  //   ——两个**无初值**的格子，原 `let X;` 就是 `undefined`，故新格子显式写 `undefined`（不拿 `null`/`0`
  //   假冒初值：“未发生过”与“发生过但为空”在 `!== undefined` 判定上是两种语义——resume 续写守卫
  //   （`runLoopState.resumeTranscriptStart !== undefined`）与 partialPersistence 的两处抛出点
  //   （`runLoopState.lastPersistenceFailure !== undefined`）全部依赖这个区分）。
  //   TDZ 同理：原声明点就是它们的全文件首次出现，提先初始化不可观察。
  // 【C resume 尾队列（收尾）】`resumeRunSnapshot`（原 :1265，无初值）——原 :1264 那行
  //   `@type {Record<string, any>|undefined}` 注解随字段逐字搬走（它存不存在的理由见下面格子上的注解）。
  /** @type {{ rounds: number, foldedThrough: number, modelMetadataNoticeSent: boolean, runOutcomeEmitted: boolean, toolExecutedThisRound: boolean, hadToolUse: boolean, stallStreak: number, lastStallSignature: any, resumePendingTools: any[], resumeTailMessages: any[], persistedTranscriptLength: number, resumeToolResultRowKey: string|undefined, resumeTranscriptStart: number|undefined, lastPersistenceFailure: any, resumeRunSnapshot: Record<string, any>|undefined, runStateVersion: number, runStateAvailability: any, todoState: any, semanticState: any, currentRunState: any, ttlInjectArmed: boolean, ttlInjectConsumed: boolean, lowBudgetInjectFired: boolean, foldedRoundCount: number, navigationRecordCount: number, lowBudgetPrompted: boolean, toolErrorCount: number, runSnapshotFailureCount: number, aggregateBudgetHit: boolean, currentTerminationReason: string, readLoopPayload: () => { usage: any; rounds: number; finalText: string }, verificationReader: () => any, judgeRecordCorrelation: Record<string, any>, judgeRecordCount: number, roundJudgeEnabled: boolean, roundJudgeFailures: number, wrapupNormalizationEnabled: boolean, judgeInterceptCount: number, interceptJudgeDecision: any, messageSeqByRound: Map<number, number> }} */
  const runLoopState = {
    rounds: 0,
    foldedThrough: 0,
    modelMetadataNoticeSent: false,
    runOutcomeEmitted: false,
    toolExecutedThisRound: false,
    hadToolUse: false,
    stallStreak: 0,
    lastStallSignature: null,
    // 【C resume 尾队列】（初值与语义与原闭包 `let` 逐字一致）
    resumePendingTools: [],
    resumeTailMessages: [],
    // 工单 261021（第三刀·恢复只认账本）：崩溃轮里那条已落盘的 `tool_result` 聚合消息的首片行 key，
    // 由 `restoreResume` 从账本读出；补跑跑出来的结果靠 `partOf` 接回它（见 resume 补跑段）。
    resumeToolResultRowKey: undefined,
    persistedTranscriptLength: 0,
    // 工单 261021（第二刀·写侧）：轮内消息序号计数器（`round → 下一个可用 seq`），与
    // `persistedTranscriptLength` 同族的「已落盘」状态；`seq` 从 0 单调递增，写进展见
    // `appendMessageRowToTranscript`，读侧口径见 `src/store/message-rows.js`。
    messageSeqByRound: new Map(),
    // 【C resume 尾队列（续）】无初值格子：原 `let X;` 的初值就是 undefined，逐字保住。
    resumeTranscriptStart: undefined,
    lastPersistenceFailure: undefined,
    // 【C resume 尾队列（收尾）】`resumeRunSnapshot`（原 :1265，无初值 → undefined）。
    // 下面这行注解是原 :1264 那行**逐字搬过来的**（issue #177 刀1 加的，只为喂给 `--checkJs`（#214
    // 棘轮），零运行时影响）：这个值只由 `restoreResume` 经 `set resumeRunSnapshot` 访问器赋值，
    // 控制流分析看不见那条赋值，丢了注解就把这个格子当成 `undefined`，于是
    // `if (resumeRunSnapshot && …)` 里的 `resumeRunSnapshot.round` 退回 TS2339（… on type 'never'）、
    // 棘轮立刻红。snapshot 的形状由宿主 store 决定，这里不假装精确。
    /** @type {Record<string, any>|undefined} */
    resumeRunSnapshot: undefined,
    // 【D run-state 可用性】`runStateVersion`（原 :1188）与 `runStateAvailability`（原 :1193）——
    //   两个**有初值**的格子，初值逐字原样搬（`0` 与 `{ status: "available" }`）：版本号的起点决定
    //   落盘 run-state 的 `stateVersion` 与 semantic stale 判定基准，availability 的起点决定「未发生
    //   校验失败」时渲染出的 `stateAvailability.status`，两者都是可观察行为，不做任何「顺手归一」。
    //   TDZ：原声明点（:1188/:1193）就是这两个符号的全文件首次出现（逐符号 `rg -n '\b<符号>\b'` 数过：
    //   9 行 / 6 行，全部在声明之后），提先初始化不可观察。
    runStateVersion: 0,
    runStateAvailability: { status: "available" },
    // 【D run-state 可用性（续）】`todoState`（原 :1195）、`semanticState`（原 :1196）、`currentRunState`
    //   （原 :1192）——三个**无初值**的格子：原 `let X;` 的初值就是 `undefined`，此处显式写 `undefined`，
    //   不拿 `null`/`0` 假冒——“provider 还从未被调用过”与“调用了但返回 null”在多处判定上是两种语义：
    //   `termination.js:272` 的 `ctx.currentRunState === undefined` 决定终局载荷是否携 `runState`，
    //   `semanticState` 的 `if (semanticState && …)` 假值短路、`todoState` 的 `todo:` 字段在
    //   `createDeterministicRunState` 里对 `undefined` 与 `null` 的渲染也不同。
    //   `currentRunState` 的 TDZ：原 :1192 声明，但 `fail()`（原 :917 定义的闭包）在原 :922-926 就读取它；
    //   逐行核过 `fail(` 的**调用点**只有原 :1462 与 :3230，两者都晚于 :1192（`fail` 是本函数私有闭包，
    //   不可能被外部提前调），故在「任何可观察时点」读到的仍是 `undefined`，提先初始化不可观察。
    todoState: undefined,
    semanticState: undefined,
    currentRunState: undefined,
    // 【E 轮内量】`ttlInjectArmed`（原 :1210）、`ttlInjectConsumed`（原 :1211）、`lowBudgetInjectFired`
    //   （原 :1212）——三个**有初值**的格子，初值逐字原样搬（三个都是 `false`），不做任何「顺手归一」：
    //   它们是 TTL 首折注入（通道 B）与低预算注入的「各只消费一次」旗标，起点若是 `true` 就等于
    //   首轮直接宣称「已消费过」，本次 run 的 run-state 注入形状整段消失，属可观察行为。
    //   三格都**没有任何 ctx 访问器**（纯闭包状态：写者只有 `recordCompactionLayer` 回调、注入判定
    //   分支与 resume 后的重置段，读者只有注入判定表达式），故本组只改读写点前缀、无访问器形状问题。
    //   TDZ：原声明点（:1210/:1211/:1212）就是这三个符号的全文件首次出现（逐符号
    //   `grep -nE "(^|[^.a-zA-Z0-9_])<符号>\b"` 数过：6 / 4 / 5 行，全部落在声明之后），提先初始化不可观察。
    ttlInjectArmed: false,
    ttlInjectConsumed: false,
    lowBudgetInjectFired: false,
    // 【E 轮内量（续）】`foldedRoundCount`（原 :1204）与 `navigationRecordCount`（原 :1205）——两个
    //   **有初值**的累计计数器，初值逐字原样搬（都是 `0`）：它们的值经 `createDeterministicRunState` 的
    //   `foldedRounds:` / `navigationRecords:` 两个键落盘并渲染进模型可见的 run-state 文本，起点不是装饰。
    //   ⚠ 两个**跨符号近名陷阱**原样保住：① 写入点 `+= foldedRounds` 里的 `foldedRounds` 是当轮折叠数的
    //   局部量，与本格 `foldedRoundCount` 是两个符号；② `navigationRecord`（局部量）与本格只差后缀。
    //   ⚠ 对象键名 `foldedRounds:` / `navigationRecords:` 与符号名**不同名**（是 run-state 的导出选项键，
    //   宿主/持久化契约），只改值、不改键。访问器只有一对（`restoreResume` 的 ctx 对象），形状原样。
    //   TDZ：原声明点（:1204/:1205）就是这两个符号的全文件首次出现（逐符号
    //   `grep -nE "(^|[^.a-zA-Z0-9_])<符号>\b"` 数过：7 / 7 行，全部在声明之后），提先初始化不可观察。
    foldedRoundCount: 0,
    navigationRecordCount: 0,
    // 【E 轮内量（三）】`lowBudgetPrompted`（原 :1203）、`toolErrorCount`（原 :1206）、
    //   `runSnapshotFailureCount`（原 :1207）——三个**有初值**的格子，初值逐字原样搬（`false` /
    //   `0` / `0`）。这三格是**同一符号挂在两个不同 ctx 对象上各一对 get/set**的形状：
    //   `restoreResume` 的 ctx（`resume-manager.js` 写：`ctx.lowBudgetPrompted = false` 等三处）与
    //   `runSnapshotContext`（`run-snapshot-executor.js` 读写：`ctx.toolErrorCount += 1`、
    //   `ctx.runSnapshotFailureCount += 1`、`ctx.lowBudgetPrompted = true`）——**两个对象都改了**，
    //   漏一个就是「一个 ctx 读到格子、另一个读到已死的闭包变量」。访问器形状一律没动
    //   （六对 get/set 全部只改函数体，没有补、没有删、没有合并）。
    //   ⚠ 对象简写陷阱两处（`toolResultFold` 里的 `lowBudgetPrompted,` 与 run-state 调用里的
    //   `lowBudgetPrompted,` / `toolErrorCount,`）已改成 `键: runLoopState.符号`，键名一字未动；
    //   `runSnapshotFailureCount` 的导出键名是**旧名** `checkpointFailureCount`（issue #83），只改值。
    //   TDZ：原声明点（:1203/:1206/:1207）就是这三个符号的全文件首次出现（逐符号
    //   `grep -nE "(^|[^.a-zA-Z0-9_])<符号>\b"` 数过：11 / 10 / 10 行，全部在声明之后），提先初始化不可观察。
    lowBudgetPrompted: false,
    toolErrorCount: 0,
    runSnapshotFailureCount: 0,
    // issue #386 切片 3：**单轮聚合输出预算**是否已经撞过线（本 run 内一旦为真就不再复位）。
    // 写者只有 `runSnapshotContext.markAggregateBudgetHit`（聚合层把某条工具输出归档/stub 化时记账），
    // 读者只有 guard 补跑桥的预算闸——它回答「再补一轮会不会继续撕输出预算」。
    // 初值 `false` 逐字照「未发生过」；不入 run-state（它只影响本次进程的补跑决定，
    // 而配额本身已经由 `governorState.guardExtensionUsed` 落盘，不需要第二个跨 resume 判据）。
    aggregateBudgetHit: false,
    // 【E 轮内量（四）】`currentTerminationReason`（原 :1213）——**有初值**的格子，初值 `"running"` 逐字
    //   原样搬（它是 run-state `termination.reason` 的起点，也是「本次 run 还没结束」这个语义的唯一表示）。
    //   ⚠ 两处写在 `fail()` 里，位置**早于**原声明点（原 :941 / :965，声明在原 :1213）：迁移前它们读的就是
    //   那个尚未执行的 `let`，靠的是「`fail()` 的调用点全部晚于声明」。TDZ 复证（当前行号，别引用旧刀结论）：
    //   `fail(` 的调用点只有 `:1528`（`restoreResume` 的早退 catch）与 `:3298`（主 try/catch），跨文件两处是
    //   `resume-manager.js:272`（经 `restoreResume` 实参，`await restoreResume({...})` 在 `:1366`）与
    //   `termination.js:310` 的 `ctx.fail(...)`（`terminationManager` 在 `:2130` 才建出来）——全部晚于本状态
    //   对象的声明点（`:673`），也晚于原 `let` 的声明点 ⇒ 任何可观察时点读到的值不变，提先初始化不可观察；
    //   搬进 `:673` 的对象之后，`fail()` 里的两次写反而**不再有** TDZ 暴露面。
    //   ⚠ run-state 的导出键名是 `terminationReason:`（与符号名不同名），只改值；`terminationContext` 上
    //   `get/set currentTerminationReason` 是唯一一对访问器（`get currentRunState` 那种「只有 get」的形状这里没有）。
    currentTerminationReason: "running",
    // 【F-1 治理记账（M1）】`readLoopPayload`（原 :955）与 `verificationReader`（原 :965）——
    //   两个**函数型**格子，即 issue #180 / #165 的「可变槽位」手法：`fail()`（调用点 `:1563`
    //   与 `:3333`）里 `:1563` 这一次（`restoreResume` 的 catch）**早于**两处接管赋值（`:1596` /
    //   `:1613`），必须读到**默认桩**
    //   ——`usage` 全 0 / `rounds: 0` / `finalText: ""`，以及 `verificationReader()` 返回
    //   `undefined`（于是 `emitRunOutcome` 的条件展开 `:1016` 不写 `verification` 字段）。⇒ 初值
    //   **不许**写成 `undefined`：源码里**没有** `typeof readLoopPayload === "function"` 这类守卫
    //   （`grep` 现在唯一的一行命中就是本注释自己），`:1067` / `:1011` 是**裸调用**，格子非
    //   函数就是 TypeError；也不许照抄 `termination.js` 的 `typeof … === "function"` 风格。
    //   ⚠ 一律「属性 + 箭头函数」，**不是方法简写**——`test/loop-callback-this.test.js` 钉住
    //   「loop 回调以 `this === undefined` 调用」，方法简写会把 this 绑到这个状态对象上。
    //   ⚠ 接管闭包读 `runLoopState.rounds`（`:1596`）：本组是第一个「格子的值引用同一状态对象
    //   其它格」的形状（A–E 无先例）；读发生在**调用时**，那时 `:673` 早已初始化完，无 TDZ。
    //   TDZ：原声明点（`:955` / `:965`）就是这两个符号的全文件首次出现（逐符号
    //   `grep -nE "(^|[^.a-zA-Z0-9_])<符号>\b"` 数过：4 / 3 行，全部落在声明之后），提先初始化不可观察。
    readLoopPayload: () => ({
      usage: { input_tokens: 0, output_tokens: 0 },
      rounds: 0,
      finalText: "",
    }),
    verificationReader: () => undefined,
    // 【F-1 治理记账（M2）】`judgeRecordCorrelation`（原 :982）与 `judgeRecordCount`（原 :983）。
    //   `judgeRecordCorrelation`（issue #165）同样是**晚接管**格子：初值是纯函数
    //   `judgeRecordFields({ runId })`（`judge-record.js`，只铺 runId、探不到模型就不写字段），
    //   模型名要等 provider/模型配置与 reflection 段解析完才可得 ⇒ 接管赋值仍在原位置（`:1242`）。
    //   初值可提先：`runId` 在 `:507` 解构、全文件**无任何再赋值**（`grep -nE "runId *=[^=]"` 空），
    //   `judgeRecordFields` 是 `:62` 的 import ⇒ 在 `:673` 求值与在原声明点求值**取到同一个值**。
    //   ⚠ 两处**展开读点**（`emitRunOutcome` 的 `...runLoopState.judgeRecordCorrelation` 与
    //   `emitJudge` 的 `{ ...runLoopState.judgeRecordCorrelation, ...info }`）同样是读点，
    //   不许漏——展开不是属性访问，看着像但它是一整格的浅拷贝。
    //   `judgeRecordCount`：初值 `0` 逐字原搬；⚠ `emitRunOutcome` 里原先是**对象简写**
    //   `judgeRecordCount,`，加前缀会**改键名** ⇒ 必须写成 `judgeRecordCount: runLoopState.judgeRecordCount`；
    //   `+= 1` 留在 `emitJudge` 内 `typeof onJudge !== "function"` 早退**之后**的原分支里
    //   （宿主没挂 `onJudge` 就不计数——这条计数口径是 run_outcome 的公开字段）。
    //   TDZ：原声明点（`:982` / `:983`）就是这两个符号的全文件首次出现（逐符号
    //   `grep -nE "(^|[^.a-zA-Z0-9_])<符号>\b"` 数过：3 / 3 行，全部落在声明之后），提先初始化不可观察。
    judgeRecordCorrelation: judgeRecordFields({ runId }),
    judgeRecordCount: 0,
    // 【F-2 治理开关】`roundJudgeEnabled`（原 :1202）、`roundJudgeFailures`（原 :1209）、
    //   `wrapupNormalizationEnabled`（原 :1256）——三格都是**运行期可关断**的治理开关与其失败计数：
    //   roundJudge 连续失败到 `roundJudgeFailureLimit`（const，现 :1236，**不是**本格的一分子）就
    //   永久关断（`:3100`/`:3146` 两处 `= false`），wrapup LLM 归一化失败一次就关断（`:3017`），
    //   `roundJudgeFailures` 在 judge 判成功后复位为 `0`（`:3114`）——三处写点都是真行为，不是死存储。
    //   ⚠ `roundJudgeEnabled` / `wrapupNormalizationEnabled` 的**初值不在这里**：它们读 `:1227` 的
    //   `const reflectionEnabled`、`:1263` 的 `const wrapupEnabled` 与 `:1222` 的 `effectiveReflection`，
    //   这三个 const 全部声明在**本字面量之后** ⇒ 把初值提进来不是「不可观察」而是 **TDZ
    //   `ReferenceError` 直接抛错**。故走 `hadToolUse` 先例：此处只放**占位 `false`**，真值在原声明
    //   位置（现 `:1233` / `:1292`）赋值，赋值点仍早于各自的全文件首读点（`:3092` / `:2975`）。
    //   `roundJudgeFailures` 的初值是常量 `0`，无 TDZ 问题，逐字原搬进字面量。
    roundJudgeEnabled: false,
    roundJudgeFailures: 0,
    wrapupNormalizationEnabled: false,
    // 【F-2 双 ctx 拦截记账】`judgeInterceptCount`（原 :1228，初值是常量 `0` ⇒ 直接进字面量，无 TDZ）
    //   与 `interceptJudgeDecision`（原 :1229，**无初值** ⇒ 显式写 `undefined`）。
    //   这两格在 orchestrator 内**没有任何裸读写点**，全部经**两个 ctx 对象上的四枚访问器**
    //   （`restoreResume` 入参 ctx 一对，现 `:1585`–`:1596`；`runSnapshotContext` 一对，现 `:2376`–`:2387`）被跳文件读写：
    //   `run-snapshot-executor.js` 的 `:377` 读（`>= ctx.judgeIntervalRound`）、`:379` `+= 1`、
    //   `:416` 与 `:516` 复位 `= 0`、`:424` 判 `ctx.interceptJudgeDecision === undefined`、
    //   `:425` 写入 decision；`resume-manager.js:227` 用已执行工具数给计数播种。
    //   ⚠ `interceptJudgeDecision` 的 `undefined` **本身就是语义**：`:424` 那一判是「本轮尚未
    //   拦到扩轮决策」的跳文件判据，不能拿 `null` / `{}` 假冒初值（那会让扩轮决策被丢弃）。
    //   ⚠ 四枚访问器一对都不许删、不许只改一半：只委托一处，另一对会在原 `let` 被删后踩
    //   `ReferenceError`（静默断链，不是红测试）。
    judgeInterceptCount: 0,
    interceptJudgeDecision: undefined,
  };
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
  // issue #497（S2）：`config` 与同名扁平键同时给了**不同的值**时 config 赢，且必须让宿主看见
  // （范围 2：冲突不许静默）。复审 R4：装配口 `policy.config` 与调用级 `config` 两个源同时在场时
  // 也一样——取值仍是「后写者胜、整棵覆盖」，但逐叶冲突走**同一条事件、同一套字段**
  // （`conflicts: [{ path, key }]`），否则同一棵树的两种来源会比「扁平 vs config」更静默。
  // issue #498（S4a）：第二个容器 `capabilities` 走同一条出口——`capabilities.hooks.<name>` 与同名
  // 扁平回调都给了不同的值 ⇒ 同一条事件、同一套字段，只是 path 形如 `hooks.onEvent`。
  // 不新增事件类型是刻意的：载荷说的是「一个旋钮两个真相来源」，path 说明是哪个容器。
  // 与上面两条启动期诊断同口径：直调 `onEvent`（`emitEvent` 定义在
  // 下方，引用会踩 TDZ），本地复刻隔离防护。与它们不同的是本事件**只可能在启动期发生一次**，
  // 所以不需要去重标记。载荷只带路径与键名（值可能是函数/大对象，不进事件）。
  const notifyConfigOverrideConflicts = () => {
    if (configConflicts.length === 0) return;
    try {
      onEvent?.({
        type: "config_override_conflict",
        runId,
        conflicts: configConflicts,
        detail: "config.* / capabilities.hooks.* win over the same-named flat option (the flat key is"
          + " still accepted), and a call-level config or capabilities tree overrides the assembly port's"
          + " policy.config / policy.capabilities as a whole tree; every leaf that both sources set to"
          + " different values is listed in conflicts",
      });
    } catch (hostError) {
      reportObserverError(hostError, {
        channel: "onEvent",
        type: "config_override_conflict",
      });
    }
  };
  notifyConfigOverrideConflicts();
  // issue #182：预算元数据缺失时本 run 的压缩总开关不进入（budgetTokens 未定义 → overBudget 恒
  // false）、单轮聚合输出预算（#120）整体关闭、输出截断上限退回 4096，而此前全链路零告警
  // （真机 92 轮 run compaction=0）。一次性诊断事件让宿主能在验收/CI 里直接断言「我的装配是否
  // 把压缩关掉了」；去重与直调 onEvent?.() 的风格照抄上方 notifyCapabilitySkipped（同样绕开
  // 定义在下方的 emitEvent，本事件在启动期预算推导段触发，引用会踩 TDZ），每 run 最多一条。
  // 同理，detail 引用的 outputHygieneLimit 也在下方声明：本函数的唯一调用点在它之后，更早调用会踩 TDZ。
  // `modelMetadataNoticeSent`（#182 去重标记）已迁入上方 `runLoopState`（issue #177 刀5-A）。
  const notifyModelMetadataMissing = () => {
    if (runLoopState.modelMetadataNoticeSent) return;
    runLoopState.modelMetadataNoticeSent = true;
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
      ? (runLoopState.toolExecutedThisRound ? "executed_uncommitted" : "not_started")
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
  // `readLoopPayload`（原 :955）与 `verificationReader`（原 :965）这两个可变槽位已迁入上方
  // `runLoopState`（issue #177 刀5 F-1）：默认桩在 `:673` 的字面量里，接管赋值仍留在原位置
  // （`usage`/`finalText` 就绪处与 `verification` 就绪处），早退 fail() 读到的仍是默认桩。
  // issue #165：judge 记录的关联字段（runId + 模型标识）与 run 级 outcome 汇总。
  // 沿用 #180 `readLoopPayload` 的可变槽位手法：模型名要等 provider/模型配置与 reflection 段
  // 解析完才可得（下方 `judgeRecordCorrelation` 在那里接管），`verification` 则到累计量声明区才存
  // 在（早退 catch 时还在 TDZ），所以未就绪时一律「不写字段」而非写假值。
  // `judgeRecordCorrelation`（原 :982）与 `judgeRecordCount`（原 :983）已迁入上方 `runLoopState`
  // （issue #177 刀5 F-1）：默认值在 `:673` 的字面量里，接管赋值仍留在下方原位置（`:1242`）。
  // `runOutcomeEmitted`（#165 去重标记）已迁入上方 `runLoopState`（issue #177 刀5）。
  // run 级 outcome 汇总走既有 onEvent 通道（新增事件类型 `run_outcome`，不新增回调）：
  // `onJudge` 的 payload 语义是「一条 judge 决策」，把终局裁决塞进去会让宿主按决策计数/过滤
  // 的代码静默跑偏。宿主回调抛错经 reportObserverError 记账（#173 PR-B 统一口径：一切观察者
  // 抛错都上报、都不改变终局——这条是审计面记录，run 已跑完，宿主日志失败不会让它变 `failed`）。
  const emitRunOutcome = (outcome) => {
    if (typeof onEvent !== "function" || runLoopState.runOutcomeEmitted) return;
    runLoopState.runOutcomeEmitted = true;
    try {
      const verification = outcome?.verification ?? runLoopState.verificationReader();
      onEvent(runOutcomeRecord({
        ...runLoopState.judgeRecordCorrelation,
        ...outcome,
        judgeRecordCount: runLoopState.judgeRecordCount,
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
    runLoopState.currentTerminationReason = initialReason;
    if (!originalPersistence && runLoopState.currentRunState?.deterministic) {
      runLoopState.currentRunState.deterministic.termination = { reason: initialReason };
      runLoopState.currentRunState.rendered = renderRunState(runLoopState.currentRunState);
      try {
        await persist("saveRunState", runId, runLoopState.currentRunState);
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
    runLoopState.currentTerminationReason = reason;
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
    const loopPayload = runLoopState.readLoopPayload();
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
  // issue #469-②③：摘要这一发的**输入上限**与**结果状态**。上限复用上面算出的 `budgetTokens`（
  // 不新引第二套窗口口径），预留 prompt guide / 省略注 / 分词误差的余量；无窗口配置 ⇒ 不设上限。
  const summarizerInputBoundTokens = Number.isFinite(budgetTokens) && budgetTokens > 0
    ? Math.max(1024, Math.floor(budgetTokens) - 2048)
    : undefined;
  /** @type {{finishReason?: string, inputTokens?: number, outputTokens?: number, inputTruncated?: boolean}|undefined} */
  let lastSummarizerMeta = undefined;
  // issue #493（下游 fde-station 实测）：摘要那一发的 `maxTokens` 以前**原样继承 run 的**
  // （实测 32768），与摘要预算 `maxSummaryTokens`（默认 1400）完全脱钩 ⇒ 模型按 32k 写满、
  // 再被 1400 剪回，白烧 token。这里**取小对齐**：`min(run 的 maxTokens, context.maxSummaryTokens)`。
  const summaryMaxTokens = Math.min(
    maxTokens === undefined ? Number.POSITIVE_INFINITY : maxTokens,
    context?.maxSummaryTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
  );
  const compactionSummarizer = createProviderSummarizer({
    chat: async (request) => {
      if (typeof provider?.chat !== "function" && typeof provider?.chatStream !== "function") {
        throw new TypeError("fold-llm default summarizer requires a provider with chat/chatStream");
      }
      const summarizerRequest = {
        ...request,
        // issue #469-①：摘要器自带超时时它已把 `request.signal` 换成子 controller 的 signal
        // （父 signal 已转发进去），这里不得再用 run 的 signal 覆盖；没配超时时无处赋值 ⇒ 逐字不变。
        signal: request.signal ?? signal,
        // issue #493：与摘要预算取小对齐（不再原样继承 run 的 maxTokens）。
        ...(Number.isFinite(summaryMaxTokens) ? { maxTokens: summaryMaxTokens } : {}),
      };
      const response = await awaitWithAbort(
        typeof provider.chat === "function"
          ? provider.chat(summarizerRequest)
          : provider.chatStream({ ...summarizerRequest, onDelta: () => {} }),
      );
      // issue #438：折叠摘要器是**引擎自己发起**的调用 ⇒ 只进 engine 桶（不进模型轮账）。
      addUsage(response, undefined, { trackLatest: false, account: "engine" });
      return response;
    },
    ...(onUsage === undefined ? {} : { onUsage }),
    ...(summarizerInputBoundTokens === undefined
      ? {}
      : { maxSummarizerInputTokens: summarizerInputBoundTokens }),
    // issue #469（宿主要求「上限开成 `context` 旋钮」）：provider 层**单发**超时。
    // 不传 = 逐字等于今天（`createProviderSummarizer` 自己的 30 s 默认）；非法值已在装配期
    // 被 `validateFoldSummarizerCaps` 拦下。注意它只管**单发**，整条步骤的死线是另一个
    // 键 `context.summarizerBudgetMs`（两层语义刻意不合并）。
    ...(context?.summarizerTimeoutMs === undefined
      ? {}
      : { summarizerTimeoutMs: context.summarizerTimeoutMs }),
    // issue #486 P1-B：父 signal 必须真的接进摘要器。超时恒开（默认 30 s）⇒
    // `request.signal` 恒存在，上面 chat 包装的 `request.signal ?? signal` 就把 run 的
    // signal 永久短路了；子 controller 没接父 abort ⇒ 宿主 abort 之后这一发 HTTP 继续跑
    // （token 照扣且不进 engineUsage，因为 `awaitWithAbort` 已经抛出）。这里补上转发。
    signal,
    // issue #469-①（评审 P1）：关思考的**形态**按协议选——vLLM/Qwen 用
    // `enable_thinking` + `chat_template_kwargs`，Anthropic 不认这两个键（400）且思考默认就关，
    // 那边退回 `"inherit"`。判据只有 provider 自己声明的 `protocol`，不猜模型名。
    thinkingMode: summarizerThinkingMode(provider?.protocol),
    // issue #469-③：今天引擎**从不看**这次调用的结果状态（被 `max_tokens` 截成半截也当完整
    // 摘要嗬下去）；先把 finish_reason / token / 被裁条数暂存在闭包，由 `recordCompactionStat`
    // 写进 `compactionStats[].foldSummary`（#469-④）。观察性质，失败不得影响折叠。
    onMeta: (meta) => { lastSummarizerMeta = meta; },
  });
  // issue #326（wo-C）：**折叠摘要的「落账 + 复用」缝在引擎自产摘要这一处**（三档内置策略的生成
  // 逻辑一字不动）。账本 = 折叠输入指纹 → 已经喂出去的那份摘要：
  //   - 命中 ⇒ 直接返回，**不再调 provider**（同一 run 的后续折叠与 resume 都走这条路）；
  //   - 未命中 ⇒ 真调一次，随即记账，由 `compactBeforeRound` 把它写成轮记录上的 `foldedSummary` 事实。
  // 为什么缝在这里而不是策略里：策略的 `compact()` 内部自己调 summarizer，引擎只有在**注入的
  // summarizer** 上才有确定性钩子；宿主自带的策略对象（自带 summarizer）由宿主自己负责重算，
  // 引擎照旧把喂出去的摘要入账（可解释性不受影响）。见 docs/host-consumer-contract.md「折叠摘要与 TTL 降级事实」。
  const foldSummaryLedger = createFoldSummaryLedger();
  /**
   * issue #469（裁决 A）：resume 灌回来的账本（`seedFoldSummaries` 里赋值）。
   * 续写基底播种只能取这份——策略实例是新造的，in-run 闭包在 resume 后第一次折叠时是空的。
   * @type {object[]|undefined}
   */
  let resumedLedgerRecords;
  /**
   * issue #469（裁决 A）：账本自己声明的最大已折轮号（三种落盘形状都收）。
   * 只在 run 的水位线还没推出来时兜底——播种要的是「账本折到哪了」，不是「这一轮 run 记到哪了」。
   *
   * @param {object[]|undefined} records
   * @returns {number}
   */
  const ledgerWatermark = (records) => {
    if (!Array.isArray(records)) return 0;
    let watermark = 0;
    for (const record of records) {
      const candidates = [
        record?.foldedRoundRange?.to,
        record?.foldedSummary?.foldedRoundRange?.to,
        record?.foldedFacts?.to,
      ];
      for (const value of candidates) {
        if (Number.isSafeInteger(value) && value > watermark) watermark = value;
      }
    }
    return watermark;
  };
  /** @type {{ fingerprint: string, summary: string, reused: boolean, roundRange?: any}|undefined} */
  let lastFoldSummaryOutcome = undefined;
  const reusableCompactionSummarizer = async (input = {}) => {
    const fingerprint = foldSummaryFingerprint(input);
    const reused = foldSummaryLedger.lookup(fingerprint);
    const roundRangePart = input?.roundRange === undefined
      ? {}
      : { roundRange: input.roundRange };
    if (reused !== undefined) {
      lastFoldSummaryOutcome = { fingerprint, summary: reused, reused: true, ...roundRangePart };
      return reused;
    }
    const summary = await compactionSummarizer(input);
    foldSummaryLedger.remember(fingerprint, summary);
    lastFoldSummaryOutcome = { fingerprint, summary, reused: false, ...roundRangePart };
    return summary;
  };
  // main 的 ADR-016 退役了 resourceStore 端口——compactionContext 不再拼它（两侧语义合并）
  // 名字在启动期一次性解析成实例（未知名字/非法类型 → 启动期 TypeError）；对象形态原样
  // 透传（同一引用），下游 configuredStrategy 通道零改动。名字形态额外吃 context 级的
  // recoveryHint/stubFor（对象形态这两个字段依旧由宿主自己在策略对象上给，语义不变）。
  // #498 S4c: the strategy object may arrive on the port (`capabilities.ports.strategy`) or in the
  // legacy `context.strategy` slot (which also still accepts a built-in name — a name is data, so it
  // is *not* a port value). `resolveCompactionStrategy` returns an object verbatim, so an injected
  // strategy keeps its identity and its `shouldCompact` / `compact` methods are the ones called.
  const configuredStrategyInput = capabilityPorts.strategy ?? context?.strategy;
  const resolvedContextStrategy = configuredStrategyInput === undefined
    ? undefined
    : resolveCompactionStrategy(configuredStrategyInput, {
      options: {
        ...(foldHookValue("recoveryHint") === undefined ? {} : { recoveryHint: foldHookValue("recoveryHint") }),
        ...(foldHookValue("stubFor") === undefined ? {} : { stubFor: foldHookValue("stubFor") }),
      },
      // issue #469（宿主要求 B1）：三个**策略层**上限经这里透传。落点必须是 `foldLlmOptions`
      // —— `resolveCompactionStrategy` 只对**内置名字形态**把 `foldLlmOptions` 展进工厂
      // （`strategy-resolution.js`），所以：宿主用对象形态自带策略时这三个键**不适用**
      // （契约里写明，不让它变成静默无效）。
      // `optionValue()` 是「callOptions 优先、构造 options 兜底」，所以这里透传即生效。
      foldLlmOptions: {
        summarizer: reusableCompactionSummarizer,
        // issue #469（宿主裁决 A）：**账本播种**。resume 出来的 run 第一次折叠的续写基底
        // = 「按水位线覆盖当上下文的那份折叠摘要」。取源走 `pickCoveringFoldAlternative`
        // （不只 `foldedSummary` 事实行，`foldedFacts` 策略替代物也算；嵌套 `foldedRoundRange.{from,to}`
        // 与平铺 `{from,to}` 两种形状都在它里面收）。
        // 优先级**最低**（见 `fold-llm.js#resolveContinuationBase`）：显式参数 > 构造参数 >
        // in-run 闭包 > 账本；非 resume 或挑不出覆盖事实 ⇒ 返回空 ⇒ 逐字退回今天的形状。
        // 取值器而非常量：水位线要到恢复之后才定，且同一 run 内折叠后它会被 in-run 闭包接管。
        ledgerPreviousSummary: () => pickCoveringFoldAlternative(
          resumedLedgerRecords,
          // 水位线优先用 run 自己的那份（restore 从账本推导）；它为 0 时退回「账本自己声明的
          // 最大已折轮号」——否则「账本里有折叠事实、但本轮 run state 还没推出水位线」这一格
          // 会让播种静默失效（A 在最需要它的那一次折叠上归零）。三种落盘形状都要收：
          // 顶层 `foldedRoundRange.to`、`foldedSummary.foldedRoundRange.to`、`foldedFacts.to`。
          runLoopState.foldedThrough >= 1
            ? runLoopState.foldedThrough
            : ledgerWatermark(resumedLedgerRecords),
        )?.fact?.text,
        ...(context.summarizerBudgetMs === undefined
          ? {}
          : { summarizerBudgetMs: context.summarizerBudgetMs }),
        ...(context.maxSummarizerInputBytes === undefined
          ? {}
          : { maxSummarizerInputBytes: context.maxSummarizerInputBytes }),
        ...(context.maxPriorSummaryBytes === undefined
          ? {}
          : { maxPriorSummaryBytes: context.maxPriorSummaryBytes }),
        // issue #493：它以前是唯一没开的那个（直连路径静默无效、装配口反倒报错）。
        ...(context.maxSummaryTokens === undefined
          ? {}
          : { maxSummaryTokens: context.maxSummaryTokens }),
      },
    });
  const compactionContext = context === undefined && budgetTokens === undefined
      && Object.keys(capabilityFoldHooks).length === 0
    ? undefined
    : {
        ...(context ?? {}),
        // #498 S4c: the capability hooks that live in the `context` shell win over the nested slot
        // (container over legacy spelling, the same direction as everywhere else). They reach the
        // strategies exactly where the old slot did: `compactOptions` below copies
        // `onBeforeFold` / `onAfterFold` / `stubFor` / `protectedMessage` out of this object, and
        // `resolveCompactionStrategy` reads `recoveryHint` / `stubFor` for the name-form strategies.
        ...capabilityFoldHooks,
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
        ...(resolvedContextStrategy === undefined ? {} : { strategy: resolvedContextStrategy }),
      };
  const baseToolContext = {
    // #550: `session` is not a term here any more — the container must not leak into the tool
    // context, and the opaque payload's one reader is the fold-context shell (`context.session`).
    ...toolContextFor({
      toolContext,
      context,
      expert,
      user,
      task,
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
  // #498 S4c: the extension notification is a capability hook (`capabilities.hooks.onReflection`)
  // whose legacy home is the nested slot `reflection.onReflection`. Resolved once here so the
  // delivery point inside the loop cannot drift from the documented precedence.
  const onReflectionHook = capabilityHooks.onReflection ?? effectiveReflection?.onReflection;
  // `roundJudgeEnabled` 已迁入 `runLoopState`（issue #177 刀5 F-2）：初值**必须**留在本处原声明点
  // 现算——它读上面 `:1227` 的 `const reflectionEnabled` 与 `:1222` 的 `effectiveReflection`，两者都
  // 晚于状态对象字面量（`:673`–`:833`），提先进字面量就是 TDZ `ReferenceError`（工单 §3.1）。
  // 字面量里的 `false` 只是占位；真值在此赋值，且早于全文件首读点（`:3092`），求值点/副作用不变。
  runLoopState.roundJudgeEnabled = reflectionEnabled
    && effectiveReflection?.roundJudge !== false
    && process.env.ERIX_NO_ROUND_JUDGE?.trim() !== "1";
  const roundJudgeFailureLimit = Number.isSafeInteger(effectiveReflection?.judgeFailureLimit)
    && effectiveReflection.judgeFailureLimit > 0
    ? effectiveReflection.judgeFailureLimit
    : 3;
  // `roundJudgeFailures` 已迁入 `runLoopState`（issue #177 刀5 F-2）：初值是常量 `0`，直接写进
  // 状态对象字面量（无 TDZ 问题）；`+= 1` 与 `= 0` 复位在 `:3099`/`:3145`/`:3114`。
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
  // issue #322：中途审计判定「目标已达成」时，把评审意见回灌给主模型的开关（默认关）。
  // 非法值（非布尔）报错沿用本文件既有选项校验的形态：`TypeError` +
  // `<父键>.<子键> must be a boolean`（同 `partialPersistence.minBytes must be a positive integer`
  // 与 `assembly port session.resume must be a boolean` 两条既有文案）。
  // 开关只控「多一条软提示」：不改判定、不拦写、不提前终止。
  if (effectiveReflection?.judgeDoneAdvisory !== undefined
    && typeof effectiveReflection.judgeDoneAdvisory !== "boolean") {
    throw new TypeError("reflection.judgeDoneAdvisory must be a boolean");
  }
  const judgeDoneAdvisoryEnabled = effectiveReflection?.judgeDoneAdvisory === true;
  // `judgeInterceptCount` / `interceptJudgeDecision` 已迁入 `runLoopState`（issue #177 刀5 F-2）：
  // 前者初值是常量 `0`、后者无初值（`undefined`），两格都已在状态对象字面量里建行（`:831`/`:832`）；本处原本两行
  // `let` 删除后，四个访问器（`:1585`–`:1596` 与 `:2376`–`:2387`）与两处裸读写点全部改读格子，键名/形状一字未动。
  const wrapupEnabled = wrapup !== false
    && process.env.ERIX_NO_WRAPUP_INSTRUCTION?.trim() !== "1";
  const mainSystem = wrapupEnabled
    ? `${system ?? ""}${system ? "\n\n" : ""}${WRAPUP_INSTRUCTION}`
    : system;
  // 归一化 evaluator：复用 judge/provider 配置（无 judge 时主 provider），供 wrapup LLM 归一化用
  const judgeConfig = effectiveReflection?.judge;
  // #498 S4c: `capabilities.ports.judgeProvider` is the canonical home of the judge evaluator; the
  // legacy nested slot `reflection.judge.provider` still wins over the main provider, and the pure
  // alias `judge.evaluator` is retired (it throws in the semantic phase). The port feeds the same
  // three places the old slot fed: judge evaluation, the wrapup normalizer and the reported
  // `judgeModel`.
  const judgeProviderPort = capabilityPorts.judgeProvider;
  const wrapupEvaluator = judgeProviderPort ?? judgeConfig?.provider ?? provider;
  // issue #165：接管 judge 记录的关联字段——每个 judge 决策（round / intercept / degraded，
  // 含 run-snapshot-executor 里的拦截决策）都经下方 `emitJudge` 这个唯一收口打上 runId 与
  // 模型标识。模型名一律从 run 选项/provider 配置探（`judge-record.js`），探不到就不写字段；
  // judge 走独立 evaluator 时额外写 `judgeModel`，与 run 同名时不写（无冗余字段）。
  runLoopState.judgeRecordCorrelation = judgeRecordFields({
    runId,
    model: resolveRunModelName({
      modelConfig: resolvedModelConfig,
      modelMetadata,
      model,
      provider,
      context,
    }),
    judgeModel: resolveModelName(judgeProviderPort ?? judgeConfig?.provider),
  });
  // wrapup LLM 归一化（默认关闭：保持既有纯文本轮行为与旧测试兼容）。
  // 开启：ERIX_WRAPUP_NORMALIZE=1 或 reflection.wrapupNormalize===true。
  // benchmark/harness 场景应开启——找不到 JSON（含空文本）就该归一化。
  // `wrapupNormalizationEnabled` 已迁入 `runLoopState`（issue #177 刀5 F-2）：同 `roundJudgeEnabled`，
  // 初值读上面 `:1263` 的 `const wrapupEnabled`（晚于状态对象字面量）⇒ 提先是 TDZ，故字面量放占位
  // `false`、真值留在本处原声明点赋值，仍早于首读点 `:2975`。
  runLoopState.wrapupNormalizationEnabled = wrapupEnabled && (
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
    // issue #386 切片 3：guard 补跑的**一次性配额**（每个 run 最多 1 次，独立于 `extensionCount`——
    // governor 还有扩轮额度也不许 guard 领第二份）。它必须**跨 resume 不重置**：否则
    // 「跑 → 崩 → resume」每次都领一份新配额 = 无界成本，所以它随 run-state 落盘、由
    // `resume-manager.js` 恢复（见 `deterministic.guardExtension`）。
    guardExtensionUsed: false,
    noToolStreak: 0,
    wrapUpNudged: false,
    errorSeen: new Map(),
    runningLog: [],
    l0Facts: [],
    timeline: [],
    filesWritten: [],
    // issue #388：**原始**写路径台账（与 `filesWritten` 并列、同源、同上限）。
    // 分工：`filesWritten` = judge 提示用的摘要（40 码点、不裁斜杠、无截断标记）；
    // `fileWrites` = 判据用的原值（可直接 `stat()`）。两个键名不许混用。
    fileWrites: [],
  };
  const toolStats = new Map();
  // `lowBudgetPrompted` 已迁入 `runLoopState`（issue #177 刀5-E）。
  // `foldedRoundCount` / `navigationRecordCount`
  //   已迁入 `runLoopState`（issue #177 刀5-E）。
  // `toolErrorCount` / `runSnapshotFailureCount`
  //   已迁入 `runLoopState`（issue #177 刀5-E）。
  // `runStateVersion` / `runStateAvailability` / `currentRunState` / `todoState` / `semanticState`
  //   已迁入 `runLoopState`（issue #177 刀5-D）。
  // `ttlInjectArmed` / `ttlInjectConsumed` / `lowBudgetInjectFired`
  //   已迁入 `runLoopState`（issue #177 刀5-E）。
  // `currentTerminationReason` 已迁入 `runLoopState`（issue #177 刀5-E）。
  const compactionStats = [];
  const trimFilesWritten = () => {
    const seen = new Set();
    const kept = [];
    for (let index = governorState.filesWritten.length - 1;
      index >= 0 && kept.length < FILE_LEDGER_LIMIT;
      index -= 1) {
      const file = governorState.filesWritten[index];
      if (!seen.has(file.path)) {
        seen.add(file.path);
        kept.push(file);
      }
    }
    governorState.filesWritten = kept.reverse();
  };
  // issue #388：`fileWrites` 用**同一个**上限常量（`FILE_LEDGER_LIMIT`）与同一套去重/保新语义。
  // 为什么不另写一个数字：切片 1 报告点名的就是「两处各一个 50」那种会静默不一致的形状。
  const trimFileWrites = () => {
    const seen = new Set();
    const kept = [];
    for (let index = governorState.fileWrites.length - 1;
      index >= 0 && kept.length < FILE_LEDGER_LIMIT;
      index -= 1) {
      const file = governorState.fileWrites[index];
      if (!seen.has(file.path)) {
        seen.add(file.path);
        kept.push(file);
      }
    }
    governorState.fileWrites = kept.reverse();
  };
  // issue #388：把一段消息里写工具声明的**原始**路径记进 `fileWrites` 台账。
  // 主循环与 resume 都只调这一个函数（两份实现 = 两种口径，那正是 #388 的根因形状）。
  const recordFileWrites = (sourceMessages, round) => {
    for (const write of rawWritePaths(sourceMessages, 0, {
      writeToolNames: resolvedWriteToolNames,
      writeToolPathKeys: resolvedWriteToolPathKeys,
    })) {
      governorState.fileWrites.push({ path: write.path, round, tool: write.name });
      trimFileWrites();
    }
  };
  // `stallStreak` / `lastStallSignature` 已迁入 `runLoopState`（issue #177 刀5-B）。
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
  // issue #404（工单 BB「复活赛告示」）：`restoreResume`（`src/loop/resume-manager.js`）造好的那条告示
  // 先存在这里，由主循环圈前（`appendResumeTailMessages()` 之后）注入。写成**普通局部变量 + 一对
  // 访问器**（与紧邻的 `taskBriefSource` 同一个先例）：它是「本次 resume 的一次性事实」，不归
  // `runLoopState`（那里放的是要跟整个 run 走、跨 resume 有语义的格子）；注入完就清空，所以
  // guard 补跑桥绕回主循环时不会再注入一次。
  /** @type {{ text: string, slot: string, round: number } | undefined} */
  let resumeNotice;
  // issue #420（A 集合入账）：`restoreResume` 从 run snapshot 接回来的那批「崩溃前**已执行完、结果已成型、
  // 账本里没有对应 `tool_result` 行**」的结果（A 集合）。它同样是「已成型但未落盘」的消息，必须和补跑
  // 跑出来的结果（B 集合）走**同一条写侧**（`appendMessageRowToTranscript` + `partOf`）。
  // 写成**普通局部变量 + 一对访问器**（与紧邻的 `resumeNotice` / `taskBriefSource` 同一个先例）：
  // `restoreResume` 的 resume 分支只读 transcript 账本；账本写入一律在本文件
  // （`appendMessageRowToTranscript` / `persist`），失败语义与 `seq` 计数器只有一处。它只负责把批次
  // 交出来，写入口是本文件的 `journalResumeUnpersistedToolResults`，由它在补跑段之前逐条入账。
  /** @type {any[]} */
  let resumeUnpersistedToolResults = [];
  // issue #424（守卫）：崩溃轮的正文里**是否已有 assistant 行**（`restoreResume` 在已折叠的账本条目上算好
  // 交过来）。`false` = 升级路径（崩溃轮的 assistant 正文只在快照里）⇒ A 集合整段不入账，退回修前的
  // 「只进内存」语义。`undefined` = 本次不是崩溃现场恢复（没有 A 集合，走不到守卫）。
  /** @type {boolean|undefined} */
  let resumeCrashRoundAssistantPersisted;
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
  // `rounds`（身份轮号）已迁入 `runLoopState.rounds`（issue #177 刀5）；下方口径注释仍然成立。
  // `budgetRounds` 是**另一个**计数器（本次调用的预算消耗），本组未动。
  let budgetRounds = 0;
  // `foldedThrough` 已迁入 `runLoopState.foldedThrough`（issue #177 刀5）。
  // 【C 组第1刀】`resumePendingTools` / `resumeTailMessages` / `resumeRunSnapshotMessages` /
  //   `persistedTranscriptLength` 已迁入 `runLoopState`（issue #177 刀5 C 组，格子在状态对象末尾）。
  // 【C 组第2刀】`resumeTranscriptStart`（原 :1268）/ `lastPersistenceFailure`（原 :1273）同上。
  // 【C 组第3刀】`resumeRunSnapshot`（原 :1265）也已迁入 `runLoopState.resumeRunSnapshot`，它的
  //   `@type {Record<string, any>|undefined}` 注解（原 :1264，issue #177 刀1 为喂 `--checkJs` #214 棘轮
  //   而加，零运行时影响）**随字段逐字搬到状态对象那一格上**：这个值只由 `restoreResume` 经
  //   `set resumeRunSnapshot` 访问器赋值，控制流分析看不见那条赋值，注解丢了 `resumeRunSnapshot.round`
  //   就会退回 TS2339（… on type 'never'）——本组唯一一行类型注解，一行也没删。
  const resumeExecutedToolIds = new Set();
  const resumeRunSnapshotResults = new Map();
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
    // issue #326（wo-C）：恢复时把**已入账的折叠摘要**灌回引擎的复用账本 ⇒ 同一折叠输入不再调摘要器。
    // 写成「属性 + 箭头函数」（`test/loop-callback-this.test.js` 钉住的口径），不是方法简写。
    seedFoldSummaries: (records) => {
      foldSummaryLedger.seedFromRecords(records);
      // issue #469（裁决 A）：把账本留给「续写基底播种」用——resume 出来的 run 第一次折叠
      // 拿不到 in-run 闭包（策略实例是新造的），只能靠这份账本。非 resume ⇒ 永不赋值。
      resumedLedgerRecords = records;
    },
    get currentRunState() {
      return runLoopState.currentRunState;
    },
    set currentRunState(value) {
      runLoopState.currentRunState = value;
    },
    get runStateAvailability() {
      return runLoopState.runStateAvailability;
    },
    set runStateAvailability(value) {
      runLoopState.runStateAvailability = value;
    },
    get runStateVersion() {
      return runLoopState.runStateVersion;
    },
    set runStateVersion(value) {
      runLoopState.runStateVersion = value;
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
    get resumeNotice() {
      return resumeNotice;
    },
    set resumeNotice(value) {
      resumeNotice = value;
    },
    get resumeUnpersistedToolResults() {
      return resumeUnpersistedToolResults;
    },
    set resumeUnpersistedToolResults(value) {
      resumeUnpersistedToolResults = value;
    },
    get resumeCrashRoundAssistantPersisted() {
      return resumeCrashRoundAssistantPersisted;
    },
    set resumeCrashRoundAssistantPersisted(value) {
      resumeCrashRoundAssistantPersisted = value;
    },
    messageRounds,
    get rounds() {
      return runLoopState.rounds;
    },
    set rounds(value) {
      runLoopState.rounds = value;
    },
    get foldedThrough() {
      return runLoopState.foldedThrough;
    },
    set foldedThrough(value) {
      runLoopState.foldedThrough = value;
    },
    get resumeRunSnapshot() {
      return runLoopState.resumeRunSnapshot;
    },
    set resumeRunSnapshot(value) {
      runLoopState.resumeRunSnapshot = value;
    },
    get resumePendingTools() {
      return runLoopState.resumePendingTools;
    },
    set resumePendingTools(value) {
      runLoopState.resumePendingTools = value;
    },
    get resumeTailMessages() {
      return runLoopState.resumeTailMessages;
    },
    set resumeTailMessages(value) {
      runLoopState.resumeTailMessages = value;
    },
    get resumeTranscriptStart() {
      return runLoopState.resumeTranscriptStart;
    },
    set resumeTranscriptStart(value) {
      runLoopState.resumeTranscriptStart = value;
    },
    get persistedTranscriptLength() {
      return runLoopState.persistedTranscriptLength;
    },
    set persistedTranscriptLength(value) {
      runLoopState.persistedTranscriptLength = value;
    },
    // 工单 261021（第三刀）：恢复路径要从账本播 `seq` 计数器与崩溃轮的首片行 key。
    get messageSeqByRound() {
      return runLoopState.messageSeqByRound;
    },
    get resumeToolResultRowKey() {
      return runLoopState.resumeToolResultRowKey;
    },
    set resumeToolResultRowKey(value) {
      runLoopState.resumeToolResultRowKey = value;
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
    // issue #388：原始写路径台账的裁剪器（与 `trimFilesWritten` 共用 `FILE_LEDGER_LIMIT`）
    // 与台账写入口（resume 从账本重建时调它，不另写一份解析）。
    trimFileWrites,
    recordFileWrites,
    get lowBudgetPrompted() {
      return runLoopState.lowBudgetPrompted;
    },
    set lowBudgetPrompted(value) {
      runLoopState.lowBudgetPrompted = value;
    },
    get foldedRoundCount() {
      return runLoopState.foldedRoundCount;
    },
    set foldedRoundCount(value) {
      runLoopState.foldedRoundCount = value;
    },
    get navigationRecordCount() {
      return runLoopState.navigationRecordCount;
    },
    set navigationRecordCount(value) {
      runLoopState.navigationRecordCount = value;
    },
    get toolErrorCount() {
      return runLoopState.toolErrorCount;
    },
    set toolErrorCount(value) {
      runLoopState.toolErrorCount = value;
    },
    get runSnapshotFailureCount() {
      return runLoopState.runSnapshotFailureCount;
    },
    set runSnapshotFailureCount(value) {
      runLoopState.runSnapshotFailureCount = value;
    },
    get semanticState() {
      return runLoopState.semanticState;
    },
    set semanticState(value) {
      runLoopState.semanticState = value;
    },
    get compactionStats() {
      return compactionStats;
    },
    set compactionStats(value) {
      compactionStats.splice(0, compactionStats.length, ...(Array.isArray(value) ? value : []));
    },
    get todoState() {
      return runLoopState.todoState;
    },
    set todoState(value) {
      runLoopState.todoState = value;
    },
    get judgeInterceptCount() {
      return runLoopState.judgeInterceptCount;
    },
    set judgeInterceptCount(value) {
      runLoopState.judgeInterceptCount = value;
    },
    get interceptJudgeDecision() {
      return runLoopState.interceptJudgeDecision;
    },
    set interceptJudgeDecision(value) {
      runLoopState.interceptJudgeDecision = value;
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
  // ── issue #438：用量分账（**纯加法**：`usage` 的口径与形状一字不动）────────────────────────
  // 病根：主循环里 `response` 在续写循环（`stopReason:"max_tokens"`）里被**逐发覆盖**，而轮记录
  // `record.response.usage` 读的就是这同一个变量 ⇒ 一轮真花 700+700+7 = 1407 个 `output_tokens`，
  // 档案只记最后一发的 7（评审实测，200 倍量级失真），而「它只含最后一发」从没写进契约。
  // 分账口径（四个桶，互不重叠）：
  //   · `modelUsage` / `roundUsage` —— 主模型自己的响应（含续写每一发）；
  //   · `engineUsage` / `roundEngineUsage` —— **引擎自发起的调用**：round judge / 收尾归一化 /
  //     折叠摘要 / 强制收尾。混进模型账里，宿主就分不开「模型话多」与「引擎开销大」。
  // `finalGuard` 是宿主回调（引擎不发起、也测不到它的用量）⇒ 两个桶都不计，见契约。
  const modelUsage = { input_tokens: 0, output_tokens: 0 };
  const engineUsage = { input_tokens: 0, output_tokens: 0 };
  let roundUsage = { input_tokens: 0, output_tokens: 0 };
  let roundEngineUsage = { input_tokens: 0, output_tokens: 0 };
  let roundEngineCallCount = 0;
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
  runLoopState.readLoopPayload = () => ({ usage, rounds: runLoopState.rounds, finalText });
  let declaredFindings;
  // issue #386 切片 1：模型最后一次 wrap-up 对象（**已归一化**的那一份，不重新解析）。
  // 与 `declaredFindings` 永远在同一处赋值（`wrapupJson` / `normalizedWrapup` / 强制收尾三处），
  // 所以 `finalGuard` payload 的 `selfReport` 与 `findings` 是同源的。
  let selfReport;
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
  runLoopState.verificationReader = () => verification;
  // issue #386 切片 3：`guard_extensions` 只在**真的补跑过**时由 `extendAfterGuard` 现写（未 opt-in
  // 或 opt-in 但一次没补的 run，`metrics` 必须与今天逐字一致），所以这里只声明成可选键——纯注解，
  // 不往字面量里加任何键（加了就等于给未补跑的 run 多一个 `guard_extensions: 0`）。
  // issue #392：`deliverables_machine_only` 同理——只在 guard `skip` + 判据全通过（机器证据单独构成
  // 验收）那一格由 `callFinalGuard` 现写，其余任何一格都不出现这个键。
  /** @type {{ verified: number, skipped: number, revised: number, unverified: number, guard_error: number, deliverables_checked?: number, deliverables_failed?: number, deliverables_machine_only?: number, guard_extensions?: number }} */
  const guardMetrics = {
    verified: 0,
    skipped: 0,
    revised: 0,
    unverified: 0,
    guard_error: 0,
    // issue #386 切片 2：这两个键**只在声明了 `deliverables` 时才存在**——未声明时 metrics 必须与
    // 今天逐字一致（`test/loop-deliverables.test.js` 的 R4-1 回归锚逐字比的就是这份对象）。
    // 语义与既有五个计数同口径：一个 run 内**累计**（多次 guard 调用/多次 revise 各自累加）。
    ...(resolvedDeliverables === undefined
      ? {}
      : { deliverables_checked: 0, deliverables_failed: 0 }),
  };
  // `hadToolUse` 已迁入 `runLoopState`（刀5-B）：初值仍在本行原来声明处现算（求值点/副作用不变），
  // 之前没有任何语句读它，所以只是把存储位置换成状态对象的一格。
  runLoopState.hadToolUse = hasToolUseInMessages(messages);
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

  // issue #326（wo-C）：**TTL 降级事实的产生即入账**。`compactionStats.layers.ttl.triggered` 只有一个计数，
  // 回答不了「这条工具结果被降级成了什么」⇒ provider-runner 每次 attempt 逐条上报，这里立刻写成引擎
  // 命名空间的补充记录（`…:ttl:<fp>`）。生成策略未动：`foldToolResultsForRequest` 仍只改请求视图，
  // `ctx.messages` 依旧存全文；同一 attempt 重试上报同一事实 ⇒ 同指纹同键 ⇒ 幂等（#326 第1步判据）。
  const rememberTtlDegradations = async (roundNumber, degradations) => {
    const byToolUseId = new Map();
    for (const entry of Array.isArray(degradations) ? degradations : []) {
      if (entry === null || typeof entry !== "object" || entry.toolUseId === undefined) continue;
      byToolUseId.set(entry.toolUseId, entry);
    }
    if (byToolUseId.size === 0) return false;
    return appendEngineFactToTranscript(roundNumber, "ttl", {
      ttlDegradations: [...byToolUseId.values()],
    });
  };

  const emitJudge = (info) => {
    if (typeof onJudge !== "function") return;
    // issue #165（additive）：先铺关联字段再铺决策字段——既有字段名与语义一律不动，
    // 只增 runId/model/judgeModel（探不到时字段缺省）；旧宿主按原字段读，行为不变。
    runLoopState.judgeRecordCount += 1;
    try {
      onJudge({ ...runLoopState.judgeRecordCorrelation, ...info });
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

  // 把一份 provider usage 累加进一个计数器（issue #438）：只搬四个计数字段，不换算、不补 0、
  // 不改写来源。`cacheRead`/`cacheWrite` 只在来源报过时才出现（与 `usage` 既有口径同构）。
  const accumulateUsage = (target, source) => {
    if (source === null || typeof source !== "object") return target;
    for (const key of ["input_tokens", "output_tokens", "cacheRead", "cacheWrite"]) {
      const value = source[key];
      if (Number.isFinite(value)) target[key] = (target[key] ?? 0) + value;
    }
    return target;
  };

  /**
   * 记一次 provider 调用的用量。
   * `account:"engine"` = 引擎自发起的调用（judge / 归一化 / 折叠摘要 / 强制收尾），
   * 缺省 `"model"` = 主循环里模型自己的响应（含续写每一发）。
   */
  const addUsage = (response, estimatedTokens, { trackLatest = true, account = "model" } = {}) => {
    const source = response?.usage;
    accumulateUsage(usage, source);
    if (account === "engine") {
      accumulateUsage(engineUsage, source);
      accumulateUsage(roundEngineUsage, source);
      roundEngineCallCount += 1;
    } else {
      accumulateUsage(modelUsage, source);
      accumulateUsage(roundUsage, source);
    }
    const inputTokens = source?.input_tokens;
    if (Number.isFinite(inputTokens) && trackLatest) {
      latestApiInputTokens = inputTokens > 0 ? inputTokens : undefined;
      latestApiEstimatedTokens = Number.isFinite(estimatedTokens)
        ? estimatedTokens
        : undefined;
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

  // 跳通道身份键（工单 261014 T1 / issue #284）：一次调用只分配一次，同值从「第一个可识别的
  // 流式片段」一路带到 tool_use 块、onToolCall fragment、tool_result、事件与投影。
  // 一个 provider attempt 一具注册表：被重试丢弃的那次 attempt 不该与真正执行的那次共用身份；
  // 而 resume/run snapshot 复放的块带着旧值回来，`ensureToolCallKeyOnBlock` 只复用不重生。
  // provider `id` / `tool_use_id` 是协议配对键（`src/messages/rounds.js` 的配对校验、快照复放
  // 查找都靠它），本单只读它、绝不改写它。
  let toolCallKeys = createToolCallKeyRegistry();
  const beginToolCallAttempt = () => {
    toolCallKeys = createToolCallKeyRegistry();
  };
  // 新调用（含 resume 里那条尚未产结果的 pending 调用）的认领：块上已带的值优先（那是同一次
  // 调用的复放把旧值带回来了），本 attempt 的流式片段已绑过的值其次，最后才现场分配。
  const claimToolCallKey = (block, confirmedReplay) => {
    const known = toolCallKeys.peek(block);
    if (known !== undefined) return known;
    return toolCallKeys.claimForBlock(block, confirmedReplay);
  };
  // resume 崩溃现场里那条**尚未产出结果**的 pending 调用：上下文（含 snapshot.messages 带回的
  // 历史）里同 id、且**没有配对 tool_result** 的那个 tool_use 块就是它本人，它的 key 就是要沿用
  // 的旧值（工单 261014 T1-fix 第 1 项明列的两个确认继承路之一）。已配过结果的同 id 旧块一律
  // 排除 —— 那正是 provider id 跳轮重复时会串号的那一类，所以这里不是「按 id 扫历史」。
  // 确认不到（升级前的旧快照，两端都没有该字段）则交回调用点现场分配：本轮的 tool_use 与
  // 它的 interrupted 结果共用同一个新值，两端仍然一致。
  const crashSitePendingKey = (
    /** @type {any} */ block,
  ) => {
    const id = typeof block?.id === "string" && block.id !== "" ? block.id : undefined;
    if (id === undefined) return undefined;
    let answered = false;
    let pending;
    for (const message of messages) {
      for (const candidate of (Array.isArray(message?.content) ? message.content : [])) {
        if (candidate?.tool_use_id === id && candidate?.type === "tool_result") answered = true;
        if (candidate?.type === "tool_use" && candidate?.id === id
          && typeof candidate?.erix?.toolCallKey === "string"
          && candidate.erix.toolCallKey !== "") pending = candidate.erix.toolCallKey;
      }
    }
    return answered ? undefined : pending;
  };
  // `toolCallKey` 的继承**只认「能确认是同一次调用的复放」**（工单 261014 T1-fix 第 1、2 项）：
  //   · 块上已带值 —— `claimToolCallKey` 的 `peek` 那条路；
  //   · 本轮复放窗口 `snapshotResults` 命中（与下面 `:2985` 那条复放分支同一份数据、同一个键），
  //     此时这次调用的身份**就是那条已记录结果里的身份**。
  // 绝不按 provider `id` 扫历史消息继承：provider 的 tool-call id **不保证 run 内唯一**（轮内
  // index 前缀，或畸形响应兜底成常量 `call_legacy`，见 issue #284），扫历史等于把串号从 `id`
  // 原样搬进 `toolCallKey`；`12968ee` 的复放也只按 `snapshotResults` 取，没有「扫历史」这一路。
  // id 仍是协议配对键：只读，不改写，也不拼进 key。
  // 返回 `null` = **本轮不认领任何 key**：复放的记录是升级前写入的（没有 `erix.toolCallKey`），
  // 于是 `tool_use` 与 `tool_result` **两端一致地缺失**——给老记录补一个 key 会比两端都缺更糟
  //（一端有身份、另一端没有，宿主无法判断该信谁），见契约《The field lists》。
  const acceptedToolCallKey = (
    /** @type {any} */ block,
    /** @type {any} */ recordedToolResult,
  ) => {
    if (recordedToolResult === undefined) return claimToolCallKey(block);
    const recorded = recordedToolResult?.erix?.toolCallKey;
    return typeof recorded === "string" && recorded !== "" ? recorded : null;
  };
  const toolCallKeyForFragment = (fragment) => toolCallKeys.keyForFragment(fragment);

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
    // 流式片段身份键（跳通道同一 key）：attempt 开始时换一具新注册表，每个 fragment 取（或分配）
    // 一个 key；宿主在流式阶段建的卡因此能在 tool_use 到达时接上同一张卡。
    beginToolCallAttempt,
    toolCallKeyForFragment,
    claimToolCallKey,
    retryOptions,
    retryAttempts,
    backoffBaseMs,
    backoffMaxMs,
    emitEvent,
    // issue #292（additive 仓内可观测信号）：请求视图定稿处的 user 轮守卫生效过一次，
    // 就记一条带 userTurnGuard 的压缩统计（并走同一条 compaction 事件通道）。
    recordUserTurnGuard: ({
      round,
      action,
      channel,
      tokensBefore,
      tokensAfter,
    }) => {
      recordCompactionStat({
        tokensBefore,
        tokensAfter,
        layers: createEmptyCompactionLayers(),
        userTurnGuard: action,
        userTurnGuardChannel: channel,
      }, round);
    },
    recordCompactionLayer: async ({
      layerId,
      round,
      triggered,
      tokensBefore,
      tokensAfter,
      degradations,
    }) => {
      // issue #326（wo-C）：除了计数，还要把「这条工具结果被降级成了什么」逐条留事实（轮末入账）。
      if (layerId === "ttl" && Array.isArray(degradations) && degradations.length > 0) {
        await rememberTtlDegradations(round, degradations);
      }
      if (
        layerId === "ttl"
        && Number.isFinite(triggered)
        && triggered > 0
        && !runLoopState.ttlInjectConsumed
      ) {
        runLoopState.ttlInjectArmed = true;
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
        lowBudgetPrompted: runLoopState.lowBudgetPrompted,
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
    const resumedToolUse = runLoopState.resumePendingTools.find((candidate) => (
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
    runLoopState.lastPersistenceFailure = undefined;
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
        persistedTranscriptLength: runLoopState.persistedTranscriptLength,
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
        runLoopState.lastPersistenceFailure = error;
        return false;
      }
      throw error;
    }
  };

  // issue #326（B1）：**引擎自产文本的「产生即入账」**。
  // 轮记录只写 `messages.slice(roundStart)`，而 `roundStart` 在下一次进圈时重新取 `messages.length`
  // （见上方圈顶）⇒ **轮记录落盘之后**才 push 进 `messages` 的引擎消息永远落不进任何一条记录：
  // judge 评审意见（nudge）、扩轮续跑提示、finalGuard revise 意见、强制收尾指令与终稿 assistant。
  // 后果是「模型见过、档案里没有」：`store.load()` 的原始记录里 0 条，追问/审计/resume 都读不到
  // 引擎自己说过什么（探针实测 main 97bd957：messages 有、journal 无）。
  // 这里给这批消息开一条**引擎命名空间的补充记录**，在产生的那一刻写入：
  //   - 不新增 record kind、不新增消息标记字段：形状仍是既有 RoundRecord + 普通 message
  //     （注入内容本身带 #323 的 `meta.source === "judge-control"`，本轮不新造 marker）；
  //   - dedupKey 沿用 `:resume` 先例（引擎命名空间 + 轮号 + 槽位名）⇒ 宿主用默认键写过同行号的行
  //     不会被去重丢掉，同轮同槽位重放幂等（崩溃后重跑不产生第二行）；
  //   - 计入 `persistedTranscriptLength`：让 resume 快照锚点继续等于「journal 已落盘的消息总数」，
  //     不再把这条已落盘的消息当成「快照里没存过」而重复入账。
  const appendEngineMessagesToTranscript = async (produced, roundNumber, slot) => {
    const messagesToJournal = Array.isArray(produced) ? produced : [produced];
    if (messagesToJournal.length === 0) return false;
    const persisted = await persist("appendRound", runId, {
      round: roundNumber,
      roundKey: `${String(runId)}:round:${String(roundNumber)}`,
      dedupKey: `${String(runId)}:engine:round:${String(roundNumber)}:control:${String(slot)}`,
      messages: cloneState(messagesToJournal),
      ts: new Date().toISOString(),
    });
    if (persisted) runLoopState.persistedTranscriptLength += messagesToJournal.length;
    return persisted;
  };

  // 工单 261021（第二刀·写侧）：**一条消息一成型就落盘**——补齐上面那条先例没覆盖的那一半：
  // 轮记录原本把整轮正文（`messages.slice(roundStart)`）留到轮末才写，于是「模型已经看到、
  // 档案里还没有」的窗口覆盖整轮（工具执行期崩溃 ⇒ 本轮 assistant 正文与已完成的工具结果全丢）。
  // 行形状与读侧折叠层（`src/store/message-rows.js`）逐字对齐，否则正文折不回去：
  //   · `dedupKey = <runId>:msg:<round>:<seq>`，`seq` 轮内从 0 单调递增（计数器在 `runLoopState`）
  //     ⇒ 崩溃重跑同 `(round, seq)` 同内容 = 同 key 同 payload = `appendRound` 幂等跳过（不产生第二行）；
  //   · `kind: "message"` + `seq` 是折叠的两把钥匙（无 `seq` 的引擎控制文本行不参与折叠，原样透传）；
  //   · `partOf` = 同一逻辑消息首片行的 `dedupKey`：一轮的多个 `tool_result` 改造前是同一条 user
  //     消息的多个 content block，现在每个结果单独成行，靠 `partOf` 接回同一条消息。
  // `persistedTranscriptLength` 的口径仍然是「折叠后已落盘的**逻辑消息**总数」（= `restoreResume`
  // 的 `records.flatMap(record.messages).length`）⇒ 分片行（`partOf`）加 0，否则 resume 锚点会偏。
  /** @param {any} message @param {number} roundNumber @param {{ partOf?: string }} [options] */
  const appendMessageRowToTranscript = async (message, roundNumber, options = {}) => {
    if (message === undefined || message === null) return undefined;
    if (!Number.isSafeInteger(roundNumber)) return undefined;
    const seq = runLoopState.messageSeqByRound.get(roundNumber) ?? 0;
    runLoopState.messageSeqByRound.set(roundNumber, seq + 1);
    const dedupKey = `${String(runId)}:msg:${String(roundNumber)}:${String(seq)}`;
    const partOf = typeof options.partOf === "string" ? options.partOf : "";
    const persisted = await persist("appendRound", runId, {
      round: roundNumber,
      roundKey: `${String(runId)}:round:${String(roundNumber)}`,
      dedupKey,
      kind: MESSAGE_ROW_KIND,
      seq,
      messages: cloneState([message]),
      ts: new Date().toISOString(),
      ...(partOf === "" ? {} : { partOf }),
    });
    if (!persisted) return undefined;
    // 分片只往已有那条逻辑消息里加 block，不新增消息 ⇒ 锥点计数不变。
    if (partOf === "") runLoopState.persistedTranscriptLength += 1;
    return dedupKey;
  };

  // issue #420（A 集合入账）：把 `restoreResume` 交回来的那批「崩溃前已执行完、结果已成型、账本里没有
  // `tool_result` 行」的结果**逐条走与 B 集合同一条写侧**。
  //
  // 为什么写在这里（而不是让 `restoreResume` 自己写）：`restoreResume` 的 resume 分支只读 transcript 账本；
  // 账本写入一律在本文件（`appendMessageRowToTranscript` / `persist`），失败语义（`ctx.fail`）与 `seq`
  // 计数器只有一处。交接到主循环前由这一小段入账，与补跑段共用同一个 `resumeToolResultRowKey` 锚点。
  //
  // 锚点的两种情形（探查票点名的边界）：
  //   · 崩溃轮**已有**结果行落盘（`resumeToolResultRowKey` 有值）⇒ 首片用 `partOf` 接回那条聚合消息；
  //   · 崩溃轮**一条结果行都没落**（`resumeToolResultRowKey === undefined`）⇒ 首片不带 `partOf`，
  //     它**自己**就是新起的那条聚合消息（在账本里也是一条独立逻辑消息，`persistedTranscriptLength`
  //     随 `appendMessageRowToTranscript` 的 `partOf === ""` 分支 +1，与账本折叠后的逻辑消息数
  //     （`foldLedgerMessages`）对齐），然后把**它自己的** `dedupKey` 写回 `resumeToolResultRowKey`
  //     当后续分片（含 B 集合）的锚点。否则每个结果都会各起一条 user 消息：合法但形状变了，
  //     `#326` 的 `<runId>:msg:<round>:<seq>` 序号语义也跟着散掉。
  //
  // issue #430：**锚点写一次就钉住，不随分片推进**。分片行的 key 不是合法的 `partOf` 寻址目标——
  // 读侧折叠（`src/store/message-rows.js#foldLedgerMessages` / `#foldMessageRows`）对分片行不新增
  // 逻辑消息，于是它的 key 指向的是「下一条消息」。把锚点推进成「刚写那条分片的 `dedupKey`」时，
  // 第三片起就落空并**新起一条消息**（实测 `[[t1,t2],[t3]]`），第二次恢复永久 `invalid_messages`。
  // 所以下面只在**首片**写成功后落定一次 `rowKey`，之后一律 `partOf` 指向它。
  //
  // issue #424（守卫）：**崩溃轮的 assistant 正文不在账本里时，整段跳过入账**。升级路径（旧账本 +
  // 快照补全）上崩溃轮的 assistant 正文只存在于 run snapshot，`restoreResume` 只把它补进内存
  // `messages`（账本里没有那一行）；此时把 A 集合写成 `kind:"message"` 结果行，账本里就出现
  // 「有 `tool_result`、没有配对 `assistant`」的孤儿 ⇒ 下一次恢复在第一次模型请求之前就
  // `invalid_messages`（实测 issue #424）。跳过 ⇒ 账本内容与 #420 之前逐字一致（那批结果只进内存、
  // 由快照兜住），不可能比修前更坏；判据事实由 `restoreResume` 从**已折叠的账本条目**里算好交过来。
  const journalResumeUnpersistedToolResults = async () => {
    const unpersisted = resumeUnpersistedToolResults;
    if (!Array.isArray(unpersisted) || unpersisted.length === 0) return;
    // 一次性交接：无论下面写不写成，这批都不得在本次 run 里被第二次入账（guard 补跑桥会回到主循环）。
    resumeUnpersistedToolResults = [];
    const crashRound = runLoopState.resumeRunSnapshot?.round;
    if (resumeCrashRoundAssistantPersisted === false) {
      // 可观测：走既有 `onEvent` 通道（不新造机制）。宿主可据此知道「这批结果只在本次上下文里、
      // 没有入账」，下一次恢复仍要靠快照兜住。
      emitEvent({
        type: "resume_journal_skipped",
        runId,
        round: crashRound,
        reason: "crash_round_assistant_not_in_ledger",
        count: unpersisted.length,
      });
      return;
    }
    let rowKey = runLoopState.resumeToolResultRowKey;
    for (const toolResult of unpersisted) {
      const persistedRowKey = await appendMessageRowToTranscript(
        { role: "user", content: [toolResult] },
        crashRound,
        rowKey === undefined ? {} : { partOf: rowKey },
      );
      // issue #430：只在首片写成功后落定锚点，之后**不推进**（分片 key 不能当 `partOf` 目标）。
      if (rowKey === undefined && persistedRowKey !== undefined) rowKey = persistedRowKey;
    }
    if (rowKey !== undefined) runLoopState.resumeToolResultRowKey = rowKey;
  };

  // issue #326（wo-C）：**引擎自产「上下文事实」的产生即入账**——沿用上面同一先例的形状与命名空间风格
  // （引擎命名空间 + 轮号 + 槽位名），只多一个**事实指纹**后缀：同一事实崩溃后重跑幂等，不同事实
  // 换键 ⇒ 不会被 #326 第1步的「同 key 异 payload = 冲突」判据误伤（一轮里可能发生两次不同折叠）。
  //
  // 覆盖两类「模型见过、档案里没有」：
  //   - `fold:<fp>`：本次折叠**实际喂给模型的那份摘要**（轮记录只写 `messages.slice(roundStart)`，
  //     而 `roundStart` 取的是折叠**后**的长度 ⇒ 摘要消息永远不进任何轮记录；探针实测 journal 0 条）；
  //   - `ttl:<fp>`：某条工具结果在请求视图里**被降级成了什么**（占位符逐字 + 原始体积 + 原文指纹）。
  //
  // 与 `:control:` 行的唯一差别：这类事实不是消息 ⇒ `messages: []`。不往 `messages` 里掺正文是因为
  // `restoreResume()` 用 `records.flatMap(record.messages)` 重建上下文，掺进去就是把同一份正文恢复两遍；
  // 也不计入 `persistedTranscriptLength`（那个计数按「已落盘消息数」口径，空行加 0）。
  const appendEngineFactToTranscript = async (roundNumber, slot, facts) => {
    const factFingerprint = stableFingerprint(facts ?? {});
    const persisted = await persist("appendRound", runId, {
      round: roundNumber,
      roundKey: `${String(runId)}:round:${String(roundNumber)}`,
      dedupKey: `${String(runId)}:engine:round:${String(roundNumber)}:${String(slot)}:${factFingerprint.slice("sha256:".length)}`,
      messages: [],
      ts: new Date().toISOString(),
      ...(facts ?? {}),
    });
    return persisted;
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
          if (runLoopState.lastPersistenceFailure !== undefined) throw runLoopState.lastPersistenceFailure;
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
          if (runLoopState.lastPersistenceFailure !== undefined) throw runLoopState.lastPersistenceFailure;
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
        runLoopState.todoState = await todoStateProvider({ runId, rounds: runLoopState.rounds });
      } catch (error) {
        runLoopState.todoState = {
          status: "error",
          detail: String(error?.message ?? error).slice(0, 80),
        };
      }
    }
    const deterministic = createDeterministicRunState({
      runId,
      stateVersion: runLoopState.runStateVersion,
      rounds: runLoopState.rounds,
      runRounds: budgetRounds,
      maxRounds: governorState.effectiveMaxRounds,
      lowBudgetPrompted: runLoopState.lowBudgetPrompted,
      toolStats,
      filesWritten: governorState.filesWritten,
      todo: runLoopState.todoState,
      foldedRounds: runLoopState.foldedRoundCount,
      navigationRecords: runLoopState.navigationRecordCount,
      terminationReason: runLoopState.currentTerminationReason,
      toolErrorCount: runLoopState.toolErrorCount,
      // 键名保持旧名 checkpointFailureCount（issue #83）：它是 createDeterministicRunState 的
      // 导出选项键，且其值以 `errors.checkpoint` 落盘、渲染进模型可见的 run-state 文本行——
      // 三处均属宿主/持久化契约，改名是破坏性变更，故此处只改引擎内部变量名、不改键名。
      checkpointFailureCount: runLoopState.runSnapshotFailureCount,
      unpersisted: errorLedger.toUnpersisted(),
      compactionStats,
      // issue #386 切片 3：guard 补跑配额随 run-state 落盘（**跨 resume 不重置**的成本闸）。
      guardExtensionUsed: governorState.guardExtensionUsed,
    });
    if (semantic && typeof semanticStateProvider === "function") {
      try {
        const provided = await semanticStateProvider({
          runId,
          state: deterministic,
          previous: runLoopState.semanticState,
        });
        if (provided !== undefined) runLoopState.semanticState = provided;
      } catch (error) {
        runLoopState.semanticState = {
          status: "error",
          text: "",
          semanticStateVersion: runLoopState.runStateVersion,
          detail: String(error?.message ?? error).slice(0, 80),
        };
      }
    } else if (
      runLoopState.semanticState
      && runLoopState.semanticState.semanticStateVersion !== undefined
      && runLoopState.semanticState.semanticStateVersion !== runLoopState.runStateVersion
    ) {
      runLoopState.semanticState = {
        ...runLoopState.semanticState,
        status: "stale",
      };
    }
    runLoopState.currentRunState = withSemanticRunState({
      ...deterministic,
      stateAvailability: { ...runLoopState.runStateAvailability },
    }, runLoopState.semanticState);
    runLoopState.currentRunState.rendered = renderRunState(runLoopState.currentRunState);
    if (inject) {
      messages = upsertRunStateInMessages(messages, runLoopState.currentRunState.rendered);
    }
    await persist("saveRunState", runId, runLoopState.currentRunState);
    return runLoopState.currentRunState;
  };

  // issue #394：强制收尾那一路的**入账口**（`forceFinalIfNeeded` 结清尾部悬空 `tool_use` 时用）。
  // 为什么是回调而不是在 `src/loop/termination.js` 里写一份：那个模块不持有 store、不碰 persist
  // （journal 写入一直是 orchestrator 的职责面），结清动作的**入账口径**必须与这里同一份。
  // 为什么 `forceFinalAndJournal` 要把它排除在自己的切片之外：这条消息已经当场落了一行，
  // 再跟着切片落一次就是同一条 `tool_result` 两行 ⇒ `load()` 折回来会有两条结果指向同一个
  // `tool_use`，`validateMessages` 以「多余的结果」拒掉历史（resume 复发）。
  const journaledPendingTailToolResult = new WeakSet();
  const journalPendingTailToolResult = async (message, roundNumber) => {
    await appendEngineMessagesToTranscript(message, roundNumber, "forced-final-tool-result");
    journaledPendingTailToolResult.add(message);
  };

  const terminationContext = {
    finalGuard,
    finalGuardTimeout,
    // issue #386 切片 2：已规范化的判据清单（`undefined` = 未声明 ⇒ 引擎侧一条分支都不走）。
    deliverables: resolvedDeliverables,
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
    // issue #438：run 级分账两桶（`usage` 仍是两者之和，逐字不动）。
    modelUsage,
    engineUsage,
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
    // issue #394：结清尾部悬空 `tool_use` 的入账回调（强制收尾那一路；见上面那个 WeakSet）。
    journalPendingTailToolResult,
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
    // issue #386 切片 1：`finalGuard` payload 的加法键读取口（全部读引擎**既有**状态，零新采集）。
    cwd,
    runId,
    taskBrief,
    toolStats,
    elapsedMs,
    finalGuardRetryLimit,
    get filesWritten() {
      return governorState.filesWritten;
    },
    // issue #388：原始写路径台账（与 `filesWritten` 并列的第二个键，不是替换）。
    get fileWrites() {
      return governorState.fileWrites;
    },
    get selfReport() {
      return selfReport;
    },
    set selfReport(value) {
      selfReport = value;
    },
    get rounds() {
      return runLoopState.rounds;
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
      return runLoopState.currentRunState;
    },
    get currentTerminationReason() {
      return runLoopState.currentTerminationReason;
    },
    set currentTerminationReason(value) {
      runLoopState.currentTerminationReason = value;
    },
  };
  const terminationManager = createTerminationManager(terminationContext);
  const {
    callFinalGuard,
    forceFinalIfNeeded,
    finish,
  } = terminationManager;

  // issue #326（B1）：跑一次强制收尾，并把**它新产生的那几条消息**当场入账。
  // `forceFinalIfNeeded`（src/loop/termination.js）往 `ctx.messages` 里 push 两条：【强制收尾】指令
  //（纯文本 `judge-control`）与终稿 assistant。它只在「本轮记录已落盘之后」跑（`stop` 分支与出圈
  // 收尾两条路都是），而轮记录写的是 `messages.slice(roundStart)`、`roundStart` 下一轮重新取值
  // ⇒ 这两条不会出现在任何一条既有记录里：终稿是**终局正文**，宿主从 `store.load()` 里拼不出来。
  // 为什么入账口放在调用点而不是 termination.js 内部：那个模块不持有 store、不碰 persist（journal
  // 写入一直是 orchestrator 的职责面），而它又被 #271 的 readFile 行容量锚钉在 ±2% 内（HEAD 已用
  // 到 +1.5%，再加不下一行注释）。代价：崩溃正好落在收尾那一次 provider 调用里时，这两条要等
  // resume 重跑收尾时才会入账——那个窗口里本来也没有任何消息落盘（resume 靠 run snapshot 重建现场）。
  const forceFinalAndJournal = async (reason) => {
    const producedFrom = messages.length;
    await forceFinalIfNeeded(reason);
    // issue #394：结清动作产生的那条 `tool_result` 已由 `journalPendingTailToolResult` 当场落行，
    // 从切片里剔掉——否则同一条结果会落两行（见上面那个 WeakSet 的理由）。
    await appendEngineMessagesToTranscript(
      messages.slice(producedFrom).filter((message) => !journaledPendingTailToolResult.has(message)),
      runLoopState.rounds,
      "forced-final",
    );
  };

  const callRoundJudge = async (round, currentL0, { timeoutMs, conversationBudgetTokens } = {}) => {
    const l0Facts = [...governorState.l0Facts, { round, ...currentL0 }];
    const recentErrors = l0Facts
      .flatMap((fact) => fact.errorTexts ?? (fact.errorText ? [fact.errorText] : []))
      .filter((text, index, values) => values.indexOf(text) === index)
      .slice(-5);
    const judge = effectiveReflection?.judge;
    // #498 S4c: port first, then the legacy nested slot, then the run's main provider. `evaluator`
    // (the old alias of `judge.provider`) is retired — the semantic phase throws on it.
    const evaluator = judgeProviderPort ?? judge?.provider ?? provider;
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
    // issue #438：judge 是引擎自发起的调用 ⇒ 只进 engine 桶（不进模型轮账）。
    addUsage(response, undefined, { trackLatest: false, account: "engine" });
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

  // issue #409：判词里的「正确形状示例」用工具自己的 `inputSchema` 渲染（有就用，没有就泛化示例）。
  // 只读、只在这里建一次；`tools` 是宿主给的 ToolSchema 数组（`{name, description, inputSchema}`）。
  const toolSchemaByName = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool === null || typeof tool !== "object") continue;
    if (typeof tool.name !== "string" || tool.name === "") continue;
    toolSchemaByName.set(tool.name, tool.inputSchema ?? tool.input_schema);
  }

  const runSnapshotContext = {
    runId,
    executeTool,
    invalidArguments,
    toolSchemaFor(name) {
      return toolSchemaByName.get(name);
    },
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
    judgeDoneAdvisoryEnabled,
    get messages() {
      return messages;
    },
    markToolExecuted() {
      runLoopState.toolExecutedThisRound = true;
    },
    // issue #386 切片 3：聚合层撞线记账（写者见 `run-snapshot-executor.js#applyRoundAggregate`，
    // 读者见 `guardExtensionBudgetAllows`）。单向、幂等、无返回值。
    markAggregateBudgetHit() {
      runLoopState.aggregateBudgetHit = true;
    },
    get lowBudgetPrompted() {
      return runLoopState.lowBudgetPrompted;
    },
    set lowBudgetPrompted(value) {
      runLoopState.lowBudgetPrompted = value;
    },
    get toolErrorCount() {
      return runLoopState.toolErrorCount;
    },
    set toolErrorCount(value) {
      runLoopState.toolErrorCount = value;
    },
    get runSnapshotFailureCount() {
      return runLoopState.runSnapshotFailureCount;
    },
    set runSnapshotFailureCount(value) {
      runLoopState.runSnapshotFailureCount = value;
    },
    get lastPersistenceFailure() {
      return runLoopState.lastPersistenceFailure;
    },
    set lastPersistenceFailure(value) {
      runLoopState.lastPersistenceFailure = value;
    },
    get judgeInterceptCount() {
      return runLoopState.judgeInterceptCount;
    },
    set judgeInterceptCount(value) {
      runLoopState.judgeInterceptCount = value;
    },
    get interceptJudgeDecision() {
      return runLoopState.interceptJudgeDecision;
    },
    set interceptJudgeDecision(value) {
      runLoopState.interceptJudgeDecision = value;
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
    pendingJudgeDoneAdvisory,
  } = runSnapshotExecutor;

  // issue #322：达成 advisory 的**单槽**投递。正常 flush 与 resume flush 共用本函数，两处
  // 策略逐字一致；它**不**并入 `pendingDirectionHints` 那条 FIFO（也不参与它的 `slice(0, 2)`
  // 计数与「另有多次方向提示已合并」）。单槽天生消灭溢出：后到的达成意见覆盖先到的，
  // 所以不需要条数上限 / 合并去重 / 终身额度。文案不进 `tool_result`（独立 user text 消息）。
  const flushJudgeDoneAdvisory = (roundNumber) => {
    const text = pendingJudgeDoneAdvisory.text;
    if (typeof text !== "string" || text === "") return undefined;
    pendingJudgeDoneAdvisory.text = undefined;
    const advisoryMessage = {
      role: "user",
      // issue #323 刚确认的机制：引擎控制文本打 `meta.source`，`renderConversation()` 按它排除，
      // 于是主模型看得见、judge 读不回。不新增 marker 值，也不改排除判据。
      meta: { source: "judge-control" },
      content: [{ type: "text", text }],
    };
    messages.push(advisoryMessage);
    if (roundNumber !== undefined) messageRounds.set(advisoryMessage, roundNumber);
    return advisoryMessage;
  };

  const roundNumbersForMessages = (currentMessages) => {
    const grouped = groupIntoRounds(currentMessages).rounds;
    return grouped.map((group, index) => {
      const known = group.messages
        .map((message) => messageRounds.get(message))
        .find((roundNumber) => Number.isSafeInteger(roundNumber) && roundNumber > 0);
      return known ?? runLoopState.foldedThrough + index + 1;
    });
  };

  // issue #460：会话级归档去重账本（同一份正文只往轮记录里写一次）。
  // 它必须活在 run 作用域（`compactBeforeRound` 每次折叠都调），所以跟折叠入口同层声明。
  const foldArchiveLedger = createFoldArchiveLedger({ store, runId });
  // issue #464 A：库层兜底诊断事件的去重标记（每 run 恰好一条，口径同 #182 的
  // `modelMetadataNoticeSent`）。声明在 run 作用域、折叠入口之前，故跨该 run 内所有折叠调用共享。
  let compactionFallbackNoticeSent = false;
  const compactBeforeRound = async (round = runLoopState.rounds + 1) => {
    normalizeMessages(messages);
    // 每次折叠前清空「引擎自产摘要现场」：只有本次 compact 真的调了摘要器才会重新赋值（#326 wo-C）。
    lastFoldSummaryOutcome = undefined;
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
    /** issue #460：写进轮记录的归档（差分 + 字节夹断后的那一份），与上面的内存全量分开。 */
    let foldedArchive;
    let foldedRoundRange;
    let navigationRecord;
    let foldedRounds = 0;
    let compacted = false;
    /** @type {{ text: string, fingerprint: string, strategy: string, summary?: string, foldedRoundRange?: any }|undefined} */
    let foldedSummaryFact = undefined;
    // issue #470（A1）：策略顺手带出的**机械替代物**（`fold-statistical` 的统计摘要 /
    // `fold-llm` 降级分支的那份）。没配内置策略、或宿主自带策略不产它 ⇒ `undefined`，语义照旧。
    /** @type {{ source: string, text?: string, degradeReason?: string }|undefined} */
    let strategyFoldSummary = undefined;
    /** @type {ReturnType<typeof buildFoldedFacts>} 投影到本轮轮记录的 `foldedFacts`（#470-B 已夹字节） */
    let pendingFoldedFacts = undefined;
    let protectedDowngraded = 0;
    // issue #326 wo-C：折叠前的消息**引用集合**——用来认出折叠新造出来、实际喂给模型的那份摘要消息
    // （折叠策略把摘要 prepend 进 head，而轮记录只写 `messages.slice(roundStart)`⇒它永远不入账）。
    const preCompactionMessages = new Set();
    // issue #292 可观测信号（additive，只在守卫真的生效时出现）：
    // "preserved_latest_user_turn" | "abandoned_fold" | "unrecoverable"
    let userTurnGuard;
    let userTurnGuardChannel;
    if (strategyRequestsCompaction || overBudget) {
      const [budgetFallbackLayer, safetyFallbackLayer] = getCompactionFallbackChain();
      const strategy = strategyRequestsCompaction
        ? configuredStrategy
        : createSlidingWindowStrategy();
      // issue #464 A：兜底路径此前**零可观测痕迹**——`context.strategy` 未配置而预算又兜底触发时，
      // 实际执行的是引擎库层的 `sliding-window`（整轮 tail keep / head drop，无摘要、无锚点），
      // 而宿主从 `compaction` 事件里根本看不出来。形状对齐 #182 `model_metadata_missing`：
      // 每 run 恰好一条，detail 首句是固定原文（宿主可直接断言）。
      if (!configuredStrategy && !compactionFallbackNoticeSent) {
        compactionFallbackNoticeSent = true;
        emitEvent({
          type: "compaction_strategy_fallback",
          // runId 只在宿主传了时才写键（与 #182 `model_metadata_missing` 同口径：引擎不自编标识）。
          ...(runId === undefined ? {} : { runId }),
          round,
          detail: 'engine compaction fallback in effect: context.strategy is not configured, '
            + 'the library default "sliding-window" strategy drops whole head rounds without '
            + 'summary or anchors'
            + (budgetTokens === undefined
              ? ""
              : `; budgetTokens=${budgetTokens}, estimatedTokens=${estimatedTokens}`),
        });
      }
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
      if (runLoopState.foldedThrough > 0) compactOptions.roundOffset = runLoopState.foldedThrough;
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
      for (const message of messages) preCompactionMessages.add(message);
      if (!Array.isArray(result?.messages)) {
        throw new TypeError("Compaction strategy must return a messages array");
      }
      let compactedMessages = result.messages;
      foldedPayload = Array.isArray(result.foldedPayload)
        ? result.foldedPayload
        : [];
      foldedRoundRange = result.foldedRoundRange;
      navigationRecord = result.navigationRecord;
      strategyFoldSummary = result.foldSummary
        // issue #470（判据②）：零 LLM 策略（`sliding-window`）带出的键名是 `foldedSummaryText`，
        // 不是 `foldSummary` —— 只读后者的话，C 档那份机械文本**没有任何消费者**（既不进
        // `record.foldedFacts`，也不进消息流），"落账"就只是 return 对象上的一个死键。
        ?? (typeof result.foldedSummaryText === "string" && result.foldedSummaryText !== ""
          ? {
            text: result.foldedSummaryText,
            source: "strategy",
            strategy: typeof strategy?.name === "string" ? strategy.name : "unknown",
          }
          : undefined);
      // issue #470（判据②）就地兜底：引擎的折叠链路（TTL / 预算兜底 / 宿主策略包装）会把策略返回值
      // **重新组对象**，`foldedSummaryText` 在这一层就被丢掉（实测 onAfterFold 看到的 result 只有 7 个键）
      // ⇒ 只读策略键仍然等于没有消费者。这里用**同一份现成零件**就地现算机械替代物，并如实标
      // `source: "strategy"`：它是机械替代物，不是模型写的摘要。
      if (strategyFoldSummary === undefined
        && Array.isArray(foldedPayload) && foldedPayload.length > 0
        && Number.isSafeInteger(result.foldedRounds) && result.foldedRounds > 0) {
        const foldRangeForFacts = result.foldedRoundRange ?? undefined;
        strategyFoldSummary = {
          text: summarizeFoldedPayload(foldedPayload, {
            from: foldRangeForFacts?.from ?? 1,
            to: foldRangeForFacts?.to ?? result.foldedRounds,
            count: result.foldedRounds,
            recoveryHint: compactionContext.recoveryHint,
          }),
          source: "strategy",
          strategy: typeof strategy?.name === "string" ? strategy.name : "unknown",
        };
      }
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
          roundOffset: runLoopState.foldedThrough,
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
      // issue #292 不变量 I1 的另一半：压缩不许把持久列表里唯一的 user 轮删光。
      // 写回前在「持久视图定稿处」校一遍，回补来源是压缩前的 messages；
      // 不这么做的后果就是真上游那一枪：视图定稿处已经没有任何可回补的源。
      const compactionUserTurnGuard = {};
      const guardedMessages = ensureUserTurnView(compactedMessages, messages, compactionUserTurnGuard);
      if (isUserTurnGuardAction(compactionUserTurnGuard.action)) {
        compactedMessages = guardedMessages;
        tokensAfter = estimateMessageTokens(compactedMessages);
        userTurnGuard = compactionUserTurnGuard.action;
        userTurnGuardChannel = "persisted";
      }
      messages = compactedMessages;
      latestApiInputTokens = undefined;
      latestApiEstimatedTokens = undefined;
      runLoopState.hadToolUse = runLoopState.hadToolUse || hasToolUseInMessages(messages);
      // issue #460：落进轮记录的归档 ≠ 内存里的全量原文。内容源仍是策略给的 `foldedPayload`
      //（「被折轮原文」的权威口径），但落盘前过两道：
      //   ① 去重 —— 真机那条放大链是 resume 把整段账本重灌回上下文 ⇒ 每次折叠从 round 1 重抄
      //      一遍（差分总量 O(n²)），这里把「会话里已经归档过的正文」按指纹剔掉；
      //   ② 字节上限 —— 默认 256 KiB，`context.maxFoldedPayloadBytes` /
      //      `ERIX_FOLD_ARCHIVE_MAX_BYTES` 可调，保证「单条记录」这一维度对定界宿主有界。
      if (runLoopState.foldedThrough > 0) {
        // 只有 resume 过的会话才需要读账本把旧归档入账（一次 run 最多一次），且**只算早于
        // 本轮的归档** —— 把本轮上一次尝试写的那份算进来会让崩溃重跑同 key 不同 payload，
        // 被 store 的去重判据报成 `dedup_payload_conflict`（#460 review）。
        await foldArchiveLedger.ensureSeeded(round);
      }
      foldedArchive = buildFoldedRecordArchive({
        foldedPayload,
        ledger: foldArchiveLedger,
        stripHistoricalImages: compactionContext.stripHistoricalImages,
        maxBytes: compactionContext.maxFoldedPayloadBytes,
      });
      if (foldedRoundRange?.to !== undefined) {
        runLoopState.foldedThrough = Math.max(runLoopState.foldedThrough, foldedRoundRange.to);
      }
      if (
        foldedRounds > 0
        || foldedRoundRange !== undefined
        || navigationRecord !== undefined
      ) {
        runLoopState.foldedRoundCount += foldedRounds;
        if (navigationRecord !== undefined) runLoopState.navigationRecordCount += 1;
      }
      // issue #326（wo-C）：**实际喂出去的折叠摘要成为账本事实**。
      // 识别口径用**对象身份**：折叠策略把摘要 prepend 进 head（新对象），于是「不在折叠前引用集合里」
      // 的消息就是本次折叠造出来、确实进了请求的那份摘要。它走轮记录上的**独立事实字段**
      // `foldedSummary`（不新增 record kind、不新增消息标记字段、不往 messages 里掺正文——
      // 掺了就会被 resume 的 `records.flatMap(record.messages)` 恢复成两份正文）。
      // 复用同一折叠不重复入账：指纹已由 `foldSummaryLedger` / 已入账事实判过 ⇒ 只记首条。
      const fedSummaryText = messages
        .filter((message) => !preCompactionMessages.has(message))
        .map((message) => textFromBlocks(blocksFor(message?.content)))
        .filter((summaryText) => summaryText !== "")
        .join("\n\n");
      const foldedFingerprint = lastFoldSummaryOutcome?.fingerprint
        ?? foldSummaryFingerprint({
          messages: foldedPayload,
          roundRange: foldedRoundRange ?? null,
        });
      if (fedSummaryText !== "" && !foldSummaryLedger.journaled(foldedFingerprint)) {
        foldSummaryLedger.markJournaled(foldedFingerprint);
        foldedSummaryFact = {
          text: fedSummaryText,
          fingerprint: foldedFingerprint,
          strategy: typeof strategy?.name === "string" ? strategy.name : "unknown",
          ...(lastFoldSummaryOutcome === undefined
            ? {}
            : { summary: lastFoldSummaryOutcome.summary }),
          ...(foldedRoundRange === undefined ? {} : { foldedRoundRange }),
        };
        // ⚠ 行上**不放**顶层 `foldedRoundRange`：resume 用它算 `foldedThrough`（`records.map(r => r.foldedRoundRange?.to)`），
        // 事实行再带一份就会把同一区间数两遍（`loop-v020-rc` 的先例断言即此）。区间留在 `foldedSummary.foldedRoundRange` 里，
        // 由轮记录那份承担「档案字段」的角色。也不放 `folded: true`：那个键的既有含义是「本条轮记录所在的轮被折过」。
        await appendEngineFactToTranscript(round, "fold", {
          foldedSummary: foldedSummaryFact,
        });
      }
      // issue #470（A1，纯加法）：同一份替代物**同时投影到轮记录**的新键 `foldedFacts`。
      // 此前它只进消息流（`compactedHead`）：模型看得见，而读轮记录的两面——宿主横幅与
      // `resume_manager` 喨给 judge 的轮次历史（`record.summary ?? "missing"`，#470 ④）——什么也看不见。
      // 文本优先级：**策略带出的机械替代物**（零 LLM、形状稳定、天然有界）> 实际喂出去的那份正文
      // > **在定稿处就地现算的机械替代物**；三者都空 ⇒ `undefined` ⇒ 调用方**不写该键**
      //（#470-A2 的「不写占位字面量」口径）。
      // 实测红因（#470 判据②，现场探针输出见 docs/tasks/wip-470/tmp-dbg-470.txt）：
      //   `strategy.compact()` 那一层返回的对象键面只有
      //   `["messages","compacted","foldedRounds","tokensBefore","tokensAfter","foldedPayload"]`
      //   ⇒ **没有** `foldedSummaryText`；且那一层 `foldedRounds` 是 **0**，真正折走的轮是**后面
      //   预算兜底 / safety 兜底那两发**加进来的。所以只读策略键、或在 3109 那一层用
      //   `result.foldedRounds > 0` 当兜底闸门，都必然落空 ⇒ 必须在 `foldedPayload`/`foldedRounds`
      //   **定稿处**就地现算。用同一份现成零件 `summarizeFoldedPayload`，如实标 `source:"strategy"`：
      //   它是机械替代物，不是模型写的摘要。
      const factsTextFromSummary = strategyFoldSummary?.text ?? fedSummaryText;
      const factsText = factsTextFromSummary !== undefined && factsTextFromSummary !== ""
        ? factsTextFromSummary
        : (compacted && foldedRounds > 0 && foldedPayload.length > 0
          ? summarizeFoldedPayload(foldedPayload, {
            from: foldedRoundRange?.from ?? 1,
            to: foldedRoundRange?.to ?? foldedRounds,
            count: foldedRounds,
            recoveryHint: compactionContext.recoveryHint,
          })
          : "");
      pendingFoldedFacts = buildFoldedFacts({
        text: factsText,
        source: strategyFoldSummary?.source
          ?? (lastFoldSummaryOutcome === undefined ? "strategy" : "llm"),
        strategy: typeof strategy?.name === "string" ? strategy.name : "unknown",
        roundRange: foldedRoundRange ?? undefined,
        rounds: foldedRounds,
        degradeReason: strategyFoldSummary?.degradeReason,
        fingerprint: foldedFingerprint,
        // issue #470-D：夹断上界开了 `context` 旋钮（默认不变 = `FOLDED_FACTS_MAX_BYTES`），
        // 让宿主的「输入上限 / 输出预算 / 容器上限」三者可以同源；非法值（非正整数）
        // 由 `buildFoldedFacts` 自己退回默认，不静默变成 0 字节的空横幅。
        maxBytes: compactionContext.maxFoldedFactsBytes,
      });
      // issue #470-D：折叠替代物的**强制投递出口**。落点就在替代物定稿处，递的是
      // **落进轮记录的那一份**（`cloneState` 后加 `round` 供宿主归档），不给“更漂亮的副本”。
      // 三条口径（与契约同步）：
      //   ① **无 `text` 不调用**——`buildFoldedFacts()` 无文本时返回 `undefined` ⇒ 本块整体
      //      不发生，既不占通道也不造空横幅（与 A2「不写占位字面量」同口径）；
      //   ② 投递失败**不许改写 run 的终局**：经 `reportHostPersistenceFailure` 落
      //      `persistence_error{port:"notes"}`（账本 + `diagnostics.error` + `onPersistenceError`）；
      //   ③ 钩子自己抱错不能拖死循环：与其余观察者通道一样是 best-effort。⚠ 故意**不用**
      //      `reportObserverError`：它的出口是 `console.error`，而替代物是宿主侧的**数据**
      //      而不是诊断噪声，必须进持久化账本（口径由 #109 的 notes 端口同构而来）。
      if (pendingFoldedFacts !== undefined && typeof onFoldSummary === "function") {
        try {
          // issue #479：宿主写「折走第 a–b 轮」需要的三个数，全部取自本轮的**同一份**事实，
          // 不让宿主侧二次推导（`runLoopState` 的水位线与累计已在上面 :3293-3301 更新过）：
          //   · `foldedRoundRange{from,to}` —— 本次折叠的区间（与轮记录同源，同形）；
          //   · `foldedThrough` —— 折叠后的水位线（run 作用域，最大已折轮号）；
          //   · `foldedRoundCount` —— run 内累计折过的轮数。
          // 三个键都是纯加法：既有键逐字不动，老宿主忽略它们时看到的形状与从前一致。
          await onFoldSummary(cloneState({
            ...pendingFoldedFacts,
            round,
            ...(foldedRoundRange === undefined ? {} : { foldedRoundRange }),
            foldedThrough: runLoopState.foldedThrough,
            foldedRoundCount: runLoopState.foldedRoundCount,
          }));
        } catch (foldSummaryError) {
          await reportHostPersistenceFailure({
            port: "notes",
            operation: "onFoldSummary",
            phase: "fold_summary_delivery",
            error: foldSummaryError,
          });
        }
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
        // issue #464 A：写实例上的名字（含库层兜底的 `"sliding-window"`），不是配置项原文。
        strategyName: typeof strategy?.name === "string" ? strategy.name : undefined,
        ...(userTurnGuard === undefined ? {} : { userTurnGuard, userTurnGuardChannel }),
        // issue #469-④：“为什么没拿到摘要”与“成本去哪了”同时入账（只取小字段，不搬正文）。
        foldSummary: {
          ...(strategyFoldSummary ?? {}),
          ...(lastFoldSummaryOutcome?.reused === true ? { reused: true } : {}),
          ...(lastSummarizerMeta ?? {}),
          // 正文与指纹不进这里（#460/#470-B 尺寸尺蠖），`foldedFacts` 已有完整一份。
          text: undefined,
        },
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
      && (runLoopState.ttlInjectArmed || (isLowBudget && !runLoopState.lowBudgetInjectFired));
    // 折叠轮优先把新鲜状态持久挂到摘要块（通道 A）；只有没有持久挂载时，
    // 才追加请求视图尾部（通道 B），避免同一轮同时产生两个 run-state 块。
    if (persistInject || requestInject) {
      runLoopState.runStateVersion += 1;
      if (requestInject && runLoopState.ttlInjectArmed) {
        // TTL 首折和低预算门各只消费一次，避免每轮改写破坏前缀缓存。
        runLoopState.ttlInjectArmed = false;
        runLoopState.ttlInjectConsumed = true;
      }
      if (requestInject && isLowBudget && !runLoopState.lowBudgetInjectFired) {
        runLoopState.lowBudgetInjectFired = true;
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
      // issue #460：轮记录里那份是**有界差分**；`foldedPayload` 局部量（全量原文）继续喂给
      // 指纹 / fidelity / 宿主折叠钩子这些内存侧消费者，语义一字未动。
      foldedPayload: compacted ? foldedArchive?.payload : undefined,
      foldedPayloadMeta: compacted ? foldedArchive?.meta : undefined,
      foldedRoundRange,
      navigationRecord,
      // issue #470（A1）：只在**发生折叠的那一轮**出现，不往每轮重复写 ⇒ 天然不累积（#470 判据 4）。
      foldedFacts: pendingFoldedFacts,
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
    for (const entry of runLoopState.resumeTailMessages) {
      const message = cloneState(entry.message);
      messages.push(message);
      messageRounds.set(message, entry.round);
    }
    runLoopState.resumeTailMessages = [];
  };

  // issue #386 切片 3：补跑桥要在「出圈收尾之后」回到主循环，所以把「主循环 + 出圈收尾」包进
  // 一层可重入的外层循环。**默认关时它只转一圈**（两段 try 的所有出口都是 return/throw）⇒
  // 行为与今天逐字一致；opt-in 时最多转两圈（配额 `guardExtensionUsed` 保证第二圈必被拒绝）。
  // 内层那 ~670 行的缩进刻意不动：那是既有代码，为一行括号重排整段只会让本切片的 diff 不可审。
  // 两个桥函数声明在 `try` **之外**：出圈收尾那段 try 是这个 try 的兄弟（不在它内部），
  // 声明在 try 里会让尾段读不到它们（`ReferenceError`，不是红测试）。
  mainLoop: for (;;) {
    // ── issue #393：注入控制文本之前先把尾部的悬空 `tool_use` 结清 ────────────────────────
    // 中途扩轮永远发生在纯文本 `end_turn` 上（末条 assistant 不可能带 `tool_use`），所以这一步
    // 对它是空操作；但 guard 补跑桥是在**终局收尾之后**被调的，末条 assistant 完全可能带着
    // 未被回答的 `tool_use`（实测形状：`max_rounds_cap` ⇒ 强制收尾那一轮模型仍回了工具调用，
    // 而强制收尾的请求本身就带 `tools: []`，于是那条 `tool_use` 没有任何结果）。
    // 直接 push 控制文本就把它与应有的 `tool_result` 隔开 ⇒ **本库自己的消息校验器**在任何
    // 请求发出之前本地抛 `invalid_messages`（`assistant tool_use has no immediately following user
    // tool_result`）拒掉整份历史，宿主拿到 `termination: failed`（issue #393 实测 index 4 / 8 两处；
    // 2026-10-22 更正归因：**零 HTTP**，拒的是 `validateMessages`，不是 provider）。
    //
    // 判据（`pendingTrailingToolUses`，与 `validateMessages` 的配对规则同源）、结果块（唯一构造点
    // `buildToolResultFact`）、正文（`PENDING_TOOL_RESULT_TEXT`）三件事实都在共享实现
    // `src/loop/pending-tool-result.js` 里；本文件只注入**入账口径**：
    //   · `:control:` 行（**不是** `kind:"message"` 消息行：消息行会被 `foldMessageRows` 折回轮
    //     载体行，从而在恢复时插到「强制收尾」那两条控制消息**之前**，把配对重新打散）；
    //   · 槽位名按注入点分（同一个 run 的同一轮里两个注入点都要结清时，dedupKey 不能互相顶掉）。
    // issue #394：这是**两个注入点共用的唯一实现**（另一个在 `src/loop/termination.js`），本文件里
    // 任何往尾部注入 user 控制消息的地方都必须先走它——第二份配对逻辑就是下一个 #394。
    const answerPendingTailToolUses = async (roundNumber, slot) => settlePendingTailToolUses(
      messages,
      {
        round: roundNumber,
        messageRounds,
        onMessage: (message, round) => appendEngineMessagesToTranscript(message, round, slot),
      },
    );

    // ── issue #386 切片 3：guard 补跑桥的两个唯一实现 ────────────────────────────────────
    // 背景（#386 探针 E4）：`max_rounds_cap` 掐停时模型还在正常调工具、交付物还差一步，guard
    // 明确知道差什么（`revise`），但 `FINAL_GUARD_NON_CONTINUABLE_REASONS` 那三类停机上它没有
    // continuation 可走 ⇒ 只能贴标签。本切片给它开一条**窄桥**：不是再发明一套扩轮，而是复用
    // 中途 judge 扩轮的同一份判据（`extensionAllowed`）与同一段落地动作（下面这个闭包）。
    //
    // 落地动作 = 中途扩轮那一段的**逐字搬移**（`Math.min(当前 + step, cap)` / `extensionCount += 1` /
    // `meta.source:"judge-control"` 的 user 消息）。两处调用同一个闭包，所以不存在第二份实现。
    // 唯一新增参数是 `journalSlot`（落账本的槽位名，决定 dedupKey 后缀），中途扩轮仍传 `"extend"`。
    const applyGovernorExtension = async (text, roundNumber, journalSlot) => {
      // issue #393：注入**之前**先结清尾部悬空 `tool_use`（理由与两种形状见上面那个闭包）。
      // 放在这个共享闭包里而不是只放桥里：这里是「引擎往尾部注入 user 控制消息」的唯一实现，
      // 任何将来的调用点都不该有机会重新引入同一个非法消息序。
      await answerPendingTailToolUses(roundNumber, "guard-extend-tool-result");
      governorState.effectiveMaxRounds = Math.min(
        governorState.effectiveMaxRounds + reflectionExtensionStep,
        reflectionMaxRoundsCap,
      );
      governorState.extensionCount += 1;
      const continuationMessage = {
        role: "user",
        // issue #323：引擎自写的续跑控制文本，打 marker 防 judge 自读回（主模型仍可见）。
        meta: { source: "judge-control" },
        content: [{ type: "text", text }],
      };
      messages.push(continuationMessage);
      messageRounds.set(continuationMessage, roundNumber);
      // issue #326（B1）：同 nudge——轮尾注入的续跑提示必须在产生的那一刻入账。
      await appendEngineMessagesToTranscript(continuationMessage, roundNumber, journalSlot);
    };

    // 桥的预算闸（R2 第 4 条后半）：**复用引擎既有的两份预算事实**，不新起第三套口径。
    // 补一轮的代价是一次完整的主模型请求，所以「预算已经撞线」时拒绝——否则本单就成了
    // 用「补跑」撕掉预算承诺的后门（AGENTS 里那根累计输入 token 的弦）。
    const guardExtensionBudgetAllows = () => {
      // ① 上下文预算：`budgetTokens` 是压缩与单轮聚合输出预算的共同基准（`src/loop/budget.js`）。
      //    最近一次**真实 API 输入 token** 已经越过它 ⇒ 上下文已经装不下，再补一轮只会在超预算的
      //    上下文里再要一次请求。判据本身是既有导出 `isApiInputOverBudget`，这里不另写一份。
      if (isApiInputOverBudget(latestApiInputTokens, budgetTokens)) return false;
      // ② 单轮聚合输出预算（`src/loop/aggregate-budget.js`）：本 run 已经有工具输出被聚合层
      //    归档/stub 化（`runLoopState.aggregateBudgetHit`，写者是 run-snapshot-executor）⇒
      //    输出预算已经撞线，再补一轮只会继续 stub 化。
      if (runLoopState.aggregateBudgetHit === true) return false;
      return true;
    };

    /** guard 补跑桥的**唯一**准入 + 落地收口。
     *  @param {string} reason 停机原因（`terminationReasonForAction` 的取值）
     *  @param {{action?:string, message?:string}} guardDecision `callFinalGuard` 的返回
     *  @returns {Promise<boolean>} true = 已经补跑，调用方应回到主循环；false = 一律走既有降级分支
     *
     *  四个条件必须**同时**成立（缺一个都退回今天的行为，逐字一致）：
     *    1. 停机原因 ∈ `{max_rounds_cap, continuation_exhausted}`；`stall` 永远不补；
     *    2. 宿主 opt-in（`finalGuardExtend === true`）；
     *    3. guard 本轮裁决是 `revise`（`accept` / `skip` / `error` 都不触发——桥只服务
     *       「guard 知道还差什么」那一格）；
     *    4. `extensionAllowed` 等价判据通过（复用同一份 `extensionCount` / `effectiveMaxRounds`）、
     *       配额没用过、且预算闸放行。
     */
    const extendAfterGuard = async (reason, guardDecision) => {
      if (finalGuardExtend !== true) return false;
      if (guardDecision?.action !== "revise") return false;
      // `stall` 永远不补：stall 的定义就是「连续无进展」，给它轮次是纯烧钱。写成**显式**判据
      // （而不是只靠集合里没有它），并由 `test/loop-guard-extend.test.js` 单独钉住。
      if (reason === "stall") return false;
      if (!FINAL_GUARD_EXTENDABLE_REASONS.has(reason)) return false;
      // 一次性配额：每个 run 最多 1 次，即使 governor 还有扩轮额度（成本闸，R3）。
      if (governorState.guardExtensionUsed === true) return false;
      // issue #393 的退路 B（兜底，不是主路）：尾部悬空 `tool_use` 的 id 必须是**非空字符串**
      // （canonical 的配对要求，见 `validateMessages`），连 id 都读不出来的畸形尾巴补不出一条
      // 合法的 `tool_result`。这一格**不补跑**、落回今天的 `unverified / non_continuable`，
      // 而不是让宿主收到 `failed / invalid_messages`（工单明禁的那一格）。判据取共享实现那一份
      // （`pendingTailToolUsesAreAnswerable`），本文件不再自己写一遍 id 校验。
      if (!pendingTailToolUsesAreAnswerable(messages)) return false;
      // 复用 governor 的**同一份**判据与**同一份**计数器，不另写「还剩几次」的第二套算术。
      if (!extensionAllowed({
        extensionCount: governorState.extensionCount,
        maxExtensions: reflectionMaxExtensions,
        effectiveMaxRounds: governorState.effectiveMaxRounds,
        maxRoundsCap: reflectionMaxRoundsCap,
      })) return false;
      if (!guardExtensionBudgetAllows()) return false;
      const fromMaxRounds = governorState.effectiveMaxRounds;
      // 配额先记账再落地：`applyGovernorExtension` 里有 await（落账本），若那一步抛错，
      // 「已经领过配额」这个事实不该被抹掉（否则重跑又会领一份）。
      governorState.guardExtensionUsed = true;
      await applyGovernorExtension(guardDecision.message, runLoopState.rounds, "guard-extend");
      guardMetrics.guard_extensions = (guardMetrics.guard_extensions ?? 0) + 1;
      emitEvent({
        type: "final_guard_extend",
        round: runLoopState.rounds,
        from_max_rounds: fromMaxRounds,
        to_max_rounds: governorState.effectiveMaxRounds,
        guard_extension: true,
      });
      // 配额**消费即入账**：立刻刷一次 run-state，否则「补跑 → 崩 → resume」会让新进程读到
      // `guardExtensionUsed:false` 而再领一份配额（无界成本）。落盘失败只走既有的持久化错误账本，
      // 不改变「已经补跑」这个事实。
      try {
        await refreshRunState();
      } catch (persistenceError) {
        await reportPersistenceError(persistenceError, {
          port: "transcript",
          operation: "saveRunState",
          phase: "guard_extension",
          fatal: false,
        });
      }
      return true;
    };

  try {
    await refreshRunState();
    // resume 后注入旗标按本次 run 重置；后续 TTL 折叠/低预算会重新注入请求视图，
    // 无需把 run-state 写入 run snapshot 或持久 transcript。
    runLoopState.ttlInjectArmed = false;
    runLoopState.ttlInjectConsumed = false;
    runLoopState.lowBudgetInjectFired = false;
    throwIfAborted(signal);
    // 工单 261021（第三刀）：resume 补跑段新产生的**引擎控制正文**（方向提示 / 达成 advisory）在此
    // 暂存，由下面那条 `…:resume` 行带走（它是该轮的折叠载体）。工具结果不走这里。
    const resumeEngineText = [];
    // issue #420：**A 集合先入账**（崩溃前已执行完、结果已成型、账本里没有 `tool_result` 行的那批）。
    // 必须在补跑段（B 集合）之前：
    //   · `seq` 顺序 = 崩溃那一刻的真实发生顺序（A 集合先于 B 集合被产出），折叠后聚合消息里的
    //     block 顺序与内存里的 `messages` 一致；
    //   · `resumeToolResultRowKey` 由本段**落定一次**（`undefined` 时首个 A 结果就是新的聚合消息锚点；
    //     issue #430 起不随分片推进），补跑段读到的正是这个首片锚点 ⇒ 两种集合接回**同一条**聚合消息。
    await journalResumeUnpersistedToolResults();
    if (runLoopState.resumePendingTools.length > 0) {
      const resumedToolResults = [];
      // 工单 261021（第三刀）：**补跑跑出来的工具结果也逐条入账**，用 `partOf` 接回崩溃轮里
      // 已落盘的那条聚合消息（`ctx.resumeToolResultRowKey`，从账本里读）。于是：
      //   · 「崩溃在轮中途 ⇒ 已产出的工具输出必须还在」在新结构下不但成立，而且不再依赖快照正文副本；
      //   · 下一次恢复折出来的 `flatMap(record.messages)` 仍是**一条**含全部结果的 user 消息，
      //     `validateMessages` 的严格配对不会报重复 id（旧写法靠 `…:resume` 行重抄整条聚合消息，
      //     逐条入账后就会把已完成的那个结果存两遍）。
      // issue #430：锚点同样**只在首片落定一次**，不随分片推进（分片行的 key 不是合法的 `partOf`
      // 寻址目标，链到上一片会让第三片起新起一条消息）。A 集合已经首片落地时这里拿到的就是首片 key。
      const journaledResumedResults = new Set();
      let resumedResultRowKey = runLoopState.resumeToolResultRowKey;
      const journalResumedToolResults = async () => {
        for (const toolResult of resumedToolResults) {
          if (journaledResumedResults.has(toolResult)) continue;
          journaledResumedResults.add(toolResult);
          const persistedRowKey = await appendMessageRowToTranscript(
            { role: "user", content: [toolResult] },
            runLoopState.rounds,
            resumedResultRowKey === undefined ? {} : { partOf: resumedResultRowKey },
          );
          if (resumedResultRowKey === undefined && persistedRowKey !== undefined) {
            resumedResultRowKey = persistedRowKey;
          }
        }
      };
      for (const [index, resumePendingTool] of runLoopState.resumePendingTools.entries()) {
        const resumedToolUse = { ...resumePendingTool };
        delete resumedToolUse.replay;
        // 续跑复放的调用：旧快照里带回来的 key 一律沿用（不重生）；只有改动前就落盘的旧快照
        // （根本没有该字段）才现场补一个，让中断的 tool_result 与后续处置仍然能归到同一张卡。
        const resumedToolCallKey = ensureToolCallKeyOnBlock(
          resumedToolUse,
          claimToolCallKey(resumedToolUse, crashSitePendingKey(resumedToolUse)),
        );
        emitEvent({ type: "tool_use", round: runLoopState.rounds, toolUse: cloneState(resumedToolUse) });
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
          // 中断重放的事实同样只由构造器产生（工单 §5）：`is_error` 在顶层（wire 字段），
          // `executionStatus: "interrupted"` 只进 `erix.*`（T2 停写后顶层不再有旧同名键）；
          // **不写 `erix.round` 也不写 `erix.durationMs`**——本次重放没跑过，耗时是未知而不是 0。
          const toolResult = buildToolResultFact({
            toolUseId: resumePendingTool.id,
            content: "The previous execution was interrupted before its outcome could be recorded. "
              + "This unsafe tool was not replayed; the host must decide whether to retry it."
              + (typeof partialOutput === "string" && partialOutput.length > 0
                ? `\n\nPreviously captured partial output:\n${partialOutput}`
                : ""),
            isError: true,
            engine: {
              toolCallKey: resumedToolCallKey,
              executionStatus: "interrupted",
            },
          });
          if (existingToolResult) {
            existingToolResult.content = toolResult.content;
            existingToolResult.is_error = true;
            // 就地改写也只能写引擎命名空间（工单 261014 T2 §2.3）：顶层那个旧名已退役。
            // 升级前的块可能带着一个**过期**的顶层 `executionStatus`（旧 attempt 的状态），
            // 而本块现在说的是「没跑完」这件新事实，所以下面整块换 `erix` 时顺手把它扫掉，
            // 不给读路径留两份互相矛盾的事实（投影已改成 `erix` 优先，不扫也只是冗余）。
            delete existingToolResult.executionStatus;
            // 同一条理由适用于**旧 attempt 的成败与耗时**（PR #288 审阅实证）：本块的 `erix` 已换成
            // 「没跑完」，而 `judge.js:128` / `l0.js:50,68` 的读路径是 `erix.success ?? block.success`。
            // 引擎口径下「中断」不带 `success`（成败未知），所以新 `erix` 里没有这个字段——缺字段就会
            // **回退到升级前那块上过期的一次成败**，judge 于是把一次没跑完的调用算成成功。
            // 删掉它，让「未知」真的是未知（而不是回退出一个 `true`）。
            delete existingToolResult.success;
            // 耗时同理：本 attempt 没有耗时这件事实（`erix.durationMs` 刻意不写），留着旧值只是
            // 一句迟早会被某个新读路径捡走的废话（今天投影只读 `erix.durationMs`，所以它是惰性的）。
            delete existingToolResult.duration;
            // **不扫**顶层 `erixRound`：它是升级前记录的**创建轮**，`readRoundMarker` 在 `erix.round`
            // 缺席时正是回退到它算年龄的；扫掉 = 这条记录永不参与 TTL 折叠（静默退化）。
            // 也**不扫**宿主摊平键：那是宿主自己的数据，不承载引擎事实，清扫不由引擎代行。
            // 那个块现在代表的是「没跑完」这件新事实，不是丢失那次 attempt 的已完成结果：
            // 整块 `erix` 换成本次重放的事实（沿用同一个身份键，丢掉属于旧 attempt 的耗时与轮号）。
            existingToolResult.erix = {
              ...(typeof resumedToolCallKey === "string" && resumedToolCallKey !== ""
                ? { toolCallKey: resumedToolCallKey }
                : {}),
              executionStatus: "interrupted",
            };
          }
          resumedToolResults.push(toolResult);
          emitEvent({
            type: "tool_replay_decision_required",
            runId,
            round: runLoopState.rounds,
            toolUseId: resumePendingTool.id,
            toolName: resumePendingTool.name,
            replay: "unsafe",
            requiresHostDecision: true,
            partialOutputAvailable: partialOutput.length > 0,
          });
          emitEvent({ type: "tool_result", round: runLoopState.rounds, toolResult: cloneState(toolResult) });
          await journalResumedToolResults();
          continue;
        }
        await executeToolWithIntercept(
          resumedToolUse,
          runLoopState.rounds,
          resumedToolResults,
          runLoopState.resumePendingTools.slice(index),
        );
        await journalResumedToolResults();
      }
      appendToolResultsToTranscript(resumedToolResults, runLoopState.rounds);
      // resume 路径也 flush 方向提示（与主循环一致，限 2 条；独立 user text 消息）
      // ⚠ **必须在下面那条 `…:resume` 行落盘之前 flush**：提示正文是靠 `messages.slice(runLoopState
      // .resumeTranscriptStart)` 被那一行带走的；挪到落盘之后就落不进任何记录（档案 0 条）。
      // 反向证与「档案恰有一条」的断言在 `test/loop-persist-engine-text.test.js`（#326 续·方向提示）。
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
        resumeEngineText.push(hintMessage);
        if (runLoopState.rounds !== undefined) messageRounds.set(hintMessage, runLoopState.rounds);
        pendingDirectionHints.length = 0;
      }
      // resume 路径同样投达成 advisory（与主循环同一个单槽策略，issue #322）
      const resumeAdvisoryMessage = flushJudgeDoneAdvisory(runLoopState.rounds);
      if (resumeAdvisoryMessage !== undefined) resumeEngineText.push(resumeAdvisoryMessage);
      runLoopState.resumePendingTools = [];
    }
    if (runLoopState.resumeRunSnapshot && runLoopState.resumeTranscriptStart !== undefined) {
      // 锚点之后新产生的**引擎控制正文**（方向提示 / 达成 advisory）。**工具结果不在这里**——
      // 它们已按「一条消息一成型就落盘」逐条入账（上面那段 `journalResumedToolResults`），
      // 在这里重抄就是同一份正文存两遍（第三次刀要销掉的正是这种双喂）。
      const persisted = await persist("appendRound", runId, {
        round: runLoopState.resumeRunSnapshot.round,
        roundKey: `${String(runId)}:round:${String(runLoopState.resumeRunSnapshot.round)}`,
        // 引擎命名空间：宿主可能已用默认键 `${runId}:round:N` 写入自己的行（追问/历史种子），
        // 同键会被 appendRound 去重 → 续接轮（含补跑工具结果）落盘被静默丢弃，
        // transcript 只剩宿主那条近空行（issue #32 #8）。`:resume` 幂等，重启重跑不重复写。
        dedupKey: `${String(runId)}:engine:round:${String(runLoopState.resumeRunSnapshot.round)}:resume`,
        messages: cloneState(resumeEngineText),
        ...(archivedOutputs.some((entry) => entry.round === runLoopState.resumeRunSnapshot.round)
          ? {
            toolOutputs: archivedOutputs
              .filter((entry) => entry.round === runLoopState.resumeRunSnapshot.round)
              .map(({ toolUseId, name, content }) => ({ toolUseId, name, content })),
          }
          : {}),
        ts: new Date().toISOString(),
      });
      if (persisted) runLoopState.persistedTranscriptLength += resumeEngineText.length;
      runLoopState.resumeTranscriptStart = undefined;
    }
    // ── issue #404（工单 BB「复活赛告示」）：恢复运行告诉模型「这是复活赛」────────────────
    // 位置：上下文重建完（`restoreResume`）、补跑结果接回之后、**宿主这次追问之前**，也就是
    // 第一次请求之前。为什么在 `appendResumeTailMessages()` 之前而不是之后：告示是「接下来这段上下文
    // 是什么」的前言，用户/宿主的真请求应该留在最后一条（模型对最后一条 user 的权重最高，且
    // 「最后一条 user 是宿主写的那句」是既有可观察形状）。
    // 三条硬约束的落点：
    //   · 只有真恢复才有：`resumeNotice` 只由 `restoreResume` 的 `resume: true` 账本分支赋值，
    //     首次运行拿到的是 `undefined` ⇒ 一个字节都不多（回归锚在 `test/loop-resume-notice.test.js`）；
    //   · 入账走**既有**的 `:control:` 行（`appendEngineMessagesToTranscript`），不是
    //     `kind:"message"` 消息行（后者会被 `foldMessageRows` 折回轮载体行、恢复时插到
    //     `tool_use` 之前把配对重新打散——#393 的结论）；
    //   · 注入前先结清尾部（#394 的共享实现）：到这里尾部通常已经由补跑结清，这一步是空操作；
    //     但「账本尾部就是一条悬空 `tool_use`」的格（无快照/升级前账本）靠它把消息序守住。
    if (resumeNotice !== undefined) {
      const notice = resumeNotice;
      resumeNotice = undefined;
      await answerPendingTailToolUses(notice.round, "resume-notice-tool-result");
      const noticeMessage = {
        role: "user",
        // issue #323 的 marker：引擎自写的控制文本，judge 不把它当成用户说的话自读回
        // （主模型仍可见——它就是要给主模型看的）。
        meta: { source: "judge-control" },
        content: [{ type: "text", text: notice.text }],
      };
      messages.push(noticeMessage);
      messageRounds.set(noticeMessage, notice.round);
      await appendEngineMessagesToTranscript(noticeMessage, notice.round, notice.slot);
    }
    appendResumeTailMessages();

    // 预算条件用 budgetRounds（本次 runToolLoop 的消耗），不是身份轮号 rounds：
    // resume 续接时 rounds 已到顶，用它当预算会导致续接轮一次进不了循环。
    while (budgetRounds < governorState.effectiveMaxRounds) {
    // PR #291 必修 1（issue #282 的漏网面 · 路径 A）：圈顶先查一次中止。**进圈条件**只看轮数、不看 signal，而圈底
    // （judge 的 nudge/continue、以及 persist + onRound + governor 收尾那一大段 await）里一个 abort
    // 检查都没有 ⇒ #282 只在 `action.kind === "stop"` 分支入口与最后一次 finish 前补的两处
    // `throwIfAborted`，管不到「judge 判 done:false → nudge → continue」这条路：宿主在 judge 已返回、
    // 终局未定的窗口里点停止，循环会**再多烧一次主模型调用**，最后由出圈的 cap 收尾伪装成轮数耗尽
    // 返回 max_rounds_cap，#180 的 {usage, rounds, partial:true} 载荷全丢。放在圈顶（而非圈底）的
    // 理由：本轮已经跑完的记录照旧落库（#283 β 的口径是「不追溯补写」，不是「该写的也不写」），
    // 只是不再为它发起下一轮请求。它同时覆盖 nudge / extend / decideRoundAction 三条 continue 路径；
    // 无 abort 时 throwIfAborted 是空操作，end_turn / judge_done / stall / no_tool / max_rounds_cap
    // 在无中止时的返回形态一个字节都不动。
    throwIfAborted(signal);
    // 轮预算在进入本轮时自增（与既有 `round` 语义对齐：budgetRounds === 本轮序号），
    // 这样预算提示 / 剩余轮数在工具执行期读到的就是正确值
    budgetRounds += 1;
    const round = runLoopState.rounds + 1;
    runLoopState.toolExecutedThisRound = false;
    runLoopState.interceptJudgeDecision = undefined;
    roundEventDeltas = [];
    roundStopReason = undefined;
    let stallSuspicion = false;
    let stallSignature = null;
    let lastSignatureThisRound = null;
    emitEvent({ type: "round_start", round });
    // issue #438：本轮两个桶从零开始（放在 `compactBeforeRound` 之前——折叠摘要器的用量属于本轮）。
    roundUsage = { input_tokens: 0, output_tokens: 0 };
    roundEngineUsage = { input_tokens: 0, output_tokens: 0 };
    roundEngineCallCount = 0;
    const compactionStatsStart = compactionStats.length;
    const compaction = await compactBeforeRound(round);
    let requestStateBlock = compaction.requestStateBlock;
    const roundStart = messages.length;
    // 工单 261021 写侧：轮末才入账的引擎控制文本（方向提示 / 达成 advisory）在此暂存，
    // 在本轮轮记录落盘**之后**写成 `…:control:` 行（不带 `seq`，折叠层原样透传）：
    // 它们的 `messages.push` 位置不动（模型下一轮照旧看得见），只是档案行改排在轮行后面，
    // 于是 `flatMap(record.messages)` 的序列与改造前（正文靠轮记录 `messages.slice(roundStart)`
    // 带走）逐字一致。写在前会让折叠后的顺序变成 [提示, assistant, tool_result]。
    const engineTextAfterRound = [];
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
    // 工单 261021 写侧：正文的入账点在下面「本轮正文定型之后」（L1 标记剥离 / 续写合并都已完成，
    // 但仍在工具执行**之前**）——append-only 行没有更新，写早了就把处理前的正文当成档案正文。
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
    // issue #386：自报对象与 `declaredFindings` 同源同刻（`null` 就是不写该键）。
    selfReport = wrapupJson ?? undefined;
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
    // 工单 261021 写侧·写入点 1：**本轮 assistant 正文一成型就入账**（此刻 L1 标记已剥离、续写已
    // 合并，而工具还没执行 ⇒ 「工具执行期崩溃 ⇒ 本轮 assistant 正文全丢」那个窗口关掉了）。
    // 先把本轮 tool_use 的 `toolCallKey` 按工具循环里同一口径认领好（`claimToolCallKey` 自带
    // `peek`、重复认领幂等），否则账本里的 tool_use 块会少了改造前就有的 `erix.toolCallKey`。
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      const claimedKey = acceptedToolCallKey(block, snapshotResults.get(block.id));
      if (claimedKey !== null) ensureToolCallKeyOnBlock(block, claimedKey);
    }
    await appendMessageRowToTranscript(
      assistant?.role === "assistant" ? assistant : { role: "assistant", content },
      round,
    );
    finalText = textFromBlocks(content);
    if (wrapupJson !== null) {
      finalText = wrapupJson.output || wrapupJson.summary;
    }

    if (hasToolUse(content)) {
      runLoopState.hadToolUse = true;
      governorState.noToolStreak = 0;
    }

    if (response?.stopReason === "tool_use") {
      const toolResults = [];
      // 工单 261021 写侧：本轮 `tool_result` 聚合消息的首片行 key（后续结果靠 `partOf` 接回同一条）。
      let toolResultRowKey = undefined;
      const journaledToolResults = new Set();
      const pendingToolUses = content.filter((candidate) => candidate?.type === "tool_use");
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        // 复放判定**先于**身份键认领（工单 261014 T1-fix 第 1、2 项）：本轮要走复放的话，
        // 这次调用的身份就是那条已记录结果里的身份，而不是现分配的一个新值。
        const recordedToolResult = snapshotResults.get(block.id);
        const acceptedKey = acceptedToolCallKey(block, recordedToolResult);
        // 调用被接受时认领身份键（就地挂到块上：assistant.content 与 RoundRecord.response.content
        // 是同一引用，所以持久化块、事事件克隆、投影拿到的都是同一个值）。`acceptedKey === null`
        // 是「复放升级前的旧记录」：两端一致地缺失，所以下面既不认领也不删块上已有的值。
        if (acceptedKey !== null) ensureToolCallKeyOnBlock(block, acceptedKey);
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

        const toolResult = executedToolIds.has(block.id) && recordedToolResult !== undefined
          ? cloneState(recordedToolResult)
          : await executeToolWithIntercept(
            block,
            round,
            toolResults,
            pendingToolUses.slice(pendingToolUses.findIndex((candidate) => candidate === block)),
          );
        if (!toolResults.includes(toolResult)) toolResults.push(toolResult);
        if (!journaledToolResults.has(toolResult)) {
          journaledToolResults.add(toolResult);
          // 工单 261021 写侧：**工具结果一产生就写**——这是全循环里唯一有外部副作用的边界，
          // 改造前它与同轮其余结果挤在同一条 user 消息里、等轮末才落盘。
          // 去重口径不能拄 `toolResults.includes(...)`：执行器自己也会把结果 push 进 `toolResults`，
          // 那个判据在正常路径下恒为真 ⇒ 一个结果都不会入账 ⇒ 按身份集合自己记。
          const persistedRowKey = await appendMessageRowToTranscript(
            { role: "user", content: [toolResult] },
            round,
            toolResultRowKey === undefined ? {} : { partOf: toolResultRowKey },
          );
          // issue #430：锚点 = 本轮聚合消息的**首片** key，写成功后**不再推进**（分片 key 不能当
          // `partOf` 目标）。链到上一片时第三个结果起就折不回聚合消息（崩溃在轮行落盘之前时可见）。
          if (toolResultRowKey === undefined && persistedRowKey !== undefined) {
            toolResultRowKey = persistedRowKey;
          }
        }
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
        // ⚠ **必须在本轮的 `persist("appendRound", runId, record)` 之前 flush**：正文是靠轮记录的
        //   `messages: messages.slice(roundStart)`（`roundStart` = 圈顶的 `messages.length`）入账的；
        //   挪到落盘之后它就落不进任何记录（档案 0 条），而另开一条 `…:control:` 行则会把同一份正文
        //   存两遍并在 resume 重建时双喂。两侧都由 `test/loop-persist-engine-text.test.js`
        //   （#326 续·方向提示）钉住；本行上方与圈底的 `persist` 在同一次迭代里，不要拆散。
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
        engineTextAfterRound.push({ message: hintMessage, slot: "direction-hint" });
      }
      // 达成 advisory 与方向提示同批发出，但走自己的单槽（issue #322）
      const advisoryMessageThisRound = flushJudgeDoneAdvisory(round);
      if (advisoryMessageThisRound !== undefined) {
        engineTextAfterRound.push({ message: advisoryMessageThisRound, slot: "judge-advisory" });
      }
    }
    // streak 只累积 stalled 命中；出现不同签名（模型转向）才清零
    if (stallSuspicion) {
      runLoopState.stallStreak += 1;
      runLoopState.lastStallSignature = stallSignature;
    } else if (runLoopState.lastStallSignature !== null && lastSignatureThisRound !== null
      && lastSignatureThisRound !== runLoopState.lastStallSignature) {
      // 本轮调用了与上次 stalled 不同的签名 → 模型转向，清零
      runLoopState.stallStreak = 0;
      runLoopState.lastStallSignature = null;
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
      && runLoopState.wrapupNormalizationEnabled
    ) {
      try {
        // issue #406 B2-b：改调**同一个入口**（`normalizeWrapupText` → `normalizeModelJson`）。
        // 旧的内联请求（自带一份提示词、自己拼 taskBrief/轮数、自己解析、自己滤 findings）已删：
        // 两份提示词必然漂移，且那份没有闸门（summary/output 从不核验）、失败只有一句 `catch {}`。
        // `provider` 只做两件引擎侧的事：把 provider 的 Promise 挂上本 run 的 abort，并把这次
        // 引擎自发起的调用记进 engine 用量桶（issue #438）。请求体本身一个字都不改。
        const normalized = await normalizeWrapupText(responseText, {
          provider: {
            async chat(request) {
              const judgeResponse = await awaitWithAbort(wrapupEvaluator.chat(request));
              // issue #438：收尾归一化同样是引擎自发起的调用 ⇒ 只进 engine 桶。
              addUsage(judgeResponse, undefined, { trackLatest: false, account: "engine" });
              return judgeResponse;
            },
          },
          ...(signal === undefined ? {} : { signal }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(temperature === undefined ? {} : { temperature }),
        });
        if (normalized.ok === true) {
          // 归一化只许“搬运”：`normalizeWrapupText` 的闸门已经按 agent 原文把非逐字的
          // finding 丢掉了（旧的内联 `filterFindingsBySource` 已删——同一件事只有一处实现）。
          const candidate = normalized.value;
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
          runLoopState.wrapupNormalizationEnabled = false;
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
    // issue #386：归一化产出的那一份才是「模型自报」的可读版本（LLM 归一化只许搬运，不改写），
    // 所以自报对象换成它；`findings` 仍以 `declaredFindings` 为准（上面那条 `if` 的语义没动）。
    if (normalizedWrapup !== null) selfReport = normalizedWrapup;
    // 失忆兑底：超过 5 轮后模型若输出欢迎语（误以为新会话），注入任务提醒并继续
    // （上下文折叠可能让模型丢失任务感；此处把主线拉回，避免空转）
    const memoryLossDetected = budgetRounds > 5
      && wrapupJson === null
      && !hasToolUse(content)
      && isLikelyWelcomeResponse(finalText);
    const noToolRound = !hasToolUse(content)
      && completionEnabled
      && !completionSignalDetected
      && runLoopState.hadToolUse;
    if (hasToolUse(content)) {
      governorState.noToolStreak = 0;
    } else if (noToolRound) {
      governorState.noToolStreak += 1;
    }

    // 身份轮号自增（非 resume 单段调用 budgetRounds 与 rounds 恒等；resume 后 rounds 领先）
    runLoopState.rounds = round;
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
    // issue #388：写工具命中那一刻的**原始**路径台账。与上面那个循环并列而不合并：
    // `filesWritten` 的既有语义（`call.arg` 为真才记）一字不动，`fileWrites` 只多记一份原值。
    recordFileWrites(currentRoundMessages, round);
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
      stallStreak: runLoopState.stallStreak,
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
    let judgeDecision = runLoopState.interceptJudgeDecision;
    let judgeUsage;
    // end_turn 轮完整评估；工具中途审计的 nearLimit 扩轮决策已由拦截器回传。
    // issue #282（期望 2）：**中止已置位就跳过整次 judge 调用**——judge 是「终局前的增值调用」，用户已按下
    // 停止后再烧一次模型费用毫无收益（停止体感延迟从「一次 LLM 往返」降到「立即」）。跳过之后
    // 终局仍由下方 stop 分支的 aborted 收口（裁决表：docs/termination-decision-table.md）。
    if (runLoopState.roundJudgeEnabled && isEndTurn && !signal?.aborted) {
      try {
        const judged = await callRoundJudge(round, currentL0);
        judgeDecision = judged.decision;
        judgeUsage = judged.usage;
        const judgeRaw = judged.raw;
        if (judgeDecision === null) {
          runLoopState.roundJudgeFailures += 1;
          if (runLoopState.roundJudgeFailures >= roundJudgeFailureLimit) runLoopState.roundJudgeEnabled = false;
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
          runLoopState.roundJudgeFailures = 0;
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
            action: judgeDecision.done === true
              && judgeDecision.confidence >= JUDGE_DONE_CONFIDENCE_THRESHOLD
              ? "judge_done"
              : (extensionAction ?? (judgeDecision.done === false ? "nudge" : "continue")),
            ...(judgeUsage ? { usage: judgeUsage } : {}),
            ...(typeof judgeRaw === "string" && judgeRaw !== "" ? { raw: judgeRaw } : {}),
          });
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        runLoopState.roundJudgeFailures += 1;
        if (runLoopState.roundJudgeFailures >= roundJudgeFailureLimit) runLoopState.roundJudgeEnabled = false;
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
      && judgeDecision.confidence >= JUDGE_DONE_CONFIDENCE_THRESHOLD
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
      && typeof onReflectionHook === "function") {
      await onReflectionHook({
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
      // 工单 261021 写侧：轮记录不再写正文（`messages: messages.slice(roundStart)`）——正文已在
      // 成型的那一刻逐条入账（`appendMessageRowToTranscript`），这里只留元数据；读侧折叠层
      // （`src/store/message-rows.js`）把那些消息行折回本行，所以 `store.load()` 的形状不变。
      ts: new Date().toISOString(),
      response: {
        content,
        stopReason: response?.stopReason,
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
      },
      // issue #438（新键，纯加法）：本轮**全部**响应的累计用量——逐轮账（预算/计费/「每轮输出多少」）
      // 读这个。上面 `response.usage` 仍是「最后一次响应的 usage」（历史形状，逐字不动：续写轮里
      // 它只有最后一发）。零值恒在（`{input_tokens:0, output_tokens:0}`），不是缺字段。
      usage: { ...roundUsage },
      // 本轮**引擎自发起的调用**（round judge / 收尾归一化 / 折叠摘要）的用量。缺键 = 本轮没有
      // 这类调用；有键才写（同 `judge`/`compactionStats` 的缺省口径）。强制收尾发生在最后一条轮记录
      // 之后 ⇒ 它只出现在 run 级 `result.engineUsage` 里。
      ...(roundEngineCallCount === 0 ? {} : { engineUsage: { ...roundEngineUsage } }),
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
    // issue #460：`record` 的字面量推断里没有折叠字段（`folded`/`foldedPayload`/`foldedRoundRange`/
    // `navigationRecord` 本来就在 --checkJs 的名册里），用一个带显式类型的别名承载这些咨询性
    // 字段，顺带把这批已有类型错一并减掉（#214 棘轮只许降不许升）。
    /** @type {Record<string, any>} */
    const roundRecord = record;
    if (compaction.folded) {
      roundRecord.folded = true;
      if (compaction.foldedPayload !== undefined) {
        roundRecord.foldedPayload = compaction.foldedPayload;
      }
      // issue #460：丢了多少要留痕，否则「归档被夹断」与「本来就没折过」在账本上同形。
      if (compaction.foldedPayloadMeta !== undefined) {
        roundRecord.foldedPayloadMeta = compaction.foldedPayloadMeta;
      }
      if (compaction.foldedRoundRange !== undefined) {
        roundRecord.foldedRoundRange = compaction.foldedRoundRange;
      }
      if (compaction.navigationRecord !== undefined) {
        roundRecord.navigationRecord = compaction.navigationRecord;
      }
      // issue #470（A1，纯加法）：被折掉的早期历史的**机械替代物**落进轮记录。
      // `record.summary`（本轮自身摘要）一字不动 ⇒ 既有的横幅语义、`#326` 守卫、归档都不受影响。
      if (compaction.foldedFacts !== undefined) {
        roundRecord[FOLDED_FACTS_RECORD_FIELD] = cloneState(compaction.foldedFacts);
      }
    }
    // issue #460：宿主有权对**单条记录**定界（本站 1 MB）。归档是咨询性字段 —— 正文早已按轮
    // 入账、resume 从不回读这一份 —— 所以「归档写不下」最多是取证面降级，不得升格成
    // `persistence_failed` 整 run 终局（连带 `sideEffect=executed_uncommitted` 的副作用重复）。
    // 判据：剥掉归档重试一次仍失败 ⇒ 才是真的存储故障，照旧终局。
    let persisted;
    try {
      persisted = await persist("appendRound", runId, record);
    } catch (archiveError) {
      const droppedArchive = roundRecord.foldedPayload;
      // 空归档不可能是尺寸元凶：剥它等于原样重试，直接交回原错（保住原始失败的判别面）。
      if (!Array.isArray(droppedArchive) || droppedArchive.length === 0) throw archiveError;
      /** @type {Record<string, any>} */
      const leanRecord = { ...record };
      leanRecord.foldedPayloadMeta = {
        ...(roundRecord.foldedPayloadMeta ?? {}),
        rejectedByHost: true,
        droppedMessages: droppedArchive.length,
        droppedBytes: payloadByteLength(droppedArchive),
      };
      delete leanRecord.foldedPayload;
      // 非致命：记一笔降级事实（`fatal: false`），run 继续。
      await reportPersistenceError(archiveError, persistenceErrorEvent({
        operation: "appendRound",
        phase: "transcript",
        runId,
        sideEffect: runLoopState.toolExecutedThisRound
          ? "executed_uncommitted"
          : "not_started",
        error: archiveError,
        fatal: false,
      }));
      persisted = await persist("appendRound", runId, leanRecord);
    }
    // 工单 261021 写侧：正文的计数已跟着消息行走（`appendMessageRowToTranscript`），轮行只剩元数据。
    for (const entry of engineTextAfterRound) {
      await appendEngineMessagesToTranscript(entry.message, round, entry.slot);
    }
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
    runLoopState.toolExecutedThisRound = false;
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
      // issue #326（B1）：本轮记录已在上面落盘，这条评审意见不会被任何后续轮记录覆盖，当场入账。
      await appendEngineMessagesToTranscript(continuationMessage, round, "judge-nudge");
      if (action.resetNoToolStreak) governorState.noToolStreak = 0;
      if (action.wrapUpNudged === true) governorState.wrapUpNudged = true;
      continue;
    }
    if (action.kind === "extend" || action.kind === "extend+redirect") {
      // issue #386 切片 3：这一段原先是**就地**写的，现在与 guard 补跑桥共用
      // `applyGovernorExtension` 那一个闭包（`Math.min(当前 + step, cap)` / `extensionCount += 1` /
      // `meta.source:"judge-control"` 的 user 消息 / 当场入账，逐字不变，槽位名仍是 `"extend"`）。
      // 唯一目的：让「第二份扩轮实现」没有存在的理由。
      await applyGovernorExtension(action.text, round, "extend");
      continue;
    }
    if (action.kind === "stop") {
      // issue #282（期望 1）：终局裁决处**统一收口**「aborted 永远优先于 judge / finalGuard」——原先 reason
      // 只由 action 推导、全程不看 signal ⇒ 用户在「judge 已返回、终局未定」的窗口里点停止，终态会被
      // 改写成 judge_done，中止语义（partial / usage / rounds）全丢。在这里抛 AbortError 交给外层 catch
      // → fail()：由它产出带 {usage, rounds, partial:true} 的 aborted 终局（#180 载荷语义不变）。
      throwIfAborted(signal);
      const reason = terminationReasonForAction(action, continuationExhausted);
      await forceFinalAndJournal(reason);
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
          // issue #386 切片 3：预算类停机（`max_rounds_cap` / `continuation_exhausted`）+ guard 判
          // `revise` + 宿主 opt-in ⇒ 借中途扩轮那套机制补跑一次，然后回到主循环。
          // 任一条件不成立 ⇒ 下面这段与今天**逐字一致**（`unverified / non_continuable` +
          // `final_guard_unverified`）。`stall` 在 `extendAfterGuard` 里被显式拒绝。
          if (await extendAfterGuard(reason, guardDecision)) continue;
          guardMetrics.unverified += 1;
          verification = {
            status: "unverified",
            reason: "non_continuable",
            detail: reason,
          };
          emitEvent({
            type: "final_guard",
            round: runLoopState.rounds,
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
              round: runLoopState.rounds,
              action: "degraded",
              reason: "max_retries",
            });
            return finish("final_guard_unverified");
          }
          finalGuardRetries += 1;
          // ── issue #394（兄弟洞）：这条续跑消息也是一个「往尾部注入 user 控制文本」的注入点 ────
          // 形状：`stopReason:"end_turn"` 但 content 带 `tool_use`（非标准边界，`isEndTurn` 那条
          // 注释点名的那个）⇒ 不进工具执行 ⇒ 尾部留一条悬空 `tool_use`，而 reason 落到 `end_turn`
          // ⇒ `forceFinalIfNeeded` 直接早退（不结清，也不报错），run 正常返回。于是**下一次**请求
          // （下面那条 `continue` 回到主循环）在 `src/loop/provider-runner.js#callProvider`
          // （`allowPendingToolUse:false`）以同一句 `invalid_messages` 崩。修法同源：注入之前先
          // 结清（共享实现），入账走 `:control:` 行。这是**行为变化**（多一条 `tool_result` +
          // 一条 `:control:` 行），契约与 CHANGELOG 已写。
          await answerPendingTailToolUses(round, "guard-revise-tool-result");
          const continuationMessage = {
            role: "user",
            // issue #323：finalGuard revise 的 message 是引擎注入的控制文本，打 marker 防 judge
            // 自读回（主模型仍可见）。
            meta: { source: "judge-control" },
            content: [{ type: "text", text: guardDecision.message }],
          };
          messages.push(continuationMessage);
          messageRounds.set(continuationMessage, round);
          // issue #326（B1）：finalGuard revise 的意见同样是轮记录落盘后才注入的引擎文本。
          await appendEngineMessagesToTranscript(continuationMessage, round, "guard-revise");
          continue;
        }
      }
      // finalGuard 同样是「终局前的增值调用」：中止若落在它自己那一次调用里，也必须以 aborted 收口，
      // 不得把用户的中止改写成 final_guard 给出的终态（issue #282 期望 3）。
      throwIfAborted(signal);
      return finish(reason);
    }
    if (action.kind === "continue") continue;
    }
  } catch (error) {
    await fail(error);
  }

  // PR #291 必修 1（issue #282 的漏网面 · 路径 B）：出圈收尾原先整段落在 `} catch (error) { await fail(error); }` **之外**，
  // 两个后果：
  //   1. 收尾里的 await（`forceFinalIfNeeded` 内那一次 `awaitWithAbort(provider.chat(...))`、以及
  //      `callFinalGuard`）在被中止时抛出的 AbortError **没人接**，会裸抛出 runRunLoop——全仓只有
  //      `fail()`（:1100）会 `annotateTermination`，所以宿主拿到的是一个没有 `termination` 载荷的
  //      原始错误（#180 的 {usage, rounds, partial:true} 全缺）。abort **不需要**在这里另加检查：
  //      `awaitWithAbort` 进门先 `throwIfAborted`、`callFinalGuard` 的 `catch` 里也有
  //      `throwIfAborted(ctx.signal)`（src/loop/termination.js），中止在 await 边界上一定会抛；
  //      本层只负责接住它并交给 `fail()`。（在两次 await 之后各加一次检查已经做过变异证：删了
  //      **无一条测试变红** ⇒ 那是死守卫，没加。）
  //   2. 收尾**不经过任何 await** 就能返回的那一格（`ERIX_NO_FORCED_FINAL=1` / `hasFinalDraft()` ⇒
  //      `forceFinalIfNeeded` 直接空转，且没挂 `finalGuard`）里，刚出的圈完全没查过 signal ⇒
  //      照样返回 max_rounds_cap。下面那一次 `throwIfAborted` 钉的就是这一格（变异证：删掉它 ⇒
  //      「收尾里没有任何 await 可守」那条测试红）。
  // 行为变化只一处：宿主收尾回调（forceFinalizer / finalGuard）自己抛错原先会冒出整次调用，
  // 现在降级成 `reason:"failed"` 的终局（带 errorCode，根因探不到则为 unknown），与仓内
  // 「宿主回调错误不杀 run」的统一口径一致（docs/host-consumer-contract*.md）。
  try {
    throwIfAborted(signal);
    await forceFinalAndJournal("max_rounds_cap");
    if (typeof finalGuard !== "function") return finish("max_rounds_cap");
    const guardDecision = await callFinalGuard("max_rounds_cap");
    if (guardDecision.action === "error") return finish("max_rounds_cap");
    if (guardDecision.action === "skip") return finish("max_rounds_cap");
    // issue #386 切片 3：**E4 那一格**——轮预算被掐停、模型还在正常调工具、guard 明确知道差什么
    // （`revise`）时，opt-in 的宿主可以让它补跑一轮再收尾。条件不成立 ⇒ 下面与今天逐字一致。
    if (await extendAfterGuard("max_rounds_cap", guardDecision)) continue mainLoop;
    guardMetrics.unverified += 1;
    verification = {
      ...verification,
      status: "unverified",
      reason: "non_continuable",
      detail: "max_rounds_cap",
    };
    emitEvent({
      type: "final_guard",
      round: runLoopState.rounds,
      action: "degraded",
      reason: "non_continuable",
    });
    return finish("final_guard_unverified");
  } catch (error) {
    return await fail(error);
  }
    }
}

// ── issue #571（片1）：`createAgent` —— 给「初始化一次的配置」一个位置 ─────────────────────────
//
// 病根（issue #524，已 by-design 关闭）：0.28 之后 `runToolLoop` 是唯一入口、**没有 agent 对象**，
// 于是「初始化一次的配置」与「这一次的数据」挤在同一个参数对象里；而 `config` 容器的合并规则是
// **整棵覆盖**，所以「发一条消息」这个动作（`config.input.messages`）会把装配口的 `policy.config`
// 整棵顶掉——折叠 TTL / 上下文预算 / 持久化开关一起消失。
//
// #571 的解**不是**改覆盖语义（不做深合并、不加诊断字段），而是给「初始化」一个位置：本函数拿住
// 「初始化那一份」，`run(input)` 只接受 `call` 绑定的叶子（外加每次的 `signal`），逐叶并进**同一棵**
// `config` 再交给 `runToolLoop`。于是「配置只有一个来源」在这个形状下是结构性的，而不是靠约定。
//
// 三件刻意不做的事（片1 的边界）：
//   · **不动 `runToolLoop`**：覆盖语义、两条输入通道、既有拒绝文案一个字都没变（收敛是片2）；
//   · **不退役任何写法**：`runToolLoop` 照旧可以直接调；本函数是纯增量包装，不是第二套引擎；
//   · **不做深合并**：初始化那棵树按组浅拷贝、逐叶取值，叶子里的对象原样带过去（引擎的取值口径不变）。
//
// 绑定事实的唯一来源是 `CONFIG_LEAF_BINDING`（`src/loop/config-namespace.js`），本文件不抄第二份。

/**
 * `createAgent({ … })` —— 把「初始化一次的配置」与「每一次调用的数据」分成两个位置（issue #571 片1）。
 *
 * 接受今天 `runToolLoop` 的**全部行为面**与 `config` / `capabilities`（同一个白名单、同一道闸口），
 * 并在**初始化时**把校验做完：
 *   · 未知键 ⇒ `assertRunToolLoopOptionNames`（与 `runToolLoop` 同一个函数、同一句判词）；
 *   · `config` 的名称/形状/函数值/逐叶值规则 ⇒ `assertConfigNamespace`（同上）；
 *   · `capabilities` 的名称/形状 ⇒ `assertCapabilitiesNamespace`（同上）；
 *   · **绑定冲突** ⇒ 只出现在 `agent.run({ … })` 的叶子（`CONFIG_LEAF_BINDING` 里的 `call`）写在
 *     `config` 里就是初始化错误，判词点名它在 `agent.run` 里的写法（#571 要求两个方向都硬拒）。
 *
 * 返回的对象只有一个方法 `run(input)`：
 *   · 只接受 `call` 绑定的**叶子名**（`messages` / `initialUserMessage` / `runId` / `resume` / `stream`
 *     / `metadata.*`）外加每次调用的 `signal`；别的键一律硬拒并指名去处（`init` 叶 ⇒
 *     `createAgent({ config })`，顶层行为面 ⇒ `createAgent({ … })`）；
 *   · 内部把「初始化那份」与这次的叶子**逐叶**并进同一棵 `config`，所以本形状下不存在「整棵覆盖」
 *     这件事（`run(input)` 连第二个 `config` 都递不进去）；
 *   · 返回 `runToolLoop` 的 promise，一次调用一个 run，agent 对象本身无状态。
 *
 * @param {Record<string, any>} init `runToolLoop` 的选项面（`config` / `capabilities` + 顶层行为面）
 * @returns {{run: (input?: Record<string, any>) => Promise<Record<string, any>>}}
 */
export function createAgent(init) {
  if (init === null || typeof init !== "object" || Array.isArray(init)) {
    throw new TypeError("createAgent options must be an object");
  }
  assertRunToolLoopOptionNames(init);
  const { config: initConfig, capabilities, ...initOptions } = init;
  const bindingProblems = collectInitBindingProblems(initConfig);
  if (bindingProblems.length > 0) throw new TypeError(bindingProblems.join("; "));
  assertConfigNamespace(initConfig);
  assertCapabilitiesNamespace(capabilities);
  return {
    /**
     * 跑一次。绑定冲突与未知键**同步**抛（编程错误，不必等一次 I/O）；正常路径返回
     * `runToolLoop` 的 promise。
     *
     * @param {Record<string, any>} [input] 这一次的数据（`call` 绑定的叶子 + `signal`）
     * @returns {Promise<Record<string, any>>}
     */
    run(input) {
      const call = collectCallInput(initConfig, input);
      // 这里必须显式声明为 any：`runToolLoop` 的 JSDoc 入参类型要求 `provider` / `executeTool` 这两个
      // **必填**键，而初始化面是 `Record<string, any>`（宿主给什么就是什么，形状由引擎自己的闸口校）。
      // 不加这一层，`--checkJs` 会多一条 TS2345（本片不允许抬 type 棘轮基线）。
      return runToolLoop(/** @type {any} */ ({
        ...initOptions,
        ...call.options,
        config: call.config,
        capabilities,
      }));
    },
  };
}

/**
 * `createAgent({ config })` 里的 **`call` 叶**：硬拒并指名新家（issue #571，方向一）。
 *
 * 形状错误（`config` 不是对象、组不是对象）**不在这里报**——那是 `assertConfigNamespace` 的活，
 * 在这里重复一遍只会让同一个形状拿到两句话（两套判词的经典来源）。
 *
 * @param {unknown} config
 * @returns {string[]} 问题列表（空 = 通过）
 */
function collectInitBindingProblems(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  const problems = [];
  for (const group of CONFIG_NAMESPACE_GROUPS) {
    const bag = /** @type {Record<string, any>} */ (config)[group];
    if (bag === null || typeof bag !== "object" || Array.isArray(bag)) continue;
    for (const [leaf, value] of Object.entries(/** @type {Record<string, any>} */ (bag))) {
      if (value === undefined) continue;
      if (configBindingForLeaf(group, leaf) !== "call") continue;
      problems.push(
        `createAgent({ config: { ${group}: { ${leaf}: … } } }): config.${group}.${leaf} is per-call data —`
        + ` write it in agent.run({ ${leaf}: … }) instead (issue #571: the config tree is fixed at`
        + " initialization and is the agent's single config source)",
      );
    }
  }
  return problems;
}

/**
 * `agent.run(input)` 的键 ⇒ `{ config, options }`（issue #571，方向二）。
 *
 * 三档判词分开说，因为修法不同：`init` 叶 ⇒ 去 `createAgent({ config })`；顶层行为面（`provider` /
 * `capabilities` / `onEvent` …）⇒ 去 `createAgent({ … })`；真未知的名字 ⇒ 枚举接受名单（`call` 叶 +
 * `signal`，名单从绑定表派生，不手抄）。
 *
 * @param {unknown} initConfig 初始化那份 `config`（原样，不被本函数改动）
 * @param {Record<string, any>} [input]
 * @returns {{config: Record<string, any>, options: Record<string, any>}}
 */
function collectCallInput(initConfig, input) {
  const source = input === undefined ? {} : input;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("agent.run input must be an object (or omitted)");
  }
  const problems = [];
  /** @type {Map<string, Record<string, any>>} */
  const callLeaves = new Map();
  /** @type {Record<string, any>} */
  const options = {};
  for (const [key, value] of Object.entries(source)) {
    // `signal` 是每次调用的东西（中止信号天然属于一次调用），不是配置叶子 ⇒ 原样进顶层。
    if (key === "signal") {
      options.signal = value;
      continue;
    }
    const path = configLeafPathForName(key);
    if (path === undefined) {
      problems.push(RUN_TOOL_LOOP_OPTION_SET.has(key)
        ? `agent.run({ ${key}: … }): ${key} is an initialization option — pass it to createAgent({ … })`
          + " instead (issue #571)"
        : `unknown agent.run option: ${JSON.stringify(key)} (accepted:`
          + ` ${configLeafNamesForBinding("call").join(", ")}, signal)`);
      continue;
    }
    const [group, leaf] = /** @type {[string, string]} */ (path.split("."));
    if (configBindingForLeafName(key) !== "call") {
      problems.push(
        `agent.run({ ${key}: … }): ${key} is an initialization knob (config.${path}) —`
        + ` write it in createAgent({ config: { ${group}: { ${leaf}: … } } }) instead (issue #571)`,
      );
      continue;
    }
    if (value === undefined) continue;
    const bag = callLeaves.get(group) ?? {};
    bag[leaf] = value;
    callLeaves.set(group, bag);
  }
  if (problems.length > 0) throw new TypeError(problems.join("; "));
  return { config: mergeConfigLeaves(initConfig, callLeaves), options };
}

/**
 * 「初始化那份」+「这次的叶子」⇒ 交给 `runToolLoop` 的**唯一一棵** `config`（issue #571）。
 *
 * 只做**组级浅拷贝 + 逐叶覆盖**：叶子里的对象按引用带过去（`config.folding.context` 这类壳的取值
 * 口径因此一字不变）。没有深合并——那不是本单要的东西，而且深合并会让「这次没给」与「这次给了
 * `undefined`」变成两件事。
 *
 * @param {unknown} initConfig
 * @param {Map<string, Record<string, any>>} callLeaves
 * @returns {Record<string, any>}
 */
function mergeConfigLeaves(initConfig, callLeaves) {
  /** @type {Record<string, any>} */
  const merged = {};
  if (initConfig !== null && typeof initConfig === "object" && !Array.isArray(initConfig)) {
    for (const [group, bag] of Object.entries(/** @type {Record<string, any>} */ (initConfig))) {
      merged[group] = bag !== null && typeof bag === "object" && !Array.isArray(bag) ? { ...bag } : bag;
    }
  }
  for (const [group, bag] of callLeaves) {
    const previous = merged[group];
    merged[group] = previous !== null && typeof previous === "object" && !Array.isArray(previous)
      ? { ...previous, ...bag }
      : { ...bag };
  }
  return merged;
}
