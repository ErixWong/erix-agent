// issue #608 —— 工作集地板 + 预算不足显式劣化 + run-state 游标（`last=`）。
//
// 三条判据（全部离线：fake provider + 内存 store，零真实 LLM、零网络、零 `~/.erix`）：
//   1. **地板生效**：待折轮次里若含最近 `WORKING_SET_RECENT_ROUNDS` 轮的 `tool_result`，
//      **有更老的轮次可折时**这些轮次不进 `foldedPayload`（= 不被换成摘要/占位符）；
//      把地板去掉（`workingSetRecentRounds: 0`）⇒ 该格必须红。
//   2. **显式劣化**：连续 `WORKING_SET_LOOP_ATTEMPTS` 次「工作集 > 预算 且折完仍超预算 且模型在
//      重读同一入参」⇒ 终局 `budget_below_working_set` + 四个数（budgetTokens / workingSetTokens /
//      suggestedBudgetTokens / repeatStreak），且**不许**静默跑到 `max_rounds_cap`；
//      反向格：紧预算但每轮入参都不同（合法长跑）⇒ **不得**触发。
//   3. **游标可见**：`last=` 等于最近一次不同入参；同一入参重调不被静默吞掉（`×N` 可见）。
//
// 变异实验（见报告，不落盘）：
//   · 把 `selectFoldedRounds` 的 `index < floorIndex` 去掉 ⇒ 判据 1 红；
//   · 把 `compactBeforeRound` 里的劣化分支去掉 ⇒ 判据 2 红（跑到 `max_rounds_cap`）；
//   · 把 `advanceLastToolCall` 的 `streak` 恒置 1 ⇒ 判据 3 的 `×3` 那半句红。

import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKING_SET_LOOP_ATTEMPTS,
  WORKING_SET_RECENT_ROUNDS,
  selectFoldedRounds,
  suggestedBudgetTokens,
  workingSetRoundIndexes,
  workingSetTokens,
} from "../../src/compact/helpers.js";
import { renderContinuityBlock } from "../../src/loop/continuity-block.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { estimateMessageTokens, estimateTokens } from "../../src/tokens.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { runDirect } from "../helpers/run-direct.js";

// ── 夹具 ──────────────────────────────────────────────────────────────────────────────

const toolUse = (id, name, input) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

/** 一轮「assistant tool_use + user tool_result」（`groupIntoRounds` 的口径）。 */
const toolRound = (index, payload = `R${index}`) => ([
  toolUse(`tu_${index}`, "getParagraph", { index }),
  toolResult(`tu_${index}`, payload),
]);

/** 一段够大的段落正文（`tokens` 只是量级，判据里用 `estimateTokens` 现算，不写死）。 */
const paragraph = (index) => `PARA-${index} ` + "填充".repeat(180);

const paragraphToolStep = (index, { repeat = 1 } = {}) => ({
  content: Array.from({ length: repeat }, (_unused, offset) => ({
    type: "tool_use",
    id: `tu_${index}_${offset + 1}`,
    name: "getParagraph",
    input: { index },
  })),
  stopReason: "tool_use",
});

const endTurn = (text = "收尾") => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

/** 引擎级 run 的公共装配：工具只回显「第几段」，正文由 `paragraph` 造。 */
const runEngine = ({
  runId,
  provider,
  seed = "start",
  budgetTokens,
  keepRounds = 0,
  maxRounds,
  capabilities,
  executeTool = async ({ input }) => paragraph(input?.index ?? 0),
}) => runDirect({
  runId,
  provider,
  seed,
  store: createMemoryTranscriptStore(),
  executeTool,
  maxRounds,
  ...(capabilities === undefined ? {} : { capabilities }),
  config: {
    folding: { context: { budgetTokens, keepRounds } },
    run: { completion: false },
  },
});

// ── 判据 1：工作集地板（单元格）────────────────────────────────────────────────────────

test("#608-1a 有更老轮次可折时，最近 WORKING_SET_RECENT_ROUNDS 轮的 tool_result 不进被折集合", () => {
  const rounds = [
    { messages: toolRound(1) },
    { messages: toolRound(2) },
    { messages: toolRound(3) },
    { messages: toolRound(4) },
  ];
  const withFloor = selectFoldedRounds(rounds, 0, undefined, WORKING_SET_RECENT_ROUNDS);
  assert.deepEqual(withFloor.foldedIndexes, [0, 1], "只折最老的两轮（更老的轮次可折）");
  assert.deepEqual(
    withFloor.retained.map((round) => round.messages[0].content[0].input.index),
    [3, 4],
    "最近 2 轮（工作集）必须留在 retained 里",
  );

  // 变异格（地板去掉）：`workingSetRecentRounds: 0` ⇒ 全部折走 ⇒ 上面那条断言必红。
  const withoutFloor = selectFoldedRounds(rounds, 0, undefined, 0);
  assert.deepEqual(withoutFloor.foldedIndexes, [0, 1, 2, 3], "地板关掉时逐字回到旧行为（全折）");
});

test("#608-1b 进度保证：没有更老的轮次可折时照旧折最老那一轮（地板不许锁死折叠）", () => {
  const rounds = [{ messages: toolRound(1) }, { messages: toolRound(2) }];
  const result = selectFoldedRounds(rounds, 0, undefined, WORKING_SET_RECENT_ROUNDS);
  assert.deepEqual(result.foldedIndexes, [0], "地板挡住全部可折轮次 ⇒ 进度保证折最老的一轮");
  assert.equal(result.retained.length, 1, "不是「一次都不折」：另一轮留下");
  // 与 #589 的分工：连续性块所在轮不是「被地板挡住」，是**不可折** ⇒ 进度保证也不碰它。
  const blockText = renderContinuityBlock({
    sections: { contract: ["goal: #608"], unfinished: ["u1: 未完成"], evidence: ["verified: none"] },
    version: 1,
  }).text;
  const blockOnly = [{ messages: [{ role: "user", content: [{ type: "text", text: blockText }] }] }];
  assert.deepEqual(
    selectFoldedRounds(blockOnly, 0, undefined, WORKING_SET_RECENT_ROUNDS).foldedIndexes,
    [],
    "整轮只有引擎注入的续接块 ⇒ 进度保证也不许折（那是 #589 的红线）",
  );
});

test("#608-1c 工作集度量与建议预算：同一把估算尺子，1.5 倍向上取整到 1k", () => {
  const rounds = [{ messages: toolRound(1, paragraph(1)) }, { messages: toolRound(2, paragraph(2)) }];
  const measured = workingSetTokens(rounds);
  assert.equal(measured, estimateMessageTokens([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: paragraph(1) }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: paragraph(2) }] },
  ]), "工作集口径 = estimateMessageTokens（不另写字符→token 换算）");
  assert.deepEqual(workingSetRoundIndexes(rounds), [0, 1]);
  assert.deepEqual(workingSetRoundIndexes([{ messages: [toolUse("x", "getParagraph", {})] }]), [],
    "没有 tool_result 的轮次不进工作集");
  assert.equal(suggestedBudgetTokens(measured), Math.ceil((measured * 1.5) / 1000) * 1000);
  assert.equal(suggestedBudgetTokens(0), 0);
});

test("#608-1d 真引擎：批量取数 + 工作集 > 预算 ⇒ 有更老轮次可折时最近 2 轮的 tool_result 不被折走", async () => {
  // 形状：前两轮是**很小**的结果（让历史能攒到 4 轮），后两轮是**很大**的结果（工作集 > 预算）。
  // 这样折叠决策时才**真的有更老的轮次可折**——那是地板唯一的可观测面（否则进度保证会照旧折一轮）。
  const provider = createFakeProvider([
    ...Array.from({ length: 6 }, (_unused, index) => paragraphToolStep(index + 1)),
    endTurn(),
  ]);
  /** @type {{foldedPayload: object[], messages: object[]}[]} */
  const folds = [];
  await runEngine({
    runId: "s608-floor",
    provider,
    budgetTokens: 1000,
    keepRounds: 0,
    maxRounds: 9,
    executeTool: async ({ input }) => (
      input.index <= 2 ? `tiny-${input.index}` : paragraph(input.index)
    ),
    capabilities: {
      hooks: {
        onBeforeFold: (payload) => {
          folds.push({ foldedPayload: payload.foldedPayload ?? [], messages: payload.messages ?? [] });
        },
      },
    },
  });

  const attempts = folds.map((entry) => ({
    foldedPayload: entry.foldedPayload,
    results: entry.messages
      .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
      .filter((block) => block?.type === "tool_result")
      .map((block) => String(block.content)),
  }));
  const withOlderRounds = attempts.filter(
    (entry) => entry.foldedPayload.length > 0 && entry.results.length > WORKING_SET_RECENT_ROUNDS,
  );
  assert.ok(withOlderRounds.length >= 1,
    `前提不成立：没有任何一次「有更老轮次可折」的折叠尝试（实测 ${JSON.stringify(
      attempts.map((entry) => ({ results: entry.results.length, folded: entry.foldedPayload.length })),
    )}）`);
  for (const entry of withOlderRounds) {
    const workingSet = entry.results.slice(-WORKING_SET_RECENT_ROUNDS);
    const foldedJson = JSON.stringify(entry.foldedPayload);
    for (const text of workingSet) {
      assert.equal(foldedJson.includes(text), false,
        `工作集里的 tool_result 被折走了（换成摘要 = 模型必须重读）：${text.slice(0, 40)}…`);
    }
    // 反向半句：更老的轮次**必须**被折（否则「没折」也能让上面那半句变绿 = 空断言）。
    assert.equal(foldedJson.includes(entry.results[0]), true, "更老的轮次必须真的被折走");
  }
});

// ── 判据 2：显式劣化（循环检测）──────────────────────────────────────────────────────

test("#608-2a 重读同一入参 + 折不动 ⇒ budget_below_working_set + 四个数（不许撞 max_rounds_cap）", async () => {
  const READS = 12;
  const provider = createFakeProvider([
    ...Array.from({ length: READS }, () => paragraphToolStep(7)),
    endTurn(),
    { ...endTurn("强制收尾"), times: 3 },
  ]);
  const events = [];
  // 预算压在「种子 + 一条工具结果」之下：折掉一切可折的东西仍然装不下（= #607 的「物理上不可能」）。
  // 预算压到**单条工具结果之下**（工作集必然 > 预算），同时让「折完仍超预算」至少能成立一次。
  const seed = "任务：" + "要求".repeat(40);
  const oneResult = estimateTokens(paragraph(7));
  assert.ok(oneResult > 500, `前提：单条工具结果必须够大（实测 ${oneResult}）`);
  const budgetTokens = 500;
  const result = await runEngine({
    runId: "s608-degrade",
    provider,
    seed,
    budgetTokens,
    maxRounds: READS + 2,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  const degrade = events.filter((event) => event.type === "budget_below_working_set");
  assert.equal(degrade.length, 1, `必须恰好一条显式劣化事件（实测 ${degrade.length}）`);
  const [event] = degrade;
  assert.equal(event.budgetTokens, budgetTokens);
  assert.ok(Number.isSafeInteger(event.workingSetTokens) && event.workingSetTokens > budgetTokens,
    `工作集必须真的超过预算（实测 ${event.workingSetTokens} vs ${budgetTokens}）`);
  assert.equal(event.suggestedBudgetTokens, Math.ceil((event.workingSetTokens * 1.5) / 1000) * 1000);
  assert.ok(event.repeatStreak >= 2, `诊断必须能审计「当时靠哪条证据掐的」（repeatStreak=${event.repeatStreak}）`);
  assert.equal(event.attempts, WORKING_SET_LOOP_ATTEMPTS);

  assert.equal(result.termination.reason, "budget_below_working_set",
    `不许静默跑到 max_rounds_cap（实测 ${result.termination.reason}）`);
  const detail = String(result.termination.detail ?? "");
  for (const key of ["budgetTokens=", "workingSetTokens=", "suggestedBudgetTokens=", "repeatStreak="]) {
    assert.ok(detail.includes(key), `终局 detail 必须带 ${key}（实测 ${detail}）`);
  }
  assert.equal(detail.includes(`budgetTokens=${budgetTokens}`), true);
  assert.equal(result.verification.status === "verified", false,
    "显式劣化不是「验收通过」：verification 绝不许变成 verified");
});

test("#608-2b 反向格：紧预算但每轮入参都不同（合法长跑）⇒ 不得触发劣化", async () => {
  const ROUNDS = 10;
  const provider = createFakeProvider([
    ...Array.from({ length: ROUNDS }, (_unused, index) => paragraphToolStep(index + 1)),
    endTurn(),
    { ...endTurn("强制收尾"), times: 3 },
  ]);
  const events = [];
  const result = await runEngine({
    runId: "s608-progress",
    provider,
    seed: "任务：" + "要求".repeat(40),
    budgetTokens: estimateTokens(paragraph(1)) + 40,
    keepRounds: 0,
    maxRounds: ROUNDS + 2,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });

  assert.equal(events.filter((event) => event.type === "budget_below_working_set").length, 0,
    "每轮都是新入参（模型在推进）⇒ 循环判据不该成立");
  assert.notEqual(result.termination.reason, "budget_below_working_set",
    `合法紧预算长跑不许被掐（实测 ${result.termination.reason}）`);
  const folds = result.compactionStats.filter((stat) => stat.compacted);
  assert.ok(folds.length >= 8, `前提：这条长跑必须真的折过 ≥8 次（实测 ${folds.length}）`);
});

// ── 判据 3：run-state 游标（`last=`）─────────────────────────────────────────────────

test("#608-3a 游标 = 最近一次不同入参；同入参重调不被静默吞掉（×N 可见）", async () => {
  const provider = createFakeProvider([
    paragraphToolStep(1),
    paragraphToolStep(2),
    paragraphToolStep(2),
    paragraphToolStep(2),
    endTurn(),
  ]);
  const result = await runEngine({ runId: "s608-cursor", provider, maxRounds: 8 });

  assert.deepEqual(result.runState.deterministic.lastToolCall, {
    summary: 'getParagraph {"index":2}',
    streak: 3,
  }, "最近一次**不同**入参 = index 2，且它被连续调了 3 次");
  const rendered = String(result.runState.rendered);
  assert.match(rendered, /^tools=.* files=.* last=getParagraph \{"index":2\}×3$/mu,
    `run-state 必须出现 last= 一格且带去重证据（实测：${rendered}）`);
});

test("#608-3b 换了入参 ⇒ last= 跟着换、连击归 1（不印 ×1）", async () => {
  const provider = createFakeProvider([
    paragraphToolStep(1),
    paragraphToolStep(1),
    paragraphToolStep(3),
    endTurn(),
  ]);
  const result = await runEngine({ runId: "s608-cursor-2", provider, maxRounds: 8 });
  assert.deepEqual(result.runState.deterministic.lastToolCall, {
    // `streak === 1` 不落盘（省体积）：缺席即「没有连击」。
    summary: 'getParagraph {"index":3}',
  });
  const rendered = String(result.runState.rendered);
  assert.match(rendered, /last=getParagraph \{"index":3\}(?!×)/u, "换入参后没有连击后缀");
  assert.equal(rendered.includes('last=getParagraph {"index":1}'), false, "旧入参不许留在 last=");
});

test("#608-3c 没调过工具的 run ⇒ 整格缺席（旧档 / 纯文本 run 渲染逐字不变）", async () => {
  const provider = createFakeProvider([endTurn("直接答")]);
  const result = await runEngine({ runId: "s608-cursor-none", provider, maxRounds: 4 });
  assert.equal(result.runState.deterministic.lastToolCall, undefined);
  assert.equal(String(result.runState.rendered).includes("last="), false);
});
