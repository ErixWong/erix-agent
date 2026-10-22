import test from "node:test";
import assert from "node:assert/strict";

import { groupIntoRounds, pendingTrailingToolUses, validateMessages } from "../../src/messages/rounds.js";
import { KitError } from "../../src/providers/errors.js";
import {
  multiRoundMixedConversation,
  multipleToolCallsRound,
  pureTextConversation,
} from "../../fixtures/rounds-fixtures.mjs";

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

test("rejects duplicate tool_use ids within one assistant message", () => {
  assert.throws(
    () => validateMessages([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "same", name: "first", input: {} },
          { type: "tool_use", id: "same", name: "second", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "same", content: "one" },
          { type: "tool_result", tool_use_id: "same", content: "two" },
        ],
      },
    ]),
    (error) => error instanceof KitError
      && /tool_use ids must be unique within a message/.test(error.message),
  );
});

test("rejects empty or non-string tool_use ids", () => {
  for (const id of ["", undefined, 42]) {
    assert.throws(
      () => validateMessages([
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "work", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
        },
      ]),
      (error) => error instanceof KitError
        && /tool_use ids must be non-empty strings/.test(error.message),
    );
  }
});

test("accepts unique non-empty tool_use ids", () => {
  assert.doesNotThrow(() => validateMessages(multipleToolCallsRound));
});

test("rejects tool blocks in roles that cannot carry them", () => {
  assert.throws(
    () => validateMessages([{
      role: "user",
      content: [{ type: "tool_use", id: "call-1", name: "exec", input: {} }],
    }]),
    (error) => error instanceof KitError
      && error.code === "invalid_messages"
      && /only legal in assistant/.test(error.message),
  );
  assert.throws(
    () => validateMessages([{
      role: "assistant",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "nope" }],
    }]),
    (error) => error?.code === "invalid_messages",
  );
});

// issue #393：`pendingTrailingToolUses` 是「能不能往尾部再插一条 user 消息」的唯一判据。
// 它必须与 `validateMessages` 同源：返回空数组 ⇔ 追加一条 user 文本消息后仍然合法。
test("pendingTrailingToolUses: 只认末条 assistant 上的悬空 tool_use", () => {
  const pending = { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "exec", input: {} }] };
  assert.deepEqual(pendingTrailingToolUses([{ role: "user", content: "go" }, pending]), [pending.content[0]]);
  // 末条是 user（哪怕它只是 tool_result 载体）⇒ 没有悬空 tool_use
  assert.deepEqual(pendingTrailingToolUses(multipleToolCallsRound.slice(0, 3)), []);
  // 末条 assistant 是纯文本 ⇒ 没有悬空 tool_use
  assert.deepEqual(pendingTrailingToolUses([{ role: "user", content: "go" }, { role: "assistant", content: "done" }]), []);
  // 空列表 / 非数组 ⇒ 空数组（不抛）
  assert.deepEqual(pendingTrailingToolUses([]), []);
  assert.deepEqual(pendingTrailingToolUses(undefined), []);
});

test("pendingTrailingToolUses 与 validateMessages 同一口径：非空 ⇔ 尾部不能再插 user 消息", () => {
  const dangling = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "exec", input: {} }] },
  ];
  assert.equal(pendingTrailingToolUses(dangling).length, 1);
  // 悬空时插一条 user 文本消息 ⇒ 严格校验当场红（这正是 issue #393 的报错）
  assert.throws(
    () => validateMessages(dangling.concat({ role: "user", content: "还差一步" })),
    (error) => error instanceof KitError
      && /assistant tool_use has no immediately following user tool_result/.test(error.message),
  );
  // 先按 canonical 规则结清（紧随其后的 user tool_result）⇒ 插什么都不再破配对
  const repaired = dangling.concat({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call-1", content: "[erix] not executed" }],
  });
  assert.deepEqual(pendingTrailingToolUses(repaired), []);
  assert.doesNotThrow(() => validateMessages(repaired.concat({ role: "user", content: "还差一步" })));
});
