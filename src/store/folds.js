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
import { createFoldIdentityAllocator } from "../compact/fold-summary-journal.js";

/**
 * ADR-022 §1.3 folds 记录的列集合（`buildFoldedFacts` 返回**逐键对齐**，再加通道自分配的 `seq`）。
 * 这张表是**表驱动断言**的判据（测试判据 4：`buildFoldedFacts(...)` 返回键集合 ⊆ 本列集合）。
 * 少一格就红。
 *
 * @type {ReadonlySet<string>}
 */
export const FOLD_RECORD_COLUMNS = new Set([
  "text", "title", "titleFallback", "origin", "source", "strategy",
  "summary", "summaryDropped", "descriptionTruncated", "toolCalls",
  "increment", "from", "to", "rounds", "bytes",
  "truncated", "bytesBefore", "degradeReason", "fingerprint",
  "foldId", "seq",
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
     * @param {object[]} rows
     */
    seedFromRows(rows) {
      if (seeded) return;
      seeded = true;
      allocator.seed(rows);
    },
  };
}

/**
 * 给一条**新**折叠分配 `seq`（已投过的 `foldId` 应在此之前由调用方挡掉、根本不会走到这里）。
 *
 * - 有可用 `foldId`：直接问分配器（它即「幂等 + 严格递增」的唯一实现）；
 * - 无可用 `foldId`（非字符串 / 空串 ⇒ `allocate` 返回 `undefined`）：退回「已存行最大 `seq` + 1」。
 *
 * @param {ReturnType<typeof createFoldIdentityAllocator>} allocator
 * @param {object[]} existingRows 该 run 已入账的折叠行（用于无 `foldId` 时取最大 `seq`）
 * @param {unknown} foldId 折叠的契约身份（可空）
 * @returns {number}
 */
export function nextFoldSeq(allocator, existingRows, foldId) {
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
  return max + 1;
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
  const digest = createHash("sha256")
    .update(JSON.stringify([fold?.from ?? null, fold?.to ?? null, fold?.text ?? ""]))
    .digest("hex");
  return `tx:${digest}`;
}
