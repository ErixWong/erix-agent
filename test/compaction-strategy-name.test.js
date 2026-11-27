import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
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

// issue #873（MIN_KEEP_ROUNDS=5）：有效保留下限 = max(keepRounds, 5)，`keepRounds: 0` ⇒ 实际按 5 算。
// 预算太小会被 `sliding-window` 兜底层抢先整轮丢，配置策略在 len≤5 时折 0 轮 ⇒ 摘要器从不调。
// 正解是让历史先长过 5 轮再由策略折：把 BASE_SCRIPT 扩到 6 个 tool 轮 + 收尾，并把预算抬到 1100
// （target=715）：实测第一次超预算时恰有 6 轮、策略恰好折最老那一轮（范围「第 1 轮 - 第 1 轮」）、
// 摘要器恰好调 1 次。契约断言逐字保留；`result.rounds` 为 7（6 tool 轮 + 收尾，摘要不占轮）。
const BASE_SCRIPT = [
  { content: [{ type: "tool_use", id: "work-1", name: "work", input: { path: "src/a.js" } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "work-2", name: "work", input: { path: "src/b.js" } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "work-3", name: "work", input: { path: "src/c.js" } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "work-4", name: "work", input: { path: "src/d.js" } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "work-5", name: "work", input: { path: "src/e.js" } }], stopReason: "tool_use" },
  { content: [{ type: "tool_use", id: "work-6", name: "work", input: { path: "src/f.js" } }], stopReason: "tool_use" },
  { content: [{ type: "text", text: "final answer" }], stopReason: "end_turn" },
];

async function runWithProvider(provider, context, usageSink, { toolOutputChars = 400 } = {}) {
  const events = [];
  const controller = new AbortController();
  const strategy = context?.strategy;
  const strategyObject = strategy !== null && typeof strategy === "object" ? strategy : undefined;
  const dataOnly = { ...context };
  if (strategyObject !== undefined) delete dataOnly.strategy;
  const result = await runDirect({
    signal: controller.signal,
    provider,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(toolOutputChars)}`,
    maxRounds: 16,
    completion: false,
    // #498 S3: split by **value shape**, not by key name. A strategy **object** is a behaviour
    // carrier (`capabilities.ports.strategy`); a bad scalar (`7`) or the retired strategy **name**
    // (`"fold-llm"`) is data and stays in `config.folding.context` — both fail at the same startup
    // place inside `resolveCompactionStrategy`.
    config: { folding: { context: { budgetTokens: 1100, keepRounds: 0, ...dataOnly } } },
    store: createMemoryTranscriptStore(),
    runId: "compaction-strategy-name",
    capabilities: {
      ...(strategyObject === undefined ? {} : { ports: { strategy: strategyObject } }),
      hooks: {
        onEvent: (event) => events.push(event),
        // `onUsage` 的规位是 `capabilities.hooks.onUsage`；只有「折叠摘要真的记账了」那一格才订阅。
        ...(usageSink === undefined ? {} : { onUsage: usageSink }),
      },
    },
  });
  return { result, events };
}

// issue #261127-12：折叠策略的**名字形态已删**。`"fold-llm"` 曾是唯一合法名字，写与不写等价
// ⇒ 纯税。缺省即引擎内置 fold-llm（语义折叠），本文件的「by name」格因此改写为「不配策略」格。

test("non-string, non-object strategy values also fail at startup", async () => {
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  await assert.rejects(
    runWithProvider(provider, { strategy: 7 }),
    { name: "TypeError" },
  );
  assert.equal(provider.mainRequests.length, 0);
});

test("the retired strategy name \"fold-llm\" now fails at startup with a TypeError (issue #261127-12)", async () => {
  // 判据 3（端到端面）：`context.strategy: "fold-llm"` ⇒ 启动期 TypeError，且不发任何主请求。
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  await assert.rejects(
    runWithProvider(provider, { strategy: "fold-llm" }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /strategy object/u);
      return true;
    },
  );
  assert.equal(provider.mainRequests.length, 0);
});

test("an unconfigured run folds via the built-in fold-llm with the run provider and books the usage", async () => {
  // 判据 1：不配任何策略 ⇒ 折叠**照常发生**，摘要来自引擎装配的 LLM summarizer（用假 provider 计数）。
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT });
  const usages = [];
  // 不传 `strategy`：缺省即引擎内置 fold-llm（与旧名字形态逐字等价）。
  const { result, events } = await runWithProvider(provider, {}, (usage) => usages.push(usage));

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
  assert.equal(result.rounds, 7, "6 个 tool 轮 + 收尾 = 7 个模型轮（摘要不占轮）");
  assert.equal(result.finalText, "final answer");
  assert.ok(events.some((event) => event.type === "compaction"));
});

test("a failing summarizer fails the run with summarizer_failed instead of degrading", async () => {
  // issue #661 语义反转：摘要器失败 = 终局错误；反向锁：请求里再也不许出现那条降级标记。
  // issue #261127-12：不配策略 ⇒ 缺省 fold-llm，其默认 summarizer 失败同样终局。
  const provider = createSummarizingProvider({
    mainScript: BASE_SCRIPT,
    summaryError: new Error("upstream 503"),
  });
  const failure = await runWithProvider(provider, {}).then(
    () => assert.fail("摘要器失败必须让 run 以 failed 终局"),
    (error) => error,
  );

  assert.equal(provider.summaryRequests.length, 1);
  assert.equal(failure.code, "summarizer_failed");
  assert.equal(failure.details.kind, "error");
  assert.equal(failure.termination?.reason, "failed");
  assert.equal(failure.termination?.errorCode, "summarizer_failed");
  // 反向锁：失败后没有第二次主请求，更没有把降级替代物塞进上下文。
  const nextRequest = JSON.stringify(provider.mainRequests.at(-1) ?? {});
  assert.doesNotMatch(nextRequest, /已降级为统计摘要/u);
  assert.doesNotMatch(nextRequest, /upstream 503/u);
});

test("an empty summarizer answer fails the run rather than folding into nothing", async () => {
  // issue #661：空串 / 空白摘要不再降级。issue #873 MIN_KEEP_ROUNDS=5：`toolOutputChars: 4000`
  // 每轮远超 1000 token；预算抬到 7000：实测 6 个 tool 轮时恰超预算⇒策略折最老一轮⇒空摘要⇒failed。
  const provider = createSummarizingProvider({ mainScript: BASE_SCRIPT, summaryText: "   " });
  const failure = await runWithProvider(
    provider,
    { budgetTokens: 7000 },
    undefined,
    { toolOutputChars: 4000 },
  ).then(
    () => assert.fail("空摘要必须让 run 以 failed 终局"),
    (error) => error,
  );

  assert.equal(failure.code, "summarizer_failed");
  assert.equal(failure.details.kind, "empty_summary");
  assert.equal(failure.termination?.reason, "failed");
  assert.match(JSON.stringify(provider.mainRequests.at(-1) ?? {}), /^(?!.*已降级为统计摘要)/u);
});

test("object-form strategies keep working verbatim, including their own summarizer", async () => {
  // 判据 2：宿主给对象 ⇒ 用宿主那个（含「对象形态不吃引擎 summarizer」这条）。
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
// issue #261127-12：不配策略（缺省 fold-llm），摘要器仍由引擎装配，signal 仍须透传。
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
    runDirect({
      signal: controller.signal,
      provider,
      initialUserMessage: `start ${"y".repeat(600)}`,
      executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
      maxRounds: 16,
      completion: false,
      config: { folding: { context: { budgetTokens: 1200, keepRounds: 0 } } },
      store: createMemoryTranscriptStore(),
      runId: "issue-486-p1b",
    }).catch(() => {}),
    new Promise((resolve) => { setTimeout(resolve, 5_000); }),
  ]);
  assert.equal(summaryRequests.length, 1, "前提：这条路径确实发起了摘要调用");
  assert.equal(summaryRequests[0].signal?.aborted, true, "宿主 abort 后摘要请求必须被中止");
  assert.ok(Date.now() - startedAt < 5_000, "不得等摘要器自然完成（旧形状会跑到 30 s 死线）");
});
