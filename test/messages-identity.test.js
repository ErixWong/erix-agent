// issue #257 T8：`messages` 数组身份契约的表征测试（characterization test）。
//
// 这组用例**不检验理想语义**，只把 `src/loop/orchestrator.js` 今天**实际发生**的行为钉死，
// 因为 #246（状态视图定形）step 1–4 会把编排器里手写的 `get/set` 访问器换成
// `makeStateView()` 生成的视图，而 `messages` 是其中最危险的一个：它同时出现在
// `baseToolContext` / `providerContext`（可读写）、`terminationContext` / `runSnapshotContext`
// （只有 getter）三类协作者上下文里，还有压缩回写与终局载荷两处「宿主直接读」的出口。
//
// 下面每条注释都写明「当前行为」与「接线后如果这条变红意味着什么」。
// 只注入假 provider，不联网。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { makeStateView } from "../src/loop/state-view.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const TOOL = [{ name: "lookup", description: "d", inputSchema: { type: "object", properties: {} } }];

// N 个工具轮 + 一个自然收尾轮（stopReason end_turn）。
function toolScript(rounds) {
  const script = [];
  for (let index = 0; index < rounds; index += 1) {
    script.push({
      content: [{ type: "tool_use", id: `call-${String(index)}`, name: "lookup", input: {} }],
      stopReason: "tool_use",
    });
  }
  script.push({ content: [{ type: "text", text: "final answer" }], stopReason: "end_turn" });
  return script;
}

// 观测通道：编排器把**内部那个 `messages` 数组本身**递给压缩策略的
// `shouldCompact(messages, budgetTokens)` / `compact(messages, options)`（见 orchestrator 里
// `compactBeforeRound` 读 `compactionContext.strategy` 那两处调用），且没有 budgetTokens 时
// `overBudget` 恒为 false、策略不点头就绝不会压缩——所以「只记录、不压缩」的哨兵策略可以
// 逐轮看到内部数组的真实身份，而**不改变**任何行为。
// 注意：provider 收到的 `request.messages` 是规范化后的**新数组**，finalGuard 载荷里的
// `messages` 是 `cloneState(...)` 的**深拷贝**，两者都不能当身份通道（E 组把它们钉住）。
function spyStrategy({ compactOnCall = null, compactImpl = null } = {}) {
  const seen = [];
  const compactInputs = [];
  const compactReturns = [];
  const strategy = {
    name: "identity-spy",
    shouldCompact(messages) {
      seen.push({ messages, length: messages.length, refs: messages.slice() });
      return compactOnCall !== null && seen.length === compactOnCall;
    },
    async compact(messages, options) {
      compactInputs.push(messages);
      const result = compactImpl
        ? await compactImpl(messages, options)
        : { messages, compacted: false };
      compactReturns.push(result.messages);
      return result;
    },
  };
  const arrays = () => seen.map((entry) => entry.messages);
  return { strategy, seen, arrays, compactInputs, compactReturns };
}

async function runLoop({ script, strategy, context, options = {} }) {
  return runToolLoop({
    provider: createFakeProvider(script),
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    tools: TOOL,
    ...options,
    context: { ...(context ?? {}), ...(strategy ? { strategy } : {}) },
  });
}

// ---------------------------------------------------------------------------
// A：返回载荷的 `messages` 与内部状态数组的引用关系
// ---------------------------------------------------------------------------

test("A1 返回载荷的 messages 与内部状态数组是同一个对象（当前行为：===，不是拷贝）", async () => {
  const spy = spyStrategy();
  const result = await runLoop({ script: toolScript(2), strategy: spy.strategy });

  // 内部数组全程只有一个身份（见 B1），因此最后一轮看到的与返回载荷必须是同一个对象。
  const lastRoundArray = spy.arrays().at(-1);
  assert.ok(lastRoundArray, "哨兵策略必须至少被调用一次");
  assert.equal(result.messages, lastRoundArray);

  // 宿主拿到结果后往 `result.messages` 里 push，改的就是编排器写过的那同一个数组：
  // 载荷没有在终局做 `.slice()` / `[...]`，否则这条会红。
  const before = result.messages.length;
  result.messages.push({ role: "user", content: [{ type: "text", text: "host push" }] });
  assert.equal(result.messages.length, before + 1);
  assert.equal(lastRoundArray.length, before + 1);
});

test("A2 transcript 是 messages 的浅拷贝：数组是新对象、元素是同一对象", async () => {
  const spy = spyStrategy();
  const result = await runLoop({ script: toolScript(2), strategy: spy.strategy });

  // 当前行为：termination.js 的 makeResult 里 `transcript: [...ctx.messages]`，
  // 而 `messages: ctx.messages` 直接给内部对象——所以两者长度相同、元素同一、容器不同。
  assert.notEqual(result.transcript, result.messages);
  assert.deepEqual(result.transcript, result.messages);
  assert.equal(result.transcript.length, result.messages.length);
  for (let index = 0; index < result.messages.length; index += 1) {
    assert.equal(result.transcript[index], result.messages[index]);
  }
});

test("A3 终局之后再动 messages，transcript 不受影响（快照语义）", async () => {
  const result = await runLoop({ script: toolScript(1), strategy: spyStrategy().strategy });
  const transcriptLength = result.transcript.length;
  result.messages.push({ role: "user", content: [{ type: "text", text: "late host push" }] });
  assert.equal(result.transcript.length, transcriptLength);
  assert.ok(result.messages.length > result.transcript.length);
});

// ---------------------------------------------------------------------------
// B：多轮之间的数组身份（当前行为：原地 push，身份全程不变）
// ---------------------------------------------------------------------------

test("B1 不压缩时全程只有一个数组身份，逐轮原地变长（当前行为：原地 push）", async () => {
  const spy = spyStrategy();
  const result = await runLoop({ script: toolScript(4), strategy: spy.strategy });

  const arrays = spy.arrays();
  assert.ok(arrays.length >= 4, "每个工具轮开始时都该被问一次是否压缩");
  assert.equal(new Set(arrays).size, 1, "多轮之间不得换成新数组（换成新数组＝#246 视图整体替换语义）");

  const lengths = spy.seen.map((entry) => entry.length);
  for (let index = 1; index < lengths.length; index += 1) {
    assert.ok(
      lengths[index] > lengths[index - 1],
      `第 ${String(index + 1)} 轮必须读到比上一轮更长的上下文`,
    );
  }
  // 全程同一个对象，直到终局载荷交出去。
  assert.equal(result.messages, arrays[0]);
  assert.ok(result.messages.length >= lengths.at(-1));
});

test("B2 上一轮原地 push 的内容，下一轮经同一引用读得到（前缀元素也是同一批对象）", async () => {
  const spy = spyStrategy();
  const result = await runLoop({ script: toolScript(3), strategy: spy.strategy });

  const roundOne = spy.seen[0];
  assert.equal(roundOne.length, 1, "第一轮开始时上下文里只有宿主那条 user");
  const roundTwo = spy.seen[1];
  assert.equal(roundTwo.messages, roundOne.messages, "第二轮必须还是同一个数组对象");
  assert.equal(roundTwo.length, 3, "第一轮的 assistant 工具调用与 tool_result 必须已原地入列");
  assert.equal(roundTwo.refs[0], roundOne.refs[0], "第一轮那条 user 不得被复制或被换掉");
  assert.equal(roundTwo.refs[1].role, "assistant");
  assert.equal(roundTwo.refs[1].content[0].type, "tool_use");
  assert.equal(roundTwo.refs[2].role, "user");
  assert.equal(roundTwo.refs[2].content[0].type, "tool_result");

  // 后一轮必须能看见前一轮写入的内容，且看到的仍是同一批元素对象（原地追加，不是重建）。
  const lastRound = spy.seen.at(-1);
  assert.equal(lastRound.messages, roundOne.messages);
  for (let index = 0; index < roundTwo.refs.length; index += 1) {
    assert.equal(lastRound.refs[index], roundTwo.refs[index]);
  }

  // 终局那条 assistant 也落在第一轮那个对象上——宿主只要持有引用就能看到全部内容。
  assert.equal(result.messages, roundOne.messages);
  assert.equal(result.messages.at(-1).role, "assistant");
  assert.equal(result.messages.at(-1).content[0].text, "final answer");
  assert.ok(result.messages.includes(roundTwo.refs[1]), "工具调用那条消息对象必须仍在同一数组里");
});

// ---------------------------------------------------------------------------
// C：一次压缩真的发生时（当前行为：整体替换绑定，不保数组身份）
// ---------------------------------------------------------------------------

test("C1 真的压缩时内部数组被整体替换，旧数组从此作废（当前行为：rebind 而非原地 splice）", async () => {
  const spy = spyStrategy();
  const result = await runLoop({
    script: toolScript(3),
    strategy: spy.strategy,
    context: { budgetTokens: 60, keepRounds: 1 },
    options: { executeTool: async () => "x".repeat(300) },
  });

  // 先证明压缩**真的发生**了（小预算 + 长工具输出逼出内置兜底链）。
  const compactedStats = result.compactionStats.filter((stat) => stat.compacted === true);
  assert.ok(compactedStats.length >= 1, "本用例必须真的发生一次压缩，否则 C 组什么都没测");
  assert.ok(
    compactedStats.every((stat) => stat.tokensAfter < stat.tokensBefore),
    "压缩必须真的让 token 回落",
  );

  const arrays = spy.arrays();
  assert.ok(
    new Set(arrays).size >= 2,
    "压缩后编排器必须换成压缩结果那个新数组（今天不是 splice 保身份）",
  );
  assert.notEqual(arrays[0], arrays.at(-1));

  // 换身份的那一刻：新数组比旧数组短（上下文确实被压缩掉），且旧数组**没有被就地裁剪**。
  let switchIndex = -1;
  for (let index = 1; index < arrays.length; index += 1) {
    if (arrays[index] !== arrays[index - 1]) {
      switchIndex = index;
      break;
    }
  }
  assert.ok(switchIndex > 0, "必须找到身份切换的那一轮");
  const stale = arrays[switchIndex - 1];
  const staleMaxSeen = Math.max(...spy.seen
    .filter((entry) => entry.messages === stale)
    .map((entry) => entry.length));
  assert.equal(
    stale.length,
    staleMaxSeen,
    "被换下的旧数组此后不得再被写；若接线改成原地 splice 保身份，旧数组会就地变短而红",
  );
  assert.notEqual(stale, result.messages, "返回载荷必须是压缩之后的新数组");
});

test("C2 折叠数为 0 且策略原地返回：身份全程保持（写回处不额外拷贝）", async () => {
  const same = spyStrategy({
    compactOnCall: 2,
    compactImpl: (messages) => {
      messages.shift();
      // foldedRounds 为 0 且不报折叠区间：不触发折叠后的 run-state 注入，写回只剩一处。
      return { messages, compacted: true, foldedRounds: 0 };
    },
  });
  const result = await runLoop({ script: toolScript(2), strategy: same.strategy });

  assert.equal(same.compactInputs.length, 1);
  assert.ok(result.compactionStats.some((stat) => stat.compacted === true));
  // 当前行为：压缩回写是「整体绑定为策略返回的那个对象」——策略原地改并返回同一数组时，
  // 身份自然保持；编排器自己**不会**再拷一份。接线若把视图改成「拷贝后整体赋值」，这里会红。
  assert.equal(new Set(same.arrays()).size, 1);
  assert.equal(same.compactInputs[0], same.arrays()[0]);
  assert.equal(result.messages, same.compactReturns[0]);
});

test("C3 折叠数为 0 且策略返回新数组：新数组直接成为内部状态并交进载荷", async () => {
  let produced = null;
  const spy = spyStrategy({
    compactOnCall: 2,
    compactImpl: (messages) => {
      produced = messages.slice(1);
      return { messages: produced, compacted: true, foldedRounds: 0 };
    },
  });
  const result = await runLoop({ script: toolScript(2), strategy: spy.strategy });

  assert.ok(result.compactionStats.some((stat) => stat.compacted === true));
  assert.equal(spy.compactInputs[0], spy.arrays()[1], "compact 收到的必须是当时的内部数组");
  assert.notEqual(produced, spy.arrays()[1], "压缩产出必须是新数组");
  assert.equal(result.messages, produced, "载荷必须交出压缩后的那个对象");
  assert.equal(spy.arrays().at(-1), produced, "压缩之后的每一轮看到的必须是新数组");
  assert.notEqual(spy.arrays()[0], produced, "旧数组从此刻作废");
});

test("C4 折叠数 >0 时还要再换一次容器：run-state 注入只换容器、不改元素", async () => {
  let produced = null;
  const spy = spyStrategy({
    compactOnCall: 2,
    compactImpl: (messages) => {
      produced = messages.slice(1);
      return {
        messages: produced,
        compacted: true,
        foldedRounds: 1,
        foldedRoundRange: { from: 1, to: 1 },
      };
    },
  });
  const result = await runLoop({ script: toolScript(2), strategy: spy.strategy });

  // 当前行为：有折叠就会走 `refreshRunState({ inject: true })`，它把
  // `messages = upsertRunStateInMessages(messages, rendered)` **整体绑回**——又一次容器替换。
  // `upsertRunStateInMessages` 内部是 `messages.map(...)`，连「没有任何 run-state 块可改写」时
  // 都返回 `.map()` 出来的新数组（它只在 rendered 不是非空字符串时才原样返回入参），
  // 所以这一次换容器与「有没有真的注入内容」无关。接线后改成「经视图原地写」这里就会红。
  assert.notEqual(result.messages, produced, "折叠后的 run-state 注入会再把数组整体换一次");
  const abandonedLength = produced.length;
  assert.ok(abandonedLength >= 1);
  for (let index = 0; index < abandonedLength; index += 1) {
    assert.equal(
      result.messages[index],
      produced[index],
      `第 ${String(index)} 条消息对象必须原封不动——注入只换容器，不得复制消息`,
    );
  }
  assert.equal(produced.length, abandonedLength, "被换下的容器不得再被写");
  assert.ok(result.messages.length > abandonedLength, "压缩之后新的工具轮只写进新容器");

  // 当前行为（实测）：轮边界能看到的身份**恰好 2 个**，不是 3 个。
  // 哨兵策略只在每一轮开始被问一次 `shouldCompact`，而「压缩产物」与「注入后的新容器」
  // 这两次换容器发生在**同一次压缩步骤之内**（compact 回写 → 立刻 refreshRunState({ inject: true })），
  // 所以压缩产物那个容器永远落在两个观测点之间、在轮边界看不到；
  // 它的存在只能靠 `compact()` 的返回值证明：它既不是旧数组，也不是终局载荷那个对象。
  // 接线后这条变红意味着：注入被改成原地写（轮边界身份仍是 1 个旧数组）、
  // 或压缩与注入被拆成两个轮次（身份数变 3）——两种都是可观测的语义改动。
  const observed = spy.arrays();
  assert.equal(new Set(observed).size, 2, "轮边界可见身份必须恰为 2：压缩前旧数组、注入后的新容器");
  assert.notEqual(observed[0], result.messages, "第一轮看到的旧数组必须已被换下");
  assert.equal(observed.at(-1), result.messages, "注入后的新容器必须是此后每一轮与终局载荷共用的那一个");
  assert.notEqual(produced, observed[0], "压缩产物必须是新容器，不是压缩前那个数组");
  assert.notEqual(produced, observed.at(-1), "压缩产物在同一个压缩步骤内就被注入换下，从不进入轮边界");
});

// ---------------------------------------------------------------------------
// D：只读 `messages` 访问器（`makeStateView` 的 `getOnly` 语义护栏）
// ---------------------------------------------------------------------------

const ORCHESTRATOR_SOURCE = readFileSync(
  new URL("../src/loop/orchestrator.js", import.meta.url),
  "utf8",
);

// 取某个上下文对象字面量所在的源码片段：从它自己的 `const <name> = {` 到下一个锚点声明之前。
// 锚点用符号名而不是行号：#246 接线会整体改写这些字面量，行号一动就全是假红。
function contextSource(name, nextAnchor) {
  const start = ORCHESTRATOR_SOURCE.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `找不到 ${name} 的声明`);
  const end = ORCHESTRATOR_SOURCE.indexOf(nextAnchor, start);
  assert.notEqual(end, -1, `找不到 ${name} 之后的锚点 ${nextAnchor}`);
  return ORCHESTRATOR_SOURCE.slice(start, end);
}

test("D1 只有 getter 的 messages 访问器：今天恰是 terminationContext 与 runSnapshotContext", () => {
  const shapes = {
    // 宿主工具上下文与 provider 上下文：读写都要有（providerContext 里 forceFinal 之外还有整体赋值）
    baseToolContext: ["const providerContext = {", true],
    providerContext: ["const terminationContext = {", true],
    // 终局上下文与 run snapshot 上下文：只有 getter
    terminationContext: ["const runSnapshotContext = {", false],
    runSnapshotContext: ["const runSnapshotExecutor = ", false],
  };
  for (const [name, [anchor, expectSetter]] of Object.entries(shapes)) {
    const body = contextSource(name, anchor);
    assert.match(body, /^\s+get messages\(\) \{/m, `${name} 必须有 messages getter`);
    const hasSetter = /^\s+set messages\(/m.test(body);
    assert.equal(
      hasSetter,
      expectSetter,
      `${name}.messages 今天${expectSetter ? "有" : "没有"} setter；`
      + (expectSetter
        ? "少了 setter 说明可写语境被改成只读视图，协作者的写入会被静默丢弃或抛错"
        : "多出 setter 说明 #246 把只读格子接成了可写视图——协作者从此可以整体替换内部数组"),
    );
  }

  // 穷尽性：全文件 messages 访问器的总数（4 个 getter / 2 个 setter），防止「新增第五个语境」溜过去。
  const getters = ORCHESTRATOR_SOURCE.match(/^\s+get messages\(\) \{/gm) ?? [];
  const setters = ORCHESTRATOR_SOURCE.match(/^\s+set messages\(/gm) ?? [];
  assert.equal(getters.length, 4, "messages getter 的总数变了：有协作者语境被增删");
  assert.equal(setters.length, 2, "messages setter 的总数变了：只读语境被补了 setter");
});

test("D2 只读语境里改数组内容必须仍然生效（强制收尾经 getter 原地 push）", async () => {
  const saved = process.env.ERIX_NO_FORCED_FINAL;
  delete process.env.ERIX_NO_FORCED_FINAL;
  const spy = spyStrategy();
  try {
    // 脚本全是 tool_use：轮数到顶触发 max_rounds_cap，终局前编排器要再要一次「强制收尾」回答。
    const result = await runLoop({
      script: [
        { content: [{ type: "tool_use", id: "c0", name: "lookup", input: {} }], stopReason: "tool_use" },
        { content: [{ type: "tool_use", id: "c1", name: "lookup", input: {} }], stopReason: "tool_use" },
        { content: [{ type: "text", text: "forced final draft" }], stopReason: "end_turn" },
      ],
      strategy: spy.strategy,
      options: { maxRounds: 2 },
    });

    assert.equal(result.termination.forcedFinal, true, "本用例必须走 forceFinalIfNeeded 这条路");
    // 强制收尾的指令与终稿都是经 `terminationContext.messages`（只有 getter）原地 push 进来的。
    const forcedInstruction = result.messages.filter((message) => (
      message.role === "user"
      && String(message.content?.[0]?.text ?? "").includes("强制收尾")
    ));
    assert.equal(forcedInstruction.length, 1, "只读访问器上的 push 没落到宿主可见数组里＝视图被拷贝或冻结了");
    assert.equal(result.messages.at(-1).role, "assistant");
    assert.equal(result.messages.at(-1).content[0].text, "forced final draft");
    // 而且没有换过身份：全程一个数组，终局载荷也是它。
    assert.equal(result.messages, spy.arrays()[0]);
    assert.equal(result.transcript.at(-1), result.messages.at(-1));
  } finally {
    if (saved === undefined) delete process.env.ERIX_NO_FORCED_FINAL;
    else process.env.ERIX_NO_FORCED_FINAL = saved;
  }
});

test("D3 getOnly 视图的机制口径：整体赋值抛 TypeError，改内容仍然生效", () => {
  // 与 test/state-view.test.js 的分工：那边测 makeStateView 本身；这里钉的是
  // 「#246 把 terminationContext/runSnapshotContext 接成视图后，messages 必须仍满足
  // 整体赋值抛 TypeError + 原地改内容生效」这组契约——本模块是 ESM，严格模式生效。
  const internal = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const state = { messages: internal };
  const view = makeStateView(state, [{ key: "messages", getOnly: true }]);

  assert.equal(
    Object.getOwnPropertyDescriptor(view, "messages").set,
    undefined,
    "getOnly 不得定义 setter",
  );
  const extra = { role: "assistant", content: [{ type: "text", text: "via getter" }] };
  view.messages.push(extra);
  assert.equal(internal.length, 2);
  assert.equal(internal.at(-1), extra, "只读视图必须交出活数组，不得冻结/拷贝");
  assert.throws(
    () => { view.messages = [{ role: "user", content: [{ type: "text", text: "replaced" }] }]; },
    TypeError,
    "只读格子被整体赋值必须抛 TypeError（补了 setter 就会静默成功，D1 也会红）",
  );
  assert.equal(internal.at(-1), extra);
});

// ---------------------------------------------------------------------------
// E：宿主可见面（返回载荷键集合与相邻字段形状、finalGuard 载荷的拷贝语义）
// ---------------------------------------------------------------------------

test("E1 返回载荷的键集合与相邻字段形状（防止接线时顺手改载荷）", async () => {
  const spy = spyStrategy();
  const result = await runLoop({ script: toolScript(1), strategy: spy.strategy });

  assert.deepEqual(Object.keys(result).slice().sort(), [
    "compactionStats",
    "completionErrors",
    "finalText",
    "messages",
    "rounds",
    "runState",
    "termination",
    "transcript",
    "truncated",
    "unpersisted",
    "usage",
    "verification",
  ]);

  assert.equal(typeof result.finalText, "string");
  assert.equal(result.finalText, "final answer");
  assert.equal(typeof result.rounds, "number");
  assert.equal(typeof result.truncated, "boolean");
  assert.equal(result.truncated, false);
  assert.equal(typeof result.termination.reason, "string");
  assert.equal(typeof result.verification.status, "string");
  assert.equal(typeof result.verification.metrics, "object");
  assert.deepEqual(Object.keys(result.usage).slice().sort(), ["input_tokens", "output_tokens"]);
  assert.ok(Array.isArray(result.compactionStats));
  assert.ok(Array.isArray(result.unpersisted));
  assert.deepEqual(result.completionErrors, []);
  assert.equal(typeof result.runState, "object");
  // messages / transcript 的位置与形状：宿主是直接读 `messages` 的那一方，见 A 组。
  assert.ok(Array.isArray(result.messages));
  assert.ok(Array.isArray(result.transcript));
});

test("E2 finalGuard 载荷的 messages 是深拷贝，宿主回调改不动循环内部状态", async () => {
  const payloads = [];
  const spy = spyStrategy();
  const result = await runToolLoop({
    provider: createFakeProvider(toolScript(1)),
    initialUserMessage: "start",
    executeTool: async () => "worked",
    completion: false,
    tools: TOOL,
    context: { strategy: spy.strategy },
    finalGuard: (payload) => {
      payloads.push(payload);
      return { action: "accept" };
    },
  });

  assert.equal(payloads.length, 1);
  assert.deepEqual(Object.keys(payloads[0]).slice().sort(), [
    "finalText",
    "findings",
    "messages",
    "round",
    "rounds",
    "signal",
    "termination",
  ]);
  // 当前行为：callFinalGuard 里 `messages: cloneState(ctx.messages)`——载荷不是活引用。
  assert.notEqual(payloads[0].messages, result.messages);
  assert.notEqual(payloads[0].messages[0], result.messages[0]);
  assert.deepEqual(payloads[0].messages, result.messages);

  const snapshotLength = payloads[0].messages.length;
  payloads[0].messages.push({ role: "user", content: [{ type: "text", text: "guard push" }] });
  payloads[0].messages[0].content[0].text = "mutated by guard";
  assert.equal(result.messages.length, snapshotLength, "回调改载荷不得影响真实上下文");
  assert.notEqual(result.messages[0].content[0].text, "mutated by guard");
});
