import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

// issue #872 验收（假绿修复）：判据 3 的对照面从 `msgShape`（只有角色 + 块类型，注入**正文**变了也
// 不红）扩到**实际 provider 请求体**。以下 `blockDigest` / `requestDigest` 与捕获脚本
// `fixtures/capture-loop-runstate-inject-872.mjs`（已提交进仓，开头硬校验 worktree SHA）里的定义**逐字一致**（期望值就是在 base 上用同两个函数量出来的，两边必须同一把尺）：
//   · 文本块取**全文**（注入正文变 ⇒ 摘要变 ⇒ 红）；
//   · 工具块取 name + 入参 JSON；tool_result 取 toolUseId + 正文；
//   · 不取 model/temperature 等与注入无关的字段，只看 provider 真正看到的消息序列。
function blockDigest(block) {
  if (!block || typeof block !== "object") return { raw: typeof block };
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") return { type: "tool_use", name: block.name, input: JSON.stringify(block.input ?? null) };
  if (block.type === "tool_result") {
    return { type: "tool_result", toolUseId: block.tool_use_id ?? block.toolUseId, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) };
  }
  return { type: block.type };
}
function requestDigest(requests) {
  return requests.map((req) => ({
    messages: (req.messages ?? []).map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(blockDigest) : [{ type: "text", text: String(m.content ?? "") }],
    })),
  }));
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
    provider,
    roundEnds: events.filter((event) => event?.type === "round_end"),
  };
}

// issue #872（续写真格）：round_start 与 `max_tokens` 续写各注入一次的场景。
// 构造（base→HEAD 同脚本实测稳定，round 3 的 round_end 带 `injections: 2`）：
//   · round1/round2 各一发 `tool_use`（budgetTokens=400 ⇒ 每轮真折叠，攒出可折窗口）；
//   · round3：round_start 的 `compactBeforeRound` 折叠→通道 A 注入（注入 1）；provider 返
//     `max_tokens` + **大文本（无 tool_use）**⇒尾部不 pending ⇒ 续写分支里 `estimateMessageTokens
//     > budgetTokens` 使第二次 `compactBeforeRound` 触发、再折叠→注入 2；续写响应 `end_turn` 收口。
// 关键：带 `tool_use` 的 `max_tokens` 会走 `compaction_deferred`（不折叠）→不会二次注入；
// 必须用无 tool_use 的 max_tokens 文本才能走到续写里的 `compactBeforeRound`。
const contBigText = "truncated reasoning: ".padEnd(2200, "y");
async function runContinuation() {
  const provider = createFakeProvider([
    { content: [{ type: "tool_use", id: "c-1", name: "scan", input: { path: "f1.js" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "c-2", name: "scan", input: { path: "f2.js" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: contBigText }], stopReason: "max_tokens" },
    { content: [{ type: "text", text: "final" }], stopReason: "end_turn" },
  ]);
  const events = [];
  const result = await runDirect({
    provider,
    seed: "scan it",
    executeTool: async () => midToolOutput,
    maxRounds: 8,
    stallDetection: false,
    completion: false,
    config: { folding: { context: { budgetTokens: 400 } } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return {
    result,
    provider,
    events,
    roundEnds: events.filter((event) => event?.type === "round_end"),
  };
}

// 判据 3 的请求体摘要期望值：逐字取自 base worktree 2ad95dfa 现跑现取（非手搜）。
// 取法：用仓内提交的**等位捕获脚本** `fixtures/capture-loop-runstate-inject-872.mjs`（已把上面的
// `blockDigest`/`requestDigest` 逐字搬进去）在 base 上实跑 `provider.requests` 并序列化成稳定摘要，
// 写入 `test/fixtures/loop-runstate-inject-request-872.json`（脚本开头硬校验 `git rev-parse HEAD`==2ad95dfa
// 且工作树干净，否则非 0 退出；重新生成方法见 fixture `_meta.regenerate`）。
// base 无 `runStateInject` 事件键（那是本支才加的观测），但**请求体里的注入正文行为早于该观测**，
// 所以 base 的请求体就是 HEAD 应有的请求体（已实测 HEAD 5/5 场景与 base 逐字相等）。
const REQUEST_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/loop-runstate-inject-request-872.json", import.meta.url),
  "utf8",
));

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
    // issue #872：本场景注入轮无续写 ⇒ 本轮只注入一次，injections 必须为 1。
    assert.equal(inject.injections, 1, "单次注入轮 ⇒ injections=1");
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

test("判据 3：同一条 fake provider 脚本，改动前后产出相同的 rounds / termination.reason / 消息序列 / **实际 provider 请求体**（fixture 对照，含续写场景）", async () => {
  // 两层对照「注入行为未变」：
  //   ① rounds / termination.reason / msgShape（粗粒度，快）；
  //   ② **实际 provider 请求体**的稳定摘要（细粒度）：文本块取全文，注入**正文**变就红；
  //     与 base 2ad95dfa 现跑现取的 fixture 逐字比。之前的判据只到 ①（`msgShape`），注入正文
  //     变了也绿 ⇒ 假绿；② 就是堵住这个洞的。第 5 个场景是续写轮，同样纳入请求体对照。
  for (const name of Object.keys(BASE_BEHAVIOR)) {
    const { result, provider } = await runScenario(name);
    const expected = BASE_BEHAVIOR[name];
    assert.equal(result.rounds, expected.rounds, `${name}: rounds 变了 ⇒ 注入行为被动了`);
    assert.equal(result.termination.reason, expected.reason, `${name}: termination.reason 变了`);
    assert.deepEqual(msgShape(result.messages ?? []), expected.messages,
      `${name}: 消息序列变了（注入内容/时机改动都会在这里红）`);
    assert.deepEqual(requestDigest(provider.requests), REQUEST_FIXTURE[name],
      `${name}: provider 请求体变了（注入正文变 / 少一条注入块都会在这里红）`);
  }
  const cont = await runContinuation();
  assert.deepEqual(requestDigest(cont.provider.requests), REQUEST_FIXTURE.continuation,
    "continuation: 续写轮的 provider 请求体同样受检（注入正文变就红）");
});

// issue #872（假绿修复的反向证）：把期望值改坏必须红——用同一把 `requestDigest` 量出的
// 真实摘要当基准，只在**期望侧**做改动（不动实现），断言对照必然不等。
test("判据 3 反向证：注入正文改一个字 / 请求里少一条注入块 ⇒ 请求体摘要必须不等（红）", async () => {
  const { provider } = await runScenario("low-budget");
  const real = requestDigest(provider.requests);
  const expected = JSON.parse(JSON.stringify(REQUEST_FIXTURE["low-budget"]));
  // 基准：未改坏的期望与真实摘要逐字相等（否则下面两格的红没有参照系）。
  assert.deepEqual(real, expected, "基准：真实请求体 == base fixture（改坏之前必须等）");

  // 反向证一：定位 **run-state 注入正文块**再改它——注入块正文里有引擎渲染的特征行
  // `run=… v=… r=…/… left=… low=…`（见 src/run-state.js renderRunState），据此 find 到那块，
  // 只改它一个字符 ⇒ 必须红。这才咬住「注入正文变了必须红」（旧版改第一个非空文本块，命中的是
  // seed「scan it」，根本没碰到注入正文）。**找不到该块 ⇒ 这格反向证无效 ⇒ 必须红，绝不静默跳过。**
  const RUN_STATE_SIGNATURE = /run=\S* v=\d+ r=\d+\/\d+ left=\d+ low=\d/;
  const tamperedText = JSON.parse(JSON.stringify(expected));
  let injectionPoked = false;
  for (const req of tamperedText) {
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string" && RUN_STATE_SIGNATURE.test(block.text)) {
          // 只改第一个命中的注入块，且只改一个字符：把版本数字 `v=<数字>` 挪一格。
          block.text = block.text.replace(/(v=)(\d)/, (_m, prefix, digit) => `${prefix}${digit === "9" ? "8" : String(Number(digit) + 1)}`);
          injectionPoked = true;
          break;
        }
      }
      if (injectionPoked) break;
    }
    if (injectionPoked) break;
  }
  assert.equal(injectionPoked, true, "夹具里必须有一个含 run-state 特征行的注入正文块，否则这格反向证无效");
  assert.notDeepEqual(real, tamperedText, "注入正文改一个字 ⇒ 请求体摘要必须红");

  // 反向证二：删掉一条**多块消息**里的一块（模拟少一条注入块）⇒ 必须红。
  // 用 persist-fold：它的注入走通道 A，持久挂到摘要块上 ⇒ 有一条 `user: text+text+text` 的多块消息，
  // 删其中一块就是「注入正文从请求里掉了一块」的直接模型。
  const pfProvider = (await runScenario("persist-fold")).provider;
  const pfReal = requestDigest(pfProvider.requests);
  const pfExpected = JSON.parse(JSON.stringify(REQUEST_FIXTURE["persist-fold"]));
  assert.deepEqual(pfReal, pfExpected, "基准：persist-fold 真实请求体 == base fixture");
  const tamperedDrop = JSON.parse(JSON.stringify(pfExpected));
  // 找一条含 >=2 块的消息，删掉其中一块。
  let blockDropped = false;
  for (const req of tamperedDrop) {
    for (const msg of req.messages) {
      if (Array.isArray(msg.content) && msg.content.length >= 2) {
        msg.content = msg.content.slice(1);
        blockDropped = true;
        break;
      }
    }
    if (blockDropped) break;
  }
  assert.equal(blockDropped, true, "persist-fold 夹具里必须至少有一条含 >=2 块的消息才能做这个反向证");
  assert.notDeepEqual(pfReal, tamperedDrop, "少一条块（注入块）⇒ 请求体摘要必须红");
});

// issue #872（续写真格）：同一轮 round_start + `max_tokens` 续写各注入一次 ⇒ round_end 报 injections=2。
test("续写真格：同一轮 round_start 与 max_tokens 续写各注入一次 ⇒ round_end.runStateInject.injections === 2", async () => {
  const { roundEnds, events } = await runContinuation();
  // 该轮确实走了续写里的 compactBeforeRound（而不是被 pending tool_use 推迟）。
  assert.equal(events.filter((e) => e?.type === "compaction_deferred").length, 0,
    "续写轮不得走 compaction_deferred（走了就不会二次注入，真格失真）");
  const double = roundEnds.filter((e) => "runStateInject" in e && e.runStateInject.injections === 2);
  assert.equal(double.length, 1, "必须恰有一轮在同一轮内注入两次");
  const inject = double[0].runStateInject;
  assert.equal(inject.persist, true, "两次注入都走通道 A（真折叠）⇒ persist=true");
  assert.equal(inject.request, false, "低预算门未开⇒ request=false");
  assert.equal(inject.lowBudget, false, "本场景预算宽松（maxRounds=8、round 3）⇒ lowBudget=false");
  // 同轮两次注入的 remainingRounds 恒定（注入不新增预算也不改已用轮数）。
  assert.equal(inject.remainingRounds, 8 - double[0].round,
    "remainingRounds 与 maxRounds - round 对得上");
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
    injections: 1,
  }, "TTL armed 走通道 B：request=true、低预算门关、无持久挂载、单次注入");

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
