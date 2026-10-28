import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createDeterministicRunState } from "../src/run-state.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 D 组的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：D 组把 `runStateVersion` / `runStateAvailability` / `todoState` / `semanticState`
// / `currentRunState` 五个闭包 `let` 迁进 `runLoopState` 后，反向证里有四条变异**红了 0 条**，
// 逐个判定下来不是「等价变异」就是「非等价但现有用例一条都没锚定」：
//   · `set runStateVersion`——restore 回来的 `stateVersion` 会经 `refreshRunState` 的
//     `stateVersion:` 流入下一次落盘与终局 run-state（实测：改成写死值后 `result.runState.stateVersion`
//     从 4 变成写死值），但既有 resume 用例只断言恢复出来的 toolStats，没人看版本号；
//   · `set todoState` / `set semanticState`——唯一写入者是 `resume-manager.js` 的
//     `ctx.todoState = deterministic.todo` / `ctx.semanticState = restored.semantic`，而既有
//     resume fixture 两者恒为 `undefined`（写 undefined 覆盖 undefined ⇒ 变异等价）；
//   · `set currentRunState` + `fail()` 里的恢复态终局注解——需要「restore 已经吃到 run-state、
//     但首轮还没跑就失败」这个形状，既有用例没有这个形状。
// 下面两条用例把这些值真正钉住：迁移前的代码必须过，任何一格被搬坏（写错格子 / set 不生效 /
// 分支被掏空）都必须变红。

const RUN_ID = "run-state-cells";

// `createDeterministicRunState` 不收 `semantic`（它只产确定性那半），故 semantic 槽位按
// 真实落盘形状手工挂上（`restored.semantic` 就是 `resume-manager.js:49` 读的那个字段）。
const restoredRunState = (runId) => ({
  ...createDeterministicRunState({
    runId,
    stateVersion: 4,
    rounds: 7,
    maxRounds: 1,
    toolStats: new Map([["restored-tool", { calls: 7, failures: 2 }]]),
    todo: { status: "active", items: [{ id: "task-1", status: "done" }] },
  }),
  semantic: { text: "restored semantic directory line", semanticStateVersion: 4 },
});

const textMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
});

test("resume restores run-state cells (stateVersion / todo / semantic) into the next run state", async () => {
  const store = createMemoryTranscriptStore();
  const restored = restoredRunState(RUN_ID);
  await store.appendRound(RUN_ID, {
    round: 0,
    messages: [textMessage("seed")],
    runState: createDeterministicRunState({ runId: RUN_ID, stateVersion: 1, maxRounds: 1 }),
  });
  store.loadRunState = async () => restored;

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    config: { run: { resume: true } },
    completion: false,
    store,
    runId: RUN_ID,
    executeTool: async () => "unused",
  });

  // `set runStateVersion`：恢复出来的版本号必须活着进入下一次 run-state（写错格子/丢值都会红）
  assert.equal(result.runState.stateVersion, 4);
  // `set todoState`：恢复出来的 todo 要在没有 todoStateProvider 时原样带下去
  assert.deepEqual(result.runState.deterministic.todo.items, [{ id: "task-1", status: "done" }]);
  // `set semanticState`：恢复出来的 semantic 同样要活着（版本相同 ⇒ 不该被标 stale）
  assert.match(String(result.runState.semantic?.text ?? ""), /restored semantic directory/);
  assert.equal(result.runState.semantic?.semanticStateVersion, 4);
  assert.notEqual(result.runState.semantic?.status, "stale");
});

test("a resume that breaks after the run-state was restored still annotates that restored state", async () => {
  const store = createMemoryTranscriptStore();
  const restored = restoredRunState("run-state-cells-fail");
  // store.load 没有记录 ⇒ restore 在 applyRestoredRunState **之后**抛错，
  // 于是 fail() 读到的就是刚恢复进格子的 currentRunState（首轮还没开始、模型还没被调用）。
  store.loadRunState = async () => restored;

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const saves = [];
  const realSave = store.saveRunState.bind(store);
  store.saveRunState = async (runId, snapshot) => {
    saves.push({ modelCalls: provider.requests.length, snapshot: structuredClone(snapshot) });
    return realSave(runId, snapshot);
  };

  // restore 的失败由 fail() 收口后照旧抛出（#176 的终局语义），这里只关心它抛之前落了什么
  await assert.rejects(
    () => runToolLoop({
      provider,
      config: { run: { resume: true } },
      completion: false,
      store,
      runId: "run-state-cells-fail",
      executeTool: async () => "unused",
    }),
    /无可恢复记录/,
  );

  assert.ok(saves.length > 0, "失败路径也要落一次 run-state");
  // 这一次落盘发生在**任何模型调用之前**：它就是 fail() 里对恢复态的终局注解
  assert.equal(saves[0].modelCalls, 0);
  assert.equal(saves[0].snapshot.stateVersion, 4, "注解的是恢复出来的那份状态（版本号是它的身份）");
  assert.equal(saves[0].snapshot.deterministic.termination.reason, "failed");
});
