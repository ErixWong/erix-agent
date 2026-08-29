import test from "node:test";
import assert from "node:assert/strict";

import { computeBudget } from "../../src/compact/budget.js";

test("subtracts output and the larger safety reserve", () => {
  assert.equal(
    computeBudget({ contextWindowTokens: 100_000, maxOutputTokens: 8_192 }),
    100_000 - 8_192 - 10_000,
  );
  assert.equal(
    computeBudget({ contextWindowTokens: 10_000, maxOutputTokens: 1_000 }),
    10_000 - 1_000 - 2_000,
  );
});
