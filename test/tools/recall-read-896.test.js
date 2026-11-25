// @ts-check
// issue #896 C1 判据（验收返工版）：确定性召回工具 recall_read。
// 全部走真引擎真折叠（内置 sliding-window 策略），不手搓 foldedPayload。
import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinRecallTools, createRecallAccessor } from "../../src/tools/recall.js";
import { estimateTokens } from "../../src/tokens.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { reconstructRoundsFromBoundary } from "../../src/messages/rounds.js";

// ─── 夹具：内置 sliding-window 跑一次真折叠，单次覆盖 round 1..11 ──────────────

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

/** 去掉 store 落盘给行消息加的回执字段 `ts`（持久化簿记，不是消息内容）。 */
function stripTs(messages) {
  return messages.map((message) => {
    const { ts: _drop, ...rest } = message;
    return rest;
  });
}

/**
 * 跑一次真折叠，返回 { store, runId, fold, originalFromRecords }。
 * originalFromRecords(N) 按引擎口径（assistant tool_use + 紧随的 tool_result 配对）从 store
 * 的行记录里取 round N 的**原文**——不是测试自己写的常量。
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
      input: { cacheStablePrefix: false },
      folding: { context: { budgetTokens: 3000, keepRounds: 1, maxFoldedPayloadBytes: 5_000_000 } },
    },
    capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
  });

  const records = await store.load(runId);
  const fold = records.find((r) => r.folded && r.foldedRoundRange && Array.isArray(r.foldedPayload) && r.foldedPayload.length > 0);
  const allMessages = records.flatMap((r) => (Array.isArray(r.messages) ? r.messages : []));

  /** 按引擎轮规则从 records 行里取 round N 的原文（assistant 带 tu_N 的那条 + 紧随的 tool_result）。 */
  const originalFromRecords = (n) => {
    for (let i = 0; i < allMessages.length; i += 1) {
      const m = allMessages[i];
      if (m?.role === "assistant"
        && Array.isArray(m.content)
        && m.content.some((b) => b?.type === "tool_use" && b.id === `tu_${n}`)) {
        return stripTs([m, allMessages[i + 1]]);
      }
    }
    return null;
  };

  return { store, runId, fold, originalFromRecords };
}

// ─── 格 1：逐字取回（核心判据）——真折叠 + 原文取自 records ────────────────────

test("#896-1 逐字取回（真折叠）：recall_read 取回的正文与 records 里的原文逐字相等", async () => {
  const { store, runId, fold, originalFromRecords } = await buildRealFold();
  assert.ok(fold, "必须有一次真折叠");
  assert.ok(fold.foldedFacts?.foldId, "真折叠记录必须带 foldId");

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: createRecallAccessor(store, runId) });
  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));

  assert.equal(result.status, "found");
  assert.equal(result.trust, "verified");
  // 核心：取回的 round 3 消息与 records 里的原文逐字相等（去 store 簿记 ts）
  assert.deepEqual(result.messages, originalFromRecords(3));
  // 逐字相等不是空对空：正文含 round 3 的判别内容，且不含相邻轮
  assert.ok(result.content.includes("MARKER_R3_"), `正文须含 round 3 原文，实测头：${result.content.slice(0, 40)}`);
  assert.ok(!result.content.includes("MARKER_R2_") && !result.content.includes("MARKER_R4_"), "只能是该轮，不得串轮");
  // 可复核坐标
  assert.equal(result.round, 3);
  assert.deepEqual(result.foldRoundRange, { from: 1, to: 11 });
  assert.equal(typeof result.payloadIndex, "number");
  assert.ok(result.byteLength > 0);
  assert.equal(result.foldId, fold.foldedFacts.foldId);
});

// ─── 格 2：多轮——一次折 ≥5 轮，逐轮各取一次，证明 round-from 下标映射 ─────────

test("#896-2 多轮真折叠（≥5 轮）：逐轮各取一次，每轮都与 records 原文逐字相等", async () => {
  const { store, runId, fold, originalFromRecords } = await buildRealFold();
  const span = fold.foldedRoundRange.to - fold.foldedRoundRange.from + 1;
  assert.ok(span >= 5, `这一格要测多轮，实测单次折叠仅 ${span} 轮`);

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: createRecallAccessor(store, runId) });
  const checked = [];
  for (let n = fold.foldedRoundRange.from; n <= fold.foldedRoundRange.to; n += 1) {
    const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: n } }));
    assert.equal(r.status, "found", `round ${n} 应 found，实测 ${r.status}`);
    // 逐字相等（原文取自 records）
    assert.deepEqual(r.messages, originalFromRecords(n), `round ${n} 逐字相等`);
    // 下标映射对：是该轮判别子，不是相邻轮
    assert.ok(r.content.includes(`MARKER_R${n}_`), `round ${n} 正文须含 MARKER_R${n}`);
    if (n > 1) assert.ok(!r.content.includes(`MARKER_R${n - 1}_`), `round ${n} 不得含上一轮`);
    assert.ok(!r.content.includes(`MARKER_R${n + 1}_`), `round ${n} 不得含下一轮`);
    checked.push(n);
  }
  assert.ok(checked.length >= 5, `实际逐轮核对 ${checked.length} 轮`);
});

// ─── 格 3：真实形态 payload（user 多为 tool_result）下切分成功——旧实现下红 ──────

test("#896-3 真实形态 payload（user 多为 tool_result）：切分用引擎轮规则、非真实用户消息", async () => {
  const { store, runId, fold } = await buildRealFold();
  const expected = fold.foldedRoundRange.to - fold.foldedRoundRange.from + 1;
  // 真实形态证明：payload 里的 user 消息绝大多数是 tool_result-only（不是「真实用户消息」）
  const userMsgs = fold.foldedPayload.filter((m) => m?.role === "user");
  const toolResultOnly = userMsgs.filter((m) => Array.isArray(m?.content) && m.content.length > 0
    && m.content.every((b) => b?.type === "tool_result"));
  assert.ok(userMsgs.length > 0 && toolResultOnly.length >= userMsgs.length - 1,
    "真实折叠里 user 轮应几乎都是 tool_result（若按真实用户消息切分会塌成一两组）");

  // 用引擎规则还原，轮数必须等于 to-from+1（旧实现按真实用户消息切分会远小于此）
  assert.equal(reconstructRoundsFromBoundary(fold.foldedPayload).length, expected,
    "引擎轮规则还原的轮数必须等于轮区间");

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: createRecallAccessor(store, runId) });
  // 取中间某轮（非 from）：旧实现会因切组错误而取不到/取错
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 5 } }));
  assert.equal(r.status, "found");
  assert.ok(r.content.includes("MARKER_R5_"), "round 5 必须取回其 tool_use/tool_result 原文");
});

// ─── 格 4：unmappable——轮数与区间对不上时报两个数、不给正文 ───────────────────

test("#896-4 unmappable：还原轮数与 to-from+1 对不上时返回 unmappable 并报两个数", async () => {
  const { store, runId } = await buildRealFold();
  const base = await createRecallAccessor(store, runId)();
  const real = base[0];
  // 模拟有界去重差分归档：区间声称 1..10，但 payload 只够还原出更少的轮
  const dedupLike = real.payload.slice(0, 4); // 2 轮
  const folds = [{ from: 1, to: 10, foldId: undefined, payload: dedupLike }];

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: () => folds });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 7 } }));

  assert.equal(r.status, "unmappable");
  assert.equal(r.reconstructedRounds, reconstructRoundsFromBoundary(dedupLike).length);
  assert.equal(r.expectedRounds, 10);
  assert.equal(r.content, null, "unmappable 不给正文");
  assert.equal(r.messages, null, "unmappable 不给消息");
});

// ─── 格 5：stale——foldId 被篡改，不给正文 ─────────────────────────────────────

test("#896-5 stale：foldId 被篡改时返回 stale 且正文为空", async () => {
  const { store, runId } = await buildRealFold();
  const base = await createRecallAccessor(store, runId)();
  const tampered = base.map((f) => ({ ...f, foldId: "sha256:TAMPERED_DOES_NOT_MATCH_000000" }));

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: () => tampered });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));

  assert.equal(r.status, "stale");
  assert.equal(r.content, null);
  assert.equal(r.messages, null);
  assert.ok(r.message.includes("不一致"));
});

// ─── 格 6：untrusted——没有 foldId，仍给正文但标注 ─────────────────────────────

test("#896-6 untrusted：没有 foldId 时仍给正文但带 untrusted 标记", async () => {
  const { store, runId } = await buildRealFold();
  const base = await createRecallAccessor(store, runId)();
  const noId = base.map((f) => ({ ...f, foldId: undefined }));

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: () => noId });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 3 } }));

  assert.equal(r.status, "found");
  assert.equal(r.trust, "untrusted");
  assert.ok(typeof r.content === "string" && r.content.includes("MARKER_R3_"));
});

// ─── 格 7：not_folded——没被折叠的轮号，明确不在归档内、不给正文 ────────────────

test("#896-7 not_folded：没被折叠的轮号不给任何正文", async () => {
  const { store, runId } = await buildRealFold();
  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: createRecallAccessor(store, runId) });
  const r = JSON.parse(await executeTool({ name: "recall_read", input: { round: 999 } }));

  assert.equal(r.status, "not_folded");
  assert.ok(r.message.includes("不在归档内"));
  assert.equal(r.content, undefined);
  assert.equal(r.messages, undefined);
});

// ─── 格 8：账本零新增——recall_read 不改任何轮记录键集 ─────────────────────────

test("#896-8 账本零新增：跑完后轮记录键集与改动前逐字相同", async () => {
  const { store, runId } = await buildRealFold();
  const before = await store.load(runId);
  const foldBefore = before.find((r) => r.folded && r.foldedRoundRange);
  const keysBefore = Object.keys(foldBefore).sort();

  const accessor = createRecallAccessor(store, runId);
  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });
  await executeTool({ name: "recall_read", input: { round: 3 } });
  await executeTool({ name: "recall_read", input: { round: 999 } });

  const after = await store.load(runId);
  const foldAfter = after.find((r) => r.folded && r.foldedRoundRange);
  assert.deepEqual(Object.keys(foldAfter).sort(), keysBefore);
});

// ─── 工具定义 token 成本实测 ──────────────────────────────────────────────────

test("#896-token 实测 recall_read 工具定义的 token 成本", () => {
  const { definitions } = createBuiltinRecallTools({ readFoldedRounds: () => [] });
  const toolDef = definitions[0];
  const serialized = toolDef.name + toolDef.description + JSON.stringify(toolDef.inputSchema);
  const tokenCost = estimateTokens(serialized);
  console.log(`[recall_read token cost] ${tokenCost}`);
  console.log(`[total with 11 builtin tools] ${4714 + tokenCost}`);
  assert.ok(tokenCost > 0);
});
