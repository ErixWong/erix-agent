// issue #178 ——「两通道 phase 不一致」的**裁决前置判定**（本文件只判定，不动 src/）。
//
// 被判决的两条分类通道
//   通道 A（猜测通道）：`src/loop/orchestrator.js` 的 `persist()` 按**方法名 + 末参 `status`**
//     推断 `phase`/`sideEffect`（`executed` → `checkpoint_after_tool`，否则 `checkpoint_before_tool`），
//     产出宿主可见的 `persistence_error` 事件（`diagnostics.error` / `onPersistenceError`）。
//   通道 B（显式声明通道）：`src/loop/run-snapshot-executor.js` 的工具前/后与 intercept 调用点，
//     在 `assertSnapshotPersisted` 里**自己声明** `phase`/`sideEffect`，写进抛出的 `checkpoint_failed`
//     错误（`error.phase` / `error.sideEffect`）。
//     定时器（`partialPersistence`）与 retrying 收尾这两处写快照**没有**显式声明，抛出的是
//     `persist()` 自己的 `persistence_failed`——那里的 `error.phase` 仍是通道 A 的猜测值。
//
// 结论（本文件的实测，2026-10-10，基点 836aaa2）：**复现失败**——同一次写经两条通道得到的
// `phase`/`sideEffect` 完全相同（定时器写 `status:"pending"` → `checkpoint_before_tool`/`not_started`，
// 与工具前显式调用点对同一 `status` 的声明逐字段一致）。因此 #178 正文 A7 说的「双通道不一致」
// **不成立**，本文件按**守门测试**写：钉住「两通道对同一状态给出相同分类」这条既有不变量，
// 未来 resolver 若把两条通道拆开、或新增调用点声明与 `status` 脱钩，这里会立刻红。
//
// 顺带钉住 #178 正文 A7 的另一半：`persistence_error` 事件的字段形状与抛出错误里的字段一致
// （同一事件对象、`operation`/`phase`/`sideEffect` 三值相同、`termination` 同源）。
//
// 卫生：store 全程注入内存实现，`toolContext.cwd` 注入临时目录（AGENTS.md 测试隔离规则），
// 用例另外断言真实 `~/.erix` 的存在性未被改动。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { makeTmp } from "./helpers/tmp.js";

// 定时器周期：足够小让一次流式尝试内必然落一条 partial 快照，又足够大避免抖动。
const PARTIAL_INTERVAL_MS = 20;

const EXPECTED_BY_STATUS = Object.freeze({
  // 与 `src/loop/run-snapshot-executor.js` 调用点声明 + `persist()` 的 status 映射一致（实测值）。
  pending: Object.freeze({ phase: "checkpoint_before_tool", sideEffect: "not_started" }),
  executed: Object.freeze({ phase: "checkpoint_after_tool", sideEffect: "executed_uncommitted" }),
  intercepted: Object.freeze({ phase: "checkpoint_before_tool", sideEffect: "not_started" }),
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 探针 store：记录每一次 run snapshot 写的**分类输入**（status / 是否 partial / pending 工具 /
// 已执行工具 id / 已带工具结果），并只在 `failWriteAt` 命中的那一次抛错——于是一次写同时被
// 两条通道分类（事件 = 通道 A，抛出的 `checkpoint_failed` = 通道 B）。
function createProbeStore({ failWriteAt = -1 } = {}) {
  const writes = [];
  const events = [];
  const transcripts = [];
  const storeError = new Error(`injected snapshot store failure (write #${String(failWriteAt)})`);
  storeError.name = "InjectedStoreFailure";
  let failedAt = -1;

  return {
    writes,
    events,
    transcripts,
    get storeError() {
      return failedAt === failWriteAt ? storeError : undefined;
    },
    async appendRound(_runId, record) {
      transcripts.push(record);
    },
    async load() {
      return transcripts.map((record) => ({ ...record }));
    },
    async saveRunSnapshot(_runId, snapshot) {
      const index = writes.length;
      writes.push({
        index,
        round: snapshot.round,
        status: snapshot.status,
        // 定时器（partialPersistence）通道的指纹：带 partialText、且没有任何 pending 工具块。
        isPartialTimer: snapshot.partialText !== undefined && snapshot.pendingToolUse == null,
        pendingToolUseId: snapshot.pendingToolUse?.id,
        pendingToolUseCount: Array.isArray(snapshot.pendingToolUses)
          ? snapshot.pendingToolUses.length
          : 0,
        executedToolIds: [...(snapshot.executedToolIds ?? [])],
        toolResultIds: (snapshot.toolResults ?? []).map((entry) => entry.toolUseId),
      });
      if (index === failWriteAt) {
        failedAt = index;
        throw storeError;
      }
    },
    async loadLatestRunSnapshot() {
      return undefined;
    },
  };
}

// 流式 provider：第 1 轮流式文本 + 两个工具块（覆盖一轮多工具块），第 2 轮流式文本后收尾。
// 每轮都留出 > interval 的时间窗，保证 partialPersistence 定时器至少落一次 partial 快照。
function createInterleavedStreamingProvider() {
  let calls = 0;
  return {
    async chatStream(request) {
      calls += 1;
      request.onDelta?.(`round ${String(calls)} streamed preamble`);
      await delay(PARTIAL_INTERVAL_MS * 3);
      return calls === 1
        ? {
          content: [
            { type: "tool_use", id: "t1", name: "work", input: {} },
            { type: "tool_use", id: "t2", name: "work", input: {} },
          ],
          stopReason: "tool_use",
        }
        : { content: [{ type: "text", text: "final answer" }], stopReason: "end_turn" };
    },
  };
}

// judge 一律 off_track + done:false → 第二个工具块被拦截，覆盖 `status:"intercepted"` 那条写。
function createBlockingJudgeProvider() {
  return {
    async chat() {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            done: false,
            confidence: 0.9,
            reason: "方向可能偏离",
            evidence: "探针注入的判定",
            direction: "off_track",
          }),
        }],
        stopReason: "end_turn",
      };
    },
  };
}

// 一次完整场景：成功跑（failWriteAt=-1）用来枚举可达的快照写；指定下标时那条写必然失败。
async function runScenario({ failWriteAt = -1, cwd, toolContextSeen }) {
  const store = createProbeStore({ failWriteAt });
  let result;
  let thrown;
  try {
    result = await runToolLoop({
      provider: createInterleavedStreamingProvider(),
      store,
      runId: `phase-channels-write-${String(failWriteAt)}`,
      initialUserMessage: "work",
      tools: [{ name: "work", description: "probe tool", inputSchema: { type: "object", properties: {} } }],
      executeTool: async ({ context }) => {
        toolContextSeen?.push(context?.cwd);
        return "ok";
      },
      toolContext: { cwd },
      stream: true,
      partialPersistence: { intervalMs: PARTIAL_INTERVAL_MS },
      reflection: {
        enabled: true,
        roundJudge: false,
        judgeIntervalRound: 1,
        judge: { provider: createBlockingJudgeProvider() },
      },
      completion: false,
      wrapup: false,
      maxRounds: 3,
      // 持久化重试关掉：一次写失败即定论，事件与抛出的都是同一次失败（不掺入重试噪声）。
      retry: { attempts: 0, backoffBaseMs: 0 },
      diagnostics: { error: (event) => store.events.push(event) },
    });
  } catch (error) {
    thrown = error;
  }
  return { store, thrown, result };
}

// 通道 A：persist() 猜测出来的分类，宿主在 `persistence_error` 事件里看到。
function guessedChannel(event) {
  if (event === undefined) return undefined;
  return { operation: event.operation, phase: event.phase, sideEffect: event.sideEffect };
}

// 通道 B：抛出错误携带的分类。工具前/后与 intercept 调用点上来自 `assertSnapshotPersisted`
// 的**显式声明**；定时器/retrying 通道的 `persistence_failed` 上退化为通道 A 的猜测值。
function thrownChannel(error) {
  if (error === undefined) return undefined;
  return { operation: error.operation, phase: error.phase, sideEffect: error.sideEffect };
}

function describeChannel(values) {
  return JSON.stringify(values);
}

// 场景枚举一次，供各用例复用（写序与下标只依赖脚本化的 provider/ judge，不依赖时序细节）。
async function enumerateWrites(cwd) {
  const { store, thrown, result } = await runScenario({ cwd });
  assert.equal(thrown, undefined, `baseline run must succeed, got ${String(thrown?.message ?? thrown)}`);
  assert.equal(result?.finalText, "final answer");
  return store.writes;
}

test("#178 判定 1/5：工具前（status:pending）同一次失败写，猜测通道与显式声明通道给出同一组分类", async () => {
  const cwd = await makeTmp("erix-178-a-");
  const writes = await enumerateWrites(cwd);
  const preToolIndex = writes.findIndex((entry) => !entry.isPartialTimer
    && entry.status === "pending"
    && entry.pendingToolUseId !== undefined);
  assert.ok(preToolIndex >= 0, `baseline must produce a pre-tool snapshot write, got ${describeChannel(writes)}`);

  const { store, thrown } = await runScenario({ failWriteAt: preToolIndex, cwd });
  const event = store.events.at(-1);
  assert.ok(event, "failed write must emit a persistence_error event (guessed channel)");
  assert.equal(thrown?.code, "checkpoint_failed", "executor call site must fail closed with checkpoint_failed");
  assert.equal(thrown?.termination?.reason, "persistence_failed");

  // 这就是 #178 声称的「同一次写、两通道不一致」：同一次写、两条通道。
  assert.deepEqual(
    guessedChannel(event),
    thrownChannel(thrown),
    `channel disagreement on one write: guessed=${describeChannel(guessedChannel(event))}`
      + ` vs explicit=${describeChannel(thrownChannel(thrown))}`,
  );
  assert.deepEqual(guessedChannel(event), {
    operation: "saveRunSnapshot",
    ...EXPECTED_BY_STATUS.pending,
  }, `pre-tool pending write must classify as ${describeChannel(EXPECTED_BY_STATUS.pending)}`);
});

test("#178 判定 2/5：工具后（status:executed）同一次失败写，两通道同为 checkpoint_after_tool/executed_uncommitted", async () => {
  const cwd = await makeTmp("erix-178-b-");
  const writes = await enumerateWrites(cwd);
  const postToolIndex = writes.findIndex((entry) => entry.status === "executed");
  assert.ok(postToolIndex >= 0, `baseline must produce a post-tool (status:executed) write, got ${describeChannel(writes)}`);
  assert.deepEqual(writes[postToolIndex].executedToolIds, ["t1"], "the executed write must carry the executed tool id");

  const { store, thrown } = await runScenario({ failWriteAt: postToolIndex, cwd });
  const event = store.events.at(-1);
  assert.ok(event, "failed write must emit a persistence_error event (guessed channel)");
  assert.equal(thrown?.code, "checkpoint_failed");

  assert.deepEqual(
    guessedChannel(event),
    thrownChannel(thrown),
    `channel disagreement on one write: guessed=${describeChannel(guessedChannel(event))}`
      + ` vs explicit=${describeChannel(thrownChannel(thrown))}`,
  );
  assert.deepEqual(guessedChannel(event), {
    operation: "saveRunSnapshot",
    ...EXPECTED_BY_STATUS.executed,
  }, `post-tool executed write must classify as ${describeChannel(EXPECTED_BY_STATUS.executed)}`);
});

test("#178 判定 3/5：partialPersistence 定时器写与工具前显式调用点对同一 status 分类一致——声称的不一致复现失败", async () => {
  const cwd = await makeTmp("erix-178-c-");
  const writes = await enumerateWrites(cwd);
  const timerIndex = writes.findIndex((entry) => entry.isPartialTimer);
  assert.ok(
    timerIndex >= 0,
    `partialPersistence timer must write a partial snapshot, got ${describeChannel(writes)}`,
  );
  const preToolIndex = writes.findIndex((entry) => !entry.isPartialTimer
    && entry.status === "pending"
    && entry.pendingToolUseId !== undefined);

  // 定时器通道：该写只被通道 A 分类（抛的是 persist() 自己的 persistence_failed）。
  const timerRun = await runScenario({ failWriteAt: timerIndex, cwd });
  const timerEvent = timerRun.store.events.at(-1);
  assert.ok(timerEvent, "timer write failure must emit a persistence_error event");
  assert.equal(timerRun.thrown?.code, "persistence_failed", "the timer channel has no explicit declaration site");
  const timerChannel = guessedChannel(timerEvent);

  // 显式声明通道：同一 status（pending）的快照写，由工具前调用点显式声明分类。
  const preToolRun = await runScenario({ failWriteAt: preToolIndex, cwd });
  const explicitChannel = thrownChannel(preToolRun.thrown);
  assert.equal(preToolRun.thrown?.code, "checkpoint_failed");

  // #178 正文 A7 的具体主张：定时器写被「猜成」checkpoint_before_tool，与显式通道不一致。
  // 实测两者逐字段相同 → 主张不成立，这条断言即守门线。
  assert.deepEqual(
    timerChannel,
    explicitChannel,
    `timer channel ${describeChannel(timerChannel)} vs explicit pre-tool channel `
      + `${describeChannel(explicitChannel)} — #178 claims these differ`,
  );
  assert.deepEqual(timerChannel, {
    operation: "saveRunSnapshot",
    ...EXPECTED_BY_STATUS.pending,
  }, `timer (status:pending) write must classify as ${describeChannel(EXPECTED_BY_STATUS.pending)}`);

  // 分类输入侧的取证：定时器写确实没有任何 pending 工具块（这才是 `not_started` 成立的前提）。
  const timerWrite = timerRun.store.writes[timerIndex];
  assert.equal(timerWrite.status, "pending", "the timer channel always writes status:\"pending\"");
  assert.equal(timerWrite.pendingToolUseId, undefined);
  assert.equal(timerWrite.pendingToolUseCount, 0);
  assert.deepEqual(timerWrite.executedToolIds, [], "round boundary clears executedToolIds before the next round streams");
});

test("#178 判定 4/5：守门 sweep——每条可达的快照写强制失败，两通道值相等且与 status 的既有映射一致", async () => {
  const cwd = await makeTmp("erix-178-d-");
  const writes = await enumerateWrites(cwd);
  assert.ok(writes.length >= 5, `scenario must reach every snapshot write site, got ${writes.length}`);
  // 覆盖面自证：定时器 / 工具前 / 工具后 / 拦截结果 四类写都必须出现，否则守门线形同虚设。
  assert.ok(writes.some((entry) => entry.isPartialTimer), "coverage: partialPersistence timer write");
  assert.ok(writes.some((entry) => entry.status === "executed"), "coverage: post-tool write");
  assert.ok(writes.some((entry) => entry.status === "intercepted"), "coverage: intercept result write");
  assert.ok(writes.some((entry) => !entry.isPartialTimer
    && entry.status === "pending"
    && entry.pendingToolUseId !== undefined), "coverage: pre-tool write");

  const observed = [];
  for (const write of writes) {
    const { store, thrown } = await runScenario({ failWriteAt: write.index, cwd });
    const event = store.events.at(-1);
    const context = {
      write: describeChannel(write),
      guessed: describeChannel(guessedChannel(event)),
      thrown: describeChannel({ ...thrownChannel(thrown), code: thrown?.code }),
    };
    assert.ok(event, `write #${String(write.index)} must emit a persistence_error event: ${describeChannel(context)}`);
    assert.ok(thrown, `write #${String(write.index)} must abort the run: ${describeChannel(context)}`);
    assert.ok(
      thrown.code === "checkpoint_failed" || thrown.code === "persistence_failed",
      `unexpected error code: ${describeChannel(context)}`,
    );
    assert.equal(thrown?.termination?.reason, "persistence_failed", describeChannel(context));
    // 守门线：两条通道（事件 = 猜测，抛出错误 = 调用点显式声明）对同一次写必须给同一组值。
    assert.deepEqual(
      guessedChannel(event),
      thrownChannel(thrown),
      `channel disagreement on write #${String(write.index)}: ${describeChannel(context)}`,
    );
    // 且必须与「status → 分类」的既有映射一致（新增 status 会在这里逼出显式期望值）。
    const expected = EXPECTED_BY_STATUS[write.status];
    assert.ok(expected, `write #${String(write.index)} carries unmapped status ${String(write.status)}: ${describeChannel(context)}`);
    assert.deepEqual(
      { phase: event.phase, sideEffect: event.sideEffect },
      expected,
      `status ${String(write.status)} must classify as ${describeChannel(expected)}: ${describeChannel(context)}`,
    );
    observed.push({ index: write.index, status: write.status, ...guessedChannel(event) });
  }

  // 取证留档：全量 sweep 的实测分类表（红测报告里直接引用这一行）。
  console.log("#178 sweep classification:", JSON.stringify(observed));
});

test("#178 附带不变量：persistence_error 事件与抛出错误的字段形状一致（正文 A7）", async () => {
  const cwd = await makeTmp("erix-178-e-");
  const writes = await enumerateWrites(cwd);
  const timerIndex = writes.findIndex((entry) => entry.isPartialTimer);
  const executorIndex = writes.findIndex((entry) => entry.status === "executed");
  const EVENT_KEYS = [
    "error", "fatal", "operation", "phase", "port", "runId", "sideEffect", "ts", "type",
  ];

  for (const [label, index] of [["timer", timerIndex], ["executor", executorIndex]]) {
    const { store, thrown } = await runScenario({ failWriteAt: index, cwd });
    const event = store.events.at(-1);
    assert.ok(event && thrown, `${label}: scenario must produce both an event and a thrown error`);
    const injected = store.storeError;
    assert.ok(injected, `${label}: store must expose the injected root cause`);

    // 事件形状（宿主可见契约）：键集合与取值口径。
    assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS, label);
    assert.equal(event.type, "persistence_error", label);
    assert.equal(event.port, "transcript", label);
    assert.equal(event.runId, `phase-channels-write-${String(index)}`, label);
    assert.equal(event.fatal, true, label);
    assert.equal(typeof event.ts, "string", label);
    assert.deepEqual(Object.keys(event.error).sort(), ["message", "name", "stack"], label);
    assert.equal(event.error.name, injected.name, label);
    assert.equal(event.error.message, injected.message, label);
    assert.equal(event.error.stack, String(injected.stack), label);

    // 抛出错误必须携带**同一个**事件对象与同一组诊断字段。
    assert.equal(thrown.persistenceError, event, `${label}: thrown error must carry the emitted event`);
    assert.equal(thrown.persistence.event, event, `${label}: persistence.event must be the same object`);
    assert.equal(thrown.operation, event.operation, label);
    assert.equal(thrown.phase, event.phase, label);
    assert.equal(thrown.sideEffect, event.sideEffect, label);
    assert.deepEqual(
      {
        operation: thrown.persistence.operation,
        phase: thrown.persistence.phase,
        sideEffect: thrown.persistence.sideEffect,
      },
      { operation: event.operation, phase: event.phase, sideEffect: event.sideEffect },
      `${label}: persistence payload must mirror the event`,
    );
    // 终局载荷同源（宿主在 termination 上看到的三值 == 事件三值）。
    assert.equal(thrown.termination.reason, "persistence_failed", label);
    assert.equal(thrown.termination.operation, event.operation, label);
    assert.equal(thrown.termination.phase, event.phase, label);
    assert.equal(thrown.termination.sideEffect, event.sideEffect, label);
  }

  // 已知不对称（**不在本单修**，只记录以免被误当作已修）：定时器通道的 `persistence_failed`
  // 带 `cause`/`unpersisted`，工具调用点的 `checkpoint_failed` 两者皆无（根因只经事件对象可达）。
  const timerRun = await runScenario({ failWriteAt: timerIndex, cwd });
  const executorRun = await runScenario({ failWriteAt: executorIndex, cwd });
  assert.equal(timerRun.thrown.cause, timerRun.store.storeError, "persistence_failed keeps the cause");
  assert.ok(Array.isArray(timerRun.thrown.unpersisted), "persistence_failed rides the ledger (#109)");
  assert.equal(executorRun.thrown.code, "checkpoint_failed");
  assert.equal(executorRun.thrown.cause, undefined, "checkpoint_failed currently drops the cause");
  assert.equal(executorRun.thrown.unpersisted, undefined, "checkpoint_failed currently drops the ledger");
});

test("用例卫生：run 使用注入的临时 cwd 与内存 store，未改动真实 ~/.erix", async () => {
  const cwd = await makeTmp("erix-178-h-");
  const home = homedir();
  const erixHome = home === undefined ? undefined : join(home, ".erix");
  const existedBefore = erixHome === undefined ? undefined : existsSync(erixHome);
  const seen = [];

  const { store, result } = await runScenario({ cwd, toolContextSeen: seen });
  assert.equal(result?.finalText, "final answer");
  assert.ok(seen.length > 0, "executeTool must observe the injected cwd via tool context");
  assert.deepEqual([...new Set(seen)], [cwd], "every tool call sees the injected tmp cwd, not the process cwd");
  assert.ok(store.writes.length > 0, "the injected in-memory store is the only persistence target");
  if (erixHome !== undefined) {
    assert.equal(existsSync(erixHome), existedBefore, `real ~/.erix existence changed (${String(erixHome)})`);
  }
});
