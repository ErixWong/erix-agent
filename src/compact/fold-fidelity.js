// 折叠摘要的机械保真层（#10 锚点索引 + #11 用户最新未解决输入 / 反向信号）。
//
// 这一层的内容全部由引擎机械抽取，不经 LLM 改写，统一追加在 LLM 摘要（尺寸截断）之后，
// 所以摘要预算削不掉它。来源是 foldedPayload 的原文——被折轮次里已经离开上下文的那部分。

import { extractAnchors } from "./anchors.js";
import { isRealUser } from "./helpers.js";

export const USER_INPUT_SECTION_HEADING = "## 用户最新未解决输入（逐字引用，未经 LLM 改写）";

/** 逐字引用上限：用户消息可能很长，逐字引用也要有硬上限，超出部分用标记说明。 */
export const MAX_USER_QUOTE_CHARS = 800;

/** 警告里最多列几个命中词。 */
export const MAX_REVERSE_SIGNAL_HITS = 5;

export const REVERSE_SIGNAL_WARNING_LEAD = "⚠ 用户曾发出中止/撤销信号";

// 反向信号词表：中文按子串匹配（中文没有词边界），英文按词边界匹配。
const CJK_REVERSE_SIGNALS = Object.freeze([
  "取消",
  "撤销",
  "撤回",
  "中止",
  "作废",
  "放弃",
  "停止",
  "停下",
  "不用了",
  "不要了",
  "算了",
  "别做了",
  "不做了",
  "先不做",
  "不用继续",
  "不要继续",
  "别再继续",
]);

const ASCII_REVERSE_SIGNALS = Object.freeze([
  "never mind",
  "nevermind",
  "forget it",
  "hold off",
  "disregard",
  "rollback",
  "cancel",
  "cancelled",
  "canceled",
  "abort",
  "aborted",
  "revert",
  "undo",
  "stop",
  "scrap",
  "don't do",
  "dont do",
  "do not do",
]);

// 否定式守卫：'不要取消' / "don't stop" 这类是"别撤销"，不是撤销信号。
// 先抹掉否定片段再匹配，避免把否定句读成反向信号。
const CJK_NEGATED_SIGNALS =
  /(?:不|别|勿|无需|不用|不必|不要|没有|没)(?:要|需|用|必|再|得|去)?(?:取消|撤销|撤回|中止|作废|放弃|停止|停下)/gu;
const ASCII_NEGATED_SIGNALS =
  /\b(?:don'?t|do not|never|no need to)\s+(?:stop|undo|cancel|abort|revert|rollback)\b/gi;

function escapeRegex(value) {
  return String(value).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const CJK_SIGNAL_PATTERN = new RegExp(CJK_REVERSE_SIGNALS.map(escapeRegex).join("|"), "gu");
const ASCII_SIGNAL_PATTERN = new RegExp(
  `\\b(?:${ASCII_REVERSE_SIGNALS.map(escapeRegex).join("|")})\\b`,
  "gi",
);

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function realUserEntries(messages) {
  const entries = [];
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    if (!isRealUser(message)) return;
    const text = messageText(message);
    if (text.trim() === "") return;
    entries.push({ index, text });
  });
  return entries;
}

/**
 * Mechanically extract the latest unresolved real user input (verbatim, no LLM rewriting).
 *
 * @param {object[]} messages
 * @returns {{text: string, messageIndex: number, truncated: boolean, totalChars: number}|undefined}
 */
export function extractLatestUserInput(messages) {
  const entries = realUserEntries(messages);
  const latest = entries.at(-1);
  if (latest === undefined) return undefined;

  const characters = Array.from(latest.text);
  const truncated = characters.length > MAX_USER_QUOTE_CHARS;
  return {
    text: truncated ? characters.slice(0, MAX_USER_QUOTE_CHARS).join("") : latest.text,
    messageIndex: latest.index,
    truncated,
    totalChars: characters.length,
  };
}

/**
 * Mechanically detect cancel/undo signals in the folded real user messages.
 *
 * @param {object[]} messages
 * @returns {{signals: string[], messageIndexes: number[]}|undefined}
 */
export function detectReverseSignals(messages) {
  const signals = [];
  const messageIndexes = [];

  for (const entry of realUserEntries(messages)) {
    const scrubbed = entry.text
      .replaceAll(CJK_NEGATED_SIGNALS, " ")
      .replaceAll(ASCII_NEGATED_SIGNALS, " ");
    const hits = [
      ...scrubbed.matchAll(CJK_SIGNAL_PATTERN),
      ...scrubbed.matchAll(ASCII_SIGNAL_PATTERN),
    ]
      // 命中顺序按消息内出现位置，便于阅读（中英词表是两套正则）。
      .sort((left, right) => left.index - right.index)
      .map((match) => match[0]);
    if (hits.length === 0) continue;
    messageIndexes.push(entry.index);
    for (const hit of hits) {
      if (!signals.includes(hit)) signals.push(hit);
    }
  }

  if (signals.length === 0) return undefined;
  return { signals, messageIndexes };
}

/**
 * One-line warning injected ahead of the quoted user input.
 *
 * @param {{signals: string[]}} detection
 * @returns {string}
 */
export function reverseSignalWarningLine(detection) {
  const hits = detection.signals.slice(0, MAX_REVERSE_SIGNAL_HITS).join("、");
  return `${REVERSE_SIGNAL_WARNING_LEAD}（命中：${hits}）：上方「下一步」里早于该信号的旧待办`
    + "不得直接照做，需先向用户确认；旧待办只标记为需确认，不从待办数据中删除。";
}

function userInputSection(quote, warningLine) {
  const lines = [USER_INPUT_SECTION_HEADING];
  if (warningLine !== undefined) lines.push(warningLine);
  lines.push(
    ...quote.text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)),
  );
  if (quote.truncated) {
    lines.push(`[用户原文过长：仅逐字引用前 ${MAX_USER_QUOTE_CHARS} 字符，`
      + `共 ${quote.totalChars} 字符]`);
  }
  return lines;
}

/**
 * Build the mechanical fidelity block appended after the LLM summary.
 *
 * @param {object[]} foldedPayload Raw folded messages (before summarization).
 * @returns {string|undefined} `undefined` when nothing was extracted (no empty sections).
 */
export function buildFoldFidelitySection(foldedPayload) {
  const sections = [];
  const latestUserInput = extractLatestUserInput(foldedPayload);
  const reverseSignals = detectReverseSignals(foldedPayload);

  if (latestUserInput !== undefined) {
    const warningLine = reverseSignals === undefined
      ? undefined
      : reverseSignalWarningLine(reverseSignals);
    sections.push(userInputSection(latestUserInput, warningLine).join("\n"));
  }

  const anchors = extractAnchors(foldedPayload);
  if (anchors.text !== "") sections.push(anchors.text);

  return sections.length === 0 ? undefined : sections.join("\n\n");
}
