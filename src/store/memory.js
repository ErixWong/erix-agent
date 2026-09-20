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
 *   saveCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   appendCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   loadLatestCheckpoint: (runId:string) => Promise<object|undefined>
 * }}
 */
export function createMemoryTranscriptStore() {
  const transcripts = new Map();
  const checkpoints = new Map();
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

    async saveCheckpoint(runId, checkpoint) {
      checkpoints.set(runId, copyRecord(checkpoint));
    },

    async appendCheckpoint(runId, checkpoint) {
      await this.saveCheckpoint(runId, checkpoint);
    },

    async loadLatestCheckpoint(runId) {
      const checkpoint = checkpoints.get(runId);
      return checkpoint === undefined ? undefined : copyRecord(checkpoint);
    },

    async loadRunState(runId) {
      const state = runStates.get(runId);
      return state === undefined ? undefined : copyRecord(state);
    },
  };
}
