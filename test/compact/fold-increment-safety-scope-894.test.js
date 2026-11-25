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
// ── 为什么必须同时钉 ⓪ 与 ③（而且必须**分开**钉）─────────────────────────────────────
// 越界正文有**两个产生点**，形状完全相同（读全量 `foldedPayload`，`from/to/count` 取不涨的区间）：
//   ⓪ `incrementText` 的 `budgetFallbackFoldedRounds > 0` 那一支（配置策略折不够 ⇒ 引擎预算兜底
//     接手折轮，本折实际删掉的是「策略那一折 + 兜底那一折」的并集；#873 之后这一格变常见）；
//   ③ 落到 `computeFactsFallbackText()` 那一支（**没有**兜底折轮、且策略自己报不出正文时才走：
//     `strategyFoldSummary` 的 `increment` 与 `text` 都不成句 ⇒ 由定稿处就地现算）。
// 上一轮的修法只切了 ⓪，③ 原封不动 ⇒ 只要有条路径落到 ③ 就照样越界，而且**没人报红**
// （实测：只退 ③ 的变异在上一版判据下全绿，见下面「变异证据」M3b）。
// ⇒ 分工（按**实测**写）：格子 1 / 格子 2 钉 ⓪（两个策略配置各一遍），**格子 4 钉 ③**。
//   分支身份只能用**观察面**断言，不能用正文措辞：两条分支吐出的正文**逐字相同**（实测两份
//   `increment.text` 完全一样，`noteTools` 的差异不改变措辞），措辞分不开它们。
//   · ⓪ 的观察面（`assertBranchIs0`）：配的是 `fold-llm`，却同时出现 `foldLlm` + `slidingWindow`
//     两层观测 —— `src/loop/orchestrator.js:4492` 那个 `observeCompactionLayer` **只在**
//     `fallback.foldedRounds > 0` 时才写 `layers.slidingWindow` ⇒ 那一发只能是引擎的预算兜底。
//   · ③ 的观察面（格子 4）：配一个**非管线**策略（名字不在 `COMPACTION_PIPELINE` 里），于是
//     `layers.slidingWindow` 只可能来自预算兜底；本格要求它 `triggered === 0` ⇒ 兜底折了 0 轮
//     ⇒ `budgetFallbackFoldedRounds === 0` ⇒ ⓪ 的闸门为假 ⇒ 正文只能出自 ③。
//   · ⚠ 默认策略 = 滑窗时**没有**可用的分支代理（入口那一发与兜底是同一个层、同一个名字）：
//     那里曾用「区间跨度 == 不受保护轮数」反证 ⓪，**已被实测推翻**（兜底折的轮也落在同一段
//     并集里，`foldedRounds == 6` 完全可以是「策略 5 + 兜底 1」）⇒ 那一格现在不声称分支身份。
//
// ── 这是**过渡期**修法（口径已批 #898，不是永久机制）────────────────────────────────
// 本格钉的这条触发路径靠的是 `protectedMessage` 钩子，而该机制已批退役（#898，前置是
// `recall_read` 先落地）。⇒ 退役完成后这条路径**不可达**，本格与 `orchestrator.js` 里那段
// 快照逻辑（`incrementFoldedPayload` 三元组）**一起删掉**。
// ⚠ 现在**不能**在代码里写「这里不可能读到安全层追加的内容」——那是假话：CLI 至今仍然设着
//   `bin/config.js:431` 的 `protectedMessage: isRealUser`，这条路径今天还活着（实测探针 commit
//   `2c5ad310`）。过渡期的做法就是把两种读者分开（见下「反向证 A」那一格），而不是删机制。
// ⇒ 也正因为机制即将消失，**账本形状一字不动**：不新增轮记录键、不新增枚举值或统计键
//   （给一个即将不存在的机制再加一层可观测面 = 过度设计）。这条「不新增」本身钉在
//   格子 3 的 `PREFIX_RECORD_KEYS` 上（实测改动前后的轮记录键集必须逐字相同）。
//
// ── 变异证据（**实测**，不是推断；每一发都是「只回退一步」的源码 + 本文件，跑完即还原）────
//   M3a 只退回 ⓪（预算兜底那一支改回读全量 `foldedPayload`）
//      ⇒ exit=1，红格 = **格子 1 与格子 2**（两格都报「实测越界轮=[7]」），格子 3/4 绿。
//      ⇒ 事实：**格子 1 与格子 2 走的都是 ⓪**（格子 2 曾名「③ 路径」——那名字是错的：它的
//        分支代理「区间跨度 == 不受保护轮数」证伪不了 ⓪，兜底折的轮也落在同一段并集里）。
//   M3b 只退回 ③（定稿处 `computeFactsFallbackText()` 那个闭包改回读全量）
//      ⇒ 在**只有格子 1–3** 的上一版判据下：exit=0、红格 0（**全绿**）⇒ ③ 当时一遍都没被钉；
//      ⇒ 加上格子 4 之后：exit=1，红格 = **仅格子 4**（报「实测越界轮=[7]」）。
//   ⇒ 本文件的分工（按实测写，不按设计意图写）：**格子 1 / 格子 2 钉 ⓪**（两个策略配置各一遍），
//     **格子 4 钉 ③**，格子 3 钉「不拿契约面换内部自洽」与「账本形状一字不动」。
//   M4a 落盘归档 `buildFoldedRecordArchive` 改读快照
//      ⇒ exit=1，红格 = **格子 3**（归档条数变 12、末条 `PROCTOOL_R7` 消失）；格子 1/2 也连带红
//      （它们的**夹具前提**就是「那条降级消息已进了轮记录归档」）⇒ 归档被搜短这件事报三行。
//   M4b 折叠身份 `foldSummaryFingerprint`（= 契约上的 `foldId`）改由快照算
//      ⇒ exit=1，红格 = **仅格子 3**（就地重算的 `foldId` 与落账那份不相等）。
//   M5 往轮记录加一个新键（实测：无条件写 `roundRecord.safetyDowngrade = { rounds:[7], count:1 }`）
//      ⇒ exit=1，红格 = **仅格子 3**（`PREFIX_RECORD_KEYS` 多一个键就红）。
//
// 夹具蓝本：上一轮取证探针（本文件照它改写：`buildRun` / `collect` / `findQ1` / `findLeak` 与三轮
// 工具轮、受保护消息的构造都是抄它的，只是**断言方向反过来**；蓝本本体不进主干）。
// 零真实 LLM、内存 store（不碰 `~/.erix` / `~/.pi`）、数值一律现算
// （`estimateMessageTokens`），只有「反向证 A」那几个归档形状常量是修复前登记的（见该格注释）。

import assert from "node:assert/strict";
import test from "node:test";

import { createFoldLlmStrategy } from "../../src/compact/fold-llm.js";
import {
  FOLDED_FACTS_INCREMENT_KEY,
  FOLDED_FACTS_RECORD_FIELD,
  foldSummaryFingerprint,
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
// 措辞当分支身份：⓪ 用下面 `assertBranchIs0` 那条观察面；③ 由格子 4 用「配非管线策略 +
// `slidingWindow.triggered === 0`」这条代理坐实（实测证据见文件头「变异证据」）。
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

// 取**某一轮**带折叠事实的那条轮记录（同一轮可能有多条行，只拿带 `foldedFacts` 的那一条）。
function findFoldRecordAtRound(records, round) {
  return records.find((record) => record?.round === round
    && record[FOLDED_FACTS_RECORD_FIELD] !== undefined);
}

// 增量正文里出现的轮次标记（工具名自带轮号：`tool_R<n>` / `PROCTOOL_R<n>`）。
function mentionedRounds(text) {
  return [...String(text ?? "").matchAll(/(?:PROCTOOL_R|tool_R)(\d+)/g)].map((m) => Number(m[1]));
}

// ⓪ 的分支身份（只在配置策略 = `fold-llm` 时可用）：配的是 `fold-llm`，`layers.slidingWindow`
// 那一发只可能是引擎预算兜底，而 `orchestrator.js:4492` 仅在 `fallback.foldedRounds > 0` 时
// 才写这一层观测 ⇒ 两层同时 triggered = ⓪ 的条件（`budgetFallbackFoldedRounds > 0`）成立。
// ⚠ 默认策略 = 滑窗时**用不了**这个代理：入口那一发与预算兜底是同一个层、同一个名字，
//   layers 分不开 ⇒ 那一格不声称分支身份（实测它走的也是 ⓪）。③ 的身份改由格子 4 坐实：
//   配**非管线策略** + `slidingWindow.triggered === 0`（见格子 4 注释）。
function assertBranchIs0(label, q1) {
  assert.ok(q1.layers?.foldLlm?.triggered, `${label} 分支身份：配置策略 fold-llm 确实折过`);
  assert.ok(q1.layers?.slidingWindow?.triggered,
    `${label} 分支身份：配的是 fold-llm，却同时出现 slidingWindow 观测 ⇒ 那是预算兜底且它真折了轮`
    + "（orchestrator.js:4492 只在 fallback.foldedRounds>0 时写）⇒ 本格走的是 ⓪");
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

  // 分支身份：声称走 ⓪ 的那格必须在格里证伪另一条；`"unknown"` = **不声称**——默认滑窗下入口
  // 那一发与预算兜底同层同名，代理不存在（实测该格走的仍是 ⓪：见文件头「变异证据」M3a/M3b）。
  if (branch === "0") {
    assertBranchIs0(label, q1);
  } else {
    assert.equal(branch, "unknown", `${label} 内部口径：branch 只认 "0" / "unknown"`);
  }

  const outside = [...new Set(mentionedRounds(text))]
    .filter((round) => round < (increment.from ?? 1) || round > increment.to);
  assert.deepEqual(outside, [],
    `${label} ${branch === "0" ? "⓪" : "不声称分支（实测与格子 1 同走 ⓪）"} #894 判据：`
    + `增量正文不得含声明区间 from=${increment.from} to=${increment.to}`
    + `（rounds=${increment.rounds}）之外的轮次，实测越界轮=${JSON.stringify(outside)}`);
}

// ── 格子 3 的常量：修复前（基点 e3b91fbb，未改源码）登记的归档形状 ────────────────────
// 为什么不硬编码归档的 sha256：实测本夹具的归档**跨进程偶发漂移**（同一夹具跑 20+ 次，
// 条数恒 13、字节量恒 5534、工具名序列恒同，但把每进程随机的 `toolCallKey` 递归剔掉后
// 的 `stableFingerprint` 仍偶发不同）⇒ 拿一个写死的摘要当判据会把引擎自己那份随机字段
// 误报成本刀的红（实测 `node --test` 8 次跑出 4 次假红）。因此这里钉**结构**：
// 条数 + 每条的工具名（顺序即归档顺序）+ 安全层那条在场。这三条足以钉死变异 M4
// （归档改读快照 ⇒ 条数变 12、末条 `PROCTOOL_R7` 消失），且不依赖任何随机字段。
// 修复前实测（(a) 与 (b) 归档同一份）：13 条，末条 = 第 7 轮 assistant(`PROCTOOL_R7`)，
// 正是安全层追加进总 `foldedPayload` 的那一条。
const PREFIX_ARCHIVE_SHAPE = {
  count: 13,
  toolNames: [
    "tool_R1", "", "tool_R2", "", "tool_R3", "", "tool_R4", "", "tool_R5", "",
    "tool_R6", "", "PROCTOOL_R7",
  ],
};

// 修复前（同一夹具、未改源码）轮记录的**键集**：过渡期修法只拆内存侧的读者，账本形状
// 一字不动 ⇒ 不新增轮记录键、不新增枚举值或统计键（理由见文件头「过渡期」那一段：
// #898 即将退役 `protectedMessage`）。连同写入顺序一起钉：多一个键就红。
const PREFIX_RECORD_KEYS = [
  "round",
  "roundKey",
  "dedupKey",
  "ts",
  "response",
  "usage",
  "textPreview",
  "toolUses",
  "summary",
  "l0facts",
  "runStateMeta",
  "compactionStats",
  "folded",
  "foldedPayload",
  "foldedPayloadMeta",
  "foldedRoundRange",
  "foldedFacts",
  "messages",
];

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
// ── 格子 2：同一份夹具只换策略配置（默认滑窗）；实测与格子 1 一样走 ⓪ ──────────────
// 名字里**不再声称 ③**：实测 M3a（只退 ⓪）让本格与格子 1 同时红、M3b（只退 ③）让本格绿。
// ③ 由格子 4 钉（那里配的是**非管线策略**，才能把预算兜底与入口那一发分开）。
test("#894 ⓪ 路径（配置策略 = 默认滑窗）：增量正文不得含声明区间外的轮次", async () => {
  await assertIncrementStaysInsideItsOwnRange({
    label: "(b) 默认滑窗 ⓪",
    runId: "p894-b-default",
    strategy: undefined,
    branch: "unknown",
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

    // 归档内容：读的是**全量**（第 1–6 轮 + 安全层追加的第 7 轮那条），不是增量快照。
    assert.equal(archive.length, PREFIX_ARCHIVE_SHAPE.count,
      `${label} 反向证A：归档条数必须与修复前相同（改读快照 ⇒ 少一条 ⇒ 这一格红）`);
    assert.deepEqual(archive.map((message) => (
      (Array.isArray(message?.content) ? message.content : [])
        .filter((block) => block?.type === "tool_use")
        .map((block) => String(block?.name ?? ""))
        .join(",")
    )), PREFIX_ARCHIVE_SHAPE.toolNames,
      `${label} 反向证A：归档每条的工具名（顺序=归档顺序）必须与修复前逐字相同`);
    assert.ok(JSON.stringify(stripVolatile(archive)).includes("PROCTOOL_R7"),
      `${label} 反向证A：被安全层降级的那条必须**仍在归档里**（增量不写它 ≠ 丢掉它）`);

    // 折叠身份（`foldId`）必须由**全量**归档现算：拿轮记录那份就地重算，必须逐字相等。
    assert.equal(fold[FOLDED_FACTS_RECORD_FIELD].foldId, foldSummaryFingerprint({
      messages: archive,
      roundRange: fold.foldedRoundRange ?? null,
      recoveryHint: null,
    }), `${label} 反向证A：foldId 仍由全量 foldedPayload 算出（改读快照 ⇒ 这一格红）`);

    // 账本形状：轮记录键集与写入顺序逐字不变（过渡期只拆内存侧读者，不新增任何账本面）。
    assert.deepEqual(Object.keys(fold), PREFIX_RECORD_KEYS,
      `${label} 反向证A：轮记录键集必须与修复前逐字相同（新增任何轮记录键 ⇒ 这一格红）`);
  }
});

// ── 原「反向证 B」= 新键 `safetyDowngrade` 的语义格：按 #898 口径**取消**（不是没写完）──────
// 它要钉的是「安全层降级了哪几轮」这个**新轮记录键**。但 `protectedMessage` 已批退役（#898，
// 前置是 `recall_read` 先落地），给一个即将不存在的机制再加一层可观测面就是过度设计。
// ⇒ 本刀**账本形状一字不动**：不新增轮记录键、不新增枚举值、不新增统计键；「不许新增」这件事
//   由上面格子 3 的 `PREFIX_RECORD_KEYS` 钉住（正面钉「没有新键」比原来那条断言更贴本刀意图）。

// ── 格子 4：**真正驱动 ③**（`computeFactsFallbackText()`）的那一格 ──────────────────────
// 实测结论（见文件头「变异证据」那一段）：**只有这个形状能让 ③ 接手**。三件事必须同时成立：
//   Ⅰ 宿主自带的策略**自己折轮**，并报一个「有形状、没正文」的 `foldSummary`（既无 `text`
//     也无 `increment`）⇒ ① 与 ② 都空。关键：引擎只在 `foldSummary` **缺席**时才就地补一份
//     机械正文（`orchestrator.js:4339-4344` 那个 `strategyFoldSummary === undefined` 的兜底），
//     报一个 `{ source, strategy }」不会触发它。
//   Ⅱ 策略把可折的那几轮**一次折光**（只留最后几条消息），库层预算兜底接手时**无轮可折**
//     ⇒ `fallback.foldedRounds === 0` ⇒ `budgetFallbackFoldedRounds === 0` ⇒ **⓪ 的闸门为假**。
//   Ⅲ 预算仍装不下 ⇒ 安全层（`enforceSize`）照跑，把它降级的那条受保护消息**追加进全量**
//     `foldedPayload`（`protectedDowngraded > 0`）——这就是越界素材本身。
// 「⓪ 真的没接手」用**观察代理**坐实，不靠读源码猜：`orchestrator.js:4492-4496` 只在
// `fallback.foldedRounds > 0` 时才给 budget 相的 `slidingWindow` 层记 `triggered`（#657 注释就写着
// 「`layers` 里 `triggered > 0` 的 budget 相层就是同一件事」）；而本夹具配的是**非管线策略**
// （`name = "host-fake-notext"`，不在 `COMPACTION_PIPELINE` 的名字表里）⇒ 策略自己那一折也不会碰
// 这个层。于是 `layers.slidingWindow.triggered === 0` ⇔ 兜底折了 0 轮 ⇔ `budgetFallbackFoldedRounds`
// === 0 ⇔ ⓪ 那一支根本没跑 ⇒ 正文只能来自 ③。
// ⚠ 上一轮我在格子 2 里用「区间跨度 == 未受保护轮数」当 ③ 的代理，**那个代理是错的**：
//   兜底折的轮也落在同一段并集里，`foldedRounds == 6` 完全可以是「策略 5 + 兜底 1」。
//   实测：只退 ⓪ ⇒ 格子 1/2 两格皆红；只退 ③ ⇒ 两格皆绿。⇒ 格子 1/2 走的都是 ⓪，
//   ③ 在本格之前**一遍都没被钉**（这正是 #894 说的那个错误的镜像：不是一处漏修，是一处漏钉）。

// 策略只留最后这么多条消息：保留集里必然还剩受保护的那几轮（越界素材会在），
// 而可折的那几轮一次折光 ⇒ 预算兜底无轮可折。
const FAKE_STRATEGY_KEEP_MESSAGES = 4;

// 一个「会折轮、但报不出正文」的假宿主策略：`foldSummary` 有形状、没 `text`/`increment`。
// 同时把每次报出的东西**留档**，让判据能直接断言「① ② 确实空」而不是靠推。
function createNoTextStrategy({ keepMessages = FAKE_STRATEGY_KEEP_MESSAGES } = {}) {
  const reports = [];
  const foldSummary = Object.freeze({ source: "strategy", strategy: "host-fake-notext" });
  return {
    reports,
    strategy: {
      name: "host-fake-notext",
      shouldCompact: async () => true,
      compact: async (messages) => {
        const kept = messages.slice(-keepMessages);
        const folded = messages.slice(0, Math.max(0, messages.length - kept.length));
        reports.push({
          foldedRounds: folded.length,
          hasText: typeof foldSummary.text === "string",
          hasIncrement: typeof foldSummary.increment === "string",
        });
        return {
          messages: kept,
          compacted: true,
          foldedPayload: folded,
          foldedRounds: folded.length,
          foldedRoundRange: { from: 1, to: Math.max(1, folded.length) },
          foldSummary,
        };
      },
    },
  };
}

test("#894 ③ 路径（假宿主策略不报正文 + 预算兜底折 0 轮 → computeFactsFallbackText）：增量正文不得含声明区间外的轮次", async () => {
  const label = "(c) 假宿主策略无正文 ③";
  const { strategy, reports } = createNoTextStrategy();
  const { records } = await runFixture({ label, runId: "p894-c-notext", strategy });

  // 前提 Ⅰ：策略每一发都报了「有形状、没正文」的 foldSummary ⇒ ① 与 ② 结构性为空。
  assert.ok(reports.length > 0, `${label} 夹具前提：配的假策略真的被调到了`);
  assert.ok(reports.every((report) => report.hasText === false && report.hasIncrement === false),
    `${label} 夹具前提：策略报出的 foldSummary 必须既无 text 也无 increment（否则正文是 ② 供的，本格钉不到 ③）`);

  // 前提 Ⅱ+Ⅲ（观察到的事实）：本折**真的折了轮**、`slidingWindow` 层**一次没触发**（⓪ 闸门为假）、
  // 安全层**真的动了手**且**降级了受保护消息**（越界素材在场）。
  const stats = records.flatMap((record) => (record.compactionStats ?? [])
    .map((stat) => ({ round: record.round, ...stat })));
  const q1 = stats.find((stat) => stat.compacted === true
    && stat.foldedRounds > 0
    && (stat.layers?.slidingWindow?.triggered ?? 0) === 0
    && (stat.layers?.enforceSize?.triggered ?? 0) > 0
    && (stat.protectedDowngraded ?? 0) > 0);
  assert.ok(q1,
    `${label} 夹具前提：要有一发「折了轮 + 预算兜底折 0 轮（slidingWindow.triggered=0）+ 安全层降级了受保护消息（protectedDowngraded>0）」的压缩；实测 stats=${JSON.stringify(stats)}`);
  assert.ok(reports.some((report) => report.foldedRounds === q1.foldedRounds),
    `${label} ③ 那一折的折轮数必须等于策略自报的那份（预算兜底一份没加 ⇒ 才能说 ⓪ 没接手）；实测=${q1.foldedRounds}`);

  const foldRecord = findFoldRecordAtRound(records, q1.round);
  assert.ok(foldRecord, `${label} 夹具前提：那一轮带折叠事实（轮号=${q1.round}）`);
  const increment = foldRecord[FOLDED_FACTS_RECORD_FIELD][FOLDED_FACTS_INCREMENT_KEY];
  // 正文真的由 ③ 供出来了（不是空串、不是占位）。
  assert.ok(typeof increment?.text === "string" && increment.text !== "",
    `${label} ③ 必须真的供出了增量正文（拿不到 ⇒ 本格是空转）`);
  // 非空转钳：声明区间必须**窄于**受保护轮的轮号，否则「正文不含越界轮」这句是自动成立的。
  assert.ok(Number.isSafeInteger(increment.to) && increment.to < PROTECTED_ROUNDS[0],
    `${label} 非空转钳：增量声明的 to=${increment.to} 必须小于受保护轮号 ${PROTECTED_ROUNDS[0]}（否则安全层那条本来就在区间内，断言空转）`);

  const outside = [...new Set(mentionedRounds(increment.text)
    .filter((round) => round < increment.from || round > increment.to))]
    .sort((left, right) => left - right);
  assert.deepEqual(outside, [],
    `${label} 格子 4：③ 供出的增量正文不得含它自己声明区间 from=${increment.from} to=${increment.to}`
    + `（rounds=${increment.rounds}）之外的轮次；实测越界轮=${JSON.stringify(outside)}`
    + `（只退 ③ 的变异下实测为 [7]，即安全层追加的那条受保护消息）`);
});
