import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinRecallTools, createRecallAccessor } from "../../src/tools/recall.js";
import { estimateTokens } from "../../src/tokens.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { runDirect } from "../helpers/run-direct.js";

// ─── 夹具：用真实 orchestrator 跑一次折叠，store 里落一份真实轮记录 ───────────

const USER_TEXT_ROUND1 = "这是一条需要被折叠的真实用户消息内容：alpha-bravo-charlie-42";

/**
 * 跑一次真实折叠：自定义策略在 round 1 折掉用户消息，
 * onRound 把含折叠字段的轮记录 append 到 store。
 */
async function buildEnv() {
  const runId = "recall-896-run";
  const store = createMemoryTranscriptStore();

  // 策略：第一次调用折掉第 1 轮（payload 含原文消息）
  let compactCall = 0;
  const strategy = {
    name: "test-fold",
    shouldCompact() { return compactCall++ === 0; },
    async compact() {
      const foldedPayload = [
        { role: "user", content: [{ type: "text", text: USER_TEXT_ROUND1 }] },
      ];
      return {
        messages: [{ role: "user", content: [{ type: "text", text: "folded context" }] }],
        compacted: true,
        foldedRounds: 1,
        tokensBefore: 9999,
        tokensAfter: 100,
        foldedPayload,
        foldedRoundRange: { from: 1, to: 1 },
      };
    },
  };

  // 收集带折叠字段的轮记录，写入 store
  /** @type {Array<object>} */
  const collectedRecords = [];
  const onRound = (record) => {
    if (record.folded === true && Array.isArray(record.foldedPayload) && record.foldedPayload.length > 0) {
      collectedRecords.push(structuredClone(record));
    }
  };

  await runDirect({
    seed: USER_TEXT_ROUND1,
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]),
    store,
    runId,
    executeTool: async () => "ok",
    completion: false,
    onRound,
    config: {
      run: { maxRounds: 2 },
      input: { cacheStablePrefix: false },
      folding: { context: { budgetTokens: 99, keepRounds: 0, maxFoldedPayloadBytes: 1_000_000 } },
    },
    capabilities: { ports: { strategy } },
  });

  // 把收集到的带折叠字段的轮记录写入 store
  for (const rec of collectedRecords) {
    await store.appendRound(runId, rec);
  }

  const foldRecord = collectedRecords[0];

  return {
    store,
    runId,
    foldRecord,
    originalText: USER_TEXT_ROUND1,
    foldedRound: foldRecord?.foldedRoundRange?.from ?? 1,
  };
}

/**
 * 从 env 里建 readFoldedRounds 访问器。
 */
function makeAccessor(env) {
  return async () => {
    const records = await env.store.load(env.runId);
    /** @type {Array<{from: number, to: number, foldId: string|undefined, payload: object[]}>} */
    const folds = [];
    for (const record of records) {
      if (record.folded && Array.isArray(record.foldedPayload) && record.foldedPayload.length > 0) {
        folds.push({
          from: record.foldedRoundRange?.from ?? 1,
          to: record.foldedRoundRange?.to ?? 1,
          foldId: record.foldedFacts?.foldId ?? undefined,
          payload: record.foldedPayload,
        });
      }
    }
    return folds;
  };
}

// ─── 格 1：逐字取回（核心判据）───────────────────────────────────────────────

test("#896-1 逐字取回：recall_read 取回的正文与原文逐字相等", async () => {
  const env = await buildEnv();
  assert.ok(env.foldRecord, "必须有一条带折叠数据的轮记录");
  assert.ok(env.foldRecord.foldedFacts?.foldId, "轮记录必须有 foldId");

  const accessor = makeAccessor(env);
  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });

  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: env.foldedRound } }));

  assert.equal(result.status, "found");
  assert.equal(result.trust, "verified");
  // 核心：逐字相等
  assert.equal(result.content, env.originalText);
  // 可复核坐标
  assert.equal(result.round, env.foldedRound);
  assert.equal(typeof result.payloadIndex, "number");
  assert.equal(typeof result.byteLength, "number");
  assert.ok(result.byteLength > 0);
  assert.equal(result.foldId, env.foldRecord.foldedFacts.foldId);
});

// ─── 格 2：找不到就明说 ──────────────────────────────────────────────────────

test("#896-2 不在归档内：没被折叠的轮号不给正文", async () => {
  const env = await buildEnv();
  const accessor = makeAccessor(env);
  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });

  // 请求一个超出折叠范围的轮号
  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: 999 } }));

  assert.equal(result.status, "not_folded");
  assert.ok(result.message.includes("不在归档内"));
  // 不给任何正文
  assert.equal(result.content, undefined);
});

// ─── 格 3：stale 不给正文 ────────────────────────────────────────────────────

test("#896-3 stale：foldId 被篡改时返回 stale 且正文为空", async () => {
  const env = await buildEnv();
  assert.ok(env.foldRecord?.foldedFacts?.foldId);

  // 篡改 store 里记录的 foldId（模拟归档被改写）
  const originalFoldId = env.foldRecord.foldedFacts.foldId;
  const tamperedId = "sha256:TAMPERED_NOT_MATCHING_" + originalFoldId.slice(24);

  // 用篡改后的访问器
  const accessor = async () => {
    const records = await env.store.load(env.runId);
    const folds = [];
    for (const record of records) {
      if (record.folded && Array.isArray(record.foldedPayload) && record.foldedPayload.length > 0) {
        folds.push({
          from: record.foldedRoundRange?.from ?? 1,
          to: record.foldedRoundRange?.to ?? 1,
          foldId: tamperedId,
          payload: record.foldedPayload,
        });
      }
    }
    return folds;
  };

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });
  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: env.foldedRound } }));

  assert.equal(result.status, "stale");
  assert.equal(result.content, null);
  assert.ok(result.message.includes("不一致"));
});

// ─── 格 4：untrusted 标注 ────────────────────────────────────────────────────

test("#896-4 untrusted：没有 foldId 时仍给正文但带 untrusted 标记", async () => {
  const env = await buildEnv();

  // 无 foldId 的访问器
  const accessor = async () => {
    const records = await env.store.load(env.runId);
    const folds = [];
    for (const record of records) {
      if (record.folded && Array.isArray(record.foldedPayload) && record.foldedPayload.length > 0) {
        folds.push({
          from: record.foldedRoundRange?.from ?? 1,
          to: record.foldedRoundRange?.to ?? 1,
          foldId: undefined,
          payload: record.foldedPayload,
        });
      }
    }
    return folds;
  };

  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });
  const result = JSON.parse(await executeTool({ name: "recall_read", input: { round: env.foldedRound } }));

  assert.equal(result.status, "found");
  assert.equal(result.trust, "untrusted");
  // 仍给正文
  assert.ok(typeof result.content === "string" && result.content.length > 0);
});

// ─── 格 5：账本零新增 ────────────────────────────────────────────────────────

test("#896-5 账本零新增：跑完后轮记录键集与改动前逐字相同", async () => {
  const env = await buildEnv();

  // 取 store 里折叠记录的键集（调用前）
  const recordsBefore = await env.store.load(env.runId);
  const foldRecordBefore = recordsBefore.find((r) => r.folded === true && Array.isArray(r.foldedPayload) && r.foldedPayload.length > 0);
  assert.ok(foldRecordBefore, "必须能找到带折叠数据的记录");
  const keysBefore = Object.keys(foldRecordBefore).sort();

  // 跑 recall_read 不应改变任何记录
  const accessor = makeAccessor(env);
  const { executeTool } = createBuiltinRecallTools({ readFoldedRounds: accessor });
  await executeTool({ name: "recall_read", input: { round: env.foldedRound } });

  // 重新读 store，取同一条记录
  const recordsAfter = await env.store.load(env.runId);
  const foldRecordAfter = recordsAfter.find((r) => r.folded === true && Array.isArray(r.foldedPayload) && r.foldedPayload.length > 0);

  const keysAfter = Object.keys(foldRecordAfter).sort();
  assert.deepEqual(keysAfter, keysBefore);
});

// ─── 工具定义 token 成本实测 ──────────────────────────────────────────────────

test("#896-token 实测 recall_read 工具定义的 token 成本", () => {
  const { definitions } = createBuiltinRecallTools({ readFoldedRounds: () => [] });
  const toolDef = definitions[0];
  const serialized = toolDef.name + toolDef.description + JSON.stringify(toolDef.inputSchema);
  const tokenCost = estimateTokens(serialized);
  // 输出实测值，供终稿使用
  console.log(`[recall_read token cost] ${tokenCost}`);
  console.log(`[total with 11 builtin tools] ${4714 + tokenCost}`);
  assert.ok(tokenCost > 0, "token 成本必须 > 0");
});
