// issue #566：折叠记录 **append-only** —— 每一折的增量成为一条不可变、可独立读取的账本记录。
//
// 病根（比工单正文更准的前提，主 agent 已核对）：账本今天每折写一条 `foldedFacts`，但
// `foldedFacts.text` 承载的是**截至本折的累计替代物**（`fold-llm` 尤其明显：它是「折叠后那条
// user 消息的全文」= 历次摘要叠起来 + 原任务正文）。连续 N 折之后账本里有 N 份累计快照，
// 每一折的增量只能靠 diff 相邻两份快照还原；其中任意一份被 `FOLDED_FACTS_MAX_BYTES`（2048）
// 前缀夹断，那个增量就**永久不可还原**。
//
// 本单的做法：**另开一个键** `foldedFacts.increment`（`text` 的语义一字未改），
// 值是「本折自己删掉的那一段」的替代物（合并前那一份，由策略从真实产物取，不从累计文本反推）。
//
// 判据（工单「判据」逐条，每格一个用例）：
//   1. 不可变：连续两折之后，第 1 折的增量记录与第 1 折当时逐字相同（不是被第 2 折改写过的版本）；
//   2. 可独立读取：不 diff 两份累计快照就能拿到第 k 折的 `from/to/rounds/text`；
//   3. 夹断不影响增量：累计体被 2048 前缀夹断时，本折增量仍完整可读（本单的核心价值断言）；
//   4. resume 对拍：同一账本 + 同一 `foldedThrough`，裁出的正文逐字相同 —— 在既有 resume 用例里扩一格
//      （`test/compact/resume-fold-trim.test.js` 的 `#566-4` 段），本文件不重复造夹具；
//   5. 模型可见面零变化：增量不进请求组装（A/B 对拍：有增量 vs 无增量，请求消息流逐字相同；
//      且增量里的哨兵串在请求里一次都不出现）；
//   6. 账本体积上界：每折增量 ≤ `FOLDED_FACTS_MAX_BYTES`（默认 2048）⇒ 100 折 ≈ 200 KB/会话。
//
// 三条硬约束（工单「硬约束」）在用例里的落点：
//   ① 不改 `text` 的既有语义 ⇒ `#566-0` 的「加不加 increment，父键逐字节相同」；
//   ② resume 行为逐字不变 ⇒ `#566-4`（`pickCoveringFoldSummary` 的取源一个字都没动）；
//   ③ 只进账本，不进模型上下文 ⇒ `#566-5`。
//
// 零真实 LLM：fake provider + 内存 store（AGENTS.md 测试隔离规则：不写真实 `~/.erix`）。

import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { withSeed } from "../helpers/run-direct.js";
import {
  FOLDED_FACTS_INCREMENT_KEY,
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";

const encoder = new TextEncoder();
const bytesOf = (value) => encoder.encode(String(value ?? "")).length;

const SUMMARY_SYSTEM = "你是对话历史压缩器";
/** 摘要器正文的哨兵（判据 3 用它证明「400 字节的载荷一个字节都没丢」）。 */
const summaryFiller = (bytes) => "s".repeat(bytes);

/**
 * `fold-llm` 路径的 fake provider：摘要请求（system 里带 `SUMMARY_SYSTEM`）返回
 * `## 阶段\nLLM_SUMMARY_<n>\n<filler>`，其余请求按脚本发工具调用、最后收尾。
 *
 * 为什么必须走**真摘要器**这一路：`fold-llm` 的 `foldedFacts.text` 才是「累计体」，
 * 也才有「累计体被夹断、增量仍然完整」这件事可断言（`fold-statistical` 的 `text` 本来就是本折那份）。
 */
function makeFoldLlmProvider({ toolTurns = 8, summaryBytes = 400 } = {}) {
  let turns = 0;
  let summaries = 0;
  const requests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaries += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nLLM_SUMMARY_${summaries}\n${summaryFiller(summaryBytes)}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      requests.push(request);
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `npm test -- --grep case-${turns}` } }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  provider.chatStream = provider.chat;
  provider.summaryCalls = () => summaries;
  return provider;
}

/**
 * 跑一条 `fold-llm` 折叠链，返回账本里**折叠轮**的 `foldedFacts` 投影（按轮号升序）。
 *
 * 预算/种子/工具输出的取值是量出来的（探针见 DELIVERY.md）：`budgetTokens: 1000` +
 * `seed 1500 字节` + 每轮 600 字节工具输出 ⇒ 第 4 轮圈顶第一次折叠（`text` 2022 字节，未夹断），
 * 第 6 轮第二次折叠（`text` 超过 2048 ⇒ 前缀夹断），而每折增量恒 ~516 字节。
 * 这正好把「累计体夹断 / 增量完整」摆在同一份账本里。
 */
async function runFoldLlmChain({
  runId,
  toolTurns = 8,
  budgetTokens = 1000,
  seedBytes = 1500,
  toolBytes = 600,
  summaryBytes = 400,
  store = createMemoryTranscriptStore(),
  // 判据 1b/1c 要换一个**对抗性**摘要器（把 `priorSummary` 原文续写进输出），其余一切不变。
  provider,
} = {}) {
  const activeProvider = provider ?? makeFoldLlmProvider({ toolTurns, summaryBytes });
  await runToolLoop(withSeed({
    provider: activeProvider,
    executeTool: async ({ id }) => `tool output ${id} ${"z".repeat(toolBytes)}`,
    maxRounds: 20,
    completion: false,
    reflection: false,
    config: { folding: { context: { budgetTokens, keepRounds: 0, strategy: "fold-llm" } } },
    store,
    runId,
    seed: `start ${"y".repeat(seedBytes)}`,
  }));
  const records = await store.load(runId);
  const folds = records
    .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
    .map((record) => ({ round: record.round, facts: record[FOLDED_FACTS_RECORD_FIELD] }));
  return { records, folds, provider: activeProvider, store };
}

const incrementOf = (facts) => facts?.[FOLDED_FACTS_INCREMENT_KEY];

// ---- 判据 0（硬约束①）：`text` 的既有语义一字未改 ----------------------------------
// 这一格是「另开键」这件事的地基：增量在场与否，父键（`text`/`title`/`origin`/`bytes`/`from`/`to`/
// `rounds`/`source`/`strategy`/`toolCalls`）必须**逐字节相同**。改 `text` 的含义去装增量 ⇒ 这里红。

test("#566-0 加不加 increment，父键逐字节相同（`text` 仍是累计替代物，语义一字未改）", () => {
  const base = {
    text: "早期第 1–9 轮（共 9 轮）已折叠。工具足迹：exec×3。",
    source: "statistical",
    strategy: "fold-statistical",
    roundRange: { from: 1, to: 9 },
    rounds: 9,
    fingerprint: "sha256:deadbeefdeadbeefdeadbeef",
  };
  const withoutIncrement = buildFoldedFacts(base);
  const withIncrement = buildFoldedFacts({ ...base, incrementText: "本折自己那份：早期第 7–9 轮" });
  assert.equal(Object.hasOwn(withoutIncrement, FOLDED_FACTS_INCREMENT_KEY), false,
    "没有增量文本 ⇒ 不写该键（不写占位字面量）");
  const { increment, ...parentOnly } = withIncrement;
  assert.deepEqual(parentOnly, withoutIncrement,
    "增量是纯加法：父键（含 text/bytes/title/origin/toolCalls）必须逐字节不变");
  assert.ok(increment !== undefined, "给了增量文本就必须有 increment 键");
  // 形状：与工单建议的形状一致（多一个 bytesBefore 只在真夹断时出现）。
  assert.deepEqual(Object.keys(increment).sort(),
    ["bytes", "from", "origin", "rounds", "text", "title", "to"]);
  assert.equal(increment.from, 1);
  assert.equal(increment.to, 9);
  assert.equal(increment.rounds, 9);
  assert.equal(increment.origin, "mechanical", "origin 与父键同一把尺子（谁写的）");
  assert.equal(increment.bytes, bytesOf(increment.text), "bytes 是本折增量正文的字节数");
  assert.equal(increment.text, "本折自己那份：早期第 7–9 轮");

  // 增量自己的夹断（> 上限）：只削它自己，父键不动，且如实自称被夹断。
  const huge = buildFoldedFacts({ ...base, incrementText: `头${"字".repeat(4000)}尾` });
  assert.equal(huge.text, withoutIncrement.text, "增量夹断不得牵连父键正文");
  assert.equal(huge.bytes, withoutIncrement.bytes);
  assert.ok(incrementOf(huge).bytes <= FOLDED_FACTS_MAX_BYTES,
    `增量必须自带上界（实测 ${incrementOf(huge).bytes} > ${FOLDED_FACTS_MAX_BYTES}）`);
  assert.equal(incrementOf(huge).truncated, true);
  assert.ok(incrementOf(huge).bytesBefore > FOLDED_FACTS_MAX_BYTES,
    "夹断了就要留痕：原始字节数可核对");
  assert.match(incrementOf(huge).text, /\[替代物已按字节上限夹断\]/u);
  assert.equal(incrementOf(huge).title.startsWith("头"), true,
    `title 从原始正文取（夹断只削尾部 ⇒ 首行按构造仍在），实测 ${JSON.stringify(incrementOf(huge).title)}`);
  assert.ok(Array.from(incrementOf(huge).title).length <= 60, "title 仍受 #565 的 60 字符上界约束");
});

// ---- 判据 1：不可变 ------------------------------------------------------------

test("#566-1 连续两折之后，第 1 折的增量与第 1 折当时逐字相同（不是被第 2 折改写过的版本）", async () => {
  // 「第 1 折当时」= 只跑到第 1 折的那次 run（同一份脚本、同一份种子、同一预算 ⇒ 第 1 折的
  // 输入逐字相同）。「第 2 折之后」= 同一脚本多跑两轮。两者第 1 折的增量必须逐字相等。
  const oneFold = await runFoldLlmChain({ runId: "566-immutable-a", toolTurns: 4 });
  const twoFolds = await runFoldLlmChain({ runId: "566-immutable-b", toolTurns: 8 });
  assert.equal(oneFold.folds.length, 1, `前置：短链必须恰好折一次（实测 ${oneFold.folds.length}）`);
  assert.ok(twoFolds.folds.length >= 2, `前置：长链必须折两次以上（实测 ${twoFolds.folds.length}）`);
  assert.ok(oneFold.provider.summaryCalls() >= 1, "前置：走的是真摘要器那条路（否则没有累计体）");

  const firstAtFoldTime = incrementOf(oneFold.folds[0].facts);
  const firstAfterSecondFold = incrementOf(twoFolds.folds[0].facts);
  assert.ok(firstAtFoldTime !== undefined, "前置：第 1 折必须落了增量");
  assert.deepEqual(firstAfterSecondFold, firstAtFoldTime,
    "第 1 折的增量记录是 append-only 的：第 2 折不许改写它（逐字相同，含 bytes/title/origin）");

  // 判据 1 的另一半（这一条才是「读累计文本」的钉子）：第 2 折的增量只讲第 2 折，
  // **不包含**第 1 折的正文；且它不等于这一折的累计体。
  //
  // 取源（修复后）：增量 = **本折的确定性机械替代物**（零 LLM，只描述本次被折轮次）。
  // 所以它里面既不该出现摘要器的产物（`LLM_SUMMARY_*`），也不该出现第 1 折的增量正文。
  // 曾经的做法（`increment = compactedSummary`）在这里是绿的，因为本夹具的 fake 摘要器
  // 返回**固定**摘要、不续写 prior；真模型的续写形状由 `#566-1b` 那个对抗性夹具钉住。
  const secondFold = twoFolds.folds[1];
  const second = incrementOf(secondFold.facts);
  assert.ok(second !== undefined, "前置：第 2 折也必须落了增量");
  assert.equal(second.text.includes("LLM_SUMMARY_"), false,
    "第 2 折的增量是本折的机械替代物：摘要器产物一个字符都不该混进来（那正是续写累计体的形状）");
  assert.equal(second.text.includes(firstAtFoldTime.text), false,
    "第 2 折的增量不得包含第 1 折的增量（否则它就不是「本折那份」）");
  assert.match(second.text, new RegExp(`第 ${secondFold.facts.from}–${secondFold.facts.to} 轮`, "u"),
    "增量的正文只描述本折自己的轮区间（不是 1..N）");
  assert.notEqual(second.text, secondFold.facts.text,
    "增量 ≠ 累计体：`foldedFacts.text` 是截至本折的累计替代物，增量是本折自己那份");
  assert.notEqual(second.bytes, secondFold.facts.bytes,
    "两者的字节数也不该相等（累计体里还压着原任务正文与历次摘要）");
  // `origin` 说的是「这段文本是谁写的」（#565）：父键是摘要器写的，增量是引擎机械算的 ——
  // 两者各说各的，机械文本不许冒充语义（否则宿主会拿它当语义索引用）。
  assert.equal(second.origin, "mechanical", "本折增量是零 LLM 的机械替代物 ⇒ 自报 mechanical");
  assert.equal(secondFold.facts.origin, "semantic", "父键仍是摘要器写的 ⇒ semantic（语义一字未改）");
});

// ---- 判据 1b / 1c：对抗性夹具 —— 「续写累计体」不是本折增量 -------------------------
//
// 为什么要这一格（这是本单真正的洞）：`fold-llm` 会把上一份摘要当**续写基底**交给下一次摘要
//（`resolveContinuationBase` → `callSummarizerWithBound({priorSummary})`），`provider-summarizer.js`
// 把它摆在窗口正文之前，提示词要求「续写」。于是**真模型会把 prior 的内容写进输出**——
// 第 n 折的 `compactedSummary` 里必然混着第 n-1 折的历史，它的语义是「截至本折的历史摘要」
//（rolling cumulative），**不是**「本折删掉的那一段」。拿它当 `increment` 就是「从累计文本反推」，
// 正是 issue #566 明令禁止的取源方式。
//
// `makeFoldLlmProvider` 返回**固定**摘要（不续写 prior），所以 `#566-1` 那格当时也能绿：
// 第 2 折的 `increment` 看起来「只含本折内容」。本夹具把 prior **原文回显**进输出，
// 正是真续写摘要的形状——旧实现（`increment = compactedSummary`）在这里必红。

/** `provider-summarizer.js` 摆 prior 用的分节头（原文字面量，只在这里读它）。 */
const PRIOR_SECTION_HEADER = "【上一份折叠摘要（续写基底，只作脉络，不要重述）】\n";

/** 从摘要请求里取出调用方摆进去的 `priorSummary` 原文（没有就空串）。 */
function priorSectionOf(request) {
  const content = String(request?.messages?.[0]?.content ?? "");
  const at = content.indexOf(PRIOR_SECTION_HEADER);
  if (at < 0) return "";
  const rest = content.slice(at + PRIOR_SECTION_HEADER.length);
  // 下一节是窗口正文（`serializeFoldedMessagesWithMeta` 的固定首行）。
  const end = rest.indexOf("\n\n【被折叠的轮次】");
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 对抗性 fake provider：摘要器把收到的 `priorSummary` **原文续写**进输出，再另起一行写自己的特征串
 * `PRIOR_ECHO_MARK_<n>` ⇒ 第 n 折的 `compactedSummary` 里必然混着第 n-1 折的历史。
 */
function makePriorEchoProvider({ toolTurns = 8 } = {}) {
  let turns = 0;
  let summaries = 0;
  const requests = [];
  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaries += 1;
        const own = `## 阶段\nPRIOR_ECHO_MARK_${summaries}`;
        const prior = priorSectionOf(request);
        return {
          content: [{ type: "text", text: prior === "" ? own : `${prior}\n${own}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      requests.push(request);
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `npm test -- --grep case-${turns}` } }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      return { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  provider.chatStream = provider.chat;
  provider.summaryCalls = () => summaries;
  return provider;
}

/** 对抗性夹具下跑两折，返回账本里的折叠记录（按轮号升序）。 */
async function runPriorEchoChain(runId) {
  const provider = makePriorEchoProvider({ toolTurns: 8 });
  const result = await runFoldLlmChain({ runId, toolTurns: 8, provider });
  return { ...result, provider };
}

test("#566-1b 对抗性续写夹具下，第 2 折的增量不含第 1 折摘要的特征串（续写累计体不算增量）", async () => {
  const { folds, provider } = await runPriorEchoChain("566-prior-echo-marker");
  assert.ok(folds.length >= 2, `前置：至少两折（实测 ${folds.length}）`);
  assert.ok(provider.summaryCalls() >= 2, "前置：走的是真摘要器那条路（否则没有续写基底）");
  const [first, second] = folds;
  // 前置（这条是「下面那条断言不是空断言」的保证）：夹具确实把第 1 折的摘要续写进了第 2 折的**累计体**。
  assert.equal(first.facts.text.includes("PRIOR_ECHO_MARK_1"), true,
    "前置：第 1 折的累计体里必须有它自己的特征串");
  assert.equal(second.facts.text.includes("PRIOR_ECHO_MARK_1"), true,
    "前置：真续写形状 —— 第 2 折的累计体里确实压着第 1 折的摘要（否则本格是空断言）");

  const increment = incrementOf(second.facts);
  assert.ok(increment !== undefined, "前置：第 2 折必须落了增量");
  // 判据（这一条有牙：`increment = compactedSummary` 在这里必红——那份里含 PRIOR_ECHO_MARK_1）。
  assert.equal(increment.text.includes("PRIOR_ECHO_MARK_1"), false,
    `第 2 折的增量不得含第 1 折摘要的特征串（实测正文：${JSON.stringify(increment.text.slice(0, 160))}）`);
  // 更宽的那一条：增量是本折的机械替代物，摘要器的任何产物都不该混进来（含它自己的特征串）。
  assert.equal(increment.text.includes("PRIOR_ECHO_MARK_"), false,
    "第 2 折的增量里不得出现摘要器的任何产物（机械替代物 ≠ 续写体）");
  // 而父键（累计体）照旧含它——`text` 的语义一字未改。
  assert.equal(second.facts.text.includes("PRIOR_ECHO_MARK_2"), true,
    "父键仍是累计体：它含本次摘要器产物（语义一字未改）");
});

test("#566-1c 对抗性夹具下，第 2 折的 increment.from/to 是本折自己的轮区间（不是 1..N）", async () => {
  const { folds } = await runPriorEchoChain("566-prior-echo-range");
  assert.ok(folds.length >= 2, `前置：至少两折（实测 ${folds.length}）`);
  const [first, second] = folds;
  const increment = incrementOf(second.facts);
  assert.ok(increment !== undefined, "前置：第 2 折必须落了增量");
  assert.equal(increment.from, second.facts.from,
    "增量的 from 必须与本折父键的 from 相同（同一次折叠的两个投影）");
  assert.equal(increment.to, second.facts.to,
    "增量的 to 必须与本折父键的 to 相同");
  assert.ok(increment.from > first.facts.to,
    `前置：第 2 折的起点必须晚于第 1 折的终点（实测 ${increment.from} vs ${first.facts.to}）`);
  assert.match(increment.text, new RegExp(`第 ${increment.from}–${increment.to} 轮（共 ${increment.rounds} 轮）`, "u"),
    "增量的正文必须写的是本折自己的区间");
  assert.equal(increment.text.includes(`第 1–${second.facts.to} 轮`), false,
    "增量不得退化成 1..N（那是「把全部历史都算进来」的形状）");
});

// ---- 判据 2：可独立读取 --------------------------------------------------------

test("#566-2 不需要 diff 两份累计快照，就能拿到第 k 折的 from/to/rounds/text", async () => {
  const store = createMemoryTranscriptStore();
  const { folds } = await runFoldLlmChain({ runId: "566-read", store, toolTurns: 10 });
  assert.ok(folds.length >= 2, `前置：至少两折（实测 ${folds.length}）`);

  const ranges = new Set();
  for (const [index, { facts }] of folds.entries()) {
    const increment = incrementOf(facts);
    assert.ok(increment !== undefined, `第 ${index + 1} 折必须落增量`);
    // 三个范围键 + 正文 + 标题 + 字节数：一条记录自己就说清了「折走了哪些轮、删掉了什么」。
    assert.ok(Number.isSafeInteger(increment.from) && increment.from >= 1,
      `第 ${index + 1} 折的增量必须自带 from（实测 ${JSON.stringify(increment.from)}）`);
    assert.ok(Number.isSafeInteger(increment.to) && increment.to >= increment.from,
      `第 ${index + 1} 折的增量必须自带 to（实测 ${JSON.stringify(increment.to)}）`);
    assert.ok(Number.isSafeInteger(increment.rounds) && increment.rounds >= 1,
      `第 ${index + 1} 折的增量必须自带 rounds（实测 ${JSON.stringify(increment.rounds)}）`);
    assert.equal(typeof increment.text, "string");
    assert.ok(increment.text !== "", "增量正文不得为空");
    assert.equal(typeof increment.title, "string");
    assert.ok(increment.title !== "", "title 必填且非空（宿主渲染一行索引要用）");
    assert.equal(increment.bytes, bytesOf(increment.text));
    assert.equal(increment.origin, "mechanical", "本折增量是机械替代物 ⇒ 自报 mechanical（#565 的同一把尺子）");
    // 「可独立读取」的可测面：每条增量都能**单独**回答「我折的是哪一段」——它自带的
    // `from`/`to`/`rounds` 与正文里的区间行、以及父键的区间三者必须说同一件事。
    assert.equal(increment.from, facts.from, `第 ${index + 1} 折的增量区间必须与父键同一段（from）`);
    assert.equal(increment.to, facts.to, `第 ${index + 1} 折的增量区间必须与父键同一段（to）`);
    assert.equal(increment.rounds, facts.rounds, `第 ${index + 1} 折的增量轮数必须与父键同一段`);
    assert.match(increment.text, new RegExp(`第 ${increment.from}–${increment.to} 轮（共 ${increment.rounds} 轮）`, "u"),
      `第 ${index + 1} 折的增量正文必须自己写出它折的是哪一段`);
    assert.equal(increment.text.includes("LLM_SUMMARY_"), false,
      `第 ${index + 1} 折的增量是机械替代物：不得混进摘要器产物（那是续写累计体的形状）`);
    const key = `${increment.from}-${increment.to}`;
    assert.equal(ranges.has(key), false, `区间 ${key} 重复出现 ⇒ 增量与累计快照混了`);
    ranges.add(key);
  }
  // 互不包含：任何一条增量都不是另一条的「超集」（累计体才会那样）。
  const texts = folds.map(({ facts }) => incrementOf(facts).text);
  for (const [left, text] of texts.entries()) {
    for (const [right, other] of texts.entries()) {
      if (left === right) continue;
      assert.equal(text.includes(other), false,
        `第 ${left + 1} 折的增量里不该出现第 ${right + 1} 折的增量正文`);
    }
  }
});

// ---- 判据 3：夹断不影响增量（本单的核心价值断言）----------------------------------

test("#566-3 累计体被 2048 前缀夹断时，本折增量仍完整可读", async () => {
  const { folds } = await runFoldLlmChain({ runId: "566-truncate", toolTurns: 8 });
  assert.ok(folds.length >= 2, `前置：至少两折（实测 ${folds.length}）`);
  const truncated = folds.filter(({ facts }) => facts.truncated === true);
  assert.ok(truncated.length >= 1,
    `前置：累计体必须真的被夹断过（实测 ${JSON.stringify(folds.map(({ facts }) => ({ bytes: facts.bytes, truncated: facts.truncated })))}）`);

  for (const { round, facts } of truncated) {
    assert.ok(facts.bytes <= FOLDED_FACTS_MAX_BYTES,
      `第 ${round} 轮：累计体被夹到上界内（实测 ${facts.bytes}）`);
    assert.ok(facts.bytesBefore > FOLDED_FACTS_MAX_BYTES,
      `第 ${round} 轮：累计体的原始字节数可核对（实测 ${facts.bytesBefore}）`);
    const increment = incrementOf(facts);
    assert.ok(increment !== undefined,
      `第 ${round} 轮：累计体被夹断**不影响**增量存在（这是本单要买的东西）`);
    assert.equal(increment.truncated, undefined,
      `第 ${round} 轮：本折增量不该被累计体的夹断牵连（实测 truncated=${JSON.stringify(increment.truncated)}）`);
    assert.ok(increment.bytes <= FOLDED_FACTS_MAX_BYTES,
      `第 ${round} 轮：增量自己的上界也守住（实测 ${increment.bytes}）`);
    // 「完整可读」的硬证据：本折机械替代物的**全部**内容一个字符都不许少 ——
    // 区间行 + 本折每一轮的清单条目（夹具每轮一条 `exec … case-N`）+ 恢复提示。
    assert.match(increment.text, new RegExp(`第 ${increment.from}–${increment.to} 轮（共 ${increment.rounds} 轮）`, "u"),
      `第 ${round} 轮：增量的区间行必须完整`);
    for (let n = increment.from; n < increment.from + increment.rounds; n += 1) {
      assert.equal(increment.text.includes(`- exec npm test -- --grep case-${n}`), true,
        `第 ${round} 轮：增量必须完整列出本折第 ${n} 轮的清单条目（缺一条就是被夹断了）`);
    }
    assert.equal(increment.text.includes("需要原文请重读文件或查看持久笔记"), true,
      `第 ${round} 轮：增量的恢复提示必须完整`);
    assert.equal(increment.text.includes("[替代物已按字节上限夹断]"), false,
      `第 ${round} 轮：增量不是被夹断的那一份`);
  }

  // 对照：同一份账本里，**未**被夹断的那一折的累计体仍然完整（夹断只发生在累计侧，
  // 且两者现在是**两个写者**：父键是摘要器写的累计体，增量是引擎机械算的本折替代物）。
  const first = folds[0];
  assert.equal(first.facts.truncated, undefined, "前置：第 1 折的累计体还没被夹断");
  assert.equal(first.facts.text.includes("LLM_SUMMARY_1"), true,
    "第 1 折的累计体是摘要器写的（父键语义一字未改）");
  assert.equal(incrementOf(first.facts).text.includes("LLM_SUMMARY_1"), false,
    "第 1 折的增量是机械替代物（两个写者各说各的，互不冒充）");
});

// ---- 判据 5：模型可见面零变化 ----------------------------------------------------

/**
 * 宿主自带策略：把 `HOST_SUMMARY_<n>` prepend 进保留的那条消息（模型看得见），
 * 可选地同时报一条 `increment`（模型**不该**看得见的那一份）。
 */
function makeHostStrategy({ withIncrement }) {
  let folds = 0;
  return {
    name: "host-566",
    shouldCompact: (messages) => Array.isArray(messages) && messages.length > 2,
    async compact(messages) {
      folds += 1;
      const summary = `HOST_SUMMARY_${folds}`;
      // 折走除首条之外的全部轮，并把摘要 prepend 进**首条**（任务正文）—— 于是摘要确实是
      // 模型看得见的那一份（对照组），而增量只在账本里。
      const first = messages[0];
      const firstContent = Array.isArray(first?.content)
        ? first.content
        : [{ type: "text", text: String(first?.content ?? "") }];
      return {
        messages: [{
          ...first,
          content: [{ type: "text", text: summary }, ...firstContent],
        }],
        compacted: true,
        foldedRounds: messages.length - 1,
        tokensBefore: 0,
        tokensAfter: 0,
        foldedPayload: messages.slice(0, -1),
        foldedRoundRange: { from: 1, to: messages.length - 1 },
        foldSummary: {
          source: "host",
          text: summary,
          ...(withIncrement
            ? { increment: `HOST_INCREMENT_SENTINEL_${folds}` }
            : {}),
        },
      };
    },
  };
}

test("#566-5 增量不进请求组装：有增量 vs 无增量，请求消息流逐字相同", async () => {
  const script = [
    { content: [{ type: "tool_use", id: "c1", name: "exec", input: { command: "one" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "c2", name: "exec", input: { command: "two" } }], stopReason: "tool_use" },
    { content: [{ type: "tool_use", id: "c3", name: "exec", input: { command: "three" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
  ];
  const run = async ({ runId, withIncrement }) => {
    const store = createMemoryTranscriptStore();
    const provider = createFakeProvider(script);
    await runToolLoop(withSeed({
      capabilities: { ports: { strategy: makeHostStrategy({ withIncrement }) } },
      provider,
      executeTool: async ({ id }) => `tool output ${id} ${"z".repeat(300)}`,
      maxRounds: 6,
      completion: false,
      reflection: false,
      // 预算故意给得很大：这条路径要验的是「增量进不进请求」，不是预算兜底；
      // 小预算会触发 safety 截断把宿主摘要一起削掉，对照就没了。
      config: { folding: { context: { budgetTokens: 100_000, keepRounds: 0 } } },
      store,
      runId,
      seed: `start ${"y".repeat(600)}`,
    }));
    const records = await store.load(runId);
    const facts = records
      .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
      .map((record) => record[FOLDED_FACTS_RECORD_FIELD]);
    return { facts, requests: provider.requests };
  };

  const baseline = await run({ runId: "566-surface", withIncrement: false });
  const withIncrement = await run({ runId: "566-surface", withIncrement: true });
  assert.ok(baseline.facts.length >= 1, "前置：这条路径必须真的折过");
  assert.ok(withIncrement.facts.length >= 1, "前置：A/B 两侧折叠次数必须相同");

  // ① A/B 对拍：两次 run 的**请求消息流**逐字相同（同一份脚本、同一份种子、同一份 runId，
  //    唯一的差别是账本里有没有那条增量）⇒ 增量对模型可见面零影响。
  assert.deepEqual(
    withIncrement.requests.map((request) => request.messages),
    baseline.requests.map((request) => request.messages),
    "有增量的那次 run 的请求消息流必须与没有增量的那次逐字相同",
  );
  // ② 哨兵：增量里那条串**只在账本里**，请求里一次都不出现。
  assert.equal(JSON.stringify(withIncrement.requests).includes("HOST_INCREMENT_SENTINEL"), false,
    "增量正文不得进模型上下文（它在请求里出现一次都算泄漏）");
  assert.equal(JSON.stringify(withIncrement.requests).includes(FOLDED_FACTS_INCREMENT_KEY), false,
    "连键名都不该出现在请求里（增量不参与请求组装）");
  assert.equal(
    withIncrement.facts.some((facts) => String(incrementOf(facts)?.text ?? "").includes("HOST_INCREMENT_SENTINEL")),
    true,
    "前置：哨兵确实落在了账本增量里（否则上面那条「请求里没有」是空断言）",
  );
  // ③ 模型看得见的那一份没被牵连：宿主摘要仍按原样进上下文。
  assert.equal(JSON.stringify(withIncrement.requests).includes("HOST_SUMMARY_"), true,
    "前置：宿主摘要本来就是模型可见的（对照组）");
  // ④ 没有增量时报的增量 = 策略自带的那份正文（口径②：策略的 `text` 本来就只讲本折）。
  assert.equal(incrementOf(baseline.facts[0])?.text, "HOST_SUMMARY_1");
  assert.equal(incrementOf(withIncrement.facts[0])?.text, "HOST_INCREMENT_SENTINEL_1");
  assert.equal(incrementOf(baseline.facts[0])?.origin, "host", "宿主写的正文自报 host（#565 同一把尺子）");
});

// ---- 判据 6：账本体积有上界 ------------------------------------------------------

test("#566-6 每折增量 ≤ FOLDED_FACTS_MAX_BYTES ⇒ 100 折 ≈ 200 KB/会话", async () => {
  const { folds } = await runFoldLlmChain({ runId: "566-budget", toolTurns: 8 });
  assert.ok(folds.length >= 2, `前置：至少两折（实测 ${folds.length}）`);
  let total = 0;
  for (const { round, facts } of folds) {
    const increment = incrementOf(facts);
    assert.ok(increment !== undefined, `第 ${round} 轮必须落增量`);
    assert.ok(increment.bytes <= FOLDED_FACTS_MAX_BYTES,
      `第 ${round} 轮：每折增量必须 ≤ ${FOLDED_FACTS_MAX_BYTES}（实测 ${increment.bytes}）`);
    total += increment.bytes;
  }
  // 上界是**线性于折叠次数**的，不是线性于会话长度：100 折 × 2048 B ≈ 200 KB（写进 PR 描述）。
  assert.ok(total <= FOLDED_FACTS_MAX_BYTES * folds.length,
    `增量总量线性于折叠次数：实测 ${total} > ${FOLDED_FACTS_MAX_BYTES} × ${folds.length}`);
  assert.ok(total <= FOLDED_FACTS_MAX_BYTES * 100,
    "100 折的增量总量也必须落在 200 KB 这条口径内");
});
