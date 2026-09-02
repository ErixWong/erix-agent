import test from "node:test";
import assert from "node:assert/strict";

import {
  decideRoundAction,
  decideWithEvaluation,
} from "../src/reflection/governor.js";
import {
  extractL0Facts,
  parseL1Summary,
} from "../src/reflection/l0.js";

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
