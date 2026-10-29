// issue #569 —— `context.foldAtRatio`：折叠可以**提前**到预算的一个比例（默认 `1.0`）。
//
// 病根：折叠触发今天只有一条预算硬闸（`compactBeforeRound` 里 `estimatedTokens > budgetTokens`）。
// 宿主想说「到预算一半就折」只能传一个**策略对象**——那会把 `compact()` 实现也一起接过去，
// 层级记账（`layers` / `foldedThrough` / `foldedFacts` / #313 观测）随之绕开。
//
// 本文件钉五件事（每格都有反例，见 `test/loop-fold-at-ratio-569.test.js` 的段头）：
//   A. **不传时逐字等价**：`overBudget` 的判定与今天（`estimatedTokens > budgetTokens`）逐格相同；
//   B. `r = 0.5` + `budgetTokens = 203161` ⇒ 阈值 101580.5：100k 不折、102k 折，两侧边界各一格；
//   C. **白名单接受**（#493 的形状）：`context.foldAtRatio` 在 `CONTEXT_OPTION_NAMES` 里，
//      装配口既不抛 `context_unknown_option` 也不发那条事件；
//   D. **非法值装配期抛 `TypeError` 并点名键名**（两条入口路线同一句话）——不静默回落默认值；
//   E. `1.0` 显式传入 ≡ 不传（防止默认值被写成 0.999 之类的漂移）。
//
// 观测口径（为什么是 `compaction` 事件）：`compactBeforeRound` 里 `overBudget` 为真才进折叠分支，
// 分支末尾**无条件** `recordCompactionStat(...)` ⇒ 该轮 `compaction` 事件的存在就是判定结果的
// 唯一足迹（`strategyRequestsCompaction` 在这里恒为 `false`：本文件**不配** `context.strategy`，
// 于是 `overBudget` 是唯一的触发器）。折叠真正改写了消息时事件里还会带 `foldedRounds` / `tokensAfter`，
// B4 用它证明「提前折」不是空转。
//
// 零真实 LLM（fake provider）、不写盘、不碰 `~/.erix`。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import {
  CONTEXT_OPTION_NAMES,
  contextOptionNameSelfCheck,
} from "../src/assembly-validators.js";
import { estimateMessageTokens } from "../src/tokens.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

// 票面那个数：`r = 0.5` 时阈值 = 101580.5（所以 101580 不折、101581 折）。
const BUDGET = 203161;
const HALF_THRESHOLD = BUDGET * 0.5;

const DONE = [{ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }];

/**
 * 造一段 ASCII 文本，使**单条 user 消息**的 `estimateMessageTokens` 恰好等于 `target`。
 *
 * 用引擎自己的估算函数收敛（而不是手算 `chars/3.5*1.15`）：估算里有 `Math.ceil` 与每消息 4 的
 * framing，手算的偏差会让「100k / 102k 卡两侧」变成「两个都在同一侧」，那格就静默失去意义。
 *
 * @param {number} target
 * @returns {string}
 */
function seedTextFor(target) {
  let chars = Math.ceil(((target - 4) / 1.15) * 3.5);
  for (let guard = 0; guard < 64; guard += 1) {
    const got = estimateMessageTokens([
      { role: "user", content: [{ type: "text", text: "a".repeat(chars) }] },
    ]);
    if (got === target) return "a".repeat(chars);
    chars += got < target ? 1 : -1;
  }
  throw new Error(`seedTextFor(${target}) did not converge`);
}

/**
 * 两轮历史（user / assistant / user），总估算 ≈ `target`。
 *
 * 用途是 B4：`keepRounds: 0` 时头部那一轮**真的**被折掉，于是「提前折」有 `foldedRounds` 可断言，
 * 而不只是「事件出现了」。
 *
 * @param {number} target
 * @returns {Array<{role: string, content: Array<{type: string, text: string}>}>}
 */
function historyFor(target) {
  const half = seedTextFor(Math.floor(target / 2));
  return [
    { role: "user", content: [{ type: "text", text: half }] },
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "user", content: [{ type: "text", text: half }] },
  ];
}

/**
 * 跑一次 run 并交出事件面。
 *
 * @param {{
 *   estimatedTokens?: number,
 *   messages?: Array<object>,
 *   budgetTokens?: number,
 *   foldAtRatio?: number,
 *   keepRounds?: number,
 * }} options
 */
async function run({ estimatedTokens, messages, budgetTokens = BUDGET, foldAtRatio, keepRounds }) {
  const events = [];
  const context = { budgetTokens };
  // `undefined` = 不传（逐字等于今天）；其余值原样写进去（非法值那条路不走这里）。
  if (foldAtRatio !== undefined) context.foldAtRatio = foldAtRatio;
  if (keepRounds !== undefined) context.keepRounds = keepRounds;
  const input = messages ?? [
    { role: "user", content: [{ type: "text", text: seedTextFor(estimatedTokens) }] },
  ];
  const result = await runDirect({
    provider: createFakeProvider(DONE),
    config: {
      input: { messages: input },
      folding: { context },
      run: { maxRounds: 2, completion: false },
    },
    wrapup: false,
    executeTool: async () => "ok",
    store: createMemoryTranscriptStore(),
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return {
    result,
    events,
    /** 第 1 轮的折叠足迹：判定为真才会有它。 */
    firstRound: events.filter((event) => event.type === "compaction" && event.round === 1),
    fallbacks: events.filter((event) => event.type === "compaction_strategy_fallback"),
  };
}

/** 最小合法装配口入参（成员都是同步工厂，`emit` 收事件）。 */
function portInput(policy, events) {
  return {
    modelConfig: () => ({
      resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }),
    }),
    provider: () => createFakeProvider(DONE),
    tools: () => ({ definitions: [], executeTool: async () => "ok" }),
    session: { id: "fold-at-ratio-569" },
    policy,
    emit: (type, payload) => events.push({ type, payload }),
  };
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------
// A. 不传时逐字等价：`overBudget` 与今天（`estimatedTokens > budgetTokens`）逐格相同。
//
// 反向证：把 `budgetTokens * foldAtRatio` 换回 `budgetTokens`（即把 `r` 从判据里去掉）⇒ A 段全绿、
// B 段（`r = 0.5`）必须红。所以 A 段的价值不是「能红」，而是**给 B 段的红一个基准**：判定公式没变。
// ---------------------------------------------------------------------------------------------------

test("A1 不传 / 显式 1.0 时判定与今天的 `estimatedTokens > budgetTokens` 逐格相同（小预算矩阵）", async () => {
  const budget = 1000;
  const rows = [];
  for (const estimatedTokens of [999, 1000, 1001]) {
    const omitted = await run({ estimatedTokens, budgetTokens: budget });
    const explicit = await run({ estimatedTokens, budgetTokens: budget, foldAtRatio: 1 });
    const expected = estimatedTokens > budget;
    rows.push({
      estimatedTokens,
      omitted: omitted.firstRound.length === 1,
      explicit: explicit.firstRound.length === 1,
      expected,
    });
  }
  assert.deepEqual(rows, [
    { estimatedTokens: 999, omitted: false, explicit: false, expected: false },
    { estimatedTokens: 1000, omitted: false, explicit: false, expected: false },
    { estimatedTokens: 1001, omitted: true, explicit: true, expected: true },
  ]);
});

test("A2 在本单那个预算上（203161）不传时仍按 `> budgetTokens` 判，不早折", async () => {
  const below = await run({ estimatedTokens: BUDGET - 1 });
  assert.equal(below.firstRound.length, 0, "203160 < 203161 ⇒ 不折（与今天一致）");

  const above = await run({ estimatedTokens: BUDGET + 1 });
  assert.equal(above.firstRound.length, 1, "203162 > 203161 ⇒ 折（与今天一致）");
  assert.equal(above.firstRound[0].compaction.tokensBefore, BUDGET + 1);
});

// ---------------------------------------------------------------------------------------------------
// B. `r = 0.5` + `budgetTokens = 203161` ⇒ 阈值 101580.5。
//
// 反向证：把 `ratio` 从判据里去掉（退回纯预算 203161）⇒ B1/B2/B3/B4 的「折」那几格必须红。
// ---------------------------------------------------------------------------------------------------

test("B1 r=0.5：100k 不折（阈值 101580.5 的另一侧）", async () => {
  const { firstRound } = await run({ estimatedTokens: 100000, foldAtRatio: 0.5 });
  assert.equal(HALF_THRESHOLD, 101580.5, "票面的两个数先自证：203161 × 0.5");
  assert.equal(firstRound.length, 0);
});

test("B2 r=0.5：102k 折，且引擎量到的就是 102000", async () => {
  const { firstRound } = await run({ estimatedTokens: 102000, foldAtRatio: 0.5 });
  assert.equal(firstRound.length, 1, "102000 > 101580.5 ⇒ 提前折");
  assert.equal(firstRound[0].compaction.tokensBefore, 102000);
});

test("B3 r=0.5：边界两侧各一格（101580 不折 / 101581 折）", async () => {
  const below = await run({ estimatedTokens: 101580, foldAtRatio: 0.5 });
  assert.equal(below.firstRound.length, 0, "101580 < 101580.5");
  const above = await run({ estimatedTokens: 101581, foldAtRatio: 0.5 });
  assert.equal(above.firstRound.length, 1, "101581 > 101580.5");
});

test("B4 r=0.5 是**真的**折：两轮历史 102k + keepRounds 0 ⇒ foldedRounds / tokensAfter 都动；同一份历史不传 r ⇒ 不折", async () => {
  const messages = historyFor(102000);
  const total = estimateMessageTokens(messages);
  assert.ok(total > HALF_THRESHOLD, `夹具必须已在阈值之上，实得 ${total}`);

  const early = await run({ messages, foldAtRatio: 0.5, keepRounds: 0 });
  assert.equal(early.firstRound.length, 1, "提前折的判定必须为真");
  const stat = early.firstRound[0].compaction;
  assert.equal(stat.tokensBefore, total);
  assert.equal(stat.compacted, true);
  assert.ok(stat.foldedRounds >= 1, `必须真的折掉轮次，实得 foldedRounds=${stat.foldedRounds}`);
  assert.ok(stat.tokensAfter < stat.tokensBefore, "折完必须变小");

  // 同一份历史、同一个 keepRounds，只是不传 r ⇒ 回到今天：102k 远低于 203161，不折。
  const baseline = await run({ messages, keepRounds: 0 });
  assert.equal(baseline.firstRound.length, 0, "不传 r 时 102k 不该折（默认 1.0 的兼容边界）");
});

// ---------------------------------------------------------------------------------------------------
// C. 白名单接受（#493 的形状）。
//
// ⚠ 这一格的「红」不是抛错：`foldAtRatio` **不在** `FOLD_SUMMARIZER_CAP_NAMES` 家族里，
// `validateContextOptionNames` 只对旋钮家族的拼错抛。白名单漏列它时，宿主给对了值会收到一条
// `context_unknown_option` **事件**（装配口）——所以本格必须同时钉「不抛」与「没那条事件」。
// 反向证：把 `foldAtRatio` 从 `CONTEXT_OPTION_NAMES` 去掉 ⇒ C1 的「没事件」必须红。
// ---------------------------------------------------------------------------------------------------

test("C1 context.foldAtRatio 在白名单里：装配口不抛、也不发 context_unknown_option", () => {
  const events = [];
  const port = createAssemblyPort(portInput({ context: { foldAtRatio: 0.5, budgetTokens: BUDGET } }, events));
  assert.ok(port !== undefined, "装配口必须构造成功");
  const unknown = events.filter((event) => event.type === "context_unknown_option");
  assert.deepEqual(unknown, [], "白名单漏列时这里会是 [{ keys: [\"foldAtRatio\"] }]");
  assert.ok(CONTEXT_OPTION_NAMES.includes("foldAtRatio"), "白名单是这件事的唯一真相");
  // 摘要旋钮家族的交叉自检不受影响：foldAtRatio 不是那一族（它是系数，不是正整数上限）。
  assert.deepEqual(contextOptionNameSelfCheck(), []);
});

test("C2 同一条事件通道是活的：真未知子键照旧点名（于是 C1 的「没事件」有意义）", () => {
  const events = [];
  createAssemblyPort(portInput({ context: { foldAtRatio: 0.5, bogusKnob569: 1 } }, events));
  const unknown = events.filter((event) => event.type === "context_unknown_option");
  assert.equal(unknown.length, 1);
  assert.deepEqual(unknown[0].payload.keys, ["bogusKnob569"]);
});

// ---------------------------------------------------------------------------------------------------
// D. 非法值 ⇒ **装配期** `TypeError` 并点名键名（不静默回落默认值，#493 同口径）。
//
// 反向证：把校值改成「静默回落 1.0」⇒ D1/D2 必须红（一条都不抛）。
// ---------------------------------------------------------------------------------------------------

const ILLEGAL_RATIOS = [
  ["0", 0],
  ["-1", -1],
  ["1.5", 1.5],
  ['"0.5"（字符串）', "0.5"],
  ["NaN", Number.NaN],
  ["null", null],
];

for (const [label, value] of ILLEGAL_RATIOS) {
  test(`D1 装配口拒绝 foldAtRatio = ${label}（TypeError 点名键名）`, () => {
    const events = [];
    const error = thrown(() => createAssemblyPort(
      portInput({ context: { foldAtRatio: value } }, events),
    ));
    assert.ok(error instanceof TypeError, `必须抛 TypeError，实得 ${error}`);
    assert.match(error.message, /foldAtRatio/u, "判词必须点名键名");
    assert.equal(error.via, "assembly", "路线标签：装配口");
  });

  test(`D2 直连路线拒绝 foldAtRatio = ${label}（同一句话，via=direct）`, async () => {
    const error = await runDirect({
      provider: createFakeProvider(DONE),
      config: { folding: { context: { foldAtRatio: value } } },
      executeTool: async () => "ok",
      store: createMemoryTranscriptStore(),
    }).then(() => undefined, (thrownError) => thrownError);
    assert.ok(error instanceof TypeError, `必须抛 TypeError，实得 ${error}`);
    assert.match(error.message, /foldAtRatio/u, "两条路线同一句话（#496 的判据）");
    assert.equal(error.via, "direct", "路线标签：直连");
  });
}

test("D3 合法值一个都不许误伤（0.0001 / 0.5 / 1）", async () => {
  for (const foldAtRatio of [0.0001, 0.5, 1]) {
    const events = [];
    const port = createAssemblyPort(portInput({ context: { foldAtRatio } }, events));
    assert.ok(port !== undefined, `foldAtRatio=${foldAtRatio} 必须被接受`);
    assert.deepEqual(events.filter((event) => event.type === "context_unknown_option"), []);
  }
});

test("D4 省略 = 默认（undefined 不校值，逐字等于今天）", () => {
  const events = [];
  const port = createAssemblyPort(portInput({ context: { foldAtRatio: undefined } }, events));
  assert.ok(port !== undefined, "undefined 是「没给」，不是「给了个错值」");
});

// ---------------------------------------------------------------------------------------------------
// E. `1.0` 显式传入 ≡ 不传（防默认值漂移：写成 0.999 这里会红）。
// ---------------------------------------------------------------------------------------------------

test("E1 显式 1.0 与不传在折叠分支上逐字相同（事件面 deepEqual）", async () => {
  const omitted = await run({ estimatedTokens: BUDGET + 1 });
  const explicit = await run({ estimatedTokens: BUDGET + 1, foldAtRatio: 1.0 });
  assert.equal(omitted.firstRound.length, 1, "这一格必须在折叠分支上，否则对拍没有内容");
  assert.deepEqual(explicit.firstRound, omitted.firstRound, "compaction 事件必须逐字相同");
  assert.deepEqual(explicit.fallbacks, omitted.fallbacks, "兜底诊断也必须逐字相同");
  assert.deepEqual(
    explicit.events.map((event) => [event.type, event.round]),
    omitted.events.map((event) => [event.type, event.round]),
    "事件序列的形状也必须相同",
  );
});

test("E2 默认值就是 1.0：203000 在不传时不折，而 0.999 会折（把默认值写成 0.999 这格必红）", async () => {
  const estimatedTokens = 203000; // 203161 × 0.999 ≈ 202958 ⇒ 0.999 下会折；× 1.0 = 203161 ⇒ 不折
  const omitted = await run({ estimatedTokens });
  assert.equal(omitted.firstRound.length, 0, "默认必须是 1.0（203000 < 203161）");
  const drift = await run({ estimatedTokens, foldAtRatio: 0.999 });
  assert.equal(drift.firstRound.length, 1, "0.999 在这里会折 ⇒ 默认值漂移是可见的");
});
