// Conservative, dependency-free token estimates for canonical messages.

/**
 * @typedef {Object} EstimateTokenOptions
 * @property {number} [cjkTokensPerChar=1.5]
 * @property {number} [charsPerToken=3.5]
 * @property {number} [margin=1.15] Multiplicative safety margin.
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

/**
 * @param {string} character
 * @returns {boolean}
 */
function isCjkUnifiedIdeograph(character) {
  const codePoint = character.codePointAt(0);
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Estimate tokens using the v0.0 conservative mixed-language heuristic.
 *
 * @param {string} text
 * @param {EstimateTokenOptions} [opts]
 * @returns {number}
 */
export function estimateTokens(text, opts = {}) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const cjkTokensPerChar = opts.cjkTokensPerChar ?? 1.5;
  const charsPerToken = opts.charsPerToken ?? 3.5;
  const margin = opts.margin ?? 1.15;

  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of value) {
    if (isCjkUnifiedIdeograph(character)) cjkCharacters += 1;
    else otherCharacters += 1;
  }

  const rawTokens = cjkCharacters * cjkTokensPerChar + otherCharacters / charsPerToken;
  return Math.ceil(rawTokens * margin);
}

/**
 * Estimate the token count of canonical messages.
 *
 * @param {Array<{content:string|Array<object>}>} messages
 * @returns {number}
 */
export function estimateMessageTokens(messages) {
  let total = 0;
  for (const message of messages ?? []) {
    if (typeof message?.content === "string") {
      total += estimateTokens(message.content);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;

    for (const block of message.content) {
      if (block?.type === "text") {
        total += estimateTokens(block.text);
      } else if (block?.type === "tool_use") {
        total += estimateTokens(JSON.stringify(block.input ?? {}));
      } else if (block?.type === "tool_result") {
        total += estimateTokens(block.content);
      }
    }
  }
  return total;
}
