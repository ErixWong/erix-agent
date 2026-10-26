import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
import { enforceSize } from "./enforce-size.js";
import { extractAnchors } from "./anchors.js";
import { buildFoldFidelitySection } from "./fold-fidelity.js";
import {
  buildFoldNavigationRecord,
  stripAnchorSection,
  summarizeFoldedPayload,
} from "./fold-statistical.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  resolveFoldRecoveryHint,
  resolveFoldStubs,
  resolveRecoveryHint,
  runFoldHook,
  selectFoldedRounds,
} from "./helpers.js";

export function createSummarizerPromptGuide(recoveryHint) {
  const hint = resolveRecoveryHint(recoveryHint);
  return `请把被折叠轮次整理成可继续工作的日志，并严格使用以下分节：
## 阶段
说明已发生的工作阶段与关键转折。
## 已改文件
列出实际修改或新增的文件。
## 已验证项
列出已经运行并确认的测试、检查或其他证据。
## 下一步（含"已完成项禁止重做"）
只列出尚未完成的动作，并明确写出"已完成项禁止重做"。
## 主题词面包屑
列出后续检索原文所需的项目、文件、工具、错误和未结事项关键词。

恢复提示：${hint}

历史工具结果留痕规则：如果被折轮次包含恢复工具结果，记录工具名称、调用轮次、查询词和结论，且所有内容必须来自原文。`;
}

export const SUMMARIZER_PROMPT_GUIDE = createSummarizerPromptGuide();

function withRecoveryHint(summary, recoveryHint) {
  if (summary.includes(recoveryHint)) return summary;
  return `${summary}\n## 恢复提示\n${recoveryHint}`;
}

// 机械保真层（锚点索引 / 逐字引用 / 反向信号）在尺寸截断之后追加，
// 所以摘要预算削不掉它；没有抽到任何内容时不输出空小节。
// anchors:false 时跳过锚点节（其余保真层不变，向后兼容 0.7.0 关闭形态）。
function appendFoldFidelity(summary, foldedPayload, anchorSettings, onLayer) {
  const fidelity = buildFoldFidelitySection(foldedPayload, { anchors: anchorSettings });
  if (fidelity === undefined) return summary;
  onLayer?.({ layerId: "anchors" });
  return summary.trim() === "" ? fidelity : `${summary}\n\n${fidelity}`;
}

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
}

function normalizedSummaryTokens(value) {
  if (value === undefined) return 800;
  if (!Number.isFinite(value)) return 800;
  return Math.max(0, Math.floor(value));
}

function blocksFor(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content;
}

function isRealUser(message) {
  if (message?.role !== "user") return false;
  const blocks = blocksFor(message);
  return typeof message.content === "string"
    || blocks.length === 0
    || blocks.some((block) => block?.type !== "tool_result");
}

// anchors:false（评审终审修复）：对 head 全部消息的所有 text 块统一剥离锚点节——
// 定点清理只覆盖目标消息，summaryRole:"system" 或 role 切换时旧摘要落在另一 role 的
// 消息里会残留锚点节。复用 fold-statistical 的 stripAnchorSection，不复制实现；
// anchorsEnabled 缺省为 true 时 head 原样不动，行为与之前字节级一致（向后兼容）。
function stripAnchorsFromHead(head, anchorsEnabled) {
  if (anchorsEnabled) return head;
  return head.map((message) => {
    const content = typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message?.content)
        ? message.content
        : [];
    const stripped = content.flatMap((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") return [block];
      const text = stripAnchorSection(block.text);
      return text.trim() === "" ? [] : [{ ...block, text }];
    });
    return { ...message, content: stripped };
  });
}

function prependSummary(head, summary, summaryRole = "user", anchorsEnabled = true) {
  const strippedHead = stripAnchorsFromHead(head, anchorsEnabled);
  if (summaryRole === "system") {
    const systemIndex = strippedHead.findLastIndex((message) => message?.role === "system");
    if (systemIndex < 0) {
      return [
        { role: "system", content: [{ type: "text", text: summary }] },
        ...strippedHead,
      ];
    }
    const updatedHead = strippedHead.slice();
    const system = updatedHead[systemIndex];
    const content = typeof system.content === "string"
      ? [{ type: "text", text: system.content }]
      : Array.isArray(system.content) ? system.content : [];
    updatedHead[systemIndex] = {
      ...system,
      content: [{ type: "text", text: summary }, ...content],
    };
    return updatedHead;
  }
  const userIndex = strippedHead.findLastIndex(isRealUser);
  if (userIndex < 0) return strippedHead;

  const user = strippedHead[userIndex];
  const originalContent = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content)
      ? user.content
      : [];
  const updatedHead = strippedHead.slice();
  updatedHead[userIndex] = {
    ...user,
    content: [{ type: "text", text: summary }, ...originalContent],
  };
  return updatedHead;
}

function priorityForHeading(heading) {
  if (heading.includes("下一步")) return 0;
  if (heading.includes("恢复提示")) return 0;
  if (heading.includes("已验证项")) return 1;
  if (heading.includes("已改文件")) return 2;
  if (heading.includes("主题词")) return 3;
  return 4;
}

function sectionsFromSummary(summary) {
  const headings = [...summary.matchAll(/^## .*(?:\r?\n|$)/gm)];
  if (headings.length === 0) return null;

  const fields = [];
  const firstHeading = headings[0].index;
  if (firstHeading > 0 && summary.slice(0, firstHeading).trim().length > 0) {
    fields.push({
      key: "phase-preamble",
      text: summary.slice(0, firstHeading),
      priority: 4,
    });
  }

  headings.forEach((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? summary.length;
    fields.push({
      key: `section-${index}`,
      text: summary.slice(start, end),
      priority: priorityForHeading(heading[0]),
    });
  });

  return fields;
}

function renderFields(fields) {
  let output = "";
  for (const field of fields) {
    if (output.length > 0 && !output.endsWith("\n") && !field.text.startsWith("\n")) {
      output += "\n";
    }
    output += field.text;
  }
  return output;
}

function truncatedMarkerForBudget(budgetTokens) {
  const marker = "[摘要已整体截断]";
  if (estimateTokens(marker) <= budgetTokens) return marker;
  const shorterMarker = "[已截断]";
  if (estimateTokens(shorterMarker) <= budgetTokens) return shorterMarker;
  return marker;
}

function prefixWithinBudget(text, suffix, budgetTokens) {
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  let best = "";

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = characters.slice(0, middle).join("");
    const candidate = prefix.length > 0 ? `${prefix}\n${suffix}` : suffix;
    if (estimateTokens(candidate) <= budgetTokens) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function truncateWholeSummary(summary, budgetTokens) {
  if (estimateTokens(summary) <= budgetTokens) return summary;

  const marker = truncatedMarkerForBudget(budgetTokens);
  const prefix = prefixWithinBudget(summary, marker, budgetTokens);
  return prefix.length > 0 ? `${prefix}\n${marker}` : marker;
}

function enforceSummarySize(summary, maxSummaryTokens, onLayer) {
  const tokensBefore = estimateTokens(summary);
  const fields = sectionsFromSummary(summary);
  if (fields === null) {
    const rendered = truncateWholeSummary(summary, maxSummaryTokens);
    onLayer?.({
      layerId: "enforceSize",
      tokensBefore,
      tokensAfter: estimateTokens(rendered),
    });
    return rendered;
  }

  const enforced = enforceSize(fields, maxSummaryTokens);
  const rendered = renderFields(enforced.fields);
  const bounded = truncateWholeSummary(rendered, maxSummaryTokens);
  onLayer?.({
    layerId: "enforceSize",
    tokensBefore,
    tokensAfter: estimateTokens(bounded),
  });
  return bounded;
}

/**
 * Create an LLM-backed whole-round folding strategy.
 *
 * issue #469-②：`maxSummarizerInputTokens` 是交给 summarizer 
 * 的被折消息上限（token），
 * 不传 ⇒ 不裁（旧行为）；超窗失败（网关 400）
 * 无论配不配都会**带更短的输入重试一次**再降级。
 * 说明写在这里而不是类型字面量内部：JSDoc 
 * 的类型字面量里不能写 `//` 注释行，否则
 * `TS1131` 会把整块类型打断（这条坑在本文件与 `provider-summarizer.js` 
 * 各踩过一次）。
 *
 * @param {{
 *   summarizer: (input: {messages: object[], roundRange: {from:number, to:number}}) => Promise<string>|string,
 *   maxSummaryTokens?: number,
 *   maxSummarizerInputTokens?: number,
 *   summaryRole?: "user"|"system",
 *   recoveryHint?: string,
 *   protectedMessage?: Function|string|string[],
 *   stripHistoricalImages?: boolean,
 *   onBeforeFold?: Function,
 *   onAfterFold?: Function,
 * }} options
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: {keepRounds?: number, budgetTokens?: number}) => Promise<object>,
 * }}
 */
export function createFoldLlmStrategy({
  summarizer,
  maxSummaryTokens = 800,
  ...options
} = {}) {
  if (typeof summarizer !== "function") {
    throw new TypeError("fold-llm summarizer must be a function");
  }
  const summaryBudget = normalizedSummaryTokens(maxSummaryTokens);
  // issue #469-③：本实例**上一次真喂进上下文**的折叠摘要（LLM 或统计降级都算），
  // 下一次折叠把它当续写基底；宿主 / resume 可用 `previousSummary` 覆盖。
  let lastFoldSummaryText;

  return {
    name: "fold-llm",

    shouldCompact(messages, budgetTokens) {
      return estimateMessageTokens(messages) > budgetTokens;
    },

    async compact(messages, callOptions = {}) {
      const tokensBefore = estimateMessageTokens(messages);
      const { head, rounds } = groupIntoRounds(messages);
      const settings = foldOptions(options, callOptions);
      const keep = normalizedKeepRounds(
        optionValue(callOptions, options, "keepRounds", undefined),
      );
      const { folded, retained, foldedIndexes } = selectFoldedRounds(
        rounds,
        keep,
        settings.protectedMessage,
      );
      const foldedPayload = cloneFoldPayload(
        folded.flatMap((round) => round.messages),
        settings.stripHistoricalImages,
      );
      const roundRange = roundRangeForIndexes(
        foldedIndexes,
        settings.roundOffset,
        settings.roundNumbers,
      );
      const recoveryHint = await resolveFoldRecoveryHint(settings.recoveryHint, {
        foldedPayload,
        folded,
        retained,
        roundRange,
      });
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });

      let compactedHead = head;
      // issue #470（A1）：本次折叠的**机械替代物**与**LLM 摘要在场标记**（进账本用，不进消息流）。
      /** @type {{ source: string, text?: string, degradeReason?: string }|undefined} */
      let foldSummary = undefined;
      if (folded.length > 0) {
        const range = roundRange ?? { from: 1, to: folded.length };
        // 降级摘要的恢复信息（评审修复）：与 fold-statistical 共用 resolveFoldStubs /
        // buildFoldNavigationRecord（复用不复制），保证降级摘要不比原生统计摘要少
        // `[已折叠] …` stub 与 artifact 导航记录。
        const foldedStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
        const navigationRecord = buildFoldNavigationRecord(foldedPayload, range);
        // 降级兜底（issue #33 D）：summarizer 运行时失败（reject/throw）不再让 run 中途死亡，
        // 改为对同一 foldedPayload 生成统计摘要并加可识别降级标记；
        // 构造期参数错误（summarizer 非函数）在 createFoldLlmStrategy 里已 fail-loud，不经此路径。
        let summary;
        let degradeReason;
        // issue #469-①②③：失败不再是「一条 `slice(0,120)` 字符串」。
        // 分类后：可自愈的先重试，
        // 不可自愈的把**原因类型**留到账上（timeout / 
        // context_window_exceeded / error）。
        let degradeKind;
        let droppedInputMessages = 0;
        const prior = normalizePriorSummary(
          optionValue(callOptions, options, "previousSummary", lastFoldSummaryText),
          normalizedLimit(
            optionValue(callOptions, options, "maxPriorSummaryBytes", DEFAULT_PRIOR_SUMMARY_MAX_BYTES),
          ),
        );
        const summarizerOutcome = await callSummarizerWithBound({
          summarizer,
          payload: foldedPayload,
          roundRange: range,
          recoveryHint,
          priorSummary: prior.text,
          budgetMs: normalizedLimit(
            optionValue(callOptions, options, "summarizerBudgetMs", DEFAULT_SUMMARIZER_BUDGET_MS),
          ),
          inputBoundBytes: normalizedLimit(
            optionValue(
              callOptions,
              options,
              "maxSummarizerInputBytes",
              DEFAULT_SUMMARIZER_INPUT_MAX_BYTES,
            ),
          ),
          inputBoundTokens: normalizedInputBound(
            optionValue(callOptions, options, "maxSummarizerInputTokens", undefined),
          ),
        });
        summary = summarizerOutcome.summary;
        degradeReason = summarizerOutcome.degradeReason;
        degradeKind = summarizerOutcome.degradeKind;
        droppedInputMessages = summarizerOutcome.droppedMessages;
        const fallbackAnchors = summary === undefined && settings.anchors !== false
          ? extractAnchors(
            foldedPayload,
            settings.anchors && typeof settings.anchors === "object" ? settings.anchors : {},
          )
          : undefined;
        if (summary === undefined && fallbackAnchors?.text !== "") {
          settings.onLayer?.({ layerId: "anchors" });
        }
        const statisticalFallbackText = summary === undefined
          ? summarizeFoldedPayload(foldedPayload, {
            from: range.from,
            to: range.to,
            count: folded.length,
            recoveryHint,
            stubs: foldedStubs,
            ...(navigationRecord === undefined ? {} : { navigationRecord }),
            ...(settings.anchors === false
              ? {}
              : { anchors: fallbackAnchors }),
          })
          : undefined;
        const compactedSummary = summary === undefined
          ? `[fold-llm 摘要失败，已降级为统计摘要（原因: ${degradeReason}）]\n`
            + statisticalFallbackText
          : appendFoldFidelity(
            enforceSummarySize(
              withRecoveryHint(summary, recoveryHint),
              summaryBudget,
              settings.onLayer,
            ),
            foldedPayload,
            settings.anchors,
            settings.onLayer,
          );
        // #470：`source` 说清「交给模型的那份是 LLM 
        // 摘要还是机械降级」；降级时 `text` 就是
        // 那份机械文本（上面已经算过，不重负）；LLM 成功时不重造摘要，由引擎投影实际喂出去那份。
        // ③ 的续写基底：记下这次真进了上下文的那份（下一轮折叠的「上一份」）。
        lastFoldSummaryText = compactedSummary;
        foldSummary = {
          source: summary === undefined ? "statistical" : "llm",
          ...(statisticalFallbackText === undefined ? {} : { text: statisticalFallbackText }),
          ...(degradeReason === undefined ? {} : { degradeReason }),
          ...(degradeKind === undefined ? {} : { degradeKind }),
          ...(prior.truncated ? { priorSummaryTruncated: true, priorSummaryBytes: prior.bytes } : {}),
          ...(prior.bytes > 0 && !prior.truncated ? { priorSummaryBytes: prior.bytes } : {}),
          ...(summarizerOutcome.droppedRounds > 0
            ? { droppedRounds: summarizerOutcome.droppedRounds }
            : {}),
          ...(summarizerOutcome.attempts > 1 ? { attempts: summarizerOutcome.attempts } : {}),
          ...(summarizerOutcome.budgetExhausted === true ? { budgetExhausted: true } : {}),
          ...(droppedInputMessages > 0
            ? { inputTruncated: true, droppedMessages: droppedInputMessages }
            : {}),
        };
        compactedHead = prependSummary(
          head,
          compactedSummary,
          settings.summaryRole,
          settings.anchors !== false,
        );
      }

      const compactedMessages = [
        ...compactedHead,
        ...retained.flatMap((round) => round.messages),
      ];
      const tokensAfter = estimateMessageTokens(compactedMessages);

      const result = {
        messages: compactedMessages,
        compacted: folded.length > 0,
        foldedRounds: folded.length,
        tokensBefore,
        tokensAfter,
        foldedPayload,
        ...(roundRange === undefined ? {} : { foldedRoundRange: roundRange }),
        ...(foldSummary === undefined ? {} : { foldSummary }),
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}

/**
 * issue #469-①：降级原因分类。今天超时（无任何阀门）、
 * 超窗（网关 400）、普通报错**三堆塌成
 * 同一条文案**，
 * 所以宿主从记录上分不出「这次降级本可以自愈」还是「摘要器真
 * 的挂了」。
 * 只分类不改文案（`degradeReason` 原文照旧保留，以免动既有断言）
 * 。
 *
 * @param {*} error 可以是 Error / 带 `code` 的自定义错 / 
 * 字符串（降级路径上什么都会抛上来）
 * @returns {"timeout"|"context_window_exceeded"|"error"}
 */
export function classifyFoldDegradeKind(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "summarizer_timeout" || code === "ETIMEDOUT" || code === "TIMEOUT") {
    return "timeout";
  }
  const message = String(error?.message ?? error ?? "");
  if (/maximum context length|context_length_exceeded|context window|ContextWindowExceeded|is longer than configured context length|input length|too many tokens/i.test(message)) {
    return "context_window_exceeded";
  }
  return "error";
}

const TRIM_NOTE_RESERVE_TOKENS = 48;
const MIN_RETRY_INPUT_TOKENS = 256;
// issue #469-③（宿主裁决 2026-10-26）：喂给摘要器的**窗口**用字节上限 48 KB，
// 超了按**整轮**从旧到新截，绝不截断单轮中部——半条工具输出比没有更容易被误信。
const DEFAULT_SUMMARIZER_INPUT_MAX_BYTES = 48 * 1024;
// 「上一份折叠摘要」是续写基底，单独计预算：24 KB，超了从**头部**截（保留最近部分），
// 且截断事实必须留痕（否则「脉络断了」和「本来就没有」分不开）。
const DEFAULT_PRIOR_SUMMARY_MAX_BYTES = 24 * 1024;
// issue #469-②（宿主裁决）：整个摘要步骤（含超窗自愈那一发）共用一条 30 s 死线；
// 剩余时间不足一个最小尝试窗口就不再重试——30 s 是硬上限，不是每次尝试的上限。
const DEFAULT_SUMMARIZER_BUDGET_MS = 30_000;
const MIN_RETRY_REMAINING_MS = 2_000;

function normalizedInputBound(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizedLimit(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** * 重试用的上限：配了就配的一半，没配就当前输入的一半；
/** 剩一条以下无从再减 ⇒ 不重试。 */
function retryBoundFor(configuredBound, messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return undefined;
  const current = configuredBound ?? estimateMessageTokens(messages);
  const next = Math.floor(current / 2);
  return next >= MIN_RETRY_INPUT_TOKENS ? next : undefined;
}

function bytesOf(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

/** 窗口正文的字节量：角色开销按 16 字节/条粗算，宁可高估也不低估。 */
function payloadBytes(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const body = typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message?.content ?? "");
    total += 16 + bytesOf(body);
  }
  return total;
}

function omissionNote(droppedRounds, droppedMessages, total) {
  const scope = droppedRounds > 0
    ? `前 ${droppedRounds} 轮最旧消息`
    : `前 ${droppedMessages} 条最旧消息`;
  return {
    role: "user",
    __omissionNote: true,
    content: [{
      type: "text",
      text: `（为守住摘要器输入上限，${scope}已省略，共 ${total} 条）`,
    }],
  };
}

/** 只丢整条消息（token 层、窗口护栏），不加省略注。 */
function trimOldestMessages(list, maxTokens) {
  const target = Math.max(1, maxTokens - TRIM_NOTE_RESERVE_TOKENS);
  let start = 0;
  while (start < list.length - 1 && estimateMessageTokens(list.slice(start)) > target) {
    start += 1;
  }
  return start === 0
    ? { messages: list, dropped: 0 }
    : { messages: list.slice(start), dropped: start };
}

/**
 * issue #469-③：两层裁剪——先按裁决（整轮 / 字节），再按窗口护栏（整条 / token）。
 * 无论哪层丢过东西都要留一条省略注：既裁了又不告诉模型（和人），是最坏的一种。
 */
function trimFoldedPayloadToLimits(payload, limits = {}) {
  const list = Array.isArray(payload) ? payload : [];
  if (list.length === 0) return { messages: list, dropped: 0, droppedRounds: 0 };
  let kept = list;
  let droppedRounds = 0;
  if (Number.isFinite(limits.maxBytes) && limits.maxBytes > 0 && payloadBytes(kept) > limits.maxBytes) {
    const { rounds } = groupIntoRounds(kept);
    let start = 0;
    while (start < rounds.length - 1
      && payloadBytes(rounds.slice(start).flatMap((round) => round.messages)) > limits.maxBytes) {
      start += 1;
    }
    if (start > 0) {
      kept = rounds.slice(start).flatMap((round) => round.messages);
      droppedRounds = start;
    }
  }
  let droppedMessages = list.length - kept.length;
  if (Number.isFinite(limits.maxTokens) && limits.maxTokens > 0
    && estimateMessageTokens(kept) > limits.maxTokens) {
    const tokenTrimmed = trimOldestMessages(kept, limits.maxTokens);
    kept = tokenTrimmed.messages;
    droppedMessages += tokenTrimmed.dropped;
  }
  if (droppedMessages === 0) return { messages: list, dropped: 0, droppedRounds: 0 };
  return {
    messages: [omissionNote(droppedRounds, droppedMessages, list.length), ...kept],
    dropped: droppedMessages,
    droppedRounds,
  };
}

/**
 * issue #469-③：上一份折叠摘要按 24 KB 从**头部**截（保留最近部分），
 * 返回截断后的文本与入账用的事实。
 */
function normalizePriorSummary(value, maxBytes) {
  if (typeof value !== "string" || value.trim() === "") {
    return { text: undefined, bytes: 0, truncated: false };
  }
  const bytes = bytesOf(value);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) {
    return { text: value, bytes, truncated: false };
  }
  const marker = "（上一份折叠摘要超出上限，头部已截断，保留最近部分）\n";
  const keep = Math.max(0, Math.floor(maxBytes) - bytesOf(marker));
  const buffer = Buffer.from(value, "utf8");
  const tail = buffer.subarray(Math.max(0, buffer.length - keep)).toString("utf8");
  return { text: `${marker}${tail.replace(/^\uFFFD+/u, "")}`, bytes, truncated: true };
}

/**
 * issue #469-①②③：一次折叠的摘要步骤。
 *   · 首发与（仅超窗时允许的）自愈重试共享一条 `budgetMs` 死线；
 *   · **超时绝不重试**（宿主裁决 ②：重试只是把一次卡顿变成两次）；
 *   · 失败不抛（沿用 #33 D 降级语义），把分类后的原因与预算事实带回去。
 */
async function callSummarizerWithBound({
  summarizer,
  payload,
  roundRange,
  recoveryHint,
  inputBoundTokens,
  inputBoundBytes,
  priorSummary,
  budgetMs,
}) {
  const promptGuide = createSummarizerPromptGuide(recoveryHint);
  const deadlineAt = Number.isFinite(budgetMs) && budgetMs > 0 ? Date.now() + budgetMs : undefined;
  const remaining = () => (deadlineAt === undefined ? undefined : deadlineAt - Date.now());
  const invoke = (messages) => {
    const left = remaining();
    return summarizer({
      messages,
      roundRange,
      recoveryHint,
      promptGuide,
      ...(priorSummary === undefined ? {} : { priorSummary }),
      ...(left === undefined ? {} : { timeoutMs: Math.max(1, left) }),
    });
  };
  const fail = (error, droppedMessages, extra = {}) => ({
    degradeKind: classifyFoldDegradeKind(error),
    degradeReason: String(error?.message ?? error).slice(0, 120),
    droppedMessages,
    droppedRounds: 0,
    attempts: 1,
    ...extra,
  });
  const first = trimFoldedPayloadToLimits(payload, {
    maxBytes: inputBoundBytes,
    maxTokens: inputBoundTokens,
  });
  const limitPart = first.droppedRounds > 0 ? { droppedRounds: first.droppedRounds } : {};
  try {
    const summary = await invoke(first.messages);
    if (typeof summary !== "string") {
      throw new TypeError("fold-llm summarizer must return a string");
    }
    return { summary, droppedMessages: first.dropped, attempts: 1, ...limitPart };
  } catch (error) {
    if (classifyFoldDegradeKind(error) !== "context_window_exceeded") {
      return fail(error, first.dropped, limitPart);
    }
    const left = remaining();
    if (left !== undefined && left < MIN_RETRY_REMAINING_MS) {
      // 预算不够一次有意义的尝试：降级，并把「不是自愈不了，是没时间」写清楚。
      return fail(error, first.dropped, { ...limitPart, budgetExhausted: true });
    }
    const retryBound = retryBoundFor(inputBoundTokens, first.messages);
    if (retryBound === undefined) return fail(error, first.dropped, limitPart);
    const retry = trimBeforeRetry(first.messages, retryBound);
    if (retry.dropped === 0 && retry.collapsed === 0) return fail(error, first.dropped, limitPart);
    try {
      const retrySummary = await invoke(retry.messages);
      if (typeof retrySummary !== "string") {
        throw new TypeError("fold-llm summarizer must return a string");
      }
      return {
        summary: retrySummary,
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        attempts: 2,
        retried: true,
        ...limitPart,
      };
    } catch (retryError) {
      // 重试又失败：若仍是超窗，原因仍记超窗（否则会被普通错误掩盖）。
      const kind = classifyFoldDegradeKind(retryError);
      return {
        degradeKind: kind === "error" ? "context_window_exceeded" : kind,
        degradeReason: String(retryError?.message ?? retryError).slice(0, 120),
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        droppedRounds: first.droppedRounds,
        attempts: 2,
        ...limitPart,
      };
    }
  }
}

/**
 * 重试前再收一次输入：首发加上去的那条省略注先塌掉（`collapsed`），
 * 再按 token 上限丢整条消息（`dropped`）。两个数分开记，
 * 免得把「注变短了」当成「丢了一条消息」。
 */
function trimBeforeRetry(messages, maxTokens) {
  const list = Array.isArray(messages) ? messages : [];
  const hasNote = list.length > 0 && list[0]?.__omissionNote === true;
  const body = hasNote ? list.slice(1) : list;
  const trimmed = trimOldestMessages(body, maxTokens);
  return {
    messages: trimmed.messages,
    dropped: trimmed.dropped,
    collapsed: hasNote ? 1 : 0,
  };
}

