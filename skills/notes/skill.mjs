// Notes 技能：run 作用域的有界事实存储。
// 自包含实现，复制到 ~/.erix/skills/ 后仍可工作。

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
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { looksLikeCredential } from "./credential-patterns.mjs";

const HASHED_ID_PREFIX = "run-h-";
const HASHED_KEY_PREFIX = "note-h-";
const HASHED_ID_PATTERN = /^run-h-[0-9a-f]{24}$/u;
export const MAX_CONTENT_LENGTH = 4000;
export const NOTE_VALUE_MAX_CHARS = 256;
const MAX_SUPERSEDED = 3;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const STATES = new Set(["active", "done", "revoked"]);
const MISSING_NEXT = "该 key 从未记录（never recorded）；未记录、不可恢复；不得重跑命令、不得凭记忆给值";
let clock = () => Date.now();

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

function injectedNotesDir(input) {
  const value = input?.__erix?.notesDir;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function notesRoot(input) {
  return path.resolve(
    injectedNotesDir(input)
      ?? process.env.ERIX_NOTES_DIR
      ?? path.join(homedir(), ".erix", "notes"),
  );
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
  const store = injectedNotesStore(input);
  if (!store) throw new Error("NotesStore is not injected");
  return store;
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

function graceMs() {
  const configured = Number(process.env.ERIX_NOTES_GRACE_MS);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_GRACE_MS;
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

async function ensureDirectory(directory) {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`拒绝使用符号链接目录：${directory}`);
    if (!stat.isDirectory()) throw new Error(`笔记路径不是目录：${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function scopeDirectory(create, input) {
  const root = notesRoot(input);
  const run = path.join(root, "run");
  const scope = path.join(run, safeId(currentScopeRef(input)));
  if (create) {
    await ensureDirectory(root);
    await ensureDirectory(run);
    await ensureDirectory(scope);
    return scope;
  }
  for (const directory of [root, run, scope]) {
    try {
      const stat = await lstat(directory);
      if (stat.isSymbolicLink()) throw new Error(`拒绝使用符号链接目录：${directory}`);
      if (!stat.isDirectory()) throw new Error(`笔记路径不是目录：${directory}`);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  return scope;
}

function notePath(directory, key) {
  return path.join(directory, `${safeKey(key)}.json`);
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

function validateRecord(parsed, originalKey) {
  if (
    !parsed
    || typeof parsed !== "object"
    || (originalKey !== undefined && parsed.key !== originalKey)
    || parsed.scope !== "run"
    || typeof parsed.scopeRef !== "string"
    || !parsed.current
    || typeof parsed.current !== "object"
    || Array.isArray(parsed.current)
    || !Array.isArray(parsed.superseded)
    || parsed.superseded.length > MAX_SUPERSEDED
    || parsed.superseded.some((entry) => !entry || typeof entry !== "object" || entry.invalid !== true)
    || !Number.isSafeInteger(parsed.folded)
    || parsed.folded < 0
    || !STATES.has(parsed.state)
    || !Array.isArray(parsed.tags)
    || parsed.tags.some((tag) => typeof tag !== "string")
  ) {
    return false;
  }
  return true;
}

async function loadRecord(file, originalKey) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) return { invalid: `拒绝读取符号链接文件：${file}` };
    if (!stat.isFile()) return { invalid: `笔记路径不是普通文件：${file}` };
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!validateRecord(parsed, originalKey)) return { invalid: "笔记记录字段无效" };
    return { record: parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    if (error instanceof SyntaxError) return { invalid: "JSON 解析失败" };
    throw error;
  }
}

async function saveRecord(directory, record) {
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

async function readJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
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
  if (looksLikeCredential(key, canonical(payload))) {
    return invalid(key, "疑似凭据，不写入笔记");
  }

  const store = injectedNotesStore(input);
  let old;
  if (injectedNotesStore(input)) {
    try {
      old = await store.read(storeRequest(input, key));
    } catch (error) {
      return invalid(key, error?.message ?? String(error));
    }
  } else {
    const directory = await scopeDirectory(true, input);
    const file = notePath(directory, key);
    const loaded = await loadRecord(file, key);
    if (loaded.invalid) return invalid(key, loaded.invalid);
    old = loaded.record;
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
    if (injectedNotesStore(input)) {
      await store.write({
        ...storeRequest(input, key),
        record,
      });
    } else {
      const directory = await scopeDirectory(true, input);
      await saveRecord(directory, {
        ...record,
        scopeRef: safeId(record.scopeRef),
      });
    }
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
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
 * CLI capture arm. It is intentionally not listed in the skill definition.
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
  if (injectedNotesStore(input)) {
    try {
      record = await notesStoreFor(input).read(storeRequest(input, key));
    } catch (error) {
      return invalid(key, error?.message ?? String(error));
    }
  } else {
    const loaded = await readCurrentRecord(key, input);
    if (loaded.invalid) return invalid(key, loaded.invalid);
    record = loaded.record;
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

async function readCurrentRecord(key, input) {
  const directory = await scopeDirectory(false, input);
  if (!directory) return { missing: true };
  return loadRecord(notePath(directory, key), key);
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
  if (injectedNotesStore(input)) {
    try {
      records = await notesStoreFor(input).list(storeRequest(input));
    } catch (error) {
      return invalid(undefined, error?.message ?? String(error));
    }
  } else {
    const directory = await scopeDirectory(false, input);
    if (!directory) return json({ status: "found", count: 0, total: 0, notes: [] });
    const files = await readJsonFiles(directory);
    records = [];
    for (const file of files) {
      const loaded = await loadRecord(file);
      const key = loaded.record?.key ?? path.basename(file, ".json");
      if (loaded.invalid) return invalid(key, loaded.invalid);
      if (loaded.missing) continue;
      records.push(loaded.record);
    }
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
  const store = injectedNotesStore(input);
  let record;
  if (injectedNotesStore(input)) {
    try {
      record = await store.read(storeRequest(input, key));
    } catch (error) {
      return invalid(key, error?.message ?? String(error));
    }
  } else {
    const directory = await scopeDirectory(false, input);
    if (!directory) return missing(key);
    const loaded = await loadRecord(notePath(directory, key), key);
    if (loaded.invalid) return invalid(key, loaded.invalid);
    record = loaded.record;
  }
  if (!record) return missing(key);
  if (record.state === "revoked") return json({ status: "revoked", key });
  const timestamp = now();
  try {
    const revoked = {
      ...record,
      state: "revoked",
      revoked_at: timestamp,
      updated_at: timestamp,
    };
    if (injectedNotesStore(input)) {
      await store.write({
        ...storeRequest(input, key),
        record: revoked,
      });
    } else {
      const directory = await scopeDirectory(false, input);
      await saveRecord(directory, revoked);
    }
  } catch (error) {
    return invalid(key, error?.message ?? String(error));
  }
  return json({ status: "revoked", key, next: "已写入撤销墓碑；历史 current 与 superseded 均不可作为当前值" });
}

async function revokeIfCurrent(directory, file, currentTime, predicate) {
  const loaded = await loadRecord(file);
  if (loaded.invalid || loaded.missing || !predicate(loaded.record)) return false;
  const timestamp = new Date(currentTime).toISOString();
  await saveRecord(directory, {
    ...loaded.record,
    state: "revoked",
    revoked_at: timestamp,
    gc_at: timestamp,
    updated_at: timestamp,
  });
  return true;
}

export async function runNotesJanitor(input = {}) {
  if (injectedNotesStore(input)) {
    return notesStoreFor(input).janitor(storeRequest(input));
  }
  const root = notesRoot(input);
  const run = path.join(root, "run");
  let entries;
  try {
    const stat = await lstat(run);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`笔记 run 路径无效：${run}`);
    entries = await readdir(run, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "found", changed: 0, revoked: 0 };
    throw error;
  }
  const liveScope = safeId(currentScopeRef(input));
  let changed = 0;
  let revoked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(run, entry.name);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`拒绝扫描符号链接目录：${directory}`);
    for (const file of await readJsonFiles(directory)) {
      const loaded = await loadRecord(file);
      if (loaded.invalid || loaded.missing) continue;
      const record = loaded.record;
      const expires = Date.parse(record.expires_at ?? "");
      const updated = Date.parse(record.updated_at ?? record.created_at ?? "");
      const expiredDone = record.state === "done"
        && Number.isFinite(expires)
        && expires <= clock();
      const orphanActive = record.state === "active"
        && entry.name !== liveScope
        && Number.isFinite(updated)
        && clock() - updated >= graceMs();
      if (expiredDone || orphanActive) {
        if (await revokeIfCurrent(directory, file, clock(), (current) => (
          (expiredDone && current.state === "done")
          || (orphanActive && current.state === "active")
        ))) {
          changed += 1;
          revoked += 1;
        }
      }
    }
  }
  return { status: "found", changed, revoked };
}

export async function completeRun(input = {}) {
  if (injectedNotesStore(input)) {
    return notesStoreFor(input).complete(storeRequest(input));
  }
  const directory = await scopeDirectory(false, input);
  if (!directory) return { status: "found", completed: 0 };
  const files = await readJsonFiles(directory);
  const expires = new Date(clock() + graceMs()).toISOString();
  let completed = 0;
  for (const file of files) {
    const loaded = await loadRecord(file);
    if (loaded.invalid || loaded.missing || loaded.record.state !== "active") continue;
    const current = await loadRecord(file, loaded.record.key);
    if (current.invalid || current.missing || current.record.state !== "active") continue;
    await saveRecord(directory, {
      ...current.record,
      state: "done",
      expires_at: expires,
      updated_at: now(),
    });
    completed += 1;
  }
  return { status: "found", completed };
}

const TOOL_DEFINITIONS = [
  {
    name: "note_take",
    description: "记录 run 作用域的事实、具体值或 artifact 引用；旧 current 会保留为已作废的 superseded。when-to-use：产生后续还要用的关键事实、一次性值或决策时调用；上下文被折叠时先 note_list，再 note_read key=...；不要重跑非幂等命令，不要遍历归档目录",
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
    description: "按精确 key 读取 current，并返回已作废的 superseded 与 folded。when-to-use：上下文被折叠时先 note_list，再 note_read key=...；不要重跑非幂等命令，不要遍历归档目录",
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
    description: "列出 run 作用域笔记的 key、标签和 current 元数据，不返回完整内容。when-to-use：上下文被折叠时先 note_list，再 note_read key=...；不要重跑非幂等命令，不要遍历归档目录",
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
    description: "撤销一个 run 作用域笔记并保留墓碑。when-to-use：值已失效或必须明确撤销时调用；上下文被折叠时先 note_list，再 note_read key=...；不要重跑非幂等命令，不要遍历归档目录",
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

export function getSkillDefinition() {
  for (const tool of TOOL_DEFINITIONS) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`非法 notes 工具名：${tool.name}`);
  }
  return {
    schema_version: 1,
    skill: { id: "notes", runtime: "node", entrypoint: "skill.mjs" },
    tools: TOOL_DEFINITIONS,
  };
}
