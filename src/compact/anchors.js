// 折叠摘要的机械保真层（#10 锚点索引）：只做正则机械抽取，零 LLM 调用、确定性可测。
//
// 背景：LLM 复述精确值必然损耗（commit SHA 会被写成"某个提交"），所以折叠时从被折轮次的
// 原文里机械抽取精确标识，作为不经模型改写的保真层追加到摘要尾部；这些标识同时也是
// recall({ pattern }) 最好的搜索关键词种子。

export const ANCHOR_SECTION_HEADING = "## 锚点索引（机械抽取，未经 LLM 改写）";

/**
 * 锚点总数上限（写死的保留规则：出现频次降序 → 首次出现位置升序 → 类型/字面序）。
 * 超限时丢弃排名靠后的条目。
 */
export const MAX_ANCHORS = 20;

/** 锚点节总字符上限：按同一排序继续跳过放不下的条目，避免长篇 URL 撑爆摘要。 */
export const MAX_ANCHOR_SECTION_CHARS = 1200;

export const ANCHOR_KINDS = Object.freeze(["paths", "shas", "issues", "urls"]);

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
// id 类字段是引擎元数据（tool_use_id 等），不是原文，跳过以降低误报。
const ID_FIELD = /(?:^|[_-])ids?$|Ids?$/;

// 抽取顺序即掩码顺序：先抽 URL/路径并掩掉，避免 URL 里的路径、路径里的十六进制段被重复计入。
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

function anchorSegments(messages) {
  const segments = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    collectStrings(message?.content, segments);
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

function renderAnchorSection(entries) {
  const lines = [ANCHOR_SECTION_HEADING];
  for (const kind of ANCHOR_KINDS) {
    const values = entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.value);
    if (values.length > 0) lines.push(`${kind}: ${values.join(", ")}`);
  }
  return lines.join("\n");
}

function normalizedMaxAnchors(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : MAX_ANCHORS;
}

function emptyByKind() {
  return Object.fromEntries(ANCHOR_KINDS.map((kind) => [kind, []]));
}

/**
 * Deterministically extract precise identifiers from the raw folded payload.
 *
 * @param {object[]} messages Raw (unsummarized) folded messages.
 * @param {{maxAnchors?: number}} [options]
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
  const found = new Map();
  let offset = 0;

  for (const segment of anchorSegments(messages)) {
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
  const entries = [];
  for (const entry of ranked.slice(0, maxAnchors)) {
    if (renderAnchorSection([...entries, entry]).length > MAX_ANCHOR_SECTION_CHARS) continue;
    entries.push(entry);
  }

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
