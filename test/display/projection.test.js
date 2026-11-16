import test from "node:test";
import assert from "node:assert/strict";
import { projectTranscriptForDisplay } from "../../src/display/projection.js";
import { projectTranscriptForDisplay as exportedProjection } from "../../src/index.js";
import { runDirect } from "./../helpers/run-direct.js";
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
    // 轮内消息里那条 assistant 消息是正文的**正本**（issue #335 第一步的读法）：它带 tool_use，
    // 而轮行 `response.content` 只有文字——两份副本不一致时以消息行为准，所以 tool_use 必须看得见
    // （改造前从 response 取，这一条会被吞掉，本用例的 toolCalls 断言在改造前是红的）。
    messages: [
      { role: "assistant", content: [
        { type: "text", text: "done reading" },
        { type: "tool_use", id: "t1", name: "read", input: { path: "src/a.js" } },
      ] },
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
  // 正本那一份的 tool_use 与配对结果照旧成对出现（结果预览按 MAX_RESULT_PREVIEW 截断）。
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].name, "read");
  assert.match(assistant.toolCalls[0].resultPreview, /^file body/u);
  assert.equal(assistant.toolCalls[0].resultPreview.length, 401);
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

// ── issue #335 第一步：assistant 正文的正本在消息行，展示侧不再依赖 `record.response.content` ──
// #334 之后「一条消息一成型就落盘」，恢复也只认消息行；轮行的 `response.content` 只是同一份正文的
// 第二副本。下面四条用例把「谁是正本」钉死：messages 优先、老账本回退、两份同时在场不得重复显示。

test("messages-only round (no response.content) still shows the assistant body", () => {
  // 第二步停写 `response.content` 之后的常态形状：轮行只剩元数据。
  const entries = projectTranscriptForDisplay([{
    round: 4,
    ts: "2026-10-21T08:00:00.000Z",
    messages: [
      { role: "user", content: [{ type: "text", text: "the task" }] },
      { role: "assistant", content: [
        { type: "reasoning", text: "musing" },
        { type: "text", text: "answer from the message row" },
        { type: "tool_use", id: "m1", name: "read", input: { path: "src/x.js" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "m1", content: "file body" }] },
    ],
    response: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } },
    toolUses: 1,
  }]);

  const assistants = entries.filter((entry) => entry.role === "assistant");
  assert.equal(assistants.length, 1);
  const [assistant] = assistants;
  assert.equal(assistant.text, "answer from the message row");
  assert.equal(assistant.reasoning, "musing");
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].name, "read");
  assert.equal(assistant.toolCalls[0].resultPreview, "file body");
  // 展示形状逐字不变：meta 仍从轮行元数据来，正文不因此被标成 synthetic/回退来源。
  assert.equal(assistant.meta.synthetic, false);
  assert.equal(assistant.meta.source, undefined);
  assert.equal(assistant.meta.stopReason, "end_turn");
  assert.deepEqual(assistant.meta.usage, { inputTokens: 7, outputTokens: 3 });
  assert.equal(assistant.round, 4);
  // 正文与工具结果的分拣照旧：只有 tool_result 的 user 消息不进展示流。
  assert.deepEqual(entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(entries[0].text, "the task");
});

test("legacy round with only response.content (no messages) still shows the assistant body", () => {
  // 老账本 + 宿主手写的轮行（touwaka 仍在写 response.content）⇒ 回退分支必须仍然服务得到。
  const entries = projectTranscriptForDisplay([{
    round: 1,
    ts: "2026-10-07T08:00:00.000Z",
    response: {
      content: [
        { type: "reasoning", text: "legacy thought" },
        { type: "text", text: "legacy answer" },
        { type: "tool_use", id: "l1", name: "exec", input: { command: "ls" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 4 },
    },
    toolUses: 1,
    summary: { action: "listing", note: "legacy" },
  }]);

  const assistants = entries.filter((entry) => entry.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "legacy answer");
  assert.equal(assistants[0].reasoning, "legacy thought");
  assert.equal(assistants[0].toolCalls[0].name, "exec");
  assert.equal(assistants[0].meta.synthetic, false);
  assert.equal(assistants[0].meta.source, undefined);
  assert.equal(assistants[0].meta.stopReason, "tool_use");
  assert.deepEqual(assistants[0].meta.summary, { action: "listing", note: "legacy" });

  // 只有 user 消息 + response.content（宿主手写行）也走同一条回退分支。
  const hostWritten = projectTranscriptForDisplay([{
    round: 2,
    messages: [{ role: "user", content: [{ type: "text", text: "host question" }] }],
    response: { content: [{ type: "text", text: "host answer" }] },
  }]);
  assert.deepEqual(hostWritten.map((entry) => [entry.role, entry.text]), [
    ["user", "host question"],
    ["assistant", "host answer"],
  ]);
});

test("both copies present and consistent: exactly one assistant entry, sourced from messages", () => {
  const body = [
    { type: "text", text: "the one body" },
    { type: "tool_use", id: "d1", name: "work", input: { path: "p" } },
  ];
  const record = {
    round: 2,
    messages: [{ role: "assistant", content: structuredClone(body) }],
    response: { content: structuredClone(body), stopReason: "tool_use" },
    textPreview: "the one body",
    toolUses: 1,
  };
  const entries = projectTranscriptForDisplay([record]);
  const assistants = entries.filter((entry) => entry.role === "assistant");
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].text, "the one body");
  assert.equal(assistants[0].toolCalls.length, 1);
  assert.equal(assistants[0].toolCalls[0].name, "work");
  // 正本的身份可查：展示的块是**消息行那一份**的对象，不是 response.content 那一份。
  assert.equal(assistants[0].blocks[0], record.messages[0].content[0]);
  assert.notEqual(assistants[0].blocks[0], record.response.content[0]);
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

// 执行状态的取值优先级（工单 261014 T2 §2.2）：`erix` 优先，顶层只作升级前记录的回退。
// T1 双写期这里是顶层优先，两边同值时看不出来；停写之后两值会分开，所以这条必须在停写前钉住。
test("executionStatus prefers erix.executionStatus and falls back to the top level for legacy records", () => {
  const project = (resultBlockExtra) => projectTranscriptForDisplay([{
    round: 2,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "exec", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x", ...resultBlockExtra }] },
    ],
  }])[0].toolCalls[0];

  // 两值不一致：取 erix 那一份（修前：取顶层那一份 → 本例会红）。
  assert.equal(project({ executionStatus: "intercepted", erix: { executionStatus: "interrupted" } }).executionStatus,
    "interrupted");
  // 只有引擎命名空间（停写后的形状）。
  assert.equal(project({ erix: { executionStatus: "interrupted" } }).executionStatus, "interrupted");
  // 只有顶层（0.19 及更早的落盘记录）：回退仍然服务得到。
  assert.equal(project({ executionStatus: "intercepted" }).executionStatus, "intercepted");
  // 两边都没有：字段缺省，而不是被造一个出来。
  assert.equal(project({}).executionStatus, undefined);
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
  assert.equal(judge.meta.sourceInferred, undefined);

  const system = entries.find((entry) => entry.text === "system note");
  assert.equal(system.role, "system");
  assert.equal(system.meta.synthetic, true);
  assert.equal(system.meta.sourceInferred, undefined);

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
  assert.equal(audit[0].meta.sourceInferred, true);

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

test("projection preserves its documented block and nested-meta reference boundaries", () => {
  const ordinaryBlock = { type: "text", text: "ordinary" };
  const foldedBlock = {
    type: "text",
    text: "lead-in\n【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮已折叠。\n\nremaining task",
  };
  const usage = { inputTokens: 1 };
  const record = {
    round: 1,
    messages: [
      { role: "user", content: [ordinaryBlock] },
      { role: "user", content: [foldedBlock] },
    ],
    response: {
      content: [{ type: "text", text: "answer" }],
      usage,
    },
  };

  const turns = projectTranscriptForDisplay([record]);
  const ordinary = turns.find((turn) => turn.text === "ordinary");
  const folded = turns.find((turn) => turn.text === "lead-in\nremaining task");
  const assistant = turns.find((turn) => turn.role === "assistant");

  assert.notEqual(ordinary.blocks, record.messages[0].content);
  assert.equal(ordinary.blocks[0], ordinaryBlock);
  ordinary.blocks[0].text = "changed ordinary";
  assert.equal(record.messages[0].content[0].text, "changed ordinary");

  assert.notEqual(folded.blocks[0], foldedBlock);
  folded.blocks[0].text = "changed folded";
  assert.equal(
    record.messages[1].content[0].text,
    "lead-in\n【上下文折叠·v1·erix-9f6e2c】早期第 1–2 轮已折叠。\n\nremaining task",
  );

  assert.equal(assistant.meta.usage, usage);
  assistant.meta.usage.inputTokens = 2;
  assert.equal(record.response.usage.inputTokens, 2);
});

test("projects records produced by a real run (seed, tool rounds, real fold summary)", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "first", name: "work", input: { path: "src/a.js" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "second", name: "work", input: { path: "src/b.js" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" },
  ]);
  const store = createMemoryTranscriptStore();
  await runDirect({ capabilities: { ports: { strategy: createFoldStatisticalStrategy() } },
    provider,
    initialUserMessage: "do the thing",
    executeTool: async ({ id }) => `result for ${id} ${"y".repeat(200)}`,
    maxRounds: 3,
    completion: false,
    wrapup: false,
    reflection: false,
    config: { folding: { context: {
            budgetTokens: 30,
      keepRounds: 0,
    } } },
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


// ── issue #854：预览截断按码点收口，切点不许落在代理对中间 ──
// `truncated()` 是八个调用点共用的唯一收口。旧写法按 UTF-16
// 代码单元 `slice(0, maxChars)` 切，切点可以落在代理对中间，预览
// 末尾于是剩一个孤立代理；这一份预览经宿主（erix-station 的
// folded 接口）原样透传给浏览器，脏字符直接进了用户界面。
// 下面的用例全部走公开入口 `projectTranscriptForDisplay`，只验两件事：
// 切点安全（不再产生孤立代理），以及可观测行为没变（不截断的输入、
// 纯 BMP 输入的输出，跟改动前逐字相同）。

/** 一个 astral 字符：UTF-16 里是 D83D DE00 一对代理。 */
const EMOJI = "\u{1F4A5}";
/** 另一个 astral 字符（D83D DE00），给「800 emoji」那格用。 */
const GRINNING = "\u{1F600}";

/** 改动前 `truncated()` 的函数体，逐字照搬，当「不许变」的对照面。 */
function legacyTruncated(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * 第一个孤立代理的代码单元下标，没有孤立代理则 -1。手工区间检查：
 * 高代理必须紧跟低代理。它只算下标，坏在哪个位置由下面那个断言写进
 * 消息。
 */
function firstLoneSurrogateIndex(text) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const pair = text.charCodeAt(index + 1);
      if (pair >= 0xdc00 && pair <= 0xdfff) {
        index += 1; // 代理对完整，整对跳过
        continue;
      }
      return index; // 孤立高代理：下半截被切掉了
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return index; // 孤立低代理
  }
  return -1;
}

/** 没有孤立代理：区间检查 + isWellFormed + 逐码点复核，三路互证。 */
function assertNoLoneSurrogate(text, label) {
  const bad = firstLoneSurrogateIndex(text);
  const at = bad === -1 ? 0 : bad;
  assert.equal(
    bad,
    -1,
    `${label}: isolated surrogate 0x${text.charCodeAt(at).toString(16)}`
      + ` at code-unit index ${bad} of ${text.length}`,
  );
  assert.ok(text.isWellFormed(), `${label}: isWellFormed() is false`);
  // 逐码点复核（另一条算法）：`Array.from` 按码点迭代，只剩一个代码
  // 单元的代理就是被切开的半对。
  const lone = Array.from(text).filter((char) => char.length === 1
    && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff);
  assert.deepEqual(lone, [], `${label}: ${lone.length} code point(s) are half a pair`);
}

/** 「assistant 调用 + 配对结果」的轮行（结果预览走 400 那一处）。 */
function roundWithToolResult(content) {
  return {
    round: 1,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
    ],
  };
}

function resultPreviewOf(content) {
  const turn = projectTranscriptForDisplay([roundWithToolResult(content)])
    .find((entry) => entry.toolCalls !== undefined);
  return turn.toolCalls[0].resultPreview;
}

/** 只带工具调用的轮行；input 给非对象也走得通（另一条分支）。 */
function argsSummaryOf(input) {
  const record = {
    round: 1,
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input }],
    }],
  };
  const turn = projectTranscriptForDisplay([record])
    .find((entry) => entry.toolCalls !== undefined);
  return turn.toolCalls[0].argsSummary;
}

/** 折叠正文的两种来源与 wrapup：都过 1200 那一处。 */
function projectedTexts(record) {
  return projectTranscriptForDisplay([record]).map((entry) => entry.text);
}

test("issue #854: a cut landing inside a surrogate pair leaves no isolated surrogate", () => {
  // 票面现场：405 个代码单元 / 404 个码点，预算 400 的旧切法正落在
  // emoji 的代理对中间。下面三行是这一格的前置：先证明现场真的脏，
  // 再证明新实现不脏。
  const content = `${"a".repeat(399)}${EMOJI}tail`;
  assert.equal(content.length, 405);
  // 旧切法的末位 = 孤立高代理 0xD83D。
  assert.equal(content.slice(0, 400).charCodeAt(399), 0xd83d);
  // 旧输出确实是脏的。
  assert.equal(content.slice(0, 400).isWellFormed(), false);

  const preview = resultPreviewOf(content);
  assertNoLoneSurrogate(preview, "resultPreview");
  assert.ok(preview.endsWith("…"), "the … suffix keeps its existing meaning");
  // 预算的口径是码点：留下 399 个 a 加整个 emoji（400 个完整码点），
  // 不是 400 个代码单元。
  assert.equal(preview, `${"a".repeat(399)}${EMOJI}…`);
  assert.equal(Array.from(preview).length, 401); // 400 码点 + 后缀
});

test("issue #854: non-truncated input and BMP output are byte-for-byte unchanged", () => {
  // ① 同一输入不被截断 ⇒ 输出既等于输入本身，也等于改动前的输出
  //    （防误伤）。
  const untouched = [
    "x",
    "中文。".repeat(80), // BMP：码点数 == 代码单元数
    "a".repeat(400), // 正好在预算上
    "a".repeat(200) + "中".repeat(199),
    GRINNING.repeat(100), // astral 但在预算内（200 单元 / 100 码点）
  ];
  for (const content of untouched) {
    const preview = resultPreviewOf(content);
    assert.equal(preview, content);
    assert.equal(preview, legacyTruncated(content, 400));
  }
  // 空结果不产生预览字段（既有语义：改动没造出空串预览）。
  assert.equal(resultPreviewOf(""), undefined);
  // ② 真被截断、但输入是纯 BMP ⇒ 内容与长度都按旧口径。ASCII 是
  //    400 + 后缀 = 401，这一条长度是本文件开头就有的老契约，一个字节都
  //    不许变。
  for (const content of ["q".repeat(700), "中".repeat(700), "a".repeat(401)]) {
    const preview = resultPreviewOf(content);
    assert.equal(preview, legacyTruncated(content, 400));
    assert.equal(preview.length, 401);
  }
  // ③ 参数摘要的 ASCII 输出同样逐字不变。裸字面量 60 已被具名成常量，
  //    这一格把值钉住：改名不许改值，预算 120 那处也一样。
  const value61 = "b".repeat(61);
  const summary61 = argsSummaryOf({ path: value61 });
  assert.equal(summary61, `path=${"b".repeat(60)}…`);
  assert.equal(summary61, `path=${legacyTruncated(value61, 60)}`);
  assert.equal(argsSummaryOf({ path: "b".repeat(60) }), `path=${"b".repeat(60)}`);
  assert.equal(argsSummaryOf("q".repeat(121)), `"${"q".repeat(119)}…`);
});

test("issue #854: 800 emoji never yields an isolated surrogate", () => {
  const pure = GRINNING.repeat(800); // 1600 代码单元 / 800 码点
  const offset = `x${pure}`; // 错开一位：旧切法第 400 个单元正落在代理对中间
  assert.equal(offset.slice(0, 400).charCodeAt(399), 0xd83d);
  assert.equal(offset.slice(0, 400).isWellFormed(), false);
  for (const [content, expected] of [
    [pure, `${GRINNING.repeat(400)}…`], // 预算按码点 ⇒ 留 400 个完整 emoji
    [offset, `x${GRINNING.repeat(399)}…`],
  ]) {
    const preview = resultPreviewOf(content);
    assertNoLoneSurrogate(preview, "resultPreview(800 emoji)");
    assert.equal(preview, expected);
    assert.equal(Array.from(preview).length, 401);
  }
});

test("issue #854: every preview budget cuts on a code-point boundary", () => {
  // 八个调用点共用 truncated()：收口只有一处，但收益必须落到每条预算
  // 上，所以逐处验。offset 扫一遍 ⇒ 切点相对代理对的位置逐次移动，
  // 必然扫到「正好落在中间」那些。每格输入都真的超过预算，否则截断
  // 不会发生，用例就咬不住退回。
  const budgets = [
    // 非对象工具入参 → MAX_ARGS_PREVIEW(120)：JSON 化后 132 码点 > 120
    ["argsSummary(non-object)", 121, (offset) => [
      argsSummaryOf(`${"x".repeat(offset)}${EMOJI.repeat(130)}`),
    ]],
    // 单个参数值 → MAX_ARG_VALUE_PREVIEW(60)：上限 66 = "path=" + 60 + 后缀
    ["argsSummary(value)", 66, (offset) => [
      argsSummaryOf({ path: `${"x".repeat(offset)}${EMOJI.repeat(70)}` }),
    ]],
    // 参数汇总串 → MAX_ARGS_PREVIEW(120)
    ["argsSummary(joined)", 121, (offset) => [
      argsSummaryOf({
        a: "c".repeat(45),
        b: "d".repeat(45),
        c: `${"x".repeat(offset)}${EMOJI.repeat(40)}`,
      }),
    ]],
    // 工具结果预览 → MAX_RESULT_PREVIEW(400)
    ["resultPreview", 401, (offset) => [
      resultPreviewOf(`${"x".repeat(offset)}${EMOJI.repeat(500)}`),
    ]],
    // 标记折叠正文 → MAX_FOLD_TEXT(1200)：splitFoldBlocks + pushFoldEntry
    ["foldText(marked)", 1201, (offset) => projectedTexts({
      round: 0,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: `【上下文折叠·v1·erix-9f6e2c】${"y".repeat(offset)}${EMOJI.repeat(1300)}`,
        }, { type: "text", text: "real task" }],
      }],
    })],
    // 组合式折叠正文 → MAX_FOLD_TEXT(1200)：composedFoldText + pushFoldEntry
    ["foldText(composed)", 1201, (offset) => projectedTexts({
      round: 2,
      folded: true,
      foldedRoundRange: { from: 1, to: 3 },
      summary: { action: `${"y".repeat(1180 + offset)}${EMOJI}tail`, note: "n" },
    })],
    // wrapup 正文 → MAX_FOLD_TEXT(1200)
    ["wrapupText", 1201, (offset) => projectedTexts({
      round: 9,
      messages: [],
      wrapup: { summary: `"${"z".repeat(offset)}${EMOJI.repeat(1300)}` },
    })],
  ];
  for (const [label, capInCodePoints, build] of budgets) {
    let truncatedCases = 0;
    for (let offset = 0; offset <= 6; offset += 1) {
      for (const text of build(offset)) {
        assert.equal(typeof text, "string", `${label} @${offset}: no text projected`);
        assertNoLoneSurrogate(text, `${label} @offset ${offset}`);
        // 预算仍然被守住（口径是码点，后缀最多再加一个码点）。
        assert.ok(
          Array.from(text).length <= capInCodePoints,
          `${label} @${offset}: ${Array.from(text).length} code points > ${capInCodePoints}`,
        );
        if (text.endsWith("…")) truncatedCases += 1;
      }
    }
    // 反空转：这条预算必须真被截过，否则用例咬不住任何退回。
    assert.ok(truncatedCases > 0, `${label}: never truncated — the case is vacuous`);
  }
});
