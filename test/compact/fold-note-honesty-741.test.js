// issue #741 切片 A —— 折叠替代物 / TTL 降级占位符的**笔记断言诚实性**。
//
// 缺陷本体（prompt 级 + 可观测级）：两处模型可见文本都**无条件**宣称「要点见已有笔记 /
// 先用 note_list 查找，再用 note_read 读取」，而引擎既不写笔记（机制级，本切片外），
// 也不知道宿主有没有装配 `note_*`（配置级，本切片外）。生产证据（run b3eeba0f）：折叠后
// 整场 `note_*` 调用 0 次，模型实际用 cat/grep/sed 取回原文 ⇒ 那句话既指了一条不存在的道路，
// 又把「我不知道有没有记录」伪报成「有记录」。
//
// 三条判据（逐字对应工单的验收方案）：
//   ① 强制折叠 + 笔记为空 ⇒ 出现「无可复原的决策记录」并带原因，且**不得**出现「要点见对话中已有笔记」；
//   ② `note_take` 不在工具面上 ⇒ 提示里不得出现任何 `note_*` 指引（这一格改前是零测试）；
//   ③ 归档有丢弃 ⇒ `droppedMessages` / `droppedBytes` 两个计数看得到（变异掉产出那行必须红）。
// 外加取回命令与证据判定的形状钉（第 2 项交付物：能确定性重算的就给一条能跑的命令）。
//
// 环境纪律：零真实 LLM、不写盘、不碰 `~/.erix`。

import assert from "node:assert/strict";
import test from "node:test";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import { createFoldStatisticalStrategy } from "../../src/compact/fold-statistical.js";
import { normalizeCompactionStats } from "../../src/compact/pipeline.js";
import { DEFAULT_RECOVERY_HINT, ENGINE_RECOVERY_HINTS } from "../../src/compact/helpers.js";
import {
  NOTE_RECALL_REASONS,
  foldToolResultsForRequest,
  hasNoteWriteEvidence,
  noteToolNamesOnSurface,
  resolveNoteRecall,
  retrievalCommandFor,
} from "../../src/loop/tool-result-ttl.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { runDirect } from "../helpers/run-direct.js";

// —— 夹具 ——

const BIG = "x".repeat(20_000); // 越过默认 4000 tokens 折叠门槛
const NOTE_TOOLS = ["note_take", "note_list", "note_read"];

/** 判据里钉的两句（模型可见文本，改字面就该在这里红一次）。 */
const NO_RECORD_CLAUSE = "无可复原的决策记录";
const NOTE_TAIL = "要点见对话中已有笔记/结论";

/**
 * 一条 readFile 结果 + 可选的 `note_take` 写入记录。
 * `noteWrite: false` = 可见账本里没有任何笔记写入（判据①的前半）。
 */
function conversation({
  noteWrite = false,
  resultContent = BIG,
  input = { path: "src/a.js", offset: 0, limit: 120 },
  toolName = "readFile",
  createdRound = 1,
} = {}) {
  return [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: toolName, input }] },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: resultContent, erix: { round: createdRound } }],
    },
    ...(noteWrite
      ? [
        { role: "assistant", content: [{ type: "tool_use", id: "note-1", name: "note_take", input: { text: "结论已记" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "note-1", content: "ok" }] },
      ]
      : []),
  ];
}

const placeholderOf = (view) => view[2].content[0].content;
const textOf = (message) => (message?.content ?? [])
  .map((block) => String(block?.text ?? (block?.type === "tool_result" ? block.content ?? "" : "")))
  .join("\n");

/** 折叠替代物正文（强制折全部轮次）。 */
async function foldSubstitute(messages, options = {}) {
  const result = await createFoldStatisticalStrategy().compact(messages, { keepRounds: 0, ...options });
  return textOf(result.messages[0]);
}

// —— 判据①：强制折叠 + 笔记为空 ⇒ 说「无可复原的决策记录」并带原因 ——

test("①折叠替代物：整族笔记工具在面上但账本里没有笔记 ⇒ 未知口径 + 原因", async () => {
  const substitute = await foldSubstitute(conversation(), { noteTools: NOTE_TOOLS });
  assert.match(substitute, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记写入）`, "u"),
    `替代物必须明说没有可复原记录并给出「笔记为空」这一原因（实测：${substitute}）`);
  // 反向锁：不许再宣称「已有笔记」——这是本缺陷的字面。
  assert.equal(substitute.includes(NOTE_TAIL), false, "笔记为空时不得出现「要点见对话中已有笔记」");
  assert.equal(substitute.includes("查看持久笔记"), false, "笔记为空时不得再指「查看持久笔记」");
});

test("①TTL 占位符：笔记为空 ⇒ 同样说「无可复原的决策记录」，不提 note_*", () => {
  const view = foldToolResultsForRequest(conversation(), {
    currentRound: 5,
    ttl: 2,
    minTokens: 100,
    noteTools: NOTE_TOOLS,
  });
  const placeholder = placeholderOf(view);
  assert.match(placeholder, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记写入）`, "u"));
  assert.equal(placeholder.includes(NOTE_TAIL), false, "占位符不得再说「要点见对话中已有笔记」");
  assert.match(placeholder, /未记录且无法确定性重算时请省略，不要猜测/u,
    "「不要猜测」半句必须保留：本切片修的是「有没有记录」，不是放松反幻觉约束");
});

test("①有笔记证据时两句逐字不变（回归锁：条件式不是删除）", async () => {
  const withEvidence = conversation({ noteWrite: true });
  const substitute = await foldSubstitute(withEvidence, { noteTools: NOTE_TOOLS });
  assert.equal(substitute.includes(DEFAULT_RECOVERY_HINT), true, "有证据 ⇒ 广告语仍是原句");
  assert.equal(substitute.includes(NO_RECORD_CLAUSE), false, "有证据 ⇒ 不该出现未知口径");

  const view = foldToolResultsForRequest(withEvidence, { currentRound: 5, ttl: 2, minTokens: 100, noteTools: NOTE_TOOLS });
  const placeholder = placeholderOf(view);
  assert.match(placeholder, /先用 note_list 查找，再用 note_read 读取/u);
  assert.equal(placeholder.includes(NOTE_TAIL), true, "有证据 ⇒ 尾巴仍是原句");
  assert.equal(placeholder.includes(NO_RECORD_CLAUSE), false);
});

// —— 判据②：note_take 不在工具面上 ⇒ 提示里不得出现任何 note_*（改前零测试）——

test("②工具面上没有 note_*：TTL 占位符一个字也不提笔记", () => {
  const view = foldToolResultsForRequest(conversation(), {
    currentRound: 5,
    ttl: 2,
    minTokens: 100,
    noteTools: noteToolNamesOnSurface([{ name: "readFile" }, { name: "exec" }, { name: "writeFile" }]),
  });
  const placeholder = placeholderOf(view);
  assert.equal(placeholder.includes("note_"), false, `不得出现任何 note_* 指引（实测：${placeholder}）`);
  assert.match(placeholder, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记工具）`, "u"));
});

test("②工具面上没有 note_*：预警轮那行也不指挥模型去调不存在的工具", () => {
  const view = foldToolResultsForRequest(conversation({ createdRound: 1 }), {
    currentRound: 2, // age=1 === ttl-1 ⇒ 预警轮
    ttl: 2,
    minTokens: 100,
    noteTools: [],
  });
  const warned = placeholderOf(view);
  assert.match(warned, /【TTL 预警】此结果下一轮将折叠为句柄/u);
  assert.equal(warned.includes("note_"), false, `预警行不得出现 note_*（实测：${warned}）`);
});

test("②工具面上没有 note_*：折叠替代物与摘要器提示都不提笔记", async () => {
  const substitute = await foldSubstitute(conversation(), { noteTools: [] });
  assert.equal(substitute.includes("note_"), false, `替代物不得出现 note_*（实测：${substitute}）`);
  assert.match(substitute, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记工具）`, "u"));

  // fold-llm 那一发：摘要器收到的恢复提示同样是模型可见口径的来源，也不许提不存在的工具。
  const rounds = [];
  for (let index = 1; index <= 3; index += 1) {
    rounds.push(
      { role: "user", content: [{ type: "text", text: `q${index}` }] },
      { role: "assistant", content: [{ type: "tool_use", id: `r${index}`, name: "readFile", input: { path: `src/f${index}.js` } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `r${index}`, content: "x".repeat(400), erix: { round: index } }] },
    );
  }
  const summaryCalls = [];
  await createFoldLlmStrategy({
    summarizer: async (input) => {
      summaryCalls.push(input);
      return "## 阶段\n只做了夹具这件事";
    },
  }).compact(rounds, { keepRounds: 1, noteTools: [] });
  assert.equal(summaryCalls.length, 1, "本用例必须真的走到摘要器（否则是空断言）");
  assert.equal(summaryCalls[0].recoveryHint.includes("note_"), false,
    `喂给摘要器的恢复提示也不得出现 note_*（实测：${summaryCalls[0].recoveryHint}）`);
  assert.match(summaryCalls[0].recoveryHint, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记工具）`, "u"));
});

test("②引擎拿不到工具面证据时不伪报知道（缺席即未知，不是默认有笔记）", async () => {
  // 直接调策略而不传 `noteTools`：这是宿主自带策略对象/老调用方的形状，
  // 改前的行为是「默认有笔记」——正是本缺陷的另一半。
  const substitute = await foldSubstitute(conversation());
  assert.match(substitute, new RegExp(`${NO_RECORD_CLAUSE}（原因：无笔记证据）`, "u"));
  assert.equal(substitute.includes(NOTE_TAIL), false);
  // 三条未知口径变体都在剥离清单里（合并折叠摘要时不许在标题里留半句广告语）。
  assert.equal(ENGINE_RECOVERY_HINTS.length, 4, "默认广告语的可枚举集合：原句 + 三条未知口径变体");
  assert.equal(ENGINE_RECOVERY_HINTS[0], DEFAULT_RECOVERY_HINT);
});

// —— 取回命令（第 2 项交付物：能确定性重算就直接给命令）——

test("取回命令：offset/limit 与 readFile 同口径（offset 0 基行号、limit 行数）", () => {
  assert.equal(retrievalCommandFor("readFile", { path: "src/a.js", offset: 0, limit: 120 }),
    "sed -n '1,120p' 'src/a.js'");
  assert.equal(retrievalCommandFor("readFile", { path: "src/a.js", offset: 200, limit: 50 }),
    "sed -n '201,250p' 'src/a.js'");
  // 没给 limit ⇒ 用一个明确的窄窗口，而不是谎称是全文。
  assert.equal(retrievalCommandFor("readFile", { path: "src/a.js" }), "sed -n '1,120p' 'src/a.js'");
});

test("取回命令：路径里的空格与单引号不破功，exec 类不给命令（它自己的 command 本来就可重跑）", () => {
  assert.equal(retrievalCommandFor("readFile", { path: "docs/a b's.md", limit: 10 }),
    "sed -n '1,10p' 'docs/a b'\\''s.md'");
  assert.equal(retrievalCommandFor("exec", { command: "npm test" }), undefined);
  assert.equal(retrievalCommandFor("scan", { query: "abc" }), undefined, "没有路径入参 ⇒ 拼不出命令，也不许瞎猜");
});

test("取回命令：占位符里独立一行，且同一条命令进 TTL 降级记录", () => {
  const stats = {};
  const view = foldToolResultsForRequest(conversation({ input: { path: "src/a b.js", offset: 40, limit: 80 } }), {
    currentRound: 9,
    ttl: 2,
    minTokens: 100,
    noteTools: [],
    stats,
  });
  const lines = placeholderOf(view).split("\n");
  assert.equal(lines[1], "取回: sed -n '41,120p' 'src/a b.js'",
    `第二行整行就是一条可执行命令（实测：${JSON.stringify(lines[1])}）`);
  assert.equal(stats.degradations.length, 1);
  assert.equal(stats.degradations[0].retrievalCommand, "sed -n '41,120p' 'src/a b.js'",
    "宿主侧读同一条命令，不必解析占位符");
  assert.deepEqual(stats.degradations[0].noteRecall, { available: false, reason: NOTE_RECALL_REASONS.noSurface });
});

test("证据判定：工具面整族齐全**且**账本里有成功写入才算有笔记", () => {
  assert.deepEqual(noteToolNamesOnSurface([{ name: "note_take" }, { name: "note_list" }, { name: "note_read" }, { name: "readFile" }]),
    NOTE_TOOLS);
  assert.deepEqual(noteToolNamesOnSurface([{ name: "note_take" }]), ["note_take"], "缺一个就是缺，不做前缀猜测");
  assert.deepEqual(noteToolNamesOnSurface(undefined), []);

  assert.equal(hasNoteWriteEvidence(conversation({ noteWrite: true })), true);
  assert.equal(hasNoteWriteEvidence(conversation()), false);
  // 写入失败过（配对的 tool_result 是 is_error）不算证据。
  const failed = conversation({ noteWrite: true });
  failed[4].content[0].is_error = true;
  assert.equal(hasNoteWriteEvidence(failed), false, "失败的 note_take 不能当「有笔记」的证据");

  // 三种未知口径各自的判定（原因文本本身就是模型可见文本）。
  assert.deepEqual(resolveNoteRecall({}), { available: false, reason: NOTE_RECALL_REASONS.unknown, surfaceKnown: false });
  assert.deepEqual(resolveNoteRecall({ noteTools: ["note_take", "note_list"] }),
    { available: false, reason: NOTE_RECALL_REASONS.noSurface, surfaceKnown: true });
  assert.deepEqual(resolveNoteRecall({ noteTools: NOTE_TOOLS, messages: conversation() }),
    { available: false, reason: NOTE_RECALL_REASONS.emptyNotes, surfaceKnown: true });
  assert.deepEqual(resolveNoteRecall({ noteTools: NOTE_TOOLS, messages: conversation({ noteWrite: true }) }),
    { available: true, reason: "", surfaceKnown: true });
});

// —— 判据③：归档有丢弃 ⇒ 两个计数看得到（不得静默）——

const SUMMARY_SYSTEM = "你是对话历史压缩器";
const toolUse = (id) => ({ type: "tool_use", id, name: "work", input: { path: `src/${id}.js`, offset: 0, limit: 60 } });

/** 双通道 fake provider：主循环脚本 + fold-llm 摘要器（按 system 前缀识别）。 */
function createProvider({ mainScript }) {
  let mainIndex = 0;
  let summaryIndex = 0;
  return {
    protocol: "fake",
    model: "fake-model",
    get summaryCalls() {
      return summaryIndex;
    },
    async chat(request) {
      if (typeof request?.system === "string" && request.system.includes(SUMMARY_SYSTEM)) {
        summaryIndex += 1;
        return {
          content: [{ type: "text", text: `## 阶段\nSUMMARY_V${summaryIndex}` }],
          stopReason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 50 },
        };
      }
      const step = mainScript[Math.min(mainIndex, mainScript.length - 1)];
      mainIndex += 1;
      return { ...step, usage: { input_tokens: 100, output_tokens: 20 } };
    },
    async chatStream(request) {
      return this.chat(request);
    },
  };
}

test("③归档夹断丢掉原文 ⇒ droppedMessages/droppedBytes 进 compaction 事件与 state 窗口（不得静默）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({
    mainScript: [
      { content: [toolUse("a")], stopReason: "tool_use" },
      { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
    ],
  });
  const events = [];
  await runDirect({
    provider,
    executeTool: async ({ id }) => `payload for ${id} ${"z".repeat(4_000)}`,
    maxRounds: 2,
    completion: false,
    reflection: false,
    // `maxFoldedPayloadBytes` 压到 600 B ⇒ 归档必然装不下本次被折负载 ⇒ 一定发生夹断。
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm", maxFoldedPayloadBytes: 600 } } },
    onEvent: (event) => events.push(event),
    store,
    runId: "741-archive-drop",
    seed: `start ${"y".repeat(900)}`,
  });

  const compactionStats = events.filter((event) => event.type === "compaction").map((event) => event.compaction);
  assert.ok(compactionStats.length >= 1, "本用例必须真的发生一次折叠（否则下面是空断言）");
  const archived = compactionStats.find((stat) => stat?.foldArchive !== undefined);
  assert.ok(archived !== undefined,
    `被夹断的那一折必须在 stat 上留下 foldArchive（实测 ${JSON.stringify(compactionStats.map((stat) => Object.keys(stat ?? {})))}）`);
  const { droppedMessages, droppedBytes } = archived.foldArchive;
  assert.ok(Number.isSafeInteger(droppedMessages) && droppedMessages > 0,
    `droppedMessages 必须是正整数计数（实测 ${JSON.stringify(archived.foldArchive)}）`);
  assert.ok(Number.isSafeInteger(droppedBytes) && droppedBytes > 0,
    `droppedBytes 必须是正整数计数（实测 ${JSON.stringify(archived.foldArchive)}）`);

  // 与轮记录上的同源事实对得上：事件说的和账本记的是同一件事，不是两处各算一遍。
  const records = await store.load("741-archive-drop");
  const meta = records.map((record) => record?.foldedPayloadMeta).find((value) => value !== undefined);
  assert.ok(meta !== undefined, "轮记录必须带 foldedPayloadMeta（同源事实）");
  assert.equal(droppedMessages, meta.droppedMessages, "事件计数必须与归档 meta 同值");
  assert.equal(droppedBytes, meta.droppedBytes, "事件计数必须与归档 meta 同值");

  // `state.json` 那条窗口路径也要带上：归一化不重建就会「事件里有、state 里没」。
  const normalized = normalizeCompactionStats(compactionStats);
  const normalizedArchived = normalized.find((stat) => stat?.foldArchive !== undefined);
  assert.ok(normalizedArchived !== undefined, "normalizeCompactionStats 必须重建 foldArchive 键");
  assert.equal(normalizedArchived.foldArchive.droppedMessages, droppedMessages);
  assert.equal(normalizedArchived.foldArchive.droppedBytes, droppedBytes);
});

test("③归档没有丢弃 ⇒ 不写 foldArchive 键（无事实不写键，形状逐字不变）", async () => {
  const store = createMemoryTranscriptStore();
  const provider = createProvider({
    mainScript: [
      { content: [toolUse("a")], stopReason: "tool_use" },
      { content: [{ type: "text", text: "收尾结论" }], stopReason: "end_turn" },
    ],
  });
  const events = [];
  await runDirect({
    provider,
    executeTool: async ({ id }) => `payload for ${id} ${"z".repeat(400)}`,
    maxRounds: 2,
    completion: false,
    reflection: false,
    // 默认归档上限（256 KiB）⇒ 这一折什么都没丢。
    config: { folding: { context: { budgetTokens: 300, keepRounds: 0, strategy: "fold-llm" } } },
    onEvent: (event) => events.push(event),
    store,
    runId: "741-archive-keep",
    seed: `start ${"y".repeat(300)}`,
  });
  const compactionStats = events.filter((event) => event.type === "compaction").map((event) => event.compaction);
  assert.ok(compactionStats.length >= 1, "必须真的折叠过");
  for (const stat of compactionStats) {
    assert.equal(stat.foldArchive, undefined,
      `没丢东西就不该有这个键（实测 ${JSON.stringify(stat?.foldArchive)}）`);
  }
});
