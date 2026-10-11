import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 E 组 M4 的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：`currentTerminationReason` 迁入 `runLoopState` 后，M4 的 6 项反向证里有 5 项红了 0。
// 逐个判定（grep 实测的读写面）：
//   · 唯一的跨文件写者是 `src/loop/termination.js:285` 的 `ctx.currentTerminationReason = reason`
//     （terminationContext 的 `set`），紧接着 `:288 await refreshRunState()` ⇒ 收尾原因必须经状态
//     对象格子回灌进 `createDeterministicRunState({ terminationReason })`（引擎内唯一读点），
//     最终落到 `snapshot.deterministic.termination.reason`（`src/run-state.js:341`）与渲染文本
//     `termination=...`（`src/run-state.js:410`）——既有测试只在**失败**路径断言过该键，而失败路径的
//     值是 `fail()` 直接标注进 `currentRunState` 的（不经本格），所以这条链一次都没被钉过；
//   · 把 run-state 键值硬编码成 `"running"`、或让 `set` 不生效，都会在下面两条断言上露馅。
//   · getter（`src/loop/orchestrator.js:2124`）在 `src/` 与 `test/` 内都无读者 ⇒ 那一项红 0 属
//     「非等价但引擎内无读者」，与 D 组的 `roundCostUsd`/`lastApiEndedAt` 同类，不额外造场景。
//   · 失败路径 `fail()` 的两次写：第一处 `= initialReason` 在到第二处 `= reason` 之间没有任何读者
//     （中间只有 persist/markRunState），是死写；第二处写完本格也再无读者 ⇒ 红 0 是结构性等价。

const toolStep = (n) => ({
  content: [{ type: "tool_use", id: `call-${n}`, name: "noop", input: { n } }],
  stopReason: "tool_use",
});

test("收尾原因经 runLoopState 回灌进 run-state：end_turn 路径（#177 刀5-E）", async () => {
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "任务已完成" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 3,
    stallDetection: false,
    completion: false,
  });

  assert.equal(result.runState.deterministic.termination.reason, "end_turn");
  assert.match(result.runState.rendered, /termination=end_turn/u, "模型可见文本同口径");
});

test("收尾原因经 runLoopState 回灌进 run-state：轮数上限路径（换一个值，排除常量巧合）（#177 刀5-E）", async () => {
  const provider = createFakeProvider([
    toolStep(1),
    toolStep(2),
    { content: [{ type: "text", text: "轮数到了，收尾" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 2,
    stallDetection: false,
    completion: false,
  });

  assert.equal(result.runState.deterministic.termination.reason, "max_rounds_cap");
  assert.match(result.runState.rendered, /termination=max_rounds_cap/u);
});
