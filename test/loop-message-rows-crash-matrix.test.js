// 工单 261021 第二刀·写侧：崩溃点矩阵（本单的安全感来源）。
//
// 判据只有一条：**只靠账本折叠**（`store.load()` 过 `src/store/message-rows.js`）就能重建出模型
// 当时该看到的上下文——尤其是**已经执行完的工具结果必须在**。改造前整轮正文只在轮记录落盘时写一次，
// 于是「工具执行期崩溃」这一格丢掉的是本轮 assistant 正文 + 已完成的工具结果，恢复只能退回
// run snapshot 的整坨 `messages` 副本（那份副本与档案正文会在下次恢复时各喂一遍）。
//
// 崩溃注入方式：包一层 store，让第 N 次 `appendRound` 抛错 ⇒ 前面的行照旧落盘、引擎随后中止，
// 于是账本恰好停在「模型消息已写 / 工具结果已写 / 轮行未写」这三种状态之一。
// 断言全部读 `store.load()` 的**折叠输出**（`records.flatMap(record.messages)`，即
// `src/loop/resume-manager.js#restoreResume` 重建上下文的唯一口径），不碰 run snapshot。
//
// 反向证（实测写进报告）：把「工具结果一产生就写」那一步去掉 ⇒ state2 / state3 必须红。
import test from "node:test";
import assert from "node:assert/strict";
import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { foldMessageRows } from "../src/store/message-rows.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const RUN_ID = "crash-matrix";
const neverCrash = () => false;
const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });
const endTurn = (value) => ({ content: [text(value)], stopReason: "end_turn" });
const TOOLS = [{ name: "work", replay: "safe", inputSchema: { type: "object" } }];

/** 第 N 次 appendRound 抛错的 store 包装：前面的行已经落盘，之后的写入全部没发生。 */
function crashOnNthAppend(inner, shouldCrash) {
  let attempts = 0;
  return {
    ...inner,
    async appendRound(runId, record) {
      attempts += 1;
      if (shouldCrash(attempts, record)) throw new Error(`simulated crash #${String(attempts)}`);
      return inner.appendRound(runId, record);
    },
  };
}

/** 跑一轮「两个工具结果 + 终稿」，在第 shouldCrash 命中的那次 appendRound 上崩掉。 */
async function runUntilCrash(shouldCrash) {
  const inner = createMemoryTranscriptStore();
  const store = crashOnNthAppend(inner, shouldCrash);
  let thrown = "";
  try {
    await runDirect({
      tools: TOOLS,
      wrapup: false,
      completion: false,
      stallDetection: false,
      maxRounds: 4,
      store,
      runId: RUN_ID,
      initialUserMessage: "任务",
      executeTool: async ({ id }) => `out-${String(id)}`,
      provider: createFakeProvider([
        { content: [toolUse("t1"), toolUse("t2")], stopReason: "tool_use" },
        endTurn("终稿"),
      ]),
    });
  } catch (error) {
    thrown = error?.message ?? String(error);
  }
  if (shouldCrash === neverCrash) assert.equal(thrown, "", "前置：没注入崩溃时不该报错");
  else assert.match(thrown, /simulated crash/u, "前置：必须真的崩在注入点");
  // 折叠层的读侧口径就是恢复路径的读法：不直接吃 run snapshot。
  const records = await inner.load(RUN_ID);
  return {
    records,
    messages: records.flatMap((record) => record.messages ?? []),
    inner,
  };
}

const toolResultsIn = (messages) => messages
  .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
  .filter((block) => block?.type === "tool_result")
  .map((block) => `${String(block.tool_use_id)}=${String(block.content)}`);

const hasRow = (records, matches) => records.some((record) => matches(record));
const isMessageRow = (record) => record?.kind === "message";

test("崩溃点矩阵 · state1 模型消息已写、工具结果未写、轮行未写：assistant 正文靠折叠就在", async () => {
  // 第 2 次 appendRound = 本轮 assistant 消息行（第 1 次是 round 0 种子行）⇒ 让它落盘，
  // 下一次（第一条工具结果行）崩掉 ⇒ 账本里只有种子行 + assistant 正文。
  const { messages, records } = await runUntilCrash((_attempts, record) => (
    record?.kind === "message" && record?.seq === 1
  ));
  assert.ok(hasRow(records, (record) => isMessageRow(record) && record.seq === 0),
    "本轮 assistant 必须已经单独成行（不等轮行）");
  assert.ok(!hasRow(records, (record) => record?.dedupKey === `${RUN_ID}:engine:round:1`),
    "前置：轮行还没写");
  const assistant = messages.find((message) => message?.role === "assistant");
  assert.ok(assistant !== undefined, "只靠账本折叠必须能重建出本轮 assistant 消息");
  assert.deepEqual((assistant.content ?? []).map((block) => block.id), ["t1", "t2"],
    "两个 tool_use 都必须在（模型已经提出的那次请求不能凭空消失）");
  assert.deepEqual(toolResultsIn(messages), [], "前置：这一格里一个工具结果都还没产生");
});

test("崩溃点矩阵 · state2 第一条工具结果已写：已执行的结果必须在，未执行的不在", async () => {
  // 第 3 次 appendRound = 第二条工具结果行 ⇒ 第一条已落盘、第二条与轮行都没写。
  const { messages, records } = await runUntilCrash((_attempts, record) => (
    record?.kind === "message" && record?.seq === 2
  ));
  assert.ok(!hasRow(records, (record) => record?.dedupKey === `${RUN_ID}:engine:round:1`),
    "前置：轮行没写，正文没有任何一处兜着它");
  assert.deepEqual(toolResultsIn(messages), ["t1=out-t1"],
    "已执行完的工具结果必须靠账本折叠重建出来（改造前这一格只能靠 run snapshot 的正文副本兜住）");
  assert.ok(!toolResultsIn(messages).includes("t2=out-t2"),
    "没执行的那条不该出现（否则恢复后会重复执行外部副作用）");
});

test("崩溃点矩阵 · state3 全部工具结果已写、轮行未写：两条结果都在（无载体行时原样透传）", async () => {
  // 轮行（engine:round:1）落盘那一刻崩掉 ⇒ 三条消息行都在、轮行没有。
  const { messages, records } = await runUntilCrash((_attempts, record) => (
    record?.dedupKey === `${RUN_ID}:engine:round:1`
  ));
  assert.ok(!hasRow(records, (record) => record?.dedupKey === `${RUN_ID}:engine:round:1`),
    "前置：轮行没落盘");
  assert.deepEqual(toolResultsIn(messages), ["t1=out-t1", "t2=out-t2"],
    "两个已完成的外部副作用必须一个都不丢");
  // 无载体行 ⇒ 消息行原样留在数组里（`src/store/message-rows.js` 口径第 2 条）：
  // 每条 tool_result 各自成一条 user 消息，仍然是合法的配对形状。
  const resultMessages = messages.filter((message) => message?.role === "user"
    && (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_result"));
  assert.equal(resultMessages.length, 2, "无载体行时不吞行、不改写：分片各自原样透传");
});

test("崩溃点矩阵 · state0 不崩：轮行落盘后，分片折回同一条 user 消息、消息行不再单独出现", async () => {
  const { messages, records } = await runUntilCrash(neverCrash);
  assert.ok(!hasRow(records, isMessageRow),
    "有轮行当载体时，load() 不得再把消息行单独暴露给宿主");
  const resultMessage = messages.find((message) => message?.role === "user"
    && (Array.isArray(message?.content) ? message.content : [])
      .every((block) => block?.type === "tool_result")
    && (Array.isArray(message?.content) ? message.content : []).length > 0);
  assert.ok(resultMessage !== undefined, "工具结果必须折回一条 user 消息");
  assert.equal((resultMessage.content ?? []).length, 2,
    "`partOf` 分片要接回同一条消息（改造前就是一条 user 消息的两个 content block）");
  assert.deepEqual(toolResultsIn(messages), ["t1=out-t1", "t2=out-t2"], "顺序按 seq 升序");
});

test("崩溃重跑幂等：同 (round, seq) 同内容重复写不产生第二行", async () => {
  const store = createMemoryTranscriptStore();
  const row = (ts) => ({
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:msg:1:0`,
    kind: "message",
    seq: 0,
    messages: [{ role: "assistant", content: [text("同一份正文")] }],
    ts,
  });
  await store.appendRound(RUN_ID, row("2026-10-21T00:00:00.000Z"));
  await store.appendRound(RUN_ID, row("2026-10-21T00:05:00.000Z"));
  const records = await store.load(RUN_ID);
  assert.equal(records.length, 1, "重复写同一 (round, seq) 同 payload 必须幂等跳过");
  // 载体行在场 ⇒ 折回它身上；这里单独验证「没有载体行」时也不会冒出第二行。
  await store.appendRound(RUN_ID, {
    round: 1,
    roundKey: `${RUN_ID}:round:1`,
    dedupKey: `${RUN_ID}:engine:round:1`,
    messages: [],
    ts: "2026-10-21T00:06:00.000Z",
  });
  const folded = await store.load(RUN_ID);
  // 载体行一到场，那条消息行就被折进去（不再单独暴露），且仍然只有一份正文。
  assert.equal(folded.length, 1, "消息行被折进载体行，不再单独出现");
  assert.equal(folded.flatMap((record) => record.messages ?? []).length, 1);
  assert.deepEqual(foldMessageRows([]), []);
});
