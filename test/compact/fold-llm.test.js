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
  assert.deepEqual(calls, [{
    messages: messages.slice(1, 5),
    roundRange: { from: 1, to: 4 },
  }]);
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 4);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.equal(result.messages[0].content[0].type, "text");
  assert.equal(result.messages[0].content[0].text, summary);
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

  assert.match(result.messages[0].content[0].text, /截断/);
  assert.ok(estimateTokens(result.messages[0].content[0].text) <= maxSummaryTokens);
});

test("publishes the recall trace and guidance requirements in the prompt guide", () => {
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 阶段/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已改文件/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已验证项/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 下一步/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已完成项禁止重做/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 主题词面包屑/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已于第 X 轮 recall 过 '<pattern>'（结论：…）/);
  assert.match(
    SUMMARIZER_PROMPT_GUIDE,
    /早期轮次已折叠，可用 recall\(pattern: "关键词"\) 搜回细节/,
  );
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
