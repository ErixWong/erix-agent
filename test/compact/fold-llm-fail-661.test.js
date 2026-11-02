// issue #661：摘要器失败是**终局错误**（不再「降级为统计摘要」）。
//
// 本文件是工单 §6 判据 1/2/3/4/5/6/8 的机器证据，全部零真实 LLM、零真实 `~/.erix`：
//   · 判据 1：必抛 summarizer + `strategy:"fold-llm"` ⇒ 抛错，`code === "summarizer_failed"`，
//     `details.kind` 是四类之一，`errorCode` 按 `terminationErrorCodeForError` 口径，且
//     `cause` **就是**摘要器抛出的那个原始错误（同一性断言——工单 §1 的 `cause` 此前无人钉）；
//   · 判据 2：同一 run 的 messages 里没有 `【上下文折叠·` 块，也没有 `[fold-llm 摘要失败` 字面量；
//   · 判据 3：「先失败后应用」四条（foldedFacts / compactionStats+事件 / 水位线 / 上一份摘要）；
//   · 判据 4：超窗缩输入重试**仍在**（首次超窗、二次成功 ⇒ 折叠成功且 `attempts` 有值）；
//   · 判据 5：`fold-statistical` 一次 LLM 都不调 ⇒ 喂「必抛 summarizer」也照样跑完；
//   · 判据 6：`resume` 能跑完——**且 resume 那一发摘要器已恢复**（否则同一故障二次判死，这条会假绿）；
//   · 判据 8：账单随异常走（异常上 `unpersisted` 非空）。
//
// 「反向锁」的口径：每条正向判据都配一条**能把它变红**的断言（没有替代物 / 没有请求 / 没有键），
// 而不是只断言「抛了错」。删掉重试、把失败改回返回替代物、把统计策略接上摘要器，都会在本文件里红。
import assert from "node:assert/strict";
import test from "node:test";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { FOLD_SUMMARY_MARKER } from "../../src/compact/fold-statistical.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";
const FOLD_BLOCK_MARKER = "【上下文折叠·";
/** 被 issue #661 删掉的那条降级前言：任何一次 run 的账本里都不许再出现。 */
const RETIRED_DEGRADE_PREFIX = "[fold-llm 摘要失败";
const SUMMARY = [
  "## 阶段", "完成初始化。",
  "## 已改文件", "src/example.js",
  "## 已验证项", "node --test",
  "## 下一步", "已完成项禁止重做；继续收尾。",
  "## 主题词面包屑", "example, tests",
].join("\n");

/**
 * 假 provider：主循环按脚本走；摘要请求由 system 提示词认出，行为可配。
 *
 * @param {{ toolTurns?: number, summaryThrows?: boolean, summaryText?: string }} [options]
 */
function makeProvider({ toolTurns = 3, summaryThrows = true, summaryText = SUMMARY } = {}) {
  let turns = 0;
  const mainRequests = [];
  const summaryRequests = [];
  // issue #661：失败异常上的 `cause` 必须是**摘要器抛出的那个对象本身**（同一性），所以夹具把那一份
  // 留住（挂在 `provider.summaryError` 上），供断言取引用——不按文案认，也不按 `instanceof` 认。
  const summaryError = new Error("summarizer exploded (661 fixture)");
  const provider = {
    protocol: "fake",
    model: "fake-model",
    mainRequests,
    summaryRequests,
    summaryError,
    async chat(request) {
      const isSummary = typeof request?.system === "string"
        && request.system.includes(SUMMARY_SYSTEM);
      if (isSummary) {
        summaryRequests.push(request);
        if (summaryThrows) throw summaryError;
        return {
          content: [{ type: "text", text: summaryText }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{
            type: "tool_use",
            id: `tu_${turns}`,
            name: "work",
            input: { path: `src/f${turns}.js` },
          }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      return {
        content: [{ type: "text", text: "收尾结论 661" }],
        stopReason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
  provider.chatStream = provider.chat;
  return provider;
}

/**
 * 一条会在第 2 轮触发 `fold-llm` 折叠的 run（`budgetTokens` 小 + `keepRounds: 0`）。
 *
 * `seedLedger` 为真时，工具那一步先报一条**非致命**的宿主持久化失败（#109 的 `notes` 端口形态），
 * 于是失败那一折抛出时 `errorLedger` 里已经有条目——判据 8 就是「那条账单跟着异常走」。
 */
async function runFoldLlm({
  runId,
  provider,
  store = createMemoryTranscriptStore(),
  budgetTokens = 300,
  strategy = "fold-llm",
  seedLedger = false,
  resume = false,
  events = [],
} = {}) {
  let seeded = false;
  const run = runDirect({
    provider,
    runId,
    store,
    seed: `开始任务 ${"y".repeat(400)}`,
    executeTool: async ({ id, context }) => {
      if (seedLedger && !seeded) {
        seeded = true;
        await context.reportPersistenceFailure({
          port: "notes",
          operation: "note_take",
          phase: "write",
          error: new Error("notes backend down (661 fixture)"),
        });
      }
      return `tool output for ${id} ${"z".repeat(400)}`;
    },
    config: {
      run: {
        maxRounds: 12,
        completion: false,
        ...(resume ? { resume: true } : {}),
      },
      input: { wrapup: false },
      folding: { context: { budgetTokens, keepRounds: 0, strategy } },
    },
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  return { run, store };
}

/** 把「必须抛」的一格收成一个值：失败返回错误对象，成功当场判红。 */
async function rejectionOf(promise, label) {
  return promise.then(
    () => assert.fail(`${label}：必须抛错（不许静默跑完、也不许返回降级替代物）`),
    (error) => error,
  );
}

// ── 判据 1 + 2 + 3 + 8：run 级 ─────────────────────────────────────────────────────────
test("#661-1/2/3/8 必抛 summarizer ⇒ summarizer_failed 终局，失败那一折什么都没应用", async () => {
  const provider = makeProvider({ summaryThrows: true });
  const events = [];
  const { run, store } = await runFoldLlm({
    runId: "661-run-level",
    provider,
    seedLedger: true,
    events,
  });
  const failure = await rejectionOf(run, "摘要器失败");

  // 判据 1：错误码 / 分类 / errorCode 三件。
  assert.equal(failure.code, "summarizer_failed");
  assert.ok(
    ["timeout", "context_window_exceeded", "empty_summary", "error"].includes(failure.details?.kind),
    `details.kind 必须是四类之一（实测 ${String(failure.details?.kind)}）`,
  );
  assert.equal(failure.details.kind, "error", "普通 reject 归 error（不是「不可用」这种自造词）");
  // 与 `makePersistenceFailure` 取值对称：`errorCode` 记根因自己的 code（这里是没有 code 的 Error）。
  assert.equal(failure.errorCode, "unknown");
  assert.equal(failure.retryable, false);
  // 工单 §1 的 `cause` 不是装饰：失败异常上的 `cause` 必须**就是**摘要器抛出的那个原始错误
  // （断同一性——文案相同的新 Error、被包装过的 Error 都过不了这一条）。
  assert.equal(failure.cause, provider.summaryError,
    `cause 必须是摘要器抛出的那个原始错误（实测 ${String(failure.cause?.message)}）`);
  assert.equal(failure.termination?.reason, "failed");
  assert.equal(failure.termination?.errorCode, "summarizer_failed");

  // 判据 8：账单随异常走（异常路径不返回 result，`unpersisted` 只能挂在异常上）。
  assert.ok(Array.isArray(failure.unpersisted) && failure.unpersisted.length > 0,
    `异常上必须带未持久化账单（实测 ${JSON.stringify(failure.unpersisted)}）`);
  assert.ok(failure.unpersisted.some((entry) => entry.port === "notes"),
    "账单里必须能看到那条 notes 端口的失败");

  // 判据 2：同一 run 的 messages 里没有折叠块，也没有被删掉的降级前言。
  const records = await store.load("661-run-level");
  const whole = JSON.stringify(records);
  assert.ok(records.length > 0, "前提：这条 run 真的落了轮记录");
  assert.ok(provider.summaryRequests.length > 0, "前提：摘要器真的被调过（否则测的是别的东西）");
  assert.equal(whole.includes(FOLD_BLOCK_MARKER), false, "失败的 run 里不许出现折叠块");
  assert.equal(whole.includes(RETIRED_DEGRADE_PREFIX), false, "被删掉的降级前言不许再出现");
  assert.equal(whole.includes(FOLD_SUMMARY_MARKER), false, "统计摘要也不许补位");

  // 判据 3-①：一个 `foldedFacts` 键都不许出现。
  assert.deepEqual(
    records.map((record) => record.foldedFacts).filter((fact) => fact !== undefined),
    [],
    "失败那一折不许留下 foldedFacts",
  );
  // 判据 3-②：`compactionStats` 里那一条与 `type:"compaction"` 事件都不许出现。
  assert.deepEqual(events.filter((event) => event?.type === "compaction"), []);
  const runState = await store.loadRunState("661-run-level");
  assert.deepEqual(runState?.deterministic?.compactionStats ?? [], []);
  // 判据 3-③：折叠水位线没动（resume 从轮记录推导 `foldedThrough`，这里没有可推导的区间）。
  assert.deepEqual(
    records.map((record) => record.foldedRoundRange).filter((range) => range !== undefined),
    [],
    "水位线不许被失败的这一折推走（否则 resume 会重放/漏放轮次）",
  );
  assert.equal(runState?.deterministic?.fold?.foldedRounds ?? 0, 0);
});

// ── 判据 3-④ + 判据 4：策略级 ─────────────────────────────────────────────────────────
const strategyConversation = () => [
  { role: "user", content: "task" },
  { role: "assistant", content: [{ type: "text", text: "phase one" }] },
  { role: "user", content: "continue" },
  { role: "assistant", content: [{ type: "text", text: "phase two" }] },
  { role: "user", content: "continue again" },
  { role: "assistant", content: [{ type: "text", text: "phase three" }] },
];

test("#661-3④ 失败那一折不给下一次折叠留「上一份摘要」残值", async () => {
  const seen = [];
  let failing = true;
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      if (failing) throw new Error("first fold explodes");
      return SUMMARY;
    },
  });
  const failure = await rejectionOf(
    strategy.compact(strategyConversation(), { keepRounds: 1 }),
    "第一折（摘要器必抛）",
  );
  assert.equal(failure.code, "summarizer_failed");

  failing = false;
  const second = await strategy.compact(strategyConversation(), { keepRounds: 1 });
  assert.equal(seen.length, 2);
  // 反向锁：若把 `lastFoldSummaryText` 挪进 finally（无条件执行），这一条会立刻红——
  // 第二次折叠会拿到一段并不存在于上下文里的「上一份摘要」。
  assert.equal(seen[1].priorSummary, undefined, "失败那一折的正文不许成为下一次折叠的续写基底");
  assert.equal(second.foldSummary.priorSummaryBytes, undefined, "也不许在账上写 priorSummary* 残值");
  assert.equal(second.foldSummary.source, "llm");
  assert.equal(second.compacted, true);
});

test("#661-4 超窗重试仍在：首次超窗、二次成功 ⇒ 折叠成功且 attempts 有值", async () => {
  const seen = [];
  const strategy = createFoldLlmStrategy({
    summarizer: async (input) => {
      seen.push(input);
      if (seen.length === 1) {
        throw new Error(
          "400 message = input length `16584` is longer than configured context length `16384`.",
        );
      }
      return SUMMARY;
    },
  });
  const result = await strategy.compact(
    [
      { role: "user", content: "alpha ".repeat(2000) },
      { role: "assistant", content: [{ type: "text", text: "alpha ".repeat(2000) }] },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "phase two" }] },
      { role: "user", content: "keep" },
    ],
    { keepRounds: 1 },
  );

  assert.equal(seen.length, 2, "超窗必须**重试一次**（那不是降级，是让调用装得下）");
  assert.ok(
    JSON.stringify(seen[1].messages).length < JSON.stringify(seen[0].messages).length,
    "重试输入必须更短（拿「消息条数」当判据会假阳性：省略注占一个位置）",
  );
  assert.equal(result.compacted, true);
  assert.equal(result.foldSummary.source, "llm");
  assert.equal(result.foldSummary.attempts, 2, "`attempts` 必须如实记下「试了两次」");
  assert.equal(result.foldSummary.inputTruncated, true);
  // 反向锁：这条格子的红点是「重试被删」——删掉重试后第一次失败即抛，本格当场红。
  assert.ok(result.foldSummary.droppedMessages > 0, "被裁掉的消息数要入账");
});

// ── 判据 5：fold-statistical 一次 LLM 都不调 ──────────────────────────────────────────
test("#661-5 fold-statistical 零 LLM：喂「必抛 summarizer」也照样跑完", async () => {
  const provider = makeProvider({ summaryThrows: true });
  const events = [];
  const { run, store } = await runFoldLlm({
    runId: "661-statistical",
    provider,
    strategy: "fold-statistical",
    events,
  });
  const result = await run;

  assert.equal(result.termination.reason, "end_turn", "统计策略不许被摘要器故障牵连");
  assert.equal(result.finalText, "收尾结论 661");
  // 反向锁：这条格子的红点是「统计策略也去调摘要器」——那时 `summaryRequests` 会非空，
  // 且 run 会以 summarizer_failed 收场（本格两条断言同时红）。
  assert.equal(provider.summaryRequests.length, 0, "fold-statistical 是零 LLM 路径");
  const records = await store.load("661-statistical");
  assert.ok(records.some((record) => record.foldedFacts !== undefined),
    "前提：统计策略真的折叠过（否则「零 LLM」是空断言）");
  assert.ok(events.some((event) => event.type === "compaction"), "统计策略的折叠统计照常入账");
});

// ── 判据 6：resume 能跑完，且 resume 那一发摘要器已恢复 ────────────────────────────────
test("#661-6 resume：失败后换一个健康的摘要器续跑，run 能跑完（摘要在 resume 时已恢复）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "661-resume";

  // 第一程：摘要器必抛 ⇒ 终局错误，账本里只剩已完成的轮次（没有折叠事实）。
  const broken = makeProvider({ summaryThrows: true });
  const first = await rejectionOf(
    runFoldLlm({ runId, provider: broken, store }).then(({ run }) => run),
    "第一程（摘要器必抛）",
  );
  assert.equal(first.code, "summarizer_failed");
  const afterCrash = await store.load(runId);
  assert.ok(afterCrash.length > 0, "前提：第一程落了可续跑的账本");
  assert.deepEqual(
    afterCrash.map((record) => record.foldedFacts).filter((fact) => fact !== undefined),
    [],
  );

  // 第二程：**同一个 runId**，摘要器已恢复（这是本判据的关键前提——若故障仍在，
  // 同一折会二次判死，这条「resume 能跑完」就会退化成「同一故障又失败一次」的假绿）。
  const healthy = makeProvider({ summaryThrows: false });
  const resumed = await runFoldLlm({ runId, provider: healthy, store, resume: true }).then(
    ({ run }) => run,
  );
  assert.equal(healthy.summaryRequests.length > 0, true,
    "resume 那一发必须真的调过（恢复后的）摘要器，否则「能跑完」可能只是没折叠");
  assert.equal(resumed.termination.reason, "end_turn", `resume 必须能跑完（实测 ${resumed.termination.reason}）`);
  assert.equal(resumed.finalText, "收尾结论 661");
  const afterResume = await store.load(runId);
  assert.ok(afterResume.length > afterCrash.length, "resume 必须接着写账本（不是从头再跑）");
  assert.ok(afterResume.some((record) => record.foldedFacts !== undefined),
    "恢复后的折叠必须真的落账（这是「摘要器已恢复」的行为证据）");
});
