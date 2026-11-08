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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// 卫生规则 B（scripts/test-hygiene-check.mjs）：test/** 里不许裸用 mkdtemp/mkdtempSync，临时目录只走本夹具。
import { makeTmp } from "../helpers/tmp.js";

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

  // 恢复行走**自己的通道**（第 2 段换道裁决）：读口是 `listRecoveryRows()`，不在轮记录里。
  const executed = (await store.listRecoveryRows("rec-run"))
    .filter((row) => row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  assert.equal(executed.length, 1, "一次执行 = 一条 tool-executed 行（一条一个事件）");
  assert.equal(executed[0].toolUseId, "call-1");
  assert.deepEqual(executed[0].messages, [], "引擎写的恢复行同样不载正文");
  assert.match(executed[0].dedupKey, /^rec-run:engine:round:\d+:recovery:tool-executed:call-1$/u,
    "引擎命名空间的事件键形状要钉住（宿主按 kind 过滤，引擎按它幂等）");

  // **换道的全部意义**：轮记录通道一个字节都不许多出来。读轮记录的每一处（`load()` 的行序与索引、
  // 聚合预算、`onRound`、261021 golden 夹具）实测都被恢复行污染过 ⇒ 这里钉住「不进 load()」。
  const roundRecords = await store.load("rec-run");
  assert.equal(
    roundRecords.filter((row) => isRecoveryRow(row)).length, 0,
    "轮记录通道里不许出现恢复行：它不是一轮，进去就把「最近一条轮记录」换成了没有 judge/正文的空行",
  );
  assert.equal(
    (await store.loadRawRows("rec-run")).filter((row) => isRecoveryRow(row)).length, 0,
    "原始行读口同样不含恢复行（两侧同一口径，宿主不必在两份读口里各滤一次）",
  );
  const lastRound = roundRecords.filter((row) => (row.round ?? 0) > 0).at(-1);
  assert.ok(lastRound !== undefined && Array.isArray(lastRound.messages) && lastRound.messages.length > 0,
    "最后一条轮记录仍须是**真轮记录**并带着本轮正文（恢复行没把它挤掉）");
});

// ── 3) 幂等：同事件重放不产生第二行 ──────────────────────────────────────────

test("#769 幂等（载体层）：同 key 同 payload 的第二次 appendRecoveryRow 被跳过，通道里只留一行", async () => {
  const store = createMemoryTranscriptStore();
  const first = await store.appendRecoveryRow("rec-idem", buildToolExecutedRecoveryRow({
    runId: "rec-idem", round: 2, toolUseId: "dup-1", ts: "2020-01-01T00:00:00.000Z",
  }));
  const second = await store.appendRecoveryRow("rec-idem", buildToolExecutedRecoveryRow({
    runId: "rec-idem", round: 2, toolUseId: "dup-1", ts: "2024-06-01T00:00:00.000Z",
  }));
  assert.equal(first, true, "第一次 append 必须报「真落了一行」");
  assert.equal(second, false, "同一事件重放必须报「跳过」（同事件键 + 同 payload；payload 指纹不含顶层 ts）");
  const rows = recoveryRows(await store.listRecoveryRows("rec-idem"));
  assert.equal(rows.length, 1, "重放之后账本里仍然只有一行");

  // 正文变长 ⇒ 换键 ⇒ 新事件（恢复语义要求「最新的半截正文」必须能进账本）
  await store.appendRecoveryRow("rec-idem", buildPartialTextRecoveryRow({ runId: "rec-idem", round: 5, text: "半" }));
  await store.appendRecoveryRow("rec-idem", buildPartialTextRecoveryRow({ runId: "rec-idem", round: 5, text: "半截" }));
  const rowsAfter = recoveryRows(await store.listRecoveryRows("rec-idem"));
  assert.equal(rowsAfter.filter((r) => r.recoveryEvent === RECOVERY_EVENT_PARTIAL_TEXT).length, 2,
    "同轮换正文必须成为第二行：读侧取的是**最后**落盘的那一条");
  assert.deepEqual(readPartialTextRecoveryRow(rowsAfter, 5), { text: "半截", round: 5 },
    "读侧必须按落盘顺序取最后一条，绝不取第一条");
});

test("#769 幂等（run 层）：同一条 run 恢复后继续跑，同一个 tool_use 不会留下第二条恢复行", async () => {
  const store = createMemoryTranscriptStore();
  const executedCalls = [];
  const phaseOne = await runDirect({
    provider: createFakeProvider([toolUseRound("call-1"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return `done-${input.step}`; },
    config: { run: { completion: false } },
    store,
    runId: "rec-resume",
  });
  assert.deepEqual(executedCalls, ["call-1"], "前置：第一段真执行了一次工具");
  assert.equal(phaseOne.rounds, 2, "前置：第一段确实跑到了带正文的那一轮");

  // 基线（合并基点 7181a1b 的独立 worktree 实测）：**恢复一个「跑过工具」的 run 本来就会抛**
  // `transcript appendRound dedup conflict (key=<runId>:msg:1:0)`——引擎重写 round 1 的消息行时
  // payload 与账本里那条不同。这是**既存问题**（与本切片无关，本切片没碰消息行），
  // 但对本例恰好是**最有价值的现场**：恢复跑会**再走一遍 round 1 的写账本路径**，
  // 于是「同一事件重放会不会多写一条恢复行」被真跑一遍。所以这里 catch 住它，只问恢复行与执行次数。
  let resumeError = null;
  let resumed = null;
  try { resumed = await runDirect({
    // 脚本给足：恢复跑的轮数不是本例的判据（判据是「已执行过的工具没被重放、恢复行没多出一条」）。
    provider: createFakeProvider([finalRound("resumed"), finalRound("spare-1"), finalRound("spare-2"), finalRound("spare-3")]),
    // 装配端口要求 executeTool 在场（恢复跑也可能执行工具）；本例的 provider 只出正文，不会真调到它。
    executeTool: async () => "not-called",
    // 与第一段同一条初始消息：seed 行（round 0）的 dedupKey 相同，正文不同时账本会按
    // 「同键不同 payload」直接拒绝——那是 seed 自己的规则，与恢复行无关，别让它抢掉本例的判据。
    initialUserMessage: "start",
    config: { run: { completion: false } },
    store,
    runId: "rec-resume",
  });
  } catch (error) {
    resumeError = error;
  }
  const conflict = String(resumeError?.message ?? "");
  assert.ok(
    resumed !== null || /dedup conflict/u.test(conflict),
    `恢复路径必须真走一遍：要么跑完，要么撞到上面说的那条既存 dedup 冲突；实际 ${conflict.slice(0, 160)}`,
  );
  if (resumeError !== null) {
    assert.match(conflict, /rec-resume:msg:1:0/u,
      "只允许那条既存的「消息行 dedup 冲突」（key=<runId>:msg:1:0）；换成了别的失败说明本切片弄坏了恢复路径：" + conflict.slice(0, 200));
  }

  const rows = (await store.listRecoveryRows("rec-resume"))
    .filter((row) => isRecoveryRow(row) && row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  const ids = rows.map((row) => row.toolUseId);
  assert.deepEqual(ids, ["call-1"],
    "恢复之后账本里仍然只有那一条 tool-executed 行：既没有重复，也没有把已执行的工具再记一次");
  assert.deepEqual(executedCalls, ["call-1"],
    "恢复之后 executeTool 一次都没被重放：台账来自账本恢复行（读侧优先读账本）⇒ 已执行的工具不再跑第二遍，"
    + "也就不会再写出第二条恢复行（事件键 + 台账同源合起来的幂等效果）");
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
  const records = await store.listRecoveryRows("rec-latest");
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
  const records = await store.listRecoveryRows("legacy-run");
  assert.deepEqual([...readExecutedToolIdRecoveryRows(records)], [],
    "#769 之前写的账本没有恢复行 ⇒ 台账必须是空集，读侧据此才允许回落快照（不许把「没有行」当成「没执行」）");
  assert.deepEqual(readPartialTextRecoveryRounds(records), [], "同理：半截正文的轮号台账为空");
  assert.equal(readPartialTextRecoveryRow(records, 1), undefined,
    "该轮没有可用恢复行时返回 undefined ⇒ 调用方才允许读快照兜底");
});

// ── 5) 字节：并列报出「新增行字节 / 每轮」（现测） ────────────────────────────

test("#769 字节：一次工具执行新增的账本行字节（现测，写进 REPORT 与契约）", async () => {
  const dir = await makeTmp("erix-769-bytes-");
  const store = createFileTranscriptStore({ dir });
  const runId = "byte-run";
  await store.appendRecoveryRow(runId, buildToolExecutedRecoveryRow({ runId, round: 1, toolUseId: "call-1" }));
  await store.appendRecoveryRow(runId, buildPartialTextRecoveryRow({ runId, round: 1, text: "半截正文样例" }));

  // 恢复行落在**自己的文件**里（`<runId>.recovery.jsonl`）：轮记录那份 `.jsonl` 一个字节都不许多。
  // 写侧是 fire-and-forget（「记账失败绝不拖垮这一轮」），所以这里要等它落盘，不能假设已写完。
  const recoveryFile = runId + ".recovery.jsonl";
  for (let i = 0; i < 50 && !readdirSync(dir).includes(recoveryFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listed = readdirSync(dir);
  assert.ok(listed.includes(recoveryFile), `前置：目录里应当有恢复行文件 ${recoveryFile}，实际 ${JSON.stringify(listed)}`);
  const lines = readFileSync(join(dir, recoveryFile), "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2, "两行都真落盘了");
  const bytesOf = (/** @type {string} */ kind) => lines
    .filter((line) => JSON.parse(line).recoveryEvent === kind)
    .reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
  const executedBytes = bytesOf(RECOVERY_EVENT_TOOL_EXECUTED);
  const partialBytes = bytesOf(RECOVERY_EVENT_PARTIAL_TEXT);
  assert.ok(executedBytes > 0 && partialBytes > 0, "字节必须是现测的正数");
  // 每轮口径：一轮一次工具执行 + 一段半截正文（#768 的三格搬进账本就是这个形状）
  const perRoundBytes = executedBytes + partialBytes;
  // 载体字节之外再量一次**真跑一轮**的账本增量（引擎写的那一条才是线上形状）。
  const liveStore = createFileTranscriptStore({ dir });
  await runDirect({
    provider: createFakeProvider([
      { content: [{ type: "tool_use", id: "byte-call", name: "work", input: {} }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "fine" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store: liveStore,
    runId: "byte-live",
  });
  const liveFile = "byte-live.recovery.jsonl";
  for (let i = 0; i < 50 && !readdirSync(dir).includes(liveFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const liveLines = readdirSync(dir).includes(liveFile)
    ? readFileSync(join(dir, liveFile), "utf8").split("\n").filter((line) => line.length > 0)
    : [];
  assert.equal(liveLines.length, 1, `真跑一轮（一次工具执行）应当写出恰好一条恢复行，实测 ${liveLines.length} 条`);
  const liveBytes = Buffer.byteLength(liveLines[0], "utf8") + 1;
  assert.ok(liveBytes > 0, "真跑的恢复行字节必须是正数");
  // 换道的另一半：真跑那一段的**轮记录**文件里一条恢复行都没有（宿主读轮记录时不必先滤 kind）。
  const liveRoundRows = readFileSync(join(dir, "byte-live.jsonl"), "utf8")
    .split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
  assert.ok(liveRoundRows.length > 0, "前置：真跑那一段的轮记录要有行");
  assert.equal(liveRoundRows.filter((row) => isRecoveryRow(row)).length, 0,
    "轮记录那份 .jsonl 里不许混进恢复行：它得保持「一行就是一轮」的形状");
  assert.ok(liveRoundRows.some((row) => (row.messages ?? []).length > 0),
    "轮记录仍带着本轮正文（正文没被搬到恢复行通道去）");
  console.log(`#769 新增行字节 / 每轮：tool-executed ${executedBytes} B + partial-text ${partialBytes} B = ${perRoundBytes} B`);
  console.log(`#769 真跑一轮实测：一条 tool-executed 恢复行 = ${liveBytes} B（无 partialPersistence ⇒ 没有 partial-text 行）`);
  assert.ok(perRoundBytes < 4096, `每轮新增字节应当是个位数 KB 以内的小数，实测 ${perRoundBytes} B`);
  assert.ok(liveBytes < 4096, `真跑一轮的恢复行也应当是小数，实测 ${liveBytes} B`);
});
