/**
 * @typedef {{round:number, messages: object[], folded?:boolean, ts?:string, foldedPayload?:any}} RoundRecord
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
 *   recall: (runId:string, fromRound?:number, toRound?:number, pattern?:string) => Promise<string>
 * }}
 */
export function createMemoryTranscriptStore() {
  const transcripts = new Map();

  return {
    async appendRound(runId, record) {
      const records = transcripts.get(runId) ?? [];
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
  };
}
