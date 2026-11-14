// issue #414（探查票）报现场、issue #420 修实现：**A 集合**——崩溃前**已执行完、结果已成型、但账本里
// 没有对应 `tool_result` 行**的那批结果——现在**逐条入账**，与补跑出来的结果（B 集合）走同一条写侧。
//
// 修前的现场（`src/loop/resume-manager.js`）：`restoreResume` 把 A 集合从 run snapshot 的
// `toolResults` 接回来，用 `mergeToolResultsIntoMessages` 合进内存里的 `messages`（合不进去就整条
// push 成一条 user 消息），然后写一句 `ctx.resumeUnpersistedToolResults = replayResults;`，注释称
// 「交给 orchestr 逐条入账」——**全仓没有读取方**。于是它的唯一载体是 latest-only 覆盖写的 run snapshot。
//
// 修后（#420）的三条事实：
//   ① 第一次恢复：A 集合的结果在模型上下文里**恰 1 份、内容逐字相同**，而且账本里也有它的行
//      （用例 1 绿、用例 2 绿）。
//   ② 「账本闭合」这条契约（`docs/host-consumer-contract.md`「A resumed run leaves the ledger closed」）
//      现在对**所有**结果成立，不只是补跑的那批（用例 2）。
//   ③ 再崩一次（新一轮的 run snapshot 是 latest-only 覆盖写 ⇒ 旧 `toolResults` 没了）之后，A 集合的
//      结果从**账本**折回来 ⇒ 上下文仍然合法，run 仍然可恢复（用例 3）。修前这里抛
//      `invalid_messages: tool_result ids do not match assistant tool_use ids`，0 次模型请求，
//      该 runId 永久不可恢复。
//
// 用例 3 的账本顺序断言（`t1, t2, t3` 而不是 `t1, t3, t2`）是**折叠语义的必然结果**，不是放宽：
// A 集合的 `t2` 是**崩溃轮（round 1）**那条聚合 user 消息的分片（`partOf` 指认它），而 `load()` 把
// 每一轮的消息行折回**该轮**的载体行 ⇒ 它必然出现在 round 1 的正文里、早于 round 2 的 `t3`。
// 反向证（脚本实测，两行都打印过）：要让 `t2` 排到 `t3` 之后，只能让 `t2` **不折进** round 1 的聚合
// 消息 —— 那正是 `load()` 形状碎成「assistant / user[t1] / user[t2]」、`t2` 悬在 `t3` 之后的那种坏形状
// （`#420` 明确禁止的「每条结果各自一条 user 消息」）。所以这里把顺序断言改成折出来**必然**是的那一个，
// 并**加**一条形状断言（round 1 的聚合 user 消息同时带着 t1 与 t2）：断言只增不减。
// **不许 skip、不许放宽断言。**
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runToolLoop } from "../src/loop/orchestrator.js";
import {
  PENDING_TOOL_RESULT_TEXT,
  UNPERSISTED_TOOL_RESULT_TEXT,
} from "../src/loop/pending-tool-result.js";
import {
  mergeToolResultsIntoAssistantNextMessage,
  mergeToolResultsIntoMessages,
} from "../src/loop/messages.js";
import { validateMessages } from "../src/messages/rounds.js";
import { foldLedgerMessages } from "../src/store/message-rows.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { withUnvalidatedAppends } from "./helpers/unvalidated-store.js";
import { withSeed } from "./helpers/run-direct.js";
import { makeTmp } from "./helpers/tmp.js";

const RUN_ID = "resume-unpersisted-results";
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];
const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });
const toolTurn = (ids) => ({ content: ids.map(toolUse), stopReason: "tool_use" });

/** 命中谓词的那次 `appendRound` 抛错：模拟进程崩在「快照已写、结果行还没写」那一刻。 */
function crashOnResultRow(inner, toolUseId) {
  let crashed = false;
  const store = {
    ...inner,
    async appendRound(runId, record) {
      const isTarget = record?.kind === "message"
        && (record?.messages ?? []).some((message) => (message?.content ?? [])
          .some((block) => block?.type === "tool_result" && block.tool_use_id === toolUseId));
      if (isTarget && !crashed) {
        crashed = true;
        throw new Error(`simulated crash before ${toolUseId} result row`);
      }
      return inner.appendRound(runId, record);
    },
  };
  return store;
}

const blocksOf = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));

const resultsFor = (messages, toolUseId) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result" && block.tool_use_id === toolUseId);

const ledgerResults = (records) => blocksOf(records.flatMap((record) => record.messages ?? []))
  .filter((block) => block?.type === "tool_result")
  .map((block) => `${String(block.tool_use_id)}=${String(block.content).split("\n")[0]}`);

/** 跑一次 runToolLoop，把失败压成 `{ ok, error }`（崩溃注入与 `invalid_messages` 都是预期路径）。 */
async function runLoop({ store, provider, executeTool, resume = true, initialUserMessage, capabilities }) {
  try {
    const result = await runToolLoop(withSeed({
      provider,
      // #833：本格测的是补跑机制本身 ⇒ 钉住仍受支持的 always-replay 档。
      config: { run: { replayPolicy: "always-replay" } },
      resume,
      store,
      runId: RUN_ID,
      tools: TOOLS,
      completion: false,
      wrapup: false,
      stallDetection: false,
      // 8 而不是 3：预算提示会以「[预算] 本轮后仅剩 N 轮…」的形式拼进最后一条 tool_result
      // 的正文里，那会让「内容逐字相同」这条断言测到别的东西。
      maxRounds: 8,
      ...(initialUserMessage === undefined ? {} : { initialUserMessage }),
      ...(capabilities === undefined ? {} : { capabilities }),
      executeTool,
    }));
    return { ok: true, finalText: result.finalText };
  } catch (error) {
    return { ok: false, error: `${String(error?.code ?? error?.name)}: ${String(error?.message)}` };
  }
}

/**
 * 造出 A 集合现场：两个工具都执行完（`executedToolIds` 与快照 `toolResults` 都有 t1/t2），
 * 但 t2 的结果行在写入点崩掉 ⇒ 账本里只有 t1 的结果。
 */
async function crashWithUnpersistedResult(inner) {
  const store = crashOnResultRow(inner, "t2");
  const first = await runLoop({
    store,
    provider: createFakeProvider([toolTurn(["t1", "t2"])]),
    executeTool: async ({ id }) => `out-${String(id)}`,
    resume: false,
    initialUserMessage: "任务",
  });
  assert.equal(first.ok, false, "前置：第一次运行必须真的崩在 t2 的结果行写入点");
  assert.match(first.error, /simulated crash before t2 result row/u);

  const snapshot = await inner.loadLatestRunSnapshot(RUN_ID);
  assert.deepEqual(snapshot?.toolResults?.map((entry) => entry.toolUseId), ["t1", "t2"],
    "前置：快照里两个工具的结果都已成型（A 集合 = t2）");
  assert.deepEqual(snapshot?.executedToolIds, ["t1", "t2"],
    "前置：两个工具都已执行完（不是 pending 待补跑）");
  const records = await inner.load(RUN_ID);
  assert.deepEqual(ledgerResults(records), ["t1=out-t1"],
    "前置：账本里只有 t1 的结果行 —— t2 就是本票的 A 集合");
  return { snapshot, records };
}

test("#414 A 集合 · 第一次恢复：结果在上下文里恰 1 份、内容逐字相同（由快照兜住，不是账本）", async () => {
  const inner = createMemoryTranscriptStore();
  await crashWithUnpersistedResult(inner);

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    provider,
    // 两个工具都已在 executedToolIds 里 ⇒ 补跑段（B 集合）一条都不该跑。
    executeTool: async () => {
      throw new Error("补跑不该发生：A 集合不是 pending 工具");
    },
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");

  const request = provider.requests[0];
  assert.ok(request !== undefined, "第一次恢复必须真的发过一次模型请求");
  const t2 = resultsFor(request.messages, "t2");
  assert.equal(t2.length, 1, "A 集合的结果在模型上下文里必须恰好一份（既不能丢，也不能翻倍）");
  assert.equal(t2[0].content, "out-t2", "内容必须逐字相同（快照带回来的是原结果，不是占位符）");
  const t1 = resultsFor(request.messages, "t1");
  assert.equal(t1.length, 1, "已落盘的 t1 同样只能有一份（快照回填不能把它再喂一遍）");
  // 形状：两个结果必须在同一条 user 消息里（与 assistant 的两个 tool_use 一一配对）
  const paired = request.messages.find((message) => message?.role === "user"
    && (Array.isArray(message?.content) ? message.content : [])
      .filter((block) => block?.type === "tool_result").length === 2);
  assert.ok(paired !== undefined, "两个结果必须合回同一条聚合 user 消息");
});

test("#414/#420 A 集合 · 第一次恢复就把它的 tool_result 行写进账本（账本闭合）", async () => {
  const inner = createMemoryTranscriptStore();
  await crashWithUnpersistedResult(inner);

  const resumed = await runLoop({
    store: inner,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async () => "unused",
  });
  assert.equal(resumed.ok, true, "前置：第一次恢复成功");

  const records = await inner.load(RUN_ID);
  assert.deepEqual(ledgerResults(records), ["t1=out-t1", "t2=out-t2"],
    "恢复之后账本必须闭合：`t2` 的结果行要落下去（`ctx.resumeUnpersistedToolResults` 是真实交接，"
    + "写入方在 `orchestrator.js#journalResumeUnpersistedToolResults`；修前这里只有 t1 一行）");
  // 形状：`t2` 是崩溃轮那条聚合 user 消息的分片，折回来必须仍是**同一条** user 消息。
  const aggregates = records
    .flatMap((record) => record.messages ?? [])
    .filter((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result"));
  assert.equal(aggregates.length, 1, "两个结果必须折回同一条聚合 user 消息（不是两条）");
  assert.deepEqual(
    aggregates[0].content.filter((block) => block?.type === "tool_result")
      .map((block) => block.tool_use_id),
    ["t1", "t2"],
    "聚合消息里两个结果的顺序 = 崩溃那一刻的真实发生顺序",
  );
});

test("#414 A 集合 · 快照被新一轮覆盖后再恢复：结果不得丢，run 不得因此不可恢复", async () => {
  const inner = createMemoryTranscriptStore();
  await crashWithUnpersistedResult(inner);

  // 第一次恢复：正常跑完（这一轮真的执行了一个工具 ⇒ run snapshot 被本轮覆盖写，
  // 旧快照里的 t2 结果从此不存在了——`saveRunSnapshot` 是 latest-only）。
  const first = await runLoop({
    store: inner,
    provider: createFakeProvider([toolTurn(["t3"]), endTurn("第一次续接完成")]),
    executeTool: async ({ id }) => `out-${String(id)}`,
  });
  assert.equal(first.ok, true, "前置：第一次恢复必须成功");
  const overwritten = await inner.loadLatestRunSnapshot(RUN_ID);
  assert.deepEqual(overwritten?.toolResults?.map((entry) => entry.toolUseId), ["t3"],
    "前置：新一轮的快照只带本轮的结果（A 集合的 t2 已被覆盖掉）");

  // 第二次恢复：账本里 t2 的结果行从没落过，快照里也没了 ⇒ 今天这里直接抛 invalid_messages。
  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({
    store: inner,
    provider,
    executeTool: async () => "unused",
  });
  assert.equal(second.ok, true,
    "第二次恢复必须能起来（今天红在这里：账本里那条 assistant 的 `t2` tool_use 永远没有配对的 "
    + "tool_result，而它不在尾部 ⇒ `pendingTailToolUses` 兜不住；实测失败为 "
    + `\`${String(second.error)}\`）`);
  const t2 = resultsFor(provider.requests[0].messages, "t2");
  assert.equal(t2.length, 1, "第二次恢复之后 A 集合的结果必须仍然恰 1 份");
  assert.equal(t2[0].content, "out-t2", "内容必须逐字相同（不许退化成占位符/中断说明）");
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), ["t1=out-t1", "t2=out-t2", "t3=out-t3"],
    "账本最终必须闭合：三个 tool_use 各有一条结果行。顺序是折叠语义的必然结果：`t2` 属于崩溃轮"
    + "（round 1）那条聚合消息，`load()` 按轮折回载体 ⇒ 它排在 round 2 的 `t3` 之前");
  // 形状（#420 的红线）：崩溃轮的正文必须仍是**一条**聚合 user 消息带着 t1+t2，不能碎成两条。
  const roundOne = (await inner.load(RUN_ID)).find((record) => record?.round === 1
    && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result")));
  const roundOneResults = (roundOne.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => block.tool_use_id);
  assert.deepEqual(roundOneResults, ["t1", "t2"],
    "round 1 的正文里必须同时有 t1 与 t2（同一条聚合 user 消息，不是每条结果各一条）");
});

// ── #420 边界（探查票点名）：崩溃轮**一条结果行都没落** ─────────────────────────────────────────
// 此时 `resumeToolResultRowKey === undefined` ⇒ A 集合的首片**没有载体可接**。修法要求它自己新起一条
// 聚合消息、并成为后续分片（含 B 集合）的 `partOf` 锚点；否则每个结果各起一条 user 消息——形状变了，
// `#326` 的 `<runId>:msg:<round>:<seq>` 序号语义也跟着散掉。

/** 账本里所有「带 tool_result 的 user 消息」（折叠后形状），按出现顺序。 */
const aggregateResults = (records) => records
  .flatMap((record) => record.messages ?? [])
  .filter((message) => (Array.isArray(message?.content) ? message.content : [])
    .some((block) => block?.type === "tool_result"))
  .map((message) => ({
    role: message.role,
    ids: message.content.filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id),
  }));

test("#420 边界 · 崩溃轮零结果行落盘（A 集合没有锚点）：自己当锚点，形状仍是一条聚合消息，再恢复仍成功", async () => {
  const inner = createMemoryTranscriptStore();
  // 单个工具、崩在**它的**结果行写入点 ⇒ 账本里这一轮一条 `tool_result` 行都没有，
  // 也没有 pending 工具（唯一那个已经执行完、结果已成型）。
  const first = await runLoop({
    store: crashOnResultRow(inner, "t1"),
    provider: createFakeProvider([toolTurn(["t1"])]),
    executeTool: async ({ id }) => `out-${String(id)}`,
    resume: false,
    initialUserMessage: "任务",
  });
  assert.equal(first.ok, false, "前置：第一次运行必须真的崩在 t1 的结果行写入点");
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), [],
    "前置：崩溃轮一条结果行都没落（这就是本用例的边界）");
  const snapshot = await inner.loadLatestRunSnapshot(RUN_ID);
  assert.deepEqual(snapshot?.toolResults?.map((entry) => entry.toolUseId), ["t1"],
    "前置：t1 已执行完、结果已成型（A 集合），但账本里没有它的行");

  // 第一次恢复：A 集合从快照接回来并逐条入账。没有锚点 ⇒ 首片自己新起一条聚合消息。
  const resumed = await runLoop({
    store: inner,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async () => {
      throw new Error("补跑不该发生：t1 已执行完（A 集合，不是 pending 工具）");
    },
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");
  const records = await inner.load(RUN_ID);
  assert.deepEqual(ledgerResults(records), ["t1=out-t1"], "A 集合的结果行必须落下去");
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids: ["t1"] }],
    "`load()` 形状必须是**一条**聚合 user 消息带全部结果（不是每条结果各自一条 user 消息）");
  // 形状（不是条数）：round 1 里带 tool_result 的记录必须只有**一条**（分片行被折叠层吸收进载体行），
  // 而且它是载体行（`kind` 不是 `"message"`）——这就是「新起的聚合消息被 `…:resume` 载体收走」。
  const roundOneResults = records.filter((record) => record?.round === 1
    && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result")));
  assert.equal(roundOneResults.length, 1, "round 1 带 tool_result 的记录必须只有一条（不是两条并列）");
  assert.equal(roundOneResults[0].kind, undefined, "折回的是载体行，分片行必须已被折叠层吸收");

  // 第二次恢复：形状没变 ⇒ 折出来的上下文仍然合法，run 仍可恢复，且结果不翻倍。
  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：\`${String(second.error)}\`）`);
  const t1 = resultsFor(provider.requests[0].messages, "t1");
  assert.equal(t1.length, 1, "A 集合的结果在第二次恢复后必须仍恰 1 份");
  assert.equal(t1[0].content, "out-t1", "内容必须逐字相同");
  assert.deepEqual(aggregateResults(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1"] }],
    "第二次恢复之后账本形状不许变（仍是一条聚合 user 消息）");
});

test("#420 边界 · 零结果行 + 还有待补跑工具：A 集合首片当锚点，B 集合接回同一条聚合消息", async () => {
  const inner = createMemoryTranscriptStore();
  // 崩在 t1 的结果行写入点 ⇒ A 集合 = [t1]（无锚点），B 集合 = [t2]（还没执行）。
  const first = await runLoop({
    store: crashOnResultRow(inner, "t1"),
    provider: createFakeProvider([toolTurn(["t1", "t2"])]),
    executeTool: async ({ id }) => `out-${String(id)}`,
    resume: false,
    initialUserMessage: "任务",
  });
  assert.equal(first.ok, false, "前置：第一次运行必须真的崩在 t1 的结果行写入点");
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), [], "前置：一条结果行都没落");

  const resumed = await runLoop({
    store: inner,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async ({ id }) => `out-${String(id)}`,
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");
  const records = await inner.load(RUN_ID);
  assert.deepEqual(ledgerResults(records), ["t1=out-t1", "t2=out-t2"],
    "两个结果各一条行，且顺序 = 真实发生顺序（A 先于 B）");
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids: ["t1", "t2"] }],
    "A 集合首片新起的聚合消息必须同时收下 B 集合（同一条 user 消息，不是两条）");
  const roundOneResults = records.filter((record) => record?.round === 1
    && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result")));
  assert.equal(roundOneResults.length, 1, "round 1 带 tool_result 的记录只有一条（A+B 都折进同一个载体行）");
  assert.equal(roundOneResults[0].kind, undefined, "折回的是载体行，分片行必须已被折叠层吸收");

  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：\`${String(second.error)}\`）`);
  assert.equal(resultsFor(provider.requests[0].messages, "t1").length, 1);
  assert.equal(resultsFor(provider.requests[0].messages, "t2").length, 1);
  assert.deepEqual(aggregateResults(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }]);
});

// ── issue #424（守卫）：升级路径上「崩溃轮的 assistant 正文只在快照里」────────────────────────────
// 现场（独立评审 + 主 agent 复现）：旧账本（崩溃轮的正文从未落盘）+ 快照补全。`restoreResume` 把崩溃轮的
// assistant 正文从快照补进内存 `messages`，但**账本里没有那一行**；#420 的 A 集合入账照样把结果写成
// `kind:"message"` 行 ⇒ 账本里出现「有 `tool_result`、没有配对 `assistant`」的孤儿 ⇒ **下一次恢复**
// 在第一次模型请求之前就 `invalid_messages: user tool_result has no matching assistant tool_use`（0 请求）。
// 守卫：写 A 集合之前先确认崩溃轮在账本里已有 assistant 行（判据是**已折叠的账本条目**）；没有就整段跳过，
// 退回 #420 之前「只进内存、由快照兜住」的语义 ⇒ 账本内容与修前逐字一致。
//
// 三态自证（本用例一次跑完）：
//   ① 加守卫 ⇒ 绿：账本里一条结果行都没有、发一条 `resume_journal_skipped`、二次恢复成功
//     （⚠ issue #754 裁决 2 之后，「成功」的来源换了：那条把崩溃轮正文从快照补进内存的升级路径已被
//      **正式关掉**，二次恢复只从账本重建、并靠恢复告示明示「丢了 N 条」；守卫本身一字未动）；
//   ② 去掉守卫 ⇒ 红：把守卫去掉时**真实会写**的那两行（实测原样，见下面 `msg:2:0` / `msg:2:1`）
//      补回账本 ⇒ 同一个二次恢复当场 `invalid_messages`、0 请求（这就是 RED 的机理）；
//   ③ 修前语义（完全不写）⇒ 也绿：①的账本必须与「只进内存」逐字一致（没有 round 2 正文行）。

const toolResultBlock = (id) => ({ type: "tool_result", tool_use_id: id, content: `out-${id}` });

/** 崩在「resume 段的引擎控制行」写入点：它排在 A 集合入账、`:resume` 载体行之后、第一次模型调用之前。 */
function crashOnControlRow(inner) {
  let fired = false;
  return {
    ...inner,
    async appendRound(runId, record) {
      const key = String(record?.dedupKey ?? record?.roundKey ?? "");
      if (!fired && key.includes(":control:")) {
        fired = true;
        throw new Error("simulated crash after journaling, before first model call");
      }
      return inner.appendRound(runId, record);
    },
  };
}

/**
 * 升级路径现场（issue #424）：旧账本只有 round 1 的载体行（崩溃轮的正文**从没落盘**），
 * 崩溃轮的正文（assistant + t1/t2 两个 `tool_use`）与两个已成型的结果只在 run snapshot 里。
 */
async function upgradePathCrashScene(inner) {
  const roundOneMessages = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [text("第一轮答复")] },
  ];
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: roundOneMessages,
    summary: "missing",
    ts: new Date().toISOString(),
  });
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [...roundOneMessages, {
      role: "assistant",
      content: [text("第二轮"), toolUse("t1"), toolUse("t2")],
    }],
    persistedTranscriptLength: roundOneMessages.length,
    executedToolIds: ["t1", "t2"],
    pendingToolUses: [toolUse("t1"), toolUse("t2")],
    toolResults: [
      { toolUseId: "t1", toolResult: toolResultBlock("t1") },
      { toolUseId: "t2", toolResult: toolResultBlock("t2") },
    ],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });
  return inner;
}

test("#424 升级路径 · 崩溃轮的 assistant 正文只在快照里 ⇒ A 集合整段不入账，二次恢复仍成功（三态自证）", async () => {
  // ── ① 加守卫 ⇒ 绿 ────────────────────────────────────────────────────────────────
  const inner = createMemoryTranscriptStore();
  await upgradePathCrashScene(inner);
  const events = [];
  const first = await runLoop({
    store: crashOnControlRow(inner),
    provider: createFakeProvider([endTurn("第一次续接")]),
    executeTool: async () => {
      throw new Error("补跑不该发生：两个工具都已在 executedToolIds 里（A 集合）");
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(first.ok, false, "前置：第一次恢复必须真的崩在 `:control:` 行");
  assert.match(first.error, /simulated crash after journaling/u);

  const records = await inner.load(RUN_ID);
  assert.deepEqual(ledgerResults(records), [],
    "守卫必须让 A 集合**整段不入账**：账本里一条 tool_result 行都不该有（有就是孤儿）");
  assert.equal(
    records.some((record) => (record.round ?? 0) === 2
      && (record.messages ?? []).some((message) => message?.role === "assistant")),
    false,
    "崩溃轮的 assistant 正文在账本里本就不存在（这是本用例的现场，守卫不许把它补出来）",
  );
  // ③ 修前语义（完全不写）⇒ 也绿：账本必须与 #420 之前逐字一致（round 2 只有那条空 `:resume` 载体行）。
  assert.deepEqual(
    records.map((record) => ({
      round: record.round,
      key: record.dedupKey,
      roles: (record.messages ?? []).map((message) => message.role),
    })),
    [
      { round: 1, key: `${RUN_ID}:engine:round:1`, roles: ["user", "assistant"] },
      { round: 2, key: `${RUN_ID}:engine:round:2:resume`, roles: [] },
    ],
    "跳过之后账本内容必须与 #420 之前逐字一致（那批结果只进内存、由快照兜住 ⇒ 不可能比修前更坏）",
  );
  // 可观测：走既有 `onEvent` 通道，恰一条，说清跳过原因与批大小。
  const skipEvents = events.filter((event) => event?.type === "resume_journal_skipped");
  assert.equal(skipEvents.length, 1, "跳过必须发**一条** `resume_journal_skipped` 事件（既有 onEvent 通道）");
  assert.deepEqual(
    {
      runId: skipEvents[0].runId,
      round: skipEvents[0].round,
      reason: skipEvents[0].reason,
      count: skipEvents[0].count,
    },
    { runId: RUN_ID, round: 2, reason: "crash_round_assistant_not_in_ledger", count: 2 },
    "事件必须点名轮号、跳过原因与 A 集合大小（宿主据此知道这批结果没入账）",
  );

  // 二次恢复（issue #754 裁决 2 之后）：**pre-261021 的档案不再支持恢复** —— 那条「从快照补正文」的
  // 升级路径已被关掉，上下文只从账本重建。结局仍然是**起得来**（守卫的初衷没变），但喂进去的东西变了：
  // 崩溃轮那条 assistant 与它那一轮的两条结果**一条都不喂**（同源同去留），换成恢复告示里一句弃用说明。
  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `二次恢复必须成功（弃用结局 = 明示降级重建，不是 invalid_messages；实测：\`${String(second.error)}\`）`);
  assert.equal(provider.requests.length, 1, "二次恢复必须真的发过一次模型请求");
  for (const id of ["t1", "t2"]) {
    assert.equal(resultsFor(provider.requests[0].messages, id).length, 0,
      `${id} 的结果一条也不许进上下文（它的 assistant 只在那个已不支持的来源里 ⇒ 喂进去就是孤儿结果）`);
  }
  const noticeText = JSON.stringify(provider.requests[0].messages.at(-1));
  assert.match(noticeText, /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 1 条/u,
    `禁止静默：丢正文必须在递给模型的告示里出声并带条数（快照 3 格 - 锚点 2 = 1），实测 ${noticeText.slice(0, 200)}`);

  // ── ② 去掉守卫 ⇒ 红（把守卫去掉时**真实会写**的那两行补回账本，实测原样）──────────────
  // 两行的 dedupKey / seq / partOf 来自实测（`<runId>:msg:2:0` 首片无 `partOf`，`msg:2:1` 接在它后面），
  // 不是手编的坏形状：去掉守卫的代码写的就是这两行。
  const unguarded = createMemoryTranscriptStore();
  for (const record of records) await unguarded.appendRound(RUN_ID, record);
  await unguarded.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "user", content: [toolResultBlock("t1")] }],
    ts: new Date().toISOString(),
  });
  await unguarded.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:1`,
    kind: "message",
    seq: 1,
    partOf: `${RUN_ID}:msg:2:0`,
    messages: [{ role: "user", content: [toolResultBlock("t2")] }],
    ts: new Date().toISOString(),
  });
  const orphanRecords = await unguarded.load(RUN_ID);
  assert.deepEqual(ledgerResults(orphanRecords), ["t1=out-t1", "t2=out-t2"],
    "去掉守卫后账本里就有这两行结果（孤儿：round 2 没有任何 assistant 正文）");
  assert.equal(
    orphanRecords.some((record) => (record.round ?? 0) === 2
      && (record.messages ?? []).some((message) => message?.role === "assistant")),
    false,
    "孤儿判据：这两行所在的 round 2 在账本里没有 assistant 正文",
  );
  const deadProvider = createFakeProvider([endTurn("不该到达")]);
  const third = await runLoop({ store: unguarded, provider: deadProvider, executeTool: async () => "unused" });
  assert.equal(third.ok, false, "去掉守卫 ⇒ 二次恢复必须红（这就是 #424 的 RED）");
  assert.match(third.error, /invalid_messages/u, `实测错误码：\`${String(third.error)}\``);
  assert.match(third.error, /user tool_result has no matching assistant tool_use/u,
    "红的原因必须正是「孤立的结果没有配对的 assistant」（判据在 `src/messages/rounds.js`）");
  assert.equal(deadProvider.requests.length, 0, "红在第一次模型请求之前：0 次请求");
});

// ── issue #754 裁决 2 · **第三刀（同源同去留补完）**的验收面 ──────────────────────────────────
// 判据 1 禁的是 `invalid_messages` 这个**结局**，不是某一个夹具形状。第二刀卡住了「快照里的**结果**呷进
// 上下文」那一个口子，但**在飞的调用**（`snapshot.pendingToolUses`）与崩溃轮正文同批、同来源：旧档案若在
// 崩溃轮留有「执行了、结果没落盘」的调用，复放它 ⇒ 结果被写进一个已经没有配对 `assistant` 的上下文 ⇒
// **同一个结局**（`invalid_messages`、0 次请求），只是换了一格夹具。第三刀用同一把尺子卡住那另一个口子
// （`src/loop/resume-manager.js` 里 `resumePendingTools` 上那道 `toolUseInRebuiltContext`）。
// 本格钉四件事：恢复**起得来**、**真的发出请求**、`invalid_messages` **不出现**、告示**照旧出声**；
// 并钉两条例外不许被顺手改掉：A 集合仍整段交给 #424 守卫（事件面一字不动）、那一轮的副作用**彻底不再补**。
// ⚠ **这是验收格，不是普适不变式**：它只覆盖「满足旧闸门原触发条件、且快照数组长度没撒谎」那一类崩溃
// 现场。`test/loop-snapshot-round-residue-735.test.js` 的 ④b 里那个把 `messages` 截到锚点的变异体
// 仍以 `invalid_messages` 收场（那种载荷谎报长度，写侧从不这么写 ⇒ 它是变异体，不是宿主会遇到的现场）。
test("#754 裁决 2 · 第三刀验收格（非普适不变式）· 旧档案崩溃轮留有未入账的在飞调用 ⇒ 起得来、发出请求、不出 invalid_messages、告示照旧出声", async () => {
  const inner = createMemoryTranscriptStore();
  const roundOneMessages = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [text("第一轮答复")] },
  ];
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: roundOneMessages,
    summary: "missing",
    ts: new Date().toISOString(),
  });
  // 崩溃轮（round 2）：`t1` **执行了但结果没落盘**（结果只在快照的 `toolResults` 里 = A 集合），
  // `t2` **还在飞**（只在 `pendingToolUses` 里，没有结果）。两者所属的那条 assistant 只在快照正文里
  // ⇒ 账本折出 2 条、锚点 2、快照 3 条 ⇒ 条数探针 = 1 ⇒ 这是**旧格式（pre-261021）档案**。
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [...roundOneMessages, {
      role: "assistant",
      content: [text("第二轮"), toolUse("t1"), toolUse("t2")],
    }],
    persistedTranscriptLength: roundOneMessages.length,
    pendingToolUses: [toolUse("t1"), toolUse("t2")],
    executedToolIds: ["t1"],
    toolResults: [{ toolUseId: "t1", toolResult: toolResultBlock("t1") }],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });

  const events = [];
  const executed = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    provider,
    executeTool: async ({ id }) => {
      executed.push(id);
      return `replayed-${String(id)}`;
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  // ① 起得来，且**不是因为**运气：错误原文一并贴进断言消息，红的时候直接看得见是哪一种结局。
  assert.equal(resumed.ok, true,
    `旧档案 + 未入账的在飞调用必须起得来（裁决 2 禁的是 \`invalid_messages\` 这个结局；实测：\`${String(resumed.error)}\`）`);
  assert.doesNotMatch(String(resumed.error ?? ""), /invalid_messages/u,
    "同一个 runId 不许永久起不来：复放出来的结果不许在没有配对 assistant 的上下文里落下孤儿");
  // ② 真的发了请求（不是 0 次请求那种「本地就拒了」）。
  assert.equal(provider.requests.length, 1, "必须真的发出过一次模型请求（`invalid_messages` 的形态是 0 次请求）");
  // ③ 崩那一轮的两批东西一条都不喂：`t1` 的结果（A 集合，正文已不支持）、`t2` 的复放结果（第三刀）。
  for (const id of ["t1", "t2"]) {
    assert.equal(resultsFor(provider.requests[0].messages, id).length, 0,
      `${id} 的结果一条也不许进上下文（它所属的 assistant 只在已不支持的来源里 ⇒ 喂进去就是孤儿结果）`);
  }
  // ④ 出声：递给模型的末条告示必须带那句弃用说明与条数（快照 3 格 - 锚点 2 = 1）。
  assert.match(JSON.stringify(provider.requests[0].messages.at(-1)),
    /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 1 条/u,
    "不许静默：丢了正文必须在递给模型的告示里出声并带条数");
  // ⑤ 代价（认下来）：那一轮的副作用**彻底不再补** —— `t1` 没结果可接、`t2` 不再重跑。
  assert.deepEqual(executed, [],
    "旧档案里那一轮的在飞调用**不再补跑**（裁决 2 认下来的代价；`legacySnapshotBodyDropped === 0` 的新格式档案照旧补跑）");
  // ⑥ 事件面一字不动：A 集合仍**整段**交给 #424 守卫 ⇒ 仍恰一条 `resume_journal_skipped`、`count` 仍是 A 集合大小。
  const skipped = events.filter((event) => event?.type === "resume_journal_skipped");
  assert.deepEqual(skipped.map((event) => ({
    round: event.round, reason: event.reason, count: event.count,
  })), [{ round: 2, reason: "crash_round_assistant_not_in_ledger", count: 1 }],
    "第三刀不许动 #424 的事件面：`ctx.resumeUnpersistedToolResults` 仍拿全量，事件照旧按 A 集合大小报");
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), [],
    "守卫照旧让 A 集合整段不入账 ⇒ 账本里仍一条 `tool_result` 行都没有");
});

test("#424 守卫精度 · 新账本（崩溃轮 assistant 已落盘）照旧入账，不发跳过事件", async () => {
  const inner = createMemoryTranscriptStore();
  await crashWithUnpersistedResult(inner);
  const events = [];
  const resumed = await runLoop({
    store: inner,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async () => "unused",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(resumed.ok, true, "前置：第一次恢复成功");
  assert.equal(events.some((event) => event?.type === "resume_journal_skipped"), false,
    "守卫不得误伤新账本路径：崩溃轮 assistant 已在账本里 ⇒ 照旧入账、不发跳过事件");
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), ["t1=out-t1", "t2=out-t2"],
    "账本照旧闭合（#420 的行为一条都没变）");
});

// ── issue #430：崩溃轮 **≥3 条**结果需要入账时，仍然只折回**一条**聚合 user 消息 ─────────────────
// 现场（独立评审在两棵树上逐字复现，本单在 `main` 上再复现一次）：崩溃轮（round 2）的 assistant 正文
// 已落盘，三个 `tool_use` 一条结果行都没有；结果要么已在快照里（A 集合），要么还在飞（B 集合）。
// 修前两个写入口（A 集合 `journalResumeUnpersistedToolResults`、B 集合补跑段）都是「写完一条就把锚点
// 推进成刚写那条分片的 `dedupKey`」⇒ 分片链成 `t1 ← t2 ← t3`。而折叠对分片行也登记 key、分片却不
// 新增逻辑消息 ⇒ 第三片拿上一片的 key 当 `partOf` 目标时落空 ⇒ 新起一条消息：`load()` 折成
// `[[t1,t2],[t3]]`，第二次恢复**永久** `invalid_messages`（0 请求）。
// 修法：锚点只在**首片**写成功后落定一次，之后一律 `partOf` 指向首片。

/** 把 `appendRound` 的入参抄一份（用来断言**落盘形状**：分片行的 `partOf` 链到哪）。 */
function recordRoundWrites(inner) {
  const rows = [];
  const store = {
    ...inner,
    async appendRound(runId, record) {
      rows.push(record);
      return inner.appendRound(runId, record);
    },
  };
  return { store, rows };
}

/** 某一轮里「带 `tool_result` 的消息行」，按落盘顺序。 */
const resultRowsInRound = (rows, round) => rows.filter((record) => record?.round === round
  && record?.kind === "message"
  && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
    .some((block) => block?.type === "tool_result")));

/** 轮 2 里「带 `tool_result` 的消息行」，按落盘顺序。 */
const resultRowsOf = (rows) => resultRowsInRound(rows, 2);

/**
 * 手搭三工具崩溃现场（与 `upgradePathCrashScene` 同一手法：账本 + 快照逐字段点名，不靠注入时序）：
 *   · round 1 载体行：`user` 任务；
 *   · round 2：**只有** assistant 那一行消息行（三个 `tool_use`），没有任何结果行，也没有轮载体行；
 *   · 快照：`snapshotResultIds` 那批结果已成型（A 集合），`pendingIds` 里未执行的那批还在飞（B 集合）。
 * 崩溃轮 assistant 已在账本里 ⇒ #424 守卫放行，A 集合照常入账（这是本票的现场）。
 */
async function threeToolCrashScene(inner, { snapshotResultIds, pendingIds }) {
  const task = { role: "user", content: [text("任务")] };
  const assistant = {
    role: "assistant",
    content: [text("第二轮"), toolUse("t1"), toolUse("t2"), toolUse("t3")],
  };
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: [task],
    summary: "missing",
    ts: new Date().toISOString(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:0`,
    kind: "message",
    seq: 0,
    messages: [assistant],
    ts: new Date().toISOString(),
  });
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [task, assistant],
    persistedTranscriptLength: 2,
    executedToolIds: [...snapshotResultIds],
    pendingToolUses: pendingIds.map(toolUse),
    toolResults: snapshotResultIds.map((id) => ({ toolUseId: id, toolResult: toolResultBlock(id) })),
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });
  return inner;
}

test("#430 崩溃轮 3 条结果（纯 A 集合）⇒ 折叠后一条聚合 user 消息 [t1,t2,t3]，第二次恢复成功", async () => {
  const inner = createMemoryTranscriptStore();
  await threeToolCrashScene(inner, {
    snapshotResultIds: ["t1", "t2", "t3"],
    pendingIds: ["t1", "t2", "t3"],
  });
  const { store, rows } = recordRoundWrites(inner);
  const resumed = await runLoop({
    store,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async () => {
      throw new Error("补跑不该发生：三个工具都已在 executedToolIds 里（A 集合）");
    },
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");

  const records = await inner.load(RUN_ID);
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "三条结果必须折回**一条**聚合 user 消息（修前实测 `[[t1,t2],[t3]]`，两条）");
  // 落盘形状（修法本体）：首片无 `partOf`，后两片**都**指向首片的 `dedupKey`——不是链到上一片。
  const resultRows = resultRowsOf(rows);
  assert.equal(resultRows.length, 3, "三个结果各落一行");
  assert.equal(resultRows[0].partOf, undefined, "首片不带 `partOf`：它自己就是聚合消息");
  assert.deepEqual(
    resultRows.slice(1).map((record) => record.partOf),
    [resultRows[0].dedupKey, resultRows[0].dedupKey],
    "后两片必须都 `partOf` 指向**首片**（修前是链式：第二片指首片、第三片指第二片）",
  );

  // 第二次恢复：折出来的上下文必须合法，且三个结果各一份。
  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true,
    `第二次恢复必须成功（修前实测：\`invalid_messages: tool_result ids do not match assistant tool_use ids\`，0 请求；实测：\`${String(second.error)}\`）`);
  assert.equal(provider.requests.length, 1, "第二次恢复必须真的发过一次模型请求（修前 0 次）");
  for (const id of ["t1", "t2", "t3"]) {
    const blocks = resultsFor(provider.requests[0].messages, id);
    assert.equal(blocks.length, 1, `${id} 的结果在第二次恢复后必须恰好一份`);
    assert.equal(blocks[0].content, `out-${id}`, `${id} 的内容必须逐字相同`);
  }
  assert.deepEqual(aggregateResults(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "第二次恢复之后账本形状不许变（仍是一条聚合 user 消息）");
});

test("#430 混合形状（A 集合 2 条 + B 集合补跑 1 条）⇒ 仍是一条聚合 user 消息 [t1,t2,t3]", async () => {
  const inner = createMemoryTranscriptStore();
  await threeToolCrashScene(inner, {
    snapshotResultIds: ["t1", "t2"],
    pendingIds: ["t1", "t2", "t3"],
  });
  const { store, rows } = recordRoundWrites(inner);
  const resumed = await runLoop({
    store,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async ({ id }) => `out-${String(id)}`,
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");

  const records = await inner.load(RUN_ID);
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "A 集合两条 + B 集合一条必须折回**同一条**聚合 user 消息（评审探针 E 的形状）");
  const resultRows = resultRowsOf(rows);
  assert.equal(resultRows.length, 3, "A 两条 + B 一条 = 三行");
  assert.equal(resultRows[0].partOf, undefined, "A 集合首片自己起聚合消息");
  assert.deepEqual(
    resultRows.slice(1).map((record) => record.partOf),
    [resultRows[0].dedupKey, resultRows[0].dedupKey],
    "A 的第二条与 B 的那条都必须 `partOf` 指向**同一个**首片（B 集合读到的是 A 落定的锚点）",
  );

  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：\`${String(second.error)}\`）`);
  assert.equal(provider.requests.length, 1, "第二次恢复必须真的发过一次模型请求");
  for (const id of ["t1", "t2", "t3"]) {
    assert.equal(resultsFor(provider.requests[0].messages, id).length, 1, `${id} 的结果必须恰好一份`);
  }
  assert.deepEqual(aggregateResults(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "第二次恢复之后账本形状不许变（仍是一条聚合 user 消息）");
});

// ── issue #430 的 **B 集合单点覆盖**（合并前修复：独立评审逐点单独回退时发现的那一格）────────────
// 上面两条用例的 B 集合最多 **1 条**（①纯 A 集合 A=3/B=0、②混合形状 A=2/B=1），而「锚点链到上一片」
// 这个病只在**同一锚点下写第 2 片**时才发作 ⇒ 只回退 B 集合那一处
// （`orchestrator.js` 里 `resumedResultRowKey === undefined` 那行）时既有用例**全绿、0 红**，三处修法里
// 有一处零回归保护。本用例把 B 集合堆到 3 条（A 集合为空），专钉那一处。
test("#430 B 集合 3 条（A 集合为空）⇒ 首片当锚点、后两片都指首片，折叠后一条聚合 user 消息", async () => {
  const inner = createMemoryTranscriptStore();
  await threeToolCrashScene(inner, { snapshotResultIds: [], pendingIds: ["t1", "t2", "t3"] });
  // 前置：三个工具都**没执行**（A 集合为空）⇒ 三条结果只能由补跑段（B 集合）产出。
  const snapshot = await inner.loadLatestRunSnapshot(RUN_ID);
  assert.deepEqual(snapshot?.executedToolIds, [], "前置：A 集合为空（一个工具都还没执行）");
  assert.deepEqual(snapshot?.toolResults, [], "前置：快照里没有任何已成型的结果（A 集合为空）");
  assert.deepEqual(snapshot?.pendingToolUses?.map((block) => block.id), ["t1", "t2", "t3"],
    "前置：三条都还在飞 ⇒ B 集合 = 三条全部");

  const { store, rows } = recordRoundWrites(inner);
  const executed = [];
  const resumed = await runLoop({
    store,
    provider: createFakeProvider([endTurn("续接完成")]),
    executeTool: async ({ id }) => {
      executed.push(id);
      return `out-${String(id)}`;
    },
  });
  assert.equal(resumed.ok, true, "第一次恢复必须成功");
  assert.deepEqual(executed, ["t1", "t2", "t3"],
    "前置：三条结果必须真的由补跑段产出（B 集合；A 集合一条都不该走那条路）");

  // 落盘形状（修法本体）：首片无 `partOf`，后两片**都**指向首片——不是链到上一片。
  const resultRows = resultRowsInRound(rows, 2);
  assert.equal(resultRows.length, 3, "三个结果各落一行");
  assert.equal(resultRows[0].partOf, undefined,
    "首片不带 `partOf`：B 集合首片自己就是聚合消息，并落定为后续分片的锚点");
  assert.deepEqual(
    resultRows.slice(1).map((record) => record.partOf),
    [resultRows[0].dedupKey, resultRows[0].dedupKey],
    "后两片必须都 `partOf` 指向**首片**（只回退 B 集合那一处时这里是 [首片, 第二片] ⇒ 本用例红）",
  );

  const records = await inner.load(RUN_ID);
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "三条结果必须折回**一条**聚合 user 消息（只回退 B 集合那一处时实测 `[[t1,t2],[t3]]`，两条）");

  // 第二次恢复：折出来的上下文必须合法，且三个结果各一份。
  const provider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(second.ok, true,
    "第二次恢复必须成功（只回退 B 集合那一处时实测："
    + "`invalid_messages: tool_result ids do not match assistant tool_use ids`，0 请求；"
    + `实测：\`${String(second.error)}\``);
  assert.equal(provider.requests.length, 1,
    "第二次恢复必须真的发过一次模型请求（只回退 B 集合那一处时 0 次）");
  for (const id of ["t1", "t2", "t3"]) {
    const blocks = resultsFor(provider.requests[0].messages, id);
    assert.equal(blocks.length, 1, `${id} 的结果在第二次恢复后必须恰好一份`);
    assert.equal(blocks[0].content, `out-${id}`, `${id} 的内容必须逐字相同`);
  }
  assert.deepEqual(aggregateResults(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2", "t3"] }],
    "第二次恢复之后账本形状不许变（仍是一条聚合 user 消息）");
});

// 第三个写入口（同一个缺陷的第三份拷贝）：主循环「工具结果一产生就写」那一处也把锚点推进成刚写那条
// 分片的 key。它不经过 resume，只要**崩溃在轮载体行落盘之前**（轮行没落 ⇒ 折叠层找不到载体 ⇒ 消息行
// 原样留在 `load()` 输出里、由 `foldLedgerMessages` 折），三条结果就会裂成 `[[t1,t2],[t3]]`。
// ⚠ 别把这条读成「只有崩溃才中招」：**正常轮就已中招**（见下面 `#430 正常轮` 那一组），本用例只是让
// 同一个坏形状在 `foldLedgerMessages` 那一侧也显形（载体行没落 ⇒ `load()` 不折）。
test("#430 主循环写入口（崩在轮载体行之前）⇒ 三条结果同样折回一条聚合 user 消息", async () => {
  const inner = createMemoryTranscriptStore();
  let fired = false;
  const store = {
    ...inner,
    async appendRound(runId, record) {
      if (!fired && record?.dedupKey === `${RUN_ID}:engine:round:1`) {
        fired = true;
        throw new Error("simulated crash before round carrier row");
      }
      return inner.appendRound(runId, record);
    },
  };
  const first = await runLoop({
    store,
    provider: createFakeProvider([toolTurn(["t1", "t2", "t3"])]),
    executeTool: async ({ id }) => `out-${String(id)}`,
    resume: false,
    initialUserMessage: "任务",
  });
  assert.equal(first.ok, false, "前置：第一次运行必须真的崩在轮载体行写入点");
  assert.match(first.error, /simulated crash before round carrier row/u);

  const crashed = await inner.load(RUN_ID);
  assert.deepEqual(
    crashed.filter((record) => record?.round === 1 && record?.kind === "message")
      .flatMap((record) => (record.messages ?? []).flatMap((message) => message.content ?? []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => block.tool_use_id),
    ["t1", "t2", "t3"],
    "前置：三条结果都已逐条入账（轮载体行没落 ⇒ 它们原样留在 load() 输出里）",
  );
  // 轮载体没落 ⇒ `load()` 按契约把消息行原样留着（每条自成一「记录」），所以形状要看**恢复口径**
  // （`foldLedgerMessages`，`restoreResume` 用的就是它）与落盘行的 `partOf` 链。
  const crashedResultRows = crashed.filter((record) => record?.round === 1
    && record?.kind === "message"
    && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result")));
  assert.equal(crashedResultRows.length, 3, "三条结果各一行");
  assert.equal(crashedResultRows[0].partOf, undefined, "首片不带 `partOf`");
  assert.deepEqual(
    crashedResultRows.slice(1).map((record) => record.partOf),
    [crashedResultRows[0].dedupKey, crashedResultRows[0].dedupKey],
    "后两片必须都 `partOf` 指向**首片**（修前是链式：第三片指第二片）",
  );
  const crashedAggregates = foldLedgerMessages(crashed)
    .filter((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : [])
      .some((block) => block?.type === "tool_result"));
  assert.equal(crashedAggregates.length, 1,
    "崩溃现场的账本折回来就必须是**一条**聚合 user 消息（修前实测 `[[t1,t2],[t3]]`，两条）");
  assert.deepEqual(
    crashedAggregates[0].message.content.map((block) => block.tool_use_id),
    ["t1", "t2", "t3"],
  );

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true,
    `恢复必须成功（修前实测：\`invalid_messages: tool_result ids do not match assistant tool_use ids\`，0 请求；实测：\`${String(resumed.error)}\`）`);
  assert.equal(provider.requests.length, 1, "恢复必须真的发过一次模型请求");
  for (const id of ["t1", "t2", "t3"]) {
    assert.equal(resultsFor(provider.requests[0].messages, id).length, 1, `${id} 的结果必须恰好一份`);
  }
  // 崩溃轮一直没有轮载体（第一次就崩在它上面）⇒ `load()` 按契约原样留着消息行；形状仍看恢复口径。
  const afterResume = await inner.load(RUN_ID);
  const afterAggregates = foldLedgerMessages(afterResume)
    .filter((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : [])
      .some((block) => block?.type === "tool_result"));
  assert.equal(afterAggregates.length, 1, "恢复之后折回来仍是**一条**聚合 user 消息");
  assert.deepEqual(
    afterAggregates[0].message.content.map((block) => block.tool_use_id),
    ["t1", "t2", "t3"],
  );
});

// ── issue #430 的**生产主路径**：正常轮 ≥3 个工具调用（合并前修复：评审实测「正常轮就已中招」）──────
// 上面那条主循环用例的现场是「崩溃在轮载体行之前」，容易被读成「只有崩溃才可见」。实测不是：`resume:false`
// 的正常一轮（3 个 `tool_use` + 3 条结果 + `end_turn`）就会把账本写成链式
// `msg:1:1`(none) → `msg:1:2`(partOf `msg:1:1`) → `msg:1:3`(partOf `msg:1:2`)，`load()` 折成
// `[assistant, user(t1,t2), user(t3)]`，**紧接着的** resume 直接 `invalid_messages`、**0 请求** ⇒ 该 runId
// 永久不可恢复。不需要崩溃、不需要 A/B 集合——这是本票最值钱的战果，必须有回归保护。
test("#430 正常轮 3 个工具调用 ⇒ 落盘 partOf 不链式、load() 一条聚合 user 消息、紧随的 resume 成功", async () => {
  const ids = ["t1", "t2", "t3"];
  const inner = createMemoryTranscriptStore();
  const { store, rows } = recordRoundWrites(inner);
  const first = await runLoop({
    store,
    provider: createFakeProvider([toolTurn(ids), endTurn("完成")]),
    executeTool: async ({ id }) => `out-${String(id)}`,
    resume: false,
    initialUserMessage: "任务",
  });
  assert.equal(first.ok, true, "前置：正常轮必须跑完（这不是崩溃现场，`resume:false` 的一轮跑到底）");

  // 落盘形状（修法本体）：首片无 `partOf`，后两片**都**指向首片——不是链到上一片。
  const resultRows = resultRowsInRound(rows, 1);
  assert.deepEqual(
    resultRows.map((record) => record.messages?.[0]?.content?.[0]?.tool_use_id),
    ids,
    "前置：三条结果各落一行，顺序 = 真实发生顺序",
  );
  assert.equal(resultRows[0].partOf, undefined, "首片不带 `partOf`：它自己就是聚合消息");
  assert.deepEqual(
    resultRows.slice(1).map((record) => record.partOf),
    [resultRows[0].dedupKey, resultRows[0].dedupKey],
    "后两片必须都 `partOf` 指向**首片**（只回退主循环那一处时是链式：`msg:1:3` 指 `msg:1:2`）",
  );

  const records = await inner.load(RUN_ID);
  assert.deepEqual(aggregateResults(records), [{ role: "user", ids }],
    "正常轮的三条结果必须折回**一条**聚合 user 消息（只回退主循环那一处时实测 `[[t1,t2],[t3]]`，"
    + "两条；`load()` 的序列会变成 assistant / user(t1,t2) / user(t3)）");

  // 紧随其后的 resume：修前这里在第一次模型请求之前就 `invalid_messages`（0 请求）。
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true,
    "紧随的 resume 必须成功（只回退主循环那一处时实测："
    + "`invalid_messages: tool_result ids do not match assistant tool_use ids`，0 请求；"
    + `实测：\`${String(resumed.error)}\`）`);
  assert.equal(provider.requests.length, 1, "resume 必须真的发过一次模型请求（只回退主循环那一处时 0 次）");
  for (const id of ids) {
    const blocks = resultsFor(provider.requests[0].messages, id);
    assert.equal(blocks.length, 1, `${id} 的结果在 resume 之后必须恰好一份`);
    assert.equal(blocks[0].content, `out-${id}`, `${id} 的内容必须逐字相同`);
  }
});

// ── issue #421：**中段**（非尾部）悬空 `tool_use` 的读侧兜底 ──────────────────────────────────────
// 病根（宿主 erix-station 真机撞过两次，第 25 / 56 轮）：一条 assistant 的 `tool_use` 必须由**紧接其后**
// 的那条 user 消息（聚合消息）以 `tool_result` 结清，id 集合还要**一模一样**
// （`src/messages/rounds.js#validateMessages`）。违反 ⇒ 本地 `invalid_messages`、**0 次 HTTP**、
// run 直接 `failed`，且这个 runId **永久起不来**（账本里那个形状不会自己变）。
// #394 修的是**尾部**（`pendingTailToolUses` 兜不住中段），#414/#420/#424/#430 修的是**写侧**。
// 本组用例钉的是剩下的那一格：**中段悬空 + 账本里没有任何一行结清过它**。
//
// 修法（`src/loop/pending-tool-result.js#answerPendingMidSequenceToolUses`）：给每个这样的 `tool_use`
// 补一张「这次调用的结果没有落盘」的桩 `tool_result`（`is_error: true`、正文以 `[erix]` marker 开头），
// **并进它所属那条 assistant 紧接的下一条 user 消息**（同页合并，不插页），并在**锚点可得**时把桩
// 落进账本（消息行 + `partOf` 指向聚合消息**首片**，#430 的锚点纪律）。
//
// 两种账本形状（本组用例各钉一条）：
//   · **崩溃轮形状**：那一轮的轮载体行还没落 ⇒ 消息行原样留在 `load()` 输出里 ⇒ 首片行**看得见** ⇒
//     桩可以落账（`partOf` → 首片）。这也是「同一个 runId 永久起不来」的典型现场。
//   · **已完成轮形状**（宿主真机：第 25 轮早就跑完了）：消息行已被折叠层吸进轮载体，`load()` 只剩
//     载体行。issue #714 之前这里**首片行的 key 不可得**（公共 store 面没有「列原始行」的入口）⇒ 桩
//     只进本次上下文、不写账本，并报 `resume_journal_skipped`
//     （`reason: "mid_sequence_aggregate_row_not_in_ledger"`）。#714 给 store 面加了一个**可选**原始行
//     读口（`loadRawRows`，内置两个 store 都提供）：折叠只是读侧变换、原始行从来没消失，把未折叠行
//     交出来就足以寻址首片行 ⇒ 桩照样落账、账本闭合。
//   · **缺省路径**（宿主 store 不提供那个读口）：逐字退回 #421 的口径（只修内存 + 发那条事件），
//     不抛错——那是**缺能力时的降级**，由本组最后一条用例独立钉住（向后兼容的正证）。

const STUB_TEXT = UNPERSISTED_TOOL_RESULT_TEXT;
/** 桩块（按正文逐字认，不按 marker 前缀认：撞车的另一条正文必须在本组用例里显形）。 */
const stubBlocks = (messages) => blocksOf(messages)
  .filter((block) => block?.type === "tool_result" && block.content === STUB_TEXT);

/** 恢复路径真正用的投影（`foldLedgerMessages`：`partOf` 分片接回它指认的那条消息）。 */
const ledgerAggregates = (records) => foldLedgerMessages(records)
  .map((entry) => entry.message)
  .filter((message) => blocksOf([message]).some((block) => block?.type === "tool_result"))
  .map((message) => ({
    role: message.role,
    ids: blocksOf([message]).filter((block) => block?.type === "tool_result")
      .map((block) => block.tool_use_id),
  }));

/**
 * 手搭「中段悬空」账本（不靠注入时序，逐字段点名）：
 *   · round 1：`user` 任务（一条消息行）；
 *   · round 2：**assistant 那条消息行**（`toolUseIds` 个 `tool_use`）+ **聚合 user 消息行**
 *     （只有 `resultIds` 那几个结果）—— 于是悬空的是 `toolUseIds \ resultIds`，而且它**不在尾部**
 *     （尾部是那条 user 消息）；
 *   · `withRoundCarrier: true` 时再加一条 round 2 的**轮载体行**（= 「这一轮跑完了」的现场，
 *     消息行会被折叠层吸进它）。
 * 没有 run snapshot：这不是「崩溃现场」那一格，而是「账本本身就是这个形状」那一格。
 */
async function midSequenceDanglingScene(inner, { toolUseIds, resultIds, withRoundCarrier = false }) {
  const ts = () => new Date().toISOString();
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "user", content: [text("任务")] }],
    ts: ts(),
  });
  if (withRoundCarrier) {
    await inner.appendRound(RUN_ID, {
      round: 2,
      roundKey: `${RUN_ID}:round:2`,
      dedupKey: `${RUN_ID}:engine:round:2`,
      ts: ts(),
    });
  }
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "assistant", content: [text("先跑工具"), ...toolUseIds.map(toolUse)] }],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:1`,
    kind: "message",
    seq: 1,
    messages: [{ role: "user", content: resultIds.map(toolResultBlock) }],
    ts: ts(),
  });
  return inner;
}

/** 落盘行里「带那张桩」的消息行（按正文逐字认）。 */
const stubRowsOf = (rows) => rows.filter((record) => record?.kind === "message"
  && (record.messages ?? []).some((message) => (Array.isArray(message?.content) ? message.content : [])
    .some((block) => block?.type === "tool_result" && block.content === STUB_TEXT)));

test("#421 中段悬空（崩溃轮形状）· 补桩并进紧跟的聚合 user 消息，且桩落进账本（`partOf` → 首片）", async () => {
  const inner = createMemoryTranscriptStore();
  await midSequenceDanglingScene(inner, { toolUseIds: ["t1", "t2"], resultIds: ["t1"] });

  // 前置（判据 1 的红侧，逐字钉住）：**这个账本形状本身**就是 `invalid_messages`。
  // 恢复器不补桩时，run 就死在这一句上、0 次请求、该 runId 永久起不来。
  const ledgerBefore = foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message);
  assert.throws(
    () => validateMessages(ledgerBefore),
    /tool_result ids do not match assistant tool_use ids/u,
    "前置：中段悬空账本必须真的过不了严格配对（否则本用例测的是别的东西）",
  );

  const { store, rows } = recordRoundWrites(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store,
    provider,
    executeTool: async () => {
      throw new Error("补跑不该发生：一个调用已结清、另一个没有结果可补跑");
    },
  });
  assert.equal(resumed.ok, true,
    "恢复必须成功（修前实测：`invalid_messages: Invalid message at index 2: tool_result ids do not "
    + "match assistant tool_use ids`，0 次请求；实测：" + String(resumed.error));
  assert.ok(provider.requests.length >= 1,
    `恢复之后必须**真的**发过至少一次模型请求（修前 0 次），实测 ${provider.requests.length}`);

  const messages = provider.requests[0].messages;
  const at = messages.findIndex((message) => message?.role === "assistant"
    && blocksOf([message]).some((block) => block?.type === "tool_use" && block.id === "t1"));
  assert.ok(at >= 0, "历史里必须有那条中段 assistant");
  const aggregate = messages[at + 1];
  assert.equal(aggregate?.role, "user", "tool_use 后面紧跟的必须仍是 user 消息（同页合并，不插页）");
  assert.deepEqual(
    blocksOf([aggregate]).filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id),
    ["t1", "t2"],
    "聚合消息的 id 集合必须与 assistant 的 tool_use 集合**一模一样**（修前少 t2）",
  );
  const stub = blocksOf([aggregate]).find((block) => block?.type === "tool_result"
    && block.tool_use_id === "t2");
  assert.equal(stub.is_error, true, "桩必须是 `is_error`（wire 上「没产出可用结果」的唯一出口）");
  assert.equal(stub.content, STUB_TEXT,
    "正文必须是本单那条常量（「执行过、结果没落盘」），不许复用尾部那句「从未执行」");
  assert.match(String(stub.content), /^\[erix\]/u, "桩正文必须以 `[erix]` marker 开头（引擎自写）");
  // 整份历史合法（严格配对那一档：`allowPendingToolUse` 默认 false）。
  validateMessages(messages);

  // 账本侧：桩落了账，而且折回来仍是**同一条**聚合 user 消息（不是第二条）。
  assert.deepEqual(ledgerAggregates(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }],
    "桩必须折回它所属的那条聚合 user 消息（形状 = 一条消息两个结果）");
  // 落盘形状（#430 的锚点纪律）：桩是**分片行**，`partOf` 指向聚合消息的**首片**行。
  const stubRows = stubRowsOf(rows);
  assert.equal(stubRows.length, 1, "桩必须落成**恰好一行**（0 = 没入账，2 = 双喂）");
  assert.equal(stubRows[0].partOf, `${RUN_ID}:msg:2:1`,
    "桩必须 `partOf` 指向那条聚合消息的**首片**行（`t1` 那一行）——分片 key 不是合法的 `partOf` 目标");
  assert.notEqual(stubRows[0].partOf, stubRows[0].dedupKey, "锚点不许是桩自己那一行（链式 `partOf` 的坑）");
  assert.equal(stubRows[0].round, 2, "桩属于它那条聚合消息的轮（不是恢复时的新轮）");

  // 第二次恢复：账本已认它 ⇒ 上下文仍只有一张桩、账本不再多写一行。
  const second = recordRoundWrites(inner);
  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const again = await runLoop({ store: second.store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(again.ok, true, `第二次恢复必须成功（实测：${String(again.error)}）`);
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复之后，桩在上下文里必须恰好一张（账本已认它，不得再补）");
  assert.equal(stubRowsOf(second.rows).length, 0,
    "第二次恢复不得再写一条桩行（0 = 幂等，1+ = 同一张桩被重复入账）");
});

test("#421/#714 中段悬空（已完成轮形状）· 首片行经可选原始行读口可得 ⇒ 桩落账、账本闭合、不发跳过事件", async () => {
  // 宿主真机的现场：那一轮**跑完了**（轮载体行已落），消息行被折叠层吸进载体 ⇒ `load()` 里
  // 没有首片消息行。折叠只是**读侧**变换，原始行在介质上从来没消失 —— issue #714 于是给 store 面加了
  // 一个**可选**原始行读口（`loadRawRows` = `load()` 的未折叠输入，内置两个 store 都提供）：首片行
  // 的 key 仍然寻址得到 ⇒ 桩以 `partOf` 落账、账本闭合。写入口（`journalResumeMidSequenceToolResults`）
  // 与 #430 的锚点纪律**一字未改**，缺的只是「折叠后仍能寻址首片行」这个能力。
  // 「宿主 store 不提供这个读口」的那一格由下面那条独立用例钉住（降级 = 只修内存 + 发事件）。
  const inner = createMemoryTranscriptStore();
  await midSequenceDanglingScene(inner, { toolUseIds: ["t1", "t2"], resultIds: ["t1"], withRoundCarrier: true });
  const ledgerBefore = foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message);
  assert.throws(
    () => validateMessages(ledgerBefore),
    /tool_result ids do not match assistant tool_use ids/u,
    "前置：这一格同样是 `invalid_messages`（否则本用例测的是别的东西）",
  );

  const events = [];
  const { store, rows } = recordRoundWrites(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store,
    provider,
    executeTool: async () => "unused",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(resumed.ok, true,
    "恢复必须成功（修前：`invalid_messages`，0 次请求；实测：" + String(resumed.error));
  assert.equal(provider.requests.length, 1, "恢复必须真的发过一次模型请求（修前 0 次）");
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文（id 集合与 tool_use 一致）");
  validateMessages(provider.requests[0].messages);

  // 判据 2：锚点可得 ⇒ 桩真的入了账 ⇒ 同一形状上**不再**发那条跳过事件。
  const skipped = events.filter((event) => event?.type === "resume_journal_skipped"
    && event?.reason === "mid_sequence_aggregate_row_not_in_ledger");
  assert.equal(skipped.length, 0,
    "锚点可得时不得再报「这批桩没有入账」（事件格子：`journalResumeMidSequenceToolResults`）");
  assert.deepEqual(ledgerAggregates(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }],
    "桩必须折回它所属的那条聚合 user 消息（形状 = 一条消息两个结果）");

  // 落盘形状（#430 的锚点纪律在**已完成轮**上同样成立）：桩是分片行，`partOf` → 首片行；
  // `seq` 地板来自原始行（该轮已有 seq 0 / 1 ⇒ 桩是 2），重号会被判成同 key 异 payload。
  const stubRows = stubRowsOf(rows);
  assert.equal(stubRows.length, 1, "桩必须落成**恰好一行**（0 = 没入账，2 = 双喂）");
  assert.equal(stubRows[0].partOf, `${RUN_ID}:msg:2:1`,
    "桩必须 `partOf` 指向那条聚合消息的**首片**行（`t1` 那一行）——分片 key 不是合法的 `partOf` 目标");
  assert.notEqual(stubRows[0].partOf, stubRows[0].dedupKey, "锚点不许是桩自己那一行（链式 `partOf` 的坑）");
  assert.equal(stubRows[0].seq, 2, "seq 必须接在该轮最大 seq（1）之后：重号会被判成同 key 异 payload");
  assert.equal(stubRows[0].round, 2, "桩属于它那条聚合消息的轮（不是恢复时的新轮）");

  // 判据 1（本单核心）：宿主 `load()` 折出来的账本必须过得了**严格配对**。修前这一句抛
  // `Invalid message at index 2: tool_result ids do not match assistant tool_use ids`。
  validateMessages(foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message));

  // 第二次恢复：账本已认它 ⇒ 上下文仍只有一张桩、账本不再多写一行。幂等**不靠**额外的 id 集合，
  // 也不新增去重键：桩落的那一页就是那条聚合消息，折回来之后 `pendingMidSequenceToolUses` 的
  // 逐对讲据自己就不再问它（issue #730 把排除集从全 run 收窄成逐对，幂等这条一个字没动）。
  const second = recordRoundWrites(inner);
  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const again = await runLoop({ store: second.store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(again.ok, true, `第二次恢复必须成功（实测：${String(again.error)}）`);
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复之后，桩在上下文里必须恰好一张（账本已认它，不得再补）");
  assert.equal(stubRowsOf(second.rows).length, 0,
    "第二次恢复不得再写一条桩行（0 = 幂等，1+ = 同一张桩被重复入账）");
});

test("#714 缺省（宿主 store 没有原始行读口）· 行为与修前逐字相同：只修内存 + 如实报事件，不抛错", async () => {
  // **向后兼容的正证**：新读口是**可选**能力（`docs/host-consumer-contract.md` 的
  // "TranscriptStore capability tiers"）。宿主最小实现（只有 `appendRound` / `load`）不提供它 ⇒ 引擎必须
  // 逐字退回 #421 的口径：本次上下文补桩、账本一行不写、发一条 `resume_journal_skipped`
  // （`reason: "mid_sequence_aggregate_row_not_in_ledger"`）、run 照旧起得来——**不是**抛错、也不是
  // 换一条写路径。
  // ⚠ 这一格**不是**设计终态，是缺能力时的降级：账本因此仍过不了严格配对，下面那条 `assert.throws`
  // 把这条残留如实钉住（免得下一个人把「绿」当成「账本已闭合」）。宿主补上 `loadRawRows` 就闭合
  // （上一条用例），中英契约的 capability 表里写着这条迁移路径。
  const base = createMemoryTranscriptStore();
  await midSequenceDanglingScene(base, { toolUseIds: ["t1", "t2"], resultIds: ["t1"], withRoundCarrier: true });
  const storeWithoutProbe = { ...base };
  delete storeWithoutProbe.loadRawRows;
  assert.equal(typeof storeWithoutProbe.loadRawRows, "undefined",
    "前置：这个 store 真的没有原始行读口（否则本条测的是上一条）");

  const events = [];
  const { store, rows } = recordRoundWrites(storeWithoutProbe);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store,
    provider,
    executeTool: async () => "unused",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(resumed.ok, true,
    "恢复必须成功（缺能力时降级，不是抛错；实测：" + String(resumed.error));
  assert.equal(provider.requests.length, 1, "恢复必须真的发过一次模型请求");
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文（id 集合与 tool_use 一致）");
  validateMessages(provider.requests[0].messages);

  const skipped = events.filter((event) => event?.type === "resume_journal_skipped"
    && event?.reason === "mid_sequence_aggregate_row_not_in_ledger");
  assert.equal(skipped.length, 1,
    "必须如实报一次「这批桩没有入账」（走既有 onEvent 通道，不新造机制）");
  assert.equal(skipped[0].count, 1, "报的条数必须等于没入账的桩数");
  assert.equal(skipped[0].round, 2, "报的轮号必须是那条聚合消息的轮");
  assert.equal(stubRowsOf(rows).length, 0, "锚点不可得时**一行都不许写**（宁可只修内存，也不造坏形状）");
  assert.deepEqual(ledgerAggregates(await base.load(RUN_ID)), [{ role: "user", ids: ["t1"] }],
    "**缺省路径**的账本必须保持修前形状（新读口缺席时这一条仍然成立，且只描述这一条路径）");
  const ledgerAfter = foldLedgerMessages(await base.load(RUN_ID)).map((entry) => entry.message);
  assert.throws(() => validateMessages(ledgerAfter),
    /tool_result ids do not match assistant tool_use ids/u,
    "残留（如实钉住，不是绿）：缺能力时账本仍过不了严格配对——宿主补上 `loadRawRows` 才闭合");
});

test("#714 中段悬空（已完成轮形状）· file store 真落盘：桩写进文件、`load()` 折出来的账本闭合", async () => {
  // 与上一条同一个形状（已完成轮），换**真落盘**的 store：证的是「内置两个 store 都提供原始行读口」
  // —— 文件里 `load()` 只返回 2 行，而首片消息行仍在文件里（`loadRawRows` 看得到 4 行）⇒ 锚点算得出来
  // ⇒ 桩真的进了档案，且下一次恢复不再补第二条。
  const dir = await makeTmp("erix-714-midseq-");
  const store = createFileTranscriptStore({ dir });
  await midSequenceDanglingScene(store, { toolUseIds: ["t1", "t2"], resultIds: ["t1"], withRoundCarrier: true });
  // 前置（#714 的事实底座）：折叠是**读侧**变换，原始行没消失。
  assert.equal((await store.load(RUN_ID)).length, 2, "前置：`load()` 只返回 2 行（已完成轮的消息行被吸进载体）");
  assert.equal((await store.loadRawRows(RUN_ID)).length, 4, "前置：原始行读口看得见 4 行（首片行还在文件里）");

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true, `恢复必须成功（实测：${String(resumed.error)}）`);
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文");
  assert.deepEqual(ledgerAggregates(await store.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }],
    "桩必须真的落进档案：`load()` 折回来仍是一条聚合 user 消息（t1 + 桩 t2）");
  // 本单核心：宿主 `load()` 折出来的账本过得了严格配对（修前抛 `Invalid message at index 2`）。
  validateMessages(foldLedgerMessages(await store.load(RUN_ID)).map((entry) => entry.message));

  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：${String(second.error)}）`);
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复：账本已认它 ⇒ 上下文里仍只有那一张桩（不是两张）");
  validateMessages(foldLedgerMessages(await store.load(RUN_ID)).map((entry) => entry.message));
});

// ── issue #729：宿主把**折好的载体行**与**原始消息行**两份都留（`#401` R3 的事故现场）────────────
// 现场（纯函数探针先复现，见下）：round 2 的轮载体行**已经带着正文**（`assistant[t1,t2]` + `user[t1]`），
// 同一轮的消息行（`seq:0` / `seq:1`）也还在账本里。折叠层的 #401 R3 守卫判「载体现有正文 == 从消息行
// 折出来的正文」⇒ 相等 ⇒ 消息行被当**重复副本**丢弃（`load()` = 2 行 / 3 条消息，形状是对的）。
// 但桩一旦落账，折出来的那份就**多出桩那一块** ⇒ 判不等 ⇒ 走 `attached` 分支把整轮正文**再拼一遍**
// （实测 3 → 5 条消息）⇒ `validateMessages` 抛 `invalid_messages`，这个 runId 永久起不来。
//
// 修法（定锚侧，`src/loop/resume-manager.js#firstSliceRowKeyOf`）：该轮已有带正文的载体行 ⇒ **不给锚点**
// ⇒ 逐字退回 #421 的降级（桩只修本次上下文 + 发一条 `resume_journal_skipped`）。
// **宁可退回降级，也不写一份会翻倍的账。**

/**
 * 手搭「载体带正文 + 同轮消息行」的账本（两份都留，#401 R3 支持的那种形状）：
 *   · round 1：任务（消息行）；
 *   · round 2：**载体行**（`dedupKey` 以 `:round:2` 结尾，正文 = 折好的 assistant + 聚合 user）；
 *   · round 2：**同一轮的原始消息行**（`seq:0` assistant、`seq:1` 聚合 user）——于是悬空的 `t2` 有
 *     合法的首片候选行，但那一轮的载体**已经带着正文**。
 */
async function bodyCarrierScene(inner) {
  const ts = () => new Date().toISOString();
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "user", content: [text("任务")] }],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:round:2`,
    messages: [
      { role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")] },
      { role: "user", content: [toolResultBlock("t1")] },
    ],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")] }],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:1`,
    kind: "message",
    seq: 1,
    messages: [{ role: "user", content: [toolResultBlock("t1")] }],
    ts: ts(),
  });
  return inner;
}

/** `load()` 折出来的逻辑消息序列（`restoreResume` 重建上下文的那一份口径）。 */
const foldedMessagesOf = async (store) => foldLedgerMessages(await store.load(RUN_ID))
  .map((entry) => entry.message);

test("#729 中段悬空（载体已带正文 + 同轮消息行）· 不给锚点、不写桩、发跳过事件、`load()` 不翻倍、二次恢复仍 ok", async () => {
  const inner = await bodyCarrierScene(createMemoryTranscriptStore());

  // 前置（这一格到底是不是本单说的形状，逐字钉住）：
  // ① `load()` 只看见 2 行（round 2 的消息行被 R3 守卫当重复副本丢弃），折出 3 条消息；
  // ② 原始行读口看得见 4 行（消息行确实还在介质上）——于是**锚点探针命中得了**，这就是本单要堵的洞。
  assert.equal((await inner.load(RUN_ID)).length, 2,
    "前置：`load()` 必须是 2 行（round 2 的消息行被 #401 R3 当重复副本丢弃）");
  assert.equal((await inner.loadRawRows(RUN_ID)).length, 4,
    "前置：原始行看得见 4 行（首片候选行在介质上 ⇒ 锚点探针命中得了，这正是本单的洞）");
  const before = await foldedMessagesOf(inner);
  assert.equal(before.length, 3, "前置：无桩时折出 3 条消息（user / assistant[t1,t2] / user[t1]）");
  assert.throws(() => validateMessages(before),
    /tool_result ids do not match assistant tool_use ids/u,
    "前置：中段悬空账本必须真的过不了严格配对（否则本用例测的是别的东西）");

  const events = [];
  const { store, rows } = recordRoundWrites(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store,
    provider,
    executeTool: async () => "unused",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(resumed.ok, true, "恢复必须成功（实测：" + String(resumed.error));
  assert.equal(provider.requests.length, 1, "恢复必须真的发过一次模型请求");

  // 判据①：桩进得了本次上下文（id 集合与 tool_use 一致），但**一行都不许写**。
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文（id 集合与 assistant 的 tool_use 一致）");
  validateMessages(provider.requests[0].messages);
  assert.equal(stubRowsOf(rows).length, 0,
    "载体已带正文的轮**不许写桩**：写下去就会被折叠层再拼一遍（实测 3 → 5 条消息）");
  assert.equal(rows.filter((record) => record?.round === 2 && record?.kind === "message").length, 0,
    "落盘行 0 增量：这次恢复不许给 round 2 写任何**消息行**（写了就是桩落了账）");
  // 落盘行 0 增量（round 2）：消息行必须仍是 2 条、载体行仍是 1 条。（这一轮多出来的那一行是
  // issue #404 的 `…:engine:round:2:control:resume-notice:…` 控制行——恢复本身就会写它，与桩无关。）
  const rawRoundTwo = (await inner.loadRawRows(RUN_ID)).filter((record) => record?.round === 2);
  assert.equal(rawRoundTwo.filter((record) => record?.kind === "message").length, 2,
    "落盘行 0 增量：round 2 的消息行必须仍是 2 条（第 3 条 = 桩落了账）");
  assert.equal(rawRoundTwo.filter((record) => record?.kind !== "message"
    && /:round:2$/u.test(String(record?.dedupKey ?? record?.roundKey))).length, 1,
    "载体行必须仍是 1 条（桩不许把载体形态撞坏）");

  // 判据②：如实发一条跳过事件（既有 `onEvent` 通道，不新造机制）。
  const skipped = events.filter((event) => event?.type === "resume_journal_skipped"
    && event?.reason === "mid_sequence_aggregate_row_not_in_ledger");
  assert.equal(skipped.length, 1, "必须如实报一次「这批桩没有入账」");
  assert.equal(skipped[0].count, 1, "报的条数必须等于没入账的桩数");
  assert.equal(skipped[0].round, 2, "报的轮号必须是那条聚合消息的轮");

  // 判据③：round 2 折出的正文必须与写桩前**逐字相同**（不翻倍）——本单的核心。
  // （恢复本身会给自己写行：issue #404 的 `…:control:resume-notice:…` 与下一轮的消息行，所以这里
  // 判的是**那一轮载体折出来的正文**与「全文里带 t1 的 assistant 条数」，不是整个账本的总条数。）
  const roundTwoCarrier = async () => (await inner.load(RUN_ID)).find((record) => record?.round === 2
    && /:round:2$/u.test(String(record?.dedupKey ?? record?.roundKey)));
  const carrierAfter = await roundTwoCarrier();
  assert.ok(carrierAfter !== undefined, "前置：round 2 的载体行必须还在 `load()` 里");
  assert.equal(carrierAfter.messages.length, 2,
    "round 2 的载体正文必须仍是 2 条（修前实测 4 条：整轮正文拼了第二遍；实测 "
    + `${carrierAfter.messages.length}）`);
  assert.deepEqual(carrierAfter.messages, before.slice(1),
    "载体折出来的正文必须与写桩前**逐字相同**（不是「条数对了、内容翻了」）");
  assert.equal((await inner.load(RUN_ID)).flatMap((record) => record.messages ?? [])
    .filter((message) => blocksOf([message]).some((block) => block?.type === "tool_use"
      && block.id === "t1")).length, 1,
    "整份账本里带 `t1` 的 assistant 必须恰好一条（修前 2 条 = 整轮正文拼了第二遍）");
  assert.deepEqual(ledgerAggregates(await inner.load(RUN_ID)), [{ role: "user", ids: ["t1"] }],
    "账本形状必须保持「一条聚合 user 消息只带 t1」（桩不进账本）");

  // 判据④：二次恢复仍 `ok`（修前这里在第一次模型请求之前就 `invalid_messages`，0 次请求）。
  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const again = await runLoop({ store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(again.ok, true,
    "第二次恢复必须仍然成功（修前：账本翻倍 ⇒ `invalid_messages`，0 次请求；实测：" + String(again.error));
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复：桩仍然只补进本次上下文（恰一张）");
  assert.equal(stubRowsOf(rows).length, 0, "第二次恢复同样不许写桩行");
  const carrierTwice = await roundTwoCarrier();
  assert.deepEqual(carrierTwice?.messages, before.slice(1),
    "两次恢复之后 round 2 折出的正文仍与最初逐字相同（一个字节都没多）");
});

// ── issue #729（第二格）：**轮号过滤不对称** ───────────────────────────────────────────────
// 旧判据是 `Number.isSafeInteger(round) && Number.isSafeInteger(row.round) && row.round !== round`
// ⇒ `row.round` **不是**安全整数时**不排除**。而折叠层（`src/store/message-rows.js`）对没有整数
// `round` 的行一律不当折叠目标 ⇒ 命中那种行等于保证桩落成**孤儿 `user` 消息**，以另一种
// `invalid_messages`（`user tool_result has no matching assistant tool_use`）死。
// 修后：「`round` 是整数时 `row.round` 必须**严格相等**」。

test("#729 轮号过滤 · 候选行的 `round` 不是整数（折叠层不认它）⇒ 不给锚点、不写桩、二次恢复仍 ok", async () => {
  // issue #811 之后那种行**进不了内置 store**（写侧当场抛 `TypeError`），所以现场由
  // `withUnvalidatedAppends` 落：宿主自研 store（驱动把整型列返回成字符串）或写侧守卫之前的档案。
  // 断言一条没改：读侧对那种行照旧宽容，而它照样**不许当锚点**。
  const inner = withUnvalidatedAppends(createMemoryTranscriptStore());
  const ts = () => new Date().toISOString();
  await inner.appendRound(RUN_ID, {
    round: 1, roundKey: `${RUN_ID}:round:1`, dedupKey: `${RUN_ID}:msg:1:0`, kind: "message", seq: 0,
    messages: [{ role: "user", content: [text("任务")] }], ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2, roundKey: `${RUN_ID}:round:2`, dedupKey: `${RUN_ID}:msg:2:0`, kind: "message", seq: 0,
    messages: [{ role: "assistant", content: [text("先跑工具"), toolUse("t1"), toolUse("t2")] }], ts: ts(),
  });
  // 聚合 user 消息那一行的 `round` 是字符串（宿主手写 / 序列化回来的现场）：首块确实是 `t1` 的
  // `tool_result`，但折叠层**不会**把它当折叠目标（`Number.isSafeInteger(record.round)` 不过）。
  await inner.appendRound(RUN_ID, {
    round: "2", roundKey: `${RUN_ID}:round:2`, dedupKey: `${RUN_ID}:msg:2:1`, kind: "message", seq: 1,
    messages: [{ role: "user", content: [toolResultBlock("t1")] }], ts: ts(),
  });
  const before = await foldedMessagesOf(inner);
  assert.deepEqual(before.map((message) => message.role), ["user", "assistant", "user"],
    "前置：这个账本就是「assistant[t1,t2] 后面只有 t1」的中段悬空形状");
  assert.throws(() => validateMessages(before),
    /tool_result ids do not match assistant tool_use ids/u,
    "前置：中段悬空账本必须真的过不了严格配对（否则本用例测的是别的东西）");

  const events = [];
  const { store, rows } = recordRoundWrites(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store,
    provider,
    executeTool: async () => "unused",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  assert.equal(resumed.ok, true, "恢复必须成功（实测：" + String(resumed.error));
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文");
  validateMessages(provider.requests[0].messages);

  // 核心：`round` 不是整数的候选行**不得**当锚点——否则桩落成孤儿 `user` 消息。
  assert.equal(stubRowsOf(rows).length, 0,
    "`round` 不是整数的候选行不得被当锚点（桩落成孤儿 `user` 消息 ⇒ 另一种 `invalid_messages`）");
  const skipped = events.filter((event) => event?.type === "resume_journal_skipped"
    && event?.reason === "mid_sequence_aggregate_row_not_in_ledger");
  assert.equal(skipped.length, 1, "锚点不给 ⇒ 必须如实发一条跳过事件");
  // 落盘行 0 增量：消息行必须仍是原来那 3 条（恢复自己写的是 issue #404 的 `…:control:resume-notice:…`
  // 控制行与下一轮的正文行，与桩无关）。
  assert.equal((await inner.loadRawRows(RUN_ID)).filter((record) => record?.round === 2
    && record?.kind === "message").length, 1,
  "账本里 `round: 2` 的消息行必须仍只有 1 条（第 2 条 = 桩落了账）");

  // 二次恢复：修前这里因为桩落了账（孤儿 `user`）而 `invalid_messages`。
  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const again = await runLoop({ store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(again.ok, true,
    "第二次恢复必须仍成功（修前：桩落成孤儿 `user` ⇒ `invalid_messages`；实测：" + String(again.error));
  assert.equal(stubRowsOf(rows).length, 0, "第二次恢复同样不许写桩行");
});

test("#421 中段悬空（崩溃轮形状）· file store 真落盘：桩写进文件、第二次恢复仍只一张", async () => {
  // 与上面那条同一个形状，换**真落盘**的 store：内存 store 证的是逻辑，这里证的是
  // 「桩真的进了档案」——`load()` 折回来仍是一条聚合 user 消息，第二次恢复不再补第二条。
  const dir = await makeTmp("erix-421-midseq-");
  const store = createFileTranscriptStore({ dir });
  await midSequenceDanglingScene(store, { toolUseIds: ["t1", "t2"], resultIds: ["t1"] });

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true, `第一次恢复必须成功（实测：${String(resumed.error)}）`);
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第一次恢复：桩必须补进上下文");
  assert.deepEqual(ledgerAggregates(await store.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }],
    "桩必须真的落进档案：`load()` 折回来仍是一条聚合 user 消息（t1 + 桩 t2）");

  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：${String(second.error)}）`);
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复：账本已认它 ⇒ 上下文里仍只有那一张桩（不是两张）");
  assert.deepEqual(ledgerAggregates(await store.load(RUN_ID)), [{ role: "user", ids: ["t1", "t2"] }],
    "第二次恢复之后账本形状不许变（仍是一条聚合 user 消息，桩不翻倍）");
});

test("#421 宿主 store 不折叠（`load()` 原样返回落盘行）· 已完成轮的桩也落账，seq 不重号", async () => {
  // 内置两个 store 的 `load()` 都会折叠，所以「已完成轮」的消息行在 `load()` 里看不见（那一格只修内存，
  // 见上一条用例）。但契约允许宿主自研 store **不折**（`src/loop/resume-manager.js` 会自己再折一次）——
  // 那种宿主上首片行仍然看得见，桩就**落得了账**。这一格同时钉住两件事：
  //   ① 已完成轮的桩真的写进账本（`partOf` → 首片）；
  //   ② 该轮的 `seq` 地板被抬到「落盘行里最大 seq + 1」（重号 ⇒ 内置 store 会抛 `dedup_payload_conflict`）。
  const rows = [];
  const seen = new Map();
  const store = {
    async appendRound(runId, record) {
      const key = record?.dedupKey ?? record?.roundKey;
      const payload = JSON.stringify(record);
      if (seen.has(key)) {
        // 与内置 store 同一条判据（`src/store/transcript-dedup.js`）：同 key 异 payload 直接抛。
        if (seen.get(key) !== payload) throw new Error(`dedup_payload_conflict: ${key}`);
        return;
      }
      seen.set(key, payload);
      rows.push(structuredClone(record));
    },
    async load() { return rows.map((row) => structuredClone(row)); },
    async markRunState() {},
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async loadRunStateStatus() { return undefined; },
  };
  await midSequenceDanglingScene(store, { toolUseIds: ["t1", "t2"], resultIds: ["t1"], withRoundCarrier: true });

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true, `恢复必须成功（实测：${String(resumed.error)}）`);
  assert.deepEqual(stubBlocks(provider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "桩必须补进本次上下文");

  const stubRows = stubRowsOf(rows);
  assert.equal(stubRows.length, 1, "不折叠的宿主上，已完成轮的桩也必须落成恰好一行");
  assert.equal(stubRows[0].partOf, `${RUN_ID}:msg:2:1`,
    "`partOf` 必须指向聚合消息的**首片**行（从 `load()` 里看得见的落盘行认出来）");
  assert.equal(stubRows[0].seq, 2, "seq 必须接在该轮最大 seq（1）之后：重号会被判成同 key 异 payload");
  assert.equal(new Set(rows.map((row) => row?.dedupKey ?? row?.roundKey)).size, rows.length,
    "全档的 key 必须唯一（seq 重号 = dedup_payload_conflict）");

  // 第二次恢复：`load()` 仍不折叠，桩已在账本里 ⇒ 上下文里仍只一张、且不再写新行。
  const before = rows.length;
  const secondProvider = createFakeProvider([endTurn("第二次续接完成")]);
  const second = await runLoop({ store, provider: secondProvider, executeTool: async () => "unused" });
  assert.equal(second.ok, true, `第二次恢复必须成功（实测：${String(second.error)}）`);
  assert.deepEqual(stubBlocks(secondProvider.requests[0].messages).map((block) => block.tool_use_id), ["t2"],
    "第二次恢复：桩在上下文里必须仍只有一张");
  assert.equal(stubRowsOf(rows).length, 1, "第二次恢复不得再写一条桩行");
  assert.ok(rows.length > before, "第二次恢复本身仍会写它自己的行（前置：这一次真的跑过）");
});

test("#421 配对成功的情形 ⇒ 上下文与账本里**零桩**（不掩盖真错误）", async () => {
  // ① 账本本来就配好对：恢复之后一个桩都不许出现。
  const paired = createMemoryTranscriptStore();
  await midSequenceDanglingScene(paired, { toolUseIds: ["t1", "t2"], resultIds: ["t1", "t2"] });
  const pairedProvider = createFakeProvider([endTurn("续接完成")]);
  const pairedRun = await runLoop({ store: paired, provider: pairedProvider, executeTool: async () => "unused" });
  assert.equal(pairedRun.ok, true, `前置：配好对的账本必须能恢复（实测：${String(pairedRun.error)}）`);
  assert.equal(stubBlocks(pairedProvider.requests[0].messages).length, 0,
    "能配上对的不得出现桩行（上下文）");
  assert.equal(stubBlocks(foldLedgerMessages(await paired.load(RUN_ID)).map((entry) => entry.message)).length, 0,
    "能配上对的不得出现桩行（账本）");

  // ② A 集合现场（#414）：`t2` 的结果**已成型、只差入账**。它在账本里没有行，但它**不是丢失** ——
  //    判据必须是「账本 + 即将入账的那批」，补桩就会造出同 id 的第二条结果。
  const inner = createMemoryTranscriptStore();
  await crashWithUnpersistedResult(inner);
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    provider,
    executeTool: async () => {
      throw new Error("补跑不该发生：A 集合不是 pending 工具");
    },
  });
  assert.equal(resumed.ok, true, `前置：A 集合现场必须能恢复（实测：${String(resumed.error)}）`);
  assert.equal(stubBlocks(provider.requests[0].messages).length, 0,
    "A 集合的真结果马上要入账 ⇒ 不得出现桩行（否则同一条聚合消息里会出现两个同 id 的 tool_result）");
  const t2 = resultsFor(provider.requests[0].messages, "t2");
  assert.equal(t2.length, 1, "A 集合的结果必须仍然恰好一份");
  assert.equal(t2[0].content, "out-t2", "内容必须逐字相同（不是桩正文）");
  const records = await inner.load(RUN_ID);
  assert.equal(stubBlocks(records.flatMap((record) => record.messages ?? [])).length, 0, "账本里也不许有桩");
  assert.deepEqual(ledgerResults(records), ["t1=out-t1", "t2=out-t2"], "账本照旧闭合（#420 的行为一条没变）");
});

test("#421 幂等 · 同一账本连做三次恢复：每个悬空 id 恰好一张桩，每次恢复都成功（账本只写一次）", async () => {
  const inner = createMemoryTranscriptStore();
  await midSequenceDanglingScene(inner, { toolUseIds: ["t1", "t2", "t3"], resultIds: ["t1"] });
  const { store, rows } = recordRoundWrites(inner);
  for (const round of [1, 2, 3]) {
    const provider = createFakeProvider([endTurn(`第 ${round} 次续接完成`)]);
    const resumed = await runLoop({ store, provider, executeTool: async () => "unused" });
    assert.equal(resumed.ok, true, `第 ${round} 次恢复必须成功（实测：${String(resumed.error)}）`);
    assert.equal(provider.requests.length, 1, `第 ${round} 次恢复必须真的发过一次模型请求`);
    const stubs = stubBlocks(provider.requests[0].messages);
    assert.deepEqual(stubs.map((block) => block.tool_use_id), ["t2", "t3"],
      `第 ${round} 次恢复：每个悬空 id 恰好一张桩（多一张 = 重复补，少一张 = 没补）`);
    const ledgerStubs = stubBlocks(foldLedgerMessages(await inner.load(RUN_ID)).map((entry) => entry.message));
    assert.deepEqual(ledgerStubs.map((block) => block.tool_use_id), ["t2", "t3"],
      `第 ${round} 次恢复之后：账本里每个悬空 id 也必须恰好一张桩`);
  }
  // 三次恢复合计只写了**两张**桩行（一次一张），不是每次恢复各写一遍。
  const stubRows = stubRowsOf(rows);
  assert.deepEqual(stubRows.map((record) => record.partOf), [`${RUN_ID}:msg:2:1`, `${RUN_ID}:msg:2:1`],
    "两张桩行都必须 `partOf` 指向同一条聚合消息的首片（三次恢复总共只写这两行）");
});

test("#421 畸形 id（`tool_use` 读不出 id）⇒ 不补，仍如实报 invalid_messages（0 次请求）", async () => {
  const inner = createMemoryTranscriptStore();
  const ts = () => new Date().toISOString();
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "user", content: [text("任务")] }],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:0`,
    kind: "message",
    seq: 0,
    // 第二个 `tool_use` 读不出 id：补不出**合法**的 `tool_result`（`isUsableToolUseId` 那一格）。
    messages: [{
      role: "assistant",
      content: [toolUse("t1"), { type: "tool_use", name: "work", input: {} }],
    }],
    ts: ts(),
  });
  await inner.appendRound(RUN_ID, {
    round: 2,
    roundKey: `${RUN_ID}:round:2`,
    dedupKey: `${RUN_ID}:msg:2:1`,
    kind: "message",
    seq: 1,
    messages: [{ role: "user", content: [toolResultBlock("t1")] }],
    ts: ts(),
  });

  const provider = createFakeProvider([endTurn("不该走到这里")]);
  const resumed = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, false, "畸形 id 补不出合法结果 ⇒ 仍然必须失败（不发明第三种兜底）");
  assert.match(String(resumed.error), /invalid_messages/u,
    `失败原因必须仍是 invalid_messages，实测 ${String(resumed.error)}`);
  assert.match(String(resumed.error), /assistant tool_use ids must be non-empty strings/u,
    "失败原因必须是「id 读不出来」那一句（不是「补桩补出来的新错误」）");
  assert.equal(provider.requests.length, 0, "红在第一次模型请求之前：0 次请求");
  const records = await inner.load(RUN_ID);
  assert.equal(stubBlocks(records.flatMap((record) => record.messages ?? [])).length, 0,
    "畸形 id 一格不许补桩（账本必须逐字保持原样）");
});

// ── #421 结构判据 + `mergeToolResultsIntoMessages` 的默认行为回归钉 ─────────────────────────────
test("#421 结构判据：桩正文只有一个定义点，且只由共享实现经唯一构造点造块", () => {
  const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const shared = "src/loop/pending-tool-result.js";
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (name.endsWith(".js")) files.push(rel);
    }
  };
  walk("src");
  const textOf = (rel) => readFileSync(join(root, rel), "utf8");
  assert.deepEqual(
    files.filter((rel) => /export const UNPERSISTED_TOOL_RESULT_TEXT\s*=/u.test(textOf(rel))),
    [shared],
    "桩正文的定义点必须唯一（第二份正文就是第二份事实）",
  );
  assert.deepEqual(
    files.filter((rel) => /buildToolResultFact\(\{(?:[^{}]*)UNPERSISTED_TOOL_RESULT_TEXT(?:[^{}]*)\}\)/u
      .test(textOf(rel))),
    [shared],
    "「造这张桩」的构造点必须全仓唯一，且只在共享实现里（`buildToolResultFact` 是唯一构造点）",
  );
  // 两种「没有结果」必须是两句话（尾部的「从未执行」 vs 本单的「执行过、结果没落盘」）。
  assert.notEqual(UNPERSISTED_TOOL_RESULT_TEXT, PENDING_TOOL_RESULT_TEXT,
    "「从未执行」与「执行过但结果没落盘」语义不同，正文不许共用一句");
  // 配对判据也只有一份：`pendingMidSequenceToolUses` 的定义点在本模块。
  assert.deepEqual(
    files.filter((rel) => /export function pendingMidSequenceToolUses\s*\(/u.test(textOf(rel))),
    [shared],
    "中段判据必须只有一份实现（任何别处再写一遍配对就是下一个 #394）",
  );
});

test("#421 回归钉：`mergeToolResultsIntoMessages` 的默认行为（尾部定位）逐字不变", () => {
  // ① 尾部定位：两条 assistant 各带一单（形状 4）⇒ 返回 `false`（本单**不**处理这个形状）。
  const consecutive = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1")] },
    { role: "assistant", content: [toolUse("t2")] },
    { role: "user", content: [toolResultBlock("t2")] },
  ];
  assert.equal(
    mergeToolResultsIntoMessages(consecutive, [toolResultBlock("t1")]),
    false,
    "形状 4（连续 assistant 各带一单）必须仍然返回 `false`（要插页，非目标）",
  );

  // ② 目标必须是**最后**那条带 `tool_use` 的 assistant 之后的那条 user 消息。
  const twoRounds = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1"), toolUse("t2")] },
    { role: "user", content: [toolResultBlock("t1")] },
    { role: "assistant", content: [toolUse("t3")] },
    { role: "user", content: [toolResultBlock("t3")] },
  ];
  const merged = mergeToolResultsIntoMessages(twoRounds, [toolResultBlock("t2")]);
  assert.equal(merged, false,
    "`t2` 属于**较早**那条 assistant：默认入口只认最后一条，不许合到错的消息上（返回 `false`）");
  assert.deepEqual(
    twoRounds[2].content.map((block) => block.tool_use_id),
    ["t1"],
    "默认入口不许改动那条较早的聚合消息",
  );
  assert.deepEqual(
    twoRounds[4].content.map((block) => block.tool_use_id),
    ["t3"],
    "默认入口也不许把别人的结果塞进尾部那条聚合消息",
  );

  // ③ 正常路径：尾部那条 assistant 的缺失结果合进紧跟的 user 消息（并就地返回它）。
  const tail = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1"), toolUse("t2")] },
    { role: "user", content: [toolResultBlock("t1")] },
  ];
  const target = mergeToolResultsIntoMessages(tail, [toolResultBlock("t2")]);
  assert.equal(target, tail[2], "合进的是紧跟那条 assistant 的 user 消息（就地改写、同一对象）");
  assert.deepEqual(
    tail[2].content.map((block) => block.tool_use_id),
    ["t1", "t2"],
    "尾部定位那一支的行为必须逐字不变（#414/#420/#430 全挂在这条路上）",
  );

  // ④ 同族新入口（本单）：定位由调用方点名 ⇒ 中段那一格能合，且**默认入口的行为没被改宽**。
  const mid = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [toolUse("t1"), toolUse("t2")] },
    { role: "user", content: [toolResultBlock("t1")] },
    { role: "assistant", content: [toolUse("t3")] },
    { role: "user", content: [toolResultBlock("t3")] },
  ];
  assert.equal(mergeToolResultsIntoAssistantNextMessage(mid, 1, [toolResultBlock("t2")]), mid[2],
    "点名 assistant 下标 ⇒ 中段那一格合得进去（默认入口对同一份输入返回 `false`）");
  assert.deepEqual(mid[2].content.map((block) => block.tool_use_id), ["t1", "t2"]);
  assert.deepEqual(mid[4].content.map((block) => block.tool_use_id), ["t3"], "尾部那条不许被牵连");
  assert.equal(mergeToolResultsIntoAssistantNextMessage(mid, 1, [toolResultBlock("t1")]), false,
    "已经在场的结果不重复追加（一条新增都没有 ⇒ `false`）");
  assert.equal(mergeToolResultsIntoAssistantNextMessage(mid, 0, [toolResultBlock("t2")]), false,
    "目标下标不是带 `tool_use` 的 assistant ⇒ `false`（不许瞎合）");
  assert.equal(mergeToolResultsIntoAssistantNextMessage(mid, 1, [toolResultBlock("t9")]), false,
    "要并进去的结果必须是这条 assistant 的 `tool_use` id ⇒ 否则 `false`");
});

// ── issue #754 裁决 2 · **第一必修**：快照的第二个正文出口 `partialText` 也要同源同去留 ──────────
// 独立评审（快照 `f1a2468`）实测：只关掉 `snapshot.messages` 那条闸门时，`src/loop/resume-manager.js`
// 里「本轮 assistant 未落账 ⇒ 把 `snapshot.partialText` 当 assistant 推上下文」那一条**没看探针**：
// 旧格式下告示说「上下文只从账本重建，不会重新出现在这里」，provider 却真收到了那段快照正文。
// 它不是改造后才有的字段（写侧 `src/loop/orchestrator.js`，引入于 `1aceadf`，早于 261021）⇒
// 同一条闸门外它照旧喂、并且**不计数**。两格把它钉死：旧格式一并抑制且计入条数；探针 = 0 逐字不变。
function legacyPartialScene() {
  const inner = createMemoryTranscriptStore();
  const seeded = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [text("第一轮答复")] },
  ];
  return { inner, seeded };
}

test("#754 第一必修 · 旧格式：`partialText` 与快照正文同去留 ⇒ 不喂，且计入告示那句「共 N 条」", async () => {
  const { inner, seeded } = legacyPartialScene();
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: seeded,
    summary: "missing",
    ts: new Date().toISOString(),
  });
  // 崩溃轮（round 2）：正文与半截正文**都只在快照里**（账本折出 2 条、锚点 2、快照 3 条 ⇒ 探针 = 1）。
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [...seeded, { role: "assistant", content: [text("快照里的崩溃轮正文")] }],
    partialText: "快照里的半截正文",
    partialRound: 2,
    persistedTranscriptLength: seeded.length,
    pendingToolUses: [],
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true, `前置：恢复必须起得来（实测：\`${String(resumed.error)}\`）`);
  const wire = JSON.stringify(provider.requests[0].messages);
  assert.equal(wire.includes("快照里的崩溃轮正文"), false, "崩溃轮正文不喂（第一刀已关）");
  assert.equal(wire.includes("快照里的半截正文"), false,
    "同一条闸门下 `partialText` 也不喂 ⇒ 否则「上下文只从账本重建」这句话就是假的");
  assert.match(JSON.stringify(provider.requests[0].messages.at(-1)),
    /本次恢复丢弃了 pre-261021 档案中只存在于快照的崩溃轮正文（共 2 条/u,
    "「共 N 条」必须是真数：1 段快照正文 + 1 段被抑制的 `partialText` = 2");
});

test("#754 第一必修的另一半 · 探针 = 0（现行写侧形状）⇒ `partialText` 照旧喂，告示一个字都不多", async () => {
  const { inner, seeded } = legacyPartialScene();
  await inner.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: seeded,
    summary: "missing",
    ts: new Date().toISOString(),
  });
  // 快照正文**不比锚点长**（长度 = 2 = 锚点）⇒ 探针 = 0，而 `partialText` 仍在：这就是 261021 之后
  // 设计上存在的那条通道（本轮 assistant 尚未成型，半截正文只有快照有）。
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [...seeded],
    partialText: "快照里的半截正文",
    partialRound: 2,
    persistedTranscriptLength: seeded.length,
    pendingToolUses: [],
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });

  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({ store: inner, provider, executeTool: async () => "unused" });
  assert.equal(resumed.ok, true, `前置：恢复必须起得来（实测：\`${String(resumed.error)}\`）`);
  const wire = JSON.stringify(provider.requests[0].messages);
  assert.equal(wire.includes("快照里的半截正文"), true,
    "现行路径不动：探针 = 0 时半截正文照旧补进上下文（那是设计上存在的通道，不是旧格式残余）");
  const noticeText = JSON.stringify(provider.requests.at(-1).messages.at(-1));
  assert.equal(noticeText.includes("本次恢复丢弃了 pre-261021"), false,
    "没丢正文就不许多说话：弃用句一个字都不出现");
  assert.match(noticeText, /崩溃时尾部没有未结清的 tool_use/u,
    "第二必修的反向半边：确实没有未结清时，那句 `NO_PENDING` 照旧出现");
});

test("#754 第二必修 · 放弃补跑在飞调用时，不许对模型说「没有未结清」，要逐条点名", async () => {
  const inner = createMemoryTranscriptStore();
  const seeded = [
    { role: "user", content: [text("任务")] },
    { role: "assistant", content: [text("第一轮答复")] },
  ];
  await inner.appendRound(RUN_ID, {
    round: 1, roundKey: `${RUN_ID}:round:1`, dedupKey: `${RUN_ID}:engine:round:1`,
    messages: seeded, summary: "missing", ts: new Date().toISOString(),
  });
  await inner.saveRunSnapshot(RUN_ID, {
    round: 2,
    messages: [...seeded, { role: "assistant", content: [text("第二轮"), toolUse("t9")] }],
    persistedTranscriptLength: seeded.length,
    pendingToolUses: [toolUse("t9")],
    executedToolIds: [],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    ts: new Date().toISOString(),
  });

  const executed = [];
  const provider = createFakeProvider([endTurn("续接完成")]);
  const resumed = await runLoop({
    store: inner,
    provider,
    executeTool: async ({ id }) => {
      executed.push(id);
      return `out-${String(id)}`;
    },
  });
  assert.equal(resumed.ok, true, `前置：恢复必须起得来（实测：\`${String(resumed.error)}\`）`);
  assert.deepEqual(executed, [], "前置：那一条确实没补跑");
  const noticeText = JSON.stringify(provider.requests[0].messages.at(-1));
  assert.equal(noticeText.includes("崩溃时尾部没有未结清的 tool_use"), false,
    `放弃补跑 ≠ 没有未结清：那句「上一次请求与结果已成对落账」是主动陈述假事实，实测 ${noticeText.slice(0, 240)}`);
  assert.match(noticeText, /放弃补跑这些在飞调用/u, "必须换成明示「放弃补跑」那一句");
  assert.match(noticeText, /t9/u, "要点名到具体是哪条调用被放弃（宿主/模型都得知道丢了哪一次副作用）");
  assert.match(noticeText, /共 1 条/u, "正文条数照旧为真（快照 3 格 - 锚点 2 = 1，本格无 partialText）");
});
