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
import {
  FOLD_SUMMARIZER_CAP_NAMES,
  CONTEXT_OPTION_NAMES,
  contextOptionNameSelfCheck,
  isSummarizerKnobKey,
} from "../src/assembly-validators.js";
import { runDirect } from "./helpers/run-direct.js";
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
  // #498 S3（`tuning` A5）：扁平 `maxTokens` 已退役（家 = `config.tuning.maxTokens`）。本函数是这一族
  // 格子的**唯一** run 装配点，所以「run 级输出预算」在夹具里收成一个 `tuning` 入参，由它并进
  // **同一个** `config` 容器（与 `test/helpers/run-direct.js` 的 `withSeed` 同一条纪律：同一个对象
  // 字面量里不许有两个 `config` 键，后者会静默胜）。
  const { tuning, ...rest } = extra;
  return runDirect({
    provider,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    maxRounds: 4,
    completion: false,
    wrapup: false,
    config: {
      folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm", ...context } },
      ...(tuning === undefined ? {} : { tuning }),
    },
    store: createMemoryTranscriptStore(),
    runId: `issue-469-knobs-${process.pid}`,
    ...rest,
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
  // issue #493：强校验只对**旋钮家族**的拼错生效（`summar*` / `maxPriorSummary*`）。
  for (const key of ["maxPriorSummaryByte", "summarizerTimeouts", "summarizeBudgetMs", "maxSummarizerInputByte"]) {
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

test("#493 业务元数据键不再被打成 TypeError：toolContext/expert/user/session/requestId 与任意未知键都放行", () => {
  const events = [];
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1000 }) },
    provider: createFakeProvider(),
    tools: { definitions: [], async executeTool() {} },
    store: createMemoryTranscriptStore(),
    session: { id: `493-metadata-${process.pid}` },
    emit: (type, event) => events.push({ type, event }),
    policy: {
      context: {
        budgetTokens: 8000,
        strategy: "fold-llm",
        // 引擎自己在 budget.js 里读的五个键（白名单漏列过一次，导致装配期直接 TypeError）。
        toolContext: { repo: "demo" },
        expert: "backend",
        user: "erix",
        session: "s-1",
        requestId: "req-1",
        // 纯业务字段：契约允许放 context，不得抛。
        workspaceName: "fde-station",
      },
    },
  });
  assert.ok(port !== undefined);
  const warning = events.find((entry) => entry.type === "context_unknown_option");
  assert.ok(warning, "未知业务键必须至少留下一条事件（不静默）");
  assert.deepEqual(warning.event.keys, ["workspaceName"], "只报真正未知的那个");
});

test("#493 maxSummaryTokens 也是 context 旋钮：非法值装配期抛，传了就同时约束摘要预算与那一发的 maxTokens", async () => {
  for (const value of [0, -1, 1.5, "1400", null]) {
    assert.throws(
      () => assembleWithContext({ strategy: "fold-llm", maxSummaryTokens: value }),
      (error) => error instanceof TypeError
        && /maxSummaryTokens must be a positive integer/u.test(error.message),
    );
  }
  const seen = [];
  const provider = createFakeProvider({
    summaryChat: (request) => {
      seen.push(request);
      return { content: [{ type: "text", text: "## 阶段\nok" }], stopReason: "end_turn" };
    },
  });
  await runFolding(provider, { maxSummaryTokens: 200 }, { tuning: { maxTokens: 32_768 } });
  assert.ok(seen.length > 0, "前提：摘要那一发真的发出去了");
  for (const request of seen) {
    assert.equal(request.maxTokens, 200,
      `摘要那一发的 maxTokens 必须与摘要预算取小对齐（实测 ${String(request.maxTokens)}）`);
  }
  // 不传旋钮 ⇒ 默认 1400（不再原样继承 run 的 32768）。
  const fallback = [];
  const provider2 = createFakeProvider({
    summaryChat: (request) => {
      fallback.push(request);
      return { content: [{ type: "text", text: "## 阶段\nok" }], stopReason: "end_turn" };
    },
  });
  await runFolding(provider2, {}, { tuning: { maxTokens: 32_768 } });
  for (const request of fallback) {
    assert.equal(request.maxTokens, 1_400, "默认必须落在摘要预算上，而不是 run 的 32768");
  }
});

test("#493 复核：每个旋钮都必须同时在 context 白名单里（单条顶五条，别靠人记两份名单）", () => {
  assert.deepEqual(contextOptionNameSelfCheck(), [],
    "FOLD_SUMMARIZER_CAP_NAMES 里有键不在 CONTEXT_OPTION_NAMES ⇒ 宿主给对值也会被判未知键");
  for (const name of FOLD_SUMMARIZER_CAP_NAMES) {
    assert.ok(CONTEXT_OPTION_NAMES.includes(name), `${name} 必须在 context 白名单里`);
  }
});

test("#493 家族判定只认「旋钮名手滑」：summaryStyle / summarizerNote 这类业务键不得被当成旋钮", () => {
  // 上游现场实测过：旧的 /summar/i 判据把它们判成旋钮 ⇒ 等于悄悄立了「context 里不许有含 summar 的键」。
  for (const key of ["summaryStyle", "summarizerNote", "summary", "summarizationMode"]) {
    assert.equal(isSummarizerKnobKey(key), false, `${key} 不该被当成旋钮`);
    assert.doesNotThrow(() => assembleWithContext({ strategy: "fold-llm", [key]: "x" }));
  }
  // 真正的手滑仍必须被认出。
  for (const key of ["maxPriorSummaryByte", "summarizerTimeouts", "summarizeBudgetMs", "maxSummarizerInputByte"]) {
    assert.equal(isSummarizerKnobKey(key), true, `${key} 是旋钮名手滑，必须抛`);
  }
});

test("#493 maxSummaryTokens 在装配口真的可用：给对值不再被当成未知键", () => {
  assert.doesNotThrow(() => assembleWithContext({ strategy: "fold-llm", maxSummaryTokens: 900 }));
});
