// @ts-check
// NotesStore 的**内存**适配器（issue #265，引擎公共导出）。
//
// 为什么引擎要自带一份：宿主存在「纯内存 run」形态（如 examples/pi-extension 的
// erix_run：不传 sessionDir 时 transcript 也是内存的），笔记单独去写
// `resolveNotesDir()` 的缺省 `~/.erix/notes` 会污染用户目录、且并发 run 共抢同一
// scope。此前这份实现只存在于扩展里的手抄版——`assertNotesStore` 只查方法在不在、
// 不查语义，手抄版拿引擎自己的契约套件一量就红 2 条。现在端口语义与文件版共用
// src/store/notes-port.js 的同一份实现，两个 adapter 各自跑同一套契约套件。
//
// 介质特有物（与文件版的差异只在存储介质，不在语义）：
//   * Map 代替目录；没有路径/symlink/0o700 概念（不硬搬，端口不承诺）；
//   * scope 时钟来自注入的 `clock()`（文件版用文件 mtime）——purge 的保留期豁免
//     语义因此可测；
//   * 记录进出做 JSON 快照（与文件版 JSON.stringify 落盘同口径：端口承诺的是
//     JSON 值相等，issue #183 裁决 6），返回值不得是内部引用。

import {
  LIST_SORTS,
  assertRequest,
  applyComplete,
  applyRevokeFields,
  isScopeExempt,
  matchesListFilters,
  normalizeListRequest,
  normalizeNoteRecord,
  prepareWriteRecord,
  purgeCutoff,
  revokeGuard,
  safeId,
} from "./notes-port.js";

/**
 * Create the built-in in-memory adapter for NotesStore.
 *
 * Records live in process memory only: nothing touches the filesystem, and a
 * new factory call yields a fully isolated store. The purge retention clock
 * reads `clock()`, so `ERIX_NOTES_RETENTION_MS` semantics are identical to the
 * file adapter's — with `clock` injectable for deterministic tests.
 *
 * @param {{ clock?: () => number }} [options]
 * @returns {import("./notes.js").NotesStore}
 */
export function createMemoryNotesStore({ clock = () => Date.now() } = {}) {
  if (typeof clock !== "function") throw new TypeError("NotesStore clock must be a function");

  /**
   * @type {Map<string, { lastWriteMs: number, records: Map<string, Record<string, any>> }>}
   */
  const scopes = new Map();

  // JSON 快照：写入即定格，调用方之后的 mutate 不得渗进 store；返回值同理
  // （文件版靠「每次从盘上重新 parse」天然满足，这里显式 clone）。
  const snapshot = (record) => (
    record === undefined ? undefined : JSON.parse(JSON.stringify(record))
  );

  const store = {
    async write(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = safeId(request.scopeRef);
      // 与文件版同一条校验（prepareWriteRecord）：畸形记录必须 reject，
      // canonical scopeRef 覆盖记录身份、不改公开 key。
      const record = prepareWriteRecord(request, scopeRef);
      let scope = scopes.get(scopeRef);
      if (scope === undefined) {
        scope = { lastWriteMs: clock(), records: new Map() };
        scopes.set(scopeRef, scope);
      }
      scope.records.set(record.key, snapshot(record));
      // 「复活即续命」：任意写入刷新整个 scope 的 purge 时钟。
      scope.lastWriteMs = clock();
    },

    async read(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = safeId(request.scopeRef);
      const record = scopes.get(scopeRef)?.records.get(request.key);
      // 与文件版 readRecord 出口对齐：normalize 兜底时间字段，返回值非内部引用。
      return /** @type {import("./notes.js").NoteRecord|undefined} */ (
        normalizeNoteRecord(snapshot(record), { key: request.key, scopeRef })
      );
    },

    async list(request) {
      assertRequest(request);
      const scopeRef = safeId(request.scopeRef);
      // 与文件版同序：先规整/校验 limit/filters/sort（非法值即使 scope 不存在
      // 也抛 TypeError），再取记录。
      const { limit, filters, sort } = normalizeListRequest(request);
      const scope = scopes.get(scopeRef);
      const records = [];
      if (scope !== undefined) {
        for (const record of scope.records.values()) {
          const normalized = normalizeNoteRecord(snapshot(record));
          if (matchesListFilters(normalized, filters)) records.push(normalized);
        }
      }
      records.sort(LIST_SORTS[sort]);
      // 同文件 store：不给 limit = 全部匹配记录；给了钳到 200（不是报错）。
      return /** @type {import("./notes.js").NoteRecord[]} */ (
        limit === undefined ? records : records.slice(0, limit)
      );
    },

    async complete(request) {
      assertRequest(request);
      const scopeRef = safeId(request.scopeRef);
      const scope = scopes.get(scopeRef);
      let completed = 0;
      if (scope !== undefined) {
        for (const [key, record] of scope.records) {
          if (record.state !== "active") continue;
          scope.records.set(key, applyComplete(record, new Date(clock()).toISOString()));
          completed += 1;
        }
      }
      return { status: /** @type {"found"} */ ("found"), completed };
    },

    async revoke(request) {
      assertRequest(request, { keyRequired: true });
      const scopeRef = safeId(request.scopeRef);
      const scope = scopes.get(scopeRef);
      const current = normalizeNoteRecord(snapshot(scope?.records.get(request.key)));
      // missing/unchanged 哨兵与并发护栏走共享 revokeGuard；reason/revoked_at
      // 落字段走共享 applyRevokeFields——与文件版逐字同语义（#265 补的套件断言钉）。
      const blocked = revokeGuard(current, request);
      if (blocked !== undefined) return blocked;
      const timestamp = new Date(clock()).toISOString();
      scope.records.set(request.key, applyRevokeFields(current, { reason: request.reason, timestamp }));
      return { status: /** @type {"found"} */ ("found"), revoked: 1 };
    },

    async purge(request = {}) {
      // 全量清扫（无视 scopeRef）；before 只能缩小窗口、保留期内刚写的 scope
      // 整本豁免、scanned = 扫描的 scope 数——三条端口语义全部走共享实现，
      // 本处只留「scope 时钟来自 clock()」这层介质事实（文件版是 mtime）。
      const cutoff = purgeCutoff(request, clock);
      let scanned = 0;
      let purged = 0;
      for (const [scopeRef, scope] of scopes) {
        scanned += 1;
        if (isScopeExempt(scope.lastWriteMs, cutoff)) continue;
        purged += scope.records.size;
        scopes.delete(scopeRef);
      }
      return { status: /** @type {"found"} */ ("found"), scanned, purged };
    },
  };

  return store;
}
