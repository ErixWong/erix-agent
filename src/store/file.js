import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundRunState } from "../run-state.js";
import { foldMessageRows } from "./message-rows.js";
import { dedupConflictError, payloadFingerprint, recordKey } from "./transcript-dedup.js";

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
 *   foldedFacts?:{text:string,title:string,origin:"mechanical"|"semantic"|"host",increment?:{text:string,title:string,origin:"mechanical"|"semantic"|"host",from?:number,to?:number,rounds?:number,bytes:number,truncated?:boolean,bytesBefore?:number},summary?:string,toolCalls?:{name:string,argsSummary:string}[],source:string,strategy:string,bytes:number,from?:number,to?:number,rounds?:number,truncated?:boolean,bytesBefore?:number,degradeReason?:string,fingerprint?:string},
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

/**
 * transcript 的落盘路径——**命名口径的唯一实现**（`<dir>/<safeRunId(runId)>.jsonl`）。
 *
 * issue #626 C1：从私有 helper 提成导出，是因为宿主需要**登记**子 run 的 transcript 路径
 * （`createDelegateTool` 的 `transcriptPathFor`）给父 run 的 `tail` 读。宿主**不许**自己拼
 * `${runId}.jsonl`：`safeRunId` 会把不安全的 id 哈希成 `run-h-<sha256>`，手拼的路径对那类 id
 * 恒错，而错法是「文件永远不存在」这种静默形状。
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {string}
 */
export function transcriptPath(dir, runId) {
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

/**
 * issue #626 C1 —— **非破坏性**的「文件尾原始行」读取：只读、不修复尾部、不截断、不写盘。
 *
 * 为什么要它（而不是直接 `createFileTranscriptStore().load()`）：父 run 要看**子 run 现在在干什么**，
 * 而 `load()` 会先跑 `repairTranscriptTail`（`open(path, "r+")` + 半行残段隔离成 `.corrupt.*` + 截断）。
 * 对一个**正在被别的进程追加写**的 transcript，那不是读，那是动刀：父读一次就可能把子还没写完的那一行
 * 截掉。所以尾读必须有自己的口子，而且只能是只读的。
 *
 * 口径（与 `readRecords` 同一个解析单位——一行一个 JSON 对象，**没有第二个 JSONL 解析器**）：
 *   · 从文件尾**反向分块**读，凑够 `lines + 1` 个换行就停（多要一个是为了丢掉可能被切开的半截首行），
 *     或者读到文件头，或者撞上 `maxBytes` 硬上限（病态文件不许把父 run 的内存吃掉）；
 *   · 首行是「窗口切出来的半截」⇒ 丢掉（它不是文件里的半截，是我们读法的边界）；
 *   · 尾行没有换行收尾且 `JSON.parse` 不了 ⇒ `partial: true`（写盘进行中的正常现象），**不抛**；
 *     尾行没有换行但能解析 ⇒ 完整 JSON 缺 LF（崩溃形状），照收，不算 partial——与
 *     `repairTrailingFragment` 的判据同源（那种尾部它会补 `\n` 而不是隔离）；
 *   · 窗口内**非尾部**的坏行按「读不动的行」跳过，不改 `partial`（单写者追加写只可能坏在尾部；
 *     真坏了也不该让父 run 拿不到后面那些好行）。
 *
 * 返回 `{ rows, partial, hasMore, missing }`：`rows` 是解析成功的对象行（落盘顺序），
 * `hasMore` 表示窗口之外**还有更早的行没给**（= 只回了文件尾），`missing` 表示文件不存在/打不开。
 *
 * @param {string} path transcript 文件路径
 * @param {{lines?: number, chunkBytes?: number, maxBytes?: number}} [options]
 *   `lines` 至少要凑够的行数（不含可能被丢掉的那半截），缺省 9；`chunkBytes` 单次读的字节数，缺省 64 KiB；
 *   `maxBytes` 反向读的总字节硬上限，缺省 4 MiB。
 * @returns {Promise<{rows: any[], partial: boolean, hasMore: boolean, missing: boolean}>}
 */
export async function readTranscriptTailLines(path, { lines = 9, chunkBytes = 64 * 1024, maxBytes = 4 * 1024 * 1024 } = {}) {
  const empty = { rows: [], partial: false, hasMore: false, missing: false };
  const want = Number.isInteger(lines) && lines > 0 ? lines + 1 : 9;
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return { ...empty, missing: true };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return empty;
    /** @type {Buffer[]} */
    const chunks = [];
    let position = size;
    let newlines = 0;
    let read = 0;
    while (position > 0 && newlines < want && read < maxBytes) {
      const take = Math.min(chunkBytes, position, maxBytes - read);
      if (take <= 0) break;
      const buffer = Buffer.alloc(take);
      const { bytesRead } = await handle.read(buffer, 0, take, position - take);
      if (bytesRead <= 0) break;
      const slice = bytesRead === take ? buffer : buffer.subarray(0, bytesRead);
      position -= bytesRead;
      read += bytesRead;
      for (const byte of slice) if (byte === 0x0a) newlines += 1;
      chunks.unshift(slice);
    }
    const reachedStart = position === 0;
    let text = Buffer.concat(chunks).toString("utf8");
    if (!reachedStart) {
      // 窗口的起点落在某一行的中间：丢掉这半截（它前面还有更早的行，`hasMore` 会说明）。
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const segments = text.split("\n");
    const endsWithNewline = segments.length > 0 && segments[segments.length - 1] === "";
    if (endsWithNewline) segments.pop();
    /** @type {any[]} */
    const rows = [];
    let partial = false;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.trim() === "") continue;
      const isTail = index === segments.length - 1 && !endsWithNewline;
      try {
        rows.push(JSON.parse(segment.endsWith("\r") ? segment.slice(0, -1) : segment));
      } catch {
        // 尾行解析不了 ⇒ 写盘进行中（partial）；窗口内的其它坏行 ⇒ 跳过，不牵连后面的好行。
        if (isTail) partial = true;
      }
    }
    return { rows, partial, hasMore: !reachedStart, missing: false };
  } finally {
    await handle.close();
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
 * issue #326 事实①后这份缓存**仍然只存 key**（不存 payload 摘要）：缓存的职责只是
 * 「这条 key 在不在」，而判 payload 要的是正文——正文在命中路径上现取（见
 * `findRecordByKey`）。这样热路径一个字节不多花，也不会把陈旧的摘要当成事实。
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

/**
 * 命中同 key 时取回既有记录正文（issue #326 事实①）：幂等缓存只记 key，判「同 payload 还是
 * 异 payload」需要既有正文，所以**只在命中路径**上多跑一次流式扫（miss 路径照常 O(1)，
 * #160 的优化不打折）。拿到的就是盘上那份——比对永远拿真实持久化结果做，不拿缓存副本，
 * 这样缓存顶多把「有没有命中」判错，不会把 payload 内容判错。
 *
 * fail-closed 与 dedupKeysFor 同口径：中间损坏行照旧抛 malformed line。
 *
 * @param {string} path
 * @param {string} runId
 * @param {string} key
 * @returns {Promise<any|undefined>} 没找到（缓存陈旧 / 外部改写过）时 undefined
 */
async function findRecordByKey(path, runId, key) {
  try {
    for await (const existing of readRecords(path)) {
      if (existing !== null && recordKey(runId, existing) === key) return existing;
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Transcript contains a malformed line: ${path}`, { cause: error });
    }
    throw error;
  }
  return undefined;
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
      // issue #326 事实①：命中同 key 不再直接丢弃来写的 payload。同 payload → 幂等 no-op
      // （历史行为）；异 payload → 抛 TranscriptDedupConflictError，既不覆盖也不静默丢弃。
      // 判据与 memory store 共用 src/store/transcript-dedup.js，两侧同一份实现。
      const existing = await findRecordByKey(path, runId, key);
      if (existing !== undefined) {
        const existingFingerprint = payloadFingerprint(existing);
        const incomingFingerprint = payloadFingerprint(record);
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
      }
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
      // 工单 261021：读侧折叠——`kind: "message"` 行的正文按轮拼回轮行，宿主可见形状与
      // 「一条消息一落盘」改造前逐字一致；没有消息行的老账本由 foldMessageRows 原样透传。
      return foldMessageRows(await loadRecords(runId));
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
