// issue #470 的两格判据 + 一条端到端（评审指出：`0f695092` 上"放宽一格"是死代码，必须用
// **真实形状**验，而不是手搓一个恰好能被读侧接受的对象）。
//
//   判据①：写入端 `orchestrator.js` 落进轮记录的是 `buildFoldedFacts()` 的**平铺对象**，
//          读侧 `pickCoveringFoldAlternative` 曾经只认数组 ⇒ 那一格永不触发。
//   判据②：`sliding-window` 带出的键名是 `foldedSummaryText`，消费端曾经只读 `result.foldSummary`
//          ⇒ 那份零 LLM 机械文本没有任何消费者。
//   端到端：滑窗折叠 → `record.foldedFacts` 存在 → resume 按水位线裁正文且 `summarySource === "strategy"`。
//
// 零真实 LLM：只用 fake provider + 内置 store；断言一律读 `store.load()` 的原始记录。
import assert from "node:assert/strict";
import test from "node:test";

import { buildFoldedFacts, FOLDED_FACTS_RECORD_FIELD } from "../src/compact/fold-summary-journal.js";
import * as foldTrimApi from "../src/compact/resume-fold-trim.js";

const pickCoveringFoldAlternative = foldTrimApi.pickCoveringFoldAlternative;
// 名字以**被测模块的导出**为准，不按记忆写：优先 Context 版，再退到 plan/build 变体。
const buildFoldedHistoryContext = foldTrimApi.buildFoldedHistoryContext
  ?? foldTrimApi.buildFoldedHistory
  ?? foldTrimApi.planFoldedHistoryContext
  ?? foldTrimApi.planFoldedHistoryTrim;
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => (block?.type === "tool_result"
    ? String(block.content ?? "")
    : block?.type === "text" ? String(block.text ?? "") : "")).join("\n")
  : String(message?.content ?? ""));

test("判据①：record.foldedFacts 是 buildFoldedFacts 的真实返回值时，读侧必须拾取并裁正文 (#470)", () => {
  // 真实形状由被测函数自己给出 —— 不手搓。
  const fact = buildFoldedFacts({
    text: "## 阶段\n第 1..3 轮被折叠，工具调用 4 次。",
    source: "strategy",
    strategy: "sliding-window",
    roundRange: { from: 1, to: 3 },
    rounds: 3,
  });
  assert.ok(fact && typeof fact === "object" && !Array.isArray(fact) && typeof fact.text === "string",
    `buildFoldedFacts 的真实形状应当是平铺对象，实测 ${JSON.stringify(fact)?.slice(0, 80)}`);

  const record = { round: 3, [FOLDED_FACTS_RECORD_FIELD]: fact };
  const picked = pickCoveringFoldAlternative([record], 3);
  assert.ok(picked, "覆盖到水位线的 foldedFacts 必须被拾取（此前只认数组 ⇒ 那一格是死代码）");
  assert.equal(picked.origin, "strategy");

  const ledgerEntries = [1, 2, 3].map((round) => ({
    message: { role: "user", content: `第 ${round} 轮的原始正文` },
    round,
  }));
  const plan = buildFoldedHistoryContext({ ledgerEntries, records: [record], foldedThrough: 3 });
  assert.equal(plan.applied, true, `必须真的裁：reason=${plan.reason}`);
  assert.equal(plan.summarySource, "strategy");
  assert.equal(plan.dropped.length, 3, "有替代物却没裁 ⇒ 读侧仍没接上写入端的形状");
  assert.ok(plan.summaryText.includes("第 1..3 轮被折叠"));
  assert.ok(!plan.messages.map((entry) => textOf(entry.message)).join("\n").includes("第 2 轮的原始正文"),
    "被裁的那些轮不得留在续跑上下文里");
});

// 判据②（本轮已解 skip 跑绿）。红因与修法（实测，不是推测）：
// 实测红因（调试脚本 tmp-dbg-470 的输出见 docs/tasks/wip-470/tmp-dbg-470.txt（脚本是一次性的，已清理））：
// 折叠确实发生（`compactionStats` 每轮 `compacted:true`、`slidingWindow.triggered:1`、轮记录带
// `foldedRoundRange`），但 8 条记录里 **0 条**有 `foldedFacts` ⇒ 写入端那一步（`orchestrator.js`
// 里 `pendingFoldedFacts = buildFoldedFacts({ text: strategyFoldSummary?.text ?? fedSummaryText … })`）
// 在这条端到端路径上没有被执行/没落到轮记录。解 skip 时断言口径不动：
// `source === "strategy"` / `record.summary` 不被替代物覆盖 / resume 侧 `summarySource === "strategy"`。
test("判据②+端到端：滑窗折叠 → foldedFacts 落账（用的是策略文本）→ resume 裁正文 (#470)", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "s-470-e2e";
  let turns = 0;
  const provider = {
    // fake provider 的判别键：缺了它 runToolLoop 不会把这份 provider 当 fake 协议驱动。
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < 6) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "echo", input: { text: `R${turns}_${"填充".repeat(300)}` } }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;

  // runToolLoop 是**单参数 options**；工具是数组 + executeTool，不是 map。
  const run = await runToolLoop({ capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
    provider,
    runId,
    store,
    initialUserMessage: "开始任务",
    tools: [{ name: "echo", description: "回显输入", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    executeTool: async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`,
    maxRounds: 20,
    completion: false,
    wrapup: false,
    stallDetection: false,
    // 折叠开关住在 `context` 里（`budgetTokens` / `keepRounds` / `strategy`），没有 `compaction` 这个键。
    config: { folding: { context: { budgetTokens: 300, keepRounds: 1, } } },
  });
  assert.ok(String(run?.finalText ?? "").includes("收尾结论"),
    `run 没正常收尾：${JSON.stringify(run?.termination ?? {})} rounds=${run?.rounds}`);

  const records = await store.load(runId);
  const withFacts = records.filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined);
  assert.ok(withFacts.length > 0, "sliding-window 折叠必须在轮记录上留下 foldedFacts（判据②：此前只 return 不消费）");
  const fact = withFacts[0][FOLDED_FACTS_RECORD_FIELD];
  assert.equal(fact.source, "strategy");
  assert.match(fact.text, /折叠/,
    `foldedFacts.text 必须是策略带出的机械文本，实测 ${JSON.stringify(String(fact.text).slice(0, 120))}`);
  assert.notEqual(withFacts[0].summary, fact.text, "record.summary（本轮自身摘要）不得被替代物覆盖");

  const ledgerEntries = records.flatMap((record) => (record.messages ?? [])
    .map((message) => ({ message, round: Number(record.round ?? 0) })));
  const plan = buildFoldedHistoryContext({
    ledgerEntries,
    records,
    // 水位线按 **#462 的口径**取（`foldedRoundRange.to`），不是「最大轮号」：折叠发生在轮首，
    // 最大轮号那轮的正文本来就还没折走，拿它当水位线是量错了对象。
    foldedThrough: Math.max(...records.map((r) => Number(r.foldedRoundRange?.to ?? 0))),
  });
  assert.ok(plan.applied === true, `resume 侧必须按水位线裁正文，实测 reason=${plan.reason}`);
  assert.ok(plan.dropped.length > 0);
  assert.equal(plan.summarySource, "strategy");
});
