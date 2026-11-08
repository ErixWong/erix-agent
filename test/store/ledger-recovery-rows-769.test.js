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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// 卫生规则 B（scripts/test-hygiene-check.mjs）：test/** 里不许裸用 mkdtemp/mkdtempSync，临时目录只走本夹具。
import { makeTmp } from "../helpers/tmp.js";

import { runDirect, directError } from "../helpers/run-direct.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore, recoveryRowsPath } from "../../src/store/file.js";
// issue #769 R3（B）：新错误码从读侧导出，测试**不**拼字面量（拼错了不会红在真正要钉的地方）。
import { RECOVERY_ROWS_UNREADABLE } from "../../src/loop/resume-manager.js";
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

  // 本格钉的是**载体形状**与**不污染轮记录**；「恢复行排在 `tool_result` 之前」那句契约**不在这里**证明——
  // 事后的两次读（`listRecoveryRows()` / `load()`）是两条独立数组，比不出先后。次序由本文件末尾那条
  // 「（D）跨通道顺序」用**记录调用序列**的包装 store 证明（`calls` 里比较 `appendRecoveryRow` 与带
  // `tool_result` 的那次 `appendRound` 谁先）。反向证两条均已实跑：把执行器里那句 await 注释掉 ⇒ 本格与
  // 次序格一起红；只把恢复行落盘延后到下一次 `appendRound` 之后 ⇒ **只有**次序格红（"恢复行在第 3 次调用、
  // 结果行在第 2 次"），证明那条断言不是空转。
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

test("#769 R3（D）幂等（run 层）：续跑后又执行下一个工具 ⇒ 出现第二条**不同键**的恢复行，第一条无重复", async () => {
  const inner = createMemoryTranscriptStore();
  /** @type {string[]} */
  const executedCalls = [];
  // 崩溃现场是**真造**的：进程崩在「`tool-executed` 恢复行已落、`tool_result` 行还没落」那一刻——
  // 那一瞬间账本里没有结果行，唯一还活着的执行证据就是恢复行（本模块存在的理由）。
  // 修前那格（R3 验收点 D）用「非续跑的第二次调用 + 既存 `<runId>:msg:1:0` dedup 冲突」当恢复结果：
  // 第二次调用压根没传 `resume`，所以它测的是「同 runId 重跑」而不是「续跑」，既没证明续跑走完，
  // 也没证明第一条恢复行不被重复。这里换成手写崩溃现场 + 真 `resume: true`。
  const store = {
    ...inner,
    async appendRound(/** @type {string} */ runId, /** @type {any} */ record) {
      const hasResult = (record?.messages ?? []).some((/** @type {any} */ message) =>
        (Array.isArray(message?.content) ? message.content : [])
          .some((/** @type {any} */ block) => block?.type === "tool_result"));
      if (hasResult) throw new Error("simulated crash: tool_result row not persisted yet");
      return inner.appendRound(runId, record);
    },
  };
  const phaseOne = await directError({
    provider: createFakeProvider([toolUseRound("call-1"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return `done-${input.step}`; },
    config: { run: { completion: false } },
    store,
    runId: "rec-resume",
  });
  assert.match(String(phaseOne?.message ?? ""), /simulated crash/u,
    "前置：第一段必须真崩在结果行的写点上（否则就不是「只有恢复行知道执行过了」的现场）");
  assert.deepEqual(executedCalls, ["call-1"], "前置：工具真执行了一次，副作用已经发生");
  const afterCrash = (await inner.listRecoveryRows("rec-resume"))
    .filter((row) => row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  assert.deepEqual(afterCrash.map((row) => row.toolUseId), ["call-1"],
    "前置：崩溃现场里唯一还在账本里的执行证据，就是那一条 tool-executed 恢复行");

  // 第二段：**真续跑**，脚本交出**下一个**工具调用（call-2）⇒ 恢复行应当变成两条、键不同。
  const resumed = await runDirect({
    provider: createFakeProvider([toolUseRound("call-2"), finalRound("resumed")]),
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return `done-${input.step}`; },
    config: { run: { completion: false } },
    store: inner,
    runId: "rec-resume",
    resume: true,
  });
  assert.equal(resumed.termination?.reason, "end_turn",
    `续跑必须真跑完并正常收口（不是撞既存冲突当结果），实际终局 ${JSON.stringify(resumed.termination)}`);
  assert.equal(resumed.finalText, "resumed", "续跑跑到了脚本给的那条正文 ⇒ 它是**走完**的，不是中途终止");

  const rows = (await inner.listRecoveryRows("rec-resume"))
    .filter((row) => isRecoveryRow(row) && row.recoveryEvent === RECOVERY_EVENT_TOOL_EXECUTED);
  const ids = rows.map((row) => row.toolUseId);
  const keys = rows.map((row) => row.dedupKey);
  assert.deepEqual(ids, ["call-1", "call-2"],
    "续跑后账本里是**两条**恢复行：第一条（call-1）既没被重放也没被再记一次，第二条是续跑里真执行的 call-2");
  assert.equal(new Set(keys).size, 2,
    "两条必须落在**不同**事件键上（同键会被 appendRecoveryRow 的去重吃掉第二行 ⇒ 「一条一个事件」不成立）");
  assert.deepEqual(executedCalls, ["call-1", "call-2"],
    "executeTool 的轨迹就是幂等的判据：call-1 一次都没被重放（台账来自恢复行），call-2 真执行了（续跑真走完了）");
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
  console.log(`#769 新增行字节 / 每轮：tool-executed ${executedBytes} B + partial-text ${partialBytes} B = ${perRoundBytes} B（partial 那格**含**下面那段短样例正文，不是空载体行）`);
  console.log(`#769 真跑一轮实测：一条 tool-executed 恢复行 = ${liveBytes} B（无 partialPersistence ⇒ 没有 partial-text 行）`);
  assert.ok(perRoundBytes < 4096, `每轮新增字节应当是个位数 KB 以内的小数，实测 ${perRoundBytes} B`);
  assert.ok(liveBytes < 4096, `真跑一轮的恢复行也应当是小数，实测 ${liveBytes} B`);

  // issue #769 R3（C4）：**字节口径自证**。上面那 `partialBytes` 是**整行**字节，而行里就带着
  // `text: "半截正文样例"` 那段正文 ⇒ 这个数**不是**「不含正文的载体行」。口径错一次就够把「每轮
  // 只多几百字节」吹成与正文长度无关（实际随正文长度增长）。这里把口径钉成断言：同一条行把
  // `text` 挖空后必然更短，差值就是那段正文（含 JSON 转义）的字节。
  const partialLine = lines.find((line) => JSON.parse(line).recoveryEvent === RECOVERY_EVENT_PARTIAL_TEXT);
  assert.ok(partialLine !== undefined && partialLine.includes("半截正文样例"),
    "前置：partial 行确实带着那段短样例正文（口径自证的前提）");
  const barePartialLine = JSON.stringify({ ...JSON.parse(partialLine), text: "" });
  const bodyOverheadBytes = (Buffer.byteLength(partialLine, "utf8") + 1)
    - (Buffer.byteLength(barePartialLine, "utf8") + 1);
  assert.ok(bodyOverheadBytes > 0,
    `字节口径断言：partial-text 那行的字节**含正文**（把 text 挖空就少 ${bodyOverheadBytes} B）⇒ 任何「不含正文」的口径都是错的`);
});

// ── 6) issue #769 R3（B）：恢复行**读失败**是硬终止，**能力缺席**才是合法降级 ────

const R3_CRASH_ID = "rec-r3-crash";
const r3Text = (/** @type {string} */ v) => ({ type: "text", text: v });
const r3ToolUse = (/** @type {string} */ id) => ({ type: "tool_use", id, name: "work", input: { step: id } });

/**
 * 崩溃现场（形状取自 `test/loop-resume-unpersisted-tool-results.test.js` 的既有夹具）：
 * 账本里只有 round 1 的载体行（assistant 带着 `tool_use: t1`，**没有** `tool_result` 行），
 * run snapshot 说「t1 还挂着」，恢复行说「t1 执行过了」——两格谁也没说漏，但**来源不同**。
 * @param {any} inner
 * @param {{ snapshotExecutedToolIds: string[] }} opts
 */
async function r3CrashScene(inner, { snapshotExecutedToolIds }) {
  const messages = [
    { role: "user", content: [r3Text("任务")] },
    { role: "assistant", content: [r3Text("答复"), r3ToolUse("t1")] },
  ];
  await inner.appendRound(R3_CRASH_ID, {
    round: 1,
    roundKey: `${R3_CRASH_ID}:round:1`,
    dedupKey: `${R3_CRASH_ID}:engine:round:1`,
    messages,
    summary: "missing",
    ts: "2020-01-01T00:00:00.000Z",
  });
  await inner.saveRunSnapshot(R3_CRASH_ID, {
    round: 1,
    messages,
    persistedTranscriptLength: messages.length,
    executedToolIds: snapshotExecutedToolIds,
    pendingToolUses: [r3ToolUse("t1")],
    toolResults: [],
    toolOutputs: [],
    compactionStats: [],
    partialRound: 1,
    partialText: "答复",
    ts: "2020-01-01T00:00:00.000Z",
  });
  await inner.appendRecoveryRow(R3_CRASH_ID, buildToolExecutedRecoveryRow({
    runId: R3_CRASH_ID, round: 1, toolUseId: "t1",
  }));
  return inner;
}

test("#769 R3（B）listRecoveryRows 拒绝 ⇒ 终局点名 recovery_rows_unreadable（**不许**吞成空集后回落绿）", async () => {
  const inner = await r3CrashScene(createMemoryTranscriptStore(), { snapshotExecutedToolIds: [] });
  const store = {
    ...inner,
    listRecoveryRows: async () => {
      throw Object.assign(new Error("simulated I/O failure while reading recovery rows"), { code: "EIO" });
    },
  };
  /** @type {string[]} */
  const executedCalls = [];
  const provider = createFakeProvider([finalRound("resumed")]);
  const thrown = await directError({
    provider,
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return "out"; },
    config: { run: { completion: false } },
    store,
    runId: R3_CRASH_ID,
    resume: true,
  });
  assert.ok(thrown !== null, "读失败必须让 run 终止：修前它被吞成「没有恢复行」，于是同一个现场是**绿**的");
  assert.equal(thrown.code, RECOVERY_ROWS_UNREADABLE,
    `终局必须点名新错误码，实际 code=${String(thrown.code)} / message=${String(thrown.message).slice(0, 160)}`);
  // 终局字段面（契约面，不是内部诊断）：三件套齐全 ⇒ `fail` 按既有口径把 reason 定成 persistence_failed。
  assert.equal(thrown.termination?.reason, "persistence_failed",
    `终局 reason 要走「错误携带持久化信息」那条既有分支，实际 ${JSON.stringify(thrown.termination)}`);
  assert.equal(thrown.termination?.operation, "listRecoveryRows", "operation 要点名到方法，宿主才知道是哪个读口");
  assert.equal(thrown.termination?.phase, "resume_recovery_rows", "F4：phase 按失败点分格：读失败自成一格，不再与写侧 transcript / 清盘 recovery_rows_clear 混在一起");
  assert.equal(thrown.termination?.sideEffect, "not_started", "发生在续跑期、本 run 尚未执行任何工具 ⇒ 没有已发生的副作用");
  assert.equal(thrown.errorCode, "EIO", "errorCode 是**根因**分类（底层那条错的 code），与 persistence_failed / checkpoint_failed 同规则");
  assert.deepEqual(executedCalls, [],
    "工具一次都没被执行 ⇒ 这不是「吞成空集后照旧重放工具」那条老路（那条路这里会 push t1）");
  assert.equal(provider.requests.length, 0,
    "终止发生在第一次模型请求之前：回落快照的那条路会先发请求（所以本断言把「回落绿」钉死）");
});

test("#769 R5（M1）listRecoveryRows **resolve 出非数组**（undefined）⇒ 终局点名**同一个** recovery_rows_unreadable（不许吞成空集）", async () => {
  const inner = await r3CrashScene(createMemoryTranscriptStore(), { snapshotExecutedToolIds: [] });
  const store = {
    ...inner,
    // 不是抛错，而是「调用成功但返回坏形状」——上一段只封了 reject，非数组仍被 `: []` 吞成空集。
    listRecoveryRows: async () => undefined,
  };
  /** @type {string[]} */
  const executedCalls = [];
  const provider = createFakeProvider([finalRound("resumed")]);
  const thrown = await directError({
    provider,
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return "out"; },
    config: { run: { completion: false } },
    store,
    runId: R3_CRASH_ID,
    resume: true,
  });
  assert.ok(thrown !== null, "非数组返回值必须让 run 终止：修前它被吞成「没有恢复行」，同一个现场是**绿**的");
  assert.equal(thrown.code, RECOVERY_ROWS_UNREADABLE,
    `M1 的裁决是**同一个码**（不新增第二个码），实际 code=${String(thrown.code)} / message=${String(thrown.message).slice(0, 160)}`);
  assert.equal(thrown.termination?.reason, "persistence_failed",
    `终局 reason 与 reject 那格同轨，实际 ${JSON.stringify(thrown.termination)}`);
  assert.equal(thrown.termination?.operation, "listRecoveryRows", "operation 仍点名那个坏形状的读口");
  assert.equal(thrown.termination?.phase, "resume_recovery_rows", "phase 仍走读失败那一格（不是清盘格 recovery_rows_clear）");
  assert.equal(thrown.termination?.sideEffect, "not_started", "同样发生在续跑期、本 run 尚未执行任何工具");
  assert.equal(thrown.errorCode, "unknown",
    `errorCode 是**根因**分类：非数组返回没有底层错误码可透出 ⇒ 按既有口径落 unknown（不编一个码），实际 ${String(thrown.errorCode)}`);
  assert.match(String(thrown.cause?.message ?? ""), /resolved to undefined/,
    `cause 要点名**收到的形状**，排障时才知道 store 坏了什么，实际 cause=${String(thrown.cause?.message)}`);
  assert.deepEqual(executedCalls, [], "工具一次都没被执行 ⇒ 不是「吞成空集后照旧重放工具」那条老路");
  assert.equal(provider.requests.length, 0, "终止在第一次模型请求之前：吞成空集会先回落快照再发请求");
});

test("#769 R3（B）负控制：store **没有** listRecoveryRows ⇒ 仍是合法降级，走快照回落且不发新错误码（三格各自值点名）", async () => {
  const inner = await r3CrashScene(createMemoryTranscriptStore(), { snapshotExecutedToolIds: ["t1"] });
  const store = { ...inner };
  delete store.listRecoveryRows;
  assert.equal(typeof store.listRecoveryRows, "undefined", "前置：方法必须真的缺席（不是抛错的替身）");
  // 快照那三格的**各自值**（读侧在能力缺席时唯一的来源）——写现场时就先点名，别事后靠内存猜。
  const snapshot = await inner.loadLatestRunSnapshot(R3_CRASH_ID);
  assert.deepEqual(snapshot?.executedToolIds, ["t1"], "快照格 1：executedToolIds = [\"t1\"]（这是降级后唯一的「执行过了」来源）");
  assert.equal(snapshot?.partialRound, 1, "快照格 2：partialRound = 1");
  assert.equal(snapshot?.partialText, "答复", "快照格 3：partialText = \"答复\"");

  /** @type {any[]} */
  const events = [];
  /** @type {string[]} */
  const executedCalls = [];
  const provider = createFakeProvider([finalRound("resumed")]);
  const resumed = await runDirect({
    provider,
    initialUserMessage: "start",
    executeTool: async ({ input }) => { executedCalls.push(input.step); return "out"; },
    config: { run: { completion: false } },
    store,
    runId: R3_CRASH_ID,
    resume: true,
    onEvent: (/** @type {any} */ event) => events.push(event),
  });
  assert.equal(resumed.termination?.reason, "end_turn",
    `能力缺席必须是**降级**而不是失败（对照上面那格的 persistence_failed），实际 ${JSON.stringify(resumed.termination)}`);
  assert.equal(resumed.finalText, "resumed", "降级路径仍跑完了脚本：回落没有把 run 卡在恢复段");
  assert.deepEqual(executedCalls, [],
    "快照那格把 t1 记成已执行 ⇒ 降级路径也没重放它（回落是真的落到了快照，不是恰好没工具）");
  assert.equal(provider.requests.length, 1, "回落路径要真发第一次模型请求（与硬终止那格的 0 请求对照）");
  const unreadable = events.filter((event) => event?.type === "recovery_rows_unreadable"
    || String(event?.code ?? "") === RECOVERY_ROWS_UNREADABLE);
  assert.deepEqual(unreadable, [], "降级路径不许冒出新的宿主可见错误：那是「读失败」专用的");
});

// ── 7) issue #769 R3（A/C1）：`clearRecoveryRows` 的实现 + fresh start 的代际边界 ───

test("#769 R3（C1）两个 store 的 clearRecoveryRows：删的是恢复行通道，轮记录账本一条不少，幂等且不抛", async () => {
  const dir = await makeTmp("erix-769-r3-clear-");
  const fileStore = createFileTranscriptStore({ dir });
  const memoryStore = createMemoryTranscriptStore();

  for (const [name, store] of [["file", fileStore], ["memory", memoryStore]]) {
    // 前置：一条恢复行 + 两条轮记录（轮记录通道必须活过清盘）
    await store.appendRound("clr-1", {
      round: 1, roundKey: "clr-1:round:1", dedupKey: "clr-1:engine:round:1",
      messages: [{ role: "user", content: [r3Text("任务")] }], summary: "missing",
      ts: "2020-01-01T00:00:00.000Z",
    });
    await store.appendRound("clr-1", {
      round: 2, roundKey: "clr-1:round:2", dedupKey: "clr-1:engine:round:2",
      messages: [{ role: "assistant", content: [r3Text("答复")] }], summary: "missing",
      ts: "2020-01-01T00:00:00.000Z",
    });
    await store.appendRecoveryRow("clr-1", buildToolExecutedRecoveryRow({ runId: "clr-1", round: 1, toolUseId: "t9" }));

    assert.equal(await store.clearRecoveryRows("clr-1"), true, `${name}：真清掉了东西必须报 true`);
    assert.deepEqual(await store.listRecoveryRows("clr-1"), [], `${name}：清盘之后恢复行读口是空集`);
    assert.equal(await store.clearRecoveryRows("clr-1"), false, `${name}：第二次清盘是 no-op（幂等，且不抛）`);
    assert.equal((await store.load("clr-1")).length, 2,
      `${name}：**只清恢复行**：轮记录账本的两条历史行必须原样在场（契约里写明 resume:false 不清账本历史）`);
    assert.deepEqual([...readExecutedToolIdRecoveryRows(await store.listRecoveryRows("clr-1"))], [],
      `${name}：清盘之后「执行过没有」的账本来源是空集 ⇒ 下一次续跑不会再看见上一代的执行事实`);
  }

  // file store 的落盘面：删的是 `<runId>.recovery.jsonl`，**不是** `<runId>.jsonl`
  assert.ok(existsSync(recoveryRowsPath(dir, "clr-1")) === false, "file：恢复行文件必须真的被删掉了");
  assert.equal((await fileStore.load("clr-1")).length, 2, "file：轮记录那份 .jsonl 不受影响");
  // 清盘之后同一 runId 还能继续写（去重键缓存被抖掉，不会拿旧键集把新行误判成重复）
  assert.equal(await fileStore.appendRecoveryRow("clr-1",
    buildToolExecutedRecoveryRow({ runId: "clr-1", round: 3, toolUseId: "t9" })), true,
    "file：清盘后同 key 必须能再落一行（旧键集已随文件一起作废）");
});

test("#769 R3（A）代际边界：同一 runId 上第二次**非续跑**先把上一代恢复行清掉（轮记录历史不动）", async () => {
  const dir = await makeTmp("erix-769-r3-gen-");
  const inner = createFileTranscriptStore({ dir });
  /** @type {string[]} */
  const clearCalls = [];
  const store = {
    ...inner,
    async clearRecoveryRows(/** @type {string} */ runId) {
      clearCalls.push(runId);
      return inner.clearRecoveryRows(runId);
    },
  };
  const runId = "rec-gen";
  const file = recoveryRowsPath(dir, runId);

  await runDirect({
    provider: createFakeProvider([toolUseRound("call-1"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId,
  });
  assert.equal(clearCalls.length, 1, "第一段是 fresh start ⇒ 引擎必须恰好调一次清盘（不多不少，别每轮都清）");
  assert.deepEqual(clearCalls, [runId], "清盘要带本次的 runId（不是别的 run 的文件）");
  assert.ok(existsSync(file), "前置：第一段跑完，恢复行文件在场");
  assert.deepEqual((await inner.listRecoveryRows(runId)).map((row) => row.toolUseId), ["call-1"],
    "前置：第一代留下了一条 tool-executed 行");
  const ledgerBefore = await inner.load(runId);

  // 第二段：**同 runId + 显式 resume:false**（新逻辑 run 复用旧 ID 的最坏现场）
  const second = await directError({
    provider: createFakeProvider([finalRound("second")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId,
    resume: false,
  });
  if (second !== null) {
    // 既存问题（与本切片无关）：同 runId 重跑会撞 round 1 消息行的 dedup 冲突。它发生在**清盘之后**，
    // 所以不影响本格的判据；但只允许这一条既存冲突，换成别的失败说明本切片弄坏了 fresh start 路径。
    assert.match(String(second.message ?? ""), /dedup conflict/u,
      `第二次非续跑只允许撞既存的「消息行 dedup 冲突」，实际 ${String(second.message ?? "").slice(0, 200)}`);
  }
  assert.deepEqual(await inner.listRecoveryRows(runId), [],
    "第二段开始时上一代的 tool-executed 行必须已被清掉 ⇒ 下一次续跑不会把上一代的执行事实当成本代的");
  assert.equal(existsSync(file), false, "file：恢复行文件确实被删了（不是只清了进程内缓存）");
  assert.deepEqual(await inner.load(runId), ledgerBefore,
    "轮记录账本的历史行**一条都不动**（契约：resume:false 清恢复行，不清 <runId>.jsonl 历史）");
});

test("#769 R3（A/C1）store 没实现 clearRecoveryRows ⇒ 走能力位：一条诊断点名方法，run 照常跑完", async () => {
  const inner = createMemoryTranscriptStore();
  const store = { ...inner };
  delete store.clearRecoveryRows;
  assert.equal(typeof store.clearRecoveryRows, "undefined", "前置：方法必须真的缺席");
  /** @type {any[]} */
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider([toolUseRound("call-9"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId: "rec-no-clear",
    onEvent: (/** @type {any} */ event) => events.push(event),
  });
  assert.equal(result.termination?.reason, "end_turn",
    `能力缺席不能让 fresh start 变成失败，实际 ${JSON.stringify(result.termination)}`);
  const degraded = events.filter((event) => event?.type === "persistence_capability_degraded"
    && event?.method === "clearRecoveryRows");
  assert.equal(degraded.length, 1,
    `必须发**恰好一条**点名 clearRecoveryRows 的降级诊断，实际 ${JSON.stringify(events.filter((e) => e?.type === "persistence_capability_degraded").map((e) => e.method))}`);
  assert.deepEqual((await inner.listRecoveryRows("rec-no-clear")).map((row) => row.toolUseId), ["call-9"],
    "降级路径本身照常写恢复行（跳过的是清盘，不是写）");
});

// ── 8) issue #769 R3（D）：跨通道**先后顺序**要有调用次序证据 ────────────────────

test("#769 R3（D）跨通道顺序：tool-executed 恢复行的落盘调用**早于**写 tool_result 的那次 appendRound", async () => {
  const inner = createMemoryTranscriptStore();
  /** @type {Array<{channel:string, note:string}>} */
  const calls = [];
  const store = {
    ...inner,
    async appendRecoveryRow(/** @type {string} */ runId, /** @type {any} */ record) {
      calls.push({ channel: "recovery", note: `${record?.recoveryEvent}:${record?.toolUseId ?? "-"}` });
      return inner.appendRecoveryRow(runId, record);
    },
    async appendRound(/** @type {string} */ runId, /** @type {any} */ record) {
      const blocks = (record?.messages ?? []).flatMap((/** @type {any} */ m) =>
        Array.isArray(m?.content) ? m.content : []);
      const ids = blocks.filter((/** @type {any} */ b) => b?.type === "tool_result")
        .map((/** @type {any} */ b) => b.tool_use_id);
      calls.push({
        channel: "round",
        note: ids.length > 0 ? `tool_result:${ids.join("+")}` : "no-tool-result",
      });
      return inner.appendRound(runId, record);
    },
  };
  await runDirect({
    provider: createFakeProvider([toolUseRound("order-1"), finalRound("done")]),
    initialUserMessage: "start",
    executeTool: async () => "ok",
    config: { run: { completion: false } },
    store,
    runId: "rec-order",
  });
  const recoveryAt = calls.findIndex((call) => call.channel === "recovery" && call.note === `tool-executed:order-1`);
  const resultAt = calls.findIndex((call) => call.channel === "round" && call.note === "tool_result:order-1");
  assert.ok(recoveryAt >= 0, `必须真的写过 order-1 的 tool-executed 恢复行，实际调用序列 ${JSON.stringify(calls)}`);
  assert.ok(resultAt >= 0, `必须真的写过带 tool_result:order-1 的轮记录，实际调用序列 ${JSON.stringify(calls)}`);
  assert.ok(recoveryAt < resultAt,
    `契约里那句「恢复行排在 tool_result 之前」必须由调用次序证明：恢复行在第 ${recoveryAt} 次调用、结果行在第 ${resultAt} 次，序列 ${JSON.stringify(calls)}`);
});
