#!/usr/bin/env node
// @ts-check
// guide-removal-gate.mjs — issue #687：**升级指南声称「已删除」的导出名，必须在发布物运行时导出面上真的不存在**。
//
// 病根（issue #687 的原话，逐字可复核）：0.30.0 升级指南写着「16 exported names are removed」、§3 写着
// `createAnthropicProvider` 在 0.30.0 已不存在，而**已发布的 `erix-agent@0.30.0` 一个都没删**——解包后
// `import` 一次，root 与 `./tools` 两个入口把 16 个名字全都还给了消费者。三把既有闸都看不见这一维：
//   · `scripts/deprecated-export-check.mjs` 只对账「`@deprecated` 登记 ↔ `check:exports` 现算候选」；
//   · `scripts/host-consumer-probe.mjs` 只对账「宿主命中 ↔ 指南有无条目」；
//   · `check:docs` 的 `bundle-table` 只对账「指南两张表的名集 ↔ 候选清单」。
// 三条都在**文档/登记**这一侧打转，没有一条把「指南说了什么」与「装好的包真的导出什么」放在一起比。
// 于是「指南说删了、包还在」这一态可以一路绿到发布之后——这一页补的就是那一维。
//
// ── 判据（红就点名 `名字 @ 指南文件:行 @ 入口`）────────────────────────────────
//  G1 STILL_EXPORTED            指南（中英任一份）声称已删除的名字，在它登记的入口上**仍然被导出**，
//                              且没有 `KNOWN_NOT_REMOVED` 条目 ⇒ 红。正向断言与反向断言在这里是同一条：
//                              指南说「不存在」而运行时说「存在」，无论读哪一头都是同一处矛盾。
//  G2 REGISTRY_NO_WHY           `KNOWN_NOT_REMOVED` 的条目没写 `why`（或只写了空白）⇒ 红。没有理由的
//                              登记就是下一任读者的免检通道（与 `CONTRACT_PUBLISH_EXEMPTIONS` /
//                              `CONTRACT_DELETION_OVERRIDES` 同一条口径）。
//  G3 REGISTRY_IDLE             登记表指向一个**不再成立**的名字 ⇒ 红（#210 R2 惯例：空转的豁免条目本身
//                              就是错）。两种形状：指南两份都不再声称删它；或者运行时**已经**不再导出它
//                              （= 删除真的发生了）——后者说明这条账已经还清，登记必须跟着删。
//  G4 REGISTRY_MALFORMED / G5 REGISTRY_DUPLICATE  登记表形状坏掉 / 同一个名字登记两次 ⇒ 红。
//  G6 TABLE_UNPARSED            指南两份都读得到，但逐名表**一行也没解析出来** ⇒ 红（exit 2）。这是
//                              「读不出」，不是「这一版没删东西」：表形状一变（列数、第一格不是单个反引号
//                              标识符），名集会静默变成空集，而空集会让 G1 恒绿。分类原因里带上
//                              `CHANGELOG.md` 同版本段的反引号字段名个数，好让人一眼看出「表坏了」。
//  G7 GUIDE_MISSING / G8 GUIDE_UNREADABLE  中英任一份指南读不出 ⇒ 红（exit 2）。「任一份声明即算声明」
//                              的前提是两份都读得到；少一份就等于「那一份声称了什么」无从核对。
//  G9 RUNTIME_SURFACE_MISSING  运行时导出面拿不到（`check:release` 的装包探针没产出，或 CLI 单独跑时
//                              没人给它真值）⇒ exit 2。**读不出永远不等于绿。**
//
// ── 入口怎么判（不许猜）───────────────────────────────────────────────────────
//  入口按指南行里登记的入口列（`.` / `./tools`）判；读法住在 `scripts/bundle-guide-table.mjs`
//  （`check:docs` 的 `bundle-table` 与 `host-consumer-probe` 读的是同一份），本文件**不抄第二份表形状**、
//  也不抄第二份名单。入口列写法本工具不认识时（`bundleEntryClaim` 返 null），**两个入口都查**——
//  宁可按更严的一边判，也不许猜一个。入口列写错本身由 `check:docs` 的 `bundle-table` 判红（它现读
//  `src/index.js` / `src/tools/index.js` 的再导出块），这里不重复那一道。
//
// ── `KNOWN_NOT_REMOVED` 是什么（已知未删除清单，不是放宽）────────────────────────
//  它记的是「指南声称删了、而今天运行时**仍然**导出」的名字，每条必须带 `why`（为什么今天还在）。
//  它存在的原因是排期而不是口径：0.30 的处置（真删 vs 撤标记）在 issue #688，今天还没拍，而本单
//  （#687）**一个导出都不许删**。所以今天这张表必须覆盖全部 16 个名字，`check:release` 才绿；登记表一
//  清空，同一次跑就会逐名红出来（`--self-test` 把这两态都钉住）。
//  它是**棘轮**：删除真的发生之后，对应条目必须删掉（G3 会点名），条目只许减、不许留余量。
//
// ── 退出码（本仓惯例：读不出真值就红，不许假绿）───────────────────────────────
//  0 = 绿（红数 0）
//  1 = 判据红（G1–G5 任一条，逐条点名）
//  2 = 读不出真值（G6–G9）：指南缺失/读不出、逐名表解析不出名集、运行时导出面拿不到。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────
//   node scripts/guide-removal-gate.mjs --runtime <装好的包的导出面 JSON>   # 单独跑（调试用）
//   node scripts/guide-removal-gate.mjs --self-test                          # 反向证（合成夹具，不写盘）
//   import { verifyGuideRemoval } from "./guide-removal-gate.mjs";           # 真门禁的调用点（check:release）
//
//  `check:release` 的装包探针把 `{ root: [...], tools: [...] }` 写进临时工程，本模块吃那一份真值；
//  单独跑时没有真值可吃，所以**不给 `--runtime` 就 exit 2**（不是 exit 0）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_GUIDE_DOCS,
  BUNDLE_GUIDE_VERSION,
  bundleEntryClaim,
  bundleRowsFromText,
} from "./bundle-guide-table.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 入口 id → 指南入口列里的逐字写法（报错文案用；合法写法本身仍由 `bundle-guide-table.mjs` 定义）。 */
export const ENTRY_LABELS = Object.freeze({ root: "`.`", tools: "`./tools`" });

/** 两个入口的固定顺序（遍历与打印都用它，别让对象键序决定报错顺序）。 */
export const ENTRY_ORDER = Object.freeze(["root", "tools"]);

/** 本闸的判据码（报告、红项、自测共用一份，别在别处再抄一遍）。 */
export const GATE_CODES = Object.freeze({
  STILL_EXPORTED: "STILL_EXPORTED",
  REGISTRY_NO_WHY: "REGISTRY_NO_WHY",
  REGISTRY_IDLE: "REGISTRY_IDLE",
  REGISTRY_MALFORMED: "REGISTRY_MALFORMED",
  REGISTRY_DUPLICATE: "REGISTRY_DUPLICATE",
  TABLE_UNPARSED: "TABLE_UNPARSED",
  GUIDE_MISSING: "GUIDE_MISSING",
  GUIDE_UNREADABLE: "GUIDE_UNREADABLE",
  RUNTIME_SURFACE_MISSING: "RUNTIME_SURFACE_MISSING",
});

/**
 * **已知未删除清单**：指南声称已删除、而今天运行时仍然导出的名字 → `{ name, why }`。
 *
 * 纪律（由 G1 / G2 / G3 看守）：
 *   · 每条必须带 `why`，写清「为什么今天它还在」（不是「以后再删」这种排期话，是这一条名字的事实）；
 *   · 空转即红：名字不在指南的声称里、或者运行时已经不再导出它 ⇒ 这条账已还清，必须删掉（G3）；
 *   · 条数与 G1 现算的红名数**双向**对账：少一条 ⇒ 那一条 G1 红；多一条 ⇒ 那一条 G3 红；
 *   · 它**不是**放宽：指南删掉那一行，这条登记立刻空转（G3）；删除真的发生，这条登记也立刻空转（G3）。
 *
 * 今天它必须覆盖全部 16 个名字，因为 issue #688（真删 vs 撤标记）还没拍、而 #687 一个导出都不许删。
 */
export const KNOWN_NOT_REMOVED = Object.freeze([
  {
    name: "createCompositeToolProvider",
    why: "`./tools` 仍然导出它：它是把多个工具提供者合成一个 `listTools(sel)` 的公开工厂。"
      + "删除它是 issue #688 的处置（真删 vs 撤标记），#687 只建闸、一个导出都不许删。",
  },
  {
    name: "createEnvModelConfigProvider",
    why: "root 仍然导出它：它按环境变量读一个槽位，宿主要迁到自己的 `resolve(slot)` 实现。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "createJsonFileToolProvider",
    why: "`./tools` 仍然导出它：它从 JSON 文件（或目录）读工具集。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "createStaticToolProvider",
    why: "`./tools` 仍然导出它：它提供一份固定的内存 schema 集合。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "estimateMessagesTokens",
    why: "root 仍然导出它：它是 `estimateMessageTokens` 的一行别名，删除只是 import 站点的改名。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "extractL0",
    why: "root 仍然导出它：它是 `extractL0Facts` 的旧名别名，两者同一个函数。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "extractL0Fact",
    why: "root 仍然导出它：同一个事实抽取器的单数拼写别名。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "MESSAGE_OVERHEAD_TOKENS",
    why: "root 仍然导出它：它是 `MESSAGE_OVERHEAD` 的拼写别名（同一个常量，不是另一个旋钮）。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "NOTE_VALUE_MAX_CHARS",
    why: "root 与 `./tools` 两个入口都仍然导出它：没有任何工具 schema 读这个长度常量，但删常量是"
      + "issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "parseReflectionSummary",
    why: "root 仍然导出它：它是 `parseL1Summary` 的旧名别名。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "parseSummary",
    why: "root 仍然导出它：同一个内联摘要解析器的更短拼写。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "removeRecord",
    why: "`./tools` 仍然导出它：它是花名册记录的删除原语（`reconcile` 只重写状态、不删文件）。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "resolveFileReadMaxBytes",
    why: "`./tools` 仍然导出它：单次读取字节上限的解析器（真正生效的那份在 `createFileTools` 里）。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "serializeFoldedMessages",
    why: "root 仍然导出它：它是 `serializeFoldedMessagesWithMeta` 的薄包装（丢掉了 dropped / total / bounded 账）。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "setNotesClock",
    why: "`./tools` 仍然导出它：只被 notes 测试驱动的时钟注入钩子。"
      + "删除它是 issue #688 的处置，#687 一个导出都不许删。",
  },
  {
    name: "createAnthropicProvider",
    why: "root 仍然导出它，而 `scripts/deprecated-export-check.mjs` 的 `REMOVAL_REGISTRY` 记着宿主仓"
      + "真的在 import 这个工厂 ⇒ 删它要等宿主迁移完。处置在 issue #688，#687 一个导出都不许删。",
  },
]);

/** 一行的入口集合 → 有序数组（`bundleEntryClaim` 的 Set 顺序不稳定，打印要稳定）。 */
function orderEntries(entries) {
  const set = new Set(entries);
  return ENTRY_ORDER.filter((entry) => set.has(entry));
}

/** 入口 id → 指南写法（未登记的 id 原样回，便于报错时让人看见那个怪写法）。 */
function entryLabel(entry) {
  return ENTRY_LABELS[entry] ?? `\`${entry}\``;
}

/**
 * `CHANGELOG.md` 里与指南同版本那一段的**反引号标识符**（只用来给「表解析不出」分类，不参与裁决）。
 *
 * 为什么是它：`Breaking` 段写的就是这一版动了哪些字段/名字。表坏掉时名集是空的，而这一段有名字——
 * 两件事放在一起，读报错的人立刻知道「不是这一版没删东西，是表形状变了」。
 *
 * @param {string} root
 * @param {(abs: string) => string} read
 * @returns {{section: boolean, names: string[], error: string|null}}
 */
function changelogIdentifiers(root, read) {
  let text;
  try {
    text = read(join(root, "CHANGELOG.md"));
  } catch (err) {
    return { section: false, names: [], error: `${err?.code ?? err?.message}` };
  }
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s*\\[${BUNDLE_GUIDE_VERSION.replace(/\./g, "\\.")}\\]`).test(line));
  if (start < 0) return { section: false, names: [], error: null };
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  const body = lines.slice(start, end < 0 ? undefined : end).join("\n");
  const names = new Set();
  for (const match of body.matchAll(/`([A-Za-z_$][\w$]*)`/g)) names.add(match[1]);
  return { section: true, names: [...names].sort(), error: null };
}

/**
 * 从指南逐名表读出「被声明已删除」的名集（中英两份，任一份声明即算声明；入口取并集）。
 *
 * 纯读取 + 分类：不判定绿红，红绿裁决在 `evaluateGuideRemoval`。读不出（缺文件 / 表解析不出名集）
 * 返回分类原因，调用侧据此 exit 2——「读不出」不许当成「没声称」。
 *
 * @param {{root?: string, read?: (abs: string) => string}} [options]
 * @returns {{claims: Map<string, {name: string, entries: string[], files: Array<{file: string, line: number}>}>,
 *            errors: Array<{code: string, message: string}>, notes: string[]}}
 */
export function readRemovalClaims({ root = DEFAULT_ROOT, read = (abs) => readFileSync(abs, "utf8") } = {}) {
  /** @type {Map<string, {name: string, entries: string[], files: Array<{file: string, line: number}>}>} */
  const claims = new Map();
  /** @type {Array<{code: string, message: string}>} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];

  for (const rel of BUNDLE_GUIDE_DOCS) {
    let text;
    try {
      text = read(join(root, rel));
    } catch (err) {
      const code = err && /** @type {{code?: string}} */ (err).code === "ENOENT"
        ? GATE_CODES.GUIDE_MISSING
        : GATE_CODES.GUIDE_UNREADABLE;
      errors.push({
        code,
        message: `${rel} 读不出（${/** @type {{code?: string, message?: string}} */ (err)?.code
          ?? /** @type {{message?: string}} */ (err)?.message ?? "unknown"}）——`
          + "「指南声称删了哪些名字」无从核对；中英两份任一份缺失，名集就不是真值",
      });
      continue;
    }
    if (typeof text !== "string" || text.trim() === "") {
      errors.push({
        code: GATE_CODES.GUIDE_UNREADABLE,
        message: `${rel} 是空文件——指南的逐名表读不出名集，读不出不等于没声称`,
      });
      continue;
    }
    const { rows, dupes } = bundleRowsFromText(text);
    for (const dupe of dupes) {
      // 重复行本身由 `check:docs` 的 `bundle-table` 判红（那一页管表形状）；这里只记一笔，不改变名集。
      notes.push(`${rel} 同一个名字有两行：${dupe}（表形状由 check:docs 的 bundle-table 判红）`);
    }
    for (const [name, row] of rows) {
      const claimed = bundleEntryClaim(row.entry);
      const entries = claimed ? orderEntries([...claimed]) : ENTRY_ORDER.slice();
      if (!claimed) {
        notes.push(`${rel}:${row.line} \`${name}\` 的入口列写法不认识（「${row.entry}」）——按更严的一边判：`
          + "两个入口都查，不猜一个");
      }
      const existing = claims.get(name);
      if (existing) {
        for (const entry of entries) if (!existing.entries.includes(entry)) existing.entries.push(entry);
        existing.entries = orderEntries(existing.entries);
        existing.files.push({ file: rel, line: row.line });
      } else {
        claims.set(name, { name, entries, files: [{ file: rel, line: row.line }] });
      }
    }
  }

  if (claims.size === 0 && errors.length === 0) {
    const changelog = changelogIdentifiers(root, read);
    const detail = changelog.error
      ? `CHANGELOG.md 也读不出（${changelog.error}），交叉核对做不了`
      : changelog.section
        ? `而 CHANGELOG.md 的 ${BUNDLE_GUIDE_VERSION} 段里有 ${changelog.names.length} 个反引号字段名`
          + `（${changelog.names.slice(0, 6).join(", ")}${changelog.names.length > 6 ? " …" : ""}）`
        : `CHANGELOG.md 里找不到 ${BUNDLE_GUIDE_VERSION} 段，交叉核对做不了`;
    errors.push({
      code: GATE_CODES.TABLE_UNPARSED,
      message: `指南两份都读得到，但逐名表一行也没解析出来（名集 0 个）——${detail}。`
        + "这是「表读不出」，不是「这一版没删东西」：表形状一变（列数、第一格不是单个反引号标识符），"
        + "名集就静默成空集，而空集会让人以为没有可断言的东西",
    });
  }

  return { claims, errors, notes };
}

/**
 * 运行时导出面归一化：`{root: [...], tools: [...]}` → `{root: Set, tools: Set}`。
 *
 * 形状不对（缺入口 / 不是字符串数组）一律记成 `RUNTIME_SURFACE_MISSING`：拿不到真值就 exit 2，
 * 不许把「没读到」当成「一个都没导出」（那会让 G1 恒绿——正是本闸要修的那种假绿）。
 *
 * @param {unknown} runtime
 * @param {Array<{code: string, message: string}>} errors
 * @returns {{root: Set<string>, tools: Set<string>}|null}
 */
function normalizeRuntime(runtime, errors) {
  if (!runtime || typeof runtime !== "object") {
    errors.push({
      code: GATE_CODES.RUNTIME_SURFACE_MISSING,
      message: "运行时导出面没给（`{ root: [...], tools: [...] }`）——装包探针没产出真值，"
        + "「指南说删了、包还在不在」这一问无从核对；读不出不等于绿",
    });
    return null;
  }
  const out = {};
  for (const entry of ENTRY_ORDER) {
    const value = /** @type {Record<string, unknown>} */ (runtime)[entry];
    const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : null;
    if (!list || !list.every((name) => typeof name === "string")) {
      errors.push({
        code: GATE_CODES.RUNTIME_SURFACE_MISSING,
        message: `运行时导出面缺入口 \`${entry}\`（或不是字符串数组）——两个入口是入口列的全部合法取值，`
          + "缺一个就等于那一个入口上的断言无从做起",
      });
      return null;
    }
    out[entry] = new Set(list);
  }
  return /** @type {{root: Set<string>, tools: Set<string>}} */ (out);
}

/**
 * 红绿裁决（**纯函数**：吃名集 + 运行时面 + 登记表，不读盘、不打时钟）——`--self-test` 因此能在
 * 合成夹具上做反向证，真门禁只负责把三份事实凑齐。
 *
 * @param {{claims: Map<string, {name: string, entries: string[], files: Array<{file: string, line: number}>}>,
 *          runtime: unknown,
 *          registry?: readonly {name?: string, why?: string}[]}} params
 * @returns {{errors: Array<{code: string, message: string}>,
 *            reds: Array<{code: string, name: string, entries: string[], files: Array<{file: string, line: number}>, detail: string}>,
 *            known: Array<{name: string, entries: string[], files: Array<{file: string, line: number}>}>,
 *            notes: string[]}}
 */
export function evaluateGuideRemoval({ claims, runtime, registry = KNOWN_NOT_REMOVED } = /** @type {any} */ ({})) {
  /** @type {Array<{code: string, message: string}>} */ const errors = [];
  /** @type {Array<{code: string, name: string, entries: string[], files: Array<{file: string, line: number}>, detail: string}>} */ const reds = [];
  /** @type {Array<{name: string, entries: string[], files: Array<{file: string, line: number}>}>} */ const known = [];
  /** @type {string[]} */ const notes = [];

  const surface = normalizeRuntime(runtime, errors);
  if (!surface || !(claims instanceof Map)) {
    if (!(claims instanceof Map)) {
      errors.push({
        code: GATE_CODES.TABLE_UNPARSED,
        message: "名集不是 Map——读指南那一步没跑（或用错了返回值），没有名集就没有可断言的声称",
      });
    }
    return { errors, reds, known, notes };
  }

  // ── 登记表自证（空转即红，形状坏掉也红）────────────────────────────────────
  /** @type {Map<string, {name: string, why: string}>} */
  const registered = new Map();
  if (!Array.isArray(registry)) {
    reds.push({
      code: GATE_CODES.REGISTRY_MALFORMED,
      name: "KNOWN_NOT_REMOVED",
      entries: [],
      files: [],
      detail: "`KNOWN_NOT_REMOVED` 不是数组——已知未删除清单的出口被改坏了，"
        + "没有它「今天还没删」就与「闸没在看」分不开",
    });
  } else {
    for (const raw of registry) {
      const name = typeof raw?.name === "string" ? raw.name : "";
      if (!name) {
        reds.push({
          code: GATE_CODES.REGISTRY_MALFORMED,
          name: JSON.stringify(raw?.name ?? null),
          entries: [],
          files: [],
          detail: "`KNOWN_NOT_REMOVED` 有条目没有 `name`（或不是字符串）——登记表只能按名字对账，缺名字就是一条空转的豁免",
        });
        continue;
      }
      if (registered.has(name)) {
        reds.push({
          code: GATE_CODES.REGISTRY_DUPLICATE,
          name,
          entries: [],
          files: [],
          detail: `\`${name}\` 在 \`KNOWN_NOT_REMOVED\` 里登记了两次——重复条目会让条数对账说谎`,
        });
        continue;
      }
      if (typeof raw?.why !== "string" || raw.why.trim() === "") {
        reds.push({
          code: GATE_CODES.REGISTRY_NO_WHY,
          name,
          entries: [],
          files: [],
          detail: `\`${name}\` 的 \`why\` 为空——必须写清「为什么它今天还在」（不是排期话，是这一条名字的事实）；`
            + "没有理由的登记就是下一任读者的免检通道",
        });
      }
      registered.set(name, { name, why: String(raw?.why ?? "") });
    }
  }

  // ── G1：指南说「不存在」而运行时说「存在」 ────────────────────────────────
  /** @type {Map<string, {claim: {name: string, entries: string[], files: Array<{file: string, line: number}>}, entries: string[]}>} */
  const stillExported = new Map();
  for (const claim of claims.values()) {
    const hit = claim.entries.filter((entry) => surface[/** @type {"root"|"tools"} */ (entry)].has(claim.name));
    if (hit.length > 0) stillExported.set(claim.name, { claim, entries: hit });
  }
  for (const [name, hit] of stillExported) {
    if (registered.has(name)) {
      known.push({ name, entries: hit.entries, files: hit.claim.files });
      continue;
    }
    const files = hit.claim.files.map((f) => `${f.file}:${f.line}`).join(" / ");
    const entries = hit.entries.map(entryLabel).join(" + ");
    reds.push({
      code: GATE_CODES.STILL_EXPORTED,
      name,
      entries: hit.entries,
      files: hit.claim.files,
      detail: `\`${name}\` @ ${files} @ ${entries}——指南（中英任一份）声称它在 ${BUNDLE_GUIDE_VERSION} 已删除，`
        + "而发布物的运行时导出面上它还在：ESM 的 `import { " + name + " }` 照样成功，读者以为删了、其实没删",
    });
  }

  // ── G3：登记表里的空转条目（两个方向都点名）────────────────────────────────
  for (const name of registered.keys()) {
    if (stillExported.has(name)) continue;
    const claim = claims.get(name);
    const detail = claim
      ? `\`${name}\` @ ${claim.files.map((f) => `${f.file}:${f.line}`).join(" / ")} @ `
        + `${claim.entries.map(entryLabel).join(" + ")}——它已经不在运行时的这几个入口上了（删除真的发生了），`
        + "这条登记已经还清，必须从 `KNOWN_NOT_REMOVED` 删掉"
      : `\`${name}\`——指南中英两份都不再声称删除它，这条登记指向一个不再成立的名字（空转条目本身就是错）`;
    reds.push({
      code: GATE_CODES.REGISTRY_IDLE,
      name,
      entries: claim ? claim.entries : [],
      files: claim ? claim.files : [],
      detail,
    });
  }

  // ── 条数对账（双向）：多一条 ⇒ 至少一条 IDLE；少一条 ⇒ 至少一条 STILL_EXPORTED ──
  notes.push(`条数对账：登记表 ${registered.size} 条 ↔ 现算红名 ${stillExported.size} 个`
    + `（名集 ${claims.size} 个名字；多一条红 IDLE，少一条红 STILL_EXPORTED，两个方向都点名）`);

  return { errors, reds, known, notes };
}

/**
 * 真门禁的调用点：读指南 + 裁决，把退出码一起算出来。
 *
 * @param {{root?: string, runtime: unknown, registry?: readonly {name?: string, why?: string}[],
 *          read?: (abs: string) => string}} params
 * @returns {{status: number, claims: Map<string, any>, errors: Array<{code: string, message: string}>,
 *            reds: Array<any>, known: Array<any>, notes: string[]}}
 */
export function verifyGuideRemoval({ root = DEFAULT_ROOT, runtime, registry = KNOWN_NOT_REMOVED, read } = /** @type {any} */ ({})) {
  const claimsRead = readRemovalClaims(read ? { root, read } : { root });
  const verdict = evaluateGuideRemoval({ claims: claimsRead.claims, runtime, registry });
  const errors = [...claimsRead.errors, ...verdict.errors];
  const notes = [...claimsRead.notes, ...verdict.notes];
  const status = errors.length > 0 ? 2 : verdict.reds.length > 0 ? 1 : 0;
  return { status, claims: claimsRead.claims, errors, reds: verdict.reds, known: verdict.known, notes };
}

/** 一条红项翻成人话（报告与 `check:release` 的失败消息共用一份）。 */
export function formatRed(red) {
  return `[${red.code}] ${red.detail}`;
}

// ─────────────────────────────── 自测（反向证） ───────────────────────────────

/** 自测用的夹具：一段只有逐名行的指南文本（表形状与真指南一致：5 格、第一格是单个反引号标识符）。 */
function guideFixture(rows) {
  const header = [
    "# Host upgrade guide: fixture",
    "",
    "| Name | What it did | Migration clause | Entry | Definition |",
    "|---|---|---|---|---|",
  ];
  const body = rows.map(([name, entry]) => `| \`${name}\` | fixture row | no in-tree replacement | ${entry} | \`${name}\` (\`src/fixture.js\`) |`);
  return [...header, ...body, ""].join("\n");
}

/** 自测用的 CHANGELOG 夹具（同版本段里有反引号字段名，用来给「表解析不出」分类）。 */
const CHANGELOG_FIXTURE = [
  "# Changelog",
  "",
  `## [${BUNDLE_GUIDE_VERSION}] - 2026-01-01`,
  "",
  "### Breaking",
  "",
  "- `runToolLoop` no longer reads `maxRounds` from the flat option surface; `config.run.maxRounds` is the home.",
  "",
  "## [0.0.1] - 2025-01-01",
  "",
  "- old entry `ancientThing`.",
  "",
].join("\n");

/** 内存读盘器：按相对路径给文本；找不到就抛带 `ENOENT` 的错（与真 `readFileSync` 同形）。 */
function fixtureReader(files) {
  return (abs) => {
    for (const [rel, text] of Object.entries(files)) {
      if (abs === rel || abs.endsWith(`/${rel}`) || abs.endsWith(`\\${rel}`)) return text;
    }
    const err = /** @type {Error & {code: string}} */ (new Error(`ENOENT: ${abs}`));
    err.code = "ENOENT";
    throw err;
  };
}

/** 把 `{root: [...], tools: [...]}` 里某个入口的某个名字拿掉/加回；**变异没落上返回 null**。 */
function toggleRuntimeName(runtime, entry, name, mode) {
  const next = { root: [...runtime.root], tools: [...runtime.tools] };
  const list = next[entry];
  const at = list.indexOf(name);
  if (mode === "remove") {
    if (at < 0) return null;
    list.splice(at, 1);
  } else {
    if (at >= 0) return null;
    list.push(name);
  }
  return next;
}

function runSelfTest() {
  /** @type {string[]} */ const passed = [];
  /** @type {string[]} */ const failures = [];
  const expect = (cond, okMsg, failMsg) => (cond ? passed.push(okMsg) : failures.push(failMsg));

  console.log("guide-removal-gate --self-test：反向证（合成夹具 + 真指南只读；不写盘）");

  // ── 例① 真指南读得出名集（基线：反向证的起点必须是真值）──
  const real = readRemovalClaims();
  expect(
    real.errors.length === 0 && real.claims.size > 0,
    `① 真指南读得出名集：${real.claims.size} 个名字、0 个读取错误（中英两份）`,
    `① 真指南读不出名集（错误 ${real.errors.map((e) => e.code).join(",") || "无"}、名集 ${real.claims.size} 个）——`
      + "先修树再看反向证",
  );
  if (real.errors.length > 0 || real.claims.size === 0) {
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log("\nguide-removal-gate --self-test: 失败 — 真指南这一基线不是真值，后面的反向证没有意义");
    return 1;
  }

  const claims = real.claims;
  const firstName = [...claims.keys()][0];
  const firstClaim = /** @type {{name: string, entries: string[], files: Array<{file: string, line: number}>}} */ (claims.get(firstName));
  const firstEntry = firstClaim.entries[0];
  const otherEntry = ENTRY_ORDER.find((entry) => entry !== firstEntry) ?? "tools";

  // 合成运行时面：一个「指南说删了、运行时也真的没有」的世界（= 删除真的发生之后的样子）。
  /** @type {{root: string[], tools: string[]}} */
  const removedWorld = { root: [], tools: [] };

  // ── 例② 删除真的发生 + 登记表为空 ⇒ 绿（没有东西可登记，也没有东西可红）──
  {
    const verdict = evaluateGuideRemoval({ claims, runtime: removedWorld, registry: [] });
    expect(
      verdict.errors.length === 0 && verdict.reds.length === 0,
      `② 全删净的世界 + 空登记表 ⇒ 绿（0 红，名集 ${claims.size} 个）`,
      `② 全删净的世界 + 空登记表却红了 ${verdict.reds.length} 处：${verdict.reds.slice(0, 3).map((r) => `${r.code}:${r.name}`).join(",")}`,
    );
  }

  // ── 例③ 把一个名字放回它声称的入口 ⇒ 红 G1，且点名「名字 @ 指南文件:行 @ 入口」──
  {
    const world = toggleRuntimeName(removedWorld, firstEntry, firstName, "add");
    if (!world) {
      failures.push(`③ G1：变异没落上——\`${firstName}\` 已经在 ${firstEntry} 的合成运行时面上（夹具写错了）`);
    } else {
      const verdict = evaluateGuideRemoval({ claims, runtime: world, registry: [] });
      const hit = verdict.reds.find((red) => red.code === GATE_CODES.STILL_EXPORTED && red.name === firstName);
      const detail = hit?.detail ?? "";
      const file = firstClaim.files[0];
      expect(
        Boolean(hit)
          && detail.includes(firstName)
          && detail.includes(`${file.file}:${file.line}`)
          && detail.includes(entryLabel(firstEntry)),
        `③ G1 放回 \`${firstName}\`@${firstEntry} ⇒ 红并点名「名字 @ ${file.file}:${file.line} @ ${entryLabel(firstEntry)}」`,
        `③ G1 没按预期：红=${Boolean(hit)}，detail=${detail || "（无）"}`,
      );
      const back = evaluateGuideRemoval({ claims, runtime: removedWorld, registry: [] });
      expect(
        back.reds.length === 0,
        `③b 拿掉它 ⇒ 回到绿（${back.reds.length} 红）`,
        `③b 拿掉后没有回到绿（${back.reds.map((r) => `${r.code}:${r.name}`).join(",")}）`,
      );
    }
  }

  // ── 例④ 入口判定按指南行：放回**未声称**的入口 ⇒ 不红（证明按入口判，不是「任一入口出现就红」）──
  {
    const claimedEntries = new Set(firstClaim.entries);
    const unclaimedEntry = ENTRY_ORDER.find((entry) => !claimedEntries.has(entry));
    if (!unclaimedEntry) {
      failures.push(`④ 入口判定：\`${firstName}\` 声称了两个入口，找不到「未声称的入口」可打靶——这一枪打不出去`);
    } else {
      const world = toggleRuntimeName(removedWorld, unclaimedEntry, firstName, "add");
      if (!world) {
        failures.push(`④ 入口判定：变异没落上——\`${firstName}\` 已经在 ${unclaimedEntry} 上（夹具写错了）`);
      } else {
        const verdict = evaluateGuideRemoval({ claims, runtime: world, registry: [] });
        expect(
          verdict.reds.length === 0,
          `④ 入口按指南行判：\`${firstName}\` 只出现在**未声称**的 ${unclaimedEntry} 上 ⇒ 不红（入口列写错由 check:docs 的 bundle-table 判）`,
          `④ 入口判定越界：未声称的 ${unclaimedEntry} 上出现 \`${firstName}\` 也红了（${verdict.reds.map((r) => `${r.code}:${r.name}`).join(",")}）`,
        );
      }
    }
  }

  // 合成运行时面：一个「指南说删了、运行时一个都没删」的世界（= 今天发布物的形状）。
  /** @type {{root: string[], tools: string[]}} */
  const stillThere = { root: [], tools: [] };
  for (const claim of claims.values()) {
    for (const entry of claim.entries) stillThere[/** @type {"root"|"tools"} */ (entry)].push(claim.name);
  }

  // ── 例⑤ 登记表清空 + 「一个都没删」的运行时面 ⇒ 红名数 = 名集大小 ──
  {
    const cleared = evaluateGuideRemoval({ claims, runtime: stillThere, registry: [] });
    expect(
      cleared.reds.length === claims.size && cleared.reds.every((red) => red.code === GATE_CODES.STILL_EXPORTED),
      `⑤ 登记表清空 ⇒ 红 ${cleared.reds.length} 处（名集 ${claims.size} 个名字，逐名一条 G1）`,
      `⑤ 登记表清空只红了 ${cleared.reds.length} 处（期望 ${claims.size}）：${cleared.reds.map((r) => `${r.code}:${r.name}`).join(",")}`,
    );

    // ── 例⑥ 同一份运行时面 + 真登记表 ⇒ 绿，并打印「已知未删除 N 条」──
    const registered = evaluateGuideRemoval({ claims, runtime: stillThere, registry: KNOWN_NOT_REMOVED });
    expect(
      registered.reds.length === 0 && registered.known.length === KNOWN_NOT_REMOVED.length,
      `⑥ 真登记表 ${KNOWN_NOT_REMOVED.length} 条 ⇒ 绿，已知未删除 ${registered.known.length} 条（N=${registered.known.length}）`,
      `⑥ 真登记表没有全兜住：红 ${registered.reds.length} 处（${registered.reds.slice(0, 3).map((r) => `${r.code}:${r.name}`).join(",")}），`
        + `已知未删除 ${registered.known.length} 条（期望 ${KNOWN_NOT_REMOVED.length}）`,
    );
    expect(
      KNOWN_NOT_REMOVED.length === claims.size,
      `⑥b 登记表条数 ${KNOWN_NOT_REMOVED.length} = 名集 ${claims.size}（双向对账的今天取值）`,
      `⑥b 登记表条数 ${KNOWN_NOT_REMOVED.length} ≠ 名集 ${claims.size}——少一条会红 G1、多一条会红 G3（登记表必须与名集同步）`,
    );
  }

  // ── 例⑦ 少一条 ⇒ G1 点名那一条；多一条 ⇒ G3 点名那一条（双向漂移）──
  {
    const trimmed = KNOWN_NOT_REMOVED.filter((row) => row.name !== firstName);
    const short = evaluateGuideRemoval({ claims, runtime: stillThere, registry: trimmed });
    const shortHit = short.reds.find((red) => red.code === GATE_CODES.STILL_EXPORTED && red.name === firstName);
    const ghost = { name: "selfTestGhostName", why: "self-test: 指南两份都没有声明删除这个名字（故意空转）" };
    const long = evaluateGuideRemoval({ claims, runtime: stillThere, registry: [...KNOWN_NOT_REMOVED, ghost] });
    const longHit = long.reds.find((red) => red.code === GATE_CODES.REGISTRY_IDLE && red.name === ghost.name);
    expect(
      Boolean(shortHit) && short.reds.length === 1 && Boolean(longHit) && long.reds.length === 1,
      `⑦ 条数双向漂移：少一条 ⇒ 1 红 G1（\`${firstName}\`）；多一条 ⇒ 1 红 G3（\`${ghost.name}\`）`,
      `⑦ 条数漂移没按预期：少一条红 ${short.reds.length} 处（命中=${Boolean(shortHit)}），`
        + `多一条红 ${long.reds.length} 处（命中=${Boolean(longHit)}）`,
    );
  }

  // ── 例⑧ 空 why ⇒ 红 G2 ──
  {
    const target = KNOWN_NOT_REMOVED[0];
    const blank = KNOWN_NOT_REMOVED.map((row) => (row.name === target.name ? { ...row, why: "   " } : row));
    const verdict = evaluateGuideRemoval({ claims, runtime: stillThere, registry: blank });
    const hit = verdict.reds.find((red) => red.code === GATE_CODES.REGISTRY_NO_WHY && red.name === target.name);
    expect(
      Boolean(hit) && blank[0].why !== target.why,
      `⑧ 把 \`${target.name}\` 的 why 改成空白 ⇒ 红 G2（空 why 不是理由）`,
      `⑧ 空 why 没红：命中=${Boolean(hit)}（变异落上=${blank[0].why !== target.why}）`,
    );
  }

  // ── 例⑨ 删除真的发生了、登记还在 ⇒ 红 G3（登记已还清）──
  {
    const world = toggleRuntimeName(stillThere, firstEntry, firstName, "remove");
    if (!world) {
      failures.push(`⑨ G3：变异没落上——\`${firstName}\` 不在 ${firstEntry} 的合成运行时面上`);
    } else {
      const verdict = evaluateGuideRemoval({ claims, runtime: world, registry: KNOWN_NOT_REMOVED });
      const hit = verdict.reds.find((red) => red.code === GATE_CODES.REGISTRY_IDLE && red.name === firstName);
      expect(
        Boolean(hit) && verdict.known.every((row) => row.name !== firstName),
        `⑨ \`${firstName}\` 真的不在 ${firstEntry} 上了、登记还在 ⇒ 红 G3（空转条目）`,
        `⑨ 已删但登记还在却没红 G3：命中=${Boolean(hit)}，红=${verdict.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}`,
      );
    }
  }

  // ── 例⑩ 指南缺一份 ⇒ exit 2 且分类 GUIDE_MISSING ──
  {
    const read = fixtureReader({
      [BUNDLE_GUIDE_DOCS[0]]: guideFixture([[firstName, ENTRY_LABELS[firstEntry]]]),
    });
    const verdict = verifyGuideRemoval({ runtime: removedWorld, registry: [], read });
    expect(
      verdict.status === 2 && verdict.errors.some((err) => err.code === GATE_CODES.GUIDE_MISSING),
      `⑩ 只给一份指南（${BUNDLE_GUIDE_DOCS[0]}）⇒ exit 2 + GUIDE_MISSING（另一份声称了什么无从核对）`,
      `⑩ 缺一份指南没按预期：status=${verdict.status}，错误=${verdict.errors.map((e) => e.code).join(",") || "无"}`,
    );
  }

  // ── 例⑪ 表格解析不出名集、而 CHANGELOG 段有反引号字段名 ⇒ exit 2 + TABLE_UNPARSED ──
  {
    const brokenTable = ["# Host upgrade guide: fixture", "", "| Name | Entry |", "|---|---|", "| `x` | `.` |", ""].join("\n");
    const read = fixtureReader({
      [BUNDLE_GUIDE_DOCS[0]]: brokenTable,
      [BUNDLE_GUIDE_DOCS[1]]: brokenTable,
      "CHANGELOG.md": CHANGELOG_FIXTURE,
    });
    const verdict = verifyGuideRemoval({ runtime: removedWorld, registry: [], read });
    const hit = verdict.errors.find((err) => err.code === GATE_CODES.TABLE_UNPARSED);
    expect(
      verdict.status === 2 && Boolean(hit) && hit.message.includes("CHANGELOG.md") && hit.message.includes("runToolLoop"),
      `⑪ 表形状坏掉（2 格）+ CHANGELOG 段有反引号字段名 ⇒ exit 2 + TABLE_UNPARSED（分类原因点名 CHANGELOG）`,
      `⑪ 表坏掉没按预期：status=${verdict.status}，错误=${verdict.errors.map((e) => e.code).join(",") || "无"}`
        + `，message=${hit?.message?.slice(0, 120) ?? "（无）"}`,
    );
  }

  // ── 例⑫ 入口列写法不认识 ⇒ 两个入口都查（不猜一个）──
  {
    const text = guideFixture([[firstName, "`./nope`"]]);
    const read = fixtureReader({ [BUNDLE_GUIDE_DOCS[0]]: text, [BUNDLE_GUIDE_DOCS[1]]: text });
    const world = toggleRuntimeName(removedWorld, otherEntry, firstName, "add");
    if (!world) {
      failures.push(`⑫ 入口未知：变异没落上——\`${firstName}\` 已经在 ${otherEntry} 上`);
    } else {
      const verdict = verifyGuideRemoval({ runtime: world, registry: [], read });
      const hit = verdict.reds.find((red) => red.code === GATE_CODES.STILL_EXPORTED && red.name === firstName);
      expect(
        verdict.status === 1 && Boolean(hit) && hit.entries.includes(otherEntry) && verdict.notes.some((n) => n.includes("入口列写法不认识")),
        `⑫ 入口列写不认识的值 ⇒ 两个入口都查：在 ${otherEntry} 上出现即红（不猜一个入口）`,
        `⑫ 入口未知没按预期：status=${verdict.status}，红=${verdict.reds.map((r) => `${r.code}:${r.name}`).join(",") || "无"}`,
      );
    }
  }

  // ── 例⑬ 运行时面缺入口 ⇒ exit 2（读不出不等于绿）──
  {
    const verdict = verifyGuideRemoval({ runtime: { root: [] }, registry: [] });
    expect(
      verdict.status === 2 && verdict.errors.some((err) => err.code === GATE_CODES.RUNTIME_SURFACE_MISSING),
      "⑬ 运行时面缺 `tools` ⇒ exit 2 + RUNTIME_SURFACE_MISSING（缺一个入口不等于那个入口没有导出）",
      `⑬ 运行时面缺入口没按预期：status=${verdict.status}，错误=${verdict.errors.map((e) => e.code).join(",") || "无"}`,
    );
  }

  // ── 例⑭ 登记表形状坏掉 / 重名 ⇒ 红（不许静默）──
  {
    const malformed = evaluateGuideRemoval({ claims, runtime: stillThere, registry: /** @type {any} */ ({}) });
    const duplicated = evaluateGuideRemoval({
      claims,
      runtime: stillThere,
      registry: [...KNOWN_NOT_REMOVED, { name: KNOWN_NOT_REMOVED[0].name, why: "self-test: 故意重复" }],
    });
    expect(
      malformed.reds.some((red) => red.code === GATE_CODES.REGISTRY_MALFORMED)
        && duplicated.reds.some((red) => red.code === GATE_CODES.REGISTRY_DUPLICATE),
      "⑭ 登记表不是数组 ⇒ 红 REGISTRY_MALFORMED；同一个名字登记两次 ⇒ 红 REGISTRY_DUPLICATE",
      `⑭ 登记表形状没按预期：malformed=${malformed.reds.map((r) => r.code).join(",") || "无"}，`
        + `duplicated=${duplicated.reds.map((r) => r.code).join(",") || "无"}`,
    );
  }

  // ── 例⑮ 名集真的会随指南文本变（不是写死名单）：中英两份各删掉同一行 ⇒ 名集少一个 ──
  {
    const rowRe = new RegExp(`^\\|\\s*\`${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`\\s*\\|`);
    const dropRow = (text) => {
      const lines = text.split("\n");
      const kept = lines.filter((line) => !rowRe.test(line));
      return kept.length === lines.length ? null : kept.join("\n");
    };
    const texts = {};
    for (const rel of BUNDLE_GUIDE_DOCS) texts[rel] = dropRow(readFileText(rel));
    const missed = BUNDLE_GUIDE_DOCS.filter((rel) => texts[rel] === null);
    if (missed.length) {
      failures.push(`⑮ 变异没落上——${missed.join(" / ")} 里找不到 \`${firstName}\` 那一行，删行这一枪打空了`);
    } else {
      const after = readRemovalClaims({ read: fixtureReader(/** @type {Record<string, string>} */ (texts)) });
      expect(
        after.claims.size === claims.size - 1 && !after.claims.has(firstName),
        `⑮ 名集是读出来的：中英两份各删掉 \`${firstName}\` 那一行 ⇒ 名集 ${claims.size} → ${after.claims.size}`,
        `⑮ 名集不是读出来的：删行后 ${after.claims.size} 个（期望 ${claims.size - 1}），`
          + `\`${firstName}\` 仍在=${after.claims.has(firstName)}`,
      );
      // 只删一份 ⇒ 名集不变（「任一份声明即算声明」），这也是删一份不算改的那条口径。
      const onlyEn = { .../** @type {Record<string, string>} */ (texts) };
      onlyEn[BUNDLE_GUIDE_DOCS[1]] = readFileText(BUNDLE_GUIDE_DOCS[1]);
      const half = readRemovalClaims({ read: fixtureReader(onlyEn) });
      expect(
        half.claims.size === claims.size && half.claims.has(firstName),
        `⑮b 只删一份（EN 删、CN 留）⇒ 名集不变（${half.claims.size} 个）：任一份声明即算声明`,
        `⑮b 只删一份后名集变成了 ${half.claims.size} 个（期望 ${claims.size}）——「任一份声明即算声明」被打破了`,
      );
    }
  }

  if (failures.length) {
    console.log("");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log(`\nguide-removal-gate --self-test: 失败 — ${failures.length} 处未达预期（共 ${passed.length + failures.length} 条判据）`);
    return 1;
  }
  for (const ok of passed) console.log(`  ✓ ${ok}`);
  console.log(`\nguide-removal-gate --self-test: OK — ${passed.length} 条判据全部按预期（合成夹具 + 真指南只读，不写盘）`);
  return 0;
}

/** 真指南文本（自测例⑮ 要用它做「删一行」的变异源；只读，不写）。 */
function readFileText(rel) {
  return readFileSync(join(DEFAULT_ROOT, rel), "utf8");
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const opts = { selfTest: false, runtime: null, json: false, root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--runtime") { opts.runtime = argv[i + 1] ?? null; i += 1; }
    else if (arg.startsWith("--runtime=")) opts.runtime = arg.slice("--runtime=".length);
    else if (arg === "--root") { opts.root = resolve(argv[i + 1] ?? ""); i += 1; }
    else if (arg.startsWith("--root=")) opts.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`guide-removal-gate: 不认识的参数 ${JSON.stringify(arg)}（支持 --runtime <file> / --json / --root <dir> / --self-test / --help）`);
      return { error: true };
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) return 2;
  if (opts.help) {
    console.log("用法：node scripts/guide-removal-gate.mjs [--runtime <导出面 JSON>] [--json] [--root <dir>] [--self-test]");
    console.log("  --runtime  装好的包导出的 `{ root: [...], tools: [...] }`；不给就 exit 2（本闸没有真值就不许绿）");
    return 0;
  }
  if (opts.selfTest) return runSelfTest();

  if (!opts.runtime) {
    console.error("guide-removal-gate: 读不出真值（RUNTIME_SURFACE_MISSING）——运行时导出面由 `npm run check:release` 的"
      + "装包探针产出；单独跑请用 `--runtime <file>`。没有真值就不许绿，所以这里 exit 2。");
    return 2;
  }

  let runtime;
  try {
    runtime = JSON.parse(readFileSync(resolve(opts.runtime), "utf8"));
  } catch (err) {
    console.error(`guide-removal-gate: 读不出运行时导出面（RUNTIME_SURFACE_MISSING）：${/** @type {Error} */ (err).message}`);
    return 2;
  }

  const result = verifyGuideRemoval({ root: opts.root, runtime });
  if (opts.json) {
    console.log(JSON.stringify({
      status: result.status,
      claims: [...result.claims.values()],
      errors: result.errors,
      reds: result.reds,
      known: result.known,
      notes: result.notes,
    }, null, 2));
    return result.status;
  }
  for (const note of result.notes) console.log(`  · ${note}`);
  for (const error of result.errors) console.error(`  ✗ [${error.code}] ${error.message}`);
  for (const red of result.reds) console.error(`  ✗ ${formatRed(red)}`);
  if (result.status === 0) {
    console.log(`guide-removal-gate: OK — 名集 ${result.claims.size} 个名字全部不在运行时导出面上；`
      + `已知未删除 ${result.known.length} 条（N=${result.known.length}）`);
  } else if (result.status === 2) {
    console.error(`guide-removal-gate: 读不出真值（${result.errors.map((e) => e.code).join(",") || "unknown"}）——读不出永远不等于绿`);
  } else {
    console.error(`guide-removal-gate: 红 ${result.reds.length} 处（见上）`);
  }
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  process.exitCode = main();
}
