// @ts-check
// runToolLoop 的「选项规范化」（issue #177 刀1）：从 src/loop/orchestrator.js 原样外提，
// 公共 API 与行为零变化。职责边界**只有**下面四件事，其余选项校验仍留在 orchestrator 里
// ——它们消费的是参数解构里的默认值（`maxRounds = 8` 之类），搬过来会把默认值复制成两份：
//   1. 选项对象形状检查（`options` 必须是非数组对象）；
//   2. 未知键白名单检查（`RUN_TOOL_LOOP_OPTION_NAMES`）；
//   3. 未知键的「did you mean」建议（编辑距离 + 阈值 `Math.max(2, ⌊len/3⌋)`）；
//   4. 把 `assemblyPortOptions(assemblyPort)` 的结果与显式选项合并成 `effectiveOptions`。
//
// 顺序即语义，且被 test/loop-option-normalization.test.js 逐条钉住，所以本模块严格按
//   形状检查 → 未知键检查 → assemblyPortOptions → 显式值合并
// 的次序执行；调用方（orchestrator）在此之后才做「解构默认值 → 能力缺失检查 →
// modelConfig.resolve」，能力缺失检查早于 resolve 的那条次序不受本模块影响。
//
// 两处「顺手就会改错」的写法，刻意保留原样，勿改：
//   · 合并条件必须是 `value !== undefined`：`false`/`null` 要能覆盖 assembled 值，
//     `undefined` 不能覆盖（改成 `??`/`!= null`/truthy 都会红）。
//   · 建议阈值必须是 `Math.max(2, Math.floor(len / 3))`，且平局用严格 `<` 比较，
//     于是**白名单顺序**就是平局优先级（不是字典序）。
//
// 本模块不发事件、不读 HOME/cwd、不需要任何事件发射回调，因此与 orchestrator 内部的
// 声明顺序依赖（`notifyCapabilitySkipped` 等 TDZ 陷阱）无关。
// 零运行时依赖：只用相对路径。

import { assemblyPortOptions } from "../assembly.js";

/**
 * `runToolLoop` 接受的选项名白名单。
 *
 * ⚠ 这份名单的**顺序**同时是未知键建议的平局优先级（`optionSuggestion` 用严格 `<`），
 * 所以它不是集合语义、不许排序、不许增删项而不同时确认建议行为。
 * 计数与顺序都由 `test/loop-option-normalization.test.js` 钉住（60 项）。
 *
 * @type {string[]}
 */
export const RUN_TOOL_LOOP_OPTION_NAMES = [
  "assemblyPort",
  "provider",
  "system",
  "cacheStablePrefix",
  "wrapup",
  "initialUserMessage",
  "initialMessages",
  "tools",
  "outputHygiene",
  "writeToolNames",
  "writeToolPathKeys",
  "executeTool",
  "replayPolicy",
  "partialPersistence",
  "maxRounds",
  "cacheCapable",
  "toolResultTtl",
  "toolResultFoldMinTokens",
  "maxTokens",
  "temperature",
  "topP",
  "timeoutMs",
  "deadlineMs",
  "reflection",
  "stallDetection",
  "retry",
  "completion",
  "finalGuard",
  "finalGuardMaxRetries",
  "finalGuardTimeoutMs",
  "maxTokenContinuations",
  "context",
  "todoStateProvider",
  "semanticStateProvider",
  "modelConfig",
  "modelMetadata",
  "model",
  "expert",
  "user",
  "task",
  "session",
  "requestId",
  "toolContext",
  "store",
  "persistence",
  "runId",
  "resume",
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  "diagnostics",
  "onObserverError",
  "signal",
  "stream",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
  "onEvent",
];

/** 白名单的查询视图（与 `RUN_TOOL_LOOP_OPTION_NAMES` 同源，勿另行维护）。 */
export const RUN_TOOL_LOOP_OPTION_SET = new Set(RUN_TOOL_LOOP_OPTION_NAMES);

/**
 * 编辑距离（Levenshtein），滚动数组实现。
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

/**
 * 为未知选项键挑一个「did you mean」建议。
 *
 * 阈值 `Math.max(2, Math.floor(unknownName.length / 3))`；等距平局由
 * `RUN_TOOL_LOOP_OPTION_NAMES` 的顺序决定（严格 `<` ⇒ 名单在前者赢）。
 *
 * @param {string} unknownName
 * @returns {string|undefined} 距离超过阈值（含「名单为空」）时返回 undefined
 */
export function optionSuggestion(unknownName) {
  let best;
  for (const optionName of RUN_TOOL_LOOP_OPTION_NAMES) {
    const distance = levenshteinDistance(unknownName, optionName);
    if (best === undefined || distance < best.distance) {
      best = { name: optionName, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(unknownName.length / 3));
  return best?.distance <= threshold ? best.name : undefined;
}

/**
 * 选项对象形状 + 未知键检查：必须在任何宿主端口被读取之前抛出。
 *
 * 抛错文案（`unknown runToolLoop option: "x" (did you mean "y"?)`）是宿主可见的，逐字保留。
 *
 * @param {Record<string, any>|null|undefined} options
 * @returns {void}
 */
export function assertRunToolLoopOptionNames(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("runToolLoop options must be an object");
  }
  for (const optionName of Object.keys(options)) {
    if (!RUN_TOOL_LOOP_OPTION_SET.has(optionName)) {
      const suggestion = optionSuggestion(optionName);
      throw new TypeError(
        `unknown runToolLoop option: ${JSON.stringify(optionName)}`
        + (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : ""),
      );
    }
  }
}

/**
 * 规范化 `runToolLoop` 的入参：形状/未知键检查 → `assemblyPortOptions` → 显式值合并。
 *
 * 合并语义（`value !== undefined` 才覆盖）与调用顺序全部沿用外提前的实现，
 * 见文件头的两处「勿改」说明。
 *
 * @param {Record<string, any>} options
 * @returns {Promise<{
 *   assemblyPort: import("../assembly.js").AssemblyPort | undefined,
 *   explicitOptions: Record<string, any>,
 *   effectiveOptions: Record<string, any>,
 * }>} `effectiveOptions` 是 assembled 值与显式值的合并结果，由调用方继续做
 *   解构默认值与后续校验。
 */
export async function normalizeRunToolLoopOptions(options) {
  assertRunToolLoopOptionNames(options);

  const { assemblyPort, ...explicitOptions } = options;
  const assembledOptions = assemblyPort === undefined
    ? {}
    : await assemblyPortOptions(
      assemblyPort,
      explicitOptions.modelConfig === undefined
        ? {}
        : { modelConfig: explicitOptions.modelConfig },
    );
  const effectiveOptions = { ...assembledOptions };
  for (const [key, value] of Object.entries(explicitOptions)) {
    if (value !== undefined) effectiveOptions[key] = value;
  }

  return { assemblyPort, explicitOptions, effectiveOptions };
}
