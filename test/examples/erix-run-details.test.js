// issue #237 R2：`erix_run` 的**每一条返回路径**的 `AgentToolResult.details` 必须可 JSON 序列化。
//
// 缺陷原文（#234 的真进程 rpc e2e 抓出来的，单元测试当时全绿）：`erix-run-jobs.js` 的
// `start()` 返回 `{kind, handle, job}`，第三个字段 `job` 是**活对象**（AbortController /
// `setTimeout` 句柄 / 未结算 promise，内部还有循环引用），而 `erix-run.ts` 把整个 `outcome`
// 原样当 `details` 交出去 → pi 序列化 `details` 时抛
// `Converting circular structure to JSON` → 白烧一轮 auto-retry，可机读面在真进程里是坏的。
//
// 本文件的三条主张（每条都用**独立实现**的扫描器判「是不是活对象」，不回读生产代码的扫描器，
// 否则就是自证）：
//   1. `JSON.stringify(result.details)` 与 `JSON.stringify(result)` 都不抛；
//   2. `content[0].text` 非空（文本面不能因为组装而变空）；
//   3. `details` 递归扫描后只含 plain 数据（plain object / array / string / number / boolean /
//      null/undefined），**没有函数、类实例（Promise / AbortController / Timeout）、循环引用**；
//      并且**形状是钉死的**（每个 `kind` 的键集合逐个断言）——「塞进更多东西」也算红。
//
// 覆盖路径：`started` | `status` | `result` | `list` | `cancel` | `unknown-run` | `error`
// | `crashed` + **同步终局**（`details: payload` / `structuredContent: payload` 一并纳入）。
// 全部离线：内层 run 走注入的 `runJob`，`cwd` / `home` / `sessionDir` 一律临时目录。

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAsyncJobRegistry,
  createAsyncRuntime,
  createCompletionSendRegistry,
} from "../../examples/pi-extension/erix-run-jobs.js";
import {
  formatAsyncResult,
  formatCrashResult,
  formatSyncResult,
} from "../../examples/pi-extension/erix-run-format.js";

function tempDir(prefix = "erix-run-details-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function waitUntil(predicate, { timeoutMs = 3_000, stepMs = 5, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ---------------------------------------------------------------------------
// 独立实现的「活对象」扫描器（**故意不 import 生产代码里的那一份**）
// ---------------------------------------------------------------------------

/**
 * 递归找出一棵树里第一处「宿主序列化不了 / 序列化出来是废话」的值，返回它的路径与理由。
 * 允许：string / number / boolean / null / undefined / plain object / array。
 * 拒绝：function / symbol / bigint / **非 plain 的对象（类实例：Promise、AbortController、
 * Timeout、Date…）** / 循环引用。
 */
function findLivePath(value, where = "$", stack = new Set()) {
  if (value === null || value === undefined) return undefined;
  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") return `${where}: ${type}`;
  if (type === "string" || type === "number" || type === "boolean") return undefined;
  if (type !== "object") return `${where}: ${type}`;
  if (stack.has(value)) return `${where}: circular`;
  stack.add(value);
  let hit;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      hit = findLivePath(value[i], `${where}[${i}]`, stack);
      if (hit !== undefined) break;
    }
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      hit = `${where}: 非 plain 对象（${value?.constructor?.name ?? "?"}）`;
    } else {
      for (const key of Object.keys(value)) {
        hit = findLivePath(value[key], `${where}.${key}`, stack);
        if (hit !== undefined) break;
      }
    }
  }
  stack.delete(value);
  return hit;
}

/** 一条工具结果是否「宿主可以安全落盘/转发」：文本面非空 + details 全是 plain 数据 + 序列化不抛。 */
function assertMachineReadable(result, label) {
  assert.ok(result !== null && typeof result === "object", `${label}: 必须返回一个结果对象`);
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === "text", `${label}: content[0] 必须是 text`);
  assert.equal(
    typeof result.content[0].text === "string" && result.content[0].text.trim() !== "",
    true,
    `${label}: 文本面不能是空的`,
  );
  const live = findLivePath(result.details);
  assert.equal(live, undefined, `${label}: details 里不许有活对象/循环引用，实测 ${live}`);
  assert.doesNotThrow(() => JSON.stringify(result.details), `${label}: JSON.stringify(details) 不能抛`);
  assert.doesNotThrow(() => JSON.stringify(result), `${label}: 整个 AgentToolResult 不能抛`);
  assert.doesNotThrow(() => JSON.stringify(result.content), `${label}: content 不能抛`);
  if (result.structuredContent !== undefined) {
    assert.equal(findLivePath(result.structuredContent), undefined, `${label}: structuredContent 里不许有活对象`);
    assert.doesNotThrow(() => JSON.stringify(result.structuredContent), `${label}: JSON.stringify(structuredContent) 不能抛`);
  }
}

/** 从真 runtime 拿到一条 `kind:"started"` 的真实 outcome（内层 run 是可控的假 run）。 */
function okPayload(extra = {}) {
  return {
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
    ...extra,
  };
}

function gatedJob(extra = {}) {
  const state = { started: 0, settled: 0 };
  let unblock = null;
  const gate = new Promise((resolve) => { unblock = resolve; });
  state.release = () => unblock();
  state.job = async () => {
    state.started += 1;
    await gate;
    state.settled += 1;
    return okPayload(extra.payload ?? {});
  };
  return state;
}

function makeRuntime({ job, sent = [] } = {}) {
  const home = tempDir("erix-run-details-home-");
  const registry = createAsyncJobRegistry();
  const runtime = createAsyncRuntime({
    home,
    registry,
    sendRegistry: createCompletionSendRegistry(),
    notify: (runJob, content, options) => { sent.push({ runId: runJob.runId, content, ...options }); return true; },
    ...(job === undefined ? {} : { runJob: job }),
  });
  return { runtime, home, registry, sent };
}

// ---------------------------------------------------------------------------
// 全路径矩阵：每一条返回路径都过一遍 assertMachineReadable
// ---------------------------------------------------------------------------

test("#237 R2：全部返回路径（started/status/result/list/cancel/unknown-run/error/crashed/同步）的 details 都可序列化", async () => {
  const job = gatedJob();
  const { runtime } = makeRuntime({ job: job.job });
  const sessionDir = tempDir("erix-run-details-sess-");

  const started = runtime.start({ task: "改点东西", cwd: sessionDir, sessionDir, async: true, maxRounds: 4 });
  const runId = started.handle.runId;
  await waitUntil(() => runtime.registry.get(runId).status === "running", { label: "running" });

  const cases = [
    ["started", started],
    ["status", runtime.act({ action: "status", runId })],
    ["list", runtime.act({ action: "list" })],
    ["unknown-run", runtime.act({ action: "status", runId: "no-such-run-237" })],
    ["error", runtime.act({ action: "cancel" })],
    // crashed 这一条走 formatAsyncResult 的委托分支（`kind === "crashed"` → 同一个形状）
    ["crashed", { kind: "crashed", message: "boom" }],
  ];
  for (const [label, outcome] of cases) {
    assertMachineReadable(formatAsyncResult(outcome), `路径 ${label}`);
  }

  // cancel（活跃 run → cancelled:true）
  const cancel = runtime.act({ action: "cancel", runId });
  assert.equal(cancel.kind, "cancel");
  assertMachineReadable(formatAsyncResult(cancel), "路径 cancel(已取消)");

  // 放行 → 内层终局 → result 路径
  job.release();
  await waitUntil(() => runtime.registry.get(runId).payload !== undefined, { label: "settled" });
  assertMachineReadable(formatAsyncResult(runtime.act({ action: "result", runId })), "路径 result");
  // 已结束的 run 再取消 → 「无需取消」是另一条形状
  assertMachineReadable(formatAsyncResult(runtime.act({ action: "cancel", runId })), "路径 cancel(已结束)");
  // 空注册表的 list（`jobs: []` 也要能序列化，且文本非空）
  const empty = makeRuntime({ job: job.job });
  assertMachineReadable(formatAsyncResult(empty.runtime.act({ action: "list" })), "路径 list(空表)");
});

// ---------------------------------------------------------------------------
// started：#237 的原始缺陷点
// ---------------------------------------------------------------------------

test("#237 R1/R2：async 派工 —— jobs 层返回值本身不带活对象，details 只有 handle", async () => {
  const job = gatedJob();
  const { runtime } = makeRuntime({ job: job.job });
  const sessionDir = tempDir("erix-run-details-start-");

  const outcome = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  // ① jobs 层的返回值自身必须可序列化（离线复现脚本 repro-circular-details.mjs 量的就是这一层；
  //    活对象 job 一旦回来，这里就抛 Converting circular structure to JSON）
  const live = findLivePath(outcome);
  assert.equal(live, undefined, `dispatch 的返回值里不许有活对象，实测 ${live}`);
  assert.doesNotThrow(() => JSON.stringify(outcome), "outcome 自身必须可序列化");
  assert.equal("job" in outcome, false, "job 只留在 dispatch 内部用，绝不进返回值");

  // ② 工具结果面：details 只有 {kind, handle}，形状钉死
  const result = formatAsyncResult(outcome);
  assertMachineReadable(result, "started");
  assert.deepEqual(Object.keys(result.details).sort(), ["handle", "kind"]);
  assert.equal(result.details.kind, "started");
  assert.deepEqual(result.details.handle, outcome.handle);
  assert.deepEqual(
    Object.keys(result.details.handle).sort(),
    ["cwd", "maxRounds", "model", "quiet", "runId", "sessionDir", "status", "statusPath", "timeoutMs"],
  );
  assert.equal(result.isError, undefined, "派工成功不是错误");
  assert.match(result.content[0].text, new RegExp(outcome.handle.runId, "u"));

  job.release();
  await waitUntil(() => runtime.registry.get(outcome.handle.runId).status === "completed", { label: "completed" });
});

test("#237 R2：status / result 的 details 只有 {kind, source, view}，view 里也不许有活对象", async () => {
  const job = gatedJob();
  const { runtime, registry } = makeRuntime({ job: job.job });
  const sessionDir = tempDir("erix-run-details-view-");
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });

  await waitUntil(() => registry.get(handle.runId).status === "running", { label: "running" });
  const statusResult = formatAsyncResult(runtime.act({ action: "status", runId: handle.runId }));
  assertMachineReadable(statusResult, "status");
  assert.deepEqual(Object.keys(statusResult.details).sort(), ["kind", "source", "view"]);
  assert.equal(statusResult.details.kind, "status");
  assert.equal(statusResult.details.source, "memory");
  assert.equal(statusResult.details.view.status, "running");
  assert.equal(statusResult.details.view.termination, null);

  job.release();
  await waitUntil(() => registry.get(handle.runId).status === "completed", { label: "completed" });
  const resultOutcome = runtime.act({ action: "result", runId: handle.runId });
  const resultResult = formatAsyncResult(resultOutcome);
  assertMachineReadable(resultResult, "result");
  assert.deepEqual(Object.keys(resultResult.details).sort(), ["kind", "source", "view"]);
  assert.equal(resultResult.details.kind, "result");
  assert.equal(resultResult.details.view.status, "completed");
  assert.equal(resultResult.details.view.termination.reason, "end_turn");
  assert.deepEqual(resultResult.details.view.usage, { input_tokens: 11, output_tokens: 4 });
  // result 的文本面要带上终稿（组装细节没被顺手删掉）
  assert.match(resultResult.content[0].text, /任务已完成/u);
});

test("#237 R2：list 的 details 是 {kind, jobs, active}，表里每行都必须是 plain 数据", async () => {
  const job = gatedJob();
  const { runtime } = makeRuntime({ job: job.job });
  const sessionDir = tempDir("erix-run-details-list-");
  runtime.start({ task: "a", cwd: sessionDir, sessionDir, async: true });
  runtime.start({ task: "b", cwd: sessionDir, sessionDir, async: true, quiet: true });

  const result = formatAsyncResult(runtime.act({ action: "list" }));
  assertMachineReadable(result, "list");
  assert.deepEqual(Object.keys(result.details).sort(), ["active", "jobs", "kind"]);
  assert.equal(result.details.kind, "list");
  assert.equal(result.details.active, 2);
  assert.equal(result.details.jobs.length, 2);
  for (const row of result.details.jobs) {
    assert.equal("job" in row, false, "list 的每行也不能带活对象 job");
    assert.equal(findLivePath(row), undefined);
  }
  assert.match(result.content[0].text, /2 个 run/u);

  job.release();
  await waitUntil(() => runtime.act({ action: "list" }).active === 0, { label: "all settled" });
});

test("#237 R2：unknown-run / error 的小对象可序列化且报 isError", async () => {
  const { runtime } = makeRuntime({ job: gatedJob().job });

  const unknown = formatAsyncResult(runtime.act({ action: "status", runId: "ghost-237" }));
  assertMachineReadable(unknown, "unknown-run");
  assert.deepEqual(Object.keys(unknown.details).sort(), ["kind", "message", "runId"]);
  assert.equal(unknown.details.kind, "unknown-run");
  assert.equal(unknown.details.runId, "ghost-237");
  assert.equal(unknown.isError, true, "查不存在的 run 要让模型看得见");

  const badParams = formatAsyncResult(runtime.act({ action: "status" }));
  assertMachineReadable(badParams, "error(bad_params)");
  assert.deepEqual(Object.keys(badParams.details).sort(), ["code", "kind", "message"]);
  assert.equal(badParams.details.code, "bad_params");
  assert.equal(badParams.isError, true);
});

test("#237 R2：crashed（扩展内部异常）的小对象可序列化", () => {
  const result = formatCrashResult("Cannot read properties of undefined");
  assertMachineReadable(result, "crashed");
  assert.deepEqual(Object.keys(result.details).sort(), ["crashed", "error"]);
  assert.equal(result.details.crashed, true);
  assert.equal(result.details.error, "Cannot read properties of undefined");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cannot read properties of undefined/u);
});

// ---------------------------------------------------------------------------
// 同步终局面（#207 的形状，#237 只是补断言）
// ---------------------------------------------------------------------------

test("#237 R1/R2：同步终局的 details / structuredContent 可序列化且形状与 payload 逐字相同", () => {
  const payload = okPayload({ diagnostics: { observerErrors: { count: 0, samples: [] }, runId: "r-1" } });
  const result = formatSyncResult(payload);

  assertMachineReadable(result, "sync");
  assert.deepEqual(result.details, payload, "details 必须还是那份结构化载荷（组装不许改形状）");
  assert.deepEqual(result.structuredContent, payload, "structuredContent 与 details 同源");
  assert.equal(result.isError, undefined, "ok:true 不报 isError");
  assert.match(result.content[0].text, /任务已完成/u);
  assert.deepEqual(result.usage, {
    input: 11, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }, "usage 仍按 #207 的口径交给 pi");

  // 失败终局：isError 仍然要报（形状不变，只是多一个 isError 键）
  const failed = formatSyncResult(okPayload({ ok: false, termination: { reason: "failed", errorCode: "unknown" } }));
  assertMachineReadable(failed, "sync(failed)");
  assert.equal(failed.isError, true);

  // 用户取消不算工具失败（那是人的决定）
  const aborted = formatSyncResult(okPayload({ ok: false, aborted: true, termination: { reason: "aborted" } }));
  assertMachineReadable(aborted, "sync(aborted)");
  assert.notEqual(aborted.isError, true);

  // 抛错路径的载荷里 error 是 plain 对象（jobs 层组装的），也不能被当成活对象
  const thrown = formatSyncResult(okPayload({
    ok: false,
    termination: { reason: "failed", detail: "boom", errorCode: "unknown" },
    error: { name: "Error", message: "boom" },
  }));
  assertMachineReadable(thrown, "sync(throw)");
  assert.deepEqual(thrown.details.error, { name: "Error", message: "boom" });
});

// ---------------------------------------------------------------------------
// 守卫：上游（jobs/core）哪天把活对象混进视图时，details 退化但绝不抛
// ---------------------------------------------------------------------------

test("#237 R2：守卫 —— view 里混进活对象时 details 退化而不是把宿主带崩", async () => {
  const job = gatedJob();
  const { runtime } = makeRuntime({ job: job.job });
  const sessionDir = tempDir("erix-run-details-guard-");
  const { handle } = runtime.start({ task: "t", cwd: sessionDir, sessionDir, async: true });
  await waitUntil(() => runtime.registry.get(handle.runId).status === "running", { label: "running" });

  // 模拟「上游回归」：查询视图里混进了活 job（AbortController + 定时器 + 未结算 promise）
  const polluted = runtime.act({ action: "status", runId: handle.runId });
  polluted.view.controller = new AbortController();
  polluted.view.timer = setTimeout(() => {}, 10_000);
  polluted.view.callback = () => {};
  polluted.view.tailPromise = Promise.resolve(1);

  const result = formatAsyncResult(polluted);
  assert.doesNotThrow(() => JSON.stringify(result.details), "守卫必须挡住活对象（宁可退化也不抛）");
  assert.equal(findLivePath(result.details), undefined, "退化后的 details 仍须是 plain 数据");
  assert.equal(result.details.detailsDropped, true);
  assert.equal(result.details.kind, "status");
  assert.match(result.details.dropReason, /controller|timer|callback|tailPromise/u, "要指名丢在哪，别静默吞掉");
  assert.equal(
    typeof result.content[0].text === "string" && result.content[0].text.includes(handle.runId),
    true,
    "退化只影响 details，文本面照常",
  );
  clearTimeout(polluted.view.timer);
  job.release();
});
