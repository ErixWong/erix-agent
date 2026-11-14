import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #835：`round_end` 的 **payload 是契约**，不是实现细节。
//
// 为什么这条判据存在：下游（erix-station）把 `round_end.payload.finalText` 当作「已完成轮次的
// durable 正文」在读 —— 真库 1,008 行 `round_end`、437 行 `final_text` 非空、最长 31,707 字。
// 而契约里 `round_end` 只有一行「轮边界」，payload 的键从来没写下来过。于是「上游瘦身事件通道」
// 与「下游把它当真值」之间没有任何书面约束。
//
// 这条判据就是那个**对端绊线**：键一旦消失，上游先红，而不是下游先炸。它只判**键存在与类型**，
// 不判内容（内容由行为判据管），也不判别的 payload 键有没有新增。

const ROUND_END_REQUIRED = ["round", "finalText", "stopReason", "usage"];

async function collectRoundEndEvents({ deltas }) {
  const events = [];
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "第一段正文。" }], stopReason: "end_turn" },
    { content: [{ type: "text", text: "第二段正文。" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    initialUserMessage: "写两轮",
    executeTool: async () => "unused",
    maxRounds: 3,
    completion: false,
    stream: deltas,
    store: createMemoryTranscriptStore(),
    runId: deltas ? "round-end-payload-stream" : "round-end-payload",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return events.filter((event) => event?.type === "round_end");
}

test("#835 round_end.payload 的四个键必须在场且类型稳定（下游拿 finalText 当 durable 正文）", async () => {
  const roundEnds = await collectRoundEndEvents({ deltas: false });
  assert.ok(roundEnds.length > 0, "场景必须真的发出 round_end（否则这一格是空转）");
  for (const event of roundEnds) {
    for (const key of ROUND_END_REQUIRED) {
      assert.ok(Object.hasOwn(event, key), `round_end.payload 缺键 \`${key}\`：下游会静默拿不到正文`);
    }
    assert.ok(Number.isSafeInteger(event.round), `round 必须是安全整数，实测 ${String(event.round)}`);
    assert.equal(typeof event.finalText, "string", "finalText 必须是字符串（空轮次是空串，不是缺席）");
    assert.equal(typeof event.stopReason, "string", "stopReason 必须是字符串");
    assert.equal(typeof event.usage, "object", "usage 必须是对象（与 usage 事件同形）");
    assert.ok(event.usage !== null, "usage 不能是 null");
  }
  // 正文必须真的在（不是恒空串）：这一格同时防「键在但永远空」那种假绿。
  assert.ok(roundEnds.some((event) => event.finalText.length > 0),
    "至少有一条 round_end 的 finalText 非空 —— 否则这条判据证明不了「正文由它承载」");
});

test("#835 空轮次也带 finalText（空串，不是缺席）—— 下游按「键存在」建行", async () => {
  const events = [];
  await runDirect({
    provider: createFakeProvider([{ content: [], stopReason: "end_turn", times: 3 }]),
    initialUserMessage: "什么都不写",
    executeTool: async () => "unused",
    maxRounds: 2,
    completion: false,
    store: createMemoryTranscriptStore(),
    runId: "round-end-empty",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  const roundEnds = events.filter((event) => event?.type === "round_end");
  assert.ok(roundEnds.length > 0, "空轮次也必须发 round_end");
  for (const event of roundEnds) {
    assert.ok(Object.hasOwn(event, "finalText"), "空轮次必须带 `finalText: \"\"`，不许整键缺席");
    assert.equal(event.finalText, "", "没有正文时它就是空串");
  }
});
