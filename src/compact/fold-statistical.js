import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  cloneFoldPayload,
  DEFAULT_RECOVERY_HINT,
  foldOptions,
  optionValue,
  roundRangeForIndexes,
  resolveFoldStubs,
  runFoldHook,
  resolveFoldRecoveryHint,
  resolveRecoveryHint,
  selectFoldedRounds,
  isRealUser,
} from "./helpers.js";

export const FOLD_SUMMARY_MARKER = "【上下文折叠·v1·erix-9f6e2c】";
const MAX_NAVIGATION_ARTIFACTS = 10;
const MAX_NAVIGATION_CHARS = 400;

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

function safeNavigationId(value) {
  const basename = String(value ?? "").split(/[\\/]/u).at(-1) ?? "";
  return basename.replaceAll(/[^\p{L}\p{N}._:-]/gu, "_").slice(0, 80);
}

function safeNavigationLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const locator = {};
  for (const key of ["lineStart", "lineEnd", "byteStart", "byteEnd"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) {
      locator[key] = value[key];
    }
  }
  return locator;
}

function boundedNavigationRecord(roundRange, artifacts) {
  if (!roundRange || !Number.isSafeInteger(roundRange.from)
    || !Number.isSafeInteger(roundRange.to) || artifacts.length === 0) {
    return undefined;
  }

  const unique = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") continue;
    const id = safeNavigationId(artifact.id);
    const digest = String(artifact.digest ?? "").slice(0, 128);
    if (!id || !digest) continue;
    const key = `${id}\u0000${digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      id,
      locator: safeNavigationLocator(artifact.locator),
      digest,
      status: artifact.status === "truncated" ? "truncated" : "archived",
    });
  }
  if (unique.length === 0) return undefined;

  let visible = unique.slice(0, MAX_NAVIGATION_ARTIFACTS);
  let truncated = visible.length < unique.length;
  const makeRecord = () => ({
    roundFrom: roundRange.from,
    roundTo: roundRange.to,
    artifacts: visible,
    ...(truncated ? { truncated: true } : {}),
  });

  while (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS && visible.length > 1) {
    visible = visible.slice(0, -1);
    truncated = true;
  }
  if (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS) {
    visible = visible.map((artifact) => ({
      ...artifact,
      id: artifact.id.slice(0, 32),
      locator: {},
    }));
  }
  if (JSON.stringify(makeRecord()).length > MAX_NAVIGATION_CHARS) {
    visible = [];
    truncated = true;
  }
  return makeRecord();
}

export function buildFoldNavigationRecord(foldedPayload, roundRange) {
  const artifacts = [];
  for (const message of foldedPayload ?? []) {
    for (const block of blocksFor(message)) {
      if (block?.type !== "tool_result" || !block.artifact) continue;
      const artifact = block.artifact;
      artifacts.push({
        id: artifact.artifactId ?? artifact.archivePath,
        locator: artifact.locator,
        digest: artifact.digest,
        status: artifact.truncated === true ? "truncated" : "archived",
      });
    }
  }
  return boundedNavigationRecord(roundRange, artifacts);
}

export function mergeFoldNavigationRecords(records, roundRange) {
  return boundedNavigationRecord(
    roundRange,
    records.flatMap((record) => record?.artifacts ?? []),
  );
}

function escapeRegex(value) {
  return String(value).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseMarkedFoldSummary(text) {
  const value = String(text);
  const markedMatch = value.match(
    new RegExp(
      `${escapeRegex(FOLD_SUMMARY_MARKER)}早期第 (\\d+)–(\\d+) 轮（共 (\\d+) 轮）已折叠。工具足迹：(.*?)。`,
      "u",
    ),
  );
  if (!markedMatch) return undefined;
  return parseFoldSummaryMatch(value, markedMatch, false);
}

function parseFoldSummaryMatch(value, match, legacy) {
  if (!match) return undefined;
  let navigationRecord;
  const navigationMatch = value.match(/^导航记录：(\{.*\})$/mu);
  if (navigationMatch) {
    try {
      const parsed = JSON.parse(navigationMatch[1]);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.artifacts)) {
        navigationRecord = parsed;
      }
    } catch {
      // Ignore malformed navigation from an older or manually edited summary.
    }
  }
  return {
    from: Number.parseInt(match[1], 10),
    to: Number.parseInt(match[2], 10),
    count: Number.parseInt(match[3], 10),
    tools: parseToolFootprint(match[4]),
    stubs: [...String(value).matchAll(/^\[已折叠\][^\n]*/gmu)]
      .map((stub) => stub[0]),
    navigationRecord,
    legacy,
  };
}

function parseFoldSummaries(text) {
  const value = String(text);
  const marker = escapeRegex(FOLD_SUMMARY_MARKER);
  const starts = [...value.matchAll(new RegExp(marker, "gu"))]
    .map((match) => match.index);
  if (starts.length > 0) {
    return starts
      .map((start, index) => parseMarkedFoldSummary(
        value.slice(start, starts[index + 1] ?? value.length),
      ))
      .filter((parsed) => parsed !== undefined);
  }
  const legacy = value.match(
    /^【上下文折叠】早期第 (\d+)–(\d+) 轮（共 (\d+) 轮）已折叠。工具足迹：(.*?)。/u,
  );
  return legacy ? [parseFoldSummaryMatch(value, legacy, true)] : [];
}

function parseFoldSummary(text) {
  return parseFoldSummaries(text)[0];
}

function stripMarkedFoldSummaries(block) {
  if (block?.type !== "text") return [block];
  const text = String(block.text ?? "");
  const markerIndex = text.indexOf(FOLD_SUMMARY_MARKER);
  if (markerIndex < 0) return [block];
  const prefix = text.slice(0, markerIndex).trim();
  return prefix === "" ? [] : [{ ...block, text: prefix }];
}

function formatFoldSummary({
  from,
  to,
  count,
  tools,
  stubs = [],
  navigationRecord,
  recoveryHint = DEFAULT_RECOVERY_HINT,
}) {
  const footprint = tools.size === 0
    ? "无"
    : [...tools.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, count]) => `${name}×${count}`)
      .join(", ");
  const lines = [
    `${FOLD_SUMMARY_MARKER}早期第 ${from}–${to} 轮（共 ${count} 轮）已折叠。`,
    `工具足迹：${footprint}。`,
  ];
  if (navigationRecord) {
    lines.push(`导航记录：${JSON.stringify(navigationRecord)}`);
  }
  lines.push(...stubs.slice(0, 10));
  lines.push(recoveryHint);
  const prefix = lines.slice(0, 2).join("");
  const suffix = lines.slice(2).join("\n");
  return stubs.length > 0 || navigationRecord
    ? `${prefix}\n${suffix}`
    : `${prefix}${suffix}`;
}

function mergedFoldSummaryContent(originalContent, summary, recoveryHint) {
  const summaries = originalContent
    .filter((block) => block?.type === "text")
    .flatMap((block) => parseFoldSummaries(block.text));
  const current = parseFoldSummary(summary);
  const merged = [...summaries, current].filter((parsed) => parsed !== undefined);
  const mergedStubs = [...new Set(merged.flatMap((parsed) => parsed.stubs ?? []))].slice(0, 10);
  const mergedRange = {
    from: Math.min(...merged.map((parsed) => parsed.from)),
    to: Math.max(...merged.map((parsed) => parsed.to)),
  };
  const mergedNavigation = mergeFoldNavigationRecords(
    merged.map((parsed) => parsed.navigationRecord),
    mergedRange,
  );
  const mergedSummary = merged.length === 0
    ? summary
    : formatFoldSummary({
      from: mergedRange.from,
      to: mergedRange.to,
      count: merged.reduce((total, parsed) => total + parsed.count, 0),
      tools: merged.reduce((counts, parsed) => {
        for (const [name, count] of parsed.tools) {
          counts.set(name, (counts.get(name) ?? 0) + count);
        }
        return counts;
      }, new Map()),
      stubs: mergedStubs,
      navigationRecord: mergedNavigation,
      recoveryHint: resolveRecoveryHint(recoveryHint),
    });
  const contentWithoutSummaries = originalContent.flatMap((block) => {
    // 旧格式仅兼容读取，保留原块；v1 marker 是专用的可替换区段。
    if (block?.type !== "text" || parseFoldSummary(block.text)?.legacy === true) {
      return [block];
    }
    return stripMarkedFoldSummaries(block);
  });
  return [{ type: "text", text: mergedSummary }, ...contentWithoutSummaries];
}

function prependSummary(
  head,
  summary,
  summaryRole = "user",
  recoveryHint = DEFAULT_RECOVERY_HINT,
) {
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
      content: mergedFoldSummaryContent(content, summary, recoveryHint),
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
    // 合并后的单段摘要放 content 最前：模型先看到折叠提示，任务原文紧跟其后；
    // （safeTruncate 同消息字段按 index 截断，任务在后可避免被先截成 [已修剪]）
    content: mergedFoldSummaryContent(originalContent, summary, recoveryHint),
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
      const recoveryHint = await resolveFoldRecoveryHint(settings.recoveryHint, {
        foldedPayload,
        folded,
        retained,
        roundRange,
      });
      const foldedStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
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

      let compactedHead = head;
      if (folded.length > 0) {
        const range = roundRange ?? { from: 1, to: folded.length };
        const summary = formatFoldSummary({
          from: range.from,
          to: range.to,
          count: folded.length,
          tools: folded.reduce((counts, round) => {
            for (const message of round.messages) {
              for (const block of blocksFor(message)) {
                if (block?.type !== "tool_use") continue;
                const name = String(block.name ?? "");
                counts.set(name, (counts.get(name) ?? 0) + 1);
              }
            }
            return counts;
          }, new Map()),
          stubs: foldedStubs,
          navigationRecord,
          recoveryHint,
        });
        compactedHead = prependSummary(
          head,
          summary,
          settings.summaryRole,
          recoveryHint,
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
        ...(navigationRecord === undefined ? {} : { navigationRecord }),
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}
