// 记忆评测夹具 e2e（需 LLM_KIT_E2E=1）：折叠后模型应主动 recall 且答案与原文一致
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMemoryBenchmark, FACT } from "./memory-benchmark.js";

const E2E = process.env.LLM_KIT_E2E === "1";

test("记忆基准：折叠后 recall 命中且答案一致", { skip: !E2E && "设 LLM_KIT_E2E=1", timeout: 300_000 }, async () => {
  const { result, recallCalls, store, runId } = await runMemoryBenchmark();

  // 压缩确实发生（早期轮被折叠，事实不在上下文里）
  assert.ok(result.compactionStats.length >= 1, "应发生压缩");
  assert.ok(result.compactionStats.some((s) => s.compacted), "应真实折叠轮次");

  // 模型主动调用了 recall（引导机制有效：面包屑 + description + 系统提示）
  assert.ok(recallCalls.length >= 1, "模型应主动调用 recall");

  // 答案与植入原文一致（不是幻觉）
  assert.ok(result.finalText.includes(FACT.expect), `答案应含 "${FACT.expect}"，实际：${result.finalText.slice(0, 200)}`);

  // recall 结果确从档案来（transcript 有对应 tool_result 且无错误）
  const transcript = await store.load(runId);
  const recallResults = transcript.flatMap((r) => r.messages)
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result");
  assert.ok(recallResults.length >= 1);
  assert.ok(recallResults.some((b) => b.content.includes(FACT.expect)), "recall 返回应包含原文事实");
});
