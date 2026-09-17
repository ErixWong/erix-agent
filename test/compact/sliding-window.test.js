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

test("keeps a folded result stub in the retained head", async () => {
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "capture", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "capture",
        content: "secret",
      }],
    },
    { role: "assistant", content: "old" },
    { role: "user", content: "keep" },
  ];
  const result = await createSlidingWindowStrategy().compact(messages, {
    keepRounds: 1,
    stubFor: () => "[已折叠] 本命令不可重放；值：nonce=abc123；原文：/tmp/001-exec.txt",
  });
  assert.match(JSON.stringify(result.messages), /nonce=abc123/u);
  assert.doesNotMatch(JSON.stringify(result.messages), /secret/u);
});

test("emits the same bounded navigation contract as statistical folding", async () => {
  const messages = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "archive", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "archive",
        artifact: {
          artifactId: "001-exec.txt",
          digest: "a".repeat(64),
          locator: { lineStart: 1, lineEnd: 3 },
        },
        content: "secret",
      }],
    },
    { role: "assistant", content: "old" },
    { role: "user", content: "keep" },
  ];

  const result = await createSlidingWindowStrategy().compact(messages, {
    keepRounds: 1,
    roundNumbers: [1, 2, 3, 4, 5],
  });

  assert.deepEqual(result.navigationRecord.artifacts, [{
    id: "001-exec.txt",
    locator: { lineStart: 1, lineEnd: 3 },
    digest: "a".repeat(64),
    status: "archived",
  }]);
  assert.doesNotMatch(JSON.stringify(result.navigationRecord), /secret/u);
});

test("materializes fallback resources before rendering stubs", async () => {
  const calls = [];
  const result = await createSlidingWindowStrategy().compact([
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "resource", name: "exec", input: {} }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "resource",
        artifact: { resource: "fallback bytes" },
        content: "fallback bytes",
      }],
    },
    { role: "user", content: "keep" },
  ], {
    keepRounds: 1,
    resourceStore: {
      async put(resource) {
        calls.push(resource);
        return {
          locator: { token: "fallback" },
          digest: "d".repeat(64),
          display: "object://fallback",
        };
      },
      async get() {
        return "fallback bytes";
      },
    },
    stubFor: (message) => `display=${message.content[0].artifact.display}`,
  });

  assert.deepEqual(calls, ["fallback bytes"]);
  assert.match(JSON.stringify(result.messages), /object:\/\/fallback/u);
  assert.deepEqual(result.navigationRecord.artifacts[0].locator, { token: "fallback" });
});
