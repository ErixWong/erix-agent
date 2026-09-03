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
  canonicalToAnthropicRequest,
  anthropicResponseToCanonical,
  createAnthropicStreamAssembler,
} from "./messages/anthropic.js";
export { groupIntoRounds, validateMessages } from "./messages/rounds.js";
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
export { enforceSize } from "./compact/enforce-size.js";
export { createMemoryTranscriptStore } from "./store/memory.js";
export { createFileTranscriptStore } from "./store/file.js";
export { createStaticModelConfigProvider } from "./config/static.js";
export { createEnvModelConfigProvider } from "./config/env.js";
export { createJsonFileModelConfigProvider } from "./config/json-file.js";
export { resolveApiKey } from "./config/api-key.js";
export { createFoldLlmStrategy, SUMMARIZER_PROMPT_GUIDE } from "./compact/fold-llm.js";
export { parseReflectionDecision, runToolLoop } from "./loop.js";
export { tryParseWrapupJson, normalizeWrapupWithLlm } from "./reflection/wrapup.js";
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
