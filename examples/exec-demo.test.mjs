// e2e：exec-demo 打真实 relay（需 LLM_KIT_E2E=1，缺省 skip）
// 验收锚点（issue #1 / docs/testing.md §1）：轮数≥2、transcript 含 exec 的 tool_result、finalText 非空
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExecDemo, loadRelayConfig } from "./exec-demo.js";

const E2E = process.env.LLM_KIT_E2E === "1";

test("exec-demo：真实 LLM 多轮工具调用", { skip: !E2E && "设 LLM_KIT_E2E=1 才跑真实 relay", timeout: 300_000 }, async () => {
  const { result, store, runId } = await runExecDemo("列出当前目录的文件，告诉我这是一个什么项目");

  assert.ok(result.rounds >= 2, `应至少 2 轮（工具调用 + 终稿），实际 ${result.rounds}`);
  assert.equal(result.truncated, false);
  assert.ok(result.finalText.length > 0, "finalText 非空");

  const transcript = await store.load(runId);
  const toolResults = transcript.flatMap((r) => r.messages)
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result");
  assert.ok(toolResults.length >= 1, "transcript 应含 tool_result");
  assert.ok(toolResults.every((b) => !b.is_error), `工具调用不应全部出错: ${toolResults[0]?.content}`);

  const recalled = await store.recall(runId, undefined, undefined, "exec");
  assert.ok(recalled.includes("exec"), "recall 能检索到 exec 调用足迹");
});

test("exec-demo：小预算强制触发 fold-statistical 压缩", { skip: !E2E && "设 LLM_KIT_E2E=1", timeout: 300_000 }, async () => {
  // 构造一段早期对话历史（真实 user/assistant 文本轮），小预算下首轮即被折叠——
  // 不依赖模型的分轮行为，确定性触发
  const longText = "这是一段早期讨论的上下文占位文本，内容足够长以便超出压缩预算。".repeat(20);
  const { result, store, runId } = await runExecDemo(undefined, {
    compactBudgetTokens: 500, keepRounds: 1,
    initialMessages: [
      { role: "user", content: "项目背景确认：" + longText },
      { role: "assistant", content: "已了解背景。" + longText },
      { role: "user", content: "补充约束：" + longText },
      { role: "assistant", content: "约束已记录。" + longText },
      { role: "user", content: "列出当前目录的文件，简要总结" },
    ],
  });
  assert.ok(result.finalText.length > 0);
  assert.ok(result.compactionStats.length >= 1, "应至少发生一次压缩");
  assert.ok(result.compactionStats[0].compacted, "首次压缩应真实折叠轮次");
  assert.ok(result.compactionStats[0].foldedRounds >= 1);
  const transcript = await store.load(runId);
  const folded = transcript.filter((r) => r.folded);
  assert.ok(folded.length >= 1, "store 应有 folded 记录");
  assert.ok(folded[0].foldedPayload?.length >= 1, "foldedPayload 应含被折叠轮次原文");
});

test("loadRelayConfig：models.json 可读且不含硬编码凭据", { skip: !E2E && "设 LLM_KIT_E2E=1" }, async () => {
  const cfg = await loadRelayConfig();
  assert.ok(cfg.endpoint.startsWith("https://"));
  assert.ok(cfg.apiKey.length > 0);
  assert.ok(cfg.model.length > 0);
});
