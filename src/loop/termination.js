import { markStablePrefix } from "./provider-runner.js";
import { tryParseWrapupJson } from "../reflection/wrapup.js";
import { validateMessages } from "../messages/rounds.js";
import { cloneState } from "./budget.js";
import { blocksFor, hasToolUse, textFromBlocks } from "./messages.js";

export const TRUNCATED_TERMINATION_REASONS = new Set([
  "max_rounds_cap",
  "continuation_exhausted",
  "stall",
  "final_guard_unverified",
]);

export const FINAL_GUARD_TERMINATION_REASONS = new Set([
  "end_turn",
  "no_tool",
  "judge_done",
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
]);

export const FINAL_GUARD_NON_CONTINUABLE_REASONS = new Set([
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
]);

export function makeTermination(reason, detail) {
  return {
    reason,
    ...(detail === undefined ? {} : { detail: String(detail) }),
  };
}

export function terminationDetailForError(error) {
  return error?.message === undefined ? String(error) : String(error.message);
}

// issue #176：`failed` 终局的根因分类。引擎不解释语义、不维护枚举，只把错误上已有的分类字段
// （`KitError.code`：timeout / rate_limited / auth / server / checkpoint_failed / …）
// 原样透出；没有分类字段时回落到 `unknown`，宿主因此总能在终局里读到该字段。
export function terminationErrorCodeForError(error) {
  const code = error?.code;
  return typeof code === "string" && code.trim() !== ""
    ? code
    : "unknown";
}

// issue #176：additive 字段——只有 `reason === "failed"` 才挂 `errorCode`，
// 其余 reason 的终局形状保持不变（宿主既有 deepEqual 断言不受影响）。
export function withErrorCode(termination, error) {
  if (termination?.reason !== "failed" || termination.errorCode !== undefined) {
    return termination;
  }
  return { ...termination, errorCode: terminationErrorCodeForError(error) };
}

// issue #180（方案 A）：抛错路径同样携带终局载荷。`aborted` 的 run 真花了 token，
// 宿主却只能在 catch 里写 0，因此把已累计量同步进 termination（additive 字段，
// 「abort = 抛错」语义不变）。
export function withTerminationPayload(termination, payload) {
  if (termination?.reason !== "aborted" || termination.usage !== undefined) {
    return termination;
  }
  return {
    ...termination,
    usage: payload.usage,
    rounds: payload.rounds,
    partial: true,
  };
}

export function annotateTermination(error, termination, payload) {
  const target = error && (typeof error === "object" || typeof error === "function")
    ? error
    : (() => {
        const wrapped = new Error(String(error));
        wrapped.cause = error;
        return wrapped;
      })();
  target.termination = termination;
  // issue #180（方案 A）：与 `makeResult` 同一对象口径的 usage/rounds/finalText 挂到
  // 同一个错误对象上（finalText 为已产出的部分终稿，无则为空串）。
  if (payload !== undefined) {
    target.usage = payload.usage;
    target.rounds = payload.rounds;
    target.finalText = payload.finalText ?? "";
  }
  return target;
}

export function terminationReasonForAction(action, continuationExhausted) {
  if (action?.value === "judge_done") return "judge_done";
  if (continuationExhausted) return "continuation_exhausted";
  if (action?.value === "noTool") return "no_tool";
  if (action?.value === "stall") return "stall";
  if (action?.value === "cap") return "max_rounds_cap";
  return "end_turn";
}

// ── issue #386 切片 1：finalGuard payload 的富化（**纯加法**）───────────────────────────────
// 背景：guard 是引擎里唯一**有牙**的复核（它能改写终局），但它从前只拿到 7 个键
// （finalText / findings / messages / round / rounds / signal / termination），验收要用的
// 事实一项都没有，宿主只能去重解析 `messages`（小 run 611 字节，真实 run 几十 KB~MB）。
//
// 纪律（三条，缺一条就退化成假数据）：
//   1. 每个新键都来自引擎**既有**状态（零新采集），现有 7 个键的名字/类型/取值逐字不变；
//   2. 探不到就**不写该键**（不写假值、不写空壳）：`undefined` / 非预期类型一律跳过；
//   3. 每个可变长键都有明确上限，超限时截断并在**同键旁**留一个可判定的 `…Truncated:true`。
// 不改任何裁决语义：本模块只多交事实，accept/skip/revise 的判定与终局 reason 一字未动。

/** `finalGuard` payload 各可变长键的上限（超限截断 + 截断标记，见 `buildFinalGuardPayload`）。
 *
 * 上限不是审美：`messages` 才是 payload 的字节大头（30 轮 × 4KB 工具输出 ≈ 130KB），新键必须
 * 小到可以忽略（探针 `scripts/final-guard-probe.mjs` 把「新键总字节 < messages 字节的 2%」
 * 当断言跑）。数值口径：`filesWritten` / `toolStats` 取**最新/最活跃**的那一头（旧尾巴丢掉），
 * `taskBrief` / `selfReport` 的文本按 Unicode 码点截断（与 `capTaskBrief` 同口径，不会切碎代理对）。
 */
export const FINAL_GUARD_PAYLOAD_LIMITS = Object.freeze({
  filesWritten: 50,
  toolStats: 40,
  taskBrief: 2000,
  selfReportText: 2000,
});

/** 按**码点**截断（不按 UTF-16 码元：那会把 emoji/生僻字切成半个）。
 *  @returns {{text:string, truncated:boolean}} */
function capCodePoints(value, limit) {
  const chars = Array.from(String(value ?? ""));
  if (chars.length <= limit) return { text: chars.join(""), truncated: false };
  return { text: chars.slice(0, limit).join(""), truncated: true };
}

/** `Map` → plain object（`JSON.stringify(new Map())` 是 `{}`，宿主会读到空对象）。
 *  保留**调用次数最多**的 `limit` 个工具（calls 降序、同数按名字升序 ⇒ 可复现）；
 *  字段只搬引擎已有的 `calls` / `failures`，不新造统计。
 *  @returns {{stats:Record<string,{calls:number,failures:number}>, truncated:boolean}|null} */
function plainToolStats(toolStats, limit) {
  if (!(toolStats instanceof Map)) return null;
  const rows = [];
  for (const [name, value] of toolStats) {
    rows.push({
      name: String(name),
      calls: Number.isFinite(value?.calls) ? value.calls : 0,
      failures: Number.isFinite(value?.failures) ? value.failures : 0,
    });
  }
  rows.sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const kept = rows.slice(0, limit);
  const stats = {};
  for (const row of kept) stats[row.name] = { calls: row.calls, failures: row.failures };
  return { stats, truncated: kept.length < rows.length };
}

/** 写文件台账 → `[{path, round}]`，只留**最后** `limit` 条（= 最新；`governorState.filesWritten`
 *  本来就是 append 顺序）。`round` 缺失时写 `null` 而不是编一个 0（0 是一个合法轮号，编不得）。
 *  @returns {{files:{path:string,round:number|null}[], truncated:boolean}|null} */
function plainFilesWritten(filesWritten, limit) {
  if (!Array.isArray(filesWritten)) return null;
  const rows = [];
  for (const entry of filesWritten) {
    if (entry === null || typeof entry !== "object") continue;
    rows.push({
      path: String(entry.path ?? ""),
      round: Number.isFinite(entry.round) ? entry.round : null,
    });
  }
  const kept = rows.slice(Math.max(0, rows.length - limit));
  return { files: kept, truncated: kept.length < rows.length };
}

/** run 累计 usage → plain object（只搬引擎自己写的四个计数，不做换算、不补 0）。 */
function plainUsage(usage) {
  if (usage === null || typeof usage !== "object") return undefined;
  const out = {};
  for (const key of ["input_tokens", "output_tokens", "cacheRead", "cacheWrite"]) {
    if (Number.isFinite(usage[key])) out[key] = usage[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 模型最后一次 wrap-up 对象（**已归一化**的那一份，不重新解析）→ JSON-safe 的 `{done,summary,output,findings}`。
 *
 *  `findings` **不是**从这里原样搬的：它取 `ctx.declaredFindings`（即 payload 的 `findings` 键），
 *  两者同源 ⇒ 永远不会出现「`findings` 有值而 `selfReport` 缺该键」的分裂。
 *  @returns {{report:object, summaryTruncated:boolean, outputTruncated:boolean}|null} */
function plainSelfReport(raw, findings, limit) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const summary = capCodePoints(raw.summary, limit);
  const output = capCodePoints(raw.output, limit);
  const report = { done: raw.done === true, summary: summary.text, output: output.text };
  if (findings !== undefined) report.findings = findings;
  return {
    report,
    summaryTruncated: summary.truncated,
    outputTruncated: output.truncated,
  };
}

/**
 * 组装 `finalGuard` 的 payload。
 *
 * 前 7 个键（`finalText` / `findings` / `messages` / `round` / `rounds` / `signal` / `termination`）
 * 是既有契约，名字、类型、取值与顺序**逐字不变**（`test/loop-final-guard.test.js` 钉住）。
 * 其后全是 issue #386 的加法键，每个都「探不到就不写」。
 *
 * @param {object} ctx 引擎侧终局上下文（`createTerminationManager` 的入参）
 * @param {string} reason 终局 reason
 * @param {string|undefined} detail 终局 detail
 * @param {number} attempt 第几次 guard 调用（1 起，单调递增）
 * @returns {object} 可直接 `JSON.stringify` 的 payload（无 Map、无函数、无循环引用、无 Error）
 */
export function buildFinalGuardPayload(ctx, reason, detail, attempt) {
  const payload = {
    finalText: ctx.finalText,
    findings: ctx.declaredFindings,
    messages: cloneState(ctx.messages),
    round: ctx.rounds,
    rounds: ctx.rounds,
    signal: ctx.toolSignal,
    termination: makeTermination(reason, detail),
  };
  // ── 以下为 issue #386 加法键。顺序固定，便于宿主与探针逐键对账。
  if (typeof ctx.cwd === "string") payload.cwd = ctx.cwd;
  if (typeof ctx.runId === "string") payload.runId = ctx.runId;
  const files = plainFilesWritten(ctx.filesWritten, FINAL_GUARD_PAYLOAD_LIMITS.filesWritten);
  if (files !== null) {
    payload.filesWritten = files.files;
    if (files.truncated) payload.filesWrittenTruncated = true;
  }
  const stats = plainToolStats(ctx.toolStats, FINAL_GUARD_PAYLOAD_LIMITS.toolStats);
  if (stats !== null) {
    payload.toolStats = stats.stats;
    if (stats.truncated) payload.toolStatsTruncated = true;
  }
  if (typeof ctx.taskBrief === "string" && ctx.taskBrief !== "") {
    const brief = capCodePoints(ctx.taskBrief, FINAL_GUARD_PAYLOAD_LIMITS.taskBrief);
    payload.taskBrief = brief.text;
    if (brief.truncated) payload.taskBriefTruncated = true;
  }
  const selfReport = plainSelfReport(
    ctx.selfReport,
    ctx.declaredFindings,
    FINAL_GUARD_PAYLOAD_LIMITS.selfReportText,
  );
  if (selfReport !== null) {
    payload.selfReport = selfReport.report;
    if (selfReport.summaryTruncated) payload.selfReportSummaryTruncated = true;
    if (selfReport.outputTruncated) payload.selfReportOutputTruncated = true;
  }
  const usage = plainUsage(ctx.usage);
  if (usage !== undefined) payload.usage = usage;
  if (typeof ctx.elapsedMs === "function") {
    const elapsed = ctx.elapsedMs();
    if (Number.isFinite(elapsed)) payload.elapsedMs = elapsed;
  }
  if (Number.isSafeInteger(attempt) && attempt > 0) payload.attempt = attempt;
  if (Number.isSafeInteger(ctx.finalGuardRetryLimit)) {
    payload.guardBudget = ctx.finalGuardRetryLimit;
  }
  return payload;
}

export function createTerminationManager(ctx) {
  // issue #386：`attempt` 是「这是第几次 guard 调用」（1 起，单调递增）。计数器放在本模块的闭包里
  // 而不是 `guardMetrics`：后者是**结果**计数（verified/skipped/revised/unverified/guard_error），
  // 一个 run 里多次 revise 会让它们分散增长，反推不出调用序号。
  let guardAttempt = 0;
  const callFinalGuard = async (reason, detail) => {
    guardAttempt += 1;
    const payload = buildFinalGuardPayload(ctx, reason, detail, guardAttempt);
    let timeoutId;
    try {
      const finalGuard = ctx.finalGuard;
      const guardPromise = Promise.resolve().then(() => finalGuard(payload));
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error("Final guard timed out");
          error.code = "timeout";
          reject(error);
        }, ctx.finalGuardTimeout);
      });
      const awaitWithAbort = ctx.awaitWithAbort;
      const decision = await Promise.race([
        awaitWithAbort(guardPromise),
        timeoutPromise,
      ]);
      if (decision?.action === "accept") {
        ctx.guardMetrics.verified += 1;
        ctx.verification = { status: "verified" };
        const emitEvent = ctx.emitEvent;
        emitEvent({ type: "final_guard", round: ctx.rounds, action: "accept" });
        return { action: "accept" };
      }
      if (
        decision?.action === "skip"
        && typeof decision.reason === "string"
        && decision.reason.length > 0
      ) {
        ctx.guardMetrics.skipped += 1;
        ctx.verification = { status: "skipped", reason: decision.reason };
        const emitEvent = ctx.emitEvent;
        emitEvent({
          type: "final_guard",
          round: ctx.rounds,
          action: "skip",
          reason: decision.reason,
        });
        return { action: "skip", reason: decision.reason };
      }
      if (
        decision?.action === "revise"
        && typeof decision.message === "string"
        && decision.message.length > 0
      ) {
        ctx.guardMetrics.revised += 1;
        const emitEvent = ctx.emitEvent;
        emitEvent({
          type: "final_guard",
          round: ctx.rounds,
          action: "revise",
          reason: "unverified",
        });
        return { action: "revise", message: decision.message };
      }
      throw new TypeError("finalGuard returned an invalid decision");
    } catch (error) {
      if (ctx.signal?.aborted) {
        const throwIfAborted = ctx.throwIfAborted;
        throwIfAborted(ctx.signal);
      }
      const errorReason = error?.code === "timeout"
        || error?.name === "TimeoutError"
        ? "timeout"
        : "error";
      ctx.guardMetrics.unverified += 1;
      ctx.verification = {
        status: "error",
        reason: errorReason,
        detail: terminationDetailForError(error),
      };
      ctx.guardMetrics.guard_error += 1;
      const emitEvent = ctx.emitEvent;
      emitEvent({
        type: "final_guard",
        round: ctx.rounds,
        action: "error",
        reason: errorReason,
      });
      return { action: "error", reason: errorReason };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const hasFinalDraft = () => (
    ctx.finalText.trim() !== ""
    && ctx.roundStopReason === "end_turn"
    && !hasToolUse(ctx.lastAssistantContent)
  );

  const forceFinalIfNeeded = async (reason) => {
    if (
      ctx.forcedFinal
      || !["max_rounds_cap", "stall", "continuation_exhausted"].includes(reason)
      || hasFinalDraft()
      || process.env.ERIX_NO_FORCED_FINAL?.trim() === "1"
    ) return;

    const instruction = {
      role: "user",
      // issue #323：强制收尾指令是引擎自写的控制文本，打 marker 防 judge 自读回（主模型仍可见）。
      meta: { source: "judge-control" },
      content: [{
        type: "text",
        text: `【强制收尾】循环因 ${reason} 结束。禁止调用任何工具；请立即给出最终结论，或明确声明不可恢复。`,
      }],
    };
    ctx.messages.push(instruction);
    ctx.messageRounds.set(instruction, ctx.rounds);
    validateMessages(ctx.messages, { allowPendingToolUse: true });
    const stablePrefix = ctx.cacheStablePrefix !== false
      ? markStablePrefix(ctx.mainSystem, ctx.messages)
      : { system: ctx.mainSystem, messages: ctx.messages };
    const request = {
      system: stablePrefix.system,
      messages: stablePrefix.messages,
      tools: [],
      signal: ctx.signal,
    };
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
    if (ctx.temperature !== undefined) request.temperature = ctx.temperature;
    if (ctx.topP !== undefined) request.topP = ctx.topP;
    const awaitWithAbort = ctx.awaitWithAbort;
    const response = await awaitWithAbort(ctx.provider.chat(request));
    const addUsage = ctx.addUsage;
    const estimateMessageTokens = ctx.estimateMessageTokens;
    addUsage(response, estimateMessageTokens(ctx.messages));
    const content = blocksFor(response?.content);
    const assistant = { role: "assistant", content };
    ctx.messages.push(assistant);
    ctx.messageRounds.set(assistant, ctx.rounds);
    ctx.lastAssistantContent = content;
    ctx.roundStopReason = response?.stopReason;
    const responseText = textFromBlocks(content);
    const wrapup = ctx.wrapupEnabled && response?.stopReason === "end_turn"
      ? tryParseWrapupJson(responseText)
      : null;
    ctx.finalText = wrapup === null
      ? responseText
      : wrapup.output || wrapup.summary;
    ctx.declaredFindings = wrapup?.findings;
    // issue #386：强制收尾同样产出一份 wrap-up（与 `declaredFindings` 同源、同一时刻），
    // 所以自报对象也要跟着换——否则 guard 拿到的是收尾**之前**那份自报，甚至没有。
    ctx.selfReport = wrapup ?? undefined;
    ctx.forcedFinal = true;
    const emitEvent = ctx.emitEvent;
    emitEvent({ type: "forced_final", round: ctx.rounds, reason });
  };

  const makeResult = (reason, detail, error) => {
    // issue #176：成功返回路径上 `failed` 目前不是可达 reason（失败统一走 fail() 抛错），
    // 此处只保持与抛错路径同一口径的字段规则，避免两条终路形状分叉。
    const termination = withErrorCode({
      ...makeTermination(reason, detail),
      ...(ctx.forcedFinal ? { forcedFinal: true } : {}),
    }, error);
    return {
      finalText: ctx.finalText,
      messages: ctx.messages,
      transcript: [...ctx.messages],
      rounds: ctx.rounds,
      truncated: TRUNCATED_TERMINATION_REASONS.has(termination.reason),
      termination,
      verification: { ...ctx.verification, metrics: { ...ctx.guardMetrics } },
      ...(ctx.currentRunState === undefined
        ? {}
        : { runState: cloneState(ctx.currentRunState) }),
      usage: ctx.usage,
      compactionStats: ctx.compactionStats,
      // 错误账单（issue #109 第 1 步）：可靠交付通道之二；默认空数组（schema 冻结）。
      // completionErrors 由第 4 步接线（收尾失败不覆盖主结果）。
      unpersisted: ctx.errorLedger.toUnpersisted(),
      completionErrors: [],
    };
  };

  const finish = async (reason, detail, error) => {
    ctx.currentTerminationReason = reason;
    const refreshRunState = ctx.refreshRunState;
    try {
      await refreshRunState();
      const state = ctx.verification.status === "unverified"
        ? "unverified_error"
        : ctx.verification.status === "error"
          ? "guard_error"
          : "succeeded";
      const markRunState = ctx.markRunState;
      await markRunState(state);
      const result = makeResult(reason, detail, error);
      // issue #165：终局追加一条 run 级 outcome 汇总记录（方案 ①：append-only，**不回写**
      // 已流出的 judge 决策记录，宿主按 `runId` join）。放在 markRunState **之后**：持久化
      // 失败时走 catch → ctx.fail()，由它发唯一一条终局记录（发射口有去重门，不会双发）。
      const emitRunOutcome = ctx.emitRunOutcome;
      if (typeof emitRunOutcome === "function") {
        emitRunOutcome({
          rounds: result.rounds,
          termination: result.termination,
          verification: result.verification,
        });
      }
      return result;
    } catch (error) {
      return ctx.fail(error);
    }
  };

  return {
    callFinalGuard,
    forceFinalIfNeeded,
    finish,
  };
}
