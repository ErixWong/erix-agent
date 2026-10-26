import test from "node:test";
import assert from "node:assert/strict";

import {
  createProviderSummarizer,
  serializeFoldedMessages,
} from "../../src/compact/provider-summarizer.js";
import { SUMMARIZER_PROMPT_GUIDE } from "../../src/compact/fold-llm.js";
import { NORMALIZATION_REASONING_EFFORT } from "../../src/reflection/wrapup.js";
import { createOpenAIProvider } from "../../src/providers/openai.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

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

// issue #419 ②：折叠摘要请求必须**恒定**带「不思考」，且要落到真 provider 的 HTTP 请求体上。
// 与 #419 ① 同形（归一化那条），同一套两格写法：①请求对象上有该字段；②载荷层真把它写进 body。
test("createProviderSummarizer always sends reasoning_effort:none (issue #419 ②)", async () => {
  const requests = [];
  const summarizer = createProviderSummarizer({
    chat: async (request) => {
      requests.push(request);
      return { content: "摘要" };
    },
  });

  await summarizer({ messages: [{ role: "user", content: "folded body" }] });
  await summarizer({ promptGuide: "PER_CALL_GUIDE" });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    // 取值走同一个内部常量（与归一化那两处共用），不是各写各的字面量
    assert.equal(request.reasoning_effort, NORMALIZATION_REASONING_EFFORT);
    assert.equal(request.reasoning_effort, "none");
    // 反向钉：`temperature` 本票**有意不发**（改采样语义属另一件事）。
    assert.equal(Object.hasOwn(request, "temperature"), false);
    // 2026-10-26 宿主裁决（issue #469 ①，erix-station）**改写**了这条反向钉：
    // 真机那一发带着 `reasoning_effort:"none"` 仍产出 584 个 reasoning token ⇒ 只发
    // 前者不够，必须**显式**关掉 chat-template 侧的思考（不能靠模型默认值）。
    // 所以 `enable_thinking` / `chat_template_kwargs` 从「不许出现」变成「必须出现」，
    // 而 `thinking`（对象形态）仍然不发——它不是「关」的开关，是「怎么开」的开关。
    assert.equal(Object.hasOwn(request, "thinking"), false);
    assert.equal(request.enable_thinking, false);
    assert.deepEqual(request.chat_template_kwargs, { thinking: false });
  }
});

test("createProviderSummarizer lands reasoning_effort:none in the real provider request body (issue #419 ②)", async () => {
  const fetchImpl = createMockFetch([{
    json: {
      choices: [{ message: { content: "## 阶段\n 摘要正文" }, finish_reason: "stop" }],
    },
  }]);
  const provider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "qwen3.8-flash-next",
    fetchImpl,
  });

  // 与引擎注入点同形：`chat` 把摘要请求原样转给本 run 的主力 provider。
  const summarizer = createProviderSummarizer({ chat: (request) => provider.chat(request) });
  const summary = await summarizer({
    messages: [{ role: "user", content: "folded body" }],
    roundRange: { from: 1, to: 2 },
  });

  assert.equal(summary, "## 阶段\n 摘要正文");
  // 「发出的请求体里必须有那个字段」——这里读的是 fetch 真正收到的那份 body
  const body = fetchImpl.calls[0].body;
  assert.equal(body.reasoning_effort, "none");
  // 反向钉：本票没有顺手动采样语义
  assert.equal(Object.hasOwn(body, "temperature"), false);
});
