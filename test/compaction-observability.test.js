import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const layerIds = [
  "ttl",
  "slidingWindow",
  "foldStatistical",
  "foldLlm",
  "anchors",
  "enforceSize",
];

test("compactionStats exposes selected layer details through result, state, archive, checkpoint, and events", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "first", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "second", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  const events = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "start",
    executeTool: async ({ id }) => `result for ${id} ${"x".repeat(200)}`,
    maxRounds: 3,
    completion: false,
    context: {
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: 30,
      keepRounds: 0,
    },
    store,
    runId: "compaction-observability",
    onEvent: (event) => events.push(event),
  });

  const stat = result.compactionStats.find((entry) => (
    entry.layers.foldStatistical.triggered > 0
  ));
  assert.ok(stat);
  assert.deepEqual(Object.keys(stat.layers), layerIds);
  for (const id of layerIds) {
    assert.ok(Number.isSafeInteger(stat.layers[id].triggered));
    assert.ok(Number.isSafeInteger(stat.layers[id].tokensSaved));
    assert.ok(stat.layers[id].tokensSaved >= 0);
  }
  assert.deepEqual(
    result.runState.deterministic.compactionStats.at(-1),
    result.compactionStats.at(-1),
  );
  assert.ok(events.some((event) => (
    event.type === "compaction"
      && event.compaction.layers.foldStatistical.triggered > 0
  )));

  const records = await store.load("compaction-observability");
  assert.ok(records.some((record) => (
    record.compactionStats?.some((entry) => entry.layers.foldStatistical.triggered > 0)
  )));
  const checkpoint = await store.loadLatestCheckpoint("compaction-observability");
  assert.ok(checkpoint.compactionStats?.some((entry) => (
    entry.layers.foldStatistical.triggered > 0
  )));
});
