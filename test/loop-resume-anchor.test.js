// issue #425：**恢复锚点必须在恢复时现算**。
//
// 旧口径读快照里的 `persistedTranscriptLength`——它是 partialPersistence 定时器写快照那一刻的
// 采样。`stream: true` + `partialPersistence` 的现场里，定时器在流式正文还没成型时写快照（锚点
// 只到 seed），之后终稿 assistant 行继续落盘 ⇒ 恢复时锚点比账本少 1，`slice(0, anchor)` 把
// 已经落盘的终稿当成「崩溃之后宿主追加的」尾队列，而快照里那份 `partialText` 又是同一段正文
// ⇒ **终稿正文喂给模型两遍**（provider 上下文 4 条 vs 应有 3 条）。
//
// 三格：
//   ① 纯函数：账本行 → 锚点（尾部宿主行不计、分片算一条、老账本原样算）；
//   ② 回归：`stream: true` + `partialPersistence` 现场恢复后终稿正文只出现一次（先红后绿）；
//   ③ 反向证：现算值人为少 1 ⇒ 崩溃现场的 tool_use/tool_result 配对断裂 ⇒
//      `invalid_messages` + **零请求**（锚点偏移的方向敏感）。
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { countResumeAnchor } from "../src/loop/resume-manager.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const text = (value) => ({ type: "text", text: value });
const userText = (value) => ({ role: "user", content: [text(value)] });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: {} });
const toolResult = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `out-${id}` }] });
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];

/** provider 请求里所有 text 块的正文（用于数「同一段正文出现了几次」）。 */
function requestTexts(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""));
}

/**
 * 流式假 provider：分三段吐 delta（每段之间让出事件循环，partialPersistence 的定时器才有机会
 * 落快照），然后在返回前**等最后一份 partial 快照带上完整正文**——否则最后一份快照可能停在
 * 前缀上，这一格的前提（陈旧锚点 + 终稿正文已在快照里）就不成立。零 LLM 成本。
 */
function streamingProvider({ bodies, store, runId, waitForPartial = false }) {
  const requests = [];
  let index = 0;
  return {
    requests,
    protocol: "fake",
    model: "fake-model",
    async chatStream(request) {
      requests.push({ messages: request.messages });
      const body = bodies[index] ?? "done";
      index += 1;
      for (const piece of [body.slice(0, 4), body.slice(4, 8), body.slice(8)]) {
        request.onDelta?.(piece);
        await sleep(20);
      }
      if (waitForPartial) {
        const deadline = Date.now() + 2000;
        for (;;) {
          const snapshot = await store.loadLatestRunSnapshot(runId);
          if (snapshot?.partialText === body) break;
          assert.ok(Date.now() < deadline, "partialPersistence 定时器必须在超时前落下完整半截正文");
          await sleep(5);
        }
      }
      return { content: [text(body)], stopReason: "end_turn" };
    },
  };
}

// ── ① 纯函数：账本行 → 锚点 ────────────────────────────────────────────────────────
test("#425 countResumeAnchor：引擎行折出的逻辑消息条数（分片算一条、尾部宿主行不算）", () => {
  const engineRows = [
    { round: 0, dedupKey: "r:engine:round:0:seed", messages: [userText("任务")] },
    { round: 1, dedupKey: "r:engine:round:1" },
    { round: 1, dedupKey: "r:msg:1:0", kind: "message", seq: 0, messages: [{ role: "assistant", content: [text("开工"), toolUse("t1")] }] },
    { round: 1, dedupKey: "r:msg:1:1", kind: "message", seq: 1, messages: [toolResult("t1")] },
    { round: 1, dedupKey: "r:msg:1:2", kind: "message", seq: 2, partOf: "r:msg:1:1", messages: [toolResult("t2")] },
  ];
  assert.equal(countResumeAnchor(engineRows), 3,
    "seed + assistant + 一条聚合 user（两个 tool_result 分片接回同一条消息）");

  const hostTail = { round: 1, dedupKey: "r:input:follow-up", roundKey: "r:input:follow-up", messages: [userText("追问")] };
  assert.equal(countResumeAnchor([...engineRows, hostTail]), 3,
    "尾部宿主追问行（appendUserTurn 的 :input:）属于尾队列，不算进崩溃现场");

  // 上一次恢复留下的追问行夹在中间：它已经在模型的上下文里了，必须计入（只数引擎行会把它漏掉，
  // 按条数切片就会切错位置）。
  const interleaved = [
    engineRows[0],
    hostTail,
    { round: 1, dedupKey: "r:engine:round:1:resume", messages: [userText("方向提示")] },
    engineRows[2],
  ];
  assert.equal(countResumeAnchor(interleaved), 4, "中间夹着的宿主行计入：seed + 追问 + 提示 + assistant");

  assert.equal(countResumeAnchor([
    { round: 0, messages: [userText("任务")] },
    { round: 1, messages: [{ role: "assistant", content: [text("答复")] }] },
  ]), 2, "老账本（轮行自带正文、没有身份键）照常算");

  assert.equal(countResumeAnchor([...engineRows, {
    round: 1,
    dedupKey: "r:engine:round:1:fold:abc123",
    messages: [],
  }]), 3, "引擎事实行（messages: []）加 0");

  assert.equal(countResumeAnchor([]), 0);
  assert.equal(countResumeAnchor(undefined), 0);
});

// ── ② 回归：stream + partialPersistence 的现场，恢复后终稿正文只出现一次 ─────────────
test("#425 stream + partialPersistence：恢复后终稿正文只出现一次（应有 3 条，不是 4 条）", async () => {
  const RUN_ID = "anchor-stream-partial";
  const BODY = "第一段正文，这是终稿内容。";
  const inner = createMemoryTranscriptStore();
  const firstProvider = streamingProvider({
    bodies: [BODY],
    store: inner,
    runId: RUN_ID,
    waitForPartial: true,
  });

  await runToolLoop({
    provider: firstProvider,
    store: inner,
    runId: RUN_ID,
    stream: true,
    partialPersistence: { intervalMs: 1, minBytes: 0 },
    initialUserMessage: "任务",
    maxRounds: 4,
    completion: false,
    wrapup: false,
    stallDetection: false,
    executeTool: async () => "unused",
  });

  // 前提（这一格测的是不是「陈旧锚点」现场）：快照里锚点只到 seed，账本已经多出终稿正文。
  const snapshot = await inner.loadLatestRunSnapshot(RUN_ID);
  const ledger = foldLedgerMessages(await inner.load(RUN_ID));
  assert.equal(snapshot?.partialText, BODY, "前提：最后一份 partial 快照带着完整终稿正文");
  assert.equal(snapshot?.persistedTranscriptLength, 1, "前提：快照锚点是正文落盘之前的采样");
  assert.equal(ledger.length, 2, "前提：账本里已有 seed + 终稿 assistant");

  const resumedProvider = streamingProvider({ bodies: ["追问的答复"], store: inner, runId: RUN_ID });
  await runToolLoop({
    provider: resumedProvider,
    resume: true,
    stream: true,
    store: inner,
    runId: RUN_ID,
    maxRounds: 4,
    completion: false,
    wrapup: false,
    stallDetection: false,
    executeTool: async () => "unused",
  });

  const context = resumedProvider.requests[0].messages;
  const bodyHits = context.flatMap(requestTexts).filter((value) => value === BODY).length;
  assert.equal(bodyHits, 1, `终稿正文在 provider 上下文里必须只出现一次，实际出现 ${bodyHits} 次`);
  assert.equal(context.length, 3, "上下文 = seed + 终稿 assistant + 恢复告示（3 条，不是 4 条）");
});

// ── ③ 反向证：现算锚点少 1 ⇒ invalid_messages + 零请求 ──────────────────────────────
test("#425 反向证：现算锚点人为少 1 ⇒ 配对断裂，invalid_messages 且零请求（方向敏感）", async () => {
  const RUN_ID = "anchor-minus-one";
  const engineRows = [
    { round: 0, dedupKey: `${RUN_ID}:engine:round:0:seed`, messages: [userText("任务")] },
    { round: 1, dedupKey: `${RUN_ID}:engine:round:1` },
    {
      round: 1,
      dedupKey: `${RUN_ID}:msg:1:0`,
      kind: "message",
      seq: 0,
      messages: [{ role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
    },
    { round: 1, dedupKey: `${RUN_ID}:msg:1:1`, kind: "message", seq: 1, messages: [toolResult("t1")] },
  ];
  // 「现算值人为减 1」：把最后那条引擎消息行改写成宿主追问行（`appendUserTurn` 的命名空间）
  // ⇒ 尾部宿主行不计入锚点 ⇒ 现算值恰好少 1（下面断言这个差值）。
  const shrunkRows = engineRows.map((row) => (row.dedupKey === `${RUN_ID}:msg:1:1`
    ? {
      round: row.round,
      dedupKey: `${RUN_ID}:input:anchor-minus-one`,
      roundKey: `${RUN_ID}:input:anchor-minus-one`,
      messages: row.messages,
    }
    : row));

  const freshAnchor = countResumeAnchor(engineRows);
  assert.equal(freshAnchor, 3, "对照：现算锚点 = seed + assistant + t1 结果");
  assert.equal(countResumeAnchor(shrunkRows), freshAnchor - 1, "反向现场：现算锚点恰好少 1");

  const buildStore = async (rows) => {
    const store = createMemoryTranscriptStore();
    for (const row of rows) await store.appendRound(RUN_ID, row);
    // 快照写「新鲜」锚点：这样失败只可能来自**现算**值，快照不能背锅。
    await store.saveRunSnapshot(RUN_ID, {
      round: 1,
      messages: [userText("任务"), { role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
      persistedTranscriptLength: freshAnchor,
      executedToolIds: [],
      pendingToolUses: [toolUse("t2")],
      toolResults: [],
      toolOutputs: [],
      compactionStats: [],
      ts: new Date().toISOString(),
    });
    return store;
  };

  // 对照（锚点不少）：同一份现场恢复成功，t2 的补跑结果接回 t1 那条聚合消息。
  const healthyStore = await buildStore(engineRows);
  const healthyProvider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
  const healthy = await runToolLoop({
    provider: healthyProvider,
    resume: true,
    store: healthyStore,
    runId: RUN_ID,
    tools: TOOLS,
    maxRounds: 8,
    completion: false,
    wrapup: false,
    stallDetection: false,
    executeTool: async ({ id }) => `replayed-${id}`,
  });
  assert.equal(healthyProvider.requests.length, 1, "对照：锚点正确时恰好一次请求");
  assert.equal(healthy.finalText, "done");

  // 反向：现算锚点少 1 ⇒ t1 结果落进尾队列，t2 的补跑结果另起一条 user 消息
  // ⇒ assistant 的 tool_use [t1,t2] 后面紧跟的 user 只有 [t2] ⇒ 本地校验器在任何请求之前拒绝。
  const brokenStore = await buildStore(shrunkRows);
  const brokenProvider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
  await assert.rejects(
    runToolLoop({
      provider: brokenProvider,
      resume: true,
      store: brokenStore,
      runId: RUN_ID,
      tools: TOOLS,
      maxRounds: 8,
      completion: false,
      wrapup: false,
      stallDetection: false,
      executeTool: async ({ id }) => `replayed-${id}`,
    }),
    (error) => {
      assert.equal(error?.code, "invalid_messages");
      assert.match(String(error?.message), /tool_result ids do not match assistant tool_use ids/u);
      return true;
    },
  );
  assert.equal(brokenProvider.requests.length, 0, "锚点偏移一格 = 零请求（本地校验器先拒）");
});

// ── ④ 恢复**不消费**快照里的锚点：把它写成 0 / 超大，上下文必须一模一样 ─────────────────
test("#425 恢复不读快照锚点：写成 0（旧口径下必然 invalid_messages）或超大都不改变上下文", async () => {
  const RUN_ID = "anchor-ignored";
  const engineRows = [
    { round: 0, dedupKey: `${RUN_ID}:engine:round:0:seed`, messages: [userText("任务")] },
    { round: 1, dedupKey: `${RUN_ID}:engine:round:1` },
    {
      round: 1,
      dedupKey: `${RUN_ID}:msg:1:0`,
      kind: "message",
      seq: 0,
      messages: [{ role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
    },
    { round: 1, dedupKey: `${RUN_ID}:msg:1:1`, kind: "message", seq: 1, messages: [toolResult("t1")] },
  ];
  const runOnce = async (snapshotAnchor) => {
    const store = createMemoryTranscriptStore();
    for (const row of engineRows) await store.appendRound(RUN_ID, row);
    await store.saveRunSnapshot(RUN_ID, {
      round: 1,
      messages: [userText("任务"), { role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
      persistedTranscriptLength: snapshotAnchor,
      executedToolIds: [],
      pendingToolUses: [toolUse("t2")],
      toolResults: [],
      toolOutputs: [],
      compactionStats: [],
      ts: new Date().toISOString(),
    });
    const provider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
    await runToolLoop({
      provider,
      resume: true,
      store,
      runId: RUN_ID,
      tools: TOOLS,
      maxRounds: 8,
      completion: false,
      wrapup: false,
      stallDetection: false,
      executeTool: async ({ id }) => `replayed-${id}`,
    });
    return provider.requests[0].messages;
  };

  // `toolCallKey` 是每次执行现场分配的身份（不参与语义），比较前投影掉。
  const shapeOf = (messages) => messages.map((message) => ({
    role: message.role,
    blocks: (Array.isArray(message.content) ? message.content : []).map((block) => (
      block?.type === "tool_result"
        ? `result:${block.tool_use_id}`
        : block?.type === "tool_use"
          ? `use:${block.id}`
          : `text:${String(block?.text ?? "")}`
    )),
  }));

  const fresh = await runOnce(3); // 3 = 现算值（= 账本条数）
  const zero = await runOnce(0);  // 旧口径：slice(0, 0) ⇒ 全部正文进尾队列 ⇒ 配对断裂
  const oversized = await runOnce(99); // 写侧多算的形态：旧口径靠 Math.min 夹到账本条数
  assert.deepEqual(shapeOf(zero), shapeOf(fresh), "快照锚点 0 不得改变恢复上下文（恢复只认现算值）");
  assert.deepEqual(shapeOf(oversized), shapeOf(fresh), "快照锚点超大不得改变恢复上下文（恢复只认现算值）");
});
