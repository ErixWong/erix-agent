// issue #601 的**接线**判据：折叠记录账本（轮记录 `foldedFacts`，一折一条）真的被线到了渲染处。
//
// 为什么单独一格：`test/compact/fold-summary-segments-601.test.js` 里的判据 1–7 都是**策略级**
// （直接调 `strategy.compact()`），它们证明「给一份列表就能渲染成该有的样子」，但证明不了
// 「引擎真的把列表给了它」。本格跑**真引擎**（fake provider + 内存 store），用一个转发的策略
// 对象把每次 `compact()` 收到的 `foldRecords` 抄下来：
//   · 第 1 次折叠：账本空（此前一折都没有）；
//   · 之后每折一次，下一次的账本恰好长一条，且最早那条的 `from/to/rounds` 就是第 1 折的区间；
//   · 列表是**非枚举**属性（与 `roundNumbers` 同口径）⇒ 选项键面逐字不变。
//
// 零真实 LLM、零网络、零 `~/.erix`（fake provider + 内存 store）。

import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";

const toolStep = (index) => ({
  content: [{
    type: "tool_use",
    id: `call-${index}`,
    name: "echo",
    input: { text: `step-${index}` },
  }],
  stopReason: "tool_use",
});

test("#601-8 引擎把折叠记录账本线到渲染处（每折长一条，最新一折在列表尾）", async () => {
  const provider = createFakeProvider([
    ...Array.from({ length: 5 }, (_, index) => toolStep(index + 1)),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const inner = createFoldStatisticalStrategy();
  /** @type {{ length: number, first?: any, enumerable: boolean }[]} */
  const seen = [];
  let asks = 0;
  const strategy = {
    name: "fold-statistical",
    // 由本格**自己**决定何时折（第 2 次被问到起，每轮都折）⇒ 折叠次数与轮数同阶，不受预算摆动影响。
    shouldCompact: () => {
      asks += 1;
      return asks >= 2;
    },
    async compact(messages, options = {}) {
      seen.push({
        length: Array.isArray(options.foldRecords) ? options.foldRecords.length : -1,
        first: Array.isArray(options.foldRecords) ? options.foldRecords[0] : undefined,
        // 非枚举（`Object.defineProperty`）⇒ 不参与 `Object.keys` / JSON 的选项键面。
        enumerable: Object.keys(options).includes("foldRecords"),
      });
      return inner.compact(messages, options);
    },
  };

  const result = await runDirect({
    capabilities: { ports: { strategy } },
    provider,
    initialUserMessage: "start",
    // 每次结果不同：与「同一发调用反复重试」区分开（stallDetection 默认开着时也不会误判）。
    executeTool: async ({ input }) => `ok:${String(input?.text ?? "")}`,
    maxRounds: 8,
    store: createMemoryTranscriptStore(),
    // budgetTokens 放大：让折叠由 `shouldCompact` 决定，避免「仍超预算」的兜底再加一次折叠。
    config: {
      input: { cacheStablePrefix: false },
      folding: { context: { budgetTokens: 1_000_000, keepRounds: 1 } },
      run: { completion: false },
    },
  });

  const foldedStats = result.compactionStats.filter((stat) => stat.foldedRounds > 0);
  assert.ok(foldedStats.length >= 2,
    `前提：本 run 必须真的折过 ≥2 次，实测 ${foldedStats.length}`);

  assert.ok(seen.length >= 3, `前提：策略必须被问到 ≥3 次折叠，实测 ${seen.length}`);
  assert.equal(seen[0].length, 0, "第 1 次折叠时账本是空的（此前一折都没有）");
  assert.equal(seen[0].enumerable, false,
    "账本走非枚举属性（选项键面逐字不变，与 roundNumbers 同口径）");

  const lengths = seen.map((entry) => entry.length);
  for (let index = 1; index < lengths.length; index += 1) {
    assert.ok(lengths[index] >= lengths[index - 1],
      `账本只增不减：${JSON.stringify(lengths)}`);
  }
  // 第 2 次折叠起，列表里最早那条就是第 1 折自己的记录（区间/计数都是结构化键）。
  const second = seen.find((entry) => entry.length > 0);
  assert.ok(second !== undefined, `折叠过之后账本必须长出来：${JSON.stringify(lengths)}`);
  assert.equal(second.first.from, 1, `最早那条记录是第 1 折：${JSON.stringify(second.first?.from)}`);
  assert.ok(Number.isSafeInteger(second.first.to) && second.first.to >= 1);
  assert.ok(Number.isSafeInteger(second.first.rounds) && second.first.rounds >= 1);
  // 落盘的那份事实同样在（账本与轮记录同源）。
  assert.ok(result.compactionStats.some((stat) => stat.foldedRounds > 0));
});
