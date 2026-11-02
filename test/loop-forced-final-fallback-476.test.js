// issue #476：强制收尾**问过之后**终局仍是空正文 ⇒ 落一条固定终稿文案（用户裁决 = 不补一发）。
//
// 现场（#467 交付时登记的残留 1）：`termination.forcedFinal === true` 而 `finalText === ""`——收尾那一发
// 被要求只出正文，模型仍然什么都没写。补一发的代价是「再吃一次收尾预算 + 仍不保证有内容」，所以裁决
// 是落一条**事实句**：说清「收尾未产出正文」，并且用 `result.finalTextFallback === true` 让宿主能判定
// 「这条不是模型写的」。文案本身只在 `src/loop/termination.js` 的 `FORCED_FINAL_FALLBACK_TEXT` 里写一次，
// 本文件只引用常量（不抄字面量）。
//
// 收尾的**每个**调用点都要覆盖（`grep -n "forceFinalAndJournal(" src/loop/orchestrator.js`）：
//   ① `max_rounds_cap`（出圈收尾那一路，`orchestrator.js` 末尾）；
//   ② `stop` 分支（`terminationReasonForAction` 推导出的 end_turn / no_tool / judge_done / …）——
//      本文件用 `end_turn` 代表；`judge_done` 那一格由 `test/loop-judge-done-forced-final.test.js` ④ 钉住；
//   ③ `budget_below_working_set`（显式劣化那一路，`compactBeforeRound` 之后）。
//
// 三条诚实界（本文件的 ⑤ / ⑥ 两格就是它们的反向证）：
//   · 兜底**不改裁决**：没跑 guard 仍 `skipped`，跑了没过仍 `unverified`；
//   · guard 的 payload 里 `finalText` 仍是**空的那一份**（兜底晚于 guard）；
//   · 交付物判据读 `facts.finalText` 时同样看到空 ⇒ 机器闸门不会被兜底正文骗过。
import test from "node:test";
import assert from "node:assert/strict";

import { FORCED_FINAL_FALLBACK_TEXT } from "../src/loop/termination.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { runDirect } from "./helpers/run-direct.js";

const toolUse = (id) => ({
  content: [{ type: "tool_use", id, name: "noop", input: {} }],
  stopReason: "tool_use",
});
/** 真机形状：`content:[reasoning]` + `stopReason:"end_turn"`，没有 text 块、没有 tool_use。 */
const reasoningOnly = (text = "只想了一下，没写正文") => ({
  content: [{ type: "reasoning", text }],
  stopReason: "end_turn",
});
const bodyText = "这是模型自己写的终稿";

const forcedFinalEvents = (events) => events.filter((event) => event.type === "forced_final");
const textBlocks = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === "text")
  .map((block) => block.text);

// ── ① 出圈收尾那一路（`max_rounds_cap`）──────────────────────────────────────────────

test("#476 ① max_rounds_cap：收尾一发仍返回空正文 ⇒ 固定兜底文案 + finalTextFallback，verification 不变好", async () => {
  const events = [];
  const provider = createFakeProvider([toolUse("c1"), reasoningOnly("收尾那一发也只想了一下")]);
  const result = await runDirect({
    provider,
    seed: "task",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { runId: "forced-final-fallback-cap", maxRounds: 1, completion: false } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.deepEqual(result.termination, { reason: "max_rounds_cap", forcedFinal: true },
    "reason 与 forcedFinal 一字不动（新行为只加字段，不改既有语义）");
  assert.equal(result.finalText, FORCED_FINAL_FALLBACK_TEXT, "终局是引擎兜底文案（不是空串）");
  assert.equal(result.finalTextFallback, true, "宿主可判别的增量字段：终稿是兜底文案而非模型正文");
  assert.equal(provider.requests.length, 2, "1 轮 + 收尾一发：**不补第二发**（裁决就是不再重试）");
  assert.deepEqual(provider.requests.at(-1).tools, [], "收尾那一发仍不带工具面");
  assert.equal(forcedFinalEvents(events).length, 1);
  // 兜底只落在结果面：对话历史里那条 assistant 仍是模型真正产出的那一条（没有 text 块）。
  assert.deepEqual(textBlocks(result.messages.at(-1)), [],
    "不许把兜底文案塞进对话历史（`store.load()` 之后会被当成模型说的话读回来）");
  // 诚实界：没接 finalGuard ⇒ 照旧 skipped，兜底正文不改善 verification。
  assert.equal(result.verification.status, "skipped");
  assert.equal(result.verification.reason, "no_final_guard");
});

// ── ② `stop` 分支（`end_turn`）────────────────────────────────────────────────────────

test("#476 ② end_turn（stop 分支）：同一格 ⇒ 兜底文案 + 新字段，仍只发一发收尾", async () => {
  const events = [];
  const provider = createFakeProvider([
    toolUse("c1"),
    reasoningOnly("r1"),
    reasoningOnly("收尾那一发也只想了一下"),
  ]);
  const result = await runDirect({
    provider,
    seed: "task",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { runId: "forced-final-fallback-end-turn", maxRounds: 4, completion: false } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.deepEqual(result.termination, { reason: "end_turn", forcedFinal: true },
    "停机 reason 不被兜底改写（兜底不是一次新的停机）");
  assert.equal(result.finalText, FORCED_FINAL_FALLBACK_TEXT);
  assert.equal(result.finalTextFallback, true);
  assert.equal(provider.requests.length, 3, "2 轮 + 收尾一发；补一发那一格必须仍然不存在");
  assert.equal(forcedFinalEvents(events).length, 1);
  assert.equal(result.verification.status, "skipped");
});

// ── ③ 显式劣化那一路（`budget_below_working_set`）────────────────────────────────────

test("#476 ③ budget_below_working_set（显式劣化那一路）：同一格 ⇒ 兜底文案 + 新字段，reason/detail 不变", async () => {
  // 夹具与 `test/compact/working-set-floor-608.test.js` 的 #608-2a 同形：预算压在**单条工具结果之下**
  // + 连续重读同一入参 ⇒ 引擎显式劣化（不静默跑到 cap）。差别只有一处：收尾那一发返回空正文。
  const READS = 12;
  const paragraph = (index) => `PARA-${index} ` + "填充".repeat(180);
  const provider = createFakeProvider([
    ...Array.from({ length: READS }, () => ({
      content: [{ type: "tool_use", id: "tu_7", name: "getParagraph", input: { index: 7 } }],
      stopReason: "tool_use",
    })),
    reasoningOnly("收尾那一发也只想了一下"),
  ]);
  const events = [];
  const result = await runDirect({
    provider,
    seed: "任务：" + "要求".repeat(40),
    store: createMemoryTranscriptStore(),
    executeTool: async () => paragraph(7),
    config: {
      folding: { context: { budgetTokens: 500, keepRounds: 0 } },
      run: { runId: "forced-final-fallback-below", maxRounds: READS + 2, completion: false },
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.equal(result.termination.reason, "budget_below_working_set",
    `前提：这一格必须真的走显式劣化（实测 ${JSON.stringify(result.termination)}）`);
  assert.equal(events.filter((event) => event.type === "budget_below_working_set").length, 1,
    "前提：劣化事件恰好一条（否则本格测的不是那一路）");
  assert.match(result.termination.detail, /^budgetTokens=\d+ workingSetTokens=\d+ suggestedBudgetTokens=\d+ repeatStreak=\d+$/u,
    "detail 的四个数一字不动");
  assert.equal(result.termination.forcedFinal, true, "这一路本来就会跑一发收尾");
  assert.equal(result.finalText, FORCED_FINAL_FALLBACK_TEXT);
  assert.equal(result.finalTextFallback, true);
});

// ── ④ 对照格：末轮已有正文 ⇒ 不发收尾、不注入兜底、新字段缺席 ──────────────────────────

test("#476 ④ 对照：末轮已有正文 ⇒ 一发都不多花，finalText 是模型那一份，finalTextFallback 缺席", async () => {
  const events = [];
  const provider = createFakeProvider([
    toolUse("c1"),
    { content: [{ type: "text", text: bodyText }], stopReason: "end_turn" },
    // 排一发进去：被消费就说明闸门失效（脚本耗尽不会报错，所以必须数请求数）
    { content: [{ type: "text", text: "不该被消费" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    seed: "task",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { runId: "forced-final-fallback-control", maxRounds: 4, completion: false } },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.termination.forcedFinal, undefined, "有正文 ⇒ 不该有强制收尾");
  assert.equal(result.finalText, bodyText, "终稿是模型自己写的那一份");
  assert.equal(result.finalTextFallback, undefined,
    "兜底字段只在真的兜底时出现（与 `forcedFinal` 同一条「缺键 = 没发生」的口径）");
  assert.equal(provider.requests.length, 2, "正常收尾不该白问一发");
  assert.equal(forcedFinalEvents(events).length, 0);
});

// ── ⑤ 诚实界：兜底不改善 verification（guard 看到的是空正文）────────────────────────────

test("#476 ⑤ guard 判 revise ⇒ 兜底正文不改善 verification（仍 unverified/non_continuable），且 guard 看到的是空正文", async () => {
  /** @type {string[]} */
  const guardSaw = [];
  const provider = createFakeProvider([toolUse("c1"), reasoningOnly("收尾那一发也只想了一下")]);
  const result = await runDirect({
    provider,
    seed: "task",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { runId: "forced-final-fallback-guard", maxRounds: 1, completion: false } },
    capabilities: {
      hooks: {
        finalGuard: async (payload) => {
          guardSaw.push(payload.finalText);
          return { action: "revise", message: "还差一步" };
        },
      },
    },
  });

  assert.deepEqual(guardSaw, [""],
    "兜底晚于 guard ⇒ payload 里的 finalText 仍是空的那一份（兜底正文不许当验收依据）");
  assert.deepEqual(result.termination, { reason: "final_guard_unverified", forcedFinal: true });
  assert.equal(result.verification.status, "unverified", "跑了 guard 但没过 ⇒ 照旧 unverified");
  assert.equal(result.verification.reason, "non_continuable");
  assert.equal(result.verification.detail, "max_rounds_cap");
  assert.equal(result.finalText, FORCED_FINAL_FALLBACK_TEXT);
  assert.equal(result.finalTextFallback, true);
});

// ── ⑥ 诚实界：交付物判据读 facts.finalText ⇒ 机器闸门不被兜底正文骗过 ────────────────────

test("#476 ⑥ 交付物判据读 facts.finalText ⇒ 兜底正文骗不过机器闸门（accept 也被拦成 deliverables_failed）", async () => {
  /** @type {string[]} */
  const checkSaw = [];
  const provider = createFakeProvider([
    toolUse("c1"),
    reasoningOnly("r1"),
    reasoningOnly("收尾那一发也只想了一下"),
  ]);
  const result = await runDirect({
    provider,
    seed: "task",
    store: createMemoryTranscriptStore(),
    executeTool: async () => "ok",
    config: { run: { runId: "forced-final-fallback-deliverables", maxRounds: 4, completion: false } },
    capabilities: {
      hooks: { finalGuard: async () => ({ action: "accept" }) },
      checks: {
        deliverables: [{
          name: "has-final-body",
          check: (facts) => {
            checkSaw.push(facts.finalText);
            return { ok: facts.finalText.trim() !== "", detail: "finalText empty" };
          },
        }],
      },
    },
  });

  assert.deepEqual(checkSaw, [""],
    "判据拿到的是 guard 那一刻的事实（此时还没有兜底正文）");
  assert.equal(result.termination.reason, "end_turn");
  assert.equal(result.verification.status, "unverified", "guard 说 accept 也照样被机器闸门拦下");
  assert.equal(result.verification.reason, "deliverables_failed");
  assert.equal(result.finalText, FORCED_FINAL_FALLBACK_TEXT);
  assert.equal(result.finalTextFallback, true);
});
