// memory-benchmark —— ADR-007 决策六：摘要保真度夹具
// 管道：构造含已知事实的长对话 → fold-statistical 确定性折叠
//      → 检查摘要足迹与 transcript 的 foldedPayload 档案完整性。
//
// 这是发布前 E2E 集合中的确定性检查：不依赖模型是否会调用 recall，
// 但仍读取 relay 配置，确保发布环境的配置入口可用。

import {
  createFoldStatisticalStrategy,
  createMemoryTranscriptStore,
} from "../src/index.js";
import { loadRelayConfig } from "./exec-demo.js";

/** 植入的事实：特意不可猜，便于确认 foldedPayload 保存的是原文。 */
export const FACT = {
  keyword: "遥测服务告警阈值",
  text: "遥测服务的告警阈值定为 42.5%，这是 2026-08-20 评审会上定的，写进了运维手册第 7 节。",
};

const filler = (topic) =>
  `关于${topic}的讨论记录：这部分是填充上下文的历史讨论，内容足够长以便触发压缩。`.repeat(15);

const BENCHMARK_BUDGET_TOKENS = 600;
const BENCHMARK_KEEP_ROUNDS = 1;

/** 跑一次摘要保真度基准，返回 { result, store, runId, model }。 */
export async function runMemoryBenchmark() {
  const cfg = await loadRelayConfig();
  const store = createMemoryTranscriptStore();
  const runId = `memory-bench-${Date.now()}`;
  const strategy = createFoldStatisticalStrategy();
  const messages = [
    { role: "user", content: "先对齐一下运维背景：" + filler("发布流程") },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "fact-1",
        name: "recordFact",
        input: { keyword: FACT.keyword },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "fact-1",
        content: FACT.text,
      }],
    },
    { role: "assistant", content: "已记录该约定。" + filler("告警平台确认") },
    { role: "user", content: "继续补充监控面板的配置历史：" + filler("监控面板") },
  ];

  const result = await strategy.compact(messages, {
    budgetTokens: BENCHMARK_BUDGET_TOKENS,
    keepRounds: BENCHMARK_KEEP_ROUNDS,
  });
  const summary = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((block) => (
      block?.type === "text" && block.text.includes("【上下文折叠·v1·erix-9f6e2c】")
    ))?.text ?? "";
  const foldedRecord = {
    round: 1,
    roundKey: `${runId}:round:1`,
    messages: result.messages,
    folded: result.compacted,
    foldedPayload: result.foldedPayload,
    foldedRoundRange: result.foldedRoundRange,
  };
  await store.appendRound(runId, {
    round: 0,
    roundKey: `${runId}:round:0`,
    messages,
    summary: "missing",
  });
  await store.appendRound(runId, foldedRecord);

  return {
    result: {
      strategy: strategy.name,
      budgetTokens: BENCHMARK_BUDGET_TOKENS,
      shouldCompact: strategy.shouldCompact(messages, BENCHMARK_BUDGET_TOKENS),
      compactionStats: [{
        compacted: result.compacted,
        foldedRounds: result.foldedRounds,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      }],
      foldedSummary: summary,
      foldedPayload: result.foldedPayload,
    },
    store,
    runId,
    model: cfg.model,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, store, runId, model } = await runMemoryBenchmark();
  const folded = (await store.load(runId)).find((record) => record.folded);
  console.log(`model=${model} strategy=${result.strategy}`);
  console.log(`compacted=${result.compactionStats[0].compacted} foldedRounds=${result.compactionStats[0].foldedRounds}`);
  console.log(`foldedPayload=${folded?.foldedPayload?.length ?? 0} ${folded ? "✅ 档案完整" : "❌ 缺少档案"}`);
}
