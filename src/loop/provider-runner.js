import { cloneState } from "./budget.js";
import { normalizeMessages } from "./messages.js";
import { throwIfAborted } from "./abort.js";
import { validateMessages } from "../messages/rounds.js";
import { foldToolResultsForRequest } from "./tool-result-ttl.js";

export async function callProvider(ctx, {
  allowPendingToolUse = false,
  round,
  // 预算兜底（2026-09-20 基准：撞 64 轮截断 + wrapup 全量重发历史多花 4 分钟）：
  // 最后一轮省略 tools，强制模型输出文本终稿。OpenAI/Anthropic 两协议均允许无 tools 请求。
  omitTools = false,
} = {}) {
  let retryIndex = 0;
  let recovered = false;
  while (true) {
    normalizeMessages(ctx.messages);
    validateMessages(ctx.messages, { allowPendingToolUse });
    // TTL 折叠（issue #35）：只替换请求视图，ctx.messages 本身不动（checkpoint 仍存全文）。
    // toolResultFold 是 orchestrator 的配置 getter（含终稿保护口径），每次 attempt 重新读取；
    // null/undefined = 本轮不折叠。
    const foldConfig = ctx.toolResultFold ?? null;
    const requestMessages = foldConfig === null || foldConfig === undefined
      ? ctx.messages
      : foldToolResultsForRequest(ctx.messages, {
        currentRound: round,
        ttl: foldConfig.ttl,
        minTokens: foldConfig.minTokens,
      });
    const estimateMessageTokens = ctx.estimateMessageTokens;
    const requestEstimatedTokens = estimateMessageTokens(requestMessages);
    const snapshot = {
      messages: cloneState(ctx.messages),
      eventDeltas: [...ctx.roundEventDeltas],
      finalText: ctx.finalText,
      usage: { ...ctx.usage },
      latestApiInputTokens: ctx.latestApiInputTokens,
      latestApiEstimatedTokens: ctx.latestApiEstimatedTokens,
      stopReason: ctx.roundStopReason,
    };

    const attempt = retryIndex + 1;
    const attemptEvents = [];
    let attemptUsage;
    const emitEvent = ctx.emitEvent;
    emitEvent({
      type: "attempt",
      round,
      attempt,
      maxAttempts: ctx.retryAttempts + 1,
    });

    const dispatchAttemptEvent = (event, callback) => {
      if (event.type === "usage") {
        const emitEvent = ctx.emitEvent;
        emitEvent({ type: "usage", round, usage: event.usage });
      }
      if (event.type !== "usage" || attemptUsage !== undefined) {
        ctx.roundEventDeltas.push(event);
      }
      try {
        callback();
      } catch (error) {
        const reportObserverError = ctx.reportObserverError;
        reportObserverError(error);
      }
    };
    const queueEvent = (event, callback) => {
      if (ctx.retryAttempts === 0) {
        dispatchAttemptEvent(event, callback);
        return;
      }
      attemptEvents.push({ event, callback });
    };
    try {
      const request = {
        system: ctx.mainSystem,
        messages: requestMessages,
        signal: ctx.signal,
      };
      if (omitTools !== true) request.tools = ctx.tools;
      if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
      if (ctx.temperature !== undefined) request.temperature = ctx.temperature;
      if (ctx.topP !== undefined) request.topP = ctx.topP;
      if (
        typeof ctx.provider.chat === "function"
          ? ctx.stream && typeof ctx.provider.chatStream === "function"
          : typeof ctx.provider.chatStream === "function"
      ) {
        const awaitWithAbort = ctx.awaitWithAbort;
        let response = await awaitWithAbort(ctx.provider.chatStream({
          ...request,
          onDelta: (chunk) => queueEvent(
            { type: "delta", delta: chunk },
            () => {
              const onDelta = ctx.onDelta;
              onDelta?.(chunk);
            },
          ),
          onReasoningDelta: (chunk, metadata) => queueEvent(
            {
              type: "reasoning_delta",
              delta: chunk,
              ...(metadata === undefined ? {} : { metadata }),
            },
            () => {
              const onReasoningDelta = ctx.onReasoningDelta;
              onReasoningDelta?.(chunk, metadata);
            },
          ),
          onToolCall: (fragment) => queueEvent(
            { type: "tool_call", ...fragment },
            () => {
              const onToolCall = ctx.onToolCall;
              onToolCall?.(fragment);
            },
          ),
          onUsage: (reportedUsage) => {
            attemptUsage = reportedUsage;
            queueEvent(
              { type: "usage", usage: reportedUsage },
              () => {
                const onUsage = ctx.onUsage;
                onUsage?.(reportedUsage);
              },
            );
          },
        }));
        if (attemptUsage !== undefined && response?.usage === undefined) {
          response = { ...response, usage: attemptUsage };
        }
        if (recovered) {
          const emitEvent = ctx.emitEvent;
          emitEvent({ type: "recovered", round, attempt });
        }
        for (const { event, callback } of attemptEvents) {
          dispatchAttemptEvent(event, callback);
        }
        return {
          response,
          usageEmitted: attemptUsage !== undefined,
          estimatedTokens: requestEstimatedTokens,
        };
      }
      const awaitWithAbort = ctx.awaitWithAbort;
      const response = await awaitWithAbort(ctx.provider.chat(request));
      if (recovered) {
        const emitEvent = ctx.emitEvent;
        emitEvent({ type: "recovered", round, attempt });
      }
      return {
        response,
        usageEmitted: false,
        estimatedTokens: requestEstimatedTokens,
      };
    } catch (error) {
      if (ctx.signal?.aborted) throwIfAborted(ctx.signal);
      if (ctx.retryOptions === null || error?.retryable !== true) {
        throw error;
      }
      ctx.messages = cloneState(snapshot.messages);
      ctx.roundEventDeltas = [...snapshot.eventDeltas];
      ctx.finalText = snapshot.finalText;
      ctx.usage.input_tokens = snapshot.usage.input_tokens;
      ctx.usage.output_tokens = snapshot.usage.output_tokens;
      ctx.latestApiInputTokens = snapshot.latestApiInputTokens;
      ctx.latestApiEstimatedTokens = snapshot.latestApiEstimatedTokens;
      ctx.roundStopReason = snapshot.stopReason;
      if (retryIndex >= ctx.retryAttempts) throw error;
      const delay = Math.min(
        ctx.backoffBaseMs * (2 ** retryIndex),
        ctx.backoffMaxMs,
      );
      retryIndex += 1;
      recovered = true;
      const emitEvent = ctx.emitEvent;
      emitEvent({
        type: "recovering",
        round,
        attempt: retryIndex + 1,
        maxAttempts: ctx.retryAttempts + 1,
      });
      const waitForRetry = ctx.waitForRetry;
      await waitForRetry(delay);
    }
  }
}
