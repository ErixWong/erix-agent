// @ts-check
// issue #785 P1 ②：**实发值可观测**——「宿主给的 reasoning 值」与「最终写进请求体的值」必须在落盘产物里
// 两个都在，且各是各的。
//
// 为什么需要这格（2026-11-08 真上游探针三条事实里的第二条）：**顶层未知键被上游 200 静默吞**（正文干净，
// 但 usage 显示仍在推理）⇒ 这类错误不报错、不降级，**只有落盘能看见**。而账本里原先没有任何请求参数格子，
// 「实际发出去的 effort 是多少、有没有被 payload 层翻译过（GLM `none→low`）」在盘上查不到。
//
// 判据（反向可证，逐条写明改坏哪一行会红）：
//   A GLM 那一格：宿主输入 `none`、最终发出 `low`，**两者都留痕**，且 `hostValue` 不许是 `low`
//     （改坏 `payload.js` 里 `hostValue` 的取值——让它读已翻译后的 payload ⇒ 本格红）；
//   B 来源通道四个都要能分辨：request 覆盖 / slot 默认 / providerOptions / extraBody
//     （把 `observeSentReasoningParams` 里那条优先级改坏 ⇒ 对应那一格红）；
//   C 无相关键 ⇒ **整格不产出**（把 `return undefined` 改成 `return { reasoningEffort: {...} }` ⇒ C 红）；
//   D 真 provider 的 wire body 与观测值必须同源（用 `createMockFetch` 抓真请求体对账，
//     不是信观测器自述：把 payload 组装改了而观测器没改 ⇒ D 红）；
//   E 轮记录里真的带着这格（走真循环 + onRound，拿的是落盘那份 record）。
//
// 零真实 LLM 调用：全部 `createMockFetch`（`test/helpers/mock-fetch.js` 的现成先例）。
import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIProvider } from "../src/providers/openai.js";
import { observeSentReasoningParams } from "../src/providers/payload.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMockFetch } from "./helpers/mock-fetch.js";

const ENDPOINT = "https://api.example.test/v1";
const okJson = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };

function makeProvider({ model, fetchImpl, ...rest }) {
  return createOpenAIProvider({ endpoint: ENDPOINT, apiKey: "test-key", model, fetchImpl, ...rest });
}

async function sentParamsFor({ model, providerOptions = {}, request = {} }) {
  const fetchImpl = createMockFetch([{ json: okJson }]);
  const provider = makeProvider({ model, fetchImpl, ...providerOptions });
  const response = await provider.chat({
    system: "",
    messages: [{ role: "user", content: "hi" }],
    ...request,
  });
  return { body: fetchImpl.calls[0].body, response };
}

test("A. GLM：宿主给 none、最终发出 low，两个都留痕且 hostValue 没被写成翻译后的 low", async () => {
  const { body, response } = await sentParamsFor({
    model: "glm-5.3-flash-awq",
    request: { reasoning_effort: "none" },
  });
  // 载荷层真的翻译了（ADR-017 的行为，本片一格没动它）
  assert.equal(body.reasoning_effort, "low", "wire body 必须是翻译后的 low");
  assert.deepEqual(response.sentRequestParams, {
    reasoningEffort: {
      hostValue: "none",
      sentValue: "low",
      source: "request",
      translated: true,
    },
  }, "GLM 那格必须同时留「宿主给的值」与「最终发出的值」");
});

test("B. 来源通道分得清：request 覆盖 / slot 默认 / providerOptions / extraBody", async () => {
  const fromRequest = await sentParamsFor({
    model: "qwen3.8-flash-next",
    providerOptions: { reasoning_effort: "medium" },
    request: { reasoning_effort: "high" },
  });
  assert.equal(fromRequest.response.sentRequestParams.reasoningEffort.source, "request");
  assert.equal(fromRequest.response.sentRequestParams.reasoningEffort.hostValue, "high");
  assert.equal(fromRequest.body.reasoning_effort, "high");

  const fromSlot = await sentParamsFor({
    model: "qwen3.8-flash-next",
    providerOptions: { reasoning_effort: "medium" },
  });
  assert.equal(fromSlot.response.sentRequestParams.reasoningEffort.source, "slotDefault");
  assert.equal(fromSlot.response.sentRequestParams.reasoningEffort.sentValue, "medium");

  const fromProviderOptions = await sentParamsFor({
    model: "qwen3.8-flash-next",
    providerOptions: { providerOptions: { openai: { reasoning_effort: "minimal" } } },
  });
  assert.equal(
    fromProviderOptions.response.sentRequestParams.reasoningEffort.source,
    "providerOptions",
  );
  assert.equal(fromProviderOptions.body.reasoning_effort, "minimal");

  const fromExtraBody = await sentParamsFor({
    model: "qwen3.8-flash-next",
    providerOptions: { extraBody: { reasoning_effort: "xhigh" } },
  });
  assert.equal(fromExtraBody.response.sentRequestParams.reasoningEffort.source, "extraBody");
  assert.equal(fromExtraBody.body.reasoning_effort, "xhigh");
});

test("C. 无相关键 ⇒ 整格不存在（不产空对象噪声），provider 响应里也没这格", async () => {
  assert.equal(
    observeSentReasoningParams({ payload: { model: "m", messages: [] } }),
    undefined,
    "payload 里没有 reasoning 相关键 ⇒ 返回 undefined",
  );
  const { body, response } = await sentParamsFor({ model: "qwen3.8-flash-next" });
  assert.equal(
    Object.hasOwn(body, "reasoning_effort"),
    false,
    "没发就不该出现在 wire body 上",
  );
  assert.equal(
    Object.hasOwn(response, "sentRequestParams"),
    false,
    `没发就不该有这格，实际键集 = ${JSON.stringify(Object.keys(response))}`,
  );
});

test("D. 观测值与真请求体同源（观测器说的 sentValue 必须等于真发出去的那一发）", async () => {
  const cases = [
    { model: "qwen3.8-flash-next", request: { reasoning_effort: "none" }, want: "none" },
    { model: "z-ai/glm-5.2", request: { reasoning_effort: "none" }, want: "low" },
    { model: "deepseek-flash", request: { reasoning_effort: "low" }, want: "low" },
  ];
  for (const testCase of cases) {
    const { body, response } = await sentParamsFor(testCase);
    assert.equal(
      response.sentRequestParams.reasoningEffort.sentValue,
      body.reasoning_effort,
      `${testCase.model}：观测的 sentValue 必须逐字等于 wire body 里的值`,
    );
    assert.equal(body.reasoning_effort, testCase.want, testCase.model);
  }
});

test("E. 轮记录带着这格落盘；无相关键的那一轮没有这格", async () => {
  const fetchImpl = createMockFetch([
    { json: { ...okJson, usage: { prompt_tokens: 9, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 4 } } } },
    { json: okJson },
  ]);
  const mainProvider = makeProvider({
    model: "glm-5.3-flash-awq",
    fetchImpl,
    reasoning_effort: "none",
  });
  /** @type {any[]} */
  const rounds = [];
  await runDirect({
    provider: mainProvider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 1,
    stallDetection: false,
    persistence: "none",
    completion: false,
    capabilities: { hooks: { onRound: (/** @type {any} */ record) => rounds.push(record) } },
  });
  assert.equal(rounds.length, 1, "一轮 ⇒ 一条轮记录");
  assert.deepEqual(rounds[0].sentRequestParams, {
    reasoningEffort: { hostValue: "none", sentValue: "low", source: "slotDefault", translated: true },
  });
  // ①的落盘腿：上游回报的推理 token 也随 response.usage 进了轮记录
  assert.deepEqual(rounds[0].response.usage, {
    input_tokens: 9,
    output_tokens: 4,
    reasoningTokens: 4,
  });

  const quietFetch = createMockFetch([{
    json: { ...okJson, usage: { prompt_tokens: 1, completion_tokens: 1 } },
  }]);
  /** @type {any[]} */
  const quietRounds = [];
  await runDirect({
    provider: makeProvider({ model: "qwen3.8-flash-next", fetchImpl: quietFetch }),
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 1,
    stallDetection: false,
    persistence: "none",
    completion: false,
    capabilities: { hooks: { onRound: (/** @type {any} */ record) => quietRounds.push(record) } },
  });
  assert.equal(
    Object.hasOwn(quietRounds[0], "sentRequestParams"),
    false,
    "无相关键的轮不许长出一个空格子（无值不产噪声）",
  );
  assert.equal(
    Object.hasOwn(quietRounds[0].response.usage, "reasoningTokens"),
    false,
    "上游没回报推理 token ⇒ 落盘的 usage 里也不许出现该键",
  );
});

test("F. 宿主自建 provider：引擎观测不到最终 wire body ⇒ 该格缺席（边界，不是「没发」）", async () => {
  /** @type {any[]} */
  const rounds = [];
  const hostProvider = createFakeProvider([
    { content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider: hostProvider,
    initialUserMessage: "go",
    executeTool: async () => "ok",
    maxRounds: 1,
    stallDetection: false,
    persistence: "none",
    completion: false,
    capabilities: { hooks: { onRound: (/** @type {any} */ record) => rounds.push(record) } },
  });
  assert.equal(
    Object.hasOwn(rounds[0], "sentRequestParams"),
    false,
    "宿主自建 provider 交不出 wire body ⇒ 缺席读作「未观测」，绝不能被写成「没发」",
  );
});
