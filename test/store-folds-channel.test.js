// @ts-check
//
// ADR-022 本刀判据（折叠记录升为独立通道）。全部离线：内存 / 文件 store + fake provider，零真实 LLM。
// 本文件**不动** rounds 的形状（payload_sha256 / fold_round_rows / recall_ask(foldSeq) 是下一刀）。

import test from "node:test";
import assert from "node:assert/strict";

import { runDirect, withSeed } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";
import { makeTmp } from "./helpers/tmp.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFileTranscriptStore } from "../src/store/file.js";
import { buildFoldedFacts } from "../src/compact/fold-summary-journal.js";
import { FOLD_RECORD_COLUMNS } from "../src/store/folds.js";
import { createFoldStatisticalStrategy } from "../src/compact/fold-statistical.js";

// 一段含**工具清单节**的正文：buildFoldedFacts 会把它投影成结构化 `toolCalls`。
const INVENTORY_TEXT = "TITLE LINE\n工具调用清单（机械摘要，不代表执行成功）：\n- exec ls -la\n- echo hello\n";

/** 触发尽量多键的折叠输入（大预算 ⇒ summary 不被挤掉）。 */
function richFacts(overrides = {}) {
  return buildFoldedFacts({
    text: INVENTORY_TEXT + "x".repeat(200),
    title: "模型给的标题",
    origin: "semantic",
    summary: "一段模型 description",
    descriptionTruncated: true,
    incrementText: "本折自己的增量正文",
    roundRange: { from: 1, to: 3 },
    rounds: 3,
    degradeReason: "llm 降级",
    fingerprint: "sha256:aaa111",
    foldId: "sha256:aaa111",
    source: "llm",
    strategy: "fold-llm",
    maxBytes: 8192,
    ...overrides,
  });
}

// ── 判据 1：appendFold + loadFolds 往返，逐字段相等（含 increment 对象、toolCalls 数组）──────────
test("判据1 memory：appendFold + loadFolds 往返逐字段相等（含 increment / toolCalls）", async () => {
  const store = createMemoryTranscriptStore();
  const facts = richFacts();
  assert.ok(facts !== undefined, "前提：richFacts 必须有正文 ⇒ buildFoldedFacts 不返回 undefined");
  const written = await store.appendFold("run-1", facts);
  const loaded = await store.loadFolds("run-1");
  assert.equal(loaded.length, 1);
  // increment 对象 / toolCalls 数组逐字段相等，不只是「有这两个键」。
  assert.deepEqual(loaded[0], written);
  assert.deepEqual(loaded[0].increment, facts.increment);
  assert.deepEqual(loaded[0].toolCalls, facts.toolCalls);
  assert.equal(loaded[0].text, facts.text);
  assert.equal(loaded[0].summary, facts.summary);
  // 通道分配的 seq：首个折叠 = 1。
  assert.equal(loaded[0].seq, 1);
});

// ── 判据 2：同 foldId 重投 ⇒ 不新增行、seq 相同 ─────────────────────────────────────────────
test("判据2 memory：同 foldId 重投不新增行、seq 相同", async () => {
  const store = createMemoryTranscriptStore();
  const facts = richFacts({ foldId: "sha256:same", fingerprint: "sha256:same" });
  const first = await store.appendFold("run-2", facts);
  const second = await store.appendFold("run-2", facts);
  const third = await store.appendFold("run-2", { ...facts, text: "异体但同 foldId" });
  assert.equal(first.seq, second.seq, "重投必须拿回同一个 seq");
  assert.equal(second.seq, third.seq);
  const loaded = await store.loadFolds("run-2");
  assert.equal(loaded.length, 1, "重投不新增行");
  // 返回的是已存那条（首次那份），不是异 payload。
  assert.equal(loaded[0].text, first.text);
});

// ── 判据 3：新折叠 seq 接在最大值之后（严格递增、不断档）──────────────────────────────────────
test("判据3 memory：新折叠 seq 严格递增、接在最大值之后、不断档", async () => {
  const store = createMemoryTranscriptStore();
  const seqs = [];
  for (let index = 0; index < 5; index += 1) {
    const facts = richFacts({
      foldId: `sha256:fold-${index}`,
      fingerprint: `sha256:fold-${index}`,
    });
    const written = await store.appendFold("run-3", facts);
    seqs.push(written.seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], "严格递增、从 1 起、不断档");
  const loaded = await store.loadFolds("run-3");
  assert.deepEqual(loaded.map((row) => row.seq), [1, 2, 3, 4, 5]);
});

// ── 判据 4：键集合对齐（表驱动）：buildFoldedFacts 每个键都能在 folds 记录里找到 ──────────────
test("判据4a：buildFoldedFacts 返回键集合 ⊆ folds 记录键集合（appendFold 后逐键可见）", async () => {
  const store = createMemoryTranscriptStore();
  const facts = richFacts();
  assert.ok(facts !== undefined);
  await store.appendFold("run-4", facts);
  const [record] = await store.loadFolds("run-4");
  for (const key of Object.keys(facts)) {
    assert.ok(Object.prototype.hasOwnProperty.call(record, key),
      `buildFoldedFacts 的键 "${key}" 必须在 folds 记录里可见`);
    assert.ok(FOLD_RECORD_COLUMNS.has(key),
      `buildFoldedFacts 的键 "${key}" 必须在 FOLD_RECORD_COLUMNS 列集合里`);
    assert.deepEqual(record[key], facts[key], `键 "${key}" 的值必须逐字一致`);
  }
});

test("判据4b：FOLD_RECORD_COLUMNS 覆盖 buildFoldedFacts 的全部可能键（除通道自分配的 seq）", async () => {
  // 三种折叠输入，合计触发 buildFoldedFacts 所有条件性键。
  const a = richFacts(); // summary / descriptionTruncated / increment / toolCalls / from / to / rounds / degradeReason / fingerprint / foldId / title
  const b = richFacts({
    title: undefined, // semantic + 无 model title ⇒ titleFallback
    summary: undefined,
    descriptionTruncated: false,
    maxBytes: 40, // 正文超预算 ⇒ truncated + bytesBefore
  });
  const c = richFacts({
    title: undefined, // 触发 titleFallback
    summary: "一段会被挤掉的 description", // 小预算 ⇒ summaryDropped
    maxBytes: 40,
  });
  /** @type {Set<string>} */
  const observed = new Set();
  for (const facts of [a, b, c]) {
    assert.ok(facts !== undefined);
    for (const key of Object.keys(facts)) observed.add(key);
    assert.ok(FOLD_RECORD_COLUMNS.has("seq"));
  }
  // seq 由通道分配、buildFoldedFacts 自己不写 ⇒ 单独放行。
  const columnsCovered = new Set([...FOLD_RECORD_COLUMNS, "seq"]);
  for (const key of columnsCovered) {
    assert.ok(key === "seq" || observed.has(key),
      `列 "${key}" 没有被任何 buildFoldedFacts 输出触发 ⇒ 列集合可能有凭空多出的键`);
  }
  // 反向：buildFoldedFacts 的每个键都在列集合里（判据 4a 已覆盖 a；这里覆盖 b/c 独有的键）。
  for (const key of observed) {
    assert.ok(FOLD_RECORD_COLUMNS.has(key), `观测到的键 "${key}" 不在列集合里`);
  }
  // 点名几个易漏的条件性键（ADR §7 错账 #2 的历史教训）。
  for (const key of ["titleFallback", "summaryDropped", "truncated", "bytesBefore", "toolCalls", "increment"]) {
    assert.ok(observed.has(key), `条件性键 "${key}" 至少应被某次 buildFoldedFacts 触发到`);
  }
});

// ── 判据 5：store 没有 appendFold ⇒ 退化写轮记录 + 恰好一次 store_folds_channel_absent ──────────
const toolStep = (index) => ({
  content: [{ type: "tool_use", id: `call-${index}`, name: "echo", input: { text: `step-${index}` } }],
  stopReason: "tool_use",
});

/** 构造一个「跑得出折叠」的 run（复刻 #601 的驱动：第 2 次被问到起每轮都折）。 */
function foldingStrategy() {
  const inner = createFoldStatisticalStrategy();
  let asks = 0;
  return {
    name: "fold-statistical",
    shouldCompact: () => {
      asks += 1;
      return asks >= 2;
    },
    async compact(messages, options = {}) {
      options.budgetTokens = undefined;
      return inner.compact(messages, options);
    },
  };
}

async function runFolding(store, events) {
  const provider = createFakeProvider([
    ...Array.from({ length: 5 }, (_, index) => toolStep(index + 1)),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  return runDirect({
    capabilities: { ports: { strategy: foldingStrategy() }, hooks: { onEvent: (event) => events.push(event) } },
    provider,
    seed: "start",
    executeTool: async ({ input }) => `ok:${String(input?.text ?? "")}`,
    maxRounds: 8,
    store,
    config: {
      input: {},
      folding: { context: { budgetTokens: 1_000_000, keepRounds: 1 } },
      run: { completion: false },
    },
  });
}

test("判据5：store 缺 appendFold ⇒ 退化只写轮记录 + 恰好一次 store_folds_channel_absent", async () => {
  const base = createMemoryTranscriptStore();
  // 一个「没有折叠通道」的 store：删掉两个可选方法（模拟旧宿主 store）。
  const store = /** @type {any} */ ({ ...base });
  delete store.appendFold;
  delete store.loadFolds;
  assert.equal(typeof store.appendFold, "undefined", "前提：store 确实没有 appendFold");
  const events = [];
  await runFolding(store, events);
  const diagnostics = events.filter((event) => event?.type === "store_folds_channel_absent");
  assert.equal(diagnostics.length, 1,
    `多折只发一次降级诊断，实测 ${diagnostics.length}：${JSON.stringify(events.map((e) => e?.type))}`);
  assert.equal(diagnostics[0].method, "appendFold");
});

// ── 判据 6：合并读（folds 有一半 + 轮记录里有一半 ⇒ 并集、去重、不重复）───────────────────────
// ── 判据 7：身份去重（同折叠两处都有 ⇒ 只出一条，取 folds 那份）─────────────────────────────
function spyStrategy(capture) {
  const inner = createFoldStatisticalStrategy();
  let captured = false;
  return {
    name: "fold-statistical",
    shouldCompact: () => true,
    async compact(messages, options = {}) {
      options.budgetTokens = undefined;
      if (!captured) {
        captured = true;
        capture(Array.isArray(options.foldRecords) ? options.foldRecords.slice() : []);
      }
      return inner.compact(messages, options);
    },
  };
}

async function resumeAndCapture(store, runId, captured) {
  const { runToolLoop } = await import("../src/loop/orchestrator.js");
  const provider = createFakeProvider([
    { content: [{ type: "text", text: "续接结论" }], stopReason: "end_turn" },
  ]);
  await runToolLoop(withSeed({
    provider,
    resume: true,
    runId,
    store,
    capabilities: { ports: { strategy: spyStrategy(captured) } },
    executeTool: async ({ input }) => `ok:${String(input?.text ?? "")}`,
    maxRounds: 2,
    completion: false,
    reflection: false,
    config: { input: {}, folding: { context: { budgetTokens: 1_000_000, keepRounds: 1 } }, run: { completion: false } },
  }));
}

// 手工搭一个「迁移中途失败」的现场：一条折叠只在轮记录、一条只在通道、一条两处都有（通道那份带标记）。
async function seedHalfMigrated(store, runId) {
  const onlyInRound = richFacts({ foldId: "sha256:only-round", fingerprint: "sha256:only-round" });
  const inBoth = richFacts({ foldId: "sha256:in-both", fingerprint: "sha256:in-both", strategy: "round-strategy" });
  const onlyInChannel = richFacts({ foldId: "sha256:only-channel", fingerprint: "sha256:only-channel" });
  const inBothChannel = richFacts({
    foldId: "sha256:in-both", fingerprint: "sha256:in-both", strategy: "CHANNEL_WIN",
  });
  // 轮记录里放 only-round + in-both(round 版)。
  await store.appendRound(runId, { round: 1, messages: [{ role: "user", content: [{ type: "text", text: "r1" }] }], foldedFacts: onlyInRound });
  await store.appendRound(runId, { round: 2, messages: [{ role: "user", content: [{ type: "text", text: "r2" }] }], foldedFacts: inBoth });
  await store.appendRound(runId, { round: 3, messages: [{ role: "user", content: [{ type: "text", text: "r3" }] }] });
  // 通道里放 only-channel + in-both(channel 版)。轮记录里**不放** only-channel（这才是「中途失败」）。
  await store.appendFold(runId, inBothChannel);
  await store.appendFold(runId, onlyInChannel);
  return { onlyInRound, inBoth, onlyInChannel, inBothChannel };
}

test("判据6：合并读 = folds 通道 ∪ 轮记录，按身份去重、不重复（迁移中途失败不漏）", async () => {
  const store = createMemoryTranscriptStore();
  await seedHalfMigrated(store, "run-merge");
  /** @type {any[]} */
  let captured = [];
  await resumeAndCapture(store, "run-merge", (records) => { captured = records; });
  const foldIds = captured.map((record) => record?.foldId).sort();
  // 并集恰好三条：only-round ∪ only-channel ∪ in-both，不重复。
  assert.deepEqual(foldIds, ["sha256:in-both", "sha256:only-channel", "sha256:only-round"],
    `合并读给出并集且去重，实测 ${JSON.stringify(foldIds)}`);
  assert.equal(new Set(foldIds).size, foldIds.length, "身份去重：不得有重复条目");
});

test("判据7：合并读的身份去重取 folds 那份（同 foldId 两处都有 ⇒ 只出一条且是通道版）", async () => {
  const store = createMemoryTranscriptStore();
  await seedHalfMigrated(store, "run-dedup");
  /** @type {any[]} */
  let captured = [];
  await resumeAndCapture(store, "run-dedup", (records) => { captured = records; });
  const inBoth = captured.filter((record) => record?.foldId === "sha256:in-both");
  assert.equal(inBoth.length, 1, "重叠折叠只出一条");
  assert.equal(inBoth[0].strategy, "CHANNEL_WIN", "取 folds 通道那份，不是轮记录那份");
});

// ── 判据 8：文件与内存 store 对同一操作序列产出逐字节相同的 loadFolds() 序列化 ─────────────────
test("判据8：file 与 memory 对同一操作序列 loadFolds() 序列化逐字节相同", async () => {
  const dir = await makeTmp("erix-folds-8-");
  const fileStore = createFileTranscriptStore({ dir });
  const memoryStore = createMemoryTranscriptStore();
  const ops = [
    richFacts({ foldId: "sha256:op-a", fingerprint: "sha256:op-a" }),
    richFacts({ foldId: "sha256:op-b", fingerprint: "sha256:op-b" }),
    richFacts({ foldId: "sha256:op-c", fingerprint: "sha256:op-c" }),
  ];
  // 重投 op-a（幂等）：两侧都必须不新增、seq 不变。
  for (const fold of [...ops, ops[0]]) {
    await fileStore.appendFold("run-8", fold);
    await memoryStore.appendFold("run-8", fold);
  }
  const fileJson = JSON.stringify(await fileStore.loadFolds("run-8"));
  const memoryJson = JSON.stringify(await memoryStore.loadFolds("run-8"));
  assert.equal(fileJson, memoryJson, "同一操作序列两侧序列化必须逐字节相同");
});

// ── 判据 9：轮记录里 foldedFacts 仍在（兼容期双写，本刀不删）；通道里也有一份 ──────────────────
test("判据9b：兼容期双写——轮记录仍有 foldedFacts + 通道也有（显式 runId）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createFakeProvider([
    ...Array.from({ length: 5 }, (_, index) => toolStep(index + 1)),
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  await runDirect({
    capabilities: { ports: { strategy: foldingStrategy() } },
    provider,
    seed: "start",
    runId: "run-9b",
    executeTool: async ({ input }) => `ok:${String(input?.text ?? "")}`,
    maxRounds: 8,
    store,
    config: {
      input: {},
      folding: { context: { budgetTokens: 1_000_000, keepRounds: 1 } },
      run: { completion: false },
    },
  });
  const roundRecords = await store.load("run-9b");
  const foldedRounds = roundRecords.filter((record) => record?.foldedFacts !== undefined);
  assert.ok(foldedRounds.length >= 1, "轮记录里 foldedFacts 仍在（兼容期双写未被本刀删）");
  const channelFolds = await store.loadFolds("run-9b");
  assert.ok(channelFolds.length >= 1, "folds 通道也落了同一折叠");
  // 通道每条都带 seq（轮记录里那份也带 orchestrator 的 seq），且通道至少与轮记录里出现过的 foldId 同源。
  assert.ok(channelFolds.every((row) => Number.isSafeInteger(row.seq) && row.seq > 0));
  const channelIds = new Set(channelFolds.map((row) => row.foldId));
  const roundIds = foldedRounds.map((record) => record.foldedFacts?.foldId).filter((id) => typeof id === "string");
  assert.ok(roundIds.every((id) => channelIds.has(id)),
    "轮记录里出现的每个折叠都应能在通道里找到（双写同源）");
});
