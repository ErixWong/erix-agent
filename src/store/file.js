import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

export function safeRunId(runId) {
  const value = String(runId);
  if (/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)
    && value !== "." && value !== "..") {
    return value;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `run-${digest}`;
}

function transcriptPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.jsonl`);
}

function checkpointPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.checkpoint.json`);
}

function statePath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.state.json`);
}

function recordKey(runId, record) {
  return record?.dedupKey
    ?? record?.roundKey
    ?? `${String(runId)}:round:${String(record?.round)}`;
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
 *   recall: (runId:string, fromRound?:number, toRound?:number, pattern?:string) => Promise<string>,
 *   markRunState: (runId:string, state:string) => Promise<void>,
 *   saveCheckpoint: (runId:string, checkpoint:object) => Promise<void>,
 *   loadLatestCheckpoint: (runId:string) => Promise<object|undefined>
 * }}
 */
export function createFileTranscriptStore({ dir }) {
  const appendLocks = new Map();
  const loadRecords = async (runId) => {
    const records = [];
    for await (const record of readRecords(transcriptPath(dir, runId))) {
      records.push(record);
    }
    return records;
  };
  const withAppendLock = async (runId, operation) => {
    const key = safeRunId(runId);
    const previous = appendLocks.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    appendLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (appendLocks.get(key) === current) appendLocks.delete(key);
    }
  };

  return {
    async appendRound(runId, record) {
      await withAppendLock(runId, async () => {
        await mkdir(dir, { recursive: true });
        const records = await loadRecords(runId);
        if (records.some((existing) => recordKey(runId, existing) === recordKey(runId, record))) {
          return;
        }
        await appendFile(
          transcriptPath(dir, runId),
          `${JSON.stringify(record)}\n`,
          "utf8",
        );
      });
    },

    async load(runId) {
      return loadRecords(runId);
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

    async markRunState(runId, state) {
      await mkdir(dir, { recursive: true });
      await writeFile(
        statePath(dir, runId),
        `${JSON.stringify({ runId, state, ts: new Date().toISOString() })}\n`,
        "utf8",
      );
    },

    async saveCheckpoint(runId, checkpoint) {
      await mkdir(dir, { recursive: true });
      const target = checkpointPath(dir, runId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, "utf8");
      await rename(temporary, target);
    },

    async appendCheckpoint(runId, checkpoint) {
      await this.saveCheckpoint(runId, checkpoint);
    },

    async loadLatestCheckpoint(runId) {
      try {
        return JSON.parse(await readFile(checkpointPath(dir, runId), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    },

    async loadRunState(runId) {
      try {
        return JSON.parse(await readFile(statePath(dir, runId), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}
