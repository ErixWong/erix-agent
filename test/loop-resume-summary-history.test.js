// issue #470 判据②（读侧那半格）：resume 时喂给 judge 的轮次历史**不得**出现合成的
// 字面量 `"missing"`。此前 `src/loop/resume-manager.js:231` 是 `record.summary ?? "missing"`，
// 写侧 `parseL1Summary` 的既定兜底串（#465 确认的形状）也原样进历史 ⇒ judge 看到一串分不清
// 真假的占位文本。口径正本：docs/host-consumer-contract_cn.md 的折叠段 + 本单 CHANGELOG。
import test from "node:test";
import assert from "node:assert/strict";
import { restoreResume } from "../src/loop/resume-manager.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const RUN = "resume-summary";
const msg = (text) => ({ role: "user", content: [{ type: "text", text }] });

// `restoreResume` 的第一行是 `if (!ctx.persistenceRequired) return;` ⇒ 这个键是回路的总闸，
// 缺它时整个函数静默早退（第一次尝试就栽在这里：历史数组空，不是逻辑没改到）。
const harness = (records) => {
  const store = createMemoryTranscriptStore();
  const rows = records.map((record) => ({ ...record, runId: RUN }));
  store.load = async () => rows.map((record) => ({ ...record }));
  const history = [];
  const ctx = {
    runId: RUN,
    store,
    persistenceRequired: true,
    // 回路真正的闸门是 ctx.resume（`restoreResume` 里 `if (ctx.resume && ctx.store …)`）；
    // 以及 `markRunState` 这个记账动作。两者都不是本单测的钉的对象。
    resume: true,
    markRunState: async () => undefined,
    setRunStateDirty: () => undefined,
    restorePersistedRunState: async () => 'absent',
    messages: [],
    messageRounds: new Map(),
    toolStats: new Map(),
    persistedTranscriptLength: 0,
    governorState: { errorSeen: {}, runningLog: [], l0Facts: [], historyLimit: 50 },
    restoreErrorSeen: () => {},
    addGovernorHistory: (round, summary) => { history.push({ round, summary }); },
    // engine stubs: restoreResume 从 ctx 上解构走的引擎内部动作（记账/通知类），本单测只钉
    // 「轮次历史里那格是什么」，这些一律 no-op。
    recordFileWrites: () => undefined,
    persist: async () => true,
    fail: (error) => { throw error; },
  };
  return { ctx, history };
};

test("缺 `summary` 键 ⇒ 那格是 undefined；写侧占位串 \"missing\" ⇒ 同样归一成「无摘要」", async () => {
  const { ctx, history } = harness([
    { round: 0, roundKey: `${RUN}:round:0`, messages: [msg("任务")], ts: "t0" },
    { round: 1, roundKey: `${RUN}:round:1`, messages: [msg("R1")], ts: "t1" },
    { round: 2, roundKey: `${RUN}:round:2`, messages: [msg("R2")], summary: "missing", ts: "t2" },
    { round: 3, roundKey: `${RUN}:round:3`, messages: [msg("R3")], summary: { action: "edit", note: "改了 X" }, ts: "t3" },
  ]);
  await restoreResume(ctx);
  const byRound = new Map(history.map((h) => [h.round, h]));
  assert.equal([...byRound.keys()].sort().join(","), "1,2,3", "条目条数逐字不变（#326 守卫与 stalled 输入不动）");
  assert.equal(byRound.get(1).summary, undefined, "缺键 ⇒ undefined，不得合成 \"missing\"");
  assert.equal(byRound.get(2).summary, undefined, "占位串 \"missing\" ⇒ 归一成「无摘要」");
  assert.deepEqual(byRound.get(3).summary, { action: "edit", note: "改了 X" }, "真摘要逐字不变");
  assert.ok(!JSON.stringify(history).includes('"missing"'), "整份历史里不得再出现字面量 \"missing\"");
});

test("#326 守卫逐字不变：带 `foldedSummary` 的引擎事实行仍不进治理历史", async () => {
  const { ctx, history } = harness([
    { round: 1, roundKey: `${RUN}:round:1`, messages: [msg("R1")], summary: "missing", ts: "t1" },
    { round: 2, roundKey: `${RUN}:engine:round:2:fold:fp`, messages: [], foldedSummary: "机械替代物", ts: "t2" },
  ]);
  await restoreResume(ctx);
  assert.deepEqual(history.map((h) => h.round), [1]);
});
