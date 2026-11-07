// @ts-check
// issue #753 C1（引擎面）：宿主的**轮边界注入口** `capabilities.hooks.nextUserTurn`。
//
// 判据（逐格对应契约 `.steer-753-contract.md` 的验收清单，不抄摘要）：
//   T1 注入的那条落进**下一轮的轮记录**：`store.load()` 读得到正文，形状是带 `seq` 的
//      `kind:"message"` 行，**不是** `…:control:` 行（后者是「轮记录落盘之后才产生的引擎文本」的待遇）；
//   T2 返回 `null` ⇒ **逐字零行为变化**：不传钩子与传了返回 null 的两个 run，账本与事件序列全等；
//   T3/T4 抛错 / 返回非字符串 ⇒ 走 `reportObserverError(..., { channel: "nextUserTurn" })`、
//      计入 `diagnostics.steer.rejected`，**终局 reason 与不传钩子的基线逐字相同**（口径同 finalGuard 失败）；
//   T5 `host_steer_injected` 的 `round` 与真实轮号对得上（同轮的 `round_start` / `round_end` 为锚）；
//   T6 #626 C3 从没验过的那格：注入的那条在 **resume 后仍读得到且不重复入账**（同 dedupKey 幂等）；
//   T7 折叠发生之后，注入的那条**仍在请求视图里**（它是真用户轮，#292 的不变量替我们担保）；
//   T8 `diagnostics.steer = { offered, injected, rejected, lastRound }`；不传钩子 ⇒ 整个键缺席；
//   T9 注入的那条**不是本轮的输出**：不在 `messages.slice(roundStart)` 那一段里（反向证明盯的就是这条，
//      把注入点挪到 `roundStart` 之后本格必须变红）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const tools = [{ name: "work", replay: "unsafe", inputSchema: { type: "object" } }];
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });
const toolTurn = (id) => ({ content: [toolUse(id)], stopReason: "tool_use" });

const baseOptions = {
  tools,
  completion: false,
  wrapup: false,
  stallDetection: false,
  reflection: false,
  executeTool: async () => "ok",
};

const messagesOf = (records) => records.flatMap((record) => record.messages ?? []);
const hasMarker = (message, needle) => (
  Array.isArray(message?.content)
  && message.content.some((block) => block?.type === "text" && String(block.text ?? "").includes(needle))
);
const countIn = (messages, needle) => messages.filter((message) => hasMarker(message, needle)).length;
/** 账本里带正文的原始行（`kind:"message"` + `seq`）；`…:control:` 行没有 `seq`，两者必须能分开。 */
const messageRowsOf = (records) => records.filter((row) => row.kind === "message");
/** 事件序列的可比形态：只留 `type` 与 `round`（其余载荷两个 run 之间本来就该同形，比的是全量 JSON）。 */
const eventShape = (events) => events.map((event) => ({
  type: event?.type,
  ...(event?.round === undefined ? {} : { round: event.round }),
}));
/** 账本的可比形态：把**非行为性**的字段归一（每个 run 必然不同的时钟 `ts`、随机 `toolCallKey`，
 * 以及受时钟粒度摆动的 `durationMs`），其余逐字留——这三个之外的任何差异都是行为差异。 */
const ledgerShape = (rows) => JSON.parse(JSON.stringify(rows)
  .replace(/"ts":"[^"]*"/g, String.raw`"ts":"<ts>"`)
  .replace(/"toolCallKey":"[^"]*"/g, String.raw`"toolCallKey":"<key>"`)
  .replace(/"durationMs":-?\d+/g, String.raw`"durationMs":0`));

// ── T1：注入的那条落进下一轮的轮记录（行形状是判据）────────────────────────────────
test("#753-C1 注入的那条落进下一轮的轮记录：带 seq 的 kind:\"message\" 行，不是 :control: 行", async () => {
  const marker = "STEER_753_T1_换个方向";
  const runId = "753-t1";
  const store = createMemoryTranscriptStore();
  const events = [];
  const provider = createFakeProvider([toolTurn("t1"), endTurn("收尾终稿")]);
  /** @type {any[]} */
  const calls = [];
  const result = await runDirect({
    ...baseOptions,
    maxRounds: 2,
    store,
    runId,
    initialUserMessage: "local task",
    provider,
    capabilities: {
      hooks: {
        nextUserTurn: (/** @type {any} */ payload) => {
          calls.push(payload);
          return payload.round === 2 ? marker : null;
        },
      },
    },
    onEvent: (/** @type {any} */ event) => events.push(event),
  });

  // 钩子被调到的次数 = 进圈的轮数；payload 四格齐（runId / round / rounds / usage）。
  assert.deepEqual(calls.map((call) => call.round), [1, 2], "每轮至多调用一次，轮号递增");
  assert.equal(calls[0].runId, runId);
  assert.equal(typeof calls[1].rounds, "number");
  assert.equal(typeof calls[1].usage?.input_tokens + typeof calls[1].usage?.output_tokens, "numbernumber");

  // 模型真看见了：第 2 轮的请求里有，第 1 轮的请求里没有。
  assert.equal(countIn(provider.requests[0].messages, marker), 0);
  assert.equal(countIn(provider.requests[1].messages, marker), 1, "注入的那条必须进下一轮的请求");

  // 注入的那条是真用户轮（不是引擎控制文本）：role user + meta.source host-steer。
  const injected = result.messages.filter((/** @type {any} */ message) => hasMarker(message, marker));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].role, "user");
  assert.equal(injected[0].meta?.source, "host-steer");

  // 原始行面（`loadRawRows` = `load()` 的未折叠输入）：形状必须是带 `seq` 的 `kind:"message"` 行。
  const rawRows = await store.loadRawRows(runId);
  const steerRows = rawRows.filter((row) => countIn(row.messages ?? [], marker) > 0);
  assert.equal(steerRows.length, 1, `账本里必须恰有一条携带正文的行（实测 ${JSON.stringify(rawRows.map((row) => row.dedupKey))}）`);
  const steerRow = steerRows[0];
  assert.equal(steerRow.kind, "message", "必须是 kind:\"message\" 行");
  assert.equal(typeof steerRow.seq, "number", "必须带 seq（折叠层的两把钥匙之一）");
  assert.equal(steerRow.round, 2, "必须挂在第 2 轮（= 宿主那句话落进下一轮的账）");
  assert.equal(steerRow.dedupKey, `${runId}:msg:2:${steerRow.seq}`);
  assert.equal(steerRow.dedupKey.includes(":control:"), false, "不得走 :control: 那条通道");
  assert.equal(steerRow.dedupKey.includes("engine:round"), false);

  // 折叠面（宿主读的 `store.load()`）：第 2 轮的轮记录里读得到正文，第 1 轮的记录里没有。
  const records = await store.load(runId);
  const byRound = new Map(records.filter((row) => typeof row.round === "number")
    .map((row) => [row.round, row]));
  assert.equal(countIn(byRound.get(2)?.messages ?? [], marker), 1, "折叠后的轮记录必须读得到正文");
  assert.equal(countIn(byRound.get(1)?.messages ?? [], marker), 0);
});

// ── T2：返回 null = 逐字零行为变化（账本 + 事件序列全等）────────────────────────────
test("#753-C1 返回 null 与不传钩子的 run：账本与事件序列逐字一致", async () => {
  const scriptFor = () => [toolTurn("a"), endTurn("收尾终稿"), toolTurn("b"), endTurn("又一次收尾")];

  const plainStore = createMemoryTranscriptStore();
  /** @type {any[]} */
  const plainEvents = [];
  const plain = await runDirect({
    ...baseOptions,
    maxRounds: 3,
    store: plainStore,
    runId: "753-zero",
    initialUserMessage: "local task",
    provider: createFakeProvider(scriptFor()),
    onEvent: (/** @type {any} */ event) => plainEvents.push(event),
  });

  const hookedStore = createMemoryTranscriptStore();
  /** @type {any[]} */
  const hookedEvents = [];
  const hooked = await runDirect({
    ...baseOptions,
    maxRounds: 3,
    store: hookedStore,
    runId: "753-zero",
    initialUserMessage: "local task",
    provider: createFakeProvider(scriptFor()),
    capabilities: { hooks: { nextUserTurn: () => null } },
    onEvent: (/** @type {any} */ event) => hookedEvents.push(event),
  });

  // 两个 run 用同一个 runId 写进各自的内存 store ⇒ 账本可以**逐字**比（dedupKey 里的 runId 同形）。
  assert.deepEqual(ledgerShape(await hookedStore.load("753-zero")), ledgerShape(await plainStore.load("753-zero")),
    "不传钩子与传了返回 null 的账本必须逐字相同（已剥 ts）");
  assert.deepEqual(eventShape(hookedEvents), eventShape(plainEvents), "事件序列必须一致");
  assert.equal(hookedEvents.some((event) => event?.type === "host_steer_injected"), false);
  assert.deepEqual(hooked.termination, plain.termination);
  // 计数面的差别：不传钩子 ⇒ 整个 `diagnostics` 键缺席；传了钩子 ⇒ 四个计数恒在且全零。
  assert.equal("diagnostics" in plain, false, "不传钩子连结果对象的形状都不许变");
  assert.deepEqual(hooked.diagnostics.steer, {
    offered: plain.rounds, injected: 0, rejected: 0, lastRound: null,
  });
});

// ── T3 / T4：抛错与返回非字符串都不改终局，只计数 + 走观察者错误通道 ──────────────────
for (const [label, hook] of /** @type {const} */ ([
  ["抛错", () => { throw new Error("steer boom"); }],
  ["返回非字符串", () => 42],
])) {
  test(`#753-C1 ${label}：不改终局、计入 diagnostics.steer.rejected、channel 为 nextUserTurn`, async () => {
    const runId = `753-bad-${label === "抛错" ? "throw" : "type"}`;

    const baselineStore = createMemoryTranscriptStore();
    const baseline = await runDirect({
      ...baseOptions,
      maxRounds: 2,
      store: baselineStore,
      runId,
      initialUserMessage: "local task",
      provider: createFakeProvider([toolTurn("a"), endTurn("收尾终稿")]),
    });

    const store = createMemoryTranscriptStore();
    /** @type {any[]} */
    const observerErrors = [];
    /** @type {any[]} */
    const events = [];
    const result = await runDirect({
      ...baseOptions,
      maxRounds: 2,
      store,
      runId,
      initialUserMessage: "local task",
      provider: createFakeProvider([toolTurn("a"), endTurn("收尾终稿")]),
      capabilities: { hooks: { nextUserTurn: hook } },
      onObserverError: (/** @type {any} */ error, /** @type {any} */ detail) => {
        observerErrors.push({ error, detail });
      },
      onEvent: (/** @type {any} */ event) => events.push(event),
    });

    // 终局一字未动：reason / detail / 轮数与基线同形（降级不致命，口径同 finalGuard 失败）。
    assert.deepEqual(result.termination, baseline.termination);
    assert.equal(result.rounds, baseline.rounds);
    assert.equal(observerErrors.length, 2, "每轮各记一笔");
    assert.deepEqual([...new Set(observerErrors.map((entry) => entry.detail.channel))], ["nextUserTurn"]);
    assert.deepEqual([...new Set(observerErrors.map((entry) => entry.detail.runId))], [runId]);
    assert.equal(events.some((event) => event?.type === "host_steer_injected"), false, "没注入就不发事件");
    // 两个 run 用同一个 runId 各写一个内存 store ⇒ 账本可以逐字比。
    assert.deepEqual(ledgerShape(await store.load(runId)), ledgerShape(await baselineStore.load(runId)),
      "账本与基线逐字同形（已剥 ts）：钩子坏了不留下任何账本痕迹");
    assert.deepEqual(result.diagnostics.steer, {
      offered: baseline.rounds, injected: 0, rejected: baseline.rounds, lastRound: null,
    });
  });
}

// ── T5：事件的 round 与真实轮号对得上 ──────────────────────────────────────────────
test("#753-C1 host_steer_injected 的 round 就是真实轮号（同轮 round_start / round_end 为锚）", async () => {
  const marker = "STEER_753_T5";
  const store = createMemoryTranscriptStore();
  /** @type {any[]} */
  const events = [];
  const provider = createFakeProvider([
    toolTurn("a"), toolTurn("b"), endTurn("收尾终稿"),
  ]);
  await runDirect({
    ...baseOptions,
    maxRounds: 3,
    store,
    runId: "753-t5",
    initialUserMessage: "local task",
    provider,
    capabilities: {
      hooks: { nextUserTurn: (/** @type {any} */ payload) => (payload.round === 3 ? marker : undefined) },
    },
    onEvent: (/** @type {any} */ event) => events.push(event),
  });

  const injected = events.filter((event) => event?.type === "host_steer_injected");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].round, 3);
  assert.equal(injected[0].chars, marker.length);
  const roundStarts = events.filter((event) => event?.type === "round_start");
  const roundEnds = events.filter((event) => event?.type === "round_end");
  const index = events.indexOf(injected[0]);
  const start = events.findLastIndex((event, i) => event?.type === "round_start" && i < index);
  const end = events.findIndex((event, i) => event?.type === "round_end" && i > index);
  assert.ok(start >= 0 && end > index, "必须落在某轮的 round_start 与 round_end 之间");
  assert.equal(events[start].round, injected[0].round);
  assert.equal(events[end].round, injected[0].round);
  assert.equal(roundStarts.length, 3, "轮号连续，注入没有多烧一轮");
  // 注入的那条进了第 3 轮的请求，且第 3 轮才是终稿轮。
  assert.equal(countIn(provider.requests[2].messages, marker), 1);
  assert.equal(countIn(provider.requests[1].messages, marker), 0);
});

// ── T6：#626 C3 从没验过的那格——resume 后仍读得到且不重复入账 ──────────────────────
test("#753-C1 resume 之后注入的那条仍读得到，且不重复入账（同 dedupKey 幂等）", async () => {
  const marker = "STEER_753_T6_重放我";
  const runId = "753-t6";
  const store = createMemoryTranscriptStore();
  // 宿主的收件箱是**取走即空**的（C2 的 FIFO 就是这个形状）：递过一次之后不再重复递。
  let pending = marker;
  const takeOnce = () => {
    const value = pending;
    pending = null;
    return value;
  };

  const first = await runDirect({
    ...baseOptions,
    maxRounds: 1,
    store,
    runId,
    initialUserMessage: "local task",
    provider: createFakeProvider([toolTurn("a"), endTurn("收尾终稿")]),
    capabilities: { hooks: { nextUserTurn: takeOnce } },
  });
  assert.equal(first.diagnostics.steer.injected, 1);
  assert.equal(pending, null, "钩子被调过 ⇒ 宿主那句话已被取走");
  const before = await store.load(runId);
  assert.equal(countIn(messagesOf(before), marker), 1);
  const steerRowBefore = (await store.loadRawRows(runId))
    .find((row) => countIn(row.messages ?? [], marker) > 0);

  // 续跑：钩子这一次**没话可说**（宿主已经递过了），账本不得因此少那条也不多那条。
  const resumedProvider = createFakeProvider([toolTurn("b"), endTurn("续跑收尾")]);
  const resumed = await runDirect({
    ...baseOptions,
    maxRounds: 2,
    resume: true,
    store,
    runId,
    initialUserMessage: "local task",
    provider: resumedProvider,
    capabilities: { hooks: { nextUserTurn: () => null } },
  });

  const after = await store.load(runId);
  assert.equal(countIn(messagesOf(after), marker), 1,
    `resume 之后仍读得到且不重复入账（实测 ${JSON.stringify({
      before: before.map((row) => row.dedupKey), after: after.map((row) => row.dedupKey),
      steer: resumed.diagnostics.steer,
    })}）`);
  assert.equal(resumed.diagnostics.steer.injected, 0, "续跑这一趟钩子没递话 ⇒ 不多注入");
  const steerRowAfter = (await store.loadRawRows(runId))
    .filter((row) => countIn(row.messages ?? [], marker) > 0);
  assert.equal(steerRowAfter.length, 1);
  assert.deepEqual(steerRowAfter[0], steerRowBefore, "同一行、同一 dedupKey、同一 payload：resume 不重写它");
  assert.equal(steerRowAfter[0].kind, "message");
  assert.equal(typeof steerRowAfter[0].seq, "number");
  // 续跑真的看见了它：返回消息里有，续跑的第一发请求里也有。
  assert.equal(countIn(resumed.messages, marker), 1);
  assert.equal(countIn(resumedProvider.requests.at(-1).messages, marker), 1,
    "续跑的请求视图必须带着注入的那条（它是真用户轮，不是可丢的控制文本）");

  // 幂等那一半单独钉：同 dedupKey + 同 payload 再写一次 = 跳过。引擎的 `(round, seq)` 键就建在
  // 这条 store 契约上 ⇒ 同轮重放天然不产生第二行（宿主改大轮预算重跑同一轮就是这一格）。
  const replay = createMemoryTranscriptStore();
  await replay.appendRound(runId, steerRowAfter[0]);
  await replay.appendRound(runId, steerRowAfter[0]);
  assert.equal(
    (await replay.loadRawRows(runId)).filter((row) => countIn(row.messages ?? [], marker) > 0).length,
    1,
    "同 dedupKey 幂等：重放不产生第二行",
  );
});

// ── T7：折叠之后仍在请求视图里（真用户轮的待遇，#292）──────────────────────────────
// 现测形状（本文件跑出来的）：`sliding-window` 把**当前最新的真用户轮**留在请求视图里，更早的那条
// 会随窗口推走；宿主想钉住它是既有 `capabilities.hooks.protectedMessage` 的口径。两格都跑：
//   T7a 折叠已发生、注入的那条就是最新真用户轮 ⇒ 必须在；
//   T7b 同一句话改在早期轮注入（本会被窗口推走）+ 宿主用 `protectedMessage` 认领 ⇒ 也必须在。
for (const [label, injectRound, protect] of [
  ["最新轮注入", 4, false],
  ["早期轮注入加宿主认领", 2, true],
]) {
  test(`#753-C1 折叠发生之后，注入的那条仍在请求视图里（${label}）`, async () => {
    const marker = `STEER_753_T7_${label}`;
    const filler = "很长的一段工具输出用于把请求顶过折叠预算。".repeat(40);
    /** @type {any[]} */
    const events = [];
    const provider = createFakeProvider([
      toolTurn("a"), toolTurn("b"), toolTurn("c"), endTurn("收尾终稿"),
    ]);
    const result = await runDirect({
      ...baseOptions,
      maxRounds: 4,
      store: createMemoryTranscriptStore(),
      runId: `753-t7-${String(injectRound)}`,
      initialUserMessage: "local task",
      provider,
      executeTool: async () => filler,
      config: { folding: { context: { budgetTokens: 200, strategy: "sliding-window" } } },
      capabilities: {
        hooks: {
          nextUserTurn: (/** @type {any} */ payload) => (payload.round === injectRound ? marker : null),
          ...(protect
            ? {
              protectedMessage: (/** @type {any} */ message) => message?.meta?.source === "host-steer",
            }
            : {}),
        },
      },
      onEvent: (/** @type {any} */ event) => events.push(event),
    });

    // 前置：这一趟真折过（否则「折叠后仍在」是空断言）。
    assert.equal(result.compactionStats.some((stat) => stat?.compacted === true), true,
      `必须真的发生折叠（实测 ${JSON.stringify(result.compactionStats.map((stat) => stat?.compacted))}）`);
    assert.equal(result.diagnostics.steer.injected, 1);
    assert.equal(countIn(provider.requests.at(-1).messages, marker), 1,
      "折叠之后的最后一发请求里必须还读得到注入的那条");
    assert.equal(events.some((event) => event?.type === "user_turn_guard_unrecoverable"), false,
      "真用户轮不该触发不可恢复的用户轮守卫");
  });
}

// ── T8：diagnostics.steer 的四格计数 ───────────────────────────────────────────────
test("#753-C1 diagnostics.steer 计数：offered / injected / rejected / lastRound", async () => {
  const store = createMemoryTranscriptStore();
  let n = 0;
  const result = await runDirect({
    ...baseOptions,
    maxRounds: 3,
    store,
    runId: "753-t8",
    initialUserMessage: "local task",
    provider: createFakeProvider([
      toolTurn("a"), toolTurn("b"), endTurn("收尾终稿"),
    ]),
    capabilities: {
      hooks: {
        nextUserTurn: () => {
          n += 1;
          if (n === 1) return "STEER_753_T8_第一条";
          if (n === 2) throw new Error("boom");
          return null;
        },
      },
    },
    onObserverError: () => {},
  });
  assert.deepEqual(result.diagnostics.steer, {
    offered: 3, injected: 1, rejected: 1, lastRound: 1,
  });
});

// ── T9：注入的那条不是本轮的输出（反向证明钉的就是这一格）──────────────────────────
test("#753-C1 注入的那条不进本轮的输出窗口（roundStart 之后 ⇒ 本格必红）", async () => {
  const marker = "STEER_753_T9_反向证明";
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([toolTurn("a"), endTurn("收尾终稿")]);
  const result = await runDirect({
    ...baseOptions,
    maxRounds: 2,
    store,
    runId: "753-t9",
    initialUserMessage: "local task",
    provider,
    capabilities: {
      hooks: {
        nextUserTurn: (/** @type {any} */ payload) => (payload.round === 2 ? marker : null),
      },
    },
  });

  // 本轮的**输出**面：轮记录的 `response.content` / `textPreview` / `summary` / `l0facts` 都是从
  // `messages.slice(roundStart)` 那一段（本轮新产生的消息）里提的。注入点在 `roundStart` **之前**
  // ⇒ 宿主那句话不在那一段里 ⇒ 它不得出现在任何一轮的输出面上（它是输入）；而它自己那条
  // `seq` 消息行挂在被消费的那一轮 ⇒ 账本里读得到正文。**反向证明盯的就是这一对。**
  const records = await store.load("753-t9");
  const roundRecords = records.filter((row) => typeof row.round === "number");
  assert.ok(roundRecords.length >= 1, "至少有一条轮记录（否则下面是空断言）");
  for (const record of roundRecords) {
    const output = JSON.stringify({
      response: record.response,
      textPreview: record.textPreview,
      summary: record.summary,
      l0facts: record.l0facts,
    });
    assert.equal(output.includes(marker), false,
      `轮 ${String(record.round)} 的输出面里不得出现宿主递进来的那句话（它是输入，不是输出）`);
  }
  // 正文只在它自己那条消息行里（挂在被注入的那一轮），输出面与行是两个去处。
  const rawRows = await store.loadRawRows("753-t9");
  assert.equal(countIn(messagesOf(rawRows.filter((row) => row.kind === "message")), marker), 1);
  assert.equal(countIn(result.messages, marker), 1);
});

// ── T11. 位置即契约（反向证明的机械面）：注入点必须在「圈顶中止检查之后、轮切片之前」之间
test("T11 注入点的源码头：`await injectHostSteerTurn(round)` 在 `throwIfAborted(signal)` 之后、`const roundStart = messages.length` 之前", () => {
  // 为什么需要这一格：把调用挪到 `roundStart` 之后时，**行为面是等价的**（那两行之间没有任何读取者，
  // 实测 10 格全绿）——「注入必须落在轮边界」因此不能只靠行为测试钉，必须直接钉源码顺序。
  // 反向证明两层：① 把调用挪出这两行之间 ⇒ 本格红；② 把它挪进轮内（provider 调用之后）⇒ T1/T2/T5 行为红。
  const source = readFileSync(new URL("../src/loop/orchestrator.js", import.meta.url), "utf8");
  const call = source.indexOf("await injectHostSteerTurn(round);");
  assert.notEqual(call, -1, "注入调用必须还在主循环里");
  const abort = source.lastIndexOf("throwIfAborted(signal);", call);
  const roundStart = source.indexOf("const roundStart = messages.length;", call);
  assert.ok(abort !== -1 && abort < call, "注入点必须在圈顶中止检查之后（中止之后还要注入 = 已经决定不跑了还问宿主）");
  assert.ok(roundStart !== -1 && call < roundStart, "注入点必须在轮切片开窗之前（轮边界的另一半）");
});
