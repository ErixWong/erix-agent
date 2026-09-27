import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const HASHED_ID_PREFIX = "run-h-";
const HASHED_KEY_PREFIX = "note-h-";
const HASHED_ID_PATTERN = /^run-h-[0-9a-f]{24}$/u;
// 统一保留期（ADR-018 D7）：单时钟一律枪毙——任何记录 updated_at 早于
// now - retention 即被 purge 物理删除，无论 state（active/done/revoked）。
// 状态字段只服务模型可见性（note_list 默认 active）与语义标签，与清理无关。
// 复活窗口 = 最后写入后 30 天；健康任务长期不写某条笔记的理论误杀已被维护者
// 显式接受。默认 30 天。
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SUPERSEDED = 3;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(["active", "done", "revoked"]);

/**
 * A complete persisted notes record. The adapter deliberately preserves
 * additional fields so future record metadata survives a read/write cycle.
 *
 * @typedef {{
 *   key: string,
 *   scope: "run",
 *   scopeRef: string,
 *   current: object,
 *   superseded: object[],
 *   folded: number,
 *   pinned?: boolean,
 *   tags: string[],
 *   relevance?: number,
 *   state: "active"|"done"|"revoked",
 *   created_at?: string,
 *   updated_at?: string,
 *   expires_at?: string,  // 历史遗留字段：0.12.0 起 complete 不再写，purge 不读
 *   revoked_at?: string,
 *   [key: string]: any
 * }} NoteRecord
 */

/**
 * NotesStore is the cross-run memory port used by the notes skill and guard.
 * `scopeRef` is the logical run identity; file adapters canonicalize unsafe
 * identities without changing the record's public key.
 *
 * The built-in file adapter assumes one writer per scope/key. Concurrent
 * read-modify-write updates may lose one update and its superseded history
 * (last-write-wins); hosts that need concurrency must serialize writes.
 *
 * @typedef {{
 *   write: (request: {scope?: "run", scopeRef: string, key: string, record: NoteRecord}) => Promise<void>,
 *   read: (request: {scope?: "run", scopeRef: string, key: string}) => Promise<NoteRecord|undefined>,
 *   list: (request: {scope?: "run", scopeRef: string, limit?: number, filters?: {state?: ("active"|"done"|"revoked")|("active"|"done"|"revoked")[], tag?: string, source?: "agent"|"auto", minRelevance?: number}, sort?: "relevance"|"pinned_updated"}) => Promise<NoteRecord[]>,
 *   complete: (request: {scope?: "run", scopeRef: string}) => Promise<{status: "found", completed: number}>,
 *   revoke: (request: {scope?: "run", scopeRef: string, key: string, reason?: string, expectedState?: "active"|"done", expectedUpdatedAt?: string}) => Promise<{status: "found"|"missing"|"unchanged", revoked: number}>,
 *   purge: (request: {scope?: "run", before?: string}) => Promise<{status: "found", scanned: number, purged: number}>  // 全量清扫（无视 scopeRef），scanned = 扫描的 scope 目录数，purged = 删除的记录文件数
 * }} NotesStore
 */

export class NotesStoreError extends Error {
  constructor(message, code = "invalid_record") {
    super(message);
    this.name = "NotesStoreError";
    this.code = code;
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function safeId(value) {
  const text = String(value);
  if (HASHED_ID_PATTERN.test(text)) return text;
  return SAFE_ID_PATTERN.test(text)
    && text !== "." && text !== ".." && !text.startsWith(HASHED_ID_PREFIX)
    ? text
    : `${HASHED_ID_PREFIX}${digest(text)}`;
}

function safeKey(value) {
  const text = String(value);
  return SAFE_KEY_PATTERN.test(text)
    && text !== "." && text !== ".." && !text.startsWith(HASHED_KEY_PREFIX)
    ? text
    : `${HASHED_KEY_PREFIX}${digest(text)}`;
}

function assertRequest(request, { keyRequired = false, scopeRefRequired = true } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("NotesStore request must be an object");
  }
  if (request.scope !== undefined && request.scope !== "run") {
    throw new TypeError("NotesStore supports only run scope");
  }
  if (
    (scopeRefRequired || request.scopeRef !== undefined)
    && (typeof request.scopeRef !== "string" || request.scopeRef.trim() === "")
  ) {
    throw new TypeError("NotesStore scopeRef must be a non-empty string");
  }
  if (keyRequired && (typeof request.key !== "string" || request.key.length === 0)) {
    throw new TypeError("NotesStore key must be a non-empty string");
  }
}

/**
 * Validate a persisted record before an adapter accepts it.
 *
 * @param {unknown} record
 * @param {{key?: string, scopeRef?: string}} [expected] expected scopeRef is canonical
 * @returns {record is NoteRecord}
 */
export function isNoteRecord(record, expected = {}) {
  return Boolean(
    record
      && typeof record === "object"
      && !Array.isArray(record)
      && typeof record.key === "string"
      && (expected.key === undefined || record.key === expected.key)
      && record.scope === "run"
      && typeof record.scopeRef === "string"
      && (expected.scopeRef === undefined || record.scopeRef === expected.scopeRef)
      && record.current
      && typeof record.current === "object"
      && !Array.isArray(record.current)
      && Array.isArray(record.superseded)
      && record.superseded.length <= MAX_SUPERSEDED
      && record.superseded.every((entry) => (
        entry && typeof entry === "object" && !Array.isArray(entry) && entry.invalid === true
      ))
      && Number.isSafeInteger(record.folded)
      && record.folded >= 0
      && STATES.has(record.state)
      && Array.isArray(record.tags)
      && record.tags.every((tag) => typeof tag === "string"),
  );
}

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function isoTimestamp(value, fallback) {
  if (typeof value !== "string") return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/**
 * Normalize a validated NoteRecord's time fields (issue #67 PR 2，PR 3 前置）：
 * updated_at 有效则标准化为 ISO；缺失/非法回退有效 created_at；两者都缺/非法
 * 用固定 epoch（不用当前时间伪造）。其余字段（含未知扩展字段）原样保留。
 * normalize 不洗白非法记录——调用方必须先经 isNoteRecord 严格校验。
 *
 * @param {unknown} record
 * @param {{key?: string, scopeRef?: string}} [expected]
 * @returns {unknown} record（时间字段已补齐）或原样返回的非法记录
 */
export function normalizeNoteRecord(record, expected = {}) {
  if (!isNoteRecord(record, expected)) return record;
  const created = isoTimestamp(record.created_at, FALLBACK_TIMESTAMP);
  const updated = isoTimestamp(record.updated_at, created);
  if (record.created_at === created && record.updated_at === updated) return record;
  return { ...record, created_at: created, updated_at: updated };
}

export function assertNotesStore(store) {
  const required = ["write", "read", "list", "complete", "revoke", "purge"];
  const missing = required.filter((method) => typeof store?.[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(`NotesStore missing required method(s): ${missing.join(", ")}`);
  }
  return store;
}

function notesRootDirectory(dir) {
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new TypeError("NotesStore dir must be a non-empty string");
  }
  return path.resolve(dir);
}

function scopeDirectory(root, scopeRef) {
  return path.join(root, "run", scopeRef);
}

function notePath(directory, key) {
  return path.join(directory, `${safeKey(key)}.json`);
}

async function ensureDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new NotesStoreError(`拒绝使用符号链接目录：${directory}`, "unsafe_path");
    if (!stat.isDirectory()) throw new NotesStoreError(`笔记路径不是目录：${directory}`, "unsafe_path");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function existingScopeDirectory(root, scopeRef) {
  const directory = scopeDirectory(root, scopeRef);
  for (const candidate of [root, path.join(root, "run"), directory]) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new NotesStoreError(`拒绝使用符号链接目录：${candidate}`, "unsafe_path");
      }
      if (!stat.isDirectory()) {
        throw new NotesStoreError(`笔记路径不是目录：${candidate}`, "unsafe_path");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }
  return directory;
}

async function readRecord(file, key, scopeRef) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new NotesStoreError(`拒绝读取符号链接文件：${file}`, "unsafe_path");
    if (!stat.isFile()) throw new NotesStoreError(`笔记路径不是普通文件：${file}`, "unsafe_path");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!isNoteRecord(parsed, { key, scopeRef })) {
      throw new NotesStoreError("笔记记录字段无效", "invalid_record");
    }
    // read/list 统一出口：保证 updated_at/created_at 存在（normalize 兜底）。
    return normalizeNoteRecord(parsed, { key, scopeRef });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new NotesStoreError("JSON 解析失败", "invalid_record");
    }
    throw error;
  }
}

async function writeRecord(root, scopeRef, record) {
  const directory = scopeDirectory(root, scopeRef);
  await ensureDirectory(root);
  await ensureDirectory(path.join(root, "run"));
  await ensureDirectory(directory);
  const target = notePath(directory, record.key);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cause = cleanupError;
    }
    throw error;
  }
}

async function listFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    // 隐藏文件（metadata sidecar 等）不得被当成 note 记录。
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink())
      && !entry.name.startsWith(".")
      && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

function configuredMs(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// 统一保留期（ADR-018 D7）：单旋钮。ERIX_NOTES_RETENTION_MS 为唯一权威变量；
// ERIX_NOTES_GRACE_MS 是 0.11.0 发布过的 deprecated alias（两者并存以新变量
// 为准）。ERIX_NOTES_DONE_GRACE_MS / ERIX_NOTES_TOMBSTONE_RETENTION_MS 从未随
// 0.12.0 发布，直接消失，无兼容包袱（审计 F 项）。
function retentionMs() {
  return configuredMs("ERIX_NOTES_RETENTION_MS")
    ?? configuredMs("ERIX_NOTES_GRACE_MS")
    ?? DEFAULT_RETENTION_MS;
}

// ---------------------------------------------------------------------------
// list() 请求规整：limit 钳制（给了才生效，最大 200；不给 = 全部匹配记录）、
// filters、sort。无 revision/游标协议——单 run 实测量级（平均约 2 条、峰值
// 9 条）下翻页与版本锚是 YAGNI（维护者复盘，ADR-018 D3 决策反转）。
// ---------------------------------------------------------------------------

function normalizeListFilters(filters) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== "object" || Array.isArray(filters)) {
    throw new TypeError("NotesStore filters must be an object");
  }
  const normalized = {};
  if (filters.state !== undefined) {
    const states = Array.isArray(filters.state) ? filters.state : [filters.state];
    if (states.length === 0 || states.some((state) => !STATES.has(state))) {
      throw new TypeError('NotesStore filters.state must be "active", "done", "revoked" or an array of them');
    }
    normalized.state = new Set(states);
  }
  if (filters.tag !== undefined) {
    if (typeof filters.tag !== "string") throw new TypeError("NotesStore filters.tag must be a string");
    normalized.tag = filters.tag;
  }
  if (filters.source !== undefined) {
    if (filters.source !== "agent" && filters.source !== "auto") {
      throw new TypeError('NotesStore filters.source must be "agent" or "auto"');
    }
    normalized.source = filters.source;
  }
  if (filters.minRelevance !== undefined) {
    if (!Number.isFinite(filters.minRelevance)
      || filters.minRelevance < 0
      || filters.minRelevance > 1) {
      throw new TypeError("NotesStore filters.minRelevance must be a number between 0 and 1");
    }
    normalized.minRelevance = filters.minRelevance;
  }
  return normalized;
}

function matchesListFilters(record, filters) {
  if (filters.state !== undefined && !filters.state.has(record.state)) return false;
  if (filters.tag !== undefined && !record.tags.includes(filters.tag)) return false;
  const source = record.current?.provenance?.source === "auto" ? "auto" : "agent";
  if (filters.source !== undefined && source !== filters.source) return false;
  const relevance = Number.isFinite(record.relevance) ? record.relevance : 0.5;
  if (filters.minRelevance !== undefined && relevance < filters.minRelevance) return false;
  return true;
}

function relevanceOf(record) {
  return Number.isFinite(record.relevance) ? record.relevance : 0.5;
}

function updatedAtMs(record) {
  const ms = Date.parse(record.updated_at);
  return Number.isFinite(ms) ? ms : undefined;
}

function compareKeyAsc(left, right) {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// 排序全部用稳定比较（key ASC 兜底），不依赖 localeCompare；非字符串/非法
// updated_at 走 normalize 兜底为合法 ISO，这里再防御一层（非法值排最后）。
function compareUpdatedDesc(left, right) {
  const leftMs = updatedAtMs(left);
  const rightMs = updatedAtMs(right);
  if (leftMs === rightMs) return 0;
  if (leftMs === undefined) return 1;
  if (rightMs === undefined) return -1;
  return rightMs - leftMs;
}

const LIST_SORTS = {
  relevance: (left, right) => (
    (relevanceOf(right) - relevanceOf(left))
    || compareUpdatedDesc(left, right)
    || compareKeyAsc(left, right)
  ),
  pinned_updated: (left, right) => (
    ((right.pinned === true ? 1 : 0) - (left.pinned === true ? 1 : 0))
    || compareUpdatedDesc(left, right)
    || compareKeyAsc(left, right)
  ),
};

function normalizeListRequest(request) {
  let limit;
  if (request.limit !== undefined) {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new TypeError("NotesStore limit must be a positive safe integer");
    }
    // 超过 200 钳制到 200（不是报错）；不给 limit = 返回全部匹配记录。
    limit = Math.min(request.limit, 200);
  }
  const filters = normalizeListFilters(request.filters);
  const sort = request.sort === undefined ? "relevance" : request.sort;
  if (!Object.hasOwn(LIST_SORTS, sort)) {
    throw new TypeError('NotesStore sort must be "relevance" or "pinned_updated"');
  }
  return { limit, filters, sort };
}

/**
 * Create the built-in JSON file adapter for NotesStore.
 *
 * @param {{dir: string, clock?: () => number}} options
 * @returns {NotesStore}
 */
export function createFileNotesStore({ dir, clock = () => Date.now() }) {
  const root = notesRootDirectory(dir);
  if (typeof clock !== "function") throw new TypeError("NotesStore clock must be a function");

  const requestScope = (request) => {
    assertRequest(request);
    return safeId(request.scopeRef);
  };

  const store = {
    async write(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = requestScope(request);
      const record = request.record
        && typeof request.record === "object"
        && !Array.isArray(request.record)
        ? { ...request.record, scopeRef }
        : request.record;
      if (!isNoteRecord(record, {
        key: request.key,
        scopeRef,
      })) {
        throw new TypeError("NotesStore write requires a valid NoteRecord");
      }
      await writeRecord(root, scopeRef, record);
    },

    async read(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = requestScope(request);
      const directory = await existingScopeDirectory(root, scopeRef);
      if (!directory) return undefined;
      return readRecord(notePath(directory, request.key), request.key, scopeRef);
    },

    // list：朴素数组契约。不给 limit → 返回全部匹配记录（内部消费方
    // complete 与宿主自建清理循环依赖全量语义）；给了 limit → 钳制最大 200。
    // 索引方案取舍（ADR-018 D4）：file adapter 选择「每次扫描目录构建内存
    // 视图 + 过滤排序」，不维护 .index.json 索引——单 scope 记录量在
    // note_list 与 semantic 的消费规模下全量读取成本可控；索引要写穿
    // write/complete/revoke/purge 四处失效点并处理崩溃一致性，
    // 复杂度大于收益。无 revision/游标协议（ADR-018 D3 决策反转）。
    async list(request) {
      const scopeRef = requestScope(request);
      const { limit, filters, sort } = normalizeListRequest(request);
      const directory = await existingScopeDirectory(root, scopeRef);
      const records = [];
      if (directory !== undefined) {
        for (const file of await listFiles(directory)) {
          const parsed = await readRecord(file, undefined, scopeRef);
          if (parsed === undefined || !matchesListFilters(parsed, filters)) continue;
          records.push(parsed);
        }
      }
      records.sort(LIST_SORTS[sort]);
      return limit === undefined ? records : records.slice(0, limit);
    },

    async complete(request) {
      const scopeRef = requestScope(request);
      // 内部全量收集：不走公共 list（避免 limit 钳制截断），直接扫描本
      // scope 目录取全部 active 记录，再逐条 read+write 置 done。
      // 单时钟规则（ADR-018 D7）：complete 只置 state + 推进 updated_at，
      // 不再写 expires_at——purge 只看 updated_at，done/revoked/active 与清理无关。
      const directory = await existingScopeDirectory(root, scopeRef);
      const activeKeys = [];
      if (directory !== undefined) {
        for (const file of await listFiles(directory)) {
          const record = await readRecord(file, undefined, scopeRef);
          if (record === undefined || record.state !== "active") continue;
          activeKeys.push(record.key);
        }
      }
      let completed = 0;
      for (const key of activeKeys) {
        const current = await store.read({ scope: "run", scopeRef, key });
        if (!current || current.state !== "active") continue;
        await store.write({
          scope: "run",
          scopeRef,
          key: current.key,
          record: {
            ...current,
            state: "done",
            updated_at: new Date(clock()).toISOString(),
          },
        });
        completed += 1;
      }
      return { status: "found", completed };
    },

    async revoke(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = requestScope(request);
      const current = await store.read({ scope: "run", scopeRef, key: request.key });
      if (!current) return { status: "missing", revoked: 0 };
      if (current.state === "revoked") return { status: "unchanged", revoked: 0 };
      // expectedState/expectedUpdatedAt 是并发护栏：检查后被他人改写过的
      // 记录一律 unchanged，不得覆盖（防并发误撤销）。
      if (request.expectedState !== undefined && current.state !== request.expectedState) {
        return { status: "unchanged", revoked: 0 };
      }
      if (
        request.expectedUpdatedAt !== undefined
        && current.updated_at !== request.expectedUpdatedAt
      ) {
        return { status: "unchanged", revoked: 0 };
      }
      const timestamp = new Date(clock()).toISOString();
      await store.write({
        scope: "run",
        scopeRef,
        key: current.key,
        record: {
          ...current,
          state: "revoked",
          revoked_at: timestamp,
          updated_at: timestamp,
          ...(request.reason === undefined ? {} : { revoke_reason: request.reason }),
        },
      });
      return { status: "found", revoked: 1 };
    },

    async purge(request = {}) {
      // scope 是笔记的生命体（ADR-018 D7）：钟挂 scope、整本存亡、到达清扫。
      // 一个 scope 目录内最新一次写入（= 目录内全部记录文件的最大 mtime，
      // 不解析 JSON）距今超过 retentionMs → 该 scope 全部记录文件整体删除
      //（含 active），空目录一并移除；未超 retention → 整个 scope 豁免（含
      // 其中很老的笔记——会话活着，笔记本整体保留）。「复活即续命」：
      // 复活后任意写入刷新整个 scope 的时钟。purge 纯 mtime 比较，不读记录
      // 内容；state 只服务模型可见性与语义标签，与清理无关。
      // before 只能缩小范围（取更早的 cutoff，绝不放大删除窗口）。
      // 无 limit/cursor 分页（ADR-018 D8，审计 C 项）：一次调用全量处理。
      // purge 对整个 run 根全量清扫：不给 scopeRef，传了也忽略（不分 scope）。
      assertRequest(request, { scopeRefRequired: false });
      let beforeMs;
      if (request.before !== undefined) {
        beforeMs = Date.parse(request.before);
        if (!Number.isFinite(beforeMs)) {
          throw new TypeError("NotesStore purge before must be a parseable date string");
        }
      }
      const cutoff = Math.min(beforeMs ?? Number.POSITIVE_INFINITY, clock() - retentionMs());
      const runDirectory = path.join(root, "run");
      let scopeDirs;
      try {
        const stat = await lstat(runDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new NotesStoreError(`笔记 run 路径无效：${runDirectory}`, "unsafe_path");
        }
        scopeDirs = await readdir(runDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return { status: "found", scanned: 0, purged: 0 };
        throw error;
      }
      let scanned = 0;
      let purged = 0;
      for (const entry of scopeDirs.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(runDirectory, entry.name);
        const dirStat = await lstat(directory);
        if (dirStat.isSymbolicLink()) {
          throw new NotesStoreError(`拒绝扫描符号链接目录：${directory}`, "unsafe_path");
        }
        // scopeRef 非 canonical 的目录不是本适配器产物，不参与维护。
        if (safeId(entry.name) !== entry.name) continue;
        scanned += 1;
        const files = (await listFiles(directory)).sort();
        let lastWriteMs = -Infinity;
        for (const file of files) {
          const fileStat = await lstat(file);
          if (fileStat.mtimeMs > lastWriteMs) lastWriteMs = fileStat.mtimeMs;
        }
        if (files.length === 0) {
          // 空 scope 目录：目录自身 mtime 也早于 cutoff 才移除——并发写者
          // 刚 mkdir 尚未写文件的窗口不得拆除（rmdir 失败即保留）。
          if (dirStat.mtimeMs < cutoff) await rmdir(directory).catch(() => {});
          continue;
        }
        // 整本豁免：scope 内最新写入仍在保留期内。
        if (lastWriteMs >= cutoff) continue;
        for (const file of files) {
          await unlink(file);
          purged += 1;
        }
        // 记录文件删完移除 scope 目录；隐藏 sidecar 残留导致非空时保留。
        await rmdir(directory).catch(() => {});
      }
      return { status: "found", scanned, purged };
    },
  };

  return store;
}
