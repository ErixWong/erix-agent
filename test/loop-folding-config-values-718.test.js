// @ts-check
// issue #718: folding numeric leaves must reject invalid values at intake without narrowing valid 0.

import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";

/**
 * @typedef {{
 *   path: string,
 *   config: (value: unknown) => object,
 *   invalid: Array<[unknown, string]>,
 * }} Rule
 */

/** @type {Rule[]} */
const RULES = [
  {
    path: "config.folding.toolResultTtl",
    config: (value) => ({ folding: { toolResultTtl: value } }),
    invalid: [
      ["6", "string"],
      [-1, "number"],
      [0.5, "number"],
      [true, "boolean"],
      [null, "null"],
      [[], "array"],
      [{}, "object"],
    ],
  },
  {
    path: "config.folding.toolResultFoldMinTokens",
    config: (value) => ({ folding: { toolResultFoldMinTokens: value } }),
    invalid: [
      ["8000", "string"],
      [-1, "number"],
      [0.5, "number"],
      [true, "boolean"],
      [null, "null"],
      [[], "array"],
      [{}, "object"],
    ],
  },
  {
    path: "config.folding.context.keepRounds",
    config: (value) => ({
      folding: { context: { keepRounds: value, session: { hostData: "unchanged" } } },
    }),
    invalid: [
      [-1, "number"],
      ["-1", "string"],
      [0.5, "number"],
      [true, "boolean"],
      [null, "null"],
      [[], "array"],
      [{}, "object"],
    ],
  },
];

/**
 * @param {Rule} rule
 * @param {unknown} value
 * @param {{count: number}} requests
 */
function optionsFor(rule, value, requests) {
  return {
    provider: {
      protocol: "fake",
      model: "fake-model",
      async chat() {
        requests.count += 1;
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    },
    executeTool: async () => "unused",
    config: {
      input: { initialUserMessage: "go", wrapup: false },
      run: { completion: false },
      ...rule.config(value),
    },
  };
}

for (const rule of RULES) {
  test(`${rule.path}: invalid values throw at startup and name the full path`, async () => {
    for (const [value, receivedType] of rule.invalid) {
      const requests = { count: 0 };
      let caught;
      try {
        await runToolLoop(optionsFor(rule, value, requests));
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof TypeError, `${JSON.stringify(value)} must throw TypeError`);
      assert.equal(
        caught.message,
        `${rule.path} must be a non-negative integer (received: ${receivedType})`,
      );
      assert.equal(requests.count, 0, "invalid config must be refused before the first provider call");
    }
  });

  test(`${rule.path}: 0 remains valid`, async () => {
    const requests = { count: 0 };
    const result = await runToolLoop(optionsFor(rule, 0, requests));
    assert.equal(result.termination.reason, "end_turn");
    assert.equal(requests.count, 1, "valid boundary config must reach the provider");
  });
}
