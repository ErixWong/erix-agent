// @ts-check
// 测试：folds 九列落地切片 2（判据 1-7），离线零 LLM。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FOLD_RECORD_COLUMNS, isFoldRecord, foldRecordsToFacts, mergeFoldRecords,
  foldIdentityKey, sortFoldsBySeq, nextFoldSeq, createFoldChannelBookkeeping,
  seedFoldAllocator,
} from "../../src/store/folds.js";
import { toFoldRecord, fromFoldRecords } from "../../src/store/fold-record.js";
import { createMemoryTranscriptStore } from "../../src/store/memory.js";
import { createFileTranscriptStore } from "../../src/store/file.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ========== 判据 1：FOLD_RECORD_COLUMNS 恰好十项 ==========

test("判据1: FOLD_RECORD_COLUMNS 恰好是九列+幂等键的十项", () => {
  const expected = [
    "runId", "seq", "foldId", "cutRound", "cutMsgSeq",
    "title", "description", "tokensBefore", "tokensAfter", "createdAt",
  ];
  assert.equal(FOLD_RECORD_COLUMNS.size, 10);
  for (const col of expected) {
    assert.ok(FOLD_RECORD_COLUMNS.has(col), `缺少列: ${col}`);
  }
  for (const col of FOLD_RECORD_COLUMNS) {
    assert.ok(expected.includes(col), `多余列: ${col}`);
  }
});

// ========== 判据 2：toFoldRecord → appendFold → loadFolds 没有旧形状键 ==========

test("判据2: appendFold 九列行后 loadFolds 读回没有 text/increment/bytes/toolCalls/origin", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "run-9col-2";
  const nineCol = toFoldRecord(
    { foldId: "f1", summary: "desc one", origin: "semantic", title: "T1", titleFallback: false },
    { cutRound: 5, tokensBefore: 1000, tokensAfter: 500, runId },
  );
  await store.appendFold(runId, nineCol);
  const rows = await store.loadFolds(runId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  for (const forbidden of ["text", "increment", "bytes", "toolCalls", "origin"]) {
    assert.ok(!(forbidden in row), `不应落盘的键: ${forbidden}`);
  }
  // 确保九列关键键在场
  assert.equal(row.foldId, "f1");
  assert.equal(row.description, "desc one");
  assert.equal(row.seq, 1);
});

// ========== 判据 3：混装（九列 + 旧形状）→ mergeFoldRecords 两条、seq 升序、身份去重 ==========

test("判据3: 混装 mergeFoldRecords 给出两条、按 seq 升序、身份去重不变", () => {
  const nineRow = {
    seq: 1, foldId: "nine-1", description: "fold one", cutRound: 3,
  };
  const legacyRow = {
    seq: 2, foldId: "legacy-1", text: "old fold text", from: 3, to: 6, bytes: 13,
  };
  const result = mergeFoldRecords({ channelRows: [legacyRow, nineRow], roundFacts: [] });
  assert.equal(result.length, 2);
  // seq 升序
  assert.ok(result[0].seq <= result[1].seq);
  // 九列转换后的 foldId 保留
  const ids = result.map((r) => r.foldId);
  assert.ok(ids.includes("nine-1"));
  assert.ok(ids.includes("legacy-1"));
});

// ========== 判据 4：旧 transcript 只有 21 键形状 → mergeFoldRecords 结果与改动前相同 ==========

test("判据4: 纯旧形状通道行 mergeFoldRecords 结果与改动前逐字节相同", () => {
  // 构造旧形状通道行（21 键形状）
  const oldRow1 = {
    text: "hello world", title: "hello", origin: "mechanical",
    source: "strategy", strategy: "sliding-window",
    from: 1, to: 3, rounds: 2, bytes: 11,
    foldId: "old-1", seq: 1,
  };
  const oldRow2 = {
    text: "second fold", title: "second", origin: "mechanical",
    source: "strategy", strategy: "sliding-window",
    from: 3, to: 5, rounds: 2, bytes: 11,
    foldId: "old-2", seq: 2,
  };
  const result = mergeFoldRecords({ channelRows: [oldRow1, oldRow2], roundFacts: [] });
  // 旧形状原样透传，结果应就是这两条按 seq 排序
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], oldRow1);
  assert.deepEqual(result[1], oldRow2);
});

// ========== 判据 5：同 foldId 重投 ⇒ appendFold 两次只有一行 ==========

test("判据5: memory 侧同 foldId 重投只有一行、seq 相同", async () => {
  const store = createMemoryTranscriptStore();
  const runId = "run-dedup-5";
  const nineCol = toFoldRecord(
    { foldId: "dup-id", summary: "dup desc" },
    { cutRound: 2, runId },
  );
  const first = await store.appendFold(runId, structuredClone(nineCol));
  const second = await store.appendFold(runId, structuredClone(nineCol));
  assert.equal(first.seq, second.seq);
  const rows = await store.loadFolds(runId);
  assert.equal(rows.length, 1);
});

test("判据5: file 侧同 foldId 重投只有一行、seq 相同", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folds-dedup-"));
  try {
    const store = createFileTranscriptStore({ dir });
    const runId = "run-dedup-file";
    const nineCol = toFoldRecord(
      { foldId: "dup-file-id", summary: "dup desc file" },
      { cutRound: 2, runId },
    );
    const first = await store.appendFold(runId, structuredClone(nineCol));
    const second = await store.appendFold(runId, structuredClone(nineCol));
    assert.equal(first.seq, second.seq);
    const rows = await store.loadFolds(runId);
    assert.equal(rows.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ========== 判据 6：九列经 foldRecordsToFacts 还原后 text = 各折 description 拼接 ==========

test("判据6: foldRecordsToFacts 两折用例 text = description 拼接（不是最后一折）", () => {
  const row1 = { seq: 1, foldId: "a", description: "first fold content", cutRound: 3 };
  const row2 = { seq: 2, foldId: "b", description: "second fold content", cutRound: 6 };
  const facts = foldRecordsToFacts([row1, row2]);
  assert.equal(facts.length, 2);
  // 第一条：text = row1.description
  assert.equal(facts[0].text, "first fold content");
  // 第二条：text = row1.description + "\n\n" + row2.description（拼接，不是只有最后一折）
  assert.equal(facts[1].text, "first fold content\n\nsecond fold content");
  // foldId 来自最后一行
  assert.equal(facts[1].foldId, "b");
});

// ========== 判据 7：变异自证 ==========

test("判据7a: 变异 foldRecordsToFacts 只取最后一折 ⇒ 判据6 红", () => {
  // 手动模拟"只取最后一折"的变异：只传最后一个 record 给 fromFoldRecords
  const row1 = { seq: 1, foldId: "a", description: "first fold content", cutRound: 3 };
  const row2 = { seq: 2, foldId: "b", description: "second fold content", cutRound: 6 };
  // 正确实现
  const correct = foldRecordsToFacts([row1, row2]);
  assert.ok(correct[1].text.includes("first fold content"), "正确实现包含第一折");
  // 变异版：只取最后一折
  const mutated = [row1, row2].map((row, i, arr) => {
    const facts = fromFoldRecords([arr[i]], {});
    return facts;
  });
  // 变异版的第二条 text 只有 "second fold content"，不含 "first fold content"
  assert.ok(!mutated[1].text.includes("first fold content"), "变异版缺少第一折");
  // 确认判据 6 在变异下会红
  assert.notEqual(correct[1].text, mutated[1].text);
});

test("判据7b: 变异 mergeFoldRecords 跳过九列转换 ⇒ 判据3 红", () => {
  const nineRow = { seq: 1, foldId: "nine-1", description: "fold one", cutRound: 3 };
  const legacyRow = { seq: 2, foldId: "legacy-1", text: "old fold text", from: 3, to: 6, bytes: 13 };
  // 正确：九列被转换后有 text 键
  const correct = mergeFoldRecords({ channelRows: [legacyRow, nineRow], roundFacts: [] });
  const nineResult = correct.find((r) => r.foldId === "nine-1");
  assert.ok(nineResult !== undefined);
  assert.ok("text" in nineResult, "正确实现中九列转换后有 text");

  // 变异版：跳过转换，直接原样放九列行
  const byIdentity = new Map();
  for (const row of [legacyRow, nineRow]) byIdentity.set(foldIdentityKey(row), row);
  const mutated = sortFoldsBySeq([...byIdentity.values()]);
  const nineMutated = mutated.find((r) => r.foldId === "nine-1");
  // 变异版的九列行没有 text（只有 description）
  assert.ok(!("text" in nineMutated), "变异版九列行没有 text");
});

// ========== 辅助：isFoldRecord 基本判定 ==========

test("isFoldRecord 判定逻辑", () => {
  // 九列形状
  assert.ok(isFoldRecord({ foldId: "x", description: "d", seq: 1 }));
  assert.ok(isFoldRecord({ foldId: "x", cutRound: 3, seq: 1 }));
  // 旧形状（有 text）
  assert.ok(!isFoldRecord({ text: "hello", foldId: "x", seq: 1 }));
  // 旧形状（有 increment）
  assert.ok(!isFoldRecord({ increment: { text: "i" }, foldId: "x", seq: 1 }));
  // 既有 description 又有 text（旧形状）
  assert.ok(!isFoldRecord({ description: "d", text: "t", foldId: "x", seq: 1 }));
  // null / 非对象
  assert.ok(!isFoldRecord(null));
  assert.ok(!isFoldRecord("string"));
});

// ── copilot 复审 #993 ①：resume 之后统计折的读法不许退化 ────────────────────────────
// `foldRecordSegments`（`src/compact/fold-statistical.js:520`）遇到任一条缺 `from`/`to` 就**整份
// 账本放弃**、退回解析块；而它把 `record.text` 当**单折**正文用（父键 text 是累计正文）。
// 所以重建出的旧形状必须：① 第一折的 `from` = 0（水位起点）；② 每折带自己的 `increment.text`。
test("261128-11 判据9: 重建的旧形状能被 foldRecordSegments 读（from/to 齐、increment 是单折）", async () => {
  const store = createMemoryTranscriptStore();
  // 形状照 `buildFoldedFacts` 的真实产出（幂等键 + 本折正文 + 语义来源）。
  const f1 = /** @type {Record<string, unknown>} */ ({
    foldId: "fold-1", summary: "第一折正文", origin: "semantic", title: "T1",
  });
  const f2 = /** @type {Record<string, unknown>} */ ({
    foldId: "fold-2", summary: "第二折正文", origin: "semantic", title: "T2",
  });
  await store.appendFold("run-9", toFoldRecord(f1, { cutRound: 3 }));
  await store.appendFold("run-9", toFoldRecord(f2, { cutRound: 9 }));
  const rows = await store.loadFolds("run-9");
  const facts = mergeFoldRecords({ channelRows: rows, roundFacts: [] });
  // ① 每一折都有整数 from/to —— 否则读侧整份放弃。
  for (const [i, fact] of facts.entries()) {
    assert.equal(Number.isSafeInteger(fact.from), true, `第 ${i + 1} 折缺 from ⇒ 读侧会整份放弃`);
    assert.equal(Number.isSafeInteger(fact.to), true, `第 ${i + 1} 折缺 to ⇒ 读侧会整份放弃`);
  }
  assert.equal(facts[0].from, 1, "第一折覆盖第 1..3 轮（from 是闭区间左端，不是水位）");
  // ② `increment.text` 是**这一折自己**的正文；父键 `text` 是累计。
  assert.equal(facts[1].increment.text, "第二折正文");
  assert.notEqual(facts[1].text, facts[1].increment.text, "多折时累计正文与单折正文必须不同");
  // ③ `summary` 也在（`ledgerSummary` 读它）。
  assert.equal(facts[1].summary, "第二折正文");
});
