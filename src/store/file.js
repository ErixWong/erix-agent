import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * @typedef {{round:number, messages: object[], folded?:boolean, ts?:string, foldedPayload?:any}} RoundRecord
 */

function safeRunId(runId) {
  return String(runId).replace(/[^A-Za-z0-9._-]/g, "_");
}

function transcriptPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.jsonl`);
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

async function* readRecords(path) {
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    let buffer = "";

    for await (const chunk of stream) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const jsonLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        yield JSON.parse(jsonLine);
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Create a JSONL-backed transcript store.
 *
 * @param {{dir:string}} options
 * @returns {{
 *   appendRound: (runId:string, record:RoundRecord) => Promise<void>,
 *   load: (runId:string) => Promise<RoundRecord[]>,
 *   recall: (runId:string, fromRound?:number, toRound?:number, pattern?:string) => Promise<string>
 * }}
 */
export function createFileTranscriptStore({ dir }) {
  return {
    async appendRound(runId, record) {
      await mkdir(dir, { recursive: true });
      await appendFile(
        transcriptPath(dir, runId),
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    },

    async load(runId) {
      const records = [];
      for await (const record of readRecords(transcriptPath(dir, runId))) {
        records.push(record);
      }
      return records;
    },

    async recall(runId, fromRound, toRound, pattern) {
      let result = "";
      let hasFragment = false;

      for await (const record of readRecords(transcriptPath(dir, runId))) {
        if (fromRound !== undefined && record.round < fromRound) continue;
        if (toRound !== undefined && record.round > toRound) continue;

        for (const message of record.messages ?? []) {
          for (const block of blocksFor(message?.content)) {
            const text = blockText(block);
            if (text === null) continue;
            if (pattern !== undefined && !text.includes(pattern)) continue;
            if (hasFragment) result += "\n";
            result += text;
            hasFragment = true;
          }
        }
        // 折叠原文同属档案，一并纳入检索（fold 只影响视图）
        for (const message of record.foldedPayload ?? []) {
          for (const block of blocksFor(message?.content)) {
            const text = blockText(block);
            if (text === null) continue;
            if (pattern !== undefined && !text.includes(pattern)) continue;
            if (hasFragment) result += "\n";
            result += text;
            hasFragment = true;
          }
        }
      }

      return result;
    },
  };
}
