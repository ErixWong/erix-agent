import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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

async function repairTrailingFragment(path, handle) {
  const { size } = await handle.stat();
  if (size === 0) return;

  const tail = Buffer.alloc(1);
  const { bytesRead } = await handle.read(tail, 0, 1, size - 1);
  if (bytesRead === 0 || tail[0] === 0x0a) return;

  const contents = await handle.readFile();
  const lastNewline = contents.lastIndexOf(0x0a);
  const trailing = contents.subarray(lastNewline + 1);
  if (trailing.length === 0) return;

  // 完整 JSON 但缺末尾换行（syscall 截断在 LF 前）→ 补 \n，不隔离不丢弃
  try {
    JSON.parse(trailing.toString("utf8"));
    await handle.write("\n", null, "utf8");
    return;
  } catch {
    // 半行残段（崩溃中断）→ 隔离到 .corrupt 存档再截断
  }
  await writeFile(
    `${path}.corrupt.${Date.now()}.${randomUUID()}`,
    trailing,
  );
  await handle.truncate(lastNewline + 1);
}

async function appendRecord(path, record) {
  const handle = await open(path, "a+");
  try {
    await repairTrailingFragment(path, handle);
    await handle.write(`${JSON.stringify(record)}\n`, null, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Create a JSONL-backed transcript store.
 *
 * 并发模型：**单写者**（每 runId 单进程写入——宿主单实例/CLI 单跑）。appendRound 的
 * 进程内锁防同实例交错；跨进程写同一 transcript 是设计外场景（需宿主自行加文件锁）。
 * 崩溃恢复：appendRound 前 repairTrailingFragment 修复尾部（半行残段隔离 .corrupt.*，
 * 完整 JSON 缺换行则补 \n）；checkpoint 支持 at-least-once 恢复（副作用工具需宿主幂等）。
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
        await appendRecord(transcriptPath(dir, runId), record);
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
