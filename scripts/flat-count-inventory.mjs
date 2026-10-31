#!/usr/bin/env node
/**
 * 扁平选项写点计数器 + 清点表核对器 / 刷表器（#498 S7；#529 落进仓库）。
 *
 * **#529：这份脚本以前只以 heredoc 形式活在 `test/compat-pin-inventory.md` 的「复跑方法」里，
 * 复跑命令指向仓库外的 `/tmp/flat-count.cjs`** —— 于是表一旦漂移，下一个 worker 刷不了
 * （那 5+ 处 `node /tmp/flat-count.cjs …` 在干净检出上根本跑不通）。现在它就在树上，
 * 命令一律写 `node scripts/flat-count-inventory.mjs …`；**`/tmp/` 不再是复现基准**。
 *
 * 用法（在仓库根跑；需要 `typescript`，仓库 devDependencies 里有，`npm ci` 后就有）：
 *   node scripts/flat-count-inventory.mjs .                       # 三个总数
 *   node scripts/flat-count-inventory.mjs . --files               # 逐文件明细
 *   node scripts/flat-count-inventory.mjs . --keys                # 逐键明细
 *   node scripts/flat-count-inventory.mjs . --verify test/compat-pin-inventory.md   # 与本表逐行对账（不一致 ⇒ exit 1）
 *   node scripts/flat-count-inventory.mjs . --sync   test/compat-pin-inventory.md   # 机器刷表（数字/明细来自 AST，不手改）
 *   node scripts/flat-count-inventory.mjs /tmp/base-498           # 迁移前基线（388 / 678）
 *
 * 两种模式（语义相反，**别混**）：
 *   · `--sync <表>`：**刷表**。数字与明细列由 AST 重写；**主表与附表的漏行都按实测补上**
 *     （主表补的那一行「分类」列写 `TODO（人手裁决：分类列）`，分类是历史裁决，机器不替你决定）；
 *     `### 分派小结` 的「写点」与「文件数（有清单可数的行）」也一并刷新。这是**唯一合法**的改表方式
 *     （表是量出来的，不是写出来的）。
 *   · `--verify <表>`：**验表**。逐行对账，**不改任何文件**；任一处不一致 ⇒ exit 1 并点名
 *     （`✗ 附表 test/x.test.js：表 125 / AST 122`）。CI 的阻塞门禁 `npm run check:inventory` 跑的就是它。
 *
 * **生成器覆盖面只有一份定义**（`CELL_OWNERSHIP`，下面紧跟着它）：`--sync` 按它决定写哪些格子，
 * `--verify` 按它决定核哪些格子、并把生成器管不到的格子**显式打印成「人工维护，依据本命令打印的
 * AST 真值」**。两处各写一份名单正是 #646 记的病根（`--sync` 不插主表行 / 不管小结，而 `--verify` 点它们）。
 *
 * 纪律（#534 起由 CI 阻塞门禁兜住，不再靠人手跑）：
 *   · 改动 `test/**` 里的兼容钉子（顶层扁平选项写点 / 壳）**必须同片 `--sync` 刷表**；
 *   · **禁止手改表里的数字** —— 手改只会让 `--verify` 红，且下一个 worker 分不清
 *     「表漂了」还是「数算错了」（A12 的 3 处不一致就是这么来的）。
 *
 * 口径（五条，缺一条数就对不上本表）：
 *   1. 走 <root>/test/**，跳过 <root>/test/contract/**（#498 S8 独占）；
 *   2. 只数属性写法（`PropertyAssignment` / `ShorthandPropertyAssignment`）的**名字**；
 *   3. **数到被数的键就停**，不再往它的值里走 —— 于是 `retry: { sleepImpl }` 只算 `retry` 一个，
 *      `onObserverError: (error, context) => seen.push({ error, context })` 里的 `context` 不算
 *      （「同名变量落进记录对象」的简写不是扁平写点）；
 *   4. `capabilities` / `config` 容器同样数到就停（容器里的同名叶子是规位写法，不是扁平写点）；
 *   5. `context` 同名壳也停（`context: foldContext({ onFoldSummary })` 只算 `context` 一个）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// `typescript` 是 CJS：按**脚本自身位置**解析（不再依赖 cwd 里有 node_modules），
// 这样 `node scripts/flat-count-inventory.mjs /tmp/base-498` 从任意目录跑都对。
const require = createRequire(import.meta.url);
const ts = require("typescript");

const RETIRED = [
  "onEvent", "onRound", "onJudge", "onToolResult", "onDelta", "onReasoningDelta",
  "onToolCall", "onUsage", "onObserverError", "onPersistenceError", "onFoldSummary",
];
const CAPABILITY_FACE = new Set([...RETIRED, "finalGuard", "deliverables"]);
// 数据面键表（#498 S7c 扩键）：白名单里「值在 test/** 出现过对象字面量」的**配置面**键 —— 也就是
// 「壳」（引擎按名字读子键的容器）——再加上本表既有的 6 个非对象条目：
//   · `resume` / `persistence`：整块开关（布尔），S3 删它们时同样是「一键一处改写」；
//   · `prompt`：`bin/cli.js` 的 `runChat({ prompt })` 入参（不是 runToolLoop 选项）；
//   · `strategy` / `sleepImpl` / `judgeProvider`：**非白名单**的在壳叶子（`context.strategy` /
//     `retry.sleepImpl` / `reflection.judge.provider`），它们没有顶层扁平别名，但扁平壳里照样写。
// 明确**排除**（各有机器可判的理由，不是凭记忆）：
//   · `system` / `user` / `task` / `model` / `toolContext`：值是不透明**载荷**（`{ id }` / `{ content }`），
//     引擎不按名字读子键；`system` 还在 provider 请求体里（`test/messages/anthropic.test.js`）出现，
//     那不是 runToolLoop 的选项面 ⇒ 归 NOT-OPTION-SURFACE，不进本表；
//   · `writeToolNames` / `writeToolPathKeys`：字符串数组（元素不是子键）；
//   · 其余标量键（`maxRounds` / `runId` / `cwd` / `initialUserMessage` / `stream` / `maxTokens` …）：
//     没有子键 ⇒ 不是壳。S3 删它们是一键一处改写，不是拆壳；它们的消费者面用「删键后全量红格数」校准
//     （见清点表的「校准方法」）。
//
// 注意：`partialPersistence` 在 A12 已经**退役顶层扁平写法**（规范之家 `config.run.partialPersistence`），
// 但它**仍留在本表里**——因为「拒绝钉」本身就要在 `test/**` 里写一次扁平拼写来证明它被拒。
// 表数的是「写点」，不是「被接受的写法」。
const DATA_KEYS = new Set([
  "reflection", "tools", "context", "resume", "retry", "initialMessages", "prompt",
  "strategy", "sleepImpl", "judgeProvider",
  // S7c 扩键：从白名单枚举出来的、此前漏掉的 7 个壳。
  "completion", "session", "modelMetadata", "outputHygiene", "stallDetection",
  "partialPersistence", "wrapup",
]);
const ALL = new Set([...CAPABILITY_FACE, ...DATA_KEYS]);
const CONTAINERS = new Set(["capabilities", "config"]);

/**
 * **「哪些格子归生成器」的唯一定义**（#646 ②：`--sync` 与 `--verify` 共用这一份，不许各写一份）。
 *
 *   · `generated`：由 AST 实测重写 / 补行，`--sync` 写、`--verify` 逐格核；
 *   · `manual`：生成器**管不到**的格子，`--verify` 明确打印成「人工维护，依据本命令打印的 AST 真值」。
 *
 * 为什么主表「分类」列是人工：它记录的是历史裁决（S7a / S7b / S7c / COMPAT-PIN / OWNED-BY-* 的归属），
 * AST 里没有这个事实；`--sync` 只能把新行标成 `TODO（人手裁决：分类列）`，由人填。
 * 为什么分派清单的「写点」列是人工：同一文件跨片时一行只记本片那几点（`S7b（3）+ S7c（1）`），
 * 单文件 AST 总数不等于任何一行；`--verify` 仍按**文件汇总**核它，并打印每组的行数 / 写点数。
 * 为什么分派小结的「文件数」只有一半是生成的：有对应清单的行 = 清单行数（生成）；没有清单的行
 * （S7a / S7a 遗留）是历史计数（人工）。合计行的「文件数」= 主表行 ∪ 分派清单行的**去重文件数**（生成）。
 */
const CELL_OWNERSHIP = Object.freeze({
  main: Object.freeze({
    generated: Object.freeze(["row", "points", "detail"]),
    manual: Object.freeze(["classification"]),
  }),
  appendix: Object.freeze({
    generated: Object.freeze(["row", "points", "detail"]),
    manual: Object.freeze([]),
  }),
  dispatchList: Object.freeze({
    generated: Object.freeze([]),
    manual: Object.freeze(["row", "points"]),
  }),
  summary: Object.freeze({
    generated: Object.freeze(["row", "points", "files"]),
    manual: Object.freeze(["label", "files（无清单可数的行）"]),
  }),
});

/** 该格是否归生成器（`--sync` 写 / `--verify` 核）；名单只有 `CELL_OWNERSHIP` 一份。 */
function generates(section, cell) {
  return CELL_OWNERSHIP[section].generated.includes(cell);
}

/** 主表新行 / 小结新行的分类占位（人裁决后替换；`--verify` 不判分类内容）。 */
const TODO_CLASSIFICATION = "TODO（人手裁决：分类列）";

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function count(root) {
  const hits = [];
  for (const file of walk(path.join(root, "test"), [])) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel.startsWith("test/contract/")) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (n) => {
      if (!n) return;
      if (ts.isPropertyAssignment(n)) {
        const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
        if (name && ALL.has(name)) hits.push({ file: rel, key: name });
        if (name && (CONTAINERS.has(name) || ALL.has(name))) return; // 规则 3 / 4 / 5
      } else if (ts.isShorthandPropertyAssignment(n)) {
        if (ALL.has(n.name.text)) hits.push({ file: rel, key: n.name.text });
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const per = new Map();
  for (const h of hits) {
    const cur = per.get(h.file) || { total: 0, cap: 0, data: 0, byKey: new Map() };
    cur.total += 1;
    if (CAPABILITY_FACE.has(h.key)) cur.cap += 1; else cur.data += 1;
    cur.byKey.set(h.key, (cur.byKey.get(h.key) || 0) + 1);
    per.set(h.file, cur);
  }
  return { hits, per };
}

/** 明细列：与既有表同格式（按写点数降序、同数按名字升序）。
 *  `face` 是**必须**的：主表的明细只列**能力面**键，附表的明细只列**数据面**键
 *  （两表各管一面，混着列就与「主表 170 / 附表 1343」这两本账对不上了）。 */
function detailOf(v, face) {
  return [...v.byKey.entries()]
    .filter(([k]) => face === undefined || (face === "cap" ? CAPABILITY_FACE.has(k) : !CAPABILITY_FACE.has(k)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, c]) => `\`${k}\`×${c}`).join(", ");
}

// ─────────────────────────── 表结构（--sync 与 --verify 共用） ───────────────────────────

/** 章节标题 → 这张表的哪一段。清单段的键名就是分派小结里的「类」名。 */
function sectionKind(header) {
  if (header.startsWith("## MIGRATE（")) return "main";
  if (header.startsWith("## 附表")) return "appendix";
  if (header.startsWith("## S7b 清单")) return "dispatchList:S7b";
  if (header.startsWith("## S7c 清单")) return "dispatchList:S7c";
  if (header.startsWith("## OWNED-BY-S5")) return "dispatchList:OWNED-BY-S5";
  if (header.startsWith("## OWNED-BY-S6")) return "dispatchList:OWNED-BY-S6";
  if (header.startsWith("## COMPAT-PIN（")) return "dispatchList:COMPAT-PIN";
  return "other";
}

/**
 * 一行表格 → 行对象（不是数据行 ⇒ null）。按**单元格**拆，不用贪婪正则：主表 4 列（文件 / 写点 /
 * 明细 / 分类）与附表 3 列（文件 / 写点 / 明细）只差最后一格，`tail` 一律取「第 5 格起」的原文。
 * 用单元格拆的另一个理由：明细列里也可能出现 `|` 之外的任何字样，按 `[^|]*` 贪吃会把明细并进分类列。
 */
function parseDataRow(line) {
  const cells = line.split("|");
  if (cells.length < 4) return null;
  const file = cells[1].trim().match(/^`(test\/[^`]+)`$/);
  if (!file) return null;
  const claimed = cells[2].trim().match(/^(\d+)(?:（[^）]*）)?$/u);
  if (!claimed) return null;
  return { file: file[1], claimed: Number(claimed[1]), cells };
}

/**
 * 把整张表解析成「行对象 + 行号」。`--sync` 要按行号回写、`--verify` 要按同一份结构核，
 * 两边解析同一份文本 —— 解析规则只此一份（#646 ②）。
 */
function analyze(lines) {
  const mainRows = [];
  const appRows = [];
  const listRows = [];
  const summaryRows = [];
  let kind = "other";
  let inSummary = false;
  lines.forEach((line, lineIdx) => {
    if (line.startsWith("## ")) { kind = sectionKind(line); inSummary = false; }
    if (line.startsWith("### 分派小结")) { inSummary = true; return; }
    if (inSummary) {
      if (!line.startsWith("|")) return;
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 5) return;
      const points = (cells[3].match(/^\*?\*?(\d+)/) || [])[1];
      if (points === undefined) return;
      const files = (cells[2].match(/^\*?\*?(\d+)/) || [])[1];
      summaryRows.push({
        lineIdx,
        label: cells[1].replace(/`/g, "").replace(/\*\*/g, ""),
        files: files === undefined ? null : Number(files),
        points: Number(points),
        isTotal: /合计/.test(cells[1]),
      });
      return;
    }
    // 段落里的「含 COMPAT-PIN 格（…）：」是**伪标题**：它后面那张 4 列表按这一类归口。
    if (line.startsWith("含 COMPAT-PIN 格（")) { kind = "dispatchList:含 COMPAT-PIN 格"; return; }
    const parsed = parseDataRow(line);
    if (!parsed) return;
    const row = { lineIdx, file: parsed.file, claimed: parsed.claimed, tail: (parsed.cells[4] ?? "").trim() };
    if (kind === "main") mainRows.push(row);
    else if (kind === "appendix") appRows.push(row);
    else if (kind.startsWith("dispatchList:")) listRows.push({ ...row, group: kind.slice("dispatchList:".length) });
  });
  return { mainRows, appRows, listRows, summaryRows };
}

/** 已迁完的切片清单（S7a 没有清单段）：这些文件只活在清单里，主表不列（表头口径）。 */
const SLICE_LISTS = new Set(["S7b", "S7c"]);

/** 该文件是否由某张**已迁完切片**清单归口（只有这种文件允许不出现在主表里）。 */
function ownedBySliceList(file, listRows) {
  return listRows.some((r) => r.file === file && SLICE_LISTS.has(r.group));
}

/** 主表「分类」列 → 逐点归片。分类列是唯一权威（同文件跨片时写 `S7b（3）+ S7c（1）`）。 */
function groupContributions(tail, points) {
  const split = [...tail.matchAll(/S7([abc])（(\d+)）/g)];
  if (split.length) return split.map((s) => [`S7${s[1]}`, Number(s[2])]);
  const plain = tail.match(/MIGRATE · S7([abc])/);
  if (plain) return [[`S7${plain[1]}`, points]];
  // 顺序要紧：`含 COMPAT-PIN 格` 里也含 `COMPAT-PIN` 字样。
  for (const g of ["NOT-OPTION-SURFACE", "含 COMPAT-PIN 格", "COMPAT-PIN", "OWNED-BY-S5", "OWNED-BY-S6"]) {
    if (tail.includes(g)) return [[g, points]];
  }
  return [[`?${tail}`, points]];
}

/** 小结「类」列 → 分组键（与 `groupContributions` 的键同一套词表）。 */
function groupOfLabel(label) {
  const m = label.match(/S7([abc])/);
  if (m) return `S7${m[1]}`;
  for (const g of ["NOT-OPTION-SURFACE", "含 COMPAT-PIN 格", "COMPAT-PIN", "OWNED-BY-S5", "OWNED-BY-S6"]) {
    if (label.includes(g)) return g;
  }
  if (/^TODO/.test(label)) return `?${label}`;
  return null;
}

function groupsOf(mainRows, per) {
  const groups = new Map();
  const addTo = (g, n) => groups.set(g, (groups.get(g) || 0) + n);
  for (const row of mainRows) {
    const n = per.get(row.file)?.cap ?? 0;
    for (const [g, points] of groupContributions(row.tail, n)) addTo(g, points);
  }
  return groups;
}

/** 小结「文件数」= 对应清单的行数；没有清单可数的组返回 null（人工维护）。 */
function listFileCounts(listRows) {
  const counts = new Map();
  for (const row of listRows) counts.set(row.group, (counts.get(row.group) || 0) + 1);
  return counts;
}

/** 合计「文件数」= 主表行 ∪ 分派清单行的**去重文件数**（附表另算一本账，不混进来）。 */
function totalFileCount(mainRows, listRows) {
  return new Set([...mainRows.map((r) => r.file), ...listRows.map((r) => r.file)]).size;
}

/** 只重写单元格开头的数字（保留 `**` 与后缀，如 `0（迁移前 37，已不在树里）`）。 */
function rewriteLeadingNumber(cell, n) {
  return cell.replace(/^(\s*)(\*\*)?\d+/, (m, ws, bold) => `${ws}${bold ?? ""}${n}`);
}

function renderMainRow(file, points, detail) {
  return `| \`${file}\` | ${points} | ${detail} | ${TODO_CLASSIFICATION} |`;
}

function renderAppRow(file, points, detail) {
  return `| \`${file}\` | ${points} | ${detail} |`;
}

function renderSummaryRow(label, files, points) {
  return `| \`${label}\` | ${files} | ${points} |`;
}

// ─────────────────────────────────── --sync ───────────────────────────────────

/**
 * 把整张表按 AST 实测重写：**哪些格子归生成器只看 `CELL_OWNERSHIP`**。
 * 主表/附表：数字与明细重写、漏行补上（主表补行的分类列写 TODO，由人裁决）；
 * 分派小结：写点、有清单可数行的文件数、缺行、合计行的去重文件数 —— 全部重算。
 * 分派清单：`CELL_OWNERSHIP.dispatchList.generated` 是空集 ⇒ 一个字不碰（`--verify` 会标注它是人工格）。
 */
function sync(root, mdPath) {
  const { per } = count(root);
  const lines = fs.readFileSync(mdPath, "utf8").split("\n");
  const doc = analyze(lines);
  const rewritten = new Map(); // lineIdx → 新行

  // 主表：写点 / 明细由 AST 重写，分类列原样保留（那是历史裁决）。
  if (generates("main", "points")) {
    for (const row of doc.mainRows) {
      const v = per.get(row.file);
      const cells = lines[row.lineIdx].split("|");
      cells[2] = ` ${v?.cap ?? 0} `;
      if (generates("main", "detail") && v) cells[3] = ` ${detailOf(v, "cap")} `;
      rewritten.set(row.lineIdx, cells.join("|"));
    }
  }
  // 附表：两列都由 AST 重写（`v` 缺席 = 该文件已无写点：清空明细、行本身留着由人判断是否该删）。
  if (generates("appendix", "points")) {
    for (const row of doc.appRows) {
      const v = per.get(row.file);
      const cells = lines[row.lineIdx].split("|");
      cells[2] = ` ${v?.data ?? 0} `;
      if (generates("appendix", "detail")) cells[3] = v ? ` ${detailOf(v)} ` : " ";
      rewritten.set(row.lineIdx, cells.join("|"));
    }
  }

  // 主表漏行：AST 有能力面写点、主表里没有这一行，且它也不由某张**已迁完切片**清单归口
  // （S7a/S7b/S7c 的文件只活在清单里，主表本来就不列 —— 这是表头口径，不是漏行）。
  // 注意：非切片清单（COMPAT-PIN / OWNED-BY-* / 含 COMPAT-PIN 格）的文件**两边都该有**，
  // 主表那一行丢了就是漏行 —— 旧版把「在任一张清单里」当成豁免，于是删掉主表行后只剩合计红。
  const missingMain = [];
  if (generates("main", "row")) {
    const known = new Set(doc.mainRows.map((r) => r.file));
    for (const [f, v] of per) {
      if (v.cap > 0 && !known.has(f) && !ownedBySliceList(f, doc.listRows)) missingMain.push([f, v]);
    }
    missingMain.sort((a, b) => b[1].cap - a[1].cap || a[0].localeCompare(b[0]));
  }

  // 分组要算上「马上要补进主表的那几行」（分类列占位 TODO）：否则小结的列和与合计对不上，
  // 而 --sync 刷完却仍是红的（#646 ②的原始病根）。
  const effectiveMainRows = [...doc.mainRows, ...missingMain.map(([f]) => ({ file: f, tail: TODO_CLASSIFICATION }))];

  // 分派小结：先按**重写后的**主表算分组，再重写「写点」「文件数」，最后补缺行。
  const groups = groupsOf(effectiveMainRows, per);
  const fileCounts = listFileCounts(doc.listRows);
  const totalFiles = totalFileCount(effectiveMainRows, doc.listRows);
  if (generates("summary", "points")) {
    for (const row of doc.summaryRows) {
      const cells = lines[row.lineIdx].split("|");
      const g = groupOfLabel(row.label);
      const actual = row.isTotal ? [...per.values()].reduce((s, v) => s + v.cap, 0) : (groups.get(g) ?? 0);
      cells[3] = rewriteLeadingNumber(cells[3], actual);
      if (generates("summary", "files")) {
        if (row.isTotal) cells[2] = rewriteLeadingNumber(cells[2], totalFiles);
        else if (fileCounts.has(g)) cells[2] = rewriteLeadingNumber(cells[2], fileCounts.get(g));
        // 没有清单可数 ⇒ 文件数是人工格，原样留着（--verify 会把它标出来）。
      }
      rewritten.set(row.lineIdx, cells.join("|"));
    }
  }

  const out = lines.map((line, i) => rewritten.get(i) ?? line);
  const inserted = [];

  if (missingMain.length) {
    const lastMain = doc.mainRows[doc.mainRows.length - 1];
    if (!lastMain) throw new Error("找不到主表最后一行，无法插入漏行");
    const rows = missingMain.map(([f, v]) => renderMainRow(f, v.cap, detailOf(v, "cap")));
    out.splice(lastMain.lineIdx + 1, 0, ...rows);
    inserted.push(...missingMain.map(([f, v]) => `主表 \`${f}\` ${v.cap} 点（分类列 ${TODO_CLASSIFICATION}）`));
  }

  // 附表漏行：AST 有数据面写点、表里没有这一行的文件 —— 按「写点降序、同数按文件名」追加。
  if (generates("appendix", "row")) {
    const known = new Set(doc.appRows.map((r) => r.file));
    const missing = [...per.entries()]
      .filter(([f, v]) => v.data > 0 && !known.has(f))
      .sort((a, b) => b[1].data - a[1].data || a[0].localeCompare(b[0]));
    if (missing.length) {
      const lastApp = doc.appRows[doc.appRows.length - 1];
      if (!lastApp) throw new Error("找不到附表最后一行，无法插入漏行");
      const rows = missing.map(([f, v]) => renderAppRow(f, v.data, detailOf(v)));
      out.splice(lastApp.lineIdx + 1, 0, ...rows);
      inserted.push(...rows.map((_, i) => `附表 \`${missing[i][0]}\` ${missing[i][1].data} 点`));
    }
  }

  // 分派小结漏行：主表里出现、小结里还没有的组（分类列是 TODO 的新组一定走到这里）。
  if (generates("summary", "row")) {
    const have = new Set(doc.summaryRows.map((r) => groupOfLabel(r.label)));
    const missing = [...groups.entries()].filter(([g, n]) => n > 0 && !have.has(g));
    if (missing.length) {
      const totalRow = doc.summaryRows.find((r) => r.isTotal);
      const anchor = totalRow ? totalRow.lineIdx : doc.summaryRows[doc.summaryRows.length - 1]?.lineIdx;
      if (anchor === undefined) throw new Error("找不到分派小结的表体，无法插入漏行");
      const rows = missing.map(([g, n]) => {
        const label = g.replace(/^\?/, "");
        const files = fileCounts.get(g) ?? "TODO（人工维护：无清单可数）";
        return renderSummaryRow(label, files, n);
      });
      out.splice(anchor, 0, ...rows);
      inserted.push(...missing.map(([g, n]) => `分派小结 \`${g.replace(/^\?/, "")}\` ${n} 点`));
    }
  }

  fs.writeFileSync(mdPath, out.join("\n"));
  const changed = [...rewritten.values()].length;
  console.log(`刷表：重写 ${changed} 行、补 ${inserted.length} 行 ⇒ ${mdPath}`);
  for (const note of inserted) console.log(`  + ${note}`);
  console.log(`  人工维护格（生成器不写）：主表「分类」列 / 分派清单「写点」列 / 小结「类」列`
    + ` / 无清单可数行的「文件数」——数字依据 --verify 打印的 AST 真值`);
  return 0;
}

// ─────────────────────────────────── --verify ───────────────────────────────────

function verify(root, mdPath) {
  const { per } = count(root);
  const lines = fs.readFileSync(mdPath, "utf8").split("\n");
  const doc = analyze(lines);
  const bad = [];
  const astCap = (f) => (per.get(f)?.cap ?? 0);
  const astData = (f) => (per.get(f)?.data ?? 0);

  // ① 逐行：生成器写的那两列必须等于 AST 实测。
  for (const row of doc.mainRows) {
    if (row.claimed !== astCap(row.file)) bad.push(`主表 ${row.file}：表 ${row.claimed} / AST ${astCap(row.file)}`);
  }
  for (const row of doc.appRows) {
    if (row.claimed !== astData(row.file)) bad.push(`附表 ${row.file}：表 ${row.claimed} / AST ${astData(row.file)}`);
  }
  // 同一文件可能被两片各分一段（如 `loop-callback-this`：S7b 3 + S7c 1）⇒ 按文件汇总后再与 AST 对账。
  const perFileClaimed = new Map();
  for (const row of doc.listRows) perFileClaimed.set(row.file, (perFileClaimed.get(row.file) ?? 0) + row.claimed);
  for (const [f, claimed] of perFileClaimed) {
    if (claimed !== astCap(f)) bad.push(`分派清单 ${f}：表合计 ${claimed} / AST ${astCap(f)}`);
  }

  // ② 合计与覆盖面（与行无关的性质：某个文件从 0 点长出写点、而它本来就没有行 —— 旧版看不见）。
  const mainSum = doc.mainRows.reduce((s, r) => s + r.claimed, 0);
  const appSum = doc.appRows.reduce((s, r) => s + r.claimed, 0);
  const astMain = [...per.values()].reduce((s, v) => s + v.cap, 0);
  const astApp = [...per.values()].reduce((s, v) => s + v.data, 0);
  if (mainSum !== astMain) bad.push(`主表合计：表 ${mainSum} / AST ${astMain}`);
  if (appSum !== astApp) bad.push(`附表合计：表 ${appSum} / AST ${astApp}`);
  for (const [f, v] of per) {
    if (v.data > 0 && !doc.appRows.some((r) => r.file === f)) bad.push(`附表漏行 ${f}：AST ${v.data} 点，表里没有这一行`);
    // 只有「已迁完切片清单」里的文件允许不出现在主表（表头口径）；非切片清单的文件两边都该有。
    if (v.cap > 0 && !doc.mainRows.some((r) => r.file === f) && !ownedBySliceList(f, doc.listRows)) {
      bad.push(`主表漏行 ${f}：AST ${v.cap} 点，表里没有这一行（--sync 会补一行，分类列写 TODO）`);
    }
  }

  // ③ 分派小结：写点与有清单可数行的文件数都是生成格，逐行核；无清单的行标注为人工。
  const groups = groupsOf(doc.mainRows, per);
  const fileCounts = listFileCounts(doc.listRows);
  const totalFiles = totalFileCount(doc.mainRows, doc.listRows);
  const totalRow = doc.summaryRows.find((r) => r.isTotal);
  const manualFiles = [];
  let sumPoints = 0;
  for (const s of doc.summaryRows) {
    const g = groupOfLabel(s.label);
    if (s.isTotal) continue;
    sumPoints += s.points;
    const actual = groups.get(g) ?? 0;
    if (s.points !== actual) bad.push(`分派小结 ${s.label}：表 ${s.points} / 逐点归片 ${actual}`);
    if (fileCounts.has(g)) {
      if (s.files !== fileCounts.get(g)) bad.push(`分派小结 ${s.label}：文件 ${s.files} / 清单 ${fileCounts.get(g)} 行`);
    } else {
      manualFiles.push(s);
    }
  }
  if (totalRow) {
    if (totalRow.points !== astMain) bad.push(`分派小结 合计：写点 ${totalRow.points} / AST 合计 ${astMain}`);
    if (totalRow.files !== totalFiles) {
      bad.push(`分派小结 合计：文件 ${totalRow.files} / 主表∪清单去重文件 ${totalFiles}`);
    }
    if (sumPoints !== totalRow.points) bad.push(`分派小结列和 ${sumPoints} ≠ 合计 ${totalRow.points}`);
  } else {
    bad.push("分派小结合计行缺失——没有合计行，删掉整张表也不会红");
  }
  // 组有写点、小结里却没有这一行：列和会不对，但要点名是哪个组（--sync 会补一行）。
  for (const [g, n] of groups) {
    if (n > 0 && !doc.summaryRows.some((s) => groupOfLabel(s.label) === g)) {
      bad.push(`分派小结缺行：组 ${g.replace(/^\?/, "")} ${n} 点，表里没有这一行（--sync 会补一行）`);
    }
  }

  // ④ 报告（不判定）：生成器覆盖面 + 人工维护格。
  console.log(`主表 ${doc.mainRows.length} 行：表合计 ${mainSum} / AST 合计 ${astMain}`);
  console.log(`附表 ${doc.appRows.length} 行：表合计 ${appSum} / AST 合计 ${astApp}`);
  const groupNames = ["S7a", "S7b", "S7c", "含 COMPAT-PIN 格", "COMPAT-PIN", "OWNED-BY-S5", "OWNED-BY-S6", "NOT-OPTION-SURFACE"];
  for (const g of groupNames) console.log(`  ${g.padEnd(18)} 逐点归片合计 ${groups.get(g) ?? 0}`);
  const groupSum = [...groups.entries()].filter(([g]) => g !== "S7a").reduce((s, [, v]) => s + v, 0);
  console.log(`  非 S7a 合计 ${groupSum}（应 = 主表合计 ${mainSum}）`);
  if (doc.summaryRows.length) {
    console.log(`分派小结 ${doc.summaryRows.length} 行：`);
    for (const s of doc.summaryRows) {
      const g = groupOfLabel(s.label);
      const actual = s.isTotal ? astMain : (groups.get(g) ?? 0);
      const ok = s.points === actual;
      const filesOk = s.isTotal ? s.files === totalFiles : (!fileCounts.has(g) || s.files === fileCounts.get(g));
      const filesNote = s.isTotal
        ? `去重文件 ${totalFiles}`
        : (fileCounts.has(g) ? `清单 ${fileCounts.get(g)} 行` : "文件数人工维护");
      console.log(`  表 ${s.label}：文件 ${s.files ?? "—"}（${filesNote}） / 写点 ${s.points}（逐点归片 ${actual}）`
        + `${ok && filesOk ? " ✅" : " ✗"}`);
    }
    if (totalRow) {
      console.log(sumPoints === totalRow.points
        ? `  列和 ${sumPoints} = 合计 ${totalRow.points} ✅`
        : `  列和 ${sumPoints} ≠ 合计 ${totalRow.points} ✗`);
    }
  }
  for (const [g, rows] of new Map(doc.listRows.reduce((m, r) => m.set(r.group, [...(m.get(r.group) ?? []), r]), new Map()))) {
    console.log(`  清单 ${g.padEnd(16)} ${rows.length} 行 / 表列写点 ${rows.reduce((a, r) => a + r.claimed, 0)}`);
  }
  console.log("生成器覆盖面（唯一一份定义，--sync 与 --verify 共用）：");
  console.log(`  主表：生成 ${CELL_OWNERSHIP.main.generated.join(" / ")}；人工维护 ${CELL_OWNERSHIP.main.manual.join(" / ")}（${doc.mainRows.length} 行）`);
  console.log(`  附表：生成 ${CELL_OWNERSHIP.appendix.generated.join(" / ")}；人工维护 ${CELL_OWNERSHIP.appendix.manual.length ? CELL_OWNERSHIP.appendix.manual.join(" / ") : "无"}`);
  console.log(`  分派清单：人工维护 ${CELL_OWNERSHIP.dispatchList.manual.join(" / ")}（${doc.listRows.length} 行，逐文件合计由上面的「分派清单」核对行给出）`);
  console.log(`  分派小结：生成 ${CELL_OWNERSHIP.summary.generated.join(" / ")}；人工维护 ${CELL_OWNERSHIP.summary.manual.join(" / ")}`
    + `${manualFiles.length ? `（${manualFiles.length} 行：${manualFiles.map((s) => s.label).join("；")}）` : ""}`);
  console.log("  人工维护格里的数字一律依据本命令打印的 AST 真值；改表唯一合法的方式是 --sync。");

  if (bad.length) { console.log("不一致："); for (const b of bad) console.log("  ✗ " + b); }
  else console.log("逐文件：0 处不一致");
  return bad.length;
}

function main() {
  const root = process.argv[2] || ".";
  const mode = process.argv[3] || "";
  const { hits, per } = count(root);
  if (mode === "--files") {
    const rows = [...per.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    for (const [f, v] of rows) {
      console.log(`${String(v.total).padStart(3)}  ${f}  |  ${detailOf(v)}`);
    }
    console.log(`--- 文件数 ${rows.length}  写点合计 ${rows.reduce((s, [, v]) => s + v.total, 0)}`);
    return;
  }
  if (mode === "--verify") { process.exitCode = verify(root, process.argv[4]) === 0 ? 0 : 1; return; }
  if (mode === "--sync") { process.exitCode = sync(root, process.argv[4]) === 0 ? 0 : 1; return; }
  if (mode === "--keys") {
    const byKey = new Map();
    const files = new Map();
    for (const h of hits) {
      byKey.set(h.key, (byKey.get(h.key) || 0) + 1);
      if (!files.has(h.key)) files.set(h.key, new Set());
      files.get(h.key).add(h.file);
    }
    for (const [k, c] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(c).padStart(4)}  ${String(files.get(k).size).padStart(3)} files  ${CAPABILITY_FACE.has(k) ? "CAP " : "DATA"}  ${k}`);
    }
    return;
  }
  const cap = hits.filter((h) => CAPABILITY_FACE.has(h.key)).length;
  const data = hits.filter((h) => DATA_KEYS.has(h.key)).length;
  console.log(`能力面 13 键（主表口径）：${cap}`);
  console.log(`数据面 ${DATA_KEYS.size} 键（附表口径）：${data}`);
  console.log(`全部写点：${hits.length}`);
}

main();
