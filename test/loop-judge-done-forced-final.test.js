// issue #467：`judge_done` 停机必须做强制收尾。
//
// 病灶（真机 erix-station 会话 `14dd6202` / run `040b2f7e`，引擎 0.25.0）：模型末轮**只出 reasoning
// 不出正文**（167 个 reasoning delta + 0 个正文字块 + 0 次 tool_use），评审仍按 `done:true / 0.85`
// 直接终局 ⇒ 终局零正文，宿主时间线上最后一条可见内容是那张评审卡。同库 90 次 `judge_done` 里 6 次。
//
// 为什么这一格以前是绿的：`forceFinalIfNeeded()` 用**原因枚举**回答一个**状态**问题，而
// `hasFinalDraft()`（判据早就写好了）在这条路上只等价于「正文非空吗」——恰恰就是我们要的——
// 但那条路一个字节都没读它。
//
// 三格各钉一件事（缺一格就退回一个假绿）：
//   ① 修好的场景：终局有正文 + `forcedFinal` + **恰好多发一发**（多发两发=没收住，一发不发=没修）；
//   ② 成本上界：末轮**有**正文时一发都不多花（`hasFinalDraft()` 挡住，真机账 90 次里挡掉 84 次）；
//   ③ 残留的可判别性：收尾那一发仍然只出 reasoning 时，`{forcedFinal:true, finalText:""}` 这个组合
//      必须与「引擎根本没问」（`forcedFinal` 缺席）**可判别**——否则票面残留 1 连量都量不出来。
//
// ⚠ 断言口径：强制收尾产出的正文落在**最后一条 `round_end` 之后**，拿 `round_end.finalText` 量会把
// 修好的场景误报成空（这个坑本站自己踩过一次，票面也提醒过）⇒ 一律按 **run 终稿口径**断言。
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
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

async function runCase({ lastRound, wrapupResponse, judgeDecision = JUDGE_DONE }) {
  const events = [];
  const provider = createFakeProvider([
    toolRound,
    lastRound,
    ...(wrapupResponse === undefined ? [] : [wrapupResponse]),
  ]);
  const judge = createFakeProvider(
    judgeDecision === null
      ? []
      : [{ content: [{ type: "text", text: JSON.stringify(judgeDecision) }] }],
  );
  const result = await runToolLoop({
    provider,
    runId: "judge-done-forced-final",
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 4,
    completion: false,
    reflection: { enabled: true, roundJudge: true, judge: { provider: judge } },
    onEvent: (event) => events.push(event),
  });
  return { result, events, provider, judge };
}

test("#467 ① 末轮只出 reasoning ⇒ judge_done 必须强制收尾出终稿，且恰好多发一发", async () => {
  const { result, events, provider } = await runCase({
    lastRound: reasoningOnlyRound,
    wrapupResponse: {
      content: [{ type: "text", text: "【收尾终稿】改了 A/B，验证通过，仅剩 git commit。" }],
      stopReason: "end_turn",
    },
  });

  assert.equal(result.termination.reason, "judge_done", "termination reason 不被改写");
  assert.equal(result.termination.forcedFinal, true, "强制收尾确实跑过（宿主可判别的唯一标记）");
  assert.equal(result.finalText, "【收尾终稿】改了 A/B，验证通过，仅剩 git commit。");
  // 成本：恰好多发一发（第 3 发是收尾），不是 0 发（没修）也不是 2 发（没收住）
  assert.equal(provider.requests.length, 3);
  assert.equal(events.filter((event) => event.type === "forced_final").length, 1);
  // 那一发不得给模型工具面：结构上开不出新轮，这是「放开白名单不会收不住」的全部依据
  assert.deepEqual(provider.requests.at(-1).tools, [], "收尾那一发必须 tools: []");
  assert.equal(result.rounds, 2, "收尾不增加轮数");
  assert.equal(result.truncated, false, "judge_done 不是截断类停机，口径不变");
  // 反向证「不是把 round_end 当终稿」：轮记录里仍然是空的，正文只在 run 终稿口径上存在
  const lastRoundEnd = events.filter((event) => event.type === "round_end").at(-1);
  assert.equal(lastRoundEnd.finalText, "", "正文落在这条轮记录**之后**，验收别拿它量");
});

test("#467 ② 末轮已有正文 ⇒ hasFinalDraft 挡住，一发都不多花", async () => {
  const { result, events, provider, judge } = await runCase({
    lastRound: { content: [{ type: "text", text: "这是模型自己写的终稿" }], stopReason: "end_turn" },
    // 排一发进去：若被消费就说明闸门失效（脚本耗尽不会报错，所以必须数请求数）
    wrapupResponse: { content: [{ type: "text", text: "不该被消费" }], stopReason: "end_turn" },
  });

  assert.equal(result.termination.reason, "judge_done");
  assert.equal(result.finalText, "这是模型自己写的终稿", "终稿是模型自己那一份，不是收尾重写的");
  assert.equal(result.termination.forcedFinal, undefined, "有终稿 ⇒ 不该有强制收尾");
  assert.equal(provider.requests.length, 2, "90 次里 84 次靠这一格挡住，一发都不多花");
  assert.equal(events.filter((event) => event.type === "forced_final").length, 0);
  assert.equal(judge.requests.length, 1, "本用例必须真的走过评审");
});

test("#467 ③ 收尾那一发仍只出 reasoning ⇒ {forcedFinal:true, finalText:\"\"} 必须可判别", async () => {
  const { result, events, provider } = await runCase({
    lastRound: reasoningOnlyRound,
    wrapupResponse: { content: [{ type: "reasoning", text: "又只想了一下，没写正文" }], stopReason: "end_turn" },
  });

  assert.equal(provider.requests.length, 3, "收尾那一发确实发了（不是没问）");
  assert.equal(result.termination.forcedFinal, true);
  assert.equal(result.finalText, "", "票面残留 1：只发一次不重试 ⇒ 仍可能空");
  assert.equal(events.filter((event) => event.type === "forced_final").length, 1);
  // 「问过但没内容」与「根本没问」必须可判别（②格是 forcedFinal 缺席 + 正文非空；这里是反过来）
  assert.notEqual(result.termination.forcedFinal, undefined);
});

test("#467 逃生阀：ERIX_NO_FORCED_FINAL=1 时 judge_done 回到今日形状", async () => {
  process.env.ERIX_NO_FORCED_FINAL = "1";
  try {
    const { result, provider } = await runCase({ lastRound: reasoningOnlyRound });
    assert.equal(result.termination.reason, "judge_done");
    assert.equal(result.termination.forcedFinal, undefined);
    assert.equal(result.finalText, "");
    assert.equal(provider.requests.length, 2, "关掉后不发收尾请求");
  } finally {
    delete process.env.ERIX_NO_FORCED_FINAL;
  }
});
