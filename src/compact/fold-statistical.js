import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  runFoldHook,
  selectFoldedRounds,
  isRealUser,
} from "./helpers.js";

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
}

function blocksFor(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content;
}

function toolFootprint(rounds) {
  const counts = new Map();

  for (const round of rounds) {
    for (const message of round.messages) {
      for (const block of blocksFor(message)) {
        if (block?.type !== "tool_use") continue;
        const name = String(block.name ?? "");
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  if (counts.size === 0) return "无";

  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

function parseToolFootprint(value) {
  const counts = new Map();
  if (value === "无") return counts;
  for (const match of String(value).matchAll(/([^,]+)×(\d+)/gu)) {
    const name = match[1].trim();
    const count = Number.parseInt(match[2], 10);
    if (name && Number.isSafeInteger(count)) {
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
  }
  return counts;
}

function parseFoldSummary(text) {
  const match = String(text).match(
    /^【上下文折叠】早期第 (\d+)–(\d+) 轮（共 (\d+) 轮）已折叠。工具足迹：(.*?)。可用 recall\(/u,
  );
  if (!match) return undefined;
  return {
    from: Number.parseInt(match[1], 10),
    to: Number.parseInt(match[2], 10),
    count: Number.parseInt(match[3], 10),
    tools: parseToolFootprint(match[4]),
  };
}

function formatFoldSummary({ from, to, count, tools }) {
  const footprint = tools.size === 0
    ? "无"
    : [...tools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
  return [
    `【上下文折叠】早期第 ${from}–${to} 轮（共 ${count} 轮）已折叠。`,
    `工具足迹：${footprint}。`,
    `可用 recall(pattern: "关键词") 搜回细节，或 recall(fromRound: ${from}, toRound: ${to}) 取原文（大段可能截断，优先关键词）。`,
  ].join("");
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
  const summaries = originalContent
    .filter((block) => block?.type === "text")
    .map((block) => parseFoldSummary(block.text))
    .filter((parsed) => parsed !== undefined);
  const current = parseFoldSummary(summary);
  const merged = [...summaries, current].filter((parsed) => parsed !== undefined);
  const mergedSummary = merged.length === 0
    ? summary
    : formatFoldSummary({
      from: Math.min(...merged.map((parsed) => parsed.from)),
      to: Math.max(...merged.map((parsed) => parsed.to)),
      count: merged.reduce((total, parsed) => total + parsed.count, 0),
      tools: merged.reduce((counts, parsed) => {
        for (const [name, count] of parsed.tools) {
          counts.set(name, (counts.get(name) ?? 0) + count);
        }
        return counts;
      }, new Map()),
    });
  const contentWithoutSummaries = originalContent.filter((block) => (
    block?.type !== "text" || parseFoldSummary(block.text) === undefined
  ));
  const updatedHead = head.slice();
  updatedHead[userIndex] = {
    ...user,
    // 合并后的单段摘要放 content 最前：模型先看到折叠提示，任务原文紧跟其后；
    // （safeTruncate 同消息字段按 index 截断，任务在后可避免被先截成 [已修剪]）
    content: [{ type: "text", text: mergedSummary }, ...contentWithoutSummaries],
  };
  return updatedHead;
}

/**
 * Create the deterministic statistical folding strategy.
 *
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: object) => Promise<object>
 * }}
 */
export function createFoldStatisticalStrategy(options = {}) {
  return {
    name: "fold-statistical",

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
        const range = roundRange ?? { from: 1, to: folded.length };
        const summary = [
          `【上下文折叠】早期第 ${range.from}–${range.to} 轮（共 ${folded.length} 轮）已折叠。`,
          `工具足迹：${toolFootprint(folded)}。`,
          `可用 recall(pattern: "关键词") 搜回细节，或 recall(fromRound: ${range.from}, toRound: ${range.to}) 取原文（大段可能截断，优先关键词）。`,
        ].join("");
        compactedHead = prependSummary(head, summary, settings.summaryRole);
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
