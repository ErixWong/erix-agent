// e2e：exec-demo 打真实 relay（需 LLM_KIT_E2E=1，缺省 skip）
// 验收锚点（issue #1 / docs/testing.md §1）：轮数≥2、transcript 含 exec 的 tool_result、finalText 非空
//
// 本文件另含**不联网**用例（始终跑）：断言输出预算 maxOutputTokens 确实传到了 provider 构造参数上
// （issue #245 第 3 件）。它们只把 HOME 指向临时目录里的假 models.json，并把 fetch 掉开，
// 因此不会发出任何真实 LLM 请求。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecDemo, loadRelayConfig, createProviderFromConfig } from "./exec-demo.js";

const E2E = process.env.LLM_KIT_E2E === "1";

/**
 * 把 HOME 指向一个只装了 `.pi/agent/models.json` 的临时目录，让 loadRelayConfig 可在
 * 不打网络的前提下读配置；同时把 globalThis.fetch 掉开，真发了请求就会红。
 */
async function withFakeHome(modelEntry, fn) {
  const home = await mkdtemp(join(tmpdir(), "exec-demo-home-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "models.json"), JSON.stringify({
    providers: {
      "my-relay": { baseUrl: "https://relay.invalid/v1", apiKey: "sk-fake-not-secret", models: [modelEntry] },
    },
  }), "utf8");
  const savedHome = process.env.HOME;
  const savedFetch = globalThis.fetch;
  process.env.HOME = home;
  globalThis.fetch = () => { throw new Error("不联网用例不应发任何网络请求"); };
  try {
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  }
}

// ---- 不联网用例（始终跑）----

test("exec-demo：输出预算从 models.json 读出并被夹到 8192（不联网）", async () => {
  for (const c of [
    { maxTokens: 20_000, want: 8192 },   // 高于上限→夹住
    { maxTokens: 2048, want: 2048 },     // 低于上限→原值
    { want: 8192 },                       // 没写 maxTokens→兜底 8192
  ]) {
    await withFakeHome({ maxTokens: c.maxTokens, contextWindow: 200_000 }, async () => {
      const cfg = await loadRelayConfig();
      assert.equal(cfg.maxOutputTokens, c.want, `models[0].maxTokens=${c.maxTokens} 应得出 ${c.want}`);
      assert.equal(cfg.endpoint, "https://relay.invalid/v1");
      assert.equal(cfg.apiKey, "sk-fake-not-secret");
      assert.ok(typeof cfg.model === "string" && cfg.model.length > 0, "模型名必须来自配置，不得为空");
    });
  }
});

test("exec-demo：maxOutputTokens 真的进了 provider 构造参数（不联网，注入 provider 工厂）", async () => {
  let captured;
  const fakeProvider = { __fake: "provider" };
  const built = await withFakeHome({ maxTokens: 20_000, contextWindow: 200_000 }, async () => {
    const cfg = await loadRelayConfig();
    return createProviderFromConfig(cfg, (options) => { captured = options; return fakeProvider; });
  });
  assert.equal(built, fakeProvider, "返回值必须是注入工厂的产物（真实 provider 未被构造）");
  assert.equal(captured.maxOutputTokens, 8192, "输出预算必须显式传给 provider 构造函数（此前算了却未传）");
  assert.equal(captured.endpoint, "https://relay.invalid/v1");
  assert.equal(captured.apiKey, "sk-fake-not-secret");
  assert.ok(typeof captured.model === "string" && captured.model.length > 0, "模型名从配置透传，未硬编码覆盖");
  assert.equal(captured.timeoutMs, 120_000);

  // 轮数上限仍显式存在：不联网跑不了真 loop，故在源码层面钉住它仍被显式写出，
  // 不会退化成库里 runToolLoop 的默认轮数上限。
  const src = await readFile(new URL("./exec-demo.js", import.meta.url), "utf8");
  assert.match(src, /maxRounds: 8,/, "runToolLoop 侧的 maxRounds 上限必须仍显式写出");
});

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
