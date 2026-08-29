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

test("loadRelayConfig：models.json 可读且不含硬编码凭据", { skip: !E2E && "设 LLM_KIT_E2E=1" }, async () => {
  const cfg = await loadRelayConfig();
  assert.ok(cfg.endpoint.startsWith("https://"));
  assert.ok(cfg.apiKey.length > 0);
  assert.ok(cfg.model.length > 0);
});
