// ADR-015 Phase 2：输出卫生进引擎（超限全量入档 + stub + recall 取回）
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";

const BIG_TAIL = "UNIQUE_TAIL_MARKER_ADR015_尾部证据";
function bigOutput() {
  const lines = [];
  for (let index = 0; index < 600; index += 1) lines.push(`line-${index}: fillertext`);
  lines.push(BIG_TAIL);
  return lines.join("\n");
}

test("oversized tool result: context gets stub, record keeps full content, recall retrieves it", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "big", input: {} }],
      stopReason: "tool_use",
    },
    {
      content: [{
        type: "tool_use",
        id: "call-2",
        name: "recall",
        input: { pattern: "UNIQUE_TAIL_MARKER_ADR015" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const hostCalls = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "run big tool",
    executeTool: async (options) => {
      hostCalls.push(options.name);
      return options.name === "big" ? bigOutput() : "unused";
    },
    store,
    runId: "hygiene-1",
    completion: false,
  });

  // 1. 上下文视图 = stub，不含尾部原文
  const stubResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.match(String(stubResult?.content), /完整输出已由引擎归档/);
  assert.match(String(stubResult?.content), /recall\(\{ round: 1/);
  assert.doesNotMatch(String(stubResult?.content), new RegExp(BIG_TAIL));

  // 2. round record 带全量 toolOutputs（字节保真：尾部证据在档）
  const records = await store.load("hygiene-1");
  const round1 = records.find((record) => record.round === 1);
  assert.ok(Array.isArray(round1?.toolOutputs) && round1.toolOutputs.length === 1);
  assert.equal(round1.toolOutputs[0].toolUseId, "call-1");
  assert.equal(round1.toolOutputs[0].name, "big");
  assert.match(round1.toolOutputs[0].content, new RegExp(BIG_TAIL));
  assert.ok(round1.toolOutputs[0].content.length > 4096);

  // 3. recall 从档案取回原文（引擎服务，host 只被调了 big）
  assert.deepEqual(hostCalls, ["big"]);
  const recallResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-2");
  assert.match(String(recallResult?.content), new RegExp(BIG_TAIL));
});

test("outputHygiene: false keeps full content in context (opt-out)", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "big", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "x",
    executeTool: async () => bigOutput(),
    store,
    runId: "hygiene-off",
    outputHygiene: false,
    completion: false,
  });
  const toolResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.match(String(toolResult?.content), new RegExp(BIG_TAIL));
  const records = await store.load("hygiene-off");
  assert.equal(records.find((record) => record.round === 1)?.toolOutputs, undefined);
});

test("custom limit: outputHygiene { limit } lowers the threshold", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "mid", input: {} }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "x",
    executeTool: async () => "x".repeat(5000),
    store,
    runId: "hygiene-limit",
    outputHygiene: { limit: 100 },
    completion: false,
  });
  const toolResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1");
  assert.match(String(toolResult?.content), /已由引擎归档/);
  assert.ok(String(toolResult?.content).length < 500);
});

test("outputHygiene validation: bad shapes are TypeErrors; store-less is loud when explicit", async () => {
  const base = {
    provider: createFakeProvider([]),
    initialUserMessage: "x",
    executeTool: async () => "unused",
  };
  await assert.rejects(
    runToolLoop({ ...base, outputHygiene: "on" }),
    /outputHygiene must be false or an object/,
  );
  await assert.rejects(
    runToolLoop({ ...base, outputHygiene: { limit: -1 } }),
    /outputHygiene\.limit must be a positive integer/,
  );
  await assert.rejects(
    runToolLoop({ ...base, outputHygiene: { limit: 4096 } }),
    /outputHygiene requires a transcript store/,
  );
});

test("outputHygiene default limit scales with the host context window (issue #32)", async (t) => {
  const runOnce = async ({ runId, outputs, ...options }) => {
    const store = createMemoryTranscriptStore();
    let call = 0;
    const provider = createFakeProvider([
      ...outputs.map((output, index) => ({
        content: [{ type: "tool_use", id: `call-${index + 1}`, name: `tool-${index + 1}`, input: {} }],
        stopReason: "tool_use",
      })),
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    const result = await runToolLoop({
      provider,
      initialUserMessage: "run tools",
      executeTool: async () => {
        call += 1;
        return outputs[call - 1];
      },
      store,
      runId,
      completion: false,
      ...options,
    });
    const stubFor = (id) => String(result.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block?.type === "tool_result" && block.tool_use_id === id)?.content);
    const records = await store.load(runId);
    return { stubFor, round1: records.find((record) => record.round === 1) };
  };

  await t.test("no contextWindowTokens keeps the 4096 default", async () => {
    const { stubFor, round1 } = await runOnce({ runId: "hygiene-window-none", outputs: ["n".repeat(5000)] });
    const stub = stubFor("call-1");
    assert.ok(stub.startsWith("n".repeat(4096)), "阈值应为 4096");
    assert.ok(!stub.startsWith("n".repeat(4097)), "阈值不应大于 4096");
    assert.match(stub, /完整输出已由引擎归档/);
    assert.equal(round1.toolOutputs[0].content.length, 5000);
  });

  await t.test("contextWindowTokens 131072 → 19660 (15% 窗口)", async () => {
    const { stubFor, round1 } = await runOnce({
      runId: "hygiene-window-131k",
      outputs: ["a".repeat(20000), "b".repeat(5000)],
      modelMetadata: { contextWindowTokens: 131072 },
    });
    const big = stubFor("call-1");
    assert.ok(big.startsWith("a".repeat(19660)), "阈值应为 floor(0.15 * 131072) = 19660");
    assert.ok(!big.startsWith("a".repeat(19661)), "阈值不应大于 19660");
    assert.match(big, /完整输出已由引擎归档/);
    // 5000 字符在 4096 默认下会被截断，但窗口缩放后应原样保留
    const mid = stubFor("call-2");
    assert.equal(mid.length, 5000);
    assert.doesNotMatch(mid, /已由引擎归档/);
    assert.equal(round1.toolOutputs.length, 1);
    assert.equal(round1.toolOutputs[0].content.length, 20000);
  });

  await t.test("an explicit outputHygiene.limit always wins over the window", async () => {
    const { stubFor, round1 } = await runOnce({
      runId: "hygiene-window-explicit",
      outputs: ["c".repeat(5000)],
      modelMetadata: { contextWindowTokens: 131072 },
      outputHygiene: { limit: 100 },
    });
    const stub = stubFor("call-1");
    assert.ok(stub.startsWith("c".repeat(100)));
    assert.ok(!stub.startsWith("c".repeat(101)));
    assert.match(stub, /已由引擎归档/);
    assert.equal(round1.toolOutputs[0].content.length, 5000);
  });

  await t.test("the window-derived limit is clamped to [8192, 100000]", async () => {
    // 小窗口：0.15 * 32768 = 4915 → 下限 8192（比 15% 更宽）
    const small = await runOnce({
      runId: "hygiene-window-clamp-min",
      outputs: ["d".repeat(9000)],
      modelMetadata: { contextWindowTokens: 32768 },
    });
    const smallStub = small.stubFor("call-1");
    assert.ok(smallStub.startsWith("d".repeat(8192)), "阈值应为 8192（下限），而非 4915");
    assert.ok(!smallStub.startsWith("d".repeat(8193)));
    // 大窗口：0.15 * 2000000 = 300000 → 上限 100000
    const large = await runOnce({
      runId: "hygiene-window-clamp-max",
      outputs: ["e".repeat(100001)],
      modelMetadata: { contextWindowTokens: 2000000 },
    });
    const largeStub = large.stubFor("call-1");
    assert.ok(largeStub.startsWith("e".repeat(100000)), "阈值应为 100000（上限），而非 300000");
    assert.ok(!largeStub.startsWith("e".repeat(100001)));
  });
});

test("archive stub warns about side effects of the truncated command", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    {
      content: [{ type: "tool_use", id: "call-1", name: "exec", input: { command: "deploy" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "run deploy",
    executeTool: async () => bigOutput(),
    store,
    runId: "hygiene-side-effects",
    completion: false,
  });
  const stub = String(result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "call-1")?.content);
  // 仍保留 recall 配方
  assert.match(stub, /recall\(\{ round: 1, pattern: "关键词" \}\)/);
  // issue #32：补副作用提示——不得仅凭截断输出判成败，也不得为重跑补全而重复副作用命令
  assert.match(stub, /若原命令有副作用，不要仅凭截断输出判断成败/);
  assert.match(stub, /也不要为补全输出重跑有副作用的命令/);
  assert.match(stub, /用 recall 取回原文或改用只读方式复核/);
});

test("file store: recall corpus covers toolOutputs (boundedRecall object path)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erix-hygiene-file-"));
  try {
    const store = createFileTranscriptStore({ dir });
    await store.appendRound("hygiene-file", {
      round: 1,
      ts: "2026-09-16T00:00:00.000Z",
      messages: [{ role: "user", content: [{ type: "text", text: "run" }] }],
      toolOutputs: [{
        toolUseId: "t1",
        name: "big",
        content: `head\n${BIG_TAIL}`,
      }],
    });
    const recalled = await store.recall({
      runId: "hygiene-file",
      pattern: "UNIQUE_TAIL_MARKER_ADR015",
    });
    const recalledText = typeof recalled === "string" ? recalled : String(recalled?.text ?? "");
    assert.match(recalledText, new RegExp(BIG_TAIL));
    const legacy = await store.recall("hygiene-file", undefined, undefined, "UNIQUE_TAIL_MARKER_ADR015");
    assert.match(String(legacy), new RegExp(BIG_TAIL));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("crash mid-round: archived output survives via checkpoint and recall still delivers", async () => {
  const store = createMemoryTranscriptStore();
  const controller = new AbortController();
  const firstProvider = createFakeProvider([
    {
      content: [
        { type: "tool_use", id: "big-1", name: "big", input: {} },
        { type: "tool_use", id: "boom-1", name: "boom", input: {} },
      ],
      stopReason: "tool_use",
    },
  ]);
  await assert.rejects(
    runToolLoop({
      provider: firstProvider,
      initialUserMessage: "run",
      executeTool: async ({ id }) => {
        if (id === "boom-1") controller.abort();
        return id === "big-1" ? bigOutput() : "unused";
      },
      store,
      runId: "hygiene-crash",
      signal: controller.signal,
      completion: false,
    }),
    /abort/i,
  );

  const resumedProvider = createFakeProvider([
    {
      content: [{
        type: "tool_use",
        id: "recall-1",
        name: "recall",
        input: { pattern: "UNIQUE_TAIL_MARKER_ADR015" },
      }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider: resumedProvider,
    resume: true,
    store,
    runId: "hygiene-crash",
    executeTool: async () => "unused",
    completion: false,
  });
  const recallResult = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => block?.type === "tool_result" && block.tool_use_id === "recall-1");
  assert.match(String(recallResult?.content), new RegExp(BIG_TAIL));
  // resumed round record 也带全量（字节保真落盘）
  const records = await store.load("hygiene-crash");
  const archived = records.flatMap((record) => record.toolOutputs ?? []);
  assert.ok(archived.some((output) => output.content.includes(BIG_TAIL)));
});
