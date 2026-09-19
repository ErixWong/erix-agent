// ADR-015 Phase 3：notes 小抄目录 → semantic 槽位 → run-state 块
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import {
  createDeterministicRunState,
  renderRunState,
  withSemanticRunState,
} from "../src/run-state.js";
import { createNotesDirectoryProvider } from "../bin/cli.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const RECORDS = [
  {
    key: "final_report",
    state: "active",
    pinned: true,
    source: "agent",
    updated_at: "2026-09-16T01:00:00.000Z",
    current: { summary: "报告已写入 /tmp/x.md" },
  },
  {
    key: "api_token",
    state: "active",
    source: "auto",
    updated_at: "2026-09-16T00:30:00.000Z",
    current: { summary: "PrintService 测试环境 token" },
  },
  {
    key: "done_note",
    state: "done",
    current: { summary: "已完成的不该出现" },
  },
];

function fakeNotesStore(records) {
  return { list: async () => structuredClone(records) };
}

test("directory provider: active notes rendered pinned-first with source markers", async () => {
  const provider = createNotesDirectoryProvider({
    notesStore: fakeNotesStore(RECORDS),
    runId: "run-1",
  });
  const provided = await provider({ state: { stateVersion: 7 } });
  const lines = provided.text.split("\n");
  assert.equal(lines[0], "[notes 小抄目录]（note_read key=... 取全文）");
  assert.match(lines[1], /- final_report \(★ @agent\): 报告已写入 \/tmp\/x\.md/);
  assert.match(lines[2], /- api_token \(@auto\): PrintService 测试环境 token/);
  assert.ok(!provided.text.includes("done_note"), "done 状态不进目录");
  assert.equal(provided.version, 7, "版本必须回声 state.stateVersion，否则被判 stale");
  assert.equal(provided.status, "ok");
});

test("directory provider: empty store and list failure both yield undefined (不装懂)", async () => {
  const empty = await createNotesDirectoryProvider({
    notesStore: fakeNotesStore([]),
    runId: "run-1",
  })({ state: { stateVersion: 1 } });
  assert.equal(empty, undefined);
  const failing = await createNotesDirectoryProvider({
    notesStore: { list: async () => { throw new Error("disk gone"); } },
    runId: "run-1",
  })({ state: { stateVersion: 1 } });
  assert.equal(failing, undefined);
});

test("directory provider caps at 20 entries and truncates long summaries", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    key: `note_${index}`,
    state: "active",
    updated_at: new Date(Date.UTC(2026, 8, 16, 0, index)).toISOString(),
    current: { summary: "x".repeat(120) },
  }));
  const provided = await createNotesDirectoryProvider({
    notesStore: fakeNotesStore(many),
    runId: "run-1",
  })({ state: { stateVersion: 1 } });
  assert.equal(provided.text.split("\n").length, 21);
  assert.ok(provided.text.includes("…"));
});

test("run-state semantic block renders multi-line text (directory fits)", async () => {
  const deterministic = createDeterministicRunState({
    runId: "run-1",
    stateVersion: 3,
    rounds: 5,
    maxRounds: 20,
  });
  const state = withSemanticRunState(deterministic, {
    text: "[notes 小抄目录]\n- final_report (★ @agent): 报告\n- api_token (@auto): token",
    version: 3,
    status: "ok",
  });
  const rendered = renderRunState(state);
  assert.match(rendered, /\[notes 小抄目录\]/);
  assert.match(rendered, /- final_report \(★ @agent\)/);
  assert.match(rendered, /- api_token \(@auto\)/);
  // 必须是多行：条目各自成行（此前把换行压平，模型读不出条目边界）
  const lines = rendered.split("\n");
  assert.ok(lines.includes("[notes 小抄目录]"), "目录标题独占一行");
  assert.ok(lines.some((line) => line.startsWith("- final_report")), "条目独占一行");
  assert.ok(lines.some((line) => line.startsWith("- api_token")), "条目独占一行");
});

test("semantic text bound: >1200 chars truncated flag set", async () => {
  const deterministic = createDeterministicRunState({
    runId: "run-1",
    stateVersion: 1,
    rounds: 1,
    maxRounds: 5,
  });
  const state = withSemanticRunState(deterministic, {
    text: "y".repeat(1500),
    version: 1,
    status: "ok",
  });
  assert.equal(state.semantic.truncated, true);
  assert.ok(state.semantic.text.length <= 1200);
});

test("engine calls semanticStateProvider only at fold points (0 calls without fold)", async () => {
  let calls = 0;
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runToolLoop({
    provider,
    initialUserMessage: "hello",
    executeTool: async () => "unused",
    store: createMemoryTranscriptStore(),
    runId: "semantic-no-fold",
    semanticStateProvider: async () => {
      calls += 1;
      return undefined;
    },
  });
  assert.equal(calls, 0);
});
