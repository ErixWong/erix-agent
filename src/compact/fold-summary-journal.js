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
// `FOLD_SUMMARY_MARKER` 同样从那边取：`title` 要剥掉的正是**引擎自己写进去的**那个 marker，
// 用常量而不是字面量 ⇒ marker 换代时这里跟着换代，不会留下一份过时的拷贝。
import {
  FOLD_SUMMARY_MARKER,
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
 * `foldedFacts` 里承载**本折自己那一份**的子键名（issue #566）。
 *
 * 与父键的分工（这是本单的全部要点）：
 *   · `foldedFacts.text` —— **截至本折的累计替代物**（今天宿主横幅/契约读的就是它），语义**一字未改**；
 *   · `foldedFacts.increment` —— **本折自己删掉的那一段**的替代物（合并前那一份），append-only。
 *
 * 为什么必须另开键而不是改 `text`：连续 N 折之后 `text` 是 N 份累计快照，第 k 折的增量只能靠
 * diff 相邻两份快照还原；其中任意一份被 `FOLDED_FACTS_MAX_BYTES` 前缀夹断，那个增量就**永久不可还原**。
 * 增量单独成键之后，每一折都有一条不可变、可独立读取的记录（`from`/`to`/`rounds`/`text`/`title`）。
 *
 * 三条边界：① 只进账本，不进模型上下文（不参与请求组装、不占上下文预算）；
 * ② resume 的取源不变（`pickCoveringFoldSummary` 仍读 `foldedSummary` 事实行 / `foldedFacts.text`，
 * 见 `resume-fold-trim.js`）；③ 每折增量自己的字节上界 = `FOLDED_FACTS_MAX_BYTES`。
 */
export const FOLDED_FACTS_INCREMENT_KEY = "increment";

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
 * 折叠的**契约身份**（issue #567）：`foldId` 与 run 内单调的 `seq`。
 *
 * 为什么 `foldId` 就是 `foldSummaryFingerprint` 的返回值（同一个字符串），不是再哈希一层：
 *   · 宿主去重的键与引擎复用账本的键**必须是同一个身份**。两个名字、两次哈希 = 两处口径，
 *     迟早会漂（`#469` 往指纹输入里加续写基底时就会漂一次，而宿主那边不会有任何门禁报警）；
 *   · 语义也刚好对上：指纹回答的正是「这是**哪一次**折叠（同一次折叠的输入）」——
 *     重放同一次折叠得到同一个字符串，宿主据此幂等去重，不再靠时刻 / 自己从 0 数的局部计数器。
 *   · 它**不是**幂等存储（工单风险节）：宿主仍要自己保证「同 `foldId` 只落一条」；
 *     且它的稳定性边界是**同一个引擎版本**——指纹的规范化口径换代（如 #469）时旧值不再可复现。
 *
 * `seq` 由引擎给（不让宿主从 0 数）：run 作用域、严格递增、**同一个 `foldId` 重投保持首次那个号**
 * （「同一折叠投递两次 ⇒ foldId / seq 都相同」是工单判据）。于是宿主可以「`foldId` 去重 + `seq` 排序」。
 *
 * @returns {{
 *   allocate: (foldId: unknown) => number|undefined,
 *   seed: (facts: unknown[]) => number,
 *   seqOf: (foldId: string) => number|undefined,
 *   lastSeq: () => number,
 *   size: () => number,
 * }}
 */
export function createFoldIdentityAllocator() {
  /** @type {Map<string, number>} */
  const seqByFoldId = new Map();
  let lastSeq = 0;
  /**
   * 给一次折叠分配（或取回）它的 `seq`。非字符串 / 空串 ⇒ `undefined`（不占号、不改状态）——
   * 这个模块的既有纪律是「没事实就不写键」，而 `undefined` 正是调用方「不写该键」的信号。
   * @param {unknown} foldId
   * @returns {number|undefined}
   */
  const allocate = (foldId) => {
    if (typeof foldId !== "string" || foldId === "") return undefined;
    const known = seqByFoldId.get(foldId);
    if (known !== undefined) return known;
    lastSeq += 1;
    seqByFoldId.set(foldId, lastSeq);
    return lastSeq;
  };
  /**
   * resume 时按**账本顺序**（旧 → 新）把已入账的 `seq` 灌回来：
   *   · 账本里有 `seq` ⇒ 原样恢复（重放同一次折叠拿回同一个号，宿主去重不会被 resume 打穿）；
   *   · 账本里没有 `seq`（#567 之前写的记录）⇒ 按账本顺序补号（它本来就只可能是「更早的折」）；
   * 两种都让 `lastSeq` 抬到已见最大值 ⇒ 本次 run 的新折叠严格接在后面。
   * @param {unknown[]} facts
   * @returns {number} 灌入的条数
   */
  const seed = (facts) => {
    const list = Array.isArray(facts) ? facts : [];
    let seeded = 0;
    for (const fact of list) {
      if (fact === null || typeof fact !== "object") continue;
      const foldId = /** @type {any} */ (fact).foldId;
      if (typeof foldId !== "string" || foldId === "") continue;
      if (seqByFoldId.has(foldId)) continue;
      const recorded = /** @type {any} */ (fact).seq;
      const seq = Number.isSafeInteger(recorded) && recorded > 0 ? recorded : lastSeq + 1;
      lastSeq = Math.max(lastSeq, seq);
      seqByFoldId.set(foldId, seq);
      seeded += 1;
    }
    return seeded;
  };
  return {
    allocate,
    seed,
    seqOf: (foldId) => seqByFoldId.get(foldId),
    lastSeq: () => lastSeq,
    size: () => seqByFoldId.size,
  };
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
 * 按字节预算**前缀夹断**一段正文（口径与 `buildFoldedFacts` 原来那段内联实现逐字相同，issue #566 抽出来
 * 只为让「累计体」与「本折增量」共用同一把尺子：两处各写一份的话，夹断行为迟早各自腐烂）。
 *
 * 返回的 `text` 已经是**最终形态**（被夹断时尾部带 `FOLDED_FACTS_TRUNCATION_MARKER`）；
 * `bytesBefore` 只在真的夹断时给出（= 原始字节数），调用方据此写 `truncated`/`bytesBefore` 两个键。
 *
 * @param {string} raw
 * @param {number} budget 字节预算
 * @returns {{ text: string, truncated: boolean, bytesBefore: number }}
 */
function clampFactsText(raw, budget) {
  const bytesBefore = foldedFactsEncoder.encode(raw).length;
  if (bytesBefore <= budget) return { text: raw, truncated: false, bytesBefore };
  // 二分找「前缀 + 夹断标记」还能装下的最长前缀（口径同 fold-llm 的整体截断）。
  const characters = Array.from(raw);
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${FOLDED_FACTS_TRUNCATION_MARKER}`;
    if (foldedFactsEncoder.encode(candidate).length <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    text: best === "" ? FOLDED_FACTS_TRUNCATION_MARKER.trim() : best,
    truncated: true,
    bytesBefore,
  };
}

/**
 * `title` 的字符上界（issue #565）。
 *
 * 为什么是**字符**而不是字节：它是给宿主渲染一行索引用的展示字段，字符数才是「一行放得下」的口径。
 * 它没有自己的字节预算 —— 见 `buildFoldedFacts` 里「title 取自 text 的首行（剥掉引擎 marker 后）」那段：
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
 * `title` = 正文的**首行**，**先剥掉引擎自己的 marker 前缀**，再夹到
 * `FOLDED_FACTS_TITLE_MAX_CHARS` 字符（不加省略号）。
 *
 * 为什么必须剥（issue #565 修补）：`title` 的**唯一用途**是宿主渲染一行索引 —— 本方案的整个动机就是
 * 「宿主不要正则解析中文」。`FOLD_SUMMARY_MARKER` 是**版本化内部标识**（带版本号与哈希），
 * 而且机械摘要的首行是「marker + 区间行 + 足迹行」（`formatFoldSummary` 里 `lines.slice(0, 2).join("")`，
 * 两行之间没有换行），于是它一口占掉 60 字符预算的三分之一、还把内部标识漏进宿主 UI。
 * 让宿主自己去剥 marker，等于把「解析引擎内部字面量」这件事又塞回宿主 —— 那正是本方案要消灭的东西。
 * 剥的时候**只用常量**（`FOLD_SUMMARY_MARKER`），不写字面量：marker 换代时这里跟着换代。
 *
 * 为什么仍然**不加省略号**：剥掉 marker 之后 `title` 不再是 `text` 的**字面前缀**，但它仍是 `raw`
 * 头部的一个**连续子串**，而 `text` 保留的是 `raw` 的前缀 ⇒ 「夹断后 title 仍存活」依旧**按构造成立**
 * （判据断言因此是 `text.includes(title)`，不是 `startsWith`）。加省略号会把末尾字符换掉，
 * 那条结构性就退化成「看起来像」。
 *
 * 剥完为空时**退回未剥版本**（例如宿主文本的首行只有 marker）：空 `title` 会让宿主那行索引变成空白，
 * 而「非空」是这条契约的底线 —— 宁可漏一个内部标识，也不给宿主一个空字符串。
 *
 * @param {string} text
 * @returns {string}
 */
function foldedFactsTitle(text) {
  const firstLine = String(text ?? "").split("\n", 1)[0].trim();
  const stripped = firstLine.startsWith(FOLD_SUMMARY_MARKER)
    ? firstLine.slice(FOLD_SUMMARY_MARKER.length).trim()
    : firstLine;
  // 剥完为空（首行只有 marker）⇒ 退回未剥版本：不许产出空串（空 title = 宿主那行索引变空白）。
  const chosen = stripped === "" ? firstLine : stripped;
  const characters = Array.from(chosen);
  return characters.length <= FOLDED_FACTS_TITLE_MAX_CHARS
    ? chosen
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
 *   ① **`title` 走「取自 `text` 的首行」这条路**（工单给的合法做法 a），不是「独立成键 + 预算预留」（b）。
 *      于是 `title` 的字节本来就花在 `text` 的 `maxBytes` 里：**不新开预算**，也就不存在「独立成键却
 *      不受预算约束」那种隐形预算。前缀夹断削的是尾部 ⇒ `title` 在夹断后按构造仍在（它是 `raw` 头部的
 *      一个连续子串，而 `text` 保留的是 `raw` 的前缀 ⇒ `text.includes(title)`；首行里那段引擎 marker 被
 *      剥掉后它不再是**字面前缀**，但「仍在」这条件是结构性的，不是「看起来像」）。
 *      前提是预算装得下这一行：默认 2048 恒成立（`title` ≤ 60 字符）；`maxBytes` 小到装不下一行时属
 *      退化预算，此时 `title` 仍如实给出原文首行，但「`text` 里仍有它」这一条在那里不成立——判据 3
 *      的断言（>2048 字节夹断后 title 仍在）正是钉在默认预算上的。
 *      （不选 b 的第二个理由：b 会让 `bytes` 从「正文字节数」变成「正文 + title 总量」，那是既有键的
 *      语义变更；本单要求既有键逐字不变，既有用例也钉着 `bytes === bytesOf(text)`。）
 *   ② `summary` 是**可选**键，且只有 `origin === "semantic"` 才允许出现；它与 `text` **共用同一个
 *      `maxBytes` 预算**（整份放不下就不写这个可选键：不截断、不越界、不另立预算）。机械路径给了也
 *      丢弃——机械产物不许冒充语义。
 *   ③ `toolCalls` 是对 `text` 里**清单节**的结构化投影：解析器与形状上界都复用 #564 的实现，
 *      喂进去的是同一份 `text` ⇒ 「与清单节逐条一致」按构造成立，不靠两处逻辑同步。
 *
 * issue #566（`incrementText`）的第四条决定：**增量另开键，不改 `text`**。
 *   · `text` 仍是「截至本折的累计替代物」（宿主横幅/契约依赖它）——本函数一个字都没改它的含义；
 *   · `incrementText` 是**本折自己那份**（合并前的那一份，由调用方从策略的真实产物取，不从累计文本反推）；
 *   · 它用自己的 `maxBytes` 预算（**不**从父键的预算里扣），因为它的价值恰恰是「父键被夹断时它仍然完整」；
 *   · 它同样带 `title`/`origin`/`from`/`to`/`rounds`/`bytes`（口径与 #565 逐条相同，用同一个 `title` 派生器），
 *     于是「第 k 折的增量」不需要 diff 两份累计快照就能独立读出来。
 *   · 空增量（没给 / 全是空白）⇒ **不写该键**（与 A2「不写占位字面量」同口径）。
 *
 * issue #566 修复（`incrementOrigin`）：增量的正文不一定是**同一个写者**写的——`fold-llm` 的
 * `text` 是摘要器写的（`semantic`），而它的增量现在是**本折的机械替代物**（`mechanical`）。
 * `origin` 的语义就是「这段文本是谁写的」（#565），所以增量允许自带 `incrementOrigin`；
 * 不给 ⇒ 沿用父键的 `origin`（既有口径，逐字不变）。机械文本**不得**冒充语义。
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
 *   incrementText?: unknown,
 *   incrementOrigin?: unknown,
 *   foldId?: unknown,
 *   seq?: unknown,
 *   maxBytes?: number,
 * }} [input]
 * @returns {{
 *   text: string, title: string, origin: "mechanical"|"semantic"|"host",
 *   foldId?: string, seq?: number,
 *   increment?: {
 *     text: string, title: string, origin: "mechanical"|"semantic"|"host",
 *     from?: number, to?: number, rounds?: number, bytes: number,
 *     truncated?: boolean, bytesBefore?: number,
 *   },
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
  // 夹断只削尾部 ⇒ 首行（剥掉引擎 marker 后）按构造还在 ⇒ `title` 结构性存活，不靠运气、也不需要第二份预算。
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
  // issue #566：夹断逻辑抽成 `clampFactsText`，与下面「本折增量」共用同一把尺子；
  // 行为逐字不变（原来的内联二分搜索搬进去，一个参数都没改）。
  const clamped = clampFactsText(raw, textBudget);
  const text = clamped.text;
  const truncated = clamped.truncated;
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
  // issue #567：**折叠的契约身份**（两个纯加法键，见 `createFoldIdentityAllocator()` 的注释）。
  // `foldId` 由调用方给（引擎侧就是 `foldSummaryFingerprint` 的值，一个身份不是两个）；
  // `seq` 也由调用方给（run 作用域分配器）——这里只负责**不造假**：拿不到就不写键。
  const foldId = typeof input.foldId === "string" && input.foldId !== "" ? input.foldId : "";
  const seq = Number.isSafeInteger(input.seq) && /** @type {number} */ (input.seq) > 0
    ? /** @type {number} */ (input.seq)
    : undefined;
  const degradeReason = typeof input.degradeReason === "string" ? input.degradeReason : "";
  const toolCalls = foldedFactsToolCalls(text);
  // issue #566：**本折自己那份**替代物（合并前那一份，不是累计体）。
  // 独立预算（与父键同一个 `maxBytes`，但**不**从父键的预算里扣）：它是一条独立记录，
  // 被父键的累计体撑爆时它必须仍然完整可读 —— 这正是本单要买的东西。
  const incrementRaw = typeof input.incrementText === "string" ? input.incrementText.trim() : "";
  const incrementClamped = incrementRaw === "" ? undefined : clampFactsText(incrementRaw, maxBytes);
  // 增量可以来自**另一个写者**（`fold-llm`：父键是摘要器写的，增量是机械替代物）⇒ 允许自带 origin；
  // 不给就沿用父键的（既有口径，逐字不变）。
  const incrementOrigin = resolveFactsOrigin(
    typeof input.incrementOrigin === "string"
      ? { origin: input.incrementOrigin, source: input.source }
      : input,
  );
  const increment = incrementClamped === undefined
    ? undefined
    : {
      text: incrementClamped.text,
      // 与 #565 同口径：title 从**原始正文**取（夹断只削尾部 ⇒ 首行按构造仍在），剥掉引擎 marker。
      title: foldedFactsTitle(incrementRaw),
      origin: incrementOrigin,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(rounds !== undefined ? { rounds } : {}),
      bytes: bytesOf(incrementClamped.text),
      ...(incrementClamped.truncated
        ? { truncated: true, bytesBefore: incrementClamped.bytesBefore }
        : {}),
    };
  return {
    text,
    // issue #565：给宿主的三键（纯加法）。`title` 取自 `text` 的首行（剥掉引擎 marker）⇒ 夹断削尾也削不掉它；
    // `origin` 必填（判据不是注释）；`toolCalls` 与 `text` 的清单节同源（同一份 `text` + 同一个解析器）。
    title,
    origin,
    ...(increment === undefined ? {} : { [FOLDED_FACTS_INCREMENT_KEY]: increment }),
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
    ...(truncated ? { truncated: true, bytesBefore: clamped.bytesBefore } : {}),
    ...(degradeReason !== "" ? { degradeReason: degradeReason.slice(0, 120) } : {}),
    ...(fingerprint !== "" ? { fingerprint } : {}),
    ...(foldId !== "" ? { foldId } : {}),
    ...(seq === undefined ? {} : { seq }),
  };
}
