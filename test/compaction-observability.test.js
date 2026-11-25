import test from "node:test";
import assert from "node:assert/strict";

import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { runDirect } from "./helpers/run-direct.js";
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

test("compactionStats exposes selected layer details through result, run-state, round record, and events", async () => {
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
  // issue #873 MIN_KEEP_ROUNDS=5 夹具重调（契约断言逐字不动）：有效保留下限 5 ⇒ `keepFloor = len - 5`。
  // 旧夹具只有 head + ≤3 轮（maxRounds 3）⇒ `keepFloor=0` ⇒ fold-statistical 一轮都折不动
  // ⇒ `layers.foldStatistical.triggered` 永远 0 ⇒ `find(...)` 落空。改为用 `config.input.messages`
  // 预置 head + 8 轮纯文本历史（无 tool_use），round 1 就有多轮可折；预算仍取极小的 30
  // ⇒ `shouldCompact`（估算 > 30）真 ⇒ 跑配置的 fold-statistical（非兵底）⇒ `keepFloor≥3` 真折一轮。
  const initialMessages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  for (let i = 0; i < 8; i += 1) {
    const role = i % 2 === 0 ? "assistant" : "user";
    initialMessages.push({ role, content: [{ type: "text", text: `seed-round-${i} ${"w".repeat(200)}` }] });
  }
  const result = await runDirect({
    provider,
    executeTool: async ({ id }) => `result for ${id} ${"x".repeat(200)}`,
    maxRounds: 3,
    completion: false,
    // #498 S3: `context` split by value shape — data at `config.folding.context`, the strategy
    // **object** at `capabilities.ports.strategy` (the config namespace holds data only).
    config: {
      input: { messages: initialMessages },
      folding: { context: {
        budgetTokens: 30,
        keepRounds: 0,
      } },
    },
    capabilities: {
      ports: { strategy: createFoldStatisticalStrategy() },
      hooks: { onEvent: (event) => events.push(event) },
    },
    store,
    runId: "compaction-observability",
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
  // issue #770：run snapshot 那一格的 `compactionStats` 已停写 ⇒ 这一面换成**权威来源**：
  // 落盘的 run-state（`<runId>.state.json`）里那份 `deterministic.compactionStats`，
  // 恢复侧读的就是它（`src/loop/resume-manager.js` 的 `ctx.compactionStats = deterministic.compactionStats`）。
  const persistedState = await store.loadRunState("compaction-observability");
  assert.ok(persistedState?.deterministic?.compactionStats?.some((entry) => (
    entry.layers.foldStatistical.triggered > 0
  )), "落盘 run-state 的 deterministic.compactionStats 必须带着层详情（恢复侧的权威出口）");
});
