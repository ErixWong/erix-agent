import test from "node:test";
import assert from "node:assert/strict";

import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { estimateMessageTokens } from "../../src/tokens.js";
import { multiRoundMixedConversation } from "../fixtures/rounds-fixtures.mjs";

test("compacts whole old rounds and preserves the head and recent rounds", async () => {
  const strategy = createSlidingWindowStrategy();
  const input = structuredClone(multiRoundMixedConversation);
  const result = await strategy.compact(input, { keepRounds: 2, budgetTokens: 0 });

  assert.equal(strategy.name, "sliding-window");
  assert.deepEqual(result.messages, [
    input[0],
    ...input.slice(3),
  ]);
  assert.deepEqual(result.foldedPayload, input.slice(1, 3));
  assert.equal(result.compacted, true);
  assert.equal(result.foldedRounds, 2);
  assert.equal(result.tokensBefore, estimateMessageTokens(input));
  assert.equal(result.tokensAfter, estimateMessageTokens(result.messages));
  assert.deepEqual(input, multiRoundMixedConversation);
});

test("uses the token estimate as the compaction predicate", () => {
  const strategy = createSlidingWindowStrategy();
  const messages = [{ role: "user", content: "hello" }];
  const tokens = estimateMessageTokens(messages);

  assert.equal(strategy.shouldCompact(messages, tokens), false);
  assert.equal(strategy.shouldCompact(messages, tokens - 1), true);
});

test("does not report compaction when all rounds are retained", async () => {
  const strategy = createSlidingWindowStrategy();
  const messages = [{ role: "user", content: "hello" }];
  const result = await strategy.compact(messages, { keepRounds: 3, budgetTokens: 0 });

  assert.equal(result.compacted, false);
  assert.equal(result.foldedRounds, 0);
  assert.deepEqual(result.foldedPayload, []);
  assert.deepEqual(result.messages, messages);
});
