import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #872（#862 修法 C，观测面）：`round_end` 事件新增**一个加法键** `runStateInject`，
// 只在「本轮**真的**发生了 run-state 注入」时出现——缺席 = 没注入（**绝不写 `false`**，与
// #476 `finalTextFallback` / #862 `finalTextShape` 同一条口径）。四个子键：
//   · `lowBudget`        —— 本轮是否处于低预算门（`remainingRounds <= 2`）；
//   · `request`          —— 走了通道 B（run-state 块追加到请求视图尾部）；
//   · `persist`          —— 走了通道 A（run-state 持久挂到摘要块，仅真折叠轮 `foldedRounds>0`）；
//   · `remainingRounds`  —— 当时的剩余轮数（`effectiveMaxRounds - budgetRounds`）。
// 目的：让复现 #862 的人一眼看出「泄漏轮是不是恰好就是注入轮」。**不改任何注入行为**
// （阈值、内容、轮次逐字不动），判据 3 就是对这条硬约束的对账。
//
// 形状事实（base 2ad95dfa worktree 同脚本实测，非推测）：
//   · 低预算注入是 one-shot（`lowBudgetInjectFired` 一次消费），所以「跑满预算的 run」里
//     带键的轮只有**门第一次打开的那一轮**（`round === maxRounds - 2`），后续低预算轮没有
//     注入 ⇒ 没有键——这正是「缺席 = 没注入」要钉的形状，而不是 bug；
//   · TTL `layers.ttl.triggered` 只把大结果在 payload 层 stub 化，`compacted` 仍是 `false`，
//     **不**产生通道 A；通道 A 要 `folding.context.budgetTokens` 小到真折叠整轮。

const bigTtl = `line: ${"x".repeat(20_000)}`;
const midToolOutput = "payload: ".padEnd(1500, "x");

function msgShape(messages) {
  return messages.map((m) => `${m.role}:${Array.isArray(m.content) ? m.content.map((b) => b?.type ?? typeof b).join("+") : typeof m.content}`);
}

// 四个场景是判据 3 的**对照 fixture**：base（改动前）与 HEAD（改动后）各跑一遍同一条
// fake provider 脚本，下面的期望值逐字取自 **base worktree 2ad95dfa** 的输出
// （探针 = 本文件场景构造的等位脚本，2026-11-18 实测；两边 `behavior_same` 全真）。
async function runScenario(name) {
  const spec = {
    // 跑满预算：maxRounds=4 ⇒ 第 2 轮起 `remainingRounds <= 2`，低预算门打开。
    "low-budget": { shape: "sss", maxRounds: 4 },
    // 预算宽松：maxRounds=8，两轮就 end_turn，全程无折叠 ⇒ 不应有任何注入。
    generous: { shape: "s", maxRounds: 8 },
    // 通道 B（TTL 首折 armed）：大结果被 TTL stub 化并 armed，注入走请求视图尾部。
    "ttl-request": { shape: "BsBs", maxRounds: 8, foldTtl: 2 },
    // 通道 A（持久挂载）：budgetTokens 小到每轮真折叠整轮（foldedRounds>0）。
    "persist-fold": { shape: "ssss", maxRounds: 8, persistFold: true },
  }[name];
  const steps = spec.shape.split("").map((kind, index) => ({
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
  const events = [];
  const result = await runDirect({
    provider,
    seed: "scan it",
    executeTool: async ({ input }) => (spec.persistFold ? midToolOutput : (input.big ? bigTtl : "small result")),
    maxRounds: spec.maxRounds,
    stallDetection: false,
    completion: false,
    ...(spec.foldTtl
      ? {
        config: { folding: { toolResultTtl: spec.foldTtl } },
        semanticStateProvider: ({ state }) => ({
          text: "notes: use note_list before note_read",
          version: state.stateVersion,
        }),
      }
      : {}),
    ...(spec.persistFold ? { config: { folding: { context: { budgetTokens: 400 } } } } : {}),
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return {
    result,
    roundEnds: events.filter((event) => event?.type === "round_end"),
  };
}

// 判据 3 的期望值：逐字来自 base 2ad95dfa（改动前）同脚本实测。
const BASE_BEHAVIOR = {
  "low-budget": {
    rounds: 4,
    reason: "end_turn",
    messages: [
      "user:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ],
  },
  generous: {
    rounds: 2,
    reason: "end_turn",
    messages: [
      "user:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ],
  },
  "ttl-request": {
    rounds: 5,
    reason: "end_turn",
    messages: [
      "user:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ],
  },
  "persist-fold": {
    rounds: 5,
    reason: "end_turn",
    messages: ["user:text+text+text", "assistant:text"],
  },
};

test("判据 1：跑满预算的 run，注入轮的 round_end 带 runStateInject（lowBudget=true、remainingRounds 与 maxRounds-round 对得上、通道至少开一条）", async () => {
  const maxRounds = 4;
  const { roundEnds } = await runScenario("low-budget");
  assert.equal(roundEnds.length, maxRounds, "场景必须真的跑满轮数");
  const injected = roundEnds.filter((event) => "runStateInject" in event);
  // one-shot 消费（`lowBudgetInjectFired`）⇒ 带键的恰是门第一次打开的那轮：round 2（4-2）。
  assert.deepEqual(injected.map((event) => event.round), [2],
    "低预算注入恰一次，且落在 remainingRounds<=2 的首轮（maxRounds-2=2）");
  for (const event of injected) {
    const inject = event.runStateInject;
    assert.equal(inject.lowBudget, true, "本轮必须由低预算门触发");
    assert.equal(inject.remainingRounds, maxRounds - event.round,
      "remainingRounds 必须与 maxRounds - round 对得上");
    assert.equal(typeof inject.request, "boolean");
    assert.equal(typeof inject.persist, "boolean");
    assert.equal(inject.request || inject.persist, true,
      "request / persist 至少一条通道为真（键在场 = 真注入了）");
    // 无折叠 ⇒ 本场景只可能走通道 B；persist 必须为 false（不是缺席，而是布尔假值——
    // 「绝不写 false」说的是**整键**，子键是完整的通道真相）。
    assert.equal(inject.persist, false);
    assert.equal(inject.request, true);
  }
});

test("判据 2：预算宽松的 run，round_end 一律没有 runStateInject 键（缺席=没注入，绝不写 false），其余键集合与改动前逐字相同", async () => {
  const { roundEnds } = await runScenario("generous");
  assert.ok(roundEnds.length >= 2, "场景必须真发出多轮 round_end（否则空转）");
  for (const event of roundEnds) {
    assert.equal("runStateInject" in event, false,
      `round ${event.round}：没注入就不许出现该键（写 false 也违规）`);
    // 键集合对账：与 base 2ad95dfa 上同场景 round_end 的键集合逐字一致（探针实测）。
    assert.deepEqual(Object.keys(event), ["type", "round", "finalText", "stopReason", "usage"],
      "老路径的 round_end 键集合一个字节不许动（#835 四键 + type）");
  }
});

test("判据 3：同一条 fake provider 脚本，改动前后产出相同的 rounds / termination.reason / 消息序列（fixture 对照）", async () => {
  for (const name of Object.keys(BASE_BEHAVIOR)) {
    const { result } = await runScenario(name);
    const expected = BASE_BEHAVIOR[name];
    assert.equal(result.rounds, expected.rounds, `${name}: rounds 变了 ⇒ 注入行为被动了`);
    assert.equal(result.termination.reason, expected.reason, `${name}: termination.reason 变了`);
    assert.deepEqual(msgShape(result.messages ?? []), expected.messages,
      `${name}: 消息序列变了（注入内容/时机改动都会在这里红）`);
  }
});

test("判据 4：注入通道 A（persist，真折叠轮）与通道 B（request，低预算与 TTL armed 两条 armed 来源）各有真格跑到", async () => {
  // —— 通道 A：budgetTokens=400 让第 2 轮起每轮真折叠整轮（foldedRounds>0）⇒
  //    persist=true 且 request 恒 false（A 在场时 B 让位）。base 上同场景无任何键
  //    （改动前这是观测盲区）；这里钉的是**新键对 A 的可见性**。
  const persistRun = await runScenario("persist-fold");
  const persistEnds = persistRun.roundEnds.filter((event) => "runStateInject" in event);
  assert.deepEqual(persistEnds.map((event) => event.round), [2, 3, 4, 5],
    "真折叠轮（第 2 轮起每轮折叠）必须逐轮带键");
  for (const event of persistEnds) {
    assert.equal(event.runStateInject.persist, true, `round ${event.round}：通道 A 必须可见`);
    assert.equal(event.runStateInject.request, false, "A 在场时 B 关闭，不许同轮双真");
    assert.equal(event.runStateInject.lowBudget, false, "maxRounds=8 的宽松预算里低预算门不开");
    assert.equal(event.runStateInject.remainingRounds, 8 - event.round);
  }
  // 同场景里不许出现 request-only 的轮（persist 折叠轮全量覆盖第 2 轮起的每一轮）。
  assert.equal(persistRun.roundEnds.filter((e) => e.runStateInject?.request).length, 0);

  // —— 通道 B（低预算来源）：判据 1 场景里 request=true / persist=false，已钉。
  // —— 通道 B（TTL armed 来源）：`ttl-request` 场景里注入轮在第 4 轮——
  //    预算宽松（lowBudget=false）⇒ 唯一可能的 armed 来源是 TTL 首折，通道 B 由此可见。
  const ttlRun = await runScenario("ttl-request");
  const ttlInjected = ttlRun.roundEnds.filter((event) => "runStateInject" in event);
  assert.deepEqual(ttlInjected.map((event) => event.round), [4],
    "TTL 首折 armed 的消耗轮必须带键（one-shot ⇒ 恰一次）");
  assert.deepEqual(ttlInjected[0].runStateInject, {
    lowBudget: false,
    request: true,
    persist: false,
    remainingRounds: 4,
  }, "TTL armed 走通道 B：request=true、低预算门关、无持久挂载");

  // TTL 触发 ≠ 折叠轮（形状事实）：该场景 compactionStats 里没有任何整轮折叠，
  // 所以 persist 恒 false 不是「没跑到 A」，而是本场景结构上不存在 A。
  assert.equal(ttlRun.result.compactionStats.every((stat) => stat.compacted === false), true,
    "ttl-request 场景必须真的只有 payload 层 TTL、没有整轮折叠（否则 persist=false 的归因失真）");

  // 全局不变量：任何场景的任何轮，两条通道不同时为真（引擎互斥门 `!persistInject && …`）。
  for (const name of ["low-budget", "generous", "ttl-request", "persist-fold"]) {
    const { roundEnds } = await runScenario(name);
    for (const event of roundEnds) {
      if (!("runStateInject" in event)) continue;
      assert.equal(event.runStateInject.request && event.runStateInject.persist, false,
        `${name} round ${event.round}: A/B 互斥门被焊穿`);
    }
  }
});
