#!/usr/bin/env node
// issue #429 的判据：**「零消费者导出已登记 @deprecated」与「清点工具现算的候选清单」必须一一对上**。
//
// 为什么要有这个脚本（而不是只加注释）：
//   #429 的决策是「17 个仓内零消费者导出 → 本轮只登记 + 标 `@deprecated`，删除并入 0.30 破坏包」。
//   登记动作是**注释**，而注释不会被任何东西检查：只要有人给一个**有消费者**的符号也标上
//   「0.30 删除」，或者有人删掉某个候选的标记，代码照样编译、测试照样绿——直到 0.30 真的删了
//   宿主在用的 API。所以这里把两件事做成一条机器判据：
//     · 清点事实（谁是候选）来自 `scripts/export-consumer-check.mjs` 的 `computeInventory()`（**现算**，
//       不抄一份名单进本脚本：抄一份就是两条漂移路径，那正是 #429 修掉的口径漏洞①的同型错误）；
//     · 登记事实（谁被标了）来自**源码里真正能被 tsc 带进 `.d.ts` 的那一个 JSDoc 块**。
//
// ── 判据（每一条都点名到 符号 @ 文件:行）───────────────────────────────────────
//  R1 NOT_REGISTERED        候选（零消费者）没有登记标记 ⇒ 红。登记是这张票的交付物本身。
//  R2 NOT_A_CANDIDATE       **有消费者**的公共名被标了删除标记（不论版本）⇒ 红。这是本判据的反向证靶子：
//                           删掉一个真消费者不会让候选数变（消费面在别处），所以只能靠这条拦。
//  R3 WRONG_VERSION         标记里的删除版本 ≠ 该名字在登记表里绑的版本（缺省 `0.30`，见 `REMOVAL_REGISTRY`）⇒ 红。
//                            写错版本等于把删除挪到另一个发布包里，比不写更危险（读的人以为对过账）。
//                            **逐个名字**可移：宿主仓实测在用的名字由登记表绑到更晚的发布包，其余仍是缺省 0.30。
//                            缺省值住在常量 `DEFAULT_REMOVAL_VERSION` 里，登记表只覆盖它点名的名字。
//  R4 NO_MIGRATION          标记没写「迁移到什么」⇒ 红。两种合法形状：
//                             · `` migrate to `X` ``（`X` 必须是树里真的声明出来的符号——指到空气里等于没写）；
//                             · `no in-tree replacement`（仓内确实没有替代，明确写出来，别编一个）。
//  R5 TAG_NOT_ADJACENT      `@deprecated` 块**不是紧贴声明那一个** ⇒ 红。这是 AGENTS「类型面规矩」里
//                            两个会让参数静默退化成 `any` 的形状之一（#213 R4）：块与声明之间夹了空行或
//                            另一个注释，tsc 就不把它当声明的 doc，`.d.ts` 里标记**静默消失**。
//                            实测过的第二种同型（本票踩到）：别名 const（`export const a = f;`）不写
//                            `@type {typeof f}` 时，tsc 会把被别名函数的 doc **连它的注释一起**复制出来，
//                            新写的 @deprecated 一样静默消失——所以 `--types` 模式读生成物，不只读源码。
//  R6 UNRESOLVED_DECLARATION 有 `@deprecated` 却认不出它贴的是哪个公共名（形状本工具不认）⇒ 红，
//                            不许静默跳过（「认不出」不等于「没问题」）。
//  R7 REGISTRY_ENTRY_IDLE   登记表里的一条名字**没对上任何标记** ⇒ 红（#210 R2 惯例：静默不匹配的豁免条目
//                            本身就是错）。它拦的是「把名字从 0.30 挪到 0.31 之后忘了改标记」这种单向豁免：
//                            登记表说「这个名等到 0.31 再删」，而源码里已经没有它的标记（或标记被删了）——
//                            读登记表的人会以为删除仍在计划里，实际上这条登记已经空转。
//  R8 REGISTRY_ENTRY_INVALID 登记表的条目形状不合规（缺理由 / 版本不是 `x.y`）⇒ 红。没有理由的豁免就是
//                            下一任读者无法复核的免检通道；版本不是 `x.y` 则 R3 无法按名字对账。
//
// ── 三档口径（与清点工具同一份）───────────────────────────────────────────────
//  候选 = 「包内消费者（`src/` `bin/`）+ 发布面消费者（`examples/` `test/contract/`）+ 自身定义文件内引用」
//  全零命中。internal-only（只在自己定义文件里用）**不是**候选：它的处置是去掉 `export` 而不是删符号，
//  所以给它标「0.30 删除」同样是错的 ⇒ R2 会点名。
//
// ── 边界（必须写进报告，不许含糊）─────────────────────────────────────────────
//  本判据只证**仓内**零消费者。宿主仓（touwaka / app_container / erix-station / pi）不在扫描面里，
//  它们的 import 这里一个都看不见 ⇒ **删除前必须另核宿主**。本判据拦的是「登记与清点脱钩」，
//  不是「可以删了」。
//
// ── 退出码（本仓惯例：读不出真值就红，不许假绿）───────────────────────────────
//  0 = 登记与清点一致（且 R3–R8 全过）
//  1 = 判据红（上面 R1–R8 任一条，逐条点名）
//  2 = 读不出真值：清点工具跑不起来/清点不完整（它自己 exit 2）、`--types` 模式下生成物不存在、
//      或扫描面读不出。**不许**把「读不出」当成「没问题」。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/deprecated-export-check.mjs               # 人读报告（门禁形态）
//   node scripts/deprecated-export-check.mjs --json        # 机器读（同一份事实）
//   node scripts/deprecated-export-check.mjs --types       # 追加：读 `npm run types:build` 的生成物
//   node scripts/deprecated-export-check.mjs --root <dir>  # 换根（自测用）
//   node scripts/deprecated-export-check.mjs --self-test   # 反向证（真树内存副本，不写盘）
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRecords,
  computeInventory,
  resolveEntries,
} from "./export-consumer-check.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 缺省删除版本（#429 决策：零消费者导出并入 0.30 破坏包）。没有在 `REMOVAL_REGISTRY` 里单独登记的名字
 * 都绑这个版本。改这里 = 改缺省口径，报告里要写。
 */
export const DEFAULT_REMOVAL_VERSION = "0.30";

/** 兼容别名：缺省版本就是「不登记时的版本」。新代码请用 `DEFAULT_REMOVAL_VERSION`。 */
export const REMOVAL_VERSION = DEFAULT_REMOVAL_VERSION;

/**
 * 逐个名字的移除版本登记表：名字 → `{ version, reason }`。
 *
 * 为什么需要它：0.30 是**整包**的删除包，但「仓内零消费者」不等于「宿主零消费者」——本判据看不见宿主仓
 * （边界写在文件头与报告里）。宿主侧核验过的名字若仍在被导入，就不能跟 0.30 一起删；把它的删除版本
 * 单独挪后，比把整张票推翻更小、也更可核：读的人从这一个名字上就能看出「它为什么还在」。
 *
 * 两条纪律（都由 R7 / R8 看守）：
 *   · 条目必须**真的对上一条标记**（空转即红，与 #210 R2 同口径）——否则登记表会变成一张「看起来已安排」
 *     的空头支票；
 *   · 条目必须写 `reason`（宿主仓实测在导入的证据 / 迁移去向）——没有理由的豁免没人能复核。
 *
 * 今天登记的两条都来自宿主仓扫描：宿主消费者探针 `scripts/host-consumer-probe.mjs` 会把它们的命中
 * 逐条点名（哪个宿主、哪个文件:行）。
 */
export const REMOVAL_REGISTRY = Object.freeze({
  notesStoreContract: {
    version: "0.31",
    reason: "host-side audit: touwaka (tests/llm-kit-adapters/notes-store-contract.test.mjs) and app_container "
      + "(apps/worker/test/notes-store.test.js) import it from the `erix-agent/contract-tests` entry today; "
      + "that entry keeps exporting it, so the removal waits for the 0.31 bundle",
  },
  createAnthropicProvider: {
    version: "0.31",
    reason: "host-side audit: app_container (apps/worker/src/pi/erix-adapter.js) imports it, and there is no "
      + "in-tree replacement until the assembly port converges — deleting it in 0.30 would break a live host",
  },
});

/**
 * 某个公共名绑定的删除版本：登记表里点名就按登记表，否则缺省。
 *
 * @param {string} name
 * @param {Record<string, {version?: string, reason?: string}>} registry
 * @returns {string}
 */
export function removalVersionOf(name, registry = REMOVAL_REGISTRY) {
  const entry = registry?.[name];
  return typeof entry?.version === "string" && entry.version.trim() !== ""
    ? entry.version.trim()
    : DEFAULT_REMOVAL_VERSION;
}

/** 扫描面：与清点工具同一份语料（消费者面 + 暴露面），登记标记只可能出现在这些文件里。 */
const TAG_SCAN_DIRS = ["src", "bin", "examples", "test", "docs", "scripts"];
const CODE_EXTS = [".js", ".mjs", ".cjs"];

/** 判据码（报告与 `--json` 共用；新增一条先加在这里）。 */
export const CODES = {
  NOT_REGISTERED: "R1",
  NOT_A_CANDIDATE: "R2",
  WRONG_VERSION: "R3",
  NO_MIGRATION: "R4",
  TAG_NOT_ADJACENT: "R5",
  UNRESOLVED_DECLARATION: "R6",
  REGISTRY_ENTRY_IDLE: "R7",
  REGISTRY_ENTRY_INVALID: "R8",
};

// ─────────────────────────────── 源码形状 ───────────────────────────────

const IDENT = "[A-Za-z_$][\\w$]*";
/** 声明那一行的形状：`export function x(`、`export const x =`、`export class X {`、`x(...) {`（方法）。 */
const DECL_PATTERNS = [
  new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class)\\s+(${IDENT})`),
  new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\b`),
  new RegExp(`^\\s*(?:async\\s+)?(${IDENT})\\s*\\(`),
];

/** 从一行源码里认出声明的标识符；认不出返回 null（**不猜**）。 */
export function declaredNameOf(line) {
  for (const pattern of DECL_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * 把 `@deprecated` 标签的正文取出来（含折行续行）。
 * 用 `matchAll` 而不是有状态 `g` 正则 `.exec()`（#406 坑 1：`lastIndex` 会推进 ⇒ 漏报）。
 *
 * @param {string} block 一个 `/** … *\/` 块（含首尾）
 * @returns {string|null} 标签正文（去掉了行首 `*`）；块里没有 `@deprecated` 返回 null
 */
export function deprecatedTagText(block) {
  const lines = block.split("\n").map((line) => line.replace(/^\s*\*\s?/, ""));
  const start = lines.findIndex((line) => /@deprecated\b/.test(line));
  if (start === -1) return null;
  const body = [lines[start].replace(/^.*?@deprecated\b\s*/, "")];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*@\w/.test(line)) break;          // 下一个标签开始了
    if (/^\s*\*\/\s*$/.test(line) || /^\s*\/\*\*/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

/**
 * 扫一个文件里的全部 JSDoc 块，返回 `{block, startLine, endLine}`（行号 1 起）。
 * 只认 `/** … *\/`；`/* … *\/` 与 `//` 不算（它们进不了 `.d.ts`）。
 *
 * @param {string} text
 * @returns {Array<{text: string, startLine: number, endLine: number}>}
 */
export function jsdocBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\/\*\*(?!\*)/.test(lines[i])) continue;
    for (let j = i; j < lines.length; j += 1) {
      if (/\*\/\s*$/.test(lines[j])) {
        blocks.push({ text: lines.slice(i, j + 1).join("\n"), startLine: i + 1, endLine: j + 1 });
        i = j;
        break;
      }
    }
  }
  return blocks;
}

/**
 * 块后面**紧贴**的那一行（中间只允许零行空隙）认出的声明名。
 * 空行、注释、别的块都算「不紧贴」⇒ 返回 `{name: null, line: <第一个非空行行号>}`。
 *
 * @returns {{name: string|null, line: number|null}}
 */
export function adjacentDeclaration(lines, endLine /* 1 起 */) {
  const next = endLine;                    // lines 下标 = 行号（endLine 是 1 起的最后一行）
  if (next >= lines.length) return { name: null, line: null };
  const raw = lines[next];
  if (raw.trim() === "") return { name: null, line: next + 1 };
  if (/^\s*(\/\/|\/\*)/.test(raw)) return { name: null, line: next + 1 };
  return { name: declaredNameOf(raw), line: next + 1 };
}

/**
 * 跳过空行与注释行，找块之后第一条**代码行**的声明名（R5 用：判断「标记是不是贴错了地方」）。
 *
 * @returns {{name: string|null, line: number|null}}
 */
export function firstDeclarationAfter(lines, endLine /* 1 起 */, maxLookahead = 12) {
  for (let i = endLine; i < Math.min(lines.length, endLine + maxLookahead); i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    return { name: declaredNameOf(raw), line: i + 1 };
  }
  return { name: null, line: null };
}

// ─────────────────────────────── 登记事实 ───────────────────────────────

/**
 * 从语料里抽出「公共名 × 登记标记」的事实。
 *
 * @param {Array<{rel: string, text: string}>} records 语料（与清点工具同一份）
 * @param {Set<string>} publicNames 公共入口导出名集合
 * @returns {{entries: Array<object>, adjacentUnresolved: Array<object>}}
 *   entries：贴对了位置的登记（`{name, file, line, tag}`）；
 *   adjacentUnresolved：贴的位置认不出公共名（R6）
 */
export function collectRegistrations(records, publicNames) {
  const entries = [];
  const adjacentUnresolved = [];
  for (const record of records) {
    if (!TAG_SCAN_DIRS.some((dir) => record.rel === dir || record.rel.startsWith(`${dir}/`))) continue;
    if (!CODE_EXTS.some((ext) => record.rel.endsWith(ext))) continue;
    const blocks = jsdocBlocks(record.text);
    if (blocks.length === 0) continue;
    const lines = record.text.split("\n");
    for (const block of blocks) {
      const tag = deprecatedTagText(block.text);
      if (tag === null) continue;
      const adjacent = adjacentDeclaration(lines, block.endLine);
      if (adjacent.name && publicNames.has(adjacent.name)) {
        entries.push({ name: adjacent.name, file: record.rel, line: adjacent.line, tag, blockLine: block.endLine });
        continue;
      }
      // 不紧贴 / 认不出：只有在「跳过空行与注释之后能认出一个公共名」时才算 R5/R6，
      // 否则它贴的是内部方法（如 `src/store/file.js` 的 checkpoint 别名），不归本判据管。
      const beyond = firstDeclarationAfter(lines, block.endLine);
      if (beyond.name && publicNames.has(beyond.name)) {
        adjacentUnresolved.push({
          name: beyond.name,
          file: record.rel,
          line: beyond.line,
          blockLine: block.endLine,
          tag,
          adjacentName: adjacent.name,
        });
      }
    }
  }
  return { entries, adjacentUnresolved };
}

/** 树里真的声明过的符号集合（迁移目标必须落在这里面，指到空气里等于没写）。 */
export function declaredSymbols(records) {
  const names = new Set();
  for (const record of records) {
    if (!CODE_EXTS.some((ext) => record.rel.endsWith(ext))) continue;
    for (const line of record.text.split("\n")) {
      const name = declaredNameOf(line);
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * 判据本体（纯函数：给语料与清点结果，返回红项；不读盘、不写盘，自测因此可以打内存副本）。
 *
 * @param {{records: Array<{rel: string, text: string}>, inventory: object,
 *          registry?: Record<string, {version?: string, reason?: string}>}} input
 *   `registry` 是逐个名字的移除版本登记表（缺省 = 模块里那张 `REMOVAL_REGISTRY`）；自测靠注入它打反向证。
 * @returns {{reds: Array<{code: string, name: string, file?: string, line?: number|null, detail: string}>,
 *            registered: Array<object>, candidates: Array<object>}}
 */
export function verify({ records, inventory, registry = REMOVAL_REGISTRY }) {
  const reds = [];
  const names = inventory.names ?? [];
  const publicNames = new Set(names.map((row) => row.name));
  const candidates = names.filter((row) => row.kind === "zero-reference");
  const candidateNames = new Set(candidates.map((row) => row.name));
  const symbols = declaredSymbols(records);
  const { entries, adjacentUnresolved } = collectRegistrations(records, publicNames);
  const registeredNames = new Set(entries.map((row) => row.name));

  // R5 / R6：标记没贴在声明上（贴错位置 / 认不出贴给谁）——先报，因为它会让 R1 假红（标记在但读不到）。
  for (const row of adjacentUnresolved) {
    reds.push({
      code: CODES.TAG_NOT_ADJACENT,
      name: row.name,
      file: row.file,
      line: row.line,
      detail: `@deprecated 块在 ${row.file}:${row.blockLine}，但紧贴它的那一行不是 \`${row.name}\` 的声明`
        + `（中间夹了空行/注释，或块贴在了别处）——这种形状 tsc **不**把它当声明的 doc，\`.d.ts\` 里的标记会静默消失`,
    });
  }
  for (const row of entries) {
    const expected = removalVersionOf(row.name, registry);
    // R2：有消费者的公共名被标了删除（版本无关——0.30 和 0.31 一样是宿主可见破坏的提前承诺）
    if (!candidateNames.has(row.name)) {
      const meta = names.find((r) => r.name === row.name);
      const evidence = meta?.consumerFiles?.length
        ? `仓内消费者：${meta.consumerFiles.slice(0, 3).join("、")}`
        : (meta?.publishFiles?.length
          ? `发布面消费者：${meta.publishFiles.slice(0, 3).join("、")}`
          : (meta?.internalUses ? `仅自身定义文件内引用 ${meta.internalUses} 处（internal-only，处置是去 \`export\`，不是标删除）` : "档位未知"));
      reds.push({
        code: CODES.NOT_A_CANDIDATE,
        name: row.name,
        file: row.file,
        line: row.line,
        detail: `被标了「${expected} 删除」，但它不是零消费者候选（kind=${meta?.kind ?? "unknown"}；${evidence}）`
          + "——给有消费者的符号标删除，是宿主可见破坏的提前承诺",
      });
    }
    // R3：删除版本（逐个名字：登记表点名就按登记表，否则缺省）
    const version = /(\d+\.\d+)/.exec(row.tag)?.[1] ?? null;
    if (version === null) {
      reds.push({
        code: CODES.WRONG_VERSION,
        name: row.name,
        file: row.file,
        line: row.line,
        detail: `标记里没有删除版本（期望 ${expected}）：${JSON.stringify(row.tag)}`,
      });
    } else if (version !== expected) {
      reds.push({
        code: CODES.WRONG_VERSION,
        name: row.name,
        file: row.file,
        line: row.line,
        detail: `标记写的删除版本是 ${version}，这个名字绑的是 ${expected}`
          + `（${registry[row.name] ? "来自 REMOVAL_REGISTRY 的逐名登记" : `未在 REMOVAL_REGISTRY 里登记 ⇒ 缺省 ${DEFAULT_REMOVAL_VERSION}`}）`,
      });
    }
    // R4：迁移目标
    const migrate = /migrate to\s+`([^`]+)`/i.exec(row.tag);
    const noReplacement = /no in-tree replacement/i.test(row.tag);
    if (!migrate && !noReplacement) {
      reds.push({
        code: CODES.NO_MIGRATION,
        name: row.name,
        file: row.file,
        line: row.line,
        detail: "标记没写迁移目标（`` migrate to `X` `` 或 `no in-tree replacement` 二选一）",
      });
    } else if (migrate && !symbols.has(migrate[1])) {
      reds.push({
        code: CODES.NO_MIGRATION,
        name: row.name,
        file: row.file,
        line: row.line,
        detail: `迁移目标 \`${migrate[1]}\` 在树里没有声明——指到空气里的迁移等于没写`,
      });
    }
  }

  // R7 / R8：登记表自身的两条判据（空转即红 / 条目形状）。
  // 它们必须在 R1 之前报：R7 说的是「登记表里有一条没对上标记」，与「候选没登记」（R1）是相反方向的两件事。
  for (const [name, entry] of Object.entries(registry ?? {})) {
    const version = typeof entry?.version === "string" ? entry.version.trim() : "";
    const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
    if (!/^\d+\.\d+$/.test(version) || reason === "") {
      reds.push({
        code: CODES.REGISTRY_ENTRY_INVALID,
        name,
        file: "scripts/deprecated-export-check.mjs",
        line: null,
        detail: `REMOVAL_REGISTRY 的条目形状不合规：version=${JSON.stringify(entry?.version ?? null)}`
          + `（必须是 \`x.y\`）、reason=${reason === "" ? "空" : "有"}（必须写理由）——`
          + "没有理由的豁免是下一任读者无法复核的免检通道",
      });
    }
    if (!registeredNames.has(name)) {
      reds.push({
        code: CODES.REGISTRY_ENTRY_IDLE,
        name,
        file: "scripts/deprecated-export-check.mjs",
        line: null,
        detail: `REMOVAL_REGISTRY 登记了 \`${name}\`（版本 ${version || "?"}），但源码里**没有任何** \`@deprecated\` 标记`
          + "对上这个名字——登记表说它等更晚的发布包再删，实际这条登记已空转（#210 R2：静默不匹配的豁免条目本身就是错）",
      });
    }
  }

  // R1：候选必须有登记
  const registered = registeredNames;
  for (const row of candidates) {
    if (registered.has(row.name)) continue;
    reds.push({
      code: CODES.NOT_REGISTERED,
      name: row.name,
      file: row.def,
      line: null,
      detail: `零消费者候选没有 \`@deprecated\` 登记（定义文件 ${row.def}）——本票的交付物就是这条登记`,
    });
  }

  return { reds, registered: entries, candidates };
}

// ─────────────────────────────── --types（读生成物）───────────────────────────────

/**
 * 生成物核对：`npm run types:build` 之后，候选的 `@deprecated` 必须出现在 `.d.ts` 里。
 *
 * 为什么必须读生成物而不是只读源码：两个坑（AGENTS「类型面规矩」，#213 R4）都会让标记**静默消失**
 * 而源码看上去一切正常——① 块与声明之间夹空行/注释；② 别名 const 没写 `@type` 时 tsc 复制被别名
 * 函数的 doc（本票实测：`extractL0` / `extractL0Fact` / `parseSummary` / `parseReflectionSummary`
 * 四个标记在 `l0.d.ts` 里一个都没有，补了 `@type {typeof …}` 才出现）。
 *
 * @returns {{reds: Array<object>, skipped: Array<object>}}
 */
export function verifyTypes({ root, candidates }) {
  const reds = [];
  const skipped = [];
  for (const row of candidates) {
    const dtsRel = row.def.replace(/\.js$/, ".d.ts");
    if (!dtsRel.startsWith("src/")) {
      // `exports["./contract-tests"]` 没有 types 键 ⇒ `test/contract/*.js` 不进声明图。
      // 这是**已知且被登记**的缺口，不是静默跳过：报告里逐条列出来。
      skipped.push({ name: row.name, file: row.def, reason: "不在声明图里（exports[\"./contract-tests\"] 没有 types 键）" });
      continue;
    }
    const abs = join(root, dtsRel);
    if (!existsSync(abs)) {
      reds.push({
        code: "TYPES_MISSING",
        name: row.name,
        file: dtsRel,
        detail: `${dtsRel} 不存在——先跑 \`npm run types:build\`（生成物不入库，本模式读的是它）`,
      });
      continue;
    }
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const hit = jsdocBlocks(text)
      .filter((block) => deprecatedTagText(block.text) !== null)
      .map((block) => ({ block, adjacent: adjacentDeclaration(lines, block.endLine) }))
      .find((row2) => row2.adjacent.name === row.name);
    if (!hit) {
      reds.push({
        code: "TYPES_DEPRECATION_LOST",
        name: row.name,
        file: dtsRel,
        detail: `生成物 ${dtsRel} 里 \`${row.name}\` 的声明上没有 \`@deprecated\`——源码标记没进声明`
          + "（别名 const 缺 `@type {typeof …}`，或块没紧贴声明）",
      });
    }
  }
  return { reds, skipped };
}

// ─────────────────────────────── 报告 ───────────────────────────────

function renderReport({ inventory, result, types, root, registry = REMOVAL_REGISTRY }) {
  const lines = [];
  lines.push("deprecated-export-check：零消费者导出 × `@deprecated` 登记对账（issue #429）");
  lines.push("");
  lines.push(`根目录：${root}`);
  lines.push(`清点事实：${inventory.total} 个导出名 ⇒ 零消费者候选 ${result.candidates.length} 个`
    + `（清点工具：node scripts/export-consumer-check.mjs）`);
  const perName = Object.keys(registry ?? {}).length;
  lines.push(`登记事实：${result.registered.length} 个公共名带删除标记（缺省删除版本 ${DEFAULT_REMOVAL_VERSION}；`
    + `逐名登记表 ${perName} 条：${Object.entries(registry ?? {}).map(([n, e]) => `\`${n}\` → ${e.version}`).join("、") || "（空）"}）`);
  lines.push("");
  lines.push("## 候选 × 登记");
  const byName = new Map(result.registered.map((row) => [row.name, row]));
  lines.push("| 名字 | 定义文件 | 登记 | 删除版本 | 迁移目标 |");
  lines.push("|---|---|---|---|---|");
  for (const row of result.candidates) {
    const reg = byName.get(row.name);
    const tag = reg?.tag ?? "";
    const migrate = /migrate to\s+`([^`]+)`/i.exec(tag)?.[1];
    const target = migrate ? `\`${migrate}\`` : (/no in-tree replacement/i.test(tag) ? "no in-tree replacement" : "—");
    const bound = removalVersionOf(row.name, registry);
    const versionCell = bound === DEFAULT_REMOVAL_VERSION ? bound : `${bound}（逐名登记）`;
    lines.push(`| \`${row.name}\` | \`${row.def}\` | ${reg ? `✓ ${reg.file}:${reg.line}` : "✗ 未登记"} | ${versionCell} | ${target} |`);
  }
  if (perName > 0) {
    lines.push("");
    lines.push("## 逐名移除版本登记表（`REMOVAL_REGISTRY`：每个条目必须对得上一条标记，且必须写理由）");
    for (const [name, entry] of Object.entries(registry)) {
      lines.push(`- \`${name}\` → ${entry.version} —— ${entry.reason}`);
    }
  }
  if (types) {
    lines.push("");
    lines.push("## 生成物核对（`--types`：读 `npm run types:build` 的 `.d.ts`）");
    for (const row of result.candidates) {
      const bad = types.reds.find((red) => red.name === row.name);
      const skip = types.skipped.find((entry) => entry.name === row.name);
      lines.push(`- ${bad ? "✗" : "✓"} \`${row.name}\`${bad ? ` — ${bad.detail}` : (skip ? ` — 跳过：${skip.reason}` : "")}`);
    }
  }
  lines.push("");
  if (result.reds.length === 0 && (types?.reds.length ?? 0) === 0) {
    lines.push(`结论：绿 —— ${result.candidates.length} 个候选全部登记且写法合规；`
      + "没有「有消费者却标删除」的名字；逐名登记表每一条都对得上标记且写了理由。");
  } else {
    lines.push("## 红项（逐条点名）");
    for (const red of [...result.reds, ...(types?.reds ?? [])]) {
      const at = red.file ? ` @ ${red.file}${red.line ? `:${red.line}` : ""}` : "";
      lines.push(`- [${red.code}] \`${red.name}\`${at} — ${red.detail}`);
    }
  }
  lines.push("");
  lines.push("## 边界（本判据证明不了的事）");
  lines.push("  只证**仓内**零消费者：宿主仓（touwaka / app_container / erix-station / pi）不在扫描面里，");
  lines.push("  它们的 import 这里一个都看不见 ⇒ **删除前必须另核宿主**。本判据拦的是「登记与清点脱钩」，");
  lines.push("  不是「可以删了」。宿主侧的核验由 `node scripts/host-consumer-probe.mjs --hosts <目录>` 做");
  lines.push("  （`npm run check:host-consumers`），它把被导入的候选名字逐条点名到宿主仓 / 文件:行。");
  lines.push("");
  lines.push("## 逐字复现");
  lines.push("  node scripts/deprecated-export-check.mjs              # 本表");
  lines.push("  node scripts/deprecated-export-check.mjs --types      # 追加生成物核对（先 npm run types:build）");
  lines.push("  node scripts/deprecated-export-check.mjs --self-test  # 反向证");
  lines.push("  node scripts/host-consumer-probe.mjs --hosts <宿主目录>  # 宿主侧求交（给了目录才判）");
  return lines.join("\n");
}

// ─────────────────────────────── 自测（反向证）───────────────────────────────

/** 把一条记录里的靶串换掉；换不掉就**算失败**（#210 R2：变异没落地不许当通过）。 */
function mutate(records, { rel, from, to }) {
  const target = records.find((record) => record.rel === rel);
  if (!target) return { records, missed: `${rel} 不在语料里` };
  const next = target.text.replace(from, () => to);
  if (next === target.text) return { records, missed: `${rel} 里找不到靶串 ${JSON.stringify(String(from))}` };
  return {
    records: records.map((record) => (record.rel === rel ? { ...record, text: next } : record)),
    missed: null,
  };
}

/**
 * 在 `def` 里给 `name` 的声明加一个登记标记：声明上方已有 JSDoc 块就**追加进那个块**（真实形状），
 * 没有就新建一个块。落不上（找不到声明 / 文本没变）返回 `missed`——变异没落地一律算失败（#210 R2）。
 */
function injectTag(records, { name, def, tag }) {
  const target = records.find((record) => record.rel === def);
  if (!target) return { records, missed: `${def} 不在语料里` };
  const lines = target.text.split("\n");
  const declIndex = lines.findIndex((line) => declaredNameOf(line) === name);
  if (declIndex === -1) return { records, missed: `${def} 里找不到 \`${name}\` 的声明` };
  const blockEnd = declIndex - 1;
  let next;
  if (blockEnd >= 0 && /\*\/\s*$/.test(lines[blockEnd])) {
    // 已有 JSDoc 块：单行块（`/** x */`）先摊成多行，否则插进去就是语法错误（变异本身也要是真形状）。
    let blockStart = blockEnd;
    while (blockStart >= 0 && !/^\s*\/\*\*(?!\*)/.test(lines[blockStart])) blockStart -= 1;
    if (blockStart < 0) return { records, missed: `${def}:${blockEnd + 1} 以 */ 结尾但找不到 /** 开头` };
    if (blockStart === blockEnd) {
      const inner = lines[blockEnd].replace(/^\s*\/\*\*/, "").replace(/\*\/\s*$/, "").trim();
      next = [
        ...lines.slice(0, blockStart),
        "/**",
        ...(inner ? [` * ${inner}`] : []),
        ` * ${tag}`,
        " */",
        ...lines.slice(blockEnd + 1),
      ];
    } else {
      next = [...lines.slice(0, blockEnd), ` * ${tag}`, ...lines.slice(blockEnd)];
    }
  } else {
    next = [...lines.slice(0, declIndex), `/** ${tag} */`, ...lines.slice(declIndex)];
  }
  const text = next.join("\n");
  if (text === target.text) return { records, missed: `${def} 的注入没落上（文本未变）` };
  return { records: records.map((record) => (record.rel === def ? { ...record, text } : record)), missed: null };
}

function runSelfTest() {
  const failures = [];
  const passed = [];
  const expect = (cond, okMsg, failMsg) => (cond ? passed.push(okMsg) : failures.push(failMsg));

  console.log("deprecated-export-check --self-test：反向证（真树内存副本；仓内源码全程只读）");

  const records = buildRecords(DEFAULT_ROOT);
  const entryResolution = resolveEntries(DEFAULT_ROOT);
  const inventory = computeInventory(records, {
    root: DEFAULT_ROOT,
    entries: entryResolution.entries,
    extraErrors: entryResolution.errors,
  });
  if (inventory.incomplete) {
    console.log(`deprecated-export-check --self-test: 失败 — 真树清点本身不完整（${inventory.errors.map((e) => e.code).join(",")}），反向证基线不是真值`);
    return 1;
  }
  const baseline = verify({ records, inventory });
  const candidates = baseline.candidates;

  // ── 例① 基线：真树今天必须是绿的（否则反向证的「还原 ⇒ 绿」没有意义）──
  expect(
    baseline.reds.length === 0,
    `① 基线绿：${candidates.length} 个候选全部登记、0 红`,
    `① 基线不绿（${baseline.reds.length} 条红）：${baseline.reds.slice(0, 3).map((r) => `${r.code} ${r.name}`).join("、")}——先修树再看反向证`,
  );

  const pickCandidate = (name) => candidates.find((row) => row.name === name) ?? candidates[0];
  const candidate = pickCandidate("estimateMessagesTokens");

  // ── 例② R1：删掉一个候选的登记标记 ⇒ 红并点名；还原 ⇒ 绿 ──
  {
    const tagLine = `@deprecated issue #429: removed in 0.30 — migrate to \`estimateMessageTokens\``;
    const mutated = mutate(records, { rel: candidate.def, from: new RegExp(`\\s*\\*\\s*${tagLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*`), to: "" });
    if (mutated.missed) {
      failures.push(`② R1：变异没落上——${mutated.missed}`);
    } else {
      const after = verify({ records: mutated.records, inventory });
      const hit = after.reds.find((red) => red.code === CODES.NOT_REGISTERED && red.name === candidate.name);
      expect(
        Boolean(hit),
        `② R1 删掉 \`${candidate.name}\` 的登记 ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
        `② R1 删掉 \`${candidate.name}\` 的登记后没有报 NOT_REGISTERED（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
      );
      const restored = verify({ records, inventory });
      expect(
        restored.reds.length === 0,
        `②b 还原 ⇒ 绿（${restored.reds.length} 红）`,
        `②b 还原后没有回到绿（${restored.reds.map((r) => `${r.code}:${r.name}`).join(",")}）`,
      );
    }
  }

  // ── 例③ R2（本票 ④ 的反向证）：给一个**有消费者**的公共名也标上 ⇒ 红并点名 ──
  {
    const consumed = inventory.names
      .filter((row) => row.kind === "package-consumed" && row.consumerFiles.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!consumed) {
      failures.push("③ R2：真树里找不到「包内消费者」的名字——这一枪打不出去，反向证失效");
    } else {
      const mutated = injectTag(records, {
        name: consumed.name,
        def: consumed.def,
        tag: `@deprecated issue #429: removed in ${DEFAULT_REMOVAL_VERSION} — no in-tree replacement.`,
      });
      if (mutated.missed) {
        failures.push(`③ R2：变异没落上——${mutated.missed}`);
      } else {
        const after = verify({ records: mutated.records, inventory });
        const hit = after.reds.find((red) => red.code === CODES.NOT_A_CANDIDATE && red.name === consumed.name);
        expect(
          Boolean(hit),
          `③ R2 给有消费者的 \`${consumed.name}\`（${consumed.def}，消费者 ${consumed.consumerFiles[0]}）也标上 ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
          `③ R2 给有消费者的 \`${consumed.name}\` 标上删除后**没**被抓出（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
        );
        const restored = verify({ records, inventory });
        expect(
          restored.reds.length === 0,
          `③b 还原 ⇒ 绿（${restored.reds.length} 红）`,
          `③b 还原后没有回到绿（${restored.reds.map((r) => `${r.code}:${r.name}`).join(",")}）`,
        );
      }
    }
  }

  // ── 例④ R3：把删除版本写错（缺省 0.30 → 0.31，且这个名字没在登记表里）⇒ 红并点名 ──
  {
    // 靶串带上迁移目标：`src/tokens.js` 里有两个候选，只替换 `removed in 0.30` 会打到另一个名字上。
    const mutated = mutate(records, {
      rel: candidate.def,
      from: `removed in ${DEFAULT_REMOVAL_VERSION} — migrate to \`estimateMessageTokens\``,
      to: "removed in 0.31 — migrate to `estimateMessageTokens`",
    });
    if (mutated.missed) {
      failures.push(`④ R3：变异没落上——${mutated.missed}`);
    } else {
      const after = verify({ records: mutated.records, inventory });
      const hit = after.reds.find((red) => red.code === CODES.WRONG_VERSION && red.name === candidate.name);
      expect(
        Boolean(hit),
        `④ R3 版本改成 0.31 ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
        `④ R3 版本改成 0.31 后没报 WRONG_VERSION（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
      );
    }
  }

  // ── 例⑤ R4：抹掉迁移目标 ⇒ 红；迁移目标指到空气里 ⇒ 红 ──
  {
    const noTarget = mutate(records, {
      rel: candidate.def,
      from: /migrate to `estimateMessageTokens`[^\n]*/,
      to: "x",
    });
    if (noTarget.missed) {
      failures.push(`⑤ R4：变异没落上——${noTarget.missed}`);
    } else {
      const after = verify({ records: noTarget.records, inventory });
      const hit = after.reds.find((red) => red.code === CODES.NO_MIGRATION && red.name === candidate.name);
      expect(
        Boolean(hit),
        `⑤ R4 抹掉迁移目标 ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
        `⑤ R4 抹掉迁移目标后没报 NO_MIGRATION（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
      );
    }
    const bogusTarget = mutate(records, {
      rel: candidate.def,
      from: "migrate to `estimateMessageTokens`",
      to: "migrate to `estimateMessageTokensZZZ`",
    });
    if (bogusTarget.missed) {
      failures.push(`⑤b R4：变异没落上——${bogusTarget.missed}`);
    } else {
      const after = verify({ records: bogusTarget.records, inventory });
      const hit = after.reds.find((red) => red.code === CODES.NO_MIGRATION && red.name === candidate.name);
      expect(
        Boolean(hit),
        `⑤b R4 迁移目标改成不存在的 \`estimateMessageTokensZZZ\` ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
        `⑤b R4 迁移目标指到空气里没被抓出（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
      );
    }
  }

  // ── 例⑥ R5：把标记块与声明之间塞一个空行（tsc 会丢掉这个 doc）⇒ 红并点名 ──
  {
    // 注意：`mutate()` 用函数式 replacer，替换串**不**展开 `$1`/`$2`（那就是变异本身写错）。
    const mutated = mutate(records, {
      rel: candidate.def,
      from: " */\nexport function estimateMessagesTokens",
      to: " */\n\nexport function estimateMessagesTokens",
    });
    if (mutated.missed) {
      failures.push(`⑥ R5：变异没落上——${mutated.missed}`);
    } else {
      const after = verify({ records: mutated.records, inventory });
      const codes = after.reds.filter((red) => red.name === candidate.name).map((red) => red.code);
      expect(
        codes.includes(CODES.TAG_NOT_ADJACENT) || codes.includes(CODES.NOT_REGISTERED),
        `⑥ R5 块与声明之间插一个空行 ⇒ 红并点名（${codes.join("、")}）`,
        `⑥ R5 空行插进去后既没报 TAG_NOT_ADJACENT 也没报 NOT_REGISTERED（${codes.join("、") || "无"}）`,
      );
    }
  }

  // ── 例⑦ 变异没落地必须算失败（#210 R2）──
  {
    const missed = mutate(records, { rel: candidate.def, from: "@deprecatedZZZ_NOT_THERE", to: "x" });
    expect(
      Boolean(missed.missed),
      `⑦ 变异没落地被识别成失败（${missed.missed?.slice(0, 40)}…）`,
      "⑦ 变异没落地却没被识别（反向证会假绿）",
    );
  }

  // ── 例⑧ internal-only 不是候选：给它标删除同样要红（口径漏洞③ 的反向证）──
  {
    const internalOnly = inventory.names.find((row) => row.kind === "internal-only");
    if (!internalOnly) {
      failures.push("⑧ internal-only：真树里一个都没有——这一枪打不出去");
    } else {
      const mutated = injectTag(records, {
        name: internalOnly.name,
        def: internalOnly.def,
        tag: `@deprecated issue #429: removed in ${DEFAULT_REMOVAL_VERSION} — no in-tree replacement.`,
      });
      if (mutated.missed) {
        failures.push(`⑧ internal-only：变异没落上——${mutated.missed}`);
      } else {
        const after = verify({ records: mutated.records, inventory });
        const hit = after.reds.find((red) => red.code === CODES.NOT_A_CANDIDATE && red.name === internalOnly.name);
        expect(
          Boolean(hit),
          `⑧ internal-only \`${internalOnly.name}\` 被标删除 ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
          `⑧ internal-only \`${internalOnly.name}\` 被标删除后没被抓出（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
        );
      }
    }
  }

  // ── 例⑨ R2 在「逐名登记表把版本挪后」之后仍然拦得住：给有消费者的名字打 0.31 标记 ⇒ 仍红并点名 ──
  // 本票要的那一枪：版本可以逐名挪，但「有消费者」这条性质与版本无关——0.31 不是免死金牌。
  {
    const consumed = inventory.names
      .filter((row) => row.kind === "package-consumed" && row.consumerFiles.length > 0 && !REMOVAL_REGISTRY[row.name])
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!consumed) {
      failures.push("⑨ R2@0.31：真树里找不到「有包内消费者且未登记」的名字——这一枪打不出去，反向证失效");
    } else {
      const mutated = injectTag(records, {
        name: consumed.name,
        def: consumed.def,
        tag: "@deprecated issue #429: removed in 0.31 — no in-tree replacement.",
      });
      if (mutated.missed) {
        failures.push(`⑨ R2@0.31：变异没落上——${mutated.missed}`);
      } else {
        const after = verify({ records: mutated.records, inventory });
        const hit = after.reds.find((red) => red.code === CODES.NOT_A_CANDIDATE && red.name === consumed.name);
        expect(
          Boolean(hit),
          `⑨ R2 给有消费者的 \`${consumed.name}\`（${consumed.def}）打上 **0.31** 标记 ⇒ 仍红并点名（${hit?.code} ${hit?.name}）`,
          `⑨ R2 给有消费者的 \`${consumed.name}\` 打 0.31 标记后**没**被抓出——版本挪后就变成免死金牌了`
            + `（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
        );
        const restored = verify({ records, inventory });
        expect(
          restored.reds.length === 0,
          `⑨b 还原 ⇒ 绿（${restored.reds.length} 红）`,
          `⑨b 还原后没有回到绿（${restored.reds.map((r) => `${r.code}:${r.name}`).join(",")}）`,
        );
      }
    }
  }

  // ── 例⑩ 登记表是**承重**的：把它清空 ⇒ 真树里那两条 0.31 标记变 R3 红；换回真表 ⇒ 绿 ──
  // 这一条证的是「登记表真的在给版本供值」，而不是一张摆在旁边没人读的表。
  {
    const emptyRegistry = verify({ records, inventory, registry: {} });
    const moved = Object.keys(REMOVAL_REGISTRY);
    const wrongVersionNames = emptyRegistry.reds
      .filter((red) => red.code === CODES.WRONG_VERSION)
      .map((red) => red.name);
    const allMovedCaught = moved.every((name) => wrongVersionNames.includes(name));
    const restored = verify({ records, inventory, registry: REMOVAL_REGISTRY });
    expect(
      moved.length > 0 && allMovedCaught && restored.reds.length === 0,
      `⑩ 登记表清空 ⇒ ${moved.length} 个逐名登记的版本变 R3 红（${wrongVersionNames.join(",")}）⇒ 换回真表 ⇒ 绿（${restored.reds.length} 红）`,
      `⑩ 登记表清空后没把逐名登记的版本报成 R3：登记 ${JSON.stringify(moved)}，R3 点名 ${JSON.stringify(wrongVersionNames)}`
        + `（还原 ${restored.reds.length} 红）——登记表没有在给版本供值`,
    );
  }

  // ── 例⑪ R7：登记表里一条**对不上任何标记**的条目 ⇒ 红并点名（#210 R2：空转的豁免条目本身就是错）──
  {
    const ghostName = "SELFTEST_GHOST_ENTRY_NOT_IN_TREE";
    const withGhost = verify({
      records,
      inventory,
      registry: { ...REMOVAL_REGISTRY, [ghostName]: { version: "0.31", reason: "self-test: 这一条故意不对应任何标记" } },
    });
    const hit = withGhost.reds.find((red) => red.code === CODES.REGISTRY_ENTRY_IDLE && red.name === ghostName);
    expect(
      Boolean(hit),
      `⑪ R7 登记表里加一条没有标记的 \`${ghostName}\` ⇒ 红并点名（${hit?.code} ${hit?.name}）`,
      `⑪ R7 空转的登记表条目没被抓出（红项：${withGhost.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
    );
    // 反过来：把**真**登记表里的一个名字从源码标记侧抹掉（标记删了、登记还在）⇒ 同样是 R7，且这条是真树形状。
    const movedName = Object.keys(REMOVAL_REGISTRY)[0];
    const registeredEntries = collectRegistrations(records, new Set(inventory.names.map((row) => row.name))).entries;
    const registration = registeredEntries.find((row) => row.name === movedName);
    const markerOwner = registration ? records.find((record) => record.rel === registration.file) : null;
    if (!movedName || !registration || !markerOwner) {
      failures.push(`⑪b R7：真树里找不到 \`${movedName ?? "?"}\` 的登记（collectRegistrations 没给出 file）——这一枪打不出去`);
    } else {
      const lines = markerOwner.text.split("\n");
      const declIndex = lines.findIndex((line) => declaredNameOf(line) === movedName);
      const closeIndex = declIndex - 1;
      let openIndex = closeIndex;
      while (openIndex >= 0 && !/^\s*\/\*\*(?!\*)/.test(lines[openIndex])) openIndex -= 1;
      const depIndex = lines.findIndex((line, i) => i > openIndex && i < closeIndex && /@deprecated\b/.test(line));
      let end = depIndex + 1;
      while (end < closeIndex && !/^\s*\*\s*@\w/.test(lines[end])) end += 1;
      const strippedText = [...lines.slice(0, depIndex), ...lines.slice(end)].join("\n");
      if (declIndex < 0 || depIndex < 0 || strippedText === markerOwner.text) {
        failures.push(`⑪b R7：\`${movedName}\` 的标记块没被剥掉（变异没落上：declIndex=${declIndex}、depIndex=${depIndex}）`);
      } else {
        const recordsWithoutMarker = records.map((record) => (record.rel === markerOwner.rel ? { ...record, text: strippedText } : record));
        const after = verify({ records: recordsWithoutMarker, inventory });
        const idle = after.reds.find((red) => red.code === CODES.REGISTRY_ENTRY_IDLE && red.name === movedName);
        expect(
          Boolean(idle),
          `⑪b R7 把 \`${movedName}\` 的标记从源码里删掉（登记表还留着）⇒ R7 红并点名（${idle?.code} ${idle?.name}）`,
          `⑪b R7 标记删了、登记还在，却没报空转（红项：${after.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}）`,
        );
      }
    }
  }

  // ── 例⑫ R8：登记表条目形状不合规（缺理由 / 版本不是 x.y）⇒ 红并点名 ──
  {
    const target = Object.keys(REMOVAL_REGISTRY)[0];
    if (!target) {
      failures.push("⑫ R8：真登记表是空的——这一枪打不出去");
    } else {
      const noReason = verify({ records, inventory, registry: { ...REMOVAL_REGISTRY, [target]: { version: REMOVAL_REGISTRY[target].version, reason: "" } } });
      const badVersion = verify({ records, inventory, registry: { ...REMOVAL_REGISTRY, [target]: { version: "next", reason: "self-test" } } });
      const hitNoReason = noReason.reds.find((red) => red.code === CODES.REGISTRY_ENTRY_INVALID && red.name === target);
      const hitBadVersion = badVersion.reds.find((red) => red.code === CODES.REGISTRY_ENTRY_INVALID && red.name === target);
      expect(
        Boolean(hitNoReason) && Boolean(hitBadVersion),
        `⑫ R8 \`${target}\` 的登记缺理由 / 版本写成 \`next\` ⇒ 各自 R8 红并点名（${hitNoReason?.code} ${hitNoReason?.name} / ${hitBadVersion?.code} ${hitBadVersion?.name}）`,
        `⑫ R8 形状不合规的条目没被抓出：缺理由=${Boolean(hitNoReason)}、版本非法=${Boolean(hitBadVersion)}`,
      );
    }
  }

  if (failures.length) {
    console.log("");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log(`\ndeprecated-export-check --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    return 1;
  }
  for (const ok of passed) console.log(`  ✓ ${ok}`);
  console.log(`\ndeprecated-export-check --self-test: OK — ${passed.length} 条判据全部按预期（真树内存副本，不写盘、不碰仓内源码）`);
  return 0;
}

// ─────────────────────────────── main ───────────────────────────────

function parseArgs(argv) {
  const opts = { json: false, selfTest: false, types: false, root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--types") opts.types = true;
    else if (arg === "--root") { opts.root = resolve(argv[i + 1] ?? ""); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`deprecated-export-check: 不认识的参数 ${JSON.stringify(arg)}（支持 --json / --types / --self-test / --root <dir> / --help）`);
      process.exit(2);
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log("用法：node scripts/deprecated-export-check.mjs [--json] [--types] [--root <dir>] [--self-test]");
    return 0;
  }
  if (opts.selfTest) return runSelfTest();

  const records = buildRecords(opts.root);
  const entryResolution = resolveEntries(opts.root);
  const inventory = computeInventory(records, {
    root: opts.root,
    entries: entryResolution.entries,
    extraErrors: entryResolution.errors,
    extraWarnings: entryResolution.warnings,
  });
  if (inventory.incomplete) {
    const codes = inventory.errors.map((error) => error.code);
    console.error(`deprecated-export-check: 清点不完整（exit 2）——清点工具报 ${codes.join(",")}`);
    for (const error of inventory.errors) console.error(`  - [${error.code}] ${error.message}`);
    console.error("  清点不是真值 ⇒ 本判据无从对账（不许把「读不出」当成「没问题」）");
    return 2;
  }

  const result = verify({ records, inventory });
  let types = null;
  if (opts.types) {
    types = verifyTypes({ root: opts.root, candidates: result.candidates });
    if (types.reds.some((red) => red.code === "TYPES_MISSING")) {
      console.error("deprecated-export-check: 生成物不存在（exit 2）——先跑 `npm run types:build`");
      for (const red of types.reds.filter((row) => row.code === "TYPES_MISSING")) {
        console.error(`  - ${red.file}：${red.detail}`);
      }
      return 2;
    }
  }

  const reds = [...result.reds, ...(types?.reds ?? [])];
  if (opts.json) {
    console.log(JSON.stringify({
      tool: "deprecated-export-check",
      generatedFor: "issue #429：零消费者导出登记 @deprecated，删除并入 0.30（宿主在用的名字逐名挪后）",
      gate: true,
      removalVersion: DEFAULT_REMOVAL_VERSION,
      removalRegistry: REMOVAL_REGISTRY,
      root: opts.root,
      total: inventory.total,
      tiers: inventory.tiers,
      candidates: result.candidates.map((row) => ({
        name: row.name, def: row.def, removalVersion: removalVersionOf(row.name),
        registered: result.registered.some((reg) => reg.name === row.name),
        registration: result.registered.find((reg) => reg.name === row.name) ?? null,
      })),
      reds,
      types: types ? { reds: types.reds, skipped: types.skipped } : null,
      boundary: "只证仓内零消费者；宿主仓（touwaka / app_container / erix-station / pi）不在扫描面里，"
        + "宿主侧由 node scripts/host-consumer-probe.mjs --hosts <目录> 核（npm run check:host-consumers）",
      reproduce: [
        "node scripts/deprecated-export-check.mjs",
        "node scripts/deprecated-export-check.mjs --types",
        "node scripts/host-consumer-probe.mjs --hosts <宿主目录>",
      ],
    }, null, 2));
  } else {
    console.log(renderReport({ inventory, result, types, root: opts.root }));
  }
  return reds.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
