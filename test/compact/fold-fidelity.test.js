import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_USER_QUOTE_CHARS,
  REVERSE_SIGNAL_WARNING_LEAD,
  USER_INPUT_SECTION_HEADING,
  buildFoldFidelitySection,
  detectReverseSignals,
  extractLatestUserInput,
  reverseSignalWarningLine,
} from "../../src/compact/fold-fidelity.js";
import { ANCHOR_SECTION_HEADING } from "../../src/compact/anchors.js";

function toolResult(content) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content }] };
}

test("quotes the latest real user message verbatim without LLM rewriting", () => {
  const payload = [
    { role: "user", content: "先按方案 A 做，注意 SHA 1ed3f35" },
    { role: "assistant", content: [{ type: "text", text: "方案 A 已完成" }] },
    toolResult("ok"),
    { role: "assistant", content: [{ type: "text", text: "继续中" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "方案 A 细节保留：" },
        { type: "text", text: "第二段要逐字" },
      ],
    },
  ];
  const section = buildFoldFidelitySection(payload);
  const expected = [
    USER_INPUT_SECTION_HEADING,
    "> 方案 A 细节保留：",
    "> 第二段要逐字",
  ].join("\n");

  assert.equal(USER_INPUT_SECTION_HEADING, "## 用户最新未解决输入（逐字引用，未经 LLM 改写）");
  assert.ok(section.includes(expected));
  // "最后一条"：更早的 user 消息不被引用。
  assert.doesNotMatch(section, /先按方案 A 做/);
  assert.deepEqual(extractLatestUserInput(payload), {
    text: "方案 A 细节保留：\n第二段要逐字",
    messageIndex: 4,
    truncated: false,
    totalChars: 17,
  });
  assert.equal(extractLatestUserInput([toolResult("only tool output")]), undefined);
  assert.equal(extractLatestUserInput([]), undefined);
});

test("bounds the verbatim quote and marks the truncation", () => {
  const text = `起点${"x".repeat(MAX_USER_QUOTE_CHARS + 50)}终点`;
  const section = buildFoldFidelitySection([{ role: "user", content: text }]);

  assert.equal(MAX_USER_QUOTE_CHARS, 800);
  assert.ok(section.includes(`> 起点${"x".repeat(MAX_USER_QUOTE_CHARS - 2)}`));
  assert.doesNotMatch(section, /终点/u);
  assert.match(section, /\[用户原文过长：仅逐字引用前 800 字符，共 854 字符\]/u);
  assert.equal(extractLatestUserInput([{ role: "user", content: text }]).truncated, true);
});

test("injects a one-line warning when the user cancelled or undid work", () => {
  const payload = [
    { role: "user", content: "开始做方案 A" },
    { role: "assistant", content: [{ type: "text", text: "进行中" }] },
    { role: "user", content: "取消方案 A，谢谢" },
    { role: "user", content: "never mind, 算了" },
  ];
  const detection = detectReverseSignals(payload);
  const section = buildFoldFidelitySection(payload);

  assert.deepEqual(detection.signals, ["取消", "never mind", "算了"]);
  assert.deepEqual(detection.messageIndexes, [2, 3]);
  assert.match(section, new RegExp(REVERSE_SIGNAL_WARNING_LEAD));
  assert.match(section, /命中：取消、never mind、算了/u);
  assert.match(section, /上方「下一步」里早于该信号的旧待办不得直接照做，需先向用户确认/u);
  assert.match(section, /旧待办只标记为需确认，不从待办数据中删除/u);
  // 警告在引用之前；待办数据本身不被改写。
  assert.ok(section.indexOf(REVERSE_SIGNAL_WARNING_LEAD)
    < section.indexOf("> never mind, 算了"));
  assert.deepEqual(payload[2], { role: "user", content: "取消方案 A，谢谢" });
  const manyHits = reverseSignalWarningLine({
    signals: Array.from({ length: 7 }, (_, index) => `s${index}`),
  });
  assert.match(manyHits, new RegExp(`^${REVERSE_SIGNAL_WARNING_LEAD}（命中：s0、s1、s2、s3、s4）`));
  assert.doesNotMatch(manyHits, /s5|s6/u);
});

test("does not warn for ordinary user input or negated cancel phrases", () => {
  assert.equal(detectReverseSignals([{ role: "user", content: "继续做方案 B" }]), undefined);
  assert.equal(buildFoldFidelitySection([{ role: "user", content: "继续做方案 B" }])
    .includes(REVERSE_SIGNAL_WARNING_LEAD), false);
  // 否定式守卫："不要取消" / "don't stop" 是"别撤销"，不能读成撤销信号。
  for (const text of [
    "不要取消这个任务",
    "先不要停止，继续跑",
    "请勿放弃剩余测试",
    "don't stop the loop",
    "do not cancel the run",
  ]) {
    assert.equal(detectReverseSignals([{ role: "user", content: text }]), undefined, text);
  }
  // 工具结果里的 stop 词不算用户信号（只有真实 user 消息参与匹配）。
  assert.equal(detectReverseSignals([toolResult("stop")]), undefined);
  assert.equal(detectReverseSignals([{ role: "assistant", content: "I will stop" }]), undefined);
});

test("emits no empty sections when nothing was extracted", () => {
  assert.equal(buildFoldFidelitySection([]), undefined);
  assert.equal(buildFoldFidelitySection(undefined), undefined);
  assert.equal(buildFoldFidelitySection([toolResult("no anchors, no user text")]), undefined);
  assert.equal(buildFoldFidelitySection([{ role: "assistant", content: "纯散文，没有精确标识" }]), undefined);
});

test("appends the anchor index after the user input section", () => {
  const payload = [
    { role: "user", content: "看 1ed3f35 的改动" },
    // A2 抽取范围：锚点只来自 tool_result 与真实 user 消息；assistant 散文里的标识不参与。
    toolResult("改了 src/a/b.js:12 (#32)"),
  ];
  const section = buildFoldFidelitySection(payload);

  assert.ok(section.startsWith(USER_INPUT_SECTION_HEADING));
  assert.ok(section.includes(`\n\n${ANCHOR_SECTION_HEADING}`));
  assert.ok(section.indexOf(ANCHOR_SECTION_HEADING) > section.indexOf("> 看 1ed3f35 的改动"));
  assert.match(section, /shas: 1ed3f35/u);
  assert.match(section, /paths: src\/a\/b\.js:12/u);
  assert.match(section, /issues: #32/u);
  // 有锚点但无真实 user 消息时只输出锚点节。
  const anchorsOnly = buildFoldFidelitySection([toolResult("1ed3f35 src/a/b.js")]);
  assert.equal(anchorsOnly.split("\n")[0], ANCHOR_SECTION_HEADING);
  assert.doesNotMatch(anchorsOnly, new RegExp(USER_INPUT_SECTION_HEADING));
});
