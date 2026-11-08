// issue #767 切片 S1 · B 组：**契约载荷表与代码之间的证伪连接**。
//
// 病根（#767 三方分析裁定的那件）：契约里那张逐格清点表是**散文**，代码改了它不会红。
// 今天把某格在契约里标成 `write: stopped` 而代码照写，**没有任何测试会红**——
// `test/loop-snapshot-write-side-735.test.js` 第 127-142 行反而要求这 10 格**必须在场**，
// 于是「停写」这件事在测试面上是隐形的；把某格标成 `read: not-source` 而恢复侧照读，同样隐形。
// 本文件把三件事接上：
//   1) **写轴对真载荷**：契约声明 `stopped` ⇒ 引擎亲手交给 `saveRunSnapshot` 的 payload 必须**无该键**；
//      声明 `written` / `residue` ⇒ 必须**有该键**（夹具取法照 `loop-snapshot-write-side-735.test.js`：
//      包一层 `saveRunSnapshot` 抓引擎亲自写的那份，不手搓快照）。
//   2) **读轴对真源码**：契约声明 `read: not-source` ⇒ `src/loop/resume-manager.js` 里**不得有**对该键的
//      快照读点。扫描**先剥注释与字符串字面量**（否则 `src/loop/resume-manager.js:518` 那句注释里的
//      `snapshot.messages` 会被当成读点 = 假红，而反向证也就废了）。剥逻辑自带反例（G-S1 那条用例）。
//   3) **表自洽**：10 格齐全（漏格即红）、两轴取值合法、无空单元格、中英两份逐格一致，
//      且表里每条 `file:line` 都复核：**文件在场 + 行号在范围内 + 那一行确实提到这格的键名**
//      （⇒ #767 正文里那批 0.31.0 的旧行号抄进来会红）。
//
// ⚠ `read` 轴的口径只量**恢复侧**（`src/loop/resume-manager.js` 里对快照对象那一层的属性读取）。
//   「引擎不读」不等于「没人碰这格」：`status` 与 `compactionStats` 引擎零读者，却被测试当形状指纹钉住，
//   那两格在契约里写 `not-source` 是**真话**，而「因此可以停写」不是——后者由表里的「交接条件」列承担。
//
// 零 LLM、零写盘、零子进程（夹具只跑 fake provider）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryTranscriptStore } from "../src/store/memory.js";
import { runDirect } from "./helpers/run-direct.js";
import { createFakeProvider } from "./helpers/fake-provider.js";

// issue #772 R3：14 格两轴的锚点登记表住在 `scripts/cell-axes-anchors.mjs`，**闸与这份测试 import 同一份**
// （R2 之前表住在下面这个文件里、闸再用正则把它抽出来 ⇒ 豁免是闸发的、锚点却住在测试里，只有
// `node --test` 会重算行号，`npm run check:docs` 看不见）。命中语义（唯一命中 / 等值 / 组键）也同源。
import {
  CELL_AXES_ANCHORS as CELL_AXES_ANCHORS_SHARED,
  CELL_AXES_ANCHOR_FLOORS,
  CELL_AXES_ANCHOR_MODULE,
  CELL_AXES_REQUIRED_CELLS,
  anchorGroupKey,
  anchorHitLines,
  anchorKindError,
  anchorLineIsComment,
  anchorLinesEqual,
  anchorTableShape,
  cellAxesRequiredSlotKey,
  checkCellAxesCoverage,
} from "../scripts/cell-axes-anchors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** 两份契约（中英必须逐格一致，见 G5）。 */
const DOCS = [
  { side: "cn", file: "docs/host-consumer-contract_cn.md" },
  { side: "en", file: "docs/host-consumer-contract.md" },
];
const BEGIN = "<!-- erix:snapshot-cell-axes:begin -->";
const END = "<!-- erix:snapshot-cell-axes:end -->";

/** 契约必须列全的 14 个格名（issue #767 的清点面；表里是 **15 行**——一个键名
 *  `persistedTranscriptLength` 底下是两个东西，占两行，见 `SPLIT_ROWS`）。 */
const CELL_KEYS = [
  "round",
  "status",
  "pendingToolUse",
  "pendingToolUses",
  "executedToolIds",
  "toolResults",
  "toolOutputs",
  "messages",
  "persistedTranscriptLength",
  "compactionStats",
  // S1r 补的 4 格：前两格是**条件写入**（「载荷里必须在场的键」那种清单天然看不见它们），
  // 后两格是**已停写**（机器缺席断言见 test/loop-snapshot-write-side-735.test.js 判据 1）。
  "partialText",
  "partialRound",
  "toolUse",
  "ts",
];
const WRITE_VOCAB = new Set(["written", "written(conditional)", "residue", "stopped"]);
/** 条件写入轴值：那一格只在写明的条件成立时才进载荷（写点 `src/loop/orchestrator.js:3039`）。 */
const CONDITIONAL_WRITE = "written(conditional)";
/** 一个键名底下是两个东西 ⇒ `persistedTranscriptLength` 必须**恰好两行**（盘上格 / 进程内计数器）。 */
const SPLIT_ROWS = { persistedTranscriptLength: 2 };

/** 读轴：`source` / `not-source` / `fallback(条件)`；只取头一段做中英比对（括号里的条件按语言写）。 */
function readAxisHead(value) {
  if (value === "source" || value === "not-source") return value;
  const fallback = /^fallback\([^()]*\)$/u.exec(value);
  return fallback === null ? null : "fallback";
}

/** 表内一个键名（允许一个括注，用于 `persistedTranscriptLength` 的两行）。 */
function parseKey(cell) {
  const match = /^\s*`([A-Za-z][A-Za-z0-9]*)`\s*(?:[（(][^|]*[)）])?\s*$/u.exec(cell);
  return match === null ? null : match[1];
}

/** 表内出现的 `file:line` 引用（只认仓库内路径，避免把 `40a518d` / `0.31.0` 当成引用）。 */
const CITATION = /(?:src|bin|test|docs|examples|scripts)\/[A-Za-z0-9_./-]+\.(?:js|mjs|md):[0-9]+/gu;

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/** 从一份契约里切出载荷表 ⇒ 结构化行。缺标记 / 列数不对 / 行残缺都直接在这里红。 */
function loadTable(doc) {
  const text = readFileSync(join(ROOT, doc.file), "utf8");
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  assert.ok(from >= 0 && to > from, `${doc.side}：契约里找不到载荷表标记 ${BEGIN}`);
  const block = text.slice(from, to);
  const lines = block.split("\n").filter((line) => line.trim().startsWith("|"));
  assert.ok(lines.length >= 3, `${doc.side}：载荷表至少要有表头 + 分隔行 + 数据行`);
  const header = splitRow(lines[0]);
  assert.equal(header.length, 7, `${doc.side}：载荷表必须是 7 列（格 / write / read / 权威源 / 交接条件 / 写点 / 读者）`);
  assert.match(header.join(" "), /write/u, `${doc.side}：表头必须有 write 轴`);
  assert.match(header.join(" "), /read/u, `${doc.side}：表头必须有 read 轴`);
  const rows = lines.slice(2).map((line, index) => {
    const cells = splitRow(line);
    assert.equal(
      cells.length,
      7,
      `${doc.side}：第 ${index + 1} 行必须 7 列（格子里不许出现裸 `|`）：${line}`,
    );
    for (const [cellIndex, cell] of cells.entries()) {
      assert.ok(cell.length > 0, `${doc.side}：第 ${index + 1} 行第 ${cellIndex + 1} 列是空值`);
    }
    const key = parseKey(cells[0]);
    assert.ok(key !== null, `${doc.side}：第 ${index + 1} 行的格名必须是反引号里的 payload 键名：${cells[0]}`);
    return {
      side: doc.side,
      file: doc.file,
      key,
      label: cells[0],
      write: cells[1],
      read: cells[2],
      authority: cells[3],
      handoff: cells[4],
      writeSite: cells[5],
      readers: cells[6],
    };
  });
  // `side` 必须随表一起回：下面那几个 `for (const { side, rows } of tables.values())` 靠它点名中英，
  // 以前这里漏带 ⇒ 所有报错只说「undefined：…」（#772 R2 顺手补上，不改任何判据）。
  return { side: doc.side, block, rows };
}

const tables = new Map(DOCS.map((doc) => [doc.side, loadTable(doc)]));

// ── G1 表自洽（漏格即红、两轴词表、无空值、中英一致）────────────────────────────

test("G1 载荷表自洽：14 格齐全、两轴取值合法、无空值", () => {
  for (const { side, rows } of tables.values()) {
    const counts = new Map();
    for (const row of rows) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    }
    assert.deepEqual(
      [...counts.keys()].sort(),
      [...CELL_KEYS].sort(),
      `${side}：表里的格名集合必须**恰好**是这 14 个（漏一格 = 集合缺项，多一格 = 多项）`,
    );
    for (const [key, expected] of Object.entries(SPLIT_ROWS)) {
      assert.equal(
        counts.get(key),
        expected,
        `${side}：\`${key}\` 必须写 ${expected} 行（盘上那格与进程内计数器是两件事，不许合成一行含糊过去）`,
      );
    }
    for (const row of rows) {
      assert.ok(
        WRITE_VOCAB.has(row.write),
        `${side}：\`${row.key}\` 的 write 轴取值 "${row.write}" 不在 written|written(conditional)|residue|stopped 里`,
      );
      assert.ok(
        readAxisHead(row.read) !== null,
        `${side}：\`${row.key}\` 的 read 轴取值 "${row.read}" 不在 source|fallback(条件)|not-source 里`,
      );
      // 「退役」单标签禁在**轴列**上：那一列只能是词表值，不许写「退役 / retired」这类跨轴结论。
      for (const axisCell of [row.write, row.read]) {
        assert.doesNotMatch(
          axisCell,
          /退役|retire|deprecat/iu,
          `${side}：\`${row.key}\` 的轴列 "${axisCell}" 用了「退役」单标签（两轴必须分开写）`,
        );
      }
    }
  }
});

test("G5 中英两份逐格一致（格序、write 轴、read 轴头）", () => {
  const cn = tables.get("cn").rows;
  const en = tables.get("en").rows;
  assert.deepEqual(
    cn.map((row) => row.key),
    en.map((row) => row.key),
    "中英两份的格序列必须逐位相同（`persistedTranscriptLength` 的两行也按序对齐）",
  );
  for (const [index, cnRow] of cn.entries()) {
    const enRow = en[index];
    assert.equal(
      cnRow.write,
      enRow.write,
      `\`${cnRow.key}\` 的 write 轴中英不一致：cn=${cnRow.write} / en=${enRow.write}`,
    );
    assert.equal(
      readAxisHead(cnRow.read),
      readAxisHead(enRow.read),
      `\`${cnRow.key}\` 的 read 轴头中英不一致：cn=${cnRow.read} / en=${enRow.read}`,
    );
  }
});

// ── G2 写轴对真载荷（B1）───────────────────────────────────────────────────────

const READ_FILE_SCHEMA = {
  name: "readFile",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const TOOL_BLOCK = { type: "tool_use", id: "call-767", name: "readFile", input: { path: "a.txt" } };

/** 抓**真实**写侧载荷（夹具取法照 `test/loop-snapshot-write-side-735.test.js`：包一层 store）。 */
let captured = null;
async function capturePayloads() {
  if (captured !== null) return captured;
  const store = createMemoryTranscriptStore();
  const payloads = [];
  const saveRunSnapshot = store.saveRunSnapshot.bind(store);
  store.saveRunSnapshot = async (runId, snapshot) => {
    payloads.push(structuredClone(snapshot));
    return saveRunSnapshot(runId, snapshot);
  };
  const result = await runDirect({
    provider: createFakeProvider([
      { content: [TOOL_BLOCK], stopReason: "tool_use" },
      { content: [{ type: "text", text: "读完了" }], stopReason: "end_turn", times: 4 },
    ]),
    tools: [READ_FILE_SCHEMA],
    executeTool: async () => ({ content: "a.txt 的内容" }),
    store,
    runId: "contract-snapshot-cell-axes-767",
    maxRounds: 4,
    initialUserMessage: "读一下 a.txt",
  });
  assert.ok(payloads.length > 0, "引擎必须真的写过 run snapshot（否则本用例是空转）");
  assert.equal(result.finalText, "读完了", "run 必须正常收口（否则现场是个 failed 的 run）");
  captured = { payloads, result };
  return captured;
}

test("G2 写轴对真载荷：声明 written/residue ⇒ 键必须在场，声明 stopped ⇒ 键必须缺席", async () => {
  const { payloads } = await capturePayloads();
  const rows = tables.get("cn").rows;
  assert.ok(
    rows.some((row) => row.write === "stopped"),
    "表里必须至少有一格 `write: stopped`，否则本用例的 stopped 分支是空转（#767 S1r 缺陷 2）",
  );
  assert.ok(
    rows.some((row) => row.write === CONDITIONAL_WRITE),
    "表里必须至少有一格 `write: written(conditional)`，否则条件写入没人复核（#767 S1r 缺陷 1）",
  );
  for (const row of rows) {
    if (row.write === CONDITIONAL_WRITE) {
      // 条件写入不能按「每条载荷都必须在场」判 ⇒ 交给 G2c 按两种现场双向判。
      continue;
    }
    if (row.write === "stopped") {
      for (const payload of payloads) {
        assert.ok(
          !Object.hasOwn(payload, row.key),
          `契约把 \`${row.key}\` 标成 stopped，但引擎仍把该键交给 saveRunSnapshot（keys：${JSON.stringify(Object.keys(payload))}）`,
        );
      }
    } else {
      for (const payload of payloads) {
        assert.ok(
          Object.hasOwn(payload, row.key),
          `契约把 \`${row.key}\` 标成 ${row.write}，但有一条写侧载荷缺该键（keys：${JSON.stringify(Object.keys(payload))}）`,
        );
      }
    }
  }
});

// ── G2c 条件写入格：两种现场双向判（#767 S1r 缺陷 1）──────────────────────────

/** 流式夹具：`deltas` 非空 ⇒ 本轮真有半截正文；为空 ⇒ 其余配置完全相同但一句正文都没吐。 */
function createPartialStreamProvider({ deltas, turns }) {
  let index = 0;
  const respond = async (request, streaming) => {
    const step = turns[Math.min(index, turns.length - 1)];
    index += 1;
    if (streaming) {
      for (const chunk of deltas) request.onDelta(chunk);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return { content: step.content, stopReason: step.stopReason };
  };
  return {
    protocol: "fake",
    model: "fake-model",
    async chat(request) { return respond(request, false); },
    async chatStream(request) { return respond(request, true); },
  };
}

async function capturePartialRun(deltas, runId) {
  const store = createMemoryTranscriptStore();
  const payloads = [];
  const saveRunSnapshot = store.saveRunSnapshot.bind(store);
  store.saveRunSnapshot = async (id, snapshot) => {
    payloads.push(structuredClone(snapshot));
    return saveRunSnapshot(id, snapshot);
  };
  const result = await runDirect({
    provider: createPartialStreamProvider({
      deltas,
      turns: deltas.length > 0
        ? [
          { content: [{ type: "text", text: "我先读一下 a.txt。" }, TOOL_BLOCK], stopReason: "tool_use" },
          { content: [{ type: "text", text: "读完了" }], stopReason: "end_turn" },
        ]
        : [
          { content: [TOOL_BLOCK], stopReason: "tool_use" },
          { content: [{ type: "text", text: "读完了" }], stopReason: "end_turn" },
        ],
    }),
    tools: [READ_FILE_SCHEMA],
    executeTool: async () => ({ content: "a.txt 的内容" }),
    store,
    runId,
    maxRounds: 4,
    initialUserMessage: "读一下 a.txt",
    stream: true,
    partialPersistence: { intervalMs: 40 },
  });
  assert.equal(result.finalText, "读完了", `${runId} 必须正常收口（否则现场是个 failed 的 run）`);
  assert.ok(payloads.length > 0, `${runId} 必须真的写过 run snapshot`);
  return payloads;
}

let partialScenes = null;
async function capturePartialScenes() {
  if (partialScenes !== null) return partialScenes;
  partialScenes = {
    withText: await capturePartialRun(["我先", "读一下 a.txt。"], "contract-snapshot-axes-767-partial"),
    withoutText: await capturePartialRun([], "contract-snapshot-axes-767-no-partial"),
  };
  return partialScenes;
}

test("G2c 条件写入格：有半截正文 ⇒ 该格必须在场；没有半截正文 ⇒ 整格缺席（不许写 undefined）", async () => {
  const keys = tables.get("cn").rows
    .filter((row) => row.write === CONDITIONAL_WRITE)
    .map((row) => row.key);
  assert.deepEqual(keys, ["partialText", "partialRound"], "条件写入格只有这两格，多一格少一格都要先回表看");
  const { withText, withoutText } = await capturePartialScenes();
  const present = withText.filter((payload) => Object.hasOwn(payload, "partialText"));
  assert.ok(present.length > 0, "有半截正文的现场里没有任何载荷带 partialText ⇒ 条件分支从没进过（空转）");
  assert.ok(
    withText.some((payload) => !Object.hasOwn(payload, "partialText")),
    "同一现场里轮末那条完整载荷也该整格缺席 ⇒ 条件假时是**整格不写**，不是写 undefined",
  );
  assert.ok(
    withoutText.every((payload) => !Object.hasOwn(payload, "partialText") && !Object.hasOwn(payload, "partialRound")),
    `没有半截正文的现场里仍有载荷写了该格（keys：${JSON.stringify(Object.keys(withoutText[0]))}）`,
  );
  for (const payload of withText) {
    // 同生同灭：只写一半 ⇒ 恢复侧读到 undefined 轮号或 undefined 正文，都是坏现场。
    assert.equal(
      Object.hasOwn(payload, "partialText"),
      Object.hasOwn(payload, "partialRound"),
      `两格必须同生同灭（keys：${JSON.stringify(Object.keys(payload))}）`,
    );
    for (const key of keys) {
      if (!Object.hasOwn(payload, key)) continue;
      assert.notEqual(payload[key], undefined, `\`${key}\` 在场时取值不能是 undefined（写 undefined ≠ 整格缺席）`);
    }
  }
  for (const payload of present) {
    assert.equal(typeof payload.partialText, "string");
    assert.ok(payload.partialText.length > 0, "在场的 partialText 必须是非空正文");
    assert.ok(Number.isSafeInteger(payload.partialRound), "partialRound 必须是安全整数");
    assert.equal(payload.partialRound, payload.round, "partialRound 必须等于该条载荷的 round");
    assert.match(payload.partialText, /我先读一下/);
  }
});


// ── G3 读轴对真源码（B2：剥注释与字符串）───────────────────────────────────────

/** 上一次非空白代码字符 ⇒ 判断 `/` 是正则字面量还是除号。 */
const REGEX_ALLOWED_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * 剥掉注释与字符串/模板字面量，**保留换行个数**（于是剥完的行号与原文行号一一对齐）。
 * 模板字面量整段剥（含 `${}` 里的代码）⇒ 靠 G3-B 那两条在场断言兜住「剥多了把代码也剥掉」。
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let previousSignificant = "";
  let index = 0;
  const length = source.length;
  const keepNewlines = (from, to) => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (source[cursor] === "\n") out += "\n";
    }
  };
  while (index < length) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (char === "/" && nextChar === "/") {
      const start = index;
      while (index < length && source[index] !== "\n") index += 1;
      keepNewlines(start, index);
      continue;
    }
    if (char === "/" && nextChar === "*") {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      keepNewlines(start, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        index += 1;
      }
      out += "\"STR\"";
      keepNewlines(start + 1, index);
      continue;
    }
    if (char === "/" && (previousSignificant === "" || REGEX_ALLOWED_AFTER.has(previousSignificant))) {
      const start = index;
      index += 1;
      let inClass = false;
      while (index < length) {
        const cursor = source[index];
        if (cursor === "\\") { index += 2; continue; }
        if (cursor === "[") inClass = true;
        else if (cursor === "]") inClass = false;
        else if (cursor === "/" && !inClass) { index += 1; break; }
        else if (cursor === "\n") break;
        index += 1;
      }
      while (index < length && /[a-z]/u.test(source[index])) index += 1;
      out += "/RE/";
      keepNewlines(start, index);
      continue;
    }
    out += char;
    if (!/\s/u.test(char)) previousSignificant = char;
    index += 1;
  }
  return out;
}

const RESUME_FILE = "src/loop/resume-manager.js";
/** 快照对象在这一层的其它名字（穷举口径同 #735 切片 1 的字段面）。 */
const SNAPSHOT_OBJECTS = "(?:resumeRunSnapshot|runSnapshot|latestSnapshot|snapshot|checkpoint)";

/** 在**已剥**源码里找某键的快照读点行号（1 基）。 */
function snapshotReadLines(strippedSource, key) {
  const pattern = new RegExp(
    `\\b${SNAPSHOT_OBJECTS}\\s*\\??\\s*\\.\\s*${key}\\b(?!\\w)`,
    "gu",
  );
  const lines = [];
  let match = null;
  let scanned = "";
  while ((match = pattern.exec(strippedSource)) !== null) {
    lines.push(1 + strippedSource.slice(0, match.index).split("\n").length - 1);
    scanned += match[0];
  }
  void scanned;
  return lines.sort((left, right) => left - right);
}

test("G3-A 读轴对真源码：声明 read: not-source ⇒ 恢复侧不得有该键的快照读点", () => {
  const raw = readFileSync(join(ROOT, RESUME_FILE), "utf8");
  const stripped = stripCommentsAndStrings(raw);
  for (const row of tables.get("cn").rows) {
    if (readAxisHead(row.read) !== "not-source") continue;
    const found = snapshotReadLines(stripped, row.key);
    assert.deepEqual(
      found,
      [],
      `契约把 \`${row.key}\` 标成 read: not-source，但 ${RESUME_FILE} 第 ${found.join(", ")} 行仍在读快照那一格`,
    );
  }
});

test("G3-B 剥逻辑有效：反例（注释/字符串里的读点不算，代码里的算；正则字面量不被误剥）", () => {
  const snippet = [
    "const codeRead = snapshot.toolOutputs;",
    "// snapshot.messages in a line comment must not count",
    "/* snapshot.executedToolIds in a block comment",
    "   snapshot.executedToolIds on its continuation line */",
    "const inDouble = 'snapshot.status inside a string';",
    "const inSingle = \"snapshot.partialRound inside a string\";",
    "const inTemplate = `snapshot.round inside a template`;",
    "const anchored = /snapshot\\.pendingToolUses/u;",
    "const ENGINE_ONLY_KEY = /:engine:/u;",
    "const reRead = snapshot.compactionStats;",
  ].join("\n");
  const stripped = stripCommentsAndStrings(snippet);
  const counted = (key) => snapshotReadLines(stripped, key);
  // 代码里的读点必须算（否则整条 G3 是空转）
  assert.deepEqual(counted("toolOutputs"), [1]);
  assert.deepEqual(counted("compactionStats"), [10]);
  // 注释 / 字符串 / 模板 / 正则字面量里的都不算 ⇒ 这四项就是「排除逻辑有效」的反例
  assert.deepEqual(counted("messages"), [], "行注释里的读点被当成读点 = 排除逻辑失效");
  assert.deepEqual(counted("executedToolIds"), [], "块注释（含续行）里的读点被当成读点");
  assert.deepEqual(counted("status"), [], "双引号字符串里的读点被当成读点");
  assert.deepEqual(counted("partialRound"), [], "单引号字符串里的读点被当成读点");
  assert.deepEqual(counted("round"), [], "模板字面量里的读点被当成读点");
  assert.deepEqual(counted("pendingToolUses"), [], "正则字面量里的转义点号被当成读点");
  // 剥多了会把代码一起剥掉 ⇒ 在场断言：正则字面量与紧随其后的代码都还在
  assert.match(stripped, /ENGINE_ONLY_KEY\s*=\s*\/RE\/;/u, "剥逻辑把正则字面量后面的代码结构吃了");
  assert.match(stripped, /reRead\s*=\s*snapshot\.compactionStats;/u, "剥逻辑把真读点也吃了");
  assert.ok(stripped.includes("/:engine:/u") === false, "正则字面量应被归一化（否则下面两条在场断言是假的）");
  assert.match(stripped, /codeRead\s*=\s*snapshot\.toolOutputs;/u);
});

test("G3-C 真实文件上的反例：注释里那句 snapshot.messages 不算读点，代码里那句算", () => {
  const raw = readFileSync(join(ROOT, RESUME_FILE), "utf8");
  const rawLines = raw.split("\n");
  const stripped = stripCommentsAndStrings(raw);
  const strippedLines = stripped.split("\n");
  assert.equal(strippedLines.length, rawLines.length, "剥完必须保持行数一致，否则行号对不上原文");

  // 原文里注释里确实出现过 `snapshot.<key>`（不写死行号，避免一挪动就红）
  const commentRead = (line) => new RegExp(`${SNAPSHOT_OBJECTS}\\s*\\??\\s*\\.\\s*messages\\b`, "u").test(line);
  const commentLineNumbers = rawLines
    .map((line, index) => (commentRead(line) && /^\s*(?:\/\/|\*)/u.test(line) ? index + 1 : 0))
    .filter((number) => number > 0);
  const commentOnly = commentLineNumbers.map((number) => rawLines[number - 1]);
  assert.ok(commentOnly.length > 0, "原文必须仍带着那句注释里的 snapshot.messages（这条反例的前提）");
  const codeReads = snapshotReadLines(stripped, "messages");
  assert.ok(codeReads.length > 0, "代码里的 snapshot.messages 读点必须被找到（否则 not-source 判定是空转）");
  for (const lineNumber of commentLineNumbers) {
    assert.ok(
      !codeReads.includes(lineNumber),
      `第 ${lineNumber} 行是注释（${rawLines[lineNumber - 1].trim()}）却被算成读点`,
    );
    assert.ok(
      new RegExp(`${SNAPSHOT_OBJECTS}\\s*\\??\\s*\\.\\s*messages\\b`, "u").test(strippedLines[lineNumber - 1]) === false,
      `第 ${lineNumber} 行剥完仍带着 snapshot.messages ⇒ 注释没被剥掉`,
    );
  }

  // 反向对照：契约里被引为读点的行，剥完必须真的带着那次读点（读轴与源码互相对账）
  const cited = tables.get("cn").rows.filter((row) => row.readers.includes(RESUME_FILE));
  assert.ok(cited.length > 0);
});

/**
 * G4 的「那一行确实提到这格的键名」判据。那不只是本测试里的一个小函数：
 * `scripts/docs-drift-check.mjs` 对两轴载荷表那个标记区给的**定点豁免**（issue #772）绑的就是它的
 * **定义与调用**——定义被删、两个参数不再被用、或断言不再调它（退化成「行号存在就行」）
 * ⇒ 豁免自动失效，`npm run check:docs` 立即回红（登记见 docs/maintenance/command-reference.md#docs-anchors）。
 * 但它只是**词面**那一档（#772 R2 评审数出来的洞：`:3038` 与 `:3015` 都提到 `compactionStats`）——
 * 真正当基准的是下面那份锚点登记表。 */
const G4_KEY_NAME_CHECK = (lineText, key) => {
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_$])${key}(?:[^A-Za-z0-9_$]|$)`, "u");
  return mention.test(lineText);
};

// ── G4 锚点登记表（#772 R2 M1：从「词面匹配」改成「按锚点重算行号再等值对账」）───────────────
//
// 为什么词面不够：契约里 `compactionStats` 的写点写 `src/loop/orchestrator.js:3038`，那是
// `compactionStats: cloneState(compactionStats),`——**把这一格写进快照载荷的那一句**；而 `:3015` 是一句
// 讲「测试拿它当指纹」的**注释**，两行都提到键名，所词面匹配与「行号在范围内」都分不开它们。
// 于是每一格登记一条**能区分这件事的代码形状**（`anchor`），行号由锚点**现算**，表里写的 `path:line`
// 必须逐字符等于算出来的行号。
//
// 三条判据（都在 G4 里跑）：
//   ① 锚点在目标文件里必须**唯一命中**：0 次 = 锚点已失效，>1 次 = **锚点歧义**，两种都不配当基准；
//   ② 表里那一格该轴引用的行号集合必须与锚点重算的集合**等值**（换一条、多一条、少一条都红）；
//   ③ 写点/读者两列里每一条 `src/…` 与 `bin/…` 引用都必须有登记锚点，登记了的也必须还在表里
//      ⇒ 既没有「先随手写个行号」的口子，也没有「表里删了引用但锚点还躺着」的后门。
//
// 字段：`key` = 格名；`axis` = `write`（今天的写点；已停写的两格引的是「停写证据」那行注释）
// / `read`（恢复侧真读这一格那一句）；`path` = 目标文件；`anchor` = 正则字面（`u` 旗标）；
// `row` = 同一格名底下的第几行（`persistedTranscriptLength` 占两行，默认 0）；
// `prev` = 可选邻行判据（只靠本行无法消歧时用它，例：`round,` 要靠上一行的 `persist(` 才唯一）。
//
// 这段数组是**两份机器共用的**：`scripts/docs-drift-check.mjs` 的 `cellAxesGuardVerdict()` 会把
// 它原样抽出来自己再算一遍（标记区定点豁免的根据因此是「锚点等值对账」而不是词面）。所以：保持**数组
// 字面量**与这两行哨兵注释，改成函数/表达式/多行拼合都会让闸抽不到 ⇒ 豁免失效、`npm run check:docs` 回红。
/** 登记表本体在 `scripts/cell-axes-anchors.mjs`；这里只补一个 `path` 别名给下面那些判据用
 *  （R2 的字段名叫 `path`，R3 按工单口径改名 `codePath`，别名让既有的判据不必整体改写）。 */
const CELL_AXES_ANCHORS = CELL_AXES_ANCHORS_SHARED.map((entry) => ({ ...entry, path: entry.codePath }));

/**
 * 锚点在目标文件里命中的行号（1 基）。两条约束都是判据的一部分：`anchor` 那一行必须命中，
 * 带了 `prev` 的还要邻行也命中（只靠本行消不了歧的那些，例：`round,`）。命中 0 次或多次都交给
 * 调用方判红——歧义锚点不配当基准。同样被 `cellAxesGuardVerdict()` 抽名（它自己重算时走同一条形状）。 */
// 命中语义（anchor + 可选 prev 邻行）与闸**共用同一个函数**：两边算出的行号必须一模一样。
const G4_ANCHOR_LINE_CHECK = (fileLines, entry) => anchorHitLines(fileLines, entry).hits ?? [];
/** 表里写的行号集合与锚点重算的行号集合是否**等值**（多 / 少 / 换一条都是 false）。 */
const G4_ANCHOR_EQ_CHECK = (citedLines, anchorLines) => anchorLinesEqual(citedLines, anchorLines);
/** 文件按行取（带缓存）：G4 与它的三条反向证共用，避免各自再读一遍盘。 */
const G4_LINE_CACHE = new Map();
function G4_LINES_OF(rel) {
  if (!G4_LINE_CACHE.has(rel)) {
    assert.ok(existsSync(join(ROOT, rel)), `锚点/契约指向的文件不在场：${rel}`);
    G4_LINE_CACHE.set(rel, readFileSync(join(ROOT, rel), "utf8").split("\n"));
  }
  return G4_LINE_CACHE.get(rel);
}

/** 一格的第几行 + 哪个轴 + 哪个文件 ⇒ 一组引用的基准键。 */
const G4_GROUP_KEY = anchorGroupKey;

/**
 * 把锚点登记表算成「组键 → 行号集合」，并把**唯一命中**判据的破口作为错误返回（不抛，
 * 好让反向证拿合成数据问它）。命中 0 次 = 锚点已失效；>1 次 = **锚点歧义**——歧义锚点不配当基准。
 * @param {{key:string,axis:string,path:string,anchor:string,row?:number,prev?:string}[]} anchors
 */
function G4_ANCHOR_GROUPS(anchors, linesOf) {
  const groups = new Map();
  const errors = [];
  for (const entry of anchors) {
    const where = `\`${entry.key}\` 的 ${entry.axis} 锚点（${entry.path}${entry.anchor ? `，正则 ${entry.anchor}` : ""}）`;
    if (!CELL_KEYS.includes(entry.key) || (entry.axis !== "write" && entry.axis !== "read")
      || typeof entry.path !== "string" || typeof entry.anchor !== "string") {
      errors.push(`锚点条目形状不合法（key 必须是表里的格名、axis 只许 write/read、path/anchor 必须是字符串）：${where}`);
      continue;
    }
    let hits = [];
    try {
      hits = G4_ANCHOR_LINE_CHECK(linesOf(entry.path), entry);
    } catch (error) {
      errors.push(`锚点正则跑不起来（${where}）：${error.message}`);
      continue;
    }
    if (hits.length !== 1) {
      errors.push(hits.length === 0
        ? `锚点 0 命中：${where} 在那份文件里找不到任何一行 ⇒ 锚点已失效（代码形状变了就先改锚点，别顺手把表里的行号改成别的形状）`
        : `锚点歧义：${where} 命中 ${hits.length} 行（${hits.map((n) => `:${n}`).join(" ")}）⇒ 歧义锚点不配当基准，收紧到只剩那一行（必要时用 prev 邻行判据）`);
      continue;
    }
    const gk = G4_GROUP_KEY(entry.key, entry.axis, entry.row ?? 0, entry.path);
    // #772 R4 M-A：「种类」也是硬判据，而且走的是与闸**同一个** `anchorKindError()`（两边不许各写一份）。
    // 行号等值对账本身看不见「锚点指到一条只是提到键名的注释 + 两份表引文同步改口」那种形状。
    const kindError = anchorKindError(entry, linesOf(entry.path), hits[0]);
    if (kindError !== null) errors.push(kindError);
    groups.set(gk, new Set([...(groups.get(gk) ?? []), ...hits]));
  }
  return { groups, errors };
}

/**
 * 一份契约的「写点 / 读者」两列 ⇄ 锚点重算结果对账。返回错误文本数组（空 = 这一份过）。
 * 判据三条：① 每条 `src/…` 与 `bin/…` 引用都必须有登记锚点；② 那一格那一轴那一文件的行号集合
 * 必须与锚点**等值**（多 / 少 / 换一条都红，并打印「表写 :X / 锚点实际 :Y / 那一行原文」）；
 * ③ 登记了的锚点必须还在表里（表删引用而锚点躺着 = 后门）。
 */
function G4_SIDE_RECONCILE({ side, rows, groups, linesOf }) {
  const errors = [];
  const show = (rel, list) => [...list].sort((a, b) => a - b).map((n) => `${rel}:${n}`).join(" / ");
  const peek = (rel, list) => [...list].sort((a, b) => a - b)
    .map((n) => `:${n}| ${linesOf(rel)[n - 1].trim().slice(0, 140)}`).join("\n          ");
  const reconciled = new Set();
  const reconciledGroups = new Set();
  const perKey = new Map();
  for (const row of rows) {
    const rowIndex = perKey.get(row.key) ?? 0;
    perKey.set(row.key, rowIndex + 1);
    for (const [axis, cell] of [["write", row.writeSite], ["read", row.readers]]) {
      const citedByPath = new Map();
      for (const citation of cell.match(CITATION) ?? []) {
        const [rel, lineText] = citation.split(":");
        if (!/^src\//u.test(rel) && !/^bin\//u.test(rel)) continue;   // 测试侧指纹走词面 + 在场那一档
        citedByPath.set(rel, new Set([...(citedByPath.get(rel) ?? []), Number(lineText)]));
      }
      for (const [rel, cited] of citedByPath) {
        const gk = G4_GROUP_KEY(row.key, axis, rowIndex, rel);
        const anchorLines = groups.get(gk);
        if (anchorLines === undefined) {
          errors.push(`${side}：\`${row.key}\` 的 ${axis} 列引了 ${rel}，但这一格这一轴没有登记锚点 ⇒ 那条行号没有基准可对`
            + `（新增引用要同批在 CELL_AXES_ANCHORS 里登记能区分这件事的代码形状）：${cell}`);
          continue;
        }
        if (!G4_ANCHOR_EQ_CHECK([...cited], [...anchorLines])) {
          errors.push(`${side}：\`${row.key}\` 的 ${axis} 列与登记锚点不等值（${rel}）——`
            + `\n          表写：${show(rel, cited)}`
            + `\n          锚点实际：${show(rel, anchorLines)}`
            + `\n          表里那一行原文：\n          ${peek(rel, cited)}`);
          continue;
        }
        reconciled.add(`${side}|${row.key}`);
        reconciledGroups.add(`${side}|${gk}`);
      }
    }
  }
  for (const gk of groups.keys()) {
    const [key, axis, rowIndex, path] = gk.split("|");
    if (!reconciledGroups.has(`${side}|${gk}`)) {
      errors.push(`${side}：登记了 \`${key}\` 的 ${axis} 锚点（同名第 ${Number(rowIndex) + 1} 行，${path}），但表里那一格`
        + `那一轴已经不再引它 ⇒ 引用被删了而锚点还躺着（要么把引用补回来，要么同批删掉这条登记）`);
    }
  }
  return { errors, reconciled, reconciledGroups };
}

/**
 * 反向证的「干扰行」：同一个键名在**别的这件事**里也出现过的那一行（注释——讲测试拿它当指纹，
 * 不是把这一格写进载荷）。行号不写死，按形状现取；表里的引用被换成它时，词面判据照过、锚点判据必红。
 */
const G4_DISTRACTOR_PROBE = {
  key: "compactionStats",
  path: "src/loop/orchestrator.js",
  anchor: "^ +// - `compactionStats`：",
};

test("G4 表里每条 file:line 都复核：文件在场 + 行号在范围内 + 该行确实提到这格的键名 + 两轴引用必须等于登记锚点重算的行号", () => {
  let checked = 0;
  for (const { rows, side } of tables.values()) {
    for (const row of rows) {
      const rowText = [row.authority, row.handoff, row.writeSite, row.readers].join(" ");
      for (const citation of rowText.match(CITATION) ?? []) {
        const [rel, lineText] = citation.split(":");
        const lineNumber = Number(lineText);
        const fileLines = G4_LINES_OF(rel);
        assert.ok(
          Number.isSafeInteger(lineNumber) && lineNumber >= 1 && lineNumber <= fileLines.length,
          `${side}：\`${row.key}\` 引用 ${citation} 的行号越界（${rel} 只有 ${fileLines.length} 行）`,
        );
        const line = fileLines[lineNumber - 1];
        assert.ok(
          G4_KEY_NAME_CHECK(line, row.key),
          `${side}：\`${row.key}\` 引用 ${citation}，但那一行没提到这个键名：${line.trim()}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked >= CELL_KEYS.length * 2, `复核到的引用只有 ${checked} 条：表里的行号覆盖面在缩水`);

  // ── 锚点等值对账（#772 R2 M1）：行号由锚点现算，表里写的必须逐字符等于它 ─────────────
  const groupsSeen = new Set(CELL_AXES_ANCHORS.map(
    (entry) => G4_GROUP_KEY(entry.key, entry.axis, entry.row ?? 0, entry.path),
  ));
  assert.ok(
    CELL_AXES_ANCHORS.length >= CELL_AXES_ANCHOR_FLOORS.entries && groupsSeen.size >= CELL_AXES_ANCHOR_FLOORS.groups,
    `锚点登记表只剩 ${CELL_AXES_ANCHORS.length} 条 / ${groupsSeen.size} 组（建单时 39 条 / 27 组，地板读 scripts/cell-axes-anchors.mjs 的 CELL_AXES_ANCHOR_FLOORS）——登记表被削薄了`,
  );
  const { groups, errors: anchorErrors } = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF);
  assert.deepEqual(anchorErrors, [], "锚点登记表自己就不成立（唯一命中判据）");

  const reconciled = new Set();
  for (const { rows, side } of tables.values()) {
    const verdict = G4_SIDE_RECONCILE({ side, rows, groups, linesOf: G4_LINES_OF });
    assert.deepEqual(verdict.errors, [], `${side}：两轴引用与登记锚点的等值对账没过`);
    for (const entry of verdict.reconciled) reconciled.add(entry);
    for (const key of new Set(rows.map((row) => row.key))) {
      assert.ok(
        verdict.reconciled.has(`${side}|${key}`),
        `${side}：\`${key}\` 这一格没有进锚点对账（写点列与读者列里的 src/bin 引用一条也没被复算）`,
      );
    }
  }
  const keysSeen = new Set([...reconciled].map((entry) => entry.split("|")[1]));
  assert.ok(keysSeen.size >= CELL_KEYS.length, `锚点对账只覆盖 ${keysSeen.size} 个格名，不满 ${CELL_KEYS.length} 格`);
});

// ── G4 的三条反向证（#772 R2 M1：不是手工跑一次，是常驻用例）────────────────────────────
//
// 现场（主会话在 `cb463b0` 上复现过）：把 EN 表 `compactionStats` 的写点从 `:3038`（`compactionStats:
// cloneState(compactionStats),`）改成 `:3015`（一句讲「测试拿它当指纹」的**注释**）——裸行号棘轮与
// 旧的词面判据**都不认**这个错引。下面三例把这三步钉成用例：① 错引必红；② 歧义锚点必红并点名「歧义」；
// ③ 原样必须 0 错（第 ③ 步就是上面 G4 自己，这里再补一条「合成数据上把改动撤回即恢复绿」的直接证据）。

test("G4-R1 反向证：写点被换成「同一键名的注释行」⇒ 词面判据照过、锚点对账必红", () => {
  const path = G4_DISTRACTOR_PROBE.path;
  const probeLines = G4_LINES_OF(path).map((line, index) => ({ line, index }))
    .filter(({ line }) => new RegExp(G4_DISTRACTOR_PROBE.anchor, "u").test(line));
  assert.ok(probeLines.length === 1, `干扰行必须唯一，实际 ${probeLines.length} 行`);
  const distractor = probeLines[0].index + 1;
  const groups = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).groups;
  const anchorLines = [...groups.get(G4_GROUP_KEY(G4_DISTRACTOR_PROBE.key, "write", 0, path))];
  assert.ok(
    anchorLines.length > 0 && !anchorLines.includes(distractor),
    `基准行（${anchorLines.join(",")}）必须与干扰行（${distractor}）不是同一行，否则这组反向证是空转`,
  );
  // 词面判据在**错的那一行**上照样通过 ⇒ 这就是旧 G4 放行 :3015 的原因（评审数出来的洞）
  assert.ok(
    G4_KEY_NAME_CHECK(G4_LINES_OF(path)[distractor - 1], G4_DISTRACTOR_PROBE.key),
    "干扰行必须仍然提到键名（否则它测不出「词面判据是瞎的」这件事）",
  );
  assert.ok(
    G4_KEY_NAME_CHECK(G4_LINES_OF(path)[anchorLines[0] - 1], G4_DISTRACTOR_PROBE.key),
    "基准行也必须提到键名（否则两行不是同一形状）",
  );
  // ① 把 EN 与 CN 表里那一格的写点行号换成干扰行：两侧都必须红，且红话里点名「表写 / 锚点实际 / 那一行原文」
  for (const { rows, side } of tables.values()) {
    const mutated = rows.map((row) => {
      if (row.key !== G4_DISTRACTOR_PROBE.key || row.writeSite.includes(`${path}:${distractor}`)) return row;
      return {
        ...row,
        // 把这一格写点里的**全部**基准行号换成干扰行（那一格写点共两处：快照写点 + 轮记录写点）
        writeSite: anchorLines.reduce(
          (cell, n) => cell.replace(`${path}:${n}`, `${path}:${distractor}`),
          row.writeSite,
        ),
      };
    });
    assert.notDeepEqual(mutated, rows, `${side}：变异没落上（表里的写点形状变了，先看这里）`);
    const verdict = G4_SIDE_RECONCILE({ side, rows: mutated, groups, linesOf: G4_LINES_OF });
    assert.ok(
      verdict.errors.length > 0,
      `${side}：把写点换成注释行 ${path}:${distractor} 之后锚点对账仍然全绿 ⇒ 判据没咬住「这件事」`,
    );
    const hit = verdict.errors.filter((e) => e.includes(G4_DISTRACTOR_PROBE.key) && e.includes("不等值"));
    assert.ok(hit.length === 1, `必须恰好一条等值对账红，实际 ${hit.length} 条：${JSON.stringify(verdict.errors)}`);
    assert.match(hit[0], /表写/u);
    assert.match(hit[0], /锚点实际/u);
    assert.match(hit[0], /那一行原文/u);
    assert.ok(
      hit[0].includes(`${path}:${distractor}`) && anchorLines.every((n) => hit[0].includes(`${path}:${n}`)),
      `红话必须同时给出「表写 :${distractor}」与「锚点实际 :${anchorLines.join(" / :")}」：${hit[0]}`,
    );
    // ③ 恢复：把行号换回去 ⇒ 同一格同一轴 0 错
    const restored = G4_SIDE_RECONCILE({ side, rows, groups, linesOf: G4_LINES_OF });
    assert.deepEqual(restored.errors, [], `${side}：原样的表必须 0 错（恢复证）`);
  }
});

test("G4-R2 反向证：锚点被放宽到命中两行（歧义）⇒ 必红并点名「锚点歧义」", () => {
  const victim = CELL_AXES_ANCHORS.find(
    (entry) => entry.key === "toolOutputs" && entry.axis === "write" && entry.anchor.includes("cloneState"),
  );
  assert.ok(victim !== undefined, "反向证需要 toolOutputs 的快照写点锚点在场");
  const [unique] = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(victim.path), victim);
  const trimmed = G4_LINES_OF(victim.path)[unique - 1].trim();
  // 放宽到「只到第一个冒号」= 退化成旧 G4 那种键名词面：同一键名在别处也写过 ⇒ 命中多行
  const fragment = trimmed.slice(0, trimmed.indexOf(":") + 1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const loose = { ...victim, prev: undefined, anchor: `^ +${fragment}` };
  const looseHits = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(loose.path), loose);
  assert.ok(looseHits.length > 1, `键名前缀锚点本该命中多行（拿它证歧义），实际 ${looseHits.length} 行`);
  const mutated = CELL_AXES_ANCHORS.map((entry) => (entry === victim ? loose : entry));
  assert.notEqual(mutated, CELL_AXES_ANCHORS);
  const { errors } = G4_ANCHOR_GROUPS(mutated, G4_LINES_OF);
  assert.ok(errors.length > 0, "锚点命中两行却全绿 ⇒ 歧义锚点被当成了基准");
  assert.match(errors.join("\n"), /锚点歧义/u);
  assert.match(errors.join("\n"), /toolOutputs/u);
  // 恢复：原表 0 错
  assert.deepEqual(G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).errors, [], "原锚点表必须 0 错（恢复证）");
});

test("G4-R3 反向证：表里多一条没登记的引用 / 少一条已登记的引用 ⇒ 都必红", () => {
  const groups = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).groups;
  const base = G4_SIDE_RECONCILE({ side: "en", rows: tables.get("en").rows, groups, linesOf: G4_LINES_OF });
  assert.deepEqual(base.errors, [], "原表必须 0 错（本例两条判据的前提）");
  // ① 多一条没登记的引用（给 `round` 的读者列再引一处 `bin/final-guard-support.js`：形状合法、词面也过，
  //    但那一格那一轴在该文件上没有锚点 ⇒ 那条行号没有基准）
  const extra = tables.get("en").rows.map((r) => (r.key === "round"
    ? { ...r, readers: `${r.readers}、bin/final-guard-support.js:218` }
    : r));
  const extraVerdict = G4_SIDE_RECONCILE({ side: "en", rows: extra, groups, linesOf: G4_LINES_OF });
  assert.ok(extraVerdict.errors.length === 1, `只该多出一条红，实际：${JSON.stringify(extraVerdict.errors)}`);
  assert.ok(extraVerdict.errors.some((e) => e.includes("没有登记锚点")), JSON.stringify(extraVerdict.errors));
  // ② 少一条已登记的引用（把 round 写点那半句删掉 ⇒ 锚点躺着、表里没人引）
  const dropped = tables.get("en").rows.map((r) => (r.key === "round"
    ? { ...r, writeSite: "见 `persistRound`（`src/loop/orchestrator.js`）" }
    : r));
  const droppedVerdict = G4_SIDE_RECONCILE({ side: "en", rows: dropped, groups, linesOf: G4_LINES_OF });
  assert.ok(droppedVerdict.errors.some((e) => e.includes("已经不再引它")), JSON.stringify(droppedVerdict.errors));
});

test("G4-R4 反向证：锚点登记的「种类」是硬判据 ⇒ 代码锚点指到注释行必红，注释锚点指到代码行也必红（M-A）", () => {
  // 出厂表的种类事实：41 条全带合法 kind，且只有八条钉的是注释（#735 停写的两格「为什么没有写点」
  // + #770 停写的 `status` / `compactionStats` 两格 + `persistedTranscriptLength` 读侧那句「不能信快照里的它」）。
  // 种类写错 ⇒ 下面那条判据当场红。
  assert.ok(
    CELL_AXES_ANCHORS.length === CELL_AXES_REQUIRED_CELLS.length,
    `登记 ${CELL_AXES_ANCHORS.length} 条与人审清单 ${CELL_AXES_REQUIRED_CELLS.length} 格不同数 ⇒ 先对齐两份真值`,
  );
  const commentEntries = CELL_AXES_ANCHORS.filter((entry) => entry.kind === "comment");
  assert.deepEqual(
    commentEntries.map((entry) => `${entry.key}|${entry.axis}`).sort(),
    [
      "compactionStats|write",
      // issue #769：三格读轴的**账本来源**钉在 `src/store/recovery-rows.js` 的格名注释上（那里是行形状的定义处，
      // 没有「读这一格」的代码行可读；读轴的代码引用仍留在恢复侧真读点上，G6 那条判据据此仍然咬得住）。
      "executedToolIds|read",
      "partialRound|read",
      "partialText|read",
      "persistedTranscriptLength|read",
      "status|write",
      "toolUse|write",
      "ts|write",
    ],
    "注释锚点只许这五条；新增注释锚点必须同批改这里（种类是登记事实，不是机器猜出来的）",
  );
  assert.ok(
    CELL_AXES_ANCHORS.every((entry) => entry.kind === "code" || entry.kind === "comment"),
    "每条锚点都必须带 kind（code / comment），闸的 parseCellAxesAnchorTable() 也按这个把关",
  );
  // 原表：种类全部相符（与闸共用同一个 anchorKindError）
  assert.deepEqual(G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).errors, [], "原表的种类判据必须 0 错");

  // ① 评审 M-A 的变异本体：把 `compactionStats` 的快照写点锚点改成「只是提到键名的那句注释」，
  //    并把**两份表**里那一格写点的行号**同步改口**到那一行 ⇒ 行号等值对账全自洽（旧行为：两道闸都绿），
  //    现在必须被种类判据拦下，且红话里点名「哪一格哪一轴 + 命中行号 + 那一行原文」。
  const path = G4_DISTRACTOR_PROBE.path;
  const groups = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).groups;
  const snapshotAnchor = CELL_AXES_ANCHORS.find(
    (entry) => entry.key === G4_DISTRACTOR_PROBE.key && entry.axis === "write" && entry.path === path && entry.kind === "code",
  );
  assert.ok(snapshotAnchor !== undefined, "需要 compactionStats 的快照写点锚点（kind=code）在场");
  const [realWrite] = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(path), snapshotAnchor);
  const distractor = G4_LINES_OF(path)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => new RegExp(G4_DISTRACTOR_PROBE.anchor, "u").test(line));
  assert.ok(distractor.length === 1, `干扰行（注释行）必须唯一，实际 ${distractor.length} 行`);
  const commentLine = distractor[0].index + 1;
  assert.ok(anchorLineIsComment(G4_LINES_OF(path)[commentLine - 1]), "干扰行必须真的是注释行，否则本例空转");
  assert.notEqual(commentLine, realWrite, "干扰行与真写点必须不是同一行");

  const kindMutatedAnchors = CELL_AXES_ANCHORS.map((entry) => (
    entry === snapshotAnchor ? { ...entry, prev: undefined, anchor: G4_DISTRACTOR_PROBE.anchor } : entry
  ));
  const mutatedGroups = G4_ANCHOR_GROUPS(kindMutatedAnchors, G4_LINES_OF);
  const kindErrors = mutatedGroups.errors.filter((text) => text.includes("锚点种类不符"));
  assert.ok(kindErrors.length === 1, `必须恰好一条种类红，实际 ${kindErrors.length} 条：${JSON.stringify(mutatedGroups.errors)}`);
  assert.match(kindErrors[0], /compactionStats/u);
  assert.match(kindErrors[0], /write 轴/u);
  assert.match(kindErrors[0], new RegExp(`:${commentLine} 那一行`, "u"));
  assert.ok(kindErrors[0].includes(G4_LINES_OF(path)[commentLine - 1].trim().slice(0, 40)), "红话必须带上命中那一行的原文");

  // 关键一步：两份表的引文**同步改口**到那一行 ⇒ 等值对账这一侧全绿（= 评审说的「旧行为两道闸都绿」），
  // 于是「红」只能来自种类判据。
  for (const { rows, side } of tables.values()) {
    const synced = rows.map((row) => (row.key === G4_DISTRACTOR_PROBE.key
      ? { ...row, writeSite: row.writeSite.replace(`${path}:${realWrite}`, `${path}:${commentLine}`) } : row));
    assert.notDeepEqual(synced, rows, `${side}：同步改口没落上`);
    const eqOnly = G4_SIDE_RECONCILE({ side, rows: synced, groups: mutatedGroups.groups, linesOf: G4_LINES_OF });
    assert.deepEqual(eqOnly.errors, [], `${side}：引文同步改口后等值对账必须自洽（不然本例测不到「只有种类看得见」）`);
  }

  // ② 另一个方向：kind=comment 的锚点被换成真代码行 ⇒ 同样红
  const commentEntry = commentEntries.find((entry) => entry.key === "toolUse" && entry.axis === "write");
  assert.ok(commentEntry !== undefined, "需要 toolUse 的注释锚点（kind=comment）在场");
  const [stoppedCommentLine] = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(commentEntry.path), commentEntry);
  const flipped = CELL_AXES_ANCHORS.map((entry) => (entry === commentEntry
    // 拿同一文件里一条真代码行当锚点（写入位置那一形状），种类却没跟着改
    ? { ...entry, anchor: snapshotAnchor.anchor } : entry));
  const flipErrors = G4_ANCHOR_GROUPS(flipped, G4_LINES_OF).errors;
  assert.ok(flipErrors.some((text) => text.includes("锚点种类不符") && text.includes("kind=comment")),
    JSON.stringify(flipErrors));
  assert.ok(stoppedCommentLine !== undefined, "注释锚点必须唯一命中（本例前提）");

  // ③ 恢复证：原表 0 错
  assert.deepEqual(G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).errors, [], "原锚点表必须 0 错（恢复证）");
});

test("G4-R5 反向证：成对删掉登记条目与两份表里的对应引用 ⇒ 覆盖面真值必红并点名缺哪一格在哪一份（M-B）", () => {
  const refsOf = ({ side, rows }) => {
    const out = new Map();
    const perKey = new Map();
    for (const row of rows) {
      const rowIndex = perKey.get(row.key) ?? 0;
      perKey.set(row.key, rowIndex + 1);
      for (const [axis, cell] of [["write", row.writeSite], ["read", row.readers]]) {
        for (const citation of cell.match(CITATION) ?? []) {
          const [rel, lineText] = citation.split(":");
          if (!/^src\//u.test(rel) && !/^bin\//u.test(rel)) continue;
          const gk = G4_GROUP_KEY(row.key, axis, rowIndex, rel);
          out.set(gk, new Set([...(out.get(gk) ?? []), Number(lineText)]));
        }
      }
    }
    return { side, doc: `contract-snapshot-cell-axes(${side})`, refs: out };
  };
  const refsByDoc = [...tables.values()].map(({ rows, side }) => refsOf({ side, rows }));

  // ① 正向：出厂的登记 + 两份表必须把 39 格全覆盖（issue #769 现算仍是 39 条 / 27 组：三格的读轴换了来源，条目数没涨）（清单 → 登记 → EN → CN 四处）
  const clean = checkCellAxesCoverage({ anchors: CELL_AXES_ANCHORS, refsByDoc });
  assert.deepEqual(clean.errors, [], JSON.stringify(clean.errors));
  assert.equal(clean.slots, new Set(CELL_AXES_REQUIRED_CELLS.map((cell) => cellAxesRequiredSlotKey(cell))).size,
    "清单去重后的槽位数必须与判据报出的一致");
  // 地板是由清单算出来的，不是手填数（#772 R4 M-B）
  assert.equal(CELL_AXES_ANCHOR_FLOORS.entries, CELL_AXES_REQUIRED_CELLS.length,
    "entries 地板必须是清单条数算出来的（手填数会留出削薄余量）");
  assert.equal(CELL_AXES_ANCHOR_FLOORS.groups,
    new Set(CELL_AXES_REQUIRED_CELLS.map((cell) => `${cell.key}|${cell.axis}`)).size,
    "groups 地板必须是清单里 key|axis 去重数算出来的");

  // ② 评审 M-B 的变异：从 8 个双锚点组各删一条登记，并同步删掉两表对应引用 ⇒ 剩下的全自洽
  const victims = [
    { key: "toolOutputs", axis: "write", path: "src/loop/orchestrator.js", at: 6265 },
    { key: "compactionStats", axis: "write", path: "src/loop/orchestrator.js", at: 6245 },
    { key: "pendingToolUses", axis: "read", path: "src/loop/resume-manager.js", at: 748 },
    { key: "pendingToolUse", axis: "read", path: "src/loop/resume-manager.js", at: 749 },
    { key: "executedToolIds", axis: "read", path: "src/loop/resume-manager.js", at: 706 },
    { key: "toolResults", axis: "read", path: "src/loop/resume-manager.js", at: 710 },
    { key: "persistedTranscriptLength", axis: "read", path: "src/loop/resume-manager.js", at: 23 },
    { key: "partialText", axis: "read", path: "src/loop/resume-manager.js", at: 677 },
  ];
  const droppedKeys = new Set();
  const mutatedAnchors = [...CELL_AXES_ANCHORS];
  const mutatedRows = new Map([...tables.values()].map(({ side, rows }) => [side, rows.map((row) => ({ ...row }))]));
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  for (const victim of victims) {
    const index = mutatedAnchors.findIndex((entry) => entry.key === victim.key && entry.axis === victim.axis
      && entry.path === victim.path && G4_ANCHOR_LINE_CHECK(G4_LINES_OF(entry.path), entry).includes(victim.at));
    assert.ok(index >= 0, `需要 \`${victim.key}\` 的 ${victim.axis} 锚点（命中 ${victim.path}:${victim.at}）在场才能删`);
    const [removedEntry] = mutatedAnchors.splice(index, 1);
    droppedKeys.add(G4_GROUP_KEY(removedEntry.key, removedEntry.axis, removedEntry.row ?? 0, removedEntry.path));
    // 同步从两份表的对应单元格里抹掉这一条 `path:line`（连它旁边的分隔符一起吃掉）
    const field = removedEntry.axis === "write" ? "writeSite" : "readers";
    const citation = `${victim.path}:${victim.at}`;
    for (const [side, rows] of mutatedRows) {
      let removed = 0;
      for (const row of rows) {
        if (row.key !== removedEntry.key || !row[field].includes(citation)) continue;
        row[field] = row[field].replace(new RegExp(`\\s*[,、；]?\\s*\`?${quote(citation)}\`?\\s*[,、；]?\\s*`, "u"), " ").trim();
        removed += 1;
      }
      assert.equal(removed, 1, `${side}：${citation} 应当只在一条单元格里出现一次（变异没落上）`);
      assert.ok(!rows.some((row) => row[field].includes(citation)), `${side}：${citation} 没被删干净`);
    }
  }
  assert.equal(mutatedAnchors.length, CELL_AXES_ANCHORS.length - 8, "变异应当只删 8 条登记");
  const mutatedGroups = G4_ANCHOR_GROUPS(mutatedAnchors, G4_LINES_OF);
  assert.deepEqual(mutatedGroups.errors, [], "剩下的那些锚点必须各自仍成立（变异是削薄，不是打坏）");
  for (const [side, rows] of mutatedRows) {
    const still = G4_SIDE_RECONCILE({ side, rows, groups: mutatedGroups.groups, linesOf: G4_LINES_OF });
    assert.deepEqual(still.errors, [], `${side}：成对删除后「剩下的自洽」必须成立（这正是旧判据看不见削薄的原因）`);
  }
  // 但覆盖面真值看得见：登记那一侧 + EN + CN 每一处都要报出缺的那一格
  const after = checkCellAxesCoverage({ anchors: mutatedAnchors, refsByDoc: [...mutatedRows.entries()].map(([side, rows]) => refsOf({ side, rows })) });
  assert.ok(after.errors.length > 0, "成对删掉 8 格之后覆盖面判据仍然全绿 ⇒ M-B 没关掉");
  assert.ok(after.errors.some((text) => text.includes("CELL_AXES_REQUIRED_CELLS")), JSON.stringify(after.errors.slice(0, 3)));
  for (const gk of droppedKeys) {
    const [key] = gk.split("|");
    assert.ok(after.errors.some((text) => text.includes(`\`${key}\``)), `红话必须点名缺的格子 \`${key}\`：${JSON.stringify(after.errors.slice(0, 3))}`);
  }
  assert.ok(
    after.errors.some((text) => text.includes("en 表")) && after.errors.some((text) => text.includes("cn 表")),
    "红话必须点名缺在哪一份（EN / CN）");
  // 地板也不再是手填数：削到 31 条必须低于由清单算出的 39
  assert.ok(mutatedAnchors.length < CELL_AXES_ANCHOR_FLOORS.entries,
    `削到 ${mutatedAnchors.length} 条必须低于地板 ${CELL_AXES_ANCHOR_FLOORS.entries}（地板由清单算出）`);
  // ③ 恢复证
  assert.deepEqual(checkCellAxesCoverage({ anchors: CELL_AXES_ANCHORS, refsByDoc }).errors, [], "原样必须 0 错（恢复证）");
  // 削薄是「无声」的那一种：格名与组数看起来一个没少（评审量出来的 31 条 / 27 组 / 14 格），
  // 只有条目数与两份表的引用条数透露了它 ⇒ 拿组数当哨兵不够，要拿人审清单逐格问。
  const before = anchorTableShape(CELL_AXES_ANCHORS);
  const afterShape = anchorTableShape(mutatedAnchors);
  assert.equal(afterShape.entries, before.entries - 8, `应剩 ${before.entries - 8} 条，实际 ${afterShape.entries}`);
  assert.equal(afterShape.groups, before.groups, "组数不该变（无声削薄的典型形状）");
  assert.equal(afterShape.cells, before.cells, "格名数不该变（无声削薄的典型形状）");
});

test("G4-R6 特征用例（已知限度，见 command-reference）：锚点改成「同一键名的另一处真写入」+ 两份引文同步改口 ⇒ 现在不红", () => {
  // 这条不是「修好了」，是把当前的**宽容**钉成契约：机器能证「这一行存在、唯一命中、种类相符、
  // 两份表与它等值、格子没被削薄」，证不了「这一行讲的是不是这一格这件事」。
  // 已知限度登记在 docs/maintenance/command-reference.md（#772 R4）；不要再加启发式去堵它。
  const path = "src/loop/orchestrator.js";
  const snapshotAnchor = CELL_AXES_ANCHORS.find(
    (entry) => entry.key === "compactionStats" && entry.axis === "write" && entry.path === path && entry.kind === "comment",
  );
  // #770 之后这一轴有两条登记：注释（解释快照为什么没有写点）与轮记录的真写点。取「命中唯一且是真代码行」那一条。
  const roundAnchor = CELL_AXES_ANCHORS.find(
    (entry) => entry.key === "compactionStats" && entry.axis === "write" && entry.path === path && entry !== snapshotAnchor
      && G4_ANCHOR_LINE_CHECK(G4_LINES_OF(path), entry).length === 1
      && !anchorLineIsComment(G4_LINES_OF(path)[G4_ANCHOR_LINE_CHECK(G4_LINES_OF(path), entry)[0] - 1]),
  );
  assert.ok(snapshotAnchor !== undefined && roundAnchor !== undefined, "需要 compactionStats 的两条写点锚点在场");
  const [snapshotLine] = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(path), snapshotAnchor);
  const [roundLine] = G4_ANCHOR_LINE_CHECK(G4_LINES_OF(path), roundAnchor);
  assert.notEqual(snapshotLine, roundLine, "停写解释注释与轮记录真写点必须是不同行，否则本例空转（#770 之后快照那一格是注释锚点）");
  assert.ok(!anchorLineIsComment(G4_LINES_OF(path)[roundLine - 1]), "轮记录那一处必须是真代码行（kind 仍相符）");

  const swapped = CELL_AXES_ANCHORS.map((entry) => (
    entry === snapshotAnchor ? { ...entry, anchor: roundAnchor.anchor, kind: roundAnchor.kind } : entry));
  const { groups, errors } = G4_ANCHOR_GROUPS(swapped, G4_LINES_OF);
  // #770 之后快照那一格是 comment 锚点：这一形要的是「换成另一处真写入」，所以种类也得跟着换成 code，
  // 否则机器当场就能认出（那是新增的严格面，不是本例要钉的宽容）。
  assert.deepEqual(errors, [], "种类/唯一命中在这一形上仍然成立（前提）");
  for (const { rows, side } of tables.values()) {
    const synced = rows.map((row) => (row.key === "compactionStats"
      ? { ...row, writeSite: row.writeSite.replace(`${path}:${snapshotLine}`, `${path}:${roundLine}`) } : row));
    const verdict = G4_SIDE_RECONCILE({ side, rows: synced, groups, linesOf: G4_LINES_OF });
    assert.deepEqual(verdict.errors, [], `${side}：这个已知限度形状现在必须**不红**（钉成契约；若哪天改判据让它红，记得同步改这条用例与文档）`);
  }
});

test("G6 表里被引为读点的恢复侧行号，必须是剥完源码里真存在的读点（读轴与源码互相对账）", () => {
  const raw = readFileSync(join(ROOT, RESUME_FILE), "utf8");
  const stripped = stripCommentsAndStrings(raw);
  let verified = 0;
  for (const row of tables.get("cn").rows) {
    const head = readAxisHead(row.read);
    const cited = [...row.readers.matchAll(new RegExp(`${RESUME_FILE}:(\\d+)`, "gu"))]
      .map((match) => Number(match[1]));
    const found = snapshotReadLines(stripped, row.key);
    if (head === "not-source") {
      // not-source 行也可以引恢复侧的行号，但那些行只能是「不信它 / 现算覆盖」的证据，不是读点。
      for (const lineNumber of cited) {
        assert.ok(
          !found.includes(lineNumber),
          `\`${row.key}\` 标的是 read: not-source，读者列引的 ${RESUME_FILE}:${lineNumber} 却是真读点（真读点在：${found.join(", ") || "无"}）`,
        );
      }
      continue;
    }
    assert.ok(
      [...row.readers.matchAll(CITATION)].length > 0,
      `\`${row.key}\` 的 read=${row.read}，读者列却一条行号都没引`,
    );
    for (const lineNumber of cited) {
      assert.ok(
        found.includes(lineNumber),
        `\`${row.key}\` 读者列引 ${RESUME_FILE}:${lineNumber}，但剥完的源码里那行不是快照读点（实found：${found.join(", ") || "无"}）`,
      );
      verified += 1;
    }
  }
  assert.ok(verified >= 5, `恢复侧读点对账只跑了 ${verified} 条，覆盖面不足以证伪`);
});
