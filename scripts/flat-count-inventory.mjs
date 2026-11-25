#!/usr/bin/env node
/**
 * 扁平选项写点计数器 + 白名单核对器（#498 S7；#529 落进仓库；#907 删台账、判据换成白名单）。
 *
 * **#529：这份脚本以前只以 heredoc 形式活在 `test/compat-pin-inventory.md` 的「复跑方法」里，
 * 复跑命令指向仓库外的 `/tmp/flat-count.cjs`** —— 于是复跑一次都要靠仓库外的临时文件。
 * 现在它就在树上，命令一律写 `node scripts/flat-count-inventory.mjs …`；**`/tmp/` 不再是复现基准**。
 *
 * **#907：台账 `test/compat-pin-inventory.md`（每文件点数抄进表、每动一次代码就要 `--sync` 重刷）已删。**
 * 但台账兼着的一条**活判据**留下：0.28 破坏性退役了顶层扁平选项拼写，于是「没登记过的文件不许在
 * `test/**` 里写退役的扁平拼写」是真的（报错见 `src/assembly-validators.js`）。载体从「每文件点数抄进表」
 * 换成白名单 `scripts/compat-pin-allowlist.mjs`（只有 `file` + `surfaces`，没有点数、没有合计、没有人格）。
 * 于是行为改变：**清单内文件的点数怎么变都不再红**（旧台账要求逐行等值；白名单不核点数）。
 *
 * 用法（在仓库根跑；需要 `typescript`，仓库 devDependencies 里有，`npm ci` 后就有）：
 *   node scripts/flat-count-inventory.mjs .                       # 三个总数
 *   node scripts/flat-count-inventory.mjs . --files               # 逐文件明细（现算真值，清单就照它生成）
 *   node scripts/flat-count-inventory.mjs . --keys                # 逐键明细
 *   node scripts/flat-count-inventory.mjs . --verify              # 白名单判据（不一致 ⇒ exit 1）
 *   node scripts/flat-count-inventory.mjs . --verify <allowlist>  # 同上，但用给定清单模块（self-test / 夹具）
 *   node scripts/flat-count-inventory.mjs . --self-test           # 内置夹具自检（不外接文件）
 *   node scripts/flat-count-inventory.mjs /tmp/base-498           # 迁移前基线（388 / 678）
 *
 * `--verify` 的白名单判据只核两件事（语义强度红线，不许只留打印）：
 *   · AST 算出某 (文件, 面) 有点数，而清单里没有该 (文件, 面) ⇒ **红并点名文件 / 面 / 点数**；
 *   · 清单条目指向已不存在的文件 ⇒ **红并点名**（防清单腐烂）。
 *   清单内文件的点数变化**不红**——这是相对旧台账的有意行为改变。
 *
 * 面名（`surfaces`）用 AST 自己用的那两个：`CAPABILITY_FACE`→`cap`、`DATA_KEYS`→`data`。
 *
 * 口径（五条，缺一条数就对不上）：
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
import { pathToFileURL } from "node:url";
import { FLAT_WRITE_ALLOWLIST } from "./compat-pin-allowlist.mjs";

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
//     没有子键 ⇒ 不是壳。S3 删它们是一键一处改写，不是拆壳；它们的消费者面用「删键后全量红格数」校准。
//
// 注意：`partialPersistence` 在 A12 已经**退役顶层扁平写法**（规范之家 `config.run.partialPersistence`），
// 但它**仍留在键表里**——因为「拒绝钉」本身就要在 `test/**` 里写一次扁平拼写来证明它被拒。
// 数的是「写点」，不是「被接受的写法」。
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

/** 明细列：按写点数降序、同数按名字升序（`--files` 用，全键一起列）。 */
function detailOf(v, face) {
  return [...v.byKey.entries()]
    .filter(([k]) => face === undefined || (face === "cap" ? CAPABILITY_FACE.has(k) : !CAPABILITY_FACE.has(k)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, c]) => `\`${k}\`×${c}`).join(", ");
}

// ─────────────────────────────────── 白名单判据（#907） ───────────────────────────────────

/**
 * 白名单判据的纯函数（不做 IO 之外的输出）：给定 (root, allowlist)，返回问题清单字符串数组。
 *   ① AST 算出某 (文件, 面) 有点数，而清单里没有该 (文件, 面) ⇒ 一条，点名文件 / 面 / 点数；
 *   ② 清单条目指向已不存在的文件 ⇒ 一条，点名文件（防清单腐烂）。
 * 清单内文件的点数变化**不产生**任何条目（相对旧台账的有意行为改变）。
 */
function checkWhitelist(root, allowlist) {
  const { per } = count(root);
  const listed = new Map();
  for (const e of allowlist) {
    if (!listed.has(e.file)) listed.set(e.file, new Set());
    for (const s of e.surfaces) listed.get(e.file).add(s);
  }
  const problems = [];
  for (const [file, v] of per) {
    const sur = listed.get(file) || new Set();
    if (v.cap > 0 && !sur.has("cap")) problems.push(`  ✗ 清单外写点：${file} 能力面（cap） ${v.cap} 点，白名单没有该 (文件, cap)`);
    if (v.data > 0 && !sur.has("data")) problems.push(`  ✗ 清单外写点：${file} 数据面（data） ${v.data} 点，白名单没有该 (文件, data)`);
  }
  for (const e of allowlist) {
    if (!fs.existsSync(path.join(root, e.file))) problems.push(`  ✗ 白名单条目指向已不存在的文件：${e.file}`);
  }
  return problems;
}

function reportWhitelist(problems, allowlist) {
  for (const p of problems) console.log(p);
  if (problems.length) console.log(`白名单核对：${problems.length} 处不一致`);
  else console.log(`白名单核对：通过（清单 ${allowlist.length} 条，清单外无写点、条目无失效文件）`);
}

/** `--verify [allowlist]`：allowlist 省略 ⇒ 用仓库内 `compat-pin-allowlist.mjs`；给定 ⇒ 动态载入（self-test / 夹具）。 */
async function loadAllowlist(allowlistPath) {
  if (!allowlistPath) return FLAT_WRITE_ALLOWLIST;
  const url = pathToFileURL(path.resolve(allowlistPath)).href;
  const mod = await import(url);
  return mod.FLAT_WRITE_ALLOWLIST;
}

async function verifyWhitelist(root, allowlistPath) {
  const allowlist = await loadAllowlist(allowlistPath);
  const problems = checkWhitelist(root, allowlist);
  reportWhitelist(problems, allowlist);
  return problems.length;
}

/** 内置夹具自检（不外接文件，跑在真仓树上）：三条判据各验一遍，任一不成立 ⇒ exit 1。 */
function selfTest() {
  const full = FLAT_WRITE_ALLOWLIST;
  let ok = true;
  const fail = (m) => { console.log(`✗ self-test: ${m}`); ok = false; };
  if (full.length === 0) fail("白名单为空，无法验证「清单外 ⇒ 红」");
  else {
    // ① 把某个确有点数的清单文件从清单里去掉 ⇒ 它变成「清单外」 ⇒ 必须红并点名它。
    const target = full[0].file;
    const probs = checkWhitelist(".", full.filter((e) => e.file !== target));
    if (probs.some((p) => p.includes(target))) console.log(`✓ self-test: 清单外文件 ${target} 有点 ⇒ 红并点名该文件`);
    else fail(`移除 ${target} 后应点名该文件，实得：${probs.join(" | ") || "(空)"}`);
    // ② 完整清单 ⇒ 0 问题（清单内文件的点数如何都不红）。
    const green = checkWhitelist(".", full);
    if (green.length === 0) console.log(`✓ self-test: 完整清单 0 问题（清单内点数变化不红）`);
    else fail(`完整清单应 0 问题，实得 ${green.length}：${green.join(" | ")}`);
    // ③ 幽灵条目（指向不存在的文件）⇒ 必须红并点名它。
    const ghost = "test/__allowlist_ghost_907__.test.js";
    const ghostProbs = checkWhitelist(".", [...full, { file: ghost, surfaces: ["data"] }]);
    if (ghostProbs.some((p) => p.includes(ghost))) console.log(`✓ self-test: 清单条目指向不存在的文件 ⇒ 红并点名`);
    else fail(`幽灵条目 ${ghost} 应被点名，实得：${ghostProbs.join(" | ") || "(空)"}`);
  }
  console.log(ok ? "self-test: PASS" : "self-test: FAIL");
  return ok ? 0 : 1;
}

async function main() {
  const root = process.argv[2] || ".";
  const mode = process.argv[3] || "";
  if (mode === "--verify") { process.exitCode = (await verifyWhitelist(root, process.argv[4])) === 0 ? 0 : 1; return; }
  if (mode === "--self-test") { process.exitCode = selfTest(); return; }
  const { hits, per } = count(root);
  if (mode === "--files") {
    const rows = [...per.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
    for (const [f, v] of rows) {
      console.log(`${String(v.total).padStart(3)}  ${f}  |  ${detailOf(v)}`);
    }
    console.log(`--- 文件数 ${rows.length}  写点合计 ${rows.reduce((s, [, v]) => s + v.total, 0)}`);
    return;
  }
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
