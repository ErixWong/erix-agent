// issue #326（wo-C）：**实际喂给模型的折叠/降级结果必须成为账本里的事实，并且复用不重算**。
//
// 基线探针（`a3689a2` + fake provider + 内置 store，零真实 LLM 调用；
// `scripts/tmp-probe-wo-c.mjs`，输出存 `/tmp/baseline-probe.txt`）实测：
//   - fold-llm 摘要：run1 里 **2 次** summarizer 调用、摘要进了当次真实请求（模型看见），
//     但 `store.load()` 的原始记录里 **0 条**；
//   - 进程恢复（resume）时 **又调了 3 次 summarizer**，得到一份**不同的**摘要（V2/V3）；
//   - TTL 降级：请求视图里带 `【已折叠·TTL】` 占位（模型看见），`store.load()` 里 **0 条**，
//     账本只剩 `compactionStats.layers.ttl.triggered` 这个**计数**（「被降级成了什么」不可指认）。
//
// 判据口径：一律数 `store.load()` 返回的原始记录，不看事件流、不看返回值；
// 「有没有重算」用 **summarizer 调用次数** 与 **摘要文本版本号** 两个可测代理。
import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { makeTmp } from "./helpers/tmp.js";

const SUMMARY_SYSTEM = "你是对话历史压缩器";

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => (block?.type === "tool_result"
    ? String(block.content ?? "")
    : block?.type === "text" ? String(block.text ?? "") : "")).join("\n")
  : String(message?.content ?? ""));

const messagesOf = (records) => records.flatMap((record) => record.messages ?? []);
const countTextIn = (messages, needle) => messages.filter((message) => (
  textOf(message).includes(needle)
)).length;

/**
 * 双通道 fake provider：主循环脚本 + fold-llm 默认 summarizer（按 system 前缀识别）。
 * 每次摘要返回**带版本号**的文本，于是「重算」在断言里看得见（V1 vs V2）。
 */
function createProvider({ mainScript }) {
  const summaryRequests = [];
  const mainRequests = [];
  let mainIndex = 0;
  let summaryIndex = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    summaryRequests,
    mainRequests,
    get summaryCalls() {
      return summaryIndex;
    },
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryRequests.push(request);
        summaryIndex += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nSUMMARY_V${summaryIndex}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      if (step && Object.prototype.hasOwnProperty.call(step, "throw")) {
        throw step.throw;
      }
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { path: `src/${id}.js` } });
const toolTurn = (id) => ({ content: [toolUse(id)], stopReason: "tool_use" });
const endTurn = (value) => ({ content: [{ type: "text", text: value }], stopReason: "end_turn" });

const foldContext = { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" };
const bigToolOutput = (id) => `tool output for ${id} ${"z".repeat(400)}`;

const foldRunOptions = (runId, store, provider, extra = {}) => ({
  provider,
  executeTool: async ({ id }) => bigToolOutput(id),
  maxRounds: 2,
  completion: false,
  reflection: false,
  context: foldContext,
  store,
  runId,
  ...extra,
});

test("#326-C fold-llm 摘要：实际喂出去的那份在 store.load() 里读得到（memory store）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({ mainScript: [toolTurn("a"), endTurn("收尾结论")] });
  await runToolLoop(foldRunOptions("326c-fold", store, provider, {
    initialUserMessage: `start ${"y".repeat(600)}`,
  }));

  // 前置：这真的发生过一次折叠摘要，且它进了当次真实请求（否则下面「读得到」是空断言）。
  assert.equal(provider.summaryCalls, 1, "本用例必须真的触发一次 fold-llm 摘要");
  assert.ok(
    provider.mainRequests.some((request) => request.messages.some((message) => textOf(message).includes("SUMMARY_V1"))),
    "摘要必须进过主模型上下文",
  );

  const records = await store.load("326c-fold");
  const journaled = records.filter((record) => (
    typeof record?.foldedSummary?.text === "string" && record.foldedSummary.text.includes("SUMMARY_V1")
  ));
  assert.equal(journaled.length, 1,
    `折叠摘要必须在 store.load() 里恰有一条（实测 ${JSON.stringify(records.map((record) => record.dedupKey ?? record.roundKey))}）`);
  assert.equal(countTextIn(messagesOf(records), "SUMMARY_V1"), 0,
    "折叠摘要走独立事实字段，不得被塞进 messages 当正文（否则宿主会当重复正文渲染）");
});

test("#326-C fold-llm 摘要：file store（真落盘 JSONL）里也读得到，且带可指认的折叠身份", async () => {
  const dir = await makeTmp("erix-326c-fold-file-");
  const store = createFileTranscriptStore({ dir });
  const provider = createProvider({ mainScript: [toolTurn("a"), endTurn("收尾结论")] });
  await runToolLoop(foldRunOptions("326c-fold-file", store, provider, {
    initialUserMessage: `start ${"y".repeat(600)}`,
  }));

  const records = await store.load("326c-fold-file");
  const entry = records.find((record) => typeof record?.foldedSummary?.text === "string");
  assert.ok(entry !== undefined, "真落盘的 transcript 必须含折叠摘要事实");
  assert.match(entry.foldedSummary.text, /SUMMARY_V1/u);
  assert.equal(entry.folded, undefined, "事实行不占用 `folded`：那个键的既有含义是「本条轮记录所在的轮被折过」");
  assert.equal(entry.foldedRoundRange, undefined,
    "事实行不放顶层 foldedRoundRange：resume 的 foldedThrough 按这个键统计，重复一份会把同一区间数两遍");
  assert.deepEqual(entry.foldedSummary.foldedRoundRange, { from: 1, to: 1 }, "「覆盖了哪些轮」在事实体里说清");
  assert.equal(typeof entry.foldedSummary.fingerprint, "string", "必须带复用键（fingerprint）");
  assert.match(entry.foldedSummary.fingerprint, /^sha256:[0-9a-f]{12,}$/u);
  assert.equal(typeof entry.foldedSummary.strategy, "string");
});

test("#326-C 复用不重算：折叠后中断，resume 不再调 summarizer，用的就是已入账那份", async () => {
  const store = createMemoryTranscriptStore();
  // 崩溃现场：折叠发生在轮 2 圈顶，而轮 2 的模型调用直接抛 ⇒ 轮 2 的记录没写成。
  const first = createProvider({ mainScript: [toolTurn("a"), { throw: new Error("boom: 轮 2 的模型调用炸了") }] });
  await assert.rejects(() => runToolLoop({
    ...foldRunOptions("326c-fold-resume", store, first, {
      initialUserMessage: `start ${"y".repeat(600)}`,
      maxRounds: 5,
      executeTool: async ({ id }) => bigToolOutput(id),
    }),
  }), /boom: 轮 2/u);
  assert.equal(first.summaryCalls, 1, "基线：一次折叠摘要");
  assert.equal((await store.load("326c-fold-resume"))
    .filter((record) => (record.round ?? 0) === 2 && (record.messages?.length ?? 0) > 0).length, 0,
    "前置：轮 2 的轮记录确实没落盘（这才是「崩溃在折叠之后」的现场）");

  const recordsBefore = await store.load("326c-fold-resume");
  const journaledSummary = recordsBefore.find((record) => (
    typeof record?.foldedSummary?.text === "string"
  ))?.foldedSummary?.text;
  assert.match(String(journaledSummary), /SUMMARY_V1/u, "摘要必须已入账");

  const resumed = createProvider({ mainScript: [endTurn("续接结论")] });
  await runToolLoop({
    provider: resumed,
    task: "继续",
    resume: true,
    runId: "326c-fold-resume",
    store,
    executeTool: async ({ id }) => bigToolOutput(id),
    maxRounds: 2,
    completion: false,
    reflection: false,
    // issue #404：恢复运行会注入一条「复活赛告示」消息，于是**最后多出一个轮**。本用例的
    // `foldContext` 是 `keepRounds: 0`（全折叠）——那样告示自己也会被折进去，折叠输入真的变了，
    // 复用当然落空。这里把 `keepRounds` 提到 1，让「被折叠的那一段」保持与崩溃前逐字相同：
    // 本用例要钉的是**同一份折叠输入不重算**，不是「上下文变了也不许重算」。
    // 告示自己落进折叠区间那一格另有专门的锚（`test/loop-resume-notice.test.js` 的
    // 「告示在同一轮被折进摘要」条）。
    context: { ...foldContext, keepRounds: 1 },
  });

  assert.equal(resumed.summaryCalls, 0,
    `恢复后必须复用已入账摘要，不得重算（实测 ${resumed.summaryCalls} 次）`);
  assert.ok(
    resumed.mainRequests.some((request) => request.messages.some((message) => textOf(message).includes("SUMMARY_V1"))),
    "恢复后的请求必须用已入账那份摘要",
  );
  assert.ok(
    !resumed.mainRequests.some((request) => request.messages.some((message) => textOf(message).includes("SUMMARY_V2"))),
    "不得出现重算出来的第二份摘要",
  );

  // 不重复入账：同一次折叠在恢复后仍然只有一条事实行。
  const recordsAfter = await store.load("326c-fold-resume");
  assert.equal(recordsAfter.filter((record) => typeof record?.foldedSummary?.text === "string").length, 1,
    "复用命中不得再记一条同样的折叠事实");
});

test("#326-C 复用不重算：同一 run 内重复折叠不重复调 summarizer", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({
    mainScript: [toolTurn("a"), toolTurn("b"), toolTurn("c"), endTurn("收尾结论")],
  });
  await runToolLoop(foldRunOptions("326c-fold-repeat", store, provider, {
    maxRounds: 4,
    initialUserMessage: `start ${"y".repeat(600)}`,
  }));

  const records = await store.load("326c-fold-repeat");
  const facts = records.filter((record) => typeof record?.foldedSummary?.text === "string");
  assert.ok(facts.length >= 1, "折叠事实必须入账");
  const fingerprints = facts.map((record) => record.foldedSummary.fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length,
    `同一折叠结果不得重复入账（实测 ${JSON.stringify(fingerprints)}）`);
  // 复用判据：账本里每条事实的指纹，最多只对应一次真实的 summarizer 调用。
  assert.ok(provider.summaryCalls <= facts.length,
    `summarizer 调用次数（${provider.summaryCalls}）不得超过已入账的折叠事实数（${facts.length}）`);
});

const ttlScript = [
  toolTurn("big"),
  toolTurn("c"),
  toolTurn("d"),
  toolTurn("e"),
  endTurn("TTL 收尾结论"),
];
const bigNumberedOutput = Array.from(
  { length: 120 },
  (_value, index) => `${index + 1}: function bigFn${index}(a) { return a + ${index}; }`,
).join("\n");

const ttlRunOptions = (runId, store, provider, extra = {}) => ({
  provider,
  initialUserMessage: "ttl task",
  executeTool: async ({ id }) => (id === "big" ? bigNumberedOutput : `small ${id}`),
  maxRounds: 6,
  completion: false,
  reflection: false,
  toolResultTtl: 1,
  toolResultFoldMinTokens: 200,
  store,
  runId,
  ...extra,
});

test("#326-C TTL 降级：load() 里读得到「这条工具结果被降级成了什么」", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({ mainScript: ttlScript });
  await runToolLoop(ttlRunOptions("326c-ttl", store, provider));

  // 前置：TTL 折叠真的发生过，并且占位符进过真实请求。
  assert.ok(
    provider.mainRequests.some((request) => request.messages.some((message) => textOf(message).includes("【已折叠·TTL】"))),
    "TTL 占位符必须进过主模型上下文",
  );

  const records = await store.load("326c-ttl");
  const degraded = records.flatMap((record) => record.ttlDegradations ?? []);
  assert.ok(degraded.length >= 1,
    `TTL 降级事实必须在 store.load() 里读得到（实测记录 ${JSON.stringify(records.map((record) => record.dedupKey ?? record.roundKey))}）`);
  const entry = degraded.find((item) => item.toolUseId === "big");
  assert.ok(entry !== undefined, "降级事实必须能指认到具体的那条工具结果（toolUseId）");
  assert.equal(entry.toolName, "work");
  assert.ok(Number.isFinite(entry.tokens) && entry.tokens > 0, "必须带原始体积（估算 tokens）");
  assert.ok(Number.isSafeInteger(entry.createdRound) && entry.createdRound >= 1, "必须带创建轮号");
  assert.match(String(entry.contentFingerprint), /^sha256:[0-9a-f]{12,}$/u, "必须带原文指纹（digest）");
  assert.match(String(entry.placeholder), /【已折叠·TTL】/u, "必须逐字保留喂给模型的占位符");
  assert.match(String(entry.placeholder), /约\s*\d+\s*tokens/u, "占位符必须自带原始体积");
  assert.doesNotMatch(String(entry.placeholder), /（内容已省略）/u, "不得退化成「（内容已省略）」");
});

test("#326-C TTL 降级：file store 里也读得到，且没有 TTL 折叠时不落该字段", async () => {
  const dir = await makeTmp("erix-326c-ttl-file-");
  const store = createFileTranscriptStore({ dir });
  const provider = createProvider({ mainScript: ttlScript });
  await runToolLoop(ttlRunOptions("326c-ttl-file", store, provider));
  const records = await store.load("326c-ttl-file");
  assert.ok(records.some((record) => (record.ttlDegradations?.length ?? 0) > 0),
    "真落盘的 transcript 必须含 TTL 降级事实");

  // 反例守卫：小体积结果不折叠 ⇒ 宿主读到的形状不变（不出现空字段）。
  const quietStore = createMemoryTranscriptStore();
  const quietProvider = createProvider({ mainScript: [toolTurn("s"), endTurn("结论")] });
  await runToolLoop(ttlRunOptions("326c-ttl-quiet", quietStore, quietProvider, {
    executeTool: async () => "tiny",
  }));
  const quietRecords = await quietStore.load("326c-ttl-quiet");
  assert.ok(quietRecords.every((record) => record.ttlDegradations === undefined),
    "没发生降级时不得凭空多出字段（宿主读取形状不变）");
});
