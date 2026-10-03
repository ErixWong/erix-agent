import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createDeterministicRunState } from "../src/run-state.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

test("replay policy and tool declarations reject unsupported values", async () => {
  const options = {
    provider: createFakeProvider([]),
    executeTool: async () => "unused",
    completion: false,
  };
  await assert.rejects(
    runToolLoop({
      ...options,
      tools: [{ name: "work", inputSchema: { type: "object" }, replay: "sometimes" }],
    }),
    /tools\[0\]\.replay must be "safe" or "unsafe"/u,
  );
  await assert.rejects(
    runToolLoop({ ...options, replayPolicy: "sometimes" }),
    /replayPolicy must be "always-replay" or "per-tool-declaration"/u,
  );
});

test("resume prefers a valid independent run-state over the latest record state", async () => {
  const store = createMemoryTranscriptStore();
  const independentState = createDeterministicRunState({
    runId: "independent-state",
    stateVersion: 4,
    maxRounds: 1,
    toolStats: new Map([["independent-tool", { calls: 7, failures: 2 }]]),
  });
  const recordState = createDeterministicRunState({
    runId: "independent-state",
    stateVersion: 9,
    maxRounds: 1,
    toolStats: new Map([["record-tool", { calls: 11, failures: 3 }]]),
  });
  await store.appendRound("independent-state", {
    round: 0,
    messages: [textMessage("seed")],
    runState: recordState,
  });
  store.loadRunState = async () => independentState;

  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId: "independent-state",
    executeTool: async () => "unused",
  });

  assert.deepEqual(result.runState.deterministic.tools, [{
    name: "independent-tool",
    calls: 7,
    failures: 2,
  }]);
});

test("resume falls back to the latest record run-state when the store has no loader", async () => {
  const runId = "record-state-fallback";
  const recordState = createDeterministicRunState({
    runId,
    stateVersion: 3,
    maxRounds: 1,
    toolStats: new Map([["record-tool", { calls: 5, failures: 1 }]]),
  });
  const records = [{
    round: 0,
    messages: [textMessage("seed")],
    runState: recordState,
  }];
  const store = {
    appendRound: async (_runId, record) => records.push(structuredClone(record)),
    load: async () => records.map((record) => structuredClone(record)),
  };

  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId,
    executeTool: async () => "unused",
  });

  assert.deepEqual(result.runState.deterministic.tools, [{
    name: "record-tool",
    calls: 5,
    failures: 1,
  }]);
});

test("resume does not fall back when an independent run-state is present but invalid", async () => {
  const store = createMemoryTranscriptStore();
  const recordState = createDeterministicRunState({
    runId: "invalid-independent-state",
    stateVersion: 3,
    maxRounds: 1,
    toolStats: new Map([["record-tool", { calls: 11, failures: 3 }]]),
  });
  await store.appendRound("invalid-independent-state", {
    round: 0,
    messages: [textMessage("seed")],
    runState: recordState,
  });
  store.loadRunState = async () => ({ schemaVersion: 99 });

  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId: "invalid-independent-state",
    executeTool: async () => "unused",
  });

  assert.equal(result.runState.stateAvailability.status, "state_unavailable");
  assert.equal(result.runState.stateAvailability.reason, "unknown_schema");
  assert.deepEqual(result.runState.deterministic.tools, []);
});

test("run-state availability does not make the next resume invalid", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "run-state-availability-ratchet";
  const originalLoadRunState = store.loadRunState.bind(store);
  let loadRunStateCalls = 0;
  store.loadRunState = async (requestedRunId) => {
    loadRunStateCalls += 1;
    if (loadRunStateCalls === 1) return { schemaVersion: 99 };
    return originalLoadRunState(requestedRunId);
  };
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("seed")],
  });

  const first = await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "ratchet-tool", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "first done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId,
    maxRounds: 2,
    executeTool: async () => "worked",
  });

  assert.equal(first.runState.stateAvailability.status, "state_unavailable");
  const persisted = await originalLoadRunState(runId);
  assert.equal(persisted.stateAvailability.status, "state_unavailable");
  assert.deepEqual(persisted.deterministic.tools, [{
    name: "work",
    calls: 1,
    failures: 0,
  }]);

  const second = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "second done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId,
    maxRounds: 1,
    executeTool: async () => "unused",
  });

  assert.equal(loadRunStateCalls, 2);
  assert.deepEqual(second.runState.deterministic.tools, [{
    name: "work",
    calls: 1,
    failures: 0,
  }]);
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
  assert.ok(
    firstProvider.requests[0].messages.some((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => /\[run state deterministic v/u.test(block?.text ?? ""))
    )),
    "低预算 run-state 只应出现在 provider 请求视图",
  );
  assert.doesNotMatch(
    JSON.stringify(storedMessages),
    /\[run state deterministic v/u,
  );

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
  const tools = [{
    name: "work",
    inputSchema: { type: "object" },
    replay: "unsafe",
  }];
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
      tools,
      signal: controller.signal,
    }),
    /aborted|abort/i,
  );
  assert.deepEqual(firstExecutions, ["a", "b"]);
  assert.equal(firstProvider.requests[0].tools[0].replay, undefined);
  const pendingSnapshot = await store.loadLatestRunSnapshot("resume-pending-tools");
  assert.deepEqual(
    pendingSnapshot.pendingToolUses.map(({ id, name, input, replay }) => ({
      id,
      name,
      input,
      replay,
    })),
    [
      { id: "b", name: "work", input: { step: "b" }, replay: "unsafe" },
      { id: "c", name: "work", input: { step: "c" }, replay: "unsafe" },
    ],
  );

  const resumedExecutions = [];
  const resumedEvents = [];
  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "complete" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider: resumedProvider,
    resume: true,
    completion: false,
    store,
    runId: "resume-pending-tools",
    tools,
    onEvent: (event) => resumedEvents.push(event),
    executeTool: async ({ id }) => {
      resumedExecutions.push(id);
      return `resumed-${id}`;
    },
  });

  assert.deepEqual(resumedExecutions, ["b", "c"]);
  assert.ok(resumedEvents
    .filter((event) => event.type === "tool_use")
    .every((event) => !Object.hasOwn(event.toolUse, "replay")));
  const replaySnapshot = await store.loadLatestRunSnapshot("resume-pending-tools");
  assert.ok(replaySnapshot.pendingToolUses.every((toolUse) => toolUse.replay === "unsafe"));
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

test("per-tool replay policy replays safe pending tools", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-safe-tool";
  const toolUse = {
    type: "tool_use",
    id: "safe-call",
    name: "safe_work",
    input: { step: 1 },
    replay: "safe",
  };
  const storedToolUse = {
    type: toolUse.type,
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  };
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("continue safely")],
  });
  await store.saveRunSnapshot(runId, {
    round: 1,
    status: "pending",
    pendingToolUses: [toolUse],
    messages: [
      textMessage("continue safely"),
      { role: "assistant", content: [storedToolUse] },
    ],
    executedToolIds: [],
    toolResults: [],
  });

  const executions = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    resume: true,
    completion: false,
    replayPolicy: "per-tool-declaration",
    tools: [{
      name: "safe_work",
      inputSchema: { type: "object" },
      replay: "safe",
    }],
    store,
    runId,
    executeTool: async ({ id }) => {
      executions.push(id);
      return "replayed safely";
    },
  });

  assert.deepEqual(executions, ["safe-call"]);
  const replayedResult = provider.requests[0].messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result" && block.tool_use_id === "safe-call");
  assert.equal(replayedResult.content, "replayed safely");
});

test("per-tool replay policy interrupts unsafe tools and exposes saved partial output", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-unsafe-tool";
  const toolUse = {
    type: "tool_use",
    id: "unsafe-call",
    name: "unsafe_work",
    input: { action: "publish" },
  };
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("resume carefully")],
  });
  await store.saveRunSnapshot(runId, {
    round: 1,
    status: "pending",
    pendingToolUses: [{ ...toolUse, replay: "unsafe" }],
    messages: [
      textMessage("resume carefully"),
      { role: "assistant", content: [toolUse] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "unsafe-call",
          content: "partial response already persisted",
        }],
      },
    ],
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [{
      toolUseId: "unsafe-call",
      name: "unsafe_work",
      content: "captured output before interruption",
    }],
  });

  const events = [];
  let executions = 0;
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    resume: true,
    completion: false,
    replayPolicy: "per-tool-declaration",
    tools: [{
      name: "unsafe_work",
      inputSchema: { type: "object" },
      replay: "unsafe",
    }],
    store,
    runId,
    onEvent: (event) => events.push(event),
    executeTool: async () => {
      executions += 1;
      return "must not run";
    },
  });

  assert.equal(executions, 0);
  const interruptedResult = result.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result" && block.tool_use_id === "unsafe-call");
  assert.equal(interruptedResult.executionStatus, "interrupted");
  assert.equal(interruptedResult.is_error, true);
  assert.match(interruptedResult.content, /was not replayed/u);
  assert.match(interruptedResult.content, /captured output before interruption/u);
  assert.match(interruptedResult.content, /partial response already persisted/u);
  const decisionEvent = events.find((event) => event.type === "tool_replay_decision_required");
  assert.equal(decisionEvent.toolUseId, "unsafe-call");
  assert.equal(decisionEvent.requiresHostDecision, true);
  assert.equal(decisionEvent.partialOutputAvailable, true);
  const modelResult = provider.requests[0].messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result" && block.tool_use_id === "unsafe-call");
  assert.equal(modelResult.executionStatus, "interrupted");
  assert.match(modelResult.content, /captured output before interruption/u);
  assert.match(modelResult.content, /partial response already persisted/u);
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
    const tailIndex = requestMessages.findIndex((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => block?.text === "tail-after-fold")
    ));
    assert.notEqual(tailIndex, -1);
    assert.equal(
      requestMessages[tailIndex].content[0].text,
      "tail-after-fold",
    );
    assert.ok(requestMessages.findIndex((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => block.type === "tool_result")
    )) < requestMessages.length - 1);
    const transcriptMessages = (await store.load(`fold-${keepRounds}`))
      .flatMap((record) => record.messages ?? []);
    assert.doesNotMatch(
      JSON.stringify(transcriptMessages),
      /\[run state deterministic v/u,
    );
  }
});

test("keeps the initial input when request-view injection meets a tiny budget", async () => {
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstProvider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "reg-c1", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "reg-c2", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "reg-c3", name: "work", input: {} }],
      stopReason: "tool_use",
    },
  ]);
  let calls = 0;
  const strategy = {
    shouldCompact: () => true,
    compact: (messages, options) => createFoldStatisticalStrategy().compact(
      messages,
      { ...options, keepRounds: 0 },
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
      runId: "small-budget-run-state-regression",
      signal: controller.signal,
    }),
    /aborted|abort/i,
  );
  await store.appendRound("small-budget-run-state-regression", {
    round: 2,
    dedupKey: "small-budget-run-state-regression:input",
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
    runId: "small-budget-run-state-regression",
    executeTool: async () => "resumed-tool",
  });

  const requestMessages = resumedProvider.requests[0].messages;
  const serialized = JSON.stringify(requestMessages);
  assert.equal((serialized.match(/fold-base-input/g) ?? []).length, 1);
  assert.equal(
    requestMessages.filter((message) => (
      Array.isArray(message.content)
      && message.content.some((block) => block?.text === "tail-after-fold")
    )).length,
    1,
  );
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

test("resume with a store lacking snapshot/run-state loaders degrades with one diagnostic each (issue #78)", async () => {
  // 最小 store：必需两方法 + run-state/snapshot 写入方法，但缺所有 loader。
  // resume 想消费 loadRunState / loadLatestRunSnapshot 而不可得——必须各发一条
  // 单条去重诊断（不能静默降级），run 本身正常跑完。
  const stored = [{
    round: 0,
    ts: "2026-09-29T00:00:00.000Z",
    messages: [textMessage("seed")],
    summary: "missing",
    l0facts: { errors: 0 },
  }];
  const appended = [];
  const store = {
    appendRound: async (runId, record) => {
      appended.push(record);
    },
    load: async () => stored.map((record) => structuredClone(record)),
    markRunState: async () => {},
    saveRunState: async () => {},
    saveRunSnapshot: async () => {},
  };
  const events = [];
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "resume-tool", name: "work", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "resumed without loaders" }], stopReason: "end_turn" },
  ]);
  let executions = 0;

  const result = await runToolLoop({
    provider,
    store,
    runId: "resume-no-loaders",
    resume: true,
    initialUserMessage: "ignored on resume",
    executeTool: async () => {
      executions += 1;
      return "worked";
    },
    completion: false,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.finalText, "resumed without loaders");
  assert.equal(executions, 1);

  const degraded = events.filter((event) => event.type === "persistence_capability_degraded");
  const methods = degraded.map((event) => event.method);
  assert.equal(degraded.length, 2, `恰好两条诊断，实际：${methods.join(",")}`);
  assert.ok(methods.includes("loadRunState"), "缺 loadRunState 必须诊断");
  assert.ok(methods.includes("loadLatestRunSnapshot"), "缺 loadLatestRunSnapshot 必须诊断");
  for (const event of degraded) {
    assert.equal(event.runId, "resume-no-loaders");
    assert.match(event.detail, new RegExp(event.method));
  }
});

test("resume with a stale snapshot (loader present, round behind transcript) does not emit capability diagnostics (issue #78)", async () => {
  // 回归锁定：loader 存在但返回过round落后的快照时，走 loader 路径（而非缺失 else 分支），
  // 静默丢弃过期现场是正常语义——绝不得误发 persistence_capability_degraded。
  const stored = [
    {
      round: 0,
      ts: "2026-09-29T00:00:00.000Z",
      messages: [textMessage("seed")],
      summary: "missing",
      l0facts: { errors: 0 },
    },
    {
      round: 1,
      ts: "2026-09-29T00:01:00.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "earlier" }] }],
      summary: "missing",
      l0facts: { errors: 0 },
    },
  ];
  let snapshotCalls = 0;
  const store = {
    appendRound: async () => {},
    load: async () => stored.map((record) => structuredClone(record)),
    markRunState: async () => {},
    saveRunState: async () => {},
    loadRunState: async () => undefined,
    // loader 存在但快照 round 落后（transcript 已到 round 1，快照还在 round 0）
    loadLatestRunSnapshot: async () => {
      snapshotCalls += 1;
      return { round: 0, status: "executed", messages: [textMessage("seed")] };
    },
  };
  const events = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "continued past stale snapshot" }], stopReason: "end_turn" },
  ]);

  const result = await runToolLoop({
    provider,
    store,
    runId: "resume-stale-snapshot",
    resume: true,
    initialUserMessage: "ignored on resume",
    executeTool: async () => "unused",
    completion: false,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.finalText, "continued past stale snapshot");
  assert.equal(snapshotCalls, 1, "loader 必须被调用（走 loader 路径，不是缺失 else 分支）");
  const degraded = events.filter((event) => event.type === "persistence_capability_degraded");
  assert.deepEqual(
    degraded.map((event) => event.method),
    [],
    `loader 存在时不得误发能力降级诊断，实际：${degraded.map((event) => event.method).join(",")}`,
  );
});
