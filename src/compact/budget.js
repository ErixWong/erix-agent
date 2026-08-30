import { KitError } from "../providers/errors.js";

/**
 * Compute the usable context budget after output and safety headroom.
 *
 * @param {{contextWindowTokens:number, maxOutputTokens:number}} options
 * @returns {number}
 */
export function computeBudget({ contextWindowTokens, maxOutputTokens }) {
  if (
    !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens <= 0
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < 0
  ) {
    throw new KitError(
      "invalid_budget",
      "contextWindowTokens and maxOutputTokens must be valid token counts",
      { retryable: false },
    );
  }

  const budget = contextWindowTokens
    - maxOutputTokens
    - Math.max(2000, Math.ceil(contextWindowTokens * 0.1));
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new KitError(
      "invalid_budget",
      `Computed context budget must be positive (got ${budget})`,
      { retryable: false },
    );
  }
  return budget;
}
