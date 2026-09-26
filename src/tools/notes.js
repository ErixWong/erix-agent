import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import {
  createFileNotesStore,
  assertNotesStore,
  normalizeNoteRecord,
  NotesStoreError,
} from "../store/notes.js";
import { createToolRegistry } from "./registry.js";

export const MAX_CONTENT_LENGTH = 4000;
export const NOTE_VALUE_MAX_CHARS = 256;
const MAX_SUPERSEDED = 3;
const MISSING_NEXT = "该 key 从未记录（never recorded）；未记录、不可恢复；不得重跑命令、不得凭记忆给值";
let clock = () => Date.now();

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function now() {
  return new Date(clock()).toISOString();
}

export function setNotesClock(nextClock) {
  if (typeof nextClock !== "function") throw new TypeError("nextClock must be a function");
  const previous = clock;
  clock = nextClock;
  return () => {
    clock = previous;
  };
}

/**
 * Resolve the notes root directory the same way everywhere (factory default,
 * assembly root, standalone tool fallback): explicit host value first, then
 * ERIX_NOTES_DIR, then ~/.erix/notes.
 */
export function resolveNotesDir(notesDir) {
  return notesDir ?? process.env.ERIX_NOTES_DIR ?? path.join(homedir(), ".erix", "notes");
}

function injectedNotesDir(input) {
  const value = input?.__erix?.notesDir;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function notesRoot(input) {
  return path.resolve(resolveNotesDir(injectedNotesDir(input)));
}

function injectedNotesStore(input) {
  const store = input?.__erix?.notesStore;
  return store
    && typeof store.write === "function"
    && typeof store.read === "function"
    && typeof store.list === "function"
    && typeof store.complete === "function"
    && typeof store.revoke === "function"
    && typeof store.janitor === "function"
    && typeof store.purge === "function"
    ? store
    : undefined;
}

function notesStoreFor(input) {
  return injectedNotesStore(input) ?? createFileNotesStore({
    dir: notesRoot(input),
    clock: () => clock(),
  });
}

function storeRequest(input, key) {
  return {
    scope: "run",
    scopeRef: currentScopeRef(input),
    ...(key === undefined ? {} : { key }),
  };
}

function injectedScopeRef(input) {
  const erix = input?.__erix;
  if (typeof erix === "string" && erix.trim()) return erix.trim();
  if (!erix || typeof erix !== "object" || Array.isArray(erix)) return undefined;
  const scope = erix.scope && typeof erix.scope === "object" ? erix.scope : undefined;
  const value = erix.runId
    ?? erix.scopeRef
    ?? (typeof erix.scope === "string" ? erix.scope : undefined)
    ?? scope?.runId
    ?? scope?.scopeRef
    ?? scope?.ref
    ?? scope?.id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function currentScopeRef(input) {
  const explicit = injectedScopeRef(input);
  if (explicit) return explicit;
  const cwd = process.cwd();
  return `${path.basename(cwd) || "root"}-${digest(cwd).slice(0, 8)}`;
}

function json(value) {
  return JSON.stringify(value);
}

function missing(key) {
  return json({ status: "missing", key, next: MISSING_NEXT });
}

function invalid(key, reason) {
  return json({
    status: "invalid",
    ...(key === undefined ? {} : { key }),
    reason,
    next: "请修正输入或检查笔记存储后重试",
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

// breaking（issue #67 PR 3）：schema 收敛为 run-only；project/user 直接
// invalid（提示「当前仅支持 run 作用域」），不再是「暂不支持」的将来 API 表面。
function validateScope(input) {
  const scope = input?.scope ?? "run";
  return scope === "run" ? "run" : null;
}

function validateKey(input) {
  return typeof input?.key === "string" && input.key.length > 0 ? input.key : null;
}

function contentProvided(input) {
  return input?.content !== undefined && input?.content !== null;
}

function artifactProvided(input) {
  return input?.artifactRef !== undefined
    && input?.artifactRef !== null
    && !(typeof input.artifactRef === "string" && input.artifactRef.length === 0);
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return null;
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeRelevance(value, fallback = 0.5) {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function payloadOf(entry) {
  if (!entry || typeof entry !== "object") return {};
  return {
    ...(entry.content !== undefined ? { content: entry.content } : {}),
    ...(entry.artifactRef !== undefined ? { artifactRef: entry.artifactRef } : {}),
  };
}

function currentEntry(payload, provenance, timestamp) {
  return { ...payload, provenance, ts: timestamp };
}

function publicEntry(entry, { invalid: markInvalid = false } = {}) {
  if (!entry || typeof entry !== "object") return null;
  return {
    ...payloadOf(entry),
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    ...(entry.ts === undefined ? {} : { ts: entry.ts }),
    ...(markInvalid || entry.invalid === true ? { invalid: true } : {}),
  };
}

function validateInput(input) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return { error: invalid(key, "当前仅支持 run 作用域（scope 仅接受 run）") };
  if (!key) return { error: invalid(key, "key 必须是非空字符串") };
  if (contentProvided(input) && typeof input.content !== "string") {
    return { error: invalid(key, "content 必须是字符串") };
  }
  if (contentProvided(input) && input.content.length > MAX_CONTENT_LENGTH) {
    return { error: invalid(key, `content 不得超过 ${MAX_CONTENT_LENGTH} 个字符`) };
  }
  if (!contentProvided(input) && !artifactProvided(input)) {
    return { error: invalid(key, "content 与 artifactRef 至少提供一个") };
  }
  const tags = normalizeTags(input.tags);
  if (tags === null) return { error: invalid(key, "tags 必须是字符串数组") };
  const relevance = input.relevance === undefined
    ? undefined
    : normalizeRelevance(input.relevance);
  if (relevance === null) return { error: invalid(key, "relevance 必须是 0 到 1 之间的数字") };
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") {
    return { error: invalid(key, "pinned 必须是布尔值") };
  }
  if (
    input.provenance !== undefined
    && (!input.provenance || typeof input.provenance !== "object" || Array.isArray(input.provenance))
  ) {
    return { error: invalid(key, "provenance 必须是对象") };
  }
  return { scope, key, tags, relevance };
}

// ADR-016：auto-capture 桥退役，写入口只剩 agent 源（note_take）。
async function writeNote(input = {}) {
  const checked = validateInput(input);
  if (checked.error) return checked.error;
  const { key, tags, relevance } = checked;
  let payload;
  try {
    payload = {
      ...(contentProvided(input) ? { content: input.content } : {}),
      ...(artifactProvided(input) ? { artifactRef: input.artifactRef } : {}),
    };
    canonical(payload);
  } catch {
    return invalid(key, "artifactRef 必须可序列化为 JSON");
  }
  const store = notesStoreFor(input);
  let old;
  try {
    old = await store.read(storeRequest(input, key));
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  const timestamp = now();
  const supplied = input.provenance ?? {};
  const provenance = {
    source: "agent",
    verified: supplied.verified ?? contentProvided(input),
    ...(supplied.toolUseId === undefined ? {} : { toolUseId: supplied.toolUseId }),
    ...(supplied.round === undefined ? {} : { round: supplied.round }),
    ts: timestamp,
  };
  const superseded = old
    ? [
        ...old.superseded.map((entry) => publicEntry(entry, { invalid: true })),
        publicEntry(old.current, { invalid: true }),
      ]
    : [];
  const retained = superseded.slice(-MAX_SUPERSEDED);
  const folded = (old?.folded ?? 0) + Math.max(0, superseded.length - MAX_SUPERSEDED);
  const record = {
    key,
    scope: "run",
    scopeRef: currentScopeRef(input),
    current: currentEntry(payload, provenance, timestamp),
    superseded: retained,
    folded,
    pinned: input.pinned ?? old?.pinned ?? false,
    tags: input.tags === undefined ? (old?.tags ?? tags) : tags,
    relevance: relevance ?? old?.relevance ?? 0.5,
    state: "active",
    created_at: old?.created_at ?? timestamp,
    updated_at: timestamp,
    ...(old?.state === "done" || old?.expires_at === undefined
      ? {}
      : { expires_at: old.expires_at }),
    ...(old?.state === "revoked" ? { revived_at: timestamp } : {}),
  };
  try {
    await store.write({
      ...storeRequest(input, key),
      record,
    });
  } catch (error) {
    if (error?.name === "NotesStoreError") return invalid(key, error?.message ?? String(error));
    throw error;
  }
  return json({
    status: "found",
    action: old ? "updated" : "saved",
    key,
    scope: "run",
    folded,
    superseded: retained.length,
    pinned: record.pinned,
    next: "已保存；后续需要该值时先用 note_read 精确读取",
  });
}

export async function note_take(input = {}) {
  return writeNote(input);
}

function noteReadValue(record) {
  const current = record.current;
  const response = {
    status: "found",
    key: record.key,
    state: record.state,
    pinned: record.pinned,
    tags: record.tags,
    folded: record.folded,
    current: publicEntry(current),
    superseded: record.superseded.map((entry) => publicEntry(entry, { invalid: true })),
    provenance: current.provenance,
    next: "已找到当前记录；superseded 条目已作废，不得当作当前值使用",
  };
  if (current.content !== undefined) response.value = current.content;
  if (current.artifactRef !== undefined) response.artifactRef = current.artifactRef;
  if (current.content === undefined && current.artifactRef !== undefined) {
    const archivePath = typeof current.artifactRef.archivePath === "string"
      ? current.artifactRef.archivePath
      : "<artifactRef.archivePath>";
    response.next = `当前值是 artifactRef；读取 ${archivePath} 的 locator 后核对。superseded 条目已作废，不得当作当前值使用`;
  }
  return response;
}

export async function note_read(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "当前仅支持 run 作用域（scope 仅接受 run）");
  if (!key) return invalid(key, "key 必须是非空字符串");
  let record;
  try {
    record = await notesStoreFor(input).read(storeRequest(input, key));
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  if (!record) return missing(key);
  // 注入 store 不经过 file adapter 的 readRecord 统一出口：防御性 normalize。
  record = normalizeNoteRecord(record, { key });
  if (record.state === "revoked") {
    return json({
      status: "revoked",
      key,
      folded: record.folded,
      superseded: record.superseded.map((entry) => publicEntry(entry, { invalid: true })),
      next: "该记录已撤销；不得把它当作当前值",
    });
  }
  return json(noteReadValue(record));
}

function listEntry(record) {
  const current = record.current;
  return {
    key: record.key,
    tags: record.tags,
    pinned: record.pinned,
    state: record.state,
    folded: record.folded,
    superseded: record.superseded.length,
    hasContent: typeof current.content === "string",
    hasArtifactRef: current.artifactRef !== undefined,
    updated_at: record.updated_at,
    relevance: Number.isFinite(record.relevance) ? record.relevance : 0.5,
    source: current?.provenance?.source === "auto" ? "auto" : "agent",
  };
}

export async function note_list(input = {}) {
  const scope = validateScope(input);
  if (!scope) return invalid(undefined, "当前仅支持 run 作用域（scope 仅接受 run）");
  if (input.tag !== undefined && typeof input.tag !== "string") {
    return invalid(undefined, "tag 必须是字符串");
  }
  if (input.source !== undefined && input.source !== "auto" && input.source !== "agent") {
    return invalid(undefined, "source 必须是 auto 或 agent");
  }
  if (
    input.minRelevance !== undefined
    && (!Number.isFinite(input.minRelevance)
      || input.minRelevance < 0
      || input.minRelevance > 1)
  ) {
    return invalid(undefined, "minRelevance 必须是 0 到 1 之间的数字");
  }
  if (
    input.limit !== undefined
    && (!Number.isSafeInteger(Number(input.limit)) || Number(input.limit) < 1)
  ) {
    return invalid(undefined, "limit 必须为正整数");
  }
  // breaking（issue #67 PR 2）：cursor 从整数 offset 改为不透明字符串
  // （上一次返回的 nextCursor），由 store 绑定 scope revision 校验。
  if (
    input.cursor !== undefined
    && (typeof input.cursor !== "string" || input.cursor.trim() === "")
  ) {
    return invalid(undefined, "cursor 必须是不透明字符串（取上一次返回的 nextCursor）");
  }
  // 过滤与排序全部下沉 store（本地不再全量排序、不再裸调 localeCompare）。
  const filters = {};
  if (input.includeInactive !== true) filters.state = "active";
  if (input.tag !== undefined) filters.tag = input.tag;
  if (input.source !== undefined) filters.source = input.source;
  if (input.minRelevance !== undefined) filters.minRelevance = input.minRelevance;
  let page;
  try {
    page = await notesStoreFor(input).list({
      ...storeRequest(input),
      ...(input.limit === undefined ? {} : { limit: Number(input.limit) }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      filters,
      sort: "relevance",
    });
  } catch (error) {
    return invalid(undefined, error?.message ?? String(error));
  }
  if (page.status === "cursor_stale") {
    // 可恢复的结构化结果：提示从头翻页，不崩溃。
    return json({
      status: "cursor_stale",
      notes: [],
      count: 0,
      nextCursor: null,
      revision: page.revision,
      next: "分页游标已过期（scope 内记录已变更）；请去掉 cursor 从头翻页",
    });
  }
  // 注入 store 的记录缺时间字段时 normalize 兜底（排序/展示不崩）。
  const notes = page.records.map((record) => listEntry(normalizeNoteRecord(record)));
  return json({
    status: "found",
    count: notes.length,
    notes,
    nextCursor: page.nextCursor,
    // breaking：不再承诺 total（分页视图不提供总数）。
    next: page.nextCursor !== null
      ? "还有更多条目；用返回的 nextCursor 继续翻页"
      : "清单仅含当前记录元数据；需要具体值时用 note_read 精确读取",
  });
}

export async function note_forget(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "当前仅支持 run 作用域（scope 仅接受 run）");
  if (!key) return invalid(key, "key 必须是非空字符串");
  const store = notesStoreFor(input);
  let record;
  try {
    record = await store.read(storeRequest(input, key));
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  if (!record) return missing(key);
  if (record.state === "revoked") return json({ status: "revoked", key });
  try {
    // forget = 经 store.revoke 写墓碑（不再读后自写，撤销语义单一来源）。
    const result = await store.revoke(storeRequest(input, key));
    if (result.status === "missing") return missing(key);
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  return json({ status: "revoked", key, next: "已写入撤销墓碑；历史 current 与 superseded 均不可作为当前值" });
}

export async function runNotesJanitor(input = {}) {
  return notesStoreFor(input).janitor(storeRequest(input));
}

export async function completeRun(input = {}) {
  return notesStoreFor(input).complete(storeRequest(input));
}

const TOOL_DEFINITIONS = [
  {
    name: "note_take",
    description: "记录 run 作用域的事实、具体值或 artifact 引用；旧 current 会保留为已作废的 superseded。when-to-use：产生后续还要用的关键事实、一次性值或决策时调用；上下文被折叠时先 note_list，再 note_read key=...；不要遍历归档目录凭记忆补值",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        content: { type: "string", maxLength: MAX_CONTENT_LENGTH },
        artifactRef: {},
        scope: { type: "string", enum: ["run"], default: "run" },
        tags: { type: "array", items: { type: "string" } },
        relevance: { type: "number", minimum: 0, maximum: 1 },
        pinned: { type: "boolean" },
        provenance: { type: "object" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "note_read",
    description: "按精确 key 读取 current，并返回已作废的 superseded 与 folded。when-to-use：上下文被折叠时先 note_list，再 note_read key=...；不要遍历归档目录凭记忆补值",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["run"], default: "run" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "note_list",
    description: "列出 run 作用域笔记的 key、标签和 current 元数据，不返回完整内容。when-to-use：上下文被折叠时先 note_list，再 note_read key=...；翻页用返回的 nextCursor 作为 cursor；不要遍历归档目录凭记忆补值",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["run"], default: "run" },
        tag: { type: "string" },
        minRelevance: { type: "number", minimum: 0, maximum: 1 },
        source: { type: "string", enum: ["auto", "agent"] },
        limit: { type: "integer", minimum: 1 },
        // breaking（issue #67 PR 2）：cursor 从整数 offset 改为不透明字符串
        // （上一次响应的 nextCursor），由 store 绑定 scope revision 校验。
        cursor: { type: "string" },
        includeInactive: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "note_forget",
    description: "撤销一个 run 作用域笔记并保留墓碑。when-to-use：值已失效或必须明确撤销时调用；上下文被折叠时先 note_list，再 note_read key=...；不要遍历归档目录凭记忆补值",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["run"], default: "run" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
];

const TOOL_EXECUTORS = {
  note_take,
  note_read,
  note_list,
  note_forget,
};

// ADR-015：notes 小抄目录语义——仅 active、最多 20 条、pinned 优先后按 updated_at 排序，
// 以 state.stateVersion 作版本（否则被判 stale）。list 失败或全空返回 undefined（不装懂）。
function renderNotesDirectory(records, state) {
  if (!Array.isArray(records)) return undefined;
  const entries = records
    .filter((record) => record?.state === "active"
      && typeof record?.key === "string" && record.key !== "")
    .sort((a, b) => (
      (b?.pinned === true ? 1 : 0) - (a?.pinned === true ? 1 : 0)
      || String(b?.updated_at ?? "").localeCompare(String(a?.updated_at ?? ""))
    ))
    .slice(0, 20);
  if (entries.length === 0) return undefined;
  const summaryOf = (record) => {
    const current = record.current;
    const raw = typeof current === "string"
      ? current
      : String(current?.summary ?? current?.content ?? "");
    const firstLine = raw.split("\n")[0]?.trim() ?? "";
    if (firstLine !== "") {
      return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    }
    // artifact-only（无 content）条目不留空摘要，渲染占位标记。
    return current?.artifactRef !== undefined ? "artifact 引用" : "";
  };
  const lines = entries.map((record) => {
    // source 与 note_list 一致从 current.provenance.source 派生；
    // 真实落盘记录的顶层没有 source 字段，读顶层会让 @agent 标记永远不出现。
    const flags = [
      record.pinned === true ? "★" : null,
      `@${record.current?.provenance?.source === "auto" ? "auto" : "agent"}`,
    ].filter(Boolean).join(" ");
    return `- ${record.key}${flags ? ` (${flags})` : ""}: ${summaryOf(record)}`;
  });
  return {
    text: ["[notes 小抄目录]（note_read key=... 取全文）", ...lines].join("\n"),
    version: state?.stateVersion,
    status: "ok",
  };
}

function scopedToolInput(input, name, scope) {
  const properties = new Set(
    TOOL_DEFINITIONS.find((tool) => tool.name === name)?.inputSchema?.properties
      ? Object.keys(TOOL_DEFINITIONS.find((tool) => tool.name === name).inputSchema.properties)
      : [],
  );
  const filtered = input && typeof input === "object" && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => properties.has(key)))
    : {};
  return Object.keys(scope).length > 0
    ? { ...filtered, __erix: scope }
    : filtered;
}

const REPORTABLE_STORE_METHODS = ["read", "write", "list", "complete", "revoke", "janitor", "purge"];
// complete/revoke/janitor/purge 与 write 一样会真实写文件（purge 直接 unlink），
// 按写副作用分类；read/list 是纯读。
const WRITE_SIDE_EFFECT_METHODS = new Set(["write", "complete", "revoke", "janitor", "purge"]);
// 已上报过的 (error, operation) 组合（防 decorator 与调用点重复上报同一组合；
// 同一 Error 对象被 complete/janitor 等多个操作复用时，每个 operation 各报一次）。
const reportedStoreFailures = new WeakMap();

async function reportStoreFailure(reporter, operation, error) {
  if (typeof reporter !== "function") return;
  const dedupable = error !== null && (typeof error === "object" || typeof error === "function");
  const reported = dedupable ? reportedStoreFailures.get(error) : undefined;
  if (reported?.has(operation)) return;
  try {
    await reporter({
      port: "notes",
      operation,
      phase: WRITE_SIDE_EFFECT_METHODS.has(operation) ? "write" : "read",
      sideEffect: WRITE_SIDE_EFFECT_METHODS.has(operation)
        ? "executed_uncommitted"
        : "not_started",
      error,
    });
    if (!dedupable) return;
    if (reported) reported.add(operation);
    else reportedStoreFailures.set(error, new Set([operation]));
  } catch {
    // 报告桥自身失败不得阻断工具原有的错误路径。
  }
}

/**
 * Decorate a NotesStore so persistence failures are reported through the
 * engine's generic host-persistence bridge (`context.reportPersistenceFailure`,
 * port="notes") instead of being silently swallowed into tool-level "invalid"
 * JSON. The original error is always re-thrown so existing tool error paths
 * keep working. The reporter is bound per tool execution (and per lifecycle
 * call) by the assembler.
 */
function withPersistenceReporting(store, getReporter) {
  const decorated = {};
  for (const method of REPORTABLE_STORE_METHODS) {
    decorated[method] = async (request) => {
      try {
        return await store[method](request);
      } catch (error) {
        await reportStoreFailure(getReporter(), method, error);
        throw error;
      }
    };
  }
  return decorated;
}

/**
 * liveness 是宿主交给 assembler 的 active orphan 判定端口：isAlive 返回
 * false 的 scopeRef 由 lifecycle.revokeInactive 撤销其 active 记录。
 * ttlMs 必须是 >0 安全整数，否则创建时抛错（不静默降级）。
 */
function validateLiveness(liveness) {
  if (liveness === undefined || liveness === null) return undefined;
  if (typeof liveness !== "object" || Array.isArray(liveness)) {
    throw new TypeError("liveness must be an object with ttlMs and isAlive");
  }
  if (!Number.isSafeInteger(liveness.ttlMs) || liveness.ttlMs <= 0) {
    throw new TypeError("liveness.ttlMs must be a positive safe integer");
  }
  if (typeof liveness.isAlive !== "function") {
    throw new TypeError("liveness.isAlive must be a function");
  }
  return { ttlMs: liveness.ttlMs, isAlive: liveness.isAlive };
}

/**
 * Full notes assembler. One call binds the run scope (runId/scopeRef), the
 * notes directory, and a single NotesStore instance; every returned view
 * (executors, executeTool, lifecycle, semanticStateProvider) reuses them and
 * forcibly overrides any caller-forged `__erix` injection.
 *
 * @param {{notesDir?: string, notesStore?: object, runId?: string, scopeRef?: string, liveness?: {ttlMs: number, isAlive: Function}}} options
 * @returns {{
 *   definitions: object[],
 *   executors: Function, executeTool: Function, resolveTools: Function,
 *   lifecycle: {onRunStart: Function, onRunComplete: Function, revokeInactive: Function},
 *   semanticStateProvider: Function,
 * }}
 */
export function createBuiltinNotesTools(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  // scope 固定：创建时解析并绑定 runId/scopeRef、notesDir、notesStore。
  const boundScopeRef = opts.runId !== undefined
    ? String(opts.runId)
    : opts.scopeRef !== undefined ? String(opts.scopeRef) : undefined;
  const resolvedNotesDir = path.resolve(resolveNotesDir(opts.notesDir));
  // 单一 store 实例：executeTool、lifecycle、semanticStateProvider 共用，
  // 禁止各自隐式创建。
  const boundStore = opts.notesStore ?? createFileNotesStore({
    dir: resolvedNotesDir,
    clock: () => clock(),
  });
  // 创建期即校验端口完整性：缺 revoke/purge 等方法立即 TypeError，
  // 不静默回退到隐式 file store（生命周期三阶段拆分后两者都是必需方法）。
  assertNotesStore(boundStore);
  // liveness（host 的 active orphan 判定）与 notesStore 同级绑定进作用域，
  // 调用方伪造的 __erix 无法覆盖（lifecycleInput 强制覆盖）。
  const boundLiveness = validateLiveness(opts.liveness);

  // 并发约定：assembler 假定宿主串行调用（runToolLoop 单线程循环）；
  // activeReporter 的 set/restore 不防并发交错，并发复用同一 assembler
  // 需宿主在宿主边界自行串行化（与 NotesStore 的 single-writer 约定一致）。
  let activeReporter;
  const reportedStore = withPersistenceReporting(boundStore, () => activeReporter);
  // issue #67 PR 2：semantic 增量缓存的本地失效锚。store 是单写者（file
  // adapter 约定），assembler 内任何变更（write/complete/revoke/janitor/
  // purge）都会经过这里并推进 epoch；epoch 未变则 scope revision 不可能变，
  // semantic 直接复用缓存文本，连 list 都不调（不读任何记录文件）。
  let semanticEpoch = 0;
  const store = { ...reportedStore };
  for (const method of ["write", "complete", "revoke", "janitor", "purge"]) {
    store[method] = async (request) => {
      const result = await reportedStore[method](request);
      semanticEpoch += 1;
      return result;
    };
  }
  const scope = {
    ...(boundScopeRef === undefined ? {} : { runId: boundScopeRef }),
    notesDir: resolvedNotesDir,
    notesStore: store,
    ...(boundLiveness === undefined ? {} : { liveness: boundLiveness }),
  };

  // lifecycle 输入同样强制覆盖调用方伪造的 __erix（评审修正项）。
  const lifecycleInput = (input) => {
    const base = input && typeof input === "object" && !Array.isArray(input)
      ? input
      : {};
    const { __erix: _discarded, ...rest } = base;
    return { ...rest, __erix: scope };
  };

  const registry = createToolRegistry({
    executors: Object.fromEntries(
      Object.entries(TOOL_EXECUTORS).map(([name, executor]) => [
        name,
        (input, context) => executor(input, context),
      ]),
    ),
    schemas: TOOL_DEFINITIONS,
  });

  // registry 位置参数形态：(name, input, context)。
  const executors = async (name, input, context) => {
    const previousReporter = activeReporter;
    activeReporter = context?.reportPersistenceFailure;
    try {
      return await registry.executeTool(name, scopedToolInput(input, name, scope), context);
    } finally {
      activeReporter = previousReporter;
    }
  };

  // 结构化形态：兼容 runToolLoop/checkpoint-executor 的调用约定
  // executeTool({id, name, input, context, signal})；同时保留位置参数
  // 视图 executeTool(name, input, context) 以兼容既有调用方。
  const executeTool = async (firstArg, positionalInput, positionalContext) => {
    const structured = firstArg
      && typeof firstArg === "object"
      && !Array.isArray(firstArg)
      && typeof firstArg.name === "string";
    const name = structured ? firstArg.name : firstArg;
    const input = structured ? firstArg.input : positionalInput;
    const context = structured
      ? { ...(firstArg.context ?? {}), toolUseId: firstArg.id }
      : positionalContext;
    return executors(name, input, context);
  };

  // lifecycle 调用（complete/revoke 会写文件）同样绑定 reporter：
  // 宿主可经 lifecycle 输入的 reportPersistenceFailure 注入；
  // set/restore 模式与 executor 视图一致。
  const withLifecycleReporter = async (input, fn) => {
    const previousReporter = activeReporter;
    const reporter = input?.reportPersistenceFailure;
    if (typeof reporter === "function") activeReporter = reporter;
    try {
      return await fn();
    } finally {
      activeReporter = previousReporter;
    }
  };

  // lifecycle 三阶段拆分（issue #67）：
  // - onRunStart：轻量 no-op 兼容入口。run 起点不再跑 janitor——过期 done
  //   清理由宿主显式调度 janitor，active orphan 清理权归宿主 liveness。
  // - onRunComplete：只调 completeRun（active → done），返回
  //   { completed, errors }（janitor 字段已移除，breaking）。
  // - revokeInactive：宿主 liveness callback 的入口；对 isAlive=false 的
  //   scopeRef 撤销其 active 记录（经 store.revoke 的 expected-state 护栏）。
  const lifecycle = {
    onRunStart: (input) => withLifecycleReporter(input, async () => ({
      status: "skipped",
      reason: "notes janitor is host-scheduled; run start performs no notes GC",
    })),
    onRunComplete: (input) => withLifecycleReporter(input, async () => {
      const completionErrors = [];
      let completed;
      try {
        completed = await completeRun(lifecycleInput(input));
      } catch (error) {
        completionErrors.push({ operation: "notes_complete_run", error });
      }
      return { completed, errors: completionErrors };
    }),
    revokeInactive: (input) => withLifecycleReporter(input, async () => {
      if (boundLiveness === undefined) {
        return {
          status: "found",
          checked: 0,
          alive: 0,
          revoked: 0,
          skipped: 0,
          reason: "liveness not configured; pass liveness to createBuiltinNotesTools to enable active orphan cleanup",
        };
      }
      const scoped = lifecycleInput(input);
      const scopeRefs = Array.isArray(scoped.scopeRefs)
        ? scoped.scopeRefs.filter((value) => typeof value === "string" && value.trim() !== "")
        : [];
      const errors = [];
      let checked = 0;
      let alive = 0;
      let revoked = 0;
      let skipped = 0;
      for (const scopeRef of scopeRefs) {
        let isAlive;
        try {
          isAlive = await boundLiveness.isAlive(scopeRef, {
            now: clock(),
            ttlMs: boundLiveness.ttlMs,
          });
        } catch (error) {
          // isAlive 抛错是整体失败信号：进 errors[]，绝不解释为 false（不得 revoke）。
          errors.push({ operation: "notes_liveness_check", scopeRef, error });
          continue;
        }
        if (typeof isAlive !== "boolean") {
          errors.push({
            operation: "notes_liveness_check",
            scopeRef,
            error: new TypeError("liveness.isAlive must return a boolean"),
          });
          continue;
        }
        checked += 1;
        if (isAlive) {
          alive += 1;
          continue;
        }
        // list 已分页：先只读翻页收集 active key，再逐条 revoke（revoke 会
        // 递增 revision，边翻页边写会让剩余游标立刻 stale）。
        const records = [];
        try {
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
              // 翻页期间记录被写入：游标失效，从头重扫（上限防活锁）。
              staleRetries += 1;
              if (staleRetries > 3) {
                throw new NotesStoreError("revokeInactive 分页游标反复过期", "cursor_stale");
              }
              records.length = 0;
              cursor = null;
              continue;
            }
            // 注入 store 的记录可能缺时间字段：expectedUpdatedAt 取值前 normalize。
            records.push(...page.records.map((record) => normalizeNoteRecord(record)));
            cursor = page.nextCursor;
          } while (cursor !== null);
        } catch (error) {
          errors.push({ operation: "notes_revoke_inactive", scopeRef, error });
          continue;
        }
        for (const record of records) {
          if (record.state !== "active") continue;
          try {
            const result = await store.revoke({
              scope: "run",
              scopeRef,
              key: record.key,
              reason: scoped.reason ?? "scope_inactive",
              expectedState: "active",
              expectedUpdatedAt: record.updated_at,
            });
            if (result.status === "found") revoked += 1;
            else skipped += 1;
          } catch (error) {
            errors.push({ operation: "notes_revoke_inactive", scopeRef, key: record.key, error });
          }
        }
      }
      return {
        status: "found",
        checked,
        alive,
        revoked,
        skipped,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }),
  };

  // ADR-015：notes 小抄目录 → semantic 槽位；复用绑定的同一 store 实例。
  // fold 点调用不在 executor 上下文内，activeReporter 恒为 undefined：
  // 失败诊断改为可选注入——宿主显式传 reportPersistenceFailure 才上报。
  const semanticScopeRef = boundScopeRef ?? currentScopeRef(undefined);
  // issue #67 PR 2：进程内增量缓存 { epoch, revision, text }。list 只取第一页
  // （pinned_updated 前 20 条 = 目录全部内容）。epoch 未变 → 直接复用缓存
  // 文本（不调 list、不读任何记录文件）；epoch 变了才调 list 复核 revision，
  // revision 未变仍复用文本（如 revoke 未命中这类无效变更），revision 变化才
  // 重渲染目录并替换缓存。
  let semanticCache;
  const semanticStateProvider = async ({ state, reportPersistenceFailure } = {}) => {
    if (semanticCache !== undefined && semanticCache.epoch === semanticEpoch) {
      return {
        text: semanticCache.text,
        version: state?.stateVersion,
        status: "ok",
        sourceRevision: semanticCache.revision,
      };
    }
    let page;
    try {
      page = await store.list({
        scopeRef: semanticScopeRef,
        limit: 20,
        filters: { state: "active" },
        sort: "pinned_updated",
      });
    } catch (error) {
      // 不装懂：list 失败返回 undefined（显式注入 reporter 时补发可观察诊断），
      // 绝不拿旧 cache 冒充最新。
      await reportStoreFailure(reportPersistenceFailure, "list", error);
      return undefined;
    }
    if (semanticCache !== undefined && semanticCache.revision === page.revision) {
      semanticCache = { epoch: semanticEpoch, revision: page.revision, text: semanticCache.text };
      return {
        text: semanticCache.text,
        version: state?.stateVersion,
        status: "ok",
        sourceRevision: page.revision,
      };
    }
    const records = page.status === "found"
      // 注入 store 不经过 file adapter 出口：渲染（updated_at 排序）前 normalize。
      ? page.records.map((record) => normalizeNoteRecord(record))
      : [];
    const rendered = renderNotesDirectory(records, state);
    if (rendered === undefined) return undefined;
    semanticCache = { epoch: semanticEpoch, revision: page.revision, text: rendered.text };
    return { ...rendered, sourceRevision: page.revision };
  };

  return {
    definitions: TOOL_DEFINITIONS,
    executors,
    executeTool,
    resolveTools: registry.resolveTools,
    lifecycle,
    semanticStateProvider,
  };
}
