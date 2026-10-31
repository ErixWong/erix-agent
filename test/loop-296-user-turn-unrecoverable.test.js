// issue #296 —— 请求视图守卫退到最后一格（`unrecoverable`）时，**对外到底留下了什么**。
//
// 病根（先复现，再修）：
//   · `src/loop/provider-runner.js` 原来那一行是
//     `if (userTurnGuard.action !== undefined && userTurnGuard.action !== "unrecoverable")` ——
//     `unrecoverable` 被**滤掉**，理由是「守卫什么都没改，就不该留下可观测信号」。
//     可这一格不是「什么都没发生」：它恰恰是「视图违反 I1（非空 ∧ 至少一条真 user 轮）且源里
//     没有可回补的 user 轮」，接下来**照原样发出去**的就是一个没有 user 轮的请求（真上游回
//     `400 invalid_request: No user query found in messages`）。T1 的第一段就是这个复现：
//     宿主既拿不到事件、终局里也看不出——只能看到一个和守卫无关的 400。
//   · 同一格也**不过** `validateMessages`：`provider-runner.js` 顶部那次
//     `validateMessages(ctx.messages, …)` 校的是**源**（`ctx.messages`），从来不是最终
//     `requestMessages`；而这一格按定义返回的就是刚刚被 `isPassableview` 拒掉的视图，
//     再验一遍只会得到同一个必然抛错 ⇒ **刻意跳过**（理由写在 `request-user-view.js` 那一格上方）。
//     R2 把这个「刻意」钉成行为：不抛、不改视图、必须带 `reason`。
//
// 本文件钉三面：
//   T1 复现 + 修复面：宿主给的初始消息没有真 user 轮 ⇒ 请求视图照原样发出（不抛、不造假 user 轮）
//      **且**恰好多出一条 `user_turn_guard_unrecoverable` 事件；`compactionStats` 里不许出现
//      `userTurnGuard`（两个通道分开，别把「没压缩的一轮」写进压缩账）。
//   T2 该格的子原因与「刻意跳过」：`empty_view` / `no_user_turn` / `invalid_view` 三格穷尽、
//      返回视图逐字不变、不抛；结构上 `#296` 的理由就写在赋值旁边（删掉理由 ⇒ 红）。
//   T3 两个**真的改了视图**的动作照旧走 `compactionStats`（`preserved_latest_user_turn` /
//      `abandoned_fold`），不被挪到新通道：同一跑里事件数为 0、`userTurnGuard` 照旧出现。
//
// 零真实 LLM（脚本化 provider）、不写盘、不碰 `~/.erix`。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { ensureUserTurnView } from "../src/loop/request-user-view.js";
import { validateMessages } from "../src/messages/rounds.js";

const filler = (count, char) => char.repeat(count);

const PAD_TOOL = {
  name: "pad",
  description: "returns deterministic filler",
  inputSchema: { type: "object", properties: { step: { type: "number" } }, required: [] },
};

const executeTool = async () => ({ content: [{ type: "text", text: `pad-result ${filler(1200, "f")}` }] });

/** 脚本化 provider：记下每一次请求视图，最后一个脚本步之后重复最后一步。 */
function scriptedProvider(steps) {
  const views = [];
  let index = 0;
  const handle = async (request, channel) => {
    views.push({ channel, messages: request.messages });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return typeof step === "function" ? step(request) : step;
  };
  return {
    views,
    protocol: "fake",
    model: "fake-model",
    async chat(request) { return handle(request, "chat"); },
    async chatStream(request) { return handle(request, "chatStream"); },
  };
}

const DONE = [{ content: [{ type: "text", text: "DONE" }], stopReason: "end_turn" }];

// 宿主给的初始消息：**没有**真 user 轮（纯 assistant 文本），但本身通过 `validateMessages`
// —— 这就是「视图违反 I1、源里也没有可回补的 user 轮」那一格最直接的可达形状。
const assistantOnlyHistory = () => [
  { role: "assistant", content: [{ type: "text", text: "orphan assistant text" }] },
];

// 三条真 user 轮的历史（与 #292 / #547 同形状，用来触发前两格守卫动作）。
const seededHistory = () => [
  { role: "user", content: [{ type: "text", text: `oldest-user-turn ${filler(1200, "a")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "b") }] },
  { role: "user", content: [{ type: "text", text: `middle-user-turn ${filler(1200, "c")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "d") }] },
  { role: "user", content: [{ type: "text", text: `latest-user-turn ${filler(1200, "e")}` }] },
];

function baseOptions({
  provider, messages, stream, run = {}, budgetTokens = 400000, folding = true, events,
}) {
  return {
    provider,
    tools: [PAD_TOOL],
    executeTool,
    // 观察者回调写在**规范之家** `capabilities.hooks.*`（#498：回调收能力面，不再加顶层扁平键）。
    ...(events === undefined ? {} : { capabilities: { hooks: { onEvent: (event) => events.push(event) } } }),
    config: {
      run: {
        ...run,
        maxRounds: 6,
        completion: false,
        stallDetection: false,
        ...(stream === undefined ? {} : { stream }),
      },
      input: { system: "call pad each round, then answer", messages },
      ...(folding
        ? { folding: { context: { strategy: "fold-statistical", budgetTokens, keepRounds: 2, task: "issue #296" } } }
        : {}),
    },
  };
}

const unrecoverableEvents = (events) => events.filter((event) => event.type === "user_turn_guard_unrecoverable");

/** 真 user 轮：role user 且不是纯 tool_result 载体（与 `isRealUserTurn` 同口径，就地重写）。 */
function hasRealUserTurn(messages) {
  return messages.some((message) => {
    if (message?.role !== "user") return false;
    if (typeof message.content === "string") return true;
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.length === 0 || blocks.some((block) => block?.type !== "tool_result");
  });
}

// ─────────────────────────────────────────────── T1 复现 + 信号

test("T1 #296 请求视图退到 unrecoverable：视图照原样发出，且宿主拿到一条 user_turn_guard_unrecoverable", async () => {
  // 前提（不是断言对象）：这个初始形状本身合法——所以复现的不是「宿主传了非法消息」，
  // 而是「引擎的 I1 在这一格没人守」。
  assert.doesNotThrow(() => validateMessages(assistantOnlyHistory(), { allowPendingToolUse: false }));

  const provider = scriptedProvider(DONE);
  const events = [];
  const result = await runToolLoop(
    baseOptions({ provider, messages: assistantOnlyHistory(), folding: false, events }),
  );

  // (a) 视图真的**照原样**发出去了：没有 user 轮、也没有被伪造一条。
  assert.equal(provider.views.length, 1, "这一跑只该有一次 provider 调用");
  const shipped = provider.views[0].messages;
  assert.equal(hasRealUserTurn(shipped), false, "该格的定义就是「照原样发」——视图里本来就没有 user 轮");
  assert.deepEqual(
    shipped.map((message) => message.role),
    ["assistant"],
    `视图必须逐字等于源（不许造假 user 轮、也不许抛）：实际 ${JSON.stringify(shipped.map((message) => message.role))}`,
  );

  // (b) 「刻意跳过 validateMessages」的行为面：run 不因这条视图变成 invalid_messages，
  //     也不造假一条 user 轮——它照常走完（真上游会不会 400 是上游的事，引擎不替它决定 run 必死）。
  //     ⚠ 这一格**不是**「补一条 validateMessages 就会红」：`validateMessages` 本身不要求 user 轮，
  //     所以这条形状它本来就能过。真正能钉住「不重新验」的是 T2 的第 3 格（`invalid_view`：
  //     视图真的过不了 `validateMessages`，而守卫仍然原样放行）——那里的反向证明见交付报告。
  assert.equal(result.termination.reason, "end_turn", "该格不抛、不把 run 判死");

  // (c) 对外信号：恰好一条，形状可断言。
  const signals = unrecoverableEvents(events);
  assert.equal(signals.length, 1, `必须恰好一条 user_turn_guard_unrecoverable，实际 ${JSON.stringify(events.map((e) => e.type))}`);
  const [signal] = signals;
  assert.equal(signal.round, 1);
  assert.equal(signal.channel, "chat", "通道名必须是真被调用的那条");
  assert.equal(signal.reason, "no_user_turn", "子原因：视图非空但没有真 user 轮");
  assert.equal(
    typeof signal.detail,
    "string",
    "detail 必须给（首句固定原文，宿主可直接断言）",
  );
  assert.match(
    signal.detail,
    /^the request view still violates the user-turn invariant after every fallback/u,
    "detail 首句是固定原文",
  );
  assert.equal(
    Object.hasOwn(signal, "runId"),
    false,
    "宿主没给 runId 时引擎不编一个（同 #182 / #464 口径）",
  );

  // (d) 两个通道分开：这一格**不许**写进压缩账（否则「这一轮到底有没有折叠」不可判读）。
  assert.deepEqual(
    (result.compactionStats ?? []).filter((stat) => stat.userTurnGuard !== undefined),
    [],
    "unrecoverable 不许落进 compactionStats.userTurnGuard",
  );
});

test("T1b #296 通道名与 runId 跟着真实调用走（streaming ⇒ chatStream；宿主给了 runId 就带上）", async () => {
  const provider = scriptedProvider(DONE);
  const events = [];
  await runToolLoop(baseOptions({
    provider,
    messages: assistantOnlyHistory(),
    folding: false,
    stream: true,
    events,
    run: { runId: "issue-296-t1b" },
  }));

  const signals = unrecoverableEvents(events);
  assert.equal(signals.length, 1, "流式通道下同样只该有一条");
  assert.equal(signals[0].channel, "chatStream", "通道名必须报真被调用的那一条（不许写死 chat）");
  assert.equal(signals[0].runId, "issue-296-t1b", "宿主给了 runId ⇒ 事件必须带上（join 键）");
  assert.equal(provider.views[0].channel, "chatStream", "前提：这一跑真的走了流式通道");
});

// ─────────────────────────────────────────────── T2 子原因 + 「刻意跳过」

test("T2 #296 第 4 格的三个子原因穷尽、视图逐字不变、且刻意不过 validateMessages", () => {
  // 1) 视图空
  const emptyStats = {};
  const emptyOut = ensureUserTurnView([], [{ role: "assistant", content: [{ type: "text", text: "x" }] }], emptyStats);
  assert.equal(emptyStats.action, "unrecoverable");
  assert.equal(emptyStats.reason, "empty_view");
  assert.deepEqual(emptyOut, []);

  // 2) 视图非空但没有真 user 轮（纯 tool_result 载体不算 user 轮）
  const orphanToolUse = [{ role: "assistant", content: [{ type: "tool_use", id: "u1", name: "pad", input: {} }] }];
  const orphanToolResult = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "r" }] }];
  const noUserStats = {};
  const noUserOut = ensureUserTurnView(orphanToolResult, orphanToolUse, noUserStats);
  assert.equal(noUserStats.reason, "no_user_turn");
  assert.deepEqual(noUserOut, orphanToolResult, "原样返回：块对象逐个相等");

  // 3) 视图有 user 轮但配对非法（assistant tool_use 后面接了一条 user 文本）——这一格**就是**
  //    「该分支不过 validateMessages」的字面形状：交给它的是 validateMessages 会拒的视图。
  const brokenPairing = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "pad", input: {} }] },
    { role: "user", content: [{ type: "text", text: "wedged in" }] },
  ];
  const brokenStats = {};
  const brokenOut = ensureUserTurnView(brokenPairing, orphanToolUse, brokenStats);
  assert.equal(brokenStats.action, "unrecoverable");
  assert.equal(brokenStats.reason, "invalid_view");
  assert.deepEqual(brokenOut, brokenPairing, "刻意跳过 = 原样返回，不抛、不修");
  assert.throws(
    () => validateMessages(brokenOut, { allowPendingToolUse: true }),
    (error) => error?.code === "invalid_messages",
    "前提：这个视图真的过不了 validateMessages —— 而守卫仍然原样放行（刻意跳过，不是漏了）",
  );

  // 4) 三格互斥且穷尽：`isPassableview` 为假时只可能是这三条。
  assert.deepEqual(
    new Set([emptyStats.reason, noUserStats.reason, brokenStats.reason]),
    new Set(["empty_view", "no_user_turn", "invalid_view"]),
  );
});

test("T2b #296 「跳过是有意的」这件事必须留在代码里（删掉理由 ⇒ 红）", () => {
  const source = readFileSync(new URL("../src/loop/request-user-view.js", import.meta.url), "utf8");
  const at = source.indexOf('stats.action = "unrecoverable"');
  assert.notEqual(at, -1, "`request-user-view.js` 里必须还有 `stats.action = \"unrecoverable\"` 这一格");
  const window = source.slice(Math.max(0, at - 2000), at);
  assert.match(window, /#296/u, "赋值旁边的理由必须点名 issue #296（否则下一个人只会看到「这里没验」）");
  assert.match(
    window,
    /validateMessages/u,
    "理由必须写清「为什么**不**重新过 validateMessages」——那是这一格最容易被误改成抛错的地方",
  );
  assert.match(window, /刻意跳过/u, "必须逐字写明这是刻意跳过（不是漏了）");
});

// ─────────────────────────────────────────────── T3 前两格不被挪走

test("T3 #296 真的改了视图的两个动作记账形状逐字不变（持久列表那一处），且不发请求视图那一处的新事件", async () => {
  const provider = scriptedProvider(DONE);
  const events = [];
  const result = await runToolLoop(
    baseOptions({ provider, messages: seededHistory(), budgetTokens: 8, events }),
  );

  const guarded = (result.compactionStats ?? []).filter((stat) => stat.userTurnGuard !== undefined);
  assert.ok(guarded.length > 0, "前提：极小预算下守卫真的在前两格里生效过（否则这一格什么也没测到）");
  // 前两格的动作名与通道名都不归本单动：逐字钉住（改名 / 掉键 ⇒ 红）。
  for (const stat of guarded) {
    assert.ok(
      ["preserved_latest_user_turn", "abandoned_fold"].includes(stat.userTurnGuard),
      `compactionStats 里只许出现前两格的动作名，实测 ${stat.userTurnGuard}`,
    );
    assert.equal(
      stat.userTurnGuardChannel,
      "persisted",
      "这一跑的前两格产生在写回持久列表那一处 ⇒ 通道名必须是 persisted",
    );
  }
  // 这两个动作**不是**「不可恢复」：它们真的改了视图。新事件只属于第 4 格，不许洒到共用路径上。
  assert.deepEqual(
    unrecoverableEvents(events),
    [],
    "前两格不许顺带发 unrecoverable 事件（上报只属于第 4 格）",
  );
});
