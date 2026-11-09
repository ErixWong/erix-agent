// erix_run 终稿核验（finalGuard）谓词的**离线**用例（issue #314 R2/R3 判据 C1–C5）。
// 全程不联网、不打模型：谓词是纯函数，成本计数注入假时钟。
// 跑法：node --test examples/pi-extension/erix-run-final-guard.test.mjs（也在 npm test 的 glob 里）
// 零依赖红线：只用 node: 内置 + 相对路径；纯 ESM。

import assert from "node:assert/strict";
import { test } from "node:test";

import * as guardModule from "./erix-run-final-guard.js";
// R2 P9/P10 要探宿主的读口（core 不 import pi，`node --test` 可测）；懒取命名空间，缺导出时在格子里红而不是链接期红。
import * as coreModule from "./erix-run-core.js";
import {
  createFinalGuardTally,
  createFinalGuardVerify,
  collectToolResultText,
  ENGINE_FINAL_GUARD_MAX_RETRIES,
  extractDeclaredBases,
  findDerivedConclusionFlags,
  FINAL_DRAFT_PROMPT,
  FINAL_DRAFT_SECTIONS,
  FINAL_GUARD_TIMEOUT_MS,
  FINAL_GUARD_WORST_CASE_MS,
  inspectFinalDraft,
  isBaseTraceable,
  splitFinalDraft,
  summarizeFinalGuard,
} from "./erix-run-final-guard.js";

const SHA = "9c2a41b";
const OTHER_SHA = "deadbeef1234";

/** 一段四件套齐全、基点可溯源的终稿（C2 的「找得到」侧）。 */
function completeDraft({ base = SHA } = {}) {
  return [
    "## 取证边界",
    "- 只读了本仓工作树，跑了 git rev-parse --short HEAD",
    "- 没看 CI 历史",
    "",
    "## 基点",
    `- ${base}`,
    "",
    "## 结论",
    "- guard 谓词在 examples/pi-extension/erix-run-final-guard.js:1 起实现",
    "",
    "## 未验证",
    "- 无",
  ].join("\n");
}

/** 本次 run 的 messages：一条 tool_result 里真的出现过 SHA。 */
function messagesWith(text) {
  return [
    { role: "user", content: [{ type: "text", text: "任务正文" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "exec", input: { command: "git rev-parse HEAD" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: text }],
    },
  ];
}

// ---------------------------------------------------------------------------
// C1 格式/存在性：缺段必须 revise，且文案点名缺的那一段
// ---------------------------------------------------------------------------

test("C1 缺 `## 基点` ⇒ revise，且 revise 文案点名该段（不许 accept）", () => {
  const draft = completeDraft().replace(/## 基点\n- [0-9a-f]+\n\n/u, "");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise", JSON.stringify(decision));
  assert.ok(decision.message.includes("## 基点"), `文案必须点名缺的段，实际：${decision.message}`);
  assert.deepEqual(decision.missingSections, ["## 基点"]);
});

test("C1 四段全缺 ⇒ revise 文案把四段都点出来（段名与 FINAL_DRAFT_SECTIONS 同源）", () => {
  const decision = inspectFinalDraft({ finalText: "任务已完成，随便改了改。", messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  for (const section of FINAL_DRAFT_SECTIONS) {
    assert.ok(decision.message.includes(section), `文案缺 ${section}：${decision.message}`);
    assert.ok(FINAL_DRAFT_PROMPT.includes(section), `提示词槽位缺 ${section}`);
  }
});

test("C1 只缺 `## 未验证` ⇒ 点名该段且不牵连其它段", () => {
  const draft = completeDraft().replace(/\n\n## 未验证\n- 无$/u, "");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.missingSections, ["## 未验证"]);
  assert.ok(decision.message.includes("## 未验证"));
});

// ---------------------------------------------------------------------------
// C2 基点溯源 = 唯一硬闸：两个方向都要钉住
// ---------------------------------------------------------------------------

test("C2 基点声明值在 tool_result 里找不到 ⇒ revise（fail closed，绝不 accept）", () => {
  const decision = inspectFinalDraft({
    finalText: completeDraft({ base: OTHER_SHA }),
    messages: messagesWith(`HEAD 现在是 ${SHA}\n`),
  });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.untraceableBases, [OTHER_SHA]);
  assert.ok(decision.message.includes(OTHER_SHA), "文案要点名对不上的那个值");
});

test("C2 基点声明值在 tool_result 里逐字找得到 ⇒ accept（= 引擎侧会写 verified）", () => {
  const decision = inspectFinalDraft({
    finalText: completeDraft({ base: SHA }),
    messages: messagesWith(`On branch main\nHEAD detached at ${SHA}\n`),
  });
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  assert.equal(decision.message, undefined);
  assert.deepEqual(decision.declaredBases, [SHA]);
});

test("C2 只有 `## 基点` 段的值参与溯源；结论段里的文件名不被当基点", () => {
  const { declaredBases } = inspectFinalDraft({
    finalText: completeDraft(),
    messages: messagesWith(SHA),
  });
  assert.deepEqual(declaredBases, [SHA], `结论段的 erix-run-final-guard.js:1 不该进基点清单：${declaredBases}`);
});

test("C2 基点只在 assistant 正文里出现过（不在 tool_result）⇒ 仍然 revise", () => {
  // 模型自己复述过一遍不算证据：来源必须是工具返回。
  const messages = [
    { role: "assistant", content: [{ type: "text", text: `我看到 ${SHA}` }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "无此值" }] },
  ];
  assert.equal(collectToolResultText(messages), "无此值");
  assert.equal(inspectFinalDraft({ finalText: completeDraft(), messages }).action, "revise");
});

test("C2 tool_result 的两种内容形状（字符串 / 块数组）都要能取到文本", () => {
  const blocks = [{
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: `tag v0.21.0` }, { type: "text", text: "另一段" }],
    }],
  }];
  assert.ok(collectToolResultText(blocks).includes("tag v0.21.0"));
  assert.equal(
    inspectFinalDraft({ finalText: completeDraft({ base: "v0.21.0" }), messages: blocks }).action,
    "accept",
  );
});

test("C2 `## 基点` 写了「无」⇒ 没有任何声明值 ⇒ revise（不许当成免检）", () => {
  const draft = completeDraft().replace(`- ${SHA}`, "- 无");
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.declaredBases, []);
  assert.ok(decision.message.includes("基点"), `文案要点名基点段，实际：${decision.message}`);
});

test("C2 多个基点里只要有一条对不上就 revise（逐条核验，不取「多数通过」）", () => {
  const draft = completeDraft().replace(`- ${SHA}`, `- ${SHA}\n- ${OTHER_SHA}`);
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.untraceableBases, [OTHER_SHA]);
});

test("extractDeclaredBases 认反引号 / 裸 SHA / 版本号，去重且顺序稳定", () => {
  const body = "\n- `9c2a41b`\n- 9c2a41b\n- v0.21.0\n- 0.21.0\n";
  assert.deepEqual(extractDeclaredBases(body).map((e) => e.literal), ["9c2a41b", "v0.21.0", "0.21.0"]);
});

test("isBaseTraceable：十六进制忽略大小写，非十六进制逐字（大小写不同就是找不到）", () => {
  assert.equal(isBaseTraceable("9C2A41B", `head at ${SHA}`), true);
  assert.equal(isBaseTraceable("Release-Note", "release-note 出现过"), false);
});

test("splitFinalDraft 取到段正文，缺段进 missing", () => {
  const { found, missing } = splitFinalDraft(completeDraft());
  assert.equal(found["## 基点"].trim(), `- ${SHA}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(splitFinalDraft("## 结论\nx").missing, ["## 取证边界", "## 基点", "## 未验证"]);
});

// ---------------------------------------------------------------------------
// C4 派生结论只提醒，不硬拒
// ---------------------------------------------------------------------------

test("C4 跨口径比值标本（1:N / 百分比 / 总计）仍被 accept，但 flags 里有提醒", () => {
  const draft = `${completeDraft()}\n\n总计：命中 3 条，比例 1:5，覆盖率 33%。`;
  const decision = inspectFinalDraft({ finalText: draft, messages: messagesWith(SHA) });
  assert.equal(decision.action, "accept", `提醒不该拦下终稿：${decision.message}`);
  const kinds = decision.ratioFlags.map((flag) => flag.kind);
  for (const kind of ["ratio", "percent", "total"]) {
    assert.ok(kinds.includes(kind), `缺 ${kind} 提醒：${JSON.stringify(decision.ratioFlags)}`);
  }
  assert.ok(decision.ratioFlags.every((flag) => typeof flag.sample === "string" && flag.sample.length > 0));
});

test("C4 没有派生结论时 flags 是空数组（不是 undefined，也不误报）", () => {
  assert.deepEqual(inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith(SHA) }).ratioFlags, []);
});

test("findDerivedConclusionFlags 样本上限 10 条（提醒不该淹掉终局面）", () => {
  const flags = findDerivedConclusionFlags("总计\n".repeat(30));
  assert.ok(flags.length <= 10, `实际 ${flags.length} 条`);
});

// ---------------------------------------------------------------------------
// R3 成本计数：次数 / 累计耗时 / revise 轮数都要留痕（假时钟，不打模型）
// ---------------------------------------------------------------------------

test("createFinalGuardVerify 记 calls / elapsedMs / reviseRounds（注入假时钟）", async () => {
  const tally = createFinalGuardTally();
  let clock = 1_000;
  // 谓词本身耗时 250ms（假时钟在谓词里走），两次调用**之间**的 1_500ms 不得计入 guard 成本。
  const inspect = (payload) => {
    clock += 250;
    return inspectFinalDraft(payload);
  };
  const verify = createFinalGuardVerify({ tally, inspect, now: () => clock });
  const payloads = [
    { finalText: completeDraft(), messages: messagesWith(SHA) },
    { finalText: "缺段", messages: messagesWith(SHA) },
  ];
  const decisions = [];
  for (const payload of payloads) {
    decisions.push(await verify(payload));
    clock += 1_500;
  }
  assert.deepEqual(decisions.map((d) => d.action), ["accept", "revise"]);
  assert.equal(tally.calls, 2);
  assert.equal(tally.accepted, 1);
  assert.equal(tally.reviseRounds, 1);
  assert.equal(tally.elapsedMs, 500, `只该累加谓词自身的墙钟：${tally.elapsedMs}`);
  assert.equal(tally.enabled, true);
  assert.equal(tally.source, "host finalGuard wrapper (erix-run-final-guard.js)");
});

test("谓词抛错 ⇒ revise（fail closed：出错绝不默认 accept），并记 invalidDecisions", async () => {
  const tally = createFinalGuardTally();
  const verify = createFinalGuardVerify({ tally, inspect: () => { throw new Error("boom"); } });
  const decision = await verify({ finalText: completeDraft(), messages: [] });
  assert.equal(decision.action, "revise");
  assert.equal(tally.invalidDecisions, 1);
  assert.equal(tally.accepted, 0);
});

test("谓词返回 undefined ⇒ revise（没有决策就是没有通过）", async () => {
  const verify = createFinalGuardVerify({ inspect: () => undefined });
  assert.equal((await verify({})).action, "revise");
});

test("onObserve 抛错不能把 guard 带死（观测面不参与裁决）", async () => {
  const verify = createFinalGuardVerify({ onObserve: () => { throw new Error("observer down"); } });
  assert.equal((await verify({ finalText: completeDraft(), messages: messagesWith(SHA) })).action, "accept");
});

test("成本行把「最坏多 ≤2 个模型往返 + 3 × finalGuardTimeoutMs 等待」写清，并给出小超时", () => {
  const line = summarizeFinalGuard(createFinalGuardTally());
  assert.match(line, /calls=0/u);
  assert.match(line, /revise=0\/2/u);
  assert.match(line, /最坏额外/u);
  assert.equal(FINAL_GUARD_TIMEOUT_MS, 10_000, "开启时必须显式给小值，别靠引擎默认 30s");
  assert.ok(FINAL_GUARD_TIMEOUT_MS < 30_000);
  assert.equal(ENGINE_FINAL_GUARD_MAX_RETRIES, 2);
  assert.equal(FINAL_GUARD_WORST_CASE_MS, 3 * FINAL_GUARD_TIMEOUT_MS);
});

test("默认关的那一行不含任何「已核验」措辞", () => {
  const line = summarizeFinalGuard(undefined);
  assert.match(line, /disabled/u);
  assert.doesNotMatch(line, /calls=\d+/u);
});

test("谓词是异步的也要 await（真 guard 会读盘/调小模型；交给引擎的必须是决策而不是 Promise）", async () => {
  const verify = createFinalGuardVerify({ inspect: async () => ({ action: "accept" }) });
  const decision = await verify({});
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  assert.notEqual(decision.action, undefined, "把 Promise 当决策交出去 ⇒ 引擎报 invalid decision");
});

// ---------------------------------------------------------------------------
// #797：证据面 = 存活窗口 ∪ 账本（谓词级 P1–P6）
//
// 缺陷现场：guard 的证据面是 `payload.messages`，而它就是被上下文压缩改写的那一份 ⇒
// 「取证发生在折叠之前」的长 run 无论怎么重跑都很难在重试预算内收敛。本段格子钉的是
// **谓词层**的账本回落：账本是宿主读好的纯数据（`buildLedgerEvidence`），谓词只做匹配，
// 依旧不联网、不读盘。宿主接线（`deps.finalGuardLedger`）的格子在
// `test/examples/erix-run-core.test.js`（H1–H5）。
// ---------------------------------------------------------------------------

// #797 新增的导出（懒取：M1「先红」那一笔里它们还不存在，取值必须是**调用时**取，
// 否则整份文件在链接期就红，格子名就没了。）
const buildLedgerEvidence = (...args) => guardModule.buildLedgerEvidence(...args);
const honestVerificationReason = (...args) => guardModule.honestVerificationReason(...args);

const FOLD_CEILING = 62;

/** 一条账本行（`RoundRecord` 的最小形状：round + messages + 可选 foldedRoundRange）。 */
function ledgerRow({ round, text, foldedRange, messages }) {
  return {
    round,
    messages: messages ?? (text === undefined ? [] : messagesWith(text)),
    ...(foldedRange === undefined ? {} : { folded: true, foldedRoundRange: foldedRange }),
  };
}

/** 折叠事实行：`foldedRoundRange.to` 就是「最后一次压缩折到哪一轮」。 */
function foldRow({ round = FOLD_CEILING, from = 1, to = FOLD_CEILING }) {
  return ledgerRow({ round, foldedRange: { from, to } });
}

test("P6 账本不给 ⇒ inspectFinalDraft 的判定与今天逐字一致（回归锚：证据面回落不许改判据）", () => {
  // ①「ledger 缺省」与「显式 ledger: undefined」必须同形，且**不多出 evidence 键**。
  const draft = completeDraft({ base: OTHER_SHA });
  const implicit = inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith(SHA) });
  const explicit = inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith(SHA), ledger: undefined });
  assert.deepEqual(explicit, implicit, "显式传 ledger: undefined 必须与不传逐字同形");
  assert.equal(implicit.action, "accept");
  assert.equal(implicit.evidence, undefined, "没有账本就不许多出 evidence 键");
  assert.deepEqual(Object.keys(implicit).sort(),
    ["action", "declaredBases", "missingSections", "ratioFlags", "untraceableBases"]);

  // ② 找不到值的那一格：文案与 untraceableBases 逐字照今天的口径。
  const red = inspectFinalDraft({ finalText: draft, messages: messagesWith(`无关文本 ${SHA}`) });
  assert.equal(red.action, "revise");
  assert.deepEqual(red.untraceableBases, [OTHER_SHA]);
  assert.deepEqual(red.declaredBases, [OTHER_SHA]);
  assert.equal(red.message,
    `「## 基点」声明的 ${OTHER_SHA} 在本次 run 的工具返回里**逐字找不到**`
    + `（基点必须来自本次取证，不许凭记忆写）。`
    + `请重跑取基点的命令（如 git rev-parse --short HEAD），并把返回里的字面值原样写进「## 基点」。`);
  assert.equal(red.evidence, undefined);
});

test("P1 字面值只在账本行里 ⇒ accept，且 evidence 记 source:\"ledger\" / round / survivesLastCompaction:false", () => {
  const ledger = buildLedgerEvidence([
    ledgerRow({ round: 23, text: `HEAD detached at ${SHA}\non branch (no-name) at ${SHA}` }),
    foldRow({}),
  ], { source: "loadRawRows" });
  const decision = inspectFinalDraft({
    finalText: completeDraft(),
    messages: messagesWith("存活窗口里没有那个值"),
    ledger,
  });
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  assert.deepEqual(decision.untraceableBases, []);
  const entry = decision.evidence.bases.find((item) => item.literal === SHA);
  assert.ok(entry, `evidence 里必须点名该值：${JSON.stringify(decision.evidence)}`);
  assert.equal(entry.source, "ledger");
  assert.equal(entry.round, 23, "round 必须是账本里命中那一轮的轮号");
  assert.equal(entry.survivesLastCompaction, false, "23 ≤ foldCeiling(62) ⇒ 最后一次压缩之后已经没有这条 tool_result");
  assert.equal(decision.evidence.foldCeiling, FOLD_CEILING);
  assert.equal(decision.evidence.foldRows, 1);
  assert.equal(decision.evidence.ledgerComplete, true);
  assert.equal(decision.evidence.ledgerSource, "loadRawRows");
  assert.deepEqual(decision.evidence.notInLedger, []);
});

test("P1b 同一个值在折叠前后都命中 ⇒ round 取**最新**那次，survivesLastCompaction:true（判据 ② 的读法）", () => {
  const ledger = buildLedgerEvidence([
    ledgerRow({ round: 23, text: `HEAD at ${SHA}` }),
    foldRow({}),
    ledgerRow({ round: 67, text: `HEAD at ${SHA}（折叠后重跑取证）` }),
  ], { source: "loadRawRows" });
  const decision = inspectFinalDraft({ finalText: completeDraft(), messages: [], ledger });
  assert.equal(decision.action, "accept");
  const entry = decision.evidence.bases.find((item) => item.literal === SHA);
  assert.equal(entry.source, "ledger");
  assert.equal(entry.round, 67);
  assert.equal(entry.survivesLastCompaction, true, "67 > foldCeiling(62) ⇒ 最后一次压缩之后仍留有可引用的 tool_result");
});

test("P2 同一格把 ledger 去掉 ⇒ revise + untraceableBases 点名该值（账本才是证据面这一半的机器证据）", () => {
  const rows = [ledgerRow({ round: 23, text: `HEAD detached at ${SHA}` }), foldRow({})];
  const ledger = buildLedgerEvidence(rows, { source: "loadRawRows" });
  const withLedger = inspectFinalDraft({ finalText: completeDraft(), messages: [], ledger });
  const withoutLedger = inspectFinalDraft({ finalText: completeDraft(), messages: [] });
  assert.equal(withLedger.action, "accept", "同一份数据，接上账本就accept");
  assert.equal(withoutLedger.action, "revise", "把账本撤掉就必须重新红");
  assert.deepEqual(withoutLedger.untraceableBases, [SHA]);
});

test("P2b 命中判定复用 isBaseTraceable：十六进制忽大小写、非十六进制逐字（不许另开第二套口径）", () => {
  const ledger = buildLedgerEvidence([
    ledgerRow({ round: 4, text: "uppercase form 9C2A41B appears here" }),
    ledgerRow({ round: 5, text: "Release-Note appears here" }),
  ], { source: "loadRawRows" });
  const hex = inspectFinalDraft({ finalText: completeDraft({ base: "9C2A41B".toLowerCase() }), messages: [], ledger });
  assert.equal(hex.action, "accept", "账本里是 9C2A41B、声明是 9c2a41b ⇒ 同一条忽大小写口径必须命中");
  const prose = inspectFinalDraft({ finalText: completeDraft({ base: "release-note" }), messages: [], ledger });
  assert.equal(prose.action, "revise", "非十六进制的值必须逐字比（大小写不同就是找不到）");
  assert.deepEqual(prose.evidence.notInLedger, ["release-note"]);
});

test("P3 账本里也没有 ⇒ revise + notInLedger 点名；账本不完整（截断/读失败）时 notInLedger 必须为空", () => {
  const rows = [ledgerRow({ round: 23, text: "与本值无关的输出" }), foldRow({})];
  const complete = inspectFinalDraft({
    finalText: completeDraft(),
    messages: [],
    ledger: buildLedgerEvidence(rows, { source: "loadRawRows" }),
  });
  assert.equal(complete.action, "revise");
  assert.deepEqual(complete.untraceableBases, [SHA]);
  assert.deepEqual(complete.evidence.notInLedger, [SHA], "账本读全了 ⇒ 可以下「全账本 0 命中」这个结论");
  assert.match(complete.message, /全部账本/u, "revise 文案要给出路（重跑取证 或 移到「## 未验证」）");
  assert.match(complete.message, /未验证/u);

  // 截断：超限 ⇒ 不完整 ⇒ **不许**下 not_in_ledger 结论（宁可留今天的 max_retries）。
  const truncatedLedger = buildLedgerEvidence(rows, { source: "loadRawRows", rowLimit: 1 });
  assert.equal(truncatedLedger.truncated, true);
  const truncated = inspectFinalDraft({ finalText: completeDraft(), messages: [], ledger: truncatedLedger });
  assert.equal(truncated.action, "revise");
  assert.deepEqual(truncated.evidence.notInLedger, [], "账本被截断 ⇒ 0 命中不能当成「值不存在」");
  assert.equal(truncated.evidence.ledgerComplete, false);
  assert.doesNotMatch(truncated.message, /全部账本/u);

  // 读失败：同样是「不完整 ⇒ 不下结论」，但留痕要说清是哪一种。
  const failed = inspectFinalDraft({
    finalText: completeDraft(),
    messages: [],
    ledger: buildLedgerEvidence([], { source: "load_error", readFailed: true }),
  });
  assert.equal(failed.action, "revise");
  assert.deepEqual(failed.evidence.notInLedger, []);
  assert.equal(failed.evidence.ledgerComplete, false);
  assert.equal(failed.evidence.ledgerSource, "load_error");
});

test("P4 foldCeiling / foldRows 只从 foldedRoundRange 推（多行取 max(to)；无折叠行 ⇒ null / 0）", () => {
  const many = buildLedgerEvidence([
    foldRow({ round: 20, from: 1, to: 18 }),
    foldRow({ round: 62, from: 19, to: 57 }),
    foldRow({ round: 40, from: 58, to: 40 }),
    ledgerRow({ round: 70, text: "not a fold row" }),
  ], { source: "loadRawRows" });
  assert.equal(many.foldCeiling, 57, "max(to) = 57，不是最后一条行的 to、也不是最大 round");
  assert.equal(many.foldRows, 3);

  const none = buildLedgerEvidence([ledgerRow({ round: 3, text: "x" }), ledgerRow({ round: 4, text: "y" })], { source: "loadRawRows" });
  assert.equal(none.foldCeiling, null, "没有折叠行 ⇒ 本次没观察到压缩（不是 0）");
  assert.equal(none.foldRows, 0);
  assert.equal(none.ledgerComplete, true, "没压缩 ≠ 账本不完整");

  // 命中轮 > foldCeiling ⇒ survivesLastCompaction:true（判据 ② 的另一半）。
  const afterFold = inspectFinalDraft({
    finalText: completeDraft(),
    messages: [],
    ledger: buildLedgerEvidence([foldRow({ round: 62, from: 1, to: 60 }), ledgerRow({ round: 61, text: `${SHA} here` })], { source: "loadRawRows" }),
  });
  assert.equal(afterFold.action, "accept");
  assert.equal(afterFold.evidence.bases.find((item) => item.literal === SHA).survivesLastCompaction, true);

  // 无折叠行时不许假称「 survivesLastCompaction」（没有压缩可比较）。
  const noFold = inspectFinalDraft({
    finalText: completeDraft(),
    messages: [],
    ledger: buildLedgerEvidence([ledgerRow({ round: 2, text: `${SHA} here` })], { source: "loadRawRows" }),
  });
  assert.equal(noFold.action, "accept");
  const entry = noFold.evidence.bases.find((item) => item.literal === SHA);
  assert.equal(entry.survivesLastCompaction, null, "没观察到压缩 ⇒ 这个键必须是 null 而不是 true/false");
});

test("P4b 上限：行超限只留最新的 N 行并置 truncated；diagnostics 清单另有小上限", () => {
  assert.equal(guardModule.LEDGER_EVIDENCE_ROW_LIMIT, 4000);
  const limit = guardModule.LEDGER_EVIDENCE_ROW_LIMIT;
  const rows = Array.from({ length: limit + 2 }, (_, index) => ledgerRow({ round: index + 1, text: `r${index + 1}` }));
  const capped = buildLedgerEvidence(rows, {});
  assert.equal(capped.rows.length, limit);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rows.at(-1).round, rows.at(-1).round, "超限必须留**最新**的 N 行");
  assert.equal(capped.ledgerComplete, false, "截断 ⇒ 账本不完整");

  const underLimit = buildLedgerEvidence(rows.slice(0, 5), {});
  assert.equal(underLimit.truncated, false);
  assert.equal(underLimit.ledgerComplete, true);

  // 逐字面值清单的小上限：20 条 + literalsTruncated（清单只是 diagnostics，不是判定面）。
  const manyLiterals = Array.from({ length: 30 }, (_, index) => `v1.0.${index}`).join("\n- ");
  const draft = `## 取证边界\nx\n\n## 基点\n- ${manyLiterals}\n\n## 结论\nz\n\n## 未验证\n无`;
  const decision = inspectFinalDraft({
    finalText: draft,
    messages: messagesWith("v1.0.0 v1.0.1 v1.0.2"),
    ledger: buildLedgerEvidence([ledgerRow({ round: 1, text: "nothing" })], {}),
  });
  assert.equal(decision.evidence.bases.length, guardModule.LEDGER_LITERAL_LIMIT, `清单条数上限 ${guardModule.LEDGER_LITERAL_LIMIT}，实得 ${decision.evidence.bases.length}`);
  assert.equal(decision.evidence.literalsTruncated, true);
  assert.equal(decision.declaredBases.length, 30, "上限只削 diagnostics 清单，不削判定用的声明值集合");
});

test("P5 honestVerificationReason 真值表：四条同时成立才改口，缺一条就回今天的原值", () => {
  const unverified = { status: "unverified", reason: "max_retries" };
  const goodTally = { notInLedgerBases: [SHA], ledgerComplete: true, compactionObserved: true };
  assert.equal(honestVerificationReason({ verification: unverified, tally: goodTally }), "not_in_ledger");

  // 缺条件 2：末次 attempt 没记下 0 命中的基点
  assert.equal(honestVerificationReason({ verification: unverified, tally: { ...goodTally, notInLedgerBases: [] } }), null);
  assert.equal(honestVerificationReason({ verification: unverified, tally: { ...goodTally, notInLedgerBases: undefined } }), null);
  // 缺条件 3：账本没读全
  assert.equal(honestVerificationReason({ verification: unverified, tally: { ...goodTally, ledgerComplete: false } }), null);
  // 缺条件 4：没观察到压缩
  assert.equal(honestVerificationReason({ verification: unverified, tally: { ...goodTally, compactionObserved: false } }), null);
  // 条件 1：reason 不是 max_retries / status 不是 unverified / tally 缺席
  assert.equal(honestVerificationReason({ verification: { status: "unverified", reason: "deliverables_failed" }, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: { status: "unverified", reason: "non_continuable" }, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: { status: "verified" }, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: { status: "skipped", reason: "no_final_guard" }, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: { status: "error", reason: "timeout" }, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: undefined, tally: goodTally }), null);
  assert.equal(honestVerificationReason({ verification: unverified, tally: undefined }), null);
  assert.equal(honestVerificationReason(), null);
});

test("P5b 观测面：证据面存在时 summarizeFinalGuard 追加尾巴，没有证据面时那一行与今天逐字一致", () => {
  const tally = createFinalGuardTally();
  const plain = summarizeFinalGuard(tally);
  assert.match(plain, /calls=0/u);
  assert.match(plain, /revise=0\/2/u);
  // 挂上证据面（末次 attempt 的事实）
  tally.evidence = {
    bases: [{ literal: SHA, source: "ledger", round: 23, survivesLastCompaction: false }],
    notInLedger: [],
    foldCeiling: FOLD_CEILING,
    foldRows: 1,
    ledgerComplete: true,
    ledgerSource: "loadRawRows",
  };
  const withEvidence = summarizeFinalGuard(tally);
  assert.ok(withEvidence.startsWith(plain), "尾巴只能是**追加**，前半段一个字都不许动");
  assert.match(withEvidence, /证据面=存活窗口∪账本/u);
  assert.match(withEvidence, /loadRawRows/u);
  assert.match(withEvidence, /折叠 1 层/u);

  const incomplete = { ...tally.evidence, ledgerComplete: false, notInLedger: [SHA] };
  assert.match(summarizeFinalGuard({ ...tally, evidence: incomplete }), /账本不完整/u);
});

// ---------------------------------------------------------------------------
// R2（审计返工）：F1/F2 是读口的信任边界，F4 是诊断粒度。**accept/revise 的判定一个字没改**，
// 这几格钉的是「不许把不完整的证据面当成完整」+「折叠前后都命中时，两个轮号都要看得见」。
// 工单：docs/tasks/active/261109-797-finalguard-evidence-surface/ticket-r2.md
// ---------------------------------------------------------------------------

test("P7 首次命中在折叠前、最后一次在折叠后 ⇒ round=lastRound、firstRound 如实、survivesLastCompaction:true", () => {
  // 真机样本的形状（`/tmp/762/segment-09`）：同一个值在 r23/r59/r61 与 r67 都命中，水位 62。
  const ledger = buildLedgerEvidence([
    ledgerRow({ round: 23, text: `HEAD at ${SHA}` }),
    ledgerRow({ round: 59, text: `re-printed ${SHA}` }),
    foldRow({}),
    ledgerRow({ round: 67, text: `still there ${SHA}` }),
  ], { source: "loadRawRows" });
  const decision = inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith("无关文本"), ledger });
  assert.equal(decision.action, "accept", JSON.stringify(decision));
  const entry = decision.evidence.bases.find((item) => item.literal === SHA);
  assert.equal(entry.lastRound, 67);
  assert.equal(entry.firstRound, 23, "首次命中轮必须如实露出来（它是诊断项）");
  assert.equal(entry.round, 67, "round 仍 = lastRound（既有 P1b 的「取最新」语义不许动）");
  assert.equal(entry.survivesLastCompaction, true, "闸门问的是「折叠后还剩没剩一处」，r67 > 62 ⇒ 有");
  assert.equal(decision.evidence.foldCeiling, FOLD_CEILING);
  // 尾巴必须把「首次已被折叠、只剩重复命中」写出来（自指回显风险要可见；出处链本单不修）。
  const tally = createFinalGuardTally();
  tally.evidence = decision.evidence;
  assert.match(summarizeFinalGuard(tally), /首次命中第 23 轮（≤ 水位）／最后一次第 67 轮/u);
});

test("P8 只在折叠前命中 ⇒ survivesLastCompaction:false 但**仍然 accept**（issue 反向证要求的格）", () => {
  // issue #797 自己的反向证：取证发生在折叠前、终稿在折叠后 ⇒ 修后必须 accept。
  // 若把闸门改成「按首次出现轮判」，这一格就会翻成 revise —— 所以判定口径不许动。
  const ledger = buildLedgerEvidence([
    ledgerRow({ round: 12, text: `HEAD at ${SHA}` }),
    ledgerRow({ round: 40, text: `again ${SHA}` }),
    foldRow({}),
  ], { source: "loadRawRows" });
  const decision = inspectFinalDraft({ finalText: completeDraft(), messages: messagesWith("无关文本"), ledger });
  assert.equal(decision.action, "accept", "折叠前取过证就是取过证：证据面里逐字在账 ⇒ accept");
  const entry = decision.evidence.bases.find((item) => item.literal === SHA);
  assert.equal(entry.survivesLastCompaction, false, "折叠后一处不剩 ⇒ 这一项如实是 false（只当诊断）");
  assert.equal(entry.firstRound, 12);
  assert.equal(entry.round, 40);
  assert.deepEqual(decision.evidence.notInLedger, [], "命中了就不该进 0 命中名单");
});

test("P9 注入的「成形证据」必须被重建：自报的 ledgerComplete / truncated / foldCeiling 一律不算数", async () => {
  const readLedgerEvidence = (...args) => coreModule.readLedgerEvidence(...args);
  // ① 自称完整 + 自称截断 + 其实空账本：不许原样返回，也不许据此说 not_in_ledger。
  const preformed = {
    rows: [], foldRows: 1, foldCeiling: 62, truncated: true, readFailed: false,
    source: "injected", ledgerComplete: true, rowLimit: 4000,
  };
  const rebuilt = await readLedgerEvidence({ runId: "r", deps: { finalGuardLedger: () => preformed } });
  assert.notEqual(rebuilt, preformed, "必须重建：原样返回就是让调用方自己填元数据");
  assert.equal(rebuilt.ledgerComplete, false, "0 行的账本撑不起「全账本 0 命中」⇒ 不完整");
  assert.equal(rebuilt.foldCeiling, null, "注入的 foldCeiling:62 不算数（折叠事实只从 rows 推）");
  assert.equal(rebuilt.foldRows, 0);
  assert.equal(rebuilt.source, "injected", "注入对象只许贡献 rows 与 source 两样");
  const decision = inspectFinalDraft({
    finalText: completeDraft({ base: OTHER_SHA }),
    messages: messagesWith("存活窗口里没有那个值"),
    ledger: rebuilt,
  });
  assert.equal(decision.action, "revise");
  assert.deepEqual(decision.evidence.notInLedger, [], "账本不完整 ⇒ 不许下 0 命中的结论");
  assert.equal(honestVerificationReason({
    verification: { status: "unverified", reason: "max_retries" },
    tally: {
      notInLedgerBases: decision.evidence.notInLedger,
      ledgerComplete: decision.evidence.ledgerComplete,
      compactionObserved: decision.evidence.foldCeiling !== null,
    },
  }), null, "自称完整的空账本不许把 reason 改成 not_in_ledger");

  // ② `rowLimit` 也不许被绕过：注入一份「已经成形」的 4001 行证据 + rowLimit:1 ⇒ 重建后必须 ≤1 行且 truncated。
  const many = Array.from({ length: guardModule.LEDGER_EVIDENCE_ROW_LIMIT + 1 }, (_, i) => ({ round: i + 1, messages: [] }));
  const capped = await readLedgerEvidence({
    runId: "r",
    deps: {
      finalGuardLedger: () => buildLedgerEvidence(many, { source: "injected" }),
      finalGuardLedgerRowLimit: 1,
    },
  });
  assert.ok(capped.rows.length <= 1, `重建后必须吃到 rowLimit，实得 ${capped.rows.length} 行`);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rowLimit, 1);
});

test("P10 注入函数抛错必须被读口吞掉；脏行（rows:[null]）不许把谓词炸掉", async () => {
  const readLedgerEvidence = (...args) => coreModule.readLedgerEvidence(...args);
  let threw = null;
  let evidence = null;
  try {
    evidence = await readLedgerEvidence({
      runId: "r",
      deps: { finalGuardLedger: () => { throw new Error("inject boom"); } },
    });
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null, `读口承诺「永不抛」：注入函数抛错必须在读口里吞掉（实际抛了 ${threw?.message}）`);
  assert.equal(evidence.source, "injected:error");
  assert.equal(evidence.readFailed, true);
  assert.equal(evidence.ledgerComplete, false);
  assert.match(String(evidence.readError), /inject boom/u, "吞掉不等于不记账：原因要留在 diagnostics");
  // 脏行：谓词**直接**拿到 rows:[null] 也不许 TypeError，必须 fail closed 判 revise。
  const dirty = inspectFinalDraft({
    finalText: completeDraft({ base: OTHER_SHA }),
    messages: messagesWith("无关文本"),
    ledger: { rows: [null], foldCeiling: null, foldRows: 0, ledgerComplete: true },
  });
  assert.equal(dirty.action, "revise", JSON.stringify(dirty));
  assert.deepEqual(dirty.untraceableBases, [OTHER_SHA]);
  // 同一条脏行从读口进来（注入成形对象）也要被重建掉。
  const rebuilt = await readLedgerEvidence({ runId: "r", deps: { finalGuardLedger: () => ({ rows: [null] }) } });
  const viaRebuild = inspectFinalDraft({
    finalText: completeDraft({ base: OTHER_SHA }),
    messages: messagesWith("无关文本"),
    ledger: rebuilt,
  });
  assert.equal(viaRebuild.action, "revise");
  assert.deepEqual(viaRebuild.untraceableBases, [OTHER_SHA]);
});
