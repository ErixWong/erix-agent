// issue #464 A：库层折叠兜底的可观测性。
//
// 背景（票面事实，已复核）：`context.strategy` 未配置时，引擎库层在「超预算兜底」那一格直接
// `createSlidingWindowStrategy()`（`src/loop/orchestrator.js` 折叠入口），而该策略整轮丢头部、
// 既不调 `formatFoldSummary` 也不调 `extractAnchors` ⇒ 宿主侧看到 `compaction` 事件却看不出
// 「跑的是兜底策略、什么替代物都没留」。本文件锁住补齐后的两件事：
//   ① `compaction` 统计带 `strategyName`（写**实际执行者**，含兜底的 "sliding-window"）；
//   ② 未配置策略且兜底真的发生时，一次性 `compaction_strategy_fallback` 诊断事件。
// 判据形状对齐 issue #182 的 `model_metadata_missing`：恰好一条、detail 首句固定原文可断言。
import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

const EVENT_TYPE = "compaction_strategy_fallback";
// detail 首句是 issue #464 A 约定的固定原文（宿主可直接断言），预算之后才追加真值。
const DETAIL_PREFIX = 'engine compaction fallback in effect: context.strategy is not configured, '
  + 'the library default "sliding-window" strategy drops whole head rounds without '
  + 'summary or anchors';

/** rounds 轮工具调用 + 一轮收尾文本；工具输出足够肥，稳定越过 budgetTokens。 */
function toolProvider(rounds) {
  return createFakeProvider([
    ...Array.from({ length: rounds }, (_, index) => ({
      content: [{
        type: "tool_use",
        id: `call-${index + 1}`,
        name: "work",
        input: {},
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
}

async function run(options = {}) {
  const events = [];
  const result = await runDirect({
    provider: toolProvider(8),
    initialUserMessage: "start",
    // 小窗口 → budgetTokens = 4096 - 512 - max(2000, 410) = 1584，20k 字符的工具输出必超预算。
    modelMetadata: { contextWindowTokens: 4096, maxOutputTokens: 512 },
    executeTool: async () => "y".repeat(20000),
    maxRounds: 10,
    completion: false,
    store: createMemoryTranscriptStore(),
    runId: "464-fallback",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    ...options,
  });
  return {
    result,
    events,
    compactions: events.filter((event) => event.type === "compaction"),
    notices: events.filter((event) => event.type === EVENT_TYPE),
  };
}

test("unconfigured context.strategy + budget fallback emits exactly one diagnostic and names the fallback (issue #464 A)", async () => {
  const { result, compactions, notices } = await run();

  assert.equal(result.finalText, "done");
  assert.ok(compactions.length >= 1, "预算兜底必须真的触发折叠，否则本用例无从对照");
  // 补齐前这里全是空白：事件面说不出「跑的是引擎库层兜底」。
  assert.equal(notices.length, 1, "一个 run 只允许一条兜底诊断事件");
  assert.equal(notices[0].type, EVENT_TYPE);
  assert.equal(notices[0].runId, "464-fallback");
  assert.ok(
    notices[0].detail.startsWith(DETAIL_PREFIX),
    `detail 首句必须是固定原文，实得：${notices[0].detail}`,
  );
  // 能解析出预算时如实报数（宿主据此判断自己的装配是否把折叠量推到了极端）。
  assert.match(notices[0].detail, /budgetTokens=1584/u);
  assert.match(notices[0].detail, /estimatedTokens=\d+/u);
  // ①：strategyName 写的是真正执行折叠的实例名，兜底那一格就是 "sliding-window"。
  for (const event of compactions) {
    assert.equal(event.compaction.strategyName, "sliding-window");
  }
});

test("configured strategy suppresses the diagnostic and reports its own name (issue #464 A)", async () => {
  const { compactions, notices } = await run({
    runId: "464-configured",
    config: { folding: { context: { strategy: "fold-statistical" } } },
  });

  assert.ok(compactions.length >= 1, "配置策略也必须真的折叠");
  assert.equal(notices.length, 0, "配了 context.strategy 就不存在兜底，不得发诊断事件");
  for (const event of compactions) {
    assert.equal(event.compaction.strategyName, "fold-statistical");
  }
});

test("the fallback notice is run-scoped: repeated folds share one, a second run gets its own (issue #464 A)", async () => {
  const first = await run({ runId: "464-run-a" });
  const second = await run({ runId: "464-run-b" });

  assert.equal(first.notices.length, 1);
  assert.equal(second.notices.length, 1);
  assert.equal(second.notices[0].runId, "464-run-b");
  // 去重是 run 作用域：同一 run 内即便折叠多次（轮次持续增长 ⇒ 每次都从头重折），也只有一条。
  assert.ok(
    first.compactions.length >= 1
      && first.notices.length < first.compactions.length + 1,
    "诊断事件不得随折叠次数线性增长",
  );
});

test("hosts that ignore the additive keys still see the previous compaction shape (issue #464 A)", async () => {
  const { compactions } = await run({ runId: "464-shape" });
  const { compactions: configured } = await run({
    runId: "464-shape-configured",
    config: { folding: { context: { strategy: "fold-statistical" } } },
  });

  for (const event of [...compactions, ...configured]) {
    // 既有键一字未动：这四键是 #460/#315 之后 state.json 与宿主横幅共同读的。
    for (const key of ["compacted", "foldedRounds", "tokensBefore", "tokensAfter"]) {
      assert.ok(Object.hasOwn(event.compaction, key), `缺既有键 ${key}`);
    }
    assert.deepEqual(
      Object.keys(event.compaction).filter((key) => !["strategyName"].includes(key)).sort(),
      Object.keys(event.compaction).filter((key) => key !== "strategyName").sort(),
    );
  }
});
