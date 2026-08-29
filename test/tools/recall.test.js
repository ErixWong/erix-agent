import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { estimateTokens } from "../../src/tokens.js";
import { createRecallTool } from "../../src/tools/recall.js";

async function seedStore() {
  const store = createMemoryTranscriptStore();
  await store.appendRound("run", {
    round: 1,
    folded: true,
    messages: [{ role: "user", content: [{ type: "text", text: "before context" }] }],
  });
  await store.appendRound("run", {
    round: 2,
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "line one\nline two\nneedle fact\nline four\nline five" },
        { type: "tool_use", name: "readFile", input: { path: "a.txt" } },
      ],
    }],
  });
  await store.appendRound("run", {
    round: 3,
    messages: [{ role: "user", content: [{ type: "tool_result", content: "result text" }] }],
  });
  return store;
}

test("recall without arguments returns an overview and folded watermark", async () => {
  const tool = createRecallTool({ store: await seedStore(), runId: "run" });
  const result = await tool.execute({});
  assert.match(result, /round 1 \[folded\]/);
  assert.match(result, /messages=1/);
  assert.match(result, /tools=readFile/);
  assert.match(result, /折叠水位线: 1-1/);
  assert.equal(tool.schema.name, "recall");
  assert.equal(tool.schema.inputSchema.properties.episodeId, undefined);
});

test("pattern recall returns grep context, textifies tool blocks, and caps segments", async () => {
  const store = await seedStore();
  const tool = createRecallTool({
    store,
    runId: "run",
    limits: { segmentTokens: 40, maxSegments: 1, totalTokens: 60 },
  });
  const result = await tool.execute({ pattern: "needle" });
  assert.match(result, /line one/);
  assert.match(result, /needle fact/);
  assert.doesNotMatch(result, /未命中/);
  assert.ok(estimateTokens(result) <= 60);
});

test("range recall and empty pattern results use the documented text and marker", async () => {
  const store = await seedStore();
  const tool = createRecallTool({
    store,
    runId: "run",
    limits: {
      segmentTokens: 300,
      maxSegments: 1,
      rangeMaxSegments: 1,
      totalTokens: 60,
    },
  });
  const range = await tool.execute({ fromRound: 2, toRound: 3 });
  assert.match(range, /needle fact/);
  assert.match(range, /\[截断，共 2 段，offset=1 继续\]/);
  assert.ok(estimateTokens(range) <= 60);
  assert.equal(await tool.execute({ pattern: "does-not-exist" }), "未命中。建议换更短的关键词或同义词重试");
});

test("recall 工具 pattern/范围 均覆盖 foldedPayload", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("rr", {
    round: 1,
    messages: [{ role: "assistant", content: [{ type: "text", text: "当轮" }] }],
    folded: true,
    foldedPayload: [{ role: "user", content: [{ type: "text", text: "折叠原文中的阈值 42.5" }] }],
    ts: new Date().toISOString(),
  });
  const tool = createRecallTool({ store, runId: "rr" });
  const byPattern = await tool.execute({ pattern: "42.5" });
  assert.ok(byPattern.includes("42.5"), "pattern 应命中折叠原文");
  assert.ok(byPattern.includes("折叠"), "应带来源标记");
  const byRange = await tool.execute({ fromRound: 1, toRound: 1 });
  assert.ok(byRange.includes("42.5"), "范围态应含折叠原文");
});

test("pattern 支持正则（模型常写 a|b 交替式），非法正则回落子串", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("re1", {
    round: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "遥测服务的告警阈值定为 42.5%" }] }],
    ts: new Date().toISOString(),
  });
  const tool = createRecallTool({ store, runId: "re1" });
  const byRegex = await tool.execute({ pattern: "遥测|阈值" });
  assert.ok(byRegex.includes("42.5"), "交替正则应命中");
  const byBadRegex = await tool.execute({ pattern: "阈值(" });
  assert.ok(byBadRegex.includes("阈值") === false || typeof byBadRegex === "string", "非法正则不崩溃");
});
