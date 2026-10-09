import test from "node:test";
import assert from "node:assert/strict";

import {
  createProviderSummarizer,
  serializeFoldedMessages,
} from "../../src/compact/provider-summarizer.js";
import { SUMMARIZER_PROMPT_GUIDE } from "../../src/compact/fold-llm.js";

test("serializeFoldedMessages renders roles, round range, tool calls, and results", () => {
  const text = serializeFoldedMessages([
    { role: "user", content: "write the report" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan first" },
        { type: "text", text: "on it" },
        { type: "tool_use", id: "t1", name: "writeFile", input: { path: "a.md" } },
        { type: "image", source: { data: "xxx" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "written" }] }],
    },
    { role: "assistant", content: [] },
  ], { from: 3, to: 7 });

  assert.match(text, /【被折叠的轮次】第 3 轮 - 第 7 轮/u);
  assert.match(text, /\[user\]\nwrite the report/u);
  assert.match(text, /plan first/u);
  assert.match(text, /\[tool_use writeFile\] \{"path":"a\.md"\}/u);
  assert.match(text, /\[tool_result\] written/u);
  assert.match(text, /\[image\]/u);
  assert.match(text, /（空）/u);
  assert.match(serializeFoldedMessages([], undefined), /【被折叠的轮次】（未知）/u);
});

test("createProviderSummarizer sends one tool-free completion and returns its text", async () => {
  const requests = [];
  const usages = [];
  const summarizer = createProviderSummarizer({
    chat: async (request) => {
      requests.push(request);
      return {
        content: [{ type: "text", text: "\n ## 阶段\n summary \n" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
    onUsage: (usage) => usages.push(usage),
  });

  const summary = await summarizer({
    messages: [{ role: "user", content: "folded body" }],
    roundRange: { from: 1, to: 2 },
  });

  assert.equal(summary, "## 阶段\n summary");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.length, 1);
  assert.equal(requests[0].messages[0].role, "user");
  assert.ok(
    requests[0].messages[0].content.startsWith(SUMMARIZER_PROMPT_GUIDE),
    "the shipped prompt guide must lead the input",
  );
  assert.match(requests[0].messages[0].content, /folded body/u);
  assert.match(requests[0].messages[0].content, /第 1 轮 - 第 2 轮/u);
  assert.match(requests[0].system, /压缩器/u);
  assert.deepEqual(usages, [{ input_tokens: 10, output_tokens: 2 }]);
});

test("createProviderSummarizer honours a per-call guide and falls back to the shipped one", async () => {
  const seen = [];
  const summarizer = createProviderSummarizer({
    chat: async (request) => {
      seen.push(request.messages[0].content);
      return { content: "ok" };
    },
  });
  await summarizer({ promptGuide: "PER_CALL_GUIDE" });
  await summarizer({});
  assert.match(seen[0], /^PER_CALL_GUIDE/u);
  assert.equal(seen[1].startsWith(SUMMARIZER_PROMPT_GUIDE), true);
});

test("createProviderSummarizer surfaces failures instead of returning junk", async () => {
  await assert.rejects(
    createProviderSummarizer({ chat: async () => ({ content: [] }) })({}),
    { name: "TypeError", message: /no text/u },
  );
  await assert.rejects(
    createProviderSummarizer({ chat: async () => { throw new Error("boom"); } })({}),
    /boom/u,
  );
  assert.throws(() => createProviderSummarizer({}), { name: "TypeError" });
});

test("a throwing host onUsage does not break the summary", async () => {
  const summarizer = createProviderSummarizer({
    chat: async () => ({ content: "text", usage: { input_tokens: 1 } }),
    onUsage: () => { throw new Error("host callback blew up"); },
  });
  assert.equal(await summarizer({}), "text");
});
