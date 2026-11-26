// issue #767 切片 S1 · B 组：**契约载荷表与代码之间的证伪连接**。
//
// Run snapshots are retired. This file keeps the remaining four historical cells honest:
//   1) the EN/CN tables contain exactly those four cells and mark every write axis stopped;
//   2) the resume path has no snapshot-property reads for them;
//   3) live citations match a unique registered anchor; retired test evidence has an explicit marker.
// The shared anchor registry is also consumed by `docs-drift-check`, so contract drift fails both
// the test suite and the documentation gate.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// issue #772 R3：两轴载荷表的锚点登记表住在 `scripts/cell-axes-anchors.mjs`，**闸与这份测试 import 同一份**
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

/** 契约两轴表保留的四个格名。 */
const CELL_KEYS = [
  "status",
  "compactionStats",
  "toolUse",
  "ts",
];
const WRITE_VOCAB = new Set(["written", "written(conditional)", "residue", "stopped"]);
const CONDITIONAL_WRITE = "written(conditional)";
const SPLIT_ROWS = {};

/** 读轴：`source` / `not-source` / `fallback(条件)`；只取头一段做中英比对（括号里的条件按语言写）。 */
function readAxisHead(value) {
  if (value === "source" || value === "not-source") return value;
  const fallback = /^fallback\([^()]*\)$/u.exec(value);
  return fallback === null ? null : "fallback";
}

/** 表内一个 payload 键名。 */
function parseKey(cell) {
  const match = /^\s*`([A-Za-z][A-Za-z0-9]*)`\s*(?:[（(][^|]*[)）])?\s*$/u.exec(cell);
  return match === null ? null : match[1];
}

/** 表内出现的 `file:line` 引用（只认仓库内路径，避免把 `40a518d` / `0.31.0` 当成引用）。 */
const CITATION = /(?:src|bin|test|docs|examples|scripts)\/[A-Za-z0-9_./-]+\.(?:js|mjs|md):[0-9]+/gu;
const RETIRED_CELL_EVIDENCE = new Map([
  ["test/loop-snapshot-write-side-735.test.js", "// 载体已退役（#838 S2），本格随之退役。"],
]);

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

test("G1 载荷表自洽：四格齐全、两轴取值合法、无空值", () => {
  for (const { side, rows } of tables.values()) {
    const counts = new Map();
    for (const row of rows) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    }
    assert.deepEqual(
      [...counts.keys()].sort(),
      [...CELL_KEYS].sort(),
      `${side}：表里的格名集合必须**恰好**是这四个（漏一格 = 集合缺项，多一格 = 多项）`,
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
    "中英两份的格序列必须逐位相同",
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

// ── G2 写轴：保留格只能声明停写 ────────────────────────────────────────────────

test("G2 写轴：保留在表里的 run-snapshot 格都已停写", () => {
  const rows = tables.get("cn").rows;
  assert.ok(rows.every((row) => row.write === "stopped"),
    "run snapshot 退役后，剩余格也不得声明有写入");
  assert.equal(rows.filter((row) => row.write === CONDITIONAL_WRITE).length, 0,
    "不得重新登记条件快照写入");
});

test("G2c 已退役的半截正文格不在契约表中", () => {
  const keys = tables.get("cn").rows
    .filter((row) => row.write === CONDITIONAL_WRITE)
    .map((row) => row.key);
  assert.deepEqual(keys, [], "条件写入格应当为空（半截正文只落账本恢复行）");
  assert.ok(!tables.get("cn").rows.some((row) => ["partialText", "partialRound"].includes(row.key)),
    "已从契约载荷表移除的半截正文格不应重新登记");
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

test("G3-C 真实文件上的反例：恢复侧不再保留任何 run-snapshot 读点", () => {
  const raw = readFileSync(join(ROOT, RESUME_FILE), "utf8");
  const rawLines = raw.split("\n");
  const stripped = stripCommentsAndStrings(raw);
  const strippedLines = stripped.split("\n");
  assert.equal(strippedLines.length, rawLines.length, "剥完必须保持行数一致，否则行号对不上原文");
  for (const key of CELL_KEYS) {
    assert.deepEqual(snapshotReadLines(stripped, key), [], `恢复侧仍读取已退役的 snapshot.${key}`);
  }
});
/**
 * 「命中那一行确实提到这格的键名」判据（#917：这是替代「行号等值」的真相之一，闸与测试共用同一条口径）。
 */
const G4_KEY_NAME_CHECK = (lineText, key) => {
  const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u");
  return pattern.test(lineText);
};

// ── G4 锚点真相校（#917：撤「行号等值对账」，改成三条）─────────────────────────────
//   ① 每条登记锚点在**它自己声明的 codePath** 里恰好命中一行（0 / 多次都红，歧义锚点不配当基准）；
//   ② 命中那一行必须提到该 `key`，且种类相符（`code`/`comment`，与闸共用 `anchorKindError()`）；
//   ③ 两份契约表里那一格点名的 `src/bin` **文件**必须等于登记的 `codePath`（指错文件 ⇒ 红并点名两边）。
// 反向证全部吃**合成行 / 合成 row**（#917 评审口径），不去改真实 `src/`：行号已经不再是判据，
// 所以「在锚点命中行上方插一行普通注释」这种纯位移**必须仍判绿**——这正是本单的靶心。
const G4_GROUP_KEY = anchorGroupKey;
/** 契约两轴列点名的仓内**文件**（#917：只认 `src/` `bin/`，不带也不看行号）。 */
const SIDE_FILE_REF = /(?:src|bin)\/[A-Za-z0-9_./-]+\.js/gu;
/** 登记条目带上 `path` 别名（= `codePath`），与闸读的是同一份登记表。 */
const CELL_AXES_ANCHORS = CELL_AXES_ANCHORS_SHARED.map((entry) => ({ ...entry, path: entry.codePath }));

const G4_LINE_CACHE = new Map();
function G4_LINES_OF(rel) {
  if (!G4_LINE_CACHE.has(rel)) {
    G4_LINE_CACHE.set(rel, existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8").split("\n") : null);
  }
  return G4_LINE_CACHE.get(rel);
}

/** 判据 ①+②（锚点唯一命中 + 种类相符 + 命中行提到键）——纯函数，反向证也复用它。 */
function G4_ANCHOR_GROUPS(anchors, linesOf) {
  const groups = new Map();
  const errors = [];
  for (const entry of anchors) {
    const gk = G4_GROUP_KEY(entry.key, entry.axis, entry.row ?? 0, entry.path);
    const fileLines = linesOf(entry.path);
    if (fileLines === null || fileLines === undefined) { errors.push(`登记表把 \`${entry.key}\` 的 ${entry.axis} 锚点指向不在场的文件 ${entry.path}`); continue; }
    const { hits, error } = anchorHitLines(fileLines, entry);
    if (error) { errors.push(`\`${entry.key}\` 的 ${entry.axis} 锚点正则跑不通：${error}`); continue; }
    if (hits.length !== 1) {
      errors.push(hits.length === 0
        ? `\`${entry.key}\` 的 ${entry.axis} 锚点 0 命中（正则 ${entry.anchor}）⇒ 锚点已失效`
        : `\`${entry.key}\` 的 ${entry.axis} 锚点歧义（正则 ${entry.anchor}）命中 ${hits.length} 行 ⇒ 歧义锚点不配当基准`);
      continue;
    }
    groups.set(gk, new Set([...(groups.get(gk) ?? []), hits[0]]));
    const kindError = anchorKindError(entry, fileLines, hits[0]);
    if (kindError !== null) { errors.push(kindError); continue; }
    if (!G4_KEY_NAME_CHECK(fileLines[hits[0] - 1], entry.key)) {
      errors.push(`\`${entry.key}\` 的 ${entry.axis} 锚点命中 ${entry.path}:${hits[0]}，但那一行没提到键名 \`${entry.key}\``
        + `（#917 真相校：锚点不许指到不含这格键名的行上）：${fileLines[hits[0] - 1].trim().slice(0, 90)}`);
    }
  }
  return { groups, errors };
}

/** 判据 ③：文档那一格点名的 src/bin 文件必须== 登记 codePath（正反两面）。 */
function G4_SIDE_RECONCILE({ side, rows, groups }) {
  const errors = [];
  const reconciled = new Set();
  const namedByCell = new Map();
  const perKey = new Map();
  for (const row of rows) {
    const rowIndex = perKey.get(row.key) ?? 0;
    perKey.set(row.key, rowIndex + 1);
    for (const [axis, cell] of [["write", row.writeSite], ["read", row.readers]]) {
      SIDE_FILE_REF.lastIndex = 0;
      const named = [...new Set(cell.match(SIDE_FILE_REF) ?? [])];
      namedByCell.set(`${row.key}|${axis}|${rowIndex}`, named);
      for (const rel of named) {
        const gk = G4_GROUP_KEY(row.key, axis, rowIndex, rel);
        if (groups.has(gk)) reconciled.add(gk);
        else errors.push(`${side}：\`${row.key}\` 的 ${axis} 轴（同名第 ${rowIndex + 1} 行）点名了 ${rel}，`
          + `但 \`${CELL_AXES_ANCHOR_MODULE}\` 里没有以它为 codePath 的登记锚点（#917 真相校：文档点名的文件对不上登记）`);
      }
    }
  }
  for (const gk of groups.keys()) {
    if (reconciled.has(gk)) continue;
    const [key, axis, rowIndex, path] = gk.split("|");
    const named = namedByCell.get(`${key}|${axis}|${rowIndex}`) ?? [];
    errors.push(`${side}：登记了 \`${key}\` 的 ${axis} 锚点（codePath ${path}），但表里那一格点名的是`
      + ` ${named.length > 0 ? named.join(" / ") : "（没点名任何 src/bin 文件）"}，没点到 ${path}`
      + `（#917 真相校：文档那一格不再指向登记 codePath）`);
  }
  return { errors, reconciled };
}

test("G4 真相校（#917）：锚点唯一命中 + 命中行提到键 + 文档那格点名的文件 == 登记 codePath", () => {
  const { groups, errors: anchorErrors } = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF);
  assert.deepEqual(anchorErrors, [], `锚点判据（唯一命中 / 种类 / 提到键）不合格：\n  ${anchorErrors.join("\n  ")}`);
  for (const [side, table] of tables) {
    const verdict = G4_SIDE_RECONCILE({ side, rows: table.rows, groups });
    assert.deepEqual(verdict.errors, [], `${side}：两轴表的 fileMatch 真相校不合格：\n  ${verdict.errors.join("\n  ")}`);
  }
});

// ── G4 的长期反向证（#917：四格，全部吃合成输入，变异没落上算失败）──────────────────────

test("G4-R1 反向证：锚点在 codePath 里命中 2 次（歧义）⇒ 必红并点名「锚点歧义」", () => {
  const victim = CELL_AXES_ANCHORS.find((e) => e.kind === "code" && !/\\s\\S\*/u.test(e.anchor));
  assert.ok(victim !== undefined, "必须能挑到一个能放宽的代码锚点，否则本例空转");
  const before = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF);
  const [unique] = [...before.groups.get(G4_GROUP_KEY(victim.key, victim.axis, victim.row ?? 0, victim.path))];
  const loosened = CELL_AXES_ANCHORS.map((e) => e === victim ? { ...e, anchor: "^.*$" } : e);
  const { errors } = G4_ANCHOR_GROUPS(loosened, G4_LINES_OF);
  const hit = errors.find((e) => e.includes(victim.key) && e.includes("锚点歧义"));
  assert.ok(hit !== undefined, `放宽到命中整文件应判「锚点歧义」并点名 \`${victim.key}\`，实际：\n  ${errors.join("\n  ")}`);
  assert.ok(/命中 \d+ 行/u.test(hit), `必须真数到多于一行（${hit}）`);
  assert.deepEqual(G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF).errors, [], "原锚点表必须 0 错（恢复证）");
  void unique;
});

test("G4-R2 反向证：锚点命中那行不提这格的键名 ⇒ 必红并点名两边", () => {
  // 合成行：一行不含 victim.key 的代码，却用一条恰好命中它的锚点 —— 命中唯一、种类像代码，但没提键名。
  const synthKey = "ghostPayloadKey";
  const synthPath = "src/loop/orchestrator.js";
  const synthLines = [
    "  // 一行普通注释锚点行（呰不提那个键名）",
    "  const unrelated = computeThing();",
  ];
  const synthAnchor = { key: synthKey, axis: "write", row: 0, codePath: synthPath, path: synthPath, kind: "comment", anchor: "^ {2}// 一行普通注释锚点行（呰不提那个键名）$" };
  const { groups, errors } = G4_ANCHOR_GROUPS([synthAnchor], () => synthLines);
  assert.equal(groups.size, 1, "合成锚点必须唯一命中（否则变异没落在这条判据上）");
  const hit = errors.find((e) => e.includes(synthKey) && e.includes("没提到键名"));
  assert.ok(hit !== undefined, `命中行不提键名必须判红并点名 \`${synthKey}\`，实际：\n  ${errors.join("\n  ")}`);
});

test("G4-R3 反向证：文档那一格把文件写错（resume-manager.js 写成 orchestrator.js）⇒ 必红并点名两边", () => {
  const { groups } = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, G4_LINES_OF);
  // 找一个原本点名 src/loop/resume-manager.js 的读格，把它换成 orchestrator.js（登记 codePath 是 resume-manager.js）。
  let target = null;
  const perKey = new Map();
  for (const row of tables.get("cn").rows) {
    const rowIndex = perKey.get(row.key) ?? 0;
    perKey.set(row.key, rowIndex + 1);
    const gk = G4_GROUP_KEY(row.key, "read", rowIndex, "src/loop/resume-manager.js");
    if (groups.has(gk) && row.readers.includes("src/loop/resume-manager.js")) { target = { rowIndex, row }; break; }
  }
  assert.ok(target !== null, "必须能找到一格原本点名 resume-manager.js 且登记锚点以它为 codePath，否则本例空转");
  const mutated = tables.get("cn").rows.map((row) =>
    row === target.row ? { ...row, readers: row.readers.replace(/src\/loop\/resume-manager\.js/gu, "src/loop/orchestrator.js") } : row);
  const verdict = G4_SIDE_RECONCILE({ side: "cn", rows: mutated, groups });
  const forward = verdict.errors.find((e) => e.includes(target.row.key) && e.includes("src/loop/orchestrator.js") && e.includes("没有以它为 codePath"));
  const back = verdict.errors.find((e) => e.includes(target.row.key) && e.includes("src/loop/resume-manager.js") && e.includes("没点到"));
  assert.ok(forward !== undefined, `文档点名的错文件必须判红并点名它，实际：\n  ${verdict.errors.join("\n  ")}`);
  assert.ok(back !== undefined, `登记的 codePath 没被点名也要判红并点名它，实际：\n  ${verdict.errors.join("\n  ")}`);
});

test("G4-R4 靶心：在锚点命中行上方插入一行普通注释（纯行号位移）⇒ 判定必须仍然全绿", () => {
  // 挑一个真实代码锚点，把它命中的那一行往下挪一行（在上方塞一行普通注释）。
  // #917 撤了「文档抄件 == 锚点行号」之后，行号不再是判据，纯位移不许让判定变红。
  const target = CELL_AXES_ANCHORS.find((e) => e.kind === "code");
  assert.ok(target !== undefined, "必须能挑到一个代码锚点，否则本例空转");
  const realLines = G4_LINES_OF(target.path);
  const { hits } = anchorHitLines(realLines, target);
  assert.equal(hits.length, 1, `靶心前置：真实锚点必须唯一命中，实际 ${hits.length}`);
  const at = hits[0] - 1;
  // 合成位移：命中行之前插一行**不匹配该锚点**的普通注释 ⇒ 锚点仍唯一命中，只是行号 +1。
  const shifted = [...realLines.slice(0, at), "  // 靶心：这只是一行普通注释，行号位移探针（#917）。", ...realLines.slice(at)];
  const linesOf = (rel) => (rel === target.path ? shifted : G4_LINES_OF(rel));
  const { groups, errors } = G4_ANCHOR_GROUPS(CELL_AXES_ANCHORS, linesOf);
  assert.deepEqual(errors, [], `插一行普通注释后锚点判据必须仍全绿（证明行号不再被比对），实际：\n  ${errors.join("\n  ")}`);
  assert.ok(groups.size > 0, "锚点组必须仍在场（否则变异没落上）");
  for (const [side, table] of tables) {
    const verdict = G4_SIDE_RECONCILE({ side, rows: table.rows, groups });
    assert.deepEqual(verdict.errors, [], `插注释后 ${side} 的 fileMatch 真相校也必须仍全绿：\n  ${verdict.errors.join("\n  ")}`);
  }
});

test("G4-R5 反向证：成对删掉某格的登记锚点与两份表里的对应点名 ⇒ 覆盖面真值必红并点名缺哪一格", () => {
  const victim = CELL_AXES_ANCHORS.find((e) => e.key === "ts" && e.axis === "write");
  assert.ok(victim !== undefined, "必须能挑到 ts 写锚点，否则本例空转");
  const anchors = CELL_AXES_ANCHORS.filter((e) => !(e.key === victim.key && e.axis === victim.axis));
  const { groups } = G4_ANCHOR_GROUPS(anchors, G4_LINES_OF);
  const drop = (rows) => rows.map((row) => row.key === victim.key
    ? { ...row, writeSite: row.writeSite.replace(/src\/loop\/[A-Za-z0-9_./-]+\.js/gu, "") } : row);
  const refsByDoc = [...tables.entries()].map(([side, table]) => ({
    side, doc: side === "en" ? "docs/host-consumer-contract.md" : "docs/host-consumer-contract_cn.md",
    refs: new Map(drop(table.rows).flatMap((row, rowIndex) => ["write", "read"].flatMap((axis) => {
      const cell = axis === "write" ? row.writeSite : row.readers;
      SIDE_FILE_REF.lastIndex = 0;
      return [...new Set(cell.match(SIDE_FILE_REF) ?? [])].map((rel) => [G4_GROUP_KEY(row.key, axis, rowIndex, rel), new Set([rel])]);
    }))),
  }));
  const coverage = checkCellAxesCoverage({ anchors, refsByDoc });
  const hit = coverage.errors.find((e) => e.includes("ts"));
  assert.ok(hit !== undefined, `成对删掉 ts 写格后覆盖面真值必红并点名 ts，实际：\n  ${coverage.errors.join("\n  ")}`);
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
  assert.equal(verified, 0, "四个保留格都声明 not-source，不应存在 snapshot 属性读点");
});
