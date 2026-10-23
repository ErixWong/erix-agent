#!/usr/bin/env node
// issue #406 裁定③ 的配套件；也服务 #419③ 那类「import 了却没人调」。
//
// 它回答一个问题：**公共入口导出的名字里，哪些在仓内除定义处之外没有任何消费者**，
// 输出成一张能直接贴进 issue 的表。它**只是清点**：默认 exit 0，不参与任何门禁判定。
// 删除任何导出都**不是**这张票的事——那要等宿主迁移 + 版本边界（另一张票），
// 所以这里既不判红也不给建议，只把事实摆出来。
//
// ── 口径（每一句都是可复算的，改口径先改这里）─────────────────────────────────
//  1. 入口 = `package.json` 的 `exports` 里**每一个**代码子路径（今天三个：`.` → `src/index.js`、
//     `./tools` → `src/tools/index.js`、`./contract-tests` → `test/contract/index.js`）。
//     入口清单从 `package.json` **现读**（`resolveEntries()`），不另抄一份——少扫一个入口就是
//     「清点漏了 11 个导出」，那是这张票修掉的口径漏洞①。
//     只认**名单式再导出** `export { a, b as c } from "./x.js"`：名字取 `as` 右边的对外名，
//     **定义处 = `from` 指的那个文件**（不是入口文件本身）。
//  2. 消费者分**三档**，报告里分开标（口径漏洞②）：
//     · 包内消费者（package）= `src/`、`bin/` 的 `.js`/`.mjs`/`.cjs`；
//     · 发布面消费者（publish）= `examples/`、`test/contract/`——`files` 里含 `test/contract`，
//       随包发布、宿主安装后自己跑，那里的引用是**真消费**，不是「测试里的自娱自乐」；
//     · 暴露面（test / docs / scripts）= `test/`（除 `test/contract/`）、`docs/`、`scripts/`，
//       单列成「自身测试数 / 文档提及数 / 脚本提及数」，**不算消费者**（暴露面 ≠ 使用）。
//  3. 「可删候选」只在**包内与发布面都零命中**时才成立；任一档有命中就不是候选。
//  4. 名字在**自己定义文件内**、除声明那一处之外还被引用 ⇒ `internal-only`（口径漏洞③）：
//     那不是死导出，是「只在本文件内部用的导出」，删除动作完全不同（去掉 `export`，不是删符号）。
//     它单列一档，**不混进「零引用」**，免得读者拿一个混口径的数去删东西。
//  5. 入口文件自己的命中**不算消费者**：入口的 `export { … }` 行就是暴露面本身，
//     把它算进去会让所有名字**全部**「有消费者」（自己消费自己），清点直接失去意义。
//     入口文件里**export 语句之外**的代码仍然算消费者（`maskSpans()` 只挖掉语句区间）。
//  6. `scripts/` 的命中也不计入消费者（脚本是开发工具，不是产品代码），只在 `--json` 里留一列
//     `scriptMentions`；报告里若有名字只被 `scripts/` 提到过，会单列一行说明，免得读者以为没人用过。
//  7. 命中判据 = 标识符边界（`(?<![\w$])NAME(?![\w$])`），所以 `extractL0` 不会被 `extractL0Facts`
//     的命中顶替成「有消费者」。注释里的字面提及**照算**（工单口径是「搜这个名字」）；
//     想只看代码可以再谈口径，但那是另一张票。
//
// ── 三个坑（本仓明文警告过，主 agent 亲手踩过两次；每一条都在 `--self-test` 里有反向证）──
//  坑 1：`new RegExp(…, "g")` 配 `.test()` / `.exec()` 是**有状态**的（`lastIndex` 会推进），
//        交替匹配时**漏报**。本脚本的计数走 `countNameHits()`：每次调用**新建**正则并走
//        `String.prototype.matchAll`（`matchAll` 内部复制正则，不共享 `lastIndex`）。
//        `--self-test` 的例②用一份「错误实现的复刻」证明这个坑是真的：同一份假树，
//        状态化口径把消费者漏掉 ⇒ 候选数从 0 变成 1（假候选）。
//  坑 2：注释里也会出现导出名——`export { … }` 的花括号里可能夹注释，朴素 `split(",")` 会把
//        整行注释当成一个名字（主 agent 第一版就产出了一个 `// issue #220：…` 当名字）。
//        本脚本的规矩是：**名字必须匹配 `/^[A-Za-z_$][\w$]*$/`，不匹配就抛 `ExportParseError`**，
//        不许静默吞掉（静默吞掉 = 少报一个导出 = 清点假绿）。`--self-test` 的例③把这条钉住。
//  坑 3：`export * from "…"` 没有名字列表 ⇒ 本工具**不展开**它。发现就明确报
//        「本工具不展开 `export *`，已发现 N 处」并把 `incomplete` 置真（exit 2），不许静默漏。
//        同理，入口里若出现 `export function` / `export default` 这类**非名单式**导出，
//        也记成 `unsupported` 并让清点变 incomplete——它们同样会让「总数」变成假数。
//
// ── 退出码（本仓惯例：读不出真值就红，不许假绿）─────────────────────────────
//  0 = 清点完成（**不代表任何判定**，零消费者也不是错误）。
//  2 = 清点不完整。`--json` 的 `errors[].code` 逐类可区分（口径漏洞④：两个「读不出真值却给 exit 0」
//      的漏口各有自己的码，不再静默跳过）：
//      PACKAGE_UNREADABLE           `package.json` 读不到/解析不了 ⇒ 不知道公共入口有几个
//      PACKAGE_EXPORTS_UNREADABLE   `exports` 里抽不出代码目标 ⇒ 同上（入口清单不是真值）
//      ENTRY_MISSING                入口文件读不到（`exports` 点名了，扫描面里没有）
//      CORPUS_DIR_UNREADABLE        扫描面目录不存在/读不出（静默跳过会让总数照算、面缺一块）
//      CORPUS_FILE_UNREADABLE       扫描面里的文件读不出
//      DEFINITION_MISSING           名字的定义文件不存在
//      DEFINITION_SYMBOL_MISSING    定义文件存在，但里面找不到这个名字（连声明那一处都没有）
//      EXPORT_PARSE_ERROR           名单里有解析不了的名字
//      EXPORT_STAR_UNEXPANDED       有 `export *` 没展开
//      EXPORT_FORM_UNSUPPORTED      有非名单式导出（`export function` 之类）没展开
//      以上任何一种都让「总数」与「零引用清单」不是真值，必须红。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/export-consumer-check.mjs                 # 人读报告（默认 exit 0）
//   node scripts/export-consumer-check.mjs --json           # 机器读（给以后挂别的工具）
//   node scripts/export-consumer-check.mjs --root <dir>     # 换根目录（自测/测试用）
//   node scripts/export-consumer-check.mjs --self-test      # 反向证（内存假集合 + 真树内存副本）
//
// 自测与测试**都不写仓内源码**：变异打在内存副本上（与 #411 同一纪律），临时目录走
// `test/helpers/tmp.js` 的 `makeTmp()`。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 公共入口的**内置兵底清单**（`package.json` 读得到时以 `exports` 为准，见 `resolveEntries()`）。
 *  今天三个：`.` / `./tools` / `./contract-tests`——三个都是发布面（`files` 里含 `test/contract`）。 */
export const ENTRIES = ["src/index.js", "src/tools/index.js", "test/contract/index.js"];
/** 包内消费者面（口径 2 第一档）。 */
export const CONSUMER_DIRS = ["src", "bin"];
/** 发布面消费者（口径 2 第二档）：`examples/` 与随包发布的 `test/contract/`。 */
export const PUBLISH_DIRS = ["examples", "test/contract"];
/** 暴露面：命中单列成「自身测试数 / 文档提及数」，**不算消费者**（口径 2 第三档）。 */
export const TEST_DIR = "test";
export const DOCS_DIR = "docs";
/** 开发工具面：只留痕，不参与判定（口径 6）。 */
export const SCRIPT_DIR = "scripts";
/** 实扫的目录（`test/` 含 `test/contract/`，扫一次就够；分档靠 `tierOf()` 的路径前缀）。 */
export const SCAN_DIRS = ["src", "bin", "examples", TEST_DIR, DOCS_DIR, SCRIPT_DIR];
/** 必须存在的扫描面目录：**不存在就是读不出真值**（口径漏洞④a：静默跳过会让总数照算而面缺一块）。 */
export const REQUIRED_DIRS = ["src", "bin", "examples", TEST_DIR, "test/contract", DOCS_DIR, SCRIPT_DIR];
const CODE_EXTS = [".js", ".mjs", ".cjs"];
const DOC_EXTS = [".md"];
/** 导出名 / 本地名的合法形状（坑 2 的硬闸）。 */
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** 解析失败（坑 2 / 坑 3 / 入口缺失）统一走这个具名错误，调用方据此把清点判成 incomplete。 */
export class ExportParseError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ExportParseError";
    this.code = "EXPORT_PARSE_ERROR";
    Object.assign(this, detail);
  }
}

/**
 * 一个仓库相对路径落在哪一档（口径 2）。**`test/contract/` 先于 `test/` 判**——它是发布面，
 * 不是「自身测试」；这一条就是口径漏洞②的修复点。
 *
 * @returns {"package" | "publish" | "test" | "docs" | "scripts" | "other"}
 */
export function tierOf(rel) {
  const under = (dir) => rel === dir || rel.startsWith(`${dir}/`);
  if (PUBLISH_DIRS.some(under)) return "publish";
  if (CONSUMER_DIRS.some(under)) return "package";
  if (under(TEST_DIR)) return "test";
  if (under(DOCS_DIR)) return "docs";
  if (under(SCRIPT_DIR)) return "scripts";
  return "other";
}

// ─────────────────────────────── 文本工具 ───────────────────────────────

/**
 * 剥掉 `//` 与 `/* *\/` 注释，**尊重字符串字面量**（`"http://x"` 里的 `//` 不是注释）。
 * 块注释里的换行会被保留，行号因此不会漂。
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i += 1; }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 数一个名字在文本里出现了几次（标识符边界，口径 6）。
 *
 * **坑 1 的正解**：每次调用新建正则 + `matchAll`。`matchAll` 要求 `g` 并把正则**复制**一份再扫，
 * 所以这里不会出现「同一个正则对象的 `lastIndex` 在两次调用之间残留」那种漏报。
 * 绝不写成 `const re = /…/g; re.test(line)`——那是有状态的（`--self-test` 例②的靶子）。
 */
export function countNameHits(text, name) {
  if (!text || !name) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g");
  let count = 0;
  for (const _ of text.matchAll(re)) count += 1;   // eslint-disable-line no-unused-vars
  return count;
}

/** 把一组区间（`{start,end}`，升序）挖成等长空白，保留换行。入口的 export 语句靠它屏蔽（口径 3）。 */
export function maskSpans(text, spans) {
  let out = "";
  let cursor = 0;
  for (const { start, end } of spans) {
    if (start < cursor) continue;   // 区间重叠（不会发生，防御性）
    out += text.slice(cursor, start);
    out += text.slice(start, end).replace(/[^\n]/g, " ");
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

// ─────────────────────────────── 语句扫描（import / export）───────────────────────────────

function skipTrivia(text, i) {
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i += 1; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    break;
  }
  return i;
}

/** 从 `{` 起找到配对的 `}`（跳过字符串与注释）；找不到 ⇒ 解析失败，不静默截断。 */
function findBraceClose(text, open) {
  let depth = 0;
  let i = open;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; i += 1; continue; }
    if (ch === "/" && next === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && next === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** 语句结束位置：`from "…"` 之后吃掉可选的 `;`（同一行内），返回下一个游标。 */
function endOfStatement(text, i) {
  const j = skipTrivia(text, i);
  return text[j] === ";" ? j + 1 : i;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

/**
 * 扫一份文本里的模块级语句（`import … from`、`export …`）。
 *
 * 只在**行首**认关键字（`^\s*import` / `^\s*export`），这样字符串/注释里出现的同名词不会误判；
 * 语句区间是**原文坐标**，供 `maskSpans()` 屏蔽用。
 *
 * @returns {{statements: Array<object>}} 每条：`{ kind, start, end, line, ... }`
 *   `kind: "export-names" | "export-star" | "export-unsupported" | "import-names" | "import-bare" | "import-ns" | "import-unsupported"`
 */
export function scanModuleStatements(text) {
  const statements = [];
  let i = 0;
  const n = text.length;
  let atLineStart = true;
  while (i < n) {
    const ch = text[i];
    if (ch === "\n") { atLineStart = true; i += 1; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i += 1; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    const keyword = atLineStart ? /^(import|export)(?![\w$])/.exec(text.slice(i, i + 7)) : null;
    if (!keyword) { atLineStart = false; i += 1; continue; }
    const kind = keyword[1];
    const start = i;
    const line = lineOf(text, i);
    let j = skipTrivia(text, i + kind.length);
    if (kind === "export") {
      if (text[j] === "*") {
        // `export * from "…"` / `export * as ns from "…"`（坑 3）
        const from = /^from\s*["']([^"']+)["']/.exec(text.slice(skipTrivia(text, j + 1)).replace(/^as\s+[A-Za-z_$][\w$]*\s+/, ""));
        const end = endOfStatement(text, j + 1);
        statements.push({ kind: "export-star", start, end, line, from: from?.[1] ?? null, raw: text.slice(start, Math.max(end, j + 1)).trim() });
        i = Math.max(end, j + 1);
        atLineStart = false;
        continue;
      }
      if (text[j] === "{") {
        const close = findBraceClose(text, j);
        if (close < 0) throw new ExportParseError(`第 ${line} 行的 \`export {\` 找不到配对的 \`}\`——语句扫描失效，清点不是真值`, { line });
        const specText = stripComments(text.slice(j + 1, close));   // 坑 2：先剥注释，再切逗号
        const afterFrom = skipTrivia(text, close + 1);
        const fromMatch = /^from\s*["']([^"']+)["']/.exec(text.slice(afterFrom));
        const end = fromMatch ? endOfStatement(text, afterFrom + fromMatch[0].length) : endOfStatement(text, close + 1);
        statements.push({
          kind: "export-names", start, end, line,
          specText, from: fromMatch?.[1] ?? null,
          raw: text.slice(start, Math.max(end, close + 1)).trim(),
        });
        i = Math.max(end, close + 1);
        atLineStart = false;
        continue;
      }
      // `export function` / `export default` / `export const` …：非名单式导出，本工具不展开（坑 3 的同款）
      const end = endOfStatement(text, j);
      statements.push({ kind: "export-unsupported", start, end: Math.max(end, j), line, raw: text.slice(start, Math.max(end, j)).trim() });
      i = Math.max(end, j);
      atLineStart = false;
      continue;
    }
    // import
    if (text[j] === '"' || text[j] === "'") {   // `import "x"`（纯副作用）
      const close = text.indexOf(text[j], j + 1);
      const end = endOfStatement(text, close < 0 ? j : close + 1);
      statements.push({ kind: "import-bare", start, end, line, specText: "", from: close < 0 ? null : text.slice(j + 1, close) });
      i = Math.max(end, j + 1);
      atLineStart = false;
      continue;
    }
    if (text[j] === "{") {
      const close = findBraceClose(text, j);
      if (close < 0) throw new ExportParseError(`第 ${line} 行的 \`import {\` 找不到配对的 \`}\`——语句扫描失效，清点不是真值`, { line });
      const specText = stripComments(text.slice(j + 1, close));
      const afterFrom = skipTrivia(text, close + 1);
      const fromMatch = /^from\s*["']([^"']+)["']/.exec(text.slice(afterFrom));
      const end = fromMatch ? endOfStatement(text, afterFrom + fromMatch[0].length) : endOfStatement(text, close + 1);
      statements.push({ kind: "import-names", start, end, line, specText, from: fromMatch?.[1] ?? null });
      i = Math.max(end, close + 1);
      atLineStart = false;
      continue;
    }
    if (text[j] === "*") {
      const m = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(text.slice(j));
      const end = endOfStatement(text, j + 1);
      statements.push({ kind: "import-ns", start, end, line, specText: m ? m[1] : "", from: null });
      i = Math.max(end, j + 1);
      atLineStart = false;
      continue;
    }
    {
      // `import d from "x"` / `import d, { a } from "x"`
      const m = /^([A-Za-z_$][\w$]*)\s*(,)?/.exec(text.slice(j));
      const end = endOfStatement(text, j + 1);
      statements.push({ kind: m ? "import-default" : "import-unsupported", start, end, line, specText: m ? m[1] : "", from: null });
      i = Math.max(end, j + 1);
      atLineStart = false;
      continue;
    }
  }
  return { statements };
}

/** 把 `{ a, b as c }` 的花括号内容切成名字表；**不合法就抛错**（坑 2：不静默吞）。 */
function parseSpecList(specText, ctx) {
  const out = [];
  for (const rawSpec of specText.split(",")) {
    const spec = rawSpec.trim().replace(/\s+/g, " ");
    if (!spec) continue;
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(spec);
    if (!m) {
      throw new ExportParseError(
        `${ctx} 里的导出名 ${JSON.stringify(spec)} 不是合法标识符——`
        + "要么是注释没剥干净，要么是解构/字符串式导出（本工具只认名单式再导出）；"
        + "静默吞掉就等于少报一个导出，所以这里直接判失败",
        { spec, where: ctx },
      );
    }
    if (!IDENT_RE.test(m[1])) throw new ExportParseError(`${ctx}：本地名 ${JSON.stringify(m[1])} 不合法`, { spec, where: ctx });
    out.push({ local: m[1], name: m[2] ?? m[1] });
  }
  return out;
}

/**
 * 解析一个入口文件，得到「对外名 → 定义文件」的映射（口径 1）。
 *
 * @param {string} text 入口原文
 * @param {string} entryRel 入口相对路径（`src/index.js`）
 * @returns {{names: Array<{name: string, local: string, def: string, entry: string, line: number}>,
 *            exportStars: Array<object>, unsupported: Array<object>, maskedText: string, statements: Array<object>}}
 */
export function parseEntryExports(text, entryRel) {
  const { statements } = scanModuleStatements(text);
  const names = [];
  const exportStars = [];
  const unsupported = [];
  const masked = [];
  for (const stmt of statements) {
    if (stmt.kind === "export-star") {
      exportStars.push({ entry: entryRel, line: stmt.line, raw: stmt.raw, from: stmt.from });
      masked.push({ start: stmt.start, end: stmt.end });
      continue;
    }
    if (stmt.kind === "export-unsupported") {
      unsupported.push({ entry: entryRel, line: stmt.line, raw: stmt.raw });
      masked.push({ start: stmt.start, end: stmt.end });
      continue;
    }
    if (stmt.kind !== "export-names") continue;
    masked.push({ start: stmt.start, end: stmt.end });
    if (!stmt.from) {
      // `export { a }`（无 from）：定义就在入口文件自己身上。
      for (const { local, name } of parseSpecList(stmt.specText, `${entryRel}:${stmt.line}`)) {
        names.push({ name, local, def: entryRel, entry: entryRel, line: stmt.line });
      }
      continue;
    }
    const def = relativePath(dirname(entryRel), stmt.from);
    for (const { local, name } of parseSpecList(stmt.specText, `${entryRel}:${stmt.line}`)) {
      names.push({ name, local, def, entry: entryRel, line: stmt.line });
    }
  }
  return { names, exportStars, unsupported, maskedText: maskSpans(text, masked), statements };
}

function relativePath(fromDir, spec) {
  const abs = resolve("/", fromDir, spec);
  return abs.slice(1);   // 去掉前导 "/"：得到 `src/…` 形式的仓库相对路径
}

// ─────────────────────────────── 语料 ───────────────────────────────

/** 递归列文件。**读不出就报**，不静默跳过（口径漏洞④a）。错误推进 `errors`，不另造返回值。 */
function walkFiles(root, dirRel, exts, out = [], errors = []) {
  const abs = join(root, dirRel);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch (err) {
    errors.push({
      code: "CORPUS_DIR_UNREADABLE",
      message: `${dirRel}/ 读不出（${err.code ?? err.message}）——`
        + "静默跳过会让总数照算、消费者面却缺一块，清点不是真值",
    });
    return out;
  }
  for (const name of entries.sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const rel = `${dirRel}/${name}`;
    let st;
    try {
      st = statSync(join(root, rel));
    } catch (err) {
      errors.push({ code: "CORPUS_FILE_UNREADABLE", message: `${rel} 读不出元信息（${err.code ?? err.message}）——该文件的命中数不可知` });
      continue;
    }
    if (st.isDirectory()) walkFiles(root, rel, exts, out, errors);
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

/**
 * 扫一棵树：`{records, errors}`。`errors` 里的两类码（目录读不出 / 文件读不出）**必须**进清点，
 * 否则「总数照算」就是假绿（口径漏洞④a）。
 *
 * @returns {{records: Array<{rel: string, text: string}>, errors: Array<{code: string, message: string}>}}
 */
export function scanCorpus(root, dirs = SCAN_DIRS) {
  const records = [];
  const errors = [];
  // 必须存在的目录：嵌套的（`test/contract`）顶层扫不到「自己」，得单独核。
  for (const dir of REQUIRED_DIRS) {
    if (dirs.includes(dir)) continue;   // 顶层目录由 walkFiles 自己报
    let st = null;
    try { st = statSync(join(root, dir)); } catch { /* 下面统一报 */ }
    if (!st || !st.isDirectory()) {
      errors.push({
        code: "CORPUS_DIR_UNREADABLE",
        message: `${dir}/ 不存在或不是目录（--root ${root}）——`
          + "这一档消费者面读不出真值，零引用清单会凭空多出命中本该在那里的名字",
      });
    }
  }
  for (const dir of dirs) {
    const exts = tierOf(dir) === "docs" ? DOC_EXTS : CODE_EXTS;
    for (const rel of walkFiles(root, dir, exts, [], errors)) {
      try {
        records.push({ rel, text: readFileSync(join(root, rel), "utf8") });
      } catch (err) {
        errors.push({ code: "CORPUS_FILE_UNREADABLE", message: `${rel} 读不出（${err.code ?? err.message}）——该文件的命中数不可知` });
      }
    }
  }
  return { records: records.sort((a, b) => a.rel.localeCompare(b.rel)), errors };
}

/** 读一棵树成 `{rel, text}` 记录（只读；不写盘）。错误由 `scanCorpus()` 报，这里只取记录。 */
export function buildRecords(root, dirs = SCAN_DIRS) {
  return scanCorpus(root, dirs).records;
}

/**
 * 入口清单的**真值来源**：`package.json` 的 `exports`。口径漏洞①（少扫了 `./contract-tests` 这个入口）
 * 的病根就是「入口清单另拄一份」——所以这里不另拄，现读。
 *
 * `exports` 的值可以是字符串，也可以是 `{ types, default }` 这类条件对象（本仓 `.` 与 `./tools` 就是）；
 * 只认 `default` / `import` / `require` 三个键，抽不到字符串就是**读不出真值**（exit 2），不静默当作没这个入口。
 *
 * @returns {{entries: string[], errors: Array<object>, warnings: Array<object>, source: string}}
 */
export function resolveEntries(root) {
  const errors = [];
  const warnings = [];
  const pkgPath = join(root, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    errors.push({
      code: "PACKAGE_UNREADABLE",
      message: `package.json 读不到/解析不了（${pkgPath}：${err.message}）——`
        + "公共入口由 `exports` 决定，读不出它就不知道有几个入口，清点不是真值",
    });
    return { entries: [...ENTRIES], errors, warnings, source: "fallback" };
  }
  const exported = pkg?.exports;
  if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
    errors.push({
      code: "PACKAGE_EXPORTS_UNREADABLE",
      message: "package.json 里没有可读的 `exports` 对象——公共入口清单无从确定，清点不是真值",
    });
    return { entries: [...ENTRIES], errors, warnings, source: "fallback" };
  }
  const entries = [];
  for (const [key, value] of Object.entries(exported)) {
    const target = typeof value === "string"
      ? value
      : (value?.default ?? value?.import ?? value?.require ?? null);
    if (typeof target !== "string") {
      errors.push({
        code: "PACKAGE_EXPORTS_UNREADABLE",
        message: `exports[${JSON.stringify(key)}] 里抽不出字符串目标（只认 string 或 default/import/require）——`
          + "这个入口导出什么名字无从得知",
      });
      continue;
    }
    if (!CODE_EXTS.some((ext) => target.endsWith(ext))) {
      warnings.push({ code: "ENTRY_NOT_CODE_SKIPPED", message: `exports[${JSON.stringify(key)}] → ${target} 不是 .js/.mjs/.cjs，不是代码入口，未扫` });
      continue;
    }
    entries.push(target.replace(/^\.\//, ""));
  }
  if (!entries.length) {
    errors.push({ code: "PACKAGE_EXPORTS_UNREADABLE", message: "`exports` 里一个代码入口都抽不出来——总数会是假 0" });
  }
  return { entries, errors, warnings, source: pkgPath };
}

// ─────────────────────────────── 清点 ───────────────────────────────

/**
 * 纯函数：给一组 `{rel, text}` 记录，算出「导出名 × 仓内消费者」清点。
 * 真树扫描与 `--self-test` 走**同一条**路径（自测的变异就打在记录的副本上）。
 *
 * @returns {{total: number, names: Array<object>, candidates: Array<object>, tiers: object,
 *            warnings: Array<object>, errors: Array<object>, incomplete: boolean, exportStars: Array<object>}}
 */
export function computeInventory(records, { entries = ENTRIES, root = null, extraErrors = [], extraWarnings = [] } = {}) {
  const errors = [...extraErrors];
  const warnings = [...extraWarnings];
  const byRel = new Map(records.map((r) => [r.rel, r.text]));
  const entryParsed = new Map();
  for (const entry of entries) {
    const text = byRel.get(entry);
    if (text === undefined) {
      errors.push({ code: "ENTRY_MISSING", message: `入口文件读不到：${entry}——没有它就数不出导出名，清点不是真值` });
      continue;
    }
    try {
      entryParsed.set(entry, parseEntryExports(text, entry));
    } catch (err) {
      if (err instanceof ExportParseError) {
        errors.push({ code: "EXPORT_PARSE_ERROR", message: `${entry}：${err.message}` });
        continue;
      }
      throw err;
    }
  }
  // 坑 3：`export *` 与非名单式导出 ⇒ 本工具不展开，明确报出来（不静默漏）。
  const exportStars = [];
  const unsupported = [];
  for (const [entry, parsed] of entryParsed) {
    exportStars.push(...parsed.exportStars);
    unsupported.push(...parsed.unsupported.map((u) => ({ ...u, entry })));
  }
  if (exportStars.length) {
    errors.push({
      code: "EXPORT_STAR_UNEXPANDED",
      message: `本工具不展开 \`export *\`，已发现 ${exportStars.length} 处：`
        + exportStars.map((s) => `${s.entry}:${s.line} \`${s.raw}\``).join("、")
        + "——这些语句里的名字一个都没进清点，总数与零消费者清单都不是真值",
    });
  }
  if (unsupported.length) {
    errors.push({
      code: "EXPORT_FORM_UNSUPPORTED",
      message: `入口里有 ${unsupported.length} 处非名单式导出（\`export function\` / \`export default\` 之类），本工具只认 \`export { … } from\`：`
        + unsupported.map((s) => `${s.entry}:${s.line} \`${s.raw}\``).join("、"),
    });
  }

  // 名字表（同名多次导出按名字去重；定义文件不一致要报，那是口径歧义）
  const table = new Map();
  for (const [entry, parsed] of entryParsed) {
    for (const item of parsed.names) {
      const prev = table.get(item.name);
      if (!prev) { table.set(item.name, { ...item, entries: [entry] }); continue; }
      if (prev.def !== item.def) {
        warnings.push({
          code: "DUPLICATE_DEFINITION",
          message: `\`${item.name}\` 从两个入口导出但定义文件不同（${prev.def} / ${item.def}），按首次出现的 ${prev.def} 记账`,
        });
      }
      if (!prev.entries.includes(entry)) prev.entries.push(entry);
    }
  }

  const names = [];
  for (const [name, meta] of [...table.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = {
      name, local: meta.local, def: meta.def, entries: meta.entries, line: meta.line,
      consumerHits: 0, consumerFiles: [], publishHits: 0, publishFiles: [],
      entryUsage: 0, testHits: 0, docHits: 0, scriptMentions: 0,
      defHits: null, internalUses: null, kind: "unknown",
    };
    for (const record of records) {
      if (record.rel === meta.def) continue;                    // 定义处自己不算消费者（口径 5）
      const parsedEntry = entryParsed.get(record.rel);
      // 口径 5：入口文件只把 export 语句挖掉，语句之外的代码照算消费者
      const hits = countNameHits(parsedEntry ? parsedEntry.maskedText : record.text, name);
      if (hits === 0) continue;
      if (parsedEntry) row.entryUsage += hits;
      const tier = tierOf(record.rel);
      if (tier === "package") { row.consumerHits += hits; row.consumerFiles.push(`${record.rel}:${hits}`); }
      else if (tier === "publish") { row.publishHits += hits; row.publishFiles.push(`${record.rel}:${hits}`); }
      else if (tier === "test") row.testHits += hits;
      else if (tier === "docs") row.docHits += hits;
      else if (tier === "scripts") row.scriptMentions += hits;
      else row.otherHits = (row.otherHits ?? 0) + hits;
    }
    names.push(row);
  }

  // 定义处核对（口径 1 的映射必须是真的）：
  //  · 定义文件**不在扫描面里**：存在 ⇒ 只留痕（口径边界，不是漂移）；不存在 ⇒ DEFINITION_MISSING。
  //  · 定义文件**在面里但里面找不到这个名字** ⇒ DEFINITION_SYMBOL_MISSING（口径漏洞④b：以前这里照样
  //    把名字计入总数，等于「真值不可读却当已核对」）。
  //  · 找到了 ⇒ 数一下除声明那一处之外还出现几次：`internalUses > 0` 就是 `internal-only`（口径 4）。
  const outsideCorpus = new Map();   // def → [name…]
  for (const row of names) {
    const defText = byRel.get(row.def);
    if (defText === undefined) {
      if (root && existsSync(join(root, row.def))) {
        if (!outsideCorpus.has(row.def)) outsideCorpus.set(row.def, []);
        outsideCorpus.get(row.def).push(row.name);
        row.kind = "outside-corpus";
        continue;
      }
      row.kind = "definition-missing";
      errors.push({
        code: "DEFINITION_MISSING",
        message: `\`${row.name}\` 的定义文件 ${row.def} 读不到（不在扫描面里，且 ${root ? `--root ${root} 下也` : ""}不存在）——`
          + "入口的 `from` 指到了不存在的文件，口径 1 的映射是假的",
      });
      continue;
    }
    // 名字可能被 `as` 改过名（入口 `export { local as name }`）：定义文件里认的是 `local`。
    const hitsName = countNameHits(defText, row.name);
    const hitsLocal = row.local && row.local !== row.name ? countNameHits(defText, row.local) : 0;
    const defHits = hitsName + hitsLocal;
    row.defHits = defHits;
    if (defHits === 0) {
      row.kind = "definition-symbol-missing";
      errors.push({
        code: "DEFINITION_SYMBOL_MISSING",
        message: `\`${row.name}\` 的定义文件 ${row.def} 里找不到这个名字（连声明那一处都没有）——`
          + "入口的 `from` 指到了这个文件，但符号不在里面；口径 1 的「定义处」映射是假的，总数与零引用清单都不是真值",
      });
      continue;
    }
    row.internalUses = Math.max(defHits - 1, 0);   // 声明那一处不算「内部引用」
  }
  for (const [def, list] of outsideCorpus) {
    warnings.push({
      code: "DEFINITION_OUTSIDE_CORPUS",
      message: `${list.length} 个名字的定义处 ${def} 在扫描面之外（入口从扫描面外转出）：${list.join("、")}——`
        + "它们的消费者只数到扫描面内（src/ bin/ examples/ test/contract/），该文件内部的用法与它自己目录里的消费者**不在口径内**",
    });
  }

  // 分档（口径 2/3/4）：kind 是给人看的分类，`--json` 里逐行带一份。
  for (const row of names) {
    if (row.kind !== "unknown") continue;
    if (row.consumerHits > 0) row.kind = "package-consumed";
    else if (row.publishHits > 0) row.kind = row.internalUses > 0 ? "publish+internal" : "publish-only";
    else if (row.internalUses === null) row.kind = "internal-unknown";
    else if (row.internalUses > 0) row.kind = "internal-only";
    else row.kind = "zero-reference";
  }
  const TIER_KINDS = [
    "package-consumed", "publish-only", "publish+internal", "internal-only", "zero-reference",
    "outside-corpus", "internal-unknown", "definition-missing", "definition-symbol-missing",
  ];
  const tiers = Object.fromEntries(TIER_KINDS.map((kind) => [kind, names.filter((r) => r.kind === kind).length]));

  const candidates = names.filter((r) => r.kind === "zero-reference");
  return {
    total: names.length,
    names,
    candidates,
    tiers,
    warnings,
    errors,
    incomplete: errors.length > 0,
    exportStars,
    unsupported,
  };
}

/**
 * 顺带报一个新事实（#419③ 那类）：`bin/` 里**import 了却从未使用**的本地名。
 * 只报不改——它回答的是「import 了却没人调」，与零消费者清单是两件事。
 */
export function scanImportedButUnused(records, dirRel = "bin") {
  const out = [];
  for (const record of records) {
    if (!record.rel.startsWith(`${dirRel}/`)) continue;
    const { statements } = scanModuleStatements(record.text);
    const imports = statements.filter((s) => s.kind.startsWith("import-"));
    if (!imports.length) continue;
    const locals = [];
    for (const stmt of imports) {
      if (stmt.kind === "import-names") {
        try {
          // import 名单里 `a as b` 的**本地绑定是右边那个**（与 export 相反），所以取 `name` 而不是 `local`。
          // 行号取**名字自己那一行**（多行 import 的语句起始行会指偏，实测 bin/tools.js 的 unlinkSync 在第 10 行、语句从第 3 行起）。
          for (const spec of parseSpecList(stmt.specText, `${record.rel}:${stmt.line}`)) {
            const at = record.text.indexOf(spec.name, stmt.start);
            locals.push({ name: spec.name, line: at >= 0 && at < stmt.end ? lineOf(record.text, at) : stmt.line });
          }
        } catch {
          // import 名单解析不了不归这条判据管（export 侧会红）；这里跳过而不是假装 0
          locals.push({ name: `(unparsed import @ line ${stmt.line})`, line: stmt.line, unparsed: true });
        }
      } else if (stmt.kind === "import-ns" || stmt.kind === "import-default") {
        if (stmt.specText) locals.push({ name: stmt.specText, line: stmt.line });
      }
    }
    const masked = maskSpans(record.text, imports.map((s) => ({ start: s.start, end: s.end })));
    for (const local of locals) {
      if (local.unparsed) continue;
      if (countNameHits(masked, local.name) === 0) out.push({ file: record.rel, name: local.name, line: local.line });
    }
  }
  return out;
}

// ─────────────────────────────── 报告 ───────────────────────────────

/** 口径说明（逐条打印；`--json` 里也带一份，免得下游各自复述走样）。 */
export const CRITERIA = [
  "入口 = package.json 的 exports 里**每一个**代码子路径（现读，今天三个：src/index.js、src/tools/index.js、test/contract/index.js）；只认名单式再导出 `export { a, b as c } from \"./x.js\"`，定义处 = `from` 指的那个文件。",
  "消费者分三档：包内（src/ bin/）、发布面（examples/ test/contract/，随包发布、宿主安装后自己跑）、暴露面（test/ docs/ scripts/，不算消费）。",
  "「可删候选」只在**包内与发布面都零命中**时才成立；任一档有命中就不是候选。",
  "名字在自己定义文件内、除声明那一处之外还被引用 ⇒ internal-only（该去掉 export，不是删符号）；它单列一档，不混进「零引用」。",
  "入口文件自己的 export 语句不算消费者（那是暴露面本身，算进去会让所有名字「自己消费自己」）；入口里 export 语句之外的代码照算。",
  "test/ 的命中记「自身测试数」、docs/ 的命中记「文档提及数」、scripts/ 的命中记 scriptMentions，三者都**不算消费者**（暴露面 ≠ 使用）。",
  "命中判据 = 标识符边界（(?<![\\w$])NAME(?![\\w$])），所以 extractL0 不会被 extractL0Facts 顶替；注释里的字面提及照算。",
  "扫描面目录不存在/读不出、定义文件里找不到该符号 ⇒ 清点不完整（exit 2，分类码可区分），不许静默跳过。",
];

export function renderReport(inventory, { root = DEFAULT_ROOT, entries = ENTRIES, importedButUnused = [] } = {}) {
  const lines = [];
  const t = inventory.tiers ?? {};
  const byKind = (...kinds) => inventory.names.filter((r) => kinds.includes(r.kind));
  const perEntry = entries.map((e) => `${e}（${inventory.names.filter((n) => n.entries.includes(e)).length} 个名字）`).join(" + ");
  lines.push("export-consumer-check：公共入口导出名 × 仓内消费者清点（**只是清点，不参与任何门禁判定**）");
  lines.push("");
  lines.push(`入口：${perEntry} ⇒ 去重后 ${inventory.total} 个导出名`);
  lines.push(`分档：包内消费者（src/ bin/）${t["package-consumed"] ?? 0} 个`
    + ` ・ 发布面消费者（examples/ test/contract/）${(t["publish-only"] ?? 0) + (t["publish+internal"] ?? 0)} 个`
    + ` ・ 仅自身定义文件内引用（internal-only）${t["internal-only"] ?? 0} 个`
    + ` ・ 真·零引用（可删候选）${t["zero-reference"] ?? 0} 个`);
  lines.push(`零消费者（包内 + 发布面都零命中）：${inventory.candidates.length + (t["internal-only"] ?? 0) + (t["internal-unknown"] ?? 0)} / ${inventory.total}`
    + `——其中 ${t["internal-only"] ?? 0} 个在自身定义文件里仍被引用（internal-only，不是死导出），`
    + `${inventory.candidates.length} 个是真·零引用（只有这一档才谈得上「可删候选」）`);
  lines.push("");
  lines.push("## 口径（每一句都可复算）");
  CRITERIA.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  lines.push("");
  lines.push("## 可删候选：真·零引用（包内、发布面、自身定义文件内都零命中）");
  if (!inventory.candidates.length) {
    lines.push("（无：每个导出名至少有一处包内 / 发布面消费者，或在本文件内部还被用着）");
  } else {
    lines.push("| 名字 | 定义文件 | 自身测试数 | 文档提及数 |");
    lines.push("|---|---|---:|---:|");
    for (const row of inventory.candidates) {
      lines.push(`| \`${row.name}\` | \`${row.def}\` | ${row.testHits} | ${row.docHits} |`);
    }
  }
  const publishRows = byKind("publish-only", "publish+internal");
  lines.push("");
  lines.push(`## 发布面消费者（${publishRows.length} 个：**不该删**——随包发布，宿主安装后自己跑）`);
  if (!publishRows.length) {
    lines.push("（无）");
  } else {
    lines.push("| 名字 | 定义文件 | 发布面命中 | 自身定义文件内引用 |");
    lines.push("|---|---|---|---:|");
    for (const row of publishRows) {
      lines.push(`| \`${row.name}\` | \`${row.def}\` | ${row.publishFiles.join("、")} | ${row.internalUses ?? "?"} |`);
    }
  }
  const internalRows = byKind("internal-only");
  lines.push("");
  lines.push(`## 仅自身定义文件内引用（internal-only，${internalRows.length} 个：**不是死导出**——该做的是去掉 \`export\`，不是删符号）`);
  if (!internalRows.length) {
    lines.push("（无）");
  } else {
    lines.push("| 名字 | 定义文件 | 定义文件内引用次数（除声明） | 自身测试数 | 文档提及数 |");
    lines.push("|---|---|---:|---:|---:|");
    for (const row of internalRows) {
      lines.push(`| \`${row.name}\` | \`${row.def}\` | ${row.internalUses} | ${row.testHits} | ${row.docHits} |`);
    }
  }
  const scriptOnly = byKind("zero-reference", "internal-only").filter((r) => r.scriptMentions > 0);
  if (scriptOnly.length) {
    lines.push("");
    lines.push(`附：上面有 ${scriptOnly.length} 个名字只在 \`scripts/\`（开发工具）里被提到过，按口径 6 不计入消费者——`
      + scriptOnly.map((r) => `${r.name}(${r.scriptMentions})`).join("、"));
  }
  lines.push("");
  lines.push("## 零引用不等于可以删");
  lines.push("  这批名字里有一批是**给宿主用的公共 API**（仓内没人用，宿主在用）；删除要等宿主迁移 + 版本边界，");
  lines.push("  那是另一张票。本工具只清点，不判定、不挂门禁、不删任何导出。");
  if (importedButUnused.length) {
    lines.push("");
    lines.push(`## 附：bin/ 里「import 了却从未使用」的名字（${importedButUnused.length} 个，#419③ 那类；只报不改）`);
    for (const item of importedButUnused) lines.push(`  - \`${item.name}\` — ${item.file}:${item.line}`);
  } else {
    lines.push("");
    lines.push("## 附：bin/ 里「import 了却从未使用」的名字：0 个");
  }
  if (inventory.warnings.length) {
    lines.push("");
    lines.push("## 警告");
    for (const w of inventory.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  if (inventory.errors.length) {
    lines.push("");
    lines.push("## 清点不完整（exit 2：读不出真值就红，不许假绿）");
    for (const e of inventory.errors) lines.push(`  - [${e.code}] ${e.message}`);
  }
  lines.push("");
  lines.push("## 逐字复现");
  lines.push("  node scripts/export-consumer-check.mjs          # 本表");
  lines.push("  node scripts/export-consumer-check.mjs --json   # 同一份事实的机器读形态");
  if (resolve(root) !== resolve(DEFAULT_ROOT)) lines.push(`  （本次跑在 --root ${root}）`);
  return lines.join("\n");
}

// ─────────────────────────────── --self-test（反向证）───────────────────────────────
// 反向证 + 放行证，每条都打印**三态数**（原值 / 变异后 / 还原后）。
// 变异一律打在**内存副本**上：真树那一条也只在 `buildRecords()` 出来的记录里改字，
// 仓内源码全程只读（#411 的纪律）。变异没落上按 #210 R2 判失败。
// 口径漏洞①–④（三入口 / 发布面档 / internal-only / 两个读不出真值的漏口）各有一条，例⑧–例⑫。

const SELF_TEST_FAKE_ENTRY = "src/index.js";

function fakeTree(overrides = {}) {
  const base = {
    "src/index.js": [
      'export { alpha, beta as gamma } from "./mod.js";',
      'export { delta } from "./mod.js";',
      "",
    ].join("\n"),
    "src/mod.js": [
      "export const alpha = 1;",
      "export const beta = 2;",
      "export const delta = 3;",
      "",
    ].join("\n"),
    "src/tools/index.js": 'export { alpha } from "../mod.js";\n',
    // 第三个公共入口（`./contract-tests`）：默认入口清单里有它，假树也得有。
    "test/contract/index.js": 'export { alpha } from "../../src/mod.js";\n',
    "src/uses.js": "import { alpha } from \"./mod.js\";\nconsole.log(alpha);\n",
    "test/mod.test.js": "gamma(); delta();\n",
    "docs/mod.md": "`gamma` 与 `delta` 是公开面。\n",
  };
  return Object.entries({ ...base, ...overrides }).map(([rel, text]) => ({ rel, text }));
}

function cloneRecords(records) {
  return records.map((r) => ({ ...r }));
}

/** 在记录集合上做一次「字符串变异」；打不上就返回 `missed`（#210 R2：变异没落上也算失败）。 */
function mutateRecord(records, { rel, from, to }) {
  const next = cloneRecords(records);
  const target = next.find((r) => r.rel === rel);
  if (!target) return { records: next, missed: `${rel} 不在记录集合里` };
  const before = target.text;
  target.text = before.replace(from, () => to);
  if (target.text === before) return { records: next, missed: `${rel} 里找不到靶串 ${JSON.stringify(from)}` };
  return { records: next, missed: null };
}

function runSelfTest() {
  const failures = [];
  const passed = [];
  const expect = (cond, okMsg, failMsg) => (cond ? passed.push(okMsg) : failures.push(failMsg));

  console.log("export-consumer-check --self-test：反向证（内存假集合 + 真树内存副本；仓内源码全程只读）");

  // ── 例① 真树：删掉一个真消费者的那一处引用 ⇒ 候选数 +1；加回来 ⇒ 回到原值 ──
  {
    const records = buildRecords(DEFAULT_ROOT);
    const baseline = computeInventory(records, { root: DEFAULT_ROOT });
    if (baseline.incomplete) {
      failures.push(`例①：真树清点本身就不完整（${baseline.errors.map((e) => e.code).join(",")}）——反向证的基线不是真值`);
    } else {
      // 挑一个「恰好 1 处消费者（在 src/ 里）、且发布面与自身定义文件内都零引用」的名字：
      // 这样删掉它必然翻成真·零引用候选（否则删了也只能翻成 internal-only / publish-only）。
      const target = baseline.names
        .filter((r) => r.kind === "package-consumed" && r.consumerHits === 1 && r.consumerFiles.length === 1
          && r.consumerFiles[0].startsWith("src/") && r.publishHits === 0 && r.internalUses === 0)
        .sort((a, b) => a.name.localeCompare(b.name))[0];
      if (!target) {
        failures.push("例①：真树里找不到「恰好 1 处消费者（且在 src/ 里）」的名字——这一枪打不出去，反向证失效");
      } else {
        const [file] = target.consumerFiles[0].split(":");
        const { records: mutated, missed } = mutateRecord(records, {
          rel: file,
          from: new RegExp(`(?<![\\w$])${target.name}(?![\\w$])`),
          to: `${target.name}_SELFTEST_MUTATED`,
        });
        if (missed) {
          failures.push(`例①：变异没落上——${missed}（反向证自身失效：靶子已与真树脱节）`);
        } else {
          const after = computeInventory(mutated, { root: DEFAULT_ROOT });
          const restored = computeInventory(records, { root: DEFAULT_ROOT });   // 记录没被改：这就是「加回来」
          const delta = after.candidates.length - baseline.candidates.length;
          const flipped = after.candidates.some((r) => r.name === target.name)
            && !baseline.candidates.some((r) => r.name === target.name);
          expect(
            delta === 1 && flipped,
            `① 真树·删掉一个真消费者（${target.name} @ ${file}）：候选数 原值 ${baseline.candidates.length} → 变异后 ${after.candidates.length}（+${delta}，且 ${target.name} 出现在候选里）→ 还原后 ${restored.candidates.length}`,
            `① 真树·删掉一个真消费者（${target.name} @ ${file}）：期望候选数 +1 且该名字翻成候选，实测 原值 ${baseline.candidates.length} → 变异后 ${after.candidates.length}（delta ${delta}），flipped=${flipped}`,
          );
          expect(
            restored.candidates.length === baseline.candidates.length,
            `①b 加回来（记录未被改动的副本重算）：候选数回到 ${restored.candidates.length}（= 原值 ${baseline.candidates.length}）`,
            `①b 加回来后候选数没有回到原值：${restored.candidates.length} ≠ ${baseline.candidates.length}`,
          );
        }
      }
    }
  }

  // ── 例② 坑 1：`g` 正则 + `.test()` 有状态 ⇒ 漏报消费者（假候选）──
  {
    // 假树：same 名字在两个消费者文件里各 1 处。文件 A 的命中在**行尾**，文件 B 的在**行首**。
    // 正解（matchAll）⇒ 两处都数到 ⇒ 0 个候选；状态化口径（共享一个 g 正则连打两次 .test()）
    // ⇒ A 命中后 lastIndex 停在 A 的尾部，拿这个 lastIndex 去扫 B 就**扫不到 B 行首那一处** ⇒ 1 个假候选。
    const pad = (n) => "x".repeat(n);
    const records = [
      { rel: "src/index.js", text: 'export { same } from "./mod.js";\n' },
      { rel: "src/mod.js", text: "export const same = 1;\n" },
      { rel: "src/a-consumer.js", text: `${pad(40)} same\n` },      // 命中在行尾（lastIndex 会推进到 ≈ 45）
      { rel: "src/b-consumer.js", text: `same ${pad(120)}\n` },      // 命中在行首（索引 0）
    ];
    const correct = computeInventory(records);
    // —— 错误实现的复刻（只出现在自测里，生产路径不用它）——
    const stateful = new RegExp("same", "g");
    const statefulHits = [];
    for (const rel of ["src/a-consumer.js", "src/b-consumer.js"]) {
      statefulHits.push({ rel, hit: stateful.test(records.find((r) => r.rel === rel).text) });
    }
    const statefulCandidates = statefulHits.filter((h) => !h.hit).length;
    expect(
      correct.candidates.length === 0 && statefulCandidates === 1,
      `② 坑1 有状态 g 正则：候选数 正确口径（matchAll）0 → 状态化口径 ${statefulCandidates}（假候选 ${statefulHits.filter((h) => !h.hit).map((h) => h.rel).join(",")}）→ 还原（再用正确口径）${computeInventory(records).candidates.length}`,
      `② 坑1 没有复现出来：正确口径候选 ${correct.candidates.length}（期望 0），状态化口径候选 ${statefulCandidates}（期望 1）——这条反向证已失效`,
    );
    // 再加一条：`countNameHits` 对同一份文本**连打两次**结果必须一致（有状态实现会 2 → 1）
    const twice = [countNameHits(records[2].text, "same"), countNameHits(records[2].text, "same")];
    expect(
      twice[0] === 1 && twice[1] === 1,
      `②b 同一个名字在同一份文本上连打两次：${twice.join(" / ")}（无状态；有状态实现会给 1 / 0）`,
      `②b countNameHits 自身有状态：连打两次得到 ${twice.join(" / ")}`,
    );
  }

  // ── 例③ 坑 2：花括号里的注释不能被当成名字；不合法 token 必须抛错 ──
  {
    const commentLine = "  // issue #220：成功返回形态的判别式";
    const withComment = fakeTree({
      "src/index.js": [
        "export {",
        "  alpha,",
        commentLine,
        "  beta as gamma,",
        "} from \"./mod.js\";",
        "",
      ].join("\n"),
    });
    const parsed = parseEntryExports(withComment.find((r) => r.rel === SELF_TEST_FAKE_ENTRY).text, SELF_TEST_FAKE_ENTRY);
    const namesNow = parsed.names.map((n) => n.name);
    // 错误实现的复刻：**不剥注释**直接在花括号内容上 `split(",")`（主 agent 第一版就是这个形状）
    const rawBraceBody = ["  alpha,", commentLine, "  beta as gamma,"].join("\n");
    const naiveNames = rawBraceBody.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s)?.[2] ?? s);
    const bogus = naiveNames.filter((n) => !IDENT_RE.test(n));
    const naiveValid = naiveNames.filter((n) => IDENT_RE.test(n));
    expect(
      namesNow.length === 2 && namesNow.join(",") === "alpha,gamma" && bogus.length === 1 && !namesNow.some((n) => !IDENT_RE.test(n)),
      `③ 坑2 注释进花括号：合法名字数 原值（剥注释）${namesNow.length} [${namesNow.join(",")}] → 不剥注释 ${naiveValid.length} 个合法 + ${bogus.length} 个伪名字（${JSON.stringify(bogus[0])}）→ 还原（剥注释）${parseEntryExports(withComment.find((r) => r.rel === SELF_TEST_FAKE_ENTRY).text, SELF_TEST_FAKE_ENTRY).names.length}`,
      `③ 坑2 没复现出来：剥注释后得到 ${JSON.stringify(namesNow)}（期望 ["alpha","gamma"]），不剥注释的伪名字 ${JSON.stringify(bogus)}（期望 1 个）`,
    );
    // 不合法 token 必须抛错，不许静默吞掉
    let threw = null;
    try {
      parseEntryExports('export { alpha, "beta" } from "./mod.js";\n', SELF_TEST_FAKE_ENTRY);
    } catch (err) {
      threw = err;
    }
    expect(
      threw instanceof ExportParseError,
      `③b 非法 token（\`export { alpha, "beta" }\`）：抛 ${threw?.name ?? "（没抛）"}（期望 ExportParseError；静默吞掉就会把名字数报成 1）`,
      `③b 非法 token 没有抛 ExportParseError，而是 ${threw ? threw.name : "静默通过"}——「不匹配就报错」这条失守`,
    );
  }

  // ── 例④ 坑 3：`export *` 必须明确报「不展开」，并让清点变 incomplete（exit 2）──
  {
    const clean = fakeTree();
    const withStar = fakeTree({
      "src/index.js": 'export { alpha } from "./mod.js";\nexport * from "./mod.js";\n',
    });
    const before = computeInventory(clean);
    const after = computeInventory(withStar);
    const back = computeInventory(clean);
    expect(
      before.exportStars.length === 0 && before.incomplete === false
        && after.exportStars.length === 1 && after.incomplete === true
        && after.errors.some((e) => e.code === "EXPORT_STAR_UNEXPANDED" && e.message.includes("已发现 1 处"))
        && back.exportStars.length === 0 && back.incomplete === false,
      `④ 坑3 export *：未展开处数 原值 ${before.exportStars.length}（incomplete=${before.incomplete}）→ 加一行 ${after.exportStars.length}（incomplete=${after.incomplete}，点名「已发现 1 处」）→ 删掉 ${back.exportStars.length}`,
      `④ 坑3 没复现出来：原值 ${before.exportStars.length}/${before.incomplete}，变异后 ${after.exportStars.length}/${after.incomplete}，还原后 ${back.exportStars.length}/${back.incomplete}`,
    );
  }

  // ── 例⑤ 放行证：入口里 export 语句**之外**的真实使用仍算消费者（屏蔽没有过度）──
  {
    const records = fakeTree({
      "src/index.js": 'export { alpha } from "./mod.js";\nconsole.log(alpha);\n',
      "src/mod.js": "export const alpha = 1;\n",
    });
    const inv = computeInventory(records);
    const row = inv.names.find((n) => n.name === "alpha");
    expect(
      inv.candidates.length === 0 && row?.entryUsage === 1,
      `⑤ 放行证·入口里的真实使用算消费者：候选数 ${inv.candidates.length}（期望 0），entryUsage ${row?.entryUsage}（期望 1）`,
      `⑤ 入口屏蔽过度：候选数 ${inv.candidates.length}（期望 0），entryUsage ${row?.entryUsage}（期望 1）——把入口里的真实使用也挖掉了`,
    );
  }

  // ── 例⑥ 清点不完整必须红：入口读不到 ⇒ exit 2 的依据 ──
  {
    const inv = computeInventory([{ rel: "src/mod.js", text: "export const alpha = 1;\n" }]);
    expect(
      inv.incomplete === true && inv.errors.some((e) => e.code === "ENTRY_MISSING"),
      `⑥ 入口缺失（两个入口都不在记录里）：incomplete=${inv.incomplete}，点名 ${[...new Set(inv.errors.map((e) => e.code))].join(",")} × ${inv.errors.length} 条（期望 ENTRY_MISSING；否则「读不出真值」会静默变成 0 个导出名）`,
      `⑥ 入口缺失没有让清点变 incomplete：${JSON.stringify(inv.errors)}`,
    );
  }

  // ── 例⑦ 定义处读不到必须红；「存在但在扫描面之外」只留痕（不判红）──
  {
    const broken = fakeTree({ "src/index.js": 'export { alpha } from "./nope.js";\n' });
    const inv = computeInventory(broken);
    const outside = computeInventory(
      fakeTree({ "src/index.js": 'export { alpha } from "../package.json";\n' }),
      { root: DEFAULT_ROOT },
    );
    expect(
      inv.incomplete === true && inv.errors.some((e) => e.code === "DEFINITION_MISSING")
        && outside.incomplete === false && outside.warnings.some((w) => w.code === "DEFINITION_OUTSIDE_CORPUS"),
      `⑦ 定义处：读不到（\`./nope.js\`）⇒ incomplete=${inv.incomplete} 且点名 DEFINITION_MISSING；`
        + `存在但在扫描面外（\`../package.json\`）⇒ incomplete=${outside.incomplete}，只留痕 ${outside.warnings.map((w) => w.code).join(",")}`,
      `⑦ 定义处判据不对：读不到时 incomplete=${inv.incomplete}（期望 true）/ 面外时 incomplete=${outside.incomplete}（期望 false），warnings=${JSON.stringify(outside.warnings)}`,
    );
  }

  // ── 例⑧ 口径漏洞①：公共入口是 package.json 的 exports **三个**，少扫一个就少报一批名字 ──
  {
    const records = fakeTree({
      "test/contract/index.js": 'export { contractAlpha } from "./helpers.js";\n',
      "test/contract/helpers.js": "export const contractAlpha = 1;\n",
    });
    const two = computeInventory(records, { entries: ["src/index.js", "src/tools/index.js"] });
    const three = computeInventory(records);   // 默认 = ENTRIES（三个入口）
    const back = computeInventory(records, { entries: ["src/index.js", "src/tools/index.js"] });
    const thirdOnly = three.names.filter((r) => r.entries.includes("test/contract/index.js") && !r.entries.includes("src/index.js"));
    expect(
      two.total === 3 && three.total === 4 && thirdOnly.length === 1 && thirdOnly[0].name === "contractAlpha" && back.total === two.total,
      `⑧ 三入口：导出名总数 原值（只扫两个入口）${two.total} → 加上 ` + "`./contract-tests`" + ` 这个入口 ${three.total}（它独占 ${thirdOnly.length} 个名字：${thirdOnly.map((r) => r.name).join(",")}）→ 还原 ${back.total}`,
      `⑧ 三入口没生效：两个入口 ${two.total}（期望 3）/ 三个入口 ${three.total}（期望 4），第三个入口独占 ${thirdOnly.length}（期望 1）`,
    );
  }

  // ── 例⑨ 口径漏洞②：`test/contract/` 是**发布面**（随包发布、宿主安装后自己跑），不是「零消费者」──
  {
    // 同一条引用（`delta()`）放在两处：
    //   · `test/contract/consumer.js`（发布面）⇒ 真消费，delta 不得进「可删候选」；
    //   · `test/consumer.test.js`（暴露面）⇒ 不算消费，delta 仍是候选（证明修复没有把 test/ 一律当消费者）。
    const plain = computeInventory(fakeTree({ "test/consumer.test.js": "delta();\n" }));
    const publish = computeInventory(fakeTree({ "test/contract/consumer.js": "delta();\n" }));
    const back = computeInventory(fakeTree());
    const plainRow = plain.names.find((r) => r.name === "delta");
    const publishRow = publish.names.find((r) => r.name === "delta");
    expect(
      plainRow?.kind === "zero-reference" && plain.candidates.some((r) => r.name === "delta")
        && publishRow?.publishHits === 1 && publishRow.kind === "publish-only"
        && !publish.candidates.some((r) => r.name === "delta")
        && back.names.find((r) => r.name === "delta")?.kind === "zero-reference",
      `⑨ 发布面档：delta 的 kind 基线（只被 test/ 提到）${plainRow?.kind} → 同一处引用挪到 test/contract/ ${publishRow?.kind}`
        + `（publishHits ${publishRow?.publishHits}，从候选里消失）→ 还原 ${back.names.find((r) => r.name === "delta")?.kind}`,
      `⑨ 发布面档没生效：基线 ${plainRow?.kind}（期望 zero-reference）/ 发布面 ${publishRow?.kind}`
        + `（期望 publish-only，publishHits ${publishRow?.publishHits}）/ 还原 ${back.names.find((r) => r.name === "delta")?.kind}`,
    );
  }

  // ── 例⑩ 口径漏洞③：定义文件内除声明外还被引用 ⇒ internal-only，不得混进「零引用」──
  {
    const withInternalUse = fakeTree({
      "src/mod.js": "export const alpha = 1;\nexport const beta = 2;\nexport const delta = 3;\nexport const wrap = () => delta;\n",
    });
    const baseline = computeInventory(fakeTree());
    const mutated = computeInventory(withInternalUse);
    const back = computeInventory(fakeTree());
    const before = baseline.names.find((r) => r.name === "delta");
    const after = mutated.names.find((r) => r.name === "delta");
    const again = back.names.find((r) => r.name === "delta");
    expect(
      before.kind === "zero-reference" && baseline.candidates.some((r) => r.name === "delta")
        && after.kind === "internal-only" && after.internalUses === 1
        && !mutated.candidates.some((r) => r.name === "delta")
        && again.kind === "zero-reference" && back.candidates.some((r) => r.name === "delta"),
      `⑩ internal-only：delta 的 kind 原值 ${before.kind}（在候选里）→ 定义文件里加一处自用 ${after.kind}`
        + `（internalUses ${after.internalUses}，从候选里消失）→ 还原 ${again.kind}`,
      `⑩ internal-only 分档不对：原值 ${before.kind}（期望 zero-reference）/ 加自用后 ${after.kind}`
        + `（期望 internal-only，internalUses ${after.internalUses}）/ 还原 ${again.kind}`,
    );
  }

  // ── 例⑪ 口径漏洞④a：扫描面目录读不出/不存在必须报 CORPUS_DIR_UNREADABLE，不许静默跳过 ──
  {
    const clean = scanCorpus(DEFAULT_ROOT);
    const withBogus = scanCorpus(DEFAULT_ROOT, [...SCAN_DIRS, "no-such-dir"]);
    const back = scanCorpus(DEFAULT_ROOT);
    const bogus = withBogus.errors.filter((e) => e.code === "CORPUS_DIR_UNREADABLE");
    const inv = computeInventory(withBogus.records, { root: DEFAULT_ROOT, extraErrors: withBogus.errors });
    expect(
      clean.errors.length === 0 && bogus.length === 1 && bogus[0].message.includes("no-such-dir/")
        && inv.incomplete === true && back.errors.length === 0,
      `⑪ 目录读不出：CORPUS_DIR_UNREADABLE 原值 ${clean.errors.length} 条 → 加一个不存在的扫描目录 ${bogus.length} 条`
        + `（点名 no-such-dir/，incomplete=${inv.incomplete}）→ 还原 ${back.errors.length} 条`,
      `⑪ 目录读不出没被报出来：原值 ${clean.errors.length}（期望 0）/ 加坏目录后 ${bogus.length}（期望 1）`
        + `/ incomplete=${inv.incomplete}（期望 true）/ 还原 ${back.errors.length}（期望 0）`,
    );
  }

  // ── 例⑫ 口径漏洞④b：定义文件在、但里面找不到这个符号 ⇒ DEFINITION_SYMBOL_MISSING（不是「已核对」）──
  {
    const ghost = fakeTree({ "src/mod.js": "export const beta = 2;\nexport const delta = 3;\n" });   // alpha 的声明没了
    const clean = computeInventory(fakeTree());
    const mutated = computeInventory(ghost);
    const back = computeInventory(fakeTree());
    const hits = mutated.errors.filter((e) => e.code === "DEFINITION_SYMBOL_MISSING");
    expect(
      clean.errors.length === 0 && clean.incomplete === false
        && mutated.incomplete === true && hits.length >= 1 && hits[0].message.includes("alpha")
        && mutated.names.find((r) => r.name === "alpha")?.kind === "definition-symbol-missing"
        && back.errors.length === 0 && back.incomplete === false,
      `⑫ 定义文件里找不到符号：errors 原值 ${clean.errors.length}（incomplete=${clean.incomplete}）→ 删掉 alpha 的声明`
        + ` ${hits.length} 条 DEFINITION_SYMBOL_MISSING（kind=${mutated.names.find((r) => r.name === "alpha")?.kind}，incomplete=${mutated.incomplete}）→ 还原 ${back.errors.length}`,
      `⑫ 定义文件里找不到符号没被判红：原值 ${clean.errors.length} 条 / 变异后 ${hits.length} 条（期望 ≥1）`
        + `/ kind=${mutated.names.find((r) => r.name === "alpha")?.kind}（期望 definition-symbol-missing）`,
    );
  }

  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) {
    console.log(`export-consumer-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    process.exit(1);
  }
  console.log(`export-consumer-check --self-test: OK — ${passed.length} 条判据全部按预期（内存假集合 + 真树内存副本，不写盘、不碰仓内源码）`);
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
      console.error(`export-consumer-check: 不认识的参数 ${JSON.stringify(arg)}（支持 --json / --self-test / --root <dir> / --help）`);
      process.exit(2);
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("用法：node scripts/export-consumer-check.mjs [--json] [--root <dir>] [--self-test]");
    return 0;
  }
  if (opts.selfTest) {
    runSelfTest();
    return 0;
  }
  const entryResolution = resolveEntries(opts.root);
  const corpus = scanCorpus(opts.root);
  const records = corpus.records;
  const inventory = computeInventory(records, {
    root: opts.root,
    entries: entryResolution.entries,
    extraErrors: [...entryResolution.errors, ...corpus.errors],
    extraWarnings: entryResolution.warnings,
  });
  const entries = entryResolution.entries;
  const importedButUnused = scanImportedButUnused(records, "bin");
  if (opts.json) {
    const payload = {
      tool: "export-consumer-check",
      generatedFor: "issue #406 裁定③ 的配套件（也服务 #419③）；清点口径修正见 #429",
      gate: false,
      note: "只是清点：零消费者不是错误，本工具不参与任何门禁判定，也不删任何导出",
      root: opts.root,
      entrySource: entryResolution.source,
      entries,
      total: inventory.total,
      tiers: inventory.tiers,
      criteria: CRITERIA,
      candidates: inventory.candidates.map((r) => ({
        name: r.name, def: r.def, kind: r.kind, testHits: r.testHits, docHits: r.docHits,
        scriptMentions: r.scriptMentions, internalUses: r.internalUses, entries: r.entries,
      })),
      publishConsumers: inventory.names
        .filter((r) => r.kind === "publish-only" || r.kind === "publish+internal")
        .map((r) => ({
          name: r.name, def: r.def, kind: r.kind, publishHits: r.publishHits,
          publishFiles: r.publishFiles, internalUses: r.internalUses, testHits: r.testHits, docHits: r.docHits,
        })),
      internalOnly: inventory.names
        .filter((r) => r.kind === "internal-only")
        .map((r) => ({
          name: r.name, def: r.def, kind: r.kind, internalUses: r.internalUses,
          defHits: r.defHits, testHits: r.testHits, docHits: r.docHits, scriptMentions: r.scriptMentions,
        })),
      names: inventory.names,
      importedButUnused,
      exportStars: inventory.exportStars,
      warnings: inventory.warnings,
      errors: inventory.errors,
      incomplete: inventory.incomplete,
      reproduce: ["node scripts/export-consumer-check.mjs", "node scripts/export-consumer-check.mjs --json"],
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderReport(inventory, { root: opts.root, entries, importedButUnused }));
  }
  return inventory.incomplete ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
