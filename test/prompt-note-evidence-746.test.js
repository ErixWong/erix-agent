// issue #746 —— 「提示面无条件建议查笔记」的证据门：其余六处入口接上 #741 的同一口径。
//
// 缺陷本体：#741 只把证据门接到了 TTL 占位符与折叠替代物两处；其余六处模型可见文本仍**无条件**
// 命令模型「先用 note_list 查找，再用 note_read 读取」，而 `--no-notes` / `ERIX_NO_NOTES=1` /
// `--tools` 滤掉笔记工具时那些工具根本不在场上。于是那句话既指了一条不存在的道路，又把
// 「我不知道有没有记录」伪报成「有记录」。
//
// 判据（工单验收 1）：**逐处**在四种输入下断言**边界行为**——
//   ① 整族笔记工具不在面上  ② `--no-notes`（= 装配面里没有笔记工具）
//   ③ 有工具但账本里没有成功的写入  ④ 写过又被 `note_forget` 撤销
// ⇒ 输出文本里**不含**无条件 `note_*` 指令，且含重读指引。
//   ⑤ 证据有效**且** `retrievalCommandFor` 真给出命令 ⇒ 才出现那条命令。
// 断言一律打在「有没有 note_」「有没有重读」「命令是不是 retrievalCommandFor 给的那一条」这三件事上，
// **不锁整段原文**（否则下一次改措辞就是假红，工单验收 2）。
//
// 第六处（S3 `src/reflection/governor.js` 的 memory-loss 提醒）是工单点名的**低风险档**：
// 它不命令调用工具，也不该断言笔记必然存在 ⇒ 只要求「条件式措辞 + 不声称召回成功」，
// **不套整族证据门**（工单原话：那是过度工程）。
//
// 环境纪律：零真实 LLM、不写盘、不碰 `~/.erix`。

import assert from "node:assert/strict";
import test from "node:test";

import { aggregateStubText } from "../src/loop/aggregate-budget.js";
import {
  NOTE_HINT_GATES,
  hasNoteToolSurface,
  noteRecallHint,
} from "../src/loop/note-prompt-hint.js";
import { NOTE_RECALL_REASONS, noteToolNamesOnSurface } from "../src/loop/tool-result-ttl.js";
import { decideRoundAction } from "../src/reflection/governor.js";
import { buildArchiveNotice, buildCliToolsSystemPrompt } from "../bin/tools.js";
import { buildCliSystemPrompt, notesOnToolSurface } from "../bin/system-prompt.js";

// —— 夹具 ——

/** 整族在面上（`--no-notes` 的反面）。 */
const NOTE_TOOLS = ["note_take", "note_list", "note_read"];
/** 装配面里一个笔记工具都没有（判据①/②）。 */
const NO_NOTE_TOOLS = ["readFile", "exec"];

const NOTE_WRITE_OK = JSON.stringify({ status: "found", action: "saved", key: "k-1", scope: "run" });
const NOTE_FORGET_OK = JSON.stringify({ status: "revoked", key: "k-1" });

/** 一次 readFile 调用（可确定性重算 ⇒ retrievalCommandFor 给得出命令），可选带一条笔记写入/撤销。 */
function ledger({ noteWrite = false, revoked = false } = {}) {
  return [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "readFile", input: { path: "src/a.js", offset: 40, limit: 80 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "BODY" }] },
    ...(noteWrite || revoked ? [
      { role: "assistant", content: [{ type: "tool_use", id: "n1", name: "note_take", input: { key: "k-1", content: "结论" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: NOTE_WRITE_OK }] },
    ] : []),
    ...(revoked ? [
      { role: "assistant", content: [{ type: "tool_use", id: "n2", name: "note_forget", input: { key: "k-1" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "n2", content: NOTE_FORGET_OK }] },
    ] : []),
  ];
}

/** 四种「没有笔记可指」的输入（判据①②③④）+ 第五种「证据有效」。 */
const NO_EVIDENCE_CASES = [
  { label: "①整族笔记工具不在面上", noteTools: NO_NOTE_TOOLS, messages: ledger({ noteWrite: true }), reason: NOTE_RECALL_REASONS.noSurface },
  { label: "②--no-notes（面上一个笔记工具都没有）", noteTools: [], messages: ledger({ noteWrite: true }), reason: NOTE_RECALL_REASONS.noSurface },
  { label: "③有工具但账本里没有成功写入", noteTools: NOTE_TOOLS, messages: ledger(), reason: NOTE_RECALL_REASONS.emptyNotes },
  { label: "④写过又被 note_forget 撤销", noteTools: NOTE_TOOLS, messages: ledger({ revoked: true }), reason: NOTE_RECALL_REASONS.revoked },
];

/** 一条取回指引的边界断言（不锁原文）：`note_*` 不许出现、必须有重读、必须有原因。 */
function assertNoUnconditionalNoteHint(label, text) {
  assert.equal(
    /note_(take|list|read)/u.test(text),
    false,
    `${label}：无证据时模型可见文本里不许出现 note_*（现文：${text}）`,
  );
  assert.match(text, /重读|只读方式复核/u, `${label}：必须给出重读 / 只读复核这条退路（现文：${text}）`);
}

// ─────────── 共用派生器本身（六处都从它取文案，故它的四格先钉住） ───────────

test("noteRecallHint：四格无证据都走 noEvidence 门，并各自报出原因", () => {
  for (const c of NO_EVIDENCE_CASES) {
    const hint = noteRecallHint({ noteTools: c.noteTools, messages: c.messages, toolName: "readFile", toolInput: { path: "src/a.js", offset: 40, limit: 80 } });
    assert.equal(hint.gate, NOTE_HINT_GATES.noEvidence, c.label);
    assert.equal(hint.available, false, c.label);
    assert.equal(hint.reason, c.reason, `${c.label}：原因必须是那一格的字面`);
    assertNoUnconditionalNoteHint(c.label, hint.clause);
  }
});

test("noteRecallHint：证据有效才走 note 门；命令只在 retrievalCommandFor 真给出时出现", () => {
  const withCommand = noteRecallHint({
    noteTools: NOTE_TOOLS,
    messages: ledger({ noteWrite: true }),
    toolName: "readFile",
    toolInput: { path: "src/a.js", offset: 40, limit: 80 },
  });
  assert.equal(withCommand.gate, NOTE_HINT_GATES.noteEvidence);
  assert.match(withCommand.clause, /note_list[\s\S]*note_read/u, "有证据 ⇒ 才给 note-first 指引");
  // 命令逐字来自 retrievalCommandFor（offset 是 0 基行号 ⇒ 从 41 起，窗口 80 行）。
  assert.equal(withCommand.command, "sed -n '41,120p' 'src/a.js'");
  assert.ok(withCommand.clause.includes(withCommand.command), "给出的命令必须逐字进文案，不许被改写或另拼");

  // exec 类：retrievalCommandFor 认不出来 ⇒ **一个 `sed` 也不许多出来**（#741 第一轮被抓的编造形状）。
  const execCall = noteRecallHint({
    noteTools: NOTE_TOOLS,
    messages: ledger({ noteWrite: true }),
    toolName: "exec",
    toolInput: { command: "npm test" },
  });
  assert.equal(execCall.command, undefined);
  assert.equal(execCall.clause.includes("sed"), false, `拼不出命令就不许出现 sed（现文：${execCall.clause}）`);

  // MCP 工具带着 path/limit 也算不出来（它的 limit 是命中条数，不是行数）——同一条退路。
  const mcpCall = noteRecallHint({
    noteTools: NOTE_TOOLS,
    messages: ledger({ noteWrite: true }),
    toolName: "mcp__server__search",
    toolInput: { path: "docs/a.md", limit: 5 },
  });
  assert.equal(mcpCall.command, undefined, "MCP 的 path/limit 是它自己的语义，拼成 sed 会指到别的行");
});

test("hasNoteToolSurface：整族全有才为真（口径与 resolveNoteRecall 同侧）", () => {
  assert.equal(hasNoteToolSurface(NOTE_TOOLS), true);
  assert.equal(hasNoteToolSurface(["note_list", "note_read"]), false, "缺 note_take ⇒ 整族不算在场");
  assert.equal(hasNoteToolSurface(undefined), false, "没给工具面 = 不知道 = 不为真");
  assert.equal(hasNoteToolSurface(NO_NOTE_TOOLS), false);
  // 与 #741 的抽取器同源（现推，不手抄名单）。
  assert.deepEqual(
    noteToolNamesOnSurface([{ name: "note_take" }, { name: "note_list" }, { name: "note_read" }, { name: "exec" }]),
    NOTE_TOOLS,
  );
});

// ───────────────── S1：单轮聚合超限桩（src/loop/aggregate-budget.js） ─────────────────

test("S1 聚合超限桩：四格无证据 ⇒ 不提 note_*，改说重读；第五格才给指引", () => {
  for (const c of NO_EVIDENCE_CASES) {
    const stub = aggregateStubText({
      round: 3,
      length: 90_000,
      retrieval: noteRecallHint({ noteTools: c.noteTools, messages: c.messages, toolName: "exec", toolInput: { command: "npm test" } }),
    });
    assert.match(stub, /超单轮聚合预算/u, `${c.label}：桩本身的事实不许丢`);
    assertNoUnconditionalNoteHint(`S1 ${c.label}`, stub);
  }
  const evidenced = aggregateStubText({
    round: 3,
    length: 90_000,
    retrieval: noteRecallHint({
      noteTools: NOTE_TOOLS,
      messages: ledger({ noteWrite: true }),
      toolName: "readFile",
      toolInput: { path: "src/a.js", offset: 0, limit: 120 },
    }),
  });
  assert.match(evidenced, /先用 note_list 查找记录，再用 note_read 读取/u);
  assert.match(evidenced, /sed -n '1,120p' 'src\/a\.js'/u, "有证据且 retrievalCommandFor 给出命令 ⇒ 命令在场");
});

test("S1 反证：不传 retrieval 时**不**默认「有笔记」（fail-closed，与 #741 同纪律）", () => {
  const stub = aggregateStubText({ round: 1, length: 10 });
  assertNoUnconditionalNoteHint("S1 缺省 retrieval", stub);
  assert.match(stub, new RegExp(`原因：${NOTE_RECALL_REASONS.unknown}`, "u"), "缺省那一走的是「无笔记证据」，不是「有笔记」");
});

// ─────────── S2：run snapshot 的逐条超限桩（src/loop/run-snapshot-executor.js） ───────────
// 这一处的文案与 S1 同句式，但**证据来源不同**（`ctx.noteTools` ← orchestrator 现推、`ctx.messages` ←
// 可见账本），所以格子也各打各的。见 `test/prompt-note-evidence-source-746.test.js`：它跑真 run，
// 钉「宿主没给笔记工具 ⇒ 桩里一个 note_* 都没有」。这里先钉派生器接进去后的行为面。

test("S2 逐条超限桩与 S1 同源：同一格同一句（不留第二份措辞）", () => {
  for (const c of NO_EVIDENCE_CASES) {
    const hint = noteRecallHint({ noteTools: c.noteTools, messages: c.messages });
    const viaS1 = aggregateStubText({ round: 1, length: 1, retrieval: hint });
    assert.equal(viaS1.includes("note_"), false, `S2/S1 同源：${c.label} 两处都得闭嘴`);
    assert.match(viaS1, /重读|只读方式复核/u);
  }
});

// ─────────────── S3：memory-loss 提醒（src/reflection/governor.js，低风险档） ───────────────

test("S3 memory-loss 提醒：措辞改条件式，不命令调工具、不声称召回成功（**不套证据门**）", () => {
  const action = decideRoundAction({ memoryLoss: true });
  assert.equal(action.kind, "nudge");
  assert.equal(action.reason, "memoryLoss");
  const text = action.text;
  // ① 不得出现无条件动词（旧文：「需要早期精确值时先用 note_list 查找，再用 note_read 读取」）。
  assert.equal(
    /(先|立刻|请)\s*(用\s*)?note_/u.test(text),
    false,
    `S3 不许再出现无条件动词 + note_*（现文：${text}）`,
  );
  // ② 不得声称召回成功 / 不得断言笔记必然存在。
  assert.equal(/已记录|已记下|要点见|已在笔记/u.test(text), false, `S3 不许声称召回成功（现文：${text}）`);
  // ③ 必须是条件式（「如有…」那类限定词）并给重读退路。
  assert.match(text, /如有|若有|如本 run 有/u, `S3 的笔记那半句必须是条件式（现文：${text}）`);
  assert.match(text, /重读/u, `S3 要给重读退路（现文：${text}）`);
  // ④ 提醒本身的既有事实（任务仍在进行 + 回顾任务指令）不许丢——这是它存在的理由。
  assert.match(text, /任务仍在进行中/u);
  assert.match(text, /任务指令/u);
});

// ────────────────── B1：`bin/` 的系统提示与归档提示（三处） ──────────────────

test("B1 CLI 系统提示：`--no-notes` 面 ⇒ 三处一个 note_* 都不出现，且给了重读退路", () => {
  const prompt = buildCliToolsSystemPrompt({ notes: false });
  assert.equal(/note_/u.test(prompt), false, `notes:false 时提示词里不许有任何 note_*（现文：${prompt}）`);
  assert.match(prompt, /重读源文件/u, "没有笔记工具时必须给「重读源文件」这条真路");
  // 事实面（上下文会折叠 / 会真的忘）不许被顺手删掉——那是它整段的存在理由。
  assert.match(prompt, /上下文会被折叠/u);
  assert.match(prompt, /具体数值必须来自当前工具返回，不得编造/u, "「数值来源」那条 bullet 也不许留 note_read");
});

test("B1 缺省（有笔记工具面）逐字节不变 ⇒ 这条改动不是拿默认路径改措辞", () => {
  assert.equal(buildCliToolsSystemPrompt(), buildCliToolsSystemPrompt({ notes: true }));
  const d = buildCliToolsSystemPrompt();
  assert.match(d, /立刻 note_take/u);
  assert.match(d, /先 note_list 再 note_read/u);
  assert.match(d, /具体数值必须来自当前工具返回或 note_read/u);
});

test("B1 归档提示：`notes:false` 不提笔记，缺省逐字不变", () => {
  const off = buildArchiveNotice("/tmp/arc", { notes: false });
  assert.equal(/note_/u.test(off), false, `归档提示不许留 note_*（现文：${off}）`);
  assert.match(off, /重读源文件/u);
  assert.match(buildArchiveNotice("/tmp/arc"), /先用 note_list 查找记录，再用 note_read 读取/u);
  assert.equal(buildArchiveNotice(undefined, { notes: false }), "", "没有归档目录时一个字节都不许多");
});

test("B1 装配：`tools` 是**真工具面**，不是旗标 —— --tools 滤掉笔记时提示词跟着闭嘴", () => {
  const withNotes = [{ name: "readFile" }, { name: "note_take" }, { name: "note_list" }, { name: "note_read" }];
  const filteredOut = [{ name: "readFile" }, { name: "exec" }];
  assert.equal(notesOnToolSurface(withNotes), true);
  assert.equal(notesOnToolSurface(filteredOut), false);
  assert.equal(notesOnToolSurface(undefined), false);

  const prompt = buildCliSystemPrompt({ cwd: "/tmp", tools: filteredOut, archiveDir: "/tmp/arc" }).systemPrompt;
  assert.equal(/note_/u.test(prompt), false, "工具面被滤掉 ⇒ 系统提示 + 归档提示都不许提笔记");
  assert.match(prompt, /重读源文件/u);
  // 没表态（不传 `tools`）= 缺省「有」⇒ 既有宿主与 golden 逐字节不变。
  const untouched = buildCliSystemPrompt({ cwd: "/tmp" }).systemPrompt;
  assert.match(untouched, /先 note_list 再 note_read/u);
  // 整族不全（只有 note_read）也算不在场：口径与 `resolveNoteRecall` 同一把尺（全有或全无）。
  assert.equal(notesOnToolSurface([{ name: "note_read" }]), false);
});

// ──────── S2 的证据来源：真跑一轮，钉「桩里的文案跟着宿主工具面走」（不是旗标、不是假设） ────────

const { runDirect } = await import("./helpers/run-direct.js");
const { createFakeProvider } = await import("./helpers/fake-provider.js");
const { createMemoryTranscriptStore } = await import("../src/store/memory.js");

const HUGE = Array.from({ length: 900 }, (_, i) => `line-${i}: fillertext`).join("\n");

/**
 * 跑一轮「大输出 ⇒ 逐条超限桩」，返回那条桩文本。
 * `surface` 是**宿主给引擎的工具面**（`runToolLoop({ tools })`）——这正是 S1/S2 的证据入口：
 * orchestrator 用它算 `noteToolSurface`（`src/loop/orchestrator.js`），桩文案从它派生。
 * `noteWrite` = 账本里先来一次成功的 `note_take`（第二格与第五格的分界）。
 *
 * @param {{ surface: Array<{ name: string }>, noteWrite: boolean }} spec
 * @returns {Promise<string>}
 */
async function runHygieneStub({ surface, noteWrite }) {
  const provider = createFakeProvider([
    ...(noteWrite
      ? [{ content: [{ type: "tool_use", id: "n1", name: "note_take", input: { key: "k-1", content: "结论" } }], stopReason: "tool_use" }]
      : []),
    { content: [{ type: "tool_use", id: "big-1", name: "big", input: { path: "src/a.js" } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const result = await runDirect({
    provider,
    initialUserMessage: "go",
    executeTool: async (options) => (options.name === "note_take" ? NOTE_WRITE_OK : HUGE),
    store: createMemoryTranscriptStore(),
    runId: "issue-746",
    completion: false,
    tools: surface,
  });
  const block = result.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((candidate) => candidate?.type === "tool_result" && candidate.tool_use_id === "big-1");
  return String(block?.content);
}

test("S2 真跑：宿主没给笔记工具 ⇒ 逐条超限桩里一个 note_* 都没有（旧行为是硬写一句）", async () => {
  const stub = await runHygieneStub({ surface: [{ name: "readFile" }, { name: "exec" }], noteWrite: false });
  assert.match(stub, /完整输出已由引擎归档/u, "桩本身的事实不许丢");
  assertNoUnconditionalNoteHint("S2 真跑·无笔记工具面", stub);
});

test("S2 真跑：整族在面上**且**账本有成功写入 ⇒ 才给 note_list / note_read 指引", async () => {
  const stub = await runHygieneStub({
    surface: [{ name: "readFile" }, { name: "note_take" }, { name: "note_list" }, { name: "note_read" }],
    noteWrite: true,
  });
  assert.match(stub, /先用 note_list 查找记录，再用 note_read 读取/u);
  assert.equal(/无可复原的决策记录/u.test(stub), false, "有证据 ⇒ 不该出现未知口径");
});

// ─────── B2 / B3：guard 侧（`bin/final-guard.js` / `bin/final-guard-support.js`）的三格 ───────
// 这一族**拿不拿得到账本**决定了它该说哪一种话，所以三格都打：有写入 / 面上有但账本没递到 / 无工具面。

const { buildCaptureStub } = await import("../bin/final-guard-support.js");
const { buildCaptureRecoveryHint } = await import("../bin/final-guard.js");

const foldedMessage = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "c1", content: "nonce=gold-4173\n" }],
};

test("B3 折叠桩：无笔记工具面 ⇒ 后缀不提 note_*；有整族但账本没递到 ⇒ 只说条件式；有写入 ⇒ note-first", async () => {
  const noSurface = await buildCaptureStub(foldedMessage, { noteTools: [], messages: ledger({ noteWrite: true }) });
  assert.equal(/note_/u.test(noSurface), false, `无工具面 ⇒ 不许指不存在的工具（现文：${noSurface}）`);
  assert.match(noSurface, /重读源文件/u);
  // 原因**全文**在 #741 的 TTL 占位符里；折叠桩是受预算保护的受保护消息，这里只要求它如实说
  // 「没有可复原的记录」，四格原因由上面 `noteRecallHint` 那几格直接断言（同一口径，两种长度）。
  assert.match(noSurface, /无可复原的笔记记录/u, "无证据那一份不许把「不知道」省成「有记录」");

  // 面上有整族、但折叠钩子**没有账本可看**（`messages` 缺席）⇒ 条件式，不许伪报「有记录」。
  assert.equal(hasNoteToolSurface(NOTE_TOOLS), true);
  const surfaceOnly = noteRecallHint({ noteTools: NOTE_TOOLS });
  assert.equal(surfaceOnly.gate, NOTE_HINT_GATES.notesAvailable);
  assert.match(surfaceOnly.shortClause, /如本 run 写过笔记/u);
  assert.match(surfaceOnly.shortClause, /重读源文件/u);
  assert.equal(/已记录|要点见|已在笔记/u.test(surfaceOnly.shortClause), false, "账本缺席时不许伪报有记录");

  const evidenced = await buildCaptureStub(foldedMessage, {
    noteTools: NOTE_TOOLS,
    messages: ledger({ noteWrite: true }),
  });
  assert.match(evidenced, /note_list[\s\S]*note_read/u);
});

test("B2 guard 的 run 状态摘要：三格同一口径（无工具面 / 有面无写入 / 有写入）", async () => {
  const store = { load: async () => [{ round: 1, messages: ledger({ noteWrite: true }) }] };
  const emptyStore = { load: async () => [{ round: 1, messages: ledger() }] };
  const withNotes = await buildCaptureRecoveryHint({
    foldedPayload: [foldedMessage], store, runId: "r", noteTools: NOTE_TOOLS,
  });
  assert.match(withNotes, /note_list[\s\S]*note_read/u);
  const noWrite = await buildCaptureRecoveryHint({
    foldedPayload: [foldedMessage], store: emptyStore, runId: "r", noteTools: NOTE_TOOLS,
  });
  assert.equal(/note_/u.test(noWrite), false, `有工具面但账本无写入 ⇒ 不伪报（现文：${noWrite}）`);
  const noSurface = await buildCaptureRecoveryHint({
    foldedPayload: [foldedMessage], store, runId: "r", noteTools: [],
  });
  assert.equal(/note_/u.test(noSurface), false, `无工具面 ⇒ 不指不存在的工具（现文：${noSurface}）`);
  assert.match(noSurface, /重读/u);
});
