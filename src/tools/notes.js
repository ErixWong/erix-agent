import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { createFileNotesStore } from "../store/notes.js";
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
    && typeof store.janitor === "function"
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

function unsupported(scope, key) {
  return json({
    status: "unsupported",
    ...(key === undefined ? {} : { key }),
    scope,
    next: "当前阶段只支持 run 作用域；请显式使用 scope=run",
  });
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

function validateScope(input) {
  const scope = input?.scope ?? "run";
  return scope === "run" || scope === "project" || scope === "user" ? scope : null;
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
  if (!scope) return { error: invalid(key, "scope 必须是 run、project 或 user") };
  if (scope !== "run") return { error: unsupported(scope, key) };
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

async function writeNote(input = {}, { source = "agent" } = {}) {
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
    source,
    verified: supplied.verified ?? contentProvided(input),
    ...(supplied.toolUseId === undefined ? {} : { toolUseId: supplied.toolUseId }),
    ...(supplied.round === undefined ? {} : { round: supplied.round }),
    ts: source === "auto" ? (supplied.ts ?? timestamp) : timestamp,
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
    relevance: relevance ?? old?.relevance ?? (source === "auto" ? 0.8 : 0.5),
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

/**
 * Private CLI capture arm. It is intentionally not listed in the tool schema.
 */
export async function recordAutoCapture(input = {}) {
  return writeNote(input, { source: "auto" });
}

export async function note_take(input = {}) {
  return writeNote(input, { source: "agent" });
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
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
  if (!key) return invalid(key, "key 必须是非空字符串");
  let record;
  try {
    record = await notesStoreFor(input).read(storeRequest(input, key));
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  if (!record) return missing(key);
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
  if (!scope) return invalid(undefined, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope);
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
  let records;
  try {
    records = await notesStoreFor(input).list(storeRequest(input));
  } catch (error) {
    return invalid(undefined, error?.message ?? String(error));
  }
  records = records.filter((record) => {
    if (input.includeInactive !== true && record.state !== "active") return false;
    if (input.tag !== undefined && !record.tags.includes(input.tag)) return false;
    const source = record.current?.provenance?.source === "auto" ? "auto" : "agent";
    const relevance = Number.isFinite(record.relevance) ? record.relevance : 0.5;
    if (input.source !== undefined && source !== input.source) return false;
    if (input.minRelevance !== undefined && relevance < input.minRelevance) return false;
    return true;
  });
  records.sort((left, right) => {
    const relevanceDifference = (
      (Number.isFinite(right.relevance) ? right.relevance : 0.5)
      - (Number.isFinite(left.relevance) ? left.relevance : 0.5)
    );
    return relevanceDifference || right.updated_at.localeCompare(left.updated_at);
  });
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(cursor) || cursor < 0) {
    return invalid(undefined, "limit 必须为正整数，cursor 必须为非负整数");
  }
  const notes = records.slice(cursor, cursor + Math.min(limit, 200)).map(listEntry);
  return json({
    status: "found",
    count: notes.length,
    total: records.length,
    notes,
    next: notes.length < records.length - cursor
      ? `还有 ${records.length - cursor - notes.length} 条元数据，可用 cursor=${cursor + notes.length} 继续`
      : "清单仅含当前记录元数据；需要具体值时用 note_read 精确读取",
  });
}

export async function note_forget(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
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
  const timestamp = now();
  try {
    await store.write({
      ...storeRequest(input, key),
      record: {
        ...record,
        state: "revoked",
        revoked_at: timestamp,
        updated_at: timestamp,
      },
    });
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
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
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
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "note_list",
    description: "列出 run 作用域笔记的 key、标签和 current 元数据，不返回完整内容。when-to-use：上下文被折叠时先 note_list，再 note_read key=...；不要遍历归档目录凭记忆补值",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
        tag: { type: "string" },
        minRelevance: { type: "number", minimum: 0, maximum: 1 },
        source: { type: "string", enum: ["auto", "agent"] },
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "integer", minimum: 0 },
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
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
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
    return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  };
  const lines = entries.map((record) => {
    const flags = [
      record.pinned === true ? "★" : null,
      typeof record.source === "string" && record.source !== ""
        ? `@${record.source}`
        : null,
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

const REPORTABLE_STORE_METHODS = ["read", "write", "list", "complete", "janitor"];

/**
 * Decorate a NotesStore so persistence failures are reported through the
 * engine's generic host-persistence bridge (`context.reportPersistenceFailure`,
 * port="notes") instead of being silently swallowed into tool-level "invalid"
 * JSON. The original error is always re-thrown so existing tool error paths
 * keep working. The reporter is bound per tool execution by the assembler.
 */
function withPersistenceReporting(store, getReporter) {
  const decorated = {};
  for (const method of REPORTABLE_STORE_METHODS) {
    decorated[method] = async (request) => {
      try {
        return await store[method](request);
      } catch (error) {
        const reporter = getReporter();
        if (typeof reporter === "function") {
          try {
            await reporter({
              port: "notes",
              operation: method,
              phase: method === "write" ? "write" : "read",
              sideEffect: method === "write" ? "executed_uncommitted" : "not_started",
              error,
            });
          } catch {
            // 报告桥自身失败不得阻断工具原有的错误路径。
          }
        }
        throw error;
      }
    };
  }
  return decorated;
}

/**
 * Full notes assembler. One call binds the run scope (runId/scopeRef), the
 * notes directory, and a single NotesStore instance; every returned view
 * (executors, executeTool, lifecycle, semanticStateProvider) reuses them and
 * forcibly overrides any caller-forged `__erix` injection.
 *
 * @param {{notesDir?: string, notesStore?: object, runId?: string, scopeRef?: string}} options
 * @returns {{
 *   definitions: object[],
 *   executors: Function, executeTool: Function, resolveTools: Function,
 *   lifecycle: {onRunStart: Function, onRunComplete: Function},
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

  let activeReporter;
  const store = withPersistenceReporting(boundStore, () => activeReporter);
  const scope = {
    ...(boundScopeRef === undefined ? {} : { runId: boundScopeRef }),
    notesDir: resolvedNotesDir,
    notesStore: store,
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

  // onRunStart = janitor；onRunComplete = completeRun 后接 janitor，
  // 收尾错误收集在返回值的 errors[] 里返回，不抛出覆盖主错误。
  const lifecycle = {
    onRunStart: async (input) => {
      await runNotesJanitor(lifecycleInput(input));
    },
    onRunComplete: async (input) => {
      const completionErrors = [];
      let completed;
      let janitor;
      try {
        completed = await completeRun(lifecycleInput(input));
      } catch (error) {
        completionErrors.push({ operation: "notes_complete_run", error });
      }
      try {
        janitor = await runNotesJanitor(lifecycleInput(input));
      } catch (error) {
        completionErrors.push({ operation: "notes_janitor", error });
      }
      return { completed, janitor, errors: completionErrors };
    },
  };

  // ADR-015：notes 小抄目录 → semantic 槽位；复用绑定的同一 store 实例。
  const semanticScopeRef = boundScopeRef ?? currentScopeRef(undefined);
  const semanticStateProvider = async ({ state } = {}) => {
    let records;
    try {
      records = await store.list({ scopeRef: semanticScopeRef });
    } catch {
      return undefined;
    }
    return renderNotesDirectory(records, state);
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
