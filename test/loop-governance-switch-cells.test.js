import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 **F-2** 的行为锚定测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：F-2 把三格「治理开关」从闭包 `let` 迁进 `runLoopState`：
//   · `roundJudgeEnabled`（原 :1202）——end_turn 轮 judge 的总开关，连续失败到上限就地关断；
//   · `roundJudgeFailures`（原 :1209）——它的连续失败计数，判成功即复位；
//   · `wrapupNormalizationEnabled`（原 :1256）——wrapup LLM 归一化开关，失败一次就地关断。
// 这三格的形状是「**初值要在原声明处现算**（读 `:1227` 的 `reflectionEnabled` 与 `:1263` 的 `wrapupEnabled`，早于它们是 TDZ）
// + **运行期被写坏一次就永久关断**」，于是每格都有两条必须各自钉死的路径：
//   · 初值侧：占位 `false` 有没有被原位赋值覆盖（覆盖不到 ⇒ 整条 judge / 归一化路径静默消失）；
//     初值表达式的每一个合取项（`reflectionEnabled` / `roundJudge !== false` / 两个 env /
//     `wrapupEnabled`）各是一个独立判据，写错哪项就少关/多关一种配置；
//   · 写侧：`= false` 关断、`+= 1` 累计、`= 0` 复位——三处都是真行为，丢掉任何一处都会改变
//     「第几轮之后不再调评估器」这个可观察量（下面各用例断言的就是评估器的**请求条数**）。
// 任一格搬坏（初值写成占位没覆盖、写点指错格子、复位丢掉）都必须在下面某条用例上变红。

const ON_TRACK = {
  done: true,
  confidence: 0.9,
  reason: "已完成",
  evidence: "验证通过",
  direction: "on_track",
  directionReason: "已接近验证",
};

const judgeJson = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  stopReason: "end_turn",
});

const textEndTurn = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

const TOOL_ROUND = { content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }], stopReason: "tool_use" };

// end_turn 轮的 judge 请求形状（与 test/judge.test.js 的口径一致），用来把「round judge 调用」
// 与别的评估器调用分开数。
const isRoundJudgeRequest = (request) => request.temperature === 0 && request.maxTokens === 1024;

// reflectionBase 只写开关部分；judge provider 统一由本 helper 注入（脚本可数）。
async function runEndTurnJudge({ reflectionBase, env, judgeScript }) {
  const previous = process.env.ERIX_NO_ROUND_JUDGE;
  if (env !== undefined) process.env.ERIX_NO_ROUND_JUDGE = env;
  const provider = createFakeProvider([textEndTurn("最终答案")]);
  const judge = createFakeProvider(judgeScript);
  const records = [];
  try {
    const result = await runToolLoop({
      provider,
      initialUserMessage: "task",
      executeTool: async () => "ok",
      maxRounds: 4,
      completion: false,
      reflection: { ...reflectionBase, judgeIntercept: false, judge: { provider: judge } },
      capabilities: { hooks: { onJudge: (info) => records.push(info) } },
    });
    return { result, judge, provider, records };
  } finally {
    if (previous === undefined) delete process.env.ERIX_NO_ROUND_JUDGE;
    else process.env.ERIX_NO_ROUND_JUDGE = previous;
  }
}

// —— roundJudgeEnabled：初值侧（占位 false 必须被原声明处的赋值覆盖）——

test("F-2 roundJudgeEnabled 初值：开着的格子让 end_turn 轮走 judge_done（读侧 :3092 拿到的是真值而非占位 false）", async () => {
  const judge = createFakeProvider([judgeJson(ON_TRACK)]);
  const provider = createFakeProvider([textEndTurn("最终答案")]);
  const records = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "task",
    executeTool: async () => "ok",
    maxRounds: 4,
    completion: false,
    reflection: { enabled: true, roundJudge: true, judgeIntercept: false, judge: { provider: judge } },
    capabilities: { hooks: { onJudge: (info) => records.push(info) } },
  });
  assert.equal(judge.requests.filter(isRoundJudgeRequest).length, 1, "初值为真 ⇒ end_turn 轮调用一次 round judge");
  assert.equal(result.termination.reason, "judge_done", "决策被采纳 ⇒ 读点读到的是真值而不是占位 false");
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "judge_done");
  assert.equal(provider.requests.length, 1);
});

test("F-2 roundJudgeEnabled 初值：reflection.roundJudge:false 这一合取项单独把关断", async () => {
  const { result, judge } = await runEndTurnJudge({
    judgeScript: [judgeJson(ON_TRACK)],
    reflectionBase: { enabled: true, roundJudge: false },
  });
  assert.equal(judge.requests.filter(isRoundJudgeRequest).length, 0, "roundJudge:false ⇒ 一次都不调");
  assert.notEqual(result.termination.reason, "judge_done");
});

test("F-2 roundJudgeEnabled 初值：ERIX_NO_ROUND_JUDGE 只认 \"1\"（\"0\" 不把关，env 合取项按 !== \"1\" 求值）", async () => {
  const { judge, result } = await runEndTurnJudge({
    judgeScript: [judgeJson(ON_TRACK)],
    reflectionBase: { enabled: true },
    env: "0",
  });
  assert.equal(judge.requests.filter(isRoundJudgeRequest).length, 1, "env 值不是 \"1\" ⇒ 不关断");
  assert.equal(result.termination.reason, "judge_done");
});

test("F-2 roundJudgeEnabled 初值：ERIX_NO_ROUND_JUDGE=1 把关断（env 合取项的正向半边）", async () => {
  const { judge, result } = await runEndTurnJudge({
    judgeScript: [judgeJson(ON_TRACK)],
    reflectionBase: { enabled: true },
    env: "1",
  });
  assert.equal(judge.requests.filter(isRoundJudgeRequest).length, 0, "env=1 ⇒ 一次都不调");
  assert.notEqual(result.termination.reason, "judge_done");
});

// —— roundJudgeEnabled + roundJudgeFailures：写侧（parse 失败分支，与 throw 分支各自独立）——

// 固定骨架：第 1 轮跑一次工具（让 hadToolUse 为真），后面全是非 JSON 的 end_turn 轮；
// 轮数由 maxRounds 钉死，评估器的**请求条数**就是本组三格的可观察量。
const JUDGE_PROVIDER_SCRIPT = [
  TOOL_ROUND,
  { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn", times: 7 },
];
const GARBAGE = { content: [{ type: "text", text: "这不是 JSON" }] };
const NOT_DONE = judgeJson({
  done: false,
  confidence: 0.2,
  reason: "还差一步",
  evidence: "未验证",
  direction: "off_track",
  directionReason: "仍在推进",
});

async function runFailureFixture({ judgeScript, maxRounds, judgeFailureLimit, withOnJudge = true }) {
  const provider = createFakeProvider(JUDGE_PROVIDER_SCRIPT);
  const judge = createFakeProvider(judgeScript);
  const records = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    maxRounds,
    completion: { signals: [], maxNoToolRounds: 9 },
    reflection: { enabled: true, judgeFailureLimit, judgeIntercept: false, judge: { provider: judge } },
    ...(withOnJudge
      ? { capabilities: { hooks: { onJudge: (info) => records.push(info) } } }
      : {}),
  });
  return { result, judge, provider, records };
}

test("F-2 roundJudgeEnabled 写侧：parse 连续失败到上限即把格子置 false，后续 end_turn 轮不再调 judge", async () => {
  // maxRounds 7 ⇒ 6 个 end_turn 轮（第 2..7 轮），上限 2 ⇒ 只有第 2、3 轮会真调评估器
  const { result, judge, records } = await runFailureFixture({
    judgeScript: [{ ...GARBAGE, times: 8 }],
    maxRounds: 7,
    judgeFailureLimit: 2,
  });
  assert.equal(judge.requests.length, 2, "计数到达上限后关断 ⇒ 评估器请求停在 2 条（关断丢失则是 6 条）");
  assert.equal(records.length, 2, "关断后一条 judge 记录都不再产生");
  assert.deepEqual(
    records.map((r) => [r.kind, r.action, r.error]),
    [["round", "degraded", "parse"], ["round", "degraded", "parse"]],
  );
  assert.equal(result.rounds, 7, "关断只关 judge，loop 照常推进到预算用尽");
});

// —— roundJudgeFailures：= 0 复位（判成功即重新起算）——

test("F-2 roundJudgeFailures 复位（parse 分支）：judge 判成功把计数写回 0，连续失败重新起算", async () => {
  // 6 个 end_turn 轮：失败、失败、**成功**、失败、失败、失败 ⇒ 计数 1→2→**0**→1→2→3（上限 3，
  // 第 7 轮才到顶）⇒ 六轮全都调了评估器；复位一旦丢失，第 5 轮就提前关断（只剩 4 条请求）。
  const { judge, records } = await runFailureFixture({
    judgeScript: [GARBAGE, GARBAGE, NOT_DONE, GARBAGE, GARBAGE, GARBAGE],
    maxRounds: 7,
    judgeFailureLimit: 3,
  });
  assert.equal(judge.requests.length, 6, "复位生效 ⇒ 六个 end_turn 轮各调一次；复位丢失则停在 4");
  assert.deepEqual(
    records.map((r) => r.action),
    ["degraded", "degraded", "nudge", "degraded", "degraded", "degraded"],
  );
});

test("F-2 roundJudgeFailures 复位（抛错分支）：成功轮把计数归零，抛错分支的 += 也走同一格", async () => {
  // 5 个 end_turn 轮（maxRounds 6）：抛错、抛错、**成功**、抛错、抛错 ⇒ 1→2→**0**→1→2，上限 3
  // ⇒ 全程不关断；复位丢失则第 5 轮就到顶（只剩 4 条请求）。
  const boom = { throw: new Error("judge down") };
  const { judge, records } = await runFailureFixture({
    judgeScript: [boom, boom, NOT_DONE, boom, boom],
    maxRounds: 6,
    judgeFailureLimit: 3,
  });
  assert.equal(judge.requests.length, 5, "复位生效 ⇒ 五个 end_turn 轮都调过；复位丢失则停在 4");
  assert.deepEqual(
    records.map((r) => [r.action, r.error]),
    [["degraded", "error"], ["degraded", "error"], ["nudge", undefined], ["degraded", "error"], ["degraded", "error"]],
  );
});

// —— wrapupNormalizationEnabled：初值侧 + 写侧 ——

// reflectionBase 只写开关部分；归一化评估器（wrapupEvaluator）统一由本 helper 注入，
// 这样「归一化器被调了几次」可以直接数 normalizer.requests。
async function runNormalizeCase({ env, reflectionBase, wrapup, normalizeText, providerScript }) {
  const previous = process.env.ERIX_WRAPUP_NORMALIZE;
  if (env === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
  else process.env.ERIX_WRAPUP_NORMALIZE = env;
  const provider = createFakeProvider(providerScript);
  const normalizer = createFakeProvider([{ content: [{ type: "text", text: normalizeText }], times: 8 }]);
  const reflection = {
    ...(reflectionBase ?? {}),
    judgeIntercept: false,
    roundJudge: false,
    judge: { provider: normalizer },
  };
  try {
    const result = await runToolLoop({
      provider,
      initialUserMessage: "工作",
      executeTool: async () => "ok",
      maxRounds: 4,
      completion: { signals: [], maxNoToolRounds: 9 },
      ...(wrapup === undefined ? {} : { wrapup }),
      reflection,
    });
    return { result, provider, normalizer };
  } finally {
    if (previous === undefined) delete process.env.ERIX_WRAPUP_NORMALIZE;
    else process.env.ERIX_WRAPUP_NORMALIZE = previous;
  }
}

// 固定骨架：1 个工具轮 + 3 个非 JSON 的 end_turn 轮（maxRounds 4 钉死），归一化器的请求
// 条数只能落在 0 / 1 / 3 三个值上，分别对应「初值关」「写侧关断」「逐轮都调」。
const NON_JSON_ROUNDS = [
  TOOL_ROUND,
  { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn", times: 4 },
];

test("F-2 wrapupNormalizationEnabled 初值：默认关闭 ⇒ 非 JSON 的 end_turn 轮一次都不调归一化器", async () => {
  const { provider, normalizer } = await runNormalizeCase({
    reflectionBase: {},
    normalizeText: "这不是 JSON",
    providerScript: NON_JSON_ROUNDS,
  });
  assert.equal(normalizer.requests.length, 0, "初值关 ⇒ 归一化路径整段不进");
  assert.equal(provider.requests.length, 4, "主 provider 只跑了 1 个工具轮 + 3 个 end_turn 轮");
});

test("F-2 wrapupNormalizationEnabled 初值：ERIX_WRAPUP_NORMALIZE=1 打开格子（读侧 :2975 拿到真值，逐轮都调）", async () => {
  const { result, normalizer } = await runNormalizeCase({
    env: "1",
    reflectionBase: {},
    normalizeText: JSON.stringify({ done: false, summary: "进展：做了一半" }),
    providerScript: NON_JSON_ROUNDS,
  });
  assert.equal(normalizer.requests.length, 3, "开关开着 ⇒ 三个非 JSON end_turn 轮各调一次");
  assert.match(result.finalText, /还在处理中/);
});

test("F-2 wrapupNormalizationEnabled 初值：reflection.wrapupNormalize===true 这条合取项单独把关", async () => {
  const { normalizer } = await runNormalizeCase({
    reflectionBase: { wrapupNormalize: true },
    normalizeText: JSON.stringify({ done: false, summary: "进展：做了一半" }),
    providerScript: NON_JSON_ROUNDS,
  });
  assert.equal(normalizer.requests.length, 3, "reflection.wrapupNormalize 单独就能打开");
});

test("F-2 wrapupNormalizationEnabled 初值：wrapup:false 时归一化恒关（wrapupEnabled 是 const，不是格子）", async () => {
  const { normalizer } = await runNormalizeCase({
    env: "1",
    wrapup: false,
    reflectionBase: { wrapupNormalize: true },
    normalizeText: JSON.stringify({ done: false, summary: "进展：做了一半" }),
    providerScript: NON_JSON_ROUNDS,
  });
  assert.equal(normalizer.requests.length, 0, "wrapup 整体关掉 ⇒ 归一化开关恒 false（第一合取项）");
});

test("F-2 wrapupNormalizationEnabled 写侧：归一化器输出不是 JSON ⇒ 格子就地关断，后续 end_turn 轮不再调", async () => {
  const { normalizer, provider } = await runNormalizeCase({
    reflectionBase: { wrapupNormalize: true },
    normalizeText: "这不是 JSON",
    providerScript: NON_JSON_ROUNDS,
  });
  assert.equal(normalizer.requests.length, 1, "失败一次即关断 ⇒ 请求停在 1 条（关断丢失则是 3 条）");
  assert.equal(provider.requests.length, 4, "关断只关归一化，loop 照常推进到 4 轮");
});
