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
 * @param {{ messages?: unknown, roundRange?: unknown, recoveryHint?: unknown }} [input]
 * @returns {string}
 */
export function foldSummaryFingerprint(input = {}) {
  return stableFingerprint({
    messages: input?.messages ?? [],
    roundRange: input?.roundRange ?? null,
    recoveryHint: input?.recoveryHint ?? null,
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

/**
 * 归一化「折叠替代物」投影（issue #470-A/B）——**纯函数，不调模型**。
 *
 * 文本由调用方给出（本次折叠**实际喂给模型**的那份摘要；策略没往消息流里 prepend 东西时，
 * 用策略带出的机械文本，如 `sliding-window` 的 `foldedSummaryText`）。本函数只做三件事：
 * 字段归一、按字节上限夹断、尺寸记账（`bytes`/`bytesBefore`/`truncated`）。
 *
 * @param {{
 *   text?: unknown,
 *   source?: unknown,
 *   strategy?: unknown,
 *   roundRange?: { from?: unknown, to?: unknown }|null,
 *   rounds?: unknown,
 *   degradeReason?: unknown,
 *   fingerprint?: unknown,
 *   maxBytes?: number,
 * }} [input]
 * @returns {{
 *   text: string, source: string, strategy: string, bytes: number,
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
  const marker = "\n[替代物已按字节上限夹断]";
  let text = raw;
  let truncated = false;
  if (bytesOf(text) > maxBytes) {
    // 二分找「前缀 + 夹断标记」还能装下的最长前缀（口径同 fold-llm 的整体截断）。
    const characters = Array.from(text);
    let low = 0;
    let high = characters.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = `${characters.slice(0, middle).join("")}${marker}`;
      if (bytesOf(candidate) <= maxBytes) {
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
  return {
    text,
    source: typeof input.source === "string" && input.source !== ""
      ? input.source
      : "strategy",
    strategy: typeof input.strategy === "string" && input.strategy !== ""
      ? input.strategy
      : "unknown",
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    bytes: bytesOf(text),
    ...(truncated ? { truncated: true, bytesBefore: bytesOf(raw) } : {}),
    ...(degradeReason !== "" ? { degradeReason: degradeReason.slice(0, 120) } : {}),
    ...(fingerprint !== "" ? { fingerprint } : {}),
  };
}
