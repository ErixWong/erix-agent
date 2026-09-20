import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPACTION_LAYER_IDS,
  COMPACTION_PIPELINE,
  getCompactionFallbackChain,
  getCompactionFallbackLayer,
  getCompactionLayer,
  getCompactionLayerForStrategy,
} from "../../src/compact/pipeline.js";

test("compaction registry declares the six layers in stable order", () => {
  assert.deepEqual(COMPACTION_LAYER_IDS, [
    "ttl",
    "slidingWindow",
    "foldStatistical",
    "foldLlm",
    "anchors",
    "enforceSize",
  ]);
  assert.deepEqual(
    COMPACTION_PIPELINE.map((definition) => definition.id),
    COMPACTION_LAYER_IDS,
  );
  for (const definition of COMPACTION_PIPELINE) {
    assert.equal(definition.order, COMPACTION_LAYER_IDS.indexOf(definition.id) + 1);
    assert.equal(typeof definition.trigger, "string");
    assert.notEqual(definition.trigger.length, 0);
    assert.equal(typeof definition.output, "string");
    assert.notEqual(definition.output.length, 0);
    assert.ok(["single-result", "whole-round", "folded-source-fragments", "fields-and-messages"]
      .includes(definition.granularity));
  }
});

test("registry keeps TTL scheduling and strategy selection rules", () => {
  const ttl = getCompactionLayer("ttl");
  assert.equal(ttl.shouldSchedule({
    budgetRounds: 1,
    effectiveMaxRounds: 4,
    lowBudgetPrompted: false,
  }), true);
  assert.equal(ttl.shouldSchedule({
    budgetRounds: 2,
    effectiveMaxRounds: 4,
    lowBudgetPrompted: false,
  }), false);
  assert.equal(ttl.shouldSchedule({
    budgetRounds: 1,
    effectiveMaxRounds: 4,
    lowBudgetPrompted: true,
  }), false);
  assert.equal(getCompactionLayerForStrategy({ name: "fold-statistical" }).id, "foldStatistical");
  assert.equal(getCompactionLayerForStrategy({ name: "fold-llm" }).id, "foldLlm");
  assert.equal(getCompactionLayerForStrategy({ name: "sliding-window" }).id, "slidingWindow");
  assert.equal(getCompactionLayerForStrategy({ name: "custom" }), undefined);
  assert.deepEqual(
    getCompactionFallbackChain().map((definition) => definition.id),
    ["slidingWindow", "enforceSize"],
  );
  assert.deepEqual(
    getCompactionFallbackChain().map((definition) => definition.phase),
    ["budget", "safety"],
  );
  assert.equal(getCompactionFallbackLayer("budget").id, "slidingWindow");
  assert.equal(getCompactionFallbackLayer("safety").id, "enforceSize");
});

test("TTL scheduling conservatively rejects NaN and undefined inputs", () => {
  const ttl = getCompactionLayer("ttl");
  for (const input of [
    { budgetRounds: NaN, effectiveMaxRounds: 4, lowBudgetPrompted: false },
    { budgetRounds: 1, effectiveMaxRounds: NaN, lowBudgetPrompted: false },
    { budgetRounds: undefined, effectiveMaxRounds: 4, lowBudgetPrompted: false },
    { budgetRounds: 1, effectiveMaxRounds: undefined, lowBudgetPrompted: false },
  ]) {
    assert.equal(ttl.shouldSchedule(input), false);
  }
});
