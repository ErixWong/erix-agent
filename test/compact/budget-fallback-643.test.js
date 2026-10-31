// issue #643 —— 预算兜底（库层 `sliding-window` 那一发）的两处行为修正，判据各带反向证。
//
// 病根（0.29.0 实测，见 issue 正文 §1/§2）：上下文略超预算（14,692 / 12,000 = 1.22）且可折轮数
// ≤ `keepRounds`（默认 6）时，配置的策略折 **0** 轮，接着引擎兜底写死 `keepRounds: 0`
// （= 把所有可折轮次全折掉）⇒ 历史被清到只剩 head（14,692 → **150** tok），摘要器一次都没被调用，
// 模型只好把同一批文件重读一遍又一遍。
//
// 四格判据：
//   ① `foldWithinBudget` 折到**够用就停**：`tokensAfter`（含摘要块）≤ 预算，且「少折一轮就超预算」
//      —— 这一条把「折到底」和「折到够用」分开；
//   ② 真引擎（= 票面现场形状）：同一场景下 `tokensAfter` 落在预算内**且** `tokensAfter > 150`
//      （不许再用「清到只剩 head」当解法），被保留那一轮的正文仍在模型请求里；
//   ③ **兜底也产摘要**（#464 B 档）：兜底触发后模型请求里出现 `【上下文折叠·v1·` marker，
//      且轮记录 `foldedFacts.title` 非空；`summarizer` 调用数仍为 **0**（零 LLM 成本）；
//   ④ 预算真的装不下可折内容时**不静默清空**：折到 `keepRounds: 0` 即收手（交给 #608 的显式劣化
//      闸门 / 安全层），而不是伪造「已经装下了」。
//
// 反向证（见交付报告；变异实验，不落盘）：
//   · 把 `fits` 的停条件写死成永远不成立（`return false`）⇒ ① 红（折到底）且 ② 红（tokensAfter 回到 150 量级）；
//   · 把兜底的 `prependFoldSummary` 去掉 ⇒ ③ 红（请求里没有 marker）；
//   · 变异没打上（脚本报 `fits` 行未改）⇒ 同样按失败处理，不拿「跑过了」当证据。
//
// 零真实 LLM、零网络、零 `~/.erix`：fake provider + 内存 store（AGENTS.md 测试隔离规则）。

import assert from "node:assert/strict";
import test from "node:test";

import { foldWithinBudget, prependFoldSummary } from "../../src/compact/budget-fit.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { FOLDED_FACTS_RECORD_FIELD } from "../../src/compact/fold-summary-journal.js";
import { createSlidingWindowStrategy } from "../../src/compact/sliding-window.js";
import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { runDirect } from "../helpers/run-direct.js";

const FOLD_MARKER = "【上下文折叠·v1·";

/** 每轮正文用**可辨认**的标记（`MOD0-CONTENT` …），于是「哪一轮还在请求里」是逐字的，不靠计数。 */
const roundContent = (index, chars) => `MOD${index}-CONTENT ` + "lorem ipsum dolor ".repeat(
  Math.ceil(chars / 18),
);

const toolRound = (index, chars) => ([
  {
    role: "assistant",
    content: [{ type: "tool_use", id: `t${index}`, name: "readFile", input: { path: `docs/mod${index}.md` } }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `t${index}`, content: roundContent(index, chars) }],
  },
]);

const conversation = ({ rounds = 4, chars = 8000 } = {}) => [
  { role: "user", content: [{ type: "text", text: "TASK: read the modules" }] },
  ...Array.from({ length: rounds }, (_unused, index) => toolRound(index, chars)).flat(),
];

const textOf = (message) => (typeof message?.content === "string"
  ? message.content
  : (Array.isArray(message?.content) ? message.content : [])
    .map((block) => String(block?.text ?? block?.content ?? ""))
    .join("\n"));

// ── ① 单元格：折到够用就停 ─────────────────────────────────────────────────────────────

test("#643-① foldWithinBudget 折到够用就停：少折一轮就超预算（不是折到底）", async () => {
  const strategy = createSlidingWindowStrategy();
  const messages = conversation({ rounds: 4, chars: 8000 });
  const total = estimateMessageTokens(messages);
  // 预算 = 全部 − 两轮（估算可加）⇒ 恰好需要折两轮左右。
  const budgetTokens = Math.floor(total * 0.5);
  const result = await foldWithinBudget(strategy, messages, { budgetTokens });
  const summaryTokens = typeof result.foldedSummaryText === "string"
    ? estimateTokens(result.foldedSummaryText)
    : 0;
  assert.ok(
    result.tokensAfter + summaryTokens <= budgetTokens,
    `折后必须装进预算：${result.tokensAfter} + ${summaryTokens} > ${budgetTokens}`,
  );
  assert.ok(result.foldedRounds > 0 && result.foldedRounds < 4,
    `必须「折一部分」（实测 foldedRounds=${result.foldedRounds}）——折 0 轮说明没折，折 4 轮说明折到底了`);
  // 「够用就停」的严格形态：**少折一轮**就必须装不下（否则停早了/停晚了都算错）。
  const keepUsed = 4 - result.foldedRounds;
  const fewer = await strategy.compact(messages, { keepRounds: keepUsed + 1, budgetTokens });
  const fewerSummary = typeof fewer.foldedSummaryText === "string"
    ? estimateTokens(fewer.foldedSummaryText)
    : 0;
  assert.ok(
    fewer.tokensAfter + fewerSummary > budgetTokens,
    `再少折一轮（keepRounds=${keepUsed + 1}）必须装不下，否则「够用就停」停早了：${fewer.tokensAfter} + ${fewerSummary} ≤ ${budgetTokens}`,
  );
});

test("#643-① 预算充裕 ⇒ 一轮都不折；预算不可达 ⇒ 折到 keepRounds: 0 收手（不伪造「装下了」）", async () => {
  const strategy = createSlidingWindowStrategy();
  const messages = conversation({ rounds: 4, chars: 8000 });
  const total = estimateMessageTokens(messages);

  const roomy = await foldWithinBudget(strategy, messages, { budgetTokens: total * 4 });
  assert.equal(roomy.foldedRounds, 0, "预算充裕时不许折任何一轮");
  assert.equal(roomy.tokensAfter, total, "不折时消息流逐字不变");

  const unreachable = await foldWithinBudget(strategy, messages, { budgetTokens: 1 });
  assert.equal(unreachable.foldedRounds, 4, "装不下时折到 keepRounds: 0（能折的都折了）即收手");
  assert.ok(unreachable.tokensAfter > 1,
    "此时不得伪造「已装进预算」：如实交出仍超预算的估算，交给引擎的显式劣化闸门 / 安全层");
});

test("#643-② prependFoldSummary 落点是 head 的第一条真实 user 消息（与 fold-llm / fold-statistical 同口径）", () => {
  const messages = [
    { role: "system", content: "SYS" },
    { role: "user", content: "TASK" },
    ...toolRound(0, 100),
  ];
  const prepended = prependFoldSummary(messages, "SUMMARY-BLOCK");
  assert.equal(prependFoldSummary(messages, ""), messages, "空摘要不得造空块");
  assert.equal(prependFoldSummary(messages, undefined), messages);
  const head = prepended[1];
  assert.deepEqual(head.content[0], { type: "text", text: "SUMMARY-BLOCK" });
  assert.deepEqual(head.content[1], { type: "text", text: "TASK" }, "任务原文必须保留在摘要之后");
  assert.equal(prepended.length, messages.length, "摘要进已有消息，不新增消息（不改变消息条数）");
  const asSystem = prependFoldSummary(messages, "SUMMARY-BLOCK", "system");
  assert.deepEqual(asSystem[0].content[0], { type: "text", text: "SUMMARY-BLOCK" });
  assert.equal(asSystem[0].role, "system");
});

// ── ②③ 真引擎格：票面现场形状 ─────────────────────────────────────────────────────────

const BUDGET = 12000;
const RESULT_CHARS = 19000;
const TOOL_ROUNDS = 2;

function engineProvider() {
  return createFakeProvider([
    ...Array.from({ length: TOOL_ROUNDS }, (_unused, index) => ({
      content: [{
        type: "tool_use",
        id: `t${index}`,
        name: "readFile",
        input: { path: `docs/mod${index}.md` },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
}

/**
 * 票面现场：配置 `fold-llm`（0.29 起 CLI 默认）+ 预算 12,000 + **可折轮数 ≤ keepRounds**。
 * `keepRounds` 用默认 6（不传）——本单明禁改这个默认值。
 */
async function runTicketShape({ runId, strategy } = {}) {
  const store = createMemoryTranscriptStore();
  const provider = engineProvider();
  const result = await runDirect({
    provider,
    seed: "Read docs/mod0.md..mod1.md fully, one readFile each, then write summary.md",
    executeTool: async ({ input }) => roundContent(Number(input?.path?.match(/mod(\d+)/u)?.[1] ?? 0), RESULT_CHARS),
    store,
    runId,
    // `maxRounds` / `completion` 走 `config.run`（扁平拼写已退役），避免给清点表添新写点。
    config: {
      folding: { context: { budgetTokens: BUDGET } },
      run: { maxRounds: TOOL_ROUNDS + 2, completion: false, outputHygiene: { limit: 100_000 } },
    },
    ...(strategy === undefined ? {} : { capabilities: { ports: { strategy } } }),
  });
  return { result, provider, store };
}

test("#643-② 真引擎：兜底折到够用就停——tokensAfter 落在预算内且远不止 150 tok（票面现场）", async () => {
  let summarizerCalls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      summarizerCalls += 1;
      return "LLM 摘要";
    },
  });
  const { result, provider } = await runTicketShape({ runId: "643-c", strategy });
  assert.equal(summarizerCalls, 0, "前置：这一格要的是「策略折 0 轮」⇒ 摘要器一次都不该被调用");

  const stats = result.runState?.deterministic?.compactionStats ?? result.compactionStats ?? [];
  assert.ok(stats.length >= 1, "前提：折叠必须真的发生");
  const stat = stats.at(-1);
  assert.equal(stat.layers.slidingWindow.triggered, 1, "真正干活的是预算兜底那一发");
  assert.ok(
    stat.tokensAfter <= BUDGET,
    `折后必须落在预算内：${stat.tokensBefore} → ${stat.tokensAfter} > ${BUDGET}`,
  );
  assert.ok(
    stat.tokensAfter > 150,
    `不许再用「清到只剩 head」当解法：${stat.tokensBefore} → ${stat.tokensAfter}（旧行为是 150 量级）`,
  );
  assert.equal(stat.foldedRounds, 1, "两轮里只折最老那一轮（折到够用就停），不是把两轮都折掉");

  // 被保留那一轮的**正文**仍在模型请求里（折叠没把它一起清掉）。
  const afterFold = provider.requests.find((request) => JSON.stringify(request).includes(FOLD_MARKER));
  assert.ok(afterFold, "兜底之后的那一发请求里必须有折叠摘要（见 ③）");
  const joined = afterFold.messages.map(textOf).join("\n");
  assert.ok(joined.includes("MOD1-CONTENT"), "被保留那一轮的正文必须还在（旧行为下它也被清掉了）");
  assert.ok(!joined.includes("MOD0-CONTENT"), "被折掉那一轮的正文必须已被摘要替代（不再原样出现）");
});

test("#643-③ 兜底也产摘要：模型请求里有 marker、轮记录 foldedFacts.title 非空，且零摘要器调用", async () => {
  let summarizerCalls = 0;
  const strategy = createFoldLlmStrategy({
    summarizer: async () => {
      summarizerCalls += 1;
      return "LLM 摘要";
    },
  });
  const { provider, store } = await runTicketShape({ runId: "643-b", strategy });

  const afterFold = provider.requests.find((request) => JSON.stringify(request).includes(FOLD_MARKER));
  assert.ok(afterFold, "兜底触发后，模型请求里必须出现机械摘要（marker）——旧行为只有任务原文 + 一行 stub");
  assert.equal(summarizerCalls, 0, "B 档是零 LLM 成本：摘要来自已经算好的机械文本，不许再调摘要器");

  const records = await store.load("643-b");
  const facts = records
    .filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => record[FOLDED_FACTS_RECORD_FIELD]);
  assert.ok(facts.length > 0, "兜底那一折必须在轮记录上留下 foldedFacts（#470 的账本口径不变）");
  assert.equal(typeof facts[0].title, "string", "foldedFacts.title 必须给出");
  assert.ok(facts[0].title.length > 0, "foldedFacts.title 不许为空串");
  assert.match(String(facts[0].text), /上下文折叠/u, "替代物正文必须是机械摘要");
});

test("#643-③ 没配策略（库层兜底独自干活）也产摘要，且覆盖被折的全部轮次", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    ...Array.from({ length: 4 }, (_unused, index) => ({
      content: [{ type: "tool_use", id: `u${index}`, name: "readFile", input: { path: `docs/mod${index}.md` } }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    provider,
    seed: "read all modules",
    executeTool: async ({ input }) => roundContent(Number(input?.path?.match(/mod(\d+)/u)?.[1] ?? 0), 12000),
    store,
    runId: "643-unconfigured",
    config: {
      folding: { context: { budgetTokens: BUDGET, keepRounds: 6 } },
      run: { maxRounds: 7, completion: false, outputHygiene: { limit: 100_000 } },
    },
  });
  const afterFold = provider.requests.find((request) => JSON.stringify(request).includes(FOLD_MARKER));
  assert.ok(afterFold, "未配策略时兜底那一发也必须给模型一份摘要（策略那一折同样只落账、不进消息）");
  const summaryText = afterFold.messages.map(textOf).join("\n");
  // 策略那一发折的是**最老**那几轮（keepRounds 6 之外的），摘要必须覆盖到它们，不能只补兜底这一折。
  assert.match(summaryText, /mod0\.md/u, "摘要必须覆盖到最老那一轮（否则最老那批轮次照样只剩计数）");
});
