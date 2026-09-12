import test from "node:test";
import assert from "node:assert/strict";

import {
  createFoldLlmStrategy,
  SUMMARIZER_PROMPT_GUIDE,
} from "../../src/compact/fold-llm.js";
import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";

function conversation() {
  return [
    { role: "user", content: "initial request" },
    { role: "assistant", content: [{ type: "text", text: "phase one" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "phase two" }] },
    { role: "user", content: [{ type: "text", text: "continue again" }] },
    { role: "assistant", content: [{ type: "text", text: "phase three" }] },
  ];
}

test("folds old rounds through the injected summarizer and preserves the payload", async () => {
  const calls = [];
  const summary = [
    "## 阶段",
    "完成初始化。",
    "## 已改文件",
    "src/example.js",
    "## 已验证项",
    "node --test",
    "## 下一步",
    "已完成项禁止重做；继续收尾。",
    "## 主题词面包屑",
    "example, tests",
  ].join("\n");
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      calls.push(input);
      return summary;
    },
  });
  const messages = conversation();
  const result = await strategy.compact(messages, { keepRounds: 1 });

  assert.equal(strategy.name, "fold-llm");
  assert.deepEqual(calls[0].messages, messages.slice(1, 5));
  assert.deepEqual(calls[0].roundRange, { from: 1, to: 4 });
  assert.doesNotMatch(calls[0].promptGuide, /recall/i);
  assert.equal(calls[0].recoveryHint, "早期轮次已折叠；需要原文请重读文件或查看持久笔记；关键值应当已落盘");
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 4);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, new RegExp(summary));
  assert.match(result.messages[0].content[0].text, /早期轮次已折叠；需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
  assert.equal(result.tokensBefore, estimateMessageTokens(messages));
  assert.equal(result.tokensAfter, estimateMessageTokens(result.messages));
});

test("uses section priorities when enforcing the summary budget", async () => {
  const summary = [
    "## 阶段",
    "phase ".repeat(60),
    "## 已改文件",
    "files ".repeat(60),
    "## 主题词面包屑",
    "topics ".repeat(60),
    "## 已验证项",
    "verified ".repeat(60),
    "## 下一步",
    "next steps and 已完成项禁止重做 ".repeat(60),
  ].join("\n");
  const result = await createFoldLlmStrategy({
    summarizer: async () => summary,
    maxSummaryTokens: 1500,
  }).compact(conversation(), { keepRounds: 1 });
  const foldedSummary = result.messages[0].content[0].text;

  assert.match(foldedSummary, /## 已验证项/);
  assert.match(foldedSummary, /## 下一步/);
  assert.match(foldedSummary, /已完成项禁止重做/);
  assert.match(foldedSummary, /\[已修剪\]/);
  assert.ok(estimateTokens(foldedSummary) <= 1500);
});

test("token truncates an unsectioned summary and marks the truncation", async () => {
  const summary = "unsectioned summary ".repeat(200);
  const maxSummaryTokens = 30;
  const result = await createFoldLlmStrategy({
    summarizer: async () => summary,
    maxSummaryTokens,
  }).compact(conversation(), { keepRounds: 1 });

  assert.match(result.messages[0].content[0].text, /截断|修剪/);
  assert.ok(estimateTokens(result.messages[0].content[0].text) <= maxSummaryTokens);
});

test("publishes recovery guidance requirements without recall advertising", () => {
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 阶段/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已改文件/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已验证项/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 下一步/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已完成项禁止重做/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 主题词面包屑/);
  assert.doesNotMatch(SUMMARIZER_PROMPT_GUIDE, /recall/i);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /早期轮次已折叠；需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
});

test("includes an injected recovery hint in the LLM summary", async () => {
  const hint = "恢复提示：请查看 durable-notes.md";
  const result = await createFoldLlmStrategy({
    recoveryHint: hint,
    summarizer: async ({ promptGuide, recoveryHint }) => {
      assert.match(promptGuide, new RegExp(hint));
      assert.equal(recoveryHint, hint);
      return "## 阶段\n完成工作。";
    },
  }).compact(conversation(), { keepRounds: 1 });

  assert.match(result.messages[0].content[0].text, new RegExp(hint));
});

test("does not call the summarizer when every round is retained", async () => {
  let calls = 0;
  const messages = conversation();
  const result = await createFoldLlmStrategy({
    summarizer: async () => {
      calls += 1;
      return "unexpected";
    },
  }).compact(messages, { keepRounds: 10 });

  assert.equal(calls, 0);
  assert.equal(result.compacted, false);
  assert.deepEqual(result.foldedPayload, []);
  assert.deepEqual(result.messages, messages);
});
