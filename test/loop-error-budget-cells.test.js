import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createDeterministicRunState } from "../src/run-state.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 E 组 M3 的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：`lowBudgetPrompted` / `toolErrorCount` / `runSnapshotFailureCount` 迁入 `runLoopState`
// 后，反向证里 8 项变异红了 0 条。逐个判定下来是「非等价但现有用例一条都没锚定」：
//   · `ctx.toolErrorCount += 1`（`run-snapshot-executor.js:340`）是**读-改-写**，而既有引擎用例里
//     从未出现过**两个**工具失败 ⇒ 把 ctx 的 `get` 掏成常量（计数被钉死在 1）也不红；
//   · run-state 的 `errors.tool` / `errors.checkpoint` 两个键的**值**没人看过（`errors.checkpoint`
//     是 issue #83 保留的旧键名，它的值来自 `runSnapshotFailureCount`，与符号名不同名）；
//   · `budget.lowBudgetPrompted` 的真值没人看过（只有初值扰动 `false → true` 红 5，那是「起点错」
//     的证据，不是「运行中会被写成 true」的证据）；
//   · `resume-manager.js:42-43` 把恢复出来的错误计数经 `set` 写回格子，既有 resume fixture 的
//     `deterministic.errors` 是 `{0,0}` ⇒ `set` 坏掉也只是写 0 覆盖 0。
// 下面四条把这几面钉住（工具失败两次 / 低预算真值 / resume 恢复非零计数 / 快照落盘失败的计数）。

const RUN_ID = "error-budget-cells";
const textMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });
const toolStep = (n) => ({
  content: [{ type: "tool_use", id: `call-${n}`, name: "boom", input: { n } }],
  stopReason: "tool_use",
});

test("两个工具失败累计成 errors.tool=2（ctx 读-改-写与 run-state 键值都活着）（#177 刀5-E）", async () => {
  const provider = createFakeProvider([
    toolStep(1),
    toolStep(2),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: "go",
    // 每次都抛 ⇒ `run-snapshot-executor.js` 里 `isError=true` ⇒ `ctx.toolErrorCount += 1` 走两次
    executeTool: async () => {
      throw new Error("tool exploded");
    },
    maxRounds: 5,
    stallDetection: false,
    completion: false,
  });

  assert.equal(provider.requests.length, 3, "两个工具轮 + 一次文本轮");
  // ctx#2 的 get 被掏成常量 ⇒ 计数钉死在 1；run-state 键值被硬编码 ⇒ 这里读到 0
  assert.equal(result.runState.deterministic.errors.tool, 2);
  assert.match(result.runState.rendered, /errors=2\/0/u, "模型可见文本同口径");
});

test("低预算把 budget.lowBudgetPrompted 写成真值（不是初值的假象）（#177 刀5-E）", async () => {
  const provider = createFakeProvider([
    toolStep(1),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 3,
    stallDetection: false,
    completion: false,
  });

  // 初值扰动（false → true）也会让这里为真，所以先证明它**不是**起点带来的：
  // maxRounds=3 的最后一轮才进入 remaining<=2 的窗口，写者是 `run-snapshot-executor.js:131`。
  assert.equal(result.runState.deterministic.budget.lowBudgetPrompted, true);
  // maxRounds=3 的两个工具/文本轮跑完后剩 1 轮——进入的正是 `remaining <= 2` 的窗口
  assert.equal(result.runState.deterministic.budget.remainingRounds, 1);
});

test("resume 把恢复出来的错误计数经 ctx set 带回下一次 run-state（#177 刀5-E）", async () => {
  const runId = `${RUN_ID}-resume`;
  const store = createMemoryTranscriptStore();
  const restored = createDeterministicRunState({
    runId,
    stateVersion: 4,
    rounds: 7,
    maxRounds: 5,
    toolErrorCount: 3,
    checkpointFailureCount: 2,
  });
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("seed")],
    runState: createDeterministicRunState({ runId, stateVersion: 1, maxRounds: 5 }),
  });
  store.loadRunState = async () => restored;
  // 前提：恢复值非零（否则 set 坏掉也是 0 覆盖 0，等于没钉）
  assert.equal(restored.deterministic.errors.tool, 3);
  assert.equal(restored.deterministic.errors.checkpoint, 2);

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    config: { run: { resume: true } },
    completion: false,
    store,
    runId,
    executeTool: async () => "unused",
  });

  // 逐字段断言（`errors` 里还有 `unpersisted` 子项，整体 deepEqual 会把无关形状钉死）
  assert.equal(result.runState.deterministic.errors.tool, 3);
  assert.equal(result.runState.deterministic.errors.checkpoint, 2);
});

test("run snapshot 落盘失败被计入 errors.checkpoint（旧键名 checkpointFailureCount 的值面）（#177 刀5-E）", async () => {
  const runId = `${RUN_ID}-snapshot`;
  const store = createMemoryTranscriptStore();
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("seed")],
    runState: createDeterministicRunState({ runId, stateVersion: 1, maxRounds: 5 }),
  });
  let snapshotCalls = 0;
  store.saveRunSnapshot = async () => {
    snapshotCalls += 1;
    throw new Error("snapshot store down");
  };
  const saves = [];
  const realSave = store.saveRunState.bind(store);
  store.saveRunState = async (id, snapshot) => {
    saves.push({ modelCalls: 0, snapshot: structuredClone(snapshot) });
    return realSave(id, snapshot);
  };

  const provider = createFakeProvider([
    toolStep(1),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  let thrown = null;
  try {
    await runDirect({
      provider,
      initialUserMessage: "go",
      executeTool: async () => "ok",
      maxRounds: 5,
      stallDetection: false,
      completion: false,
      store,
      runId,
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, "checkpoint_failed", "必须以 checkpoint_failed 抛出（#174 的 fail-closed 契约）");
  assert.ok(snapshotCalls > 0, "必须真的尝试过快照落盘");
  assert.ok(saves.length > 0, "失败路径也要落一次 run-state");
  // fail-closed 口径锂子（探针实测）：计数发生在 `assertSnapshotPersisted` 里，而它紧接着就抛，
  // `fail()` 注解的是**之前**那份 currentRunState ⇒ 本次落盘既没进计数也没改成终局 reason：
  //   `errors.checkpoint = 0`、`termination.reason = "running"`、`stateVersion = 0`。
  // 这三条锂的就是这个顺序：将来谁在失败路径上补一次 refreshRunState，这里会变红（而不是静默飘移）。
  assert.equal(saves.at(-1).snapshot.deterministic.errors.checkpoint, 0);
  assert.equal(saves.at(-1).snapshot.deterministic.termination.reason, "running");
  assert.equal(saves.at(-1).snapshot.stateVersion, 0);
});
