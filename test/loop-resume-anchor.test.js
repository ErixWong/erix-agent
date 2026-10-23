// issue #425：**恢复锚点必须在恢复时现算**。
//
// 旧口径读快照里的 `persistedTranscriptLength`——它是 partialPersistence 定时器写快照那一刻的
// 采样。`stream: true` + `partialPersistence` 的现场里，定时器在流式正文还没成型时写快照（锚点
// 只到 seed），之后终稿 assistant 行继续落盘 ⇒ 恢复时锚点比账本少 1，`slice(0, anchor)` 把
// 已经落盘的终稿当成「崩溃之后宿主追加的」尾队列，而快照里那份 `partialText` 又是同一段正文
// ⇒ **终稿正文喂给模型两遍**（provider 上下文 4 条 vs 应有 3 条）。
//
// 四格：
//   ① 纯函数：账本行 → 锚点（尾部宿主行不计、分片算一条、老账本原样算）；
//   ② 回归：`stream: true` + `partialPersistence` 现场恢复后终稿正文只出现一次（先红后绿）；
//   ③ 反向证：现算值人为少 1 ⇒ 崩溃现场的 tool_use/tool_result 配对断裂 ⇒
//      `invalid_messages` + **零请求**（锚点偏移的方向敏感）；
//   ④ 恢复**不消费**快照锚点：写成 0 / 超大都不改变上下文（写侧多算的残留也在这条里被中和）。
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

  // issue #425 评审阻塞（形状判据）的边界：**无键的远古种子行**与宿主预写行都是「单条 user/text」形状，
  // 区别只在**位置**——种子是账本第一行，追问是崩溃之后追加在末尾的。尾队列最多从第二行开始。
  assert.equal(countResumeAnchor([{ round: 0, messages: [userText("任务")] }]), 1,
    "无键种子行（账本第一行）仍在崩溃现场——形状判据不得把整个账本都当尾队列");
  assert.equal(countResumeAnchor([
    { round: 0, messages: [userText("任务")] },
    { round: 0, dedupKey: "r:round:0", roundKey: "r:round:0", messages: [userText("追问")] },
  ]), 1, "无键种子行之后的宿主预写行仍归尾队列（位置分开两者）");
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

// ── ⑤ 宿主预写行的**键形态**不得决定边界归属（issue #425 评审阻塞） ─────────────────────
//
// 评审实测的失效面：宿主用**引擎形态的键**（`<runId>:round:<n>`，契约自己叫它 "host default key"）
// 或**根本没有键**写追问行时，旧判别式（只认键的命名空间）把那行算进**崩溃现场** ⇒ 补跑结果被插到
// 它前面/后面错位 ⇒ `invalid_messages` + **零请求**；现场已落 1 条结果行时则是**静默改序**（宿主
// 追问排到【恢复运行】告示**之前**，与契约的形状相反）。
//
// 判据必须是「键认引擎 ⇒ 引擎；键不认引擎 ⇒ 看形状」，而不是「形状优先于键」：引擎自己写的
// `:engine:…:resume` / `:control:` 载体**也可能**是「单条 user/text」形状（评审造的那格 4==4），
// 先看形状就会把它们误判成宿主尾队列。

/** 崩溃现场：seed + 轮行 + 带 `tool_use [t1,t2]` 的 assistant 行（+ 可选已落盘的 t1 结果行）+ 尾行。 */
const crashScene = (RUN_ID, { tail, landedT1 = false } = {}) => [
  { round: 0, dedupKey: `${RUN_ID}:engine:round:0:seed`, messages: [userText("任务")] },
  { round: 1, dedupKey: `${RUN_ID}:engine:round:1` },
  {
    round: 1,
    dedupKey: `${RUN_ID}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
  },
  ...(landedT1
    ? [{ round: 1, dedupKey: `${RUN_ID}:msg:1:1`, kind: "message", seq: 1, messages: [toolResult("t1")] }]
    : []),
  ...(tail === undefined ? [] : [tail]),
];

/** 三种「宿主预写行」的键形态：`appendUserTurn` 的**产出形状**逐字照抄
 * （`{ round, messages: [user(text)], dedupKey, roundKey, ts }`），只换身份键。 */
const hostPreWriteRow = (RUN_ID, keyShape) => {
  const shape = { round: 1, messages: [userText("宿主追问")], ts: new Date().toISOString() };
  if (keyShape === "none") return shape; // 远古 / 手搓宿主：连键都没写
  const dedupKey = keyShape === "default"
    ? `${RUN_ID}:round:1` // 契约里的 "host default key"（store 生成 / 宿主照抄）
    : `${RUN_ID}:msg:1:9`; // 引擎逐条消息行用过的命名空间
  return { ...shape, dedupKey, roundKey: dedupKey };
};

/** provider 收到的消息序列（断言失败时贴出来，评审要求「贴序列」而不是只贴条数）。 */
function sequenceOf(messages) {
  return messages.map((message) => `${message.role}:${(Array.isArray(message.content) ? message.content : [])
    .map((block) => (block?.type === "tool_result"
      ? `result:${block.tool_use_id}`
      : block?.type === "tool_use"
        ? `use:${block.id}`
        : `text:${String(block?.text ?? "").slice(0, 10)}`))
    .join("+")}`).join(" | ");
}

/** 跑一遍「崩溃现场 + 宿主预写行」的恢复，返回现算锚点、provider 与结果。 */
async function resumeWithHostRow(keyShape, { landedT1 = false } = {}) {
  const RUN_ID = `anchor-host-key-${keyShape}${landedT1 ? "-landed" : ""}`;
  const rows = crashScene(RUN_ID, { tail: hostPreWriteRow(RUN_ID, keyShape), landedT1 });
  const store = createMemoryTranscriptStore();
  for (const row of rows) await store.appendRound(RUN_ID, row);
  await store.saveRunSnapshot(RUN_ID, {
    round: 1,
    messages: [userText("任务"), { role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
    // 快照锚点写「新鲜」值：失败只可能来自**现算**，快照不能背锅（同 ③ 的做法）。
    persistedTranscriptLength: landedT1 ? 3 : 2,
    executedToolIds: [],
    pendingToolUses: landedT1 ? [toolUse("t2")] : [toolUse("t1"), toolUse("t2")],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });
  const provider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
  const result = await runToolLoop({
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
  return { rows, provider, result, anchor: countResumeAnchor(rows) };
}

/** ①②③ 共用的断言面：恢复成功、宿主追问是最后一条、告示在它之前。 */
function assertHostTailIsLast({ provider, result, anchor }, label) {
  const messages = provider.requests[0]?.messages ?? [];
  const sequence = sequenceOf(messages);
  assert.equal(anchor, 2, `${label}：尾部宿主预写行不算进崩溃现场（锚点 = seed + assistant）`);
  assert.equal(provider.requests.length, 1, `${label}：恢复必须成功发出 1 次请求（0 = 本地校验器先拒）。实测序列：${sequence}`);
  assert.equal(result.finalText, "done", `${label}：恢复必须跑完（实测序列：${sequence}）`);
  const last = messages.at(-1);
  assert.deepEqual(requestTexts(last), ["宿主追问"],
    `${label}：宿主这次追问必须仍是**最后一条**（模型对最后一条 user 权重最高，且这是既有可观察形状）。实测序列：${sequence}`);
  assert.match(String(messages.at(-2)?.content?.[0]?.text ?? ""), /^【恢复运行】/u,
    `${label}：恢复告示排在宿主追问**之前**（契约的形状：先告示、再宿主真请求）。实测序列：${sequence}`);
  assert.deepEqual(
    (messages[2]?.content ?? []).map((block) => [block?.type, block?.tool_use_id]),
    [["tool_result", "t1"], ["tool_result", "t2"]],
    `${label}：补跑结果接在崩溃轮那条聚合 user 消息里（不另起一条把配对打散）。实测序列：${sequence}`,
  );
  assert.deepEqual(
    (messages[2]?.content ?? []).map((block) => block?.content),
    ["replayed-t1", "replayed-t2"],
    `${label}：两条补跑结果（t1 的账本行没落）都接在那条聚合 user 消息里。实测序列：${sequence}`,
  );
}

test("#425 宿主追问行用**默认键** `<runId>:round:<n>`：恢复成功且宿主请求仍是最后一条", async () => {
  assertHostTailIsLast(await resumeWithHostRow("default"), "默认键");
});

test("#425 宿主追问行**完全没有键**：恢复成功且宿主请求仍是最后一条", async () => {
  assertHostTailIsLast(await resumeWithHostRow("none"), "无键");
});

test("#425 宿主追问行的键是引擎形态 `<runId>:msg:<round>:<seq>`：恢复成功且宿主请求仍是最后一条", async () => {
  assertHostTailIsLast(await resumeWithHostRow("msg"), "`:msg:` 键");
});

test("#425 已落 1 条结果行时，默认键宿主追问仍排在【恢复运行】告示**之后**（不静默改序）", async () => {
  const scene = await resumeWithHostRow("default", { landedT1: true });
  const messages = scene.provider.requests[0]?.messages ?? [];
  const sequence = sequenceOf(messages);
  assert.equal(scene.anchor, 3, "锚点 = seed + assistant + 已落盘的 t1 结果（宿主行不算）");
  assert.equal(scene.provider.requests.length, 1, `实测序列：${sequence}`);
  assert.deepEqual(requestTexts(messages.at(-1)), ["宿主追问"], `宿主追问必须是最后一条。实测序列：${sequence}`);
  assert.match(String(messages.at(-2)?.content?.[0]?.text ?? ""), /^【恢复运行】/u,
    `告示必须排在宿主追问之前。实测序列：${sequence}`);
  assert.deepEqual(
    (messages[2]?.content ?? []).map((block) => block?.tool_use_id),
    ["t1", "t2"],
    `已落盘的 t1 与补跑的 t2 必须折在同一条 user 消息里。实测序列：${sequence}`,
  );
});

// ── ⑥ 反向钉：形状像预写、但**键**归引擎的行不算宿主 ───────────────────────────────
test("#425 反向钉：单条 user/text 形状但键是 `:engine:` / `:control:` 的引擎行**不算**宿主尾队列", () => {
  const RUN_ID = "anchor-engine-shaped";
  const engineResumeRow = {
    round: 1,
    dedupKey: `${RUN_ID}:engine:round:1:resume`,
    roundKey: `${RUN_ID}:round:1`,
    messages: [userText("方向提示")],
  };
  const engineControlRow = {
    round: 1,
    dedupKey: `${RUN_ID}:engine:round:1:control:resume-notice`,
    messages: [userText("【恢复运行】…")],
  };
  const base = crashScene(RUN_ID);
  assert.equal(countResumeAnchor(base), 2, "对照：无尾行时锚点 = seed + assistant");
  assert.equal(countResumeAnchor([...base, engineResumeRow]), 3,
    "`:engine:…:resume` 载体即使形状是「单条 user/text」也按键判引擎（形状判据**不优先于**键）");
  assert.equal(countResumeAnchor([...base, engineControlRow]), 3,
    "`:engine:…:control:` 载体同理（评审造的那格 4==4 就是它）");
  // 同一个形状、同一个轮号，只把键换成宿主命名空间 ⇒ 立刻归尾队列：归属由**键 + 形状**两件事实
  // 共同决定，而不是由其中任何一件单独决定。
  assert.equal(countResumeAnchor([...base, { ...engineResumeRow, dedupKey: `${RUN_ID}:input:x`, roundKey: `${RUN_ID}:input:x` }]), 2,
    "同一个形状的宿主 `:input:` 行归尾队列（对照，证明上一条不是因为形状而被判引擎）");
});

// ── ⑦ 方向敏感复证：边界归属真的挪了一格 ⇒ 仍 invalid_messages + 零请求 ────────────────
test("#425 方向敏感复证：默认键现场下锚点人为少 1 ⇒ 仍 invalid_messages 且零请求", async () => {
  const RUN_ID = "anchor-host-key-minus-one";
  const healthyRows = crashScene(RUN_ID, { tail: hostPreWriteRow(RUN_ID, "default"), landedT1: true });
  // 「现算值人为少 1」：把最后那条**引擎**结果行的键改成宿主命名空间 ⇒ 它连同默认键追问行一起归尾队列
  // ⇒ 现算值恰好少 1（下面断言这个差值）。这是**边界归属**的位移，不是把断言绕开。
  const shrunkRows = healthyRows.map((row) => (row.dedupKey === `${RUN_ID}:msg:1:1`
    ? {
      round: row.round,
      dedupKey: `${RUN_ID}:input:anchor-host-key-minus-one`,
      roundKey: `${RUN_ID}:input:anchor-host-key-minus-one`,
      messages: row.messages,
    }
    : row));
  const freshAnchor = countResumeAnchor(healthyRows);
  assert.equal(freshAnchor, 3, "对照：默认键宿主行不算 ⇒ 锚点 = seed + assistant + t1 结果");
  assert.equal(countResumeAnchor(shrunkRows), freshAnchor - 1, "反向现场：现算锚点恰好少 1");

  const runOnce = async (rows) => {
    const store = createMemoryTranscriptStore();
    for (const row of rows) await store.appendRound(RUN_ID, row);
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
    const provider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
    const error = await runToolLoop({
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
    }).then(() => undefined, (thrown) => thrown);
    return { provider, error };
  };

  const healthy = await runOnce(healthyRows);
  assert.equal(healthy.error, undefined, "对照：默认键宿主行归尾队列时恢复成功");
  assert.equal(healthy.provider.requests.length, 1, "对照：恰好一次请求");

  const broken = await runOnce(shrunkRows);
  assert.ok(broken.error, "锚点少 1 必须让本地校验器先拒（不是静默放过）");
  assert.equal(broken.error?.code, "invalid_messages");
  assert.match(String(broken.error?.message), /tool_result ids do not match assistant tool_use ids/u);
  assert.equal(broken.provider.requests.length, 0, "锚点偏移一格 = 零请求（方向敏感）");
});

// ── ⑧ 契约外形状的边界：宿主行**带 `kind:"message"`** ⇒ 不像预写 ⇒ 判引擎（算进崩溃现场） ────────
//
// 这是**如实钉住的剩余边界**，不是要修的 bug：契约的宿主预写行形状是
// `{ round, messages, dedupKey, roundKey, ts }`（`docs/host-consumer-contract.md`「A correct
// pre-written `RoundRecord` must satisfy」那一段），`kind` / `seq` 是**引擎逐条消息行**的标记。
// 宿主给预写行带上它们 ⇒ 形状判据认不出「这是预写」⇒ 判引擎行 ⇒ 锚点把它算进崩溃现场 ⇒
// 补跑结果被插到它**之后**、`tool_use` 与 `tool_result` 不再相邻 ⇒ `invalid_messages` + **零请求**
// （同一现场在 main 上是 1 请求）。契约中英已把「预写行不得带 `kind` / `seq`」写成成对约束。
test("#425 边界：`:round:` 键 + `kind:\"message\"` 的尾行判引擎（anchor 计入）", async () => {
  const RUN_ID = "anchor-host-row-with-kind";
  // 键是契约的 "host default key"（`:round:`），但形状带了引擎逐条消息行的标记 ⇒ 判引擎。
  const tail = {
    round: 1,
    dedupKey: `${RUN_ID}:round:1`,
    roundKey: `${RUN_ID}:round:1`,
    kind: "message",
    messages: [userText("宿主追问")],
    ts: new Date().toISOString(),
  };
  const rows = crashScene(RUN_ID, { tail });
  assert.equal(countResumeAnchor(rows), 3,
    "`kind:\"message\"` 的尾行**算进**崩溃现场（锚点 = seed + assistant + 该行）——形状判据只认契约形状");
  // 同一行的 `kind` 摘掉 ⇒ 逐字变回契约形状 ⇒ 立刻归尾队列。这一对证明上一条断的是 `kind` 本身。
  assert.equal(countResumeAnchor(crashScene(RUN_ID, { tail: { ...tail, kind: undefined } })), 2,
    "对照：摘掉 `kind` 后同一行（同键、同正文）归尾队列");

  const store = createMemoryTranscriptStore();
  for (const row of rows) await store.appendRound(RUN_ID, row);
  await store.saveRunSnapshot(RUN_ID, {
    round: 1,
    messages: [userText("任务"), { role: "assistant", content: [text("开工"), toolUse("t1"), toolUse("t2")] }],
    persistedTranscriptLength: 3,
    executedToolIds: [],
    pendingToolUses: [toolUse("t1"), toolUse("t2")],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });
  const provider = createFakeProvider([{ content: [text("done")], stopReason: "end_turn" }]);
  const error = await runToolLoop({
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
  }).then(() => undefined, (thrown) => thrown);
  assert.ok(error, "这一现场在本地校验器上必须被拒（不是静默放过）");
  assert.equal(error?.code, "invalid_messages", "判引擎 ⇒ 补跑结果排到宿主行之后 ⇒ 配对断裂");
  assert.match(String(error?.message), /assistant tool_use has no immediately following user tool_result/u);
  assert.equal(provider.requests.length, 0, "零请求（契约外形状的边界，与 main 的 1 请求不同）");
});
