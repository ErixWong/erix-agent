import test from "node:test";
import assert from "node:assert/strict";

import {
  ANCHOR_SECTION_HEADING,
  MAX_ANCHORS,
  MAX_ANCHOR_SECTION_CHARS,
  extractAnchors,
} from "../../src/compact/anchors.js";

test("extracts the four anchor kinds from raw payload text", () => {
  const result = extractAnchors([
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "fix 1ed3f35 in src/compact/anchors.js:42, see https://example.test/a/b.js and #32",
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool",
        content: "0c309e6 abcdef12\n/home/eric/projects/x/y.json:7\n#115\nhttp://example.test/docs?x=1。",
      }],
    },
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
  // 渲染顺序固定：paths → shas → issues → urls。
  assert.deepEqual(
    result.text.split("\n").slice(1).map((value) => value.split(":")[0]),
    ["paths", "shas", "issues", "urls"],
  );
  assert.equal(result.kept, result.entries.length);
  assert.equal(result.omitted, 0);
  // 确定性：同一输入两次抽取结果完全一致。
  const input = [{ role: "assistant", content: "1ed3f35 #32 src/a/b.js https://x.y/z" }];
  assert.deepEqual(extractAnchors(input), extractAnchors(input));
});

test("does not report prose, line numbers, colors, dates, ids or url paths as anchors", () => {
  const result = extractAnchors([
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "defaced 1234567 and/or 1/2 #ff0000 #2024-01-01 roughly so/that "
          + "https://example.test/a/b.js ENOENT",
      }],
    },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_01abcdef1234567890",
        name: "readFile",
        input: { file_id: "9f8e7d6c5b4a" },
      }],
    },
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

test("deduplicates anchors and counts every occurrence", () => {
  const result = extractAnchors([
    { role: "assistant", content: "1ed3f35 1ed3f35 #32 1ed3f35 #32 #33" },
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
  const result = extractAnchors([{ role: "assistant", content: text }]);

  assert.equal(MAX_ANCHORS, 20);
  assert.equal(result.total, MAX_ANCHORS * 2);
  assert.equal(result.kept, MAX_ANCHORS);
  assert.equal(result.omitted, MAX_ANCHORS);
  // 频次优先：#1(3 次) → #2/#3(2 次，按首次出现) → 其余按首次出现顺序。
  assert.deepEqual(result.byKind.issues.slice(0, 3), ["#1", "#2", "#3"]);
  assert.deepEqual(result.byKind.issues.slice(3, 6), ["#4", "#5", "#6"]);
  assert.deepEqual(result.byKind.issues.at(-1), `#${MAX_ANCHORS}`);
  assert.equal(result.text.split("\n").length, 2);
  assert.equal(extractAnchors([{ role: "assistant", content: text }], { maxAnchors: 2 }).kept, 2);
  assert.equal(extractAnchors([{ role: "assistant", content: text }], { maxAnchors: 0 }).text, "");
});

test("skips entries that would break the anchor section character cap", () => {
  const longUrl = `https://example.test/${"a".repeat(MAX_ANCHOR_SECTION_CHARS + 200)}`;
  const result = extractAnchors([
    { role: "assistant", content: `${longUrl} src/short/a.js src/short/b.js` },
  ]);

  assert.ok(result.text.length <= MAX_ANCHOR_SECTION_CHARS);
  assert.equal(result.omitted, 1);
  assert.deepEqual(result.byKind.urls, []);
  assert.deepEqual(result.byKind.paths, ["src/short/a.js", "src/short/b.js"]);
});

test("returns no section for empty or anchor-free payloads", () => {
  for (const payload of [
    undefined,
    null,
    [],
    [{ role: "assistant", content: "nothing precise here" }],
    [{ role: "user", content: [{ type: "text", text: "普通中文叙述，没有标识符" }] }],
    [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "plain" }] }],
    [null, { role: "assistant", content: 42 }],
  ]) {
    const result = extractAnchors(payload);
    assert.equal(result.text, "");
    assert.equal(result.total, 0);
    assert.equal(result.kept, 0);
    assert.deepEqual(result.byKind, { paths: [], shas: [], issues: [], urls: [] });
  }
});
