import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import {
  NORMALIZATION_REASONING_EFFORT,
  normalizeWrapupWithLlm,
} from "../src/reflection/wrapup.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMockFetch } from "./helpers/mock-fetch.js";

// issue #419 ① **后半段**：跑真循环，钉住「循环里那份内联归一化请求」也带
// `reasoning_effort:"none"`。
//
// 为什么需要这个文件（前半段测试盖不到的那一格）：
//   · `normalizeWrapupWithLlm`（`src/reflection/wrapup.js`）全仓只有两处：`src/index.js` 导出、
//     以及它自己的定义 —— **引擎循环从来没调用过它**（issue #430 顺手删掉了 orchestrator 顶部那条
//     死 import；函数本体保留：它是公开导出，契约中英各一处符号锚点）。
//   · 循环里真正在跑的收尾归一化是 `src/loop/orchestrator.js` 里 `requestForJudge` 那段内联请求
//     （触发条件 `wrapupJson === null && stopReason === "end_turn" && !hasToolUse(...)`）。
//   所以「库函数发了 reasoning_effort」不等于「真上游那次请求发了」——后者只有跑真循环才看得见。
//   `test/wrapup.test.js` 那两格（#419 ① 前半段）证的是库函数的请求体，盖不到这里。
//
// **注入层选择（以及为什么不选另一层）**：
//   `runToolLoop({ reflection: { judge: { provider } } })`。`src/loop/orchestrator.js:1396` 的
//   `wrapupEvaluator = judgeConfig?.provider ?? judgeConfig?.evaluator ?? provider` 是归一化
//   evaluator 的唯一来源；注入到 `judge.provider` 这一层，
//     ① 归一化请求与主 provider 的请求**分属两条流**（`normalizer.requests` / `provider.requests`），
//        于是「这条请求体是不是归一化那条」不需要靠调用顺序去猜（对照 `test/wrapup.test.js` 里
//        「空文本 end_turn」那格：它不注入 judge，归一化响应和模型轮共用同一个假脚本，请求体被
//        混在一条 `requests` 里，拿不到「哪一条是归一化」）；
//     ② 计数口径与既有夹具一致（`test/loop-governance-switch-cells.test.js` 的 `runNormalizeCase`
//        用同一层数 `normalizer.requests.length`）。
//   注：本仓**没有** `currentJudgeProvider` 这个标识符（`grep -rn currentJudgeProvider src/ bin/`
//   为空），归一化 evaluator 的解析就是上面那一行三元。

const TOOL_ROUND = {
  content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
  stopReason: "tool_use",
};

// 收尾文本**不含**完成标记（不是 JSON 信封、也没有 completion signal），且全程不给 finalGuard ⇒
// 正好落在内联归一化的触发条件上。3 个非 JSON 的 end_turn 轮 + `maxRounds: 4` 钉死轮数。
const NON_JSON_ROUNDS = [
  TOOL_ROUND,
  { content: [{ type: "text", text: "还在处理中" }], stopReason: "end_turn", times: 4 },
];

const DONE_FALSE_JSON = JSON.stringify({ done: false, summary: "进展：做了一半" });

// 归一化请求的身份判据：内联那段自己的 system 提示词（`requestForJudge.system`）。
const isInlineNormalizationRequest = (request) => /归一化/.test(String(request?.system ?? ""));

async function runLoopWithNormalizer({ normalizer, maxRounds = 4 }) {
  const provider = createFakeProvider(NON_JSON_ROUNDS);
  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    maxRounds,
    // 收尾文本不含标记（signals 为空）+ 不给 finalGuard：与 `test/wrapup.test.js` 的
    // 「空文本 end_turn 也归一化」同一骨架。
    completion: { signals: [], maxNoToolRounds: 9 },
    reflection: {
      wrapupNormalize: true,
      roundJudge: false,
      judgeIntercept: false,
      judge: { provider: normalizer },
    },
  });
  return { result, provider };
}

test("真循环：内联收尾归一化请求体带 reasoning_effort:\"none\"（issue #419 ① 后半段）", async () => {
  const normalizer = createFakeProvider([{ content: [{ type: "text", text: DONE_FALSE_JSON }], times: 8 }]);
  const { result, provider } = await runLoopWithNormalizer({ normalizer });

  // 先证「我们观察到的确实是归一化那条路」——否则后面的断言可能只是在空数组上空转。
  assert.equal(normalizer.requests.length, 3, "3 个非 JSON 的 end_turn 轮各触发一次内联归一化");
  assert.ok(
    normalizer.requests.every(isInlineNormalizationRequest),
    "捕获到的每条请求都是归一化请求（system 提示词含「归一化」）",
  );
  // 钉住本单的核心：内联那次请求也带 reasoning_effort:"none"。
  for (const [index, request] of normalizer.requests.entries()) {
    assert.equal(
      request.reasoning_effort,
      "none",
      `第 ${index + 1} 次内联归一化请求必须带 reasoning_effort:"none"（实际 ${JSON.stringify(request.reasoning_effort)}）`,
    );
  }
  // 反向钉（判别力）：主 provider 的模型轮**不带**这个字段 ⇒ 上面的命中来自归一化分支，
  // 不是「某个地方无差别地往所有请求上贴字段」。
  assert.equal(
    Object.hasOwn(provider.requests[0], "reasoning_effort"),
    false,
    "主 provider 的模型轮不该带 reasoning_effort",
  );
  // 归一化没改写 done:false 的语义：loop 照常推进到 maxRounds，正文仍是模型原文。
  assert.equal(result.rounds, 4);
  assert.match(result.finalText, /还在处理中/);
});

test("两处共用同一个常量：内联请求与 normalizeWrapupWithLlm 发的是同一个值（不许各写各的字面量）", async () => {
  const normalizer = createFakeProvider([{ content: [{ type: "text", text: DONE_FALSE_JSON }], times: 8 }]);
  await runLoopWithNormalizer({ normalizer });
  const inlineValue = normalizer.requests[0].reasoning_effort;

  // 库函数那一侧（同一个假 evaluator 手法，见 `test/wrapup.test.js` 的前半段用例）
  const libraryRequests = [];
  await normalizeWrapupWithLlm("已完成", {
    async chat(request) {
      libraryRequests.push(request);
      return { content: [{ type: "text", text: '{"done":true,"summary":"s","output":"o"}' }] };
    },
  });

  assert.equal(NORMALIZATION_REASONING_EFFORT, "none", "常量取值就是 none");
  assert.equal(inlineValue, NORMALIZATION_REASONING_EFFORT, "内联请求引用的是这个常量");
  assert.equal(
    libraryRequests[0].reasoning_effort,
    inlineValue,
    "两处发的是同一个值（任一处改成别的字面量，这里必红）",
  );
});

test("真循环 + 真 provider：内联归一化的 HTTP 请求体里就有 reasoning_effort:\"none\"（落到载荷层）", async () => {
  const fetchImpl = createMockFetch(
    Array.from({ length: 4 }, () => ({
      json: {
        choices: [{
          message: { content: DONE_FALSE_JSON },
          finish_reason: "stop",
        }],
      },
    })),
  );
  const judgeProvider = createOpenAIProvider({
    endpoint: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "qwen3.8-flash-next",
    fetchImpl,
  });

  const { provider } = await runLoopWithNormalizer({ normalizer: judgeProvider });

  assert.equal(provider.requests.length, 4, "主 provider（假）跑满 4 轮");
  assert.equal(fetchImpl.calls.length, 3, "真 provider 只被归一化调用（roundJudge/judgeIntercept 都关）");
  for (const [index, call] of fetchImpl.calls.entries()) {
    assert.equal(
      call.body.reasoning_effort,
      "none",
      `第 ${index + 1} 次内联归一化的 HTTP body 必须带 reasoning_effort:"none"（实际 ${JSON.stringify(call.body.reasoning_effort)}）`,
    );
  }
});
