// issue #464 A：库层折叠兜底的可观测性。
//
// 背景（票面事实，已复核）：`context.strategy` 未配置时，引擎库层在「超预算兜底」那一格直接
// `createSlidingWindowStrategy()`（`src/loop/orchestrator.js` 折叠入口），而该策略整轮丢头部、
// 既不调 `formatFoldSummary` 也不调 `extractAnchors` ⇒ 宿主侧看到 `compaction` 事件却看不出
// 「跑的是兜底策略、什么替代物都没留」。本文件锁住补齐后的两件事：
//   ① `compaction` 统计带 `strategyName`（写**实际执行者**，含兜底的 "sliding-window"）；
//   ② 未配置策略且兜底真的发生时，一次性 `compaction_strategy_fallback` 诊断事件。
// 判据形状对齐 issue #182 的 `model_metadata_missing`：恰好一条、detail 首句固定原文可断言。
import test from "node:test";
import assert from "node:assert/strict";

import { runDirect } from "./helpers/run-direct.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { groupIntoRounds } from "../src/messages/rounds.js";
import { estimateMessageTokens } from "../src/tokens.js";
import {
  COMPACTION_PIPELINE,
  getCompactionLayerForStrategy,
} from "../src/compact/pipeline.js";
import { FOLDED_FACTS_RECORD_FIELD } from "../src/compact/fold-summary-journal.js";

const EVENT_TYPE = "compaction_strategy_fallback";
// detail 首句是 issue #464 A 约定的固定原文（宿主可直接断言），预算之后才追加真值。
// issue #643：兜底的行为变了（折到够用就停 + 把机械摘要 prepend 进 head），首句跟着改——
// 旧句「drops whole head rounds without summary or anchors」已经不是事实（那正是本单修的病）。
const DETAIL_PREFIX = 'engine compaction fallback in effect: context.strategy is not configured, '
  + 'the library default "sliding-window" strategy folds only the oldest rounds needed '
  + 'to fit the budget and prepends a mechanical summary';

/** rounds 轮工具调用 + 一轮收尾文本；工具输出足够肥，稳定越过 budgetTokens。 */
function toolProvider(rounds) {
  return createFakeProvider([
    ...Array.from({ length: rounds }, (_, index) => ({
      content: [{
        type: "tool_use",
        id: `call-${index + 1}`,
        name: "work",
        // issue #608：入参逐轮不同。本文件的意图是「未配置 `context.strategy` + 预算兜底恰好发一条
        // 诊断并点名 fallback」，与「入参是否相同」无关；而**入参全同**（原来的 `{}`）在引擎眼里就是
        // 「模型在重读同一入参」，会撞上 #608 的循环判据（`budgetTokens=1584` 且每条结果 20k 字符
        // ⇒ 工作集 > 预算 ∧ streak ≥ 2 连续 5 次 ⇒ 明确收尾），于是本夹具测的东西被另一条判据抢先收口。
        // 断言一个字节都没动（见本文件下半部分）。
        input: { i: index + 1 },
      }],
      stopReason: "tool_use",
    })),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
}

async function run(options = {}) {
  const events = [];
  // #498 S3（`metadata` A8）：扁平 `modelMetadata` 已退役，预算元数据的写点是
  // `config.metadata.modelMetadata`（展开相写回 `effectiveOptions.modelMetadata`，
  // `modelMetadataFor` 的读侧一字未动）。调用方仍可传自己的 `config`（例如
  // `config.folding.context.strategy`），这里**并进同一个容器**——第二个 `config` 键会静默盖掉
  // 前一个，那会让「配了策略」的两格悄悄丢掉预算元数据（压缩整体不进，断言全绿而判据失效）。
  const { config, ...rest } = options;
  const store = createMemoryTranscriptStore();
  const result = await runDirect({
    provider: toolProvider(8),
    initialUserMessage: "start",
    // 小窗口 → budgetTokens = 4096 - 512 - max(2000, 410) = 1584，20k 字符的工具输出必超预算。
    config: { metadata: { modelMetadata: { contextWindowTokens: 4096, maxOutputTokens: 512 } }, ...config },
    executeTool: async () => "y".repeat(20000),
    maxRounds: 10,
    completion: false,
    store,
    runId: "464-fallback",
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
    ...rest,
  });
  return {
    result,
    events,
    store,
    // issue #657：三个写点的另外两处（`foldedFacts` / `foldedSummary` 事实行）只在账本里，
    // 不在事件面上 ⇒ 判据要能把轮记录读出来对账。
    records: await store.load(rest.runId ?? "464-fallback"),
    compactions: events.filter((event) => event.type === "compaction"),
    notices: events.filter((event) => event.type === EVENT_TYPE),
  };
}


test("unconfigured context.strategy + budget fallback emits exactly one diagnostic and names the fallback (issue #464 A)", async () => {
  const { result, compactions, notices } = await run();

  assert.equal(result.finalText, "done");
  assert.ok(compactions.length >= 1, "预算兜底必须真的触发折叠，否则本用例无从对照");
  // 补齐前这里全是空白：事件面说不出「跑的是引擎库层兜底」。
  assert.equal(notices.length, 1, "一个 run 只允许一条兜底诊断事件");
  assert.equal(notices[0].type, EVENT_TYPE);
  assert.equal(notices[0].runId, "464-fallback");
  assert.ok(
    notices[0].detail.startsWith(DETAIL_PREFIX),
    `detail 首句必须是固定原文，实得：${notices[0].detail}`,
  );
  // 能解析出预算时如实报数（宿主据此判断自己的装配是否把折叠量推到了极端）。
  assert.match(notices[0].detail, /budgetTokens=1584/u);
  assert.match(notices[0].detail, /estimatedTokens=\d+/u);
  // ①：strategyName 写的是真正执行折叠的实例名，兜底那一格就是 "sliding-window"。
  for (const event of compactions) {
    assert.equal(event.compaction.strategyName, "sliding-window");
  }
});

test("configured strategy suppresses the diagnostic; strategyName names whoever really folded (issue #464 A, #657)", async () => {
  const { compactions, notices } = await run({
    runId: "464-configured",
    config: { folding: { context: { strategy: "fold-statistical" } } },
  });

  assert.ok(compactions.length >= 1, "配置策略也必须真的折叠");
  assert.equal(notices.length, 0, "配了 context.strategy 就不存在兜底，不得发诊断事件");
  // issue #657：这一格只改**期望值**，本用例的意图（「配了策略 ⇒ 不发兜底诊断事件」）一个字都没动。
  // 改前那半句写的是 `strategyName === "fold-statistical"`，而它钉的正是本单要修的撒谎字段：
  // 本夹具（8 轮 × 20k 字符工具输出、`budgetTokens=1584`）实测 8/8 次都是
  // `layers.foldStatistical.triggered === 0` / `layers.slidingWindow.triggered === 1`
  // —— 配置的 `fold-statistical` **一轮都没折**（`selectFoldedRounds` 的
  // `target = rounds.length - keepRounds` 在「轮数少、keepRounds 收紧」时等于 0，连摘要器都不调），
  // 真正折走那一轮的是引擎在预算兜底里**另建实例**的库层 `sliding-window`。
  // 按 #657 的真值表（配置策略折 0 轮 + 兜底折了 ≥1 轮 ⇒ 写兜底实例名），这里如实写 "sliding-window"；
  // 而 `layers` 那一列本来就说真话，两者现在必须互相对得上（见下面那条交叉锁用例）。
  for (const event of compactions) {
    assert.equal(event.compaction.strategyName, "sliding-window",
      "配置策略折 0 轮、兜底真折 ⇒ 账上必须写兜底实例名，不是配置名（#657 真值表第 3 行）");
    assert.ok(event.compaction.layers.slidingWindow.triggered >= 1,
      "前置：这一格确实是兜底干的活");
    assert.equal(event.compaction.layers.foldStatistical.triggered, 0,
      "前置：配置的 fold-statistical 一轮都没折");
  }
});

test("the fallback notice is run-scoped: repeated folds share one, a second run gets its own (issue #464 A)", async () => {
  const first = await run({ runId: "464-run-a" });
  const second = await run({ runId: "464-run-b" });

  assert.equal(first.notices.length, 1);
  assert.equal(second.notices.length, 1);
  assert.equal(second.notices[0].runId, "464-run-b");
  // 去重是 run 作用域：同一 run 内即便折叠多次（轮次持续增长 ⇒ 每次都从头重折），也只有一条。
  assert.ok(
    first.compactions.length >= 1
      && first.notices.length < first.compactions.length + 1,
    "诊断事件不得随折叠次数线性增长",
  );
});

test("hosts that ignore the additive keys still see the previous compaction shape (issue #464 A)", async () => {
  const { compactions } = await run({ runId: "464-shape" });
  const { compactions: configured } = await run({
    runId: "464-shape-configured",
    config: { folding: { context: { strategy: "fold-statistical" } } },
  });

  for (const event of [...compactions, ...configured]) {
    // 既有键一字未动：这四键是 #460/#315 之后 state.json 与宿主横幅共同读的。
    for (const key of ["compacted", "foldedRounds", "tokensBefore", "tokensAfter"]) {
      assert.ok(Object.hasOwn(event.compaction, key), `缺既有键 ${key}`);
    }
    assert.deepEqual(
      Object.keys(event.compaction).filter((key) => !["strategyName"].includes(key)).sort(),
      Object.keys(event.compaction).filter((key) => key !== "strategyName").sort(),
    );
  }
});

// ============================================================================================
// issue #657（缺陷一）：`strategyName` 必须写**真正干了这一折活的那一层**。
//
// 折叠入口里有两个可能的执行者（`src/loop/orchestrator.js`）：入口选中的 `strategy`，以及策略
// 折完仍超预算时**另建实例**的预算兜底 `createSlidingWindowStrategy()`。改前四个写点读的都是
// `typeof strategy?.name`（= 入口选了谁），而兜底从不回写它 ⇒ 「配置策略折 0 轮、兜底真折」
// 那一格里三处账（`compactionStats[].strategyName` / `record.foldedFacts.strategy` /
// `record.foldedSummary.strategy`）一起把功劳记给了没动手的那一个。
//
// 真值表（`src/loop/orchestrator.js` 的 `actualFolderName` 那处注释是权威副本）：
//   ① 配置策略折了 ≥1 轮              ⇒ 配置名（不管兜底随后折没折）
//   ② 配置策略折 0 轮 + 兜底折了 ≥1 轮 ⇒ 兜底实例名（"sliding-window"）
//   ③ 未配策略（入口那一发就是库层兜底）⇒ "sliding-window"（本来就如实，不变）
//   ④ 谁都没折                        ⇒ 不写这个键（「无事实 ⇒ 无键」）
//
// 下面每一格都同时读**事件面**与**账本面**：三处写点里有两处只在账本里，只测事件会漏。
// ============================================================================================

/** 摘要器 + 工具轮混合的 fake provider：摘要请求走 `## 阶段` 那一路，其余按脚本发工具调用。 */
function summaryProvider({ toolTurns, summaryBytes }) {
  let turns = 0;
  let summaries = 0;
  const provider = {
    protocol: "fake",
    model: "fake-model",
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes("你是对话历史压缩器")) {
        summaries += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nLLM_SUMMARY_${summaries}\n${"s".repeat(summaryBytes)}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      if (turns < toolTurns) {
        turns += 1;
        return {
          content: [{ type: "tool_use", id: `tu_${turns}`, name: "exec", input: { command: `c${turns}` } }],
          stopReason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  provider.chatStream = provider.chat;
  provider.summaryCalls = () => summaries;
  return provider;
}

/**
 * 一条 `fold-llm` 折叠链（`keepRounds` / `foldAtRatio` 可调），返回事件面 + 账本面。
 *
 * ⚠ 全部用**规位拼写**（`config.run.*` / `config.folding.context.*`）：本文件不许新增扁平写点，
 * 否则 `test/compat-pin-inventory.md` 会漂（那张表没有手改的余地，只能 `--sync`）。
 */
async function runFoldLlmChain({
  runId,
  budgetTokens = 900,
  keepRounds = 1,
  foldAtRatio = 0.5,
  toolTurns = 6,
  toolBytes = 1200,
  seedBytes = 300,
  summaryBytes = 2000,
}) {
  const events = [];
  const store = createMemoryTranscriptStore();
  const provider = summaryProvider({ toolTurns, summaryBytes });
  const result = await runDirect({
    provider,
    seed: `start ${"y".repeat(seedBytes)}`,
    executeTool: async ({ id }) => `out ${id} ${"z".repeat(toolBytes)}`,
    config: {
      run: { maxRounds: 12, completion: false, reflection: false },
      folding: { context: { budgetTokens, keepRounds, foldAtRatio, strategy: "fold-llm" } },
    },
    store,
    runId,
    capabilities: { hooks: { onEvent: (event) => events.push(event) } },
  });
  const records = await store.load(runId);
  return {
    result,
    provider,
    compactions: events.filter((event) => event.type === "compaction"),
    notices: events.filter((event) => event.type === EVENT_TYPE),
    facts: records
      .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
      .map((record) => record[FOLDED_FACTS_RECORD_FIELD]),
    summaryFacts: records
      .filter((record) => record?.foldedSummary !== undefined)
      .map((record) => record.foldedSummary),
  };
}

/**
 * 宿主**自带的**折叠策略对象（#657 真值表第一行的「宿主对象」半边）。
 *
 * 与内置策略的关键区别是**它不在 `COMPACTION_PIPELINE` 里**：`name` 是宿主自己起的
 * （`"host-strategy"`），`getCompactionLayerForStrategy` 的映射表认不出它 ⇒ 这一折在 `layers` 上
 * 不留任何痕迹（`observeCompactionLayer` 只在选中层存在时被调）。于是「它到底干没干活」只能靠
 * `foldedRounds` / `compacted` 这两个字段自证——这正是交叉锁要分两支的原因。
 *
 * 它**真的干活**：`compact` 折走最老的一轮（`foldedRounds: 1`），返回形状照
 * `src/compact/sliding-window.js`（`messages` / `compacted` / `foldedRounds` / `foldedPayload` /
 * `foldedRoundRange` / `tokensBefore` / `tokensAfter`），所以它走的确实是引擎的**策略**那条主路
 * （而不是只被调一下就原样返回）。
 */
function createHostStrategy() {
  const calls = { shouldCompact: 0, compact: 0, foldedRounds: 0 };
  return {
    name: "host-strategy",
    calls,
    async shouldCompact() {
      calls.shouldCompact += 1;
      return true;
    },
    async compact(messages, options = {}) {
      calls.compact += 1;
      const tokensBefore = estimateMessageTokens(messages);
      // `roundOffset` 是引擎给的水位线（第二次折叠起非零），口径与 sliding-window 的
      // `roundRangeForIndexes` 一致：区间号是**会话里**的轮号，不是本次可折列表的下标。
      const offset = Number.isSafeInteger(options.roundOffset) ? options.roundOffset : 0;
      const { head, rounds } = groupIntoRounds(messages);
      if (rounds.length === 0) {
        // 没有可折的轮次 ⇒ 如实报 0（本夹具的第一发就是这一种：策略被问了、但还没有轮次可折）。
        return {
          messages,
          compacted: false,
          foldedRounds: 0,
          foldedPayload: [],
          tokensBefore,
          tokensAfter: tokensBefore,
        };
      }
      const folded = rounds.slice(0, 1);
      const retained = rounds.slice(1);
      // 归档那一份与内存那一份分开（浅拷贝一层，同 sliding-window 的 `cloneFoldPayload` 口径）。
      const foldedPayload = folded
        .flatMap((round) => round.messages)
        .map((message) => ({ ...message }));
      calls.foldedRounds += folded.length;
      const compactedMessages = [...head, ...retained.flatMap((round) => round.messages)];
      return {
        messages: compactedMessages,
        compacted: true,
        foldedRounds: folded.length,
        foldedPayload,
        foldedRoundRange: { from: offset + 1, to: offset + folded.length },
        tokensBefore,
        tokensAfter: estimateMessageTokens(compactedMessages),
      };
    },
  };
}

/**
 * 一条「宿主自带策略对象」的折叠链：事件面 + 账本面（夹具形状照 `runFoldLlmChain`）。
 *
 * 策略对象走 `capabilities.ports.strategy` —— 这是**唯一**的规位：配置面只装数据（那棵子树要能过
 * JSON 往返），`config.folding.context.strategy` 里塞函数会被名称闸口当场拒（实测文案
 * `config.folding.context.strategy.shouldCompact is not accepted`）。
 */
async function runHostStrategyChain({
  runId,
  budgetTokens = 1200,
  toolTurns = 6,
  toolBytes = 9000,
  seedBytes = 200,
}) {
  const events = [];
  const store = createMemoryTranscriptStore();
  const provider = summaryProvider({ toolTurns, summaryBytes: 400 });
  const hostStrategy = createHostStrategy();
  const result = await runDirect({
    provider,
    seed: `start ${"y".repeat(seedBytes)}`,
    executeTool: async ({ id }) => `out ${id} ${"z".repeat(toolBytes)}`,
    config: {
      run: { maxRounds: 12, completion: false, reflection: false },
      // 宿主策略自己决定折几轮，`keepRounds` 对它没有约束 ⇒ 这里只给触发折叠所需的两个数。
      folding: { context: { budgetTokens, foldAtRatio: 1 } },
    },
    capabilities: {
      ports: { strategy: hostStrategy },
      hooks: { onEvent: (event) => events.push(event) },
    },
    store,
    runId,
  });
  const records = await store.load(runId);
  return {
    result,
    provider,
    // ⚠ 返回值上的这个键**故意**叫 `hostStrategy` 而不是 `strategy`：`scripts/flat-count-inventory.mjs`
    // 数的是 `test/**` 里出现的属性名，`strategy` 是它认的兼容钉子键之一（口径是「属性写法的名字」，
    // 分不清「选项写点」和「普通对象键」）⇒ 叫 `strategy` 会让 `test/compat-pin-inventory.md` 凭空
    // 多一个与兼容性无关的写点。这里不是在绕开计数器，而是不给那张表添噪声。
    hostStrategy,
    compactions: events.filter((event) => event.type === "compaction"),
    notices: events.filter((event) => event.type === EVENT_TYPE),
    facts: records
      .filter((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined)
      .map((record) => record[FOLDED_FACTS_RECORD_FIELD]),
  };
}

test("#657 缺失的那一格：配置策略折 0 轮 + 预算兜底真折 ⇒ 三处账都写兜底实例名，且不发兜底诊断事件", async () => {
  // 这一格此前**零测试覆盖**（#464 A 的四格只覆盖「未配置策略」与「配了策略」两种入口状态，
  // 而「配了策略但它一轮都没折」是第三种：入口有策略、干活的却是兜底）。
  const { compactions, notices, facts, summaryFacts, provider } = await runFoldLlmChain({
    runId: "657-missing-cell",
    // 本格要的就是「配置策略折 0 轮」：预算充裕到收紧后的 keepRounds 把可折轮次压成 0，
    // 而 `foldAtRatio` 让它仍然请求折叠 ⇒ 策略跑了一发、一轮没折，兜底接手。
    budgetTokens: 1200,
    keepRounds: 6,
    foldAtRatio: 1,
    toolTurns: 4,
    toolBytes: 9000,
    seedBytes: 200,
    summaryBytes: 400,
  });

  assert.ok(compactions.length >= 1, "前置：预算兜底必须真的折过，否则本格无从对照");
  assert.equal(provider.summaryCalls(), 0, "前置：配置的 fold-llm 一次摘要器都没调（它一轮都没折）");
  assert.ok(facts.length >= 1, "前置：账本里必须有折叠轮记录");
  assert.ok(summaryFacts.length >= 1, "前置：账本里必须有 foldedSummary 事实行");

  // ① 事件面（= `<runId>.state.json` 的 `deterministic.compactionStats`，同一个白名单）。
  for (const event of compactions) {
    assert.equal(event.compaction.strategyName, "sliding-window",
      "写兜底实例名（真值表第 2 行），不是配置的 fold-llm");
    assert.ok(event.compaction.layers.slidingWindow.triggered >= 1,
      "前置：这一格确实是兜底干的活");
    assert.equal(event.compaction.layers.foldLlm.triggered, 0,
      "前置：配置策略一层都没触发");
  }
  // ② 账本面：轮记录 `foldedFacts.strategy`。
  for (const entry of facts) {
    assert.equal(entry.strategy, "sliding-window",
      "`record.foldedFacts.strategy` 与事件面同一个真值（改前它报的是配置名）");
  }
  // ③ 账本面：引擎事实行 `foldedSummary.strategy`（票面未列，同一根因）。
  for (const fact of summaryFacts) {
    assert.equal(fact.strategy, "sliding-window",
      "`record.foldedSummary.strategy` 与事件面同一个真值（改前它报的是配置名）");
  }
  // ④ 语义护栏：`compaction_strategy_fallback` 只覆盖「**没配**策略」那一格，本格配了策略 ⇒ 零事件。
  assert.equal(notices.length, 0,
    "配了 context.strategy 就不发兜底诊断事件——这条语义本单一个字都没动");
});

test("#657 真值表前两行：配置策略真的折了 ⇒ 仍写配置名（兜底随后也折了也一样）", async () => {
  // 行 1：配置策略折了、兜底没折。
  const rowOne = await runFoldLlmChain({
    runId: "657-row-one",
    budgetTokens: 1200,
    keepRounds: 0,
    foldAtRatio: 1,
    toolTurns: 4,
    toolBytes: 9000,
    seedBytes: 200,
    summaryBytes: 400,
  });
  assert.ok(rowOne.compactions.length >= 1, "前置：这一格必须真的折叠");
  assert.ok(rowOne.provider.summaryCalls() >= 1, "前置：配置的 fold-llm 真的跑了摘要器（它折了）");
  for (const event of rowOne.compactions) {
    assert.ok(event.compaction.layers.foldLlm.triggered >= 1, "前置：配置策略那一层真的触发过");
    assert.equal(event.compaction.strategyName, "fold-llm",
      "配置策略做了它那份 ⇒ 写配置名（真值表第 1 行，改前改后都必须是这样）");
  }

  // 行 2：配置策略折了，**而且**兜底随后也折了（同一个 stat 上两个 budget 相层都 triggered）。
  const rowTwo = await runFoldLlmChain({
    runId: "657-row-two",
    budgetTokens: 900,
    keepRounds: 1,
    foldAtRatio: 0.5,
    toolTurns: 6,
    toolBytes: 1200,
    seedBytes: 300,
    summaryBytes: 2000,
  });
  const both = rowTwo.compactions
    .map((event) => event.compaction)
    .filter((stat) => stat.layers.foldLlm.triggered > 0 && stat.layers.slidingWindow.triggered > 0);
  assert.ok(both.length >= 1,
    `前置：必须有「两层都折」的那一格（实测 ${JSON.stringify(rowTwo.compactions.map((event) => ({
      name: event.compaction.strategyName,
      llm: event.compaction.layers.foldLlm.triggered,
      sw: event.compaction.layers.slidingWindow.triggered,
    })))}）`);
  for (const stat of both) {
    assert.equal(stat.strategyName, "fold-llm",
      "兜底随后也折了**不许**抢走配置策略的名字（真值表第 2 行）");
    assert.ok(stat.foldedRounds >= 2, "前置：这一折确实折了两轮以上（两层各折了一部分）");
  }
});

test("#657 真值表第一行的宿主对象半边：宿主自带策略真的折了 ⇒ 账上写它自己的名字", async () => {
  // 为什么要有这一格（#657 落地的覆盖缺口）：真值表第 1 行原先只有**内置** `fold-llm` 证过，
  // 而 #657 把两处夹具的期望值从 `"spy-strategy"` / `"port-strategy"` 改成「键不存在」（它们确实
  // 一轮没折，改得对）之后，**没有任何一条用例证明「宿主自带策略对象真的折了 ⇒ 写它自己的名字」**
  // ——「把断言改掉之后覆盖悄悄丢了」那一类。本格就是那一半。
  const { compactions, notices, facts, provider, hostStrategy } = await runHostStrategyChain({
    runId: "657-host-strategy",
  });

  // 前置①：干活的必须是**宿主对象自己**（不是内置策略、也不是兜底）。
  assert.ok(hostStrategy.calls.compact >= 1, "前置：宿主的 compact 真被调");
  assert.ok(hostStrategy.calls.foldedRounds >= 1, "前置：宿主对象真的折走了 ≥1 轮");
  assert.equal(provider.summaryCalls(), 0, "前置：本格与内置 fold-llm 无关（摘要器零调用）");
  assert.equal(notices.length, 0, "配了策略（哪怕是宿主对象）就不存在兜底，不得发诊断事件");
  assert.ok(compactions.length >= 1, "前置：必须有 compaction 统计");

  // ① 事件面：写的是**宿主自己的名字**，不是兜底实例名、也不是空键。
  const folded = compactions
    .map((event) => event.compaction)
    .filter((stat) => stat.foldedRounds > 0);
  assert.ok(folded.length >= 1, "前置：必须有「宿主对象真折了」的那一格");
  for (const stat of folded) {
    assert.equal(stat.strategyName, "host-strategy",
      "宿主对象折了 ≥1 轮 ⇒ 写它自己的名字（真值表第 1 行；改前这里也对，但只被内置 fold-llm 证过）");
    assert.equal(stat.compacted, true,
      "前置：compacted 与 foldedRounds 同向——宿主对象没有 `layers` 可对，这两个字段是它唯一的自证");
  }

  // ② 账本面：轮记录 `foldedFacts.strategy` 与事件面同一个真值（这一处在改前是四个写点里的一个）。
  assert.ok(facts.length >= 1, "前置：账本里必须有折叠轮记录");
  for (const entry of facts) {
    assert.equal(entry.strategy, "host-strategy",
      "`record.foldedFacts.strategy` 也必须写宿主自己的名字（同一份 `actualFolderName`）");
    assert.ok(entry.rounds >= 1, "前置：这条事实行确实记了折过的轮次");
  }

  // ③ 反向（本格咬人的锚点）：策略被问了、但还没有轮次可折的那一发必须**不写**这个键。
  // 这一行就是反向证的对象：把 `actualFolderName` 的最后一支改回 `strategy.name`（= 改前「写入口
  // 选中谁」的写法），这一发会拿到一个一次都没折过的入口名 ⇒ 本断言红。
  const idle = compactions
    .map((event) => event.compaction)
    .filter((stat) => stat.foldedRounds === 0);
  assert.ok(idle.length >= 1, "前置：必须有「策略被问了、但还没有轮次可折」的那一发");
  for (const stat of idle) {
    assert.equal(Object.hasOwn(stat, "strategyName"), false,
      "宿主对象一轮没折 ⇒ 同样无键（真值表第 4 行不区分内置/宿主）");
  }
});

test("#657 真值表第 4 行：谁都没折 ⇒ 不写 strategyName 这个键（不是写入口选中的名字）", async () => {
  // 现场：配置的 fold-llm 请求了折叠但一轮都没折（keepRounds 收紧到可折轮次为 0），而折完
  // 仍装得进预算 ⇒ 兜底也不动。改前这一格写的是 `"fold-llm"`——一个**一次都没折过**的策略名。
  const { compactions } = await runFoldLlmChain({
    runId: "657-nobody-folded",
    budgetTokens: 600,
    keepRounds: 1,
    foldAtRatio: 0.5,
    toolTurns: 6,
    toolBytes: 800,
    seedBytes: 300,
    summaryBytes: 1300,
  });
  const idle = compactions
    .map((event) => event.compaction)
    .filter((stat) => stat.foldedRounds === 0);
  assert.ok(idle.length >= 1, "前置：必须有「请求了折叠但一轮没折」的那一格");
  for (const stat of idle) {
    assert.equal(Object.hasOwn(stat, "strategyName"), false,
      "谁都没折 ⇒ 无键（「无事实 ⇒ 无键」，与 userTurnGuard / foldSummary 同口径）");
    assert.equal(stat.layers.slidingWindow.triggered, 0, "前置：兜底也没折");
    assert.equal(stat.layers.foldLlm.triggered, 0, "前置：配置策略也没折");
  }
});

test("#657 交叉锁：`strategyName` 必须与同一条 stat 上 `layers` 里 budget 相层对得上（本单真正防复发的东西）", async () => {
  // 为什么这一条才防复发：两个字段**现在就在同一条 stat 上**，一个说真话（`layers` 由
  // `observeCompactionLayer` 按实际调用记）一个说假话（`strategyName` 由入口常量填），
  // 而在此之前**没有任何用例把它们对照过**——8 次折叠里 8 次 `foldStatistical.triggered=0` /
  // `slidingWindow.triggered=1`，断言却写着 `strategyName === "fold-statistical"`，全绿。
  const BUDGET_LAYERS = COMPACTION_PIPELINE.filter((definition) => definition.phase === "budget");
  const layerIdForName = (name) => getCompactionLayerForStrategy({ name })?.id;
  const check = (label, stats) => {
    assert.ok(stats.length >= 1, `${label}：前置，必须有 compaction 统计`);
    for (const [index, stat] of stats.entries()) {
      const triggeredBudgetLayers = BUDGET_LAYERS
        .filter((definition) => stat.layers[definition.id].triggered > 0)
        .map((definition) => definition.id);
      const where = `${label} stat[${index}]（strategyName=${JSON.stringify(stat.strategyName)}、`
        + `foldedRounds=${stat.foldedRounds}、triggered=${JSON.stringify(triggeredBudgetLayers)}）`;
      if (stat.strategyName === undefined) {
        // 反向：没有名字 ⇒ 没有任何 budget 相层折过（否则就是「干了活却不留名」）。
        assert.deepEqual(triggeredBudgetLayers, [], `${where}：无 strategyName 却有 budget 相层触发过`);
        assert.equal(stat.foldedRounds, 0, `${where}：无 strategyName 却折了轮次`);
        continue;
      }
      // 正向：写出来的名字必须指向一个**真的触发过**的 budget 相层。
      //
      // issue #657（宿主对象那一半）：这条口径只对**内置折叠策略名**成立。`getCompactionLayerForStrategy`
      // 的表是从 `COMPACTION_PIPELINE[].strategyNames` 现推的，里面只有内置名；而宿主自带的策略对象
      // （`capabilities.ports.strategy`，`name` 由宿主自己起）**在 `layers` 里没有对应层**——
      // `observeCompactionLayer` 只在选中层存在时被调，引擎也不会替一个它不认识的策略造层。
      // 所以分两支，而不是为了让用例绿就删掉这一块：
      //   · 内置名 ⇒ 继续要求它点名的那一层 `triggered > 0`（原来的锁，一个字没松）；
      //   · 非内置名 ⇒ 它只能是宿主自己的策略对象（`actualFolderName` 的来源只有四种：`undefined`、
      //     内置实例名、兜底实例名 `"sliding-window"`、以及宿主对象的 `name`），改要求
      //     `foldedRounds > 0` **且** `compacted === true`——没有 `layers` 可对时，这两个字段就是
      //     它唯一能自证「真干了这一折活」的证据（宿主对象的那一格见下面第五格）。
      const namedLayer = layerIdForName(stat.strategyName);
      if (namedLayer === undefined) {
        assert.ok(stat.foldedRounds > 0,
          `${where}：非内置名（宿主自带策略，layers 里没有它的层）却一轮都没折 ⇒ 账本在说假话`);
        assert.equal(stat.compacted, true,
          `${where}：非内置名却没 compacted ⇒ 「写了名字」与「真折了」对不上`);
        continue;
      }
      assert.ok(stat.layers[namedLayer].triggered > 0,
        `${where}：strategyName 点名的那一层一次都没触发 ⇒ 账本在说假话（#657 缺陷一）`);
      assert.ok(triggeredBudgetLayers.length > 0, `${where}：写了名字却没有任何 budget 相层触发过`);
    }
  };

  // 五格覆盖真值表的四行 × 两种策略来源：未配置（入口兜底）/ 配置折 0 + 兜底折 / 配置真折 /
  // 两层都折 / 宿主自带对象真折（它没有层可对，走的是非内置名那一支）。
  const unconfigured = await run({ runId: "657-lock-unconfigured" });
  check("未配置策略", unconfigured.compactions.map((event) => event.compaction));
  check("配置折 0 + 兜底折", (await runFoldLlmChain({
    runId: "657-lock-missing-cell", budgetTokens: 1200, keepRounds: 6, foldAtRatio: 1,
    toolTurns: 4, toolBytes: 9000, seedBytes: 200, summaryBytes: 400,
  })).compactions.map((event) => event.compaction));
  check("配置真折", (await runFoldLlmChain({
    runId: "657-lock-row-one", budgetTokens: 1200, keepRounds: 0, foldAtRatio: 1,
    toolTurns: 4, toolBytes: 9000, seedBytes: 200, summaryBytes: 400,
  })).compactions.map((event) => event.compaction));
  check("两层都折 / 谁都没折", (await runFoldLlmChain({
    runId: "657-lock-row-two", budgetTokens: 900, keepRounds: 1, foldAtRatio: 0.5,
    toolTurns: 6, toolBytes: 1200, seedBytes: 300, summaryBytes: 2000,
  })).compactions.map((event) => event.compaction));
  // 宿主自带策略对象：它折了 ≥1 轮、名字也是它自己的，但 `layers` 里**没有任何层**能对得上。
  check("宿主自带策略真折", (await runHostStrategyChain({
    runId: "657-lock-host-strategy",
  })).compactions.map((event) => event.compaction));
});
