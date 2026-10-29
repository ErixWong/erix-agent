// issue #601：折叠摘要**按折分段** —— 近期给全（title + 工具足迹 + 清单 + 摘要）/ 远期只给 title，
// 并把「stub 保留最旧 10 条」的反向 bug 一并修掉（#564 已经把**清单**做成最新在前，stub 漏了）。
//
// 为什么必须分段：账本里每次折叠各一条记录（#565 / #566），但进上下文的那块摘要把逐折边界抹平了
// （`Math.min`/`Math.max` + `reduce(count)`）⇒ 折了 7 次，模型只看到一句「早期第 1–132 轮已折叠」。
//
// 七格判据（issue 正文「判据（绿）」逐条；第 7 格是变异反向证，在报告里逐条跑）：
//   1. 逐折可见：折叠 3 次 ⇒ 块里 3 条折叠记录，区间不重叠、不合并；
//   2. 双层生效：折叠 7 次 ⇒ 最近 3 次带「工具足迹 + 清单 + 摘要」，更早的只有一行 title；
//   3. 最新 stub 必须还在（构造「旧折 10 条 + 新折 1 条独特」）；
//   4. 往返自洽：3 次折叠后解析结果与渲染一致；旧格式（单区间行）继续可读；
//   5. `text` 语义不变：第 1 次折叠的独特字面量在第 3 次折叠后仍在 `text` 里；
//   6. 预算：20 次折叠 ⇒ 块 ≤ `FOLDED_FACTS_MAX_BYTES`，且最新那次仍在（夹断只削尾部）。
//
// 纪律：全部走**真机形态**（不传 `stubFor`，TTL 句柄从被折负载里自己收），与 #564 同口径。

import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLD_SUMMARY_RECENT_FOLDS,
  createFoldStatisticalStrategy,
  summarizeFoldedPayload,
} from "../../src/compact/fold-statistical.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";

// 分段行：与引擎渲染的形状逐字对应（`- 第 120–132 轮（13 轮） · title` / `- 第 1–11 轮 · title`）。
const SEGMENT_LINE = /^- 第 (\d+)–(\d+) 轮(?:（(\d+) 轮）)? · (.*)$/u;

const ttlStub = (label) => `【已折叠·TTL】exec ${label}（约 4200 tokens，r1 读取）`
  + "— 后续需要时先用 note_list 查找，再用 note_read 读取；未记录且无法确定性重算时请省略，不要猜测"
  + "；要点见对话中已有笔记/结论";

const toolUse = (id, name, input) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

const summaryTextOf = (result) => result.messages[0].content[0].text;

const segmentLinesOf = (text) => text
  .split("\n")
  .filter((line) => SEGMENT_LINE.test(line));

const segmentsOf = (text) => segmentLinesOf(text).map((line) => {
  const match = line.match(SEGMENT_LINE);
  const from = Number.parseInt(match[1], 10);
  const to = Number.parseInt(match[2], 10);
  return {
    from,
    to,
    count: match[3] === undefined ? to - from + 1 : Number.parseInt(match[3], 10),
    title: match[4],
  };
});

/**
 * 连续折叠 `count` 次，每次折走**一轮**（轮号 = 第几次折叠）。
 *
 * 为什么每次先凑两轮：`keepRounds: 1` 时 `selectFoldedRounds` 至少要留下 1 轮才折得动，
 * 所以「折第 k 轮」的现场是「第 k 轮 + 第 k+1 轮」。`roundNumbers` 显式给号（块在 head 里，
 * 轮索引每次从 0 重数 ⇒ 不给号的话每次折叠都会自称「第 1 轮」，那就不是真机形状了）。
 */
async function foldSeries(count, round = (index) => [
  toolUse(`use-${index}`, "exec", { command: `npm test -- --grep case-${index}` }),
  toolResult(`use-${index}`, ttlStub(`fold-${index}`)),
]) {
  const strategy = createFoldStatisticalStrategy();
  let messages = [{ role: "user", content: "task" }, ...round(1), ...round(2)];
  let last;
  for (let index = 1; index <= count; index += 1) {
    if (index > 1) messages = [...messages, ...round(index + 1)];
    last = await strategy.compact(messages, {
      keepRounds: 1,
      roundNumbers: [index, index + 1],
    });
    messages = last.messages;
  }
  return last;
}

/**
 * 造一条**与引擎落账同形**的折叠记录（`foldedFacts`）：`orchestrator.js` 就是用
 * `buildFoldedFacts({ text: strategyFoldSummary.text, incrementText: 同一份, roundRange, rounds })`
 * 造它、再 `roundRecord[FOLDED_FACTS_RECORD_FIELD] = cloneState(...)` 落盘的。
 */
const foldRecordOf = (result) => buildFoldedFacts({
  text: result.foldSummary.text,
  incrementText: result.foldSummary.text,
  source: result.foldSummary.source,
  roundRange: result.foldedRoundRange,
  rounds: result.foldedRounds,
});

test("#601-7 账本驱动：渲染从折叠记录列表生成（块解析只作兜底）", async () => {
  // ① 连折 2 次（块里 2 条记录），顺手按引擎口径造出这 2 条账本记录。
  const strategy = createFoldStatisticalStrategy();
  const round = (index, command) => [
    toolUse(`use-${index}`, "exec", { command }),
    toolResult(`use-${index}`, ttlStub(`fold-${index}`)),
  ];
  const first = await strategy.compact([
    { role: "user", content: "task" },
    ...round(1, "echo case-1"),
    ...round(2, "echo case-2"),
  ], { keepRounds: 1, roundNumbers: [1, 2] });
  const second = await strategy.compact([
    ...first.messages,
    ...round(3, "echo case-3"),
  ], { keepRounds: 1, roundNumbers: [2, 3] });
  const ledger = [foldRecordOf(first), foldRecordOf(second)];
  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map((record) => [record.from, record.to, record.rounds]),
    [[1, 1, 1], [2, 2, 1]],
    "账本一折一条，`from/to/rounds` 是结构化键",
  );

  // ② 账本里的第 2 折换成另一份明细 ⇒ 块里必须出现**账本**那份（证明渲染读的是列表，不是块）。
  const forgedSecond = buildFoldedFacts({
    text: summarizeFoldedPayload([
      toolUse("use-ledger", "exec", { command: "echo LEDGER-WINS" }),
    ], { from: 2, to: 2, count: 1 }),
    source: "statistical",
      roundRange: { from: 2, to: 2 },
    rounds: 1,
  });
  const third = await strategy.compact([
    ...second.messages,
    ...round(4, "echo case-4"),
  ], {
    keepRounds: 1,
    roundNumbers: [3, 4],
    foldRecords: [ledger[0], forgedSecond],
  });
  const fromLedger = summaryTextOf(third);
  assert.equal(segmentsOf(fromLedger).length, 3, `账本 2 条 + 本次 1 条：\n${fromLedger}`);
  assert.ok(fromLedger.includes("LEDGER-WINS"),
    `块里第 2 折的明细必须来自账本：\n${fromLedger}`);
  assert.ok(!fromLedger.includes("echo case-2"),
    `块里那份旧的明细必须被账本顶掉：\n${fromLedger}`);

  // ③ 账本覆盖不到块（只给 1 条、块里已有 2 条）⇒ 退回解析块，一条折都不许丢。
  const fallback = await strategy.compact([
    ...second.messages,
    ...round(5, "echo case-5"),
  ], {
    keepRounds: 1,
    roundNumbers: [3, 4],
    foldRecords: [ledger[0]],
  });
  const fromBlock = summaryTextOf(fallback);
  assert.equal(segmentsOf(fromBlock).length, 3, `兜底路径同样 3 条：\n${fromBlock}`);
  assert.ok(fromBlock.includes("echo case-2"),
    `账本不全时退回解析块（不静默丢折）：\n${fromBlock}`);
  assert.ok(!fromBlock.includes("LEDGER-WINS"), fromBlock);
});

test("#601-1 逐折可见：折叠 3 次 ⇒ 块里 3 条折叠记录，区间不重叠、不合并", async () => {
  const text = summaryTextOf(await foldSeries(3));
  const segments = segmentsOf(text);

  assert.equal(segments.length, 3, `折叠 3 次必须有 3 条记录：\n${text}`);
  // 最新在最前，每折自己的区间原样保留（不再被 min/max 抹平）。
  assert.deepEqual(
    segments.map((segment) => [segment.from, segment.to]),
    [[3, 3], [2, 2], [1, 1]],
    `逐折区间必须保留且最新在最前：\n${text}`,
  );
  // 区间两两不重叠。
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 1; right < segments.length; right += 1) {
      assert.ok(
        segments[left].from > segments[right].to || segments[left].to < segments[right].from,
        `区间不得重叠：${JSON.stringify(segments[left])} vs ${JSON.stringify(segments[right])}`,
      );
    }
  }
  // 头行只交代「折了几次、覆盖到哪」——它不是替代品，逐折记录才是。
  assert.match(text, /共折叠 3 次，覆盖第 1–3 轮（共 3 轮）/u);
  assert.doesNotMatch(text, /早期第 1–3 轮（共 3 轮）已折叠/u,
    `min/max 抹平句必须消失：\n${text}`);
});

test("#601-2 双层生效：折叠 7 次 ⇒ 最近 3 次给全，更早的每条只一行 title", async () => {
  const text = summaryTextOf(await foldSeries(7));
  const lines = text.split("\n");
  const indexes = [];
  lines.forEach((line, index) => {
    if (SEGMENT_LINE.test(line)) indexes.push(index);
  });

  assert.equal(FOLD_SUMMARY_RECENT_FOLDS, 3, "近期条数是导出常量 3（不新增 config 叶）");
  assert.equal(indexes.length, 7, `折叠 7 次必须有 7 条记录：\n${text}`);
  assert.match(text, /^近期（最近 3 次，完整）：$/mu);
  assert.match(text, /^更早（仅标题，每条一行）：$/mu);

  const recent = indexes.slice(0, FOLD_SUMMARY_RECENT_FOLDS);
  const older = indexes.slice(FOLD_SUMMARY_RECENT_FOLDS);
  assert.deepEqual(
    recent.map((index) => lines[index].match(SEGMENT_LINE)[1]),
    ["7", "6", "5"],
    "近期那 3 条是最新的 3 次",
  );
  for (const index of recent) {
    const next = indexes.find((candidate) => candidate > index) ?? lines.length;
    const body = lines.slice(index + 1, next);
    assert.ok(body.some((line) => line.startsWith("工具足迹：")),
      `近期那折必须带工具足迹（第 ${index} 行）：\n${body.join("\n")}`);
    assert.ok(body.some((line) => line.startsWith("工具调用清单")),
      `近期那折必须带清单（第 ${index} 行）：\n${body.join("\n")}`);
    assert.ok(body.includes("摘要："),
      `近期那折必须带摘要（第 ${index} 行）：\n${body.join("\n")}`);
  }
  for (const index of older) {
    const next = lines[index + 1];
    assert.ok(
      next === undefined || SEGMENT_LINE.test(next) || next.startsWith("另有"),
      `远期那条后面不得有细节，实测下一行 ${JSON.stringify(next)}`,
    );
    // 预算：远期 title 行 ≤80 字符。
    assert.ok(Array.from(lines[index]).length <= 80,
      `远期 title 行 ≤80 字符，实测 ${Array.from(lines[index]).length}：${lines[index]}`);
  }
  assert.match(text, /^另有 4 次更早的已合并（只留标题）。$/mu,
    `更早那批要有收尾句：\n${text}`);
});

test("#601-3 最新 stub 必须还在：旧折 10 条 + 新折 1 条独特 ⇒ 新那条在块里", async () => {
  const strategy = createFoldStatisticalStrategy();
  const oldStubs = Array.from({ length: 10 }, (_, index) => ttlStub(`old-cmd-${index + 1}`));
  const first = await strategy.compact([
    { role: "user", content: "task" },
    toolUse("use-1", "exec", { command: "echo old" }),
    toolResult("use-1", oldStubs.join("\n")),
    toolUse("use-2", "exec", { command: "echo new" }),
    toolResult("use-2", ttlStub("UNIQUE-NEW-601-STUB")),
  ], { keepRounds: 1, roundNumbers: [1, 2] });
  // 第 1 折只折走第 1 轮（10 条旧 stub）；第 2 折折走第 2 轮（1 条新 stub）。
  const second = await strategy.compact([
    ...first.messages,
    toolUse("use-3", "exec", { command: "echo keep" }),
    toolResult("use-3", "kept"),
  ], { keepRounds: 1, roundNumbers: [2, 3] });
  const text = summaryTextOf(second);

  assert.equal(segmentLinesOf(text).length, 2, `两折 = 两条记录：\n${text}`);
  assert.ok(text.includes("UNIQUE-NEW-601-STUB"),
    `最新那次折叠的 stub 必须在块里（旧实现 slice(0,10) 留最旧、丢最新）：\n${text}`);
  // 全局上限仍是 10 条（既有口径不变），只是「谁被丢」从最新改成了最旧。
  const stubLines = text.split("\n").filter((line) => /^(?:\[已折叠\]|【已折叠·TTL】)/u.test(line));
  assert.ok(stubLines.length <= 10, `stub 总条数 ≤10，实测 ${stubLines.length}`);
});

test("#601-4 往返自洽：3 次折叠的解析结果与渲染一致；旧格式单区间行仍可读", async () => {
  // ① 新格式自解析：第 4 折读回前 3 条（不是合并成 1 条，也不是重头再来）。
  const fourth = summaryTextOf(await foldSeries(4));
  const segments = segmentsOf(fourth);
  assert.deepEqual(
    segments.map((segment) => ({ from: segment.from, to: segment.to, count: segment.count })),
    [
      { from: 4, to: 4, count: 1 },
      { from: 3, to: 3, count: 1 },
      { from: 2, to: 2, count: 1 },
      { from: 1, to: 1, count: 1 },
    ],
    `第 4 折必须把前 3 条原样读回来：\n${fourth}`,
  );
  assert.match(fourth, /共折叠 4 次，覆盖第 1–4 轮（共 4 轮）/u,
    "头行的次数与覆盖范围必须与逐折记录自洽");

  // ② 旧格式（单区间行，无分段）继续可读：它是「一条折叠记录」，不是噪声。
  const legacyBlock = "【上下文折叠·v1·erix-9f6e2c】早期第 1–4 轮（共 4 轮）已折叠。工具足迹：exec×2。\n"
    + "工具调用清单（机械摘要，不代表执行成功）：\n"
    + "- exec echo legacy\n"
    + "需要原文请重读文件或查看持久笔记；关键值应当已落盘";
  const merged = summaryTextOf(await createFoldStatisticalStrategy().compact([
    { role: "user", content: [{ type: "text", text: legacyBlock }, { type: "text", text: "task" }] },
    toolUse("use-5", "exec", { command: "echo five" }),
    toolResult("use-5", "out-5"),
    toolUse("use-6", "exec", { command: "echo six" }),
    toolResult("use-6", "out-6"),
  ], { keepRounds: 1, roundNumbers: [5, 6] }));

  assert.match(merged, /共折叠 2 次，覆盖第 1–5 轮（共 5 轮）/u, merged);
  assert.match(merged, /^- 第 1–4 轮（4 轮） · exec echo legacy$/mu,
    `旧格式（单区间行）必须解析成一条记录：\n${merged}`);
  assert.match(merged, /^- 第 5–5 轮（1 轮） · /mu, merged);
});

test("#601-5 text 语义不变：第 1 折的独特字面量在第 3 折后仍在 text 里", async () => {
  const text = summaryTextOf(await foldSeries(3, (index) => [
    toolUse(`use-${index}`, "exec", { command: `echo fold-${index}` }),
    toolResult(`use-${index}`, ttlStub(index === 1 ? "ALPHA-601-FIRST" : `fold-${index}`)),
  ]));

  assert.ok(text.includes("ALPHA-601-FIRST"),
    `第 1 折的独特字面量必须还在（累计替代物，不是「只留最近几折」）：\n${text}`);
  // 累计性：头行仍报全量覆盖，3 条记录都在（远期那几条只是降级成 title，没有被删掉）。
  assert.match(text, /共折叠 3 次，覆盖第 1–3 轮（共 3 轮）/u, text);
  assert.equal(segmentsOf(text).length, 3, text);
});

test("#601-6 预算：20 次折叠 ⇒ 块 ≤2048 字节，且最新那次仍在（夹断只削尾部）", async () => {
  const text = summaryTextOf(await foldSeries(20, (index) => [
    toolUse(`use-${index}`, "exec", {
      command: `npm test -- --grep case-${index} ${"x".repeat(40)}`,
    }),
    toolResult(`use-${index}`, ttlStub(`fold-${index}`)),
  ]));
  const facts = buildFoldedFacts({
    text,
    roundRange: { from: 1, to: 20 },
    rounds: 20,
  });

  assert.equal(facts.truncated, true, `前置：这一份必须真的被夹断（实测 ${new TextEncoder().encode(text).length} 字节）`);
  assert.ok(new TextEncoder().encode(facts.text).length <= FOLDED_FACTS_MAX_BYTES,
    `夹断后 ≤ ${FOLDED_FACTS_MAX_BYTES}`);
  assert.match(facts.text, /共折叠 20 次，覆盖第 1–20 轮（共 20 轮）/u, "头行在夹断后仍在");
  assert.match(facts.text, /^- 第 20–20 轮（1 轮） · /mu,
    `最新那次必须在（顺序：最新在最前，夹断削尾部）：\n${facts.text}`);
  assert.match(facts.text, /^- 第 19–19 轮（1 轮） · /mu, facts.text);
});
