import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundRunState } from "../run-state.js";

const HASHED_RUN_ID_PREFIX = "run-h-";

/**
 * @typedef {{
 *   round:number,
 *   messages: object[],
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
 *   l0facts?:object
 * }} RoundRecord
 */

export function safeRunId(runId) {
  const value = String(runId);
  if (/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)
    && value !== "." && value !== ".."
    && !value.startsWith(HASHED_RUN_ID_PREFIX)) {
    // Keep existing safe-id filenames readable; the reserved prefix prevents
    // a user id from colliding with the hashed namespace. Legacy unsafe
    // run-<hash> names are intentionally not read because they are ambiguous.
    return value;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${HASHED_RUN_ID_PREFIX}${digest}`;
}

function transcriptPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.jsonl`);
}

function snapshotPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.snapshot.json`);
}

// 旧后缀（issue #78 更名前）：仅用于读取兼容，不再写入。
function legacyCheckpointPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.checkpoint.json`);
}

function statePath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.state.json`);
}

function statusPath(dir, runId) {
  return join(dir, `${safeRunId(runId)}.status.json`);
}

function recordKey(runId, record) {
  return record?.dedupKey
    ?? record?.roundKey
    ?? `${String(runId)}:round:${String(record?.round)}`;
}

// issue #160：(size, mtimeMs) 新鲜度戳。文件缺失时 size/mtimeMs 均为 null。
async function statStamp(path) {
  try {
    const { size, mtimeMs } = await stat(path);
    return { size, mtimeMs };
  } catch (error) {
    if (error?.code === "ENOENT") return { size: null, mtimeMs: null };
    throw error;
  }
}

function stampsMatch(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
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

    // A crash can leave a complete JSON record after the final newline.
    // Ignore an incomplete tail, matching repairTrailingFragment semantics.
    if (buffer.length > 0) {
      const jsonLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      try {
        yield JSON.parse(jsonLine);
      } catch {
        // An incomplete EOF fragment is not a readable record.
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

  // 完整 JSON 对象但缺末尾换行（syscall 截断在 LF 前）→ 补 \n，不隔离不丢弃
  try {
    const parsed = JSON.parse(trailing.toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      await handle.write("\n", size, "utf8");
      return;
    }
  } catch {
    // fall through: 半行残段或非法尾部
  }
  // 半行残段 / 非对象 JSON（null/数组/标量——resume 时会崩 record.messages）→ 隔离存档再截断
  await writeFile(
    `${path}.corrupt.${Date.now()}.${randomUUID()}`,
    trailing,
  );
  await handle.truncate(lastNewline + 1);
}

async function repairTranscriptTail(path) {
  let handle;
  try {
    handle = await open(path, "r+");
    await repairTrailingFragment(path, handle);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * issue #160：appendRecord 的幂等判据取 key set——优先命中进程内缓存（新鲜度以
 * 修复尾部后的 (size, mtimeMs) 戳一致为准），不一致时流式重建（readRecords，保持
 * fail-closed：中间损坏行照旧抛错）。仅当扫描前后戳一致才把重建结果落缓存；
 * 0 字节文件无记录，直接视为可信空集。
 *
 * @param {string} path
 * @param {string} runId
 * @param {{size:number|null, mtimeMs:number|null}} stamp 修复尾部后的当前戳
 * @param {Map<string, {keys:Set<string>, size:number|null, mtimeMs:number|null}>} dedupCaches
 */
async function dedupKeysFor(path, runId, stamp, dedupCaches) {
  const cacheKey = safeRunId(runId);
  const cached = dedupCaches.get(cacheKey);
  if (cached && stampsMatch(cached, stamp)) return cached;

  // 空文件无记录可扫——免读全文，直接构造可信空集并落缓存
  if (stamp.size === 0) {
    const entry = { keys: new Set(), size: 0, mtimeMs: stamp.mtimeMs, transient: false };
    dedupCaches.set(cacheKey, entry);
    return entry;
  }

  const keys = new Set();
  try {
    // fail-closed：中间损坏行抛错（与旧全量 parse 语义一致），失败不落缓存
    for await (const existing of readRecords(path)) {
      if (existing !== null) keys.add(recordKey(runId, existing));
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Transcript contains a malformed line: ${path}`, { cause: error });
    }
    throw error;
  }
  const afterScan = await statStamp(path);
  if (!stampsMatch(stamp, afterScan)) {
    // 扫描期间被外部改动——本次判定仍用刚扫出的集合（与旧 readFile 同等的瞬时快照），
    // 但不落缓存，避免把不新鲜的 key set 当成有效缓存
    return { keys, size: null, mtimeMs: null, transient: true };
  }
  const entry = { keys, size: afterScan.size, mtimeMs: afterScan.mtimeMs, transient: false };
  dedupCaches.set(cacheKey, entry);
  return entry;
}

async function appendRecord(path, runId, record, dedupCaches) {
  const handle = await open(path, "a+");
  try {
    await repairTrailingFragment(path, handle);
    // 幂等判定（防无 LF 尾部绕过幂等检查——审计发现）：issue #160 起优先用进程内
    // dedup key 缓存（修复尾部后 stat 戳一致即命中，O(1)，不再全文读）；不一致时
    // 流式重建（见 dedupKeysFor）
    const stamp = await statStamp(path);
    const entry = await dedupKeysFor(path, runId, stamp, dedupCaches);
    const key = recordKey(runId, record);
    if (entry.keys.has(key)) {
      return false;
    }
    await handle.write(`${JSON.stringify(record)}\n`, null, "utf8");
    // 写后：新 key 入 set、刷新戳（仅当缓存条目可信；transient 条目不落缓存）
    if (!entry.transient) {
      if (record !== null && record !== undefined) entry.keys.add(key);
      const afterWrite = await statStamp(path);
      entry.size = afterWrite.size;
      entry.mtimeMs = afterWrite.mtimeMs;
    }
    return true;
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
 * 完整 JSON 缺换行则补 \n）；run snapshot 支持 at-least-once 恢复（副作用工具需宿主幂等）。
 * snapshot 是 latest-only 覆盖写（每轮覆盖、只用于中断恢复现场），不是多版本 checkpoint。
 *
 * @param {{dir:string}} options
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
export function createFileTranscriptStore({ dir }) {
  const appendLocks = new Map();
  // issue #160：进程内 dedup key 缓存（safeRunId → { keys, size, mtimeMs }）。
  // keys 恒等于文件里全部记录的 key（与全量 parse 结果相同）→ 幂等语义逐字不变；
  // 新鲜度由 (size, mtimeMs) 戳校验，外部改动/跨实例写会因戳不一致触发流式重建。
  const dedupCaches = new Map();
  const loadRecords = async (runId) => {
    const path = transcriptPath(dir, runId);
    await repairTranscriptTail(path);
    // 顺手填充 dedup 缓存（issue #160）：本次扫描本来就要全量读，把 key 收进集合，
    // 扫描前后各 stat 一次，仅当戳一致才落缓存（防止"扫到一半被外部改动"的集合被当成新鲜）
    const stampBefore = await statStamp(path);
    const records = [];
    const keys = new Set();
    for await (const record of readRecords(path)) {
      records.push(record);
      if (record !== null) keys.add(recordKey(runId, record));
    }
    const stampAfter = await statStamp(path);
    if (stampsMatch(stampBefore, stampAfter)) {
      dedupCaches.set(safeRunId(runId), {
        keys, size: stampAfter.size, mtimeMs: stampAfter.mtimeMs, transient: false,
      });
    }
    return records;
  };
  const readStateSnapshot = async (runId) => {
    try {
      return JSON.parse(await readFile(statePath(dir, runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        return {
          runId,
          stateStatus: "state_unavailable",
          stateError: "corrupt",
        };
      }
      throw error;
    }
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
        // dedup 在 appendRecord 内修复尾部后判断（防无 LF 尾部绕过幂等）；issue #160：
        // 判定优先走进程内 key set 缓存（(size, mtimeMs) 校验），未命中才流式重建
        await appendRecord(transcriptPath(dir, runId), runId, record, dedupCaches);
      });
    },

    async load(runId) {
      return loadRecords(runId);
    },

    async markRunState(runId, state) {
      await mkdir(dir, { recursive: true });
      const target = statusPath(dir, runId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ runId, status: state, ts: new Date().toISOString() })}\n`,
        "utf8",
      );
      await rename(temporary, target);
    },

    async saveRunState(runId, snapshot) {
      await mkdir(dir, { recursive: true });
      const target = statePath(dir, runId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      let previous = {};
      try {
        previous = JSON.parse(await readFile(target, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const persisted = boundRunState({
        ...previous,
        ...snapshot,
        runId,
        ts: new Date().toISOString(),
      });
      delete persisted.state;
      await writeFile(temporary, `${JSON.stringify(persisted)}\n`, "utf8");
      await rename(temporary, target);
    },

    async saveRunSnapshot(runId, snapshot) {
      await mkdir(dir, { recursive: true });
      const target = snapshotPath(dir, runId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
      await rename(temporary, target);
    },

    async loadLatestRunSnapshot(runId) {
      // 优先读新后缀 .snapshot.json；不存在回落旧后缀 .checkpoint.json（读取兼容，不做迁移）
      try {
        return JSON.parse(await readFile(snapshotPath(dir, runId), "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        return JSON.parse(await readFile(legacyCheckpointPath(dir, runId), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
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
     * @deprecated issue #78：请改用 loadLatestRunSnapshot（新方法兼容读取旧 .checkpoint.json）。
     */
    async loadLatestCheckpoint(runId) {
      return this.loadLatestRunSnapshot(runId);
    },

    async loadRunState(runId) {
      return readStateSnapshot(runId);
    },

    async loadRunStateStatus(runId) {
      const target = statusPath(dir, runId);
      let persisted;
      try {
        persisted = JSON.parse(await readFile(target, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return (await readStateSnapshot(runId))?.state;
        }
        if (error instanceof SyntaxError) {
          throw new Error(
            `run-state status file is corrupt (runId=${runId}): ${target}`,
            { cause: error },
          );
        }
        throw error;
      }
      // This channel has one clean type (string | undefined): damaged data must remain visible,
      // not silently fall back to a potentially stale legacy state.
      if (typeof persisted?.status !== "string") {
        throw new Error(`run-state status file is malformed (runId=${runId}): ${target}`);
      }
      return persisted.status;
    },
  };
}
