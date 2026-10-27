
import { assertConfigNamespace } from "./loop/config-namespace.js";
import {
  MODEL_CONFIG_RESOLVER_HINT,
  assertSemanticOptionValues,
  collectUnknownContextOptions,
  validateModelConfigResolver,
  validateProviderBoundary,
  validateTranscriptStore,
} from "./assembly-validators.js";

// Re-exported for existing consumers (loop/orchestrator.js imports the hint
// from this module); the canonical definition lives in assembly-validators.js.
export { MODEL_CONFIG_RESOLVER_HINT };

const ASSEMBLY_POLICY_OPTION_NAMES = new Set([
  "system",
  "wrapup",
  "writeToolNames",
  "writeToolPathKeys",
  "replayPolicy",
  "partialPersistence",
  "maxRounds",
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
  "modelMetadata",
  "model",
  "expert",
  "user",
  "task",
  "requestId",
  "toolContext",
  "persistence",
  "onRound",
  "onJudge",
  "onToolResult",
  "onPersistenceError",
  // issue #470-D：折叠替代物 `record.foldedFacts` 的强制投递出口（形状校验见
  // `validateFoldSummaryHook`：给了就必须是函数，给错名字/给错形状都不静默宽容）。
  "onFoldSummary",
  // issue #497（S2）：嵌套命名空间。**装配口也接受**，否则同一份配置换个入口就变成
  // `unknown assembly policy option`，又回到「校验绑在入口路线上」的老病（#496 的病根）。
  // 它的展开与校验都在 `normalizeRunToolLoopOptions`（合并之后、语义相之前）做：装配口这里
  // 只保证名字被放行，于是 `policy.config` 与直连 `config` 走的是**同一棵树、同一套规则**。
  "config",
  "diagnostics",
  "onObserverError",
  "signal",
  "stream",
  "onDelta",
  "onReasoningDelta",
  "onToolCall",
  "onUsage",
]);

function resolveAssemblyMember(value, name) {
  const resolved = typeof value === "function" ? value() : value;
  if (resolved && typeof resolved.then === "function") {
    throw new TypeError(`assembly port ${name} factory must resolve synchronously`);
  }
  return resolved;
}

function missingAssemblyMethods(port) {
  const missing = [];
  if (!port || typeof port !== "object" || Array.isArray(port)) {
    return ["assemblyPort"];
  }
  missing.push(...validateModelConfigResolver(port.modelConfig));
  missing.push(...validateProviderBoundary(port.provider));
  if (!port.tools || !Array.isArray(port.tools.definitions)) {
    missing.push("tools.definitions");
  }
  if (!port.tools || typeof port.tools.executeTool !== "function") {
    missing.push("tools.executeTool");
  }
  if (port.store !== undefined) {
    if (typeof port.store !== "object" || port.store === null || Array.isArray(port.store)) {
      missing.push("store");
    } else {
      missing.push(...validateTranscriptStore(port.store));
    }
  }
  if (!port.session || typeof port.session !== "object" || Array.isArray(port.session)) {
    missing.push("session");
  } else if (typeof port.session.id !== "string" || port.session.id.length === 0) {
    missing.push("session.id");
  }
  if (port.policy !== undefined
    && (typeof port.policy !== "object" || port.policy === null || Array.isArray(port.policy))) {
    missing.push("policy");
  }
  if (port.emit !== undefined && typeof port.emit !== "function") {
    missing.push("emit");
  }
  return missing;
}

/**
 * @typedef {object} AssemblyPort
 * @property {{resolve:(slot?:string)=>Promise<object>|object}} modelConfig
 *   ModelConfigProvider for the assembled session.
 * @property {{chat:(request:object)=>Promise<object>,chatStream?:Function}} provider
 *   Provider instance. The library never reads credentials from this boundary.
 * @property {{definitions:object[],executeTool:Function,getToolMetadata?:Function}} tools
 *   Tool definitions and the structured ToolExecutor.
 * @property {object} [store]
 *   Optional TranscriptStore. Required: `appendRound`, `load`. Optional
 *   capabilities (issue #78): run snapshot (`saveRunSnapshot`,
 *   `loadLatestRunSnapshot`) and run-state (`markRunState`, `saveRunState`,
 *   `loadRunState`); missing optional methods degrade, they do not fail.
 *   `loadRunStateStatus` is an optional host-facing terminal-status reader;
 *   the engine does not consume or validate it.
 * @property {{id:string,modelSlot?:string,resume?:boolean,initialMessages?:object[]}} session
 *   Run identity and optional resume seed.
 * @property {object} [policy]
 *   Explicit run options; unknown policy keys are rejected.
 * @property {(event:string,payload:object)=>void|Promise<void>} [emit]
 *   Optional event sink. It is used only when runToolLoop has no explicit onEvent.
 */

/**
 * Assemble and validate the host boundary once.
 *
 * Required adapter members may be supplied as synchronous factories. This
 * keeps construction at the host composition root while allowing the loop to
 * consume one normalized port object.
 *
 * @param {object} input
 * @returns {AssemblyPort}
 */
export function createAssemblyPort(input = {}) {
  const port = {
    modelConfig: resolveAssemblyMember(input.modelConfig, "modelConfig"),
    provider: resolveAssemblyMember(input.provider, "provider"),
    tools: resolveAssemblyMember(input.tools, "tools"),
    store: resolveAssemblyMember(input.store, "store"),
    session: resolveAssemblyMember(input.session, "session"),
    policy: resolveAssemblyMember(input.policy, "policy"),
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  };
  const missing = missingAssemblyMethods(port);
  if (missing.length > 0) {
    throw new TypeError(`assembly port is missing methods: ${missing.join(", ")}`);
  }
  if (port.session.resume !== undefined && typeof port.session.resume !== "boolean") {
    throw new TypeError("assembly port session.resume must be a boolean");
  }
  if (port.session.initialMessages !== undefined && !Array.isArray(port.session.initialMessages)) {
    throw new TypeError("assembly port session.initialMessages must be an array");
  }
  for (const key of Object.keys(port.policy ?? {})) {
    if (!ASSEMBLY_POLICY_OPTION_NAMES.has(key)) {
      throw new TypeError(`unknown assembly policy option: ${JSON.stringify(key)}`);
    }
  }
  // issue #470-D：`policy.onFoldSummary` 是可选钩子，但**给了就必须是函数**。
  // 不校形状的话，宿主把字符串/对象当钩子递进来会在真正发生折叠那一轮才炸（或默默不投递
  // ——两种都是“跑了很久才知道配错了”），而装配期一条 TypeError 就能说清。
  //
  // issue #496（S1）：`onFoldSummary` 的形状、`context` 的未知子键（#469 / #493 的旋钮家族闭集）、
  // 折叠摘要旋钮的取值（#469 / #493）与**所有承载宿主回调的字段**（`finalGuard` / `retry.sleepImpl` /
  // `reflection.onReflection` / `diagnostics.error` / 顶层 `onFoldSummary` / `context.onBeforeFold` /
  // `context.onAfterFold`）
  // 现在都由**同一个语义相闸口**校：条件与文案只写在 `collectSemanticOptionProblems`
  // （`src/assembly-validators.js`）一处，直连侧（`normalizeRunToolLoopOptions` 合并出
  // `effectiveOptions` 之后）调的是同一个函数。以前这里是「装配口有闭集、直连侧零校验」，
  // 同一份配置走两条路线结论相反（`context.summarizeBudgetMs` 装配口抛、直连静默 `end_turn`）。
  // 路线只贴标签：装配口 `via:"assembly"`，直连 `via:"direct"`。
  // issue #497（S2）：`policy.config` 的**名称/形状**在构造期就校（与上面那条 policy 白名单同相）——
  // 能力键写进 config、未知分组/叶子、把扁平键写在 config 顶层，都在这里抛，`via:"assembly"`。
  // **取值**不在这里校：展开发生在 `normalizeRunToolLoopOptions`（合并之后、语义相之前），
  // 展开后的扁平键由同一道语义相覆盖（`config.folding.context` 的旋钮拼错照样抛）。
  assertConfigNamespace(port.policy?.config, { via: "assembly" });
  assertSemanticOptionValues(port.policy ?? {}, { via: "assembly" });
  // issue #493：非「旋钮家族」的未知 `context` 子键**不抛**——契约允许宿主把私有元数据放这里
  // （`budget.js` 自己也读 `toolContext` / `expert` / `user` / `session` / `requestId`）。
  // 但也不静默：给一条事件，宿主接 `onEvent` / `emit` 就能看见（拼错旋钮名的照旧由上面抛）。
  const toleratedKeys = collectUnknownContextOptions(port.policy?.context);
  if (toleratedKeys.length > 0 && typeof port.emit === "function") {
    try {
      port.emit("context_unknown_option", {
        type: "context_unknown_option",
        keys: toleratedKeys,
        note: "unknown context keys are tolerated as host metadata; summarizer knob typos throw instead",
      });
    } catch {
      // 观察者失败不得影响装配。
    }
  }
  return Object.freeze(port);
}

/**
 * Convert a validated AssemblyPort to the existing fine-grained loop options.
 * Explicit options are merged after this conversion and win.
 *
 * @param {AssemblyPort} input
 * @param {object} [overrides]
 * @returns {Promise<object>}
 */
export async function assemblyPortOptions(input, overrides = {}) {
  const port = createAssemblyPort(input);
  if (overrides.modelConfig !== undefined) {
    const missing = validateModelConfigResolver(overrides.modelConfig);
    if (missing.length > 0) {
      throw new TypeError(`assembly port is missing methods: ${missing.join(", ")}`);
    }
  }
  const options = {
    ...port.policy,
    modelConfig: overrides.modelConfig === undefined
      ? await port.modelConfig.resolve(port.session.modelSlot)
      : overrides.modelConfig,
    provider: port.provider,
    tools: port.tools.definitions,
    executeTool: port.tools.executeTool,
    ...(port.store === undefined ? {} : { store: port.store }),
    runId: port.session.id,
    session: port.session,
    ...(port.session.resume === undefined ? {} : { resume: port.session.resume }),
    ...(port.session.initialMessages === undefined
      ? {}
      : { initialMessages: port.session.initialMessages }),
  };
  if (port.emit !== undefined && options.onEvent === undefined) {
    options.onEvent = (event) => port.emit(event.type, event);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) options[key] = value;
  }
  return options;
}
