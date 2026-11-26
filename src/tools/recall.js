// @ts-check
import { isMessageRow } from "../store/message-rows.js";
import { Buffer } from "node:buffer";
import { estimateTokens } from "../tokens.js";

/** 硬顶（issue #896 §3-B 写死的数，照抄）：单段摘录 300 tok、最多 5 段、单次返回总 1500 tok、概览 500 tok。 */
const MAX_SEGMENT_TOKENS = 300;
const MAX_SEGMENTS = 5;
const MAX_TOTAL_TOKENS = 1500;
const MAX_OVERVIEW_TOKENS = 500;
/** 摘录前后各保留的上下文字符数（§3-B「前后各留一点上下文窗口以便模型读懂」）。 */
const CONTEXT_CHARS = 80;

/** 含这些字符 ⇒ pattern 走正则；正则非法时回落子串（不许抛）。 */
const REGEX_META = /[.*+?()[\]{}|^$\\]/;

/**
 * 计算 JSON 序列化后的 UTF-8 字节长度。
 * @param {any} value
 * @returns {number}
 */
function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** @param {any} v @returns {boolean} */
function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v >= 1;
}

/**
 * 从一条消息里取出可逐字检索的正文（string 直接用；块数组只取 text 块原文，不改写）。
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  if (message === null || typeof message !== "object") return "";
  let content = message.content;
  if (content === undefined) content = message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((/** @type {any} */ block) => {
        if (typeof block === "string") return block;
        if (block && block.type === "text" && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 取 `s` 的前缀，使其 token 数 ≤ `cap`。返回 cut=true 表示被切过。
 * 前缀 token 数随长度单调不减，故二分找最大可行长度。
 * @param {string} s
 * @param {number} cap
 * @returns {{ text: string, cut: boolean }}
 */
function fitPrefix(s, cap) {
  if (estimateTokens(s) <= cap) return { text: s, cut: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(s.slice(0, mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, lo), cut: true };
}

/**
 * 编译 pattern：含正则元字符则按正则（非法回落子串），否则子串。
 * @param {string} pattern
 * @returns {{ matchedBy: "substring" | "regex", match: (text: string) => { matched: boolean, start: number, end: number } }}
 */
function compileMatcher(pattern) {
  /** @type {(text: string) => { matched: boolean, start: number, end: number }} */
  const substring = (text) => {
    const i = text.indexOf(pattern);
    return i >= 0 ? { matched: true, start: i, end: i + pattern.length } : { matched: false, start: -1, end: -1 };
  };
  if (!REGEX_META.test(pattern)) return { matchedBy: "substring", match: substring };
  try {
    // 不带 /g：exec 无状态，逐条正文重复调用不互相污染 lastIndex。
    const re = new RegExp(pattern);
    return {
      matchedBy: "regex",
      match: (text) => {
        const m = re.exec(text);
        return m ? { matched: true, start: m.index, end: m.index + m[0].length } : { matched: false, start: -1, end: -1 };
      },
    };
  } catch {
    // 正则非法 ⇒ 回落到子串（不许抛）。
    return { matchedBy: "substring", match: substring };
  }
}

/**
 * 从命中位置切一段逐字原文，前后各带一点上下文；整段 token 超单段硬顶则收窄上下文，
 * 连命中本身都装不下时从前缀截（此时 clamped=true ⇒ 上层据此报 truncated）。
 * @param {string} text
 * @param {number} matchStart
 * @param {number} matchEnd
 * @returns {{ excerpt: string, clamped: boolean }}
 */
function clampExcerpt(text, matchStart, matchEnd) {
  let radius = CONTEXT_CHARS;
  let clamped = false;
  for (;;) {
    const start = Math.max(0, matchStart - radius);
    const end = Math.min(text.length, matchEnd + radius);
    const excerpt = text.slice(start, end);
    if (estimateTokens(excerpt) <= MAX_SEGMENT_TOKENS) return { excerpt, clamped };
    if (radius === 0) {
      const fit = fitPrefix(text.slice(matchStart), MAX_SEGMENT_TOKENS);
      return { excerpt: fit.text, clamped: true };
    }
    radius = Math.floor(radius / 2);
    clamped = true;
  }
}

/**
 * 创建 `recall_read` 内置工具的工厂（issue #896 C1，B 层加 pattern/区间/硬顶/三态 §3-B）。
 *
 * 默认不挂进任何既有默认工具列表——由宿主显式挂载。
 *
 * 数据源是**账本本身**（`store.load(runId)` 的行），不是折叠快照 `foldedPayload`：
 * `foldedPayload` 是有界去重后的快照、不是轮的完整切片，天生还原不出轮；而账本完整、
 * 且每条消息都记着自己的轮号。轮号直接取账本上记的 `record.round`，不重算、不按下标猜。
 *
 * 两种模式：
 * - **逐字模式**（不给 `pattern`）：按 `round` 取回整轮原始消息，`status` 为 found / not_folded。
 * - **grep 模式**（给非空字符串 `pattern`）：在 `[fromRound, toRound]`（缺省用 `round` 当锚，
 *   再缺省全区间）里逐字检索，返回命中段列表；`status` 为 found / no_match / truncated /
 *   unrecoverable / empty 三态之一。
 *
 * @param {{ readLedgerRows?: () => Promise<any[]> | any[] }} [options]
 *   只读访问器：返回该 run 的账本行（`store.load(runId)` 的输出）。
 * @returns {{ definitions: object[], executeTool: (req: any) => Promise<string> }}
 */
export function createBuiltinRecallTools(options = {}) {
  const accessor = options?.readLedgerRows;
  if (typeof accessor !== "function") {
    throw new TypeError("createBuiltinRecallTools requires options.readLedgerRows to be a function");
  }

  const TOOL_DEFINITION = {
    name: "recall_read",
    description:
      "从账本逐字取回历史（不做任何改写、摘录是原文切片）。两种模式：① 给 round ⇒ 取回该轮整段原始消息；② 给 pattern ⇒ 在 fromRound..toRound（含端点）里做 grep 式确定性回忆——默认子串匹配，pattern 含正则元字符时按正则匹配（正则非法自动回落子串）。when-to-use：需要取回某轮落盘的原始消息、或在被折叠的历史里按字面/正则定位片段时调用——无论是否已折，账本始终保留每轮正文；round 是账本记录的轮号（1 起）不是下标；scope 仅支持 run。返回 status：found 有命中/正文；no_match 区间内逐字搜过确实没有；empty 账本里一条正文都没有（没折过也没跑过）；unrecoverable 有轮行但正文没存；truncated 命中的归档夹断过、可能只是残片（比 no_match 更保守）。截断时带 truncated:true 与 segmentsOmitted，不静默截",
    inputSchema: {
      type: "object",
      properties: {
        round: { type: "integer", minimum: 1 },
        pattern: { type: "string", minLength: 1, description: "grep 式检索；含 . * + ? ( ) [ ] { } | ^ $ \\ 时按正则，否则按子串" },
        fromRound: { type: "integer", minimum: 1, description: "检索轮区间下界（含端点）" },
        toRound: { type: "integer", minimum: 1, description: "检索轮区间上界（含端点）" },
        scope: { type: "string", enum: ["run"], default: "run" },
      },
      required: ["round"],
      additionalProperties: false,
    },
  };

  async function executeTool(request) {
    const input = (request && typeof request === "object" && !Array.isArray(request) && typeof request.name === "string")
      ? request.input
      : request;
    return recallRead(input ?? {});
  }

  async function recallRead(/** @type {any} */ input) {
    // 给了 pattern（哪怕类型不对）⇒ 进 grep 模式，那里再校验；不给 pattern 才走逐字模式，
    // 逐字模式先校验 round 再校验 scope（与既有行为逐字一致）。
    if (input.pattern !== undefined && input.pattern !== null) {
      return grepRead(input);
    }

    const { round } = input;

    if (!isPositiveInt(round)) {
      return JSON.stringify({ status: "invalid", reason: "round 必须是 ≥1 的正整数", round });
    }

    const scope = input.scope ?? "run";
    if (scope !== "run") {
      return JSON.stringify({ status: "invalid", reason: "scope 仅支持 run", round });
    }

    let rows;
    try {
      rows = await accessor();
    } catch {
      return JSON.stringify({ status: "error", reason: "无法读取账本", round });
    }
    if (!Array.isArray(rows)) rows = [];

    // 口径①：消息行（kind==="message"）里 round===N 的那些，按 seq 升序拼接其 messages
    //   （seq 相同保持落盘先后：V8 的 Array#sort 稳定，先按原序入桶再按 seq 排序即可）。
    //   正常轮的正文已被 store.load() 折进轮载体、消息行被吸走，所以这里只剩崩溃轮（无载体）。
    const fromMessageRows = rows
      .map((/** @type {any} */ row, /** @type {number} */ index) => ({ row, index }))
      .filter(({ row }) => isMessageRow(row) && row.round === round && Array.isArray(row.messages))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.row.seq - b.row.seq) || (a.index - b.index))
      .flatMap(({ row }) => row.messages);

    // 口径②：轮载体行（非消息行、自带 messages 的旧/正常格式）里 round===N 的，直接取其 messages。
    const fromCarrierRows = rows
      .filter((/** @type {any} */ row) => !isMessageRow(row) && row.round === round && Array.isArray(row.messages))
      .flatMap((/** @type {any} */ row) => row.messages);

    const messages = [...fromMessageRows, ...fromCarrierRows];

    if (messages.length === 0) {
      return JSON.stringify({
        status: "not_folded",
        round,
        message: `账本里没有第 ${round} 轮的正文（recall_read 读的是账本，不限于已折轮次）`,
      });
    }

    return JSON.stringify({
      status: "found",
      round,
      messageCount: messages.length,
      byteLength: byteLength(messages),
      messages,
    });
  }

  /**
   * grep 模式：pattern + [fromRound, toRound] 区间内的确定性回忆。
   * @param {any} input
   * @returns {Promise<string>}
   */
  async function grepRead(input) {
    const scope = input.scope ?? "run";
    if (scope !== "run") {
      return JSON.stringify({ status: "invalid", reason: "scope 仅支持 run" });
    }

    const { pattern } = input;
    if (typeof pattern !== "string") {
      return JSON.stringify({ status: "invalid", reason: "pattern 必须是字符串" });
    }
    if (pattern.length === 0) {
      return JSON.stringify({ status: "invalid", reason: "pattern 不能为空字符串" });
    }

    const { fromRound, toRound } = input;
    if (fromRound !== undefined && !isPositiveInt(fromRound)) {
      return JSON.stringify({ status: "invalid", reason: "fromRound 必须是 ≥1 的正整数", fromRound });
    }
    if (toRound !== undefined && !isPositiveInt(toRound)) {
      return JSON.stringify({ status: "invalid", reason: "toRound 必须是 ≥1 的正整数", toRound });
    }
    if (fromRound !== undefined && toRound !== undefined && fromRound > toRound) {
      return JSON.stringify({ status: "invalid", reason: "fromRound 不得大于 toRound", fromRound, toRound });
    }

    let rows;
    try {
      rows = await accessor();
    } catch {
      return JSON.stringify({ status: "error", reason: "无法读取账本" });
    }
    if (!Array.isArray(rows)) rows = [];

    // 账本级分类（三态里的 empty / unrecoverable 是对整个 run 的判断，与检索区间无关）。
    let ledgerHasAnyMessage = false;
    let ledgerHasRoundRows = false;
    for (const /** @type {any} */ row of rows) {
      if (isPositiveInt(row?.round)) ledgerHasRoundRows = true;
      if (Array.isArray(row?.messages) && row.messages.length > 0) ledgerHasAnyMessage = true;
    }
    if (!ledgerHasAnyMessage && !ledgerHasRoundRows) {
      return JSON.stringify({
        status: "empty",
        pattern,
        message: "账本里一条正文都没有（既没折过、也没跑过任何轮）",
        segments: [],
        matchCount: 0,
        segmentsOmitted: 0,
        truncated: false,
      });
    }
    if (!ledgerHasAnyMessage && ledgerHasRoundRows) {
      return JSON.stringify({
        status: "unrecoverable",
        pattern,
        message: "账本里有轮行，但没有任何 messages（正文没存）",
        segments: [],
        matchCount: 0,
        segmentsOmitted: 0,
        truncated: false,
      });
    }

    // 检索区间：显式 fromRound/toRound 优先，其次用 round 当锚，再缺省全区间。
    const anchor = isPositiveInt(input.round) ? input.round : null;
    const windowFrom = fromRound ?? anchor ?? 1;
    const windowTo = toRound ?? anchor ?? Number.MAX_SAFE_INTEGER;

    const { match: matcher, matchedBy } = compileMatcher(pattern);
    const { hits, clampedInWindow } = collectHits(rows, windowFrom, windowTo, matcher);

    if (hits.length === 0) {
      // 无命中：窗口内归档夹断过 ⇒ 报 truncated（比 no_match 更保守），否则 no_match。
      if (clampedInWindow) {
        return JSON.stringify({
          status: "truncated",
          pattern,
          matchedBy,
          fromRound: windowFrom,
          toRound: windowTo === Number.MAX_SAFE_INTEGER ? null : windowTo,
          message: "命中的轮次里归档夹断过正文（droppedMessages/droppedBytes>0）——没命中可能是残片所致，不等于这段历史不存在",
          segments: [],
          matchCount: 0,
          segmentsOmitted: 0,
          truncated: true,
          clamped: true,
        });
      }
      return JSON.stringify({
        status: "no_match",
        pattern,
        matchedBy,
        fromRound: windowFrom,
        toRound: windowTo === Number.MAX_SAFE_INTEGER ? null : windowTo,
        message: "区间内逐字搜过，确实没有匹配（账本别处仍有正文，非 empty）",
        segments: [],
        matchCount: 0,
        segmentsOmitted: 0,
        truncated: false,
        clamped: false,
      });
    }

    // 有命中：按硬顶装配段列表（单段 300 / 段数 5 / 总 1500）。
    const segments = [];
    let totalTokens = 0;
    let segmentClamped = false;
    let segmentsOmitted = 0;
    for (let i = 0; i < hits.length; i += 1) {
      if (segments.length >= MAX_SEGMENTS) {
        segmentsOmitted = hits.length - segments.length;
        break;
      }
      const hit = hits[i];
      const { excerpt, clamped } = clampExcerpt(hit.text, hit.start, hit.end);
      if (clamped) segmentClamped = true;
      const tokens = estimateTokens(excerpt);
      if (totalTokens + tokens > MAX_TOTAL_TOKENS) {
        segmentsOmitted = hits.length - segments.length;
        break;
      }
      totalTokens += tokens;
      segments.push({
        round: hit.round,
        messageIndex: hit.messageIndex,
        excerpt,
        bytes: Buffer.byteLength(excerpt, "utf8"),
        matchedBy,
      });
    }

    const truncated = segmentsOmitted > 0 || segmentClamped;
    const overviewRaw = `pattern "${pattern}" 在轮 [${windowFrom}, ${windowTo === Number.MAX_SAFE_INTEGER ? "∞" : windowTo}] 命中 ${hits.length} 处，返回 ${segments.length} 段（matchedBy=${matchedBy}${segmentsOmitted > 0 ? `，省略 ${segmentsOmitted} 段` : ""}）。`;
    const overview = fitPrefix(overviewRaw, MAX_OVERVIEW_TOKENS).text;

    return JSON.stringify({
      status: "found",
      pattern,
      matchedBy,
      fromRound: windowFrom,
      toRound: windowTo === Number.MAX_SAFE_INTEGER ? null : windowTo,
      matchCount: hits.length,
      segments,
      segmentsOmitted,
      truncated,
      clamped: clampedInWindow,
      overview,
    });
  }

  /**
   * 在 `[fromRound, toRound]` 区间内收集命中（每条命中 = 某轮某条消息的首次匹配）。
   * 轮内顺序：消息行按 seq 升序（seq 相同按落盘先后），其后接轮载体行——与逐字模式同口径。
   * 同时回报区间内是否有轮被归档夹断（foldedPayloadMeta.droppedMessages/droppedBytes>0）。
   * @param {any[]} rows
   * @param {number} fromRound
   * @param {number} toRound
   * @param {(text: string) => { matched: boolean, start: number, end: number }} matcher
   * @returns {{ hits: { round: number, messageIndex: number, text: string, start: number, end: number }[], clampedInWindow: boolean }}
   */
  function collectHits(rows, fromRound, toRound, matcher) {
    /** @type {Map<number, { items: { message: any, order: number }[], clamped: boolean }>} */
    const byRound = new Map();
    rows.forEach((/** @type {any} */ row, /** @type {number} */ index) => {
      const round = row?.round;
      if (!isPositiveInt(round) || round < fromRound || round > toRound) return;
      const isMsg = isMessageRow(row);
      const entry = byRound.get(round) ?? { items: [], clamped: false };
      const meta = row?.foldedPayloadMeta;
      if (meta && ((meta.droppedMessages > 0) || (meta.droppedBytes > 0))) entry.clamped = true;
      if (Array.isArray(row?.messages)) {
        // 消息行按 seq 排在前面，载体行排后面；order 单调，保证轮内确定性顺序。
        const orderBase = isMsg ? (Number.isSafeInteger(row.seq) ? row.seq : 0) : Number.MAX_SAFE_INTEGER - 1;
        row.messages.forEach((/** @type {any} */ message, /** @type {number} */ mi) => {
          entry.items.push({ message, order: orderBase * 1e6 + index * 1000 + mi });
        });
      }
      byRound.set(round, entry);
    });

    const hits = [];
    let clampedInWindow = false;
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    for (const round of rounds) {
      const entry = byRound.get(round);
      if (entry === undefined) continue;
      if (entry.clamped) clampedInWindow = true;
      entry.items.sort((a, b) => a.order - b.order);
      entry.items.forEach((/** @type {any} */ item, /** @type {number} */ messageIndex) => {
        const text = messageText(item.message);
        if (text === "") return;
        const m = matcher(text);
        if (m.matched) hits.push({ round, messageIndex, text, start: m.start, end: m.end });
      });
    }
    return { hits, clampedInWindow };
  }

  return {
    definitions: [TOOL_DEFINITION],
    executeTool,
  };
}
