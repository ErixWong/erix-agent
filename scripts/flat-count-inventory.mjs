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
 *   · `--sync <表>`：**刷表**。数字与明细列由 AST 重写，表里漏掉的行按实测补上 ——
 *     这是**唯一合法**的改表方式（表是量出来的，不是写出来的）。
 *   · `--verify <表>`：**验表**。逐行对账，**不改任何文件**；任一处不一致 ⇒ exit 1 并点名
 *     （`✗ 附表 test/x.test.js：表 125 / AST 122`）。CI 的阻塞门禁 `npm run check:inventory` 跑的就是它。
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

/** 把整张表按 AST 实测重写：主表/附表的**数字与明细**一律来自 AST，插入漏掉的行。 */
function sync(root, mdPath) {
  const { per } = count(root);
  const lines = fs.readFileSync(mdPath, "utf8").split("\n");
  let section = "";
  let inSummary = false;
  let touched = 0;
  const out = [];
  const appSeen = new Set();
  let lastAppRowIdx = -1;
  for (const line of lines) {
    if (line.startsWith("## ")) { section = line; inSummary = false; }
    if (line.startsWith("### 分派小结")) inSummary = true;
    if (inSummary || line.startsWith("含 COMPAT-PIN 格（")) { out.push(line); continue; }
    const m = line.match(/^\| `(test\/[^`]+)` \| (\d+)（?[^|]*\| ?(.*)$/);
    if (!m) { out.push(line); continue; }
    const file = m[1];
    const isApp = section.startsWith("## 附表");
    const isMain = section.startsWith("## MIGRATE（");
    if (!isApp && !isMain) { out.push(line); continue; }
    const v = per.get(file);
    const n = isApp ? (v?.data ?? 0) : (v?.cap ?? 0);
    // 主表 4 列（文件 / 写点 / 明细 / 分类）：只重写数字与明细，**分类列原样保留**（那是历史裁决）。
    // 附表 3 列（文件 / 写点 / 明细）：两列都由 AST 重写。
    const cells = line.split("|");
    // cells[0] = "" , cells[1] = 文件, cells[2] = 写点, cells[3] = 明细, cells[4] = 分类?, ...
    cells[2] = ` ${n} `;
    // 明细列由 AST 重写（`v` 缺席 = 该文件已无写点：附表清空明细、行本身留着由人判断是否该删；
    // 主表则连明细都不碰，因为它的第 4 列是历史裁决）。
    if (v) cells[3] = ` ${detailOf(v, isApp ? undefined : "cap")} `;
    else if (isApp) cells[3] = " ";
    const rebuilt = cells.join("|");
    if (rebuilt !== line) touched += 1;
    if (isApp) appSeen.add(file);
    out.push(rebuilt);
    if (isApp) lastAppRowIdx = out.length - 1;
  }
  // 附表漏行：AST 有数据面写点、表里没有这一行的文件 —— 按「写点降序、同数按文件名」追加。
  const missing = [...per.entries()]
    .filter(([f, v]) => v.data > 0 && !appSeen.has(f))
    .sort((a, b) => b[1].data - a[1].data || a[0].localeCompare(b[0]));
  if (missing.length) {
    if (lastAppRowIdx < 0) throw new Error("找不到附表最后一行，无法插入漏行");
    const rows = missing.map(([f, v]) => `| \`${f}\` | ${v.data} | ${detailOf(v)} |`);
    out.splice(lastAppRowIdx + 1, 0, ...rows);
    touched += rows.length;
  }
  fs.writeFileSync(mdPath, out.join("\n"));
  console.log(`刷表：改动 ${touched} 行（补 ${missing.length} 行）⇒ ${mdPath}`);
  for (const [f, v] of missing) console.log(`  + 附表 \`${f}\` ${v.data} 点`);
  return 0;
}

function verify(root, mdPath) {
  const { per } = count(root);
  const lines = fs.readFileSync(mdPath, "utf8").split("\n");
  const bad = [];
  const mainRows = [];
  const appRows = [];
  const summary = [];
  const listRows = new Map(); // 分派清单（S7b/S7c/S5/S6/COMPAT/含COMPAT）逐行：文件 → 表列写点
  const groupRows = (g, row) => {
    if (!listRows.has(g)) listRows.set(g, []);
    listRows.get(g).push(row);
  };
  let section = "";
  let inSummary = false;
  for (const line of lines) {
    if (line.startsWith("## ")) { section = line; inSummary = false; }
    if (line.startsWith("### 分派小结")) { inSummary = true; continue; }
    if (inSummary) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 5) continue;
      const files = (cells[2].match(/^\*?\*?(\d+)/) || [])[1];
      const points = (cells[3].match(/^\*?\*?(\d+)/) || [])[1];
      if (files === undefined || points === undefined) continue;
      summary.push({ label: cells[1].replace(/`/g, "").replace(/\*\*/g, ""), files: Number(files), points: Number(points) });
      continue;
    }
    if (line.startsWith("含 COMPAT-PIN 格（")) { section = "## 含 COMPAT-PIN 格"; continue; }
    const m = line.match(/^\| `(test\/[^`]+)` \| (\d+)（?[^|]*\| ?(.*)$/);
    if (!m) continue;
    const row = { file: m[1], claimed: Number(m[2]), tail: m[3] };
    if (section.startsWith("## 附表")) appRows.push(row);
    else if (section.startsWith("## MIGRATE（")) mainRows.push(row);
    else if (section.startsWith("## S7b 清单")) groupRows("S7b", row);
    else if (section.startsWith("## S7c 清单")) groupRows("S7c", row);
    else if (section.startsWith("## OWNED-BY-S5")) groupRows("OWNED-BY-S5", row);
    else if (section.startsWith("## OWNED-BY-S6")) groupRows("OWNED-BY-S6", row);
    else if (section.startsWith("## COMPAT-PIN（")) groupRows("COMPAT-PIN", row);
    else if (section === "## 含 COMPAT-PIN 格") groupRows("含 COMPAT-PIN 格", row);
  }
  const astCap = (f) => (per.get(f)?.cap ?? 0);
  const astData = (f) => (per.get(f)?.data ?? 0);

  for (const row of mainRows) if (row.claimed !== astCap(row.file)) bad.push(`主表 ${row.file}：表 ${row.claimed} / AST ${astCap(row.file)}`);
  // 同一文件可能被两片各分一段（如 `loop-callback-this`：S7b 3 + S7c 1）⇒ 按文件汇总后再与 AST 对账
  const perFileClaimed = new Map();
  for (const [, rows] of listRows) for (const row of rows) perFileClaimed.set(row.file, (perFileClaimed.get(row.file) ?? 0) + row.claimed);
  for (const [f, claimed] of perFileClaimed) if (claimed !== astCap(f)) bad.push(`分派清单 ${f}：表合计 ${claimed} / AST ${astCap(f)}`);
  for (const row of appRows) if (row.claimed !== astData(row.file)) bad.push(`附表 ${row.file}：表 ${row.claimed} / AST ${astData(row.file)}`);
  const mainSum = mainRows.reduce((s, r) => s + r.claimed, 0);
  const appSum = appRows.reduce((s, r) => s + r.claimed, 0);
  const astMain = [...per.values()].reduce((s, v) => s + v.cap, 0);
  const astApp = [...per.values()].reduce((s, v) => s + v.data, 0);

  // 反证面（#498 S3 A2b 补）：上面的逐行对账只核**已登记的行**，于是「某个文件从 0 点长出写点、
  // 而它本来就没有附表行」这种漂移是**看不见**的（实测：给 `test/loop-deliverables.test.js` 加 3 个
  // 数据面写点，旧版只把总数印成 1263/1266 却照样 exit=0）。所以再钉三条与行无关的性质：
  //   ① 两个合计必须各自等于 AST 合计；② 有任何数据面写点的文件必须有附表行；
  //   ③ 有任何能力面写点的文件必须落在主表或某张分派清单里。
  if (mainSum !== astMain) bad.push(`主表合计：表 ${mainSum} / AST ${astMain}`);
  if (appSum !== astApp) bad.push(`附表合计：表 ${appSum} / AST ${astApp}`);
  const allGroupRows = [...listRows.values()].flat();
  for (const [f, v] of per) {
    if (v.data > 0 && !appRows.some((r) => r.file === f)) bad.push(`附表漏行 ${f}：AST ${v.data} 点，表里没有这一行`);
    if (v.cap > 0 && !mainRows.some((r) => r.file === f) && !allGroupRows.some((r) => r.file === f)) {
      bad.push(`主表/分派清单漏行 ${f}：AST ${v.cap} 点，表里没有这一行`);
    }
  }

  // 分组：主表「分类」列是唯一权威（同文件跨片时写 `S7b（3）+ S7c（1）` 逐点归片）
  const groups = new Map();
  const addTo = (g, n) => groups.set(g, (groups.get(g) || 0) + n);
  for (const row of mainRows) {
    const tail = row.tail;
    const split = [...tail.matchAll(/S7([abc])（(\d+)）/g)];
    if (split.length) { for (const s of split) addTo(`S7${s[1]}`, Number(s[2])); continue; }
    const plain = tail.match(/MIGRATE · S7([abc])/);
    if (plain) { addTo(`S7${plain[1]}`, row.claimed); continue; }
    if (/NOT-OPTION-SURFACE/.test(tail)) { addTo("NOT-OPTION-SURFACE", row.claimed); continue; }
    if (/COMPAT-PIN 格/.test(tail)) { addTo("含 COMPAT-PIN 格", row.claimed); continue; }
    if (/COMPAT-PIN/.test(tail)) { addTo("COMPAT-PIN", row.claimed); continue; }
    if (/OWNED-BY-S5/.test(tail)) { addTo("OWNED-BY-S5", row.claimed); continue; }
    if (/OWNED-BY-S6/.test(tail)) { addTo("OWNED-BY-S6", row.claimed); continue; }
    addTo(`?${tail}`, row.claimed);
  }

  console.log(`主表 ${mainRows.length} 行：表合计 ${mainSum} / AST 合计 ${astMain}`);
  console.log(`附表 ${appRows.length} 行：表合计 ${appSum} / AST 合计 ${astApp}`);
  const groupNames = ["S7a", "S7b", "S7c", "含 COMPAT-PIN 格", "COMPAT-PIN", "OWNED-BY-S5", "OWNED-BY-S6", "NOT-OPTION-SURFACE"];
  for (const g of groupNames) console.log(`  ${g.padEnd(18)} 逐点归片合计 ${groups.get(g) ?? 0}`);
  const groupSum = [...groups.entries()].filter(([g]) => g !== "S7a").reduce((s, [, v]) => s + v, 0);
  console.log(`  非 S7a 合计 ${groupSum}（应 = 主表合计 ${mainSum}）`);
  if (summary.length) {
    console.log(`分派小结 ${summary.length} 行：`);
    const groupOf = (label) => {
      const m = label.match(/S7([abc])/);
      if (m) return `S7${m[1]}`;
      if (/NOT-OPTION-SURFACE/.test(label)) return "NOT-OPTION-SURFACE";
      if (/含 COMPAT-PIN 格/.test(label)) return "含 COMPAT-PIN 格";
      if (/COMPAT-PIN/.test(label)) return "COMPAT-PIN";
      if (/OWNED-BY-S5/.test(label)) return "OWNED-BY-S5";
      if (/OWNED-BY-S6/.test(label)) return "OWNED-BY-S6";
      return null;
    };
    let sumPoints = 0;
    let totalPoints = null;
    for (const s of summary) {
      const g = groupOf(s.label);
      const isTotal = /合计/.test(s.label);
      if (isTotal) totalPoints = s.points;
      else sumPoints += s.points;
      const actual = isTotal ? astMain : (groups.get(g) ?? 0);
      const ok = s.points === actual;
      if (!ok) bad.push(`分派小结 ${s.label}：表 ${s.points} / 逐点归片 ${actual}`);
      let filesOk = true;
      if (!isTotal && g !== "S7a") {
        const rows = listRows.get(g);
        if (rows) { filesOk = rows.length === s.files; if (!filesOk) bad.push(`分派小结 ${s.label}：文件 ${s.files} / 清单 ${rows.length} 行`); }
      }
      console.log(`  表 ${s.label}：文件 ${s.files} / 写点 ${s.points}（逐点归片 ${actual}${filesOk ? "" : "，文件数不符"}）${ok && filesOk ? " ✅" : " ✗"}`);
    }
    if (totalPoints !== null && sumPoints !== totalPoints) {
      bad.push(`分派小结列和 ${sumPoints} ≠ 合计 ${totalPoints}`);
      console.log(`  列和 ${sumPoints} ≠ 合计 ${totalPoints} ✗`);
    } else if (totalPoints !== null) {
      console.log(`  列和 ${sumPoints} = 合计 ${totalPoints} ✅`);
    }
  }
  for (const [g, rows] of listRows) {
    console.log(`  清单 ${g.padEnd(16)} ${rows.length} 行 / 表列写点 ${rows.reduce((a, r) => a + r.claimed, 0)}`);
  }
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
