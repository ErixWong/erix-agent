// memory-benchmark —— ADR-007 决策六：记忆评测夹具 v1
// 管道：植入已知事实的长对话（initialMessages）→ 小预算强制 fold-statistical 折叠
//      → 提问需要该事实的问题 → 断言模型主动 recall 且答案与原文一致（非幻觉）
// 这是后续一切记忆工作（episode/冷循环/蒸馏）的回归网：召回率不许 degrade。
//
// LLM 配置直读 pi models.json（同 exec-demo）。LLM_KIT_E2E=1 才在测试中运行。

import { runToolLoop, createMemoryTranscriptStore, createFoldStatisticalStrategy } from "../src/index.js";
import { createRecallTool } from "../src/tools/index.js";
import { loadRelayConfig } from "./exec-demo.js";
import { createOpenAIProvider } from "../src/index.js";

/** 植入的事实：特意不可猜（避免模型凭先验答对造成假阳性） */
export const FACT = {
  keyword: "遥测服务告警阈值",
  text: "遥测服务的告警阈值定为 42.5%，这是 2026-08-20 评审会上定的，写进了运维手册第 7 节。",
  question: "我们的遥测服务告警阈值是多少？请给出具体数字。",
  expect: "42.5",
};

const filler = (topic) =>
  `关于${topic}的讨论记录：这部分是填充上下文的历史讨论，内容足够长以便触发压缩。`.repeat(15);

/** 跑一次基准，返回 { result, recallCalls, store, runId } */
export async function runMemoryBenchmark() {
  const cfg = await loadRelayConfig();
  const provider = createOpenAIProvider({
    endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: 120_000,
  });
  const store = createMemoryTranscriptStore();
  const runId = `memory-bench-${Date.now()}`;
  const recall = createRecallTool({ store, runId });

  const recallCalls = [];
  const executeTool = async (name, input) => {
    if (name !== "recall") throw new Error(`未知工具: ${name}`);
    recallCalls.push(input);
    return recall.execute(input);
  };

  const result = await runToolLoop({
    provider,
    system: "你是一个运维助手。早期对话已被折叠时，用 recall 工具找回细节再回答，不要凭印象编数字。",
    initialMessages: [
      { role: "user", content: "先对齐一下运维背景：" + filler("发布流程") },
      { role: "assistant", content: "好的，发布流程背景已了解。" + filler("发布流程确认") },
      { role: "user", content: `有一条重要约定要记下：${FACT.text} 另外，` + filler("告警平台") },
      { role: "assistant", content: "已记录该约定。" + filler("告警平台确认") },
      { role: "user", content: "再补充一些监控面板的配置历史：" + filler("监控面板") },
      { role: "assistant", content: "了解。" + filler("监控面板确认") },
      { role: "user", content: FACT.question },
    ],
    tools: [recall.schema],
    executeTool,
    maxRounds: 6,
    store,
    runId,
    context: { strategy: createFoldStatisticalStrategy(), budgetTokens: 600, keepRounds: 1 },
  });
  return { result, recallCalls, store, runId };
}

// CLI 入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const { result, recallCalls } = await runMemoryBenchmark();
  console.log("=== 终稿 ===\n" + result.finalText);
  console.log(`\nrecall 调用 ${recallCalls.length} 次：`, JSON.stringify(recallCalls));
  console.log(`compactions=${result.compactionStats.length} rounds=${result.rounds}`);
  console.log(result.finalText.includes(FACT.expect) ? "✅ 命中事实" : "❌ 未命中事实");
}
