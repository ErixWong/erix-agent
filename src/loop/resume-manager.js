import { cloneState } from "./budget.js";
import { blocksFor, mergeToolResultsIntoMessages } from "./messages.js";
import { MESSAGE_ROW_KIND, isRoundCarrier, nextMessageSeqByRound, foldLedgerMessages, foldMessageRows } from "../store/message-rows.js";
import { extractL0Facts } from "../reflection/l0.js";
import { buildTimeline } from "../reflection/judge.js";
import { pendingTailToolUses, answerPendingMidSequenceToolUses, RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT, RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY, RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER } from "./pending-tool-result.js";
import { planResumeNotice } from "./resume-notice.js";
import { injectFoldSummaryIntoHead, planFoldedHistoryTrim } from "../compact/resume-fold-trim.js";
import { validateRunState } from "../run-state.js";

const rowKeyOf = (record) => {
  const key = record?.dedupKey ?? record?.roundKey;
  return typeof key === "string" ? key : "";
};

// issue #425：**恢复锚点必须在恢复时现算**，不能信快照里的 `persistedTranscriptLength`——
// 那是 partialPersistence 定时器写快照**那一刻**的采样。之后工具结果行 / 终稿 assistant 行还会
// 继续落盘（写侧「一条消息一成型就落盘」），于是快照里的值比账本少（实测 28/28 次快照当场
// `write === read`，恢复时却少 2）⇒ `slice(0, anchor)` 把已经落盘的正文当成「崩溃之后宿主追加的」
// 尾队列，终稿正文被喂给模型两遍。
//
// 现算口径统计折叠后的逻辑消息条数，**尾部**的宿主追问行不算（它属于尾队列，补跑结果之后再接回）。
// 只排除**尾部**的宿主行：上一次恢复留下的追问行夹在中间时，它已经在模型的上下文里了，必须计入
// （否则按条数切片会切在一条逻辑消息中间，或者把历史追问挤进尾队列）。
//
// 归属判据 = **键 + 形状**两件事实，顺序是「键优先、形状兜底」（issue #425 评审阻塞）：
//   ① 键是引擎**独占**命名空间 = `:engine:`（`<runId>:engine:…`；`:resume` / `:control:` / `:fold:` /
//      `:ttl:` 这些载体**都写在 `:engine:` 下面**）⇒ 引擎行。**必须按键先判**：这些载体的形状**也可能**是
//      「单条 user/text」（`…:engine:round:<n>:control:resume-notice` 带一条真消息就是那一格），形状判据
//      优先就会把引擎自己的载体误判成宿主尾队列。⚠ 独占命名空间**只有** `:engine:`：裸 `:control:` 不是
//      （把它并进来，`myapp:control:x` 这类契约内合法的宿主自定键会被判成引擎行 ⇒ 0 请求 + `invalid_messages`）。
//   ② 键是宿主命名空间（`<runId>:input:…`，`src/store/append-user-turn.js`）或宿主自定键 ⇒ 宿主行。
//   ③ 键**不足以**定归属——`<runId>:round:<n>`（契约 `docs/host-consumer-contract.md` 自己叫它
//      "host default key"，宿主照抄它完全合法）、`<runId>:msg:<round>:<seq>`（引擎逐条消息行用过的
//      命名空间）、以及**根本没有键**的远古行 ⇒ 看**形状**：`appendUserTurn` 的产出形状是
//      `{ round, messages: [user(text)], dedupKey, roundKey, ts }`，即「没有 `kind`、没有安全整数
//      `seq`、恰好一条 `role:"user"` 消息、content 全是 text」⇒ 宿主预写行；其余 ⇒ 引擎行。
//      引擎自己的 `<runId>:msg:` 行**恒带** `kind:"message"` 与安全整数 `seq`，老账本的
//      `<runId>:round:<n>` 轮行带的是整轮正文（assistant / tool_result），两者都落不进那个形状。
//
// 为什么不能只认键（旧口径，`key === "" || /:(?:engine|msg|round):/`）：宿主用引擎形态的键或干脆
// 不写键时，它的追问行被算进**崩溃现场** ⇒ 补跑结果插错位置 ⇒ `invalid_messages` + **零请求**
// （现场已落 1 条结果行时是**静默改序**：宿主追问排到【恢复运行】告示**之前**，与契约的形状相反）。
// 契约只写宿主 **should** 走 `appendUserTurn`（`:1090`），`:964` 还允许 dedup 回落到 store 生成的
// `<runId>:round:<n>`，`orchestrator.js` 的注释也明写「宿主可能已用默认键」——按「必须走
// `appendUserTurn`」立论，就是把 main 上可恢复的现场改成永久不可恢复。
const ENGINE_ONLY_KEY = /:engine:/u;
const AMBIGUOUS_KEY = /:(?:msg|round):/u;

/** `appendUserTurn` 的产出形状（宿主预写行）：没有 `kind` / 安全整数 `seq`，恰好一条 `user` 消息，
 * content 全是 `text` 块。形状判据只回答「像不像宿主预写行」，**不**单独决定归属（见上面的顺序）。
 * @param {any} record
 * @returns {boolean}
 */
function hasHostPreWriteShape(record) {
  if (record?.kind !== undefined) return false;
  if (Number.isSafeInteger(record?.seq)) return false;
  const messages = record?.messages;
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  const [message] = messages;
  if (message?.role !== "user") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.length > 0 && content.every((block) => block?.type === "text");
}

/** 这一行是不是引擎自己写的账本行。判别顺序见上面那段注释：键独占 ⇒ 引擎；宿主命名空间/自定键 ⇒
 * 宿主；**键不足以定归属时**（`:round:` / `:msg:` / 无键）才看形状。
 * 实例（「形状像预写、但按键归引擎」）：`{ dedupKey: "r:engine:round:1:control:resume-notice",
 * messages: [userText("【恢复运行】…")] }` 形状与宿主预写行逐字相同，但键是引擎独占命名空间 ⇒ 引擎行。
 * @param {any} record
 * @returns {boolean}
 */
function isEngineLedgerRow(record) {
  const key = rowKeyOf(record);
  if (ENGINE_ONLY_KEY.test(key)) return true;
  if (key !== "" && !AMBIGUOUS_KEY.test(key)) return false;
  return !hasHostPreWriteShape(record);
}

/**
 * 恢复锚点：账本里「崩溃那一刻**已经落盘**」的折叠逻辑消息条数（issue #425）。
 *
 * 纯函数，单一职责：输入账本行（`store.load()` 的折叠行或原始行都行），输出条数。
 * 口径 = 去掉**尾部**宿主行之后，按 `foldLedgerMessages` 折出来的逻辑消息数
 * （`partOf` 分片接回它指认的那条消息，分片不加）。
 *
 * 为什么不是「全账本条数」：宿主追问行（`…:input:…`，或宿主用默认键 / 无键写的预写行）是崩溃之后
 * 才写的，把它算进崩溃现场会让补跑结果插到它前面（`validateMessages` 当场 `invalid_messages`）。
 * 为什么不是「只数引擎行」：上一次恢复留下的追问行夹在中间，只数引擎行会把条数压小，
 * 切片同样会错位。
 *
 * @param {Array<object>} records
 * @returns {number}
 */
export function countResumeAnchor(records) {
  const rows = Array.isArray(records) ? records : [];
  let end = rows.length;
  // `end > 1`：账本的**第一行**是这个 run 的种子（round 0，引擎在任何请求之前写的），它不是「崩溃之后
  // 宿主追加的」东西，尾队列最多从第二行开始。这一条同时把「无键的远古种子行」从形状判据的歧义里救回来：
  // 它与宿主预写行都是「单条 user/text」形状，区别只在**位置**（种子在最前、追问在末尾）。
  while (end > 1 && !isEngineLedgerRow(rows[end - 1])) end -= 1;
  return foldLedgerMessages(rows.slice(0, end)).length;
}

/**
 * issue #736：**崩溃边界必须从账本推，不从快照推**。
 *
 * 病根（#734 的后果放大器）：`crashSiteRound` 的判据来自 run snapshot，而 #734 那次失败的写
 * **正是快照本身**（`checkpoint_before_tool` fail-closed ⇒ 最新可用快照是上一轮那份）⇒ 探测器跟
 * 现场一起消失 ⇒ 既不裁锚点、也不结清尾部 ⇒ 账本里那条悬空 `tool_use` 落在**中段**，被 #421 的
 * 「同页合并」纪律（`pendingMidSequenceToolUses` 的 `results.length === 0`）跳过 ⇒ 每次请求在任何
 * 出网之前被本地 `validateMessages` 拒掉（真机一例：7 次同类 `run_end`，报错 index 从 685 漂到 693）。
 *
 * 所以边界必须与**快照的新鲜度/存在性无关**，只吃账本。判据（工单 #736 原文，别改写成第二套）：
 *   最大下标 `i`，使 `ledgerEntries[i]` 是带 `tool_use` 的 assistant、其 id 不在
 *   `settledToolResultIds`（#420 的权威口径）里，且 `i` **之后**的每一行要么带 `tool_result`、
 *   要么是宿主预写的纯文本用户行、要么是引擎控制行。
 *
 * 三条实现取舍（都有理由，别顺手简化）：
 *   ① **候选行要求「该条 assistant 的 `tool_use` 全部未结清」**（不是「有一个未结清就算」）。
 *      部分结清（`assistant[X,Y]` + `user[result X]`）是 #421 的**中段**形状：它的出口是同页合并桩
 *      （下一条 user 已经带着结果），不是尾部结清。按这种行裁切会把**已落账的那条结果行**挤进尾
 *      队列，尾部结清再补一张同 id 的桩 ⇒ 同一个 id 两份结果 ⇒ 把可恢复现场变成不可恢复。
 *   ② **其后行的归属沿用 `isEngineLedgerRow`**（由调用方经 `isEngineRow` 注入），本函数**不**新写
 *      第二份配对逻辑（#394 的纪律）。带 `tool_result` 的行一律放行：它不会把悬空块从尾部挤走。
 *      「引擎控制行 / 宿主预写行」共有的形状是「一条 `user` + 纯文本」，而**合法的消息序里
 *      悬空 `tool_use` 之后不可能跟着这样一行**（`validateMessages` 当场拒），所以按这个形状放行
 *      不会把「崩溃之后继续跑的正文」误算进崩溃现场。
 *   ③ 归属**未知**（调用方没给 `isEngineRow`，或镜像条数对不上）时走宽松档：只按 ② 的形状放行，
 *      引擎正文行（assistant）照旧判 false ⇒ 宁可判成「边界不成立」（= 修复前的行为），也不误裁。
 *
 * 边界成立之后**不做**任何新的消息页形状：调用方按 `i + 1` 切片 ⇒ 悬空块变成**尾部** ⇒ 走既有
 * `answerPendingTailToolUses`（注入告示之前那一步）结清，宿主预写行照旧最后接回（#421 的候选 (b)
 * 「插页」在有边界之后不需要）。
 *
 * @param {Array<{message?: any, round?: number}>} ledgerEntries `foldLedgerMessages(records)` 的输出
 * @param {Set<any>} settledToolResultIds 账本里已有结果行的 `tool_use` id 集合（#420 口径）
 * @param {(entry: any, index: number) => boolean|undefined} [isEngineRow] 这一行的**归属**：
 *   `true` = 引擎行，`false` = 宿主行，`undefined` = 未知（取舍 ③）。判据本身是 `isEngineLedgerRow`。
 * @returns {number|null} 最大下标 `i`；`null` = 边界不成立（正常收口，不结清也不裁切）
 */
export function deriveLedgerCrashBoundary(ledgerEntries, settledToolResultIds, isEngineRow) {
  const entries = Array.isArray(ledgerEntries) ? ledgerEntries : [];
  const settled = settledToolResultIds instanceof Set ? settledToolResultIds : new Set();
  const toolUsesOf = (entry) => blocksFor(entry?.message?.content)
    .filter((block) => block?.type === "tool_use");
  // 取舍 ②：`i` 之后允许出现的行
  // ——结果行 / 宿主预写行 / 引擎控制行，三者共有的特征是
  // 「这一行不可能是崩溃**之前**的对话正文」。
  const isPostCrashEntry = (entry, index) => {
    const blocks = blocksFor(entry?.message?.content);
    if (blocks.some((block) => block?.type === "tool_result")) return true;
    if (typeof isEngineRow === "function" && isEngineRow(entry, index) === false) return true;
    // 引擎控制行（#323 的 marker：
    // `meta.source === "judge-control"`）——恢复告示 / 方向提示 / 扩轮指令。
    // **不**用「user + 纯文本」那个形状当判据：宿主把预写行带上
    // `kind:"message"`（`#425` 钉过的契约外
    // 形状）时形状与告示逐字相同，按形状放行会推翻
    // #425 那条「判引擎 ⇒ 零请求」的边界。
    const message = entry?.message;
    return message?.role === "user" && message?.meta?.source === "judge-control";
  };
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const uses = toolUsesOf(entries[index]);
    if (entries[index]?.message?.role !== "assistant" || uses.length === 0) continue;
    // 取舍 ①：只要有一个 id 已在账本结清，这一行就不是尾部结清的料（那是 #421 的中段格子）。
    if (uses.some((block) => settled.has(block?.id))) continue;
    // 「最大下标」+ 取舍 ②：后缀里只要有一行是崩溃**之前**的正文，边界就不成立（更早的下标后缀更长，
    // 同样不成立 ⇒ 直接返回 null，不必继续回溯）。
    for (let tail = index + 1; tail < entries.length; tail += 1) {
      if (!isPostCrashEntry(entries[tail], tail)) return null;
    }
    return index;
  }
  return null;
}

/**
 * 给 {@link deriveLedgerCrashBoundary} 造**逐条**归属：`ledgerEntries[index]` 那一行是不是引擎写的。
 *
 * `foldLedgerMessages` 的输出只有 `{message, round}`（`dedupKey` 在行上，折叠后拿不到），而归属判别
 * （#425 的口径）**必须先看键**——`…:engine:round:<n>:control:resume-notice` 与宿主预写行形状逐字相同，
 * 只看形状会把引擎自己的告示判成宿主行。所以这里按 `foldLedgerMessages` **同一条**「`partOf` 分片不加
 * 条目」的规则，把每条逻辑消息对应回它自己那一行，再问 `isEngineLedgerRow`。
 *
 * 条数对不上（调用方传的 rows 与折出 entries 的口径不一致）⇒ 返回 `undefined`，让边界走取舍 ③ 的
 * 宽松档；这里**不**猜归属。
 *
 * @param {Array<object>} records `store.load()`（必要时先 `foldMessageRows`）的行序列
 * @param {number} expected `ledgerEntries.length`
 * @returns {((entry: any, index: number) => boolean)|undefined}
 */
function ledgerRowAttribution(records, expected) {
  const rows = Array.isArray(records) ? records : [];
  const flags = [];
  /** @type {Map<string, number>} 与 `foldLedgerMessages` 同一个 key → 下标表（分片 key 指向「下一条」） */
  const keyToIndex = new Map();
  for (const record of rows) {
    const key = rowKeyOf(record);
    if (key !== "") keyToIndex.set(key, flags.length);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const partOf = typeof record?.partOf === "string" ? record.partOf : "";
    if (partOf !== "" && keyToIndex.get(partOf) !== undefined && messages.length === 1) continue;
    for (let offset = 0; offset < messages.length; offset += 1) {
      flags.push(isEngineLedgerRow(record));
    }
  }
  if (flags.length !== expected) return undefined;
  return (_entry, index) => flags[index];
}

/**
 * issue #421：把「上下文里那条聚合 `tool_result` user 消息」映射回**账本里承载它的那一行**的 key。
 *
 * 为什么需要：中段补桩要落成一条 `partOf` 指向**该聚合消息首片**的分片行（#430 的纪律：锚点只钉在
 * 首片、分片 key 不是合法的 `partOf` 目标），而折叠后的逻辑消息序列里看不出「这条消息是哪一行落的」。
 * 判据：`kind:"message"` + 安全整数 `seq` + **首片**（无 `partOf`）+ 轮号相同 + user 消息，且**第一个
 * block** 就是那条聚合消息的第一个 `tool_result`（写侧每个结果单独落一行，首片 content 就是
 * `[toolResult]` ⇒ 首个 `tool_use_id` 足以认人）。
 *
 * 找不到 ⇒ 返回 `undefined`，调用方**不入账**、只留内存里的桩。硬写一行会被折叠层当成「该轮多出来的
 * 一条正文」⇒ 桩变成另一条 user 消息（孤立 `tool_result`），比修前更坏。
 *
 * 入参是**落盘行**：`store.load()` 的返回值，或（issue #714）store 提供的可选原始行读口
 * `loadRawRows` 的未折叠行。后者是**已完成轮**那一格的唯一出路：内置两个 store 的 `load()` 都跑
 * `foldMessageRows`，那种轮的消息行已被吸进轮载体 ⇒ 折叠后的行里没有合法的 `partOf` 目标。store
 * 不提供这个读口 ⇒ 这一格退回修前口径（只修本次内存 + `resume_journal_skipped`），那是**缺能力时的
 * 降级**，不是设计终态。
 *
 * 残留风险（有意接受）：provider `id` 不保证 run 内唯一（issue #284），同轮两条聚合消息首个
 * `tool_use_id` 相同时会认到先出现的那一行 ⇒ 桩落进同轮另一条聚合消息（不报错、不丢块，形状不对）。
 *
 * **该轮载体已带正文 ⇒ 不给锚点（issue #729）**：见 `roundHasBodyCarrier`。宿主把折好的载体行与
 * 原始消息行**两份都留**时（`#401` R3 的事故现场就是它），桩一落账就绕开 R3 守卫（折出来的那份多
 * 出桩这一块 ⇒ 判不等）⇒ 整轮正文拼第二遍、`load()` 出一份重复轮的账。宁可退回 #421 的降级（桩只
 * 修本次上下文 + 发一条 `resume_journal_skipped`），也不写一份会翻倍的账。
 *
 * @param {any[]} rows `store.load()` 返回的行
 * @param {any} message 上下文里的那条聚合消息
 * @param {number|undefined} round 该消息的轮号
 * @returns {string|undefined}
 */
function firstSliceRowKeyOf(rows, message, round) {
  const head = blocksFor(message?.content).find((block) => block?.type === "tool_result");
  if (head === undefined || head.tool_use_id === undefined) return undefined;
  const scanned = Array.isArray(rows) ? rows : [];
  if (roundHasBodyCarrier(scanned, round)) return undefined;
  for (const row of scanned) {
    if (row?.kind !== MESSAGE_ROW_KIND) continue;
    if (!Number.isSafeInteger(row.seq)) continue;
    if (typeof row.partOf === "string" && row.partOf !== "") continue;
    // issue #729：轮号是整数时 `row.round` 必须**严格相等**。旧写法把「`row.round` 不是安全整数」
    // 当成「不排除」，而折叠层（`src/store/message-rows.js`）对没有整数 `round` 的行一律不当折叠
    // 目标 ⇒ 命中那种行等于保证桩落成**孤儿 `user` 消息**（`user tool_result has no matching
    // assistant tool_use`），另一种 `invalid_messages`。
    if (Number.isSafeInteger(round) && row.round !== round) continue;
    // 轮号未知（`messageRounds` 没有这条消息）：退回逐行判据——候选行自己那一轮已有带正文的载体 ⇒
    // 同样不给锚点（同一条纪律，不因为「轮号算不出来」就放开）。
    if (!Number.isSafeInteger(round) && roundHasBodyCarrier(scanned, row.round)) continue;
    const [only] = Array.isArray(row.messages) ? row.messages : [];
    if (only?.role !== "user") continue;
    const first = blocksFor(only.content)[0];
    if (first?.type === "tool_result" && first.tool_use_id === head.tool_use_id) return rowKeyOf(row);
  }
  return undefined;
}

/**
 * issue #729：这一轮在**同一份落盘行**里是否已经有「带着正文的载体行」。
 *
 * 判据与折叠层逐字同源：载体形态 = `isRoundCarrier`（key 以 `:round:<n>` / `:round:<n>:resume` 结尾），
 * 「带着正文」= `messages.length > 0`。为什么这一格必须由**定锚侧**判：折叠层唯一的守卫（#401 R3）
 * 是「载体现有正文 **逐字段深比较** 从消息行折出来的正文」，桩分片行进了消息行集合之后，折出来的
 * 那份多出桩那一块 ⇒ 判不等 ⇒ 走 `attached` 分支把整轮正文再拼一遍。定锚侧看不见「深比较」的结果，
 * 只能看「载体有没有正文」——所以口径取**宁可保守**：有正文就不给锚点（退回 #421 的降级）。
 *
 * 反例（`…:round:<n>:resume` 载体带的是方向提示那几条引擎控制正文，同轮消息行装的是崩溃轮正文、
 * **必须**照常折进去）只影响「折叠怎么折」，不影响「桩能不能落账」：那种轮上写桩同样是「折出来的
 * 那份 ≠ 载体现有正文」⇒ 一样进 `attached` 分支。降级在这一格是**正确**选择，不是损失。
 *
 * @param {any[]} rows
 * @param {number|undefined} round
 * @returns {boolean}
 */
function roundHasBodyCarrier(rows, round) {
  if (!Number.isSafeInteger(round)) return false;
  return (Array.isArray(rows) ? rows : []).some((row) => (
    Array.isArray(row?.messages) && row.messages.length > 0 && isRoundCarrier(row, round)
  ));
}

/**
 * 桩拿不到锚点时，把「**哪一种**拿不到」写成宿主可读的 `detail`（issue #730）。
 *
 * 修前这三件完全不同的事共用一个 `reason`：① 宿主没提供 `loadRawRows`（补上探针下一次就闭合）；
 * ② 该轮载体已带正文（#729，**有行也不给用**，补探针也闭合不了）；③ 探针给了、轮也干净，账本里
 * 确实没有那条首片行。只读 reason 的宿主会把 ① 当成 ③ 而不去补探针。判据与 `firstSliceRowKeyOf`
 * **同源**（同一个 `rows`、同一个 `round`、同一个 `roundHasBodyCarrier`），不另写一套。
 *
 * @param {{probeAvailable: boolean, rows: object[], round: any}} input
 * @returns {string}
 */
function midSequenceAnchorMissDetail({ probeAvailable, rows, round }) {
  if (!probeAvailable) return RESUME_JOURNAL_SKIP_DETAIL_PROBE_ABSENT;
  if (roundHasBodyCarrier(rows, round)) return RESUME_JOURNAL_SKIP_DETAIL_ROUND_CARRIER_HAS_BODY;
  return RESUME_JOURNAL_SKIP_DETAIL_ROW_NOT_IN_LEDGER;
}

export async function restoreResume(ctx) {
  if (!ctx.persistenceRequired) return;

  const restoreRunState = (restored) => {
    const validation = validateRunState(restored);
    if (!validation.ok) {
      ctx.runStateAvailability = {
        status: validation.status,
        reason: validation.reason,
      };
      return "invalid";
    }
    applyRestoredRunState(validation.state);
    return "applied";
  };

  const applyRestoredRunState = (restored) => {
    if (!restored || typeof restored !== "object") return;
    ctx.currentRunState = cloneState(restored);
    ctx.runStateVersion = Number.isSafeInteger(restored.stateVersion)
      ? restored.stateVersion
      : 0;
    const deterministic = restored.deterministic ?? {};
    for (const tool of deterministic.tools ?? []) {
      if (typeof tool?.name !== "string") continue;
      ctx.toolStats.set(tool.name, {
        calls: Number.isSafeInteger(tool.calls) ? tool.calls : 0,
        failures: Number.isSafeInteger(tool.failures) ? tool.failures : 0,
      });
    }
    // lowBudgetPrompted 属于“本次预算”类状态：预算轮数每次 runToolLoop 从 0 起算，
    // 续接会话有全新预算，不得继承上一次的“预算将尽”标记（只影响 run-state 报告口径）
    ctx.lowBudgetPrompted = false;
    ctx.foldedRoundCount = deterministic.fold?.foldedRounds ?? 0;
    ctx.navigationRecordCount = deterministic.fold?.navigationRecords ?? 0;
    ctx.toolErrorCount = deterministic.errors?.tool ?? 0;
    ctx.runSnapshotFailureCount = deterministic.errors?.checkpoint ?? 0;
    ctx.compactionStats = deterministic.compactionStats;
    // issue #386 切片 3：guard 补跑的**一次性配额**跨 resume 不重置——它就在上面那句
    // 「预算类状态一律复位」的旁边，语义**相反**：`lowBudgetPrompted` 复位是因为它只描述
    // 「本次预算将尽」（续接会话有全新预算），而这一格是成本闸：已经领过的补跑额度必须跟着
    // 这个 run 走完，否则「跑 → 崩 → resume」每次都能领一份 = 无界成本。
    // 旧档没有 `deterministic.guardExtension`（增量字段）⇒ 读成 `false`，与今天的 run 等价。
    ctx.governorState.guardExtensionUsed = deterministic.guardExtension?.used === true;
    ctx.governorState.filesWritten = Array.isArray(deterministic.filesWritten)
      ? deterministic.filesWritten.map((path) => ({ path }))
      : [];
    ctx.todoState = deterministic.todo;
    ctx.semanticState = restored.semantic;
  };

  const restorePersistedRunState = async () => {
    if (!ctx.resume || ctx.runId === undefined) return "absent";
    if (typeof ctx.store?.loadRunState !== "function") {
      // issue #78 验收修正：resume 想消费 run-state 但 store 缺 loader——
      // 走 orchestrator 的单条去重诊断（与 persist 守卫同一事件通道/语义）。
      ctx.notifyCapabilitySkipped?.("loadRunState");
      return "absent";
    }
    const stored = await ctx.store.loadRunState(ctx.runId);
    if (stored === undefined) return "absent";
    const restored = stored?.runState && typeof stored.runState === "object"
      ? stored.runState
      : stored;
    return restoreRunState(restored);
  };

  const resolveRunStateSource = (persistedResult) => (
    persistedResult === "absent" ? "record" : "independent"
  );

  const markRunState = ctx.markRunState;
  await markRunState("running");
  const persistedRunStateResult = await restorePersistedRunState();
  if (ctx.resume && ctx.store && ctx.runId !== undefined) {
    try {
      // issue #401：宿主自研 store 可能**没折**（`load()` 直接返回落盘行）。再折一次，宿主折不折都能
      // 拿到同一份时间线——守卫在 `foldMessageRows` 里（该轮载体已带这一轮正文 ⇒ 该轮跳过），
      // 所以「两份都留」的宿主也不会让正文翻倍。
      // 只有账本里**还看得见消息行**时才需要折（宿主没折 / 折了又留着原始行）；已折过的账本直接原样用，
      // 不多走一遍折叠（内置 store 这条路因此与今天逐字一致，连一次额外的数组遍历都不添）。
      const loadedRecords = await ctx.store.load(ctx.runId);
      const records = loadedRecords.some((record) => (
        record?.kind === MESSAGE_ROW_KIND && Number.isSafeInteger(record.seq)
      ))
        ? foldMessageRows(loadedRecords)
        : loadedRecords;
      if (records.length === 0) throw new Error("resume: 无可恢复记录");
      // issue #326（wo-C）：**恢复不得重算折叠摘要**——把已入账的那份灌回引擎的复用账本，
      // 于是本次进程里同一折叠输入直接命中，不再调摘要器，也不会重复落账。
      ctx.seedFoldSummaries?.(records);
      if (resolveRunStateSource(persistedRunStateResult) === "record") {
        const latestStateRecord = [...records].reverse().find((record) => (
          record?.runState && typeof record.runState === "object"
        ));
        if (latestStateRecord?.runState !== undefined) {
          restoreRunState(latestStateRecord.runState);
        }
      }
      const ledgerEntries = foldLedgerMessages(records);
      const ledgerMessages = ledgerEntries.map((entry) => entry.message);
      // 账本里**已经有结果行**的 `tool_use` id（「已结清」的权威口径，issue #420）。
      // 提到这里（原本在下面快照分支里）是因为 issue #421 的中段兜底也要它，而那条路
      // 与「有没有快照」无关：判据是账本，不是快照。
      const ledgerToolResultIds = new Set(ledgerMessages
        .flatMap((message) => blocksFor(message?.content))
        .filter((block) => block?.type === "tool_result")
        .map((block) => block.tool_use_id));
      const seedRecords = records.filter((record) => (record.round ?? 0) === 0);
      const seedMessages = seedRecords.flatMap((record) => record.messages ?? []);
      ctx.taskBriefSource = seedRecords.length > 0 ? seedMessages : [];
      // 工单 261021（第三刀·恢复只认账本）：逻辑消息序列是崩溃/续跑上下文的**唯一正文来源**。
      // 口径不是裸 `records.flatMap(record.messages)`，而是 `foldLedgerMessages(records)`：
      // 它把 `partOf` 分片接回它指认的那条消息（分片不加一条），**与载体行在场无关**
      // （理由见 `src/store/message-rows.js` 里该函数的注释）。
      // issue #425：折叠口径仍与写侧**同源**，但恢复侧已经**不读**写侧那个计数了——
      // `persistedTranscriptLength` 是快照里的采样（写侧 `+= n` 逐条累加，去重命中时还会多算），
      // 恢复锚点改由 `countResumeAnchor(records)` 在账本上**现算**（多算对它彻底惰性）。
      // 两者共同点只剩「分片不加」这一条折叠规则，不再是一条等价的计数。
      // 轮号直接带在 `ledgerEntries` 里：切片后的正文是 `cloneState` 的副本，拿身份去查轮号会落空。
      ctx.messages = ledgerMessages;
      ctx.persistedTranscriptLength = ctx.messages.length;
      let pendingTail = pendingTailToolUses(ctx.messages);
      for (const entry of ledgerEntries) {
        ctx.messageRounds.set(entry.message, entry.round);
      }
      for (const record of records) {
        // issue #326（wo-C）：**引擎事实行不进治理历史**。`…:engine:round:<n>:fold:<fp>` /
        // `…:ttl:<fp>` 这类补充记录带轮号但没有轮正文（`messages: []`），照旧走下面的分支就会给同一轮
        // 追加一条 `summary: "missing"` 的历史条目，污染 judge 看到的轮次历史。
        const isEngineFactRow = (record?.messages?.length ?? 0) === 0
          && (record?.foldedSummary !== undefined || record?.ttlDegradations !== undefined);
        if ((record.round ?? 0) > 0 && !isEngineFactRow) {
          // issue #470 判据②：这一格**不再合成字面量** `"missing"`。写侧 `parseL1Summary` 的既定
          // 兜底串（#465 已确认它是 L1 摘要的既定形状）在这里同样归一成「无摘要」⇒ judge 看到的轮次
          // 历史里不会再出现一串它没法判别真假的占位文本。条目**本身**照旧生成：governor 的历史条数
          // 与 `stalled` 的输入逐字不变，上面 `isEngineFactRow`（#326）的守卫也不动。
          const summary = record.summary === "missing" ? undefined : record.summary;
          const l0facts = record.l0facts
            // 无 l0facts 的远古记录：用共享 errorSeen 重新提取（跨记录累计；
            // 随后 restoreErrorSeen 的 Math.max 幂等，不会双计）
            ?? extractL0Facts(record.messages ?? [], {
              seenErrors: ctx.governorState.errorSeen,
            });
          const restoreErrorSeen = ctx.restoreErrorSeen;
          restoreErrorSeen(l0facts);
          const addGovernorHistory = ctx.addGovernorHistory;
          addGovernorHistory(
            record.round,
            summary,
            l0facts,
            record.ts,
            record.wrapup,
            record.judge,
          );
          // `record.messages` 是 `store.load()` 的**折叠后**形状（`src/store/message-rows.js`），不是落盘行形状：
          // 0.23 的正文在 `kind:"message"` 行里，读侧折回轮载体行（issue #353）。判据钉在
          // `test/loop-resume.test.js` 的「#353 resume 从折叠后的账本重建」两条用例。
          const recordedTimeline = buildTimeline(record.messages ?? [], 0, {
            writeToolNames: ctx.resolvedWriteToolNames,
            writeToolPathKeys: ctx.resolvedWriteToolPathKeys,
          });
          if (recordedTimeline.toolCalls.length > 0 || recordedTimeline.outputs.length > 0) {
            ctx.governorState.timeline.push({ round: record.round, ...recordedTimeline });
            ctx.governorState.timeline = ctx.governorState.timeline.slice(-12);
            for (const call of recordedTimeline.toolCalls) {
              if (ctx.resolvedWriteToolNames.has(call.name) && call.arg) {
                ctx.governorState.filesWritten.push({ path: call.arg, round: record.round });
                const trimFilesWritten = ctx.trimFilesWritten;
                trimFilesWritten();
              }
            }
            ctx.recordFileWrites(record.messages ?? [], record.round);
          }
        }
      }
      // 以最大 round 为续跑基数（含 round 0 种子记录时 records.length 会多算一轮）。
      // 双计数器约定（issue #32 #8）：`rounds` 是**身份**轮号，跨 resume 单调递增，
      // 只用于 round 编号 / roundKey / judge 已运行轮数展示 / run snapshot round；
      // 轮**预算**是 orchestrator 里每次 runToolLoop 从 0 起的 `budgetRounds`，
      // resume **不**把历史轮号当预算恢复（否则续接轮轮号已到顶，主循环一次进不了）。
      ctx.rounds = Math.max(...records.map((record) => record.round ?? 0));
      ctx.foldedThrough = Math.max(
        0,
        ...records.map((record) => record.foldedRoundRange?.to ?? 0),
      );
      const loadLatestSnapshot = typeof ctx.store.loadLatestRunSnapshot === "function"
        ? ctx.store.loadLatestRunSnapshot
        : typeof ctx.store.loadLatestCheckpoint === "function"
          ? ctx.store.loadLatestCheckpoint
          : undefined;
      // issue #736：**崩溃边界从账本推**，在加载快照**之前**算，与快照的新鲜度/存在性彻底无关。
      // 这里只交出下标 `i`（崩溃轮那条带未结清 `tool_use` 的 assistant），切片/结清全部复用既有机械。
      const ledgerBoundary = deriveLedgerCrashBoundary(
        ledgerEntries,
        ledgerToolResultIds,
        ledgerRowAttribution(records, ledgerEntries.length),
      );
      if (loadLatestSnapshot !== undefined) {
        ctx.resumeRunSnapshot = await loadLatestSnapshot.call(ctx.store, ctx.runId);
      } else {
        // issue #78
        // 验收修正：resume
        // 想消费 run snapshot 但 store 无任何 loader——
        // 单条去重诊断（loadLatestCheckpoint 旧名也缺才走到这里），跳过崩溃现场恢复。
        // ⚠ 本分支**不再**拦住上面那条账本侧边界：没有快照时，账本仍是唯一的崩溃现场来源（#736）。
        ctx.notifyCapabilitySkipped?.("loadLatestRunSnapshot");
      }
      // 工单 261021（第三刀·恢复只认账本）：崩溃现场的**正文一律来自账本**，快照只剩
      // 「跑到一半的工具调用/状态」——改造前那套「拿 `snapshot.messages` 当上下文、再按锚点
      // 把账本里『快照没见过的那段』拼回去」的算法整体删除。理由：写侧已改成「一条消息一成型
      // 就落盘」（`orchestrator.js#appendMessageRowToTranscript`
      // ），于是本轮的 assistant 正文与
      // 已完成的工具结果**已经在账本里**；快照那份正文副本此时必然**落后于**账本（它写于工具执行
      // 之前），拿它当上下文就是把正文回滚，并把
      // `resumeTailMessages` 那套「对齐快照与账本」的
      // 匹配逻辑全部作废。锚点仍在（现在是
      // **恢复时现算**的 `countResumeAnchor(records)`，issue #425），
      // 口径是**纯账本口径**：崩溃时刻账本里已落盘的逻辑消息条数（见下面
      // `ledgerMessages` 与 `anchor`）。
      const crashToolUses = ctx.resumeRunSnapshot?.pendingToolUses
        ?? (ctx.resumeRunSnapshot?.pendingToolUse ? [ctx.resumeRunSnapshot.pendingToolUse] : []);
      const unfinishedToolUses = crashToolUses.filter((toolUse) => (
        toolUse?.id !== undefined && !ledgerToolResultIds.has(toolUse.id)
      ));
      // 「崩溃现场」的判据：快照里还有账本没结清的在飞工具/半截正文。没有（正常收口后追问）
      // ⇒ 上下文就是完整账本，一条快照正文都不需要。
      const crashSiteRound = unfinishedToolUses.length > 0
        || (ctx.resumeRunSnapshot?.toolResults ?? []).some((entry) => (
          entry?.toolResult?.tool_use_id !== undefined
          && !ledgerToolResultIds.has(entry.toolResult.tool_use_id)
        ))
        || (typeof ctx.resumeRunSnapshot?.partialText === "string"
          && ctx.resumeRunSnapshot.partialText.length > 0);
      // issue #736：快照没认出来（那份快照本身就是写失败的那次，#734）不等于没有崩溃现场——
      // 账本边界成立就是崩溃现场。两者取**或**；快照那条路保留原样（B 集合的补跑集合同样靠它）。
      // issue #754（裁决 2）：旧格式（pre-261021）档案里「只在快照里」的那段崩溃轮正文，现在一条
      // 也不喂；这个局部只数「丢了几条」，交给下面那条恢复告示出声用（判据 2：禁止静默）。
      let legacySnapshotBodyDropped = 0;
      if (crashSiteRound || ledgerBoundary !== null) {
        // 工单 261021（第三刀）·issue #425 ·锚点的**现算**口径：`persistedTranscriptLength` 过去
        // 读的是快照里那份**采样**（`saveRunSnapshot` 写出的那一刻 write === read），而 partialPersistence
        // 的定时器在流式正文成型之前就写了快照，之后工具结果行 / 终稿 assistant 行还会继续落盘 ⇒
        // 恢复时锚点比账本少，`slice(0, anchor)` 把**已经落盘的**正文当成尾队列，终稿正文被喂两遍
        // （实测 provider 上下文 4 条 vs 应有 3 条）。现在一律从账本现算：
        // `countResumeAnchor(records)` = 去掉尾部宿主追问行之后折出来的逻辑消息条数。
        // 于是「它之内的正文就是崩溃现场（含本轮已落盘的 assistant 正文与已完成的工具结果），
        // 它之外的行是崩溃**之后**由宿主追加的（`appendUserTurn` 的 `:input:` 行等），
        // 必须延后到补跑结果之后再接回」。
        // issue #736：账本边界也算一个候选锚点，两者取**较早**的那个（`Math.min`）。
        // 为什么不是「边界成立就用边界」：#425 的锚点还兜着「尾部宿主行不算进现场」与「中间夹着的
        // 历史追问要算」两条纪律，而边界只看「崩溃行之后是否全是宿主/控制行」；取较早者只会把
        // 现场切得**更小**（悬空块仍在尾部），不会把已落盘正文挤进尾队列（那才是 #425 的现场）。
        const snapshotAnchor = countResumeAnchor(records);
        const anchor = ledgerBoundary === null
          ? snapshotAnchor
          : Math.min(snapshotAnchor, ledgerBoundary + 1);
        // issue #736：这一段现在也可能**没有快照**支撑（陈旧快照没带上那次在飞调用，
        // 甚至 store 里根本没有快照）⇒ 快照读点一律走 `snapshot`（缺席 = 空对象）；
        // 崩溃轮轮号在快照没给时退回**边界那一行自己的轮号**（`ledgerEntries` 的轮号，
        // 与 #425 同一个账本口径）。
        const snapshot = ctx.resumeRunSnapshot ?? {};
        const crashRound = Number.isSafeInteger(snapshot.round)
          ? snapshot.round
          : ledgerBoundary === null
            ? snapshot.round
            : ledgerEntries[ledgerBoundary]?.round;
        ctx.messages = ledgerEntries.slice(0, anchor).map((entry) => cloneState(entry.message));
        for (const [index, message] of ctx.messages.entries()) {
          ctx.messageRounds.set(message, ledgerEntries[index].round);
        }
        ctx.resumeTailMessages = ledgerEntries.slice(anchor).map((entry) => ({
          message: cloneState(entry.message),
          round: entry.round,
        }));
        // **pre-261021 的档案不再支持恢复（issue #754 裁决 2）**：这里原本是一条「升级路径」——改造前
        // 写的账本里崩溃那一轮的正文**只在快照里**（旧写侧把整轮正文留到轮末才写，而轮行因崩溃 never
        // landed），于是当「账本在锚点之后一条都没有」时，把 `snapshot.messages.slice(anchor)` 补进上下文。
        // 它服务的是死档案，而它**自己就是坏的**（现测，非推测）：`anchor` 是一个**标量**（折叠后的逻辑
        // 消息条数），不是「快照哪些下标已入账」的位图 ⇒ 第一次恢复续跑一入账，第二跳的锚点就涨过那段
        // 正文 ⇒ 第二次恢复在**发出任何模型请求之前**就 `invalid_messages`（常驻用例：
        // `test/loop-snapshot-round-residue-735.test.js` 的两跳那条，两棵写侧写法逐字同结果）。
        // ⇒ 这条通道**正式关掉**：恢复上下文一律只由账本重建，**一条正文也不从快照 `messages` 喂**
        // （写侧不动，快照照旧写「本轮残余」）。剩下的那一处读点只量**条数**，**只用于出声**（#754 判据 2
        // 「禁止把残缺上下文静默喂下去」），**不再**用于喂正文；触发判据沿用被删掉那个 `if` 的条件。
        const snapshotBody = Array.isArray(snapshot.messages) ? snapshot.messages : [];
        legacySnapshotBodyDropped = ledgerMessages.length === anchor && snapshotBody.length > anchor
          ? snapshotBody.slice(anchor).filter((message) => message !== null && message !== undefined).length
          : 0;
        // `resumeTranscriptStart` = 锚点（= 已落盘正文的条数）：下面那条 `…:resume` 行只写
        // **锚点之后**的正文（本次补跑跑出来的结果），已落盘的正文一行也不会重抄。
        ctx.resumeTranscriptStart = anchor;
        // 工单 261021（第三刀）：**补跑出来的工具结果也走「一条消息一成型就落盘」**——它们接在
        // 崩溃轮已落盘的那条聚合消息后面（`partOf` 指认它的首片行），于是下一次恢复折出来的仍是
        // 一条合法的 tool_use/tool_result 配对。两个信息只能从账本拿：本轮下一个可用 `seq`、以及
        // 该轮首片行的 dedupKey（无载体行时消息行原样留在 `load()` 输出里，所以两者都看得见）。
        // issue #424（守卫事实）：崩溃轮的正文里**是否已有 assistant 行**——判据是**已折叠的账本条目**
        // （`ledgerEntries`，按轮号看），不是 `ctx.messages`：升级路径（旧账本 + 快照补全）会把崩溃轮的
        // assistant 正文从快照补进内存，账本里却没有那一行。本函数只把事实交出去，
        // 写不写由写侧决定（`orchestrator.js#journalResumeUnpersistedToolResults`）。
        ctx.resumeCrashRoundAssistantPersisted = ledgerEntries.some((entry) => (
          entry.round === crashRound && entry.message?.role === "assistant"
        ));
        // 两个只能从账本拿的信息：**本轮下一个可用的 `seq`**（否则重跑/续跑会在同 `(round, seq)`
        // 上携不同正文 ⇒ 去重冲突），以及**该轮首片行的 dedupKey**（无载体行时消息行原样留在
        // `load()` 输出里，所以两者都看得见）。seq 的地板取「该轮已有正文的条数」：折叠过的轮里
        // 消息行已被吸进载体、`seq` 看不见，宁可跳号也不能重号（跳号只是空号，重号是冲突）。
        const seqSeed = nextMessageSeqByRound(records);
        for (const record of records) {
          if (!Number.isSafeInteger(record?.round)) continue;
          const messageCount = (record.messages ?? []).length;
          if (messageCount === 0) continue;
          seqSeed.set(record.round, Math.max(seqSeed.get(record.round) ?? 0, messageCount));
        }
        for (const [round, nextSeq] of seqSeed) {
          ctx.messageSeqByRound.set(round, Math.max(ctx.messageSeqByRound.get(round) ?? 0, nextSeq));
        }
        ctx.resumeToolResultRowKey = records.reduce((found, record) => (
          record?.round === crashRound
          && record?.kind === MESSAGE_ROW_KIND
          && Number.isSafeInteger(record.seq)
          && typeof record.partOf !== "string"
          && (record.messages ?? []).some((message) => blocksFor(message?.content)
            .some((block) => block?.type === "tool_result"))
            ? rowKeyOf(record) : found
        ), undefined);
        // 崩溃现场的轮号：账本里本轮的行可能已落（逐条入账），故取两者的较大值，绝不回退轮号。
        ctx.rounds = Math.max(ctx.rounds, crashRound);
        const partialText = snapshot.partialText;
        const partialRound = snapshot.partialRound;
        // 半截正文只补**账本里还没有的那一段**：写侧已在本轮正文一成型就落盘，所以
        // 「快照里带 partialText 而本轮 assistant 行已落」是常见路径（工具执行期崩溃）；
        // 再补一次就是把同一份正文喂给模型两遍。判据：崩溃轮的 assistant 行已在锚点之内 ⇒ 不补。
        // ⚠ 这里必须读**轮号本身**（`ledgerEntries`）而不是拿克隆后的 `ctx.messages` 去查轮号表：
        // `ctx.messages` 是 `cloneState` 的副本，身份对不上，那种写法永远返回 false
        // ⇒ partialText 会被再喂一遗（实测改造前靠「上下文整体取自快照正文」逗着，不暴露这个问题）。
        const crashRoundAssistantPersisted = ledgerEntries
          .slice(0, anchor)
          .some((entry) => entry.message?.role === "assistant"
            && entry.round === crashRound);
        if (typeof partialText === "string" && partialText.length > 0
          && Number.isSafeInteger(partialRound)
          && partialRound === crashRound
          && !crashRoundAssistantPersisted) {
          const partialMessage = {
            role: "assistant",
            content: [{ type: "text", text: partialText }],
          };
          ctx.messages.push(partialMessage);
          ctx.messageRounds.set(partialMessage, partialRound);
        }
        for (const id of snapshot.executedToolIds ?? []) {
          ctx.resumeExecutedToolIds.add(id);
        }
        ctx.judgeInterceptCount = ctx.resumeExecutedToolIds.size;
        for (const entry of snapshot.toolResults ?? []) {
          if (entry?.toolUseId !== undefined && entry.toolResult !== undefined) {
            ctx.resumeRunSnapshotResults.set(entry.toolUseId, entry.toolResult);
          }
        }
        // 崩溃前已归档的全量输出回填引擎缓冲，保持证据的字节保真。
        for (const output of snapshot.toolOutputs ?? []) {
          if (typeof output?.content === "string" && output.content.length > 0) {
            ctx.archivedOutputs.push({
              toolUseId: output.toolUseId,
              name: output.name,
              round: crashRound,
              content: output.content,
            });
          }
        }
        pendingTail = pendingTailToolUses(ctx.messages);
        // 崩溃前已产出、但**没来得及落盘**的结果：账本里没有 ⇒ 从快照接回来。接回的位置很讲究：
        // 它们属于崩溃那一轮的那条聚合消息，必须**合进**账本里已落盘的那条（否则 assistant 的
        // tool_use 与紧随其后的 tool_result 条数对不上，`validateMessages` 当场报 invalid_messages）。
        // issue #420：判据是账本（`ledgerToolResultIds`）不是上下文
        // （`ctx.messages`）：升级路径可能已把结果补进上下文，
        // 账本里却仍没有那一行（合并自己按 id 去重）。
        const replayResults = [...ctx.resumeRunSnapshotResults.values()]
          .filter((toolResult) => !ledgerToolResultIds.has(toolResult.tool_use_id));
        if (replayResults.length > 0) {
          if (mergeToolResultsIntoMessages(ctx.messages, replayResults) === false) {
            const replayMessage = { role: "user", content: replayResults };
            ctx.messages.push(replayMessage);
            ctx.messageRounds.set(replayMessage, crashRound);
          }
          // issue #420：**真实交接**（修前是死字段，注释承诺的入账
          // 全仓无读取方）。`restoreResume` 的 resume 分支只读 transcript 账本；
          // 账本写入一律在 orchestrator（`appendMessageRowToTranscript` / `persist`），
          // 失败语义与 `seq` 计数器只有一处。写入口在 orchestrator 的
          // `journalResumeUnpersistedToolResults`：补跑段之前逐条写成消息行。
          ctx.resumeUnpersistedToolResults = replayResults;
        }
        const pendingTools = snapshot.pendingToolUses
          ?? (snapshot.pendingToolUse
            ? [snapshot.pendingToolUse]
            : []);
        ctx.resumePendingTools = pendingTools.filter((pendingTool) => (
          !snapshot.executedToolIds?.includes(pendingTool.id)
          && !ctx.resumeRunSnapshotResults.has(pendingTool.id)
          // 账本已经结清的结果不再补跑（逐条入账后，这是「已落盘」的权威口径）。
          && !ledgerToolResultIds.has(pendingTool.id)
        ));
      }
      // ── issue #421：**中段**悬空 `tool_use` 的读侧兜底 ────────────────────────────────────
      // 位置：上下文重建完（含 A 集合的内存合并）之后、**任何模型请求之前**、任何裁剪之前（裁剪只动
      // 上下文，不动账本；桩要跟着它所属的那条聚合消息走）。
      // 判据是**账本**，但**逐对**判（issue #730 第 1 格）：「这一对」= 那条 assistant 与它紧接的聚合
      // 消息，而`pendingMidSequenceToolUses` 的 `missing` 算的就是「这一对的聚合消息里没该 id 的结果块」
      // ——与 `validateMessages`（`src/messages/rounds.js`）同粒度。修前这里并的是**全 run** 的
      // `ledgerToolResultIds`：同一个 `tool_use_id` 在**别的轮**结清过（provider 不保证 id run 内唯一，
      // issue #284）就被当成这一对也结清了 ⇒ 桩被抑制、这一对永不闭合 ⇒ 每次请求出网前本地拒掉，
      // 这个 runId 永久起不来。幂等不受影响：桩落的那一页就是这条聚合消息，下一次恢复时 `missing`
      // 自己就不带它了（#714 那三条「三次恢复」用例钉着）。
      // 剩下的排除集只有「**本进程马上要产出真结果**」的两批：A 集合（结果已成型、只差入账）与
      // B 集合（补跑段会重跑并接回同一条聚合消息）。这两批与「哪一对」无关，必须一律排除：它们的真
      // 结果会并进那条聚合消息，而桩已占了同一个 `tool_use_id` ⇒ 同一条消息里两个同 id 的结果 ⇒ id
      // 集合对不上（补桩反而把可恢复的现场变成不可恢复）。这不是放宽判据：能配上对的不得出现桩行。
      const midSequenceInFlightIds = new Set();
      for (const toolResult of ctx.resumeUnpersistedToolResults) {
        if (toolResult?.tool_use_id !== undefined) midSequenceInFlightIds.add(toolResult.tool_use_id);
      }
      for (const pendingTool of ctx.resumePendingTools) {
        if (pendingTool?.id !== undefined) midSequenceInFlightIds.add(pendingTool.id);
      }
      // 入账由 orchestrator（`journalResumeMidSequenceToolResults`）用 `partOf` 指向**首片**完成；
      // 这里只交出「补了哪几张、该写向哪一行」。锚点在**落盘行**上找，不是引擎再折一遍的 `records`：
      // 后者里的消息行可能已被吸进载体（没有 `seq`、也就没有 `partOf` 目标）。
      // issue #714：可选原始行读口 `loadRawRows` 交出 `load()` 的**未折叠输入**。内置两个 store 的
      // `load()` 都折叠，**已完成轮**的首片行只剩在原始行里 ⇒ 没有它那一格永远拿不到锚点；提供它时
      // 账本才闭合。缺这个读口 ⇒ 逐字退回修前口径（只修内存 + `resume_journal_skipped`），不抛错。
      const anchorProbeAvailable = typeof ctx.store.loadRawRows === "function";
      const anchorRows = anchorProbeAvailable
        ? await ctx.store.loadRawRows(ctx.runId)
        : loadedRecords;
      // issue #730：「引擎放弃了这一格」的成因（普查判悬空而合并拒了 / 非目标形状）从这里交出去，
      // 发事件一律在 orchestrator（事件面只有一处）。本模块不持有 `onEvent`。
      /** @type {Array<{reason: string, detail: string|undefined, round: any, toolUseIds: any[], assistantIndex: number}>} */
      const midSequenceAbandons = [];
      const midSequenceStubs = await answerPendingMidSequenceToolUses(ctx.messages, {
        pendingResultIds: midSequenceInFlightIds,
        roundOf: (message) => ctx.messageRounds.get(message),
        anchorOf: (message) => firstSliceRowKeyOf(
          anchorRows,
          message,
          ctx.messageRounds.get(message),
        ),
        onAbandon: (entry) => { midSequenceAbandons.push(entry); },
      });
      // 找不到锚点的桩：把「**哪一种**找不到」也写成事实（issue #730：同一个 reason 下原来混着两件事，
      // 宿主读不出「补上 `loadRawRows` 就能闭合」那一格）。只对真要入账而锚点缺失的桩算。
      for (const stub of midSequenceStubs) {
        if (typeof stub?.partOf === "string" && stub.partOf !== "") continue;
        stub.anchorMissDetail = midSequenceAnchorMissDetail({
          probeAvailable: anchorProbeAvailable,
          rows: anchorRows,
          round: stub.round,
        });
      }
      ctx.resumeMidSequenceToolResults = midSequenceStubs;
      ctx.resumeMidSequenceAbandons = midSequenceAbandons;
      // 真要落账的那几张桩：把所属轮的 `seq` 地板抬到「落盘行里最大 `seq` + 1」。本单是第一个往
      // **已完成轮**写消息行的调用点，而那种轮的消息行在折叠后的行里已被吸进载体 ⇒ 崩溃现场那一段的
      // 「按正文条数」地板会算小，分片行重号 ⇒ `dedup_payload_conflict`（既不覆盖也不静默丢弃，整 run
      // 崩）。地板与锚点**同源**（`anchorRows`：原始行看得见 `seq`）。没有桩要写 ⇒ 一个字节都不碰。
      const journaledRounds = new Set(midSequenceStubs
        .filter((stub) => typeof stub?.partOf === "string" && stub.partOf !== "")
        .map((stub) => stub.round)
        .filter((round) => Number.isSafeInteger(round)));
      if (journaledRounds.size > 0) {
        const rawSeqSeed = nextMessageSeqByRound(anchorRows);
        for (const round of journaledRounds) {
          const floor = rawSeqSeed.get(round);
          if (floor === undefined) continue;
          ctx.messageSeqByRound.set(round, Math.max(ctx.messageSeqByRound.get(round) ?? 0, floor));
        }
      }
      // issue #462：**按折叠水位线裁续跑正文**（#460 只修了写侧，读侧一个字节都没省）。
      // 今天 `ctx.messages` 是整段未折账本 ⇒ 续跑第一次折叠必然从 round 1 重折：摘要器重算
      // （#326 的复用因区间漂移而 miss）、`keepRounds` 被 2× 判据压到 2、`tokensBefore` 虚高。
      // 这里把水位线以下的轮次从上下文里摘掉，并把**模型本来就在看的那份摘要**（#326 落的
      // `record.foldedSummary` 事实）按折叠自己的形状并回头部 ⇒ 续跑形状回到崩溃前那一刻。
      // 挑不出覆盖水位线的摘要事实时**整段原样保留**（判据 3：被误判成未折的区间必须在上下文
      // 里可见，不许档案与上下文两边都静默）。口径与边界见 `src/compact/resume-fold-trim.js`。
      const foldWatermark = ctx.foldedThrough;
      const contextEntries = ctx.messages.map((message) => ({
        message,
        round: ctx.messageRounds.get(message) ?? 0,
      }));
      const foldTrim = planFoldedHistoryTrim({
        ledgerEntries: contextEntries,
        records,
        foldedThrough: foldWatermark,
      });
      if (foldTrim.applied) {
        const keptMessages = foldTrim.messages.map((entry) => entry.message);
        const trimmedMessages = injectFoldSummaryIntoHead(keptMessages, foldTrim.summaryText);
        // 轮号表按**对象身份**查（`orchestrator.js#roundNumbersForMessages`），而注入会换掉那条
        // head 消息的对象（或插一条新的）⇒ 必须把轮号一并搬过去，否则那条 seed 任务的轮号会从
        // 0 掉进兜底分支，把已折区间重新数进轮号。
        const roundByNewMessage = new Map();
        if (trimmedMessages.length === keptMessages.length) {
          for (const [index, message] of trimmedMessages.entries()) {
            roundByNewMessage.set(message, foldTrim.messages[index].round);
          }
        } else {
          // 注入成独立 user 消息（只有 head 里没有真实 user 消息时才走到这里）：那条正文属于
          // 已折区间，按水位线记轮号最贴近它被折走时的身份。
          let cursor = 0;
          for (const message of trimmedMessages) {
            const entry = foldTrim.messages[cursor];
            if (entry !== undefined && entry.message === message) {
              roundByNewMessage.set(message, entry.round);
              cursor += 1;
            } else {
              roundByNewMessage.set(message, foldWatermark);
            }
          }
        }
        for (const entry of foldTrim.dropped) {
          ctx.messageRounds.delete(entry.message);
        }
        for (const [message, round] of roundByNewMessage) {
          ctx.messageRounds.set(message, round);
        }
        ctx.messages = trimmedMessages;
      }
      // issue #404：恢复运行要告诉模型这是复活赛（拼装/幂等见 `src/loop/resume-notice.js`）。
      // issue #754（裁决 2）：第 4 个实参是「本次丢弃了几条只在快照里的旧格式正文」——它只让告示
      // **多一句弃用说明**（0 时一个字都不多），不参与任何判据。
      ctx.resumeNotice = planResumeNotice(ctx, records, pendingTail, legacySnapshotBodyDropped);
    } catch (error) {
      const fail = ctx.fail;
      await fail(error);
    }
  } else if (ctx.store && ctx.runId !== undefined && ctx.messages.length > 0) {
    // 种子记录：初始消息（initialMessages/initialUserMessage）先入档，
    // 否则它们永不在 store 中，fold 后的初始历史将无法用于恢复（ADR-002 档案完整性）。
    const persist = ctx.persist;
    const persisted = await persist("appendRound", ctx.runId, {
      round: 0,
      roundKey: `${String(ctx.runId)}:round:0`,
      // 引擎命名空间：宿主/上一次运行的默认键行不应把本次种子去重没（transcript 完整性）
      dedupKey: `${String(ctx.runId)}:engine:round:0:seed`,
      messages: [...ctx.messages],
      summary: "missing",
      l0facts: extractL0Facts(ctx.messages),
      ts: new Date().toISOString(),
    });
    if (persisted) ctx.persistedTranscriptLength += ctx.messages.length;
  }
}
