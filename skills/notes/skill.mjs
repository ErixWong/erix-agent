// Notes 技能：run 作用域的版本化事实/值存储。
// 自包含实现，复制到 ~/.erix/skills/ 后仍可工作；safe id 规则与 src/store/file.js 保持一致。

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
import {
  looksLikeCredential,
  normalizedLabel,
} from "./credential-patterns.mjs";

const HASHED_ID_PREFIX = "run-h-";
const HASHED_KEY_PREFIX = "note-h-";
const MAX_CONTENT_LENGTH = 4000;
const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MISSING_NEXT = "未记录、不可恢复；不得重跑命令、不得凭记忆给值";
let clock = () => Date.now();

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

function notesRoot() {
  return path.resolve(process.env.ERIX_NOTES_DIR || path.join(homedir(), ".erix", "notes"));
}

function currentScopeRef() {
  const runId = process.env.ERIX_RUN_ID?.trim();
  if (runId) return safeId(runId);
  const cwd = process.cwd();
  const base = path.basename(cwd) || "root";
  return safeId(`${base}-${digest(cwd).slice(0, 8)}`);
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

async function scopeDirectory(create = false) {
  const root = notesRoot();
  const run = path.join(root, "run");
  const scope = path.join(run, currentScopeRef());
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

async function readCurrentRecord(key) {
  const directory = await scopeDirectory(false);
  if (!directory) return { missing: true };
  return loadRecord(notePath(directory, key), key);
}

function recordVersion(record, requestedVersion) {
  if (requestedVersion === undefined) return record.versions.at(-1);
  if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) return null;
  return record.versions.find((item) => item.version === requestedVersion) ?? null;
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
} = {}) {
  const directory = await scopeDirectory(false);
  if (!directory) return "";
  const files = await readJsonFiles(directory);
  const records = [];
  for (const file of files) {
    const loaded = await loadRecord(file);
    if (loaded.corrupt) throw new Error(`笔记文件损坏，无法生成 ledger：${file}`);
    if (loaded.missing) continue;
    const record = loaded.record;
    if (record.pinned !== true || record.state === "revoked") continue;
    const version = record.versions.at(-1);
    if (version) records.push({ record, version });
  }
  records.sort((left, right) => (
    right.record.updated_at.localeCompare(left.record.updated_at)
    || left.record.key.localeCompare(right.record.key)
  ));

  const maxCharacters = Math.max(1, Math.floor(maxTokens * 0.8));
  const lines = [];
  let used = 0;
  for (const entry of records.slice(0, Math.max(0, maxEntries))) {
    const fixed = ledgerLine(entry.record, entry.version);
    const remaining = maxCharacters - used - (lines.length === 0 ? 0 : 1);
    if (remaining < 1) break;
    const line = Array.from(fixed).slice(0, remaining).join("");
    if (line.length === 0) break;
    lines.push(line);
    used += line.length + (lines.length === 1 ? 0 : 1);
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

  const directory = await scopeDirectory(true);
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
  const record = {
    key,
    scope: "run",
    scopeRef: currentScopeRef(),
    versions: samePayload ? old.versions : [...(old?.versions ?? []), nextVersion],
    pinned: input.pinned ?? old?.pinned ?? false,
    tags: input.tags === undefined ? (old?.tags ?? tags) : tags,
    state: old?.state === "revoked" ? "active" : (old?.state ?? "active"),
    created_at: old?.created_at ?? timestamp,
    updated_at: timestamp,
    ...(old?.expires_at === undefined ? {} : { expires_at: old.expires_at }),
  };
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
}

/**
 * Internal CLI capture arm. It is intentionally not listed in the skill
 * definition, so model tool calls can only reach note_take (source=agent).
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
  const loaded = await readCurrentRecord(key);
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
  if (!version) return missing(key);
  return json(recordValue(null, record, version));
}

export async function note_list(input = {}) {
  const scope = validateScope(input);
  if (!scope) return invalid(undefined, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope);
  if (input.tag !== undefined && typeof input.tag !== "string") {
    return invalid(undefined, "tag 必须是字符串");
  }
  const directory = await scopeDirectory(false);
  if (!directory) {
    return json({
      status: "ok",
      count: 0,
      total: 0,
      notes: [],
      next: "暂无记录；需要具体值时不得重跑命令、不得凭记忆给值",
    });
  }
  const files = await readJsonFiles(directory);
  const records = [];
  for (const file of files) {
    const loaded = await loadRecord(file);
    const key = loaded.record?.key ?? path.basename(file, ".json");
    if (loaded.corrupt) return corrupt(key, loaded.corrupt);
    if (loaded.missing) continue;
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
      : "清单仅含元数据与短 preview；需要完整值时用 note_read 精确读取",
  });
}

export async function note_forget(input = {}) {
  const scope = validateScope(input);
  const key = validateKey(input);
  if (!scope) return invalid(key, "scope 必须是 run、project 或 user");
  if (scope !== "run") return unsupported(scope, key);
  if (!key) return invalid(key, "key 必须是非空字符串");
  const directory = await scopeDirectory(false);
  if (!directory) return json({ status: "missing", key, next: MISSING_NEXT });
  const loaded = await loadRecord(notePath(directory, key), key);
  if (loaded.corrupt) return corrupt(key, loaded.corrupt);
  if (loaded.missing) return json({ status: "missing", key, next: MISSING_NEXT });
  const record = loaded.record;
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
}

async function processRunDirectory(directory, currentTime) {
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
    const expires = Date.parse(record.expires_at ?? "");
    if (record.state === "completed") {
      if (Number.isFinite(expires) && expires <= currentTime) {
        const revokedAt = new Date(currentTime).toISOString();
        await saveRecord(directory, {
          ...record,
          state: "revoked",
          revoked_at: revokedAt,
          gc_at: revokedAt,
          updated_at: revokedAt,
        });
        removed += 1;
        continue;
      }
      await saveRecord(directory, {
        ...record,
        state: "grace",
        updated_at: now(),
      });
      changed += 1;
    } else if (record.state === "grace" && Number.isFinite(expires) && expires <= currentTime) {
      const revokedAt = new Date(currentTime).toISOString();
      await saveRecord(directory, {
        ...record,
        state: "revoked",
        revoked_at: revokedAt,
        gc_at: revokedAt,
        updated_at: revokedAt,
      });
      removed += 1;
    }
  }
  return { changed, removed, corruptKey };
}

export async function runNotesJanitor() {
  const root = notesRoot();
  const run = path.join(root, "run");
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
    const result = await processRunDirectory(directory, clock());
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

export async function completeRun() {
  const directory = await scopeDirectory(false);
  if (!directory) return { status: "ok", completed: 0 };
  const files = await readJsonFiles(directory);
  let completed = 0;
  const timestamp = now();
  for (const file of files) {
    const loaded = await loadRecord(file);
    const key = loaded.record?.key ?? path.basename(file, ".json");
    if (loaded.corrupt || loaded.missing) continue;
    const record = loaded.record;
    if (record.state === "active") {
      await saveRecord(directory, {
        ...record,
        state: "completed",
        expires_at: new Date(clock() + graceMs()).toISOString(),
        updated_at: timestamp,
      });
      completed += 1;
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
