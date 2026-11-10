// 一个**不做写侧轮号校验**的账本夹具（issue #811）。
//
// 为什么需要它：#811 之后两个内置 store 的 `appendRound` / `appendRecoveryRow` 把轮号不是安全整数的行
// 当场拒掉（`TypeError` ⇒ 宿主映射 4xx）。而本仓有一批用例断的是**读侧**对那种行的处理（#729 的
// 「轮号不是整数的候选行不当锚点」、#730 的「轮号不可用 ⇒ 不给锚点」那一格……），那种行今天只可能
// 来自**不经本 store 写入口**的现场：
//   · 宿主自研 store（PG 驱动对 `int8`/`bigint` 列默认返回 JS **字符串** —— issue #811 动机那条），
//   · 或写侧守卫装上之前就躺在档案里的行。
// 用内置 store 的 `appendRound` 去造那种现场，造的其实是「守卫之前的世界」，而守卫装上之后那条路
// 已经不存在 ⇒ 夹具必须换个来源。本夹具就是把那种现场交出来：**只有追加是裸的**，其余能力全部
// 委托给真 store（快照 / run-state 等能力照旧走内存实现）。
//
// 语义与内置 store 的差别只有一处：`round` 不校验。幂等仍按同一份判据（`src/store/transcript-dedup.js`
// 的 key + payload 指纹）⇒ 引擎重跑同 key 同 payload 照旧静默跳过，夹具不会自己造出重复行。
//
// ⚠ 读侧读的是**这一份行数组**（不是 inner 的账本）：种子行在前、引擎后续写在后，顺序就是落盘顺序。
// `load()` 仍跑 `foldMessageRows`（与内置 store 同一条读侧口径），`loadRawRows()` 给未折叠行。
import { foldMessageRows } from "../../src/store/message-rows.js";
import { dedupConflictError, payloadFingerprint, recordKey } from "../../src/store/transcript-dedup.js";

/** @param {any} value @returns {any} */
function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * 把真 store 包成「追加不校验轮号」的那一层。
 * @param {any} inner 真 store（内存或 file 实现；快照 / run-state 等能力原样透传）
 * @returns {any} 同一个能力面，但 `appendRound` / `appendRecoveryRow` 是裸写
 */
export function withUnvalidatedAppends(inner) {
  /** @type {any[]} 轮记录通道（裸写视图，顺序 = 落盘顺序） */
  const rows = [];
  /** @type {any[]} 恢复行通道（裸写视图） */
  const recoveryRows = [];

  /**
   * 裸追加：幂等判据与内置 store 同源，唯独**不碰轮号**。
   * @param {any[]} list 落到哪个通道的数组
   * @param {string} runId
   * @param {any} record
   * @returns {boolean} 真的追加了一条才是 `true`
   */
  const rawAppend = (list, runId, record) => {
    const key = recordKey(runId, record);
    const existing = list.find((item) => recordKey(runId, item) === key);
    if (existing !== undefined) {
      const existingFingerprint = payloadFingerprint(existing);
      const incomingFingerprint = payloadFingerprint(record);
      if (existingFingerprint !== incomingFingerprint) {
        throw dedupConflictError({
          runId, key, existing, incoming: record, existingFingerprint, incomingFingerprint,
        });
      }
      return false;
    }
    list.push(copy(record));
    return true;
  };

  return {
    ...inner,
    async appendRound(runId, record) {
      rawAppend(rows, runId, record);
    },
    async appendRecoveryRow(runId, record) {
      return rawAppend(recoveryRows, runId, record);
    },
    async load(runId) {
      return foldMessageRows(rows.map((row) => copy(row)));
    },
    async loadRawRows(runId) {
      return rows.map((row) => copy(row));
    },
    async listRecoveryRows(runId) {
      return recoveryRows.map((row) => copy(row));
    },
    // 清代际（fresh start）必须把这份视图一起清掉，否则「inner 清了、夹具还留着」= 假证据。
    async clearRecoveryRows(runId) {
      const cleared = typeof inner.clearRecoveryRows === "function"
        ? await inner.clearRecoveryRows(runId)
        : false;
      const had = recoveryRows.length > 0;
      recoveryRows.length = 0;
      return cleared || had;
    },
  };
}
