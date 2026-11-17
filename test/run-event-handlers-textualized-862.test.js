// @ts-check
// issue #862：CLI 面（`erix run`）撞上真泄漏时不能一声不响。
//
// `bin/run-event-handlers.js` 的 `onEvent` 只处理 6 类事件，新事件
// `final_text_textualized_tool_call` 从前被丢弃 ⇒ 人眼面什么都没变。这里钉住：
//   ① 该事件 ⇒ 经 `createRunEventHandlers` 的 CLI 路径真打一行 stderr、且点名命中的
//      marker，措辞**中性**（「这不是失败」，不是报错）；
//   ② 其它事件 ⇒ 不打这一行（不能把每个 run 都刷成噪音）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  createRunEventHandlers,
  formatTextualizedToolCallLine,
} from "../bin/run-event-handlers.js";

const SHAPE_EVENT = "final_text_textualized_tool_call";

/** 造一组只把 stderr 收进数组的 handler（不写判据日志、不碰真 stderr）。 */
function collectStderr() {
  const lines = [];
  const { onEvent } = createRunEventHandlers({ writeStderr: (line) => lines.push(line) });
  return { lines, onEvent };
}

test("① 该事件 ⇒ CLI 路径打一行、点名 marker、措辞中性（不报失败）", () => {
  const line = formatTextualizedToolCallLine({
    type: SHAPE_EVENT, round: 2, marker: "<｜｜DSML｜｜",
  });
  assert.equal(typeof line, "string", "命中⇒必须是一行字符串");
  assert.ok(line.includes("<｜｜DSML｜｜"), "必须点名命中的那条 marker");
  // 中性：除了「这不是失败」这句否定，正文里不得再出现「失败」（否则人眼会误读成 run 挂了）。
  assert.ok(!line.replace(/这不是失败/g, "").includes("失败"), "措辞必须中性，不能报失败");

  const { lines, onEvent } = collectStderr();
  onEvent({ type: SHAPE_EVENT, round: 2, marker: "<tool_call" });
  assert.equal(lines.length, 1, "CLI 的 onEvent 必须真把这一行送到 stderr");
  assert.ok(lines[0].includes("<tool_call"));
});

test("② 其它事件 ⇒ 不打这一行（避免把正常 run 刷成噪音）", () => {
  assert.equal(formatTextualizedToolCallLine({ type: "compaction" }), null);
  assert.equal(formatTextualizedToolCallLine({ type: "run_outcome" }), null);
  assert.equal(formatTextualizedToolCallLine(undefined), null);

  const { lines, onEvent } = collectStderr();
  onEvent({ type: "attempt" });
  onEvent({ type: "run_outcome", rounds: 1 });
  onEvent({ type: "compaction", compaction: { compacted: false } });
  assert.equal(
    lines.filter((line) => line.includes("被文本化的工具调用")).length,
    0,
    "非本事件不得产出这一行",
  );
});
