// 工单 261021 第一刀（读侧折叠层）的**手写合成用例**。
//
// 为什么全部用手写期望值：写侧（`orchestrator` 一条消息一落盘）是下一单，今天的引擎还不会
// 产出 `kind:"message"` + `seq` 的行 ⇒ 折叠层只能由测试自己喂行来驱动。金样
// （test/store/message-journal-golden.test.js）钉的是「改造前后宿主读到的形状不变」，
// 而形状规则本身必须由这里逐条钉死——**期望轮行的 messages 写在字面量里**，
// 不是用代码算出来再和自己比。
import test from "node:test";
import assert from "node:assert/strict";

import {
  MESSAGE_ROW_KIND,
  foldLedgerMessages,
  foldMessageRows,
  isFoldableMessageRow,
  isMessageRow,
  nextMessageSeqByRound,
} from "../../src/store/message-rows.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore } from "../../src/store/file.js";
import { appendUserTurn } from "../../src/store/append-user-turn.js";
import { makeTmp } from "../helpers/tmp.js";

const RUN = "r1";
const text = (t) => ({ type: "text", text: t });
const msg = (role, t) => ({ role, content: [text(t)] });
/** 一条 `tool_result` 块（分片用例的最小正文单元）。 */
const toolResult = (id) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });

/** 轮行（载体）：改造前一轮正文只在这里落一次。 */
const roundRow = (round, messages = [], extra = {}) => ({
  round,
  dedupKey: `${RUN}:engine:round:${String(round)}`,
  roundKey: `${RUN}:round:${String(round)}`,
  messages,
  ...extra,
});

/** 消息行：改造后一条消息一成型就落一行。 */
const messageRow = (round, seq, message, extra = {}) => ({
  round,
  seq,
  kind: MESSAGE_ROW_KIND,
  dedupKey: `${RUN}:msg:${String(round)}:${String(seq)}`,
  messages: [message],
  ...extra,
});

const contentOf = (record) => record.messages.map((m) => m.content);

// ── 口径 1：分组与组内排序 ────────────────────────────────────────────────────
test("261021 fold: 按 round 分组、组内按 seq 升序拼回轮行（落盘乱序不影响正文顺序）", () => {
  const rows = [
    roundRow(1),
    messageRow(1, 2, msg("assistant", "第三次调用")),
    messageRow(1, 0, msg("assistant", "第一次正文")),
    messageRow(1, 1, msg("user", "工具结果一")),
  ];
  const folded = foldMessageRows(rows);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].dedupKey, "r1:engine:round:1");
  assert.deepEqual(contentOf(folded[0]), [
    [text("第一次正文")],
    [text("工具结果一")],
    [text("第三次调用")],
  ]);
});

test("261021 fold: seq 相同则按落盘先后（数组顺序）拼接", () => {
  const folded = foldMessageRows([
    roundRow(2),
    messageRow(2, 0, msg("assistant", "先落盘的")),
    messageRow(2, 0, msg("assistant", "后落盘的")),
  ]);
  assert.deepEqual(contentOf(folded[0]), [[text("先落盘的")], [text("后落盘的")]]);
});

test("261021 fold: 多轮各自分组，轮行原有正文在前、消息行接在后面", () => {
  const folded = foldMessageRows([
    roundRow(1, [msg("assistant", "轮一原有正文")]),
    messageRow(1, 0, msg("user", "轮一工具结果")),
    roundRow(2),
    messageRow(2, 0, msg("assistant", "轮二正文")),
  ]);
  assert.deepEqual(folded.map((r) => r.round), [1, 2]);
  assert.deepEqual(contentOf(folded[0]), [[text("轮一原有正文")], [text("轮一工具结果")]]);
  assert.deepEqual(contentOf(folded[1]), [[text("轮二正文")]]);
});

// ── 口径 2：载体形态与「无载体原样留」 ────────────────────────────────────────
for (const [label, carrierKey] of [
  ["引擎轮行 <runId>:engine:round:<n>", `${RUN}:engine:round:3`],
  ["宿主默认键 <runId>:round:<n>", `${RUN}:round:3`],
  ["resume 预落盘行 …:round:<n>:resume", `${RUN}:engine:round:3:resume`],
]) {
  test(`261021 fold: 载体形态——${label}`, () => {
    const folded = foldMessageRows([
      { round: 3, dedupKey: carrierKey, roundKey: carrierKey, messages: [] },
      messageRow(3, 0, msg("assistant", "正文")),
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].dedupKey, carrierKey);
    assert.deepEqual(contentOf(folded[0]), [[text("正文")]]);
  });
}

test("261021 fold: 崩溃在轮行落盘之前 ⇒ 消息行原样留在数组里、一个字节都不改（同一引用）", () => {
  const orphan = messageRow(4, 0, msg("assistant", "模型已看到、轮行还没落盘的正文"));
  const tail = messageRow(4, 1, msg("user", "已完成的工具结果"));
  const other = roundRow(5, [msg("assistant", "下一轮")]);
  const rows = [orphan, tail, other];
  const folded = foldMessageRows(rows);
  assert.equal(folded.length, 3);
  assert.deepEqual(folded.map((r) => r.dedupKey), [
    "r1:msg:4:0",
    "r1:msg:4:1",
    "r1:engine:round:5",
  ]);
  // 崩溃点矩阵的判据：flatMap(record.messages) 仍拼出模型当时该看到的序列。
  assert.deepEqual(rows.flatMap((r) => r.messages ?? []), folded.flatMap((r) => r.messages ?? []));
  // 「一个字节都不改」：消息行是**同一个对象引用**，没被浅拷贝或改写。
  assert.equal(folded[0], orphan);
  assert.equal(folded[1], tail);
  assert.equal(folded[2], other);
});

test("261021 fold: 一轮有载体、另一轮没有 ⇒ 有载体的折叠、没载体的照旧原样留", () => {
  const orphan = messageRow(1, 0, msg("assistant", "轮一没载体"));
  const folded = foldMessageRows([orphan, roundRow(2), messageRow(2, 0, msg("assistant", "轮二正文"))]);
  assert.deepEqual(folded.map((r) => r.dedupKey), ["r1:msg:1:0", "r1:engine:round:2"]);
  assert.equal(folded[0], orphan);
  assert.deepEqual(contentOf(folded[1]), [[text("轮二正文")]]);
});

// ── 口径 3：老账本原样透传 ────────────────────────────────────────────────────
test("261021 fold: 没有可折叠消息行 ⇒ 返回入参本身（同一引用、同一批对象）", () => {
  const rows = [roundRow(0, [msg("user", "任务")], { summary: "x" }), roundRow(1, [msg("assistant", "答复")])];
  const folded = foldMessageRows(rows);
  assert.equal(folded, rows);
  assert.equal(folded[0], rows[0]);
  assert.equal(folded[1], rows[1]);
});

test("261021 fold: 只有空 messages 的消息行不算可折叠 ⇒ 仍走透传（老账本零改写）", () => {
  const rows = [roundRow(1, [msg("assistant", "正文")]), { round: 1, seq: 0, kind: MESSAGE_ROW_KIND, messages: [] }];
  assert.equal(foldMessageRows(rows), rows);
});

// ── 口径 4：`:input:` 行不折叠（appendUserTurn 幂等判据） ─────────────────────
test("261021 fold: 宿主 :input: 行标了 kind 但没有 seq ⇒ 不吸走，load 里仍能看见自己的 dedupKey", () => {
  const inputRow = {
    round: 1,
    kind: MESSAGE_ROW_KIND,
    dedupKey: `${RUN}:input:1:host-followup-1`,
    roundKey: `${RUN}:input:1:host-followup-1`,
    messages: [msg("user", "追问：还剩什么")],
  };
  const rows = [roundRow(1), inputRow, messageRow(1, 0, msg("assistant", "引擎正文"))];
  assert.equal(isMessageRow(inputRow), true);
  assert.equal(isFoldableMessageRow(inputRow), false);
  const folded = foldMessageRows(rows);
  // 存活的行保持**原数组顺序**（折叠不重排账本），载体行在前、宿主 `:input:` 行照旧可见。
  assert.deepEqual(folded.map((r) => r.dedupKey), [
    "r1:engine:round:1",
    "r1:input:1:host-followup-1",
  ]);
  assert.equal(folded[1], inputRow);
  assert.deepEqual(contentOf(folded[0]), [[text("引擎正文")]]);
});

test("261021 fold: appendUserTurn 幂等判据在折叠层之上仍然成立（重复调用不重复追加）", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("r2", {
    round: 1,
    dedupKey: "r2:engine:round:1",
    roundKey: "r2:round:1",
    messages: [],
    kind: "round",
  });
  await store.appendRound("r2", messageRowFor("r2", 1, 0, msg("assistant", "引擎正文")));
  const first = await appendUserTurn(store, { key: "r2", text: "追问", messageId: "m-1" });
  const before = await store.load("r2");
  const second = await appendUserTurn(store, { key: "r2", text: "追问", messageId: "m-1" });
  const after = await store.load("r2");
  assert.equal(second.dedupKey, first.dedupKey);
  assert.equal(after.length, before.length);
  assert.equal(after.filter((r) => r.dedupKey === first.dedupKey).length, 1);
});

const messageRowFor = (run, round, seq, message) => ({
  round,
  seq,
  kind: MESSAGE_ROW_KIND,
  dedupKey: `${run}:msg:${String(round)}:${String(seq)}`,
  messages: [message],
});

// ── 口径 5：partOf 分片接回同一条消息 ─────────────────────────────────────────
test("261021 fold: partOf 指认的分片按 seq 接回同一条消息（一条 user 消息多个 tool_result block）", () => {
  const aggregate = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a1", content: "done-a1" },
      { type: "tool_result", tool_use_id: "a2", content: "done-a2" },
    ],
  };
  const folded = foldMessageRows([
    roundRow(2),
    messageRow(2, 1, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a1", content: "done-a1" }],
    }),
    messageRow(2, 2, { role: "user", content: [{ type: "tool_result", tool_use_id: "a2", content: "done-a2" }] },
      { partOf: `${RUN}:msg:2:1` }),
    messageRow(2, 0, msg("assistant", "轮二正文")),
  ]);
  // 期望值手写：与改造前那条聚合消息逐字相等（分片行不额外产生一条消息）。
  assert.deepEqual(folded[0].messages, [msg("assistant", "轮二正文"), aggregate]);
});

test("261021 fold: partOf 指认的行不在本组（或没指认到）⇒ 分片行按普通消息拼接，不丢正文", () => {
  const folded = foldMessageRows([
    roundRow(3),
    messageRow(3, 0, msg("user", "结果"), { partOf: "r1:msg:9:9" }),
  ]);
  assert.deepEqual(contentOf(folded[0]), [[text("结果")]]);
});

// ── issue #430：`foldLedgerMessages` 的 `partOf` 只认**首片** ─────────────────────────
// 病根（评审定位 + 本单复现）：写侧曾把锚点推进成「刚写那条分片的 `dedupKey`」，于是分片链成
// `t1 ← t2 ← t3`。而折叠对**分片行**也登记 key（`keyToIndex.set(key, entries.length)`），分片不新增
// entry ⇒ 分片的 key 指向「下一条消息的下标」；第三片拿它当 `partOf` 目标时 `entries[targetIndex]`
// 恒为 `undefined` ⇒ 落空 ⇒ 新起一条消息（实测 `[[t1,t2],[t3]]`）。
// 修法在写侧：锚点钉在首片、不随分片推进。本用例钉读侧的**正确输入形状**（三片都指向首片）
// 必须折成两条消息（assistant + 一条含三个结果的 user），也就是「同一崩溃轮的所有结果折回一条」。
test("#430 foldLedgerMessages: 三片都 partOf 指向首片 ⇒ 折成 assistant + 一条含 3 个结果的 user", () => {
  const entries = foldLedgerMessages([
    {
      round: 1,
      dedupKey: `${RUN}:msg:1:0`,
      kind: MESSAGE_ROW_KIND,
      seq: 0,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "work", input: {} }] }],
    },
    { round: 1, dedupKey: `${RUN}:msg:1:1`, kind: MESSAGE_ROW_KIND, seq: 1, messages: [{ role: "user", content: [toolResult("t1")] }] },
    {
      round: 1,
      dedupKey: `${RUN}:msg:1:2`,
      kind: MESSAGE_ROW_KIND,
      seq: 2,
      partOf: `${RUN}:msg:1:1`,
      messages: [{ role: "user", content: [toolResult("t2")] }],
    },
    {
      round: 1,
      dedupKey: `${RUN}:msg:1:3`,
      kind: MESSAGE_ROW_KIND,
      seq: 3,
      partOf: `${RUN}:msg:1:1`,
      messages: [{ role: "user", content: [toolResult("t3")] }],
    },
  ]);
  assert.equal(entries.length, 2, "三片必须折回**一条** user 消息（不是两条）");
  assert.deepEqual(entries.map((entry) => entry.message.role), ["assistant", "user"]);
  assert.deepEqual(
    entries[1].message.content.map((block) => block.tool_use_id),
    ["t1", "t2", "t3"],
    "聚合消息里三个结果的顺序 = 落盘顺序（首片在前）",
  );
});

// 「条数不限」：契约声称同一崩溃轮的所有结果折回**一条**聚合 `user` 消息，与条数无关。上面那格钉 3 片，
// 这里把 4 片与 5 片也钉住（片数再多也只是同一个形状）。
for (const shardCount of [4, 5]) {
  test(`#430 foldLedgerMessages: ${shardCount} 片都 partOf 指向首片 ⇒ 仍折成一条聚合 user 消息（条数不限）`, () => {
    const ids = Array.from({ length: shardCount }, (_, index) => `t${String(index + 1)}`);
    const rows = [
      {
        round: 1,
        dedupKey: `${RUN}:msg:1:0`,
        kind: MESSAGE_ROW_KIND,
        seq: 0,
        messages: [{
          role: "assistant",
          content: ids.map((id) => ({ type: "tool_use", id, name: "work", input: {} })),
        }],
      },
      ...ids.map((id, index) => ({
        round: 1,
        dedupKey: `${RUN}:msg:1:${String(index + 1)}`,
        kind: MESSAGE_ROW_KIND,
        seq: index + 1,
        ...(index === 0 ? {} : { partOf: `${RUN}:msg:1:1` }),
        messages: [{ role: "user", content: [toolResult(id)] }],
      })),
    ];
    const entries = foldLedgerMessages(rows);
    assert.equal(entries.length, 2, `${shardCount} 片必须折回**一条** user 消息（不是两条/多条）`);
    assert.deepEqual(entries.map((entry) => entry.message.role), ["assistant", "user"]);
    assert.deepEqual(
      entries[1].message.content.map((block) => block.tool_use_id),
      ids,
      "聚合消息里结果的顺序 = 落盘顺序（首片在前）",
    );
  });
}

// 寻址目标**不存在**（`partOf` 指向一条不在账本里的行）：分片按普通消息拼接——正文不许丢，也不许
// 并进别人身上。`foldMessageRows` 那一侧已有同形用例（上面「partOf 指认的行不在本组」），这一格是
// `foldLedgerMessages`（恢复路径真正用的那个口径）的对应证明。
test("#430 foldLedgerMessages: partOf 指认的行不在账本里 ⇒ 分片按普通消息拼接，不丢正文", () => {
  const entries = foldLedgerMessages([
    {
      round: 1,
      dedupKey: `${RUN}:msg:1:0`,
      kind: MESSAGE_ROW_KIND,
      seq: 0,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "work", input: {} }] }],
    },
    {
      round: 1,
      dedupKey: `${RUN}:msg:1:1`,
      kind: MESSAGE_ROW_KIND,
      seq: 1,
      partOf: `${RUN}:msg:9:9`,
      messages: [{ role: "user", content: [toolResult("t1")] }],
    },
  ]);
  assert.equal(entries.length, 2, "寻址目标不存在 ⇒ 分片自己成为一条消息（正文不许丢）");
  assert.deepEqual(entries.map((entry) => entry.message.role), ["assistant", "user"]);
  assert.deepEqual(
    entries[1].message.content.map((block) => block.tool_use_id),
    ["t1"],
    "这一块必须原样在它自己的消息里，不得被并进上一条 assistant",
  );
});

// ── store 侧：两个内置 store 给同一个答案 ────────────────────────────────────
test("261021 fold: file store 与 memory store 的 load() 折叠结果一致，且不改写落盘/内存里的原始行", async () => {
  const rows = [
    roundRow(1),
    messageRow(1, 0, msg("assistant", "正文")),
    messageRow(1, 1, msg("user", "工具结果")),
  ];
  const memory = createMemoryTranscriptStore();
  for (const row of rows) await memory.appendRound(RUN, row);
  const file = createFileTranscriptStore({ dir: await makeTmp("fold-file") });
  for (const row of rows) await file.appendRound(RUN, row);

  const fromMemory = await memory.load(RUN);
  const fromFile = await file.load(RUN);
  assert.deepEqual(fromFile, fromMemory);
  assert.deepEqual(fromMemory.map((r) => r.dedupKey), ["r1:engine:round:1"]);
  assert.deepEqual(contentOf(fromMemory[0]), [[text("正文")], [text("工具结果")]]);
  // 折叠是**读侧纯函数**：反复 load 结果一致，不会把已折的形状再折一遍。
  assert.deepEqual(await memory.load(RUN), fromMemory);
  assert.deepEqual(await file.load(RUN), fromFile);
});

// ── issue #439 A：折叠产出的**每条逻辑消息**带逐条 `ts` ──────────────────────
//
// 病根：折叠把「一行一条消息」的行级 `ts`（`appendMessageRowToTranscript` 每条消息落盘时都写
// `ts: new Date().toISOString()`）丢在行上，只把 `messages` 拼回载体行 ⇒ 宿主拿 `load()` 的结果
// 做时间线/延迟分析时，凡是被折叠过的消息**没有时间戳**（载体行自己的 `ts` 是轮行落盘时刻，
// 不是这条消息成型的时刻）。
// 口径（与 #430 的「锚点钉在首片」同向）：`ts` = 该逻辑消息**首片行**的 `ts`；行上没有 `ts` 时
// **缺键**（不写 `undefined`、不猜值）。
test("#439 fold: 折叠产出的每条逻辑消息带 `ts` = 该消息**首片行**的 `ts`（分片取首片，不是末片）", () => {
  const folded = foldMessageRows([
    roundRow(1, [], { ts: "2026-10-24T00:00:00.000Z" }),
    messageRow(1, 0, msg("assistant", "正文"), { ts: "2026-10-24T00:00:01.000Z" }),
    messageRow(1, 1, { role: "user", content: [toolResult("a1")] }, { ts: "2026-10-24T00:00:02.000Z" }),
    messageRow(1, 2, { role: "user", content: [toolResult("a2")] },
      { ts: "2026-10-24T00:00:03.000Z", partOf: `${RUN}:msg:1:1` }),
  ]);
  assert.deepEqual(folded[0].messages.map((message) => message.ts), [
    "2026-10-24T00:00:01.000Z",
    "2026-10-24T00:00:02.000Z",
  ], "分片折回的那条消息取**首片**（00:00:02）的 ts，不是末片（00:00:03）");
  // 既有键语义一个字不改：正文、角色顺序、载体行自己的 ts 都原样。
  assert.deepEqual(folded[0].messages.map((message) => message.role), ["assistant", "user"]);
  assert.deepEqual(folded[0].messages[1].content.map((block) => block.tool_use_id), ["a1", "a2"]);
  assert.equal(folded[0].ts, "2026-10-24T00:00:00.000Z", "载体行的 ts 是轮行落盘时刻，不参与折叠改写");
});

test("#439 fold: 行上没有 `ts` ⇒ 消息**缺键**（不写 undefined、不猜值）", () => {
  const folded = foldMessageRows([roundRow(1), messageRow(1, 0, msg("assistant", "正文"))]);
  assert.equal(Object.hasOwn(folded[0].messages[0], "ts"), false,
    "手写行/不落 ts 的宿主 store 不该凭空多出一个 `ts: undefined`");
});

test("#439 fold: 内置 store 的 load() 里被分片的消息带首片 ts（file 与 memory 同答案）", async () => {
  const rows = [
    roundRow(1, [], { ts: "2026-10-24T00:00:00.000Z" }),
    messageRow(1, 0, msg("assistant", "正文"), { ts: "2026-10-24T00:00:01.000Z" }),
    messageRow(1, 1, { role: "user", content: [toolResult("a1")] }, { ts: "2026-10-24T00:00:02.000Z" }),
    messageRow(1, 2, { role: "user", content: [toolResult("a2")] },
      { ts: "2026-10-24T00:00:03.000Z", partOf: `${RUN}:msg:1:1` }),
  ];
  const memory = createMemoryTranscriptStore();
  for (const row of rows) await memory.appendRound(RUN, row);
  const file = createFileTranscriptStore({ dir: await makeTmp("fold-ts-file") });
  for (const row of rows) await file.appendRound(RUN, row);

  const expected = ["2026-10-24T00:00:01.000Z", "2026-10-24T00:00:02.000Z"];
  const fromMemory = await memory.load(RUN);
  const fromFile = await file.load(RUN);
  assert.deepEqual(fromMemory[0].messages.map((message) => message.ts), expected);
  assert.deepEqual(fromFile[0].messages.map((message) => message.ts), expected);
  assert.deepEqual(fromFile, fromMemory, "两个内置 store 必须给同一个答案");
});

test("#439 foldLedgerMessages: 恢复路径按**规范化消息**读账本——逐条 `ts` 不进模型上下文", () => {
  // 为什么必须有这一格：`ts` 是档案信封（这条消息什么时候落盘），而 `foldLedgerMessages` 的产物是
  // 恢复上下文。留在这里会让 #326 的折叠摘要复用键（`foldSummaryFingerprint` 的输入就是这些消息）
  // 在 resume 后变一次 ⇒ 同一份折叠输入被重算一次（实测多调一次付费摘要器）。
  const rows = foldMessageRows([
    roundRow(1, [], { ts: "2026-10-24T00:00:00.000Z" }),
    messageRow(1, 0, msg("assistant", "正文"), { ts: "2026-10-24T00:00:01.000Z" }),
    messageRow(1, 1, { role: "user", content: [toolResult("a1")] }, { ts: "2026-10-24T00:00:02.000Z" }),
    messageRow(1, 2, { role: "user", content: [toolResult("a2")] },
      { ts: "2026-10-24T00:00:03.000Z", partOf: `${RUN}:msg:1:1` }),
  ]);
  assert.deepEqual(rows[0].messages.map((message) => message.ts), [
    "2026-10-24T00:00:01.000Z",
    "2026-10-24T00:00:02.000Z",
  ], "前置：折叠结果（load() 面）带逐条 ts");
  const entries = foldLedgerMessages(rows);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(Object.hasOwn(entry.message, "ts"), false, "恢复上下文里不许留档案信封的 ts");
  }
  // 既有键语义一个字不改：正文与角色照旧（只少了那个加法键）。
  assert.deepEqual(entries.map((entry) => entry.message.role), ["assistant", "user"]);
  assert.deepEqual(entries[1].message.content.map((block) => block.tool_use_id), ["a1", "a2"]);
});

// ── issue #439 回归：升级现场（旧版折叠产物 + 原始消息行）正文不许翻倍 ─────────────
//
// 「两份都留」（折好的载体 + 原始消息行）是契约明文承诺的安全形状（`docs/host-consumer-contract.md`
// 的 `### The fold is public API, and the engine covers one fallback (issue #401)` 一节：
// 「which is what keeps the “both copies” shape from doubling the body」）。而 #439 给折叠出的
// 每条消息加了逐条 `ts`：上一版（≤0.24.0 或宿主自研折叠）折出来的**载体行里，消息没有这个键** ⇒
// 若守卫按「逐字段深比较」，升级现场（旧载体 + 新消息行）会判不等 ⇒ 同一轮正文拼第二遍（实测
// 2 条变 4 条：`assistant+user+assistant+user`，正是 #401 R3 治过的坏形状）。
// 守卫判的是「同一段正文是否已折过」，**信封字段（`ts`）不该参与**——它答的是「这条消息什么时候
// 落盘」，不是「这段正文是什么」。
const LEGACY_CARRIER_TS = "2026-10-24T00:00:00.000Z";
const LEGACY_MSG_TS = ["2026-10-24T00:00:01.000Z", "2026-10-24T00:00:02.000Z"];
const textsOf = (record) => record.messages.map((message) => message.content[0].text);

test("#439 升级现场：载体由**旧版折叠**产出（消息不带 `ts`）+ 原始消息行仍在 ⇒ load() 正文不翻倍", async () => {
  const body = [msg("assistant", "正文"), msg("user", "工具结果")];
  // 基线形状：同一份账本**没有**旧载体（消息行照常折）——正文就是这两条。
  const baseline = foldMessageRows([
    roundRow(1),
    messageRow(1, 0, structuredClone(body[0]), { ts: LEGACY_MSG_TS[0] }),
    messageRow(1, 1, structuredClone(body[1]), { ts: LEGACY_MSG_TS[1] }),
  ]);
  assert.deepEqual(baseline[0].messages.map((message) => message.role), ["assistant", "user"],
    "前置：基线形状就是这两条（翻倍前的正确条数）");

  // 升级现场：宿主手里是**上一版 `load()` 的产物**（每条消息都没有 `ts`），原始消息行也还在。
  const legacyRows = [
    roundRow(1, structuredClone(body), { ts: LEGACY_CARRIER_TS }),
    messageRow(1, 0, structuredClone(body[0]), { ts: LEGACY_MSG_TS[0] }),
    messageRow(1, 1, structuredClone(body[1]), { ts: LEGACY_MSG_TS[1] }),
  ];
  const folded = foldMessageRows(structuredClone(legacyRows));
  assert.equal(folded.length, 1, "消息行折进载体行（当重复副本丢弃），只剩一条记录");
  assert.deepEqual(folded[0].messages.map((message) => message.role), ["assistant", "user"],
    `升级现场不得把正文拼第二遍；翻倍时是 assistant+user+assistant+user，实测：${JSON.stringify(folded[0].messages.map((message) => message.role))}`);
  assert.deepEqual(textsOf(folded[0]), textsOf(baseline[0]), "正文与基线逐字相同（既不丢也不翻倍）");

  // store 面：`load()` 才是宿主实际读到的那一层（file 与 memory 必须同答案）。
  const memory = createMemoryTranscriptStore();
  for (const row of structuredClone(legacyRows)) await memory.appendRound(RUN, row);
  const file = createFileTranscriptStore({ dir: await makeTmp("fold-legacy-carrier-file") });
  for (const row of structuredClone(legacyRows)) await file.appendRound(RUN, row);
  const fromMemory = await memory.load(RUN);
  const fromFile = await file.load(RUN);
  assert.deepEqual(fromFile, fromMemory, "两个内置 store 必须给同一个答案");
  assert.equal(fromMemory.length, 1);
  assert.deepEqual(fromMemory[0].messages.map((message) => message.role), ["assistant", "user"],
    `load() 的正文不得翻倍；实测：${JSON.stringify(fromMemory[0].messages.map((message) => message.role))}`);
  assert.deepEqual(textsOf(fromMemory[0]), textsOf(baseline[0]));
});

// ── seq 播种（崩溃重跑幂等，写侧下一单要用） ─────────────────────────────────
test("261021 fold: nextMessageSeqByRound 按轮取 max(seq)+1，忽略无 seq/无 round 的行", () => {
  const next = nextMessageSeqByRound([
    messageRow(1, 0, msg("assistant", "a")),
    messageRow(1, 3, msg("assistant", "b")),
    { round: 2, kind: MESSAGE_ROW_KIND, messages: [msg("user", "追问")] },
    { seq: 7, messages: [] },
    roundRow(9, [msg("assistant", "轮行")]),
  ]);
  assert.deepEqual([...next.entries()], [[1, 4]]);
});
