import { createFoldLlmStrategy } from "./fold-llm.js";

/**
 * Resolve `context.strategy` into a strategy instance exactly once (run startup).
 *
 * issue #261127-12：折叠策略的**名字形态已删除**（`"fold-llm"` 曾是唯一合法名字，写与不写
 * 行为一致 ⇒ 纯税，用户裁决）。折叠策略从此只有两种来源，且**永不为空**：
 *
 * - `undefined` / `null`（没配策略）→ 引擎内置 `createFoldLlmOptions` 展平出来的 fold-llm 实例，
 *   携带宿主注入的默认 summarizer（`foldLlmOptions`）。引擎在 `orchestrator.js` 启动时已把
 *   `reusableCompactionSummarizer` 与账本播种等透传进 `foldLlmOptions`，所以缺省即语义折叠。
 * - object → returned unchanged (identity), so the injected-strategy channel keeps its
 *   exact pre-#167 semantics, including a missing `summarizer` on a hand-built
 *   `createFoldLlmStrategy(...)` object. 契约不变：对象形态**不吃** `foldLlmOptions`
 *   （`summarizer` / 三个策略层上限对宿主自带的策略对象静默无效，由宿主自己负责）。
 * - anything else (the former `"fold-llm"` name, a number, boolean, function) → `TypeError`，
 *   文案直说「只接受策略对象」，在启动期抛出而不是第一次折叠时。
 *
 * @param {unknown} strategy
 * @param {{
 *   options?: Record<string, unknown>,
 *   foldLlmOptions?: Record<string, unknown>,
 * }} [config]
 */
export function resolveCompactionStrategy(strategy, { options = {}, foldLlmOptions = {} } = {}) {
  if (strategy === undefined || strategy === null) {
    // 缺省策略：引擎内置 fold-llm（`foldLlmOptions` 里的默认 summarizer 在这里展进工厂）。
    return createFoldLlmStrategy({ ...options, ...foldLlmOptions });
  }
  if (typeof strategy === "object") return strategy;
  throw invalidStrategyTypeError(strategy);
}

function describeStrategy(strategy) {
  if (typeof strategy === "string") return JSON.stringify(strategy);
  if (Array.isArray(strategy)) return "array";
  if (strategy === null) return "null";
  return typeof strategy;
}

function invalidStrategyTypeError(strategy) {
  return new TypeError(
    `context.strategy must be a strategy object (the built-in strategy **name** form was `
    + `removed; fold-llm is the engine default and needs no name), received ${describeStrategy(strategy)}`,
  );
}
