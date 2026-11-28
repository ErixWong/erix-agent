// issue 261128-09（切片 1）：`src/store/fold-record.js` 的形状互转判据（离线、零真实 LLM）。
//
// 判据的**数据来源**是 `buildFoldedFacts()` 真跑出来的对象，不是手搓的字面量——手搓一份「我以为的
// 形状」只会钉住我自己的想象（`titleFallback` 什么时候出现、`truncated` 和 `bytesBefore` 是不是同现、
// `toolCalls` 从哪来，都由实现说了算）。这里用 `src/store/folds.js#FOLD_RECORD_COLUMNS` 当**键名全集**
// 的参照，把「真实对象到底覆盖了多少键」也钉住：真实输入覆盖得越少，判据 2 的「恰好」就越弱。
import test from "node:test";
import assert from "node:assert/strict";

import { buildFoldedFacts } from "../../src/compact/fold-summary-journal.js";
import { FOLD_RECORD_COLUMNS } from "../../src/store/folds.js";
import { fromFoldRecords, toFoldRecord } from "../../src/store/fold-record.js";

/** `fold-statistical.js` 的清单节标题（`toolCalls` 的唯一触发条件：正文里有这一节 + `- ` 条目行）。 */
const INVENTORY_HEADING = "工具调用清单（机械摘要，不代表执行成功）：";

/** 超长正文：触发 `truncated` / `bytesBefore`（默认预算 `FOLDED_FACTS_MAX_BYTES = 4096`）。 */
const LONG_TEXT = [
  "阶段：切片一（九列适配）",
  INVENTORY_HEADING,
  "- readFile path=src/store/folds.js",
  "- exec node --test",
  "补脚".repeat(3000),
].join("\n");

/**
 * `buildFoldedFacts` 的**最大**真实输入：每个可选键的触发条件都满足。
 * 注意 `summary` 与 `summaryDropped` **结构性互斥**（`summaryDropped` 的定义就是
 * 「给了 summary 但共用预算装不下」⇒ `summary === ""`），所以单次调用拿不到全部 21 个键名；
 * 21 是**键名并集**（也是 `FOLD_RECORD_COLUMNS` 的大小），下面用三个真实变体把它验出来。
 *
 * @param {Record<string, unknown>} [override]
 */
function realFacts(override = {}) {
  return buildFoldedFacts({
    text: LONG_TEXT,
    title: "模型给的短标题",
    origin: "semantic",
    summary: "## 行动\n改了 fold-record.js\n## 遗留\n接线\n## 关键词\n九列",
    incrementText: "本折自己那一份增量正文",
    roundRange: { from: 2, to: 5 },
    rounds: 4,
    fingerprint: "fp-261128",
    foldId: "fold-261128",
    seq: 3,
    degradeReason: "budget_fallback_mechanical",
    source: "llm",
    strategy: "fold-llm",
    descriptionTruncated: true,
    ...override,
  });
}

test("261128-09 判据1: 输入是 buildFoldedFacts 真跑出的对象（单次 19 键，三个真实变体的并集 = FOLD_RECORD_COLUMNS 的 21 个键名）", () => {
  const semantic = /** @type {Record<string, unknown>} */ (realFacts());
  // summary 太大 ⇒ summaryCandidate 非空但装不下 ⇒ `summaryDropped` 出现、`summary` 缺席。
  const dropped = /** @type {Record<string, unknown>} */ (
    realFacts({ summary: "挤".repeat(4000) })
  );
  // 语义折但不给模型 title ⇒ 退回正文首行，`titleFallback: true` 出现。
  const fallback = /** @type {Record<string, unknown>} */ (realFacts({ title: undefined }));

  assert.ok(semantic && dropped && fallback, "三个变体都必须真的产出对象");
  assert.equal(semantic.titleFallback, undefined, "给了模型 title ⇒ 不该有 titleFallback");
  assert.equal(dropped.summaryDropped, true);
  assert.equal("summary" in dropped, false, "summaryDropped 与 summary 结构性互斥");
  assert.equal(fallback.titleFallback, true, "语义折没拿到模型 title ⇒ 首行兜底要可检测");

  assert.equal(Object.keys(semantic).length, 19, "单次调用的最大键数（互斥掉一个）");
  const union = new Set([...Object.keys(semantic), ...Object.keys(dropped), ...Object.keys(fallback)]);
  assert.equal(FOLD_RECORD_COLUMNS.size, 21, "buildFoldedFacts 可能产出的键名全集");
  assert.deepEqual(
    [...union].sort(),
    [...FOLD_RECORD_COLUMNS].sort(),
    "三个真实变体必须逐字覆盖全集——覆盖不到的话判据 2 的「恰好」是虚的",
  );
});

test("261128-09 判据2: toFoldRecord 的结果键集合恰好是九列里拿得到的那些（多一个少一个都红）", () => {
  const record = toFoldRecord(/** @type {Record<string, unknown>} */ (realFacts()), {
    runId: "run-1",
    cutRound: 5,
    cutMsgSeq: 9,
    tokensBefore: 12000,
    tokensAfter: 4100,
    createdAt: "2026-11-28T00:00:00.000Z",
  });
  assert.deepEqual(
    Object.keys(record).sort(),
    ["createdAt", "cutMsgSeq", "cutRound", "description", "foldId", "runId", "seq", "title", "tokensAfter", "tokensBefore"],
  );
  assert.equal(record.foldId, "fold-261128");
  assert.equal(record.seq, 3);
  assert.equal(record.cutRound, 5);
  assert.equal(record.cutMsgSeq, 9);
  assert.equal(record.title, "模型给的短标题");
  // description 取 `summary`（摘要器写的三节），不是累计正文 `text`。
  assert.equal(record.description, "## 行动\n改了 fold-record.js\n## 遗留\n接线\n## 关键词\n九列");
  assert.equal(record.tokensBefore, 12000);
  assert.equal(record.tokensAfter, 4100);
  assert.equal(record.createdAt, "2026-11-28T00:00:00.000Z");
});

test("261128-09 判据2b: fingerprint 单独在场也能当 fold_id（ADR：fingerprint 并入 fold_id，同一身份）", () => {
  const facts = /** @type {Record<string, unknown>} */ (realFacts({ foldId: undefined }));
  assert.equal("foldId" in facts, false);
  assert.equal(toFoldRecord(facts).foldId, "fp-261128");
});

test("261128-09 判据3: titleFallback === true ⇒ 结果里没有 title 键（不是 title: \"\"）", () => {
  const facts = /** @type {Record<string, unknown>} */ (realFacts({ title: undefined }));
  assert.equal(facts.titleFallback, true, "前提：真实对象确实带了首行兜底标记");
  const record = toFoldRecord(facts, { cutRound: 5, cutMsgSeq: 9 });
  assert.equal("title" in record, false, "派生标题不许冒充模型标题存进 title 列（NULL 才是「模型没给」）");
  assert.notEqual(record.title, "");
});

test("261128-09 判据3b: 非语义折（mechanical / host）的 title 也不进结果", () => {
  for (const origin of ["mechanical", "host"]) {
    const facts = /** @type {Record<string, unknown>} */ (realFacts({ origin }));
    assert.equal(facts.origin, origin, "前提：真实对象带上了该 origin");
    assert.equal("title" in toFoldRecord(facts), false, `${origin} 折的 title 是首行派生物`);
  }
});

test("261128-09 判据4: 既无 foldId 又无 fingerprint ⇒ TypeError（幂等键不许缺）", () => {
  const facts = /** @type {Record<string, unknown>} */ (realFacts({ foldId: undefined, fingerprint: undefined }));
  assert.equal("foldId" in facts, false);
  assert.equal("fingerprint" in facts, false);
  assert.throws(() => toFoldRecord(facts), TypeError);
  // 空串同样不算身份（`buildFoldedFacts` 自己就不写空串键）。
  assert.throws(() => toFoldRecord({ text: "正文", foldId: "", fingerprint: "  " }), TypeError);
});

test("261128-09 判据5: 既无 summary 又无 text ⇒ TypeError（description 是 not null 列）", () => {
  assert.throws(() => toFoldRecord({ foldId: "fold-1", source: "llm" }), TypeError);
  assert.throws(() => toFoldRecord({ foldId: "fold-1", summary: "", text: "   " }), TypeError);
  // copilot 复审 #991 ①：**累计 text 不许当 description**——那会把整份累计正文按折存 N 份。
  // 构造一份「只有累计 text、没有任何本折正文」的对象（`increment` 也不给，否则它才是合法来源）。
  const onlyText = /** @type {Record<string, unknown>} */ ({
    .../** @type {Record<string, unknown>} */ (buildFoldedFacts({ text: "累计正文", origin: "semantic" })),
    // 补一个幂等键：本判据要钉的是 description，不是 fold_id（后者是判据 4 的事）。
    foldId: "fold-only-text",
  });
  assert.equal("summary" in onlyText, false);
  assert.equal("increment" in onlyText, false, "前提：这份对象确实没有本折正文");
  assert.equal(typeof onlyText.text, "string", "前提：它确实带累计 text");
  assert.throws(() => toFoldRecord(onlyText), TypeError,
    "只有累计 text、没有本折正文 ⇒ 必须抛，不许把累计正文当本折日志");
  // 本折正文的第二条合法来源是 `increment.text`（机械折的增量），不是累计 text。
  const withIncrement = /** @type {Record<string, unknown>} */ ({ ...onlyText, increment: { text: "本折增量正文" } });
  assert.equal(toFoldRecord(withIncrement).description, "本折增量正文");
});

test("261128-09 判据6: 往返 —— fromFoldRecords([toFoldRecord(f, …)], {previousCutRound:2}) 得 from: 2, to: 5", () => {
  const facts = /** @type {Record<string, unknown>} */ (realFacts());
  const back = fromFoldRecords(
    [toFoldRecord(facts, { cutRound: 5, cutMsgSeq: 9 })],
    { previousCutRound: 2, source: "llm", strategy: "fold-llm" },
  );
  assert.equal(back.from, 2);
  assert.equal(back.to, 5);
  assert.equal(back.rounds, 3);
  assert.equal(back.foldId, "fold-261128");
  assert.equal(back.seq, 3);
  // copilot 复审 #991 ③：来源/策略**由调用方给**，不许写死（显式 `fold-statistical` 也走这条路）。
  assert.equal(back.source, "llm");
  assert.equal(back.strategy, "fold-llm");
  assert.equal(back.text, "## 行动\n改了 fold-record.js\n## 遗留\n接线\n## 关键词\n九列");
});

test("261128-09 判据6b: fromFoldRecords 的键集合恰好 = 契约面里能从九列导出的那些（truncated / degradeReason 缺席）", () => {
  const facts = /** @type {Record<string, unknown>} */ (realFacts());
  const back = fromFoldRecords(
    [toFoldRecord(facts, { cutRound: 5, cutMsgSeq: 9 })],
    { previousCutRound: 2, source: "llm", strategy: "fold-llm" },
  );
  assert.deepEqual(
    Object.keys(back).sort(),
    ["bytes", "foldId", "from", "rounds", "seq", "source", "strategy", "text", "to"],
  );
  assert.equal(back.bytes, Buffer.byteLength(/** @type {string} */ (back.text), "utf8"));
  // ① 来源/策略不给 ⇒ 缺席，不猜（写死就是给统计折贴 LLM 标签）。
  const noSource = fromFoldRecords([toFoldRecord(facts)], {});
  assert.equal("source" in noSource, false);
  assert.equal("strategy" in noSource, false);
  // ② 累计正文是**拼接**，不是取最后一折：两折 ⇒ 两段按序连起来。
  const two = fromFoldRecords([
    toFoldRecord(facts, { cutRound: 3 }),
    toFoldRecord(/** @type {Record<string, unknown>} */ (realFacts({ summary: "第二折正文" })), { cutRound: 5 }),
  ], { previousCutRound: 2 });
  assert.equal(two.text, `${facts.summary}\n\n第二折正文`, "累计 text 必须按 seq 拼接各折 description");
  assert.equal(two.to, 5);
  assert.equal(two.from, 2);
  // 上一折切点拿不到 ⇒ from / rounds 缺席，不猜 0。
  const noPrev = fromFoldRecords([toFoldRecord(facts)], {});
  assert.equal("from" in noPrev, false);
  assert.equal("rounds" in noPrev, false);
  assert.equal("to" in noPrev, false, "本折切点也只能由调用方给");
});

test("261128-09 判据7: 15 个退役键一个都不在 toFoldRecord 的结果里（表驱动）", () => {
  const retired = [
    "bytes", "truncated", "bytesBefore", "degradeReason", "origin", "source", "strategy",
    "toolCalls", "increment", "from", "to", "rounds", "titleFallback", "summaryDropped",
    "descriptionTruncated",
  ];
  assert.equal(retired.length, 15);
  // 需要**三份**真实对象：`titleFallback` 要「没给模型 title」，`summaryDropped` 要「给了 summary
  // 但装不下」——两者与「给了模型 title 且 summary 装得下」结构性互斥，单份凑不齐 15 个。
  const variants = {
    "语义折且模型给了标题": /** @type {Record<string, unknown>} */ (realFacts()),
    "语义折但退回首行标题": /** @type {Record<string, unknown>} */ (realFacts({ title: undefined })),
    "语义折但 description 装不下": /** @type {Record<string, unknown>} */ (
      realFacts({ summary: "挤".repeat(4000) })
    ),
  };
  for (const [name, facts] of Object.entries(variants)) {
    // 前提：15 个退役键在**变体并集**里确实在场——否则「结果里没有」只是因为输入里没有，判据是空的。
    const record = toFoldRecord(facts, { cutRound: 5, cutMsgSeq: 9, tokensBefore: 1, tokensAfter: 2 });
    for (const key of retired) {
      assert.equal(key in record, false, `${name}：${key} 已退役为列，不许漏进九列结果`);
    }
  }
  const covered = new Set();
  for (const facts of Object.values(variants)) {
    for (const key of retired) if (key in facts) covered.add(key);
  }
  assert.deepEqual(
    [...covered].sort(),
    [...retired].sort(),
    "三个真实变体的并集必须覆盖全部 15 个退役键（含 truncated / bytesBefore / toolCalls…）",
  );
});

test("261128-09 判据8: 拿不到的列一律缺席 —— 不用 0 / -1 / \"\" 顶替，也不拿 bytes 冒充 token", () => {
  const minimal = /** @type {Record<string, unknown>} */ (
    buildFoldedFacts({ text: "只有一行正文", summary: "本折正文", origin: "semantic" })
  );
  assert.ok(minimal);
  assert.equal(minimal.titleFallback, true);
  assert.equal("bytes" in minimal, true, "前提：输入里确实有 bytes 这把序列化尺子");
  // 真实最小对象不带 foldId / fingerprint（引擎的 foldId 由调用方给），这里补一个 fingerprint 才过幂等键闸门。
  const withFp = /** @type {Record<string, unknown>} */ ({ ...minimal, fingerprint: "fp-min" });
  const rec = /** @type {Record<string, unknown>} */ (toFoldRecord(withFp));
  assert.deepEqual(Object.keys(rec).sort(), ["description", "foldId"]);
  assert.equal(rec.foldId, "fp-min");
  for (const key of ["cutRound", "cutMsgSeq", "tokensBefore", "tokensAfter", "seq", "runId", "createdAt", "title"]) {
    assert.equal(key in rec, false, `${key} 必须缺席，不能是 0 / -1 / ""`);
  }
  assert.equal(rec.tokensBefore, undefined, "不许拿 bytes 冒充 tokens_before");
});
