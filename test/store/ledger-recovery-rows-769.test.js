// @ts-check
// issue #769：run snapshot「只有快照载着」那几格的 **append-only 账本恢复行**（载体 + 写点 + 幂等 + 字节）。
//
// 这个文件测的是「载体本身」，不测快照通道（那是 #767/#770 的地盘）：
//   1) **形状**：一条一个事件、`messages: []`（不载正文 ⇒ `restoreResume` 的 `records.flatMap(record.messages)`
//      不会把同一份正文恢复两遍，工单 261021 的「正文翻倍」不再被重新造出来）；
//   2) **写点**：工具执行那一刻就入账，位置在 `tool_result` 行**之前**（语义红线：执行发生在结果行落盘之前）；
//   3) **幂等**：唯一事件键 ⇒ 同一事件重放只有一行（`appendRound` 的同 key 同 payload 跳过）；
//   4) **latest-only vs append-only**：快照那一格会被下一轮盖掉，恢复行不会 ⇒ 读侧的首选来源只能是后者；
//   5) **字节**：并列报出「新增行字节 / 每轮」（现测，不抄 #768 的 371）。
//
// 零 npm 依赖：只用 `node:` 内置 + 相对路径。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDirect } from "../helpers/run-direct.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore } from "../../src/store/file.js";
import {
  RECOVERY_EVENT_PARTIAL_TEXT,
  RECOVERY_EVENT_TOOL_EXECUTED,
  RECOVERY_EVENTS,
  RECOVERY_ROW_KIND,
  buildPartialTextRecoveryRow,
  buildToolExecutedRecoveryRow,
  isRecoveryRow,
  partialTextEventDiscriminator,
  readExecutedToolIdRecoveryRows,
  readPartialTextRecoveryRow,
  readPartialTextRecoveryRounds,
  recoveryEventKey,
} from "../../src/store/recovery-rows.js";

const toolUseRound = (/** @type {string} */ id) => ({
  content: [{ type: "tool_use", id, name: "work", input: { step: id } }],
  stopReason: "tool_use",
});
const finalRound = (/** @type {string} */ text) => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});

/** 只挑恢复行（按落盘顺序）。 */
const recoveryRows = (/** @type {any[]} */ records) => records.filter((row) => isRecoveryRow(row));

// ── 1) 载体形状 ──────────────────────────────────────────────────────────────

test("#769 载体形状：恢复行一条一个事件、messages 为空（不载正文），两种事件各带自己的判别字段", () => {
  const executed = buildToolExecutedRecoveryRow({ runId: "r1", round: 3, toolUseId: "call-9" });
  const partial = buildPartialTextRecoveryRow({ runId: "r1", round: 3, text: "写到一半" });

  for (const [name, row] of [["tool-executed", executed], ["partial-text", partial]]) {
    assert.equal(row.kind, RECOVERY_ROW_KIND, `${name}：行类型必须是 "${RECOVERY_ROW_KIND}"（宿主看的就是这个 kind）`);
    assert.deepEqual(row.messages, [], `${name}：恢复行**不载正文**，否则 restoreResume 会把同一份正文恢复两遍`);
    assert.equal(row.round, 3, `${name}：顶层轮号要在（读侧按轮筛）`);
    assert.equal(row.roundKey, "r1:round:3", `${name}：roundKey 与引擎其它行同形`);
    assert.ok(RECOVERY_EVENTS.includes(row.recoveryEvent), `${name}：recoveryEvent 必须在已知事件清单里`);
    assert.ok(typeof row.ts === "string" && row.ts.length > 0, `${name}：ts 要在（宿主时间线）`);
    assert.ok(!JSON.stringify(row).includes('"content"'), `${name}：整行不许出现消息 content（正文翻倍的前置条件）`);
  }
  assert.equal(executed.recoveryEvent, RECOVERY_EVENT_TOOL_EXECUTED);
  assert.equal(executed.toolUseId, "call-9", "「执行过没有」必须由行**显式携带** toolUseId，不许靠推断");
  assert.equal(partial.recoveryEvent, RECOVERY_EVENT_PARTIAL_TEXT);
  assert.equal(partial.text, "写到一半");
});

test("#769 事件键：同一事件重放必得同一个键，不同事件必换键（幂等与「一条一个事件」的支点）", () => {
  const a = buildToolExecutedRecoveryRow({ runId: "r1", round: 2, toolUseId: "dup-1", ts: "2020-01-01T00:00:00.000Z" });
  const b = buildToolExecutedRecoveryRow({ runId: "r1", round: 2, toolUseId: "dup-1", ts: "2024-01-01T00:00:00.000Z" });
  assert.equal(a.dedupKey, b.dedupKey, "同一个 tool_use 的「执行过了」是同一个事件：ts 不同也必须同键（payload 指纹不含 ts）");
  assert.notEqual(
    a.dedupKey,
    buildToolExecutedRecoveryRow({ runId: "r1", round: 2, toolUseId: "dup-2" }).dedupKey,
    "另一个 tool_use 是另一个事件：必须换键，否则第二行会被去重吃掉",
  );
  assert.equal(
    partialTextEventDiscriminator("半截 A"),
    partialTextEventDiscriminator("半截 A"),
    "同一段正文重放 = 同键 = 幂等",
  );
  assert.notEqual(
    partialTextEventDiscriminator("半截 A"),
    partialTextEventDiscriminator("半截 AB"),
    "正文变长是新事件：append-only 只追加，绝不改写已落的行",
  );
  assert.equal(
    recoveryEventKey("r1", 4, RECOVERY_EVENT_TOOL_EXECUTED, "x"),
    "r1:engine:round:4:recovery:tool-executed:x",
    "事件键必须落在引擎命名空间里（与 `:control:` / `:fold:` 同一风格）",
  );
});

// ── 2) 写点：执行那一刻就入账，比结果行早 ─────────────────────────────────────

test("#769 写点：工具执行那一刻账本里就出现 tool-executed 恢复行，且排在 tool_result 行之前", async () => {
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: createFakeProvider([toolUseRound("call-1"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId: "rec-run",
  });

  const records = await store.loadRawRows("rec-run");
  const executed = records.filter((row) => isRecoveryRow(row) && row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  assert.equal(executed.length, 1, "一次执行 = 一条 tool-executed 行（一条一个事件）");
  assert.equal(executed[0].toolUseId, "call-1");
  assert.deepEqual(executed[0].messages, [], "引擎写的恢复行同样不载正文");
  assert.match(executed[0].dedupKey, /^rec-run:engine:round:\d+:recovery:tool-executed:call-1$/u,
    "引擎命名空间的事件键形状要钉住（宿主按 kind 过滤，引擎按它幂等）");

  const resultIndex = records.findIndex((row) => row.kind === "tool-result" && row.source === "engine");
  assert.ok(resultIndex >= 0, "前置：这一轮必须真有引擎写的 tool_result 行（否则下一条判据空转）");
  assert.ok(
    records.indexOf(executed[0]) < resultIndex,
    "执行行的落盘位置必须**早于**结果行：这正是「缺结果行推不出没执行」的现场，恢复行必须比结果行先到",
  );
});

// ── 3) 幂等：同事件重放不产生第二行 ──────────────────────────────────────────

test("#769 幂等（载体层）：同 key 同 payload 的第二次 appendRound 被跳过，账本只留一行", async () => {
  const store = createMemoryTranscriptStore();
  const first = await store.appendRound("rec-idem", buildToolExecutedRecoveryRow({
    runId: "rec-idem", round: 2, toolUseId: "dup-1", ts: "2020-01-01T00:00:00.000Z",
  }));
  const second = await store.appendRound("rec-idem", buildToolExecutedRecoveryRow({
    runId: "rec-idem", round: 2, toolUseId: "dup-1", ts: "2024-06-01T00:00:00.000Z",
  }));
  assert.ok(first !== false, "第一次 append 必须真写入（下面数得到那一行）");
  assert.equal(second, undefined, "同一事件重放必须被跳过：`appendRound` 的跳过的形状是返回 undefined（同 key 同 payload；payload 指纹不含顶层 ts）");
  const rows = recoveryRows(await store.loadRawRows("rec-idem"));
  assert.equal(rows.length, 1, "重放之后账本里仍然只有一行");

  // 正文变长 ⇒ 换键 ⇒ 新事件（恢复语义要求「最新的半截正文」必须能进账本）
  await store.appendRound("rec-idem", buildPartialTextRecoveryRow({ runId: "rec-idem", round: 5, text: "半" }));
  await store.appendRound("rec-idem", buildPartialTextRecoveryRow({ runId: "rec-idem", round: 5, text: "半截" }));
  const rowsAfter = recoveryRows(await store.loadRawRows("rec-idem"));
  assert.equal(rowsAfter.filter((r) => r.recoveryEvent === RECOVERY_EVENT_PARTIAL_TEXT).length, 2,
    "同轮换正文必须成为第二行：读侧取的是**最后**落盘的那一条");
  assert.deepEqual(readPartialTextRecoveryRow(rowsAfter, 5), { text: "半截", round: 5 },
    "读侧必须按落盘顺序取最后一条，绝不取第一条");
});

test("#769 幂等（run 层）：同一条 run 恢复后继续跑，同一个 tool_use 不会留下第二条恢复行", async () => {
  const store = createMemoryTranscriptStore();
  const executedCalls = [];
  const phaseOne = await runDirect({
    provider: createFakeProvider([toolUseRound("call-1"), toolUseRound("call-2")]),
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return `done-${input.step}`; },
    maxRounds: 2,
    config: { run: { completion: false } },
    store,
    runId: "rec-resume",
  });
  assert.deepEqual(executedCalls, ["call-1", "call-2"], "前置：两轮各执行一次");
  assert.equal(phaseOne.rounds, 2);

  const resumed = await runDirect({
    provider: createFakeProvider([finalRound("resumed"), finalRound("spare"), finalRound("spare")]),
    initialUserMessage: "must be ignored",
    config: { run: { completion: false } },
    store,
    runId: "rec-resume",
  });
  assert.equal(resumed.rounds, 3, "恢复必须接着上一轮的轮号往下走（前置：确实进了恢复路径）");

  const rows = (await store.loadRawRows("rec-resume"))
    .filter((row) => isRecoveryRow(row) && row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  const ids = rows.map((row) => row.toolUseId);
  assert.deepEqual(ids, ["call-1", "call-2"],
    "恢复之后账本里仍然只有这两条 tool-executed 行：既没有重复，也没有把已执行的工具再记一次");
  assert.deepEqual(executedCalls, ["call-1", "call-2"], "恢复之后 executeTool 一次都没被重放");
});

// ── 4) latest-only vs append-only：读侧首选来源只能是账本 ────────────────────

test("#769 快照那一格会被下一轮盖掉，恢复行不会 ⇒ 账本是唯一还活着的来源（读侧优先级的理由）", async () => {
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: createFakeProvider([toolUseRound("early-1"), toolUseRound("late-2"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId: "rec-latest",
  });
  const records = await store.loadRawRows("rec-latest");
  const rows = recoveryRows(records);
  const fromLedger = readExecutedToolIdRecoveryRows(records);
  assert.ok(fromLedger.has("early-1") && fromLedger.has("late-2"),
    "账本侧必须把**所有轮**执行过的 tool_use 都还在场（append-only：后面的轮不会盖掉前面的行）");

  // 快照那一格是 latest-only（`runSnapshotStore` 写的是同一份文件的覆盖写，见
  // `docs/host-consumer-contract.md` 的两轴载荷表与 `#767` 那一串停写裁决）；账本这一格是 append-only。
  // 两者能在同一份 `records` 里对照的**可测面**就是：早期那一轮的执行事实到后面几轮之后**仍然在场**，
  // 而且带的是**它自己那一轮**的轮号（不是被后面轮次改写后的值）。
  const early = rows.find((row) => row.toolUseId === "early-1");
  const late = rows.find((row) => row.toolUseId === "late-2");
  assert.ok(early !== undefined && late !== undefined, "两条早期/晚期执行行都必须在场");
  assert.ok(Number.isSafeInteger(early.round) && Number.isSafeInteger(late.round)
    && early.round < late.round,
    `恢复行必须各自带**自己那一轮**的轮号（early:${early.round} / late:${late.round}），`
    + "否则就是被后面轮次盖过——那正是快照那一格的形状");
});

test("#769 兜底不缺席：没有恢复行的老账本 ⇒ 读侧读出台账为空，快照那格仍是合法兜底", async () => {
  const store = createMemoryTranscriptStore();
  await store.appendRound("legacy-run", {
    round: 1, roundKey: "legacy-run:round:1", kind: "user", messages: [], ts: "2020-01-01T00:00:00.000Z",
  });
  const records = await store.loadRawRows("legacy-run");
  assert.deepEqual([...readExecutedToolIdRecoveryRows(records)], [],
    "#769 之前写的账本没有恢复行 ⇒ 台账必须是空集，读侧据此才允许回落快照（不许把「没有行」当成「没执行」）");
  assert.deepEqual(readPartialTextRecoveryRounds(records), [], "同理：半截正文的轮号台账为空");
  assert.equal(readPartialTextRecoveryRow(records, 1), undefined,
    "该轮没有可用恢复行时返回 undefined ⇒ 调用方才允许读快照兜底");
});

// ── 5) 字节：并列报出「新增行字节 / 每轮」（现测） ────────────────────────────

test("#769 字节：一次工具执行新增的账本行字节（现测，写进 REPORT 与契约）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "erix-769-bytes-"));
  const store = createFileTranscriptStore({ dir });
  const runId = "byte-run";
  await store.appendRound(runId, buildToolExecutedRecoveryRow({ runId, round: 1, toolUseId: "call-1" }));
  await store.appendRound(runId, buildPartialTextRecoveryRow({ runId, round: 1, text: "半截正文样例" }));

  const jsonl = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(jsonl.length, 1, `前置：目录里应当只有一份账本，实际 ${JSON.stringify(readdirSync(dir))}`);
  const lines = readFileSync(join(dir, jsonl[0]), "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, "两行都真落盘了");
  const bytesOf = (/** @type {string} */ kind) => lines
    .filter((line) => JSON.parse(line).recoveryEvent === kind)
    .reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
  const executedBytes = bytesOf(RECOVERY_EVENT_TOOL_EXECUTED);
  const partialBytes = bytesOf(RECOVERY_EVENT_PARTIAL_TEXT);
  assert.ok(executedBytes > 0 && partialBytes > 0, "字节必须是现测的正数");
  // 每轮口径：一轮一次工具执行 + 一段半截正文（#768 的三格搬进账本就是这个形状）
  const perRoundBytes = executedBytes + partialBytes;
  console.log(`#769 新增行字节 / 每轮：tool-executed ${executedBytes} B + partial-text ${partialBytes} B = ${perRoundBytes} B`);
  assert.ok(perRoundBytes < 4096, `每轮新增字节应当是个位数 KB 以内的小数，实测 ${perRoundBytes} B`);
});
