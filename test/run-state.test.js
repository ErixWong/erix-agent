import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  boundRunState,
  createDeterministicRunState,
  renderRunState,
  RUN_STATE_MAX_CHARS,
  RUN_STATE_MAX_SERIALIZED_BYTES,
  appendRunStateToRequestView,
  upsertRunStateInMessages,
  validateRunState,
  withSemanticRunState,
} from "../src/run-state.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

test("run state carries the persistence bill so a mid-run crash does not lose it (issue #109 修正 4)", () => {
  const state = createDeterministicRunState({
    runId: "bill",
    unpersisted: [
      { ts: "2026-09-17T00:00:00.000Z", kind: "persistence_error", port: "notes", operation: "note_write", phase: "tool", fatal: false, repeat: 4, error: { name: "Error", message: "disk full" } },
      { ts: "2026-09-17T00:00:01.000Z", kind: "persistence_error", port: "transcript", operation: "appendRound", fatal: true, error: { name: "Error", message: "db down" } },
    ],
  });
  assert.equal(state.deterministic.errors.unpersisted.count, 2);
  assert.equal(state.deterministic.errors.unpersisted.items.length, 2);
  assert.equal(state.deterministic.errors.unpersisted.items[0].repeat, 4);
  assert.equal(state.deterministic.errors.unpersisted.items[1].fatal, true);
  // 渲染行只给条数，不把宿主错误正文灌进模型上下文
  const rendered = renderRunState(state);
  assert.match(rendered, /errors=0\/0\/2/u);
  assert.doesNotMatch(rendered, /disk full/u);

  // 条目数封顶，但总数不丢
  const many = createDeterministicRunState({
    runId: "bill-many",
    unpersisted: Array.from({ length: 40 }, (_unused, index) => ({
      ts: "2026-09-17T00:00:00.000Z",
      port: "notes",
      operation: `op-${index}`,
      error: { name: "Error", message: "boom" },
    })),
  });
  assert.equal(many.deterministic.errors.unpersisted.count, 40);
  assert.equal(many.deterministic.errors.unpersisted.items.length, 10);
});

test("run state is bounded and marked when truncated (no agent-side credential redaction)", () => {
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
  // issue #55：agent 层凭据启发式脱敏已退役，凭据样式的 semantic 文本原样渲染——
  // 防敏感信息到达上游 LLM 是 token hub 的职责，不是 run-state 的。
  const withSemantic = withSemanticRunState(state, {
    text: "Bearer sk-secret-value-123456789",
    version: 3,
  });
  const rendered = renderRunState(withSemantic);
  assert.ok(rendered.length <= RUN_STATE_MAX_CHARS);
  assert.match(rendered, /Bearer sk-secret-value-123456789/u);

  // 预算 400→1600 后上面的小 fixture 不再溢出，但截断路径仍必须可达：
  // 宿主 notes 目录形态的长 semantic 文本（1200 字上限）依然超出整块预算。
  const longState = withSemanticRunState(state, {
    text: "note-entry ".repeat(120),
    version: 3,
  });
  const longRendered = renderRunState(longState);

  assert.ok(
    longRendered.length <= RUN_STATE_MAX_CHARS,
    `rendered=${longRendered.length} > RUN_STATE_MAX_CHARS=${RUN_STATE_MAX_CHARS}`,
  );
  assert.match(longRendered, /\[run state truncated\]/u);
  assert.ok(longRendered.endsWith("[/run state]"), "closing marker must survive truncation");

  // 语义目录最长 1200 字符：整块必须放得下；行数封顶时截断必须可见
  const longSemantic = withSemanticRunState(state, {
    text: Array.from({ length: 200 }, (_unused, index) => `note line ${index}`).join("\n"),
    version: 3,
  });
  const longSemanticRendered = renderRunState(longSemantic);
  assert.ok(
    longSemanticRendered.length <= RUN_STATE_MAX_CHARS,
    `rendered=${longSemanticRendered.length} > RUN_STATE_MAX_CHARS=${RUN_STATE_MAX_CHARS}`,
  );
  assert.match(longSemanticRendered, /\.\.\. \(semantic lines truncated: \d+ more\)/u);
});

test("persisted run state is bounded and marked (semantic text kept verbatim, issue #55)", () => {
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
  // issue #55：不再脱敏——凭据样式的 semantic 文本原样持久化，也没有 redacted 字段。
  assert.match(JSON.stringify(state), /secret-value-should-not-persist/u);
  assert.equal(state.semantic.redacted, undefined);
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

test("validateRunState accepts the additive runRounds budget field", () => {
  const state = createDeterministicRunState({
    runId: "additive-budget",
    stateVersion: 1,
    rounds: 12,
    runRounds: 4,
    maxRounds: 20,
  });

  assert.equal(state.deterministic.budget.runRounds, 4);
  assert.equal(state.deterministic.budget.remainingRounds, 16);
  assert.equal(validateRunState(state).ok, true);
  // 旧（无 runRounds）持久化状态仍可读：缺省回落到 rounds
  const legacy = structuredClone(state);
  delete legacy.deterministic.budget.runRounds;
  assert.equal(validateRunState(legacy).ok, true);
  assert.match(renderRunState(legacy), /r=12\/20 left=16/u);
});

// issue #315：`state.json` 里那份 `compactionStats` 是只留最后 32 条的窗口，
// 而 run 返回值上那份是全量。窗口大小/丢弃条数/原本条数必须**写在同一份文件里**，
// 读者不读源码也能判断手里这份是全量还是尾巴（不许再靠人数列）。
const compactionStatFixture = (index) => ({
  compacted: true,
  foldedRounds: 1,
  tokensBefore: 1000 + index,
  tokensAfter: 100,
});

test("#315 compactionStatsWindow 与数组同时落盘：全量时 dropped=0，超窗时 dropped=total-limit", () => {
  const full = createDeterministicRunState({
    runId: "window-full",
    compactionStats: Array.from({ length: 5 }, (_unused, index) => compactionStatFixture(index)),
  });
  assert.deepEqual(full.deterministic.compactionStatsWindow, { limit: 32, dropped: 0, total: 5 });
  assert.equal(full.deterministic.compactionStats.length, 5);

  const windowed = createDeterministicRunState({
    runId: "window-cut",
    compactionStats: Array.from({ length: 40 }, (_unused, index) => compactionStatFixture(index)),
  });
  assert.deepEqual(windowed.deterministic.compactionStatsWindow, { limit: 32, dropped: 8, total: 40 });
  assert.equal(windowed.deterministic.compactionStats.length, 32);
  // 窗口留的是**尾巴**（不是头）——最后一个才是最近的账
  assert.equal(windowed.deterministic.compactionStats.at(-1).tokensBefore, 1039);
  assert.equal(validateRunState(windowed).ok, true);

  // 没有统计（非数组 / 空）时不出窗口账：0 条没有可截断的东西，缺席不是歧义
  assert.equal(
    createDeterministicRunState({ runId: "window-empty" }).deterministic.compactionStatsWindow,
    undefined,
  );
});

test("#315 序列化体积的第二道截断也改窗口账：数组切到 8 条时 limit/dropped 跟着改口", () => {
  const state = createDeterministicRunState({
    runId: "window-size-cut",
    compactionStats: Array.from({ length: 40 }, (_unused, index) => compactionStatFixture(index)),
  });
  // 撑爆 64KB：boundRunState 只负责 bounding，不重新归一化，所以这里直接挂大字段
  const inflated = {
    ...state,
    semantic: { status: "ok", text: "s".repeat(80_000), semanticStateVersion: 0 },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(inflated), "utf8") > RUN_STATE_MAX_SERIALIZED_BYTES);
  const bounded = boundRunState(inflated);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= RUN_STATE_MAX_SERIALIZED_BYTES);
  assert.equal(bounded.bounds.reason, "serialized_size");
  assert.equal(bounded.deterministic.compactionStats.length, 8);
  // 窗口账不能停在 32：它必须说真话（limit=8，丢 32 条，原本 40 条）
  assert.deepEqual(bounded.deterministic.compactionStatsWindow, { limit: 8, dropped: 32, total: 40 });
  assert.equal(validateRunState(bounded).ok, true);
});

test("#315 旧档没有 compactionStatsWindow 仍可读（validate 与 resume 都不判坏档）", async () => {
  const legacy = createDeterministicRunState({
    runId: "window-legacy",
    stateVersion: 2,
    rounds: 3,
    maxRounds: 1,
  });
  delete legacy.deterministic.compactionStatsWindow;
  assert.equal(legacy.deterministic.compactionStatsWindow, undefined);
  assert.equal(validateRunState(legacy).ok, true);

  const store = createMemoryTranscriptStore();
  await store.appendRound("window-legacy", {
    round: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "seed" }] }],
  });
  store.loadRunState = async () => legacy;
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    resume: true,
    completion: false,
    store,
    runId: "window-legacy",
    executeTool: async () => "unused",
  });
  assert.equal(result.runState.stateAvailability.status, "available");
  // 旧档可读；本次 run 没有产出统计（total = 0）⇒ 不出窗口账（缺席不是歧义）
  assert.equal(result.runState.deterministic.compactionStatsWindow, undefined);

  // 有、但形状坏了才判坏档：不拿半份窗口账去算削减
  const broken = structuredClone(legacy);
  broken.deterministic.compactionStatsWindow = { limit: "32", dropped: 0, total: 0 };
  assert.deepEqual(validateRunState(broken), {
    ok: false,
    status: "state_unavailable",
    reason: "missing_fields",
  });
});

test("#315 真跑一个 >32 条 compactionStats 的 run：<runId>.state.json 文件里直接看出丢了几条，run 返回值仍是全量", async () => {
  const toolResponse = (id) => ({
    content: [{ type: "tool_use", id, name: "work", input: { n: id } }],
    stopReason: "tool_use",
  });
  // 真落盘：断言读的是磁盘上的 `<runId>.state.json`，不是内存里的那个对象
  const dir = await makeTmp("erix-compaction-window-");
  const store = createFileTranscriptStore({ dir });
  const runId = "compaction-window-run";
  const result = await runDirect({
    provider: createFakeProvider([
      ...Array.from({ length: 40 }, (_unused, index) => toolResponse(`t-${index}`)),
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "start",
    // 每轮工具结果都不同，避免 stall 裁决提前收工（本用例要的是长 run，不是终止行为）
    executeTool: async (options) => `worked-${options?.id ?? "?"}`,
    completion: false,
    config: { folding: { context: { budgetTokens: 10 } } },
    maxRounds: 60,
    store,
    runId,
  });

  // ① run 返回值是全量（本单不改它）：真跑出 >32 条，否则这条用例是空转
  const total = result.compactionStats.length;
  assert.ok(total > 32, `run 返回值应有 >32 条 compactionStats，实际 ${total}`);

  // ② 磁盘上的 state.json 里直接能看出「有 N 条被丢弃」，两种口径的差值**就是** dropped
  const persisted = JSON.parse(await readFile(join(dir, `${runId}.state.json`), "utf8"));
  const window = persisted.deterministic.compactionStatsWindow;
  assert.ok(window, "state.json 必须自报窗口，不许再让读者读源码猜");
  assert.equal(window.limit, 32);
  assert.equal(window.total, total);
  assert.ok(window.total > window.limit);
  assert.equal(window.dropped, window.total - window.limit);
  assert.ok(window.dropped > 0);
  assert.equal(persisted.deterministic.compactionStats.length, window.limit);
  assert.equal(total - persisted.deterministic.compactionStats.length, window.dropped);
  // 窗口留的是尾巴：最后一条逐字相同（读侧按窗口理解就不会数错方向）
  assert.deepEqual(
    persisted.deterministic.compactionStats.at(-1),
    result.compactionStats.at(-1),
  );
  assert.equal(validateRunState(persisted).ok, true);
});

test("resume exposes unknown persisted schema instead of silently resetting it", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("unknown-schema", {
    round: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "resume" }] }],
  });
  store.loadRunState = async () => ({ schemaVersion: 99, deterministic: {} });

  const result = await runDirect({
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

test("truncated run state keeps the closing marker so replacement stays idempotent", () => {
  // 2026-09-18 全面评审 M2 回归：超预算时 END_MARKER 曾被截掉，
  // upsert 正则匹配不到旧块 → 第二次 upsert 追加第二个块（上下文累积）。
  const state = createDeterministicRunState({
    runId: "trunc-marker",
    stateVersion: 3,
    rounds: 9,
    maxRounds: 16,
    toolStats: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`very-long-tool-name-${i}-aaaaaaaaaaaaaaaa`, [20, 1]])),
    filesWritten: Array.from({ length: 8 }, (_, i) => `src/very/long/path/component-${i}/bbbbbbbbbbbbbbbbbbbb.js`),
    todo: { status: "active", items: Array.from({ length: 6 }, (_, i) => ({ id: `todo-item-${i}-cccccc`, status: "in_progress" })) },
  });
  const withSemantic = withSemanticRunState(state, {
    text: Array.from({ length: 16 }, (_, i) => `note-key-${i}: ${"value-".repeat(13)}`).join("\n"),
    semanticStateVersion: 1,
  });
  const rendered = renderRunState(withSemantic);

  assert.ok(rendered.length > 1000, "fixture should overflow the old 400 cap");
  assert.ok(rendered.endsWith("[/run state]"), "closing marker must survive truncation");

  const next = renderRunState({ ...withSemantic, stateVersion: 4 });
  const original = [{ role: "user", content: [{ type: "text", text: `摘要\n${rendered}` }] }];
  const once = upsertRunStateInMessages(original, next);
  const twice = upsertRunStateInMessages(once, next);

  assert.equal(
    (twice[0].content[0].text.match(/\[run state deterministic v/gu) ?? []).length,
    1,
    "repeated upserts must replace, not accumulate",
  );
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

test("run state request view appends without modifying persistent messages", () => {
  const rendered = "[run state deterministic v1]\n[/run state]";
  const original = [
    { role: "assistant", content: [{ type: "text", text: "先前回复" }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const view = appendRunStateToRequestView(original, rendered);
  assert.notEqual(view, original);
  assert.deepEqual(view.slice(0, -1), original);
  assert.deepEqual(view.at(-1), {
    role: "user",
    content: [{ type: "text", text: rendered }],
  });
  assert.deepEqual(original, [
    { role: "assistant", content: [{ type: "text", text: "先前回复" }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ]);
});

test("run state request view returns the original input for empty or invalid data", () => {
  const messages = [{ role: "user", content: "继续" }];
  assert.equal(appendRunStateToRequestView(messages, ""), messages);
  assert.equal(appendRunStateToRequestView(messages, 42), messages);
  assert.equal(appendRunStateToRequestView(null, "state"), null);
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
  const result = await runDirect({
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
  await runDirect({ capabilities: { ports: { strategy: strategy } },
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
    config: { folding: { context: { budgetTokens: 100 } } },
    store,
    runId: "resume-state",
  });

  const resumed = await runToolLoop({ capabilities: { ports: { strategy: strategy } },
    provider: createFakeProvider([
      { content: [{ type: "text", text: "resumed" }], stopReason: "end_turn" },
    ]),
    executeTool: async () => "unused",
    maxRounds: 3,
    completion: false,
    config: { folding: { context: { budgetTokens: 100 } } },
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

test("single-session runs keep both counters equal and drain remainingRounds monotonically", async () => {
  const store = createMemoryTranscriptStore();
  const budgets = [];
  const result = await runDirect({
    provider: createFakeProvider([
      {
        content: [{ type: "tool_use", id: "a", name: "work", input: { step: 1 } }],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "tool_use", id: "b", name: "work", input: { step: 2 } }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "work",
    executeTool: async () => "worked",
    maxRounds: 3,
    completion: false,
    store,
    runId: "budget-monotonic",
    capabilities: { hooks: { onRound: (record) => budgets.push(record.runState.deterministic.budget) } },
  });

  // 非 resume 单段调用：身份轮号与预算轮数恒等
  assert.deepEqual(
    budgets.map((budget) => [budget.rounds, budget.runRounds, budget.remainingRounds]),
    [[1, 1, 2], [2, 2, 1], [3, 3, 0]],
  );
  assert.deepEqual(
    budgets.map((budget) => budget.remainingRounds),
    [2, 1, 0],
  );
  assert.equal(result.termination.reason, "end_turn");
  assert.deepEqual(result.runState.deterministic.budget.runRounds, 3);
  assert.match(result.runState.rendered, /r=3\/3 left=0/u);
  assert.doesNotMatch(result.runState.rendered, /session=/u);
});
