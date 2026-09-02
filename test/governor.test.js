import test from "node:test";
import assert from "node:assert/strict";

import {
  decideRoundAction,
  decideWithEvaluation,
  isStuckOnRepeatedError,
} from "../src/reflection/governor.js";
import {
  extractL0Facts,
  parseL1Summary,
} from "../src/reflection/l0.js";
import { runToolLoop } from "../src/loop.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

test("governor keeps continuation exhaustion ahead of reflection", () => {
  assert.deepEqual(
    decideRoundAction({
      continuationExhausted: true,
      reflectionEnabled: true,
      nearLimit: true,
    }),
    { kind: "stop", value: "cap", truncated: true },
  );
});

test("governor performs deterministic memory-loss recovery", () => {
  const action = decideRoundAction({ memoryLoss: true });
  assert.equal(action.kind, "nudge");
  assert.equal(action.reason, "memoryLoss");
  assert.equal(action.resetNoToolStreak, true);
  assert.match(action.text, /任务仍在进行/);
});

test("governor detects a repeated error only without progress", () => {
  assert.equal(
    isStuckOnRepeatedError({
      errorRepeat: 3,
      hasProgress: false,
      shouldContinue: true,
    }),
    true,
  );
  assert.equal(
    isStuckOnRepeatedError({
      errorRepeat: 2,
      hasProgress: false,
      shouldContinue: true,
    }),
    false,
  );
  assert.equal(
    isStuckOnRepeatedError({
      errorRepeat: 3,
      hasProgress: true,
      shouldContinue: true,
    }),
    false,
  );
});

test("L0 accumulates identical errors across rounds without mixing hashes", () => {
  const state = { seenErrors: new Map() };
  const sameError = (text) => [{
    role: "user",
    content: [{ type: "tool_result", is_error: true, content: text }],
  }];
  assert.equal(extractL0Facts(sameError("same"), state).errorRepeat, 1);
  assert.equal(extractL0Facts(sameError("same"), state).errorRepeat, 2);
  const different = extractL0Facts(sameError("different"), state);
  assert.equal(different.errorRepeat, 1);
  assert.equal(extractL0Facts(sameError("same"), state).errorRepeat, 3);
});

test("loop nudges after three rounds of the same error", async () => {
  const provider = createFakeProvider([
    ...["one", "two", "three"].map((id) => ({
      content: [{ type: "tool_use", id, name: `work-${id}`, input: {} }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "fix it",
    executeTool: async () => ({ data: "same failure", success: false }),
    maxRounds: 4,
    completion: false,
    stallDetection: false,
  });
  assert.ok(provider.requests[3].messages.some((message) => (
    message.content?.some((block) => /请换思路/.test(block.text ?? ""))
  )));
});

test("loop does not nudge a repeated error when the round also makes progress", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "bad-1", name: "bad", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "bad-2", name: "bad", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [
        { type: "tool_use", id: "bad-3", name: "bad", input: {} },
        { type: "tool_use", id: "good-3", name: "good", input: {} },
      ],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "fix it",
    executeTool: async ({ name }) => (
      name === "good"
        ? { data: "progress", success: true }
        : { data: "same failure", success: false }
    ),
    maxRounds: 4,
    completion: false,
    stallDetection: false,
  });
  assert.equal(
    provider.requests[3].messages.some((message) => (
      message.content?.some((block) => /请换思路/.test(block.text ?? ""))
    )),
    false,
  );
});

test("governor preserves the intermediate no-tool nudge", () => {
  assert.deepEqual(
    decideRoundAction({
      noToolRound: true,
      noToolStreak: 1,
      maxNoToolRounds: 3,
    }),
    {
      kind: "nudge",
      reason: "noTool",
      text: "（请继续完成任务）",
      continue: true,
    },
  );
  assert.equal(
    decideRoundAction({
      noToolRound: true,
      noToolStreak: 3,
      maxNoToolRounds: 3,
    }).value,
    "noTool",
  );
});

test("governor requests reflection, then extends or redirects from evaluation", () => {
  const signals = {
    reflectionEnabled: true,
    nearLimit: true,
    extensionCount: 0,
    maxExtensions: 2,
    effectiveMaxRounds: 10,
    maxRoundsCap: 20,
    extensionStep: 5,
    shouldContinue: true,
  };
  assert.deepEqual(decideRoundAction(signals), { kind: "reflect" });
  assert.equal(
    decideWithEvaluation(signals, {
      continue: true,
      stalled: false,
      plan: "运行测试",
    }).kind,
    "extend",
  );
  assert.equal(
    decideWithEvaluation(signals, {
      continue: true,
      stalled: true,
      stallPattern: "重复",
      plan: "换方案",
    }).kind,
    "extend+redirect",
  );
  assert.equal(
    decideWithEvaluation(signals, { continue: false }).value,
    "reflection-stop",
  );
});

test("governor skips extension but continues when time is short", () => {
  const action = decideWithEvaluation({
    reflectionEnabled: true,
    nearLimit: true,
    extensionCount: 0,
    maxExtensions: 1,
    effectiveMaxRounds: 8,
    maxRoundsCap: 16,
    elapsedMs: 12_000,
    rounds: 2,
    remainingMs: 10_000,
  }, { continue: true });
  assert.deepEqual(action, {
    kind: "continue",
    timedOut: true,
  });
});

test("L0 deduplicates identical errors and truncates excerpts", () => {
  const longError = "x".repeat(700);
  const messages = [{
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", is_error: true, content: longError },
      { type: "tool_result", tool_use_id: "b", is_error: true, content: longError },
      { type: "tool_result", tool_use_id: "c", content: "ok" },
    ],
  }];
  const fact = extractL0Facts(messages);
  assert.equal(fact.exitOk, false);
  assert.equal(fact.errorText.length, 500);
  assert.equal(fact.errorHashes.length, 1);
  assert.equal(fact.errorHash, fact.errorHashes[0]);
  assert.equal(
    extractL0Facts([{ role: "user", content: [{
      type: "tool_result",
      content: "ok",
    }] }]).exitOk,
    true,
  );
});

test("L1 parses embedded summaries and strips their markers", () => {
  const parsed = parseL1Summary(
    "前置文本 <erix-summary>{\"action\":\"test\",\"note\":\"新增测试\"}</erix-summary> 后置文本",
  );
  assert.deepEqual(parsed.summary, { action: "test", note: "新增测试" });
  assert.equal(parsed.text, "前置文本  后置文本");
});

test("L1 treats malformed and absent summaries as missing", () => {
  assert.equal(
    parseL1Summary("x<erix-summary>{bad}</erix-summary>").summary,
    "missing",
  );
  assert.equal(parseL1Summary("plain text").summary, "missing");
});

test("L0 persists cumulative error counts for resume reconstruction", () => {
  const state = { seenErrors: new Map() };
  const err = { type: "tool_result", tool_use_id: "a", is_error: true, content: "same failure" };
  // 第 1 轮：1 次同错
  let fact1 = extractL0Facts([{ role: "user", content: [err] }], state);
  assert.equal(fact1.errorRepeat, 1);
  assert.deepEqual(fact1.errorCounts, { [fact1.errorHash]: 1 });
  // 第 2 轮：再次同错 → count 2（errorCounts 反映跨轮累计）
  const fact2 = extractL0Facts([{ role: "user", content: [err] }], state);
  assert.equal(fact2.errorRepeat, 2);
  assert.deepEqual(fact2.errorCounts, { [fact2.errorHash]: 2 });
  // 不同错误不混
  const other = { type: "tool_result", tool_use_id: "b", is_error: true, content: "different error" };
  const fact3 = extractL0Facts([{ role: "user", content: [other] }], state);
  assert.equal(fact3.errorRepeat, 1); // 新错首现
  assert.equal(Object.keys(fact3.errorCounts).length, 1); // 本轮只含新错
});
