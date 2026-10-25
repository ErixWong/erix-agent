// issue #469：折叠摘要调用的四条缺口 —— 限时 / 输入有界 / 看结果状态 / 降级原因不隐身。
// 全部零真实 LLM：provider 侧用假 chat，策略侧用假 summarizer。
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFoldLlmStrategy,
  classifyFoldDegradeKind,
} from "../../src/compact/fold-llm.js";
import {
  createProviderSummarizer,
  serializeFoldedMessages,
} from "../../src/compact/provider-summarizer.js";
import { createCompactionStat } from "../../src/compact/pipeline.js";

// 足够长的早期消息：让折叠输入进到「还能再裁一半」的量级（重试下限 256 token）。
const BULK = "alpha ".repeat(2000);

function conversation(bulky = false) {
  return [
    { role: "user", content: bulky ? BULK : "initial request" },
    { role: "assistant", content: [{ type: "text", text: bulky ? BULK : "phase one" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
    { role: "user", content: [{ type: "text", text: "continue again" }] },
    { role: "assistant", content: [{ type: "text", text: "phase three" }] },
  ];
}

const SUMMARY = [
  "## 阶段", "完成初始化。",
  "## 已改文件", "src/example.js",
  "## 已验证项", "node --test",
  "## 下一步", "已完成项禁止重做；继续收尾。",
  "## 主题词面包屑", "example, tests",
].join("\n");

function keepalive() {
  // 摘要器超时用的定时器是 unref 的：测试里必须另留一个 handle，否则事件循环可能提前空转退出。
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);
}

test("#469-① 摘要专属超时：只中断这一发，不连坐 run；原因分类为 timeout", async () => {
  const parent = new AbortController();
  const release = keepalive();
  try {
    const summarizer = createProviderSummarizer({
      chat: () => new Promise(() => {}), // 永不返回
      summarizerTimeoutMs: 25,
      signal: parent.signal,
    });
    const error = await summarizer({ messages: conversation() }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error, "挂起的摘要调用必须按时失败");
    assert.equal(error.code, "summarizer_timeout");
    assert.equal(classifyFoldDegradeKind(error), "timeout");
    // 关键：run 的 signal 没被这条超时牵连（否则一次摘要超时 = 整轮任务死）。
    assert.equal(parent.signal.aborted, false);
  } finally {
    release();
  }
});

test("#469-①④ 超时降级：折叠照常完成，degradeKind 落进 foldSummary", async () => {
  let calls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      calls += 1;
      const error = new Error("fold summarizer timed out after 25ms");
      error.code = "summarizer_timeout";
      throw error;
    },
  });
  const result = await strategy.compact(conversation(), { keepRounds: 1 });
  assert.equal(result.compacted, true, "摘要失败不得让折叠本身失败");
  assert.equal(calls, 1, "超时不是超窗，不做重试");
  assert.equal(result.foldSummary.source, "statistical");
  assert.equal(result.foldSummary.degradeKind, "timeout");
  assert.match(result.foldSummary.degradeReason, /timed out/u);
  assert.match(result.messages[0].content.map((b) => b.text ?? "").join(""), /降级为统计摘要/u);
});

test("#469-② 超窗（网关 400）：带更短的输入重试一次并成功，不再静默降级", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      if (seen.length === 1) {
        throw new Error(
          "400 message = input length `16584` is longer than configured context length `16384`.",
        );
      }
      return SUMMARY;
    },
  });
  const result = await strategy.compact(conversation(true), { keepRounds: 1 });
  assert.equal(seen.length, 2, "超窗必须重试一次");
  // 裁掉整条消息时，开头会多一条「已省略」注占住一个位置 ⇒ **消息条数可以不变**，
  // 真正变小的是序列化后的输入。拿条数当断言会得到假阳性。
  const inputChars = seen.map((input) => JSON.stringify(input.messages).length);
  assert.ok(
    inputChars[1] < inputChars[0],
    `重试输入必须更短：${inputChars[0]} → ${inputChars[1]} 字符`,
  );
  assert.equal(result.foldSummary.source, "llm", "重试成功 ⇒ 不是降级");
  assert.equal(result.foldSummary.degradeKind, undefined);
  assert.equal(result.foldSummary.inputTruncated, true);
  assert.ok(result.foldSummary.droppedMessages > 0);
});

test("#469-③④ 结果状态入账：finish_reason 与 token 进 compactionStats.foldSummary", async () => {
  const metas = [];
  const summarizer = createProviderSummarizer({
    chat: async () => ({
      content: [{ type: "text", text: "## 阶段\n截断在半截" }],
      usage: { input_tokens: 16584, output_tokens: 800 },
      finish_reason: "length",
    }),
    onMeta: (meta) => metas.push(meta),
  });
  const summary = await summarizer({ messages: conversation() });
  assert.equal(summary, "## 阶段\n截断在半截");
  assert.equal(metas.length, 1);
  assert.equal(metas[0].finishReason, "length");
  assert.equal(metas[0].inputTokens, 16584);
  assert.equal(metas[0].outputTokens, 800);

  const stat = createCompactionStat({
    compacted: true,
    foldSummary: { ...metas[0], degradeKind: "timeout", text: "不该进账的正文" },
  });
  assert.deepEqual(stat.foldSummary, {
    degradeKind: "timeout",
    finishReason: "length",
    inputTokens: 16584,
    outputTokens: 800,
  });
  // 无事发生 ⇒ 无键：既有读取形状逐字不变。
  assert.equal("foldSummary" in createCompactionStat({ compacted: true }), false);
  assert.equal("foldSummary" in createCompactionStat({ compacted: true, foldSummary: {} }), false);
});

test("#469-② 输入上限：从最旧侧整条丢弃并留省略注；不传则逐字不变", async () => {
  const messages = [
    { role: "user", content: "OLDEST-UNIQUE" },
    { role: "assistant", content: "middle message body" },
    { role: "user", content: "NEWEST-UNIQUE" },
  ];
  const unbounded = serializeFoldedMessages(messages, { from: 1, to: 3 });
  assert.ok(unbounded.includes("OLDEST-UNIQUE") && unbounded.includes("NEWEST-UNIQUE"));
  assert.ok(!unbounded.includes("已省略"));

  const bounded = serializeFoldedMessages(messages, { from: 1, to: 3 }, { maxTokens: 20 });
  assert.ok(!bounded.includes("OLDEST-UNIQUE"), "最旧一条应被丢弃");
  assert.ok(bounded.includes("NEWEST-UNIQUE"), "尾部必须保留（最近性）");
  assert.match(bounded, /前 \d+ 条最旧消息已省略/u);
});
