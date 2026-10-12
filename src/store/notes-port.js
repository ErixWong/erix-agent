// @ts-check
// NotesStore 端口语义的**共享实现**（issue #265，引擎内部模块，不发公共面）。
//
// 为什么存在：端口此前只有 `assertNotesStore` 这一道「方法在不在」的校验，语义全靠
// 各实现自觉——examples/pi-extension 的手抄内存 store 拿引擎自己的契约套件一量就红
// 2 条（记录完全不校验、purge 的保留期豁免被忽略），证明「靠注释对齐」是漂移根因。
// 本模块把端口语义（记录校验、scopeRef 规范化、list 的 filters/sort/limit 钳制、
// revoke 字段写入、purge 的 before/保留期/scanned）抽成一份实现，`createFileNotesStore`
// 与 `createMemoryNotesStore` 共用，杜绝「再抄一份照样漂」。先例：`src/assembly-validators.js`
// （共享校验器、不发公共面）。
//
// 介质特有物**不在**这里：路径/symlink/0o700/文件名（文件版）、mtime（文件版的 scope
// 时钟来源）——purge 的时钟来源由各自的 `clock()` 提供，语义比较在这里。
// `@typedef`（NotesStore / NoteRecord）留在 src/store/notes.js（0.19 已发布的引用点），
// 这里通过 import("./notes.js") 引用。

import { createHash } from "node:crypto";

// 单一真值的保留期常量住在 src/store/notes.js（那里是 check:docs 的「notes 统一
// 保留期」默认值锚点所在文件，scripts/** 在本单改动面外）；本模块只拥有读取与
// 应用它的语义。运行时循环无害：retentionMs() 只在调用期访问该绑定。
import { DEFAULT_RETENTION_MS } from "./notes.js";

export const HASHED_ID_PREFIX = "run-h-";
const HASHED_ID_PATTERN = /^run-h-[0-9a-f]{24}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
export const MAX_SUPERSEDED = 3;
export const STATES = new Set(["active", "done", "revoked"]);

export class NotesStoreError extends Error {
  constructor(message, code = "invalid_record") {
    super(message);
    this.name = "NotesStoreError";
    this.code = code;
  }
}

export function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

/**
 * scopeRef 规范化（端口语义）：不安全身份 canonicalize 成 `run-h-<sha256-24>`，
 * 但**不改记录公开 key**。契约套件对每个 adapter 都断言这条（unsafe scopes 往返）。
 */
export function safeId(value) {
  const text = String(value);
  if (HASHED_ID_PATTERN.test(text)) return text;
  return SAFE_ID_PATTERN.test(text)
    && text !== "." && text !== ".." && !text.startsWith(HASHED_ID_PREFIX)
    ? text
    : `${HASHED_ID_PREFIX}${digest(text)}`;
}

export function assertRequest(request, { keyRequired = false, scopeRefRequired = true } = {}) {
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
 * @returns {record is import("./notes.js").NoteRecord}
 */
export function isNoteRecord(record, expected = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  // 结构前置已由上面三行完成；用显式别名访问字段（语义与逐条短路链完全同形）。
  const rec = /** @type {Record<string, any>} */ (record);
  return Boolean(
    typeof rec.key === "string"
      && (expected.key === undefined || rec.key === expected.key)
      && rec.scope === "run"
      && typeof rec.scopeRef === "string"
      && (expected.scopeRef === undefined || rec.scopeRef === expected.scopeRef)
      && rec.current
      && typeof rec.current === "object"
      && !Array.isArray(rec.current)
      && Array.isArray(rec.superseded)
      && rec.superseded.length <= MAX_SUPERSEDED
      && rec.superseded.every((entry) => (
        entry && typeof entry === "object" && !Array.isArray(entry) && entry.invalid === true
      ))
      && Number.isSafeInteger(rec.folded)
      && rec.folded >= 0
      && STATES.has(rec.state)
      && Array.isArray(rec.tags)
      && rec.tags.every((tag) => typeof tag === "string"),
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
export function retentionMs() {
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

export function matchesListFilters(record, filters) {
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

export const LIST_SORTS = {
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

export function normalizeListRequest(request) {
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

// ---------------------------------------------------------------------------
// 写路径与生命周期字段的共享语义（issue #265）：文件版与内存版必须产出逐字相同的
// 记录变更与错误文案——错误文案本身是契约（契约套件钉 /valid NoteRecord/ 等）。
// ---------------------------------------------------------------------------

/**
 * write 的记录校验：以 canonical scopeRef 覆盖记录身份，畸形记录必须 reject。
 * （手抄版曾完全不校验记录——契约套件红点 1 的根因。）
 *
 * @param {{ record?: unknown, key: string }} request
 * @param {string} scopeRef canonicalized scopeRef
 * @returns {Record<string, any>}
 */
export function prepareWriteRecord(request, scopeRef) {
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
  return record;
}

/**
 * complete 的记录变更：只置 state + 推进 updated_at，不写 expires_at（ADR-018 D7）。
 *
 * @param {object} record
 * @param {string} timestamp
 * @returns {Record<string, any>}
 */
export function applyComplete(record, timestamp) {
  return { ...record, state: "done", updated_at: timestamp };
}

/**
 * revoke 的前置守卫（missing/unchanged 哨兵 + 并发护栏）：命中即返回终态，
 * 未命中返回 undefined（调用方继续写入）。expectedState/expectedUpdatedAt 是
 * 并发护栏：检查后被他人改写过的记录一律 unchanged，不得覆盖（防并发误撤销）。
 *
 * @param {any} current 端口读出的当前记录（undefined = 不存在）
 * @param {{ expectedState?: string, expectedUpdatedAt?: string }} request
 * @returns {{ status: "missing"|"unchanged", revoked: 0 }|undefined}
 */
export function revokeGuard(current, request) {
  if (!current) return { status: "missing", revoked: 0 };
  if (current.state === "revoked") return { status: "unchanged", revoked: 0 };
  if (request.expectedState !== undefined && current.state !== request.expectedState) {
    return { status: "unchanged", revoked: 0 };
  }
  if (
    request.expectedUpdatedAt !== undefined
    && current.updated_at !== request.expectedUpdatedAt
  ) {
    return { status: "unchanged", revoked: 0 };
  }
  return undefined;
}

/**
 * revoke 的记录变更：state + revoked_at + updated_at 同步推进，reason 落
 * `revoke_reason`（手抄版曾丢 reason、不写 revoked_at——套件补断言钉住的点）。
 *
 * @param {any} record
 * @param {{ timestamp: string, reason?: string }} options
 * @returns {Record<string, any>}
 */
export function applyRevokeFields(record, { timestamp, reason }) {
  return {
    ...record,
    state: "revoked",
    revoked_at: timestamp,
    updated_at: timestamp,
    ...(reason === undefined ? {} : { revoke_reason: reason }),
  };
}

/**
 * purge 的 cutoff 语义：`before` 只能**缩小**删除窗口（取更早的 cutoff，绝不放大），
 * 与自然保留期取 min。assertRequest 的 scopeRef 可选（purge 是全量清扫，
 * 无视 scopeRef）也在这里守住。
 *
 * @param {{ scope?: "run", scopeRef?: string, before?: string }} request
 * @param {() => number} clock
 * @returns {number} cutoff（epoch 毫秒）
 */
export function purgeCutoff(request, clock) {
  assertRequest(request, { scopeRefRequired: false });
  let beforeMs;
  if (request.before !== undefined) {
    beforeMs = Date.parse(request.before);
    if (!Number.isFinite(beforeMs)) {
      throw new TypeError("NotesStore purge before must be a parseable date string");
    }
  }
  return Math.min(beforeMs ?? Number.POSITIVE_INFINITY, clock() - retentionMs());
}

/**
 * purge 的保留期豁免（ADR-018 D7，手抄版红点 2 的语义）：scope 内最新一次写入
 * 仍在保留期内 → 整个 scope 豁免（含其中很老的笔记——会话活着，笔记本整体保留）。
 * 「复活即续命」：复活后任意写入刷新整个 scope 的时钟（clock 来源介质特有）。
 *
 * @param {number} lastWriteMs scope 时钟（文件版 = 目录内记录文件最大 mtime；
 *   内存版 = 最近一次 write() 的 clock()）
 * @param {number} cutoff purgeCutoff 的结果
 * @returns {boolean} true = 豁免，一条不删
 */
export function isScopeExempt(lastWriteMs, cutoff) {
  return lastWriteMs >= cutoff;
}

// key sanitize（safeKey 的 `note-h-` 文件名口径）留在文件版——它是介质特有物。
