// issue #234：erix_run 异步执行面的离线单测（派工即返回句柄 / status→result 生命周期 /
// cancel 终局 aborted / status.json 落盘 / 投递去重 / parent-wake 两条分支 + pending 窗口 +
// reload 安全 / run 级看门狗 / quiet 唤醒策略）。
//
// 全部离线：内层 run 走注入的 runJob（或假 lib + 假 provider 的真 runToolLoop），
// cwd/home/sessionDir 一律注入临时目录 —— 不碰真实 ~/.erix，不触网。
//
// 机制出处：docs/tasks/active/261010-13-erix-run-async/analysis.md（照 pi-subagents 的逐行实现）

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import {
  COMPLETION_SEND_TTL_MS,
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
import { formatAsyncResult } from "../../examples/pi-extension/erix-run-format.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempDir(prefix = "erix-run-async-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
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

function makeRuntime({ job, sent, registry = createAsyncJobRegistry(), sendRegistry = createCompletionSendRegistry(), now, extra = {} } = {}) {
  const home = tempDir("erix-run-async-home-");
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

// ---------------------------------------------------------------------------
// R1：async 参数（默认 false = 同步语义逐字不变）
// ---------------------------------------------------------------------------

test("#234 R1：不传 async / async:false 都走同步语义（返回的是完整终局载荷，不是句柄）", async () => {
  const sent = [];
  const { runtime } = makeRuntime({ job: async () => ({ ...P_OK }), sent });

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
  const { runtime, registry } = makeRuntime({ job: job.job, sent });
  const sessionDir = tempDir("erix-run-async-dir-");

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
  const home = tempDir("erix-run-async-nohome-");
  const dir = tempDir("erix-run-async-nodir-");
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
  const { runtime } = makeRuntime({ job: job.job, sent: [] });
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

test("#234 R2：跨 /reload 查询 —— 内存表空了仍能从 status.json 读回终局", () => {
  const sessionDir = tempDir("erix-run-async-reload-");
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
  const dir = tempDir("erix-run-async-cancel-");
  const home = tempDir("erix-run-async-cancel-home-");
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
  const dir = tempDir("erix-run-async-watchdog-");
  // 内层连 signal 都不看、永远不返回：只有 run 级看门狗能把状态从 running 推到 aborted
  const job = async (_params, { signal }) => {
    await new Promise((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    return new Promise(() => {});
  };
  const { runtime } = makeRuntime({ job, sent });
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
  const dir = tempDir("erix-run-async-late-");
  const { runtime } = makeRuntime({
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
  const { runtime, registry } = makeRuntime({ job: async () => ({ ...P_OK }), sent });
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
  const { runtime } = makeRuntime({ job: async () => ({ ...P_OK }), sent });
  runtime.start({ task: "quiet", cwd: repoRoot, async: true, quiet: true });
  await waitUntil(() => sent.length === 1);
  assert.equal(sent[0].triggersTurn, false, "quiet + completed 不打扰父会话（只落 status.json）");
  assert.equal(sent[0].outcome, "completed");

  const noisy = [];
  const rt2 = makeRuntime({ job: async () => ({ ...P_OK, ok: false, termination: { reason: "failed", errorCode: "unknown" } }), sent: noisy });
  rt2.runtime.start({ task: "quiet-fail", cwd: repoRoot, async: true, quiet: true });
  await waitUntil(() => noisy.length === 1);
  assert.equal(noisy[0].triggersTurn, true, "quiet 也不能吞掉失败（那是可动作的结果）");
  assert.equal(noisy[0].outcome, "failed");
});

// ---------------------------------------------------------------------------
// 机制 6：session_shutdown 幂等清理 + 落盘面的 artifacts 口径
// ---------------------------------------------------------------------------

test("#234 机制6：shutdown 幂等（重复调用不重复清、不抛），并清掉在跑 run 的看门狗定时器", () => {
  const { runtime, registry } = makeRuntime({ job: gatedJob().job, sent: [] });
  const { handle } = runtime.start({ task: "t", cwd: repoRoot, async: true, timeoutMs: core.MIN_TIMEOUT_MS });
  assert.notEqual(registry.get(handle.runId).watchdog, undefined, "派工后定时器必须在");
  assert.equal(runtime.shutdown(), true);
  assert.equal(runtime.shutdown(), false, "第二次调用必须是 no-op");
  assert.equal(registry.get(handle.runId).watchdog, undefined);
});

test("#234 R6：status.json 的 artifacts 沿用 core 的 resolveArtifacts 口径（文件真在盘上才给路径）", async () => {
  const dir = tempDir("erix-run-async-artifacts-");
  const runId = "erix-run-artifact-run";
  const paths = core.artifactPaths({ sessionDir: dir, runId });
  const { runtime } = makeRuntime({ job: gatedJob(), sent: [] });
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

test("#237 R4：writeStatusFile 必须先写 .tmp- 再 rename（退化成直接写同名文件必须变红）", () => {
  const sessionDir = tempDir("erix-run-atomic-");
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

test("#237 R4：rename 失败时旧 status.json 不被破坏、不留 .tmp- 残留、错误被回报而不是抛出", () => {
  const sessionDir = tempDir("erix-run-atomic-rename-fail-");
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

test("#237 R4：写临时文件中途抛错（半截文件已在盘上）同样要清干净并回报错误", () => {
  const sessionDir = tempDir("erix-run-atomic-write-fail-");
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
  const sessionDir = tempDir("erix-run-atomic-runtime-");
  const job = gatedJob();
  const { runtime, registry } = makeRuntime({
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
async function settledRun({ payload = {}, prefix = "erix-run-finaltext" } = {}) {
  const sessionDir = tempDir(`${prefix}-`);
  const sent = [];
  const job = gatedJob({ payload });
  const { runtime, registry } = makeRuntime({ job: job.job, sent });
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });
  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed", { label: "finaltext run completed" });
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
  const sessionDir = tempDir("erix-run-finaltext-running-");
  const job = gatedJob();
  const { runtime, registry } = makeRuntime({ job: job.job, sent: [] });
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
