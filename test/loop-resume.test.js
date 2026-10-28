import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { renderConversation } from "../src/reflection/judge.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createDeterministicRunState } from "../src/run-state.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

/** issue #439 A：`load()` 的折叠结果给每条逻辑消息带了行级 `ts`（落盘时刻，宿主时间线），
 * 内存里的消息没有——比较「档案 = 完整正文」时剥掉信封字段，**逐字比正文**。
 * 不静默放宽：调用点另有一句断言档案侧**真的**带 `ts`（否则这条剥字段就成了白名单）。 */
const withoutJournalTs = (messages) => messages.map(({ ts, ...message }) => message);

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
  // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役 ⇒ 取值校验走规位 `config.run.replayPolicy`。
  // 仍写扁平的话，这一格撞的是名称闸口（`unknown runToolLoop option`），取值校验就没人测了。
  await assert.rejects(
    runToolLoop({ ...options, config: { run: { replayPolicy: "sometimes" } } }),
    /replayPolicy must be "always-replay" or "per-tool-declaration"/u,
  );
  for (const partialPersistence of [
    null,
    true,
    [],
    {},
    { intervalMs: 0 },
    { intervalMs: -1 },
    { intervalMs: 1.5 },
    { intervalMs: Number.POSITIVE_INFINITY },
    { intervalMs: 10, minBytes: -1 },
    { intervalMs: 10, minBytes: 1.5 },
  ]) {
    await assert.rejects(
      runToolLoop({ ...options, config: { run: { partialPersistence } } }),
      TypeError,
    );
  }
});

test("partial persistence requires streaming mode", async () => {
  const options = {
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    executeTool: async () => "unused",
    completion: false,
    config: { run: { partialPersistence: { intervalMs: 10 } } },
  };

  for (const streamOption of [{}, { stream: false }]) {
    await assert.rejects(
      runToolLoop({ ...options, ...streamOption }),
      {
        name: "TypeError",
        message: "partialPersistence requires stream: true",
      },
    );
  }

  const result = await runToolLoop({ ...options, stream: true });
  assert.equal(result.finalText, "done");
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

  const firstResult = await runDirect({
    provider: firstProvider,
    initialUserMessage: "start",
    executeTool: async ({ input }) => `completed-${input.step}`,
    maxRounds: 3,
    completion: false,
    // #498 S3 (`input` slice A): the flat spelling retired; the home is config.input.*.
    config: { input: { cacheStablePrefix: false } },
    store,
    runId: "resume-run",
  });
  const beforeResume = await store.load("resume-run");
  const storedMessages = beforeResume.flatMap((record) => record.messages);

  assert.equal(firstResult.rounds, 3);
  // 种子记录后档案 = 完整消息。issue #439 A：**被折叠**的每条逻辑消息多一个行级 `ts`（落盘时刻），
  // 内存里的消息没有 —— 剥信封字段后**正文逐字相等**。轮行自带的正文（round 0 种子行）不是折叠
  // 产物，没有这个字段；这里只要求「从消息行折回来的那部分」带 `ts`。
  // 轮 0 是 `:seed` 控制行（轮行自带正文，不是折叠产物），不带逐条 `ts`；其余各轮**每条**都必须带。
  const foldedMessages = beforeResume
    .filter((record) => (record.round ?? 0) !== 0)
    .flatMap((record) => record.messages ?? []);
  assert.ok(foldedMessages.length > 0, "前置：这次 run 必须有从消息行折回来的正文（否则下一条判据空转）");
  assert.ok(foldedMessages.every((message) => typeof message.ts === "string"),
    "折叠后的**每条**逻辑消息都必须带 `ts`（#439）");
  assert.deepEqual(firstResult.messages, withoutJournalTs(storedMessages));
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
  const resumedResult = await runDirect({
    provider: resumedProvider,
    initialUserMessage: "must be ignored",
    // #498 S3 (`input` slice A): `messages` is the leaf alias of the retired flat `initialMessages`.
    config: { input: { messages: [{ role: "user", content: "must also be ignored" }], cacheStablePrefix: false } },
    executeTool: async () => "unused",
    maxRounds: 4,
    completion: false,
    store,
    runId: "resume-run",
    resume: true,
  });

  assert.equal(resumedProvider.requests.length, 1);
  // issue #404（工单 BB）：恢复运行会在**上下文之后、第一次请求之前**注入一条「复活赛告示」。
  // 断言强度不降：除最后那一条告示之外，请求正文与崩溃那一刻的账本**逐字一致**。
  const notice = resumedProvider.requests[0].messages.at(-1);
  assert.match(JSON.stringify(notice), /【恢复运行】/u,
    `恢复的第一次请求末尾必须是那条告示，实测 ${JSON.stringify(notice).slice(0, 120)}`);
  // #439 A：恢复上下文用的是**规范化消息**（不含档案信封的逐条 `ts`，见
  // `src/store/message-rows.js#foldLedgerMessages`），所以这里剥掉它再逐字比。
  assert.deepEqual(resumedProvider.requests[0].messages.slice(0, -1), withoutJournalTs(storedMessages));
  assert.equal(resumedResult.rounds, 4);
  assert.equal(resumedResult.finalText, "round four");
  assert.deepEqual(
    (await store.load("resume-run")).map((record) => record.round),
    // 末位那条 round 3 的 `:control:resume-notice` 行是 #404 的告示（`round` 取恢复时的身份轮号）。
    [0, 1, 2, 3, 3, 4],
  );
  assert.deepEqual(resumedResult.messages, [
    ...withoutJournalTs(storedMessages),
    notice,
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
    runDirect({
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
    capabilities: {
      hooks: {
        onEvent: (event) => resumedEvents.push(event),
      },
    },
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
  // issue #404：最后一条是恢复告示，补跑出来的那条聚合结果紧排在它前面（位置与强度都不降）。
  assert.match(JSON.stringify(resumedProvider.requests[0].messages.at(-1)), /【恢复运行】/u);
  assert.deepEqual(
    resumedProvider.requests[0].messages.at(-2).content.map((block) => block.tool_use_id),
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
    // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役，规位是 `config.run.replayPolicy`。
    config: { run: { replayPolicy: "per-tool-declaration" } },
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
    // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役，规位是 `config.run.replayPolicy`。
    config: { run: { replayPolicy: "per-tool-declaration" } },
    tools: [{
      name: "unsafe_work",
      inputSchema: { type: "object" },
      replay: "unsafe",
    }],
    store,
    runId,
    capabilities: {
      hooks: {
        onEvent: (event) => events.push(event),
      },
    },
    executeTool: async () => {
      executions += 1;
      return "must not run";
    },
  });

  assert.equal(executions, 0);
  const interruptedResult = result.messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result" && block.tool_use_id === "unsafe-call");
  // 执行状态只住在 `erix.executionStatus`（工单 261014 T2 停写了顶层旧同名键）。
  assert.equal(interruptedResult.erix.executionStatus, "interrupted");
  assert.equal(Object.hasOwn(interruptedResult, "executionStatus"), false, "顶层旧键已退役");
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
  assert.equal(modelResult.erix.executionStatus, "interrupted");
  assert.equal(Object.hasOwn(modelResult, "executionStatus"), false, "递给模型的那一份同样不再有顶层旧键");
  assert.match(modelResult.content, /captured output before interruption/u);
  assert.match(modelResult.content, /partial response already persisted/u);
});

test("升级前记录被中断重放时，不得把过期 attempt 的成败留给 judge 的回退链（PR #288 审阅）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "resume-legacy-keys";
  const toolUse = { type: "tool_use", id: "legacy-call", name: "unsafe_work", input: {} };
  await store.appendRound(runId, { round: 0, messages: [textMessage("resume carefully")] });
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
          tool_use_id: "legacy-call",
          content: "partial from the lost attempt",
          // 升级前落盘的形状：顶层既有引擎旧同名键，也有宿主摊平键。
          erixRound: 0,
          executionStatus: "ok",
          success: true,
          duration: 900,
          artifactStatus: "done",
        }],
      },
    ],
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [],
  });

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    resume: true,
    completion: false,
    // #498 S3（`run` 片 A11）：扁平 `replayPolicy` 已退役，规位是 `config.run.replayPolicy`。
    config: { run: { replayPolicy: "per-tool-declaration" } },
    tools: [{ name: "unsafe_work", inputSchema: { type: "object" }, replay: "unsafe" }],
    store,
    runId,
    executeTool: async () => "must not run",
  });

  const forBlock = (messages) => messages
    .flatMap((message) => message.content ?? [])
    .find((block) => block.type === "tool_result" && block.tool_use_id === "legacy-call");
  for (const [label, messages] of [["落盘侧", result.messages], ["递给模型", provider.requests[0].messages]]) {
    const block = forBlock(messages);
    assert.equal(block.erix.executionStatus, "interrupted", `${label}：新事实住在 erix`);
    assert.equal(Object.hasOwn(block.erix, "success"), false, `${label}：中断不编造成败`);
    for (const retired of ["executionStatus", "success", "duration"]) {
      assert.equal(Object.hasOwn(block, retired), false, `${label}：过期 attempt 的顶层 ${retired} 必须被扫掉`);
    }
    // 钉住真正的危害点：judge.js:128 / l0.js:50,68 就是这个表达式——它必须是 undefined（未知），
    // 而不是回退出上一次 attempt 的 true。
    assert.equal(block.erix?.success ?? block.success, undefined, `${label}：judge 的成败回退链不得拿到过期值`);
    // 但创建轮不能跟着扫：readRoundMarker 在 erix.round 缺席时正是回退到它算年龄的。
    assert.equal(block.erixRound, 0, `${label}：erixRound 是 TTL 的年龄来源，扫掉=这条记录永不折叠`);
    assert.equal(block.artifactStatus, "done", `${label}：宿主摊平键不承载引擎事实，不由引擎代扫`);
  }
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
  // 引擎事实在 `erix.*`（工单 261014 T2）：本例测的是「合并不丢文本、配对不破坏」，
  // 逐字段的存在性矩阵见 test/contract/tool-result-envelope.js。
  // T1 留的缺口：旧版只对账**键名**（`__erixKeys`），于是 `erix` 里装错值也看不出来；
  // 下面在保留整块对账的同时，对 `erix` 的**值**也断言（身份键沿用、轮号与耗时不重算）。
  const replayedErix = toolResultMessage.content
    .find((block) => block.type === "tool_result" && block.tool_use_id === "b")?.erix;
  const mergedBlocks = toolResultMessage.content.map((block) => {
    const { erix, ...rest } = block;
    return { ...rest, ...(erix === undefined ? {} : { __erixKeys: Object.keys(erix).sort() }) };
  });
  assert.deepEqual(mergedBlocks, [
    { type: "tool_result", tool_use_id: "a", content: "done-a" },
    { type: "text", text: "keep this text" },
    {
      type: "tool_result",
      tool_use_id: "b",
      content: "done-b",
      // 年龄标记只住 erix.round（顶层 erixRound 已退役），且不再多一个顶层摊平键。
      __erixKeys: ["durationMs", "round", "success", "toolCallKey"],
    },
  ]);
  // 值对账（而不是只看键名）：`b` 是续跑本轮**真的执行了**的那一个，所以四个事实都要真对得上值。
  assert.equal(replayedErix.round, 1, "erix.round 是执行轮（续跑从 checkpoint 的 round 1 继续）");
  assert.equal(typeof replayedErix.durationMs, "number");
  assert.ok(Number.isFinite(replayedErix.durationMs) && replayedErix.durationMs >= 0,
    `耗时必须是个可解释的非负数，实测 ${replayedErix.durationMs}`);
  assert.match(replayedErix.toolCallKey, /^tc_[0-9a-f]{12}$/u, "身份键沿用同一次调用的值");
  assert.equal(replayedErix.success, true, "executor 没声明成败时一律写下归一化后的 true");
  // 宿主自己写下的 checkpoint 里那两条 `tool_use` 没有身份键（本例是手摆的崩溃现场），
  // 所以这里只钉结果侧的 key 形状；跨通道同值那件事由 test/contract/tool-result-envelope.js 负责。
  assert.equal(new Set([replayedErix.toolCallKey]).size, 1);
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

  // issue #404：恢复告示排在方向提示之后（提示仍是「宿主/引擎最后一句」之前的那一条）。
  assert.deepEqual(
    provider.requests[0].messages.slice(-4).map((message) => message.role),
    ["assistant", "user", "user", "user"],
  );
  assert.deepEqual(
    provider.requests[0].messages.at(-3).content.map((block) => block.tool_use_id),
    ["a", "b"],
  );
  assert.match(provider.requests[0].messages.at(-2).content[0].text, /附方向提示/);
  assert.match(provider.requests[0].messages.at(-1).content[0].text, /【恢复运行】/);
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
    capabilities: {
      hooks: {
        onJudge: (info) => audited.push(info.tool?.id),
      },
    },
  });

  assert.deepEqual(audited, ["b"]);
  assert.equal(judge.requests.length, 1);
});

test("resume rejects an empty transcript", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([]);

  await assert.rejects(
    runDirect({
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
      runDirect({ capabilities: { ports: { strategy: strategy } },
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
        config: { folding: { context: { budgetTokens: 30 } } },
        store,
        runId: `fold-${keepRounds}`,
        signal: controller.signal,
      }),
      /aborted|abort/i,
    );

    const checkpoint = await store.loadLatestCheckpoint(`fold-${keepRounds}`);
    // 锁点 = 崩溃那一刻账本里已落盘的**逻辑消息数**（分片不加）。工单 261021 写侧之后，
    // 崩溃轮（round 3）的 assistant 正文已「一成型就落盘」，所以下标比改造前多 1：
    // 1（种子行）+ 2（round 1）+ 2（round 2）+ **1（round 3 已落盘的 assistant）**= 6。
    // 这一条不是可以动的装饰：少 1 就是把崩溃轮那条带 pending tool_use 的 assistant 切进
    // 尾队列，补跑结果将找不到对应的 tool_use（`validateMessages` 当场 invalid_messages）。
    // ⚠ issue #425 注记（上面这段原文保留）：这句断言的**对象**是**写侧增量账**
    // （`persistedTranscriptLength`）——写侧自增点一字未动，6 仍然正确；但上面描述的那个**失效模式**
    // 已由恢复侧**现算**接管：恢复不再读这个采样值，锚点由 `countResumeAnchor(records)`
    // 在账本上现算（`src/loop/resume-manager.js`）。所以「少 1 ⇒ 切进尾队列」不再随这个数字发生，
    // 数字与恢复正确性已经解耦：改它是改写侧口径，不会把崩溃轮 assistant 挤进尾队列。
    assert.equal(checkpoint.persistedTranscriptLength, 6);
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
    runDirect({ capabilities: { ports: { strategy: strategy } },
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
      config: { folding: { context: { budgetTokens: 30 } } },
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
    runDirect({
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
  const first = await runDirect({
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
  // issue #326（B1）多出的那一条 round=2 是引擎的**强制收尾补充记录**（指令 + 终稿 assistant）：
  // 它产生时 round 2 的轮记录早已落盘，不当场补一笔就永远不会进档案。
  // 顺序：引擎轮记录 → 收尾补充记录（同轮号，独立 dedupKey）→ 宿主追问行 → 续接轮。
  // issue #404：多出的那条 round 2 是**恢复告示**（`…:control:resume-notice:<fp>`，轮号取恢复时的
  // 身份轮号），它与下面第 6 条那条「收尾补充记录」同一个先例：宿主看到行数多于轮数。
  assert.deepEqual(records.map((record) => record.round), [0, 1, 2, 2, 2, 2, 3, 4]);
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
  const result = await runDirect({
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

  const result = await runDirect({
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
    capabilities: {
      hooks: {
        onEvent: (event) => events.push(event),
      },
    },
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

  const result = await runDirect({
    provider,
    store,
    runId: "resume-stale-snapshot",
    resume: true,
    initialUserMessage: "ignored on resume",
    executeTool: async () => "unused",
    completion: false,
    capabilities: {
      hooks: {
        onEvent: (event) => events.push(event),
      },
    },
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

test("#323 强制收尾指令对主模型可见、但不进 judge 输入（renderConversation 产物）", async () => {
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "ff-1", name: "work", input: { step: 1 } }],
      stopReason: "tool_use",
    },
    {
      content: [{ type: "tool_use", id: "ff-2", name: "work", input: { step: 2 } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "forced-final-draft" }], stopReason: "end_turn" },
  ]);

  const result = await runDirect({
    provider,
    initialUserMessage: "cap this run",
    executeTool: async () => "ok",
    maxRounds: 2,
    completion: false,
  });

  assert.equal(result.termination.reason, "max_rounds_cap");
  // 主模型侧仍可见：强制收尾那次真实模型请求里，最后一条 user 就是【强制收尾】指令原文。
  const forcedRequest = provider.requests.at(-1);
  const instruction = forcedRequest.messages.at(-1);
  assert.match(instruction.content[0].text, /【强制收尾】/);
  assert.ok(
    result.messages.some((message) => JSON.stringify(message).includes("【强制收尾】")),
    "指令必须留在主消息链（主模型/宿主可见），只是不进 judge 输入",
  );
  // 真实 judge 输入口径（renderConversation 产物）不得出现该控制文本原文。
  const rendered = renderConversation(result.messages);
  assert.ok(
    !rendered.includes("【强制收尾】"),
    "judge 输入不得含强制收尾指令（摘掉 meta.source marker 本断言必须变红）",
  );
  assert.equal(instruction.meta?.source, "judge-control");
});

// —— issue #353：resume 后 governor 的 `timeline` / `filesWritten` 是否从账本重建 ——
//
// 宿主报的是「0.23 的轮记录不再写 `messages`，而 `resume-manager.js` 仍取 `record.messages` ⇒
// resume 后治理历史是空的」。实测判据不成立：`store.load()` 在返回前把 `kind:"message"` 行折回轮行
// （`src/store/message-rows.js#foldMessageRows`，memory/file 两个 store 同一层），`resume-manager`
// 拿到的正是 `await ctx.store.load(runId)` 的返回值 ⇒ `record.messages` 非空。
//
// 本用例把两个**必须分清**的概念分别钉住（宿主正是把前者当成了后者）：
//   · 「落盘行形状」：轮载体行（`…:engine:round:<n>`）**没有** `messages` 键 —— 0.23 写侧口径；
//   · 「load() 之后的形状」：同一个轮行带上本轮全部正文（含 `tool_use` / `tool_result`），与 0.22 同形。
// 反向对照（实测，2026-10 夜班工单 B 探针）：把折叠层摘掉、直接拿落盘行当记录喂 resume，
// 时间线不会变空，但工具状态会从 `[ok]` 掉成 `[pending]`（`tool_result` 与 `tool_use` 落在不同行，
// 配不上对）—— 所以下面钉 `[ok]` 才是「折叠真的生效」的判据，不是「非空」。
const GOVERNED_WRITE_PATH = "/tmp/issue-353/governed.txt";

const WRITE_FILE_TOOL = {
  name: "writeFile",
  description: "write a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
};

const promptTextOf = (provider) => provider.requests
  .map((request) => (request.messages ?? []).map((message) => (
    Array.isArray(message?.content)
      ? message.content.map((block) => block?.text ?? "").join("")
      : String(message?.content ?? "")
  )).join("\n"))
  .join("\n");

/**
 * 跑两轮（第 1 轮含一次写类工具调用）再在同一 store/runId 上 resume，返回观测面。
 * @param {string} runId
 * @param {{ withRunState: boolean }} options `withRunState:false` 把 run-state 独立通道切断，
 *   只剩「从账本重建」一条路（#353 诉求①的判决只需要这一条）。
 */
async function runTwoRoundsThenResume(runId, { withRunState }) {
  const store = createMemoryTranscriptStore();
  const rawRows = [];
  const appendRound = store.appendRound.bind(store);
  store.appendRound = async (id, record) => {
    rawRows.push(structuredClone(record));
    return appendRound(id, record);
  };
  if (!withRunState) store.loadRunState = async () => undefined;

  await runDirect({
    provider: createFakeProvider([
      {
        content: [
          { type: "text", text: "先写文件" },
          { type: "tool_use", id: "w1", name: "writeFile", input: { path: GOVERNED_WRITE_PATH, content: "x" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "任务：写一个文件然后收尾",
    executeTool: async ({ input }) => `wrote ${input?.path ?? ""}`,
    tools: [WRITE_FILE_TOOL],
    maxRounds: 4,
    completion: false,
    wrapup: false,
    reflection: false,
    store,
    runId,
  });

  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "续接完成" }], stopReason: "end_turn", times: 3 },
  ]);
  const resumedJudge = createFakeProvider([
    {
      content: [{
        type: "text",
        text: JSON.stringify({
          done: false, confidence: 0.5, reason: "继续", evidence: "有工具足迹",
          direction: "on_track", directionReason: "推进中",
        }),
      }],
      times: 3,
    },
  ]);
  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    executeTool: async () => "unused",
    tools: [WRITE_FILE_TOOL],
    maxRounds: 2,
    completion: false,
    wrapup: false,
    reflection: { enabled: true, judge: { provider: resumedJudge } },
    store,
    runId,
  });

  return { rawRows, records: await store.load(runId), judgePrompt: promptTextOf(resumedJudge) };
}

const roundRowOf = (rows, round) => rows.find((row) => (
  (row.dedupKey ?? row.roundKey ?? "").endsWith(`:engine:round:${String(round)}`)
));

for (const withRunState of [true, false]) {
  const channel = withRunState ? "run-state 在场" : "run-state 切断（只剩账本一条路）";
  test(`#353 resume 从折叠后的账本重建 timeline / filesWritten（${channel}）`, async () => {
    const { rawRows, records, judgePrompt } = await runTwoRoundsThenResume(
      `issue-353-resume-governance-${withRunState ? "with" : "without"}-run-state`,
      { withRunState },
    );

    // ① 落盘行形状：轮载体行不带 `messages`（宿主观察到的就是这个，0.23 写侧口径）
    const rawRoundRow = roundRowOf(rawRows, 1);
    assert.ok(rawRoundRow !== undefined, "第一轮必须有轮载体行");
    assert.equal(
      Object.prototype.hasOwnProperty.call(rawRoundRow, "messages"),
      false,
      "0.23 写侧：轮记录只留元数据，正文在 `…:msg:<round>:<seq>` 行里",
    );
    assert.ok(rawRows.some((row) => row.kind === "message" && row.round === 1),
      "正文由 `kind:\"message\"` 行承载");

    // ② load() 之后的形状：同一个轮行被折回本轮全部正文（含 tool_use 与配对上的 tool_result）
    const loadedRoundRow = roundRowOf(records, 1);
    assert.ok(loadedRoundRow !== undefined, "load() 之后仍按轮行读");
    const loadedBlocks = (loadedRoundRow.messages ?? []).flatMap((message) => (
      Array.isArray(message?.content) ? message.content : []
    ));
    assert.equal((loadedRoundRow.messages ?? []).length, 2,
      "折叠层把本轮两条消息行拼回轮行（assistant + tool_result 那条 user）");
    assert.ok(loadedBlocks.some((block) => block?.type === "tool_use" && block.name === "writeFile"));
    assert.ok(loadedBlocks.some((block) => block?.type === "tool_result"),
      "`tool_result` 也必须在折叠后的正文里（否则时间线状态只能到 [pending]）");

    // ③ 治理历史：resume 侧 judge 提示词的「时间线」与「写过的文件」两节
    assert.ok(judgePrompt.length > 0, "resume 必须真的请求过 judge");
    const timelineSection = judgePrompt.slice(
      judgePrompt.indexOf("时间线（最新在前）"),
      judgePrompt.indexOf("写过的文件"),
    );
    assert.ok(
      timelineSection.includes(`R1: writeFile ${GOVERNED_WRITE_PATH} [ok]`),
      `崩溃前那轮的工具足迹必须重建出来（状态 [ok] 说明 tool_result 也折回了）；实测：${timelineSection}`,
    );
    assert.equal((timelineSection.match(/R1: writeFile/gu) ?? []).length, 1,
      "每轮只能有一条时间线条目（折叠前按消息行逐行重建会给同一轮重复条目）");
    assert.ok(
      judgePrompt.includes(`写过的文件：${GOVERNED_WRITE_PATH}(R1)`),
      "写过的文件必须带轮号 R1 ⇒ 来自账本重建（run-state 那条通道只有路径、没有轮号）",
    );

    // ④ Q3：轮行 `summary` 恒为字符串 `"missing"` 是 `parseL1Summary` 的既定兜底
    // （模型没发 `<erix-summary>` 标记 ⇒ l0.js 的缺省值），不是引擎漏写字段。
    assert.equal(loadedRoundRow.summary, "missing",
      "summary 字段存在且取 L1 兜底字面值（不是 undefined / 缺键）");
  });
}
