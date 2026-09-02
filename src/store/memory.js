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

function blocksFor(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function blockText(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") return String(block.text ?? "");
  if (block.type === "tool_use") {
    return `${block.name ?? ""}${JSON.stringify(block.input)}`;
  }
  if (block.type === "tool_result") return String(block.content ?? "");
  return null;
}

/**
 * Create an in-process transcript store backed by a Map.
 *
 * @returns {{
 *   appendRound: (runId:string, record:RoundRecord) => Promise<void>,
 *   load: (runId:string) => Promise<RoundRecord[]>,
 *   recall: (runId:string, fromRound?:number, toRound?:number, pattern?:string) => Promise<string>,
 *   markRunState: (runId:string, state:string) => Promise<void>,
 *   saveCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
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

    async recall(runId, fromRound, toRound, pattern) {
      const records = transcripts.get(runId) ?? [];
      const fragments = [];

      for (const record of records) {
        if (fromRound !== undefined && record.round < fromRound) continue;
        if (toRound !== undefined && record.round > toRound) continue;

        for (const message of record.messages ?? []) {
          for (const block of blocksFor(message?.content)) {
            const text = blockText(block);
            if (text !== null) fragments.push(text);
          }
        }
        // 折叠原文同属档案，一并纳入检索（fold 只影响视图）
        for (const message of record.foldedPayload ?? []) {
          for (const block of blocksFor(message?.content)) {
            const text = blockText(block);
            if (text !== null) fragments.push(text);
          }
        }
      }

      const selected = pattern === undefined
        ? fragments
        : fragments.filter((fragment) => fragment.includes(pattern));
      return selected.join("\n");
    },

    async markRunState(runId, state) {
      runStates.set(runId, {
        runId,
        state,
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
