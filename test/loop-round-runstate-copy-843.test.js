// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createFileTranscriptStore,
  transcriptPath,
} from "../src/store/file.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import {
  createDeterministicRunState,
  renderRunState,
  RUN_STATE_MAX_SERIALIZED_BYTES,
} from "../src/run-state.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const RUN_ID = "runstate-copy-843";
const RESUME_RUN_ID = "runstate-copy-843-resume";
const ENGINE_ROUND_KEY = /:engine:round:\d+$/u;
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function withoutRunStateMethods(store) {
  const {
    saveRunState: _saveRunState,
    loadRunState: _loadRunState,
    ...recordStore
  } = store;
  return recordStore;
}

function runStateToolResponses() {
  return [
    ...Array.from({ length: 44 }, (_unused, index) => ({
      content: [{
        type: "tool_use",
        id: `tool-${String(index + 1)}`,
        name: "work",
        input: { step: index + 1 },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
}

async function writeFortyFiveRoundRun(store) {
  const result = await runToolLoop({
    provider: createFakeProvider(runStateToolResponses()),
    store,
    config: {
      input: { initialUserMessage: "work", wrapup: false },
      run: { runId: RUN_ID, maxRounds: 45, completion: false, reflection: { enabled: false } },
    },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    executeTool: async () => ({ success: true, data: "ok" }),
  });
  const rows = await store.loadRawRows(RUN_ID);
  const rounds = rows.filter((row) => ENGINE_ROUND_KEY.test(String(row?.dedupKey ?? "")));
  return { result, rows, rounds };
}

function createLegacyResumeState() {
  const state = createDeterministicRunState({
    runId: RESUME_RUN_ID,
    stateVersion: 5,
    rounds: 7,
    runRounds: 3,
    maxRounds: 10,
    toolStats: new Map([["legacy-tool", { calls: 4, failures: 1 }]]),
    compactionStats: [{
      compacted: true,
      foldedRounds: 2,
      tokensBefore: 100,
      tokensAfter: 60,
      strategyName: "fold-statistical",
      layers: { foldStatistical: { triggered: 1, tokensSaved: 40 } },
    }],
    guardExtensionUsed: true,
  });
  state.semantic = { status: "ok", text: "baseline semantic", semanticStateVersion: 5 };
  state.rendered = renderRunState(state);
  return state;
}

async function seedResumeRecord(store, state) {
  await store.appendRound(RESUME_RUN_ID, {
    round: 7,
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    runState: state,
  });
}

async function resumeRun(store) {
  return runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    config: {
      run: { resume: true, runId: RESUME_RUN_ID, maxRounds: 1, completion: false },
    },
    store,
    executeTool: async () => "unused",
  });
}

test("#843 a: saveRunState store omits each round copy and materially shrinks the 45-round ledger", async () => {
  const beforeDir = await makeTmp("erix-843-before-");
  const afterDir = await makeTmp("erix-843-after-");
  const beforeStore = withoutRunStateMethods(createFileTranscriptStore({ dir: beforeDir }));
  const afterStore = createFileTranscriptStore({ dir: afterDir });
  const beforeRun = await writeFortyFiveRoundRun(beforeStore);
  const afterRun = await writeFortyFiveRoundRun(afterStore);
  const beforeBytes = (await readFile(transcriptPath(beforeDir, RUN_ID))).byteLength;
  const afterBytes = (await readFile(transcriptPath(afterDir, RUN_ID))).byteLength;
  const reductionPercent = ((beforeBytes - afterBytes) / beforeBytes * 100).toFixed(1);

  console.log(
    `RUNSTATE-COPY-BYTES before=${String(beforeBytes)} after=${String(afterBytes)}`
      + ` reduction=${reductionPercent}% rounds=${String(afterRun.rounds.length)}`,
  );
  assert.equal(beforeRun.result.rounds, 45);
  assert.equal(afterRun.result.rounds, 45);
  assert.equal(beforeRun.rounds.length, 45);
  assert.equal(afterRun.rounds.length, 45);
  assert.ok(afterBytes <= Math.floor(beforeBytes * 0.85),
    `a: expected at least 15% fewer transcript bytes; before=${String(beforeBytes)} after=${String(afterBytes)}`);
  assert.ok(beforeRun.rounds.every((record) => Object.hasOwn(record, "runState")));
  assert.ok(afterRun.rounds.every((record) => !Object.hasOwn(record, "runState")));
  assert.ok(afterRun.rounds.every((record) => Object.hasOwn(record, "runStateMeta")));
  const stateFile = await readFile(join(afterDir, `${RUN_ID}.state.json`), "utf8");
  assert.equal(typeof JSON.parse(stateFile).stateVersion, "number");
});

test("#843 b: store without saveRunState retains the legacy copy and exact pre-change resume state", async () => {
  const store = withoutRunStateMethods(createMemoryTranscriptStore());
  const state = createLegacyResumeState();
  await seedResumeRecord(store, state);
  const beforeResume = await store.load(RESUME_RUN_ID);
  assert.equal(JSON.stringify(beforeResume[0].runState), JSON.stringify(state));
  assert.equal(typeof store.loadRunState, "undefined");
  assert.equal(typeof store.saveRunState, "undefined");

  const result = await resumeRun(store);
  const json = JSON.stringify(result.runState);
  const digest = createHash("sha256").update(json).digest("hex");
  const resumedRows = await store.loadRawRows(RESUME_RUN_ID);
  const latestRound = resumedRows
    .filter((record) => Number.isInteger(record?.round))
    .at(-1);
  console.log(`RUNSTATE-FALLBACK-RESUME bytes=${String(Buffer.byteLength(json))} sha256=${digest}`);
  // Captured from main b4bde305 with this same record and provider response before #843.
  assert.equal(Buffer.byteLength(json), 1501);
  assert.equal(digest, "00edf56f1b42232dc2dec785ae453117a1ff80eff442fcba05597da7f867a65d");
  assert.ok(Object.hasOwn(latestRound ?? {}, "runState"),
    "b: a resumed round on the fallback store still records the recovery state");
});

test("#843 c: independent-state and record-fallback resumes preserve the same four run-state cells", async () => {
  const state = createLegacyResumeState();
  const stateStore = createMemoryTranscriptStore();
  const recordStore = withoutRunStateMethods(createMemoryTranscriptStore());
  await stateStore.saveRunState(RESUME_RUN_ID, state);
  await seedResumeRecord(stateStore, state);
  await seedResumeRecord(recordStore, state);

  const fromIndependent = await resumeRun(stateStore);
  const fromRecord = await resumeRun(recordStore);
  const independentCells = {
    guardExtensionUsed: fromIndependent.runState.deterministic.guardExtension?.used,
    compactionStats: fromIndependent.runState.deterministic.compactionStats,
    termination: fromIndependent.runState.deterministic.termination,
    semantic: fromIndependent.runState.semantic,
  };
  const recordCells = {
    guardExtensionUsed: fromRecord.runState.deterministic.guardExtension?.used,
    compactionStats: fromRecord.runState.deterministic.compactionStats,
    termination: fromRecord.runState.deterministic.termination,
    semantic: fromRecord.runState.semantic,
  };

  assert.equal(independentCells.guardExtensionUsed, true);
  assert.equal(independentCells.compactionStats.length, 1);
  assert.equal(independentCells.termination.reason, "end_turn");
  assert.equal(independentCells.semantic.text, "baseline semantic");
  for (const key of Object.keys(independentCells)) {
    assert.equal(JSON.stringify(independentCells[key]), JSON.stringify(recordCells[key]), key);
  }
});

test("#843 d: runStateMeta measures the refreshed snapshot even when the record omits runState", async () => {
  const store = createMemoryTranscriptStore();
  const saveRunState = store.saveRunState.bind(store);
  const appendRound = store.appendRound.bind(store);
  /** @type {object|undefined} */
  let latestSnapshot;
  /** @type {Array<{record:object,snapshot:object|undefined}>} */
  const observed = [];
  store.saveRunState = async (runId, snapshot) => {
    if (runId === RUN_ID) latestSnapshot = structuredClone(snapshot);
    await saveRunState(runId, snapshot);
  };
  store.appendRound = async (runId, record) => {
    if (runId === RUN_ID && ENGINE_ROUND_KEY.test(String(record?.dedupKey ?? ""))) {
      observed.push({
        record: structuredClone(record),
        snapshot: latestSnapshot === undefined ? undefined : structuredClone(latestSnapshot),
      });
    }
    await appendRound(runId, record);
  };

  await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "meta-tool", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    store,
    config: {
      input: { initialUserMessage: "work", wrapup: false },
      run: { runId: RUN_ID, maxRounds: 2, completion: false, reflection: { enabled: false } },
    },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    executeTool: async () => ({ success: true, data: "ok" }),
  });

  assert.equal(observed.length, 2);
  for (const { record, snapshot } of observed) {
    assert.notEqual(snapshot, undefined);
    assert.equal(Object.hasOwn(record, "runState"), false);
    const meta = record.runStateMeta;
    const bytes = serializedBytes(snapshot);
    assert.equal(meta.bytes, bytes);
    assert.equal(meta.capBytes, RUN_STATE_MAX_SERIALIZED_BYTES);
    assert.equal(meta.truncated, snapshot.bounds?.truncated === true || bytes > meta.capBytes);
  }
});
