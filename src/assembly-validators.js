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
 * The required TranscriptStore surface (issue #78): only the transcript
 * append/load pair is mandatory. Everything else — run snapshots and
 * run-state — is an optional capability; a store without those methods
 * still runs, it just cannot resume a crashed run mid-flight.
 */
export const TRANSCRIPT_STORE_METHODS = [
  "appendRound",
  "load",
];

/**
 * Optional run-snapshot capability (issue #78). Semantics are latest-only
 * overwrite — a run snapshot is an autosave of the in-flight run used only
 * for crash resume, not a multi-version checkpoint. `appendCheckpoint` was
 * merged into `saveRunSnapshot` because both were identical overwrite
 * writes. Reference for diagnostics/documentation; NOT enforced by
 * validateTranscriptStore.
 */
export const RUN_SNAPSHOT_STORE_METHODS = [
  "saveRunSnapshot",
  "loadLatestRunSnapshot",
];

/**
 * Optional run-state capability (issue #78). Reference for
 * diagnostics/documentation; NOT enforced by validateTranscriptStore.
 */
export const RUN_STATE_STORE_METHODS = [
  "saveRunState",
  "loadRunState",
  "markRunState",
];

/**
 * Full optional surface: run snapshots + run-state. Convenience aggregate
 * of RUN_SNAPSHOT_STORE_METHODS and RUN_STATE_STORE_METHODS.
 */
export const OPTIONAL_TRANSCRIPT_STORE_METHODS = [
  ...RUN_SNAPSHOT_STORE_METHODS,
  ...RUN_STATE_STORE_METHODS,
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
 * TranscriptStore required-method check (issue #78): only `appendRound` and
 * `load` are required; missing optional capabilities (run snapshot /
 * run-state) are reported by the engine as a one-time diagnostic and the
 * corresponding persistence is skipped. Returns one `store.<method>` entry
 * per missing required method. Callers own the surrounding semantics
 * (optional vs required store, error prefix).
 *
 * @param {object} store
 * @returns {string[]} missing method descriptions (empty when required methods present)
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
