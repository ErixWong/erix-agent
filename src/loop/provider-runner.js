import { cloneState } from "./budget.js";
import { isContinuityMessage } from "./continuity-block.js";
import { normalizeMessages } from "./messages.js";
import { throwIfAborted } from "./abort.js";
import { validateMessages } from "../messages/rounds.js";
import { foldToolResultsForRequest } from "./tool-result-ttl.js";
import { ensureUserTurnView } from "./request-user-view.js";
import { pendingTailToolUses } from "./pending-tool-result.js";
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

/**
 * The **rolling tail** cache breakpoint (issue #192).
 *
 * Why a separate function and not one more line inside `markStablePrefix`: the two marks have
 * different legal inputs. `markStablePrefix` is called on the **final** request view (system +
 * first user + everything the request will carry), and it is also called by the forced wrap-up
 * path. The tail mark must land on the **persistent history tail** — the last message that will
 * still be there in the *next* round's request — and that is a different position: `callProvider`
 * appends per-request blocks (`appendRunStateToRequestView`, the #598 handoff instruction) *after*
 * this point. Marking those instead would be worse than marking nothing: an Anthropic breakpoint
 * caches the prefix up to its block, and a per-request block never recurs at the same position, so
 * every round would pay the 1.25x cache-**write** premium for a prefix no later request can ever
 * read.
 *
 * The forced wrap-up request gets no tail mark at all (same reason, other direction): it is
 * one-shot, so a tail breakpoint there would write the whole history at 1.25x with no future read.
 * Its two static marks already cap the write at the first-user boundary.
 *
 * The continuity block (issue #568) is skipped as a tail candidate even though it is a real message:
 * it is **re-positioned** to the tail every round, so a prefix ending with it never reappears at the
 * same offset. Excluding it is also what makes #568's discipline 2 ("only the messages grown after
 * the last request are invalidated") true at the cache layer rather than only in prose.
 *
 * @param {Array<object>} messages request view whose **last** message is the persistent tail
 * @returns {Array<object>} a new array; the input array and its messages are not mutated
 */
export function markTailCacheBoundary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  let tailIndex = messages.length - 1;
  while (tailIndex >= 0 && isContinuityMessage(messages[tailIndex])) tailIndex -= 1;
  if (tailIndex < 0) return messages;
  const tail = messages[tailIndex];
  if (!isRecord(tail) || tail.cacheBoundary === true) return messages;
  const marked = messages.slice();
  marked[tailIndex] = { ...tail, cacheBoundary: true };
  return marked;
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
    // issue #192（裁决：只做尾部滚动断点）：尾部断点标在**持久历史**的尾巴上，即 run-state /
    // 收尾指令这些「只属于本次请求」的块**追加之前**。位置是判据的一部分：断点缓存的是它之前
    // 的整个前缀，而每轮新建的 run-state 块下一轮不会出现在同一位置 ⇒ 标在它上面等于每轮按
    // 1.25x 写一段永远没人读的前缀（比不打标更贵）。上一轮的尾部断点因此总能命中本轮的前缀，
    // 只有「折叠改写了中段」的那一轮会退回 system / 首条 user 两个静态断点（见 architecture
    // 的缓存小节：这是与 TTL 折叠共存的代价，不是漏做）。
    if (ctx.cacheStablePrefix !== false) {
      requestMessages = markTailCacheBoundary(requestMessages);
    }
    // run-state 只追加到本次请求视图，保留前缀以实现零缓存失效。
    requestMessages = appendRunStateToRequestView(requestMessages, requestStateBlock);
    const estimateMessageTokens = ctx.estimateMessageTokens;
    // issue #292 不变量 I1（请求视图定稿处，chat 与 chatStream 共用下面的 request 对象）：
    // 折叠 / run-state 追加之后、组装 request 之前校验「非空且至少一条真 user 轮」，
    // 回补来源是未折叠的 ctx.messages。放在折叠策略内部只能管住那一层，管不住这里。
    const userTurnGuard = {};
    requestMessages = ensureUserTurnView(requestMessages, ctx.messages, userTurnGuard);
    // issue #598: the handoff instruction rides the **request tail only** (never `ctx.messages`).
    // Why the tail: the same discipline as the continuity block (#568) — the block and this
    // instruction are "per-request small blocks", while touching `mainSystem` would invalidate the
    // prefix reuse of the 100k–200k history that sits after it.
    // Why the `pendingTailToolUses` gate: a request whose tail is an assistant `tool_use` without its
    // `tool_result` must not get another user message wedged in (it would break the pairing the
    // providers enforce). That is the same shape the continuity block refuses to inject into, and
    // the block's own `continuity_injection_skipped` event already accounts for that round.
    // `undefined` (the default, `config.continuity.handoff = "off"`) ⇒ not one byte is added.
    const requestTailInstruction = ctx.requestTailInstruction;
    if (typeof requestTailInstruction === "string"
      && requestTailInstruction !== ""
      && pendingTailToolUses(requestMessages).length === 0) {
      requestMessages = [
        ...requestMessages,
        { role: "user", content: [{ type: "text", text: requestTailInstruction }] },
      ];
    }
    // issue #547 asked "who still reaches this recording branch" and #548 answered it: the one
    // shape that did (a `max_tokens` continuation — `allowPendingToolUse: true`, the only such call
    // site — with a low-budget run-state block appended behind a trailing `assistant[tool_use]`) was
    // **not** a legal shape, it was #548's defect: the append broke the pairing, the guard fell
    // through to `preserved_latest_user_turn` and the whole request context was dropped
    // (`count=1`). #548 made the append skip a dangling tail, so the branch is back to **no
    // behavioural producer**: folding only rewrites `tool_result` bodies and the run-state append
    // now only ever appends behind a legal tail, so neither can make the view illegal or miss user
    // turns the source still has.
    //
    // The branch and the channel name **stay** (removing the name is #547's follow-up decision, not
    // a side effect of removing the producer); the guard's own accounting is still pinned at the unit
    // level (`test/loop-request-user-invariant.test.js` T5) and the wiring here is pinned
    // structurally by `test/loop-547-provider-guard-channel.test.js` T3. What that file's T2/T3 now
    // assert is the current fact: this shape records **nothing** and keeps the full view (T1's four
    // natural shapes + this fifth one are the whole enumeration — no shape reaches this branch).
    // issue #296：`unrecoverable` 这一格以前被**滤掉**（`action !== "unrecoverable"`）——理由是
    // 「守卫什么都没改，就不算一次动作」。代价是**真失败对外零信号**：`unrecoverable` 恰恰不是
    // 「什么都没发生」，而是「视图违反 I1 且源里没有可回补的 user 轮」，接下来发出去的就是一个
    // 没有 user 轮的请求（真上游回 `400 No user query found in messages`），而宿主既拿不到事件、
    // 也看不出终局与守卫有关。
    //
    // 现在的分工：两个**真的改了视图**的动作继续走 `recordUserTurnGuard`（记账形状逐字不变）；
    // `unrecoverable` 走**自己的通道**（`user_turn_guard_unrecoverable` 事件，additive）。
    // 为什么不把它塞进 `compactionStats`：这一格可以在**完全没发生压缩**的一轮触发（宿主给的
    // 初始消息本身就没有 user 轮），往压缩账里写一条 `foldedRounds: 0` 的条目会让「这一轮到底
    // 有没有折叠」变得不可判读，而那是宿主已经在用的口径。
    const userTurnGuardAction = userTurnGuard.action;
    // issue #538 的结构判据（`test/loop-run-stream-538.test.js` U2）：通道名全文件只有**一处**
    // 表达式，由唯一的派生值 `streaming` 决定。两个上报口（真改了视图的两个动作 / #296 的
    // `unrecoverable`）共用这一处——多写一份就是把「通道名怎么来的」又分叉一次。
    const guardChannel = { channel: streaming ? "chatStream" : "chat" };
    if (userTurnGuardAction === "unrecoverable") {
      ctx.recordUserTurnUnrecoverable?.({
        ...guardChannel,
        round,
        reason: userTurnGuard.reason,
      });
    } else if (userTurnGuardAction !== undefined) {
      ctx.recordUserTurnGuard?.({
        ...guardChannel,
        round,
        action: userTurnGuardAction,
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
