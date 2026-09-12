// e2e：摘要保真度与 transcript 档案完整性（需 LLM_KIT_E2E=1，缺省 skip）
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMemoryBenchmark, FACT } from "./memory-benchmark.js";

const E2E = process.env.LLM_KIT_E2E === "1";

test("记忆基准：fold-statistical 摘要保真且 foldedPayload 可找回", {
  skip: !E2E && "设 LLM_KIT_E2E=1 才运行发布前 E2E",
  timeout: 300_000,
}, async () => {
  const { result, store, runId, model } = await runMemoryBenchmark();

  assert.equal(result.strategy, "fold-statistical");
  assert.equal(result.shouldCompact, true, "测试输入应超过折叠预算");
  assert.ok(result.compactionStats.some((stat) => stat.compacted), "应真实发生折叠");
  assert.ok(result.compactionStats[0].foldedRounds >= 1, "应折叠至少一个轮次");

  // 摘要不需要包含原文事实，但必须保留可定位的轮次与工具足迹。
  assert.match(result.foldedSummary, /早期第 \d+–\d+ 轮（共 \d+ 轮）已折叠/u);
  assert.match(result.foldedSummary, /工具足迹：recordFact×1/u);

  // 折叠只改变上下文视图，原文必须仍在 transcript 的 foldedPayload 档案中。
  const transcript = await store.load(runId);
  const folded = transcript.find((record) => record.folded === true);
  assert.ok(folded, "store 应有 folded 记录");
  assert.ok(Array.isArray(folded.foldedPayload), "folded 记录应带 foldedPayload");
  assert.deepEqual(folded.foldedPayload, result.foldedPayload);
  assert.match(
    JSON.stringify(folded.foldedPayload),
    new RegExp(FACT.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
  );

  console.log(
    `[memory-benchmark] model=${model} verdict=PASS `
    + `summary=${result.foldedSummary.slice(0, 120)}... `
    + `payload=${folded.foldedPayload.length}`,
  );
});
