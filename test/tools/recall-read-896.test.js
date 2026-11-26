// @ts-check
// issue #896 C1 判据（账本直读版）：确定性召回工具 recall_read。
// 数据源是账本 store.load(runId) 的行（不是有界去重的折叠快照 foldedPayload）。
// 全部走真引擎真折叠（内置 sliding-window 策略），不手搓行。
import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinRecallTools } from "../../src/tools/recall.js";
import { isMessageRow } from "../../src/store/message-rows.js";
import { estimateTokens } from "../../src/tokens.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { reconstructRoundsFromBoundary } from "../../src/messages/rounds.js";

// ─── 夹具：内置 sliding-window 跑一次真折叠，单次覆盖 round 1..11 ──────────────
// maxFoldedPayloadBytes 刻意压小 ⇒ foldedPayload 被有界截断、明显小于轮数（复现
// station-719 那类「payload ≪ 轮数」的有界去重差分归档）；但账本每轮正文完整。

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

/** 每轮：assistant 发一个 tool_use(id=tu_N, input.text=MARKER_RN...)，工具回 ECHO:MARKER_RN...。
 *  前 10 轮极小、第 11 轮巨大 ⇒ target 折叠为回落到预算下，一次折掉 round 1..11。 */
function makeProvider(sizes) {
  let t = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (t < sizes.length) {
        t += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${t}`, name: "echo", input: { text: `MARKER_R${t}_` + "x".repeat(sizes[t - 1]) } }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "FINAL" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

/**
 * 跑一次真折叠，返回 { store, runId, fold, rows, ledgerMessagesFor }。
 * rows = store.load(runId) 的账本行；ledgerMessagesFor(N) 按「账本直读」口径独立地从
 * rows 里取第 N 轮的正文（口径①消息行按 seq 拼接、口径②载体行直接取 messages）——
 * 这是判据自己的口径，不依赖 recall.js 的实现。
 */
async function buildRealFold() {
  const runId = "recall-896-real";
  const store = createMemoryTranscriptStore();
  const sizes = [60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 20000];

  await runDirect({
    seed: "开始任务 TASKBRIEF",
    provider: makeProvider(sizes),
    store,
    runId,
    tools: TOOLS,
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    completion: false,
    config: {
      run: { maxRounds: 40 },
      input: {},
      folding: { context: { budgetTokens: 3000, keepRounds: 1, maxFoldedPayloadBytes: 200 } },
    },
    capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
  });

  const rows = await store.load(runId);
  const fold = rows.find((r) => r.folded && r.foldedRoundRange && Array.isArray(r.foldedPayload) && r.foldedPayload.length > 0);

  const ledgerMessagesFor = (n) => {
    const msgRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => isMessageRow(row) && row.round === n && Array.isArray(row.messages))
      .sort((a, b) => (a.row.seq - b.row.seq) || (a.index - b.index))
      .flatMap(({ row }) => row.messages);
    const carriers = rows
      .filter((row) => !isMessageRow(row) && row.round === n && Array.isArray(row.messages))
      .flatMap((row) => row.messages);
    return [...msgRows, ...carriers];
  };

  return { store, runId, fold, rows, ledgerMessagesFor };
}

// ─── 格 1：逐字取回（核心判据）——真折叠、被折轮、账本直读、逐字相等 ───────────

test("#896-1 逐字取回（真折叠被折轮）：recall_read 取回的正文与账本里该轮原文逐字相等", async () => {
  const { store, runId, fold, ledgerMessagesFor } = await buildRealFold();
  assert.ok(fold, "必须有一次真折叠");

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));

  assert.equal(result.status, "found");
  // 核心：取回的 round 3 消息与账本里该轮原文逐字相等（deepEqual 整段，不截断、不改写）
  assert.deepEqual(result.messages, ledgerMessagesFor(3));
  // 不是空对空：正文含 round 3 的判别内容，且不含相邻轮
  const joined = JSON.stringify(result.messages);
  assert.ok(joined.includes("MARKER_R3_"), `正文须含 round 3 原文，实测头：${joined.slice(0, 60)}`);
  assert.ok(!joined.includes("MARKER_R2_") && !joined.includes("MARKER_R4_"), "只能是该轮，不得串轮");
  // 可复核坐标：轮号 / 消息条数 / 字节数
  assert.equal(result.round, 3);
  assert.equal(result.messageCount, result.messages.length);
  assert.ok(result.byteLength > 0 && result.byteLength === Buffer.byteLength(JSON.stringify(result.messages), "utf8"));
});

// ─── 格 2：多轮——一次折 ≥5 轮，逐轮各取一次，逐字相等 ─────────────────────────

test("#896-2 多轮真折叠（≥5 轮）：逐轮各取一次，每轮都与账本原文逐字相等", async () => {
  const { store, runId, fold, ledgerMessagesFor } = await buildRealFold();
  const span = fold.foldedRoundRange.to - fold.foldedRoundRange.from + 1;
  assert.ok(span >= 5, `这一格要测多轮，实测单次折叠仅 ${span} 轮`);

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  for (let n = fold.foldedRoundRange.from; n <= fold.foldedRoundRange.to; n += 1) {
    const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: n } }));
    assert.equal(r.status, "found", `round ${n} 应 found，实测 ${r.status}`);
    assert.deepEqual(r.messages, ledgerMessagesFor(n), `round ${n} 逐字相等`);
    assert.ok(JSON.stringify(r.messages).includes(`MARKER_R${n}_`), `round ${n} 正文须含自身判别内容`);
  }
});

// ─── 格 3（关键）：真折叠 foldedPayload 明显小于轮数 ⇒ 被折轮仍逐字取回 ─────────
// 旧实现读 foldedPayload：payload 被有界截断 ⇒ 还原轮数 ≠ to-from+1 ⇒ unmappable、取不到；
// 账本直读：每轮正文完整 ⇒ 逐字取回。这一格钉死数据源换对了。

test("#896-3 关键：foldedPayload ≪ 轮数时，被折轮仍从账本逐字取回（旧实现在此红）", async () => {
  const { store, runId, fold, ledgerMessagesFor } = await buildRealFold();
  const expected = fold.foldedRoundRange.to - fold.foldedRoundRange.from + 1;
  const payloadMsgs = fold.foldedPayload.length;
  const reconstructed = reconstructRoundsFromBoundary(fold.foldedPayload).length;

  // 前提：payload 明显小于轮数，且按 payload 还原不出轮（⇒ 读 payload 的旧实现会 unmappable）
  assert.ok(payloadMsgs < expected, `payload(${payloadMsgs}) 必须明显小于轮数(${expected})`);
  assert.notEqual(reconstructed, expected, "按 foldedPayload 还原的轮数 ≠ 期望轮数（旧实现据此报 unmappable）");

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 6 } }));

  // 账本直读照样取回完整该轮，且逐字相等
  assert.equal(r.status, "found");
  assert.deepEqual(r.messages, ledgerMessagesFor(6));
  // 取回的是完整的 2 条该轮消息（而非被截断到 1 条的 payload）——旧实现给不出
  assert.equal(r.messageCount, 2, "取回必须是完整该轮正文，不是被有界截断的 payload");
  assert.ok(JSON.stringify(r.messages).includes("MARKER_R6_"));
});

// ─── 格 4（新）：账本里有、但不在任何折叠区间的轮 ⇒ 照样取回 ───────────────────
// 语义：recall_read 读的是账本，不限于已折轮次。

test("#896-4 未折叠轮（在账本、不在折叠区间）照样取回", async () => {
  const { store, runId, fold, ledgerMessagesFor } = await buildRealFold();
  const { from, to } = fold.foldedRoundRange;
  // 找一个 ≥1、在账本里有正文、却不在折叠区间 [from,to] 的轮
  let target = null;
  for (const row of (await store.load(runId))) {
    if (Number.isSafeInteger(row.round) && row.round >= 1 && Array.isArray(row.messages) && row.messages.length > 0
      && (row.round < from || row.round > to)) { target = row.round; break; }
  }
  assert.ok(target !== null, "必须存在一个在账本里、不在折叠区间内的轮");

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: target } }));

  assert.equal(r.status, "found", `未折轮 ${target} 也应取回（读账本，不限于已折轮次）`);
  assert.deepEqual(r.messages, ledgerMessagesFor(target));
});

// ─── 格 5：无校验字段——取回结果不含 trust / foldId 比对结论 ────────────────────

test("#896-5 无校验字段：found 返回里不含 trust / foldId 比对结论", async () => {
  const { store, runId } = await buildRealFold();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));

  assert.equal(r.status, "found");
  assert.ok(Array.isArray(r.messages) && r.messages.length > 0, "仍给正文");
  assert.ok(!("trust" in r), "返回不得含 trust 字段");
  assert.ok(!("foldId" in r), "返回不得含 foldId 比对结论");
});

// ─── 格 7：not_folded——账本里没有该轮正文，明确不给正文 ────────────────────────

test("#896-7 not_folded：账本没有该轮 ⇒ 不给任何正文、话术是「账本里没有」", async () => {
  const { store, runId } = await buildRealFold();
  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 999 } }));

  assert.equal(r.status, "not_folded");
  assert.ok(r.message.includes("账本里没有"), `话术须说「账本里没有」，实测：${r.message}`);
  assert.ok(!r.message.includes("未被折叠"), "不得再说「未被折叠」（读的是账本不是折叠快照）");
  assert.equal(r.messages, undefined);
  assert.equal(r.content, undefined);
});

// ─── 格 8：账本零新增——recall_read 不改任何轮记录键集 ─────────────────────────

test("#896-8 账本零新增：跑完后轮记录键集与改动前逐字相同", async () => {
  const { store, runId } = await buildRealFold();
  const before = await store.load(runId);
  const keysBefore = before.map((r) => Object.keys(r).sort());

  const { executeTool } = createBuiltinRecallTools({ readLedgerRows: () => store.load(runId) });
  await executeTool({ name: "recall_read", input: { round: 3 } });
  await executeTool({ name: "recall_read", input: { round: 12 } });
  await executeTool({ name: "recall_read", input: { round: 999 } });

  const after = await store.load(runId);
  assert.deepEqual(after.map((r) => Object.keys(r).sort()), keysBefore);
});

// ─── 工具定义 token 成本实测 ──────────────────────────────────────────────────

test("#896-token 实测 recall_read 工具定义的 token 成本", () => {
  const { definitions } = createBuiltinRecallTools({ readLedgerRows: () => [] });
  const toolDef = definitions[0];
  const serialized = toolDef.name + toolDef.description + JSON.stringify(toolDef.inputSchema);
  const tokenCost = estimateTokens(serialized);
  console.log(`[recall_read token cost] ${tokenCost}`);
  console.log(`[total with 11 builtin tools] ${4714 + tokenCost}`);
  assert.ok(tokenCost > 0);
});
