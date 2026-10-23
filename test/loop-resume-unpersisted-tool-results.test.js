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

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

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
async function runLoop({ store, provider, executeTool, resume = true, initialUserMessage }) {
  try {
    const result = await runToolLoop({
      provider,
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
      executeTool,
    });
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
