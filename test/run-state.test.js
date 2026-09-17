import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicRunState,
  renderRunState,
  RUN_STATE_MAX_SERIALIZED_BYTES,
  upsertRunStateInMessages,
  validateRunState,
  withSemanticRunState,
} from "../src/run-state.js";
import { runToolLoop } from "../src/loop.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("run state is bounded, marked when truncated, and does not expose credentials", () => {
  const state = createDeterministicRunState({
    runId: "bounded",
    stateVersion: 3,
    rounds: 12,
    maxRounds: 20,
    toolStats: new Map(
      Array.from({ length: 20 }, (_unused, index) => [`tool-${index}`, { calls: 4, failures: 1 }]),
    ),
    filesWritten: Array.from({ length: 20 }, (_unused, index) => `/tmp/file-${index}.js`),
    foldedRounds: 8,
    navigationRecords: 3,
  });
  const withSemantic = withSemanticRunState(state, {
    text: "Bearer sk-secret-value-123456789",
    version: 3,
  });
  const rendered = renderRunState(withSemantic);

  assert.ok(rendered.length <= 400);
  assert.match(rendered, /\[run state truncated\]/u);
  assert.doesNotMatch(rendered, /sk-secret|Bearer/u);
});

test("persisted run state is bounded, marked, and redacts semantic credentials", () => {
  const state = withSemanticRunState(createDeterministicRunState({
    runId: "persisted-bounds",
    toolStats: new Map(
      Array.from({ length: 100_000 }, (_unused, index) => [
        `tool-${index}-${"x".repeat(200)}`,
        { calls: 1, failures: 0 },
      ]),
    ),
    filesWritten: Array.from({ length: 1_000 }, (_unused, index) => `/tmp/file-${index}`),
    todo: {
      status: "working",
      items: Array.from({ length: 1_000 }, (_unused, index) => ({
        id: `todo-${index}-${"x".repeat(100)}`,
        status: "pending",
      })),
    },
  }), {
    text: "token=secret-value-should-not-persist",
    version: 0,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= RUN_STATE_MAX_SERIALIZED_BYTES);
  assert.equal(state.bounds.truncated, true);
  assert.ok(state.bounds.omittedTools > 0);
  assert.doesNotMatch(JSON.stringify(state), /secret-value-should-not-persist/u);
  assert.equal(validateRunState(state).ok, true);
});

test("unknown and incomplete run state are explicitly unavailable", () => {
  assert.deepEqual(validateRunState({ schemaVersion: 99 }), {
    ok: false,
    status: "state_unavailable",
    reason: "unknown_schema",
  });
  assert.deepEqual(validateRunState({ schemaVersion: 1, runId: "missing" }), {
    ok: false,
    status: "state_unavailable",
    reason: "missing_fields",
  });
});

test("resume exposes unknown persisted schema instead of silently resetting it", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("unknown-schema", {
    round: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "resume" }] }],
  });
  store.loadRunState = async () => ({ schemaVersion: 99, deterministic: {} });

  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "ignored on resume",
    executeTool: async () => "unused",
    maxRounds: 1,
    completion: false,
    store,
    runId: "unknown-schema",
    resume: true,
  });

  assert.equal(result.runState.stateAvailability.status, "state_unavailable");
  assert.equal(result.runState.stateAvailability.reason, "unknown_schema");
});

test("run state replacement is idempotent across repeated folds", () => {
  const oldState = renderRunState(createDeterministicRunState({
    runId: "replace",
    stateVersion: 1,
    rounds: 4,
    maxRounds: 8,
  }));
  const newState = renderRunState(createDeterministicRunState({
    runId: "replace",
    stateVersion: 2,
    rounds: 7,
    maxRounds: 8,
  }));
  const original = [{
    role: "user",
    content: [{ type: "text", text: `【上下文折叠】历史摘要\n${oldState}` }],
  }];
  const once = upsertRunStateInMessages(original, newState);
  const twice = upsertRunStateInMessages(once, newState);
  const text = twice[0].content[0].text;

  assert.equal((text.match(/\[run state deterministic v1\]/gu) ?? []).length, 1);
  assert.match(text, /run=replace v=2 r=7\/8/u);
  assert.doesNotMatch(text, /run=replace v=1/u);
  assert.deepEqual(twice, once);
});

test("run state records tool facts, files, budget prompts, todo status, and persists", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "write-1", name: "writeFile", input: { path: "src/new.js" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "write a file",
    executeTool: async () => ({ success: true, data: "written" }),
    maxRounds: 2,
    completion: false,
    store,
    runId: "facts",
    todoStateProvider: () => ({
      items: [{ id: "task-1", status: "done" }],
    }),
  });
  const state = result.runState;

  assert.equal(state.deterministic.budget.rounds, 2);
  assert.equal(state.deterministic.budget.remainingRounds, 0);
  assert.equal(state.deterministic.budget.lowBudgetPrompted, true);
  assert.deepEqual(state.deterministic.tools, [{
    name: "writeFile",
    calls: 1,
    failures: 0,
  }]);
  assert.deepEqual(state.deterministic.filesWritten, ["src/new.js"]);
  assert.deepEqual(state.deterministic.todo.items, [{ id: "task-1", status: "done" }]);
  assert.equal((await store.loadRunState("facts")).stateVersion, state.stateVersion);
});

test("resume keeps one persisted run-state block", async () => {
  const store = createMemoryTranscriptStore();
  const strategy = {
    shouldCompact: (messages) => messages.length > 1,
    compact: (messages, options) => createFoldStatisticalStrategy().compact(
      messages,
      { ...options, keepRounds: 0 },
    ),
  };
  await runToolLoop({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "fold-tool", name: "work", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "first" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "fold this",
    executeTool: async () => "result",
    maxRounds: 2,
    completion: false,
    context: { strategy, budgetTokens: 100 },
    store,
    runId: "resume-state",
  });

  const resumed = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "resumed" }], stopReason: "end_turn" },
    ]),
    executeTool: async () => "unused",
    maxRounds: 3,
    completion: false,
    context: { strategy, budgetTokens: 100 },
    store,
    runId: "resume-state",
    resume: true,
  });
  const text = resumed.messages
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  assert.equal((text.match(/\[run state deterministic v1\]/gu) ?? []).length, 1);
  assert.equal((await store.loadRunState("resume-state")).stateVersion, resumed.runState.stateVersion);
});

test("semantic state with an old version is explicitly stale", () => {
  const state = createDeterministicRunState({ stateVersion: 2 });
  const stale = renderRunState(withSemanticRunState(state, {
    text: "old derived note",
    version: 1,
  }));
  assert.match(stale, /status=stale version=1/u);
});
