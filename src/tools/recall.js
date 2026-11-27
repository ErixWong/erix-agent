// @ts-check
import { isMessageRow, messageRowPosition } from "../store/message-rows.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { estimateTokens } from "../tokens.js";
// issue #896 §3-C（PR #969 复审③）：2 KiB 上限验证侧也要拦，与 recall-runner 生成侧共用同一常量。recall-runner 不 import 本文件，无循环。
import { RECALL_MAX_EVIDENCE_BYTES } from "../loop/recall-runner.js";

/** 硬顶（issue #896 §3-B 写死的数，照抄）：单段摘录 300 tok、最多 5 段、单次返回总 1500 tok、概览 500 tok。 */
const MAX_SEGMENT_TOKENS = 300;
const MAX_SEGMENTS = 5;
/** 单次返回的段 token 总顶与概览顶——导出给测试引用（别在测试里手抄数字）。 */
export const MAX_TOTAL_TOKENS = 1500;
export const MAX_OVERVIEW_TOKENS = 500;
/** 摘录前后各保留的上下文字符数（§3-B「前后各留一点上下文窗口以便模型读懂」）。 */
const CONTEXT_CHARS = 80;
/**
 * 回显 `pattern` 的字符上限（copilot #964 ②）：pattern 也计入返回总量，无上限原样回显
 * 会让「段 ≤1500 + 概览 ≤500」的预算被一个超长 pattern 击穿。截断带 `patternTruncated:true`。
 */
export const MAX_PATTERN_ECHO_CHARS = 200;

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
 * evidenceRef 形状校验（§3-C + issue #261127-15：**行主键**）：合法返回 null，否则返回报错原因（上层据此报 invalid）。
 * 只校结构（round_no/msg_seq/charRange/sha256 都在且形对），不对内容做真假判断。
 * 身份口径是**行主键**：`round_no` + `msg_seq` 合起来是本轮内**稳定**的消息地址（口径在
 * `src/store/message-rows.js` 的 `messageRowPosition`：消息行取行上的 `seq`、轮载体行取该消息在
 * **该行自己的** `messages` 里的下标——两者都是行上的不可变位置，消息行被 `store.load()` 折进载体
 * 也不变，同轮再落一条消息行也不改既有消息的地址）。
 * 上一版的内容寻址（`round` + `textSha256` + `occurrence`）与更早的位置寻址（`round`+`messageIndex`）
 * 一律 invalid——**不迁移**（该能力尚未发布，明确不兼容）：旧 ref 里没有 `msg_seq`，这里直接判 invalid。
 * @param {any} ref
 * @returns {string|null}
 */
function evidenceRefShapeError(ref) {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    return "evidenceRef 必须是指纹对象（round_no/msg_seq/charRange/sha256）";
  }
  if (!isPositiveInt(ref.round_no)) return "evidenceRef.round_no 必须是 ≥1 的正整数（行主键下定位必需）";
  if (!(Number.isSafeInteger(ref.msg_seq) && ref.msg_seq >= 0)) {
    return "evidenceRef.msg_seq 必须是 ≥0 的整数（本轮内的稳定消息位置）：缺失 ⇒ invalid（旧的内容寻址格式不迁移）";
  }
  const cr = ref.charRange;
  if (!Array.isArray(cr) || cr.length !== 2 || !cr.every((/** @type {any} */ n) => Number.isSafeInteger(n) && n >= 0)) {
    return "evidenceRef.charRange 必须是两个 ≥0 整数的数组 [start, end]";
  }
  if (cr[0] > cr[1]) return "evidenceRef.charRange 的 start 不得大于 end";
  if (typeof ref.sha256 !== "string" || ref.sha256.length === 0) return "evidenceRef.sha256 必须是非空字符串";
  return null;
}

/**
 * 从一条消息里取出**逐块**的原文数组（copilot #964 ④：绝不拼接）。
 * 拼成整条正文再 grep 会让正则跨拼接边界命中，返回的 excerpt 就成了「原文里没有的切片」。
 * string content ⇒ 单元素；块数组 ⇒ 每个 text 块一项（string 块直接用其原文，不改写）；其余 ⇒ 空数组。
 * @param {any} message
 * @returns {string[]}
 */
function messageTextUnits(message) {
  if (message === null || typeof message !== "object") return [];
  let content = message.content;
  if (content === undefined) content = message.text;
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content
      .map((/** @type {any} */ block) => {
        if (typeof block === "string") return block;
        if (block && block.type === "text" && typeof block.text === "string") return block.text;
        return "";
      })
      .filter(Boolean);
  }
  return [];
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
 * 把回显给调用方的 `pattern` 截到 {@link MAX_PATTERN_ECHO_CHARS} 字符（copilot #964 ②）。
 * 只取前缀，绝不改写：返回的截断值必须是原 pattern 的切片。
 * @param {string} pattern
 * @returns {{ text: string, truncated: boolean }}
 */
function clipPattern(pattern) {
  if (pattern.length <= MAX_PATTERN_ECHO_CHARS) return { text: pattern, truncated: false };
  return { text: pattern.slice(0, MAX_PATTERN_ECHO_CHARS), truncated: true };
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
      "从账本逐字取回历史（不做任何改写、摘录是原文切片）。两种模式：① 给 round ⇒ 取回该轮整段原始消息；② 给 pattern ⇒ 在 fromRound..toRound（含端点）里做 grep 式确定性回忆——默认子串匹配，pattern 含正则元字符时按正则匹配（正则非法自动回落子串）。when-to-use：需要取回某轮落盘的原始消息、或在被折叠的历史里按字面/正则定位片段时调用——无论是否已折，账本始终保留每轮正文；round 是账本记录的轮号（1 起）不是下标；round 与 pattern 至少给一个（两个都没给 ⇒ status=invalid）；scope 仅支持 run。返回 status：found 有命中/正文；no_match 区间内逐字搜过确实没有；empty 账本里一条正文都没有（没折过也没跑过）；unrecoverable 有轮行但正文没存；truncated 命中的归档夹断过、可能只是残片（比 no_match 更保守）。截断时带 truncated:true 与 segmentsOmitted，不静默截",
    inputSchema: {
      type: "object",
      properties: {
        round: { type: "integer", minimum: 1 },
        pattern: { type: "string", minLength: 1, description: "grep 式检索；含 . * + ? ( ) [ ] { } | ^ $ \\ 时按正则，否则按子串；回显时截到 200 字符并带 patternTruncated" },
        fromRound: { type: "integer", minimum: 1, description: "检索轮区间下界（含端点）" },
        toRound: { type: "integer", minimum: 1, description: "检索轮区间上界（含端点）" },
        scope: { type: "string", enum: ["run"], default: "run" },
        // issue #896 §3-C：第三种模式——按引擎落下的指纹切片逐字取回并验影子。
        evidenceRef: {
          type: "object",
          description: "引擎落进 record.recallEvidence 的切片指纹；给了它就进 evidence 模式（优先级高于 round/pattern）。定位口径是**行主键**：round_no + msg_seq 合起来是本轮内稳定的消息地址（消息行取行上 seq、轮载体行取该行自己 messages 的下标，折进载体也不变）；两者定位必需",
          properties: {
            round_no: { type: "integer", minimum: 1, description: "定位必需的轮号（1 起）" },
            msg_seq: { type: "integer", minimum: 0, description: "本轮内的稳定消息位置：消息行是行上的 seq，轮载体行是该消息在该行 messages 里的下标" },
            charRange: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 2, maxItems: 2 },
            sha256: { type: "string", minLength: 1 },
            bytes: { type: "integer", minimum: 0 },
          },
          additionalProperties: true,
        },
      },
      // ①（copilot #964 P0）：不再 required:["round"]——本功能的全部价值就是「记不得第几轮」时
      // 用 pattern 检索，硬 required 会让合规调用方没法只给 pattern。“至少给一个”在入口处校。
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
    // issue #896 §3-C：第三模式——给了 `evidenceRef` 就进 evidence 校验（优先级最高）。
    // 放在最前面，既有的 round / pattern 输入从不带 `evidenceRef`，两条既有路径逐字不变。
    if (input?.evidenceRef !== undefined && input?.evidenceRef !== null) {
      return evidenceRead(input.evidenceRef);
    }
    // ①（copilot #964 P0）：round 与 pattern 至少给一个——schema 已不再 required round，
    // 两个都没给才在这里判 invalid（只给 round 的逐字模式行为逐字不变）。
    const hasPattern = input.pattern !== undefined && input.pattern !== null;
    const hasRound = input.round !== undefined && input.round !== null;
    if (!hasPattern && !hasRound) {
      return JSON.stringify({
        status: "invalid",
        reason: "round 与 pattern 至少给一个（round 逐字取回整轮，pattern 做 grep 式检索）",
      });
    }

    // 给了 pattern（哪怕类型不对）⇒ 进 grep 模式，那里再校验；不给 pattern 才走逐字模式，
    // 逐字模式先校验 round 再校验 scope（与既有行为逐字一致）。
    if (hasPattern) {
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
      // `row?.` 不是洁癖：访问器是**宿主注入**的（`readLedgerRows`），返回 `null` / 非对象行时
      // `row.round` 会抛 `Cannot read properties of null`——工具里抛异常等于整轮 run 死掉，
      // 而「账本里有一行是 null」这种事不该有这种代价（#896 C1 的 null 安全洞，fuzz 实测到）。
      .filter(({ row }) => isMessageRow(row) && row?.round === round && Array.isArray(row?.messages))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.row.seq - b.row.seq) || (a.index - b.index))
      .flatMap(({ row }) => row.messages);

    // 口径②：轮载体行（非消息行、自带 messages 的旧/正常格式）里 round===N 的，直接取其 messages。
    const fromCarrierRows = rows
      .filter((/** @type {any} */ row) => !isMessageRow(row) && row?.round === round && Array.isArray(row?.messages))
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
   * 按**行主键** `(round_no, msg_seq)` 在账本里取回那条消息的整段正文；取不到返回 null。
   * 地址口径不另造一套：直接走 `collectRoundMessagesInRange`，它逐条问 `messageRowPosition`
   * （`src/store/message-rows.js`，与折叠侧 `stampRowPosition` 同一份定义）——生成侧与校验侧因此
   * 对同一条消息算出的地址逐字相同，这是「折行不变性」的实现前提（上一版内容寻址的理由——
   * 「行身份在 `store.load()` 后会漂」——已经被折行时 stamp 上去的**不可变行位置**替掉）。
   * 轮内顺序口径与生成侧一致（消息行按 seq 升序在前、轮载体行在后）。
   * @param {any[]} rows
   * @param {number} round_no 轮号（定位必需）
   * @param {number} msg_seq 本轮内的稳定消息位置
   * @returns {string|null}
   */
  function ledgerTextAtRowKey(rows, round_no, msg_seq) {
    const bound = Number.isSafeInteger(round_no) ? round_no : -1;
    const entries = collectRoundMessagesInRange(Array.isArray(rows) ? rows : [], bound, bound);
    const hit = entries.find(
      (/** @type {any} */ e) => e.round_no === round_no && e.msg_seq === msg_seq,
    );
    return hit === undefined ? null : hit.text;
  }

  /**
   * evidence 模式（§3-C + issue #261127-15 行主键）：拿引擎落下的指纹回账本逐字取回并**重算 sha256** 验影子。
   * 定位口径：行主键 (round_no, msg_seq)（见 `ledgerTextAtRowKey`）。三态：重算一致⇒found + 逐字原文；
   * 定位到了但 sha256 不一致⇒stale（影子对不上原文，绝不回一份“差不多的”）；
   * `(round_no, msg_seq)` 指不到任何消息⇒invalid。
   * 四既有校验（空切片 / 越界 / bytes 不符 / >2 KiB）全部保留，且全在 sha 比较之前判。
   * @param {any} ref
   * @returns {Promise<string>}
   */
  async function evidenceRead(ref) {
    const shapeReason = evidenceRefShapeError(ref);
    if (shapeReason !== null) {
      return JSON.stringify({ status: "invalid", reason: shapeReason, evidenceRef: ref });
    }
    const { round_no, msg_seq, charRange, sha256 } = ref;

    let rows;
    try {
      rows = await accessor();
    } catch {
      return JSON.stringify({ status: "error", reason: "无法读取账本", evidenceRef: ref });
    }
    if (!Array.isArray(rows)) rows = [];

    const text = ledgerTextAtRowKey(rows, round_no, msg_seq);
    if (text === null) {
      return JSON.stringify({
        status: "invalid",
        reason: `台账里没有这个 ref（第 ${round_no} 轮里没有 msg_seq=${msg_seq} 那条可寻址的消息）`,
        evidenceRef: ref,
      });
    }

    const rangeStart = charRange[0];
    const rangeEnd = charRange[1];
    // PR #969 复审③：三条校验缺一不可，全在 sha 比较之前判（否则空/越界会先被判成 stale）。
    // 校验 1：空切片一律 invalid（旧 bug：[0,0] + 空串 sha256 恒 found，账本怎么改都对得上）。
    if (!(rangeEnd > rangeStart)) {
      return JSON.stringify({ status: "invalid", reason: `空切片：charRange [${rangeStart}, ${rangeEnd}] 的 end 必须严格大于 start（空区间一律 invalid）`, evidenceRef: ref });
    }
    // 校验 2：越界 invalid（JS 的 slice 会把越界夹成整段，不先拦就误判 stale/found）。
    if (rangeEnd > text.length) {
      return JSON.stringify({ status: "invalid", reason: `越界：charRange end=${rangeEnd} 超出原文长度 ${text.length}`, evidenceRef: ref, textLength: text.length });
    }
    const slice = text.slice(rangeStart, rangeEnd);
    const bytes = Buffer.byteLength(slice, "utf8");
    // 校验 3a：2 KiB 上限在验证侧同样拦（不能只在生成侧夹断）。
    if (bytes > RECALL_MAX_EVIDENCE_BYTES) {
      return JSON.stringify({ status: "invalid", reason: `切片 ${bytes} 字节超过 ${RECALL_MAX_EVIDENCE_BYTES} 字节上限（验证侧也拦）`, evidenceRef: ref, actualBytes: bytes });
    }
    // 校验 3b：bytes 对不上 invalid（ref 声明字节数 ≠ 账本原文切片实际字节数）。
    if (ref.bytes !== undefined && ref.bytes !== bytes) {
      return JSON.stringify({ status: "invalid", reason: `bytes 对不上：ref.bytes=${ref.bytes} 不等于账本原文切片实际字节 ${bytes}`, evidenceRef: ref, actualBytes: bytes });
    }
    const actualSha = createHash("sha256").update(slice, "utf8").digest("hex");
    if (actualSha === sha256) {
      return JSON.stringify({
        status: "found",
        evidenceRef: ref,
        text: slice,
        bytes,
      });
    }
    return JSON.stringify({
      status: "stale",
      reason: "影子对不上原文：台账里的切片与指纹的 sha256 不一致（绝不回一份差不多的）",
      evidenceRef: ref,
      expectedSha: sha256,
      actualSha,
      actualBytes: bytes,
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
    // ②（copilot #964）：回显的 pattern 截到 200 字符，否则硬顶管不住返回 JSON 总量。
    const echo = clipPattern(pattern);

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
        pattern: echo.text,
        patternTruncated: echo.truncated,
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
        pattern: echo.text,
        patternTruncated: echo.truncated,
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
    // ③（copilot #964）：夹断是 **run 级事实**，扫全部行、不受检索窗口限制
    // ⇒ 宁可多报 truncated，不许漏报（变量名也从 clampedInWindow 改为 archiveClamped）。
    const { hits, archiveClamped } = collectHits(rows, windowFrom, windowTo, matcher);

    if (hits.length === 0) {
      // 无命中：本次 run 的归档曾经夹断过 ⇒ 报 truncated（比 no_match 更保守），否则 no_match。
      if (archiveClamped) {
        return JSON.stringify({
          status: "truncated",
          pattern: echo.text,
          patternTruncated: echo.truncated,
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
        pattern: echo.text,
        patternTruncated: echo.truncated,
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
    const overviewRaw = `pattern "${echo.text}" 在轮 [${windowFrom}, ${windowTo === Number.MAX_SAFE_INTEGER ? "∞" : windowTo}] 命中 ${hits.length} 处，返回 ${segments.length} 段（matchedBy=${matchedBy}${segmentsOmitted > 0 ? `，省略 ${segmentsOmitted} 段` : ""}）。`;
    const overview = fitPrefix(overviewRaw, MAX_OVERVIEW_TOKENS).text;

    // copilot #964 第三轮：上面的三个硬顶（单段 / 段数 / 总 1500）都是拿 `estimateTokens` 量**原文**的，
    // 而模型读到的其实是 `JSON.stringify` 之后的串。控制字符（`\u0000` 等）在 JSON 里会被转义成 6 个字符，
    // 于是「原文 296 tok 的摘录」序列化后可以远超它——把预算击穿。这里对**序列化后的整包**再收一次口：
    // 超了就从末尾丢段（并如实报 `segmentsOmitted` / `truncated`），丢到只剩一段仍超就只留概览。
    const build = () => ({
      status: "found",
      pattern: echo.text,
      patternTruncated: echo.truncated,
      matchedBy,
      fromRound: windowFrom,
      toRound: windowTo === Number.MAX_SAFE_INTEGER ? null : windowTo,
      matchCount: hits.length,
      segments,
      segmentsOmitted,
      truncated,
      clamped: archiveClamped,
      overview,
    });
    // 概览是单独的一条预算（issue：概览 500 tok），整包预算 = 1500 + 500。
    const PACKAGE_TOKEN_BUDGET = MAX_TOTAL_TOKENS + MAX_OVERVIEW_TOKENS;
    let payload = build();
    while (estimateTokens(JSON.stringify(payload)) > PACKAGE_TOKEN_BUDGET && payload.segments.length > 0) {
      payload.segments = payload.segments.slice(0, -1);
      payload.segmentsOmitted = hits.length - payload.segments.length;
      payload.truncated = true;
    }
    return JSON.stringify(payload);
  }

  /**
   * 在 `[fromRound, toRound]` 区间内收集命中（每条命中 = 某轮某条消息**某一个原文块**的首次匹配）。
   * 轮内顺序：消息行按 seq 升序（seq 相同按落盘先后），其后接轮载体行——与逐字模式同口径。
   * ④（copilot #964）：逐块匹配、摘录只从一块里切——拼成整条正文会让正则跨 `"\n"` 拼接边界
   * 命中，返回的 excerpt 就不是任何原始块的切片（等于自己造了原文里没有的字符）。
   * 同时回报「本次 run 的归档曾经夹断过正文」：这是 run 级事实（foldedPayloadMeta 挂在归档行上，
   * 描述的是“归档到此轮之前的正文被夹断过”），③（copilot #964）**扫全部行、不受窗口限制**：
   * 窗口收窄到受影响的轮时，旧实现会把夹断记录切在窗口外⇒漏报 truncated。
   * @param {any[]} rows
   * @param {number} fromRound
   * @param {number} toRound
   * @param {(text: string) => { matched: boolean, start: number, end: number }} matcher
   * @returns {{ hits: { round: number, messageIndex: number, text: string, start: number, end: number }[], archiveClamped: boolean }}
   */
  function collectHits(rows, fromRound, toRound, matcher) {
    // 夹断检测：故意比窗口更粗（宁可多报，不许漏报）。
    let archiveClamped = false;
    for (const /** @type {any} */ row of rows) {
      const meta = row?.foldedPayloadMeta;
      if (meta && ((meta.droppedMessages > 0) || (meta.droppedBytes > 0))) archiveClamped = true;
    }

    /** @type {Map<number, { items: { message: any, order: number }[] }>} */
    const byRound = new Map();
    rows.forEach((/** @type {any} */ row, /** @type {number} */ index) => {
      const round = row?.round;
      if (!isPositiveInt(round) || round < fromRound || round > toRound) return;
      if (!Array.isArray(row?.messages)) return;
      const isMsg = isMessageRow(row);
      const entry = byRound.get(round) ?? { items: [] };
      // 消息行按 seq 排在前面，载体行排后面；order 单调，保证轮内确定性顺序。
      const orderBase = isMsg ? (Number.isSafeInteger(row.seq) ? row.seq : 0) : Number.MAX_SAFE_INTEGER - 1;
      row.messages.forEach((/** @type {any} */ message, /** @type {number} */ mi) => {
        entry.items.push({ message, order: orderBase * 1e6 + index * 1000 + mi });
      });
      byRound.set(round, entry);
    });

    /** @type {{ round: number, messageIndex: number, text: string, start: number, end: number }[]} */
    const hits = [];
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    for (const round of rounds) {
      const entry = byRound.get(round);
      if (entry === undefined) continue;
      entry.items.sort((a, b) => a.order - b.order);
      entry.items.forEach((/** @type {any} */ item, /** @type {number} */ messageIndex) => {
        for (const unit of messageTextUnits(item.message)) {
          if (unit === "") continue;
          const m = matcher(unit);
          if (!m.matched) continue;
          // 只记命中所在那一个块：excerpt 从这块里切，永远是原文块的切片。
          hits.push({ round, messageIndex, text: unit, start: m.start, end: m.end });
          break;
        }
      });
    }
    return { hits, archiveClamped };
  }

  return {
    definitions: [TOOL_DEFINITION],
    executeTool,
  };
}

/**
 * 取 [fromRound, toRound]（含端点）轮区间内的账本原文，逐条返回 {round_no, msg_seq, text}（issue #261127-15 行主键）。
 * 与 createBuiltinRecallTools 里 evidenceRead/逐字模式同一套账本行口径：口径①消息行（isMessageRow
 * && round 命中 && 带 messages）按 seq 升序（seq 相同按落盘先后），口径②轮载体行（非消息行 &&
 * round 命中）接在其后；text = messageTextUnits(message).join("")——与 recall_read 逐字模式取回的原文逐字一致，
 * 因此按同一 (round_no, msg_seq) 与同一 charRange 算的 sha256 能被 recall_read({evidenceRef}) 重算对上
 * （PR #969 复审②：指纹必须落在账本原文切片上，不是摘要）。
 * **地址口径（issue #261127-15：行主键）**：`round_no` + `msg_seq` 直接问 `messageRowPosition`
 * （`src/store/message-rows.js`，与折叠侧 `stampRowPosition` 同一份定义）：消息行取行上的 `seq`，
 * 轮载体行取该消息在**该行自己的** `messages` 里的下标——两者都是行上的**不可变位置**，消息行被
 * `store.load()` 折进载体后地址不变（位戳已随消息走），同轮再落一条消息行也不改既有消息的地址。
 * 取不到稳定位置的消息（行无轮号 / 消息行缺整数 `seq`）**跳过**：不可寻址就不交出去，宁可少一片
 * 也不发一个会漂的地址。
 * （旧口径已整块删除：上一版用**内容寻址**——那条消息整段正文的 sha256 `textSha256` + 同轮内
 * 同正文第几次出现 `occurrence`——它的唯一理由是「折进载体后行位置会变」，那个前提在折行 stamp 之后
 * 不再成立，重复正文怎么区分的那套计数也一起删了。）
 * @param {any[]} rows 账本行（store.load(runId) 的输出）
 * @param {number} fromRound 区间下界（含）
 * @param {number} toRound 区间上界（含）
 * @returns {Array<{round_no:number, msg_seq:number, text:string}>}
 */
export function collectRoundMessagesInRange(rows, fromRound, toRound) {
  const safeRows = Array.isArray(rows) ? rows : [];
  /** @type {number[]} */
  const rounds = [];
  for (const /** @type {any} */ row of safeRows) {
    const r = row?.round;
    if (Number.isSafeInteger(r) && r >= fromRound && r <= toRound && Array.isArray(row?.messages)) {
      if (!rounds.includes(r)) rounds.push(r);
    }
  }
  rounds.sort((a, b) => a - b);
  /** @type {Array<{round_no:number, msg_seq:number, text:string}>} */
  const out = [];
  for (const round of rounds) {
    const numbered = safeRows
      .map((/** @type {any} */ row, /** @type {number} */ index) => ({ row, index }));
    const fromMessageRows = numbered
      .filter(({ row }) => isMessageRow(row) && row?.round === round && Array.isArray(row?.messages))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.row.seq - b.row.seq) || (a.index - b.index));
    const fromCarrierRows = numbered
      .filter(({ row }) => !isMessageRow(row) && row?.round === round && Array.isArray(row?.messages));
    // 轮内顺序照旧（消息行在前、轮载体行在后）；地址不再自己算，逐条问 `messageRowPosition`。
    for (const { row } of [...fromMessageRows, ...fromCarrierRows]) {
      row.messages.forEach((/** @type {any} */ message, /** @type {number} */ index) => {
        const position = messageRowPosition(message, row, index);
        if (position === null) return; // 取不到稳定位置 ⇒ 这条消息不可寻址，不交出去
        const text = messageTextUnits(message).join("");
        out.push({ round_no: position.round_no, msg_seq: position.msg_seq, text });
      });
    }
  }
  return out;
}
