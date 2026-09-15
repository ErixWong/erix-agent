import { cloneState } from "./budget.js";
import { normalizeMessages } from "./messages.js";
import { throwIfAborted } from "./abort.js";
import { validateMessages } from "../messages/rounds.js";

export async function callProvider(ctx, { allowPendingToolUse = false, round } = {}) {
  let retryIndex = 0;
  let recovered = false;
  while (true) {
    normalizeMessages(ctx.messages);
    validateMessages(ctx.messages, { allowPendingToolUse });
    const requestEstimatedTokens = ctx.estimateMessageTokens(ctx.messages);
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
    ctx.emitEvent({
      type: "attempt",
      round,
      attempt,
      maxAttempts: ctx.retryAttempts + 1,
    });

    const dispatchAttemptEvent = (event, callback) => {
      if (event.type === "usage") {
        ctx.emitEvent({ type: "usage", round, usage: event.usage });
      }
      if (event.type !== "usage" || attemptUsage !== undefined) {
        ctx.roundEventDeltas.push(event);
      }
      try {
        callback();
      } catch (error) {
        ctx.reportObserverError(error);
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
        messages: ctx.messages,
        tools: ctx.tools,
        signal: ctx.signal,
      };
      if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
      if (ctx.temperature !== undefined) request.temperature = ctx.temperature;
      if (ctx.topP !== undefined) request.topP = ctx.topP;
      if (ctx.stream && typeof ctx.provider.chatStream === "function") {
        let response = await ctx.awaitWithAbort(ctx.provider.chatStream({
          ...request,
          onDelta: (chunk) => queueEvent(
            { type: "delta", delta: chunk },
            () => ctx.onDelta?.(chunk),
          ),
          onReasoningDelta: (chunk, metadata) => queueEvent(
            {
              type: "reasoning_delta",
              delta: chunk,
              ...(metadata === undefined ? {} : { metadata }),
            },
            () => ctx.onReasoningDelta?.(chunk, metadata),
          ),
          onToolCall: (fragment) => queueEvent(
            { type: "tool_call", ...fragment },
            () => ctx.onToolCall?.(fragment),
          ),
          onUsage: (reportedUsage) => {
            attemptUsage = reportedUsage;
            queueEvent(
              { type: "usage", usage: reportedUsage },
              () => ctx.onUsage?.(reportedUsage),
            );
          },
        }));
        if (attemptUsage !== undefined && response?.usage === undefined) {
          response = { ...response, usage: attemptUsage };
        }
        if (recovered) ctx.emitEvent({ type: "recovered", round, attempt });
        for (const { event, callback } of attemptEvents) {
          dispatchAttemptEvent(event, callback);
        }
        return {
          response,
          usageEmitted: attemptUsage !== undefined,
          estimatedTokens: requestEstimatedTokens,
        };
      }
      const response = await ctx.awaitWithAbort(ctx.provider.chat(request));
      if (recovered) ctx.emitEvent({ type: "recovered", round, attempt });
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
      ctx.emitEvent({
        type: "recovering",
        round,
        attempt: retryIndex + 1,
        maxAttempts: ctx.retryAttempts + 1,
      });
      await ctx.waitForRetry(delay);
    }
  }
}
