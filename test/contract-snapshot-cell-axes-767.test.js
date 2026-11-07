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
  return { block, rows };
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
 * ⇒ 豁免自动失效，`npm run check:docs` 立即回红（登记见 docs/maintenance/command-reference.md#docs-anchors）。 */
const G4_KEY_NAME_CHECK = (lineText, key) => {
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_$])${key}(?:[^A-Za-z0-9_$]|$)`, "u");
  return mention.test(lineText);
};

test("G4 表里每条 file:line 都复核：文件在场 + 行号在范围内 + 该行确实提到这格的键名", () => {
  const lineCache = new Map();
  const linesOf = (rel) => {
    if (!lineCache.has(rel)) {
      assert.ok(existsSync(join(ROOT, rel)), `契约引用的文件不在场：${rel}`);
      lineCache.set(rel, readFileSync(join(ROOT, rel), "utf8").split("\n"));
    }
    return lineCache.get(rel);
  };
  let checked = 0;
  for (const { rows, side } of tables.values()) {
    for (const row of rows) {
      const rowText = [row.authority, row.handoff, row.writeSite, row.readers].join(" ");
      for (const citation of rowText.match(CITATION) ?? []) {
        const [rel, lineText] = citation.split(":");
        const lineNumber = Number(lineText);
        const fileLines = linesOf(rel);
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
