import test from "node:test";
import assert from "node:assert/strict";

import { groupIntoRounds } from "../../src/messages/rounds.js";
import {
  multiRoundMixedConversation,
  multipleToolCallsRound,
  pureTextConversation,
} from "../fixtures/rounds-fixtures.mjs";

test("keeps the first real user in the protected head", () => {
  const result = groupIntoRounds([
    { role: "system", content: "system" },
    ...pureTextConversation,
  ]);

  assert.deepEqual(result.head, [
    { role: "system", content: "system" },
    { role: "user", content: "Hello" },
  ]);
  assert.deepEqual(result.rounds, [
    { messages: [pureTextConversation[1]] },
    { messages: [pureTextConversation[2]] },
    { messages: [pureTextConversation[3]] },
  ]);
});

test("groups tool calls with their immediately following results", () => {
  const result = groupIntoRounds(multipleToolCallsRound);

  assert.deepEqual(result.head, [multipleToolCallsRound[0]]);
  assert.deepEqual(result.rounds, [
    { messages: multipleToolCallsRound.slice(1, 3) },
    { messages: [multipleToolCallsRound[3]] },
  ]);
});

test("makes real user messages and text-only assistants independent rounds", () => {
  const result = groupIntoRounds(multiRoundMixedConversation);

  assert.deepEqual(result.rounds.map((round) => round.messages), [
    [multiRoundMixedConversation[1]],
    [multiRoundMixedConversation[2]],
    multiRoundMixedConversation.slice(3, 5),
    [multiRoundMixedConversation[5]],
  ]);
});

test("rejects a tool call without matching results and reports its index", () => {
  assert.throws(
    () => groupIntoRounds([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "exec", input: {} }],
      },
    ]),
    (error) => /index 1/.test(error.message) && /tool_use/.test(error.message),
  );
});

test("rejects mismatched and orphan tool results with their index", () => {
  assert.throws(
    () => groupIntoRounds([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "exec", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "wrong", content: "nope" }],
      },
    ]),
    (error) => /index 2/.test(error.message),
  );

  assert.throws(
    () => groupIntoRounds([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "nope" }] },
    ]),
    (error) => /index 0/.test(error.message) && /tool_result/.test(error.message),
  );
});
