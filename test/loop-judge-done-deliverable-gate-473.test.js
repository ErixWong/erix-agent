// issue #473：`judge_done` 的停门必须把「这段文本到底是不是被声明为交付物」当作判据的输入。
//
// 病灶（工单 §1/§2）：`src/reflection/judge.js` 的 `renderConversation` 自己声明了两种块的地位不同——
// `text` 块是该轮**交付物**（并进 mandatory 集，`### assistant`），`reasoning` 块标着
// 「内部自述，不可作为事实依据」。而 `judge_done` 的**停门**两条都不看：同一段字，标成 `text` 就是
// 交付物、标成 `reasoning` 就不可作为事实依据，停门却给它们同一个结论。真机形状（run
// `run-2026-08-30T04-06-26-011Z-41f2043c` 第 11 轮）：评审拿一段「模型自承缺项」的**自述**判了
// `done:true / 0.85 > 0.7`，越过 judge 提示词自己写的「必须有工具结果或文本能直接证明目标已完成」。
//
// 本文件钉四件事：
//   ① **最小夹具**：同一段文本，标成 `text` 与标成 `reasoning` ⇒ 停门结论**相反**（工单点名的那组矛盾）；
//   ② 判据的**输入面**：评审提示词里必须出现机器分类（正文块数 / 自述块数 / stop_reason）与绑定规则，
//      而**不给**事实时提示词与今天逐字相同（纯加法，既有调用方不受影响）；
//   ③ 三类落点：`no_deliverable_text`（自述）、`self_reported_incomplete`（自承缺项）、以及
//      「还需要再跑一步」为何不需要第三套判据（`isEndTurn` 结构性排除）；
//   ④ 反向证：把分类退回「不看」（`judgeDoneBlocker` 恒返回 null）⇒ ① 必须红。
//
// ⚠ 口径纪律：分类**只有一份**实现（`deliverableKindOfBlock`），渲染器与停门都读它。所以本文件的
// 断言一律走 `renderConversation` 的产物与引擎的公开结果，不去读引擎私有状态。
import test from "node:test";
import assert from "node:assert/strict";

import {
  REASONING_NOT_EVIDENCE_LABEL,
  buildJudgePrompt,
  deliverableKindOfBlock,
  judgeDoneBlocker,
  renderConversation,
  roundDeliverableFacts,
} from "../src/reflection/judge.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const JUDGE_DONE = {
  done: true,
  confidence: 0.85,
  reason: "任务已完成",
  evidence: "模型说已经做完",
  direction: "on_track",
  directionReason: "看起来在推进",
};

const toolRound = {
  content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "ls" } }],
  stopReason: "tool_use",
};
/** ① 的主夹具：**同一段字**，只换块类型。 */
const SAME_TEXT = "清单里还缺一半，没有写入操作。";

const asText = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const asReasoning = (value) => ({ content: [{ type: "reasoning", text: value }], stopReason: "end_turn" });

async function runCase({ script, judgeDecisions = [JUDGE_DONE], maxRounds = 4, env = {} }) {
  const judgeRecords = [];
  const provider = createFakeProvider(script);
  const judge = createFakeProvider(judgeDecisions.map((decision) => ({
    content: [{ type: "text", text: JSON.stringify(decision) }],
  })));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const result = await runDirect({
      provider,
      runId: "judge-done-deliverable-gate-473",
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds,
      // 规位拼写（不是扁平壳）：`completion` 的家是 `config.run.completion`，judge provider 是
      // **行为**（函数）⇒ 家是 `capabilities.ports.judgeProvider`（`config` 里放函数会被 intake 拒）。
      config: { run: { completion: false, reflection: { enabled: true, roundJudge: true } } },
      capabilities: {
        ports: { judgeProvider: judge },
        hooks: { onJudge: (record) => judgeRecords.push(record) },
      },
    });
    return { result, provider, judgeRecords, judge };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

// ── ① 最小夹具：text 与 reasoning 同文、结论相反 ────────────────────────────────────────
test("#473 ① 同一段文本：标 text ⇒ judge_done 成立；标 reasoning ⇒ 同一份 done:true 不成立", async () => {
  const script = (round) => [toolRound, round, asText("补出来的交付正文")];

  const asDeliverable = await runCase({ script: script(asText(SAME_TEXT)) });
  const asSelfTalk = await runCase({
    script: script(asReasoning(SAME_TEXT)),
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
  });

  // 前提（否则这组对照不成立）：两次的评审**输入结论完全相同**（done:true / 0.85 / 同一段字）
  assert.equal(asDeliverable.judgeRecords[0].decision.done, true);
  assert.equal(asSelfTalk.judgeRecords[0].decision.done, true);
  assert.equal(asDeliverable.judgeRecords[0].decision.confidence, 0.85);
  assert.equal(asSelfTalk.judgeRecords[0].decision.confidence, 0.85);

  // 结论相反：标成交付物 ⇒ 第 2 轮就停；标成自述 ⇒ 第 2 轮不许停（多跑一轮）
  assert.equal(asDeliverable.judgeRecords[0].action, "judge_done");
  assert.equal(asDeliverable.result.rounds, 2);
  assert.equal(asDeliverable.provider.requests.length, 2);
  assert.equal(asDeliverable.result.termination.reason, "judge_done");

  assert.equal(asSelfTalk.judgeRecords[0].action, "nudge",
    "同一段字标成 reasoning ⇒ 它是「内部自述」，停门不许拿它当完成证据");
  assert.equal(asSelfTalk.result.rounds, 3, "这一轮不许停 ⇒ 多跑一轮（配额 = 1）");
  assert.equal(asSelfTalk.provider.requests.length, 3);
  // 而且它停的理由必须是**补出来的正文**，不是那句自述
  assert.equal(asSelfTalk.result.finalText, "补出来的交付正文");
  assert.equal(asSelfTalk.judgeRecords[1].action, "judge_done");
});

// ── ② 判据的输入面：分类进提示词（纯加法，不给则逐字不变）────────────────────────────────
test("#473 ② 评审提示词带上机器分类与绑定规则；不给事实时与今天逐字相同", () => {
  const messages = [
    { role: "assistant", content: [{ type: "reasoning", text: "先想一下" }] },
    { role: "assistant", content: [{ type: "text", text: "交付正文 42" }] },
  ];
  const facts = {
    roundDeliverable: roundDeliverableFacts(messages, 0),
    roundStopReason: "end_turn",
  };
  const withFacts = buildJudgePrompt("task", 3, [], [], [], "### assistant\n交付正文 42", {}, facts);
  assert.match(withFacts, /本轮交付物分类（引擎机器事实/u);
  assert.match(withFacts, /assistant 正文块 1 个 \/ 7 字符/u);
  assert.match(withFacts, /内部自述（reasoning）1 个 \/ 4 字符/u);
  assert.match(withFacts, /本轮 stop_reason：end_turn/u);
  // 绑定规则必须把「正文块为 0」直接映射到 done=false，并把渲染器那句标签原文写进去
  assert.match(withFacts, /assistant 正文块为 0 ⇒ 本轮\*\*没有交付物\*\*/u);
  assert.match(withFacts, new RegExp(REASONING_NOT_EVIDENCE_LABEL, "u"));
  assert.match(withFacts, /自承缺项/u);
  assert.match(withFacts, /还需要再跑一步/u);

  // 反向锚（纯加法）：不传 `facts` ⇒ 一个字节都不多
  const withoutFacts = buildJudgePrompt("task", 3, [], [], [], "### assistant\n交付正文 42");
  assert.doesNotMatch(withoutFacts, /本轮交付物分类/u);
  assert.doesNotMatch(withoutFacts, /交付物硬规则/u);
});

test("#473 ② 分类只有一份实现：渲染器把 reasoning 标成「不可作为事实依据」，停门引用同一个常量", () => {
  const rendered = renderConversation([
    { role: "assistant", content: [
      { type: "reasoning", text: "内部想法" },
      { type: "text", text: "交付正文" },
    ] },
  ]);
  assert.match(rendered, new RegExp(`### assistant（${REASONING_NOT_EVIDENCE_LABEL}）`, "u"));
  assert.match(rendered, /### assistant\n交付正文/u);
  // 同一个函数给出的分类就是渲染器分支用的那一份（改常量 ⇒ 两处一起变）
  assert.equal(deliverableKindOfBlock({ type: "text", text: "x" }), "deliverable_text");
  assert.equal(deliverableKindOfBlock({ type: "reasoning", text: "x" }), "reasoning");
  assert.equal(deliverableKindOfBlock({ type: "tool_use", name: "exec" }), "other");
  // user 的正文不是该轮交付物（它是任务与引擎控制文本）
  assert.equal(roundDeliverableFacts([
    { role: "user", content: [{ type: "text", text: "任务" }] },
  ], 0).hasDeliverable, false);
});

// ── ③ 三类落点 ───────────────────────────────────────────────────────────────────────────
test("#473 ③ no_deliverable_text：只有自述 ⇒ 拦；有正文 ⇒ 放；空白正文不算正文", () => {
  const onlyReasoning = roundDeliverableFacts([
    { role: "assistant", content: [{ type: "reasoning", text: "想了很久" }] },
  ], 0);
  assert.equal(onlyReasoning.hasDeliverable, false);
  assert.equal(onlyReasoning.reasoningBlocks, 1);
  const blocker = judgeDoneBlocker({ facts: onlyReasoning, selfReport: undefined });
  assert.equal(blocker.code, "no_deliverable_text");
  assert.match(blocker.detail, new RegExp(REASONING_NOT_EVIDENCE_LABEL, "u"));

  // 有正文 ⇒ 不拦（这一格是「不许误杀」的反向锚）
  const withText = roundDeliverableFacts([
    { role: "assistant", content: [{ type: "text", text: "交付正文" }] },
  ], 0);
  assert.equal(judgeDoneBlocker({ facts: withText, selfReport: undefined }), null);

  // 空白 text 块不是正文（渲染器同样 `trim() === ""` 就跳过它）
  const blank = roundDeliverableFacts([
    { role: "assistant", content: [{ type: "text", text: "   \n\t " }] },
  ], 0);
  assert.equal(blank.hasDeliverable, false);
  assert.equal(judgeDoneBlocker({ facts: blank, selfReport: undefined }).code, "no_deliverable_text");
});

test("#473 ③ self_reported_incomplete：模型自己的收尾信封 done:false ⇒ 自报只能否决、不能授予", async () => {
  // 该轮**有**正文（JSON 信封本身是 text 块）⇒ 分类这一格不拦；拦住它的是信封自己的 done:false
  const envelope = (done) => JSON.stringify({ done, summary: "还差一半没写", output: "还差一半没写" });
  const { result, judgeRecords, provider } = await runCase({
    script: [
      toolRound,
      asText(envelope(false)),
      asText(envelope(true)),
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
  });
  assert.equal(judgeRecords[0].action, "nudge", "信封自承 done:false ⇒ 评审的 done:true 不成立");
  assert.equal(result.rounds, 3);
  assert.equal(provider.requests.length, 3);
  // 注入的 nudge 点名「自承缺项」
  const nudge = provider.requests[2].messages.at(-1).content
    .filter((block) => block.type === "text").map((block) => block.text).join("");
  assert.match(nudge, /自承缺项/u);
});

test("#473 ③ 还需要再跑一步：末轮带 tool_use 的轮次结构上到不了 judge_done（不需要第三套判据）", async () => {
  // `isEndTurn = roundStopReason === "end_turn" && !hasToolUse(content)` 是这条停门的前置条件：
  // 末轮只要带 tool_use，评审根本不跑（`roundJudgeEnabled && isEndTurn`），于是也不会有 judge_done。
  const { result, judgeRecords, judge } = await runCase({
    script: [
      toolRound,
      { content: [{ type: "tool_use", id: "c2", name: "exec", input: { command: "ls" } }], stopReason: "tool_use" },
      // 预算用尽后的强制收尾那一发（它属于收尾，不属于「跑一步」）
      asText("收尾正文"),
    ],
    maxRounds: 2,
  });
  assert.equal(judge.requests.length, 0, "带 tool_use 的轮次不进评审（结构排除）");
  assert.equal(judgeRecords.length, 0);
  assert.notEqual(result.termination.reason, "judge_done");
});
