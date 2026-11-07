// issue #753 C2：`erix_run` 扩展面的 **steer 通道**（`action:"steer"` → job 的内存收件箱 →
// 内层 run 的 `capabilities.hooks.nextUserTurn`）。
//
// 判据逐格（工单「测试要钉的格子」）：
//   1. 装了钩子的 run 会在轮边界被问，队首那条真的进到内层 run 的 messages 里（真 runToolLoop）；
//   2. 多条 steer 按 FIFO，每个轮边界只消费一条；
//   3. 队列空后钩子回 `null`；
//   4. **没 steer ⇒ 不装钩子**：同步面的 runJob 收不到 `nextUserTurn`，装配出来的 options 里连那个键
//      都没有；而「装了但一直回 null」的 run 与「从没装钩子」的 run，账本行与事件序列逐字一致；
//   5. 只在盘上的 job 被拒（`steer_unavailable` / `disk-only`）且 `steerPending` 不变；
//   6. 已结算的 job 被拒（`settled`，理由说「没有下一个轮边界」），不许谎称已投递；
//   7. `steerPending` 进 `jobView` 与盘上 `status.json`（含文本面）；
//   8. `diagnostics.steer` 在**同步面**与异步 `status`/`result`/`status.json` **四面同形**；
//   9. `bad_params` 面：缺 runId / 缺 message / message 空串（含只含空白、非字符串）。
//
// 全部离线：真 `runToolLoop` + 假 provider（`test/helpers/fake-provider.js`），cwd/home/sessionDir
// 一律临时目录 —— 不碰真实 ~/.erix，不触网。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  STEER_UNAVAILABLE_CODE,
  createAsyncJobRegistry,
  createAsyncRuntime,
  createSteerHook,
  jobView,
  steerHookDeps,
  statusFilePath,
} from "../../examples/pi-extension/erix-run-jobs.js";
import { formatAsyncResult } from "../../examples/pi-extension/erix-run-format.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { makeTmp } from "../helpers/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const textOf = (result) => (result?.content ?? []).map((part) => part?.text ?? "").join("\n");

async function tempDir(prefix = "erix-run-steer-") {
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
  finalText: "任务已完成",
  rounds: 2,
  truncated: false,
  usage: { input_tokens: 11, output_tokens: 4 },
  termination: { reason: "end_turn" },
  timeout: false,
  aborted: false,
  artifacts: { transcriptPath: null, judgeLogPath: null },
  extensionCount: 0,
  maxExtensions: 0,
  resumable: false,
  diagnostics: { model: "slot-model" },
};

/** 把 `job` 摆成「只在盘上、内存里没有」：写完 status.json 之后把注册表清掉。 */
async function diskOnlyFixture() {
  const home = await tempDir("erix-run-steer-home-");
  const sessionDir = await tempDir("erix-run-steer-sess-");
  const registry = createAsyncJobRegistry();
  const runtime = createAsyncRuntime({ home, registry, runJob: async () => ({ ...P_OK }), notify: () => true });
  const started = runtime.start({ task: "t", cwd: repoRoot, sessionDir }, { sessionId: "s-1" });
  const runId = started.handle.runId;
  await waitUntil(() => registry.get(runId)?.status === "completed", { label: "settled" });
  runtime.persistStatus(registry.get(runId));
  registry.jobs.delete(runId);
  return { runtime, registry, runId, sessionDir };
}

// ---------------------------------------------------------------------------
// 1. 投成的一面：入队 / 队列长度 / 落盘 / 一次一条
// ---------------------------------------------------------------------------

test("steer 投进活着的 job：steerPending 进 jobView 与 status.json，队列一次消费一条（FIFO）", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const sessionDir = await tempDir("erix-run-steer-sess-");
  const registry = createAsyncJobRegistry();
  const seen = [];
  const runtime = createAsyncRuntime({
    home,
    registry,
    notify: () => true,
    runJob: async (params, deps) => {
      seen.push(deps);
      await waitUntil(() => registry.get(params.runId ?? seen[0].runId)?.steerInbox?.length >= 2, { label: "two steers" });
      const hook = deps.nextUserTurn;
      assert.equal(typeof hook, "function", "异步派工的 runJob 必须收到 nextUserTurn 钩子");
      const first = hook({ round: 1 });
      const second = hook({ round: 2 });
      const third = hook({ round: 3 });
      assert.deepEqual([first, second, third], ["先改测试", "再改实现", null], "FIFO 一次一条，队列空后回 null");
      return { ...P_OK };
    },
  });

  const started = runtime.start({ task: "t", cwd: repoRoot, sessionDir }, { sessionId: "s-1" });
  const runId = started.handle.runId;

  const a = runtime.act({ action: "steer", runId, message: "先改测试" });
  assert.equal(a.kind, "steer");
  assert.equal(a.steered, true);
  assert.equal(a.position, 1);
  assert.equal(a.steerPending, 1);
  assert.equal(a.view.steerPending, 1, "返回的视图当场就带上队列长度");
  assert.match(a.message, /下一个轮边界/u);

  const b = runtime.act({ action: "steer", runId, message: "  再改实现  " });
  assert.equal(b.steered, true);
  assert.equal(b.position, 2);
  assert.equal(b.steerPending, 2);

  // 判据 7：`status.json` 里也要看得见（它是 /reload 之后唯一残留）
  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
  assert.equal(disk.steerPending, 2, `status.json 要带 steerPending，实测 ${disk.steerPending}`);

  await waitUntil(() => registry.get(runId)?.status === "completed", { label: "settled" });
  const after = runtime.act({ action: "status", runId });
  assert.equal(after.view.steerPending, 0, "两条都被取走之后队列是空的（不是停在 2）");
  assert.ok(after.view.progressTail.some((line) => line.startsWith("steer 入队")), "入队有进度行");
  assert.ok(after.view.progressTail.some((line) => line.startsWith("steer 已交给内层 run")), "取走有进度行（旁证）");
  assert.match(textOf(formatAsyncResult(after)), /steerPending=0/u, "文本面也报队列长度");
});

test("steerPending 恒在场：没 steer 的 job 是 0，不是缺键", () => {
  assert.equal(jobView({ runId: "r-0", status: "running" }).steerPending, 0, "没有收件箱的老形状 job 也读得出 0");
  assert.equal(jobView({ runId: "r-1", status: "running", steerInbox: ["x"] }).steerPending, 1);
});

// ---------------------------------------------------------------------------
// 2. 装配闸门：没人 steer ⇒ 一个钩子都不装
// ---------------------------------------------------------------------------

test("闸门：steerHookDeps 只给**真有收件箱**的 job 装钩子；同步面/没收件箱 ⇒ 空 deps", () => {
  assert.deepEqual(steerHookDeps(undefined), {});
  assert.deepEqual(steerHookDeps({}), {}, "没有 steerInbox ⇒ 不装（同步面就是这个形状）");
  assert.deepEqual(steerHookDeps({ steerInbox: null }), {});
  const hook = steerHookDeps({ steerInbox: [] }).nextUserTurn;
  assert.equal(typeof hook, "function", "有收件箱 ⇒ 装（引擎在 runToolLoop 入口一次性捕获，晚装等于装不上）");
  assert.equal(hook({ round: 1 }), null, "空队列回 null —— C1 契约里 null ⇒ 零行、零事件、账本逐字不变");
});

test("同步面（非 async）的 runJob **收不到** nextUserTurn：那次工具调用正阻塞着，没这个通道", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const seen = [];
  const runtime = createAsyncRuntime({
    home,
    registry: createAsyncJobRegistry(),
    notify: () => true,
    runJob: async (params, deps) => {
      seen.push(deps);
      return { ...P_OK };
    },
  });
  const out = await runtime.sync({ task: "t", cwd: repoRoot });
  assert.equal(out.kind, "sync");
  assert.equal(seen.length, 1);
  assert.equal("nextUserTurn" in seen[0], false, `同步面不许装钩子：${JSON.stringify(Object.keys(seen[0]))}`);
  assert.equal(steerHookDeps({ steerInbox: [] }).nextUserTurn.length, 0, "钩子是同步的、不接参数也打得开");
});

// ---------------------------------------------------------------------------
// 3. 拒绝面必须诚实
// ---------------------------------------------------------------------------

test("只在盘上的 job（进程重启后）被拒：steer_unavailable / disk-only，steerPending 不变", async () => {
  const { runtime, runId, sessionDir } = await diskOnlyFixture();
  const before = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8")).steerPending;

  const rejected = runtime.act({ action: "steer", runId, message: "还在吗" });
  assert.equal(rejected.kind, "steer");
  assert.equal(rejected.steered, false, "不许谎称已投递");
  assert.equal(rejected.code, STEER_UNAVAILABLE_CODE);
  assert.equal(rejected.reason, "disk-only");
  assert.equal(rejected.steerPending, before, "被拒不改变队列");
  assert.match(rejected.message, /只存在于盘上/u);
  assert.match(rejected.message, /进程重启/u);

  const result = formatAsyncResult(rejected);
  assert.equal(result.isError, true, "投不进去是调用失败，要让模型看见");
  assert.equal(result.details.steered, false);
  assert.equal(result.details.code, STEER_UNAVAILABLE_CODE);
  assert.match(textOf(result), /steer_unavailable\/disk-only/u);

  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
  assert.equal(disk.steerPending, before, "拒完之后盘上还是原值");
});

test("已结算的 job 被拒：steer_unavailable / settled，理由明说「没有下一个轮边界」", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const registry = createAsyncJobRegistry();
  const runtime = createAsyncRuntime({ home, registry, runJob: async () => ({ ...P_OK }), notify: () => true });
  const runId = runtime.start({ task: "t", cwd: repoRoot }, { sessionId: "s-1" }).handle.runId;
  await waitUntil(() => registry.get(runId)?.status === "completed", { label: "settled" });

  const rejected = runtime.act({ action: "steer", runId, message: "补一句" });
  assert.equal(rejected.steered, false);
  assert.equal(rejected.code, STEER_UNAVAILABLE_CODE);
  assert.equal(rejected.reason, "settled");
  assert.equal(rejected.steerPending, 0, "被拒不入队");
  assert.match(rejected.message, /已结束的 run 没有下一个轮边界/u);
  assert.match(rejected.message, /不是「已投递」/u);
  assert.equal(runtime.registry.get(runId).steerInbox.length, 0, "队列里确实没多出一条");

  // 已取消（aborted）的 job 同样拒：口径同 cancel 的「已经结束」
  const abortedRuntime = createAsyncRuntime({ home, registry: createAsyncJobRegistry(), runJob: async () => ({ ...P_OK }), notify: () => true });
  const abortedId = abortedRuntime.start({ task: "t", cwd: repoRoot }, { sessionId: "s-2" }).handle.runId;
  abortedRuntime.act({ action: "cancel", runId: abortedId });
  const rejectedAborted = abortedRuntime.act({ action: "steer", runId: abortedId, message: "补一句" });
  assert.equal(rejectedAborted.steered, false);
  assert.equal(rejectedAborted.reason, "settled");
});

test("查不到的 runId 仍然是 unknown-run（steer 不新造一套「找不到」形状）", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const runtime = createAsyncRuntime({ home, registry: createAsyncJobRegistry(), runJob: async () => ({ ...P_OK }), notify: () => true });
  const out = runtime.act({ action: "steer", runId: "nope", message: "x" });
  assert.equal(out.kind, "unknown-run");
});

// ---------------------------------------------------------------------------
// 4. bad_params：当场报，不落进后台载荷
// ---------------------------------------------------------------------------

test("坏参数当场 bad_params：缺 runId / 缺 message / 空串 / 只含空白 / 非字符串", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const sessionDir = await tempDir("erix-run-steer-sess-");
  const registry = createAsyncJobRegistry();
  const runtime = createAsyncRuntime({ home, registry, runJob: async () => ({ ...P_OK }), notify: () => true });

  const noRunId = runtime.act({ action: "steer", message: "正文" });
  assert.equal(noRunId.code, "bad_params");
  assert.match(noRunId.message, /runId/u);

  const noMessage = runtime.act({ action: "steer", runId: "r-x" });
  assert.equal(noMessage.code, "bad_params");
  assert.match(noMessage.message, /message/u);

  for (const message of ["", "   ", "\n\t", 42, true, {}, null, undefined]) {
    const bad = runtime.act({ action: "steer", runId: "r-x", message });
    assert.equal(bad.code, "bad_params", `message=${JSON.stringify(message)} 必须是 bad_params`);
    assert.equal(bad.kind, "error", "坏参数是当场错误，不是后台载荷");
  }

  // 坏参数不许把一个活着的 job 的队列改动，也不许派工出第二个 job
  const runId = runtime.start({ task: "t", cwd: repoRoot, sessionDir }, { sessionId: "s-1" }).handle.runId;
  const bad = runtime.act({ action: "steer", runId, message: "  " });
  assert.equal(bad.code, "bad_params");
  assert.equal(runtime.act({ action: "status", runId }).view.steerPending, 0);
  assert.equal(registry.list().length, 1, "坏参数不许派工");
});

// ---------------------------------------------------------------------------
// 5. 真 runToolLoop：钩子真的被问、正文真的进 messages、账目真的透传
// ---------------------------------------------------------------------------

/** `runErixRun` 的离线装配（照 erix-run-async.test.js 的 offlineFakeLib 口径）。 */
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

const SCRIPT = () => [
  { content: [{ type: "tool_use", id: "t1", name: "work", input: { step: "t1" } }], stopReason: "tool_use", usage: { input_tokens: 5, output_tokens: 2 } },
  { content: [{ type: "tool_use", id: "t2", name: "work", input: { step: "t2" } }], stopReason: "tool_use", usage: { input_tokens: 6, output_tokens: 3 } },
  { content: [{ type: "text", text: "任务已完成" }], stopReason: "end_turn", usage: { input_tokens: 7, output_tokens: 4 } },
];

/**
 * 离线跑一次真 `runToolLoop`：`runLoop` 包装里抓 options（钩子装配事实 + 事件序列），
 * provider 的 requests 给出「模型实际看到的消息」，`store.load(runId)` 给出账本行。
 */
async function offlineRun({ nextUserTurn, sessionDir, runId = `steer-753-c2-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const provider = createFakeProvider(SCRIPT());
  const events = [];
  let options = null;
  let store = null;
  const deps = {
    env: {},
    home: await tempDir("erix-run-steer-home-"),
    now: () => 1_700_000_000_000,
    runId,
    loadLib: async () => offlineFakeLib(),
    loadSlot: async () => ({
      slot: { endpoint: "https://relay.example/v1", model: "slot-model", apiKey: "k", contextWindowTokens: 200_000, maxOutputTokens: 4_096 },
      configPath: "/tmp/fake-erix-config.json",
    }),
    createProvider: () => provider,
    createAssembly: () => ({
      tools: [{ name: "work", replay: "unsafe", inputSchema: { type: "object" } }],
      executeTool: async () => "ok",
    }),
    createStore: () => {
      store = createMemoryTranscriptStore();
      return store;
    },
    runLoop: (input) => {
      options = input;
      // 事件要从能力面抓（#498 S6 之后 `onEvent` 在 `capabilities.hooks.onEvent`，不是顶层），
      // 所以这里包的是那一个，不是顶层的 `onEvent`。
      const hooks = input.capabilities?.hooks ?? {};
      return runToolLoop({
        ...input,
        capabilities: {
          ...(input.capabilities ?? {}),
          hooks: {
            ...hooks,
            onEvent: (event) => {
              events.push(event);
              hooks.onEvent?.(event);
            },
          },
        },
      });
    },
  };
  const payload = await core.runErixRun(
    { task: "修 bug", cwd: repoRoot, maxRounds: 4, strategy: "sliding-window", ...(sessionDir === undefined ? {} : { sessionDir }) },
    nextUserTurn === undefined ? deps : { ...deps, nextUserTurn },
  );
  const rows = store === null ? [] : await store.load(runId);
  return { payload, options, events, provider, store, rows };
}

/** 去掉时钟/随机量之后的账本行（C1 契约里「逐字一致」的同一条豁免口径）。 */
function normalizeRows(rows) {
  const VOLATILE = new Set(["ts", "durationMs", "elapsedMs", "startedAt", "finishedAt", "toolCallKey", "at"]);
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, child]) => [key, walk(child)]));
  };
  return JSON.parse(JSON.stringify(walk(rows ?? [])));
}

test("真 runToolLoop：steer 在轮边界被问，队首那条真的进内层 run 的 messages，diagnostics.steer 进终局", async () => {
  const job = { steerInbox: ["注意：只改 a.js", "补一条测试"], progress: [] };
  const { payload, options, events, provider, rows: rawRows } = await offlineRun({ nextUserTurn: createSteerHook(job) });

  assert.equal(typeof options.capabilities?.hooks?.nextUserTurn, "function", "钩子装配进了 capabilities.hooks");
  // 账本侧的证据：注入的那条以**普通用户消息**的身份落在轮记录里（引擎 C1 的行形状
  // （带 seq 的 `kind:"message"` 行 vs `:control:` 行）已在 `test/loop-host-steer-turn-753.test.js` 钉过，
  // 本层只验「它真的进了内层 run 的历史」）。
  const rows = JSON.stringify(rawRows.map((record) => record?.messages ?? []));
  assert.ok(rows.includes("注意：只改 a.js"), `注入的那条要出现在内层 run 的 messages 里：${rows.slice(0, 400)}`);
  assert.ok(rows.includes('"role":"user"'), "它是一条 user 轮，不是引擎自己的输出");
  const userTexts = provider.requests.flatMap((request) => (request?.messages ?? [])
    .filter((message) => message?.role === "user")
    .map((message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((b) => b?.text ?? "").join(""))));
  assert.ok(userTexts.some((text) => text.includes("注意：只改 a.js")), `队首要成为一条用户轮：${JSON.stringify(userTexts)}`);

  const injected = events.filter((event) => event?.type === "host_steer_injected");
  assert.ok(injected.length >= 1, "注入成功要发 host_steer_injected");
  assert.equal(injected[0].chars, "注意：只改 a.js".length);

  assert.deepEqual(Object.keys(payload.diagnostics.steer).sort(), ["injected", "lastRound", "offered", "rejected"]);
  assert.ok(payload.diagnostics.steer.offered >= 1, "装了钩子就要有 offered 计数");
  assert.equal(payload.diagnostics.steer.injected, injected.length, "injected 与注入事件同数");
  assert.equal(payload.diagnostics.steer.rejected, 0);
  const shown = core.formatPayloadForModel(payload);
  assert.match(shown, new RegExp(`steer：offered=\\d+ injected=${payload.diagnostics.steer.injected} rejected=0`, "u"),
    `同步文本面也报转向账目：${shown}`);
});

test("多条 steer 按 FIFO 每轮一条：第二轮才消费第二条", async () => {
  const asked = [];
  const job = { steerInbox: ["第一条", "第二条"], progress: [] };
  const hook = createSteerHook(job);
  const wrapped = (ctx) => {
    asked.push(ctx?.round);
    return hook(ctx);
  };
  const { provider } = await offlineRun({ nextUserTurn: wrapped });
  const texts = provider.requests.flatMap((request) => (request?.messages ?? [])
    .filter((message) => message?.role === "user")
    .map((message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((b) => b?.text ?? "").join(""))));
  assert.ok(texts.some((t) => t.includes("第一条")), "第一条在更早的边界进来了");
  assert.ok(texts.some((t) => t.includes("第二条")), "第二条在下一个边界进来（FIFO，不合并成一条）");
  assert.ok(asked.length >= 2, "每个轮边界都问一次");
  assert.equal(job.steerInbox.length, 0, "队列被消费空");
});

test("没 steer ⇒ 不装钩子；装了但一直回 null 的 run 与不装的 run 账本/事件逐字一致", async () => {
  const bare = await offlineRun({ runId: "steer-753-c2-same-run" });
  assert.equal("nextUserTurn" in (bare.options?.capabilities?.hooks ?? {}), false,
    "没递钩子 ⇒ options.capabilities.hooks 里连这个键都没有");
  assert.equal("nextUserTurn" in (bare.options?.capabilities ?? {}), false);
  assert.equal("steer" in (bare.payload?.diagnostics ?? {}), false, "没装钩子的 run 不许多出 diagnostics.steer");

  const quiet = await offlineRun({ runId: "steer-753-c2-same-run", nextUserTurn: createSteerHook({ steerInbox: [], progress: [] }) });
  assert.equal(typeof quiet.options.capabilities.hooks.nextUserTurn, "function");
  assert.equal(quiet.payload.diagnostics.steer.injected, 0, "钩子回了 null ⇒ 一条也没注入");
  assert.equal(quiet.events.some((event) => event?.type === "host_steer_injected"), false, "null 是设计上静默的");

  assert.deepEqual(normalizeRows(quiet.rows), normalizeRows(bare.rows), "队列空的钩子不许改变账本");
  assert.deepEqual(quiet.events.map((event) => event?.type), bare.events.map((event) => event?.type),
    "队列空的钩子不许改变事件序列");
  assert.deepEqual(normalizeRows(quiet.provider.requests), normalizeRows(bare.provider.requests),
    "发给模型的消息序列逐字一致");
});

test("非函数的 deps.nextUserTurn 被忽略（不把「配错型」变成半个钩子）", async () => {
  const { options } = await offlineRun({ nextUserTurn: "把这句话注入进去" });
  assert.equal("nextUserTurn" in (options?.capabilities?.hooks ?? {}), false, "只认函数，其他一律当没递");
});

// ---------------------------------------------------------------------------
// 6. diagnostics.steer 的四面同形（同步 / status / result / status.json）
// ---------------------------------------------------------------------------

test("diagnostics.steer 与 steerPending 在 status / result / status.json 三面同形", async () => {
  const home = await tempDir("erix-run-steer-home-");
  const sessionDir = await tempDir("erix-run-steer-sess-");
  const steer = { offered: 3, injected: 2, rejected: 1, lastRound: 2 };
  const payload = { ...P_OK, diagnostics: { model: "slot-model", steer } };
  const registry = createAsyncJobRegistry();
  const runtime = createAsyncRuntime({
    home,
    registry,
    notify: () => true,
    runJob: async (params, deps) => {
      // 等两条都进了队列再装模作样地跑：只取走**第一条**，第二条留在队列里跨终局。
      await waitUntil(() => (registry.get(deps.runId)?.steerInbox?.length ?? 0) >= 2, { label: "two steers queued" });
      deps.nextUserTurn?.();
      return payload;
    },
  });
  const runId = runtime.start({ task: "t", cwd: repoRoot, sessionDir }, { sessionId: "s-1" }).handle.runId;
  runtime.act({ action: "steer", runId, message: "第一条会被取走" });
  runtime.act({ action: "steer", runId, message: "第二条没被消费" });
  await waitUntil(() => registry.get(runId)?.status === "completed", { label: "settled" });

  const status = runtime.act({ action: "status", runId });
  assert.deepEqual(status.view.diagnostics.steer, steer, "status 视图整块透传");
  assert.equal(status.view.steerPending, 1, "run 结束还剩 1 条没被消费（诚实：没注入就是没注入）");

  const result = formatAsyncResult(runtime.act({ action: "result", runId }));
  assert.deepEqual(result.details.view.diagnostics.steer, steer);
  const resultText = textOf(result);
  assert.match(resultText, /steer=offered:3\/injected:2\/rejected:1\/lastRound:2/u, `文本面要报账目：${resultText}`);
  assert.match(resultText, /steerPending=1/u);

  const disk = JSON.parse(readFileSync(statusFilePath({ sessionDir, runId }), "utf8"));
  assert.deepEqual(disk.diagnostics.steer, steer, "status.json 带账目（/reload 后唯一残留）");
  assert.equal(disk.steerPending, 1);
  assert.equal(disk.steerInbox, undefined, "收件箱本体不落盘（内存队列，不伪装成可跨重启的东西）");

  // 同步面：同一个载荷经 `formatSyncResult` 的文本面也报同一份账目
  const { formatSyncResult } = await import("../../examples/pi-extension/erix-run-format.js");
  assert.match(textOf(formatSyncResult(payload)), /steer：offered=3 injected=2 rejected=1/u);
});
