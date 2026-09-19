import { KitError } from "../providers/errors.js";
import { cloneState } from "./budget.js";
import { throwIfAborted } from "./abort.js";
import {
  mergeToolResultsIntoMessages,
  toolResultContent,
  toolResultData,
} from "./messages.js";
import { directionHintText } from "./reflection.js";
import {
  aggregateStubText,
  aggregateUnrecoverableStubText,
  createRoundAggregateGate,
  errorSnippet,
} from "./aggregate-budget.js";

// 只读工具集合（issue #33 C）：拦截 judge 对这类工具放行——只读调用无外部副作用，
// uncertain/off_track 时拦它净收益为负（实测 readFile 被拦后缺陷反而漏出）。
// exec/writeFile/mcp 等写路径不在此列，维持拦截语义不变。
export const READONLY_INTERCEPT_TOOLS = new Set([
  "readFile",
  "tree",
  "rg",
  "note_read",
  "note_list",
  "recall",
]);

// judge 原文落盘前的防爆日志截断（2026-09-20）：单条 intercept 记录最多 2000 字符。
const JUDGE_RAW_LOG_LIMIT = 2000;
function truncateJudgeRaw(text) {
  const value = String(text ?? "");
  return value.length > JUDGE_RAW_LOG_LIMIT
    ? `${value.slice(0, JUDGE_RAW_LOG_LIMIT)}…[截断，共 ${value.length} 字符]`
    : value;
}

export function createCheckpointExecutor(ctx) {
  // 单轮聚合输出预算（issue #32 #2）：逐条 outputHygiene 之外的「本轮合计」闸门。
  // 预算基准用引擎既有 budgetTokens（无窗口配置 → 聚合层整体关闭，行为不变）。
  const aggregateGate = createRoundAggregateGate({
    // 归档通道不存在（理论上 outputHygiene 已保证，这里只做防御）→ 聚合层关闭，不产生假 stub
    budgetTokens: Array.isArray(ctx.archivedOutputs) ? ctx.aggregateBudgetTokens : undefined,
    archivedOutputs: ctx.archivedOutputs ?? [],
    listRoundResults: () => [...(ctx.checkpointResults?.values() ?? [])],
  });
  // 终止态事件每轮只报一次（诊断用；不参与判定，故无恢复语义）
  const aggregateTerminalRounds = new Set();
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

  // 剩余轮数必须配本次 runToolLoop 的预算计数器（budgetRounds），不能用身份轮号：
  // resume 后身份轮号已到顶，会算出错误的剩余轮数提前催收尾（issue #32 #8）
  const budgetHintFor = () => {
    const remaining = ctx.governorState.effectiveMaxRounds - ctx.budgetRounds;
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

  // 单轮聚合预算（issue #32 #2）：在 onToolResult 改写 + 逐条 outputHygiene 之后、后置 checkpoint
  // **之前**立即判定内联或归档+stub。声明顺序与 tool_use_id 不变、不重排、不做批末回写——
  // 因此已 checkpoint 的 tool_result 永远不会被回写，resume 语义与改动前一致。
  const applyRoundAggregate = (block, round, toolName, execution, failed) => {
    if (!aggregateGate.enabled) return execution;
    // 聚合层要求稳定的 tool_use id（OpenAI/Anthropic 双协议都强制提供）：归档条目的幂等与
    // 终止态判定都以 toolUseId 为键，缺 id 会让多条结果互相冒充。无 id 的结果维持现状（内联）。
    if (block.id === undefined) return execution;
    const decision = aggregateGate.evaluate({
      round,
      toolUseId: block.id,
      content: execution.content,
    });
    if (decision.action === "inline") return execution;
    const fullText = execution.content;
    const snippet = failed ? errorSnippet(fullText) : undefined;
    const emitAggregate = (action, extra = {}) => {
      const emitEvent = ctx.emitEvent;
      if (typeof emitEvent !== "function") return;
      emitEvent({
        type: "tool_output_aggregate",
        round,
        toolUseId: block.id,
        name: toolName,
        action,
        reason: decision.reason,
        budgetTokens: decision.budgetTokens,
        inlineTokens: decision.inlineTokens,
        costTokens: decision.costTokens,
        projectedTokens: decision.projectedTokens,
        contentLength: fullText.length,
        ...extra,
      });
    };
    if (decision.action === "archive") {
      ctx.archivedOutputs.push({
        toolUseId: block.id,
        name: toolName,
        round,
        content: fullText,
      });
      emitAggregate("archived", { archivedBytes: decision.bytes });
      return {
        ...execution,
        content: aggregateStubText({ round, length: fullText.length, errorSnippet: snippet }),
      };
    }
    if (decision.action === "unrecoverable") {
      // fail-closed：不归档、不承诺 recall，显式计数 + 事件（宁丢不骗）。
      // main/ADR-016 退役了 run-state 的 `errors.archive` 计数，「没存上」改入错误账本
      // （`deterministic.errors.unpersisted`）——语义同一：这一份原文被丢了。
      ctx.errorLedger?.record?.({
        port: "transcript",
        operation: "archiveToolOutput",
        phase: "tool",
        fatal: false,
        error: new Error(
          `aggregate archive capacity exceeded: round ${round} output of ${fullText.length} chars not archived`,
        ),
      });
      emitAggregate("unrecoverable", { archivedBytes: decision.archivedBytes });
      return {
        ...execution,
        content: aggregateUnrecoverableStubText({
          round,
          length: fullText.length,
          reason: decision.reason,
          errorSnippet: snippet,
        }),
      };
    }
    // stub_kept：已在档（逐条或聚合归档过）→ 不再二次替换；全部 stub 化即终止，每轮只报一次
    if (decision.terminal === true && !aggregateTerminalRounds.has(round)) {
      aggregateTerminalRounds.add(round);
      emitAggregate("terminated");
    }
    return execution;
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
          + `需要原文：recall({ round: ${round}, pattern: "关键词" })；不要重跑有副作用的命令。`
          + `若原命令有副作用，不要仅凭截断输出判断成败，也不要为补全输出重跑有副作用的命令；`
          + `用 recall 取回原文或改用只读方式复核。]`,
      };
    }
    // 单轮聚合预算：逐条阈值与聚合阈值**串联且独立**——逐条先跑，聚合再判；
    // 已是 stub 的结果不再被聚合层二次替换（两者叠加不死循环）。
    execution = applyRoundAggregate(
      block,
      round,
      toolName,
      execution,
      isError || execution.success === false,
    );
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
    const budgetHint = budgetHintFor();
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
    // 最后一轮（无 tools 请求）跳过 intercept 审计：无工具可审（2026-09-20 预算兜底修复）。
    // 用 budgetRounds 而非身份轮号：resume 后身份轮号已到顶，会误判剩余轮数（issue #32 #8 同口径）。
    const finalBudgetRound = ctx.budgetRounds >= ctx.governorState.effectiveMaxRounds;
    const interceptEnabled = !finalBudgetRound
      && ctx.judgeInterceptEnabled
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
    let judgeUsage;
    let judgeRaw;
    let interceptError;
    let interceptErrorMessage;
    try {
      const callRoundJudge = ctx.callRoundJudge;
      const judged = await callRoundJudge(round, undefined, {
        timeoutMs: ctx.judgeInterceptTimeoutMs,
        conversationBudgetTokens: ctx.judgeInterceptConversationTokens,
      });
      decision = judged?.decision;
      judgeUsage = judged?.usage;
      judgeRaw = judged?.raw;
    } catch (error) {
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      decision = undefined;
      interceptError = error?.code === "judge_intercept_timeout" ? "timeout" : "error";
      // 错误详情落 judge.log（可审计性）：judge 空转/报错需要能看到根因，300 字符截断。
      interceptErrorMessage = String(error?.message ?? String(error)).slice(0, 300);
    }
    ctx.judgeInterceptCount = 0;

    // 放行规则（issue #32 / 运行时评估 §5）：done:false 只是「任务尚未完成」，与「这次调用该不该执行」正交。
    // 任务中途 done:false 必然成立，若一律拦截就会误杀方向正确的工具调用（实测 39 次）。
    // 因此仅当 judge 明确 direction === "on_track" 时放行；uncertain / off_track / 缺省 direction 维持拦截。
    const onTrackPassThrough = decision !== undefined
      && decision !== null
      && decision.done === false
      && decision.direction === "on_track";
    // 只读放行（issue #33 C）：done:false 且方向非 on_track 时，只读工具照常执行
    // （无外部副作用，拦截净收益为负）；事件 action 仍为 executed，passThrough 标 "readonly"
    // 与 on_track 同构，审计可辨；uncertain/off_track 语义本身不变，写工具维持拦截。
    const readOnlyPassThrough = decision !== undefined
      && decision !== null
      && decision.done === false
      && READONLY_INTERCEPT_TOOLS.has(String(block.name ?? ""));
    const passThrough = onTrackPassThrough
      ? "on_track"
      : (readOnlyPassThrough ? "readonly" : undefined);

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
        ...(interceptErrorMessage ? { errorDetail: interceptErrorMessage } : {}),
        // parse 失败但 usage 已可取得时同样带出（超时/抛错路径 judgeUsage 为 undefined，
        // 展开为空、字段缺省，行为不变）。
        ...(judgeUsage ? { usage: judgeUsage } : {}),
        // judge 原文落盘（可审计性）：截断 2000 字符防爆日志；超时/无响应时 raw 为空串，缺省。
        ...(typeof judgeRaw === "string" && judgeRaw !== ""
          ? { raw: truncateJudgeRaw(judgeRaw) }
          : {}),
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
        action: passThrough !== undefined || decision.done !== false ? "executed" : "blocked",
        ...(passThrough ? { passThrough } : {}),
        // judge 当次调用用量（issue #33 B）：judge.log 对账；超时/出错时缺省。
        ...(judgeUsage ? { usage: judgeUsage } : {}),
        // judge 原文落盘（可审计性）：截断 2000 字符防爆日志。
        ...(typeof judgeRaw === "string" && judgeRaw !== ""
          ? { raw: truncateJudgeRaw(judgeRaw) }
          : {}),
      });
    }

    // on_track / readonly 放行的调用照常执行（judge 已给出方向判断，无需再打断）
    if (onTrackPassThrough || readOnlyPassThrough || decision?.done !== false) {
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
    const budgetHint = budgetHintFor();
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
