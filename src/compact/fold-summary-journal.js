// @ts-check
// issue #326（wo-C）：**实际喂给模型的折叠摘要 = 账本里的一条事实，且复用不重算**。
//
// 为什么存在：`fold-llm` 的摘要在 `compactBeforeRound` 里现算现用——它进了当次真实请求（模型看见了），
// 却**不进任何一条 transcript 记录**：轮记录只写 `messages.slice(roundStart)`，而 `roundStart` 取的是
// 折叠**之后**的 `messages.length`（`orchestrator.js` 圈顶），摘要消息永远落在 `roundStart` 之前。
// 探针实测（`scripts/probe-361021-wo-c-compaction-facts.mjs`，基线 `a3689a2`）：run1 摘要 2 次、
// journal 0 条；resume 又调 3 次并拿到**另一份**摘要（V2/V3）。每轮现算同时毁掉 cache 命中与可解释性。
//
// 本模块只做两件事，**不改任何折叠/降级生成策略**：
//   1. `foldSummaryFingerprint` —— 给「这次折叠喂给摘要器的输入」一个稳定身份（被折叠负载 + 轮区间），
//      于是「同一个折叠结果」在进程内与跨进程都可判定，复用有据可依；
//   2. `createFoldSummaryLedger` —— 引擎侧的复用账本：`remember` 记账、`lookup` 命中即复用、
//      `seedFromRecord` 在 resume 时把**已入账那份**灌回账本（这就是「不再重算」的实现点）。
//
// 指纹口径与 `src/store/transcript-dedup.js#payloadFingerprint` 同源（规范化 JSON：对象排序键、数组保序、
// `undefined`/函数丢弃、非有限数记 `null`），但这里是**引擎侧的复用键**，不是 store 的幂等判据——
// 两者判据不同（那个排除 `round`/`ts`，这个必须包含轮区间），故各自独立，不得互相「复用」掉语义。

import { createHash } from "node:crypto";

// issue #565：`toolCalls` 与 `text` 里的清单节**同源**——解析器与形状上界都从 #564 的实现里复用，
// 不在这里另写一份（另写一份 = 两处逻辑各自腐烂，判据「逐条一致」就只能靠运气）。
import {
  MAX_TOOL_INVENTORY_CHARS,
  MAX_TOOL_INVENTORY_ENTRIES,
  parseInventorySection,
} from "./fold-statistical.js";

/** 摘要器输入里参与复用键的字段（顺序即语义，写在这里便于文档引用）。 */
export const FOLD_SUMMARY_KEY_FIELDS = Object.freeze(["messages", "roundRange", "recoveryHint"]);

/** 轮记录上承载折叠摘要事实的字段名（不新增 record kind、不新增消息标记字段）。 */
export const FOLD_SUMMARY_RECORD_FIELD = "foldedSummary";

/** 轮记录上承载 TTL 降级事实的字段名（同上）。 */
export const TTL_DEGRADATION_RECORD_FIELD = "ttlDegradations";

/**
 * 轮记录上承载**折叠替代物投影**的字段名（issue #470-A）。
 *
 * 与 `foldedSummary` 的分工：那条是**引擎事实行**（`messages: []`，只在「首次喂出去」时记一次）；
 * `foldedFacts` 挂在**发生折叠的那一轮的轮记录**上，宿主与 judge 读轮记录就能看见「被折掉的早期
 * 历史长什么样」，不必再去翻事实行、或为一个占位字面量自建 `hasSummary`（erix-station #390）。
 * 它是纯加法：`record.summary`（本轮自身摘要）的语义一字未动。
 */
export const FOLDED_FACTS_RECORD_FIELD = "foldedFacts";

/**
 * 替代物投影的字节上界（issue #470-B）。
 * 机械文本本身有界（锚点索引带 `maxPerKind`/`maxChars`），这里再夹一刀，
 * 防 #460 那条 O(n) 在摘要面复发（与 #335 重复存储同族）。
 */
export const FOLDED_FACTS_MAX_BYTES = 2048;

/** @param {any} value @param {WeakSet<object>} seen @returns {string} */
function canonicalJson(value, seen) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value) ? String(value) : "null";
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return JSON.stringify(value);
  if (type === "bigint") return `${value.toString()}n`;
  if (type === "undefined" || type === "function" || type === "symbol") return "null";
  if (typeof value !== "object") return "null";
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return `[${items.join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`);
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

/** 稳定指纹（`sha256:<24 hex>`），口径见文件头注释。 */
export function stableFingerprint(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value, new WeakSet()), "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * 折叠摘要的复用键：由**喂给摘要器的输入**决定，不由轮号决定。
 *
 * @param {{ messages?: unknown, roundRange?: unknown, recoveryHint?: unknown, priorSummary?: unknown }} [input]
 * @returns {string}
 */
export function foldSummaryFingerprint(input = {}) {
  return stableFingerprint({
    messages: input?.messages ?? [],
    roundRange: input?.roundRange ?? null,
    recoveryHint: input?.recoveryHint ?? null,
    // issue #469（裁决 A 实施条件 4）：续写基底必须进键。否则 resume 第一折若命中 #326
    // 播进来的账本，**播进去的基底会被无声忽略**——A 的效果在最需要它的那一次折叠上归零。
    // 代价是既有账本（用旧键算的）在升级后首次跑会 miss 一次，重算一份摘要。
    priorSummary: typeof input?.priorSummary === "string" && input.priorSummary !== ""
      ? input.priorSummary
      : null,
  });
}

/**
 * 从一条 transcript 记录里读出已入账的折叠摘要事实（无则 undefined）。
 * @param {any} record
 * @returns {{ text: string, fingerprint: string, strategy?: string }|undefined}
 */
export function readFoldSummaryFact(record) {
  const fact = record?.[FOLD_SUMMARY_RECORD_FIELD];
  if (fact === null || typeof fact !== "object") return undefined;
  if (typeof fact.fingerprint !== "string" || fact.fingerprint === "") return undefined;
  // ⚠ 复用读的是 `summary`（引擎摘要器原文，即策略内部拿到的那份），不是 `text`（那份已经过了
  // enforce-size 与机械保真节）——把 `text` 当成摘要器返回值会**二次**追加保真节，折叠输出会
  // 一轮比一轮长。`text` 是给宿主/审计读的，`summary` 是给引擎复用读的。
  const reusable = typeof fact.summary === "string" && fact.summary !== ""
    ? fact.summary
    : typeof fact.text === "string" && fact.text !== ""
      ? fact.text
      : undefined;
  if (reusable === undefined) return undefined;
  return typeof fact.strategy === "string"
    ? { text: reusable, fingerprint: fact.fingerprint, strategy: fact.strategy }
    : { text: reusable, fingerprint: fact.fingerprint };
}

/**
 * 引擎侧的折叠摘要账本：键 = `foldSummaryFingerprint`，值 = 已喂出去的那份摘要正文。
 *
 * - `remember`：本次真的调了摘要器 ⇒ 记账（后续同指纹直接复用）。
 * - `lookup`：命中即复用（**不再调摘要器**）。
 * - `seedFromRecord` / `seedFromRecords`：resume 时把已入账的事实灌回来 ⇒ 「恢复不得重算」。
 *
 * @returns {{
 *   lookup: (fingerprint:string) => string|undefined,
 *   remember: (fingerprint:string, text:string) => void,
 *   journaled: (fingerprint:string) => boolean,
 *   markJournaled: (fingerprint:string) => void,
 *   seedFromRecord: (record:any) => boolean,
 *   seedFromRecords: (records:any[]) => number,
 *   size: () => number,
 *   fingerprints: () => string[]
 * }}
 */
export function createFoldSummaryLedger() {
  /** @type {Map<string, string>} */
  const summaries = new Map();
  /** @type {Set<string>} */
  const journaled = new Set();
  const remember = (fingerprint, text) => {
    if (typeof fingerprint !== "string" || fingerprint === "") return;
    if (typeof text !== "string" || text === "") return;
    summaries.set(fingerprint, text);
  };
  const seedFromRecord = (record) => {
    const fact = readFoldSummaryFact(record);
    if (fact === undefined) return false;
    // 已入账 ⇒ 两件事同时成立：这份摘要**可复用**（不再调摘要器），且**已落账**（不得再记一行）。
    journaled.add(fact.fingerprint);
    if (summaries.has(fact.fingerprint)) return false;
    summaries.set(fact.fingerprint, fact.text);
    return true;
  };
  return {
    lookup: (fingerprint) => summaries.get(fingerprint),
    remember,
    journaled: (fingerprint) => journaled.has(fingerprint),
    markJournaled: (fingerprint) => {
      if (typeof fingerprint === "string" && fingerprint !== "") journaled.add(fingerprint);
    },
    seedFromRecord,
    seedFromRecords: (records) => {
      const list = Array.isArray(records) ? records : [];
      let seeded = 0;
      for (const record of list) {
        if (seedFromRecord(record)) seeded += 1;
      }
      return seeded;
    },
    size: () => summaries.size,
    fingerprints: () => [...summaries.keys()],
  };
}

const foldedFactsEncoder = new TextEncoder();

/** 夹断标记：`text` 被前缀夹断时追加在尾部（既有形状，语义一字未动）。 */
const FOLDED_FACTS_TRUNCATION_MARKER = "\n[替代物已按字节上限夹断]";

/** `text` 在预算里至少保留的字节数（= 夹断标记 + 1）：「被夹断」这件事必须永远写得下。 */
const MIN_FACTS_TEXT_BYTES = foldedFactsEncoder.encode(FOLDED_FACTS_TRUNCATION_MARKER).length + 1;

/**
 * `title` 的字符上界（issue #565）。
 *
 * 为什么是**字符**而不是字节：它是给宿主渲染一行索引用的展示字段，字符数才是「一行放得下」的口径。
 * 它没有自己的字节预算 —— 见 `buildFoldedFacts` 里「title 是 text 的首行」那段：
 * title 的字节**本来就花在 text 的预算里**，所以这里不需要第二个旋钮。
 */
export const FOLDED_FACTS_TITLE_MAX_CHARS = 60;

/**
 * `origin` 的闭集（issue #565）：这段文本**是谁写的**。
 *
 * 与既有的 `source` **正交**，两者不是一件事：
 *   · `source` 说的是「文本来自**策略**还是**摘要器**」（`statistical` / `strategy` / `llm`）；
 *   · `origin` 说的是「**写者**是机械、语义还是宿主」（`mechanical` / `semantic` / `host`）。
 * 例：`fold-llm` 摘要器失败降级时 `source: "statistical"`、`origin: "mechanical"`——文本确实是策略侧
 * 的机械兜底，不是模型写的。宿主能凭 `origin` 判断「能不能把这行当语义索引用」，不必去猜 `source`。
 */
export const FOLDED_FACT_ORIGINS = Object.freeze(["mechanical", "semantic", "host"]);

/**
 * `source` → `origin` 的映射（`source` 的既有取值一字未改，这里只是读它）。
 *
 * 口径：
 *   · `statistical` / `strategy` —— 零 LLM 的机械替代物（`fold-statistical`、`sliding-window`、
 *     以及 `fold-llm` 的降级兜底）⇒ `mechanical`；
 *   · `llm` —— 摘要器真的写了正文 ⇒ `semantic`；
 *   · `host` —— 宿主自带策略注入的正文 ⇒ `host`；
 *   · **其余未知来源一律 `host`**：引擎只对自己产出的文本自报 `mechanical` / `semantic`，
 *     来源不明时**不得冒充引擎产物**（宁可少认，不可多认）。
 */
const ORIGIN_BY_SOURCE = Object.freeze({
  statistical: "mechanical",
  strategy: "mechanical",
  llm: "semantic",
  host: "host",
});

/**
 * 解析本条投影的 `origin`：显式给了合法值就用它，否则按 `source` 派生（见 `ORIGIN_BY_SOURCE`）。
 *
 * @param {{ origin?: unknown, source?: unknown }} input
 * @returns {"mechanical"|"semantic"|"host"}
 */
function resolveFactsOrigin(input) {
  const explicit = typeof input?.origin === "string" ? input.origin : "";
  if (FOLDED_FACT_ORIGINS.includes(explicit)) {
    return /** @type {"mechanical"|"semantic"|"host"} */ (explicit);
  }
  const source = typeof input?.source === "string" && input.source !== "" ? input.source : "strategy";
  return /** @type {"mechanical"|"semantic"|"host"} */ (ORIGIN_BY_SOURCE[source] ?? "host");
}

/**
 * `title` = 正文的**首行**（夹到 `FOLDED_FACTS_TITLE_MAX_CHARS` 字符，不加省略号）。
 *
 * 刻意不加 `…`：`title` 必须是 `text` 的**严格前缀**，省略号会把第 60 个字符换掉、
 * 于是「title 在夹断后仍存活」就退化成「看起来像」，而判据要的是结构性成立。
 *
 * @param {string} text
 * @returns {string}
 */
function foldedFactsTitle(text) {
  const firstLine = String(text ?? "").split("\n", 1)[0].trim();
  const characters = Array.from(firstLine);
  return characters.length <= FOLDED_FACTS_TITLE_MAX_CHARS
    ? firstLine
    : characters.slice(0, FOLDED_FACTS_TITLE_MAX_CHARS).join("");
}

/**
 * 把 `text` 里的**清单节**投影成结构化的 `toolCalls`（issue #565）。
 *
 * 同源，不是第二份实现：解析器就是 #564 落 `formatFoldSummary` 时用的那一个
 * （`parseInventorySection`，从 `fold-statistical.js` 导出后复用），喂进去的也是**同一份 `text`**
 * ⇒ `toolCalls` 与 `text` 里那节逐条相等是**按构造成立**的，不靠两处逻辑同步。
 *
 * 形状上界沿用 #564 已定的常量（≤8 条 × ≤80 字符），不新开预算：清单节本来就排在区间行之后，
 * 字节夹断削的是尾部 ⇒ 它不会因为夹断而与 `text` 脱节（夹断后的残行仍逐字相等）。
 *
 * @param {string} text
 * @returns {{ name: string, argsSummary: string }[]}
 */
function foldedFactsToolCalls(text) {
  const entries = parseInventorySection(text).slice(0, MAX_TOOL_INVENTORY_ENTRIES);
  return entries.map((entry) => {
    // 条目由 `summarizeToolCall` 造：`"<工具名> <关键入参>"`（无入参时只有工具名）。
    const spaceIndex = entry.indexOf(" ");
    if (spaceIndex < 0) return { name: entry, argsSummary: "" };
    return {
      name: entry.slice(0, spaceIndex),
      argsSummary: entry.slice(spaceIndex + 1).slice(0, MAX_TOOL_INVENTORY_CHARS),
    };
  });
}

/**
 * 归一化「折叠替代物」投影（issue #470-A/B；issue #565 加结构化键）——**纯函数，不调模型**。
 *
 * 文本由调用方给出（本次折叠**实际喂给模型**的那份摘要；策略没往消息流里 prepend 东西时，
 * 用策略带出的机械文本，如 `sliding-window` 的 `foldedSummaryText`）。本函数做四件事：
 * 字段归一、按字节上限夹断、尺寸记账（`bytes`/`bytesBefore`/`truncated`）、
 * 给宿主补可判断的结构化键（`title` / `origin` / 可选 `summary` / 可选 `toolCalls`）。
 *
 * #565 的三条形状决定（PR 描述里同样写明）：
 *   ① **`title` 走「作为 `text` 首行」这条路**（工单给的合法做法 a），不是「独立成键 + 预算预留」（b）。
 *      于是 `title` 的字节本来就花在 `text` 的 `maxBytes` 里：**不新开预算**，也就不存在「独立成键却
 *      不受预算约束」那种隐形预算。前缀夹断削的是尾部 ⇒ `title` 在夹断后按构造仍在（`text` 以它开头）。
 *      前提是预算装得下这一行：默认 2048 恒成立（`title` ≤ 60 字符）；`maxBytes` 小到装不下一行时属
 *      退化预算，此时 `title` 仍如实给出原文首行，但「`text` 以它开头」这一条在那里不成立——判据 3
 *      的断言（>2048 字节夹断后 title 仍在）正是钉在默认预算上的。
 *      （不选 b 的第二个理由：b 会让 `bytes` 从「正文字节数」变成「正文 + title 总量」，那是既有键的
 *      语义变更；本单要求既有键逐字不变，既有用例也钉着 `bytes === bytesOf(text)`。）
 *   ② `summary` 是**可选**键，且只有 `origin === "semantic"` 才允许出现；它与 `text` **共用同一个
 *      `maxBytes` 预算**（整份放不下就不写这个可选键：不截断、不越界、不另立预算）。机械路径给了也
 *      丢弃——机械产物不许冒充语义。
 *   ③ `toolCalls` 是对 `text` 里**清单节**的结构化投影：解析器与形状上界都复用 #564 的实现，
 *      喂进去的是同一份 `text` ⇒ 「与清单节逐条一致」按构造成立，不靠两处逻辑同步。
 *
 * @param {{
 *   text?: unknown,
 *   source?: unknown,
 *   strategy?: unknown,
 *   origin?: unknown,
 *   summary?: unknown,
 *   roundRange?: { from?: unknown, to?: unknown }|null,
 *   rounds?: unknown,
 *   degradeReason?: unknown,
 *   fingerprint?: unknown,
 *   maxBytes?: number,
 * }} [input]
 * @returns {{
 *   text: string, title: string, origin: "mechanical"|"semantic"|"host",
 *   summary?: string, toolCalls?: { name: string, argsSummary: string }[],
 *   source: string, strategy: string, bytes: number,
 *   from?: number, to?: number, rounds?: number,
 *   truncated?: boolean, bytesBefore?: number,
 *   degradeReason?: string, fingerprint?: string
 * }|undefined} 没有可投影的文本 ⇒ `undefined`（调用方据此**不写该键**，而不是写占位字面量）
 */
export function buildFoldedFacts(input = {}) {
  const raw = typeof input.text === "string" ? input.text.trim() : "";
  if (raw === "") return undefined;
  const maxBytes = Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0
    ? input.maxBytes
    : FOLDED_FACTS_MAX_BYTES;
  const bytesOf = (value) => foldedFactsEncoder.encode(value).length;
  const origin = resolveFactsOrigin(input);
  // `title` 从**原始正文**取（不是从夹断后的结果取）：这样「首行」是**输入的性质**，不是夹断的副产物。
  // 夹断只削尾部 ⇒ 首行按构造还在 ⇒ `title` 结构性存活，不靠运气、也不需要第二份预算。
  const title = foldedFactsTitle(raw);
  // `summary` 与 `text` 共用一个预算：语义摘要先占，剩下的留给正文；整份放不下就不写这个可选键
  //（不截断、不越界、不另立预算——机械路径给的 `summary` 在这里就被丢掉，它不许冒充语义）。
  const summaryCandidate = origin === "semantic" && typeof input.summary === "string"
    ? input.summary.trim()
    : "";
  const summary = summaryCandidate !== "" && bytesOf(summaryCandidate) <= maxBytes - MIN_FACTS_TEXT_BYTES
    ? summaryCandidate
    : "";
  const textBudget = maxBytes - bytesOf(summary);
  const marker = FOLDED_FACTS_TRUNCATION_MARKER;
  let text = raw;
  let truncated = false;
  if (bytesOf(text) > textBudget) {
    // 二分找「前缀 + 夹断标记」还能装下的最长前缀（口径同 fold-llm 的整体截断）。
    const characters = Array.from(text);
    let low = 0;
    let high = characters.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = `${characters.slice(0, middle).join("")}${marker}`;
      if (bytesOf(candidate) <= textBudget) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    text = best === "" ? marker.trim() : best;
    truncated = true;
  }
  const range = input.roundRange ?? undefined;
  // `Number.isSafeInteger` 不是类型谓词，tsc 不会因此收窄；这里显式收口成 `number` 局部。
  // 不这么做的话下面三个可选键会带着 `unknown` 去撞 `FoldedFact` 的声明（types:build 直接红，
  // 而 `--checkJs` 棘轮清单不含这两个文件 —— 只有 prepack 那条路拦得住，见 #470 闭环）。
  const from = Number.isSafeInteger(range?.from) ? /** @type {number} */ (range?.from) : undefined;
  const to = Number.isSafeInteger(range?.to) ? /** @type {number} */ (range?.to) : undefined;
  const rounds = Number.isSafeInteger(input.rounds) && /** @type {number} */ (input.rounds) > 0
    ? /** @type {number} */ (input.rounds)
    : undefined;
  const fingerprint = typeof input.fingerprint === "string" ? input.fingerprint : "";
  const degradeReason = typeof input.degradeReason === "string" ? input.degradeReason : "";
  const toolCalls = foldedFactsToolCalls(text);
  return {
    text,
    // issue #565：给宿主的三键（纯加法）。`title` 是 `text` 的首行 ⇒ 夹断削尾也削不掉它；
    // `origin` 必填（判据不是注释）；`toolCalls` 与 `text` 的清单节同源（同一份 `text` + 同一个解析器）。
    title,
    origin,
    ...(summary !== "" ? { summary } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    source: typeof input.source === "string" && input.source !== ""
      ? input.source
      : "strategy",
    strategy: typeof input.strategy === "string" && input.strategy !== ""
      ? input.strategy
      : "unknown",
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    // `bytes` 是**投影正文**的字节数：`summary` 缺席时逐字节等于旧口径（既有用例原样绿）；
    // 在场时是 `text + summary` 的总量（两者共用同一个预算，谁都不在预算外）。
    bytes: bytesOf(text) + bytesOf(summary),
    ...(truncated ? { truncated: true, bytesBefore: bytesOf(raw) } : {}),
    ...(degradeReason !== "" ? { degradeReason: degradeReason.slice(0, 120) } : {}),
    ...(fingerprint !== "" ? { fingerprint } : {}),
  };
}
