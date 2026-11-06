import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { transcriptStoreContract } from "../contract/transcript-store.js";

// memory store：通用行为全部由契约套件覆盖，无实现特有行为需补充
// 内置 memory store 全量实现除快路径探针外的全部可选能力（issue #739：声明出来，
// 于是「把某个可选实现删了」会在这套件的收尾核对里红，而不是被守卫静默跳过）。
transcriptStoreContract("memory", () => createMemoryTranscriptStore(), {
  optionalCapabilities: ["runSnapshot", "runState", "runStateStatus", "rawRows"],
});

// ---- issue #78：deprecated 别名委托 ----

test("memory: deprecated 别名 saveCheckpoint/appendCheckpoint/loadLatestCheckpoint 委托新方法", async () => {
  const store = createMemoryTranscriptStore();
  await store.saveCheckpoint("run-1", { round: 1, status: "pending" });
  await store.appendCheckpoint("run-1", { round: 2, status: "executed" });

  assert.deepEqual(await store.loadLatestCheckpoint("run-1"), { round: 2, status: "executed" });
  assert.deepEqual(await store.loadLatestRunSnapshot("run-1"), { round: 2, status: "executed" });
});
