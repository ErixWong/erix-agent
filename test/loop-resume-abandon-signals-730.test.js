// issue #730：**放弃兜底这条路必须可观测**。
//
// 病根：恢复兜底（给账本里悬空的 `tool_use` 补一张「结果没落盘」的 `tool_result` 桩）有四条**放弃**
// 路径，而只有「锚点缺失」那一条会发 `resume_journal_skipped`。于是宿主读到的只有
// `invalid_messages`（0 次 HTTP、`termination: failed`、这个 runId 永久起不来），分不清
// 「兜底放弃了、这一轮仍需人工修」与「兜底成功了」。四格逐格：
//   ① 判据粒度（`src/loop/resume-manager.js`）：`midSequenceSettledIds` 原来是**全 run** 的账本 id
//      集合，而 `validateMessages`（`src/messages/rounds.js`）是**逐对**比 id 集合 ⇒ 「别的轮结清过
//      同一个 id」把这一对的桩抑制掉了 ⇒ 这一对永不闭合。收窄成「这一对的聚合消息里是否已有该 id
//      的结果块」（用例 1 的现场就是 id 在两轮各出现一次）。
//   ② 普查判它悬空，而 `mergeToolResultsIntoAssistantNextMessage` 返回 `false`（聚合消息串了味）
//      ⇒ 修前直接 `continue`（用例 2）。
//   ③ 非目标形状：紧跟的 user 一条结果都没有 / 相邻两条 assistant ⇒ 修前根本不进判据（用例 3、4）。
//   ④ `appendMessageRowToTranscript` 对非安全整数轮号 `return undefined` ⇒ 修前调用方一声不响
//      （用例 5）。
// 外加一格语义重叠：`mid_sequence_aggregate_row_not_in_ledger` 原来混着三件不同的事（探针没给 /
// 该轮载体已带正文 / 账本真没有那一行），只有第一种是「宿主补上 `loadRawRows` 就能闭合」——现在用
// `detail` 分细（用例 6）。
//
// **没有新增事件类型**：这些成因全部骑在 `resume_journal_skipped`（issue #743 分级表里的 `fact`，
// 不可删）上，只加 `reason` 取值与可选 `detail`（缺席就不带那个键 ⇒ 纯加法）。用例 7 把这条边界
// 钉住：`reason`/`detail` 闭集与中英两份契约的表**双向**对账，少一边就红。
//
// 反向证（issue #210 R2 的规矩）：每格都把新增的发射/收窄代码拿掉跑过，红在**本格**那条断言上，
// 原文贴在 `/tmp/report-730.md`。不许 skip、不许放宽既有断言。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { EVENT_TIERS } from "../src/loop/event-tiers.js";
import {
  MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
  MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS,
  MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER,
  MID_SEQUENCE_ABANDON_MERGE_REFUSED,
  MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED,
  MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
  RESUME_JOURNAL_SKIP_DETAIL_APPEND_SKIPPED,
  RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY,
  RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_NOT_SAFE_INTEGER,
  UNPERSISTED_TOOL_RESULT_TEXT,
} from "../src/loop/pending-tool-result.js";
import { validateMessages } from "../src/messages/rounds.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

const RUN_ID = "resume-abandon-signals-730";
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const toolResultBlock = (id) => ({ type: "tool_result", tool_use_id: id, content: `out-${String(id)}` });
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });

/** 一条消息行（写侧形状：`kind:"message"` + 轮内 `seq`，折叠层的两把钥匙都在）。 */
const messageRow = (round, seq, message, extra = {}) => ({
  round,
  roundKey: `${RUN_ID}:round:${String(round)}`,
  dedupKey: `${RUN_ID}:msg:${String(round)}:${String(seq)}`,
  kind: "message",
  seq,
  messages: [message],
  ts: new Date().toISOString(),
  ...extra,
});

/** 跑一次 runToolLoop，把失败压成 `{ ok, error }`（`invalid_messages` 是预期路径）。 */
async function runLoop({ store, provider, executeTool, resume = true, events }) {
  try {
    const result = await runToolLoop(withSeed({
      provider,
      resume,
      store,
      runId: RUN_ID,
      tools: TOOLS,
      completion: false,
      wrapup: false,
      stallDetection: false,
      maxRounds: 8,
      ...(events === undefined ? {} : { capabilities: { hooks: { onEvent: (event) => events.push(event) } } }),
      executeTool: executeTool ?? (async () => {
        throw new Error("补跑不该发生：本格的现场里没有可补跑的调用");
      }),
    }));
    return { ok: true, finalText: result.finalText };
  } catch (error) {
    return { ok: false, error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}` };
  }
}

const blocksOf = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));

const stubBlocks = (messages) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result" && block?.content === UNPERSISTED_TOOL_RESULT_TEXT)
  .map((block) => String(block.tool_use_id));

/** 本次 run 发过的 `resume_journal_skipped`（按 `reason` 过滤；`detail` 一并交出）。 */
function skipEvents(events, reason) {
  return events
    .filter((event) => event?.type === "resume_journal_skipped"
      && (reason === undefined || event?.reason === reason))
    .map((event) => ({ reason: event?.reason, detail: event?.detail, round: event?.round, count: event?.count }));
}

/**
 * 前置判据（每一格都要）：**这个账本形状本身**就过不了严格配对，且过不了的那一句就是本格说的那一句。
 * 前置不成立时用例测的是别的东西，所以它红比结论红更要紧。
 */
async function assertLedgerIsInvalid(inner, pattern, why) {
  return assert.rejects(
    async () => validateMessages(foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message)),
    pattern,
    why,
  );
}

// ───────────────────── 用例 1（格 1）：id 在两轮各出现一次 ⇒ 收窄成逐对判据 ─────────────────────

/**
 * 现场：round 2 的 assistant 带 `t1`+`t2`，聚合消息只结了 `t1`（`t2` 中段悬空）；round 3 又发起一次
 * **同 id** 的 `t2` 并正常结清。修前的排除集是全 run 的账本 id 集合 ⇒ `t2` 被当成「已结清」⇒ 桩被
 * 抑制 ⇒ round 2 那一对永不闭合（provider 的 `tool_use_id` 不保证 run 内唯一，issue #284 实测过）。
 */
async function crossRoundDuplicateIdScene(inner) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [toolResultBlock("t1")] }));
  await inner.appendRound(RUN_ID, messageRow(3, 0, { role: "assistant", content: [toolUse("t2")] }));
  await inner.appendRound(RUN_ID, messageRow(3, 1, { role: "user", content: [toolResultBlock("t2")] }));
  return inner;
}

test("格1 别的轮结清过同一个 id ⇒ 这一对仍要补桩、run 仍能起来（修前 invalid_messages、0 请求）", async () => {
  const inner = createMemoryTranscriptStore();
  await crossRoundDuplicateIdScene(inner);
  // 前置：账本形状本身必须真的过不了严格配对（否则本用例测的是别的东西）。
  await assertLedgerIsInvalid(inner, /tool_result ids do not match assistant tool_use ids/u,
    "前置：round 2 那一对（assistant{t1,t2} vs user{t1}）必须过不了逐对配对");

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    events,
    provider,
    executeTool: async () => {
      throw new Error("补跑不该发生：t2 的结果要么在账本里，要么补桩，绝不该重跑");
    },
  });
  assert.equal(resumed.ok, true,
    "收窄之后恢复必须成功（修前实测 `invalid_messages: tool_result ids do not match assistant tool_use ids`、"
    + "0 次请求、该 runId 永久起不来；实测：" + String(resumed.error) + ")");
  assert.ok(provider.requests.length >= 1,
    `必须**真的**发过模型请求（修前 0 次），实测 ${String(provider.requests.length)}`);

  const messages = provider.requests[0].messages;
  // 桩必须补在**它自己那一对**（round 2 的聚合消息）里，且 t1 的真结果原样还在。
  const pairAggregate = messages[2];
  assert.equal(pairAggregate?.role, "user", "round 2 的聚合消息位置变了（夹具与判据不同源了）");
  assert.ok(blocksOf([pairAggregate]).some((block) => block?.type === "tool_result"
    && block.tool_use_id === "t1" && block.content === "out-t1"),
  "t1 的真结果不许被动过");
  assert.deepEqual(stubBlocks([pairAggregate]), ["t2"],
    "t2 的桩必须并进**这一对**的聚合消息（正文逐字 = UNPERSISTED_TOOL_RESULT_TEXT）");
  // 别的轮那份真结果不许被桩顶掉（收窄不是放宽：结清的那一对仍是原样）。
  assert.deepEqual(stubBlocks([messages[3], messages[4]]), [],
    "round 3 那一对已结清，不许出现第二张 t2 桩");

  // 桩落了账：partOf 指向该聚合消息的首片行，下一次 `load()` 折出来就闭合。
  const rows = await inner.loadRawRows(RUN_ID);
  const stubRows = rows.filter((row) => row?.partOf === `${RUN_ID}:msg:2:1`);
  assert.equal(stubRows.length, 1,
    `恰好一行桩行（partOf → 首片 ${RUN_ID}:msg:2:1），实测 ${String(rows
      .filter((row) => row?.partOf !== undefined && row.partOf !== "").map((row) => String(row.dedupKey)))}`);
  assert.deepEqual(stubBlocks(stubRows.flatMap((row) => row.messages ?? [])), ["t2"], "桩行正文就是那张桩");
  const ledgerAfter = foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message);
  assert.doesNotThrow(() => validateMessages(ledgerAfter),
    "桩落账之后账本必须闭合（下一次恢复不再 invalid_messages）");

  // 这一格是**成功兜底**，不是放弃 ⇒ 一条 `resume_journal_skipped` 都不许发（对照后面四格）。
  assert.deepEqual(skipEvents(events), [],
    "成功兜底不许发放弃事件（否则宿主读不出「这次真补上了」与「放弃了」的差别）");
});

// ───────────── 用例 2（格 2①）：普查判悬空、同页合并拒了 ⇒ mid_sequence_merge_refused ─────────────

/**
 * 聚合消息里除 `t1` 还混着**别的单**的 `t3`：`t2` 因此既过不了配对（`validateMessages` 判 id 集合
 * 不匹配），也并进不去（`mergeToolResultsIntoAssistantNextMessage` 的「已有结果必须都属于这一单」
 * 守卫）。`t1` 在场很要紧：它让这条 assistant **不是**崩溃边界候选（边界要求「全部未结清」，
 * `resume-manager.js#deriveLedgerCrashBoundary` 取舍 ①），于是 `t2` 走的是**中段**那条路而不是尾部
 * 结清——本格测的正是中段那格的合并拒绝分支。
 */
async function foreignIdScene(inner) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [toolResultBlock("t1"), toolResultBlock("t3")] }));
  return inner;
}

test("格2① 同页合并拒了（聚合消息串味）⇒ 发 reason=mid_sequence_merge_refused（修前静默、只剩 invalid_messages）", async () => {
  const inner = createMemoryTranscriptStore();
  await foreignIdScene(inner);
  await assertLedgerIsInvalid(inner, /tool_result/u,
    "前置：聚合消息带着外来 id 的 `tool_result`，配对必须过不了");

  const events = [];
  const provider = createFakeProvider([endTurn("不该被请求")]);
  const resumed = await runLoop({ store: inner, events, provider });
  assert.equal(resumed.ok, false,
    "这一格**行为不变**（合并拒了就是补不出合法桩）：run 仍旧失败，本单只加可观测");
  assert.match(resumed.error, /invalid_messages/u, "失败的成因不许变（不是本单改的）");
  assert.equal(provider.requests.length, 0, "仍然 0 次模型请求（修前修后一致）");
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_MERGE_REFUSED), [{
    reason: MID_SEQUENCE_ABANDON_MERGE_REFUSED,
    detail: MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS,
    round: 2,
    count: 1,
  }], "必须恰好一条，点名「合并拒了」这一格、哪一轮、放弃了几个 id");
});

// ─────────── 用例 3／4（格 2②）：非目标形状 ⇒ mid_sequence_shape_not_supported + detail ───────────

/** 相邻两条 assistant（要在那两条之间**插页**）：`t1` 悬空，而形状不是同页合并那一种。 */
async function adjacentAssistantsScene(inner) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, { role: "assistant", content: [toolUse("t1")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "assistant", content: [toolUse("t2")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 2, { role: "user", content: [toolResultBlock("t2")] }));
  return inner;
}

/** 紧跟的 user 一条结果都没有（纯文本）：同样需要插页。 */
async function emptyAggregateScene(inner) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, { role: "assistant", content: [toolUse("t1")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [text("一句文本")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 2, { role: "assistant", content: [text("继续")] }));
  return inner;
}

test("格2② 相邻两条 assistant ⇒ reason=mid_sequence_shape_not_supported + detail=next_message_is_not_user", async () => {
  const inner = createMemoryTranscriptStore();
  await adjacentAssistantsScene(inner);
  await assertLedgerIsInvalid(inner, /no immediately following user tool_result/u,
    "前置：悬空 `tool_use` 后面紧跟的是 assistant，必须过不了配对");

  const events = [];
  const provider = createFakeProvider([endTurn("不该被请求")]);
  const resumed = await runLoop({ store: inner, events, provider });
  assert.equal(resumed.ok, false, "非目标形状仍然补不出来（行为不变）");
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED), [{
    reason: MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
    detail: MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER,
    round: 2,
    count: 1,
  }], "必须点名「紧接的不是 user」这一格（修前这一格连判据都不进）");
});

test("格2② 紧跟的 user 一条结果都没有 ⇒ detail=aggregate_has_no_tool_result（需要插页那一类）", async () => {
  const inner = createMemoryTranscriptStore();
  await emptyAggregateScene(inner);
  await assertLedgerIsInvalid(inner, /no immediately following user tool_result/u,
    "前置：聚合消息一条 `tool_result` 都没有，必须过不了配对");

  const events = [];
  const provider = createFakeProvider([endTurn("不该被请求")]);
  const resumed = await runLoop({ store: inner, events, provider });
  assert.equal(resumed.ok, false, "需要插页 ⇒ 本函数不发明形状，行为不变（纪律 ④）");
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED), [{
    reason: MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
    detail: MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
    round: 2,
    count: 1,
  }], "必须点名「聚合消息里一条结果都没有」这一格");
});

// ─────── 用例 5（格 2③）：有锚点而写被拒（轮号不是安全整数）⇒ mid_sequence_stub_row_write_refused ───────

/**
 * 现场：账本里 round 2 那一对中段悬空（首片行在 ⇒ 锚点找得到），而该轮的正文**同时**由一份
 * `round` 不是整数的 run snapshot 补全过（#758 那种轮号残留形状）⇒ 补出来的第二张桩所属轮的轮号是
 * 字符串 ⇒ `appendMessageRowToTranscript` 直接 `return undefined`。修前这一写被拒一声不响：账本里
 * 没那一行，而宿主以为已经闭合。
 */
async function snapshotRoundResidueScene(inner) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [toolResultBlock("t1")] }));
  await inner.saveRunSnapshot(RUN_ID, {
    runId: RUN_ID,
    round: "2",                                  // ← 轮号残留：不是安全整数
    partialText: "跑到一半",                      // 让快照仍然被认成崩溃现场
    messages: [
      { role: "user", content: [text("任务")] },
      { role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")] },
      { role: "user", content: [toolResultBlock("t1")] },
      { role: "assistant", content: [text("又跑了一刀"), toolUse("t1"), toolUse("t9")] },
      { role: "user", content: [toolResultBlock("t1")] },
    ],
  });
  return inner;
}

test("格2③ 有锚点而写被拒（轮号非安全整数）⇒ 发 reason=mid_sequence_stub_row_write_refused，且那一行真的没落盘", async () => {
  const inner = createMemoryTranscriptStore();
  await snapshotRoundResidueScene(inner);

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    events,
    provider,
    executeTool: async () => {
      throw new Error("补跑不该发生：本格的在飞调用只存在于快照正文里，没有可重跑的记录");
    },
  });
  assert.equal(resumed.ok, true, "上下文被两张桩修合法了 ⇒ run 能起来（实测：" + String(resumed.error) + ")");
  const messages = provider.requests[0].messages;
  assert.equal(stubBlocks(messages).length, 2,
    `两张桩都进了本次上下文（每一对各一张），实测 ${String(stubBlocks(messages))}`);

  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED), [{
    reason: MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED,
    detail: RESUME_JOURNAL_SKIP_DETAIL_ROUND_NOT_SAFE_INTEGER,
    round: "2",
    count: 1,
  }], "必须点名「有锚点而写被拒」这一格，并说清是哪一种（轮号不是安全整数）");

  const rows = await inner.loadRawRows(RUN_ID);
  const stubRows = rows.filter((row) => typeof row?.partOf === "string" && row.partOf !== "");
  assert.equal(stubRows.length, 1,
    "落盘的桩行**恰好一张**（round 2 那张落了，被拒那张没有）——只有事件、没有这条，就是虚报");
  assert.deepEqual(stubBlocks(stubRows.flatMap((row) => row.messages ?? [])), ["t2"], "落盘的是 round 2 那张");
  assert.deepEqual(skipEvents(events, "mid_sequence_aggregate_row_not_in_ledger"), [],
    "两张桩都有锚点 ⇒ 不许混进「锚点缺失」那条成因（两种放弃对宿主完全不同）");
});

// ─────── 用例 6（重叠语义）：同一个 reason 下的三种成因，用 detail 分开 ───────

/** 中段悬空 + 可选锚点探针的各种形状（issue #714/#729 的三种「拿不到锚点」）。 */
async function danglingWithRoundString(inner, { aggregateRound = 2 }) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(aggregateRound, 1, { role: "user", content: [toolResultBlock("t1")] }));
  return inner;
}

test("重叠语义：mid_sequence_aggregate_row_not_in_ledger 用 detail 分出「探针没给」与「账本真没那一行」", async () => {
  // 形状相同，唯一差别是宿主给不给 `loadRawRows`：这两种对宿主是完全不同的处置（补探针 ⇒ 下次闭合）。
  const withProbe = createMemoryTranscriptStore();
  await danglingWithRoundString(withProbe, { aggregateRound: "2" });
  const withProbeEvents = [];
  const first = await runLoop({ store: withProbe, events: withProbeEvents, provider: createFakeProvider([endTurn("续")]) });
  assert.equal(first.ok, true, "桩只修本次上下文，run 仍要能起来（实测：" + String(first.error) + ")");
  assert.deepEqual(skipEvents(withProbeEvents, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
    round: 0,
    count: 1,
  }], "探针给了、轮也干净，而账本里没有合法首片行 ⇒ detail 必须是 aggregate_row_not_in_ledger");

  // 同一个 store，把探针摘掉（issue #714 之前那一刻的行为）⇒ detail 必须是 anchor_probe_absent。
  const probeAbsent = { ...withProbe, loadRawRows: undefined };
  delete probeAbsent.loadRawRows;
  const ledger2 = createMemoryTranscriptStore();
  await danglingWithRoundString(ledger2, { aggregateRound: "2" });
  const probeRows = await ledger2.loadRawRows(RUN_ID);
  for (const row of probeRows) await probeAbsent.appendRound(RUN_ID, row);
  const secondEvents = [];
  const second = await runLoop({ store: probeAbsent, events: secondEvents, provider: createFakeProvider([endTurn("续")]) });
  assert.equal(second.ok, true, "探针缺席也只是降级，不失败（实测：" + String(second.error) + ")");
  assert.deepEqual(skipEvents(secondEvents, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
    round: 0,
    count: 1,
  }], "没有探针时 detail 必须是 anchor_probe_absent（宿主据此才知道该补探针）");
  assert.notDeepEqual(skipEvents(withProbeEvents)[0].detail, skipEvents(secondEvents)[0].detail,
    "同一 reason 下这两种成因必须分得开（这正是本单要点名的那件事）");
});

test("重叠语义：该轮载体已带正文 ⇒ detail=round_carrier_has_body（#729，补探针也闭合不了）", async () => {
  const inner = createMemoryTranscriptStore();
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  // 「两份都留」（issue #401 那节）：折好的轮载体带正文 + 该轮的原始消息行。
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:engine:round:2`,
    ts: new Date().toISOString(),
    messages: [
      { role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")] },
      { role: "user", content: [toolResultBlock("t1")] },
    ],
  });
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [toolResultBlock("t1")] }));

  const events = [];
  const resumed = await runLoop({ store: inner, events, provider: createFakeProvider([endTurn("续")]) });
  assert.equal(resumed.ok, true, "桩只修本次上下文（写进去会把整轮正文拼第二遍）；实测：" + String(resumed.error));
  assert.deepEqual(skipEvents(events, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY,
    round: 2,
    count: 1,
  }], "载体已带正文那一格必须与「探针没给」「账本没那一行」分开（三种成因的处置完全不同）");
  assert.equal((await inner.loadRawRows(RUN_ID)).filter((row) => row?.partOf === `${RUN_ID}:msg:2:1`).length, 0,
    "这一格一行都不许多写（#729：一份翻倍的账比一份还开着的账更坏）");
});

// ─────────────── 用例 7：成因闭集 ↔ 中英两份契约（双向），且没新增事件类型 ───────────────

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONTRACT_EN = "docs/host-consumer-contract.md";
const CONTRACT_CN = "docs/host-consumer-contract_cn.md";
const CONTRACTS = [CONTRACT_EN, CONTRACT_CN];

/** 运行时真会发出的 `reason` 闭集（源码字面量，不是文档字符串）。 */
const SOURCE_REASONS = [
  "crash_round_assistant_not_in_ledger",
  "mid_sequence_aggregate_row_not_in_ledger",
  MID_SEQUENCE_ABANDON_MERGE_REFUSED,
  MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
  MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED,
];
const SOURCE_DETAILS = [
  RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY,
  RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
  MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS,
  MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER,
  MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_NOT_SAFE_INTEGER,
  RESUME_JOURNAL_SKIP_DETAIL_APPEND_SKIPPED,
];

test("成因闭集与中英两份契约双向对账（少一边就红），且本单没新增事件类型", () => {
  assert.ok(Object.hasOwn(EVENT_TIERS, "resume_journal_skipped"),
    "resume_journal_skipped 必须在 #743 分级表里（本单全部成因都骑在它上面）");
  assert.equal(EVENT_TIERS.resume_journal_skipped, "fact",
    "它是 fact：放弃兜底这个决定本身就是记录，不可删档");

  for (const rel of CONTRACTS) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const reason of SOURCE_REASONS) {
      assert.ok(src.includes(`\`${reason}\``), `${rel} 必须写明成因 \`${reason}\`（宿主可读面不能只靠人眼）`);
    }
    for (const detail of SOURCE_DETAILS) {
      assert.ok(src.includes(`\`${detail}\``), `${rel} 必须写明分支码 \`${detail}\``);
    }
    // 反向：契约里那张成因表不许写源码没有的名字（表的第一格是 `` `成因码` ``）。
    for (const line of docReasonRows(src)) {
      assert.ok(
        SOURCE_REASONS.includes(line) || SOURCE_DETAILS.includes(line),
        `${rel} 的成因表写了源码不发的 \`${line}\` —— 要么补发射点，要么从表里删掉`,
      );
    }
  }
});

/** 抽「中段补桩的放弃路径」那一节里成因表的第一格（`` `成因码` ``）。 */
function docReasonRows(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{2,4}\s/.test(line) && /issue\s+#730/iu.test(line));
  assert.notEqual(start, -1, "两份契约里必须有「标题带 issue #730」的那一节（成因表的落脚点）");
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,4}\s/.test(lines[index])) break;
    const line = lines[index];
    if (!line.startsWith("|")) continue;
    const cell = line.split("|").map((part) => part.trim())[1] ?? "";
    const token = /^`([a-z][a-z0-9_]*)`$/u.exec(cell)?.[1];
    if (token !== undefined) rows.push(token);
  }
  assert.ok(rows.length >= SOURCE_REASONS.length + SOURCE_DETAILS.length,
    `那一节的成因表只抽到 ${String(rows.length)} 行（应至少 ${String(SOURCE_REASONS.length + SOURCE_DETAILS.length)} 行）`
    + " —— 表格形状变了或漏了成因");
  return rows;
}
