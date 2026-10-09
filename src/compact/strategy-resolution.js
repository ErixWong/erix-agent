import { createFoldLlmStrategy } from "./fold-llm.js";
import { createFoldStatisticalStrategy } from "./fold-statistical.js";
import { createSlidingWindowStrategy } from "./sliding-window.js";

/**
 * Built-in compaction strategy names (issue #167 方案 C).
 *
 * `context.strategy` accepts either one of these names or a strategy object
 * (object behaviour is unchanged: the engine passes it through verbatim).
 */
export const BUILTIN_COMPACTION_STRATEGIES = Object.freeze({
  "sliding-window": createSlidingWindowStrategy,
  "fold-statistical": createFoldStatisticalStrategy,
  "fold-llm": createFoldLlmStrategy,
});

export const BUILTIN_COMPACTION_STRATEGY_NAMES = Object.freeze(
  Object.keys(BUILTIN_COMPACTION_STRATEGIES),
);

export function isBuiltinCompactionStrategyName(value) {
  return typeof value === "string"
    && Object.hasOwn(BUILTIN_COMPACTION_STRATEGIES, value.trim());
}

function describeStrategy(strategy) {
  if (typeof strategy === "string") return JSON.stringify(strategy);
  if (Array.isArray(strategy)) return "array";
  if (strategy === null) return "null";
  return typeof strategy;
}

function invalidStrategyTypeError(strategy) {
  return new TypeError(
    `context.strategy must be a strategy object or one of the built-in names `
    + `(${BUILTIN_COMPACTION_STRATEGY_NAMES.join(" | ")}), received ${describeStrategy(strategy)}`,
  );
}

/**
 * Resolve `context.strategy` into a strategy instance exactly once (run startup).
 *
 * - `undefined` / `null` → returned unchanged (no configured strategy, same as before).
 * - object → returned unchanged (identity), so the injected-strategy channel keeps its
 *   exact pre-#167 semantics, including a missing `summarizer` on a hand-built
 *   `createFoldLlmStrategy(...)` object.
 * - built-in name → the matching factory is invoked with `options` (plus `foldLlmOptions`
 *   for `fold-llm`, where the engine injects the default provider summarizer).
 * - anything else (unknown name, number, boolean, function) → `TypeError` listing the
 *   legal values, raised at startup rather than on the first compaction.
 *
 * @param {unknown} strategy
 * @param {{
 *   options?: Record<string, unknown>,
 *   foldLlmOptions?: Record<string, unknown>,
 * }} [config]
 */
export function resolveCompactionStrategy(strategy, { options = {}, foldLlmOptions = {} } = {}) {
  if (strategy === undefined || strategy === null) return strategy;
  if (typeof strategy === "object") return strategy;
  if (typeof strategy === "string") {
    const name = strategy.trim();
    const factory = BUILTIN_COMPACTION_STRATEGIES[name];
    if (factory === undefined) throw invalidStrategyTypeError(strategy);
    return name === "fold-llm"
      ? factory({ ...options, ...foldLlmOptions })
      : factory(options);
  }
  throw invalidStrategyTypeError(strategy);
}
