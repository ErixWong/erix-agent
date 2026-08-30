import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore } from "../../src/store/file.js";

const record = {
  round: 1,
  roundKey: "run:round:1",
  messages: [{ role: "assistant", content: "one" }],
};

test("memory store deduplicates rounds and stores run state/checkpoints", async () => {
  const store = createMemoryTranscriptStore();

  await store.appendRound("run", record);
  await store.appendRound("run", { ...record, messages: [{ role: "assistant", content: "duplicate" }] });
  await store.markRunState("run", "running");
  await store.saveCheckpoint("run", { round: 2, executedToolIds: ["tool-1"] });

  assert.equal((await store.load("run")).length, 1);
  assert.equal((await store.loadRunState("run")).state, "running");
  assert.deepEqual(await store.loadLatestCheckpoint("run"), {
    round: 2,
    executedToolIds: ["tool-1"],
  });
});

test("file store deduplicates rounds and persists checkpoint/state with sanitized IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "erix-llm-kit-rc-store-"));
  try {
    const store = createFileTranscriptStore({ dir: root });
    const runId = "../unsafe run";
    await store.appendRound(runId, record);
    await store.appendRound(runId, record);
    await store.markRunState(runId, "failed");
    await store.saveCheckpoint(runId, { round: 3, pendingToolUse: { id: "tool-3" } });

    assert.equal((await store.load(runId)).length, 1);
    assert.equal((await store.loadRunState(runId)).state, "failed");
    assert.deepEqual(await store.loadLatestCheckpoint(runId), {
      round: 3,
      pendingToolUse: { id: "tool-3" },
    });
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".jsonl")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
