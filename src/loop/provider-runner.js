import { cloneState } from "./budget.js";
import { normalizeMessages } from "./messages.js";
import { throwIfAborted } from "./abort.js";
import { validateMessages } from "../messages/rounds.js";
import { foldToolResultsForRequest } from "./tool-result-ttl.js";
import { ensureUserTurnView } from "./request-user-view.js";
import { appendRunStateToRequestView } from "../run-state.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The **one** derived "is this run streaming" value (issue #538).
 *
 * The bug this replaces: the run switch was read in two places with two different truthiness tests —
 * the channel label said `ctx.stream === true` while the branch that picks the provider method said
 * `ctx.stream &&` (truthy). A host writing `stream: 1` therefore got a **self-contradictory run**: the
 * recorded channel claimed `chat` while the engine actually called `chatStream`. Both readings are
 * now the same derived boolean, so they cannot disagree even in principle — and the value rule
 * (`CONFIG_LEAF_VALUE_RULES["run.stream"]`, `src/loop/config-namespace.js`) refuses every
 * non-boolean at intake, so a host never gets to observe which of the two readings would have won.
 *
 * Not "unify on truthiness": that would make `stream: "yes"` actually stream (the disagreement would
 * just move). The rule is boolean-only, and this function is the single place that turns the boolean
 * into a channel decision.
 *
 * The one shape that is not a choice: a provider implementing **only** `chatStream` has no batch
 * channel to fall back to, so it streams whatever the switch says (the previous behaviour, kept).
 *
 * @param {{provider: {chat?: Function, chatStream?: Function}, stream?: boolean}} ctx
 * @returns {boolean}
 */
function streamsThisRun(ctx) {
  const hasChat = typeof ctx.provider.chat === "function";
  const hasChatStream = typeof ctx.provider.chatStream === "function";
  if (!hasChat) return hasChatStream;
  return ctx.stream === true && hasChatStream;
}

function markSystemCacheBoundary(system) {
  if (system === undefined || system === null) return system;
  if (isRecord(system) && Object.hasOwn(system, "content")) {
    return { ...system, cacheBoundary: true };
  }
  return { content: system, cacheBoundary: true };
}

export function markStablePrefix(system, messages) {
  let firstUserMarked = false;
  const markedMessages = messages.map((message) => {
    if (firstUserMarked || message?.role !== "user") return message;
    firstUserMarked = true;
    return { ...message, cacheBoundary: true };
  });
  return {
    system: markSystemCacheBoundary(system),
    messages: markedMessages,
  };
}

export async function callProvider(ctx, {
  allowPendingToolUse = false,
  round,
  requestStateBlock,
  // 预算兜底（2026-09-20 基准：撞 64 轮截断 + wrapup 全量重发历史多花 4 分钟）：
  // 最后一轮省略 tools，强制模型输出文本终稿。OpenAI/Anthropic 两协议均允许无 tools 请求。
  omitTools = false,
} = {}) {
  let retryIndex = 0;
  let recovered = false;
  // issue #538: computed **once** per call and used by both sites below (the channel label and the
  // provider-method branch). One value, one answer: the two cannot fork.
  const streaming = streamsThisRun(ctx);
  while (true) {
    normalizeMessages(ctx.messages);
    validateMessages(ctx.messages, { allowPendingToolUse });
    // TTL 折叠（issue #35）：只替换请求视图，ctx.messages 本身不动（run snapshot 仍存全文）。
    // toolResultFold 是 orchestrator 的配置 getter（含终稿保护口径），每次 attempt 重新读取；
    // null/undefined = 本轮不折叠。
    const foldConfig = ctx.toolResultFold ?? null;
    const ttlStats = {};
    let requestMessages = foldConfig === null || foldConfig === undefined
      ? ctx.messages
      : foldToolResultsForRequest(ctx.messages, {
        currentRound: round,
        ttl: foldConfig.ttl,
        minTokens: foldConfig.minTokens,
        stats: ttlStats,
      });
    // run-state 只追加到本次请求视图，保留前缀以实现零缓存失效。
    requestMessages = appendRunStateToRequestView(requestMessages, requestStateBlock);
    const estimateMessageTokens = ctx.estimateMessageTokens;
    // issue #292 不变量 I1（请求视图定稿处，chat 与 chatStream 共用下面的 request 对象）：
    // 折叠 / run-state 追加之后、组装 request 之前校验「非空且至少一条真 user 轮」，
    // 回补来源是未折叠的 ctx.messages。放在折叠策略内部只能管住那一层，管不住这里。
    const userTurnGuard = {};
    requestMessages = ensureUserTurnView(requestMessages, ctx.messages, userTurnGuard);
    if (userTurnGuard.action !== undefined && userTurnGuard.action !== "unrecoverable") {
      ctx.recordUserTurnGuard?.({
        round,
        action: userTurnGuard.action,
        channel: streaming ? "chatStream" : "chat",
        tokensBefore: estimateMessageTokens(ctx.messages),
        tokensAfter: estimateMessageTokens(requestMessages),
      });
    }
    const requestEstimatedTokens = estimateMessageTokens(requestMessages);
    if (ttlStats.foldedCount > 0) {
      await ctx.recordCompactionLayer?.({
        layerId: "ttl",
        round,
        triggered: ttlStats.foldedCount,
        tokensBefore: estimateMessageTokens(ctx.messages),
        tokensAfter: requestEstimatedTokens,
        // issue #326（wo-C）：除了计数还要逐条上报「这条工具结果被降级成了什么」，由引擎随轮记录入账。
        degradations: Array.isArray(ttlStats.degradations) ? ttlStats.degradations : [],
      });
    }
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
    // 新 attempt = 新一批 provider id：身份键注册表同步换新（上一轮被丢弃的调用不与本轮共用 key）。
    ctx.beginToolCallAttempt?.();
    const attemptEvents = [];
    let attemptUsage;
    const emitEvent = ctx.emitEvent;
    emitEvent({
      type: "attempt",
      round,
      attempt,
      maxAttempts: ctx.retryAttempts + 1,
    });

    // issue #173 PR-B：流式观察者（onDelta/onReasoningDelta/onToolCall/onUsage）的抛错原本就走
    // reportObserverError 隔离，语义不回退；这里只是给它们补上**自己的通道名**上下文（与新增的
    // onEvent/onRound/onToolResult/onJudge 同一口径），宿主能直接按 channel 分流。
    const dispatchAttemptEvent = (event, callback, observerChannel = "unknown") => {
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
        reportObserverError(error, { channel: observerChannel, round, type: event.type });
      }
    };
    const queueEvent = (event, callback, observerChannel) => {
      if (ctx.retryAttempts === 0) {
        dispatchAttemptEvent(event, callback, observerChannel);
        return;
      }
      attemptEvents.push({ event, callback, observerChannel });
    };
    try {
      const stablePrefix = ctx.cacheStablePrefix !== false
        ? markStablePrefix(ctx.mainSystem, requestMessages)
        : { system: ctx.mainSystem, messages: requestMessages };
      const request = {
        system: stablePrefix.system,
        messages: stablePrefix.messages,
        signal: ctx.signal,
      };
      if (omitTools !== true) request.tools = ctx.tools;
      if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;
      if (ctx.temperature !== undefined) request.temperature = ctx.temperature;
      if (ctx.topP !== undefined) request.topP = ctx.topP;
      if (streaming) {
        const awaitWithAbort = ctx.awaitWithAbort;
        let response = await awaitWithAbort(ctx.provider.chatStream({
          ...request,
          onDelta: (chunk) => {
            if (ctx.onPartialDelta !== undefined) ctx.onPartialDelta(chunk, round);
            queueEvent(
              { type: "delta", delta: chunk },
              () => {
                const onDelta = ctx.onDelta;
                onDelta?.(chunk);
              },
              "onDelta",
            );
          },
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
            "onReasoningDelta",
          ),
          onToolCall: (rawFragment) => {
            // 跳通道身份键（工单 261014 T1 / issue #284）：宿主在流式阶段就能建卡，
            // 且 `tool_use` 事件到达时是同一张卡—— fragment 上的 key 与块上的 `erix.toolCallKey` 同值。
            const toolCallKey = ctx.toolCallKeyForFragment?.(rawFragment);
            const fragment = toolCallKey === undefined
              ? rawFragment
              : { ...rawFragment, toolCallKey };
            queueEvent(
              { type: "tool_call", ...fragment },
              () => {
                const onToolCall = ctx.onToolCall;
                onToolCall?.(fragment);
              },
              "onToolCall",
            );
          },
          onUsage: (reportedUsage) => {
            attemptUsage = reportedUsage;
            queueEvent(
              { type: "usage", usage: reportedUsage },
              () => {
                const onUsage = ctx.onUsage;
                onUsage?.(reportedUsage);
              },
              "onUsage",
            );
          },
        }));
        if (ctx.onPartialAttemptEnd !== undefined) {
          await ctx.onPartialAttemptEnd({ round, retrying: false });
        }
        if (attemptUsage !== undefined && response?.usage === undefined) {
          response = { ...response, usage: attemptUsage };
        }
        if (recovered) {
          const emitEvent = ctx.emitEvent;
          emitEvent({ type: "recovered", round, attempt });
        }
        for (const { event, callback, observerChannel } of attemptEvents) {
          dispatchAttemptEvent(event, callback, observerChannel);
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
      if (ctx.signal?.aborted) {
        if (ctx.onPartialAttemptEnd !== undefined) {
          await ctx.onPartialAttemptEnd({ round, retrying: false });
        }
        throwIfAborted(ctx.signal);
      }
      if (ctx.retryOptions === null || error?.retryable !== true) {
        if (ctx.onPartialAttemptEnd !== undefined) {
          await ctx.onPartialAttemptEnd({ round, retrying: false });
        }
        throw error;
      }
      ctx.messages = cloneState(snapshot.messages);
      ctx.roundEventDeltas = [...snapshot.eventDeltas];
      ctx.finalText = snapshot.finalText;
      ctx.usage.input_tokens = snapshot.usage.input_tokens;
      ctx.usage.output_tokens = snapshot.usage.output_tokens;
      for (const key of ["cacheRead", "cacheWrite"]) {
        if (snapshot.usage[key] === undefined) delete ctx.usage[key];
        else ctx.usage[key] = snapshot.usage[key];
      }
      ctx.latestApiInputTokens = snapshot.latestApiInputTokens;
      ctx.latestApiEstimatedTokens = snapshot.latestApiEstimatedTokens;
      ctx.roundStopReason = snapshot.stopReason;
      if (retryIndex >= ctx.retryAttempts) {
        if (ctx.onPartialAttemptEnd !== undefined) {
          await ctx.onPartialAttemptEnd({ round, retrying: false });
        }
        throw error;
      }
      if (ctx.onPartialAttemptEnd !== undefined) {
        await ctx.onPartialAttemptEnd({ round, retrying: true });
      }
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
