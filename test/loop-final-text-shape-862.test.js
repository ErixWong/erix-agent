// issue #862（修法 A）：终稿正文是一段**被文本化的工具调用** ⇒ 引擎认得出来。
//
// 现场：上游/网关把 tool call 编进了 `content`，引擎那一轮看到的就是「无 `tool_use` +
// `end_turn` + 正文非空」⇒ 按既有规则直接判 `completed`，未交付被静默收下。上游编码各家
// 不同（DeepSeek 的 `<｜｜DSML｜｜`、通用 `<tool_call`、`<｜Function`、Anthropic 的 `<invoke`、
// 某些网关的 `chatcmpl-tool-…`），所以判据是**一份共享特征集**，不是 DSML 专属。
// 本包此前对这类标记**零判据**（`grep -rn 'DSML' src/` 全空），宿主自己那份拷贝只覆盖顶层
// run 的终局信封 ⇒ `delegate` 子 run 一个标记都不带。
//
// 格子对账（九格，编号与下面 test() 一致）：
//   ① / ②：命中面 —— 真样本端到端、五条特征逐个、优先级 = 清单顺序、大小写不敏感；
//   ③ / ④：不误伤 —— ``` 围栏与行内码里的字面量不算命中，`offset` / `offer` / `chatcmpl`
//          / 空正文 / 正常中文总结不算命中，以及**裸串特征的长度下限**这条宿主守卫；
//   ⑤：老路径**缺席而不是 false** —— `'finalTextShape' in result === false`（宿主判据就是
//      键存在性），且命中那一发的键集合只比不命中多这一个键；
//   ⑥：**终态语义一个字节都没动** —— 仍 `end_turn`，`rounds` / `usage` / `verification`
//      与不命中那一发同值（停门是修法 B，单开一单，本票不改判定）；
//   ⑦：`runId` 只在宿主传了时才写键（引擎不自编标识）；
//   ⑧：one-shot —— 同一 run 至多一条；旗标住在 `runLoopState`（本次进程的现场，不入账、
//      不进 resume 重置段）⇒ resume 之后那一次终局**重新判、重新发**。这是**选择**不是
//      遗漏：把「发过没有」写成 durable 判据，跨 resume 重跑的 run 就会**一条都没有**；
//   ⑨：特征集与宿主**逐字同一条**（含顺序），事件分级是 `fact`。
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TOOLCALL_MARKERS,
  detectTextualizedToolCall,
  textualizedToolCallField,
} from "../src/index.js";
import { eventTierOf } from "../src/loop/event-tiers.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

/** 宿主 `/home/eric/projects/erix-station/runner/lib/final-text-toolcall.js` 的那五条，
 *  **顺序**也一并按它写：命中取第一条 ⇒ 顺序就是优先级。这里逐字抄一遍是为了让"两边漂移"
 *  在本文件红掉，而不是在宿主的判据里静默改变含义（U+FF5C 全角竖线尤其容易看漏）。 */
const HOST_MARKERS = ["<｜｜DSML｜｜", "<tool_call", "<｜Function", "<invoke", "chatcmpl-tool-"];

/** #862 现场里那条真实终稿：一句正常总结 + 换行 + 被文本化的调用。 */
const REAL_DSML_FINAL = [
  "Tests: 3824 total … all green. Commit pushed on branch main.",
  "<｜｜DSML｜｜ calls>",
  "<｜｜DSML｜｜ invoke name=\"execute_command\">",
].join("\n");

const textTurn = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const toolTurn = (text) => ({
  content: [
    ...(text === "" ? [] : [{ type: "text", text }]),
    { type: "tool_use", id: "t1", name: "noop", input: {} },
  ],
  stopReason: "tool_use",
});

const SHAPE_EVENT = "final_text_textualized_tool_call";

/** 跑一发，返回终局 + 本 run 看到的 `final_text_textualized_tool_call` 事件。 */
async function runOnce(script, { runId = "run-862", rounds = 4 } = {}) {
  // `runId: null` = 宿主**没传**（`undefined` 会踩默认值参数，测试里读起来反而含糊）。
  const events = [];
  const result = await runDirect({
    provider: createFakeProvider(script),
    seed: "把活干了",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { ...(runId === null ? {} : { runId }), maxRounds: rounds, completion: false } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return { result, shapeEvents: events.filter((event) => event.type === SHAPE_EVENT) };
}

// ── ① 命中：字段 + 事件（真实 DSML 样本，端到端走引擎，不是只喂纯函数）──────────────────────
test("① #862 现场：总结句 + 被文本化的调用 ⇒ finalTextShape 出现、告警事件发出", async () => {
  const { result, shapeEvents } = await runOnce([textTurn(REAL_DSML_FINAL)]);

  assert.deepEqual(result.finalTextShape, { textualizedToolCall: true, marker: "<｜｜DSML｜｜" });
  assert.equal(shapeEvents.length, 1, `终局只该有一条告警，实际 ${shapeEvents.length} 条`);
  assert.equal(shapeEvents[0].marker, "<｜｜DSML｜｜", "载荷必须点名命中的那条特征");
  assert.equal(shapeEvents[0].round, 1);
  assert.equal(shapeEvents[0].runId, "run-862", "宿主传了 runId ⇒ 事件要能 join 到那次 run");
});

test("② 五条特征逐个都认（含 `<invoke` 与 `chatcmpl-tool-` 这两条**零实证**的预防性覆盖）", async () => {
  const samples = [
    ['报告就绪\n<｜｜DSML｜｜ calls>', "<｜｜DSML｜｜"],
    ["结论如下\n<tool_call name=\"exec\">", "<tool_call"],
    ["结论如下\n<｜Function=exec>", "<｜Function"],
    ['结论如下\n<invoke name="exec">', "<invoke"],
    ["结论如下\nchatcmpl-tool-abc123def456", "chatcmpl-tool-"],
  ];
  for (const [text, marker] of samples) {
    assert.equal(detectTextualizedToolCall(text), marker, `没认出：${text}`);
    assert.deepEqual(textualizedToolCallField(text), {
      finalTextShape: { textualizedToolCall: true, marker },
    });
  }
  // 优先级 = 特征集顺序：同一发里同时出现 `<invoke` 与 `<｜｜DSML｜｜` 时，报**清单第一条**。
  assert.equal(detectTextualizedToolCall('<invoke name="a">\n<｜｜DSML｜｜ calls>'), "<｜｜DSML｜｜");
  assert.equal(detectTextualizedToolCall("<tool_call\nchatcmpl-tool-abc123def456"), "<tool_call");
  // 大小写不敏感（宿主同款 `t.toLowerCase().includes(m.toLowerCase())`）。
  assert.equal(detectTextualizedToolCall("done\n<INVOKE name=\"exec\">"), "<invoke");
  assert.equal(detectTextualizedToolCall("done\nCHATCMPL-TOOL-abc123"), "chatcmpl-tool-");
});

test("③ 代码块与行内码里的字面量**不算命中**（文档/台账里引用这些标记是日常）", () => {
  const fenced = '改动如下：\n```javascript\nconst tag = \'<invoke name="x">\';\n```\n以上。';
  const fencedTwice = '改动：\n```\n<｜Function=exec>\n```\n还有：\n```\n<invoke name="b">\n```\n以上。';
  const inline = "台账里写的是 `<tool_call` 这个标记，不是泄漏。";
  const inlinePair = "围栏里：`<invoke name=\"a\">` 与 `<｜｜DSML｜｜ calls>`\n收尾。";
  for (const text of [fenced, fencedTwice, inline, inlinePair]) {
    assert.equal(detectTextualizedToolCall(text), null, `误命中：${text}`);
    assert.deepEqual(textualizedToolCallField(text), {}, `未命中必须给空对象：${text}`);
  }
  // 只吃**成对**的 ``` 围栏：没闭合的那半个不吞后文（否则整篇正文会被"半个围栏"抹掉）。
  assert.equal(detectTextualizedToolCall("```\n<invoke>\n正文里的 <tool_call>"), "<tool_call");
  // 已知边界（与宿主**逐字一致**带来的，不是疏漏）：宿主只剥 ``` 与行内码，`~~~` 围栏不在
  // 剥的范围 ⇒ 里面的标记仍算命中。本票写明"匹配规则必须与宿主一致"，所以这里**记下**；
  // 顺手加宽就等于两边判据不同 ⇒ 又回到两个真相源。
  assert.equal(detectTextualizedToolCall("说明：\n~~~\n<tool_call>\n~~~\n完毕。"), "<tool_call");
});

test("④ 近邻词与短串不误伤：offset / offer / chatcmpl / 空正文 / 正常中文总结", () => {
  const misses = [
    "offset 与 offer 是两个方向；本轮 chatcmpl 是请求 id 的前缀，不是泄漏。",
    "chatcmpl",
    "chatcmpl-tool",
    "",
    "本轮完成：改了 3 个文件，补了 12 个测试，3824 全绿，无遗留。",
    "特征集本身：`<｜｜DSML｜｜` / `<tool_call` —— 都在行内码里，不算泄漏。",
  ];
  for (const text of misses) {
    assert.equal(detectTextualizedToolCall(text), null, `误命中：${JSON.stringify(text)}`);
  }
  // `<invoke` 单独出现（正文里、不在码里）时**算**命中。
  assert.equal(detectTextualizedToolCall("<invoke"), "<invoke");
  // **裸串特征的下限**（宿主同款守卫）：不含 `<` 的特征必须长度 ≥ 12 且带 `-`，否则它会把
  // `offset` / `offer` 这类正常英文词判成泄漏 ⇒ 这种条目直接被跳过，而不是"匹配得少一点"。
  assert.equal(detectTextualizedToolCall("an offset in the text", ["offset"]), null);
  assert.equal(detectTextualizedToolCall("an offer-marker here", ["offer-"]), null);
  assert.equal(
    detectTextualizedToolCall("an offset-marker-x in the text", ["offset-marker-"]),
    "offset-marker-",
    "长度 14 且带 `-` 的裸串是**可用**特征，别把下限写成永久拒绝",
  );
});

test("⑤ 老路径是**缺席**，不是 false（宿主判据就是键存在性）", async () => {
  const { result, shapeEvents } = await runOnce([
    toolTurn("先看一眼\n<invoke name=\"a\">"), // 中途轮的正文里带标记 ⇒ 不该发
    textTurn("本轮完成：改了 3 个文件，3824 全绿，无遗留。"),
  ]);

  assert.equal("finalTextShape" in result, false, "未命中时**不许**写 finalTextShape:false");
  assert.equal(result.finalTextShape, undefined);
  assert.equal(shapeEvents.length, 0, "只有**终稿**正文参与判定，中途轮的正文不发事件");
  assert.equal("finalTextFallback" in result, false);
  assert.equal(result.termination.reason, "end_turn");
  // 命中那一发与不命中那一发**同形**（只差 `finalTextShape` 这一个键）⇒ 终态语义没被动过。
  const hit = await runOnce([textTurn(REAL_DSML_FINAL)]);
  const missKeys = Object.keys(result).sort();
  const hitKeys = Object.keys(hit.result).sort();
  assert.deepEqual(hitKeys.filter((key) => key !== "finalTextShape"), missKeys);
});

test("⑥ 终态语义不变：命中那一发仍 end_turn，verification 与不命中同值", async () => {
  const hit = await runOnce([textTurn(REAL_DSML_FINAL)]);
  const miss = await runOnce([textTurn("一切正常，无遗留。")]);

  assert.equal(hit.result.termination.reason, "end_turn");
  assert.equal(hit.result.termination.completed, miss.result.termination.completed);
  assert.deepEqual(hit.result.usage, miss.result.usage);
  assert.equal(hit.result.rounds, miss.result.rounds);
  assert.deepEqual(hit.result.verification, miss.result.verification);
  assert.equal(hit.result.finalText, REAL_DSML_FINAL, "判据不许改写终稿正文");
});

test("⑦ runId 只在宿主传了时才写键（引擎不自编标识，与 #182 同口径）", async () => {
  const { shapeEvents } = await runOnce([textTurn(REAL_DSML_FINAL)], { runId: null });
  assert.equal(shapeEvents.length, 1);
  assert.equal("runId" in shapeEvents[0], false, "宿主没传 runId ⇒ 事件里不该凭空长出一个");
});

test("⑧ one-shot：一个 run 内两轮都命中也只发一条；跨 resume 会重新判、重新发", async () => {
  // 同一 run 内两轮都带标记：第 1 轮是 tool_use（不判），第 2 轮是终稿（判一次）⇒ 一条。
  const twoRounds = await runOnce(
    [toolTurn("<invoke name=\"a\">"), textTurn("<｜Function=exec> 收工。")],
    { rounds: 6 },
  );
  assert.equal(twoRounds.shapeEvents.length, 1, "同一 run 至多一条");
  assert.equal(twoRounds.shapeEvents[0].round, 2);
  assert.equal(twoRounds.shapeEvents[0].marker, "<｜Function");

  // resume 的那一次终局**重新判**（旗标在 runLoopState，不落账）：这是刻意的选择，
  // 写成 durable 判据的话，跨 resume 重跑的 run 会一条都没有。
  const store = createMemoryTranscriptStore();
  const firstEvents = [];
  await runDirect({
    provider: createFakeProvider([textTurn(REAL_DSML_FINAL)]),
    seed: "把活干了",
    store,
    executeTool: async () => "ok",
    config: { run: { runId: "resume-862", maxRounds: 4, completion: false } },
    capabilities: { hooks: { onEvent: (event) => firstEvents.push(event) } },
  });
  const resumedEvents = [];
  const resumed = await runDirect({
    provider: createFakeProvider([textTurn("<invoke name=\"b\"> 补一句。")]),
    store,
    executeTool: async () => "ok",
    config: { run: { runId: "resume-862", resume: true, maxRounds: 4, completion: false } },
    capabilities: { hooks: { onEvent: (event) => resumedEvents.push(event) } },
  });
  assert.equal(firstEvents.filter((event) => event.type === SHAPE_EVENT).length, 1);
  const afterResume = resumedEvents.filter((event) => event.type === SHAPE_EVENT);
  assert.equal(afterResume.length, 1, "resume 后的终局同样要发（旗标不跨进程持久）");
  assert.equal(afterResume[0].marker, "<invoke");
  assert.equal("finalTextShape" in resumed, true);
});

test("⑨ 特征集就是宿主那五条（顺序 = 优先级），且事件分级是 fact", () => {
  assert.deepEqual(DEFAULT_TOOLCALL_MARKERS, HOST_MARKERS);
  assert.ok(Object.isFrozen(DEFAULT_TOOLCALL_MARKERS), "共享特征集被下游改写会静默改变优先级");
  assert.equal(eventTierOf(SHAPE_EVENT), "fact", "唯一 durable 副本 ⇒ 删不得");
});
