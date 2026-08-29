import { estimateTokens } from "../tokens.js";

const EMPTY_RESULT = "未命中。建议换更短的关键词或同义词重试";
const DEFAULT_SEGMENT_TOKENS = 300;
const DEFAULT_MAX_SEGMENTS = 5;
const DEFAULT_TOTAL_TOKENS = 1500;
const DEFAULT_OVERVIEW_TOKENS = 500;

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function blockText(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return String(block.text ?? "");
  if (block.type === "tool_use") return `${block.name ?? ""}${JSON.stringify(block.input)}`;
  if (block.type === "tool_result") return String(block.content ?? "");
  return null;
}

function recordFragments(record) {
  const fragments = [];
  for (const message of record?.messages ?? []) {
    for (const block of blocksFor(message?.content)) {
      const text = blockText(block);
      if (text !== null) fragments.push(text);
    }
  }
  // 折叠原文也进检索语料（fold 只影响上下文视图，档案含 foldedPayload——
  // 被折轮次正好是 recall 的主要目标；标记来源防与当轮消息混淆）
  if (Array.isArray(record?.foldedPayload) && record.foldedPayload.length > 0) {
    fragments.push("[以下为该轮折叠时归档的早期原文]");
    for (const message of record.foldedPayload) {
      for (const block of blocksFor(message?.content)) {
        const text = blockText(block);
        if (text !== null) fragments.push(text);
      }
    }
  }
  return fragments;
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

function nonNegativeInteger(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function prefixForBudget(text, budget) {
  if (budget <= 0) return "";
  const characters = Array.from(text);
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= budget) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

function truncateText(text, budget, marker = "[段截断]") {
  const value = String(text ?? "");
  if (estimateTokens(value) <= budget) return value;
  const markerTokens = estimateTokens(marker);
  if (markerTokens >= budget) return prefixForBudget(value, budget);
  let prefix = prefixForBudget(value, budget - markerTokens);
  let result = `${prefix}${marker}`;
  while (estimateTokens(result) > budget && prefix.length > 0) {
    prefix = Array.from(prefix).slice(0, -1).join("");
    result = `${prefix}${marker}`;
  }
  return result;
}

function fitBodyWithSuffix(body, suffix, budget, marker = "[段截断]") {
  const suffixText = `\n${suffix}`;
  if (estimateTokens(suffixText) > budget) return truncateText(suffix, budget, "");
  let boundedBody = truncateText(
    body,
    Math.max(0, budget - estimateTokens(suffixText)),
    marker,
  );
  let result = `${boundedBody}${suffixText}`;
  while (estimateTokens(result) > budget && boundedBody.length > 0) {
    boundedBody = Array.from(boundedBody).slice(0, -1).join("");
    result = `${boundedBody}${suffixText}`;
  }
  return result;
}

function limitsFrom(options) {
  const limits = options ?? {};
  const hasPatternSegmentLimit = limits.segmentTokens !== undefined
    || limits.perSegmentTokens !== undefined
    || limits.maxSegmentTokens !== undefined
    || limits.maxPerSegmentTokens !== undefined;
  const hasPatternTotalLimit = limits.totalTokens !== undefined
    || limits.maxTotalTokens !== undefined;
  return {
    segmentTokens: nonNegativeInteger(
      limits.segmentTokens
        ?? limits.perSegmentTokens
        ?? limits.maxSegmentTokens
        ?? limits.maxPerSegmentTokens,
      DEFAULT_SEGMENT_TOKENS,
    ),
    maxSegments: nonNegativeInteger(limits.maxSegments, DEFAULT_MAX_SEGMENTS),
    totalTokens: nonNegativeInteger(
      limits.totalTokens ?? limits.maxTotalTokens,
      DEFAULT_TOTAL_TOKENS,
    ),
    overviewTokens: nonNegativeInteger(limits.overviewTokens, DEFAULT_OVERVIEW_TOKENS),
    rangeSegmentTokens: nonNegativeInteger(
      limits.rangeSegmentTokens ?? limits.singleResultTokens,
      500,
    ),
    rangeMaxSegments: nonNegativeInteger(
      limits.rangeMaxSegments,
      Number.MAX_SAFE_INTEGER,
    ),
    rangeTotalTokens: nonNegativeInteger(
      limits.rangeTotalTokens
        ?? (hasPatternTotalLimit ? limits.totalTokens ?? limits.maxTotalTokens : undefined),
      hasPatternSegmentLimit ? DEFAULT_TOTAL_TOKENS : 2000,
    ),
  };
}

function cappedSegments(segments, offset, limits) {
  const totalSegments = segments.length;
  const selected = segments.slice(offset);
  const candidates = selected.slice(0, limits.maxSegments).map((segment) => (
    truncateText(segment, limits.segmentTokens)
  ));
  let body = candidates.join("\n");
  let nextOffset = offset + candidates.length;
  let hasMore = nextOffset < totalSegments;

  if (estimateTokens(body) > limits.totalTokens) {
    hasMore = true;
    const markerTokens = estimateTokens(
      `[截断，共 ${totalSegments} 段，offset=${nextOffset} 继续]`,
    );
    body = truncateText(
      body,
      Math.max(0, limits.totalTokens - markerTokens),
      "[段截断]",
    );
  }

  if (hasMore) {
    const marker = `[截断，共 ${totalSegments} 段，offset=${nextOffset} 继续]`;
    return fitBodyWithSuffix(body, marker, limits.totalTokens);
  }
  return truncateText(body, limits.totalTokens);
}

// 返回 { test, firstIndex }：firstIndex 给出命中位置（超长行居中截取用）
function makeMatcher(pattern) {
  if (/[|\[\]()+*?\\^$]/.test(pattern)) {
    try {
      const re = new RegExp(pattern);
      return { test: (s) => re.test(s), firstIndex: (s) => { const i = s.search(re); return i; } };
    } catch { /* 非法正则回落子串 */ }
  }
  return { test: (s) => s.includes(pattern), firstIndex: (s) => s.indexOf(pattern) };
}

// 超长单行（大段无换行文本）：以命中位置为中心截取窗口，保证命中词不被后续段截断切掉
function centerOnMatch(line, firstIndex, maxChars = 600) {
  if (line.length <= maxChars) return line;
  const at = Math.max(0, firstIndex);
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(at - half, line.length - maxChars));
  return (start > 0 ? "…" : "") + line.slice(start, start + maxChars) + (start + maxChars < line.length ? "…" : "");
}

function patternSegments(records, pattern) {
  const lines = [];
  const fragments = [];
  for (const record of records) {
    for (const fragment of recordFragments(record)) {
      const start = lines.length;
      const fragmentLines = splitLines(fragment);
      lines.push(...fragmentLines);
      fragments.push({ start, end: lines.length - 1, text: fragment });
    }
  }

  const matches = makeMatcher(pattern);
  const hits = [];
  for (const fragment of fragments) {
    if (!matches.test(fragment.text)) continue;
    const matchingLines = lines
      .slice(fragment.start, fragment.end + 1)
      .map((line, index) => matches.test(line) ? fragment.start + index : -1)
      .filter((index) => index >= 0);
    hits.push(...(matchingLines.length > 0 ? matchingLines : [fragment.start]));
  }

  // 每个命中行独立成段：命中行居中截取放最前（保证命中词不被任何下游截断切掉），
  // 上下文邻行截短缀后（合并范围会让填充邻居吃掉段预算）
  const short = (l) => (l.length > 120 ? l.slice(0, 120) + "…" : l);
  const uniqueHits = [...new Set(hits)].sort((a, b) => a - b);
  return uniqueHits.map((hit) => {
    const before = lines.slice(Math.max(0, hit - 2), hit).map((l) => "  ↑ " + short(l));
    const after = lines.slice(hit + 1, hit + 3).map((l) => "  ↓ " + short(l));
    return [centerOnMatch(lines[hit], matches.firstIndex(lines[hit])), ...before, ...after].join("\n");
  });
}

function overview(records, budget) {
  const lines = records.map((record) => {
    const tools = [];
    for (const message of record.messages ?? []) {
      for (const block of blocksFor(message?.content)) {
        if (block?.type === "tool_use" && block.name !== undefined) {
          tools.push(String(block.name));
        }
      }
    }
    const folded = record.folded ? " [folded]" : "";
    return `round ${record.round}${folded} messages=${(record.messages ?? []).length} tools=${tools.join(",") || "-"}`;
  });
  const foldedRounds = records.filter((record) => record.folded).map((record) => record.round);
  const watermark = foldedRounds.length === 0
    ? "折叠水位线: none"
    : `折叠水位线: ${Math.min(...foldedRounds)}-${Math.max(...foldedRounds)}`;
  const body = lines.join("\n");
  const complete = body ? `${body}\n${watermark}` : watermark;
  if (estimateTokens(complete) <= budget) return complete;
  return fitBodyWithSuffix(body, watermark, budget, "[概览截断]");
}

/**
 * Create a transcript recall tool with progressive, bounded output.
 *
 * @param {{store:{load:Function}, runId:string, limits?:object}} options
 * @returns {{schema:object, execute:(input?:object)=>Promise<string>}}
 */
export function createRecallTool({ store, runId, limits = {} }) {
  const bounded = limitsFrom(limits);
  const schema = {
    name: "recall",
    description: "Recall folded transcript context: start with a pattern, then use a round range.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "关键词（子串匹配；含 | 等正则元字符时按正则匹配）。优先用这个，短词比长句准" },
        fromRound: { type: "integer" },
        toRound: { type: "integer" },
        offset: { type: "integer" },
      },
      additionalProperties: false,
    },
  };

  const execute = async (input = {}) => {
    const records = await store.load(runId);
    const options = input && typeof input === "object" ? input : {};
    const offset = nonNegativeInteger(options.offset, 0);

    if (options.pattern !== undefined) {
      return cappedSegments(patternSegments(records, String(options.pattern)), offset, bounded)
        || EMPTY_RESULT;
    }

    if (options.fromRound !== undefined || options.toRound !== undefined) {
      const selected = records.filter((record) => (
        (options.fromRound === undefined || record.round >= options.fromRound)
        && (options.toRound === undefined || record.round <= options.toRound)
      ));
      const segments = selected.map((record) => recordFragments(record).join("\n"));
      const rangeLimits = {
        ...bounded,
        maxSegments: bounded.rangeMaxSegments,
        segmentTokens: bounded.rangeSegmentTokens,
        totalTokens: bounded.rangeTotalTokens,
      };
      return cappedSegments(segments, offset, rangeLimits) || EMPTY_RESULT;
    }

    return overview(records, bounded.overviewTokens);
  };

  return { schema, execute };
}
