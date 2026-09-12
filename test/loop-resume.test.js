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
    executeTool: async (_name, input) => `completed-${input.step}`,
    maxRounds: 3,
    completion: false,
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
    { type: "tool_result", tool_use_id: "b", content: "done-b" },
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
