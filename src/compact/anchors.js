// 折叠摘要的机械保真层（#10 锚点索引）：只做正则机械抽取，零 LLM 调用、确定性可测。
//
// 背景：LLM 复述精确值必然损耗（commit SHA 会被写成"某个提交"），所以折叠时从被折轮次的
// 原文里机械抽取精确标识，作为不经模型改写的保真层追加到摘要尾部；这些标识同时也是
// recall({ pattern }) 最好的搜索关键词种子。
//
// 抽取范围（A2 降误报）：只扫 tool_result 内容 + 真实 user 消息，不看 assistant 散文——
// 散文里的"大致路径/某个提交"复述是误报重灾区（fold-llm 与 fold-statistical 共用本模块）。

import { isRealUser } from "./helpers.js";

export const ANCHOR_SECTION_HEADING = "## 锚点索引（机械抽取，未经 LLM 改写）";

/**
 * 锚点总数上限（写死的保留规则：出现频次降序 → 首次出现位置升序 → 类型/字面序）。
 * 超限时丢弃排名靠后的条目。
 */
export const MAX_ANCHORS = 20;

/** 锚点节总字符上限：按同一排序继续跳过放不下的条目，避免长篇 URL 撑爆摘要。 */
export const MAX_ANCHOR_SECTION_CHARS = 1200;

export const ANCHOR_KINDS = Object.freeze(["paths", "shas", "issues", "urls", "errors"]);

/** errors 类硬上限（设计稿 A2：错误行最多保留 5 条）。 */
export const MAX_ERROR_ANCHORS = 5;

/** errors 类锚点取值：命中行取前 120 字符。 */
export const MAX_ERROR_ANCHOR_CHARS = 120;

// 正则全部"宁缺毋滥"：宁可少一条，也不要把散文里的普通单词当锚点。
const URL_PATTERN = /https?:\/\/[^\s<>"'`，。；、！？）】》」』]+/gu;
const URL_TRAILING_NOISE = /[.,;:!?)\]}>"'，。；、：！？】）》」』]+$/u;
// SHA：7-40 位小写十六进制，且必须同时含数字与字母（滤掉纯数字行号、纯字母英文词如 defaced）。
const SHA_PATTERN = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/gu;
const ISSUE_PATTERN = /(?<![\w#])#\d{1,6}(?![-\d])/gu;
// 路径：至少一级目录 + 末段必须带字母扩展名（挡掉 and/or、1/2 这类误报），可带 :行号。
const PATH_PATTERN = new RegExp(
  "(?<![\\w.\\-/])(?:\\.{0,2}\\/)?(?:[A-Za-z0-9_@+-]+\\/)+"
    + "[A-Za-z0-9_@+-]+\\.[A-Za-z][A-Za-z0-9]{0,9}(?::\\d{1,6})?(?![\\w/-])",
  "gu",
);
// errors：行内含 Error / Exception / Traceback / fatal: 即整行前 120 字符留痕。
const ERROR_SIGNAL = /Error|Exception|Traceback|fatal:/u;
// id 类字段是引擎元数据（tool_use_id 等），不是原文，跳过以降低误报。
const ID_FIELD = /(?:^|[_-])ids?$|Ids?$/;

// 抽取顺序即掩码顺序：先抽 URL/路径并掩掉，避免 URL 里的路径、路径里的十六进制段被重复计入。
// errors 独立成行级抽取，不参与掩码（整行留痕，行内其他标识仍按各自 kind 计入）。
const EXTRACTION_PIPELINE = Object.freeze([
  { kind: "urls", pattern: URL_PATTERN, normalize: stripUrlNoise },
  { kind: "paths", pattern: PATH_PATTERN },
  { kind: "shas", pattern: SHA_PATTERN, normalize: normalizeSha },
  { kind: "issues", pattern: ISSUE_PATTERN },
]);

function stripUrlNoise(value) {
  return value.replace(URL_TRAILING_NOISE, "");
}

function normalizeSha(value) {
  return /[0-9]/u.test(value) && /[a-f]/u.test(value) ? value : undefined;
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (ID_FIELD.test(key)) continue;
    collectStrings(item, output);
  }
}

// 抽取范围收窄（A2）：只看 user 消息——真实 user 消息的文本 + 任何 user 消息里的
// tool_result 内容；assistant 散文（含 tool_use 参数）一律不扫。
function anchorSegments(messages) {
  const segments = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      if (message.content !== "") segments.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const realUser = isRealUser(message);
    for (const block of message.content) {
      if (block?.type === "tool_result") {
        collectStrings(block.content, segments);
      } else if (realUser && block?.type === "text" && typeof block.text === "string") {
        if (block.text !== "") segments.push(block.text);
      }
    }
  }
  return segments;
}

function matchesFor(step, text) {
  const matches = [];
  for (const match of text.matchAll(step.pattern)) {
    const value = step.normalize === undefined ? match[0] : step.normalize(match[0]);
    if (value === undefined || value === "") continue;
    matches.push({ value, index: match.index, length: match[0].length });
  }
  return matches;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    characters[index] = " ";
  }
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function rankEntries(entries) {
  return entries.sort((left, right) => (
    right.count - left.count
    || left.firstOffset - right.firstOffset
    || ANCHOR_KINDS.indexOf(left.kind) - ANCHOR_KINDS.indexOf(right.kind)
    || compareStrings(left.value, right.value)
  ));
}

// 值内转义（评审修复）：errors/urls 的值可含 `,`（如 "Error: failed, retry later"、
// "https://x.com/?a=1,2"），而多值以 ", " 连接——序列化转义 `\` 与 `,`，解析端按
// splitAnchorValues 反转义，保证五种 kind 全部 round-trip 保真。
// （paths/shas/issues 的正则字符集不含 `,`/`\`，转义对它们是恒等操作。）
function encodeAnchorValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

/**
 * 解析锚点行的取值列表（renderAnchorSection 的逆操作）：按未转义的 `,` 切分，
 * `\x` 还原为字面 x。供 fold-statistical 的 parseAnchorSection 复用。
 */
export function splitAnchorValues(text) {
  const values = [];
  let current = "";
  let index = 0;
  const value = String(text);
  while (index < value.length) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      current += value[index + 1];
      index += 2;
      continue;
    }
    if (char === ",") {
      values.push(current);
      current = "";
      index += value[index + 1] === " " ? 2 : 1;
      continue;
    }
    current += char;
    index += 1;
  }
  values.push(current);
  return values;
}

function renderAnchorSection(entries) {
  const lines = [ANCHOR_SECTION_HEADING];
  for (const kind of ANCHOR_KINDS) {
    const values = entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => encodeAnchorValue(entry.value));
    if (values.length > 0) lines.push(`${kind}: ${values.join(", ")}`);
  }
  return lines.join("\n");
}

function normalizedMaxAnchors(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : MAX_ANCHORS;
}

function normalizedMaxPerKind(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizedMaxChars(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : MAX_ANCHOR_SECTION_CHARS;
}

function normalizedAnchorSettings(value) {
  if (value === false) return false;
  if (value === null || value === undefined || typeof value !== "object") return {};
  return {
    maxPerKind: normalizedMaxPerKind(value.maxPerKind),
    maxChars: normalizedMaxChars(value.maxChars),
  };
}

function emptyByKind() {
  return Object.fromEntries(ANCHOR_KINDS.map((kind) => [kind, []]));
}

// 按排序截断到上限：总数、单 kind（maxPerKind，errors 另有硬上限 5）、节字符数三重夹取。
function clampAnchorEntries(ranked, { maxAnchors, maxPerKind, maxChars }) {
  const entries = [];
  const perKind = Object.fromEntries(ANCHOR_KINDS.map((kind) => [kind, 0]));
  for (const entry of ranked) {
    if (entries.length >= maxAnchors) break;
    const kindCap = entry.kind === "errors"
      ? Math.min(maxPerKind ?? MAX_ERROR_ANCHORS, MAX_ERROR_ANCHORS)
      : maxPerKind;
    if (kindCap !== undefined && perKind[entry.kind] >= kindCap) continue;
    if (renderAnchorSection([...entries, entry]).length > maxChars) continue;
    entries.push(entry);
    perKind[entry.kind] += 1;
  }
  return entries;
}

/**
 * 按 kind 并集（调用方保证去重与顺序）夹取上限并渲染锚点节。
 * 供 fold-statistical 的 mergedFoldSummaryContent 复用，保证多次折叠后锚点不丢、不重复、不超限。
 *
 * @param {Record<string, string[]>} byKind kind → 取值数组（展示顺序即数组顺序）。
 * @param {{maxPerKind?: number, maxChars?: number}} [options]
 * @returns {{byKind: Record<string, string[]>, text: string}} text 为整节文本（空桶返回 ""）。
 */
export function clampAnchorSection(byKind, options = {}) {
  const settings = normalizedAnchorSettings(options) || {};
  const entries = [];
  for (const kind of ANCHOR_KINDS) {
    for (const value of Array.isArray(byKind?.[kind]) ? byKind[kind] : []) {
      if (typeof value !== "string" || value === "") continue;
      entries.push({ kind, value, count: 1, firstOffset: entries.length });
    }
  }
  if (entries.length === 0) return { byKind: emptyByKind(), text: "" };
  const clamped = clampAnchorEntries(entries, {
    maxAnchors: MAX_ANCHORS,
    maxPerKind: settings.maxPerKind,
    maxChars: settings.maxChars,
  });
  const result = emptyByKind();
  for (const entry of clamped) result[entry.kind].push(entry.value);
  return { byKind: result, text: renderAnchorSection(clamped) };
}

/**
 * Deterministically extract precise identifiers from the raw folded payload.
 *
 * @param {object[]} messages Raw (unsummarized) folded messages.
 * @param {{maxAnchors?: number, maxPerKind?: number, maxChars?: number}} [options]
 * @returns {{
 *   text: string,
 *   byKind: Record<string, string[]>,
 *   entries: object[],
 *   total: number,
 *   kept: number,
 *   omitted: number,
 * }}
 */
export function extractAnchors(messages, options = {}) {
  const maxAnchors = normalizedMaxAnchors(options?.maxAnchors);
  const maxPerKind = normalizedMaxPerKind(options?.maxPerKind);
  const maxChars = normalizedMaxChars(options?.maxChars);
  const found = new Map();
  let offset = 0;

  for (const segment of anchorSegments(messages)) {
    // errors 先行（行级、不掩码），保证整行留痕不被掩码切碎。
    let lineOffset = 0;
    for (const line of segment.split("\n")) {
      if (ERROR_SIGNAL.test(line)) {
        const value = line.trim().slice(0, MAX_ERROR_ANCHOR_CHARS);
        if (value !== "") {
          const key = `errors\u0000${value}`;
          const existing = found.get(key);
          if (existing === undefined) {
            found.set(key, { kind: "errors", value, count: 1, firstOffset: offset + lineOffset });
          } else {
            existing.count += 1;
          }
        }
      }
      lineOffset += line.length + 1;
    }
    const characters = segment.split("");
    for (const step of EXTRACTION_PIPELINE) {
      for (const match of matchesFor(step, characters.join(""))) {
        const key = `${step.kind}\u0000${match.value}`;
        const existing = found.get(key);
        if (existing === undefined) {
          found.set(key, {
            kind: step.kind,
            value: match.value,
            count: 1,
            firstOffset: offset + match.index,
          });
        } else {
          existing.count += 1;
        }
        maskRange(characters, match.index, match.index + match.length);
      }
    }
    offset += segment.length + 1;
  }

  const ranked = rankEntries([...found.values()]);
  const entries = clampAnchorEntries(ranked, { maxAnchors, maxPerKind, maxChars });

  const byKind = emptyByKind();
  for (const entry of entries) byKind[entry.kind].push(entry.value);

  return {
    text: entries.length === 0 ? "" : renderAnchorSection(entries),
    byKind,
    entries,
    total: ranked.length,
    kept: entries.length,
    omitted: ranked.length - entries.length,
  };
}
