#!/usr/bin/env node
// issue #865（#862 修法 B）停门行为的**前后对照测量**（判据 3）。
//
// 问一句具体的话：「终稿是被文本化的工具调用」那一轮，`judge_done` 该不该停？
// 这张票要求答案必须是**数**，不是「应该更严」这种形容词。于是本脚本用 fake provider
// （零真模型、零写盘）跑三组场景，每组 N 个 run，把四件事打印成一张表：
//   · `judge_done` 触发率（`termination.reason === "judge_done"` 的 run 占比）
//   · `rounds` 均值（停门时机——本单真正挪动的东西）
//   · `termination.reason` 分布
//   · **终稿仍是「文本化工具调用」的 run 数**（读 `result.finalTextShape`，#862 修法 A 的键；
//     这才是「静默降级」本身：交付了一堆标记、run 却是绿的）
//   · 以及评审在**泄漏那一轮**上给出 `judge_done` 的次数（`judge_done@leak-round`）——停门
//     直接作用的那一格。
//
// 三组场景（fake provider 逐步脚本，判据可复跑）：
//   ① `leak_only`        —— 第 1 轮调工具，此后每轮的终稿都是那堆标记（模型没救回来）
//   ② `normal_delivery`  —— 第 1 轮调工具，此后每轮都是正常交付（**老路径对照组**）
//   ③ `leak_then_delivery` —— 第 2 轮泄漏，被 nudge 之后的那一轮真交付（混排）
//
// 前后对照的跑法（两组数字都要进交付报告）：
//   git worktree add /tmp/base-865 origin/main      # base（改动前）
//   node scripts/probe-865-stopgate-comparison.mjs /tmp/base-865   # ← 改动前
//   node scripts/probe-865-stopgate-comparison.mjs                 # ← 改动后（HEAD）
// 脚本按**入参那棵树**动态 import `test/helpers/*` 与 `src/*`，所以同一份脚本在两棵树上
// 各自量的是那棵树的行为（脚本自身不参与判定）。
//
// ⚠ fake judge 恒判 `done:true / 0.85`（> `JUDGE_DONE_CONFIDENCE_THRESHOLD` 0.7），也就是
// 「评审认为做完了」——这是本单判据的形状：停门**不该**再被一段标记正文撑起来。
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? ".");
const RUNS = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 5);

const LEAK_TEXT = "Tests: 3824 total, 0 failing. Final round — checks 5 & 6.\n"
  + "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"exec\">\n"
  + "<｜｜DSML｜｜ parameter name=\"command\">npm test -- --filter judge</｜｜DSML｜｜>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
const DELIVERABLE_TEXT = "已完成：给 judge_done 的停门补上「正文是不是交付物」这一格；"
  + "改动集中在 src/reflection/judge.js，全套测试绿（3824 tests / 0 fail）。";

const TOOL_ROUND = {
  content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "npm test" } }],
  stopReason: "tool_use",
};
const asText = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
const JUDGE_DONE = {
  done: true,
  confidence: 0.85,
  reason: "任务已完成",
  evidence: "模型说已经做完",
  direction: "on_track",
  directionReason: "看起来在推进",
};
const MAX_ROUNDS = 6;

/** 三组场景：`script()` 给 fake provider 的逐步脚本，`leakRounds` 是「哪几轮的正文是泄漏」
 *  （本夹具里一轮恰好一发 provider 请求，脚本里有断言钉住这条映射）。 */
const SCENARIOS = [
  {
    name: "leak_only",
    script: () => [TOOL_ROUND, { ...asText(LEAK_TEXT), times: MAX_ROUNDS }],
    leakRounds: (rounds) => Array.from({ length: rounds }, (_, i) => i + 1).filter((r) => r >= 2),
  },
  {
    name: "normal_delivery",
    script: () => [TOOL_ROUND, { ...asText(DELIVERABLE_TEXT), times: MAX_ROUNDS }],
    leakRounds: () => [],
  },
  {
    name: "leak_then_delivery",
    script: () => [
      TOOL_ROUND,
      asText(LEAK_TEXT),
      { ...asText(DELIVERABLE_TEXT), times: MAX_ROUNDS },
    ],
    leakRounds: () => [2],
  },
];

const { runDirect } = await import(pathToFileURL(resolve(ROOT, "test/helpers/run-direct.js")).href);
const { createFakeProvider } = await import(
  pathToFileURL(resolve(ROOT, "test/helpers/fake-provider.js")).href
);

async function runOnce(scenario) {
  const judgeRecords = [];
  const provider = createFakeProvider(scenario.script());
  const judge = createFakeProvider(Array.from({ length: MAX_ROUNDS }, () => ({
    content: [{ type: "text", text: JSON.stringify(JUDGE_DONE) }],
  })));
  const result = await runDirect({
    provider,
    runId: `probe-865-${scenario.name}`,
    initialUserMessage: "按判据交付任务",
    executeTool: async () => "ok",
    maxRounds: MAX_ROUNDS,
    config: { run: { completion: false, reflection: { enabled: true, roundJudge: true } } },
    capabilities: {
      ports: { judgeProvider: judge },
      hooks: { onJudge: (record) => judgeRecords.push(record) },
    },
  });
  // 一轮 = 一发 provider 请求（本夹具没有续写 / 强制收尾之外的额外调用），否则
  // `leakRounds`（按轮号定义）与 judge 事件的 `round` 就对不上。
  const mappingHonest = provider.requests.length === result.rounds;
  const leakRounds = scenario.leakRounds(result.rounds);
  const judgeDoneRounds = judgeRecords
    .filter((record) => record.action === "judge_done")
    .map((record) => record.round);
  return {
    reason: result.termination.reason,
    rounds: result.rounds,
    actions: judgeRecords.map((record) => `${record.round}:${record.action}`),
    // #862 修法 A 的键：命中 ⇒ 终稿那堆标记被引擎认出来了（两棵树都有这个键，可同尺对量）。
    finalIsTextualized: result.finalTextShape?.textualizedToolCall === true,
    judgeDoneOnLeakRound: judgeDoneRounds.filter((round) => leakRounds.includes(round)).length,
    mappingHonest,
  };
}

function summarize(runs) {
  const reasons = {};
  for (const run of runs) reasons[run.reason] = (reasons[run.reason] ?? 0) + 1;
  const mean = runs.reduce((sum, run) => sum + run.rounds, 0) / runs.length;
  return {
    runs: runs.length,
    judgeDoneRate: runs.filter((run) => run.reason === "judge_done").length / runs.length,
    meanRounds: Number(mean.toFixed(2)),
    roundsPerRun: runs.map((run) => run.rounds),
    terminationReasons: reasons,
    finalStillTextualized: runs.filter((run) => run.finalIsTextualized).length,
    judgeDoneOnLeakRound: runs.reduce((sum, run) => sum + run.judgeDoneOnLeakRound, 0),
    nudgeRounds: runs.flatMap((run) => run.actions)
      .filter((entry) => entry.endsWith(":nudge")).length,
    mappingHonest: runs.every((run) => run.mappingHonest),
  };
}

const table = {};
for (const scenario of SCENARIOS) {
  const runs = [];
  for (let index = 0; index < RUNS; index += 1) runs.push(await runOnce(scenario));
  table[scenario.name] = summarize(runs);
}
console.log(JSON.stringify({ tree: ROOT, runsPerScenario: RUNS, scenarios: table }, null, 1));
