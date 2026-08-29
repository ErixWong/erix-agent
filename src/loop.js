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

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the minimum tool-calling loop against an injected provider.
 *
 * @param {{
 *   provider: {chat: (request: object) => Promise<object>},
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

  const addUsage = (response) => {
    if (Number.isFinite(response?.usage?.input_tokens)) {
      usage.input_tokens += response.usage.input_tokens;
    }
    if (Number.isFinite(response?.usage?.output_tokens)) {
      usage.output_tokens += response.usage.output_tokens;
    }
  };

  const callProvider = async () => {
    let retryIndex = 0;
    while (true) {
      normalizeMessages(messages);
      const snapshotLen = messages.length;
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
        return await provider.chat(request);
      } catch (error) {
        if (retryOptions === null || error?.retryable !== true) {
          throw error;
        }
        messages.length = snapshotLen;
        if (retryIndex >= retryAttempts) throw error;
        const delay = Math.min(backoffBaseMs * (2 ** retryIndex), backoffMaxMs);
        retryIndex += 1;
        await sleepImpl(delay);
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
    const compaction = await compactBeforeRound();
    const roundStart = messages.length;
    let response = await callProvider();
    let content = blocksFor(response?.content);

    messages.push({ role: "assistant", content });
    addUsage(response);

    let tokenContinuationCount = 0;
    while (response?.stopReason === "max_tokens"
      && tokenContinuationCount < continuationLimit) {
      tokenContinuationCount += 1;
      response = await callProvider();
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
    if (!shouldContinue) return finish(false);
  }

  return finish(true);
}
