import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  runFoldHook,
  selectFoldedRounds,
} from "./helpers.js";

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
}

function compactRounds(messages, keepRounds) {
  const { head, rounds } = groupIntoRounds(messages);
  const keep = normalizedKeepRounds(keepRounds);
  const foldedCount = Math.max(0, rounds.length - keep);
  const folded = rounds.slice(0, foldedCount);
  const retained = rounds.slice(foldedCount);
  const foldedPayload = folded.flatMap((round) => round.messages);
  const compactedMessages = [
    ...head,
    ...retained.flatMap((round) => round.messages),
  ];

  return {
    compactedMessages,
    folded,
    foldedPayload,
  };
}

/**
 * Create the whole-round sliding-window compaction strategy.
 *
 * @returns {{
 *   name: string,
 *   shouldCompact: (messages: object[], budgetTokens: number) => boolean,
 *   compact: (messages: object[], options?: object) => Promise<object>
 * }}
 */
export function createSlidingWindowStrategy(options = {}) {
  return {
    name: "sliding-window",

    shouldCompact(messages, budgetTokens) {
      return estimateMessageTokens(messages) > budgetTokens;
    },

    async compact(messages, callOptions = {}) {
      const tokensBefore = estimateMessageTokens(messages);
      const settings = foldOptions(options, callOptions);
      const { head, rounds } = groupIntoRounds(messages);
      const keepRounds = normalizedKeepRounds(
        optionValue(callOptions, options, "keepRounds", undefined),
      );
      const { folded, retained, foldedIndexes } = selectFoldedRounds(
        rounds,
        keepRounds,
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
      const compactedMessages = [
        ...head,
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
