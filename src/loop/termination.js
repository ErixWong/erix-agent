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
  "reflection_stop",
]);

export const FINAL_GUARD_NON_CONTINUABLE_REASONS = new Set([
  "max_rounds_cap",
  "stall",
  "continuation_exhausted",
  "reflection_stop",
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

export function annotateTermination(error, termination) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    error.termination = termination;
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.cause = error;
  wrapped.termination = termination;
  return wrapped;
}

export function terminationReasonForAction(action, continuationExhausted) {
  if (action?.value === "judge_done") return "judge_done";
  if (continuationExhausted) return "continuation_exhausted";
  if (action?.value === "noTool") return "no_tool";
  if (action?.value === "stall") return "stall";
  if (action?.value === "cap") return "max_rounds_cap";
  if (action?.value === "reflection-stop") return "reflection_stop";
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
    const request = {
      system: ctx.mainSystem,
      messages: ctx.messages,
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

  const makeResult = (reason, detail) => {
    const termination = {
      ...makeTermination(reason, detail),
      ...(ctx.forcedFinal ? { forcedFinal: true } : {}),
    };
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

  const finish = async (reason, detail) => {
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
      return makeResult(reason, detail);
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
import { tryParseWrapupJson } from "../reflection/wrapup.js";
import { validateMessages } from "../messages/rounds.js";
import { cloneState } from "./budget.js";
import { blocksFor, hasToolUse, textFromBlocks } from "./messages.js";
