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

export function createTerminationManager(ctx) {
  const callFinalGuard = async (reason, detail) => {
    const payload = {
      finalText: ctx.finalText,
      findings: ctx.declaredFindings,
      messages: cloneState(ctx.messages),
      round: ctx.rounds,
      rounds: ctx.rounds,
      signal: ctx.toolSignal,
      termination: makeTermination(reason, detail),
    };
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
