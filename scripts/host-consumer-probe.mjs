#!/usr/bin/env node
// issue #429 的**宿主侧半边**：把「宿主仓真的在导入的名字」与「仓内零消费者候选」求交，再拿命中的名字去
// 当前版本的升级指南里找它那一行条目。判据是**覆盖**，不是否决。
//
// 为什么需要它（`check:exports:deprecated` 自己写明的边界）：
//   那条判据只证**仓内**零消费者。宿主仓（touwaka / fde-workshop / 以及仍在盘上的旧检出 app_container、
//   erix-station / pi）不在它的扫描面里，它们的 import 一个都看不见。于是「仓内零消费者 ⇒ 可以标 0.30 删除」
//   这条推论在宿主侧从未被机器核过：主 agent 手工 grep 才发现有名字正在被活宿主导入，其中一个还没有仓内替代
//   方案。手工 grep 不可复现、也不会在下次改名后重新跑一遍 ⇒ 这里把它做成一条**可跑的机器检查**。
//
// ── 口径（#429 纠错：下游不握否决权）────────────────────────────────────────────
//   本仓是**上游**。上游删一个导出，不需要下游批准；需要的是**破坏可见、可迁**。所以判据不是「宿主零命中才
//   许删」（那等于把否决权交给下游的迁移进度），而是：
//
//     **每一个「计划删除、且已知有真实宿主在 import」的名字，必须在当前版本的升级指南里有一行对应条目
//     （含迁移写法）。**
//
//   做到 ⇒ 绿，并把「已知会被破坏的宿主引用」逐条列出来（哪个仓、哪个文件:行、指南哪一行、迁移怎么写）；
//   漏一条 ⇒ 红，点名宿主仓 / 文件:行 / 名字 / 缺的是哪份指南的哪一格。
//
//   换句话说：命中不再是「不许发版」的证据，而是「这一页必须已经写到它」的清单。删不删、什么时候删，是上游
//   按自己的版本边界决定的事；宿主侧的义务只是**被告知怎么迁**。
//
// ── 它做什么 ──────────────────────────────────────────────────────────────────
//   1. 从 `--hosts <目录>`（可多次给，也可逗号分隔）里**递归**提取所有对 `erix-agent` 的入口引用：
//      `import { … } from "erix-agent"` / `"erix-agent/<子路径>"`、`export … from …`、
//      `require("erix-agent…")`（含解构赋值）、动态 `import("erix-agent…")`；
//   2. 与 `npm run check:exports` **现算**的零消费者候选求交——候选清单来自
//      `scripts/export-consumer-check.mjs` 的 `computeInventory()`（**import 进来**，不抄第二份名单：
//      抄一份就是两条漂移路径，那正是 #429 修掉的口径漏洞①的同型错误）；
//   3. 把命中的名字拿到当前版本的升级指南逐名表里找条目——**表的读法**来自
//      `scripts/bundle-guide-table.mjs`，与 `check:docs` 的 `bundle-table` 对账用的是同一份读法（不抄第二份
//      名单，否则「指南写了什么」就有两个答案）；
//   4. 每个命中名字在**中英两份**指南里都要有一行、且那一行的迁移条款格非空 ⇒ 覆盖；缺任一份 / 条款格空
//      ⇒ exit 1，逐条点名「哪个宿主仓 / 哪个文件:行 / 哪个名字 / 缺哪份指南的哪一格」；
//   5. 目录不存在 / 不可读 ⇒ **不是错误**：exit 0 + 分类原因（`HOST_DIR_MISSING` / `HOST_DIR_NOT_DIR` /
//      `HOST_DIR_UNREADABLE`）。CI 上没有宿主仓检出，这一条必须让它绿——探针绝不许变成 CI 对宿主仓的硬依赖；
//   6. 不给 `--hosts` ⇒ 只打印口径与「未判定」，exit 0（`npm run check:host-consumers` 默认不阻断）。
//
// ── 边界（本探针证明不了的事，报告里也印一遍）──────────────────────────────────
//   · 只认**静态可解析**的入口引用：名字从 import/export/require 的名单里读。命名空间导入（`import * as ns`）、
//     默认导入（`import X`）、裸 `require("erix-agent")`、动态 `import(…)` 都**解析不出名字** ⇒ 单列成
//     「未解析」并计数，**不静默丢弃**（「读不出」不等于「没问题」）。
//   · 注释里提到的 `require("erix-agent")` 不算（先做一遍注释涂白；字符串字面量保留，因为模块说明符本身
//     就是字符串）。
//   · 宿主仓可以不在本机：给不出目录时这条判据**不成立**，报告会明说「未判定」而不是「绿」。
//   · 它**不**判定「该不该删」，也**不**判定「指南写得对不对」：条款是否照抄标记、入口列是否写对、中英是否
//     一致，是 `check:docs` 的 `bundle-table` 那一半。这里只问一件事：**命中的名字，指南有没有写到它。**
//   · 「命中为 0」**不等于**「删了不会破坏任何宿主」：它只说明这一次扫到的宿主检出里没有静态命中。宿主可能
//     在别处、可能用动态 import、也可能用命名空间导入（那类形状单列在「解析不出名字」一节）。
//
// ── 它在发布流程里的位置 ──────────────────────────────────────────────────────
//   `AGENTS.md` / `AGENTS_cn.md` 的预发布清单把它列为 0.30 的**发布前置检查**：
//   `npm run check:host-consumers -- --hosts <宿主仓目录>` 跑绿 = 每一处已知的宿主引用都已被指南覆盖。
//   它在 CI 里**不跑**（CI 没有宿主仓检出）——不给目录时 exit 0 并打印分类原因，那是「未判定」，不是绿。
//
// ── 退出码（与家族同构：读不出真值就红，不许假绿）───────────────────────────────
//   0 = 判定了、且每一处命中都被指南覆盖（或压根没给宿主目录 / 给的目录不存在——分类原因打印出来，不是静默绿）
//   1 = 有命中名字在指南里缺条目（逐条点名宿主仓 / 文件:行 / 名字 / 缺哪一格）
//   2 = 读不出真值：清点工具跑不起来 / 清点不完整（`computeInventory` 报 incomplete）/ 指南表读不出
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/host-consumer-probe.mjs --hosts /home/eric/projects   # 判定（递归扫该目录）
//   node scripts/host-consumer-probe.mjs --hosts ../touwaka --hosts ../fde-workshop
//   node scripts/host-consumer-probe.mjs --hosts ../touwaka,../fde-workshop   # 逗号分隔同义
//   node scripts/host-consumer-probe.mjs                               # 不给目录 ⇒ 未判定，exit 0
//   node scripts/host-consumer-probe.mjs --json                        # 机器读同一份事实
//   node scripts/host-consumer-probe.mjs --root <dir>                  # 换根（自测用）
//   node scripts/host-consumer-probe.mjs --self-test                   # 反向证（内存夹具，不写盘）
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRecords,
  computeInventory,
  hostContractNames,
  resolveEntries,
} from "./export-consumer-check.mjs";
import {
  DEFAULT_REMOVAL_VERSION,
  REMOVAL_REGISTRY,
  removalVersionOf,
} from "./deprecated-export-check.mjs";
// 逐名表的**读法**（版本号 / 两份文件名 / 一行长什么样 / 哪一格是迁移条款）与 `check:docs` 的
// `bundle-table` 对账共用同一份：两边各读一份就是两条会各自漂移的真相。
import {
  BUNDLE_GUIDE_DOCS,
  BUNDLE_GUIDE_VERSION,
  bundleRowsFromText,
} from "./bundle-guide-table.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 被探的包名（入口说明符 = `erix-agent` 或 `erix-agent/<子路径>`）。 */
export const PACKAGE_NAME = "erix-agent";

/** 宿主侧的代码扩展名（JS 与 TS 都收：宿主用什么写，不由本仓决定）。 */
const CODE_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

/** 递归时**剪掉**的目录：依赖树与构建产物里没有「宿主自己的导入」，扫它们只会把耗时翻几十倍。 */
const PRUNE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt", ".output",
  ".cache", ".turbo", ".yarn", "out", "vendor", "backups",
]);

/** 单文件上限：超过就**列进 oversized**（不是静默跳过），因为打包产物里也可能有入口引用。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 宿主目录的分类原因（报告与 `--json` 共用；新增一个先加在这里）。 */
export const HOST_CODES = {
  DIR_MISSING: "HOST_DIR_MISSING",
  DIR_NOT_DIR: "HOST_DIR_NOT_DIR",
  DIR_UNREADABLE: "HOST_DIR_UNREADABLE",
  FILE_UNREADABLE: "HOST_FILE_UNREADABLE",
};

/** 指南表的分类原因（读不出真值 ⇒ exit 2，与家族同构；不是「没命中」）。 */
export const GUIDE_CODES = {
  TABLE_MISSING: "GUIDE_TABLE_MISSING",
  TABLE_UNREADABLE: "GUIDE_TABLE_UNREADABLE",
};

/** 覆盖判定的两态（报告、`--json` 与自测共用一份措辞）。 */
export const COVERAGE_CODES = {
  ENTRY_MISSING: "GUIDE_ENTRY_MISSING",
};

/** 解析不出名字的引用形状（逐类计数，不静默丢）。 */
export const UNRESOLVED_KINDS = {
  DEFAULT_IMPORT: "default-import",
  NAMESPACE_IMPORT: "namespace-import",
  SIDE_EFFECT_IMPORT: "side-effect-import",
  DYNAMIC_IMPORT: "dynamic-import",
  EXPORT_STAR: "export-star",
  NAMESPACE_REQUIRE: "namespace-require",
  BARE_REQUIRE: "bare-require",
  UNPARSED_SPEC: "unparsed-spec",
};

// ─────────────────────────────── 源码形状 ───────────────────────────────

const IDENT = "[A-Za-z_$][\\w$]*";
const IDENT_RE = new RegExp(`^${IDENT}$`);

/**
 * 从 `{ a, b as c, … }` 的**花括号内容**里取出「导出名」（`as` 左边那个；解构的 `a: b` 与默认值 `a = 1`
 * 也取左边那个属性名——那才是入口导出的名字）。认不出的条目进 `unparsed`，不静默丢。
 *
 * @param {string} body
 * @returns {{names: string[], unparsed: string[]}}
 */
export function namesFromBraceBody(body) {
  const names = [];
  const unparsed = [];
  for (const raw of body.split(",")) {
    const piece = raw.trim();
    if (piece === "") continue;
    const token = /^([A-Za-z_$][\w$]*)/.exec(piece);
    if (!token) { unparsed.push(piece); continue; }
    names.push(token[1]);
  }
  return { names, unparsed };
}

/**
 * 把注释与**字符串内容**涂成空格（引号保留、换行保留 ⇒ 行号与原文对齐）。
 *
 * 两件都必须涂：
 *   · 注释：宿主的注释里会写 `require('erix-agent')` 这种说明文字（真实样本在 touwaka 的
 *     `transcript-payload-fingerprint.js` 里），不涂白就会把它当成一次导入；
 *   · 字符串内容：测试夹具常把 import 语句**当字符串**存（本仓自己的 `--self-test` 就是），不涂白就会
 *     把夹具文本报成「宿主在导入」。模块说明符本身也是字符串，所以引号**保留**，说明符由
 *     `specifierAt()` 回原文里取。
 *
 * 已知边界：正则字面量里的引号（`/'/`）会骗过这个状态机——代价是**多**报一条未解析引用，不会漏报命中
 * （命中要求真的解析出名字，而字符串/注释里的名字一个都进不了 `refs`）。
 *
 * @param {string} text
 * @returns {string} 与原文等长、等换行的文本（注释与字符串内容位是空格）
 */
export function maskNonCode(text) {
  const out = text.split("");
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < text.length && text[i + 1] !== "\n") out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (ch === quote) { quote = null; i += 1; continue; }
      if (ch !== "\n") out[i] = " ";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; i += 1; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") { out[i] = " "; i += 1; }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < text.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 1 起的行号（`index` 是 0 起的字符下标）。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * 取 `quoteIndex` 处那个字符串字面量的**内容**（回原文取：`maskNonCode()` 已经把内容涂白了）。
 *
 * @param {string} original 源码原文
 * @param {number} quoteIndex 开引号的字符下标
 * @returns {string|null} 字面量内容；找不到闭合引号（被截断的源）返回 null
 */
export function specifierAt(original, quoteIndex) {
  const quote = original[quoteIndex];
  let i = quoteIndex + 1;
  while (i < original.length) {
    if (original[i] === "\\") { i += 2; continue; }
    if (original[i] === quote) return original.slice(quoteIndex + 1, i);
    i += 1;
  }
  return null;
}

/** 这个说明符是不是被探的包（`erix-agent` 或 `erix-agent/<子路径>`）。 */
export function isErixSpecifier(spec) {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}/`));
}

/**
 * 解析一份源码里对 `erix-agent` 的**入口引用**。
 *
 * 只认静态可解析的名字（见文件头的边界）；解析不出名字的形状进 `unresolved`，逐类计数。
 *
 * @param {string} text 源码原文
 * @param {string} rel 文件名（只用于报告；不影响解析）
 * @returns {{refs: Array<{name: string, line: number, spec: string, kind: string, file: string}>,
 *            unresolved: Array<{kind: string, line: number, spec: string|null, detail: string}>}}
 */
export function extractErixImports(text, rel = "<inline>") {
  const refs = [];
  const unresolved = [];
  // 快路径：整份文件都不提这个包名 ⇒ 一定没有入口引用（不必涂白、不必跑正则；宿主树里绝大多数文件如此）。
  if (!text.includes(PACKAGE_NAME)) return { refs, unresolved };
  const masked = maskNonCode(text);

  /**
   * 把一份名单里的名字推进 `refs`。**行号取名字自己那一行**（多行 import 的语句起始行会指偏：
   * 宿主的 `import {\n a,\n b,\n} from` 很常见，报成第 1 行等于没报）。
   *
   * @param {string} body 花括号**里面**的内容
   * @param {{spec: string, line: number, kind: string, bodyStart: number}} ctx
   */
  const pushNames = (body, { spec, line, kind, bodyStart }) => {
    const { names, unparsed } = namesFromBraceBody(body);
    let cursor = 0;
    for (const name of names) {
      const at = body.indexOf(name, cursor);
      if (at >= 0) cursor = at + name.length;
      refs.push({ name, line: at >= 0 ? lineAt(masked, bodyStart + at) : line, spec, kind, file: rel });
    }
    for (const piece of unparsed) {
      unresolved.push({ kind: UNRESOLVED_KINDS.UNPARSED_SPEC, line, spec, detail: `名单条目 ${JSON.stringify(piece)} 认不出名字` });
    }
  };

  // ① `import … from "<spec>"`（名单式 / 默认 / 命名空间 / 默认+名单）
  const importFrom = /\bimport\s+([^;]*?)\s*from\s*(["'])/g;
  for (const match of masked.matchAll(importFrom)) {
    const spec = specifierAt(text, match.index + match[0].length - 1);
    if (!isErixSpecifier(spec)) continue;
    const clause = match[1];
    const line = lineAt(masked, match.index);
    const brace = /\{([\s\S]*?)\}/.exec(clause);
    const outside = brace ? clause.replace(brace[0], "") : clause;
    if (/\*/.test(outside)) {
      unresolved.push({ kind: UNRESOLVED_KINDS.NAMESPACE_IMPORT, line, spec, detail: `命名空间导入（${outside.trim()}）解析不出名字` });
      continue;
    }
    if (brace) {
      pushNames(brace[1], { spec, line, kind: "import-names", bodyStart: match.index + match[0].indexOf(brace[1]) });
    }
    const rest = outside.replace(/,/g, "").trim();
    if (rest !== "") {
      unresolved.push({ kind: UNRESOLVED_KINDS.DEFAULT_IMPORT, line, spec, detail: `默认导入（${rest}）解析不出导出名` });
    }
  }

  // ①b 副作用导入 `import "<spec>"`（没有 from，也没有名字）——单独认，否则会被静默漏掉
  const sideEffect = /\bimport\s*(["'])/g;
  for (const match of masked.matchAll(sideEffect)) {
    const spec = specifierAt(text, match.index + match[0].length - 1);
    if (!isErixSpecifier(spec)) continue;
    unresolved.push({
      kind: UNRESOLVED_KINDS.SIDE_EFFECT_IMPORT,
      line: lineAt(masked, match.index),
      spec,
      detail: "副作用导入（只执行入口，不取名字）",
    });
  }

  // ② `export { … } from "<spec>"` / `export * from "<spec>"`
  const exportFrom = /\bexport\s+([^;]*?)\s*from\s*(["'])/g;
  for (const match of masked.matchAll(exportFrom)) {
    const spec = specifierAt(text, match.index + match[0].length - 1);
    if (!isErixSpecifier(spec)) continue;
    const clause = match[1];
    const line = lineAt(masked, match.index);
    const brace = /\{([\s\S]*?)\}/.exec(clause);
    if (!brace) {
      unresolved.push({ kind: UNRESOLVED_KINDS.EXPORT_STAR, line, spec, detail: `\`export ${clause.trim()} from\` 解析不出名字` });
      continue;
    }
    pushNames(brace[1], { spec, line, kind: "export-names", bodyStart: match.index + match[0].indexOf(brace[1]) });
  }

  // ③ `require("<spec>")`（含 `const { a } = require(...)` 解构）
  const requireRe = /\brequire\s*\(\s*(["'])/g;
  for (const match of masked.matchAll(requireRe)) {
    const spec = specifierAt(text, match.index + match[0].length - 1);
    if (!isErixSpecifier(spec)) continue;
    const line = lineAt(masked, match.index);
    const prefix = masked.slice(Math.max(0, match.index - 400), match.index);
    const assign = new RegExp(`(?:const|let|var)\\s+(\\{[^}]*\\}|${IDENT})\\s*=\\s*$`).exec(prefix);
    if (assign && assign[1].startsWith("{")) {
      const bodyStart = (match.index - prefix.length) + prefix.lastIndexOf(assign[1]) + 1;
      pushNames(assign[1].slice(1, -1), { spec, line, kind: "require-destructure", bodyStart });
      continue;
    }
    unresolved.push({
      kind: assign ? UNRESOLVED_KINDS.NAMESPACE_REQUIRE : UNRESOLVED_KINDS.BARE_REQUIRE,
      line,
      spec,
      detail: assign ? `命名空间 require（${assign[1]}）解析不出名字` : "裸 require（整个入口对象）解析不出名字",
    });
  }

  // ④ 动态 `import("<spec>")`
  const dynamicRe = /\bimport\s*\(\s*(["'])/g;
  for (const match of masked.matchAll(dynamicRe)) {
    const spec = specifierAt(text, match.index + match[0].length - 1);
    if (!isErixSpecifier(spec)) continue;
    unresolved.push({
      kind: UNRESOLVED_KINDS.DYNAMIC_IMPORT,
      line: lineAt(masked, match.index),
      spec,
      detail: "动态 import 解析不出名字（运行期才知道取什么）",
    });
  }

  return { refs, unresolved };
}


// ─────────────────────────────── 宿主目录扫描 ───────────────────────────────

/**
 * 递归列出一个宿主目录里的代码文件。目录不存在 / 不可读**不抛**：返回分类原因（探针靠它 exit 0）。
 *
 * @param {string} hostDir
 * @returns {{error: null|{code: string, message: string}, files: string[], oversized: string[],
 *            unreadable: Array<{code: string, path: string, message: string}>}}
 */
export function walkHost(hostDir) {
  let st;
  try {
    st = statSync(hostDir);
  } catch (err) {
    return {
      error: {
        code: err.code === "ENOENT" ? HOST_CODES.DIR_MISSING : HOST_CODES.DIR_UNREADABLE,
        message: `${hostDir} 读不出（${err.code ?? err.message}）`,
      },
      files: [], oversized: [], unreadable: [],
    };
  }
  if (!st.isDirectory()) {
    return { error: { code: HOST_CODES.DIR_NOT_DIR, message: `${hostDir} 不是目录（是文件）` }, files: [], oversized: [], unreadable: [] };
  }
  const files = [];
  const oversized = [];
  const unreadable = [];
  const stack = [hostDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ code: HOST_CODES.DIR_UNREADABLE, path: dir, message: `${dir} 读不出（${err.code ?? err.message}）` });
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!PRUNE_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CODE_EXTS.some((ext) => entry.name.endsWith(ext))) continue;
      let size;
      try {
        size = statSync(abs).size;
      } catch (err) {
        unreadable.push({ code: HOST_CODES.FILE_UNREADABLE, path: abs, message: `${abs} 读不出元信息（${err.code ?? err.message}）` });
        continue;
      }
      if (size > MAX_FILE_BYTES) { oversized.push(abs); continue; }
      files.push(abs);
    }
  }
  return { error: null, files: files.sort(), oversized, unreadable };
}

/**
 * 命中所在的**宿主仓**：先往上找最近的带 `.git` 的目录（那是**仓边界**，名字就是宿主仓的名字——
 * `touwaka` / `fde-workshop`，以及仍在盘上的旧检出 `app_container` / `erix-station`），找不到 `.git`
 * 再退回最近的 `package.json` 的 `name`（monorepo 里的工作区包名），再不行退回目录名。报告里不会出现
 * 空白的「哪个宿主仓」。
 */
export function hostRepoOf(absFile, hostDir) {
  const stop = resolve(hostDir);
  const chain = [];
  let dir = dirname(resolve(absFile));
  while (dir.startsWith(stop)) {
    chain.push(dir);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const gitRoot = chain.find((candidate) => existsSync(join(candidate, ".git")));
  if (gitRoot) return basename(gitRoot);
  const pkgDir = chain.find((candidate) => existsSync(join(candidate, "package.json")));
  if (pkgDir) {
    try {
      const name = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))?.name;
      if (typeof name === "string" && name.trim() !== "") return name.trim();
    } catch {
      // 读不出 package.json 就退回目录名（不静默丢掉「哪个宿主仓」这一格）
    }
    return basename(pkgDir);
  }
  return basename(stop);
}

/**
 * 「这个文件属于**被探的包自己的检出**」判定器：从文件目录往上找最近的 `package.json`，
 * 它的 `name` 等于 `erix-agent` ⇒ 是同一个包的另一份检出（本仓 / 另一棵 worktree / 另一处 clone），
 * **不是宿主**。不排掉它，报告会被本仓自己的 `scripts/release-check.mjs`（它确实 import 自己的
 * `erix-agent/contract-tests`）与几棵 worktree 刷屏，真正要看的两条命中就淹了。
 *
 * 目录级缓存：同一棵树上千个文件只读一次 `package.json`。
 *
 * @returns {(absFile: string) => boolean}
 */
export function makeOwnCheckoutDetector() {
  const cache = new Map();
  return (absFile) => {
    const walked = [];
    let dir = dirname(resolve(absFile));
    let verdict = false;
    for (;;) {
      if (cache.has(dir)) { verdict = cache.get(dir); break; }
      walked.push(dir);
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          verdict = JSON.parse(readFileSync(pkgPath, "utf8"))?.name === PACKAGE_NAME;
        } catch {
          verdict = false;   // 读不出 package.json 就当宿主（宁可多报，不可静默豁免）
        }
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const entry of walked) cache.set(entry, verdict);
    return verdict;
  };
}

/**
 * 探针本体（纯函数：`walk` / `read` 可注入，自测因此打内存夹具、不写盘）。
 *
 * `retired` 是**当前版本升级指南声称已删**的名字（issue #688）：删完之后那些名字不再是「零消费者候选」
 * （它们根本不在导出面上了），但宿主对它们的导入恰恰是**这一版已经打断**的引用——不把它们纳入求交，
 * 探针就会在「真删了」的那一版报告「0 处命中」，把最该被指南覆盖的那一笔账静默掉。
 *
 * @param {{hosts: string[], candidates: Array<{name: string}>, retired?: string[], registry?: object,
 *          walk?: (host: string) => object, read?: (abs: string) => string}} input
 * @returns {{hits: Array<object>, unresolved: Array<object>, skipped: Array<object>, stats: object}}
 */
export function probeHosts({
  hosts,
  candidates,
  retired = [],
  registry = REMOVAL_REGISTRY,
  walk = walkHost,
  read = (abs) => readFileSync(abs, "utf8"),
  isOwn = makeOwnCheckoutDetector(),
}) {
  const retiredNames = new Set(retired ?? []);
  const candidateNames = new Set([...(candidates ?? []).map((row) => row.name), ...retiredNames]);
  const hits = [];
  const unresolved = [];
  const skipped = [];
  const stats = { hosts: hosts.length, scannedFiles: 0, oversized: 0, unresolved: 0, ownCheckoutFiles: 0 };

  for (const host of hosts) {
    const walked = walk(host);
    if (walked.error) {
      skipped.push({ host, scope: "host", ...walked.error });
      continue;
    }
    for (const item of walked.unreadable ?? []) skipped.push({ host, scope: "entry", ...item });
    stats.oversized += (walked.oversized ?? []).length;
    for (const abs of walked.files ?? []) {
      if (isOwn(abs)) { stats.ownCheckoutFiles += 1; continue; }
      let text;
      try {
        text = read(abs);
      } catch (err) {
        skipped.push({ host, scope: "file", code: HOST_CODES.FILE_UNREADABLE, path: abs, message: `${abs} 读不出（${err.code ?? err.message}）` });
        continue;
      }
      stats.scannedFiles += 1;
      const parsed = extractErixImports(text, abs);
      for (const ref of parsed.refs) {
        if (!candidateNames.has(ref.name)) continue;
        hits.push({
          host,
          repo: hostRepoOf(abs, host),
          file: abs,
          rel: relative(host, abs).split(sep).join("/"),
          line: ref.line,
          name: ref.name,
          spec: ref.spec,
          kind: ref.kind,
          removalVersion: removalVersionOf(ref.name, registry),
          retired: retiredNames.has(ref.name),
        });
      }
      for (const row of parsed.unresolved) {
        unresolved.push({ host, file: abs, ...row });
        stats.unresolved += 1;
      }
    }
  }
  return { hits, unresolved, skipped, stats };
}

// ─────────────────────────────── 清点（复用，不抄） ───────────────────────────────

/**
 * 现算零消费者候选：与 `npm run check:exports` / `check:exports:deprecated` 走**同一条**路径。
 *
 * @returns {{inventory: object, candidates: Array<object>}}
 */
export function currentCandidates(root = DEFAULT_ROOT) {
  const records = buildRecords(root);
  const entryResolution = resolveEntries(root);
  // 宿主契约套件这一类不参与「零消费者」删除判据（消费者按定义在宿主仓）⇒ 也不进求交面。
  // 派生口径与 `check:exports` / `check:exports:deprecated` **同一份**（`hostContractNames()`，不抄名单）。
  const hostContract = hostContractNames(entryResolution.pkg, records);
  const inventory = computeInventory(records, {
    root,
    entries: entryResolution.entries,
    contractNames: hostContract.names,
    extraErrors: entryResolution.errors,
    extraWarnings: [...entryResolution.warnings, ...hostContract.warnings],
  });
  return { inventory, candidates: inventory.candidates ?? [] };
}

// ─────────────────────────────── 指南覆盖（机器交集） ───────────────────────────────

/**
 * 读当前版本升级指南的逐名表（中英两份）。
 *
 * 读法来自 `scripts/bundle-guide-table.mjs`（与 `check:docs` 的 `bundle-table` 对账同一份）：版本号、文件名、
 * 一行长什么样都只有那一份定义。读不出（文件没了 / 打不开）**不抛**：返回分类原因，调用侧据此 exit 2——
 * 「读不出真值」不许当成「没命中」。
 *
 * @param {string} root
 * @param {(abs: string) => string} read 注入点（自测打内存夹具，不写盘）
 * @returns {{guides: Array<{rel: string, rows: Map<string, object>}>, error: null|{code: string, message: string}}}
 */
export function readGuideTables(root = DEFAULT_ROOT, read = (abs) => readFileSync(abs, "utf8")) {
  const guides = [];
  for (const rel of BUNDLE_GUIDE_DOCS) {
    let text;
    try {
      text = read(join(root, rel));
    } catch (err) {
      return {
        guides: [],
        error: {
          code: err?.code === "ENOENT" ? GUIDE_CODES.TABLE_MISSING : GUIDE_CODES.TABLE_UNREADABLE,
          message: `${rel} 读不出（${err?.code ?? err?.message}）——覆盖判据的另一半（指南写了什么）无从核对`,
        },
      };
    }
    guides.push({ rel, rows: bundleRowsFromText(text).rows });
  }
  return { guides, error: null };
}

/**
 * 覆盖判定（纯函数：`hits` × `guides`，不打盘、不看时钟）。
 *
 * 判据只有一条：**命中名字在中英两份指南里都要有一行、且那一行的迁移条款格非空**。缺任一份、或条款格是
 * 空的（「有一行但没写怎么迁」= 读者拿不到迁移写法）⇒ 未覆盖。
 *
 * 为什么两份都要：指南中英成对是这一族的既有规矩（只改一边不算改）。只覆盖英文那份等于半个交付。
 *
 * @param {{hits: Array<{name: string}>, guides: Array<{rel: string, rows: Map<string, object>}>}} input
 * @returns {{covered: Array<{name: string, entries: Array<{rel: string, line: number, clause: string, entry: string}>,
 *            hits: Array<object>}>,
 *            uncovered: Array<{name: string, hits: Array<object>, reason: string, detail: string}>}}
 */
export function judgeHostCoverage({ hits, guides }) {
  const byName = new Map();
  for (const hit of hits) {
    const list = byName.get(hit.name) ?? [];
    list.push(hit);
    byName.set(hit.name, list);
  }
  const covered = [];
  const uncovered = [];
  for (const [name, nameHits] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entries = [];
    const missing = [];
    for (const guide of guides) {
      const row = guide.rows.get(name);
      if (!row) { missing.push(`${guide.rel}（没有 \`${name}\` 这一行）`); continue; }
      if (String(row.clause ?? "").trim() === "") {
        missing.push(`${guide.rel}:${row.line}（有一行，但迁移条款格是空的）`);
        continue;
      }
      entries.push({ rel: guide.rel, line: row.line, clause: row.clause, entry: row.entry });
    }
    if (missing.length) {
      uncovered.push({
        name,
        hits: nameHits,
        reason: COVERAGE_CODES.ENTRY_MISSING,
        detail: `缺指南条目：${missing.join("、")}`,
      });
    } else {
      covered.push({ name, entries, hits: nameHits });
    }
  }
  return { covered, uncovered };
}

/**
 * 退出码（与报告同一份裁决，不许两处各判一次）。
 *
 * `judged = false` ⇒ 0：那是「未判定」（没给宿主目录 / 目录读不出），不是绿也不是红——报告会照实说。
 * `judged = true` ⇒ 有未覆盖的名字就 1，全覆盖才 0。
 *
 * @param {{judged: boolean, uncovered: Array<object>}} input
 * @returns {0|1}
 */
export function exitCodeOf({ judged, uncovered }) {
  if (!judged) return 0;
  return (uncovered ?? []).length === 0 ? 0 : 1;
}

// ─────────────────────────────── 报告 ───────────────────────────────

export const CRITERIA = [
  "入口引用的形状：`import { … } from \"erix-agent\"` / `\"erix-agent/<子路径>\"`、`export { … } from …`、`require(\"erix-agent…\")`（含 `const { … } = require(…)` 解构）、动态 `import(\"erix-agent…\")`。",
  "候选清单来自 `scripts/export-consumer-check.mjs` 的 `computeInventory()`（现算，不抄第二份名单）。",
  "宿主契约套件（`exports[\"./contract-tests\"]` 这一类的导出名）**不在**候选里：它们的消费者按定义在宿主仓，仓内零命中是天然的 ⇒ 宿主导入它们不是「删除命中」。",
  "求交 = 宿主 import 的**导出名** ∩ 零消费者候选名；命中 = 「这个宿主现在就会被打断」，要的是**可见 + 可迁**，不是「不许删」。",
  "判据是**覆盖**：每个命中名字在**中英两份**当前版本升级指南里都要有一行逐名条目，且那一行的迁移条款格非空。做到 ⇒ 绿并逐条列出已知会被破坏的宿主引用；缺任一份 / 条款格空 ⇒ 红，点名宿主仓 / 文件:行 / 名字 / 缺哪一格。",
  "指南逐名表的读法来自 `scripts/bundle-guide-table.mjs`——与 `check:docs` 的 `bundle-table` 对账同一份读法，指南「写了什么」只有一个答案。",
  "解析不出名字的形状（命名空间 / 默认 / 裸 require / 动态 import / export *）逐类计数并打印，不静默丢弃。",
  "注释与字符串内容先涂白再解析：注释里写 `require('erix-agent')`、测试夹具里把 import 语句当字符串存，都不算一次导入。",
  "被探包**自己的检出**（最近的 `package.json` 的 `name` 是 `erix-agent`）不算宿主，跳过并计数——否则本仓自己的 `scripts/release-check.mjs` 会把自己的契约套件报成「宿主在用」。",
  "目录不存在 / 不可读不是错误：打印分类原因并 exit 0（CI 上没有宿主仓检出，探针不得变成硬依赖）。",
  "不给 `--hosts` 时只打印口径，exit 0——「没给目录」是**未判定**，不是绿。",
];

/**
 * 人读报告。
 *
 * @param {{probe: object, coverage: object, candidates: Array<object>, total: number,
 *          hosts: string[], root: string, judged: boolean, guideRead: object}} input
 */
export function renderReport({ probe, coverage, candidates, total, hosts, root, judged, guideRead, retiredCount = 0 }) {
  const lines = [];
  const hostSkips = probe.skipped.filter((row) => row.scope === "host");
  lines.push("host-consumer-probe：宿主仓 × 零消费者候选 求交，再拿命中的名字去指南里找条目（issue #429 的宿主侧半边）");
  lines.push("");
  lines.push(`根目录（被探的包）：${root}`);
  lines.push(`清点事实：${total} 个导出名 ⇒ 零消费者候选 ${candidates.length} 个`
    + "（`computeInventory()` 现算，未抄第二份名单）；求交面另外并入**当前指南声称已删**的名字"
    + `（issue #688：真删之后它们不再进候选清单，但宿主对它们的导入正是这一版已经打断的引用）：`
    + `${retiredCount} 个`);
  if (guideRead?.error) {
    lines.push(`指南表（${BUNDLE_GUIDE_VERSION}）：读不出 —— [${guideRead.error.code}] ${guideRead.error.message}`);
  } else {
    const rowsText = (guideRead?.guides ?? []).map((guide) => `${guide.rel} ${guide.rows.size} 行`).join("、");
    lines.push(`指南表（${BUNDLE_GUIDE_VERSION}）：${rowsText}`
      + "（读法与 `check:docs` 的 `bundle-table` 对账同一份：`scripts/bundle-guide-table.mjs`）");
  }
  lines.push("");
  if (!hosts.length) {
    lines.push("宿主目录：（未给 `--hosts`）");
    lines.push("");
    lines.push("结论：**未判定** —— 没给宿主目录，本探针无从求交。");
    lines.push("  这是 CI 的常态（CI 没有宿主仓检出），所以 `npm run check:host-consumers` 默认不阻断；");
    lines.push("  要判定就给目录：`node scripts/host-consumer-probe.mjs --hosts <目录>`（可多次 / 逗号分隔）。");
  } else {
    lines.push(`宿主目录：${hosts.join("、")}`);
    lines.push(`扫描：${probe.stats.scannedFiles} 个代码文件；本包自己的检出跳过 ${probe.stats.ownCheckoutFiles} 个；`
      + `超大文件跳过 ${probe.stats.oversized} 个；解析不出名字的引用 ${probe.stats.unresolved} 处；`
      + `整目录跳过 ${hostSkips.length} 个`);
    lines.push("");
    if (!judged) {
      lines.push("## 结论：**未判定** —— 给的宿主目录一个都读不出来（分类原因见下）");
      lines.push("  这不是绿：本探针没有看到任何宿主代码，覆盖判据无从成立。");
    } else if (coverage.uncovered.length > 0) {
      lines.push(`## 命中但指南没有条目（exit 1）：${coverage.uncovered.length} 个名字 —— 破坏不可见，也就不可迁`);
      for (const row of coverage.uncovered) {
        for (const hit of row.hits) {
          lines.push(`- \`${row.name}\` @ 宿主仓 \`${hit.repo}\` — \`${hit.file}:${hit.line}\``
            + `（\`${hit.kind}\` from \`${hit.spec}\`；登记删除版本 ${hit.removalVersion}）`
            + ` ⇒ [${row.reason}] ${row.detail}`);
        }
      }
      lines.push("");
      lines.push("怎么读这张表：这些名字现在删就会打断上面点名的宿主，而当前版本的升级指南没有告诉那个宿主怎么迁。");
      lines.push("处置是**补指南**（一行逐名条目 + 迁移写法），不是「不许删」——本仓是上游，删除由自己的版本边界决定；");
      lines.push("下游不握否决权。补完再跑一遍：绿 = 每一处已知的宿主引用都已被指南覆盖。");
    } else if (probe.hits.length === 0) {
      lines.push("## 命中：0 处");
      lines.push("结论：绿 —— 这次扫到的宿主检出里，没有一处静态导入「被登记为将删除」的零消费者导出，");
      lines.push("  所以这一版没有已知会被打断的宿主引用需要指南点名。");
      lines.push("  ⚠ 「0 处」只覆盖**这次扫到的目录 + 静态可解析的形状**（见下面的边界），不是「删了不会破坏任何宿主」的证明。");
    } else {
      lines.push(`## 命中（${probe.hits.length} 处）—— 全部已被 ${BUNDLE_GUIDE_VERSION} 指南覆盖：绿`);
      lines.push("这就是「已知会被破坏的宿主引用」清单：下面每一条在升级指南里都有对应条目，宿主照条目迁移即可。");
      for (const row of coverage.covered) {
        for (const hit of row.hits) {
          lines.push(`- \`${row.name}\` @ 宿主仓 \`${hit.repo}\` — \`${hit.file}:${hit.line}\``
            + `（\`${hit.kind}\` from \`${hit.spec}\`；登记删除版本 ${hit.removalVersion}`
            + `${hit.retired ? "；这一版已删" : ""}）`);
        }
        for (const entry of row.entries) {
          lines.push(`  ↳ 指南条目：\`${entry.rel}:${entry.line}\`（入口 ${entry.entry}）——迁移写法：${entry.clause}`);
        }
      }
      lines.push("");
      lines.push("怎么读这张表：命中 = **这一版删了就会打断上面那个宿主**，而指南已经写清怎么迁。");
      lines.push("所以它是「破坏可见、可迁」的清单，不是「不许发版」的清单：删不删由上游的版本边界决定。");
    }
  }
  if (probe.skipped.length) {
    lines.push("");
    lines.push("## 跳过 / 未判定（分类原因，不是静默绿）");
    for (const row of probe.skipped) {
      const where = row.path ?? row.host;
      lines.push(`- [${row.code}] ${where} — ${row.message}`);
    }
  }
  if (probe.unresolved.length) {
    lines.push("");
    lines.push(`## 解析不出名字的入口引用（${probe.unresolved.length} 处：不静默丢，但也证明不了「没在用」）`);
    const byKind = new Map();
    for (const row of probe.unresolved) {
      const list = byKind.get(row.kind) ?? [];
      list.push(row);
      byKind.set(row.kind, list);
    }
    for (const [kind, rows] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- \`${kind}\` × ${rows.length}：${rows.slice(0, 3).map((row) => `${row.file}:${row.line}`).join("、")}`
        + `${rows.length > 3 ? " …" : ""}`);
    }
  }
  lines.push("");
  lines.push("## 口径（每一句都可复算）");
  CRITERIA.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  lines.push("");
  lines.push("## 边界（本探针证明不了的事）");
  lines.push("  · 只认静态可解析的名单式引用：命名空间 / 默认 / 裸 require / 动态 import 解析不出名字，");
  lines.push("    它们单列在「解析不出名字」一节——那条通道既不能证明「在用」，也不能证明「没在用」。");
  lines.push("  · 宿主不在本机 ⇒ 这条判据不成立（报告写「未判定」）。它不替代宿主自己的契约测试。");
  lines.push("  · 它不判「指南写得对不对」（条款是否照抄标记、入口列是否写对、中英是否一致 = `check:docs` 的");
  lines.push("    `bundle-table` 那一半）；这里只问一件事：命中的名字，指南有没有写到它、有没有写怎么迁。");
  lines.push("");
  lines.push("## 逐字复现");
  lines.push("  node scripts/host-consumer-probe.mjs --hosts <宿主目录>   # 判定");
  lines.push("  node scripts/host-consumer-probe.mjs                     # 未判定（exit 0）");
  lines.push("  node scripts/host-consumer-probe.mjs --self-test          # 反向证");
  return lines.join("\n");
}

// ─────────────────────────────── 自测（反向证）───────────────────────────────

function runSelfTest() {
  const failures = [];
  const passed = [];
  const expect = (cond, okMsg, failMsg) => (cond ? passed.push(okMsg) : failures.push(failMsg));

  console.log("host-consumer-probe --self-test：反向证（内存夹具；仓内源码全程只读）");

  // ── 例① 多行名单式 import：名字与行号都要对，别名取 `as` 左边（导出名） ──
  {
    const text = [
      'import {',
      '  createAnthropicProvider,',
      '  runToolLoop as loop,',
      '} from "erix-agent";',
      "",
    ].join("\n");
    const { refs, unresolved } = extractErixImports(text, "host/src/a.js");
    const names = refs.map((row) => row.name);
    expect(
      names.includes("createAnthropicProvider") && names.includes("runToolLoop")
        && refs.find((row) => row.name === "createAnthropicProvider")?.line === 2
        && refs.find((row) => row.name === "runToolLoop")?.line === 3
        && unresolved.length === 0,
      `① 多行 import：解析出 ${JSON.stringify(names)}，行号 ${refs.map((r) => r.line).join("/")}，未解析 ${unresolved.length}`,
      `① 多行 import 没解析对：names=${JSON.stringify(names)} lines=${JSON.stringify(refs.map((r) => r.line))} unresolved=${JSON.stringify(unresolved)}`,
    );
  }

  // ── 例② 子路径入口（`erix-agent/contract-tests`）与 `export … from` 都要认 ──
  {
    const text = [
      'import { notesStoreContract } from "erix-agent/contract-tests";',
      'export { runToolLoop } from "erix-agent";',
      "",
    ].join("\n");
    const { refs } = extractErixImports(text, "host/src/b.js");
    const got = refs.map((row) => `${row.name}@${row.spec}`);
    expect(
      got.includes("notesStoreContract@erix-agent/contract-tests") && got.includes("runToolLoop@erix-agent"),
      `② 子路径 + 再导出：${JSON.stringify(got)}`,
      `② 子路径 / 再导出没认全：${JSON.stringify(got)}`,
    );
  }

  // ── 例③ 解析不出名字的形状逐类进 unresolved（不静默丢） ──
  {
    const text = [
      'import * as ns from "erix-agent";',
      'import defaultThing from "erix-agent";',
      'import "erix-agent";',
      'export * from "erix-agent";',
      'const whole = require("erix-agent");',
      'require("erix-agent");',
      'const lazy = () => import("erix-agent");',
      "",
    ].join("\n");
    const { refs, unresolved } = extractErixImports(text, "host/src/c.js");
    const kinds = new Set(unresolved.map((row) => row.kind));
    const expected = Object.values(UNRESOLVED_KINDS).filter((kind) => kind !== UNRESOLVED_KINDS.UNPARSED_SPEC);
    const missing = expected.filter((kind) => !kinds.has(kind));
    expect(
      refs.length === 0 && missing.length === 0,
      `③ 六种解析不出名字的形状逐类点名：${[...kinds].sort().join("、")}`,
      `③ 有形状被静默丢了：缺 ${JSON.stringify(missing)}（refs=${refs.length}）`,
    );
    expect(
      refs.length === 0,
      `③b 解析不出名字的形状一个都不进 refs（refs=${refs.length}）`,
      `③b 未解析形状被当成命中推进 refs 了：${JSON.stringify(refs)}`,
    );
  }

  // ── 例④ 注释里提到的 `require('erix-agent')` 不算导入（涂白证明） ──
  {
    const text = [
      "// node -p \"Object.keys(require('erix-agent'))\"",
      "/* import { notesStoreContract } from \"erix-agent/contract-tests\"; */",
      "",
    ].join("\n");
    const { refs, unresolved } = extractErixImports(text, "host/src/d.js");
    expect(
      refs.length === 0 && unresolved.length === 0,
      `④ 注释涂白：refs ${refs.length} / unresolved ${unresolved.length}（都应为 0）`,
      `④ 注释里的引用被当成真的了：refs=${JSON.stringify(refs)} unresolved=${JSON.stringify(unresolved)}`,
    );
  }

  // ── 例⑤ `const { a, b: c } = require(…)` 解构：导出名取属性名（`:` 左边） ──
  {
    const text = 'const { notesStoreContract, createAnthropicProvider: factory } = require("erix-agent");\n';
    const { refs } = extractErixImports(text, "host/src/e.js");
    const names = refs.map((row) => row.name).sort();
    expect(
      names.join(",") === "createAnthropicProvider,notesStoreContract",
      `⑤ require 解构：${JSON.stringify(names)}（取属性名，不是本地别名）`,
      `⑤ require 解构解析错：${JSON.stringify(names)}`,
    );
  }

  // ── 例⑥ 求交：只有**候选**名字才命中；非候选名字不命中（两态都钉住） ──
  {
    const fixture = {
      "/hosts/acme/src/adapter.js": [
        'import { notesStoreContract } from "erix-agent/contract-tests";',
        'import { runToolLoop } from "erix-agent";',
        "",
      ].join("\n"),
    };
    const walk = (host) => (host === "/hosts/acme"
      ? { error: null, files: Object.keys(fixture), oversized: [], unreadable: [] }
      : walkHost(host));
    const read = (abs) => fixture[abs];
    const candidates = [{ name: "notesStoreContract" }, { name: "createAnthropicProvider" }];
    const probe = probeHosts({ hosts: ["/hosts/acme"], candidates, walk, read });
    const hitNames = probe.hits.map((row) => row.name);
    expect(
      probe.hits.length === 1 && hitNames[0] === "notesStoreContract"
        && probe.hits[0].line === 1 && probe.hits[0].rel === "src/adapter.js"
        && probe.hits[0].removalVersion === removalVersionOf("notesStoreContract"),
      `⑥ 求交：命中 ${JSON.stringify(hitNames)}（非候选 \`runToolLoop\` 不命中），行 ${probe.hits[0]?.line}、`
        + `文件 ${probe.hits[0]?.rel}、登记删除版本 ${probe.hits[0]?.removalVersion}`,
      `⑥ 求交不对：hits=${JSON.stringify(probe.hits)}`,
    );
    // 变异：候选集合里去掉那个名字 ⇒ 同一份宿主代码不再命中（证明命中来自**现算候选**，不是抄的名单）
    const withoutCandidate = probeHosts({ hosts: ["/hosts/acme"], candidates: [{ name: "createAnthropicProvider" }], walk, read });
    expect(
      withoutCandidate.hits.length === 0,
      "⑥b 把 `notesStoreContract` 从候选集合里去掉 ⇒ 同一份宿主代码 0 命中（命中确实来自现算候选）",
      `⑥b 候选集合去掉后仍然命中 ${JSON.stringify(withoutCandidate.hits.map((row) => row.name))}——求交没有真的用候选集合`,
    );
  }

  // ── 例⑦ 目录不存在 / 不是目录 ⇒ 分类原因 + 0 命中（CI 上没有宿主仓时必须绿） ──
  {
    const missing = probeHosts({ hosts: ["/definitely/not/here"], candidates: [{ name: "notesStoreContract" }] });
    const notDir = probeHosts({ hosts: [join(DEFAULT_ROOT, "package.json")], candidates: [{ name: "notesStoreContract" }] });
    expect(
      missing.hits.length === 0 && missing.skipped.some((row) => row.code === HOST_CODES.DIR_MISSING)
        && notDir.hits.length === 0 && notDir.skipped.some((row) => row.code === HOST_CODES.DIR_NOT_DIR),
      `⑦ 目录不存在 ⇒ [${missing.skipped[0]?.code}] 0 命中；给的路径是文件 ⇒ [${notDir.skipped[0]?.code}] 0 命中`,
      `⑦ 目录不存在 / 不是目录没有走分类原因：missing=${JSON.stringify(missing.skipped)} notDir=${JSON.stringify(notDir.skipped)}`,
    );
  }

  // ── 例⑧ 变异没落地必须算失败（#210 R2）：靶串不在文本里时 `extractErixImports` 不许凭「没匹配」给出命中 ──
  {
    const text = 'import { something } from "other-package";\n';
    const { refs } = extractErixImports(text, "host/src/f.js");
    expect(
      refs.length === 0,
      "⑧ 别的包的 import 不进 refs（0 条）——探针只认 erix-agent 的入口说明符",
      `⑧ 别的包也被当成命中：${JSON.stringify(refs)}`,
    );
  }

  // ── 例⑨⑩⑪ 覆盖判据的三态（#429 纠错的核心）：命中 + 指南无条目 ⇒ 红；补上条目 ⇒ 绿；删掉条目 ⇒ 又红 ──
  //
  // 这一组打在 `readGuideTables()` + `judgeHostCoverage()` + `exitCodeOf()` 这条**真链路**上（注入读盘函数，
  // 夹具是内存里的指南文本），不是打在某个字符串匹配上：改坏任何一环，三态就会有一态不对。
  {
    const fixtureRoot = "/fixtures/root";
    const guideText = (rows) => [
      "| Name | What it did | Migration clause | Entry | Definition |",
      "|---|---|---|---|---|",
      ...rows.map(([name, clause]) => `| \`${name}\` | did a thing | ${clause} | \`.\` | \`${name}\` (\`src/x.js\`) |`),
      "",
    ].join("\n");
    const makeRead = (rowsByName) => (abs) => {
      const rel = abs.slice(fixtureRoot.length + 1);
      if (!(rel in rowsByName)) {
        const err = new Error(`no ${rel}`);
        err.code = "ENOENT";
        throw err;
      }
      return rowsByName[rel];
    };
    const hit = {
      name: "createAnthropicProvider", repo: "mini-host", file: "/hosts/acme/src/a.js", line: 3,
      kind: "import-names", spec: "erix-agent", removalVersion: "0.30",
    };
    const judge = (rowsByName) => {
      const read = readGuideTables(fixtureRoot, makeRead(rowsByName));
      return {
        read,
        coverage: judgeHostCoverage({ hits: [hit], guides: read.guides }),
        exit: exitCodeOf({ judged: true, uncovered: judgeHostCoverage({ hits: [hit], guides: read.guides }).uncovered }),
      };
    };
    const CLAUSE = "no in-tree replacement — the host builds it itself";

    // ⑨ 命中但指南没有这一行 ⇒ 未覆盖、exit 1，且点名缺哪一份
    const before = judge({
      [BUNDLE_GUIDE_DOCS[0]]: guideText([["somethingElse", CLAUSE]]),
      [BUNDLE_GUIDE_DOCS[1]]: guideText([["somethingElse", CLAUSE]]),
    });
    expect(
      before.coverage.uncovered.length === 1 && before.coverage.uncovered[0].name === "createAnthropicProvider"
        && before.coverage.uncovered[0].reason === COVERAGE_CODES.ENTRY_MISSING
        && BUNDLE_GUIDE_DOCS.every((rel) => before.coverage.uncovered[0].detail.includes(rel))
        && before.exit === 1,
      `⑨ 命中 + 指南无条目 ⇒ 未覆盖 ${JSON.stringify(before.coverage.uncovered.map((row) => row.name))}、exit ${before.exit}`
        + `（点名两份都缺）`,
      `⑨ 命中但指南没条目时没有判红：${JSON.stringify(before.coverage.uncovered)} exit=${before.exit}`,
    );

    // ⑩ 补上指南条目（中英两份）⇒ 覆盖、exit 0，且把条目行号带出来
    const after = judge({
      [BUNDLE_GUIDE_DOCS[0]]: guideText([["createAnthropicProvider", CLAUSE]]),
      [BUNDLE_GUIDE_DOCS[1]]: guideText([["createAnthropicProvider", CLAUSE]]),
    });
    expect(
      after.coverage.covered.length === 1 && after.coverage.uncovered.length === 0 && after.exit === 0
        && after.coverage.covered[0].entries.length === 2
        && after.coverage.covered[0].entries.every((entry) => entry.line === 3 && entry.clause === CLAUSE),
      `⑩ 补上指南条目 ⇒ 覆盖 ${JSON.stringify(after.coverage.covered.map((row) => row.name))}、`
        + `条目行 ${after.coverage.covered[0]?.entries.map((e) => `${e.rel}:${e.line}`).join("、")}、exit ${after.exit}`,
      `⑩ 补上条目后仍未判绿：${JSON.stringify(after.coverage)} exit=${after.exit}`,
    );

    // ⑪ 把条目删掉 ⇒ 又红（同一份夹具的三态闭合：红 → 绿 → 红）
    const again = judge({
      [BUNDLE_GUIDE_DOCS[0]]: guideText([["somethingElse", CLAUSE]]),
      [BUNDLE_GUIDE_DOCS[1]]: guideText([["createAnthropicProvider", CLAUSE]]),
    });
    expect(
      again.coverage.uncovered.length === 1 && again.exit === 1
        && again.coverage.uncovered[0].detail.includes(BUNDLE_GUIDE_DOCS[0]),
      `⑪ 删掉英文那份的条目 ⇒ 又红（exit ${again.exit}），且只点名缺的那一份`,
      `⑪ 删掉条目后没有判红：${JSON.stringify(again.coverage.uncovered)} exit=${again.exit}`,
    );

    // ⑫「有一行但迁移条款格是空的」不算覆盖：读者拿不到迁移写法 = 破坏不可迁
    const emptyClause = judge({
      [BUNDLE_GUIDE_DOCS[0]]: guideText([["createAnthropicProvider", ""]]),
      [BUNDLE_GUIDE_DOCS[1]]: guideText([["createAnthropicProvider", CLAUSE]]),
    });
    expect(
      emptyClause.coverage.uncovered.length === 1 && emptyClause.exit === 1
        && emptyClause.coverage.uncovered[0].detail.includes("迁移条款格是空的"),
      `⑫ 条目在但迁移条款格空 ⇒ 仍红（exit ${emptyClause.exit}）`,
      `⑫ 迁移条款格空也被当成覆盖了：${JSON.stringify(emptyClause.coverage)}`,
    );

    // ⑬ 指南表读不出 ⇒ 分类原因（调用侧 exit 2），不是「0 命中所以绿」
    const missing = readGuideTables(fixtureRoot, makeRead({}));
    expect(
      missing.guides.length === 0 && missing.error?.code === GUIDE_CODES.TABLE_MISSING,
      `⑬ 指南表不存在 ⇒ [${missing.error?.code}] ${missing.error?.message}`,
      `⑬ 指南表读不出没有走分类原因：${JSON.stringify(missing)}`,
    );
  }

  if (failures.length) {
    console.log("");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log(`\nhost-consumer-probe --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    return 1;
  }
  for (const ok of passed) console.log(`  ✓ ${ok}`);
  console.log(`\nhost-consumer-probe --self-test: OK — ${passed.length} 条判据全部按预期（内存夹具，不写盘、不碰仓内源码）`);
  return 0;
}

// ─────────────────────────────── main ───────────────────────────────

function parseArgs(argv) {
  const opts = { json: false, selfTest: false, root: DEFAULT_ROOT, hosts: [], help: false };
  const addHosts = (value) => {
    for (const piece of String(value ?? "").split(",")) {
      const trimmed = piece.trim();
      if (trimmed !== "") opts.hosts.push(resolve(trimmed));
    }
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--hosts") { addHosts(argv[i + 1]); i += 1; }
    else if (arg.startsWith("--hosts=")) addHosts(arg.slice("--hosts=".length));
    else if (arg === "--root") { opts.root = resolve(argv[i + 1] ?? ""); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`host-consumer-probe: 不认识的参数 ${JSON.stringify(arg)}（支持 --hosts <目录> / --json / --root <dir> / --self-test / --help）`);
      process.exit(2);
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("用法：node scripts/host-consumer-probe.mjs --hosts <目录> [--hosts <目录2>] [--json] [--root <dir>] [--self-test]");
    return 0;
  }
  if (opts.selfTest) return runSelfTest();

  const { inventory, candidates } = currentCandidates(opts.root);
  if (inventory.incomplete) {
    const codes = inventory.errors.map((error) => error.code);
    console.error(`host-consumer-probe: 清点不完整（exit 2）——清点工具报 ${codes.join(",")}`);
    for (const error of inventory.errors) console.error(`  - [${error.code}] ${error.message}`);
    console.error("  候选清单不是真值 ⇒ 求交无从谈起（不许把「读不出」当成「没问题」）");
    return 2;
  }

  // 指南表是判据的另一半。**只有判定了才把它当硬真值**：没给宿主目录时这一格是「未判定」，
  // 指南读不出不该把 CI 形态（`npm run check:host-consumers`，无参数）压红——但报告要照实说出来。
  // 它同时给出求交面的另一半：指南声称已删的名字（issue #688 之后真删的那批不再进候选清单）。
  const guideRead = readGuideTables(opts.root);
  const retiredNames = [...new Set((guideRead.guides ?? []).flatMap((guide) => [...guide.rows.keys()]))].sort();
  const probe = probeHosts({ hosts: opts.hosts, candidates, retired: retiredNames });
  const hostSkips = probe.skipped.filter((row) => row.scope === "host");
  const judged = opts.hosts.length > 0 && hostSkips.length < opts.hosts.length;
  if (judged && guideRead.error) {
    console.error(`host-consumer-probe: 指南表读不出（exit 2）——[${guideRead.error.code}] ${guideRead.error.message}`);
    console.error("  覆盖判据 = 宿主命中 × 指南条目；缺一半就无从判定（不许把「读不出」当成「没命中」）");
    return 2;
  }
  const coverage = judgeHostCoverage({ hits: probe.hits, guides: guideRead.guides });
  const exitCode = exitCodeOf({ judged, uncovered: coverage.uncovered });

  if (opts.json) {
    console.log(JSON.stringify({
      tool: "host-consumer-probe",
      generatedFor: "issue #429 的宿主侧半边：宿主仓真的在导入的零消费者导出，× 当前版本升级指南的覆盖",
      gate: judged,
      verdict: !judged ? "not-judged" : (exitCode === 0 ? "covered" : "uncovered"),
      root: opts.root,
      hosts: opts.hosts,
      defaultRemovalVersion: DEFAULT_REMOVAL_VERSION,
      nextBreakingVersion: DEFAULT_REMOVAL_VERSION,
      removalRegistry: REMOVAL_REGISTRY,
      guideVersion: BUNDLE_GUIDE_VERSION,
      guides: (guideRead.guides ?? []).map((guide) => ({ rel: guide.rel, rows: guide.rows.size })),
      guideError: guideRead.error ?? null,
      total: inventory.total,
      candidates: candidates.map((row) => ({ name: row.name, def: row.def, removalVersion: removalVersionOf(row.name) })),
      hits: probe.hits,
      covered: coverage.covered.map((row) => ({
        name: row.name,
        hits: row.hits.map((hit) => ({ repo: hit.repo, file: hit.file, line: hit.line })),
        entries: row.entries,
      })),
      uncovered: coverage.uncovered.map((row) => ({
        name: row.name,
        reason: row.reason,
        detail: row.detail,
        hits: row.hits.map((hit) => ({ repo: hit.repo, file: hit.file, line: hit.line })),
      })),
      unresolved: probe.unresolved,
      skipped: probe.skipped,
      stats: probe.stats,
      judged,
      criteria: CRITERIA,
      boundary: "只认静态可解析的名单式入口引用；宿主不在本机时这条判据不成立（未判定，不是绿）。"
        + "本探针不判「指南写得对不对」（那是 check:docs 的 bundle-table 那一半）",
      reproduce: [
        "node scripts/host-consumer-probe.mjs --hosts <宿主目录>",
        "node scripts/host-consumer-probe.mjs --self-test",
      ],
    }, null, 2));
  } else {
    console.log(renderReport({
      probe, coverage, candidates, total: inventory.total,
      hosts: opts.hosts, root: opts.root, judged, guideRead, retiredCount: retiredNames.length,
    }));
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
