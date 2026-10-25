// @ts-check
// issue #462：折叠水位线 `foldedThrough` 的**读侧**。#460 只修了写侧（归档改成有界差分），
// 而 resume 至今从不按水位线裁正文 —— `restoreResume()` 把整段账本折成上下文
// （`src/loop/resume-manager.js` 的 `ctx.messages = ledgerMessages`），于是续跑的第一次折叠
// **每次都是从 round 1 重折**：真机探针（`scripts/probe-462-resume-refold.mjs`，fake provider，
// budget 4000，16 轮、每 2 轮 resume 一次）实测
//   · 喂进 compact 的消息数 8→11→16→21→26→31→36（线性），折走区间恒为 `{from:1,…}`，
//     `foldedRounds` 7→10→13→16→19（那时只新增了 2 轮）；
//   · `fold-llm` 的摘要器因此**每次续跑都要重算**（重折的 `roundRange` 在变 ⇒
//     `foldSummaryFingerprint` 必 miss ⇒ #326 的「复用不重算」跨 resume 完全不生效）：
//     同样 16 轮，连续跑摘要 0 次 / 0 字节，续跑摘要 7 次 / 累计输入 210 645 B / 单次最大 58 348 B；
//   · 且 `estimatedTokens / budgetTokens > 2`（`orchestrator.js` 的 keepRounds 收紧）必然命中
//     ⇒ `keepRounds` 被压到 2 ⇒ 续跑比连续跑多砍一倍历史轮次（实测 foldedRounds 6 vs 3）。
//
// 本模块把「水位线以下的正文」从续跑上下文里裁掉，并把**模型本来就在看的那份摘要**
// （#326 落的 `record.foldedSummary` 事实行）回填到原位置 —— 于是续跑的上下文形状
// 回到崩溃前那一刻，上面四条一起消失。
//
// 三条口径边界（都是刻意的，别在后续改动里磨掉）：
//   ① **只在能回填摘要时才裁**。裁掉的正文必须由等价的信息补回去，否则就是静默丢历史；
//      挑不出可用的 `foldedSummary` 事实（老账本 / 摘要不可用）⇒ 原样返回，行为与今天逐字一致。
//      这条同时是 #462 判据 3 的落点：「区间被误判成未折」时正文必须在上下文里**可见**，
//      不允许档案与上下文两边都静默。
//   ② 水位线**只从轮行**推（`record.foldedRoundRange.to`，见 `resume-manager.js`），事实行不放
//      顶层 `foldedRoundRange`（`test/loop-persist-compaction-facts.test.js` 钉着：放顶层会把同一
//      区间数两遍）。所以本模块**消费**水位线，不参与推导它。
//   ③ 回填位置沿用折叠自己的形状：折叠策略把摘要**并进最后一条真实 user 消息**
//      （`fold-statistical.js` 的 `prependSummary`，`summaryRole` 默认 `"user"`），本模块也并进同一条，
//      不新造消息、不改角色交替 —— 摘要文本因此落回崩溃前那个位置。

import { FOLDED_FACTS_RECORD_FIELD, FOLD_SUMMARY_RECORD_FIELD } from "./fold-summary-journal.js";

/** 一条「覆盖到水位线」的折叠摘要事实。
 * `origin` 如实交代这份替代物从哪来（#462 放宽的那一格）：
 *   · `"journal"` —— `record.foldedSummary` 事实行，即**模型当时真的见过**的那份摘要；
 *   · `"strategy"` —— 轮记录上的 `record.foldedFacts`（#470-B 落的策略替代物），
 *     机械摘要 / 宿主注入文本，模型未必见过 ⇒ 回填的是「等价信息」，不是「模型看过的那份」。
 * @typedef {{ text: string, summary?: string, foldedRoundRange?: { from?: number, to?: number }, from?: number, to?: number, origin?: "journal"|"strategy" }} FoldSummaryFact
 */

/** 真实 user 消息（与 `fold-statistical.js` 里 `prependSummary` 找的 `isRealUser` 同口径）：
 * `role:"user"`、至少一个 `text` 块、且**不**是纯工具结果载体。
 * @param {any} message
 * @returns {boolean}
 */
function isRealUserMessage(message) {
  if (message?.role !== "user") return false;
  const content = Array.isArray(message?.content) ? message.content : [];
  if (content.some((block) => block?.type === "tool_result")) return false;
  return content.some((block) => block?.type === "text"
    && String(block?.text ?? "").trim() !== "");
}

/** 一条消息里全部 `text` 块的拼接（与 `orchestrator.js` 取 `fedSummaryText` 同一口径）。
 * @param {any} message
 * @returns {string}
 */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block?.text ?? ""))
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * 从账本里挑**覆盖水位线**的那份折叠摘要事实：取 `foldedRoundRange.to` 最大的一条。
 *
 * 为什么只要最新那份：折叠策略每次都是把新摘要**并进**同一条 user 消息
 * （`mergedFoldSummaryContent` 会把旧摘要节一并合进来），所以最新事实的 `text` 已经包含
 * 之前各次折叠的摘要 ⇒ 一条就够，不必按区间拼多条。
 *
 * @param {object[]} records 折叠后的账本记录（`store.load()` 的形状）
 * @param {number} foldedThrough 水位线（轮号）
 * @returns {FoldSummaryFact|undefined}
 */
export function pickCoveringFoldSummary(records, foldedThrough) {
  if (!Number.isSafeInteger(foldedThrough) || foldedThrough < 1) return undefined;
  let best;
  let bestTo = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const fact = record?.[FOLD_SUMMARY_RECORD_FIELD];
    if (typeof fact?.text !== "string" || fact.text === "") continue;
    const to = Number.isSafeInteger(fact?.foldedRoundRange?.to)
      ? /** @type {number} */ (fact.foldedRoundRange.to)
      : 0;
    // ⚠ 必须**覆盖**水位线：摘要只讲它自己折走的那些轮，覆盖不到就补不齐裁掉的正文。
    if (to < foldedThrough) continue;
    if (to >= bestTo) {
      best = /** @type {FoldSummaryFact} */ (fact);
      bestTo = to;
    }
  }
  return best;
}

/**
 * #462 放宽一格：挑「能补齐已折正文」的替代物，按可靠性排序。
 *
 * ① `record.foldedSummary` 事实行（`pickCoveringFoldSummary`）—— 模型当时真的在上下文里见过它，
 *    裁正文后回填它，续跑形状与崩溃前**逐字一致** ⇒ 有它就用它，行为与今天一字不变。
 * ② `record.foldedFacts`（#470-B 投影到轮记录的**策略替代物**）—— 机械摘要 / 宿主注入文本。
 *    这条路（`context.strategy = "sliding-window"` 尤其）永远不 prepend 进消息流 ⇒
 *    **永远写不出** ①，守卫的等待条件对它逻辑上不可能满足 ⇒ 只落账不给裁用，
 *    不调 LLM 摘要器的宿主每次续跑仍从第 1 轮重折。这里接受它，裁的判据（覆盖水位线）
 *    一条不放宽，只放宽「替代物从哪来」。
 *
 * 两处形状不同，必须显式适配（不是换个字段名）：① 的区间是嵌套 `foldedRoundRange.{from,to}`，
 * ② 是平铺 `{from,to}`（`buildFoldedFacts` 的落盘形状）。
 *
 * @param {object[]} records
 * @param {number} foldedThrough
 * @returns {{ fact: FoldSummaryFact, origin: "journal"|"strategy" }|undefined}
 */
export function pickCoveringFoldAlternative(records, foldedThrough) {
  const journal = pickCoveringFoldSummary(records, foldedThrough);
  if (journal !== undefined) return { fact: journal, origin: "journal" };
  if (!Number.isSafeInteger(foldedThrough) || foldedThrough < 1) return undefined;
  let best;
  let bestTo = 0;
  for (const record of Array.isArray(records) ? records : []) {
    for (const entry of Array.isArray(record?.[FOLDED_FACTS_RECORD_FIELD])
      ? record[FOLDED_FACTS_RECORD_FIELD]
      : []) {
      if (typeof entry?.text !== "string" || entry.text === "") continue;
      const to = Number.isSafeInteger(entry?.to) ? /** @type {number} */ (entry.to) : 0;
      // 与 ① 同一条硬约束：替代物必须**覆盖**到水位线，否则补不齐裁掉的正文（#462 边界①）。
      if (to < foldedThrough) continue;
      if (to >= bestTo) {
        best = { ...entry, origin: "strategy" };
        bestTo = to;
      }
    }
  }
  return best === undefined ? undefined : { fact: best, origin: "strategy" };
}

/**
 * 从事实体里还原「要回填进上下文的那段摘要正文」。
 *
 * 两个来源，按可靠性排序：
 *   ① `fact.summary` —— 引擎自己跑摘要器时留下的**纯摘要**（`orchestrator.js` 的
 *      `lastFoldSummaryOutcome.summary`），最干净，有就用它；
 *   ② `fact.text` —— 折叠后**那条被并进了摘要的 user 消息**的全文（`#326` 落的形状），
 *      里面还混着原任务正文（就是 seed 那条 user 消息）。原任务正文在账本里另有一行 ⇒
 *      把它从 `text` 里剥掉，剩下的才是摘要。剥不掉（宿主自己给策略、引擎没见过摘要现场 ⇒
 *      文本口径对不上）时**宁可整段回填**也不猜：多喂一份任务正文，远好过把摘要丢掉。
 *
 * @param {FoldSummaryFact} fact
 * @param {string[]} headTexts 留在上下文里的那些 head 消息正文（用来剥重复的任务正文）
 * @returns {string}
 */
export function deriveFoldSummaryText(fact, headTexts = []) {
  if (typeof fact?.summary === "string" && fact.summary.trim() !== "") {
    return fact.summary.trim();
  }
  let text = String(fact?.text ?? "").trim();
  for (const headText of headTexts) {
    if (typeof headText !== "string" || headText.trim() === "") continue;
    if (!text.includes(headText)) continue;
    text = text.split(headText).join("").trim();
  }
  return text;
}

/**
 * 规划「按水位线裁正文」：**纯函数**，不改入参。
 *
 * @param {{
 *   ledgerEntries?: { message: any, round: number }[],
 *   records?: object[],
 *   foldedThrough?: number,
 * }} input
 * @returns {{
 *   applied: boolean,
 *   reason: string,
 *   messages: { message: any, round: number }[],
 *   dropped: { message: any, round: number }[],
 *   summaryText: string,
 *   summarySource: string,
 *   droppedRounds: number,
 * }}
 */
export function planFoldedHistoryTrim(input = {}) {
  const entries = Array.isArray(input.ledgerEntries) ? input.ledgerEntries : [];
  const foldedThrough = Number.isSafeInteger(input.foldedThrough)
    ? /** @type {number} */ (input.foldedThrough)
    : 0;
  const passthrough = (/** @type {string} */ reason) => ({
    applied: false,
    reason,
    messages: entries,
    dropped: [],
    summaryText: "",
    summarySource: "",
    droppedRounds: 0,
  });

  if (foldedThrough < 1) return passthrough("no-watermark");
  const dropped = entries.filter((entry) => Number.isSafeInteger(entry.round)
    && /** @type {number} */ (entry.round) > 0
    && /** @type {number} */ (entry.round) <= foldedThrough);
  if (dropped.length === 0) return passthrough("nothing-to-trim");
  // head（round ≤ 0，含 seed 种子行）永不裁：任务正文与 system 都在那里。
  // 用 Set 而不是 `dropped.includes`：账本消息数是千级（真机一个会话 30+ 轮、单轮 1 MB），
  // 数组 `includes` 在这里是 O(n²)。
  const droppedSet = new Set(dropped);
  const kept = entries.filter((entry) => !droppedSet.has(entry));

  const picked = pickCoveringFoldAlternative(input.records, foldedThrough);
  const fact = picked?.fact;
  if (fact === undefined) return passthrough("no-covering-summary");
  const summaryText = deriveFoldSummaryText(
    fact,
    kept.filter((entry) => (entry.round ?? 0) <= 0).map((entry) => textOf(entry.message)),
  );
  if (summaryText === "") return passthrough("empty-summary");

  return {
    applied: true,
    reason: "trimmed",
    messages: kept,
    dropped,
    summaryText,
    // 如实交代回填的替代物来源："journal" = 模型当时见过的那份摘要；
    // "strategy" = 策略算出的机械摘要 / 宿主注入文本（模型未必见过，但信息等价）。
    summarySource: picked.origin,
    droppedRounds: new Set(dropped.map((entry) => entry.round)).size,
  };
}

/**
 * 把摘要回填进续跑上下文：沿用折叠的形状，并进**最后一条真实 user 消息**的头部；
 * head 里没有任何真实 user 消息时，退化成在 system 之后插一条独立 user 消息。
 *
 * @param {any[]} messages 已裁掉的续跑上下文（就地不改，返回新数组）
 * @param {string} summaryText
 * @returns {any[]}
 */
export function injectFoldSummaryIntoHead(messages, summaryText) {
  const list = Array.isArray(messages) ? messages : [];
  if (summaryText === "") return list.slice();
  const summaryBlock = { type: "text", text: summaryText };
  // ⚠ 只在 **head 段**（第一条 assistant 之前）里找那条载体，不能拿到整份上下文去找最后一条：
  // 尾部常见的宿主追问行（`appendUserTurn` 产出的 `role:"user"` + 纯 text）形状与它逐字相同，
  // 全文去找就会把摘要并到**最后一条追问**身上 —— 位置从「上下文最前」掉到「所有 tool_result
  // 之后」，既不是折叠当时的形状，也把摘要与它要概括的正文隔开了。
  const firstAssistant = list.findIndex((message) => message?.role === "assistant");
  const headEnd = firstAssistant < 0 ? list.length : firstAssistant;
  let userIndex = -1;
  for (let index = headEnd - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(list[index])) {
      userIndex = index;
      break;
    }
  }
  if (userIndex >= 0) {
    const target = list[userIndex];
    const content = typeof target?.content === "string"
      ? [{ type: "text", text: target.content }]
      : Array.isArray(target?.content) ? target.content : [];
    const next = list.slice();
    next[userIndex] = {
      ...target,
      content: [summaryBlock, ...content],
    };
    return next;
  }
  const systemIndex = list.findLastIndex((message) => message?.role === "system");
  const standalone = { role: "user", content: [summaryBlock] };
  const next = list.slice();
  next.splice(systemIndex + 1, 0, standalone);
  return next;
}
