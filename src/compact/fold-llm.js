import { groupIntoRounds } from "../messages/rounds.js";
import { estimateMessageTokens, estimateTokens } from "../tokens.js";
// issue #661：摘要器失败是**终局错误**，错误码口径与 `termination.errorCode` 同一份实现
//（`src/loop/termination.js#terminationErrorCodeForError`），不在这里另抄一份取 `code` 的逻辑。
import { terminationErrorCodeForError } from "../loop/termination.js";
import { KitError } from "../providers/errors.js";
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
## 教训与坑（不要重犯的）
记录被折轮次里出现过的：①试过但失败或代价高的做法（含为什么失败）；②不可违反的约束；③已确认的坑。
只写原文里确实出现过的，不要推测、不要补充；没有就写「无」。

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
  // issue #469（宿主审计 C 片）：主题词必须优先保。它排第 3 档时，预算一紧就先被剪，
  // 而它恰恰是「下次按什么搜回来」的唯一线索（比「已改文件」更不可重建）。
  if (heading.includes("下一步")) return 0;
  if (heading.includes("恢复提示")) return 0;
  if (heading.includes("主题词")) return 1;
  if (heading.includes("已验证项")) return 2;
  if (heading.includes("已改文件")) return 3;
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
 * 无论配不配都会**带更短的输入重试一次**——重试仍失败 ⇒ 抛 `summarizer_failed`
 *（issue #661：不再有「降级为统计摘要」那条替代路径）。
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
  maxSummaryTokens = DEFAULT_SUMMARY_MAX_TOKENS,
  ...options
} = {}) {
  if (typeof summarizer !== "function") {
    throw new TypeError("fold-llm summarizer must be a function");
  }
  const summaryBudget = normalizedSummaryTokens(maxSummaryTokens);
  // issue #469-③：本实例**上一次真喂进上下文**的折叠摘要（#661 起只可能是 LLM 摘要——
  // 失败那一折会抛，走不到这里），下一次折叠把它当续写基底；宿主 / resume 可用
  // `previousSummary` 覆盖。
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
        // issue #608：工作集地板（`0` = 关闭，引擎显式开成 `WORKING_SET_RECENT_ROUNDS`）。
        // #614 之后本策略是 CLI 默认 ⇒ 漏传就等于宿主显式开的地板在默认路径上被静默忽略。
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
      const recoveryHint = await resolveFoldRecoveryHint(settings.recoveryHint, {
        foldedPayload,
        folded,
        retained,
        roundRange,
        // issue #741：同 `fold-statistical` —— 拿不到笔记证据就把广告语换成显式未知口径。
        noteTools: settings.noteTools,
      });
      await runFoldHook(settings.onBeforeFold, {
        messages,
        folded,
        retained,
        foldedPayload,
        roundRange,
      });

      let compactedHead = head;
      // issue #470（A1）：本次折叠的**机械替代物**（进账本用，不进消息流）。
      /** @type {{ source: string, text?: string, increment?: string, incrementOrigin?: string }|undefined} */
      let foldSummary = undefined;
      if (folded.length > 0) {
        const range = roundRange ?? { from: 1, to: folded.length };
        // 机械替代物（stub / 导航记录）与摘要器无关，先算好；它们只是**账本**的一份，
        // 不是摘要失败时的替代物（issue #661 已删掉那条替代路径）。
        const foldedStubs = await resolveFoldStubs(foldedPayload, settings.stubFor);
        const navigationRecord = buildFoldNavigationRecord(foldedPayload, range);
        // issue #661：`callSummarizerWithBound` **失败即抛**（`KitError("summarizer_failed")`）。
        // 改前它返回一份「降级为统计摘要」的替代物（issue #33 D 的旧语义），于是摘要器挂了
        // 的 run 与摘要器正常的 run 在终局上长得一样——用户永远不知道质量掉了。
        // 现在失败就是失败：异常一路穿到 run 的终局（`termination.reason === "failed"`，
        // `errorCode === "summarizer_failed"`）。构造期参数错误（summarizer 非函数）仍在
        // `createFoldLlmStrategy` 里 fail-loud，不经此路径。
        //
        // 「先失败后应用」：下面每一处状态写入（`lastFoldSummaryText` / `foldSummary` /
        // `compactedHead`）都在 `await` **之后** ⇒ 抛出的那一折一个键都不留。
        // issue #469（裁决 A）：取源链 **显式调用参数 > 策略构造参数 > in-run 闭包 > 账本播种**。
        // 账本排最后 ⇒ 非 resume / 挑不出覆盖事实时它为空，行为逐字退回今天的形状（纯加法）。
        const continuationBase = await resolveContinuationBase(
          callOptions,
          options,
          lastFoldSummaryText,
        );
        const prior = normalizePriorSummary(
          continuationBase.text,
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
        const summary = summarizerOutcome.summary;
        const droppedInputMessages = summarizerOutcome.droppedMessages;
        // issue #566：本折的机械替代物总是算（零 LLM）。
        // `compactedSummary` 是续写累计体（prior 会被续写进输出），
        // 不是本折增量。
        const fallbackAnchors = settings.anchors === false
          ? undefined
          : extractAnchors(
            foldedPayload,
            settings.anchors && typeof settings.anchors === "object" ? settings.anchors : {},
          );
        const mechanicalSummaryText = summarizeFoldedPayload(foldedPayload, {
          from: range.from,
          to: range.to,
          count: folded.length,
          recoveryHint,
          stubs: foldedStubs,
          ...(navigationRecord === undefined ? {} : { navigationRecord }),
          ...(fallbackAnchors === undefined ? {} : { anchors: fallbackAnchors }),
        });
        const compactedSummary = appendFoldFidelity(
          enforceSummarySize(
            withRecoveryHint(summary, recoveryHint),
            summaryBudget,
            settings.onLayer,
          ),
          foldedPayload,
          settings.anchors,
          settings.onLayer,
        );
        // ③ 的续写基底：记下这次真进了上下文的那份（下一轮折叠的「上一份」）。
        // issue #661：只有拿到摘要才写 ⇒ 失败那一折不会给下一次折叠留残值。
        lastFoldSummaryText = compactedSummary;
        foldSummary = {
          // issue #661：`fold-llm` 只有一条成功路径（失败即抛），所以 `source` 恒为 `"llm"`。
          // 改前失败分支写 `"statistical"`——那是被删掉的「降级为统计摘要」替代物的自报。
          source: "llm",
          // issue #566：本折那份 = 机械替代物 ⇒ 自报 mechanical。
          increment: mechanicalSummaryText,
          incrementOrigin: "mechanical",
          // #470：`text` 说清「交给模型的那份」是什么。
          // issue #657（缺陷二）：**成功分支也交 `text`** = 已存进 `lastFoldSummaryText` 的累计摘要（不重算）。
          // 改前它不给这个键 ⇒ 引擎落回 `fedSummaryText`（折叠后那条消息**全文** = 摘要 + 原任务正文）
          // ⇒ 账上 54–78% 是模型还在 head 里看着的任务原文，`truncated` 从第 2 折起恒真。
          text: compactedSummary,
          ...(prior.truncated ? { priorSummaryTruncated: true, priorSummaryBytes: prior.bytes } : {}),
          ...(prior.bytes > 0 && !prior.truncated ? { priorSummaryBytes: prior.bytes } : {}),
          // issue #469（裁决 A）：基底从哪来——`"ledger"` = resume 后从账本播的，
          // `"in-run"` = 本 run 攒的（含宿主显式传的）。口径照「无事实不写键」：没基底就不写。
          ...(prior.bytes > 0
            ? { priorSummaryOrigin: continuationBase.origin ?? "in-run" }
            : {}),
          ...(summarizerOutcome.droppedRounds > 0
            ? { droppedRounds: summarizerOutcome.droppedRounds }
            : {}),
          ...(summarizerOutcome.attempts > 1 ? { attempts: summarizerOutcome.attempts } : {}),
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
 * issue #469-①：摘要器失败的**归因分类**。超时、超窗（网关 400）、普通报错此前塌成
 * 同一条文案，宿主从记录上分不出「这次本可以自愈」还是「摘要器真的挂了」。
 *
 * issue #661：分类结果不再落成 `degradeKind`（那条降级路径已删），而是
 * `summarizer_failed` 异常上的 `details.kind`。四类原值不变：
 * `timeout` / `context_window_exceeded` / `empty_summary` / `error`。
 *
 * @param {*} error 可以是 Error / 带 `code` 的自定义错 / 
 * 字符串（降级路径上什么都会抛上来）
 * @returns {"timeout"|"context_window_exceeded"|"empty_summary"|"error"}
 */
export function classifyFoldDegradeKind(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "summarizer_timeout" || code === "ETIMEDOUT" || code === "TIMEOUT") {
    return "timeout";
  }
  // 缺陷 ②：空串 / 只有空白的摘要是**摘要器没产出**，不是「成功的空摘要」。
  // 单独一类，好让宿主从记录上把它与「摘要器挂了」（`error`）分开。
  if (code === "summarizer_empty_summary") {
    return "empty_summary";
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

/**
 * issue #493：折叠摘要的输出预算默认值（`createFoldLlmStrategy` 的 `maxSummaryTokens` 默认，
 * 也是 `context.maxSummaryTokens` 不传时的值）。导出给 `orchestrator` 用——摘要那一发的
 * `maxTokens` 必须与这个预算**取小对齐**，否则模型按大预算写满再被剪回来，白烧 token。
 */
export const DEFAULT_SUMMARY_MAX_TOKENS = 1_400;

/**
 * issue #469（宿主裁决 A）：续写基底的**取源链**——显式调用参数 > 策略构造参数 > in-run 闭包 >
 * 账本播种（`ledgerPreviousSummary`，值或异步取值器）。
 *
 * 账本那一档排**最后**：非 resume / 挑不出覆盖水位线的事实 ⇒ 返回空 ⇒ 行为逐字退回今天的形状。
 * 返回值带 `origin`，由 `foldSummary.priorSummaryOrigin` 如实交代（`ledger` / `in-run`）。
 *
 * @param {any} callOptions
 * @param {any} options
 * @param {string|undefined} inRunText 本实例上一次真喂出去的摘要（`lastFoldSummaryText`）
 * @returns {Promise<{ text?: string, origin?: "ledger"|"in-run" }>}
 */
async function resolveContinuationBase(callOptions, options, inRunText) {
  const explicit = optionValue(callOptions, options, "previousSummary", undefined);
  if (typeof explicit === "string" && explicit !== "") return { text: explicit, origin: "in-run" };
  if (typeof inRunText === "string" && inRunText !== "") return { text: inRunText, origin: "in-run" };
  const seed = optionValue(callOptions, options, "ledgerPreviousSummary", undefined);
  const seeded = typeof seed === "function" ? await seed() : seed;
  if (typeof seeded === "string" && seeded !== "") return { text: seeded, origin: "ledger" };
  return { text: undefined, origin: undefined };
}

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
 * 缺陷 ②：摘要器的返回值必须**真的是一份摘要**。
 *
 * `typeof "" === "string"` 曾把「模型什么都没写」当成成功 ⇒ 折叠块里只有恢复提示 +
 * 锚点，既无语义内容、也无降级标记（看上去正常，实际是空的）。空串 / 只有空白的串
 * 一律当**失败**：抛错 ⇒ 由 `callSummarizerWithBound` 包成 `summarizer_failed`
 *（issue #661；改前是 #33 D 的「降级为统计摘要」），原因分类为 `empty_summary`
 *（`summarizer_empty_summary`），文案「摘要器返回空内容」。
 *
 * 非字符串的旧口径（`TypeError` + `error` 类）逐字不动。
 *
 * @param {*} summary
 * @returns {string} 可用的摘要文本
 */
function assertUsableSummary(summary) {
  if (typeof summary !== "string") {
    throw new TypeError("fold-llm summarizer must return a string");
  }
  if (summary.trim() === "") {
    const error = new TypeError("摘要器返回空内容");
    Object.assign(error, { code: "summarizer_empty_summary" });
    throw error;
  }
  return summary;
}

/**
 * issue #661：摘要器失败的**唯一**出口。
 *
 * 改前这里是「返回一份降级替代物」（issue #33 D），于是摘要器挂了的 run 与摘要器正常的 run
 * 在终局上长得一样（只有 stdout 里一块 `[fold-llm 摘要失败，已降级为统计摘要（原因: …）]`）。
 * 现在是终局错误：`KitError("summarizer_failed")` 一路穿到 `termination.reason === "failed"`。
 *
 * 三个字段的口径：
 *   · `errorCode` —— **与 `makePersistenceFailure`（`src/loop/orchestrator.js`）取值对称**：
 *     记根因自己的 `code`（`terminationErrorCodeForError`，取不到即 `"unknown"`），
 *     `cause` 仍是底层错误对象；
 *   · `details.kind` —— `classifyFoldDegradeKind` 的四类原值（`timeout` /
 *     `context_window_exceeded` / `empty_summary` / `error`）。刻意**不**叫
 *     `summarizer_unavailable`：`empty_summary` 是「模型返回空串/空白」的确定性故障，
 *     换模型才有用，不叫「不可用」；
 *   · `details` 上的诊断事实（`attempts` / `droppedMessages` / `droppedRounds` /
 *     `budgetExhausted`）—— 异常路径不返回 result，这些事实只能随异常走，否则「为什么失败」
 *     与「试过几次」一起消失。
 *
 * 用 `Object.assign` 写 `errorCode` / `details`：`KitError` 的 JSDoc 没声明这两个 additive
 * 字段，直接赋值会让 `--checkJs` 棘轮多背 TS2339（#214 的「只减不增」）。
 *
 * @param {*} error 底层错误（超时 / 网关 400 / 空摘要 / 任意 reject）
 * @param {{ kind?: "timeout"|"context_window_exceeded"|"empty_summary"|"error",
 *   droppedMessages?: number, droppedRounds?: number, attempts?: number,
 *   budgetExhausted?: boolean }} [facts]
 * @returns {KitError}
 */
function summarizerFailure(error, facts = {}) {
  const kind = facts.kind ?? classifyFoldDegradeKind(error);
  const reason = String(error?.message ?? error).slice(0, 120);
  const failure = new KitError(
    "summarizer_failed",
    `fold-llm 摘要失败（${kind}）：${reason}`,
    { retryable: false, cause: error },
  );
  Object.assign(failure, {
    errorCode: terminationErrorCodeForError(error),
    details: {
      kind,
      ...(facts.droppedMessages > 0 ? { droppedMessages: facts.droppedMessages } : {}),
      ...(facts.droppedRounds > 0 ? { droppedRounds: facts.droppedRounds } : {}),
      ...(facts.attempts > 1 ? { attempts: facts.attempts } : {}),
      ...(facts.budgetExhausted === true ? { budgetExhausted: true } : {}),
    },
  });
  return failure;
}

/**
 * issue #469-①②③：一次折叠的摘要步骤。
 *   · 首发与（仅超窗时允许的）自愈重试共享一条 `budgetMs` 死线；
 *   · **超时绝不重试**（宿主裁决 ②：重试只是把一次卡顿变成两次）；
 *   · **失败即抛** `summarizer_failed`（issue #661：不再返回降级替代物）。
 *
 * 保留「超窗 ⇒ 缩输入重试一次」：那不是降级，是让调用装得下。重试仍失败 ⇒ 同样抛，
 * `details.kind` 保持 `context_window_exceeded`（超窗归因不因重试又失败而被掩盖）。
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
  const fail = (error, droppedMessages, extra = {}) => summarizerFailure(error, {
    droppedMessages,
    ...extra,
  });
  const first = trimFoldedPayloadToLimits(payload, {
    maxBytes: inputBoundBytes,
    maxTokens: inputBoundTokens,
  });
  const limitPart = first.droppedRounds > 0 ? { droppedRounds: first.droppedRounds } : {};
  try {
    const summary = assertUsableSummary(await invoke(first.messages));
    return { summary, droppedMessages: first.dropped, attempts: 1, ...limitPart };
  } catch (error) {
    if (classifyFoldDegradeKind(error) !== "context_window_exceeded") {
      // issue #661：非超窗失败（超时 / 空摘要 / 任意 reject）没有自愈余地 ⇒ 直接终局。
      throw fail(error, first.dropped, limitPart);
    }
    const left = remaining();
    if (left !== undefined && left < MIN_RETRY_REMAINING_MS) {
      // 预算不够一次有意义的尝试：仍抛，但把「不是自愈不了，是没时间」写进 details。
      throw fail(error, first.dropped, { ...limitPart, budgetExhausted: true });
    }
    const retryBound = retryBoundFor(inputBoundTokens, first.messages);
    if (retryBound === undefined) throw fail(error, first.dropped, limitPart);
    const retry = trimBeforeRetry(first.messages, retryBound);
    if (retry.dropped === 0 && retry.collapsed === 0) throw fail(error, first.dropped, limitPart);
    try {
      const retrySummary = assertUsableSummary(await invoke(retry.messages));
      return {
        summary: retrySummary,
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        attempts: 2,
        ...limitPart,
      };
    } catch (retryError) {
      // 重试又失败：若仍是普通报错，归因仍记超窗（否则「为什么缩了输入」会被掩盖）；
      // 超时 / 空摘要保留自己的分类（issue #661：`details.kind` 是四类原值）。
      const kind = classifyFoldDegradeKind(retryError);
      throw summarizerFailure(retryError, {
        kind: kind === "error" ? "context_window_exceeded" : kind,
        droppedMessages: first.dropped + retry.dropped + retry.collapsed,
        droppedRounds: first.droppedRounds,
        attempts: 2,
      });
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

