// issue #475：强制收尾的判据从**原因枚举**下沉到**状态**。
//
// 病灶（#467 交付时登记的残留项 B1）：`forceFinalIfNeeded()` 的闸门是一串 reason 字符串
// `["max_rounds_cap","stall","continuation_exhausted","judge_done"]`，而它要回答的是一个**状态**问题
// ——「手里有没有可交付的终局正文」。用枚举回答状态问题就天然会漏：把停机 reason 全集穷举一遍，
// 未覆盖的是且仅是 `end_turn` / `no_tool`（`aborted` 结构上不经过这个收口点，不存在第三格），
// 而这两格上「末轮只出 reasoning ⇒ 终局零正文、judge 侧 `judge:"missing"`」与 #467 完全同构。
//
// 现在的形状：被预算/截断掐断的（`FORCED_FINAL_TRUNCATED_REASONS`）继续走 `hasFinalDraft()`
// （**截断语义逐字不变**），其余 reason 只看「终稿正文是否为空」。对未来新增的 reason 免疫。
//
// 四格各钉一件事（缺一格就退回一个假绿）：
//   ① 修好的场景：`end_turn` 哑局 ⇒ 终局有正文 + `forcedFinal` + **恰好多发一发**；
//   ② 成本上界：`end_turn` 末轮**有**正文 ⇒ 一发都不多花（否则就是「每次正常收尾都白问一发」）；
//   ③ 另一格 `no_tool` 同构修好，且终局仍带可判别标记；
//   ④ 回归界：截断类 `max_rounds_cap` 的 `hasFinalDraft()` 语义不被「正文非空」这套新判据吃掉。
//
// ⚠ 断言口径沿用 #467 的教训：强制收尾的正文落在**最后一条 `round_end` 之后**，拿
// `round_end.finalText` 量会把修好的场景误报成空 ⇒ 一律按 run 终稿口径断言。
import test from "node:test";
import assert from "node:assert/strict";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const toolRound = {
  content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "ls" } }],
  stopReason: "tool_use",
};
// 真机形状：那一发回的是 content:[reasoning] + stopReason:"end_turn"，没有 text 块、没有 tool_use
const reasoningOnly = (text = "还剩提交动作没做，先总结一下…") => ({
  content: [{ type: "reasoning", text }],
  stopReason: "end_turn",
});
const forcedFinalText = "【收尾终稿】改了 A/B，验证通过，仅剩提交动作。";
const forcedFinalRound = { content: [{ type: "text", text: forcedFinalText }], stopReason: "end_turn" };

async function run({ script, maxRounds = 8, completion = false, env = {} }) {
  const events = [];
  const provider = createFakeProvider(script);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    const result = await runDirect({
      provider,
      runId: "forced-final-by-state-475",
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds,
      completion,
      capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    });
    return { result, events, provider };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

const forcedFinalEvents = (events) => events.filter((event) => event.type === "forced_final");

test("#475 ① end_turn 哑局（末轮只出 reasoning）⇒ 必须强制收尾出终稿，且恰好多发一发", async () => {
  const { result, events, provider } = await run({
    // 排一发收尾响应；若闸门仍按旧枚举早退，它会**不被消费**而请求数停在 2 ⇒ 本用例红
    script: [toolRound, reasoningOnly(), forcedFinalRound],
  });

  assert.equal(result.termination.reason, "end_turn", "reason 不被改写，只补正文");
  assert.equal(result.termination.forcedFinal, true, "宿主可判别的唯一标记");
  assert.equal(result.finalText, forcedFinalText, "终局不再是零正文");
  assert.equal(provider.requests.length, 3, "恰好多发一发（2 发=没修，4 发=没收住）");
  assert.deepEqual(provider.requests.at(-1).tools, [], "收尾那一发不得给工具面（结构上开不出新轮）");
  assert.equal(forcedFinalEvents(events).length, 1);
  assert.equal(result.rounds, 2, "收尾不增加轮数");
  assert.equal(result.truncated, false, "end_turn 不是截断类停机");
});

test("#475 ② end_turn 末轮已有正文 ⇒ 一发都不多花（成本上界）", async () => {
  const { result, events, provider } = await run({
    script: [
      toolRound,
      { content: [{ type: "text", text: "这是模型自己写的终稿" }], stopReason: "end_turn" },
      forcedFinalRound, // 排一发：被消费就说明闸门失效
    ],
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.finalText, "这是模型自己写的终稿", "终稿是模型自己那一份，不是收尾重写的");
  assert.equal(result.termination.forcedFinal, undefined, "有终稿 ⇒ 不该有强制收尾");
  assert.equal(provider.requests.length, 2, "正常收尾不该白问一发");
  assert.equal(forcedFinalEvents(events).length, 0);
});

test("#475 ③ no_tool 哑局同构修好：终局有正文，且停机 reason 不变", async () => {
  const { result, events, provider } = await run({
    // completion.maxNoToolRounds=2 ⇒ 连续两轮无工具即由 governor 判停（reason `no_tool`）
    script: [toolRound, reasoningOnly("r1"), reasoningOnly("r2"), forcedFinalRound],
    completion: { signals: [], maxNoToolRounds: 2 },
  });

  assert.equal(result.termination.reason, "no_tool", "停机原因仍是 governor 那一格");
  assert.equal(result.termination.forcedFinal, true);
  assert.equal(result.finalText, forcedFinalText);
  assert.equal(provider.requests.length, 4, "1 轮工具 + 2 轮无工具 + 收尾一发");
  assert.deepEqual(provider.requests.at(-1).tools, []);
  assert.equal(forcedFinalEvents(events).length, 1);
  assert.equal(result.rounds, 3, "收尾不增加轮数");
});

test("#475 ④ 截断类不被新判据吃掉：max_rounds_cap 末轮有正文仍按 hasFinalDraft 再问一发", async () => {
  const { result, events, provider } = await run({
    // 每轮都出 tool_use（正文始终为空、末轮是 tool_use）⇒ hasFinalDraft() 为假 ⇒ 截断语义照旧发收尾
    script: [
      toolRound,
      { content: [{ type: "tool_use", id: "c2", name: "exec", input: { command: "pwd" } }], stopReason: "tool_use" },
      { content: [{ type: "text", text: "还差一步验证" }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "c3", name: "exec", input: { command: "ls" } }], stopReason: "tool_use" },
      { content: [{ type: "tool_use", id: "c4", name: "exec", input: { command: "ls" } }], stopReason: "tool_use" },
      forcedFinalRound,
    ],
    maxRounds: 5,
    completion: { signals: [], maxNoToolRounds: 99 },
  });

  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.truncated, true);
  assert.equal(result.termination.forcedFinal, true, "截断类保留原语义：末轮有正文也要问收尾");
  assert.equal(result.finalText, forcedFinalText);
  assert.equal(forcedFinalEvents(events).length, 1);
  assert.equal(provider.requests.length, 6, "5 轮 + 收尾一发");
});

test("#475 逃生阀：ERIX_NO_FORCED_FINAL=1 时 end_turn 回到今日形状", async () => {
  const { result, provider } = await run({
    script: [toolRound, reasoningOnly(), forcedFinalRound],
    env: { ERIX_NO_FORCED_FINAL: "1" },
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.termination.forcedFinal, undefined);
  assert.equal(result.finalText, "");
  assert.equal(provider.requests.length, 2, "关掉后不发收尾请求（这两格的成本可退回）");
});
