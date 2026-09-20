import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/tokens.js";
import { foldToolResultsForRequest } from "../src/loop/tool-result-ttl.js";

const BIG = "x".repeat(20_000); // ~6600 估算 tokens，高于默认 4000 门槛

function conversation({
  resultContent = BIG,
  erixRound = 1,
  toolName = "scan",
  input = { path: "src/a.js", offset: 0, limit: 100 },
  extraResultFields = {},
} = {}) {
  return [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: toolName, input }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-1",
        content: resultContent,
        ...(erixRound === undefined ? {} : { erixRound }),
        ...extraResultFields,
      }],
    },
  ];
}

function resultBlock(view) {
  return view[2].content[0];
}

test("年龄 >= ttl 才折叠，低于 ttl 保持原文", () => {
  const messages = conversation();
  const young = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
  assert.equal(young, messages); // 无折叠 → 原引用

  const aged = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  assert.notEqual(aged, messages);
  assert.match(resultBlock(aged).content, /【已折叠·TTL】/);
});

test("低于 minTokens 的结果永不折叠", () => {
  const messages = conversation({ resultContent: "small" });
  const view = foldToolResultsForRequest(messages, { currentRound: 10, ttl: 1, minTokens: 4000 });
  assert.equal(view, messages);
});

test("占位符保留工具名/入参摘要/recall 句柄，且引用原文为 0", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  assert.match(folded.content, /【已折叠·TTL】scan path=src\/a\.js offset=0 limit=100/);
  assert.match(folded.content, /约 \d+ tokens，r1 读取/);
  assert.match(folded.content, /recall\(\{fromRound:1, pattern:"关键词"\}\)/);
  // 配对信息不丢（OpenAI 协议要求 tool_use 必有配对结果）
  assert.equal(folded.type, "tool_result");
  assert.equal(folded.tool_use_id, "call-1");
  // 占位符里不出现任何超过 100 字符的原文片段
  for (const line of folded.content.split("\n")) {
    assert.ok(line.length <= 200, `placeholder line too long: ${line.length}`);
  }
  assert.ok(!folded.content.includes("xxxx"));
});

test("exec 类工具显示 command 前 80 字符", () => {
  const command = `npm run build ${"arg ".repeat(40)}`;
  const messages = conversation({ toolName: "exec", input: { command } });
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  const commandIndex = folded.content.indexOf("npm run build");
  const snippet = folded.content.slice(commandIndex, commandIndex + 80);
  assert.ok(folded.content.includes(snippet));
  assert.ok(!folded.content.includes(command.slice(90)));
});

test("JSON {success,data} 结果的占位符额外保留骨架行", () => {
  const content = JSON.stringify({
    success: true,
    data: {
      // 垫高体积使其越过 minTokens 门槛
      blob: "x".repeat(20_000),
      items: Array.from({ length: 42 }, (_, index) => ({ id: index })),
    },
  });
  const messages = conversation({ resultContent: content });
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  const lines = folded.content.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /骨架: success=true · 共42条/);
});

test("JSON 骨架带 error 摘要", () => {
  const content = JSON.stringify({
    success: false,
    error: "boom: something failed badly",
    blob: "x".repeat(20_000), // 垫高体积
  });
  const messages = conversation({ resultContent: content });
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  assert.match(resultBlock(view).content, /骨架: success=false · error=boom/);
});

test("永不折叠名单：is_error / recall / note_* / todo_* / noFold", () => {
  for (const [label, options] of [
    ["is_error", { extraResultFields: { is_error: true } }],
    ["noFold", { extraResultFields: { noFold: true } }],
    ["recall", { toolName: "recall", input: { fromRound: 1 } }],
    ["note_read", { toolName: "note_read", input: {} }],
    ["todo_add", { toolName: "todo_add", input: {} }],
  ]) {
    const messages = conversation(options);
    const view = foldToolResultsForRequest(messages, { currentRound: 9, ttl: 1 });
    assert.equal(view, messages, `${label} must never fold`);
  }
});

test("缺失 erixRound 的结果保守不折（旧 checkpoint 恢复场景）", () => {
  const messages = conversation({ erixRound: null });
  const view = foldToolResultsForRequest(messages, { currentRound: 9, ttl: 1 });
  assert.equal(view, messages);
});

test("ttl=0 或 minTokens<=0 为 no-op（返回原引用）", () => {
  const messages = conversation();
  assert.equal(
    foldToolResultsForRequest(messages, { currentRound: 9, ttl: 0 }),
    messages,
  );
  assert.equal(
    foldToolResultsForRequest(messages, { currentRound: 9, ttl: 2, minTokens: 0 }),
    messages,
  );
});

test("浅拷贝：不改原数组、不改原块对象，未折叠消息保持引用", () => {
  const messages = conversation();
  const originalResult = messages[2].content[0];
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  // 原块对象未被修改
  assert.equal(originalResult.content, BIG);
  assert.equal(messages[2].content[0], originalResult);
  // 折叠块是浅拷贝：其他字段共享，content 被替换
  const folded = resultBlock(view);
  assert.notEqual(folded, originalResult);
  assert.equal(folded.erixRound, originalResult.erixRound);
  // 未涉及的消息保持引用
  assert.equal(view[0], messages[0]);
  assert.equal(view[1], messages[1]);
});

test("自定义 recallHint 生效", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, {
    currentRound: 3,
    ttl: 2,
    recallHint: ({ round, tokens }) => `自定义取回 r${round}/${tokens}`,
  });
  assert.match(resultBlock(view).content, /自定义取回 r1\/\d+/);
});

test("tokens 估算与 estimateTokens 一致", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const expected = estimateTokens(BIG);
  assert.match(resultBlock(view).content, new RegExp(`约 ${expected} tokens`));
});
