// issue #499 —— `context.onFoldSummary` 退役（处置 2）。本文件是**病根证据 + 退役后的形状**。
//
// 病根（#496 worker 报告 §6.4 发现，A 格的历史断言在 3eb336e 那个提交里跑绿过）：
// `onFoldSummary` 曾留在 `CONTEXT_OPTION_NAMES` 白名单里 ⇒ 宿主写 `context.onFoldSummary = fn` 时
//   ① 装配口**不抛**（它是「合法键」）、
//   ② 装配口**零 `context_unknown_option` 事件**（事件只对白名单外的键发）、
//   ③ 引擎**从不从 `context` 读它**（真实投递点是顶层 `onFoldSummary` / `policy.onFoldSummary`）
//   ⇒ 三次静默叠成「配了、不生效、连事件都没有」。这比未知键更糟：未知键至少留一条事件。
//
// 退役后的形状（主 agent 裁决：处置 2「退役」，不选「真去读它」）：从白名单移除 ⇒ 它像其它未知键
// 一样按**宿主元数据**对待 —— 装配口报一条 `context_unknown_option` 事件、直连静默放行、**都不抛**
// （抛是破坏：它是宿主业务键的形状，与 #493「只对旋钮家族强校验」口径一致）。
//
// 红线（D 格钉住）：只动 `context.` 侧。顶层 `onFoldSummary` 是**活选项**——有投递路径、有次数断言，
// 退役不许顺手删掉它。
//
// mutation 自证（实测见交付报告）：
//   · 把 `onFoldSummary` 加回 `CONTEXT_OPTION_NAMES`（= 撤销退役）⇒ A/B 两格的事件断言红；
//   · 把顶层 `onFoldSummary` 从 `RUN_TOOL_LOOP_OPTION_NAMES` 删掉（= 越界退役）⇒ D 格红。
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
import { RUN_TOOL_LOOP_OPTION_NAMES } from "../src/loop/option-normalization.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// 一条**必然折叠**的 run（与 `test/loop-option-gate-496.test.js` D① 同形）：
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

const foldContext = (extra = {}) => ({
  budgetTokens: 300,
  keepRounds: 1,
  strategy: createSlidingWindowStrategy({ keepRounds: 1 }),
  ...extra,
});

/** 直连路线的一条折叠 run；`contextExtra` 只多带被测的那一个 `context` 子键。 */
function runDirectFolding(contextExtra = {}, { onFoldSummary, diagnostics } = {}) {
  const events = [];
  const options = {
    provider: foldingProvider(),
    tools: FOLD_TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    initialUserMessage: "go",
    completion: false,
    maxRounds: 20,
    wrapup: false,
    stallDetection: false,
    onEvent: (event) => events.push(event),
    config: { folding: { context: foldContext(contextExtra) } },
    ...(onFoldSummary === undefined ? {} : { onFoldSummary }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
  return runToolLoop(options).then((result) => ({ result, events }));
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

/** 装配口路线的一条折叠 run（`context` 来自 `policy.context`，与直连共用同一份语义相规则）。 */
function runAssemblyFolding(contextExtra = {}) {
  const events = [];
  const port = makePort({ context: foldContext(contextExtra) }, events);
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
const folded = (result) => (result.compactionStats ?? []).some((stat) => stat.compacted === true);

// ================================================================ A. 正例：退役后装配口报事件、不抛、仍不投递
test("A 退役（正例）：`context.onFoldSummary` 不再在白名单里 ⇒ 装配口报一条 `context_unknown_option`、不抛、钩子仍零调用", async () => {
  // 机制面：退役就是「从白名单移除」，所以它现在**是**未知键（这条断言就是退役本身的机器判据）。
  assert.equal(
    CONTEXT_OPTION_NAMES.includes("onFoldSummary"),
    false,
    "退役：`onFoldSummary` 不得再出现在 context 白名单里",
  );
  assert.deepEqual(
    collectUnknownContextOptions({ onFoldSummary: () => {} }),
    ["onFoldSummary"],
    "退役：它必须落进「未知 context 子键」集合（这样装配口才拿得到它去发事件）",
  );

  let hookCalls = 0;
  // 机制面（装配期）：端口**构造一次** ⇒ 恰好一条事件。
  const constructionEvents = [];
  const port = makePort({ context: foldContext({ onFoldSummary: () => { hookCalls += 1; } }) }, constructionEvents);
  assert.ok(port, "退役后装配口必须照旧装配成功（不抛）");
  assert.equal(
    unknownEvents(constructionEvents).length,
    1,
    `构造一次端口只该有一条事件，实测 ${JSON.stringify(constructionEvents)}`,
  );
  assert.deepEqual(unknownEvents(constructionEvents)[0].event.keys, ["onFoldSummary"], "事件必须点名这个键");

  // 端到端：`runToolLoop({ assemblyPort })` 会经 `assemblyPortOptions` **再装配一次**
  // （`option-normalization.js` 的既有行为，不是本单引入），所以事件会出现两次；
  // 断言改成「至少一条、且每一条都点名 onFoldSummary」，不把「两次」当成契约。
  const { result, events } = await runAssemblyFolding({
    onFoldSummary: () => { hookCalls += 1; },
  });

  // ① 不抛：退役**不是**把静默换成报错（那会是破坏，主 agent 裁决的红线）。
  assert.ok(result.termination, "退役后装配口这条 run 必须照旧跑完（不抛）");
  assert.equal(result.termination.reason, "end_turn");
  // ② 前提：真发生了折叠 —— 否则下面「零调用」只是在测空气。
  assert.ok(folded(result), `前提：这条路径必须真的折叠，实测 ${JSON.stringify(result.compactionStats ?? [])}`);
  // ③ 退役的**可观察**收益：从「零事件」变成「一条事件，且点名这个键」。
  const warnings = unknownEvents(events);
  assert.ok(warnings.length >= 1, `退役后装配口必须报出事件，实测 ${JSON.stringify(warnings)}`);
  assert.ok(
    warnings.every((entry) => Array.isArray(entry.event.keys) && entry.event.keys.join(",") === "onFoldSummary"),
    `每条事件都必须点名 onFoldSummary，实测 ${JSON.stringify(warnings)}`,
  );
  // ④ 语义没变：它仍然不是投递点（退役 ≠ 突然开始读它）。
  assert.equal(hookCalls, 0, "`context.onFoldSummary` 依旧不被引擎读取，必须零调用");
});

test("A② 退役的边界：`context.onFoldSummary` 给非函数值也不抛（它现在是宿主元数据，不校形状）", async () => {
  // 与「白名单内且校形状」的键（`context.onBeforeFold` / `context.onAfterFold`）对照：
  // 退役的键若还校形状，就等于用报错把「退役」说成「还活着」。
  for (const value of ["notes", {}, 42, null]) {
    const events = [];
    assert.doesNotThrow(
      () => makePort({ context: { budgetTokens: 1000, onFoldSummary: value } }, events),
      `退役的元数据键不得因形状抛错（实测值 ${JSON.stringify(value)}）`,
    );
    assert.deepEqual(unknownEvents(events)[0]?.event.keys, ["onFoldSummary"]);
  }
  // 对照：仍然活着的两个 context 回调**照旧**校形状（证明 A② 不是把整类都放开了）。
  assert.throws(
    () => makePort({ context: { onBeforeFold: "hooks" } }, []),
    /context\.onBeforeFold must be a function \(or omitted\)/u,
  );
});

// ================================================================ B. 正例（直连）：静默放行、不抛、零事件
test("B 退役（直连路线正例）：不抛、钩子零调用、也收不到那条事件（直连从不发这条事件）", async () => {
  let hookCalls = 0;
  const { result, events } = await runDirectFolding({
    onFoldSummary: () => { hookCalls += 1; },
  });
  assert.ok(folded(result), "前提：这条路径必须真的折叠");
  assert.equal(result.termination.reason, "end_turn", "退役后直连路线照旧跑完（不抛）");
  assert.equal(hookCalls, 0, "退役 ≠ 开始读它：直连路线仍然零投递");
  assert.equal(
    events.filter((event) => event.type === "context_unknown_option").length,
    0,
    "直连路线从不发这条事件（#469 口径），退役不改这一点",
  );
});

// ================================================================ C. 与「本来就被放行的未知键」逐格同形
test("C 同形对照：退役后的 `onFoldSummary` 与 `onFoldSummaryx` 走同一条元数据分支（非破坏的机器判据）", async () => {
  const shapeOf = (key) => {
    const events = [];
    const port = makePort({ context: { budgetTokens: 1000, [key]: () => {} } }, events);
    const keys = unknownEvents(events).map((entry) => entry.event.keys);
    return {
      assembled: port !== undefined,
      eventCount: keys.length,
      // 归一掉键名本身：比的是**形状**（一条事件、只点名自己），不是名字。
      reportsItselfOnly: keys.every((group) => group.length === 1 && group[0] === key),
    };
  };
  const retired = shapeOf("onFoldSummary");
  const plainUnknown = shapeOf("onFoldSummaryx");
  assert.deepEqual(retired, plainUnknown, "退役后的键必须与一个普通未知键逐格同形（这才是「非破坏」）");
  assert.deepEqual(retired, { assembled: true, eventCount: 1, reportsItselfOnly: true });
  // 对照：**旋钮家族**的拼错照旧抛（退役没有放宽 #493 的家族判据）。
  assert.throws(
    () => makePort({ context: { maxPriorSummaryByte: 1024 } }, []),
    /unknown assembly policy context option: "maxPriorSummaryByte"/u,
  );
});

// ================================================================ D. 反例（红线一）：顶层 `onFoldSummary` 仍是活选项
test("D 红线一（反例）：顶层 `onFoldSummary` 照旧**真投递**并断言次数，给错照旧启动即抛", async () => {
  assert.ok(
    RUN_TOOL_LOOP_OPTION_NAMES.includes("onFoldSummary"),
    "红线一：顶层 `onFoldSummary` 不许被顺手退役（它是有投递路径的活选项）",
  );

  let topCalls = 0;
  const { result } = await runDirectFolding({}, { onFoldSummary: () => { topCalls += 1; } });
  assert.ok(folded(result), "前提：这条路径必须真的折叠");
  assert.ok(topCalls >= 1, `顶层 onFoldSummary 必须被真投递，实测 ${topCalls} 次`);

  // 投递失败仍走持久化账本（`persistence_error{port:"notes"}`），终局不改写 —— 活选项的既有契约。
  const persistence = [];
  const thrown = await runDirectFolding({}, {
    onFoldSummary: () => { throw new Error("宿主归档器炸了"); },
    diagnostics: { error: (event) => persistence.push(event) },
  });
  assert.equal(thrown.result.termination.reason, "end_turn", "钩子抱错不得改写终局");
  assert.ok(
    persistence.every((event) => event.port === "notes" && event.operation === "onFoldSummary"),
    `诊断事件必须是 onFoldSummary 的持久化失败，实测 ${JSON.stringify(persistence)}`,
  );

  // 形状校验照旧（`null` = 给了但给错 ⇒ 启动即抛）：退役只动 `context.` 侧。
  for (const bad of [null, {}, "notes"]) {
    await assert.rejects(
      () => runDirectFolding({}, { onFoldSummary: bad }),
      /assembly policy option onFoldSummary must be a function \(or omitted\)/u,
      `顶层 onFoldSummary 给 ${JSON.stringify(bad)} 必须启动即抛`,
    );
  }
});
