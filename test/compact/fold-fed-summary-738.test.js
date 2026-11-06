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

// 反向证（手工跑过，未登记）：把读侧旧优先级**字面反转**（`.text` 优先）后，第一发且唯一一发红的就是
// `test/compact/resume-fold-trim.test.js` 的 `#462 规划器`，红在 `plan.applied === true`（`false !== true`，退出码 1）
// ——那一格「优先用引擎留下的纯摘要」正是旧优先级的钉子，「不许反转」这条既有常驻用例守着、也有手工反向证验过落点。
// 诚实记录一个不那么好看的变体：把 `.text` 排到 `.summary` **前面**、但剥正文剥空后仍回落到 `.summary`，`#462` 抓不到
// （剥完的 `.text` 是空串，照样回落），是本文件的 `#738-C` / `#738-E` / `#738-F` 三条把它打红的（三条同时红、退出码 1）。
//
// 变异样本已登记：`test/mutation-samples.md` 的 **M22** 钉的是**读侧**逐字（短路 `resume-fold-trim.js` 里那条精确分支
// ⇒ `#738-E` 红）；**M23** 钉的是**写侧**只认**钉住的那一块**（在 `pinFedSummaryBlock` 里丢掉「必须落在插入约定那个
// 下标」⇒ `#738-G2` 红）。两条打的是不同判据、彼此不互红，所以都得留。**编号是第二次 rebase 之后改的**：
// main 上 #736 已占用 M19/M20，本片的两条顺延为 M22/M23。
//
// 手工反向证（本刀落地时跑过，未登记为常驻样本）：把 `pickFedSummaryTextBlock` 退化成评审那版「定稿里有任一完整
// text 块与候选相等」⇒ `#738-G` 与 `#738-G2` 一起红（退出码 1）；只删 `pinFedSummaryBlock` 里「必须落在 `content[0]`」
// 那一条守卫 ⇒ `#738-G2` 红（退出码 1）。⇒ 这两条用例不是恒绿的摆设。
import test from "node:test";
import assert from "node:assert/strict";
import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import {
  FOLDED_SUMMARY_FED_TEXT_KEY,
  FOLD_SUMMARY_RECORD_FIELD,
  pickFedSummaryTextBlock,
  pinFedSummaryBlock,
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

const options = (runId, store, provider, {
  budgetTokens, keepRounds = 0, maxRounds = 6, toolBytes = 400, resume = false,
}) => withSeed({
  provider,
  executeTool: async ({ id }) => `MARK-${id} ${"z".repeat(toolBytes)}`,
  maxRounds,
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
});

const factsOf = (records) => records
  .map((record) => record?.[FOLD_SUMMARY_RECORD_FIELD])
  .filter((fact) => fact && typeof fact === "object" && typeof fact.text === "string");
const watermarkOf = (records) => Math.max(0, ...records.map((r) => r.foldedRoundRange?.to ?? 0));
/** 一条消息（含 `tool_result` 里的正文）的可搜索文本 —— 「这一轮的正文在不在上下文里」。 */
const searchable = (message) => JSON.stringify(message ?? "");
/** 真实请求里出现过的**全部 text 块原文**（逐字证据的唯一来源）。 */
const requestedBlocks = (provider) => provider.mainRequests
  .flatMap((request) => (request?.messages ?? []).flatMap((message) => blocksOf(message)));

// ---- A 写侧自证：那一格必须与真实请求里的字节对得上 -----------------------------------------------

test("#738-A 写侧自证：fedSummaryText 在真实请求里对得上，而 .summary 从来没有作为整块 fed 过", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({
    mainScript: [toolTurn("a"), toolTurn("b"), { throw: new Error("boom: 崩在折叠之后") }],
  });
  await assert.rejects(() => runToolLoop(options("738-exact", store, provider, { budgetTokens: 300 })),
    /boom: 崩在折叠之后/u);
  const facts = factsOf(await store.load("738-exact"));
  assert.equal(provider.summaryCalls >= 1, true, "前置：`fold-llm` 必须真跑过摘要器");
  assert.ok(facts.length >= 1, "前置：折叠摘要事实必须已入账");

  // 逐字证据**只来自请求**：把每个请求的每个 text 块摊平（拿引擎自己的账证引擎的账是永真的）。
  const blocks = requestedBlocks(provider);
  assert.ok(blocks.length >= 1, "前置：主循环请求里必须有 text 块");
  const withExact = facts.filter((fact) => FOLDED_SUMMARY_FED_TEXT_KEY in fact);
  assert.ok(withExact.length >= 1,
    "`fold-llm` 那一档至少要写得出一个精确串（一个都写不出来 = 这一格在本切片里根本没接上）");
  for (const fact of withExact) {
    const exact = fact[FOLDED_SUMMARY_FED_TEXT_KEY];
    assert.equal(typeof exact, "string", "写了键就必须是字符串（不许空串占位）");
    assert.equal(blocks.includes(exact), true,
      `那一格必须在真实请求里是一个完整块（实测块首：${JSON.stringify(exact.slice(0, 40))}）`);
    assert.notEqual(exact, fact.summary, "精确串不是 `.summary` 的副本（否则这格没兑现任何新东西）");
    assert.equal(exact.includes(fact.summary.trim()), true,
      "逐字那串**包着**摘要器原文（恢复提示 / 夹断产物 / 保真节是加在它上面的）");
    assert.ok(fact.text.includes(TASK_BODY),
      "前提：`.text` 仍是整条新消息的投影（含仍在 head 的原任务正文），语义一字未动");
    assert.equal(exact.includes(TASK_BODY), false, "精确串是**摘要块本身**，不掺任务正文");
  }
  // 工单的缺陷面：`.summary`（摘要器原文）在**任何一折**都没有作为完整块进过请求。
  // 它就是「不是当年 fed 的那一串」的那一格 —— 而它的语义与读者本切片一字未动。
  for (const fact of facts) {
    // 模型确实见过摘要器原文（它是 fed 那一大块里的一段）⇒ 旧路径不是「没喂摘要」，是「喂错了字节」。
    assert.equal(blocks.includes(fact.summary), false,
      "`.summary` 不作为**完整块**出现 ⇒ 读侧优先它就是拿错了字节");
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
    executeTool: async ({ id }) => `MARK-${id} ${"z".repeat(4000)}`,
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

  // 这份**真账本**续跑时走的就是兼容路径 ⇒ 可观测面必须报「不可判定」，不是伪报相等。
  const ledger = await store.load("738-noexact");
  const plan = planFoldedHistoryTrim({
    ledgerEntries: foldLedgerMessages(ledger),
    records: ledger,
    foldedThrough: watermarkOf(ledger),
  });
  assert.equal(plan.applied, true, "前置：这份账本要真的裁得动（否则下面三格是空断言）");
  assert.notEqual(plan.replaySource, FOLDED_SUMMARY_FED_TEXT_KEY,
    "没有精确保存值 ⇒ 回填不许声称来自那一格");
  assert.equal(plan.savedSummaryBytes, null);
  assert.equal(plan.byteEqual, "unknown",
    "真账本的兼容回填：**不可判定**就是不可判定（工单第 4 条「禁止伪报相等」）");
});

// ---- C 端到端：续跑回填的字节 == 崩溃前模型看到的字节 --------------------------------------------

test("#738-C 端到端：续跑回填的首块逐字等于当年 fed 的那一串（改前这里是 .summary）", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "738-replay";
  const first = createProvider({
    mainScript: [toolTurn("a"), toolTurn("b"), { throw: new Error("boom: 崩在折叠之后") }],
  });
  // 预算 900 / 工具输出 3000：折得动、且覆盖水位线那一格**没被安全层改写**（实测：预算 300 时
  // 最新那一格会被 `[已修剪]` 改写过 ⇒ 精确串证不过、续跑退回兼容路径，那是 B 测的形状，不是这条）。
  await assert.rejects(() => runToolLoop(options(runId, store, first, {
    budgetTokens: 900, toolBytes: 3000,
  })), /boom: 崩在折叠之后/u);
  const records = await store.load(runId);
  const watermark = watermarkOf(records);
  assert.ok(watermark >= 1, `前置：水位线必须已推进（实测 ${String(watermark)}）`);
  const facts = factsOf(records);
  assert.ok(facts.length >= 1, `前置：崩溃前至少折一次（实测 ${String(facts.length)} 条事实）`);
  const covering = [...facts].sort((a, b) => (b.foldedRoundRange?.to ?? 0) - (a.foldedRoundRange?.to ?? 0))[0];
  assert.equal(typeof covering[FOLDED_SUMMARY_FED_TEXT_KEY], "string", "前置：覆盖水位线那格要有精确串");
  assert.notEqual(covering.summary, covering.text, "夹具前提：`.summary` 与 `.text` 不等（否则本条永真）");
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
  // 「不许裁过头」那一侧：水位线（1）之后那一轮的正文必须还在续跑上下文里，且只出现一次。
  const replayed = resumed.mainRequests[0].messages;
  assert.equal(replayed.filter((message) => searchable(message).includes("MARK-b")).length, 1,
    "水位线以上的正文必须还在上下文里，且只出现一次（不多不少）");
  assert.equal(replayed.filter((message) => searchable(message).includes("MARK-a")).length, 0,
    "水位线以下（≤ 水位线 1）那一轮的正文不得再被喂一遍 —— 它已经在那份逐字摘要里了");
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

// ---- G 评审必修：摘要块的身份 ≠ 「同一条消息里有个同文块」 -----------------------------------------

// 独立评审定罪的误认路径（探针现场，原文见 `rv738a/review-738-fed-summary.md`）：
//   新消息 = [ 摘要块被夹断成 "SUMMARY\n[已修剪]", 保留下来的正文块 "SUMMARY" ]，候选 = "SUMMARY"
//   ⇒ 实际插入的摘要块是 `"SUMMARY\n[已修剪]"`，而旧判据（`content.some(block => block.text === candidate)`）
//   会命中**那个保留正文块**，把 `"SUMMARY"` 当成「当年 fed 的那一串」写进账。
// 根因是判据不限定「命中的那一块是不是摘要块」。修法是把身份**在安全层动手之前**就钉住
// （`pinFedSummaryBlock`），定稿处只认那个块对象（`pickFedSummaryTextBlock` 的两档身份）。
// 这几例全部**直接调这两个函数**，形状与 `orchestrator.js:4361` / `:4484` 的调用完全一致。

/** 评审夹具：候选 = `"SUMMARY"`，同一条新消息里还留着与它同文的正文块。 */
const REVIEW_CANDIDATE = "SUMMARY";

test("#738-G 反例（评审必修）：摘要块被改写、同一条新消息里仍有同文正文块 ⇒ 不得写 fedSummaryText", () => {
  // ① 钉住的时刻（折叠层定稿、安全层之前）：摘要块在 content[0]，正文块在它后面 —— 三条插入路径
  //    都是这个形状（`fold-llm.js:145`、`fold-statistical.js:1116-1119 + :1167`、`budget-fit.js:160`）。
  const summaryBlock = { type: "text", text: REVIEW_CANDIDATE };
  const carriedBodyBlock = { type: "text", text: "与摘要同文的保留正文" };
  const carrierAtInsertion = { role: "user", content: [summaryBlock, carriedBodyBlock] };
  const pin = pinFedSummaryBlock({
    candidate: REVIEW_CANDIDATE,
    messages: [carrierAtInsertion],
    preCompactionMessages: new Set(),
  });
  assert.deepEqual(pin && { blockIndex: pin.blockIndex, sameBlock: pin.block === summaryBlock },
    { blockIndex: 0, sameBlock: true }, "钉住的必须是 content[0] 那块摘要块（这一步是身份的来源）");

  // ② 安全层动过手：`safeTruncateMessages` 起手 `cloneState(messages)`（`budget.js:179-180`，
  //    即 `structuredClone`）⇒ 消息与块**全是新对象**，而摘要块被截成了 `"SUMMARY\n[已修剪]"`；
  //    同一条消息里**另有一块**仍是 `"SUMMARY"` —— 评审探针里那一份。
  const finalMessages = [{
    role: "user",
    content: [
      { type: "text", text: `${REVIEW_CANDIDATE}\n[已修剪]` },
      { type: "text", text: REVIEW_CANDIDATE },
    ],
  }];
  // 夹具前提（不是恒真）：定稿里**确实存在**一个与候选逐字同文的块 —— 旧判据正是栽在这里。
  assert.equal(
    finalMessages[0].content.some((block) => block.text === REVIEW_CANDIDATE), true,
    "前提：同文块在场（否则本例挡不住任何事）",
  );
  assert.notEqual(finalMessages[0].content[0].text, REVIEW_CANDIDATE,
    "前提：真正的摘要块已被改写 ⇒ 逐字承诺当场不成立");
  assert.equal(pickFedSummaryTextBlock({
    candidate: REVIEW_CANDIDATE, messages: finalMessages, pin,
  }), undefined, "被截断之后不得再写 fedSummaryText（把保留正文当成当年 fed 的摘要 = 评审定罪的误认）");

  // ②b 另一种碎法：不深拷贝、就地改写文本（同一块对象，文本变了）。两档身份里 ① 的文本核对先碎。
  summaryBlock.text = `${REVIEW_CANDIDATE}\n[已修剪]`;
  assert.equal(pickFedSummaryTextBlock({
    candidate: REVIEW_CANDIDATE, messages: [carrierAtInsertion], pin,
  }), undefined, "就地改写也必须证不过（块还在，但它已经不是当年那一串了）");

  // ③ 正向对照（**这条才是关键**：整个函数不能靠「一律不写」蒙过上面两例）
  const untouched = { type: "text", text: REVIEW_CANDIDATE };
  const carrier = { role: "user", content: [untouched, { type: "text", text: "正文" }] };
  const goodPin = pinFedSummaryBlock({
    candidate: REVIEW_CANDIDATE, messages: [carrier], preCompactionMessages: new Set(),
  });
  assert.equal(pickFedSummaryTextBlock({
    candidate: REVIEW_CANDIDATE, messages: [carrier], pin: goodPin,
  }), REVIEW_CANDIDATE, "身份没断、文本没动 ⇒ 照旧写（写侧的覆盖面不是靠伪报撑住的）");
});

test("#738-G2 同文歧义一律不写：同一条消息里两块同文 / 两条新消息都命中 / 命中的不是插入下标", () => {
  // (a) 同一条消息里两块与候选同文 ⇒「哪一块是摘要块」当场不可判 ⇒ 不钉 ⇒ 不写
  const twinCarrier = {
    role: "user",
    content: [{ type: "text", text: "SUMMARY" }, { type: "text", text: "SUMMARY" }],
  };
  assert.equal(pinFedSummaryBlock({
    candidate: "SUMMARY", messages: [twinCarrier], preCompactionMessages: new Set(),
  }), undefined, "两块同文 ⇒ 不可判");

  // (b) 两条新消息的首块都是候选 ⇒ 同样不可判
  const carrierA = { role: "user", content: [{ type: "text", text: "SUMMARY" }] };
  const carrierB = { role: "system", content: [{ type: "text", text: "SUMMARY" }] };
  assert.equal(pinFedSummaryBlock({
    candidate: "SUMMARY", messages: [carrierA, carrierB], preCompactionMessages: new Set(),
  }), undefined, "两条新消息都命中 ⇒ 不可判");
  assert.equal(pickFedSummaryTextBlock({
    candidate: "SUMMARY", messages: [carrierA, carrierB], pin: undefined,
  }), undefined, "没钉住 ⇒ 直接证不过（禁止拿候选去定稿消息里做文字搜索）");

  // (c) 同文块命中的是**保留正文那个下标**，不是插入约定的首块 ⇒ 不敢认
  //     (c1) 这条消息是压缩前就在的（正文原文行）⇒ 它根本不是本次折叠新造的
  const bodyFirst = {
    role: "user",
    content: [{ type: "text", text: "SUMMARY" }, { type: "text", text: "别的正文" }],
  };
  assert.equal(pinFedSummaryBlock({
    candidate: "SUMMARY",
    messages: [bodyFirst],
    preCompactionMessages: new Set([bodyFirst]),
  }), undefined, "旧消息里的同文块不算证据");
  //     (c2) 消息是**新造的**，但同文块落在下标 1（`fold-llm` 改写 user 消息时正文跟在摘要块后面，
  //     评审反例里那块的位置）⇒ 命中不在插入约定那个下标上 ⇒ 一样不敢认
  const bodySecond = {
    role: "user",
    content: [{ type: "text", text: "别的正文" }, { type: "text", text: "SUMMARY" }],
  };
  assert.equal(pinFedSummaryBlock({
    candidate: "SUMMARY",
    messages: [bodySecond],
    preCompactionMessages: new Set(),
  }), undefined, "同文块不在摘要块那个下标上 ⇒ 不算证据（这正是评审坐实的那一类命中）");

  // (d) 候选本身空/非串 ⇒ 没得证
  assert.equal(pinFedSummaryBlock({ candidate: "   ", messages: [carrierA] }), undefined);
  assert.equal(pickFedSummaryTextBlock({ candidate: 42, messages: [carrierA], pin: { message: carrierA, blockIndex: 0, block: carrierA.content[0] } }), undefined);
});