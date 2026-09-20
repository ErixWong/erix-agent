import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/tokens.js";
import {
  extractContentDigest,
  foldToolResultsForRequest,
} from "../src/loop/tool-result-ttl.js";

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

test("年龄 >= ttl 才折叠；age===ttl-1 预警轮；其余保持原引用", () => {
  const messages = conversation();
  // age=0（当轮结果）：原引用不变、无预警。
  const fresh = foldToolResultsForRequest(messages, { currentRound: 1, ttl: 2 });
  assert.equal(fresh, messages);
  // age=1 === ttl-1：预警轮，视图变化（原文 + 预警行），原块不动。
  const warned = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
  assert.notEqual(warned, messages);
  assert.match(resultBlock(warned).content, /【TTL 预警】此结果下一轮将折叠为句柄/);
  assert.ok(!resultBlock(warned).content.includes("【已折叠·TTL】"));
  assert.equal(resultBlock(messages).content, BIG); // 原块未被修改
  // age=2 >= ttl：折叠为占位符。
  const aged = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  assert.notEqual(aged, messages);
  assert.match(resultBlock(aged).content, /【已折叠·TTL】/);
});

test("低于 minTokens 的结果永不折叠", () => {
  const messages = conversation({ resultContent: "small" });
  const view = foldToolResultsForRequest(messages, { currentRound: 10, ttl: 1, minTokens: 4000 });
  assert.equal(view, messages);
});

test("占位符保留工具名/入参摘要/笔记提示，且引用原文为 0", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  assert.match(folded.content, /【已折叠·TTL】scan path=src\/a\.js offset=0 limit=100/);
  assert.match(folded.content, /约 \d+ tokens，r1 读取/);
  assert.match(folded.content, /先用 note_list 查找，再用 note_read 读取/);
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

test("永不折叠名单：is_error / note_* / todo_* / noFold", () => {
  for (const [label, options] of [
    ["is_error", { extraResultFields: { is_error: true } }],
    ["noFold", { extraResultFields: { noFold: true } }],
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

test("自定义 retrievalHint 生效", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, {
    currentRound: 3,
    ttl: 2,
    retrievalHint: ({ round, tokens }) => `自定义取回 r${round}/${tokens}`,
  });
  assert.match(resultBlock(view).content, /自定义取回 r1\/\d+/);
});

test("tokens 估算与 estimateTokens 一致", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const expected = estimateTokens(BIG);
  assert.match(resultBlock(view).content, new RegExp(`约 ${expected} tokens`));
});

// —— 预警轮（issue #35 探索项） ——

const WARNING_LINE = "【TTL 预警】此结果下一轮将折叠为句柄；若后续仍需，请现在用 note_take 记录要点";

test("预警轮：age===ttl-1 的结果末尾追加预警行，且原块对象未被修改", () => {
  const messages = conversation();
  const originalBlock = messages[2].content[0];
  const view = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
  const warned = resultBlock(view);
  // 原文在场 + 末尾恰好一行预警
  assert.equal(warned.content, `${BIG}\n${WARNING_LINE}`);
  assert.equal(warned.content.split("【TTL 预警】").length - 1, 1);
  // 原块对象未被修改（深比较）
  assert.deepEqual(originalBlock, {
    type: "tool_result",
    tool_use_id: "call-1",
    content: BIG,
    erixRound: 1,
  });
  assert.ok(!originalBlock.content.includes("【TTL 预警】"));
  // 折叠视图块是浅拷贝，其他字段共享
  assert.equal(warned.tool_use_id, originalBlock.tool_use_id);
  assert.equal(warned.erixRound, originalBlock.erixRound);
});

test("预警轮：age===ttl 当轮直接折叠，无预警", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  assert.match(resultBlock(view).content, /【已折叠·TTL】/);
  assert.ok(!resultBlock(view).content.includes("【TTL 预警】"));
});

test("预警轮：ttl=1 时当轮结果（age=0）无预警不折叠", () => {
  const messages = conversation();
  const view = foldToolResultsForRequest(messages, { currentRound: 1, ttl: 1 });
  assert.equal(view, messages); // age=0：当轮结果在场，原引用不变
  assert.ok(!resultBlock(view).content.includes("【TTL 预警】"));
});

test("预警轮：体积低于 minTokens 的结果不预警", () => {
  const messages = conversation({ resultContent: "small" });
  const view = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2, minTokens: 4000 });
  assert.equal(view, messages);
});

test("预警轮：never-fold 名单（note_*/todo_*）不预警", () => {
  for (const toolName of ["note_read", "todo_add"]) {
    const messages = conversation({ toolName, input: {} });
    const view = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
    assert.equal(view, messages, `${toolName} must not warn`);
  }
});

test("预警轮：不重复叠加（多次构建视图各含且仅含一行预警）", () => {
  const messages = conversation();
  const view1 = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
  const view2 = foldToolResultsForRequest(messages, { currentRound: 2, ttl: 2 });
  for (const view of [view1, view2]) {
    assert.equal(resultBlock(view).content.split("【TTL 预警】").length - 1, 1);
  }
  assert.equal(resultBlock(view1).content, resultBlock(view2).content);
  // 原块自始至终未被污染
  assert.equal(resultBlock(messages).content, BIG);
});

// —— 结构化导航摘要 extractContentDigest ——

const NUMBERED_SOURCE = [
  "1: import { x } from './y';",
  "40: // 一些普通注释",
  "120: export function handleLogin() {",
  "150: const password = await hash(pw);",
  "294: function postMessage(msg, target) {",
  "300: class SessionManager {",
  "310: def helper(",
  "400: ## 概述与用法",
  "410: async function fetchData() {",
  "500: export const MAX_RETRY = 3;",
  "600: export class Widget extends Base {",
].join("\n");

test("digest：从行号格式文本提取定义行（行号 + 签名片段）", () => {
  const digest = extractContentDigest(NUMBERED_SOURCE);
  assert.equal(typeof digest, "string");
  assert.ok(digest.includes("L120 handleLogin("));
  assert.ok(digest.includes("L294 postMessage("));
  assert.ok(digest.includes("L300 SessionManager"));
  assert.ok(digest.includes("L310 helper("));
  assert.ok(digest.includes("L400 概述与用法"));
  assert.ok(digest.includes("L410 fetchData("));
  assert.ok(digest.includes("L500 MAX_RETRY"));
  assert.ok(digest.includes("L600 Widget"));
  // 单行、竖线分隔
  assert.ok(!digest.includes("\n"));
  assert.ok(digest.includes(" | "));
  // 普通注释/const 非定义行不入 digest
  assert.ok(!digest.includes("password"));
  assert.ok(!digest.includes("一些普通注释"));
});

test("digest：非行号格式返回 undefined", () => {
  assert.equal(extractContentDigest("hello world\nno line numbers here"), undefined);
  assert.equal(extractContentDigest(JSON.stringify({ success: true })), undefined);
  assert.equal(extractContentDigest(""), undefined);
  assert.equal(extractContentDigest(undefined), undefined);
  assert.equal(extractContentDigest("x".repeat(20_000)), undefined);
});

test("digest：行号格式但无定义行 → undefined", () => {
  assert.equal(extractContentDigest("1: hello\n2: world\n3: foo bar"), undefined);
});

test("digest：maxEntries 截断", () => {
  const lines = Array.from(
    { length: 20 },
    (_, index) => `${(index + 1) * 10}: function fn${index}() {`,
  );
  const text = lines.join("\n");
  const full = extractContentDigest(text);
  assert.equal(full.split(" | ").length, 12); // 默认上限 12
  assert.ok(full.includes("L10 fn0("));
  assert.ok(!full.includes("L130 fn12(")); // 第 13 条被截断
  const capped = extractContentDigest(text, { maxEntries: 5 });
  assert.equal(capped.split(" | ").length, 5);
  assert.ok(capped.includes("L50 fn4("));
  assert.ok(!capped.includes("L60 fn5("));
});

test("digest：签名片段限长 ≤60 字符", () => {
  const longHeading = "# " + "词".repeat(100);
  const digest = extractContentDigest(`7: ${longHeading}`);
  assert.ok(digest !== undefined);
  const fragment = digest.slice(digest.indexOf(" ") + 1);
  assert.ok(fragment.length <= 60, `fragment too long: ${fragment.length}`);
});

// —— 占位符升级：导航行 + 600 字符上限 ——

function numberedBigSource({ entryCount = 8, padToTokens = true } = {}) {
  const names = Array.from(
    { length: entryCount },
    (_, index) => `handlerForDomainEventNumber${index}`,
  );
  const lines = names.map(
    (name, index) => `${(index + 1) * 37}: export function ${name}(req, res) {`,
  );
  if (padToTokens) {
    // 垫高体积越过 minTokens 门槛（注释行不构成定义行）
    lines.push(`999: // ${"x".repeat(20_000)}`);
  }
  return lines.join("\n");
}

test("占位符含 digest 导航行（readFile 类行号结果）", () => {
  const messages = conversation({ resultContent: numberedBigSource() });
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  const lines = folded.content.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /【已折叠·TTL】scan path=src\/a\.js/);
  assert.match(lines[1], /^导航: L37 handlerForDomainEventNumber0\( | L74 handlerForDomainEventNumber1\(/);
  // 原文不泄漏（除 digest 片段外不出现函数行原文）
  assert.ok(!folded.content.includes("req, res"));
});

test("占位符总量控制在 ~600 字符内（digest 超限时从尾裁剪）", () => {
  const messages = conversation({ resultContent: numberedBigSource({ entryCount: 12 }) });
  const view = foldToolResultsForRequest(messages, { currentRound: 3, ttl: 2 });
  const folded = resultBlock(view);
  assert.ok(
    folded.content.length <= 600,
    `placeholder too long: ${folded.content.length}`,
  );
  assert.match(folded.content, /【已折叠·TTL】/);
  assert.match(folded.content, /^导航: /m);
  // 不足 12 条时有多少放多少
  const fewMessages = conversation({ resultContent: numberedBigSource({ entryCount: 3 }) });
  const fewView = foldToolResultsForRequest(fewMessages, { currentRound: 3, ttl: 2 });
  const navLine = resultBlock(fewView).content.split("\n")[1];
  assert.equal(navLine.split(" | ").length, 3);
});

test("占位符：digest 与 JSON 骨架同时存在时两行都保留", () => {
  // JSON 骨架只在整体为 JSON 时存在；行号文本不触发骨架，digest 不触发骨架——
  // 二者互斥于同一 content，这里验证行号文本不产生伪骨架行、JSON 不产生 digest 行。
  const jsonContent = JSON.stringify({
    success: true,
    data: {
      blob: "x".repeat(20_000),
      items: [1, 2, 3],
    },
  });
  const jsonMessages = conversation({ resultContent: jsonContent });
  const jsonView = foldToolResultsForRequest(jsonMessages, { currentRound: 3, ttl: 2 });
  const jsonLines = resultBlock(jsonView).content.split("\n");
  assert.equal(jsonLines.length, 2);
  assert.match(jsonLines[1], /骨架: success=true · 共3条/);
  assert.ok(!jsonLines[1].startsWith("导航:"));
});
