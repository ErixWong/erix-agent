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
//
// ⚠ issue #790 对本文件的改动（**只改了一格的结局，一条断言都没删、没放宽**）：格 2② 的「紧跟的 user
// 一条结果都没有」那一格，从「run 失败、0 次请求」改成「run 能起来、请求视图合法」——#790 在**请求视图**
// 里为这一类形状插了一张纯 `tool_result` 页（账本仍未修：census 事件与「账本里零桩」两条逐字不动，而
// 「零桩」是本单新加的一条）。同一类的另一形状（相邻两条 assistant）**行为不变**：那一单在
// `normalizeMessages` 合成一条 assistant 后 `t2` 已有结果 ⇒「整单未结清」不成立，插页会把那份真结果
// 挤成孤儿（归 #421 同页合并）——本文件为它补了一条「不许发 `mid_sequence_request_view_stub`」的反向断言。
//
// ⚠ issue #776 对本文件的改动（**只换现场来源，一条断言没删、没放宽**）：格 2③「有锚点而写被拒」原先靠
// 那条被 #754 裁决 2 关掉的 pre-261021 闸门造现场（第二对悬空只在 `snapshot.messages` 里），因此被具名
// 跳过。现在两对悬空都写成 `kind:"message"` 账本行，「写被拒」改由**假 store 拒掉那一写**给出 ⇒
// 本格不再 skip。随之只有该事件的 `detail`/`round` 两个取值换人（`round_not_safe_integer`/`"2"` ⇒
// `append_row_not_persisted`/`3`）：前者在当前树上已**不可达**（取证坐标写在格 2③ 那段注释里，实测与
// 完整推理见 `docs/delivery/261109-776-worker-report.md`；那是 `.gitignore` 里的冷层，干净检出里
// 可能不可解析，所以承重的取证坐标都已抄在本文件里），不是被悄悄改宽——事件必须发、必须恰好一条、
// 必须点名是哪一种，这些一条没动。
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
  MID_SEQUENCE_REQUEST_VIEW_STUB,
  RESUME_JOURNAL_SKIP_DETAIL_APPEND_SKIPPED,
  RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY,
  RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
  NO_EVIDENCE_TOOL_RESULT_TEXT,
  UNPERSISTED_TOOL_RESULT_TEXT,
} from "../src/loop/pending-tool-result.js";
import { validateMessages } from "../src/messages/rounds.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withUnvalidatedAppends } from "./helpers/unvalidated-store.js";
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
  // issue #790 的请求视图兜底**不搭这一格**，而这不是漏做：`normalizeMessages`（每次请求视图都跑）会把
  // 相邻两条 assistant 合成为一条 `assistant[t1, t2]`，而 `t2` 的结果在**再下一页**里 ⇒ 「整单未结清」
  // 不成立 ⇒ 插页会把 `t2` 那份已有结果挤成孤儿。那一支归 #421 的同页合并（在恢复路径里做）。
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB), [],
    "部分结清那一单不许被请求视图插页（插了就会把另一单的真结果弄成孤儿）");
});

test("格2② 紧跟的 user 一条结果都没有 ⇒ detail=aggregate_has_no_tool_result（需要插页那一类）", async () => {
  const inner = createMemoryTranscriptStore();
  await emptyAggregateScene(inner);
  await assertLedgerIsInvalid(inner, /no immediately following user tool_result/u,
    "前置：聚合消息一条 `tool_result` 都没有，必须过不了配对");

  const events = [];
  const provider = createFakeProvider([endTurn("不该被请求")]);
  const resumed = await runLoop({ store: inner, events, provider });
  // ⚠ **issue #790 把这一格的结局从「run 起不来」改成了「run 能起来」**（而账本那一格仍然没修）：
  // 请求视图那一层为「需要插页」这一类形状插了一张纯 `tool_result` 页（主判据在
  // `test/loop-request-view-stub-790.test.js`）。下面那条 census 事件与「账本里一张桩都不许多写」**逐字不动**
  // —— 它们说的都是账本侧，而 #790 只改出网视图。这不是放宽既有断言：它记的是**行为变了**这件事实。
  assert.equal(resumed.ok, true,
    "#790 之后这类形状必须能续起来（修前：`invalid_messages`、0 次请求、该 runId 永久起不来）；实测："
    + String(resumed.error));
  assert.ok(provider.requests.length >= 1,
    `必须**真的**发过模型请求（修前 0 次），实测 ${String(provider.requests.length)}`);
  const stubRows = (await inner.loadRawRows(RUN_ID)).filter((row) => {
    const json = JSON.stringify(row?.messages ?? []);
    return json.includes(UNPERSISTED_TOOL_RESULT_TEXT) || json.includes(NO_EVIDENCE_TOOL_RESULT_TEXT);
  });
  assert.deepEqual(stubRows, [], "视图里插的那一页不许落账：账本里一张桩都不许多写（#790 的硬边界）");
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED), [{
    reason: MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
    detail: MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
    round: 2,
    count: 1,
  }], "必须点名「聚合消息里一条结果都没有」这一格（账本侧的成因，与 #790 无关，逐字不变）");
  assert.equal(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB).length, 1,
    "同一格现在两条事件各有分工：账本没修（上面那条）/ 视图修了（本条）");
});

// ─────── 用例 5（格 2③）：有锚点而写被拒（那一写没落盘）⇒ mid_sequence_stub_row_write_refused ───────

/**
 * **假 store（issue #776）**：把「紧随第一张桩的那一写」拒掉，其余写照常透传（含 `loadRawRows` 探针）。
 *
 * 「拒」的口径**不是**「`appendRound` 返回 `false`」——引擎不看返回值：`persist()`
 * （`src/loop/orchestrator.js#persistClassified`）只在**调用抛错**时算失败（重试到顶就抛
 * `persistence_failed`，本格的结局是「run 仍能起来」，那条路走不得），否则一律 `return true`。
 * 能被 `appendMessageRowToTranscript` 读成「这一写没落盘」的只有 `persist()` 自己返回 `false` 那两条：
 * 持久化没开（本格不可能——恢复本身就要求它），或**写入口这一次读起来不是函数**（能力位那一支，
 * `typeof store?.[method] !== "function"`）。本双取后者：写入口每写成功一张桩就把自己**下一次**读
 * 变成「没有这个能力」⇒ 恰好第二张桩那一写没落盘，其余一字不动。
 *
 * @param {any} inner 真 store（内存实现）
 * @returns {any} 只拒「第二张桩那一写」的 facade
 */
function storeThatRefusesOneStubWrite(inner) {
  const facade = { ...inner };
  let stubWrites = 0;
  let refuseNextWrite = false;
  Object.defineProperty(facade, "appendRound", {
    configurable: true,
    enumerable: true,
    get() {
      if (refuseNextWrite) {
        refuseNextWrite = false;
        return undefined;
      }
      return async (runId, record) => {
        await inner.appendRound(runId, record);
        const isStubRow = JSON.stringify(record?.messages ?? []).includes(UNPERSISTED_TOOL_RESULT_TEXT);
        stubWrites += isStubRow ? 1 : 0;
        if (stubWrites === 1) refuseNextWrite = true;
      };
    },
  });
  return facade;
}

/**
 * 现场（issue #776 重造，断言一条没改口径）：**两对**中段悬空，全部住在新写侧的账本里。
 *   · round 2：`assistant(先跑工具, t1, t2)` + 聚合 `user(t1)` ⇒ `t2` 悬空；
 *   · round 3：`assistant(又跑了一刀, t1, t9)` + 聚合 `user(t1)` ⇒ `t9` 悬空（`t1` 在两轮各出现一次，
 *     provider 的 id 不保证 run 内唯一，issue #284）。
 * 两条聚合消息的**首片行都在** ⇒ 两张桩各自拿得到 `partOf` 锚点（「锚点缺失」那条成因必须不出现）；
 * 两轮轮号都是安全整数 ⇒ 被拒那一张的成因只能是「这一写没落盘」。
 * 旧夹具里第二对**只写在 `snapshot.messages` 里**，靠已退役的 pre-261021 闸门补进上下文（#754
 * 裁决 2 之后不再有那条闸门）；现在两对都是 `kind:"message"` 行 ⇒ 「两张桩都进上下文」不再依赖闸门。
 */
async function twoMidSequencePairsScene(store) {
  await store.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await store.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [toolResultBlock("t1")] }));
  await store.appendRound(RUN_ID, messageRow(3, 0, {
    role: "assistant", content: [text("又跑了一刀"), toolUse("t1"), toolUse("t9")],
  }));
  await store.appendRound(RUN_ID, messageRow(3, 1, { role: "user", content: [toolResultBlock("t1")] }));
  return store;
}

test(
  "格2③ 有锚点而写被拒（那一写没落盘）⇒ 发 reason=mid_sequence_stub_row_write_refused，且那一行真的没落盘",
  async () => {
    // issue #776：本格现场从「pre-261021 升级闸门补快照正文」换成**两对都在账本里**的中段悬空
    // （`twoMidSequencePairsScene`），「写被拒」由假 store 拒掉那一写给出（`storeThatRefusesOneStubWrite`）。
    // **只有 `detail` 与 `round` 两个取值随现场换人**（`round_not_safe_integer`/`"2"` ⇒
    // `append_row_not_persisted`/`3`），断言的形状（恰好一条、点名是哪一种、哪一轮、几个）逐字不动。
    // 被换掉的那个取值不是被删的判据而是**当前树上不可达**的一格，取证见 #776 交付报告
    // （冷层，不入库；承重要点已拄在下面这几行）：
    // 桩所属轮的轮号只来自 `ctx.messageRounds`，而账本来源的轮号被折叠层归成安全整数
    // （`src/store/message-rows.js` 的 `Number.isSafeInteger(record?.round) ? record.round : 0`），
    // 唯一能带非安全整数轮号的消息是 A 集合 push 的那一条（`src/loop/resume-manager.js` 里
    // `ctx.messageRounds.set(replayMessage, crashRound)`），而它**永远拿不到锚点**
    // （`firstSliceRowKeyOf` 要的首片行必须载着同一个 `tool_use_id`，而 A 集合只装账本没结清的 id）
    // ⇒ `partOf` 为空，写侧根本走不到「写被拒」那一步（`src/loop/orchestrator.js` 里
    // `if (typeof stub?.partOf !== "string" || stub.partOf === "") continue;` 先跳过）。
  const inner = createMemoryTranscriptStore();
  await twoMidSequencePairsScene(inner);
  // 前置：这个账本形状本身就过不了严格配对，而过不了的那一句就是本格说的那一句。
  await assertLedgerIsInvalid(inner, /tool_result ids do not match assistant tool_use ids/u,
    "前置：两对聚合消息都少一张结果，配对必须过不了（否则本格测的是别的东西）");

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: storeThatRefusesOneStubWrite(inner),
    events,
    provider,
    executeTool: async () => {
      throw new Error("补跑不该发生：本格的悬空调用没有可重跑的记录（快照里根本没有在飞那一格）");
    },
  });
  assert.equal(resumed.ok, true, "上下文被两张桩修合法了 ⇒ run 能起来（实测：" + String(resumed.error) + ")");
  const messages = provider.requests[0].messages;
  assert.equal(stubBlocks(messages).length, 2,
    `两张桩都进了本次上下文（每一对各一张），实测 ${String(stubBlocks(messages))}`);

  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED), [{
    reason: MID_SEQUENCE_ABANDON_ROW_WRITE_REFUSED,
    detail: RESUME_JOURNAL_SKIP_DETAIL_APPEND_SKIPPED,
    round: 3,
    count: 1,
  }], "必须点名「有锚点而写被拒」这一格，并说清是哪一种（那一写没落盘）");

  const rows = await inner.loadRawRows(RUN_ID);
  const stubRows = rows.filter((row) => typeof row?.partOf === "string" && row.partOf !== "");
  assert.equal(stubRows.length, 1,
    "落盘的桩行**恰好一张**（round 2 那张落了，被拒那张没有）——只有事件、没有这条，就是虚报");
  assert.deepEqual(stubBlocks(stubRows.flatMap((row) => row.messages ?? [])), ["t2"], "落盘的是 round 2 那张");
  assert.deepEqual(skipEvents(events, "mid_sequence_aggregate_row_not_in_ledger"), [],
    "两张桩都有锚点 ⇒ 不许混进「锚点缺失」那条成因（两种放弃对宿主完全不同）");
});

// ─────── 用例 6（重叠语义）：同一个 reason 下的三种成因，用 detail 分开 ───────

/**
 * 中段悬空 + 可选锚点探针的各种形状（issue #714/#729 的三种「拿不到锚点」）。
 *
 * ⚠ issue #811：`aggregateRound` 交非整数（`"2"`）时，这个 store 必须是 `withUnvalidatedAppends`
 * 包过的那一层 —— 写侧守卫现在也认不了那种轮号，它只能来自宿主自研 store / 守卫之前的档案
 * （读侧照旧宽容：行读得回来，只是**不参与折叠**）。
 */
async function danglingWithRoundString(inner, { aggregateRound = 2 }) {
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, {
    role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")],
  }));
  await inner.appendRound(RUN_ID, messageRow(aggregateRound, 1, { role: "user", content: [toolResultBlock("t1")] }));
  return inner;
}

test("#811 裁决 A：宿主 store 交回非整数轮号 ⇒ 不发 `mid_sequence_stub_row_write_refused`、不抛、run 继续", async () => {
  // 现场（issue #811 动机的形状）：宿主自研 store（PG 驱动对 `int8` 默认返回 JS **字符串**）把崩溃轮
  // 那条聚合消息的轮号交成了 `"2"`。写侧守卫管不到它（那道守卫在**内置 store 的写入口**），能管到的
  // 只有读侧。本格钉的是两件事：
  //   ① **不许报成「写被拒」**：`mid_sequence_stub_row_write_refused` 那句话讲的是「store 收了这一行
  //      却没落盘」，而这里 store 根本没被调用过——#811 删掉 `round_not_safe_integer` 那条 detail 之后，
  //      再让轮号不可用走进发射路径，事件就变成假话（只剩 `append_row_not_persisted` 可选）。
  //   ② **不抛、run 继续**：轮号不可用不能把一次续跑变成 run 级致命（读侧对既有档案宽容是 #729 的
  //      契约明文），也不能把桩弄丢（本次上下文的合法性靠它）。
  const store = withUnvalidatedAppends(createMemoryTranscriptStore());
  await danglingWithRoundString(store, { aggregateRound: "2" });
  const events = [];
  const provider = createFakeProvider([endTurn("续")]);
  const resumed = await runLoop({ store, events, provider });
  assert.equal(resumed.ok, true,
    `轮号不可用只是降级，run 必须还能起来（实测：${String(resumed.error)}）`);
  assert.deepEqual(skipEvents(events, "mid_sequence_stub_row_write_refused"), [],
    "轮号不可用不得借用「store 拒了」那个语义（那一写根本没发生 ⇒ 不发射，也不新增取值）");
  assert.deepEqual(skipEvents(events, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
    // 轮号未知（不是 `0`）：#811 第 2 条——折叠层不再猜轮号，事件也就不再拿一个假轮号发言。
    round: undefined,
    count: 1,
  }], "真发生的那件事（拿不到合法锚点）必须照旧如实说");
  assert.deepEqual(stubBlocks(provider.requests[0].messages), ["t2"],
    "桩仍补进本次上下文（合法性不塌：模型看得见「这次调用的结果没了」）");
  const rows = await store.loadRawRows(RUN_ID);
  assert.equal(rows.filter((row) => typeof row?.partOf === "string" && row.partOf !== "").length, 0,
    "零桩行：一轮也不许多写（写入口现在也会当场拒非整数轮号，#811 第 1 条）");
});

test("重叠语义：mid_sequence_aggregate_row_not_in_ledger 用 detail 分出「探针没给」与「账本真没那一行」", async () => {
  // 形状相同，唯一差别是宿主给不给 `loadRawRows`：这两种对宿主是完全不同的处置（补探针 ⇒ 下次闭合）。
  const withProbe = withUnvalidatedAppends(createMemoryTranscriptStore());
  await danglingWithRoundString(withProbe, { aggregateRound: "2" });
  const withProbeEvents = [];
  const first = await runLoop({ store: withProbe, events: withProbeEvents, provider: createFakeProvider([endTurn("续")]) });
  assert.equal(first.ok, true, "桩只修本次上下文，run 仍要能起来（实测：" + String(first.error) + ")");
  assert.deepEqual(skipEvents(withProbeEvents, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
    // #811 第 2 条：折叠层不再把不可用的轮号当 `0` ⇒ 事件里的轮号是**未知**（`undefined`），
    // 而不是一个假轮号。
    round: undefined,
    count: 1,
  }], "探针给了、轮也干净，而账本里没有合法首片行 ⇒ detail 必须是 aggregate_row_not_in_ledger");

  // 同一个 store，把探针摘掉（issue #714 之前那一刻的行为）⇒ detail 必须是 anchor_probe_absent。
  const probeAbsent = { ...withProbe, loadRawRows: undefined };
  delete probeAbsent.loadRawRows;
  const ledger2 = withUnvalidatedAppends(createMemoryTranscriptStore());
  await danglingWithRoundString(ledger2, { aggregateRound: "2" });
  const probeRows = await ledger2.loadRawRows(RUN_ID);
  for (const row of probeRows) await probeAbsent.appendRound(RUN_ID, row);
  const secondEvents = [];
  const second = await runLoop({ store: probeAbsent, events: secondEvents, provider: createFakeProvider([endTurn("续")]) });
  assert.equal(second.ok, true, "探针缺席也只是降级，不失败（实测：" + String(second.error) + ")");
  assert.deepEqual(skipEvents(secondEvents, "mid_sequence_aggregate_row_not_in_ledger"), [{
    reason: "mid_sequence_aggregate_row_not_in_ledger",
    detail: RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
    round: undefined,
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
  // issue #790：「只视图修了、账本仍开着」那一格（新值，中英两份契约同笔到账；为什么不能复用上面那个
  // shape_not_supported：见 `src/loop/pending-tool-result.js` 里那条常量的注释）。
  MID_SEQUENCE_REQUEST_VIEW_STUB,
];
const SOURCE_DETAILS = [
  RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT,
  RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY,
  RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER,
  MID_SEQUENCE_ABANDON_DETAIL_FOREIGN_IDS,
  MID_SEQUENCE_ABANDON_DETAIL_NEXT_NOT_USER,
  MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
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
