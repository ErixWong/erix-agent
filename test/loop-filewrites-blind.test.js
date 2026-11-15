// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import { buildFinalGuardPayload } from "../src/loop/termination.js";

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
