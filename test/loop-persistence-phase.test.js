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
// issue #230：上面这条「附带不变量」同时是**两个出口的字段面对称**守门——原先它钉的是「`checkpoint_failed`
// 缺 `cause`/`unpersisted`」这个已知不对称，现在改成可枚举对撞（两个错误的 `Object.keys` 与
// `Object.getOwnPropertyNames` 必须逐字相等），缺任一字段即红。
// 键名对称只是第一层：**取值类型**也必须对称（同名字段两种类型 = 宿主只能读源码才知道），故另钉
// 「两侧 `cause` 都是错误对象且 `cause.code` 可读」「两侧 `unpersisted` 都是数组」「两侧 `errorCode`
// 都是字符串且同输入同值（`ETIMEDOUT` / 无 code ⇒ `"unknown"`）」。把任一取值换回旧形状（字符串 /
// `{ count, items }`）即红。
//
// 卫生：store 全程注入内存实现，`toolContext.cwd` 注入临时目录（AGENTS.md 测试隔离规则），
// 用例另外断言真实 `~/.erix` 的存在性未被改动。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runDirect } from "./helpers/run-direct.js";
import { makeTmp } from "./helpers/tmp.js";

// 定时器周期：足够小让一次流式尝试内必然落一条 partial 快照，又足够大避免抖动。
const PARTIAL_INTERVAL_MS = 20;

// `#178` 的映射：工具前 pending / 工具后 executed。⚠ issue #770：这条映射的**输入**不再是快照载荷里
// 的 `status` 那一格（已停写），而是下面 `callSiteOf()` 从载荷里的执行事实反推出来的调用点名。
const EXPECTED_BY_CALL_SITE = Object.freeze({
  // 与 `src/loop/run-snapshot-executor.js` 调用点声明 + `persistClassified()` 的状态口径一致（实测值）。
  pending: Object.freeze({ phase: "checkpoint_before_tool", sideEffect: "not_started" }),
  executed: Object.freeze({ phase: "checkpoint_after_tool", sideEffect: "executed_uncommitted" }),
  intercepted: Object.freeze({ phase: "checkpoint_before_tool", sideEffect: "not_started" }),
});

// issue #770：分辨「哪条调用点写下这条快照」的**权威来源**（旧的那格 `snapshot.status` 已停写）。
// 引擎在每条调用点上都把当时的执行事实写进了 `tool_result` 的 `erix.executionStatus`
// （`src/tool-fact.js#buildToolResultFact`：`rejected` 见 `run-snapshot-executor.js:330`、
// `intercepted` 见 `:721`），并只在**工具真的执行过**之后才把 id 记进 `executedToolIds`。于是
// 四条调用点各自可分辨，用的全部是载荷自己携带的引擎事实（实测写序见 REPORT 步骤 2）：
//   · 最后一条 `tool_result` 带 `executionStatus: "rejected"` ⇒ 引数被拒那次写；
//   · 带 `"intercepted"` ⇒ 拦截结果那次写；
//   · **在飞的那条调用就是最后那条结果**（`pendingToolUse.id === 最后一条结果的 toolUseId`）且
//     那个 id 在 `executedToolIds` 里 ⇒ 工具后那次写。必须比「同一个 id」而不能只比「集合非空」：
//     `executedToolIds` 是跨调用点累积的，同一轮里**下一个工具的工具前写**带着上一个工具的结果
//     （实测写序：`pending(t1) → executed(t1) → pending(t2，带 t1 的结果) → intercepted(t2)`），
//     只看非空会把那个 pending 误标成 executed；
//   · 其余（含定时器写：它自己没新增结果，调用点交进来的就是 pending）⇒ pending。
// @param {Record<string, any>} snapshot
// @returns {"rejected" | "intercepted" | "executed" | "pending"}
function callSiteOf(snapshot) {
  const last = (snapshot.toolResults ?? []).at(-1);
  const executionStatus = last?.toolResult?.erix?.executionStatus;
  if (executionStatus === "rejected") return "rejected";
  if (executionStatus === "intercepted") return "intercepted";
  const lastToolUseId = last?.toolUseId;
  if (lastToolUseId !== undefined
    && snapshot.pendingToolUse?.id === lastToolUseId
    && (snapshot.executedToolIds ?? []).includes(lastToolUseId)) {
    return "executed";
  }
  return "pending";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 探针 store：记录每一次 run snapshot 写的**分类输入**（status / 是否 partial / pending 工具 /
// 已执行工具 id / 已带工具结果），并只在 `failWriteAt` 命中的那一次抛错——于是一次写同时被
// 两条通道分类（事件 = 通道 A，抛出的 `checkpoint_failed` = 通道 B）。
// `storeErrorCode`（issue #230）：给注入的底层故障挂一个分类码，用来验证两个出口的根因口径
// 是**透传**而不是硬编码 `unknown`。
function createProbeStore({ failWriteAt = -1, storeErrorCode } = {}) {
  const writes = [];
  const events = [];
  const transcripts = [];
  const storeError = new Error(`injected snapshot store failure (write #${String(failWriteAt)})`);
  storeError.name = "InjectedStoreFailure";
  if (storeErrorCode !== undefined) storeError.code = storeErrorCode;
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
        status: callSiteOf(snapshot),
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
async function runScenario({ failWriteAt = -1, cwd, toolContextSeen, storeErrorCode } = {}) {
  const store = createProbeStore({ failWriteAt, storeErrorCode });
  let result;
  let thrown;
  try {
    result = await runDirect({
      provider: createInterleavedStreamingProvider(),
      store,
      runId: `phase-channels-write-${String(failWriteAt)}`,
      initialUserMessage: "work",
      tools: [{ name: "work", description: "probe tool", inputSchema: { type: "object", properties: {} } }],
      executeTool: async ({ context }) => {
        toolContextSeen?.push(context?.cwd);
        return "ok";
      },
      // #498 S3（`metadata` A8）：扁平 `toolContext` 已退役，写点搬进 `config.metadata.toolContext`
      // （展开相写回 `effectiveOptions.toolContext`，`toolContextFor` 读侧一字未动）。并进**同一个**
      // `config` 容器——第二个 `config` 键会静默盖掉下面的 `timing.retry`。
      config: {
        metadata: { toolContext: { cwd } },
        timing: { retry: { attempts: 0, backoffBaseMs: 0 } },
      },
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
      // （重试旋钮已并进上面唯一的 `config` 容器，见 `timing` 那一段。）
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

test("#178 判定 1/5：工具前（调用点 pending）同一次失败写，猜测通道与显式声明通道给出同一组分类", async () => {
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
    ...EXPECTED_BY_CALL_SITE.pending,
  }, `pre-tool pending write must classify as ${describeChannel(EXPECTED_BY_CALL_SITE.pending)}`);
});

test("#178 判定 2/5：工具后（调用点 executed）同一次失败写，两通道同为 checkpoint_after_tool/executed_uncommitted", async () => {
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
    ...EXPECTED_BY_CALL_SITE.executed,
  }, `post-tool executed write must classify as ${describeChannel(EXPECTED_BY_CALL_SITE.executed)}`);
});

test("#178 判定 4/5：守门 sweep——每条可达的快照写强制失败，两通道值相等且与 status 的既有映射一致", async () => {
  const cwd = await makeTmp("erix-178-d-");
  const writes = await enumerateWrites(cwd);
  // #827 第 5 刀：partialPersistence 定时器不再写快照 ⇒ 可达写点少一条（原来 ≥5，现在 ≥4）。
  assert.ok(writes.length >= 4, `scenario must reach every snapshot write site, got ${writes.length}`);
  // 覆盖面自证：定时器 / 工具前 / 工具后 / 拦截结果 四类写都必须出现，否则守门线形同虚设。
  assert.ok(!writes.some((entry) => entry.isPartialTimer),
    "partialPersistence 定时器不许再写快照（#827 第 5 刀：半截正文只落账本恢复行）");
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
    const expected = EXPECTED_BY_CALL_SITE[write.status];
    assert.ok(expected, `write #${String(write.index)} carries unmapped call site ${String(write.status)}: ${describeChannel(context)}`);
    assert.deepEqual(
      { phase: event.phase, sideEffect: event.sideEffect },
      expected,
      `call site ${String(write.status)} must classify as ${describeChannel(expected)}: ${describeChannel(context)}`,
    );
    observed.push({ index: write.index, status: write.status, ...guessedChannel(event) });
  }

  // 取证留档：全量 sweep 的实测分类表（红测报告里直接引用这一行）。
  console.log("#178 sweep classification:", JSON.stringify(observed));
});

// #827 第 5 刀：partialPersistence 定时器不再写快照 ⇒ 本片里**没有**「靠 `persist()` 猜分类」的
// 快照写点了（剩下的三类写全部有显式声明）。这条判据原本拿「定时器（猜）」与「工具后（显式）」
// 对撞，检查 `persistence_failed` 与 `checkpoint_failed` 两种出口的字段面必须对称（#230）。
// 停写之后另一侧不存在 ⇒ **不在本片里改薄它**（把两侧都换成显式通道会静默改掉判据语义），
// 改成显式 skip 并在 #767 上记一条：退役整个快照写侧时，把「猜测通道」的取样换到一个非快照
// 写点（例如 `saveRunState` 失败），或者连同 `persistence_failed` 这一档一起裁掉。
// 原判据全文在 `git show 0cf7f978:test/loop-persistence-phase.test.js` 里（同一段 `#178 附带不变量`）。
test("#178 附带不变量：persistence_error 事件与抛出错误的字段形状一致（正文 A7）", {
  skip: "随快照通道退役重判（#767 / #827 第 5 刀）：定时器不再写快照 ⇒ 猜测通道已无取样面",
}, () => {
  // 有意留空：判据本体在快照写侧删净时一并重写，见上面那段注释。
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

// ── issue #769 R5（M2）：phase 面缺的那一格 —— fresh start 的**清盘**写 ─────────────────
// 上面四格走的都是快照写点（`checkpoint_before_tool` / `checkpoint_after_tool`）。清盘写
// （`clearRecoveryRows`）既不是快照写也不是轮记录写：它分类到 `recovery_rows_clear`
// （`src/loop/orchestrator.js#persistClassified`），而它坏掉的后果不是「少写一行」而是**上一代恢复行
// 还在场上** ⇒ 必须硬终止（R5 M2 的裁决：方法**缺席** = 宿主从未承诺这项能力，方法**在而失败** =
// 承诺了、而这一次「已清理」是假话）。本格把这条 phase 值同时钉在三个面上：`persistence_error` 事件、
// 抛出的错误、`termination` 载荷。store 用最小面（快照写 + 轮记录 + 清盘），不借 `createProbeStore`
// 的写序探针：那一格的判据是「哪条调用点写的」，本格只判定分类与终局。

test("#769 R5（M2）phase 面补格：清盘写失败 ⇒ 事件 / 抛出 / termination 三处同为 clearRecoveryRows + recovery_rows_clear + not_started", async () => {
  const cwd = await makeTmp("erix-769r5-clear-");
  const injected = new Error("injected clearRecoveryRows failure");
  injected.name = "InjectedClearFailure";
  let clearCalls = 0;
  let modelCalls = 0;
  const store = {
    async appendRound() {},
    async load() { return []; },
    async saveRunSnapshot() {},
    async loadLatestRunSnapshot() { return undefined; },
    async clearRecoveryRows() {
      clearCalls += 1;
      throw injected;
    },
  };
  const provider = {
    async chat() {
      modelCalls += 1;
      return { content: [{ type: "text", text: "clear phase" }], stopReason: "end_turn" };
    },
  };
  /** @type {any[]} */
  const events = [];
  let thrown;
  try {
    await runDirect({
      provider,
      store,
      runId: "clear-phase",
      initialUserMessage: "work",
      executeTool: async () => "ok",
      config: {
        metadata: { toolContext: { cwd } },
        timing: { retry: { attempts: 0, backoffBaseMs: 0 } },
      },
      completion: false,
      wrapup: false,
      maxRounds: 3,
      diagnostics: { error: (/** @type {any} */ event) => events.push(event) },
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, "清盘写失败必须让 run 抛出（不是记一条诊断就继续跑）");
  assert.equal(clearCalls, 1, "retry.attempts=0 ⇒ 恰好一次尝试（不掺重试噪声）");
  assert.equal(modelCalls, 0, "终止在**第一次模型请求之前** ⇒ run 没有继续跑（旧行在场时继续跑就是脏读）");
  assert.equal(thrown.code, "persistence_failed", "清盘失败走 persistence_failed 出口");
  assert.equal(thrown.cause, injected, "cause 就是注入的那个 store 错对象");
  assert.equal(thrown.errorCode, "unknown", "根因无 code ⇒ errorCode=unknown（与上面各格同口径）");

  const event = events.find((/** @type {any} */ e) => e?.operation === "clearRecoveryRows");
  assert.ok(event !== undefined,
    `必须有一条点名 clearRecoveryRows 的 persistence_error 事件，实际 ${JSON.stringify(events.map((e) => e?.operation))}`);
  assert.equal(event.type, "persistence_error", "诊断事件类型不变（不为一格新造事件名）");
  assert.equal(event.phase, "recovery_rows_clear", "phase 必须是清盘那一格（不是 transcript，也不是 checkpoint_*）");
  assert.equal(event.sideEffect, "not_started", "失败在第一次模型请求之前 ⇒ 本 run 不欠外部副作用");
  assert.deepEqual(thrownChannel(thrown), guessedChannel(event),
    `通道 A/B 同值：A=${describeChannel(guessedChannel(event))} B=${describeChannel(thrownChannel(thrown))}`);
  assert.equal(thrown.termination?.reason, "persistence_failed",
    "R5 M2 的裁决点：**termination 必须在场**（修前清盘在造终局的路径之外，这一格是 undefined）");
  assert.deepEqual(
    {
      operation: thrown.termination?.operation,
      phase: thrown.termination?.phase,
      sideEffect: thrown.termination?.sideEffect,
    },
    { operation: event.operation, phase: event.phase, sideEffect: event.sideEffect },
    "termination 三值与事件三值同源（宿主在终局上看到的 == 诊断里看到的）",
  );
});
