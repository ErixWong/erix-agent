// issue #470：折叠的确定性替代物必须**同时落进账本**（轮记录新键 `foldedFacts`），
// 而不是只进消息流。宿主横幅与引擎自己的 judge 轮次历史都读轮记录（`record.summary ?? "missing"`，
// `src/loop/resume-manager.js`），此前不调 LLM 就永远只有占位字面量 `"missing"`。
//
// 判据（照工单 §4）：
//   1. 配 `context.strategy:"fold-statistical"`（**不配任何 summarizer**）折一轮 ⇒ 该轮 record 上
//      出现非空机械事实键，内容含**范围句 + 工具足迹**；`record.summary` 不被覆盖。
//   3. 下界锁：注入必然失败的 summarizer ⇒ LLM 摘要缺席，但机械事实仍在 record 上（旧形状两者皆无）。
//   4. 尺寸上界：投影字节数 ≤ 声明上限，且**只挂在折叠轮** ⇒ 不随折叠次数累积。
// C 档：`sliding-window` 也产这份摘要，但**只用于落账**——不 prepend 进 `compactedMessages`
// ⇒ 模型输入逐字不变（本文件最后一格钉这条）。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { FOLD_SUMMARY_MARKER, summarizeFoldedPayload } from "../../src/compact/fold-statistical.js";
import {
  injectFoldSummaryIntoHead,
  pickCoveringFoldAlternative,
  planFoldedHistoryTrim,
} from "../../src/compact/resume-fold-trim.js";
import {
  buildFoldedFacts,
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
} from "../../src/compact/fold-summary-journal.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => (block?.type === "tool_result"
    ? String(block.content ?? "")
    : block?.type === "text" ? String(block.text ?? "") : "")).join("\n")
  : String(message?.content ?? ""));

const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { path: `src/${id}.js` } });
const toolTurn = (id) => ({ content: [toolUse(id)], stopReason: "tool_use" });
const endTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const bigToolOutput = (id) => `tool output for ${id} ${"z".repeat(400)}`;

/** 主循环脚本 + 可开关的「摘要必然失败」。 */
let summaryCalls = 0;

function createProvider({ mainScript, failSummary = false }) {
  let mainIndex = 0;
  summaryCalls = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    mainRequests: [],
    get summaryCalls() {
      return summaryCalls;
    },
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryCalls += 1;
        if (failSummary) throw new Error("summarizer boom");
        return {
          content: [{ type: "text", text: "## 阶段\nSUMMARY_OK" }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      this.mainRequests.push(request);
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

const runOptions = (runId, store, provider, context, extra = {}) => ({
  provider,
  executeTool: async ({ id }) => bigToolOutput(id),
  maxRounds: 2,
  completion: false,
  reflection: false,
  // #498 S3: the flat `context` option is retired; data-only bags (budgetTokens / keepRounds /
  // strategy-name) live at `config.folding.context`, the expansion phase writes them back.
  config: { folding: { context } },
  store,
  runId,
  initialUserMessage: `start ${"y".repeat(600)}`,
  ...extra,
});

const foldRoundRecords = (records) => records.filter((record) => (
  (record.round ?? 0) > 0
  && (record.messages?.length ?? 0) > 0
  && record[FOLDED_FACTS_RECORD_FIELD] !== undefined
));

test("#470-1 fold-statistical（零 LLM）：替代物落进轮记录，含范围句 + 工具足迹", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({ mainScript: [toolTurn("a"), endTurn("收尾结论")] });
  await runToolLoop(runOptions("470-statistical", store, provider, {
    budgetTokens: 300,
    keepRounds: 0,
    strategy: "fold-statistical",
  }));

  // 前置：这条路真的没调过任何 LLM 摘要器（否则「零 LLM 也有替代物」是空断言）。
  assert.equal(provider.summaryCalls, 0, "本用例必须全程零 LLM 摘要调用");

  const records = await store.load("470-statistical");
  const withFacts = foldRoundRecords(records);
  assert.ok(withFacts.length >= 1,
    `折叠轮的轮记录上必须出现 ${FOLDED_FACTS_RECORD_FIELD}（实测 ${JSON.stringify(
      records.map((record) => ({ round: record.round, hasFacts: record[FOLDED_FACTS_RECORD_FIELD] !== undefined })),
    )}）`);
  const facts = withFacts[0][FOLDED_FACTS_RECORD_FIELD];
  assert.match(facts.text, /已折叠/u, "范围句在场");
  assert.match(facts.text, /工具足迹/u, "工具足迹在场");
  assert.equal(facts.source, "statistical", "零 LLM 的路子必须标成 statistical");
  assert.equal(facts.strategy, "fold-statistical");
  assert.ok(Number.isSafeInteger(facts.from) && Number.isSafeInteger(facts.to), "折叠区间可指认");
  // 判据 1 的后半句：summary 仍是本轮自身摘要，没被替代物覆盖。
  assert.notEqual(String(facts.text), String(records.find((record) => (
    (record.round ?? 0) > 0 && (record.messages?.length ?? 0) > 0
  ))?.summary ?? ""), "`record.summary` 不得被替代物覆盖");
});

test("#470-3 下界锁：summarizer 必然失败时，LLM 摘要缺席但机械事实仍在轮记录上", async () => {
  const store = createMemoryTranscriptStore();
  summaryCalls = 0;
  const provider = createProvider({ mainScript: [toolTurn("a"), endTurn("收尾结论")], failSummary: true });
  await runToolLoop(runOptions("470-degrade", store, provider, {
    budgetTokens: 300,
    keepRounds: 0,
    strategy: "fold-llm",
  }));

  assert.ok(summaryCalls >= 1, "前置：这真的试过 LLM 摘要（否则下界锁是空断言）");
  const records = await store.load("470-degrade");
  const withFacts = foldRoundRecords(records);
  assert.ok(withFacts.length >= 1, "LLM 缺席时机械事实必须补位（旧形状是两者皆无）");
  const facts = withFacts[0][FOLDED_FACTS_RECORD_FIELD];
  assert.equal(facts.source, "statistical");
  assert.match(String(facts.degradeReason), /summarizer boom/u,
    "降级原因要可指认，而不是只塞进摘要正文里的一条字符串");
  assert.match(facts.text, /工具足迹/u);
});

test("#470-4 尺寸上界：投影 ≤ 声明上限，且只挂在折叠轮（不随折叠次数累积）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({ mainScript: [toolTurn("a"), endTurn("收尾结论")] });
  await runToolLoop(runOptions("470-bound", store, provider, {
    budgetTokens: 300,
    keepRounds: 0,
    strategy: "fold-statistical",
  }));
  const records = await store.load("470-bound");
  const factsRows = records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined);
  assert.ok(factsRows.length >= 1);
  for (const record of factsRows) {
    const facts = record[FOLDED_FACTS_RECORD_FIELD];
    assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES,
      `投影字节数必须 ≤ ${FOLDED_FACTS_MAX_BYTES}（实测 ${facts.bytes}）`);
  }
  // 「不累积」的可测代理：每条轮记录上最多一个投影键、且没把整包原文抄进去（#470-B / #335 同族）。
  const totalFactsBytes = factsRows.reduce(
    (sum, record) => sum + record[FOLDED_FACTS_RECORD_FIELD].bytes,
    0,
  );
  assert.ok(totalFactsBytes <= FOLDED_FACTS_MAX_BYTES * factsRows.length,
    "每个折叠轮一份、非折叠轮零份 ⇒ 总量线性于**折叠次数**而非会话长度");
  for (const record of records) {
    if ((record.messages?.length ?? 0) > 0 && record[FOLDED_FACTS_RECORD_FIELD] === undefined) continue;
    assert.ok(!Array.isArray(record[FOLDED_FACTS_RECORD_FIELD]?.messages),
      "投影里不得嵌整包被折原文");
  }
});

test("#470-B buildFoldedFacts：空文本不写键（不是占位字面量），超上限按字节夹断并留痕", () => {
  assert.equal(buildFoldedFacts({ text: "   " }), undefined, "空文本 ⇒ undefined（调用方据此不写键）");
  assert.equal(buildFoldedFacts({}), undefined);
  const small = buildFoldedFacts({
    text: "早期第 1–9 轮（共 9 轮）已折叠。工具足迹：shell×3。",
    source: "statistical",
    strategy: "fold-statistical",
    roundRange: { from: 1, to: 9 },
    rounds: 9,
    fingerprint: "sha256:deadbeefdeadbeefdeadbeef",
  });
  assert.equal(small.bytes, new TextEncoder().encode(small.text).length);
  assert.equal(small.truncated, undefined, "没超限不得谎报 truncated");
  assert.deepEqual({ from: small.from, to: small.to, rounds: small.rounds }, { from: 1, to: 9, rounds: 9 });

  const huge = buildFoldedFacts({ text: `头${"字".repeat(4000)}尾`, maxBytes: 512 });
  assert.ok(huge.bytes <= 512, `夹断后必须 ≤ 上限（实测 ${huge.bytes}）`);
  assert.equal(huge.truncated, true);
  assert.ok(huge.bytesBefore > 512, "夹断了就要留痕：原始字节数可核对");
  assert.match(huge.text, /\[替代物已按字节上限夹断\]/u, "被夹断的事实必须自称被夹断");

  // 非法输入不得写出畸形事实：轮数/区间只在合法整数时出现。
  const odd = buildFoldedFacts({ text: "x", rounds: 0, roundRange: { from: null, to: "3" } });
  assert.equal(odd.rounds, undefined);
  assert.equal(odd.from, undefined);
  assert.equal(odd.to, undefined);
});

test("#470-C sliding-window：也产这份摘要，但它**不进** compactedMessages（模型输入逐字不变）", async () => {
  const strategy = createSlidingWindowStrategy();
  const messages = [];
  for (let index = 0; index < 4; index += 1) {
    messages.push({ role: "user", content: [{ type: "text", text: `u${index} ${"u".repeat(300)}` }] });
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${index}`, name: "shell", input: { cmd: `c${index}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${index}`, content: `r${index} ${"r".repeat(300)}` }],
    });
  }
  const result = await strategy.compact(messages, { keepRounds: 0 });
  assert.ok(result.foldedRounds > 0, "前置：这一格必须真的折了");
  assert.match(String(result.foldedSummaryText), /工具足迹/u, "C 档：兜底路径也要产出摘要文本");
  assert.ok(
    !result.messages.some((message) => textOf(message).includes(FOLD_SUMMARY_MARKER)),
    "机械摘要**只用于落账**：不得 prepend 进 compactedMessages（那会改变模型输入）",
  );
});

// ---- #462 放宽一格：落账的替代物必须**给裁用** --------------------------------
// 只做 #470-B（落账）而不改守卫①，不调 LLM 摘要器的宿主依旧每次续跑从第 1 轮重折：
// `pickCoveringFoldSummary` 只认 `foldedSummary` 事实行，而 `sliding-window` 永不 prepend
// ⇒ 那个等待条件对它逻辑上不可能满足。这里放宽的只有「替代物从哪来」，
// 「必须覆盖水位线」这条硬约束一字不放宽。

function foldedFactsRecords(text, to) {
  return [{ round: to, [FOLDED_FACTS_RECORD_FIELD]: [{ text, source: "statistical", from: 1, to }] }];
}

const roundEntries = [
  { message: { role: "user", content: [{ type: "text", text: "把水牌改了" }] }, round: 0 },
  { message: { role: "assistant", content: [{ type: "text", text: "第 1 轮正文" }] }, round: 1 },
  { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }] }, round: 2 },
  { message: { role: "assistant", content: [{ type: "text", text: "第 3 轮正文" }] }, round: 3 },
  { message: { role: "assistant", content: [{ type: "text", text: "第 4 轮正文（未折）" }] }, round: 4 },
];

test("#462 放宽一格：模型见过的 foldedSummary 事实优先，来源如实标 journal", () => {
  const records = [
    ...foldedFactsRecords("机械摘要", 3),
    { round: 0, foldedSummary: { text: "引擎摘要全文", summary: "纯摘要", foldedRoundRange: { from: 1, to: 4 } } },
  ];
  assert.equal(pickCoveringFoldAlternative(records, 4).origin, "journal");
  const plan = planFoldedHistoryTrim({ ledgerEntries: roundEntries, records, foldedThrough: 4 });
  assert.equal(plan.applied, true);
  assert.equal(plan.summarySource, "journal");
  // 旧路径逐字不变：回填的是引擎那份纯摘要，不是机械文本
  assert.equal(plan.summaryText, "纯摘要");
});

test("#462 放宽一格：只有 foldedFacts 也能按水位线裁正文，来源标 strategy", () => {
  // 真机械摘要（与 fold-statistical 的 compact 产物同一套规则），含真实工具足迹
  const summary = summarizeFoldedPayload(
    [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "editFile", input: {} }] }],
    { from: 1, to: 3 },
  );
  const records = foldedFactsRecords(summary, 3);
  // 形状锁（实测钉死，别再凭记忆改）：交给读侧的折叠替代物是**按轮的账本事实行** {round, foldedFacts}，
  // 区间在 foldedFacts[] 里是**平铺** {from,to}；pickCoveringFoldAlternative 就是按这两个键判「覆盖水位线」。
  // 改这个形状 = 改线格式，读侧与写侧（recordFoldSummaryToTurnRecord）必须同步改。
  assert.deepEqual(Object.keys(records[0]).sort(), ["foldedFacts", "round"]);
  // 覆盖得到 ⇒ 能挑出来；覆盖不到 ⇒ 一律不挑（裁的判据不放宽）
  assert.equal(pickCoveringFoldAlternative(records, 3).origin, "strategy");
  assert.equal(pickCoveringFoldAlternative(records, 4), undefined);

  const plan = planFoldedHistoryTrim({ ledgerEntries: roundEntries, records, foldedThrough: 3 });
  assert.equal(plan.applied, true);
  assert.equal(plan.summarySource, "strategy");
  assert.equal(plan.droppedRounds, 3);
  assert.match(plan.summaryText, /工具足迹/u);
  assert.deepEqual(plan.messages.map((entry) => entry.round), [0, 4]);
  // 补齐而非静默丢（#462 判据 3）：注入后工具足迹仍在上下文里可见，head 任务正文不被牵连
  const injected = injectFoldSummaryIntoHead(plan.messages.map((entry) => entry.message), plan.summaryText);
  assert.equal(injected[0].content[0].text.includes("editFile×1"), true);
  assert.ok(JSON.stringify(injected).includes("把水牌改了"));

  // 老账本（两种键都没有）⇒ 照旧不裁，行为与今天逐字一致
  const legacy = planFoldedHistoryTrim({ ledgerEntries: roundEntries, records: [{ round: 1 }], foldedThrough: 2 });
  assert.equal(legacy.applied, false);
  assert.equal(legacy.reason, "no-covering-summary");
  assert.equal(legacy.summarySource, "");
  assert.equal(legacy.messages.length, roundEntries.length);
});
