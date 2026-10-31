// issue #467（+ issue #473 的叠加）：`judge_done` 停机必须做强制收尾。
//
// 病灶（真机 erix-station 会话 `14dd6202` / run `040b2f7e`，引擎 0.25.0）：模型末轮**只出 reasoning
// 不出正文**（167 个 reasoning delta + 0 个正文字块 + 0 次 tool_use），评审仍按 `done:true / 0.85`
// 直接终局 ⇒ 终局零正文，宿主时间线上最后一条可见内容是那张评审卡。同库 90 次 `judge_done` 里 6 次。
//
// 为什么这一格以前是绿的：`forceFinalIfNeeded()` 用**原因枚举**回答一个**状态**问题，而
// `hasFinalDraft()`（判据早就写好了）在这条路上只等价于「正文非空吗」——恰恰就是我们要的——
// 但那条路一个字节都没读它。
//
// ── issue #473 之后本文件的形状 ────────────────────────────────────────────────────────────────
// #473 把**同一格**再往前推了一步：那一轮既然没有交付物正文，`judge_done` 本身就不该成立
// （评审依据只有 reasoning，而渲染器对它自己的口径是「不可作为事实依据」）⇒ 先降级成一次 nudge
// 让模型真的写出正文；配额（`JUDGE_DONE_GAP_NUDGE_LIMIT`，每 run 1 次）用完之后才回到 #467 的
// 强制收尾。于是本文件钉的是**两单叠起来**的行为，五格各钉一件事（缺一格就退回一个假绿）：
//   ① #473 主格：末轮只出 reasoning ⇒ 这一轮**不以 judge_done 停机**，注入一条 nudge；模型补出正文
//      后第二次评审放行 ⇒ `judge_done` + 终稿是模型自己写的 + `forcedFinal` **缺席**（没花收尾那一发）；
//   ② #467 成本上界：末轮**有**正文时一发都不多花（`hasFinalDraft()` 挡住，真机账 90 次里挡掉 84 次）；
//   ③ 配额用完（评审连续两次判 done 而该轮仍只有 reasoning）⇒ 落回 #467 的强制收尾：
//      `{forcedFinal:true, finalText:<正文>}` —— 「终局正文不再为空」这条保证不被 #473 吃掉；
//   ④ 残留的可判别性：收尾那一发仍然只出 reasoning 时，`{forcedFinal:true, finalText:""}` 这个组合
//      必须与「引擎根本没问」（`forcedFinal` 缺席）**可判别**——否则票面残留 1 连量都量不出来；
//   ⑤ #467 逃生阀：`ERIX_NO_FORCED_FINAL=1` 时回到「问都不问」的形状（#473 的 nudge 仍发生）。
//
// ⚠ 断言口径：强制收尾产出的正文落在**最后一条 `round_end` 之后**，拿 `round_end.finalText` 量会把
// 修好的场景误报成空（这个坑本站自己踩过一次，票面也提醒过）⇒ 一律按 **run 终稿口径**断言。
import test from "node:test";
import assert from "node:assert/strict";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const JUDGE_DONE = {
  done: true,
  confidence: 0.85,
  reason: "文档/CHANGELOG/模块地图已同步，仅剩提交动作。",
  evidence: "验证通过",
  direction: "on_track",
  directionReason: "已接近验证",
};

const toolRound = {
  content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "ls" } }],
  stopReason: "tool_use",
};
// 真机 28555→28721 那一格：末轮只有 reasoning，没有任何 text 块、没有任何 tool_use
const reasoningOnlyRound = {
  content: [{ type: "reasoning", text: "还剩提交动作没做，先总结一下…" }],
  stopReason: "end_turn",
};
const forcedFinalText = "【收尾终稿】改了 A/B，验证通过，仅剩 git commit。";

/** `judgeDecisions.length` 发评审响应（用完后 judge provider 抛错 ⇒ 评审降级，不会静默通过）。 */
function judgeScript(judgeDecisions) {
  return createFakeProvider(judgeDecisions.map((decision) => ({
    content: [{ type: "text", text: JSON.stringify(decision) }],
  })));
}

async function runCase({ script, judgeDecisions = [JUDGE_DONE], maxRounds = 4, env = {} }) {
  const events = [];
  const judgeRecords = [];
  const provider = createFakeProvider(script);
  const judge = judgeScript(judgeDecisions);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const result = await runDirect({
      provider,
      runId: "judge-done-forced-final",
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds,
      completion: false,
      reflection: { enabled: true, roundJudge: true, judge: { provider: judge } },
      capabilities: {
        hooks: {
          onEvent: (event) => events.push(event),
          onJudge: (record) => judgeRecords.push(record),
        },
      },
    });
    return { result, events, judgeRecords, provider, judge };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

/** 评审决策的**唯一**出口是 `onJudge`（`emitJudge`），不是 `onEvent`。 */
const judgeEvents = (judgeRecords) => judgeRecords.filter((record) => record.kind === "round");
const forcedFinalEvents = (events) => events.filter((event) => event.type === "forced_final");

test("#473 ① 末轮只出 reasoning ⇒ 这一轮不以 judge_done 停机（先 nudge），补出正文后正常收口", async () => {
  const { result, events, judgeRecords, provider, judge } = await runCase({
    script: [
      toolRound,
      reasoningOnlyRound,
      // 被 nudge 之后模型真的写出交付正文
      { content: [{ type: "text", text: "最终交付：清单已给出，回滚资产失效已定位。" }], stopReason: "end_turn" },
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
  });

  // ① 停门不认这一轮的 done:true —— 评审卡上是 nudge，不是 judge_done
  assert.equal(judgeEvents(judgeRecords)[0].action, "nudge",
    "评审判 done 但该轮没有交付物正文 ⇒ 事件里也不许写 judge_done（可观测面不许说谎）");
  assert.equal(judgeEvents(judgeRecords).length, 2, "补出正文之后要再评一次（本用例的第二发）");
  // ② 模型补出正文后，评审第二次 done ⇒ 真正以 judge_done 收口
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.finalText, "最终交付：清单已给出，回滚资产失效已定位。",
    "终稿是模型自己写的那一份（不是收尾重写的）");
  assert.equal(result.termination.forcedFinal, undefined,
    "有正文 ⇒ 不该再花强制收尾那一发（#473 与 #467 的分工就在这一格）");
  assert.equal(provider.requests.length, 3, "轮次：tool / reasoning / 补出的正文；收尾那发不许出现");
  assert.equal(forcedFinalEvents(events).length, 0);
  // 注入的 nudge 必须点名「没有交付物正文」，否则模型不知道被拦的是哪一件事
  const nudge = provider.requests[2].messages.at(-1).content
    .filter((block) => block.type === "text").map((block) => block.text).join("");
  assert.match(nudge, /没有交付物正文/u, `nudge 正文=${JSON.stringify(nudge)}`);
  assert.equal(judge.requests.length, 2);
});

test("#467 ② 末轮已有正文 ⇒ hasFinalDraft 挡住，一发都不多花", async () => {
  const { result, events, provider, judge } = await runCase({
    script: [
      toolRound,
      { content: [{ type: "text", text: "这是模型自己写的终稿" }], stopReason: "end_turn" },
      // 排一发进去：若被消费就说明闸门失效（脚本耗尽不会报错，所以必须数请求数）
      { content: [{ type: "text", text: "不该被消费" }], stopReason: "end_turn" },
    ],
  });

  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.finalText, "这是模型自己写的终稿", "终稿是模型自己那一份，不是收尾重写的");
  assert.equal(result.termination.forcedFinal, undefined, "有终稿 ⇒ 不该有强制收尾");
  assert.equal(provider.requests.length, 2, "90 次里 84 次靠这一格挡住，一发都不多花");
  assert.equal(forcedFinalEvents(events).length, 0);
  assert.equal(judge.requests.length, 1, "本用例必须真的走过评审");
});

test("#473 ③ 配额用完（评审两次判 done 而该轮仍只有 reasoning）⇒ 落回 #467 的强制收尾", async () => {
  const { result, events, judgeRecords, provider } = await runCase({
    script: [
      toolRound,
      reasoningOnlyRound,
      // 被 nudge 之后模型**仍然**只出 reasoning ⇒ 配额耗尽，这一次 judge_done 成立
      { content: [{ type: "reasoning", text: "又只想了一下，没写正文" }], stopReason: "end_turn" },
      { content: [{ type: "text", text: forcedFinalText }], stopReason: "end_turn" },
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
  });

  assert.equal(result.termination.reason, "judge_done", "termination reason 不被改写");
  assert.equal(result.termination.forcedFinal, true, "强制收尾确实跑过（宿主可判别的唯一标记）");
  assert.equal(result.finalText, forcedFinalText, "终局正文不再为空（#467 的保证仍在）");
  // 成本：3 发轮次 + 1 发收尾；nudge 恰好 1 次（配额 = 1，不许把剩余轮次全烧掉）
  assert.equal(provider.requests.length, 4);
  assert.equal(forcedFinalEvents(events).length, 1);
  assert.equal(judgeEvents(judgeRecords).filter((record) => record.action === "nudge").length, 1,
    "降级 nudge 只许发生一次（JUDGE_DONE_GAP_NUDGE_LIMIT）");
  // 那一发不得给模型工具面：结构上开不出新轮，这是「放开白名单不会收不住」的全部依据
  assert.deepEqual(provider.requests.at(-1).tools, [], "收尾那一发必须 tools: []");
  // 反向证「不是把 round_end 当终稿」：轮记录里仍然是空的，正文只在 run 终稿口径上存在
  const lastRoundEnd = events.filter((event) => event.type === "round_end").at(-1);
  assert.equal(lastRoundEnd.finalText, "", "正文落在这条轮记录**之后**，验收别拿它量");
});

test("#467 ④ 收尾那一发仍只出 reasoning ⇒ {forcedFinal:true, finalText:\"\"} 必须可判别", async () => {
  const { result, events, provider } = await runCase({
    script: [
      toolRound,
      reasoningOnlyRound,
      { content: [{ type: "reasoning", text: "又只想了一下，没写正文" }], stopReason: "end_turn" },
      { content: [{ type: "reasoning", text: "收尾那一发也只想了一下" }], stopReason: "end_turn" },
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
  });

  assert.equal(provider.requests.length, 4, "收尾那一发确实发了（不是没问）");
  assert.equal(result.termination.forcedFinal, true);
  assert.equal(result.finalText, "", "票面残留 1：只发一次不重试 ⇒ 仍可能空");
  assert.equal(forcedFinalEvents(events).length, 1);
  // 「问过但没内容」与「根本没问」必须可判别（②格是 forcedFinal 缺席 + 正文非空；这里是反过来）
  assert.notEqual(result.termination.forcedFinal, undefined);
});

test("#467 ⑤ 逃生阀：ERIX_NO_FORCED_FINAL=1 时回到「问都不问」的形状", async () => {
  const { result, provider } = await runCase({
    script: [
      toolRound,
      reasoningOnlyRound,
      { content: [{ type: "reasoning", text: "又只想了一下，没写正文" }], stopReason: "end_turn" },
    ],
    judgeDecisions: [JUDGE_DONE, JUDGE_DONE],
    env: { ERIX_NO_FORCED_FINAL: "1" },
  });
  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.termination.forcedFinal, undefined);
  assert.equal(result.finalText, "");
  // #473 的 nudge 仍然发生（它是停门判据，不是收尾）：两发轮次 + 没有收尾那一发
  assert.equal(provider.requests.length, 3, "关掉收尾后不再多发；nudge 那一轮属于主循环");
});
