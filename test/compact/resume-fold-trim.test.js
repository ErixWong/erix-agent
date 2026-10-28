// issue #462：折叠水位线的**读侧** —— resume 必须按 `foldedThrough` 裁正文，并把模型见过的
// 那份摘要回填到原位置。四条判据来自工单 §3：
//   1 续跑不再从 round 1 重折（摘要器不重算 ⇒ 那条 O(n) 的输入不再随会话增长）；
//   2 跨 run 一致：被折区间在续跑上下文里**只出现一次**（不多不少）；
//   3 相互作用回归：区间被误判成未折时，正文必须**可见**，不许档案与上下文两边都静默；
//   4 可对账：模型见过的那份摘要在档案里有唯一可定位去处（`record.foldedSummary` 事实行）。
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  deriveFoldSummaryText,
  injectFoldSummaryIntoHead,
  pickCoveringFoldSummary,
  planFoldedHistoryTrim,
} from "../../src/compact/resume-fold-trim.js";
import { createFakeProvider } from "../helpers/fake-provider.js";

const big = (n) => "x".repeat(n);
const toolStep = (n) => ({
  content: [{ type: "tool_use", id: `call-${String(n)}`, name: "work", input: { step: n } }],
  stopReason: "tool_use",
});
const endStep = (text) => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === "text")
  .map((block) => String(block?.text ?? ""))
  .join("\n\n");
const countTextIn = (messages, needle) => messages.reduce(
  (sum, message) => sum + textOf(message).split(needle).length - 1,
  0,
);

/** 一个宿主自带的 `fold-llm` 策略：数摘要调用，并记录每次折叠喂进去的消息数与折走区间。 */
function makeHostFoldLlm() {
  const summaryCalls = [];
  const folds = [];
  const inner = createFoldLlmStrategy({
    summarizer: async ({ messages, roundRange }) => {
      summaryCalls.push({
        bytes: JSON.stringify(messages).length,
        msgs: messages.length,
        from: roundRange?.from ?? null,
        to: roundRange?.to ?? null,
      });
      return `SUMMARY_HOST_${String(summaryCalls.length)}`;
    },
  });
  return {
    summaryCalls,
    folds,
    strategy: {
      name: inner.name,
      shouldCompact: (messages, budgetTokens) => inner.shouldCompact(messages, budgetTokens),
      async compact(messages, options) {
        const result = await inner.compact(messages, options);
        // 判据用「有没有折走区间」，不用 `foldedRounds`：`fold-llm` 的返回值里带的是
        // `foldedRoundRange`，`foldedRounds` 是 `fold-statistical` 那侧的键。
        if (result?.foldedRoundRange !== undefined || (result?.foldedRounds ?? 0) > 0) {
          folds.push({ msgsIn: messages.length, range: result?.foldedRoundRange ?? null });
        }
        return result;
      },
    },
  };
}

// 每轮工具输出 20 000 字符 ≈ 5 000 tokens，预算 20 000、留 2 轮 ⇒ 第 5 轮圈顶就折一次
// （必须让**配置的策略**真的折，而不是让 `keepRounds: 0` 的预算兜底折：兜底那条没有摘要器，
// 落不出 `foldedSummary` 事实，读侧按边界①就不该动）。
const BUDGET_TOKENS = 4000;
const KEEP_ROUNDS = 1;
const TOOL_BYTES = 4000;

function loopOptions({ runId, store, strategy, steps, resume = false, budgetTokens = BUDGET_TOKENS }) {
  return { capabilities: { ports: { strategy: strategy } },
    provider: createFakeProvider(steps),
    initialUserMessage: `start ${big(2000)}`,
    executeTool: async ({ input }) => `MARK-r${String(input.step)} ${big(TOOL_BYTES)}`,
    completion: false,
    cacheStablePrefix: false,
    config: { folding: { context: { budgetTokens, keepRounds: KEEP_ROUNDS } } },
    store,
    runId,
    maxRounds: 10,
    ...(resume ? { resume: true } : {}),
  };
}

// ---- 纯函数：规划器的四格 ----

test("#462 规划器：没有水位线 ⇒ 一条都不裁", () => {
  const entries = [
    { message: { role: "user", content: [{ type: "text", text: "任务" }] }, round: 0 },
    { message: { role: "assistant", content: [{ type: "text", text: "r1" }] }, round: 1 },
  ];
  const plan = planFoldedHistoryTrim({ ledgerEntries: entries, records: [], foldedThrough: 0 });
  assert.equal(plan.applied, false);
  assert.equal(plan.reason, "no-watermark");
  assert.equal(plan.messages.length, 2);
});

test("#462 判据 3：有水位线但挑不出覆盖它的摘要 ⇒ 正文保持可见（不许两边静默）", () => {
  const entries = [
    { message: { role: "user", content: [{ type: "text", text: "任务" }] }, round: 0 },
    { message: { role: "assistant", content: [{ type: "text", text: "MARK-r1" }] }, round: 1 },
  ];
  // 只有一条覆盖到 round 1 的**都没有**的摘要事实（区间 to=1 < 水位线 2）
  const records = [{ foldedSummary: { text: "旧摘要", foldedRoundRange: { from: 1, to: 1 } } }];
  const plan = planFoldedHistoryTrim({ ledgerEntries: entries, records, foldedThrough: 2 });
  assert.equal(plan.applied, false);
  assert.equal(plan.reason, "no-covering-summary");
  assert.deepEqual(plan.messages, entries, "整段原样保留：被误判成未折的区间必须还在上下文里");
});

test("#462 规划器：裁掉水位线以下的轮，head 与水位线之后的原样留", () => {
  const entries = [
    { message: { role: "user", content: [{ type: "text", text: "任务正文" }] }, round: 0 },
    { message: { role: "assistant", content: [{ type: "text", text: "MARK-r1" }] }, round: 1 },
    { message: { role: "assistant", content: [{ type: "text", text: "MARK-r2" }] }, round: 2 },
    { message: { role: "assistant", content: [{ type: "text", text: "MARK-r3" }] }, round: 3 },
  ];
  const records = [{
    foldedSummary: {
      text: "任务正文",
      summary: "已折到 round 2 的摘要",
      foldedRoundRange: { from: 1, to: 2 },
    },
  }];
  const plan = planFoldedHistoryTrim({ ledgerEntries: entries, records, foldedThrough: 2 });
  assert.equal(plan.applied, true);
  assert.equal(plan.summaryText, "已折到 round 2 的摘要", "优先用引擎留下的纯摘要");
  assert.deepEqual(plan.messages.map((entry) => entry.round), [0, 3]);
  assert.deepEqual(plan.dropped.map((entry) => entry.round), [1, 2]);
  assert.equal(plan.droppedRounds, 2);
});

test("#462 摘要还原：没有纯摘要时从事实 text 里剥掉仍在上下文里的那份任务正文", () => {
  assert.equal(
    deriveFoldSummaryText(
      { text: "SUMMARY_HOST_1\n\nstart 任务正文" },
      ["start 任务正文"],
    ),
    "SUMMARY_HOST_1",
  );
  // 剥不掉（宿主自己的摘要口径与账本正文对不上）⇒ 整段回填，宁可多喂一份任务正文
  assert.equal(
    deriveFoldSummaryText({ text: "SUMMARY_HOST_1\n\n另一份正文" }, ["start 任务正文"]),
    "SUMMARY_HOST_1\n\n另一份正文",
  );
  assert.equal(pickCoveringFoldSummary([], 1), undefined);
});

test("#462 注入形状：并进最后一条真实 user 消息，不新造消息、不改角色交替", () => {
  const messages = [
    { role: "system", content: [{ type: "text", text: "系统" }] },
    { role: "user", content: [{ type: "text", text: "任务正文" }] },
    { role: "assistant", content: [{ type: "text", text: "r3" }] },
  ];
  const next = injectFoldSummaryIntoHead(messages, "摘要在此");
  assert.equal(next.length, 3, "不新增消息");
  assert.equal(next[1].role, "user");
  assert.equal(textOf(next[1]).startsWith("摘要在此"), true);
  assert.match(textOf(next[1]), /任务正文/u, "原任务正文还在");
  // head 里没有真实 user 消息 ⇒ 退化成 system 之后一条独立 user 消息
  const noUser = [{ role: "system", content: [{ type: "text", text: "系统" }] }];
  const injected = injectFoldSummaryIntoHead(noUser, "摘要在此");
  assert.deepEqual(injected.map((message) => message.role), ["system", "user"]);
});

test("#462 注入位置：尾部有宿主追问（同为 user+纯 text）时，摘要仍并到 head 那条而不是追问", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "任务正文" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "work", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
    { role: "user", content: [{ type: "text", text: "宿主追问：现在怎么样了" }] },
  ];
  const next = injectFoldSummaryIntoHead(messages, "摘要在此");
  assert.equal(next.length, 4, "不新增消息");
  assert.match(textOf(next[0]), /^摘要在此/u, "摘要必须在 head 那条任务消息上（上下文最前）");
  assert.equal(textOf(next[0]).includes("任务正文"), true);
  assert.equal(textOf(next[3]), "宿主追问：现在怎么样了",
    "尾部追问不得被当成摘要载体（否则摘要会掉到所有 tool_result 之后）");
});

// ---- 端到端：崩溃 + resume ----

test("#462 判据 1/2/4：续跑不从 round 1 重折，被折正文一次都不出现，摘要在档案里有唯一去处", async () => {
  const store = createMemoryTranscriptStore();
  const first = makeHostFoldLlm();
  const crashSteps = [];
  for (let step = 1; step <= 6; step += 1) crashSteps.push(toolStep(step));
  crashSteps.push({ throw: new Error("boom: 崩溃在崩溃轮的模型调用") });
  await assert.rejects(() => runToolLoop(loopOptions({
    runId: "462-refold", store, strategy: first.strategy, steps: crashSteps,
  })), /boom/u);

  const recordsAfterCrash = await store.load("462-refold");
  const facts = recordsAfterCrash.filter((record) => typeof record?.foldedSummary?.text === "string");
  assert.ok(first.folds.length >= 1, "前置：崩溃前必须由**配置的策略**折过一次（不是预算兜底）");
  assert.equal(first.summaryCalls.length, first.folds.length, "前置：每次折叠调一次摘要器");
  assert.equal(facts.length, first.summaryCalls.length,
    "判据 4：模型见过的每份摘要在档案里恰有一条（不重复落账）");
  const watermark = Math.max(0, ...recordsAfterCrash.map((r) => r.foldedRoundRange?.to ?? 0));
  assert.ok(watermark >= 1, `前置：水位线必须已推进（实测 ${String(watermark)}）`);
  assert.ok(facts.some((record) => (record.foldedSummary?.foldedRoundRange?.to ?? 0) >= watermark),
    "必须有一条摘要事实覆盖到水位线（它就是续跑要回填的那份）");

  // 续跑沿用同一个策略闭包，于是第一段的计数搬到新的记录器里，下面只判**新增**部分
  const resumed = makeHostFoldLlm();
  const callsBeforeResume = first.summaryCalls.length;
  const foldsBeforeResume = first.folds.length;
  resumed.summaryCalls.push(...first.summaryCalls);
  resumed.folds.push(...first.folds);
  const resumeSteps = [toolStep(7), toolStep(8), toolStep(9), endStep("done")];
  // 判据 2 要量的是**续跑那一刻**的上下文 ⇒ 直接把 provider 拿到手，读续跑的第一个请求
  // （后面几轮还会继续折，拿最终 `result.messages` 问会问成别的形状）。
  const resumedProvider = createFakeProvider(resumeSteps);
  const resumedResult = await runToolLoop({
    ...loopOptions({
      runId: "462-refold", store, strategy: resumed.strategy, steps: resumeSteps, resume: true,
    }),
    provider: resumedProvider,
  });
  assert.equal(resumedResult.finalText, "done");

  // 判据 1：续跑不再从 round 1 重折 —— 新增折叠的区间必须**整段**在水位线之后
  const newFolds = resumed.folds.slice(foldsBeforeResume);
  for (const fold of newFolds) {
    assert.ok(
      (fold.range?.from ?? Number.POSITIVE_INFINITY) > watermark,
      `续跑不许把已折区间重折一遍（实测区间 ${JSON.stringify(fold.range)}，水位线 ${String(watermark)}）`,
    );
  }
  // 判据 1（钱）：摘要器一次都不许多调 —— 那条 O(n) 的摘要输入整段省掉
  const ledgerMessages = recordsAfterCrash.flatMap((record) => record.messages ?? []);
  const newSummaryCalls = resumed.summaryCalls.slice(callsBeforeResume);
  for (const call of newSummaryCalls) {
    assert.ok(
      (call.from ?? Number.POSITIVE_INFINITY) > watermark,
      `续跑的摘要不得覆盖已折区间（实测 ${String(call.from)}→${String(call.to)}，水位线 ${String(watermark)}）`,
    );
    assert.ok(
      call.msgs < ledgerMessages.length,
      `续跑摘要的输入必须是裁过的（实测 ${String(call.msgs)} 条 vs 账本 ${String(ledgerMessages.length)} 条）`,
    );
  }
  // 判据 1（形状）：续跑折叠吃进去的消息数必须**少于**整段账本（= 读侧确实裁了）
  if (newFolds.length > 0) {
    assert.ok(
      newFolds[0].msgsIn < ledgerMessages.length,
      `续跑折叠的输入必须是裁过的（实测 ${String(newFolds[0].msgsIn)} 条 vs 账本 ${String(ledgerMessages.length)} 条）`,
    );
  }

  // 判据 2：被折区间在续跑上下文里**一次都不出现**；还留下的正文**不多不少各一次**。
  // 逐个标记数，而不是钉某一条具体轮次：续跑那一轮圈顶可能又合法地折走几轮（区间必须在水位线
  // 之后，上面已钉），钉死某一轮会把「合法的新折叠」误判成回归。
  const contextMessages = resumedProvider.requests[0].messages;
  const seen = new Map();
  for (const message of contextMessages) {
    for (const match of textOf(message).matchAll(/MARK-r(\d+)/gu)) {
      seen.set(match[1], (seen.get(match[1]) ?? 0) + 1);
    }
  }
  assert.equal(countTextIn(contextMessages, "MARK-r1"), 0, "已折到摘要里的正文不得再被喂给模型");
  for (const [round, count] of seen) {
    assert.equal(count, 1, `正文 MARK-r${round} 出现 ${count} 次，要求不多不少各一次`);
    assert.ok(Number(round) > watermark,
      `水位线（${watermark}）以下的正文不得出现在续跑上下文里（实测 MARK-r${round}）`);
  }
  // 「没裁过头」这一侧不在这里钉：续跑那一轮圈顶**可以**合法地把水位线之后的轮再折一次
  // （`keepRounds` 小、预算小就会），真正的「不许裁到水位线以下」由上面两条区间判据钉住
  // （新增折叠的 `from` 与新增摘要的 `from` 都必须 > 水位线）。
  assert.ok(countTextIn(contextMessages, "SUMMARY_HOST_") >= 1,
    "模型见过的那份摘要必须在续跑上下文里（不是只躺在档案里）");
});

test("#462 回归：没折过的会话，resume 上下文与账本一致（裁切除外）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "462-nofold";
  const steps = [toolStep(1), endStep("phase one")];
  await runToolLoop(loopOptions({
    runId, store, strategy: makeHostFoldLlm().strategy, steps, budgetTokens: 200_000,
  }));
  const records = await store.load(runId);
  const resumedSteps = [endStep("phase two")];
  const resumed = await runToolLoop(loopOptions({
    runId, store, strategy: makeHostFoldLlm().strategy, steps: resumedSteps,
    resume: true, budgetTokens: 200_000,
  }));
  assert.equal(resumed.finalText, "phase two");
  assert.equal(Math.max(0, ...records.map((r) => r.foldedRoundRange?.to ?? 0)), 0,
    "前置：这轮没有折叠 ⇒ 水位线为 0，切除必须完全不介入");
  assert.equal(resumed.messages.length >= records.flatMap((r) => r.messages ?? []).length, true);
});
