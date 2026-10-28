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
// 判据（工单要求的 ①②③ + 评审退回后补的 ⑤⑥）：
//   ① 三响应 700+700+7 ⇒ 新键累计 **1407**（改之前是 7 ⇒ 这一格先红后绿）；
//   ② **无续写**的轮 ⇒ 新键与 `response.usage` 逐字一致（防「加法把兼容路径改了」）；
//   ③ judge / 归一化 / 强制收尾发生过 ⇒ 引擎用量落在另一个键里，**轮账不含它**；
//   ④ provider 不报用量 ⇒ 新键是零值对象，不是缺字段；
//   ⑤ **跨轮不串账**：两轮各一发 ⇒ 两条轮记录各装自己那一发（评审变异「删掉轮桶清零」在这里红：
//      round 2 会从 {200,34} 变成 {300,734}）；
//   ⑥ **折叠摘要进当轮 `engineUsage`**：双通道假 provider 按 `SUMMARY_SYSTEM` 分流，摘要那发
//      （900/50）落在它发生的轮 2，且**不进**轮账（评审另两个变异在这里红：清零挪到
//      `compactBeforeRound` 之后 ⇒ engineUsage 变 undefined；摘要器标成 `model` ⇒ usage 变 {1000,70}）。
//   ⑤⑥ 就是评审「三个方向零测试背书、变异全绿」那一格的补丁——三个变异各自的三态见
//   CHANGELOG 的 #438 条目。
//
// 全部用假 provider（`test/helpers/fake-provider.js`，per-step `usage`），零真实 LLM 调用。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const text = (value) => ({ type: "text", text: value });
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { step: id } });

/** 主模型三发：700 + 700 + 7 = **1407** 个 `output_tokens`（评审实测的那个量级）。 */
const THREE_SHOT_700_700_7 = [
  { content: [text("part-1")], stopReason: "max_tokens", usage: { input_tokens: 11, output_tokens: 700 } },
  { content: [text("part-2")], stopReason: "max_tokens", usage: { input_tokens: 12, output_tokens: 700 } },
  { content: [text("done")], stopReason: "end_turn", usage: { input_tokens: 13, output_tokens: 7 } },
];

/** 把一次 run 的轮记录收齐（`onRound` 是轮记录落盘后的宿主钩子，拿到的就是那份 record）。
 *  规位写法：钩子住 `capabilities.hooks`，辅助函数直接把**容器**交回去（`{ ...BASE, ...capabilities }`），
 *  于是每一格都只写一侧，不再出现「扁平 `onRound` + 容器」两个真相来源。 */
function collectRounds() {
  const rounds = [];
  return { rounds, capabilities: { hooks: { onRound: (record) => rounds.push(record) } } };
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
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({ ...BASE, provider, capabilities }));

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
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({ ...BASE, provider, capabilities }));

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
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({
    ...BASE,
    provider,
    capabilities,
    reflection: {
      enabled: true,
      roundJudge: true,
      wrapupNormalize: true,
      judge: { provider: judgeProvider },
    },
  }));

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
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({ ...BASE, provider, capabilities, maxRounds: 1 }));

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
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({ ...BASE, provider, capabilities }));

  const record = rounds.at(-1);
  assert.equal("usage" in record.response, false, "provider 没报 ⇒ 历史那份照旧缺键");
  assert.deepEqual(record.usage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.modelUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.engineUsage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

// ── ⑤ 跨轮不串账：轮桶必须**每轮从零开始**（评审变异：删掉清零 ⇒ 本格红）────────────────────
//
// 变异现场（评审实测）：把轮桶的清零整段删掉 ⇒ round 2 的 `record.usage` 从 `{200,34}` 变成
// `{300,734}`——上一轮的用量被吞进下一轮。清零点的位置同样是被钉住的：它必须落在
// `round_start` 之后、`compactBeforeRound` **之前**（见下一格 ⑥）。
test("#438 ⑤ 两轮各自一发：`rounds[0].usage` 只有第一发，`rounds[1].usage` 只有第二发（轮桶逐轮从零起）", async () => {
  // round 1 一发 100/700 以 tool_use 收尾（消耗 700 个 output_tokens），round 2 一发 200/34 收尾。
  const provider = createFakeProvider([
    { content: [toolUse("t1")], stopReason: "tool_use", usage: { input_tokens: 100, output_tokens: 700 } },
    { content: [text("done")], stopReason: "end_turn", usage: { input_tokens: 200, output_tokens: 34 } },
  ]);
  const { rounds, capabilities } = collectRounds();

  const result = await runToolLoop(withSeed({ ...BASE, provider, capabilities }));

  assert.equal(result.rounds, 2, "两轮（第一轮 tool_use，第二轮 end_turn）");
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds[0].usage,
    { input_tokens: 100, output_tokens: 700 },
    `round 1 的轮账只能是它自己那一发，实际：${JSON.stringify(rounds[0].usage)}`,
  );
  assert.deepEqual(
    rounds[1].usage,
    { input_tokens: 200, output_tokens: 34 },
    `round 2 的轮账必须从零起（吞进 round 1 就变成 {300,734}），实际：${JSON.stringify(rounds[1].usage)}`,
  );
  // run 级仍然是两轮之和：轮账「逐轮」与 run 账「累计」是两件事，别把前者也做成累计。
  assert.deepEqual(result.modelUsage, { input_tokens: 300, output_tokens: 734 });
  assert.deepEqual(result.usage, { input_tokens: 300, output_tokens: 734 });
});

// ── ⑥ 折叠摘要（引擎自发起）进**当轮**的 `engineUsage`，且轮账不含它 ──────────────────────────
//
// 两处变异被这一格钉住：
//   · 把清零挪到 `compactBeforeRound` **之后** ⇒ 折叠摘要那一发（900/50）被清零吞掉，
//     round 2/3 的 `record.engineUsage` 从 `{900,50}` 变成 `undefined`；
//   · 把折叠摘要器标成 `account:"model"` ⇒ 它进了轮账，`record.usage` 从 `{100,20}` 变成 `{1000,70}`。
//
// provider 是**双通道**的（与 `test/loop-persist-compaction-facts.test.js` 同口径）：按 system 前缀
// 认折叠摘要器，主循环走脚本。全部是假 provider，零真实 LLM 调用。
const SUMMARY_SYSTEM = "你是对话历史压缩器";

function createFoldProvider({ mainScript }) {
  const summaryRequests = [];
  const mainRequests = [];
  let mainIndex = 0;
  let summaryIndex = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    summaryRequests,
    mainRequests,
    get summaryCalls() {
      return summaryIndex;
    },
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryRequests.push(request);
        summaryIndex += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nSUMMARY_V${String(summaryIndex)}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

test("#438 ⑥ 折叠摘要那一发（900/50）落在**当轮** `record.engineUsage`，轮账只有模型那发", async () => {
  const provider = createFoldProvider({
    mainScript: [
      { content: [toolUse("f1")], stopReason: "tool_use" },
      { content: [text("收尾结论")], stopReason: "end_turn" },
    ],
  });
  const { rounds, capabilities } = collectRounds();

  const result = await runDirect({
    ...BASE,
    provider,
    capabilities,
    maxRounds: 2,
    reflection: false,
    initialUserMessage: `start ${"y".repeat(600)}`,
    executeTool: async () => `tool output ${"z".repeat(400)}`,
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" } } },
  });

  // 前置：这一格必须**真的**发生过一次折叠摘要（否则下面的断言是空断言）。
  assert.equal(provider.summaryCalls, 1, "本用例必须真的触发一次 fold-llm 摘要");

  // 摘要发生的那一轮 = 轮 2（轮 1 的历史还不足以触发折叠）。**按轮号取**，不按「谁带了
  // engineUsage」取——否则「这一发被丢掉了」会让 find 落空，红在一个看不出症状的地方。
  const foldRound = rounds.find((record) => record.round === 2);
  assert.ok(foldRound !== undefined, "本用例必须有轮 2 的轮记录");
  // 轮账（模型桶）不含摘要那一发：这一轮只有一发模型响应 100/20，摘要的 900/50 一个字都不许进来。
  assert.deepEqual(
    foldRound.usage,
    { input_tokens: 100, output_tokens: 20 },
    `轮账只装模型输出（摘要器被标成 model 就会变成 {1000,70}），实际：${JSON.stringify(foldRound.usage)}`,
  );
  assert.deepEqual(
    foldRound.engineUsage,
    { input_tokens: 900, output_tokens: 50 },
    `折叠摘要的用量必须记进**它发生的那一轮**（丢了或挪到别的轮都是这里红），实际：${JSON.stringify(foldRound.engineUsage)}`,
  );
  // 归属钉死：整场只有轮 2 带 engineUsage（挪到轮 1 / 轮 3 都红）。
  assert.deepEqual(
    rounds.filter((record) => record.engineUsage !== undefined).map((record) => record.round),
    [2],
    "摘要只发生一次 ⇒ 恰好轮 2 带 engineUsage",
  );
  assert.notEqual(foldRound.usage.input_tokens, foldRound.engineUsage.input_tokens,
    "两个桶的数值必须可区分，否则「模型话多」与「引擎开销大」还是分不开");

  // 其余轮：没有引擎调用 ⇒ 缺键（不是零值）。
  for (const record of rounds) {
    if (record === foldRound) continue;
    assert.equal("engineUsage" in record, false,
      `round ${String(record.round)} 没有引擎调用 ⇒ 不该有 engineUsage`);
    assert.deepEqual(record.usage, { input_tokens: 100, output_tokens: 20 });
  }

  // run 级：`usage` = 模型两发（两轮各一发 100/20）+ 引擎一发，逐字段相加。
  assert.deepEqual(result.modelUsage, { input_tokens: 200, output_tokens: 40 });
  assert.deepEqual(result.engineUsage, { input_tokens: 900, output_tokens: 50 });
  assert.deepEqual(result.usage, { input_tokens: 1100, output_tokens: 90 });
});
