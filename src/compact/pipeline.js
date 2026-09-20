const layer = (definition) => Object.freeze({
  ...definition,
  strategyNames: Object.freeze([...(definition.strategyNames ?? [])]),
});

/**
 * The canonical compaction pipeline declaration.
 *
 * The registry order is the product mental model. Runtime branches can apply
 * slidingWindow as either the selected strategy or the post-strategy fallback.
 */
export const COMPACTION_PIPELINE = Object.freeze([
  layer({
    id: "ttl",
    order: 1,
    phase: "request",
    granularity: "single-result",
    trigger: "provider attempt with an eligible aged and large tool_result; triggered counts folded results, not warning-only views",
    output: "request-only TTL handle with digest/retrieval hint",
    strategyNames: [],
    shouldSchedule: ({ budgetRounds, effectiveMaxRounds, lowBudgetPrompted } = {}) => {
      const remaining = Number(effectiveMaxRounds) - Number(budgetRounds);
      return Number.isFinite(remaining)
        && Number(budgetRounds) < Number(effectiveMaxRounds)
        && remaining > 2
        && lowBudgetPrompted !== true;
    },
  }),
  layer({
    id: "slidingWindow",
    order: 2,
    phase: "budget",
    granularity: "whole-round",
    trigger: "budget overflow without a selected strategy, or overflow after the selected strategy",
    output: "retained head/recent rounds plus foldedPayload and optional navigationRecord",
    strategyNames: ["sliding-window"],
    fallback: true,
  }),
  layer({
    id: "foldStatistical",
    order: 3,
    phase: "budget",
    granularity: "whole-round",
    trigger: "configured fold-statistical strategy requests compaction",
    output: "deterministic fold summary, tool footprint, stubs, navigationRecord, and foldedPayload",
    strategyNames: ["fold-statistical"],
  }),
  layer({
    id: "foldLlm",
    order: 4,
    phase: "budget",
    granularity: "whole-round",
    trigger: "configured fold-llm strategy requests compaction",
    output: "LLM summary bounded by enforce-size, fidelity block, and foldedPayload",
    strategyNames: ["fold-llm"],
  }),
  layer({
    id: "anchors",
    order: 5,
    phase: "fidelity",
    granularity: "folded-source-fragments",
    trigger: "a fold emits an anchors or fold-fidelity section",
    output: "bounded mechanical anchor index and optional verbatim user-input fidelity block",
    strategyNames: ["fold-statistical", "fold-llm"],
  }),
  layer({
    id: "enforceSize",
    order: 6,
    phase: "safety",
    granularity: "fields-and-messages",
    trigger: "fold-llm summary sizing or final context still exceeds the budget",
    output: "deterministic field pruning and final message safety truncation",
    strategyNames: [],
    fallback: true,
  }),
]);

export const COMPACTION_LAYER_IDS = Object.freeze(
  COMPACTION_PIPELINE.map(({ id }) => id),
);

const LAYERS_BY_ID = new Map(
  COMPACTION_PIPELINE.map((definition) => [definition.id, definition]),
);
const LAYERS_BY_STRATEGY = new Map(
  COMPACTION_PIPELINE
    .filter((definition) => definition.phase === "budget")
    .flatMap((definition) => (
      definition.strategyNames.map((name) => [name, definition])
    )),
);
const COMPACTION_FALLBACK_CHAIN = Object.freeze(
  COMPACTION_PIPELINE
    .filter((definition) => definition.fallback === true)
    .sort((left, right) => left.order - right.order),
);

export function getCompactionLayer(id) {
  return LAYERS_BY_ID.get(id);
}

export function getCompactionLayerForStrategy(strategy) {
  return LAYERS_BY_STRATEGY.get(strategy?.name);
}

export function getCompactionFallbackLayer(phase) {
  return COMPACTION_FALLBACK_CHAIN.find((definition) => definition.phase === phase);
}

export function getCompactionFallbackChain() {
  return COMPACTION_FALLBACK_CHAIN;
}

export function createEmptyCompactionLayers() {
  return Object.fromEntries(COMPACTION_LAYER_IDS.map((id) => [
    id,
    { triggered: 0, tokensSaved: 0 },
  ]));
}

export function observeCompactionLayer(
  layers,
  id,
  { triggered = 1, tokensBefore = 0, tokensAfter = 0 } = {},
) {
  const target = layers?.[id];
  if (!target) return layers;
  const count = Number.isSafeInteger(triggered) && triggered > 0 ? triggered : 0;
  const before = Number.isFinite(tokensBefore) ? tokensBefore : 0;
  const after = Number.isFinite(tokensAfter) ? tokensAfter : before;
  target.triggered += count;
  target.tokensSaved += Math.max(0, Math.floor(before - after));
  return layers;
}

export function createCompactionStat({
  compacted = false,
  foldedRounds = 0,
  tokensBefore = 0,
  tokensAfter = tokensBefore,
  protectedDowngraded = 0,
  layers,
} = {}) {
  const stat = {
    compacted: compacted === true,
    foldedRounds: Number.isSafeInteger(foldedRounds) && foldedRounds >= 0
      ? foldedRounds
      : 0,
    tokensBefore: Number.isFinite(tokensBefore) ? tokensBefore : 0,
    tokensAfter: Number.isFinite(tokensAfter) ? tokensAfter : tokensBefore,
    layers: {
      ...createEmptyCompactionLayers(),
      ...(layers ?? {}),
    },
  };
  if (Number.isSafeInteger(protectedDowngraded) && protectedDowngraded > 0) {
    stat.protectedDowngraded = protectedDowngraded;
  }
  return stat;
}

export function normalizeCompactionStats(value, limit = 32) {
  const entries = Array.isArray(value) ? value.slice(-limit) : [];
  return entries.map((entry) => createCompactionStat({
    compacted: entry?.compacted,
    foldedRounds: entry?.foldedRounds,
    tokensBefore: entry?.tokensBefore,
    tokensAfter: entry?.tokensAfter,
    protectedDowngraded: entry?.protectedDowngraded,
    layers: Object.fromEntries(COMPACTION_LAYER_IDS.map((id) => {
      const layerStats = entry?.layers?.[id];
      return [id, {
        triggered: Number.isSafeInteger(layerStats?.triggered) && layerStats.triggered >= 0
          ? layerStats.triggered
          : 0,
        tokensSaved: Number.isFinite(layerStats?.tokensSaved) && layerStats.tokensSaved >= 0
          ? Math.floor(layerStats.tokensSaved)
          : 0,
      }];
    })),
  }));
}
