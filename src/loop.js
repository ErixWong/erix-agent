import { validateMessages } from "./messages/rounds.js";

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function toolResultContent(result) {
  return typeof result === "string" ? result : String(result);
}

function normalizeMessages(messages) {
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous?.role !== "assistant" || current?.role !== "assistant") continue;

    messages[index - 1] = {
      ...previous,
      content: [
        ...blocksFor(previous.content),
        ...blocksFor(current.content),
      ],
    };
    messages.splice(index, 1);
    index -= 1;
  }
  return messages;
}

function appendAssistantContent(existing, continuation) {
  const combined = blocksFor(existing).map((block) => ({ ...block }));
  for (const block of continuation) {
    const previous = combined.at(-1);
    if (block?.type === "text" && previous?.type === "text") {
      previous.text = `${String(previous.text ?? "")}${String(block.text ?? "")}`;
    } else {
      combined.push(block);
    }
  }
  return combined;
}

function hasToolUse(content) {
  return content.some((block) => block?.type === "tool_use");
}

function hasToolUseInMessages(messages) {
  return messages.some((message) => hasToolUse(blocksFor(message?.content)));
}

function stallError(signature) {
  const error = new Error(`Tool loop stalled on repeated call: ${signature}`);
  error.code = "llm_kit_stalled";
  return error;
}

function cloneState(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason === undefined
    ? "The operation was aborted"
    : String(signal.reason));
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw abortError(signal);
}

function defaultSleep(ms, signal) {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * @typedef {object} LoopEvent
 * @property {"round_start"|"attempt"|"recovering"|"recovered"|"usage"|"tool_use"|"tool_result"|"round_end"} type
 * @property {number} [round]
 * @property {number} [attempt] 1-based provider attempt within the round.
 * @property {number} [maxAttempts] Retry count plus the initial attempt.
 * @property {object} [usage] Provider usage reported after a successful call.
 * @property {object} [toolUse] Completed canonical tool_use block.
 * @property {object} [toolResult] Canonical tool_result block.
 * @property {string} [finalText] Text accumulated at round end.
 * @property {string} [stopReason] Canonical provider stop reason.
 */

/**
 * Run the minimum tool-calling loop against an injected provider.
 *
 * @param {{
 *   provider: {chat: (request: object) => Promise<object>, chatStream?: (request: object) => Promise<object>},
 *   system?: string,
 *   initialUserMessage?: string,
 *   initialMessages?: object[],
 *   tools?: object[],
 *   executeTool: (name:string, input:object) => Promise<string>,
 *   maxRounds?: number,
 *   maxTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   stallDetection?: {window?:number}|false,
 *   retry?: {attempts?:number, backoffBaseMs?:number, backoffMaxMs?:number,
 *     sleepImpl?:(ms:number)=>Promise<void>}|false,
 *   completion?: {signals?:string[], maxNoToolRounds?:number}|false,
 *   maxTokenContinuations?: number,
 *   context?: {strategy?: object, budgetTokens?:number, keepRounds?:number},
 *   store?: {appendRound?: Function},
 *   runId?: string,
 *   resume?: boolean,
 *   onRound?: Function,
 *   onToolResult?: Function,
 *   signal?: AbortSignal,
 *   stream?: boolean,
 *   onDelta?: (chunk:string) => void,
 *   onReasoningDelta?: (chunk:string) => void,
 *   onToolCall?: (fragment:object) => void,
 *   onUsage?: (usage:object) => void,
 *   onEvent?: (event:LoopEvent) => void,
 * }} options
 * @returns {Promise<{
 *   finalText:string,
 *   messages:object[],
 *   transcript:object[],
 *   rounds:number,
 *   truncated:boolean,
 *   usage:{input_tokens:number, output_tokens:number},
 *   compactionStats:{compacted:boolean, foldedRounds:number, tokensBefore:number, tokensAfter:number}[]
 * }>}
 */
export async function runToolLoop({
  provider,
  system,
  initialUserMessage,
  initialMessages,
  tools = [],
  executeTool,
  maxRounds = 8,
  maxTokens,
  temperature,
  topP,
  stallDetection = { window: 4 },
  retry = false,
  completion = false,
  maxTokenContinuations = 3,
  context,
  store,
  runId,
  resume = false,
  onRound,
  onToolResult,
  signal,
  stream = false,
  onDelta,
  onReasoningDelta,
  onToolCall,
  onUsage,
  onEvent,
}) {
  let messages = initialMessages !== undefined
    ? [...initialMessages]
    : initialUserMessage !== undefined
      ? [{ role: "user", content: [{ type: "text", text: initialUserMessage }] }]
      : [];
  let rounds = 0;
  if (resume && store && runId !== undefined) {
    const records = await store.load(runId);
    if (records.length === 0) throw new Error("resume: 无可恢复记录");
    messages = records.flatMap((record) => record.messages);
    // 以最大 round 为续跑基数（含 round 0 种子记录时 records.length 会多算一轮）
    rounds = Math.max(...records.map((record) => record.round ?? 0));
  } else if (store && runId !== undefined && messages.length > 0) {
    // 种子记录：初始消息（initialMessages/initialUserMessage）先入档，
    // 否则它们永不在 store 中——recall 在 fold 后找不到被折的初始历史（ADR-002 档案完整性）
    try {
      await store.appendRound(runId, { round: 0, messages: [...messages], ts: new Date().toISOString() });
    } catch {
      // 快照容错：持久化失败不中断循环（与轮内快照一致）
    }
  }
  const recentSignatures = [];
  const stallWindow = stallDetection === false
    ? 0
    : Number.isInteger(stallDetection?.window) && stallDetection.window > 0
      ? stallDetection.window
      : 4;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const retryOptions = retry && typeof retry === "object" ? retry : null;
  const retryAttempts = Number.isInteger(retryOptions?.attempts)
    ? Math.max(0, retryOptions.attempts)
    : 2;
  const backoffBaseMs = Number.isFinite(retryOptions?.backoffBaseMs)
    ? Math.max(0, retryOptions.backoffBaseMs)
    : 1500;
  const backoffMaxMs = Number.isFinite(retryOptions?.backoffMaxMs)
    ? Math.max(0, retryOptions.backoffMaxMs)
    : 10000;
  const sleepImpl = retryOptions?.sleepImpl ?? defaultSleep;
  const completionEnabled = completion !== false;
  const completionSignals = Array.isArray(completion?.signals) ? completion.signals : [];
  const maxNoToolRounds = Number.isInteger(completion?.maxNoToolRounds)
    ? Math.max(0, completion.maxNoToolRounds)
    : 3;
  const continuationLimit = Number.isInteger(maxTokenContinuations)
    ? Math.max(0, maxTokenContinuations)
    : 3;
  const compactionStats = [];
  let finalText = "";
  let hadToolUse = hasToolUseInMessages(messages);
  let noToolRounds = 0;
  let roundStopReason;
  let roundEventDeltas = [];

  const emitEvent = (event) => {
    onEvent?.(event);
  };

  const addUsage = (response) => {
    if (Number.isFinite(response?.usage?.input_tokens)) {
      usage.input_tokens += response.usage.input_tokens;
    }
    if (Number.isFinite(response?.usage?.output_tokens)) {
      usage.output_tokens += response.usage.output_tokens;
    }
  };

  const awaitWithAbort = async (promise) => {
    if (!signal) return promise;
    throwIfAborted(signal);
    let removeAbortListener;
    const aborted = new Promise((_, reject) => {
      const onAbort = () => reject(abortError(signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      removeAbortListener?.();
    }
  };

  const waitForRetry = async (delay) => {
    const sleeping = Promise.resolve().then(() => sleepImpl(delay, signal));
    await awaitWithAbort(sleeping);
    throwIfAborted(signal);
  };

  const callProvider = async ({ allowPendingToolUse = false, round } = {}) => {
    let retryIndex = 0;
    let recovered = false;
    while (true) {
      normalizeMessages(messages);
      validateMessages(messages, { allowPendingToolUse });
      const snapshot = {
        messages: cloneState(messages),
        eventDeltas: [...roundEventDeltas],
        finalText,
        usage: { ...usage },
        stopReason: roundStopReason,
      };
      const attempt = retryIndex + 1;
      const attemptEvents = [];
      let attemptUsage;
      emitEvent({
        type: "attempt",
        round,
        attempt,
        maxAttempts: retryAttempts + 1,
      });

      const queueEvent = (event, callback) => {
        attemptEvents.push({ event, callback });
      };
      try {
        const request = {
          system,
          messages,
          tools,
          signal,
        };
        if (maxTokens !== undefined) request.maxTokens = maxTokens;
        if (temperature !== undefined) request.temperature = temperature;
        if (topP !== undefined) request.topP = topP;
        if (stream && typeof provider.chatStream === "function") {
          let response = await awaitWithAbort(provider.chatStream({
            ...request,
            onDelta: (chunk) => queueEvent(
              { type: "delta", delta: chunk },
              () => onDelta?.(chunk),
            ),
            onReasoningDelta: (chunk, metadata) => queueEvent(
              {
                type: "reasoning_delta",
                delta: chunk,
                ...(metadata === undefined ? {} : { metadata }),
              },
              () => onReasoningDelta?.(chunk, metadata),
            ),
            onToolCall: (fragment) => queueEvent(
              { type: "tool_call", ...fragment },
              () => onToolCall?.(fragment),
            ),
            onUsage: (reportedUsage) => {
              attemptUsage = reportedUsage;
              queueEvent(
                { type: "usage", usage: reportedUsage },
                () => onUsage?.(reportedUsage),
              );
            },
          }));
          if (attemptUsage !== undefined && response?.usage === undefined) {
            response = { ...response, usage: attemptUsage };
          }
          if (recovered) emitEvent({ type: "recovered", round, attempt });
          for (const { event, callback } of attemptEvents) {
            callback();
            if (event.type === "usage") {
              emitEvent({ type: "usage", round, usage: event.usage });
            }
            if (event.type !== "usage" || attemptUsage !== undefined) {
              roundEventDeltas.push(event);
            }
          }
          return { response, usageEmitted: attemptUsage !== undefined };
        }
        const response = await awaitWithAbort(provider.chat(request));
        if (recovered) emitEvent({ type: "recovered", round, attempt });
        return { response, usageEmitted: false };
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        if (retryOptions === null || error?.retryable !== true) {
          throw error;
        }
        messages = cloneState(snapshot.messages);
        roundEventDeltas = [...snapshot.eventDeltas];
        finalText = snapshot.finalText;
        usage.input_tokens = snapshot.usage.input_tokens;
        usage.output_tokens = snapshot.usage.output_tokens;
        roundStopReason = snapshot.stopReason;
        if (retryIndex >= retryAttempts) throw error;
        const delay = Math.min(backoffBaseMs * (2 ** retryIndex), backoffMaxMs);
        retryIndex += 1;
        recovered = true;
        emitEvent({
          type: "recovering",
          round,
          attempt: retryIndex + 1,
          maxAttempts: retryAttempts + 1,
        });
        await waitForRetry(delay);
      }
    }
  };

  const compactBeforeRound = async () => {
    normalizeMessages(messages);
    const strategy = context?.strategy;
    if (strategy && await strategy.shouldCompact(messages, context.budgetTokens)) {
      const result = await strategy.compact(messages, {
        keepRounds: context.keepRounds ?? 6,
        budgetTokens: context.budgetTokens,
      });
      if (!Array.isArray(result?.messages)) {
        throw new TypeError("Compaction strategy must return a messages array");
      }
      messages = result.messages;
      hadToolUse = hadToolUse || hasToolUseInMessages(messages);
      compactionStats.push({
        compacted: result.compacted,
        foldedRounds: result.foldedRounds,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
      normalizeMessages(messages);
      return {
        folded: result.compacted === true,
        foldedPayload: result.compacted === true ? result.foldedPayload : undefined,
      };
    }
    return { folded: false, foldedPayload: undefined };
  };

  const finish = (truncated) => ({
    finalText,
    messages,
    transcript: [...messages],
    rounds,
    truncated,
    usage,
    compactionStats,
  });

  while (rounds < maxRounds) {
    const round = rounds + 1;
    roundEventDeltas = [];
    roundStopReason = undefined;
    emitEvent({ type: "round_start", round });
    const compaction = await compactBeforeRound();
    const roundStart = messages.length;
    let providerResult = await callProvider({ round });
    let response = providerResult.response;
    let content = blocksFor(response?.content);

    messages.push({ role: "assistant", content });
    addUsage(response);
    if (!providerResult.usageEmitted && response?.usage !== undefined) {
      emitEvent({ type: "usage", round, usage: response.usage });
    }
    roundStopReason = response?.stopReason;

    let tokenContinuationCount = 0;
    while (response?.stopReason === "max_tokens"
      && tokenContinuationCount < continuationLimit) {
      tokenContinuationCount += 1;
      providerResult = await callProvider({ allowPendingToolUse: true, round });
      response = providerResult.response;
      const continuation = blocksFor(response?.content);
      const assistant = messages.at(-1);
      if (assistant?.role === "assistant") {
        assistant.content = appendAssistantContent(assistant.content, continuation);
        content = appendAssistantContent(content, continuation);
      } else {
        content = appendAssistantContent(content, continuation);
        messages.push({ role: "assistant", content });
      }
      addUsage(response);
      if (!providerResult.usageEmitted && response?.usage !== undefined) {
        emitEvent({ type: "usage", round, usage: response.usage });
      }
      roundStopReason = response?.stopReason;
    }
    finalText = textFromBlocks(content);

    if (hasToolUse(content)) {
      hadToolUse = true;
      noToolRounds = 0;
    }

    if (response?.stopReason === "tool_use") {
      const toolResults = [];
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        emitEvent({ type: "tool_use", round, toolUse: cloneState(block) });

        const signature = `${block.name}${JSON.stringify(block.input)}`;
        if (stallWindow > 0
          && recentSignatures.length >= stallWindow
          && recentSignatures.includes(signature)) {
          throw stallError(signature);
        }
        if (stallWindow > 0) {
          recentSignatures.push(signature);
          if (recentSignatures.length > stallWindow) recentSignatures.shift();
        }

        let result;
        let isError = false;
        try {
          result = await executeTool(block.name, block.input);
        } catch (error) {
          isError = true;
          result = String(error?.message ?? error);
        }
        if (onToolResult) {
          result = await onToolResult(block.name, result);
        }

        const toolResult = {
          type: "tool_result",
          tool_use_id: block.id,
          content: toolResultContent(result),
        };
        if (isError) toolResult.is_error = true;
        toolResults.push(toolResult);
        emitEvent({ type: "tool_result", round, toolResult: cloneState(toolResult) });
      }
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }
    }

    let shouldContinue = response?.stopReason === "tool_use";
    if (!hasToolUse(content) && completionEnabled) {
      const hasSignal = completionSignals.some(
        (completionSignal) => typeof completionSignal === "string"
          && finalText.includes(completionSignal),
      );
      if (!hasSignal && hadToolUse) {
        noToolRounds += 1;
        if (noToolRounds < maxNoToolRounds) {
          messages.push({
            role: "user",
            content: [{ type: "text", text: "（请继续完成任务）" }],
          });
          shouldContinue = true;
        } else {
          shouldContinue = false;
        }
      } else {
        shouldContinue = false;
      }
    }

    const record = {
      round,
      messages: messages.slice(roundStart),
      ts: new Date().toISOString(),
    };
    if (compaction.folded) {
      record.folded = true;
      if (compaction.foldedPayload !== undefined) {
        record.foldedPayload = compaction.foldedPayload;
      }
    }
    if (typeof store?.appendRound === "function") {
      try {
        await store.appendRound(runId, record);
      } catch {
        // Transcript persistence is best effort and must not stop the loop.
      }
    }
    if (onRound) await onRound(record);

    rounds = round;
    emitEvent({
      type: "round_end",
      round,
      finalText,
      stopReason: roundStopReason,
      usage: { ...usage },
    });
    if (!shouldContinue) return finish(false);
  }

  return finish(true);
}
