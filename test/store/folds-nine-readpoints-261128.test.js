// @ts-check
// issue 261128-12（切片 3）：九列落地之后，**四个读点一行都不用改**——这一格把「不用改」变成判据。
//
// 切片 2 的设计是「持久化 = 九列，引擎边界 = 旧形状（由九列导出）」。所以真正要证明的不是「读点
// 能编译」，而是**同一次折叠，无论账本来自旧形状还是九列重建，渲染出来的块逐字相同**。
// 只要这一条成立，四个读点（`recall-runner` 的 `fold.text`、`resume-fold-trim` 的 `fact.text`、
// `fold-statistical` 的 `foldRecordSegments`、`onFoldSummary` 的载荷）就没有理由改。
//
// 数据一律来自 `buildFoldedFacts()` 的真实产出（手搓形状只会钉住想象），且**两折**——单折走不到
// 「累计拼接」和「分段渲染」这两条路。

import test from "node:test";
import assert from "node:assert/strict";

import { buildFoldedFacts } from "../../src/compact/fold-summary-journal.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { mergeFoldRecords } from "../../src/store/folds.js";
import { toFoldRecord } from "../../src/store/fold-record.js";

/** 造一份真实的两折账本（每折都有 from/to/rounds/title/正文）。 */
function twoFoldFacts() {
  const first = buildFoldedFacts({
    text: "## 行动\n第一折：读了 gateway/router.ts\n## 遗留\n无\n## 关键词\ngateway",
    title: "第一折",
    summary: "## 行动\n第一折：读了 gateway/router.ts\n## 遗留\n无\n## 关键词\ngateway",
    origin: "semantic",
    source: "llm",
    strategy: "fold-llm",
    roundRange: { from: 1, to: 5 },
    rounds: 5,
    foldId: "fold-a",
    seq: 1,
  });
  const second = buildFoldedFacts({
    text: "## 行动\n第二折：改了 store/pg/pool.ts\n## 遗留\n跑测试\n## 关键词\npool",
    title: "第二折",
    summary: "## 行动\n第二折：改了 store/pg/pool.ts\n## 遗留\n跑测试\n## 关键词\npool",
    origin: "semantic",
    source: "llm",
    strategy: "fold-llm",
    roundRange: { from: 6, to: 11 },
    rounds: 6,
    foldId: "fold-b",
    seq: 2,
  });
  assert.ok(first !== undefined && second !== undefined);
  return [first, second];
}

/** 用同一份账本渲染一次（策略的真实入口：`callOptions.foldRecords`）。 */
async function renderWith(foldRecords) {
  const strategy = createFoldStatisticalStrategy();
  const messages = [];
  for (let round = 1; round <= 20; round += 1) {
    messages.push({ role: "user", content: `第 ${round} 轮：巡检` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `第 ${round} 轮完成` }] });
  }
  const result = await strategy.compact(messages, {
    keepRounds: 1,
    budgetTokens: 200,
    foldRecords,
  });
  const block = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
  return block;
}

test("261128-12 判据1：九列重建出的账本与原始旧形状账本渲染出的块逐字相同", async () => {
  const original = twoFoldFacts();
  const store = createMemoryTranscriptStore();
  for (const facts of original) {
    await store.appendFold("run-read", toFoldRecord(facts, {
      cutRound: /** @type {any} */ (facts).to,
      tokensBefore: 1000,
      tokensAfter: 400,
    }));
  }
  const channelRows = await store.loadFolds("run-read");
  const rebuilt = mergeFoldRecords({ channelRows, roundFacts: [] });
  assert.equal(rebuilt.length, 2, "两折都要重建出来（不许被身份去重吃掉）");

  const fromOriginal = await renderWith(original);
  const fromRebuilt = await renderWith(rebuilt);
  assert.equal(fromRebuilt, fromOriginal,
    "同一次折叠，账本来自九列重建还是旧形状，渲染必须逐字相同——否则四个读点就得改");
});

test("261128-12 判据2：重建账本真的走了「账本路径」（不是退回块解析）", async () => {
  const original = twoFoldFacts();
  const store = createMemoryTranscriptStore();
  for (const facts of original) {
    await store.appendFold("run-read-2", toFoldRecord(facts, { cutRound: /** @type {any} */ (facts).to }));
  }
  const rebuilt = mergeFoldRecords({ channelRows: await store.loadFolds("run-read-2"), roundFacts: [] });
  const block = await renderWith(rebuilt);
  // 账本路径会把**更早那一折的 title** 渲染出来；块解析拿不到它（块里没有 title 这个信息面）。
  assert.match(block, /第一折/, `块里应出现账本里的旧折标题（实测块：${block.slice(0, 300)}）`);
  // 分段渲染（两折 ⇒ `formatSegmentedFoldSummary`）的骨架也在。
  assert.match(block, /共折叠|覆盖第|近期|更早/u);
});

// ── 261128-13：**有口子的区间**（copilot 复审抓到的阻断项）─────────────────────────
// 真机现场 `1–5, 6–6, 8–8`（`fold-statistical.js:834` 引的那份原始数据）：第 7 轮一轮未折。
// 只按「上一折切点 + 1」推 `from` 会把第 7 轮误报成已折 ⇒ 必须把 `from_round` 存成列。
test("261128-13 判据3：区间有口子时 from 取列值，不按「上一折切点+1」猜", async () => {
  const store = createMemoryTranscriptStore();
  // 三折：1–5 / 6–6 / 8–8 —— 第 7 轮没被任何一折吃掉。
  const folds = [
    { foldId: "g1", summary: "第一折", title: "第一折", origin: "semantic", fromRound: 1, cutRound: 5, rounds: 5 },
    { foldId: "g2", summary: "第二折", title: "第二折", origin: "semantic", fromRound: 6, cutRound: 6, rounds: 1 },
    { foldId: "g3", summary: "第三折", title: "第三折", origin: "semantic", fromRound: 8, cutRound: 8, rounds: 1 },
  ];
  for (const fold of folds) {
    await store.appendFold("run-gap", toFoldRecord(fold, {
      cutRound: fold.cutRound, fromRound: fold.fromRound, rounds: fold.rounds,
    }));
  }
  const rebuilt = mergeFoldRecords({ channelRows: await store.loadFolds("run-gap"), roundFacts: [] });
  assert.equal(rebuilt.length, 3);
  assert.deepEqual(rebuilt.map((r) => [r.from, r.to, r.rounds]), [[1, 5, 5], [6, 6, 1], [8, 8, 1]],
    "三折的区间必须逐字还原；按切点推的话第二折会变成 7–8、把第 7 轮误报成已折");
});
