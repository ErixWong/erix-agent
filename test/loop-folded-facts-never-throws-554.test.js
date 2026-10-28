// issue #554 —— `maxFoldedFactsBytes` **从不抛**：这一格是给「顺手加校验」的人设的闸门。
//
// 裁决（#554，已执行在文档侧）：**只改文档、不加校验**。理由是 #551 甲已经裁过
// `config.folding.context` 是**自由壳**（引擎按名读、不校验），在壳里单开一条值规则会与那条裁决
// 互相打脸。所以本片给的是**正向**判据（「坏值也照常跑」），不是「还没有人校验」的缺席证明：
//
//   ① 直连路线 `config.folding.context.maxFoldedFactsBytes = 0` **不抛**；
//   ② 装配口路线 `policy.context.maxFoldedFactsBytes = 0` **不抛**（`policy` 只在装配口那一路有效：
//      直连顶层写 `policy` 会先撞 `unknown runToolLoop option: "policy"`，那不是本格要测的东西）；
//   ③ 两条路线都**照常折叠**，且折叠替代物**不是 0 字节**——坏值在 `buildFoldedFacts` 内部退回默认
//      （`FOLDED_FACTS_MAX_BYTES` = 2048，`src/compact/fold-summary-journal.js`），而不是被当成
//      「上界 0」夹成空横幅（`src/loop/orchestrator.js` 折叠落账处的注释：#470-D 刻意选的）。
//
// 为什么这格必须存在：契约（EN/CN 各一处）现在写的是「**never throws**：不是安全正整数的取值在
// `buildFoldedFacts` 内部退回默认」。谁「顺手」把 `maxFoldedFactsBytes must be a positive integer`
// 加回启动期校验（或在校验器里补一条值规则），这格立刻红——文档与代码不许再分叉。
// ⚠ 反向别读错：本格证明的不是「这个值被采纳」，而是**形状被接受、取值被忽略并退回默认**。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。

import assert from "node:assert/strict";
import test from "node:test";

import { createAssemblyPort } from "../src/assembly.js";
import { FOLDED_FACTS_MAX_BYTES, FOLDED_FACTS_RECORD_FIELD } from "../src/compact/fold-summary-journal.js";
import { createSlidingWindowStrategy } from "../src/compact/sliding-window.js";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const TOOLS = [{
  name: "echo",
  description: "回显输入",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
}];

/** 先 6 发工具调用把上下文撑起来（折叠必然发生），再收尾——与 #470 的折叠判据同一套 fake。 */
function makeProvider({ toolTurns = 6 } = {}) {
  let turns = 0;
  const provider = {
    // fake 协议的判别键：缺了它 runToolLoop 不会把这份 provider 当 fake 驱动。
    protocol: "fake",
    model: "fake-model",
    async chat() {
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{
            type: "tool_use",
            id: `tu_${turns}`,
            name: "echo",
            input: { text: `R${turns}_${"填充".repeat(300)}` },
          }],
          stopReason: "tool_use",
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

const executeTool = async ({ input }) => `ECHO:${String(input?.text ?? "").slice(0, 40)}`;

/** 折叠替代物的账本行（`record.foldedFacts`）。 */
function foldedFactsOf(records) {
  return records
    .filter((record) => record[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => record[FOLDED_FACTS_RECORD_FIELD]);
}

/**
 * 一条路线跑出来的结果必须满足的全部判据（两条路线共用，避免「一格一套口径」）。
 *
 * `label` 只用于红的时候说清是哪条路线。
 */
function assertFactsSurvived(facts, label) {
  assert.ok(
    facts.length > 0,
    `${label}：前提不成立——这条路径根本没折叠（那样这格只是在测空气，不是「坏值也照常跑」）`,
  );
  for (const fact of facts) {
    assert.equal(typeof fact.text, "string", `${label}：折叠替代物必须带 text`);
    assert.ok(
      fact.text.length > 0,
      `${label}：折叠替代物被夹成了 0 字节空横幅——坏值必须退回默认，而不是把上界当成 0`,
    );
    assert.ok(
      Number.isSafeInteger(fact.bytes) && fact.bytes > 0,
      `${label}：替代物字节数必须 > 0，实测 ${String(fact.bytes)}`,
    );
    assert.ok(
      fact.bytes <= FOLDED_FACTS_MAX_BYTES,
      `${label}：退回默认之后仍不得超过默认上界 ${FOLDED_FACTS_MAX_BYTES}，实测 ${fact.bytes}`,
    );
    assert.equal(
      fact.truncated,
      undefined,
      `${label}：退回默认（2048）之后不该标 truncated——标了说明真按某个小上界夹断过`,
    );
  }
}

// ================================================================ ① 直连路线

test("①直连：config.folding.context.maxFoldedFactsBytes = 0 不抛，且折叠替代物不是 0 字节 (#554)", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "s-554-direct";
  // 「不抛」就是这一行：任何启动期/折叠期的校验都会让 `await` 抛出来 ⇒ 本格红。
  const run = await runToolLoop({
    provider: makeProvider(),
    store,
    tools: TOOLS,
    executeTool,
    config: {
      run: { runId, completion: false, maxRounds: 20 },
      input: { initialUserMessage: "开始任务" },
      folding: { context: { budgetTokens: 300, keepRounds: 1, maxFoldedFactsBytes: 0 } },
    },
    capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
  });
  assert.equal(run.termination.reason, "end_turn", "坏值不许把 run 拖死或改写终局");
  assertFactsSurvived(foldedFactsOf(await store.load(runId)), "直连路线");
});

// ================================================================ ② 装配口路线（policy 只在这里有效）

test("②装配口：policy.context.maxFoldedFactsBytes = 0 不抛，且折叠替代物不是 0 字节 (#554)", async () => {
  const store = createMemoryTranscriptStore();
  // `createAssemblyPort` 本身也是「不抛」的一部分：谁在装配期给这个叶子加值校验，这里先红。
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: makeProvider(),
    store,
    tools: { definitions: TOOLS, executeTool },
    session: { id: "s-554-port", initialMessages: [{ role: "user", content: "开始任务" }] },
    policy: {
      context: { maxFoldedFactsBytes: 0, budgetTokens: 300, keepRounds: 1 },
      capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
    },
  });
  const run = await runToolLoop({
    assemblyPort: port,
    config: { run: { completion: false, maxRounds: 20 } },
  });
  assert.equal(run.termination.reason, "end_turn", "坏值不许把 run 拖死或改写终局");
  assertFactsSurvived(foldedFactsOf(await store.load("s-554-port")), "装配口路线");
});

test("②对照：同一条 policy 路线换成合法小上界 ⇒ 真的夹断（证明这一路不是「配了等于没配」） (#554)", async () => {
  // 没有这一格，上面那格可以被「`policy.context` 根本没到达引擎」满足——那就成了假绿。
  const store = createMemoryTranscriptStore();
  const port = createAssemblyPort({
    modelConfig: { resolve: async () => ({ contextWindowTokens: 100000, maxOutputTokens: 1024 }) },
    provider: makeProvider(),
    store,
    tools: { definitions: TOOLS, executeTool },
    session: { id: "s-554-port-clamp", initialMessages: [{ role: "user", content: "开始任务" }] },
    policy: {
      context: { maxFoldedFactsBytes: 120, budgetTokens: 300, keepRounds: 1 },
      capabilities: { ports: { strategy: createSlidingWindowStrategy({ keepRounds: 1 }) } },
    },
  });
  await runToolLoop({ assemblyPort: port, config: { run: { completion: false, maxRounds: 20 } } });
  const facts = foldedFactsOf(await store.load("s-554-port-clamp"));
  assert.ok(facts.length > 0, "前提：对照路线也必须真的折叠");
  for (const fact of facts) {
    assert.ok(fact.bytes <= 120, `合法小上界必须真的生效，实测 ${fact.bytes}`);
    assert.equal(fact.truncated, true, "超过上界必须如实标 truncated");
    assert.ok(fact.text !== "", "夹断也不许夹成空串");
  }
});
