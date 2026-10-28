import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../src/loop/orchestrator.js";
import { runDirect } from "./helpers/run-direct.js";
import { createDeterministicRunState } from "../src/run-state.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #177 刀5 E 组 M2 的**行为锚定**测试（纯新增，不改任何既有断言语义）。
//
// 为什么存在：`foldedRoundCount` / `navigationRecordCount` 迁入 `runLoopState` 后，反向证的四项
// 变异（自增掏空 `+= foldedRounds → += 0`、`+= 1 → += 0`、run-state 键值硬编码 0）**红了 0 条**，
// 而格子初值 0 → 7 反而红 1 —— 说明「读侧 + 落盘」有人钉，**写侧与 resume 的 set 通道没人钉**：
//   · 既有折叠用例（`test/loop-fr2.test.js`）只断言 `result.compactionStats`，那是折叠**当轮**的
//     统计量，跟累计格子是两条独立的路；没有任何用例看过 `deterministic.fold.*` 的真实累计值；
//   · `resume-manager.js:40-41` 的 `ctx.foldedRoundCount = deterministic.fold?.foldedRounds ?? 0`
//     与 `ctx.navigationRecordCount = …` 是这两格唯一的跨文件写入口，既有 resume 用例的 fixture
//     里 `deterministic.fold` 缺省（⇒ 恢复的就是 0，写 0 覆盖 0 ⇒ `set` 坏掉也不红）。
// 下面两条把这两面钉住：写侧（策略真折叠出 foldedRounds=3 + 一条 navigationRecord）与
// resume 侧（恢复出 8/3 必须活着进入下一次落盘）。

const textMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });

test("策略折叠的轮数与导航记录累计进 run-state 的 fold 计数（#177 刀5-E）", async () => {
  const steps = [1, 2, 3].map((n) => ({
    content: [{
      type: "tool_use",
      id: `call-${n}`,
      name: "scan",
      input: { path: `src/f${n}.js` },
    }],
    stopReason: "tool_use",
  }));
  const provider = createFakeProvider([
    ...steps,
    { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" },
  ]);
  const replacement = [{ role: "user", content: [{ type: "text", text: "compacted context" }] }];
  let compactCalls = 0;
  const strategy = {
    shouldCompact() {
      compactCalls += 1;
      return compactCalls === 2;
    },
    async compact() {
      return {
        messages: replacement,
        compacted: true,
        foldedRounds: 3,
        foldedRoundRange: { from: 1, to: 3 },
        navigationRecord: { artifacts: ["src/f1.js"] },
        tokensBefore: 4000,
        tokensAfter: 120,
        foldedPayload: [{ round: 1, text: "folded away" }],
      };
    },
  };

  const result = await runDirect({ capabilities: { ports: { strategy: strategy } },
    provider,
    initialUserMessage: "start",
    executeTool: async () => "worked",
    maxRounds: 5,
    stallDetection: false,
    completion: false,
    // budgetTokens 放大：让策略自己决定折叠，避免「仍超预算 → 安全截断 fallback」再加一次折叠，
    // 那样累计值就不是策略报的 3 了（实测 3 + 2 = 5，断言会变成在测 fallback 而不是测本格写侧）。
    config: { input: { cacheStablePrefix: false }, folding: { context: { budgetTokens: 100_000, keepRounds: 4 } } },
  });

  // 前提：折叠确实发生了（否则下面的累计值是空断言）
  assert.ok(compactCalls >= 2, "策略必须被问到折叠");
  assert.equal(result.compactionStats.some((stat) => stat.foldedRounds === 3), true);
  // 写侧：`runLoopState.foldedRoundCount += foldedRounds` 与 `navigationRecordCount += 1`
  assert.deepEqual(result.runState.deterministic.fold, { foldedRounds: 3, navigationRecords: 1 });
  // 读侧到模型可见文本的那一段（键名 foldedRounds/navigationRecords 是导出契约，不改）
  assert.match(result.runState.rendered, /fold=3\/1/u);
});

test("resume 恢复的 fold 计数经 ctx 写入口活着进入下一次 run-state（#177 刀5-E）", async () => {
  const runId = "fold-count-cells";
  const store = createMemoryTranscriptStore();
  const restored = createDeterministicRunState({
    runId,
    stateVersion: 4,
    rounds: 7,
    maxRounds: 1,
    foldedRounds: 8,
    navigationRecords: 3,
  });
  await store.appendRound(runId, {
    round: 0,
    messages: [textMessage("seed")],
    runState: createDeterministicRunState({ runId, stateVersion: 1, maxRounds: 1 }),
  });
  store.loadRunState = async () => restored;
  // 前提：fixture 里的 fold 计数非 0（否则 `set` 不生效也只是写 0 覆盖 0，等于没钉）
  assert.deepEqual(restored.deterministic.fold, { foldedRounds: 8, navigationRecords: 3 });

  const provider = createFakeProvider([
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runToolLoop({
    provider,
    config: { run: { resume: true, runId } },
    completion: false,
    store,
    executeTool: async () => "unused",
  });

  // 本段没有任何新折叠 ⇒ 终局计数必须就是恢复出来的那一份
  assert.deepEqual(result.runState.deterministic.fold, { foldedRounds: 8, navigationRecords: 3 });
  assert.equal(result.runState.stateVersion, 4, "同一份恢复状态（不是重新从零累计）");
});
