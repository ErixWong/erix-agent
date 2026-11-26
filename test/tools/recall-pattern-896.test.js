// issue #896 B 层：recall_read 的 pattern（grep 式确定性回忆）+ 硬顶 + 三态。
// 判据 7 格逐一对应；逐字模式回归另测。纯手搓账本行，零 provider / 零 port。

import test from "node:test";
import assert from "node:assert/strict";

import { createBuiltinRecallTools } from "../../src/index.js";
import { estimateTokens } from "../../src/tokens.js";
// 硬顶一律**引常量**，不手抄数字（copilot #964 ②）。
import { MAX_OVERVIEW_TOKENS, MAX_PATTERN_ECHO_CHARS, MAX_TOTAL_TOKENS } from "../../src/tools/recall.js";

/** @param {any[]} rows */
const tool = (rows) => createBuiltinRecallTools({ readLedgerRows: () => rows });

/** 取一条结果的段 token 与单段 token 上限。 */
function segmentTokenStats(result) {
  const per = result.segments.map((s) => estimateTokens(s.excerpt));
  return { per, total: per.reduce((a, b) => a + b, 0) };
}

// ─── 格 1：子串命中 ────────────────────────────────────────────────────────────

test("#896B-1 子串命中：普通词 ⇒ found、matchedBy=substring、excerpt 逐字含它", async () => {
  const rows = [
    { round: 2, messages: [{ role: "user", content: "please wire RECALL_SUB_TOKEN into the pipeline now" }] },
  ];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "RECALL_SUB_TOKEN" } }));
  assert.equal(r.status, "found");
  assert.equal(r.matchedBy, "substring");
  assert.equal(r.matchCount, 1);
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.equal(seg.round, 2);
  assert.equal(seg.messageIndex, 0);
  assert.equal(seg.matchedBy, "substring");
  assert.ok(seg.excerpt.includes("RECALL_SUB_TOKEN"), "excerpt 必须逐字包含命中词");
  assert.equal(seg.bytes, Buffer.byteLength(seg.excerpt, "utf8"));
});

// ─── 格 2：正则命中 ────────────────────────────────────────────────────────────

test("#896B-2 正则命中：pattern 含元字符 ⇒ matchedBy=regex", async () => {
  const rows = [
    { round: 4, messages: [{ role: "assistant", content: "alloc R42 slots and R7 cores" }] },
  ];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "R[0-9]+" } }));
  assert.equal(r.status, "found");
  assert.equal(r.matchedBy, "regex");
  assert.equal(r.segments[0].matchedBy, "regex");
  assert.ok(r.segments[0].excerpt.includes("R42"));
});

// ─── 格 3：非法正则回落子串（不许抛）─────────────────────────────────────────────

test("#896B-3 非法正则回落子串：'(' 含元字符但正则非法 ⇒ 不抛、按子串命中", async () => {
  const rows = [
    { round: 1, messages: [{ role: "user", content: "call parse( with care" }] },
  ];
  let parsed;
  try {
    parsed = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "(" } }));
  } catch (err) {
    assert.fail(`非法正则必须回落子串、绝不抛，实际抛出：${err && err.message}`);
  }
  assert.equal(parsed.status, "found");
  assert.equal(parsed.matchedBy, "substring", "非法正则必须回落 substring");
  assert.ok(parsed.segments[0].excerpt.includes("("));
});

// ─── 格 4：fromRound / toRound 限定区间 ─────────────────────────────────────────

test("#896B-4 区间限定：区间外的命中不出现", async () => {
  const rows = [
    { round: 2, messages: [{ role: "user", content: "marker=WIN in round 2" }] },
    { round: 5, messages: [{ role: "user", content: "marker=WIN in round 5" }] },
  ];
  const narrow = JSON.parse(await tool(rows).executeTool({
    name: "recall_read", input: { pattern: "marker=WIN", fromRound: 1, toRound: 3 },
  }));
  assert.equal(narrow.status, "found");
  assert.deepEqual(narrow.segments.map((s) => s.round), [2], "toRound=3 时 round 5 的命中必须被排除");

  const wide = JSON.parse(await tool(rows).executeTool({
    name: "recall_read", input: { pattern: "marker=WIN", fromRound: 3, toRound: 9 },
  }));
  assert.deepEqual(wide.segments.map((s) => s.round), [5], "fromRound=3 时 round 2 的命中必须被排除");
});

// ─── 格 5：硬顶（段数 / 单段 / 总 token / 可检测标记）──────────────────────────────

test("#896B-5a 硬顶·段数：多处命中 ⇒ segments≤5、segmentsOmitted>0、truncated:true、总 token≤1500", async () => {
  const rows = [{
    round: 1,
    messages: Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `line ${i} NEEDLE here` })),
  }];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "NEEDLE" } }));
  assert.equal(r.status, "found");
  assert.equal(r.matchCount, 8);
  assert.ok(r.segments.length <= 5, `segments 必须 ≤5，实得 ${r.segments.length}`);
  assert.equal(r.segments.length, 5);
  assert.equal(r.segmentsOmitted, 3);
  assert.equal(r.truncated, true, "段数被硬顶截断必须带 truncated:true");
  const { total } = segmentTokenStats(r);
  assert.ok(total <= 1500, `总 token 必须 ≤1500，实得 ${total}`);
});

test("#896B-5b 硬顶·单段：超长命中 ⇒ 单段≤300 tok、truncated:true、excerpt 仍是逐字前缀", async () => {
  const big = "A".repeat(2000);
  const rows = [{ round: 3, messages: [{ role: "user", content: big }] }];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "A+" } }));
  assert.equal(r.status, "found");
  assert.equal(r.segments.length, 1);
  const { per } = segmentTokenStats(r);
  assert.ok(per[0] <= 300, `单段必须 ≤300 tok，实得 ${per[0]}`);
  assert.equal(r.truncated, true, "单段被夹到硬顶必须带 truncated:true");
  assert.ok(big.startsWith(r.segments[0].excerpt), "excerpt 必须是逐字原文的切片（前缀）");

  // ④（copilot #964）：摘录必须是**某一个原文块**的切片，绝不跨块拼接边界。
  const blocks = [
    { type: "text", text: "BOUNDARY_HEAD one" },
    { type: "text", text: "BOUNDARY_TAIL two" },
  ];
  const blockRows = [{ round: 6, messages: [{ role: "assistant", content: blocks }] }];
  const inSecond = JSON.parse(await tool(blockRows)
    .executeTool({ name: "recall_read", input: { pattern: "BOUNDARY_TAIL" } }));
  assert.equal(inSecond.status, "found");
  assert.ok(blocks[1].text.includes(inSecond.segments[0].excerpt),
    "excerpt 必须是第二个原始块的切片（不得含拼接出来的跨块文本）");

  // 拼成整条正文（旧实现 join("\n")）后这个 pattern 会命中「one\nBOUNDARY_TAIL」——
  // 逐块匹配后必须 no_match：那个换行是拼接造出来的，原文里没有。
  const spansBoundary = JSON.parse(await tool(blockRows)
    .executeTool({ name: "recall_read", input: { pattern: "one\nBOUNDARY_TAIL" } }));
  assert.equal(spansBoundary.status, "no_match",
    "跨拼接边界的 pattern 不得命中（那拼接符不是原文）");
});

// ─── 格 6：三态各一格（empty / unrecoverable / truncated）──────────────────────────

test("#896B-6a empty：空账本 ⇒ status=empty", async () => {
  const r = JSON.parse(await tool([]).executeTool({ name: "recall_read", input: { pattern: "anything" } }));
  assert.equal(r.status, "empty");
  assert.deepEqual(r.segments, []);
});

test("#896B-6b unrecoverable：有轮行但无 messages ⇒ status=unrecoverable", async () => {
  const rows = [{ round: 5 }, { round: 6 }];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "anything" } }));
  assert.equal(r.status, "unrecoverable");
  assert.deepEqual(r.segments, []);
});

test("#896B-6c truncated：命中轮 foldedPayloadMeta.droppedMessages>0 且无命中 ⇒ status=truncated", async () => {
  // 有正文（避开 unrecoverable/empty），但 pattern 不命中；窗口内有夹断留痕 ⇒ 报 truncated（比 no_match 保守）。
  const rows = [{
    round: 2,
    messages: [{ role: "user", content: "surviving fragment after clamp" }],
    foldedPayloadMeta: { count: 1, bytes: 10, droppedMessages: 3, droppedBytes: 999 },
  }];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "ZZZ_NOT_THERE" } }));
  assert.equal(r.status, "truncated");
  assert.equal(r.truncated, true);
  assert.equal(r.clamped, true);
});

test("#896B-6d truncated（droppedBytes>0 也触发）", async () => {
  const rows = [{
    round: 2,
    messages: [{ role: "user", content: "kept text" }],
    foldedPayloadMeta: { count: 1, bytes: 5, droppedMessages: 0, droppedBytes: 42 },
  }];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "ZZZ" } }));
  assert.equal(r.status, "truncated");
});

// ─── 格 7：no_match 与 empty 分得开 ──────────────────────────────────────────────

test("#896B-7 no_match 与 empty 分得开：两种输入 ⇒ 两种 status", async () => {
  const noMatchRows = [{ round: 1, messages: [{ role: "user", content: "totally unrelated text" }] }];
  const noMatch = JSON.parse(await tool(noMatchRows).executeTool({ name: "recall_read", input: { pattern: "GHOST_WORD" } }));
  assert.equal(noMatch.status, "no_match");
  assert.equal(noMatch.truncated, false);

  const empty = JSON.parse(await tool([]).executeTool({ name: "recall_read", input: { pattern: "GHOST_WORD" } }));
  assert.equal(empty.status, "empty");

  assert.notEqual(noMatch.status, empty.status, "no_match 与 empty 必须是不同 status");
});

// ─── 格 8：pattern 回显硬顶与返回 JSON 总量（copilot ②）────────────────────────

test("#896B-8 pattern 回显硬顶：超长 pattern ⇒ 截到 200 字符、patternTruncated:true、返回 JSON 总 token ≤ 1500+500", async () => {
  // pattern 无元字符⇒子串匹配；它同时是检索目标，所以既能撞满段硬顶又能撞回显顶。
  const bigPattern = "D".repeat(8000);
  const rows = [{
    round: 1,
    messages: Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `lead ${i} ${bigPattern} tail` })),
  }];
  const raw = await tool(rows).executeTool({ name: "recall_read", input: { pattern: bigPattern } });
  const r = JSON.parse(raw);
  assert.equal(r.status, "found");

  // 真比：未截断的 pattern 单独就该爆预算——否则这格证明不了截断真在做事。
  assert.ok(estimateTokens(bigPattern) > MAX_TOTAL_TOKENS + MAX_OVERVIEW_TOKENS,
    `原样回显的 pattern 单独就该超预算（实际 ${estimateTokens(bigPattern)} tok），否则测不出硬顶作用`);

  assert.equal(r.pattern.length, MAX_PATTERN_ECHO_CHARS, `回显 pattern 必须截到 ${MAX_PATTERN_ECHO_CHARS} 字符`);
  assert.equal(r.patternTruncated, true, "截了必须带 patternTruncated:true");
  assert.ok(bigPattern.startsWith(r.pattern), "回显必须是原 pattern 的前缀（不许造字符）");

  const total = estimateTokens(raw);
  assert.ok(total <= MAX_TOTAL_TOKENS + MAX_OVERVIEW_TOKENS,
    `返回 JSON 总 token 必须 ≤ ${MAX_TOTAL_TOKENS}+${MAX_OVERVIEW_TOKENS}，实得 ${total}`);
});

// ─── 格 9/10：元字符两种情况（copilot ⑤ 点名没覆盖的两个例子）───────────────────────

test("#896B-9 含元字符但正则非法：'foo(bar' ⇒ 不抛、回落子串、命中字面量 foo(bar", async () => {
  const rows = [{ round: 3, messages: [{ role: "assistant", content: "render foo(bar) with care" }] }];
  let r;
  try {
    r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "foo(bar" } }));
  } catch (err) {
    assert.fail(`非法正则必须回落子串、绝不抛，实际抛出：${err && err.message}`);
  }
  assert.equal(r.status, "found");
  assert.equal(r.matchedBy, "substring", "'foo(bar' 含 '(' 但正则非法，必须回落 substring");
  assert.equal(r.segments[0].matchedBy, "substring");
  assert.ok(r.segments[0].excerpt.includes("foo(bar"), "命中的是字面量 foo(bar");
});

test("#896B-10 含元字符且正则合法：'a.b' ⇒ matchedBy=regex、且能命中 axb（证明没回落成子串）", async () => {
  const rows = [
    { round: 1, messages: [{ role: "user", content: "the token axb appears here" }] },
    { round: 2, messages: [{ role: "user", content: "and the literal a.b too" }] },
  ];
  const r = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { pattern: "a.b" } }));
  assert.equal(r.status, "found");
  assert.equal(r.matchedBy, "regex", "'a.b' 含 '.' 且正则合法，必须走 regex");
  assert.equal(r.matchCount, 2, "axb 与 a.b 都应命中");
  assert.equal(r.segments[0].round, 1, "round 1（axb）必须进了命中");
  assert.ok(r.segments[0].excerpt.includes("axb"),
    "只有真走正则才能命中 axb；若回落成子串，axb 不会命中");
});

// ─── 逐字模式回归：无 pattern 时行为不变 ──────────────────────────────────────────

test("#896B-reg 逐字模式回归：给 round 无 pattern ⇒ 仍返回逐字 messages；缺轮 not_folded", async () => {
  const userMsg = { role: "user", content: "VERBATIM_R2_" + "u".repeat(20) };
  const rows = [
    { kind: "message", round: 2, seq: 0, messages: [userMsg] },
  ];
  const r2 = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { round: 2 } }));
  assert.equal(r2.status, "found");
  assert.equal(JSON.stringify(r2.messages), JSON.stringify([userMsg]));

  const missing = JSON.parse(await tool(rows).executeTool({ name: "recall_read", input: { round: 99 } }));
  assert.equal(missing.status, "not_folded");
  assert.ok(!("messages" in missing));
});

test("#896B-invalid：fromRound>toRound / pattern 非字符串 ⇒ invalid", async () => {
  const badRange = JSON.parse(await tool([{ round: 1, messages: [{ content: "x" }] }])
    .executeTool({ name: "recall_read", input: { pattern: "x", fromRound: 5, toRound: 2 } }));
  assert.equal(badRange.status, "invalid");

  const badPattern = JSON.parse(await tool([{ round: 1, messages: [{ content: "x" }] }])
    .executeTool({ name: "recall_read", input: { pattern: 7 } }));
  assert.equal(badPattern.status, "invalid");

  // ①（copilot #964 P0）：schema 不再 hard-require round，“round 与 pattern 至少给一个”由代码校。
  const { definitions } = createBuiltinRecallTools({ readLedgerRows: () => [] });
  assert.deepEqual(definitions[0].inputSchema.required ?? [], [],
    "inputSchema.required 不得再含 round（否则合规调用方没法只给 pattern）");

  const neither = JSON.parse(await tool([{ round: 1, messages: [{ content: "x" }] }])
    .executeTool({ name: "recall_read", input: {} }));
  assert.equal(neither.status, "invalid", "round 与 pattern 都没给 ⇒ invalid");
});
