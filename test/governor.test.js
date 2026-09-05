import test from "node:test";
import assert from "node:assert/strict";

import {
  decideRoundAction,
  decideWithEvaluation,
  isStuckOnRepeatedError,
  shouldWrapUp,
  STALL_STREAK_LIMIT,
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

test("governor nudges suspected stalls before stopping at the streak limit", () => {
  assert.equal(STALL_STREAK_LIMIT, 3);
  const nudge = decideRoundAction({
    stallSuspicion: true,
    stallStreak: STALL_STREAK_LIMIT - 1,
  });
  assert.equal(nudge.kind, "nudge");
  assert.equal(nudge.reason, "stall");
  assert.equal(nudge.resetNoToolStreak, true);
  assert.equal(nudge.continue, true);
  assert.match(nudge.text, /疑似重复调用/);
  assert.match(nudge.text, /推进新步骤/);
  assert.deepEqual(
    decideRoundAction({
      stallSuspicion: true,
      stallStreak: STALL_STREAK_LIMIT,
    }),
    { kind: "stop", value: "stall", truncated: true },
  );
});

test("governor detects a short wrap-up window only once and when not spinning", () => {
  const signals = {
    elapsedMs: 12_000,
    rounds: 2,
    remainingMs: 10_000,
    errorRepeat: 0,
  };
  assert.equal(shouldWrapUp(signals), true);
  assert.equal(shouldWrapUp({ ...signals, remainingMs: 30_000 }), false);
  assert.equal(shouldWrapUp({ ...signals, wrapUpNudged: true }), false);
  assert.equal(shouldWrapUp({ ...signals, errorRepeat: 3 }), false);
});

test("governor prioritizes the wrap-up nudge before lower-priority actions", () => {
  const action = decideRoundAction({
    elapsedMs: 12_000,
    rounds: 2,
    remainingMs: 10_000,
    errorRepeat: 2,
    hasProgress: false,
    shouldContinue: true,
    noToolRound: true,
    noToolStreak: 1,
    maxNoToolRounds: 3,
  });
  assert.equal(action.kind, "nudge");
  assert.equal(action.reason, "wrapUp");
  assert.equal(action.wrapUpNudged, true);
  assert.equal(action.continue, true);
  assert.match(action.text, /剩余约 10 秒/);
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

test("loop injects the wrap-up nudge once near a configured deadline", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "one", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "two", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "finish it",
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { data: "worked", success: true };
    },
    maxRounds: 3,
    timeoutMs: 100,
    completion: false,
    stallDetection: false,
  });
  for (const request of provider.requests.slice(0, 3)) {
    assert.equal(
      request.messages.filter((message) => (
        message.content?.some((block) => /外部时间预算将尽/.test(block.text ?? ""))
      )).length,
      request === provider.requests[0] ? 0 : 1,
    );
  }
});

test("loop does not inject a wrap-up nudge without a configured deadline", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "one", name: "work", input: {} }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "finish it",
    executeTool: async () => ({ data: "worked", success: true }),
    maxRounds: 2,
    completion: false,
    stallDetection: false,
  });
  assert.equal(
    provider.requests[1].messages.some((message) => (
      message.content?.some((block) => /外部时间预算将尽/.test(block.text ?? ""))
    )),
    false,
  );
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

test("wrap-up window defers to repeated-error redirect when stuck", () => {
  // errorRepeat>=3 且临近 deadline：repeatedError 换思路优先（两分支互斥），
  // 不收尾提示（避免打转时放弃产物收尾）
  const action = decideRoundAction({
    remainingMs: 5_000,
    elapsedMs: 60_000,
    rounds: 10,
    errorRepeat: 4,
    hasProgress: false,
    shouldContinue: true,
    wrapUpNudged: false,
  });
  assert.equal(action.kind, "nudge");
  assert.equal(action.reason, "repeatedError");
  assert.notEqual(action.reason, "wrapUp");
});

test("wrap-up does not fire when the model is already writing output without tools", () => {
  // hasToolUse=false（模型正在自然收尾/输出文本）时不打扰
  const action = decideRoundAction({
    remainingMs: 5_000,
    elapsedMs: 60_000,
    rounds: 10,
    hasToolUse: false,
    errorRepeat: 1,
    shouldContinue: false,
    wrapUpNudged: false,
  });
  assert.notEqual(action.reason, "wrapUp");
});
