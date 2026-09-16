import { validateResourceStore } from "./store/resource.js";

export const MODEL_CONFIG_RESOLVER_HINT =
  "modelConfig must expose resolve(slot); wrap plain config with createModelConfigResolver(...)";

const TRANSCRIPT_STORE_METHODS = [
  "appendRound",
  "load",
  "recall",
  "saveCheckpoint",
  "appendCheckpoint",
  "loadLatestCheckpoint",
  "saveRunState",
  "loadRunState",
  "markRunState",
];

const ASSEMBLY_POLICY_OPTION_NAMES = new Set([
  "system",
  "wrapup",
  "writeToolNames",
  "writeToolPathKeys",
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
  "runState",
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
  if (!port.modelConfig || typeof port.modelConfig.resolve !== "function") {
    missing.push(`modelConfig.resolve (${MODEL_CONFIG_RESOLVER_HINT})`);
  }
  if (!port.provider
    || (typeof port.provider.chat !== "function"
      && typeof port.provider.chatStream !== "function")) {
    missing.push("provider.chat or provider.chatStream");
  }
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
      for (const method of TRANSCRIPT_STORE_METHODS) {
        if (typeof port.store[method] !== "function") missing.push(`store.${method}`);
      }
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
 *   Optional complete TranscriptStore implementation with all nine methods.
 * @property {{id:string,modelSlot?:string,resume?:boolean,initialMessages?:object[]}} session
 *   Run identity and optional resume seed.
 * @property {{put:Function,get:Function}} [resourceStore]
 *   Optional opaque resource archive used by compaction adapters.
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
    ...(input.resourceStore === undefined
      ? {}
      : { resourceStore: validateResourceStore(
        resolveAssemblyMember(input.resourceStore, "resourceStore"),
      ) }),
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
  if (overrides.modelConfig !== undefined
    && (!overrides.modelConfig || typeof overrides.modelConfig.resolve !== "function")) {
    throw new TypeError(`assembly port is missing methods: modelConfig.resolve (${MODEL_CONFIG_RESOLVER_HINT})`);
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
    ...(port.resourceStore === undefined ? {} : { resourceStore: port.resourceStore }),
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
