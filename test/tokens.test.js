import test from "node:test";
import assert from "node:assert/strict";

import { estimateMessageTokens, estimateTokens } from "../src/tokens.js";

test("estimates CJK and non-CJK text with the default safety margin", () => {
  assert.equal(estimateTokens("你好"), Math.ceil(2 * 1.5 * 1.15));
  assert.equal(estimateTokens("abcd"), Math.ceil((4 / 3.5) * 1.15));
  assert.equal(
    estimateTokens("中ab"),
    Math.ceil((1 * 1.5 + 2 / 3.5) * 1.15),
  );
  assert.equal(estimateTokens(""), 0);
});

test("allows all estimation coefficients to be overridden", () => {
  assert.equal(
    estimateTokens("中abcd", {
      cjkTokensPerChar: 2,
      charsPerToken: 2,
      margin: 1,
    }),
    Math.ceil(2 + 4 / 2),
  );
});

test("sums string content and supported canonical blocks", () => {
  const messages = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "你好" },
        { type: "tool_use", id: "call-1", name: "lookup", input: { q: "中" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "结果" },
        { type: "raw", protocol: "vendor", payload: { ignored: true } },
      ],
    },
  ];

  const expected =
    3 * 4 +
    estimateTokens("hello") +
    estimateTokens("你好") +
    estimateTokens(JSON.stringify({ q: "中" })) +
    estimateTokens("结果") +
    estimateTokens(JSON.stringify({ ignored: true }));
  assert.equal(estimateMessageTokens(messages), expected);
  assert.equal(estimateMessageTokens([]), 0);
});

test("accounts for configurable message, image, reasoning, and raw block costs", () => {
  const options = {
    messageOverhead: 4,
    imageTokenCost: 1000,
    reasoningBlockCost: 5,
    rawBlockCost: 7,
  };
  const rawPayload = { kind: "trace", value: "x" };
  const messages = [{
    role: "assistant",
    content: [
      { type: "text", text: "answer" },
      { type: "image", url: "https://example.test/image.png" },
      { type: "reasoning", text: "think" },
      { type: "raw", protocol: "vendor", payload: rawPayload },
    ],
  }];

  assert.equal(
    estimateMessageTokens(messages, options),
    options.messageOverhead
      + estimateTokens("answer", options)
      + options.imageTokenCost
      + estimateTokens("think", options)
      + options.reasoningBlockCost
      + estimateTokens(JSON.stringify(rawPayload), options)
      + options.rawBlockCost,
  );
  assert.equal(
    estimateMessageTokens([{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
    }]),
    4 + 1000,
  );
});
