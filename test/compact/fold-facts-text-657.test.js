// issue #657（缺陷二）：`fold-llm` **成功**折叠时，账本 `foldedFacts.text` 不许再混进任务原文。
//
// 病根（一句话）：`src/compact/fold-llm.js` 的 `foldSummary` 只在**降级**分支写 `text`，LLM 成功时
// 不给这个键 ⇒ 引擎在 `strategyFoldSummary?.text ?? fedSummaryText` 处落回 `fedSummaryText`，
// 而 `fedSummaryText` 是「折叠后新出现的那条消息」里**全部** text 块的拼接（`textFromBlocks`）：
// `prependSummary(head, summary, …)` 把摘要放 `content[0]`、**原任务正文接在后面** ⇒ 一起被拼进来。
//
// 实测（`budgetTokens=1000` / `keepRounds=0` / 摘要器真跑）：
//   折 1  bytes=2034  truncated=false  任务原文从偏移 454 起 ⇒ 摘要只占 22%
//   折 2  bytes=2048  truncated=true   bytesBefore=2550   ⇒ 摘要占 44%
//   （`FOLDED_FACTS_MAX_BYTES = 2048`，`clampFactsText` 保前缀、削尾部）
// 危害：父键 2048B 预算里 54–78% 是**模型此刻还在 head 里看着的**任务原文；`truncated` 从第 2 折起
// 恒真且 `bytesBefore` 单调涨 ⇒ 宿主看这个信号已看不出信息量。
//
// 本文件锁三件事（工单 §4 判据 6/7/8/9）：
//   ① 成功路径：`foldedFacts.text` 不含任务原文，且**逐字等于**模型这一折真拿到的那份累计摘要；
//   ② `foldedFacts.increment.text` 逐字不变（仍是 `summarizeFoldedPayload` 的产物），`title` 形状不变；
//   ③ 反向锁：降级路径（摘要器失败）的 `foldedFacts.text` 仍是统计摘要，形状不因本修法变化。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。

import assert from "node:assert/strict";
import test from "node:test";

import { runDirect } from "../helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import {
  FOLDED_FACTS_INCREMENT_KEY,
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
} from "../../src/compact/fold-summary-journal.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";
/** 任务正文的哨兵：它只该出现在请求的 head 里，**不许**出现在折叠账本的替代物里。 */
const TASK_MARKER = "TASK_MARKER_START_657";
/** 工具输出的填充串：同上（账本里出现它就是「正文污染」）。 */
const TOOL_FILLER = "z";

/**
 * `fold-llm` 的 fake provider。
 *
 * @param {{ toolTurns?: number, summaryBytes?: number, failSummary?: boolean }} [options]
 */
function makeProvider({ toolTurns = 4, summaryBytes = 400, failSummary = false } = {}) {
  let turns = 0;
  let summaries = 0;
  const requests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaries += 1;
        if (failSummary) throw new Error("summarizer exploded (657 fixture)");
        return {
          content: [{ type: "text", text: `## 阶段\nLLM_SUMMARY_${summaries}\n${"s".repeat(summaryBytes)}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      requests.push(request);
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `case-${turns}` } }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  provider.chatStream = provider.chat;
  provider.summaryCalls = () => summaries;
  return provider;
}

/** 跑一条 `fold-llm` 折叠链，返回账本里的折叠记录与事件面的 compaction 统计。 */
async function runChain({ runId, provider, budgetTokens = 1000, toolBytes = 600, seedBytes = 1500 }) {
  const stats = [];
  const store = createMemoryTranscriptStore();
  const result = await runDirect({
    provider,
    executeTool: async ({ id }) => `tool output ${id} ${TOOL_FILLER.repeat(toolBytes)}`,
    // 全部用规位拼写（不新增扁平写点，`test/compat-pin-inventory.md` 因此不漂）。
    config: {
      run: { maxRounds: 20, completion: false, reflection: false },
      folding: { context: { budgetTokens, keepRounds: 0, strategy: "fold-llm" } },
    },
    seed: `${TASK_MARKER} ${"y".repeat(seedBytes)}`,
    store,
    runId,
    capabilities: { hooks: { onEvent: (event) => { if (event.type === "compaction") stats.push(event.compaction); } } },
  });
  const records = await store.load(runId);
  const folds = records
    .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => ({ round: record.round, facts: record[FOLDED_FACTS_RECORD_FIELD] }));
  return { result, folds, stats };
}

/** 模型**真的看见过**的那些 text 块（折叠后每一发主请求的全文）。 */
function seenTexts(provider) {
  const texts = [];
  for (const request of provider.requests) {
    for (const message of request?.messages ?? []) {
      const blocks = typeof message?.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
  }
  return texts;
}

test("#657-6 成功的 fold-llm 折叠：`foldedFacts.text` 不含任务原文，且等于交给上下文的那份累计摘要", async () => {
  const provider = makeProvider({ toolTurns: 4, summaryBytes: 400 });
  const { folds } = await runChain({ runId: "657-6-success", provider });
  assert.equal(folds.length, 1, `前置：本夹具恰好折一次（实测 ${folds.length}）`);
  assert.ok(provider.summaryCalls() >= 1, "前置：走的是真摘要器那条路（否则测的是降级分支）");

  const { facts } = folds[0];
  // ① 摘要在场（这条改前也成立：`fedSummaryText` 的第一块就是摘要）。
  assert.equal(facts.text.startsWith("## 阶段"), true,
    `累计替代物必须以摘要首行开头（实测 ${JSON.stringify(facts.text.slice(0, 40))}）`);
  // ② **起锁的那一条**：任务原文不许出现。改前它是 `fedSummaryText` = 摘要 + 原任务正文。
  assert.equal(facts.text.includes(TASK_MARKER), false,
    "折叠替代物里出现了任务原文哨兵 ⇒ 账本记的是「折叠后那条消息的全文」，不是摘要（#657 缺陷二）");
  assert.equal(/y{40}/u.test(facts.text), false,
    "折叠替代物里出现了任务正文的填充串（y×40）");
  assert.equal(new RegExp(`${TOOL_FILLER}{40}`, "u").test(facts.text), false,
    "折叠替代物里出现了工具输出的填充串（z×40）");
  // ③ 逐字等于模型这一折真拿到的那份累计摘要（不是「看起来像摘要」）。
  const seen = seenTexts(provider);
  assert.ok(seen.includes(facts.text),
    "`foldedFacts.text` 必须**逐字**是模型看见过的那份累计摘要（两份不同的文本 = 账本又在自说自话）");
  // ④ 不再贴着上界，也不再被夹断。
  assert.ok(facts.bytes < FOLDED_FACTS_MAX_BYTES,
    `摘要本身远小于上界（实测 ${facts.bytes} / ${FOLDED_FACTS_MAX_BYTES}）`);
  assert.equal(facts.truncated, undefined, "没有被夹断就不写 truncated（「无事实 ⇒ 无键」）");
  assert.equal(facts.bytesBefore, undefined, "没有夹断就没有 bytesBefore");
});

test("#657-7 同一折的 `increment` 逐字不变（仍是机械替代物），`title` 形状不变", async () => {
  const provider = makeProvider({ toolTurns: 4, summaryBytes: 400 });
  const { folds } = await runChain({ runId: "657-7-increment", provider });
  const { facts } = folds[0];
  const increment = facts[FOLDED_FACTS_INCREMENT_KEY];
  assert.ok(increment !== undefined, "前置：这一折必须落了增量");
  // 增量的来源是 `summarizeFoldedPayload`（零 LLM 的机械替代物）：带固定的区间句 + 工具清单。
  assert.equal(increment.text.startsWith("【上下文折叠·v1·"), true,
    `增量仍是机械替代物（实测 ${JSON.stringify(increment.text.slice(0, 40))}）`);
  assert.match(increment.text, /早期第 1–\d+ 轮（共 \d+ 轮）已折叠/u, "增量的区间句在场");
  assert.match(increment.text, /- exec case-1/u, "增量的工具清单在场");
  assert.equal(increment.origin, "mechanical", "增量自报 mechanical（摘要器没参与它）");
  assert.equal(increment.text.includes("LLM_SUMMARY_1"), false,
    "增量里不许出现摘要器的产物（那是父键的写者，不是增量的）");
  assert.notEqual(increment.text, facts.text, "增量与累计体是两个写者、两份正文");
  // `title` 形状不变（#565 口径）：字符串、取自正文首行、剥掉引擎 marker 前缀、≤ 60 字符。
  assert.equal(typeof facts.title, "string");
  assert.ok(Array.from(facts.title).length <= 60, `title 仍受 60 字符上界（实测 ${Array.from(facts.title).length}）`);
  assert.equal(increment.text.includes(increment.title), true,
    "`title` 仍是正文首行的连续子串（#565 的「夹断后 title 仍存活」就靠这条）");
  assert.equal(increment.title.startsWith("早期第 1–"), true,
    `title 仍剥掉引擎 marker 前缀（实测 ${JSON.stringify(increment.title)}）`);
  assert.equal(facts.origin, "semantic", "父键的 origin 仍是 semantic（摘要器写的）");
});

test("#657-8 反向锁（issue #661 反转）：摘要器失败 ⇒ 根本没有 `foldedFacts`", async () => {
  // PR #660 在这里加的是一条「降级路径反向锁」——它锁的正是 issue #661 删掉的那条分支。
  // 处置（工单 §3 特别交代）：**不许删格子**，改写成「失败 ⇒ 一个折叠记录都没有」：
  // 没有统计摘要替代物、没有 `source:"statistical"`、也没有 `degradeReason`。
  const provider = makeProvider({ toolTurns: 4, summaryBytes: 400, failSummary: true });
  const store = createMemoryTranscriptStore();
  const events = [];
  const failure = await runDirect({
    provider,
    executeTool: async ({ id }) => `tool output ${id} ${TOOL_FILLER.repeat(600)}`,
    config: {
      run: { maxRounds: 20, completion: false, reflection: false },
      folding: { context: { budgetTokens: 1000, keepRounds: 0, strategy: "fold-llm" } },
    },
    seed: `${TASK_MARKER} ${"y".repeat(1500)}`,
    store,
    runId: "657-8-degrade",
    capabilities: {
      hooks: {
        onEvent: (event) => { if (event.type === "compaction") events.push(event.compaction); },
      },
    },
  }).then(
    () => assert.fail("摘要器失败必须让 run 以 failed 终局（不许降级成统计摘要）"),
    (error) => error,
  );

  assert.equal(failure.code, "summarizer_failed");
  assert.equal(failure.details.kind, "error");
  assert.equal(failure.termination?.reason, "failed");
  const records = await store.load("657-8-degrade");
  assert.deepEqual(
    records.filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined),
    [],
    "失败那一折不许留下 `foldedFacts`（一个键都不许出现）",
  );
  assert.deepEqual(events, [], "也不许留下 compaction 事件（stats 与事件同一处落点）");
});

test("#657-9 `compactionStats[].foldSummary` 不受影响：那里 `text` 显式写死为 undefined（正文只走账本）", async () => {
  const provider = makeProvider({ toolTurns: 4, summaryBytes: 400 });
  const { stats, folds } = await runChain({ runId: "657-9-stat-shape", provider });
  assert.ok(stats.length >= 1, "前置：必须有 compaction 统计");
  for (const stat of stats) {
    if (stat.foldSummary === undefined) continue;
    assert.equal(stat.foldSummary.text, undefined,
      "`compactionStats[].foldSummary.text` 必须缺席（#469-④ 的尺寸口径：正文只在轮记录上）");
  }
  assert.ok(folds.length >= 1, "前置：这一格同时验证了账本侧确实有正文");
});
