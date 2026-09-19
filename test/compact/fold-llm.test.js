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
  assert.equal(calls[0].recoveryHint, "需要原文请重读文件或查看持久笔记；关键值应当已落盘");
  assert.deepEqual(result.foldedPayload, messages.slice(1, 5));
  assert.equal(result.foldedRounds, 4);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, new RegExp(summary));
  assert.match(result.messages[0].content[0].text, /需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
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
  const [llmPart] = foldedSummary.split("## 用户最新未解决输入");

  assert.match(foldedSummary, /## 已验证项/);
  assert.match(foldedSummary, /## 下一步/);
  assert.match(foldedSummary, /已完成项禁止重做/);
  assert.match(foldedSummary, /\[已修剪\]/);
  // LLM 摘要受 maxSummaryTokens 约束；机械保真层在其后追加（见 docs/design A2）。
  assert.ok(estimateTokens(llmPart) <= 1500);
  assert.match(foldedSummary, /^> continue again$/m);
});

test("token truncates an unsectioned summary and marks the truncation", async () => {
  const summary = "unsectioned summary ".repeat(200);
  const maxSummaryTokens = 30;
  const result = await createFoldLlmStrategy({
    summarizer: async () => summary,
    maxSummaryTokens,
  }).compact(conversation(), { keepRounds: 1 });
  const text = result.messages[0].content[0].text;
  const [llmPart] = text.split("## 用户最新未解决输入");

  assert.match(llmPart, /截断|修剪/);
  assert.ok(estimateTokens(llmPart) <= maxSummaryTokens);
  // 机械保真层在尺寸截断之后才追加，所以摘要预算削不掉它（A2 的关键行为）。
  assert.match(text, /^> continue again$/m);
});

test("publishes recovery guidance requirements without recall advertising", () => {
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 阶段/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已改文件/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 已验证项/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 下一步/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /已完成项禁止重做/);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /## 主题词面包屑/);
  assert.doesNotMatch(SUMMARIZER_PROMPT_GUIDE, /recall/i);
  assert.match(SUMMARIZER_PROMPT_GUIDE, /需要原文请重读文件或查看持久笔记；关键值应当已落盘/);
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

function anchorConversation() {
  return [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "git log -1" } }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "1ed3f35 fix src/compact/fold-llm.js:120 (#32) "
          + "https://git.erix.vip/eric/erix-llm-kit/commit/1ed3f35",
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "folded phase" }] },
    { role: "user", content: "取消旧方案，改做锚点索引" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "final request" },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
}

test("appends the mechanical fidelity layer after the LLM summary" + " (anchor index / verbatim user input / reverse signal)", async () => {
  const messages = anchorConversation();
  const paraphrased = [
    "## 阶段",
    "早期工作已完成（提交了某个 commit）。",
    "## 下一步",
    "已完成项禁止重做；继续收尾。",
  ].join("\n");
  const result = await createFoldLlmStrategy({
    summarizer: async () => paraphrased,
  }).compact(messages, { keepRounds: 2 });
  const text = result.messages[0].content[0].text;

  // LLM 复述必然丢失精确值（SHA → "某个 commit"），机械保真层把原文值兜回来。
  assert.match(text, /提交了某个 commit/);
  assert.match(text, /## 锚点索引（机械抽取，未经 LLM 改写）/);
  assert.match(text, /^shas: 1ed3f35$/m);
  assert.match(text, /^paths: src\/compact\/fold-llm\.js:120$/m);
  assert.match(text, /^issues: #32$/m);
  assert.match(text, /^urls: https:\/\/git\.erix\.vip\/eric\/erix-llm-kit\/commit\/1ed3f35$/m);
  // 逐字引用被折轮次里最后一条真实 user 消息，并标注反向信号。
  assert.match(text, /## 用户最新未解决输入（逐字引用，未经 LLM 改写）/);
  assert.match(text, /⚠ 用户曾发出中止\/撤销信号（命中：取消）/);
  assert.match(text, /^> 取消旧方案，改做锚点索引$/m);
  // 保真层整体追加在 LLM 摘要之后，锚点节位于最末。
  assert.ok(text.indexOf(paraphrased) < text.indexOf("## 用户最新未解决输入"));
  assert.ok(text.lastIndexOf("## 锚点索引") > text.indexOf("## 用户最新未解决输入"));
  assert.ok(text.trimEnd().endsWith("https://git.erix.vip/eric/erix-llm-kit/commit/1ed3f35"));
  // 引用的是"被折轮次里"最后一条真实 user 消息；仍在上下文里的最新 user 输入不重复注入。
  assert.doesNotMatch(text, /^> final request$/m);
  assert.equal(result.foldedRounds, 4);
  assert.deepEqual(result.messages.at(-1), messages.at(-1));
});

test("keeps the mechanical fidelity layer when the summary budget is tiny", async () => {
  const result = await createFoldLlmStrategy({
    summarizer: async () => "unsectioned summary ".repeat(200),
    maxSummaryTokens: 40,
  }).compact(anchorConversation(), { keepRounds: 2 });
  const text = result.messages[0].content[0].text;
  const [llmPart] = text.split("## 用户最新未解决输入");

  assert.ok(estimateTokens(llmPart) <= 40);
  assert.match(llmPart, /截断|修剪/);
  assert.match(text, /^shas: 1ed3f35$/m);
  assert.match(text, /^> 取消旧方案，改做锚点索引$/m);
});

test("adds no mechanical section when the folded payload has nothing to extract", async () => {
  const messages = [
    { role: "user", content: "initial request" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "echo hi" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "plain output" }],
    },
    { role: "assistant", content: [{ type: "text", text: "no precise identifiers" }] },
    { role: "assistant", content: [{ type: "text", text: "recent" }] },
  ];
  const result = await createFoldLlmStrategy({
    summarizer: async () => "## 下一步\n已完成项禁止重做",
  }).compact(messages, { keepRounds: 1 });
  const text = result.messages[0].content[0].text;

  assert.equal(
    text,
    "## 下一步\n已完成项禁止重做\n## 恢复提示\n需要原文请重读文件或查看持久笔记；关键值应当已落盘",
  );
  assert.doesNotMatch(text, /锚点索引|用户最新未解决输入|中止\/撤销/u);
});
