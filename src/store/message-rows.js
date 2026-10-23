// 消息行（「一条消息一落盘」）的读侧折叠 —— 工单 261021「存储架构收敛第一刀」。
//
// 背景：改造前一轮的全部正文只在**轮记录**落盘时写一次（`src/loop/orchestrator.js` 的
// `messages.slice(roundStart)`），于是「模型已经看到、档案里还没有」的窗口覆盖整轮：工具执行期
// 崩溃 ⇒ 本轮 assistant 正文与已完成的工具结果全丢，恢复只能退回 run snapshot 的整坨 `messages`
// 副本，而那份副本与档案里的正文会在下一次恢复时**各喂一遍**（实测模型看到 2 遍）。
//
// 现在：一条消息一成型就写一条 `kind: "message"` 行（`dedupKey = <runId>:msg:<round>:<seq>`，
// `seq` 轮内从 0 单调递增；写侧在 `src/loop/orchestrator.js#appendMessageRowToTranscript`），
// 轮记录只留元数据、不再写 `messages`。**宿主可见形状不能变** ⇒ `store.load()` 在返回前把消息行
// 折回轮行（本模块），于是 `records.flatMap(record => record.messages ?? [])` 的语义
// （`src/loop/resume-manager.js#restoreResume` 重建上下文的唯一口径、`src/display/projection.js`
// 与 `bin/final-guard-support.js` 的读法）与改造前逐字一致。
//
// 折叠口径（三条，缺一不可）：
// 1. **分组**：按顶层 `round` 分组；组内按 `seq` 升序（`seq` 相同则按落盘先后）拼接 `messages`。
// 2. **载体**：拼回**轮行**——该轮里 key 以 `:round:<n>` 或 `:round:<n>:resume` 结尾的非消息行
//    （引擎轮记录 `<runId>:engine:round:<n>`、宿主默认键 `<runId>:round:<n>`、resume 预落盘行
//    `<runId>:engine:round:<n>:resume`，方向提示正文的载体守卫就钉在最后这一种）。
//    **没有载体行**（崩溃在轮行落盘之前）⇒ 消息行**原样留在数组里**，一个字节都不改：
//    `flatMap(record.messages)` 仍然拼出模型当时该看到的序列，这就是「崩溃点矩阵」用例的判据。
// 3. **老账本原样透传**：整个数组里没有可折叠消息行 ⇒ 直接返回**入参本身**（同一个引用、同一批
//    对象），不复制不改写 ⇒ 改造前的账本（轮行自带 `messages`、没有消息行）读出来逐字不变。
//
// 两个刻意的设计约束：
// · **只有带 `seq` 的消息行参与折叠**。宿主经 `src/store/append-user-turn.js` 写的 `:input:` 行
//   同样携带正文（行形状统一，投影可一视同仁；但它**不带** `kind: "message"`，因为 `appendUserTurn` 不写这个字段），但没有引擎的轮内序号、也就没有排序
//   依据；更硬的理由是 `appendUserTurn` 的幂等判据是「`store.load()` 里能看见自己那条 dedupKey」，
//   被折叠吸走就会重复追加同一轮追问。
// · **`partOf`**：一条逻辑消息的分片（一轮的多个 `tool_result` 改造前是同一条 user 消息的多个
//   content block，现在每个结果一成型就写一行）。分片行按 `seq` 接在 `partOf` 指认的那条消息后面，
//   拼回**同一条**消息 ⇒ 折叠后的 `messages` 与改造前那条聚合消息深比较相等。
//
// 折叠层挂在哪：两个内置 store 的 `load()`（`src/store/file.js`、`src/store/memory.js`）在
// `loadRecords` 之后调用本模块。`loadByDedupKey` / `loadMaxRound` 两个点查探针**不折叠**
// （它们是对原始行的探针，`appendUserTurn` 快路径要的正是「这条 key 在不在」）。
import { isDeepStrictEqual } from "node:util";

/** 消息行的 `kind` 字面值。 */
export const MESSAGE_ROW_KIND = "message";

/**
 * 可折叠的消息行：`kind === "message"` 且带轮内序号 `seq` 且带非空 `messages`。
 * @param {any} record
 * @returns {boolean}
 */
export function isFoldableMessageRow(record) {
  return record?.kind === MESSAGE_ROW_KIND
    && Number.isSafeInteger(record.seq)
    && Array.isArray(record.messages)
    && record.messages.length > 0;
}

/** 参与了消息行写入的行（含没有 `seq` 的宿主 `:input:` 行）——仅用于诊断/文档口径。
 * @param {any} record
 * @returns {boolean}
 */
export function isMessageRow(record) {
  return record?.kind === MESSAGE_ROW_KIND;
}

const rowKey = (record) => {
  const key = record?.dedupKey ?? record?.roundKey;
  return typeof key === "string" ? key : "";
};

/**
 * 这一行能不能当该轮的载体（正文挂回它身上）。口径见文件头第 2 条。
 * @param {any} record
 * @param {number} round
 * @returns {boolean}
 */
function isRoundCarrier(record, round) {
  const key = rowKey(record);
  if (key === "") return false;
  return key.endsWith(`:round:${String(round)}`) || key.endsWith(`:round:${String(round)}:resume`);
}

/** 把分片行的 content blocks 接到目标消息后面；目标消息是浅拷贝，不改动入参行。
 * @param {object} target
 * @param {object} part
 * @returns {object}
 */
function mergePartIntoMessage(target, part) {
  const targetContent = Array.isArray(target.content) ? [...target.content] : [target.content];
  const partContent = Array.isArray(part.content) ? part.content : [part.content];
  return { ...target, content: [...targetContent, ...partContent] };
}

/**
 * 给折出来的一条消息补上**它那一行**的 `ts`（issue #439 A）。
 *
 * 病根：写侧每条消息落盘时都带行级 `ts`（`orchestrator.js#appendMessageRowToTranscript` 的
 * `ts: new Date().toISOString()`），但折叠只把 `messages` 拼回载体行 ⇒ 消息成型时刻**丢了**，
 * 而载体行的 `ts` 是**轮行**落盘时刻。宿主拿 `load()` 做时间线/延迟分析时，被折叠过的消息没有
 * 时间戳。
 *
 * 口径（与 #430「锚点钉在首片」同向）：`ts` = 该逻辑消息**首片行**的 `ts`。分片合并只加 content、
 * 不改首片已经写上的 `ts`（`mergePartIntoMessage` 的浅拷贝已经保住它）；行上没有 `ts`（手写行 /
 * 不落 `ts` 的宿主 store）⇒ **缺键**，不写 `undefined`、不猜值。
 * 已有 `ts` 的消息不改写（幂等：同一份账本折两次不会把时间戳推后）。
 *
 * @param {any} message
 * @param {any} row
 * @returns {any}
 */
function stampRowTs(message, row) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
  if (typeof message.ts === "string" && message.ts !== "") return message;
  const ts = typeof row?.ts === "string" ? row.ts : "";
  return ts === "" ? message : { ...message, ts };
}

/**
 * 读侧折叠：把 `kind: "message"` 行的正文按轮拼回轮行。
 * 无消息行时返回入参本身（老账本零改写）。
 *
 * **公共 API（issue #401，`src/index.js` 导出）。** 宿主自研 `TranscriptStore` 时，`load()` 必须在
 * 返回前跑一遍本函数——契约「落盘行形状 ≠ `load()` 之后的形状」那一节的要求，在此之前宿主只能
 * 自己重写一套（而重写的那套正是 #353 / #401 两份事故的根因）。
 *
 * 入参是 **`load()` 级别的原样行**：`appendRound` 收到什么形状，就喂什么形状（`round` 分组、
 * `kind: "message"` + `seq` 排序、`partOf` 分片）。出参是**折叠后的形状**——与「一条消息一落盘」
 * 改造前（0.22 及更早）的账本 `load()` 逐字一致，于是 `records.flatMap((record) => record.messages ?? [])`
 * 仍然拼出模型当时该看到的序列。老账本（轮行自带正文、没有消息行）原样透传：**同一个引用、
 * 同一批对象**，不复制不改写。
 *
 * **幂等**：`foldMessageRows(foldMessageRows(rows))` 与 `foldMessageRows(rows)` 逐字相等。
 *
 * **逐条 `ts`（issue #439）**：折叠出的每条逻辑消息带 `ts`，取值是**该消息首片行**的 `ts`
 * （见 `stampRowTs`；分片只追加 content、不改写首片写上的戳）。行上没有 `ts`（手写行 / 不落 `ts`
 * 的宿主 store）⇒ 该消息**没有 `ts` 键**。宿主拿它做时间线/延迟分析——载体行自己的 `ts` 是
 * **轮行**落盘时刻，不是这条消息成型的时刻。
 *
 * **守卫（载体已带这一轮的正文 ⇒ 该轮跳过）**：某轮载体行的 `messages` 已经等于从该轮消息行折出来的
 * 正文（逐字段深比较相等）时，这一轮的消息行被当作**重复副本**丢弃，不再往里拼一次。这就是宿主
 * 「两份都留」（折好的载体 + 原始消息行）时唯一安全的读法：再折一遍不会让同一轮正文翻倍。
 * 引擎的 resume 路径也靠这条规则免疫（`src/loop/resume-manager.js` 会对 `store.load()` 的返回值
 * 再折一次，宿主折不折都能拿到同一份时间线）。
 *
 * @template {{ round?: number, seq?: number, kind?: string, partOf?: string, messages?: object[] }} T
 * @param {T[]} records
 * @returns {T[]}
 */
export function foldMessageRows(records) {
  if (!Array.isArray(records)) return records;
  /** @type {Map<number, { carrier: number, rows: number[] }>} */
  const groups = new Map();
  let foldable = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const round = Number.isSafeInteger(record?.round) ? record.round : undefined;
    if (round === undefined) continue;
    let group = groups.get(round);
    if (group === undefined) {
      group = { carrier: -1, rows: [] };
      groups.set(round, group);
    }
    if (isFoldableMessageRow(record)) {
      foldable += 1;
      group.rows.push(index);
    } else if (group.carrier === -1 && isRoundCarrier(record, round)) {
      group.carrier = index;
    }
  }
  if (foldable === 0) return records;

  /** @type {Set<number>} 被吸收（不再单独出现在返回数组里）的行下标 */
  const consumed = new Set();
  /** @type {Map<number, object[]>} 载体行下标 → 折回的正文 */
  const attached = new Map();
  for (const group of groups.values()) {
    if (group.carrier === -1 || group.rows.length === 0) continue; // 无载体：消息行原样留着
    const ordered = [...group.rows].sort((left, right) => (
      (records[left].seq ?? 0) - (records[right].seq ?? 0) || left - right
    ));
    const messages = [];
    /** @type {Map<string, number>} partOf 目标行 key → messages 里的下标 */
    const parts = new Map();
    for (const index of ordered) {
      const row = records[index];
      consumed.add(index);
      const key = rowKey(row);
      const partOf = typeof row.partOf === "string" ? row.partOf : "";
      const partTargetIndex = partOf === "" ? -1 : parts.get(partOf) ?? -1;
      if (partTargetIndex >= 0 && row.messages.length === 1) {
        // 分片：接到它指认的那条消息后面（分片行自身不出现在正文里）
        messages[partTargetIndex] = mergePartIntoMessage(messages[partTargetIndex], row.messages[0]);
        continue;
      }
      if (key !== "") parts.set(key, messages.length);
      messages.push(...row.messages.map((message) => stampRowTs(message, row)));
    }
    // 守卫（issue #401 R3）：该轮载体**已经带着这一轮的正文**——宿主把折好的载体与原始消息行
    // 都交给了我们。此时再把消息行拼一次就是同一轮正文重复一遍（实测 r1 变
    // assistant+user+assistant+user）。判据是「折出来的结果与载体现有正文逐字段深比较相等」，
    // 而不是「载体非空」：`…:engine:round:<n>:resume` 载体带的是方向提示那几条引擎控制正文，
    // 同轮的消息行装的是崩溃轮的正文——那一轮**必须**照常拼，按「非空就跳」会把正文丢掉。
    const carrier = records[group.carrier];
    const existing = Array.isArray(carrier?.messages) ? carrier.messages : [];
    if (existing.length > 0 && isDeepStrictEqual(existing, messages)) continue; // 已折过：消息行当重复副本丢弃
    attached.set(group.carrier, messages);
  }
  if (consumed.size === 0) return records;

  const folded = [];
  for (let index = 0; index < records.length; index += 1) {
    if (consumed.has(index)) continue;
    const record = records[index];
    const messages = attached.get(index);
    folded.push(messages === undefined
      ? record
      : { ...record, messages: [...(record.messages ?? []), ...messages] });
  }
  return folded;
}

/**
 * 从既有账本给每轮的 `seq` 计数器播种（崩溃重跑幂等）：返回「该轮下一个可用 seq」。
 * 崩溃前已落盘的消息行占了 0..max，重跑时新消息必须从 max+1 起，否则同 seq 携带不同正文会被
 * `src/store/transcript-dedup.js` 判成「同 key 异 payload」冲突（既不覆盖也不静默丢弃）。
 * @param {Array<{ round?: number, seq?: number }>} records
 * @returns {Map<number, number>}
 */
export function nextMessageSeqByRound(records) {
  /** @type {Map<number, number>} */
  const next = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!Number.isSafeInteger(record?.round) || !Number.isSafeInteger(record?.seq)) continue;
    next.set(record.round, Math.max(next.get(record.round) ?? 0, record.seq + 1));
  }
  return next;
}

/**
 * 恢复路径与**快照锚点共用的那一个口径**：把 `store.load()` 的输出拼成「一条逻辑消息一项」的序列。
 *
 * 为什么不能直接用 `records.flatMap(record.messages)`：那条式子在**载体行在场**时把 `partOf` 分片
 * 折回同一条消息（一条逻辑消息一项），在**载体行不在场**（崩溃在轮行落盘之前）时把分片原样留着
 * （每个分片各自一项）。于是同一个账本状态会因为「轮行有没有落」而给出两种条数，而写侧的锚点计数
 * （`orchestrator.js#appendMessageRowToTranscript` 里 `partOf === ""` 才加 1）只认前者。
 * 锚点与条数不同口径 ⇒ 切片会切在一条逻辑消息的中间（崩溃轮那条聚合 `tool_result` 被劈成两半），
 * 而拆出来的多条 user 消息也不再是合法形状——`src/messages/rounds.js#validateMessages` 要求一条
 * assistant 的 tool_use 由**紧随其后的那一条** user 消息结清，于是恢复出来的上下文直接
 * `invalid_messages`（实测：`resume consistency: visible stubs after recovery match the normal path`）。
 *
 * 所以这里与载体行在场无关：`partOf` 分片一律接回它指认的那条消息。已折叠的账本（分片已被
 * `foldMessageRows` 吸进载体行）走这条路是**幂等**的——看不见分片行，也就无片可接。
 * 老账本（轮行自带 `messages`、没有消息行）原样拼出，与改造前逐字一致。
 *
 * **issue #439 A：这里去掉逐条 `ts`。** `load()` 的折叠结果给每条逻辑消息带了行级 `ts`
 * （`foldMessageRows#stampRowTs`，宿主拿它做时间线），但那是**档案信封**（这条消息什么时候落盘），
 * 不是模型上下文的一部分：留在这里会让 #326 的折叠摘要复用键（`foldSummaryFingerprint` 的输入就是
 * 这些消息，见 `src/compact/fold-summary-journal.js`）在 resume 后变一次——同一份折叠输入被判成
 * 新输入，重启一次多调一次付费摘要器（实测 1 次）。所以恢复上下文一律回到「规范化消息」。
 *
 * @param {Array<{ round?: number, kind?: string, partOf?: string, messages?: object[], dedupKey?: string, roundKey?: string, ts?: string }>} records
 * @returns {Array<{ message: object, round: number }>} 逻辑消息序列（含来源轮号）
 */
export function foldLedgerMessages(records) {
  /** @type {Array<{ message: object, round: number }>} */
  const entries = [];
  /** @type {Map<string, number>} 行 key → 该行第一条逻辑消息在 `entries` 里的下标 */
  const keyToIndex = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const round = Number.isSafeInteger(record?.round) ? record.round : 0;
    const key = rowKey(record);
    // ⚠ 陷阱（issue #430）：这里对**分片行**也登记了 key，但分片不新增 entry ⇒ 它的 key 被映射到
    // 「**下一条**逻辑消息的下标」。所以分片行的 key **不是合法的 `partOf` 寻址目标**：写侧必须把锚点
    // 钉在该聚合消息的**首片**上（`src/loop/orchestrator.js` 的三处写入口——
    // `journalResumeUnpersistedToolResults`、resume 补跑段、主循环的工具结果入账——都只在首片落定时
    // 记一次 key，之后不推进）。
    // 若有人把 `partOf` 链成「上一片」，坏形状是**每隔一片落一次**（不是「第三片起恒为 `undefined`」）：
    // 每落空一次就新起一条消息、下一片又接得上。实测 3 片 ⇒ `[[t1,t2],[t3]]`、4 片 ⇒ `[[t1,t2],[t3,t4]]`、
    // 5 片 ⇒ 三段（`[[t1,t2],[t3,t4],[t5]]`）、6 片 ⇒ `[[t1,t2],[t3,t4],[t5,t6]]`；`assistant` 的
    // `tool_use` 与紧随其后的那一条 user 消息再也配不上 ⇒ 第二次恢复永久 `invalid_messages`（0 请求）。
    // 更坏的形态是**静默并进错的消息**：分片 key 指向的是「下一条逻辑消息」，若它之后恰好落了另一条
    // 逻辑消息（宿主追问、下一轮的正文……），链式 `partOf` 就把这条结果块并进**那条**消息——不报错、
    // 不丢块、形状全错（实测折出 `assistant:text+t3`）。
    // `foldMessageRows` 里同一个坑的形态不同（分片 key 根本不入 `parts`，链式 `partOf` 一律落空 ⇒ 每片
    // 自起一条消息，不会并进错的消息），结论一样：`partOf` 只认首片。
    if (key !== "") keyToIndex.set(key, entries.length);
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const partOf = typeof record?.partOf === "string" ? record.partOf : "";
    const targetIndex = partOf === "" ? undefined : keyToIndex.get(partOf);
    if (targetIndex !== undefined && messages.length === 1 && entries[targetIndex] !== undefined) {
      // 分片：接回它指认的那条消息（浅拷贝，不改入参行、也不改已折回的载体行）
      entries[targetIndex] = {
        round: entries[targetIndex].round,
        message: mergePartIntoMessage(entries[targetIndex].message, messages[0]),
      };
      continue;
    }
    for (const message of messages) entries.push({ message: withoutJournalTs(message), round });
  }
  return entries;
}

/**
 * 去掉消息上的**档案信封**字段 `ts`（issue #439 A，恢复路径专用）。
 *
 * 只在真的带 `ts` 时拷贝；没有就原样返回（老账本/手写行/宿主不落 `ts` 的 store 零改写）。
 * @param {any} message
 * @returns {any}
 */
function withoutJournalTs(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
  if (typeof message.ts !== "string") return message;
  const rest = { ...message };
  delete rest.ts;
  return rest;
}
