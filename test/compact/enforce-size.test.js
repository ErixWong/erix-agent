import test from "node:test";
import assert from "node:assert/strict";

import { enforceSize } from "../../src/compact/enforce-size.js";
import { estimateTokens } from "../../src/tokens.js";

test("prunes lowest-priority fields deterministically without mutating input", () => {
  const fields = [
    { key: "important", text: "keep this", priority: 0 },
    { key: "details", text: "d".repeat(100), priority: 10 },
    { key: "notes", text: "n".repeat(100), priority: 20 },
  ];
  const budget = estimateTokens("keep this[已修剪][已修剪]");
  const result = enforceSize(fields, budget);

  assert.deepEqual(result.fields, [
    fields[0],
    { ...fields[1], text: "[已修剪]" },
    { ...fields[2], text: "[已修剪]" },
  ]);
  assert.deepEqual(result.prunedKeys, ["notes", "details"]);
  assert.equal(result.tokensBefore, estimateTokens("keep this" + "d".repeat(100) + "n".repeat(100)));
  assert.equal(result.tokensAfter, budget);
  assert.deepEqual(fields, [
    { key: "important", text: "keep this", priority: 0 },
    { key: "details", text: "d".repeat(100), priority: 10 },
    { key: "notes", text: "n".repeat(100), priority: 20 },
  ]);
});

test("leaves already-fitting fields untouched", () => {
  const fields = [{ key: "only", text: "short", priority: 0 }];
  const result = enforceSize(fields, estimateTokens("short"));

  assert.deepEqual(result.fields, fields);
  assert.deepEqual(result.prunedKeys, []);
  assert.equal(result.tokensBefore, result.tokensAfter);
});
