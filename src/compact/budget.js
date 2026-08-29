/**
 * Compute the usable context budget after output and safety headroom.
 *
 * @param {{contextWindowTokens:number, maxOutputTokens:number}} options
 * @returns {number}
 */
export function computeBudget({ contextWindowTokens, maxOutputTokens }) {
  return contextWindowTokens
    - maxOutputTokens
    - Math.max(2000, Math.ceil(contextWindowTokens * 0.1));
}
