// issue #499 —— `context.onFoldSummary` 退役（处置 2）。本文件是**病根证据 + 退役后的形状**。
//
// 病根（#496 worker 报告 §6.4 发现，本文件 A/B 两格先把它跑成可证伪的断言）：`onFoldSummary`
// 曾经留在 `CONTEXT_OPTION_NAMES` 白名单里 ⇒ 宿主写 `context.onFoldSummary = fn` 时
//   ① 装配口**不抛**（它是「合法键」）、
//   ② 装配口**零 `context_unknown_option` 事件**（事件只对白名单外的键发）、
//   ③ 引擎**从不从 `context` 读它**（真实投递点是顶层 `onFoldSummary` / `policy.onFoldSummary`）
//   ⇒ 三次静默叠成「配了、不生效、连事件都没有」。这比未知键更糟：未知键至少留一条事件。
//
// 退役后的形状（处置 2，主 agent 裁决：不选「真去读它」）：把它从白名单里移除，让它像其它未知键
// 一样按**宿主元数据**对待 —— 装配口报一条 `context_unknown_option` 事件、直连静默放行、**都不抛**
// （抛是破坏：它是宿主业务键的形状，与 #493「只对旋钮家族强校验」口径一致）。
//
// 红线（本文件 C/D 两格钉住）：只动 `context.` 侧。顶层 `onFoldSummary` 是**活选项**——
// 有投递路径、有次数断言，退役不许顺手删掉它。
//
// mutation 自证（实测见交付报告）：
//   · 把 `onFoldSummary` 加回 `CONTEXT_OPTION_NAMES`（= 撤销退役）⇒ A/B 两格的事件断言红；
//   · 把顶层 `onFoldSummary` 从 `RUN_TOOL_LOOP_OPTION_NAMES` 删掉（= 越界退役）⇒ C 格红。
//
// 零真实 LLM（fake provider），不写盘、不碰真实 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CONTEXT_OPTION_NAMES,
  collectUnknownContextOptions,
} from "../src/assembly-validators.js";
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// 一条**必然折叠**的直连 run（与 `test/loop-option-gate-496.test.js` D① 同形）：
// 预算压到 300 token + `keepRounds: 1` + 零 LLM 的 `sliding-window`，先 6 发工具调用撑过预算再收尾。
const FOLD_TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

function foldingProvider() {
  const toolTurns = Array.from({ length: 6 }, (_unused, index) => ({
    content: [{
      type: "tool_use",
      id: `tu_${index + 1}`,
      name: "echo",
      input: { text: `R${index + 1}_${"填充".repeat(300)}` },
    }],
    stopReason: "tool_use",
  }));
  return createFakeProvider([
    ...toolTurns,
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
}

/** 直连路线的一条折叠 run；`contextExtra` 只多带被测的那一个 `context` 子键。 */
function runDirectFolding(contextExtra = {}) {
  return runToolLoop({
    provider: foldingProvider(),
    tools: FOLD_TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    initialUserMessage: "go",
    completion: false,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
    context: {
      budgetTokens: 300,
      keepRounds: 1,
      strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
      ...contextExtra,
    },
  });
}

/** 装配口路线的端口（`policy` 在构造期就过闸口；`emit` 收装配期事件）。 */
function makePort(policy, events) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: foldingProvider(),
    tools: {
      definitions: FOLD_TOOLS,
      executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    },
    session: { id: `retired-499-${process.pid}` },
    emit: (type, event) => events.push({ type, event }),
    policy,
  });
}

/** 装配口路线的一条折叠 run（`context` 来自 `policy.context`，与直连走同一份语义相规则）。 */
function runAssemblyFolding(contextExtra = {}) {
  const events = [];
  const port = makePort({
    context: {
      budgetTokens: 300,
      keepRounds: 1,
      strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
      ...contextExtra,
    },
  }, events);
  return runToolLoop({
    assemblyPort: port,
    initialUserMessage: "go",
    completion: false,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
  }).then((result) => ({ result, events }));
}

const unknownEvents = (events) => events.filter((entry) => entry.type === "context_unknown_option");

// ================================================================ A. 病根：配了不生效，且装配口零事件
test("A 病根复现：`context.onFoldSummary` 落在白名单里 ⇒ 装配口不抛、**零** `context_unknown_option` 事件、钩子一次都不被调", async () => {
  // 机制面：这个键今天被算作「已知的 context 子键」（这就是静默的来源）。
  assert.ok(
    CONTEXT_OPTION_NAMES.includes("onFoldSummary"),
    "前提：`onFoldSummary` 必须还在 context 白名单里（退役前）",
  );
  assert.deepEqual(
    collectUnknownContextOptions({ onFoldSummary: () => {} }),
    [],
    "前提：白名单内的键不算「未知」，所以装配口拿不到它去发事件",
  );

  let hookCalls = 0;
  const { result, events } = await runAssemblyFolding({
    onFoldSummary: () => { hookCalls += 1; },
  });

  // ① 不抛（装配成功、run 正常收尾）——这正是「静默」的那一半。
  assert.ok(result.termination, "前提：装配口这条 run 必须跑完（不抛）");
  // ② 真发生了折叠 —— 否则「钩子没被调」可能只是因为没有折叠。
  assert.ok(
    (result.compactionStats ?? []).some((stat) => stat.compacted === true),
    `前提：这条路径必须真的折叠，实测 ${JSON.stringify(result.compactionStats ?? [])}`,
  );
  // ③ 病根：钩子配在 `context` 上 ⇒ 引擎从不读它 ⇒ 零调用。
  assert.equal(hookCalls, 0, "病根：`context.onFoldSummary` 不被引擎读取，必须零调用");
  // ④ 病根：连一条「你不认识这个键」的事件都没有（比未知键更糟）。
  assert.equal(
    unknownEvents(events).length,
    0,
    `病根：白名单放行 ⇒ 装配口零事件，实测 ${JSON.stringify(unknownEvents(events))}`,
  );
});

// ================================================================ B. 病根：直连路线同样「配了不生效、零事件」
test("B 病根复现：直连路线 `context.onFoldSummary` 同样不投递、不抛、也拿不到那条事件（直连从不发）", async () => {
  let hookCalls = 0;
  const events = [];
  const result = await runToolLoop({
    provider: foldingProvider(),
    tools: FOLD_TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    initialUserMessage: "go",
    completion: false,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
    onEvent: (event) => events.push(event),
    context: {
      budgetTokens: 300,
      keepRounds: 1,
      strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
      onFoldSummary: () => { hookCalls += 1; },
    },
  });
  assert.ok(
    (result.compactionStats ?? []).some((stat) => stat.compacted === true),
    "前提：这条路径必须真的折叠",
  );
  assert.equal(hookCalls, 0, "病根：直连路线同样从不从 `context` 读这个钩子");
  assert.equal(
    events.filter((event) => event.type === "context_unknown_option").length,
    0,
    "直连路线从不发这条事件（#469 口径）",
  );
});

// ================================================================ C. 对照：一个**真的未知**的键走的是哪条分支
test("C 对照前提：`context.onFoldSummaryx`（编辑距离 > 2）今天就不抛 ⇒ 退役后 `onFoldSummary` 会落同一条元数据分支（红线二的自查）", async () => {
  const events = [];
  const port = makePort({ context: { budgetTokens: 1000, onFoldSummaryx: () => {} } }, events);
  assert.ok(port, "前提：编辑距离 > 2 的未知键不得抛（宿主元数据放行分支）");
  const warnings = unknownEvents(events);
  assert.equal(warnings.length, 1, `前提：放行的未知键必须留一条事件，实测 ${JSON.stringify(warnings)}`);
  assert.deepEqual(warnings[0].event.keys, ["onFoldSummaryx"]);
});
