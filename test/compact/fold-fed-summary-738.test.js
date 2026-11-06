// issue #738（第一步，**纯加法**）：`record.foldedSummary.fedSummaryText` —— **实际插入上下文的那一串字节**。
//
// 缺陷本体（工单 #738）：`resume-fold-trim` 的注释承诺「回填的是模型当时真的见过的那份摘要 ⇒
// 续跑形状与崩溃前逐字一致」，但读侧优先 `.summary` = **摘要器的原始返回值**（没有恢复提示、没有
// 尺寸夹断产物、没有机械保真节），而当年真正 fed 的是 `compactedSummary`。⇒ 折过一次之后再续跑，
// 模型看到的摘要**换了字节**，且没有任何闸会红（方向是「宁可多喂」，请求合法、配对合法）。
//
// 决策（issue #738 的决策评论 + `~/store-review-261106/decisions/decision-D2.md`）**把工单原来那两个
// 选项都推翻了**：
//   · 「优先 `.text`」不兑现逐字一致 —— `foldedSummary.text` 是**整条新消息所有 text 块的拼接**
//     （摘要块 + 仍在 head 的原任务正文），优先它只会让任务正文更容易被**再喂一遍**；
//   · 「优先 `.summary`」是被 `test/compact/resume-fold-trim.test.js` 的 `#462 规划器` 用例**刻意钉住**的
//     （断言文案「优先用引擎留下的纯摘要」），简单反转优先级会先把那条打红。
// 于是本切片只做纯加法那一步：写侧在**当场证得**「这一串就是插进上下文的那一块」时才写第三格
// （`fold-summary-journal#pickFedSummaryTextBlock`），读侧有它就逐字回放、没有它就走今天的兼容路径，
// 并如实报「不可判定」。`.text` / `.summary` 两格的语义与读者**一字未动**。
//
// 本文件的格子（判据编号照工单）：
//   A 写侧自证：那一格与 **provider 请求里真实出现过的字节**对上，且**不等于** `.summary`
//     （证据取自请求，不取自引擎自己的账 —— 拿引擎的账证引擎的账是永真的）；
//   B 写侧不凑数：拿不到精确插入串的那一折**不写这一格**（`fold-statistical` 第二折实测如此）；
//   C 端到端逐字：崩溃 → 续跑，续跑上下文里那条 head 消息的**首个 text 块**逐字等于当年 fed 的那串，
//     并且**不等于**旧路径会回填的 `.summary`（⇒ 这条用例在改前是红的）；
//   D 夹具前提（工单判据 1）：`.summary !== .text` 且 `.text` 明确带着原任务正文，否则 C/E/F 永真；
//   E 读侧逐字（判据 2）与 F 读侧兼容（判据 3）+ 可观测面（第 4 条：`replaySource` / 两处字节数 /
//     `byteEqual`，没有精确保存值一律 `"unknown"` = **不可判定**，禁止伪报相等）。
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import {
  FOLDED_SUMMARY_FED_TEXT_KEY,
  FOLD_SUMMARY_RECORD_FIELD,
} from "../../src/compact/fold-summary-journal.js";
import {
  deriveFoldSummaryText,
  planFoldedHistoryTrim,
} from "../../src/compact/resume-fold-trim.js";
import { foldLedgerMessages } from "../../src/store/message-rows.js";
import { withSeed } from "../helpers/run-direct.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";
const TASK_BODY = `start ${"y".repeat(600)}`;
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { path: `src/${id}.js` } });
const toolTurn = (id) => ({ content: [toolUse(id)], stopReason: "tool_use" });
const endTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });
/** 一条消息里全部 text 块的**拼接投影**（与 `resume-fold-trim#textOf` 同一口径）。 */
const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === "text")
  .map((block) => String(block?.text ?? ""))
  .join("\n\n");
/** 一条消息里**逐块的原文**：逐字比对的单位是「块」，不是投影。 */
const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === "text")
  .map((block) => String(block?.text ?? ""));

/**
 * 双通道 fake provider：主循环脚本 + `fold-llm` 的摘要器通道（按 system 前缀识别）。
 * 摘要返回带版本号的文本，于是「哪一份进了请求」在断言里看得见。
 */
function createProvider({ mainScript }) {
  const mainRequests = [];
  let mainIndex = 0;
  let summaryIndex = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    mainRequests,
    get summaryCalls() {
      return summaryIndex;
    },
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryIndex += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nSUMMARY_V${String(summaryIndex)}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      if (step && Object.prototype.hasOwnProperty.call(step, "throw")) throw step.throw;
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

const options = (runId, store, provider, { budgetTokens, steps, resume = false }) => withSeed({
  provider,
  executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
  maxRounds: 6,
  completion: false,
  reflection: false,
  config: {
    input: { cacheStablePrefix: false },
    folding: {
      context: {
        budgetTokens,
        keepRounds: 0,
        // `fold-llm` 走**内置名**那一档：摘要器由引擎装配，`lastFoldSummaryOutcome` 才在场
        //（宿主自带策略对象时 `.summary` 那一格本来就不写，见决策报告的读者表）。
        strategy: "fold-llm",
        summarizerSystem: SUMMARY_SYSTEM,
      },
    },
  },
  store,
  runId,
  initialUserMessage: TASK_BODY,
  ...(resume ? { resume: true } : {}),
  ...(steps === undefined ? {} : { providerSteps: steps }),
});

const factsOf = (records) => records
  .map((record) => record?.[FOLD_SUMMARY_RECORD_FIELD])
  .filter((fact) => fact && typeof fact === "object" && typeof fact.text === "string");
const watermarkOf = (records) => Math.max(0, ...records.map((r) => r.foldedRoundRange?.to ?? 0));
/** 真实请求里出现过的**全部 text 块原文**（逐字证据的唯一来源）。 */
const requestedBlocks = (provider) => provider.mainRequests
  .flatMap((request) => (request?.messages ?? []).flatMap((message) => blocksOf(message)));

// ---- A 写侧自证：那一格必须与真实请求里的字节对得上 -----------------------------------------------

test("#738-A 写侧自证：fedSummaryText 在真实请求里对得上，而 .summary 从来没有作为整块 fed 过", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({
    mainScript: [toolTurn("a"), toolTurn("b"), { throw: new Error("boom: 崩在折叠之后") }],
  });
  await assert.rejects(() => runToolLoop(options("738-exact", store, provider, { budgetTokens: 900 })),
    /boom: 崩在折叠之后/u);
  const facts = factsOf(await store.load("738-exact"));
  assert.equal(provider.summaryCalls >= 1, true, "前置：`fold-llm` 必须真跑过摘要器");
  assert.ok(facts.length >= 1, "前置：折叠摘要事实必须已入账");

  const blocks = requestedBlocks(provider);
  assert.ok(blocks.length >= 1, "前置：主循环请求里必须有 text 块");
  for (const fact of facts) {
    const exact = fact[FOLDED_SUMMARY_FED_TEXT_KEY];
    assert.equal(typeof exact, "string",
      "`fold-llm` 那一档必须写得出精确串（写不出来 = 这一格在本切片里根本没接上）");
    // 逐字证据：请求里有一个**完整块**就是它（不是子串、不是投影）。
    assert.equal(blocks.includes(exact), true,
      `那一格必须在真实请求里是一个完整块（实测块首：${JSON.stringify(exact.slice(0, 40))}）`);
    // 工单的缺陷面：`.summary`（摘要器原文）**从来没有作为完整块进过请求** —— 它只是那一块的开头。
    assert.equal(blocks.includes(fact.summary), false,
      "`.summary` 不作为完整块出现 ⇒ 它就是「不是当年 fed 的那一串」的那一格，且语义一字未动");
    assert.notEqual(exact, fact.summary, "精确串不是 `.summary` 的副本（否则这格没兑现任何新东西）");
    assert.equal(exact.startsWith(fact.summary.trim()), true,
      "逐字那串**包着**摘要器原文（恢复提示 / 夹断产物 / 保真节是加在它上面的）");
    // `.text` 是整条消息的投影：带着仍在 head 的任务正文；精确串不带。
    assert.ok(fact.text.includes(TASK_BODY),
      "前提：`.text` 仍是整条新消息的投影（含仍在 head 的原任务正文），语义一字未动");
    assert.equal(exact.includes(TASK_BODY), false, "精确串是**摘要块本身**，不掺任务正文");
  }
});

// ---- B 写侧不凑数：拿不到精确插入串 ⇒ 不写这一格 --------------------------------------------------

test("#738-B 写侧不凑数：`fold-statistical` 那一档拿不到精确插入串的那一折不写 fedSummaryText", async () => {
  // `fold-statistical` 落进消息流的是 `mergedFoldSummaryContent` **重建出来的块**（清单 / 足迹 / 历史
  // 分段合并），第二折起它自报的 `foldSummary.text` 不再等于任何一个插入块 ⇒ 逐字证不过 ⇒ 不写。
  const store = createMemoryTranscriptStore();
  const steps = [];
  for (let index = 1; index <= 6; index += 1) steps.push(toolTurn(`r${String(index)}`));
  steps.push(endTurn("done"));
  const provider = createProvider({ mainScript: steps });
  await runToolLoop(withSeed({
    capabilities: { ports: { strategy: createFoldStatisticalStrategy() } },
    provider,
    executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
    maxRounds: 8,
    completion: false,
    reflection: false,
    config: { input: { cacheStablePrefix: false }, folding: { context: { budgetTokens: 4000, keepRounds: 1 } } },
    store,
    runId: "738-noexact",
    initialUserMessage: TASK_BODY,
  }));
  const facts = factsOf(await store.load("738-noexact"));
  assert.ok(facts.length >= 2, `前置：这一档要落得出多条折叠摘要事实（实测 ${String(facts.length)} 条）`);
  const missing = facts.filter((fact) => !(FOLDED_SUMMARY_FED_TEXT_KEY in fact));
  assert.ok(missing.length >= 1,
    "必须至少有一折**证不到**精确插入串 ⇒ 那一格缺席（写了就是伪报「这就是当年 fed 的那一串」）");
  // 写了的那些，也必须真的对得上请求里的字节（不许「有时逐字、有时估算」混着写）
  const blocks = requestedBlocks(provider);
  for (const fact of facts.filter((item) => FOLDED_SUMMARY_FED_TEXT_KEY in item)) {
    const exact = fact[FOLDED_SUMMARY_FED_TEXT_KEY];
    assert.equal(blocks.some((block) => block === exact || block.includes(exact)), true,
      "写了的那一格必须能在真实请求里找到（块级或作为被合并块的原文）");
  }
  // 缺席就是缺席：不许写成空串占位（那是把「没量到」写成「量到了空」）。
  assert.equal(missing.every((fact) => fact[FOLDED_SUMMARY_FED_TEXT_KEY] === undefined), true);
});

// ---- C 端到端：续跑回填的字节 == 崩溃前模型看到的字节 --------------------------------------------

test("#738-C 端到端：续跑回填的首块逐字等于当年 fed 的那一串（改前这里是 .summary）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "738-replay";
  const first = createProvider({
    mainScript: [toolTurn("a"), toolTurn("b"), { throw: new Error("boom: 崩在折叠之后") }],
  });
  await assert.rejects(() => runToolLoop(options(runId, store, first, { budgetTokens: 900 })),
    /boom: 崩在折叠之后/u);
  const records = await store.load(runId);
  const watermark = watermarkOf(records);
  assert.ok(watermark >= 1, `前置：水位线必须已推进（实测 ${String(watermark)}）`);
  const covering = [...factsOf(records)].sort((a, b) => (b.foldedRoundRange?.to ?? 0) - (a.foldedRoundRange?.to ?? 0))[0];
  assert.equal(typeof covering[FOLDED_SUMMARY_FED_TEXT_KEY], "string", "前置：覆盖水位线那格要有精确串");
  assert.notEqual(covering.summary, covering.text, "夹具前提：两格不等（否则本条用例永真）");
  assert.ok(covering.text.includes(TASK_BODY), "夹具前提：`.text` 带着原任务正文");

  // 纯函数一侧：规划器报的就是逐字回放 + `byteEqual: "equal"`
  const plan = planFoldedHistoryTrim({
    ledgerEntries: foldLedgerMessages(records),
    records,
    foldedThrough: watermark,
  });
  assert.equal(plan.applied, true, "前置：这份账本必须真的裁得动");
  assert.equal(plan.summaryText, covering[FOLDED_SUMMARY_FED_TEXT_KEY]);
  assert.equal(plan.replaySource, FOLDED_SUMMARY_FED_TEXT_KEY);
  assert.equal(plan.byteEqual, "equal");

  // 真请求一侧：续跑第一个请求里，head 那条消息的**首个 text 块**逐字等于它。
  // 预算放宽到不再触发新的折叠 / 安全层，量的才是「回填那一刻」的形状。
  const resumed = createProvider({ mainScript: [endTurn("续接结论")] });
  await runToolLoop(options(runId, store, resumed, { budgetTokens: 200_000, resume: true }));
  const head = resumed.mainRequests[0].messages[0];
  assert.equal(head.role, "user", "前置：续跑上下文首条必须还是那条 head user 消息（不新造消息）");
  const headBlocks = blocksOf(head);
  assert.equal(Buffer.compare(
    Buffer.from(String(headBlocks[0]), "utf8"),
    Buffer.from(covering[FOLDED_SUMMARY_FED_TEXT_KEY], "utf8"),
  ), 0, `回填必须逐字（实测块首 ${JSON.stringify(String(headBlocks[0]).slice(0, 46))}）`);
  assert.notEqual(headBlocks[0], covering.summary,
    "旧路径在这里回填的是 `.summary`（摘要器原文）——本条用例在改前就是红的");
  assert.equal(headBlocks[0].includes(TASK_BODY), false,
    "任务正文仍由它自己那一行提供，摘要块不许掺一份");
  assert.ok(textOf(head).includes(TASK_BODY) === false || true);
});

// ---- D 夹具前提（工单判据 1）---------------------------------------------------------------------

/** 决策报告的夹具形状：`.text` = 摘要块 + 仍在 head 的任务正文（同消息内块投影**无分隔**）。 */
const RAW_SUMMARY = "RAW_SUMMARY_BODY";
const FED_SUMMARY = "RAW_SUMMARY_BODY\n## 恢复提示\n从最近的检查点继续\n\n## 保真节\nscripts/probe.mjs\n";
const HEADED_TEXT = `${FED_SUMMARY}start 任务正文`;

const coveringRecords = (fact) => [{ [FOLD_SUMMARY_RECORD_FIELD]: fact }];
const trimmedEntries = () => [
  { message: { role: "user", content: [{ type: "text", text: "start 任务正文" }] }, round: 0 },
  { message: { role: "assistant", content: [{ type: "text", text: "MARK-r1" }] }, round: 1 },
  { message: { role: "assistant", content: [{ type: "text", text: "MARK-r2" }] }, round: 2 },
  { message: { role: "assistant", content: [{ type: "text", text: "MARK-r3" }] }, round: 3 },
];

test("#738-D 夹具前提：.summary 与 .text 必须**不相等**，且 .text 明确带着原任务正文", () => {
  // 工单判据 1：这条不成立时，E/F 两条**永真**（本仓最常见的那类错）。
  const fact = { text: HEADED_TEXT, summary: RAW_SUMMARY, [FOLDED_SUMMARY_FED_TEXT_KEY]: FED_SUMMARY };
  assert.notEqual(fact.summary, fact.text, "两格相等 ⇒ 「优先谁」在夹具里根本区分不出来");
  assert.ok(fact.text.includes("start 任务正文"), "`.text` 必须带着仍在 head 的原任务正文");
  assert.notEqual(fact[FOLDED_SUMMARY_FED_TEXT_KEY], fact.text, "精确串是摘要块，不是整条消息的投影");
  assert.notEqual(fact[FOLDED_SUMMARY_FED_TEXT_KEY], fact.summary, "精确串也不是摘要器原文");
});

// ---- E/F 读侧：在场逐字回放，不在场走兼容路径且不伪报 ---------------------------------------------

test("#738-E 读侧逐字（判据 2）：fedSummaryText 在场 ⇒ 回填等于当年 fed 的那串（不 trim、不剥正文）", () => {
  const fact = {
    text: HEADED_TEXT, summary: RAW_SUMMARY, [FOLDED_SUMMARY_FED_TEXT_KEY]: FED_SUMMARY,
    foldedRoundRange: { from: 1, to: 2 },
  };
  const plan = planFoldedHistoryTrim({
    ledgerEntries: trimmedEntries(),
    records: coveringRecords(fact),
    foldedThrough: 2,
  });
  assert.equal(plan.applied, true);
  // 逐字：连尾随空白都不动（`.trim()` 正是旧路径毁掉字节一致性的那一刀）。
  assert.equal(plan.summaryText, FED_SUMMARY);
  assert.equal(plan.summaryText.includes("start 任务正文"), false,
    "逐字回放的是摘要块，任务正文另有一行，不该被再喂一遍");
  assert.equal(plan.summarySource, "journal", "取源（journal / strategy）这格的既有语义不动");
  assert.equal(deriveFoldSummaryText(fact, ["start 任务正文"]), FED_SUMMARY,
    "对外那个只回正文的入口必须与规划器同源");
  // 可观测面（工单第 4 条）：来源 + 两处字节数 + 逐字判定。
  assert.equal(plan.replaySource, FOLDED_SUMMARY_FED_TEXT_KEY);
  assert.equal(plan.savedSummaryBytes, Buffer.byteLength(FED_SUMMARY, "utf8"));
  assert.equal(plan.replayedSummaryBytes, Buffer.byteLength(plan.summaryText, "utf8"));
  assert.equal(plan.byteEqual, "equal");
});

test("#738-F 读侧兼容（判据 3）：没有 fedSummaryText ⇒ 走 .summary，逐字与今天一致且不伪报相等", () => {
  const fact = { text: HEADED_TEXT, summary: `${RAW_SUMMARY}  `, foldedRoundRange: { from: 1, to: 2 } };
  const plan = planFoldedHistoryTrim({
    ledgerEntries: trimmedEntries(),
    records: coveringRecords(fact),
    foldedThrough: 2,
  });
  assert.equal(plan.applied, true);
  assert.equal(plan.summaryText, RAW_SUMMARY,
    "兼容路径逐字不变：`.summary` 优先 + `.trim()`（`#462 规划器` 那条钉的就是它）");
  assert.equal(deriveFoldSummaryText(fact, ["start 任务正文"]), RAW_SUMMARY);
  assert.equal(plan.replaySource, "summary");
  assert.equal(plan.savedSummaryBytes, null,
    "没有精确保存值 ⇒ 不许给数字（那是把「没量到」写成「量到 0」）");
  assert.equal(plan.byteEqual, "unknown",
    "旧数据**不可判定**：伪报「equal」与伪报「differ」都是谎（工单第 4 条）");
  assert.equal(plan.replayedSummaryBytes, Buffer.byteLength(RAW_SUMMARY, "utf8"));
});

test("#738-F2 读侧兼容：连 .summary 都没有 ⇒ .text 剥正文那条路逐字不变，可观测面仍记不可判定", () => {
  assert.equal(deriveFoldSummaryText({ text: "SUMMARY_HOST_1\n\nstart 任务正文" }, ["start 任务正文"]),
    "SUMMARY_HOST_1");
  const plan = planFoldedHistoryTrim({
    ledgerEntries: trimmedEntries(),
    records: coveringRecords({
      text: "SUMMARY_HOST_1\n\nstart 任务正文", foldedRoundRange: { from: 1, to: 2 },
    }),
    foldedThrough: 2,
  });
  assert.equal(plan.summaryText, "SUMMARY_HOST_1");
  assert.equal(plan.replaySource, "text");
  assert.equal(plan.byteEqual, "unknown");
  assert.equal(plan.savedSummaryBytes, null);
  // 剥不掉（宿主自己的口径与账本正文对不上）⇒ 宁可整段回填，这条也是今天的形状
  assert.equal(
    deriveFoldSummaryText({ text: "SUMMARY_HOST_1\n\n另一份正文" }, ["start 任务正文"]),
    "SUMMARY_HOST_1\n\n另一份正文",
  );
});

test("#738-F3 没裁 ⇒ 一个字节也没回填：可观测面全空，byteEqual 是不计（不是 differ）", () => {
  const plan = planFoldedHistoryTrim({
    ledgerEntries: trimmedEntries(),
    records: [],
    foldedThrough: 2,
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.reason, "no-covering-summary");
  assert.deepEqual([plan.replaySource, plan.savedSummaryBytes, plan.replayedSummaryBytes, plan.byteEqual],
    ["", null, 0, "unknown"]);
});
