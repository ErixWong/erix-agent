import test from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore } from "../../src/store/file.js";
import { makeTmp } from "../helpers/tmp.js";

const record = {
  round: 1,
  roundKey: "run:round:1",
  messages: [{ role: "assistant", content: "one" }],
};

test("memory store deduplicates rounds and stores run state", async () => {
  const store = createMemoryTranscriptStore();

  await store.appendRound("run", record);
  // issue #326 事实①收紧：同 key 只允许**同 payload** 幂等重放（字段顺序无关），
  // 异 payload 不再是静默丢弃而是明确报错——本用例原先拿「同 key 换正文」当幂等样本，
  // 钉的正是被修掉的那个 bug。
  await store.appendRound("run", {
    messages: record.messages,
    roundKey: record.roundKey,
    round: record.round,
  });
  await assert.rejects(
    store.appendRound("run", { ...record, messages: [{ role: "assistant", content: "duplicate" }] }),
    (error) => error.code === "dedup_payload_conflict" && error.key === "run:round:1",
    "同 key 异 payload 必须报冲突，不得静默接受",
  );
  await store.markRunState("run", "running");

  assert.equal((await store.load("run")).length, 1);
  assert.deepEqual((await store.load("run"))[0], record, "冲突那次的 payload 不得落盘");
  assert.equal(await store.loadRunStateStatus("run"), "running");
});

test("file store deduplicates rounds and persists state with sanitized IDs", async () => {
  const root = await makeTmp("erix-llm-kit-rc-store-");
  try {
    const store = createFileTranscriptStore({ dir: root });
    const runId = "../unsafe run";
    await store.appendRound(runId, record);
    await store.appendRound(runId, record);
    await store.markRunState(runId, "failed");

    assert.equal((await store.load(runId)).length, 1);
    assert.equal(await store.loadRunStateStatus(runId), "failed");
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".jsonl")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
