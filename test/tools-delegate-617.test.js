// issue #617（P1b）——派生工具本体（`src/tools/delegation/tool.js`）守门测试。
//
// 覆盖（工单清单）：
//   1. 真嵌套离线 e2e：父 `runToolLoop` 挂 `delegate` 工具，`runChild` 是**嵌套的真
//      `runToolLoop`**（脚本化假 provider）——子名册记录的 `parentRunId` 逐字等于父的 runId；
//   2. 后台完成唤醒恰好一次；父 `result` 自取后不再被唤醒；
//   3. 子中途取消 ⇒ 名册 `aborted`；换一个工具实例读同名册目录（模拟父进程重启）⇒
//      `reconcile` 判 `interrupted`；
//   4. 配额满 ⇒ `run` 返回 `ok:false` 并点名持有者，不排队；
//   5. `cancel` 对非本进程 runId ⇒ `not_owned`；
//   6. 工具 schema 里没有 `parentRunId` 键。
//
// 离线：脚本化假 provider，零网络、零 `~/.erix`、零真实子进程；临时目录一律走
// `test/helpers/tmp.js` 的 `makeTmp(...)`。
import assert from "node:assert/strict";
import test from "node:test";

import { readRecord } from "../src/tools/delegation/roster.js";
import { createDelegateTool } from "../src/tools/delegation/tool.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";

const DONE = [{ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }];

/** 轮询到谓词为真（后台收尾是异步的）；超时按失败处理。 */
async function waitFor(predicate, { timeoutMs = 2_000, stepMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时：条件一直不成立");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 永不应答的 runChild：占着租约 / 保持活态，用来测配额与陈旧重算。 */
const neverSettles = () => new Promise(() => {});

/**
 * 嵌套的真 runToolLoop 当 runChild（假 provider 一轮就 end_turn）。
 * 宿主侧的 abort 归一：引擎中止时抛带 `termination.reason` 的错误，这里收成
 * `{ text, termination }` 交给库的映射表（cancel 路径断言名册 `aborted` 的前提）。
 */
async function runChildNestedLoop({ task, parentRunId, runId, signal }) {
  try {
    const child = await runDirect({
      provider: createFakeProvider([
        { content: [{ type: "text", text: `child-text:${task}` }], stopReason: "end_turn" },
      ]),
      executeTool: async () => "ok",
      tools: [{ name: "noop", description: "probe", inputSchema: { type: "object", properties: {} } }],
      maxRounds: 2,
      completion: false,
      signal,
      config: { run: { runId, ...(parentRunId === undefined ? {} : { parentRunId }) } },
      seed: task,
    });
    return { text: child.finalText, termination: child.termination?.reason, verification: child.verification };
  } catch (error) {
    if (error?.termination?.reason !== undefined) {
      return { text: error.finalText ?? "", termination: error.termination.reason };
    }
    throw error;
  }
}

// ================================================================ 1. 真嵌套 e2e：parentRunId 逐字归属

test("delegate e2e: 父 runToolLoop 挂工具、runChild 是嵌套真 runToolLoop，子记录 parentRunId 逐字等于父 runId", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: runChildNestedLoop, rosterDir: dir });
  const parentRunId = "parent-run-617-e2e";
  const result = await runDirect({
    provider: createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "d1",
          name: "delegate",
          input: { action: "run", task: "summarize", background: false },
        }],
        stopReason: "tool_use",
      },
      ...DONE,
    ]),
    tools: [delegate.definition],
    executeTool: async ({ name, input, context }) => (
      name === "delegate" ? delegate.execute(input, context) : "ok"
    ),
    maxRounds: 4,
    completion: false,
    config: { run: { runId: parentRunId } },
    seed: "delegate one child",
  });
  assert.equal(result.termination?.reason, "end_turn", "父 run 正常收尾");
  const records = (await delegate.execute({ action: "list" })).records;
  assert.equal(records.length, 1, "名册恰好一条子记录");
  const child = records[0];
  assert.equal(child.parentRunId, parentRunId, "子记录 parentRunId 逐字等于父 runId（上下文自取）");
  assert.equal(child.state, "completed", "嵌套 loop end_turn ⇒ completed");
  assert.equal(child.termination, "end_turn", "termination 原样保留");
});

test("delegate: parentRunId 只能在执行上下文里来——给了 context.runId 才落盘，schema 无此键", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: runChildNestedLoop, rosterDir: dir });
  // 不给上下文 runId：库不编造父身份，记录里整键不存在。
  const noParent = await delegate.execute({ action: "run", task: "orphan", background: false });
  assert.equal(noParent.ok, true);
  assert.ok(!("parentRunId" in readRecord(dir, noParent.runId)), "没给就不写 parentRunId 键");
  // 给了：逐字落盘。
  const withParent = await delegate.execute(
    { action: "run", task: "child", background: false },
    { runId: "parent-ctx-9" },
  );
  assert.equal(readRecord(dir, withParent.runId).parentRunId, "parent-ctx-9");
});

// ================================================================ 2. 后台唤醒恰好一次 + 自取后不再唤醒

test("delegate: 后台完成唤醒恰好一次；父 result 自取后不再被唤醒", async () => {
  const dir = await makeTmp("delegate-617-");
  /** @type {string[]} */
  const notifications = [];
  let resolveChild;
  const delegate = createDelegateTool({
    runChild: () => new Promise((resolve) => { resolveChild = resolve; }),
    rosterDir: dir,
    notifyParent: (text) => notifications.push(text),
  });
  const started = await delegate.execute(
    { action: "run", task: "bg", background: true },
    { runId: "parent-wake-1" },
  );
  // issue #630 S2（D）：`runChild` 之前就写了 `running`，所以后台返回与盘上记录都是 `running`
  //（以前两个都是 `queued`，而 `running` 从未被写入过）。
  assert.deepEqual(started, { ok: true, runId: started.runId, state: "running", background: true });
  assert.equal(readRecord(dir, started.runId).state, "running");

  resolveChild({ text: "bg done", termination: "end_turn" });
  await waitFor(() => notifications.length === 1);
  assert.equal(notifications.length, 1, "完成恰好唤醒一次");
  assert.match(notifications[0], /^【子run完成】/u, "固定前缀在代码里（notify.js 常量）");
  assert.match(notifications[0], /runId=/u);
  assert.match(notifications[0], /state=completed/u);

  // 父自取终局：ok，且登记二元组——之后这次完成不再触发唤醒。
  const got = await delegate.execute({ action: "result", runId: started.runId });
  assert.equal(got.ok, true);
  assert.equal(got.state, "completed");
  assert.equal(got.termination, "end_turn");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(notifications.length, 1, "自取之后没有第二次唤醒");
});

test("delegate: result 对活态 run 报 still_running，不消费", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: neverSettles, rosterDir: dir });
  const started = await delegate.execute({ action: "run", task: "slow", background: true });
  const early = await delegate.execute({ action: "result", runId: started.runId });
  assert.deepEqual(early, { ok: false, reason: "still_running", runId: started.runId, state: "running" });
  const missing = await delegate.execute({ action: "result", runId: "sub-never-existed" });
  assert.deepEqual(missing, { ok: false, reason: "not_found", runId: "sub-never-existed" });
});

// ================================================================ 3. 中途取消 aborted / 跨实例 reconcile interrupted

test("delegate: 子中途取消 ⇒ 名册 aborted（termination 原样）；新实例 reconcile 判 interrupted", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({
    runChild: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ text: "", termination: "aborted" }));
    }),
    rosterDir: dir,
  });

  // 3a：cancel 本进程持有的后台 run ⇒ 名册终态 aborted。
  const started = await delegate.execute(
    { action: "run", task: "abortable", background: true },
    { runId: "parent-cancel-1" },
  );
  const cancelled = await delegate.execute({ action: "cancel", runId: started.runId });
  assert.deepEqual(cancelled, { ok: true, runId: started.runId, aborted: true });
  await waitFor(() => readRecord(dir, started.runId)?.state === "aborted");
  assert.equal(readRecord(dir, started.runId).termination, "aborted", "termination 原样保留");

  // 3b：另一条后台 run 永不收尾（模拟父进程重启前的活态遗留）——新实例读同名册目录，
  //     list 先 reconcile：无人认领 ⇒ interrupted，endedAt 取原 updatedAt。
  const lingering = await delegate.execute({ action: "run", task: "orphan", background: true });
  assert.equal(readRecord(dir, lingering.runId).state, "running");
  // issue #630 S2（D）：谓词必须给——模拟「旧父进程真的没了」。不给谓词时库拒绝判死（见
  // `tools-delegation-foreign-630.test.js` 的 D-3）。
  const revived = createDelegateTool({ runChild: neverSettles, rosterDir: dir, isProcessAlive: () => false });
  const listed = await revived.execute({ action: "list" });
  const orphan = listed.records.find((record) => record.runId === lingering.runId);
  assert.equal(orphan.state, "interrupted", "新实例 reconcile：活态且无人认领 ⇒ interrupted");
  assert.equal(typeof orphan.endedAt, "number");
  assert.equal(listed.interrupted.length, 1, "reconcile 点名了被重算的那条");
});

// ================================================================ 4. 配额满：结构化失败 + 点名持有者，不排队

test("delegate: 配额满 ⇒ ok:false capacity_full 点名持有者，不排队", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: neverSettles, rosterDir: dir, maxConcurrent: 1 });
  const first = await delegate.execute({ action: "run", task: "occupies the only slot", background: true });
  assert.equal(first.ok, true);
  const second = await delegate.execute({ action: "run", task: "must not queue", background: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "capacity_full");
  assert.equal(second.maxConcurrent, 1);
  assert.ok(
    second.holders.some((holder) => holder.runId === first.runId),
    "失败结果点名当前持有者",
  );
  // 租约还是一份：没排队、没自旋、没多抢。
  const stillOne = await delegate.execute({ action: "list" });
  assert.equal(stillOne.records.length, 1, "没有第二条名册记录");
});

// ================================================================ 5. cancel 对非本进程 runId ⇒ not_owned

test("delegate: cancel 非本进程持有的 runId ⇒ not_owned，不谎称成功", async () => {
  const dir = await makeTmp("delegate-617-");
  const otherDir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: neverSettles, rosterDir: dir });
  // 另一个实例（模拟另一进程）持有的 runId：
  const other = createDelegateTool({ runChild: neverSettles, rosterDir: otherDir });
  const foreign = await other.execute({ action: "run", task: "foreign", background: true });
  const res = await delegate.execute({ action: "cancel", runId: foreign.runId });
  assert.deepEqual(res, { ok: false, reason: "not_owned", runId: foreign.runId });
  // 纯属捏造的 runId 同样 not_owned：
  assert.deepEqual(
    await delegate.execute({ action: "cancel", runId: "sub-made-up" }),
    { ok: false, reason: "not_owned", runId: "sub-made-up" },
  );
});

// ================================================================ 6. schema 无 parentRunId 键 + 杂项形状

test("delegate: schema 不存在 parentRunId 键；动作封闭六值（#626 C1 加 tail）", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: runChildNestedLoop, rosterDir: dir });
  const properties = delegate.definition.inputSchema.properties;
  assert.ok(!("parentRunId" in properties), "schema 里没有 parentRunId（父身份不可由模型填）");
  assert.ok(!JSON.stringify(delegate.definition).includes("parentRunId"), "description 里也不出现该键名");
  assert.deepEqual(delegate.definition.inputSchema.properties.action.enum,
    ["run", "status", "result", "list", "cancel", "tail"]);
  const unknown = await delegate.execute({ action: "pause" });
  assert.deepEqual(unknown, { ok: false, reason: "unknown_action", action: "pause" });
});

test("delegate: 前台 run 等完返回子 text；runChild 抛错 ⇒ 名册 failed 且如实报 error", async () => {
  const dir = await makeTmp("delegate-617-");
  const okTool = createDelegateTool({ runChild: runChildNestedLoop, rosterDir: dir });
  const ok = await okTool.execute({ action: "run", task: "sync-child", background: false });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "child-text:sync-child", "前台把子 run 的 text 作为工具结果返回");
  assert.equal(ok.state, "completed");
  assert.equal(readRecord(dir, ok.runId).state, "completed", "名册写终态");

  const failing = createDelegateTool({
    runChild: async () => { throw new Error("child exploded"); },
    rosterDir: dir,
  });
  const bad = await failing.execute({ action: "run", task: "boom", background: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.state, "failed");
  assert.match(bad.error, /child exploded/u);
  assert.equal(readRecord(dir, bad.runId).state, "failed", "失败也写名册终态");
  assert.ok(!("termination" in readRecord(dir, bad.runId)), "没给的 termination 不落盘");
});

test("delegate: 工厂参数校验（runChild 必注入、maxConcurrent ≥1）", () => {
  assert.throws(() => createDelegateTool({ rosterDir: "x" }), /runChild/u);
  assert.throws(() => createDelegateTool({ runChild: async () => ({ text: "" }), rosterDir: "x", maxConcurrent: 0 }), /maxConcurrent/u);
});

test("delegate: 经 runToolLoop 的结构化 executeTool 桥接（context.runId 自取父身份）", async () => {
  const dir = await makeTmp("delegate-617-");
  const delegate = createDelegateTool({ runChild: runChildNestedLoop, rosterDir: dir });
  const engineResult = await runDirect({
    provider: createFakeProvider([
      {
        content: [{
          type: "tool_use",
          id: "d9",
          name: "delegate",
          input: { action: "run", task: "via-engine" },
        }],
        stopReason: "tool_use",
      },
      ...DONE,
    ]),
    tools: [delegate.definition],
    executeTool: async ({ id, name, input, context, signal }) => {
      assert.equal(id, "d9");
      assert.ok(signal instanceof AbortSignal, "引擎把 toolSignal 递进来");
      return name === "delegate" ? delegate.execute(input, context) : "ok";
    },
    maxRounds: 4,
    completion: false,
    config: { run: { runId: "parent-engine-bridge" } },
    seed: "go",
  });
  assert.equal(engineResult.termination?.reason, "end_turn");
  const records = (await delegate.execute({ action: "list" })).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].parentRunId, "parent-engine-bridge");
});
