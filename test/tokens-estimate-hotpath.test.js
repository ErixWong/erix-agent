// Issue #172：token 估算热路径三连的回归网。
//
// 三件事都宣称「零行为变化」，所以这里的断言全部是**等价性**断言，而不是新口径断言：
//   A3 ASCII 快路径  → 与旧实现（for...of + CJK_RANGES.some）逐字节同值
//   A4 trim 线性化   → 与旧 O(n²) while 循环保留完全相同的条目集合
//   A2 复用估算      → compactionStats 的 tokensBefore/tokensAfter 与独立重算逐位相同
import test from "node:test";
import assert from "node:assert/strict";

import {
  GOVERNOR_HISTORY_TOKEN_LIMIT,
  runToolLoop,
  trimGovernorHistory,
} from "../src/loop/orchestrator.js";
import {
  countEstimateCharacters,
  estimateMessageTokens,
  estimateTokens,
  estimateTokensFromCharacterCounts,
} from "../src/tokens.js";
import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// ────────────────────────── 旧实现（HEAD 口径）逐字复刻 ──────────────────────────

const LEGACY_CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0x2ceb0, 0x2ebef],
  [0x30000, 0x3134f],
];

function legacyEstimateTokens(text, opts = {}) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const cjkTokensPerChar = opts.cjkTokensPerChar ?? 1.5;
  const charsPerToken = opts.charsPerToken ?? 3.5;
  const margin = opts.margin ?? 1.15;
  const isCjk = (character) => {
    const codePoint = character.codePointAt(0);
    return LEGACY_CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
  };
  let cjkCharacters = 0;
  let otherCharacters = 0;
  for (const character of value) {
    if (isCjk(character)) cjkCharacters += 1;
    else otherCharacters += 1;
  }
  return Math.ceil((cjkCharacters * cjkTokensPerChar + otherCharacters / charsPerToken) * margin);
}

// 旧消息级估算：块口径与 src/tokens.js 完全一致，只有字符计数走上面的旧实现
function legacyEstimateBlock(block, opts) {
  if (block?.type === "image" || block?.type === "image_url") {
    return opts?.imageTokenCost ?? opts?.imageTokens ?? 1000;
  }
  if (block?.type === "text") return legacyEstimateTokens(block.text, opts);
  if (block?.type === "reasoning"
    || (block?.type === "raw" && block?.payload?.kind === "reasoning")) {
    const text = block?.type === "reasoning" ? block.text : block.payload.text;
    return legacyEstimateTokens(text, opts)
      + (opts?.reasoningBlockCost ?? opts?.reasoningTokenCost ?? 0);
  }
  if (block?.type === "tool_use") {
    return legacyEstimateTokens(JSON.stringify(block.input ?? {}), opts)
      + legacyEstimateTokens(block.id ?? "", opts)
      + legacyEstimateTokens(block.name ?? "", opts);
  }
  if (block?.type === "tool_result") {
    // 真实实现走 `estimateTokens(block.content, opts)`：content 为数组时逐块估算，
    // 不是整块 JSON.stringify（旧复刻这里最容易错）
    return legacyEstimateValue(block.content, opts)
      + legacyEstimateTokens(block.tool_use_id ?? "", opts);
  }
  if (block?.type === "raw") {
    return legacyEstimateTokens(JSON.stringify(block.payload), opts)
      + (opts?.rawBlockCost ?? opts?.rawTokenCost ?? 0);
  }
  return legacyEstimateTokens(JSON.stringify(block), opts);
}

// `estimateTokens` 对数组入参走「逐块」分支，tool_result.content 正靠它
function legacyEstimateValue(value, opts) {
  if (Array.isArray(value)) {
    return value.reduce((total, block) => total + legacyEstimateBlock(block, opts), 0);
  }
  return legacyEstimateTokens(value, opts);
}

function legacyEstimateMessageTokens(messages, opts = {}) {
  const messageOverhead = opts?.messageOverhead ?? opts?.messageOverheadTokens ?? opts?.overhead ?? 4;
  let total = 0;
  for (const message of messages ?? []) {
    total += messageOverhead;
    if (typeof message?.content === "string") {
      total += legacyEstimateTokens(message.content, opts);
      continue;
    }
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) total += legacyEstimateBlock(block, opts);
  }
  return total;
}

// 旧 trim（#172 A4 前 orchestrator.js:959-965）：每移出一条就对剩余全量重估两遍
function legacyTrimGovernorHistory(state, limit = GOVERNOR_HISTORY_TOKEN_LIMIT) {
  while (state.runningLog.length > 1
    && legacyEstimateTokens(JSON.stringify(state.runningLog))
      + legacyEstimateTokens(JSON.stringify(state.l0Facts)) > limit) {
    state.runningLog.shift();
    state.l0Facts.shift();
  }
  return state;
}

// ─────────────────────────────── A3：逐字节同值 ───────────────────────────────

const SAME_TEXTS = [
  ["空串", ""],
  ["纯 ASCII", "hello world, 42 tabs\tand\nnewlines"],
  ["中英混排", "compactBeforeRound 压缩判断：主用本地估算（真实上下文大小）"],
  ["纯 CJK（BMP）", "你好，世界。这是一段纯中文文本，用于验证口径不变。"],
  ["纯 CJK 扩展 A 区", "㐀䶁䶂㐁㐂"],
  ["emoji 代理对", "😀😁😂🤣 result same? true ✅"],
  ["emoji 与汉字混排", "结果逐字节相同 😀 与汉字 漢字 混排 🈳"],
  ["CJK 扩展 B 代理对", "𠀀𠀁𠀂 𪜶 𬓵"],
  ["孤立高代理", "\ud83d"],
  ["孤立低代理", "\ude00"],
  ["代理对撕裂", "\ud83dx\ude00y\ud83d\ud83d\ude00\ude00"],
  ["假名/CJK 标点（低于 CJK_FLOOR）", "ぁあぃいヴヶンー「」・、。〆〇"],
  ["拉丁扩展与音标", "éàüñçßøåœæ ʰˡ ẞ"],
  ["希腊/西里尔/希伯来/阿拉伯", "ΑΒΓ Γειά σου Привет мир שלום مرحبا"],
  ["韩文（高于 CJK_FLOOR 但非 CJK）", "안녕하세요 한자"],
  ["全角与货币符号", "￥＄€₹①②③㈠㈡"],
  ["Combining marks", "é́ŵ̃ ́̃"],
];

test("#172 A3：ASCII 快路径与旧实现逐字节同值（固定文本 × 系数组合）", () => {
  const coefficientSets = [
    {},
    { cjkTokensPerChar: 2.5 },
    { charsPerToken: 1 },
    { margin: 1 },
    { cjkTokensPerChar: 1, charsPerToken: 4, margin: 2 },
    { cjkTokensPerChar: 0.25, charsPerToken: 7.7, margin: 1.0001 },
    { cjkTokensPerChar: 3, charsPerToken: 2.5, margin: 1.3 },
  ];
  for (const [label, text] of SAME_TEXTS) {
    for (const opts of coefficientSets) {
      assert.equal(
        estimateTokens(text, opts),
        legacyEstimateTokens(text, opts),
        `${label} / ${JSON.stringify(opts)}`,
      );
    }
  }
});

test("#172 A3：BMP 全码点逐一与非 BMP 采样均同值", () => {
  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    const text = `a${String.fromCharCode(codePoint)}b`;
    assert.equal(estimateTokens(text), legacyEstimateTokens(text), `U+${codePoint.toString(16)}`);
  }
  for (let codePoint = 0x10000; codePoint <= 0x10ffff; codePoint += 89) {
    const text = `x${String.fromCodePoint(codePoint)}y`;
    assert.equal(estimateTokens(text), legacyEstimateTokens(text), `U+${codePoint.toString(16)}`);
  }
});

test("#172 A3：CJK 区间上下边界逐点同值", () => {
  for (const [start, end] of LEGACY_CJK_RANGES) {
    for (const codePoint of [start - 1, start, start + 1, end - 1, end, end + 1]) {
      if (codePoint < 0 || codePoint > 0x10ffff) continue;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const text = String.fromCodePoint(codePoint);
      assert.equal(
        estimateTokens(text),
        legacyEstimateTokens(text),
        `boundary U+${codePoint.toString(16)}`,
      );
      assert.equal(
        estimateTokens(`前${text}后`),
        legacyEstimateTokens(`前${text}后`),
        `wrapped boundary U+${codePoint.toString(16)}`,
      );
    }
  }
});

test("#172 A3：随机 fuzz（多字符池混合）与旧实现同值", () => {
  const pools = [
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t{}\"':;,()",
    "中文漢字語彙表測試內容，標點符號。",
    "ぁあヴヶンー「」・、。漢字混じり",
    "Привет мир ☃ ✨ 😀 🈳 漢字",
    "\ud83d",
    "\ude00",
    "éàüñ",
  ];
  let seed = 123456789;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let iteration = 0; iteration < 800; iteration += 1) {
    const pool = pools[rand(pools.length)];
    let text = "";
    for (let index = 0; index < rand(180); index += 1) text += pool[rand(pool.length)];
    assert.equal(estimateTokens(text), legacyEstimateTokens(text), `fuzz #${iteration}`);
  }
});

test("#172 A3：消息级估算（image/tool_use/raw/reasoning/tool_result/未知块）同值", () => {
  const messages = [
    { role: "user", content: "中英 mixed 混排 with emoji 😀 and code: const x = 1;" },
    { role: "system" },
    { role: "user", content: null },
    {
      role: "assistant",
      content: [
        { type: "text", text: "漢字のみテキスト" },
        { type: "image", source: { type: "base64", data: "AAA" } },
        { type: "image_url", image_url: { url: "https://example.test/漢😀.png" } },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "bash",
          input: { command: "ls -la /tmp/漢字 😀", nested: { deep: [1, 2, null] } },
        },
        { type: "reasoning", text: "推理内容 reasoning" },
        { type: "raw", payload: { kind: "reasoning", text: "raw reasoning 漢😀" } },
        { type: "raw", payload: { kind: "other", blob: [1, 2, "漢😀"] } },
        { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "ok 結果" }] },
        { type: "tool_result", tool_use_id: "toolu_02", content: "纯字符串结果 漢" },
        { type: "unknown", nested: { deep: "漢字 and 😀" } },
        { type: "text", text: "" },
      ],
    },
  ];
  for (const opts of [
    {},
    { imageTokenCost: 0 },
    { rawBlockCost: 12 },
    { reasoningBlockCost: 7, margin: 1.3 },
    { cjkTokensPerChar: 2, charsPerToken: 2, margin: 1.7 },
    { messageOverhead: 0 },
  ]) {
    assert.equal(
      estimateMessageTokens(messages, opts),
      legacyEstimateMessageTokens(messages, opts),
      `message-level ${JSON.stringify(opts)}`,
    );
  }
  // 非字符串 content 归一化（String(text ?? "")）也必须同口径
  for (const value of [undefined, null, 0, false, NaN, {}]) {
    assert.equal(estimateTokens(value), legacyEstimateTokens(value), `coerced ${String(value)}`);
  }
});

test("#172 A3/A4：字符计数拆分与 estimateTokens 同值且对拼接可加", () => {
  const parts = ["abcdef", "漢字テキスト", "😀 emoji", "！，。", "\ud83d", "\ude00"];
  assert.deepEqual(
    countEstimateCharacters(""),
    [0, 0],
  );
  const merged = [0, 0];
  for (const part of parts) {
    const [cjk, other] = countEstimateCharacters(part);
    merged[0] += cjk;
    merged[1] += other;
    assert.equal(
      estimateTokensFromCharacterCounts(countEstimateCharacters(part)),
      estimateTokens(part),
      `part ${JSON.stringify(part)}`,
    );
  }
  assert.equal(
    estimateTokensFromCharacterCounts(merged),
    estimateTokens(parts.join("")),
    "逐段计数相加 === 整串估算",
  );
  assert.equal(estimateTokensFromCharacterCounts([0, 0]), 0);
});

// ─────────────────────────── A4：trim 线性化等价 ───────────────────────────

const makeLcg = (initial) => {
  let seed = initial;
  return (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
};
const TEXT_POOLS = [
  "abcdefghijklmnopqrstuvwxyz  ,\":;[]{}",
  "中文摘要内容，包含标点符号。",
  "😀🈳✨ mixed 混排 text",
];
const randomText = (rand, max) => {
  const pool = TEXT_POOLS[rand(TEXT_POOLS.length)];
  let out = "";
  for (let index = 0; index < rand(max); index += 1) out += pool[rand(pool.length)];
  return out;
};
const makeHistory = (rand, size) => {
  const runningLog = [];
  const l0Facts = [];
  for (let index = 0; index < size; index += 1) {
    runningLog.push({
      round: index + 1,
      summary: { planned: randomText(rand, 50), actual: randomText(rand, 120), source: "json" },
      ts: new Date(1700000000000 + index * 1000).toISOString(),
      ...(rand(4) === 0 ? { judge: { decision: "continue", why: randomText(rand, 30) } } : {}),
      ...(rand(5) === 0 ? { missing: undefined } : {}),
    });
    l0Facts.push({
      round: index + 1,
      errors: rand(3),
      files: [randomText(rand, 10)],
      ...(rand(6) === 0 ? { note: randomText(rand, 160) } : {}),
    });
  }
  return { runningLog, l0Facts };
};

test("#172 A4：线性修剪与旧 O(n²) 循环保留完全相同的条目（随机历史 × 限额扫描）", () => {
  const rand = makeLcg(987654321);
  let droppedTotal = 0;
  let floored = 0;
  for (let trial = 0; trial < 400; trial += 1) {
    const history = makeHistory(rand, rand(35));
    const limit = trial % 5 === 0 ? GOVERNOR_HISTORY_TOKEN_LIMIT : 1 + rand(6000);
    const expected = legacyTrimGovernorHistory({
      runningLog: structuredClone(history.runningLog),
      l0Facts: structuredClone(history.l0Facts),
    }, limit);
    const state = { runningLog: history.runningLog, l0Facts: history.l0Facts };
    const before = state.runningLog.length;
    const dropped = trimGovernorHistory(state, limit);
    assert.equal(dropped, before - state.runningLog.length, "dropped 必须等于实际弹出数");
    droppedTotal += dropped;
    if (state.runningLog.length === 1 && expected.runningLog.length === 1) floored += 1;
    assert.deepEqual(state.runningLog, expected.runningLog, `trial ${trial} limit ${limit}`);
    assert.deepEqual(state.l0Facts, expected.l0Facts, `trial ${trial} limit ${limit} (l0)`);
  }
  assert.ok(droppedTotal > 200, `随机历史应当真的触发修剪（实际弹出 ${droppedTotal} 条）`);
  assert.ok(floored > 0, "应当覆盖「至少留 1 条」的兜底路径");
});

test("#172 A4：阈值与「至少留 1 条」语义不变", () => {
  assert.equal(GOVERNOR_HISTORY_TOKEN_LIMIT, 4000);
  // 恰好不超 → 不修剪；刚好超 1 token → 修剪（与旧实现同一判据 `> limit`）
  const entry = (text) => ({ round: 1, actual: text });
  const fit = { runningLog: [entry("a"), entry("b")], l0Facts: [{ round: 1 }, { round: 2 }] };
  const fitLimit = legacyEstimateTokens(JSON.stringify(fit.runningLog))
    + legacyEstimateTokens(JSON.stringify(fit.l0Facts));
  assert.equal(trimGovernorHistory(structuredClone(fit), fitLimit), 0);
  assert.equal(trimGovernorHistory(structuredClone(fit), fitLimit - 1), 1);
  // 单条就超预算也必须留 1 条
  const huge = {
    runningLog: [entry("漢".repeat(4000))],
    l0Facts: [{ round: 1 }],
  };
  assert.equal(trimGovernorHistory(huge, 10), 0);
  assert.equal(huge.runningLog.length, 1);
  // 空历史不炸、不动
  const empty = { runningLog: [], l0Facts: [] };
  assert.equal(trimGovernorHistory(empty), 0);
  assert.deepEqual(empty, { runningLog: [], l0Facts: [] });
  // 默认 4000 上限下的行为与旧实现同值
  const rand = makeLcg(2468013579);
  const busy = makeHistory(rand, 60);
  const expectedBusy = legacyTrimGovernorHistory(structuredClone(busy));
  const actualBusy = structuredClone(busy);
  trimGovernorHistory(actualBusy);
  assert.deepEqual(actualBusy, expectedBusy);
  assert.ok(actualBusy.runningLog.length < busy.runningLog.length);
});

test("#172 A4：逐条 JSON 与整串 JSON 同口径（undefined 在数组位上归一化为 null）", () => {
  // undefined 在对象里会被 JSON 丢掉、在数组位上变成 "null"；逐条序列化必须走同一口径，
  // 否则递减账本会漂，修剪结果与旧实现不一致
  const state = {
    runningLog: [{ round: 1, a: undefined }, { round: 2, a: "漢字" }, { round: 3, a: "x" }],
    l0Facts: [{ round: 1 }, { round: 2, note: "内容" }, { round: 3 }],
  };
  for (const limit of [1, 3, 10, 20, 100, GOVERNOR_HISTORY_TOKEN_LIMIT]) {
    const expected = legacyTrimGovernorHistory(structuredClone(state), limit);
    const actual = structuredClone(state);
    trimGovernorHistory(actual, limit);
    assert.deepEqual(actual, expected, `limit ${limit}`);
  }
  // 极低限额下仍保留 1 条
  const floored = structuredClone(state);
  assert.equal(trimGovernorHistory(floored, 1), 2);
  assert.equal(floored.runningLog.length, 1);
  assert.equal(floored.l0Facts.length, 1);
});

// ─────────────────────── A2：复用估算不改 compaction 数字 ───────────────────────

const roundsFixture = (count, text) => {
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({ role: "user", content: `第 ${index} 轮：${text}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: `回复 ${index}：${text}` }] });
  }
  return messages;
};

// 单轮 end_turn + 总是折叠的自定义策略：整次运行只产生一条 compactionStat，
// 且「选层输出」就是策略返回的固定数组，于是各层的 tokensBefore 可以被独立重算
const compactsOnce = async ({ replacement, budgetTokens, keepRounds = 2, runId }) => {
  let snapshotBefore = null;
  const strategy = {
    shouldCompact(messages) {
      snapshotBefore = structuredClone(messages);
      return true;
    },
    async compact() {
      return {
        messages: structuredClone(replacement),
        compacted: true,
        foldedRounds: 1,
        foldedPayload: [{ role: "user", content: "folded 折叠" }],
      };
    },
  };
  const result = await runToolLoop({
    provider: createFakeProvider([
      { content: [{ type: "text", text: "done 完成" }], stopReason: "end_turn" },
    ]),
    initialUserMessage: "start 开始",
    executeTool: async ({ id }) => `result ${id} 漢😀`,
    maxRounds: 1,
    completion: false,
    context: { strategy, budgetTokens, keepRounds },
    store: createMemoryTranscriptStore(),
    runId,
  });
  return { result, snapshotBefore, replacement };
};

test("#172 A2：tokensBefore 复用轮首估算后，仍与压缩前全量独立重算逐位相同", async () => {
  const replacement = [{ role: "user", content: "[摘要] 已折叠，含中文与 emoji 😀" }];
  const { result, snapshotBefore } = await compactsOnce({
    replacement, budgetTokens: 60, runId: "hotpath-a2-before",
  });
  assert.equal(result.compactionStats.length, 1);
  const stat = result.compactionStats[0];
  // tokensBefore 现在直接复用轮首的 estimatedTokens（#172 A2 第 1 对），
  // 因此必须 === 对压缩前全量的一次独立重算（新旧口径也一致）
  assert.equal(stat.tokensBefore, estimateMessageTokens(snapshotBefore));
  assert.equal(stat.tokensBefore, legacyEstimateMessageTokens(snapshotBefore));
  assert.ok(stat.tokensBefore > 0);
});

test("#172 A2：tokensAfter 与压缩输出独立重算一致（无兜底层介入）", async () => {
  const replacement = [{ role: "user", content: "[摘要] 已折叠，含中文与 emoji 😀" }];
  const { result } = await compactsOnce({
    replacement, budgetTokens: 60, runId: "hotpath-a2-after",
  });
  const stat = result.compactionStats[0];
  assert.equal(stat.tokensAfter, estimateMessageTokens(replacement));
  assert.equal(stat.tokensAfter, legacyEstimateMessageTokens(replacement));
  for (const layer of Object.values(stat.layers)) {
    assert.equal(layer.triggered, 0, "本场景不应触发任何兜底层");
  }
});

test("#172 A2：budget 兜底层的 tokensBefore === 复用值（saved 可独立复算）", async () => {
  // 选层（匿名策略）折叠后仍超预算 → slidingWindow 兜底再折叠。
  // 兜底层的 tokensBefore 现在复用 tokensAfter，所以
  // 「选层输出独立重算 − slidingWindow.tokensSaved」必须正好等于兜底后的 tokensAfter。
  const replacement = roundsFixture(4, "内容漢字😀".repeat(6));
  const { result } = await compactsOnce({
    replacement, budgetTokens: 60, runId: "hotpath-a2-budget",
  });
  const stat = result.compactionStats[0];
  assert.equal(stat.layers.slidingWindow.triggered, 1);
  assert.equal(stat.layers.enforceSize.triggered, 0);
  assert.equal(
    estimateMessageTokens(replacement) - stat.layers.slidingWindow.tokensSaved,
    stat.tokensAfter,
    `复用值必须等于「选层输出的一次独立重算」${estimateMessageTokens(replacement)}`,
  );
  assert.ok(stat.tokensAfter < estimateMessageTokens(replacement));
});

test("#172 A2：safety 层的 tokensBefore 同样复用上一层 tokensAfter（双层链路可复算）", async () => {
  // 折叠 → slidingWindow 兜底 → 仍超预算 → enforceSize 兜底：三段的 before/after
  // 必须串成一条自洽链路，最上游等于选层输出的独立重算，最下游等于 stat.tokensAfter
  const replacement = roundsFixture(6, "内容漢字😀".repeat(8));
  const { result } = await compactsOnce({
    replacement, budgetTokens: 40, runId: "hotpath-a2-chain",
  });
  const stat = result.compactionStats[0];
  assert.equal(stat.layers.slidingWindow.triggered, 1);
  assert.equal(stat.layers.enforceSize.triggered, 1);
  assert.equal(
    estimateMessageTokens(replacement)
      - stat.layers.slidingWindow.tokensSaved
      - stat.layers.enforceSize.tokensSaved,
    stat.tokensAfter,
    "三层链路必须闭合：复用的 before 若与重算不等，这里就会差出 token",
  );
});

test("#172 A2：单条消息就超预算时 safety 层的 before 也是复用值", async () => {
  // slidingWindow 折叠不动（无完整轮），只有 enforceSize 动 →
  // safetyTokensBefore 必须等于进入兜底前那次全量估算（= 选层输出重算）
  const replacement = [{ role: "user", content: "漢字内容😀 ".repeat(300) }];
  const { result } = await compactsOnce({
    replacement, budgetTokens: 200, keepRounds: 0, runId: "hotpath-a2-safety",
  });
  const stat = result.compactionStats[0];
  assert.equal(stat.layers.slidingWindow.triggered, 0);
  assert.equal(stat.layers.enforceSize.triggered, 1);
  assert.equal(
    estimateMessageTokens(replacement) - stat.layers.enforceSize.tokensSaved,
    stat.tokensAfter,
  );
  assert.ok(stat.tokensAfter <= 200, "兜底后应当回到预算内");
});
