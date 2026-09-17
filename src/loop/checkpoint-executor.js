import { KitError } from "../providers/errors.js";
import { cloneState } from "./budget.js";
import { throwIfAborted } from "./abort.js";
import {
  mergeToolResultsIntoMessages,
  toolResultContent,
  toolResultData,
} from "./messages.js";
import { directionHintText } from "./reflection.js";

export function createCheckpointExecutor(ctx) {
  const normalizeExecutionResult = (value, startedAt) => {
    if (value instanceof Error) {
      return {
        content: toolResultContent(value.message ?? value),
        metadata: {},
        success: false,
      };
    }
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "content")
    ) {
      const metadata = value.metadata
        && typeof value.metadata === "object"
        && !Array.isArray(value.metadata)
        ? { ...value.metadata }
        : {};
      if (Object.prototype.hasOwnProperty.call(value, "success")) {
        metadata.success = value.success;
      }
      const success = value.success ?? metadata.success ?? true;
      metadata.duration = Date.now() - startedAt;
      return {
        content: toolResultContent(value.content),
        metadata,
        success: success !== false,
      };
    }
    const structured = toolResultData(value);
    if (structured === undefined) {
      return { content: toolResultContent(value), metadata: {}, success: true };
    }
    const metadata = Object.fromEntries(
      Object.entries(structured).filter(([key]) => (
        !["data", "type", "tool_use_id", "content"].includes(key)
      )),
    );
    metadata.success = structured.success ?? true;
    metadata.duration = Date.now() - startedAt;
    return {
      content: toolResultContent(structured.data),
      metadata,
      success: metadata.success !== false,
    };
  };

  const budgetHintFor = (round) => {
    const remaining = ctx.governorState.effectiveMaxRounds - round;
    if (remaining <= 2) ctx.lowBudgetPrompted = true;
    return remaining <= 2
      ? `[预算] 本轮后仅剩 ${Math.max(0, remaining)} 轮；请立即给出结论，或明确声明不可恢复`
      : "";
  };

  const messagesWithToolResults = (toolResults) => {
    const snapshot = cloneState(ctx.messages);
    if (toolResults.length === 0) return snapshot;
    if (mergeToolResultsIntoMessages(snapshot, toolResults) !== false) return snapshot;
    snapshot.push({ role: "user", content: cloneState(toolResults) });
    return snapshot;
  };

  const executeToolBlock = async (block, round, toolResults, pendingToolUses = []) => {
    const toolName = String(block.name ?? "");
    const toolStat = ctx.toolStats.get(toolName) ?? { calls: 0, failures: 0 };
    toolStat.calls += 1;
    ctx.toolStats.set(toolName, toolStat);
    const persistCheckpoint = ctx.persistCheckpoint;
    const checkpointPersisted = await persistCheckpoint({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
    if (!checkpointPersisted && ctx.hasCheckpointStore) {
      ctx.checkpointFailureCount += 1;
      const failure = new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed before tool execution (runId=${String(ctx.runId)}, round=${round})`,
      );
      if (ctx.lastPersistenceFailure) {
        failure.operation = ctx.lastPersistenceFailure.operation;
        failure.phase = "checkpoint_before_tool";
        failure.sideEffect = "not_started";
        failure.persistence = ctx.lastPersistenceFailure.persistence;
        failure.persistenceError = ctx.lastPersistenceFailure.persistenceError;
      }
      throw failure;
    }
    const startedAt = Date.now();
    let execution;
    let isError = false;
    try {
      const structuredOptions = {
        id: block.id,
        name: block.name,
        input: block.input,
        context: { ...ctx.baseToolContext, round },
        signal: ctx.toolSignal,
      };
      const executeTool = ctx.executeTool;
      const awaitWithAbort = ctx.awaitWithAbort;
      const result = await awaitWithAbort(
        Promise.resolve().then(() => executeTool(structuredOptions)),
      );
      execution = normalizeExecutionResult(result, startedAt);
    } catch (error) {
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      isError = true;
      execution = {
        content: String(error?.message ?? error),
        metadata: {},
        success: false,
      };
    }
    ctx.markToolExecuted?.();

    if (ctx.onToolResult) {
      const onToolResult = ctx.onToolResult;
      const rewritten = await onToolResult(
        block.name,
        execution.content,
        execution.metadata,
      );
      if (rewritten !== undefined) {
        const normalized = normalizeExecutionResult(rewritten, startedAt);
        execution = {
          ...normalized,
          metadata: { ...execution.metadata, ...normalized.metadata },
          success: execution.success && normalized.success,
        };
      }
    }

    // ADR-015 输出卫生：超限结果全量入档（round record 的 toolOutputs），上下文视图留 stub + recall 配方。
    // 在 onToolResult 重写之后执行：宿主的改写/脱敏先行，引擎归档的是宿主最终交出的内容。
    if (ctx.outputHygieneEnabled && execution.content.length > ctx.outputHygieneLimit) {
      const fullText = execution.content;
      ctx.archivedOutputs.push({
        toolUseId: block.id,
        name: toolName,
        round,
        content: fullText,
      });
      execution = {
        ...execution,
        content: `${fullText.slice(0, ctx.outputHygieneLimit)}`
          + `\n[完整输出已由引擎归档（第 ${round} 轮，共 ${fullText.length} 字符）。`
          + `需要原文：recall({ round: ${round}, pattern: "关键词" })；不要重跑有副作用的命令]`,
      };
    }
    const toolResult = {
      type: "tool_result",
      tool_use_id: block.id,
      content: execution.content,
      ...execution.metadata,
    };
    if (isError || execution.success === false) {
      toolStat.failures += 1;
      ctx.toolErrorCount += 1;
    }
    const budgetHint = budgetHintFor(round);
    if (budgetHint) toolResult.content = `${toolResult.content}\n${budgetHint}`;
    if (isError || execution.success === false) toolResult.is_error = true;
    toolResults.push(toolResult);
    if (block.id !== undefined) ctx.executedToolIds.add(block.id);
    ctx.checkpointResults.set(block.id, toolResult);
    const persistCheckpointAfter = ctx.persistCheckpoint;
    const postCheckpointPersisted = await persistCheckpointAfter({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "executed",
      messagesOverride: messagesWithToolResults(toolResults),
    });
    if (!postCheckpointPersisted && ctx.hasCheckpointStore) {
      ctx.checkpointFailureCount += 1;
      const failure = new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed after tool execution: tool already executed but result was not persisted (toolUseId=${String(block.id)}, runId=${String(ctx.runId)}, round=${round})`,
      );
      if (ctx.lastPersistenceFailure) {
        failure.operation = ctx.lastPersistenceFailure.operation;
        failure.phase = "checkpoint_after_tool";
        failure.sideEffect = "executed_uncommitted";
        failure.persistence = ctx.lastPersistenceFailure.persistence;
        failure.persistenceError = ctx.lastPersistenceFailure.persistenceError;
      }
      throw failure;
    }
    return toolResult;
  };

  const pendingDirectionHints = [];
  const executeToolWithIntercept = async (
    block,
    round,
    toolResults,
    pendingToolUses = [],
  ) => {
    const interceptEnabled = ctx.judgeInterceptEnabled
      && ctx.judgeInterceptCount >= ctx.judgeIntervalRound;
    if (!interceptEnabled) {
      ctx.judgeInterceptCount += 1;
      return executeToolBlock(block, round, toolResults, pendingToolUses);
    }

    const persistCheckpointAfterIntercept = ctx.persistCheckpoint;
    const checkpointPersisted = await persistCheckpointAfterIntercept({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
    if (!checkpointPersisted && ctx.hasCheckpointStore) {
      ctx.checkpointFailureCount += 1;
      const failure = new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed before intercepted tool execution (runId=${String(ctx.runId)}, round=${round})`,
      );
      if (ctx.lastPersistenceFailure) {
        failure.operation = ctx.lastPersistenceFailure.operation;
        failure.phase = "checkpoint_before_tool";
        failure.sideEffect = "not_started";
        failure.persistence = ctx.lastPersistenceFailure.persistence;
        failure.persistenceError = ctx.lastPersistenceFailure.persistenceError;
      }
      throw failure;
    }
    let decision;
    let interceptError;
    try {
      const callRoundJudge = ctx.callRoundJudge;
      decision = await callRoundJudge(round, undefined, {
        timeoutMs: ctx.judgeInterceptTimeoutMs,
        conversationBudgetTokens: ctx.judgeInterceptConversationTokens,
      });
    } catch (error) {
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      decision = undefined;
      interceptError = error?.code === "judge_intercept_timeout" ? "timeout" : "error";
    }
    ctx.judgeInterceptCount = 0;

    if (decision === undefined || decision === null) {
      const emitJudge = ctx.emitJudge;
      emitJudge({
        kind: "intercept",
        tool: {
          id: block.id,
          name: block.name,
          input: cloneState(block.input),
        },
        decision: null,
        action: "degraded",
        error: decision === undefined ? interceptError : "parse",
      });
    } else {
      const emitJudge = ctx.emitJudge;
      emitJudge({
        kind: "intercept",
        tool: {
          id: block.id,
          name: block.name,
          input: cloneState(block.input),
        },
        decision: {
          done: decision.done,
          confidence: decision.confidence,
          reason: decision.reason,
          evidence: decision.evidence,
          direction: decision.direction,
          directionReason: decision.directionReason,
        },
        action: decision.done === false ? "blocked" : "executed",
      });
    }

    if (decision?.done !== false) {
      try {
        const toolResult = await executeToolBlock(block, round, toolResults, pendingToolUses);
        const directionHint = directionHintText(
          decision?.direction,
          decision?.directionReason,
        );
        if (directionHint) pendingDirectionHints.push(directionHint);
        return toolResult;
      } finally {
        ctx.judgeInterceptCount = 0;
      }
    }

    const reason = decision.reason || "任务方向可能偏离目标";
    const evidence = decision.evidence || "评审未提供更多证据";
    const directionHint = directionHintText(
      decision.direction,
      decision.directionReason,
    );
    if (directionHint) pendingDirectionHints.push(directionHint);
    const toolResult = {
      type: "tool_result",
      tool_use_id: block.id,
      executionStatus: "intercepted",
      content: `【审计拦截】方向可能偏: ${reason}/${evidence}。原工具调用未执行，请重新评估方向后继续。`,
    };
    const budgetHint = budgetHintFor(round);
    if (budgetHint) toolResult.content = `${toolResult.content}\n${budgetHint}`;
    if (block.id !== undefined) ctx.checkpointResults.set(block.id, toolResult);
    toolResults.push(toolResult);
    const overriddenMessages = [
      ...ctx.messages,
      { role: "user", content: cloneState(toolResults) },
    ];
    if (pendingDirectionHints.length > 0) {
      overriddenMessages.push({
        role: "user",
        content: pendingDirectionHints.map((text) => ({ type: "text", text })),
      });
    }
    const persistCheckpointForInterceptResult = ctx.persistCheckpoint;
    const resultCheckpointPersisted = await persistCheckpointForInterceptResult({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "intercepted",
      messagesOverride: overriddenMessages,
    });
    if (!resultCheckpointPersisted && ctx.hasCheckpointStore) {
      ctx.checkpointFailureCount += 1;
      const failure = new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed after intercept result (runId=${String(ctx.runId)}, round=${round})`,
      );
      if (ctx.lastPersistenceFailure) {
        // The intercepted tool never ran, so losing its decision/result has no external side effect.
        failure.operation = ctx.lastPersistenceFailure.operation;
        failure.phase = "checkpoint_before_tool";
        failure.sideEffect = "not_started";
        failure.persistence = ctx.lastPersistenceFailure.persistence;
        failure.persistenceError = ctx.lastPersistenceFailure.persistenceError;
      }
      throw failure;
    }
    return toolResult;
  };

  return {
    executeToolBlock,
    executeToolWithIntercept,
    pendingDirectionHints,
  };
}
