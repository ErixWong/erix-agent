// @ts-check
// issue #897 第一刀：折叠摘要器产出的 title / description 必须可解析并落进 `foldedFacts`。
//
// 病根（工单正文）：产品默认 `fold-llm` 下，出厂提示词规定第一行是 `## 阶段` 小节标题，
// 而 `buildFoldedFacts` 的 title 派生是「取正文首行」⇒ 落账的 `foldedFacts.title` 逐字等于
// `## 阶段`（一个壳）；`foldedFacts.summary`（description）在产品路径上恒缺席（orchestrator
// 从不传 `input.summary`）。本单让摘要器在第一个 `##` 之前额外吐两行带固定前缀的元信息
//（`标题：` / `描述：`），引擎解析、剥离、优先落账，且「挤掉」可检测。
//
// 判据（四格，全部内存 store + fake provider，零真实 LLM）：
//   1. 语义折的 title 不再是小节标题：`foldedFacts.title` 等于 fake 给的纯 title（不是 "## 阶段"）；
//   2. description 落账：`foldedFacts.summary` 等于 fake 给的 description；
//   3. 装不下时可检测：description 大到 2048（此处收小到 maxFoldedFactsBytes）装不下
//      ⇒ `summary` 键缺席**且** `summaryDropped` 在场，并与「模型没给 description」的落账形状可区分；
//   4. 解析失败不冒充：fake 返回没有那两行的六节摘要 ⇒ title 退回正文首行（今天的 `## 阶段`），
//      且 `titleFallback` 在场（能看出这一折没拿到模型 title）。
//
// ⚠ 每格都先在未改树上红（见终稿）；每格至少一条断言钉住「退回旧派生 / 旧落账」会翻红。

import assert from "node:assert/strict";
import test from "node:test";

import { FOLDED_FACTS_RECORD_FIELD } from "../../src/compact/fold-summary-journal.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

const SUMMARY_ANCHOR = "整理成可继续工作的日志"; // 出厂 promptGuide 首句，摘要请求独有，对话正文不含。
const TITLE = "修复折叠落账的标题与描述";
const DESC = "让摘要器产出标题与描述，解析后优先落进账本";
// 200 字符上限内取满中文（每字符 3 字节 ≈ 600 字节），配合收小的 maxFoldedFactsBytes 触发挤掉。
const LONG_DESC = "长".repeat(200);

/** 六节摘要，带两行元信息前缀（模拟新提示词下模型的行为）。desc=null ⇒ 只给 title 不给 description。 */
function summaryWithMeta(title, desc) {
  const meta = `标题：${title}\n${desc === null ? "" : `描述：${desc}\n`}`;
  return `${meta}## 阶段
阶段：先解析再落账。
## 已改文件
src/compact/fold-llm.js
## 已验证项
node --check 通过
## 下一步（含"已完成项禁止重做"）
已完成项禁止重做
## 主题词面包屑
897 fold title desc
## 教训与坑（不要重犯的）
无`;
}

/** 六节摘要但**没有**那两行元信息前缀（模拟模型不配合 / 旧提示词）。 */
function summaryWithoutMeta() {
  return `## 阶段
阶段：旧派生。
## 已改文件
src/compact/fold-llm.js
## 已验证项
node --check 通过
## 下一步（含"已完成项禁止重做"）
已完成项禁止重做
## 主题词面包屑
897 title fallback
## 教训与坑（不要重犯的）
无`;
}

/** fake provider：主循环用工具轮撑上下文；识别摘要请求（含 promptGuide 首句）返回指定正文。 */
function makeProvider(summarizeReply, { toolTurns = 7 } = {}) {
  let turns = 0;
  const chat = async (request) => {
    const haystack = JSON.stringify(request?.messages ?? "");
    if (haystack.includes(SUMMARY_ANCHOR)) {
      const text = typeof summarizeReply === "function" ? summarizeReply() : summarizeReply;
      return { content: [{ type: "text", text }], stopReason: "end_turn" };
    }
    if (turns < toolTurns) {
      turns += 1;
      return {
        content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `npm test -- --grep case-${turns}` } }],
        stopReason: "tool_use",
      };
    }
    return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
  };
  const provider = { protocol: "fake", model: "fake-model", chat };
  provider.chatStream = (request) => chat(request);
  return provider;
}

const factsOf = async (store, runId) => {
  const records = await store.load(runId);
  const rows = records
    .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => record[FOLDED_FACTS_RECORD_FIELD]);
  assert.ok(rows.length >= 1,
    `前置：这条路径必须真的折过（否则判据是空断言）。记录形状：${JSON.stringify(
      records.map((record) => ({ round: record.round, hasFacts: record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined })),
    )}`);
  return rows;
};

// 一次语义折（fold-llm）。params.maxBytes 收小 foldedFacts 预算以触发挤掉。
async function foldOnce({ runId, summarizeReply, maxBytes }) {
  const store = createMemoryTranscriptStore();
  await runDirect({
    provider: makeProvider(summarizeReply),
    executeTool: async () => `tool output ${"z".repeat(400)}`,
    maxRounds: 8,
    completion: false,
    reflection: false,
    config: {
      folding: {
        context: {
          budgetTokens: 1300,
          keepRounds: 0,
          ...(maxBytes === undefined ? {} : { maxFoldedFactsBytes: maxBytes }),
        },
      },
    },
    store,
    runId,
    seed: `start ${"y".repeat(600)}`,
  });
  return factsOf(store, runId);
}

test("#897-1 语义折的 title 是模型给的纯 title，不再是小节标题 ## 阶段", async () => {
  const rows = await foldOnce({ runId: "897-1", summarizeReply: summaryWithMeta(TITLE, DESC) });
  const semantic = rows.filter((facts) => facts.origin === "semantic");
  assert.ok(semantic.length >= 1, "前置：必须有语义折（origin===semantic）");
  for (const facts of semantic) {
    // 主断言：等于 fake 给的**纯** title。未改树上 title = 退回首行「标题：修复…」（带前缀），
    // 这条会因「退回旧的首行派生」而红。
    assert.equal(facts.title, TITLE,
      `title 必须等于模型给的纯 title，实测 ${JSON.stringify(facts.title)}`);
    assert.notEqual(facts.title, "## 阶段",
      "title 不得是小节标题壳（这正是本单要消灭的病根）");
    assert.equal(Object.hasOwn(facts, "titleFallback"), false,
      "拿到了模型 title ⇒ 不应出现 titleFallback 标记");
  }
});

test("#897-2 description 落进 foldedFacts.summary", async () => {
  const rows = await foldOnce({ runId: "897-2", summarizeReply: summaryWithMeta(TITLE, DESC) });
  const semantic = rows.filter((facts) => facts.origin === "semantic");
  assert.ok(semantic.length >= 1, "前置：必须有语义折");
  for (const facts of semantic) {
    assert.equal(facts.summary, DESC,
      `summary(description) 必须等于模型给的 description，实测 ${JSON.stringify(facts.summary)}`);
    assert.equal(Object.hasOwn(facts, "summaryDropped"), false,
      "description 正常落账 ⇒ 不应出现 summaryDropped 标记");
  }
});

test("#897-3 description 装得下 vs 被挤掉：落账形状可区分（summaryDropped 只在真挤掉时出现）", async () => {
  // 收小 foldedFacts 预算：clamp 后的 description（200 中文 ≈ 600 字节）> maxBytes - marker 预留 ⇒ 挤掉。
  const dropped = await foldOnce({
    runId: "897-3-dropped",
    summarizeReply: summaryWithMeta(TITLE, LONG_DESC),
    maxBytes: 400,
  });
  const notGiven = await foldOnce({
    runId: "897-3-notgiven",
    summarizeReply: summaryWithMeta(TITLE, null), // 只给 title，不给 description 行
    maxBytes: 400,
  });
  const a = dropped.filter((facts) => facts.origin === "semantic")[0];
  const b = notGiven.filter((facts) => facts.origin === "semantic")[0];
  assert.ok(a && b, "前置：两格都必须有语义折");

  // 被挤掉：summary 缺席 + summaryDropped 在场。未改树上无 summaryDropped ⇒ 此断言红。
  assert.equal(Object.hasOwn(a, "summary"), false, "被挤掉时 summary 键必须缺席");
  assert.equal(a.summaryDropped, true, "被挤掉时必须出现 summaryDropped:true");

  // 模型没给 description：summary 缺席，但**没有** summaryDropped（不是被挤掉，是根本没写）。
  assert.equal(Object.hasOwn(b, "summary"), false, "没给 description 时 summary 也缺席");
  assert.equal(Object.hasOwn(b, "summaryDropped"), false,
    "没给 description 不是被挤掉 ⇒ 不得出现 summaryDropped");

  // 两种落账形状必须可区分：去掉 foldId/seq（同配置同内容可能同值，去掉更纯净），其余必须 deepStrictEqual 不等。
  const strip = (facts) => {
    const { foldId, seq, ...rest } = facts;
    return rest;
  };
  assert.notDeepStrictEqual(strip(a), strip(b),
    "「被挤掉」与「模型没写」必须在落账形状上可区分（deepStrictEqual 不等）");
});

test("#897-4 解析失败（没有那两行）不冒充：title 退回正文首行(## 阶段) 且能看出没拿到模型 title", async () => {
  const rows = await foldOnce({ runId: "897-4", summarizeReply: summaryWithoutMeta() });
  const semantic = rows.filter((facts) => facts.origin === "semantic");
  assert.ok(semantic.length >= 1, "前置：必须有语义折");
  for (const facts of semantic) {
    // 退回今天的行为：title = 正文首行（模型正文首行是 `## 阶段`）。
    assert.equal(facts.title, "## 阶段",
      `没拿到模型 title 时 title 退回正文首行（今天的 ## 阶段），实测 ${JSON.stringify(facts.title)}`);
    // 且能看出这一折没拿到模型 title —— 未改树上无 titleFallback 键 ⇒ 此断言红。
    assert.equal(facts.titleFallback, true,
      "退回首行必须可检测：titleFallback 在场（不许静默冒充模型 title）");
  }
});
