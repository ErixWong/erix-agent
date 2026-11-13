import { boundRunState } from "../run-state.js";
import { RECOVERY_EVENT_PARTIAL_TEXT } from "./recovery-rows.js";
import { foldMessageRows } from "./message-rows.js";
import {
  assertSafeRound, dedupConflictError, payloadFingerprint, recordKey,
} from "./transcript-dedup.js";

/**
 * @typedef {{
 *   round:number,
 *   messages: import("../messages/canonical.js").CanonicalMessage[],
 *   folded?:boolean,
 *   ts?:string,
 *   foldedPayload?:any,
 *   dedupKey?:string,
 *   roundKey?:string,
 *   navigationRecord?:object,
 *   foldedRoundRange?:{from:number,to:number},
 *   foldedPayloadMeta?:{count:number,bytes:number,droppedMessages?:number,droppedBytes?:number,capBytes?:number,dedupedMessages?:number},
 *   response?:{content:object[], stopReason?:string, usage?:object},
 *   textPreview?:string,
 *   toolUses?:number,
 *   summary?:{action:string,note:string}|"missing",
 *   foldedFacts?:{text:string,title:string,origin:"mechanical"|"semantic"|"host",increment?:{text:string,title:string,origin:"mechanical"|"semantic"|"host",from?:number,to?:number,rounds?:number,bytes:number,truncated?:boolean,bytesBefore?:number},summary?:string,toolCalls?:{name:string,argsSummary:string}[],source:string,strategy:string,bytes:number,from?:number,to?:number,rounds?:number,truncated?:boolean,bytesBefore?:number,degradeReason?:string,fingerprint?:string},
 *   l0facts?:object
 * }} RoundRecord
 */

function copyRecord(record) {
  return structuredClone(record);
}

/**
 * Create an in-process transcript store backed by a Map.
 *
 * @returns {{
 *   appendRound: (runId:string, record:RoundRecord) => Promise<void>,
 *   load: (runId:string) => Promise<RoundRecord[]>,
 *   markRunState: (runId:string, state:string) => Promise<void>,
 *   saveRunState: (runId:string, snapshot:object) => Promise<void>,
 *   loadRunState: (runId:string) => Promise<object|undefined>,
 *   loadRunStateStatus: (runId:string) => Promise<string|undefined>,
 *   loadRawRows: (runId:string) => Promise<RoundRecord[]>,
 *   saveRunSnapshot: (runId:string, snapshot:object) => Promise<void>,
 *   loadLatestRunSnapshot: (runId:string) => Promise<object|undefined>,
 *   saveCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   appendCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   loadLatestCheckpoint: (runId:string) => Promise<object|undefined>, appendRecoveryRow: (runId:string, record:object) => Promise<boolean>, listRecoveryRows: (runId:string) => Promise<object[]>, clearRecoveryRows: (runId:string) => Promise<boolean>
 * }}
 */
export function createMemoryTranscriptStore() {
  const transcripts = new Map();
  // issue #769：恢复行通道（与轮记录 `transcripts` **两份容器**，语义与 file store 的
  // `<runId>.recovery.jsonl` 对齐：`load()` / `loadRawRows()` 永远看不到恢复行）。值类型写出来不是装饰：`rows.find((item) => …)` 的 `item` 要靠它推断，否则 `--strict` 报 TS7006。
  const recoveryLedger = /** @type {Map<string, object[]>} */ (new Map());
  const runSnapshots = new Map();
  const runStates = new Map();
  const runStatuses = new Map();
  /** 落盘行的**副本**（`load()` 与 `loadRawRows` 的共同输入；折叠只发生在 `load()` 那一侧）。
   * @param {string} runId @returns {RoundRecord[]} */
  const rawRows = (runId) => (transcripts.get(runId) ?? []).map(copyRecord);

  return {
    /**
     * 幂等/冲突语义（issue #326 事实①）：同 key 同 payload → 不重复写入（与历史一致，返回
     * undefined）；同 key 异 payload → 抛 `TranscriptDedupConflictError`，既不覆盖也不静默丢弃。
     * 判据与 file store 共用 `src/store/transcript-dedup.js`，两侧不得各抄一套。
     */
    async appendRound(runId, record) {
      // issue #811：轮号不可用的行**进不来**（`TypeError` ⇒ 宿主映射 4xx）。读侧照旧宽容。
      assertSafeRound("appendRound", { runId, record });
      const records = transcripts.get(runId) ?? [];
      const key = recordKey(runId, record);
      const existing = records.find((item) => recordKey(runId, item) === key);
      if (existing !== undefined) {
        const incomingFingerprint = payloadFingerprint(record);
        const existingFingerprint = payloadFingerprint(existing);
        if (existingFingerprint !== incomingFingerprint) {
          throw dedupConflictError({
            runId,
            key,
            existing,
            incoming: record,
            existingFingerprint,
            incomingFingerprint,
          });
        }
        return;
      }
      records.push(copyRecord(record));
      transcripts.set(runId, records);
    },

    /**
     * issue #769（可选能力）：追加一条恢复行（`kind: "recovery"`）到恢复行通道。
     * 幂等与 `appendRound` 同口径（同键同 payload ⇒ 跳过并返回 `false`；同键异 payload ⇒ 抛冲突）。
     * issue #827 第 1 刀：`recoveryEvent === "partial-text"` 是**槽**——同 round 同事件只保留一条
     * （新行替旧行，与 file store 的原子整写同语义）；其余事件照旧只追加、永不替换。
     * @param {string} runId @param {object} record @returns {Promise<boolean>}
     */
    async appendRecoveryRow(runId, record) {
      // issue #811：恢复行的事件键含轮号 ⇒ 轮号不可用就当场拒（与 `appendRound` 同一份判据）。
      assertSafeRound("appendRecoveryRow", { runId, record });
      const rows = recoveryLedger.get(runId) ?? [];
      const key = recordKey(runId, record);
      const existing = rows.find((item) => recordKey(runId, item) === key);
      if (existing !== undefined) {
        const incomingFingerprint = payloadFingerprint(record);
        const existingFingerprint = payloadFingerprint(existing);
        if (existingFingerprint !== incomingFingerprint) {
          throw dedupConflictError({
            runId,
            key,
            existing,
            incoming: record,
            existingFingerprint,
            incomingFingerprint,
          });
        }
        return false;
      }
      if (record !== null && record !== undefined
        && record.recoveryEvent === RECOVERY_EVENT_PARTIAL_TEXT) {
        // 槽替换：丢掉同 round 同事件的旧行，新行落在尾部（与 file store 的整写同位置）。
        const kept = rows.filter((item) => !(item !== null
          && item.recoveryEvent === RECOVERY_EVENT_PARTIAL_TEXT
          && item.round === record.round));
        kept.push(copyRecord(record));
        recoveryLedger.set(runId, kept);
        return true;
      }
      rows.push(copyRecord(record));
      recoveryLedger.set(runId, rows);
      return true;
    },

    /**
     * issue #769（可选能力）：读回恢复行通道的全部行（落盘顺序）。没写过 ⇒ `[]`。
     * @param {string} runId @returns {Promise<object[]>}
     */
    async listRecoveryRows(runId) {
      return (recoveryLedger.get(runId) ?? []).map(copyRecord);
    },

    /**
     * issue #769 R3（C1，并为阻断 A 提供代际边界；可选能力）：清掉该 runId 的恢复行容器。
     * 与 file store 的「删 `<runId>.recovery.jsonl`」同语义：只动恢复行通道，`transcripts`（轮记录
     * 账本）一条不少。引擎在 `resume !== true` 的 fresh start 调它（`src/loop/orchestrator.js`），
     * 因为事件键里没有 run 代际 ⇒ 「这个容器/文件」就是代际边界。
     * 幂等：本来没写过 ⇒ `false`，不抛；清掉了东西 ⇒ `true`。
     *
     * @param {string} runId @returns {Promise<boolean>}
     */
    async clearRecoveryRows(runId) {
      return recoveryLedger.delete(runId);
    },

    async load(runId) {
      // 工单 261021：与 file store 同一个折叠层（两侧不得各抄一套），宿主看到的 `load()` 形状不变。
      return foldMessageRows(rawRows(runId));
    },

    /**
     * issue #714：可选**原始行读口**（anchor probe）——`load()` 的**未折叠输入**（同一批行、同一顺序，
     * 不过 `foldMessageRows`）。内置两个 store 都提供；宿主最小实现可以不给（缺它就退回修前口径）。
     * @param {string} runId @returns {Promise<RoundRecord[]>}
     */
    async loadRawRows(runId) {
      return rawRows(runId);
    },

    async markRunState(runId, state) {
      runStatuses.set(runId, state);
    },

    async saveRunState(runId, snapshot) {
      const persisted = boundRunState({
        ...(runStates.get(runId) ?? {}),
        ...copyRecord(snapshot),
        runId,
        ts: new Date().toISOString(),
      });
      delete persisted.state;
      runStates.set(runId, persisted);
    },

    async saveRunSnapshot(runId, snapshot) {
      runSnapshots.set(runId, copyRecord(snapshot));
    },

    async loadLatestRunSnapshot(runId) {
      const snapshot = runSnapshots.get(runId);
      return snapshot === undefined ? undefined : copyRecord(snapshot);
    },

    /**
     * @deprecated issue #78：checkpoint 更名 run snapshot。请改用 saveRunSnapshot。
     */
    async saveCheckpoint(runId, checkpoint) {
      await this.saveRunSnapshot(runId, checkpoint);
    },

    /**
     * @deprecated issue #78：append 语义与 save 相同（latest-only 覆盖写），
     * 别名已合并——请改用 saveRunSnapshot。
     */
    async appendCheckpoint(runId, checkpoint) {
      await this.saveRunSnapshot(runId, checkpoint);
    },

    /**
     * @deprecated issue #78：请改用 loadLatestRunSnapshot。
     */
    async loadLatestCheckpoint(runId) {
      return this.loadLatestRunSnapshot(runId);
    },

    async loadRunState(runId) {
      const state = runStates.get(runId);
      return state === undefined ? undefined : copyRecord(state);
    },

    async loadRunStateStatus(runId) {
      if (runStatuses.has(runId)) return runStatuses.get(runId);
      return runStates.get(runId)?.state;
    },
  };
}
