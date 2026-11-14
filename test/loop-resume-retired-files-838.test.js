// @ts-check
// #838 裁决：不删 `.state.json`，其中 `guardExtension.used`、`compactionStats`、`termination`、
// `semantic` 是四个不可推事实，不迁移；删掉会重置守门扩展预算等状态。本组只删纯投影 `.status.json`。

import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileTranscriptStore, safeRunId } from "../src/store/file.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import { runDirect } from "./helpers/run-direct.js";

const FAKE_MESSAGE = "STALE_SNAPSHOT_MESSAGE_838";
const FAKE_TOOL_USE_ID = "snapshot-only-tool-838";
const FAKE_TOOL_RESULT = "STALE_SNAPSHOT_TOOL_RESULT_838";

async function seedRun(dir, runId) {
  const store = createFileTranscriptStore({ dir });
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "ledger answer" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    seed: "ledger task",
    config: { run: { runId, completion: false } },
    store,
    executeTool: async () => "unused",
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(provider.requests.length, 1);
}

async function resumeRun(store, runId) {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "resumed answer" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    seed: "resume task",
    config: { run: { resume: true, runId, completion: false } },
    store,
    executeTool: async () => "unused",
  });
  return { provider, result };
}

function foldedMessages(records) {
  return records.flatMap((record) => record.messages ?? []);
}

test("#838：陈旧 snapshot 文件与 loader 都不影响恢复上下文", async () => {
  const root = await makeTmp("erix-resume-snapshot-838-");
  const runId = "stale-snapshot-838";
  const cleanDir = join(root, "clean");
  const staleDir = join(root, "stale");
  await mkdir(cleanDir, { recursive: true });
  await seedRun(cleanDir, runId);
  await cp(cleanDir, staleDir, { recursive: true });

  const cleanStore = createFileTranscriptStore({ dir: cleanDir });
  const staleStore = createFileTranscriptStore({ dir: staleDir });
  const fakeSnapshot = {
    runId,
    messages: [{
      role: "user",
      content: [{ type: "text", text: FAKE_MESSAGE }],
    }],
    toolResults: [{
      toolUseId: FAKE_TOOL_USE_ID,
      result: { type: "tool_result", tool_use_id: FAKE_TOOL_USE_ID, content: FAKE_TOOL_RESULT },
    }],
  };
  await writeFile(
    join(staleDir, `${safeRunId(runId)}.snapshot.json`),
    `${JSON.stringify(fakeSnapshot)}\n`,
    "utf8",
  );
  let snapshotLoadCalls = 0;
  Object.defineProperty(staleStore, "loadLatestRunSnapshot", {
    configurable: true,
    value: async (requestedRunId) => {
      snapshotLoadCalls += 1;
      assert.equal(requestedRunId, runId);
      return structuredClone(fakeSnapshot);
    },
  });

  const clean = await resumeRun(cleanStore, runId);
  const stale = await resumeRun(staleStore, runId);
  assert.equal(clean.result.termination.reason, "end_turn");
  assert.equal(stale.result.termination.reason, "end_turn");
  assert.equal(stale.provider.requests.length, 1);
  assert.deepEqual(stale.provider.requests[0].messages, clean.provider.requests[0].messages);
  const requestText = JSON.stringify(stale.provider.requests[0].messages);
  assert.equal(requestText.includes(FAKE_MESSAGE), false);
  assert.equal(requestText.includes(FAKE_TOOL_USE_ID), false);
  assert.equal(requestText.includes(FAKE_TOOL_RESULT), false);
  assert.equal(snapshotLoadCalls, 0, "恢复不得请求已退役的快照读口");
});

test("#838：删除 <runId>.status.json 不改变账本或恢复请求上下文", async () => {
  const root = await makeTmp("erix-resume-status-838-");
  const runId = "status-projection-838";
  const seedDir = join(root, "seed");
  const controlDir = join(root, "control");
  const removedDir = join(root, "removed");
  await mkdir(seedDir, { recursive: true });
  await seedRun(seedDir, runId);
  await cp(seedDir, controlDir, { recursive: true });
  await cp(seedDir, removedDir, { recursive: true });

  const statusPath = join(removedDir, `${safeRunId(runId)}.status.json`);
  const statePath = join(removedDir, `${safeRunId(runId)}.state.json`);
  await readFile(statusPath, "utf8");
  const stateBefore = await readFile(statePath, "utf8");
  await rm(statusPath);
  await assert.rejects(readFile(statusPath), { code: "ENOENT" });
  assert.equal(await readFile(statePath, "utf8"), stateBefore);

  const controlStore = createFileTranscriptStore({ dir: controlDir });
  const removedStore = createFileTranscriptStore({ dir: removedDir });
  const controlLoaded = foldedMessages(await controlStore.load(runId));
  const removedLoaded = foldedMessages(await removedStore.load(runId));
  assert.deepEqual(removedLoaded, controlLoaded);

  const control = await resumeRun(controlStore, runId);
  const removed = await resumeRun(removedStore, runId);
  assert.equal(control.result.termination.reason, "end_turn");
  assert.equal(removed.result.termination.reason, "end_turn");
  assert.equal(Object.hasOwn(removed.result, "errorCode"), false);
  assert.equal(Object.hasOwn(removed.result.termination, "errorCode"), false);
  assert.deepEqual(removed.provider.requests[0].messages, control.provider.requests[0].messages);
});
