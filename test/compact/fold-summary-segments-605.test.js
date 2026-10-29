// issue #605：#604 分支真机复跑（51 轮 / 9 次折叠）抓到 1 个回归 + 2 个残留。
//
// 真机块原文（issue 正文）：
//
//   【上下文折叠·v1·erix-9f6e2c】共折叠 9 次，覆盖第 1–44 轮（共 44 轮）。
//   近期（最近 3 次，完整）：
//   - 第 40–44 轮 · 工具足迹：getParagraph×3
//   - 第 39–39 轮 · 工具足迹：getParagraph×15
//   - 第 29–32 轮 · 工具足迹：getParagraph×4
//   更早（仅标题，每条一行）：
//   - 第 22–28 轮 · 工具足迹：getParagraph×7
//   - 第 15–21 轮 · 工具足迹：getParagraph×7
//   - 第 9–14 轮 · 工具足迹：getParagraph×6
//   - 第 8–8 轮 · 工具足迹：无。需要原文请重读文件或查看持久笔记；关键值应当已落盘
//   - 第 6–6 轮 · 工具足迹：无。需要原文请重读文件或查看持久笔记；关键值应当已落盘
//   - 第 1–5 轮 · 工具足迹：getParagraph×5
//
// 三处缺陷：
//   A（回归，最严重）近期那 3 条**只剩一行 title** —— 清单与摘要都没了，#601 的「近期给全」被吃掉；
//   B（残留）`第 8–8 轮` / `第 6–6 轮` 的 title 把**块级恢复提示**当成了自己的标题；
//   C（残留）头行声称「覆盖第 1–44 轮」，而那 9 条记录的区间是
//     `1–5, 6–6, 8–8, 9–14, 15–21, 22–28, 29–32, 39–39, 40–44` ⇒ **第 7 轮与第 33–38 轮一轮未折**。
//
// **为什么 #603 的用例全绿而这三处看不见**：那批夹具的 `increment.text` 里**带着**清单节
// （`foldTextOf` 把清单拼进了正文），`title` 里没有恢复提示，`rounds` 也恰好…… 总之三处缺陷
// 都要求**不自洽的真实形状**：结构化 `toolCalls` 与 `increment.text` 不同步、正文以
// `工具足迹：无。` + `DEFAULT_RECOVERY_HINT` 结尾、记录区间有空洞。本文件的夹具一律用这种形状。
//
// 判据（issue 正文「判据（绿）」逐条）：
//   1. 近期给全（回归 A）；2. title 不含恢复提示（残留 B）；3. 覆盖措辞诚实（残留 C）。
// 判据 4（既有判据不回归）由 `node --test test/compact/` 全量覆盖；判据 5 是真机复跑（报告里贴块）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLD_SUMMARY_RECENT_FOLDS,
  createFoldStatisticalStrategy,
  formatFoldSummary,
} from "../../src/compact/fold-statistical.js";
import { buildFoldedFacts } from "../../src/compact/fold-summary-journal.js";
import { DEFAULT_RECOVERY_HINT } from "../../src/compact/helpers.js";

/** 分段行：与引擎渲染的形状逐字对应（近期/远期都只印区间）。 */
const SEGMENT_LINE = /^- 第 (\d+)–(\d+) 轮(?:（(\d+) 轮）)? · (.*)$/u;

const toolUse = (id, name, input) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

const summaryTextOf = (result) => result.messages[0].content[0].text;

const linesOf = (text) => text.split("\n");

const segmentIndexesOf = (text) => linesOf(text)
  .reduce((indexes, line, index) => (SEGMENT_LINE.test(line) ? [...indexes, index] : indexes), []);

const segmentTitleOf = (text, from) => {
  const line = linesOf(text).find((candidate) => {
    const match = candidate.match(SEGMENT_LINE);
    return match !== null && Number.parseInt(match[1], 10) === from;
  });
  return line === undefined ? undefined : line.match(SEGMENT_LINE)[4];
};

/** 一折的**本折明细块**（title 行之后、下一折 title 行之前）；远期那折为空。 */
function segmentBodyOf(text, from) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => {
    const match = line.match(SEGMENT_LINE);
    return match !== null && Number.parseInt(match[1], 10) === from;
  });
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && SEGMENT_LINE.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/**
 * 真机那 9 折的**真实区间形状**（issue 正文）：`1–5, 6–6, 8–8, 9–14, 15–21, 22–28, 29–32, 39–39, 40–44`。
 *
 * 空洞是现场事实，不是造出来的：**第 7 轮**（夹在 6–6 与 8–8 之间）与**第 33–38 轮**一轮未折。
 * `calls` 是该折的工具调用（`第 8–8 轮` / `第 6–6 轮` 现场是「无」）。
 */
const REAL_605_FOLDS = [
  { from: 1, to: 5, calls: [1, 2, 3, 4, 5] },
  { from: 6, to: 6, calls: [] },
  { from: 8, to: 8, calls: [] },
  { from: 9, to: 14, calls: [9, 10, 11, 12, 13, 14] },
  { from: 15, to: 21, calls: [15, 16, 17, 18, 19, 20, 21] },
  { from: 22, to: 28, calls: [22, 23, 24, 25, 26, 27, 28] },
  { from: 29, to: 32, calls: [29, 30, 31, 32] },
  { from: 39, to: 39, calls: Array.from({ length: 15 }, (_, index) => index + 1) },
  { from: 40, to: 44, calls: [40, 41, 42] },
];

const footprintOf = (calls) => (calls.length === 0 ? "无" : `getParagraph×${calls.length}`);

const inventorySectionOf = (calls) => (calls.length === 0 ? [] : [
  "工具调用清单（机械摘要，不代表执行成功）：",
  ...calls.map((index) => `- getParagraph {"index":"${index}"}`),
]);

/**
 * 账本父键 `text`（**带**清单节）：`buildFoldedFacts` 就是从这里把清单节投影成结构化 `toolCalls` 的。
 */
const foldTextOf = (fold) => [
  `【上下文折叠·v1·erix-9f6e2c】早期第 ${fold.from}–${fold.to} 轮`
    + `（共 ${fold.to - fold.from + 1} 轮）已折叠。工具足迹：${footprintOf(fold.calls)}。`,
  ...inventorySectionOf(fold.calls),
  DEFAULT_RECOVERY_HINT,
].join("\n");

/**
 * 账本增量 `increment.text`：**不带**清单节（真机现场的形状，也是回归 A 的现场）。
 *
 * 这刻意与父键 `text` **不自洽**：结构化 `toolCalls` 非空，而增量正文里没有那一节 ——
 * 修前渲染只认这一份正文（`parseInventorySection` 返回空）⇒ 近期折叠只剩一行 title。
 */
const incrementTextOf = (fold) => [
  `【上下文折叠·v1·erix-9f6e2c】早期第 ${fold.from}–${fold.to} 轮`
    + `（共 ${fold.to - fold.from + 1} 轮）已折叠。工具足迹：${footprintOf(fold.calls)}。`,
  DEFAULT_RECOVERY_HINT,
].join("\n");

/**
 * 造一条**与引擎落账同形**的折叠记录：父键 `text` 带清单（⇒ `toolCalls` 非空）、
 * 增量 `increment.text` 不带清单（⇒ 只解析文本就必然丢清单）。
 */
const foldRecordOf = (fold) => {
  const record = buildFoldedFacts({
    text: fold.text ?? foldTextOf(fold),
    incrementText: fold.incrementText ?? incrementTextOf(fold),
    source: "statistical",
    roundRange: { from: fold.from, to: fold.to },
    rounds: fold.to - fold.from + 1,
  });
  if (fold.title !== undefined) record.title = fold.title;
  return record;
};

/**
 * 用**账本驱动路径**渲染一块分段摘要：`ledger` 是前 N 折（账本），`newest` 由本次 `compact`
 * 真的折出来 —— 与真机现场同一条路（`orchestrator` 把 `foldedFacts` 列表线进 `foldRecords`）。
 */
async function renderBlock({ ledger, newest }) {
  const numbers = Array.from(
    { length: newest.to - newest.from + 1 },
    (_, index) => newest.from + index,
  );
  const result = await createFoldStatisticalStrategy().compact([
    { role: "user", content: "把下面 30 段中文逐段翻译成英文，每段用一次 getParagraph(index) 取原文。" },
    ...numbers.flatMap((number) => [
      toolUse(`use-${number}`, "getParagraph", { index: String(number) }),
      toolResult(`use-${number}`, `第 ${number} 段中文原文……`),
    ]),
  ], {
    keepRounds: 0,
    roundNumbers: numbers,
    foldRecords: ledger,
  });
  return summaryTextOf(result);
}

/** 真机形状：账本给前 8 折，第 9 折（40–44）现场折。 */
const renderRealShapedBlock = () => renderBlock({
  ledger: REAL_605_FOLDS.slice(0, -1).map(foldRecordOf),
  newest: REAL_605_FOLDS.at(-1),
});

test("#605-A 回归：toolCalls 非空而 increment.text 无清单节 ⇒ 近期每条仍有清单", async () => {
  const ledger = REAL_605_FOLDS.slice(0, -1).map(foldRecordOf);
  // 前置（这就是回归现场的形状）：结构化 `toolCalls` 在，增量正文里**没有**清单节。
  const withCalls = ledger.filter((record) => (record.toolCalls ?? []).length > 0);
  assert.ok(withCalls.length >= 3, "前置：账本里至少 3 折有结构化 toolCalls");
  for (const record of withCalls) {
    assert.ok(!String(record.increment?.text ?? "").includes("工具调用清单"),
      `前置：第 ${record.from}–${record.to} 折的增量正文里不得带清单节`);
  }

  const text = await renderRealShapedBlock();
  assert.equal(segmentIndexesOf(text).length, 9, `真机 9 折 = 9 条记录：\n${text}`);

  // 近期那 3 折（40–44 现场折 / 39–39 / 29–32 来自账本）**每一条**都必须带清单。
  for (const from of [40, 39, 29]) {
    const body = segmentBodyOf(text, from);
    assert.ok(body !== undefined, `第 ${from} 轮那折必须在块里：\n${text}`);
    assert.ok(body.some((line) => line.trimStart().startsWith("工具调用清单")),
      `近期折叠必须带清单（第 ${from} 轮那折，修前只剩一行 title）：\n${body.join("\n")}`);
    assert.ok(body.some((line) => /^ {2}- getParagraph \{/u.test(line)),
      `近期折叠必须带清单条目（第 ${from} 轮那折）：\n${body.join("\n")}`);
  }
  // 清单来源是**账本的结构化 toolCalls**（而不是文本解析）：条目必须与它逐条相等。
  const record39 = ledger.find((record) => record.from === 39);
  assert.ok(record39 !== undefined);
  for (const call of record39.toolCalls.slice(0, 3)) {
    const entry = call.argsSummary === "" ? call.name : `${call.name} ${call.argsSummary}`;
    assert.ok(segmentBodyOf(text, 39).some((line) => line.trim() === `- ${entry}`),
      `第 39–39 轮那折的清单必须逐条等于账本的 toolCalls（缺 ${entry}）：\n${text}`);
  }
  // 近期那 3 条也不能只剩 title：足迹仍在（title 已经说完足迹时明细行省略，两处都算）。
  for (const from of [40, 39, 29]) {
    const title = segmentTitleOf(text, from);
    const body = segmentBodyOf(text, from);
    assert.ok(title.includes("工具足迹：") || body.some((line) => line.trimStart().startsWith("工具足迹：")),
      `近期那折必须交代工具足迹（第 ${from} 轮）：${title}`);
  }
});

test("#605-B 残留：title 不得含恢复提示（块级句尾不是本折的标题）", async () => {
  // 现场形状：这一折没有工具调用 ⇒ 单折正文就是 `区间句 + 工具足迹：无。` **直接拼上**恢复提示
  // （`formatFoldSummary` 的单折路径里 hint 紧跟足迹句，中间没有换行）⇒ `foldedFacts.title`
  // 整段就是「足迹句 + 提示」。
  const bare = foldRecordOf({
    from: 8,
    to: 8,
    calls: [],
    text: `【上下文折叠·v1·erix-9f6e2c】早期第 8–8 轮（共 1 轮）已折叠。工具足迹：无。${DEFAULT_RECOVERY_HINT}`,
    incrementText: `【上下文折叠·v1·erix-9f6e2c】早期第 8–8 轮（共 1 轮）已折叠。工具足迹：无。${DEFAULT_RECOVERY_HINT}`,
  });
  assert.ok(String(bare.title).includes("需要原文请重读"),
    `前置：账本 title 里确实带着恢复提示（否则这一格测不到东西）：${bare.title}`);

  const text = await renderBlock({
    ledger: [foldRecordOf(REAL_605_FOLDS[0]), bare],
    newest: REAL_605_FOLDS.at(-1),
  });

  // ① 任何一条分段 title 都不得含恢复提示。
  for (const line of linesOf(text).filter((candidate) => SEGMENT_LINE.test(candidate))) {
    assert.ok(!line.includes("需要原文请重读"),
      `title 不得含恢复提示（修前现场：\`- 第 8–8 轮 · 工具足迹：无。需要原文请重读…\`）：${line}`);
  }
  // ② 那一折的 title 退到下一级（`无工具调用`），而不是 `工具足迹：无`。
  assert.equal(segmentTitleOf(text, 8), "无工具调用", `第 8–8 轮那折的 title：\n${text}`);
  // ③ 恢复提示仍然在**块级句尾**（它是块的一部分，只是不属于任何一折的 title）。
  assert.ok(linesOf(text).at(-1).includes("需要原文请重读"),
    `恢复提示必须仍在块尾：\n${text}`);
  assert.equal(linesOf(text).filter((line) => line.includes("需要原文请重读")).length, 1,
    `恢复提示只能出现一次（块尾）：\n${text}`);

  // ④ 往返：拿这块当上一块再折一次（**不给账本** ⇒ 走块解析兜底）⇒ 旧那几折的 title 仍不含提示。
  const again = await createFoldStatisticalStrategy().compact([
    { role: "user", content: [{ type: "text", text }, { type: "text", text: "任务原文" }] },
    toolUse("use-45", "getParagraph", { index: "45" }),
    toolResult("use-45", "第 45 段中文原文……"),
  ], { keepRounds: 0, roundNumbers: [45] });
  const roundTripped = summaryTextOf(again);
  for (const line of linesOf(roundTripped).filter((candidate) => SEGMENT_LINE.test(candidate))) {
    assert.ok(!line.includes("需要原文请重读"),
      `往返一次也不得把提示吃进 title：${line}`);
  }
  assert.equal(segmentTitleOf(roundTripped, 8), "无工具调用", `往返后第 8–8 轮：\n${roundTripped}`);

  // ⑤ 宿主自定义恢复提示同样剥（不是只认默认那一句）。
  const custom = "需要原文请重读文件或 note_read 读取；关键值应当已落盘";
  const customText = formatFoldSummary({
    from: 1,
    to: 1,
    count: 1,
    tools: new Map(),
    segments: [{
      from: 1,
      to: 1,
      count: 1,
      title: `工具足迹：无。${custom}`,
      ledgerTitle: undefined,
      summaryText: "",
      tools: new Map(),
      inventory: [],
      stubs: [],
    }, {
      from: 2,
      to: 2,
      count: 1,
      title: "第 2 段译文已定稿",
      ledgerTitle: undefined,
      summaryText: "",
      tools: new Map(),
      inventory: [],
      stubs: [],
    }],
    recoveryHint: custom,
  });
  assert.equal(segmentTitleOf(customText, 1), "无工具调用", `自定义提示也要剥：\n${customText}`);
});

test("#605-C 残留：头行不得谎称连续覆盖（9 条记录 / 空洞 7 与 33–38）", async () => {
  const text = await renderRealShapedBlock();
  const header = linesOf(text)[0];

  // 区间端点仍然如实报（1–44），轮数仍是**区间长度**（44，不是各折计数之和）。
  assert.match(header, /共折叠 9 次，覆盖第 1–44 轮（共 44 轮）。/u, header);
  // 但**不得**在这里收尾：那 9 条记录并没有填满 1–44。
  assert.doesNotMatch(header, /^【[^】]*】共折叠 9 次，覆盖第 1–44 轮（共 44 轮）。$/u,
    `头行不得只写 min…max（修前现场就是这一行，33–38 轮一轮未折却毫无保留）：${header}`);
  // 显式交代空洞：第 7 轮与第 33–38 轮（issue 正文只点了 33–38，形状里第 7 轮同样没折）。
  assert.match(header, /其中 7 轮未经折叠（第 7、33–38 轮）。$/u,
    `头行必须显式写出未经折叠的轮数与区间：${header}`);

  // 反向：连续记录（没有空洞）⇒ 不加尾巴（不为没有的事付字数）。
  const contiguous = formatFoldSummary({
    from: 1,
    to: 3,
    count: 3,
    tools: new Map(),
    segments: [3, 2, 1].map((index) => ({
      from: index,
      to: index,
      count: 1,
      title: `第 ${index} 段译文已定稿`,
      ledgerTitle: undefined,
      summaryText: "",
      tools: new Map(),
      inventory: [],
      stubs: [],
    })),
  });
  assert.match(linesOf(contiguous)[0], /共折叠 3 次，覆盖第 1–3 轮（共 3 轮）。$/u, contiguous);
  assert.doesNotMatch(contiguous, /未经折叠/u, `无空洞时不得出现空洞句：\n${contiguous}`);

  // 空洞句是**块级**信息：块被当成上一块解析回来时，它不得漏进任何一折的 title。
  const again = await createFoldStatisticalStrategy().compact([
    { role: "user", content: [{ type: "text", text }, { type: "text", text: "任务原文" }] },
    toolUse("use-45", "getParagraph", { index: "45" }),
    toolResult("use-45", "第 45 段中文原文……"),
  ], { keepRounds: 0, roundNumbers: [45] });
  for (const line of linesOf(summaryTextOf(again)).filter((candidate) => SEGMENT_LINE.test(candidate))) {
    assert.ok(!line.includes("未经折叠"), `空洞句不得进 title：${line}`);
  }
});

test("#605-A2 近期条数与降级不变：清单只给近期，远期仍只留一行 title", async () => {
  const text = await renderRealShapedBlock();
  const indexes = segmentIndexesOf(text);
  assert.equal(FOLD_SUMMARY_RECENT_FOLDS, 3, "近期条数是导出常量 3（不新增 config 叶）");

  // 远期那几折（22–28 等）后面不得出现本折明细（清单 / 足迹 / 摘要）——清单只给近期。
  for (const from of [22, 15, 9, 1]) {
    const body = segmentBodyOf(text, from);
    assert.ok(body !== undefined, `第 ${from} 轮那折必须在块里：\n${text}`);
    assert.ok(!body.some((line) => /^(?:工具足迹：|工具调用清单|摘要：)/u.test(line.trimStart())),
      `远期折叠只留一行 title（第 ${from} 轮那折）：\n${body.join("\n")}`);
  }
  // 近期 3 条在最前，且顺序是最新在前。
  assert.deepEqual(
    indexes.slice(0, 3).map((index) => linesOf(text)[index].match(SEGMENT_LINE)[1]),
    ["40", "39", "29"],
    text,
  );
});
