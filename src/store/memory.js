import { boundRunState } from "../run-state.js";

/**
 * @typedef {{
 *   round:number,
 *   messages: object[],
 *   folded?:boolean,
 *   ts?:string,
 *   foldedPayload?:any,
 *   dedupKey?:string,
 *   foldedRoundRange?:{from:number,to:number},
 *   response?:{content:object[], stopReason?:string, usage?:object},
 *   textPreview?:string,
 *   toolUses?:number,
 *   summary?:{action:string,note:string}|"missing",
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
 *   saveRunState: (runId:string, state:object) => Promise<void>,
 *   loadRunState: (runId:string) => Promise<object|undefined>,
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

  const recordKey = (runId, record) => (
    record?.dedupKey
      ?? record?.roundKey
      ?? `${String(runId)}:round:${String(record?.round)}`
  );

  return {
    async appendRound(runId, record) {
      const records = transcripts.get(runId) ?? [];
      const key = recordKey(runId, record);
      if (records.some((existing) => recordKey(runId, existing) === key)) return;
      records.push(copyRecord(record));
      transcripts.set(runId, records);
    },

    async load(runId) {
      return (transcripts.get(runId) ?? []).map(copyRecord);
    },

    async markRunState(runId, state) {
      runStates.set(runId, {
        ...(runStates.get(runId) ?? {}),
        runId,
        state,
        ts: new Date().toISOString(),
      });
    },

    async saveRunState(runId, state) {
      runStates.set(runId, {
        ...(runStates.get(runId) ?? {}),
        ...boundRunState({ ...copyRecord(state), runId }),
        runId,
        ts: new Date().toISOString(),
      });
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
  };
}
