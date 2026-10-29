// issue #603：分段折叠块的**三处真机缺陷**（#601 合并后由真上游 e2e 暴露）。
//
// 真机块原文（issue 正文，`budgetTokens: 4000` / 30 段逐段翻译 / 60 轮 ⇒ 折 10 次）：
//
//   【上下文折叠·v1·erix-9f6e2c】共折叠 10 次，覆盖第 2–46 轮（共 61 轮）。
//   近期（最近 3 次，完整）：
//   - 第 36–46 轮（17 轮） · getParagraph {"index":"11"}
//   工具足迹：getParagraph×5。
//   ...
//   更早（仅标题，每条一行）：
//   - 第 10–10 轮（3 轮） · 无工具调用
//   ...
//   另有 7 次更早的已合并（只留标题）。
//
// 三处缺陷：
//   ① 轮数与区间自相矛盾（`第 36–46 轮（17 轮）`、`覆盖第 2–46 轮（共 61 轮）`）；
//   ② `另有 7 次` 把刚刚逐条列完的那批**又数了一遍**（读者会加成 3+7+7=17 次）；
//   ③ 每条 title 都是工具调用参数（`getParagraph {"index":"11"}`），对读者没有信息量。
//
// **为什么 #601 的单测全绿而缺陷看不见**：夹具里 `rounds` 一律按 `to-from+1` 造（自洽）、
// `older` 恰好为空、`title` 显式给。所以本文件的夹具一律用**不自洽的真实形状**：
// `record.rounds ≠ to-from+1`（真机是 17 vs 11）、`older` 非空、`title` 缺失。
//
// 判据（issue 正文「判据（绿）」逐条；第 6 格是变异反向证，在报告里逐条跑）：
//   1. 轮数一致；2. 不重复计数；3. title 有信息量；4. 缩进；5. 预算与夹断不变。
// 额外一格（不在 issue 正文里，但本单改了渲染形状就必须钉住）：往返自洽。

import test from "node:test";
import assert from "node:assert/strict";

import {
  FOLD_SUMMARY_RECENT_FOLDS,
  MAX_OLDER_FOLD_TITLES,
  createFoldStatisticalStrategy,
  formatFoldSummary,
} from "../../src/compact/fold-statistical.js";
import {
  FOLDED_FACTS_MAX_BYTES,
  buildFoldedFacts,
} from "../../src/compact/fold-summary-journal.js";

/** 分段行：与引擎渲染的形状逐字对应（近期/远期都只印区间：`- 第 36–46 轮 · title`）。 */
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

/** 真机那 10 折的**真实形状**：`rounds` 是压缩层的 `foldedRounds`（含兜底折），不是区间轮数。 */
const REAL_FOLDS = [
  { from: 2, to: 2, rounds: 1, calls: [1] },
  { from: 3, to: 7, rounds: 3, calls: [1, 2] },
  { from: 8, to: 9, rounds: 2, calls: [1] },
  { from: 10, to: 10, rounds: 3, calls: [] },
  { from: 12, to: 12, rounds: 1, calls: [1] },
  { from: 13, to: 13, rounds: 1, calls: [1] },
  { from: 14, to: 16, rounds: 2, calls: [1] },
  { from: 17, to: 24, rounds: 12, calls: [5, 6, 7] },
  { from: 25, to: 35, rounds: 16, calls: [5, 6, 7, 8, 9] },
  { from: 36, to: 46, rounds: 17, calls: [11, 12, 13, 14, 15] },
];

/**
 * 引擎形状的单折正文（与 `formatFoldSummary` 的单折渲染逐字同形）：
 * 首行是「区间句 + 工具足迹」，清单节跟在后面。
 *
 * 首行那句话正是 `foldedFacts.title`（#565：正文首行剥 marker）的来源，也是缺陷 1 的载体
 * （`共 ${rounds} 轮` 里的 `rounds` 与区间无关）。
 */
const foldTextOf = ({ from, to, rounds, calls }) => [
  `【上下文折叠·v1·erix-9f6e2c】早期第 ${from}–${to} 轮（共 ${rounds} 轮）已折叠。`
    + `工具足迹：${calls.length === 0 ? "无" : `getParagraph×${calls.length}`}。`,
  ...(calls.length === 0
    ? []
    : [
      "工具调用清单（机械摘要，不代表执行成功）：",
      ...calls.map((index) => `- getParagraph {"index":"${index}"}`),
    ]),
].join("\n");

/**
 * 造一条**与引擎落账同形**的折叠记录（`foldedFacts`）。
 *
 * `rounds` 故意与区间不自洽（真机现场：`rounds: 17` 而区间 36–46）；`text` 可以换成别的正文
 * （例如语义摘要 —— `title` 就是从它首行派生的）；`title: undefined` 显式模拟「账本没有 title」。
 */
const foldRecordOf = (fold) => {
  const text = fold.text ?? foldTextOf(fold);
  const record = buildFoldedFacts({
    text,
    incrementText: text,
    source: "statistical",
    roundRange: { from: fold.from, to: fold.to },
    rounds: fold.rounds,
  });
  if (fold.title === undefined) delete record.title;
  else if (fold.title !== null) record.title = fold.title;
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

/** 真机形状：账本给前 9 折（`rounds` 与区间不自洽），第 10 折现场折。 */
const renderRealShapedBlock = () => renderBlock({
  ledger: REAL_FOLDS.slice(0, -1).map(foldRecordOf),
  newest: REAL_FOLDS.at(-1),
});

test("#603-1 轮数一致：账本 rounds=17 而区间 36–46 ⇒ 渲染出的轮数不得与区间矛盾", async () => {
  const text = await renderRealShapedBlock();

  // 头行「共 N 轮」= **覆盖区间**的长度（46-2+1=45），不是各折 `count` 之和（真机现场 61）。
  assert.match(text, /共折叠 10 次，覆盖第 2–46 轮（共 45 轮）。/u, text);
  assert.doesNotMatch(text, /共 61 轮/u, `头行不得把兜底折算进区间轮数：\n${text}`);

  // 每一折那一行：**只印区间**（口径见 `recentFoldLines` 注释）。万一将来有人把计数印回来，
  // 它必须等于区间长度，否则这条判据红。
  const segments = segmentsOf(text);
  assert.equal(segments.length, 10, text);
  for (const line of segmentLinesOf(text)) {
    const match = line.match(SEGMENT_LINE);
    const from = Number.parseInt(match[1], 10);
    const to = Number.parseInt(match[2], 10);
    if (match[3] !== undefined) {
      assert.equal(Number.parseInt(match[3], 10), to - from + 1,
        `分段行的计数必须等于区间长度（修前是 record.rounds）：${line}`);
    }
  }
  // 真机现场那几条自相矛盾的行必须消失。
  assert.doesNotMatch(text, /第 36–46 轮（17 轮）/u, text);
  assert.doesNotMatch(text, /第 25–35 轮（16 轮）/u, text);
  assert.doesNotMatch(text, /第 10–10 轮（3 轮）/u, text);
  assert.doesNotMatch(text, /（\d+ 轮）/u, `分段行不得再出现轮数括号：\n${text}`);
});

test("#603-2 不重复计数：10 折（近期 3 + 更早 7）⇒ 折叠次数合计恰好 10", async () => {
  const text = await renderRealShapedBlock();
  const segments = segmentsOf(text);

  assert.equal(segments.length, 10, text);
  assert.match(text, /共折叠 10 次/u, text);
  assert.equal(segments.length - FOLD_SUMMARY_RECENT_FOLDS, 7, "近期 3 + 更早 7");
  // 更早那 7 条**全部逐条列了** ⇒ 没有「剩下的那批」⇒ 不得再补一句「另有 N 次」。
  // （修前这里写 `另有 ${older.length}` ⇒ 3+7+7=17 次，比真实的 10 次多出 7。）
  assert.doesNotMatch(text, /另有 \d+ 次/u, `全部列完时不得重复计数：\n${text}`);
  // 块里出现的折叠次数：逐条行 10 条 = 头行声明的 10 次。
  assert.equal(segmentLinesOf(text).length, Number(text.match(/共折叠 (\d+) 次/u)[1]));
});

test("#603-2b 真的还有剩下的那批时：`另有 N 次` 的 N 是被截掉的那些（不是 older.length）", () => {
  const older = MAX_OLDER_FOLD_TITLES + 5;
  const total = FOLD_SUMMARY_RECENT_FOLDS + older;
  const segments = Array.from({ length: total }, (_, index) => ({
    from: index + 1,
    to: index + 1,
    count: 1,
    title: `exec case-${index + 1}`,
    tools: new Map(),
    inventory: [],
    stubs: [],
  }));
  const text = formatFoldSummary({
    from: 1,
    to: total,
    count: total,
    tools: new Map(),
    segments,
  });

  const listed = segmentLinesOf(text).length;
  assert.equal(listed, FOLD_SUMMARY_RECENT_FOLDS + MAX_OLDER_FOLD_TITLES,
    `逐条列出的条数受 MAX_OLDER_FOLD_TITLES 约束：\n${text}`);
  const remaining = Number(text.match(/^另有 (\d+) 次/mu)[1]);
  assert.equal(remaining, total - listed,
    `N 必须是**剩下的那批**（修前是 older.length = ${older}）：\n${text}`);
  assert.equal(remaining, 5, text);
  // 折叠次数的账对得上：头行声明 = 逐条列出的 + 另有 N 次。
  assert.equal(Number(text.match(/共折叠 (\d+) 次/u)[1]), listed + remaining);
});

test("#603-3 title 有信息量：账本 title → 本折摘要首句 → 清单（真机形状里不再是工具调用参数）", async () => {
  // ① 真机形状：账本 title 是「区间句 + 工具足迹」⇒ 剥掉区间句后 title 是工具足迹，
  //    而**不是**清单首条 `getParagraph {"index":"…"}`。
  const text = await renderRealShapedBlock();
  const segments = segmentsOf(text);
  assert.equal(segments.length, 10, text);
  for (const segment of segments) {
    assert.doesNotMatch(segment.title, /getParagraph \{/u,
      `title 不得是工具调用参数：第 ${segment.from}–${segment.to} 轮 · ${segment.title}`);
    assert.doesNotMatch(segment.title, /早期第 \d+–\d+ 轮/u,
      `title 不得重复本行已经印过的区间句：${segment.title}`);
  }
  assert.match(text, /^- 第 36–46 轮 · 工具足迹：getParagraph×11$/mu, text);
  assert.match(text, /^- 第 10–10 轮 · 无工具调用$/mu, text);

  // ② 语义 title（`fold-llm` 的首行）原样保留 —— 它比工具足迹有信息量得多。
  const semantic = await renderBlock({
    ledger: [foldRecordOf({
      from: 25,
      to: 35,
      rounds: 16,
      text: "第 25–35 段译文已定稿（术语表统一为「上下文折叠」）。\n工具足迹：getParagraph×5。",
    })],
    newest: REAL_FOLDS.at(-1),
  });
  // title 是标题不是句子 ⇒ 句末句号被剥掉（两条路同一写法）。
  assert.match(semantic, /^- 第 25–35 轮 · 第 25–35 段译文已定稿（术语表统一为「上下文折叠」）$/mu,
    `账本 title（剥掉 marker/区间句后）必须原样用上：\n${semantic}`);

  // ③ 三级优先级一次看清（同一个块里三条，按链取到的东西各不相同）：
  //    账本 title 缺失 ⇒ 本折摘要首句；两者都缺 ⇒ 清单首条（最后才退到它）。
  const ordered = formatFoldSummary({
    from: 1,
    to: 3,
    count: 3,
    tools: new Map(),
    segments: [
      {
        from: 3, to: 3, count: 1, title: "", ledgerTitle: "账本 title 优先", summaryText: "摘要首句。后面还有。", tools: new Map(), inventory: ["exec inventory"], stubs: [],
      },
      {
        from: 2, to: 2, count: 1, title: "", ledgerTitle: undefined, summaryText: "摘要首句。后面还有。", tools: new Map(), inventory: ["exec inventory"], stubs: [],
      },
      {
        from: 1, to: 1, count: 1, title: "", ledgerTitle: undefined, summaryText: "", tools: new Map(), inventory: ["exec inventory"], stubs: [],
      },
    ],
  });
  assert.match(ordered, /^- 第 3–3 轮 · 账本 title 优先$/mu, ordered);
  assert.match(ordered, /^- 第 2–2 轮 · 摘要首句$/mu, ordered);
  assert.match(ordered, /^- 第 1–1 轮 · exec inventory$/mu, ordered);
});

test("#603-4 缩进：工具足迹 / 清单行缩进在 title 之下，title 行与远期行不缩进", () => {
  const text = formatFoldSummary({
    from: 1,
    to: 2,
    count: 2,
    tools: new Map(),
    segments: [
      {
        from: 2, to: 2, count: 1, title: "第 2 段译文已定稿", ledgerTitle: undefined, summaryText: "", tools: new Map([["getParagraph", 2]]), inventory: ['getParagraph {"index":"2"}', 'getParagraph {"index":"3"}'], stubs: [],
      },
      {
        from: 1, to: 1, count: 1, title: "第 1 段译文已定稿", ledgerTitle: undefined, summaryText: "", tools: new Map(), inventory: [], stubs: [],
      },
    ],
  });

  assert.match(text, /^- 第 2–2 轮 · 第 2 段译文已定稿$/mu, text);
  // 明细行：两个空格起头（视觉从属清楚）；title 行、清单条目与足迹行都不得与 title 同级。
  assert.match(text, /^ {2}工具足迹：getParagraph×2。$/mu, text);
  assert.match(text, /^ {2}工具调用清单（机械摘要，不代表执行成功）：$/mu, text);
  assert.match(text, /^ {2}- getParagraph \{"index":"2"\}$/mu, text);
  assert.match(text, /^ {2}- getParagraph \{"index":"3"\}$/mu, text);
  // 远期那一行（只有 title）不得缩进：它是同级的一条记录，不是谁的明细。
  assert.match(text, /^- 第 1–1 轮 · 第 1 段译文已定稿$/mu, text);
  // 每条分段行本身都不缩进（缩进只属于明细）。
  for (const line of segmentLinesOf(text)) assert.ok(line.startsWith("- "), line);
});

test("#603-5 预算与夹断不变：20 折 ⇒ 块 ≤ FOLDED_FACTS_MAX_BYTES，最新那条不被削", async () => {
  // 每一折都带 8 条长清单（近期那 3 折会被 `MAX_RECENT_FOLD_CHARS` 自己削，远期只剩一行 title），
  // 于是整块必然超过 `FOLDED_FACTS_MAX_BYTES` ⇒ 走 `buildFoldedFacts` 的前缀夹断。
  const longFoldText = (index) => [
    `【上下文折叠·v1·erix-9f6e2c】早期第 ${index}–${index} 轮（共 1 轮）已折叠。工具足迹：exec×8。`,
    "工具调用清单（机械摘要，不代表执行成功）：",
    ...Array.from({ length: 8 }, (_, k) => `- exec ${`case-${index}-${k}-`.padEnd(70, "x")}`),
  ].join("\n");
  const ledger = Array.from({ length: 19 }, (_, index) => foldRecordOf({
    from: index + 1,
    to: index + 1,
    rounds: 1,
    calls: [index + 1],
    text: longFoldText(index + 1),
  }));
  const text = await renderBlock({
    ledger,
    newest: { from: 20, to: 20, rounds: 1, calls: [20] },
  });

  const facts = buildFoldedFacts({ text, roundRange: { from: 1, to: 20 }, rounds: 20 });
  assert.equal(facts.truncated, true,
    `前置：这一份必须真的被夹断（实测 ${new TextEncoder().encode(text).length} 字节）`);
  assert.ok(new TextEncoder().encode(facts.text).length <= FOLDED_FACTS_MAX_BYTES,
    `夹断后 ≤ ${FOLDED_FACTS_MAX_BYTES}`);
  // 头行与**最新那一折**都在（夹断只削尾部）。
  assert.match(facts.text, /共折叠 20 次，覆盖第 1–20 轮（共 20 轮）/u, facts.text);
  assert.match(facts.text, /^- 第 20–20 轮 · /mu, facts.text);
  assert.match(facts.text, /^- 第 19–19 轮 · /mu, facts.text);
  // 单折渲染上界（`MAX_RECENT_FOLD_CHARS` = 600，本文件不导出它，用「近期那折自己的字符数」钉住）。
  const lines = text.split("\n");
  const starts = lines.reduce((acc, line, index) => (SEGMENT_LINE.test(line) ? [...acc, index] : acc), []);
  for (const start of starts.slice(0, FOLD_SUMMARY_RECENT_FOLDS)) {
    const end = starts.find((candidate) => candidate > start) ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    assert.ok(Array.from(body).length <= 600, `近期那折 ≤600 字符，实测 ${Array.from(body).length}`);
  }
});

test("#603-6 往返自洽：新形状（无计数 + 缩进 + title）解析回来与渲染一致", async () => {
  const text = await renderRealShapedBlock();
  const before = segmentsOf(text);
  assert.equal(before.length, 10, text);

  // ② 拿这块当**上一块**再折一次（不给账本 ⇒ 走块解析兜底），形状必须原样读回来。
  // 拿这块当 head 里的旧块，只折**新的一轮**（第 47 轮）：不给账本 ⇒ 旧那 10 折只能从块里解析回来。
  const again = await createFoldStatisticalStrategy().compact([
    { role: "user", content: [{ type: "text", text }, { type: "text", text: "任务原文" }] },
    toolUse("use-47", "getParagraph", { index: "47" }),
    toolResult("use-47", "第 47 段中文原文……"),
  ], { keepRounds: 0, roundNumbers: [47] });
  const after = segmentsOf(summaryTextOf(again));

  // 旧那 10 折逐条还在，区间与 title 逐字一致（计数按区间还原，往返不变形）。
  assert.deepEqual(after.slice(1), before, `块解析兜底必须逐字读回来：\n${summaryTextOf(again)}`);
  assert.deepEqual([after[0].from, after[0].to], [47, 47], summaryTextOf(again));
  assert.equal(after.length, 11, summaryTextOf(again));
  // 缩进没有破坏清单解析：近期那几折的清单条目仍在（`parseInventorySection` 已 trimStart）。
  assert.match(summaryTextOf(again), /^ {2}- getParagraph \{"index":"47"\}$/mu, summaryTextOf(again));
});
