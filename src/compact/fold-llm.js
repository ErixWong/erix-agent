import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
import { enforceSize } from "./enforce-size.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  runFoldHook,
  selectFoldedRounds,
} from "./helpers.js";

export const SUMMARIZER_PROMPT_GUIDE = `请把被折叠轮次整理成可继续工作的日志，并严格使用以下分节：
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

recall 留痕规则：如果被折轮次包含 recall 工具结果，记录"已于第 X 轮 recall 过 '<pattern>'（结论：…）"，其中 X、pattern 和结论必须来自原文。
末尾 recall 指引：最后写"早期轮次已折叠，可用 recall(pattern: \"关键词\") 搜回细节，或 recall(fromRound: a, toRound: b) 取原文（大段可能截断，优先关键词）"，并将 a、b 替换为本次实际折叠范围。`;

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

function prependSummary(head, summary, summaryRole = "user") {
  if (summaryRole === "system") {
    const systemIndex = head.findLastIndex((message) => message?.role === "system");
    if (systemIndex < 0) {
      return [{ role: "system", content: [{ type: "text", text: summary }] }, ...head];
    }
    const updatedHead = head.slice();
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
  const userIndex = head.findLastIndex(isRealUser);
  if (userIndex < 0) return head;

  const user = head[userIndex];
  const originalContent = typeof user.content === "string"
    ? [{ type: "text", text: user.content }]
    : Array.isArray(user.content)
      ? user.content
      : [];
  const updatedHead = head.slice();
  updatedHead[userIndex] = {
    ...user,
    content: [{ type: "text", text: summary }, ...originalContent],
  };
  return updatedHead;
}

function priorityForHeading(heading) {
  if (heading.includes("下一步")) return 0;
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

function enforceSummarySize(summary, maxSummaryTokens) {
  const fields = sectionsFromSummary(summary);
  if (fields === null) {
    return truncateWholeSummary(summary, maxSummaryTokens);
  }

  const enforced = enforceSize(fields, maxSummaryTokens);
  const rendered = renderFields(enforced.fields);
  return truncateWholeSummary(rendered, maxSummaryTokens);
}

/**
 * Create an LLM-backed whole-round folding strategy.
 *
 * @param {{
 *   summarizer: (input: {messages: object[], roundRange: {from:number, to:number}}) => Promise<string>|string,
 *   maxSummaryTokens?: number,
 *   summaryRole?: "user"|"system",
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
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });

      let compactedHead = head;
      if (folded.length > 0) {
        const summary = await summarizer({
          messages: foldedPayload,
          roundRange: roundRange ?? { from: 1, to: folded.length },
        });
        if (typeof summary !== "string") {
          throw new TypeError("fold-llm summarizer must return a string");
        }
        const compactedSummary = enforceSummarySize(summary, summaryBudget);
        compactedHead = prependSummary(head, compactedSummary, settings.summaryRole);
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
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}
