import { boundRunState } from "../run-state.js";
import { foldMessageRows } from "./message-rows.js";
import { dedupConflictError, payloadFingerprint, recordKey } from "./transcript-dedup.js";

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
 *   saveRunSnapshot: (runId:string, snapshot:object) => Promise<void>,
 *   loadLatestRunSnapshot: (runId:string) => Promise<object|undefined>,
 *   saveCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   appendCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   loadLatestCheckpoint: (runId:string) => Promise<object|undefined>
 * }}
 */
export function createMemoryTranscriptStore() {
  const transcripts = new Map();
  const runSnapshots = new Map();
  const runStates = new Map();
  const runStatuses = new Map();

  return {
    /**
     * 幂等/冲突语义（issue #326 事实①）：同 key 同 payload → 不重复写入（与历史一致，返回
     * undefined）；同 key 异 payload → 抛 `TranscriptDedupConflictError`，既不覆盖也不静默丢弃。
     * 判据与 file store 共用 `src/store/transcript-dedup.js`，两侧不得各抄一套。
     */
    async appendRound(runId, record) {
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

    async load(runId) {
      // 工单 261021：与 file store 同一个折叠层（两侧不得各抄一套），宿主看到的 `load()` 形状不变。
      return foldMessageRows((transcripts.get(runId) ?? []).map(copyRecord));
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
