// @ts-check
//
// ADR-022 §1.3 / §3：折叠记录（`folds`）升为**独立事实通道**。本模块只放**两侧 store 必须逐字
// 一致**的纯函数——`seq` 分配口径、`seq` 升序排序、以及合并读的身份键——这样 `memory` 与 `file`
// 对同一操作序列必然产出逐字节相同的 `loadFolds()` 序列化结果（判据 8）。
//
// `seq` 的分配**复用** `src/compact/fold-summary-journal.js` 的 `createFoldIdentityAllocator()`
// （ADR §1.3 末段点名，不许另写一套）：`allocate(foldId)` 命中已投的 `foldId` 拿回首次那个号
// （幂等），新 `foldId` 接在已见最大值之后（严格递增）。没有可用 `foldId` 的折叠退回「已存行
// 的最大 `seq` + 1」，仍严格递增、不断档。

import { createHash } from "node:crypto";
import {
  createFoldIdentityAllocator, FOLDED_FACTS_RECORD_FIELD,
} from "../compact/fold-summary-journal.js";
import { fromFoldRecords } from "./fold-record.js";

/**
 * ADR-022 §1.3 folds 记录的列集合（九列 + 幂等键，共十项）。
 * 这张表是**表驱动断言**的判据（测试判据 1：恰好是这十项，多一个少一个都红）。
 *
 * @type {ReadonlySet<string>}
 */
export const FOLD_RECORD_COLUMNS = new Set([
  "runId", "seq", "foldId", "cutRound", "cutMsgSeq",
  // `from_round` / `rounds` 是 261128-13 补的两列：**切点单独表达不了「这一折吃了哪些轮」**。
  // 真机现场 `1–5, 6–6, 8–8`（`fold-statistical.js:834` 的原始数据）有口子——第 7 轮一轮未折，
  // 而只按「上一折切点 + 1」推会把第 7 轮误报成已折。`rounds` 同理：它不总等于区间长度。
  "fromRound", "rounds",
  "title", "description", "tokensBefore", "tokensAfter", "createdAt",
]);

/**
 * 一个 run 的折叠通道簿记：`seq` 分配器（来自复用的 `createFoldIdentityAllocator`）＋ 已存行。
 * 内存侧直接拿它当存储；文件侧拿它当**分配器**（行仍落盘），但两侧的 `seq` 口径共用同一份实现。
 *
 * @returns {{
 *   allocator: ReturnType<typeof createFoldIdentityAllocator>,
 *   seedFromRows: (rows: object[]) => void,
 * }}
 */
export function createFoldChannelBookkeeping() {
  const allocator = createFoldIdentityAllocator();
  let seeded = false;
  return {
    allocator,
    /**
     * 从**已存在的行**（内存 Map 里的、或从盘上读回的）灌回分配器：把 `lastSeq` 抬到已见最大值、
     * 并把每个 `foldId → seq` 记进分配器，于是「重投同 `foldId` 拿回同一个号」与「新折叠接在
     * 最大值之后」在跨进程 / 重新打开文件后仍成立。只灌一次（重复灌是幂等的 no-op）。
     *
     * issue #971 ②：调用方传进来的应是**合并集**（`folds` 通道 ∪ 轮记录 `foldedFacts`），
     * 而不是只有通道——否则拿不到通道（旧 transcript）或通道不完整时，新折叠会从头编号、
     * 与轮记录里已存在的 `seq` 撞车。播种口径见 `seedFoldAllocator`（有 `foldId` 走 `seed`、
     * 无 `foldId` 但有 `seq` 走 `record`）。
     * @param {object[]} rows
     */
    seedFromRows(rows) {
      if (seeded) return;
      seeded = true;
      seedFoldAllocator(allocator, rows);
    },
  };
}

/**
 * 给一条**新**折叠分配 `seq`（已投过的 `foldId` 应在此之前由调用方挡掉、根本不会走到这里）。
 *
 * - 有可用 `foldId`：直接问分配器（它即「幂等 + 严格递增」的唯一实现）；
 * - 无可用 `foldId`（非字符串 / 空串 ⇒ `allocate` 返回 `undefined`）：退回「已存行最大 `seq` + 1」，
 *   并**把这个新号按内容身份登记回分配器**（issue #971 ③）。不登记的话，`lastSeq` 不会前进：
 *   下一次无 `foldId` 的折叠（`existingRows` 未含它时）会重发同一个号，且有 `foldId` 的折叠
 *   会接在被低估的 `lastSeq` 之后、与它撞车。内容身份用 `foldIdentityKey`（与合并读同一口径）。
 *
 * @param {ReturnType<typeof createFoldIdentityAllocator>} allocator
 * @param {object[]} existingRows 该 run 已入账的折叠行（用于无 `foldId` 时取最大 `seq`）
 * @param {any} fold 待分配的折叠记录（读它的 `foldId` 与内容身份）
 * @returns {number}
 */
export function nextFoldSeq(allocator, existingRows, fold) {
  const foldId = /** @type {{ foldId?: unknown }} */ (fold ?? {}).foldId;
  if (typeof foldId === "string" && foldId !== "") {
    const allocated = allocator.allocate(foldId);
    if (allocated !== undefined) return allocated;
  }
  let max = allocator.lastSeq();
  for (const row of existingRows) {
    const seq = /** @type {{ seq?: unknown }} */ (row ?? {}).seq;
    if (Number.isSafeInteger(seq) && /** @type {number} */ (seq) > max) {
      max = /** @type {number} */ (seq);
    }
  }
  const seq = max + 1;
  // ③：无论有无 `foldId`，发出一个 `seq` 就必须记进分配器（无 `foldId` 时按内容哈希登记）。
  allocator.record(foldIdentityKey(fold), seq);
  return seq;
}

/**
 * 分配器播种的唯一口径（issue #971 ②③）。对合并集（通道 ∪ 轮记录 `foldedFacts`）：
 *   · 有 `foldId` 的行：走 `allocator.seed`（登记 `foldId → seq`、抬 `lastSeq`）；
 *   · 无 `foldId` 但带正安全整数 `seq` 的行：`seed` 会跳过它们（只认 `foldId`），
 *     所以改用 `record`按内容身份登记，否则这些已存在的 `seq` 抬不动 `lastSeq`、
 *     新折叠会从头编号。
 *
 * @param {ReturnType<typeof createFoldIdentityAllocator>} allocator
 * @param {object[]} rows
 * @returns {void}
 */
export function seedFoldAllocator(allocator, rows) {
  allocator.seed(rows);
  for (const row of rows) {
    const foldId = /** @type {{ foldId?: unknown }} */ (row ?? {}).foldId;
    if (typeof foldId === "string" && foldId !== "") continue;
    const seq = /** @type {{ seq?: unknown }} */ (row ?? {}).seq;
    if (Number.isSafeInteger(seq) && /** @type {number} */ (seq) > 0) {
      allocator.record(foldIdentityKey(row), /** @type {number} */ (seq));
    }
  }
}

/**
 * 从轮记录数组里取出 `foldedFacts`（与 orchestrator 的 resume 合并读同口径，issue #971 ②）。
 * 只取「存在且是对象」的那些；非数组入参 ⇒ `[]`。
 *
 * @param {any[]} roundRecords
 * @returns {object[]}
 */
export function foldRecordsFromRoundRecords(roundRecords) {
  return (Array.isArray(roundRecords) ? roundRecords : [])
    .map((record) => record?.[FOLDED_FACTS_RECORD_FIELD])
    .filter((facts) => facts !== null && typeof facts === "object");
}

/**
 * 判定一条通道行是否是**九列**形状。九列特征：有 `description` 或 `cutRound`，
 * 且没有 `text` 与 `increment`（旧 21 键形状有 `text`，有的还有 `increment`）。
 *
 * @param {any} row
 * @returns {boolean}
 */
export function isFoldRecord(row) {
  if (row === null || typeof row !== "object") return false;
  const hasNine = row.description !== undefined || row.cutRound !== undefined;
  const hasOld = row.text !== undefined || row.increment !== undefined;
  return hasNine && !hasOld;
}

/**
 * 把九列行按 `seq` 升序折成旧形状 `foldedFacts` 数组。
 * 逐行：传前缀 `sorted[0..i]`，`previousCutRound` 取 `sorted[i-1]?.cutRound`。
 * `source`/`strategy` 不传（九列里没有来源）。
 *
 * @param {object[]} rows 九列行（不必已排序，内部会排）
 * @returns {object[]} 与入参同序的旧形状数组（按 seq 升序）
 */
export function foldRecordsToFacts(rows) {
  const sorted = sortFoldsBySeq(rows);
  /** @type {object[]} */
  const results = [];
  for (let i = 0; i < sorted.length; i++) {
    const prefix = sorted.slice(0, i + 1);
    const row = sorted[i] ?? {};
    // **第一折的 `from` 是 0，不是「拿不到」**（copilot 复审 #993 ①）：`from` 的语义是
    // 「已折到的水位」，水位起点就是 0。这里写 0 是**定义**，不是猜。不写的话
    // `foldRecordSegments`（`fold-statistical.js:520`）会因为缺 `from`/`to` **整份账本放弃**、
    // 退回解析块 ⇒ resume 之后统计折的读法静默退化。
    // 上一折的切点（第一折 = 0，即「还没有折过任何轮」）；`fromFoldRecords` 会把它 +1 变成
    // 本折覆盖的第一轮（261128-12 实测：`from` 是闭区间左端，不是水位）。
    const previousCutRound = i > 0
      ? Number.isSafeInteger(sorted[i - 1]?.cutRound) ? sorted[i - 1].cutRound : undefined
      : 0;
    const facts = fromFoldRecords(prefix, { previousCutRound });
    // **本折自己的那份**（copilot 复审 #993 ①）：`fromFoldRecords` 的 `text` 是**累计**正文
    // （契约语义），而 `foldRecordSegments` 把 `record.text` 当**单折**正文用。所以补三个派生键，
    // 让读侧拿到的每一折都带着「这一折是什么」：
    //   · `summary` = 这一行的 `description`（语义折的模型正文，`ledgerSummary` 读它）；
    //   · `increment.text` = 同一个 `description`（`detailText` 读它，单折文本）；
    //   · `increment.{from,to,rounds}` = 与父键同值（`foldRecordSegments` 也从 increment 兜底取）。
    // 这三个键**不是列**，是从列导出的；写进派生对象是因为旧形状的读侧就是按旧形状写的。
    const description = typeof row.description === "string" ? row.description : undefined;
    if (description !== undefined) {
      facts.summary = description;
      facts.increment = {
        text: description,
        ...(Number.isSafeInteger(facts.from) ? { from: facts.from } : {}),
        ...(Number.isSafeInteger(facts.to) ? { to: facts.to } : {}),
        ...(Number.isSafeInteger(facts.rounds) ? { rounds: facts.rounds } : {}),
      };
    }
    results.push(facts);
  }
  return results;
}

/**
 * 合并读（ADR §4）的**唯一口径**（issue #971 ②）：`folds` 通道 ∪ 轮记录 `foldedFacts`，按
 * `foldIdentityKey` 去重、**通道行优先**（轮记录先占位、通道行后入覆盖），再按 `seq` 升序。
 * 纯函数、不 clone（调用方自己决定要不要副本）。orchestrator 的 resume 合并读与两侧 store 的
 * `appendFold` 播种都走它 ⇒ 「口径只许有一处」。
 *
 * 九列通道行在合并前先经 `foldRecordsToFacts` 转成旧形状；旧形状原样。混装可处理。
 *
 * @param {{ channelRows?: object[], roundFacts?: object[] }} input
 * @returns {object[]}
 */
export function mergeFoldRecords({ channelRows = [], roundFacts = [] }) {
  // 分离九列行与旧形状行
  const nineCol = channelRows.filter(isFoldRecord);
  const legacy = channelRows.filter((row) => !isFoldRecord(row));
  // 九列 → 旧形状
  const converted = nineCol.length > 0 ? foldRecordsToFacts(nineCol) : [];
  const allChannel = [...legacy, ...converted];

  /** @type {Map<string, object>} */
  const byIdentity = new Map();
  for (const facts of roundFacts) byIdentity.set(foldIdentityKey(facts), facts);
  for (const row of allChannel) byIdentity.set(foldIdentityKey(row), row);
  return sortFoldsBySeq([...byIdentity.values()]);
}

/**
 * 按 `seq` 升序返回折叠行（缺 `seq` / 非安全整数的排最前，视作 `0`）。V8 的 `Array#sort` 是**稳定**
 * 排序 ⇒ 同 `seq` 保持入参相对序，两侧（同一份实现）必然同序。这是 `loadFolds()` 的**契约顺序**，
 * 也是「文件 / 内存逐字节相同」的前提。
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function sortFoldsBySeq(rows) {
  const num = (/** @type {object} */ row) => {
    const seq = /** @type {{ seq?: unknown }} */ (row ?? {}).seq;
    return Number.isSafeInteger(seq) && /** @type {number} */ (seq) > 0
      ? /** @type {number} */ (seq)
      : 0;
  };
  return [...rows].sort((left, right) => num(left) - num(right));
}

/**
 * 合并读（ADR §4）的**身份键**：`foldId` → `fingerprint` → `sha256(from, to, text)` 三级回退。
 * 两处（`folds` 通道与轮记录 `foldedFacts`）算出同一个键 ⇒ 判为同一条折叠、只留一条。
 *
 * @param {any} fold
 * @returns {string}
 */
export function foldIdentityKey(fold) {
  if (typeof fold?.foldId === "string" && fold.foldId !== "") {
    return `id:${fold.foldId}`;
  }
  if (typeof fold?.fingerprint === "string" && fold.fingerprint !== "") {
    return `fp:${fold.fingerprint}`;
  }
  // 九列行没有 from/to/text 也没有 fingerprint（只有 foldId，上面已命中）；
  // 走到这里的一定是旧形状（至少有 text）。
  const digest = createHash("sha256")
    .update(JSON.stringify([fold?.from ?? null, fold?.to ?? null, fold?.text ?? ""]))
    .digest("hex");
  return `tx:${digest}`;
}
