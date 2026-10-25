// issue #462 取证：resume 不按 foldedThrough 裁正文 ⇒ 折叠在续跑时重做一遍。
//
// 跑法：`node scripts/probe-462-resume-refold.mjs`。A/B 用 `fold-statistical`（没有摘要器 ⇒
// 落不出 `foldedSummary` 事实 ⇒ 读侧按边界①**不动**，这两段是「修后行为不变」的对照）；
// D 段用宿主自带的 `fold-llm`（有摘要事实 ⇒ 读侧生效），逐次续跑打印「喂进 compact 的消息数 /
// 摘要输入字节 / 折走区间」与账本行数 —— 修前的曲线是 8→11→16→21→26→31→36 线性、
// 折走区间恒为 `{from:1,…}`、16 轮会话摘要累计输入 210 645 B。
// 量三件事：① 每次折叠的 tokensBefore 是否随会话增长；② resume 后第一个请求体有多大；
// ③ resume 后第一次折叠是否比连续跑砍得更狠（keepRounds 误收紧的证据 = foldedRounds 变大）。
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "../test/helpers/fake-provider.js";

const BUDGET = 4000;
const TOOL_BYTES = 4000;
const ROUNDS = 12;
const CRASH_AFTER = 5;

const toolStep = (n) => ({
  content: [{ type: "tool_use", id: `call-${n}`, name: "work", input: { step: n } }],
  stopReason: "tool_use",
});
const endStep = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const big = (n) => "x".repeat(n);
const bodyBytes = (request) => JSON.stringify(request?.messages ?? []).length;
const loopOptions = (runId, store, provider, extra = {}) => ({
  provider,
  initialUserMessage: `start ${big(2000)}`,
  executeTool: async ({ input }) => `out-${input.step}: ${big(TOOL_BYTES)}`,
  completion: false,
  cacheStablePrefix: false,
  context: { strategy: "fold-statistical", budgetTokens: BUDGET, keepRounds: 4 },
  store,
  runId,
  ...extra,
});
const show = (label, result, provider) => {
  const stats = (result?.compactionStats ?? []).filter((s) => s.compacted);
  console.log(`\n== ${label} ==`);
  console.log("rounds:", result?.rounds, "| folds:", stats.length);
  console.log("tokensBefore:", stats.map((s) => s.tokensBefore).join(", "));
  console.log("foldedRounds:", stats.map((s) => s.foldedRounds).join(", "));
  console.log("req body bytes:", provider.requests.map(bodyBytes).join(", "));
};

// A：连续跑，不崩溃
const storeA = createMemoryTranscriptStore();
const stepsA = [];
for (let i = 1; i <= ROUNDS; i += 1) stepsA.push(toolStep(i));
stepsA.push(endStep("done"));
const provA = createFakeProvider(stepsA);
const resA = await runToolLoop(loopOptions("p462-a", storeA, provA, { maxRounds: ROUNDS + 1 }));
show("A 连续跑（对照）", resA, provA);

// B：同样 12 轮，跑 CRASH_AFTER 轮后崩，再 resume 续完
const storeB = createMemoryTranscriptStore();
const crashSteps = [];
for (let i = 1; i <= CRASH_AFTER; i += 1) crashSteps.push(toolStep(i));
crashSteps.push({ throw: new Error("boom: 崩溃在崩溃轮的模型调用") });
const provB1 = createFakeProvider(crashSteps);
let resB1;
try {
  resB1 = await runToolLoop(loopOptions("p462-b", storeB, provB1, { maxRounds: ROUNDS + 1 }));
} catch (error) {
  console.log("\n[第一次运行崩了]", error.message);
}
const recordsAfterCrash = await storeB.load("p462-b");
console.log("崩溃后 foldedThrough(重算口径) =",
  Math.max(0, ...recordsAfterCrash.map((r) => r.foldedRoundRange?.to ?? 0)),
  "| 账本行数 =", recordsAfterCrash.length);
show("B1 崩溃前", resB1, provB1);

const resumeSteps = [];
for (let i = CRASH_AFTER + 1; i <= ROUNDS; i += 1) resumeSteps.push(toolStep(i));
resumeSteps.push(endStep("done"));
const provB2 = createFakeProvider(resumeSteps);
const resB2 = await runToolLoop(loopOptions("p462-b", storeB, provB2, {
  maxRounds: ROUNDS + 1,
  resume: true,
}));
show("B2 resume 后", resB2, provB2);
console.log("\nresume 后第一个请求体 =", bodyBytes(provB2.requests[0]), "bytes; 连续跑同轮 =",
  bodyBytes(provA.requests[CRASH_AFTER]), "bytes");

// C：反复 resume（每 2 轮崩一次，共 6 次）—— 判据 1 的形状：tokensBefore 是否随会话单调上升。
const storeC = createMemoryTranscriptStore();
const CYCLES = 6;
const PER = 2;
let foldFirst = [];
let totalBytes = 0;
let roundBase = 0;
for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
  const steps = [];
  for (let i = 1; i <= PER; i += 1) steps.push(toolStep(roundBase + i));
  steps.push({ throw: new Error(`boom: cycle ${cycle}`) });
  const prov = createFakeProvider(steps);
  let res;
  try {
    res = await runToolLoop(loopOptions("p462-c", storeC, prov, {
      maxRounds: 4,
      resume: cycle > 1,
      ...(cycle === 1 ? {} : {}),
    }));
  } catch { /* 预期崩 */ }
  totalBytes += prov.requests.reduce((sum, r) => sum + bodyBytes(r), 0);
  const stats = (res?.compactionStats ?? []).filter((s) => s.compacted);
  if (stats.length > 0) foldFirst.push(`${stats[0].tokensBefore}/${stats[0].foldedRounds}r`);
  roundBase = (res?.rounds ?? roundBase + PER);
  const recs = await storeC.load("p462-c");
  console.log(`cycle ${cycle}: rows=${recs.length}`,
    "foldedThrough=", Math.max(0, ...recs.map((r) => r.foldedRoundRange?.to ?? 0)),
    "| 本次 fold tokensBefore/foldedRounds:", foldFirst.at(-1) ?? "-");
}
console.log("\nC: 每次 resume 后首次折叠 (tokensBefore/foldedRounds) =", foldFirst.join(" → "));
console.log("C: 全程喂给模型的请求体累计 =", totalBytes, "bytes");

// D：折走区间与摘要输入的逐次曲线（宿主自带 fold-llm ⇒ 有 `foldedSummary` 事实 ⇒ 读侧生效）
import { createFoldLlmStrategy } from "../src/compact/fold-llm.js";
const dSummary = [];
const dInner = createFoldLlmStrategy({
  summarizer: async ({ messages, roundRange }) => {
    dSummary.push({ bytes: JSON.stringify(messages).length, from: roundRange?.from ?? null });
    return `SUMMARY_D_${String(dSummary.length)}`;
  },
});
const dStrategy = {
  name: dInner.name,
  shouldCompact: (m, b) => dInner.shouldCompact(m, b),
  compact: (m, o) => dInner.compact(m, o),
};
const storeD = createMemoryTranscriptStore();
const curve = [];
let dRoundBase = 0;
for (let cycle = 1; cycle <= 8; cycle += 1) {
  const steps = [];
  for (let i = 1; i <= 2; i += 1) steps.push(toolStep(dRoundBase + i));
  steps.push({ throw: new Error(`boom: cycle ${cycle}`) });
  let msgsIn = 0;
  const wrapped = {
    name: dStrategy.name,
    shouldCompact: (m, b) => dStrategy.shouldCompact(m, b),
    async compact(m, o) {
      const r = await dStrategy.compact(m, o);
      if (r?.foldedRoundRange !== undefined) {
        msgsIn = Math.max(msgsIn, m.length);
        curve.push(`msgs=${String(m.length)} range=${JSON.stringify(r.foldedRoundRange)}`);
      }
      return r;
    },
  };
  try {
    const r = await runToolLoop(loopOptions("p462-d", storeD, createFakeProvider(steps), {
      maxRounds: 6,
      ...(cycle > 1 ? { resume: true } : {}),
      context: { strategy: wrapped, budgetTokens: 4000, keepRounds: 1 },
    }));
    dRoundBase = r?.rounds ?? dRoundBase + 2;
  } catch { dRoundBase += 2; }
  const recs = await storeD.load("p462-d");
  console.log(`D cycle ${cycle}: 账本行数=${String(recs.length)}`,
    "foldedThrough=", String(Math.max(0, ...recs.map((r) => r.foldedRoundRange?.to ?? 0))),
    "| 本次续跑折叠:", curve.slice(-1)[0] ?? "-");
}
console.log("\nD: 摘要调用", String(dSummary.length), "次, 累计输入",
  String(dSummary.reduce((a, c) => a + c.bytes, 0)), "bytes, 单次最大",
  String(Math.max(0, ...dSummary.map((c) => c.bytes))), "bytes");
