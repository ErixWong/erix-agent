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
      throw new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed before tool execution (runId=${String(ctx.runId)}, round=${round})`,
      );
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
      const result = executeTool.length <= 1
        ? await awaitWithAbort(
          Promise.resolve().then(() => executeTool(structuredOptions)),
        )
        : await awaitWithAbort(Promise.resolve().then(() => (
          executeTool(block.name, block.input)
        )));
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

    const toolResult = {
      type: "tool_result",
      tool_use_id: block.id,
      content: execution.content,
      ...execution.metadata,
    };
    const artifactStatus = execution.metadata.artifactStatus
      ?? execution.metadata.artifact?.status
      ?? execution.metadata.rerunOf?.status;
    if (execution.metadata.replayable === false) ctx.nonReplayableCaptureCount += 1;
    if (["missing", "stale", "unrecoverable", "error"].includes(artifactStatus)) {
      ctx.archiveFailureCount += 1;
    }
    if (artifactStatus === "unrecoverable") ctx.unrecoverableCaptureCount += 1;
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
      throw new KitError(
        "checkpoint_failed",
        `Checkpoint persistence failed after tool execution: tool already executed but result was not persisted (toolUseId=${String(block.id)}, runId=${String(ctx.runId)}, round=${round})`,
      );
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
    await persistCheckpointAfterIntercept({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
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
    await persistCheckpointForInterceptResult({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "intercepted",
      messagesOverride: overriddenMessages,
    });
    return toolResult;
  };

  return {
    executeToolBlock,
    executeToolWithIntercept,
    pendingDirectionHints,
  };
}
