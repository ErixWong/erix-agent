// issue #414（探查票）的机器证据：**A 集合**——崩溃前**已执行完、结果已成型、但账本里没有对应
// `tool_result` 行**的那批结果——到底有没有以任何形式落到账本里。
//
// 现场（`src/loop/resume-manager.js:340-346`）：`restoreResume` 把 A 集合从 run snapshot 的
// `toolResults` 接回来，用 `mergeToolResultsIntoMessages` 合进内存里的 `messages`（合不进去就整条
// push 成一条 user 消息），然后写一句 `ctx.resumeUnpersistedToolResults = replayResults;`，注释称
// 「交给 orchestr 逐条入账」——**全仓没有读取方**（`grep -rn resumeUnpersistedToolResults src bin
// examples test` 只有这一行）。
//
// 本文件实测的三条事实：
//   ① 第一次恢复：A 集合的结果**在模型上下文里恰 1 份、内容逐字相同**——靠的是 run snapshot
//      再喂一遍，不是账本（用例 1，绿）。
//   ② 第一次恢复之后账本里**仍然没有**那个结果的行：该轮的 assistant 带着 tool_use，账本里却没有
//      配对的 tool_result ⇒ 「账本闭合」这条契约（`docs/host-consumer-contract.md`「A resumed run
//      leaves the ledger closed」）对 A 集合不成立（用例 2，**故意红**）。
//   ③ 再崩一次（新一轮的 run snapshot 是 latest-only 覆盖写 ⇒ 旧 `toolResults` 没了）之后：
//      A 集合的结果既不在账本、也不在快照 ⇒ 账本里那条 tool_use 永远悬空 ⇒ `restoreResume` 重建
//      出的上下文过不了 `validateMessages`，**整个 run 从此不可恢复**
//      （`invalid_messages: tool_result ids do not match assistant tool_use ids`，0 次模型请求；
//      用例 3，**故意红**）。
//
// 为什么不是「重复两份」：`load()` 折叠出来的那一轮永远只有已落盘的那条聚合消息，A 集合每次恢复
// 都是「从快照补进内存」而不是「从账本折出来」，所以它既不会翻倍，也永远不会被写下去。
//
// 两条红用例是**缺陷现场**（#414 只报现场、不改实现：时序语义属功能改动，另开票）。修法落地后它们
// 应转绿，届时删掉本节「故意红」的说明即可。**不许 skip、不许放宽断言。**
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

test("#414 A 集合 · 第一次恢复之后账本里仍然没有它的 tool_result 行（账本不闭合）", async () => {
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
    "恢复之后账本必须闭合：`t2` 的结果行要落下去（`resumeUnpersistedToolResults` 的注释承诺"
    + "「交给 orchestr 逐条入账」，而全仓没有读取方 ⇒ 今天只有 t1 一行；"
    + "见 `src/loop/resume-manager.js:346`）");
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
  assert.deepEqual(ledgerResults(await inner.load(RUN_ID)), ["t1=out-t1", "t3=out-t3", "t2=out-t2"],
    "账本最终必须闭合：三个 tool_use 各有一条结果行");
});
