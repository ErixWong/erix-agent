// @ts-check
// issue #894 —— 「本折增量」的正文必须与它自己写出的 `from/to/rounds` 自洽。
//
// ── 判据是什么 ────────────────────────────────────────────────────────────────────────
// 同一次压缩里，安全层 `safeTruncateMessages` 会把**被降级的受保护消息**追加进总 `foldedPayload`
// （`src/loop/orchestrator.js` 安全层那一发），但 `foldedRoundRange` / `foldedRounds` **不跟着涨**。
// 于是「用此刻的全量 `foldedPayload` 现算正文、却用不涨的区间声明 from/to/count」的写法，会让
// 增量正文覆盖到**它自己声明的区间之外**的轮次。实测实物（修复前，本夹具）：
//   `foldedFacts.increment` 声明 `from=1,to=6,rounds=6`，正文却写着
//   「早期第 1–6 轮（共 6 轮）已折叠。工具足迹：**PROCTOOL_R7**×1 …」——`PROCTOOL_R7` 属第 7 轮
//   = 受保护轮 = 区间外。
// ⇒ 判据：**增量正文里出现的轮次标记必须全部落在该增量自己声明的 [from,to] 之内**。
//   （夹具里第 7、8 轮的 assistant 带 `PROCTOOL_R<n>`，第 1–6 轮带 `tool_R<n>`，正文里的工具名
//   就是可观察的「轮次标记」；判据把它抽成 `mentionedRounds()`，两个方向都钉：既不许 `> to`，
//   也不许 `< from`。）
//
// ── 为什么必须同时钉 ⓪ 与 ③ ──────────────────────────────────────────────────────────
// 越界正文有**两个产生点**，形状完全相同（读全量 `foldedPayload`，`from/to/count` 取不涨的区间）：
//   ⓪ `incrementText` 的 `budgetFallbackFoldedRounds > 0` 那一支（配置策略折不够 ⇒ 引擎预算兜底
//     接手折轮，本折实际删掉的是「策略那一折 + 兜底那一折」的并集，#873 之后这一格变常见）；
//   ③ 落到 `computeFactsFallbackText()` 那一支（无兜底折轮时，**默认策略 = 滑窗**就走这里）。
// 上一轮的修法只切了 ⓪，③ 原封不动 ⇒ 默认策略（绝大多数用户的默认路径）照样越界。
// ⇒ 两个格子各自钉一条路径，并且**各自断言自己走的是哪一支**（判据见 `assertBranchIs0` /
//   `assertBranchIs3`）：
//   · ⓪ 的条件是「预算兜底真折了轮」，而 `src/loop/orchestrator.js:4492` 那个
//     `observeCompactionLayer` **只在** `fallback.foldedRounds > 0` 时写 `layers.slidingWindow`
//     ⇒ 配的是 `fold-llm`、却同时出现 `foldLlm` + `slidingWindow` 两层观测，就是 ⓪ 的充分证据；
//   · ③ 反过来证伪 ⓪：入口那一发已把**全部**不受保护轮折完（区间跨度与 `foldedRounds` 都等于
//     不受保护轮数），兜底既不折受保护轮也不重折已折的 ⇒ `budgetFallbackFoldedRounds = 0`
//     ⇒ 正文只能出自 `computeFactsFallbackText()`。
//   两条分支在本夹具里吐出的正文**逐字相同**（实测两份 `increment.text` 完全一样，`noteTools`
//   的差异不改变措辞），所以只能靠上面这两条**观察面**区分；不写它们，「只修 ⓪」的人会把
//   ③ 的红误读成 ⓪ 的红。
//
// ── 变异格（改动方向一旦被改坏，哪一格会红）────────────────────────────────────────────
//   M1 快照取点太晚（在安全层之后才切，或干脆不切、继续读全量 `foldedPayload`）
//      ⇒ 格子 1 与格子 2 同时红（正文重新含 `PROCTOOL_R7`）。
//   M2 只切 ⓪、不切 ③ ⇒ 格子 1 绿、**格子 2 红**（这一格存在的唯一理由）。
//   M3 只切 ③、不切 ⓪ ⇒ 格子 1 红、格子 2 绿。
//   M4 把归档 `buildFoldedRecordArchive` 或折叠身份 `foldSummaryFingerprint` 也改成读快照
//      ⇒ **格子 3** 红（契约面被拿去做内部自洽：`foldId` 变了、归档里再没有安全层降级的原文）。
//   M5 新键 `safetyDowngrade` 的轮号取错源（数数组下标 / 用全 run 轮号 / 用折叠区间），
//      或「无事实也写键」（写 `[]` / `0`）⇒ **格子 4** 红。
//   M6 字节上界硬编码（不复用 `FOLDED_FACTS_MAX_BYTES`）⇒ 格子 4 的尺寸断言会漂移；
//      上界口径与本仓其余折叠事实同源于 `src/compact/fold-summary-journal.js`。
//
// 夹具蓝本：上一轮取证探针 `test/compact/probe-894-reference.txt`（本文件照它改写，断言方向反过来，
// 蓝本本身不进主干）。零真实 LLM、内存 store（不碰 `~/.erix` / `~/.pi`）、数值一律现算
// （`estimateMessageTokens`），只有「反向证 A」那两个归档摘要值是修复前登记的常量（见该格注释）。

import assert from "node:assert/strict";
import test from "node:test";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  FOLDED_FACTS_INCREMENT_KEY,
  FOLDED_FACTS_MAX_BYTES,
  FOLDED_FACTS_RECORD_FIELD,
  foldSummaryFingerprint,
  stableFingerprint,
} from "../../src/compact/fold-summary-journal.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { estimateMessageTokens } from "../../src/tokens.js";
import { createFakeProvider } from "../helpers/fake-provider.js";
import { runDirect } from "../helpers/run-direct.js";

// ── 夹具（蓝本逐字搬来，只改断言方向）──────────────────────────────────────────────────

// CJK ≈ 3 字节/字，只用于把「想要的量级」翻成 filler 字数；真实判据全用现算 token。
const filler = (bytes) => "填".repeat(Math.max(0, Math.ceil(bytes / 3)));

// 受保护轮的轮号：这些轮的 assistant 带 `PROCTOOL_R<n>` tool_use ⇒ 被 `protectedMessage` 命中，
// 永不被策略/兜底折掉，所以它们的轮号恒 > `foldedRoundRange.to`。
const PROTECTED_ROUNDS = [7, 8];
const TOOL_TURNS = 8;
const TOOL_RESULT_BYTES = 150;
const BUDGET_TOKENS = 3000;
const PROTECTED_ASSISTANT_BYTES = 3000;
// ⓪ 分支才会传 `noteTools`；③ 不传——但两者在本夹具里吐的正文逐字相同，所以**不能**拿正文
// 措辞当分支身份，必须用下面 `assertBranchIs0` / `assertBranchIs3` 那两条观察面。
// 不受保护轮数 = 总工具轮 − 受保护轮 = 6：③ 那一格拿它证伪「预算兜底折了轮」。
const UNPROTECTED_ROUNDS = TOOL_TURNS - PROTECTED_ROUNDS.length;

function buildRun({ runId, strategy, budgetTokens, protectedAssistantBytes }) {
  const protectedSet = new Set(PROTECTED_ROUNDS);
  const toolNameFor = (n) => (protectedSet.has(n) ? `PROCTOOL_R${n}` : `tool_R${n}`);
  const steps = Array.from({ length: TOOL_TURNS }, (_unused, i) => {
    const n = i + 1;
    const toolUse = { type: "tool_use", id: `tu_${n}`, name: toolNameFor(n), input: { index: n } };
    return protectedSet.has(n)
      ? { content: [{ type: "text", text: `PTXT${n} ${filler(protectedAssistantBytes)}` }, toolUse], stopReason: "tool_use" }
      : { content: [toolUse], stopReason: "tool_use" };
  });
  const provider = createFakeProvider([...steps, { content: [{ type: "text", text: "收尾" }], stopReason: "end_turn" }]);
  const store = createMemoryTranscriptStore();
  const executeTool = async ({ input }) => `R${input?.index} ${filler(TOOL_RESULT_BYTES)}`;
  const protectedMessage = (message) => (
    (Array.isArray(message?.content) ? message.content : [])
      .some((block) => block?.type === "tool_use" && String(block?.name ?? "").startsWith("PROCTOOL"))
  );
  const promise = runDirect({
    runId,
    provider,
    seed: `start ${filler(300)}`,
    store,
    executeTool,
    maxRounds: TOOL_TURNS + 4,
    capabilities: {
      hooks: { protectedMessage },
      ...(strategy === undefined ? {} : { ports: { strategy } }),
    },
    // `workingSetRecentRounds` 不给 ⇒ 默认 0（#612）⇒ `budgetBelowWorkingSet` 那条 #608 闸门恒不成立
    // ⇒ 安全层一定动手（这是 #894 可达性的前提之一）。
    config: { folding: { context: { budgetTokens, keepRounds: 0 } }, run: { completion: false } },
  });
  return { promise, store };
}

async function collect(store, runId) {
  const records = await store.load(runId);
  const compactions = [];
  const folds = [];
  for (const record of records) {
    const stats = Array.isArray(record?.compactionStats)
      ? record.compactionStats
      : record?.compactionStats ? [record.compactionStats] : [];
    for (const stat of stats) compactions.push({ round: record.round, ...stat });
    const facts = record?.[FOLDED_FACTS_RECORD_FIELD];
    if (facts) folds.push({ round: record.round, record, facts, increment: facts[FOLDED_FACTS_INCREMENT_KEY] });
  }
  return { records, compactions, folds };
}

async function runFixture({ label, runId, strategy, budgetTokens = BUDGET_TOKENS, protectedAssistantBytes = PROTECTED_ASSISTANT_BYTES }) {
  const { promise, store } = buildRun({ runId, strategy, budgetTokens, protectedAssistantBytes });
  await promise;
  return { label, store, ...(await collect(store, runId)) };
}

// 夹具前提自检（现算，不写死 token 数）：单条受保护消息 < 预算、两条合起来 > 预算
// ⇒ 策略与兜底都折不动它 ⇒ 只有安全层会去降级它（= #894 的触发面）。
function assertFixturePremises(budgetTokens, protectedAssistantBytes) {
  const single = estimateMessageTokens([{
    role: "assistant",
    content: [
      { type: "text", text: `PTXT7 ${filler(protectedAssistantBytes)}` },
      { type: "tool_use", id: "tu_7", name: "PROCTOOL_R7", input: { index: 7 } },
    ],
  }]);
  assert.ok(single < budgetTokens,
    `夹具前提：单条受保护消息必须 < 预算（现算 single=${single} budget=${budgetTokens}）`);
  assert.ok(2 * single > budgetTokens,
    `夹具前提：两条受保护合起来必须 > 预算（现算 two=${2 * single} budget=${budgetTokens}）`);
  return { singleProtectedTokens: single, twoProtectedTokens: 2 * single };
}

// #894 场景（Q1）：同一次压缩内「滑窗那一发真折了轮」且「安全层真降级」（唯一无歧义观察面）。
function findQ1(compactions) {
  return compactions.find((compaction) => (
    (compaction.protectedDowngraded ?? 0) > 0
    && compaction.layers?.slidingWindow?.triggered
    && compaction.foldedRounds > 0
  ));
}

// 增量正文里出现的轮次标记（工具名自带轮号：`tool_R<n>` / `PROCTOOL_R<n>`）。
function mentionedRounds(text) {
  return [...String(text ?? "").matchAll(/(?:PROCTOOL_R|tool_R)(\d+)/g)].map((m) => Number(m[1]));
}

// ⓪ 的分支身份（只在配置策略 = `fold-llm` 时可用）：配的是 `fold-llm`，`layers.slidingWindow`
// 那一发只可能是引擎预算兜底，而 `orchestrator.js:4492` 仅在 `fallback.foldedRounds > 0` 时
// 才写这一层观测 ⇒ 两层同时 triggered = ⓪ 的条件（`budgetFallbackFoldedRounds > 0`）成立。
function assertBranchIs0(label, q1) {
  assert.ok(q1.layers?.foldLlm?.triggered, `${label} 分支身份：配置策略 fold-llm 确实折过`);
  assert.ok(q1.layers?.slidingWindow?.triggered,
    `${label} 分支身份：配的是 fold-llm，却同时出现 slidingWindow 观测 ⇒ 那是预算兜底且它真折了轮`
    + "（orchestrator.js:4492 只在 fallback.foldedRounds>0 时写）⇒ 本格走的是 ⓪");
}

// ③ 的分支身份（默认策略 = 滑窗）：用「区间跨度与折轮数都等于不受保护轮数」证伪 ⓪ 的条件
// ⇒ 兜底无轮可折 ⇒ 正文只能出自 `computeFactsFallbackText()`（只修 ⓪ 不算修这一格）。
function assertBranchIs3(label, q1, increment) {
  assert.ok(q1.layers?.slidingWindow?.triggered, `${label} 分支身份：滑窗那一发折过`);
  assert.ok(!q1.layers?.foldLlm?.triggered,
    `${label} 分支身份：本格没有 fold-llm 层 ⇒ slidingWindow 观测可能来自入口那一发，不能反推兜底折轮`);
  assert.equal(increment.to - increment.from + 1, UNPROTECTED_ROUNDS,
    `${label} 分支身份：本折区间必须正好覆盖全部 ${UNPROTECTED_ROUNDS} 个不受保护轮 ⇒ 兜底无轮可折`
    + " ⇒ budgetFallbackFoldedRounds>0 为假 ⇒ 正文出自 computeFactsFallbackText（③）");
  assert.equal(q1.foldedRounds, UNPROTECTED_ROUNDS, `${label} 分支身份：折的轮数必须等于不受保护轮数`);
}

// 一条格里跑完「夹具前提 → 分支身份 → 判据」三步，红的是哪一步由断言消息区分。
async function assertIncrementStaysInsideItsOwnRange({ label, runId, strategy, branch }) {
  assertFixturePremises(BUDGET_TOKENS, PROTECTED_ASSISTANT_BYTES);
  const { compactions, folds } = await runFixture({ label, runId, strategy });

  const q1 = findQ1(compactions);
  assert.ok(q1,
    `${label} 夹具前提：存在同一次压缩「滑窗折轮 foldedRounds>0」且 protectedDowngraded>0 ⇒ #894 场景成立`);
  const fold = folds.find((candidate) => candidate.round === q1.round);
  assert.ok(fold?.increment, `${label} 夹具前提：该折写了 ${FOLDED_FACTS_RECORD_FIELD}.${FOLDED_FACTS_INCREMENT_KEY}`);
  const increment = fold.increment;
  const text = String(increment.text ?? "");
  // 越界素材确实在场（安全层真把那条受保护消息追加进了全量归档）⇒ 判据不是空转。
  // 不能拿「增量正文里含 PROCTOOL」当前提：修好了它就不含了。
  assert.ok(JSON.stringify(stripVolatile(fold.record?.foldedPayload ?? [])).includes("PROCTOOL_R7"),
    `${label} 夹具前提：被安全层降级的那条已进了总 foldedPayload（越界素材在场）`);

  if (branch === "0") {
    assertBranchIs0(label, q1);
  } else {
    assertBranchIs3(label, q1, increment);
  }

  const outside = [...new Set(mentionedRounds(text))]
    .filter((round) => round < (increment.from ?? 1) || round > increment.to);
  assert.deepEqual(outside, [],
    `${label} #894 判据：增量正文不得含声明区间 from=${increment.from} to=${increment.to}`
    + `（rounds=${increment.rounds}）之外的轮次，实测越界轮=${JSON.stringify(outside)}`);
}

// ── 格子 3 的常量：修复前（基点 e3b91fbb，未改源码）登记的归档摘要 ──────────────────────
// 折叠身份 `foldId` 与轮记录归档 `foldedPayload` 里带一个每次进程随机的 `toolCallKey`，
// ⇒ 不能硬编码原始 sha256，必须先递归剔掉 `toolCallKey` 再取 `stableFingerprint`
// （归一化后的值在本夹具里跨进程稳定，已连跑两次 diff 证实）。
// 这两个常量的来源 = 修复前跑同一夹具（(a) 与 (b) 归档同一份）实测所得：
//   fingerprint `sha256:ad7da330d36ac60e331fdf83` / bytes 5534 / 条数 13（末条 = 第 7 轮
//   assistant(`PROCTOOL_R7`)，正是安全层追加进总 `foldedPayload` 的那一条）。
// 「修复前后逐字相同」= 这两格断言的是**契约面**：归档内容、以及由归档算出的折叠身份，
// 都不许因为内部自洽修复而变化（快照只喂增量）。
const PREFIX_ARCHIVE_DIGEST = {
  fingerprint: "sha256:ad7da330d36ac60e331fdf83",
  bytes: 5534,
  count: 13,
};

// 随机量 `toolCallKey` 不参与比对（其余逐字保留）。
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "toolCallKey") continue;
      out[key] = stripVolatile(nested);
    }
    return out;
  }
  return value;
}

// ── 格子 1：⓪ 路径（配置策略 = fold-llm ⇒ slidingWindow 那一发必是引擎预算兜底）──────────
test("#894 ⓪ 路径（配置策略 fold-llm + 预算兜底折轮）：增量正文不得含声明区间外的轮次", async () => {
  await assertIncrementStaysInsideItsOwnRange({
    label: "(a) fold-llm ⓪",
    runId: "p894-a-foldllm",
    strategy: createFoldLlmStrategy({ summarizer: async () => `## 阶段\nLLM_SUMMARY\n${"s".repeat(200)}` }),
    branch: "0",
  });
});

// ── 格子 2：③ 路径（默认策略 = 滑窗 ⇒ 落进 `computeFactsFallbackText()`）────────────────
// 专门钉「上一轮只修 ⓪ 会漏」：这一格的夹具与格子 1 只差一个策略配置，越界正文却来自另一个函数。
test("#894 ③ 路径（默认滑窗策略 → computeFactsFallbackText）：增量正文不得含声明区间外的轮次", async () => {
  await assertIncrementStaysInsideItsOwnRange({
    label: "(b) 默认滑窗 ③",
    runId: "p894-b-default",
    strategy: undefined,
    branch: "3",
  });
});

// ── 格子 3：反向证 A —— 不拿契约面换内部自洽 ──────────────────────────────────────────
test("#894 反向证A（不改契约）：foldId 仍由全量归档算出、轮记录 foldedPayload 逐字不变", async () => {
  for (const { label, runId, strategy } of [
    {
      label: "(a) fold-llm",
      runId: "p894-a-foldllm",
      strategy: createFoldLlmStrategy({ summarizer: async () => `## 阶段\nLLM_SUMMARY\n${"s".repeat(200)}` }),
    },
    { label: "(b) 默认滑窗", runId: "p894-b-default", strategy: undefined },
  ]) {
    const { records } = await runFixture({ label, runId, strategy });
    const fold = records.find((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined);
    assert.ok(fold, `${label} 夹具前提：本轮记录里有折叠事实`);
    const archive = fold.foldedPayload ?? [];
    const normalized = stripVolatile(archive);

    assert.equal(stableFingerprint(normalized), PREFIX_ARCHIVE_DIGEST.fingerprint,
      `${label} 反向证A：轮记录归档内容必须与修复前逐字相同（快照不得改读归档）`);
    assert.equal(Buffer.byteLength(JSON.stringify(normalized), "utf8"), PREFIX_ARCHIVE_DIGEST.bytes,
      `${label} 反向证A：归档字节量必须与修复前相同`);
    assert.equal(archive.length, PREFIX_ARCHIVE_DIGEST.count,
      `${label} 反向证A：归档条数必须与修复前相同（安全层降级的原文仍要留在归档里，不丢证据）`);
    assert.ok(JSON.stringify(stripVolatile(archive)).includes("PROCTOOL_R7"),
      `${label} 反向证A：被安全层降级的那条必须**仍在归档里**（增量不写它 ≠ 丢掉它）`);

    // 折叠身份（`foldId`）必须由**全量**归档现算：拿轮记录那份就地重算，必须逐字相等。
    assert.equal(fold[FOLDED_FACTS_RECORD_FIELD].foldId, foldSummaryFingerprint({
      messages: archive,
      roundRange: fold.foldedRoundRange ?? null,
      recoveryHint: null,
    }), `${label} 反向证A：foldId 仍由全量 foldedPayload 算出（改读快照 ⇒ 这一格红）`);
  }
});

// ── 格子 4：反向证 B —— 新键 `safetyDowngrade` 的语义 ─────────────────────────────────
test("#894 反向证B（新键语义）：safetyDowngrade.rounds = 被降级消息所在轮号；无降级 ⇒ 键不存在", async () => {
  for (const { label, runId, strategy } of [
    {
      label: "(a) fold-llm",
      runId: "p894-a-foldllm",
      strategy: createFoldLlmStrategy({ summarizer: async () => `## 阶段\nLLM_SUMMARY\n${"s".repeat(200)}` }),
    },
    { label: "(b) 默认滑窗", runId: "p894-b-default", strategy: undefined },
  ]) {
    const { records } = await runFixture({ label, runId, strategy });
    const fold = records.find((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined);
    assert.ok(fold, `${label} 夹具前提：本轮记录里有折叠事实`);
    assert.ok("safetyDowngrade" in fold,
      `${label} 反向证B：protectedDowngraded>0 的格子必须写 safetyDowngrade 键`);
    const safetyDowngrade = fold.safetyDowngrade;

    // 被降级的只有第 7 轮那条 assistant(`PROCTOOL_R7`)（实测 protectedDowngraded=1）。
    assert.deepEqual(safetyDowngrade.rounds, [7],
      `${label} 反向证B：rounds 必须是被降级消息**所在的那一轮**（实测被降级 = 第 7 轮）`);
    assert.equal(safetyDowngrade.count, 1, `${label} 反向证B：count = 被降级条数`);
    assert.ok(!("budgetUnreachable" in safetyDowngrade),
      `${label} 反向证B：安全层没报 budgetUnreachable ⇒ 不许写这个键（无事实不写键）`);

    // 语义反面对照：既不是「全 run 的轮号」，也不是「折叠区间」。
    const foldRange = fold.foldedRoundRange;
    assert.ok(safetyDowngrade.rounds.every((round) => round > foldRange.to),
      `${label} 反向证B：轮号必须落在折叠区间 [${foldRange.from},${foldRange.to}] **之外**（受保护轮没被折）`);
    assert.ok(safetyDowngrade.rounds.length < TOOL_TURNS,
      `${label} 反向证B：不许把全 run 的轮号写成 rounds`);

    // 字节上界沿用折叠事实那一套口径（同一个常量，不许硬编码）。
    assert.ok(Buffer.byteLength(JSON.stringify(safetyDowngrade), "utf8") <= FOLDED_FACTS_MAX_BYTES,
      `${label} 反向证B：safetyDowngrade 必须受 FOLDED_FACTS_MAX_BYTES 约束`);
  }

  // 「无事实 ⇒ 无键」那一格：受保护消息**自身** > 预算 ⇒ 安全层早退保留它、一条没降级。
  const { records, compactions } = await runFixture({
    label: "(c) 受保护消息自身超预算",
    runId: "p894-c-exceeds",
    strategy: undefined,
    budgetTokens: 2000,
    protectedAssistantBytes: 6000,
  });
  const exceeds = compactions.find((compaction) => compaction.budgetUnreachable === "protected_message_exceeds_budget");
  assert.ok(exceeds, "(c) 夹具前提：出现 budgetUnreachable=protected_message_exceeds_budget");
  assert.equal(exceeds.protectedDowngraded ?? 0, 0, "(c) 夹具前提：protectedDowngraded=0（安全层一条没降级）");
  const fold = records.find((record) => record?.[FOLDED_FACTS_RECORD_FIELD] !== undefined);
  assert.ok(fold, "(c) 夹具前提：这一格照样有折叠（foldedRounds>0），只是没有安全层降级");
  assert.ok(!("safetyDowngrade" in fold),
    "(c) 反向证B：protectedDowngraded=0 ⇒ safetyDowngrade 键必须**不存在**（不是 [] / 0）");
});
