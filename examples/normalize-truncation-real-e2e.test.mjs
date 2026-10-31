// issue #637 真机 e2e：归一化兜底（L2）在**真上游**上把「被 token 上限截断」与「模型输出垃圾」
// 判成两档，而不是压成同一个 error。
//
// 病根（#419 的真机形状，`maxTokens:120`、输出契约要求把原文回显 ⇒ 输出长度 ≈ 输入长度 ⇒ 结构上
// 必然截断）：正文停在 `"strategy` 处，`Unterminated string at position 256`，宿主拿到的是
// `no_candidate` / `unparsable` —— **分不清该加预算还是该换写法**。修法在
// `normalizeModelJson`（`src/normalization/parse-model-json.js`）：读 provider 回的 `stopReason`，
// `max_tokens` / `length` 且没产出可用的值时给 `error:"truncated"`（原值另挂在 `stopReason` 上）。
//
// 用法（闸门与其余真机脚本同一口径，缺省 skip + 分类原因 + exit 0）：
//   ERIX_E2E_REAL=1 node --test examples/normalize-truncation-real-e2e.test.mjs
//
// ---------------------------------------------------------------------------
// 为什么判据是「预算收紧 ⇒ truncated；预算放宽 ⇒ 不是 truncated」，而不是「模型输出被截断」
//
// 后者是在**断言模型行为**（它这次写多长），而模型写多长正是它自由的那一维——那种断言在真机上
// 只会随机假红（#619 踩过同一个坑，见 `examples/fold-default-real-e2e.mjs` 文件头）。截断这件事
// 可以被**构造**出来：`maxTokens` 收到 1，任何模型的回答都不可能是一个合法 JSON，于是
// 「这一发被截断了」是结构性事实，与模型抽不抽风无关。反向臂（预算放宽到 512）只断言
// 「**不是** truncated」——模型这次答成散文也照样成立，因为散文的病因是「垃圾」，不是「预算」。
//
// 离线臂（始终跑，不联网）用假 provider 钉同一组判别，于是闸门关着时本文件也**不会**变红，
// 且它证明的不是「装置没坏」，而是**判据本身**没被改成永远为真（同一个桩换 stopReason 就换答案）。
//
// 隔离：本文件一个字节也不写（不给 store、不建临时目录），只读配置；唯一的输出是 stdout 上的诊断行。

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeModelJson } from "../src/index.js";
import { formatSkip, printableEndpoint, resolveRealUpstream } from "./e2e-real-gate.mjs";

/** 要被归一化的「模型原文」：一句短到不必省 token 的话（截断只由 `maxTokens` 造成）。 */
const RAW_TEXT = "把这句话原样搬进 JSON：折叠日志里第 3 行丢了 TOK-637-deadbeef。";

/** 预算收得多紧：1 个 token ⇒ 任何回答都不可能是合法 JSON（结构性截断，不赌模型行为）。 */
const TIGHT_MAX_TOKENS = 1;

/** 预算放宽到多少：足够写完一个短 JSON 信封（这一臂只断言「不是 truncated」）。 */
const ROOMY_MAX_TOKENS = 512;

/** 被截断的两个拼写（canonical 与 OpenAI 原始）：与源码里的 `TRUNCATING_STOP_REASONS` 同一口径。 */
const TRUNCATING_STOP_REASONS = ["max_tokens", "length"];

/** 真上游闸门：关着 ⇒ `t.skip` 分类原因（与其余真机脚本同形，`npm test` 必须离线可重复）。 */
async function gateOrSkip(t) {
  const gate = await resolveRealUpstream({ probeTimeoutMs: 8_000 });
  if (!gate.ok) {
    t.skip(`真上游不可用/闸门关：${formatSkip(gate)}`);
    return undefined;
  }
  console.log(`[637] 闸门开：model=${gate.model} endpoint=${printableEndpoint(gate.endpoint)}`
    + `｜紧凑预算=${TIGHT_MAX_TOKENS} 放宽预算=${ROOMY_MAX_TOKENS}`);
  return gate;
}

// ---------------------------------------------------------------------------
// 离线臂（始终跑，不联网）：同一个桩，只换 stopReason 就换答案
// ---------------------------------------------------------------------------

test("[637] 离线：同一段正文只换 stopReason ⇒ 判别值必须不同（判据本身没被改成恒真）", async () => {
  const body = '{"strategy'; // #419 的真机形状：正文停在半个键上
  const withStopReason = (stopReason) => ({
    async chat() {
      return { content: [{ type: "text", text: body }], stopReason };
    },
  });

  const cut = await normalizeModelJson("散文", { provider: withStopReason("max_tokens"), llm: true });
  const prose = await normalizeModelJson("散文", { provider: withStopReason("end_turn"), llm: true });

  assert.equal(cut.error, "truncated", `被 token 上限截断必须是自成一档：${JSON.stringify(cut)}`);
  assert.equal(cut.stopReason, "max_tokens", "原始 stop reason 必须带给宿主");
  assert.equal(prose.error, "no_candidate", `end_turn 的同一段正文是「垃圾」那档：${JSON.stringify(prose)}`);
  assert.notEqual(cut.error, prose.error, "两种病因必须给出不同的判别值（否则这条判据没有意义）");
});

// ---------------------------------------------------------------------------
// 真机臂（ERIX_E2E_REAL=1 才跑）
// ---------------------------------------------------------------------------

test("[637] 真机：maxTokens 收到 1 ⇒ error 是 truncated（不是 unparsable / no_candidate）", async (t) => {
  const gate = await gateOrSkip(t);
  if (gate === undefined) return;

  const result = await normalizeModelJson(RAW_TEXT, {
    slot: gate.slot,
    llm: true,
    maxTokens: TIGHT_MAX_TOKENS,
  });
  console.log(`[637] 紧凑预算：${JSON.stringify({ ok: result.ok, error: result.error, stopReason: result.stopReason, llmUsed: result.llmUsed })}`);

  assert.equal(result.ok, false, `预算 1 个 token 不可能产出合法 JSON：${JSON.stringify(result)}`);
  assert.equal(result.error, "truncated", "被 token 上限截断必须报 truncated（宿主据此加预算/换契约）");
  assert.ok(
    TRUNCATING_STOP_REASONS.includes(result.stopReason),
    `stopReason 必须逐字是上游给的那一个（实测 ${JSON.stringify(result.stopReason)}）`,
  );
  assert.equal(result.llmUsed, true, "这一档只在真的发过 L2 请求时出现");
  assert.equal("value" in result, false, "失败结果不许带 value 键");
});

test("[637] 真机：预算放宽到 512 ⇒ 不是 truncated（同一段原文，病因不再由预算解释）", async (t) => {
  const gate = await gateOrSkip(t);
  if (gate === undefined) return;

  const result = await normalizeModelJson(RAW_TEXT, {
    slot: gate.slot,
    llm: true,
    maxTokens: ROOMY_MAX_TOKENS,
  });
  console.log(`[637] 放宽预算：${JSON.stringify({ ok: result.ok, error: result.error, stopReason: result.stopReason, llmUsed: result.llmUsed })}`);

  // 不要求模型一定答成 JSON（那是它的自由）：只要求「预算够的时候不许把失败归因成截断」。
  assert.notEqual(result.error, "truncated", `预算 512 下报 truncated 就是把预算问题当成了别的东西：${JSON.stringify(result)}`);
  assert.equal("stopReason" in result, false, "不是截断就不许带 stopReason 键");
});
