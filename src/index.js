// erix-agent 公共导出（tools 子路径 v0.2 才落地，见 package.json exports）
export { KitError, classifyHttpError, classifyFetchException } from "./providers/errors.js";
export { createOpenAIProvider } from "./providers/openai.js";
export { createAnthropicProvider } from "./providers/anthropic.js";
export {
  canonicalToOpenAIMessages,
  canonicalToolsToOpenAI,
  openAIResponseToCanonical,
} from "./messages/canonical.js";
export {
  normalizeOpenAIUsage,
  normalizeOpenAIStopReason,
  parseOpenAIToolArguments,
  createOpenAIStreamAccumulator,
} from "./messages/openai-normalization.js";
export {
  canonicalToAnthropicRequest,
  anthropicResponseToCanonical,
  createAnthropicStreamAssembler,
} from "./messages/anthropic.js";
export { groupIntoRounds, validateMessages } from "./messages/rounds.js";
// 工具事实契约面（工单 261014 T1）：宿主与契约测试都要能 import 到同一份字段归属常量。
export {
  TOOL_RESULT_CONTRACT,
  TOOL_FACT_ENGINE_NS,
  TOOL_FACT_HOST_NS,
  buildToolResultFact,
  allocateToolCallKey,
  ensureToolCallKeyOnBlock,
} from "./tool-fact.js";
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  IMAGE_TOKEN_COST,
  MESSAGE_OVERHEAD,
  MESSAGE_OVERHEAD_TOKENS,
} from "./tokens.js";
export { computeBudget } from "./compact/budget.js";
export { createSlidingWindowStrategy } from "./compact/sliding-window.js";
export { createFoldStatisticalStrategy } from "./compact/fold-statistical.js";
export {
  buildFoldNavigationRecord,
  mergeFoldNavigationRecords,
} from "./compact/fold-statistical.js";
export { enforceSize } from "./compact/enforce-size.js";
export { createMemoryTranscriptStore } from "./store/memory.js";
export { createFileTranscriptStore } from "./store/file.js";
// 折叠义务必须可履行（issue #401）：宿主自研 store 的 `load()` 要做与内置 store 同一件事，
// 而在此之前这个函数**拿不到**——packed install 里 `'foldMessageRows' in await import("erix-agent")`
// 为 false，深路径 `erix-agent/src/store/message-rows.js` 又是 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
// `isRoundCarrier` 是内部判据，刻意**不外露**（载体形态属于实现口径，宿主不该依赖它）。
export { foldMessageRows } from "./store/message-rows.js";
export { projectTranscriptForDisplay } from "./display/projection.js";
export { appendUserTurn } from "./store/append-user-turn.js";
export {
  createAssemblyPort,
  assemblyPortOptions,
} from "./assembly.js";
export {
  NotesStoreError,
  assertNotesStore,
  createFileNotesStore,
  isNoteRecord,
} from "./store/notes.js";
export { createMemoryNotesStore } from "./store/notes-memory.js";
export {
  createBuiltinNotesTools,
  MAX_CONTENT_LENGTH,
  NOTE_VALUE_MAX_CHARS,
  resolveNotesDir,
} from "./tools/notes.js";
export {
  createDeterministicRunState,
  renderRunState,
  upsertRunStateInMessages,
  appendRunStateToRequestView,
  withSemanticRunState,
  RUN_STATE_MAX_CHARS,
} from "./run-state.js";
export {
  createStaticModelConfigProvider,
  createModelConfigResolver,
} from "./config/static.js";
export { createEnvModelConfigProvider } from "./config/env.js";
export { createJsonFileModelConfigProvider } from "./config/json-file.js";
export { resolveApiKey } from "./config/api-key.js";
// 槽位 → provider 的构造件（issue #406 B2-a 的 C-a）：宿主拿 L2 兜底得先有 provider，
// 而「读 slots.default → 校验必填 → 摊平给 createOpenAIProvider」在此之前每个宿主各写一份。
export { loadModelSlot, createProviderForSlot } from "./config/slot-provider.js";
export { createFoldLlmStrategy, SUMMARIZER_PROMPT_GUIDE } from "./compact/fold-llm.js";
export {
  BUILTIN_COMPACTION_STRATEGIES,
  BUILTIN_COMPACTION_STRATEGY_NAMES,
  isBuiltinCompactionStrategyName,
  resolveCompactionStrategy,
} from "./compact/strategy-resolution.js";
export { createProviderSummarizer, serializeFoldedMessages } from "./compact/provider-summarizer.js";
export { createAgent, runToolLoop } from "./loop/orchestrator.js";
// issue #571：逐叶「初始化 / 每次调用」的绑定事实（`"init"` / `"call"`）。它是**机器可读**的
// 公开事实，唯一来源在 `src/loop/config-namespace.js`（与 `CONFIG_NAMESPACE_SCHEMA` 同处、由自检
// 对账）；导出来是因为宿主得能算「这个键该写在哪」，而不是去读散文。
export { CONFIG_LEAF_BINDING } from "./loop/config-namespace.js";
export { parseReflectionDecision } from "./loop/reflection.js";
export { parseModelJson } from "./text/parse-model-json.js";
// 模型输出归一化底座（issue #406 B2-a）：**异步**、L1 保字节修复 + 闸门 + L2 兜底。
// 与上面那条同步 L0 入口是**两个函数**（设计稿 §10 的分工），不许合并、不许改名：
// `parseModelJson` 是 #307 钉死的同步 L0 面，`normalizeModelJson` 是带兜底的异步入口。
export { normalizeModelJson } from "./normalization/parse-model-json.js";
export { tryParseWrapupJson, normalizeWrapupWithLlm } from "./reflection/wrapup.js";
export {
  buildTimeline,
  buildJudgePrompt,
  parseJudgeDecision,
} from "./reflection/judge.js";
export {
  decide,
  decideRoundAction,
  decideWithEvaluation,
  isStuckOnRepeatedError,
  shouldWrapUp,
} from "./reflection/governor.js";
export {
  extractL0Fact,
  extractL0,
  extractL0Facts,
  parseL1Summary,
  parseReflectionSummary,
  parseSummary,
} from "./reflection/l0.js";
export { DEFAULT_REFLECTION_MIN_ROUNDS } from "./loop/reflection.js";
