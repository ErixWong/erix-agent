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
import { buildFoldNavigationRecord } from "./fold-statistical.js";
import { validateResourceStore } from "../store/resource.js";

async function materializeFoldResources(messages, resourceStore) {
  if (resourceStore === undefined) return messages;
  const store = validateResourceStore(resourceStore);
  return Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = await Promise.all(message.content.map(async (block) => {
      if (!block?.artifact || typeof block.artifact !== "object"
        || block.artifact.resource === undefined) {
        return block;
      }
      const reference = await store.put(block.artifact.resource);
      const { resource: _resource, ...artifact } = block.artifact;
      changed = true;
      return { ...block, artifact: { ...artifact, ...reference } };
    }));
    return changed ? { ...message, content } : message;
  }));
}

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
      );
      const foldedPayload = await materializeFoldResources(cloneFoldPayload(
        folded.flatMap((round) => round.messages),
        settings.stripHistoricalImages,
      ), settings.resourceStore);
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
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });

      return result;
    },
  };
}
