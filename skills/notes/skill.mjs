// Notes 技能：run 作用域的版本化事实/值存储。
// 自包含实现，复制到 ~/.erix/skills/ 后仍可工作；safe id 规则与 src/store/file.js 保持一致。

import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  looksLikeCredential,
  normalizedLabel,
} from "./credential-patterns.mjs";
import { estimateTokens } from "../../src/tokens.js";

const HASHED_ID_PREFIX = "run-h-";
const HASHED_KEY_PREFIX = "note-h-";
const MAX_CONTENT_LENGTH = 4000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 32;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MISSING_NEXT = "该 key/version 从未记录（never recorded）；未记录、不可恢复；不得重跑命令、不得凭记忆给值";
const PRUNED_NEXT = "该旧版本已因有界历史上限被裁剪（pruned），仅保留摘要或版本水位；它不是 never recorded，请读取当前版本或可信归档";
let clock = () => Date.now();

class NotesLockTimeoutError extends Error {
  constructor(key) {
    super(`笔记 key 锁定超时：${key}`);
    this.name = "NotesLockTimeoutError";
    this.code = "notes_lock_timeout";
    this.key = key;
  }
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function safeId(value) {
  const text = String(value);
  if (
    SAFE_ID_PATTERN.test(text)
    && text !== "."
    && text !== ".."
    && !text.startsWith(HASHED_ID_PREFIX)
  ) {
    return text;
  }
  return `${HASHED_ID_PREFIX}${digest(text)}`;
}

function safeKey(value) {
  const text = String(value);
  if (
    SAFE_KEY_PATTERN.test(text)
    && text !== "."
    && text !== ".."
    && !text.startsWith(HASHED_KEY_PREFIX)
  ) {
    return text;
  }
  return `${HASHED_KEY_PREFIX}${digest(text)}`;
}

function now() {
  return new Date(clock()).toISOString();
}

export function setNotesClock(nextClock) {
  if (typeof nextClock !== "function") {
    throw new TypeError("nextClock must be a function");
  }
  const previous = clock;
  clock = nextClock;
  return () => {
    clock = previous;
  };
}

function injectedNotesDir(input) {
  const notesDir = input?.__erix?.notesDir;
  return typeof notesDir === "string" && notesDir.trim() !== ""
    ? notesDir
    : undefined;
}

function notesRoot(input) {
  return path.resolve(
    injectedNotesDir(input)
      ?? process.env.ERIX_NOTES_DIR
      ?? path.join(homedir(), ".erix", "notes"),
  );
}

function injectedScopeRef(input) {
  const erix = input?.__erix;
  if (typeof erix === "string" && erix.trim()) return erix.trim();
  if (!erix || typeof erix !== "object" || Array.isArray(erix)) return undefined;
  const nestedScope = erix.scope && typeof erix.scope === "object"
    ? erix.scope
    : undefined;
  const explicit = erix.runId ?? erix.scopeRef
    ?? (typeof erix.scope === "string" ? erix.scope : undefined)
    ?? nestedScope?.runId
    ?? nestedScope?.scopeRef
    ?? nestedScope?.ref
    ?? nestedScope?.id
    ?? (typeof erix.run === "string" ? erix.run : erix.run?.id);
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : undefined;
}

function currentScopeRef(input) {
  const runId = injectedScopeRef(input) ?? process.env.ERIX_RUN_ID?.trim();
  if (runId) return safeId(runId);
  const cwd = process.cwd();
  const base = path.basename(cwd) || "root";
  return safeId(`${base}-${digest(cwd).slice(0, 8)}`);
}

function historyLimit() {
  const configured = Number(
    process.env.ERIX_NOTES_HISTORY_LIMIT
      ?? process.env.ERIX_NOTES_MAX_HISTORY
      ?? process.env.ERIX_NOTES_MAX_VERSIONS,
  );
  return Number.isSafeInteger(configured) && configured >= 2
    ? Math.min(configured, 200)
    : DEFAULT_HISTORY_LIMIT;
}

function lockTimeoutMs() {
  const configured = Number(process.env.ERIX_NOTES_LOCK_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : DEFAULT_LOCK_TIMEOUT_MS;
}

function lockStaleMs() {
  const configured = Number(process.env.ERIX_NOTES_LOCK_STALE_MS);
  return Number.isSafeInteger(configured) && configured >= 1
    ? configured
    : DEFAULT_LOCK_STALE_MS;
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

function corrupt(key, error) {
  return json({
    status: "corrupt",
    key,
    next: `笔记文件损坏，无法安全读取；请检查存储后再处理（${error}）`,
  });
}

function invalid(key, message) {
  return json({
    status: "invalid",
    ...(key === undefined ? {} : { key }),
    reason: message,
    next: "请修正输入后重试",
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
  if (typeof input?.key !== "string" || input.key.length === 0) return null;
  return input.key;
}

function artifactProvided(input) {
  return input?.artifactRef !== undefined && input.artifactRef !== null
    && !(typeof input.artifactRef === "string" && input.artifactRef.length === 0);
}

function contentProvided(input) {
  return input?.content !== undefined && input.content !== null;
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return null;
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

async function ensureDirectory(directory) {
  try {
    const existing = await lstat(directory);
    if (existing.isSymbolicLink()) {
      throw new Error(`拒绝使用符号链接目录：${directory}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`笔记路径不是目录：${directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
}

async function scopeDirectory(create = false, input = undefined) {
  const root = notesRoot(input);
  const run = path.join(root, "run");
  const scope = path.join(run, currentScopeRef(input));
  if (create) {
    await ensureDirectory(root);
    await ensureDirectory(run);
    await ensureDirectory(scope);
  } else {
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
  }
  return scope;
}

function notePath(directory, key) {
  return path.join(directory, `${safeKey(key)}.json`);
}

function lockPath(directory, key) {
  return path.join(directory, `${safeKey(key)}.lock`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.ownerToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function restoreQuarantinedLock(quarantine, target) {
  try {
    await link(quarantine, target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    try {
      await unlink(quarantine);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function compareAndDeleteLock(target, expected, { staleBefore } = {}) {
  const quarantine = `${target}.${process.pid}.${randomUUID()}.reclaim`;
  try {
    await rename(target, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    const [raw, stat] = await Promise.all([
      readFile(quarantine, "utf8"),
      lstat(quarantine),
    ]);
    const parsed = parseLock(raw);
    const tokenMatches = (parsed?.ownerToken ?? null) === expected.ownerToken
      && raw === expected.raw;
    const stillStale = staleBefore === undefined || stat.mtimeMs <= staleBefore;
    if (!tokenMatches || !stillStale) {
      await restoreQuarantinedLock(quarantine, target);
      return false;
    }
    await unlink(quarantine);
    return true;
  } catch (error) {
    try {
      await restoreQuarantinedLock(quarantine, target);
    } catch (restoreError) {
      error.cause = restoreError;
    }
    throw error;
  }
}

async function renewLock(target, ownerToken, timestamp = clock()) {
  let handle;
  try {
    handle = await open(target, "r+");
    const raw = await handle.readFile({ encoding: "utf8" });
    if (parseLock(raw)?.ownerToken !== ownerToken) return false;
    const renewed = new Date(timestamp);
    await handle.utimes(renewed, renewed);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Internal lock primitive exported for deterministic concurrency tests. It is
 * not exposed as a model tool.
 */
export async function withNotesKeyLock(directory, key, callback) {
  await ensureDirectory(directory);
  const target = lockPath(directory, key);
  const started = clock();
  const timeout = lockTimeoutMs();
  const stale = lockStaleMs();
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({ ownerToken, pid: process.pid, createdAt });
  let acquired = false;
  while (!acquired) {
    try {
      await writeFile(target, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const [raw, lockStat] = await Promise.all([
          readFile(target, "utf8"),
          lstat(target),
        ]);
        const observed = parseLock(raw);
        const staleBefore = clock() - stale;
        if (lockStat.mtimeMs <= staleBefore) {
          await compareAndDeleteLock(
            target,
            { ownerToken: observed?.ownerToken ?? null, raw },
            { staleBefore },
          );
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (clock() - started >= timeout) throw new NotesLockTimeoutError(key);
      await sleep(Math.min(25, Math.max(1, timeout)));
    }
  }
  let renewing = false;
  let renewalError;
  const renewal = setInterval(async () => {
    if (renewing || renewalError) return;
    renewing = true;
    try {
      await renewLock(target, ownerToken, clock());
    } catch (error) {
      renewalError = error;
    } finally {
      renewing = false;
    }
  }, Math.max(1, Math.floor(stale / 3)));
  renewal.unref?.();
  let result;
  let callbackError;
  try {
    result = await callback();
  } catch (error) {
    callbackError = error;
  }
  clearInterval(renewal);
  while (renewing) await sleep(1);
  let releaseError;
  try {
    let raw;
    try {
      raw = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      await compareAndDeleteLock(target, { ownerToken, raw: payload });
    }
  } catch (error) {
    releaseError = error;
  }
  if (callbackError) throw callbackError;
  if (renewalError) throw renewalError;
  if (releaseError) throw releaseError;
  return result;
}

function compactedVersion(version) {
  return {
    version: version.version,
    ts: version.ts,
    provenance: version.provenance,
    preview: preview(version),
  };
}

function boundedVersions(record) {
  const limit = historyLimit();
  const versions = Array.isArray(record.versions) ? record.versions : [];
  if (versions.length <= limit) return record;
  const overflow = versions.slice(0, -limit).map(compactedVersion);
  const previous = Array.isArray(record.compactedHistory)
    ? record.compactedHistory
    : [];
  return {
    ...record,
    versions: versions.slice(-limit),
    compactedHistory: [...previous, ...overflow].slice(-limit),
  };
}

async function loadRecord(file, originalKey = undefined) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) return { corrupt: `拒绝读取符号链接文件：${file}` };
    if (!stat.isFile()) return { corrupt: `笔记路径不是普通文件：${file}` };
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || (originalKey !== undefined && parsed.key !== originalKey)
      || parsed.scope !== "run"
      || typeof parsed.scopeRef !== "string"
      || !Array.isArray(parsed.versions)
      || parsed.versions.length === 0
      || !["active", "completed", "grace", "revoked"].includes(parsed.state)
    ) {
      return { corrupt: "笔记记录字段无效" };
    }
    return { record: parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    if (error instanceof SyntaxError) return { corrupt: "JSON 解析失败" };
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

async function readCurrentRecord(key, input) {
  const directory = await scopeDirectory(false, input);
  if (!directory) return { missing: true };
  return loadRecord(notePath(directory, key), key);
}

function recordVersion(record, requestedVersion) {
  if (requestedVersion === undefined) return record.versions.at(-1);
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) return null;
  return record.versions.find((item) => item.version === requestedVersion) ?? null;
}

function compactedRecordVersion(record, requestedVersion) {
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) return null;
  return (Array.isArray(record.compactedHistory) ? record.compactedHistory : [])
    .find((item) => item.version === requestedVersion) ?? null;
}

function recordValue(result, record, version) {
  const response = {
    status: "found",
    key: record.key,
    version: version.version,
    pinned: record.pinned,
    tags: record.tags,
    provenance: version.provenance,
    next: "已找到记录；如需最新版本请再次 note_read，不要重跑命令",
  };
  if (version.content !== undefined) response.value = version.content;
  if (version.artifactRef !== undefined) response.artifactRef = version.artifactRef;
  if (version.content === undefined && version.provenance?.verified !== true) {
    response.status = "unverified";
    response.next = "该记录只有未验证的 artifact 引用；先核对归档，无法核对时声明不可恢复";
  }
  return response;
}

function preview(version) {
  if (typeof version?.content === "string") return version.content.slice(0, 120);
  if (version?.artifactRef !== undefined) return "[artifact reference]";
  return "";
}

function ledgerReference(version) {
  const artifact = version?.artifactRef;
  if (!artifact || typeof artifact !== "object") return "";
  const name = artifact.artifactId
    ?? (typeof artifact.archivePath === "string" ? path.basename(artifact.archivePath) : "artifact");
  const digest = typeof artifact.digest === "string"
    ? ` digest=${artifact.digest.slice(0, 8)}`
    : "";
  return `引用 ${name}${digest}`;
}

function ledgerLine(record, version) {
  const provenance = version?.provenance ?? {};
  const source = String(provenance.source ?? "unknown");
  const round = provenance.round === undefined ? "-" : String(provenance.round);
  const toolUse = provenance.toolUseId === undefined
    ? "-"
    : String(provenance.toolUseId).slice(0, 32);
  const value = typeof version?.content === "string"
    ? version.content.length > 96
      ? `${Array.from(version.content).slice(0, 72).join("")}…（摘要）`
      : version.content
    : ledgerReference(version);
  return `${record.key} = ${value} source=${source} round=${round} toolUse=${toolUse} version=${version?.version ?? "-"}`;
}

/**
 * Build the small, read-only pinned ledger used by the optional CLI push arm.
 * The character budget is intentionally conservative because ledger values may
 * contain CJK text where one character can be close to one token. Keep a
 * margin below the nominal token budget for punctuation and field labels.
 */
export async function buildPinnedLedger({
  maxEntries = 5,
  maxTokens = 200,
  __erix,
} = {}) {
  const directory = await scopeDirectory(false, { __erix });
  if (!directory) return "";
  const files = await readJsonFiles(directory);
  const records = [];
  for (const file of files) {
    const loaded = await loadRecord(file);
    if (loaded.corrupt) throw new Error(`笔记文件损坏，无法生成 ledger：${file}`);
    if (loaded.missing) continue;
    const record = loaded.record;
    if (record.pinned !== true || record.state !== "active") continue;
    const version = record.versions.at(-1);
    if (version) records.push({ record, version });
  }
  records.sort((left, right) => (
    right.record.updated_at.localeCompare(left.record.updated_at)
    || left.record.key.localeCompare(right.record.key)
  ));

  const budget = Number.isSafeInteger(maxTokens) && maxTokens > 0
    ? maxTokens
    : 1;
  const lines = [];
  for (const entry of records.slice(0, Math.max(0, maxEntries))) {
    const fixed = ledgerLine(entry.record, entry.version);
    const prefix = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    if (estimateTokens(prefix + fixed) <= budget) {
      lines.push(fixed);
      continue;
    }
    const characters = Array.from(fixed);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${prefix}${characters.slice(0, middle).join("")}`;
      if (estimateTokens(candidate) <= budget) low = middle;
      else high = middle - 1;
    }
    if (low > 0) lines.push(characters.slice(0, low).join(""));
    break;
  }
  return lines.join("\n");
}

async function readJsonFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".json")) continue;
    files.push(path.join(directory, entry.name));
  }
  return files;
}

async function writeNote(input = {}, { source = "agent" } = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
  if (!key) return invalid(key, "key 必须是非空字符串");
  if (contentProvided(input) && typeof input.content !== "string") {
    return invalid(key, "content 必须是字符串");
  }
  if (contentProvided(input) && input.content.length > MAX_CONTENT_LENGTH) {
    return invalid(key, `content 不得超过 ${MAX_CONTENT_LENGTH} 个字符`);
  }
  if (!contentProvided(input) && !artifactProvided(input)) {
    return invalid(key, "content 与 artifactRef 至少提供一个");
  }
  const tags = normalizeTags(input.tags);
  if (tags === null) return invalid(key, "tags 必须是字符串数组");
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") {
    return invalid(key, "pinned 必须是布尔值");
  }
  if (
    input.provenance !== undefined
    && (!input.provenance || typeof input.provenance !== "object" || Array.isArray(input.provenance))
  ) {
    return invalid(key, "provenance 必须是对象");
  }
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
    return json({
      status: "rejected",
      key,
      reason: "possible-credential",
      next: "疑似凭据未写入；请移除 token/password/Bearer/JWT/AWS key 等敏感值后再记录",
    });
  }

  const directory = await scopeDirectory(true, input);
  try {
    return await withNotesKeyLock(directory, key, async () => {
      const loaded = await loadRecord(notePath(directory, key), key);
      if (loaded.corrupt) return corrupt(key, loaded.corrupt);
      const timestamp = now();
      const old = loaded.record;
      const previous = old?.versions.at(-1);
      const samePayload = previous && canonical({
        ...(previous.content !== undefined ? { content: previous.content } : {}),
        ...(previous.artifactRef !== undefined ? { artifactRef: previous.artifactRef } : {}),
      }) === canonical(payload);
      const version = samePayload ? previous.version : (previous?.version ?? 0) + 1;
      const suppliedProvenance = input.provenance ?? {};
      const provenance = {
        source,
        verified: suppliedProvenance.verified ?? contentProvided(input),
        ...(input.relevance === undefined ? {} : { relevance: input.relevance }),
        ...(suppliedProvenance.toolUseId === undefined
          ? {}
          : { toolUseId: suppliedProvenance.toolUseId }),
        ...(suppliedProvenance.round === undefined ? {} : { round: suppliedProvenance.round }),
        ...(suppliedProvenance.supersededCandidate === true
          ? { supersededCandidate: true }
          : {}),
        ts: source === "auto" ? (suppliedProvenance.ts ?? timestamp) : timestamp,
      };
      const nextVersion = samePayload
        ? previous
        : { ...payload, version, provenance, ts: timestamp };
      let record = {
        key,
        scope: "run",
        scopeRef: currentScopeRef(input),
        versions: samePayload ? old.versions : [...(old?.versions ?? []), nextVersion],
        ...(old?.compactedHistory ? { compactedHistory: old.compactedHistory } : {}),
        pinned: input.pinned ?? old?.pinned ?? false,
        tags: input.tags === undefined ? (old?.tags ?? tags) : tags,
        state: old?.state === "revoked" ? "active" : (old?.state ?? "active"),
        created_at: old?.created_at ?? timestamp,
        updated_at: timestamp,
        ...(old?.expires_at === undefined ? {} : { expires_at: old.expires_at }),
      };
      record = boundedVersions(record);
      if (old?.state === "revoked" || old?.revoked_at !== undefined) {
        delete record.revoked_at;
        record.revived_at = timestamp;
      }
      await saveRecord(directory, record);
      return json({
        status: old && samePayload ? "updated" : old ? "updated" : "saved",
        key,
        version,
        scope: "run",
        pinned: record.pinned,
        next: "已保存；后续需要该值时先用 note_read 精确读取",
      });
    });
  } catch (error) {
    if (error?.code === "notes_lock_timeout") {
      return json({
        status: "busy",
        key,
        reason: "lock-timeout",
        next: "笔记正在被其他写入操作更新；稍后重试，不要覆盖并发写入",
      });
    }
    throw error;
  }
}

/**
 * CLI capture arm. It is intentionally not listed in the skill definition,
 * so model tool calls can only reach note_take (source=agent). The exported
 * helper is a convenience index writer; final-guard trust comes only from the
 * CLI archive manifest, not from this notes metadata.
 */
export async function recordAutoCapture(input = {}) {
  return writeNote(input, { source: "auto" });
}

export async function note_take(input = {}) {
  return writeNote(input, { source: "agent" });
}

export async function note_read(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
  if (!key) return invalid(key, "key 必须是非空字符串");
  const loaded = await readCurrentRecord(key, input);
  if (loaded.corrupt) return corrupt(key, loaded.corrupt);
  if (loaded.missing) return missing(key);
  const record = loaded.record;
  if (record.state === "revoked" || record.revoked_at !== undefined) {
    return json({
      status: "revoked",
      key,
      next: "该记录已撤销；不得把它当作当前值，必要时显式 note_take 写入新版本",
    });
  }
  const version = recordVersion(record, input.version);
  if (!version) {
    const compacted = compactedRecordVersion(record, input.version);
    if (compacted) {
      return json({
        status: "pruned",
        key,
        version: compacted.version,
        preview: compacted.preview,
        provenance: compacted.provenance,
        next: PRUNED_NEXT,
      });
    }
    const requestedVersion = input.version;
    const latestVersion = record.versions.at(-1)?.version ?? 0;
    if (
      Number.isSafeInteger(requestedVersion)
      && requestedVersion >= 1
      && requestedVersion < latestVersion
    ) {
      return json({
        status: "pruned",
        key,
        version: requestedVersion,
        next: PRUNED_NEXT,
      });
    }
    return missing(key);
  }
  return json(recordValue(null, record, version));
}

export async function note_list(input = {}) {
  const scope = validateScope(input);
  if (!scope) return invalid(undefined, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope);
  if (input.tag !== undefined && typeof input.tag !== "string") {
    return invalid(undefined, "tag 必须是字符串");
  }
  const directory = await scopeDirectory(false, input);
  if (!directory) {
    return json({
      status: "ok",
      count: 0,
      total: 0,
      notes: [],
      next: "当前 run 从未记录（never recorded）任何 note；需要具体值时不得重跑命令、不得凭记忆给值",
    });
  }
  const files = await readJsonFiles(directory);
  const records = [];
  for (const file of files) {
    const loaded = await loadRecord(file);
    const key = loaded.record?.key ?? path.basename(file, ".json");
    if (loaded.corrupt) return corrupt(key, loaded.corrupt);
    if (loaded.missing) continue;
    if (input.includeInactive !== true && loaded.record.state !== "active") continue;
    if (input.tag !== undefined && !loaded.record.tags.includes(input.tag)) continue;
    records.push(loaded.record);
  }
  records.sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  const total = records.length;
  const limit = input.limit === undefined ? 50 : Number(input.limit);
  const cursor = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(cursor) || cursor < 0) {
    return invalid(undefined, "limit 必须为正整数，cursor 必须为非负整数");
  }
  const notes = records.slice(cursor, cursor + Math.min(limit, 200)).map((record) => {
    const latest = record.versions.at(-1);
    return {
      key: record.key,
      tags: record.tags,
      pinned: record.pinned,
      version: latest.version,
      updated_at: record.updated_at,
      state: record.state,
      preview: preview(latest),
    };
  });
  return json({
    status: "ok",
    count: notes.length,
    total,
    notes,
    next: notes.length < total
      ? `还有 ${total - cursor - notes.length} 条元数据，可用 cursor=${cursor + notes.length} 继续`
      : "清单仅含当前有界版本元数据与短 preview；旧版本可能已 pruned（不同于 never recorded），需要完整值时用 note_read 精确读取",
  });
}

export async function note_forget(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
  if (!key) return invalid(key, "key 必须是非空字符串");
  const directory = await scopeDirectory(false, input);
  if (!directory) return json({ status: "missing", key, next: MISSING_NEXT });
  try {
    return await withNotesKeyLock(directory, key, async () => {
      const current = await loadRecord(notePath(directory, key), key);
      if (current.corrupt) return corrupt(key, current.corrupt);
      if (current.missing) return json({ status: "missing", key, next: MISSING_NEXT });
      const record = current.record;
      if (record.state === "revoked" || record.revoked_at !== undefined) {
        return json({ status: "revoked", key, next: "该 key 已是撤销墓碑，未物理删除" });
      }
      const timestamp = now();
      await saveRecord(directory, {
        ...record,
        state: "revoked",
        revoked_at: timestamp,
        updated_at: timestamp,
      });
      return json({ status: "revoked", key, next: "已写入撤销墓碑；历史版本仍保留但不可作为当前值" });
    });
  } catch (error) {
    if (error?.code === "notes_lock_timeout") {
      return json({
        status: "busy",
        key,
        reason: "lock-timeout",
        next: "笔记正在被其他写入操作更新；稍后重试",
      });
    }
    throw error;
  }
}

async function processRunDirectory(directory, currentTime, liveScopeRef = currentScopeRef()) {
  const files = await readJsonFiles(directory);
  let changed = 0;
  let removed = 0;
  let corruptKey;
  for (const file of files) {
    const loaded = await loadRecord(file);
    const key = loaded.record?.key ?? path.basename(file, ".json");
    if (loaded.corrupt) {
      corruptKey = key;
      continue;
    }
    if (loaded.missing) continue;
    const record = loaded.record;
    await withNotesKeyLock(directory, record.key, async () => {
      // Re-read after acquiring the lock so a concurrent take/complete cannot
      // be overwritten by the janitor's stale snapshot.
      const current = await loadRecord(file, record.key);
      if (current.corrupt || current.missing) return;
      const latest = current.record;
      const expires = Date.parse(latest.expires_at ?? "");
      const updatedAt = Date.parse(latest.updated_at ?? latest.created_at ?? "");
      const orphanActive = latest.state === "active"
        && path.basename(directory) !== liveScopeRef
        && Number.isFinite(updatedAt)
        && currentTime - updatedAt >= graceMs();
      if (latest.state === "completed") {
        if (Number.isFinite(expires) && expires <= currentTime) {
          const revokedAt = new Date(currentTime).toISOString();
          await saveRecord(directory, {
            ...latest,
            state: "revoked",
            revoked_at: revokedAt,
            gc_at: revokedAt,
            updated_at: revokedAt,
          });
          removed += 1;
          return;
        }
        await saveRecord(directory, {
          ...latest,
          state: "grace",
          updated_at: now(),
        });
        changed += 1;
      } else if (orphanActive) {
        const timestamp = now();
        await saveRecord(directory, {
          ...latest,
          state: "grace",
          expires_at: new Date(currentTime + graceMs()).toISOString(),
          updated_at: timestamp,
          orphaned_at: timestamp,
        });
        changed += 1;
      } else if (
        latest.state === "grace"
        && Number.isFinite(expires)
        && expires <= currentTime
      ) {
        const revokedAt = new Date(currentTime).toISOString();
        await saveRecord(directory, {
          ...latest,
          state: "revoked",
          revoked_at: revokedAt,
          gc_at: revokedAt,
          updated_at: revokedAt,
        });
        removed += 1;
      }
    });
  }
  return { changed, removed, corruptKey };
}

export async function runNotesJanitor(input = {}) {
  const root = notesRoot(input);
  const run = path.join(root, "run");
  const liveScopeRef = currentScopeRef(input);
  try {
    const stat = await lstat(run);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`笔记 run 路径无效：${run}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "ok", changed: 0, removed: 0 };
    throw error;
  }
  const entries = await readdir(run, { withFileTypes: true });
  let changed = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(run, entry.name);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) throw new Error(`拒绝扫描符号链接目录：${directory}`);
    let result;
    try {
      result = await processRunDirectory(directory, clock(), liveScopeRef);
    } catch (error) {
      if (error?.code === "notes_lock_timeout") {
        return {
          status: "busy",
          key: error.key,
          reason: "lock-timeout",
          next: "笔记正在被其他操作更新；稍后重试 janitor",
        };
      }
      throw error;
    }
    if (result.corruptKey !== undefined) {
      return {
        status: "corrupt",
        key: result.corruptKey,
        next: "笔记文件损坏，未执行静默清理；请检查存储后再处理",
      };
    }
    changed += result.changed;
    removed += result.removed;
  }
  return { status: "ok", changed, removed };
}

export async function completeRun(input = {}) {
  const directory = await scopeDirectory(false, input);
  if (!directory) return { status: "ok", completed: 0 };
  const files = await readJsonFiles(directory);
  let completed = 0;
  const timestamp = now();
  for (const file of files) {
    const loaded = await loadRecord(file);
    const key = loaded.record?.key ?? path.basename(file, ".json");
    if (loaded.corrupt || loaded.missing) continue;
    try {
      await withNotesKeyLock(directory, key, async () => {
        const current = await loadRecord(file, key);
        if (current.corrupt || current.missing || current.record.state !== "active") return;
        await saveRecord(directory, {
          ...current.record,
          state: "completed",
          expires_at: new Date(clock() + graceMs()).toISOString(),
          updated_at: timestamp,
        });
        completed += 1;
      });
    } catch (error) {
      if (error?.code === "notes_lock_timeout") {
        return {
          status: "busy",
          key,
          completed,
          reason: "lock-timeout",
          next: "笔记正在被其他操作更新；稍后重试 completeRun",
        };
      }
      throw error;
    }
  }
  return { status: "ok", completed };
}

const TOOL_DEFINITIONS = [
  {
    name: "note_take",
    description: "记录 run 作用域的事实、值或 artifact 引用；同 key 版本化保留历史",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        content: { type: "string", maxLength: MAX_CONTENT_LENGTH },
        artifactRef: {},
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
        tags: { type: "array", items: { type: "string" } },
        pinned: { type: "boolean" },
        relevance: { type: "number" },
        provenance: { type: "object" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "note_read",
    description: "按精确 key 读取笔记值或 artifact 引用",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
        version: { type: "integer", minimum: 1 },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "note_list",
    description: "列出 run 作用域笔记的元数据与短 preview，不返回完整内容",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["run", "project", "user"], default: "run" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        cursor: { type: "integer", minimum: 0 },
        includeInactive: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "note_forget",
    description: "撤销一个 run 作用域笔记并保留墓碑与历史版本",
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
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`非法 notes 工具名：${tool.name}`);
    }
  }
  return {
    schema_version: 1,
    skill: {
      id: "notes",
      runtime: "node",
      entrypoint: "skill.mjs",
    },
    tools: TOOL_DEFINITIONS,
  };
}
