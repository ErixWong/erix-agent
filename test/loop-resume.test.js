import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

test("resumes after three rounds without replaying paid provider calls", async () => {
  const store = createMemoryTranscriptStore();
  const firstProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "work", input: { step: 1 } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "call-2", name: "work", input: { step: 2 } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "paused" }], stopReason: "end_turn" },
  ]);

  const firstResult = await runToolLoop({
    provider: firstProvider,
    initialUserMessage: "start",
    executeTool: async ({ input }) => `completed-${input.step}`,
    maxRounds: 3,
    completion: false,
    cacheStablePrefix: false,
    store,
    runId: "resume-run",
  });
  const beforeResume = await store.load("resume-run");
  const storedMessages = beforeResume.flatMap((record) => record.messages);

  assert.equal(firstResult.rounds, 3);
  assert.deepEqual(firstResult.messages, storedMessages); // 种子记录后档案 = 完整消息
  assert.equal(firstProvider.requests.length, 3);

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "round four" }], stopReason: "end_turn" },
  ]);
  const resumedResult = await runToolLoop({
    provider: resumedProvider,
    initialUserMessage: "must be ignored",
    initialMessages: [{ role: "user", content: "must also be ignored" }],
    executeTool: async () => "unused",
    maxRounds: 4,
    completion: false,
    cacheStablePrefix: false,
    store,
    runId: "resume-run",
    resume: true,
  });

  assert.equal(resumedProvider.requests.length, 1);
  assert.deepEqual(resumedProvider.requests[0].messages, storedMessages);
  assert.equal(resumedResult.rounds, 4);
  assert.equal(resumedResult.finalText, "round four");
  assert.deepEqual(
    (await store.load("resume-run")).map((record) => record.round),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(resumedResult.messages, [
    ...storedMessages,
    { role: "assistant", content: [{ type: "text", text: "round four" }] },
  ]);
});

test("resumes every pending tool in order after a mid-turn crash", async () => {
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstExecutions = [];
  const firstProvider = createFakeProvider([{
    content: [
      { type: "tool_use", id: "a", name: "work", input: { step: "a" } },
      { type: "tool_use", id: "b", name: "work", input: { step: "b" } },
      { type: "tool_use", id: "c", name: "work", input: { step: "c" } },
    ],
    stopReason: "tool_use",
  }]);

  await assert.rejects(
    runToolLoop({
      provider: firstProvider,
      initialUserMessage: "run three tools",
      executeTool: async ({ id }) => {
        firstExecutions.push(id);
        if (id === "b") controller.abort();
        return `done-${id}`;
      },
      maxRounds: 2,
      completion: false,
      store,
      runId: "resume-pending-tools",
      signal: controller.signal,
    }),
    /aborted|abort/i,
  );
  assert.deepEqual(firstExecutions, ["a", "b"]);

  const resumedExecutions = [];
  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider: resumedProvider,
    resume: true,
    completion: false,
    store,
    runId: "resume-pending-tools",
    executeTool: async ({ id }) => {
      resumedExecutions.push(id);
      return `resumed-${id}`;
    },
  });

  assert.deepEqual(resumedExecutions, ["b", "c"]);
  assert.equal(resumedProvider.requests.length, 1);
  const toolUseIds = result.messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => block.id);
  const toolResultIds = result.messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "tool_result")
    .map((block) => block.tool_use_id);
  assert.deepEqual(toolUseIds, ["a", "b", "c"]);
  assert.deepEqual(toolResultIds, ["a", "b", "c"]);
  assert.deepEqual(
    resumedProvider.requests[0].messages.at(-1).content.map((block) => block.tool_use_id),
    ["a", "b", "c"],
  );
  const persistedToolResultIds = (await store.load("resume-pending-tools"))
    .flatMap((record) => record.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "tool_result")
    .map((block) => block.tool_use_id);
  assert.deepEqual(persistedToolResultIds, ["a", "b", "c"]);
});

test("resumes a partial tool-result message without dropping text or breaking pairing", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-mixed-tool-result";
  await store.appendRound(runId, {
    round: 0,
    messages: [{ role: "user", content: "task" }],
  });
  await store.saveCheckpoint(runId, {
    round: 1,
    pendingToolUses: [
      { type: "tool_use", id: "a", name: "work", input: { step: "a" } },
      { type: "tool_use", id: "b", name: "work", input: { step: "b" } },
    ],
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "work", input: { step: "a" } },
          { type: "tool_use", id: "b", name: "work", input: { step: "b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "done-a" },
          { type: "text", text: "keep this text" },
        ],
      },
    ],
    executedToolIds: ["a"],
    toolResults: [{
      toolUseId: "a",
      toolResult: { type: "tool_result", tool_use_id: "a", content: "done-a" },
    }],
  });

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    resume: true,
    completion: false,
    store,
    runId,
    executeTool: async ({ id }) => `done-${id}`,
  });

  const toolResultMessage = provider.requests[0].messages[2];
  assert.deepEqual(toolResultMessage.content, [
    { type: "tool_result", tool_use_id: "a", content: "done-a" },
    { type: "text", text: "keep this text" },
    { type: "tool_result", tool_use_id: "b", content: "done-b", erixRound: 1 },
  ]);
});

test("does not merge a tool result whose id belongs to another assistant call", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-mismatched-tool-result";
  await store.appendRound(runId, {
    round: 0,
    messages: [{ role: "user", content: "task" }],
  });
  await store.saveCheckpoint(runId, {
    round: 1,
    pendingToolUses: [
      { type: "tool_use", id: "a", name: "work", input: {} },
      { type: "tool_use", id: "b", name: "work", input: {} },
    ],
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "work", input: {} },
          { type: "tool_use", id: "b", name: "work", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "wrong", content: "wrong" }],
      },
    ],
    executedToolIds: ["a"],
    toolResults: [{
      toolUseId: "a",
      toolResult: { type: "tool_result", tool_use_id: "a", content: "done-a" },
    }],
  });

  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([
        { content: [{ type: "text", text: "unreachable" }], stopReason: "end_turn" },
      ]),
      resume: true,
      completion: false,
      store,
      runId,
      executeTool: async () => "done-b",
    }),
    (error) => error?.code === "invalid_messages",
  );
});

test("resumes tool results before a later direction hint without moving the hint", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-tool-result-before-hint";
  await store.appendRound(runId, {
    round: 0,
    messages: [{ role: "user", content: "task" }],
  });
  await store.saveCheckpoint(runId, {
    round: 1,
    pendingToolUses: [
      { type: "tool_use", id: "a", name: "work", input: {} },
      { type: "tool_use", id: "b", name: "work", input: {} },
    ],
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "work", input: {} },
          { type: "tool_use", id: "b", name: "work", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "done-a" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "（附方向提示：换一种方法）" }],
      },
    ],
    executedToolIds: ["a"],
    toolResults: [{
      toolUseId: "a",
      toolResult: { type: "tool_result", tool_use_id: "a", content: "done-a" },
    }],
  });

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    resume: true,
    completion: false,
    store,
    runId,
    executeTool: async ({ id }) => `done-${id}`,
  });

  assert.deepEqual(
    provider.requests[0].messages.slice(-3).map((message) => message.role),
    ["assistant", "user", "user"],
  );
  assert.deepEqual(
    provider.requests[0].messages.at(-2).content.map((block) => block.tool_use_id),
    ["a", "b"],
  );
  assert.match(provider.requests[0].messages.at(-1).content[0].text, /附方向提示/);
});

test("restores judge interception count from executed checkpoint tools", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-judge-count";
  await store.appendRound(runId, {
    round: 0,
    messages: [{ role: "user", content: "task" }],
  });
  await store.saveCheckpoint(runId, {
    round: 1,
    pendingToolUses: [
      { type: "tool_use", id: "a", name: "work", input: { step: 1 } },
      { type: "tool_use", id: "b", name: "work", input: { step: 2 } },
    ],
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "work", input: { step: 1 } },
          { type: "tool_use", id: "b", name: "work", input: { step: 2 } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "done-a" }],
      },
    ],
    executedToolIds: ["a"],
    toolResults: [{
      toolUseId: "a",
      toolResult: { type: "tool_result", tool_use_id: "a", content: "done-a" },
    }],
  });

  const audited = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const judge = createFakeProvider([
    {
      content: [{
        type: "text",
        text: JSON.stringify({
          done: true,
          confidence: 1,
          reason: "continue",
          evidence: "checkpoint restored",
        }),
      }],
    },
  ]);
  await runToolLoop({
    provider,
    resume: true,
    completion: false,
    store,
    runId,
    executeTool: async ({ id }) => `done-${id}`,
    reflection: {
      enabled: true,
      roundJudge: false,
      judgeIntervalRound: 1,
      judge: { provider: judge },
    },
    onJudge: (info) => audited.push(info.tool?.id),
  });

  assert.deepEqual(audited, ["b"]);
  assert.equal(judge.requests.length, 1);
});

test("resume rejects an empty transcript", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([]);

  await assert.rejects(
    runToolLoop({
      provider,
      initialUserMessage: "ignored",
      executeTool: async () => "unused",
      store,
      runId: "empty",
      resume: true,
    }),
    (error) => error?.message === "resume: 无可恢复记录",
  );
  assert.equal(provider.requests.length, 0);
});

test("resumes folded checkpoints from the persisted transcript anchor", async () => {
  for (const keepRounds of [0, 2]) {
    const store = createMemoryTranscriptStore();
    const controller = new AbortController();
    const firstProvider = createFakeProvider([
      {
        content: [{ type: "tool_use", id: "c1", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "c2", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "c3", name: "work", input: {} }],
        stopReason: "tool_use",
      },
    ]);
    let calls = 0;
    const strategy = {
      shouldCompact: () => true,
      compact: (messages, options) => createFoldStatisticalStrategy().compact(
        messages,
        { ...options, keepRounds },
      ),
    };

    await assert.rejects(
      runToolLoop({
        provider: firstProvider,
        initialUserMessage: "fold-base-input",
        executeTool: ({ signal }) => {
          calls += 1;
          if (calls === 3) {
            controller.abort();
            return "not reached";
          }
          return `tool-out-${calls}`;
        },
        maxRounds: 6,
        completion: false,
        context: { strategy, budgetTokens: 30 },
        store,
        runId: `fold-${keepRounds}`,
        signal: controller.signal,
      }),
      /aborted|abort/i,
    );

    const checkpoint = await store.loadLatestCheckpoint(`fold-${keepRounds}`);
    assert.equal(checkpoint.persistedTranscriptLength, 5);
    await store.appendRound(`fold-${keepRounds}`, {
      round: 2,
      dedupKey: `fold-${keepRounds}:input`,
      messages: [textMessage("tail-after-fold")],
    });

    const resumedProvider = createFakeProvider([
      { content: [{ type: "text", text: "final" }] },
    ]);
    await runToolLoop({
      provider: resumedProvider,
      resume: true,
      completion: false,
      store,
      runId: `fold-${keepRounds}`,
      executeTool: async () => "resumed-tool",
    });

    const requestMessages = resumedProvider.requests[0].messages;
    const serialized = JSON.stringify(requestMessages);
    assert.equal((serialized.match(/fold-base-input/g) ?? []).length, 1);
    assert.equal(
      requestMessages.at(-1).content[0].text,
      "tail-after-fold",
    );
    assert.ok(requestMessages.findIndex((message) => (
      message.content?.some((block) => block.type === "tool_result")
    )) < requestMessages.length - 1);
  }
});

test("archives replayed tool results without duplicating multiple resume tails", async () => {
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstProvider = createFakeProvider([{
    content: [{ type: "tool_use", id: "call-1", name: "work", input: {} }],
    stopReason: "tool_use",
  }]);

  await assert.rejects(
    runToolLoop({
      provider: firstProvider,
      initialUserMessage: "user-one",
      executeTool: ({ signal }) => {
        controller.abort();
        return signal.reason;
      },
      completion: false,
      store,
      runId: "multi-tail",
      signal: controller.signal,
    }),
    /aborted|abort/i,
  );
  await store.appendRound("multi-tail", {
    round: 0,
    dedupKey: "multi-tail:input:1",
    messages: [textMessage("user-two")],
  });
  await store.appendRound("multi-tail", {
    round: 0,
    dedupKey: "multi-tail:input:2",
    messages: [textMessage("user-three")],
  });

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "resumed" }] },
  ]);
  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    completion: false,
    store,
    runId: "multi-tail",
    executeTool: async () => "tool-output",
  });

  const requestMessages = resumedProvider.requests[0].messages;
  assert.deepEqual(
    requestMessages.slice(-2).map((message) => message.content[0].text),
    ["user-two", "user-three"],
  );
  const records = await store.load("multi-tail");
  const archived = JSON.stringify(records);
  assert.equal((archived.match(/user-two/g) ?? []).length, 1);
  assert.equal((archived.match(/user-three/g) ?? []).length, 1);
  assert.equal((archived.match(/tool-output/g) ?? []).length, 1);
  const resumedRound = records.find((record) => record.round === 1);
  assert.ok(resumedRound.messages.some((message) => (
    message.content?.some((block) => block.type === "tool_result")
  )));

  const secondProvider = createFakeProvider([
    { content: [{ type: "text", text: "second resume" }] },
  ]);
  await runToolLoop({
    provider: secondProvider,
    resume: true,
    completion: false,
    store,
    runId: "multi-tail",
    executeTool: async () => "unused",
  });
  assert.equal(secondProvider.requests.length, 1);
});

test("resumed session gets its own round budget and persists the continuation rounds (issue #32 #8)", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-budget-after-cap";

  // 第一段：maxRounds 跑满（每轮都调工具）→ 以 max_rounds_cap 强制收尾
  const firstProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "s1-a", name: "work", input: { step: 1 } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "s1-b", name: "work", input: { step: 2 } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "session-one-final" }], stopReason: "end_turn" },
  ]);
  const first = await runToolLoop({
    provider: firstProvider,
    initialUserMessage: "session one task",
    executeTool: async ({ input }) => `done-${input.step}`,
    maxRounds: 2,
    completion: false,
    store,
    runId,
  });
  assert.equal(first.rounds, 2);
  assert.equal(first.termination.reason, "max_rounds_cap");

  // 第二段：宿主以 CLI/REPL 同样的方式落一条同 session 追问输入行
  // （round = 当前最大轮号，独立 dedupKey；见 bin/cli.js、bin/repl.js 的 resume 路径）
  const beforeResume = await store.load(runId);
  const latestRound = Math.max(0, ...beforeResume.map((record) => record.round ?? 0));
  const inputKey = `${runId}:input:1`;
  await store.appendRound(runId, {
    round: latestRound,
    roundKey: inputKey,
    dedupKey: inputKey,
    messages: [textMessage("session two follow-up")],
    ts: new Date().toISOString(),
  });

  const secondProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "s2-a", name: "work", input: { step: "follow-up" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "session-two-answer" }], stopReason: "end_turn" },
  ]);
  const executed = [];
  const second = await runToolLoop({
    provider: secondProvider,
    resume: true,
    executeTool: async ({ input }) => {
      executed.push(input.step);
      return `resumed-${input.step}`;
    },
    maxRounds: 2,
    completion: false,
    store,
    runId,
  });

  // 轮预算（budgetRounds）从 0 起算：续接会话能真正跑满并执行工具。
  // 修复前 rounds 已 = maxRounds（2），主循环 `rounds < effectiveMaxRounds` 一次都进不去，
  // 既没有工具调用，也不落任何续接轮记录（transcript 只剩追问那条近空行）。
  assert.deepEqual(executed, ["follow-up"]);
  assert.equal(second.finalText, "session-two-answer");
  assert.deepEqual(second.termination, { reason: "end_turn" });
  // 身份轮号（rounds）跨 resume 单调递增
  assert.equal(second.rounds, 4);

  // run-state 双报：rounds = 会话累计，runRounds / remainingRounds = 本次预算
  const budget = second.runState.deterministic.budget;
  assert.equal(budget.rounds, 4);
  assert.equal(budget.runRounds, 2);
  assert.equal(budget.maxRounds, 2);
  assert.equal(budget.remainingRounds, 0);
  assert.match(second.runState.rendered, /r=2\/2 left=0/u);
  assert.match(second.runState.rendered, /session=4/u);

  // transcript 完整：追问在案、续接轮记录在案且含 response 文本，轮号递增不撞号
  const records = await store.load(runId);
  assert.deepEqual(records.map((record) => record.round), [0, 1, 2, 2, 3, 4]);
  const flatMessages = records.flatMap((record) => record.messages ?? []);
  assert.equal(
    flatMessages.filter((message) => (
      (message.content ?? []).some((block) => block?.text === "session two follow-up")
    )).length,
    1,
  );
  const continuationRecords = records.filter((record) => record.round > latestRound);
  assert.equal(continuationRecords.length, 2, "续接轮记录不得被去重丢弃");
  const continuationText = continuationRecords.flatMap((record) => record.messages ?? []);
  assert.ok(
    continuationText.some((message) => message.role === "user"
      && (message.content ?? []).some((block) => block?.type === "tool_result")),
    "续接轮记录应含 user（tool_result）消息",
  );
  const answerRecords = records.filter((record) => (
    (record.messages ?? []).some((message) => (
      (message.content ?? []).some((block) => block?.text === "session-two-answer")
    ))
  ));
  assert.equal(answerRecords.length, 1, "续接轮的 response 文本必须落盘");
  assert.ok(answerRecords[0].round > latestRound);
});

test("engine round records are not deduped away by a host row with the same round number", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "engine-round-key-namespace";
  // 宿主预置历史行：默认键（无 dedupKey/roundKey）→ `${runId}:round:1`
  await store.appendRound(runId, {
    round: 1,
    messages: [textMessage("宿主预置历史")],
  });

  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "engine-1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "engine-answer" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "engine task",
    executeTool: async () => "tool-out",
    maxRounds: 2,
    completion: false,
    store,
    runId,
  });

  assert.equal(result.finalText, "engine-answer");
  const records = await store.load(runId);
  // 宿主行 + 引擎 round 1 行并存（修复前引擎行被同键去重吃掉，transcript 只剩宿主那行）
  assert.deepEqual(records.map((record) => record.round), [1, 0, 1, 2]);
  const engineRoundOne = records.filter((record) => record.round === 1
    && (record.messages ?? []).some((message) => message.role === "assistant"));
  assert.equal(engineRoundOne.length, 1);
  assert.ok((engineRoundOne[0].messages ?? []).some((message) => (
    message.content?.some((block) => block?.type === "tool_result")
  )));
  assert.ok(records.some((record) => (record.messages ?? []).some((message) => (
    message.content?.some((block) => block?.text === "engine-answer")
  ))));
});
