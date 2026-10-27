// issue #469（宿主 2026-10-26 审计 B1 + 裁决）：四个折叠摘要上限开成 `context` 旋钮。
//
// 三条口径一次钉住：
//   ① **默认值逐字不变**（30000 / 30000 / 49152 / 24576）——不传 = 今天的形状逐字节一致；
//   ② **装配期就校**：`context` 的未知子键与四个键的非安全正整数一律 `TypeError`（含 `fold-llm` 的
//      `summarizerBudgetMs`）；
//   ③ **传了就真生效**：极小 `maxPriorSummaryBytes` ⇒ `priorSummaryTruncated`；极小
//      `summarizerTimeoutMs` ⇒ `summarizer_timeout`；极小 `maxSummarizerInputBytes` ⇒ 整轮丢弃。
//
// 零真实 LLM：provider 侧全是假 chat。
import test from "node:test";
import assert from "node:assert/strict";

import { createAssemblyPort } from "../src/assembly.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";
const LONG_SUMMARY = `## 阶段\n${"完成初始化与骨架。".repeat(20)}`
  + "\n## 下一步\n已完成项禁止重做；继续收尾。";

function keepalive() {
  // 摘要器超时用的定时器是 unref 的：测试里必须另留一个 handle，否则事件循环可能提前空转退出。
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);
}

function createFakeProvider({ summaryText = LONG_SUMMARY, summaryChat } = {}) {
  const summaryRequests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    summaryRequests,
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
      if (summaryChat !== undefined) return summaryChat(request);
      return {
        content: [{ type: "text", text: summaryText }],
        stopReason: "end_turn",
        usage: { input_tokens: 900, output_tokens: 50 },
      };
    },
  };
  return provider;
}

/** 多轮折叠：每轮都产出一段足够长的历史，`keepRounds:0` ⇒ 每轮都折。 */
function runFolding(provider, context, extra = {}) {
  return runToolLoop({
    provider,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    maxRounds: 4,
    completion: false,
    wrapup: false,
    context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm", ...context },
    store: createMemoryTranscriptStore(),
    runId: `issue-469-knobs-${process.pid}`,
    ...extra,
  });
}

function assembleWithContext(context) {
  return createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1000 }) },
    provider: createFakeProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `issue-469-knobs-assembly-${process.pid}` },
    policy: { context },
  });
}

test("#469-B1 装配期：未知 context 子键报错（不再静默丢弃，#331 的病）", () => {
  for (const key of ["maxPriorSummaryByte", "summarizerTimeouts", "maxFoldedFactsByte"]) {
    assert.throws(
      () => assembleWithContext({ strategy: "fold-llm", [key]: 1024 }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /unknown assembly policy context option/u);
        assert.ok(error.message.includes(key), `报错必须点名那个键：${error.message}`);
        return true;
      },
    );
  }
  // 已知键（含四个新旋钮与既有键）放行。
  assert.doesNotThrow(() => assembleWithContext({
    strategy: "fold-llm",
    budgetTokens: 8000,
    keepRounds: 2,
    maxFoldedFactsBytes: 512,
    maxFoldedPayloadBytes: 4096,
    summarizerTimeoutMs: 30_000,
    summarizerBudgetMs: 30_000,
    maxSummarizerInputBytes: 49_152,
    maxPriorSummaryBytes: 24_576,
  }));
});

test("#469-B1 装配期：四个键的非法值一律 TypeError，文案照既有范式", () => {
  const keys = [
    "summarizerTimeoutMs",
    "summarizerBudgetMs",
    "maxSummarizerInputBytes",
    "maxPriorSummaryBytes",
  ];
  for (const key of keys) {
    for (const value of [0, -1, 1.5, "30000", null]) {
      assert.throws(
        () => assembleWithContext({ strategy: "fold-llm", [key]: value }),
        (error) => {
          assert.ok(error instanceof TypeError, `${key}=${String(value)} 必须是 TypeError`);
          assert.match(error.message, new RegExp(`${key} must be a positive integer`, "u"));
          return true;
        },
        `${key}=${String(value)} 应在装配期被拦下`,
      );
    }
  }
});

test("#469-B1 默认值逐字不变：不传四个键 ⇔ 显式传契约定下的默认值，请求体逐字节相同", async () => {
  const baseline = createFakeProvider();
  await runFolding(baseline, {});
  const explicit = createFakeProvider();
  await runFolding(explicit, {
    summarizerTimeoutMs: 30_000,
    summarizerBudgetMs: 30_000,
    maxSummarizerInputBytes: 48 * 1024,
    maxPriorSummaryBytes: 24 * 1024,
  });
  assert.ok(baseline.summaryRequests.length > 1, "前提：这条路径必须折叠了不止一次");
  assert.deepEqual(
    explicit.summaryRequests.map((request) => request.messages[0].content),
    baseline.summaryRequests.map((request) => request.messages[0].content),
    "显式传默认值必须与不传逐字节一致（否则「默认没变」是假的）",
  );
});

test("#469-B1 传了就真生效：maxPriorSummaryBytes 极小 ⇒ priorSummaryTruncated === true", async () => {
  const provider = createFakeProvider();
  const result = await runFolding(provider, { maxPriorSummaryBytes: 16 });
  const stats = (result.compactionStats ?? []).filter((stat) => stat.foldSummary !== undefined);
  assert.ok(stats.length > 1, "前提：至少折叠两次（第二次才有续写基底可截）");
  assert.ok(
    stats.some((stat) => stat.foldSummary.priorSummaryTruncated === true),
    `续写基底必须被截并留痕：${JSON.stringify(stats.map((stat) => stat.foldSummary))}`,
  );
  // 默认（24 KB）下同样这条路径**不得**标截断：证明旋钮不是恒真。
  const baseline = createFakeProvider();
  const baselineResult = await runFolding(baseline, {});
  const baselineStats = (baselineResult.compactionStats ?? [])
    .filter((stat) => stat.foldSummary !== undefined);
  assert.equal(
    baselineStats.some((stat) => stat.foldSummary.priorSummaryTruncated === true),
    false,
    "默认 24 KB 下不该出现 priorSummaryTruncated（否则这个断言是恒真的）",
  );
});

test("#469-B1 传了就真生效：summarizerTimeoutMs 极小 ⇒ summarizer_timeout / degradeKind=timeout", async () => {
  const release = keepalive();
  try {
    const provider = createFakeProvider({
      // 真 provider 的形状：挂住不回，直到被 signal / 死线打断。
      summaryChat: () => new Promise(() => {}),
    });
    const result = await runFolding(provider, { summarizerTimeoutMs: 25 });
    const stats = (result.compactionStats ?? []).filter((stat) => stat.foldSummary !== undefined);
    assert.ok(stats.length > 0, "前提：确实发生过折叠");
    assert.ok(
      stats.some((stat) => stat.foldSummary.degradeKind === "timeout"),
      `极小 summarizerTimeoutMs 必须走超时归因：${JSON.stringify(stats.map((stat) => stat.foldSummary))}`,
    );
    assert.equal(result.termination, undefined ?? result.termination, "保持可读：run 不得因摘要超时而中止");
  } finally {
    release();
  }
});

test("#469-B1 传了就真生效：maxSummarizerInputBytes 极小 ⇒ 按整轮从最旧侧丢弃", async () => {
  const provider = createFakeProvider();
  // 折叠输入得真的超过上限才谈得上「丢整轮」：这里把工具输出放大到 6 KB/轮。
  const bigToolOutput = async ({ id }) => `tool output for ${id} ${"z".repeat(6000)}`;
  const result = await runFolding(provider, { maxSummarizerInputBytes: 512 }, {
    executeTool: bigToolOutput,
  });
  const stats = (result.compactionStats ?? []).filter((stat) => stat.foldSummary !== undefined);
  assert.ok(stats.length > 0, "前提：确实发生过折叠");
  assert.ok(
    stats.some((stat) => Number(stat.foldSummary.droppedRounds ?? 0) > 0
      || stat.foldSummary.inputTruncated === true),
    `极小字节上限必须留下「整轮被丢」的痕迹：${JSON.stringify(stats.map((stat) => stat.foldSummary))}`,
  );
  // 同一形状不传旋钮 ⇒ 不得有丢弃痕迹（证明上一条不是恒真）。
  const baselineProvider = createFakeProvider();
  const baseline = await runFolding(baselineProvider, {}, { executeTool: bigToolOutput });
  const baselineStats = (baseline.compactionStats ?? [])
    .filter((stat) => stat.foldSummary !== undefined);
  assert.equal(
    baselineStats.some((stat) => Number(stat.foldSummary.droppedRounds ?? 0) > 0),
    false,
    "默认 48 KB 下 6 KB/轮的输入不该被丢（否则这个断言是恒真的）",
  );
});
