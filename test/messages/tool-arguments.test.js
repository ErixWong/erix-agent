// `src/messages/tool-arguments.js` 的单测（issue #409）：解析入口 + 判词生成。
//
// 端到端那一半（坏引数 → 不执行 → 判词回给模型）在 `test/loop-invalid-arguments.test.js`；
// 这里只钉模块自己的契约：`input` 与今天逐字兼容、判词挂载点、正确形状示例的来源与退化。

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeToolArgumentsParseError,
  exampleToolArguments,
  legacyArgumentsFallback,
  parseToolArguments,
} from "../../src/messages/tool-arguments.js";

test("parseToolArguments：能解析就是解析结果，不带判词", () => {
  assert.deepEqual(parseToolArguments('{"path":"a.txt"}'), { input: { path: "a.txt" } });
  assert.deepEqual(parseToolArguments(undefined), { input: {} }, "缺省引数与今天一致：{}");
  assert.deepEqual(parseToolArguments("{}"), { input: {} });
});

test("parseToolArguments：修得出来的走 L1，返回值逐字等于原文那一段", () => {
  const raw = "{'path': 'a.txt', 'limit': True,}";
  const parsed = parseToolArguments(raw);
  assert.deepEqual(parsed.input, { path: "a.txt", limit: true });
  assert.equal(parsed.parseError, undefined);
  assert.equal(raw.includes(parsed.input.path), true);
});

test("parseToolArguments：修不出来的回落对象与今天逐字相同，另带判词", () => {
  const raw = '{"path":';
  const parsed = parseToolArguments(raw);
  assert.deepEqual(parsed.input, legacyArgumentsFallback(raw));
  assert.deepEqual(parsed.input, { _truncatedArguments: raw, _raw: raw });
  assert.equal(parsed.parseError.reason, "unparsable");
  assert.equal(parsed.parseError.text, raw);
  assert.equal(typeof parsed.parseError.message, "string");
});

test("parseToolArguments：非字符串引数与今天一致（对象被 JSON.parse 拒 → 假对象）", () => {
  const value = { already: "object" };
  const parsed = parseToolArguments(value);
  assert.deepEqual(parsed.input, { _truncatedArguments: value, _raw: value });
  assert.equal(parsed.parseError.reason, "unparsable");
});

test("exampleToolArguments：有 required 就只列 required（照着写就能过的最小形状）", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" }, recursive: { type: "boolean" } },
    required: ["path"],
  };
  assert.equal(exampleToolArguments(schema), '{"path": ""}');
  // 没声明 required ⇒ 列全部属性（上限 6 个）
  assert.equal(
    exampleToolArguments({ properties: { path: { type: "string" }, limit: { type: "integer" } } }),
    '{"path": "", "limit": 0}',
  );
  // 属性太多 ⇒ 只列前 6 个（判词不是 schema 的转储）
  const many = { properties: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, { type: "number" }])) };
  assert.equal(exampleToolArguments(many).split(",").length, 6);
  // schema 缺失/退化 ⇒ 泛化示例，不编造字段名
  assert.equal(exampleToolArguments(undefined), '{"<参数名>": "<值>"}');
  assert.equal(exampleToolArguments({ properties: {} }), '{"<参数名>": "<值>"}');
});

test("describeToolArgumentsParseError：解析器原话 + 位置 + 附近片段 + 正确形状，四件齐", () => {
  const raw = '{"path": "a.txt"';
  const message = describeToolArgumentsParseError({
    toolName: "readFile",
    parseError: { reason: "unparsable", message: "Unexpected end of JSON input", position: 16, text: raw },
    schema: { properties: { path: { type: "string" } }, required: ["path"] },
  });
  assert.match(message, /工具 readFile/);
  assert.match(message, /没有执行/);
  assert.match(message, /解析器原话：Unexpected end of JSON input/);
  assert.match(message, /第 17 个字符（从 1 开始数）/);
  assert.match(message, /附近：\{"path": "a\.txt"/);
  assert.match(message, /正确形状：\{"path": ""\}/);
});

test("describeToolArgumentsParseError：抽不到位置/原文时不许编位置", () => {
  const message = describeToolArgumentsParseError({
    toolName: "work",
    parseError: { reason: "unparsable", message: "some parser words" },
  });
  assert.match(message, /解析器原话：some parser words/);
  assert.doesNotMatch(message, /出错位置/);
  assert.match(message, /正确形状：\{"<参数名>": "<值>"\}/);
});
