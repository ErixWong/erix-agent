import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 E 组 M1 的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：`ttlInjectArmed` / `ttlInjectConsumed` / `lowBudgetInjectFired` 三个旗标迁入
// `runLoopState` 后，反向证里有三项变异**红了 0 条**（armed 赋值掏空、consumed 赋值掏空、
// armed 门常关）。逐个判定下来是「非等价但既有断言没锚定」，不是等价变异：既有 TTL 用例
// （`test/loop.test.js` 的 issue #35 那条）跑的是 `maxRounds: 6`，注入那一轮**同时**满足
// `ttlInjectArmed` 与低预算门（`remainingRounds <= 2`），两条通道开着一条还剩一条，所以怎么
// 掏都不红。下面把预算放大（`maxRounds: 8`）让注入那一轮只剩 armed 一条通道，并把
// 「注入恰有一次」钉死：armed 的写侧/读侧被搬坏 → 一次都不注入；consumed 被搬坏 → 注入两次。
//
// 形状事实（探针实测，非推测）：通道 B 只把 run-state 文本追加到**当轮请求视图的最后一条消息**，
// 后续请求里没有它（通道 A 才会落到持久消息里）；`ttl.triggered` 在本场景是 `[1, 1, 2]`，
// 即确实发生了三次 TTL 折叠，「恰有一次注入」不是因为没有后续折叠才成立。

const MARK = "[run state deterministic";
const big = `line: ${"x".repeat(20_000)}`;

// `shape` 里 `B` = 该轮产出 20k 大结果（会被 TTL 折叠），`s` = 小结果（不折叠）。
const runFolded = async ({ shape, maxRounds }) => {
  const steps = shape.split("").map((kind, index) => ({
    content: [{
      type: "tool_use",
      id: `call-${index + 1}`,
      name: "scan",
      input: { path: `src/f${index + 1}.js`, big: kind === "B" },
    }],
    stopReason: "tool_use",
  }));
  const provider = createFakeProvider([
    ...steps,
    { content: [{ type: "text", text: "最终结论：完成" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "scan it",
    executeTool: async ({ input }) => (input.big ? big : "small result"),
    maxRounds,
    stallDetection: false,
    completion: false,
    config: { folding: { toolResultTtl: 2 } },
    semanticStateProvider: ({ state }) => ({
      text: "notes: use note_list before note_read",
      version: state.stateVersion,
    }),
  });
  const textBlocksOf = (request) => request.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "text")
    .map((block) => block.text);
  return {
    provider,
    result,
    // 每轮请求视图里「尾部注入的 run-state 块」计数与「最后一条消息就是该块」的标记
    injectedRequests: provider.requests
      .map((request, index) => ({ index, blocks: textBlocksOf(request).filter((text) => text.includes(MARK)).length }))
      .filter((entry) => entry.blocks > 0)
      .map((entry) => entry.index),
    lastMessageIsRunState: provider.requests.map((request) => {
      const texts = textBlocksOf(request);
      return (texts.at(-1) ?? "").includes(MARK);
    }),
    ttlTriggered: result.compactionStats.map((stat) => stat.layers?.ttl?.triggered ?? 0),
  };
};

test("TTL 折叠把 run-state 注入请求视图恰一次：armed 写侧与 consumed 门都活着（#177 刀5-E）", async () => {
  const run = await runFolded({ shape: "BsBs", maxRounds: 8 });

  // 前提：本场景确实发生了多次 TTL 折叠（否则「恰一次注入」是空断言）
  assert.deepEqual(run.ttlTriggered.filter((count) => count > 0).length >= 2, true, "需要 >=2 次 TTL 折叠");

  // armed 写侧（`runLoopState.ttlInjectArmed = true`）被掏空 / armed 读侧被焊死 ⇒ 一个都不注入
  assert.deepEqual(run.injectedRequests, [3], "首折后的那一轮注入一次，且只此一次");
  // 通道 B 的形状：块追加在当轮请求视图末尾（掏掉注入或改走别处都会红）
  assert.equal(run.lastMessageIsRunState[3], true);
  // consumed 写侧（`runLoopState.ttlInjectConsumed = true`）被掏空 ⇒ 后续折叠重新 armed ⇒ 注入两次
  assert.equal(run.injectedRequests.length, 1, "注入只能发生一次（consumed 生效）");
  assert.equal(run.lastMessageIsRunState.filter((flag) => flag).length, 1);
});

test("注入那一轮的低预算门是关的：armed 是注入的唯一原因（#177 刀5-E）", async () => {
  // 把低预算通道单独焊死（`isLowBudget && !fired` 整项关掉）后注入仍在同一轮出现，
  // 反过来证明上一轮的注入不是低预算通道给的——即 armed 这格真的在被读。
  // 对照：同场景把 `lowBudgetInjectFired` 的写侧掏空（既有 5 条红）不影响本用例的注入轮号。
  const run = await runFolded({ shape: "BsBs", maxRounds: 8 });
  const versionBefore = run.result.compactionStats.length;
  assert.ok(versionBefore > 0, "折叠统计必须存在，否则注入轮号无从判断");
  // 注入轮（3）之前不允许出现任何注入：低预算窗口在本场景里晚于 armed 窗口
  assert.deepEqual(run.injectedRequests.filter((index) => index < 3), []);
});
