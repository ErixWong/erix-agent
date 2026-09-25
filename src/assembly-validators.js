/**
 * Shared boundary validators for the assembly port and the fine-grained
 * loop options. Both entry shapes (createAssemblyPort/assemblyPortOptions
 * and runToolLoop with fine-grained options) must report the same missing
 * capability descriptions, so the checks live here as the single source.
 *
 * Internal module: zero runtime dependencies, pure ESM, not re-exported
 * from the public entry point (src/index.js).
 */

export const MODEL_CONFIG_RESOLVER_HINT =
  "modelConfig must expose resolve(slot); wrap plain config with createModelConfigResolver(...)";

/**
 * The complete TranscriptStore surface. Single source of truth; assembly.js
 * and loop/orchestrator.js both derive their store checks from this list.
 */
export const TRANSCRIPT_STORE_METHODS = [
  "appendRound",
  "load",
  "saveCheckpoint",
  "appendCheckpoint",
  "loadLatestCheckpoint",
  "saveRunState",
  "loadRunState",
  "markRunState",
];

/**
 * Provider capability check: a provider satisfies the boundary when it
 * exposes at least one of chat / chatStream.
 *
 * @param {object} provider
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function validateProviderBoundary(provider) {
  if (!provider
    || (typeof provider.chat !== "function"
      && typeof provider.chatStream !== "function")) {
    return ["provider.chat or provider.chatStream"];
  }
  return [];
}

/**
 * ModelConfig resolver check. A plain config object is not accepted at the
 * boundary; the message carries the resolver hint.
 *
 * @param {object} modelConfig
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function validateModelConfigResolver(modelConfig) {
  if (!modelConfig || typeof modelConfig.resolve !== "function") {
    return [`modelConfig.resolve (${MODEL_CONFIG_RESOLVER_HINT})`];
  }
  return [];
}

/**
 * TranscriptStore method-surface check. Returns one `store.<method>` entry
 * per missing method. Callers own the surrounding semantics (optional vs
 * required store, error prefix).
 *
 * @param {object} store
 * @returns {string[]} missing method descriptions (empty when complete)
 */
export function validateTranscriptStore(store) {
  return TRANSCRIPT_STORE_METHODS
    .filter((method) => typeof store?.[method] !== "function")
    .map((method) => `store.${method}`);
}

/**
 * Aggregated loop-startup capability check for runToolLoop. Preserves the
 * historical check order so the produced message stays byte-compatible:
 * provider boundary, executeTool, then modelConfig/session for the
 * fine-grained port shape (or an explicit modelConfig override on an
 * assembly port).
 *
 * @param {object} input
 * @param {object} input.provider
 * @param {Function} input.executeTool
 * @param {object} [input.modelConfig]
 * @param {object} [input.session]
 * @param {boolean} [input.fineGrainedPortShape]
 * @param {boolean} [input.hasExplicitModelConfigOverride]
 * @returns {string[]} missing capability descriptions (empty when satisfied)
 */
export function collectLoopCapabilitiesMissing({
  provider,
  executeTool,
  modelConfig,
  session,
  fineGrainedPortShape = false,
  hasExplicitModelConfigOverride = false,
}) {
  const missing = [
    ...validateProviderBoundary(provider),
  ];
  if (typeof executeTool !== "function") missing.push("executeTool");
  if (fineGrainedPortShape) {
    missing.push(...validateModelConfigResolver(modelConfig));
    if (session !== undefined && (!session || typeof session !== "object"
      || Array.isArray(session)
      || typeof session.id !== "string" || session.id.length === 0)) {
      missing.push("session.id");
    }
  } else if (hasExplicitModelConfigOverride) {
    missing.push(...validateModelConfigResolver(modelConfig));
  }
  return missing;
}
