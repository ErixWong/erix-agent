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
function appendFoldFidelity(summary, foldedPayload, anchorSettings) {
  const fidelity = buildFoldFidelitySection(foldedPayload, { anchors: anchorSettings });
  if (fidelity === undefined) return summary;
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

// anchors:false（评审修复）：旧 content 里的锚点节一并清除——否则 fold1（默认，产生
// 锚点节）之后 fold2 传 anchors:false 时旧摘要留在 head，锚点节会被原样保留下来。
// 复用 fold-statistical 的 stripAnchorSection，不复制实现；anchorsEnabled 缺省为 true，
// 此时旧 content 原样保留，行为与之前完全一致（向后兼容）。
function stripAnchorBlocks(content, anchorsEnabled) {
  if (anchorsEnabled) return content;
  return content.flatMap((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return [block];
    const stripped = stripAnchorSection(block.text);
    return stripped.trim() === "" ? [] : [{ ...block, text: stripped }];
  });
}

function prependSummary(head, summary, summaryRole = "user", anchorsEnabled = true) {
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
      content: [
        { type: "text", text: summary },
        ...stripAnchorBlocks(content, anchorsEnabled),
      ],
    };
    return updatedHead;
  }
  const userIndex = head.findLastIndex(isRealUser);
  if (userIndex < 0) return head;

  const user = head[userIndex];
  const originalContent = stripAnchorBlocks(
    typeof user.content === "string"
      ? [{ type: "text", text: user.content }]
      : Array.isArray(user.content)
        ? user.content
        : [],
    anchorsEnabled,
  );
  const updatedHead = head.slice();
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
        try {
          summary = await summarizer({
            messages: foldedPayload,
            roundRange: range,
            recoveryHint,
            promptGuide: createSummarizerPromptGuide(recoveryHint),
          });
          if (typeof summary !== "string") {
            throw new TypeError("fold-llm summarizer must return a string");
          }
        } catch (error) {
          degradeReason = String(error?.message ?? error).slice(0, 120);
          summary = undefined;
        }
        const compactedSummary = summary === undefined
          ? `[fold-llm 摘要失败，已降级为统计摘要（原因: ${degradeReason}）]\n`
            + summarizeFoldedPayload(foldedPayload, {
              from: range.from,
              to: range.to,
              count: folded.length,
              recoveryHint,
              stubs: foldedStubs,
              ...(navigationRecord === undefined ? {} : { navigationRecord }),
              ...(settings.anchors === false
                ? {}
                : { anchors: extractAnchors(
                  foldedPayload,
                  settings.anchors && typeof settings.anchors === "object" ? settings.anchors : {},
                ) }),
            })
          : appendFoldFidelity(
            enforceSummarySize(
              withRecoveryHint(summary, recoveryHint),
              summaryBudget,
            ),
            foldedPayload,
            settings.anchors,
          );
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
      };
      await runFoldHook(settings.onAfterFold, { ...result, roundRange });
      return result;
    },
  };
}
