// issue #406 B2-b：让**引擎内联那条**收尾归一化改调统一入口（`normalizeWrapupText`
// → `normalizeModelJson`），并把公开入口 `normalizeWrapupWithLlm` 改成同一入口的薄壳。
//
// 本文件只钉「两条路径是不是同一个实现」与由此产生的可观察行为（全部假 provider，零真实 LLM）：
//   1. **先红的一格**：同一段原文，引擎内联请求与公开入口请求**逐字相同**（system + messages +
//      思考取值），且同一份归一化器回答在两条路径上得到**逐字相同**的信封（findings 被同一道
//      闸门判掉）。改前：内联那份自带一份提示词（含 taskBrief/轮数），公开入口是另一份 ⇒ 必红。
//   2. **闸门对原文判**：归一化器把 `http\.request` 改写成 `http.request` 时，拿**修后/回答**文本
//      当 `source` 会放行；闸门闭包捕获的是 agent 原文，所以必须判掉。
//   3. **思考恒关**：两条路径的请求都带 `reasoning_effort:"none"`，且不自创别的开关。
//   4. **失败可见**：归一化器答非 JSON ⇒ 请求停在 1 条（开关就地关断），loop 不崩、终稿仍是
//      模型原文；公开入口返回 `null`。这是 B2-b 之前的既有事实，本单不顺手改语义。
//   5. **L1 命中就不发请求**：尾逗号 / 非法转义这两种以前会走 LLM 的形状，现在由确定性修复层
//      解析（值逐字保留），归一化器一次都不被调——统一入口的直接后果，钉住免得回退。

import test from "node:test";
import assert from "node:assert/strict";

import { runToolLoop } from "../src/loop/orchestrator.js";
import {
  NORMALIZATION_REASONING_EFFORT,
  normalizeWrapupWithLlm,
} from "../src/reflection/wrapup.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const TOOL_ROUND = {
  content: [{ type: "tool_use", id: "work-1", name: "work", input: {} }],
  stopReason: "tool_use",
};

const NORMALIZED_REPLY = '{"done":true,"summary":"s","output":"TARGET=gold-417","findings":{"TARGET":"gold-4173"}}';

/**
 * 跑一个「工具轮 + 非 JSON 的 end_turn 轮」的最小现场，注入独立归一化 provider。
 * `finalGuard` 收到的是归一化**之后**的自报对象与 findings，正好拿来和公开入口的返回值对拍。
 */
async function runInlineNormalization({ text, reply, maxRounds = 3 }) {
  const provider = createFakeProvider([
    TOOL_ROUND,
    { content: [{ type: "text", text }], stopReason: "end_turn", times: 4 },
  ]);
  const normalizer = createFakeProvider([
    { content: [{ type: "text", text: reply }], times: 8 },
  ]);
  const guards = [];
  const result = await runToolLoop({
    provider,
    initialUserMessage: "工作",
    executeTool: async () => "ok",
    maxRounds,
    completion: { signals: [], maxNoToolRounds: 9 },
    reflection: {
      wrapupNormalize: true,
      roundJudge: false,
      judgeIntercept: false,
      judge: { provider: normalizer },
    },
    finalGuard: async ({ findings, selfReport }) => {
      guards.push({ findings, selfReport });
      return { action: "accept" };
    },
  });
  return { result, provider, normalizer, guards };
}

/** 公开入口那一侧：同一个假 evaluator 手法，把请求原样收下来。 */
async function runPublicEntry({ text, reply }) {
  const requests = [];
  const evaluator = {
    async chat(request) {
      requests.push(request);
      return { content: [{ type: "text", text: reply }] };
    },
  };
  const value = await normalizeWrapupWithLlm(text, evaluator);
  return { requests, value };
}

test("#406 B2-b 先红格：引擎内联与公开入口发出**同一份**归一化请求、得到**逐字相同**的信封", async () => {
  const text = "TARGET=gold-417";
  const { normalizer, guards } = await runInlineNormalization({ text, reply: NORMALIZED_REPLY });
  const inlineRequest = normalizer.requests[0];
  assert.ok(inlineRequest, "内联路径必须真的发了一次归一化请求（否则后面的对拍是空转）");

  const { requests: publicRequests, value: publicValue } = await runPublicEntry({ text, reply: NORMALIZED_REPLY });
  const publicRequest = publicRequests[0];

  // ① 请求体逐字相同：提示词只有一份，形状示例、失败判词、原文都在同一处拼。
  //    `signal` 是 run 级对象，公开入口没有；除它之外整份请求必须 `deepEqual`。
  assert.deepEqual(
    {
      system: inlineRequest.system,
      messages: inlineRequest.messages,
      reasoning_effort: inlineRequest.reasoning_effort,
    },
    {
      system: publicRequest.system,
      messages: publicRequest.messages,
      reasoning_effort: publicRequest.reasoning_effort,
    },
    "两条路径必须发同一份提示词（改前：内联那份带 taskBrief/轮数，公开入口带 WRAPUP_NORMALIZATION_PROMPT）",
  );

  // ② 同一份回答在两条路径上得到逐字相同的信封：归一化器改写的 finding（gold-4173 不在 agent
  //    原文里）被**同一道**闸门判掉，两条路径都不该看见它。
  assert.deepEqual(publicValue, {
    done: true,
    summary: "s",
    output: "TARGET=gold-417",
  });
  assert.deepEqual(guards.at(-1)?.selfReport, publicValue, "引擎自报对象必须与公开入口返回值逐字相同");
  assert.equal(guards.at(-1)?.findings, undefined, "被改写的 finding 不许到达 guard（闸门对 agent 原文判）");
});

test("#406 B2-b 闸门：findings 对**原文**判，不对修后 / 归一化器回答判", async () => {
  // 动态导入：本格要钉的两个符号是 B2-b 新增的内部件；静态导入会让「改前先红」变成整文件
  // 导入失败（红的理由就不是「两条路径不是同一个实现」了）。
  const { wrapupGate, wrapupValue } = await import("../src/reflection/wrapup.js");
  // agent 原文里是带反斜杠的 `http\.request`（非法 JSON 转义，L1 会**加倍**反斜杠修好）。
  // 一条会「删反斜杠」的修复（jsonrepair 那类）会产出 `http.request`：原文里没有它。
  const original = String.raw`{"api":"http\.request"}`;
  const repaired = '{"api":"http.request"}';
  const gate = wrapupGate(original);

  const rewritten = { done: true, findings: { api: "http.request" } };
  // 关键：即使把**修后文本**当第二个参数递进来（它会 `includes("http.request")`），闸门也不认——
  // 判据是闭包里的 agent 原文。
  assert.deepEqual(gate(rewritten, repaired), { ok: true, dropped: ["api"] });
  assert.equal(wrapupValue(rewritten, original).findings, undefined, "被改写的值必须落成「不写这个键」");

  // 逐字搬运的值照常保留（反斜杠是原文字节的一部分）。
  const verbatim = { done: true, findings: { api: String.raw`http\.request` } };
  assert.deepEqual(gate(verbatim, repaired), { ok: true });
  assert.deepEqual(wrapupValue(verbatim, original).findings, { api: String.raw`http\.request` });

  // 空串一律丢弃（`"".includes` 恒真，不先挡掉就会让空声明混进 guard 的核验面）。
  assert.deepEqual(gate({ done: true, findings: { note: "" } }, repaired), { ok: true, dropped: ["note"] });
});

test("#406 B2-b 思考恒关：引擎内联与公开入口两条请求都透传 reasoning_effort:\"none\"", async () => {
  const text = "做完了";
  const { normalizer } = await runInlineNormalization({ text, reply: '{"done":false,"summary":"进展","output":""}' });
  const { requests } = await runPublicEntry({ text, reply: '{"done":true,"summary":"s","output":"o"}' });

  assert.equal(NORMALIZATION_REASONING_EFFORT, "none");
  for (const [label, request] of [
    ["引擎内联", normalizer.requests[0]],
    ["公开入口", requests[0]],
  ]) {
    assert.equal(request.reasoning_effort, "none", `${label}：归一化请求必须不思考`);
    assert.equal(Object.hasOwn(request, "thinking"), false, `${label}：不许自创第二种开关`);
    assert.equal(Object.hasOwn(request, "enable_thinking"), false, `${label}：不许自创第二种开关`);
  }
});

test("#406 B2-b 失败可见：归一化器答非 JSON ⇒ 请求停在 1 条、loop 不崩、终稿仍是模型原文", async () => {
  const text = "还在处理中";
  const { result, normalizer, provider } = await runInlineNormalization({
    text,
    reply: "这不是 JSON",
    maxRounds: 4,
  });

  // 既有事实（本单不改语义）：失败一次就把开关就地关断，后续 end_turn 轮不再烧 token。
  assert.equal(normalizer.requests.length, 1, "失败一次即关断 ⇒ 归一化请求停在 1 条（关断丢失则是 3 条）");
  assert.equal(provider.requests.length, 4, "关断只关归一化，loop 照常推进到 4 轮");
  assert.match(result.finalText, /还在处理中/, "归一化失败不许把终稿改成空或别的东西");

  // 公开入口这一侧同样是可观察的失败：返回 null（不是抛错，也不是一个空信封）。
  const requests = [];
  const value = await normalizeWrapupWithLlm(text, {
    async chat(request) {
      requests.push(request);
      return { content: [{ type: "text", text: "这不是 JSON" }] };
    },
  });
  assert.equal(requests.length, 1, "公开入口每次调用最多 1 个请求（失败不重试）");
  assert.equal(value, null);
});

test("#406 B2-b L1 命中就不发归一化请求：尾逗号 / 非法转义由确定性修复层解析，值逐字保留", async () => {
  // 尾逗号：旧内联路径 JSON.parse 失败 ⇒ 发一次 LLM 请求；统一入口的 L1 直接修好。
  const trailingComma = await runInlineNormalization({
    text: '{"done":true,"summary":"s","output":"o",}',
    reply: '{"done":false,"summary":"N","output":"N"}',
  });
  assert.equal(trailingComma.normalizer.requests.length, 0, "尾逗号是 L1 可修形状 ⇒ 不许再花一次请求");
  assert.equal(trailingComma.result.finalText, "o", "修好之后 done:true 的 output 照常替换终稿");

  // 非法转义：`invalid-escape` 是**加倍反斜杠**，解析出来的值逐字等于原文（不是删反斜杠）。
  const invalidEscape = await runInlineNormalization({
    text: String.raw`{"done":true,"summary":"s","output":"http\.request"}`,
    reply: '{"done":false,"summary":"N","output":"N"}',
  });
  assert.equal(invalidEscape.normalizer.requests.length, 0, "非法转义是 L1 可修形状 ⇒ 不许再花一次请求");
  assert.equal(invalidEscape.result.finalText, String.raw`http\.request`, "修的是结构字符，值的字节一个都不许动");
});
