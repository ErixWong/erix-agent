// ADR-015 Phase 3：notes 小抄目录 → semantic 槽位 → run-state 块
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import {
  createDeterministicRunState,
  renderRunState,
  withSemanticRunState,
} from "../src/run-state.js";
import {
  createBuiltinNotesTools,
} from "../src/tools/notes.js";
import { createFileNotesStore } from "../src/store/notes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

// 真实记录形态：source 在 current.provenance.source（writeNote 构造），
// 顶层没有 source 字段——旧 fake 的顶层 source 正是评审抓到的字段错位。
const RECORDS = [
  {
    key: "final_report",
    state: "active",
    pinned: true,
    updated_at: "2026-09-16T01:00:00.000Z",
    current: { summary: "报告已写入 /tmp/x.md", provenance: { source: "agent" } },
  },
  {
    key: "api_token",
    state: "active",
    updated_at: "2026-09-16T00:30:00.000Z",
    current: { summary: "PrintService 测试环境 token", provenance: { source: "auto" } },
  },
  {
    key: "done_note",
    state: "done",
    current: { summary: "已完成的不该出现" },
  },
];

function fakeNotesStore(records) {
  // 创建期 assertNotesStore 要求完整端口（issue #67）：fake 只需 list 生效。
  // 契约收窄（ADR-018 D3 决策反转）：list 返回朴素数组，不再返回分页页面对象。
  return {
    list: async () => structuredClone(records),
    read: async () => undefined,
    write: async () => {},
    complete: async () => ({ status: "found", completed: 0 }),
    revoke: async () => ({ status: "missing", revoked: 0 }),
    purge: async () => ({ status: "found", scanned: 0, purged: 0 }),
  };
}

function directoryProvider(notesStore, runId = "run-1") {
  return createBuiltinNotesTools({ notesStore, runId }).semanticStateProvider;
}

test("directory provider: active notes rendered pinned-first with source markers", async () => {
  const provided = await directoryProvider(fakeNotesStore(RECORDS))({ state: { stateVersion: 7 } });
  const lines = provided.text.split("\n");
  assert.equal(lines[0], "[notes 小抄目录]（note_read key=... 取全文）");
  assert.match(lines[1], /- final_report \(★ @agent\): 报告已写入 \/tmp\/x\.md/);
  assert.match(lines[2], /- api_token \(@auto\): PrintService 测试环境 token/);
  assert.ok(!provided.text.includes("done_note"), "done 状态不进目录");
  assert.equal(provided.version, 7, "版本必须回声 state.stateVersion，否则被判 stale");
  assert.equal(provided.status, "ok");
});

test("directory provider: real file-store integration renders source markers and artifact placeholder", async () => {
  const directory = await makeTmp("erix-notes-directory-");
  try {
    const notesStore = createFileNotesStore({ dir: directory });
    const builtin = createBuiltinNotesTools({ notesDir: directory, notesStore, runId: "dir-run" });
    // 真实写入：agent 笔记、历史 auto 记录（ADR-016：recordAutoCapture 已删，
    // 直接写 store 构造 auto 源的存量数据）、artifact-only 笔记（无 content）
    await builtin.executeTool("note_take", { key: "agent_note", content: "人工记录的值" });
    await notesStore.write({
      scope: "run",
      scopeRef: "dir-run",
      key: "auto_note",
      record: {
        key: "auto_note",
        scope: "run",
        scopeRef: "dir-run",
        current: {
          content: "自动捕获的 token",
          provenance: { source: "auto", verified: true, ts: "2026-09-15T02:00:00.000Z" },
          ts: "2026-09-15T02:00:00.000Z",
        },
        superseded: [],
        folded: 0,
        pinned: false,
        tags: [],
        relevance: 0.8,
        state: "active",
        created_at: "2026-09-15T02:00:00.000Z",
        updated_at: "2026-09-15T02:00:00.000Z",
      },
    });
    await builtin.executeTool("note_take", {
      key: "artifact_note",
      artifactRef: { archivePath: "/tmp/out/report.json", locator: "$.total" },
    });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 3 } });
    assert.equal(provided.status, "ok");
    assert.equal(provided.version, 3);
    assert.match(provided.text, /- agent_note \(@agent\): 人工记录的值/);
    assert.match(provided.text, /- auto_note \(@auto\): 自动捕获的 token/);
    assert.match(provided.text, /- artifact_note \(@agent\): artifact 引用/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory provider: empty store and list failure both yield undefined (不装懂)", async () => {
  const empty = await directoryProvider(fakeNotesStore([]))({ state: { stateVersion: 1 } });
  assert.equal(empty, undefined);
  const failingStore = fakeNotesStore([]);
  failingStore.list = async () => { throw new Error("disk gone"); };
  const failing = await directoryProvider(failingStore)({ state: { stateVersion: 1 } });
  assert.equal(failing, undefined);
});

test("directory provider caps at 20 entries and truncates long summaries", async () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    key: `note_${index}`,
    state: "active",
    updated_at: new Date(Date.UTC(2026, 8, 16, 0, index)).toISOString(),
    current: { summary: "x".repeat(120) },
  }));
  const provided = await directoryProvider(fakeNotesStore(many))({ state: { stateVersion: 1 } });
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
  await runDirect({
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

// ---------------------------------------------------------------------------
// issue #570：note_take 的 summary 在目录里的两面。
//   ① 有 summary ⇒ 目录行就是 summary（不再被「正文首行截 60 字符」吃掉主题）；
//   ② 没 summary ⇒ 目录输出**逐字等于今天**（下面那格把整段文本冻成字面量，
//      就是「对拍」，不是重写期望值）。
// 目录的 20 条上限、pinned → updated_at 排序、60 字符窗口、artifact 占位符都
// 不动：本单只把 summary 这条写入路径接上。
// ---------------------------------------------------------------------------

// 真机形态：首行 107 字符，60 字符窗口被 uuid 与时刻占满，「主题=」在窗口之外。
const FOLDING_CONTENT = "折走存档：第 12 次折叠（run 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b，"
  + "2026-10-29T03:14:15.926Z）：主题=note_take 补 summary 写入口";
const FOLDING_SUMMARY = "第 12 次折叠：note_take 补 summary 写入口";

function lineOf(text, key) {
  return text.split("\n").find((line) => line.startsWith(`- ${key} `));
}

test("directory shows summary instead of the content's truncated first line", async () => {
  const directory = await makeTmp("erix-notes-summary-dir-");
  try {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "summary-dir-run" });
    // 同一个正文写两条：一条带 summary，一条不带——差别只可能来自 summary。
    await builtin.executeTool("note_take", {
      key: "with_summary",
      content: FOLDING_CONTENT,
      summary: FOLDING_SUMMARY,
    });
    await builtin.executeTool("note_take", { key: "without_summary", content: FOLDING_CONTENT });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(provided.status, "ok");

    assert.equal(
      lineOf(provided.text, "with_summary"),
      `- with_summary (@agent): ${FOLDING_SUMMARY}`,
      "有 summary ⇒ 目录行就是 summary",
    );
    const fallback = lineOf(provided.text, "without_summary");
    assert.equal(
      fallback,
      "- without_summary (@agent): 折走存档：第 12 次折叠（run 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b，2026-…",
      "无 summary ⇒ 仍是正文首行截 60 字符（既有兜底逐字不变）",
    );
    // 主题在 60 字符窗口之外：不带 summary 的那行看不到它，带的那行才看得到。
    assert.equal(fallback.includes("主题="), false);
    assert.equal(lineOf(provided.text, "with_summary").includes("主题="), false);
    assert.equal(provided.text.includes("主题=note_take"), false, "正文全文不进目录");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory output without any summary is byte-identical to the pre-#570 render", async () => {
  const directory = await makeTmp("erix-notes-summary-frozen-");
  try {
    const store = createFileNotesStore({ dir: directory });
    const record = (key, current, updatedAt) => ({
      key,
      scope: "run",
      scopeRef: "frozen-run",
      current: { ...current, provenance: { source: "agent" }, ts: updatedAt },
      superseded: [],
      folded: 0,
      pinned: false,
      tags: [],
      relevance: 0.5,
      state: "active",
      created_at: updatedAt,
      updated_at: updatedAt,
    });
    // 三条都不带 summary：长正文（要截断）、短正文、artifact-only（占位符）。
    await store.write({
      scope: "run",
      scopeRef: "frozen-run",
      key: "long_body",
      record: record("long_body", { content: FOLDING_CONTENT }, "2026-10-29T03:00:00.000Z"),
    });
    await store.write({
      scope: "run",
      scopeRef: "frozen-run",
      key: "short_body",
      record: record("short_body", { content: "短正文" }, "2026-10-29T02:00:00.000Z"),
    });
    await store.write({
      scope: "run",
      scopeRef: "frozen-run",
      key: "artifact_only",
      record: record("artifact_only", { artifactRef: { archivePath: "/tmp/out.json" } }, "2026-10-29T01:00:00.000Z"),
    });
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "frozen-run" });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 4 } });
    assert.equal(provided.version, 4);
    assert.equal(provided.status, "ok");
    // 冻结字面量 = #570 之前的渲染输出，一个字节都不许动。
    assert.equal(
      provided.text,
      [
        "[notes 小抄目录]（note_read key=... 取全文）",
        "- long_body (@agent): 折走存档：第 12 次折叠（run 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b，2026-…",
        "- short_body (@agent): 短正文",
        "- artifact_only (@agent): artifact 引用",
      ].join("\n"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory keeps summary-first even when the summary itself exceeds the 60-char window", async () => {
  const directory = await makeTmp("erix-notes-summary-long-");
  try {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "summary-long-run" });
    const longSummary = "折叠主题".repeat(20);
    assert.ok(longSummary.length > 60 && longSummary.length <= 120);
    await builtin.executeTool("note_take", {
      key: "long_summary",
      content: "正文首行不该出现",
      summary: longSummary,
    });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    const line = lineOf(provided.text, "long_summary");
    assert.equal(line, `- long_summary (@agent): ${longSummary.slice(0, 60)}…`);
    assert.equal(line.includes("正文首行不该出现"), false, "summary 优先，正文不参与渲染");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory shows summary for an artifact-only note instead of the artifact placeholder", async () => {
  const directory = await makeTmp("erix-notes-summary-artifact-");
  try {
    const builtin = createBuiltinNotesTools({ notesDir: directory, runId: "summary-artifact-run" });
    await builtin.executeTool("note_take", {
      key: "artifact_with_summary",
      artifactRef: { archivePath: "/tmp/out/report.json", locator: "$.total" },
      summary: "报告 JSON 的 total 字段",
    });
    await builtin.executeTool("note_take", {
      key: "artifact_without_summary",
      artifactRef: { archivePath: "/tmp/out/report.json", locator: "$.total" },
    });
    const provided = await builtin.semanticStateProvider({ state: { stateVersion: 1 } });
    assert.equal(
      lineOf(provided.text, "artifact_with_summary"),
      "- artifact_with_summary (@agent): 报告 JSON 的 total 字段",
    );
    assert.equal(
      lineOf(provided.text, "artifact_without_summary"),
      "- artifact_without_summary (@agent): artifact 引用",
      "无 summary 的 artifact-only 条目仍是既有占位符",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
