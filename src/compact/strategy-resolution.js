import { createFoldLlmStrategy } from "./fold-llm.js";

/**
 * Built-in compaction strategy names (issue #167 方案 C；issue #898 第二刀收敛为单一默认).
 *
 * `context.strategy` accepts either this name or a strategy object (object behaviour
 * is unchanged: the engine passes it through verbatim).
 *
 * issue #898: 折叠**必须由 LLM 完成**，`sliding-window` / `fold-statistical` 不再是「宿主可显式
 * 选择的零 LLM 策略」——机械折叠产出的是 `工具足迹：exec×5` 这种零语义文本，等于把历史丢进一个
 * 看起来像摘要的壳里。这里只保留 `fold-llm` 作为唯一可选默认；底层模块（`sliding-window.js` /
 * `fold-statistical.js`）**不删**——引擎的预算兜底仍复用 `sliding-window`（见 orchestrator）。
 */
export const BUILTIN_COMPACTION_STRATEGIES = Object.freeze({
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
