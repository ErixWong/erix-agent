import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  cloneFoldPayload,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  runFoldHook,
  appendFoldStubsToHead,
  selectFoldedRounds,
  resolveFoldStubs,
} from "./helpers.js";
import { buildFoldNavigationRecord, summarizeFoldedPayload } from "./fold-statistical.js";

function normalizedKeepRounds(value) {
  if (value === undefined) return 6;
  if (!Number.isFinite(value)) return 6;
  return Math.max(0, Math.floor(value));
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
        // issue #608：工作集地板（`0` = 关闭，引擎显式开成 `WORKING_SET_RECENT_ROUNDS`）。
        settings.workingSetRecentRounds,
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
      const navigationRecord = buildFoldNavigationRecord(
        foldedPayload,
        roundRange ?? (folded.length > 0 ? { from: 1, to: folded.length } : undefined),
      );
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });
      const foldedStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
      // issue #470（C 档，零 LLM）：这一档此前**任何摘要文本都不产** ⇒ 账本上除了计数什么都没有。
      // 现在用现成零件（范围句 + 工具足迹 + stub + 导航记录）现算一份，**只用于落账**：
      // 它不 prepend 进 `compactedMessages` ⇒ 模型输入逐字不变（判据：见 `test/compact/folded-facts.test.js`）。
      const foldedSummaryText = folded.length > 0
        ? summarizeFoldedPayload(foldedPayload, {
          from: roundRange?.from ?? 1,
          to: roundRange?.to ?? folded.length,
          count: folded.length,
          recoveryHint: settings.recoveryHint,
          stubs: foldedStubs,
          ...(navigationRecord === undefined ? {} : { navigationRecord }),
        })
        : undefined;
      const compactedMessages = [
        ...appendFoldStubsToHead(head, foldedStubs),
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
        ...(navigationRecord === undefined ? {} : { navigationRecord }),
        ...(foldedSummaryText === undefined ? {} : { foldedSummaryText }),
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });

      return result;
    },
  };
}
