// issue #469：宿主 erix-station 2026-10-26 的裁决（①②③）——显式关思考 / 单条 30 s 死线
// / 输入只喂被折轮次 + 上一份摘要（48 KB 整轮、24 KB 头部截）。
// 全部零真实 LLM：provider 侧假 chat，策略侧假 summarizer。
import test from "node:test";
import assert from "node:assert/strict";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  createProviderSummarizer,
  summarizerThinkingMode,
} from "../../src/compact/provider-summarizer.js";
import { createCompactionStat } from "../../src/compact/pipeline.js";

const SUMMARY = [
  "## 阶段", "完成初始化。",
  "## 已改文件", "src/example.js",
  "## 已验证项", "node --test",
  "## 下一步", "已完成项禁止重做；继续收尾。",
  "## 主题词面包屑", "example, tests",
].join("\n");

function bulkyRound(label, size = 400) {
  return [
    { role: "user", content: `${label}-USER ${"x".repeat(size)}` },
    { role: "assistant", content: [{ type: "text", text: `${label}-ASSISTANT ${"y".repeat(size)}` }] },
  ];
}

// 4 轮：keepRounds=1 ⇒ 折走前 3 轮，保留最后 1 轮（里面放活上下文标记）。
function conversation() {
  return [
    ...bulkyRound("R1"),
    ...bulkyRound("R2"),
    ...bulkyRound("R3"),
    { role: "user", content: [{ type: "text", text: "RETAINED-LIVE-MARKER" }] },
    { role: "assistant", content: [{ type: "text", text: "retained answer" }] },
  ];
}

function keepalive() {
  // 摘要器超时用的定时器是 unref 的：测试里必须另留一个 handle，否则事件循环可能提前空转退出。
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);
}

test("#469-① 显式关思考：三个键同时发，不靠模型默认值", async () => {
  const seen = [];
  const summarizer = createProviderSummarizer({
    chat: async (request) => {
      seen.push(request);
      return { content: [{ type: "text", text: SUMMARY }] };
    },
  });
  await summarizer({ messages: bulkyRound("R1") });
  const request = seen[0];
  assert.equal(request.reasoning_effort, "none");
  assert.equal(request.enable_thinking, false);
  assert.deepEqual(request.chat_template_kwargs, { thinking: false });
});

test("#469-① thinkingMode:inherit 退回旧形状（上游 provider 不认这些字段时）", async () => {
  const seen = [];
  const summarizer = createProviderSummarizer({
    thinkingMode: "inherit",
    chat: async (request) => {
      seen.push(request);
      return { content: [{ type: "text", text: SUMMARY }] };
    },
  });
  await summarizer({ messages: bulkyRound("R1") });
  assert.equal("enable_thinking" in seen[0], false);
  assert.equal("chat_template_kwargs" in seen[0], false);
});

test("#469-② 每次调用可用「剩余预算」覆盖本实例默认超时", async () => {
  const release = keepalive();
  try {
    const summarizer = createProviderSummarizer({
      chat: () => new Promise(() => {}),
      summarizerTimeoutMs: 30_000,
    });
    const startedAt = Date.now();
    const error = await summarizer({ messages: bulkyRound("R1"), timeoutMs: 20 }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error, "按剩余预算必须按时失败");
    assert.equal(error.code, "summarizer_timeout");
    assert.ok(Date.now() - startedAt < 5_000, "用的是 20 ms 这一发，不是 30 s 默认值");
  } finally {
    release();
  }
});

test("#469-② 预算耗尽 ⇒ 超窗也不再重试，原因记 budgetExhausted", async () => {
  let calls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      calls += 1;
      throw new Error(
        "400 message = input length `16584` is longer than configured context length `16384`.",
      );
    },
  });
  const result = await strategy.compact(conversation(), {
    keepRounds: 1,
    summarizerBudgetMs: 1,
  });
  assert.equal(calls, 1, "30 s 是整条步骤的硬上限，不是每次尝试的上限");
  assert.equal(result.foldSummary.source, "statistical");
  assert.equal(result.foldSummary.degradeKind, "context_window_exceeded");
  assert.equal(result.foldSummary.budgetExhausted, true);
  // `attempts` 只在真的试了不止一次时进账（与「无事发生 ⇒ 无键」同口径）。
  assert.equal("attempts" in result.foldSummary, false);
});

test("#469-③ 上一份折叠摘要是续写基底：第二次折叠拿得到第一次的摘要", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return `${SUMMARY}`;
    },
  });
  await strategy.compact(conversation(), { keepRounds: 1 });
  await strategy.compact(conversation(), { keepRounds: 1 });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].priorSummary, undefined, "第一次折叠没有上一份");
  assert.ok(typeof seen[1].priorSummary === "string" && seen[1].priorSummary !== "");
  assert.match(seen[1].priorSummary, /## 阶段/u);
  assert.equal(seen[1].priorSummary, seen[1].priorSummary.trim());
});

test("#469-③ 续写基底 24 KB 从头部截：保留最近部分并留痕", async () => {
  const seen = [];
  const text = `FIRST-BYTES-ONLY${"m".repeat(30_000)}TAIL-MARKER-END`; // 30 KB
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return SUMMARY;
    },
  });
  const result = await strategy.compact(conversation(), {
    keepRounds: 1,
    previousSummary: text,
  });
  const prior = seen[0].priorSummary;
  assert.ok(Buffer.byteLength(prior, "utf8") <= 24 * 1024, `24 KB 硬上限，实得 ${Buffer.byteLength(prior, "utf8")}`);
  assert.match(prior, /头部已截断/u, "截过就要说");
  assert.ok(prior.endsWith("TAIL-MARKER-END"), "保留的是最近部分（尾部）");
  assert.ok(!prior.includes("FIRST-BYTES-ONLY"), "被截掉的正是头部");
  assert.equal(result.foldSummary.priorSummaryTruncated, true);
  assert.ok(result.foldSummary.priorSummaryBytes > 24 * 1024);
});

test("#469-③ 只喂被折走的轮次：未折走的活上下文不进摘要请求", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return SUMMARY;
    },
  });
  // `groupIntoRounds` 的「轮」= 单条消息（除 tool_use/result 对）；keepRounds:2 才把
  // 最后那条活 user 消息 + 它的回答一起留在上下文里。
  await strategy.compact(conversation(), { keepRounds: 2 });
  const serialized = JSON.stringify(seen[0].messages);
  assert.ok(serialized.includes("R2-USER"), "被折走的最旧轮次要喂进去");
  assert.ok(!serialized.includes("R1-USER"), "head（首条真 user + system）不是折叠对象，不喂");
  assert.ok(!serialized.includes("RETAINED-LIVE-MARKER"), "活上下文喂进去就是重复付费 + 诱导复述");
});

test("#469-③ 48 KB 窗口字节帽：按整轮从旧到新截，不切单轮中部", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      return SUMMARY;
    },
  });
  const result = await strategy.compact(conversation(), {
    keepRounds: 1,
    maxSummarizerInputBytes: 1_200,
  });
  const messages = seen[0].messages;
  const note = messages[0];
  assert.match(
    String(note.content?.[0]?.text ?? ""),
    /前 \d+ 轮最旧消息已省略/u,
    "字节帽裁掉的是整轮，省略注要说是哪一层裁的",
  );
  const kept = messages.slice(1);
  // 整轮不切：留下的第一条必须是某一轮的起点（真 user 消息），不能是 assistant 半截。
  assert.equal(kept[0].role, "user");
  assert.ok(String(kept[0].content).includes("-USER"));
  // 被丢的轮是**最旧**的：R1 一定不在，R3（最新被折轮）一定在。
  const serialized = JSON.stringify(kept);
  assert.ok(!serialized.includes("R1-USER"), "从旧的一侧截");
  assert.ok(serialized.includes("R3-USER"), "最新的被折轮必须留");
  assert.ok(result.foldSummary.droppedRounds > 0);
  assert.equal(result.foldSummary.source, "llm");
});

test("#469-③④ 新的诊断键只在真有事时进账（无事发生 ⇒ 无键）", () => {
  const stat = createCompactionStat({
    compacted: true,
    foldSummary: {
      priorSummaryTruncated: true,
      priorSummaryBytes: 30_000,
      droppedRounds: 2,
      attempts: 2,
      budgetExhausted: true,
    },
  });
  assert.deepEqual(stat.foldSummary, {
    priorSummaryTruncated: true,
    priorSummaryBytes: 30_000,
    droppedRounds: 2,
    attempts: 2,
    budgetExhausted: true,
  });
  assert.equal("foldSummary" in createCompactionStat({ compacted: true, foldSummary: {} }), false);
});

test("#469-① 关思考的形态按协议选：Anthropic 不认 vLLM 那两个键（否则每次折叠都 400）", () => {
  assert.equal(summarizerThinkingMode("anthropic"), "inherit");
  assert.equal(summarizerThinkingMode("openai"), "off");
  assert.equal(summarizerThinkingMode(undefined), "off");
  // 反向钉：Anthropic 形态的请求体里**不得**出现 vLLM 专用键（它的 `thinking` 是对象，不认这两格）。
  const summarizer = createProviderSummarizer({
    thinkingMode: summarizerThinkingMode("anthropic"),
    chat: async (request) => {
      assert.equal("enable_thinking" in request, false);
      assert.equal("chat_template_kwargs" in request, false);
      return { content: [{ type: "text", text: "## 阶段\nok" }] };
    },
  });
  return summarizer({ messages: bulkyRound("R1") }).then((summary) => {
    assert.equal(summary, "## 阶段\nok");
  });
});
