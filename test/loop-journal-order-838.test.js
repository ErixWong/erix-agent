// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { RECOVERY_EVENT_TOOL_EXECUTED } from "../src/store/recovery-rows.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

/** Record result-bearing ledger rows and executed recovery rows in their write order. */
function createOrderRecordingStore() {
  const inner = createMemoryTranscriptStore();
  /** @type {Array<{kind: "ledger", toolUseIds: string[]} | {kind: "executed", toolUseId: string}>} */
  const ops = [];
  return {
    ...inner,
    ops,
    async appendRound(runId, record) {
      const toolUseIds = (record?.messages ?? [])
        .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
        .filter((block) => block?.type === "tool_result")
        .map((block) => block.tool_use_id)
        .filter((id) => typeof id === "string");
      if (toolUseIds.length > 0) ops.push({ kind: "ledger", toolUseIds });
      return inner.appendRound(runId, record);
    },
    async appendRecoveryRow(runId, record) {
      if (record?.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED
        && typeof record?.toolUseId === "string") {
        ops.push({ kind: "executed", toolUseId: record.toolUseId });
      }
      return inner.appendRecoveryRow(runId, record);
    },
  };
}

async function runToolBatch(ids, runId) {
  const store = createOrderRecordingStore();
  const provider = createFakeProvider([
    {
      content: ids.map((id) => ({ type: "tool_use", id, name: "work", input: {} })),
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    initialUserMessage: "run tools",
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    executeTool: async ({ id }) => `output-${String(id)}`,
    completion: false,
    maxRounds: 3,
    store,
    runId,
    config: { run: { completion: false } },
  });
  return store;
}

function assertResultsPrecedeExecutedRows(store, ids) {
  for (const id of ids) {
    const ledgerIndex = store.ops.findIndex(
      (op) => op.kind === "ledger" && op.toolUseIds.includes(id),
    );
    const recoveryIndex = store.ops.findIndex(
      (op) => op.kind === "executed" && op.toolUseId === id,
    );
    assert.ok(ledgerIndex >= 0, `${id} must have a result-bearing appendRound (ops: ${JSON.stringify(store.ops)})`);
    assert.ok(recoveryIndex >= 0, `${id} must have an executed recovery row (ops: ${JSON.stringify(store.ops)})`);
    assert.ok(
      ledgerIndex < recoveryIndex,
      `${id}: its tool_result ledger row must precede its executed recovery row (ops: ${JSON.stringify(store.ops)})`,
    );
  }
}

test("#838 写序：单个工具的结果账本行早于 executed 恢复行", async () => {
  const ids = ["t1"];
  const store = await runToolBatch(ids, "journal-order-838-single");
  assertResultsPrecedeExecutedRows(store, ids);
});

test("#838 写序：同批每个工具的结果账本行都早于各自的 executed 恢复行", async () => {
  const ids = ["t1", "t2"];
  const store = await runToolBatch(ids, "journal-order-838-batch");
  assertResultsPrecedeExecutedRows(store, ids);
});
