// @ts-check
// issue #881（CLI 面）：交付物判据「这次判不了」必须进人眼面。
//
// 引擎那条 `deliverable_blind` 事件从前被 `bin/run-event-handlers.js` 的 `onEvent` 丢掉 ⇒ 宿主
// 看到的现象与「真的通过」逐字相同（裸 `--require-deliverable` 命中盲区时返回的是 `ok:true` +
// 一句 detail，而 `=== 统计 ===` 那行只渲染 verification 的指标）。这里钉三件事：
//   ① 该事件 ⇒ 一行中性 stderr，**含两个数字**（几条 exec 写了东西、几条解析不出来）；
//   ② 其它事件 ⇒ 不打这一行（不能把每个 run 都刷成噪音）；
//   ③ **端到端**：真跑一个盲区 run（exec 写目标解析不出）经 CLI 的 `onEvent` ⇒ **恰好一行**、
//      数字与引擎发出的一致；而正常 run（exec 目标全解析）⇒ **零行**。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  createRunEventHandlers,
  formatDeliverableBlindLine,
} from "../bin/run-event-handlers.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { EXEC_TOOL_NAME } from "../src/loop/exec-writes.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { makeTmp } from "./helpers/tmp.js";

const BLIND_EVENT = "deliverable_blind";

const toolUse = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
const text = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

/** 只把 stderr 收进数组的 handler（不写判据日志、不碰真 stderr）。 */
function collectStderr() {
  const lines = [];
  const { onEvent } = createRunEventHandlers({ writeStderr: (line) => lines.push(line) });
  return { lines, onEvent };
}

const BLIND_KEYWORD = "交付物判据这次判不了";

test("#881 ① 命中 ⇒ 一行中性提示、点名两个数字；其它事件 ⇒ null", () => {
  const line = formatDeliverableBlindLine({
    type: BLIND_EVENT, round: 3, execWriteCount: 3, execWriteUnresolvedCount: 2,
  });
  assert.equal(typeof line, "string", "命中⇒必须是一行字符串");
  assert.equal(line.includes("\n"), false, "必须是一行");
  assert.ok(line.includes("3") && line.includes("2"), `必须点名两个数字，实测：${line}`);
  // 中性：除了「这不是失败」这句否定，正文里不得再出现「失败」。
  assert.ok(!line.replace(/这不是失败/g, "").includes("失败"), `措辞必须中性，实测：${line}`);
  assert.ok(line.includes("判不了"), `要说的是「判不了」，实测：${line}`);
  // 可处置的一句话：告诉人下一步做什么。
  assert.ok(line.includes("deliverablePaths"), `必须给一句可处置的话，实测：${line}`);
  assert.ok(line.includes("台账没东西"), `必须点名那条误读，实测：${line}`);

  assert.equal(formatDeliverableBlindLine({ type: "compaction" }), null);
  assert.equal(formatDeliverableBlindLine({ type: "final_text_textualized_tool_call", marker: "x" }), null);
  assert.equal(formatDeliverableBlindLine(undefined), null);
});

test("#881 ①b 只有粗旗时不写数字，也不许冒出「0 条」这种假数字", () => {
  const line = formatDeliverableBlindLine({ type: BLIND_EVENT, round: 1 });
  assert.equal(typeof line, "string");
  assert.equal(line.includes("0 条"), false, `没有值就不许编数字，实测：${line}`);
  assert.ok(line.includes(BLIND_KEYWORD), line);
});

test("#881 ② 其它事件 ⇒ 不打这一行（避免把正常 run 刷成噪音）", () => {
  const { lines, onEvent } = collectStderr();
  onEvent({ type: "attempt" });
  onEvent({ type: "run_outcome", rounds: 1 });
  onEvent({ type: "compaction", compaction: { compacted: false } });
  onEvent({ type: "final_guard", round: 1, action: "accept" });
  assert.equal(lines.filter((line) => line.includes(BLIND_KEYWORD)).length, 0,
    `非本事件不得产出这一行：${JSON.stringify(lines)}`);
});

/** 跑一个 run，把 CLI 的 onEvent 直接挂在引擎的 onEvent 通道上（人眼面端到端）。 */
async function runWithCliHandlers(commands) {
  const dir = await makeTmp("erix-deliverable-blind-cli-");
  const { lines, onEvent } = collectStderr();
  /** @type {any[]} */
  const events = [];
  const result = await runToolLoop({
    provider: createFakeProvider([
      ...commands.map((command, index) => toolUse(`x${index + 1}`, EXEC_TOOL_NAME, { command })),
      text("done"),
    ]),
    store: createMemoryTranscriptStore(),
    executeTool: async (call) => {
      execFileSync("/bin/sh", ["-c", call.input.command], { cwd: dir, stdio: "ignore" });
      return "ok";
    },
    config: {
      input: { initialUserMessage: "write the files", wrapup: false },
      run: { cwd: dir, maxRounds: commands.length + 3, completion: false, reflection: false },
    },
    capabilities: {
      hooks: {
        finalGuard: async () => ({ action: "accept" }),
        onEvent: (event) => {
          events.push(event);
          onEvent(event);
        },
      },
    },
  });
  return { dir, lines, events, blindLines: lines.filter((line) => line.includes(BLIND_KEYWORD)), result };
}

test("#881 ③ 端到端：盲区 run ⇒ 恰好一行 stderr 且数字与事件一致；正常 run ⇒ 零行", async () => {
  const blind = await runWithCliHandlers(["printf x > known.txt", 'echo hi > "$OUT"']);
  assert.equal(blind.events.filter((event) => event.type === BLIND_EVENT).length, 1, "引擎侧恰好一条事件");
  assert.equal(blind.blindLines.length, 1, `人眼面恰好一行，实测 ${JSON.stringify(blind.lines)}`);
  const event = blind.events.find((item) => item.type === BLIND_EVENT);
  assert.ok(blind.blindLines[0].includes(String(event.execWriteCount)), `行内必须带事件里的 execWriteCount：${blind.blindLines[0]}`);
  assert.ok(blind.blindLines[0].includes(String(event.execWriteUnresolvedCount)), `行内必须带事件里的未解析数：${blind.blindLines[0]}`);
  assert.ok(!blind.blindLines[0].replace(/这不是失败/g, "").includes("失败"), "终态措辞中性");

  const clean = await runWithCliHandlers(["cat > out.txt <<'EOF'\nbody\nEOF", "printf hello | tee out2.txt"]);
  assert.equal(clean.events.filter((event) => event.type === BLIND_EVENT).length, 0, "正常 run 零事件");
  assert.equal(clean.blindLines.length, 0, `正常 run 零行（不许刷噪音）：${JSON.stringify(clean.lines)}`);
});
