// issue #765：宿主在 `appendUserTurn` 里预写下一条用户轮时，账本里那条**悬空 `tool_use`**（有
// `assistant[tool_use]` 行、整本账本没有对应 `tool_result`）现在在**宿主那条 `user[text]` 行落盘之前**
// 就被结清 —— 结清行自己当尾行，折叠顺序天然是 `assistant[TU] → user[TR] → user(text)`。
//
// 为什么时机是本案的全部（修前后各跑过一遍，脚本 `/tmp/repro-765.mjs`）：`foldMessageRows` 把同一轮的
// 消息行按 `seq` 排好再挂回该轮载体（`src/store/message-rows.js#attachRoundMessages`），所以「事后补一行」
// 在这层是**位置错**的：宿主那条纯文本轮一落盘，① 任何补在它后面的 `user[tool_result]` 在折叠视图里都排在
// 它**后面**，出网顺序成 `assistant[TU] → user(text) → user(TR)`，provider 直接 400；② 尾行不再是带
// `tool_use` 的 assistant ⇒ `pendingTailToolUses` / `resumeMessagesWithUnpersistedToolResults` 的**尾部**判据
// 全部失效，引擎侧看不见这笔悬空 ⇒ 恢复路径上唯一还看得见它的是出网前的 `validateMessages`，而它
// 只会在本地把该 runId 砖化（`invalid_messages: assistant tool_use has no immediately following user
// tool_result`，issue 现场就是这条）。所以主判据必须断**折叠后的顺序**，断「写了两行」不算数。
//
// 与本仓既有三件同形状东西的分工（本案刻意复用而不是再造第四件）：
//   · 桩的块形状：`src/loop/pending-tool-result.js#buildUnpersistedToolResultStub`（#421 那张桩，
//     `content = UNPERSISTED_TOOL_RESULT_TEXT` + `is_error: true`）—— 全仓唯一构造点仍在共享实现里；
//   · 行形状：`kind: "message"` + 现取 `seq`（引擎写侧 `src/loop/orchestrator.js#appendMessageRowToTranscript`
//     同口径），**不写 `roundKey`**（`isRoundCarrier` 会把缺 `seq` 时的 `roundKey` 当第二个轮载体 ⇒ R3 守卫
//     反过来丢掉我们刚写的行）；
//   · 拒写时机：`resume-manager` 的 `resume_journal_skipped` 曾有一条同名的轮号成因，但那是**事件面**的
//     闭集表，store 层不发事件 ⇒ 原因走返回值（用例 5 / 6 / 7 钉住「拒写必须出声，不许静默」）。
//     issue #811 把**轮号**那一格从两边同时删了：事件面那条构造性不可能（写侧已挡），store 层这一格
//     改成抛 `TypeError`（调用方参数错了不是降级）⇒ 现在 `reason` 只剩三条降级成因。
import test from "node:test";
import assert from "node:assert/strict";

import { appendUserTurn } from "../../src/store/append-user-turn.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { foldLedgerMessages } from "../../src/store/message-rows.js";
import { withUnvalidatedAppends } from "../helpers/unvalidated-store.js";
import { validateMessages } from "../../src/messages/rounds.js";
import { UNPERSISTED_TOOL_RESULT_TEXT, PENDING_TOOL_RESULT_TEXT } from "../../src/loop/pending-tool-result.js";
import { runDirect } from "../helpers/run-direct.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

const RUN = "append-user-turn-settle-765";
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const toolResult = (id) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });
const typesOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => block?.type);
const shapeOf = (messages) => messages.map((message) => `${message.role}[${typesOf(message).join(",")}]`);

/** 引擎写侧的消息行（`src/loop/orchestrator.js` 的 `kind/seq/dedupKey = <runId>:msg:<round>:<seq>`）。 */
const messageRow = (round, seq, message, extra = {}) => ({
  round,
  roundKey: `${RUN}:round:${round}`,
  dedupKey: `${RUN}:msg:${round}:${seq}`,
  kind: "message",
  seq,
  messages: [message],
  ts: "2026-02-01T00:00:00.000Z",
  ...extra,
});

/** 崩溃现场：一条用户种子轮 + 一条带 `tool_use` 的 assistant 行，没有结果行、没有轮载体行。 */
async function crashedLedger(store, ids = ["t1"]) {
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN, messageRow(2, 0, {
    role: "assistant",
    content: [text("我跑一下工具"), ...ids.map(toolUse)],
  }));
  return store;
}

const settleRowsOf = (rows) => rows.filter((row) => typeof row?.dedupKey === "string"
  && row.dedupKey.includes(":settle:"));

const blocksOfMessages = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));

// ── 判据 1（工单主判据）：折叠后的顺序 ──────────────────────────────────────────────────

test("#765 主判据：结清行在宿主纯文本轮之前落盘，折叠视图是 assistant[TU] → user[TR] → user(text)", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store);

  const result = await appendUserTurn(store, { key: RUN, text: "宿主追问", messageId: "m-1" });

  const entries = foldLedgerMessages(await store.load(RUN));
  // 顺序断言（**不是**「写了两行」）：折叠视图里 assistant 的 tool_use 紧接的就是那条 tool_result，
  // 宿主的纯文本轮在**它们之后**。这正是 `src/messages/rounds.js#validateMessages` 要求的形状。
  assert.deepEqual(shapeOf(entries.map((entry) => entry.message)), [
    "user[text]",
    "assistant[text,tool_use]",
    "user[tool_result]",
    "user[text]",
  ], `折叠顺序必须让 tool_result 夹在 assistant[TU] 与宿主纯文本轮之间，实得：${JSON.stringify(shapeOf(entries.map((e) => e.message)))}`);
  assert.deepEqual(entries.map((entry) => entry.round), [1, 2, 2, 2],
    "结清行与宿主行都挂在崩溃那一轮（round 复用现有最大 round，#97 的既有语义没动）");

  // 出网前那道本地校验必须过（issue 现场的红就是它把 runId 砖化在本地）。
  assert.doesNotThrow(() => validateMessages(entries.map((entry) => entry.message)));

  // 结清行本身：内容 = #421 那张桩（正文逐字相同 + `is_error`），id 与悬空的那个一一对应。
  const settleRow = settleRowsOf(await store.load(RUN));
  assert.equal(settleRow.length, 1, "恰好一条结清行");
  assert.deepEqual(settleRow[0].messages, [{
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "t1",
      content: UNPERSISTED_TOOL_RESULT_TEXT,
      is_error: true,
    }],
  }]);
  assert.deepEqual(
    { key: result.key, dedupKey: result.dedupKey, written: result.written, round: result.round },
    { key: RUN, dedupKey: `${RUN}:input:m-1`, written: true, round: 2 },
    "宿主行的返回形状不受影响");
});

test("#765 行形状：kind/seq 与引擎消息行同口径、不写 roundKey、dedupKey 稳定可幂等", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store, ["t1", "t2"]);
  await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });

  const [settleRow] = settleRowsOf(await store.load(RUN));
  assert.equal(settleRow.kind, "message", "必须是引擎那条折叠判据认的 `kind: \"message\"`");
  assert.equal(settleRow.seq, 1,
    "seq 必须由 `nextMessageSeqByRound` 现取（崩溃轮已有 seq=0 的 assistant 行 ⇒ 1）；缺 seq 会让多条补行乱序");
  assert.equal(settleRow.roundKey, undefined,
    "不写 roundKey：缺 `seq` 的 store 上它会被 `isRoundCarrier` 当成第二个轮载体 ⇒ R3 守卫丢掉这条结清行");
  assert.equal(settleRow.dedupKey, `${RUN}:settle:2:t1+t2`,
    "dedupKey 只由 (key, round, 排序后的 tool_use_id) 决定 ⇒ 不含时间戳/messageId，重跑幂等");
  assert.deepEqual(blocksOfMessages(settleRow.messages).map((block) => block.tool_use_id), ["t1", "t2"]);
});

test("#765 幂等：同 messageId 重跑与换 messageId 续写都只留一条结清行", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store);

  const first = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });
  assert.deepEqual({ status: first.unsettledToolUses.status, written: first.unsettledToolUses.written },
    { status: "settled", written: true });

  // 崩溃重跑：同 dedupKey ⇒ 走的是 #97 那条「命中即返回」的早退路径（在结清之前）⇒ 一行也不写。
  // 写序是先结清再写宿主行 ⇒ 宿主行已在账本里就等于结清行也已在，这里无事可做。
  const rerun = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });
  assert.equal(rerun.written, false);
  assert.equal("unsettledToolUses" in rerun, false,
    "幂等重跑走早退路径：返回形状与今天逐字相同（不许在这一格多写一行，也不许多一个键）");

  // 换一条用户轮：上一轮已被第一条结清行结清 ⇒ 这次是 clean，返回值里不带这个字段。
  const next = await appendUserTurn(store, { key: RUN, text: "再追问", messageId: "m-2" });
  assert.equal("unsettledToolUses" in next, false,
    `第二次调用已无悬空 ⇒ 返回形状回到今天那份，实得 ${JSON.stringify(Object.keys(next))}`);

  const rows = await store.load(RUN);
  assert.equal(settleRowsOf(rows).length, 1, "反复预写只结清一次");
  assert.equal(rows.length, 5, "种子 2 行 + 结清 1 行 + 两条宿主轮（m-1 与其重跑不新增）；结清行不重复");
  assert.equal(shapeOf(foldLedgerMessages(rows).map((entry) => entry.message)).join(" → "),
    "user[text] → assistant[text,tool_use] → user[tool_result] → user[text] → user[text]");
});

// ── 判据 2：没有悬空时行为逐字不变 ──────────────────────────────────────────────────────

test("#765 无悬空 ⇒ 不多写一行、返回对象键集合与 dedupKey 形态逐字不变", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN, messageRow(2, 0, {
    role: "assistant", content: [text("一轮完整的回答"), toolResult("t0"), toolUse("t1")],
  }));
  await store.appendRound(RUN, messageRow(2, 1, { role: "user", content: [toolResult("t1")] }));
  const before = await store.load(RUN);

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });
  const after = await store.load(RUN);

  assert.deepEqual(Object.keys(result), ["key", "dedupKey", "round", "written"],
    "没有悬空时返回值不许多出一个键（宿主读的是这四键，#157/#97 的契约）");
  assert.equal(after.length, before.length + 1, "只写宿主那一行");
  assert.deepEqual(settleRowsOf(after), []);
  assert.match(result.dedupKey, /^append-user-turn-settle-765:input:m-1$/u,
    "宿主行的 dedupKey 形态不许被结清逻辑影响");
  assert.equal(after.at(-1).seq, undefined, "宿主那条纯文本轮仍然不是消息行（没有 kind/seq）");
});

test("#765 尾行不是带 tool_use 的 assistant 时不结清（中段悬空仍归引擎的 #421 复放管）", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN, messageRow(2, 0, { role: "assistant", content: [text("答完"), toolUse("t1")] }));
  await store.appendRound(RUN, messageRow(3, 0, { role: "user", content: [text("上一轮已经追过")] }));

  const result = await appendUserTurn(store, { key: RUN, text: "再追问", messageId: "m-1" });

  assert.equal("unsettledToolUses" in result, false,
    "尾行是一条带正文的 user ⇒ 尾部判据（与 `pendingTailToolUses` 同一条）不成立，这里不越权补 #421 的账");
  assert.deepEqual(settleRowsOf(await store.load(RUN)), []);
});

test("#765 分片行（带 partOf）不新起一条逻辑消息，因此不当尾行", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store);
  await store.appendRound(RUN, {
    ...messageRow(2, 1, { role: "user", content: [toolResult("t1")] }),
    partOf: `${RUN}:msg:2:1`,
  });

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });

  assert.equal("unsettledToolUses" in result, false,
    "t1 的结果行已在账本里 ⇒ 不悬空；分片行也不许被当成尾行而把结清方向反过来");
  assert.deepEqual(settleRowsOf(await store.load(RUN)), []);
});

// ── 判据 3：拒写必须出声（不许新增事件类型，也不许静默）────────────────────────────────

test("#811 抛错（原 #765 拒写 A）：崩溃轮的轮号不是安全整数 ⇒ 抛 TypeError，一行都不写", async () => {
  // 现场：账本尾行（带悬空 `tool_use` 的 assistant）自己的轮号不是安全整数。#811 之前这是一条
  // `refused`（与下面三条降级同一个形状），而它根本不是「可恢复的降级」而是**调用方/宿主 store
  // 交错了**：结清行的 `dedupKey` 与 `seq` 都由那个轮号派生 ⇒ 现在当场抛 `TypeError`。
  // 行为什么由 `withUnvalidatedAppends` 落：内置 store 的写入口现在也认不了那种行（#811 第 1 条），
  // 它只能来自宿主自研 store（驱动把整型列返回成字符串）或守卫之前的档案。
  const store = withUnvalidatedAppends(createMemoryTranscriptStore());
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN, messageRow("nope", 0, { role: "assistant", content: [toolUse("t1")] }));

  // 类型是契约：宿主只把 `TypeError` 映射成 4xx，其他异常一律 5xx。
  const error = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" })
    .then(() => null, (caught) => caught);
  assert.ok(error instanceof TypeError, `必须抛 TypeError（宿主据此映射 4xx），实得：${String(error)}`);
  // 错误信息必须点名：哪个入口、哪一行、收到的值与类型。
  assert.match(error.message, /^appendUserTurn: /u, `必须点名入口，实得：${String(error?.message)}`);
  assert.match(error.message, /msg:nope:0/u, `必须点名是哪一行，实得：${String(error?.message)}`);
  assert.match(error.message, /"nope" \(string\)/u,
    `必须点名收到的值与类型，实得：${String(error?.message)}`);
  assert.match(error.message, /not a safe integer/u, `实得：${String(error?.message)}`);
  const rows = await store.load(RUN);
  assert.deepEqual(settleRowsOf(rows), [], "抛错在写之前 ⇒ 结清行一行都不写");
  assert.equal(rows.filter((row) => row?.dedupKey === `${RUN}:input:m-1`).length, 0,
    "宿主那条输入同样不落盘：抛的就是「这次调用没法算出写在哪一轮」，宿主修好轮号再重发");
});

test("#765 拒写 B：同轮载体已带正文 ⇒ 折叠顺序不可信，宁可不写也要点名", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  // 宿主把「折好的载体行」与「原始消息行」两份都留（#401 R3 的事故现场形状）。
  await store.appendRound(RUN, {
    round: 2,
    roundKey: `${RUN}:round:2`,
    dedupKey: `${RUN}:engine:round:2`,
    messages: [{ role: "assistant", content: [text("我跑一下工具"), toolUse("t1")] }],
    ts: "2026-02-01T00:00:01.000Z",
  });
  await store.appendRound(RUN, messageRow(2, 0, { role: "assistant", content: [text("我跑一下工具"), toolUse("t1")] }));

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });

  assert.deepEqual(result.unsettledToolUses, {
    status: "refused",
    reason: "round_carrier_has_body",
    round: 2,
    toolUseIds: ["t1"],
  }, "判据与 `resume-manager#roundHasBodyCarrier` 同源：载体有正文 ⇒ 折叠会把结清行挂进活载体，位置由 seq 决定 ⇒ 不赌");
  assert.deepEqual(settleRowsOf(await store.load(RUN)), []);
  assert.equal(result.written, true);
});

test("#765 拒写 C：探针快路径没有 loadRawRows ⇒ 拒写且不整本读一次 store.load", async () => {
  const inner = createMemoryTranscriptStore();
  // 内置 store 没有那两根点查探针（#160：对 JSONL 无意义），这里按宿主面形状搭一个 DB store 的替身。
  const rowsOf = async (key) => (await inner.loadRawRows(key));
  let loads = 0;
  const store = {
    // 只有 #157 那两根探针：成对生效 ⇒ 快路径 ⇒ 全程不许调 `load`（那是 #157 给宿主的承诺）。
    appendRound: (key, record) => inner.appendRound(key, record),
    loadByDedupKey: async (key, dedupKey) => (await rowsOf(key))
      .find((row) => (row?.dedupKey ?? row?.roundKey) === dedupKey) ?? null,
    loadMaxRound: async (key) => (await rowsOf(key))
      .reduce((max, row) => Math.max(max, Number.isSafeInteger(row?.round) ? row.round : 0), 0),
    load: async (key) => { loads += 1; return inner.load(key); },
  };
  await crashedLedger(store);

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });

  assert.equal(loads, 0, "快路径不得为了结清而把 #157 的优化退回去（整本读一次）");
  assert.deepEqual(result.unsettledToolUses, { status: "refused", reason: "ledger_probe_absent", toolUseIds: [] });
  assert.equal(result.written, true, "宿主行照写：探针缺席是宿主的事，用户输入不是");
  assert.deepEqual(settleRowsOf(await inner.load(RUN)), []);
});

test("#765 探针快路径三根齐备 ⇒ 与全量路径写逐字相同的结清行", async () => {
  const inner = createMemoryTranscriptStore();
  const rowsOf = async (key) => (await inner.loadRawRows(key));
  const store = {
    ...inner,
    loadByDedupKey: async (key, dedupKey) => (await rowsOf(key))
      .find((row) => (row?.dedupKey ?? row?.roundKey) === dedupKey) ?? null,
    loadMaxRound: async (key) => (await rowsOf(key))
      .reduce((max, row) => Math.max(max, Number.isSafeInteger(row?.round) ? row.round : 0), 0),
    loadRawRows: (key) => inner.loadRawRows(key),
  };
  await crashedLedger(store);

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });
  assert.deepEqual({
    status: result.unsettledToolUses.status,
    written: result.unsettledToolUses.written,
    round: result.unsettledToolUses.round,
    dedupKey: result.unsettledToolUses.dedupKey,
    seq: result.unsettledToolUses.seq,
  }, {
    status: "settled", written: true, round: 2, dedupKey: `${RUN}:settle:2:t1`, seq: 1,
  });

  const rows = await inner.load(RUN);
  const [settleRow] = settleRowsOf(rows);
  assert.equal(settleRow.seq, 1, "快路径拿的是未折叠行 ⇒ seq 与全量路径同值（幂等重跑写出的行逐字相同）");
  assert.deepEqual(shapeOf(foldLedgerMessages(rows).map((entry) => entry.message)), [
    "user[text]", "assistant[text,tool_use]", "user[tool_result]", "user[text]",
  ]);
});

test("#765 tool_use id 不合法时不硬造桩：拒写点名，把砖化留给 validateMessages 如实报（#421 纪律 ⑤）", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN, messageRow(2, 0, {
    role: "assistant", content: [toolUse(""), toolUse("t2")],
  }));

  const result = await appendUserTurn(store, { key: RUN, text: "追问", messageId: "m-1" });

  assert.equal(result.unsettledToolUses.status, "refused");
  assert.equal(result.unsettledToolUses.reason, "tool_use_id_unusable");
  assert.deepEqual(settleRowsOf(await store.load(RUN)), [],
    "半张桩（只结清 t2）会留下一条永远不合法的账 ⇒ 要红一起红，不写半套");
});

// ── 判据 4：端到端（真 store + 真 runToolLoop）──────────────────────────────────────────

test("#765 端到端：预写之后 runToolLoop(resume) 能跑通，桩在请求里紧跟那条 assistant", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store);
  await appendUserTurn(store, { key: RUN, text: "宿主追问：刚才那步结果怎么样了？", messageId: "m-1" });

  const events = [];
  const provider = createFakeProvider([{ content: [text("续接完成")], stopReason: "end_turn" }]);
  const result = await runDirect({
    provider,
    resume: true,
    store,
    runId: RUN,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    executeTool: async () => { throw new Error("结清之后不该补跑工具"); },
  });

  assert.equal(result.finalText, "续接完成", "恢复必须真的出网跑完（修前是本地 `invalid_messages` 抛死，0 次请求）");
  assert.equal(provider.requests.length, 1);

  const messages = provider.requests[0].messages;
  const shapes = shapeOf(messages);
  const assistantIndex = shapes.findIndex((shape) => shape.startsWith("assistant["));
  assert.ok(assistantIndex >= 0, `请求里必须有那条 assistant，实得 ${JSON.stringify(shapes)}`);
  assert.deepEqual(shapes.slice(assistantIndex, assistantIndex + 3), [
    "assistant[text,tool_use]",
    "user[tool_result]",
    "user[text]",
  ], "出网顺序：tool_result 紧接 assistant 的 tool_use，宿主的纯文本轮在它们后面");

  const stub = blocksOfMessages(messages).find((block) => block?.type === "tool_result");
  assert.equal(stub.tool_use_id, "t1");
  assert.equal(stub.is_error, true);
  assert.equal(stub.content, UNPERSISTED_TOOL_RESULT_TEXT);

  // 结清已经发生在写侧 ⇒ 引擎续跑侧无事可做，不该再发降级事件（发了就说明两侧都在补，那是两份事实）。
  assert.deepEqual(events.filter((event) => event.type === "resume_journal_skipped"), [],
    `续跑侧不该再补桩，实得 ${JSON.stringify(events.filter((event) => event.type === "resume_journal_skipped"))}`);
});

test("#765 端到端（反向对照）：不预写时引擎侧的尾部结清仍然工作（本案没有抢走它的活）", async () => {
  const store = createMemoryTranscriptStore();
  await crashedLedger(store);
  const events = [];
  const provider = createFakeProvider([{ content: [text("续接完成")], stopReason: "end_turn" }]);

  const result = await runDirect({
    provider,
    resume: true,
    store,
    runId: RUN,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    executeTool: async () => { throw new Error("不该补跑"); },
  });

  assert.equal(result.finalText, "续接完成");
  assert.deepEqual(shapeOf(provider.requests[0].messages).slice(0, 3), [
    "user[text]", "assistant[text,tool_use]", "user[tool_result]",
  ], "宿主没预写 ⇒ 尾行仍是那条 assistant ⇒ 引擎的尾部结清负责补（`answerPendingTailToolUses`）");
});

// ── 判据 7（反向证）：把「前移结清」短路 ⇒ 本案两条主格子必须回到红 ────────────────────

/**
 * 反向证夹具：把结清行挡在 store 门外 ⇒ 账本逐字等于「没有前移结清」的今天。
 *
 * 为什么不在这里改生产代码：判据要红在**账本事实**上，而不是红在某个被注释掉的调用上（后者每次改文件都得重做
 * 一遍，且改错了也不会响）。`appendUserTurn` 照常跑结清那一步，只是这一格的 store 不吃这一行 ⇒ 落盘后的形状
 * 与修前逐字同形（脚本实测过：行数、dedupKey、折叠顺序都对得上修前）。
 */
function withoutSettling(inner) {
  return {
    ...inner,
    appendRound: (key, record) => (typeof record?.dedupKey === "string" && record.dedupKey.includes(":settle:")
      ? Promise.resolve(undefined)
      : inner.appendRound(key, record)),
  };
}

test("#765 反向证（账本面）：没有那条结清行 ⇒ 折叠视图缺 tool_result，本地校验器当场报 issue 里那句原话", async () => {
  const inner = createMemoryTranscriptStore();
  const store = withoutSettling(inner);
  await crashedLedger(store);

  const result = await appendUserTurn(store, { key: RUN, text: "宿主追问", messageId: "m-1" });
  // 结清那一步跑了，但 `written: true` 不等于落盘（文件头那条「并发去重」口径的同一条），这一格就利用这一点。
  assert.equal(result.unsettledToolUses.status, "settled");

  const entries = foldLedgerMessages(await inner.load(RUN));
  assert.deepEqual(shapeOf(entries.map((entry) => entry.message)), [
    "user[text]", "assistant[text,tool_use]", "user[text]",
  ], "没有结清行就只剩修前那个形状：宿主的纯文本轮直接接在带 tool_use 的 assistant 后面");
  assert.throws(
    () => validateMessages(entries.map((entry) => entry.message)),
    /assistant tool_use has no immediately following user tool_result/u,
    "issue #765 现场那句砖化报错必须能从这里重现（不是只断一个抽象的「顺序不对」）",
  );
});

test("#765 反向证（端到端）：没有结清行时引擎只能在内存里替一张「从没执行」的桩，而账本里桩行落在宿主轮**后面**", async () => {
  const inner = createMemoryTranscriptStore();
  const store = withoutSettling(inner);
  await crashedLedger(store);
  await appendUserTurn(store, { key: RUN, text: "宿主追问：刚才那步结果怎么样了？", messageId: "m-1" });

  const provider = createFakeProvider([{ content: [text("续接完成")], stopReason: "end_turn" }]);
  const result = await runDirect({
    provider,
    resume: true,
    store,
    runId: RUN,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    executeTool: async () => { throw new Error("不该补跑"); },
  });

  // 这一格不要求「0 次请求」：实测引擎的续跑复放（#421）会在**内存里**替一张桩把本次上下文顶住。
  // 它顶的是哪一张桩、以及账本里那一行落在哪，才是本案的代价，所以两条都钉住。
  assert.equal(result.finalText, "续接完成");
  const stub = blocksOfMessages(provider.requests[0].messages)
    .find((block) => block?.type === "tool_result");
  assert.equal(stub.content, PENDING_TOOL_RESULT_TEXT,
    "修前上下文里顶上来的是「这个工具调用从未执行」（`PENDING_TOOL_RESULT_TEXT`），而事实是「执行过、结果没落盘」"
    + "⇒ 模型被告知了一件错事（它不知道那次调用可能有副作用）；若哪天续跑复放改用正确的桩且把桩行折到宿主轮之前，"
    + "这一格会红，那时本案的动机要重读一遍");

  const shapes = shapeOf(foldLedgerMessages(await inner.load(RUN)).map((entry) => entry.message));
  const hostIndex = shapes.indexOf("user[text]");
  const resultIndex = shapes.indexOf("user[tool_result]");
  assert.ok(hostIndex >= 0 && resultIndex > hostIndex,
    `事后补的桩行在折叠视图里排在宿主那条纯文本轮**后面**（这就是「位置不对」而不是「没补」）：${JSON.stringify(shapes)}`);
  assert.deepEqual(settleRowsOf(await inner.load(RUN)), []);
});

// ── 结构判据：别把同一件事写第二遍 ──────────────────────────────────────────────────────

test("#765 结构：桩块走共享构造点，store 层不许自己手搭块形状", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../src/store/append-user-turn.js", import.meta.url), "utf8");

  assert.match(source, /buildUnpersistedToolResultStub\(/u,
    "结清行的块必须由 `src/loop/pending-tool-result.js` 那个唯一构造点造（同一个桩只有一份形状）");
  assert.doesNotMatch(source, /type:\s*"tool_result"/u,
    "store 层不许手搭 `tool_result` 块：那会把 #421 那张桩变成第二份事实（正文/`is_error` 各写一遍）");
  assert.doesNotMatch(source, /buildToolResultFact\(/u,
    "块构造点仍只在共享实现里（`test/loop-resume-unpersisted-tool-results.test.js` 的构造点判据）");
  assert.match(source, /nextMessageSeqByRound\(rows\)/u,
    "seq 必须现取；写死 seq 会让多条结清行在折叠时乱序");
});
