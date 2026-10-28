// 基线探针（改前）：折叠摘要 / TTL 降级结果在 store.load() 里的可见性 + summarizer 调用次数。
// 真引擎 + fake provider + 内置 memory store，零真实 LLM 调用。
import { runToolLoop } from "../src/loop/orchestrator.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";

const ROOT = "/home/eric/projects/worktrees/erix-llm-kit/pi-worktree-ba7cab7d-f1e5-4bf2-8df4-1b4e158a5773-s0-0";
void ROOT;
const SUMMARY_SYSTEM = "你是对话历史压缩器";

const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => (block?.type === "tool_result"
    ? String(block.content ?? "")
    : block?.type === "text" ? block.text ?? "" : "")).join("\n")
  : String(message?.content ?? ""));

function createProvider(runId, script) {
  const summaryRequests = [];
  const mainRequests = [];
  let mainIndex = 0;
  let summaryIndex = 0;
  return {
    protocol: "fake",
    model: "fake",
    summaryRequests,
    mainRequests,
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryRequests.push(request);
        summaryIndex += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nSUMMARY_V${summaryIndex}_${runId}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      mainRequests.push(request);
      const step = script[Math.min(mainIndex, script.length - 1)];
      mainIndex += 1;
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
}

const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { path: `src/${id}.js` } });
const script = [
  { content: [toolUse("a")], stopReason: "tool_use" },
  { content: [toolUse("b")], stopReason: "tool_use" },
  { content: [{ type: "text", text: "final" }], stopReason: "end_turn" },
];

const runId = "probe-fold";
const store = createMemoryTranscriptStore();
const p1 = createProvider(runId, script);
// #546: 选项拼写迁移（只改落点，观察逻辑/打印/判据一字未动）：`runId` / `maxRounds` /
// `completion` / `reflection` / `resume` 的扁平拼写已退役，家分别是 `config.run.*`
// （#498 S3 A20 / A21 / A23b / #530 / A19）；`initialUserMessage` / `task` 早就是
// `config.input.*` / `config.metadata.*`。同一个对象字面量里原先写了**两个 `config` 键**
// （后者静默覆盖前者），这里并进同一棵树。
const first = await runToolLoop({
  provider: p1,
  executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
  store,
  config: {
    input: { initialUserMessage: `start ${"y".repeat(600)}` },
    run: { runId, maxRounds: 3, completion: false, reflection: false },
    folding: { context: { budgetTokens: 400, keepRounds: 0, strategy: "fold-llm" } },
  },
});
const records1 = await store.load(runId);
const flat1 = records1.flatMap((r) => r.messages ?? []);
console.log("=== fold probe ===");
console.log("run1 termination:", first.termination.reason);
console.log("run1 summarizer calls:", p1.summaryRequests.length);
console.log("run1 last main request contains SUMMARY_V1:", p1.mainRequests.at(-1).messages.some((m) => textOf(m).includes("SUMMARY_V1")));
console.log("run1 records:", records1.length, records1.map((r) => r.dedupKey ?? r.roundKey));
console.log("journal body messages contain SUMMARY_V1:", flat1.filter((m) => textOf(m).includes("SUMMARY_V1")).length,
  "(事实行不带正文，所以这里本该是 0 —— 摘要在下面的事实字段里)");
const foldFacts1 = records1.filter((r) => r.foldedSummary).map((r) => ({
  dedupKey: r.dedupKey, messages: (r.messages ?? []).length,
  strategy: r.foldedSummary.strategy, fingerprint: r.foldedSummary.fingerprint,
  foldedRoundRange: r.foldedSummary.foldedRoundRange ?? null,
  hasRawSummary: typeof r.foldedSummary.summary === "string",
  textHasV1: String(r.foldedSummary.text).includes("SUMMARY_V1"),
}));
console.log("journal fold fact rows:", JSON.stringify(foldFacts1));

const p2 = createProvider(runId, script);
const second = await runToolLoop({
  provider: p2,
  store,
  executeTool: async ({ id }) => `tool output for ${id} ${"z".repeat(400)}`,
  config: {
    // #498 S3 (`metadata` A9): the flat `task` is retired at the name gate; its canonical home is
    // `config.metadata.task` (the expansion phase writes it back onto `effectiveOptions.task`).
    metadata: { task: "continue" },
    // #546: `resume` / `runId` / `maxRounds` / `completion` / `reflection` → 同一棵 `run` 子树。
    run: { resume: true, runId, maxRounds: 3, completion: false, reflection: false },
    folding: { context: { budgetTokens: 400, keepRounds: 0, strategy: "fold-llm" } },
  },
});
console.log("resume termination:", second.termination.reason);
console.log("resume summarizer calls:", p2.summaryRequests.length);
const records2 = await store.load(runId);
console.log("journal fold fact rows after resume:", records2.filter((r) => r.foldedSummary).length,
  // 注：这里的「3 次调用 / 多条事实行」是续跑时折叠了**新的轮区间**（指纹不同）⇒ 合法的新摘要，不是重算同一输入。
  // “复用不重算”的判据在 test/loop-persist-compaction-facts.test.js 第 3/4 条：同一指纹不得二次调摘要器。
  "(新轮区间的新摘要属合法新增；同指纹不重算的判据见 test/loop-persist-compaction-facts.test.js 第 3/4 条)");
console.log("resume last main request contains V1:", p2.mainRequests.at(-1).messages.some((m) => textOf(m).includes("SUMMARY_V1")));
console.log("resume last main request contains V2:", p2.mainRequests.at(-1).messages.some((m) => textOf(m).includes("SUMMARY_V2")));

// —— TTL ——
console.log("=== ttl probe ===");
const ttlRunId = "probe-ttl";
const ttlStore = createMemoryTranscriptStore();
const ttlScript = [
  { content: [toolUse("big")], stopReason: "tool_use" },
  { content: [toolUse("c")], stopReason: "tool_use" },
  { content: [toolUse("d")], stopReason: "tool_use" },
  { content: [toolUse("e")], stopReason: "tool_use" },
  { content: [toolUse("f")], stopReason: "tool_use" },
  { content: [{ type: "text", text: "ttl final" }], stopReason: "end_turn" },
];
const p3 = createProvider(ttlRunId, ttlScript);
const third = await runToolLoop({
  provider: p3,
  executeTool: async ({ id }) => (id === "big"
    ? Array.from({ length: 120 }, (_v, i) => `${i + 1}: function bigFn${i}(a) { return a + ${i}; }`).join("\n")
    : `small ${id}`),
  store: ttlStore,
  config: {
    input: { initialUserMessage: "ttl task" },
    run: { runId: ttlRunId, maxRounds: 6, completion: false, reflection: false },
    folding: { toolResultTtl: 1, toolResultFoldMinTokens: 200 },
  },
});
const records3 = await ttlStore.load(ttlRunId);
const flat3 = records3.flatMap((r) => r.messages ?? []);
console.log("ttl termination:", third.termination.reason);
console.log("a request carried the TTL placeholder:",
  p3.mainRequests.some((r) => r.messages.some((m) => textOf(m).includes("【已折叠·TTL】"))));
console.log("journal records containing TTL placeholder (in body messages):",
  flat3.filter((m) => textOf(m).includes("【已折叠·TTL】")).length,
  "(TTL 占位符只活在请求视图里，正文不带 ⇒ 本该 0)");
console.log("journal ttl fact rows:", JSON.stringify(records3.filter((r) => r.ttlDegradations)
  .map((r) => ({ dedupKey: r.dedupKey, messages: (r.messages ?? []).length,
    facts: r.ttlDegradations.map((d) => ({ toolUseId: d.toolUseId, createdRound: d.createdRound,
      tokens: d.tokens, tokensAfter: d.tokensAfter, chars: d.chars, fingerprint: d.contentFingerprint,
      placeholderHasTtlMark: String(d.placeholder).includes("【已折叠·TTL】") })) }))));
console.log("journal records:", records3.map((r) => r.dedupKey ?? r.roundKey));
console.log("compactionStats layers ttl:", JSON.stringify(records3.map((r) => r.compactionStats?.map((s) => s.layers?.ttl?.triggered) ?? null)));
