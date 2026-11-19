// issue #865（#862 修法 B）：**停门那一格**——评审判「已完成」，但本轮正文只是被文本化的工具调用。
//
// 这一格为什么必须端到端跑（不能只测纯函数）：本单的主张是「`judge_done` 的停机许可不再被一堆
// 标记撑起来」，而许可的落点在 `src/loop/orchestrator.js` 的 stop 分支与那条 nudge 上——纯函数
// 测到的是**输入**（`hasDeliverable`），测不到「评审看到的分类」与「停门用的分类」是不是同一份。
// 于是这里用 fake provider + fake judge（零真模型、零写盘）跑真 run，断言的是**引擎公开结果**
// 与 `onJudge` 记录，不去读引擎私有状态。
//
// 三格（与 `test/judge-deliverable-textualized-865.test.js` 的纯函数面互补）：
//   · **B1 命中 ⇒ 先 nudge**：fake judge 恒判 `done:true / 0.85`（> `JUDGE_DONE_CONFIDENCE_THRESHOLD`），
//     终稿是纯泄漏 ⇒ 该轮 `onJudge` 记的是 `nudge`（不是 `judge_done`），注入的那条控制消息
//     **点名「被文本化的工具调用」**，且配额（`JUDGE_DONE_GAP_NUDGE_LIMIT`）用尽之后才真的
//     `judge_done`（放行是设计：不放行 run 就挂死，#435 记过同一条教训）；
//   · **B2 命中后被推回真交付**：泄漏 → nudge → 真交付 ⇒ 终稿是真交付正文，**不是**那堆标记
//     （`result.finalTextShape` 缺席）。这一格就是判据 3 那张表里 `leak_then_delivery`
//     从「终稿仍是标记 5/5」变成「0/5」的那一格收益；
//   · **B3 不误伤（对照组）**：正文是**在 ``` 围栏里引用**标记的正常交付 ⇒ 第 2 轮直接
//     `judge_done`、一发 nudge 都没有。与 B1 的唯一差别就是那段文字的形状。
//
// ⚠ 评审的 `done` / `confidence` 一字未动（#473 明禁改评分模型/阈值）：B1 因此同时钉
// 「记录里 decision 仍是 done:true / 0.85」与「action 是 nudge」——停门读结论，不改结论。
import test from "node:test";
import assert from "node:assert/strict";

import { TEXTUALIZED_TOOL_CALL_LABEL } from "../src/reflection/judge.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

/** 评审恒判「已完成」（0.85 > 0.7）。 */
const JUDGE_DONE = {
  done: true,
  confidence: 0.85,
  reason: "任务已完成",
  evidence: "模型说已经做完",
  direction: "on_track",
  directionReason: "看起来在推进",
};

const LEAK = "Tests: 3824 total, 0 failing. Final round — checks 5 & 6.\n"
  + "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"exec\">\n"
  + "<｜｜DSML｜｜ parameter name=\"command\">npm test -- --filter judge</｜｜DSML｜｜>\n"
  + "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
const DELIVER = "已完成：给 judge_done 的停门补上「正文是不是交付物」这一格；"
  + "改动集中在 src/reflection/judge.js，全套测试绿（3878 tests / 0 fail）。";
/** 正常交付，但**在 ``` 围栏里引用**标记（本仓台账的写法）——B3 的对照组。 */
const QUOTED_DELIVER = "已完成：判据现在认得这些标记了。\n```\n<｜｜DSML｜｜ calls>\n```\n以上。";

const TOOL_ROUND = {
  content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "npm test" } }],
  stopReason: "tool_use",
};
const asText = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

async function runCase(script, { maxRounds = 6 } = {}) {
  const judgeRecords = [];
  const provider = createFakeProvider(script);
  const judge = createFakeProvider(Array.from({ length: maxRounds }, () => ({
    content: [{ type: "text", text: JSON.stringify(JUDGE_DONE) }],
  })));
  const result = await runDirect({
    provider,
    runId: "judge-done-textualized-865",
    seed: "按判据把交付正文写出来",
    executeTool: async () => "ok",
    maxRounds,
    config: { run: { completion: false, reflection: { enabled: true, roundJudge: true } } },
    capabilities: {
      ports: { judgeProvider: judge },
      hooks: { onJudge: (record) => judgeRecords.push(record) },
    },
  });
  return { result, provider, judgeRecords, judge };
}

/** 取第 `requestIndex` 发请求尾部那条引擎控制消息的正文。 */
function injectedText(provider, requestIndex) {
  const messages = provider.requests[requestIndex].messages;
  const tail = messages.at(-1);
  return (Array.isArray(tail?.content) ? tail.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

// ── B1 命中 ⇒ 先 nudge，配额用尽才放行 ─────────────────────────────────────────────────────
test("#865 B1 终稿是纯泄漏：该轮不许 judge_done，先 nudge 且文案点名这类正文，配额用尽后放行", async () => {
  const { result, provider, judgeRecords } = await runCase([
    TOOL_ROUND,
    { ...asText(LEAK), times: 4 },
  ]);

  // 前提：评审确实判了「已完成」（否则 B 段的绿只说明「评审没判完」）。
  assert.equal(judgeRecords[0].decision.done, true);
  assert.equal(judgeRecords[0].decision.confidence, 0.85);
  assert.equal(judgeRecords[0].round, 2, "第 1 轮是 tool_use 轮，结构上到不了评审");

  // 泄漏那一轮：结论一字未动，**许可**被撤 ⇒ 记录报 nudge，不是 judge_done。
  assert.equal(judgeRecords[0].action, "nudge",
    "一堆标记撑不起停机许可（#473 的停门读的就是这一格）");
  assert.equal(judgeRecords[0].decision.done, true, "降级不许改写评审的评分结论");
  const nudge = injectedText(provider, 2);
  assert.match(nudge, /【Judge 评审意见】/u, "注入的必须是那条评审控制消息");
  assert.ok(nudge.includes(TEXTUALIZED_TOOL_CALL_LABEL),
    `nudge 必须点名「${TEXTUALIZED_TOOL_CALL_LABEL}」，只说「没有正文」会把模型指错方向：${nudge}`);
  assert.match(nudge, /不计入交付物/u);
  assert.ok(nudge.includes("请给出真正完成该任务的交付正文"), "nudge 仍要给出路（#473 那条文案）");

  // 配额（`JUDGE_DONE_GAP_NUDGE_LIMIT` = 1）用尽 ⇒ 第二次同样判 done 就放行。
  // 放行是**设计**：不放行就把剩余轮次全烧在同一个判据上（#435 记过的形状）。
  assert.equal(judgeRecords[1].action, "judge_done", "配额用尽后回到 #473 之前的行为：放行");
  assert.equal(judgeRecords.filter((record) => record.action === "nudge").length, 1,
    "nudge 每 run 只给一次");
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.rounds, 3, "泄漏轮 + 被推回去的那一轮");
  assert.equal(provider.requests.length, 3, "一轮一发，nudge 只多花一轮主模型请求");
  // 终态语义没被本单改动：终稿仍是那堆标记，#862 修法 A 的键照样报出来（**没有**改成 failed）。
  assert.equal(result.finalText, LEAK);
  assert.deepEqual(result.finalTextShape, { textualizedToolCall: true, marker: "<｜｜DSML｜｜" });
});

// ── B2 命中后被推回真交付 ───────────────────────────────────────────────────────────────────
test("#865 B2 泄漏 → nudge → 真交付：终稿是真交付正文而不是标记（判据 3 那张表里的 5/5 → 0/5）", async () => {
  const { result, provider, judgeRecords } = await runCase([
    TOOL_ROUND,
    asText(LEAK),
    { ...asText(DELIVER), times: 3 },
  ]);

  assert.equal(judgeRecords[0].action, "nudge");
  assert.equal(judgeRecords[1].action, "judge_done", "真交付那一轮照常放行（本单没加第二次闸）");
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.rounds, 3);
  assert.equal(result.finalText, DELIVER, "交付的是正文，不是上游编码的标记");
  assert.equal(result.finalTextShape, undefined,
    "修法 A 的键缺席 = 终稿不是被文本化的调用（这一格是 0/5 那一格的单发形状）");
  assert.equal(provider.requests.length, 3);
});

// ── B3 不误伤：围栏里引用标记的正文照旧直接停机 ────────────────────────────────────────────
test("#865 B3 对照组：正文在 ``` 围栏里引用标记 ⇒ 第 2 轮直接 judge_done，零 nudge", async () => {
  const { result, provider, judgeRecords } = await runCase([
    TOOL_ROUND,
    { ...asText(QUOTED_DELIVER), times: 4 },
  ]);

  assert.equal(judgeRecords[0].action, "judge_done");
  assert.equal(judgeRecords.filter((record) => record.action === "nudge").length, 0,
    "不误伤：引用标记的台账写法不能被推回去重做一次");
  assert.equal(result.rounds, 2, "与 B1 的唯一差别是那段文字的形状：这里少跑的那一轮就是省下的钱");
  assert.equal(result.finalTextShape, undefined);
  assert.equal(provider.requests.length, 2);
});
