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
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
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
 * @typedef {{
 *   write: (request: {scope?: "run", scopeRef: string, key: string, record: NoteRecord}) => Promise<void>,
 *   read: (request: {scope?: "run", scopeRef: string, key: string}) => Promise<NoteRecord|undefined>,
 *   list: (request: {scope?: "run", scopeRef: string}) => Promise<NoteRecord[]>,
 *   complete: (request: {scope?: "run", scopeRef: string}) => Promise<{status: "found", completed: number}>,
 *   janitor: (request: {scope?: "run", scopeRef: string}) => Promise<{status: "found", changed: number, revoked: number}>
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

function assertRequest(request, { keyRequired = false } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("NotesStore request must be an object");
  }
  if (request.scope !== undefined && request.scope !== "run") {
    throw new TypeError("NotesStore supports only run scope");
  }
  if (typeof request.scopeRef !== "string" || request.scopeRef.trim() === "") {
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
 * @param {{key?: string, scopeRef?: string}} [expected]
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
      && (expected.scopeRef === undefined || record.scopeRef === safeId(expected.scopeRef))
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

export function assertNotesStore(store) {
  const required = ["write", "read", "list", "complete", "janitor"];
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
  return path.join(root, "run", safeId(scopeRef));
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
    return parsed;
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
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name));
}

function graceMs() {
  const configured = Number(process.env.ERIX_NOTES_GRACE_MS);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_GRACE_MS;
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
      if (!isNoteRecord(request.record, {
        key: request.key,
        scopeRef: request.scopeRef,
      })) {
        throw new TypeError("NotesStore write requires a valid NoteRecord");
      }
      await writeRecord(root, request.scopeRef, request.record);
    },

    async read(request) {
      assertRequest(request, { keyRequired: true });
      const directory = await existingScopeDirectory(root, request.scopeRef);
      if (!directory) return undefined;
      return readRecord(notePath(directory, request.key), request.key, request.scopeRef);
    },

    async list(request) {
      const scopeRef = requestScope(request);
      const directory = await existingScopeDirectory(root, scopeRef);
      if (!directory) return [];
      const records = [];
      for (const file of await listFiles(directory)) {
        const parsed = await readRecord(file, undefined, scopeRef);
        if (!parsed) continue;
        records.push(parsed);
      }
      return records;
    },

    async complete(request) {
      const scopeRef = requestScope(request);
      const records = await store.list({ scope: "run", scopeRef });
      const expires = new Date(clock() + graceMs()).toISOString();
      let completed = 0;
      for (const record of records) {
        if (record.state !== "active") continue;
        const current = await store.read({ scope: "run", scopeRef, key: record.key });
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

    async janitor(request) {
      const liveScope = requestScope(request);
      const runDirectory = path.join(root, "run");
      let entries;
      try {
        const stat = await lstat(runDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new NotesStoreError(`笔记 run 路径无效：${runDirectory}`, "unsafe_path");
        }
        entries = await readdir(runDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return { status: "found", changed: 0, revoked: 0 };
        throw error;
      }

      let changed = 0;
      let revoked = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(runDirectory, entry.name);
        const stat = await lstat(directory);
        if (stat.isSymbolicLink()) {
          throw new NotesStoreError(`拒绝扫描符号链接目录：${directory}`, "unsafe_path");
        }
        for (const file of await listFiles(directory)) {
          let record;
          try {
            record = await readRecord(file, undefined, entry.name);
          } catch (error) {
            if (error?.code === "invalid_record" || error?.code === "unsafe_path") continue;
            throw error;
          }
          if (!record) continue;
          const expires = Date.parse(record.expires_at ?? "");
          const updated = Date.parse(record.updated_at ?? record.created_at ?? "");
          const expiredDone = record.state === "done"
            && Number.isFinite(expires)
            && expires <= clock();
          const orphanActive = record.state === "active"
            && entry.name !== liveScope
            && Number.isFinite(updated)
            && clock() - updated >= graceMs();
          if (!expiredDone && !orphanActive) continue;

          const current = await readRecord(file, record.key, entry.name);
          if (!current) continue;
          const stillEligible = (
            (expiredDone && current.state === "done")
            || (orphanActive && current.state === "active")
          );
          if (!stillEligible) continue;
          const timestamp = new Date(clock()).toISOString();
          await store.write({
            scope: "run",
            scopeRef: entry.name,
            key: current.key,
            record: {
              ...current,
              state: "revoked",
              revoked_at: timestamp,
              gc_at: timestamp,
              updated_at: timestamp,
            },
          });
          changed += 1;
          revoked += 1;
        }
      }
      return { status: "found", changed, revoked };
    },
  };

  return store;
}
