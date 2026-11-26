import { KitError } from "../providers/errors.js";

/**
 * Compute the usable context budget after output and safety headroom.
 *
 * issue #892：`toolDefinitionTokens` 是「工具定义序列化后的估算 token」。每个请求都会把
 * `payload.tools` 发给 provider，而这份开销以前从没进过预算 ⇒ 派生预算乐观（工具越多越乐观）。
 * 默认 `0` ⇒ 没有工具时逐字等于改动前；非零时从预算里扣掉这一项，使预算与折叠判据口径一致。
 *
 * @param {{contextWindowTokens:number, maxOutputTokens:number, toolDefinitionTokens?:number}} options
 * @returns {number}
 */
export function computeBudget({ contextWindowTokens, maxOutputTokens, toolDefinitionTokens = 0 }) {
  if (
    !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens <= 0
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < 0
    || !Number.isSafeInteger(toolDefinitionTokens)
    || toolDefinitionTokens < 0
  ) {
    throw new KitError(
      "invalid_budget",
      "contextWindowTokens, maxOutputTokens and toolDefinitionTokens must be valid token counts",
      { retryable: false },
    );
  }

  const budget = contextWindowTokens
    - maxOutputTokens
    - Math.max(2000, Math.ceil(contextWindowTokens * 0.1))
    - toolDefinitionTokens;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new KitError(
      "invalid_budget",
      `Computed context budget must be positive (got ${budget})`,
      { retryable: false },
    );
  }
  return budget;
}
