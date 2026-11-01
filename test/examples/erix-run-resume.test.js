// issue #207 R2：erix_run 的 **resume** 通道离线单测（从盘上账本续跑，而不是每次整单重跑）。
//
// 全部离线：真 `runToolLoop` + 假 provider（脚本化）+ 临时目录（`makeTmp`）；不触网、不碰 ~/.erix。
//
// 钉住四件事（对应本单的验收点）：
//   ① 第一次 run 停在某处 ⇒ 第二次 run **从账本接着跑**：消息历史 / 轮号 / 账本都不重置；
//   ② resume 一个不存在的 run（或空账本 / 坏 status.json）⇒ **明确报错**，且**不许静默起新 run**；
//   ③ 参数校验：非法值一律 `bad_params`（不静默当成「没传」）；
//   ④ 异步面打通：`status.json` 本身就是续跑坐标（job 沿用原 runId，status.json 还是同一个文件）。
//
// 引擎侧的真值（本文件不复制口径，只消费）：
//   - 续跑入口 = `config.run.resume: true` + `runId` + 装着账本的 store（`src/loop/resume-manager.js`
//     的 `restoreResume` 只读账本）；扁平 `resume` 已在 #498 S3 A19 退役（`src/loop/option-normalization.js`）。
//   - 新任务入账走公共导出 `appendUserTurn`（`src/store/append-user-turn.js`，CLI `-c` 同一条通道）。

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendUserTurn,
  createFileTranscriptStore,
  createJsonFileModelConfigProvider,
  createMemoryTranscriptStore,
  runToolLoop,
} from "../../src/index.js";
import * as core from "../../examples/pi-extension/erix-run-core.js";
import {
  createAsyncJobRegistry,
  createAsyncRuntime,
  createCompletionSendRegistry,
} from "../../examples/pi-extension/erix-run-jobs.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { makeTmp } from "../helpers/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const FIRST_TASK = "第一段任务：把 A 改成 B";
const SECOND_TASK = "继续：把 C 也改掉";

/** 一次「预算用尽」的收口：第 1 轮出工具调用，第 2 次请求被强制收尾 ⇒ termination `max_rounds_cap`。 */
const toolStep = (id) => ({
  content: [{ type: "tool_use", id, name: "exec", input: { command: "echo hi" } }],
  stopReason: "tool_use",
  usage: { input_tokens: 7, output_tokens: 2 },
});
const textStep = (text) => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 3 },
});

async function tempDir(prefix = "erix-run-resume-") {
  return makeTmp(prefix);
}

/** job 的三种终局（`completed` / `failed` / `aborted`）——续跑测试关心的是「结算完了」而不是「成功了」。 */
const TERMINAL_JOB_STATUSES = Object.freeze(["completed", "failed", "aborted"]);

async function waitUntil(predicate, { timeoutMs = 5_000, stepMs = 5, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function fakeSlot() {
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

/** 假 lib：**真** runToolLoop / 真 store 工厂 / 真 appendUserTurn（引擎口径不在这里复制）。 */
function fakeLib() {
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
      appendUserTurn,
    },
    binTools: {
      buildCliToolsSystemPrompt: () => "SYS",
      createCliTools: () => ({ tools: [], executeTool: async () => "unused", truncateResult: (t) => t }),
      truncateResult: (text) => text,
    },
    binFinalGuard: {},
  };
}

/**
 * 装配齐活的 deps：真 `runToolLoop` + 假 provider + 真文件 store（不注入 `createStore`，
 * 让 `sessionDir` 这条生产路径自己决定落盘位置——resume 的坐标正是从它推出来的）。
 */
function makeDeps({ provider, home, captured, progress, extra = {} } = {}) {
  return {
    env: {},
    home,
    now: () => 1_700_000_000_000,
    loadLib: async () => fakeLib(),
    loadSlot: async () => fakeSlot(),
    createProvider: () => provider,
    createAssembly: () => ({ tools: [], executeTool: async () => "tool-ok" }),
    runLoop: (options) => {
      if (captured) captured.options = options;
      return runToolLoop(options);
    },
    ...(progress === undefined ? {} : { onProgress: progress }),
    ...extra,
  };
}

function readRows(transcriptPath) {
  return readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** 账本里**宿主预写**的用户轮（`appendUserTurn` 的 `:input:` 命名空间）有几条。 */
function inputRowCount(rows) {
  return rows.filter((row) => /:input:/u.test(String(row?.dedupKey ?? row?.roundKey ?? ""))).length;
}

/** 一次请求里的全部正文（断言「历史有没有被重置」用）。 */
function requestText(provider, index = 0) {
  return JSON.stringify(provider.requests?.[index]?.messages ?? []);
}

// ---------------------------------------------------------------------------
// ① 从账本续跑：历史 / 轮号 / 账本都不重置
// ---------------------------------------------------------------------------

test("#207 R2①：第一次 run 停在 max_rounds_cap ⇒ 第二次 run 从账本接着跑（历史与轮号都不重置）", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const sessionDir = await tempDir("erix-run-resume-sessions-");
  const work = await tempDir("erix-run-resume-work-");

  // —— 第一次：maxRounds 1 ⇒ 一轮工具调用之后预算用尽（forcedFinal 收口），账本留在盘上。
  const first = await core.runErixRun(
    { task: FIRST_TASK, cwd: work, maxRounds: 1, sessionDir },
    makeDeps({ provider: createFakeProvider([toolStep("c1"), textStep("任务已完成（第一段）")]), home }),
  );
  assert.equal(first.termination.reason, "max_rounds_cap", JSON.stringify(first.termination));
  assert.equal(first.ok, false, "预算用尽不是采纳终局");
  // ① resumable 是**事实**：落了盘 ⇒ true，handle 就是那个账本文件。
  assert.equal(first.resumable, true);
  const handle = first.diagnostics.resume.handle;
  assert.equal(handle, path.join(sessionDir, `${first.diagnostics.runId}.jsonl`));
  assert.equal(existsSync(handle), true, `handle 必须是盘上真文件：${handle}`);
  assert.equal(first.diagnostics.resume.handleKind, "transcript");
  assert.equal(first.diagnostics.resume.resumedFrom, null, "第一次 run 不是续跑");

  const rowsBefore = readRows(handle);
  assert.ok(rowsBefore.length > 0, "账本不能是空的（否则 resume 没有现场可续）");
  assert.equal(inputRowCount(rowsBefore), 0, "第一次 run 没有宿主预写轮");

  // —— 第二次：只给 handle + cwd + 新任务（不给 sessionDir，坐标自己反推）。
  const secondProvider = createFakeProvider([textStep("任务已完成（第二段）")]);
  const second = await core.runErixRun(
    { resume: handle, cwd: work, task: SECOND_TASK, maxRounds: 3 },
    makeDeps({ provider: secondProvider, home }),
  );
  assert.equal(second.ok, true, JSON.stringify(second.termination));
  assert.equal(second.termination.reason, "end_turn");
  assert.equal(second.diagnostics.runId, first.diagnostics.runId, "续跑沿用原 runId（不新起一个身份）");
  assert.equal(second.diagnostics.sessionDir, sessionDir, "sessionDir 从坐标反推出来");
  assert.equal(second.diagnostics.cwd, work);
  assert.deepEqual(second.diagnostics.resume.resumedFrom, {
    handle,
    kind: "transcript",
    runId: first.diagnostics.runId,
    sessionDir,
    transcriptPath: handle,
  });

  // 历史**不重置**：第二次 run 的第一次请求里，第一次的 task / tool_use / tool_result 全在。
  const sent = requestText(secondProvider, 0);
  assert.match(sent, new RegExp(FIRST_TASK, "u"), "第一次的 task 必须还在上下文里");
  assert.match(sent, /"type":"tool_use"/u);
  assert.match(sent, /tool-ok/u, "第一次跑出来的工具结果必须还在（不是整单重跑）");
  assert.match(sent, new RegExp(SECOND_TASK, "u"), "新任务作为一条用户轮追加进账本");
  // 轮号续上（不是从 0 重数）：第一次 1 轮 ⇒ 第二次从第 2 轮起。
  assert.ok(second.rounds > first.rounds, `轮号必须续上：first=${first.rounds} second=${second.rounds}`);

  // 账本只增不减：同一个文件里既有第一次的行，也有第二次的行。
  const rowsAfter = readRows(handle);
  assert.ok(rowsAfter.length > rowsBefore.length, "续跑要往同一份账本里追加，而不是换一个文件");
  assert.deepEqual(
    rowsAfter.slice(0, rowsBefore.length).map((row) => row.round),
    rowsBefore.map((row) => row.round),
    "原有行不许被改写 / 重排（续跑不是重写账本）",
  );
  assert.equal(inputRowCount(rowsAfter), 1, "本次新任务只写一条宿主预写轮（appendUserTurn 的幂等形状）");
  assert.equal(second.resumable, true, "续跑出来的 run 自己也是可续跑的");
  assert.equal(second.diagnostics.resume.handle, handle, "handle 还是同一个账本");
});

test("#207 R2①：不传 task 的续跑是「纯接着跑」——账本里不追加用户轮", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const sessionDir = await tempDir("erix-run-resume-sessions-");
  const work = await tempDir("erix-run-resume-work-");

  const first = await core.runErixRun(
    { task: FIRST_TASK, cwd: work, maxRounds: 1, sessionDir },
    makeDeps({ provider: createFakeProvider([toolStep("c1"), textStep("任务已完成（第一段）")]), home }),
  );
  const handle = first.diagnostics.resume.handle;
  const before = readRows(handle);

  const provider = createFakeProvider([textStep("任务已完成（纯续跑）")]);
  const resumed = await core.runErixRun(
    { resume: handle, cwd: work, maxRounds: 2 },
    makeDeps({ provider, home }),
  );
  assert.equal(resumed.ok, true, JSON.stringify(resumed.termination));
  assert.equal(requestText(provider, 0).includes(SECOND_TASK), false, "没有新任务就不该凭空多一条用户轮");
  assert.match(requestText(provider, 0), new RegExp(FIRST_TASK, "u"), "历史仍是那份账本");
  assert.equal(inputRowCount(readRows(handle)), inputRowCount(before), "纯续跑不写宿主预写轮");
});

test("#207 R2①：runId + sessionDir 与 status.json 两种坐标都指到同一份账本", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const sessionDir = await tempDir("erix-run-resume-sessions-");
  const work = await tempDir("erix-run-resume-work-");

  const first = await core.runErixRun(
    { task: FIRST_TASK, cwd: work, maxRounds: 1, sessionDir },
    makeDeps({ provider: createFakeProvider([toolStep("c1"), textStep("任务已完成（第一段）")]), home }),
  );
  const runId = first.diagnostics.runId;
  const handle = first.diagnostics.resume.handle;

  // 坐标 ③：runId + sessionDir（这条通道不反推文件名，所以哈希化 runId 也能用）。
  const viaRunId = await core.runErixRun(
    { resume: runId, sessionDir, cwd: work, task: "第三段", maxRounds: 2 },
    makeDeps({ provider: createFakeProvider([textStep("任务已完成（第三段）")]), home }),
  );
  assert.equal(viaRunId.ok, true, JSON.stringify(viaRunId.termination));
  assert.equal(viaRunId.diagnostics.runId, runId);
  assert.equal(viaRunId.diagnostics.resume.resumedFrom.kind, "runId");
  assert.equal(viaRunId.diagnostics.resume.resumedFrom.handle, runId);

  // 坐标 ①：status.json（异步面落盘的那份）——自带 runId / sessionDir / **cwd**，所以 cwd 可以省。
  const statusPath = path.join(sessionDir, "outputs", runId, "status.json");
  writeFileSync(statusPath, `${JSON.stringify({
    runId, sessionDir, cwd: work, status: "completed", ok: true,
  }, null, 2)}\n`, "utf8");
  const viaStatus = await core.runErixRun(
    { resume: statusPath, task: "第四段", maxRounds: 2 },
    makeDeps({ provider: createFakeProvider([textStep("任务已完成（第四段）")]), home }),
  );
  assert.equal(viaStatus.ok, true, JSON.stringify(viaStatus.termination));
  assert.equal(viaStatus.diagnostics.runId, runId, "status.json 坐标也沿用原 runId");
  assert.equal(viaStatus.diagnostics.cwd, work, "cwd 从 status.json 里取（不用宿主再传）");
  assert.equal(viaStatus.diagnostics.resume.resumedFrom.kind, "status");
  assert.equal(viaStatus.diagnostics.resume.resumedFrom.handle, statusPath);
  assert.equal(viaStatus.diagnostics.resume.transcriptPath, handle, "两种坐标指向同一份账本");
});

// ---------------------------------------------------------------------------
// ② 续跑一个不存在的 run ⇒ 明确报错，且不静默起新 run
// ---------------------------------------------------------------------------

test("#207 R2②：resume 指向不存在的 run ⇒ resume_not_found，且一次 provider 请求都不发", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const base = await tempDir("erix-run-resume-missing-");
  const work = await tempDir("erix-run-resume-work-");

  const provider = createFakeProvider([textStep("不该跑到这里")]);
  const payload = await core.runErixRun(
    { resume: path.join(base, "no-such-run.jsonl"), cwd: work },
    makeDeps({ provider, home }),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "resume_not_found");
  assert.equal(payload.termination.reason, "failed");
  assert.match(payload.error.message, /不存在/u, "报错要点名「那个坐标不存在」，不是一句泛泛的失败");
  assert.equal(provider.requests.length, 0, "续跑不成立时**不许**静默起一个新 run");
  assert.equal(payload.rounds, 0);
  assert.equal(payload.resumable, false, "这次没跑起来，也没有账本");

  // 空账本（0 字节）与坏 status.json 同样是「明确的错」，而不是一个悄悄开跑的新 run。
  const empty = path.join(base, "empty.jsonl");
  writeFileSync(empty, "", "utf8");
  const emptyPayload = await core.runErixRun({ resume: empty, cwd: work }, makeDeps({ provider, home }));
  assert.equal(emptyPayload.error.code, "resume_not_found");
  assert.match(emptyPayload.error.message, /空的/u);

  const badStatus = path.join(base, "bad-status.json");
  writeFileSync(badStatus, "{ not json", "utf8");
  const badStatusPayload = await core.runErixRun({ resume: badStatus, cwd: work }, makeDeps({ provider, home }));
  assert.equal(badStatusPayload.error.code, "bad_params");
  assert.match(badStatusPayload.error.message, /不是合法 JSON/u);

  const noRunIdStatus = path.join(base, "no-runid.json");
  writeFileSync(noRunIdStatus, JSON.stringify({ status: "completed" }), "utf8");
  const noRunIdPayload = await core.runErixRun({ resume: noRunIdStatus, cwd: work }, makeDeps({ provider, home }));
  assert.equal(noRunIdPayload.error.code, "bad_params");
  assert.match(noRunIdPayload.error.message, /没有 runId/u);

  assert.equal(provider.requests.length, 0, "四种不成立的情形都不许触到 provider");
});

// ---------------------------------------------------------------------------
// ③ 参数校验：非法值归 bad_params（不静默当「没传」）
// ---------------------------------------------------------------------------

test("#207 R2③：resume 的形状校验（非字符串 / 空白 / 相对路径 / 非 .json(.jsonl) / runId 缺 sessionDir）", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const work = await tempDir("erix-run-resume-work-");
  const base = await tempDir("erix-run-resume-bad-");

  const cases = [
    [{ resume: 42 }, /只能是字符串/u],
    [{ resume: { runId: "x" } }, /只能是字符串/u],
    [{ resume: "   " }, /空白字符串/u],
    [{ resume: "rel/path.jsonl" }, /绝对路径/u],
    [{ resume: path.join(base, "notes.txt") }, /只认 \.json \/ \.jsonl/u],
    // runId 形态但没给 sessionDir ⇒ 无处找账本（不当成「起个新 run」）
    [{ resume: "erix-run-2026-01-01T00-00-00.000Z-abcdef" }, /必须同时给 sessionDir/u],
  ];
  for (const [raw, pattern] of cases) {
    const payload = await core.runErixRun({ task: "t", cwd: work, ...raw }, makeDeps({
      provider: createFakeProvider([]), home,
    }));
    assert.equal(payload.ok, false, `${JSON.stringify(raw)} 必须失败`);
    assert.equal(payload.error.code, "bad_params", `${JSON.stringify(raw)} 应归 bad_params`);
    assert.equal(payload.error.stage, "assembly");
    assert.match(payload.error.message, pattern);
  }

  // 哈希化 transcript 文件名反推不回 runId ⇒ 明确要求换一种坐标（不猜一个 runId）。
  const sessionDir = await tempDir("erix-run-resume-hashed-");
  const hashed = path.join(sessionDir, "run-h-0123456789ab.jsonl");
  writeFileSync(hashed, "{\"round\":0}\n", "utf8");
  const hashedPayload = await core.runErixRun({ resume: hashed, cwd: work }, makeDeps({
    provider: createFakeProvider([]), home,
  }));
  assert.equal(hashedPayload.error.code, "bad_params");
  assert.match(hashedPayload.error.message, /哈希化/u);

  // 续跑必须沿用原 runId：显式给一个不同的 runId 是身份冲突，当场拒绝。
  const first = await core.runErixRun(
    { task: FIRST_TASK, cwd: work, maxRounds: 1, sessionDir },
    makeDeps({ provider: createFakeProvider([toolStep("c1"), textStep("任务已完成")]), home }),
  );
  const conflict = await core.runErixRun(
    { resume: first.diagnostics.resume.handle, cwd: work },
    { ...makeDeps({ provider: createFakeProvider([]), home }), runId: "another-run-id" },
  );
  assert.equal(conflict.error.code, "bad_params");
  assert.match(conflict.error.message, /冲突/u);
});

// ---------------------------------------------------------------------------
// ④ 异步面打通：status.json 本身就是续跑坐标
// ---------------------------------------------------------------------------

test("#207 R2④：异步派工 —— status.json 里带续跑坐标，按它 resume 的 job 沿用原 runId", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const sessionDir = await tempDir("erix-run-resume-async-");
  const work = await tempDir("erix-run-resume-work-");

  let provider = createFakeProvider([toolStep("c1"), textStep("任务已完成（第一段）")]);
  const sent = [];
  const runtime = createAsyncRuntime({
    home,
    registry: createAsyncJobRegistry(),
    sendRegistry: createCompletionSendRegistry(),
    notify: (job, content, options) => {
      sent.push({ runId: job.runId, content, ...options });
      return true;
    },
    runJob: (params, opts) => core.runErixRun(params, {
      ...makeDeps({ provider, home }),
      runId: opts.runId,
      ...(opts.resumeTarget === undefined ? {} : { resumeTarget: opts.resumeTarget }),
      signal: opts.signal,
      ...(opts.onProgress === undefined ? {} : { onProgress: opts.onProgress }),
    }),
  });

  const first = await runtime.dispatch({
    task: FIRST_TASK, cwd: work, sessionDir, maxRounds: 1, async: true,
  }, {});
  assert.equal(first.kind, "started");
  const runId = first.handle.runId;
  // 第一次 run 是**故意**用尽预算的（termination=max_rounds_cap ⇒ 状态机的 failed），
  // 这里关心的是「结算完了、盘上 status.json 有终局面」，不是「成功了」。
  await waitUntil(() => TERMINAL_JOB_STATUSES.includes(runtime.registry.get(runId)?.status), { label: "first async run settled" });
  assert.equal(runtime.registry.get(runId)?.status, "failed");

  // status.json（`/reload`、pi 重启后唯一残留）里就带着续跑坐标。
  const statusPath = first.handle.statusPath;
  const disk = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(disk.runId, runId);
  assert.equal(disk.sessionDir, sessionDir);
  assert.equal(disk.cwd, work, "status.json 里有工作目录 ⇒ 用它续跑不必再传 cwd");
  assert.equal(disk.resumable, true);
  assert.equal(disk.diagnostics.resume.handle, disk.artifacts.transcriptPath);
  assert.equal(disk.diagnostics.resume.handle, path.join(sessionDir, `${runId}.jsonl`));

  // 按 status.json 续跑：job 沿用原 runId（不是新开一个身份），status.json 还是同一个文件。
  provider = createFakeProvider([textStep("任务已完成（第二段）")]);
  const second = await runtime.dispatch({ resume: statusPath, task: SECOND_TASK, maxRounds: 3, async: true }, {});
  assert.equal(second.kind, "started");
  assert.equal(second.handle.runId, runId, "续跑的 job 按**原** runId 登记");
  assert.equal(second.handle.statusPath, statusPath);
  assert.equal(second.handle.cwd, work, "cwd 从 status.json 里取");
  assert.equal(runtime.registry.size, 1, "注册表里还是同一个 job，不是两个 run");
  await waitUntil(() => runtime.registry.get(runId)?.status === "completed", { label: "resumed async run settled" });

  const view = runtime.act({ action: "result", runId }).view;
  assert.equal(view.ok, true, JSON.stringify(view.termination));
  assert.equal(view.termination.reason, "end_turn");
  assert.equal(view.resumable, true);
  assert.equal(view.diagnostics.resume.resumedFrom.handle, statusPath);
  assert.equal(view.artifacts.transcriptPath, path.join(sessionDir, `${runId}.jsonl`));

  // 账本里两段任务都在（续跑没有把第一次的历史冲掉）。
  const ledger = JSON.stringify(readRows(view.artifacts.transcriptPath));
  assert.match(ledger, new RegExp(FIRST_TASK, "u"));
  assert.match(ledger, new RegExp(SECOND_TASK, "u"));
  // 两次派工各自结算一次：去重键是「派工序」而不是 runId（续跑让同一个 run 合法地结算多次）。
  assert.equal(sent.length, 2, `两次派工各投一次完成通知，实际 ${sent.length}`);
  assert.equal(sent[0].runId, runId);
  assert.match(sent[0].content, /\[erix_run .*\] failed/u, "第一次是 max_rounds_cap ⇒ failed");
  assert.match(sent[1].content, /\[erix_run .*\] completed/u, "续跑那次是 completed");
});

// ---------------------------------------------------------------------------
// ⑤ 纯内存 run：resumable 是 false 且有明确原因（不是「静默不可续跑」）
// ---------------------------------------------------------------------------

test("#207 R2⑤：没落盘的 run ⇒ resumable=false + reason（且没有 handle 可传回去）", async () => {
  const home = await tempDir("erix-run-resume-home-");
  const work = await tempDir("erix-run-resume-work-");

  const payload = await core.runErixRun(
    { task: FIRST_TASK, cwd: work, maxRounds: 2 },
    makeDeps({ provider: createFakeProvider([textStep("任务已完成")]), home }),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.resumable, false);
  assert.equal(payload.diagnostics.resume.handle, null);
  assert.equal(payload.diagnostics.resume.reason, core.RESUME_REASON_MEMORY);
  // 文本面也要如实说（模型读的是文本，不是可机读面）。
  const facts = core.formatPayloadForModel(payload).split("\n").find((line) => line.startsWith("[facts]"));
  assert.match(facts, /resumable=false/u);
  assert.match(facts, /没有可续跑的账本/u);
});
