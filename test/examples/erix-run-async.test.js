// issue #234：erix_run 异步执行面的离线单测（派工即返回句柄 / status→result 生命周期 /
// cancel 终局 aborted / status.json 落盘 / 投递去重 / parent-wake 两条分支 + pending 窗口 +
// reload 安全 / run 级看门狗 / quiet 唤醒策略）。
// issue #654：末尾一节把「投递可观测性」与「按会话隔离投递句柄」也钉在这里（见那节的节头注释）。
//
// 全部离线：内层 run 走注入的 runJob（或假 lib + 假 provider 的真 runToolLoop），
// cwd/home/sessionDir 一律注入临时目录 —— 不碰真实 ~/.erix，不触网。
//
// 机制出处：docs/research/2026-10-13-pi-subagents-async-attribution.md（照 pi-subagents 的逐行实现）

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createFileTranscriptStore,
  createJsonFileModelConfigProvider,
  createMemoryTranscriptStore,
  runToolLoop,
} from "../../src/index.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";
import * as jobsApi from "../../examples/pi-extension/erix-run-jobs.js";
import {
  COMPLETION_SEND_TTL_MS,
  NOTIFY_RETRY_DELAYS_MS,
  createAsyncJobRegistry,
  createAsyncRuntime,
  createCompletionSendRegistry,
  jobView,
  statusFilePath,
  writeStatusFile,
} from "../../examples/pi-extension/erix-run-jobs.js";
import {
  PARENT_WAKE_TEXT,
  WAKE_PENDING_MS,
  createParentWake,
} from "../../examples/pi-extension/erix-run-parent-wake.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { makeTmp } from "../helpers/tmp.js";
import { formatAsyncResult } from "../../examples/pi-extension/erix-run-format.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 同步结果的字段全集（测试侧从 jobs 导出的派生表取，① 那条断言负责验它没骗人）。 */
const SYNC_FIELDS = jobsApi.SYNC_RESULT_FIELDS;

async function tempDir(prefix = "erix-run-async-") {
  return makeTmp(prefix);
}

async function waitUntil(predicate, { timeoutMs = 3_000, stepMs = 5, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const P_OK = {
  ok: true,
  finalText: "任务已完成：改好了",
  rounds: 3,
  truncated: false,
  usage: { input_tokens: 11, output_tokens: 4 },
  termination: { reason: "end_turn" },
  timeout: false,
  aborted: false,
  artifacts: { transcriptPath: null, judgeLogPath: null },
  extensionCount: 0,
  maxExtensions: 0,
  resumable: false,
};

/** 可控延迟的 runJob：派工必须不等它。`release()` 在建好就可调，不必等 runJob 起跑。 */
function gatedJob(extra = {}) {
  const state = { started: 0, settled: 0, signals: [] };
  let unblock = null;
  const gate = new Promise((resolve) => { unblock = resolve; });
  state.release = () => unblock();
  state.job = async (params, opts) => {
    state.started += 1;
    state.signals.push(opts.signal);
    await gate;
    state.settled += 1;
    return { ...P_OK, ...(extra.payload ?? {}) };
  };
  return state;
}

async function makeRuntime({ job, sent, registry = createAsyncJobRegistry(), sendRegistry = createCompletionSendRegistry(), now, extra = {} } = {}) {
  const home = await tempDir("erix-run-async-home-");
  const runtime = createAsyncRuntime({
    home,
    registry,
    sendRegistry,
    ...(now === undefined ? {} : { now }),
    notify: (runJob, content, options) => {
      sent.push({ runId: runJob.runId, content, ...options });
      return true;
    },
    ...(job === undefined ? {} : { runJob: job }),
    ...extra,
  });
  return { runtime, home, registry, sendRegistry, sent };
}

/**
 * 假时钟（issue #659 第 1 格）：投递重试的三档是 5s / 10s / 30s，真等一轮要 45 秒。
 *
 * `setTimeout` / `clearTimeout` / `now` 三个注进 `createAsyncRuntime`（看门狗与重试共用同一对），
 * 所以 `tick()` 推的是**真代码路径**，不是重写一份重试逻辑。
 */
function fakeClock(start = 1_000_000) {
  let current = start;
  let seq = 0;
  /** @type {Map<number, {fn:Function, at:number, delay:number}>} */
  const timers = new Map();
  return {
    timers,
    now: () => current,
    setTimeout: (fn, delay) => {
      seq += 1;
      timers.set(seq, { fn, at: current + delay, delay });
      return seq;
    },
    clearTimeout: (id) => { timers.delete(id); },
    /** 还挂着的定时器延迟（升序）：钉「档位」用。 */
    pendingDelays: () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b),
    /** 推到**最早**那个定时器并执行它；一个都没有就返回 false。 */
    tick() {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) return false;
      const [id, timer] = next;
      timers.delete(id);
      current = timer.at;
      timer.fn();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// R1：async 参数（默认 false = 同步语义逐字不变）
// ---------------------------------------------------------------------------

test("#234 R1：不传 async / async:false 都走同步语义（返回的是完整终局载荷，不是句柄）", async () => {
  const sent = [];
  const { runtime } = await makeRuntime({ job: async () => ({ ...P_OK }), sent });

  for (const raw of [{ task: "t", cwd: repoRoot }, { task: "t", cwd: repoRoot, async: false }]) {
    const outcome = await runtime.dispatch(raw, {});
    assert.equal(outcome.kind, "sync", `${JSON.stringify(raw)} 必须是同步分支`);
    assert.equal(outcome.payload.ok, true);
    assert.equal(outcome.payload.termination.reason, "end_turn");
    // 同步面一个 job 也不进注册表（否则 async:false 也留下了状态）
    assert.equal(runtime.registry.size, 0, "同步分支不落异步注册表");
  }
  assert.deepEqual(sent, [], "同步分支不发完成通知（它本来就是自己等回来的）");
});

test("#234 R1：async:true 立即返回句柄，且返回时内层 run 还没结束", async () => {
  const sent = [];
  const job = gatedJob();
  const { runtime, registry } = await makeRuntime({ job: job.job, sent });
  const sessionDir = await tempDir("erix-run-async-dir-");

  const startedAt = Date.now();
  const outcome = await runtime.dispatch({
    task: "改点东西", cwd: repoRoot, sessionDir, async: true, maxRounds: 6, timeoutMs: core.MIN_TIMEOUT_MS,
  }, {});
  const returnedAt = Date.now();

  assert.equal(outcome.kind, "started");
  assert.ok(returnedAt - startedAt < 1_000, `派工必须秒级返回，实测 ${returnedAt - startedAt}ms`);
  assert.equal(job.settled, 0, "返回时内层 run 一个字节都还没跑完（这是本单的核心主张）");
  // 再给一个宏任务：后台仍未结束、状态仍是 running（证明定时器与 run 都真的活在 execute 之外）
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.settled, 0, "过了一个宏任务仍未结束");
  assert.equal(runtime.registry.get(outcome.handle.runId).status, "running");
  assert.deepEqual(
    Object.keys(outcome.handle).sort(),
    ["cwd", "maxRounds", "model", "quiet", "runId", "sessionDir", "status", "statusPath", "timeoutMs"],
  );
  assert.equal(outcome.handle.status, "running");
  assert.equal(outcome.handle.cwd, repoRoot);
  assert.equal(outcome.handle.maxRounds, 6);
  assert.equal(outcome.handle.model, null, "没传 model 就是「用配置槽位的模型」，不编一个名字");
  assert.equal(outcome.handle.timeoutMs, core.MIN_TIMEOUT_MS);
  assert.equal(outcome.handle.sessionDir, sessionDir);
  assert.equal(
    outcome.handle.statusPath,
    path.join(sessionDir, "outputs", outcome.handle.runId, "status.json"),
    "status.json 与 judge.log 同一棵树（#207 已有布局，不新造一棵）",
  );

  // status → 还在跑（内层已被排上微任务：此时已起跑但没结束）
  await waitUntil(() => job.started === 1, { label: "inner run started after the handle returned" });
  assert.equal(job.settled, 0, "查状态时内层仍未结束");
  const running = runtime.act({ action: "status", runId: outcome.handle.runId });
  assert.equal(running.kind, "status");
  assert.equal(running.view.status, "running");
  assert.equal(running.view.termination, null, "没终局就不替引擎发明一个 termination.reason");

  // 放行 → 终局
  job.release();
  await waitUntil(() => registry.get(outcome.handle.runId).status === "completed", { label: "completed" });
  const done = runtime.act({ action: "result", runId: outcome.handle.runId });
  assert.equal(done.kind, "result");
  assert.equal(done.view.status, "completed");
  // R2：result 必须回终局四件套 + #207 R4 的 artifacts
  assert.equal(done.view.termination.reason, "end_turn");
  assert.equal(done.view.truncated, false);
  assert.equal(done.view.rounds, 3);
  assert.deepEqual(done.view.usage, { input_tokens: 11, output_tokens: 4 });
  assert.deepEqual(done.view.artifacts, { transcriptPath: null, judgeLogPath: null });
  assert.equal(done.view.ok, true);
  assert.equal(done.view.resumable, false);
  assert.equal(sent.length, 1, "完成只通知一次");
  assert.match(sent[0].content, new RegExp(`\\[erix_run ${outcome.handle.runId}\\] completed`, "u"));
  assert.equal(sent[0].triggersTurn, true, "quiet 缺省时成功完成也唤醒");

  // 盘上的 status.json 与内存视图一致（查询侧两条路同一形状）
  const disk = JSON.parse(readFileSync(outcome.handle.statusPath, "utf8"));
  assert.equal(disk.status, "completed");
  assert.equal(disk.termination.reason, "end_turn");
  assert.deepEqual(disk.usage, { input_tokens: 11, output_tokens: 4 });
  assert.equal(disk.rounds, 3);
  assert.equal(disk.truncated, false);
  assert.deepEqual(disk.artifacts, { transcriptPath: null, judgeLogPath: null });
});

test("#234 R6：不传 sessionDir 的异步 run 不落盘（内存可查，句柄里 statusPath 是 null）", async () => {
  const home = await tempDir("erix-run-async-nohome-");
  const dir = await tempDir("erix-run-async-nodir-");
  const job = gatedJob();
  const runtime = createAsyncRuntime({ home, registry: createAsyncJobRegistry(), runJob: job.job, notify: () => true });
  const { handle } = runtime.start({ task: "t", cwd: dir, async: true });
  assert.equal(handle.statusPath, null);
  assert.deepEqual(readdirSync(dir), [], "工作目录里没有 status.json");
  assert.deepEqual(readdirSync(home), [], "注入的 home 下也没建东西（不污染 ~/.erix）");
  assert.equal(runtime.act({ action: "status", runId: handle.runId }).view.status, "running");
  job.release();
  await waitUntil(() => runtime.registry.get(handle.runId).status === "completed");
  assert.deepEqual(readdirSync(dir), [], "终局也不该凭空造目录");
});

// ---------------------------------------------------------------------------
// R2：action 面
// ---------------------------------------------------------------------------

test("#234 R2：action:list / 未知 runId / 缺 runId 的形状", async () => {
  const job = gatedJob();
  const { runtime } = await makeRuntime({ job: job.job, sent: [] });
  const a = runtime.start({ task: "a", cwd: repoRoot, async: true }).handle;
  const b = runtime.start({ task: "b", cwd: repoRoot, async: true, quiet: true }).handle;

  const list = runtime.act({ action: "list" });
  assert.equal(list.kind, "list");
  assert.equal(list.active, 2);
  assert.deepEqual(list.jobs.map((entry) => entry.runId).sort(), [a.runId, b.runId].sort());
  assert.deepEqual(Object.keys(list.jobs[0]).sort(), [
    "createdAt", "cwd", "elapsedMs", "finishedAt", "model", "ok", "rounds", "runId",
    "sessionDir", "status", "statusPath", "termination",
  ]);

  assert.equal(runtime.act({ action: "status", runId: "no-such-run" }).kind, "unknown-run");
  assert.equal(runtime.act({ action: "cancel" }).kind, "error", "cancel 没给 runId 要当场报");
  assert.equal(runtime.act({ action: "cancel" }).code, "bad_params");
  assert.equal(runtime.act({ action: "result", runId: "no-such-run" }).kind, "unknown-run");

  job.release();
  await waitUntil(() => runtime.act({ action: "list" }).active === 0);
  assert.equal(runtime.act({ action: "list" }).active, 0);
});

test("#234 R2：跨 /reload 查询 —— 内存表空了仍能从 status.json 读回终局", async () => {
  const sessionDir = await tempDir("erix-run-async-reload-");
  const runId = "erix-run-old-1";
  const written = writeStatusFile({
    sessionDir, runId,
    view: { runId, status: "completed", termination: { reason: "judge_done" }, rounds: 9, usage: { input_tokens: 1, output_tokens: 2 } },
  });
  assert.equal(written.error, undefined);
  assert.equal(written.path, path.join(sessionDir, "outputs", runId, "status.json"));

  // 新实例（模拟 /reload 之后的扩展实例）：内存表空的，但知道这个 sessionDir
  const registry = createAsyncJobRegistry();
  registry.noteDir(sessionDir);
  const runtime = createAsyncRuntime({ registry, runJob: async () => P_OK, notify: () => true });
  const found = runtime.act({ action: "result", runId });
  assert.equal(found.kind, "result");
  assert.equal(found.source, "disk", "内存 miss → 必须回落到盘上的 status.json");
  assert.equal(found.view.termination.reason, "judge_done");
  assert.equal(found.view.rounds, 9);

  // 坏文件（半截 JSON）不能把查询面带崩：当作「没有」
  writeFileSync(path.join(sessionDir, "outputs", "broken", "status.json").replace("broken", runId), "{not json", "utf8");
  mkdirSync(path.join(sessionDir, "outputs", "broken"), { recursive: true });
  writeFileSync(path.join(sessionDir, "outputs", "broken", "status.json"), "{not json", "utf8");
  assert.equal(runtime.act({ action: "status", runId: "broken" }).kind, "unknown-run");
});

// ---------------------------------------------------------------------------
// R3：取消
// ---------------------------------------------------------------------------

test("#234 R3：cancel 把 signal 打进内层 runToolLoop，终局是 aborted 而不是悬挂", async () => {
  // 真 runToolLoop + 第二轮永悬的 provider：只有 signal 真打进去才能拿到 aborted
  const dir = await tempDir("erix-run-async-cancel-");
  const home = await tempDir("erix-run-async-cancel-home-");
  let calls = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      calls += 1;
      if (calls > 1) return new Promise(() => {});
      return {
        content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "sleep 1" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 120, output_tokens: 30 },
      };
    },
  };
  const lib = {
    source: "fake://lib",
    index: {
      runToolLoop,
      createMemoryTranscriptStore,
      createFileTranscriptStore,
      createJsonFileModelConfigProvider,
      createOpenAIProvider: (config) => ({ ...config }),
    },
    binTools: {
      buildCliToolsSystemPrompt: () => "TOOLS",
      createCliTools: () => ({ tools: [{ name: "exec", description: "exec", input_schema: {} }], executeTool: async () => "ok", truncateResult: (t) => t }),
      truncateResult: (t) => t,
    },
  };
  const sent = [];
  const runtime = createAsyncRuntime({
    home,
    registry: createAsyncJobRegistry(),
    sendRegistry: createCompletionSendRegistry(),
    notify: (job, content, options) => { sent.push({ runId: job.runId, content, ...options }); return true; },
    deps: {
      env: {},
      home,
      loadLib: async () => lib,
      loadSlot: async () => ({ slot: { endpoint: "https://r/v1", model: "slot-model", apiKey: "k" }, configPath: "/tmp/fake.json" }),
      createProvider: () => provider,
      createAssembly: () => ({ tools: [{ name: "exec", description: "exec", input_schema: {} }], executeTool: async () => "ok" }),
      createStore: () => createMemoryTranscriptStore(),
    },
  });

  const { handle } = runtime.start({ task: "长跑", cwd: dir, async: true, sessionDir: dir });
  await waitUntil(() => calls >= 2, { label: "inner run reached round 2" });
  const cancel = runtime.act({ action: "cancel", runId: handle.runId });
  assert.equal(cancel.kind, "cancel");
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.view.status, "aborted", "取消必须当场可见，不能等内层自己醒");

  await waitUntil(() => runtime.registry.get(handle.runId).payload !== undefined, { label: "inner run settled" });
  const job = runtime.registry.get(handle.runId);
  assert.equal(job.payload.aborted, true, "内层终局必须是 aborted");
  assert.equal(job.payload.termination.reason, "aborted");
  assert.equal(job.payload.termination.partial, true, "#180：中止的 partial 事实要带回来");
  assert.deepEqual(
    { input_tokens: job.payload.usage.input_tokens, output_tokens: job.payload.usage.output_tokens },
    { input_tokens: 120, output_tokens: 30 },
    "#180：花过 token 的中止不能记成零用量",
  );
  assert.equal(job.payload.rounds, 1);

  const disk = JSON.parse(readFileSync(handle.statusPath, "utf8"));
  assert.equal(disk.status, "aborted");
  assert.equal(disk.termination.reason, "aborted");
  assert.equal(disk.aborted, true);
  assert.equal(sent.length, 1, "取消只通知一次");
  assert.match(sent[0].content, /aborted/u);
  assert.equal(sent[0].triggersTurn, true, "中止是可动作的结果，必须唤醒");

  // 再取消一次：不重复投递、不假装取消成功
  const again = runtime.act({ action: "cancel", runId: handle.runId });
  assert.equal(again.cancelled, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, "重复 cancel 不得二次投递");
});

// ---------------------------------------------------------------------------
// R5 / 机制 5：timeoutMs 定时器搬出 execute()
// ---------------------------------------------------------------------------

test("#234 R5：异步分支返回后 timeoutMs 到点仍把终局写成 aborted 并落进 status.json（内层连 abort 都不理）", async () => {
  const sent = [];
  const dir = await tempDir("erix-run-async-watchdog-");
  // 内层连 signal 都不看、永远不返回：只有 run 级看门狗能把状态从 running 推到 aborted
  const job = async (_params, { signal }) => {
    await new Promise((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    return new Promise(() => {});
  };
  const { runtime } = await makeRuntime({ job, sent });
  const { handle } = runtime.start({ task: "卡死", cwd: dir, async: true, sessionDir: dir, timeoutMs: core.MIN_TIMEOUT_MS });
  assert.equal(runtime.registry.get(handle.runId).status, "running");
  assert.equal(JSON.parse(readFileSync(handle.statusPath, "utf8")).status, "running");

  await waitUntil(() => JSON.parse(readFileSync(handle.statusPath, "utf8")).status === "aborted", {
    timeoutMs: 4_000, label: "watchdog wrote aborted into status.json",
  });
  const view = runtime.act({ action: "status", runId: handle.runId }).view;
  assert.equal(view.status, "aborted");
  assert.equal(view.timeout, true, "看门狗写的终局要如实标 timeout");
  assert.equal(sent.length, 1, "看门狗也要发一次通知（否则父会话永远等不到）");
  assert.match(sent[0].content, /aborted/u);
  assert.equal(runtime.registry.get(handle.runId).status, "aborted", "内存视图与盘上不能分叉");
});

test("#234 R5：看门狗到点之后内层真终局仍要落盘，但不得二次投递", async () => {
  const sent = [];
  let release;
  const dir = await tempDir("erix-run-async-late-");
  const { runtime } = await makeRuntime({
    sent,
    job: async () => { await new Promise((resolve) => { release = resolve; }); return { ...P_OK, timeout: true, aborted: true, termination: { reason: "aborted" } }; },
  });
  const { handle } = runtime.start({ task: "t", cwd: dir, async: true, sessionDir: dir, timeoutMs: core.MIN_TIMEOUT_MS });
  await waitUntil(() => runtime.registry.get(handle.runId).status === "aborted", { timeoutMs: 4_000 });
  release();
  await waitUntil(() => runtime.registry.get(handle.runId).payload !== undefined, { timeoutMs: 4_000 });
  assert.equal(runtime.registry.get(handle.runId).latePayload, true, "迟到的真终局要留痕");
  const view = runtime.act({ action: "result", runId: handle.runId }).view;
  assert.equal(view.termination.reason, "aborted");
  assert.deepEqual(view.usage, { input_tokens: 11, output_tokens: 4 }, "迟到终局的四件套也要能查到");
  assert.equal(sent.length, 1, "去重：看门狗与迟到终局只投一次");
});

// ---------------------------------------------------------------------------
// 机制 4：投递去重注册表
// ---------------------------------------------------------------------------

test("#234 机制4：createCompletionSendRegistry —— 同一 key 只 owned 一次；没投成功让位重试；TTL 与容量上限", () => {
  let now = 1_000;
  const registry = createCompletionSendRegistry(100, 2);

  const first = registry.claim("run-1", now);
  assert.equal(first.owned, true);
  const dup = registry.claim("run-1", now);
  assert.equal(dup.owned, false, "同一 run 的完成不能投两次");
  first.settle(true, now);

  // 投失败 → 条目让出去，允许重试（照上游：settle(false) 直接删条目）
  const failed = registry.claim("run-2", now);
  failed.settle(false, now);
  const retry = registry.claim("run-2", now);
  assert.equal(retry.owned, true, "没投成功就不该占着去重位");
  retry.settle(true, now);
  assert.equal(registry.claim("run-2", now).owned, false, "投成功之后必须占住");
  assert.equal(registry.size, 2);

  // TTL：两条都是「已投递且过期」→ 下一次 claim 先 prune，然后允许再占
  now += 101;
  const again1 = registry.claim("run-1", now);
  assert.equal(again1.owned, true, "TTL 过期后条目要能淘汰");
  again1.settle(true, now);
  const again2 = registry.claim("run-2", now);
  assert.equal(again2.owned, true, "两条都过期了，都要能重占");
  again2.settle(true, now);

  // 容量上限 cap=2：第三条已投递条目挤掉最老的已投递条目（未投递的 in-flight 不动，照上游）
  registry.claim("run-3", now).settle(true, now);
  assert.ok(registry.size <= 2, `容量上限必须生效，实测 size=${registry.size}`);
  assert.equal(registry.has("run-1"), false, "淘汰从插入序升始");
  assert.equal(COMPLETION_SEND_TTL_MS, 10 * 60 * 1000, "TTL 与 pi-subagents 同一对常量");
});

test("#234 机制4：同一 run 的完成被多个来源触发时只投递一次（去重注册表在 runtime 里真起作用）", async () => {
  const sent = [];
  const { runtime, registry } = await makeRuntime({ job: async () => ({ ...P_OK }), sent });
  const { handle } = runtime.start({ task: "t", cwd: repoRoot, async: true });
  await waitUntil(() => registry.get(handle.runId).status === "completed");
  assert.equal(sent.length, 1);
  // 另外两个触发源：reload 之后旧闭包再投一次、宿主手动重试
  assert.equal(runtime.notifySettled(registry.get(handle.runId)).delivered, false);
  assert.equal(runtime.notifySettled(registry.get(handle.runId)).delivered, false);
  assert.equal(sent.length, 1, "去重注册表改成不去重时这条必须变红");
});

// ---------------------------------------------------------------------------
// 机制 2/3：parent-wake 双分支 + pending 窗口 + reload 安全 + 唤醒策略
// ---------------------------------------------------------------------------

function fakePi() {
  const calls = { sendMessage: [], sendUserMessage: [] };
  return {
    calls,
    pi: {
      sendMessage: (message, options) => calls.sendMessage.push({ message, options }),
      sendUserMessage: (content, options) => calls.sendUserMessage.push({ content, options }),
    },
  };
}

function fakeCtx({ idle = true, sessionId = "s-1", sessionManager } = {}) {
  const manager = sessionManager ?? { getSessionId: () => sessionId };
  return { isIdle: () => idle, sessionManager: manager };
}

test("#234 机制2：idle 分支 —— 消息只追加（triggerTurn:false），另发一条 steer 用户消息起一轮", () => {
  const { pi, calls } = fakePi();
  const wake = createParentWake(pi);
  wake.bindSession(fakeCtx({ idle: true }));

  const triggered = wake.sendMessage({ customType: "erix-run-notify", content: "done" }, { triggerTurn: true });
  assert.equal(triggered, true);
  assert.deepEqual(calls.sendMessage, [{ message: { customType: "erix-run-notify", content: "done" }, options: { triggerTurn: false } }],
    "idle 时不能把 triggerTurn:true 原样交给 pi");
  assert.deepEqual(calls.sendUserMessage, [{ content: PARENT_WAKE_TEXT, options: { deliverAs: "steer" } }]);
});

test("#234 机制2：父会话忙时退化为「原样追加 + 不排 steer」，不硬触发", () => {
  const { pi, calls } = fakePi();
  const wake = createParentWake(pi);
  wake.bindSession(fakeCtx({ idle: false }));

  const triggered = wake.sendMessage({ customType: "erix-run-notify", content: "done" }, { triggerTurn: true });
  assert.equal(triggered, false, "isIdle 硬编码成永远 idle 时这条必须变红");
  assert.deepEqual(calls.sendMessage, [{ message: { customType: "erix-run-notify", content: "done" }, options: { triggerTurn: true } }],
    "忙时原样透传，由 pi 按当前投递策略处理");
  assert.deepEqual(calls.sendUserMessage, [], "忙时不能排 steer（否则会把消息塞进正在跑的一轮）");
});

test("#234 机制2：triggerTurn 不是 true 时一律透传（不建 reservation）", () => {
  const { pi, calls } = fakePi();
  const wake = createParentWake(pi);
  wake.bindSession(fakeCtx({ idle: true }));
  assert.equal(wake.sendMessage({ content: "x" }, { triggerTurn: false }), false);
  assert.equal(wake.sendMessage({ content: "x" }), false);
  assert.equal(calls.sendUserMessage.length, 0);
  assert.equal(calls.sendMessage.length, 2);
});

test("#659 第3格：`sent` 的上界是「宿主接受了这次调用」—— pi 返回 void 不算已送达，只有 agent_start 才是确认", () => {
  const { pi, calls } = fakePi();
  const wake = createParentWake(pi);
  wake.bindSession(fakeCtx({ idle: true }));

  // 投递口把消息交给了 pi（`sendMessage` / `sendUserMessage` 的契约都是 void，不抛 ≠ 送达）
  assert.equal(wake.sendMessage({ customType: "erix-run-notify", content: "done" }, { triggerTurn: true }), true);
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendUserMessage.length, 1);
  assert.equal(wake.isPending(), true,
    "宿主接受了调用，但观察侧还没看到 agent_start ⇒ 这条唤醒仍然欠着（sent 不是已送达）");

  // 观察侧确认：`agent_start` 真的来了，才算「进了会话」
  wake.agentStarted();
  assert.equal(wake.isPending(), false, "只有 agent_start 能结清欠账");

  // 文档面同一条边界（#659 第 3 格要求在代码注释与 README 里写准确，不许写成「已送达」）
  for (const relative of ["examples/pi-extension/erix-run-jobs.js", "examples/pi-extension/README.md"]) {
    const text = readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /宿主接受了这次(投递)?调用/u, `${relative} 要写清 sent 的上界是「宿主接受了这次调用」`);
    assert.match(text, /不是\*{0,2}「已送达」/u, `${relative} 必须显式否掉「已送达」这个读法`);
  }
});

test("#234 机制2：WAKE_PENDING_MS 窗口 —— 窗口内不重复排 steer，超窗后重新排，agent_start 清位", () => {
  let now = 100_000;
  const { pi, calls } = fakePi();
  const wake = createParentWake(pi, () => now);
  wake.bindSession(fakeCtx({ idle: true }));

  wake.sendMessage({ content: "a" }, { triggerTurn: true });
  assert.equal(calls.sendUserMessage.length, 1);
  assert.equal(wake.isPending(), true);

  // 窗口内再来一条：消息照常追加，但不再排第二条 steer
  now += WAKE_PENDING_MS - 1;
  assert.equal(wake.sendMessage({ content: "b" }, { triggerTurn: true }), true);
  assert.equal(calls.sendUserMessage.length, 1, "去掉 pending 窗口时这条必须变红");
  assert.equal(calls.sendMessage.length, 2, "通知本身仍然要追加");

  // 超窗：那条唤醒那一轮丢了（被处理掉/失败的 prompt 不发 agent_start），允许再排
  now += 2;
  assert.equal(wake.sendMessage({ content: "c" }, { triggerTurn: true }), true);
  assert.equal(calls.sendUserMessage.length, 2);

  // 正常路径：唤醒换来了 agent_start → 清位，下一条立刻能再排
  wake.agentStarted();
  assert.equal(wake.isPending(), false);
  wake.sendMessage({ content: "d" }, { triggerTurn: true });
  assert.equal(calls.sendUserMessage.length, 3);
});

test("#234 机制2：reservation 挂 Symbol.for + WeakMap（按 sessionManager）→ 扩展 /reload 不丢 pending", () => {
  let now = 500_000;
  const manager = { current: "s-reload", getSessionId() { return this.current; } };
  const first = fakePi();
  const wakeA = createParentWake(first.pi, () => now);
  wakeA.bindSession(fakeCtx({ idle: true, sessionManager: manager }));
  wakeA.sendMessage({ content: "a" }, { triggerTurn: true });
  assert.equal(first.calls.sendUserMessage.length, 1);

  // 模拟 /reload：新扩展实例、新唤醒器，但 sessionManager 与 sessionId 都没变
  const second = fakePi();
  const wakeB = createParentWake(second.pi, () => now);
  wakeB.bindSession(fakeCtx({ idle: true, sessionManager: manager }));
  wakeB.sendMessage({ content: "b" }, { triggerTurn: true });
  assert.equal(second.calls.sendUserMessage.length, 0, "reload 后 pending 必须还在（WeakMap 按 sessionManager 键）");

  // 换成另一个会话（sessionManager 不同）→ 独立的 reservation，该排就排
  const third = fakePi();
  const wakeC = createParentWake(third.pi, () => now);
  wakeC.bindSession(fakeCtx({ idle: true, sessionManager: { getSessionId: () => "s-other" } }));
  wakeC.sendMessage({ content: "c" }, { triggerTurn: true });
  assert.equal(third.calls.sendUserMessage.length, 1);

  // 同一个 sessionManager 但 sessionId 变了（会话被替换）→ reservation 重建，不串台
  manager.current = "s-reload-v2";
  const fourth = fakePi();
  const wakeD = createParentWake(fourth.pi, () => now);
  wakeD.bindSession({ isIdle: () => true, sessionManager: manager });
  wakeD.sendMessage({ content: "d" }, { triggerTurn: true });
  assert.equal(fourth.calls.sendUserMessage.length, 1, "sessionId 变了就不能延用旧 pending");

  // session_shutdown：reload **不**清 pending（那条唤醒仍然欠着一轮），quit 清
  wakeD.sessionShutdown("reload");
  assert.notEqual(wakeD.peekReservation().sentAt, undefined, "reload 不能把欠着的唤醒抹掉");
  now += WAKE_PENDING_MS + 1;
  const fifth = fakePi();
  const wakeE = createParentWake(fifth.pi, () => now);
  wakeE.bindSession(fakeCtx({ idle: true, sessionManager: manager }));
  wakeE.sendMessage({ content: "e" }, { triggerTurn: true });
  assert.equal(fifth.calls.sendUserMessage.length, 1, "超窗之后新实例该排就排（pending 不会永远卡住投递）");
  wakeE.sessionShutdown("quit");
  assert.equal(wakeE.peekReservation().sentAt, undefined, "quit 必须清 pending");
});

test("#234 机制3：唤醒策略 —— quiet 的成功完成不唤醒，失败/中止仍然唤醒", async () => {
  const sent = [];
  const { runtime } = await makeRuntime({ job: async () => ({ ...P_OK }), sent });
  runtime.start({ task: "quiet", cwd: repoRoot, async: true, quiet: true });
  await waitUntil(() => sent.length === 1);
  assert.equal(sent[0].triggersTurn, false, "quiet + completed 不打扰父会话（只落 status.json）");
  assert.equal(sent[0].outcome, "completed");

  const noisy = [];
  const rt2 = await makeRuntime({ job: async () => ({ ...P_OK, ok: false, termination: { reason: "failed", errorCode: "unknown" } }), sent: noisy });
  rt2.runtime.start({ task: "quiet-fail", cwd: repoRoot, async: true, quiet: true });
  await waitUntil(() => noisy.length === 1);
  assert.equal(noisy[0].triggersTurn, true, "quiet 也不能吞掉失败（那是可动作的结果）");
  assert.equal(noisy[0].outcome, "failed");
});

// ---------------------------------------------------------------------------
// 机制 6：session_shutdown 幂等清理 + 落盘面的 artifacts 口径
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #659 第 1 格：投失败后的有界重试（5s / 10s / 30s 三档，每次重算 isIdle()）
//
// 为什么必须有：`claim.settle(false)` 只把去重条目删掉（#656 已修好那半边），而 `notifySettled` 的三个
// 调用点全在 settle 路径上 —— **没有任何第二个调用者会再来一次**，释放的去重位白白空着。
// 这里用假时钟（`fakeClock`）推真代码路径，不真等 45 秒。
// ---------------------------------------------------------------------------

test("#659 第1格：重试档位是显式契约（5s / 10s / 30s 三档，重试上限 3 次）", () => {
  assert.deepEqual([...NOTIFY_RETRY_DELAYS_MS], [5_000, 10_000, 30_000],
    "档数与上限是显式契约（README 同一份值），不是隐式默认");
});

test("#659 第1格：投失败 ⇒ 到点重投，三档走完（5s / 10s）就成功；每次重投都重算 isIdle()", async () => {
  const clock = fakeClock();
  const sessionDir = await tempDir("erix-run-659-retry-");
  const sessionHandles = jobsApi.createSessionHandleRegistry();
  sessionHandles.set("659-retry", { deliver: () => true });
  /** @type {{at:number, idle:boolean}[]} */
  const attempts = [];
  let idle = false;
  const runtime = createAsyncRuntime({
    home: await tempDir("erix-run-659-retry-home-"),
    registry: createAsyncJobRegistry(),
    sendRegistry: createCompletionSendRegistry(),
    sessionHandles,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runJob: async () => ({ ...P_OK }),
    // 投递口每次被调时**重新问一次**父会话忙不忙（生产里就是 `wake.sendMessage` 的 `ctx.isIdle()`）
    notify: () => {
      attempts.push({ at: clock.now(), idle });
      if (attempts.length <= 2) return { delivery: "failed", error: "父会话忙（isIdle=false）" };
      return "sent";
    },
  });

  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true }, { sessionId: "659-retry" });
  await waitUntil(() => runtime.registry.get(handle.runId).status === "completed");
  const job = runtime.registry.get(handle.runId);
  assert.equal(jobView(job).delivery, "failed", "首次投失败就是 failed（不谎报 sent）");
  assert.equal(job.notifyRetries, 1, "失败后立即排第一档");
  assert.deepEqual(clock.pendingDelays(), [NOTIFY_RETRY_DELAYS_MS[0]], "第一档是 5s");

  // 父会话现在空闲了：重投要能拿到这个新事实（每档重算 isIdle）
  idle = true;
  const firstAt = attempts[0].at;
  assert.equal(clock.tick(), true, "第一档到点必须真的重投");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].idle, true, "重投时读的是当下的 isIdle()，不是首次投递时那个值");
  assert.equal(jobView(job).delivery, "failed");
  assert.deepEqual(clock.pendingDelays(), [NOTIFY_RETRY_DELAYS_MS[1]], "第二档是 10s");

  assert.equal(clock.tick(), true);
  assert.equal(attempts.length, 3);
  assert.equal(jobView(job).delivery, "sent", "第三档投成 ⇒ 盘上变 sent");
  assert.deepEqual(clock.pendingDelays(), [], "投成之后剩下的档要撤掉（不再排）");
  // 三档的时间线逐字钉住：0 / +5s / +15s
  assert.deepEqual(attempts.map((attempt) => attempt.at - firstAt), [0, 5_000, 15_000]);

  // 盘上的事实也是 sent（重投成功必须跟着落盘，否则「重投成功但盘上还写 failed」）
  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId: handle.runId }), "utf8"));
  assert.equal(disk.delivery, "sent");
  assert.equal(disk.notifyError, null);
  assert.equal(disk.notifyRetries, 2, "已发生的重试次数是历史事实");
});

test("#659 第1格：一直投不出去 ⇒ 三档后停（有界，不无限重试）", async () => {
  const clock = fakeClock();
  const sessionDir = await tempDir("erix-run-659-retry-exhaust-");
  const sessionHandles = jobsApi.createSessionHandleRegistry();
  sessionHandles.set("659-exhaust", { deliver: () => true });
  let attempts = 0;
  const runtime = createAsyncRuntime({
    home: await tempDir("erix-run-659-exhaust-home-"),
    registry: createAsyncJobRegistry(),
    sendRegistry: createCompletionSendRegistry(),
    sessionHandles,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    runJob: async () => ({ ...P_OK }),
    notify: () => { attempts += 1; return { delivery: "failed", error: "宿主一直在拒" }; },
  });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true }, { sessionId: "659-exhaust" });
  await waitUntil(() => runtime.registry.get(handle.runId).status === "completed");

  // 首次 + 三档 = 4 次尝试，之后彻底停手
  for (let index = 0; index < NOTIFY_RETRY_DELAYS_MS.length; index += 1) {
    assert.equal(clock.tick(), true, `第 ${index + 1} 档重试必须排上`);
  }
  assert.equal(attempts, NOTIFY_RETRY_DELAYS_MS.length + 1, "首次 + 三档 = 4 次，不多不少");
  assert.deepEqual(clock.pendingDelays(), [], "用尽三档后不再挂定时器");
  assert.equal(clock.tick(), false, "没有第四档（有界）");
  const job = runtime.registry.get(handle.runId);
  assert.equal(job.notifyRetries, NOTIFY_RETRY_DELAYS_MS.length);
  assert.equal(jobView(job).delivery, "failed", "用尽重试仍然是 failed —— 不粉饰成 sent");
  assert.match(jobView(job).notifyError ?? "", /宿主一直在拒/u, "盘上留得住根因");
});

test("#234 R6：status.json 的 artifacts 沿用 core 的 resolveArtifacts 口径（文件真在盘上才给路径）", async () => {
  const dir = await tempDir("erix-run-async-artifacts-");
  const runId = "erix-run-artifact-run";
  const paths = core.artifactPaths({ sessionDir: dir, runId });
  const { runtime } = await makeRuntime({ job: gatedJob(), sent: [] });
  // 直接给一个已知的 runId（走 jobView，不依赖真引擎命名）
  const job = {
    runId, status: "aborted", cwd: dir, maxRounds: 8, timeoutMs: 1_000, sessionDir: dir,
    createdAt: 1, startedAt: 2, finishedAt: 3, progress: [], persistence: paths, timedOut: true,
  };
  assert.deepEqual(jobView(job).artifacts, { transcriptPath: null, judgeLogPath: null }, "文件不在就是 null，不猜路径");
  mkdirSync(path.dirname(paths.judgeLogPath), { recursive: true });
  writeFileSync(paths.transcriptPath, "{}\n", "utf8");
  writeFileSync(paths.judgeLogPath, "{}\n", "utf8");
  assert.deepEqual(jobView(job).artifacts, { transcriptPath: paths.transcriptPath, judgeLogPath: paths.judgeLogPath });

  const written = writeStatusFile({ sessionDir: dir, runId, view: jobView(job) });
  assert.equal(written.path, statusFilePath({ sessionDir: dir, runId }));
  const disk = JSON.parse(readFileSync(written.path, "utf8"));
  assert.deepEqual(disk.artifacts, { transcriptPath: paths.transcriptPath, judgeLogPath: paths.judgeLogPath });
  assert.equal(disk.status, "aborted");
  assert.equal(disk.termination, null, "内层还没给出终局时不替引擎发明 termination.reason");
  assert.equal(disk.timeout, true, "看门狗致因要如实标在盘上");
  assert.ok(runtime.registry.size >= 0);
});

// ---------------------------------------------------------------------------
// #237 R4：`status.json` 的 tmp + rename 原子写（折带的 #234 遗留）
//
// 为什么单独一节：主 agent 实测把 `writeStatusFile` 的「写 `.tmp-` 再 rename」退化成
// 「直接 `writeFileSync(最终路径)`」，**全量测试零红** —— 原子写当时没有任何覆盖。
// 下面三条把「先写临时文件、再 rename」这条**顺序**钉住，并补上「写中途失败」的三条后果
// （旧内容不被破坏 / 不留 `.tmp-` 残留 / 错误进 `statusWriteError` 而不抛）。
// 注入缝照 `erix-run-core.js` 的 `deps.createStore` 风格：`writeStatusFile(input, deps)`，
// deps 可换 `mkdirSync` / `writeFileSync` / `renameSync` / `unlinkSync`；`createAsyncRuntime({deps})`
// 把它透传给内部每一次 `persistStatus`。
// ---------------------------------------------------------------------------

test("#237 R4：writeStatusFile 必须先写 .tmp- 再 rename（退化成直接写同名文件必须变红）", async () => {
  const sessionDir = await tempDir("erix-run-atomic-");
  const runId = "erix-run-atomic-1";
  const file = statusFilePath({ sessionDir, runId });
  const calls = [];
  const written = writeStatusFile(
    { sessionDir, runId, view: { runId, status: "running" }, now: () => 1_700_000_000_000 },
    {
      writeFileSync: (p, data, enc) => { calls.push(["write", p]); writeFileSync(p, data, enc); },
      renameSync: (from, to) => { calls.push(["rename", from, to]); renameSync(from, to); },
    },
  );

  assert.equal(written.error, undefined);
  assert.equal(written.path, file);
  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ["write", "rename"],
    "顺序必须是「写临时文件 → rename」；少一步 rename（直接写同名）就不是原子写",
  );
  const tmp = calls[0][1];
  assert.notEqual(tmp, file, "写入的目标不能就是最终文件本身");
  assert.match(path.basename(tmp), /^status\.json\.tmp-/, `临时文件名要认得出来，实测 ${tmp}`);
  assert.deepEqual(calls[1].slice(1), [tmp, file], "rename 必须把那个临时文件搬到最终路径");
  assert.equal(
    readFileSync(file, "utf8"),
    `${JSON.stringify({ runId, status: "running" }, null, 2)}\n`,
    "rename 之后盘上内容就是那个视图",
  );
  assert.deepEqual(
    readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-")),
    [],
    "成功路径也不能留 .tmp- 残留",
  );
});

test("#237 R4：rename 失败时旧 status.json 不被破坏、不留 .tmp- 残留、错误被回报而不是抛出", async () => {
  const sessionDir = await tempDir("erix-run-atomic-rename-fail-");
  const runId = "erix-run-atomic-rename-fail";
  const first = writeStatusFile({ sessionDir, runId, view: { runId, status: "running", marker: "old" } });
  assert.equal(first.error, undefined);
  const before = readFileSync(first.path, "utf8");
  assert.match(before, /"old"/u);

  const second = writeStatusFile(
    { sessionDir, runId, view: { runId, status: "completed", marker: "new" } },
    { renameSync: () => { throw new Error("EXDEV: cross-device link not permitted"); } },
  );

  assert.equal(typeof second.error, "string", "写失败要回报错误，不能抛出去打断调用方");
  assert.match(second.error, /EXDEV/u);
  assert.equal(second.path, first.path);
  assert.equal(
    readFileSync(first.path, "utf8"),
    before,
    "写中途失败绝不能破坏旧文件（读者要么看到旧的完整内容，要么看到新的完整内容）",
  );
  assert.match(readFileSync(first.path, "utf8"), /"old"/u);
  assert.doesNotMatch(readFileSync(first.path, "utf8"), /"new"/u);
  assert.deepEqual(
    readdirSync(path.dirname(first.path)),
    ["status.json"],
    `中途失败必须把半截 .tmp- 清掉，实测目录：${readdirSync(path.dirname(first.path)).join(", ")}`,
  );
});

test("#237 R4：写临时文件中途抛错（半截文件已在盘上）同样要清干净并回报错误", async () => {
  const sessionDir = await tempDir("erix-run-atomic-write-fail-");
  const runId = "erix-run-atomic-write-fail";
  const first = writeStatusFile({ sessionDir, runId, view: { runId, status: "running", marker: "old" } });
  const before = readFileSync(first.path, "utf8");

  const second = writeStatusFile(
    { sessionDir, runId, view: { runId, status: "failed", marker: "new" } },
    {
      // 真写一半再抛：模拟磁盘写了一半就 ENOSPC
      writeFileSync: (p, data) => { writeFileSync(p, String(data).slice(0, 12), "utf8"); throw new Error("ENOSPC: no space left on device"); },
    },
  );

  assert.match(second.error ?? "", /ENOSPC/u);
  assert.equal(readFileSync(first.path, "utf8"), before, "旧文件原样");
  assert.deepEqual(
    readdirSync(path.dirname(first.path)),
    ["status.json"],
    `半截临时文件不能留在盘上，实测：${readdirSync(path.dirname(first.path)).join(", ")}`,
  );
});

test("#237 R4：status.json 写失败不打断派工，错误经 job.statusWriteError 进查询视图（不抛）", async () => {
  const sessionDir = await tempDir("erix-run-atomic-runtime-");
  const job = gatedJob();
  const { runtime, registry } = await makeRuntime({
    job: job.job,
    extra: { deps: { writeFileSync: () => { throw new Error("EROFS: read-only file system"); } } },
  });

  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });
  assert.equal(handle.statusPath, statusFilePath({ sessionDir, runId: handle.runId }), "写失败不改变落点");
  const running = runtime.act({ action: "status", runId: handle.runId });
  assert.equal(running.view.status, "running", "派工照常进行（写盘失败不是内层 run 的失败）");
  assert.match(running.view.statusWriteError ?? "", /EROFS/u, "写失败要成为可机读事实，别让查询侧以为落盘成功");

  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed", { label: "completed despite write failure" });
  assert.match(registry.get(handle.runId).statusWriteError, /EROFS/u);
  assert.equal(existsSync(handle.statusPath), false, "写不进去就是没有这个文件（不假装落盘成功）");
});

// ---------------------------------------------------------------------------
// issue #261：终稿正文进查询视图（jobView）→ `action:"result"` 文本 + `status.json`。
// 修之前视图里没有 `finalText`：format.js 里那一支 `typeof view?.finalText === "string"` 永不
// 成立（死分支），派工跑完几十轮后宿主既拿不到正文、也读不到盘上的正文。
// 全部离线：假 runJob 产出可控 finalText，cwd/home/sessionDir 一律临时目录。
// ---------------------------------------------------------------------------

const FINAL_TEXT = "任务已完成：R1 落地了\n验证：node --test 全绿\nfindings={\"nonce\":\"x-261\"}";

/** 派一条会成功结束的异步 run，等它终局（内层 run 是可控假 run）。 */
async function settledRun({ payload = {}, prefix = "erix-run-finaltext", outcome = "completed" } = {}) {
  const sessionDir = await tempDir(`${prefix}-`);
  const sent = [];
  const job = gatedJob({ payload });
  const { runtime, registry } = await makeRuntime({ job: job.job, sent });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });
  job.release();
  await waitUntil(() => registry.get(handle.runId).status === outcome, { label: `${prefix} ${outcome}` });
  return { runtime, registry, sent, sessionDir, runId: handle.runId };
}

function textOf(result) {
  return result.content[0].text;
}

test("#261 R4①：异步 run 跑完后 action:\"result\" 的返回文本含终稿正文（此前是死分支）", async () => {
  const { runtime, runId } = await settledRun({ payload: { finalText: FINAL_TEXT } });

  const outcome = runtime.act({ action: "result", runId });
  assert.equal(outcome.kind, "result");
  assert.equal(outcome.view.finalText, FINAL_TEXT, "视图必须原样透传终稿（不截断、不缺字段）");

  const text = textOf(formatAsyncResult(outcome));
  assert.ok(text.includes("R1 落地了"), `result 文本必须带交付物正文，实测：${text}`);
  assert.ok(text.includes(FINAL_TEXT), "正文整段在场（短文本不该被切）");
  assert.doesNotMatch(text, /终稿为空/u, "有正文时不该冒「终稿为空」");
});

test("#261 R4②：status.json（复用同一 jobView，不另写拼装）里含同一份终稿", async () => {
  const { runId, sessionDir } = await settledRun({ payload: { finalText: FINAL_TEXT } });

  const file = statusFilePath({ sessionDir, runId });
  assert.ok(existsSync(file), `status.json 应落在 ${file}`);
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("R1 落地了"), "盘上的状态文件同样要带终稿（派工没传 sessionDir 之外的场景）");
  assert.equal(JSON.parse(raw).finalText, FINAL_TEXT, "status.json 的 finalText 与视图同一份值");

  // 盘上兜底查询（内存注册表之外的那条 lookup 分支）也是同一形状
  const fromDisk = JSON.parse(raw);
  assert.equal(typeof fromDisk.finalText, "string");
});

test("#261 R4③：还没终局时 jobView.finalText === \"\"（字段恒在场，不是缺字段）", async () => {
  const sessionDir = await tempDir("erix-run-finaltext-running-");
  const job = gatedJob();
  const { runtime, registry } = await makeRuntime({ job: job.job, sent: [] });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  const running = jobView(registry.get(handle.runId));
  assert.ok("finalText" in running, "字段必须恒在场（查询侧不必分两种形状解析）");
  assert.equal(running.finalText, "", "未终局给空串而不是 undefined");
  assert.equal(runtime.act({ action: "status", runId: handle.runId }).view.finalText, "");

  // 载荷没带 finalText 的终局（抛错归一化那类）同样给 ""
  assert.equal(jobView({ runId: "r-261", status: "failed", payload: { ok: false } }).finalText, "");
  assert.equal(jobView({ runId: "r-261", status: "failed", payload: { ok: false, finalText: null } }).finalText, "");

  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed", { label: "released" });
});

test("#261 R4④：带终稿之后 details 与视图仍可 JSON.stringify（守 #237 R1：纯数据）", async () => {
  const { runtime, registry, runId } = await settledRun({ payload: { finalText: FINAL_TEXT } });

  const details = formatAsyncResult(runtime.act({ action: "result", runId })).details;
  const roundTripped = JSON.parse(JSON.stringify(details));
  assert.equal(roundTripped.kind, "result");
  assert.equal(roundTripped.view.finalText, FINAL_TEXT, "JSON 往返之后终稿原样");
  assert.equal(roundTripped.detailsDropped, undefined, "不能因为多了字符串就触发守卫退化");

  const viewJson = JSON.stringify(jobView(registry.get(runId)));
  assert.ok(viewJson.includes("R1 落地了"), "视图本身也是纯数据，直接序列化得动");
});

test("#261 R1/R3：视图层不截断，显示层保持 4000 字截断口径", async () => {
  const long = "长".repeat(4_500);
  const { runtime, registry, runId } = await settledRun({ payload: { finalText: long } });

  const view = jobView(registry.get(runId));
  assert.equal(view.finalText.length, 4_500, "jobView 原样透传，不在视图层切（单一真值）");

  const text = textOf(formatAsyncResult(runtime.act({ action: "result", runId })));
  assert.ok(text.includes("长".repeat(4_000)), "显示层仍给出前 4000 字");
  assert.ok(!text.includes("长".repeat(4_001)), "显示层 4000 字口径不许变宽");
});

test("#261 R3：终稿为空时 result 文本明说「终稿为空」，别让宿主以为被截断", async () => {
  const { runtime, runId } = await settledRun({ payload: { finalText: "" } });
  const text = textOf(formatAsyncResult(runtime.act({ action: "result", runId })));
  assert.match(text, /终稿为空/u, `空终稿要写明，实测：${text}`);
  assert.match(text, /不是被 4000 字截断/u);

  // 载荷干脆没有 finalText 键（老形状）也必须走到这条明说分支
  const noKey = await settledRun({ payload: { finalText: undefined }, prefix: "erix-run-finaltext-nokey" });
  assert.match(textOf(formatAsyncResult(noKey.runtime.act({ action: "result", runId: noKey.runId }))), /终稿为空/u);
});

// ---------------------------------------------------------------------------
// issue #276：**异步投影视图必须覆盖同步结果的每个字段**。
//
// 缺陷原文：`runJob` 的返回（= 同步面的终局载荷，`erix-run-core.js` 的
// `buildSuccessPayload`/`buildErrorPayload` 产出）里有 `diagnostics`，工具描述也向模型承诺了
// （`erix-run.ts`：返回形状含 `diagnostics`、「ok:false 先读 termination.errorCode / diagnostics」），
// 但 `jobView` 是**手抄**投影，`diagnostics` 没抄进去 → `action:"result"` / `action:"status"` /
// `status.json` 三处全都没有它（`status.json` 是 `/reload`、pi 重启后唯一残留）。
// 同型缺陷已第二例（A3/`d14f0f7`：`status.json` 缺 `runId`/`sessionDir`），两次都没有断言看守。
//
// 复现用的是**真同步终局**（离线 `core.runErixRun` + 假 lib/假 provider，不打 LLM），
// 不是手搓夹具：否则「同步面有、异步面没有」这句话就只是夹具之间对账。
// ---------------------------------------------------------------------------

/** `runErixRun` 的离线装配（照 test/examples/erix-run-core.test.js 的 fakeDeps 口径）。 */
function offlineFakeLib() {
  return {
    source: "fake://lib",
    libEntry: "/fake/src/index.js",
    binToolsEntry: "/fake/bin/tools.js",
    index: {
      runToolLoop,
      createMemoryTranscriptStore,
      createFileTranscriptStore,
      createJsonFileModelConfigProvider,
      createOpenAIProvider: (config) => ({ ...config, chat: async () => ({ content: [], stopReason: "end_turn" }) }),
    },
    binTools: {
      buildCliToolsSystemPrompt: () => "TOOLS",
      createCliTools: () => ({ tools: [], executeTool: async () => "unused", truncateResult: (t) => t }),
      truncateResult: (text) => text,
    },
  };
}

/** 真跑一次 `core.runErixRun`（假 provider，离线）拿**真同步终局载荷**——异步面的真值源就是它。 */
async function offlineSyncPayload({ sessionDir } = {}) {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "任务已完成：修好了 a.js" }], stopReason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } },
  ]);
  return core.runErixRun(
    { task: "修 bug", cwd: repoRoot, maxRounds: 4, strategy: "sliding-window", ...(sessionDir === undefined ? {} : { sessionDir }) },
    {
      env: {},
      home: await tempDir("erix-run-276-home-"),
      now: () => 1_700_000_000_000,
      loadLib: async () => offlineFakeLib(),
      loadSlot: async () => ({ slot: { endpoint: "https://relay.example/v1", model: "slot-model", apiKey: "k", contextWindowTokens: 200_000, maxOutputTokens: 4_096 }, configPath: "/tmp/fake-erix-config.json" }),
      createProvider: () => provider,
      createAssembly: () => ({ tools: [], executeTool: async () => "tool-ok" }),
      createStore: () => createMemoryTranscriptStore(),
      runLoop: (options) => runToolLoop(options),
    },
  );
}

/** 视图缺了同步结果里的哪些键（undefined 值的键也算「在场」——它与同步面同形）。 */
function missingSyncFields(syncPayload, view) {
  return Object.keys(syncPayload).filter((field) => view === undefined || !(field in view));
}

/**
 * 盘上比较的口径：`JSON.stringify` 会把值为 `undefined` 的键**整个丢掉**（同步面自己也不例外，
 * 比如 `verification: undefined`），所以盘上那一处只能拿「JSON 里看得见的键」对账。
 */
function jsonKeys(value) {
  return Object.keys(JSON.parse(JSON.stringify(value)));
}

test("#276 复现：同一个 run 的同步终局有 diagnostics，异步视图此前整键丢失", async () => {
  const syncPayload = await offlineSyncPayload({ sessionDir: await tempDir("erix-run-276-syncdir-") });

  // 真值源自己先自证：同步面确实有 diagnostics / termination（工具描述承诺的就是它）
  assert.ok("diagnostics" in syncPayload, "同步面（runJob 的返回）必须有 diagnostics");
  assert.equal(typeof syncPayload.diagnostics.model, "string", "diagnostics 得有实际内容，不是空壳");

  const { runtime, runId, sessionDir } = await settledRun({ payload: syncPayload, prefix: "erix-run-276-repro" });

  const resultView = runtime.act({ action: "result", runId }).view;
  assert.deepEqual(missingSyncFields(syncPayload, resultView), [], "action:\"result\" 的视图不许缺同步结果里的任何键");
  assert.deepEqual(resultView.diagnostics, syncPayload.diagnostics, "diagnostics 必须整块同形");
  assert.deepEqual(resultView.termination, syncPayload.termination, "termination 必须整块同形（含 errorCode）");

  const statusView = runtime.act({ action: "status", runId }).view;
  assert.deepEqual(statusView.diagnostics, syncPayload.diagnostics, "action:\"status\" 与 result 是同一个 jobView，也必须带");

  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
  assert.deepEqual(missingSyncFields(Object.fromEntries(jsonKeys(syncPayload).map((k) => [k, syncPayload[k]])), disk), [],
    "status.json 落盘后回读也不许缺键（只比 JSON 看得见的键：值为 undefined 的键同步面自己也不落盘）");
  assert.deepEqual(disk.diagnostics, syncPayload.diagnostics, "status.json 是 /reload 后唯一残留，必须带 diagnostics");
});

test("#276 复现（抛错终局）：error 载荷的 diagnostics 同样不许丢", async () => {
  const syncPayload = await offlineSyncPayload();
  const failed = { ...syncPayload, ok: false, termination: { reason: "failed", detail: "boom", errorCode: "provider_error" } };

  const { runtime, runId } = await settledRun({ payload: failed, prefix: "erix-run-276-failed", outcome: "failed" });
  const view = runtime.act({ action: "result", runId }).view;

  assert.deepEqual(view.diagnostics, failed.diagnostics);
  assert.equal(view.diagnostics.model, "slot-model");
  assert.equal(view.termination.errorCode, "provider_error", "「ok:false 先读 termination.errorCode」这条指导依赖的字段");
  assert.deepEqual(missingSyncFields(failed, view), [], "抛错终局也不许缺键");

  const text = textOf(formatAsyncResult(runtime.act({ action: "result", runId })));
  assert.match(text, /modelMetadataMissing|diagnostics/u, "result 文本面也要把 diagnostics 的自查结论播报出来（模型读的是文本）");
});

test("#276 复现：#266 的 notesLifecycle 是 diagnostics 的子键，因此也一并丢了", async () => {
  const syncPayload = await offlineSyncPayload({ sessionDir: await tempDir("erix-run-276-notesdir-") });
  const withNotes = { ...syncPayload, diagnostics: { ...syncPayload.diagnostics, notesLifecycle: { attempted: true, completed: 1, errors: [] } } };

  const { runtime, runId, sessionDir } = await settledRun({ payload: withNotes, prefix: "erix-run-276-notes" });
  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));

  assert.deepEqual(disk.diagnostics?.notesLifecycle, { attempted: true, completed: 1, errors: [] },
    "主 agent 实测盘上没有 notesLifecycle：它挂在 diagnostics 下面，父键丢了它就一起丢");
});

// ---------------------------------------------------------------------------
// #276 R2：**结构看守**——「异步视图覆盖同步结果的每个字段」是一条可断言的性质，
// 不是「这次记得把 diagnostics 加上」的一次性补丁。
//
// 三层（缺任何一个，同类静默都会回来；A3/`d14f0f7` 缺 `runId`/`sessionDir` 与本单
// 缺 `diagnostics` 是同一条病因：`jobView` 是手抄投影，而 `runJob` 的返回才是真值源）：
//   1. **派生**：`SYNC_RESULT_FIELDS` 在装载期从 core 的两个载荷构造器探出来（不是手抄清单），
//      所以上游加字段 → 这张表当场变长；
//   2. **口径表覆盖派生表**：`UNPROJECTED_SYNC_FIELDS` 恒为空——非空就是「有字段没定投影口径」；
//   3. **覆盖断言 + 穿透**：同步结果里出现的每个键，在 `action:"result"` / `action:"status"` /
//      `status.json` 三处都必须出现（含一个**本层根本不认识的假字段**）——把视图改回手抄
//      白名单，第 3 条必红（反向证②）。
// ---------------------------------------------------------------------------

/** 测试侧**独立**探一次同步字段表（不回读 jobs 的常量，否则就是自证）。 */
function truthSourceFields() {
  const probeInput = {
    timeout: false,
    aborted: false,
    observerErrors: [],
    metadataEvents: [],
    ledgerErrors: [],
    persistenceErrors: [],
    context: {},
  };
  const fields = new Set([
    ...Object.keys(core.buildSuccessPayload({}, probeInput)),
    ...Object.keys(core.buildErrorPayload(new Error("truth probe"), probeInput)),
  ]);
  return [...fields].sort();
}

test("#276 R2①：字段表是从真值源**派生**的，不是手抄清单（上游加字段当场进表）", () => {
  const truth = truthSourceFields();
  assert.deepEqual([...jobsApi.SYNC_RESULT_FIELDS].sort(), truth,
    "jobs 的字段表必须逐字等于 core 两个载荷构造器的键集——不相等就是手抄没跟上");
  // 现场示范「加一个同步字段不需要改异步层」：探针多吐一个键，表就得多一个（反向证②的前提）。
  assert.ok(truth.includes("diagnostics"), "探到的字段集自身得含 diagnostics（否则本节的断言 ① 是空转）");
});

test("#276 R2②：UNPROJECTED_SYNC_FIELDS 恒为空（有字段没定投影口径就红）", () => {
  assert.deepEqual([...jobsApi.UNPROJECTED_SYNC_FIELDS], [],
    `这些同步字段没在 TERMINAL_FIELD_SHAPES 里登记口径：${jobsApi.UNPROJECTED_SYNC_FIELDS.join(",")}`);
});

test("#276 R2③：同步结果里出现的每个键，三处异步面都得有（含一个本层不认识的假字段）", async () => {
  // `brandNewFieldFromUpstream` 模拟「上游新加了一个同步字段而异步层没改一行」：
  // 派生式视图要自动带上它；手抄白名单在这里必红（反向证②）。
  const payloadWithNewField = {
    ...P_OK,
    diagnostics: { observerErrors: { count: 0, samples: [] }, model: "slot-model", compaction: { events: 0 } },
    brandNewFieldFromUpstream: { addedBy: "core", value: 42 },
  };
  const { runtime, runId, sessionDir } = await settledRun({ payload: payloadWithNewField, prefix: "erix-run-276-coverage" });

  const places = {
    "action:result": runtime.act({ action: "result", runId }).view,
    "action:status": runtime.act({ action: "status", runId }).view,
    "status.json": JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8")),
  };
  for (const [label, view] of Object.entries(places)) {
    assert.deepEqual(missingSyncFields(payloadWithNewField, view), [], `${label} 缺同步结果的键`);
    assert.deepEqual(view.brandNewFieldFromUpstream, { addedBy: "core", value: 42 },
      `${label}：本层不认识的字段也不许静默丢（派生式视图的地板）`);
    assert.deepEqual(view.diagnostics, payloadWithNewField.diagnostics, `${label}：diagnostics 整块同形`);
  }
  // 三处之间也必须同形（共用一个 jobView，不存在第二份拼装）。比之前两边都过一次 JSON，
  // 否则「内存里有 `error: undefined` / 盘上没这个键」会假报不同形（JSON.stringify 本来就不落 undefined）。
  const throughJson = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(places["status.json"], throughJson(places["action:status"]), "status.json 与 status 视图同形");
  assert.deepEqual(throughJson(places["action:result"]), throughJson(places["action:status"]),
    "result 与 status 是同一个 jobView：JSON 口径下逐字同形");
  for (const field of ["termination", "diagnostics", "artifacts", "usage"]) {
    assert.deepEqual(places["action:result"][field], places["status.json"][field], `三处同形：${field}`);
  }
});

test("#276 R2④：还没终局时同步字段也恒在场（零值形状，查询侧不必分两种形状）", async () => {
  const sessionDir = await tempDir("erix-run-276-preterminal-");
  const job = gatedJob();
  const { runtime, registry } = await makeRuntime({ job: job.job, sent: [] });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  const running = jobView(registry.get(handle.runId));
  assert.deepEqual(missingSyncFields(Object.fromEntries(SYNC_FIELDS.map((field) => [field, null])), running), [],
    "未终局的视图也得带全同步字段（本单修前就缺 diagnostics/verification 两个）");
  assert.equal(running.diagnostics, null, "未终局不替 core 发明一份 diagnostics");
  assert.equal(running.verification, null);

  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed");
});

test("#276 R2⑤：刻意只给子集的两个视图要钉死，并在 README 写明理由", async () => {
  const sessionDir = await tempDir("erix-run-276-subset-");
  const job = gatedJob();
  const { runtime } = await makeRuntime({ job: job.job, sent: [] });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  // 派工句柄与 list 摘要行是**终局面之外**的刻意子集（字段少 = 设计），键集合钉死。
  assert.deepEqual(Object.keys(handle).sort(), ["cwd", "maxRounds", "model", "quiet", "runId", "sessionDir", "status", "statusPath", "timeoutMs"]);
  const summaryKeys = Object.keys(runtime.act({ action: "list" }).jobs[0]).sort();
  assert.ok(!summaryKeys.includes("diagnostics"), "list 是摘要表，不搬 diagnostics（撑爆上下文）");

  // 而这两个子集不能反过来被当成「异步面本来就是子集」的借口：README 必须写明它们是子集、
  // 而终局视图不是（本单选的是全覆盖，所以 syncOnlyFields 为空）。
  const readme = readFileSync(path.join(repoRoot, "examples", "pi-extension", "README.md"), "utf8");
  assert.match(readme, /syncOnlyFields/u, "README 要显式写 syncOnlyFields（哪些字段只在同步面有）");
  assert.match(readme, /handleOf[^"]{0,400}刻意/u, "README 要写明 handleOf / list 是刻意子集");

  job.release();
  await waitUntil(() => runtime.act({ action: "list" }).active === 0);
});

// ---------------------------------------------------------------------------
// issue #654：异步完成唤醒的「投递可观测性」与「按会话隔离投递句柄」。
//
// 现场：pi-web 在**一个 Node 进程里跑 N 个会话**，扩展 factory 对每个会话各调一次（pi 的
// `dist/core/extensions/loader.js` 把 factory 缓存在进程级 `extensionCache`，但 `await factory(api)`
// 那一处是每会话各调一次）。修前 `erix-run.ts` 把唤醒器与 `pi` 放在**模块级单槽**里 ⇒ 后启动的
// 会话覆盖前一个：A 会话派工的 run 结算时把通知投到了 B 会话的 `pi` 上，连「父会话忙不忙」
// （`ctx.isIdle()`）读的也是 B 的。reservation 的隔离当时有测试（上面那组共享 sessionManager 的
// 用例），**投递句柄的隔离一条都没有**。
//
// 三条缺陷（下面逐条钉住）：
//   1. 投递句柄是进程级单槽 ⇒ 改成按 `sessionId` 键的句柄表（`globalSessionHandleRegistry`），
//      投递时按 `job.ownerSessionId` 查；查不到记 `delivery:"orphaned"`，**没有「投给最后启动的会话」这条路**；
//   2. 投递事实不落盘（`delivery` / `notifyTargetSessionId` / `notifyError` 不在 `jobView` 里），
//      而且三处 settle 路径是「先落盘、后投递」⇒ 只加字段也读不到（顺序坑）；
//   3. 成功判定过松（`notify(...) !== false` ⇒ `claim.settle(true)` 锁死去重位，再没有重投机会）。
//
// 怎么在离线单测里跑**真的**扩展 factory：`erix-run.ts` 是 TS，而且 import 了三个没装进本仓的包
// （零依赖红线）。这里用 Node 自带的模块钩子（`module.register` + `data:` URL 的 resolve hook）
// 把那三个裸包名解析成三行桩，于是 `import()` 能加载**同一份**扩展模块——两个假 pi 各跑一次
// factory、各发一次 `session_start`，就是 pi 在多会话宿主里对两个会话做的事。
// 内层 run 不碰网络：`HOME` 指空临时目录（没有 `~/.erix/config.json` ⇒ `runErixRun` 以
// `config_missing` 当场终局，实测 ~34ms），走的是**真的** settle → notify 链，不是手搓的假 settle。
// ---------------------------------------------------------------------------

/** pi 的三个裸包名 → 三行桩（只为让 `erix-run.ts` 能被 import；本层不测它们的语义）。 */
const PI_MODULE_STUBS = {
  "@earendil-works/pi-ai": "export const StringEnum = (values) => ({ type: 'string', enum: values });",
  "@earendil-works/pi-coding-agent": "export const defineTool = (definition) => definition;",
  "typebox": "const node = () => ({});\nexport const Type = new Proxy({}, { get: () => () => node() });",
};

/** 已加载的扩展模块（同一份模块多次 factory 调用，正是 pi 在多会话宿主里的行为）。 */
let extensionModule;

/**
 * 加载 `examples/pi-extension/erix-run.ts`（**同一份**模块）。
 * `module.register` 的钩子必须在 `import()` 之前注册，且只在**本进程**生效
 * （`node --test` 每个测试文件一个子进程 ⇒ 不会污染别的文件）。
 */
async function loadExtensionModule() {
  if (extensionModule !== undefined) return extensionModule;
  const stubUrls = Object.fromEntries(Object.entries(PI_MODULE_STUBS)
    .map(([specifier, source]) => [specifier, `data:text/javascript,${encodeURIComponent(source)}`]));
  const hook = `const STUBS = ${JSON.stringify(stubUrls)};
export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) return { url: STUBS[specifier], shortCircuit: true };
  return next(specifier, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
  extensionModule = await import("../../examples/pi-extension/erix-run.ts");
  return extensionModule;
}

/**
 * 一个「会话」：假 pi + 假 ctx + 各自的收件箱；跑一次 factory + 一次 `session_start`
 * （= pi 在多会话宿主里对每个会话做的事）。
 */
function startSession(extension, { sessionId, idle = true } = {}) {
  const calls = { sendMessage: [], sendUserMessage: [] };
  const handlers = new Map();
  const pi = {
    registerTool: () => {},
    on: (name, handler) => { handlers.set(name, handler); },
    sendMessage: (message, options) => calls.sendMessage.push({ message, options }),
    sendUserMessage: (content, options) => calls.sendUserMessage.push({ content, options }),
  };
  extension.default(pi);
  const ctx = fakeCtx({ idle, sessionId });
  handlers.get("session_start")?.({}, ctx);
  return { calls, handlers, ctx, pi, received: () => calls.sendMessage.length + calls.sendUserMessage.length };
}

/**
 * 让「真 settle」在离线环境里发生：`HOME` 指空临时目录（没有配置 ⇒ `config_missing`），
 * `ERIX_AGENT_LIB` 指本仓（不依赖裸包名自解析）。返回 `restore()`。
 *
 * ⚠ `HOME` 必须在**第一次** `session_start` 之前改：扩展的进程级 runtime 在那时才建（`home = homedir()`）。
 */
async function offlineRunEnv() {
  const home = await tempDir("erix-run-654-home-");
  const before = { HOME: process.env.HOME, ERIX_AGENT_LIB: process.env.ERIX_AGENT_LIB };
  process.env.HOME = home;
  process.env.ERIX_AGENT_LIB = repoRoot;
  return {
    restore() {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** 走**真的** `execute()` 派工并等它终局；返回 runId 与内存里的 job。 */
async function dispatchAndSettle(extension, session, params) {
  const result = await extension.erixRunTool.execute("tc-654", params, undefined, undefined, session.ctx);
  const runId = result.details?.handle?.runId;
  assert.equal(typeof runId, "string", `派工必须回句柄，实测 details=${JSON.stringify(result.details)}`);
  const registry = jobsApi.globalAsyncJobRegistry();
  await waitUntil(() => {
    const job = registry.get(runId);
    return job !== undefined && !["queued", "running"].includes(job.status);
  }, { label: "#654 settle", timeoutMs: 5_000 });
  return { runId, job: registry.get(runId), result };
}

test("#654 缺陷1+2：A 派工的 run 结算后收到消息的是 A（不是后启动的 B），且 delivery/notifyTargetSessionId 进 status.json", async () => {
  const env = await offlineRunEnv();
  const sessionDir = await tempDir("erix-run-654-two-sessions-");
  const sessionHandles = jobsApi.globalSessionHandleRegistry();
  const sessionA = "654-two-A";
  const sessionB = "654-two-B";
  try {
    const extension = await loadExtensionModule();
    // 先 A 后 B：修前 B 会覆盖 A 的模块级单槽（`piRef = pi` / `wake = createParentWake(pi)`）
    const a = startSession(extension, { sessionId: sessionA });
    const b = startSession(extension, { sessionId: sessionB });

    const { runId, job } = await dispatchAndSettle(extension, a, {
      task: "t", cwd: sessionDir, sessionDir, async: true, maxRounds: 2,
    });

    // ① 收件人：派工的那个会话，不是最后启动的那个
    assert.equal(a.calls.sendMessage.length, 1,
      `A（派工会话）必须收到完成通知，实测 ${a.calls.sendMessage.length} 条`);
    assert.equal(a.calls.sendUserMessage.length, 1, "A 应该被排一条 steer 唤醒（idle 分支）");
    assert.equal(b.calls.sendMessage.length, 0,
      "B（后启动的会话）绝不能收到 A 派工的完成通知——修前这条必红（通知投到了 B）");
    assert.equal(b.calls.sendUserMessage.length, 0, "B 也不能被排 steer 唤醒");
    assert.deepEqual(a.calls.sendMessage[0].options, { triggerTurn: false }, "idle 分支：通知只追加");
    assert.deepEqual(a.calls.sendUserMessage[0], { content: PARENT_WAKE_TEXT, options: { deliverAs: "steer" } },
      "起一轮靠 steer 用户消息（分支结构没变）");

    // ② 投递事实在 jobView 里（= action:"status" / action:"result" 的 view）
    const view = jobView(job);
    assert.equal(view.delivery, "sent", "投递事实要能在视图里读到");
    assert.equal(view.notifyTargetSessionId, sessionA, "投递目标必须是派工会话");
    assert.equal(view.ownerSessionId, sessionA, "job 上要记着派工那一刻的会话身份");
    assert.equal(view.notifyError, null, "投成功不该留错误");
    assert.equal(view.deduped, 0, "这条 run 只投了一次");

    // ③ 同一份事实在 status.json 上（/reload 之后唯一残留 ⇒ 盘上读不到等于永久丢）
    const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
    assert.equal(disk.delivery, "sent", "status.json 必须带 delivery（「先投递后落盘」的看守：顺序反了这里恒为 null）");
    assert.equal(disk.notifyTargetSessionId, sessionA);
    assert.equal(disk.ownerSessionId, sessionA);

    // ④ action:"status" 走的是同一条查询面
    const statusResult = await extension.erixRunTool.execute(
      "tc-654-status", { action: "status", runId }, undefined, undefined, a.ctx,
    );
    assert.equal(statusResult.details?.view?.delivery, "sent", "action:\"status\" 也带同一份投递事实");
    assert.equal(statusResult.details?.view?.notifyTargetSessionId, sessionA);
  } finally {
    sessionHandles.delete(sessionA);
    sessionHandles.delete(sessionB);
    env.restore();
  }
});

test("#654 缺陷1：owner 会话的句柄查不到 ⇒ delivery:\"orphaned\"，且不投给任何存活会话", async () => {
  const env = await offlineRunEnv();
  const sessionDir = await tempDir("erix-run-654-orphaned-");
  const sessionHandles = jobsApi.globalSessionHandleRegistry();
  const sessionA = "654-orphan-A";
  const sessionB = "654-orphan-B";
  try {
    const extension = await loadExtensionModule();
    const a = startSession(extension, { sessionId: sessionA });
    const b = startSession(extension, { sessionId: sessionB });

    // 派工之后、结算之前，会话 A 走了（`session_shutdown("quit")` 做的就是这一件事，见下一条用例）
    const pending = extension.erixRunTool.execute(
      "tc-654-orphan", { task: "t", cwd: sessionDir, sessionDir, async: true, maxRounds: 2 }, undefined, undefined, a.ctx,
    );
    sessionHandles.delete(sessionA);
    const result = await pending;
    const runId = result.details.handle.runId;
    const registry = jobsApi.globalAsyncJobRegistry();
    await waitUntil(() => {
      const job = registry.get(runId);
      return job !== undefined && !["queued", "running"].includes(job.status);
    }, { label: "#654 orphaned settle", timeoutMs: 5_000 });

    const job = registry.get(runId);
    assert.equal(a.received(), 0, "owner 的句柄没了就不投（连 A 自己也不投）");
    assert.equal(b.received(), 0, "更不能改投给别的存活会话（B）——修前正是「投给最后一个会话」");
    assert.equal(jobView(job).delivery, "orphaned");
    assert.equal(jobView(job).notifyTargetSessionId, sessionA, "orphaned 仍要记下**本来该投给谁**");

    const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
    assert.equal(disk.delivery, "orphaned", "status.json 上也要读得到（否则 /reload 之后这件事就没人知道）");
    assert.equal(disk.notifyTargetSessionId, sessionA);
  } finally {
    sessionHandles.delete(sessionA);
    sessionHandles.delete(sessionB);
    env.restore();
  }
});

test("#654 缺陷2：派工时拿不到会话身份 ⇒ delivery:\"no-owner\"，一个会话都不投（不猜目标）", async () => {
  const env = await offlineRunEnv();
  const sessionDir = await tempDir("erix-run-654-no-owner-");
  const sessionHandles = jobsApi.globalSessionHandleRegistry();
  const sessionA = "654-no-owner-A";
  try {
    const extension = await loadExtensionModule();
    // A 是个正常会话（句柄在表里）；派工的那个会话拿不到 sessionId（宿主没给 / 给了空串）
    const a = startSession(extension, { sessionId: sessionA });
    const anonymous = startSession(extension, { sessionId: "" });

    const { job } = await dispatchAndSettle(extension, anonymous, {
      task: "t", cwd: sessionDir, sessionDir, async: true, maxRounds: 2,
    });

    assert.equal(a.received(), 0, "没有会话身份时不能退化成「投给某个存活会话」");
    assert.equal(anonymous.received(), 0, "连匿名会话自己也不投（没有可靠目标就不猜）");
    assert.equal(jobView(job).delivery, "no-owner");
    assert.equal(jobView(job).notifyTargetSessionId, null, "没有目标就是 null，不编一个 id");
    assert.equal(jobView(job).ownerSessionId, null);
  } finally {
    sessionHandles.delete(sessionA);
    env.restore();
  }
});

test("#654 缺陷1：session_shutdown(\"quit\") 摘掉本会话句柄；\"reload\" 保留（新实例会以同一 sessionId 重新注册）", async () => {
  const env = await offlineRunEnv();
  const sessionHandles = jobsApi.globalSessionHandleRegistry();
  const quitSession = "654-shutdown-quit";
  const reloadSession = "654-shutdown-reload";
  try {
    const extension = await loadExtensionModule();

    const quit = startSession(extension, { sessionId: quitSession });
    assert.equal(sessionHandles.has(quitSession), true, "session_start 之后句柄必须在表里");
    quit.handlers.get("session_shutdown")({ reason: "quit" });
    assert.equal(sessionHandles.has(quitSession), false,
      "quit 之后投递按 owner 查不到 ⇒ orphaned（而不是投进一个已经不存在的会话）");

    const reload = startSession(extension, { sessionId: reloadSession });
    reload.handlers.get("session_shutdown")({ reason: "reload" });
    assert.equal(sessionHandles.has(reloadSession), true,
      "reload 不算会话走了：新实例会以同一个 sessionId 重新注册，摘掉只会制造一段假 orphaned 窗口");
  } finally {
    sessionHandles.delete(quitSession);
    sessionHandles.delete(reloadSession);
    env.restore();
  }
});

test("#659 第5格：getSessionId() 真抛异常 ⇒ 仍是 no-owner，但盘上带根因（ownerSessionError / notifyError）", async () => {
  const env = await offlineRunEnv();
  const sessionHandles = jobsApi.globalSessionHandleRegistry();
  const sessionDir = await tempDir("erix-run-659-owner-throw-");
  const throwingSession = "659-owner-throw";
  try {
    const extension = await loadExtensionModule();

    // 会话正常启动（session_start 里 getSessionId 还能用），之后派工那一刻才真抛
    const session = startSession(extension, { sessionId: throwingSession });
    session.ctx.sessionManager.getSessionId = () => { throw new Error("session manager exploded"); };
    const { job } = await dispatchAndSettle(extension, session, {
      task: "t", cwd: sessionDir, sessionDir, async: true, maxRounds: 2,
    });

    assert.equal(jobView(job).delivery, "no-owner", "拿不到会话身份就是 no-owner（不猜目标）");
    assert.match(jobView(job).ownerSessionError ?? "", /session manager exploded/u,
      "真异常的原文要进 ownerSessionError（以前 `catch { return undefined }` 把它吃掉了）");
    assert.match(jobView(job).notifyError ?? "", /session manager exploded/u,
      "no-owner 的根因也要进 notifyError（否则盘上只有一句 no-owner，没有任何解释字段）");
    const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId: job.runId }), "utf8"));
    assert.equal(disk.delivery, "no-owner");
    assert.match(disk.ownerSessionError ?? "", /session manager exploded/u, "status.json 上读得到根因");
    assert.match(disk.notifyError ?? "", /session manager exploded/u);

    // 对照：**正常缺失**（宿主没给 sessionManager）不是异常 ⇒ 不留假根因
    const anonymous = startSession(extension, { sessionId: "" });
    anonymous.ctx.sessionManager = undefined;
    const normal = await dispatchAndSettle(extension, anonymous, {
      task: "t", cwd: sessionDir, sessionDir, async: true, maxRounds: 2,
    });
    assert.equal(jobView(normal.job).delivery, "no-owner");
    assert.equal(jobView(normal.job).ownerSessionError, null, "没有异常就不许编一条根因");
    assert.equal(jobView(normal.job).notifyError, null);
  } finally {
    sessionHandles.delete(throwingSession);
    env.restore();
  }
});

test("#654 缺陷2：未终局时 delivery / notifyTargetSessionId / notifyError 恒在场（null），取值域只有五个", async () => {
  assert.deepEqual([...jobsApi.DELIVERY_VALUES], ["sent", "deduped", "failed", "orphaned", "no-owner"],
    "投递事实的取值域是契约（README 同口径）");

  const sessionDir = await tempDir("erix-run-654-preterminal-");
  const job = gatedJob();
  const { runtime, registry } = await makeRuntime({ job: job.job, sent: [] });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  const running = jobView(registry.get(handle.runId));
  for (const field of ["delivery", "notifyTargetSessionId", "notifyError", "ownerSessionId", "deduped",
    "ownerSessionError", "notifyRetries", "resume"]) {
    assert.ok(field in running, `${field} 必须恒在场（查询侧不必分两种形状解析）`);
  }
  assert.equal(running.delivery, null, "还没投递就给 null（不编一个 sent）");
  assert.equal(running.notifyTargetSessionId, null);
  assert.equal(running.notifyError, null);
  assert.equal(running.ownerSessionId, null);
  assert.equal(running.deduped, 0);
  assert.equal(running.ownerSessionError, null, "没有真异常就是 null（不编根因）");
  assert.equal(running.notifyRetries, 0, "还没排过重试");
  assert.equal(running.resume, null, "还没终局 = 还没有坐标事实（不是「不能续跑」，那是 resumable 的事）");

  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed");
});

test("#654 缺陷2（顺序坑）：投递事实必须**先产生再落盘**——status.json 上读得到 delivery / notifyTargetSessionId", async () => {
  const sessionDir = await tempDir("erix-run-654-order-");
  const sent = [];
  const sessionHandles = jobsApi.createSessionHandleRegistry();
  const handleOfOwner = { deliver: () => true };
  sessionHandles.set("654-order-sess", handleOfOwner);
  const runtime = createAsyncRuntime({
    home: await tempDir("erix-run-654-order-home-"),
    registry: createAsyncJobRegistry(),
    sendRegistry: createCompletionSendRegistry(),
    sessionHandles,
    runJob: async () => ({ ...P_OK }),
    // 只收下「投递口拿到的句柄」：断言「拿到的是 owner 会话的句柄」这一件事
    notify: (runJob, content, options) => {
      sent.push(options.session);
      return "sent";
    },
  });

  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true }, { sessionId: "654-order-sess" });
  await waitUntil(() => runtime.registry.get(handle.runId).status === "completed");

  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId: handle.runId }), "utf8"));
  assert.equal(disk.delivery, "sent",
    "先落盘后投递会让这里永远是 null（缺陷 2 的顺序坑：只加字段不调顺序等于没修）");
  assert.equal(disk.notifyTargetSessionId, "654-order-sess");
  assert.equal(sent.length, 1);
  assert.equal(sent[0], handleOfOwner, "投递口拿到的必须是 **owner 会话的** 句柄");
});

test("#654 缺陷3：投递失败不再被记成「已投递」——false / 抛异常都记 failed，且去重位没被锁死", async () => {
  const sessionDir = await tempDir("erix-run-654-failed-");
  const attempts = [];
  const sessionHandles = jobsApi.createSessionHandleRegistry();
  sessionHandles.set("654-fail-sess", { deliver: () => true });
  const registry = createAsyncJobRegistry();
  const sendRegistry = createCompletionSendRegistry();
  const runtime = createAsyncRuntime({
    home: await tempDir("erix-run-654-failed-home-"),
    registry,
    sendRegistry,
    sessionHandles,
    runJob: async () => ({ ...P_OK }),
    notify: (runJob, content, options) => {
      attempts.push(options.session);
      if (attempts.length === 1) return false;                     // 宿主显式拒绝
      if (attempts.length === 2) throw new Error("host exploded");  // 调用抛异常
      return "sent";
    },
  });

  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true }, { sessionId: "654-fail-sess" });
  await waitUntil(() => registry.get(handle.runId).status === "completed");
  const job = registry.get(handle.runId);
  assert.equal(jobView(job).delivery, "failed", "显式 false 不能记成已投递");

  // 旧代码在这里就锁死了（`notify(...) !== false` ⇒ `claim.settle(true)`），下面两次都只会是 deduped。
  assert.equal(runtime.notifySettled(job).delivery, "failed", "抛异常也要记 failed");
  assert.match(jobView(job).notifyError ?? "", /host exploded/u, "失败原因要可机读（进 status.json）");

  assert.equal(runtime.notifySettled(job).delivery, "sent");
  assert.equal(attempts.length, 3, "三次都真的调了投递口（失败没有被记成已投递）");
  assert.equal(jobView(job).notifyError, null, "成功之后不该留着上一次的错误");

  const dedupedAgain = runtime.notifySettled(job);
  assert.equal(dedupedAgain.deduped, true, "投成功之后才允许去重");
  assert.equal(jobView(job).delivery, "sent", "去重不能把「已经投出去」改写成 deduped");
  assert.equal(jobView(job).deduped, 1);
  assert.equal(attempts.length, 3, "deduped 不再调投递口");
});
