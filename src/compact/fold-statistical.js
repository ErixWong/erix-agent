import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens } from "../tokens.js";

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
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

function prependSummary(head, summary) {
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

/**
 * Create the deterministic statistical folding strategy.
 *
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: object) => Promise<object>
 * }}
 */
export function createFoldStatisticalStrategy() {
  return {
    name: "fold-statistical",

    shouldCompact(messages, budgetTokens) {
      return estimateMessageTokens(messages) > budgetTokens;
    },

    async compact(messages, { keepRounds } = {}) {
      const tokensBefore = estimateMessageTokens(messages);
      const { head, rounds } = groupIntoRounds(messages);
      const keep = normalizedKeepRounds(keepRounds);
      const foldedCount = Math.max(0, rounds.length - keep);
      const folded = rounds.slice(0, foldedCount);
      const retained = rounds.slice(foldedCount);
      const foldedPayload = folded.flatMap((round) => round.messages);

      let compactedHead = head;
      if (folded.length > 0) {
        const summary = [
          `【上下文折叠】早期第 1–${folded.length} 轮（共 ${folded.length} 轮）已折叠。`,
          `工具足迹：${toolFootprint(folded)}。`,
          `可用 recall(pattern: "关键词") 搜回细节，或 recall(fromRound: 1, toRound: ${folded.length}) 取原文（大段可能截断，优先关键词）。`,
        ].join("");
        compactedHead = prependSummary(head, summary);
      }

      const compactedMessages = [
        ...compactedHead,
        ...retained.flatMap((round) => round.messages),
      ];
      const tokensAfter = estimateMessageTokens(compactedMessages);

      return {
        messages: compactedMessages,
        compacted: folded.length > 0,
        foldedRounds: folded.length,
        tokensBefore,
        tokensAfter,
        foldedPayload,
      };
    },
  };
}
