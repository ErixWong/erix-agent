// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { buildFinalGuardPayload } from "../src/loop/termination.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

function payloadFor(toolStats, fileWrites) {
  return buildFinalGuardPayload({
    finalText: "",
    declaredFindings: undefined,
    messages: [],
    rounds: 0,
    toolSignal: undefined,
    toolStats,
    fileWrites,
  }, "end_turn", undefined, 1);
}

test("#711 a: exec calls with an empty fileWrites ledger set fileWritesBlind", () => {
  const payload = payloadFor(new Map([["exec", { calls: 1, failures: 0 }]]), []);
  assert.equal(payload.fileWritesBlind, true);
});

test("#711 b: a write-tool ledger entry suppresses fileWritesBlind, even after exec", () => {
  const payload = payloadFor(
    new Map([
      ["exec", { calls: 1, failures: 0 }],
      ["writeFile", { calls: 1, failures: 0 }],
    ]),
    [{ path: "answer.txt", round: 1, tool: "writeFile" }],
  );
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "fileWritesBlind"), false);
});

test("#711 c: a pure-read run omits fileWritesBlind", () => {
  const payload = payloadFor(new Map([["readFile", { calls: 1, failures: 0 }]]), []);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "fileWritesBlind"), false);
});

test("#711 d: resume rebuilds an exec count from ledger tool_use blocks when run-state is absent", async () => {
  const runId = "filewrites-blind-resume-ledger";
  const store = createMemoryTranscriptStore();
  await store.appendRound(runId, {
    round: 1,
    roundKey: `${runId}:round:1`,
    dedupKey: `${runId}:round:1`,
    messages: [
      { role: "user", content: [{ type: "text", text: "run a command" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "exec-1",
          name: "exec",
          input: { command: "inspect" },
        }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "exec-1", content: "done" }],
      },
      { role: "assistant", content: [{ type: "text", text: "command complete" }] },
    ],
  });
  assert.equal(await store.loadRunState(runId), undefined, "the crash archive has no run-state to restore");

  let payload;
  await runToolLoop({
    provider: createFakeProvider([{
      content: [{ type: "text", text: "resumed final" }],
      stopReason: "end_turn",
    }]),
    store,
    tools: [],
    executeTool: async () => "unused",
    config: {
      input: { cacheStablePrefix: false, wrapup: false },
      run: { runId, resume: true, maxRounds: 1, completion: false, reflection: false },
    },
    capabilities: {
      hooks: {
        finalGuard: async (value) => {
          payload = value;
          return { action: "accept" };
        },
      },
    },
  });

  assert.equal(payload.fileWritesBlind, true, "ledger-backed exec history must prevent a silent blind spot");
  assert.equal(payload.toolStats.exec.calls, 1, "the recovered toolStats entry must retain the ledger count");
});
