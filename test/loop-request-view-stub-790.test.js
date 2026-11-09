// issue #790：恢复侧的「**请求视图**桩」兜底 —— 只改出网那一份视图，账本一个字节都不动。
//
// 病根：#789 把「给账本里悬空的 `tool_use` 补桩」的时机前移到宿主预写用户轮**之前**
// （`src/store/append-user-turn.js`），但仍有两类它管不到：
//   ① 已经砖化的**归档**档案 —— 那条宿主纯文本用户轮早就落盘了，`appendUserTurn` 不会再回来；
//   ② 绕开 `appendUserTurn`、直接 `store.appendRound` 的宿主。
// 两者在下一次续跑时仍旧在**任何请求出网之前**被本库自己的校验器拒掉（0 次 HTTP、`termination: failed`、
// 那个 runId 永久起不来），而账本侧的中段兜底（`answerPendingMidSequenceToolUses`）只会**同页合并**、
// 不会**插页**（#421 纪律 ④）。本单补的就是「插页」那一支，而它只活在交给 provider 的那份数组里。
//
// 三条边界（本文件一半的断言在钉这三条）：
//   · **不调任何 `store.append*` / `saveRunState`** ⇒ 账本文件字节一字不差（用真文件 store 量，不靠声明）；
//   · **不把桩塞进 `ctx.messages`** ⇒ `extractL0Facts(ctx.messages)` 不会把桩当真工具结果（它是扫
//     `tool_result` + `is_error` 的，桩一旦进历史就会被当成「这一轮工具失败了」），
//     `ctx.persistedTranscriptLength` 也不会被虚抬；
//   · **不造混合页** —— 桩必须是**独立的一页**（只装 `tool_result`）。全仓档案里「同时带 `text` 与
//     `tool_result` 的 user 页」是 0 个；并进宿主那一页会 (a) 被 `isRealUser` 当成真 user 轮（#292 I1
//     的判据），(b) 在 OpenAI 转换层被拆成 `user` 然后 `tool`（`src/messages/canonical.js` 的
//     `userToOpenAI`：文本先 flush 才轮到 `role:"tool"`），那个顺序不合法（T7 用真转换器实测两条）。
//
// 措辞二选一（#769 的语义红线）：账本里有该 id 的 `tool-executed` 恢复行 ⇒「执行过、结果没入账」
// （复用 `UNPERSISTED_TOOL_RESULT_TEXT`）；没有 ⇒「未知/无证据」（`NO_EVIDENCE_TOOL_RESULT_TEXT`）。
// **一律写「没执行」是伪报**：执行发生在结果行落盘之前，「没跑」与「跑了而结果没落」在账本里形状相同。
//
// 出声：仍走 `resume_journal_skipped`（**不新增事件类型**），`reason` 用 `mid_sequence_request_view_stub`
// （为什么必须是新值：见 `src/loop/pending-tool-result.js` 里那条常量的注释），`detail` 复用既有两个取值，
// payload 追加**可选** `toolUseIds`（缺席就不带那个键 ⇒ 既有四条事件逐字不变）。
//
// 反向证（issue #210 R2 的规矩）：见 T5 / T6 / T8 三格，红点都写在断言文案里；整层兜底注释掉之后
// 本文件与 `test/loop-resume-abandon-signals-730.test.js` 的红由 `REPORT-790.md` 贴原文。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { callProvider } from "../src/loop/provider-runner.js";
import { validateMessages } from "../src/messages/rounds.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { transcriptPath, createFileTranscriptStore } from "../src/store/file.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { appendUserTurn } from "../src/store/append-user-turn.js";
import { buildToolExecutedRecoveryRow } from "../src/store/recovery-rows.js";
import { canonicalToOpenAIMessages } from "../src/messages/canonical.js";
import { extractL0Facts } from "../src/reflection/l0.js";
import {
  MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
  MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
  MID_SEQUENCE_REQUEST_VIEW_STUB,
  NO_EVIDENCE_TOOL_RESULT_TEXT,
  PENDING_TOOL_RESULT_TEXT,
  UNPERSISTED_TOOL_RESULT_TEXT,
  buildNoEvidenceToolResultStub,
  stubUnsettledToolUsesForRequestView,
} from "../src/loop/pending-tool-result.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withSeed } from "./helpers/run-direct.js";

const RUN_ID = "request-view-stub-790";
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const toolResultBlock = (id, content = `out-${String(id)}`) => ({
  type: "tool_result", tool_use_id: id, content,
});
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });

/** 一条消息行（写侧形状：`kind:"message"` + 轮内 `seq`，与引擎那条折叠判据同源）。 */
const messageRow = (round, seq, message, extra = {}) => ({
  round,
  roundKey: `${RUN_ID}:round:${String(round)}`,
  dedupKey: `${RUN_ID}:msg:${String(round)}:${String(seq)}`,
  kind: "message",
  seq,
  messages: [message],
  ts: "2026-02-01T00:00:00.000Z",
  ...extra,
});

const blocksOf = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));
const typesOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => block?.type);
const shapeOf = (messages) => messages.map((message) => `${message.role}[${typesOf(message).join(",")}]`);
const stubIdsOf = (messages, content) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result"
    && (content === undefined || block?.content === content))
  .map((block) => String(block.tool_use_id));

/**
 * 「**混合页**」判据（本单不许造出第二种）：一条 user 页里同时出现 `text` 与 `tool_result`。
 * 全仓既有档案里这条恒为 0；T6 反过来用它证明「并进宿主那一页」这个错法会红在本判据上。
 */
const mixedPages = (messages) => messages
  .filter((message) => message?.role === "user")
  .filter((message) => {
    const types = typesOf(message);
    return types.includes("text") && types.includes("tool_result");
  });

/**
 * 砖化归档（工单主判据的形状）：`assistant(tool_use)` 后面紧跟一条**只有纯文本**的 user 页，
 * 而它**之后**还有引擎正文 ⇒ 这不是崩溃边界候选（边界要求「之后全是宿主/控制行」），
 * `deriveLedgerCrashBoundary` 判 `null` ⇒ 尾部结清那三支都够不着它，中段兜底又只会同页合并。
 */
async function brickedArchive(store) {
  await store.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await store.appendRound(RUN_ID, messageRow(2, 0, { role: "assistant", content: [toolUse("t1")] }));
  await store.appendRound(RUN_ID, messageRow(2, 1, { role: "user", content: [text("一句文本")] }));
  await store.appendRound(RUN_ID, messageRow(2, 2, { role: "assistant", content: [text("继续")] }));
  return store;
}

/** 跑一次续跑，把失败压成 `{ ok, error }`（`invalid_messages` 是修前的预期路径）。 */
async function resumeRun({ store, provider, events, executeTool }) {
  try {
    const result = await runToolLoop(withSeed({
      provider,
      resume: true,
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
    return { ok: true, finalText: result.finalText, rounds: result.rounds };
  } catch (error) {
    return { ok: false, error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}` };
  }
}

const skipEvents = (events, reason) => events
  .filter((event) => event?.type === "resume_journal_skipped"
    && (reason === undefined || event?.reason === reason))
  .map((event) => ({
    reason: event?.reason,
    detail: event?.detail,
    round: event?.round,
    count: event?.count,
    ...(event?.toolUseIds === undefined ? {} : { toolUseIds: event.toolUseIds }),
  }));

/** 前置判据（每一格都要）：**这个账本形状本身**就过不了严格配对，且过不了的那一句就是本格那一句。 */
async function assertLedgerIsInvalid(store, pattern) {
  const folded = foldLedgerMessages(await store.load(RUN_ID)).map((entry) => entry.message);
  await assert.rejects(async () => validateMessages(folded), pattern,
    "前置：账本形状本身必须过不了严格配对（否则本格测的是别的东西）");
  return folded;
}

// ─────────── T1（工单主判据）：砖化归档 + 真文件 store —— 视图合法、桩夹在中间、账本一字不差 ───────────

test("T1 砖化归档续跑：出网前视图合法（桩夹在 assistant[TU] 与宿主纯文本页之间）且账本文件字节一字不差", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erix-790-t1-"));
  const store = createFileTranscriptStore({ dir });
  await brickedArchive(store);
  // 前置：账本本身过不了配对，且过不了的那一句就是工单那一句（实测 index 1）。
  await assertLedgerIsInvalid(store, /no immediately following user tool_result/u);
  const path = transcriptPath(dir, RUN_ID);
  const bytesBefore = readFileSync(path);

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await resumeRun({ store, provider, events });

  assert.equal(resumed.ok, true, "必须能续起来（修前实测 `invalid_messages`、0 次请求；实测："
    + String(resumed.error) + ")");
  assert.ok(provider.requests.length >= 1, `必须**真的**发过模型请求（修前 0 次），实测 ${String(provider.requests.length)}`);

  const messages = provider.requests[0].messages;
  // 形状断言（**不是**「请求成功了」）：桩页必须夹在**它自己那一单**的 assistant 与宿主纯文本页之间。
  assert.deepEqual(shapeOf(messages), [
    "user[text]",
    "assistant[tool_use]",
    "user[tool_result]",   // ← 本单插的那一页（独立、纯 `tool_result`）
    "user[text]",
    "assistant[text]",
    "user[text]",          // ← 续跑告示（引擎注入，与本单无关）
  ], `请求视图的形状实得：${JSON.stringify(shapeOf(messages))}`);
  assert.deepEqual(stubIdsOf([messages[2]], NO_EVIDENCE_TOOL_RESULT_TEXT), ["t1"],
    "那一页就是 `t1` 的桩，正文逐字 = NO_EVIDENCE_TOOL_RESULT_TEXT（现场没有任何执行证据）");
  assert.deepEqual(mixedPages(messages), [], "视图里不许出现「同时带 `text` 与 `tool_result`」的混合页");
  // 视图本身必须过严格配对 —— 修前死在这一点上（栈落在 `provider-runner.js` 的那次 `validateMessages`）。
  assert.doesNotThrow(() => validateMessages(messages), "打桩之后的**请求视图**必须合法");

  // **账本一字不差**：文件是 append-only 的存储，前缀逐字节相同 ⇒ 已有的每一行都没被重写；
  // 而整个文件里不许出现任何一张桩（两种措辞都不许）⇒ 这一层根本没往账本写东西（不是「写了别的行」）。
  const bytesAfter = readFileSync(path);
  assert.ok(bytesAfter.length >= bytesBefore.length, "append-only：文件只可能变长");
  assert.deepEqual(Buffer.compare(bytesAfter.subarray(0, bytesBefore.length), bytesBefore), 0,
    "续跑之前的那一段必须逐字节相同（本单不许改写已有行）");
  const ledgerText = bytesAfter.toString("utf8");
  assert.ok(!ledgerText.includes(NO_EVIDENCE_TOOL_RESULT_TEXT), "账本里不许出现「无证据」那张桩");
  assert.ok(!ledgerText.includes(UNPERSISTED_TOOL_RESULT_TEXT), "账本里不许出现「执行过」那张桩");
  // 折叠回账本视图仍然过不了配对：**账本没被本单修过**（这件事实由既有那条 census 事件继续说）。
  await assertLedgerIsInvalid(store, /no immediately following user tool_result/u);

  // 出声：补了几条、给哪些 id（新 reason + 既有 detail 词表 + 新增可选 `toolUseIds`）。
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB), [{
    reason: MID_SEQUENCE_REQUEST_VIEW_STUB,
    detail: MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
    round: 3,
    count: 1,
    toolUseIds: ["t1"],
  }], "必须恰好一条，点名「请求视图补了桩」、哪一轮、几个、哪些 id");
  // 既有那条「账本这一格放弃了」必须**照旧**发（本单没把它吞掉，也没改它的形状）。
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED), [{
    reason: MID_SEQUENCE_ABANDON_SHAPE_NOT_SUPPORTED,
    detail: MID_SEQUENCE_ABANDON_DETAIL_AGGREGATE_HAS_NO_RESULT,
    round: 2,
    count: 1,
  }], "账本侧那条 census 事件的形状一字不变（它说的是账本，本单说的是视图 —— 两件事）");
});

// ────────── T2（措辞）：账本 `tool-executed` 恢复行 ⇒「执行过」；没有 ⇒「未知」，绝不写「没执行」 ──────────

test("T2a 账本里有该 id 的 tool-executed 恢复行 ⇒ 措辞是「执行过、结果没入账」（且恢复行不算 tool_result）", async () => {
  const inner = createMemoryTranscriptStore();
  await brickedArchive(inner);
  await inner.appendRecoveryRow(RUN_ID, buildToolExecutedRecoveryRow({
    runId: RUN_ID, round: 2, toolUseId: "t1",
  }));

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await resumeRun({ store: inner, provider, events });
  assert.equal(resumed.ok, true, "实测：" + String(resumed.error));

  const messages = provider.requests[0].messages;
  // #769 判据 1：`kind:"recovery"` 行**不是** `tool_result` 行 ⇒ 这一单仍旧要补桩（恢复了执行证据，
  // 没有恢复结果）。桩在场就是这条判据的证据；正文是另一条。
  assert.deepEqual(stubIdsOf(messages, UNPERSISTED_TOOL_RESULT_TEXT), ["t1"],
    "有执行证据 ⇒ 必须复用既有那句「执行过、结果没入账」（不是新造一句）");
  assert.deepEqual(stubIdsOf(messages, NO_EVIDENCE_TOOL_RESULT_TEXT), [],
    "有证据时不许说「无证据」（同一句事实只有一种说法）");
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB).map((event) => event.toolUseIds),
    [["t1"]], "id 必须交给宿主（措辞换了也不能丢这一格）");
  // 恢复行本身没被折进任何请求页（它 `messages: []`）。
  assert.equal(blocksOf(messages).filter((block) => block?.recoveryEvent !== undefined).length, 0,
    "恢复行不许当成消息进请求视图");
});

test("T2b 没有任何证据 ⇒ 措辞是「未知/无证据」，且三句桩正文互不混用（绝不写「从未执行」）", async () => {
  const inner = createMemoryTranscriptStore();
  await brickedArchive(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  assert.equal((await resumeRun({ store: inner, provider })).ok, true);

  const messages = provider.requests[0].messages;
  const stub = blocksOf(messages).find((block) => block?.type === "tool_result");
  assert.equal(stub?.content, NO_EVIDENCE_TOOL_RESULT_TEXT);
  assert.equal(stub?.is_error, true, "wire 上「没有可用结果」的唯一出口是 `is_error`（与既有两句同口径）");
  assert.ok(!/never executed/iu.test(String(stub?.content)),
    "无证据时不许写成「从未执行」——那是 `PENDING_TOOL_RESULT_TEXT` 的事实，本单没有这个证据");
  assert.notEqual(NO_EVIDENCE_TOOL_RESULT_TEXT, UNPERSISTED_TOOL_RESULT_TEXT, "两句是三件事里的第二件");
  assert.notEqual(NO_EVIDENCE_TOOL_RESULT_TEXT, PENDING_TOOL_RESULT_TEXT, "两句是三件事里的第三件");
  assert.ok(NO_EVIDENCE_TOOL_RESULT_TEXT.startsWith("[erix] "), "引擎自写的 marker 约定（与既有两句一致）");
});

// ───────────── T3（不双结清）：#789 已经结清过的那一单，本单不许再补第二张桩 ─────────────

test("T3 #789 结清过的形状（宿主预写用户轮之前已落结清行）⇒ 请求视图只有一张 t1 结果、本单一声不出", async () => {
  const inner = createMemoryTranscriptStore();
  await inner.appendRound(RUN_ID, messageRow(1, 0, { role: "user", content: [text("任务")] }));
  await inner.appendRound(RUN_ID, messageRow(2, 0, { role: "assistant", content: [toolUse("t1")] }));
  // #789 的那一步：宿主预写用户轮**之前**先结清（结清行 `…:settle:` 在前，宿主纯文本轮在后）。
  await appendUserTurn(inner, { key: RUN_ID, text: "宿主追问", messageId: "m-1" });
  const folded = foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message);
  assert.doesNotThrow(() => validateMessages(folded), "前置：#789 之后这个账本已经**合法**了");

  const events = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  assert.equal((await resumeRun({ store: inner, provider, events })).ok, true);

  const messages = provider.requests[0].messages;
  assert.deepEqual(stubIdsOf(messages, UNPERSISTED_TOOL_RESULT_TEXT), ["t1"],
    "结清行那一张桩原样在场（它就是账本里的那一行）");
  assert.equal(blocksOf(messages).filter((block) => block?.type === "tool_result").length, 1,
    "整份请求里 `t1` 的结果必须**只有一张**（双结清 = 两份事实）");
  assert.equal(blocksOf(messages).filter((block) => block?.content === NO_EVIDENCE_TOOL_RESULT_TEXT).length, 0,
    "已结清的那一单不许被本单再补一张");
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB), [],
    "没有插任何桩 ⇒ 一条事件都不许发（否则宿主读不出「这次真补了」）");
});

// ─── T4（L0 与 `ctx.messages`）：桩只活在视图里；`extractL0Facts(ctx.messages)` 看不见它 ───

test("T4 兜底不改输入数组（逐字）：extractL0Facts(ctx.messages) 里不许出现桩，而视图里有（判据有牙齿）", () => {
  const messages = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1"), toolUse("t2")] },
    { role: "user", content: [text("宿主纯文本")] },
    { role: "assistant", content: [text("继续")] },
  ];
  const snapshot = structuredClone(messages);
  const factsBefore = JSON.stringify(extractL0Facts(messages));

  const view = stubUnsettledToolUsesForRequestView(messages, {});
  assert.notEqual(view.messages, messages, "补了桩就必须交回**新数组**（不许就地改）");
  assert.deepEqual(messages, snapshot, "输入数组必须逐字不变（一个块都不加、一个对象都不改）");
  assert.equal(JSON.stringify(extractL0Facts(messages)), factsBefore,
    "`extractL0Facts(ctx.messages)` 必须逐字不变 —— 桩进了历史就会被当成「这一轮工具失败」的 L0 事实");

  // 牙齿：视图**里**确实有桩 ⇒ 上面那条「不变」不是空断言（塞进历史就会红）。
  assert.deepEqual(stubIdsOf(view.messages, NO_EVIDENCE_TOOL_RESULT_TEXT), ["t1", "t2"],
    "两个 id 一张不少（同一单的桩是**一页**，不是两页）");
  assert.notEqual(JSON.stringify(extractL0Facts(view.messages)), factsBefore,
    "视图里那两张桩会被 L0 看见 —— 所以「不塞进 ctx.messages」是本单的硬边界，不是风格");
  assert.deepEqual(mixedPages(view.messages), []);
  assert.doesNotThrow(() => validateMessages(view.messages));
});

test("T4b 无可补时返回**同一个数组引用**（健康路径逐字等价，一行不多一个对象不多）", () => {
  const messages = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1")] },
    { role: "user", content: [toolResultBlock("t1")] },
    { role: "assistant", content: [text("收口")] },
  ];
  const out = stubUnsettledToolUsesForRequestView(messages, {});
  assert.equal(out.messages, messages, "结清的账本必须拿到同一个引用");
  assert.deepEqual(out.stubs, []);
  // 尾部悬空（`assistant[tool_use]` 是最后一条）也不归本层：那是 #394 / #736 / #789 的三支。
  const tail = messages.slice(0, 2);
  const tailOut = stubUnsettledToolUsesForRequestView(tail, {});
  assert.equal(tailOut.messages, tail, "尾部悬空不许被插页（`allowPendingToolUse: true` 的在飞尾巴同一条判据）");
});

// ─────────────── T5（反向证 a）：桩页放错位置 ⇒ 红在「没有紧随的 tool_result」 ───────────────

test("T5 反向证：把桩页放到宿主纯文本页**之后** ⇒ validateMessages 必须仍旧红在那一句上", () => {
  const wrong = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1")] },
    { role: "user", content: [text("宿主纯文本")] },
    { role: "user", content: [buildNoEvidenceToolResultStub("t1")] },
    { role: "assistant", content: [text("继续")] },
  ];
  // 位置是判据的一部分：桩补了、id 对了、正文对了，仍旧不合法 —— 本单测的从来不是「有没有桩」。
  assert.throws(() => validateMessages(wrong), /no immediately following user tool_result/u,
    "位置放错的桩必须过不了配对（若这条不红，说明本格测的不是位置）");
});

// ───────────── T6（反向证 a'）：并进宿主那一页（混合页）⇒ 红在混合页判据 + OpenAI 顺序 ─────────────

test("T6 反向证：并进宿主纯文本页（混合页）—— 本仓配对放过，但混合页判据与 OpenAI 转换顺序都红", () => {
  const merged = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1")] },
    {
      role: "user",
      content: [text("宿主纯文本"), buildNoEvidenceToolResultStub("t1")],
    },
    { role: "assistant", content: [text("继续")] },
  ];
  // ① 本仓的配对**放过**这种页（紧随的 user 里有该 id 的结果）⇒ 只靠校验器挡不住混合页，
  //    所以本单的断言里有「视图里没有混合页」这一条独立判据。
  assert.doesNotThrow(() => validateMessages(merged));
  assert.equal(mixedPages(merged).length, 1, "混合页判据必须红在这一格上（T1 里它是 0）");

  // ② OpenAI 转换层把混合页拆成 `user` 然后 `tool`：`tool` 不再紧跟带 `tool_calls` 的那条 assistant。
  const wire = canonicalToOpenAIMessages(undefined, merged);
  assert.deepEqual(wire.map((message) => message.role), ["user", "assistant", "user", "tool", "assistant"],
    "混合页在 OpenAI 面就是 `user` 在前、`tool` 在后（实测，`src/messages/canonical.js#userToOpenAI`）");
  // 同一份内容按本单的做法（独立一页）在 OpenAI 面是 `tool` 紧跟 assistant。
  const pure = stubUnsettledToolUsesForRequestView([
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1")] },
    { role: "user", content: [text("宿主纯文本")] },
    { role: "assistant", content: [text("继续")] },
  ], {}).messages;
  assert.deepEqual(canonicalToOpenAIMessages(undefined, pure).map((message) => message.role),
    ["user", "assistant", "tool", "user", "assistant"],
    "独立一页在两个协议面都是「结果紧跟那一单」—— 这就是不许混合页的全部理由");
});

// ───────────── T7（出声的去重与稳定）：同一批桩每轮重补，只报一次；位置跨轮逐字稳定 ─────────────

test("T7 同一批桩每轮都会重补（账本没修）⇒ 事件只报一次；且桩页在两轮请求里的下标逐字相同", async () => {
  const inner = createMemoryTranscriptStore();
  await brickedArchive(inner);
  const events = [];
  const provider = createFakeProvider([
    { content: [toolUse("t9")], stopReason: "tool_use" },
    endTurn("续接完成"),
  ]);
  const resumed = await resumeRun({
    store: inner,
    provider,
    events,
    executeTool: async () => ({ content: "ok", isError: false }),
  });
  assert.equal(resumed.ok, true, "实测：" + String(resumed.error));
  assert.ok(provider.requests.length >= 2, `需要两轮请求，实测 ${String(provider.requests.length)}`);
  assert.deepEqual(skipEvents(events, MID_SEQUENCE_REQUEST_VIEW_STUB).length, 1,
    "同一个 run 里同一批桩只报一条（逐轮重报会把静态事实当噪声——与 #769 对 `listRecoveryRows` 沉默同口径）");
  const firstIndex = provider.requests[0].messages
    .findIndex((message) => typesOf(message).includes("tool_result"));
  const secondIndex = provider.requests[1].messages
    .findIndex((message) => typesOf(message).includes("tool_result"));
  assert.equal(firstIndex, secondIndex,
    "桩页的下标必须跨轮一致：不一致意味着缓存前缀每轮被挪位（前缀复用会整段失效）");
});

// ───────────── T8（反向证 b）：整层兜底不生效时，同一份现场仍旧死在 invalid_messages ─────────────

test("T8 反向证：把这一层去掉（直接吃 ctx.messages）⇒ 同一份现场逐字回到 invalid_messages、0 次请求", async () => {
  const inner = createMemoryTranscriptStore();
  await brickedArchive(inner);
  const folded = await assertLedgerIsInvalid(inner, /no immediately following user tool_result/u);
  // 「去掉这一层」在单元面上的等价形状：校验器吃的就是账本折出来的那份（本单之前的那一行）。
  await assert.rejects(async () => validateMessages(folded), /no immediately following user tool_result/u,
    "去掉兜底 ⇒ 出网前那道本地校验必须仍旧拒掉整份历史（整层注释掉的实跑原文见 REPORT-790.md）");
  // 而且这一层**不产任何写**：`callProvider` 直接跑一遍，账本行数与字节都不许动。
  const before = await inner.loadRawRows(RUN_ID);
  const seen = [];
  const provider = {
    chat: async (request) => {
      seen.push(request.messages);
      return { content: [text("出网了")], stopReason: "end_turn" };
    },
  };
  const events = [];
  await callProvider({
    provider,
    mainSystem: "system",
    messages: folded.map((message) => structuredClone(message)),
    tools: [],
    stream: false,
    cacheStablePrefix: false,
    retryOptions: null,
    retryAttempts: 0,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    emitEvent() {},
    reportObserverError() {},
    awaitWithAbort: (promise) => promise,
    waitForRetry: async () => {},
    estimateMessageTokens: () => 1,
    roundEventDeltas: [],
    finalText: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    latestApiInputTokens: undefined,
    latestApiEstimatedTokens: undefined,
    roundStopReason: undefined,
    executedEvidenceToolIds: new Set(),
    recordRequestViewStub: (entry) => events.push(entry),
  }, { round: 3 });
  assert.equal(seen.length, 1, "必须真的发过一发请求");
  assert.equal(stubIdsOf(seen[0], NO_EVIDENCE_TOOL_RESULT_TEXT).join(), "t1");
  assert.deepEqual(await inner.loadRawRows(RUN_ID), before, "账本一行都不许多（本层不调任何 store 写口）");
  assert.deepEqual(events.map((entry) => entry.stubs.map((stub) => stub.toolUseId)), [["t1"]],
    "回调交出的是事实（几条、哪些 id），发事件归 orchestrator");
});

// ─────────────── T9（结构判据）：落点、唯一构造点、provider-runner 不碰 store ───────────────

const runnerSource = readFileSync(new URL("../src/loop/provider-runner.js", import.meta.url), "utf8");
const pendingSource = readFileSync(new URL("../src/loop/pending-tool-result.js", import.meta.url), "utf8");

test("T9 结构判据：兜底在 normalize 之后 / validate 之前；provider-runner 不碰 store；桩正文定义点唯一", () => {
  const normalizeAt = runnerSource.indexOf("normalizeMessages(ctx.messages)");
  const stubAt = runnerSource.indexOf("stubUnsettledToolUsesForRequestView(ctx.messages");
  const validateAt = runnerSource.indexOf("validateMessages(requestView.messages");
  assert.ok(normalizeAt >= 0 && stubAt > normalizeAt && validateAt > stubAt,
    "顺序必须是 normalize → 插页 → 校验（插在两者中间会插错位置：合并相邻 assistant 改变了「哪一条是那一单的宿主」）");
  assert.ok(runnerSource.includes("ensureUserTurnView(requestMessages, ctx.messages, userTurnGuard)"),
    "#547 T3 钉的那一行必须逐字还在（回补来源仍是未插页的 ctx.messages）");
  // 只改视图这一条边界的**可检查形式**：本层所在文件的**代码**里不许出现任何账本写口。
  // （先剥掉整行注释：本文件的注释里就写着 `store.append*`，不剥就是自己挡自己。）
  const runnerCode = runnerSource.split("\n").filter((line) => !/^\s*\/\//u.test(line)).join("\n");
  for (const forbidden of ["store.append", "appendRound(", "appendMessageRowToTranscript", "saveRunState(", "persist("]) {
    assert.ok(!runnerCode.includes(forbidden), `provider-runner 的代码里不许出现账本写口：${forbidden}`);
  }
  // 两份桩正文的定义点各只有一处，且都只在共享实现里（`buildToolResultFact` 仍是全仓唯一构造点）。
  assert.equal(pendingSource.match(/export const NO_EVIDENCE_TOOL_RESULT_TEXT/gu)?.length, 1);
  assert.equal(pendingSource.match(/buildToolResultFact\(\{[^}]*NO_EVIDENCE_TOOL_RESULT_TEXT/gu)?.length, 1);
  assert.equal(pendingSource.match(/export const UNPERSISTED_TOOL_RESULT_TEXT/gu)?.length, 1);
});
