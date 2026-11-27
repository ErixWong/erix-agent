// @ts-check
// issue #261127-15 判据 6 + 真 store 端到端：**stamp 不外泄** 与 **真机形状下的地址不变性**。
//
// 上面的 40 格（test/tools/recall-ask-896c.test.js 17 格 + test/loop/recall-evidence-896c.test.js 23 格）
// 全是手造行夹具；本文件补的是「真跑一遍引擎」的两件事：
//   ① 折行 stamp（`stampRowPosition` 写 `round_no` + `msg_seq`）只在**账本侧**存在，绝不进 provider 请求体
//      ——判据 6：抓真实请求体断言 `JSON.stringify(request).includes("msg_seq") === false`；
//   ② 真 store 写出来的账本（load() 已折成载体行）里取出的地址，交回 `recall_read({evidenceRef})` 必须
//      found，且**同轮再落一条消息行**之后同一个 ref 仍 found（判据 1 的真机版，夹具之外的第二重保险）。
//
// 零真实 LLM、不写盘：假 provider + 内存 store。

import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "../helpers/run-direct.js";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { foldMessageRows } from "../../src/store/message-rows.js";
import { buildRecallRequest } from "../../src/loop/recall-runner.js";
import { createBuiltinRecallTools, collectRoundMessagesInRange } from "../../src/tools/recall.js";

const WRITE_FILE_TOOL = {
  name: "writeFile",
  description: "write a file",
  inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
};

/** 跑一轮（含一次写类工具调用），返回观测面：provider 抓到的请求体、store、load() 出来的行。 */
async function runOnceWithStore(runId) {
  const base = createMemoryTranscriptStore();
  /** @type {any[]} */
  const rawRows = [];
  const store = base;
  const appendRound = store.appendRound.bind(store);
  store.appendRound = async (/** @type {string} */ id, /** @type {any} */ record) => {
    rawRows.push(structuredClone(record));
    return appendRound(id, record);
  };
  const provider = createFakeProvider([
    {
      content: [
        { type: "text", text: "先写文件" },
        { type: "tool_use", id: "w1", name: "writeFile", input: { path: "ledger/rowkey.txt", content: "正文内容" } },
      ],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "收尾完成" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    seed: "任务：写一个文件然后收尾",
    executeTool: async ({ input }) => `wrote ${input?.path ?? ""}`,
    tools: [WRITE_FILE_TOOL],
    maxRounds: 4,
    config: { input: { wrapup: false }, run: { completion: false, reflection: false } },
    store,
    runId,
  });
  const rows = await store.load(runId);
  return { store, provider, rows, rawRows };
}

/** load() 出来的消息对象上**真的写了** `round_no` / `msg_seq` 的那几条（证明 stamp 真的落上了）。 */
function stampedMessages(rows) {
  /** @type {any[]} */
  const out = [];
  for (const row of rows) {
    for (const /** @type {any} */ message of Array.isArray(row?.messages) ? row.messages : []) {
      if (Number.isSafeInteger(message?.round_no) && Number.isSafeInteger(message?.msg_seq)) out.push(message);
    }
  }
  return out;
}

/** 生成侧口径（`recall_ask` 用的就是它）：每条可寻址消息的 `{round_no, msg_seq, text}`。 */
const unitsOf = (/** @type {any[]} */ rows) => collectRoundMessagesInRange(rows, 1, 999);

/** 同一轮内地址必须唯一（两套命名空间不相交的直接后果）。 */
function assertAddressesUnique(/** @type {any[]} */ units, label) {
  const seen = new Set();
  for (const /** @type {any} */ u of units) {
    const key = `${u.round_no}:${u.msg_seq}`;
    assert.ok(!seen.has(key), `${label}：第 ${u.round_no} 轮里地址 ${key} 被两条消息同时占用（命名空间撞了）`);
    seen.add(key);
  }
}

// ─── 判据 6：真实请求体里没有 round_no / msg_seq（stamp 不外泄）────────────────
test("#261127-15-6 provider 请求体里没有 round_no / msg_seq（真跑 + resume，抓真实请求体）", async () => {
  const runId = "issue-261127-15-purity";
  const { store, provider, rows } = await runOnceWithStore(runId);

  // 先自证非空转：load() 出来的消息**确实带**稳定位置（否则下面的「请求里没有它」是句空话）。
  const stamped = stampedMessages(rows);
  assert.ok(stamped.length > 0, "load() 出来的消息必须已带上 round_no / msg_seq（stamp 生效）");
  const units = unitsOf(rows);
  assert.ok(units.length > 0, "生成侧必须能从真机账本里取到可寻址的正文");
  assertAddressesUnique(units, "真机账本");

  // 第一段 run 的每一个真实请求体都不许出现这两个键。
  assert.ok(provider.requests.length > 0, "必须真的抓到过请求体");
  for (const request of provider.requests) {
    assert.equal(JSON.stringify(request).includes("msg_seq"), false, "请求体不许带 msg_seq");
    assert.equal(JSON.stringify(request).includes("round_no"), false, "请求体不许带 round_no");
  }

  // resume：时间线是从**已 stamp 的** load() 输出重建的 ⇒ 这一路才是 stamp 真会外泄的地方。
  const resumedProvider = createFakeProvider([
    { content: [{ type: "text", text: "续接完成" }], stopReason: "end_turn", times: 3 },
  ]);
  await runToolLoop({
    provider: resumedProvider,
    executeTool: async () => "unused",
    tools: [WRITE_FILE_TOOL],
    config: { input: { wrapup: false }, run: { resume: true, runId, maxRounds: 2, completion: false, reflection: false } },
    store,
  });
  assert.ok(resumedProvider.requests.length > 0, "resume 必须真的发过请求");
  for (const request of resumedProvider.requests) {
    assert.equal(JSON.stringify(request).includes("msg_seq"), false, "resume 的请求体不许带 msg_seq");
    assert.equal(JSON.stringify(request).includes("round_no"), false, "resume 的请求体不许带 round_no");
    assert.ok(
      (request.messages ?? []).length > 0,
      "resume 的请求体确实带着从 stamp 过的账本重建的时间线（否则本格空转）",
    );
  }
});

// ─── 判据 1 的真机版：真 store 账本取出的地址，同轮再落一条消息行仍 found ────────
test("#261127-15-1b 真 store 账本（load 已折成载体行）取出的地址 ⇒ found；同轮再落一条消息行仍 found", async () => {
  const runId = "issue-261127-15-rowkey";
  const { store, rows, rawRows } = await runOnceWithStore(runId);
  const target = unitsOf(rows).reduce(
    (/** @type {any} */ best, /** @type {any} */ u) => (best === null || u.text.length > best.text.length ? u : best),
    null,
  );
  assert.ok(target && target.text.length > 0, "账本里必须有一条可寻址、有正文的消息");

  const readLedgerRows = async () => store.load(runId);
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows });
  const ref = buildRecallRequest("q", [{
    round_no: target.round_no, row_key: target.row_key, msg_seq: target.msg_seq, text: target.text,
  }]).evidence[0];
  const before = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(before.status, "found", `真机地址必须回账本 found（实得 ${before.status}：${before.reason ?? ""}）`);
  assert.equal(before.text, target.text, "必须逐字等于账本原文");

  // 同轮**再落一条消息行**（真写侧形状：kind:"message" + 新的轮内 seq）：既有地址不许被顶位。
  const roundNo = target.round_no;
  // 下一号 seq 必须从**落盘原样行**（不是折好的行）上取：`load()` 已把消息行折进载体，载体上看不到 seq。
  const nextSeq = Math.max(
    -1,
    ...rawRows.filter((/** @type {any} */ r) => r?.kind === "message" && r?.round === roundNo)
      .map((/** @type {any} */ r) => /** @type {any} */ (r.seq)),
  ) + 1;
  await store.appendRound(runId, {
    round: roundNo,
    kind: "message",
    seq: nextSeq,
    dedupKey: `${runId}:msg:${roundNo}:${nextSeq}`,
    messages: [{ role: "user", content: "同轮后补的一条消息 APPEND_MARK" }],
  });
  const after = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(after.status, "found", `同轮追加消息行之后同一 ref 必须仍 found（实得 ${after.status}：${after.reason ?? ""}）`);
  assert.equal(after.text, target.text, "追加不许改动取回的正文");
  // 生成侧同口径复查：追加之后那条消息的地址逐字不变，新行拿的是新 seq。
  const unitsAfter = unitsOf(await store.load(runId));
  assertAddressesUnique(unitsAfter, "追加之后");
  assert.ok(unitsAfter.some((/** @type {any} */ u) => u.round_no === target.round_no
    && u.row_key === target.row_key && u.msg_seq === target.msg_seq && u.text === target.text),
  "既有地址必须仍指向同一条正文");

  // 折叠口径自证：把 load() 再折一次（宿主/ resume 都会这么做），地址同样不改（幂等 + stamp 已随消息走）。
  const refolded = foldMessageRows(await readLedgerRows());
  const { executeTool: refoldedRead } = createBuiltinRecallTools({ readLedgerRows: () => refolded });
  const refoldedAfter = JSON.parse(await refoldedRead({ name: "recall_read", input: { evidenceRef: ref } }));
  assert.equal(refoldedAfter.status, "found", `拿「再折一次」的行回验必须仍 found（实得 ${refoldedAfter.status}：${refoldedAfter.reason ?? ""}）`);
  assert.equal(refoldedAfter.text, target.text, "再折一次取回的正文逐字不变");
  assertAddressesUnique(unitsOf(refolded), "再折一次");
  assert.ok(unitsOf(refolded).some((/** @type {any} */ u) => u.round_no === target.round_no
    && u.row_key === target.row_key && u.msg_seq === target.msg_seq), "再折一次不丢稳定位置（幂等）");
});

// ─── copilot 复审抓到的唯一性缺口（PR #981 阻塞项）──────────────────────────
// 现场：同一轮里引擎会为不同 control slot 各写一条**带正文的行**（`…:engine:round:<n>:resume` /
// 判官 / 方向提示），它们的 `messages[0]` 都算成 `MSG_SEQ_CARRIER_BASE + 0` ⇒ 只靠
// `(round_no, msg_seq)` 会撞号，回验 `.find()` 命中第一条 ⇒ **证据指错正文**（静默错数据）。
// 修法：地址加第三个分量 `row_key`（行身份，`appendRound` 按它去重 ⇒ 不可变）。
test("#261127-15-7 同轮两条 control-slot 行（各带 messages[0]）⇒ 地址仍唯一", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "issue-261127-15-two-slots";
  await store.appendRound(runId, { round: 3, roundKey: `${runId}:round:3`, messages: [] });
  await store.appendRound(runId, {
    round: 3,
    dedupKey: `${runId}:engine:round:3:resume`,
    messages: [{ role: "user", content: [{ type: "text", text: "RESUME_NOTICE_TEXT" }] }],
  });
  await store.appendRound(runId, {
    round: 3,
    dedupKey: `${runId}:judge:round:3`,
    messages: [{ role: "user", content: [{ type: "text", text: "JUDGE_NOTE_TEXT" }] }],
  });
  const rows = await store.load(runId);
  const units = collectRoundMessagesInRange(rows, 3, 3);
  assert.equal(units.length, 2, "两条 control-slot 行各有一条正文");

  const addresses = units.map((/** @type {any} */ u) => `${u.round_no}|${u.row_key}|${u.msg_seq}`);
  assert.equal(new Set(addresses).size, 2, `地址必须互不相同（实得 ${addresses.join(" / ")}）`);
  assert.notEqual(units[0].row_key, units[1].row_key, "行身份是区分这两条的唯一手段");
  // 同一 `msg_seq`（都落在载体命名空间基址上）但行身份不同 ⇒ 仍能各取各的正文。
  assert.equal(units[0].msg_seq, units[1].msg_seq, "前提：这两条的 msg_seq 本来就相同");

  // 端到端：拿第一条的地址回验必须取回它自己的正文，不是另一条。
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => rows });
  const first = units[0];
  const { evidence } = buildRecallRequest("q", [{
    round_no: first.round_no, row_key: first.row_key, msg_seq: first.msg_seq, text: first.text,
  }]);
  const out = JSON.parse(await executeTool({ name: "recall_read", input: { evidenceRef: evidence[0] } }));
  assert.equal(out.status, "found");
  assert.equal(out.text, first.text, "必须取回它自己那一行的正文（不是同轮另一条 control slot 的）");
});
