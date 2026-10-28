// issue #469 宿主裁决 A（2026-10-26）：续写基底按「账本/会话作用域」跨 resume 播种。
//
// 四条实施条件逐条钉：
//   ① 取源走 `pickCoveringFoldAlternative`（不只 `foldedSummary` 事实行，`foldedFacts` 策略替代物也算；
//      嵌套 `foldedRoundRange.{from,to}` 与平铺 `{from,to}` 两种形状都在它里面收）；
//   ② `compactionStats[].foldSummary.priorSummaryOrigin` = `"ledger" | "in-run"`，无基底不写键；
//   ③ 优先级 显式调用参数 > 策略构造参数 > in-run 闭包 > 账本播种（账本最后）；
//   ④ `foldSummaryFingerprint` 必须纳入 `priorSummary`（否则播进去的基底会被复用逻辑无声忽略）。
//
// 零真实 LLM：provider 侧全是假 chat。
import test from "node:test";
import assert from "node:assert/strict";

import { createFoldLlmStrategy } from "../src/compact/fold-llm.js";
import { foldSummaryFingerprint } from "../src/compact/fold-summary-journal.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";
const SEED_SUMMARY = "## 阶段\nSUMMARY_SEED_469 已折到第 2 轮。";
const PRIOR_HEADER = "【上一份折叠摘要（续写基底，只作脉络，不要重述）】";

function bulkyRound(label, size = 400) {
  return [
    { role: "user", content: `${label}-USER ${"x".repeat(size)}` },
    { role: "assistant", content: [{ type: "text", text: `${label}-ASSISTANT ${"y".repeat(size)}` }] },
  ];
}

function conversation() {
  return [...bulkyRound("R1"), ...bulkyRound("R2"), ...bulkyRound("R3")];
}

function textOf(message) {
  // 摘要器请求的 content 是**字符串**（provider-summarizer 拼好的那一段），
  // 主模型请求才是块数组 —— 两种形状都要收，否则会静默读到空串。
  if (typeof message?.content === "string") return message.content;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n\n");
}

test("#469-A ① 账本播种：第一次折叠就带上基底，且 origin=ledger", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return "## 阶段\nnew summary";
    },
    ledgerPreviousSummary: () => SEED_SUMMARY,
  });
  const result = await strategy.compact(conversation(), { keepRounds: 1 });
  assert.equal(seen.length, 1, "前提：确实调了一次摘要器");
  assert.match(String(seen[0].priorSummary), /SUMMARY_SEED_469/u, "resume 后首次折叠必须带基底");
  assert.equal(result.foldSummary.priorSummaryOrigin, "ledger");
});

test("#469-A ②③ 优先级：显式参数 > in-run 闭包 > 账本；无基底不写 origin 键", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return "## 阶段\nsummary";
    },
    ledgerPreviousSummary: () => SEED_SUMMARY,
  });
  // 显式调用参数最优先（即便账本有货）。
  await strategy.compact(conversation(), { keepRounds: 1, previousSummary: "EXPLICIT_BASE" });
  assert.match(String(seen[0].priorSummary), /EXPLICIT_BASE/u);

  // 不给显式参数：in-run 闭包（上一次真喂出去的那份）接管，账本不再参与。
  await strategy.compact(conversation(), { keepRounds: 1 });
  assert.match(String(seen[1].priorSummary), /## 阶段\nsummary/u, "第二次折叠必须用 in-run 那份");
  assert.doesNotMatch(String(seen[1].priorSummary), /SUMMARY_SEED_469/u, "账本不得盖掉 in-run");

  // 完全没有基底（新实例、无账本播种）⇒ 不得出现 origin 键。
  const bare = createFoldLlmStrategy({ summarizer: async () => "## 阶段\nplain" });
  const bareResult = await bare.compact(conversation(), { keepRounds: 1 });
  assert.equal("priorSummaryOrigin" in bareResult.foldSummary, false);
  assert.equal("priorSummaryBytes" in bareResult.foldSummary, false);
});

test("#469-A ④ 复用键纳入 priorSummary：基底不同 ⇒ 键不同（否则播进去会被无声忽略）", () => {
  const input = { messages: [{ role: "user", content: "x" }], roundRange: { from: 1, to: 2 } };
  const base = foldSummaryFingerprint(input);
  assert.equal(foldSummaryFingerprint({ ...input, priorSummary: "" }), base, "空串等同于没有");
  assert.equal(foldSummaryFingerprint({ ...input, priorSummary: undefined }), base, "未传等同于没有");
  assert.notEqual(
    foldSummaryFingerprint({ ...input, priorSummary: "BASE_A" }),
    base,
    "带基底必须换键（否则复用会把基底当成无关字段跳过）",
  );
  assert.notEqual(
    foldSummaryFingerprint({ ...input, priorSummary: "BASE_A" }),
    foldSummaryFingerprint({ ...input, priorSummary: "BASE_B" }),
    "不同基底必须是不同的键",
  );
});

function createProvider({ summaryText = SEED_SUMMARY } = {}) {
  const summaryRequests = [];
  const mainRequests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    summaryRequests,
    mainRequests,
    async chat(request) {
      const isSummary = typeof request?.system === "string"
        && request.system.includes(SUMMARY_SYSTEM);
      if (isSummary) {
        summaryRequests.push(request);
        return {
          content: [{ type: "text", text: summaryText }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      // 第一步先要工具（否则单轮就结束、上下文根本长不到触发折叠）。
      const wantTool = mainRequests.length === 1;
      return {
        content: wantTool
          ? [{ type: "tool_use", id: "work-1", name: "work", input: { path: "src/a.js" } }]
          : [{ type: "text", text: "收尾结论" }],
        stopReason: wantTool ? "tool_use" : "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
  return provider;
}

test("#469-A 端到端：resume 出来的 run 第一次折叠带账本基底（不是从零重建）", async () => {
  const runId = `469a-resume-seed-${process.pid}`;
  const store = createMemoryTranscriptStore();
  const first = createProvider();
  await runDirect({
    provider: first,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    maxRounds: 3,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" } }, run: { completion: false } },
    store,
    runId,
  });
  const records = await store.load(runId);
  assert.ok(
    records.some((record) => record?.foldedSummary !== undefined
      || record?.foldedFacts !== undefined),
    "前提：账本里必须有一份折叠事实可供播种",
  );

  const resumed = createProvider();
  const result = await runToolLoop({
    provider: resumed,
    // #498 S3 A9：`task` 的扁平写法已退役，并进**同一个** `config` 容器（下面那行 folding）。
    // #498 S3 A19：`resume` 同样退役（家 `config.run.resume`），并进同一个容器。
    store,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    config: {
      // #498 S3 A21：`maxRounds` 退役扁平写法（家 `config.run.maxRounds`），并进同一棵 `run` 子树。
      // #530：`reflection` 也退役了扁平写法（家 `config.run.reflection`），同样并进这棵 `run` 子树。
      run: { resume: true, runId, maxRounds: 3, completion: false, reflection: false },
      metadata: { task: "继续" },
      folding: { context: { budgetTokens: 300, keepRounds: 1, strategy: "fold-llm" } },
    },
  });

  const stats = (result.compactionStats ?? []).filter((stat) => stat.foldSummary !== undefined);
  assert.ok(stats.length > 0, "前提：resume 出来的 run 必须真的折叠过");
  const ledgerSeeded = stats.filter((stat) => stat.foldSummary.priorSummaryOrigin === "ledger");
  assert.ok(ledgerSeeded.length > 0,
    `resume 后必须有一格折叠的基底来自账本：${JSON.stringify(stats.map((stat) => stat.foldSummary))}`);
  assert.ok(Number(ledgerSeeded[0].foldSummary.priorSummaryBytes ?? 0) > 0, "基底必须非空");
  // 基底必须真的进了**摘要器入参**；但如果这一折命中了账本复用（键里已含基底），
  // provider 根本不会被调用（`summaryRequests` 为空）——两条都算达成，分别断言。
  if (resumed.summaryRequests.length > 0) {
    assert.ok(
      resumed.summaryRequests.some((request) => textOf(request.messages[0]).includes(PRIOR_HEADER)),
      "摘要器入参里必须真的有「续写基底」那一节（priorSummary 非空）",
    );
  } else {
    assert.equal(ledgerSeeded[0].foldSummary.source, "llm", "没有调用 ⇒ 必须是复用命中那份摘要");
  }
});
