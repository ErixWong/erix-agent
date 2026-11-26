// issue #896 B 层：recall_read 的 pattern（grep 式确定性回忆）+ 硬顶 + 三态。
// 判据 7 格逐一对应；逐字模式回归另测。纯手搓账本行，零 provider / 零 port。

import test from "node:test";
import assert from "node:assert/strict";

import { createBuiltinRecallTools } from "../../src/index.js";
import { estimateTokens } from "../../src/tokens.js";

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
});
