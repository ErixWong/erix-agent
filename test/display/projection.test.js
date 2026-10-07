import test from "node:test";
import assert from "node:assert/strict";
import { projectTranscriptForDisplay } from "../../src/display/projection.js";
import { projectTranscriptForDisplay as exportedProjection } from "../../src/index.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

test("projection is exported from the public entry point", () => {
  assert.equal(exportedProjection, projectTranscriptForDisplay);
});

test("plain round: assistant text, tool call summary with key args, tool result preview", () => {
  const entries = projectTranscriptForDisplay([{
    round: 3,
    ts: "2026-10-07T08:00:00.000Z",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "src/a.js" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body".repeat(100) }] },
    ],
    response: {
      content: [{ type: "text", text: "done reading" }],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2 },
    },
    textPreview: "done reading",
    toolUses: 1,
    summary: { action: "read file", note: "ok" },
  }]);

  assert.equal(entries.length, 1);
  const [assistant] = entries;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.round, 3);
  assert.equal(assistant.ts, "2026-10-07T08:00:00.000Z");
  assert.equal(assistant.text, "done reading");
  assert.equal(assistant.folded, undefined);
  assert.equal(assistant.meta.synthetic, false);
  assert.equal(assistant.meta.stopReason, "end_turn");
  assert.deepEqual(assistant.meta.usage, { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(assistant.meta.summary, { action: "read file", note: "ok" });

  const projected = projectTranscriptForDisplay([{
    round: 1,
    messages: [],
    response: {
      content: [
        { type: "text", text: "let me read it" },
        { type: "tool_use", id: "t9", name: "bash", input: { command: "npm test", timeout: 30 } },
      ],
    },
  }]);
  assert.equal(projected[0].toolCalls.length, 1);
  assert.equal(projected[0].toolCalls[0].name, "bash");
  assert.equal(projected[0].toolCalls[0].id, "t9");
  assert.match(projected[0].toolCalls[0].argsSummary, /^command=npm test/u);
  assert.ok(projected[0].toolCalls[0].argsSummary.length <= 121);
});

test("tool result preview is attached to the matching tool call", () => {
  const entries = projectTranscriptForDisplay([{
    round: 2,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "boom", is_error: true }] },
    ],
  }]);
  const assistant = entries.find((entry) => entry.role === "assistant");
  assert.equal(assistant.toolCalls[0].name, "read");
  assert.equal(assistant.toolCalls[0].resultPreview, "boom");
  assert.equal(assistant.toolCalls[0].isError, true);
  // tool-result-only user messages are model plumbing, not display turns
  assert.equal(entries.filter((entry) => entry.role === "user").length, 0);
});

test("reasoning blocks are projected into the reasoning field, never into text", () => {
  const entries = projectTranscriptForDisplay([{
    round: 1,
    response: {
      content: [
        { type: "reasoning", text: "thinking hard" },
        { type: "text", text: "answer" },
      ],
    },
  }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "answer");
  assert.equal(entries[0].reasoning, "thinking hard");
});

test("reasoning block shapes from every provider normalization are recognized", () => {
  const entries = projectTranscriptForDisplay([{
    round: 1,
    response: {
      content: [
        { type: "thinking", thinking: "anthropic style" },
        { payload: { kind: "reasoning", text: "openai style" } },
        { type: "text", text: "hi" },
      ],
    },
  }]);
  assert.equal(entries[0].text, "hi");
  assert.equal(entries[0].reasoning, "anthropic style\nopenai style");
});

test("folded round renders the fold summary and range, not the raw folded payload", () => {
  const entries = projectTranscriptForDisplay([{
    round: 12,
    ts: "2026-10-07T09:00:00.000Z",
    folded: true,
    foldedRoundRange: { from: 1, to: 7 },
    navigationRecord: {
      roundFrom: 1,
      roundTo: 7,
      artifacts: [{ id: "art1", locator: "/tmp/a.txt", digest: "d", status: "archived" }],
      truncated: true,
    },
    foldedPayload: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "HUGE_PAYLOAD_MARKER" }] },
      { role: "assistant", content: [{ type: "text", text: "HUGE_PAYLOAD_MARKER_2" }] },
    ],
    summary: { action: "keep going", note: "tests green" },
    messages: [],
    response: { content: [{ type: "text", text: "current answer" }] },
  }]);

  const fold = entries[0];
  assert.equal(fold.role, "system");
  assert.equal(fold.folded, true);
  assert.equal(fold.round, 12);
  assert.equal(fold.meta.synthetic, true);
  assert.equal(fold.meta.source, "fold-summary");
  assert.deepEqual(fold.meta.foldedRoundRange, { from: 1, to: 7 });
  assert.deepEqual(fold.meta.navigationRecord.roundFrom, 1);
  assert.equal(fold.meta.navigationRecord.truncated, true);
  assert.equal(fold.meta.foldedPayloadMessages, 2);
  assert.match(fold.text, /第 1–7 轮/u);
  assert.match(fold.text, /tests green/u);
  assert.match(fold.text, /导航记录：1 个归档产物（已截断）/u);

  const assistant = entries.at(-1);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.text, "current answer");

  const rendered = JSON.stringify(entries);
  assert.ok(!rendered.includes("HUGE_PAYLOAD_MARKER"));
  assert.ok(!rendered.includes("HUGE_PAYLOAD_MARKER_2"));
});

test("marked fold summary block in a resumed seed record becomes its own system line", () => {
  const entries = projectTranscriptForDisplay([{
    round: 0,
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: "【上下文折叠·v1·erix-9f6e2c】早期第 1–4 轮（共 4 轮）已折叠。工具足迹：无。\n需要原文请重读文件或查看持久笔记；关键值应当已落盘",
        },
        { type: "text", text: "real task text" },
      ],
    }],
    summary: "missing",
  }]);
  assert.equal(entries[0].role, "system");
  assert.equal(entries[0].folded, true);
  assert.match(entries[0].text, /早期第 1–4 轮/u);
  assert.ok(!entries[0].text.includes("real task text"));
  const user = entries.find((entry) => entry.role === "user");
  assert.equal(user.text, "real task text");
  assert.equal(user.meta.synthetic, false);
});

test("legacy inline fold marker is split out of the user text", () => {
  const entries = projectTranscriptForDisplay([{
    round: 0,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: "lead-in\n【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮已折叠。\n\nrest of task",
      }],
    }],
  }]);
  const fold = entries.find((entry) => entry.folded === true);
  assert.match(fold.text, /早期第 1–2 轮/u);
  const user = entries.find((entry) => entry.role === "user");
  assert.equal(user.text, "lead-in\nrest of task");
});

test("synthetic turns are labelled with role and meta.synthetic", () => {
  const entries = projectTranscriptForDisplay([{
    round: 5,
    messages: [
      { role: "user", meta: { source: "judge-control" }, content: [{ type: "text", text: "（附方向提示：换思路）" }] },
      { role: "system", content: [{ type: "text", text: "system note" }] },
      { role: "user", content: [{ type: "text", text: "real user follow-up" }] },
    ],
    response: { content: [{ type: "text", text: "ok" }] },
  }]);

  const judge = entries.find((entry) => entry.text.includes("方向提示"));
  assert.equal(judge.role, "user");
  assert.equal(judge.meta.synthetic, true);
  assert.equal(judge.meta.source, "judge-control");

  const system = entries.find((entry) => entry.text === "system note");
  assert.equal(system.role, "system");
  assert.equal(system.meta.synthetic, true);

  const real = entries.find((entry) => entry.text === "real user follow-up");
  assert.equal(real.role, "user");
  assert.equal(real.meta.synthetic, false);
});

test("audit-intercept and wrapup synthetic shapes are labelled", () => {
  const audit = projectTranscriptForDisplay([{
    round: 6,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "【审计拦截】方向可能偏: x/y。原工具调用未执行。" }],
    }],
  }]);
  assert.equal(audit[0].meta.synthetic, true);
  assert.equal(audit[0].meta.source, "audit-intercept");

  const wrapup = projectTranscriptForDisplay([{
    round: 7,
    messages: [],
    wrapup: { summary: "wrapped up", done: true },
  }]);
  const wrapupTurn = wrapup.find((entry) => entry.meta.source === "wrapup");
  assert.ok(wrapupTurn);
  assert.equal(wrapupTurn.role, "system");
  assert.equal(wrapupTurn.meta.synthetic, true);
  assert.equal(wrapupTurn.text, "wrapped up");
});

test("records are projected in ascending round order regardless of input order", () => {
  const entries = projectTranscriptForDisplay([
    { round: 3, response: { content: [{ type: "text", text: "three" }] } },
    { round: 1, response: { content: [{ type: "text", text: "one" }] } },
    { round: 2, folded: true, foldedRoundRange: { from: 1, to: 1 }, response: { content: [{ type: "text", text: "two" }] } },
  ]);
  assert.deepEqual(entries.map((entry) => entry.round), [1, 2, 2, 3]);
  assert.deepEqual(entries.map((entry) => entry.text), ["one", "早期第 1–1 轮已折叠。", "two", "three"]);
});

test("records sharing the same round keep their input relative order (index tiebreak)", () => {
  // 预写入 :input: 行与引擎自身行共享最大 round（appendUserTurn 语义），
  // 实现用输入索引打破平局：同 round 输出必须保持输入相对顺序。
  const entries = projectTranscriptForDisplay([
    { round: 2, messages: [{ role: "user", content: [{ type: "text", text: "pre-written input" }] }], dedupKey: "k:input:m-1" },
    { round: 2, response: { content: [{ type: "text", text: "engine answer" }] } },
    { round: 2, messages: [{ role: "user", content: [{ type: "text", text: "second input" }] }], dedupKey: "k:input:m-2" },
  ]);
  assert.deepEqual(entries.map((entry) => `${entry.role}:${entry.text}`), [
    "user:pre-written input",
    "assistant:engine answer",
    "user:second input",
  ]);
  // 输入顺序反转时，输出相对顺序随之反转（非字典序/稳定 sort 的另一种假象）
  const reversed = projectTranscriptForDisplay([
    { round: 2, messages: [{ role: "user", content: [{ type: "text", text: "second input" }] }], dedupKey: "k:input:m-2" },
    { round: 2, response: { content: [{ type: "text", text: "engine answer" }] } },
    { round: 2, messages: [{ role: "user", content: [{ type: "text", text: "pre-written input" }] }], dedupKey: "k:input:m-1" },
  ]);
  assert.deepEqual(reversed.map((entry) => `${entry.role}:${entry.text}`), [
    "user:second input",
    "assistant:engine answer",
    "user:pre-written input",
  ]);
});

test("tolerates empty input, missing fields, legacy records and odd shapes", () => {
  assert.deepEqual(projectTranscriptForDisplay([]), []);
  assert.deepEqual(projectTranscriptForDisplay(undefined), []);
  assert.deepEqual(projectTranscriptForDisplay(null), []);
  assert.deepEqual(projectTranscriptForDisplay("nope"), []);
  assert.deepEqual(projectTranscriptForDisplay([null, undefined, 7, "x"]), []);

  const entries = projectTranscriptForDisplay([
    {}, // legacy record with nothing at all
    { round: 1, summary: "missing", messages: [{ role: "user", content: [{ type: "text", text: "seed task" }] }] }, // seed record without ts
    { round: 2, textPreview: "legacy preview" }, // no response, preview fallback
    { round: "3", messages: [{ role: "user", content: "string content" }] }, // string content, string round
    { round: 4, messages: {}, response: { content: null }, folded: true }, // broken content
  ]);

  assert.ok(entries.length > 0);
  assert.deepEqual(entries.map((entry) => entry.round), [1, 2, 3, 4]);
  const preview = entries.find((entry) => entry.text === "legacy preview");
  assert.equal(preview.role, "assistant");
  assert.equal(preview.meta.source, "textPreview");
  const seeded = entries.find((entry) => entry.text === "seed task");
  assert.equal(seeded.role, "user");
  assert.equal(seeded.ts, undefined);
  assert.equal(seeded.meta.summary, "missing");
  const stringUser = entries.find((entry) => entry.text === "string content");
  assert.equal(stringUser.role, "user");
  assert.equal(stringUser.ts, undefined);
  assert.equal(stringUser.meta.summary, undefined);
  const broken = entries.filter((entry) => entry.round === 4);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].folded, true);
  assert.equal(broken[0].role, "system");
});

test("does not mutate the input records", () => {
  const record = {
    round: 1,
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: { path: "p" } }] }],
    response: { content: [{ type: "text", text: "x" }] },
  };
  const snapshot = structuredClone(record);
  projectTranscriptForDisplay([record]);
  assert.deepEqual(record, snapshot);
});

test("projects records produced by a real run (seed, tool rounds, real fold summary)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "first", name: "work", input: { path: "src/a.js" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "second", name: "work", input: { path: "src/b.js" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  await runToolLoop({
    provider,
    initialUserMessage: "do the thing",
    executeTool: async ({ id }) => `result for ${id} ${"y".repeat(200)}`,
    maxRounds: 3,
    completion: false,
    wrapup: false,
    reflection: false,
    context: {
      strategy: createFoldStatisticalStrategy(),
      budgetTokens: 30,
      keepRounds: 0,
    },
    store,
    runId: "display-projection",
  });

  const records = await store.load("display-projection");
  assert.ok(records.length > 1);
  const entries = projectTranscriptForDisplay(records);

  // ascending round order, every entry carries the display contract shape
  const rounds = entries.map((entry) => entry.round ?? Number.MAX_SAFE_INTEGER);
  assert.deepEqual(rounds, [...rounds].sort((left, right) => left - right));
  for (const entry of entries) {
    assert.ok(["user", "assistant", "system"].includes(entry.role));
    assert.equal(typeof entry.text, "string");
    assert.ok(Array.isArray(entry.blocks));
    assert.equal(typeof entry.meta, "object");
    assert.equal(typeof entry.meta.synthetic, "boolean");
  }

  // the initial user turn is projected from the seed record
  const seeded = entries.find((entry) => entry.role === "user" && entry.text === "do the thing");
  assert.ok(seeded, "seed user turn must be projected");

  // a real folded round exposes the marked summary line, not the raw payload
  const foldEntries = entries.filter((entry) => entry.folded === true);
  assert.ok(foldEntries.length > 0, "expected at least one folded round");
  assert.match(foldEntries[0].text, /已折叠/u);
  assert.ok(foldEntries.every((entry) => !entry.text.includes("y".repeat(200))));

  // tool calls survive as summaries
  const withCalls = entries.filter((entry) => entry.toolCalls !== undefined);
  assert.ok(withCalls.length > 0);
  assert.match(JSON.stringify(withCalls.map((entry) => entry.toolCalls)), /work/u);

  // the final answer is present
  assert.ok(entries.some((entry) => entry.role === "assistant" && entry.text === "all done"));
});
