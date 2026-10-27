import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFoldLlmStrategy } from "../src/compact/fold-llm.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";

/**
 * Provider that answers both the main loop and the injected fold-llm summarizer call.
 * The summarizer request is recognized by its system prompt (it carries no tools).
 */
function createSummarizingProvider({
  mainScript,
  summaryText = "## 阶段\ncompressed history",
  summaryUsage = { input_tokens: 900, output_tokens: 50 },
  summaryError,
} = {}) {
  const summaryRequests = [];
  let mainIndex = 0;
  const mainRequests = [];

  const provider = {
    protocol: "fake",
    model: "fake-model",
    mainRequests,
    summaryRequests,
    async chat(request) {
      const isSummary = typeof request?.system === "string"
        && request.system.includes(SUMMARY_SYSTEM);
      if (isSummary) {
        summaryRequests.push(request);
        if (summaryError !== undefined) throw summaryError;
        return {
          content: [{ type: "text", text: summaryText }],
          stopReason: "end_turn",
          usage: summaryUsage,
        };
      }
      mainRequests.push(request);
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      return {
        ...step,
        usage: step.usage ?? { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
  return provider;
}

const BASE_SCRIPT = [
  {
    content: [{ type: "tool_use", id: "work-1", name: "work", input: { path: "src/a.js" } }],
    stopReason: "tool_use",
  },
  { content: [{ type: "text", text: "final answer" }], stopReason: "end_turn" },
];

async function runWithProvider(provider, context, extra = {}) {
  const events = [];
  const controller = new AbortController();
  const result = await runToolLoop({
    signal: controller.signal,
    provider,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    maxRounds: 3,
    completion: false,
    context: { budgetTokens: 400, keepRounds: 0, ...context },
    store: createMemoryTranscriptStore(),
    runId: "compaction-strategy-name",
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { result, events };
}

test("built-in names resolve once at startup and drive the same compaction channel", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  const { result } = await runWithProvider(provider, { strategy: "fold-statistical" });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(provider.summaryRequests.length, 0);
  assert.ok(result.compactionStats.some((stat) => (
    stat.compacted === true && stat.layers.foldStatistical.triggered > 0
  )));
});

test("unknown strategy names fail before the first provider call", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  await assert.rejects(
    runWithProvider(provider, { strategy: "fold-lm" }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /sliding-window \| fold-statistical \| fold-llm/u);
      return true;
    },
  );
  assert.equal(provider.mainRequests.length, 0);
  assert.equal(provider.summaryRequests.length, 0);
});

test("non-string, non-object strategy values also fail at startup", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  await assert.rejects(
    runWithProvider(provider, { strategy: 7 }),
    { name: "TypeError" },
  );
  assert.equal(provider.mainRequests.length, 0);
});

test("fold-llm by name summarizes folded rounds with the run provider and books the usage", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  const usages = [];
  const { result, events } = await runWithProvider(provider, { strategy: "fold-llm" }, {
    onUsage: (usage) => usages.push(usage),
  });

  // 1) the summary really happened, once, with no tools attached
  assert.equal(provider.summaryRequests.length, 1);
  const summaryRequest = provider.summaryRequests[0];
  assert.equal(summaryRequest.tools, undefined);
  assert.ok(summaryRequest.signal instanceof AbortSignal, "abort signal must reach the call");

  // 2) its input carries the guide, the round range and the folded content itself
  const prompt = summaryRequest.messages[0].content;
  assert.match(prompt, /## 主题词面包屑/u);
  assert.match(prompt, /【被折叠的轮次】第 1 轮 - 第 1 轮/u);
  assert.match(prompt, /tool output for work-1/u);
  assert.match(prompt, /\[assistant\]/u);

  // 3) the summary text lands in the next model request (the folded context in use)
  const nextRequest = JSON.stringify(provider.mainRequests.at(-1));
  assert.match(nextRequest, /compressed history/u);
  assert.doesNotMatch(nextRequest, /摘要失败/u);

  // 4) usage merged into the run ledger and visible through onUsage
  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0], { input_tokens: 900, output_tokens: 50 });
  assert.ok(result.usage.input_tokens >= 900);
  assert.ok(result.usage.output_tokens >= 50);
  assert.equal(
    result.usage.input_tokens,
    provider.mainRequests.length * 100 + 900,
  );

  // 5) the run still finishes normally, and the summary call is not a round
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, "final answer");
  assert.ok(events.some((event) => event.type === "compaction"));
});

test("a failing summarizer degrades to the statistical summary instead of killing the run", async () => {
  const provider = createSummarizingProvider({
    mainScript: BASE_SCRIPT,
    summaryError: new Error("upstream 503"),
  });
  const { result } = await runWithProvider(provider, { strategy: "fold-llm" });

  assert.equal(provider.summaryRequests.length, 1);
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "final answer");
  assert.equal(result.usage.input_tokens, provider.mainRequests.length * 100);
  const nextRequest = JSON.stringify(provider.mainRequests.at(-1));
  assert.match(nextRequest, /摘要失败，已降级为统计摘要/u);
  assert.match(nextRequest, /upstream 503/u);
  // 降级摘要仍带折叠 stub / 导航信息（不比原生统计摘要少）
  assert.match(nextRequest, /上下文折叠/u);
});

test("an empty summarizer answer also degrades rather than folding into nothing", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT, summaryText: "   " });
  const { result } = await runWithProvider(provider, { strategy: "fold-llm" });

  assert.equal(result.termination.reason, "end_turn");
  assert.match(JSON.stringify(provider.mainRequests.at(-1)), /摘要失败，已降级为统计摘要/u);
});

test("object-form strategies keep working verbatim, including their own summarizer", async () => {
  const injectedCalls = [];
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      injectedCalls.push(1);
      return "## 阶段\nhost injected summary";
    },
  });
  const { result } = await runWithProvider(provider, { strategy });

  assert.equal(injectedCalls.length, 1);
  assert.equal(provider.summaryRequests.length, 0);
  assert.match(JSON.stringify(provider.mainRequests.at(-1)), /host injected summary/u);
  assert.equal(result.termination.reason, "end_turn");
  // 注入形式的 usage 由宿主自己负责：引擎不记账
  assert.equal(result.usage.input_tokens, provider.mainRequests.length * 100);

  const statistical = createFoldStatisticalStrategy();
  const statisticalRun = await runWithProvider(
    createSummarizingProvider({ mainScript: BASE_SCRIPT }),
    { strategy: statistical },
  );
  assert.equal(statisticalRun.result.termination.reason, "end_turn");
  assert.ok(statisticalRun.result.compactionStats.some((stat) => stat.compacted === true));
});

// issue #486 P1-B：宿主 abort run 之后，折叠摘要那一发必须真的被中止。
// 补丁前 `createProviderSummarizer` 没接 `signal`，而超时恒开 ⇒ `request.signal` 恒是子
// controller，chat 包装里 `request.signal ?? signal` 把 run 的 signal 永久短路，子 controller
// 从未接父 abort ⇒ 摘要 HTTP 继续跑到自然完成（token 照扣且不进 engineUsage）。
test("#486 P1-B 宿主 abort 必须真的中止摘要请求（run 的 signal 不再被短路）", async () => {
  const summaryRequests = [];
  const controller = new AbortController();
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      const isSummary = typeof request?.system === "string"
        && request.system.includes(SUMMARY_SYSTEM);
      if (!isSummary) {
        return {
          content: [{ type: "tool_use", id: "work-1", name: "work", input: { path: "src/a.js" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      summaryRequests.push(request);
      // 真 provider 的形状：HTTP 挂着，只有 signal abort 才收工。
      setTimeout(() => controller.abort(), 20);
      return new Promise((_, reject) => {
        const fail = () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          error.code = "aborted";
          reject(error);
        };
        if (request?.signal?.aborted === true) fail();
        else request?.signal?.addEventListener("abort", fail, { once: true });
      });
    },
  };
  const startedAt = Date.now();
  // 回归时 run 会挂到摘要器 30 s 默认死线：用 5 s 上限把「挂住」变成可读的断言失败。
  await Promise.race([
    runToolLoop({
      signal: controller.signal,
      provider,
      initialUserMessage: `start ${"y".repeat(600)}`,
      executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
      maxRounds: 3,
      completion: false,
      context: { budgetTokens: 400, keepRounds: 0, strategy: "fold-llm" },
      store: createMemoryTranscriptStore(),
      runId: "issue-486-p1b",
    }).catch(() => {}),
    new Promise((resolve) => { setTimeout(resolve, 5_000); }),
  ]);
  assert.equal(summaryRequests.length, 1, "前提：这条路径确实发起了摘要调用");
  assert.equal(summaryRequests[0].signal?.aborted, true, "宿主 abort 后摘要请求必须被中止");
  assert.ok(Date.now() - startedAt < 5_000, "不得等摘要器自然完成（旧形状会跑到 30 s 死线）");
});
