// ADR-015 Phase 1：引擎标配 recall 工具（转录即档案、recall 即通道）
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

test("recall defaults to registered when store+runId present (provider sees the schema)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    store: createMemoryTranscriptStore(),
    runId: "run-recall-1",
  });
  const schema = provider.requests[0].tools?.find((tool) => tool.name === "recall");
  assert.ok(schema, "recall schema should be appended to provider tools");
  assert.equal(schema.inputSchema?.properties?.pattern?.type, "string");
});

test("no store or no runId → recall not registered (no silent promise)", async () => {
  for (const broken of [
    { store: undefined, runId: "run-x" },
    { store: createMemoryTranscriptStore(), runId: undefined },
  ]) {
    const provider = createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    await runToolLoop({
      provider,
      initialUserMessage: "hello",
      executeTool: async () => "unused",
      ...broken,
    });
    assert.equal(
      provider.requests[0].tools?.some((tool) => tool.name === "recall"),
      false,
      JSON.stringify(broken),
    );
  }
});

test("recall: false opts out explicitly", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    store: createMemoryTranscriptStore(),
    runId: "run-recall-2",
    recall: false,
  });
  assert.equal(provider.requests[0].tools?.some((tool) => tool.name === "recall"), false);
});

test("recall: true without capability is a loud TypeError (撕票不静默)", async () => {
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialUserMessage: "x",
      executeTool: async () => "unused",
      recall: true,
    }),
    /recall: true requires/,
  );
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialUserMessage: "x",
      executeTool: async () => "unused",
      recall: true,
      runId: "run-x",
      // store 缺 load()
      store: { appendRound: async () => {} },
    }),
    /recall: true requires/,
  );
});

test("recall: non-boolean is rejected by strict options", async () => {
  await assert.rejects(
    runToolLoop({
      provider: createFakeProvider([]),
      initialUserMessage: "x",
      executeTool: async () => "unused",
      recall: "yes",
    }),
    /recall must be a boolean/,
  );
});

test("engine serves recall calls itself; host executeTool never sees them", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("run-recall-3", {
    round: 1,
    ts: "2026-09-16T00:00:00.000Z",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "UNIQUE_MARKER_ADR015 alpha beta" }],
    }],
  });
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "recall",
        input: { pattern: "UNIQUE_MARKER_ADR015" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "found" }], stopReason: "end_turn" },
  ]);
  const hostCalls = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "find marker",
    executeTool: async (options) => {
      hostCalls.push(options.name);
      return "host-result";
    },
    store,
    runId: "run-recall-3",
    completion: false,
  });
  assert.deepEqual(hostCalls, [], "host executeTool must not receive recall calls");
  const recallResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.match(String(recallResult?.content), /UNIQUE_MARKER_ADR015/);
  assert.equal(result.finalText, "found");
});

test("host-provided recall tool wins: no duplicate schema, host serves the call", async () => {
  const provider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "call-h",
        name: "recall",
        input: { pattern: "x" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const hostCalls = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "hello",
    tools: [{
      name: "recall",
      description: "host-owned recall",
      inputSchema: { type: "object", properties: {} },
    }],
    executeTool: async (options) => {
      hostCalls.push(options.name);
      return "host-recall-result";
    },
    store: createMemoryTranscriptStore(),
    runId: "run-recall-4",
    completion: false,
  });
  const recallSchemas = provider.requests[0].tools
    ?.filter((tool) => tool.name === "recall");
  assert.equal(recallSchemas?.length, 1, "no duplicate registration");
  assert.equal(recallSchemas?.[0]?.description, "host-owned recall");
  assert.deepEqual(hostCalls, ["recall"]);
  const toolResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-h");
  assert.equal(toolResult?.content, "host-recall-result");
});
