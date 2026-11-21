// @ts-check
// issue #881：交付物判据「这次判不了」必须**说出来**。
//
// 现场：#711 把 exec 的写形态记进台账，并把「我看不见」写成 finalGuard payload 的三个**加法键**
// （`fileWritesBlind` / `fileWritesBlindToExec` / `execWriteUnresolvedCount`）。但那三格只住在载荷里：
// 宿主不读 payload 就只看到「判据通过」，而裸 `--require-deliverable` 命中盲区时返回的是
// `ok:true` + 一句 detail ⇒ 人眼面什么都没变。本单补的是一条 one-shot 事件 `deliverable_blind`。
//
// 本文件的格子（判据 ①②③④ + 三条边界/纯度钉）：
//   ① 盲区 run ⇒ **恰好一条**事件，载荷点名两个计数；宿主传了 runId 才带 runId 键；
//   ② 正常 run（只有写工具 / exec 目标全部解析出来）⇒ **零事件**（不许把每个 run 刷成噪音）；
//   ③ 设备丢弃（`cat a > /dev/null`）⇒ **零事件**：#711 之后它既不计入写形态、也不举细盲区旗；
//   ④ one-shot **真咬**：让 guard 走两次 attempt（第一次 `revise`）⇒ 事件仍只一条。
//      ⚠ 这一格必须**真的**触发两次 `callFinalGuard`：断言里同时钉「guard 被调 2 次」「两份载荷的
//      `attempt` 是 1 与 2」「两份载荷**都**带着盲区键（即第二次确实有资格再发一条）」——
//      只断言 `length === 1` 而结构上不可能有第二次 = 假绿（#862 第 ⑧ 格栽过，后补第 ⑩ 格）。
//   ⑤ 边界一：这条事件**只在配了 `finalGuard` 时**才可能发（`callFinalGuard` 的调用点有
//      `typeof finalGuard === "function"` 那道闸）；
//   ⑥ 边界二：「模型一个写都没声明」的 run 空集恒真、三个盲区键都不出现 ⇒ **静默通过**
//      （那是 #391 的另一半，本单不做，钉在这里防后来者误以为已全覆盖）；
//   ⑦ 纯度：`buildFinalGuardPayload` 是导出的**纯构造器**（测试与 `scripts/final-guard-probe.mjs`
//      直接当纯函数调）⇒ 它自己**不发**事件，副作用只住在 `callFinalGuard` 里。
//
// 刻意的写法：exec 走**真 shell**（「文件真在盘上」是磁盘事实），事件从 `capabilities.hooks.onEvent`
// 收，全部用 `config.*` / `capabilities.*` 规位拼写。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { buildFinalGuardPayload, createTerminationManager } from "../src/loop/termination.js";
import { EXEC_TOOL_NAME } from "../src/loop/exec-writes.js";
import { EVENT_TIER_FACT, eventTierOf } from "../src/loop/event-tiers.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { makeTmp } from "./helpers/tmp.js";

const BLIND_EVENT = "deliverable_blind";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** 真跑一遍命令：让「文件真的落到磁盘」成为磁盘事实，而不是测试自己替模型写的。 */
const shellTool = (cwd) => async (call) => {
  execFileSync("/bin/sh", ["-c", call.input.command], { cwd, stdio: "ignore" });
  return "ok";
};

/**
 * 跑一个 run，把 guard 的每一次 payload、全部事件与终局交回来。
 *
 * @param {object} options
 * @param {string[]} [options.commands] 每轮一条 exec 命令（自动补一条收尾正文轮）
 * @param {string} [options.cwd]
 * @param {string} [options.runId] 宿主侧标识：传了才该在事件里看到 `runId`
 * @param {boolean} [options.withGuard] 默认 true；false ⇒ 不配 `finalGuard`（边界⑤）
 * @param {(call:number)=>any} [options.guard] guard 裁决工厂（默认一律 accept）
 * @param {any[]} [options.script] 直接给脚本（给了就不再用 commands）
 */
async function runBlindRun(options) {
  const dir = options.cwd ?? await makeTmp("erix-deliverable-blind-");
  /** @type {any[]} */
  const payloads = [];
  /** @type {any[]} */
  const events = [];
  let guardCalls = 0;
  const decide = options.guard ?? (() => ({ action: "accept" }));
  const script = options.script ?? [
    ...options.commands.map((command, index) => toolUse(`x${index + 1}`, EXEC_TOOL_NAME, { command })),
    text("done"),
  ];
  const result = await runToolLoop({
    provider: createFakeProvider(script),
    store: createMemoryTranscriptStore(),
    executeTool: shellTool(dir),
    config: {
      input: { initialUserMessage: "write the files", cacheStablePrefix: false, wrapup: false },
      run: {
        cwd: dir,
        maxRounds: script.length + 3,
        completion: false,
        reflection: false,
        ...(options.runId ? { runId: options.runId } : {}),
      },
    },
    capabilities: {
      hooks: {
        // 不配 guard 那一格（边界⑤）就递 `undefined`：引擎侧的门就是 `typeof finalGuard === "function"`，
        // 而这一格把 hooks 写成直接字面量、不用展开（展开会让「选项面写点」清点器把它当成扁平搭台）。
        finalGuard: options.withGuard === false
          ? undefined
          : async (payload) => {
            guardCalls += 1;
            payloads.push(payload);
            return decide(guardCalls);
          },
        onEvent: (event) => events.push(event),
      },
    },
  });
  return {
    dir,
    payloads,
    events,
    guardCalls,
    blindEvents: events.filter((event) => event.type === BLIND_EVENT),
    result,
  };
}

/**
 * 直接驱动 `createTerminationManager` 用的最小终局上下文：盲区键齐、guard 一律 accept。
 * 它证明本单的 one-shot 不靠「只有一次调用所构造的伪一」：同一个 ctx 连调两次也能跑完 guard。
 */
function guardCtx(events, deliverableBlindEmitted) {
  return {
    finalText: "",
    declaredFindings: undefined,
    messages: [],
    rounds: 4,
    toolSignal: undefined,
    fileWrites: [],
    execWriteCount: 1,
    execWriteUnresolvedCount: 1,
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 1, failures: 0 }]]),
    finalGuard: async () => ({ action: "accept" }),
    finalGuardTimeout: 1000,
    awaitWithAbort: (promise) => promise,
    guardMetrics: {
      verified: 0, skipped: 0, revised: 0, unverified: 0, guard_error: 0,
      deliverables_checked: 0, deliverables_failed: 0,
    },
    deliverableBlindEmitted,
    emitEvent: (event) => events.push(event),
  };
}

// ── ① 盲区 run：恰好一条事件 + 载荷点名数字 ────────────────────────────────────────────
test("#881 ① 盲区 run ⇒ 恰好一条 deliverable_blind，载荷点名 execWriteCount / execWriteUnresolvedCount", async () => {
  const { dir, payloads, blindEvents, guardCalls, result } = await runBlindRun({
    commands: [
      "printf x > known.txt",
      'echo hi > "$OUT"',
      'echo hi > "$OTHER"',
    ],
  });
  // 先把现场钉住：1 条可解析 + 2 条解析不出 ⇒ 台账非空（粗旗闭）、细旗举。
  assert.equal(guardCalls, 1, "本格的 run 只问过 guard 一次");
  assert.equal(payloads[0].execWriteCount, 3, `三条命令都有写形态：${JSON.stringify(payloads[0].execWriteCount)}`);
  assert.equal(payloads[0].execWriteUnresolvedCount, 2, "两条未解析 ⇒ 计数面必须数到 2");
  assert.equal(payloads[0].fileWritesBlindToExec, true);
  assert.equal("fileWritesBlind" in payloads[0], false, "台账里有可解析的条目 ⇒ 粗旗闭");
  assert.equal(readFileSync(join(dir, "known.txt"), "utf8"), "x", "known.txt 真在盘上（磁盘事实）");

  assert.equal(blindEvents.length, 1, `盲区 run 必须恰好一条事件，实测 ${JSON.stringify(blindEvents)}`);
  assert.deepEqual(
    { ...blindEvents[0], round: 0 },
    { type: BLIND_EVENT, round: 0, execWriteCount: 3, execWriteUnresolvedCount: 2 },
    `载荷形状：数字键只写有值的，宿主没传 runId ⇒ 不许带 runId 键，实测 ${JSON.stringify(blindEvents[0])}`,
  );
  assert.equal("runId" in blindEvents[0], false, "引擎不自编标识（与 model_metadata_missing 同口径）");
});

test("#881 ①b 宿主传了 runId ⇒ 事件带同一个 runId；粗旗独立的 run 也发一条（不带计数键）", async () => {
  const withRunId = await runBlindRun({
    commands: ['echo hi > "$OUT"'],
    runId: "deliverable-blind-runid",
  });
  assert.equal(withRunId.blindEvents.length, 1);
  assert.equal(withRunId.blindEvents[0].runId, "deliverable-blind-runid");
  assert.equal(withRunId.blindEvents[0].execWriteCount, 1);
  assert.equal(withRunId.blindEvents[0].execWriteUnresolvedCount, 1);

  // 粗旗独立的形状：台账空 + 跑过 exec（这里是**只读**命令）⇒ 没有 exec 写形态计数，
  // 但「判不了」这件事照样要说出来，且**不写**那两个没有值的数字键。
  const readOnly = await runBlindRun({ commands: ["ls -la"], cwd: withRunId.dir });
  assert.equal(readOnly.payloads[0].fileWritesBlind, true, "台账空 + 跑过 exec ⇒ #386 的粗旗照举（既有语义）");
  assert.equal("execWriteCount" in readOnly.payloads[0], false);
  assert.equal(readOnly.blindEvents.length, 1, `粗旗也必须发一条，实测 ${JSON.stringify(readOnly.blindEvents)}`);
  assert.deepEqual(
    { ...readOnly.blindEvents[0], round: 0 },
    { type: BLIND_EVENT, round: 0 },
    "没有值的数字键不许写（绝不写 0 / undefined）",
  );
});

// ── ② 正常 run：零事件（不许把每个 run 刷成噪音）─────────────────────────────────────
test("#881 ② 正常 run ⇒ 零事件：只有写工具，以及 exec 目标全部解析出来", async () => {
  // (a) 只有写工具：台账非空、没跑过 exec ⇒ 三个盲区键都不成立。
  const writesOnly = await runBlindRun({
    script: [
      toolUse("w1", "writeFile", { path: "answer.txt", content: "42" }),
      text("done"),
    ],
  });
  assert.equal(writesOnly.guardCalls, 1, "(a) 本格必须问过 guard，否则零事件是空集恒真");
  // 写工具记的是**原值**路径（#388：`fileWrites` 可直接 `stat()` 的原值，引擎不替它绝对化），
  // 与 exec 那一族「引擎自己绝对化」不同口径 —— 本格只钉「台账非空」这件事。
  assert.deepEqual(writesOnly.payloads[0].fileWrites.map((entry) => entry.path), ["answer.txt"]);
  assert.equal(writesOnly.blindEvents.length, 0, `只有写工具的 run 不许发事件：${JSON.stringify(writesOnly.blindEvents)}`);

  // (b) exec 目标全部解析出来（heredoc / 重定向 / tee）⇒ 计数面 > 0 但未解析为 0 ⇒ 旗闭。
  const resolved = await runBlindRun({
    commands: ["cat > out.txt <<'EOF'\nbody\nEOF", "printf hello | tee out2.txt"],
  });
  assert.equal(resolved.payloads[0].execWriteCount, 2, "两条都算写形态（计数面不为 0）");
  assert.equal("execWriteUnresolvedCount" in resolved.payloads[0], false, "全部解析出来 ⇒ 未解析键缺席");
  assert.equal("fileWritesBlindToExec" in resolved.payloads[0], false);
  assert.equal("fileWritesBlind" in resolved.payloads[0], false);
  assert.equal(resolved.blindEvents.length, 0, `目标全解析的 run 不许发事件：${JSON.stringify(resolved.blindEvents)}`);
});

// ── ③ 设备丢弃：零事件 ───────────────────────────────────────────────────────────────
test("#881 ③ 设备丢弃（cat a > /dev/null）⇒ 既不计数也不举旗 ⇒ 零事件", async () => {
  const dir = await makeTmp("erix-deliverable-blind-devnull-");
  writeFileSync(join(dir, "a"), "seed\n");
  const { payloads, blindEvents } = await runBlindRun({
    cwd: dir,
    commands: ["printf x > real.txt", "cat a > /dev/null"],
  });
  assert.equal(payloads[0].execWriteCount, 1, `只有真写文件那条计数，设备丢弃不许计入：${payloads[0].execWriteCount}`);
  assert.equal("execWriteUnresolvedCount" in payloads[0], false, "设备丢弃不举盲区旗 ⇒ 未解析计数为 0");
  assert.equal("fileWritesBlindToExec" in payloads[0], false);
  assert.equal("fileWritesBlind" in payloads[0], false, "台账非空 ⇒ 粗旗也闭");
  assert.equal(blindEvents.length, 0, `写到设备是**看得见**的丢弃，不是判不了：${JSON.stringify(blindEvents)}`);
  assert.equal(readFileSync(join(dir, "real.txt"), "utf8"), "x");
});

// ── ④ one-shot 真咬：两次 callFinalGuard 仍只一条 ──────────────────────────────────
test("#881 ④ one-shot 真咬：guard 走两次 attempt（第一次 revise）⇒ 事件仍恰好一条", async () => {
  const { payloads, blindEvents, guardCalls, result } = await runBlindRun({
    // 第 1 轮 exec（盲区）→ 终局问 guard → revise → 模型补一发 → 再问 guard → accept。
    script: [
      toolUse("x1", EXEC_TOOL_NAME, { command: 'echo hi > "$OUT"' }),
      text("first final"),
      text("second final"),
    ],
    guard: (call) => (call === 1
      ? { action: "revise", message: "请先核实交付物" }
      : { action: "accept" }),
  });

  // 结构前提：真的调了**两次** `callFinalGuard`（不是「只有一次所以旗没用上」）。
  assert.equal(guardCalls, 2, "两次 attempt 的前提没成立 ⇒ 这一格会退化成假绿");
  assert.deepEqual(payloads.map((payload) => payload.attempt), [1, 2], "两份载荷必须是 attempt 1 与 2");
  // 关键反证：**第二次**那份载荷照样带着盲区键 ⇒ 它确实有资格再发一条，只是被旗标挡住了。
  for (const [index, payload] of payloads.entries()) {
    assert.equal(payload.execWriteUnresolvedCount, 1, `第 ${index + 1} 份载荷的盲区键必须成立（否则 one-shot 没被咬）`);
    assert.equal(payload.fileWritesBlindToExec, true, `第 ${index + 1} 份载荷的细旗必须成立`);
  }
  assert.equal(blindEvents.length, 1, `两次 guard ⇒ 事件仍必须恰好一条，实测 ${JSON.stringify(blindEvents)}`);
  assert.equal(result.verification.status, "verified", "补做之后仍按既有语义验收（本单不改裁决）");

  // 反证（旗标真的在那儿）：同一个 ctx 直接连调两次 `callFinalGuard` —— 旗标初值 false ⇒ 1 条，
  // 旗标初值 true ⇒ 0 条（后者证明那一格不是「旗标恒 false 、判据恒真」的摆设）。
  /** @type {any[]} */
  const eventsA = [];
  const managerA = createTerminationManager(guardCtx(eventsA, false));
  await managerA.callFinalGuard("end_turn", undefined);
  await managerA.callFinalGuard("end_turn", undefined);
  assert.equal(eventsA.filter((event) => event.type === BLIND_EVENT).length, 1,
    "同一 ctx 连调两次 callFinalGuard ⇒ 有旗标就是 1 条");
  assert.equal(eventsA.filter((event) => event.type === "final_guard").length, 2,
    "两次调用都真走完了 guard（否则上面那条 1 条只是根本没跑到第二次）");
  /** @type {any[]} */
  const eventsB = [];
  const managerB = createTerminationManager(guardCtx(eventsB, true));
  await managerB.callFinalGuard("end_turn", undefined);
  assert.equal(eventsB.filter((event) => event.type === BLIND_EVENT).length, 0,
    "旗标已为真 ⇒ 一条也不许再发（旗子真的在读写，不是恒 false 的摆设）");
  assert.equal(managerB && eventsB.length > 0, true, "第二次确实跑到了 guard 与其余事件面");
});

// ── ⑤⑥ 两条边界 ───────────────────────────────────────────────────────────────────
test("#881 ⑤ 没配 finalGuard ⇒ 盲区 run 也零事件（这条事件只挂在 guard 上）", async () => {
  const { guardCalls, blindEvents, result } = await runBlindRun({
    commands: ['echo hi > "$OUT"'],
    withGuard: false,
  });
  assert.equal(guardCalls, 0);
  assert.equal(result.verification.reason, "no_final_guard");
  assert.equal(blindEvents.length, 0, "交付物判据本来就挂在 guard 上：没配 guard 就没有「判不了」这回事");
});

test("#881 ⑥ 一个写都没声明的 run ⇒ 静默通过（#391 的另一半，本单不做）", async () => {
  const dir = await makeTmp("erix-deliverable-blind-nowrite-");
  writeFileSync(join(dir, "seed"), "seed\n");
  const { payloads, blindEvents } = await runBlindRun({ cwd: dir, commands: ["ls -la"] });
  assert.deepEqual(payloads[0].fileWrites, [], "空台账");
  assert.equal(payloads[0].fileWritesBlind, true,
    "跑过 exec 且台账空 ⇒ 粗旗按 #386 举 ⇒ 事件发一条（本格钉的是**没有 exec** 的那一半）");
  assert.equal(blindEvents.length, 1);

  // 真的一个写都没有、也没跑过 exec：三个盲区键都不出现 ⇒ 事件为零，判据空集恒真、静默通过。
  const noExec = await runBlindRun({ cwd: dir, script: [text("done")] });
  for (const key of ["fileWritesBlind", "fileWritesBlindToExec", "execWriteUnresolvedCount"]) {
    assert.equal(key in noExec.payloads[0], false, `键 ${key} 不该出现：${JSON.stringify(noExec.payloads[0])}`);
  }
  assert.equal(noExec.blindEvents.length, 0,
    "「一个写都没声明」仍是静默通过 —— 那是 #391 的另一半，本单明确不做");
});

// ── ⑦ 纯度与分级 ───────────────────────────────────────────────────────────────────
test("#881 ⑦ buildFinalGuardPayload 仍是纯构造器（探针口径），事件档位是 fact", () => {
  /** @type {any[]} */
  const emitted = [];
  const ctx = {
    finalText: "", messages: [], rounds: 3, toolSignal: undefined,
    fileWrites: [], execWriteCount: 2, execWriteUnresolvedCount: 2,
    toolStats: new Map([[EXEC_TOOL_NAME, { calls: 2, failures: 0 }]]),
    emitEvent: (event) => emitted.push(event),
    deliverableBlindEmitted: false,
  };
  const payload = buildFinalGuardPayload(ctx, "end_turn", undefined, 1);
  assert.equal(payload.execWriteUnresolvedCount, 2, "盲区键仍在载荷里（本单没动它）");
  assert.equal(payload.fileWritesBlindToExec, true);
  assert.deepEqual(emitted, [], "纯构造器不许有副作用：探针直接调它，不该收到事件");
  assert.equal(ctx.deliverableBlindEmitted, false, "纯构造器也不许碰旗标");
  assert.equal(eventTierOf(BLIND_EVENT), EVENT_TIER_FACT,
    "三个计数只在 payload 里、随内存消失 ⇒ 事件是这条事实唯一的 durable 副本");
});
