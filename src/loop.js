import { KitError } from "./providers/errors.js";
import { computeBudget } from "./compact/budget.js";
import { createSlidingWindowStrategy } from "./compact/sliding-window.js";
import { enforceSize } from "./compact/enforce-size.js";
import { estimateMessageTokens, estimateTokens } from "./tokens.js";
import { groupIntoRounds, validateMessages } from "./messages/rounds.js";
import { decideRoundAction, decideWithEvaluation } from "./reflection/governor.js";
import { extractL0Facts, parseL1Summary } from "./reflection/l0.js";
import { tryParseWrapupJson, normalizeWrapupWithLlm } from "./reflection/wrapup.js";
import {
  buildJudgePrompt,
  buildTimeline,
  parseJudgeDecision,
} from "./reflection/judge.js";

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

function numberOr(value) {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the deliberately small reflection response without requiring a
 * perfectly formatted provider response.
 */
export function parseReflectionDecision(text) {
  const value = String(text ?? "");
  const jsonMatch = value.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        progress: numberOr(parsed.progress),
        stalled: parsed.stalled === true,
        continueFlag: parsed.continue === true || parsed["continue"] === true,
        stallPattern: String(parsed.stallPattern ?? ""),
        reason: String(parsed.reason ?? ""),
        plan: String(parsed.plan ?? ""),
      };
    } catch {
      // Fall through to the text interpretation below.
    }

  }

  return {
    progress: undefined,
    stalled: /打转|重复|无进展|stalled/i.test(value),
    continueFlag: /继续|值得|continue/i.test(value)
      && !/不值得|放弃|停止/i.test(value),
    stallPattern: "",
    reason: value.slice(0, 200),
    plan: "",
  };
}

function textFromUserMessage(message) {
  return textFromBlocks(blocksFor(message?.content));
}

function taskBriefFromMessages(messages) {
  const firstUserText = messages
    .filter((message) => message?.role === "user")
    .map(textFromUserMessage)
    .find((text) => text.trim() !== "");
  return Array.from(firstUserText ?? "").slice(0, 500).join("");
}

const WRAPUP_INSTRUCTION = `任务完成或需要给出结论时（不再调用工具），输出 JSON（不要输出其他文本）：
{"done":true,"summary":"任务总结","output":"给用户的结果"}
若任务尚未完成但需要阶段性说明，可输出 {"done":false,"summary":"当前进展"}。
继续工作时直接调用工具。`;

function reflectionPrompt({ rounds, taskBrief, runningLog, l0Facts, errorText }) {
  return `【进度反思】你是严格的独立评审者，不是执行者。请根据客观事实判断是否值得继续：

任务原始目标：${taskBrief || "（未提供）"}
已运行轮数：${rounds}
L0 客观事实链：${JSON.stringify(l0Facts).slice(0, 4000)}
L1 增量日志链：${JSON.stringify(runningLog).slice(0, 4000)}
最近 distinct 错误摘录：${errorText || "无"}

只输出 JSON（不要其他文字）：
{"progress":0-100,"stalled":true/false,"continue":true/false,"stallPattern":"描述或空","reason":"一句话","plan":"下一步具体动作"}`;
}

// 失忆检测：模型输出欢迎语（误以为新会话/没任务）时，注入任务提醒拉回主线
function isLikelyWelcomeResponse(text) {
  const value = String(text ?? "").trim();
  return /^(?:你好|嗨|hello)\s*[!！,，。.]?\s*(?:我是|i\s*(?:am|'m))[\s\S]*(?:助手|assistant)/iu.test(value)
    || /(?:看起来|好像|似乎)[\s\S]{0,40}(?:没有|未)[\s\S]{0,20}(?:输入|收到)[\s\S]{0,20}(?:具体)?(?:任务|task)/iu.test(value)
    || /请[\s\S]{0,10}(?:告诉|输入|描述)[\s\S]{0,10}(?:我)?[\s\S]{0,20}(?:做什么|任务|task)/iu.test(value);
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

function hasSuccessfulToolResult(messages) {
  return messages.some((message) => blocksFor(message?.content).some((block) => (
    block?.type === "tool_result"
      && block?.is_error !== true
      && block?.success !== false
  )));
}

function stallError(signature) {
  const error = new Error(`Tool loop stalled on repeated call: ${signature}`);
  error.code = "llm_kit_stalled";
  return error;
}

const TRUNCATED_TERMINATION_REASONS = new Set([
  "max_rounds_cap",
  "continuation_exhausted",
]);

function makeTermination(reason, detail) {
  return {
    reason,
    ...(detail === undefined ? {} : { detail: String(detail) }),
  };
}

function terminationDetailForError(error) {
  return error?.message === undefined ? String(error) : String(error.message);
}

function annotateTermination(error, termination) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    error.termination = termination;
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.cause = error;
  wrapped.termination = termination;
  return wrapped;
}

function terminationReasonForAction(action, continuationExhausted) {
  if (action?.value === "judge_done") return "judge_done";
  if (continuationExhausted) return "continuation_exhausted";
  if (action?.value === "noTool") return "no_tool";
  if (action?.value === "cap") return "max_rounds_cap";
  if (action?.value === "reflection-stop") return "reflection_stop";
  return "end_turn";
}

function cloneState(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isProtectedMessage(message, guard) {
  if (typeof guard === "function") return guard(message) === true;
  if (typeof guard === "string") return message?.role === guard;
  if (Array.isArray(guard)) return guard.includes(message?.role);
  return false;
}

function validateBudget(budgetTokens) {
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new KitError(
      "invalid_budget",
      `budgetTokens must be a positive integer (got ${String(budgetTokens)})`,
      { retryable: false },
    );
  }
  return budgetTokens;
}

function isApiInputOverBudget(apiInputTokens, budgetTokens) {
  return budgetTokens !== undefined
    && Number.isFinite(apiInputTokens)
    && apiInputTokens > budgetTokens;
}

function projectedApiInputTokens(apiInputTokens, estimatedBefore, estimatedAfter) {
  if (
    !Number.isFinite(apiInputTokens)
    || apiInputTokens <= 0
    || !Number.isFinite(estimatedBefore)
    || estimatedBefore <= 0
  ) {
    return undefined;
  }
  return Math.ceil(apiInputTokens * estimatedAfter / estimatedBefore);
}

function modelMetadataFor({ modelConfig, modelMetadata, model, provider, context }) {
  const candidates = [modelConfig, modelMetadata, model, provider, context];
  return candidates.find((candidate) => (
    candidate
    && typeof candidate === "object"
    && (
      candidate.contextWindowTokens !== undefined
      || candidate.maxOutputTokens !== undefined
    )
  ));
}

function toolContextFor({
  toolContext,
  context,
  expert,
  user,
  task,
  session,
  requestId,
}) {
  const result = {
    ...(context?.toolContext && typeof context.toolContext === "object"
      ? context.toolContext
      : {}),
    ...(toolContext && typeof toolContext === "object" ? toolContext : {}),
  };
  for (const [key, value] of Object.entries({
    expert: expert !== undefined ? expert : context?.expert,
    user: user !== undefined ? user : context?.user,
    task: task !== undefined ? task : context?.task,
    session: session !== undefined ? session : context?.session,
    requestId: requestId !== undefined ? requestId : context?.requestId,
  })) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function toolResultData(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "data")
    ? value
    : undefined;
}

function truncateTextToBudget(text, budgetTokens) {
  const value = String(text ?? "");
  if (estimateTokens(value) <= budgetTokens) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function dropOldestUnprotectedRound(messages, protectedMessage) {
  const { head, rounds } = groupIntoRounds(messages);
  const index = rounds.findIndex((round) => !round.messages.some((message) => (
    isProtectedMessage(message, protectedMessage)
  )));
  if (index < 0) return false;
  const start = head.length + rounds
    .slice(0, index)
    .reduce((total, round) => total + round.messages.length, 0);
  const count = rounds[index].messages.length;
  messages.splice(start, count);
  return true;
}

function safeTruncateMessages(messages, budgetTokens, protectedMessage) {
  const result = cloneState(messages);
  while (estimateMessageTokens(result) > budgetTokens
    && dropOldestUnprotectedRound(result, protectedMessage)) {
    // Remove complete rounds before reducing individual message content.
  }

  const fields = [];
  const references = [];
  result.forEach((message, messageIndex) => {
    const protectedMessageValue = isProtectedMessage(message, protectedMessage);
    if (typeof message.content === "string") {
      fields.push({
        key: `message-${messageIndex}`,
        text: message.content,
        priority: protectedMessageValue ? Number.MAX_SAFE_INTEGER : messageIndex,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex: undefined,
      });
      return;
    }
    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      let text;
      let kind;
      if (block?.type === "text" || block?.type === "reasoning") {
        text = block.text;
        kind = "text";
      } else if (block?.type === "tool_result") {
        text = block.content;
        kind = "content";
      }
      if (text === undefined) continue;
      fields.push({
        key: `message-${messageIndex}-block-${blockIndex}`,
        text: String(text),
        priority: protectedMessageValue ? Number.MAX_SAFE_INTEGER : messageIndex,
      });
      references.push({
        fieldIndex: fields.length - 1,
        messageIndex,
        blockIndex,
        kind,
      });
    }
  });
  const enforced = enforceSize(fields, budgetTokens);
  for (const reference of references) {
    const text = enforced.fields[reference.fieldIndex].text;
    if (reference.blockIndex === undefined) {
      result[reference.messageIndex].content = truncateTextToBudget(
        text,
        budgetTokens,
      );
    } else if (reference.kind === "text") {
      result[reference.messageIndex].content[reference.blockIndex].text =
        truncateTextToBudget(text, budgetTokens);
    } else {
      result[reference.messageIndex].content[reference.blockIndex].content =
        truncateTextToBudget(text, budgetTokens);
    }
  }

  result.forEach((message) => {
    if (!Array.isArray(message.content)) return;
    message.content = message.content.filter((block) => (
      block?.type !== "image" && block?.type !== "image_url"
    )).map((block) => {
      if (block?.type !== "tool_use") return block;
      return { ...block, input: {} };
    });
  });

  while (estimateMessageTokens(result) > budgetTokens) {
    const removableIndex = result.findIndex((message) => (
      !isProtectedMessage(message, protectedMessage)
    ));
    if (removableIndex < 0) {
      throw new KitError(
        "invalid_budget",
        "Protected messages cannot fit within budgetTokens",
        { retryable: false },
      );
    }
    const message = result[removableIndex];
    const uses = blocksFor(message.content).filter((block) => block?.type === "tool_use");
    const results = blocksFor(message.content).filter((block) => block?.type === "tool_result");
    if (uses.length > 0 && result[removableIndex + 1]?.role === "user") {
      if (isProtectedMessage(result[removableIndex + 1], protectedMessage)) {
        throw new KitError(
          "invalid_budget",
          "Protected messages cannot fit within budgetTokens",
          { retryable: false },
        );
      }
      result.splice(removableIndex, 2);
    } else if (results.length > 0 && removableIndex > 0
      && result[removableIndex - 1]?.role === "assistant") {
      if (isProtectedMessage(result[removableIndex - 1], protectedMessage)) {
        throw new KitError(
          "invalid_budget",
          "Protected messages cannot fit within budgetTokens",
          { retryable: false },
        );
      }
      result.splice(removableIndex - 1, 2);
    } else {
      result.splice(removableIndex, 1);
    }
  }
  return { messages: result, tokensAfter: estimateMessageTokens(result), enforced };
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
 * Stall detection defaults to `appear`, which detects a signature anywhere in
 * the window; `consecutive` requires the entire window to match.
 *
 * @param {{
 *   provider: {chat: (request: object) => Promise<object>, chatStream?: (request: object) => Promise<object>},
 *   system?: string,
 *   initialUserMessage?: string,
 *   initialMessages?: object[],
 *   tools?: object[],
 *   executeTool: ((name:string, input:object) => Promise<string>)
 *     | ((options:{id:string, name:string, input:object, context:object, signal:AbortSignal})
 *       => Promise<string|{success?:boolean, data:any, duration?:number, toolMessageId?:string}>),
 *   maxRounds?: number,
 *   maxTokens?: number,
 *   temperature?: number,
 *   topP?: number,
 *   timeoutMs?: number,
 *   deadlineMs?: number,
 *   reflection?: {enabled?:boolean, roundJudge?:boolean, triggerRound?:number, extensionStep?:number,
 *     maxExtensions?:number, maxRoundsCap?:number, format?:"json"|"text",
 *     judge?:{provider?:object,evaluator?:object},
 *     onReflection?:(info:{round:number, decision:object, extendedTo:number}) => void}|false,
 *   stallDetection?: {window?:number, mode?:"appear"|"consecutive"}|false,
 *   retry?: {attempts?:number, backoffBaseMs?:number, backoffMaxMs?:number,
 *     sleepImpl?:(ms:number)=>Promise<void>}|false,
 *   completion?: {signals?:string[], maxNoToolRounds?:number}|false,
 *   maxTokenContinuations?: number,
 *   context?: {strategy?: object, budgetTokens?:number, keepRounds?:number, toolContext?:object},
 *   modelConfig?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   modelMetadata?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   model?: {contextWindowTokens?:number, maxOutputTokens?:number},
 *   expert?:any, user?:any, task?:any, session?:any, requestId?:string, toolContext?:object,
 *   store?: {appendRound?: Function, saveCheckpoint?:Function, appendCheckpoint?:Function,
 *     markRunState?:Function, loadLatestCheckpoint?:Function},
 *   runId?: string,
 *   resume?: boolean,
 *   onRound?: Function,
 *   onToolResult?: Function,
 *   onPersistenceError?: (error:Error) => void,
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
 *   termination:{reason:"end_turn"|"no_tool"|"stall"|"max_rounds_cap"|"reflection_stop"|"judge_done"|"continuation_exhausted"|"aborted"|"failed", detail?:string},
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
  timeoutMs,
  deadlineMs,
  reflection = false,
  stallDetection = { window: 4 },
  retry = false,
  completion = { signals: [], maxNoToolRounds: 3 },
  maxTokenContinuations = 3,
  context,
  modelConfig,
  modelMetadata,
  model,
  expert,
  user,
  task,
  session,
  requestId,
  toolContext,
  store,
  runId,
  resume = false,
  onRound,
  onToolResult,
  onPersistenceError,
  signal,
  stream = false,
  onDelta,
  onReasoningDelta,
  onToolCall,
  onUsage,
  onEvent,
}) {
  const reportPersistenceError = (error) => {
    if (typeof onPersistenceError === "function") {
      onPersistenceError(error);
      return;
    }
    console.error("Transcript persistence error:", error);
  };
  const persist = async (method, ...args) => {
    if (typeof store?.[method] !== "function") return false;
    try {
      await store[method](...args);
      return true;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  };
  const markRunState = async (state) => {
    await persist("markRunState", runId, state);
  };
  const fail = async (error) => {
    const reason = signal?.aborted ? "aborted" : "failed";
    const termination = makeTermination(reason, terminationDetailForError(error));
    const annotated = annotateTermination(error, termination);
    await markRunState(reason);
    throw annotated;
  };
  const metadata = modelMetadataFor({ modelConfig, modelMetadata, model, provider, context });
  let budgetTokens = context?.budgetTokens;
  if (budgetTokens === undefined
    && metadata?.contextWindowTokens !== undefined
    && metadata?.maxOutputTokens !== undefined) {
    budgetTokens = computeBudget({
      contextWindowTokens: metadata.contextWindowTokens,
      maxOutputTokens: metadata.maxOutputTokens,
    });
  }
  if (budgetTokens !== undefined) validateBudget(budgetTokens);
  const compactionContext = context === undefined && budgetTokens === undefined
    ? undefined
    : {
        ...(context ?? {}),
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
      };
  const baseToolContext = toolContextFor({
    toolContext,
    context,
    expert,
    user,
    task,
    session,
    requestId,
  });
  const toolSignal = signal ?? new AbortController().signal;
  const effectiveReflection = reflection === true
    ? {}
    : reflection && typeof reflection === "object"
      ? reflection
      : undefined;
  const reflectionEnabled = reflection === true
    || (effectiveReflection !== undefined && effectiveReflection.enabled !== false);
  let roundJudgeEnabled = reflectionEnabled
    && effectiveReflection?.roundJudge !== false
    && process.env.ERIX_NO_ROUND_JUDGE?.trim() !== "1";
  const roundJudgeFailureLimit = Number.isSafeInteger(effectiveReflection?.judgeFailureLimit)
    && effectiveReflection.judgeFailureLimit > 0
    ? effectiveReflection.judgeFailureLimit
    : 3;
  let roundJudgeFailures = 0;
  // 方向检查频率：tool_calls 轮每 judgeIntervalRound 轮查一次方向（done:false→nudge 纠偏）；
  // stop 轮（end_turn）总是完整评估（含 done 判定）。默认 5：跑偏最多 5 轮被发现。
  const judgeIntervalRound = Number.isSafeInteger(effectiveReflection?.judgeIntervalRound)
    && effectiveReflection.judgeIntervalRound > 0
    ? effectiveReflection.judgeIntervalRound
    : 5;
  let lastJudgeRound = 0;
  const mainSystem = `${system ?? ""}${system ? "\n\n" : ""}${WRAPUP_INSTRUCTION}`;
  // 归一化 evaluator：复用 judge/provider 配置（无 judge 时主 provider），供 wrapup LLM 归一化用
  const judgeConfig = effectiveReflection?.judge;
  const wrapupEvaluator = judgeConfig?.provider ?? judgeConfig?.evaluator ?? provider;
  // wrapup LLM 归一化（默认关闭：保持既有纯文本轮行为与旧测试兼容）。
  // 开启：ERIX_WRAPUP_NORMALIZE=1 或 reflection.wrapupNormalize===true。
  // benchmark/harness 场景应开启——找不到 JSON（含空文本）就该归一化。
  let wrapupNormalizationEnabled = process.env.ERIX_WRAPUP_NORMALIZE?.trim() === "1"
    || effectiveReflection?.wrapupNormalize === true;
  const reflectionTriggerRound = Number.isSafeInteger(effectiveReflection?.triggerRound)
    && effectiveReflection.triggerRound > 0
    ? effectiveReflection.triggerRound
    : Math.max(1, Math.floor(maxRounds * 0.8));
  const reflectionExtensionStep = Number.isSafeInteger(effectiveReflection?.extensionStep)
    && effectiveReflection.extensionStep > 0
    ? effectiveReflection.extensionStep
    : 32;
  const reflectionMaxExtensions = Number.isSafeInteger(effectiveReflection?.maxExtensions)
    && effectiveReflection.maxExtensions >= 0
    ? effectiveReflection.maxExtensions
    : 2;
  const reflectionMaxRoundsCap = Math.max(
    maxRounds,
    Number.isSafeInteger(effectiveReflection?.maxRoundsCap)
      && effectiveReflection.maxRoundsCap > 0
      ? effectiveReflection.maxRoundsCap
      : 256,
  );
  const governorState = {
    effectiveMaxRounds: maxRounds,
    extensionCount: 0,
    nextReflectionRound: reflectionTriggerRound,
    noToolStreak: 0,
    wrapUpNudged: false,
    errorSeen: new Map(),
    runningLog: [],
    l0Facts: [],
    timeline: [],
    filesWritten: [],
  };
  const startedAt = Date.now();
  const configuredDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : Number.isFinite(timeoutMs) && timeoutMs > 0
      ? startedAt + timeoutMs
      : undefined;
  const elapsedMs = () => Date.now() - startedAt;
  const remainingMs = () => configuredDeadline === undefined
    ? undefined
    : configuredDeadline > startedAt
      ? configuredDeadline - Date.now()
      : configuredDeadline - elapsedMs();
  const trimGovernorHistory = () => {
    while (governorState.runningLog.length > 1
      && estimateTokens(JSON.stringify(governorState.runningLog))
        + estimateTokens(JSON.stringify(governorState.l0Facts)) > 4000) {
      governorState.runningLog.shift();
      governorState.l0Facts.shift();
    }
  };
  const addGovernorHistory = (round, summary, l0facts, ts, wrapup, judge) => {
    governorState.runningLog.push({
      round,
      summary,
      ...(summary && typeof summary === "object" ? summary : {}),
      ...(wrapup === undefined || wrapup === null ? {} : {
        planned: "",
        actual: wrapup.summary,
        next: "",
        source: wrapup.done ? "json-done" : "json",
      }),
      ...(judge === undefined || judge === null ? {} : { judge }),
      ts,
    });
    governorState.l0Facts.push({ round, ...l0facts });
    trimGovernorHistory();
  };
  const restoreErrorSeen = (l0facts) => {
    // 优先 errorCounts（每轮持久化的累计 count，resume 精确重建）；
    // 旧 schema fallback：errorHashes 每 hash +1（近似，同轮多次同错会少计）
    const counts = l0facts?.errorCounts;
    if (counts && typeof counts === "object") {
      for (const [errorHash, count] of Object.entries(counts)) {
        const current = governorState.errorSeen.get(errorHash)?.count ?? 0;
        governorState.errorSeen.set(errorHash, {
          count: Math.max(current, Number.isFinite(count) ? count : 0),
        });
      }
      return;
    }
    const errorHashes = l0facts?.errorHashes
      ?? (l0facts?.errorHash ? [l0facts.errorHash] : []);
    for (const errorHash of errorHashes) {
      const previous = governorState.errorSeen.get(errorHash);
      const previousCount = Number.isSafeInteger(previous?.count) ? previous.count : 0;
      governorState.errorSeen.set(errorHash, {
        ...(previous ?? {}),
        count: previousCount + 1,
      });
    }
  };
  let messages = initialMessages !== undefined
    ? [...initialMessages]
    : initialUserMessage !== undefined
      ? [{ role: "user", content: [{ type: "text", text: initialUserMessage }] }]
      : [];
  const messageRounds = new WeakMap();
  for (const message of messages) messageRounds.set(message, 0);
  let rounds = 0;
  let foldedThrough = 0;
  let resumeCheckpoint;
  let resumePendingTool;
  let resumeTailMessages = [];
  let resumeTranscriptStart;
  let resumeCheckpointMessages = [];
  let persistedTranscriptLength = 0;
  const resumeExecutedToolIds = new Set();
  const resumeCheckpointResults = new Map();
  await markRunState("running");
  if (resume && store && runId !== undefined) {
    try {
      const records = await store.load(runId);
      if (records.length === 0) throw new Error("resume: 无可恢复记录");
      messages = records.flatMap((record) => record.messages ?? []);
      persistedTranscriptLength = messages.length;
      for (const record of records) {
        for (const message of record.messages ?? []) {
          messageRounds.set(message, record.round ?? 0);
        }
        if ((record.round ?? 0) > 0) {
          const summary = record.summary ?? "missing";
          const l0facts = record.l0facts
            // 无 l0facts 的远古记录：用共享 errorSeen 重新提取（跨记录累计；
            // 随后 restoreErrorSeen 的 Math.max 幂等，不会双计）
            ?? extractL0Facts(record.messages ?? [], {
              seenErrors: governorState.errorSeen,
            });
          restoreErrorSeen(l0facts);
          addGovernorHistory(
            record.round,
            summary,
            l0facts,
            record.ts,
            record.wrapup,
            record.judge,
          );
          const recordedTimeline = buildTimeline(record.messages ?? [], 0);
          if (recordedTimeline.toolCalls.length > 0 || recordedTimeline.outputs.length > 0) {
            governorState.timeline.push({ round: record.round, ...recordedTimeline });
            governorState.timeline = governorState.timeline.slice(-12);
            for (const call of recordedTimeline.toolCalls) {
              if (call.name === "writeFile" && call.arg) {
                governorState.filesWritten.push({ path: call.arg, round: record.round });
              }
            }
          }
        }
      }
      // 以最大 round 为续跑基数（含 round 0 种子记录时 records.length 会多算一轮）
      rounds = Math.max(...records.map((record) => record.round ?? 0));
      foldedThrough = Math.max(
        0,
        ...records.map((record) => record.foldedRoundRange?.to ?? 0),
      );
      if (typeof store.loadLatestCheckpoint === "function") {
        resumeCheckpoint = await store.loadLatestCheckpoint(runId);
        if (resumeCheckpoint?.round > rounds && Array.isArray(resumeCheckpoint.messages)) {
          const recordedEntries = [];
          for (const record of records) {
            for (const message of record.messages ?? []) {
              recordedEntries.push({
                message,
                round: record.round ?? 0,
              });
            }
          }
          const checkpointAnchor = Number.isSafeInteger(
            resumeCheckpoint.persistedTranscriptLength,
          ) && resumeCheckpoint.persistedTranscriptLength >= 0
            ? Math.min(resumeCheckpoint.persistedTranscriptLength, recordedEntries.length)
            : undefined;
          let searchFrom = 0;
          let lastMatchedIndex = -1;
          const checkpointMessageRounds = [];
          const checkpointMessageIndices = [];
          for (const message of resumeCheckpoint.messages) {
            const key = JSON.stringify(message);
            let matchedIndex = -1;
            for (let index = searchFrom; index < recordedEntries.length; index += 1) {
              if (JSON.stringify(recordedEntries[index].message) === key) {
                matchedIndex = index;
                break;
              }
            }
            if (matchedIndex === -1) {
              checkpointMessageRounds.push(undefined);
              checkpointMessageIndices.push(-1);
              continue;
            }
            searchFrom = matchedIndex + 1;
            lastMatchedIndex = matchedIndex;
            checkpointMessageRounds.push(recordedEntries[matchedIndex].round);
            checkpointMessageIndices.push(matchedIndex);
          }
          resumeTailMessages = recordedEntries
            .slice(checkpointAnchor ?? lastMatchedIndex + 1)
            .map((entry) => ({
              message: cloneState(entry.message),
              round: entry.round,
            }));
          messages = cloneState(resumeCheckpoint.messages);
          resumeTranscriptStart = messages.length;
          resumeCheckpointMessages = resumeCheckpoint.messages.filter((_message, index) => {
            const matchedIndex = checkpointMessageIndices[index];
            const isPersisted = matchedIndex >= 0
              && (checkpointAnchor === undefined || matchedIndex < checkpointAnchor);
            return !isPersisted && blocksFor(_message?.content).some((block) => (
              block?.type === "tool_use" || block?.type === "tool_result"
            ));
          });
          for (const [index, message] of messages.entries()) {
            messageRounds.set(
              message,
              checkpointMessageRounds[index] ?? resumeCheckpoint.round,
            );
          }
          rounds = resumeCheckpoint.round;
          for (const id of resumeCheckpoint.executedToolIds ?? []) {
            resumeExecutedToolIds.add(id);
          }
          for (const entry of resumeCheckpoint.toolResults ?? []) {
            if (entry?.toolUseId !== undefined && entry.toolResult !== undefined) {
              resumeCheckpointResults.set(entry.toolUseId, entry.toolResult);
            }
          }
          const recordedIds = new Set(
            messages.flatMap((message) => blocksFor(message?.content))
              .filter((block) => block?.type === "tool_result")
              .map((block) => block.tool_use_id),
          );
          const replayResults = [...resumeCheckpointResults.values()]
            .filter((toolResult) => !recordedIds.has(toolResult.tool_use_id));
          if (replayResults.length > 0) {
            const replayMessage = { role: "user", content: replayResults };
            messages.push(replayMessage);
            messageRounds.set(replayMessage, resumeCheckpoint.round);
          }
          const pendingTools = resumeCheckpoint.pendingToolUses
            ?? (resumeCheckpoint.pendingToolUse ? [resumeCheckpoint.pendingToolUse] : []);
          resumePendingTool = pendingTools.find((pendingTool) => (
            !resumeCheckpoint.executedToolIds?.includes(pendingTool.id)
            && !resumeCheckpointResults.has(pendingTool.id)
          ));
        }
      }
    } catch (error) {
      await fail(error);
    }
  } else if (store && runId !== undefined && messages.length > 0) {
    // 种子记录：初始消息（initialMessages/initialUserMessage）先入档，
    // 否则它们永不在 store 中——recall 在 fold 后找不到被折的初始历史（ADR-002 档案完整性）
    const persisted = await persist("appendRound", runId, {
      round: 0,
      roundKey: `${String(runId)}:round:0`,
      messages: [...messages],
      summary: "missing",
      l0facts: extractL0Facts(messages),
      ts: new Date().toISOString(),
    });
    if (persisted) persistedTranscriptLength += messages.length;
  }
  const recentSignatures = [];
  const envStallMode = process.env.ERIX_STALL_MODE;
  const resolvedStallDetection = envStallMode
    ? { window: stallDetection?.window ?? 4, mode: envStallMode }
    : stallDetection;
  const stallWindow = resolvedStallDetection === false
    ? 0
    : Number.isInteger(resolvedStallDetection?.window) && resolvedStallDetection.window > 0
      ? resolvedStallDetection.window
      : 4;
  const stallMode = resolvedStallDetection?.mode === "consecutive" ? "consecutive" : "appear";
  const usage = { input_tokens: 0, output_tokens: 0 };
  let latestApiInputTokens;
  let latestApiEstimatedTokens;
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
  let roundStopReason;
  let roundEventDeltas = [];

  const emitEvent = (event) => {
    onEvent?.(event);
  };

  const addUsage = (response, estimatedTokens, { trackLatest = true } = {}) => {
    const inputTokens = response?.usage?.input_tokens;
    if (Number.isFinite(inputTokens)) {
      usage.input_tokens += inputTokens;
      if (trackLatest) {
        latestApiInputTokens = inputTokens > 0 ? inputTokens : undefined;
        latestApiEstimatedTokens = Number.isFinite(estimatedTokens)
          ? estimatedTokens
          : undefined;
      }
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

  const executedToolIds = new Set(resumeExecutedToolIds);
  const checkpointResults = new Map(resumeCheckpointResults);
  const persistCheckpoint = async ({
    round,
    pendingToolUse,
    pendingToolUses = [],
    toolResults = [],
    status = "pending",
    messagesOverride,
  }) => {
    const method = typeof store?.saveCheckpoint === "function"
      ? "saveCheckpoint"
      : typeof store?.appendCheckpoint === "function"
        ? "appendCheckpoint"
        : undefined;
    if (method === undefined) return;
    await persist(method, runId, {
      round,
      status,
      pendingToolUse: cloneState(pendingToolUse),
      toolUse: cloneState(pendingToolUse),
      pendingToolUses: cloneState(pendingToolUses),
      messages: cloneState(messagesOverride ?? messages),
      persistedTranscriptLength,
      executedToolIds: [...executedToolIds],
      toolResults: toolResults.map((toolResult) => ({
        toolUseId: toolResult.tool_use_id,
        toolResult: cloneState(toolResult),
      })),
      ts: new Date().toISOString(),
    });
  };

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

  const executeToolBlock = async (block, round, toolResults, pendingToolUses = []) => {
    await persistCheckpoint({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
    });
    const startedAt = Date.now();
    let execution;
    let isError = false;
    try {
      const structuredOptions = {
        id: block.id,
        name: block.name,
        input: block.input,
        context: { ...baseToolContext, round },
        signal: toolSignal,
      };
      const result = executeTool.length <= 1
        ? await awaitWithAbort(Promise.resolve().then(() => executeTool(structuredOptions)))
        : await awaitWithAbort(Promise.resolve().then(() => (
          executeTool(block.name, block.input)
        )));
      execution = normalizeExecutionResult(result, startedAt);
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      isError = true;
      execution = {
        content: String(error?.message ?? error),
        metadata: {},
        success: false,
      };
    }

    if (onToolResult) {
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
    if (isError || execution.success === false) toolResult.is_error = true;
    toolResults.push(toolResult);
    if (block.id !== undefined) executedToolIds.add(block.id);
    checkpointResults.set(block.id, toolResult);
    await persistCheckpoint({
      round,
      pendingToolUse: block,
      pendingToolUses,
      toolResults,
      status: "executed",
      messagesOverride: [
        ...messages,
        { role: "user", content: cloneState(toolResults) },
      ],
    });
    return toolResult;
  };

  const callProvider = async ({ allowPendingToolUse = false, round } = {}) => {
    let retryIndex = 0;
    let recovered = false;
    while (true) {
      normalizeMessages(messages);
      validateMessages(messages, { allowPendingToolUse });
      const requestEstimatedTokens = estimateMessageTokens(messages);
      const snapshot = {
        messages: cloneState(messages),
        eventDeltas: [...roundEventDeltas],
        finalText,
        usage: { ...usage },
        latestApiInputTokens,
        latestApiEstimatedTokens,
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
          system: mainSystem,
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
          return {
            response,
            usageEmitted: attemptUsage !== undefined,
            estimatedTokens: requestEstimatedTokens,
          };
        }
        const response = await awaitWithAbort(provider.chat(request));
        if (recovered) emitEvent({ type: "recovered", round, attempt });
        return {
          response,
          usageEmitted: false,
          estimatedTokens: requestEstimatedTokens,
        };
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
        latestApiInputTokens = snapshot.latestApiInputTokens;
        latestApiEstimatedTokens = snapshot.latestApiEstimatedTokens;
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

  const callReflection = async (round, currentL0, currentSummary) => {
    const l0Facts = [...governorState.l0Facts, { round, ...currentL0 }];
    const runningLog = [
      ...governorState.runningLog,
      { round, summary: currentSummary },
    ];
    const reflectionMessages = [{
      role: "user",
      content: [{
        type: "text",
        text: reflectionPrompt({
          rounds: round,
          taskBrief: taskBriefFromMessages(messages),
          runningLog,
          l0Facts,
          errorText: l0Facts
            .flatMap((fact) => fact.errorTexts ?? (fact.errorText ? [fact.errorText] : []))
            .filter((text, index, values) => values.indexOf(text) === index)
            .slice(-5)
            .join("\n"),
        }),
      }],
    }];
    const judge = effectiveReflection?.judge;
    const evaluator = judge?.provider ?? judge?.evaluator ?? provider;
    const request = {
      system: "你是严格的独立评审者，不是执行者。只评估任务价值与是否继续，不执行工具。",
      messages: reflectionMessages,
      signal,
    };
    if (maxTokens !== undefined) request.maxTokens = maxTokens;
    if (temperature !== undefined) request.temperature = temperature;
    if (topP !== undefined) request.topP = topP;
    const response = await awaitWithAbort(evaluator.chat(request));
    addUsage(response, undefined, { trackLatest: false });
    return parseReflectionDecision(textFromBlocks(blocksFor(response?.content)));
  };

  const callRoundJudge = async (round, currentL0) => {
    const l0Facts = [...governorState.l0Facts, { round, ...currentL0 }];
    const recentErrors = l0Facts
      .flatMap((fact) => fact.errorTexts ?? (fact.errorText ? [fact.errorText] : []))
      .filter((text, index, values) => values.indexOf(text) === index)
      .slice(-5);
    const judge = effectiveReflection?.judge;
    const evaluator = judge?.provider ?? judge?.evaluator ?? provider;
    const request = {
      system: "你是交付评审者，独立判断任务是否完成。只输出 JSON。",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: buildJudgePrompt(
            taskBriefFromMessages(messages),
            round,
            governorState.timeline,
            governorState.filesWritten,
            recentErrors,
          ),
        }],
      }],
      maxTokens: 8000,
      temperature: 0,
      reasoning_effort: "none",
    };
    if (signal !== undefined) request.signal = signal;
    const response = await awaitWithAbort(
      typeof evaluator === "function"
        ? evaluator(request)
        : evaluator.chat(request),
    );
    addUsage(response, undefined, { trackLatest: false });
    return parseJudgeDecision(textFromBlocks(blocksFor(response?.content)));
  };

  const roundNumbersForMessages = (currentMessages) => {
    const grouped = groupIntoRounds(currentMessages).rounds;
    return grouped.map((group, index) => {
      const known = group.messages
        .map((message) => messageRounds.get(message))
        .find((roundNumber) => Number.isSafeInteger(roundNumber) && roundNumber > 0);
      return known ?? foldedThrough + index + 1;
    });
  };

  const compactBeforeRound = async () => {
    normalizeMessages(messages);
    const configuredStrategy = compactionContext?.strategy;
    // API input usage is per request; keep the aggregate for billing output.
    // 压缩判断：主用本地估算（真实上下文大小），API usage 辅助取单轮完整输入
    // （flash/kimi 型 API 报完整输入含历史；累积 usage.input_tokens 是计费总量、虚高会误触发折叠）
    const apiInputTokens = latestApiInputTokens;
    const estimatedTokens = estimateMessageTokens(messages);
    const overBudget = budgetTokens !== undefined
      && (estimatedTokens > budgetTokens || isApiInputOverBudget(apiInputTokens, budgetTokens));
    const strategyRequestsCompaction = configuredStrategy
      ? await configuredStrategy.shouldCompact(messages, budgetTokens)
      : false;
    if (strategyRequestsCompaction || overBudget) {
      const strategy = strategyRequestsCompaction
        ? configuredStrategy
        : createSlidingWindowStrategy();
      const tokensBefore = estimateMessageTokens(messages);
      const configuredKeepRounds = compactionContext.keepRounds ?? 6;
      // 上下文膨胀到预算 2 倍以上时收紧 keepRounds（防折叠后立刻再超预算的恶性循环）
      const keepRounds = estimatedTokens / budgetTokens > 2
        ? Math.min(configuredKeepRounds, 2)
        : configuredKeepRounds;
      const compactOptions = {
        keepRounds,
        budgetTokens,
      };
      Object.defineProperty(compactOptions, "roundNumbers", {
        value: roundNumbersForMessages(messages),
        enumerable: false,
      });
      if (foldedThrough > 0) compactOptions.roundOffset = foldedThrough;
      for (const key of [
        "summaryRole",
        "protectedMessage",
        "stripHistoricalImages",
        "onBeforeFold",
        "onAfterFold",
      ]) {
        if (compactionContext[key] !== undefined) compactOptions[key] = compactionContext[key];
      }
      const result = await strategy.compact(messages, compactOptions);
      if (!Array.isArray(result?.messages)) {
        throw new TypeError("Compaction strategy must return a messages array");
      }
      let compactedMessages = result.messages;
      let foldedPayload = Array.isArray(result.foldedPayload)
        ? result.foldedPayload
        : [];
      let foldedRoundRange = result.foldedRoundRange;
      let foldedRounds = Number.isSafeInteger(result.foldedRounds)
        ? result.foldedRounds
        : 0;
      let compacted = result.compacted === true;
      let tokensAfter = estimateMessageTokens(compactedMessages);
      const apiEstimateBefore = latestApiEstimatedTokens ?? tokensBefore;
      let apiTokensAfter = projectedApiInputTokens(
        apiInputTokens,
        apiEstimateBefore,
        tokensAfter,
      );
      if (
        (budgetTokens !== undefined && tokensAfter > budgetTokens)
        || isApiInputOverBudget(apiTokensAfter, budgetTokens)
      ) {
        const fallback = await createSlidingWindowStrategy().compact(compactedMessages, {
          keepRounds: 0,
          budgetTokens,
          protectedMessage: compactionContext.protectedMessage,
          stripHistoricalImages: compactionContext.stripHistoricalImages,
          roundOffset: foldedThrough,
          roundNumbers: roundNumbersForMessages(compactedMessages),
        });
        compactedMessages = fallback.messages;
        foldedPayload = [...foldedPayload, ...(fallback.foldedPayload ?? [])];
        foldedRounds += fallback.foldedRounds ?? 0;
        compacted = compacted || fallback.compacted === true;
        if (foldedRoundRange === undefined) foldedRoundRange = fallback.foldedRoundRange;
        tokensAfter = estimateMessageTokens(compactedMessages);
        apiTokensAfter = projectedApiInputTokens(
          apiInputTokens,
          apiEstimateBefore,
          tokensAfter,
        );
      }
      if (
        (budgetTokens !== undefined && tokensAfter > budgetTokens)
        || isApiInputOverBudget(apiTokensAfter, budgetTokens)
      ) {
        const apiAwareBudget = isApiInputOverBudget(apiTokensAfter, budgetTokens)
          ? Math.max(
            1,
            Math.floor(budgetTokens * apiEstimateBefore / apiInputTokens),
          )
          : budgetTokens;
        const fallback = safeTruncateMessages(
          compactedMessages,
          apiAwareBudget,
          compactionContext.protectedMessage,
        );
        compactedMessages = fallback.messages;
        tokensAfter = fallback.tokensAfter;
      }
      messages = compactedMessages;
      latestApiInputTokens = undefined;
      latestApiEstimatedTokens = undefined;
      hadToolUse = hadToolUse || hasToolUseInMessages(messages);
      if (foldedRoundRange?.to !== undefined) {
        foldedThrough = Math.max(foldedThrough, foldedRoundRange.to);
      }
      compactionStats.push({
        compacted,
        foldedRounds,
        tokensBefore,
        tokensAfter,
      });
      normalizeMessages(messages);
      return {
        folded: compacted,
        foldedPayload: compacted ? foldedPayload : undefined,
        foldedRoundRange,
      };
    }
    return { folded: false, foldedPayload: undefined };
  };

  const appendToolResultsToTranscript = (toolResults, roundNumber) => {
    if (toolResults.length === 0) return;
    const previous = messages.at(-2);
    const last = messages.at(-1);
    const previousUses = blocksFor(previous?.content)
      .filter((block) => block?.type === "tool_use");
    const lastResults = blocksFor(last?.content)
      .filter((block) => block?.type === "tool_result");
    if (previous?.role === "assistant"
      && last?.role === "user"
      && previousUses.length > 0
      && lastResults.length > 0) {
      last.content = [...lastResults, ...toolResults];
      if (roundNumber !== undefined) messageRounds.set(last, roundNumber);
      return;
    }
    const message = { role: "user", content: toolResults };
    messages.push(message);
    if (roundNumber !== undefined) messageRounds.set(message, roundNumber);
  };

  const makeResult = (reason, detail) => {
    const termination = makeTermination(reason, detail);
    return {
      finalText,
      messages,
      transcript: [...messages],
      rounds,
      truncated: TRUNCATED_TERMINATION_REASONS.has(termination.reason),
      termination,
      usage,
      compactionStats,
    };
  };

  const finish = async (reason, detail) => {
    await markRunState("succeeded");
    return makeResult(reason, detail);
  };

  const appendResumeTailMessages = () => {
    for (const entry of resumeTailMessages) {
      const message = cloneState(entry.message);
      messages.push(message);
      messageRounds.set(message, entry.round);
    }
    resumeTailMessages = [];
  };

  try {
    throwIfAborted(signal);
    if (resumePendingTool) {
      const resumedToolResults = [];
      emitEvent({ type: "tool_use", round: rounds, toolUse: cloneState(resumePendingTool) });
      await executeToolBlock(
        resumePendingTool,
        rounds,
        resumedToolResults,
        [resumePendingTool],
      );
      appendToolResultsToTranscript(resumedToolResults, rounds);
      resumePendingTool = undefined;
    }
    if (resumeCheckpoint && resumeTranscriptStart !== undefined) {
      const resumeRecordMessages = messages.slice(resumeTranscriptStart);
      const resumeMessagesToPersist = [
        ...resumeCheckpointMessages,
        ...resumeRecordMessages,
      ];
      const persisted = await persist("appendRound", runId, {
        round: resumeCheckpoint.round,
        roundKey: `${String(runId)}:round:${String(resumeCheckpoint.round)}`,
        dedupKey: `${String(runId)}:round:${String(resumeCheckpoint.round)}`,
        messages: cloneState(resumeMessagesToPersist),
        ts: new Date().toISOString(),
      });
      if (persisted) persistedTranscriptLength += resumeMessagesToPersist.length;
      resumeTranscriptStart = undefined;
      resumeCheckpointMessages = [];
    }
    appendResumeTailMessages();

    while (rounds < governorState.effectiveMaxRounds) {
    const round = rounds + 1;
    roundEventDeltas = [];
    roundStopReason = undefined;
    emitEvent({ type: "round_start", round });
    const compaction = await compactBeforeRound();
    const roundStart = messages.length;
    let providerResult = await callProvider({ round });
    let response = providerResult.response;
    let content = blocksFor(response?.content);

    const assistantMessage = { role: "assistant", content };
    messages.push(assistantMessage);
    messageRounds.set(assistantMessage, round);
    addUsage(response, providerResult.estimatedTokens);
    if (!providerResult.usageEmitted && response?.usage !== undefined) {
      emitEvent({ type: "usage", round, usage: response.usage });
    }
    roundStopReason = response?.stopReason;

    let tokenContinuationCount = 0;
    while (response?.stopReason === "max_tokens"
      && tokenContinuationCount < continuationLimit) {
      // reasoning 模型单次响应常因推理过长触发 max_tokens 截断；
      // 若 messages 已超预算，先压缩再补全，避免截断循环耗尽预算（Issue #11）
      if (budgetTokens !== undefined
        && (
          estimateMessageTokens(messages) > budgetTokens
          || isApiInputOverBudget(latestApiInputTokens, budgetTokens)
        )) {
        await compactBeforeRound();
      }
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
        const assistantMessage = { role: "assistant", content };
        messages.push(assistantMessage);
        messageRounds.set(assistantMessage, round);
      }
      addUsage(response, providerResult.estimatedTokens);
      if (!providerResult.usageEmitted && response?.usage !== undefined) {
        emitEvent({ type: "usage", round, usage: response.usage });
      }
      roundStopReason = response?.stopReason;
    }
    const continuationExhausted = response?.stopReason === "max_tokens"
      && tokenContinuationCount >= continuationLimit;
    const responseText = textFromBlocks(content);
    // OpenAI 规范：finish_reason=stop 是模型自然停止的唯一标识。
    // 但社区实测存在 stop 但 content 带 tool_calls 的边界（非标准）——双保险：stop && 无 tool_use
    // 才算真正说完（tool_calls 轮即使报 stop 也是要调工具，不该 judge/wrapup）
    const isEndTurn = roundStopReason === "end_turn" && !hasToolUse(content);
    const wrapupJson = isEndTurn ? tryParseWrapupJson(responseText) : null;
    const parsedSummary = parseL1Summary(responseText);
    let roundSummary = wrapupJson === null
      ? parsedSummary.summary
      : wrapupJson.summary;
    content = content.map((block) => (
      block?.type === "text"
        ? { ...block, text: parseL1Summary(block.text).text }
        : block
    ));
    const assistant = messages.at(-1);
    if (assistant?.role === "assistant") assistant.content = content;
    finalText = textFromBlocks(content);
    if (wrapupJson !== null) {
      finalText = wrapupJson.output || wrapupJson.summary;
    }

    if (hasToolUse(content)) {
      hadToolUse = true;
      governorState.noToolStreak = 0;
    }

    if (response?.stopReason === "tool_use") {
      const toolResults = [];
      const pendingToolUses = content.filter((candidate) => candidate?.type === "tool_use");
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        emitEvent({ type: "tool_use", round, toolUse: cloneState(block) });

        const signature = `${block.name}${JSON.stringify(block.input)}`;
        const stalled = stallMode === "consecutive"
          ? recentSignatures.length >= stallWindow
            && recentSignatures.slice(-stallWindow).every((recent) => recent === signature)
          : recentSignatures.length >= stallWindow
            && recentSignatures.includes(signature);
        if (stallWindow > 0 && stalled) {
          throw stallError(signature);
        }
        if (stallWindow > 0) {
          recentSignatures.push(signature);
          if (recentSignatures.length > stallWindow) recentSignatures.shift();
        }

        const recordedToolResult = checkpointResults.get(block.id);
        const toolResult = executedToolIds.has(block.id) && recordedToolResult !== undefined
          ? cloneState(recordedToolResult)
          : await executeToolBlock(
            block,
            round,
            toolResults,
            pendingToolUses.slice(pendingToolUses.findIndex((candidate) => candidate === block)),
          );
        if (!toolResults.includes(toolResult)) toolResults.push(toolResult);
        emitEvent({ type: "tool_result", round, toolResult: cloneState(toolResult) });
      }
      if (toolResults.length > 0) {
        const toolResultMessage = { role: "user", content: toolResults };
        messages.push(toolResultMessage);
        messageRounds.set(toolResultMessage, round);
      }
    }

    let shouldContinue = response?.stopReason === "tool_use"
      || (wrapupJson !== null && wrapupJson.done === false);
    let normalizedWrapup = null;
    let completionSignalDetected = wrapupJson?.done === true
      || (wrapupJson === null && completionSignals.some(
      (completionSignal) => typeof completionSignal === "string"
        && finalText.includes(completionSignal),
      ));
    // LLM 归一化兑底：end_turn + 无工具 + 没解析出 JSON（含空文本/自然语言/杂讯）→
    // 调 judge 归一化为 {done,summary,output}，统一交给下游判定。
    // 触发条件刻意宽松：找不到 JSON 就该归一化（覆盖空文本/难任务放弃场景）。
    if (
      wrapupJson === null
      && response?.stopReason === "end_turn"
      && !hasToolUse(content)
      && wrapupNormalizationEnabled
    ) {
      try {
        const requestForJudge = {
          system: "你是输出协议归一化器，只输出有效 JSON。",
          messages: [{
            role: "user",
            content: [{ type: "text", text: `【归一化】判断 agent 是否完成任务。
任务目标：${taskBriefFromMessages(messages) || "（未提供）"}
已运行轮数：${rounds}
本轮 agent 最终输出（可能为空）：${JSON.stringify(responseText).slice(0, 2000)}
若 agent 已给出明确结论/产物就绪则 done=true；若它在工作中途停下/放弃则判断产出是否可判定，可判定则 done=true 否则 done=false。
只输出 JSON：{"done":true|false,"summary":"任务总结或当前进展","output":"给用户的最终结果"}` }],
          }],
          signal,
        };
        if (maxTokens !== undefined) requestForJudge.maxTokens = maxTokens;
        if (temperature !== undefined) requestForJudge.temperature = temperature;
        const judgeResponse = await awaitWithAbort(wrapupEvaluator.chat(requestForJudge));
        addUsage(judgeResponse, undefined, { trackLatest: false });
        const candidate = tryParseWrapupJson(
          textFromBlocks(blocksFor(judgeResponse?.content)),
        );
        if (candidate !== null) {
          normalizedWrapup = candidate;
          if (candidate.summary !== "" || candidate.output !== "") {
            roundSummary = candidate.summary || candidate.output || roundSummary;
          }
          if (candidate.done === true) {
            shouldContinue = false;
            completionSignalDetected = true;
            if (candidate.output !== "" || candidate.summary !== "") {
              finalText = candidate.output || candidate.summary || finalText;
            }
          } else {
            shouldContinue = true;
          }
        } else {
          // 归一化失败：关闭开关，避免每轮都烧 token
          wrapupNormalizationEnabled = false;
        }
      } catch {
        // 归一化失败降级：走现有 noToolStreak/completion 兑底，不崩 loop
      }
    }
    // 失忆兑底：超过 5 轮后模型若输出欢迎语（误以为新会话），注入任务提醒并继续
    // （上下文折叠可能让模型丢失任务感；此处把主线拉回，避免空转）
    const memoryLossDetected = rounds > 5
      && wrapupJson === null
      && !hasToolUse(content)
      && isLikelyWelcomeResponse(finalText);
    const noToolRound = !hasToolUse(content)
      && completionEnabled
      && !completionSignalDetected
      && hadToolUse;
    if (hasToolUse(content)) {
      governorState.noToolStreak = 0;
    } else if (noToolRound) {
      governorState.noToolStreak += 1;
    }

    rounds = round;
    const currentRoundMessages = messages.slice(roundStart);
    const currentL0 = extractL0Facts(currentRoundMessages, {
      seenErrors: governorState.errorSeen,
    });
    const currentTimeline = buildTimeline(messages, roundStart);
    governorState.timeline.push({ round, ...currentTimeline });
    governorState.timeline = governorState.timeline.slice(-12);
    for (const call of currentTimeline.toolCalls) {
      if (call.name === "writeFile" && call.arg) {
        governorState.filesWritten.push({ path: call.arg, round });
      }
    }
    const actionSignals = {
      round,
      rounds,
      hasToolUse: hasToolUse(content),
      shouldContinue,
      noToolRound,
      noToolStreak: governorState.noToolStreak,
      maxNoToolRounds,
      errorRepeat: currentL0.errorRepeat,
      hasProgress: hasSuccessfulToolResult(currentRoundMessages),
      memoryLoss: memoryLossDetected,
      completionSignalDetected,
      continuationExhausted,
      wrapUpNudged: governorState.wrapUpNudged,
      reflectionEnabled: roundJudgeEnabled ? false : reflectionEnabled,
      nearLimit: rounds >= governorState.nextReflectionRound,
      extensionCount: governorState.extensionCount,
      maxExtensions: reflectionMaxExtensions,
      effectiveMaxRounds: governorState.effectiveMaxRounds,
      maxRoundsCap: reflectionMaxRoundsCap,
      extensionStep: reflectionExtensionStep,
      elapsedMs: elapsedMs(),
      remainingMs: remainingMs(),
    };
    let judgeDecision;
    // judge 两种触发：
    // 1. stop 轮（end_turn）：完整评估——模型说完想停，判完成 + 方向
    // 2. tool_calls 轮周期性（每 judgeIntervalRound）：只查方向——done:true 不生效（模型还要干），done:false→nudge 纠偏
    const toolRoundDirectionCheck = !isEndTurn
      && hasToolUse(content)
      && round - lastJudgeRound >= judgeIntervalRound;
    if (roundJudgeEnabled && (isEndTurn || toolRoundDirectionCheck)) {
      lastJudgeRound = round;
      try {
        judgeDecision = await callRoundJudge(round, currentL0);
        if (judgeDecision === null) {
          roundJudgeFailures += 1;
          if (roundJudgeFailures >= roundJudgeFailureLimit) roundJudgeEnabled = false;
        } else {
          roundJudgeFailures = 0;
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        roundJudgeFailures += 1;
        if (roundJudgeFailures >= roundJudgeFailureLimit) roundJudgeEnabled = false;
      }
    }

    let action;
    // tool_calls 轮的方向检查：done:true 不生效（模型还在干活，抢停会截断收尾）
    const directionCheckOnly = !isEndTurn;
    if (judgeDecision?.done === true
      && judgeDecision.confidence >= 0.7
      && !directionCheckOnly) {
      action = {
        kind: "stop",
        value: "judge_done",
        truncated: false,
      };
    } else if (judgeDecision?.done === false) {
      const reason = judgeDecision.reason || "任务尚未完成";
      const evidence = judgeDecision.evidence || "评审未提供更多证据";
      action = {
        kind: "nudge",
        reason: "judge",
        text: `【Judge 评审意见】${reason}\n证据：${evidence}\n请根据评审意见继续完成任务。`,
        continue: true,
      };
    } else {
      action = decideRoundAction(actionSignals);
    }
    let reflectionDecision;
    if (action.kind === "reflect") {
      // Phase two stays in the loop because only the loop owns the provider.
      try {
        reflectionDecision = await callReflection(round, currentL0, roundSummary);
      } catch (error) {
        if (signal?.aborted) throwIfAborted(signal);
        // judge 失败降级：不崩 loop，回到无评估的 actionSignals 决策
        reflectionDecision = undefined;
        action = decideRoundAction({
          ...actionSignals,
          reflectionEnabled: false,
        });
      }
      if (reflectionDecision !== undefined) {
        action = decideWithEvaluation(actionSignals, reflectionDecision);
        if (typeof effectiveReflection?.onReflection === "function") {
          await effectiveReflection.onReflection({
            round,
            decision: reflectionDecision,
            extendedTo: action.kind === "extend" || action.kind === "extend+redirect"
              ? Math.min(
                governorState.effectiveMaxRounds + reflectionExtensionStep,
                reflectionMaxRoundsCap,
              )
              : governorState.effectiveMaxRounds,
          });
        }
      }
    }
    addGovernorHistory(
      round,
      roundSummary,
      currentL0,
      new Date().toISOString(),
      wrapupJson,
      judgeDecision,
    );

    const record = {
      round,
      roundKey: `${String(runId)}:round:${String(round)}`,
      dedupKey: `${String(runId)}:round:${String(round)}`,
      messages: messages.slice(roundStart),
      ts: new Date().toISOString(),
      response: {
        content,
        stopReason: response?.stopReason,
        ...(response?.usage === undefined ? {} : { usage: response.usage }),
      },
      textPreview: textFromBlocks(content),
      toolUses: content.filter((block) => block?.type === "tool_use").length,
      summary: roundSummary,
      l0facts: currentL0,
      ...(judgeDecision === null || judgeDecision === undefined ? {} : {
        judge: {
          done: judgeDecision.done,
          confidence: judgeDecision.confidence,
          reason: judgeDecision.reason,
          evidence: judgeDecision.evidence,
        },
      }),
      ...(wrapupJson === null ? {} : { wrapup: wrapupJson }),
    };
    if (compaction.folded) {
      record.folded = true;
      if (compaction.foldedPayload !== undefined) {
        record.foldedPayload = compaction.foldedPayload;
      }
      if (compaction.foldedRoundRange !== undefined) {
        record.foldedRoundRange = compaction.foldedRoundRange;
      }
    }
    const persisted = await persist("appendRound", runId, record);
    if (persisted) persistedTranscriptLength += record.messages.length;
    if (onRound) await onRound(record);

    executedToolIds.clear();
    checkpointResults.clear();
    emitEvent({
      type: "round_end",
      round,
      finalText,
      stopReason: roundStopReason,
      usage: { ...usage },
    });
    if (action.kind === "nudge") {
      const continuationMessage = {
        role: "user",
        content: [{ type: "text", text: action.text }],
      };
      messages.push(continuationMessage);
      messageRounds.set(continuationMessage, round);
      if (action.resetNoToolStreak) governorState.noToolStreak = 0;
      if (action.wrapUpNudged === true) governorState.wrapUpNudged = true;
      continue;
    }
    if (action.kind === "extend" || action.kind === "extend+redirect") {
      governorState.effectiveMaxRounds = Math.min(
        governorState.effectiveMaxRounds + reflectionExtensionStep,
        reflectionMaxRoundsCap,
      );
      governorState.extensionCount += 1;
      governorState.nextReflectionRound = Math.max(
        rounds + 1,
        Math.floor(governorState.effectiveMaxRounds * 0.8),
      );
      const continuationMessage = {
        role: "user",
        content: [{ type: "text", text: action.text }],
      };
      messages.push(continuationMessage);
      messageRounds.set(continuationMessage, round);
      continue;
    }
    if (action.kind === "stop") {
      const reason = terminationReasonForAction(action, continuationExhausted);
      const detail = reason === "reflection_stop" ? action.reason : undefined;
      return finish(reason, detail);
    }
    if (action.kind === "continue") continue;
    }
  } catch (error) {
    await fail(error);
  }

  return finish("max_rounds_cap");
}
