#!/usr/bin/env node
/**
 * 题库盘点：**行为 → 守护题**（issue #618）。
 *
 * 为什么要有：`#614` 把 CLI 默认压缩策略从 `fold-statistical` 换成 `fold-llm`，发现方式不是
 * 「某个守护者报警」，而是「3 个测试文件意外变红」——**在此之前，「CLI 默认是 fold-statistical」
 * 这件事没有任何一条题在守护**。同型问题：题库按**工单**长（`test/compact/` 里大量 `-601/-603/-605`
 * 这类文件名），同一行为被多文件重复守护；真机层（`check:release:real`）有整片空白。
 * 本脚本只把事实摆成四张表，**不改、不删、不合并任何测试**——处置另开单。
 *
 * ── 四张表 ────────────────────────────────────────────────────────────────────
 *  表 1 默认值/常量的守护者：`src/` + `bin/` 里 `export const DEFAULT_*` / `*_DEFAULT`，加上
 *       工单点名的关键行为常量（`PINNED_CONSTANTS`）。每行给出「被哪些测试文件按名字命中」，
 *       **0 个 = 零守护**并高亮。`bin/` 也在扫描面里是刻意的：`DEFAULT_COMPACTION_STRATEGY`
 *       就住在 `bin/config.js`，只扫 `src/` 会把这张票最核心的历史证据漏掉。
 *  表 2 行为 → 守护题（按 `src/` 模块聚合）：每个模块被多少测试文件引用、其中哪些按工单号命名
 *       （`-\d{3}\.test\.js`）、是否「冗余守护候选」（同模块被 ≥3 个工单号文件覆盖）。
 *  表 3 测试文件画像：spawn 子进程 / 依赖真上游（`ERIX_E2E_REAL`）/ 有 `skip` / 工单号命名 / 用例数。
 *  表 4 只有离线、没有真机：`src/` 模块被 `test/` 覆盖、但**静态证据里**不出现在发版真机清单
 *       （`scripts/release-real-check.mjs` 的 STEPS）的覆盖面里；按 `src/` 分区汇总出「真机空白面」。
 *
 * ── 口径（每一句都可复算；改口径先改这里）──────────────────────────────────────
 *  1. 扫描面 = `<root>/src/**` + `<root>/bin/**`（模块与常量）、`<root>/test/**\/*.test.js`
 *     （守护题）、发版真机清单点名的文件（真机面）。`test/helpers/`、`test/fixtures/`、
 *     `test/contract/` **不算题**：它们是夹具/发布面，不是守护者。
 *  2. 「引用」= **静态扫 import + 字符串路径**，不靠文件系统猜、不靠 `node --test` 运行时观测：
 *     · `from "…"` / `import "…"` / `import("…")` / `require("…")` 的 specifier；
 *     · 字面路径字符串：`"../src/x.js"`、`"src/x.js"`（只认这两种形状）。
 *     specifier 按**引用方所在目录**解析成仓内相对路径，只有落进 `src/` **且文件真在语料里**才算命中。
 *     两个**刻意收紧**的口径（都是为了不假绿）：
 *       · 先 `stripComments()` **剥注释**——注释里随手写的 `` `src/x.js` `` 不是引用（本仓实测：
 *         `examples/cross-version-real-e2e.test.mjs` 的注释会把 `src/loop/resume-manager.js` 变成
 *         假「真机覆盖」，表 4 直接少一行）；
 *       · 字面路径**不认反引号**（模板字符串里的路径几乎都在注释/文档里），也不认
 *         `join(root, "src", "index.js")` 这种拼接式提及。代价是下界——宁可表难看，也不要假绿。
 *  3. 「按名字命中」= 标识符边界出现（`(?<![\w$])NAME(?![\w$])`），**注释里的提及也算**（工单口径是
 *     「搜这个名字」——与口径 2 故意不一致）。额外给一列 `importedBy`（真的 import 了这个名字的文件数），
 *     `hits > 0 且 importedBy === 0` 的行标「仅提及」——提醒读者「命中 ≠ 断言」。
 *     计数一律 `matchAll` 新建正则（`g` + `.test()` 是有状态的，本仓明文警告过）。
 *  4. 覆盖分**三桶且互斥**（表 2 / 表 4 的分母就是这个）：
 *     · **直接覆盖** = 测试文件直接 import 它；
 *     · **间接覆盖** = 没有测试直接 import，但某个被测试引用的 `src/` 模块（沿 `src/` 内部引用反向边，
 *       可多跳）引用它。不做这一步，`src/tool-fact.js`（只经 `src/index.js` 再导出）会被误报成真缺口；
 *     · **真缺口** = 直接与间接都为零（工单预期为 0，不为 0 就点名）。
 *     表 4 的分母是「直接 ∪ 间接」：只经 `src/index.js` 被跑到的模块也算被 `test/` 覆盖。
 *  5. 「真机面」= `scripts/release-real-check.mjs` 的 `STEPS` 里 `argv` 点名的文件 + 运行器自己 +
 *     `examples/e2e-real-gate.mjs`（闸门模块）。**清单从脚本现读**，不另抄一份。
 *     另有 `ORPHAN_PATTERNS`：`examples/**\/*real-e2e*` / `scripts/*real-smoke*` 里**没被 STEPS 点名**的
 *     文件单列成「孤儿真机件」——它们存在、能跑，但发版清单不会跑它们。
 *     ⚠ 已知下界：`cli-real-smoke.mjs` 与 `release-real-check.mjs` 打的是 **CLI 子进程**，
 *     静态扫不到它实际跑到的模块 ⇒ 表 4 的行是「静态证据里没有真机覆盖」，**不是**「一定没被真机跑到」。
 *  6. 「用例数」是**估算**：`\btest\s*\(` 出现次数（不含 `describe(` 包装、不展开表驱动循环，
 *     `it(` 形态与「用例交给 `test/contract/*.js` 共享 runner」的 0 行会标出来）。真值只有 `node --test` 说了算。
 *
 * ── 退出码（本仓惯例：读不出真值就红，不许假绿）──────────────────────────────
 *  0 = 盘点完成（**不代表任何判定**：零守护、冗余守护、真机空白都不是错误，处置另开单）。
 *  2 = 读不到真相。`--json` 的 `errors[].code` 逐类可区分：
 *      CORPUS_DIR_UNREADABLE       扫描面目录不存在/读不出（静默跳过会让表少一块）
 *      CORPUS_FILE_UNREADABLE      扫描面里的文件读不出
 *      RELEASE_STEPS_UNREADABLE    发版真机清单的 STEPS 解析不出文件（不知道真机面有哪些）
 *      RELEASE_STEP_MISSING        STEPS 点名的文件不存在
 *      PINNED_CONSTANT_MISSING     `PINNED_CONSTANTS` 里的常量在 `src/`+`bin/` 找不到声明
 *                                  （导出名解析失败 ⇒ 表 1 少一行，那是假表）
 *      DUPLICATE_CONSTANT          同名常量在两个文件里各声明一次（口径歧义，按首个记账并报出）
 *  1 = `--self-test` 有判据没过（反向证失败）。变异**没落上**也算失败（#210 R2 口径）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *   node scripts/test-corpus-inventory.mjs                  # 人读报告（四张表）
 *   node scripts/test-corpus-inventory.mjs --json            # 机器读（同样的事实）
 *   node scripts/test-corpus-inventory.mjs --root <dir>      # 换根目录
 *   node scripts/test-corpus-inventory.mjs --self-test       # 反向证（4 类）
 *
 * **不 gate**：本脚本不进 CI、不改 `package.json`（照 `check:exports` 的先例，先读几轮再谈）。
 * 自测的变异全打在**内存副本**上（真树只读，一个字节也不写，`test/` 不被碰）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 扫描面里**必须存在**的目录：缺一个就是「读不出真值」（静默跳过会让表少一块）。 */
export const REQUIRED_DIRS = ["src", "bin", "test", "examples", "scripts"];
/** 常量扫描面（表 1）。`bin/` 不是多余的：CLI 的默认值住在那里（#614 的教训）。 */
export const CONSTANT_DIRS = ["src", "bin"];
/** 工单点名的关键行为常量（表 1 的固定行；找不到声明 ⇒ exit 2）。 */
export const PINNED_CONSTANTS = Object.freeze([
  "WORKING_SET_RECENT_ROUNDS",
  "FOLD_SUMMARY_RECENT_FOLDS",
  "MAX_OLDER_FOLD_TITLES",
  "PENDING_TOOL_RESULT_TEXT",
  "DEFAULT_FOLD_ARCHIVE_MAX_BYTES",
]);
/** 发版真机清单的运行器（它自己也是真机面的一部分：它点名每一步）。 */
export const RELEASE_RUNNER = "scripts/release-real-check.mjs";
/** 真机闸门模块（所有真机步骤共用；它自己引用 0 个 `src/` 模块，但它是真机面的一员）。 */
export const RELEASE_GATE = "examples/e2e-real-gate.mjs";
/** 孤儿真机件的发现口径（存在、但发版清单不跑）。 */
export const ORPHAN_PATTERNS = Object.freeze([
  { dir: "examples", re: /real-e2e/u },
  { dir: "scripts", re: /real-smoke/u },
]);
/** 表 2 的「冗余守护候选」阈值：同一模块被 ≥3 个工单号文件覆盖。 */
export const REDUNDANT_THRESHOLD = 3;
/** 工单号命名的测试文件（`…-601.test.js`）。 */
export const ISSUE_NAMED_RE = /-[0-9]{3}\.test\.(?:js|mjs)$/u;
/** 守护题的形状（`test/**\/*.test.js`；`test/helpers/` 之类不是题）。 */
export const TEST_FILE_RE = /^test\/(?:[^/]+\/)*[^/]+\.test\.(?:js|mjs)$/u;
/** 默认值/常量的名字形状（表 1 的自动发现口径）。 */
const DEFAULT_NAME_RE = /^(?:DEFAULT_[A-Za-z0-9_]*|[A-Za-z0-9_]*_DEFAULT)$/u;

const CODE_EXTS = [".js", ".mjs", ".cjs"];

/** 口径常量原样进 `--json`，读者不用读代码就知道每列是怎么来的。 */
export const CRITERIA = Object.freeze({
  scanSurface: "src/** + bin/**（模块与常量）· test/**/*.test.js（守护题）· 发版真机清单点名的文件（真机面）",
  reference: "静态扫 import/require/dynamic-import 的 specifier + 字面路径字符串（'../src/x.js' / 'src/x.js'）；先剥注释（注释里的路径不算引用）、不认反引号与拼接式 join(root,'src',…)；按引用方目录解析，落进 src/ 且文件在语料里才算命中",
  guardHit: "标识符边界出现次数（注释里的提及也算）；importedBy = 真的 import 了这个名字的文件数",
  coverageBuckets: "直接覆盖（测试直接 import）/ 间接覆盖（沿 src/ 内部引用反向边、可多跳）/ 真缺口（两者都为零）；三桶互斥，表 4 的分母是直接∪间接",
  realSurface: "release-real-check.mjs 的 STEPS argv 点名 + 运行器自己 + examples/e2e-real-gate.mjs；孤儿件 = examples/**/*real-e2e* / scripts/*real-smoke* 里没被点名的",
  caseCount: "估算：\\btest\\s*\\( 出现次数（不含 describe 包装、不展开表驱动；it( 形态会标 0）",
  redundantGuard: `同一 src/ 模块被 ≥${REDUNDANT_THRESHOLD} 个工单号命名的测试文件覆盖`,
  gate: "false —— 本脚本不进 CI、不参与任何门禁判定",
});

// ─────────────────────────────── 通用小工具 ───────────────────────────────

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 标识符边界命中数。**每次新建正则**（`g` 配 `.test()` 是有状态的，会漏报）。 */
export function countIdent(text, name) {
  if (!text || !name) return 0;
  const re = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, "gu");
  let n = 0;
  for (const _ of text.matchAll(re)) n += 1;
  return n;
}

/** 仓内相对路径 → 盘上路径（只在本脚本读文件时用）。 */
function toAbs(root, rel) {
  return posix.join(root.replace(/\\/gu, "/"), rel);
}

function isCodeFile(rel) {
  return CODE_EXTS.some((ext) => rel.endsWith(ext));
}

function walkRel(root, dir, out, errors) {
  let entries;
  try {
    entries = readdirSync(toAbs(root, dir), { withFileTypes: true });
  } catch (err) {
    errors.push({ code: "CORPUS_DIR_UNREADABLE", message: `目录读不到：${dir}（${err?.message ?? err}）——少扫一块，表就不是真值` });
    return out;
  }
  for (const entry of entries) {
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkRel(root, rel, out, errors);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** 语料 = 内存里的 `{rel, text, role?}` 数组。真树扫描与 `--self-test` 走**同一条**分析路径。 */
export function readCorpus(root = DEFAULT_ROOT) {
  const errors = [];
  const records = [];
  const seen = new Set();

  const readOne = (rel, role) => {
    if (seen.has(rel)) {
      const prev = records.find((r) => r.rel === rel);
      if (prev && role && prev.role !== role) prev.roles = [...new Set([...(prev.roles ?? [prev.role]), role])];
      return;
    }
    let text;
    try {
      if (!statSync(toAbs(root, rel)).isFile()) return;
      text = readFileSync(toAbs(root, rel), "utf8");
    } catch (err) {
      errors.push({ code: "CORPUS_FILE_UNREADABLE", message: `文件读不到：${rel}（${err?.message ?? err}）` });
      return;
    }
    seen.add(rel);
    records.push(role ? { rel, text, role } : { rel, text });
  };

  for (const dir of REQUIRED_DIRS) {
    try {
      if (!statSync(toAbs(root, dir)).isDirectory()) throw new Error("不是目录");
    } catch (err) {
      errors.push({ code: "CORPUS_DIR_UNREADABLE", message: `扫描面目录不存在：${dir}（${err?.message ?? err}）——没有它这张表就是假表` });
    }
  }

  // 模块面 + 常量面
  for (const dir of CONSTANT_DIRS) {
    const files = walkRel(root, dir, [], errors).filter(isCodeFile).sort();
    for (const rel of files) readOne(rel);
  }
  // 守护题面
  const testFiles = walkRel(root, "test", [], errors).filter((rel) => TEST_FILE_RE.test(rel)).sort();
  for (const rel of testFiles) readOne(rel);

  // 真机面：发版清单现读，不另抄一份
  const release = resolveReleaseSurfaces(root, errors);
  for (const rel of release.files) readOne(rel, "release-step");
  // 孤儿真机件（存在、但发版清单不跑）：单列成 role，表 4 用它标「只被孤儿件引用」
  const orphans = resolveOrphanSurfaces(root, release.files, errors);
  for (const rel of orphans) readOne(rel, "orphan");

  return {
    records, errors, root,
    releaseSurfaces: release.files,
    releaseSteps: release.steps,
    orphanSurfaces: orphans,
  };
}

/**
 * 从 `release-real-check.mjs` 的 `STEPS` 里读出每一步点名的文件（+ 运行器自己 + 闸门模块）。
 *
 * @returns {{files: string[], steps: string[]}} `steps` = STEPS 真点名的文件（不含运行器/闸门）
 */
export function resolveReleaseSurfaces(root, errors = []) {
  const out = [];
  const add = (rel) => { if (rel && !out.includes(rel)) out.push(rel); };
  let text = null;
  try {
    text = readFileSync(toAbs(root, RELEASE_RUNNER), "utf8");
  } catch (err) {
    errors.push({ code: "RELEASE_STEPS_UNREADABLE", message: `发版真机清单读不到：${RELEASE_RUNNER}（${err?.message ?? err}）——真机面就是未知数` });
    return { files: out, steps: [] };
  }
  // 只认 `argv: [ … ]` 里的字符串字面量，别把注释里的例子当步骤。
  const argvBlocks = [...text.matchAll(/argv\s*:\s*\[([\s\S]*?)\]/gu)].map((m) => m[1]);
  const steps = [];
  for (const block of argvBlocks) {
    for (const m of block.matchAll(/["']([^"']+)["']/gu)) {
      if (isCodeFile(m[1])) steps.push(m[1]);
    }
  }
  if (steps.length === 0) {
    errors.push({ code: "RELEASE_STEPS_UNREADABLE", message: `从 ${RELEASE_RUNNER} 的 STEPS 里一个步骤文件都没解析出来——真机面不是真值` });
    return { files: out, steps: [] };
  }
  const landed = [];
  for (const rel of steps) {
    try {
      if (!statSync(toAbs(root, rel)).isFile()) throw new Error("不存在");
    } catch (err) {
      errors.push({ code: "RELEASE_STEP_MISSING", message: `发版清单点名的文件不存在：${rel}（${err?.message ?? err}）` });
      continue;
    }
    landed.push(rel);
    add(rel);
  }
  try {
    if (statSync(toAbs(root, RELEASE_GATE)).isFile()) add(RELEASE_GATE);
  } catch { /* 闸门模块缺席只影响真机面的完整性，下面由自测的结构不变量兜住 */ }
  return { files: out, steps: landed };
}

/** 孤儿真机件：存在、但发版清单不跑（`fold-605-real-e2e.mjs` 就是这一类）。 */
export function resolveOrphanSurfaces(root, releaseSurfaces, errors = []) {
  const out = [];
  for (const { dir, re } of ORPHAN_PATTERNS) {
    for (const rel of walkRel(root, dir, [], errors)) {
      if (!isCodeFile(rel)) continue;
      if (!re.test(rel)) continue;
      if (releaseSurfaces.includes(rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

// ─────────────────────────────── 引用抽取（口径 2）───────────────────────────────

/**
 * 剥掉注释（`//` 与 `/* … *\/`），保留字符串字面量内部的 `//`（URL 之类）。
 *
 * 为什么要剥：**「引用」指的是代码里的引用**。不剥的话，注释里随手写的
 * `` `src/loop/resume-manager.js` `` 会被当成「这个模块被真机面覆盖」，把表 4 打成假绿
 * （本仓实测：`examples/cross-version-real-e2e.test.mjs` 的注释就贡献了一个假命中）。
 * ⚠ 与口径 3（表 1 的「按名字命中」）**故意不一致**：那边是「搜这个名字」，注释也算。
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let state = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === state) state = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { state = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 从一个文件的源码里抽出**可能是仓内相对路径**的 specifier。
 * 返回值可能含噪声——真正的过滤在 `resolveSpecifier()` + 「文件在语料里」。
 * 口径细节：
 *  · 先 `stripComments()`（注释里的路径不算引用）；
 *  · 字面路径字符串**只认 `"` 与 `'`**，不认反引号——模板字符串里的路径几乎都在注释/文档里，
 *    收进来会把表 4 打成假绿；代价是 `` `${root}/src/x.js` `` 这类拼接式提及不计（已在口径里声明）。
 *
 * @returns {string[]}
 */
export function extractSpecifiers(text) {
  const out = [];
  const push = (spec) => { if (spec) out.push(spec); };
  const code = stripComments(text);
  for (const m of code.matchAll(/\bfrom\s*["']([^"'\n]+)["']/gu)) push(m[1]);
  for (const m of code.matchAll(/\bimport\s*["']([^"'\n]+)["']/gu)) push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu)) push(m[1]);
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/gu)) push(m[1]);
  for (const m of code.matchAll(/["'](\.{1,2}\/[^"'\n]*?\.(?:js|mjs|cjs))["']/gu)) push(m[1]);
  for (const m of code.matchAll(/["'](src\/[^"'\n]*?\.(?:js|mjs|cjs))["']/gu)) push(m[1]);
  return out;
}

/**
 * specifier → 仓内相对路径（按引用方所在目录解析）。非相对/非 `src/` 开头的一律 null。
 * 解析结果**不保证存在**——存在性由调用方用语料核对（那就是口径 2 的过滤）。
 */
export function resolveSpecifier(spec, fromRel) {
  if (typeof spec !== "string" || !spec) return null;
  if (spec.startsWith("src/")) return posix.normalize(spec);
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  return posix.normalize(posix.join(posix.dirname(fromRel), spec)).replace(/^\.\//u, "");
}

/** `import { A, B } from "x"` 的「子句」文本（用来判断某个名字是不是真被 import 了）。 */
export function importClauses(text) {
  const out = [];
  for (const m of text.matchAll(/\bimport\s+([^;]*?)\s+from\s*["']([^"'\n]+)["']/gu)) {
    out.push({ clause: m[1], spec: m[2] });
  }
  return out;
}

// ─────────────────────────────── 分析（四张表）───────────────────────────────

/**
 * 纯函数：给一组 `{rel, text, role?}` 记录，算出四张表。
 * 真树扫描与 `--self-test` 走**同一条**路径（自测的变异就打在记录的副本上）。
 */
export function analyze(corpus, opts = {}) {
  const pinned = opts.pinned ?? PINNED_CONSTANTS;
  const threshold = opts.redundantThreshold ?? REDUNDANT_THRESHOLD;
  const records = corpus.records ?? [];
  const errors = [...(corpus.errors ?? [])];
  const warnings = [];

  const modules = records.filter((r) => r.rel.startsWith("src/")).map((r) => r.rel).sort();
  const moduleSet = new Set(modules);
  const tests = records.filter((r) => TEST_FILE_RE.test(r.rel)).map((r) => r.rel).sort();
  const constSources = records.filter((r) => CONSTANT_DIRS.some((d) => r.rel.startsWith(`${d}/`)));
  const byRel = new Map(records.map((r) => [r.rel, r]));
  const roleOf = (rec) => rec.role ?? (rec.roles?.includes("release-step") ? "release-step" : null);

  // 引用索引：每个文件 → 它引用的 src/ 模块集合（口径 2）。src/ 内部的边单存一份，用于「间接覆盖」。
  const refIndex = new Map();
  const srcImporters = new Map(); // module → [引用它的 src 模块…]（反向边）
  for (const module of modules) srcImporters.set(module, []);
  for (const rec of records) {
    const refs = new Set();
    for (const spec of extractSpecifiers(rec.text)) {
      const resolved = resolveSpecifier(spec, rec.rel);
      if (resolved && resolved !== rec.rel && moduleSet.has(resolved)) refs.add(resolved);
    }
    if (rec.rel.startsWith("src/")) {
      for (const target of refs) srcImporters.get(target)?.push(rec.rel);
      continue;
    }
    refIndex.set(rec.rel, refs);
  }

  // ── 表 1：默认值/常量的守护者 ──────────────────────────────────────────────
  const decls = [];
  const declByName = new Map();
  const addDecl = (decl) => {
    const prev = declByName.get(decl.name);
    if (prev) {
      if (prev.def !== decl.def) {
        errors.push({
          code: "DUPLICATE_CONSTANT",
          message: `常量 \`${decl.name}\` 在两个文件各声明一次（${prev.def}:${prev.line} / ${decl.def}:${decl.line}）——`
            + "表 1 按首个记账，守护者数只对首个成立",
        });
      }
      return;
    }
    declByName.set(decl.name, decl);
    decls.push(decl);
  };
  for (const rec of constSources) {
    rec.text.split("\n").forEach((line, i) => {
      const m = /^\s*export const ([A-Za-z_$][\w$]*)\s*=/u.exec(line);
      if (!m) return;
      if (!DEFAULT_NAME_RE.test(m[1])) return;
      addDecl({ name: m[1], def: rec.rel, line: i + 1, source: "auto" });
    });
  }
  for (const name of pinned) {
    let found = null;
    for (const rec of constSources) {
      const lines = rec.text.split("\n");
      const idx = lines.findIndex((line) => new RegExp(`^\\s*export const ${escapeRe(name)}(?![\\w$])`, "u").test(line));
      if (idx >= 0) { found = { name, def: rec.rel, line: idx + 1, source: "pinned" }; break; }
    }
    if (!found) {
      errors.push({
        code: "PINNED_CONSTANT_MISSING",
        message: `\`PINNED_CONSTANTS\` 里的 \`${name}\` 在 ${CONSTANT_DIRS.map((d) => `${d}/`).join("+")} 找不到 \`export const\` 声明`
          + "——表 1 会少一行，那不是真表",
      });
      continue;
    }
    addDecl(found);
  }

  const testTexts = tests.map((rel) => ({ rel, text: byRel.get(rel).text }));
  const table1 = decls.map((decl) => {
    const guardFiles = [];
    let importedBy = 0;
    for (const { rel, text } of testTexts) {
      const hits = countIdent(text, decl.name);
      if (hits > 0) guardFiles.push({ rel, hits });
      if (importClauses(text).some((c) => countIdent(c.clause, decl.name) > 0)) importedBy += 1;
    }
    guardFiles.sort((a, b) => b.hits - a.hits || a.rel.localeCompare(b.rel));
    const guardCount = guardFiles.length;
    const hits = guardFiles.reduce((sum, f) => sum + f.hits, 0);
    return {
      name: decl.name,
      def: decl.def,
      line: decl.line,
      source: decl.source,
      guardCount,
      hits,
      importedBy,
      guardFiles,
      zeroGuard: guardCount === 0,
      mentionOnly: guardCount > 0 && importedBy === 0,
    };
  });
  table1.sort((a, b) => Number(b.zeroGuard) - Number(a.zeroGuard) || a.guardCount - b.guardCount || a.name.localeCompare(b.name));

  // ── 表 2：行为 → 守护题（按 src/ 模块聚合）──────────────────────────────────
  const testRefs = new Map(); // module → [testRel…]
  for (const module of modules) testRefs.set(module, []);
  for (const rel of tests) {
    for (const module of refIndex.get(rel) ?? []) {
      const list = testRefs.get(module);
      if (list) list.push(rel);
    }
  }
  const table2 = modules.map((module) => {
    const files = (testRefs.get(module) ?? []).slice().sort();
    const issueNamedFiles = files.filter((rel) => ISSUE_NAMED_RE.test(rel));
    // 直接引用为 0 时，再沿 `src/` 内部的引用反向边找「间接覆盖」：测试引用 A、A 引用 M ⇒ M 也被跑到了。
    // 不做这一步，`src/tool-fact.js`（只经 `src/index.js` 再导出）会被误报成真缺口。
    const indirectFiles = files.length === 0 ? indirectTestRefs(module, srcImporters, testRefs) : [];
    return {
      module,
      area: areaOf(module),
      refCount: files.length,
      files,
      issueNamedFiles,
      redundantGuardCandidate: issueNamedFiles.length >= threshold,
      indirectFiles,
      indirectVia: indirectFiles.length
        ? (srcImporters.get(module) ?? []).filter((m) => (testRefs.get(m) ?? []).length > 0).sort()
        : [],
      offlineCovered: files.length > 0 || indirectFiles.length > 0,
      zeroCoverage: files.length === 0 && indirectFiles.length === 0,
    };
  });
  table2.sort((a, b) => b.issueNamedFiles.length - a.issueNamedFiles.length || b.refCount - a.refCount || a.module.localeCompare(b.module));

  // ── 表 3：测试文件画像 ────────────────────────────────────────────────────
  const table3 = tests.map((rel) => {
    const text = byRel.get(rel).text;
    const code = stripComments(text);
    return {
      file: rel,
      // spawn 口径：真的起子进程（`child_process` 或它的调用）。`re.exec(` / `.fork(` 这类
      // 方法调用**不算**（`(?<![\w$.])` 就是为此），否则 22 个文件里有一半是假阳性。
      spawn: /child_process/u.test(code)
        || /(?<![\w$.])(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/u.test(code),
      realUpstream: /ERIX_E2E_REAL/u.test(text),
      skip: /\b(?:test|it|describe|suite|t)\.skip\s*\(/u.test(text) || /\bskip\s*:\s*(?:true|["'`])/u.test(text),
      issueNamed: ISSUE_NAMED_RE.test(rel),
      caseCount: [...text.matchAll(/\btest\s*\(/gu)].length,
    };
  });
  table3.sort((a, b) => a.file.localeCompare(b.file));

  // ── 表 4：只有离线、没有真机 ──────────────────────────────────────────────
  const releaseFiles = records.filter((r) => roleOf(r) === "release-step").map((r) => r.rel).sort();
  const releaseSteps = (corpus.releaseSteps ?? []).slice().sort();
  const orphanFiles = records.filter((r) => r.role === "orphan").map((r) => r.rel).sort();
  const releaseCovered = new Set();
  for (const rel of releaseFiles) for (const module of refIndex.get(rel) ?? []) releaseCovered.add(module);
  const orphanCovered = new Set();
  for (const rel of orphanFiles) for (const module of refIndex.get(rel) ?? []) orphanCovered.add(module);

  const table2ByModule = new Map(table2.map((row) => [row.module, row]));
  const offlineModules = modules.filter((m) => table2ByModule.get(m)?.offlineCovered);
  const table4 = offlineModules
    .filter((module) => !releaseCovered.has(module))
    .map((module) => {
      const row = table2ByModule.get(module);
      return {
        module,
        area: areaOf(module),
        offlineFiles: row.refCount,
        indirectFiles: row.indirectFiles.length,
        issueNamedFiles: row.issueNamedFiles.length,
        orphanOnly: orphanCovered.has(module),
      };
    })
    .sort((a, b) => a.area.localeCompare(b.area) || a.module.localeCompare(b.module));

  const directlyUncovered = modules.filter((m) => (testRefs.get(m) ?? []).length === 0);
  const zeroCoverage = modules.filter((m) => table2ByModule.get(m)?.zeroCoverage);
  const areas = [...new Set(modules.map(areaOf))].sort().map((area) => {
    const inArea = modules.filter((m) => areaOf(m) === area);
    return {
      area,
      modules: inArea.length,
      offline: inArea.filter((m) => table2ByModule.get(m)?.offlineCovered).length,
      releaseCovered: inArea.filter((m) => releaseCovered.has(m)).length,
      orphanOnly: inArea.filter((m) => orphanCovered.has(m) && !releaseCovered.has(m)).length,
      rows: table4.filter((r) => r.area === area).length,
    };
  });
  const blankAreas = areas.filter((a) => a.releaseCovered === 0);

  const summary = {
    modules: modules.length,
    tests: tests.length,
    constants: table1.length,
    zeroGuard: table1.filter((r) => r.zeroGuard).length,
    mentionOnly: table1.filter((r) => r.mentionOnly).length,
    issueNamedTests: table3.filter((r) => r.issueNamed).length,
    spawnTests: table3.filter((r) => r.spawn).length,
    realUpstreamTests: table3.filter((r) => r.realUpstream).length,
    skipTests: table3.filter((r) => r.skip).length,
    caseCountEstimate: table3.reduce((sum, r) => sum + r.caseCount, 0),
    zeroCaseFiles: table3.filter((r) => r.caseCount === 0).map((r) => r.file),
    redundantGuardCandidates: table2.filter((r) => r.redundantGuardCandidate).length,
    releaseSurfaces: releaseFiles.length,
    releaseSteps: releaseSteps.length,
    orphanSurfaces: orphanFiles.length,
    offlineCoveredModules: offlineModules.length,
    releaseCoveredModules: modules.filter((m) => releaseCovered.has(m)).length,
    realBlankRows: table4.length,
    orphanOnlyRows: table4.filter((r) => r.orphanOnly).length,
    directlyUncoveredModules: directlyUncovered.length,
    indirectlyCoveredModules: directlyUncovered.filter((m) => (table2ByModule.get(m)?.indirectFiles.length ?? 0) > 0).length,
    zeroCoverageModules: zeroCoverage.length,
    blankAreas: blankAreas.map((a) => a.area),
  };

  return {
    table1, table2, table3, table4,
    areas, blankAreas, zeroCoverage, directlyUncovered,
    releaseFiles, orphanFiles,
    releaseSteps,
    releaseCovered: [...releaseCovered].sort(),
    orphanCovered: [...orphanCovered].sort(),
    summary, errors, warnings,
    incomplete: errors.length > 0,
  };
}

export function areaOf(moduleRel) {
  const parts = moduleRel.split("/");
  return parts.length <= 2 ? "(root)" : parts[1];
}

/**
 * 间接覆盖：沿 `src/` 内部引用**反向**找——测试引用 A、A 引用 M ⇒ M 也被跑到。
 * 不做这一步，只经 `src/index.js` 再导出的模块（`src/tool-fact.js`）会被误报成真缺口。
 *
 * @param {string} module 目标模块
 * @param {Map<string, string[]>} srcImporters module → 引用它的 src 模块
 * @param {Map<string, string[]>} testRefs module → 直接引用它的测试文件
 * @returns {string[]} 间接把该模块拉进来的测试文件（排序去重）
 */
export function indirectTestRefs(module, srcImporters, testRefs) {
  const seen = new Set([module]);
  const queue = [module];
  const files = new Set();
  while (queue.length) {
    const cur = queue.shift();
    for (const importer of srcImporters.get(cur) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      for (const rel of testRefs.get(importer) ?? []) files.add(rel);
      queue.push(importer);
    }
  }
  return [...files].sort();
}

// ─────────────────────────────── 人读报告 ───────────────────────────────

function pad(text, width) {
  const s = String(text);
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

export function renderReport(inv, { root = DEFAULT_ROOT } = {}) {
  const L = [];
  const s = inv.summary;
  L.push("题库盘点：行为 → 守护题（issue #618）——**只清点，不 gate**（不进 CI、不改 package.json）");
  L.push(`根目录：${root}`);
  L.push(`扫描面：src/ ${s.modules} 个模块 · test/ ${s.tests} 个 *.test.js · 常量 ${s.constants} 个 · `
    + `真机面 ${s.releaseSurfaces} 个文件（发版清单现读）+ 孤儿真机件 ${s.orphanSurfaces} 个`);
  L.push("");
  L.push(`口径：${CRITERIA.reference}`);
  L.push(`      ${CRITERIA.caseCount}`);
  L.push(`      ${CRITERIA.gate}`);
  L.push("");

  // 表 1
  L.push(`## 表 1：默认值/常量的守护者（${s.constants} 行；零守护 ${s.zeroGuard} 行 ← 高亮）`);
  L.push("");
  L.push("| 常量 | 定义 | 守护文件数 | 命中 | 断言它的测试文件 |");
  L.push("|---|---|---|---|---|");
  for (const row of inv.table1) {
    const flag = row.zeroGuard ? "**零守护**" : row.mentionOnly ? "仅提及" : "";
    const files = row.guardFiles.length
      ? row.guardFiles.map((f) => `\`${f.rel}\`×${f.hits}`).join(", ")
      : "—";
    L.push(`| ${row.zeroGuard ? "⚠ " : ""}\`${row.name}\` | \`${row.def}:${row.line}\` | ${row.guardCount} | ${row.hits} | ${files} ${flag}|`);
  }
  L.push("");
  if (s.zeroGuard) {
    L.push("零守护清单（没有任何测试按名字提到它 ⇒ 改这个默认值不会有题变红）：");
    for (const row of inv.table1.filter((r) => r.zeroGuard)) L.push(`  · \`${row.name}\`（\`${row.def}:${row.line}\`）`);
  } else {
    L.push("零守护清单：空（本树的每个默认值/关键常量都至少被一个测试文件提到）。");
  }
  const mentionOnly = inv.table1.filter((r) => r.mentionOnly);
  if (mentionOnly.length) {
    L.push("");
    L.push(`「仅提及」行（有命中但没有任何文件 import 这个名字 ⇒ 命中不等于断言，别当守护）：`
      + mentionOnly.map((r) => `\`${r.name}\``).join("、"));
  }
  L.push("");

  // 表 2
  L.push(`## 表 2：行为 → 守护题（按 src/ 模块聚合；${inv.table2.length} 行，冗余守护候选 ${s.redundantGuardCandidates} 个）`);
  L.push("");
  L.push("| src/ 模块 | 引用它的测试文件数 | 工单号命名的文件 | 冗余守护候选 |");
  L.push("|---|---|---|---|");
  for (const row of inv.table2) {
    const named = row.issueNamedFiles.length
      ? row.issueNamedFiles.map((f) => `\`${f.replace(/^test\//u, "")}\``).join(", ")
      : "—";
    // 直接引用为 0 时把间接覆盖写在同一个格里：否则读者会把「只经 src/index.js 再导出」当成真缺口。
    const refCell = row.refCount > 0
      ? String(row.refCount)
      : row.indirectFiles.length > 0
        ? `0（间接 ${row.indirectFiles.length}）`
        : "**0（真缺口）**";
    L.push(`| \`${row.module}\` | ${refCell} | ${named} | ${row.redundantGuardCandidate ? `**是（${row.issueNamedFiles.length}）**` : ""} |`);
  }
  L.push("");
  const redundant = inv.table2.filter((r) => r.redundantGuardCandidate);
  L.push(redundant.length
    ? `冗余守护候选（同一模块被 ≥${REDUNDANT_THRESHOLD} 个工单号文件覆盖）：${redundant.map((r) => `\`${r.module}\`(${r.issueNamedFiles.length})`).join("、")}`
    : `冗余守护候选：0 个`);
  const indirectOnly = inv.directlyUncovered.filter((m) => (inv.table2.find((r) => r.module === m)?.indirectFiles.length ?? 0) > 0);
  L.push(indirectOnly.length
    ? `零**直接**引用的模块（表 2 只数直接 import；这些是**间接覆盖**，不是真缺口）：`
      + indirectOnly.map((m) => {
        const row = inv.table2.find((r) => r.module === m);
        return `\`${m}\` ← 经 ${row.indirectVia.map((v) => `\`${v}\``).join("、")}（${row.indirectFiles.length} 个测试文件）`;
      }).join("、")
    : "零直接引用的模块：0 个（每个 src/ 模块都被测试文件直接 import）");
  L.push(inv.zeroCoverage.length
    ? `⚠ 真缺口（直接与间接覆盖都为零，工单预期为 0）：${inv.zeroCoverage.map((m) => `\`${m}\``).join("、")}`
    : "真缺口（直接与间接覆盖都为零）：0 个");
  L.push("");

  // 表 3
  L.push(`## 表 3：测试文件画像（${inv.table3.length} 行；spawn ${s.spawnTests} · 真上游 ${s.realUpstreamTests} · skip ${s.skipTests} · 工单号命名 ${s.issueNamedTests}）`);
  L.push("");
  L.push(`用例数合计 **${s.caseCountEstimate}**（${CRITERIA.caseCount}）`);
  if (s.zeroCaseFiles.length) L.push(`估算口径抓不到的 0 行（it( 形态或纯表驱动）：${s.zeroCaseFiles.map((f) => `\`${f}\``).join("、")}`);
  L.push("");
  L.push("| 文件 | spawn | 真上游 | skip | 工单号 | 用例数(估) |");
  L.push("|---|---|---|---|---|---|");
  for (const row of inv.table3) {
    L.push(`| \`${row.file}\` | ${row.spawn ? "✔" : ""} | ${row.realUpstream ? "✔" : ""} | ${row.skip ? "✔" : ""} | ${row.issueNamed ? "✔" : ""} | ${row.caseCount} |`);
  }
  L.push("");

  // 表 4
  L.push(`## 表 4：只有离线、没有真机（${inv.table4.length} 行；其中只被孤儿真机件引用的 ${s.orphanOnlyRows} 行）`);
  L.push("");
  L.push(`真机面（发版清单现读，${inv.releaseFiles.length} 个文件 / ${s.releaseSteps} 步）：${inv.releaseFiles.map((f) => `\`${f}\``).join("、")}`);
  L.push(`孤儿真机件（存在、但发版清单不跑，${inv.orphanFiles.length} 个）：`
    + (inv.orphanFiles.length ? inv.orphanFiles.map((f) => `\`${f}\``).join("、") : "无"));
  L.push(`静态可见的真机覆盖模块（${inv.releaseCovered.length} 个）：`
    + (inv.releaseCovered.length ? inv.releaseCovered.map((m) => `\`${m}\``).join("、") : "无"));
  L.push("");
  L.push("| src/ 模块 | 分区 | 直接文件数 | 间接文件数 | 工单号文件数 | 只被孤儿真机件引用 |");
  L.push("|---|---|---|---|---|---|");
  for (const row of inv.table4) {
    L.push(`| \`${row.module}\` | ${row.area} | ${row.offlineFiles} | ${row.indirectFiles} | ${row.issueNamedFiles} | ${row.orphanOnly ? "是" : ""} |`);
  }
  L.push("");
  L.push("分区汇总（`releaseCovered` = 静态证据里被发版清单跑到的模块数）：");
  L.push("");
  L.push("| src/ 分区 | 模块数 | 离线覆盖 | 真机覆盖 | 孤儿件覆盖 | 表 4 行数 |");
  L.push("|---|---|---|---|---|---|");
  for (const a of inv.areas) {
    L.push(`| ${a.area} | ${a.modules} | ${a.offline} | ${a.releaseCovered} | ${a.orphanOnly} | ${a.rows} |`);
  }
  L.push("");
  L.push(`真机空白面（发版清单一步都没碰到的分区，${inv.blankAreas.length} 个）：`
    + (inv.blankAreas.length ? inv.blankAreas.map((a) => `**${a.area}**`).join("、") : "无"));
  const foldOnlyOrphan = inv.table4.filter((r) => r.area === "compact" && r.orphanOnly);
  if (foldOnlyOrphan.length) {
    L.push(`  · 压缩/折叠面（\`src/compact/*\`）：真机覆盖 0 —— 静态引用它、却不在发版清单里的只有孤儿真机件 `
      + `${inv.orphanFiles.map((f) => `\`${f}\``).join("、")}，而发版清单（\`npm run check:release:real\`）的 ${s.releaseSteps} 步里没有它。`
      + `这就是「改一次折叠行为，真机层一无所知」的机械口径。`);
  }
  L.push("");
  L.push("⚠ 下界声明：`cli-real-smoke.mjs` / `release-real-check.mjs` 打的是 CLI 子进程，静态扫不到它实际跑到的模块 ⇒ "
    + "表 4 的行是「静态证据里没有真机覆盖」，**不是**「一定没被真机跑到」。");
  L.push("");

  if (inv.errors.length) {
    L.push(`## 读不到真相（${inv.errors.length} 处 ⇒ exit 2）`);
    for (const e of inv.errors) L.push(`  ✗ [${e.code}] ${e.message}`);
    L.push("");
  }
  if (inv.warnings.length) {
    L.push(`## 警告（${inv.warnings.length} 处）`);
    for (const w of inv.warnings) L.push(`  ! [${w.code}] ${w.message}`);
    L.push("");
  }
  L.push("处置建议（**本单不做**：不合并、不删除、不改写任何测试）：");
  L.push("  · 零守护条目 ⇒ 补一条行为题（先补断言，再谈删旧题）；");
  L.push("  · 冗余守护候选 ⇒ 逐组读一遍，分清「契约断言」与「某工单的现场快照」，后者并进前者；");
  L.push("  · 真机空白面 ⇒ 另开单补 `check:release:real` 的第 6 步（压缩/折叠面优先）。");
  return L.join("\n");
}

// ─────────────────────────────── --self-test（反向证）───────────────────────────────

function cloneCorpus(corpus) {
  return { ...corpus, records: corpus.records.map((r) => ({ ...r })) };
}

function syntheticCorpus(files) {
  return { records: Object.entries(files).map(([rel, text]) => ({ rel, text })), errors: [] };
}

/** 变异助手：返回 null = **变异没落上**（#210 R2：那也算失败，不许当成「绿」）。 */
function dropFile(corpus, rel) {
  const next = cloneCorpus(corpus);
  const idx = next.records.findIndex((r) => r.rel === rel);
  if (idx < 0) return null;
  next.records.splice(idx, 1);
  return next;
}

function renameFile(corpus, from, to) {
  const next = cloneCorpus(corpus);
  const rec = next.records.find((r) => r.rel === from);
  if (!rec || next.records.some((r) => r.rel === to)) return null;
  rec.rel = to;
  return next;
}

function rewriteFile(corpus, rel, transform) {
  const next = cloneCorpus(corpus);
  const rec = next.records.find((r) => r.rel === rel);
  if (!rec) return null;
  const before = rec.text;
  rec.text = transform(before);
  if (rec.text === before) return null;
  return next;
}

/** 把某个模块的引用从一批文件里删掉（删掉提到它的那一行）。返回 null = 一行都没改（变异没落上）。 */
function stripRefs(corpus, files, moduleRel) {
  const next = cloneCorpus(corpus);
  let touched = 0;
  for (const rec of next.records) {
    if (!files.includes(rec.rel)) continue;
    const keep = [];
    for (const line of rec.text.split("\n")) {
      const specs = extractSpecifiers(line);
      if (specs.some((spec) => resolveSpecifier(spec, rec.rel) === moduleRel)) { touched += 1; continue; }
      keep.push(line);
    }
    rec.text = keep.join("\n");
  }
  return touched > 0 ? next : null;
}

function runSelfTest() {
  const passed = [];
  const failures = [];
  const expect = (ok, okMsg, failMsg) => { (ok ? passed : failures).push(ok ? okMsg : failMsg); };
  const rowOf = (inv, name) => inv.table1.find((r) => r.name === name) ?? null;
  const modRow = (inv, module) => inv.table2.find((r) => r.module === module) ?? null;

  console.log("test-corpus-inventory --self-test：反向证（合成夹具 + 真树内存副本；仓内源码全程只读）");

  const real = readCorpus(DEFAULT_ROOT);
  if (real.errors.length) {
    for (const e of real.errors) failures.push(`读不到真树（${e.code}）：${e.message}`);
    console.log(`  ✗ 真树读不到真相：${real.errors.length} 处 —— 反向证无从谈起`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log(`test-corpus-inventory --self-test: 失败 — ${failures.length} 处（读不到真树）`);
    process.exitCode = 1;
    return;
  }
  const base = analyze(real);

  // ── ① 合成夹具：常量断言消失 ⇒ 零守护；恢复 ⇒ 变回 ────────────────────────
  const syn = syntheticCorpus({
    "src/alpha.js": "export const DEFAULT_ALPHA = 1;\nexport const WORKING_SET_RECENT_ROUNDS = 2;\n",
    "src/compact/gamma.js": "export const DEFAULT_GAMMA = 3;\n",
    "test/alpha.test.js": "import test from \"node:test\";\nimport { DEFAULT_ALPHA } from \"../src/alpha.js\";\n"
      + "test(\"alpha\", () => { assert.equal(DEFAULT_ALPHA, 1); });\n",
    "test/gamma.test.js": "import test from \"node:test\";\nimport { DEFAULT_GAMMA } from \"../src/compact/gamma.js\";\n"
      + "test(\"gamma\", () => {});\n",
    "examples/fake-real-e2e.mjs": "import { DEFAULT_GAMMA } from \"../src/compact/gamma.js\";\n",
  });
  const synPinned = ["WORKING_SET_RECENT_ROUNDS"];
  const synBase = analyze(syn, { pinned: synPinned });
  expect(rowOf(synBase, "DEFAULT_ALPHA")?.guardCount === 1 && rowOf(synBase, "DEFAULT_ALPHA")?.zeroGuard === false,
    "① 合成夹具基线：DEFAULT_ALPHA 有 1 个守护者（test/alpha.test.js）",
    `① 合成夹具基线不对：DEFAULT_ALPHA guardCount=${rowOf(synBase, "DEFAULT_ALPHA")?.guardCount}（期望 1）`);
  expect(rowOf(synBase, "WORKING_SET_RECENT_ROUNDS")?.zeroGuard === true,
    "① 合成夹具基线：WORKING_SET_RECENT_ROUNDS 零守护（0 命中能被抓到）",
    "① 合成夹具基线：零守护没被抓到 —— 0 命中口径是坏的");

  const synNoGuard = rewriteFile(syn, "test/alpha.test.js", (t) => t.split("\n").filter((l) => !l.includes("DEFAULT_ALPHA")).join("\n"));
  if (!synNoGuard) {
    failures.push("① 变异没落上：删不掉 test/alpha.test.js 里对 DEFAULT_ALPHA 的断言");
  } else {
    const mutated = analyze(synNoGuard, { pinned: synPinned });
    const row = rowOf(mutated, "DEFAULT_ALPHA");
    expect(row?.zeroGuard === true && row?.guardCount === 0 && mutated.summary.zeroGuard === synBase.summary.zeroGuard + 1,
      "① 断言消失 ⇒ 表 1 该行从「有守护」变「零守护」（零守护计数 +1）",
      `① 断言消失没被表 1 抓到：guardCount=${row?.guardCount}（期望 0），zeroGuard=${row?.zeroGuard}（期望 true），`
        + `零守护 ${mutated.summary.zeroGuard} vs 基线 ${synBase.summary.zeroGuard}`);
    const restored = analyze(syn, { pinned: synPinned });
    expect(rowOf(restored, "DEFAULT_ALPHA")?.guardCount === 1 && rowOf(restored, "DEFAULT_ALPHA")?.zeroGuard === false,
      "① 恢复 ⇒ 该行变回「有守护」（1 个）",
      `① 恢复后不对：guardCount=${rowOf(restored, "DEFAULT_ALPHA")?.guardCount}（期望 1）`);
  }

  // ── ①b 真树内存副本：#614 之前 DEFAULT_COMPACTION_STRATEGY 就是零守护 ────────
  const dcs = rowOf(base, "DEFAULT_COMPACTION_STRATEGY");
  if (!dcs) {
    failures.push("①b 真树里没有 DEFAULT_COMPACTION_STRATEGY —— 表 1 的自动发现口径漏了这个常量");
  } else {
    expect(dcs.guardCount >= 1,
      `①b 真树基线：DEFAULT_COMPACTION_STRATEGY 有 ${dcs.guardCount} 个守护者（${dcs.guardFiles.map((f) => f.rel).join("、")}）`,
      "①b 真树基线：DEFAULT_COMPACTION_STRATEGY 现在就是零守护 —— #614 的守护已经没了");
    let without = cloneCorpus(real);
    let landed = 0;
    for (const f of dcs.guardFiles) {
      const next = dropFile(without, f.rel);
      if (next) { without = next; landed += 1; }
    }
    if (landed === 0) {
      failures.push("①b 变异没落上：一个守护者文件都没摘掉");
    } else {
      const mutated = analyze(without);
      const row = rowOf(mutated, "DEFAULT_COMPACTION_STRATEGY");
      expect(row?.zeroGuard === true && row?.guardCount === 0,
        `①b 摘掉那 ${landed} 个守护者 ⇒ DEFAULT_COMPACTION_STRATEGY 变「零守护」（= #614 之前的历史形态，不 checkout 旧提交）`,
        `①b 摘掉守护者后仍不是零守护：guardCount=${row?.guardCount}（期望 0）`);
      const restored = analyze(real);
      expect(rowOf(restored, "DEFAULT_COMPACTION_STRATEGY")?.guardCount === dcs.guardCount,
        "①b 恢复 ⇒ 守护者数回到基线",
        `①b 恢复后守护者数 ${rowOf(restored, "DEFAULT_COMPACTION_STRATEGY")?.guardCount} ≠ 基线 ${dcs.guardCount}`);
    }
  }

  // ── ② 改名成工单号形态 ⇒ 表 2/3 的计数跟着动 ──────────────────────────────
  const synRenamed = renameFile(syn, "test/gamma.test.js", "test/gamma-321.test.js");
  if (!synRenamed) {
    failures.push("② 合成变异没落上：test/gamma.test.js 改名失败");
  } else {
    const mutated = analyze(synRenamed, { pinned: synPinned });
    const baseRow = modRow(synBase, "src/compact/gamma.js");
    const row = modRow(mutated, "src/compact/gamma.js");
    const baseNamed = synBase.summary.issueNamedTests;
    expect(row?.issueNamedFiles.length === (baseRow?.issueNamedFiles.length ?? 0) + 1
      && mutated.summary.issueNamedTests === baseNamed + 1,
      "② 合成：改名为 `gamma-321.test.js` ⇒ 表 2 该模块工单号文件 +1、表 3 工单号计数 +1",
      `② 合成改名没被表 2/3 抓到：工单号文件 ${row?.issueNamedFiles.length}（期望 ${(baseRow?.issueNamedFiles.length ?? 0) + 1}）、`
        + `表 3 工单号 ${mutated.summary.issueNamedTests}（期望 ${baseNamed + 1}）`);
  }

  const realRenameFrom = "test/compact/fold-llm.test.js";
  const realRenameTo = "test/compact/fold-llm-999.test.js";
  const realRenamed = renameFile(real, realRenameFrom, realRenameTo);
  if (!realRenamed) {
    failures.push(`② 真树变异没落上：${realRenameFrom} 不在语料里（改名基准没了）`);
  } else {
    const mutated = analyze(realRenamed);
    const baseRow = modRow(base, "src/compact/fold-llm.js");
    const row = modRow(mutated, "src/compact/fold-llm.js");
    const landed = row?.issueNamedFiles.includes(realRenameTo)
      && row.issueNamedFiles.length === (baseRow?.issueNamedFiles.length ?? 0) + 1
      && mutated.summary.issueNamedTests === base.summary.issueNamedTests + 1;
    expect(landed,
      `② 真树：\`${realRenameFrom}\` → \`${realRenameTo}\` ⇒ src/compact/fold-llm.js 的工单号文件 `
        + `${(baseRow?.issueNamedFiles.length ?? 0)} → ${row?.issueNamedFiles.length}，表 3 工单号 ${base.summary.issueNamedTests} → ${mutated.summary.issueNamedTests}`,
      `② 真树改名没被表 2/3 抓到：工单号文件 ${row?.issueNamedFiles.length}（期望 ${(baseRow?.issueNamedFiles.length ?? 0) + 1}）、`
        + `表 3 工单号 ${mutated.summary.issueNamedTests}（期望 ${base.summary.issueNamedTests + 1}）`);
    expect(modRow(analyze(real), "src/compact/fold-llm.js")?.issueNamedFiles.length === (baseRow?.issueNamedFiles.length ?? 0),
      "② 恢复 ⇒ 工单号文件数回到基线（变异没有污染真树语料）",
      "② 恢复后工单号文件数没回到基线 —— 变异泄漏进了基线语料");
  }

  // ── ③ 真机覆盖面被削 ⇒ 表 4 多一行；离线覆盖被削 ⇒ 它离开表 4 并落进零覆盖桶 ──
  const realCoveredModules = base.releaseCovered.slice();
  if (realCoveredModules.length === 0) {
    failures.push("③ 真树里静态可见的真机覆盖模块为 0 —— 真机面解析坏了（表 4 会退化成「全部模块」）");
  } else {
    const target = realCoveredModules[0];
    const mutated = stripRefs(real, base.releaseFiles, target);
    if (!mutated) {
      failures.push(`③ 变异没落上：真机面里找不到 \`${target}\` 的引用行（削不掉）`);
    } else {
      const after = analyze(mutated);
      const gained = after.table4.some((r) => r.module === target);
      expect(gained && after.table4.length === base.table4.length + 1 && !after.releaseCovered.includes(target),
        `③ 把 \`${target}\` 从真机覆盖面里削掉 ⇒ 表 4 多一行（${base.table4.length} → ${after.table4.length}），并点名它`,
        `③ 削掉真机覆盖后表 4 没有多出 \`${target}\`：行数 ${after.table4.length}（期望 ${base.table4.length + 1}），`
          + `gained=${gained}`);
      const restored = analyze(real);
      expect(restored.table4.length === base.table4.length,
        "③ 恢复 ⇒ 表 4 行数回到基线",
        `③ 恢复后表 4 行数 ${restored.table4.length} ≠ 基线 ${base.table4.length}`);
    }
  }
  const offlineOnly = base.table4[0];
  if (!offlineOnly) {
    failures.push("③b 表 4 为空 —— 没有可削的离线覆盖行");
  } else {
    let without = cloneCorpus(real);
    let landed = 0;
    for (const rel of modRow(base, offlineOnly.module)?.files ?? []) {
      const next = dropFile(without, rel);
      if (next) { without = next; landed += 1; }
    }
    if (landed === 0) {
      failures.push(`③b 变异没落上：\`${offlineOnly.module}\` 的离线守护文件一个都没摘掉`);
    } else {
      const after = analyze(without);
      const row = modRow(after, offlineOnly.module);
      const stillInTable4 = after.table4.some((r) => r.module === offlineOnly.module);
      const indirectly = (row?.indirectFiles.length ?? 0) > 0;
      const nowZero = after.zeroCoverage.includes(offlineOnly.module);
      // 两种合法去命都要被点名（不许静默消失）：直接覆盖归零后，要么被 src/ 间接覆盖接住，
      // 要么落进「真缺口」桶。
      expect(row?.refCount === 0 && (indirectly || nowZero) && (indirectly ? stillInTable4 : !stillInTable4),
        `③b 把 \`${offlineOnly.module}\` 的 ${landed} 个离线守护文件全摘掉 ⇒ 直接覆盖归零（${offlineOnly.offlineFiles} → 0），`
          + `表 2 该行改报${indirectly ? `「间接覆盖」（经 ${row?.indirectVia.join("、")}，${row?.indirectFiles.length} 个测试文件，仍在表 4）` : `「真缺口」桶（${after.summary.zeroCoverageModules} 个）`}`,
        `③b 摘掉离线覆盖后口径不对：refCount=${row?.refCount}（期望 0）、间接=${indirectly}、真缺口桶=${nowZero}、仍在表 4=${stillInTable4}`);
    }
  }

  // ── ③c 合成夹具：直接与间接都归零 ⇒ 落进「真缺口」桶（③b 的另一个分支）────────
  const synNoCoverage = dropFile(syn, "test/alpha.test.js");
  if (!synNoCoverage) {
    failures.push("③c 变异没落上：test/alpha.test.js 摘不掉");
  } else {
    const after = analyze(synNoCoverage, { pinned: synPinned });
    const row = modRow(after, "src/alpha.js");
    expect(row?.refCount === 0 && row?.indirectFiles.length === 0 && row?.zeroCoverage === true
      && after.zeroCoverage.includes("src/alpha.js") && after.summary.zeroCoverageModules === 1,
      "③c 合成夹具：把唯一的离线守护文件摘掉（且 src/ 内无人引用）⇒ 该模块落进「真缺口」桶，不是静默消失",
      `③c 真缺口桶没接住：refCount=${row?.refCount}、间接=${row?.indirectFiles.length}、zeroCoverage=${row?.zeroCoverage}、`
        + `桶大小=${after.summary.zeroCoverageModules}（期望 1）`);
  }

  // ── ④ 对照：什么都不改 ⇒ 全绿 ────────────────────────────────────────────
  const again = analyze(real);
  expect(JSON.stringify(again.table1) === JSON.stringify(base.table1)
    && JSON.stringify(again.table2) === JSON.stringify(base.table2)
    && JSON.stringify(again.table3) === JSON.stringify(base.table3)
    && JSON.stringify(again.table4) === JSON.stringify(base.table4),
    "④ 不变异对照：同一语料跑两次，四张表逐字节相同（没有隐藏的可变状态）",
    "④ 不变异对照失败：同一语料两次跑出不同结果（有隐藏可变状态，例如 `g` 正则的 lastIndex）");
  const structural = base.table2.length === base.summary.modules
    && base.table3.length === base.summary.tests
    && base.table4.every((r) => base.table2.some((m) => m.module === r.module && m.offlineCovered))
    && base.table2.every((r) => r.offlineCovered === (r.refCount > 0 || r.indirectFiles.length > 0))
    && base.table2.every((r) => Number(r.refCount > 0) + Number(r.indirectFiles.length > 0) + Number(r.zeroCoverage) === 1)
    && base.table1.length === base.summary.constants
    && PINNED_CONSTANTS.every((name) => base.table1.some((r) => r.name === name))
    && base.summary.zeroGuard === base.table1.filter((r) => r.zeroGuard).length;
  expect(structural,
    `④ 结构不变量：表 1 ${base.table1.length} 行（含全部 ${PINNED_CONSTANTS.length} 个工单点名常量）· `
      + `表 2 ${base.table2.length} 行 = ${base.summary.modules} 个模块（直接/间接/真缺口三桶互斥）· `
      + `表 3 ${base.table3.length} 行 = ${base.summary.tests} 个题 · 表 4 ${base.table4.length} 行 ⊆ 表 2 的「离线覆盖」行`,
    `④ 结构不变量不成立：表1 ${base.table1.length}/${base.summary.constants}、表2 ${base.table2.length}/${base.summary.modules}、`
      + `表3 ${base.table3.length}/${base.summary.tests}、表4 越界=${!base.table4.every((r) => base.table2.some((m) => m.module === r.module))}`);
  expect(base.incomplete === false,
    `④ 真树没有「读不到真相」的条目（errors=${base.errors.length}）`,
    `④ 真树有 ${base.errors.length} 处读不到真相：${base.errors.map((e) => e.code).join("、")}`);

  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`test-corpus-inventory --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    process.exitCode = 1;
    return;
  }
  console.log(`test-corpus-inventory --self-test: OK — ${passed.length} 条判据全部按预期（合成夹具 + 真树内存副本，不写盘、不碰仓内源码）`);
}

// ─────────────────────────────── main ───────────────────────────────

function parseArgs(argv) {
  const opts = { json: false, selfTest: false, root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--root") { opts.root = resolve(argv[i + 1] ?? ""); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`test-corpus-inventory: 不认识的参数 ${JSON.stringify(arg)}（支持 --json / --self-test / --root <dir> / --help）`);
      process.exit(2);
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("用法：node scripts/test-corpus-inventory.mjs [--json] [--root <dir>] [--self-test]");
    return 0;
  }
  if (opts.selfTest) {
    runSelfTest();
    return process.exitCode ?? 0;
  }
  const inv = analyze(readCorpus(opts.root));

  if (opts.json) {
    const payload = {
      tool: "test-corpus-inventory",
      generatedFor: "issue #618（题库盘点：行为 → 守护题）",
      gate: false,
      note: "只是清点：零守护 / 冗余守护 / 真机空白都不是错误，本工具不参与任何门禁判定，也不改任何测试",
      root: opts.root,
      criteria: CRITERIA,
      pinnedConstants: PINNED_CONSTANTS,
      redundantThreshold: REDUNDANT_THRESHOLD,
      releaseSurfaces: inv.releaseFiles,
      orphanSurfaces: inv.orphanFiles,
      releaseCoveredModules: inv.releaseCovered,
      orphanCoveredModules: inv.orphanCovered,
      summary: inv.summary,
      table1: inv.table1,
      table2: inv.table2,
      table3: inv.table3,
      table4: inv.table4,
      areas: inv.areas,
      blankAreas: inv.blankAreas,
      zeroCoverageModules: inv.zeroCoverage,
      errors: inv.errors,
      warnings: inv.warnings,
      incomplete: inv.incomplete,
      reproduce: ["node scripts/test-corpus-inventory.mjs", "node scripts/test-corpus-inventory.mjs --json"],
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderReport(inv, { root: opts.root }));
  }
  return inv.incomplete ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
