// issue #438：**逐轮输出计量记漏**——续写循环覆盖 `response` ⇒ `record.response.usage` 只含最后一发。
//
// 病根（先复证，再改）：主循环里 `let response = providerResult.response;`，撞
// `stopReason:"max_tokens"` 的续写循环里每轮 `response = providerResult.response` **覆盖**；而轮记录
// `response: { content, stopReason, usage }` 用的就是这同一个变量 ⇒ `record.response.usage` 只反映
// 最后一次响应。评审实测：一轮真花 1407 个 `output_tokens`（700 + 700 + 7 三发），档案记 **7**。
//
// 本单的修法是**纯加法**（`record.response.usage` 逐字不动——已有宿主在读它，且契约里「最后一次
// 响应的 usage」这个形状被依赖），另开两个自解释的键：
//   · `record.usage`        —— 本轮**全部**响应的累计（逐轮账：预算 / 计费 / 「每轮输出多少」）；
//   · `record.engineUsage`  —— 本轮**引擎自发起的调用**（round judge / 收尾归一化 / 折叠摘要）的用量，
//                              缺键 = 本轮没有这类调用；
//   · `result.modelUsage` / `result.engineUsage` —— run 级同口径分账（`result.usage` 仍是两者之和，
//                              一字未动）。强制收尾发生在最后一条轮记录之后 ⇒ 只在 run 级那一份里。
//
// 三格判据（工单要求的 ①②③）：
//   ① 三响应 700+700+7 ⇒ 新键累计 **1407**（改之前是 7 ⇒ 这一格先红后绿）；
//   ② **无续写**的轮 ⇒ 新键与 `response.usage` 逐字一致（防「加法把兼容路径改了」）；
//   ③ judge / 归一化 / 强制收尾发生过 ⇒ 引擎用量落在另一个键里，**轮账不含它**。
//
// 全部用假 provider（`test/helpers/fake-provider.js`，per-step `usage`），零真实 LLM 调用。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });

/** 主模型三发：700 + 700 + 7 = **1407** 个 `output_tokens`（评审实测的那个量级）。 */
const THREE_SHOT_700_700_7 = [
  { content: [text("part-1")], stopReason: "max_tokens", usage: { input_tokens: 11, output_tokens: 700 } },
  { content: [text("part-2")], stopReason: "max_tokens", usage: { input_tokens: 12, output_tokens: 700 } },
  { content: [text("done")], stopReason: "end_turn", usage: { input_tokens: 13, output_tokens: 7 } },
];

/** 把一次 run 的轮记录收齐（`onRound` 是轮记录落盘后的宿主钩子，拿到的就是那份 record）。 */
function collectRounds() {
  const rounds = [];
  return { rounds, onRound: (record) => rounds.push(record) };
}

const BASE = {
  initialUserMessage: "write",
  executeTool: async () => "unused",
  persistence: "none",
  stallDetection: false,
  completion: false,
};

// ── ① 续写轮：新键必须累计全部三发（本单的核心格；改之前实测 7）────────────────────────────
test("#438 ① 续写轮（700+700+7）：`record.usage` 累计 1407，`record.response.usage` 仍是最后一发的 7", async () => {
  const provider = createFakeProvider(THREE_SHOT_700_700_7);
  const { rounds, onRound } = collectRounds();

  const result = await runToolLoop({ ...BASE, provider, onRound });

  assert.equal(result.rounds, 1, "三发续写合并成**一轮**（续写不是新轮）");
  assert.equal(provider.requests.length, 3, "三次 provider 调用 = 三次真花钱的响应");

  const record = rounds.at(-1);
  // 逐轮账（新键）：三发之和。
  assert.deepEqual(
    record.usage,
    { input_tokens: 36, output_tokens: 1407 },
    `record.usage 必须累计本轮**全部**响应，实际：${JSON.stringify(record.usage)}`,
  );
  // 历史形状（逐字不动）：只含最后一发。
  assert.deepEqual(
    record.response.usage,
    { input_tokens: 13, output_tokens: 7 },
    "record.response.usage 的历史语义是「最后一次响应的 usage」，本单一个字都不改",
  );
  // 无引擎自发起调用 ⇒ 轮记录上不写 engineUsage（缺键 = 没这类开销）。
  assert.equal(
    "engineUsage" in record,
    false,
    `本轮没有 judge/归一化/折叠摘要 ⇒ record 不该有 engineUsage，实际：${JSON.stringify(record.engineUsage)}`,
  );
  // run 级分账：这轮没有引擎开销 ⇒ 两桶就是模型那一份。
  assert.deepEqual(result.modelUsage, { input_tokens: 36, output_tokens: 1407 });
  assert.deepEqual(result.engineUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.usage, { input_tokens: 36, output_tokens: 1407 });
  assert.equal(result.finalText, "part-1part-2done");
});

// ── ② 无续写的轮：新键必须与 `response.usage` 逐字一致（兼容路径不许被「加法」改掉）──────────
test("#438 ② 无续写的轮：`record.usage` 与 `record.response.usage` 逐字一致", async () => {
  const single = {
    content: [text("done")],
    stopReason: "end_turn",
    usage: { input_tokens: 21, output_tokens: 34, cacheRead: 500, cacheWrite: 2 },
  };
  const provider = createFakeProvider([single]);
  const { rounds, onRound } = collectRounds();

  const result = await runToolLoop({ ...BASE, provider, onRound });

  const record = rounds.at(-1);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    record.usage,
    record.response.usage,
    "只有一发响应时，逐轮账必须与历史那份逐字一致（含 cacheRead/cacheWrite 的出现规则）",
  );
  assert.deepEqual(record.usage, single.usage);
  assert.deepEqual(result.modelUsage, single.usage);
  assert.deepEqual(result.engineUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.usage, single.usage);
});

// ── ③a 轮内引擎开销（round judge + 收尾归一化）：进 engine 桶，轮账只装模型三发 ──────────────
test("#438 ③a judge + 归一化的用量进 `engineUsage`，轮账仍是模型三发之和", async () => {
  // judge / 归一化共用同一个 evaluator provider（`reflection.judge.provider`）：
  // 调用次序是**先归一化、后 round judge**（orchestrator 里归一化在 judge 之前）。
  const judgeProvider = createFakeProvider([
    {
      content: [text(JSON.stringify({ done: true, summary: "ok", output: "ok" }))],
      stopReason: "end_turn",
      usage: { input_tokens: 30, output_tokens: 40 },
    },
    {
      content: [text(JSON.stringify({ done: true, confidence: 0.9, reason: "delivered" }))],
      stopReason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 60 },
    },
  ]);
  const provider = createFakeProvider(THREE_SHOT_700_700_7);
  const { rounds, onRound } = collectRounds();

  const result = await runToolLoop({
    ...BASE,
    provider,
    onRound,
    reflection: {
      enabled: true,
      roundJudge: true,
      wrapupNormalize: true,
      judge: { provider: judgeProvider },
    },
  });

  assert.equal(judgeProvider.requests.length, 2, "归一化一次 + round judge 一次 = 两次引擎自发起调用");
  const record = rounds.at(-1);
  // 模型轮账：仍然只有三发，**不含**那两次引擎调用。
  assert.deepEqual(
    record.usage,
    { input_tokens: 36, output_tokens: 1407 },
    `轮账必须只装模型三发，实际：${JSON.stringify(record.usage)}`,
  );
  // 引擎自发起的那两次：另一个键。
  assert.deepEqual(
    record.engineUsage,
    { input_tokens: 80, output_tokens: 100 },
    `引擎用量必须单独记，实际：${JSON.stringify(record.engineUsage)}`,
  );
  assert.notEqual(
    record.engineUsage.output_tokens,
    record.usage.output_tokens,
    "两个键的数值不相等——否则「模型话多」与「引擎开销大」还是分不开",
  );
  // 历史形状照旧：只含最后一发。
  assert.deepEqual(record.response.usage, { input_tokens: 13, output_tokens: 7 });
  // run 级：`usage` = 模型 + 引擎（逐字段相加），两桶各自可读。
  assert.deepEqual(result.modelUsage, { input_tokens: 36, output_tokens: 1407 });
  assert.deepEqual(result.engineUsage, { input_tokens: 80, output_tokens: 100 });
  assert.deepEqual(result.usage, { input_tokens: 116, output_tokens: 1507 });
});

// ── ③b 强制收尾（轮记录之后才发生的引擎调用）：只进 run 级 engine 桶，不追写进轮账 ─────────────
test("#438 ③b 强制收尾的用量只进 `result.engineUsage`，轮账与最后一条轮记录都不含它", async () => {
  // 一轮三发（700+700+7）以 tool_use 收尾 ⇒ 工具执行后轮预算（maxRounds:1）耗尽 ⇒ 强制收尾再发一次。
  const provider = createFakeProvider([
    { content: [text("part-1")], stopReason: "max_tokens", usage: { input_tokens: 11, output_tokens: 700 } },
    { content: [text("part-2")], stopReason: "max_tokens", usage: { input_tokens: 12, output_tokens: 700 } },
    { content: [toolUse("c1")], stopReason: "tool_use", usage: { input_tokens: 13, output_tokens: 7 } },
    {
      content: [text("forced final")],
      stopReason: "end_turn",
      usage: { input_tokens: 90, output_tokens: 30 },
    },
  ]);
  const { rounds, onRound } = collectRounds();

  const result = await runToolLoop({ ...BASE, provider, onRound, maxRounds: 1 });

  assert.equal(result.termination.reason, "max_rounds_cap");
  assert.equal(result.termination.forcedFinal, true, "这一格必须真的走到强制收尾");
  assert.equal(provider.requests.length, 4, "三发模型响应 + 一发强制收尾");

  const record = rounds.at(-1);
  assert.deepEqual(record.usage, { input_tokens: 36, output_tokens: 1407 });
  assert.equal("engineUsage" in record, false, "强制收尾不在轮内 ⇒ 轮记录上不该出现它");
  assert.deepEqual(result.modelUsage, { input_tokens: 36, output_tokens: 1407 });
  assert.deepEqual(
    result.engineUsage,
    { input_tokens: 90, output_tokens: 30 },
    `强制收尾是引擎发起的调用，必须落在 engine 桶，实际：${JSON.stringify(result.engineUsage)}`,
  );
  assert.deepEqual(result.usage, { input_tokens: 126, output_tokens: 1437 });
  assert.equal(result.finalText, "forced final");
});

// ── ④ 没有用量可记的轮：新键是零值而不是缺字段（宿主可以无条件读）─────────────────────────
test("#438 ④ provider 不报 usage ⇒ `record.usage` 是零值对象（不是缺字段）", async () => {
  const provider = createFakeProvider([
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  const { rounds, onRound } = collectRounds();

  const result = await runToolLoop({ ...BASE, provider, onRound });

  const record = rounds.at(-1);
  assert.equal("usage" in record.response, false, "provider 没报 ⇒ 历史那份照旧缺键");
  assert.deepEqual(record.usage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.modelUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.engineUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});
