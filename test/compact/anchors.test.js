import test from "node:test";
import assert from "node:assert/strict";

import {
  ANCHOR_SECTION_HEADING,
  MAX_ANCHORS,
  MAX_ANCHOR_SECTION_CHARS,
  extractAnchors,
  splitAnchorValues,
} from "../../src/compact/anchors.js";

// A2 抽取范围：只扫 tool_result 内容 + 真实 user 消息；assistant 散文不参与。
function toolResult(content) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content }] };
}

test("extracts the five anchor kinds from raw payload text", () => {
  const result = extractAnchors([
    {
      role: "user",
      content: "fix 1ed3f35 in src/compact/anchors.js:42, see https://example.test/a/b.js and #32",
    },
    toolResult(
      "0c309e6 abcdef12\n/home/eric/projects/x/y.json:7\n#115\nhttp://example.test/docs?x=1。",
    ),
  ]);

  assert.equal(ANCHOR_SECTION_HEADING, "## 锚点索引（机械抽取，未经 LLM 改写）");
  assert.equal(result.text.split("\n")[0], ANCHOR_SECTION_HEADING);
  assert.deepEqual(
    result.byKind.paths,
    ["src/compact/anchors.js:42", "/home/eric/projects/x/y.json:7"],
  );
  assert.deepEqual(result.byKind.shas, ["1ed3f35", "0c309e6", "abcdef12"]);
  assert.deepEqual(result.byKind.issues, ["#32", "#115"]);
  assert.deepEqual(
    result.byKind.urls,
    ["https://example.test/a/b.js", "http://example.test/docs?x=1"],
  );
  // 渲染顺序固定：paths → shas → issues → urls（errors 有值时排最末）。
  assert.deepEqual(
    result.text.split("\n").slice(1).map((value) => value.split(":")[0]),
    ["paths", "shas", "issues", "urls"],
  );
  assert.equal(result.kept, result.entries.length);
  assert.equal(result.omitted, 0);
  // 确定性：同一输入两次抽取结果完全一致。
  const input = [toolResult("1ed3f35 #32 src/a/b.js https://x.y/z")];
  assert.deepEqual(extractAnchors(input), extractAnchors(input));
});

test("never scans assistant prose, tool_use params or engine metadata", () => {
  const result = extractAnchors([
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "我改了 src/compact/anchors.js:42（1ed3f35），详见 https://example.test/a/b.js",
      }],
    },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_01abcdef1234567890",
        name: "readFile",
        input: { path: "src/secret/config.js" },
      }],
    },
    { role: "system", content: "config path src/sys/config.js" },
  ]);

  assert.deepEqual(result.byKind, {
    paths: [], shas: [], issues: [], urls: [], errors: [],
  });
  assert.equal(result.text, "");
});

test("does not report prose, line numbers, colors, dates, ids or url paths as anchors", () => {
  const result = extractAnchors([
    toolResult(
      "defaced 1234567 and/or 1/2 #ff0000 #2024-01-01 roughly so/that "
        + "https://example.test/a/b.js ENOENT",
    ),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "1234567890abcdef", content: "ok" }],
    },
    { role: "user", content: [{ type: "image", source: { type: "url", url: "not-a-url" } }] },
  ]);

  assert.deepEqual(result.byKind.paths, []);
  assert.deepEqual(result.byKind.shas, []);
  assert.deepEqual(result.byKind.issues, []);
  assert.deepEqual(result.byKind.urls, ["https://example.test/a/b.js"]);
  // URL 不会被同时当成路径（`example.test/a/b.js` 不出现）。
  assert.equal(result.text.split("\n").length, 2);
});

test("extracts error lines verbatim, truncated to 120 chars and capped at 5", () => {
  const longLine = `TypeError: ${"x".repeat(200)}`;
  const result = extractAnchors([
    toolResult([
      "first ok line",
      "TypeError: cannot read properties of undefined",
      "Traceback (most recent call last):",
      "fatal: unable to connect",
      longLine,
      "SyntaxError: unexpected token",
      "ReferenceError: foo is not defined",
      "RangeError: index out of bounds",
      "plain line with error word lowercase error here",
      "all good",
    ].join("\n")),
  ]);

  assert.deepEqual(result.byKind.errors, [
    "TypeError: cannot read properties of undefined",
    "Traceback (most recent call last):",
    "fatal: unable to connect",
    longLine.slice(0, 120),
    "SyntaxError: unexpected token",
  ]);
  assert.ok(result.byKind.errors.every((value) => value.length <= 120));
  assert.ok(result.text.includes(`${ANCHOR_SECTION_HEADING}\nerrors: `));
  // 7 条错误行命中，硬上限 5：total 计全部唯一值，byKind 只留夹取后的 5 条。
  assert.equal(result.total, 7);
  assert.equal(result.byKind.errors.length, 5);
  assert.equal(result.omitted, 2);
});

test("real user messages are scanned but tool_result-only messages stay tool output", () => {
  const result = extractAnchors([
    { role: "user", content: "看 1ed3f35 的改动" },
    toolResult("src/a/b.js:12"),
  ]);

  assert.deepEqual(result.byKind.shas, ["1ed3f35"]);
  assert.deepEqual(result.byKind.paths, ["src/a/b.js:12"]);
  // assistant 同句复述不参与（降误报核心）：把 assistant 散文加进来结果不变。
  const withProse = extractAnchors([
    { role: "user", content: "看 1ed3f35 的改动" },
    toolResult("src/a/b.js:12"),
    { role: "assistant", content: "我读一下 src/c/d.js 和 9f8e7d6" },
  ]);
  assert.deepEqual(withProse.byKind, result.byKind);
});

test("deduplicates anchors and counts every occurrence", () => {
  const result = extractAnchors([
    toolResult("1ed3f35 1ed3f35 #32 1ed3f35 #32 #33"),
  ]);

  assert.deepEqual(result.byKind.shas, ["1ed3f35"]);
  assert.deepEqual(result.byKind.issues, ["#32", "#33"]);
  assert.equal(result.total, 3);
  assert.equal(result.entries.find((entry) => entry.value === "1ed3f35").count, 3);
  assert.equal(result.entries.find((entry) => entry.value === "#32").count, 2);
});

test(`keeps the ${MAX_ANCHORS} most frequent anchors, ties by first appearance`, () => {
  const anchors = Array.from({ length: MAX_ANCHORS * 2 }, (_, index) => `#${index + 1}`);
  const text = ["#1 #1 #1", "#2 #2", "#3 #3", anchors.slice(3).join(" ")].join("\n");
  const result = extractAnchors([toolResult(text)]);

  assert.equal(MAX_ANCHORS, 20);
  assert.equal(result.total, MAX_ANCHORS * 2);
  assert.equal(result.kept, MAX_ANCHORS);
  assert.equal(result.omitted, MAX_ANCHORS);
  // 频次优先：#1(3 次) → #2/#3(2 次，按首次出现) → 其余按首次出现顺序。
  assert.deepEqual(result.byKind.issues.slice(0, 3), ["#1", "#2", "#3"]);
  assert.deepEqual(result.byKind.issues.slice(3, 6), ["#4", "#5", "#6"]);
  assert.deepEqual(result.byKind.issues.at(-1), `#${MAX_ANCHORS}`);
  assert.equal(result.text.split("\n").length, 2);
  assert.equal(extractAnchors([toolResult(text)], { maxAnchors: 2 }).kept, 2);
  assert.equal(extractAnchors([toolResult(text)], { maxAnchors: 0 }).text, "");
});

test("honors per-kind caps via maxPerKind", () => {
  const text = "#1 #2 #3 #4 #5 1ed3f35 0c309e6 abcdef1 1234abc";
  const result = extractAnchors([toolResult(text)], { maxPerKind: 2 });

  assert.equal(result.byKind.issues.length, 2);
  assert.equal(result.byKind.shas.length, 2);
  assert.equal(result.kept, 4);
});

test("skips entries that would break the anchor section character cap", () => {
  const longUrl = `https://example.test/${"a".repeat(MAX_ANCHOR_SECTION_CHARS + 200)}`;
  const result = extractAnchors([
    toolResult(`${longUrl} src/short/a.js src/short/b.js`),
  ]);

  assert.ok(result.text.length <= MAX_ANCHOR_SECTION_CHARS);
  assert.equal(result.omitted, 1);
  assert.deepEqual(result.byKind.urls, []);
  assert.deepEqual(result.byKind.paths, ["src/short/a.js", "src/short/b.js"]);
});

test("escapes commas and backslashes so every kind round-trips losslessly", () => {
  const result = extractAnchors([
    toolResult("Error: failed, retry later\nfatal: copy C:\\tmp\\a, C:\\tmp\\b failed"),
    { role: "user", content: "stats https://x.com/?a=1,2 其他 https://y.com/dir\\name" },
  ]);

  // 值本身保真（含逗号/反斜杠的原值）。
  assert.deepEqual(result.byKind.errors, [
    "Error: failed, retry later",
    "fatal: copy C:\\tmp\\a, C:\\tmp\\b failed",
  ]);
  assert.deepEqual(result.byKind.urls, [
    "https://x.com/?a=1,2",
    "https://y.com/dir\\name",
  ]);
  // 渲染层转义：值内 `,` → `\,`、值内 `\` → `\\`，单行人类可读格式不变。
  assert.match(result.text, /^errors: Error: failed\\, retry later, /mu);
  assert.match(
    result.text,
    /^urls: https:\/\/x\.com\/\?a=1\\,2, https:\/\/y\.com\/dir\\\\name$/mu,
  );
  // 逆操作逐值还原：每行 `kind: …` 的取值列表与 byKind 完全一致（round-trip 保真）。
  for (const line of result.text.split("\n").slice(1)) {
    const separator = line.indexOf(": ");
    const kind = line.slice(0, separator);
    assert.deepEqual(
      splitAnchorValues(line.slice(separator + 2)),
      result.byKind[kind],
      line,
    );
  }
  // 常见边界：只有反斜杠的值、空值列表、无转义字符的 plain 值。
  assert.deepEqual(splitAnchorValues("a\\\\b"), ["a\\b"]);
  assert.deepEqual(splitAnchorValues(""), [""]);
  assert.deepEqual(splitAnchorValues("plain, value"), ["plain", "value"]);
});

test("returns no section for empty or anchor-free payloads", () => {
  for (const payload of [
    undefined,
    null,
    [],
    [{ role: "assistant", content: "1ed3f35 src/a/b.js https://x.y/z #1" }],
    [{ role: "user", content: [{ type: "text", text: "普通中文叙述，没有标识符" }] }],
    [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "plain" }] }],
    [null, { role: "assistant", content: 42 }],
  ]) {
    const result = extractAnchors(payload);
    assert.equal(result.text, "");
    assert.equal(result.total, 0);
    assert.equal(result.kept, 0);
    assert.deepEqual(
      result.byKind,
      { paths: [], shas: [], issues: [], urls: [], errors: [] },
    );
  }
});
