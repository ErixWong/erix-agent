// issue #736（端到端夹具）：**崩溃边界必须从账本推，不从快照推**。
//
// 现场（#734 的后果放大器，宿主 erix-station 真机两例：会话 `c65cbc0c` 报错 index 659、
// `a2dc7cd2` 7 次同类 `run_end`、index 从 685 漂到 693）：
//   崩溃轮的 `checkpoint_before_tool` 写失败 ⇒ 最新可用快照是**上一轮**那份（latest-only 覆盖写，
//   被拒的那次没落）⇒ 账本里「assistant 行已入账、`tool_result` 永远不会来」这条事实在快照里
//   **看不见** ⇒ `crashSiteRound === false` ⇒ 不裁锚点、不结清尾部 ⇒ 悬空 `tool_use` 落在中段
//   ⇒ #421 的「同页合并」纪律（`pendingMidSequenceToolUses` 的 `results.length === 0`）跳过它
//   ⇒ 每次请求在任何出网之前被本地 `validateMessages` 拒掉（0 token、永久不可用），
//   而用户每重发一次，宿主就多预写一行 ⇒ 洞再往后埋一层。
//
// 本文件的夹具就是那一份账本：**崩溃轮 assistant 行已入账（带 `tool_use`）+ 其后一条宿主
// `:input:` 纯文本预写行 + 一份陈旧但存在的快照（不含那次在飞调用）**。
// 关键前提：快照**陈旧但不是缺失**（缺失那格早就走 `notifyCapabilitySkipped` 那条路了）。
//
// 判据落点：
//   · 判据 1（本文件第一条）：修复前 `invalid_messages` + 0 请求（RED，变异见报告）；修复后恢复成功、
//     上下文里能看到未落账那张桩（`tool_result` + `is_error` + `[erix]` marker）、宿主那句追问在**最后一条**。
//   · 判据 4（本文件第二条）：告示里**不得**出现 `RESUME_NOTICE_NO_PENDING` 那句——修复前它会出现，
//     于是告示对模型说了一句不实的话（账本里明明有未结清的 `tool_use`，只是不在尾部）。
//   · 判据 2（本文件第三条）：正常收口（末轮纯文本 `end_turn` + 宿主追问）⇒ 边界不成立 ⇒
//     不结清、不裁切、告示仍走 `RESUME_NOTICE_NO_PENDING` 那一支。
//   · 判据 3（本文件第四条）：崩溃现场同时被快照认出时，补跑（B 集合）的 id 与桩的 id 照旧互斥
//     （`resume-manager.js` 的 `midSequenceSettledIds` 那格）⇒ 同一条聚合消息里只有一个同 id 结果。
//
// ⚠ 桩的**文案**：工单正文写的是 `UNPERSISTED_TOOL_RESULT_TEXT`（#421 中段那条「执行过但结果没落盘」），
// 而本单规定的出口是既有的**尾部**结清 `answerPendingTailToolUses`（注入告示之前那一步），它写的是
// `PENDING_TOOL_RESULT_TEXT`（「从未执行」）。#734 的现场正是 `sideEffect=not_started`（工具根本没跑），
// 所以尾部那句才是真话。下面按**实际落地的这一句**断言，差异记进报告的 `## 未验证`。
import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { appendUserTurn } from "../src/store/append-user-turn.js";
import { PENDING_TOOL_RESULT_TEXT, UNPERSISTED_TOOL_RESULT_TEXT } from "../src/loop/pending-tool-result.js";
import {
  RESUME_NOTICE_NO_PENDING,
  RESUME_NOTICE_PENDING_HEADER,
} from "../src/loop/resume-notice.js";

const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];
const text = (value) => ({ type: "text", text: value });
const userText = (value) => ({ role: "user", content: [text(value)] });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });

const blocksOf = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));
const resultsFor = (messages, id) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result" && block.tool_use_id === id);

/** 崩溃现场的账本：seed + 崩溃轮载体 + 崩溃轮 assistant 行（带未结清的 `t1`）。 */
async function seedCrashLedger(store, runId) {
  await store.appendRound(runId, {
    round: 0,
    roundKey: `${runId}:round:0`,
    dedupKey: `${runId}:engine:round:0:seed`,
    messages: [userText("任务")],
    ts: new Date().toISOString(),
  });
  await store.appendRound(runId, {
    round: 1,
    roundKey: `${runId}:round:1`,
    dedupKey: `${runId}:engine:round:1`,
    messages: [],
    ts: new Date().toISOString(),
  });
  await store.appendRound(runId, {
    round: 1,
    kind: "message",
    seq: 0,
    dedupKey: `${runId}:msg:1:0`,
    messages: [{ role: "assistant", content: [text("开工"), toolUse("t1")] }],
    ts: new Date().toISOString(),
  });
}

/**
 * #734 的那一份快照：**存在，但不含那次在飞调用**（`checkpoint_before_tool` 被拒 ⇒ latest-only
 * 覆盖写停在更早的那一刻）。`round` 就写崩溃那一轮（同轮更早的一次成功 checkpoint），
 * 但 `pendingToolUses` / `toolResults` / `partialText` 三件**都空** ⇒ 快照侧的 `crashSiteRound` 为假。
 */
function staleSnapshot(runId, round = 1) {
  return {
    round,
    status: "running",
    pendingToolUse: undefined,
    pendingToolUses: [],
    toolResults: [],
    toolOutputs: [],
    executedToolIds: [],
    partialText: undefined,
    partialRound: undefined,
    messages: [{ role: "user", content: [text("任务")] }],
    compactionStats: [],
    persistedTranscriptLength: 1,
    ts: new Date().toISOString(),
  };
}

async function resumeOnce({ store, runId, script = [endTurn("恢复了")], executeTool }) {
  const provider = createFakeProvider(script);
  const outcome = await runDirect({
    provider,
    resume: true,
    store,
    runId,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    executeTool: executeTool ?? (async ({ id }) => `out-${String(id)}`),
  }).then(
    (result) => ({ ok: true, finalText: result.finalText }),
    (error) => ({
      ok: false,
      code: String(error?.code ?? error?.name ?? ""),
      message: String(error?.message ?? error),
    }),
  );
  return { provider, outcome };
}

/** 恢复告示那一行（`noticeDedupKey` = `:control:resume-notice:<hash>`）。 */
async function controlRows(store, runId) {
  const rows = await store.loadRawRows(runId);
  return rows
    .filter((row) => String(row?.dedupKey ?? "").includes(":control:"))
    .map((row) => ({
      key: String(row.dedupKey),
      text: (row.messages ?? [])
        .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
        .filter((block) => block?.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("\n"),
    }));
}

const noticeRows = (rows) => rows.filter((row) => row.key.includes(":control:resume-notice:"));

test("#736 夹具：陈旧快照 + 宿主预写行盖住崩溃现场 ⇒ 修前 invalid_messages，修后走尾部结清", async () => {
  const RUN_ID = "b736-stale-snapshot";
  const store = createMemoryTranscriptStore();
  await seedCrashLedger(store, RUN_ID);
  await store.saveRunSnapshot(RUN_ID, staleSnapshot(RUN_ID));
  await appendUserTurn(store, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  const { provider, outcome } = await resumeOnce({ store, runId: RUN_ID });

  assert.ok(outcome.ok, `恢复必须成功（修前这里是 invalid_messages + 0 请求），实际：${JSON.stringify(outcome)}`);
  assert.equal(provider.requests.length, 1, "修复前那格在任何出网之前就被本地校验器拒掉");

  const sent = provider.requests[0].messages;
  const stubs = resultsFor(sent, "t1");
  assert.equal(stubs.length, 1, "上下文里要有且只有一张 `t1` 的结果桩");
  assert.equal(stubs[0].is_error, true, "桩是 wire 上「这次调用没产出可用结果」的唯一出口");
  assert.equal(String(stubs[0].content), PENDING_TOOL_RESULT_TEXT,
    "尾部结清（`answerPendingTailToolUses`）的正文，以 `[erix]` marker 开头");
  assert.match(String(stubs[0].content), /^\[erix\]/u, "引擎自写：宿主/judge/审计凭 marker 认出这不是工具输出");

  const lastBlocks = blocksOf(sent.slice(-1));
  assert.ok(lastBlocks.some((block) => block?.type === "text"
    && String(block.text).includes("怎么样了？")),
    `宿主那句追问必须仍在最后一条，实际尾部：${JSON.stringify(sent.at(-1))}`);

  // 悬空块由「中段」变成「尾部」⇒ 同页相邻（`validateMessages` 的配对规则）。
  const assistantIndex = sent.findIndex((message) => message?.role === "assistant"
    && blocksOf([message]).some((block) => block?.type === "tool_use"));
  assert.ok(assistantIndex >= 0);
  assert.equal(sent[assistantIndex + 1]?.role, "user");
  assert.deepEqual(blocksOf(sent.slice(assistantIndex + 1, assistantIndex + 2))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id), ["t1"],
    "桩必须紧跟在悬空 `tool_use` 那条 assistant 之后（不是插页，也不是排到宿主行后面）");
});

test("#736 假断言反向钉：本形状的告示**不得**写「崩溃时尾部没有未结清的 tool_use」", async () => {
  const RUN_ID = "b736-notice-truth";
  const store = createMemoryTranscriptStore();
  await seedCrashLedger(store, RUN_ID);
  await store.saveRunSnapshot(RUN_ID, staleSnapshot(RUN_ID));
  await appendUserTurn(store, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  const { outcome } = await resumeOnce({ store, runId: RUN_ID });
  assert.ok(outcome.ok, JSON.stringify(outcome));

  const notices = noticeRows(await controlRows(store, RUN_ID));
  assert.equal(notices.length, 1, `账本里应恰有一条恢复告示，实际：${JSON.stringify(await controlRows(store, RUN_ID))}`);
  assert.ok(!notices[0].text.includes(RESUME_NOTICE_NO_PENDING),
    `告示对模型说了假话（修前的形状）：账本里明明有未结清的 \`t1\`，只是不在尾部。\n${notices[0].text}`);
  assert.ok(notices[0].text.includes(RESUME_NOTICE_PENDING_HEADER));
  assert.ok(notices[0].text.includes("`t1`"),
    `告示必须列出那个未结清的 id，实际：${notices[0].text}`);
});

test("#736 边界在「**根本没有可用快照**」时同样成立（#734 的另一形态：latest 就是读不到）", async () => {
  const RUN_ID = "b736-no-snapshot";
  const base = createMemoryTranscriptStore();
  await seedCrashLedger(base, RUN_ID);
  await appendUserTurn(base, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  // 比「陈旧」更极端：读点存在但**什么都读不到**（首 run 就崩、或 latest 被拒后没有任何可用快照）。
  // 这一格与上面那格合起来才是「与快照的新鲜度/存在性无关」两面；只钉一面时另一面可以随便退回去。
  const store = Object.create(Object.getPrototypeOf(base));
  Object.assign(store, base);
  store.loadLatestRunSnapshot = async () => undefined;

  const provider = createFakeProvider([endTurn("恢复了")]);
  const outcome = await runDirect({
    provider,
    resume: true,
    store,
    runId: RUN_ID,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    executeTool: async ({ id }) => `out-${String(id)}`,
  }).then((result) => ({ ok: true, finalText: result.finalText }),
    (error) => ({ ok: false, code: String(error?.code ?? error?.message ?? error) }));

  assert.ok(outcome.ok, `读不到快照也必须恢复，实际：${JSON.stringify(outcome)}`);
  const sent = provider.requests[0].messages;
  assert.equal(resultsFor(sent, "t1").length, 1, "未结清的 `t1` 仍拿到一张桩");
  const assistantIndex = sent.findIndex((message) => message?.role === "assistant"
    && blocksOf([message]).some((block) => block?.type === "tool_use"));
  assert.equal(sent[assistantIndex + 1]?.role, "user");
  assert.deepEqual(blocksOf(sent.slice(assistantIndex + 1, assistantIndex + 2))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id), ["t1"],
    "桩仍紧跟那条带悬空 `tool_use` 的 assistant（不在中段）");
  assert.ok(blocksOf(sent.slice(-1)).some((block) => block?.type === "text"
    && String(block.text).includes("怎么样了？")), "宿主追问仍在最后一条");
});

test("#736 判据 2：正常收口（末轮纯文本 end_turn + 宿主追问）⇒ 边界不成立、告示走 NO_PENDING 那一支", async () => {
  const RUN_ID = "b736-normal-close";
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN_ID, {
    round: 0, roundKey: `${RUN_ID}:round:0`, dedupKey: `${RUN_ID}:engine:round:0:seed`,
    messages: [userText("任务")], ts: new Date().toISOString(),
  });
  await store.appendRound(RUN_ID, {
    round: 1, roundKey: `${RUN_ID}:round:1`, dedupKey: `${RUN_ID}:engine:round:1`,
    messages: [], ts: new Date().toISOString(),
  });
  await store.appendRound(RUN_ID, {
    round: 1, kind: "message", seq: 0, dedupKey: `${RUN_ID}:msg:1:0`,
    messages: [{ role: "assistant", content: [text("开工"), toolUse("t1")] }],
    ts: new Date().toISOString(),
  });
  await store.appendRound(RUN_ID, {
    round: 1, kind: "message", seq: 1, dedupKey: `${RUN_ID}:msg:1:1`,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out-t1" }] }],
    ts: new Date().toISOString(),
  });
  await store.appendRound(RUN_ID, {
    round: 1, kind: "message", seq: 2, dedupKey: `${RUN_ID}:msg:1:2`,
    messages: [{ role: "assistant", content: [text("做完了")] }],
    ts: new Date().toISOString(),
  });
  await store.saveRunSnapshot(RUN_ID, staleSnapshot(RUN_ID));
  await appendUserTurn(store, { key: RUN_ID, text: "再帮我看看", messageId: "m1" });

  const { provider, outcome } = await resumeOnce({ store, runId: RUN_ID });
  assert.ok(outcome.ok, JSON.stringify(outcome));

  const sent = provider.requests[0].messages;
  assert.equal(resultsFor(sent, "t1").length, 1,
    "结清过的 `t1` 只有一份**真**结果，不许再多一张桩（不结清）");
  assert.ok(!sent.some((message) => String(JSON.stringify(message)).includes(PENDING_TOOL_RESULT_TEXT)),
    "上下文里不许出现尾部结清桩（不结清 = 判据 2 的前半）");
  // 不裁切：seed + assistant[t1] + 结果 + 终稿 + 宿主追问 + 告示（告示在本形状里**排在最后**）。
  assert.deepEqual(sent.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "user", "user"],
    `裁切会把宿主追问挤进尾队列 ⇒ 它会被排到结清桩与告示之前，消息序因此变成 5 条；实际：${JSON.stringify(sent.map((m) => m.role))}`);
  assert.ok(blocksOf([sent[4]]).some((block) => block?.type === "text"
    && String(block.text).includes("再帮我看看")),
    "本形状没裁切 ⇒ 宿主追问留在它原本的位置（告示按 #323 的老行为附在末尾，不是挤到它前面）");

  const notices = noticeRows(await controlRows(store, RUN_ID));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes(RESUME_NOTICE_NO_PENDING),
    `正常收口的告示必须走 NO_PENDING 那一支，实际：${notices[0].text}`);
});

test("#736 钉住现状：恢复成功后**再**恢复一次，同一份账本仍会 invalid_messages（落账顺序归下一单）", async () => {
  const RUN_ID = "b736-second-resume";
  const store = createMemoryTranscriptStore();
  await seedCrashLedger(store, RUN_ID);
  await store.saveRunSnapshot(RUN_ID, staleSnapshot(RUN_ID));
  await appendUserTurn(store, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  const first = await resumeOnce({ store, runId: RUN_ID });
  assert.ok(first.outcome.ok, `第一次恢复（本单修的这格）：${JSON.stringify(first.outcome)}`);

  const second = await resumeOnce({ store, runId: RUN_ID, script: [endTurn("第二次恢复")]});
  // 尾队列的**顺序**问题（工单原文：「那要修的是宿主预写行与它的答复谁先落账」）：结清桩按
  // 「账本里它自己那一轮的一条 `:control:` 行」落账 ⇒ 它排在宿主预写行**之后** ⇒ 折叠出来的
  // 账本又是「assistant[t1] → 宿主正文 → 桩(t1)」，`t1` 重新落回中段。
  // ⚠ 下一单（落账顺序）修好后，这一条断言应**反转**成 `second.outcome.ok === true`。
  assert.equal(second.outcome.ok, false,
    `落账顺序那一单还没做，现状必须是这样；实际：${JSON.stringify(second.outcome)}`);
  assert.match(String(second.outcome.code), /invalid_messages/u);

  const rawRows = await store.loadRawRows(RUN_ID);
  const hostIndex = rawRows.findIndex((row) => String(row?.dedupKey ?? "").includes(":input:"));
  const stubIndex = rawRows.findIndex((row) => String(row?.dedupKey ?? "")
    .endsWith(":control:resume-notice-tool-result"));
  assert.ok(hostIndex >= 0 && stubIndex > hostIndex,
    `结清桩落在宿主预写行**之后**（这就是下一单要修的那一格）：宿主行下标 ${String(hostIndex)}、桩下标 ${String(stubIndex)}，` 
    + `全序：${JSON.stringify(rawRows.map((row) => row.dedupKey))}`);
});

test("#736 边界与快照的**存在性**也无关：store 根本没有快照读点时仍从账本推出边界", async () => {
  const RUN_ID = "b736-no-loader";
  const base = createMemoryTranscriptStore();
  await seedCrashLedger(base, RUN_ID);
  await base.saveRunSnapshot(RUN_ID, staleSnapshot(RUN_ID));
  await appendUserTurn(base, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  // 比「陈旧快照」更极端的一格：store **一个快照读点都没有**（`loadLatestRunSnapshot` 与旧名
  // `loadLatestCheckpoint` 都缺 ⇒ `restoreResume` 走 #78 那条 `notifyCapabilitySkipped`）。
  // 这一格证的是：边界不只在「快照陈旧」时顶得住，而是与快照的存在性彻底无关。
  const store = Object.create(Object.getPrototypeOf(base));
  Object.assign(store, base);
  delete store.loadLatestRunSnapshot;
  delete store.loadLatestCheckpoint;
  assert.equal(typeof store.loadLatestRunSnapshot, "undefined");
  assert.equal(typeof store.loadLatestCheckpoint, "undefined");

  const provider = createFakeProvider([endTurn("恢复了")]);
  const outcome = await runDirect({
    provider,
    resume: true,
    store,
    runId: RUN_ID,
    tools: TOOLS,
    completion: false,
    wrapup: false,
    stallDetection: false,
    maxRounds: 8,
    executeTool: async ({ id }) => `out-${String(id)}`,
  }).then((result) => ({ ok: true, finalText: result.finalText }),
    (error) => ({ ok: false, code: String(error?.code ?? error?.message ?? error) }));

  assert.ok(outcome.ok, `没有快照读点也必须恢复（边界只吃账本），实际：${JSON.stringify(outcome)}`);
  const sent = provider.requests[0].messages;
  assert.equal(resultsFor(sent, "t1").length, 1, "未结清的 `t1` 仍拿到一张桩");
  assert.ok(blocksOf(sent.slice(-1)).some((block) => block?.type === "text"
    && String(block.text).includes("怎么样了？")), "宿主追问仍在最后一条");
  const notices = noticeRows(await controlRows(store, RUN_ID));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes("`t1`") && !notices[0].text.includes(RESUME_NOTICE_NO_PENDING),
    `告示仍必须列出那个未结清的 id，实际：${notices[0]?.text}`);
});

test("#736 判据 3：崩溃现场同时被快照认出 ⇒ 补跑（B 集合）与桩的 id 互斥，一条聚合消息里不出现两个同 id 结果", async () => {
  const RUN_ID = "b736-both-recognize";
  const store = createMemoryTranscriptStore();
  await seedCrashLedger(store, RUN_ID);
  // 快照**认得出**这次在飞调用（`crashSiteRound` 为真，B 集合 = [t1]）。
  await store.saveRunSnapshot(RUN_ID, {
    ...staleSnapshot(RUN_ID),
    pendingToolUse: toolUse("t1"),
    pendingToolUses: [toolUse("t1")],
  });
  await appendUserTurn(store, { key: RUN_ID, text: "怎么样了？", messageId: "m1" });

  const executed = [];
  const { provider, outcome } = await resumeOnce({
    store,
    runId: RUN_ID,
    executeTool: async ({ id }) => {
      executed.push(String(id));
      return `replayed-${String(id)}`;
    },
  });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(executed, ["t1"], "补跑段（B 集合）照旧重跑一次");

  const sent = provider.requests[0].messages;
  assert.deepEqual(resultsFor(sent, "t1").map((block) => String(block.content).split("\n")[0]),
    ["replayed-t1"],
    "同一条聚合消息里只能有一个 `t1` 的结果，且必须是**真**结果而不是桩"
    + "（两个同 id `tool_result` 会把可恢复现场变成不可恢复）");
  assert.ok(!String(JSON.stringify(sent)).includes(PENDING_TOOL_RESULT_TEXT),
    "补跑已经产出真结果 ⇒ 尾部结清必须是空操作（桩不得再占同一个 id）");
  assert.ok(blocksOf(sent.slice(-1)).some((block) => block?.type === "text"
    && String(block.text).includes("怎么样了？")));
});

// 评审（#736 独立评审）留下的唯一缺口：既有「同时被快照认出」那格只有**单个** `tool_use`，
// 而 `resume-manager.js` 里 `midSequenceSettledIds` 那格过滤（把「本进程马上要产出真结果」的
// A/B 两批并进已结清集合）在单调用形状下**删掉也不会红**——实测删掉后 id 数照样是 2、
// `validateMessages` 照样过，只是 `t2` 的**真**结果被一张中段桩顶掉（模型被告知「结果没落盘、
// 结局未知」，而引擎刚刚真的跑出来了）。这一格钉的就是那个顶替：断言面不能只数 id。
test("#736 评审补格：崩溃行带**两个** tool_use（`t1` 已入账、`t2` 待补跑）⇒ `t2` 必须是补跑的真结果，不许被中段桩顶掉", async () => {
  const RUN_ID = "b736-two-calls-one-settled";
  const store = createMemoryTranscriptStore();
  await store.appendRound(RUN_ID, {
    round: 0, roundKey: `${RUN_ID}:round:0`, dedupKey: `${RUN_ID}:engine:round:0:seed`,
    messages: [userText("任务")], ts: new Date().toISOString(),
  });
  await store.appendRound(RUN_ID, {
    round: 1, roundKey: `${RUN_ID}:round:1`, dedupKey: `${RUN_ID}:engine:round:1`,
    messages: [], ts: new Date().toISOString(),
  });
  // 崩溃行：一条聚合 assistant 带**两个** tool_use
  await store.appendRound(RUN_ID, {
    round: 1, kind: "message", seq: 0, dedupKey: `${RUN_ID}:msg:1:0`,
    messages: [{ role: "assistant", content: [text("一次发两个"), toolUse("t1"), toolUse("t2")] }],
    ts: new Date().toISOString(),
  });
  // `t1` 的结果已入账，`t2` 的永远不会来（崩溃在 `t2` 执行之前）
  await store.appendRound(RUN_ID, {
    round: 1, kind: "message", seq: 1, dedupKey: `${RUN_ID}:msg:1:1`,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out-t1" }] }],
    ts: new Date().toISOString(),
  });
  // 快照认得出在飞的 `t2` ⇒ `crashSiteRound` 为真 ⇒ B 集合 = [t2]
  await store.saveRunSnapshot(RUN_ID, {
    ...staleSnapshot(RUN_ID),
    pendingToolUse: toolUse("t2"),
    pendingToolUses: [toolUse("t2")],
  });

  const executed = [];
  const { provider, outcome } = await resumeOnce({
    store,
    runId: RUN_ID,
    executeTool: async ({ id }) => {
      executed.push(String(id));
      return `replayed-${String(id)}`;
    },
  });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(executed, ["t2"], "只有未结清的 `t2` 进补跑段（`t1` 已结清，不得重跑）");

  const sent = provider.requests[0].messages;
  const ids = blocksOf(sent).filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id);
  assert.deepEqual(ids, ["t1", "t2"],
    `每个 id 恰好一个结果（不许出现重复 id 的 tool_result），实际：${JSON.stringify(ids)}`);

  // 同页合并（#421 纪律）：两个结果并排落在**紧随**那条双 `tool_use` assistant 的那条 user 页上
  const assistantIndex = sent.findIndex((message) => message?.role === "assistant"
    && blocksOf([message]).filter((block) => block?.type === "tool_use").length === 2);
  assert.ok(assistantIndex >= 0);
  assert.deepEqual(blocksOf(sent.slice(assistantIndex + 1, assistantIndex + 2))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id), ["t1", "t2"],
    "两个结果必须在同一条聚合 user 消息里、且紧跟那条 assistant");

  assert.equal(String(resultsFor(sent, "t1")[0].content), "out-t1",
    "`t1` 的必须是**账本里那条**真结果，没被桩顶掉");
  assert.equal(String(resultsFor(sent, "t2")[0].content), "replayed-t2",
    "`t2` 的必须是补跑产出的**真**结果 —— 这是本格的全部要点：删掉 `midSequenceSettledIds` 里"
    + "「马上要产出真结果」那一格过滤时，id 数照样对、校验器照样过，只有这条会红（桩顶掉了真结果）");
  assert.ok(!String(JSON.stringify(sent)).includes(UNPERSISTED_TOOL_RESULT_TEXT),
    "上下文里不许出现**中段**桩（「执行过但结果没落盘」）—— 结果刚刚被跑出来了");
  assert.ok(!String(JSON.stringify(sent)).includes(PENDING_TOOL_RESULT_TEXT),
    "上下文里也不许出现**尾部**桩（「从未执行」）");
});
