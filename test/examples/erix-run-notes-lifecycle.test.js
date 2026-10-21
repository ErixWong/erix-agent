// issue #266：erix_run 必须调用 notes lifecycle.onRunComplete，否则落盘笔记永远停在 active。
//
// 判据映射（任务书要求 1-4）：
//   ① 成功终局 → active 变 done（文件 store：盘上状态；② ③ 见下）
//   ② 异常终局（内层抛错）→ 同样变 done
//   ③ 收尾自身抛错 / 返回 errors[] → 终局 ok/termination/usage 一字不动，且留痕在 payload 里可见
//   ④ 自定义 deps.createAssembly（无 notes 字段）→ 不调、不炸
//   ⑤ 未传 sessionDir（纯内存 notes store）→ 收口照样跑，断言方式是**观测 store 内状态**
//   ⑥ timeoutMs 到点（abort 终局）→ 收口照样跑（证明收口在公共 finally，不在某个出口里）
//
// 全离线：真 lib（src/index.js + bin/tools.js）+ 临时目录 + 桩 runLoop，不触网、不碰 ~/.erix。

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as binTools from "../../bin/tools.js";
import { createMemoryTranscriptStore } from "../../src/index.js";
import * as libIndex from "../../src/index.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";
import { makeTmp } from "../helpers/tmp.js";

async function tempDir(prefix = "erix-run-266-") {
  return makeTmp(prefix);
}

/** 真 lib 形状（与 loadErixAgent 的返回同构）。 */
function realLib(index = libIndex) {
  return {
    source: "file://real-lib",
    libEntry: "file:///fake/src/index.js",
    index,
    binTools,
  };
}

function fakeSlotResult() {
  return {
    slot: {
      endpoint: "https://relay.example/v1",
      model: "slot-model",
      apiKey: "k",
      contextWindowTokens: 200_000,
      maxOutputTokens: 4_096,
    },
    configPath: "/tmp/fake-erix-config.json",
  };
}

const CANNED_USAGE = { input_tokens: 11, output_tokens: 3, cacheRead: 0, cacheWrite: 0 };

/** 成功终局的引擎返回值（桩 runLoop 直接交回这个形状）。 */
function successResult() {
  return {
    finalText: "任务已完成",
    rounds: 2,
    truncated: false,
    usage: { ...CANNED_USAGE },
    termination: { reason: "end_turn" },
  };
}

/**
 * 桩 runLoop：先用**引擎拿到的那把 executeTool** 记一条笔记（走真 assembler），
 * 再按 outcome 决定终局（返回值 / 抛错 / 挂到 abort）。
 */
function stubRunLoop({ outcome = "success", noteKey = "k266", note = "nonce=266-lifecycle", probe } = {}) {
  return async (options) => {
    const written = await options.executeTool({
      id: "n1", name: "note_take", input: { key: noteKey, content: note },
    });
    assert.doesNotMatch(String(written), /^\s*错误/u, `前提：note_take 必须真写成功，实测 ${String(written).slice(0, 120)}`);
    if (typeof probe === "function") await probe(options);
    if (outcome === "throw") {
      const error = new Error("内层炸了-266");
      error.usage = { ...CANNED_USAGE };
      error.rounds = 2;
      throw error;
    }
    if (outcome === "abort") {
      return await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          error.usage = { ...CANNED_USAGE };
          error.rounds = 1;
          reject(error);
        }, { once: true });
      });
    }
    return successResult();
  };
}

/** 齐活的 deps：真 lib + 假 slot/provider + 内存 transcript + 桩 runLoop。 */
function makeDeps({ lib = realLib(), extra = {}, runLoop }) {
  return {
    env: {},
    home: "/tmp/fake-home",
    now: () => 1_700_000_000_000,
    loadLib: async () => lib,
    loadSlot: async () => fakeSlotResult(),
    createProvider: () => ({ model: "slot-model", chat: async () => ({ content: [], stopReason: "end_turn" }) }),
    createStore: () => createMemoryTranscriptStore(),
    runLoop,
    ...extra,
  };
}

/** 递归找出 sessionDir 下写着某个 key 的 notes 记录文件（不猜 file store 的目录布局）。 */
function findNoteRecord(root, key) {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (parsed?.key === key) return { file, record: parsed };
  }
  return undefined;
}

/** 用注入的内存 store 造一个「带 notes 的自定义装配」，好直接观测 store 内状态。 */
function notesAssembly({ lib = realLib(), runId, notesStore }) {
  const assembler = core.createInnerNotesTools({ lib, runId, notesStore });
  assert.ok(assembler, "前提：真 lib 必须导出 createBuiltinNotesTools");
  return {
    assembler,
    assembly: {
      tools: assembler.definitions,
      notes: assembler,
      executeTool: async (execution = {}) => String(await assembler.executors(
        execution.name,
        execution.input,
        { ...(execution.context ?? {}), toolUseId: execution.id },
      )),
    },
  };
}

async function listStates(store, scopeRef) {
  const states = {};
  for (const state of ["active", "done", "revoked"]) {
    states[state] = (await store.list({ scopeRef, filters: { state } })).length;
  }
  return states;
}

// ---------------------------------------------------------------------------
// ① 成功终局 → 落盘笔记 active 变 done
// ---------------------------------------------------------------------------

test("#266①：成功终局把 sessionDir 下的笔记从 active 收到 done", async () => {
  const sessionDir = await tempDir("session-");
  let stateWhileRunning;
  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-"), sessionDir },
    makeDeps({
      runLoop: stubRunLoop({
        noteKey: "k266-success",
        probe: async (options) => {
          // 前提：run 进行到一半时这条记录确实是 active（否则「变 done」这条断言是空的）
          stateWhileRunning = findNoteRecord(sessionDir, "k266-success")?.record?.state;
          assert.ok(options.tools.some((tool) => tool.name === "note_take"), "前提：note_* 在内层工具面里");
        },
      }),
    }),
  );

  assert.equal(stateWhileRunning, "active", "前提：run 中记录是 active");
  assert.equal(payload.ok, true);
  assert.equal(payload.termination.reason, "end_turn");
  assert.deepEqual(payload.diagnostics.notesLifecycle, { attempted: true, completed: 1, errors: [] });
  const found = findNoteRecord(sessionDir, "k266-success");
  assert.ok(found, "盘上必须还能找到这条记录（收口≠删除）");
  assert.equal(found.record.state, "done", "收口后盘上状态必须是 done");
});

// ---------------------------------------------------------------------------
// ② 异常终局 → 同样变 done（内存 store，观测 store 内状态）
// ---------------------------------------------------------------------------

test("#266②：内层抛错的终局也把笔记收到 done，且不影响 failed 终局的形状", async () => {
  const runId = "erix-run-266-error";
  const notesStore = core.createMemoryNotesStore();
  const { assembly } = notesAssembly({ runId, notesStore });
  const before = await listStates(notesStore, runId);
  assert.deepEqual(before, { active: 0, done: 0, revoked: 0 }, "前提：起点空");

  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({
      extra: { runId, createAssembly: () => assembly },
      runLoop: stubRunLoop({ outcome: "throw", noteKey: "k266-error" }),
    }),
  );

  assert.equal(payload.ok, false, "抛错终局不得被收口粉饰成成功");
  assert.equal(payload.termination.reason, "failed");
  assert.equal(payload.error.message, "内层炸了-266", "原异常仍是主结果");
  assert.deepEqual(payload.diagnostics.notesLifecycle, { attempted: true, completed: 1, errors: [] });
  assert.deepEqual(await listStates(notesStore, runId), { active: 0, done: 1, revoked: 0 },
    "异常终局也必须收口（active → done）");
});

// ---------------------------------------------------------------------------
// ③ 收尾自身失败 → 终局一字不动，只在 payload 里留痕
// ---------------------------------------------------------------------------

test("#266③a：onRunComplete 抛错 → ok/termination/usage 一字不动，错误在 diagnostics 里可见", async () => {
  const runId = "erix-run-266-hookthrows";
  const notesStore = core.createMemoryNotesStore();
  const { assembler, assembly } = notesAssembly({ runId, notesStore });
  // 把钩子换成必抛错的假钩子（只改 lifecycle，工具面保持真的）
  assembly.notes = {
    ...assembler,
    lifecycle: {
      onRunComplete: async () => { throw new Error("boom-266"); },
    },
  };
  const progressLines = [];

  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({
      extra: { runId, createAssembly: () => assembly, onProgress: (line) => progressLines.push(line) },
      runLoop: stubRunLoop({ noteKey: "k266-hookthrows" }),
    }),
  );

  // 终局一字不动
  assert.equal(payload.ok, true, "收尾失败不得把成功终局改成失败");
  assert.deepEqual(payload.termination, { reason: "end_turn" }, "termination 一字不动");
  assert.deepEqual(payload.usage, CANNED_USAGE, "usage 一字不动");
  assert.equal(payload.finalText, "任务已完成");
  // 留痕可见（不是静默丢弃）
  assert.equal(payload.diagnostics.notesLifecycle.attempted, true);
  assert.deepEqual(payload.diagnostics.notesLifecycle.errors, [
    { operation: "notes_lifecycle", message: "boom-266" },
  ]);
  assert.equal(payload.diagnostics.notesLifecycle.completed, 0);
  // 留痕走 diagnostics，不冒充模型输出
  assert.doesNotMatch(payload.finalText, /boom-266/u, "收尾错误不得塞进 finalText");
  assert.match(core.formatPayloadForModel(payload), /notes 收尾失败（notes_lifecycle）：boom-266/u);
  assert.match(core.formatPayloadForModel(payload), /notesClosed=0\/errors=1/u);
  assert.ok(progressLines.some((line) => line.includes("notes 收尾失败") && line.includes("boom-266")),
    "进度通道也要留痕（宿主当场看得见）");
  // 钩子确实没成功：笔记留在 active（说明留痕不是「收口成功了还报错」）
  assert.deepEqual(await listStates(notesStore, runId), { active: 1, done: 0, revoked: 0 });
});

test("#266③b：onRunComplete 返回 errors[]（store 层失败不抛）→ 同样只留痕、不改终局", async () => {
  const runId = "erix-run-266-errors";
  const notesStore = core.createMemoryNotesStore();
  const { assembler, assembly } = notesAssembly({ runId, notesStore });
  assembly.notes = {
    ...assembler,
    lifecycle: {
      onRunComplete: async () => ({
        completed: { status: "found", completed: 0 },
        errors: [{ operation: "notes_complete_run", error: new Error("disk-quota-266") }],
      }),
    },
  };

  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({ extra: { runId, createAssembly: () => assembly }, runLoop: stubRunLoop({ noteKey: "k266-errors" }) }),
  );

  assert.equal(payload.ok, true);
  assert.equal(payload.termination.reason, "end_turn");
  assert.deepEqual(payload.usage, CANNED_USAGE);
  assert.deepEqual(payload.diagnostics.notesLifecycle.errors, [
    { operation: "notes_complete_run", message: "disk-quota-266" },
  ], "errors[] 必须逐条转成可 JSON 化的留痕（Error 对象不能直接进 payload）");
  assert.ok(JSON.stringify(payload).includes("disk-quota-266"), "留痕必须能随 payload 序列化交回宿主");
});

// ---------------------------------------------------------------------------
// ④ 自定义装配没有 notes → 不调、不炸
// ---------------------------------------------------------------------------

test("#266④：deps.createAssembly 无 notes 字段 → 不调收尾也不炸，也不假留痕", async () => {
  let executeCalls = 0;
  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({
      extra: {
        createAssembly: (input) => {
          assert.equal(typeof input.runId, "string", "自定义装配仍要拿到 runId");
          return { tools: [], executeTool: async () => { executeCalls += 1; return "tool-ok"; } };
        },
      },
      // 这个装配里没有 note_*，用一条只调 executeTool 的桩 loop
      runLoop: async (options) => {
        assert.equal(await options.executeTool({ id: "t1", name: "exec", input: {} }), "tool-ok");
        return successResult();
      },
    }),
  );

  assert.equal(executeCalls, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.termination.reason, "end_turn");
  assert.equal(payload.diagnostics.notesLifecycle, undefined, "没装配 notes 就不该有收尾留痕");
  assert.doesNotMatch(core.formatPayloadForModel(payload), /notesClosed/u);
});

test("#266④b：notes 字段形状不全（undefined/null/{}/无 onRunComplete）→ 不调不炸、不假留痕", async () => {
  for (const notes of [undefined, null, {}, { lifecycle: {} }, { lifecycle: { onRunComplete: "nope" } }]) {
    const shaped = await core.runErixRun(
      { task: "收口测试", cwd: await tempDir("cwd-") },
      makeDeps({
        extra: { createAssembly: () => ({ tools: [], executeTool: async () => "tool-ok", notes }) },
        runLoop: async (options) => {
          assert.equal(await options.executeTool({ id: "t1", name: "exec", input: {} }), "tool-ok");
          return successResult();
        },
      }),
    );
    assert.equal(shaped.ok, true, `收尾不得把 notes=${JSON.stringify(notes)} 的 run 带成失败`);
    assert.equal(shaped.diagnostics.notesLifecycle, undefined);
    assert.doesNotMatch(core.formatPayloadForModel(shaped), /notesClosed/u);
  }
});

test("#266④c：整个自定义装配返回 undefined → 终局仍是结构化载荷，收尾不额外炸", async () => {
  // 装配缺失本身是旧的装配问题（buildLoopOptions 要 tools），不归 #266 管；
  // 这里只钉住：收尾路径不得把它带成未捕获异常，也不得假留痕。
  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({
      extra: { createAssembly: () => undefined },
      runLoop: async () => successResult(),
    }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.termination.reason, "failed");
  assert.equal(payload.diagnostics.notesLifecycle, undefined);
  assert.equal(typeof payload.error?.message, "string");
});

// ---------------------------------------------------------------------------
// ⑤ 未传 sessionDir（纯内存 store）：收口照样跑，断言 store 内状态
// ---------------------------------------------------------------------------

test("#266⑤：无 sessionDir 走内存 notes store，收口照样把 store 里的记录改成 done", async () => {
  const runId = "erix-run-266-memory";
  const seen = {};
  const index = {
    ...libIndex,
    createBuiltinNotesTools: (options = {}) => {
      // 只观测，不改行为：把 core 自己造的 store 与 assembler 抓在手上，好断言 store 内状态。
      seen.notesStore = options.notesStore;
      seen.assembler = libIndex.createBuiltinNotesTools(options);
      return seen.assembler;
    },
  };

  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-") },
    makeDeps({
      lib: realLib(index),
      extra: { runId },
      runLoop: stubRunLoop({ noteKey: "k266-memory" }),
    }),
  );

  assert.equal(payload.ok, true);
  assert.equal(typeof seen.assembler, "object", "前提：不传 createAssembly 走默认装配时 notes 真被装配");
  assert.ok(seen.notesStore, "前提：无 sessionDir 时 core 自己造的是内存 store（不落 ~/.erix）");
  assert.equal(typeof seen.notesStore.purge, "function", "前提：抓到的就是 NotesStore 端口");
  assert.deepEqual(payload.diagnostics.notesLifecycle, { attempted: true, completed: 1, errors: [] });
  assert.deepEqual(await listStates(seen.notesStore, runId), { active: 0, done: 1, revoked: 0 },
    "内存 store 的 complete 也必须被调到（观测 store，不观测盘上文件）");
  // 收口后 note_list 默认（只列 active）就看不到东西了——这正是 #266 的症状反面对照
  const listed = String(await seen.assembler.executors("note_list", {}, {}));
  assert.doesNotMatch(listed, /k266-memory/u, "收口后 note_list 默认不再列出该 key（active 已空）");
});

// ---------------------------------------------------------------------------
// ⑥ timeout 到点（abort 终局）：收口在公共 finally，不在某个成功出口里
// ---------------------------------------------------------------------------

test("#266⑥：timeoutMs 到点 abort 的终局同样收口", async () => {
  const runId = "erix-run-266-timeout";
  const notesStore = core.createMemoryNotesStore();
  const { assembly } = notesAssembly({ runId, notesStore });
  const started = Date.now();

  const payload = await core.runErixRun(
    { task: "收口测试", cwd: await tempDir("cwd-"), timeoutMs: core.MIN_TIMEOUT_MS },
    makeDeps({
      extra: { runId, createAssembly: () => assembly },
      runLoop: stubRunLoop({ outcome: "abort", noteKey: "k266-timeout" }),
    }),
  );

  assert.equal(payload.timeout, true, "前提：这确实是超时终局");
  assert.equal(payload.aborted, true);
  assert.equal(payload.ok, false);
  assert.ok(Date.now() - started >= core.MIN_TIMEOUT_MS - 50, `定时器该到点（实测 ${Date.now() - started}ms）`);
  assert.deepEqual(payload.diagnostics.notesLifecycle, { attempted: true, completed: 1, errors: [] });
  assert.deepEqual(await listStates(notesStore, runId), { active: 0, done: 1, revoked: 0 });
});
