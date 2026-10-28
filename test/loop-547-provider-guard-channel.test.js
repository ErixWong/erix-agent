// issue #547 —— `provider-runner.js` 请求视图守卫那一处的**通道名**今天到底有没有生产者。
//
// 背景（#538 交付时如实报告、本单要求当场取证）：#538 把「通道名」与「provider 方法分支」
// 合一到 `streamsThisRun(ctx)`，但通道名那一处（`recordUserTurnGuard({ channel })`）在
// **最自然的四条形状**上都没有生产者：
//   · 折叠只会改写 tool_result 的正文、不改条数、不改块类型 ⇒ 视图不会比源**更缺** user 轮；
//   · run-state 只往尾部**追加**一条 user 文本 ⇒ 只会让视图更合规；
//   · 两条合起来仍推不出「视图缺 user 轮而源不缺」⇒ 守卫落在 `unrecoverable`，被
//     `provider-runner.js` 那一行过滤掉（不记账）。
// 于是「删掉通道名」与「它其实有生产者」这两种结论在行为面上**无法用折叠/复用/续跑区分**。
//
// #547 自己造探针（基点 `1fdeb1e`），当时的结论是**有生产者**，而且不是上面那四条：
//   生产者 = `max_tokens` 续写 + 低预算 run-state 请求注入
//     · `orchestrator.js` 的续写调用是**唯一**以 `allowPendingToolUse: true` 调 provider 的地方；
//     · 该轮若处于低预算（`remainingRounds <= 2`）或 TTL 注入已武装，`compactBeforeRound` 会
//       给出非空 `requestStateBlock`，并**跨续写循环保留**（`requestStateBlock` 是同一个局部量）；
//     · 截断发生在 tool_use 上 ⇒ `messages` 末尾是 `assistant[tool_use]`（严格校验会拒，
//       续写调用按 `allowPendingToolUse: true` 放行）；
//     · `appendRunStateToRequestView` 无条件往尾部追加一条 user 文本 ⇒
//       视图 = `[…, assistant(tool_use), user(text)]` ⇒ **配对断裂**；
//     · 守卫因此不是「原样放行」：`[current + 最新 user 轮]` 仍非法，退到「只留最新 user 轮」
//       那一格 ⇒ `action = preserved_latest_user_turn` ⇒ 通道名被消费（chat / chatStream）。
// 对照（同一截断 provider、把 maxRounds 调到 6 ⇒ 首轮不是低预算 ⇒ 没有 run-state 注入）：
// 守卫一次都不记账。所以生产者是「run-state 请求注入 × 尾部悬空 tool_use」，不是截断本身。
//
// **#548 之后（本文件的当前事实，别按 #547 的结论读）**：上面那个「生产者」不是一个合法形状，
// 而是 #548 的缺陷本体——追加把一份**本来合法**的续写视图弄成非法，代价是整段上下文被
// `preserved_latest_user_turn` 摘掉（`count=1`）。#548 在追加侧加了判据（尾部悬空 `tool_use` ⇒
// 跳过追加），于是**这条生产者消失**：请求视图那一处的通道名回到「没有行为面生产者」的状态。
// 通道名本身**没有**被删（删不删是 #547 处置的延续，需要单独决定，见 #548 报告），所以：
//   T2/T3 按新事实改写：同一形状不再记账、通道名不再出现，且**视图保住**（不再被压成一条）；
//   守卫的**记账能力**仍由单元面钉着：`test/loop-request-user-invariant.test.js` T5 直接调
//   `ensureUserTurnView` 断言 `preserved_latest_user_turn` / `unrecoverable` 等动作照旧产出，
//   T3 末尾再补一条结构判据（`provider-runner.js` 的记账分支与通道名逐字还在）。
//
// 本文件钉四面：
//   T1 四条自然形状（折叠关 / 折叠强制 / run-state 复用 / 快照续跑）**都不产生**
//      `userTurnGuardChannel: chat|chatStream`（它们只会走 `persisted` 那一处）——
//      这就是「今天谁还走得到」的逐格证据，不是注释；
//   T2/T3 第五条形状（低预算 run-state 注入 × 尾部悬空 `tool_use`）：#547 时它消费通道名，
//      #548 之后它**不再**消费（视图保住、守卫不记账）——两格合起来就是「现在没有形状能触发
//      请求视图那一处的通道名」的完整枚举（四条自然形状 + 这条）；
//   T4 因果对照：去掉低预算注入 ⇒ 同一 provider 也造不出该形状 ⇒ 记账数归零。
//
// 零真实 LLM（脚本化 provider）、不写盘、不碰 `~/.erix`（run-state 用内存 store）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const filler = (count, char) => char.repeat(count);

const PAD_TOOL = {
  name: "pad",
  description: "returns deterministic filler",
  inputSchema: { type: "object", properties: { step: { type: "number" } }, required: [] },
};

const executeTool = async () => ({
  content: [{ type: "text", text: `pad-result ${filler(1500, "f")}` }],
});

// 三条真 user 轮 + 两条 assistant 轮，全部远超极小预算（与 #292 的夹具同形状，但本文件自带，
// 不复用 `test/helpers/` 之外的任何夹具）。
const seededHistory = () => [
  { role: "user", content: [{ type: "text", text: `oldest-user-turn ${filler(1200, "a")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "b") }] },
  { role: "user", content: [{ type: "text", text: `middle-user-turn ${filler(1200, "c")}` }] },
  { role: "assistant", content: [{ type: "text", text: filler(1200, "d") }] },
  { role: "user", content: [{ type: "text", text: `latest-user-turn ${filler(1200, "e")}` }] },
];

const TOOL_SCRIPT = [
  { content: [{ type: "tool_use", id: "t1", name: "pad", input: { step: 1 } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "t2", name: "pad", input: { step: 2 } }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "DONE" }], stopReason: "end_turn" },
];

/** 脚本化 provider：记录每次请求视图，两个通道都实现。 */
function scriptedProvider(steps) {
  const views = [];
  let index = 0;
  const handle = async (request, channel) => {
    views.push({
      channel,
      count: request.messages.length,
      users: request.messages.filter((message) => message?.role === "user").length,
    });
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

/** 截断在 tool_use 上（每次一个新 id：续写会把内容并进同一条 assistant，重复 id 会被校验器拒）。 */
function truncatingProvider() {
  let counter = 0;
  return scriptedProvider([() => {
    counter += 1;
    return {
      content: [{ type: "tool_use", id: `t${counter}`, name: "pad", input: { step: counter } }],
      stopReason: "max_tokens",
    };
  }]);
}

function baseOptions({ provider, budgetTokens = 400000, maxRounds = 6, stream, run = {}, messages, store }) {
  return {
    provider,
    ...(store === undefined ? {} : { store }),
    tools: [PAD_TOOL],
    executeTool,
    config: {
      run: { ...run, maxRounds, completion: false, stallDetection: false, ...(stream === undefined ? {} : { stream }) },
      input: {
        system: "call pad each round, then answer",
        ...(messages === undefined ? {} : { messages }),
      },
      folding: {
        toolResultTtl: 1,
        toolResultFoldMinTokens: 1,
        context: { strategy: "fold-statistical", budgetTokens, keepRounds: 2, task: "issue #547" },
      },
    },
  };
}

const guardStats = (result) => (result.compactionStats ?? []).filter((stat) => stat.userTurnGuard !== undefined);
const providerSiteChannels = (result) => guardStats(result)
  .map((stat) => stat.userTurnGuardChannel)
  .filter((channel) => channel === "chat" || channel === "chatStream");

// ─────────────────────────────────────────────── T1 四条自然形状：通道名无生产者

test("T1 #547 折叠 / run-state 复用 / 快照续跑四条形状都走不到 provider-runner 的通道名", async () => {
  // (a) 折叠关闭（ttl 0 + 健康预算）：视图就是源，守卫无事可做。
  const a = scriptedProvider(TOOL_SCRIPT);
  const shapeA = await runToolLoop(baseOptions({ provider: a, budgetTokens: 400000, messages: seededHistory() }));
  assert.equal(shapeA.termination.reason, "end_turn");
  assert.equal(guardStats(shapeA).length, 0, "折叠关闭时守卫一次都不该记账");
  assert.deepEqual(providerSiteChannels(shapeA), []);

  // (b) 折叠强制触发（极小预算 + ttl 1）：视图真的被折过，但走的是**写回持久列表**那一处
  //     （`channel: "persisted"`），不是请求视图那一处。
  const b = scriptedProvider(TOOL_SCRIPT);
  const shapeB = await runToolLoop(baseOptions({ provider: b, budgetTokens: 8, messages: seededHistory() }));
  assert.equal(shapeB.termination.reason, "end_turn");
  const foldedB = (shapeB.compactionStats ?? []).reduce((sum, stat) => sum + (stat.foldedRounds ?? 0), 0);
  assert.ok(foldedB > 0, `(b) 前提：视图必须真的被折过，实际 foldedRounds 合计 ${foldedB}`);
  assert.ok(guardStats(shapeB).length > 0, "(b) 守卫确实生效过（否则这一格什么也没测到）");
  assert.deepEqual(
    guardStats(shapeB).map((stat) => stat.userTurnGuardChannel),
    guardStats(shapeB).map(() => "persisted"),
    "(b) 折叠造出的守卫动作只出现在写回持久列表那一处（persisted），请求视图那一处不记账",
  );

  // (c) run-state 复用：第一跑 saveRunState，第二跑 resume: true 走 loadRunState。
  const store = createMemoryTranscriptStore();
  let savedStates = 0;
  const realSave = store.saveRunState.bind(store);
  store.saveRunState = async (runId, state) => { savedStates += 1; return realSave(runId, state); };
  let loadedStates = 0;
  const realLoad = store.loadRunState.bind(store);
  store.loadRunState = async (runId) => { loadedStates += 1; return realLoad(runId); };
  const c1 = scriptedProvider(TOOL_SCRIPT);
  await runToolLoop(baseOptions({ provider: c1, budgetTokens: 8, run: { runId: "issue-547-c" }, messages: seededHistory(), store }));
  const c2 = scriptedProvider(TOOL_SCRIPT);
  const shapeC = await runToolLoop(baseOptions({
    provider: c2,
    budgetTokens: 8,
    run: { runId: "issue-547-c", resume: true },
    store,
  }));
  assert.ok(savedStates > 0, "(c) 前提：第一跑必须真的落过 run-state");
  assert.ok(loadedStates > 0, "(c) 前提：第二跑必须真的读过 run-state（走的是 loadRunState）");
  assert.equal(shapeC.termination.reason, "end_turn");
  assert.deepEqual(providerSiteChannels(shapeC), [], "(c) run-state 复用不许在请求视图那一处消费通道名");

  // (d) 快照续跑：loadLatestRunSnapshot 被真的调用、且真的拿到了快照。
  const snapshotStore = createMemoryTranscriptStore();
  let snapshotLoads = 0;
  let snapshotsPresent = 0;
  const realLoadSnapshot = snapshotStore.loadLatestRunSnapshot.bind(snapshotStore);
  snapshotStore.loadLatestRunSnapshot = async (runId) => {
    snapshotLoads += 1;
    const value = await realLoadSnapshot(runId);
    if (value !== undefined) snapshotsPresent += 1;
    return value;
  };
  const d1 = scriptedProvider(TOOL_SCRIPT);
  await runToolLoop(baseOptions({
    provider: d1, budgetTokens: 8, run: { runId: "issue-547-d" }, messages: seededHistory(), store: snapshotStore,
  }));
  const d2 = scriptedProvider(TOOL_SCRIPT);
  const shapeD = await runToolLoop(baseOptions({
    provider: d2, budgetTokens: 8, run: { runId: "issue-547-d", resume: true }, store: snapshotStore,
  }));
  assert.ok(snapshotLoads > 0, "(d) 前提：续跑必须真的调用 loadLatestRunSnapshot");
  assert.ok(snapshotsPresent > 0, "(d) 前提：续跑必须真的拿到快照（否则这一格测的是空快照路径）");
  assert.equal(shapeD.termination.reason, "end_turn");
  assert.deepEqual(providerSiteChannels(shapeD), [], "(d) 快照续跑不许在请求视图那一处消费通道名");
});

// ─────────────────────────────────────────────── T2/T3 第五条形状：#548 之后不再消费通道名

test("T2 #547+#548 第五条形状（低预算 run-state 注入 × 尾部悬空 tool_use）不再消费请求视图通道名", async () => {
  // 生产者形状：maxRounds 3 ⇒ 首轮 remainingRounds=2 ⇒ 低预算 ⇒ requestStateBlock 非空；
  // provider 把 max_tokens 截断在 tool_use 上 ⇒ 续写调用 allowPendingToolUse: true。
  // #548 之前：追加把这条合法视图弄成 `[…, assistant(tool_use), user(run-state)]` ⇒ 配对断裂
  // ⇒ 守卫 `preserved_latest_user_turn` ⇒ 通道名 chat 被消费、视图压成 count=1。
  // #548 之后：追加侧先看尾部（悬空 ⇒ 跳过）⇒ 视图原样合法 ⇒ 守卫原样放行、不记账。
  const provider = truncatingProvider();
  const result = await runToolLoop(baseOptions({
    provider,
    budgetTokens: 400000,
    maxRounds: 3,
    stream: false,
    messages: seededHistory(),
  }));

  assert.equal(result.termination.reason, "continuation_exhausted", "前提：必须真的走进续写循环");
  // ① 守卫在请求视图那一处一次都不记账（#547 时这里 >0，且通道名逐字是 chat）。
  assert.deepEqual(guardStats(result), [],
    "#548 之后这条形状不再触发守卫：悬空 tool_use 不是「视图缺 user 轮」，追加跳过就无需回补");
  assert.deepEqual(providerSiteChannels(result), [], "请求视图那一处的通道名现在没有生产者");
  // ② 守卫不再「作用在请求视图上」：视图一条都没有被压成「只剩最新 user 轮」。
  assert.deepEqual(
    provider.views.filter((view) => view.count <= 1),
    [],
    `续写请求视图必须保住整段上下文（#548 的缺陷现场是 count=1），实际 ${JSON.stringify(provider.views)}`,
  );
  assert.ok(provider.views.every((view) => view.count >= 5),
    `每次请求视图都必须保住种子历史的 5 条，实际 ${JSON.stringify(provider.views)}`);
  // ③ 形状确实还是那条形状：续写请求的尾巴仍是那条悬空的 assistant（不是被摘掉/补 user）。
  assert.ok(
    provider.views.some((view) => view.count >= 5 && view.users >= 1),
    "前提：请求视图仍然是「悬空 tool_use 结尾」的形状，而不是被换成了别的形状",
  );
});

test("T3 #547+#548 同一条形状在 stream: true 下同样不消费通道名，且记账分支仍然在（不许顺手删）", async () => {
  const provider = truncatingProvider();
  const result = await runToolLoop(baseOptions({
    provider,
    budgetTokens: 400000,
    maxRounds: 3,
    stream: true,
    messages: seededHistory(),
  }));

  assert.equal(result.termination.reason, "continuation_exhausted");
  assert.deepEqual(guardStats(result), [], "stream: true 下这条形状同样不触发守卫");
  assert.deepEqual(providerSiteChannels(result), [],
    "通道名没有生产者：`chatStream` 这一支在行为面上取不到（但也不许删，见下面的结构判据）");
  assert.ok(provider.views.every((view) => view.count >= 5),
    `每次请求视图都必须保住种子历史的 5 条，实际 ${JSON.stringify(provider.views)}`);

  // 记账分支本身**不许消失**（#547 的规矩：删不删通道名是单独的决定，不是删生产者的副作用）。
  // 行为面的记账能力由 `test/loop-request-user-invariant.test.js` T5 直接钉 `ensureUserTurnView`；
  // 这里只钉「请求视图那一处的接线还在」：记账调用 + 两个通道名字面值 + 派生值同源。
  const runner = readFileSync(new URL("../src/loop/provider-runner.js", import.meta.url), "utf8");
  assert.ok(runner.includes("ctx.recordUserTurnGuard?.("), "记账调用必须还在");
  assert.ok(runner.includes("channel: streaming ? \"chatStream\" : \"chat\""),
    "通道名必须仍由派生值 streamsThisRun 给出（#538 的契约）");
  assert.ok(runner.includes("ensureUserTurnView(requestMessages, ctx.messages, userTurnGuard)"),
    "守卫仍作用在请求视图定稿处");
});

// ─────────────────────────────────────────────── T4 因果对照

test("T4 #547 对照：同一截断 provider、去掉低预算注入 ⇒ 守卫一次都不记账", async () => {
  // maxRounds 6 ⇒ 首轮 remainingRounds=5 ⇒ 不是低预算 ⇒ requestStateBlock 恒为 undefined；
  // 尾部悬空 tool_use 在 allowPendingToolUse: true 下本来就合法 ⇒ 守卫原样放行。
  const provider = truncatingProvider();
  const result = await runToolLoop(baseOptions({
    provider,
    budgetTokens: 400000,
    maxRounds: 6,
    messages: seededHistory(),
  }));

  assert.equal(result.termination.reason, "continuation_exhausted", "前提：续写循环照旧被走到");
  assert.ok(
    provider.views.some((view) => view.count >= 5),
    "前提：视图没有被守卫压成一条（对照档的视图保持完整）",
  );
  assert.deepEqual(guardStats(result), [], "没有 run-state 注入 ⇒ 请求视图守卫不该记账");
  assert.deepEqual(providerSiteChannels(result), []);
});
