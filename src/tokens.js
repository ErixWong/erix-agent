// Conservative, dependency-free token estimates for canonical messages.

/**
 * @typedef {Object} EstimateTokenOptions
 * @property {number} [cjkTokensPerChar=1.5]
 * @property {number} [charsPerToken=3.5]
 * @property {number} [margin=1.15] Multiplicative safety margin.
 * @property {number} [messageOverhead=4] Per-message framing cost.
 * @property {number} [imageTokenCost=1000] Cost assigned to each image block.
 * @property {number} [reasoningBlockCost=0] Additional cost per reasoning block.
 * @property {number} [rawBlockCost=0] Additional cost per raw block.
 */

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef],
  [0x30000, 0x3134f],
];

export const IMAGE_TOKEN_COST = 1000;
export const MESSAGE_OVERHEAD = 4;
export const MESSAGE_OVERHEAD_TOKENS = MESSAGE_OVERHEAD;

/**
 * Lowest code point any CJK range starts at: every code point below it is
 * guaranteed non-CJK, which is what makes the ASCII fast path exact.
 */
const CJK_FLOOR = Math.min(...CJK_RANGES.map(([start]) => start));

/**
 * @param {number} codePoint
 * @returns {boolean}
 */
function isCjkCodePoint(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

/**
 * Character classes feeding the mixed-language heuristic, as `[cjk, nonCjk]`
 * code-point counts.
 *
 * `estimateTokens` ceils once over the whole text, so its *result* is not
 * additive across parts, while these counts are: concatenating text just adds
 * their tallies. A caller that repeatedly re-serializes a growing list (the
 * governor history trim loop) can therefore count each part once and finish with
 * `estimateTokensFromCharacterCounts` instead of re-scanning the whole string.
 *
 * @param {unknown} text
 * @returns {[cjkCharacters: number, otherCharacters: number]}
 */
export function countEstimateCharacters(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  let cjkCharacters = 0;
  let otherCharacters = 0;
  // Hot path: every code point below the first CJK range (all ASCII/Latin/
  // punctuation plus CJK punctuation and kana) is guaranteed non-CJK, so it
  // skips the 8-range scan entirely. Indexing also avoids the string iterator
  // (an order of magnitude slower per character), while the surrogate branch
  // keeps the code-point semantics of `for...of`: one surrogate pair counts as
  // one character, and a lone surrogate counts as one character too (the
  // original yielded U+FFFD there, which is non-CJK as well).
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < CJK_FLOOR) {
      otherCharacters += 1;
      continue;
    }
    let codePoint = codeUnit;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const trail = value.charCodeAt(index + 1);
      if (trail >= 0xdc00 && trail <= 0xdfff) {
        codePoint = 0x10000 + ((codeUnit - 0xd800) * 0x400) + (trail - 0xdc00);
        index += 1;
      }
    }
    if (isCjkCodePoint(codePoint)) cjkCharacters += 1;
    else otherCharacters += 1;
  }
  return [cjkCharacters, otherCharacters];
}

/**
 * Finish an estimate begun with `countEstimateCharacters`, applying the same
 * coefficients and rounding as `estimateTokens`.
 *
 * @param {[cjkCharacters: number, otherCharacters: number]} counts
 * @param {EstimateTokenOptions} [opts]
 * @returns {number}
 */
export function estimateTokensFromCharacterCounts(counts, opts = {}) {
  const cjkTokensPerChar = optionNumber(opts, ["cjkTokensPerChar"], 1.5);
  const charsPerToken = optionNumber(opts, ["charsPerToken"], 3.5);
  const margin = optionNumber(opts, ["margin"], 1.15);
  const rawTokens = (counts?.[0] ?? 0) * cjkTokensPerChar
    + (counts?.[1] ?? 0) / charsPerToken;
  return Math.ceil(rawTokens * margin);
}

/**
 * Estimate tokens using the v0.0 conservative mixed-language heuristic.
 *
 * @param {string} text
 * @param {EstimateTokenOptions} [opts]
 * @returns {number}
 */
export function estimateTokens(text, opts = {}) {
  validateEstimateOptions(opts);
  if (Array.isArray(text)) {
    return text.reduce((total, block) => total + estimateBlockTokens(block, opts), 0);
  }
  return estimateTokensFromCharacterCounts(countEstimateCharacters(text), opts);
}

function optionNumber(opts, names, fallback, { allowZero = false } = {}) {
  for (const name of names) {
    const value = opts?.[name];
    if (value === undefined) continue;
    // Invalid coefficients silently poison budget decisions, so fail fast.
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || (allowZero ? value < 0 : value <= 0)
    ) {
      throw new TypeError(
        `Token estimate option "${name}" must be a finite ${
          allowZero ? "non-negative" : "positive"
        } number`,
      );
    }
    return value;
  }
  return fallback;
}

function validateEstimateOptions(opts) {
  optionNumber(opts, ["cjkTokensPerChar"], 1.5);
  optionNumber(opts, ["charsPerToken"], 3.5);
  optionNumber(opts, ["margin"], 1.15);
  optionNumber(opts, ["imageTokenCost", "imageTokens"], IMAGE_TOKEN_COST, { allowZero: true });
  optionNumber(opts, ["reasoningBlockCost", "reasoningTokenCost"], 0, { allowZero: true });
  optionNumber(opts, ["rawBlockCost", "rawTokenCost"], 0, { allowZero: true });
}

function serializedValue(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function estimateBlockTokens(block, opts) {
  if (block?.type === "image" || block?.type === "image_url") {
    return optionNumber(
      opts,
      ["imageTokenCost", "imageTokens"],
      IMAGE_TOKEN_COST,
      { allowZero: true },
    );
  }
  if (block?.type === "text") return estimateTokens(block.text, opts);
  if (block?.type === "reasoning" || (
    block?.type === "raw"
    && block?.payload
    && block.payload.kind === "reasoning"
  )) {
    const text = block?.type === "reasoning" ? block.text : block.payload.text;
    return estimateTokens(text, opts)
      + optionNumber(
        opts,
        ["reasoningBlockCost", "reasoningTokenCost"],
        0,
        { allowZero: true },
      );
  }
  if (block?.type === "tool_use") {
    return estimateTokens(serializedValue(block.input ?? {}), opts)
      + estimateTokens(block.id ?? "", opts)
      + estimateTokens(block.name ?? "", opts);
  }
  if (block?.type === "tool_result") {
    return estimateTokens(block.content, opts)
      + estimateTokens(block.tool_use_id ?? "", opts);
  }
  if (block?.type === "raw") {
    return estimateTokens(serializedValue(block.payload), opts)
      + optionNumber(opts, ["rawBlockCost", "rawTokenCost"], 0, { allowZero: true });
  }
  return estimateTokens(serializedValue(block), opts);
}

/**
 * Estimate the token count of canonical messages.
 *
 * @param {Array<{content:string|Array<object>}>} messages
 * @param {EstimateTokenOptions} [opts]
 * @returns {number}
 */
export function estimateMessageTokens(messages, opts = {}) {
  validateEstimateOptions(opts);
  const messageOverhead = optionNumber(
    opts,
    ["messageOverhead", "messageOverheadTokens", "overhead"],
    MESSAGE_OVERHEAD,
    { allowZero: true },
  );
  let total = 0;
  for (const message of messages ?? []) {
    total += messageOverhead;
    if (typeof message?.content === "string") {
      total += estimateTokens(message.content, opts);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;

    for (const block of message.content) {
      total += estimateBlockTokens(block, opts);
    }
  }
  return total;
}

/**
 * Compatibility alias matching the touwaka token utility name.
 *
 * @param {Array<{content:string|Array<object>}>} messages
 * @param {EstimateTokenOptions} [opts]
 * @returns {number}
 */
export function estimateMessagesTokens(messages, opts = {}) {
  return estimateMessageTokens(messages, opts);
}
