import { SUMMARIZER_PROMPT_GUIDE } from "./fold-llm.js";
import { NORMALIZATION_REASONING_EFFORT } from "../reflection/wrapup.js";
import { estimateTokens } from "../tokens.js";

const DEFAULT_SUMMARY_SYSTEM = "你是对话历史压缩器。只输出摘要正文，不要调用工具，不要寒暄。";

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text" || block.type === "thinking" || block.type === "reasoning") {
      const text = [block.text, block.thinking, block.reasoning_content]
        .filter((value) => typeof value === "string" && value !== "")
        .join("\n");
      if (text !== "") parts.push(text);
      continue;
    }
    if (block.type === "tool_use") {
      parts.push(`[tool_use ${String(block.name ?? "?")}] ${stringifyInput(block.input)}`);
      continue;
    }
    if (block.type === "tool_result") {
      const inner = textOfContent(block.content);
      parts.push(`[tool_result] ${inner}`);
      continue;
    }
    if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function stringifyInput(input) {
  if (typeof input === "string") return input;
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function roundRangeLabel(roundRange) {
  if (roundRange === undefined || roundRange === null) return "（未知）";
  return `第 ${roundRange.from ?? "?"} 轮 - 第 ${roundRange.to ?? "?"} 轮`;
}

/**
 * Deterministically serialize the folded payload for a summarizing completion.
 *
 * issue #469-②：
 * 输入尺寸**不再**默认「由已在上下文里的量兜住」——真机 #469 
 * 就是这条假设塌的：
 * 一次折叠把 16 584 token 整坨发给摘要器（引擎账本只有 16 518），
 * 网关回
 * `400 message = input length '16584' is longer than configured context length 
 * '16384'`，
 * 于是整次折叠摘要**静默**降级。现在可选传 `options.maxTokens`：
 * 超限时从**最旧**一侧整条丢弃、
 * 保留尾部（最近性优先），并在正文开头注一行「前 N 
 * 条已省略」，让被裁这件事本身可读。
 * 不传（默认）⇒ 逐字行为与今天一致。
 *
 * @param {object[]} messages
 * @param {{from?: number, to?: number}|undefined} roundRange
 * @param {{ maxTokens?: number }} [options]
 */
export function serializeFoldedMessages(messages, roundRange, options = {}) {
  return serializeFoldedMessagesWithMeta(messages, roundRange, options).text;
}

/**
 * Same serialization, plus how much had to be dropped（#469-② 的入账口径：
 * 被裁过要留痕，
 * 不能既裁了又不告诉任何人——那正是「降级静默」的同一种失败
 * ）。
 *
 * @returns {{ text: string, dropped: number, total: number, bounded: boolean }}
 */
export function serializeFoldedMessagesWithMeta(messages, roundRange, options = {}) {
  const all = Array.isArray(messages) ? messages : [];
  const header = [
    `【被折叠的轮次】${roundRangeLabel(roundRange)}`,
    "【被折叠的消息】",
  ];
  const entries = all.map((message) => {
    const role = typeof message?.role === "string" ? message.role : "unknown";
    const body = textOfContent(message?.content);
    return `[${role}]\n${body === "" ? "（空）" : body}`;
  });
  const maxTokens = Number.isFinite(options?.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : undefined;
  if (maxTokens === undefined) {
    return { text: [...header, ...entries].join("\n"), dropped: 0, total: entries.length, bounded: false };
  }
  const kept = trimOldestEntries(entries, header, maxTokens);
  const note = kept.dropped === 0
    ? []
    : [`（为守住摘要器上下文窗口，前 ${kept.dropped} 条最旧消息已省略，共 ${entries.length} 条）`];
  return {
    text: [...header, ...note, ...kept.kept].join("\n"),
    dropped: kept.dropped,
    total: entries.length,
    bounded: true,
  };
}

// 省略注本身也占位：估工时先给它留出固定余量，
// 避免「裁到刚好又因为注超长」的来回。
const TRIM_NOTE_RESERVE_TOKENS = 48;

function trimOldestEntries(entries, header, maxTokens) {
  let start = 0;
  while (start < entries.length - 1
    && estimateTokens([...header, ...entries.slice(start)].join("\n")) + TRIM_NOTE_RESERVE_TOKENS > maxTokens) {
    start += 1;
  }
  return { kept: entries.slice(start), dropped: start };
}

// issue #469-①：摘要这一发的默认限时。取 30 s 的依据：同形状的 
// judge 拦截调用是 15 s，
// 而摘要的输入比 judge 大一两个量级（真机正常值 11 987 ms）；61 960 
// ms 那一发在真实数据里
// 是离群值，30 s 既不误杀正常摘要，也不会让离群值拖死整轮。传 
// `Infinity`/0/负数 ⇒ 不计时。
// issue #469-①（宿主裁决 2026-10-26）：折叠摘要在每个 run 的**关键路径**上，
// 思考是拿"看得见的延迟"换"没人看见的质量" ⇒ **显式关**，不靠模型默认值
// （换上游模型时默认值会变，等于把这条裁决交给别人的配置表）。三个键同时发：
//   · `reasoning_effort` 是引擎既有口径（judge 同款，`"none"` = 不思考）；
//   · `enable_thinking` / `chat_template_kwargs.thinking` 是 vLLM / Qwen 一类
//     chat-template 后端的开关——真机 #469 那几发带着 `reasoning_effort:"none"`
//     仍产出 584 个 reasoning token，只发前者不够。
// 上游 provider 不接受未知字段时传 `thinkingMode: "inherit"` 退回旧形状。
const FOLD_THINKING_OFF_FIELDS = Object.freeze({
  reasoning_effort: NORMALIZATION_REASONING_EFFORT,
  enable_thinking: false,
  chat_template_kwargs: Object.freeze({ thinking: false }),
});

/**
 * issue #469-①（评审 P1）：**关思考的形态按 provider 协议选**。
 *
 * `enable_thinking` / `chat_template_kwargs` 是 vLLM / Qwen 一类 chat-template 后端的开关；
 * Anthropic 侧 `thinking` 是**对象形态**（`{type:"enabled", budget_tokens}`），而且它的请求体
 * 对未知字段是 400——把这两个键发过去会让**每一次折叠都失败**（降级成统计摘要，账上只留一条
 * `degradeKind:"error"`）。Anthropic 的思考本来就是默认关的，不需要显式关 ⇒ 那边退回 `"inherit"`。
 *
 * @param {string|undefined} protocol provider 的 `protocol` 判别键（`"openai"` / `"anthropic"` / …）
 * @returns {"off"|"inherit"}
 */
export function summarizerThinkingMode(protocol) {
  return protocol === "anthropic" ? "inherit" : "off";
}

const DEFAULT_FOLD_SUMMARIZER_TIMEOUT_MS = 30_000;

/**
 * Default `fold-llm` summarizer backed by the run's own provider (issue #167 方案 C).
 *
 * One tool-free completion per compaction: input = summarizer prompt guide + serialized
 * folded messages + round range; output text becomes the summary. Any thrown/rejected
 * error falls through to the pre-existing statistical-summary degradation in
 * `createFoldLlmStrategy`, so a run never dies because the summary call failed.
 *
 * Usage accounting belongs to the caller-supplied `chat` (the engine merges it into the
 * run ledger); `onUsage` is only the host-visible notification.
 *
 * issue #469 的四条边界（说明只能写在这里，
 * **不能**写进下面那个类型字面量：JSDoc 的
 * `@param {{…}}` 内部放 `//` 注释行会被当类型 token 解析（`TS1131`），
 * 整块 config 类型崩掉
 * 并级联出一串假的 `Property 'x' does not exist`——这条坑踩过两次，
 * 别再犯）：
 *   · `maxSummarizerInputTokens`：
 * 交给摘要器的那一份的**输入**上限（token）；不传 ⇒ 
 * 不裁（旧行为）。
 *   · `summarizerTimeoutMs`：摘要专属超时（ms），**默认 30 
 * 000**（不传不是「无超时」：真机
 *     61 960 ms 那一发就是旧「无超时」行为挂出来的）。**不复用 run 
 * 的 signal 做超时**，
 *     否则一次摘要超时会连坐整轮 run。
 *   · `signal`：父 signal（run/宿主）——只做转发，
 * 到时间只中断摘要这一发。
 *   · `onMeta`：把**结果状态**带出去（finish_reason / token / 被裁条数）
 * 供入账；返回值仍是
 *     string（`fold-llm.js` 对非 string 报错、宿主自带 summarizer 也是 
 * string）。
 *
 * @param {{
 *   chat: (request: { system: string, messages: object[], signal?: AbortSignal, 
 * maxTokens?: number }) => Promise<object>|object,
 *   onUsage?: (usage: object) => void,
 *   system?: string,
 *   promptGuide?: string,
 *   maxSummarizerInputTokens?: number,
 *   summarizerTimeoutMs?: number,
 *   signal?: AbortSignal,
 *   onMeta?: (meta: object) => void,
 *   thinkingMode?: "off"|"inherit",
 * }} config
@returns {(input: { messages?: object[], roundRange?: object, promptGuide?: string,
 *   priorSummary?: string, timeoutMs?: number }) => Promise<string>}
 */
export function createProviderSummarizer({
  chat,
  onUsage,
  system = DEFAULT_SUMMARY_SYSTEM,
  promptGuide = SUMMARIZER_PROMPT_GUIDE,
  maxSummarizerInputTokens,
  // issue #469-①：默认 **限时**（旧行为是「无超时」，真机 61 960 ms 
  // 那一发就在旧行为里挂着）。
  // 要关掉：传 `Infinity`（非有限 ⇒ 不计时的分支）；传 0 / 
  // 负数同样退回不计时。
  summarizerTimeoutMs = DEFAULT_FOLD_SUMMARIZER_TIMEOUT_MS,
  thinkingMode = "off",
  signal,
  onMeta,
} = {}) {
  if (typeof chat !== "function") {
    throw new TypeError("createProviderSummarizer requires a chat(request) function");
  }
  return async ({
    messages = [],
    roundRange,
    promptGuide: perCallGuide,
    priorSummary,
    timeoutMs: perCallTimeoutMs,
  } = {}) => {
    const serialized = serializeFoldedMessagesWithMeta(messages, roundRange, {
      ...(maxSummarizerInputTokens === undefined ? {} : { maxTokens: maxSummarizerInputTokens }),
    });
    // issue #469-③（宿主裁决）：上一份折叠摘要作**续写基底**，单独一节摆到窗口正文之前。
    // 24 KB 上限与截断事实由调用方（`fold-llm`）负责——这里只渲染。
    const prior = typeof priorSummary === "string" && priorSummary.trim() !== ""
      ? `【上一份折叠摘要（续写基底，只作脉络，不要重述）】\n${priorSummary}`
      : undefined;
    const userContent = [perCallGuide ?? promptGuide, prior, serialized.text]
      .filter((part) => part !== undefined)
      .join("\n\n");
    // 显式标注类型：条件展开会让字面量推成**联合类型**，`request.signal = …` 就报
    // TS2339（`Property 'signal' does not exist`）。这不是风格问题，是把它收敛回单一对象。
    /** @type {{ system: string, messages: { role: string, content: string }[],
     * signal?: AbortSignal, reasoning_effort?: string, enable_thinking?: boolean,
     * chat_template_kwargs?: { thinking: boolean } }} */
    const request = {
      system,
      messages: [{ role: "user", content: userContent }],
      ...(thinkingMode === "inherit" ? {} : FOLD_THINKING_OFF_FIELDS),
    };
    // issue #469-②（宿主裁决）：整条摘要步骤**共用一条死线**。调用方把「这一发还能用
    // 多久」按剩余预算传下来（超窗自愈重试与首发共享同一个 30 s，不是各给 30 s）；
    // 不传 ⇒ 用本实例的默认值。
    const timeoutMs = Number.isFinite(perCallTimeoutMs) && perCallTimeoutMs > 0
      ? perCallTimeoutMs
      : Number.isFinite(summarizerTimeoutMs) && summarizerTimeoutMs > 0
        ? summarizerTimeoutMs
        : undefined;
    // 超时只住这一发请求：子 controller + 父 signal 转发 + Promise.race，
    // 与 judge 拦截调用
    // （orchestrator 里的同形模板）一致；run 的 signal 不参与计时。
    let controller;
    let timer;
    let onParentAbort;
    // issue #486 P1-A：归因必须按「死线是否已到」判，不能按「哪个 promise 先 reject」。
    // 死线一到，先 `controller.abort()` 让请求收工 ⇒ **会尊重 signal 的真 provider** 立刻
    // 以 `AbortError` / `KitError(code="aborted")` 同步 reject，`Promise.race` 当场定型；
    // 带 `summarizer_timeout` 的那条腿晚一拍落地、无人认领，于是超时被记成 `error`。
    let deadlineFired = false;
    if (timeoutMs !== undefined) {
      controller = new AbortController();
      request.signal = controller.signal;
      timer = setTimeout(() => { deadlineFired = true; controller.abort(); }, timeoutMs);
      timer.unref?.();
      if (signal !== undefined && typeof signal.addEventListener === "function") {
        onParentAbort = () => controller.abort(signal?.reason);
        if (signal.aborted === true) onParentAbort();
        else signal.addEventListener("abort", onParentAbort, { once: true });
      }
    }
    let response;
    try {
      response = await (timeoutMs === undefined
        ? chat(request)
        : Promise.race([chat(request), timeoutRejection(timeoutMs, controller, serialized.dropped)]));
    } catch (error) {
      // issue #486 P1-A：死线先到、provider 自己回了 aborted 时，形状是
      // `KitError(code="aborted")` / `AbortError`——`classifyFoldDegradeKind` 认不出它。
      // 只在「死线已到 且 不是宿主 abort」时改写成 `summarizer_timeout`：宿主主动 abort
      // 属于 `error`（不是超时），不许被这条改写成 timeout。
      if (deadlineFired && (signal === undefined || signal.aborted !== true)) {
        throw timeoutError(timeoutMs, serialized.dropped);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onParentAbort !== undefined && typeof signal?.removeEventListener === "function") {
        signal.removeEventListener("abort", onParentAbort);
      }
    }
    const usage = response?.usage;
    if (usage !== undefined && typeof onUsage === "function") {
      try {
        onUsage(usage);
      } catch {
        // Observer failures must not affect compaction.
      }
    }
    if (typeof onMeta === "function") {
      try {
        // 今天 fold-llm **从不看**这次调用的结果状态：被 `max_tokens` 
        // 截成半截（finish_reason
        // ="length"）也当完整摘要吞下去。这里只负责**带出**，
        // 不在此处改变降级决定。
        // 位置在「空正文抛错」之前：空正文恰恰是最需要看到 
        // finish_reason 的那一种。
        onMeta({
          finishReason: response?.finish_reason ?? response?.stop_reason ?? response?.stopReason,
          // 注意括号：`a ?? b === undefined` 会被解析成 `a ?? (b === undefined)
          // `，
          // 于是三元的判据变成「有 token ⇒ 返回 
          // {}」——写反过一次，token 静默丢掉。
          ...((usage?.input_tokens ?? usage?.inputTokens) === undefined
            ? {}
            : { inputTokens: usage?.input_tokens ?? usage?.inputTokens }),
          ...((usage?.output_tokens ?? usage?.outputTokens) === undefined
            ? {}
            : { outputTokens: usage?.output_tokens ?? usage?.outputTokens }),
          estimatedInputTokens: estimateTokens(userContent),
          ...(serialized.dropped > 0
            ? { inputTruncated: true, droppedMessages: serialized.dropped, inputMessages: serialized.total }
            : {}),
        });
      } catch {
        // 同上：观察者失败不得影响折叠。
      }
    }
    const summary = textOfContent(response?.content).trim();
    if (summary === "") {
      throw new TypeError("default fold-llm summarizer returned no text");
    }
    return summary;
  };
}

// `code` / `droppedMessages` 不是 Error 
// 的声明字段——显式标注这个交叉类型，否则
// `--checkJs` 下挂字段就是 TS2339（同一个坑在 #469 原型上踩过）
// 。
function timeoutError(timeoutMs, dropped) {
  const error = /** @type {Error & { code?: string, droppedMessages?: number }} */ (
    new Error(`fold summarizer timed out after ${timeoutMs}ms`)
  );
  error.code = "summarizer_timeout";
  // 被裁过多少也带上：重试时 fold-llm 
  // 需要知道「已经裁到哪里」。
  error.droppedMessages = dropped > 0 ? dropped : 0;
  return error;
}

function timeoutRejection(timeoutMs, controller, dropped) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(timeoutError(timeoutMs, dropped));
    }, timeoutMs);
    timer.unref?.();
  });
}
