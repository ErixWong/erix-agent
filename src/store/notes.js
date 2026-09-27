import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const HASHED_ID_PREFIX = "run-h-";
const HASHED_KEY_PREFIX = "note-h-";
const HASHED_ID_PATTERN = /^run-h-[0-9a-f]{24}$/u;
// 默认 7 天：跨周末/长中断场景（周五讨论，下周中回来）done 笔记仍在保留期内可查。
// 实测量级：单 run 平均约 2 条笔记，多留不构成负担。
const DEFAULT_DONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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
 *   expires_at?: string,
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
 *   status: "found"|"cursor_stale",
 *   records: NoteRecord[],
 *   nextCursor: string|null,
 *   revision: string
 * }} NotesListPage
 *
 * @typedef {{
 *   write: (request: {scope?: "run", scopeRef: string, key: string, record: NoteRecord}) => Promise<void>,
 *   read: (request: {scope?: "run", scopeRef: string, key: string}) => Promise<NoteRecord|undefined>,
 *   list: (request: {scope?: "run", scopeRef: string, limit?: number, cursor?: string|null, filters?: {state?: ("active"|"done"|"revoked")|("active"|"done"|"revoked")[], tag?: string, source?: "agent"|"auto", minRelevance?: number}, sort?: "relevance"|"pinned_updated"}) => Promise<NotesListPage>,
 *   complete: (request: {scope?: "run", scopeRef: string}) => Promise<{status: "found", completed: number}>,
 *   revoke: (request: {scope?: "run", scopeRef: string, key: string, reason?: string, expectedState?: "active"|"done", expectedUpdatedAt?: string}) => Promise<{status: "found"|"missing"|"unchanged", revoked: number, revision?: string}>,
 *   janitor: (request: {scope?: "run", scopeRef?: string, limit?: number, cursor?: number}) => Promise<{status: "found", scanned: number, revoked: number, nextCursor: number|null}>,
 *   purge: (request: {scope?: "run", scopeRef?: string, limit?: number, cursor?: string, before?: string}) => Promise<{status: "found", scanned: number, purged: number, nextCursor: string|null}>
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
  const required = ["write", "read", "list", "complete", "revoke", "janitor", "purge"];
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
    // 隐藏文件（.revision 等 metadata）不得被当成 note 记录。
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

// done 保留期：ERIX_NOTES_DONE_GRACE_MS 优先；ERIX_NOTES_GRACE_MS 仅作 deprecated
// alias（两者并存以新变量为准）。graceMs=0 不再有 active orphan 清理语义——
// active 记录的撤销权归宿主 liveness callback（revokeInactive）。
function doneGraceMs() {
  return configuredMs("ERIX_NOTES_DONE_GRACE_MS")
    ?? configuredMs("ERIX_NOTES_GRACE_MS")
    ?? DEFAULT_DONE_GRACE_MS;
}

// tombstone 保留期：purge 只删除 revoked_at 早于 now-retention 的墓碑文件。
function tombstoneRetentionMs() {
  return configuredMs("ERIX_NOTES_TOMBSTONE_RETENTION_MS")
    ?? DEFAULT_TOMBSTONE_RETENTION_MS;
}

function assertLimit(request) {
  if (request.limit !== undefined
    && (!Number.isSafeInteger(request.limit) || request.limit < 1)) {
    throw new TypeError("NotesStore limit must be a positive safe integer");
  }
}

function assertJanitorPagination(request) {
  assertLimit(request);
  if (request.cursor !== undefined
    && (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) {
    throw new TypeError("NotesStore cursor must be a non-negative safe integer");
  }
}

// purge 分页中途会 unlink 文件：数值 offset 游标会因条目左移而跳过墓碑。
// 因此 purge 的 cursor 是稳定的不透明 key（"scopeRef/file"，按扫描序可比较），
// 已处理条目被删除不影响排在其后的条目。
function entryKey(entry) {
  return `${entry.scopeRef}/${path.basename(entry.file)}`;
}

/**
 * 收集 run 根下全部 scope 的记录条目（只读扫描）。损坏记录与符号链接按旧
 * janitor 语义跳过；scopeRef 非 canonical 的目录不参与扫描。
 *
 * @param {string} root
 * @returns {Promise<Array<{scopeRef: string, file: string, record: NoteRecord}>>}
 */
async function collectScopeEntries(root) {
  const runDirectory = path.join(root, "run");
  let entries;
  try {
    const stat = await lstat(runDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new NotesStoreError(`笔记 run 路径无效：${runDirectory}`, "unsafe_path");
    }
    entries = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const collected = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runDirectory, entry.name);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) {
      throw new NotesStoreError(`拒绝扫描符号链接目录：${directory}`, "unsafe_path");
    }
    const scopeRef = safeId(entry.name);
    if (scopeRef !== entry.name) continue;
    for (const file of (await listFiles(directory)).sort()) {
      let record;
      try {
        record = await readRecord(file, undefined, scopeRef);
      } catch (error) {
        if (error?.code === "invalid_record" || error?.code === "unsafe_path") continue;
        throw error;
      }
      if (record) collected.push({ scopeRef, file, record });
    }
  }
  return collected;
}

/**
 * 对扫描结果做 limit/cursor 分页。limit 缺省=全部；窗口恰好覆盖末尾时
 * nextCursor 为 null（调用方循环终止条件）。
 */
function pageWindow(entries, { limit, cursor } = {}) {
  const start = cursor ?? 0;
  const size = limit ?? entries.length;
  const window = entries.slice(start, start + size);
  const consumed = start + window.length;
  return { window, nextCursor: consumed < entries.length ? consumed : null };
}

// ---------------------------------------------------------------------------
// scope revision：每个 scope 维护一个单调递增的非负整数 revision，落在
// run/<scope>/.revision（隐藏文件，listFiles 已排除，绝不参与 note 扫描）。
// revision 是 list() 分页游标与 semantic 增量缓存的绑定版本；文件缺失/损坏
// 时从目录状态（note 文件数）重建并落盘——缺失不得被当成 revision=0 后
// 永不递增。重建值可能小于历史峰值（外部删文件+丢 .revision 的极端情况），
// 只可能造成缓存误失效，不会造成误命中。
// ---------------------------------------------------------------------------

const REVISION_FILE = ".revision";

function revisionPath(directory) {
  return path.join(directory, REVISION_FILE);
}

async function readRevisionNumber(directory) {
  const target = revisionPath(directory);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new NotesStoreError(`拒绝使用符号链接文件：${target}`, "unsafe_path");
    }
    if (!stat.isFile()) return undefined;
    const parsed = Number.parseInt(await readFile(target, "utf8"), 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function persistRevisionNumber(directory, value) {
  const target = revisionPath(directory);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
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

// revisions 是 adapter 进程内的 scope→revision 缓存：write 是热路径，
// 每次递增都重读 .revision 文件代价过高；单写者约定下缓存单调且唯一。
async function currentRevisionNumber(directory, revisions) {
  const cached = revisions.get(directory);
  if (cached !== undefined) return cached;
  const existing = await readRevisionNumber(directory);
  let value;
  if (existing !== undefined) {
    value = existing;
  } else {
    // 文件缺失/损坏：从目录状态（note 文件数）重建并落盘——缺失不得被
    // 当成 revision=0 后永不递增。
    value = (await listFiles(directory)).length;
    try {
      await persistRevisionNumber(directory, value);
    } catch {
      // 只读目录等落盘失败：本次调用用重建值，后续变更时继续递增/重建。
    }
  }
  revisions.set(directory, value);
  return value;
}

async function bumpRevisionNumber(directory, revisions) {
  const next = (await currentRevisionNumber(directory, revisions)) + 1;
  revisions.set(directory, next);
  await persistRevisionNumber(directory, next);
  return next;
}

// ---------------------------------------------------------------------------
// list() 请求规整：limit 钳制（默认 50、最大 200）、filters、sort、cursor。
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
  let limit = 50;
  if (request.limit !== undefined) {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new TypeError("NotesStore limit must be a positive safe integer");
    }
    // 超过 200 钳制到 200（不是报错）。
    limit = Math.min(request.limit, 200);
  }
  let cursor = null;
  if (request.cursor !== undefined && request.cursor !== null) {
    if (typeof request.cursor !== "string" || request.cursor.trim() === "") {
      throw new TypeError("NotesStore cursor must be a non-empty opaque string");
    }
    cursor = request.cursor;
  }
  const filters = normalizeListFilters(request.filters);
  const sort = request.sort === undefined ? "relevance" : request.sort;
  if (!Object.hasOwn(LIST_SORTS, sort)) {
    throw new TypeError('NotesStore sort must be "relevance" or "pinned_updated"');
  }
  return { limit, cursor, filters, sort };
}

// cursor 是不透明字符串 "<revision>:<offset>"：revision 绑定生成时的 scope
// 版本；revision 不匹配说明翻页期间记录已变更，调用方必须从头翻页。
function parseListCursor(cursor) {
  const separator = cursor.indexOf(":");
  const revision = separator === -1 ? "" : cursor.slice(0, separator);
  const offsetText = separator === -1 ? "" : cursor.slice(separator + 1);
  const offset = Number.parseInt(offsetText, 10);
  if (revision === "" || !/^(0|[1-9]\d*)$/u.test(offsetText)) {
    throw new TypeError("NotesStore cursor is not a valid opaque list cursor");
  }
  return { revision, offset };
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
  // scope revision 的 adapter 进程内缓存（见 currentRevisionNumber）。
  const revisions = new Map();

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
      // write 是 complete/revoke/janitor 变更的最终落点：统一在这里递增
      // scope revision（complete/revoke/janitor 经 store.write 写回）。
      await bumpRevisionNumber(scopeDirectory(root, scopeRef), revisions);
    },

    async read(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = requestScope(request);
      const directory = await existingScopeDirectory(root, scopeRef);
      if (!directory) return undefined;
      return readRecord(notePath(directory, request.key), request.key, scopeRef);
    },

    // 分页 list：返回 NotesListPage。索引方案取舍（issue #67 PR 2）：file
    // adapter 选择「每次扫描目录构建内存视图 + 分页」而非 .index.json 缓存——
    // 单 scope 记录量在 note_list（≤200/页）与 semantic（≤20）的消费规模下
    // 全量读取成本可控；索引要写穿 write/complete/revoke/janitor/purge 五处
    // 失效点并处理崩溃一致性，复杂度大于收益。revision 仍是分页与增量的
    // 正确性锚点，semantic 层靠它做进程内缓存短路。
    async list(request) {
      const scopeRef = requestScope(request);
      const { limit, cursor, filters, sort } = normalizeListRequest(request);
      const directory = await existingScopeDirectory(root, scopeRef);
      const revision = directory === undefined
        ? "0"
        : String(await currentRevisionNumber(directory, revisions));
      let offset = 0;
      if (cursor !== null) {
        const parsed = parseListCursor(cursor);
        if (parsed.revision !== revision) {
          // 翻页期间 scope 已变更：游标不可恢复，调用方从头翻页。
          return { status: "cursor_stale", records: [], nextCursor: null, revision };
        }
        offset = parsed.offset;
      }
      const records = [];
      if (directory !== undefined) {
        for (const file of await listFiles(directory)) {
          const parsed = await readRecord(file, undefined, scopeRef);
          if (parsed === undefined || !matchesListFilters(parsed, filters)) continue;
          records.push(parsed);
        }
      }
      records.sort(LIST_SORTS[sort]);
      const window = records.slice(offset, offset + limit);
      const consumed = offset + window.length;
      return {
        status: "found",
        records: window,
        nextCursor: consumed < records.length ? `${revision}:${consumed}` : null,
        revision,
      };
    },

    async complete(request) {
      const scopeRef = requestScope(request);
      const expires = new Date(clock() + doneGraceMs()).toISOString();
      // 先只读分页收集 active key，再逐条 read+write：write 会递增 revision，
      // 边翻页边写会让剩余游标立刻 stale。
      const activeKeys = [];
      let cursor = null;
      let staleRetries = 0;
      do {
        const page = await store.list({
          scope: "run",
          scopeRef,
          limit: 200,
          ...(cursor === null ? {} : { cursor }),
        });
        if (page.status === "cursor_stale") {
          // 翻页期间记录被（外部）写入：游标失效，从头重扫；重试上限防活锁。
          staleRetries += 1;
          if (staleRetries > 3) {
            throw new NotesStoreError("complete 分页游标反复过期", "cursor_stale");
          }
          activeKeys.length = 0;
          cursor = null;
          continue;
        }
        for (const record of page.records) {
          if (record.state === "active") activeKeys.push(record.key);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
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
            expires_at: expires,
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
      return { status: "found", revoked: 1, revision: timestamp };
    },

    async janitor(request = {}) {
      // 只做一件事：state === "done" && expires_at <= now 的过期记录逐条
      // revoke（写墓碑，revoked_at = tombstone 起点）。active orphan /
      // liveScope / grace 启发式判定已全部移除——active 记录的清理权归宿主
      // liveness callback；墓碑文件删除归 purge。
      assertRequest(request, { scopeRefRequired: false });
      assertJanitorPagination(request);
      const nowMs = clock();
      const entries = await collectScopeEntries(root);
      const { window, nextCursor } = pageWindow(entries, request);
      let revoked = 0;
      for (const { scopeRef, record } of window) {
        if (record.state !== "done") continue;
        const expires = Date.parse(record.expires_at ?? "");
        if (!Number.isFinite(expires) || expires > nowMs) continue;
        const result = await store.revoke({
          scope: "run",
          scopeRef,
          key: record.key,
          reason: "done_expired",
          expectedState: "done",
          expectedUpdatedAt: record.updated_at,
        });
        if (result.status === "found") revoked += 1;
      }
      return { status: "found", scanned: window.length, revoked, nextCursor };
    },

    async purge(request = {}) {
      // 真正删除墓碑文件：state === "revoked" && revoked_at（缺省兜底
      // updated_at）<= now - tombstoneRetention。before 只能缩小范围
      // （取更早的 cutoff，绝不放大删除窗口）。
      assertRequest(request, { scopeRefRequired: false });
      assertLimit(request);
      let beforeMs;
      if (request.before !== undefined) {
        beforeMs = Date.parse(request.before);
        if (!Number.isFinite(beforeMs)) {
          throw new TypeError("NotesStore purge before must be a parseable date string");
        }
      }
      const cutoff = Math.min(beforeMs ?? Number.POSITIVE_INFINITY, clock() - tombstoneRetentionMs());
      const entries = await collectScopeEntries(root);
      let start = 0;
      if (request.cursor !== undefined) {
        if (typeof request.cursor !== "string" || request.cursor.trim() === "") {
          throw new TypeError("NotesStore purge cursor must be a non-empty string");
        }
        const following = entries.findIndex((entry) => entryKey(entry) > request.cursor);
        start = following === -1 ? entries.length : following;
      }
      const size = request.limit ?? entries.length;
      const window = entries.slice(start, start + size);
      const nextCursor = start + window.length < entries.length && window.length > 0
        ? entryKey(window[window.length - 1])
        : null;
      let purged = 0;
      for (const { scopeRef, file, record } of window) {
        if (record.state !== "revoked") continue;
        const revokedAt = Date.parse(record.revoked_at ?? record.updated_at ?? "");
        if (!Number.isFinite(revokedAt) || revokedAt > cutoff) continue;
        // 删除前重读：期间被 revive（state 不再是 revoked）或 revoked_at 变化
        // 的墓碑不得删除。
        const current = await readRecord(file, record.key, scopeRef);
        if (!current || current.state !== "revoked") continue;
        const currentRevokedAt = Date.parse(current.revoked_at ?? current.updated_at ?? "");
        if (!Number.isFinite(currentRevokedAt) || currentRevokedAt > cutoff) continue;
        await unlink(file);
        // purge 直接删除文件（不经过 store.write），revision 在这里递增：
        // list 视图变化必须让进行中的分页游标与 semantic 缓存失效。
        await bumpRevisionNumber(path.dirname(file), revisions);
        purged += 1;
      }
      return { status: "found", scanned: window.length, purged, nextCursor };
    },
  };

  return store;
}
