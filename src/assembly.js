
import {
  MODEL_CONFIG_RESOLVER_HINT,
  validateContextOptionNames,
  validateFoldSummarizerCaps,
  validateFoldSummaryHook,
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
  const foldSummaryHookProblems = validateFoldSummaryHook(port.policy?.onFoldSummary);
  if (foldSummaryHookProblems.length > 0) {
    throw new TypeError(foldSummaryHookProblems.join("; "));
  }
  // issue #469：`context` 的未知子键与四个折叠摘要上限都在装配期校。
  // 以前写错键名是**静默丢弃**（宿主以为配上了，实际跑默认值，`#331` 的病），
  // 而 `0` / 负数 / 字符串会等到真发生折叠那一轮才现形。
  const contextOptionProblems = [
    ...validateContextOptionNames(port.policy?.context),
    ...validateFoldSummarizerCaps(port.policy?.context),
  ];
  if (contextOptionProblems.length > 0) {
    throw new TypeError(contextOptionProblems.join("; "));
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
